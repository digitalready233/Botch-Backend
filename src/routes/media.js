import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../db/index.js';
import { authMiddleware } from '../middleware/auth.js';
import { isCustomerRole } from '../lib/roles.js';
import { queryProjectId, bodyProjectId } from '../lib/route-ids.js';
import { body, validationResult, query } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import { uploadToS3, isS3Configured } from '../lib/s3.js';
import { logAudit } from '../lib/audit.js';
import { createNotificationForUser } from '../lib/notifications.js';
import { fileFilter, ALLOWED_MEDIA_MIMES, validateMediaCategoryMime } from '../lib/upload-validation.js';

const MEDIA_MAX_BYTES = (() => {
  const raw = Number(process.env.UPLOAD_MAX_MEDIA_BYTES);
  const n = Number.isFinite(raw) && raw > 0 ? raw : 25 * 1024 * 1024;
  return Math.min(100 * 1024 * 1024, Math.max(1 * 1024 * 1024, n));
})();
import { getUploadsBase } from '../lib/upload-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = getUploadsBase(path.join(__dirname, '..', '..', 'uploads'));

const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.bin';
    cb(null, uuidv4() + ext);
  },
});
const memoryStorage = multer.memoryStorage();
const upload = multer({
  storage: isS3Configured() ? memoryStorage : diskStorage,
  limits: { fileSize: MEDIA_MAX_BYTES },
  fileFilter: fileFilter(ALLOWED_MEDIA_MIMES, 'Media upload'),
});

const router = express.Router();

