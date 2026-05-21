/**
 * Ensure at least one super_admin exists. Safe to run multiple times.
 * Run from backend folder:  npm run db:ensure-super-admin
 * Or:  node scripts/ensure-super-admin.js  (after npm install)
 */
import pool from '../src/db/index.js';

async function main() {
  try {
    const { rows: superRows } = await pool.query("SELECT id FROM users WHERE role = 'super_admin' LIMIT 1");
    if (superRows.length > 0) {
      console.log('✓ A super_admin already exists. No change needed.');
      process.exit(0);
      return;
    }
    const { rows: admins } = await pool.query("SELECT id, email FROM users WHERE role = 'admin' ORDER BY email LIMIT 1");
    if (admins.length === 0) {
      console.log('No admin user found to upgrade. Create an admin first (e.g. via signup or seed), then run this again.');
      process.exit(0);
      return;
    }
    await pool.query("UPDATE users SET role = 'super_admin' WHERE id = $1", [admins[0].id]);
    console.log('✓ Updated', admins[0].email || admins[0].id, 'to super_admin. Log out and log in again to see the Admins link.');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

main();
