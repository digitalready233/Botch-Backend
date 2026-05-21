/**
 * Adds one pending invoice for the seeded test client so you can test Paystack again.
 * Run from backend folder: node scripts/add-pending-invoice.js
 */
import { v4 as uuidv4 } from 'uuid';
import pool from '../src/db/index.js';

const SEED_CLIENT_ID = 'a0000000-0000-0000-0000-000000000002';

async function addPendingInvoice() {
  try {
    const { rows: projects } = await pool.query(
      'SELECT id FROM projects WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1',
      [SEED_CLIENT_ID]
    );
    if (!projects.length) {
      console.error('No project found for test client. Run db:seed first.');
      process.exit(1);
    }
    const projectId = projects[0].id;

    const { rows: milestones } = await pool.query(
      'SELECT id, name, amount FROM milestones WHERE project_id = $1 AND is_paid = 0 ORDER BY order_index ASC LIMIT 1',
      [projectId]
    );
    if (!milestones.length) {
      console.error('No unpaid milestone found. All milestones are paid.');
      process.exit(1);
    }
    const milestone = milestones[0];

    const invoiceId = uuidv4();
    const invoiceNumber = 'INV-TEST-' + Date.now().toString(36).toUpperCase();
    await pool.query(
      `INSERT INTO invoices (id, invoice_number, project_id, client_id, milestone_id, amount, status, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', date('now', '+30 days'))`,
      [invoiceId, invoiceNumber, projectId, SEED_CLIENT_ID, milestone.id, milestone.amount]
    );

    console.log('✓ Pending invoice created:', invoiceNumber, '| Amount:', milestone.amount);
    console.log('  Log in as client@example.com and go to Payments & Invoices to try Pay with Paystack.');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

addPendingInvoice();
