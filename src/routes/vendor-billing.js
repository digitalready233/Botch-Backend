import express from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import Stripe from 'stripe';
import pool from '../db/index.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { resolveVendorBusinessStatus } from '../lib/vendor-business.js';
import {
  VENDOR_CHANNELS,
  listActivePlans,
  listAllPlans,
  getPlanById,
  finalizeChannelSubscriptionPayment,
  parsePerks,
  seedDefaultChannelPlansIfEmpty,
} from '../lib/vendor-channel-subscriptions.js';
import { logAudit } from '../lib/audit.js';
import { createNotificationForUser } from '../lib/notifications.js';

const router = express.Router();
const DEFAULT_BILLING_CURRENCY = (process.env.VENDOR_BILLING_CURRENCY || 'USD').toUpperCase();

function getStripeSecret() {
  return String(process.env.STRIPE_SECRET_KEY || '').trim().replace(/\s+/g, '');
}

function getPaystackSecret() {
  return String(process.env.PAYSTACK_SECRET_KEY || '').trim().replace(/\s+/g, '');
}

function getFrontendUrl() {
  return String(process.env.FRONTEND_URL || 'http://localhost:3000').split(',')[0].trim().replace(/\/+$/, '');
}

function toMinorUnits(amount) {
  return Math.round(Number(amount || 0) * 100);
}

async function fetchWithRetry(url, options, { maxRetries = 3, timeoutMs = 15000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      return res;
    } catch (err) {
      clearTimeout(timeoutId);
      lastErr = err;
      const isRetryable =
        err?.name === 'AbortError' ||
        err?.code === 'ECONNRESET' ||
        err?.code === 'ETIMEDOUT' ||
        err?.cause?.code === 'ECONNRESET' ||
        err?.cause?.code === 'ETIMEDOUT';
      if (!isRetryable || attempt === maxRetries) throw err;
      await new Promise((resolve) => setTimeout(resolve, 450 * attempt));
    }
  }
  throw lastErr;
}

export async function finalizeVendorBillingPaymentAtomic(opts) {
  return finalizeChannelSubscriptionPayment(pool, opts.paymentId, opts.providerReference);
}

router.get(
  '/status',
  authMiddleware,
  [query('user_id').optional().isUUID(), query('vendor_org_id').optional().isUUID()],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      let targetUserId = req.userId;
      if ((req.userRole === 'admin' || req.userRole === 'super_admin') && req.query.user_id) {
        targetUserId = req.query.user_id;
      }

      if (req.query.vendor_org_id && (req.userRole === 'admin' || req.userRole === 'super_admin')) {
        const { rows: vendorRows } = await pool.query(
          `SELECT id FROM users
           WHERE role = 'vendor' AND vendor_org_id = $1
           ORDER BY updated_at DESC
           LIMIT 1`,
          [req.query.vendor_org_id]
        );
        if (!vendorRows.length) {
          return res.status(404).json({ error: 'No vendor user found for this vendor organization' });
        }
        targetUserId = vendorRows[0].id;
      }

      if (targetUserId !== req.userId && req.userRole !== 'admin' && req.userRole !== 'super_admin') {
        return res.status(403).json({ error: "You don't have permission to do that." });
      }

      const status = await resolveVendorBusinessStatus(pool, targetUserId);
      res.json(status);
    } catch (err) {
      next(err);
    }
  }
);

router.get('/me', authMiddleware, async (req, res, next) => {
  try {
    if (req.userRole !== 'vendor' && req.userRole !== 'admin' && req.userRole !== 'super_admin') {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }
    await seedDefaultChannelPlansIfEmpty(pool);
    const status = await resolveVendorBusinessStatus(pool, req.userId);
    return res.json(status);
  } catch (err) {
    next(err);
  }
});

