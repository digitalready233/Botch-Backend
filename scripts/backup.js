#!/usr/bin/env node
/**
 * Backup script for SQLite DB and uploads.
 * Run from repo root: node backend/scripts/backup.js
 * Or from backend: node scripts/backup.js
 *
 * Creates:
 *   backend/backups/botch_YYYYMMDD_HHMMSS.db
 *   backend/backups/uploads_YYYYMMDD_HHMMSS.tar.gz (if uploads dir exists)
 *
 * Ensure backend/backups/ is in .gitignore so backup files are not committed.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');
const dbPath = path.join(backendRoot, 'botch.db');
const uploadsDir = path.join(backendRoot, 'uploads');
const backupsDir = path.join(backendRoot, 'backups');

const stamp = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${y}${m}${day}_${h}${min}${s}`;
};

async function main() {
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
    console.log('Created', backupsDir);
  }

  const timestamp = stamp();

  // 1. Backup SQLite DB
  if (fs.existsSync(dbPath)) {
    const dest = path.join(backupsDir, `botch_${timestamp}.db`);
    fs.copyFileSync(dbPath, dest);
    console.log('DB backup:', dest);
  } else {
    console.warn('No botch.db found at', dbPath);
  }

  // 2. Archive uploads (optional; requires tar on PATH - Linux/macOS. On Windows, copy uploads/ manually.)
  if (fs.existsSync(uploadsDir)) {
    const archiveName = `uploads_${timestamp}.tar.gz`;
    const archivePath = path.join(backupsDir, archiveName);
    try {
      const { execSync } = await import('child_process');
      const cwd = backendRoot;
      execSync(`tar -czf "${archivePath}" uploads`, { cwd });
      console.log('Uploads backup:', archivePath);
    } catch (e) {
      console.warn('Could not create uploads archive (tar failed or not available). Copy uploads/ manually.');
    }
  } else {
    console.log('No uploads/ dir; skipping.');
  }

  console.log('Backup done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
