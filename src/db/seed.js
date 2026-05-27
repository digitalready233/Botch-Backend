import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from './index.js';
import { sqlInsertVerb, sqlConflictDoNothing } from '../lib/upsert-sql.js';

const __filename = fileURLToPath(import.meta.url);

const SALT_ROUNDS = 12;

export async function seed() {
  const adminEmail = 'admin@botchrealties.com';
  const clientEmail = 'client@example.com';
  const passwordHash = await bcrypt.hash('Password123!', SALT_ROUNDS);

  const emailConflict = sqlConflictDoNothing('(email)');
  await pool.query(`
    ${sqlInsertVerb()} INTO users (id, email, password_hash, full_name, role, verified)
    VALUES 
      ('a0000000-0000-0000-0000-000000000001', $1, $2, 'Botch Admin', 'super_admin', true),
      ('a0000000-0000-0000-0000-000000000002', $3, $2, 'Diaspora Client', 'client', true)
    ${emailConflict}
  `, [adminEmail, passwordHash, clientEmail]);

  const projectConflict = sqlConflictDoNothing('(id)');
  await pool.query(`
    ${sqlInsertVerb()} INTO projects (id, client_id, name, location, package_type, total_cost, amount_paid, progress_percent, status, start_date, estimated_completion)
    VALUES 
      ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002', 'East Legon 3BR Villa', 'East Legon, Accra', '3BR Villa', 185000, 46000, 28, 'active', '2024-06-01', '2025-06-01')
    ${projectConflict}
  `);

  const { rows: projRows } = await pool.query('SELECT id FROM projects WHERE id = $1', ['b0000000-0000-0000-0000-000000000001']);
  if (projRows.length > 0) {
    await pool.query(`
      INSERT INTO milestones (project_id, name, description, progress_percent, amount, is_paid, order_index)
      SELECT 'b0000000-0000-0000-0000-000000000001', 'Foundation', 'Foundation work complete', 100, 46000, true, 1
      WHERE NOT EXISTS (SELECT 1 FROM milestones WHERE project_id = 'b0000000-0000-0000-0000-000000000001' AND order_index = 1)
    `);
    await pool.query(`
      INSERT INTO milestones (project_id, name, description, progress_percent, amount, is_paid, order_index)
      SELECT 'b0000000-0000-0000-0000-000000000001', 'Superstructure', 'Walls and roofing', 40, 55000, false, 2
      WHERE NOT EXISTS (SELECT 1 FROM milestones WHERE project_id = 'b0000000-0000-0000-0000-000000000001' AND order_index = 2)
    `);
    await pool.query(`
      INSERT INTO milestones (project_id, name, description, progress_percent, amount, is_paid, order_index)
      SELECT 'b0000000-0000-0000-0000-000000000001', 'Finishes', 'Electrical, plumbing, finishes', 0, 42000, false, 3
      WHERE NOT EXISTS (SELECT 1 FROM milestones WHERE project_id = 'b0000000-0000-0000-0000-000000000001' AND order_index = 3)
    `);
    await pool.query(`
      INSERT INTO milestones (project_id, name, description, progress_percent, amount, is_paid, order_index)
      SELECT 'b0000000-0000-0000-0000-000000000001', 'Handover', 'Final inspection and keys', 0, 42000, false, 4
      WHERE NOT EXISTS (SELECT 1 FROM milestones WHERE project_id = 'b0000000-0000-0000-0000-000000000001' AND order_index = 4)
    `);
  }

  console.log('Seed data inserted. Admin:', adminEmail, '| Client:', clientEmail, '| Password: Password123!');
}

const isRunDirect = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isRunDirect) {
  seed().catch((err) => { console.error(err); process.exit(1); });
}
