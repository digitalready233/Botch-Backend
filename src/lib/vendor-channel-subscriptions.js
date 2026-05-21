import { v4 as uuidv4 } from 'uuid';
import pool from '../db/index.js';

export const VENDOR_CHANNELS = ['properties', 'rentals'];
export const ACTIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing'];
const DEFAULT_CURRENCY = (process.env.VENDOR_BILLING_CURRENCY || 'USD').toUpperCase();

const DEFAULT_PLAN_SEEDS = [
  { duration_months: 1, name: 'Monthly', amount: 49, compare_at_amount: null, discount_percent: null, perks: [] },
  {
    duration_months: 12,
    name: 'Annual',
    amount: 499,
    compare_at_amount: 588,
    discount_percent: 15,
    perks: ['Priority listing review', 'Featured placement eligibility'],
  },
  {
    duration_months: 24,
    name: '2-year',
    amount: 899,
    compare_at_amount: 1176,
    discount_percent: 24,
    perks: ['Priority listing review', 'Featured placement eligibility', 'Dedicated support'],
  },
  {
    duration_months: 36,
    name: '3-year Pro',
    amount: 1199,
    compare_at_amount: 1764,
    discount_percent: 32,
    perks: ['Priority listing review', 'Featured placement eligibility', 'Dedicated support', 'Profile badge'],
  },
];

export function computePeriodEndIso(startDate, durationMonths) {
  const end = new Date(startDate.getTime());
  end.setMonth(end.getMonth() + Number(durationMonths || 1));
  return end.toISOString();
}

