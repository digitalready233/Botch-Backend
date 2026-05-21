import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import speakeasy from 'speakeasy';
import { body, validationResult } from 'express-validator';
import pool from '../db/index.js';
import { authMiddleware, loadUser, touchSessionActivity } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';
import { sendMail, isEmailConfigured } from '../lib/email.js';
import { sendSms, isSmsConfigured } from '../lib/sms.js';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { logAudit } from '../lib/audit.js';
import { authSignupLoginLimiter, forgotPasswordLimiter, otpAnd2FALimiter } from '../lib/rate-limit-sensitive.js';
import { getUserPermissions } from '../lib/permissions.js';

const router = express.Router();
const SALT_ROUNDS = 12;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ACCESS_EXPIRY = process.env.JWT_ACCESS_EXPIRY || '15m';
const REFRESH_EXPIRY = process.env.JWT_REFRESH_EXPIRY || '7d';
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:3000').trim();
const VERIFY_EXPIRY_HOURS = 24;
const RESET_EXPIRY_HOURS = 1;
const TWO_FA_TOKEN_EXPIRY = '5m';
const LOGIN_OTP_ENABLED = process.env.LOGIN_OTP_ENABLED === 'true' || process.env.LOGIN_OTP_ENABLED === '1';
const LOGIN_OTP_EXPIRY_MINUTES = 10;
const OTP_CODE_LENGTH = 6;
const AUTH_DEBUG_LINKS = process.env.AUTH_DEBUG_LINKS === 'true';

/** PostgreSQL unique violation, or SQLite / better-sqlite3 (often SQLITE_CONSTRAINT_UNIQUE, not SQLITE_CONSTRAINT). */
function isUniqueConstraintError(err) {
  if (!err) return false;
  if (err.code === '23505') return true;
  const code = String(err.code || '');
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
  if (code.includes('SQLITE_CONSTRAINT') && /unique|primary/i.test(String(err.message || ''))) return true;
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('unique constraint failed') || msg.includes('unique failed');
}

function isSqliteCheckConstraintError(err) {
  if (!err) return false;
  if (String(err.code || '') === 'SQLITE_CONSTRAINT_CHECK') return true;
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('check constraint failed');
}

// WebAuthn: relying party config. RP ID must match the browser's domain (e.g. my-app.vercel.app).
// Use apex domain (no www) when possible so both www and non-www work.
function getWebAuthnRpId() {
  if (process.env.WEBAUTHN_RP_ID) return process.env.WEBAUTHN_RP_ID.trim();
  try {
    const u = new URL(FRONTEND_URL);
    const host = (u.hostname || 'localhost').toLowerCase();
    if (host.startsWith('www.') && host.length > 4) return host.slice(4);
    return host;
  } catch {
    return 'localhost';
  }
}
const WEBAUTHN_RP_ID = getWebAuthnRpId();
const WEBAUTHN_ORIGIN = process.env.WEBAUTHN_ORIGIN || FRONTEND_URL.replace(/\/+$/, '');

/** Allowed origins for WebAuthn verification (www + apex) so fingerprint works on both. */
function getWebAuthnAllowedOrigins() {
  const list = [WEBAUTHN_ORIGIN];
  try {
    const u = new URL(WEBAUTHN_ORIGIN);
    const host = u.hostname.toLowerCase();
    if (host.startsWith('www.') && host.length > 4) list.push(`${u.protocol}//${host.slice(4)}`);
    else if (!host.includes('localhost')) list.push(`${u.protocol}//www.${host}`);
  } catch (_) {}
  return list;
}
const WEBAUTHN_RP_NAME = process.env.WEBAUTHN_RP_NAME || 'Botch Realty';

/** Get origin from credential response and validate it's in allowed list; return origin to use for verify. */
function getExpectedOriginFromCredential(credential, allowedOrigins) {
  try {
    const raw = credential?.response?.clientDataJSON;
    if (!raw || typeof raw !== 'string') return WEBAUTHN_ORIGIN;
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    const origin = parsed?.origin;
    if (origin && allowedOrigins.includes(origin)) return origin;
  } catch (_) {}
  return WEBAUTHN_ORIGIN;
}

// In-memory challenge store (userId or email -> { challenge, options }) with 5 min TTL
const registrationChallenges = new Map();
const authenticationChallenges = new Map();
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function pruneChallenges(map) {
  const now = Date.now();
  for (const [key, value] of map.entries()) {
    if (value.expiresAt < now) map.delete(key);
  }
}

function generateTokens(user) {
  const payload = { userId: user.id, role: user.role };
  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_EXPIRY });
  const refreshToken = jwt.sign({ ...payload, refresh: true }, JWT_SECRET, { expiresIn: REFRESH_EXPIRY });
  return { accessToken, refreshToken };
}

const CSRF_EXPIRY = '15m';

/** Generate a short-lived CSRF token for signup/login (signed, no cookie so cross-origin works). */
function createCsrfToken() {
  return jwt.sign({ purpose: 'csrf', n: crypto.randomBytes(8).toString('hex') }, JWT_SECRET, { expiresIn: CSRF_EXPIRY });
}

/** Verify CSRF token from body (csrf_token or csrfToken). Returns true if valid. */
function validateCsrf(req) {
  const token = req.body?.csrf_token || req.body?.csrfToken;
  if (!token || typeof token !== 'string') return false;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded && decoded.purpose === 'csrf';
  } catch {
    return false;
  }
}