router.get(
  '/channel-plans',
  authMiddleware,
  [query('channel').isIn(VENDOR_CHANNELS)],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      await seedDefaultChannelPlansIfEmpty(pool);
      const plans = await listActivePlans(pool, req.query.channel);
      res.json(plans);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/channel-subscription/initialize',
  authMiddleware,
  [
    body('plan_id').isUUID(),
    body('payment_method').optional().isIn(['paystack', 'stripe']),
    body('return_origin').optional().isString().trim(),
  ],
  async (req, res, next) => {
    try {
      if (req.userRole !== 'vendor') {
        return res.status(403).json({ error: 'Only vendors can subscribe to a channel' });
      }
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const status = await resolveVendorBusinessStatus(pool, req.userId);
      const vendorOrgId = status.vendor_org_id;
      if (!vendorOrgId) return res.status(400).json({ error: 'Vendor organization is required first' });

      const plan = await getPlanById(pool, req.body.plan_id);
      if (!plan || !plan.is_active) {
        return res.status(404).json({ error: 'Subscription plan not found or inactive' });
      }

      const channel = plan.channel;
      const channelStatus = status.channel_subscriptions?.[channel];
      if (channelStatus?.active) {
        return res.json({
          alreadyActive: true,
          message: `You already have an active ${channel} subscription`,
        });
      }

      const paymentMethod = String(req.body.payment_method || 'paystack').toLowerCase();
      const { rows: userRows } = await pool.query('SELECT email FROM users WHERE id = $1', [req.userId]);
      const email = userRows[0]?.email || null;
      if (!email) return res.status(400).json({ error: 'User email required for payment' });

      const amount = Number(plan.amount);
      const currency = String(plan.currency || DEFAULT_BILLING_CURRENCY).toUpperCase();
      const subscriptionId = uuidv4();

      await pool.query(
        `INSERT INTO vendor_channel_subscriptions
          (id, vendor_org_id, channel, plan_id, plan_name, duration_months, amount, currency, provider, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'past_due', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          subscriptionId,
          vendorOrgId,
          channel,
          plan.id,
          plan.name,
          plan.duration_months,
          amount,
          currency,
          paymentMethod === 'stripe' ? 'stripe' : 'paystack',
        ]
      );

      const paymentId = uuidv4();
      await pool.query(
        `INSERT INTO vendor_billing_payments
          (id, vendor_org_id, user_id, payment_type, target_id, amount, currency, payment_method, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'channel_subscription', $4, $5, $6, $7, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          paymentId,
          vendorOrgId,
          req.userId,
          subscriptionId,
          amount,
          currency,
          paymentMethod === 'stripe' ? 'stripe' : 'paystack',
        ]
      );

      const baseUrl =
        req.body.return_origin && /^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?$/.test(req.body.return_origin)
          ? req.body.return_origin.replace(/\/+$/, '')
          : getFrontendUrl();

      const productLabel = `${channel === 'properties' ? 'Properties' : 'Rentals'} posting — ${plan.name}`;

      if (paymentMethod === 'stripe') {
        const stripeSecret = getStripeSecret();
        if (!stripeSecret || stripeSecret.startsWith('pk_')) {
          return res.status(503).json({ error: 'Stripe is not configured. Set STRIPE_SECRET_KEY (sk_...)' });
        }
        const stripe = new Stripe(stripeSecret, { apiVersion: '2024-11-20.acacia' });
        const successUrl = `${baseUrl}/agent/billing?billingPayment=1&channel=${encodeURIComponent(channel)}&reference=${encodeURIComponent(paymentId)}&stripe=1`;
        const cancelUrl = `${baseUrl}/agent/billing?billingPayment=cancelled`;
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          mode: 'payment',
          success_url: successUrl,
          cancel_url: cancelUrl,
          customer_email: email,
          client_reference_id: paymentId,
          metadata: {
            type: 'vendor_channel_subscription',
            billing_payment_id: paymentId,
            vendor_org_id: vendorOrgId,
            user_id: req.userId,
            target_id: subscriptionId,
            channel,
            plan_id: plan.id,
          },
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: currency.toLowerCase(),
                unit_amount: toMinorUnits(amount),
                product_data: { name: productLabel },
              },
            },
          ],
        });
        await pool.query(
          'UPDATE vendor_billing_payments SET provider_reference = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
          [paymentId, session.id]
        );
        return res.json({ authorization_url: session.url, reference: paymentId });
      }

      const paystackSecret = getPaystackSecret();
      if (!paystackSecret) {
        return res.status(503).json({ error: 'Paystack is not configured. Set PAYSTACK_SECRET_KEY' });
      }
      const callbackUrl = `${baseUrl}/agent/billing?billingPayment=1&channel=${encodeURIComponent(channel)}&reference=${encodeURIComponent(paymentId)}`;
      const initRes = await fetchWithRetry('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${paystackSecret}`,
        },
        body: JSON.stringify({
          email,
          amount: String(toMinorUnits(amount)),
          currency,
          reference: paymentId,
          callback_url: callbackUrl,
          metadata: {
            type: 'vendor_channel_subscription',
            billing_payment_id: paymentId,
            vendor_org_id: vendorOrgId,
            user_id: req.userId,
            target_id: subscriptionId,
            channel,
            plan_id: plan.id,
          },
        }),
      });
      const payload = await initRes.json();
      if (!payload?.status || !payload?.data?.authorization_url) {
        await pool.query(
          "UPDATE vendor_billing_payments SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
          [paymentId]
        );
        return res.status(502).json({ error: payload?.message || 'Unable to initialize checkout' });
      }
      await pool.query(
        'UPDATE vendor_billing_payments SET provider_reference = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [paymentId, payload?.data?.reference || null]
      );
      return res.json({ authorization_url: payload.data.authorization_url, reference: paymentId });
    } catch (err) {
      return next(err);
    }
  }
);

