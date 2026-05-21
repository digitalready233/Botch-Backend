import { v4 as uuidv4 } from 'uuid';
import pool from '../db/index.js';
import { publicPropertyFilterSql } from './listing-state.js';
import { sendMail } from './email.js';

function toCleanString(value, max = 255) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

function normalizeAmenities(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return raw
    .map((a) => String(a).trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeSavedSearchFilters(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  const q = toCleanString(src.q, 200);
  const location = toCleanString(src.location, 200);
  const area = toCleanString(src.area, 200);
  const propertyType = toCleanString(src.property_type, 50).toLowerCase();
  const listingPurpose = toCleanString(src.listing_purpose, 20).toLowerCase();
  const minPrice = Number.parseFloat(String(src.min_price ?? ''));
  const maxPrice = Number.parseFloat(String(src.max_price ?? ''));
  const bedrooms = Number.parseInt(String(src.bedrooms ?? ''), 10);
  const amenities = normalizeAmenities(src.amenities);

  if (q) out.q = q;
  if (location) out.location = location;
  if (area) out.area = area;
  if (!Number.isNaN(minPrice) && minPrice >= 0) out.min_price = minPrice;
  if (!Number.isNaN(maxPrice) && maxPrice >= 0) out.max_price = maxPrice;
  if (propertyType) out.property_type = propertyType;
  if (!Number.isNaN(bedrooms) && bedrooms >= 0) out.bedrooms = bedrooms;
  if (amenities.length > 0) out.amenities = amenities;
  if (listingPurpose === 'sale' || listingPurpose === 'rent') out.listing_purpose = listingPurpose;
  return out;
}

function buildPropertySearchSql(rawInput, { limit } = {}) {
  const input = normalizeSavedSearchFilters(rawInput);
  const pub = publicPropertyFilterSql('');
  let sql = `SELECT id, title, created_at FROM properties WHERE ${pub}`;
  const params = [];
  let paramIndex = 1;

  if (input.listing_purpose) {
    sql += ` AND listing_purpose = $${paramIndex}`;
    params.push(input.listing_purpose);
    paramIndex++;
  } else {
    sql += ` AND COALESCE(listing_purpose, 'sale') = 'sale'`;
  }

  if (input.q) {
    const term = `%${input.q}%`;
    sql += ` AND (title LIKE $${paramIndex} OR description LIKE $${paramIndex} OR location LIKE $${paramIndex} OR area LIKE $${paramIndex})`;
    params.push(term);
    paramIndex++;
  }
  if (input.location) {
    sql += ` AND (location LIKE $${paramIndex} OR area LIKE $${paramIndex})`;
    params.push(`%${input.location}%`);
    paramIndex++;
  }
  if (input.area) {
    sql += ` AND (area LIKE $${paramIndex} OR location LIKE $${paramIndex})`;
    params.push(`%${input.area}%`);
    paramIndex++;
  }
  if (input.min_price !== undefined) {
    sql += ` AND price >= $${paramIndex}`;
    params.push(input.min_price);
    paramIndex++;
  }
  if (input.max_price !== undefined) {
    sql += ` AND price <= $${paramIndex}`;
    params.push(input.max_price);
    paramIndex++;
  }
  if (input.property_type) {
    sql += ` AND property_type = $${paramIndex}`;
    params.push(input.property_type);
    paramIndex++;
  }
  if (input.bedrooms !== undefined) {
    sql += ` AND bedrooms >= $${paramIndex}`;
    params.push(input.bedrooms);
    paramIndex++;
  }
  if (Array.isArray(input.amenities) && input.amenities.length) {
    for (const amenity of input.amenities) {
      sql += ` AND (amenities LIKE $${paramIndex} OR amenities LIKE $${paramIndex + 1})`;
      params.push(`%${amenity}%`, `%"${amenity}"%`);
      paramIndex += 2;
    }
  }

  sql += ' ORDER BY created_at DESC';
  const safeLimit = Number.parseInt(String(limit ?? ''), 10);
  if (!Number.isNaN(safeLimit) && safeLimit > 0) {
    sql += ` LIMIT ${Math.min(safeLimit, 50)}`;
  }
  return { sql, params };
}

function toTime(value) {
  if (!value) return 0;
  const t = Date.parse(String(value));
  return Number.isNaN(t) ? 0 : t;
}

function intervalMsForFrequency(frequency) {
  if (frequency === 'weekly') return 7 * 24 * 60 * 60 * 1000;
  if (frequency === 'daily') return 24 * 60 * 60 * 1000;
  return 10 * 60 * 1000; // instant cadence (job runs every 30m)
}

/**
 * Run saved-search checks and create in-app notifications for new matches.
 */
export async function runSavedSearchAlerts({ db = pool, now = Date.now() } = {}) {
  const result = {
    scanned: 0,
    baselineInitialized: 0,
    matched: 0,
    notifiedUsers: 0,
    notificationsCreated: 0,
    emailsSent: 0,
  };

  let rows = [];
  try {
    const query = await db.query(
      `SELECT s.id, s.user_id, s.name, s.filters_json, s.query_string, s.last_notified_at, s.is_active, s.search_scope, s.alert_frequency, s.notify_email, u.email AS user_email
       FROM saved_searches s
       LEFT JOIN users u ON u.id = s.user_id
       WHERE COALESCE(CAST(s.is_active AS INTEGER), 1) = 1`
    );
    rows = query.rows || [];
  } catch (err) {
    const message = String(err?.message || '');
    if (!message.includes('alert_frequency')) throw err;

    // Self-heal legacy SQLite schemas where alert_frequency was not added.
    try {
      await db.query("ALTER TABLE saved_searches ADD COLUMN alert_frequency TEXT DEFAULT 'instant'");
    } catch (_) {}
    try {
      await db.query("UPDATE saved_searches SET alert_frequency = 'instant' WHERE alert_frequency IS NULL OR alert_frequency = ''");
    } catch (_) {}

    try {
      const query = await db.query(
        `SELECT s.id, s.user_id, s.name, s.filters_json, s.query_string, s.last_notified_at, s.is_active, s.search_scope, s.alert_frequency, s.notify_email, u.email AS user_email
         FROM saved_searches s
         LEFT JOIN users u ON u.id = s.user_id
         WHERE COALESCE(CAST(s.is_active AS INTEGER), 1) = 1`
      );
      rows = query.rows || [];
    } catch (_) {
      const fallback = await db.query(
        `SELECT s.id, s.user_id, s.name, s.filters_json, s.query_string, s.last_notified_at, s.is_active, s.search_scope, s.notify_email, u.email AS user_email
         FROM saved_searches s
         LEFT JOIN users u ON u.id = s.user_id
         WHERE COALESCE(CAST(s.is_active AS INTEGER), 1) = 1`
      );
      rows = (fallback.rows || []).map((row) => ({ ...row, alert_frequency: 'instant' }));
    }
  }
  if (!rows?.length) return result;

  const notifiedUsers = new Set();

  for (const row of rows) {
    result.scanned += 1;
    if (row.search_scope !== 'properties') continue;
    let filters = {};
    try {
      filters = row.filters_json ? JSON.parse(row.filters_json) : {};
    } catch {
      filters = {};
    }

    const lastNotifiedMs = toTime(row.last_notified_at);
    const minIntervalMs = intervalMsForFrequency(row.alert_frequency || 'instant');
    if (!lastNotifiedMs) {
      await db.query('UPDATE saved_searches SET last_notified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [row.id]);
      result.baselineInitialized += 1;
      continue;
    }
    if (now - lastNotifiedMs < minIntervalMs) continue;

    const { sql, params } = buildPropertySearchSql(filters, { limit: 25 });
    const { rows: matches } = await db.query(sql, params);
    const freshMatches = (matches || []).filter((m) => toTime(m.created_at) > lastNotifiedMs);
    if (!freshMatches.length) continue;

    result.matched += freshMatches.length;
    const top = freshMatches[0];
    const count = freshMatches.length;
    const msg =
      count === 1
        ? `New listing match: ${top.title}`
        : `${count} new listings match your saved search "${row.name}".`;

    await db.query(
      `INSERT INTO notifications (id, user_id, type, title, message, is_read)
       VALUES ($1, $2, $3, $4, $5, 0)`,
      [uuidv4(), row.user_id, 'saved_search_match', 'Saved search alert', msg]
    );
    if (row.notify_email && row.user_email) {
      const listUrl = row.query_string
        ? `${(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')}/properties?${row.query_string}`
        : `${(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')}/properties`;
      const mail = await sendMail({
        to: row.user_email,
        subject: 'New listings match your saved search',
        text: `${msg}\n\nView matches: ${listUrl}`,
        html: `<p>${msg}</p><p><a href="${listUrl}">View matches</a></p>`,
      });
      if (mail.sent) result.emailsSent += 1;
    }
    await db.query('UPDATE saved_searches SET last_notified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [row.id]);
    notifiedUsers.add(row.user_id);
    result.notificationsCreated += 1;
  }

  result.notifiedUsers = notifiedUsers.size;
  return result;
}
