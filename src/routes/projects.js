import express from 'express';
import pool from '../db/index.js';
import { createNotificationForUser } from '../lib/notifications.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { body, validationResult, query } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../lib/audit.js';
import { getProjectTransparency } from '../lib/dashboard-metrics.js';
import { getProjectTimeline } from '../lib/timeline.js';
import { validateFeedUrl, isExternalTabOnlyFeedUrl } from '../lib/feed-url.js';
import { sanitizeProjectListForClient } from '../lib/project-sanitize.js';
import { isCustomerRole } from '../lib/roles.js';

const router = express.Router();

/** Deduplicate project list by (client_id, name), keeping the row with latest updated_at then id. */
function dedupeProjectsByName(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.client_id ?? ''}\0${(row.name ?? '').trim()}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    const rowUpdated = row.updated_at ? new Date(row.updated_at).getTime() : 0;
    const existingUpdated = existing.updated_at ? new Date(existing.updated_at).getTime() : 0;
    if (rowUpdated > existingUpdated || (rowUpdated === existingUpdated && (row.id || '') > (existing.id || ''))) {
      byKey.set(key, row);
    }
  }
  return Array.from(byKey.values());
}

function isKnownNonEmbeddableHost(url) {
  return isExternalTabOnlyFeedUrl(url);
}

