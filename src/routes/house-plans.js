import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Stripe from 'stripe';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { body, validationResult, query } from 'express-validator';
import pool from '../db/index.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { getUploadsBase } from '../lib/upload-paths.js';
import { logAudit } from '../lib/audit.js';
import { uploadToS3, isS3Configured } from '../lib/s3.js';
import { fileFilter, ALLOWED_IMAGE_MIMES, ALLOWED_INVOICE_MIMES } from '../lib/upload-validation.js';
import { createNotificationForUser } from '../lib/notifications.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsRoot = getUploadsBase(path.join(__dirname, '..', '..', 'uploads'));
const plansDir = path.join(uploadsRoot, 'house-plans');
const previewsDir = path.join(uploadsRoot, 'house-plan-previews');
const coversDir = path.join(uploadsRoot, 'house-plan-covers');
try {
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(previewsDir, { recursive: true });
  fs.mkdirSync(coversDir, { recursive: true });
} catch (_) {}

const pdfFileFilter = fileFilter(ALLOWED_INVOICE_MIMES, 'House plan PDF');
const imageFileFilter = fileFilter(ALLOWED_IMAGE_MIMES, 'House plan image');
const planDiskStorage = multer.diskStorage({
    destination: (_req, file, cb) => {
      if ((file.fieldname || '').includes('preview')) return cb(null, previewsDir);
      if ((file.fieldname || '').includes('cover')) return cb(null, coversDir);
      return cb(null, plansDir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.bin';
      cb(null, `${uuidv4()}${ext}`);
    },
  });
const planMemoryStorage = multer.memoryStorage();
const upload = multer({
  storage: isS3Configured() ? planMemoryStorage : planDiskStorage,
  limits: { fileSize: 40 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'file') return pdfFileFilter(req, file, cb);
    if ((file.fieldname || '').includes('cover') || (file.fieldname || '').includes('preview')) {
      return imageFileFilter(req, file, cb);
    }
    return cb(new Error('Unsupported upload field'));
  },
});

const router = express.Router();

