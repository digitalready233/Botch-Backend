/**
 * Generate a weekly/summary progress report for a project.
 * Aggregates: milestones completed (is_paid), new media in period, financial (payments, invoices).
 */

import pool from '../db/index.js';

/**
 * @param {string} projectId
 * @param {string} periodStart - ISO date YYYY-MM-DD
 * @param {string} periodEnd - ISO date YYYY-MM-DD
 * @returns {Promise<{ summary_text: string; milestones_completed: object[]; new_photos_count: number; financial_summary: object }>}
 */
export async function generateReportForPeriod(projectId, periodStart, periodEnd) {
  const [projRes, milestonesRes, mediaRes, paymentsRes, invoicesRes] = await Promise.all([
    pool.query('SELECT name, progress_percent, total_cost, amount_paid FROM projects WHERE id = $1', [projectId]),
    pool.query(
      `SELECT id, name, amount, is_paid FROM milestones WHERE project_id = $1 ORDER BY order_index, created_at`,
      [projectId]
    ),
    pool.query(
      `SELECT COUNT(*) AS count FROM media WHERE project_id = $1 AND date(created_at) >= $2 AND date(created_at) <= $3`,
      [projectId, periodStart, periodEnd]
    ),
    pool.query(
      `SELECT p.amount, p.currency, p.created_at FROM payments p JOIN invoices i ON p.invoice_id = i.id WHERE i.project_id = $1 AND p.status = 'completed' AND date(p.created_at) >= $2 AND date(p.created_at) <= $3`,
      [projectId, periodStart, periodEnd]
    ),
    pool.query(
      `SELECT invoice_number, amount, status, due_date, created_at FROM invoices WHERE project_id = $1 AND date(created_at) >= $2 AND date(created_at) <= $3`,
      [projectId, periodStart, periodEnd]
    ),
  ]);

  const project = projRes.rows?.[0];
  if (!project) return null;

  const milestones = milestonesRes.rows || [];
  const completedMilestones = milestones.filter((m) => m.is_paid === 1 || m.is_paid === true);
  const newPhotosCount = parseInt(mediaRes.rows?.[0]?.count || 0, 10);
  const payments = paymentsRes.rows || [];
  const invoices = invoicesRes.rows || [];
  const paymentsTotal = payments.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
  const newInvoicesCount = invoices.length;

  const summaryParts = [];
  summaryParts.push(`Project: ${project.name}. Overall progress: ${project.progress_percent || 0}%.`);
  summaryParts.push(`Milestones: ${completedMilestones.length} of ${milestones.length} completed.`);
  if (completedMilestones.length) {
    summaryParts.push(`Completed: ${completedMilestones.map((m) => m.name).join(', ')}.`);
  }
  summaryParts.push(`New photos this period: ${newPhotosCount}.`);
  summaryParts.push(`Payments received this period: ${payments.length} (total USD ${paymentsTotal.toFixed(2)}).`);
  if (newInvoicesCount) {
    summaryParts.push(`New invoices: ${newInvoicesCount}.`);
  }
  summaryParts.push(`Project total: ${project.total_cost != null ? parseFloat(project.total_cost).toFixed(2) : '0'} | Paid to date: ${project.amount_paid != null ? parseFloat(project.amount_paid).toFixed(2) : '0'}.`);

  const summary_text = summaryParts.join(' ');
  const milestones_completed = completedMilestones.map((m) => ({
    id: m.id,
    name: m.name,
    amount: m.amount,
  }));
  const financial_summary = {
    payments_in_period: payments.length,
    payments_total_amount: paymentsTotal,
    new_invoices_count: newInvoicesCount,
    project_total: project.total_cost != null ? parseFloat(project.total_cost) : 0,
    amount_paid: project.amount_paid != null ? parseFloat(project.amount_paid) : 0,
  };

  return {
    summary_text,
    milestones_completed,
    new_photos_count: newPhotosCount,
    financial_summary,
  };
}
