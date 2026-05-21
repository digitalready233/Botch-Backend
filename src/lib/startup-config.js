/**
 * Production startup configuration validator.
 * Ensures required secrets and paths are set so the app fails fast instead of running in an insecure state.
 * Does not modify behavior in development.
 */

function validateStartupConfig() {
  const isProduction = process.env.NODE_ENV === 'production';
  if (!isProduction) return { ok: true };

  const errors = [];
  const warnings = [];

  // Already enforced in index.js: JWT_SECRET
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'dev-secret-change-me') {
    errors.push('JWT_SECRET must be set to a strong random value in production.');
  }

  // Persistent uploads: recommend /data on Render
  if (!process.env.UPLOADS_PATH) {
    warnings.push('UPLOADS_PATH is not set. Set to a persistent path (e.g. /data/uploads or /data/private_uploads) so uploads survive restarts.');
  } else {
    const p = process.env.UPLOADS_PATH;
    if (p.includes('..') || p === '/' || p === '') {
      errors.push('UPLOADS_PATH must be a safe absolute path (e.g. /data/uploads).');
    }
  }

  // Webhook secrets: if payment/KYC is used in production, secrets should be set
  if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_WEBHOOK_SECRET) {
    warnings.push('STRIPE_WEBHOOK_SECRET is not set. Stripe webhooks will fail signature verification.');
  }
  if (!process.env.KYC_WEBHOOK_SECRET?.trim()) {
    warnings.push(
      'KYC_WEBHOOK_SECRET is not set. In production, POST /api/v1/kyc/webhook returns 503 until you set a shared secret (required for Sumsub and any KYC webhook).'
    );
  }

  if (process.env.NODE_ENV === 'production' && !process.env.UPLOADS_PROXY_SECRET?.trim()) {
    warnings.push(
      'UPLOADS_PROXY_SECRET is not set. /uploads is readable if someone guesses URLs. Set the same random value on Render and Vercel; the Next.js /uploads proxy will send header X-Botch-Uploads-Proxy.'
    );
  }

  // FRONTEND_URL for CORS
  if (!process.env.FRONTEND_URL) {
    warnings.push('FRONTEND_URL is not set. CORS may be too permissive.');
  }

  if (errors.length > 0) {
    console.error('[startup] Configuration errors:');
    errors.forEach((e) => console.error('  -', e));
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.warn('[startup] Configuration warnings:');
    warnings.forEach((w) => console.warn('  -', w));
  }

  return { ok: true, warnings };
}

export { validateStartupConfig };