router.get(
  '/verify',
  authMiddleware,
  [query('reference').notEmpty()],
  async (req, res, next) => {
    try {
      if (req.userRole !== 'vendor' && req.userRole !== 'admin' && req.userRole !== 'super_admin') {
        return res.status(403).json({ error: "You don't have permission to do that." });
      }
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const reference = String(req.query.reference || '').trim();
      const stripeReturn = req.query.stripe === '1' || req.query.stripe === 'true';
      const { rows } = await pool.query('SELECT * FROM vendor_billing_payments WHERE id = $1', [reference]);
      if (!rows.length) return res.status(404).json({ error: 'Billing payment not found' });
      const payment = rows[0];
      const isAdmin = req.userRole === 'admin' || req.userRole === 'super_admin';
      if (!isAdmin && String(payment.user_id || '') !== String(req.userId)) {
        return res.status(403).json({ error: "You don't have permission to do that." });
      }
      if (payment.status === 'completed') {
        return res.json({ ok: true, message: 'Payment already completed', payment });
      }

      if (payment.payment_method === 'stripe' || stripeReturn) {
        const stripeSecret = getStripeSecret();
        if (!stripeSecret || stripeSecret.startsWith('pk_')) {
          return res.status(503).json({ error: 'Stripe is not configured. Set STRIPE_SECRET_KEY (sk_...)' });
        }
        const stripe = new Stripe(stripeSecret, { apiVersion: '2024-11-20.acacia' });
        const sessionId = String(payment.provider_reference || '').trim() || reference;
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        const paid = session.payment_status === 'paid';
        const stripePaymentId = String(session?.metadata?.billing_payment_id || session?.client_reference_id || '').trim();
        const amountMinor = Number(session?.amount_total ?? Number.NaN);
        const currency = String(session?.currency || '').toUpperCase();
        const expectedAmountMinor = toMinorUnits(payment.amount);
        const expectedCurrency = String(payment.currency || DEFAULT_BILLING_CURRENCY).toUpperCase();
        const matches =
          paid &&
          stripePaymentId === String(payment.id) &&
          Number.isFinite(amountMinor) &&
          amountMinor === expectedAmountMinor &&
          currency === expectedCurrency;
        if (!matches) {
          return res.json({ ok: false, message: 'Payment is being processed', payment });
        }
        const finalized = await finalizeChannelSubscriptionPayment(pool, payment.id, session.id || session.payment_intent || null);
        if (finalized.justCompleted) {
          await createNotificationForUser(
            payment.user_id,
            'vendor_billing_paid',
            'Channel subscription active',
            'Your channel posting subscription is now active.'
          );
        }
        return res.json({ ok: true, message: 'Payment successful', payment: finalized.payment });
      }

      const paystackSecret = getPaystackSecret();
      if (!paystackSecret) return res.status(503).json({ error: 'Paystack is not configured. Set PAYSTACK_SECRET_KEY' });
      const verifyRes = await fetchWithRetry(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${paystackSecret}` },
        }
      );
      const payload = await verifyRes.json();
      const data = payload?.data || {};
      const amountMinor = Number(data?.amount ?? Number.NaN);
      const currency = String(data?.currency || '').toUpperCase();
      const metadata = data?.metadata || {};
      const verifiedPaymentId = String(metadata?.billing_payment_id || data?.reference || '').trim();
      const expectedAmountMinor = toMinorUnits(payment.amount);
      const expectedCurrency = String(payment.currency || DEFAULT_BILLING_CURRENCY).toUpperCase();
      const matches =
        payload?.status &&
        data?.status === 'success' &&
        verifiedPaymentId === String(payment.id) &&
        Number.isFinite(amountMinor) &&
        amountMinor === expectedAmountMinor &&
        currency === expectedCurrency;
      if (!matches) {
        await pool.query(
          "UPDATE vendor_billing_payments SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
          [payment.id]
        );
        return res.status(400).json({ ok: false, message: 'Payment verification mismatch' });
      }
      const finalized = await finalizeChannelSubscriptionPayment(
        pool,
        payment.id,
        data?.reference || payment.provider_reference || null
      );
      if (finalized.justCompleted) {
        await createNotificationForUser(
          payment.user_id,
          'vendor_billing_paid',
          'Channel subscription active',
          'Your channel posting subscription is now active.'
        );
      }
      return res.json({ ok: true, message: 'Payment successful', payment: finalized.payment });
    } catch (err) {
      return next(err);
    }
  }
);

// --- Admin: plan catalog ---

router.get(
  '/admin/channel-plans',
  authMiddleware,
  requireAdmin,
  [query('channel').isIn(VENDOR_CHANNELS)],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      await seedDefaultChannelPlansIfEmpty(pool);
      const plans = await listAllPlans(pool, req.query.channel);
      res.json(plans);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/admin/channel-plans',
  authMiddleware,
  requireAdmin,
  [
    body('channel').isIn(VENDOR_CHANNELS),
    body('name').trim().isLength({ min: 1, max: 120 }),
    body('duration_months').isInt({ min: 1, max: 120 }),
    body('amount').isFloat({ min: 0 }),
    body('currency').optional().trim().isLength({ min: 3, max: 10 }),
    body('compare_at_amount').optional({ nullable: true }).isFloat({ min: 0 }),
    body('discount_percent').optional({ nullable: true }).isInt({ min: 0, max: 100 }),
    body('perks').optional().isArray(),
    body('sort_order').optional().isInt(),
    body('is_active').optional().isBoolean(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const id = uuidv4();
      const perks = JSON.stringify(parsePerks(req.body.perks || []));
      const {
        channel,
        name,
        duration_months,
        amount,
        currency = DEFAULT_BILLING_CURRENCY,
        compare_at_amount = null,
        discount_percent = null,
        sort_order = 0,
        is_active = true,
      } = req.body;

      await pool.query(
        `INSERT INTO vendor_channel_plans
          (id, channel, name, duration_months, amount, currency, compare_at_amount, discount_percent, perks, sort_order, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          id,
          channel,
          name,
          duration_months,
          amount,
          String(currency).toUpperCase(),
          compare_at_amount,
          discount_percent,
          perks,
          sort_order,
          is_active,
        ]
      );

      logAudit({
        userId: req.userId,
        action: 'vendor_channel_plan_create',
        resourceType: 'vendor_channel_plan',
        resourceId: id,
        details: JSON.stringify({ channel, name, amount }),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      const plan = await getPlanById(pool, id);
      res.status(201).json(plan);
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/admin/channel-plans/:id',
  authMiddleware,
  requireAdmin,
  [
    param('id').isUUID(),
    body('name').optional().trim().isLength({ min: 1, max: 120 }),
    body('duration_months').optional().isInt({ min: 1, max: 120 }),
    body('amount').optional().isFloat({ min: 0 }),
    body('currency').optional().trim().isLength({ min: 3, max: 10 }),
    body('compare_at_amount').optional({ nullable: true }).isFloat({ min: 0 }),
    body('discount_percent').optional({ nullable: true }).isInt({ min: 0, max: 100 }),
    body('perks').optional().isArray(),
    body('sort_order').optional().isInt(),
    body('is_active').optional().isBoolean(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { id } = req.params;
      const existing = await getPlanById(pool, id);
      if (!existing) return res.status(404).json({ error: 'Plan not found' });

      const fields = [];
      const params = [];
      let idx = 1;
      const setField = (col, val) => {
        fields.push(`${col} = $${idx}`);
        params.push(val);
        idx += 1;
      };

      if (req.body.name !== undefined) setField('name', req.body.name);
      if (req.body.duration_months !== undefined) setField('duration_months', req.body.duration_months);
      if (req.body.amount !== undefined) setField('amount', req.body.amount);
      if (req.body.currency !== undefined) setField('currency', String(req.body.currency).toUpperCase());
      if (req.body.compare_at_amount !== undefined) setField('compare_at_amount', req.body.compare_at_amount);
      if (req.body.discount_percent !== undefined) setField('discount_percent', req.body.discount_percent);
      if (req.body.perks !== undefined) setField('perks', JSON.stringify(parsePerks(req.body.perks)));
      if (req.body.sort_order !== undefined) setField('sort_order', req.body.sort_order);
      if (req.body.is_active !== undefined) setField('is_active', req.body.is_active);

      if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

      fields.push('updated_at = CURRENT_TIMESTAMP');
      params.push(id);
      await pool.query(`UPDATE vendor_channel_plans SET ${fields.join(', ')} WHERE id = $${idx}`, params);

      const plan = await getPlanById(pool, id);
      res.json(plan);
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  '/admin/channel-plans/:id',
  authMiddleware,
  requireAdmin,
  [param('id').isUUID()],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { id } = req.params;
      const existing = await getPlanById(pool, id);
      if (!existing) return res.status(404).json({ error: 'Plan not found' });

      await pool.query(
        `UPDATE vendor_channel_plans SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [id]
      );
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/admin/channel-subscriptions',
  authMiddleware,
  requireAdmin,
  [
    query('channel').isIn(VENDOR_CHANNELS),
    query('status').optional().trim(),
    query('q').optional().trim(),
    query('limit').optional().isInt({ min: 1, max: 200 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const channel = req.query.channel;
      const limit = Number(req.query.limit || 50);
      const offset = Number(req.query.offset || 0);
      const params = [channel];
      let where = 'WHERE s.channel = $1';
      let idx = 2;

      if (req.query.status) {
        where += ` AND s.status = $${idx}`;
        params.push(req.query.status);
        idx += 1;
      }
      if (req.query.q) {
        where += ` AND LOWER(vo.legal_name) LIKE LOWER($${idx})`;
        params.push(`%${req.query.q}%`);
        idx += 1;
      }

      params.push(limit, offset);
      const { rows } = await pool.query(
        `SELECT s.*, vo.legal_name AS vendor_org_name
         FROM vendor_channel_subscriptions s
         JOIN vendor_organizations vo ON vo.id = s.vendor_org_id
         ${where}
         ORDER BY s.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        params
      );

      res.json(rows);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
