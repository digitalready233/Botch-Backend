/**
 * Keeps the backend running: restarts on crash or exit.
 * Run from backend folder: node scripts/run-with-restart.js
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.join(__dirname, '..');
const RESTART_DELAY_MS = 2000;

function run() {
  const child = spawn(
    process.execPath,
    ['--no-deprecation', '--watch', path.join(BACKEND_ROOT, 'src', 'index.js')],
    {
      cwd: BACKEND_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV || 'development',
        // --no-deprecation suppresses util._extend etc. from dependencies
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || '--max-old-space-size=2048'} --no-deprecation`,
      },
    }
  );

  child.on('exit', (code, signal) => {
    if (code === 1) {
      console.error('[run-with-restart] Server exited with code 1 (e.g. port in use). Not restarting.');
      process.exit(1);
    }
    console.error(`[run-with-restart] Process exited (code=${code}, signal=${signal}). Restarting in ${RESTART_DELAY_MS / 1000}s...`);
    setTimeout(run, RESTART_DELAY_MS);
  });
}

run();
