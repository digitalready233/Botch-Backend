/**
 * Stricter in-memory rate limits for sensitive auth endpoints (signup, login, forgot-password, OTP verify, 2FA verify).
 * Complements the general auth limiter in index.js. Per-IP, fixed window.
 */

const DEFAULT_WINDOW_MS = 15 * 60 * 1000; // 15 min
const store = new Map(); // key -> { count, resetAt }

function prune() {
  const now = Date.now();
  for (const [key, v] of store.entries()) {
    if (v.resetAt < now) store.delete(key);
  }
}

/**
 * Middleware: max N requests per IP per window. Sends 429 when exceeded.
 * @param {number} max - Max requests per window
 * @param {string} message - JSON error message
 * @param {number} [windowMs] - Window in ms (default 15 min)
 */
export function createSensitiveLimiter(max, message = 'Too many attempts. Try again later.', windowMs = DEFAULT_WINDOW_MS) {
  return (req, res, next) => {
    prune();
    const key = (req.ip || req.socket?.remoteAddress || 'unknown').trim();
    const now = Date.now();
    let entry = store.get(key);
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({ error: message });
    }
    next();
  };
}

/** Signup + login: 10 per minute per IP (CSRF/brute-force protection; aligns with security assessment). */
const ONE_MINUTE_MS = 60 * 1000;
export const authSignupLoginLimiter = createSensitiveLimiter(
  10,
  'Too many signup or login attempts. Try again in a minute.',
  ONE_MINUTE_MS
);

/** Forgot-password: 5 per 15 min per IP */
export const forgotPasswordLimiter = createSensitiveLimiter(5, 'Too many password reset requests. Try again in 15 minutes.');

/** OTP verify + 2FA login: 10 per 15 min per IP (brute-force protection) */
export const otpAnd2FALimiter = createSensitiveLimiter(10, 'Too many verification attempts. Try again in 15 minutes.');
