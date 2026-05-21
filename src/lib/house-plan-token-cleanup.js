import pool from '../db/index.js';

function parsePositiveInt(raw, fallback) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isMissingTableError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('no such table') ||
    msg.includes('relation') && msg.includes('does not exist')
  );
}

export async function cleanupExpiredHousePlanAccessTokens(now = new Date()) {
  const nowIso = now.toISOString();
  try {
    const res = await pool.query(
      'DELETE FROM house_plan_access_tokens WHERE expires_at IS NOT NULL AND expires_at < $1',
      [nowIso]
    );
    return Number(res?.rowCount || 0);
  } catch (err) {
    if (isMissingTableError(err)) {
      // Table may not exist in older environments before running migrations.
      return 0;
    }
    throw err;
  }
}

export function startHousePlanTokenCleanupJob() {
  if (String(process.env.DISABLE_HOUSE_PLAN_TOKEN_CLEANUP || '').toLowerCase() === 'true') {
    console.log('[house-plan-token-cleanup] disabled by DISABLE_HOUSE_PLAN_TOKEN_CLEANUP=true');
    return () => {};
  }

  const intervalMinutes = parsePositiveInt(process.env.HOUSE_PLAN_TOKEN_CLEANUP_INTERVAL_MINUTES, 60);
  const startDelaySeconds = parsePositiveInt(process.env.HOUSE_PLAN_TOKEN_CLEANUP_START_DELAY_SECONDS, 120);
  const intervalMs = intervalMinutes * 60 * 1000;
  const startDelayMs = startDelaySeconds * 1000;

  let started = false;
  const run = async () => {
    try {
      const deleted = await cleanupExpiredHousePlanAccessTokens();
      if (deleted > 0) {
        console.log(`[house-plan-token-cleanup] deleted ${deleted} expired token(s)`);
      } else if (!started) {
        console.log('[house-plan-token-cleanup] active');
      }
      started = true;
    } catch (err) {
      console.error('[house-plan-token-cleanup]', err?.message || err);
    }
  };

  const bootTimer = setTimeout(run, startDelayMs);
  const intervalTimer = setInterval(run, intervalMs);
  bootTimer.unref?.();
  intervalTimer.unref?.();

  return () => {
    clearTimeout(bootTimer);
    clearInterval(intervalTimer);
  };
}

