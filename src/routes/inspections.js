import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../db/index.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { body, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import { createNotificationForUser } from '../lib/notifications.js';
import { getUploadsBase } from '../lib/upload-paths.js';
import { uploadToS3, isS3Configured } from '../lib/s3.js';
import { validateFileExtension } from '../lib/upload-validation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = getUploadsBase(path.join(__dirname, '..', '..', 'uploads'));

const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.bin';
    cb(null, `inspection-${uuidv4()}${ext}`);
  },
});
const memoryStorage = multer.memoryStorage();
const fileFilter = (req, file, cb) => {
  const { allowed } = validateFileExtension(file.originalname);
  if (!allowed) return cb(new Error('File type not allowed'));
  cb(null, true);
};
const upload = multer({
  storage: isS3Configured() ? memoryStorage : diskStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter,
});

const router = express.Router();

/** GET /api/v1/inspections - list: client (own projects), admin (all), inspector (assigned to me) */
router.get('/', authMiddleware, async (req, res, next) => {
  try {
    if (req.userRole === 'admin' || req.userRole === 'super_admin') {
      const { rows } = await pool.query(
        `SELECT i.*, p.name AS project_name, u1.full_name AS requested_by_name, u2.full_name AS inspector_name
         FROM site_inspections i
         LEFT JOIN projects p ON i.project_id = p.id
         LEFT JOIN users u1 ON i.requested_by = u1.id
         LEFT JOIN users u2 ON i.assigned_inspector_id = u2.id
         ORDER BY i.created_at DESC`
      );
      return res.json(rows);
    }
    if (req.userRole === 'client') {
      const { rows } = await pool.query(
        `SELECT i.*, p.name AS project_name
         FROM site_inspections i
         LEFT JOIN projects p ON i.project_id = p.id
         WHERE i.requested_by = $1
         ORDER BY i.created_at DESC`,
        [req.userId]
      );
      return res.json(rows);
    }
    return res.status(403).json({ error: "You don't have permission to access this." });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/inspections - client requests inspection */
router.post('/', authMiddleware, [
  body('project_id').isUUID(),
  body('client_notes').optional().trim(),
], async (req, res, next) => {
  try {
    if (req.userRole !== 'client') {
      return res.status(403).json({ error: 'Only clients can request an inspection' });
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { project_id, client_notes } = req.body;
    const { rows: proj } = await pool.query('SELECT id, client_id FROM projects WHERE id = $1', [project_id]);
    if (proj.length === 0) return res.status(404).json({ error: 'Project not found' });
    if (proj[0].client_id !== req.userId) return res.status(403).json({ error: 'Not your project' });

    const id = uuidv4();
    await pool.query(
      `INSERT INTO site_inspections (id, project_id, requested_by, client_notes, status)
       VALUES ($1, $2, $3, $4, 'requested')`,
      [id, project_id, req.userId, client_notes || null]
    );

    const { rows: clientRow } = await pool.query('SELECT full_name FROM users WHERE id = $1', [req.userId]);
    const clientName = clientRow[0]?.full_name || 'A client';
    const { rows: adminRows } = await pool.query("SELECT id FROM users WHERE role IN ('admin', 'super_admin')");
    const io = req.app.get('io');
    const notifTitle = 'Site inspection requested';
    const notifMessage = `${clientName} requested a site inspection for project ${proj[0].id}.`;
    for (const admin of adminRows) {
      await createNotificationForUser(admin.id, 'inspection_requested', notifTitle, notifMessage);
      if (io) io.to(`user:${admin.id}`).emit('notification:new', { type: 'inspection_requested', title: notifTitle, message: notifMessage });
    }

    const { rows } = await pool.query(
      'SELECT i.*, p.name AS project_name FROM site_inspections i LEFT JOIN projects p ON i.project_id = p.id WHERE i.id = $1',
      [id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/inspections/:id - detail with photos */
router.get('/:id', authMiddleware, async (req, res, next) => {
  try {
    const { rows: insp } = await pool.query(
      `SELECT i.*, p.name AS project_name, p.client_id AS project_client_id, u1.full_name AS requested_by_name, u2.full_name AS inspector_name
       FROM site_inspections i
       LEFT JOIN projects p ON i.project_id = p.id
       LEFT JOIN users u1 ON i.requested_by = u1.id
       LEFT JOIN users u2 ON i.assigned_inspector_id = u2.id
       WHERE i.id = $1`,
      [req.params.id]
    );
    if (insp.length === 0) return res.status(404).json({ error: 'Inspection not found' });
    const i = insp[0];
    const canView = req.userRole === 'admin' || req.userRole === 'super_admin'
      || (req.userRole === 'client' && i.requested_by === req.userId)
      || (req.userRole === 'client' && i.project_client_id === req.userId);
    if (!canView) return res.status(403).json({ error: "You don't have permission to view this inspection." });

    const { rows: photos } = await pool.query('SELECT * FROM inspection_photos WHERE inspection_id = $1 ORDER BY created_at', [req.params.id]);
    res.json({ ...i, photos });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/v1/inspections/:id - admin: assign inspector, status, scheduled_at, admin_notes */
router.patch('/:id', authMiddleware, requireAdmin, [
  body('assigned_inspector_id').optional().isUUID(),
  body('status').optional().isIn(['requested', 'assigned', 'scheduled', 'completed', 'cancelled']),
  body('scheduled_at').optional().trim(),
  body('admin_notes').optional().trim(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { rows: existing } = await pool.query('SELECT * FROM site_inspections WHERE id = $1', [req.params.id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Inspection not found' });

    const updates = [];
    const values = [];
    let idx = 1;
    if (req.body.assigned_inspector_id !== undefined) {
      updates.push(`assigned_inspector_id = $${idx++}`);
      values.push(req.body.assigned_inspector_id || null);
    }
    if (req.body.status !== undefined) {
      updates.push(`status = $${idx++}`);
      values.push(req.body.status);
    }
    if (req.body.scheduled_at !== undefined) {
      updates.push(`scheduled_at = $${idx++}`);
      values.push(req.body.scheduled_at || null);
    }
    if (req.body.admin_notes !== undefined) {
      updates.push(`admin_notes = $${idx++}`);
      values.push(req.body.admin_notes || null);
    }
    if (updates.length === 0) return res.json(existing[0]);
    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(req.params.id);
    await pool.query(
      `UPDATE site_inspections SET ${updates.join(', ')} WHERE id = $${idx}`,
      values
    );

    const clientId = existing[0].requested_by;
    const inspectorId = req.body.assigned_inspector_id;
    if (inspectorId && clientId) {
      const notifTitle = 'Inspection assigned';
      const notifMessage = 'An inspector has been assigned to your site inspection request.';
      await createNotificationForUser(clientId, 'inspection_assigned', notifTitle, notifMessage);
      const io = req.app.get('io');
      if (io) io.to(`user:${clientId}`).emit('notification:new', { type: 'inspection_assigned', title: notifTitle, message: notifMessage });
    }

    const { rows } = await pool.query(
      'SELECT i.*, p.name AS project_name FROM site_inspections i LEFT JOIN projects p ON i.project_id = p.id WHERE i.id = $1',
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/inspections/:id/report - inspector uploads report (text + optional file + photos) */
router.post('/:id/report', authMiddleware, upload.fields([
  { name: 'report_file', maxCount: 1 },
  { name: 'photos', maxCount: 10 },
]), async (req, res, next) => {
  try {
    const { rows: insp } = await pool.query('SELECT * FROM site_inspections WHERE id = $1', [req.params.id]);
    if (insp.length === 0) return res.status(404).json({ error: 'Inspection not found' });
    if (req.userRole === 'vendor') {
      return res.status(403).json({ error: 'Site inspections are not available for vendor accounts.' });
    }
    if (insp[0].assigned_inspector_id !== req.userId && req.userRole !== 'admin' && req.userRole !== 'super_admin') {
      return res.status(403).json({ error: 'Only the assigned inspector or admin can submit the report' });
    }
    if (insp[0].status === 'cancelled') return res.status(400).json({ error: 'Inspection is cancelled' });

    const report_text = (req.body && req.body.report_text) ? String(req.body.report_text).trim() : null;
    const report_file = req.files?.report_file?.[0];
    const photoFiles = req.files?.photos || [];
    const captions = req.body && req.body.photo_captions ? (Array.isArray(req.body.photo_captions) ? req.body.photo_captions : [req.body.photo_captions]) : [];

    let report_file_url = null;
    if (report_file) {
      if (isS3Configured() && report_file.buffer) {
        const ext = path.extname(report_file.originalname) || '.pdf';
        const key = `inspections/${req.params.id}/${uuidv4()}${ext}`;
        report_file_url = await uploadToS3(report_file.buffer, key, report_file.mimetype || 'application/pdf');
      } else {
        report_file_url = `/uploads/${report_file.filename}`;
      }
    }

    await pool.query(
      `UPDATE site_inspections SET report_text = $1, report_file_url = COALESCE($2, report_file_url), reported_at = CURRENT_TIMESTAMP, reported_by = $3, status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = $4`,
      [report_text || insp[0].report_text, report_file_url, req.userId, req.params.id]
    );

    for (let i = 0; i < photoFiles.length; i++) {
      const file = photoFiles[i];
      let photoUrl;
      if (isS3Configured() && file.buffer) {
        const ext = path.extname(file.originalname) || '.jpg';
        const key = `inspections/${req.params.id}/photos/${uuidv4()}${ext}`;
        photoUrl = await uploadToS3(file.buffer, key, file.mimetype || 'image/jpeg');
      } else {
        photoUrl = `/uploads/${file.filename}`;
      }
      const caption = captions[i] != null ? String(captions[i]).trim() : null;
      await pool.query(
        'INSERT INTO inspection_photos (id, inspection_id, file_url, caption) VALUES ($1, $2, $3, $4)',
        [uuidv4(), req.params.id, photoUrl, caption]
      );
    }

    const clientId = insp[0].requested_by;
    if (clientId) {
      const notifTitle = 'Inspection report ready';
      const notifMessage = 'The inspector has submitted the site inspection report.';
      await createNotificationForUser(clientId, 'inspection_report_ready', notifTitle, notifMessage);
      const io = req.app.get('io');
      if (io) io.to(`user:${clientId}`).emit('notification:new', { type: 'inspection_report_ready', title: notifTitle, message: notifMessage });
    }

    const { rows } = await pool.query(
      'SELECT i.*, p.name AS project_name FROM site_inspections i LEFT JOIN projects p ON i.project_id = p.id WHERE i.id = $1',
      [req.params.id]
    );
    const { rows: photos } = await pool.query('SELECT * FROM inspection_photos WHERE inspection_id = $1 ORDER BY created_at', [req.params.id]);
    res.json({ ...rows[0], photos });
  } catch (err) {
    next(err);
  }
});

export default router;