function toSlug(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function ensureUniqueSlug(base, excludeId = null) {
  let slug = base || `plan-${Date.now()}`;
  let i = 1;
  while (i < 50) {
    const { rows } = await pool.query(
      excludeId
        ? 'SELECT id FROM house_plans WHERE slug = $1 AND id <> $2 LIMIT 1'
        : 'SELECT id FROM house_plans WHERE slug = $1 LIMIT 1',
      excludeId ? [slug, excludeId] : [slug]
    );
    if (!rows.length) return slug;
    i += 1;
    slug = `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}

function getStripe() {
  const key = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) return null;
  return new Stripe(key);
}

function frontendUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').split(',')[0].trim();
}

function isExternalAssetUrl(value) {
  const s = String(value || '').trim().toLowerCase();
  return s.startsWith('http://') || s.startsWith('https://');
}

function getAccessTokenSecret() {
  return process.env.JWT_SECRET || 'dev-secret-change-me';
}

function signPlanAccessToken({ userId, planId, action, expiresInSeconds = 600 }) {
  const tokenId = uuidv4();
  return jwt.sign(
    { sub: userId, pid: planId, act: action, type: 'house_plan_access', jti: tokenId },
    getAccessTokenSecret(),
    { expiresIn: expiresInSeconds }
  );
}

function verifyPlanAccessToken(token, expected) {
  const payload = jwt.verify(token, getAccessTokenSecret());
  if (!payload || payload.type !== 'house_plan_access') return false;
  if (String(payload.sub) !== String(expected.userId)) return false;
  if (String(payload.pid) !== String(expected.planId)) return false;
  if (String(payload.act) !== String(expected.action)) return false;
  if (!payload.jti) return false;
  return payload;
}

async function getPlanByIdOrSlug(idOrSlug, publishedOnly = true) {
  const wherePublished = publishedOnly ? "AND publish_status = 'published'" : '';
  const byId = await pool.query(`SELECT * FROM house_plans WHERE id = $1 ${wherePublished} LIMIT 1`, [idOrSlug]);
  if (byId.rows.length) return byId.rows[0];
  const bySlug = await pool.query(`SELECT * FROM house_plans WHERE slug = $1 ${wherePublished} LIMIT 1`, [idOrSlug]);
  return bySlug.rows[0] || null;
}

async function hasPaidAccess(planId, userId) {
  const { rows } = await pool.query(
    "SELECT id FROM house_plan_purchases WHERE house_plan_id = $1 AND user_id = $2 AND status = 'paid' LIMIT 1",
    [planId, userId]
  );
  return rows.length > 0;
}

async function resolveArchitectOwnerId(candidateUserId, fallbackUserId = null) {
  const raw = String(candidateUserId || fallbackUserId || '').trim();
  if (!raw) return null;
  const { rows } = await pool.query('SELECT id, role FROM users WHERE id = $1 LIMIT 1', [raw]);
  if (!rows.length) {
    const err = new Error('Selected architect account was not found');
    err.status = 400;
    throw err;
  }
  const role = String(rows[0].role || '').toLowerCase();
  if (!['vendor', 'admin', 'super_admin'].includes(role)) {
    const err = new Error('Selected owner must be an agent/architect or admin account');
    err.status = 400;
    throw err;
  }
  return rows[0].id;
}

async function notifyHousePlanPaidOnce(purchaseId) {
  try {
    const { rows } = await pool.query(
      `SELECT
         hpp.id,
         hpp.user_id,
         hpp.amount,
         hpp.currency,
         hp.id AS plan_id,
         hp.title AS plan_title,
         hp.slug AS plan_slug,
         hp.owner_architect_id,
         hp.created_by,
         u.full_name AS buyer_name,
         u.email AS buyer_email
       FROM house_plan_purchases hpp
       LEFT JOIN house_plans hp ON hp.id = hpp.house_plan_id
       LEFT JOIN users u ON u.id = hpp.user_id
       WHERE hpp.id = $1 AND hpp.status = 'paid'
       LIMIT 1`,
      [purchaseId]
    );
    const purchase = rows[0];
    if (!purchase) return;

    const amountLabel = `${purchase.currency === 'GHS' ? 'GHS ' : '$'}${Number(purchase.amount || 0).toLocaleString()}`;
    const buyerLabel = purchase.buyer_name || purchase.buyer_email || 'A client';
    const planLabel = purchase.plan_title || purchase.plan_slug || purchase.plan_id || 'house plan';

    await createNotificationForUser(
      purchase.user_id,
      'house_plan_purchase_paid',
      'House plan unlocked',
      `Payment confirmed for "${planLabel}". Your secure preview and download are now available.`
    );

    const ownerArchitectId = purchase.owner_architect_id || purchase.created_by || null;
    if (ownerArchitectId && String(ownerArchitectId) !== String(purchase.user_id)) {
      await createNotificationForUser(
        ownerArchitectId,
        'house_plan_sale',
        'House plan purchased',
        `${buyerLabel} purchased "${planLabel}" for ${amountLabel}.`
      );
    }

    const { rows: adminRows } = await pool.query(
      `SELECT id
       FROM users
       WHERE role IN ('admin', 'super_admin')`
    );
    for (const admin of adminRows || []) {
      if (!admin?.id) continue;
      await createNotificationForUser(
        admin.id,
        'house_plan_sale',
        'House plan purchase received',
        `${buyerLabel} purchased "${planLabel}" for ${amountLabel}.`
      );
    }
  } catch (_) {
    // Notification failures must never break payment verification.
  }
}

async function canAccessPlanAsset({ plan, userId, userRole, signedToken, action }) {
  const isAdmin = userRole === 'admin' || userRole === 'super_admin';
  if (isAdmin) return true;
  const paid = await hasPaidAccess(plan.id, userId);
  if (!paid) return false;
  if (!signedToken) return false;
  try {
    const payload = verifyPlanAccessToken(signedToken, { userId, planId: plan.id, action });
    if (!payload) return false;
    const nowIso = new Date().toISOString();
    const consume = await pool.query(
      `UPDATE house_plan_access_tokens
       SET used_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND house_plan_id = $2
         AND user_id = $3
         AND action = $4
         AND used_at IS NULL
         AND expires_at > $5`,
      [payload.jti, plan.id, userId, action, nowIso]
    );
    return (consume.rowCount ?? 0) > 0;
  } catch (_) {
    return false;
  }
}

/** Public marketplace list */
router.get(
  '/',
  [query('category').optional(), query('building_type').optional(), query('featured').optional()],
  async (req, res, next) => {
    try {
      let sql = "SELECT id, slug, title, architect_name, building_type, category, description, price, currency, size_label, floors, bedrooms, bathrooms, square_meters, square_feet, cover_image_url, featured, publish_status FROM house_plans WHERE publish_status = 'published'";
      const params = [];
      let idx = 1;
      if (req.query.category) {
        sql += ` AND category = $${idx}`;
        params.push(String(req.query.category).trim());
        idx += 1;
      }
      if (req.query.building_type) {
        sql += ` AND building_type = $${idx}`;
        params.push(String(req.query.building_type).trim());
        idx += 1;
      }
      if (req.query.featured === 'true') sql += ' AND COALESCE(featured, 0) = 1';
      sql += ' ORDER BY COALESCE(featured, 0) DESC, created_at DESC';
      const limit = parseInt(req.query.limit, 10);
      if (!Number.isNaN(limit) && limit > 0 && limit <= 60) sql += ` LIMIT ${Math.min(limit, 60)}`;
      const { rows } = await pool.query(sql, params);
      res.json(rows || []);
    } catch (err) {
      next(err);
    }
  }
);

/** Admin list all plans */
router.get('/admin/list/all', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM house_plans ORDER BY updated_at DESC, created_at DESC');
    res.json(rows || []);
  } catch (err) {
    next(err);
  }
});

/** Architect/agent purchases for plans they own */
router.get('/architect/purchases/me', authMiddleware, async (req, res, next) => {
  try {
    const role = String(req.userRole || '').toLowerCase();
    if (!['vendor', 'admin', 'super_admin'].includes(role)) {
      return res.status(403).json({ error: 'Only architects/agents and admins can view this purchase list' });
    }
    const { rows } = await pool.query(
      `SELECT
         hpp.*,
         hp.title AS plan_title,
         hp.slug AS plan_slug,
         u.email AS buyer_email,
         u.full_name AS buyer_name
       FROM house_plan_purchases hpp
       INNER JOIN house_plans hp ON hp.id = hpp.house_plan_id
       LEFT JOIN users u ON u.id = hpp.user_id
       WHERE COALESCE(hp.owner_architect_id, hp.created_by) = $1
       ORDER BY hpp.created_at DESC`,
      [req.userId]
    );
    return res.json(rows || []);
  } catch (err) {
    return next(err);
  }
});

/** Public plan details with preview images (low-res assets; UI applies blur until purchase) */
router.get('/:idOrSlug', async (req, res, next) => {
  try {
    const plan = await getPlanByIdOrSlug(req.params.idOrSlug, true);
    if (!plan) return res.status(404).json({ error: 'House plan not found' });
    const { rows: previews } = await pool.query(
      'SELECT id, image_url, sort_order FROM house_plan_previews WHERE house_plan_id = $1 ORDER BY sort_order ASC, created_at ASC',
      [plan.id]
    );
    res.json({
      ...plan,
      previews: previews || [],
      pdf_locked: true,
      payment_notice: 'This architectural plan is protected. Complete payment to unlock full preview and PDF download.',
    });
  } catch (err) {
    next(err);
  }
});

/** Access status for current user */
router.get('/:id/access-status', authMiddleware, async (req, res, next) => {
  try {
    const plan = await getPlanByIdOrSlug(req.params.id, true);
    if (!plan) return res.status(404).json({ error: 'House plan not found' });
    const paid = await hasPaidAccess(plan.id, req.userId);
    res.json({ paid, plan_id: plan.id });
  } catch (err) {
    next(err);
  }
});

/** Signed short-lived access link for preview/download (bound to current user). */
router.get('/:id/signed-link', authMiddleware, [
  query('action').isIn(['preview', 'download']),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const action = String(req.query.action || 'preview');
    const plan = await getPlanByIdOrSlug(req.params.id, false);
    if (!plan || plan.publish_status !== 'published') return res.status(404).json({ error: 'House plan not found' });
    const isAdmin = req.userRole === 'admin' || req.userRole === 'super_admin';
    const paid = isAdmin ? true : await hasPaidAccess(plan.id, req.userId);
    if (!paid) return res.status(402).json({ error: 'Payment required' });

    const expiresInSeconds = 10 * 60;
    const sat = signPlanAccessToken({ userId: req.userId, planId: plan.id, action, expiresInSeconds });
    const payload = jwt.decode(sat);
    const tokenId = payload?.jti;
    const expiresAtSec = payload?.exp;
    if (!tokenId || !expiresAtSec) return res.status(500).json({ error: 'Unable to generate secure token' });
    const expiresAtIso = new Date(Number(expiresAtSec) * 1000).toISOString();
    await pool.query(
      `INSERT INTO house_plan_access_tokens (id, house_plan_id, user_id, action, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
      [tokenId, plan.id, req.userId, action, expiresAtIso]
    );
    const base = process.env.BACKEND_PUBLIC_URL || process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 4000}`;
    const url = `${base.replace(/\/+$/, '')}/api/v1/house-plans/${plan.id}/${action}?sat=${encodeURIComponent(sat)}`;
    res.json({ url, expiresInSeconds });
  } catch (err) {
    next(err);
  }
});

/** Initialize purchase */
router.post('/:id/purchase/initiate', authMiddleware, [
  body('provider').optional().isIn(['stripe', 'paystack']),
], async (req, res, next) => {
  try {
    const plan = await getPlanByIdOrSlug(req.params.id, true);
    if (!plan) return res.status(404).json({ error: 'House plan not found' });
    const alreadyPaid = await hasPaidAccess(plan.id, req.userId);
    if (alreadyPaid) return res.json({ alreadyPaid: true, message: 'You already own this plan.' });

    const requestedProvider = String(req.body.provider || 'paystack').toLowerCase();
    const hasStripe = Boolean(getStripe());
    const provider = requestedProvider === 'stripe' ? 'stripe' : 'paystack';
    const { rows: userRows } = await pool.query('SELECT email FROM users WHERE id = $1', [req.userId]);
    const payerEmail = userRows[0]?.email || req.body.email;
    let purchaseId = null;
    const { rows: existingRows } = await pool.query(
      `SELECT id, status
       FROM house_plan_purchases
       WHERE house_plan_id = $1 AND user_id = $2 AND status IN ('pending', 'failed')
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
      [plan.id, req.userId]
    );
    if (existingRows.length > 0) {
      purchaseId = existingRows[0].id;
      await pool.query(
        `UPDATE house_plan_purchases
         SET amount = $2,
             currency = $3,
             provider = $4,
             provider_reference = NULL,
             status = 'pending',
             paid_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [purchaseId, plan.price, plan.currency || 'USD', provider]
      );
    } else {
      purchaseId = uuidv4();
      await pool.query(
        `INSERT INTO house_plan_purchases (id, house_plan_id, user_id, amount, currency, provider, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [purchaseId, plan.id, req.userId, plan.price, plan.currency || 'USD', provider]
      );
    }

    const createStripeCheckout = async () => {
      const stripe = getStripe();
      if (!stripe) return null;
      const okUrl = `${frontendUrl()}/house-plans/${plan.slug || plan.id}?purchase=success&purchaseId=${purchaseId}`;
      const cancelUrl = `${frontendUrl()}/house-plans/${plan.slug || plan.id}?purchase=cancelled`;
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        success_url: okUrl,
        cancel_url: cancelUrl,
        client_reference_id: purchaseId,
        metadata: {
          purchase_id: purchaseId,
          house_plan_id: plan.id,
          user_id: req.userId,
          type: 'house_plan',
        },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: String((plan.currency || 'USD').toLowerCase()),
              unit_amount: Math.round(Number(plan.price) * 100),
              product_data: {
                name: plan.title,
                description: `Architectural plan by ${plan.architect_name}`,
              },
            },
          },
        ],
      });
      await pool.query(
        'UPDATE house_plan_purchases SET provider = $1, provider_reference = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        ['stripe', session.id, purchaseId]
      );
      return { purchaseId, provider: 'stripe', checkoutUrl: session.url, reference: session.id };
    };

    if (provider === 'stripe') {
      const stripeCheckout = await createStripeCheckout();
      if (!stripeCheckout) return res.status(503).json({ error: 'Stripe is not configured' });
      return res.json(stripeCheckout);
    }

    const paystackKey = (process.env.PAYSTACK_SECRET_KEY || '').trim();
    if (!paystackKey) {
      if (hasStripe) {
        const stripeCheckout = await createStripeCheckout();
        if (stripeCheckout) return res.json(stripeCheckout);
      }
      return res.status(503).json({ error: 'Paystack is not configured' });
    }
    if (!payerEmail) return res.status(400).json({ error: 'Missing payer email for Paystack checkout' });
    const callbackUrl = `${frontendUrl()}/house-plans/${plan.slug || plan.id}?purchase=success&purchaseId=${purchaseId}`;
    const expectedCurrency = String(plan.currency || 'USD').toUpperCase();
    const allowedPaystack = (process.env.PAYSTACK_CURRENCIES || 'GHS,USD')
      .toUpperCase()
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    if (allowedPaystack.length > 0 && !allowedPaystack.includes(expectedCurrency)) {
      if (hasStripe) {
        const stripeCheckout = await createStripeCheckout();
        if (stripeCheckout) return res.json(stripeCheckout);
      }
      return res.status(400).json({
        error: `Paystack does not support ${expectedCurrency} for this merchant. Supported: ${allowedPaystack.join(', ')}.`,
      });
    }

    async function tryPaystackInitialize(payCurrency, payAmountMinor) {
      const response = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${paystackKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: payAmountMinor,
          email: payerEmail,
          currency: payCurrency,
          callback_url: callbackUrl,
          metadata: {
            purchase_id: purchaseId,
            house_plan_id: plan.id,
            user_id: req.userId,
            type: 'house_plan',
            plan_currency: expectedCurrency,
            plan_amount: String(plan.price),
          },
        }),
      });
      let data = null;
      try {
        data = await response.json();
      } catch (_) {
        data = null;
      }
      return { response, data };
    }

    let paystackResult = await tryPaystackInitialize(expectedCurrency, Math.round(Number(plan.price) * 100));
    if ((!paystackResult.data?.status || !paystackResult.data?.data?.authorization_url) && paystackResult.response.status === 403) {
      const message = String(paystackResult.data?.message || '').toLowerCase();
      if (message.includes('currency not supported') && expectedCurrency !== 'GHS') {
        const usdToGhs = parseFloat(process.env.PAYSTACK_USD_TO_GHS || '15') || 15;
        const convertedAmountMinor = Math.round(Number(plan.price) * usdToGhs * 100);
        if (convertedAmountMinor > 0) {
          paystackResult = await tryPaystackInitialize('GHS', convertedAmountMinor);
        }
      }
    }

    const gatewayMessage = String(paystackResult.data?.message || '').trim();
    const authorizationUrl = String(paystackResult.data?.data?.authorization_url || '').trim();
    if (!paystackResult.response.ok || !paystackResult.data?.status || !authorizationUrl) {
      if (hasStripe) {
        const stripeCheckout = await createStripeCheckout();
        if (stripeCheckout) return res.json(stripeCheckout);
      }
      const safeMessage = gatewayMessage || 'Unable to initialize payment with Paystack';
      const statusCode = paystackResult.response.status >= 400 && paystackResult.response.status < 500 ? 400 : 502;
      return res.status(statusCode).json({ error: safeMessage });
    }
    await pool.query(
      'UPDATE house_plan_purchases SET provider = $1, provider_reference = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      ['paystack', paystackResult.data?.data?.reference || null, purchaseId]
    );
    return res.json({
      purchaseId,
      provider: 'paystack',
      checkoutUrl: authorizationUrl,
      reference: paystackResult.data?.data?.reference,
    });
  } catch (err) {
    next(err);
  }
});

