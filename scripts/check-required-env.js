/**
 * Validates critical production environment variables for safe go-live.
 * Exits non-zero when any required key is missing/blank.
 */

const required = [
  'UPLOADS_PATH',
  'KYC_WEBHOOK_SECRET',
  'UPLOADS_PROXY_SECRET',
  'FRONTEND_URL',
];

const missing = required.filter((key) => !(process.env[key] || '').trim());

if (missing.length > 0) {
  console.error('Missing required production env vars:');
  for (const key of missing) {
    console.error(`- ${key}`);
  }
  process.exit(1);
} else {
  console.log('All required production env vars are set.');
  process.exit(0);
}