export function parsePerks(perks) {
  if (Array.isArray(perks)) return perks.filter((p) => typeof p === 'string' && p.trim());
  if (typeof perks === 'string') {
    try {
      const parsed = JSON.parse(perks);
      return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string' && p.trim()) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function serializePlanRow(row) {
  if (!row) return null;
  return {
    ...row,
    perks: parsePerks(row.perks),
    amount: row.amount != null ? Number(row.amount) : null,
    compare_at_amount: row.compare_at_amount != null ? Number(row.compare_at_amount) : null,
    discount_percent: row.discount_percent != null ? Number(row.discount_percent) : null,
    is_active: row.is_active === true || row.is_active === 1,
  };
}

function isSubscriptionRowActive(row) {
  if (!row) return false;
  const status = String(row.status || '');
  if (!ACTIVE_SUBSCRIPTION_STATUSES.includes(status)) return false;
  if (row.current_period_end && new Date(row.current_period_end) < new Date()) return false;
  return true;
}

export async function seedDefaultChannelPlansIfEmpty(queryable = pool) {
  for (const channel of VENDOR_CHANNELS) {
    const { rows } = await queryable.query(
      'SELECT id FROM vendor_channel_plans WHERE channel = $1 LIMIT 1',
      [channel]
    );
    if (rows.length) continue;
    let sort = 0;
    for (const seed of DEFAULT_PLAN_SEEDS) {
      const perksJson = JSON.stringify(seed.perks || []);
      await queryable.query(
        `INSERT INTO vendor_channel_plans
          (id, channel, name, duration_months, amount, currency, compare_at_amount, discount_percent, perks, sort_order, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          uuidv4(),
          channel,
          seed.name,
          seed.duration_months,
          seed.amount,
          DEFAULT_CURRENCY,
          seed.compare_at_amount,
          seed.discount_percent,
          perksJson,
          sort,
        ]
      );
      sort += 1;
    }
  }
}

export async function listActivePlans(queryable, channel) {
  const { rows } = await queryable.query(
    `SELECT * FROM vendor_channel_plans
     WHERE channel = $1 AND (is_active = TRUE OR is_active = 1)
     ORDER BY sort_order ASC, duration_months ASC`,
    [channel]
  );
  return rows.map(serializePlanRow);
}

export async function listAllPlans(queryable, channel) {
  const { rows } = await queryable.query(
    `SELECT * FROM vendor_channel_plans
     WHERE channel = $1
     ORDER BY sort_order ASC, duration_months ASC`,
    [channel]
  );
  return rows.map(serializePlanRow);
}

export async function getPlanById(queryable, planId) {
  const { rows } = await queryable.query('SELECT * FROM vendor_channel_plans WHERE id = $1', [planId]);
  return rows[0] ? serializePlanRow(rows[0]) : null;
}

export async function getActiveChannelSubscription(queryable, vendorOrgId, channel) {
  const { rows } = await queryable.query(
    `SELECT * FROM vendor_channel_subscriptions
     WHERE vendor_org_id = $1 AND channel = $2
     ORDER BY
       CASE WHEN status IN ('active', 'trialing') THEN 0 ELSE 1 END,
       current_period_end DESC NULLS LAST,
       created_at DESC
     LIMIT 1`,
    [vendorOrgId, channel]
  );
  const row = rows[0] || null;
  return { subscription: row, active: isSubscriptionRowActive(row) };
}

export async function getChannelSubscriptionsForOrg(queryable, vendorOrgId) {
  const out = {};
  for (const channel of VENDOR_CHANNELS) {
    const { subscription, active } = await getActiveChannelSubscription(queryable, vendorOrgId, channel);
    out[channel] = {
      active,
      subscription: subscription
        ? {
            id: subscription.id,
            channel: subscription.channel,
            plan_id: subscription.plan_id,
            plan_name: subscription.plan_name,
            duration_months: subscription.duration_months,
            amount: subscription.amount != null ? Number(subscription.amount) : null,
            currency: subscription.currency,
            status: subscription.status,
            current_period_start: subscription.current_period_start,
            current_period_end: subscription.current_period_end,
          }
        : null,
    };
  }
  return out;
}

export async function assertVendorChannelSubscriptionActive(queryable, userId, channel) {
  const { rows: userRows } = await queryable.query(
    'SELECT id, role, vendor_org_id FROM users WHERE id = $1',
    [userId]
  );
  if (!userRows.length) {
    return { ok: false, status: 403, error: 'User not found', code: 'user_not_found' };
  }
  const user = userRows[0];
  if (user.role !== 'vendor') {
    return { ok: true };
  }
  if (!user.vendor_org_id) {
    return { ok: false, status: 403, error: 'Vendor organization required', code: 'no_vendor_org' };
  }

  const moduleCol =
    channel === 'properties'
      ? 'module_properties_enabled'
      : channel === 'rentals'
        ? 'module_rentals_enabled'
        : null;
  if (!moduleCol) {
    return { ok: false, status: 400, error: 'Invalid channel', code: 'invalid_channel' };
  }

  const { rows: orgRows } = await queryable.query(
    `SELECT id, ${moduleCol} AS module_enabled FROM vendor_organizations WHERE id = $1`,
    [user.vendor_org_id]
  );
  if (!orgRows.length) {
    return { ok: false, status: 403, error: 'Vendor organization not found', code: 'vendor_org_missing' };
  }
  const moduleOn =
    orgRows[0].module_enabled === true || orgRows[0].module_enabled === 1;
  if (!moduleOn) {
    return {
      ok: false,
      status: 403,
      error: 'This channel is turned off. Enable it under Billing.',
      code: 'CHANNEL_MODULE_DISABLED',
      channel,
    };
  }

  const { active } = await getActiveChannelSubscription(queryable, user.vendor_org_id, channel);
  if (!active) {
    return {
      ok: false,
      status: 403,
      error: `An active ${channel} posting subscription is required.`,
      code: 'CHANNEL_SUBSCRIPTION_REQUIRED',
      channel,
    };
  }
  return { ok: true };
}

export async function finalizeChannelSubscriptionPayment(queryable, paymentId, providerReference = null) {
  await queryable.query('BEGIN IMMEDIATE');
  try {
    const { rows: paymentRows } = await queryable.query(
      'SELECT * FROM vendor_billing_payments WHERE id = $1',
      [paymentId]
    );
    if (!paymentRows.length) throw new Error('Billing payment not found');
    const payment = paymentRows[0];
    const updateRes = await queryable.query(
      `UPDATE vendor_billing_payments
       SET status = 'completed',
           provider_reference = COALESCE($2, provider_reference),
           paid_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status <> 'completed'`,
      [paymentId, providerReference]
    );
    const justCompleted = updateRes.rowCount > 0;
    if (justCompleted && payment.payment_type === 'channel_subscription') {
      const { rows: subRows } = await queryable.query(
        'SELECT * FROM vendor_channel_subscriptions WHERE id = $1',
        [payment.target_id]
      );
      if (!subRows.length) throw new Error('Channel subscription not found');
      const sub = subRows[0];
      const start = new Date();
      const periodEnd = computePeriodEndIso(start, sub.duration_months);
      await queryable.query(
        `UPDATE vendor_channel_subscriptions
         SET status = 'active',
             provider_reference = COALESCE($2, provider_reference),
             current_period_start = $3,
             current_period_end = $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [sub.id, providerReference, start.toISOString(), periodEnd]
      );
      await queryable.query(
        `UPDATE vendor_channel_subscriptions
         SET status = 'expired', updated_at = CURRENT_TIMESTAMP
         WHERE vendor_org_id = $1 AND channel = $2 AND id <> $3 AND status IN ('active', 'trialing')`,
        [sub.vendor_org_id, sub.channel, sub.id]
      );
    }
    const { rows: refreshed } = await queryable.query(
      'SELECT * FROM vendor_billing_payments WHERE id = $1',
      [paymentId]
    );
    await queryable.query('COMMIT');
    return { payment: refreshed[0], justCompleted };
  } catch (err) {
    try {
      await queryable.query('ROLLBACK');
    } catch (_) {}
    throw err;
  }
}