/** Verify payment and unlock */
router.post('/purchase/verify', authMiddleware, [
  body('purchaseId').isUUID(),
  body('reference').optional().trim(),
], async (req, res, next) => {
  try {
    const { purchaseId, reference } = req.body;
    const { rows } = await pool.query('SELECT * FROM house_plan_purchases WHERE id = $1 AND user_id = $2', [purchaseId, req.userId]);
    if (!rows.length) return res.status(404).json({ error: 'Purchase not found' });
    const purchase = rows[0];
    if (purchase.status === 'paid') return res.json({ ok: true, paid: true });
    const expectedAmountMinor = Math.round(Number(purchase.amount) * 100);
    const expectedCurrency = String(purchase.currency || 'USD').toLowerCase();

    if (purchase.provider === 'stripe') {
      const stripe = getStripe();
      if (!stripe) return res.status(503).json({ error: 'Stripe is not configured' });
      const sessionId = reference || purchase.provider_reference;
      if (!sessionId) return res.status(400).json({ error: 'Missing Stripe session reference' });
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const stripePurchaseId = String(session?.client_reference_id || session?.metadata?.purchase_id || '').trim();
      const stripeCurrency = String(session?.currency || '').toLowerCase();
      const stripeAmountMinor = Number(session?.amount_total ?? Number.NaN);
      const paid = session.payment_status === 'paid'
        && stripePurchaseId === purchaseId
        && Number.isFinite(stripeAmountMinor)
        && stripeAmountMinor === expectedAmountMinor
        && stripeCurrency === expectedCurrency;
      const updateRes = await pool.query(
        'UPDATE house_plan_purchases SET status = $1, paid_at = CASE WHEN $1 = \'paid\' THEN CURRENT_TIMESTAMP ELSE paid_at END, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND status <> $1',
        [paid ? 'paid' : 'failed', purchaseId]
      );
      if (paid && (updateRes.rowCount ?? 0) > 0) {
        await notifyHousePlanPaidOnce(purchaseId);
      }
      return res.json({ ok: true, paid });
    }

    const paystackKey = (process.env.PAYSTACK_SECRET_KEY || '').trim();
    if (!paystackKey) return res.status(503).json({ error: 'Paystack is not configured' });
    const ref = reference || purchase.provider_reference;
    if (!ref) return res.status(400).json({ error: 'Missing Paystack reference' });
    const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`, {
      headers: { Authorization: `Bearer ${paystackKey}` },
    });
    const data = await verifyRes.json();
    const payload = data?.data || {};
    const paystackPurchaseId = String(payload?.metadata?.purchase_id || '').trim();
    const paystackCurrency = String(payload?.currency || '').toLowerCase();
    const paystackAmountMinor = Number(payload?.amount ?? Number.NaN);
    const paid = Boolean(
      data?.status
      && payload?.status === 'success'
      && paystackPurchaseId === purchaseId
      && Number.isFinite(paystackAmountMinor)
      && paystackAmountMinor === expectedAmountMinor
      && paystackCurrency === expectedCurrency
    );
    const updateRes = await pool.query(
      'UPDATE house_plan_purchases SET status = $1, paid_at = CASE WHEN $1 = \'paid\' THEN CURRENT_TIMESTAMP ELSE paid_at END, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND status <> $1',
      [paid ? 'paid' : 'failed', purchaseId]
    );
    if (paid && (updateRes.rowCount ?? 0) > 0) {
      await notifyHousePlanPaidOnce(purchaseId);
    }
    return res.json({ ok: true, paid });
  } catch (err) {
    next(err);
  }
});

/** Protected inline PDF preview (paid users/admin only) */
router.get('/:id/preview', authMiddleware, async (req, res, next) => {
  try {
    const plan = await getPlanByIdOrSlug(req.params.id, false);
    if (!plan || plan.publish_status !== 'published') return res.status(404).json({ error: 'House plan not found' });
    const sat = req.query.sat ? String(req.query.sat) : null;
    const canAccess = await canAccessPlanAsset({
      plan,
      userId: req.userId,
      userRole: req.userRole,
      signedToken: sat,
      action: 'preview',
    });
    if (!canAccess) {
      return res.status(403).json({
        error: 'Secure access required',
        message: sat
          ? 'Secure access link expired or invalid. Generate a new link from your purchase page.'
          : 'Generate a secure one-time preview link before opening this protected plan.',
      });
    }
    if (!plan.pdf_path) return res.status(404).json({ error: 'PDF not uploaded yet' });
    if (isExternalAssetUrl(plan.pdf_path)) {
      return res.redirect(plan.pdf_path);
    }
    const fullPath = path.join(plansDir, path.basename(plan.pdf_path));
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File not found' });
    logAudit({
      userId: req.userId,
      action: 'house_plan_preview',
      resourceType: 'house_plan',
      resourceId: plan.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${(plan.slug || plan.id)}.pdf"`);
    fs.createReadStream(fullPath).pipe(res);
  } catch (err) {
    next(err);
  }
});

