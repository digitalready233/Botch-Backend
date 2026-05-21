import express from 'express';
import pool from '../db/index.js';
import { authMiddleware } from '../middleware/auth.js';
import { body, param, query, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../lib/audit.js';

const router = express.Router();

const ADMIN_CLASS = ['admin', 'super_admin', 'vendor_admin', 'finance_admin', 'moderator', 'editor'];

function isOpsAdmin(role) {
  return role === 'admin' || role === 'super_admin';
}

function requireOpsAdmin(req, res, next) {
  if (!isOpsAdmin(req.userRole)) return res.status(403).json({ error: 'Admin access required' });
  next();
}

/** GET /api/v1/project-agent-assignments — agent: own assignments; admin: all (optional filters). */
router.get(
  '/',
  authMiddleware,
  [
    query('project_id').optional().isUUID(),
    query('agent_id').optional().isUUID(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      if (req.userRole === 'agent') {
        const { rows } = await pool.query(
          `SELECT a.*, p.name AS project_name
           FROM project_agent_assignments a
           INNER JOIN projects p ON p.id = a.project_id
           WHERE a.agent_id = $1
           ORDER BY a.updated_at DESC`,
          [req.userId]
        );
        return res.json(rows || []);
      }

      if (!ADMIN_CLASS.includes(req.userRole)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      let sql = `SELECT a.*, p.name AS project_name
                 FROM project_agent_assignments a
                 INNER JOIN projects p ON p.id = a.project_id
                 WHERE 1=1`;
      const params = [];
      if (req.query.project_id) {
        params.push(req.query.project_id);
        sql += ` AND a.project_id = $${params.length}`;
      }
      if (req.query.agent_id) {
        params.push(req.query.agent_id);
        sql += ` AND a.agent_id = $${params.length}`;
      }
      sql += ' ORDER BY a.updated_at DESC';
      const { rows } = await pool.query(sql, params);
      res.json(rows || []);
    } catch (err) {
      next(err);
    }
  }
);

/** POST /api/v1/project-agent-assignments — admin only: assign agent work on a project. */
router.post(
  '/',
  authMiddleware,
  requireOpsAdmin,
  [
    body('project_id').isUUID(),
    body('agent_id').isUUID(),
    body('kind').isIn(['service', 'material']),
    body('title').trim().notEmpty().isLength({ max: 255 }),
    body('description').optional({ nullable: true }).trim().isLength({ max: 8000 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { rows: agents } = await pool.query("SELECT id FROM users WHERE id = $1 AND role = 'agent'", [
        req.body.agent_id,
      ]);
      if (agents.length === 0) return res.status(400).json({ error: 'agent_id must be a user with role agent' });

      const { rows: projects } = await pool.query('SELECT id FROM projects WHERE id = $1', [req.body.project_id]);
      if (projects.length === 0) return res.status(404).json({ error: 'Project not found' });

      const id = uuidv4();
      await pool.query(
        `INSERT INTO project_agent_assignments (
          id, project_id, agent_id, assigned_by, kind, title, description, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'assigned')`,
        [
          id,
          req.body.project_id,
          req.body.agent_id,
          req.userId,
          req.body.kind,
          String(req.body.title).trim(),
          req.body.description != null ? String(req.body.description).trim() : null,
        ]
      );

      logAudit({
        userId: req.userId,
        action: 'project_agent_assignment_create',
        resourceType: 'project_agent_assignment',
        resourceId: id,
        details: JSON.stringify({ project_id: req.body.project_id, agent_id: req.body.agent_id }),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      const row = await loadRow(id);
      res.status(201).json(row);
    } catch (err) {
      next(err);
    }
  }
);

async function loadRow(id) {
  const { rows } = await pool.query(
    `SELECT a.*, p.name AS project_name
     FROM project_agent_assignments a
     INNER JOIN projects p ON p.id = a.project_id
     WHERE a.id = $1`,
    [id]
  );
  return rows[0] || null;
}

/** PATCH /api/v1/project-agent-assignments/:id — admin or assigned agent; body.action drives workflow. */
router.patch(
  '/:id',
  authMiddleware,
  [
    param('id').isUUID(),
    body('action').isString().trim().notEmpty(),
    body('note').optional({ nullable: true }).trim().isLength({ max: 8000 }),
    body('document_url').optional({ nullable: true }).trim().isLength({ max: 2000 }),
    body('completion_note').optional({ nullable: true }).trim().isLength({ max: 8000 }),
    body('completion_document_url').optional({ nullable: true }).trim().isLength({ max: 2000 }),
    body('receipt_document_url').optional({ nullable: true }).trim().isLength({ max: 2000 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const row = await loadRow(req.params.id);
      if (!row) return res.status(404).json({ error: 'Assignment not found' });

      const action = String(req.body.action || '').trim();
      const isAdmin = isOpsAdmin(req.userRole);
      const isAgent = req.userRole === 'agent' && row.agent_id === req.userId;

      if (!isAdmin && !isAgent) return res.status(403).json({ error: 'Forbidden' });

      const now = new Date().toISOString();

      if (isAdmin) {
        if (action === 'request_invoice') {
          if (row.status !== 'assigned') {
            return res.status(400).json({ error: 'Can only request invoice while assignment is assigned' });
          }
          await pool.query(
            `UPDATE project_agent_assignments SET
              status = 'invoice_required',
              invoice_request_note = $2,
              invoice_requested_at = $3,
              updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [row.id, req.body.note || null, now]
          );
        } else if (action === 'accept_invoice') {
          if (row.status !== 'invoice_submitted') {
            return res.status(400).json({ error: 'No invoice submission to accept' });
          }
          await pool.query(
            `UPDATE project_agent_assignments SET
              status = 'assigned',
              updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [row.id]
          );
        } else if (action === 'approve_completion') {
          if (row.status !== 'completion_submitted') {
            return res.status(400).json({ error: 'Completion must be submitted before approval' });
          }
          await pool.query(
            `UPDATE project_agent_assignments SET
              status = 'completion_approved',
              completion_approved_at = $2,
              completion_approved_by = $3,
              completion_rejection_note = NULL,
              updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [row.id, now, req.userId]
          );
        } else if (action === 'reject_completion') {
          if (row.status !== 'completion_submitted') {
            return res.status(400).json({ error: 'Can only reject when completion is submitted' });
          }
          await pool.query(
            `UPDATE project_agent_assignments SET
              status = 'assigned',
              completion_rejection_note = $2,
              completion_submitted_at = NULL,
              completion_note = NULL,
              completion_document_url = NULL,
              updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [row.id, req.body.note || null]
          );
        } else if (action === 'request_receipts') {
          if (row.status !== 'completion_approved') {
            return res.status(400).json({ error: 'Approve completion before requesting payment receipts' });
          }
          await pool.query(
            `UPDATE project_agent_assignments SET
              status = 'receipts_required',
              receipts_request_note = $2,
              receipts_requested_at = $3,
              updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [row.id, req.body.note || null, now]
          );
        } else if (action === 'close') {
          if (!['receipts_submitted', 'completion_approved'].includes(row.status)) {
            return res.status(400).json({ error: 'Close only after receipts submitted or when skipping receipts from completion-approved' });
          }
          await pool.query(
            `UPDATE project_agent_assignments SET
              status = 'closed',
              closed_at = $2,
              closed_by = $3,
              updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [row.id, now, req.userId]
          );
        } else if (action === 'cancel') {
          if (row.status === 'closed' || row.status === 'cancelled') {
            return res.status(400).json({ error: 'Already terminal' });
          }
          await pool.query(
            `UPDATE project_agent_assignments SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [row.id]
          );
        } else {
          return res.status(400).json({ error: 'Unknown admin action' });
        }

        logAudit({
          userId: req.userId,
          action: `project_agent_assignment_${action}`,
          resourceType: 'project_agent_assignment',
          resourceId: row.id,
          details: JSON.stringify({ action }),
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });

        return res.json(await loadRow(row.id));
      }

      // Agent actions
      if (action === 'submit_invoice') {
        if (row.status !== 'invoice_required') {
          return res.status(400).json({ error: 'Admin has not requested an invoice for this assignment' });
        }
        if (!req.body.document_url || !String(req.body.document_url).trim()) {
          return res.status(400).json({ error: 'document_url is required when submitting an invoice' });
        }
        await pool.query(
          `UPDATE project_agent_assignments SET
            status = 'invoice_submitted',
            invoice_document_url = $2,
            invoice_note = $3,
            invoice_submitted_at = $4,
            updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [row.id, String(req.body.document_url).trim(), req.body.note || null, now]
        );
      } else if (action === 'submit_completion') {
        if (row.status === 'invoice_required') {
          return res.status(400).json({ error: 'Submit the requested invoice before marking work complete' });
        }
        if (row.status !== 'assigned') {
          return res.status(400).json({ error: 'Can only submit completion while assignment is assigned' });
        }
        await pool.query(
          `UPDATE project_agent_assignments SET
            status = 'completion_submitted',
            completion_note = $2,
            completion_document_url = $3,
            completion_submitted_at = $4,
            completion_rejection_note = NULL,
            updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [
            row.id,
            req.body.completion_note || req.body.note || null,
            req.body.completion_document_url || req.body.document_url || null,
            now,
          ]
        );
      } else if (action === 'submit_receipts') {
        if (row.status !== 'receipts_required') {
          return res.status(400).json({ error: 'Admin has not requested payment receipts yet' });
        }
        if (!req.body.receipt_document_url && !req.body.document_url) {
          return res.status(400).json({ error: 'receipt_document_url (or document_url) is required' });
        }
        const url = String(req.body.receipt_document_url || req.body.document_url).trim();
        await pool.query(
          `UPDATE project_agent_assignments SET
            status = 'receipts_submitted',
            receipt_document_url = $2,
            receipts_submitted_at = $3,
            updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [row.id, url, now]
        );
      } else {
        return res.status(400).json({ error: 'Unknown agent action' });
      }

      logAudit({
        userId: req.userId,
        action: `project_agent_assignment_${action}`,
        resourceType: 'project_agent_assignment',
        resourceId: row.id,
        details: JSON.stringify({ action }),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json(await loadRow(row.id));
    } catch (err) {
      next(err);
    }
  }
);

export default router;
