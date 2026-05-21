import pool from './src/db/index.js';

async function test() {
  try {
    const r = await pool.query('SELECT COUNT(*) AS count FROM users WHERE role = $1', ['client']);
    console.log('OK', r);
  } catch (e) {
    console.error('ERR', e.message);
  }
}
test();
