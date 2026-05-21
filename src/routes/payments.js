import express from 'express';
import pool from '../db/index.js';
import { createNotificationForUser } from '../lib/notifications.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { body, param, validationResult, query } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import { ensureReceiptForPayment } from '../lib/receipt-pdf.js';
import { logAudit } from '../lib/audit.js';
import { assertVendorOrgModuleEnabled } from '../lib/vendor-org-modules.js';
import { isSqliteDatabase } from '../lib/db-dialect.js';
import { isCustomerRole } from '../lib/roles.js';
import {
  VENDOR_FEATURED_CHANNELS,
  getFeaturedPlanById,
  legacyPlanSlugFromDays,
  listActiveFeaturedPlans,
  listAllFeaturedPlans,
  parsePerks,
  resolveFeaturedChannel,
  seedDefaultFeaturedPlansIfEmpty,
} from '../lib/vendor-featured-plans.js';
import Stripe from 'stripe';

const router = express.Router();
const DEFAULT_FEATURED_CURRENCY = (process.env.VENDOR_BILLING_CURRENCY || 'USD').toUpperCase();

/** Allowed post-checkout paths for featured payments (agent filesystem routes and public /vendor URLs). */
const ALLOWED_FEATURED_SUCCESS_PATHS = new Set([
  '/agent/vendor-listings',
  '/vendor/marketplace/workspace/my-post',
  '/agent/properties/workspace/my-properties',
  '/vendor/properties/workspace/my-properties',
  '/agent/rentals/workspace/my-rentals',
  '/vendor/rentals/workspace/my-rentals',
]);

function getStripeSecret() {
  const raw = (process.env.STRIPE_SECRET_KEY || '').trim();
  return raw.replace(/\s+/g, '');
}

function getBankDetails() {
  return {
    bankName: process.env.BANK_NAME || 'Bank Name',
    accountNumber: process.env.BANK_ACCOUNT_NUMBER || '',
    accountName: process.env.BANK_ACCOUNT_NAME || 'Botch Realty',
    sortCode: process.env.BANK_SORT_CODE || '',
    reference: process.env.BANK_REFERENCE_PREFIX || 'BOTCH',
  };
}

function getPaystackSecret() {
  const raw = process.env.PAYSTACK_SECRET_KEY || '';
  return raw.replace(/\s+/g, '').trim();
}

