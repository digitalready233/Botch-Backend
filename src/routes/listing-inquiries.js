import express from 'express';
import pool from '../db/index.js';
import { authMiddleware } from '../middleware/auth.js';
import { body, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { createNotificationForUser } from '../lib/notifications.js';
import { requireActiveVendorBusiness } from '../middleware/vendor-business.js';
import { publicPropertyFilterSql } from '../lib/listing-state.js';
import { LEAD_STATUS_VALUES } from '../lib/lead-status.js';
import { resolveListingAgentId } from '../lib/property-agent.js';
import { isCustomerRole } from '../lib/roles.js';

const router = express.Router();

/** Ensure property is visible to buyers (for creating inquiries) */
async function assertPublicProperty(propertyId) {
  const cond = publicPropertyFilterSql('');
  const { rows } = await pool.query(`SELECT id FROM properties WHERE id = $1 AND ${cond}`, [propertyId]);
  return rows.length > 0;
}

const inquirySelect = `
  li.*,
  p.title AS property_title,
  u.full_name AS client_name,
  u.email AS client_email,
  agent.full_name AS agent_name,
  agent.email AS agent_email,
  agent.id AS agent_id
`;

const inquiryJoins = `
  FROM listing_inquiries li
  JOIN properties p ON p.id = li.property_id
  JOIN users u ON u.id = li.vendor_id
  JOIN users agent ON agent.id = li.assigned_to
`;

function tryDecodeAuthUser(req) {
  const authHeader = (req.get('authorization') || '').trim();
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;
  try {
    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    const decoded = jwt.verify(token, secret);
    return {
      userId: decoded?.userId || null,
      userRole: decoded?.role || null,
    };
  } catch (_) {
    return null;
  }
}

function canAccessInquiryRow(row, role, userId) {
  if (role === 'admin' || role === 'super_admin') return true;
  if (isCustomerRole(role) && row.vendor_id === userId) return true;
  if (role === 'vendor' && row.assigned_to === userId) return true;
  return false;
}

/** POST — client submits inquiry on a listing */
router.post(
  '/',
  authMiddleware,
  [body('property_id').isUUID(), body('message').optional().trim()],
  async (req, res, next) => {
    try {
      if (!isCustomerRole(req.userRole)) {
        return res.status(403).json({ error: 'Only buyers and project clients can submit listing inquiries' });
      }
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { property_id, message } = req.body;
      const ok = await assertPublicProperty(property_id);
      if (!ok) return res.status(404).json({ error: 'Listing not found or not available' });
      const agentId = await resolveListingAgentId(property_id);
      if (!agentId) {
        return res.status(503).json({ error: 'No agent is available to assign this lead. Please contact support.' });
      }
      const id = uuidv4();
      await pool.query(
        `INSERT INTO listing_inquiries (id, property_id, vendor_id, message, lead_status, assigned_to, updated_at)
         VALUES ($1, $2, $3, $4, 'new', $5, CURRENT_TIMESTAMP)
         ON CONFLICT(property_id, vendor_id) DO UPDATE SET
           message = COALESCE(excluded.message, message),
           lead_status = 'new',
           assigned_to = excluded.assigned_to,
           updated_at = CURRENT_TIMESTAMP`,
        [id, property_id, req.userId, message || null, agentId]
      );

      const { rows: propRows } = await pool.query('SELECT title FROM properties WHERE id = $1', [property_id]);
      const title = propRows[0]?.title || 'a property';
      const { rows: clientRows } = await pool.query('SELECT full_name, email FROM users WHERE id = $1', [req.userId]);
      const clientLabel = clientRows[0]?.full_name || clientRows[0]?.email || 'A client';

      const notifTitle = 'New property inquiry';
      const notifMessage = `${clientLabel} inquired about “${title}”.`;

      const { rows: adminRows } = await pool.query(
        "SELECT id FROM users WHERE role IN ('admin', 'super_admin')"
      );
      const io = req.app.get('io');
      for (const admin of adminRows) {
        await createNotificationForUser(admin.id, 'listing_inquiry', notifTitle, notifMessage);
        if (io) io.to(`user:${admin.id}`).emit('notification:new', { type: 'listing_inquiry', title: notifTitle, message: notifMessage });
      }

      if (agentId) {
        await createNotificationForUser(agentId, 'listing_inquiry', notifTitle, notifMessage);
        if (io) io.to(`user:${agentId}`).emit('notification:new', { type: 'listing_inquiry', title: notifTitle, message: notifMessage });
      }

      const { rows } = await pool.query(
        `SELECT ${inquirySelect} ${inquiryJoins} WHERE li.property_id = $1 AND li.vendor_id = $2 ORDER BY li.updated_at DESC LIMIT 1`,
        [property_id, req.userId]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

/** POST /contact — public contact-form inquiry with listing context (ties to client when bearer token is present) */
router.post(
  '/contact',
  [
    body('property_id').isUUID(),
    body('message').trim().isLength({ min: 5, max: 2000 }),
    body('name').optional().trim().isLength({ max: 255 }),
    body('email').optional().trim().isEmail(),
    body('source').optional().trim().isLength({ max: 100 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { property_id, message, name, email, source } = req.body;
      const ok = await assertPublicProperty(property_id);
      if (!ok) return res.status(404).json({ error: 'Listing not found or not available' });

      const authUser = tryDecodeAuthUser(req);
      const { rows: propRows } = await pool.query('SELECT title FROM properties WHERE id = $1', [property_id]);
      const title = propRows[0]?.title || 'a property';
      const io = req.app.get('io');
      const agentId = await resolveListingAgentId(property_id);

      let leadId = null;
      if (authUser?.userId && isCustomerRole(authUser.userRole) && agentId) {
        const newId = uuidv4();
        await pool.query(
          `INSERT INTO listing_inquiries (id, property_id, vendor_id, message, lead_status, assigned_to, updated_at)
           VALUES ($1, $2, $3, $4, 'new', $5, CURRENT_TIMESTAMP)
           ON CONFLICT(property_id, vendor_id) DO UPDATE SET
             message = COALESCE(excluded.message, message),
             lead_status = 'new',
             assigned_to = excluded.assigned_to,
             updated_at = CURRENT_TIMESTAMP`,
          [newId, property_id, authUser.userId, message, agentId]
        );
        const { rows: idRows } = await pool.query(
          'SELECT id FROM listing_inquiries WHERE property_id = $1 AND vendor_id = $2 ORDER BY updated_at DESC LIMIT 1',
          [property_id, authUser.userId]
        );
        leadId = idRows[0]?.id ?? null;
      }

      const senderLabel = name || email || 'A visitor';
      const notifTitle = 'Listing contact inquiry';
      const notifMessage = `${senderLabel} asked about “${title}”.${source ? ` Source: ${source}.` : ''}`;
      const { rows: adminRows } = await pool.query("SELECT id FROM users WHERE role IN ('admin', 'super_admin')");
      for (const admin of adminRows) {
        await createNotificationForUser(admin.id, 'listing_inquiry', notifTitle, notifMessage);
        if (io) io.to(`user:${admin.id}`).emit('notification:new', { type: 'listing_inquiry', title: notifTitle, message: notifMessage });
      }
      if (agentId) {
        await createNotificationForUser(agentId, 'listing_inquiry', notifTitle, notifMessage);
        if (io) io.to(`user:${agentId}`).emit('notification:new', { type: 'listing_inquiry', title: notifTitle, message: notifMessage });
      }

      return res.status(201).json({
        ok: true,
        inquiry_id: leadId,
        message: 'Inquiry submitted',
      });
    } catch (err) {
      next(err);
    }
  }
);

/** GET — list: admin all; vendor assigned; client own */
router.get('/', authMiddleware, async (req, res, next) => {
  try {
    const role = req.userRole;
    if (role === 'admin' || role === 'super_admin') {
      const { rows } = await pool.query(
        `SELECT ${inquirySelect} ${inquiryJoins}
         ORDER BY li.created_at DESC LIMIT 500`
      );
      return res.json(rows);
    }
    if (role === 'vendor') {
      const { rows } = await pool.query(
        `SELECT ${inquirySelect} ${inquiryJoins}
         WHERE li.assigned_to = $1
         ORDER BY li.created_at DESC LIMIT 200`,
        [req.userId]
      );
      return res.json(rows);
    }
    if (isCustomerRole(role)) {
      const { rows } = await pool.query(
        `SELECT ${inquirySelect} ${inquiryJoins}
         WHERE li.vendor_id = $1
         ORDER BY li.created_at DESC LIMIT 100`,
        [req.userId]
      );
      return res.json(rows);
    }
    return res.status(403).json({ error: 'Access denied' });
  } catch (err) {
    next(err);
  }
});

/** GET /:id — single lead (admin inspect, assigned vendor, or owning client) */
router.get('/:id', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT ${inquirySelect} ${inquiryJoins} WHERE li.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Inquiry not found' });
    const row = rows[0];
    if (!canAccessInquiryRow(row, req.userRole, req.userId)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

/** PATCH — admin: any field; vendor: only assigned leads, status only (no reassignment) */
router.patch(
  '/:id',
  authMiddleware,
  requireActiveVendorBusiness({ enforce: false }),
  [
    body('lead_status').optional().isIn(LEAD_STATUS_VALUES),
    body('assigned_to').optional({ nullable: true }).isUUID(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { rows: existing } = await pool.query('SELECT * FROM listing_inquiries WHERE id = $1', [req.params.id]);
      if (!existing.length) return res.status(404).json({ error: 'Inquiry not found' });
      const row = existing[0];

      const isAdmin = req.userRole === 'admin' || req.userRole === 'super_admin';
      const isVendor = req.userRole === 'vendor';
      if (!isAdmin && !isVendor) {
        return res.status(403).json({ error: 'Only admins and assigned agents can update leads' });
      }
      if (isVendor && row.assigned_to !== req.userId) {
        return res.status(403).json({ error: 'You can only update leads assigned to you' });
      }
      if (isVendor && req.body.assigned_to !== undefined) {
        return res.status(403).json({ error: 'Only admins can reassign leads' });
      }

      const updates = [];
      const params = [];
      let i = 1;
      if (req.body.lead_status !== undefined) {
        updates.push(`lead_status = $${i++}`);
        params.push(req.body.lead_status);
      }
      if (isAdmin && req.body.assigned_to !== undefined) {
        updates.push(`assigned_to = $${i++}`);
        params.push(req.body.assigned_to);
      }
      if (!updates.length) {
        const { rows } = await pool.query(`SELECT ${inquirySelect} ${inquiryJoins} WHERE li.id = $1`, [req.params.id]);
        return res.json(rows[0]);
      }
      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(req.params.id);
      await pool.query(`UPDATE listing_inquiries SET ${updates.join(', ')} WHERE id = $${i}`, params);
      const { rows } = await pool.query(`SELECT ${inquirySelect} ${inquiryJoins} WHERE li.id = $1`, [req.params.id]);
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