/** Verify reCAPTCHA v3 token with Google. Returns true if score >= threshold or recaptcha not configured. */
async function verifyRecaptcha(token, action = 'signup') {
  const secret = (process.env.RECAPTCHA_SECRET_KEY || '').trim();
  if (!secret) return true; // skip if not configured (e.g. dev)
  if (!token || typeof token !== 'string') return false;
  try {
    const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token }).toString(),
    });
    const data = await res.json();
    if (!data.success) return false;
    if (action && data.action && data.action !== action) return false;
    const threshold = Number(process.env.RECAPTCHA_SCORE_THRESHOLD) || 0.5;
    return (Number(data.score) >= threshold);
  } catch (e) {
    console.error('[auth] reCAPTCHA verify error:', e.message);
    return false;
  }
}

/** GET /api/v1/auth/csrf - Return a short-lived CSRF token for signup/login (no auth required). */
router.get('/csrf', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ csrfToken: createCsrfToken() });
});

/** GET /api/v1/auth/debug - Check users in database (DEBUG ONLY - disabled in production) */
router.get('/debug', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, email, full_name, role FROM users'
    );
    res.json({ 
      usersCount: rows.length,
      users: rows 
    });
  } catch (err) {
    console.error('Debug error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/** POST /api/v1/auth/register — role: 'client' (project owner), 'buyer' (shop/rent), or 'vendor' (agent/contractor). Requires CSRF token, password confirmation, and optional reCAPTCHA v3. */
router.post('/register', authSignupLoginLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('fullName').optional().trim().isLength({ max: 255 }),
  body('phone').optional().trim(),
  body('country').optional().trim(),
  body('role').optional().isIn(['client', 'vendor', 'buyer']),
  body('vendor_channel').optional().isIn(['marketplace', 'properties', 'rentals']),
], async (req, res) => {
  try {
    if (!validateCsrf(req)) return res.status(403).json({ error: 'Invalid or expired security token. Please refresh the page and try again.' });
    const recaptchaToken = req.body.recaptcha_token || req.body.recaptchaToken;
    const recaptchaOk = await verifyRecaptcha(recaptchaToken, 'signup');
    if (!recaptchaOk) return res.status(403).json({ error: 'Security check failed. Please refresh and try again.' });

    const confirmPassword = req.body.confirm_password || req.body.passwordConfirm;
    if (req.body.password && confirmPassword !== req.body.password) {
      return res.status(400).json({ error: 'Password and confirmation do not match.' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password, fullName, phone, country } = req.body;
    const role =
      req.body.role === 'vendor' ? 'vendor' : req.body.role === 'buyer' ? 'buyer' : 'client';
    const vendorChannel =
      req.body.vendor_channel === 'properties' || req.body.vendor_channel === 'rentals'
        ? req.body.vendor_channel
        : req.body.vendor_channel === 'marketplace'
          ? 'marketplace'
          : null;
    if (role === 'vendor' && !vendorChannel) {
      return res.status(400).json({
        error: 'Please select a channel: Marketplace, Properties, or Rentals.',
      });
    }
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const id = uuidv4();
    const emailToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + VERIFY_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();

    await pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, phone, country, role, verified, email_verified, email_verification_token, email_verification_expires_at, signup_vendor_channel)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, $11)`,
      [
        id,
        email,
        passwordHash,
        fullName || null,
        phone || null,
        country || null,
        role,
        0,
        emailToken,
        expiresAt,
        role === 'vendor' ? vendorChannel : null,
      ]
    );

    const verifyUrl = `${FRONTEND_URL}/verify-email?token=${encodeURIComponent(emailToken)}`;

    if (role === 'vendor') {
      const emailResult = await sendMail({
        to: email,
        subject: 'Botch Realty — Verify your email (Agent/Contractor registration)',
        text: `Thanks for registering as an Agent/Contractor on Botch Realty.

Step 1 — Verify this email address (required):
${verifyUrl}

Step 2 — An admin must approve your account before you can sign in. You will receive another email when you are approved.

After approval, sign in at: ${FRONTEND_URL}/login

— Botch Realty`,
        html: `<p>Thanks for registering as an Agent/Contractor.</p>
<p><strong>Step 1 — Verify your email</strong> (required):<br/><a href="${verifyUrl}">Verify my email</a></p>
<p><strong>Step 2 — Admin approval</strong> — After you verify, an admin will review your account. You will receive a separate email when you can sign in.</p>
<p>— Botch Realty</p>`,
      });
      const emailSent = emailResult?.sent === true;
      if (!emailSent && emailResult?.error) {
        console.error('[auth] Vendor signup email failed:', emailResult.error);
      }
      const { rows } = await pool.query(
        'SELECT id, email, full_name, role, verified, email_verified FROM users WHERE id = $1',
        [id]
      );
      return res.status(201).json({
        user: { ...rows[0], verified: false, email_verified: false },
        pendingApproval: true,
        message:
          'Check your email to verify your address. After verification, an admin must approve your account before you can sign in.',
        verificationUrl: verifyUrl,
        emailSent,
        emailHint: !isEmailConfigured()
          ? 'Email is not configured. Add RESEND_API_KEY (or SENDGRID_API_KEY / SMTP settings) to backend .env to send verification emails.'
          : !emailSent
            ? 'We could not send the verification email. Check your email settings or try again later.'
            : undefined,
      });
    }

    const emailResult = await sendMail(
      role === 'buyer'
        ? {
            to: email,
            subject: 'Welcome to Botch Realty — Verify your email (Buyer)',
            text: `Welcome! Please verify your email by opening this link: ${verifyUrl}\n\nAfter verification, sign in to browse properties, rentals, and your saved listings.\n\n— Botch Realty`,
            html: `<p>Welcome to Botch Realty as a buyer!</p><p><a href="${verifyUrl}">Verify your email</a></p><p>Then sign in to explore the marketplace, rentals, and saved listings.</p><p>— Botch Realty</p>`,
          }
        : {
            to: email,
            subject: 'Welcome to Botch Realty — Verify your email',
            text: `Welcome! Please verify your email by opening this link: ${verifyUrl}\n\nComplete your profile in the dashboard so we can assign your first project.\n\n— Botch Realty`,
            html: `<p>Welcome to Botch Realty!</p><p><a href="${verifyUrl}">Verify your email</a></p><p>Then complete your profile in the dashboard so we can assign your first project.</p><p>— Botch Realty</p>`,
          }
    );

    const { rows } = await pool.query(
      'SELECT id, email, full_name, role, verified, email_verified FROM users WHERE id = $1',
      [id]
    );
    const user = rows[0];
    const { accessToken, refreshToken } = generateTokens(user);
    touchSessionActivity(user.id);
    const emailSent = emailResult?.sent === true;
    if (!emailSent && emailResult?.error) {
      console.error('[auth] Welcome email failed:', emailResult.error);
    }

    res.status(201).json({
      user: {
        ...user,
        verified: Boolean(user.verified),
        email_verified: Boolean(user.email_verified),
      },
      accessToken,
      refreshToken,
      expiresIn: 900,
      verificationUrl: verifyUrl,
      emailSent,
      emailHint: !isEmailConfigured()
        ? 'Email is not configured. Add RESEND_API_KEY (or SENDGRID_API_KEY / SMTP settings) to backend .env to send verification emails.'
        : !emailSent
          ? 'We could not send the verification email. Check your email settings or try again later.'
          : undefined,
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    if (isSqliteCheckConstraintError(err)) {
      console.error('[auth] register CHECK constraint (often stale users.role in SQLite):', err.message);
      return res.status(400).json({
        error:
          'Account could not be created: the local database has an outdated schema (for example the user role check). Stop the API, run `node src/db/migrate.js` from the backend folder if you use it, or delete `backend/botch.db` and restart the server once to recreate the DB.',
      });
    }
    console.error('[auth] register failed:', err.code, err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

/** POST /api/v1/auth/login — requires CSRF token. */
router.post('/login', authSignupLoginLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res) => {
  try {
    if (!validateCsrf(req)) return res.status(403).json({ error: 'Invalid or expired security token. Please refresh the page and try again.' });
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;
    const { rows } = await pool.query(
      'SELECT id, email, password_hash, full_name, role, verified, email_verified, two_fa_enabled, login_otp_enabled, phone FROM users WHERE email = $1',
      [email]
    );
    if (rows.length === 0) {
      logAudit({
        userId: null,
        action: 'login_failed',
        resourceType: 'auth',
        resourceId: null,
        details: JSON.stringify({ reason: 'user_not_found', email_domain: email.includes('@') ? email.split('@')[1] : null }),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      logAudit({
        userId: user.id,
        action: 'login_failed',
        resourceType: 'auth',
        resourceId: user.id,
        details: JSON.stringify({ reason: 'invalid_password' }),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (user.role === 'vendor' && !user.verified) {
      return res.status(403).json({
        error: 'Your account is pending approval. You will receive an email when an admin approves your account.',
        code: 'ACCOUNT_PENDING_APPROVAL',
      });
    }

    const useLoginOtp = LOGIN_OTP_ENABLED || (user.login_otp_enabled && user.login_otp_enabled !== 0);
    const preferEmailOtp = req.body.otp_method === 'email';
    const useEmailOtp = useLoginOtp && (preferEmailOtp || !user.two_fa_enabled);

    if (useEmailOtp) {
      const code = crypto.randomInt(100000, 999999).toString();
      const codeHash = await bcrypt.hash(code, 10);
      const otpId = uuidv4();
      const expiresAt = new Date(Date.now() + LOGIN_OTP_EXPIRY_MINUTES * 60 * 1000).toISOString();
      await pool.query(
        `INSERT INTO login_otp_codes (id, user_id, code_hash, channel, expires_at) VALUES ($1, $2, $3, 'email', $4)`,
        [otpId, user.id, codeHash, expiresAt]
      );
      sendMail({
        to: user.email,
        subject: 'Your Botch login code',
        text: `Your one-time login code is: ${code}. It expires in ${LOGIN_OTP_EXPIRY_MINUTES} minutes.`,
        html: `<p>Your one-time login code is: <strong>${code}</strong>.</p><p>It expires in ${LOGIN_OTP_EXPIRY_MINUTES} minutes.</p>`,
      }).catch((err) => console.error('[auth] OTP email failed:', err.message));
      if (user.phone && isSmsConfigured()) {
        sendSms(user.phone, `Botch login code: ${code}. Valid for ${LOGIN_OTP_EXPIRY_MINUTES} min.`).catch(() => {});
      }
      const otpToken = jwt.sign(
        { userId: user.id, purpose: 'login_otp', otpId },
        JWT_SECRET,
        { expiresIn: `${LOGIN_OTP_EXPIRY_MINUTES}m` }
      );
      return res.json({
        requiresOtp: true,
        otpToken,
        otpChannel: 'email',
        message: 'Enter the 6-digit code sent to your email' + (user.phone && isSmsConfigured() ? ' or phone' : ''),
      });
    }

    if (user.two_fa_enabled) {
      const twoFaToken = jwt.sign(
        { userId: user.id, email: user.email, purpose: '2fa' },
        JWT_SECRET,
        { expiresIn: TWO_FA_TOKEN_EXPIRY }
      );
      return res.json({
        requiresTwoFa: true,
        twoFaToken,
        message: 'Enter your 6-digit authenticator code',
        canUseEmailOtp: Boolean(useLoginOtp),
      });
    }

    const { accessToken, refreshToken } = generateTokens(user);
    touchSessionActivity(user.id);
    res.json({
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        verified: Boolean(user.verified),
        email_verified: Boolean(user.email_verified),
        two_fa_enabled: Boolean(user.two_fa_enabled),
      },
      accessToken,
      refreshToken,
      expiresIn: 900,
    });
  } catch (err) {
    console.error('Login error:', err);
    // Helpful message when DB is not set up (e.g. missing users table)
    if (err.code === '42P01') {
      return res.status(503).json({
        error: 'Database not set up. Run from backend: npm run db:migrate && npm run db:seed',
      });
    }
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      return res.status(503).json({ error: 'Database connection failed. Check DATABASE_URL and that PostgreSQL is running.' });
    }
    // SQLite: missing column (e.g. two_fa_enabled on old DB)
    if (err.code === 'SQLITE_ERROR' || err.message?.includes('no such column')) {
      return res.status(503).json({
        error: 'Database schema is outdated. Restart the backend once to run migrations, then try again.',
      });
    }
    res.status(500).json({ error: err.message || 'Login failed' });
  }
});

/** GET /api/v1/auth/verify-email - verify email from link (token in query) */
router.get('/verify-email', async (req, res) => {
  try {
    let token = (req.query.token || '').toString().trim();
    if (!token) {
      return res.status(400).json({
        error: 'This verification link is incomplete. Check your email for the full link, or sign in and request a new one.',
      });
    }
    try {
      token = decodeURIComponent(token);
    } catch (_) {}
    const { rows } = await pool.query(
      'SELECT id, email, email_verification_expires_at FROM users WHERE email_verification_token = $1',
      [token]
    );
    if (rows.length === 0) {
      return res.status(400).json({
        error: 'This link is invalid or has already been used. Sign in and we can send you a new verification email.',
      });
    }
    const user = rows[0];
    const rawExpiry = user.email_verification_expires_at;
    const expiresAt = rawExpiry ? new Date(rawExpiry) : null;
    if (expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() < Date.now()) {
      return res.status(400).json({
        error: 'This link has expired. Sign in to your account and we can send you a fresh verification email.',
      });
    }
    await pool.query(
      'UPDATE users SET email_verified = 1, email_verification_token = NULL, email_verification_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );
    res.json({ ok: true, message: 'Your email is verified. You can now use all features of your account.' });
  } catch (err) {
    console.error('Verify email error:', err);
    res.status(500).json({
      error: 'Something went wrong on our end. Please try again in a moment, or contact support if it keeps happening.',
    });
  }
});

/** POST /api/v1/auth/resend-verification-public - resend verification email by email (login-safe, CSRF required). */
router.post('/resend-verification-public', authSignupLoginLimiter, [
  body('email').isEmail().normalizeEmail(),
], async (req, res) => {
  try {
    if (!validateCsrf(req)) {
      return res.status(403).json({ error: 'Invalid or expired security token. Please refresh the page and try again.' });
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const { rows } = await pool.query(
      'SELECT id, email, email_verified FROM users WHERE email = $1',
      [email]
    );

    // Return a generic success response to avoid account-enumeration leaks.
    if (rows.length === 0) {
      return res.json({
        ok: true,
        message: 'If this email exists, a verification link has been sent. Check your inbox and spam folder.',
      });
    }

    const user = rows[0];
    if (user.email_verified) {
      return res.json({ ok: true, message: 'This email is already verified. You can sign in.' });
    }

    const emailToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + VERIFY_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
    await pool.query(
      'UPDATE users SET email_verification_token = $1, email_verification_expires_at = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [emailToken, expiresAt, user.id]
    );

    const verifyUrl = `${FRONTEND_URL}/verify-email?token=${encodeURIComponent(emailToken)}`;
    const emailResult = await sendMail({
      to: user.email,
      subject: 'Verify your Botch Realty email',
      text: `Please verify your email by opening this link: ${verifyUrl}\n\nThis link expires in ${VERIFY_EXPIRY_HOURS} hours.\n\n— Botch Realty`,
      html: `<p>Please <a href="${verifyUrl}">verify your email</a> to complete your account setup.</p><p>This link expires in ${VERIFY_EXPIRY_HOURS} hours.</p><p>— Botch Realty</p>`,
    });

    if (!emailResult?.sent) {
      if (!isEmailConfigured()) {
        return res.status(503).json({
          error: 'Email is not configured yet. Please contact support.',
        });
      }
      return res.status(503).json({
        error: 'We could not send the email right now. Please try again in a few minutes.',
      });
    }

    return res.json({
      ok: true,
      message: 'Verification email sent. Check your inbox and spam folder.',
    });
  } catch (err) {
    console.error('Resend verification (public) error:', err);
    return res.status(500).json({
      error: 'Something went wrong. Please try again in a moment.',
    });
  }
});

/** POST /api/v1/auth/resend-verification - send a new verification email (authenticated) */
router.post('/resend-verification', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, email_verified, email_verification_token FROM users WHERE id = $1',
      [req.userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Account not found.' });
    const user = rows[0];
    if (user.email_verified) {
      return res.json({ ok: true, message: 'Your email is already verified.' });
    }
    const emailToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + VERIFY_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
    await pool.query(
      'UPDATE users SET email_verification_token = $1, email_verification_expires_at = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [emailToken, expiresAt, user.id]
    );
    const verifyUrl = `${FRONTEND_URL}/verify-email?token=${encodeURIComponent(emailToken)}`;
    const emailResult = await sendMail({
      to: user.email,
      subject: 'Verify your Botch Realty email',
      text: `Please verify your email by opening this link: ${verifyUrl}\n\nThis link expires in ${VERIFY_EXPIRY_HOURS} hours.\n\n— Botch Realty`,
      html: `<p>Please <a href="${verifyUrl}">verify your email</a> to complete your account setup.</p><p>This link expires in ${VERIFY_EXPIRY_HOURS} hours.</p><p>— Botch Realty</p>`,
    });
    if (!emailResult?.sent) {
      if (!isEmailConfigured()) {
        return res.status(503).json({
          error: 'Email is not set up yet. Please contact support to verify your account.',
        });
      }
      return res.status(503).json({
        error: 'We could not send the email right now. Please try again in a few minutes.',
      });
    }
    res.json({ ok: true, message: 'A new verification email has been sent. Check your inbox (and spam folder).' });
  } catch (err) {
    console.error('Resend verification error:', err);
    res.status(500).json({
      error: 'Something went wrong. Please try again in a moment.',
    });
  }
});

/** POST /api/v1/auth/refresh - rotate refresh token: returns new access + new refresh token */
router.post('/refresh', [
  body('refreshToken').notEmpty(),
], (req, res) => {
  const { refreshToken } = req.body;
  try {
    const decoded = jwt.verify(refreshToken, JWT_SECRET);
    if (!decoded.refresh) return res.status(401).json({ error: 'Invalid refresh token' });
    const payload = { userId: decoded.userId, role: decoded.role };
    touchSessionActivity(decoded.userId);
    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_EXPIRY });
    const newRefreshToken = jwt.sign(
      { ...payload, refresh: true },
      JWT_SECRET,
      { expiresIn: REFRESH_EXPIRY }
    );
    res.json({ accessToken, refreshToken: newRefreshToken, expiresIn: 900 });
  } catch {
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

/** GET /api/v1/auth/me - current user (protected) */
router.get('/me', authMiddleware, loadUser, async (req, res, next) => {
  try {
    const permissions = await getUserPermissions(pool, req.user?.role);
    res.json({ ...req.user, permissions });
  } catch (err) {
    next(err);
  }
});

/** PUT /api/v1/auth/me/public-key - set current user's public key for E2EE */
router.put('/me/public-key', authMiddleware, [
  body('public_key').isString().isLength({ min: 50, max: 2000 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const publicKey = String(req.body.public_key).trim();
    await pool.query(
      'UPDATE users SET public_key = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [publicKey, req.userId]
    );
    return res.json({ ok: true, message: 'Public key updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/v1/auth/change-password — authenticated user updates password (requires current password) */
router.post(
  '/change-password',
  authMiddleware,
  otpAnd2FALimiter,
  [
    body('current_password').notEmpty().withMessage('Current password is required'),
    body('new_password').isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
    body('confirm_password').notEmpty().withMessage('Please confirm your new password'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        const first = errors.array()[0];
        return res.status(400).json({ error: first?.msg || 'Invalid input' });
      }
      if (req.body.new_password !== req.body.confirm_password) {
        return res.status(400).json({ error: 'New password and confirmation do not match.' });
      }
      if (req.body.current_password === req.body.new_password) {
        return res.status(400).json({ error: 'New password must be different from your current password.' });
      }
      const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
      if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
      const passwordHash = rows[0].password_hash;
      if (!passwordHash) {
        return res.status(400).json({ error: 'Password sign-in is not set for this account. Use forgot password to set one.' });
      }
      const match = await bcrypt.compare(req.body.current_password, passwordHash);
      if (!match) {
        return res.status(401).json({ error: 'Current password is incorrect.' });
      }
      const newHash = await bcrypt.hash(req.body.new_password, SALT_ROUNDS);
      await pool.query(
        'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [newHash, req.userId]
      );
      logAudit({
        userId: req.userId,
        action: 'password_changed',
        resourceType: 'auth',
        resourceId: req.userId,
        details: JSON.stringify({ source: 'profile' }),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ ok: true, message: 'Your password has been updated.' });
    } catch (err) {
      console.error('Change password error:', err);
      res.status(500).json({ error: 'Could not update password. Please try again.' });
    }
  }
);

/** POST /api/v1/auth/forgot-password - request password reset (sends link; in dev we return it) */
router.post('/forgot-password', forgotPasswordLimiter, [
  body('email').isEmail().normalizeEmail(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const { rows } = await pool.query('SELECT id, email FROM users WHERE email = $1', [req.body.email]);
    if (rows.length === 0) {
      return res.json({ ok: true, message: 'If that email is registered, we sent a reset link. Check your inbox and spam folder.' });
    }
    const user = rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
    await pool.query(
      'UPDATE users SET password_reset_token = $1, password_reset_expires_at = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [token, expiresAt, user.id]
    );
    const resetUrl = `${FRONTEND_URL}/reset-password?token=${encodeURIComponent(token)}`;
    const emailResult = await sendMail({
      to: user.email,
      subject: 'Reset your Botch Realty password',
      text: `You requested a password reset. Open this link to set a new password: ${resetUrl}\n\nThis link expires in ${RESET_EXPIRY_HOURS} hour(s).\n\n— Botch Realty`,
      html: `<p>You requested a password reset.</p><p><a href="${resetUrl}">Set new password</a></p><p>This link expires in ${RESET_EXPIRY_HOURS} hour(s).</p><p>— Botch Realty</p>`,
    });
    if (!emailResult?.sent) {
      if (!isEmailConfigured()) {
        // Development-only helper when explicitly opted in.
        if (process.env.NODE_ENV !== 'production' && AUTH_DEBUG_LINKS) {
          return res.json({
            ok: true,
            message: 'Email is not configured. Use the link below to reset your password (dev only).',
            resetUrl,
          });
        }
        return res.status(503).json({
          error: 'Email is not set up yet. Please contact support to reset your password.',
        });
      }
      return res.status(503).json({
        error: 'We could not send the reset email right now. Please try again in a few minutes.',
      });
    }
    return res.json({
      ok: true,
      message: 'If that email is registered, we sent a reset link. Check your inbox and spam folder.',
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again in a moment.' });
  }
});

/** POST /api/v1/auth/reset-password - set new password using reset token */
router.post('/reset-password', [
  body('token').notEmpty().trim(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const first = errors.array()[0];
      const msg = first?.msg || 'Password must be at least 8 characters.';
      return res.status(400).json({ error: msg });
    }
    const { token, password } = req.body;
    const { rows } = await pool.query(
      'SELECT id, password_reset_expires_at FROM users WHERE password_reset_token = $1',
      [token]
    );
    if (rows.length === 0) {
      return res.status(400).json({ error: 'This reset link is invalid or has already been used. Request a new one from the forgot password page.' });
    }
    const user = rows[0];
    const expiresAt = user.password_reset_expires_at ? new Date(user.password_reset_expires_at) : null;
    if (expiresAt && expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ error: 'This reset link has expired. Go to the forgot password page to request a new one.' });
    }
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    await pool.query(
      'UPDATE users SET password_hash = $1, password_reset_token = NULL, password_reset_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [passwordHash, user.id]
    );
    res.json({ ok: true, message: 'Your password has been reset. You can now sign in with your new password.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again in a moment.' });
  }
});

/** POST /api/v1/auth/otp/verify - complete login with email/SMS OTP code */
router.post('/otp/verify', otpAnd2FALimiter, [
  body('otpToken').notEmpty(),
  body('code').isLength({ min: 6, max: 6 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    let decoded;
    try {
      decoded = jwt.verify(req.body.otpToken, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    if (decoded.purpose !== 'login_otp' || !decoded.userId) return res.status(401).json({ error: 'Invalid token' });
    const { rows: otpRows } = await pool.query(
      'SELECT * FROM login_otp_codes WHERE id = $1 AND user_id = $2 AND used_at IS NULL',
      [decoded.otpId, decoded.userId]
    );
    if (otpRows.length === 0) return res.status(401).json({ error: 'Invalid or already used code' });
    const otpRow = otpRows[0];
    const expiresAt = otpRow.expires_at ? new Date(otpRow.expires_at) : null;
    if (expiresAt && expiresAt.getTime() < Date.now()) {
      return res.status(401).json({ error: 'Code expired. Please log in again.' });
    }
    const match = await bcrypt.compare(req.body.code, otpRow.code_hash);
    if (!match) return res.status(401).json({ error: 'Invalid code' });
    await pool.query('UPDATE login_otp_codes SET used_at = CURRENT_TIMESTAMP WHERE id = $1', [otpRow.id]);
    const { rows: userRows } = await pool.query(
      'SELECT id, email, full_name, role, verified, email_verified, two_fa_enabled FROM users WHERE id = $1',
      [decoded.userId]
    );
    if (userRows.length === 0) return res.status(401).json({ error: 'User not found' });
    const user = userRows[0];
    const { accessToken, refreshToken } = generateTokens(user);
    touchSessionActivity(user.id);
    res.json({
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        verified: Boolean(user.verified),
        email_verified: Boolean(user.email_verified),
        two_fa_enabled: Boolean(user.two_fa_enabled),
      },
      accessToken,
      refreshToken,
      expiresIn: 900,
    });
  } catch (err) {
    console.error('OTP verify error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

/** POST /api/v1/auth/2fa/login - complete login with 2FA code */
router.post('/2fa/login', otpAnd2FALimiter, [
  body('twoFaToken').notEmpty(),
  body('code').isLength({ min: 6, max: 6 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    let decoded;
    try {
      decoded = jwt.verify(req.body.twoFaToken, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    if (decoded.purpose !== '2fa' || !decoded.userId) return res.status(401).json({ error: 'Invalid token' });
    const { rows } = await pool.query(
      'SELECT id, email, full_name, role, verified, email_verified, two_fa_enabled, two_fa_secret FROM users WHERE id = $1',
      [decoded.userId]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'User not found' });
    const user = rows[0];
    if (!user.two_fa_secret) return res.status(401).json({ error: '2FA not enabled' });
    const valid = speakeasy.totp.verify({ secret: user.two_fa_secret, encoding: 'base32', token: req.body.code });
    if (!valid) return res.status(401).json({ error: 'Invalid verification code' });
    const { accessToken, refreshToken } = generateTokens(user);
    touchSessionActivity(user.id);
    res.json({
      user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, verified: Boolean(user.verified), email_verified: Boolean(user.email_verified), two_fa_enabled: true },
      accessToken,
      refreshToken,
      expiresIn: 900,
    });
  } catch (err) {
    console.error('2FA login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

/** POST /api/v1/auth/2fa/disable - turn off 2FA (requires current password) */
router.post('/2fa/disable', authMiddleware, [
  body('password').notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { rows } = await pool.query('SELECT password_hash, two_fa_enabled FROM users WHERE id = $1', [req.userId]);
    if (rows.length === 0) return res.status(401).json({ error: 'User not found' });
    const user = rows[0];
    if (!user.two_fa_enabled) return res.json({ message: '2FA was not enabled' });
    const match = await bcrypt.compare(req.body.password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect password' });
    await pool.query('UPDATE users SET two_fa_enabled = 0, two_fa_secret = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [req.userId]);
    logAudit({
      userId: req.userId,
      action: 'mfa_disabled',
      resourceType: 'auth',
      resourceId: req.userId,
      details: JSON.stringify({ method: 'password_verified' }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ message: '2FA disabled' });
  } catch (err) {
    console.error('2FA disable error:', err);
    res.status(500).json({ error: 'Failed to disable 2FA' });
  }
});

/** POST /api/v1/auth/2fa/setup - generate 2FA secret */
router.post('/2fa/setup', authMiddleware, (req, res) => {
  const secret = speakeasy.generateSecret({
    name: `Botch Realty (${req.userId})`,
    issuer: process.env.TWO_FA_ISSUER || 'Botch Realty',
  });
  res.json({ secret: secret.base32, qrCodeUrl: secret.otpauth_url });
});

/** POST /api/v1/auth/2fa/verify - enable 2FA after verifying token */
router.post('/2fa/verify', authMiddleware, [
  body('token').isLength({ min: 6, max: 6 }),
  body('secret').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { token, secret } = req.body;
  const valid = speakeasy.totp.verify({ secret, encoding: 'base32', token });
  if (!valid) return res.status(400).json({ error: 'Invalid verification code' });
  await pool.query('UPDATE users SET two_fa_enabled = true, two_fa_secret = $1 WHERE id = $2', [secret, req.userId]);
  logAudit({
    userId: req.userId,
    action: 'mfa_enabled',
    resourceType: 'auth',
    resourceId: req.userId,
    details: JSON.stringify({ method: 'totp' }),
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
  res.json({ message: '2FA enabled' });
});

// ---------- WebAuthn / Biometric (fingerprint, face) ----------

/** POST /api/v1/auth/webauthn/register/options - get registration options (authenticated) */
router.post('/webauthn/register/options', authMiddleware, loadUser, async (req, res) => {
  try {
    pruneChallenges(registrationChallenges);
    const userId = req.userId;
    const user = req.user;
    const { rows: existing } = await pool.query(
      'SELECT credential_id FROM webauthn_credentials WHERE user_id = $1',
      [userId]
    );
    const excludeCredentials = existing.map((r) => ({ id: r.credential_id }));
    const options = await generateRegistrationOptions({
      rpName: WEBAUTHN_RP_NAME,
      rpID: WEBAUTHN_RP_ID,
      userName: user.email,
      userDisplayName: user.full_name || user.email,
      attestationType: 'none',
      excludeCredentials: excludeCredentials.length ? excludeCredentials : undefined,
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
        authenticatorAttachment: 'platform',
      },
      supportedAlgorithmIDs: [-7, -257],
    });
    registrationChallenges.set(userId, {
      options,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
    res.json(options);
  } catch (err) {
    console.error('WebAuthn register options error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate options' });
  }
});

/** POST /api/v1/auth/webauthn/register/verify - verify and store credential (authenticated) */
router.post('/webauthn/register/verify', authMiddleware, [
  body('credential').notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const userId = req.userId;
    const stored = registrationChallenges.get(userId);
    if (!stored || stored.expiresAt < Date.now()) {
      return res.status(400).json({ error: 'Registration expired. Please try again.' });
    }
    registrationChallenges.delete(userId);
    const allowedOrigins = getWebAuthnAllowedOrigins();
    const expectedOrigin = getExpectedOriginFromCredential(req.body.credential, allowedOrigins);
    const verification = await verifyRegistrationResponse({
      response: req.body.credential,
      expectedChallenge: stored.options.challenge,
      expectedOrigin,
      expectedRPID: WEBAUTHN_RP_ID,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Verification failed' });
    }
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const publicKeyBase64 = Buffer.from(credential.publicKey).toString('base64');
    const transportsStr = credential.transports && credential.transports.length ? credential.transports.join(',') : null;
    const id = uuidv4();
    await pool.query(
      `INSERT INTO webauthn_credentials (id, user_id, credential_id, public_key, counter, webauthn_user_id, device_type, backed_up, transports)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        userId,
        credential.id,
        publicKeyBase64,
        credential.counter,
        stored.options.user.id,
        credentialDeviceType || 'singleDevice',
        credentialBackedUp ? 1 : 0,
        transportsStr,
      ]
    );
    logAudit({
      userId,
      action: 'passkey_registered',
      resourceType: 'webauthn_credential',
      resourceId: id,
      details: JSON.stringify({ device_type: credentialDeviceType || 'singleDevice' }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ verified: true, message: 'Biometric sign-in added for this device.' });
  } catch (err) {
    console.error('WebAuthn register verify error:', err);
    res.status(400).json({ error: err.message || 'Verification failed' });
  }
});