async function fetchWithRetry(url, options, { maxRetries = 3, timeoutMs = 15000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const opts = { ...options, signal: controller.signal };
    try {
      const res = await fetch(url, opts);
      clearTimeout(timeoutId);
      return res;
    } catch (err) {
      clearTimeout(timeoutId);
      lastErr = err;
      const isRetryable = err.cause?.code === 'ECONNRESET' || err.cause?.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.name === 'AbortError';
      if (!isRetryable || attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastErr;
}
function getFrontendUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').trim();
}

function toMinorUnits(amount) {
  return Math.round(Number(amount || 0) * 100);
}

async function finalizeInvoicePaymentAtomic({
  paymentId,
  transactionId = null,
  receiptUrl = null,
}) {
  await pool.query('BEGIN IMMEDIATE');
  try {
    const { rows: payRows } = await pool.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
    if (!payRows.length) {
      throw new Error('Payment not found');
    }
    const current = payRows[0];
    const updateRes = await pool.query(
      `UPDATE payments
       SET status = 'completed',
           transaction_id = COALESCE($2, transaction_id),
           receipt_url = COALESCE($3, receipt_url)
       WHERE id = $1 AND status <> 'completed'`,
      [paymentId, transactionId, receiptUrl]
    );
    const transitionedNow = updateRes.rowCount > 0;
    if (transitionedNow) {
      const { rows: invRows } = await pool.query('SELECT * FROM invoices WHERE id = $1', [current.invoice_id]);
      if (!invRows.length) {
        throw new Error('Invoice not found');
      }
      const inv = invRows[0];
      await pool.query('UPDATE invoices SET status = $1 WHERE id = $2', ['paid', inv.id]);
      if (inv.project_id) {
        await pool.query(
          'UPDATE projects SET amount_paid = amount_paid + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [current.amount, inv.project_id]
        );
      }
      if (inv.milestone_id) {
        await pool.query('UPDATE milestones SET is_paid = 1 WHERE id = $1', [inv.milestone_id]);
      }
    }
    const { rows: updatedRows } = await pool.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
    await pool.query('COMMIT');
    return {
      payment: updatedRows[0],
      justCompleted: transitionedNow,
    };
  } catch (err) {
    try { await pool.query('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

async function finalizeHousePlanPurchaseAtomic({ purchaseId, providerReference = null }) {
  await pool.query('BEGIN IMMEDIATE');
  try {
    const { rows: purchaseRows } = await pool.query('SELECT * FROM house_plan_purchases WHERE id = $1', [purchaseId]);
    if (!purchaseRows.length) {
      throw new Error('House plan purchase not found');
    }
    const updateRes = await pool.query(
      `UPDATE house_plan_purchases
       SET status = 'paid',
           provider_reference = COALESCE($2, provider_reference),
           paid_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status <> 'paid'`,
      [purchaseId, providerReference]
    );
    const { rows: updatedRows } = await pool.query('SELECT * FROM house_plan_purchases WHERE id = $1', [purchaseId]);
    await pool.query('COMMIT');
    return {
      purchase: updatedRows[0],
      justCompleted: updateRes.rowCount > 0,
    };
  } catch (err) {
    try { await pool.query('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

async function finalizeFeaturedListingPaymentAtomic({ featuredPaymentId, providerReference = null }) {
  await pool.query('BEGIN IMMEDIATE');
  try {
    const { rows: payRows } = await pool.query('SELECT * FROM featured_listing_payments WHERE id = $1', [featuredPaymentId]);
    if (!payRows.length) {
      throw new Error('Featured payment not found');
    }
    const payment = payRows[0];
    const updateRes = await pool.query(
      `UPDATE featured_listing_payments
       SET status = 'completed',
           provider_reference = COALESCE($2, provider_reference),
           paid_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status <> 'completed'`,
      [featuredPaymentId, providerReference]
    );
    const justCompleted = updateRes.rowCount > 0;
    if (justCompleted) {
      const propertyTargetId = payment.property_id || null;
      const listingTargetId = payment.listing_id || null;
      const durationDays =
        payment.duration_days != null
          ? Number(payment.duration_days)
          : null;
      const legacyPlan = payment.plan || (durationDays != null ? legacyPlanSlugFromDays(durationDays) : '7_days');
      if (propertyTargetId) {
        await pool.query(
          `UPDATE properties
           SET featured_status = 'pending',
               featured_plan = $2,
               featured_duration_days = $3,
               featured_requested_at = CURRENT_TIMESTAMP,
               featured_requested_by = $4,
               featured_price = $5,
               featured_currency = $6,
               featured_rejection_reason = NULL,
               featured_approved_at = NULL,
               featured_approved_by = NULL,
               featured_expires_at = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [
            propertyTargetId,
            legacyPlan,
            durationDays,
            payment.user_id,
            payment.amount,
            payment.currency || 'USD',
          ]
        );
      } else if (listingTargetId) {
        await pool.query(
          `UPDATE vendor_listings
           SET featured_status = 'pending',
               featured_plan = $2,
               featured_duration_days = $3,
               featured_requested_at = CURRENT_TIMESTAMP,
               featured_requested_by = $4,
               featured_price = $5,
               featured_currency = $6,
               featured_rejection_reason = NULL,
               featured_approved_at = NULL,
               featured_approved_by = NULL,
               featured_expires_at = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [
            listingTargetId,
            legacyPlan,
            durationDays,
            payment.user_id,
            payment.amount,
            payment.currency || 'USD',
          ]
        );
      }
    }
    const { rows: refreshedRows } = await pool.query('SELECT * FROM featured_listing_payments WHERE id = $1', [featuredPaymentId]);
    await pool.query('COMMIT');
    return {
      payment: refreshedRows[0],
      justCompleted,
    };
  } catch (err) {
    try { await pool.query('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

import { finalizeChannelSubscriptionPayment } from '../lib/vendor-channel-subscriptions.js';

async function finalizeVendorBillingPaymentAtomic({ paymentId, providerReference = null }) {
  if (paymentId) {
    const { rows } = await pool.query('SELECT payment_type FROM vendor_billing_payments WHERE id = $1', [paymentId]);
    if (rows[0]?.payment_type === 'channel_subscription') {
      return finalizeChannelSubscriptionPayment(pool, paymentId, providerReference);
    }
  }
  return { payment: null, justCompleted: false };
}

/** GET /api/v1/payments/bank-details - bank transfer details for client (authenticated) */
router.get('/bank-details', authMiddleware, (req, res) => {
  res.json(getBankDetails());
});

/** POST /api/v1/payments/request-bank-transfer - client declares they will pay by bank transfer; creates pending payment and notifies admin */
router.post('/request-bank-transfer', authMiddleware, [
  body('invoice_id').isUUID(),
], async (req, res, next) => {
  try {
    if (!isCustomerRole(req.userRole)) return res.status(403).json({ error: 'Only buyers and project clients can request bank transfer' });
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { invoice_id } = req.body;
    const { rows: invRows } = await pool.query('SELECT * FROM invoices WHERE id = $1', [invoice_id]);
    if (invRows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    const inv = invRows[0];
    if (inv.client_id !== req.userId) return res.status(403).json({ error: "You don't have permission to do that." });
    if (inv.status === 'paid') return res.status(400).json({ error: 'Invoice already paid' });
    const paymentId = uuidv4();
    const currency = (inv.currency || 'USD').toUpperCase();
    await pool.query(
      `INSERT INTO payments (id, invoice_id, client_id, amount, currency, payment_method, transaction_id, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [paymentId, inv.id, req.userId, inv.amount, currency, 'bank_transfer', `bank-${paymentId}`, 'pending']
    );
    await createNotificationForUser(inv.client_id, 'payment_pending', 'Bank transfer initiated', `Payment of ${currency} ${inv.amount} for invoice ${inv.invoice_number} is pending. You will be notified when we confirm receipt.`);
    const { rows: adminRows } = await pool.query(
      "SELECT id FROM users WHERE role IN ('admin', 'super_admin')"
    );
    const bankTitle = 'Bank transfer pending';
    const bankMessage = `Client requested bank transfer for invoice ${inv.invoice_number}. Amount: ${currency} ${inv.amount}. Mark as paid when received.`;
    for (const admin of adminRows) {
      await createNotificationForUser(admin.id, 'bank_transfer_requested', bankTitle, bankMessage);
    }
    const io = req.app?.get?.('io');
    if (io) for (const admin of adminRows) io.to(`user:${admin.id}`).emit('notification:new', { type: 'bank_transfer_requested', title: bankTitle, message: bankMessage });
    const { rows } = await pool.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
    res.status(201).json({ payment: rows[0], message: 'Bank transfer recorded. We will confirm when payment is received.' });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/payments/initialize - start Paystack or Stripe checkout (client only) */
router.post('/initialize', authMiddleware, [
  body('invoice_id').isUUID(),
  body('return_origin').optional().isString().trim(),
  body('payment_method').optional().isIn(['paystack', 'stripe']),
], async (req, res, next) => {
  try {
    if (!isCustomerRole(req.userRole)) {
      return res.status(403).json({ error: 'Only buyers and project clients can pay invoices' });
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const paymentMethod = (req.body.payment_method || 'paystack').toLowerCase();
    const { invoice_id } = req.body;
    const { rows: invRows } = await pool.query('SELECT * FROM invoices WHERE id = $1', [invoice_id]);
    if (invRows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    const inv = invRows[0];
    if (inv.client_id !== req.userId) return res.status(403).json({ error: "You don't have permission to do that." });
    if (inv.status === 'paid') return res.status(400).json({ error: 'Invoice already paid' });

    const { rows: userRows } = await pool.query('SELECT email, full_name FROM users WHERE id = $1', [req.userId]);
    const email = userRows[0]?.email || req.body.email;
    if (!email) return res.status(400).json({ error: 'User email required for payment' });

    const currency = (inv.currency || 'USD').toUpperCase();
    const amountInMajor = Number(inv.amount);
    const paymentId = uuidv4();
    const baseUrl = (req.body.return_origin && /^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?$/.test(req.body.return_origin))
      ? req.body.return_origin.replace(/\/+$/, '')
      : getFrontendUrl();

    if (paymentMethod === 'stripe') {
      const STRIPE_SECRET = getStripeSecret();
      if (!STRIPE_SECRET || STRIPE_SECRET.startsWith('pk_')) {
        return res.status(503).json({ error: 'Stripe is not configured. Set STRIPE_SECRET_KEY (sk_...) in backend .env' });
      }
      const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2024-11-20.acacia' });
      await pool.query(
        `INSERT INTO payments (id, invoice_id, client_id, amount, currency, payment_method, transaction_id, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [paymentId, inv.id, req.userId, inv.amount, currency, 'stripe', paymentId, 'pending']
      );
      const successUrl = `${baseUrl}/dashboard/payment/return?reference=${encodeURIComponent(paymentId)}&stripe=1`;
      const cancelUrl = `${baseUrl}/dashboard/invoices`;
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: currency.toLowerCase() === 'ghs' ? 'ghs' : 'usd',
            product_data: {
              name: `Invoice ${inv.invoice_number}`,
              description: inv.project_id ? `Project invoice` : undefined,
            },
            unit_amount: Math.round(amountInMajor * 100),
          },
          quantity: 1,
        }],
        mode: 'payment',
        success_url: successUrl,
        cancel_url: cancelUrl,
        customer_email: email,
        client_reference_id: paymentId,
        metadata: { payment_id: paymentId, invoice_id: inv.id },
      });
      return res.json({ authorization_url: session.url, reference: paymentId });
    }

    const PAYSTACK_SECRET = getPaystackSecret();
    if (!PAYSTACK_SECRET) {
      return res.status(503).json({ error: 'Paystack is not configured. Set PAYSTACK_SECRET_KEY in backend .env' });
    }
    if (PAYSTACK_SECRET.startsWith('pk_')) {
      return res.status(503).json({
        error: 'Use your Paystack SECRET key (sk_test_...), not the Public key (pk_test_...). Get it from Dashboard → Settings → API Keys.',
      });
    }

    // Ghana Paystack = GHS only. Nigeria/Kenya may support USD. If merchant rejects currency, fallback to GHS with conversion.
    const allowedPaystack = (process.env.PAYSTACK_CURRENCIES || 'GHS,USD').toUpperCase().split(',').map((c) => c.trim()).filter(Boolean);
    if (allowedPaystack.length > 0 && !allowedPaystack.includes(currency)) {
      return res.status(400).json({
        error: `Paystack does not support ${currency} for this merchant. Supported: ${allowedPaystack.join(', ')}. Use Stripe or bank transfer for other currencies.`,
      });
    }

    await pool.query(
      `INSERT INTO payments (id, invoice_id, client_id, amount, currency, payment_method, transaction_id, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [paymentId, inv.id, req.userId, inv.amount, currency, 'paystack', paymentId, 'pending']
    );

    const callbackUrl = `${baseUrl}/dashboard/payment/return?reference=${encodeURIComponent(paymentId)}`;

    async function tryPaystackInitialize(payCurrency, payAmountMinor) {
      const res = await fetchWithRetry('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + PAYSTACK_SECRET,
        },
        body: JSON.stringify({
          email,
          amount: String(payAmountMinor),
          currency: payCurrency,
          reference: paymentId,
          callback_url: callbackUrl,
          metadata: {
            invoice_id: inv.id,
            payment_id: paymentId,
            invoice_currency: currency,
            invoice_amount: String(amountInMajor),
          },
        }),
      });
      return { response: res, data: await res.json() };
    }

    let result = await tryPaystackInitialize(currency, Math.round(amountInMajor * 100));

    // Ghana merchants support GHS only. If "Currency not supported", retry in GHS with conversion.
    const usdToGhs = parseFloat(process.env.PAYSTACK_USD_TO_GHS || '15', 10) || 15;
    if ((!result.data.status || !result.data.data?.authorization_url) && result.response.status === 403) {
      const msg = (result.data.message || '').toLowerCase();
      if (msg.includes('currency not supported') && currency !== 'GHS') {
        const amountGhs = amountInMajor * usdToGhs;
        const amountGhsMinor = Math.round(amountGhs * 100); // pesewas
        if (amountGhsMinor > 0) {
          result = await tryPaystackInitialize('GHS', amountGhsMinor);
        }
      }
    }

    const data = result.data;
    const response = result.response;
    if (!data.status || !data.data?.authorization_url) {
      await pool.query("UPDATE payments SET status = 'failed' WHERE id = $1", [paymentId]);
      const msg = data.message || 'Paystack could not create checkout';
      const detail = data.data?.message ? ' (' + (data.data.message || '') + ')' : '';
      console.error('Paystack initialize failed:', {
        httpStatus: response.status,
        message: msg,
        keyLength: PAYSTACK_SECRET.length,
        keyStartsWith: PAYSTACK_SECRET.substring(0, 10),
      });
      // 401 Invalid key = wrong/expired/revoked secret key in .env
      if (response.status === 401 && (msg === 'Invalid key' || String(msg).toLowerCase().includes('invalid key'))) {
        return res.status(502).json({
          error: 'Paystack secret key is invalid. Update PAYSTACK_SECRET_KEY in backend .env with the Secret Key from Paystack Dashboard → Settings → API Keys. Use sk_test_... for testing, sk_live_... for production.',
        });
      }
      return res.status(502).json({ error: msg + detail });
    }

    res.json({ authorization_url: data.data.authorization_url, reference: data.data.reference });
  } catch (err) {
    console.error('Payments initialize error:', err);
    const isNetwork = err.cause?.code === 'ECONNRESET' || err.cause?.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
    if (isNetwork) {
      try {
        await pool.query("UPDATE payments SET status = 'failed' WHERE id = $1", [paymentId]);
      } catch (_) {}
      return res.status(503).json({ error: 'Payment service temporarily unavailable. Please try again in a moment.' });
    }
    next(err);
  }
});

/** GET /api/v1/payments/verify?reference= - verify Paystack payment or return Stripe payment status (client only) */
router.get('/verify', authMiddleware, query('reference').notEmpty(), async (req, res, next) => {
  try {
    if (!isCustomerRole(req.userRole)) {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }
    const reference = req.query.reference;
    const isStripeReturn = req.query.stripe === '1' || req.query.stripe === 'true';
    const { rows: payRows } = await pool.query(
      'SELECT * FROM payments WHERE id = $1 AND client_id = $2',
      [reference, req.userId]
    );
    if (payRows.length === 0) return res.status(404).json({ error: 'Payment not found' });
    const payment = payRows[0];
    if (payment.status === 'completed') {
      return res.json({ ok: true, message: 'Already completed', payment });
    }
    if (payment.payment_method === 'stripe' || isStripeReturn) {
      const { rows } = await pool.query('SELECT * FROM payments WHERE id = $1', [reference]);
      const p = rows[0];
      return res.json({ ok: p && p.status === 'completed', message: p && p.status === 'completed' ? 'Payment successful' : 'Payment is being processed', payment: p || payment });
    }

    const PAYSTACK_SECRET = getPaystackSecret();
    if (!PAYSTACK_SECRET) {
      return res.status(503).json({ error: 'Paystack is not configured' });
    }

    const response = await fetchWithRetry(
      'https://api.paystack.co/transaction/verify/' + encodeURIComponent(reference),
      {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + PAYSTACK_SECRET },
      }
    );
    const data = await response.json();
    if (!data.status || data.data?.status !== 'success') {
      await pool.query("UPDATE payments SET status = 'failed' WHERE id = $1", [reference]);
      return res.json({ ok: false, message: data.message || 'Payment not successful', payment: payRows[0] });
    }
    const payload = data?.data || {};
    const metadata = payload?.metadata || {};
    const verifiedPaymentId = String(metadata?.payment_id || payload?.reference || '').trim();
    const verifiedInvoiceId = String(metadata?.invoice_id || '').trim();
    const verifiedCurrency = String(payload?.currency || '').toUpperCase();
    const verifiedAmountMinor = Number(payload?.amount ?? Number.NaN);
    const expectedCurrency = String(payment.currency || 'USD').toUpperCase();
    const expectedAmountMinor = toMinorUnits(payment.amount);
    const isPaymentMatch = verifiedPaymentId === String(payment.id);
    const isInvoiceMatch = !verifiedInvoiceId || verifiedInvoiceId === String(payment.invoice_id);
    const isAmountMatch = Number.isFinite(verifiedAmountMinor) && verifiedAmountMinor === expectedAmountMinor;
    const isCurrencyMatch = !verifiedCurrency || verifiedCurrency === expectedCurrency;
    if (!isPaymentMatch || !isInvoiceMatch || !isAmountMatch || !isCurrencyMatch) {
      await pool.query("UPDATE payments SET status = 'failed' WHERE id = $1", [reference]);
      return res.status(400).json({
        ok: false,
        error: 'Payment verification mismatch',
        message: 'Verified transaction does not match expected invoice payment details.',
      });
    }

    const inv = (await pool.query('SELECT * FROM invoices WHERE id = $1', [payment.invoice_id])).rows[0];
    if (!inv) return res.status(500).json({ error: 'Invoice not found' });

    const { payment: finalized, justCompleted } = await finalizeInvoicePaymentAtomic({
      paymentId: reference,
      transactionId: data.data.reference || null,
      receiptUrl: data.data.receipt_url || null,
    });
    if (justCompleted) {
      ensureReceiptForPayment(reference).catch(() => {});
      const currency = (payment.currency || 'GHS').toUpperCase();
      await createNotificationForUser(payment.client_id, 'payment_received', 'Payment received', `Your payment of ${currency} ${payment.amount} has been confirmed.`);
      const { rows: adminRows } = await pool.query(
        "SELECT id FROM users WHERE role IN ('admin', 'super_admin')"
      );
      const payTitle = 'Payment received';
      const payMessage = `A client paid ${currency} ${payment.amount} for invoice ${inv.invoice_number}.`;
      for (const admin of adminRows) {
        await createNotificationForUser(admin.id, 'payment_made', payTitle, payMessage);
      }
      const io = req.app?.get?.('io');
      if (io) for (const admin of adminRows) io.to(`user:${admin.id}`).emit('notification:new', { type: 'payment_made', title: payTitle, message: payMessage });
    }
    res.json({ ok: true, message: 'Payment successful', payment: finalized });
  } catch (err) {
    next(err);
  }
});

/** Marketplace listing id or dev seed id (e.g. seed-vl-003). */
function bodyFeaturedListingId() {
  return body('listing_id')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ min: 1, max: 128 })
    .matches(/^[a-zA-Z0-9-]+$/)
    .withMessage('Invalid listing_id');
}

/** Property row id (sale or rental) including dev seed ids. */
function bodyFeaturedPropertyId() {
  return body('property_id')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ min: 1, max: 128 })
    .matches(/^[a-zA-Z0-9-]+$/)
    .withMessage('Invalid property_id');
}

/** GET /api/v1/payments/featured-plans?channel= — active boost plans for vendors */
router.get(
  '/featured-plans',
  authMiddleware,
  [query('channel').isIn(VENDOR_FEATURED_CHANNELS)],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      await seedDefaultFeaturedPlansIfEmpty(pool);
      const plans = await listActiveFeaturedPlans(pool, req.query.channel);
      res.json(plans);
    } catch (err) {
      next(err);
    }
  }
);

/** GET /api/v1/payments/featured-plans/admin?channel= */
router.get(
  '/featured-plans/admin',
  authMiddleware,
  requireAdmin,
  [query('channel').isIn(VENDOR_FEATURED_CHANNELS)],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      await seedDefaultFeaturedPlansIfEmpty(pool);
      const plans = await listAllFeaturedPlans(pool, req.query.channel);
      res.json(plans);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/featured-plans/admin',
  authMiddleware,
  requireAdmin,
  [
    body('channel').isIn(VENDOR_FEATURED_CHANNELS),
    body('name').trim().isLength({ min: 1, max: 120 }),
    body('duration_days').isInt({ min: 1, max: 365 }),
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
        duration_days,
        amount,
        currency = DEFAULT_FEATURED_CURRENCY,
        compare_at_amount = null,
        discount_percent = null,
        sort_order = 0,
        is_active = true,
      } = req.body;

      await pool.query(
        `INSERT INTO vendor_featured_plans
          (id, channel, name, duration_days, amount, currency, compare_at_amount, discount_percent, perks, sort_order, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          id,
          channel,
          name,
          duration_days,
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
        action: 'vendor_featured_plan_create',
        resourceType: 'vendor_featured_plan',
        resourceId: id,
        details: JSON.stringify({ channel, name, duration_days, amount }),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      const plan = await getFeaturedPlanById(pool, id);
      res.status(201).json(plan);
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/featured-plans/admin/:id',
  authMiddleware,
  requireAdmin,
  [
    param('id').notEmpty(),
    body('name').optional().trim().isLength({ min: 1, max: 120 }),
    body('duration_days').optional().isInt({ min: 1, max: 365 }),
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
      const existing = await getFeaturedPlanById(pool, id);
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
      if (req.body.duration_days !== undefined) setField('duration_days', req.body.duration_days);
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
      await pool.query(
        `UPDATE vendor_featured_plans SET ${fields.join(', ')} WHERE id = $${idx}`,
        params
      );

      const plan = await getFeaturedPlanById(pool, id);
      res.json(plan);
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  '/featured-plans/admin/:id',
  authMiddleware,
  requireAdmin,
  [param('id').notEmpty()],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { id } = req.params;
      const existing = await getFeaturedPlanById(pool, id);
      if (!existing) return res.status(404).json({ error: 'Plan not found' });

      await pool.query(
        `UPDATE vendor_featured_plans SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [id]
      );
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

/** POST /api/v1/payments/featured-listings/initialize - start checkout for featured placement (marketplace listing OR property/rental) */
router.post('/featured-listings/initialize', authMiddleware, [
  bodyFeaturedListingId(),
  bodyFeaturedPropertyId(),
  body('plan_id').notEmpty().trim(),
  body('payment_method').optional().isIn(['paystack', 'stripe']),
  body('return_origin').optional().isString().trim(),
  body('success_path').optional().isString().trim(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const paymentMethod = String(req.body.payment_method || 'paystack').toLowerCase();
    const listingId = req.body.listing_id ? String(req.body.listing_id).trim() : '';
    const propertyId = req.body.property_id ? String(req.body.property_id).trim() : '';
    const hasListing = Boolean(listingId);
    const hasProperty = Boolean(propertyId);
    if (hasListing === hasProperty) {
      return res.status(400).json({ error: 'Provide exactly one of listing_id or property_id' });
    }
    if (hasProperty && (await isSqliteDatabase())) {
      return res.status(503).json({
        error: 'Featured checkout for property and rental listings requires PostgreSQL in this deployment.',
      });
    }
    const planId = String(req.body.plan_id || '').trim();
    await seedDefaultFeaturedPlansIfEmpty(pool);
    const planRow = await getFeaturedPlanById(pool, planId);
    if (!planRow || !planRow.is_active) return res.status(404).json({ error: 'Featured plan not found' });

    let successPath = String(req.body.success_path || '').trim();
    if (successPath && !ALLOWED_FEATURED_SUCCESS_PATHS.has(successPath)) {
      return res.status(400).json({ error: 'Invalid success_path' });
    }

    const isAdmin = ['admin', 'super_admin'].includes(String(req.userRole || '').toLowerCase());

    let checkoutTitle = '';
    let listingIdVal = null;
    let propertyIdVal = null;

    let resolvedChannel = null;

    if (hasListing) {
      const { rows: listingRows } = await pool.query(
        'SELECT id, title, created_by, workflow_state FROM vendor_listings WHERE id = $1',
        [listingId]
      );
      if (!listingRows.length) return res.status(404).json({ error: 'Vendor listing not found' });
      const listing = listingRows[0];
      if (!isAdmin && String(listing.created_by || '') !== String(req.userId)) {
        return res.status(403).json({ error: "You don't have permission to do that." });
      }
      const ws = String(listing.workflow_state || '');
      if (ws !== 'published' && ws !== 'approved') {
        return res.status(400).json({ error: 'Only published or approved listings can be boosted' });
      }
      listingIdVal = listing.id;
      resolvedChannel = 'marketplace';
      checkoutTitle = `Featured listing: ${listing.title}`;
      if (!successPath) successPath = '/vendor/marketplace/workspace/my-post';
    } else {
      const { rows: propRows } = await pool.query(
        `SELECT id, title, created_by, listing_state, listing_purpose
         FROM properties WHERE id = $1`,
        [propertyId]
      );
      if (!propRows.length) return res.status(404).json({ error: 'Property listing not found' });
      const prop = propRows[0];
      if (!isAdmin && String(prop.created_by || '') !== String(req.userId)) {
        return res.status(403).json({ error: "You don't have permission to do that." });
      }
      const listingState = String(prop.listing_state || '');
      if (listingState !== 'published' && listingState !== 'approved') {
        return res.status(400).json({ error: 'Only published or approved property listings can be boosted' });
      }
      const purpose = String(prop.listing_purpose || 'sale');
      if (purpose !== 'sale' && purpose !== 'rent') {
        return res.status(400).json({ error: 'Invalid listing purpose for featured checkout' });
      }
      if (!isAdmin) {
        const modKey = purpose === 'rent' ? 'rentals' : 'properties';
        const mod = await assertVendorOrgModuleEnabled(pool, req.userId, modKey);
        if (!mod.ok) return res.status(403).json({ error: mod.error });
      }
      propertyIdVal = prop.id;
      resolvedChannel = resolveFeaturedChannel({ propertyRow: prop });
      const kind = purpose === 'rent' ? 'rental' : 'property';
      checkoutTitle = `Featured ${kind}: ${prop.title}`;
      if (!successPath) {
        successPath = purpose === 'rent'
          ? '/vendor/rentals/workspace/my-rentals'
          : '/vendor/properties/workspace/my-properties';
      }
    }

    if (!resolvedChannel || planRow.channel !== resolvedChannel) {
      return res.status(400).json({
        error: 'Plan channel mismatch',
        message: `This plan is for ${planRow.channel} listings only`,
      });
    }

    const { rows: userRows } = await pool.query('SELECT email FROM users WHERE id = $1', [req.userId]);
    const email = userRows[0]?.email || null;
    if (!email) return res.status(400).json({ error: 'User email required for payment' });

    const paymentId = uuidv4();
    const currency = String(planRow.currency || DEFAULT_FEATURED_CURRENCY).toUpperCase();
    const amountMajor = Number(planRow.amount);
    const durationDays = Number(planRow.duration_days);
    const legacyPlan = legacyPlanSlugFromDays(durationDays);
    const planName = planRow.name;
    const baseUrl = (req.body.return_origin && /^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?$/.test(req.body.return_origin))
      ? req.body.return_origin.replace(/\/+$/, '')
      : getFrontendUrl();

    await pool.query(
      `INSERT INTO featured_listing_payments
        (id, listing_id, property_id, user_id, plan, plan_id, plan_name, duration_days, amount, currency, payment_method, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        paymentId,
        listingIdVal,
        propertyIdVal,
        req.userId,
        legacyPlan,
        planId,
        planName,
        durationDays,
        amountMajor,
        currency,
        paymentMethod === 'stripe' ? 'stripe' : 'paystack',
      ]
    );

    const successQuery = `featuredPayment=1&reference=${encodeURIComponent(paymentId)}`;
    const stripeSuccessUrl = `${baseUrl}${successPath}?${successQuery}&stripe=1`;
    const stripeCancelUrl = `${baseUrl}${successPath}?featuredPayment=cancelled`;
    const paystackCallbackUrl = `${baseUrl}${successPath}?${successQuery}`;

    const stripeMeta = {
      type: 'featured_listing',
      featured_payment_id: paymentId,
      plan_id: planId,
      plan: legacyPlan,
      user_id: req.userId,
      ...(listingIdVal ? { listing_id: String(listingIdVal) } : {}),
      ...(propertyIdVal ? { property_id: String(propertyIdVal) } : {}),
    };

    if (paymentMethod === 'stripe') {
      const stripeKey = getStripeSecret();
      if (!stripeKey || stripeKey.startsWith('pk_')) {
        return res.status(503).json({ error: 'Stripe is not configured. Set STRIPE_SECRET_KEY (sk_...) in backend .env' });
      }
      const stripe = new Stripe(stripeKey, { apiVersion: '2024-11-20.acacia' });
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        success_url: stripeSuccessUrl,
        cancel_url: stripeCancelUrl,
        customer_email: email,
        client_reference_id: paymentId,
        metadata: stripeMeta,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(amountMajor * 100),
            product_data: {
              name: checkoutTitle,
              description: `${planName} (${durationDays} days)`,
            },
          },
        }],
      });
      return res.json({ authorization_url: session.url, reference: paymentId });
    }

    const PAYSTACK_SECRET = getPaystackSecret();
    if (!PAYSTACK_SECRET) return res.status(503).json({ error: 'Paystack is not configured. Set PAYSTACK_SECRET_KEY in backend .env' });
    const paystackRes = await fetchWithRetry('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
      },
      body: JSON.stringify({
        email,
        amount: String(Math.round(amountMajor * 100)),
        currency: 'USD',
        reference: paymentId,
        callback_url: paystackCallbackUrl,
        metadata: {
          ...stripeMeta,
          amount: String(amountMajor),
          currency: 'USD',
        },
      }),
    });
    const payload = await paystackRes.json();
    if (!payload?.status || !payload?.data?.authorization_url) {
      await pool.query("UPDATE featured_listing_payments SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [paymentId]);
      return res.status(502).json({ error: payload?.message || 'Paystack could not create checkout' });
    }
    await pool.query(
      'UPDATE featured_listing_payments SET provider_reference = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [paymentId, payload?.data?.reference || null]
    );
    return res.json({ authorization_url: payload.data.authorization_url, reference: paymentId });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/payments/featured-listings/verify?reference=... */
router.get('/featured-listings/verify', authMiddleware, [query('reference').notEmpty()], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const reference = String(req.query.reference || '').trim();
    const isStripe = req.query.stripe === '1' || req.query.stripe === 'true';
    const { rows } = await pool.query(
      'SELECT * FROM featured_listing_payments WHERE id = $1',
      [reference]
    );
    if (!rows.length) return res.status(404).json({ error: 'Featured payment not found' });
    const payment = rows[0];
    const isAdmin = ['admin', 'super_admin'].includes(String(req.userRole || '').toLowerCase());
    if (!isAdmin && String(payment.user_id || '') !== String(req.userId)) {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }
    if (payment.status === 'completed') {
      return res.json({ ok: true, message: 'Payment already completed', payment });
    }
    if (String(payment.payment_method || '') === 'stripe' || isStripe) {
      const { rows: refreshedRows } = await pool.query('SELECT * FROM featured_listing_payments WHERE id = $1', [reference]);
      const fresh = refreshedRows[0] || payment;
      return res.json({
        ok: fresh.status === 'completed',
        message: fresh.status === 'completed' ? 'Payment successful' : 'Payment is being processed',
        payment: fresh,
      });
    }

    const paystackKey = getPaystackSecret();
    if (!paystackKey) return res.status(503).json({ error: 'Paystack is not configured' });
    const verifyRes = await fetchWithRetry(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${paystackKey}` } }
    );
    const verifyPayload = await verifyRes.json();
    const tx = verifyPayload?.data || {};
    const amountMinor = Number(tx?.amount ?? Number.NaN);
    const currency = String(tx?.currency || '').toUpperCase();
    const metadata = tx?.metadata || {};
    const metaPaymentId = String(metadata?.featured_payment_id || tx?.reference || '').trim();
    const expectedAmountMinor = toMinorUnits(payment.amount);
    const expectedCurrency = String(payment.currency || 'USD').toUpperCase();
    const matches =
      verifyPayload?.status &&
      tx?.status === 'success' &&
      metaPaymentId === String(payment.id) &&
      Number.isFinite(amountMinor) &&
      amountMinor === expectedAmountMinor &&
      currency === expectedCurrency;

    if (!matches) {
      await pool.query(
        "UPDATE featured_listing_payments SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [payment.id]
      );
      return res.status(400).json({ ok: false, message: 'Payment verification mismatch' });
    }

    const finalized = await finalizeFeaturedListingPaymentAtomic({
      featuredPaymentId: payment.id,
      providerReference: tx?.reference || null,
    });
    return res.json({ ok: true, message: 'Payment successful', payment: finalized.payment });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/payments - list payments (client: own, admin: all) */
router.get('/', authMiddleware, query('project_id').optional(), query('status').optional(), query('client_id').optional(), async (req, res, next) => {
  try {
    if (req.userRole === 'admin' || req.userRole === 'super_admin') {
      let sql = `
        SELECT py.*, i.invoice_number, i.due_date AS invoice_due_date, p.name AS project_name, u.full_name AS client_name
        FROM payments py
        JOIN invoices i ON py.invoice_id = i.id
        JOIN projects p ON i.project_id = p.id
        JOIN users u ON py.client_id = u.id
        WHERE 1=1
      `;
      const params = [];
      if (req.query.project_id) { params.push(req.query.project_id); sql += ` AND p.id = $${params.length}`; }
      if (req.query.client_id) { params.push(req.query.client_id); sql += ` AND py.client_id = $${params.length}`; }
      const statusFilter = (req.query.status || '').toString().toLowerCase();
      if (statusFilter === 'paid' || statusFilter === 'completed') {
        sql += ` AND py.status = 'completed'`;
      } else if (statusFilter === 'overdue') {
        sql += ` AND py.status = 'pending' AND i.due_date IS NOT NULL AND i.due_date < date('now')`;
      } else if (statusFilter === 'pending') {
        sql += ` AND py.status = 'pending' AND (i.due_date IS NULL OR i.due_date >= date('now'))`;
      } else if (statusFilter === 'failed') {
        sql += ` AND py.status = 'failed'`;
      } else if (req.query.status) {
        params.push(req.query.status);
        sql += ` AND py.status = $${params.length}`;
      }
      sql += ' ORDER BY py.created_at DESC';
      const { rows } = await pool.query(sql, params);
      return res.json(rows);
    }
    if (!isCustomerRole(req.userRole)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    let sql = `
      SELECT py.*, i.invoice_number, p.name AS project_name
      FROM payments py
      JOIN invoices i ON py.invoice_id = i.id
      JOIN projects p ON i.project_id = p.id
      WHERE py.client_id = $1
    `;
    const params = [req.userId];
    if (req.query.project_id) { params.push(req.query.project_id); sql += ` AND p.id = $${params.length}`; }
    if (req.query.status) { params.push(req.query.status); sql += ` AND py.status = $${params.length}`; }
    sql += ' ORDER BY py.created_at DESC';
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/payments - record payment (admin) or initiate (client - stub for Stripe/Paystack) */
router.post('/', authMiddleware, [
  body('invoice_id').isUUID(),
  body('amount').isFloat({ min: 0 }),
  body('currency').optional().isLength({ max: 10 }),
  body('payment_method').optional().trim(),
  body('transaction_id').optional().trim(),
  body('status').optional().isIn(['pending', 'completed', 'failed']),
  body('receipt_url').optional().trim(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { rows: invRows } = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.body.invoice_id]);
    if (invRows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    const inv = invRows[0];
    if (isCustomerRole(req.userRole)) {
      if (String(req.body.status || '').toLowerCase() === 'completed') {
        return res.status(403).json({ error: 'Only admins can record completed invoice payments' });
      }
      if (inv.client_id !== req.userId) return res.status(403).json({ error: "You don't have permission to do that." });
      if (inv.status === 'paid') return res.status(400).json({ error: 'Invoice already paid' });
      if (Number(req.body.amount) !== Number(inv.amount)) {
        return res.status(400).json({ error: 'Amount must match invoice amount' });
      }
      if ((req.body.currency || inv.currency || 'USD').toUpperCase() !== (inv.currency || 'USD').toUpperCase()) {
        return res.status(400).json({ error: 'Currency must match invoice currency' });
      }
      const id = uuidv4();
      await pool.query(
        `INSERT INTO payments (id, invoice_id, client_id, amount, currency, payment_method, status) VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
        [id, inv.id, req.userId, req.body.amount, req.body.currency || 'USD', req.body.payment_method || 'card']
      );
      const { rows } = await pool.query('SELECT * FROM payments WHERE id = $1', [id]);
      return res.status(201).json({ payment: rows[0], message: 'Payment initiated. Integrate Stripe/Paystack for live charges.' });
    }
    if (req.userRole !== 'admin' && req.userRole !== 'super_admin') {
      return res.status(403).json({ error: 'Admin access required to record invoice payments' });
    }
    const id = uuidv4();
    const status = req.body.status || 'completed';
    await pool.query(
      `INSERT INTO payments (id, invoice_id, client_id, amount, currency, payment_method, transaction_id, status, receipt_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, inv.id, inv.client_id, req.body.amount, req.body.currency || 'USD', req.body.payment_method || null, req.body.transaction_id || null, status, req.body.receipt_url || null]
    );
    if (status === 'completed') {
      await finalizeInvoicePaymentAtomic({
        paymentId: id,
        transactionId: req.body.transaction_id || null,
        receiptUrl: req.body.receipt_url || null,
      });
      ensureReceiptForPayment(id).catch(() => {});
      const currency = (req.body.currency || 'USD').toUpperCase();
      await createNotificationForUser(inv.client_id, 'payment_received', 'Payment received', `Your payment of ${currency} ${req.body.amount} has been recorded.`);
      const { rows: adminRows } = await pool.query(
      "SELECT id FROM users WHERE role IN ('admin', 'super_admin')"
    );
      const payTitle = 'Payment received';
      const payMessage = `A client payment of ${currency} ${req.body.amount} for invoice ${inv.invoice_number} was recorded.`;
      for (const admin of adminRows) {
        await createNotificationForUser(admin.id, 'payment_made', payTitle, payMessage);
      }
      const io = req.app?.get?.('io');
      if (io) for (const admin of adminRows) io.to(`user:${admin.id}`).emit('notification:new', { type: 'payment_made', title: payTitle, message: payMessage });
    }
    logAudit({
      userId: req.userId,
      action: 'payment_record',
      resourceType: 'payment',
      resourceId: id,
      details: JSON.stringify({ invoice_id: inv.id, amount: req.body.amount, status }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    const { rows } = await pool.query('SELECT * FROM payments WHERE id = $1', [id]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/v1/payments/:id - admin update payment (e.g. set receipt_url after uploading receipt) */
router.patch('/:id', authMiddleware, requireAdmin, [
  body('receipt_url').optional().trim(),
  body('status').optional().isIn(['pending', 'completed', 'failed']),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { id } = req.params;
    const { rows: existing } = await pool.query('SELECT * FROM payments WHERE id = $1', [id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Payment not found' });
    const updates = {};
    if (req.body.receipt_url !== undefined) updates.receipt_url = req.body.receipt_url;
    if (req.body.status !== undefined) updates.status = req.body.status;
    if (Object.keys(updates).length === 0) return res.json(existing[0]);
    const setClause = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
    await pool.query(`UPDATE payments SET ${setClause} WHERE id = $1`, [id, ...Object.values(updates)]);
    logAudit({
      userId: req.userId,
      action: 'payment_update',
      resourceType: 'payment',
      resourceId: id,
      details: JSON.stringify(updates),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    const { rows } = await pool.query('SELECT * FROM payments WHERE id = $1', [id]);
    const updated = rows[0];
    if (existing[0].status !== 'completed' && updated.status === 'completed') {
      await finalizeInvoicePaymentAtomic({
        paymentId: id,
        transactionId: updated.transaction_id || null,
        receiptUrl: updated.receipt_url || null,
      });
      ensureReceiptForPayment(id).catch(() => {});
    }
    const { rows: freshRows } = await pool.query('SELECT * FROM payments WHERE id = $1', [id]);
    res.json(freshRows[0]);
  } catch (err) {
    next(err);
  }
});

/** Stripe webhook handler - must be mounted with express.raw({ type: 'application/json' }). Expects STRIPE_WEBHOOK_SECRET in env. */
export async function stripeWebhookHandler(req, res) {
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    return res.status(503).send('Stripe webhook secret not configured');
  }
  const sig = req.headers['stripe-signature'];
  if (!sig) {
    return res.status(400).send('Missing stripe-signature');
  }
  const body = req.body;
  if (!body || !Buffer.isBuffer(body)) {
    return res.status(400).send('Invalid body');
  }
  let event;
  try {
    const stripe = new Stripe(getStripeSecret(), { apiVersion: '2024-11-20.acacia' });
    event = stripe.webhooks.constructEvent(body, sig, secret);
  } catch (err) {
    console.error('[payments] Stripe webhook signature verification failed:', err.message);
    return res.status(400).send('Webhook signature verification failed');
  }
  if (event.type !== 'checkout.session.completed') {
    return res.json({ received: true });
  }
  const session = event.data.object;
  try {
    const paymentKind = session.metadata?.type || 'invoice';
    if (
      paymentKind === 'vendor_channel_subscription' ||
      session.metadata?.billing_payment_id
    ) {
      const billingPaymentId = session.metadata?.billing_payment_id || session.client_reference_id;
      if (!billingPaymentId) return res.status(400).send('Missing billing_payment_id in session metadata');
      const { rows: paymentRows } = await pool.query('SELECT * FROM vendor_billing_payments WHERE id = $1', [billingPaymentId]);
      if (!paymentRows.length) return res.status(404).send('Vendor billing payment not found');
      const billingPayment = paymentRows[0];
      if (billingPayment.status === 'completed') return res.json({ received: true });
      const stripePaymentId = String(session?.metadata?.billing_payment_id || session?.client_reference_id || '').trim();
      const stripeCurrency = String(session?.currency || '').toUpperCase();
      const stripeAmountMinor = Number(session?.amount_total ?? Number.NaN);
      const expectedAmountMinor = toMinorUnits(billingPayment.amount);
      const expectedCurrency = String(billingPayment.currency || 'USD').toUpperCase();
      const isMatch =
        session.payment_status === 'paid' &&
        stripePaymentId === String(billingPaymentId) &&
        Number.isFinite(stripeAmountMinor) &&
        stripeAmountMinor === expectedAmountMinor &&
        stripeCurrency === expectedCurrency;
      if (!isMatch) {
        await pool.query(
          "UPDATE vendor_billing_payments SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
          [billingPaymentId]
        );
        return res.status(400).send('Vendor billing payment verification mismatch');
      }
      const finalized = await finalizeVendorBillingPaymentAtomic({
        paymentId: billingPaymentId,
        providerReference: session.id || session.payment_intent || null,
      });
      if (finalized.justCompleted) {
        await createNotificationForUser(
          billingPayment.user_id,
          'vendor_billing_paid',
          'Channel subscription active',
          'Your channel posting subscription is now active.'
        );
      }
      return res.json({ received: true });
    }

    if (paymentKind === 'featured_listing' || session.metadata?.featured_payment_id) {
      const featuredPaymentId = session.metadata?.featured_payment_id || session.client_reference_id;
      if (!featuredPaymentId) return res.status(400).send('Missing featured_payment_id in session metadata');
      const { rows: featuredRows } = await pool.query('SELECT * FROM featured_listing_payments WHERE id = $1', [featuredPaymentId]);
      if (!featuredRows.length) return res.status(404).send('Featured payment not found');
      const featuredPayment = featuredRows[0];
      if (featuredPayment.status === 'completed') return res.json({ received: true });

      const expectedCurrency = String(featuredPayment.currency || 'USD').toLowerCase();
      const expectedAmountMinor = toMinorUnits(featuredPayment.amount);
      const stripePaymentId = String(session?.metadata?.featured_payment_id || session?.client_reference_id || '').trim();
      const stripeCurrency = String(session?.currency || '').toLowerCase();
      const stripeAmountMinor = Number(session?.amount_total ?? Number.NaN);
      const isPaymentMatch = stripePaymentId === String(featuredPaymentId);
      const isAmountMatch = Number.isFinite(stripeAmountMinor) && stripeAmountMinor === expectedAmountMinor;
      const isCurrencyMatch = stripeCurrency === expectedCurrency;

      if (!isPaymentMatch || !isAmountMatch || !isCurrencyMatch || session.payment_status !== 'paid') {
        await pool.query(
          "UPDATE featured_listing_payments SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
          [featuredPaymentId]
        );
        return res.status(400).send('Featured payment verification mismatch');
      }

      const { justCompleted } = await finalizeFeaturedListingPaymentAtomic({
        featuredPaymentId,
        providerReference: session.id || session.payment_intent || null,
      });
      if (justCompleted) {
        const isPropertyBoost = Boolean(featuredPayment.property_id);
        await createNotificationForUser(
          featuredPayment.user_id,
          'featured_listing_paid',
          isPropertyBoost ? 'Featured property request submitted' : 'Featured listing request submitted',
          isPropertyBoost
            ? 'Payment confirmed. Your featured property request is now pending admin approval.'
            : 'Payment confirmed. Your featured listing request is now pending admin approval.'
        );
      }
      return res.json({ received: true });
    }

    if (paymentKind === 'house_plan' || session.metadata?.purchase_id) {
      const purchaseId = session.metadata?.purchase_id || session.client_reference_id;
      if (!purchaseId) return res.status(400).send('Missing purchase_id in session metadata');
      const { rows: purchaseRows } = await pool.query('SELECT * FROM house_plan_purchases WHERE id = $1', [purchaseId]);
      if (!purchaseRows.length) return res.status(404).send('House plan purchase not found');
      const purchase = purchaseRows[0];
      if (purchase.status === 'paid') return res.json({ received: true });
      const expectedCurrency = String(purchase.currency || 'USD').toLowerCase();
      const expectedAmountMinor = toMinorUnits(purchase.amount);
      const stripePurchaseId = String(session?.metadata?.purchase_id || session?.client_reference_id || '').trim();
      const stripeCurrency = String(session?.currency || '').toLowerCase();
      const stripeAmountMinor = Number(session?.amount_total ?? Number.NaN);
      const isPurchaseMatch = stripePurchaseId === String(purchaseId);
      const isAmountMatch = Number.isFinite(stripeAmountMinor) && stripeAmountMinor === expectedAmountMinor;
      const isCurrencyMatch = stripeCurrency === expectedCurrency;
      if (!isPurchaseMatch || !isAmountMatch || !isCurrencyMatch || session.payment_status !== 'paid') {
        await pool.query(
          "UPDATE house_plan_purchases SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
          [purchaseId]
        );
        return res.status(400).send('House plan payment verification mismatch');
      }

      const { justCompleted } = await finalizeHousePlanPurchaseAtomic({
        purchaseId,
        providerReference: session.id || session.payment_intent || purchase.provider_reference || null,
      });
      if (justCompleted) {
        await createNotificationForUser(
          purchase.user_id,
          'house_plan_unlocked',
          'House plan unlocked',
          'Payment confirmed. You can now preview and download your architectural plan PDF.'
        );
        const { rows: adminRows } = await pool.query("SELECT id FROM users WHERE role IN ('admin', 'super_admin')");
        for (const admin of adminRows) {
          await createNotificationForUser(
            admin.id,
            'house_plan_purchase_paid',
            'House plan purchase',
            `A house plan purchase was completed. Purchase ID: ${purchaseId}.`
          );
        }
        const io = req.app?.get?.('io');
        if (io) {
          for (const admin of adminRows) {
            io.to(`user:${admin.id}`).emit('notification:new', {
              type: 'house_plan_purchase_paid',
              title: 'House plan purchase',
              message: `A house plan purchase was completed. Purchase ID: ${purchaseId}.`,
            });
          }
        }
      }
      return res.json({ received: true });
    }

    const paymentId = session.metadata?.payment_id || session.client_reference_id;
    if (!paymentId) {
      return res.status(400).send('Missing payment_id in session metadata');
    }
    const { rows: payRows } = await pool.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
    if (payRows.length === 0) return res.status(404).send('Payment not found');
    const payment = payRows[0];
    if (payment.status === 'completed') {
      return res.json({ received: true });
    }
    const expectedCurrency = String(payment.currency || 'USD').toLowerCase();
    const expectedAmountMinor = toMinorUnits(payment.amount);
    const stripePaymentId = String(session?.metadata?.payment_id || session?.client_reference_id || '').trim();
    const stripeInvoiceId = String(session?.metadata?.invoice_id || '').trim();
    const stripeCurrency = String(session?.currency || '').toLowerCase();
    const stripeAmountMinor = Number(session?.amount_total ?? Number.NaN);
    const isPaymentMatch = stripePaymentId === String(paymentId);
    const isInvoiceMatch = !stripeInvoiceId || stripeInvoiceId === String(payment.invoice_id);
    const isAmountMatch = Number.isFinite(stripeAmountMinor) && stripeAmountMinor === expectedAmountMinor;
    const isCurrencyMatch = stripeCurrency === expectedCurrency;
    if (!isPaymentMatch || !isInvoiceMatch || !isAmountMatch || !isCurrencyMatch || session.payment_status !== 'paid') {
      await pool.query("UPDATE payments SET status = 'failed' WHERE id = $1", [paymentId]);
      return res.status(400).send('Payment verification mismatch');
    }
    const inv = (await pool.query('SELECT * FROM invoices WHERE id = $1', [payment.invoice_id])).rows[0];
    if (!inv) return res.status(500).send('Invoice not found');

    const { justCompleted } = await finalizeInvoicePaymentAtomic({
      paymentId,
      transactionId: session.id || session.payment_intent || null,
      receiptUrl: null,
    });
    if (justCompleted) {
      ensureReceiptForPayment(paymentId).catch(() => {});
      const currency = (payment.currency || 'USD').toUpperCase();
      await createNotificationForUser(payment.client_id, 'payment_received', 'Payment received', `Your payment of ${currency} ${payment.amount} has been confirmed.`);
      const { rows: adminRows } = await pool.query(
        "SELECT id FROM users WHERE role IN ('admin', 'super_admin')"
      );
      const payTitle = 'Payment received';
      const payMessage = `A client paid ${currency} ${payment.amount} for invoice ${inv.invoice_number} (Stripe).`;
      for (const admin of adminRows) {
        await createNotificationForUser(admin.id, 'payment_made', payTitle, payMessage);
      }
      const io = req.app?.get?.('io');
      if (io) for (const admin of adminRows) io.to(`user:${admin.id}`).emit('notification:new', { type: 'payment_made', title: payTitle, message: payMessage });
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook error:', err);
    res.status(500).send('Webhook handler error');
  }
}

export default router;
