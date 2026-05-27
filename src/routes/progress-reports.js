import express from 'express';
import pool from '../db/index.js';
import { sqlConflictDoUpdate } from '../lib/upsert-sql.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { body, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import { bodyProjectId, queryProjectId } from '../lib/route-ids.js';
import { generateReportForPeriod } from '../lib/progress-report.js';
import { sendMail } from '../lib/email.js';

const router = express.Router();

function canAccessProject(role, userId, project) {
  if (!project) return false;
  if (role === 'admin' || role === 'super_admin') return true;
  if (role === 'client' && project.client_id === userId) return true;
  return false;
}

/** GET /api/v1/progress-reports/preferences - my report preferences (per project) */
router.get('/preferences', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM project_report_preferences WHERE user_id = $1',
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/** PUT /api/v1/progress-reports/preferences - set send_weekly_email for a project */
router.put('/preferences', authMiddleware, [
  bodyProjectId(),
  body('send_weekly_email').optional().isBoolean(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { project_id, send_weekly_email } = req.body;
    const { rows: proj } = await pool.query('SELECT id, client_id FROM projects WHERE id = $1', [project_id]);
    if (proj.length === 0) return res.status(404).json({ error: 'Project not found' });
    if (!canAccessProject(req.userRole, req.userId, proj[0])) return res.status(403).json({ error: "You don't have permission to access this." });

    const prefUpsert = sqlConflictDoUpdate('(project_id, user_id)', 'send_weekly_email = excluded.send_weekly_email');
    await pool.query(
      `INSERT INTO project_report_preferences (project_id, user_id, send_weekly_email) VALUES ($1, $2, $3)
       ${prefUpsert}`,
      [project_id, req.userId, send_weekly_email !== false ? 1 : 0]
    );
    const { rows } = await pool.query(
      'SELECT * FROM project_report_preferences WHERE project_id = $1 AND user_id = $2',
      [project_id, req.userId]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/progress-reports/generate - generate and save a report (admin or system) */
router.post('/generate', authMiddleware, requireAdmin, [
  bodyProjectId(),
  body('period_start').matches(/^\d{4}-\d{2}-\d{2}$/),
  body('period_end').matches(/^\d{4}-\d{2}-\d{2}$/),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { project_id, period_start, period_end } = req.body;
    const { rows: proj } = await pool.query('SELECT id FROM projects WHERE id = $1', [project_id]);
    if (proj.length === 0) return res.status(404).json({ error: 'Project not found' });

    const data = await generateReportForPeriod(project_id, period_start, period_end);
    if (!data) return res.status(404).json({ error: 'Project not found' });

    const id = uuidv4();
    await pool.query(
      `INSERT INTO project_progress_reports (id, project_id, period_start, period_end, summary_text, milestones_completed, new_photos_count, financial_summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        project_id,
        period_start,
        period_end,
        data.summary_text,
        JSON.stringify(data.milestones_completed),
        data.new_photos_count,
        JSON.stringify(data.financial_summary),
      ]
    );
    const activityId = uuidv4();
    await pool.query(
      `INSERT INTO project_activity (id, project_id, activity_type, reference_id, actor_id, details)
       VALUES ($1, $2, 'progress_report', $3, $4, $5)`,
      [activityId, project_id, id, req.userId, JSON.stringify({ period_start, period_end })]
    );
    const { rows } = await pool.query('SELECT * FROM project_progress_reports WHERE id = $1', [id]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/progress-reports?project_id= - list reports for project */
router.get('/', authMiddleware, queryProjectId(), async (req, res, next) => {
  try {
    const val = validationResult(req);
    if (!val.isEmpty()) return res.status(400).json({ errors: val.array() });
    const { project_id } = req.query;
    const { rows: proj } = await pool.query('SELECT id, client_id FROM projects WHERE id = $1', [project_id]);
    if (proj.length === 0) return res.status(404).json({ error: 'Project not found' });
    if (!canAccessProject(req.userRole, req.userId, proj[0])) return res.status(403).json({ error: "You don't have permission to access this." });

    const { rows } = await pool.query(
      'SELECT * FROM project_progress_reports WHERE project_id = $1 ORDER BY period_end DESC, created_at DESC LIMIT 52',
      [project_id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/progress-reports/:id - get one report */
router.get('/:id', authMiddleware, async (req, res, next) => {
  try {
    if (req.params.id === 'generate' || req.params.id === 'preferences') return next();
    const { rows: report } = await pool.query(
      'SELECT r.*, p.name AS project_name, p.client_id FROM project_progress_reports r JOIN projects p ON r.project_id = p.id WHERE r.id = $1',
      [req.params.id]
    );
    if (report.length === 0) return res.status(404).json({ error: 'Report not found' });
    if (!canAccessProject(req.userRole, req.userId, report[0])) return res.status(403).json({ error: "You don't have permission to access this." });
    const r = report[0];
    if (r.milestones_completed && typeof r.milestones_completed === 'string') {
      try { r.milestones_completed = JSON.parse(r.milestones_completed); } catch (_) {}
    }
    if (r.financial_summary && typeof r.financial_summary === 'string') {
      try { r.financial_summary = JSON.parse(r.financial_summary); } catch (_) {}
    }
    res.json(r);
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/progress-reports/:id/send-email - send report to project client and opted-in users */
router.post('/:id/send-email', authMiddleware, async (req, res, next) => {
  try {
    const { rows: report } = await pool.query(
      'SELECT r.*, p.name AS project_name, p.client_id FROM project_progress_reports r JOIN projects p ON r.project_id = p.id WHERE r.id = $1',
      [req.params.id]
    );
    if (report.length === 0) return res.status(404).json({ error: 'Report not found' });
    if (!canAccessProject(req.userRole, req.userId, report[0])) return res.status(403).json({ error: "You don't have permission to access this." });
    const r = report[0];

    const { rows: users } = await pool.query(
      `SELECT u.id, u.email, u.full_name FROM users u
       WHERE u.id = $1 OR (u.id IN (SELECT user_id FROM project_report_preferences WHERE project_id = $2 AND send_weekly_email = 1))`,
      [r.client_id, r.project_id]
    );
    const emails = [...new Set((users || []).map((u) => u.email).filter(Boolean))];
    const summary = typeof r.summary_text === 'string' ? r.summary_text : '';
    const subject = `Progress report: ${r.project_name} (${r.period_start} to ${r.period_end})`;
    const text = summary;
    const html = `<h2>Progress Report</h2><p><strong>${r.project_name}</strong> — ${r.period_start} to ${r.period_end}</p><p>${summary.replace(/\n/g, '<br>')}</p>`;

    let sent = 0;
    for (const to of emails) {
      const result = await sendMail({ to, subject, text, html });
      if (result.sent) sent++;
    }

    if (sent > 0) {
      await pool.query(
        'UPDATE project_progress_reports SET email_sent_at = CURRENT_TIMESTAMP WHERE id = $1',
        [req.params.id]
      );
    }
    res.json({ sent, total: emails.length });
  } catch (err) {
    next(err);
  }
});

export default router;
