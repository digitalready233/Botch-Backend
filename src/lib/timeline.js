/**
 * Verified Construction Transparency: chronological project timeline.
 * Every update has uploader (actor_id), timestamp (created_at), project_id.
 */

export async function getProjectTimeline(pool, projectId) {
  const { rows: activities } = await pool.query(
    `SELECT pa.id, pa.project_id, pa.activity_type, pa.reference_id, pa.actor_id, pa.details, pa.created_at, pa.verified_at, pa.verified_by,
            u.full_name AS actor_name
     FROM project_activity pa
     LEFT JOIN users u ON pa.actor_id = u.id
     WHERE pa.project_id = $1
     ORDER BY pa.created_at DESC
     LIMIT 200`,
    [projectId]
  );
  if (!activities.length) return [];

  const mediaIds = activities.filter((a) => a.activity_type === 'media_upload' && a.reference_id).map((a) => a.reference_id);
  const reportIds = activities.filter((a) => a.activity_type === 'progress_report' && a.reference_id).map((a) => a.reference_id);

  let mediaMap = {};
  if (mediaIds.length > 0) {
    const placeholders = mediaIds.map((_, i) => `$${i + 1}`).join(', ');
    const { rows: mediaRows } = await pool.query(
      `SELECT id, project_id, uploaded_by, title, description, media_type, file_url, file_size, metadata, created_at
       FROM media WHERE id IN (${placeholders})`,
      mediaIds
    );
    mediaRows.forEach((m) => { mediaMap[m.id] = m; });
  }

  let reportMap = {};
  if (reportIds.length > 0) {
    const placeholders = reportIds.map((_, i) => `$${i + 1}`).join(', ');
    const { rows: reportRows } = await pool.query(
      `SELECT id, project_id, period_start, period_end, summary_text, created_at
       FROM project_progress_reports WHERE id IN (${placeholders})`,
      reportIds
    );
    reportRows.forEach((r) => { reportMap[r.id] = r; });
  }

  return activities.map((a) => {
    const entry = {
      id: a.id,
      project_id: a.project_id,
      activity_type: a.activity_type,
      reference_id: a.reference_id,
      actor_id: a.actor_id,
      actor_name: a.actor_name,
      created_at: a.created_at,
      verified_at: a.verified_at,
      verified_by: a.verified_by,
      details: a.details,
    };
    if (a.activity_type === 'media_upload' && a.reference_id && mediaMap[a.reference_id]) {
      entry.media = mediaMap[a.reference_id];
      try {
        entry.media.metadata_json = entry.media.metadata ? JSON.parse(entry.media.metadata) : null;
      } catch (_) {
        entry.media.metadata_json = null;
      }
    }
    if (a.activity_type === 'progress_report' && a.reference_id && reportMap[a.reference_id]) {
      entry.report = reportMap[a.reference_id];
    }
    return entry;
  });
}
