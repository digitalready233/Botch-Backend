/**
 * Invoice / milestone due-date reminders for admins.
 * Previously ran on every GET /dashboard/stats (side effects + duplicate notifications).
 * Now: scheduled interval + optional POST /admin/jobs/milestone-reminders.
 */

import pool from '../db/index.js';
import { createNotificationForUser } from './notifications.js';

/**
 * @param {import('socket.io').Server | null | undefined} io
 * @returns {Promise<{ dueSent: number; approachingSent: number }>}
 */
export async function runMilestoneReminders(io) {
  const today = new Date().toISOString().slice(0, 10);
  const inSevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { rows: adminRows } = await pool.query(
    "SELECT id FROM users WHERE role IN ('admin', 'super_admin')"
  );
  if (!adminRows?.length) return { dueSent: 0, approachingSent: 0 };

  let dueSent = 0;
  let approachingSent = 0;

  const { rows: dueRows } = await pool.query(
    `SELECT id, invoice_number, due_date, project_id FROM invoices WHERE status = 'pending' AND due_date IS NOT NULL AND due_date <= $1`,
    [today]
  );

  for (const inv of dueRows || []) {
    const title = 'Invoice / milestone due';
    const message = `Invoice ${inv.invoice_number} was due on ${inv.due_date}. Please follow up.`;
    for (const admin of adminRows) {
      const { rows: existing } = await pool.query(
        `SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'milestone_due' AND message LIKE $2 LIMIT 1`,
        [admin.id, `%${inv.invoice_number}%`]
      );
      if (existing?.length) continue;
      await createNotificationForUser(admin.id, 'milestone_due', title, message);
      dueSent++;
      if (io) io.to(`user:${admin.id}`).emit('notification:new', { type: 'milestone_due', title, message });
    }
  }

  const { rows: approachingRows } = await pool.query(
    `SELECT id, invoice_number, due_date, project_id FROM invoices WHERE status = 'pending' AND due_date IS NOT NULL AND due_date > $1 AND due_date <= $2`,
    [today, inSevenDays]
  );

  for (const inv of approachingRows || []) {
    const title = 'Milestone deadline approaching';
    const message = `Invoice ${inv.invoice_number} is due on ${inv.due_date}.`;
    for (const admin of adminRows) {
      const { rows: existing } = await pool.query(
        `SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'milestone_approaching' AND message LIKE $2 LIMIT 1`,
        [admin.id, `%${inv.invoice_number}%`]
      );
      if (existing?.length) continue;
      await createNotificationForUser(admin.id, 'milestone_approaching', title, message);
      approachingSent++;
      if (io) io.to(`user:${admin.id}`).emit('notification:new', { type: 'milestone_approaching', title, message });
    }
  }

  return { dueSent, approachingSent };
}
