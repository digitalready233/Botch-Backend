import express from 'express';
import pool from '../db/index.js';
import { authMiddleware } from '../middleware/auth.js';
import { body, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import { createNotificationForUser } from '../lib/notifications.js';
import { publicPropertyFilterSql } from '../lib/listing-state.js';
import { isCustomerRole } from '../lib/roles.js';

const router = express.Router();

async function assertRentableProperty(propertyId) {
  const cond = publicPropertyFilterSql('');
  const { rows } = await pool.query(
    `SELECT id FROM properties WHERE id = $1 AND listing_purpose = 'rent' AND ${cond}`,
    [propertyId]
  );
  return rows.length > 0;
}

/** POST — client creates draft or submitted application */
router.post(
  '/',
  authMiddleware,
  [
    body('property_id').isUUID(),
    body('status').optional().isIn(['draft', 'submitted']),
    body('move_in_date').optional().trim(),
    body('employment_note').optional().trim(),
    body('notes').optional().trim(),
  ],
  async (req, res, next) => {
    try {
      if (!isCustomerRole(req.userRole)) {
        return res.status(403).json({ error: 'Only buyers and project clients can submit rental applications' });
      }
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { property_id, move_in_date, employment_note, notes, status: stIn } = req.body;
      const status = stIn === 'submitted' ? 'submitted' : 'draft';
      const ok = await assertRentableProperty(property_id);
      if (!ok) return res.status(404).json({ error: 'Rental listing not found or not available' });
      const id = uuidv4();
      await pool.query(
        `INSERT INTO rental_applications (id, property_id, vendor_id, move_in_date, employment_note, notes, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)`,
        [id, property_id, req.userId, move_in_date || null, employment_note || null, notes || null, status]
      );
      if (status === 'submitted') {
        const { rows: adminRows } = await pool.query(
          "SELECT id FROM users WHERE role IN ('admin', 'super_admin')"
        );
        const io = req.app.get('io');
        for (const admin of adminRows) {
          await createNotificationForUser(admin.id, 'rental_application', 'New rental application', 'A client submitted a rental application.');
          if (io) io.to(`user:${admin.id}`).emit('notification:new', { type: 'rental_application', title: 'Rental application', message: 'A client submitted a rental application.' });
        }
      }
      const { rows } = await pool.query(
        `SELECT ra.*, p.title AS property_title FROM rental_applications ra JOIN properties p ON p.id = ra.property_id WHERE ra.id = $1`,
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
        `SELECT ra.*, p.title AS property_title, u.full_name AS client_name, u.email AS client_email
         FROM rental_applications ra
         JOIN properties p ON p.id = ra.property_id
         JOIN users u ON u.id = ra.vendor_id
         ORDER BY ra.created_at DESC LIMIT 200`
      );
      return res.json(rows);
    }
    if (!isCustomerRole(req.userRole)) return res.status(403).json({ error: 'Access denied' });
    const { rows } = await pool.query(
      `SELECT ra.*, p.title AS property_title FROM rental_applications ra
       JOIN properties p ON p.id = ra.property_id
       WHERE ra.vendor_id = $1 ORDER BY ra.created_at DESC LIMIT 100`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/** Client updates draft / submit / withdraw; admin reviews */
router.patch(
  '/:id',
  authMiddleware,
  [
    body('status').optional().isIn(['draft', 'submitted', 'withdrawn', 'under_review', 'approved', 'rejected']),
    body('move_in_date').optional().trim(),
    body('employment_note').optional().trim(),
    body('notes').optional().trim(),
    body('admin_note').optional().trim(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { rows: existing } = await pool.query('SELECT * FROM rental_applications WHERE id = $1', [req.params.id]);
      if (!existing.length) return res.status(404).json({ error: 'Application not found' });
      const row = existing[0];
      const isAdmin = req.userRole === 'admin' || req.userRole === 'super_admin';
      const isOwner = row.vendor_id === req.userId;
      const b = req.body;

      if (isAdmin) {
        if (b.status !== undefined && !['under_review', 'approved', 'rejected'].includes(b.status)) {
          return res.status(400).json({ error: 'Invalid admin status' });
        }
        const cur = row.status;
        if (b.status === 'under_review' && cur !== 'submitted') {
          return res.status(400).json({ error: 'Can only move submitted applications to under_review' });
        }
        if ((b.status === 'approved' || b.status === 'rejected') && !['submitted', 'under_review'].includes(cur)) {
          return res.status(400).json({ error: 'Invalid transition' });
        }
        const updates = [];
        const params = [];
        let i = 1;
        if (b.status !== undefined) {
          updates.push(`status = $${i++}`);
          params.push(b.status);
        }
        if (b.admin_note !== undefined) {
          updates.push(`admin_note = $${i++}`);
          params.push(b.admin_note);
        }
        if (updates.length) {
          updates.push('updated_at = CURRENT_TIMESTAMP');
          params.push(req.params.id);
          await pool.query(`UPDATE rental_applications SET ${updates.join(', ')} WHERE id = $${i}`, params);
        }
        if (b.status === 'approved') {
          await pool.query(
            `UPDATE properties SET availability_status = 'booked', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [row.property_id]
          );
        }
      } else if (isOwner) {
        if (b.admin_note !== undefined) return res.status(403).json({ error: 'Access denied' });
        if (['approved', 'rejected', 'withdrawn'].includes(row.status)) {
          return res.status(400).json({ error: 'Application is closed' });
        }
        if (b.status === 'withdrawn') {
          if (!['draft', 'submitted'].includes(row.status)) {
            return res.status(400).json({ error: 'Cannot withdraw from this status' });
          }
          await pool.query(
            'UPDATE rental_applications SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            ['withdrawn', req.params.id]
          );
        } else {
          if (row.status !== 'draft') {
            if (b.move_in_date !== undefined || b.employment_note !== undefined || b.notes !== undefined) {
              return res.status(400).json({ error: 'Only draft applications can be edited' });
            }
            if (b.status === 'submitted' && row.status === 'submitted') {
              /* idempotent */
            } else if (b.status !== undefined && b.status !== 'submitted') {
              return res.status(400).json({ error: 'Invalid status' });
            }
          } else {
            const fields = [];
            const params = [];
            let i = 1;
            if (b.move_in_date !== undefined) {
              fields.push(`move_in_date = $${i++}`);
              params.push(b.move_in_date);
            }
            if (b.employment_note !== undefined) {
              fields.push(`employment_note = $${i++}`);
              params.push(b.employment_note);
            }
            if (b.notes !== undefined) {
              fields.push(`notes = $${i++}`);
              params.push(b.notes);
            }
            if (b.status === 'submitted') {
              fields.push(`status = $${i++}`);
              params.push('submitted');
            }
            if (fields.length) {
              fields.push('updated_at = CURRENT_TIMESTAMP');
              params.push(req.params.id);
              await pool.query(`UPDATE rental_applications SET ${fields.join(', ')} WHERE id = $${i}`, params);
            }
            if (b.status === 'submitted') {
              const { rows: adminRows } = await pool.query(
                "SELECT id FROM users WHERE role IN ('admin', 'super_admin')"
              );
              const io = req.app.get('io');
              for (const admin of adminRows) {
                await createNotificationForUser(admin.id, 'rental_application', 'Rental application submitted', 'A client submitted a rental application.');
                if (io) io.to(`user:${admin.id}`).emit('notification:new', { type: 'rental_application', title: 'Rental application', message: 'Submitted.' });
              }
            }
          }
        }
      } else {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { rows: out } = await pool.query(
        `SELECT ra.*, p.title AS property_title, u.full_name AS client_name, u.email AS client_email
         FROM rental_applications ra
         JOIN properties p ON p.id = ra.property_id
         JOIN users u ON u.id = ra.vendor_id
         WHERE ra.id = $1`,
        [req.params.id]
      );
      res.json(out[0]);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
