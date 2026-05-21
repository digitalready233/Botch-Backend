import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { validationResult } from 'express-validator';
import pool from '../db/index.js';
import { authMiddleware } from '../middleware/auth.js';
import { isCustomerRole } from '../lib/roles.js';
import { paramProjectId, paramDocId } from '../lib/route-ids.js';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../lib/audit.js';
import { fileFilter, ALLOWED_DOCUMENT_MIMES, sanitizeDisplayName } from '../lib/upload-validation.js';
import { getUploadsBase } from '../lib/upload-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const documentsDir = path.join(getUploadsBase(path.join(__dirname, '..', '..', 'uploads')), 'documents');
try {
  fs.mkdirSync(documentsDir, { recursive: true });
} catch (_) {}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, documentsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.bin';
    cb(null, uuidv4() + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 }, fileFilter: fileFilter(ALLOWED_DOCUMENT_MIMES, 'Document upload') }); // 20MB

const router = express.Router({ mergeParams: true });

const validateProjectId = [paramProjectId()];
const validateDocId = [paramDocId()];

async function getProjectAndCheckAccess(req, res) {
  const projectId = req.params.projectId;
  const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (rows.length === 0) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  const project = rows[0];
  const canAccess =
    req.userRole === 'admin' ||
    req.userRole === 'super_admin' ||
    (isCustomerRole(req.userRole) && project.client_id === req.userId);
  if (!canAccess) {
    res.status(403).json({ error: "You don't have permission to do that." });
    return null;
  }
  return project;
}

/** GET /api/v1/projects/:projectId/documents - list documents for project */
router.get('/', authMiddleware, validateProjectId, async (req, res, next) => {
  try {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    const project = await getProjectAndCheckAccess(req, res);
    if (!project) return;
    const { rows } = await pool.query(
      'SELECT id, project_id, name, file_path, document_type, uploaded_by, created_at FROM project_documents WHERE project_id = $1 ORDER BY created_at DESC',
      [project.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/projects/:projectId/documents - upload document (admin only; clients may not upload) */
router.post('/', authMiddleware, validateProjectId, upload.single('file'), async (req, res, next) => {
  try {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    const project = await getProjectAndCheckAccess(req, res);
    if (!project) return;
    if (req.userRole === 'client') {
      return res.status(403).json({
        error: 'Only administrators can upload project documents.',
      });
    }
    const documentType = (req.body && req.body.document_type) || 'contract';
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const name = sanitizeDisplayName((req.body && req.body.name) || req.file.originalname || 'Document');
    const id = uuidv4();
    const filePath = req.file.filename;
    await pool.query(
      `INSERT INTO project_documents (id, project_id, name, file_path, document_type, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, project.id, name, filePath, documentType, req.userId]
    );
    logAudit({
      userId: req.userId,
      action: 'document_upload',
      resourceType: 'project_document',
      resourceId: id,
      details: JSON.stringify({ project_id: project.id, name, document_type: documentType }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    const { rows } = await pool.query('SELECT * FROM project_documents WHERE id = $1', [id]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/projects/:projectId/documents/:docId/download - download file */
router.get('/:docId/download', authMiddleware, validateProjectId.concat(validateDocId), async (req, res, next) => {
  try {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    const project = await getProjectAndCheckAccess(req, res);
    if (!project) return;
    const { rows } = await pool.query(
      'SELECT * FROM project_documents WHERE id = $1 AND project_id = $2',
      [req.params.docId, project.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Document not found' });
    const doc = rows[0];
    const fullPath = path.join(documentsDir, doc.file_path);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File not found' });
    logAudit({
      userId: req.userId,
      action: 'document_download',
      resourceType: 'project_document',
      resourceId: doc.id,
      details: JSON.stringify({ project_id: project.id, name: doc.name }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.download(fullPath, doc.name || doc.file_path);
  } catch (err) {
    next(err);
  }
});

export default router;
