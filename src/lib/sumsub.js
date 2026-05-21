/**
 * Sumsub API client for KYC: access token generation (Web SDK auth).
 * See: https://docs.sumsub.com/reference/authentication
 *      https://docs.sumsub.com/reference/generate-access-token
 */

import crypto from 'crypto';

const DEFAULT_TTL_SEC = 600; // 10 min

/**
 * @returns {boolean} true if Sumsub is configured (app token + secret)
 */
export function isSumsubConfigured() {
  return Boolean(
    process.env.SUMSUB_APP_TOKEN &&
    process.env.SUMSUB_SECRET_KEY &&
    process.env.SUMSUB_BASE_URL
  );
}

/**
 * Get Sumsub API base URL (no trailing slash).
 * Sandbox: https://api-sandbox.sumsub.com
 * Production: https://api.sumsub.com
 */
export function getSumsubBaseUrl() {
  const base = process.env.SUMSUB_BASE_URL || 'https://api-sandbox.sumsub.com';
  return base.replace(/\/+$/, '');
}

/**
 * Build HMAC signature for Sumsub API.
 * Order per docs example: timestamp + method + pathWithQuery + body.
 * Ref: https://docs.sumsub.com/reference/authentication
 */
function signRequest(method, pathWithQuery, body, ts) {
  const secret = process.env.SUMSUB_SECRET_KEY;
  if (!secret) throw new Error('SUMSUB_SECRET_KEY is not set');
  const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
  const stringToSign = String(ts) + method + pathWithQuery + bodyStr;
  const sig = crypto.createHmac('sha256', secret).update(stringToSign).digest('hex');
  return sig;
}

/**
 * Generate a Sumsub access token for the Web SDK.
 * @param {string} userId - Your app's user id (externalUserId in Sumsub)
 * @param {object} [options]
 * @param {string} [options.levelName] - Verification level (default from env SUMSUB_LEVEL_NAME or basic-kyc-level)
 * @param {number} [options.ttlInSecs] - Token TTL in seconds
 * @param {string} [options.email] - Applicant email (optional)
 * @param {string} [options.phone] - Applicant phone (optional)
 * @returns {Promise<{ token: string, userId: string }>}
 */
export async function createAccessToken(userId, options = {}) {
  const baseUrl = getSumsubBaseUrl();
  const appToken = process.env.SUMSUB_APP_TOKEN;
  if (!appToken) throw new Error('SUMSUB_APP_TOKEN is not set');

  const levelName = options.levelName || process.env.SUMSUB_LEVEL_NAME || 'basic-kyc-level';
  const ttlInSecs = options.ttlInSecs ?? DEFAULT_TTL_SEC;
  const path = '/resources/accessTokens/sdk';
  const body = {
    userId,
    levelName,
    ttlInSecs,
  };
  if (options.email) body.applicantIdentifiers = { ...(body.applicantIdentifiers || {}), email: options.email };
  if (options.phone) body.applicantIdentifiers = { ...(body.applicantIdentifiers || {}), phone: options.phone };

  const ts = Math.floor(Date.now() / 1000);
  const bodyStr = JSON.stringify(body);
  const sig = signRequest('POST', path, bodyStr, ts);

  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-App-Token': appToken,
      'X-App-Access-Ts': String(ts),
      'X-App-Access-Sig': sig,
    },
    body: bodyStr,
  });

  if (!res.ok) {
    const errBody = await res.text();
    let msg = `Sumsub API ${res.status}: ${errBody}`;
    try {
      const j = JSON.parse(errBody);
      if (j.description) msg = j.description;
    } catch (_) {}
    throw new Error(msg);
  }

  const data = await res.json();
  return { token: data.token, userId: data.userId || userId };
}

/**
 * Base URL for Sumsub Web SDK (script and iframe).
 * Sandbox: https://sandbox-cdn.sumsub.com (or similar)
 * Production: https://cdn.sumsub.com
 * You can also use SUMSUB_WEB_SDK_BASE_URL to point to your flow (e.g. in.sumsub.com).
 */
export function getSumsubWebSdkBaseUrl() {
  if (process.env.SUMSUB_WEB_SDK_BASE_URL) return process.env.SUMSUB_WEB_SDK_BASE_URL.replace(/\/+$/, '');
  const apiBase = getSumsubBaseUrl();
  if (apiBase.includes('sandbox')) return 'https://sandbox-cdn.sumsub.com';
  return 'https://cdn.sumsub.com';
}
