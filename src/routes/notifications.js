import express from 'express';
import pool from '../db/index.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { body, validationResult, query } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../lib/audit.js';

const router = express.Router();

/** GET /api/v1/notifications/unread-count - count of unread (for red dot in nav) */
router.get('/unread-count', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND (is_read = false OR is_read = 0)',
      [req.userId]
    );
    const count = parseInt(rows[0]?.count ?? '0', 10);
    res.json({ count });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/notifications - list notifications for current user */
router.get('/', authMiddleware, query('is_read').optional().isBoolean(), async (req, res, next) => {
  try {
    let sql = 'SELECT * FROM notifications WHERE user_id = $1';
    const params = [req.userId];
    if (req.query.is_read !== undefined) { params.push(req.query.is_read); sql += ` AND is_read = $${params.length}`; }
    sql += ' ORDER BY created_at DESC LIMIT 100';
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/v1/notifications/:id/read - mark as read */
router.patch('/:id/read', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Notification not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/notifications/mark-all-read - mark all as read */
router.post('/mark-all-read', authMiddleware, async (req, res, next) => {
  try {
    await pool.query('UPDATE notifications SET is_read = true WHERE user_id = $1', [req.userId]);
    res.json({ message: 'All marked as read' });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/notifications - create notification (admin or system) */
router.post('/', authMiddleware, requireAdmin, [
  body('user_id').isUUID(),
  body('type').optional().trim(),
  body('title').trim().notEmpty(),
  body('message').optional().trim(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const id = uuidv4();
    await pool.query(
      `INSERT INTO notifications (id, user_id, type, title, message) VALUES ($1, $2, $3, $4, $5)`,
      [id, req.body.user_id, req.body.type || null, req.body.title, req.body.message || null]
    );
    logAudit({
      userId: req.userId,
      action: 'notification_create',
      resourceType: 'notification',
      resourceId: id,
      details: JSON.stringify({ target_user_id: req.body.user_id, title: req.body.title }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    const { rows } = await pool.query('SELECT * FROM notifications WHERE id = $1', [id]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

export default router;
