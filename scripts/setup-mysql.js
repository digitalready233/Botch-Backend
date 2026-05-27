#!/usr/bin/env node
/**
 * First-time MySQL setup: schema.mysql.sql + seed.mysql.sql + ensure super admin.
 * Requires DATABASE_URL=mysql://...
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: backendRoot, stdio: 'inherit', shell: false });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function main() {
  await run('node', ['src/db/apply-mysql-sql.js', 'schema.mysql.sql']);
  await run('node', ['src/db/apply-mysql-sql.js', 'seed.mysql.sql']);
  await run('node', ['scripts/ensure-super-admin.js']);
  console.log('MySQL setup complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
