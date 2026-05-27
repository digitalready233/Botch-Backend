/**
 * Zip backend for Hostinger Node.js (api.botchrealty.com).
 * Run from backend: npm run package:hostinger
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..');

const EXCLUDE_DIRS = new Set([
  'node_modules',
  'coverage',
  'tests',
  'backups',
  'hostinger-deploy',
  '.git',
]);
const EXCLUDE_FILES = new Set(['hostinger-backend.zip', 'botch.db', '.env', 'cpanel-environment.env', 'hostinger.env']);

function copyTree(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (EXCLUDE_DIRS.has(path.basename(src))) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyTree(path.join(src, name), path.join(dest, name));
    }
    return;
  }
  if (EXCLUDE_FILES.has(path.basename(src))) return;
  if (src.endsWith('.db') || src.endsWith('.db-journal')) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

const deployRoot = path.join(backendRoot, 'hostinger-deploy');
if (fs.existsSync(deployRoot)) fs.rmSync(deployRoot, { recursive: true });
fs.mkdirSync(deployRoot, { recursive: true });

for (const name of fs.readdirSync(backendRoot)) {
  const full = path.join(backendRoot, name);
  if (name === 'hostinger-deploy' || name === 'uploads') continue;
  if (fs.statSync(full).isDirectory() && EXCLUDE_DIRS.has(name)) continue;
  copyTree(full, path.join(deployRoot, name));
}

fs.mkdirSync(path.join(deployRoot, 'data'), { recursive: true });
fs.mkdirSync(path.join(deployRoot, 'uploads'), { recursive: true });
fs.writeFileSync(path.join(deployRoot, 'uploads', '.gitkeep'), '');
fs.writeFileSync(path.join(deployRoot, 'data', '.gitkeep'), '');

const startSh = `#!/bin/sh
cd "$(dirname "$0")"
mkdir -p data uploads
export LISTEN_HOST="\${LISTEN_HOST:-0.0.0.0}"
export PORT="\${PORT:-4000}"
exec node --no-deprecation src/index.js
`;
fs.writeFileSync(path.join(deployRoot, 'start.sh'), startSh, { mode: 0o755 });

const envTemplate = fs.readFileSync(
  path.join(backendRoot, 'hostinger-backend.env'),
  'utf8'
);
fs.writeFileSync(path.join(deployRoot, 'hostinger-backend.env'), envTemplate);

const readme = `Botch API — Hostinger Node.js (api.botchrealty.com)

1. Upload and extract hostinger-backend.zip into the Node app root for api.botchrealty.com
2. hPanel → Node.js → Environment: copy hostinger-backend.env (fix REPLACE_CPANEL_HOME and PORT)
3. Startup: ./start.sh
4. In Hostinger terminal (SSH or app console):
   npm install
   npm rebuild better-sqlite3
   npm run db:migrate
   npm run db:ensure-super-admin
5. Restart the app
6. Test: curl -s https://api.botchrealty.com/api/health

Frontend (botchrealty.com) must use:
  NEXT_PUBLIC_API_URL=https://api.botchrealty.com/api/v1
  NEXT_PUBLIC_WS_URL=https://api.botchrealty.com
Rebuild frontend after changing .env.local (npm run build:hostinger).
`;
fs.writeFileSync(path.join(deployRoot, 'HOSTINGER-README.txt'), readme);

const zipName = 'hostinger-backend.zip';
const zipPath = path.join(backendRoot, zipName);
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

const zip = spawnSync('zip', ['-r', zipName, 'hostinger-deploy'], {
  cwd: backendRoot,
  stdio: 'inherit',
});

if ((zip.status ?? 1) !== 0) {
  console.warn('[package:hostinger] zip failed — upload hostinger-deploy/ manually.');
} else {
  console.log(`[package:hostinger] Created ${zipPath}`);
}
console.log('[package:hostinger] Upload folder:', deployRoot);
