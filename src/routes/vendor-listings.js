import express from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { body, param, query, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/index.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { requireActiveVendorBusiness } from '../middleware/vendor-business.js';
import { logAudit } from '../lib/audit.js';
import { getUploadsBase } from '../lib/upload-paths.js';
import { uploadToS3, isS3Configured } from '../lib/s3.js';
import { fileFilter, ALLOWED_IMAGE_MIMES } from '../lib/upload-validation.js';
import { isSellerVerificationApproved } from '../lib/seller-publish-eligibility.js';
import { assertVendorOrgModuleEnabled } from '../lib/vendor-org-modules.js';
import { isCustomerRole } from '../lib/roles.js';
import {
  getFeaturedPlanById,
  legacyPlanSlugFromDays,
  resolveFeaturedDurationDays,
} from '../lib/vendor-featured-plans.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vendorListingsDir = path.join(getUploadsBase(path.join(__dirname, '..', '..', 'uploads')), 'vendor-listings');
try { fs.mkdirSync(vendorListingsDir, { recursive: true }); } catch (_) {}

const vendorListingDiskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, vendorListingsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.bin';
    cb(null, `vendor-listing-${uuidv4()}${ext}`);
  },
});
const vendorListingMemoryStorage = multer.memoryStorage();
const vendorListingUpload = multer({
  storage: isS3Configured() ? vendorListingMemoryStorage : vendorListingDiskStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: fileFilter(ALLOWED_IMAGE_MIMES, 'Vendor listing image'),
});

function canManageListing(role, userId, row) {
  if (['admin', 'super_admin', 'vendor_admin', 'finance_admin', 'moderator', 'editor'].includes(role)) return true;
  return role === 'vendor' && row.created_by === userId;
}

/** `vendor_listings.id`: UUID in production; dev/SQLite seeds may use strings like `seed-vl-003`. */
function paramVendorListingId(name = 'id') {
  return param(name)
    .trim()
    .isLength({ min: 1, max: 128 })
    .matches(/^[a-zA-Z0-9-]+$/)
    .withMessage('Invalid listing id');
}

function isAdminClass(role) {
  return ['admin', 'super_admin', 'vendor_admin', 'finance_admin', 'moderator', 'editor'].includes(role);
}

function addDaysIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString();
}

function parseMetadataObject(input) {
  if (!input) return {};
  if (typeof input === 'object' && !Array.isArray(input)) return input;
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }
  return {};
}

