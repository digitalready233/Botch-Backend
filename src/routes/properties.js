import express from 'express';
import pool from '../db/index.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { requireActiveVendorBusiness } from '../middleware/vendor-business.js';
import { body, param, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../lib/audit.js';
import { publicPropertyFilterSql } from '../lib/listing-state.js';
import {
  LISTING_STATES,
  LISTING_STATE_VALUES,
  normalizeListingState,
  validateListingStateTransition,
  validateInitialListingState,
  getSyncedColumnsForListingState,
  allowedListingStateTargets,
} from '../lib/listing-workflow.js';
import { isSellerVerificationApproved } from '../lib/seller-publish-eligibility.js';
import { assertVendorOrgModuleEnabled } from '../lib/vendor-org-modules.js';
import { assertVendorChannelSubscriptionActive } from '../lib/vendor-channel-subscriptions.js';
import { resolveFeaturedDurationDays } from '../lib/vendor-featured-plans.js';
import { sqlPropertyGalleryUrlsSubquery } from '../lib/db-dialect.js';

const router = express.Router();

function addDaysIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString();
}

function isAdminRole(role) {
  return role === 'admin' || role === 'super_admin';
}

function normalizeSubImageUrls(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const output = [];
  for (const raw of input) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}

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

function normalizeProofUrl(value) {
  if (value === undefined) return undefined;
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

async function isListingOwnerVerificationApproved(propertyRow) {
  const ownerId = propertyRow?.created_by;
  if (!ownerId) return true;
  const { rows } = await pool.query(
    `SELECT u.vendor_org_id,
            u.verification_status AS user_verification_status,
            vo.verification_status AS org_verification_status,
            vo.status AS org_status
     FROM users u
     LEFT JOIN vendor_organizations vo ON vo.id = u.vendor_org_id
     WHERE u.id = $1`,
    [ownerId]
  );
  const owner = rows?.[0];
  if (!owner) return true;
  return isSellerVerificationApproved(owner);
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

function deriveQueryStringFromFilters(filters) {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', String(filters.q));
  if (filters.location) params.set('location', String(filters.location));
  if (filters.area) params.set('area', String(filters.area));
  if (filters.min_price !== undefined) params.set('min_price', String(filters.min_price));
  if (filters.max_price !== undefined) params.set('max_price', String(filters.max_price));
  if (filters.property_type) params.set('property_type', String(filters.property_type));
  if (filters.bedrooms !== undefined) params.set('bedrooms', String(filters.bedrooms));
  if (Array.isArray(filters.amenities) && filters.amenities.length) {
    params.set('amenities', filters.amenities.join(','));
  }
  if (filters.listing_purpose) params.set('listing_purpose', String(filters.listing_purpose));
  return params.toString();
}

function mapSavedSearchRow(row) {
  let parsedFilters = {};
  try {
    parsedFilters = row?.filters_json ? JSON.parse(row.filters_json) : {};
  } catch {
    parsedFilters = {};
  }
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    search_scope: row.search_scope,
    filters: parsedFilters,
    query_string: row.query_string || '',
    is_active: !!row.is_active,
    alert_frequency: row.alert_frequency || 'instant',
    notify_email: !!row.notify_email,
    notify_push: !!row.notify_push,
    last_notified_at: row.last_notified_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** True when the listing creator belongs to at least one partner vendor org (p = properties alias). */
const creatorHasPartnerOrgSql = `EXISTS (
  SELECT 1 FROM vendor_memberships vm_p
  INNER JOIN vendor_organizations vo_p ON vo_p.id = vm_p.vendor_org_id
  WHERE vm_p.user_id = p.created_by
    AND (vo_p.is_partner = 1 OR LOWER(CAST(vo_p.is_partner AS TEXT)) IN ('true', '1'))
)`;

/** Vendor display name + logo for public property cards (p = properties alias). */
const propertyVendorBrandingSql = `
  (SELECT COALESCE(vo2.display_name, vo2.legal_name, u.full_name)
   FROM vendor_memberships vm2
   INNER JOIN vendor_organizations vo2 ON vo2.id = vm2.vendor_org_id
   WHERE vm2.user_id = p.created_by
   ORDER BY CASE WHEN vm2.is_primary_contact = 1 OR vm2.is_primary_contact = TRUE THEN 0 ELSE 1 END, vm2.created_at ASC
   LIMIT 1) AS vendor_name,
  (SELECT CASE
     WHEN vo2.logo_url IS NOT NULL AND TRIM(CAST(vo2.logo_url AS TEXT)) <> '' THEN vo2.logo_url
     ELSE u.avatar_url
   END
   FROM vendor_memberships vm2
   INNER JOIN vendor_organizations vo2 ON vo2.id = vm2.vendor_org_id
   WHERE vm2.user_id = p.created_by
   ORDER BY CASE WHEN vm2.is_primary_contact = 1 OR vm2.is_primary_contact = TRUE THEN 0 ELSE 1 END, vm2.created_at ASC
   LIMIT 1) AS vendor_logo_url,
  (SELECT vo2.id
   FROM vendor_memberships vm2
   INNER JOIN vendor_organizations vo2 ON vo2.id = vm2.vendor_org_id
   WHERE vm2.user_id = p.created_by
   ORDER BY CASE WHEN vm2.is_primary_contact = 1 OR vm2.is_primary_contact = TRUE THEN 0 ELSE 1 END, vm2.created_at ASC
   LIMIT 1) AS vendor_org_id
`;

function buildPropertySearchSql(rawInput, { limit } = {}) {
  const input = normalizeSavedSearchFilters(rawInput);
  const pub = publicPropertyFilterSql('p.');
  let sql = `
    SELECT p.*, u.role as creator_role, u.full_name as creator_name,
           (SELECT CASE WHEN ${creatorHasPartnerOrgSql} THEN 1 ELSE 0 END) AS is_partner_org,
           ${propertyVendorBrandingSql}
    FROM properties p
    LEFT JOIN users u ON u.id = p.created_by
    WHERE ${pub}
  `;
  const params = [];
  let paramIndex = 1;

  if (input.listing_purpose) {
    sql += ` AND p.listing_purpose = $${paramIndex}`;
    params.push(input.listing_purpose);
    paramIndex++;
  } else {
    sql += ` AND COALESCE(p.listing_purpose, 'sale') = 'sale'`;
  }

  // New filters for row-based layout
  if (rawInput.is_featured === '1' || rawInput.is_featured === 'true') {
    sql += ` AND (
      (p.featured = 1 OR LOWER(CAST(p.featured AS TEXT)) IN ('true', '1'))
      OR (
        COALESCE(p.featured_status, 'none') = 'active'
        AND (p.featured_expires_at IS NULL OR p.featured_expires_at > CURRENT_TIMESTAMP)
      )
    )`;
  }
  if (rawInput.is_botch === '1' || rawInput.is_botch === 'true') {
    sql += ` AND (u.role IN ('admin', 'super_admin') OR ${creatorHasPartnerOrgSql} OR u.id = 'a0000000-0000-0000-0000-000000000003')`;
  }
  if (rawInput.is_others === '1' || rawInput.is_others === 'true') {
    sql += ` AND u.id IS NOT NULL
      AND u.role IN ('vendor', 'vendor_admin')
      AND u.id <> 'a0000000-0000-0000-0000-000000000003'
      AND NOT (${creatorHasPartnerOrgSql})`;
  }

  if (input.q) {
    const term = `%${input.q}%`;
    sql += ` AND (p.title LIKE $${paramIndex} OR p.description LIKE $${paramIndex} OR p.location LIKE $${paramIndex} OR p.area LIKE $${paramIndex})`;
    params.push(term);
    paramIndex++;
  }
  if (input.location) {
    sql += ` AND (p.location LIKE $${paramIndex} OR p.area LIKE $${paramIndex})`;
    params.push(`%${input.location}%`);
    paramIndex++;
  }
  if (input.area) {
    sql += ` AND (p.area LIKE $${paramIndex} OR p.location LIKE $${paramIndex})`;
    params.push(`%${input.area}%`);
    paramIndex++;
  }
  if (input.min_price !== undefined) {
    sql += ` AND p.price >= $${paramIndex}`;
    params.push(input.min_price);
    paramIndex++;
  }
  if (input.max_price !== undefined) {
    sql += ` AND p.price <= $${paramIndex}`;
    params.push(input.max_price);
    paramIndex++;
  }
  if (input.property_type) {
    sql += ` AND p.property_type = $${paramIndex}`;
    params.push(input.property_type);
    paramIndex++;
  }
  if (input.bedrooms !== undefined) {
    sql += ` AND p.bedrooms >= $${paramIndex}`;
    params.push(input.bedrooms);
    paramIndex++;
  }
  if (Array.isArray(input.amenities) && input.amenities.length) {
    for (const amenity of input.amenities) {
      sql += ` AND (p.amenities LIKE $${paramIndex} OR p.amenities LIKE $${paramIndex + 1})`;
      params.push(`%${amenity}%`, `%"${amenity}"%`);
      paramIndex += 2;
    }
  }

  sql += ' ORDER BY p.created_at DESC';
  const safeLimit = Number.parseInt(String(limit ?? ''), 10);
  if (!Number.isNaN(safeLimit) && safeLimit > 0) {
    sql += ` LIMIT ${Math.min(safeLimit, 50)}`;
  }
  return { sql, params };
}

/**
 * GET /api/v1/properties - Smart search with filters
 * Query params: q, location, area, min_price, max_price, property_type, bedrooms, amenities (comma-separated)
 * Example: ?q=apartment&location=Accra&area=East Legon&max_price=2000&bedrooms=3&amenities=pool,generator
 */
router.get('/', async (req, res, next) => {
  try {
    const { sql, params } = buildPropertySearchSql(req.query, { limit: req.query.limit });
    const { rows } = await pool.query(sql, params);
    res.json(rows || []);
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/properties/mine — listings for current user (or all if admin) */
router.get('/mine', authMiddleware, async (req, res, next) => {
  try {
    if (req.userRole !== 'vendor' && req.userRole !== 'admin' && req.userRole !== 'super_admin') {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }

    const galleryCore = await sqlPropertyGalleryUrlsSubquery();
    const gallerySql = `${galleryCore} AS property_gallery_urls`;

    if (req.userRole === 'admin' || req.userRole === 'super_admin') {
      const { rows } = await pool.query(
        `SELECT p.*, u.full_name AS creator_name, ${gallerySql}
         FROM properties p
         LEFT JOIN users u ON u.id = p.created_by
         WHERE COALESCE(p.listing_purpose, 'sale') = 'sale'
         ORDER BY p.updated_at DESC, p.created_at DESC`
      );
      return res.json(rows || []);
    }

    const { rows } = await pool.query(
      `SELECT p.*, u.full_name AS creator_name, ${gallerySql}
       FROM properties p
       LEFT JOIN users u ON u.id = p.created_by
       WHERE COALESCE(p.listing_purpose, 'sale') = 'sale' AND p.created_by = $1
       ORDER BY p.updated_at DESC, p.created_at DESC`,
      [req.userId]
    );
    return res.json(rows || []);
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/properties/admin/list/all — admin: all sale listings (any workflow state) */
router.get('/admin/list/all', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM properties WHERE COALESCE(listing_purpose, 'sale') = 'sale'
       ORDER BY updated_at DESC, created_at DESC`
    );
    res.json(rows || []);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/properties/admin/workflow-meta — allowed listing_state targets for current user (admin/vendor rules).
 */
router.get('/admin/workflow-meta', authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    res.json({
      states: [...LISTING_STATE_VALUES],
      role: req.userRole,
      /** Client hint: from each state, which targets this JWT may use */
      transitionsByFrom: Object.fromEntries(
        LISTING_STATE_VALUES.map((from) => [
          from,
          allowedListingStateTargets(from, req.userRole, 'sale'),
        ])
      ),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/feature-requests', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         p.id,
         p.title,
         p.listing_purpose,
         p.rent_type,
         p.featured_status,
         p.featured_plan,
         p.featured_duration_days,
         p.featured_price,
         p.featured_currency,
         p.featured_requested_at,
         p.created_by,
         COALESCE(vo.display_name, vo.legal_name, u.full_name, 'Vendor') AS vendor_name
       FROM properties p
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN vendor_memberships vm ON vm.user_id = p.created_by
       LEFT JOIN vendor_organizations vo ON vo.id = vm.vendor_org_id
       WHERE COALESCE(p.featured_status, 'none') = 'pending'
       ORDER BY p.featured_requested_at DESC NULLS LAST, p.updated_at DESC`
    );
    return res.json(rows || []);
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/admin/feature-requests/:id',
  authMiddleware,
  requireAdmin,
  [
    param('id').isUUID(),
    body('action').isIn(['approve', 'reject']),
    body('rejection_reason').optional().trim().isLength({ max: 1000 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { rows: existingRows } = await pool.query('SELECT * FROM properties WHERE id = $1', [req.params.id]);
      if (!existingRows.length) return res.status(404).json({ error: 'Property not found' });
      const existing = existingRows[0];
      if (String(existing.featured_status || 'none') !== 'pending') {
        return res.status(400).json({ error: 'This listing has no pending featured request' });
      }

      const action = String(req.body.action || '');
      if (action === 'approve') {
        const boostDays = resolveFeaturedDurationDays(existing);
        const expiresAt = addDaysIso(boostDays);
        await pool.query(
          `UPDATE properties
           SET featured_status = 'active',
               featured = 1,
               featured_approved_at = CURRENT_TIMESTAMP,
               featured_approved_by = $2,
               featured_expires_at = $3,
               featured_rejection_reason = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [req.params.id, req.userId, expiresAt]
        );
      } else {
        await pool.query(
          `UPDATE properties
           SET featured_status = 'rejected',
               featured = 0,
               featured_approved_at = CURRENT_TIMESTAMP,
               featured_approved_by = $2,
               featured_rejection_reason = $3,
               featured_expires_at = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [req.params.id, req.userId, req.body.rejection_reason || null]
        );
      }

      logAudit({
        userId: req.userId,
        action: 'property_feature_review',
        resourceType: 'property',
        resourceId: req.params.id,
        details: JSON.stringify({ action, rejection_reason: req.body.rejection_reason || null }),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      const { rows } = await pool.query('SELECT * FROM properties WHERE id = $1', [req.params.id]);
      return res.json(rows[0]);
    } catch (err) {
      return next(err);
    }
  }
);

/** POST /api/v1/properties/:id/favorite - save listing for current user */
router.post('/:id/favorite', authMiddleware, async (req, res, next) => {
  try {
    const { id: propertyId } = req.params;
    const pub = publicPropertyFilterSql('');
    const { rows: propRows } = await pool.query(`SELECT id FROM properties WHERE id = $1 AND ${pub}`, [propertyId]);
    if (!propRows.length) return res.status(404).json({ error: 'Property not found' });
    await pool.query(
      `INSERT INTO property_favorites (id, user_id, property_id)
       VALUES ($1, $2, $3)`,
      [uuidv4(), req.userId, propertyId]
    );
    return res.status(201).json({ ok: true, saved: true });
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.toLowerCase().includes('unique')) {
      return res.json({ ok: true, saved: true });
    }
    next(err);
  }
});

/** DELETE /api/v1/properties/:id/favorite - unsave listing for current user */
router.delete('/:id/favorite', authMiddleware, async (req, res, next) => {
  try {
    const { id: propertyId } = req.params;
    await pool.query('DELETE FROM property_favorites WHERE user_id = $1 AND property_id = $2', [req.userId, propertyId]);
    return res.json({ ok: true, saved: false });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/properties/saved-searches - current user's saved property searches */
router.get('/saved-searches', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, user_id, name, search_scope, filters_json, query_string, is_active, alert_frequency, notify_email, notify_push, last_notified_at, created_at, updated_at
       FROM saved_searches
       WHERE user_id = $1 AND search_scope = 'properties'
       ORDER BY updated_at DESC, created_at DESC`,
      [req.userId]
    );
    res.json((rows || []).map(mapSavedSearchRow));
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/properties/saved-searches - save a property filter + alert settings */
router.post(
  '/saved-searches',
  authMiddleware,
  [
    body('name').optional().isString().trim().isLength({ min: 1, max: 140 }),
    body('search_scope').optional().isIn(['properties', 'rentals', 'marketplace', 'vendor_listings']),
    body('filters').optional().custom((v) => v && typeof v === 'object' && !Array.isArray(v)),
    body('query_string').optional().isString().isLength({ max: 2000 }),
    body('is_active').optional().isBoolean(),
    body('alert_frequency').optional().isIn(['instant', 'daily', 'weekly']),
    body('notify_email').optional().isBoolean(),
    body('notify_push').optional().isBoolean(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const filters = normalizeSavedSearchFilters(req.body.filters || {});
      const queryString = toCleanString(req.body.query_string, 2000) || deriveQueryStringFromFilters(filters);
      const id = uuidv4();
      const name = toCleanString(req.body.name, 140) || 'Saved search';
      const searchScope = req.body.search_scope || 'properties';
      const isActive = req.body.is_active !== undefined ? !!req.body.is_active : true;
      const alertFrequency = req.body.alert_frequency || 'instant';
      const notifyEmail = req.body.notify_email !== undefined ? !!req.body.notify_email : true;
      const notifyPush = req.body.notify_push !== undefined ? !!req.body.notify_push : false;

      await pool.query(
        `INSERT INTO saved_searches (id, user_id, name, search_scope, filters_json, query_string, is_active, alert_frequency, notify_email, notify_push, last_notified_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [id, req.userId, name, searchScope, JSON.stringify(filters), queryString, isActive, alertFrequency, notifyEmail, notifyPush]
      );
      const { rows } = await pool.query(
        `SELECT id, user_id, name, search_scope, filters_json, query_string, is_active, alert_frequency, notify_email, notify_push, last_notified_at, created_at, updated_at
         FROM saved_searches WHERE id = $1`,
        [id]
      );
      res.status(201).json(mapSavedSearchRow(rows[0]));
    } catch (err) {
      next(err);
    }
  }
);

/** PATCH /api/v1/properties/saved-searches/:id - update name/filters/alert settings */
router.patch(
  '/saved-searches/:id',
  authMiddleware,
  [
    body('name').optional().isString().trim().isLength({ min: 1, max: 140 }),
    body('filters').optional().custom((v) => v && typeof v === 'object' && !Array.isArray(v)),
    body('query_string').optional().isString().isLength({ max: 2000 }),
    body('is_active').optional().isBoolean(),
    body('alert_frequency').optional().isIn(['instant', 'daily', 'weekly']),
    body('notify_email').optional().isBoolean(),
    body('notify_push').optional().isBoolean(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { id } = req.params;
      const { rows: existingRows } = await pool.query(
        'SELECT * FROM saved_searches WHERE id = $1 AND user_id = $2 AND search_scope = $3',
        [id, req.userId, 'properties']
      );
      if (!existingRows.length) return res.status(404).json({ error: 'Saved search not found' });

      const existing = existingRows[0];
      const updates = [];
      const params = [];
      let idx = 1;

      if (req.body.name !== undefined) {
        updates.push(`name = $${idx}`);
        params.push(toCleanString(req.body.name, 140));
        idx++;
      }
      let nextFilters = null;
      if (req.body.filters !== undefined) {
        nextFilters = normalizeSavedSearchFilters(req.body.filters);
        updates.push(`filters_json = $${idx}`);
        params.push(JSON.stringify(nextFilters));
        idx++;
      }
      if (req.body.query_string !== undefined) {
        updates.push(`query_string = $${idx}`);
        params.push(toCleanString(req.body.query_string, 2000));
        idx++;
      } else if (nextFilters) {
        updates.push(`query_string = $${idx}`);
        params.push(deriveQueryStringFromFilters(nextFilters));
        idx++;
      }
      if (req.body.is_active !== undefined) {
        updates.push(`is_active = $${idx}`);
        params.push(!!req.body.is_active);
        idx++;
      }
      if (req.body.alert_frequency !== undefined) {
        updates.push(`alert_frequency = $${idx}`);
        params.push(req.body.alert_frequency);
        idx++;
      }
      if (req.body.notify_email !== undefined) {
        updates.push(`notify_email = $${idx}`);
        params.push(!!req.body.notify_email);
        idx++;
      }
      if (req.body.notify_push !== undefined) {
        updates.push(`notify_push = $${idx}`);
        params.push(!!req.body.notify_push);
        idx++;
      }

      if (!updates.length) return res.json(mapSavedSearchRow(existing));

      params.push(id, req.userId);
      await pool.query(
        `UPDATE saved_searches
         SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
         WHERE id = $${idx} AND user_id = $${idx + 1}`,
        params
      );

      const { rows } = await pool.query(
        `SELECT id, user_id, name, search_scope, filters_json, query_string, is_active, alert_frequency, notify_email, notify_push, last_notified_at, created_at, updated_at
         FROM saved_searches WHERE id = $1`,
        [id]
      );
      res.json(mapSavedSearchRow(rows[0]));
    } catch (err) {
      next(err);
    }
  }
);

/** DELETE /api/v1/properties/saved-searches/:id - remove saved search */
router.delete('/saved-searches/:id', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'DELETE FROM saved_searches WHERE id = $1 AND user_id = $2 AND search_scope = $3',
      [id, req.userId, 'properties']
    );
    if ((result.rowCount ?? 0) === 0) return res.status(404).json({ error: 'Saved search not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/properties/:id - single property with images (for detail page) */
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const pub = publicPropertyFilterSql('');
    const { rows: propRows } = await pool.query(`SELECT * FROM properties WHERE id = $1 AND ${pub}`, [id]);
    if (propRows.length === 0) return res.status(404).json({ error: 'Property not found' });
    const property = propRows[0];
    let images = [];
    try {
      const { rows: imgRows } = await pool.query(
        'SELECT id, file_url, sort_order FROM property_images WHERE property_id = $1 ORDER BY sort_order ASC, created_at ASC',
        [id]
      );
      images = imgRows || [];
    } catch (_) {}
    if (property.image_url && images.every((img) => img.file_url !== property.image_url)) {
      images.unshift({ id: null, file_url: property.image_url, sort_order: 0 });
    }
    res.json({ ...property, images });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/properties - create listing (admin or vendor; vendor listings are moderation-first) */
router.post('/', authMiddleware, requireActiveVendorBusiness({ enforce: false }), [
  body('title').trim().notEmpty(),
  body('description').optional().trim(),
  body('property_type').optional().isIn(['apartment', 'villa', 'house', 'cabin', 'treehouse', 'other']),
  body('bedrooms').optional().isInt({ min: 0 }),
  body('bathrooms').optional().isInt({ min: 0 }),
  body('location').optional().trim(),
  body('area').optional().trim(),
  body('price').isFloat({ min: 0 }),
  body('currency').optional().trim(),
  body('image_url').optional().trim(),
  body('sub_images').optional().isArray({ max: 30 }),
  body('amenities').optional(),
  body('listing_state').optional().isIn(['draft', 'pending_review']),
  body('ownership_proof_url').optional().trim(),
  body('mandate_proof_url').optional().trim(),
  body('authenticity_status').optional().isIn(['not_submitted', 'pending', 'approved', 'rejected']),
  body('authenticity_notes').optional().trim(),
], async (req, res, next) => {
  try {
    if (!isAdminRole(req.userRole) && req.userRole !== 'vendor') {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    if (req.userRole === 'vendor') {
      const mod = await assertVendorOrgModuleEnabled(pool, req.userId, 'properties');
      if (!mod.ok) return res.status(403).json({ error: mod.error });
      const sub = await assertVendorChannelSubscriptionActive(pool, req.userId, 'properties');
      if (!sub.ok) {
        return res.status(sub.status || 403).json({ error: sub.error, code: sub.code, channel: sub.channel });
      }
    }
    const listingState = req.body.listing_state || (req.userRole === 'vendor' ? LISTING_STATES.PENDING_REVIEW : LISTING_STATES.DRAFT);
    const initCheck = validateInitialListingState(listingState, req.userRole);
    if (!initCheck.ok) return res.status(400).json({ error: initCheck.error });
    const sync = getSyncedColumnsForListingState(listingState);
    const id = uuidv4();
    const {
      title, description, property_type, bedrooms, bathrooms,
      location, area, price, currency, image_url, amenities, sub_images,
      ownership_proof_url, mandate_proof_url, authenticity_status, authenticity_notes,
    } = req.body;
    const amenitiesStr = typeof amenities === 'string' ? amenities : (Array.isArray(amenities) ? JSON.stringify(amenities) : null);
    const mainImageUrl = typeof image_url === 'string' ? image_url.trim() : '';
    const subImageUrls = normalizeSubImageUrls(sub_images).filter((url) => url !== mainImageUrl);
    const ownershipProofUrl = normalizeProofUrl(ownership_proof_url);
    const mandateProofUrl = normalizeProofUrl(mandate_proof_url);
    const hasProofDocs = Boolean(ownershipProofUrl || mandateProofUrl);
    let authenticityStatus = authenticity_status || (hasProofDocs ? 'pending' : 'not_submitted');
    if (req.userRole === 'vendor' && authenticityStatus === 'approved') {
      return res.status(403).json({ error: 'Only administrators can mark listing authenticity as approved' });
    }
    if (req.userRole === 'vendor' && authenticityStatus === 'rejected') {
      return res.status(403).json({ error: 'Only administrators can reject listing authenticity' });
    }
    await pool.query(
      `INSERT INTO properties (id, title, description, property_type, bedrooms, bathrooms, location, area, price, currency, image_url, amenities,
        listing_state, moderation_status, publish_status, status, availability_status, created_by, listing_purpose,
        ownership_proof_url, mandate_proof_url, authenticity_status, authenticity_notes, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'sale', $19, $20, $21, $22, CURRENT_TIMESTAMP)`,
      [id, title, description || null, property_type || 'apartment', bedrooms ?? 0, bathrooms ?? 1, location || null, area || null, price, currency || 'USD', image_url || null, amenitiesStr,
        listingState, sync.moderation_status, sync.publish_status, sync.status, sync.availability_status, req.userId || null,
        ownershipProofUrl, mandateProofUrl, authenticityStatus, authenticity_notes ? String(authenticity_notes).trim() : null]
    );
    if (subImageUrls.length) {
      for (let i = 0; i < subImageUrls.length; i++) {
        await pool.query(
          'INSERT INTO property_images (id, property_id, file_url, sort_order) VALUES ($1, $2, $3, $4)',
          [uuidv4(), id, subImageUrls[i], i + 1]
        );
      }
    }
    const { rows } = await pool.query('SELECT * FROM properties WHERE id = $1', [id]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/v1/properties/:id - update listing (admin only) */
router.patch('/:id', authMiddleware, requireActiveVendorBusiness({ enforce: false }), [
  body('title').optional().trim().notEmpty(),
  body('description').optional().trim(),
  body('property_type').optional().isIn(['apartment', 'villa', 'house', 'cabin', 'treehouse', 'other']),
  body('bedrooms').optional().isInt({ min: 0 }),
  body('bathrooms').optional().isInt({ min: 0 }),
  body('location').optional().trim(),
  body('area').optional().trim(),
  body('price').optional().isFloat({ min: 0 }),
  body('currency').optional().trim(),
  body('image_url').optional().trim(),
  body('sub_images').optional().isArray({ max: 30 }),
  body('amenities').optional(),
  body('listing_state').optional().isIn([...LISTING_STATE_VALUES]),
  body('ownership_proof_url').optional().trim(),
  body('mandate_proof_url').optional().trim(),
  body('authenticity_status').optional().isIn(['not_submitted', 'pending', 'approved', 'rejected']),
  body('authenticity_notes').optional().trim(),
], async (req, res, next) => {
  try {
    if (!isAdminRole(req.userRole) && req.userRole !== 'vendor') {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { id } = req.params;
    const {
      title, description, property_type, bedrooms, bathrooms,
      location, area, price, currency, image_url, amenities, sub_images,
      listing_state: listingStateNew,
      ownership_proof_url, mandate_proof_url, authenticity_status, authenticity_notes,
    } = req.body;
    const {
      moderation_status: modNew,
      publish_status: pubNew,
      status: legacyNew,
      availability_status: avNew,
    } = req.body;
    const hasLegacyWorkflow =
      modNew !== undefined || pubNew !== undefined || legacyNew !== undefined || avNew !== undefined;
    if (hasLegacyWorkflow) {
      return res.status(400).json({
        error:
          'Use listing_state for workflow changes. moderation_status, publish_status, status, and availability_status are derived from listing_state.',
      });
    }
    const { rows: existingRows } = await pool.query('SELECT * FROM properties WHERE id = $1', [id]);
    if (existingRows.length === 0) return res.status(404).json({ error: 'Property not found' });
    const row = existingRows[0];
    if (req.userRole === 'vendor' && row.created_by !== req.userId) {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }
    if ((authenticity_status !== undefined || authenticity_notes !== undefined) && !isAdminRole(req.userRole)) {
      return res.status(403).json({ error: 'Only administrators can update authenticity review status' });
    }

    const updates = [];
    const params = [];
    let idx = 1;
    if (title !== undefined) { updates.push(`title = $${idx}`); params.push(title); idx++; }
    if (description !== undefined) { updates.push(`description = $${idx}`); params.push(description); idx++; }
    if (property_type !== undefined) { updates.push(`property_type = $${idx}`); params.push(property_type); idx++; }
    if (bedrooms !== undefined) { updates.push(`bedrooms = $${idx}`); params.push(bedrooms); idx++; }
    if (bathrooms !== undefined) { updates.push(`bathrooms = $${idx}`); params.push(bathrooms); idx++; }
    if (location !== undefined) { updates.push(`location = $${idx}`); params.push(location); idx++; }
    if (area !== undefined) { updates.push(`area = $${idx}`); params.push(area); idx++; }
    if (price !== undefined) { updates.push(`price = $${idx}`); params.push(price); idx++; }
    if (currency !== undefined) { updates.push(`currency = $${idx}`); params.push(currency); idx++; }
    if (image_url !== undefined) { updates.push(`image_url = $${idx}`); params.push(image_url); idx++; }
    if (amenities !== undefined) {
      const amenitiesStr = typeof amenities === 'string' ? amenities : (Array.isArray(amenities) ? JSON.stringify(amenities) : null);
      updates.push(`amenities = $${idx}`); params.push(amenitiesStr); idx++;
    }
    if (ownership_proof_url !== undefined) {
      updates.push(`ownership_proof_url = $${idx}`);
      params.push(normalizeProofUrl(ownership_proof_url));
      idx++;
    }
    if (mandate_proof_url !== undefined) {
      updates.push(`mandate_proof_url = $${idx}`);
      params.push(normalizeProofUrl(mandate_proof_url));
      idx++;
    }
    if (authenticity_notes !== undefined) {
      updates.push(`authenticity_notes = $${idx}`);
      params.push(String(authenticity_notes || '').trim() || null);
      idx++;
    }
    if (authenticity_status !== undefined) {
      updates.push(`authenticity_status = $${idx}`);
      params.push(authenticity_status);
      idx++;
      updates.push(`authenticity_reviewed_at = $${idx}`);
      params.push(new Date().toISOString());
      idx++;
      updates.push(`authenticity_reviewed_by = $${idx}`);
      params.push(req.userId || null);
      idx++;
    } else if (
      req.userRole === 'vendor' &&
      (ownership_proof_url !== undefined || mandate_proof_url !== undefined) &&
      row.authenticity_status !== 'approved'
    ) {
      // Vendor provided/updated proof documents; put listing back into pending authenticity review.
      updates.push(`authenticity_status = $${idx}`);
      params.push('pending');
      idx++;
    }

    if (listingStateNew !== undefined) {
      const from = normalizeListingState(row);
      const purpose = row.listing_purpose || 'sale';
      const effectiveOwnershipProofUrl = ownership_proof_url !== undefined ? normalizeProofUrl(ownership_proof_url) : row.ownership_proof_url;
      const effectiveMandateProofUrl = mandate_proof_url !== undefined ? normalizeProofUrl(mandate_proof_url) : row.mandate_proof_url;
      const effectiveAuthenticityStatus = authenticity_status !== undefined
        ? authenticity_status
        : (
          req.userRole === 'vendor' &&
          (ownership_proof_url !== undefined || mandate_proof_url !== undefined) &&
          row.authenticity_status !== 'approved'
            ? 'pending'
            : row.authenticity_status
        );
      if (listingStateNew === LISTING_STATES.PUBLISHED) {
        if (effectiveAuthenticityStatus !== 'approved') {
          return res.status(400).json({ error: 'Listing authenticity must be approved before publishing.' });
        }
        if (!effectiveOwnershipProofUrl && !effectiveMandateProofUrl) {
          return res.status(400).json({ error: 'Upload ownership or mandate proof before publishing.' });
        }
        const ownerVerified = await isListingOwnerVerificationApproved(row);
        if (!ownerVerified) {
          return res.status(400).json({
            error: 'Listing owner must be verified before publishing.',
            reason_code: 'AGENT_VERIFICATION_REQUIRED',
          });
        }
      }
      const tCheck = validateListingStateTransition({
        from,
        to: listingStateNew,
        role: req.userRole,
        listingPurpose: purpose,
      });
      if (!tCheck.ok) return res.status(400).json({ error: tCheck.error });
      const sync = getSyncedColumnsForListingState(listingStateNew);
      updates.push(`listing_state = $${idx}`); params.push(listingStateNew); idx++;
      updates.push(`moderation_status = $${idx}`); params.push(sync.moderation_status); idx++;
      updates.push(`publish_status = $${idx}`); params.push(sync.publish_status); idx++;
      updates.push(`status = $${idx}`); params.push(sync.status); idx++;
      updates.push(`availability_status = $${idx}`); params.push(sync.availability_status); idx++;
    }

    if (updates.length === 0 && sub_images === undefined) {
      const { rows } = await pool.query('SELECT * FROM properties WHERE id = $1', [id]);
      return res.json(rows[0]);
    }
    if (updates.length > 0) {
      params.push(id);
      await pool.query(`UPDATE properties SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${idx}`, params);
    }
    if (sub_images !== undefined) {
      const currentMainImage = image_url !== undefined ? (typeof image_url === 'string' ? image_url.trim() : '') : (row.image_url || '');
      const subImageUrls = normalizeSubImageUrls(sub_images).filter((url) => url !== currentMainImage);
      await pool.query('DELETE FROM property_images WHERE property_id = $1', [id]);
      for (let i = 0; i < subImageUrls.length; i++) {
        await pool.query(
          'INSERT INTO property_images (id, property_id, file_url, sort_order) VALUES ($1, $2, $3, $4)',
          [uuidv4(), id, subImageUrls[i], i + 1]
        );
      }
    }
    const { rows } = await pool.query('SELECT * FROM properties WHERE id = $1', [id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/v1/properties/:id - delete listing (admin only) */
router.delete('/:id', authMiddleware, requireActiveVendorBusiness({ enforce: false }), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isAdminRole(req.userRole) && req.userRole !== 'vendor') {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }
    if (req.userRole === 'vendor') {
      const { rows: propertyRows } = await pool.query('SELECT id, created_by FROM properties WHERE id = $1', [id]);
      if (!propertyRows.length) return res.status(404).json({ error: 'Property not found' });
      if (propertyRows[0].created_by !== req.userId) return res.status(403).json({ error: "You don't have permission to do that." });
    }
    const result = await pool.query('DELETE FROM properties WHERE id = $1', [id]);
    if ((result.rowCount ?? 0) === 0) return res.status(404).json({ error: 'Property not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/properties/:id/images - add image to property (admin only) */
router.post('/:id/images', authMiddleware, requireActiveVendorBusiness({ enforce: false }), [
  body('file_url').trim().notEmpty(),
  body('sort_order').optional().isInt({ min: 0 }),
], async (req, res, next) => {
  try {
    if (!isAdminRole(req.userRole) && req.userRole !== 'vendor') {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { id } = req.params;
    const { rows: prop } = await pool.query('SELECT id FROM properties WHERE id = $1', [id]);
    if (prop.length === 0) return res.status(404).json({ error: 'Property not found' });
    if (req.userRole === 'vendor') {
      const { rows: ownerRows } = await pool.query('SELECT id, created_by FROM properties WHERE id = $1', [id]);
      if (!ownerRows.length) return res.status(404).json({ error: 'Property not found' });
      if (ownerRows[0].created_by !== req.userId) return res.status(403).json({ error: "You don't have permission to do that." });
    }
    const imgId = uuidv4();
    await pool.query(
      'INSERT INTO property_images (id, property_id, file_url, sort_order) VALUES ($1, $2, $3, $4)',
      [imgId, id, req.body.file_url.trim(), req.body.sort_order ?? 0]
    );
    const { rows } = await pool.query('SELECT * FROM property_images WHERE id = $1', [imgId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

export default router;
