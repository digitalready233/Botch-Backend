import express from 'express';
import pool from '../db/index.js';
import { authMiddleware } from '../middleware/auth.js';
import { body, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import { createNotificationForUser } from '../lib/notifications.js';
import { logAudit } from '../lib/audit.js';
import { publicPropertyFilterSql } from '../lib/listing-state.js';
import { resolveListingAgentId } from '../lib/property-agent.js';
import { BOOKING_STATUS_VALUES } from '../lib/booking-status.js';
import { computeDefaultReminderAt, scheduleReminderJob } from '../lib/appointment-reminders.js';

const router = express.Router();

const appointmentSelect = `
  a.*,
  u.full_name AS client_name,
  u.email AS client_email,
  agent.full_name AS agent_name,
  agent.email AS agent_email,
  p.name AS project_name,
  pr.title AS property_title
`;

const appointmentJoins = `
  FROM appointments a
  LEFT JOIN users u ON u.id = a.client_id
  LEFT JOIN users agent ON agent.id = a.agent_id
  LEFT JOIN projects p ON p.id = a.project_id
  LEFT JOIN properties pr ON pr.id = a.property_id
`;

async function assertPublicPropertyForBooking(propertyId) {
  const cond = publicPropertyFilterSql('');
  const { rows } = await pool.query(
    `SELECT id FROM properties WHERE id = $1 AND COALESCE(availability_status, 'available') = 'available' AND ${cond}`,
    [propertyId]
  );
  return rows.length > 0;
}

function canViewAppointment(row, role, userId) {
  if (role === 'admin' || role === 'super_admin') return true;
  if (role === 'client' && row.client_id === userId) return true;
  if (role === 'vendor' && row.agent_id && row.agent_id === userId) return true;
  return false;
}

async function notifyParticipants({ clientId, agentId, adminToo, title, message, io }) {
  const targets = new Set();
  if (clientId) targets.add(clientId);
  if (agentId) targets.add(agentId);
  if (adminToo) {
    const { rows } = await pool.query("SELECT id FROM users WHERE role IN ('admin', 'super_admin')");
    for (const r of rows) targets.add(r.id);
  }
  for (const uid of targets) {
    await createNotificationForUser(uid, 'appointment_update', title, message);
    if (io) io.to(`user:${uid}`).emit('notification:new', { type: 'appointment_update', title, message });
  }
}

/** GET /api/v1/appointments — client: own; vendor: assigned property viewings; admin: all */
router.get('/', authMiddleware, async (req, res, next) => {
  try {
    if (req.userRole === 'admin' || req.userRole === 'super_admin') {
      const { rows } = await pool.query(
        `SELECT ${appointmentSelect} ${appointmentJoins}
         ORDER BY a.created_at DESC LIMIT 500`
      );
      return res.json(rows);
    }
    if (req.userRole === 'vendor') {
      const { rows } = await pool.query(
        `SELECT ${appointmentSelect} ${appointmentJoins}
         WHERE a.agent_id = $1
         ORDER BY a.created_at DESC LIMIT 200`,
        [req.userId]
      );
      return res.json(rows);
    }
    if (req.userRole === 'client') {
      const { rows } = await pool.query(
        `SELECT ${appointmentSelect} ${appointmentJoins}
         WHERE a.client_id = $1
         ORDER BY a.created_at DESC LIMIT 200`,
        [req.userId]
      );
      return res.json(rows);
    }
    return res.status(403).json({ error: 'Access denied' });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/appointments/:id */
router.get('/:id', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT ${appointmentSelect} ${appointmentJoins} WHERE a.id = $1`, [
      req.params.id,
    ]);
    if (!rows.length) return res.status(404).json({ error: 'Appointment not found' });
    if (!canViewAppointment(rows[0], req.userRole, req.userId)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** POST — client books; property viewings get assigned agent */
router.post(
  '/',
  authMiddleware,
  [
    body('title').trim().notEmpty().withMessage('Title is required'),
    body('project_id').optional().isUUID(),
    body('property_id').optional().isUUID(),
    body('preferred_date').optional().trim(),
    body('preferred_time').optional().trim(),
    body('notes').optional().trim(),
  ],
  async (req, res, next) => {
    try {
      if (req.userRole !== 'client') {
        return res.status(403).json({ error: 'Only clients can book appointments' });
      }
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { title, project_id, property_id, preferred_date, preferred_time, notes } = req.body;
      const pid = project_id && String(project_id).trim() ? String(project_id).trim() : null;
      const prid = property_id && String(property_id).trim() ? String(property_id).trim() : null;
      if (pid && prid) {
        return res.status(400).json({ error: 'Provide either project_id or property_id, not both.' });
      }
      const effectiveProjectId = prid ? null : pid;
      const effectivePropertyId = pid ? null : prid;

      let agentId = null;
      if (effectivePropertyId) {
        const ok = await assertPublicPropertyForBooking(effectivePropertyId);
        if (!ok) {
          return res.status(400).json({ error: 'Property is not available for viewing requests' });
        }
        agentId = await resolveListingAgentId(effectivePropertyId);
        if (!agentId) {
          return res.status(503).json({ error: 'No agent is available to handle this viewing. Please try again later.' });
        }
      }

      const id = uuidv4();
      const reminderAt = computeDefaultReminderAt({
        scheduled_date: null,
        scheduled_time: null,
        preferred_date,
        preferred_time,
      });

      await pool.query(
        `INSERT INTO appointments (
          id, client_id, project_id, property_id, agent_id, title,
          preferred_date, preferred_time, notes, status,
          reminder_at, updated_at
        )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, CURRENT_TIMESTAMP)`,
        [
          id,
          req.userId,
          effectiveProjectId,
          effectivePropertyId,
          agentId,
          title,
          preferred_date || null,
          preferred_time || null,
          notes || null,
          reminderAt,
        ]
      );

      scheduleReminderJob(id, reminderAt);

      const { rows: clientRow } = await pool.query('SELECT full_name, email FROM users WHERE id = $1', [req.userId]);
      const clientName = clientRow[0]?.full_name || clientRow[0]?.email || 'A client';
      const dateStr = preferred_date ? ` for ${preferred_date}` : '';
      const timeStr = preferred_time ? ` (${preferred_time})` : '';
      const notifTitle = 'Appointment requested';
      const notifMessage = `${clientName} requested an appointment${dateStr}${timeStr}: ${title}.${notes ? ` ${notes}` : ''}`;

      const io = req.app.get('io');
      await notifyParticipants({
        clientId: null,
        agentId,
        adminToo: true,
        title: notifTitle,
        message: notifMessage,
        io,
      });

      const { rows } = await pool.query(`SELECT ${appointmentSelect} ${appointmentJoins} WHERE a.id = $1`, [id]);
      res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

/** PATCH — admin: full; vendor: assigned bookings; client: cancel own */
router.patch('/:id', authMiddleware, async (req, res, next) => {
  try {
    const { rows: existing } = await pool.query('SELECT * FROM appointments WHERE id = $1', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Appointment not found' });
    const row = existing[0];

    if (!canViewAppointment(row, req.userRole, req.userId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const isAdmin = req.userRole === 'admin' || req.userRole === 'super_admin';
    const isVendor = req.userRole === 'vendor' && row.agent_id === req.userId;
    const isClient = req.userRole === 'client' && row.client_id === req.userId;

    const statusIn = (v) => BOOKING_STATUS_VALUES.includes(v);

    if (req.body.status !== undefined && !statusIn(req.body.status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    if (isClient) {
      const allowedKeys = ['status', 'cancellation_reason'];
      if (Object.keys(req.body).some((k) => !allowedKeys.includes(k))) {
        return res.status(403).json({ error: 'Clients can only cancel bookings' });
      }
      if (req.body.status !== undefined && req.body.status !== 'cancelled') {
        return res.status(403).json({ error: 'Clients can only set status to cancelled' });
      }
      if (req.body.status === 'cancelled') {
        const allowed = ['pending', 'confirmed', 'rescheduled'];
        if (!allowed.includes(row.status)) {
          return res.status(400).json({ error: 'This booking cannot be cancelled' });
        }
      }
    }

    if (isVendor && !isAdmin) {
      const forbidden = ['client_id', 'project_id', 'property_id', 'agent_id'];
      for (const k of forbidden) {
        if (req.body[k] !== undefined) return res.status(403).json({ error: `Cannot update ${k}` });
      }
      if (req.body.status !== undefined) {
        const v = req.body.status;
        if (!['confirmed', 'rescheduled', 'cancelled', 'completed'].includes(v)) {
          return res.status(403).json({ error: 'Invalid status for agent' });
        }
      }
    }

    const updates = [];
    const params = [];
    let i = 1;

    const set = (col, val) => {
      updates.push(`${col} = $${i++}`);
      params.push(val);
    };

    if (req.body.status !== undefined) set('status', req.body.status);
    if (req.body.scheduled_date !== undefined) set('scheduled_date', req.body.scheduled_date || null);
    if (req.body.scheduled_time !== undefined) set('scheduled_time', req.body.scheduled_time || null);
    if (req.body.reschedule_note !== undefined) set('reschedule_note', req.body.reschedule_note || null);
    if (req.body.cancellation_reason !== undefined) set('cancellation_reason', req.body.cancellation_reason || null);
    if (isAdmin) {
      if (req.body.title !== undefined) set('title', req.body.title);
      if (req.body.notes !== undefined) set('notes', req.body.notes || null);
      if (req.body.agent_id !== undefined) set('agent_id', req.body.agent_id || null);
    }

    if (!updates.length) {
      const { rows } = await pool.query(`SELECT ${appointmentSelect} ${appointmentJoins} WHERE a.id = $1`, [req.params.id]);
      return res.json(rows[0]);
    }

    let reminderAt = row.reminder_at;
    if (
      req.body.scheduled_date !== undefined ||
      req.body.scheduled_time !== undefined ||
      req.body.status === 'confirmed' ||
      req.body.status === 'rescheduled'
    ) {
      const merged = {
        scheduled_date: req.body.scheduled_date !== undefined ? req.body.scheduled_date : row.scheduled_date,
        scheduled_time: req.body.scheduled_time !== undefined ? req.body.scheduled_time : row.scheduled_time,
        preferred_date: row.preferred_date,
        preferred_time: row.preferred_time,
      };
      const next = computeDefaultReminderAt(merged);
      if (next) {
        updates.push(`reminder_at = $${i++}`);
        params.push(next);
        reminderAt = next;
      }
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    const whereIdx = i;
    params.push(req.params.id);

    await pool.query(`UPDATE appointments SET ${updates.join(', ')} WHERE id = $${whereIdx}`, params);

    const { rows: out } = await pool.query(`SELECT ${appointmentSelect} ${appointmentJoins} WHERE a.id = $1`, [req.params.id]);
    const ap = out[0];

    if (req.body.status !== undefined) {
      scheduleReminderJob(req.params.id, reminderAt);
      const io = req.app.get('io');
      const title = 'Booking updated';
      const message = `Your viewing/booking "${ap.title}" is now: ${ap.status}.`;
      if (isClient) {
        await notifyParticipants({
          clientId: null,
          agentId: ap.agent_id,
          adminToo: true,
          title: 'Booking cancelled by client',
          message: `${ap.client_name || 'Client'} cancelled: ${ap.title}`,
          io,
        });
      } else {
        await notifyParticipants({
          clientId: ap.client_id,
          agentId: ap.agent_id,
          adminToo: isVendor,
          title,
          message,
          io,
        });
      }
    }

    logAudit({
      userId: req.userId,
      action: 'appointment_update',
      resourceType: 'appointment',
      resourceId: req.params.id,
      details: JSON.stringify({ body: req.body }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json(ap);
  } catch (err) {
    next(err);
  }
});

export default router;