/** GET /api/v1/projects - list projects (client: own only, admin: all). Deduplicated by client+name so the same project does not appear twice. */
router.get('/', authMiddleware, query('status').optional(), async (req, res, next) => {
  try {
    if (req.userRole === 'admin' || req.userRole === 'super_admin') {
      const status = req.query.status;
      const clientId = req.query.client_id;
      let sql = `
        SELECT p.*, u.full_name AS client_name, u.email AS client_email
        FROM projects p
        LEFT JOIN users u ON p.client_id = u.id
        WHERE 1=1
      `;
      const params = [];
      if (status) { params.push(status); sql += ` AND p.status = $${params.length}`; }
      if (clientId) { params.push(clientId); sql += ` AND p.client_id = $${params.length}`; }
      sql += ' ORDER BY p.updated_at DESC';
      const { rows } = await pool.query(sql, params);
      return res.json(dedupeProjectsByName(rows));
    }
    if (req.userRole === 'vendor' || req.userRole === 'agent') {
      return res.status(403).json({ error: 'Projects are not available for this account type.' });
    }
    const { rows } = await pool.query(
      'SELECT * FROM projects WHERE client_id = $1 ORDER BY updated_at DESC',
      [req.userId]
    );
    res.json(sanitizeProjectListForClient(dedupeProjectsByName(rows), req.userRole));
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/projects/:id/escrow - get escrow for project (client: own project only) */
router.get('/:id/escrow', authMiddleware, async (req, res, next) => {
  try {
    const { rows: projects } = await pool.query('SELECT id, client_id, vendor_id, vendor_org_id FROM projects WHERE id = $1', [req.params.id]);
    if (projects.length === 0) return res.status(404).json({ error: 'Project not found' });
    const p = projects[0];
    if (isCustomerRole(req.userRole) && p.client_id !== req.userId) return res.status(403).json({ error: "You don't have permission to do that." });
    if (req.userRole === 'vendor' || req.userRole === 'agent') return res.status(403).json({ error: 'Projects are not available for this account type.' });
    const { rows } = await pool.query('SELECT * FROM project_escrow WHERE project_id = $1', [req.params.id]);
    res.json(rows[0] || null);
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/projects/:id/mortgage - get mortgage for project (client: own project only) */
router.get('/:id/mortgage', authMiddleware, async (req, res, next) => {
  try {
    const { rows: projects } = await pool.query('SELECT id, client_id, vendor_id, vendor_org_id FROM projects WHERE id = $1', [req.params.id]);
    if (projects.length === 0) return res.status(404).json({ error: 'Project not found' });
    const p = projects[0];
    if (isCustomerRole(req.userRole) && p.client_id !== req.userId) return res.status(403).json({ error: "You don't have permission to do that." });
    if (req.userRole === 'vendor' || req.userRole === 'agent') return res.status(403).json({ error: 'Projects are not available for this account type.' });
    const { rows } = await pool.query('SELECT * FROM project_mortgage WHERE project_id = $1', [req.params.id]);
    res.json(rows[0] || null);
  } catch (err) {
    next(err);
  }
});

/** PUT /api/v1/projects/:id/mortgage - create or update mortgage (admin only) */
router.put('/:id/mortgage', authMiddleware, requireAdmin, [
  body('lender_name').optional().trim(),
  body('amount').optional().isFloat({ min: 0 }),
  body('interest_rate').optional().isFloat({ min: 0, max: 100 }),
  body('term_months').optional().isInt({ min: 1 }),
  body('status').optional().isIn(['inquiry', 'applied', 'approved', 'active', 'paid_off', 'rejected']),
  body('notes').optional().trim(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { rows: projects } = await pool.query('SELECT id FROM projects WHERE id = $1', [req.params.id]);
    if (projects.length === 0) return res.status(404).json({ error: 'Project not found' });
    const { lender_name, amount, interest_rate, term_months, status, notes } = req.body;
    const { rows: existing } = await pool.query('SELECT id FROM project_mortgage WHERE project_id = $1', [req.params.id]);
    if (existing.length > 0) {
      const updates = [];
      const values = [];
      let i = 1;
      if (lender_name !== undefined) { updates.push(`lender_name = $${i++}`); values.push(lender_name || null); }
      if (amount !== undefined) { updates.push(`amount = $${i++}`); values.push(amount ?? null); }
      if (interest_rate !== undefined) { updates.push(`interest_rate = $${i++}`); values.push(interest_rate ?? null); }
      if (term_months !== undefined) { updates.push(`term_months = $${i++}`); values.push(term_months ?? null); }
      if (status !== undefined) { updates.push(`status = $${i++}`); values.push(status || 'inquiry'); }
      if (notes !== undefined) { updates.push(`notes = $${i++}`); values.push(notes || null); }
      if (updates.length > 0) {
        values.push(req.params.id);
        await pool.query(
          `UPDATE project_mortgage SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE project_id = $${i}`,
          values
        );
      }
    } else {
      const id = uuidv4();
      await pool.query(
        `INSERT INTO project_mortgage (id, project_id, lender_name, amount, interest_rate, term_months, status, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, req.params.id, lender_name || null, amount ?? null, interest_rate ?? null, term_months ?? null, status || 'inquiry', notes || null]
      );
    }
    const { rows } = await pool.query('SELECT * FROM project_mortgage WHERE project_id = $1', [req.params.id]);
    logAudit({
      userId: req.userId,
      action: 'mortgage_update',
      resourceType: 'project_mortgage',
      resourceId: req.params.id,
      details: JSON.stringify({ lender_name, status }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json(rows[0] || null);
  } catch (err) {
    next(err);
  }
});

/** PUT /api/v1/projects/:id/escrow - set or update escrow contract (admin only) */
router.put('/:id/escrow', authMiddleware, requireAdmin, [
  body('chain').trim().notEmpty(),
  body('contract_address').trim().notEmpty(),
  body('amount').optional().isFloat({ min: 0 }),
  body('currency').optional().trim(),
  body('status').optional().isIn(['active', 'released', 'disputed']),
  body('explorer_url').optional().trim(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { rows: projects } = await pool.query('SELECT id FROM projects WHERE id = $1', [req.params.id]);
    if (projects.length === 0) return res.status(404).json({ error: 'Project not found' });
    const { chain, contract_address, amount, currency, status, explorer_url } = req.body;
    const { rows: existing } = await pool.query('SELECT id FROM project_escrow WHERE project_id = $1', [req.params.id]);
    if (existing.length > 0) {
      await pool.query(
        `UPDATE project_escrow SET chain = $1, contract_address = $2, amount = $3, currency = $4, status = $5, explorer_url = $6, updated_at = CURRENT_TIMESTAMP WHERE project_id = $7`,
        [chain, contract_address, amount ?? null, currency || 'USD', status || 'active', explorer_url || null, req.params.id]
      );
    } else {
      const id = uuidv4();
      await pool.query(
        `INSERT INTO project_escrow (id, project_id, chain, contract_address, amount, currency, status, explorer_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, req.params.id, chain, contract_address, amount ?? null, currency || 'USD', status || 'active', explorer_url || null]
      );
    }
    const { rows } = await pool.query('SELECT * FROM project_escrow WHERE project_id = $1', [req.params.id]);
    logAudit({
      userId: req.userId,
      action: 'escrow_update',
      resourceType: 'project_escrow',
      resourceId: req.params.id,
      details: JSON.stringify({ chain, contract_address }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json(rows[0] || null);
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/projects/:id/transparency - project transparency score (client, admin, vendor for own project) */
router.get('/:id/transparency', authMiddleware, async (req, res, next) => {
  try {
    const { rows: projects } = await pool.query('SELECT id, client_id, vendor_id, vendor_org_id FROM projects WHERE id = $1', [req.params.id]);
    if (projects.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projects[0];
    if (isCustomerRole(req.userRole) && project.client_id !== req.userId) {
      return res.status(403).json({ error: "You don't have permission to view this project." });
    }
    if (req.userRole === 'vendor' || req.userRole === 'agent') {
      return res.status(403).json({ error: 'Projects are not available for this account type.' });
    }
    const transparency = await getProjectTransparency(pool, req.params.id);
    if (!transparency) return res.status(404).json({ error: 'Project not found' });
    res.json(transparency);
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/projects/:id/timeline - chronological project updates (Verified Construction Transparency) */
router.get('/:id/timeline', authMiddleware, async (req, res, next) => {
  try {
    const { rows: projects } = await pool.query('SELECT id, client_id, vendor_id, vendor_org_id FROM projects WHERE id = $1', [req.params.id]);
    if (projects.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projects[0];
    if (isCustomerRole(req.userRole) && project.client_id !== req.userId) {
      return res.status(403).json({ error: "You don't have permission to view this project." });
    }
    if (req.userRole === 'vendor' || req.userRole === 'agent') {
      return res.status(403).json({ error: 'Projects are not available for this account type.' });
    }
    const timeline = await getProjectTimeline(pool, req.params.id);
    res.json(timeline);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/v1/projects/:id/updates/:activityId/verify - mark an update as verified (admin only) */
router.patch('/:id/updates/:activityId/verify', authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    const { id: projectId, activityId } = req.params;
    const { rows: proj } = await pool.query('SELECT id FROM projects WHERE id = $1', [projectId]);
    if (proj.length === 0) return res.status(404).json({ error: 'Project not found' });
    const { rows: act } = await pool.query(
      'SELECT id, project_id FROM project_activity WHERE id = $1 AND project_id = $2',
      [activityId, projectId]
    );
    if (act.length === 0) return res.status(404).json({ error: 'Update not found' });
    await pool.query(
      'UPDATE project_activity SET verified_at = CURRENT_TIMESTAMP, verified_by = $1 WHERE id = $2',
      [req.userId, activityId]
    );
    const { rows } = await pool.query(
      'SELECT id, project_id, activity_type, reference_id, actor_id, created_at, verified_at, verified_by FROM project_activity WHERE id = $1',
      [activityId]
    );
    res.json(rows[0] || null);
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/projects/:id - get one project with milestones */
router.get('/:id', authMiddleware, async (req, res, next) => {
  try {
    const { rows: projects } = await pool.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
    if (projects.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projects[0];
    if (isCustomerRole(req.userRole) && project.client_id !== req.userId) {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }
    if (req.userRole === 'vendor' || req.userRole === 'agent') {
      return res.status(403).json({ error: 'Projects are not available for this account type.' });
    }
    const { rows: milestones } = await pool.query(
      'SELECT * FROM milestones WHERE project_id = $1 ORDER BY order_index, created_at',
      [req.params.id]
    );
    project.milestones = milestones;
    const canView = !!project.client_can_view_live_stream;
    if (isCustomerRole(req.userRole)) {
      project.can_view_live_stream = canView;
      if (!canView) {
        project.live_stream_url = null;
        project.ivs_playback_url = null;
      }
    } else {
      project.can_view_live_stream = true;
    }
    if (req.userRole === 'admin' || req.userRole === 'super_admin') {
      const { rows: clientRow } = await pool.query(
        'SELECT id, full_name, email, phone, country FROM users WHERE id = $1',
        [project.client_id]
      );
      project.client = clientRow[0] || null;
    }
    res.json(project);
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/projects/:id/live-stream - authorized live stream info for this project */
router.get('/:id/live-stream', authMiddleware, async (req, res, next) => {
  try {
    const { rows: projects } = await pool.query(
      'SELECT id, client_id, vendor_id, vendor_org_id, client_can_view_live_stream, live_stream_url, ivs_playback_url FROM projects WHERE id = $1',
      [req.params.id]
    );
    if (projects.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projects[0];

    if (isCustomerRole(req.userRole) && project.client_id !== req.userId) {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }
    if (req.userRole === 'vendor' || req.userRole === 'agent') {
      return res.status(403).json({ error: 'Projects are not available for this account type.' });
    }

    const canView = isCustomerRole(req.userRole) ? !!project.client_can_view_live_stream : true;
    if (!canView) return res.status(403).json({ error: 'Live stream access has not been granted yet.' });

    const url = project.ivs_playback_url || project.live_stream_url;
    if (!url) return res.status(404).json({ error: 'Live stream is not set up for this project yet.' });

    const streamType = url.includes('.m3u8') || url.includes('m3u8') ? 'hls' : 'embed';
    const nonEmbeddable = isKnownNonEmbeddableHost(url);

    res.json({
      project_id: project.id,
      url,
      stream_type: streamType,
      embeddable: !nonEmbeddable,
      open_in_new_tab_recommended: nonEmbeddable,
      can_view_live_stream: canView,
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/projects - create project (admin only) */
router.post('/', authMiddleware, requireAdmin, [
  body('client_id').isUUID(),
  body('name').trim().notEmpty(),
  body('location').optional().trim(),
  body('package_type').optional().trim(),
  body('total_cost').optional().isFloat({ min: 0 }),
  body('start_date').optional().isISO8601(),
  body('estimated_completion').optional().isISO8601(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const id = uuidv4();
    const {
      client_id, name, location, package_type, total_cost,
      start_date, estimated_completion,
    } = req.body;
    await pool.query(
      `INSERT INTO projects (id, client_id, name, location, package_type, total_cost, status, start_date, estimated_completion)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)`,
      [id, client_id, name, location || null, package_type || null, total_cost || null, start_date || null, estimated_completion || null]
    );
    logAudit({
      userId: req.userId,
      action: 'project_create',
      resourceType: 'project',
      resourceId: id,
      details: JSON.stringify({ name, client_id }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    await createNotificationForUser(client_id, 'project_created', 'Project created', `Your project "${name}" has been assigned to you.`);
    const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/v1/projects/:id - update project (admin) */
router.patch('/:id', authMiddleware, requireAdmin, [
  body('name').optional().trim().notEmpty(),
  body('location').optional().trim(),
  body('package_type').optional().trim(),
  body('total_cost').optional().isFloat({ min: 0 }),
  body('progress_percent').optional().isInt({ min: 0, max: 100 }),
  body('amount_paid').optional().isFloat({ min: 0 }),
  body('status').optional().isIn(['pending', 'active', 'completed', 'on_hold']),
  body('start_date').optional().isISO8601(),
  body('estimated_completion').optional().isISO8601(),
  body('live_stream_url').optional().trim(),
  body('client_can_view_live_stream').optional().isBoolean(),
  body('ivs_stream_key').optional().trim(),
  body('ivs_ingest_url').optional().trim(),
  body('ivs_playback_url').optional().trim(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const allowed = ['name', 'location', 'package_type', 'total_cost', 'progress_percent', 'amount_paid', 'status', 'start_date', 'estimated_completion', 'live_stream_url', 'client_can_view_live_stream', 'ivs_stream_key', 'ivs_ingest_url', 'ivs_playback_url'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (updates.live_stream_url !== undefined && updates.live_stream_url) {
      const msg = validateFeedUrl(updates.live_stream_url);
      if (msg) return res.status(400).json({ error: msg });
    }
    if (updates.ivs_playback_url !== undefined && updates.ivs_playback_url) {
      const msg = validateFeedUrl(updates.ivs_playback_url);
      if (msg) return res.status(400).json({ error: msg });
    }
    if (updates.client_can_view_live_stream !== undefined) {
      updates.client_can_view_live_stream = updates.client_can_view_live_stream ? 1 : 0;
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No fields to update' });
    const setClause = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = Object.values(updates);
    const updateResult = await pool.query(
      `UPDATE projects SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [req.params.id, ...values]
    );
    if (!updateResult.rowCount || updateResult.rowCount === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }
    logAudit({
      userId: req.userId,
      action: 'project_update',
      resourceType: 'project',
      resourceId: req.params.id,
      details: JSON.stringify(updates),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
    res.json(rows[0] || {});
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/projects/:id/milestones - add milestone (admin) */
router.post('/:id/milestones', authMiddleware, requireAdmin, [
  body('name').trim().notEmpty(),
  body('description').optional().trim(),
  body('amount').optional().isFloat({ min: 0 }),
  body('order_index').optional().isInt({ min: 0 }),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { name, description, amount, order_index } = req.body;
    const mid = uuidv4();
    await pool.query(
      `INSERT INTO milestones (id, project_id, name, description, amount, order_index) VALUES ($1, $2, $3, $4, $5, $6)`,
      [mid, req.params.id, name, description || null, amount || null, order_index ?? 0]
    );
    logAudit({
      userId: req.userId,
      action: 'milestone_create',
      resourceType: 'milestone',
      resourceId: mid,
      details: JSON.stringify({ project_id: req.params.id, name }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    const { rows } = await pool.query('SELECT * FROM milestones WHERE id = $1', [mid]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/projects/:id/progress-notes - list progress notes (admin: all, client: visible only) */
router.get('/:id/progress-notes', authMiddleware, async (req, res, next) => {
  try {
    const { rows: projects } = await pool.query('SELECT id, client_id, vendor_id, vendor_org_id FROM projects WHERE id = $1', [req.params.id]);
    if (projects.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projects[0];
    if (isCustomerRole(req.userRole) && project.client_id !== req.userId) return res.status(403).json({ error: "You don't have permission to do that." });
    if (req.userRole === 'vendor' || req.userRole === 'agent') return res.status(403).json({ error: 'Projects are not available for this account type.' });
    let sql = 'SELECT * FROM project_progress_notes WHERE project_id = $1 ORDER BY created_at DESC';
    const params = [req.params.id];
    if (isCustomerRole(req.userRole)) {
      sql = 'SELECT * FROM project_progress_notes WHERE project_id = $1 AND visible_to_client = 1 ORDER BY created_at DESC';
    }
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/v1/projects/:id/vendor-assignment - assign vendor organization and primary vendor user (admin only) */
router.patch('/:id/vendor-assignment', authMiddleware, requireAdmin, [
  body('vendor_org_id').optional({ nullable: true }).isUUID(),
  body('vendor_id').optional({ nullable: true }).isUUID(),
  body('reason').optional().trim(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { vendor_org_id = null, vendor_id = null, reason = null } = req.body;

    const { rows: existingProjectRows } = await pool.query(
      'SELECT id FROM projects WHERE id = $1',
      [req.params.id]
    );
    if (existingProjectRows.length === 0) return res.status(404).json({ error: 'Project not found' });

    if (vendor_org_id) {
      const { rows: orgRows } = await pool.query(
        'SELECT id FROM vendor_organizations WHERE id = $1',
        [vendor_org_id]
      );
      if (orgRows.length === 0) return res.status(400).json({ error: 'Vendor organization not found' });
    }

    if (vendor_id) {
      const { rows: vendorRows } = await pool.query(
        "SELECT id FROM users WHERE id = $1 AND role = 'vendor'",
        [vendor_id]
      );
      if (vendorRows.length === 0) return res.status(400).json({ error: 'Assigned vendor user must have vendor role' });
    }

    if (vendor_org_id && vendor_id) {
      await pool.query(
        `INSERT INTO vendor_memberships (id, vendor_org_id, user_id, org_role, is_primary_contact)
         VALUES ($1, $2, $3, 'member', 1)
         ON CONFLICT (vendor_org_id, user_id) DO UPDATE SET
           is_primary_contact = EXCLUDED.is_primary_contact,
           updated_at = CURRENT_TIMESTAMP`,
        [uuidv4(), vendor_org_id, vendor_id]
      );

      await pool.query(
        `UPDATE vendor_memberships
         SET is_primary_contact = 0, updated_at = CURRENT_TIMESTAMP
         WHERE vendor_org_id = $1 AND user_id <> $2`,
        [vendor_org_id, vendor_id]
      );

      await pool.query(
        'UPDATE users SET vendor_org_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [vendor_org_id, vendor_id]
      );
    }

    await pool.query(
      'UPDATE projects SET vendor_org_id = $1, vendor_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [vendor_org_id, vendor_id, req.params.id]
    );

    logAudit({
      userId: req.userId,
      action: 'project_vendor_assignment_update',
      resourceType: 'project',
      resourceId: req.params.id,
      details: JSON.stringify({ vendor_org_id, vendor_id, reason }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
    res.json(rows[0] || {});
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/projects/:id/progress-notes - add progress note (admin only) */
router.post('/:id/progress-notes', authMiddleware, requireAdmin, [
  body('note').trim().notEmpty(),
  body('visible_to_client').optional().isBoolean(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { rows: projects } = await pool.query('SELECT id FROM projects WHERE id = $1', [req.params.id]);
    if (projects.length === 0) return res.status(404).json({ error: 'Project not found' });
    const id = uuidv4();
    const visible = req.body.visible_to_client !== false;
    await pool.query(
      'INSERT INTO project_progress_notes (id, project_id, note, visible_to_client, created_by) VALUES ($1, $2, $3, $4, $5)',
      [id, req.params.id, req.body.note.trim(), visible ? 1 : 0, req.userId]
    );
    logAudit({
      userId: req.userId,
      action: 'progress_note_create',
      resourceType: 'project_progress_note',
      resourceId: id,
      details: JSON.stringify({ project_id: req.params.id, visible_to_client: visible }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    const { rows } = await pool.query('SELECT * FROM project_progress_notes WHERE id = $1', [id]);
    const io = req.app.get('io');
    const { rows: proj } = await pool.query('SELECT client_id FROM projects WHERE id = $1', [req.params.id]);
    if (io && proj[0]?.client_id) {
      io.to(`user:${proj[0].client_id}`).emit('project:update', { project_id: req.params.id, type: 'progress_note' });
    }
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/v1/projects/:projectId/progress-notes/:noteId - toggle visibility (admin only) */
router.patch('/:projectId/progress-notes/:noteId', authMiddleware, requireAdmin, [
  body('visible_to_client').isBoolean(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { projectId, noteId } = req.params;
    const { rowCount } = await pool.query(
      'UPDATE project_progress_notes SET visible_to_client = $1 WHERE id = $2 AND project_id = $3',
      [req.body.visible_to_client ? 1 : 0, noteId, projectId]
    );
    if (!rowCount || rowCount === 0) return res.status(404).json({ error: 'Note not found' });
    const { rows: updated } = await pool.query('SELECT * FROM project_progress_notes WHERE id = $1', [noteId]);
    const io = req.app.get('io');
    const { rows: proj } = await pool.query('SELECT client_id FROM projects WHERE id = $1', [projectId]);
    if (io && proj[0]?.client_id) {
      io.to(`user:${proj[0].client_id}`).emit('project:update', { project_id: projectId, type: 'progress_note' });
    }
    res.json(updated[0] || {});
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/v1/projects/:projectId/milestones/:milestoneId - update milestone (admin) */
router.patch('/:projectId/milestones/:milestoneId', authMiddleware, requireAdmin, [
  body('progress_percent').optional().isInt({ min: 0, max: 100 }),
  body('is_paid').optional().isBoolean(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const updates = {};
    if (req.body.progress_percent !== undefined) updates.progress_percent = req.body.progress_percent;
    if (req.body.is_paid !== undefined) updates.is_paid = req.body.is_paid;
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No fields to update' });
    const setClause = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
    await pool.query(
      `UPDATE milestones SET ${setClause} WHERE id = $1 AND project_id = $2`,
      [req.params.milestoneId, req.params.projectId, ...Object.values(updates)]
    );
    const { rows: milestones } = await pool.query('SELECT progress_percent FROM milestones WHERE project_id = $1', [req.params.projectId]);
    const avgProgress = milestones.length
      ? Math.round(milestones.reduce((s, m) => s + (m.progress_percent || 0), 0) / milestones.length)
      : 0;
    await pool.query('UPDATE projects SET progress_percent = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [avgProgress, req.params.projectId]);
    logAudit({
      userId: req.userId,
      action: 'milestone_update',
      resourceType: 'milestone',
      resourceId: req.params.milestoneId,
      details: JSON.stringify(updates),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    const { rows } = await pool.query('SELECT * FROM milestones WHERE id = $1', [req.params.milestoneId]);
    const io = req.app.get('io');
    const { rows: proj } = await pool.query('SELECT client_id FROM projects WHERE id = $1', [req.params.projectId]);
    if (io && proj[0]?.client_id) {
      io.to(`user:${proj[0].client_id}`).emit('project:update', { project_id: req.params.projectId, type: 'milestone' });
    }
    res.json(rows[0] || {});
  } catch (err) {
    next(err);
  }
});

export default router;
