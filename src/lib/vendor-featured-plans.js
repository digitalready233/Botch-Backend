import { v4 as uuidv4 } from 'uuid';
import pool from '../db/index.js';

export const VENDOR_FEATURED_CHANNELS = ['properties', 'rentals', 'marketplace'];
const DEFAULT_CURRENCY = (process.env.VENDOR_BILLING_CURRENCY || 'USD').toUpperCase();

const LEGACY_PLAN_DAYS = {
  '3_days': 3,
  '7_days': 7,
  '14_days': 14,
};

const DEFAULT_FEATURED_SEEDS = [
  { duration_days: 3, name: '3-day boost', amount: 15, compare_at_amount: null, discount_percent: null, perks: [] },
  { duration_days: 7, name: '7-day boost', amount: 30, compare_at_amount: null, discount_percent: null, perks: [] },
  {
    duration_days: 14,
    name: '14-day boost',
    amount: 50,
    compare_at_amount: 60,
    discount_percent: 17,
    perks: ['Extended visibility'],
  },
];

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

export function serializeFeaturedPlanRow(row) {
  if (!row) return null;
  return {
    ...row,
    perks: parsePerks(row.perks),
    amount: row.amount != null ? Number(row.amount) : null,
    compare_at_amount: row.compare_at_amount != null ? Number(row.compare_at_amount) : null,
    discount_percent: row.discount_percent != null ? Number(row.discount_percent) : null,
    duration_days: row.duration_days != null ? Number(row.duration_days) : null,
    is_active: row.is_active === true || row.is_active === 1,
  };
}

export function legacyPlanSlugFromDays(days) {
  const n = Number(days);
  if (n === 3) return '3_days';
  if (n === 7) return '7_days';
  if (n === 14) return '14_days';
  return `${n}_days`;
}

export function durationDaysFromLegacyPlan(planSlug) {
  if (!planSlug) return 7;
  const key = String(planSlug).trim();
  if (LEGACY_PLAN_DAYS[key] != null) return LEGACY_PLAN_DAYS[key];
  const match = /^(\d+)_days$/.exec(key);
  if (match) return Number(match[1]) || 7;
  return 7;
}

export function resolveFeaturedChannel({ listingId, propertyRow }) {
  if (listingId) return 'marketplace';
  if (propertyRow) {
    const purpose = String(propertyRow.listing_purpose || 'sale');
    return purpose === 'rent' ? 'rentals' : 'properties';
  }
  return null;
}

export async function seedDefaultFeaturedPlansIfEmpty(queryable = pool) {
  for (const channel of VENDOR_FEATURED_CHANNELS) {
    const { rows } = await queryable.query(
      'SELECT id FROM vendor_featured_plans WHERE channel = $1 LIMIT 1',
      [channel]
    );
    if (rows.length) continue;
    let sort = 0;
    for (const seed of DEFAULT_FEATURED_SEEDS) {
      const perksJson = JSON.stringify(seed.perks || []);
      await queryable.query(
        `INSERT INTO vendor_featured_plans
          (id, channel, name, duration_days, amount, currency, compare_at_amount, discount_percent, perks, sort_order, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          uuidv4(),
          channel,
          seed.name,
          seed.duration_days,
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

export async function listActiveFeaturedPlans(queryable, channel) {
  const { rows } = await queryable.query(
    `SELECT * FROM vendor_featured_plans
     WHERE channel = $1 AND (is_active = TRUE OR is_active = 1)
     ORDER BY sort_order ASC, duration_days ASC`,
    [channel]
  );
  return rows.map(serializeFeaturedPlanRow);
}

export async function listAllFeaturedPlans(queryable, channel) {
  const { rows } = await queryable.query(
    `SELECT * FROM vendor_featured_plans
     WHERE channel = $1
     ORDER BY sort_order ASC, duration_days ASC`,
    [channel]
  );
  return rows.map(serializeFeaturedPlanRow);
}

export async function getFeaturedPlanById(queryable, planId) {
  const { rows } = await queryable.query('SELECT * FROM vendor_featured_plans WHERE id = $1', [planId]);
  return serializeFeaturedPlanRow(rows[0]);
}

export function resolveFeaturedDurationDays(listingOrPayment) {
  if (!listingOrPayment) return 7;
  if (listingOrPayment.featured_duration_days != null) {
    return Number(listingOrPayment.featured_duration_days) || 7;
  }
  if (listingOrPayment.duration_days != null) {
    return Number(listingOrPayment.duration_days) || 7;
  }
  return durationDaysFromLegacyPlan(listingOrPayment.featured_plan || listingOrPayment.plan);
}
