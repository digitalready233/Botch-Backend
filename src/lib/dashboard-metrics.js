/**
 * Dashboard metrics: project risk, field agents on client projects, transparency score.
 * Supports Transparency, Trust, Visual progress, Automation, Speed (PropTech diaspora).
 */

/**
 * Compute project transparency score (0-100) for Verified Construction Transparency:
 * - update_frequency: recent progress reports / project updates
 * - milestone_progress: % milestones completed
 * - verified_updates: ratio of verified to verifiable (media + progress_report) activities
 * - project_activity: recent project activity (media, messages, reports in last 30 days)
 */
export async function getProjectTransparency(pool, projectId) {
  const today = new Date().toISOString().slice(0, 10);
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { rows: proj } = await pool.query(
    'SELECT id, updated_at, vendor_id FROM projects WHERE id = $1',
    [projectId]
  );
  if (!proj.length) return null;

  const project = proj[0];
  const projectUpdated = project.updated_at ? new Date(project.updated_at).toISOString().slice(0, 10) : null;

  // Update frequency (25): last update or last progress report within 14 days = 25, 14-30 = 15, >30 = 5
  let updateScore = 0;
  const { rows: lastReport } = await pool.query(
    'SELECT period_end FROM project_progress_reports WHERE project_id = $1 ORDER BY period_end DESC LIMIT 1',
    [projectId]
  );
  const lastReportDate = lastReport[0]?.period_end || null;
  const lastActivity = [projectUpdated, lastReportDate].filter(Boolean).sort().pop();
  if (lastActivity) {
    if (lastActivity >= fourteenDaysAgo) updateScore = 25;
    else if (lastActivity >= thirtyDaysAgo) updateScore = 15;
    else updateScore = 5;
  }

  // Milestone progress (25): % of milestones completed (is_paid or progress_percent 100)
  const { rows: ms } = await pool.query(
    'SELECT COUNT(*) AS total, SUM(CASE WHEN is_paid = 1 OR progress_percent >= 100 THEN 1 ELSE 0 END) AS done FROM milestones WHERE project_id = $1',
    [projectId]
  );
  const totalMs = Number(ms[0]?.total || 0);
  const doneMs = Number(ms[0]?.done || 0);
  const milestoneScore = totalMs > 0 ? Math.round((doneMs / totalMs) * 25) : 25;

  // Verified updates (25): ratio of verified to verifiable activities (media_upload, progress_report)
  const { rows: verRows } = await pool.query(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN verified_at IS NOT NULL THEN 1 ELSE 0 END) AS verified
     FROM project_activity WHERE project_id = $1 AND activity_type IN ('media_upload', 'progress_report')`,
    [projectId]
  );
  const verifiableTotal = Number(verRows[0]?.total || 0);
  const verifiedCount = Number(verRows[0]?.verified || 0);
  const verifiedScore = verifiableTotal > 0 ? Math.round((verifiedCount / verifiableTotal) * 25) : 25;

  // Project activity (25): media + messages + progress reports in last 30 days
  const [mediaRes, msgRes, reportRes] = await Promise.all([
    pool.query('SELECT COUNT(*) AS c FROM media WHERE project_id = $1 AND created_at >= $2', [projectId, thirtyDaysAgo]),
    pool.query('SELECT COUNT(*) AS c FROM messages WHERE project_id = $1 AND created_at >= $2', [projectId, thirtyDaysAgo]),
    pool.query('SELECT COUNT(*) AS c FROM project_progress_reports WHERE project_id = $1 AND created_at >= $2', [projectId, thirtyDaysAgo]),
  ]);
  const mediaCount = Number(mediaRes.rows?.[0]?.c || 0);
  const msgCount = Number(msgRes.rows?.[0]?.c || 0);
  const reportCount = Number(reportRes.rows?.[0]?.c || 0);
  const activityLevel = mediaCount + msgCount + reportCount;
  let activityScore = 0;
  if (activityLevel >= 5) activityScore = 25;
  else if (activityLevel >= 2) activityScore = 18;
  else if (activityLevel >= 1) activityScore = 10;
  else activityScore = 5;

  const score = Math.min(100, updateScore + milestoneScore + verifiedScore + activityScore);
  return {
    score,
    factors: {
      update_frequency: { score: updateScore, max: 25, label: 'Update frequency' },
      milestone_progress: { score: milestoneScore, max: 25, label: 'Milestone progress' },
      verified_updates: { score: verifiedScore, max: 25, label: 'Verified updates' },
      project_activity: { score: activityScore, max: 25, label: 'Project activity' },
    },
  };
}

/**
 * Get risk items: overdue invoices, projects with missing updates (no progress report in 14 days or project not updated in 30 days).
 */
export async function getDashboardRisks(pool) {
  const today = new Date().toISOString().slice(0, 10);
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [overdueInvoicesRes, projectsRes] = await Promise.all([
    pool.query(
      `SELECT i.id, i.invoice_number, i.project_id, i.amount, i.due_date, i.status, p.name AS project_name
       FROM invoices i
       JOIN projects p ON i.project_id = p.id
       WHERE i.status IN ('pending', 'overdue') AND i.due_date IS NOT NULL AND i.due_date < $1
       ORDER BY i.due_date ASC LIMIT 50`,
      [today]
    ),
    pool.query(
      `SELECT p.id, p.name, p.updated_at, p.status,
              (SELECT MAX(period_end) FROM project_progress_reports WHERE project_id = p.id) AS last_report_end
       FROM projects p
       WHERE p.status = 'active'`
    )
  ]);

  const overdue_invoices = (overdueInvoicesRes.rows || []).map((r) => ({
    id: r.id,
    invoice_number: r.invoice_number,
    project_id: r.project_id,
    project_name: r.project_name,
    amount: r.amount,
    due_date: r.due_date,
    status: r.status,
  }));

  const missing_updates = (projectsRes.rows || []).filter((p) => {
    const updated = p.updated_at ? new Date(p.updated_at).toISOString().slice(0, 10) : null;
    const lastReport = p.last_report_end || null;
    const lastActivity = [updated, lastReport].filter(Boolean).sort().pop();
    if (!lastActivity) return true;
    return lastActivity < fourteenDaysAgo;
  }).map((p) => ({
    project_id: p.id,
    project_name: p.name,
    last_updated: p.updated_at,
    last_report_end: p.last_report_end,
  }));

  return {
    overdue_invoices,
    missing_updates,
    overdue_milestones: overdue_invoices, // same as overdue invoices (invoice = milestone payment)
  };
}

/**
 * Field agents (role `agent`) on client projects: distinct projects from `project_agent_assignments`,
 * completion timing, and `contractor_ratings` keyed by agent user id (client-submitted ratings).
 */
export async function getContractorsReputation(pool) {
  const dedupeProjectsByClientAndName = (rows) => {
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
  };

  const { rows: assignmentRows } = await pool.query(
    `SELECT
       u.id AS agent_id,
       u.full_name AS agent_full_name,
       u.email AS agent_email,
       p.id AS project_id,
       p.client_id,
       p.name AS project_name,
       p.status,
       p.start_date,
       p.estimated_completion,
       p.updated_at,
       p.created_at,
       c.full_name AS client_name
     FROM users u
     INNER JOIN project_agent_assignments a ON a.agent_id = u.id
     INNER JOIN projects p ON p.id = a.project_id
     LEFT JOIN users c ON c.id = p.client_id
     WHERE u.role = 'agent'
     ORDER BY COALESCE(u.full_name, ''), u.email, p.created_at DESC`
  );

  if (!assignmentRows.length) return [];

  const byAgent = new Map();
  for (const r of assignmentRows) {
    const id = r.agent_id;
    if (!byAgent.has(id)) {
      byAgent.set(id, {
        id,
        full_name: r.agent_full_name,
        email: r.agent_email,
        rawProjectRows: [],
      });
    }
    byAgent.get(id).rawProjectRows.push({
      id: r.project_id,
      client_id: r.client_id,
      name: r.project_name,
      status: r.status,
      start_date: r.start_date,
      estimated_completion: r.estimated_completion,
      updated_at: r.updated_at,
      created_at: r.created_at,
      client_name: r.client_name,
    });
  }

  const agentIds = [...byAgent.keys()];
  const ratingByAgent = new Map();
  if (agentIds.length) {
    const placeholders = agentIds.map((_, i) => `$${i + 1}`).join(', ');
    const { rows: ratingAgg } = await pool.query(
      `SELECT contractor_id,
              AVG(rating) AS avg_rating,
              COUNT(*) AS rating_count
       FROM contractor_ratings
       WHERE contractor_id IN (${placeholders})
       GROUP BY contractor_id`,
      agentIds
    );
    for (const rr of ratingAgg) {
      ratingByAgent.set(rr.contractor_id, {
        avg_rating: rr.avg_rating != null ? Math.round(parseFloat(rr.avg_rating) * 10) / 10 : null,
        rating_count: Number(rr.rating_count || 0),
      });
    }
  }

  const result = [];
  for (const agent of byAgent.values()) {
    const projects = dedupeProjectsByClientAndName(agent.rawProjectRows);
    const completed = projects.filter((p) => p.status === 'completed');
    const total = projects.length;
    const completionTimes = completed
      .filter((p) => p.start_date && p.updated_at)
      .map((p) => {
        const start = new Date(p.start_date).getTime();
        const end = new Date(p.updated_at).getTime();
        return Math.round((end - start) / (24 * 60 * 60 * 1000));
      });
    const avgCompletionDays = completionTimes.length
      ? Math.round(completionTimes.reduce((a, b) => a + b, 0) / completionTimes.length)
      : null;

    const ratings = ratingByAgent.get(agent.id) || { avg_rating: null, rating_count: 0 };

    result.push({
      id: agent.id,
      full_name: agent.full_name,
      email: agent.email,
      project_count: total,
      completed_count: completed.length,
      avg_completion_days: avgCompletionDays,
      avg_rating: ratings.avg_rating,
      rating_count: ratings.rating_count,
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        start_date: p.start_date,
        estimated_completion: p.estimated_completion,
        client_id: p.client_id,
        client_name: p.client_name,
      })),
    });
  }

  result.sort((a, b) => String(a.full_name || a.email).localeCompare(String(b.full_name || b.email)));
  return result;
}
