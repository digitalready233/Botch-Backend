import express from 'express';
import pool from '../db/index.js';
import { createNotificationForUser } from '../lib/notifications.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { body, validationResult, query } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../lib/audit.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { uploadToS3, isS3Configured } from '../lib/s3.js';
import { fileFilter, ALLOWED_INVOICE_MIMES } from '../lib/upload-validation.js';
import { getUploadsBase } from '../lib/upload-paths.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const invoicesDir = path.join(getUploadsBase(path.join(__dirname, '..', '..', 'uploads')), 'invoices');
try { fs.mkdirSync(invoicesDir, { recursive: true }); } catch (_) {}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, invoicesDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.pdf';
    cb(null, uuidv4() + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 }, fileFilter: fileFilter(ALLOWED_INVOICE_MIMES, 'Invoice attachment') }); // 15MB

const router = express.Router();

function invoiceNumber() {
  return 'INV-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

/** GET /api/v1/invoices - list invoices (client: own, admin: all) */
router.get('/', authMiddleware, query('status').optional(), query('project_id').optional(), async (req, res, next) => {
  try {
    if (req.userRole === 'admin' || req.userRole === 'super_admin') {
      let sql = `
        SELECT i.*, p.name AS project_name, u.full_name AS client_name
        FROM invoices i
        JOIN projects p ON i.project_id = p.id
        JOIN users u ON i.client_id = u.id
        WHERE 1=1
      `;
      const params = [];
      if (req.query.status) { params.push(req.query.status); sql += ` AND i.status = $${params.length}`; }
      if (req.query.project_id) { params.push(req.query.project_id); sql += ` AND i.project_id = $${params.length}`; }
      sql += ' ORDER BY i.created_at DESC';
      const { rows } = await pool.query(sql, params);
      return res.json(rows);
    }
    if (req.userRole === 'vendor') {
      return res.status(403).json({ error: 'Invoices are not available for vendor accounts.' });
    }
    if (req.userRole === 'buyer') {
      return res.status(403).json({ error: 'Invoices are not available for buyer accounts.' });
    }
    let sql = 'SELECT i.*, p.name AS project_name FROM invoices i JOIN projects p ON i.project_id = p.id WHERE i.client_id = $1';
    const params = [req.userId];
    if (req.query.status) { params.push(req.query.status); sql += ` AND i.status = $${params.length}`; }
    if (req.query.project_id) { params.push(req.query.project_id); sql += ` AND i.project_id = $${params.length}`; }
    sql += ' ORDER BY i.created_at DESC';
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/invoices/:id/view - client marks invoice as viewed/downloaded; notifies all admins */
router.post('/:id/view', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows: existing } = await pool.query(
      'SELECT id, invoice_number, client_id, project_id FROM invoices WHERE id = $1',
      [id]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    const inv = existing[0];
    if (inv.client_id !== req.userId) return res.status(403).json({ error: "You don't have permission to do that." });
    await pool.query('UPDATE invoices SET viewed_at = COALESCE(viewed_at, CURRENT_TIMESTAMP) WHERE id = $1', [id]);
    const { rows: clientRow } = await pool.query('SELECT full_name, email FROM users WHERE id = $1', [req.userId]);
    const clientName = clientRow[0]?.full_name || clientRow[0]?.email || 'A client';
    const title = 'Invoice viewed or downloaded';
    const message = `${clientName} viewed or downloaded invoice ${inv.invoice_number}.`;
    const { rows: adminRows } = await pool.query(
      "SELECT id FROM users WHERE role IN ('admin', 'super_admin')"
    );
    const io = req.app.get('io');
    for (const admin of adminRows) {
      const { rows: recent } = await pool.query(
        `SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'invoice_viewed' AND message LIKE $2
         AND datetime(created_at) > datetime('now', '-24 hours') LIMIT 1`,
        [admin.id, `%${inv.invoice_number}%`]
      );
      if (recent?.length) continue;
      await createNotificationForUser(admin.id, 'invoice_viewed', title, message);
      if (io) io.to(`user:${admin.id}`).emit('notification:new', { type: 'invoice_viewed', title, message });
    }
    const { rows } = await pool.query('SELECT * FROM invoices WHERE id = $1', [id]);
    return res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/invoices/:id - get one invoice */
router.get('/:id', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.*, p.name AS project_name, m.name AS milestone_name
       FROM invoices i
       JOIN projects p ON i.project_id = p.id
       LEFT JOIN milestones m ON i.milestone_id = m.id
       WHERE i.id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    const inv = rows[0];
    if (req.userRole === 'admin' || req.userRole === 'super_admin') {
      return res.json(inv);
    }
    if (req.userRole === 'client') {
      if (inv.client_id !== req.userId) {
        return res.status(403).json({ error: "You don't have permission to do that." });
      }
      return res.json(inv);
    }
    if (req.userRole === 'vendor' || req.userRole === 'buyer') {
      return res.status(403).json({ error: 'Invoices are not available for this account type.' });
    }
    return res.status(403).json({ error: "You don't have permission to do that." });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/invoices - create invoice (admin only) */
router.post('/', authMiddleware, requireAdmin, [
  body('project_id')
    .isUUID()
    .withMessage('Please select a project.'),
  body('client_id')
    .isUUID()
    .withMessage('Please select a client.'),
  body('milestone_id')
    .optional({ values: 'falsy' })
    .isUUID()
    .withMessage('Milestone must be a valid selection when provided.'),
  body('amount')
    .isFloat({ min: 0 })
    .withMessage('Amount must be a positive number.'),
  body('due_date')
    .optional({ values: 'falsy' })
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage('Due date must be YYYY-MM-DD.'),
  body('currency')
    .optional({ values: 'falsy' })
    .isIn(['USD', 'GBP', 'EUR', 'GHS'])
    .withMessage('Currency must be USD, GBP, EUR, or GHS.'),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const arr = errors.array();
      const firstMsg = (arr[0] && (arr[0].msg || arr[0].message)) || 'Validation failed';
      return res.status(400).json({ errors: arr, error: firstMsg });
    }
    const id = uuidv4();
    const invoice_number = invoiceNumber();
    const { project_id, client_id, milestone_id, amount, due_date, currency } = req.body;
    const amountNum = amount != null ? (typeof amount === 'string' ? parseFloat(amount) : Number(amount)) : 0;
    const currencyVal = (currency || 'USD').toUpperCase();
    if (isNaN(amountNum) || amountNum < 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }
    await pool.query(
      `INSERT INTO invoices (id, invoice_number, project_id, client_id, milestone_id, amount, status, due_date, currency)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)`,
      [id, invoice_number, project_id, client_id, milestone_id || null, amountNum, due_date || null, currencyVal]
    );
    await createNotificationForUser(client_id, 'invoice_ready', 'Invoice ready', `Invoice ${invoice_number} is ready for payment.`);
    const io = req.app.get('io');
    if (io) io.to(`user:${client_id}`).emit('notification:new', { type: 'invoice_ready', title: 'Invoice ready', message: `Invoice ${invoice_number} is ready for payment.` });
    logAudit({
      userId: req.userId,
      action: 'invoice_create',
      resourceType: 'invoice',
      resourceId: id,
      details: JSON.stringify({ invoice_number, project_id, client_id, amount: amountNum }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    const { rows } = await pool.query(
      'SELECT i.*, p.name AS project_name FROM invoices i JOIN projects p ON i.project_id = p.id WHERE i.id = $1',
      [id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Invoice create error:', err);
    res.status(500).json({ error: err.message || 'Failed to create invoice' });
  }
});

/** PATCH /api/v1/invoices/:id - update invoice (admin), e.g. mark viewed, upload pdf_url */
router.patch('/:id', authMiddleware, [
  body('status').optional().isIn(['pending', 'paid', 'overdue']),
  body('pdf_url').optional().trim(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { rows: existing } = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    const inv = existing[0];
    if (req.userRole === 'client') {
      if (inv.client_id !== req.userId) return res.status(403).json({ error: "You don't have permission to do that." });
      await pool.query('UPDATE invoices SET viewed_at = COALESCE(viewed_at, CURRENT_TIMESTAMP) WHERE id = $1', [req.params.id]);
      const { rows } = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
      return res.json(rows[0]);
    }
    if (req.userRole !== 'admin' && req.userRole !== 'super_admin') {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }
    const updates = {};
    if (req.body.status !== undefined) updates.status = req.body.status;
    if (req.body.pdf_url !== undefined) updates.pdf_url = req.body.pdf_url;
    if (Object.keys(updates).length === 0) return res.json(inv);
    const setClause = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
    await pool.query(`UPDATE invoices SET ${setClause} WHERE id = $1`, [req.params.id, ...Object.values(updates)]);
    if (req.userRole === 'admin' || req.userRole === 'super_admin') {
      logAudit({
        userId: req.userId,
        action: 'invoice_update',
        resourceType: 'invoice',
        resourceId: req.params.id,
        details: JSON.stringify(updates),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
    }
    const { rows } = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/invoices/:id/pdf - admin upload invoice attachment (PDF, image, or Word doc; URL stored in pdf_url) */
router.post('/:id/pdf', authMiddleware, requireAdmin, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { id } = req.params;
    const { rows: existing } = await pool.query('SELECT * FROM invoices WHERE id = $1', [id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Invoice not found' });

    let pdfUrl;
    if (isS3Configured()) {
      const buffer = fs.readFileSync(req.file.path);
      const key = `invoices/${id}-${req.file.filename}`;
      pdfUrl = await uploadToS3(buffer, key, req.file.mimetype || 'application/pdf');
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
    if (!pdfUrl) {
      pdfUrl = `/uploads/invoices/${req.file.filename}`;
    }
    await pool.query('UPDATE invoices SET pdf_url = $1 WHERE id = $2', [pdfUrl, id]);
    const inv = existing[0];
    const clientId = inv.client_id;
    const invoiceNumber = inv.invoice_number;
    await createNotificationForUser(
      clientId,
      'invoice_pdf_ready',
      'Invoice file ready',
      `Your invoice ${invoiceNumber} file has been uploaded and is ready to view.`
    );
    const io = req.app.get('io');
    if (io) io.to(`user:${clientId}`).emit('notification:new', { type: 'invoice_pdf_ready', title: 'Invoice file ready', message: `Invoice ${invoiceNumber} file is ready.` });
    logAudit({
      userId: req.userId,
      action: 'invoice_pdf_upload',
      resourceType: 'invoice',
      resourceId: id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    const { rows } = await pool.query('SELECT * FROM invoices WHERE id = $1', [id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

export default router;
