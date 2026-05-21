import * as Sentry from '@sentry/node';

const enabled = Boolean(String(process.env.SENTRY_DSN || '').trim());

function parseSampleRate(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

export function initSentryBackend() {
  if (!enabled) return;

  const release =
    process.env.SENTRY_RELEASE ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GITHUB_SHA ||
    undefined;

  Sentry.init({
    dsn: process.env.SENTRY_DSN.trim(),
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release,
    tracesSampleRate: parseSampleRate(
      process.env.SENTRY_TRACES_SAMPLE_RATE,
      process.env.NODE_ENV === 'production' ? 0.1 : 0
    ),
    sendDefaultPii: false,
    integrations: [Sentry.expressIntegration(), Sentry.httpIntegration()],
  });
}

/** Register after all routes — pairs with Express integration from init(). */
export function attachExpressErrorHandler(app) {
  if (!enabled) return;
  Sentry.setupExpressErrorHandler(app);
}