/** Protected PDF download (paid users/admin only) */
router.get('/:id/download', authMiddleware, async (req, res, next) => {
  try {
    const plan = await getPlanByIdOrSlug(req.params.id, false);
    if (!plan || plan.publish_status !== 'published') return res.status(404).json({ error: 'House plan not found' });
    const sat = req.query.sat ? String(req.query.sat) : null;
    const canAccess = await canAccessPlanAsset({
      plan,
      userId: req.userId,
      userRole: req.userRole,
      signedToken: sat,
      action: 'download',
    });
    if (!canAccess) {
      return res.status(403).json({
        error: 'Secure access required',
        message: sat
          ? 'Secure access link expired or invalid. Generate a new link from your purchase page.'
          : 'Generate a secure one-time download link before downloading this protected plan.',
      });
    }
    if (!plan.pdf_path) return res.status(404).json({ error: 'PDF not uploaded yet' });
    if (isExternalAssetUrl(plan.pdf_path)) {
      return res.redirect(plan.pdf_path);
    }
    const fullPath = path.join(plansDir, path.basename(plan.pdf_path));
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File not found' });
    logAudit({
      userId: req.userId,
      action: 'house_plan_download',
      resourceType: 'house_plan',
      resourceId: plan.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.download(fullPath, `${plan.slug || plan.id}.pdf`);
  } catch (err) {
    next(err);
  }
});

/** Admin create */
router.post(
  '/',
  authMiddleware,
  requireAdmin,
  [
    body('title').trim().notEmpty(),
    body('architect_name').trim().notEmpty(),
    body('price').isFloat({ min: 0 }),
    body('owner_architect_id').optional({ nullable: true, checkFalsy: true }).isUUID(),
    body('publish_status').optional().isIn(['draft', 'published', 'unpublished']),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const b = req.body || {};
      const ownerArchitectId = await resolveArchitectOwnerId(b.owner_architect_id, req.userId);
      const id = uuidv4();
      const slug = await ensureUniqueSlug(toSlug(b.slug || b.title));
      await pool.query(
        `INSERT INTO house_plans
         (id, slug, title, architect_name, architect_bio, building_type, category, description, tags,
          price, currency, size_label, floors, bedrooms, bathrooms, square_meters, square_feet, cover_image_url,
          featured, publish_status, created_by, owner_architect_id, created_at, updated_at)
         VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $17, $18,
          $19, $20, $21, $22, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          id,
          slug,
          b.title,
          b.architect_name,
          b.architect_bio || null,
          b.building_type || null,
          b.category || null,
          b.description || null,
          Array.isArray(b.tags) ? JSON.stringify(b.tags) : (b.tags || null),
          b.price,
          (b.currency || 'USD').toUpperCase(),
          b.size_label || null,
          b.floors ?? 1,
          b.bedrooms ?? 0,
          b.bathrooms ?? 0,
          b.square_meters ?? null,
          b.square_feet ?? null,
          b.cover_image_url || null,
          b.featured ? 1 : 0,
          b.publish_status || 'draft',
          req.userId,
          ownerArchitectId,
        ]
      );
      const { rows } = await pool.query('SELECT * FROM house_plans WHERE id = $1', [id]);
      res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

/** Admin update */
router.patch('/:id', authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    const { rows: existing } = await pool.query('SELECT * FROM house_plans WHERE id = $1', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'House plan not found' });
    const b = req.body || {};
    const allowed = [
      'title', 'architect_name', 'architect_bio', 'building_type', 'category', 'description',
      'price', 'currency', 'size_label', 'floors', 'bedrooms', 'bathrooms',
      'square_meters', 'square_feet', 'cover_image_url', 'featured', 'publish_status',
    ];
    const updates = [];
    const params = [];
    let idx = 1;

    for (const key of allowed) {
      if (b[key] !== undefined) {
        updates.push(`${key} = $${idx}`);
        if (key === 'featured') params.push(b[key] ? 1 : 0);
        else if (key === 'currency') params.push(String(b[key] || 'USD').toUpperCase());
        else params.push(b[key]);
        idx += 1;
      }
    }
    if (b.owner_architect_id !== undefined) {
      if (b.owner_architect_id === null || String(b.owner_architect_id).trim() === '') {
        updates.push(`owner_architect_id = NULL`);
      } else {
        const ownerArchitectId = await resolveArchitectOwnerId(b.owner_architect_id, null);
        updates.push(`owner_architect_id = $${idx}`);
        params.push(ownerArchitectId);
        idx += 1;
      }
    }
    if (b.tags !== undefined) {
      updates.push(`tags = $${idx}`);
      params.push(Array.isArray(b.tags) ? JSON.stringify(b.tags) : b.tags);
      idx += 1;
    }
    if (b.slug !== undefined || b.title !== undefined) {
      const slug = await ensureUniqueSlug(toSlug(b.slug || b.title || existing[0].title), req.params.id);
      updates.push(`slug = $${idx}`);
      params.push(slug);
      idx += 1;
    }
    if (!updates.length) return res.json(existing[0]);
    params.push(req.params.id);
    await pool.query(`UPDATE house_plans SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${idx}`, params);
    const { rows } = await pool.query('SELECT * FROM house_plans WHERE id = $1', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** Admin add/remove preview URLs */
router.post('/:id/previews', authMiddleware, requireAdmin, [
  body('image_url').trim().notEmpty(),
  body('sort_order').optional().isInt({ min: 0 }),
], async (req, res, next) => {
  try {
    const { rows: planRows } = await pool.query('SELECT id FROM house_plans WHERE id = $1', [req.params.id]);
    if (!planRows.length) return res.status(404).json({ error: 'House plan not found' });
    const id = uuidv4();
    await pool.query(
      'INSERT INTO house_plan_previews (id, house_plan_id, image_url, sort_order, created_at) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)',
      [id, req.params.id, req.body.image_url.trim(), req.body.sort_order ?? 0]
    );
    const { rows } = await pool.query('SELECT * FROM house_plan_previews WHERE id = $1', [id]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** Admin upload house-plan PDF (protected file) */
router.post('/:id/upload-pdf', authMiddleware, requireAdmin, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if ((req.file.mimetype || '').toLowerCase() !== 'application/pdf') return res.status(400).json({ error: 'Only PDF files are allowed' });
    const { rows: planRows } = await pool.query('SELECT id FROM house_plans WHERE id = $1', [req.params.id]);
    if (!planRows.length) return res.status(404).json({ error: 'House plan not found' });
    let pdfRef = req.file.filename || null;
    if (isS3Configured()) {
      const key = `house-plans/${req.file.filename || `plan-${uuidv4()}.pdf`}`;
      const uploaded = await uploadToS3(req.file.buffer, key, req.file.mimetype || 'application/pdf');
      if (uploaded) pdfRef = uploaded;
    }
    await pool.query('UPDATE house_plans SET pdf_path = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [pdfRef, req.params.id]);
    res.json({ ok: true, file: pdfRef });
  } catch (err) {
    next(err);
  }
});

/** Admin upload plan cover */
router.post('/:id/upload-cover', authMiddleware, requireAdmin, upload.single('cover'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { rows: planRows } = await pool.query('SELECT id FROM house_plans WHERE id = $1', [req.params.id]);
    if (!planRows.length) return res.status(404).json({ error: 'House plan not found' });
    let coverUrl = null;
    if (isS3Configured()) {
      const key = `house-plan-covers/${req.file.filename || `cover-${uuidv4()}`}`;
      coverUrl = await uploadToS3(req.file.buffer, key, req.file.mimetype || 'image/jpeg');
    }
    if (!coverUrl) {
      coverUrl = `/uploads/house-plan-covers/${req.file.filename}`;
    }
    await pool.query('UPDATE house_plans SET cover_image_url = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [coverUrl, req.params.id]);
    res.json({ ok: true, cover_image_url: coverUrl });
  } catch (err) {
    next(err);
  }
});

/** Admin upload plan preview image */
router.post('/:id/upload-preview', authMiddleware, requireAdmin, upload.single('preview'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { rows: planRows } = await pool.query('SELECT id FROM house_plans WHERE id = $1', [req.params.id]);
    if (!planRows.length) return res.status(404).json({ error: 'House plan not found' });
    let imageUrl = null;
    if (isS3Configured()) {
      const key = `house-plan-previews/${req.file.filename || `preview-${uuidv4()}`}`;
      imageUrl = await uploadToS3(req.file.buffer, key, req.file.mimetype || 'image/jpeg');
    }
    if (!imageUrl) {
      imageUrl = `/uploads/house-plan-previews/${req.file.filename}`;
    }
    const id = uuidv4();
    await pool.query(
      'INSERT INTO house_plan_previews (id, house_plan_id, image_url, sort_order, created_at) VALUES ($1, $2, $3, 0, CURRENT_TIMESTAMP)',
      [id, req.params.id, imageUrl]
    );
    res.status(201).json({ id, image_url: imageUrl });
  } catch (err) {
    next(err);
  }
});

/** Admin list purchases */
router.get('/admin/purchases/all', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT hpp.*, hp.title AS plan_title, hp.slug AS plan_slug, u.email AS buyer_email, u.full_name AS buyer_name
       FROM house_plan_purchases hpp
       LEFT JOIN house_plans hp ON hp.id = hpp.house_plan_id
       LEFT JOIN users u ON u.id = hpp.user_id
       ORDER BY hpp.created_at DESC`
    );
    res.json(rows || []);
  } catch (err) {
    next(err);
  }
});

/** Admin purchase metrics for dashboard cards */
router.get('/admin/purchases/metrics', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const [totalsRes, statusRes, recentRes, topPlansRes] = await Promise.all([
      pool.query(
        `SELECT
          COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) AS total_revenue,
          COUNT(*) AS total_purchases
         FROM house_plan_purchases`
      ),
      pool.query(
        `SELECT
          SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid_count,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
         FROM house_plan_purchases`
      ),
      pool.query(
        `SELECT
          COUNT(*) AS purchases_7d,
          COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) AS revenue_7d
         FROM house_plan_purchases
         WHERE created_at >= datetime('now', '-7 days')`
      ),
      pool.query(
        `SELECT hp.id, hp.title, hp.slug, COUNT(*) AS paid_sales, COALESCE(SUM(hpp.amount), 0) AS paid_revenue
         FROM house_plan_purchases hpp
         LEFT JOIN house_plans hp ON hp.id = hpp.house_plan_id
         WHERE hpp.status = 'paid'
         GROUP BY hp.id, hp.title, hp.slug
         ORDER BY paid_sales DESC
         LIMIT 5`
      ),
    ]);
    res.json({
      totals: totalsRes.rows?.[0] || {},
      status: statusRes.rows?.[0] || {},
      recent7d: recentRes.rows?.[0] || {},
      topPlans: topPlansRes.rows || [],
    });
  } catch (err) {
    next(err);
  }
});

/** Admin delete */
router.delete('/:id', authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM house_plans WHERE id = $1', [req.params.id]);
    if ((result.rowCount ?? 0) === 0) return res.status(404).json({ error: 'House plan not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