/** GET /api/v1/media/latest - most recent photo/video for client (across all their projects) */
router.get('/latest', authMiddleware, async (req, res, next) => {
  try {
    if (req.userRole === 'admin' || req.userRole === 'super_admin') {
      const { rows } = await pool.query(
        `SELECT m.*, u.full_name AS uploaded_by_name, p.name AS project_name, p.id AS project_id
         FROM media m
         LEFT JOIN users u ON m.uploaded_by = u.id
         LEFT JOIN projects p ON m.project_id = p.id
         ORDER BY m.created_at DESC LIMIT 1`
      );
      return res.json(rows[0] || null);
    }
    if (isCustomerRole(req.userRole)) {
      const { rows } = await pool.query(
        `SELECT m.*, u.full_name AS uploaded_by_name, p.name AS project_name, p.id AS project_id
         FROM media m
         LEFT JOIN users u ON m.uploaded_by = u.id
         LEFT JOIN projects p ON m.project_id = p.id
         WHERE p.client_id = $1
         ORDER BY m.created_at DESC LIMIT 1`,
        [req.userId]
      );
      return res.json(rows[0] || null);
    }
    if (req.userRole === 'vendor') {
      return res.status(403).json({ error: 'Project media is not available for vendor accounts.' });
    }
    return res.status(403).json({ error: "You don't have permission to do that." });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/media - list media by project */
router.get('/', authMiddleware, queryProjectId(), query('media_type').optional(), async (req, res, next) => {
  try {
    const v = validationResult(req);
    if (!v.isEmpty()) return res.status(400).json({ errors: v.array() });
    const { project_id, media_type } = req.query;
    const { rows: project } = await pool.query('SELECT * FROM projects WHERE id = $1', [project_id]);
    if (project.length === 0) return res.status(404).json({ error: 'Project not found' });
    const proj = project[0];
    const canView =
      req.userRole === 'admin' ||
      req.userRole === 'super_admin' ||
      (isCustomerRole(req.userRole) && proj.client_id === req.userId);
    if (!canView) return res.status(403).json({ error: "You don't have permission to do that." });
    let sql = 'SELECT m.*, u.full_name AS uploaded_by_name FROM media m LEFT JOIN users u ON m.uploaded_by = u.id WHERE m.project_id = $1';
    const params = [project_id];
    if (media_type) { params.push(media_type); sql += ` AND m.media_type = $${params.length}`; }
    sql += ' ORDER BY m.created_at DESC';
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/media/upload - upload progress media (admin only). Uses S3 if configured, else local. Optional GPS: latitude, longitude. */
router.post('/upload', authMiddleware, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { project_id, title, description, media_type, latitude, longitude } = req.body || {};
    if (!project_id || !media_type || !['photo', 'video', 'drone'].includes(media_type)) {
      return res.status(400).json({ error: 'project_id and media_type (photo|video|drone) required' });
    }
    const categoryErr = validateMediaCategoryMime(media_type, req.file.mimetype);
    if (categoryErr) return res.status(400).json({ error: categoryErr });
    const metadata =
      latitude != null && longitude != null && !Number.isNaN(Number(latitude)) && !Number.isNaN(Number(longitude))
        ? JSON.stringify({ latitude: Number(latitude), longitude: Number(longitude) })
        : null;
    const { rows: project } = await pool.query('SELECT id, vendor_id, client_id FROM projects WHERE id = $1', [project_id]);
    if (project.length === 0) return res.status(404).json({ error: 'Project not found' });
    const canUpload = req.userRole === 'admin' || req.userRole === 'super_admin';
    if (!canUpload) return res.status(403).json({ error: 'Forbidden: only administrators can upload progress media' });

    let fileUrl;
    if (isS3Configured() && req.file.buffer) {
      const ext = path.extname(req.file.originalname) || '.bin';
      const key = `media/${uuidv4()}${ext}`;
      const contentType = req.file.mimetype || 'application/octet-stream';
      fileUrl = await uploadToS3(req.file.buffer, key, contentType);
    }
    if (!fileUrl) {
      fileUrl = `/uploads/${req.file.filename}`;
    }
    const id = uuidv4();
    await pool.query(
      `INSERT INTO media (id, project_id, uploaded_by, title, description, media_type, file_url, file_size, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, project_id, req.userId, title || null, description || null, media_type, fileUrl, req.file.size, metadata]
    );
    const activityId = uuidv4();
    await pool.query(
      `INSERT INTO project_activity (id, project_id, activity_type, reference_id, actor_id, details)
       VALUES ($1, $2, 'media_upload', $3, $4, $5)`,
      [activityId, project_id, id, req.userId, JSON.stringify({ media_type, title: title || null })]
    );
    logAudit({
      userId: req.userId,
      action: 'media_upload',
      resourceType: 'media',
      resourceId: id,
      details: JSON.stringify({ project_id, media_type }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    const clientId = project[0].client_id;
    if (clientId) {
      const title = 'New site update';
      const message = `New ${media_type} has been posted to your project.`;
      await createNotificationForUser(clientId, 'media_uploaded', title, message);
      const io = req.app.get('io');
      if (io) io.to(`user:${clientId}`).emit('notification:new', { type: 'media_uploaded', title, message });
    }
    const { rows } = await pool.query('SELECT * FROM media WHERE id = $1', [id]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/media - create media with URL only (admin only). For S3/external URLs. Optional GPS: latitude, longitude. */
router.post('/', authMiddleware, [
  bodyProjectId(),
  body('title').optional().trim(),
  body('description').optional().trim(),
  body('media_type').isIn(['photo', 'video', 'drone']),
  body('file_url').trim().notEmpty(),
  body('file_size').optional().isInt({ min: 0 }),
  body('latitude').optional().isFloat({ min: -90, max: 90 }),
  body('longitude').optional().isFloat({ min: -180, max: 180 }),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { project_id, title, description, media_type, file_url, file_size, latitude, longitude } = req.body;
    const metadata =
      latitude != null && longitude != null
        ? JSON.stringify({ latitude: Number(latitude), longitude: Number(longitude) })
        : null;
    const { rows: projRows } = await pool.query('SELECT id, vendor_id FROM projects WHERE id = $1', [project_id]);
    if (projRows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const canUpload = req.userRole === 'admin' || req.userRole === 'super_admin';
    if (!canUpload) return res.status(403).json({ error: 'Forbidden: only administrators can add progress media' });
    const id = uuidv4();
    await pool.query(
      `INSERT INTO media (id, project_id, uploaded_by, title, description, media_type, file_url, file_size, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, project_id, req.userId, title || null, description || null, media_type, file_url, file_size || null, metadata]
    );
    const activityId = uuidv4();
    await pool.query(
      `INSERT INTO project_activity (id, project_id, activity_type, reference_id, actor_id, details)
       VALUES ($1, $2, 'media_upload', $3, $4, $5)`,
      [activityId, project_id, id, req.userId, JSON.stringify({ media_type, title: title || null })]
    );
    const { rows } = await pool.query('SELECT * FROM media WHERE id = $1', [id]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

export default router;
