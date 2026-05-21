import express from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/index.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';
import { createNotificationForUser } from '../lib/notifications.js';

const router = express.Router();

const TARGET_TYPES = ['message', 'property', 'vendor_listing', 'vendor_profile', 'user'];
const REPORT_STATUSES = ['open', 'acknowledged', 'resolved', 'dismissed'];

function isAdminClass(role) {
  return ['admin', 'super_admin', 'vendor_admin', 'finance_admin', 'moderator', 'editor'].includes(role);
}

const RISK_KEYWORDS = [
  /\bscam\b/i,
  /\bfraud\b/i,
  /\bimpersonat/i,
  /\bfake\b/i,
  /\badvance fee\b/i,
  /\bwire transfer\b/i,
  /\boff[- ]platform\b/i,
  /\bphishing\b/i,
  /\bthreat\b/i,
  /\bharass/i,
];

function riskLevelFromScore(score) {
  if (score >= 85) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 35) return 'medium';
  return 'low';
}

async function computeRiskSnapshot({ targetType, targetId, projectId, reason, details }) {
  let score = 20;
  const text = `${reason || ''} ${details || ''}`.trim();
  if (RISK_KEYWORDS.some((rx) => rx.test(text))) score += 20;

  const [sameTargetResult, sameProjectResult, recentCriticalResult] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) AS count
       FROM fraud_reports
       WHERE target_type = $1
         AND target_id = $2`,
      [targetType, targetId]
    ),
    projectId
      ? pool.query(
          `SELECT COUNT(*) AS count
           FROM fraud_reports
           WHERE project_id = $1`,
          [projectId]
        )
      : Promise.resolve({ rows: [{ count: '0' }] }),
    pool.query(
      `SELECT COUNT(*) AS count
       FROM fraud_reports
       WHERE status = 'open'
         AND (risk_level = 'high' OR risk_level = 'critical')`
    ),
  ]);

  const sameTargetCount = Number.parseInt(String(sameTargetResult.rows?.[0]?.count || '0'), 10) || 0;
  const sameProjectCount = Number.parseInt(String(sameProjectResult.rows?.[0]?.count || '0'), 10) || 0;
  const recentCriticalOpen = Number.parseInt(String(recentCriticalResult.rows?.[0]?.count || '0'), 10) || 0;

  score += Math.min(40, sameTargetCount * 10);
  score += Math.min(20, sameProjectCount * 5);
  score += Math.min(20, recentCriticalOpen >= 10 ? 20 : Math.floor(recentCriticalOpen / 2));
  if (targetType === 'message' && projectId) score += 5;

  const finalScore = Math.max(0, Math.min(100, score));
  return {
    risk_score: finalScore,
    risk_level: riskLevelFromScore(finalScore),
    sameTargetCount,
    sameProjectCount,
    recentCriticalOpen,
  };
}

async function notifyAdminsAboutReport(app, report, reason) {
  const { rows: admins } = await pool.query(
    `SELECT id FROM users WHERE role IN ('admin', 'super_admin', 'vendor_admin', 'finance_admin', 'moderator', 'editor')`
  );
  if (!admins.length) return;
  const io = app?.get?.('io');
  const title = `Fraud report (${String(report.risk_level || 'medium').toUpperCase()})`;
  const message = `${report.target_type} reported: ${String(reason || '').slice(0, 140)}`;
  const results = await Promise.all(
    admins.map(async (admin) => {
      const notificationId = await createNotificationForUser(
        admin.id,
        'fraud_report_opened',
        title,
        message
      );
      return { adminId: admin.id, notificationId };
    })
  );
  if (io) {
    results.forEach(({ adminId, notificationId }) => {
      io.to(`user:${adminId}`).emit('notification:new', {
        id: notificationId,
        type: 'fraud_report_opened',
        title,
        message,
      });
    });
  }
}

async function ensureTargetExistsAndAllowed(req, targetType, targetId, projectId) {
  if (targetType === 'message') {
    const { rows } = await pool.query(
      `SELECT m.id, m.project_id, m.sender_id, m.recipient_id, p.client_id
       FROM messages m
       LEFT JOIN projects p ON p.id = m.project_id
       WHERE m.id = $1`,
      [targetId]
    );
    if (!rows.length) return { error: 'Message not found', code: 404 };
    const row = rows[0];
    if (projectId && row.project_id && row.project_id !== projectId) {
      return { error: 'project_id does not match message project', code: 400 };
    }
    if (!isAdminClass(req.userRole)) {
      const isDirectParty = row.sender_id === req.userId || row.recipient_id === req.userId;
      const isProjectParty = row.client_id === req.userId;
      if (!isDirectParty && !isProjectParty) {
        return { error: "You don't have permission to report this message.", code: 403 };
      }
    }
    return { projectId: row.project_id || projectId || null };
  }

  if (targetType === 'property') {
    const { rows } = await pool.query('SELECT id FROM properties WHERE id = $1', [targetId]);
    if (!rows.length) return { error: 'Property not found', code: 404 };
    return { projectId: projectId || null };
  }

  if (targetType === 'vendor_listing') {
    const { rows } = await pool.query('SELECT id FROM vendor_listings WHERE id = $1', [targetId]);
    if (!rows.length) return { error: 'Vendor listing not found', code: 404 };
    return { projectId: projectId || null };
  }

  if (targetType === 'user' || targetType === 'vendor_profile') {
    const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [targetId]);
    if (!rows.length) return { error: 'User profile not found', code: 404 };
    return { projectId: projectId || null };
  }

  return { error: 'Unsupported target_type', code: 400 };
}

router.post(
  '/',
  authMiddleware,
  [
    body('target_type').isIn(TARGET_TYPES),
    body('target_id').isUUID(),
    body('project_id').optional().isUUID(),
    body('reason').trim().isLength({ min: 5, max: 500 }),
    body('details').optional().trim().isLength({ max: 2000 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const targetType = String(req.body.target_type || '').trim();
      const targetId = String(req.body.target_id || '').trim();
      const reason = String(req.body.reason || '').trim();
      const details = req.body.details ? String(req.body.details).trim() : null;
      const requestedProjectId = req.body.project_id ? String(req.body.project_id).trim() : null;

      const targetCheck = await ensureTargetExistsAndAllowed(req, targetType, targetId, requestedProjectId);
      if (targetCheck.error) return res.status(targetCheck.code || 400).json({ error: targetCheck.error });
      const risk = await computeRiskSnapshot({
        targetType,
        targetId,
        projectId: targetCheck.projectId || null,
        reason,
        details,
      });

      const id = uuidv4();
      await pool.query(
        `INSERT INTO fraud_reports (
          id, reporter_user_id, target_type, target_id, project_id, reason, details, risk_score, risk_level, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [id, req.userId, targetType, targetId, targetCheck.projectId || null, reason, details, risk.risk_score, risk.risk_level]
      );

      const { rows } = await pool.query(
        `SELECT fr.*, u.full_name AS reporter_name, u.email AS reporter_email
         FROM fraud_reports fr
         LEFT JOIN users u ON u.id = fr.reporter_user_id
         WHERE fr.id = $1`,
        [id]
      );
      logAudit({
        userId: req.userId,
        action: 'fraud_report_create',
        resourceType: 'fraud_report',
        resourceId: id,
        details: JSON.stringify({
          targetType,
          targetId,
          projectId: targetCheck.projectId || null,
          risk_score: risk.risk_score,
          risk_level: risk.risk_level,
          sameTargetCount: risk.sameTargetCount,
          sameProjectCount: risk.sameProjectCount,
        }),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      await notifyAdminsAboutReport(req.app, rows[0], reason);
      return res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/admin/queue',
  authMiddleware,
  requireAdmin,
  [
    query('status').optional().isIn(REPORT_STATUSES),
    query('sla_bucket').optional().isIn(['new', 'in_review', 'resolved']),
    query('limit').optional().isInt({ min: 1, max: 500 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const limitParsed = Number.parseInt(String(req.query.limit ?? ''), 10);
      const limit =
        Number.isFinite(limitParsed) && limitParsed >= 1 && limitParsed <= 500 ? limitParsed : 200;

      const slaBucketRaw = req.query.sla_bucket ? String(req.query.sla_bucket) : '';
      const slaBucket = ['new', 'in_review', 'resolved'].includes(slaBucketRaw) ? slaBucketRaw : '';

      const params = [];
      let where = '';
      if (slaBucket === 'resolved') {
        where = `WHERE fr.status IN ('resolved', 'dismissed')`;
      } else if (slaBucket === 'in_review') {
        params.push('acknowledged');
        where = `WHERE fr.status = $${params.length}`;
      } else if (slaBucket === 'new') {
        params.push('open');
        where = `WHERE fr.status = $${params.length}`;
      } else if (req.query.status) {
        const status = String(req.query.status);
        params.push(status);
        where = `WHERE fr.status = $${params.length}`;
      } else {
        params.push('open');
        where = `WHERE fr.status = $${params.length}`;
      }
      params.push(limit);

      const { rows } = await pool.query(
        `SELECT fr.*,
          reporter.full_name AS reporter_name,
          reporter.email AS reporter_email,
          assignee.full_name AS assigned_to_name,
          resolver.full_name AS resolved_by_name
         FROM fraud_reports fr
         LEFT JOIN users reporter ON reporter.id = fr.reporter_user_id
         LEFT JOIN users assignee ON assignee.id = fr.assigned_to
         LEFT JOIN users resolver ON resolver.id = fr.resolved_by
         ${where}
         ORDER BY fr.risk_score DESC, fr.created_at DESC
         LIMIT $${params.length}`,
        params
      );
      res.json(rows || []);
    } catch (err) {
      next(err);
    }
  }
);

router.get('/admin/sla-summary', authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT status, COUNT(*) AS count
       FROM fraud_reports
       GROUP BY status`,
      []
    );
    const byStatus = {};
    for (const r of rows || []) {
      const key = r.status;
      const n = Number.parseInt(String(r.count ?? 0), 10) || 0;
      byStatus[key] = n;
    }
    const openCount = byStatus.open || 0;
    const acknowledgedCount = byStatus.acknowledged || 0;
    const resolvedCount = byStatus.resolved || 0;
    const dismissedCount = byStatus.dismissed || 0;
    res.json({
      by_status: byStatus,
      sla: {
        new: openCount,
        in_review: acknowledgedCount,
        resolved: resolvedCount + dismissedCount,
      },
      dismissed: dismissedCount,
      resolved_only: resolvedCount,
    });
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/admin/:id',
  authMiddleware,
  requireAdmin,
  [
    param('id').isUUID(),
    body('status').isIn(REPORT_STATUSES),
    body('admin_note').optional().trim().isLength({ max: 2000 }),
    body('assigned_to').optional({ nullable: true }).isUUID(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const id = req.params.id;
      const status = String(req.body.status);
      const adminNote = req.body.admin_note ? String(req.body.admin_note).trim() : null;
      const assignedTo = req.body.assigned_to || null;

      const { rows: existing } = await pool.query('SELECT id FROM fraud_reports WHERE id = $1', [id]);
      if (!existing.length) return res.status(404).json({ error: 'Fraud report not found' });

      const resolvedAt = status === 'resolved' || status === 'dismissed' ? new Date().toISOString() : null;
      const resolvedBy = status === 'resolved' || status === 'dismissed' ? req.userId : null;

      await pool.query(
        `UPDATE fraud_reports
         SET status = $2,
             admin_note = COALESCE($3, admin_note),
             assigned_to = COALESCE($4, assigned_to),
             resolved_at = $5,
             resolved_by = $6,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id, status, adminNote, assignedTo, resolvedAt, resolvedBy]
      );

      const { rows } = await pool.query(
        `SELECT fr.*,
          reporter.full_name AS reporter_name,
          reporter.email AS reporter_email,
          assignee.full_name AS assigned_to_name,
          resolver.full_name AS resolved_by_name
         FROM fraud_reports fr
         LEFT JOIN users reporter ON reporter.id = fr.reporter_user_id
         LEFT JOIN users assignee ON assignee.id = fr.assigned_to
         LEFT JOIN users resolver ON resolver.id = fr.resolved_by
         WHERE fr.id = $1`,
        [id]
      );

      logAudit({
        userId: req.userId,
        action: 'fraud_report_update',
        resourceType: 'fraud_report',
        resourceId: id,
        details: JSON.stringify({ status, assignedTo: assignedTo || null }),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
