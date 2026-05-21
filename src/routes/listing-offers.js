import express from 'express';
import pool from '../db/index.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { body, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import { createNotificationForUser } from '../lib/notifications.js';
import { publicPropertyFilterSql } from '../lib/listing-state.js';
import { isCustomerRole } from '../lib/roles.js';

const router = express.Router();

async function assertOfferableProperty(propertyId) {
  const cond = publicPropertyFilterSql('');
  const { rows } = await pool.query(
    `SELECT id FROM properties WHERE id = $1 AND COALESCE(listing_purpose, 'sale') = 'sale' AND ${cond}`,
    [propertyId]
  );
  return rows.length > 0;
}

/** POST — client submits offer (sale listings only) */
router.post(
  '/',
  authMiddleware,
  [
    body('property_id').isUUID(),
    body('amount').isFloat({ min: 0 }),
    body('currency').optional().trim(),
    body('terms_note').optional().trim(),
  ],
  async (req, res, next) => {
    try {
      if (!isCustomerRole(req.userRole)) {
        return res.status(403).json({ error: 'Only buyers and project clients can submit offers' });
      }
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { property_id, amount, currency, terms_note } = req.body;
      const ok = await assertOfferableProperty(property_id);
      if (!ok) return res.status(404).json({ error: 'Property not found or not available for offers' });
      const id = uuidv4();
      const cur = (currency || 'USD').toUpperCase();
      await pool.query(
        `INSERT INTO listing_offers (id, property_id, vendor_id, amount, currency, terms_note, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'submitted', CURRENT_TIMESTAMP)`,
        [id, property_id, req.userId, amount, cur, terms_note || null]
      );
      const { rows: adminRows } = await pool.query(
        "SELECT id FROM users WHERE role IN ('admin', 'super_admin')"
      );
      const io = req.app.get('io');
      for (const admin of adminRows) {
        await createNotificationForUser(admin.id, 'listing_offer', 'New purchase offer', `A client submitted an offer of ${cur} ${amount}.`);
        if (io) io.to(`user:${admin.id}`).emit('notification:new', { type: 'listing_offer', title: 'New offer', message: 'A client submitted a purchase offer.' });
      }
      const { rows } = await pool.query(
        `SELECT lo.*, p.title AS property_title FROM listing_offers lo JOIN properties p ON p.id = lo.property_id WHERE lo.id = $1`,
        [id]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

router.get('/', authMiddleware, async (req, res, next) => {
  try {
    if (req.userRole === 'admin' || req.userRole === 'super_admin') {
      const { rows } = await pool.query(
        `SELECT lo.*, p.title AS property_title, u.full_name AS client_name, u.email AS client_email
         FROM listing_offers lo
         JOIN properties p ON p.id = lo.property_id
         JOIN users u ON u.id = lo.vendor_id
         ORDER BY lo.created_at DESC LIMIT 200`
      );
      return res.json(rows);
    }
    if (!isCustomerRole(req.userRole)) return res.status(403).json({ error: 'Access denied' });
    const { rows } = await pool.query(
      `SELECT lo.*, p.title AS property_title FROM listing_offers lo
       JOIN properties p ON p.id = lo.property_id
       WHERE lo.vendor_id = $1 ORDER BY lo.created_at DESC LIMIT 100`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/** Withdraw (client) or review / finalize (admin) */
router.patch(
  '/:id',
  authMiddleware,
  [
    body('status').optional().isIn(['withdrawn', 'under_review', 'accepted', 'rejected']),
    body('admin_note').optional().trim(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { rows: existing } = await pool.query('SELECT * FROM listing_offers WHERE id = $1', [req.params.id]);
      if (!existing.length) return res.status(404).json({ error: 'Offer not found' });
      const row = existing[0];
      const isAdmin = req.userRole === 'admin' || req.userRole === 'super_admin';
      const isOwner = row.vendor_id === req.userId;

      const terminal = ['accepted', 'rejected', 'withdrawn'];
      if (terminal.includes(row.status)) {
        return res.status(400).json({ error: 'Offer is closed' });
      }

      const { status, admin_note } = req.body;
      if (status === undefined && admin_note === undefined) {
        const { rows: out } = await pool.query(
          `SELECT lo.*, p.title AS property_title FROM listing_offers lo JOIN properties p ON p.id = lo.property_id WHERE lo.id = $1`,
          [req.params.id]
        );
        return res.json(out[0]);
      }

      if (!isAdmin && isOwner) {
        if (admin_note !== undefined) return res.status(403).json({ error: 'Access denied' });
        if (status !== 'withdrawn') {
          return res.status(403).json({ error: 'Clients may only withdraw an offer' });
        }
        await pool.query(
          'UPDATE listing_offers SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          ['withdrawn', req.params.id]
        );
      } else if (isAdmin) {
        if (status !== undefined) {
          if (!['under_review', 'accepted', 'rejected'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status for admin update' });
          }
          const cur = row.status;
          if (status === 'under_review' && !['submitted'].includes(cur)) {
            return res.status(400).json({ error: 'Invalid transition to under_review' });
          }
          if ((status === 'accepted' || status === 'rejected') && !['submitted', 'under_review'].includes(cur)) {
            return res.status(400).json({ error: 'Invalid transition from current status' });
          }
          await pool.query(
            `UPDATE listing_offers SET status = $1, admin_note = COALESCE($2, admin_note), updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
            [status, admin_note ?? null, req.params.id]
          );
          if (status === 'accepted') {
            await pool.query(
              `UPDATE properties SET availability_status = 'booked', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
              [row.property_id]
            );
          }
        } else if (admin_note !== undefined) {
          await pool.query(
            `UPDATE listing_offers SET admin_note = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [admin_note, req.params.id]
          );
        }
      } else {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { rows: out } = await pool.query(
        `SELECT lo.*, p.title AS property_title, u.full_name AS client_name, u.email AS client_email
         FROM listing_offers lo
         JOIN properties p ON p.id = lo.property_id
         JOIN users u ON u.id = lo.vendor_id
         WHERE lo.id = $1`,
        [req.params.id]
      );
      res.json(out[0]);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
