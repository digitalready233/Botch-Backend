/**
 * Arcjet middleware for Express API (Render). Keeps Stripe/KYC webhooks & Engine.IO polling out of Shield/bot scoring.
 *
 * Env:
 * - ARCJET_KEY — required when enabled (set on Render via Arcjet dash / Netlify parity).
 * - ARCJET_ENABLED — set false/0/off to disable even if key is set (optional).
 * - ARCJET_SHIELD_MODE — LIVE (default) or DRY_RUN.
 * - ARCJET_BOT_MODE — DRY_RUN (default; log-only). Set LIVE to block bots.
 * - ARCJET_TRUSTED_PROXIES — comma-separated IPs/CIDR behind Render/nginx (optional).
 */

import arcjet from '@arcjet/node';
import { detectBot, shield } from '@arcjet/node';

const API_VERSION = process.env.API_VERSION || 'v1';

function resolveMode(raw, fallback) {
  const v = String(raw || '').toUpperCase();
  if (v === 'DRY_RUN') return 'DRY_RUN';
  if (v === 'LIVE') return 'LIVE';
  return fallback;
}

function parseProxies(raw) {
  const list = String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

function pathnameOnly(urlLike) {
  if (!urlLike || typeof urlLike !== 'string') return '';
  const q = urlLike.indexOf('?');
  const path = q === -1 ? urlLike : urlLike.slice(0, q);
  return path.startsWith('/') ? path : `/${path}`;
}

export function arcjetBypassPath(pathOnly) {
  if (pathOnly === '/api/health') return true;
  if (pathOnly === '/') return true;
  if (pathOnly.startsWith('/api-docs')) return true;
  if (pathOnly.startsWith('/api/socket-io')) return true;
  if (pathOnly.startsWith(`/api/${API_VERSION}/payments/stripe-webhook`)) return true;
  if (pathOnly.startsWith(`/api/${API_VERSION}/kyc/webhook`)) return true;
  if (pathOnly.startsWith('/uploads')) return true;
  return false;
}

let cached = null;

function getClient() {
  const key = (process.env.ARCJET_KEY || '').trim();
  const disabled = /^0|false|no|off$/i.test((process.env.ARCJET_ENABLED || '').trim());
  if (!key || disabled) return null;

  if (cached) return cached;

  const shieldMode = resolveMode(process.env.ARCJET_SHIELD_MODE, 'LIVE');
  const botMode = resolveMode(process.env.ARCJET_BOT_MODE, 'DRY_RUN');
  const proxies = parseProxies(process.env.ARCJET_TRUSTED_PROXIES);

  cached = arcjet({
    key,
    ...(proxies ? { proxies } : {}),
    rules: [
      shield({ mode: shieldMode }),
      detectBot({
        mode: botMode,
        allow: ['CATEGORY:SEARCH_ENGINE'],
      }),
    ],
  });
  return cached;
}

/** Express middleware: fail-open if Arcjet misconfigured/off. */
export function arcjetExpressMiddleware(req, res, next) {
  if (req.method === 'OPTIONS') return next();

  const pathOnly = pathnameOnly(req.originalUrl || req.url || '');
  if (arcjetBypassPath(pathOnly)) return next();

  const aj = getClient();
  if (!aj) return next();

  aj
    .protect(req)
    .then((decision) => {
      if (decision.isDenied()) {
        if (decision.reason?.isRateLimit?.()) {
          return res.status(429).json({ code: 429, message: 'Too Many Requests' });
        }
        return res.status(403).json({ code: 403, message: 'Forbidden' });
      }
      next();
    })
    .catch(() => next());
}