/** POST /api/v1/auth/webauthn/login/options - get authentication options (public, by email) */
router.post('/webauthn/login/options', authSignupLoginLimiter, [
  body('email').isEmail().normalizeEmail(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const email = req.body.email;
    const { rows: userRows } = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );
    if (userRows.length === 0) {
      return res.status(401).json({ error: 'No account found with this email' });
    }
    const userId = userRows[0].id;
    const { rows: creds } = await pool.query(
      'SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1',
      [userId]
    );
    if (creds.length === 0) {
      return res.status(400).json({ error: 'Biometric sign-in is not set up for this account. Use your password or add it in Profile.' });
    }
    pruneChallenges(authenticationChallenges);
    const allowCredentials = creds.map((c) => ({
      id: c.credential_id,
      transports: c.transports ? c.transports.split(',') : undefined,
    }));
    const options = await generateAuthenticationOptions({
      rpID: WEBAUTHN_RP_ID,
      allowCredentials,
    });
    authenticationChallenges.set(email, {
      options,
      userId,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
    res.json(options);
  } catch (err) {
    console.error('WebAuthn login options error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate options' });
  }
});

/** POST /api/v1/auth/webauthn/login/verify - verify assertion and return tokens */
router.post('/webauthn/login/verify', authSignupLoginLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('credential').notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const email = req.body.email;
    const stored = authenticationChallenges.get(email);
    if (!stored || stored.expiresAt < Date.now()) {
      return res.status(400).json({ error: 'Session expired. Please try again.' });
    }
    authenticationChallenges.delete(email);
    const credentialId = req.body.credential.id;
    const { rows: credRows } = await pool.query(
      'SELECT id, user_id, public_key, counter, transports FROM webauthn_credentials WHERE credential_id = $1',
      [credentialId]
    );
    if (credRows.length === 0) {
      return res.status(401).json({ error: 'Invalid credential' });
    }
    const cred = credRows[0];
    if (cred.user_id !== stored.userId) {
      return res.status(401).json({ error: 'Invalid credential' });
    }
    const publicKey = new Uint8Array(Buffer.from(cred.public_key, 'base64'));
    const allowedOrigins = getWebAuthnAllowedOrigins();
    const expectedOrigin = getExpectedOriginFromCredential(req.body.credential, allowedOrigins);
    const verification = await verifyAuthenticationResponse({
      response: req.body.credential,
      expectedChallenge: stored.options.challenge,
      expectedOrigin,
      expectedRPID: WEBAUTHN_RP_ID,
      credential: {
        id: credentialId,
        publicKey,
        counter: cred.counter,
        transports: cred.transports ? cred.transports.split(',') : undefined,
      },
    });
    if (!verification.verified) {
      return res.status(401).json({ error: 'Verification failed' });
    }
    const { rows: userRows } = await pool.query(
      'SELECT id, email, full_name, role, verified, email_verified, two_fa_enabled FROM users WHERE id = $1',
      [cred.user_id]
    );
    if (userRows.length === 0) return res.status(401).json({ error: 'User not found' });
    const user = userRows[0];
    await pool.query(
      'UPDATE webauthn_credentials SET counter = $1 WHERE id = $2',
      [verification.authenticationInfo.newCounter, cred.id]
    );
    const { accessToken, refreshToken } = generateTokens(user);
    touchSessionActivity(user.id);
    logAudit({
      userId: user.id,
      action: 'passkey_login',
      resourceType: 'auth',
      resourceId: user.id,
      details: JSON.stringify({ credential_id: cred.id }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        verified: Boolean(user.verified),
        email_verified: Boolean(user.email_verified),
        two_fa_enabled: Boolean(user.two_fa_enabled),
      },
      accessToken,
      refreshToken,
      expiresIn: 900,
    });
  } catch (err) {
    console.error('WebAuthn login verify error:', err);
    res.status(400).json({ error: err.message || 'Verification failed' });
  }
});

/** GET /api/v1/auth/webauthn/credentials - list user's biometric credentials (authenticated) */
router.get('/webauthn/credentials', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, credential_id, device_type, created_at FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at DESC',
      [req.userId]
    );
    res.json({ credentials: rows });
  } catch (err) {
    console.error('WebAuthn credentials list error:', err);
    res.status(500).json({ error: 'Failed to load credentials' });
  }
});

/** DELETE /api/v1/auth/webauthn/credentials/:id - remove a passkey (authenticated; must own credential) */
router.delete('/webauthn/credentials/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query(
      'DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Credential not found or already removed' });
    }
    logAudit({
      userId: req.userId,
      action: 'passkey_removed',
      resourceType: 'webauthn_credential',
      resourceId: id,
      details: null,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ removed: true });
  } catch (err) {
    console.error('WebAuthn credential delete error:', err);
    res.status(500).json({ error: 'Failed to remove credential' });
  }
});

export default router;
