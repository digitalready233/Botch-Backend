/**
 * Weekly job: generate progress reports for active projects (past 7 days) and send to opted-in users.
 * Call runWeeklyReports() from a cron or timer (e.g. every Sunday).
 */

import { v4 as uuidv4 } from 'uuid';
import pool from '../db/index.js';
import { generateReportForPeriod } from './progress-report.js';
import { sendMail } from './email.js';

function getLastWeekPeriod() {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  return {
    period_start: start.toISOString().slice(0, 10),
    period_end: end.toISOString().slice(0, 10),
  };
}

export async function runWeeklyReports() {
  const { period_start, period_end } = getLastWeekPeriod();
  const { rows: projects } = await pool.query(
    "SELECT id, name FROM projects WHERE status = 'active'"
  );
  let generated = 0;
  let emailsSent = 0;
  for (const proj of projects || []) {
    try {
      const data = await generateReportForPeriod(proj.id, period_start, period_end);
      if (!data) continue;
      const id = uuidv4();
      await pool.query(
        `INSERT INTO project_progress_reports (id, project_id, period_start, period_end, summary_text, milestones_completed, new_photos_count, financial_summary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          proj.id,
          period_start,
          period_end,
          data.summary_text,
          JSON.stringify(data.milestones_completed),
          data.new_photos_count,
          JSON.stringify(data.financial_summary),
        ]
      );
      generated++;

      const { rows: users } = await pool.query(
        `SELECT u.email FROM users u
         WHERE u.id = (SELECT client_id FROM projects WHERE id = $1)
         OR u.id IN (SELECT user_id FROM project_report_preferences WHERE project_id = $1 AND send_weekly_email = 1)`,
        [proj.id]
      );
      const emails = [...new Set((users || []).map((u) => u.email).filter(Boolean))];
      const subject = `Weekly progress report: ${proj.name} (${period_start} to ${period_end})`;
      const text = data.summary_text;
      const html = `<h2>Weekly Progress Report</h2><p><strong>${proj.name}</strong> — ${period_start} to ${period_end}</p><p>${text.replace(/\n/g, '<br>')}</p>`;
      for (const to of emails) {
        try {
          const result = await sendMail({ to, subject, text, html });
          if (result.sent) emailsSent++;
        } catch (_) {}
      }
      if (emails.length > 0) {
        await pool.query(
          'UPDATE project_progress_reports SET email_sent_at = CURRENT_TIMESTAMP WHERE id = $1',
          [id]
        );
      }
    } catch (err) {
      console.error('[weekly-reports]', proj.id, err.message);
    }
  }
  return { generated, emailsSent };
}