function normalizeImageUrls(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((v) => String(v || '').trim())
    .filter((v) => /^https?:\/\/|^\//i.test(v))
    .slice(0, 5);
}

function extractListingImageUrls(row, overrideImageUrls) {
  const metadata = parseMetadataObject(row?.metadata);
  const fromMetadata = normalizeImageUrls(metadata.image_urls);
  const candidate = Array.isArray(overrideImageUrls) ? normalizeImageUrls(overrideImageUrls) : fromMetadata;
  const fallback = String(row?.media_url || '').trim();
  if (!fallback) return candidate;
  if (candidate.includes(fallback)) return candidate;
  return [fallback, ...candidate].slice(0, 5);
}

function formatResponseStats(rows) {
  const all = Array.isArray(rows) ? rows : [];
  const totalLeadsCount = all.length;
  const responded = all.filter((r) => r?.lead_status && String(r.lead_status) !== 'new');
  const respondedLeadsCount = responded.length;
  let totalHours = 0;
  let timedCount = 0;
  for (const row of responded) {
    const created = new Date(row.created_at || 0).getTime();
    const updated = new Date(row.updated_at || 0).getTime();
    if (!Number.isFinite(created) || !Number.isFinite(updated) || updated <= created) continue;
    totalHours += (updated - created) / (1000 * 60 * 60);
    timedCount += 1;
  }
  const avgResponseHours = timedCount > 0 ? Math.round((totalHours / timedCount) * 10) / 10 : null;
  const responseRatePercent =
    totalLeadsCount > 0 ? Math.round((respondedLeadsCount / totalLeadsCount) * 100) : null;
  return {
    avg_response_hours: avgResponseHours,
    responded_leads_count: respondedLeadsCount,
    total_leads_count: totalLeadsCount,
    response_rate_percent: responseRatePercent,
  };
}

async function getVendorResponseStats(vendorId, vendorType) {
  if (!vendorId) {
    return {
      avg_response_hours: null,
      responded_leads_count: 0,
      total_leads_count: 0,
      response_rate_percent: null,
    };
  }
  if (vendorType === 'organization') {
    const { rows } = await pool.query(
      `SELECT li.created_at, li.updated_at, li.lead_status
       FROM listing_inquiries li
       INNER JOIN vendor_memberships vm ON vm.user_id = li.assigned_to
       WHERE vm.vendor_org_id = $1
       ORDER BY li.created_at DESC
       LIMIT 1000`,
      [vendorId]
    );
    return formatResponseStats(rows);
  }
  const { rows } = await pool.query(
    `SELECT created_at, updated_at, lead_status
     FROM listing_inquiries
     WHERE assigned_to = $1
     ORDER BY created_at DESC
     LIMIT 1000`,
    [vendorId]
  );
  return formatResponseStats(rows);
}

function requireVendorOrAdmin(req, res, next) {
  if (req.userRole !== 'vendor' && !isAdminClass(req.userRole)) {
    return res.status(403).json({ error: "You don't have permission to do that." });
  }
  return next();
}

async function isVendorListingPublishEligible(listingId) {
  const { rows } = await pool.query(
    `SELECT
       vl.id,
       vl.created_by,
       vl.vendor_org_id,
       u.verification_status AS user_verification_status,
       vo.verification_status AS org_verification_status,
       vo.status AS org_status
     FROM vendor_listings vl
     LEFT JOIN users u ON u.id = vl.created_by
     LEFT JOIN vendor_organizations vo ON vo.id = vl.vendor_org_id
     WHERE vl.id = $1`,
    [listingId]
  );
  return isSellerVerificationApproved(rows?.[0]);
}

/** Whitelisted ORDER BY for public listings (prevent SQL injection). */
function orderClauseForPublicListings(sortRaw) {
  const s = String(sortRaw || 'newest').toLowerCase();
  const featuredPriority = `CASE
    WHEN COALESCE(vl.featured_status, 'none') = 'active'
      AND (vl.featured_expires_at IS NULL OR vl.featured_expires_at > CURRENT_TIMESTAMP)
    THEN 0
    ELSE 1
  END`;
  if (s === 'price_asc') {
    return ` ORDER BY ${featuredPriority}, (CASE WHEN vl.price IS NULL THEN 1 ELSE 0 END), vl.price ASC, vl.approved_at DESC, vl.created_at DESC`;
  }
  if (s === 'price_desc') {
    return ` ORDER BY ${featuredPriority}, vl.price DESC NULLS LAST, vl.approved_at DESC, vl.created_at DESC`;
  }
  if (s === 'rating') {
    return ` ORDER BY ${featuredPriority}, vendor_avg_rating DESC NULLS LAST, vl.approved_at DESC, vl.created_at DESC`;
  }
  return ` ORDER BY ${featuredPriority}, vl.approved_at DESC NULLS LAST, vl.created_at DESC`;
}

/** Anonymous marketplace listing row (published only). Matches GET /public list shape. */
const PUBLIC_VENDOR_LISTING_SELECT_SQL = `
        SELECT
          vl.*,
          COALESCE(vo.display_name, vo.legal_name, creator.full_name, 'Verified vendor') AS vendor_name,
          COALESCE(primary_contact.full_name, creator.full_name) AS vendor_contact_name,
          COALESCE(primary_contact.phone, creator.phone) AS vendor_contact_phone,
          vo.status AS vendor_org_status,
          CASE
            WHEN vl.vendor_org_id IS NOT NULL THEN
              CASE WHEN vo.verification_status = 'approved' THEN 1 ELSE 0 END
            ELSE
              CASE WHEN creator.verification_status = 'approved' THEN 1 ELSE 0 END
          END AS vendor_verified,
          CASE
            WHEN vl.vendor_org_id IS NOT NULL THEN vo.verified_at
            ELSE creator.verified_at
          END AS vendor_verified_at,
          CASE
            WHEN vl.vendor_org_id IS NOT NULL THEN vo.verification_level
            ELSE creator.verification_level
          END AS vendor_verification_level,
          CASE
            WHEN COALESCE(primary_contact.phone, creator.phone) IS NULL THEN 0
            ELSE 1
          END AS vendor_has_phone,
          review_stats.avg_rating AS vendor_avg_rating,
          COALESCE(review_stats.reviews_count, 0) AS vendor_reviews_count,
          CASE
            WHEN vl.vendor_org_id IS NOT NULL THEN
              CASE
                WHEN COALESCE(org_leads.total_leads, 0) = 0 THEN NULL
                ELSE ROUND((COALESCE(org_leads.responded_leads, 0) * 100.0) / org_leads.total_leads)
              END
            ELSE
              CASE
                WHEN COALESCE(user_leads.total_leads, 0) = 0 THEN NULL
                ELSE ROUND((COALESCE(user_leads.responded_leads, 0) * 100.0) / user_leads.total_leads)
              END
          END AS vendor_response_rate_percent,
          CASE WHEN vl.vendor_org_id IS NOT NULL THEN vl.vendor_org_id ELSE vl.created_by END AS vendor_profile_id,
          CASE WHEN vl.vendor_org_id IS NOT NULL THEN 'organization' ELSE 'user' END AS vendor_profile_type,
          CASE WHEN vl.vendor_org_id IS NOT NULL THEN vo.logo_url ELSE creator.avatar_url END AS vendor_image_url
        FROM vendor_listings vl
        LEFT JOIN vendor_organizations vo ON vo.id = vl.vendor_org_id
        LEFT JOIN users creator ON creator.id = vl.created_by
        LEFT JOIN vendor_memberships vm
          ON vm.vendor_org_id = vl.vendor_org_id
         AND (vm.is_primary_contact = 1 OR vm.is_primary_contact = 1)
        LEFT JOIN users primary_contact ON primary_contact.id = vm.user_id
        LEFT JOIN (
          SELECT
            vendor_profile_id,
            vendor_profile_type,
            ROUND(AVG(rating), 2) AS avg_rating,
            COUNT(*) AS reviews_count
          FROM vendor_reviews
          WHERE COALESCE(moderation_status, 'visible') <> 'hidden'
          GROUP BY vendor_profile_id, vendor_profile_type
        ) review_stats
          ON review_stats.vendor_profile_id = CASE WHEN vl.vendor_org_id IS NOT NULL THEN vl.vendor_org_id ELSE vl.created_by END
         AND review_stats.vendor_profile_type = CASE WHEN vl.vendor_org_id IS NOT NULL THEN 'organization' ELSE 'user' END
        LEFT JOIN (
          SELECT
            vm.vendor_org_id,
            COUNT(*) AS total_leads,
            SUM(CASE WHEN li.lead_status <> 'new' THEN 1 ELSE 0 END) AS responded_leads
          FROM listing_inquiries li
          INNER JOIN vendor_memberships vm ON vm.user_id = li.assigned_to
          GROUP BY vm.vendor_org_id
        ) org_leads ON org_leads.vendor_org_id = vl.vendor_org_id
        LEFT JOIN (
          SELECT
            assigned_to AS user_id,
            COUNT(*) AS total_leads,
            SUM(CASE WHEN lead_status <> 'new' THEN 1 ELSE 0 END) AS responded_leads
          FROM listing_inquiries
          GROUP BY assigned_to
        ) user_leads ON user_leads.user_id = vl.created_by
        WHERE vl.workflow_state = 'published'`;

router.get(
  '/public',
  [
    query('listing_type').optional().isIn(['material', 'service']),
    query('q').optional().trim().isLength({ max: 200 }),
    query('location').optional().trim().isLength({ max: 255 }),
    query('vendor_profile_id').optional().isUUID(),
    query('vendor_profile_type').optional().isIn(['organization', 'user']),
    query('verified_only').optional().isIn(['1', '0', 'true', 'false']),
    query('has_phone').optional().isIn(['1', '0', 'true', 'false']),
    query('paginated').optional().isIn(['1', '0', 'true', 'false']),
    query('page').optional().isInt({ min: 1, max: 10_000 }),
    query('page_size').optional().isInt({ min: 1, max: 48 }),
    query('sort').optional().isIn(['newest', 'price_asc', 'price_desc', 'rating']),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { listing_type, q, location, vendor_profile_id, vendor_profile_type, verified_only, has_phone, is_featured, is_botch, is_partner, is_others } = req.query;
      const verifiedOnly = String(verified_only || '').toLowerCase();
      const hasPhone = String(has_phone || '').toLowerCase();
      let sql = PUBLIC_VENDOR_LISTING_SELECT_SQL;
      const params = [];
      let idx = 1;

      if (listing_type) {
        sql += ` AND vl.listing_type = $${idx++}`;
        params.push(listing_type);
      }
      if (q && String(q).trim()) {
        const term = `%${String(q).trim()}%`;
        sql += ` AND (vl.title LIKE $${idx} OR vl.description LIKE $${idx})`;
        params.push(term);
        idx++;
      }
      if (location && String(location).trim()) {
        sql += ` AND vl.location LIKE $${idx++}`;
        params.push(`%${String(location).trim()}%`);
      }

      // New filters for row-based layout
      if (is_featured === '1' || is_featured === 'true') {
        sql += ` AND COALESCE(vl.featured_status, 'none') = 'active' AND (vl.featured_expires_at IS NULL OR vl.featured_expires_at > CURRENT_TIMESTAMP)`;
      }
      if (is_botch === '1' || is_botch === 'true') {
        sql += ` AND (creator.role IN ('admin', 'super_admin') OR vo.is_partner = 1 OR creator.id = 'a0000000-0000-0000-0000-000000000003')`;
      }
      if (is_partner === '1' || is_partner === 'true') {
        sql += ` AND vo.is_partner = 1`;
      }
      if (is_others === '1' || is_others === 'true') {
        sql += ` AND creator.role NOT IN ('admin', 'super_admin') AND (vo.is_partner IS NULL OR vo.is_partner = 0) AND creator.id <> 'a0000000-0000-0000-0000-000000000003'`;
      }

      if (vendor_profile_id && vendor_profile_type === 'organization') {
        sql += ` AND vl.vendor_org_id = $${idx++}`;
        params.push(vendor_profile_id);
      }
      if (vendor_profile_id && vendor_profile_type === 'user') {
        sql += ` AND vl.created_by = $${idx++}`;
        params.push(vendor_profile_id);
      }
      if (verifiedOnly === '1' || verifiedOnly === 'true') {
        sql += ` AND (
          CASE
            WHEN vl.vendor_org_id IS NOT NULL THEN vo.verification_status = 'approved'
            ELSE creator.verification_status = 'approved'
          END
        )`;
      }
      if (hasPhone === '1' || hasPhone === 'true') {
        sql += ` AND TRIM(COALESCE(primary_contact.phone, creator.phone, '')) <> ''`;
      }

      const paginatedRaw = String(req.query.paginated || '').toLowerCase();
      const usePaged = paginatedRaw === '1' || paginatedRaw === 'true';
      const page = Math.min(10_000, Math.max(1, Number(req.query.page) || 1));
      const pageSizeRaw = Number(req.query.page_size);
      const pageSize = Math.min(48, Math.max(1, Number.isFinite(pageSizeRaw) ? pageSizeRaw : 24));

      const orderClause = orderClauseForPublicListings(req.query.sort);
      let listSql = sql + orderClause;
      let queryParams = params;

      if (usePaged) {
        const li = params.length + 1;
        const oi = params.length + 2;
        listSql += ` LIMIT $${li} OFFSET $${oi}`;
        queryParams = [...params, pageSize, (page - 1) * pageSize];
      }

      try {
        if (usePaged) {
          const countSql = `SELECT COUNT(*) AS total FROM (${sql}) AS counted_listings`;
          const [{ rows: countRows }, { rows }] = await Promise.all([
            pool.query(countSql, params),
            pool.query(listSql, queryParams),
          ]);
          const total = Number(countRows?.[0]?.total ?? 0);
          return res.json({
            items: rows || [],
            total,
            page,
            page_size: pageSize,
          });
        }
        const { rows } = await pool.query(listSql, queryParams);
        return res.json(rows || []);
      } catch (_) {
        // Backward-compatible fallback when newer vendor/review tables/columns are unavailable.
        let fallbackSql = `
          SELECT
            vl.*,
            COALESCE(creator.full_name, 'Verified vendor') AS vendor_name,
            creator.full_name AS vendor_contact_name,
            creator.phone AS vendor_contact_phone,
            NULL AS vendor_org_status,
            CASE WHEN creator.verification_status = 'approved' THEN 1 ELSE 0 END AS vendor_verified,
            creator.verified_at AS vendor_verified_at,
            creator.verification_level AS vendor_verification_level,
            CASE WHEN TRIM(COALESCE(creator.phone, '')) = '' THEN 0 ELSE 1 END AS vendor_has_phone,
            NULL AS vendor_avg_rating,
            0 AS vendor_reviews_count,
            NULL AS vendor_response_rate_percent,
            vl.created_by AS vendor_profile_id,
            'user' AS vendor_profile_type
          FROM vendor_listings vl
          LEFT JOIN users creator ON creator.id = vl.created_by
          WHERE vl.workflow_state = 'published'`;
        const fallbackParams = [];
        let fallbackIdx = 1;

        if (listing_type) {
          fallbackSql += ` AND vl.listing_type = $${fallbackIdx++}`;
          fallbackParams.push(listing_type);
        }
        if (q && String(q).trim()) {
          const term = `%${String(q).trim()}%`;
          fallbackSql += ` AND (vl.title LIKE $${fallbackIdx} OR vl.description LIKE $${fallbackIdx})`;
          fallbackParams.push(term);
          fallbackIdx++;
        }
        if (location && String(location).trim()) {
          fallbackSql += ` AND vl.location LIKE $${fallbackIdx++}`;
          fallbackParams.push(`%${String(location).trim()}%`);
        }
        if (vendor_profile_id && vendor_profile_type === 'user') {
          fallbackSql += ` AND vl.created_by = $${fallbackIdx++}`;
          fallbackParams.push(vendor_profile_id);
        }
        if (vendor_profile_id && vendor_profile_type === 'organization') {
          return res.json([]);
        }
        if (verifiedOnly === '1' || verifiedOnly === 'true') {
          fallbackSql += ` AND creator.verification_status = 'approved'`;
        }
        if (hasPhone === '1' || hasPhone === 'true') {
          fallbackSql += ` AND TRIM(COALESCE(creator.phone, '')) <> ''`;
        }
        fallbackSql += ' ORDER BY vl.approved_at DESC, vl.created_at DESC';

        try {
          const { rows } = await pool.query(fallbackSql, fallbackParams);
          return res.json(rows || []);
        } catch (_) {
          // Final safety net for legacy schemas missing workflow_state.
          const { rows } = await pool.query(
            `SELECT
               vl.*,
               COALESCE(creator.full_name, 'Verified vendor') AS vendor_name,
               creator.full_name AS vendor_contact_name,
               creator.phone AS vendor_contact_phone,
               NULL AS vendor_org_status,
               CASE WHEN creator.verification_status = 'approved' THEN 1 ELSE 0 END AS vendor_verified,
               creator.verified_at AS vendor_verified_at,
               creator.verification_level AS vendor_verification_level,
               CASE WHEN TRIM(COALESCE(creator.phone, '')) = '' THEN 0 ELSE 1 END AS vendor_has_phone,
               NULL AS vendor_avg_rating,
               0 AS vendor_reviews_count,
               NULL AS vendor_response_rate_percent,
               vl.created_by AS vendor_profile_id,
               'user' AS vendor_profile_type
             FROM vendor_listings vl
             LEFT JOIN users creator ON creator.id = vl.created_by
             ORDER BY vl.created_at DESC
             LIMIT 500`
          );
          return res.json(rows || []);
        }
      }
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/public/listings/:id',
  [paramVendorListingId()],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const id = req.params.id;
      try {
        const sql = `${PUBLIC_VENDOR_LISTING_SELECT_SQL} AND vl.id = $1`;
        const { rows } = await pool.query(sql, [id]);
        const row = rows?.[0];
        if (!row) return res.status(404).json({ error: 'Listing not found' });
        return res.json(row);
      } catch (_) {
        const fallbackSql = `
          SELECT
            vl.*,
            COALESCE(creator.full_name, 'Verified vendor') AS vendor_name,
            creator.full_name AS vendor_contact_name,
            creator.phone AS vendor_contact_phone,
            NULL AS vendor_org_status,
            CASE WHEN creator.verification_status = 'approved' THEN 1 ELSE 0 END AS vendor_verified,
            creator.verified_at AS vendor_verified_at,
            creator.verification_level AS vendor_verification_level,
            CASE WHEN TRIM(COALESCE(creator.phone, '')) = '' THEN 0 ELSE 1 END AS vendor_has_phone,
            NULL AS vendor_avg_rating,
            0 AS vendor_reviews_count,
            NULL AS vendor_response_rate_percent,
            vl.created_by AS vendor_profile_id,
            'user' AS vendor_profile_type
          FROM vendor_listings vl
          LEFT JOIN users creator ON creator.id = vl.created_by
          WHERE vl.workflow_state = 'published' AND vl.id = $1`;
        try {
          const { rows } = await pool.query(fallbackSql, [id]);
          const row = rows?.[0];
          if (!row) return res.status(404).json({ error: 'Listing not found' });
          return res.json(row);
        } catch (fallbackErr) {
          next(fallbackErr);
          return undefined;
        }
      }
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/public/vendors/:id',
  [
    param('id').isUUID(),
    query('type').optional().isIn(['organization', 'user']),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const id = req.params.id;
      const type = String(req.query.type || 'organization');

      if (type === 'organization') {
        const { rows } = await pool.query(
          `SELECT
             vo.id,
             'organization' AS profile_type,
             vo.legal_name,
             COALESCE(vo.display_name, vo.legal_name) AS display_name,
             vo.registration_country,
             vo.status,
             vo.verification_status,
             vo.verified_at,
             vo.verification_level,
             vo.verification_notes,
             vo.logo_url,
             vo.cover_photo_url,
             review_stats.avg_rating AS average_rating,
             COALESCE(review_stats.reviews_count, 0) AS reviews_count,
             vo.created_at,
             primary_contact.full_name AS primary_contact_name,
             primary_contact.phone AS primary_contact_phone,
             COALESCE(published_stats.published_count, 0) AS published_listings_count
           FROM vendor_organizations vo
           LEFT JOIN vendor_memberships vm
             ON vm.vendor_org_id = vo.id
            AND (vm.is_primary_contact = TRUE OR vm.is_primary_contact = 1)
           LEFT JOIN users primary_contact ON primary_contact.id = vm.user_id
           LEFT JOIN (
             SELECT vendor_org_id, COUNT(*) AS published_count
             FROM vendor_listings
             WHERE workflow_state = 'published'
             GROUP BY vendor_org_id
           ) published_stats ON published_stats.vendor_org_id = vo.id
           LEFT JOIN (
             SELECT
               vendor_profile_id,
               ROUND(AVG(rating), 2) AS avg_rating,
               COUNT(*) AS reviews_count
             FROM vendor_reviews
             WHERE vendor_profile_type = 'organization' AND COALESCE(moderation_status, 'visible') <> 'hidden'
             GROUP BY vendor_profile_id
           ) review_stats ON review_stats.vendor_profile_id = vo.id
           WHERE vo.id = $1`,
          [id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Vendor profile not found' });
        const responseStats = await getVendorResponseStats(id, 'organization');
        return res.json({ ...rows[0], ...responseStats });
      }

      const { rows } = await pool.query(
        `SELECT
           u.id,
           'user' AS profile_type,
           u.full_name AS display_name,
           u.country AS registration_country,
           u.verified,
           u.verification_status,
           u.verified_at,
           u.verification_level,
           u.verification_notes,
           u.avatar_url AS logo_url,
           NULL AS cover_photo_url,
           review_stats.avg_rating AS average_rating,
           COALESCE(review_stats.reviews_count, 0) AS reviews_count,
           u.created_at,
           u.full_name AS primary_contact_name,
           u.phone AS primary_contact_phone,
           COALESCE(published_stats.published_count, 0) AS published_listings_count
         FROM users u
         LEFT JOIN (
           SELECT created_by, COUNT(*) AS published_count
           FROM vendor_listings
           WHERE workflow_state = 'published'
           GROUP BY created_by
         ) published_stats ON published_stats.created_by = u.id
         LEFT JOIN (
           SELECT
             vendor_profile_id,
             ROUND(AVG(rating), 2) AS avg_rating,
             COUNT(*) AS reviews_count
           FROM vendor_reviews
           WHERE vendor_profile_type = 'user' AND COALESCE(moderation_status, 'visible') <> 'hidden'
           GROUP BY vendor_profile_id
         ) review_stats ON review_stats.vendor_profile_id = u.id
         WHERE u.id = $1 AND u.role = 'vendor'`,
        [id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Vendor profile not found' });
      const responseStats = await getVendorResponseStats(id, 'user');
      return res.json({ ...rows[0], ...responseStats });
    } catch (err) {
      return next(err);
    }
  }
);

router.get(
  '/public/vendors/:id/reviews',
  [param('id').isUUID(), query('type').optional().isIn(['organization', 'user'])],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const vendorId = req.params.id;
      const vendorType = String(req.query.type || 'organization');
      const { rows } = await pool.query(
        `SELECT
           vr.id,
           vr.vendor_profile_id,
           vr.vendor_profile_type,
           vr.rating,
           vr.comment,
           vr.created_at,
           reviewer.id AS reviewer_id,
           reviewer.full_name AS reviewer_name
         FROM vendor_reviews vr
         LEFT JOIN users reviewer ON reviewer.id = vr.reviewer_user_id
         WHERE vr.vendor_profile_id = $1
           AND vr.vendor_profile_type = $2
           AND COALESCE(vr.moderation_status, 'visible') <> 'hidden'
         ORDER BY vr.created_at DESC
         LIMIT 100`,
        [vendorId, vendorType]
      );
      return res.json(rows || []);
    } catch (err) {
      return next(err);
    }
  }
);

router.post(
  '/public/vendors/:vendorId/reviews/:reviewId/report',
  authMiddleware,
  [
    param('vendorId').isUUID(),
    param('reviewId').isUUID(),
    query('type').optional().isIn(['organization', 'user']),
    body('reason').optional({ nullable: true }).trim().isLength({ max: 1000 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
      const vendorId = req.params.vendorId;
      const reviewId = req.params.reviewId;
      const vendorType = String(req.query.type || 'organization');

      const { rows: reviewRows } = await pool.query(
        `SELECT id, reviewer_user_id, moderation_status
         FROM vendor_reviews
         WHERE id = $1 AND vendor_profile_id = $2 AND vendor_profile_type = $3`,
        [reviewId, vendorId, vendorType]
      );
      if (!reviewRows.length) return res.status(404).json({ error: 'Review not found' });
      if (reviewRows[0].reviewer_user_id === req.userId) {
        return res.status(400).json({ error: 'You cannot report your own review.' });
      }

      await pool.query(
        `INSERT INTO vendor_review_reports (id, review_id, reporter_user_id, reason)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (review_id, reporter_user_id) DO NOTHING`,
        [uuidv4(), reviewId, req.userId, req.body.reason || null]
      );

      await pool.query(
        `UPDATE vendor_reviews vr
         SET reports_count = sub.report_count,
             moderation_status = CASE
               WHEN COALESCE(vr.moderation_status, 'visible') = 'hidden' THEN 'hidden'
               WHEN sub.report_count >= 2 THEN 'flagged'
               ELSE COALESCE(vr.moderation_status, 'visible')
             END,
             updated_at = CURRENT_TIMESTAMP
         FROM (
           SELECT review_id, COUNT(*) AS report_count
           FROM vendor_review_reports
           WHERE review_id = $1
           GROUP BY review_id
         ) sub
         WHERE vr.id = sub.review_id`,
        [reviewId]
      );

      return res.status(201).json({ ok: true, message: 'Thanks. This review was reported for moderation.' });
    } catch (err) {
      return next(err);
    }
  }
);

router.post(
  '/public/vendors/:id/reviews',
  authMiddleware,
  [
    param('id').isUUID(),
    query('type').optional().isIn(['organization', 'user']),
    body('rating').isInt({ min: 1, max: 5 }),
    body('comment').optional({ nullable: true }).trim().isLength({ max: 2000 }),
  ],
  async (req, res, next) => {
    try {
      if (!isCustomerRole(req.userRole) && req.userRole !== 'admin' && req.userRole !== 'super_admin') {
        return res.status(403).json({ error: 'Only buyers and project clients can submit vendor reviews' });
      }
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const vendorId = req.params.id;
      const vendorType = String(req.query.type || 'organization');

      if (vendorType === 'organization') {
        const { rows } = await pool.query('SELECT id FROM vendor_organizations WHERE id = $1', [vendorId]);
        if (!rows.length) return res.status(404).json({ error: 'Vendor profile not found' });
      } else {
        const { rows } = await pool.query("SELECT id FROM users WHERE id = $1 AND role = 'vendor'", [vendorId]);
        if (!rows.length) return res.status(404).json({ error: 'Vendor profile not found' });
      }

      const hasEngagementQuery =
        vendorType === 'organization'
          ? `SELECT li.id
             FROM listing_inquiries li
             INNER JOIN vendor_memberships vm ON vm.user_id = li.assigned_to
             WHERE li.vendor_id = $1 AND vm.vendor_org_id = $2
             LIMIT 1`
          : `SELECT id
             FROM listing_inquiries
             WHERE vendor_id = $1 AND assigned_to = $2
             LIMIT 1`;
      const { rows: engagementRows } = await pool.query(hasEngagementQuery, [req.userId, vendorId]);
      if (!engagementRows.length && isCustomerRole(req.userRole)) {
        return res.status(400).json({ error: 'You can only review vendors you have interacted with.' });
      }

      const id = uuidv4();
      await pool.query(
        `INSERT INTO vendor_reviews (id, vendor_profile_id, vendor_profile_type, reviewer_user_id, rating, comment)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (vendor_profile_id, vendor_profile_type, reviewer_user_id)
         DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = CURRENT_TIMESTAMP`,
        [id, vendorId, vendorType, req.userId, Number(req.body.rating), req.body.comment || null]
      );

      const { rows } = await pool.query(
        `SELECT
           vr.id,
           vr.vendor_profile_id,
           vr.vendor_profile_type,
           vr.rating,
           vr.comment,
           vr.created_at,
           reviewer.id AS reviewer_id,
           reviewer.full_name AS reviewer_name
         FROM vendor_reviews vr
         LEFT JOIN users reviewer ON reviewer.id = vr.reviewer_user_id
         WHERE vr.vendor_profile_id = $1 AND vr.vendor_profile_type = $2 AND vr.reviewer_user_id = $3
         LIMIT 1`,
        [vendorId, vendorType, req.userId]
      );

      return res.status(201).json(rows[0] || null);
    } catch (err) {
      return next(err);
    }
  }
);

router.get('/mine', authMiddleware, async (req, res, next) => {
  try {
    if (req.userRole !== 'vendor' && req.userRole !== 'admin' && req.userRole !== 'super_admin') {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }

    if (req.userRole === 'admin' || req.userRole === 'super_admin') {
      const { rows } = await pool.query(`
        SELECT vl.*, COALESCE(vo.display_name, vo.legal_name, u.full_name, 'Vendor') AS vendor_name
        FROM vendor_listings vl
        LEFT JOIN vendor_organizations vo ON vo.id = vl.vendor_org_id
        LEFT JOIN users u ON u.id = vl.created_by
        ORDER BY vl.updated_at DESC, vl.created_at DESC
      `);
      return res.json(rows || []);
    }

    const { rows } = await pool.query(`
      SELECT vl.*, COALESCE(vo.display_name, vo.legal_name, u.full_name, 'Vendor') AS vendor_name
      FROM vendor_listings vl
      LEFT JOIN vendor_organizations vo ON vo.id = vl.vendor_org_id
      LEFT JOIN users u ON u.id = vl.created_by
      WHERE vl.created_by = $1
      ORDER BY vl.updated_at DESC, vl.created_at DESC
    `, [req.userId]);
    return res.json(rows || []);
  } catch (err) {
    next(err);
  }
});

router.post(
  '/:id/feature-request',
  authMiddleware,
  requireActiveVendorBusiness({ enforce: false }),
  requireVendorOrAdmin,
  [
    paramVendorListingId(),
    body('plan').isIn(['3_days', '7_days', '14_days']),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { rows: existingRows } = await pool.query('SELECT * FROM vendor_listings WHERE id = $1', [req.params.id]);
      if (!existingRows.length) return res.status(404).json({ error: 'Vendor listing not found' });
      const existing = existingRows[0];
      if (!canManageListing(req.userRole, req.userId, existing)) {
        return res.status(403).json({ error: "You don't have permission to do that." });
      }
      const isAdminClassRole = ['admin', 'super_admin', 'vendor_admin', 'finance_admin', 'moderator', 'editor'].includes(
        String(req.userRole || '').toLowerCase()
      );
      if (!isAdminClassRole) {
        return res.status(402).json({
          error: 'Featured listing checkout required',
          message: 'Use the featured listing payment flow before submitting a featured request.',
        });
      }
      if (existing.workflow_state !== 'published') {
        return res.status(400).json({ error: 'Only published listings can request featured placement' });
      }

      const planId = req.body.plan_id ? String(req.body.plan_id).trim() : '';
      let planSlug = String(req.body.plan || '').trim();
      let amount = 0;
      let durationDays = null;
      if (planId) {
        const planRow = await getFeaturedPlanById(pool, planId);
        if (!planRow || planRow.channel !== 'marketplace') {
          return res.status(400).json({ error: 'Invalid featured plan for marketplace' });
        }
        planSlug = legacyPlanSlugFromDays(planRow.duration_days);
        amount = Number(planRow.amount);
        durationDays = Number(planRow.duration_days);
      } else if (planSlug) {
        const days = resolveFeaturedDurationDays({ featured_plan: planSlug });
        durationDays = days;
        amount = 0;
      } else {
        return res.status(400).json({ error: 'plan_id or plan required' });
      }

      await pool.query(
        `UPDATE vendor_listings
         SET featured_status = 'pending',
             featured_plan = $2,
             featured_duration_days = $3,
             featured_requested_at = CURRENT_TIMESTAMP,
             featured_requested_by = $4,
             featured_price = $5,
             featured_currency = 'USD',
             featured_rejection_reason = NULL,
             featured_approved_at = NULL,
             featured_approved_by = NULL,
             featured_expires_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [req.params.id, planSlug, durationDays, req.userId, amount]
      );

      logAudit({
        userId: req.userId,
        action: 'vendor_listing_feature_request',
        resourceType: 'vendor_listing',
        resourceId: req.params.id,
        details: JSON.stringify({ plan: planSlug, duration_days: durationDays, amount, currency: 'USD' }),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      const { rows } = await pool.query('SELECT * FROM vendor_listings WHERE id = $1', [req.params.id]);
      return res.json(rows[0]);
    } catch (err) {
      return next(err);
    }
  }
);

router.get('/admin/feature-requests', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         vl.id,
         vl.title,
         vl.listing_type,
         vl.featured_status,
         vl.featured_plan,
         vl.featured_duration_days,
         vl.featured_price,
         vl.featured_currency,
         vl.featured_requested_at,
         vl.created_by,
         COALESCE(vo.display_name, vo.legal_name, u.full_name, 'Vendor') AS vendor_name
       FROM vendor_listings vl
       LEFT JOIN vendor_organizations vo ON vo.id = vl.vendor_org_id
       LEFT JOIN users u ON u.id = vl.created_by
       WHERE COALESCE(vl.featured_status, 'none') = 'pending'
       ORDER BY vl.featured_requested_at DESC, vl.updated_at DESC`
    );
    return res.json(rows || []);
  } catch (err) {
    return next(err);
  }
});

/** Admin: all marketplace listings for a vendor organization (any workflow state). */
router.get(
  '/admin/vendor-org/:orgId/listings',
  authMiddleware,
  requireAdmin,
  [param('orgId').isUUID()],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { rows } = await pool.query(
        `SELECT
           vl.id,
           vl.title,
           vl.listing_type,
           vl.category,
           vl.workflow_state,
           vl.price,
           vl.currency,
           vl.location,
           vl.media_url,
           vl.metadata,
           vl.created_at,
           vl.updated_at,
           vl.approved_at,
           vl.rejection_reason,
           vl.created_by,
           vl.vendor_org_id,
           vl.featured_status,
           vl.featured_expires_at
         FROM vendor_listings vl
         WHERE vl.vendor_org_id = $1
         ORDER BY vl.created_at DESC
         LIMIT 500`,
        [req.params.orgId]
      );
      return res.json(rows || []);
    } catch (err) {
      return next(err);
    }
  }
);

router.patch(
  '/admin/feature-requests/:id',
  authMiddleware,
  requireAdmin,
  [
    paramVendorListingId(),
    body('action').isIn(['approve', 'reject']),
    body('rejection_reason').optional().trim().isLength({ max: 1000 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { rows: existingRows } = await pool.query('SELECT * FROM vendor_listings WHERE id = $1', [req.params.id]);
      if (!existingRows.length) return res.status(404).json({ error: 'Vendor listing not found' });
      const existing = existingRows[0];
      if (String(existing.featured_status || 'none') !== 'pending') {
        return res.status(400).json({ error: 'This listing has no pending featured request' });
      }

      const action = String(req.body.action || '');
      if (action === 'approve') {
        const boostDays = resolveFeaturedDurationDays(existing);
        const expiresAt = addDaysIso(boostDays);
        await pool.query(
          `UPDATE vendor_listings
           SET featured_status = 'active',
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
          `UPDATE vendor_listings
           SET featured_status = 'rejected',
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
        action: 'vendor_listing_feature_review',
        resourceType: 'vendor_listing',
        resourceId: req.params.id,
        details: JSON.stringify({ action, rejection_reason: req.body.rejection_reason || null }),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      const { rows } = await pool.query('SELECT * FROM vendor_listings WHERE id = $1', [req.params.id]);
      return res.json(rows[0]);
    } catch (err) {
      return next(err);
    }
  }
);

router.post(
  '/upload-image',
  authMiddleware,
  requireActiveVendorBusiness({ enforce: false }),
  requireVendorOrAdmin,
  vendorListingUpload.single('image'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

      if (req.userRole === 'vendor') {
        const mod = await assertVendorOrgModuleEnabled(pool, req.userId, 'marketplace');
        if (!mod.ok) return res.status(403).json({ error: mod.error });
      }

      let mediaUrl = null;
      if (isS3Configured()) {
        const ext = (path.extname(req.file.originalname || '') || '.bin').toLowerCase();
        const key = `vendor-listings/${uuidv4()}${ext}`;
        mediaUrl = await uploadToS3(req.file.buffer, key, req.file.mimetype || 'application/octet-stream');
      }
      if (!mediaUrl) {
        mediaUrl = `/uploads/vendor-listings/${req.file.filename}`;
      }

      return res.status(201).json({
        media_url: mediaUrl,
        mime_type: req.file.mimetype || null,
        size_bytes: req.file.size || null,
      });
    } catch (err) {
      return next(err);
    }
  }
);

router.post(
  '/',
  authMiddleware,
  requireActiveVendorBusiness({ enforce: false }),
  requireVendorOrAdmin,
  [
    body('listing_type').isIn(['material', 'service']),
    body('title').trim().notEmpty().isLength({ max: 255 }),
    body('description').optional().trim(),
    body('category').optional().trim().isLength({ max: 120 }),
    body('price').optional().isFloat({ min: 0 }),
    body('currency').optional().trim().isLength({ min: 3, max: 10 }),
    body('location').optional().trim().isLength({ max: 255 }),
    body('media_url').optional().trim().isLength({ max: 2000 }),
    body('image_urls').optional().isArray({ min: 1, max: 5 }),
    body('image_urls.*').optional().isString().trim().isLength({ min: 1, max: 2000 }),
    body('workflow_state').optional().isIn(['draft', 'pending_review']),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      if (req.userRole === 'vendor') {
        const mod = await assertVendorOrgModuleEnabled(pool, req.userId, 'marketplace');
        if (!mod.ok) return res.status(403).json({ error: mod.error });
      }

      const {
        listing_type,
        category = null,
        title,
        description = null,
        price = null,
        currency = 'USD',
        location = null,
        media_url = null,
        image_urls = [],
        workflow_state = req.userRole === 'vendor' ? 'pending_review' : 'draft',
      } = req.body;

      const normalizedImageUrls = normalizeImageUrls(image_urls);
      if (req.userRole === 'vendor' && workflow_state === 'pending_review') {
        if (normalizedImageUrls.length < 3 || normalizedImageUrls.length > 5) {
          return res.status(400).json({
            error: 'Please upload between 3 and 5 images before submitting for review.',
          });
        }
      }

      const primaryMediaUrl =
        (typeof media_url === 'string' && media_url.trim()) ||
        normalizedImageUrls[0] ||
        null;
      const metadata = normalizedImageUrls.length ? { image_urls: normalizedImageUrls } : null;

      const id = uuidv4();
      const { rows: meRows } = await pool.query('SELECT vendor_org_id FROM users WHERE id = $1', [req.userId]);
      const vendorOrgId = meRows[0]?.vendor_org_id || null;

      await pool.query(
        `INSERT INTO vendor_listings
          (id, vendor_org_id, created_by, listing_type, category, title, description, price, currency, location, media_url, workflow_state, submitted_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          id,
          vendorOrgId,
          req.userId,
          listing_type,
          category,
          title,
          description,
          price,
          currency,
          location,
          primaryMediaUrl,
          workflow_state,
          workflow_state === 'pending_review' ? new Date().toISOString() : null,
          metadata ? JSON.stringify(metadata) : null,
        ]
      );

      logAudit({
        userId: req.userId,
        action: 'vendor_listing_create',
        resourceType: 'vendor_listing',
        resourceId: id,
        details: JSON.stringify({ listing_type, workflow_state }),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      const { rows } = await pool.query('SELECT * FROM vendor_listings WHERE id = $1', [id]);
      res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/:id',
  authMiddleware,
  requireActiveVendorBusiness({ enforce: false }),
  requireVendorOrAdmin,
  [
    paramVendorListingId(),
    body('title').optional().trim().notEmpty().isLength({ max: 255 }),
    body('description').optional().trim(),
    body('category').optional().trim().isLength({ max: 120 }),
    body('price').optional().isFloat({ min: 0 }),
    body('currency').optional().trim().isLength({ min: 3, max: 10 }),
    body('location').optional().trim().isLength({ max: 255 }),
    body('media_url').optional().trim().isLength({ max: 2000 }),
    body('image_urls').optional().isArray({ min: 1, max: 5 }),
    body('image_urls.*').optional().isString().trim().isLength({ min: 1, max: 2000 }),
    body('workflow_state').optional().isIn(['draft', 'pending_review', 'published', 'unpublished']),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { rows: existingRows } = await pool.query('SELECT * FROM vendor_listings WHERE id = $1', [req.params.id]);
      if (!existingRows.length) return res.status(404).json({ error: 'Vendor listing not found' });
      const existing = existingRows[0];

      if (req.userRole === 'vendor') {
        const mod = await assertVendorOrgModuleEnabled(pool, req.userId, 'marketplace');
        if (!mod.ok) return res.status(403).json({ error: mod.error });
      }

      if (!canManageListing(req.userRole, req.userId, existing)) {
        return res.status(403).json({ error: "You don't have permission to do that." });
      }

      const updates = {};
      const fields = ['title', 'description', 'category', 'price', 'currency', 'location', 'media_url'];
      for (const f of fields) {
        if (req.body[f] !== undefined) updates[f] = req.body[f];
      }
      if (req.body.image_urls !== undefined) {
        const normalized = normalizeImageUrls(req.body.image_urls);
        const existingMeta = parseMetadataObject(existing.metadata);
        existingMeta.image_urls = normalized;
        updates.metadata = JSON.stringify(existingMeta);
        if (updates.media_url === undefined && normalized.length > 0) {
          updates.media_url = normalized[0];
        }
      }

      if (req.body.workflow_state !== undefined) {
        const requestedState = req.body.workflow_state;
        if (req.userRole === 'vendor') {
          const allowed = new Set(['draft', 'pending_review', 'unpublished']);
          if (!allowed.has(requestedState)) {
            return res.status(403).json({ error: 'Vendors cannot set this workflow state directly' });
          }
        }
        if (requestedState === 'pending_review') {
          const candidateImageUrls = extractListingImageUrls(existing, req.body.image_urls);
          if (candidateImageUrls.length < 3 || candidateImageUrls.length > 5) {
            return res.status(400).json({
              error: 'Please upload between 3 and 5 images before submitting for review.',
            });
          }
        }
        updates.workflow_state = requestedState;
        if (requestedState === 'pending_review') updates.submitted_at = new Date().toISOString();
      }

      if (!Object.keys(updates).length) return res.status(400).json({ error: 'No fields to update' });

      const setClause = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
      const values = Object.values(updates);
      await pool.query(
        `UPDATE vendor_listings
         SET ${setClause}, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [req.params.id, ...values]
      );

      const { rows } = await pool.query('SELECT * FROM vendor_listings WHERE id = $1', [req.params.id]);
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/:id/review',
  authMiddleware,
  requireAdmin,
  [
    paramVendorListingId(),
    body('action').isIn(['approve', 'reject']),
    body('rejection_reason').optional().trim().isLength({ max: 2000 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { rows: existingRows } = await pool.query('SELECT * FROM vendor_listings WHERE id = $1', [req.params.id]);
      if (!existingRows.length) return res.status(404).json({ error: 'Vendor listing not found' });
      const existing = existingRows[0];

      const action = req.body.action;
      if (action === 'approve') {
        const publishEligible = await isVendorListingPublishEligible(req.params.id);
        if (!publishEligible) {
          return res.status(400).json({
            error:
              'Seller is not verified for publishing. Approve the vendor account (registrations) and/or set their company to approved under Vendor organizations.',
            reason_code: 'VENDOR_VERIFICATION_REQUIRED',
          });
        }
        const listingImageUrls = extractListingImageUrls(existing);
        if (listingImageUrls.length < 3 || listingImageUrls.length > 5) {
          return res.status(400).json({
            error: 'Listing must include 3 to 5 images before approval.',
          });
        }
        await pool.query(
          `UPDATE vendor_listings
           SET workflow_state = 'published',
               approved_by = $1,
               approved_at = CURRENT_TIMESTAMP,
               rejection_reason = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [req.userId, req.params.id]
        );
      } else {
        await pool.query(
          `UPDATE vendor_listings
           SET workflow_state = 'rejected',
               approved_by = $1,
               approved_at = CURRENT_TIMESTAMP,
               rejection_reason = $2,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [req.userId, req.body.rejection_reason || null, req.params.id]
        );
      }

      logAudit({
        userId: req.userId,
        action: 'vendor_listing_review',
        resourceType: 'vendor_listing',
        resourceId: req.params.id,
        details: JSON.stringify({ action, rejection_reason: req.body.rejection_reason || null }),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      const { rows } = await pool.query('SELECT * FROM vendor_listings WHERE id = $1', [req.params.id]);
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

router.get('/admin/review-queue', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         id,
         'vendor_listing' AS source_type,
         listing_type,
         title,
         description,
         location,
         media_url,
         metadata,
         created_by,
         created_at,
         updated_at
       FROM vendor_listings
       WHERE workflow_state = 'pending_review'
       ORDER BY updated_at DESC, created_at DESC`
    );

    res.json(rows || []);
  } catch (err) {
    next(err);
  }
});

router.get('/admin/reviews', authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    const status = String(req.query.status || '').trim();
    const params = [];
    let where = '';
    if (status) {
      params.push(status);
      where = `WHERE COALESCE(vr.moderation_status, 'visible') = $1`;
    }

    try {
      const { rows } = await pool.query(
        `SELECT
           vr.id,
           vr.vendor_profile_id,
           vr.vendor_profile_type,
           COALESCE(vo.legal_name, vu.full_name, 'Vendor') AS vendor_name,
           reviewer.full_name AS reviewer_name,
           vr.rating,
           vr.comment,
           COALESCE(vr.moderation_status, 'visible') AS moderation_status,
           vr.moderation_reason,
           COALESCE(vr.reports_count, 0) AS reports_count,
           vr.created_at,
           vr.moderated_at,
           moderator.full_name AS moderated_by_name
         FROM vendor_reviews vr
         LEFT JOIN vendor_organizations vo
           ON vr.vendor_profile_type = 'organization' AND vo.id = vr.vendor_profile_id
         LEFT JOIN users vu
           ON vr.vendor_profile_type = 'user' AND vu.id = vr.vendor_profile_id
         LEFT JOIN users reviewer ON reviewer.id = vr.reviewer_user_id
         LEFT JOIN users moderator ON moderator.id = vr.moderated_by
         ${where}
         ORDER BY
           CASE COALESCE(vr.moderation_status, 'visible')
             WHEN 'flagged' THEN 0
             WHEN 'hidden' THEN 1
             ELSE 2
           END,
           COALESCE(vr.reports_count, 0) DESC,
           vr.created_at DESC`,
        params
      );
      return res.json(rows || []);
    } catch (primaryErr) {
      const statusLc = status.toLowerCase();
      if (statusLc && statusLc !== 'visible') {
        // On older schemas without moderation columns, hidden/flagged have no representation.
        return res.json([]);
      }
      try {
        const { rows } = await pool.query(
          `SELECT
             vr.id,
             vr.vendor_profile_id,
             'user' AS vendor_profile_type,
             COALESCE(vu.full_name, 'Vendor') AS vendor_name,
             reviewer.full_name AS reviewer_name,
             vr.rating,
             vr.comment,
             'visible' AS moderation_status,
             NULL AS moderation_reason,
             0 AS reports_count,
             vr.created_at,
             NULL AS moderated_at,
             NULL AS moderated_by_name
           FROM vendor_reviews vr
           LEFT JOIN users reviewer ON reviewer.id = vr.reviewer_user_id
           LEFT JOIN users vu ON vu.id = vr.vendor_profile_id
           ORDER BY vr.created_at DESC
           LIMIT 500`
        );
        return res.json(rows || []);
      } catch (_) {
        return res.json([]);
      }
    }
  } catch (err) {
    next(err);
  }
});

router.patch('/admin/reviews/:id/moderate', authMiddleware, requireAdmin, [
  body('action').isIn(['hide', 'restore', 'flag']),
  body('reason').optional().trim(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { id } = req.params;
    const action = String(req.body.action || '');
    const reason = req.body.reason ? String(req.body.reason).trim() : null;
    const nextStatus = action === 'hide' ? 'hidden' : action === 'restore' ? 'visible' : 'flagged';

    const { rows: existingRows } = await pool.query('SELECT id FROM vendor_reviews WHERE id = $1', [id]);
    if (!existingRows.length) return res.status(404).json({ error: 'Review not found' });

    await pool.query(
      `UPDATE vendor_reviews
       SET moderation_status = $1,
           moderation_reason = $2,
           moderated_by = $3,
           moderated_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [nextStatus, reason, req.userId, id]
    );

    logAudit({
      userId: req.userId,
      action: 'vendor_review_moderate',
      resourceType: 'vendor_review',
      resourceId: id,
      details: JSON.stringify({ action, moderation_status: nextStatus, reason }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    const { rows } = await pool.query(
      `SELECT
         vr.id,
         vr.vendor_profile_id,
         vr.vendor_profile_type,
         COALESCE(vo.legal_name, vu.full_name, 'Vendor') AS vendor_name,
         reviewer.full_name AS reviewer_name,
         vr.rating,
         vr.comment,
         COALESCE(vr.moderation_status, 'visible') AS moderation_status,
         vr.moderation_reason,
         COALESCE(vr.reports_count, 0) AS reports_count,
         vr.created_at,
         vr.moderated_at,
         moderator.full_name AS moderated_by_name
       FROM vendor_reviews vr
       LEFT JOIN vendor_organizations vo
         ON vr.vendor_profile_type = 'organization' AND vo.id = vr.vendor_profile_id
       LEFT JOIN users vu
         ON vr.vendor_profile_type = 'user' AND vu.id = vr.vendor_profile_id
       LEFT JOIN users reviewer ON reviewer.id = vr.reviewer_user_id
       LEFT JOIN users moderator ON moderator.id = vr.moderated_by
       WHERE vr.id = $1`,
      [id]
    );

    res.json(rows[0]);
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('column') || msg.includes('does not exist')) {
      return res.status(503).json({
        error: 'Review moderation fields are not available yet. Run the latest database migration and try again.',
      });
    }
    next(err);
  }
});

export default router;
