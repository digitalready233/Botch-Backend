import express from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../db/index.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { requireActiveVendorBusiness } from '../middleware/vendor-business.js';
import { assertVendorOrgModuleEnabled } from '../lib/vendor-org-modules.js';
import { assertVendorChannelSubscriptionActive } from '../lib/vendor-channel-subscriptions.js';
import { body, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import { getUploadsBase } from '../lib/upload-paths.js';
import { uploadToS3, isS3Configured } from '../lib/s3.js';
import { fileFilter, ALLOWED_IMAGE_MIMES } from '../lib/upload-validation.js';
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
import { sqlPropertyGalleryUrlsSubquery } from '../lib/db-dialect.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** True when the listing creator belongs to at least one partner vendor org (p = properties alias). */
const creatorHasPartnerOrgSql = `EXISTS (
  SELECT 1 FROM vendor_memberships vm_p
  INNER JOIN vendor_organizations vo_p ON vo_p.id = vm_p.vendor_org_id
  WHERE vm_p.user_id = p.created_by
    AND (vo_p.is_partner = 1 OR LOWER(CAST(vo_p.is_partner AS TEXT)) IN ('true', '1'))
)`;

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

const rentalImagesDir = path.join(getUploadsBase(path.join(__dirname, '..', '..', 'uploads')), 'rental-images');
try { fs.mkdirSync(rentalImagesDir, { recursive: true }); } catch (_) {}

const rentalDiskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, rentalImagesDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.bin';
    cb(null, `rental-${uuidv4()}${ext}`);
  },
});
const rentalMemoryStorage = multer.memoryStorage();
const rentalUpload = multer({
  storage: isS3Configured() ? rentalMemoryStorage : rentalDiskStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: fileFilter(ALLOWED_IMAGE_MIMES, 'Rental image'),
});

function toSlug(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
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

async function ensureUniqueSlug(base, excludeId = null) {
  let slug = base || `rental-${Date.now()}`;
  let i = 1;
  // Small bounded loop to avoid collisions.
  while (i < 50) {
    const { rows } = await pool.query(
      excludeId
        ? 'SELECT id FROM properties WHERE slug = $1 AND id <> $2 LIMIT 1'
        : 'SELECT id FROM properties WHERE slug = $1 LIMIT 1',
      excludeId ? [slug, excludeId] : [slug]
    );
    if (rows.length === 0) return slug;
    i += 1;
    slug = `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}

/** Public rentals listing */
router.get('/', async (req, res, next) => {
  try {
    const {
      q,
      location,
      region,
      city,
      min_price,
      max_price,
      property_type,
      bedrooms,
      rent_type,
      furnished,
      featured,
      is_featured,
      is_botch,
      is_others,
    } = req.query;

    const pub = publicPropertyFilterSql('p.');
    let sql = `
      SELECT p.*, u.role as creator_role, u.full_name as creator_name,
             (SELECT CASE WHEN ${creatorHasPartnerOrgSql} THEN 1 ELSE 0 END) AS is_partner_org,
             ${propertyVendorBrandingSql}
      FROM properties p
      LEFT JOIN users u ON u.id = p.created_by
      WHERE p.listing_purpose = 'rent' AND ${pub}
    `;
    const params = [];
    let idx = 1;

    if (is_featured === '1' || is_featured === 'true' || featured === 'true') {
      sql += ` AND (
        (p.featured = 1 OR LOWER(CAST(p.featured AS TEXT)) IN ('true', '1'))
        OR (
          COALESCE(p.featured_status, 'none') = 'active'
          AND (p.featured_expires_at IS NULL OR p.featured_expires_at > CURRENT_TIMESTAMP)
        )
      )`;
    }
    if (is_botch === '1' || is_botch === 'true') {
      sql += ` AND (u.role IN ('admin', 'super_admin') OR ${creatorHasPartnerOrgSql} OR u.id = 'a0000000-0000-0000-0000-000000000003')`;
    }
    if (is_others === '1' || is_others === 'true') {
      sql += ` AND u.id IS NOT NULL
        AND u.role IN ('vendor', 'vendor_admin')
        AND u.id <> 'a0000000-0000-0000-0000-000000000003'
        AND NOT (${creatorHasPartnerOrgSql})`;
    }

    if (q && String(q).trim()) {
      const term = `%${String(q).trim()}%`;
      sql += ` AND (p.title LIKE $${idx} OR p.description LIKE $${idx} OR p.short_description LIKE $${idx} OR p.location LIKE $${idx} OR p.area LIKE $${idx} OR COALESCE(p.region,'') LIKE $${idx} OR COALESCE(p.city,'') LIKE $${idx} OR COALESCE(p.address,'') LIKE $${idx})`;
      params.push(term);
      idx += 1;
    }
    if (location && String(location).trim()) {
      sql += ` AND (p.location LIKE $${idx} OR p.area LIKE $${idx} OR p.address LIKE $${idx} OR COALESCE(p.region,'') LIKE $${idx} OR COALESCE(p.city,'') LIKE $${idx})`;
      params.push(`%${String(location).trim()}%`);
      idx += 1;
    }
    if (region && String(region).trim()) {
      const term = `%${String(region).trim()}%`;
      sql += ` AND (COALESCE(p.region,'') LIKE $${idx} OR COALESCE(p.area,'') LIKE $${idx})`;
      params.push(term);
      idx += 1;
    }
    if (city && String(city).trim()) {
      const term = `%${String(city).trim()}%`;
      sql += ` AND (COALESCE(p.city,'') LIKE $${idx} OR COALESCE(p.location,'') LIKE $${idx})`;
      params.push(term);
      idx += 1;
    }
    const minP = parseFloat(min_price);
    if (!Number.isNaN(minP) && minP >= 0) {
      sql += ` AND p.price >= $${idx}`;
      params.push(minP);
      idx += 1;
    }
    const maxP = parseFloat(max_price);
    if (!Number.isNaN(maxP) && maxP >= 0) {
      sql += ` AND p.price <= $${idx}`;
      params.push(maxP);
      idx += 1;
    }
    if (property_type && String(property_type).trim()) {
      sql += ` AND p.property_type = $${idx}`;
      params.push(String(property_type).trim().toLowerCase());
      idx += 1;
    }
    const beds = parseInt(bedrooms, 10);
    if (!Number.isNaN(beds) && beds >= 0) {
      sql += ` AND p.bedrooms >= $${idx}`;
      params.push(beds);
      idx += 1;
    }
    if (rent_type && String(rent_type).trim()) {
      sql += ` AND p.rent_type = $${idx}`;
      params.push(String(rent_type).trim());
      idx += 1;
    }
    if (furnished && String(furnished).trim()) {
      sql += ` AND p.furnished_status = $${idx}`;
      params.push(String(furnished).trim());
      idx += 1;
    }

    sql += ` ORDER BY (
      CASE
        WHEN COALESCE(p.featured_status, 'none') = 'active'
          AND (p.featured_expires_at IS NULL OR p.featured_expires_at > CURRENT_TIMESTAMP) THEN 1
        WHEN p.featured = 1 OR LOWER(CAST(p.featured AS TEXT)) IN ('true', '1') THEN 1
        ELSE 0
      END
    ) DESC, p.created_at DESC`;

    const limit = parseInt(req.query.limit, 10);
    if (!Number.isNaN(limit) && limit > 0) sql += ` LIMIT ${Math.min(limit, 60)}`;

    let rows;
    try {
      ({ rows } = await pool.query(sql, params));
    } catch (primaryErr) {
      const msg = String(primaryErr?.message || '').toLowerCase();
      const missingJoinOrColumn =
        msg.includes('no such column') ||
        msg.includes('does not exist');
      if (!missingJoinOrColumn) throw primaryErr;

      // Backward-compatible fallback
      const pubL = publicPropertyFilterSql('');
      let legacySql = `SELECT * FROM properties WHERE listing_purpose = 'rent' AND ${pubL}`;
      const legacyParams = [];
      let legacyIdx = 1;

      if (is_featured === '1' || is_featured === 'true' || featured === 'true') {
        legacySql += ` AND featured = 1`;
      }

      if (q && String(q).trim()) {
        const term = `%${String(q).trim()}%`;
        legacySql += ` AND (title LIKE $${legacyIdx} OR description LIKE $${legacyIdx} OR short_description LIKE $${legacyIdx} OR location LIKE $${legacyIdx} OR area LIKE $${legacyIdx} OR COALESCE(address,'') LIKE $${legacyIdx})`;
        legacyParams.push(term);
        legacyIdx += 1;
      }
      if (location && String(location).trim()) {
        legacySql += ` AND (location LIKE $${legacyIdx} OR area LIKE $${legacyIdx} OR address LIKE $${legacyIdx})`;
        legacyParams.push(`%${String(location).trim()}%`);
        legacyIdx += 1;
      }
      // ... (other filters)
      const minP2 = parseFloat(min_price);
      if (!Number.isNaN(minP2) && minP2 >= 0) {
        legacySql += ` AND price >= $${legacyIdx}`;
        legacyParams.push(minP2);
        legacyIdx += 1;
      }
      const maxP2 = parseFloat(max_price);
      if (!Number.isNaN(maxP2) && maxP2 >= 0) {
        legacySql += ` AND price <= $${legacyIdx}`;
        legacyParams.push(maxP2);
        legacyIdx += 1;
      }
      if (property_type && String(property_type).trim()) {
        legacySql += ` AND property_type = $${legacyIdx}`;
        legacyParams.push(String(property_type).trim().toLowerCase());
        legacyIdx += 1;
      }
      const beds2 = parseInt(bedrooms, 10);
      if (!Number.isNaN(beds2) && beds2 >= 0) {
        legacySql += ` AND bedrooms >= $${legacyIdx}`;
        legacyParams.push(beds2);
        legacyIdx += 1;
      }
      if (rent_type && String(rent_type).trim()) {
        legacySql += ` AND rent_type = $${legacyIdx}`;
        legacyParams.push(String(rent_type).trim());
        legacyIdx += 1;
      }
      if (furnished && String(furnished).trim()) {
        legacySql += ` AND furnished_status = $${legacyIdx}`;
        legacyParams.push(String(furnished).trim());
        legacyIdx += 1;
      }
      legacySql += ' ORDER BY featured DESC, created_at DESC';
      const legacyLimit = parseInt(req.query.limit, 10);
      if (!Number.isNaN(legacyLimit) && legacyLimit > 0) {
        legacySql += ` LIMIT ${Math.min(legacyLimit, 60)}`;
      }
      ({ rows } = await pool.query(legacySql, legacyParams));
    }
    res.json(rows || []);
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/rentals/mine — listings for current user (or all if admin) */
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
         WHERE p.listing_purpose = 'rent'
         ORDER BY p.updated_at DESC, p.created_at DESC`
      );
      return res.json(rows || []);
    }

    const { rows } = await pool.query(
      `SELECT p.*, u.full_name AS creator_name, ${gallerySql}
       FROM properties p
       LEFT JOIN users u ON u.id = p.created_by
       WHERE p.listing_purpose = 'rent' AND p.created_by = $1
       ORDER BY p.updated_at DESC, p.created_at DESC`,
      [req.userId]
    );
    return res.json(rows || []);
  } catch (err) {
    next(err);
  }
});

/** Admin routes must be registered before /:idOrSlug so paths like /admin/list/all are not captured as slugs */
router.get('/admin/list/all', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM properties WHERE listing_purpose = 'rent' ORDER BY updated_at DESC, created_at DESC"
    );
    res.json(rows || []);
  } catch (err) {
    next(err);
  }
});

router.get('/admin/workflow-meta', authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    res.json({
      states: [...LISTING_STATE_VALUES],
      role: req.userRole,
      listing_purpose: 'rent',
      transitionsByFrom: Object.fromEntries(
        LISTING_STATE_VALUES.map((from) => [
          from,
          allowedListingStateTargets(from, req.userRole, 'rent'),
        ])
      ),
    });
  } catch (err) {
    next(err);
  }
});

/** Public rental details by id or slug */
router.get('/:idOrSlug', async (req, res, next) => {
  try {
    const key = String(req.params.idOrSlug || '').trim();
    const pub = publicPropertyFilterSql('');
    const byId = await pool.query(
      `SELECT * FROM properties WHERE id = $1 AND listing_purpose = 'rent' AND ${pub}`,
      [key]
    );
    let row = byId.rows[0];
    if (!row) {
      const bySlug = await pool.query(
        `SELECT * FROM properties WHERE slug = $1 AND listing_purpose = 'rent' AND ${pub}`,
        [key]
      );
      row = bySlug.rows[0];
    }
    if (!row) return res.status(404).json({ error: 'Rental not found' });

    const { rows: imgRows } = await pool.query(
      'SELECT id, file_url, sort_order FROM property_images WHERE property_id = $1 ORDER BY sort_order ASC, created_at ASC',
      [row.id]
    );
    const images = imgRows || [];
    if (row.image_url && images.every((img) => img.file_url !== row.image_url)) {
      images.unshift({ id: null, file_url: row.image_url, sort_order: 0 });
    }
    res.json({ ...row, images });
  } catch (err) {
    next(err);
  }
});

/** Create rental (admin or vendor; vendor submissions default to pending review) */
router.post(
  '/',
  authMiddleware,
  requireActiveVendorBusiness({ enforce: false }),
  [
    body('title').trim().notEmpty(),
    body('description').optional().trim(),
    body('short_description').optional().trim(),
    body('property_type').optional().isIn(['apartment', 'villa', 'house', 'cabin', 'treehouse', 'other']),
    body('rent_type').optional().isIn(['short_stay', 'long_term']),
    body('bedrooms').optional().isInt({ min: 0 }),
    body('bathrooms').optional().isInt({ min: 0 }),
    body('price').isFloat({ min: 0 }),
    body('currency').optional().trim(),
    body('location').optional().trim(),
    body('area').optional().trim(),
    body('image_url').optional().trim(),
    body('sub_images').optional().isArray({ max: 30 }),
    body('furnished_status').optional().isIn(['furnished', 'unfurnished', 'part_furnished']),
    body('listing_state').optional().isIn(['draft', 'pending_review']),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const isAdminRole = req.userRole === 'admin' || req.userRole === 'super_admin';
      if (!isAdminRole && req.userRole !== 'vendor') {
        return res.status(403).json({ error: "You don't have permission to do that." });
      }
      if (req.userRole === 'vendor') {
        const mod = await assertVendorOrgModuleEnabled(pool, req.userId, 'rentals');
        if (!mod.ok) return res.status(403).json({ error: mod.error });
        const sub = await assertVendorChannelSubscriptionActive(pool, req.userId, 'rentals');
        if (!sub.ok) {
          return res.status(sub.status || 403).json({ error: sub.error, code: sub.code, channel: sub.channel });
        }
      }
      const id = uuidv4();
      const b = req.body || {};
      const listingState =
        b.listing_state ||
        (req.userRole === 'vendor' ? LISTING_STATES.PENDING_REVIEW : LISTING_STATES.DRAFT);
      const initCheck = validateInitialListingState(listingState, req.userRole);
      if (!initCheck.ok) return res.status(400).json({ error: initCheck.error });
      const sync = getSyncedColumnsForListingState(listingState);
      const slugBase = toSlug(b.slug || b.title);
      const slug = await ensureUniqueSlug(slugBase);
      const amenitiesStr = typeof b.amenities === 'string'
        ? b.amenities
        : (Array.isArray(b.amenities) ? JSON.stringify(b.amenities) : null);

      const featured = req.userRole === 'vendor' ? 0 : (b.featured ? 1 : 0);
      const isNew = req.userRole === 'vendor' ? 0 : (b.is_new ? 1 : 0);

      await pool.query(
        `INSERT INTO properties
          (id, title, slug, description, short_description, property_type, listing_purpose, rent_type,
           bedrooms, bathrooms, location, area, region, city, address, square_footage, price, currency,
           image_url, amenities, furnished_status, availability_status, featured, is_new,
           listing_state, moderation_status, publish_status, status, created_by, updated_at)
         VALUES
          ($1, $2, $3, $4, $5, $6, 'rent', $7,
           $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
           $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, CURRENT_TIMESTAMP)`,
        [
          id,
          b.title,
          slug,
          b.description || null,
          b.short_description || null,
          b.property_type || 'apartment',
          b.rent_type || 'long_term',
          b.bedrooms ?? 0,
          b.bathrooms ?? 1,
          b.location || null,
          b.area || null,
          b.region || null,
          b.city || null,
          b.address || null,
          b.square_footage ?? null,
          b.price,
          (b.currency || 'USD').toUpperCase(),
          b.image_url || null,
          amenitiesStr,
          b.furnished_status || null,
          sync.availability_status,
          featured,
          isNew,
          listingState,
          sync.moderation_status,
          sync.publish_status,
          sync.status,
          req.userId || null,
        ]
      );
      const mainImageUrl = typeof b.image_url === 'string' ? b.image_url.trim() : '';
      const subImageUrls = normalizeSubImageUrls(b.sub_images).filter((url) => url !== mainImageUrl);
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
  }
);

function isAdminRole(role) {
  return role === 'admin' || role === 'super_admin';
}

/** PATCH /api/v1/rentals/:id — admin or owner vendor */
router.patch('/:id', authMiddleware, requireActiveVendorBusiness({ enforce: false }), async (req, res, next) => {
  try {
    if (!isAdminRole(req.userRole) && req.userRole !== 'vendor') {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }
    const id = req.params.id;
    const b = req.body || {};
    const {
      title,
      description,
      short_description,
      property_type,
      rent_type,
      bedrooms,
      bathrooms,
      location,
      area,
      region,
      city,
      address,
      square_footage,
      price,
      currency,
      image_url,
      furnished_status,
      amenities,
      listing_state: listingStateNew,
      sub_images,
      ownership_proof_url,
      mandate_proof_url,
      authenticity_status,
      authenticity_notes,
      moderation_status: modNew,
      publish_status: pubNew,
      status: legacyNew,
      availability_status: avNew,
    } = b;
    const hasLegacyWorkflow =
      modNew !== undefined || pubNew !== undefined || legacyNew !== undefined || avNew !== undefined;
    if (hasLegacyWorkflow) {
      return res.status(400).json({
        error:
          'Use listing_state for workflow changes. moderation_status, publish_status, status, and availability_status are derived from listing_state.',
      });
    }

    const { rows: existingRows } = await pool.query("SELECT * FROM properties WHERE id = $1 AND listing_purpose = 'rent'", [id]);
    if (!existingRows.length) return res.status(404).json({ error: 'Rental not found' });
    const row = existingRows[0];

    if (req.userRole === 'vendor') {
      const mod = await assertVendorOrgModuleEnabled(pool, req.userId, 'rentals');
      if (!mod.ok) return res.status(403).json({ error: mod.error });
      if (String(row.created_by || '') !== String(req.userId)) {
        return res.status(403).json({ error: "You don't have permission to do that." });
      }
    }

    if ((authenticity_status !== undefined || authenticity_notes !== undefined) && !isAdminRole(req.userRole)) {
      return res.status(403).json({ error: 'Only administrators can update authenticity review status' });
    }

    const updates = [];
    const params = [];
    let idx = 1;

    if (title !== undefined) {
      updates.push(`title = $${idx}`);
      params.push(title);
      idx++;
    }
    if (description !== undefined) {
      updates.push(`description = $${idx}`);
      params.push(description);
      idx++;
    }
    if (short_description !== undefined) {
      updates.push(`short_description = $${idx}`);
      params.push(short_description);
      idx++;
    }
    if (property_type !== undefined) {
      updates.push(`property_type = $${idx}`);
      params.push(property_type);
      idx++;
    }
    if (rent_type !== undefined) {
      updates.push(`rent_type = $${idx}`);
      params.push(rent_type);
      idx++;
    }
    if (bedrooms !== undefined) {
      updates.push(`bedrooms = $${idx}`);
      params.push(bedrooms);
      idx++;
    }
    if (bathrooms !== undefined) {
      updates.push(`bathrooms = $${idx}`);
      params.push(bathrooms);
      idx++;
    }
    if (location !== undefined) {
      updates.push(`location = $${idx}`);
      params.push(location);
      idx++;
    }
    if (area !== undefined) {
      updates.push(`area = $${idx}`);
      params.push(area);
      idx++;
    }
    if (region !== undefined) {
      updates.push(`region = $${idx}`);
      params.push(region);
      idx++;
    }
    if (city !== undefined) {
      updates.push(`city = $${idx}`);
      params.push(city);
      idx++;
    }
    if (address !== undefined) {
      updates.push(`address = $${idx}`);
      params.push(address);
      idx++;
    }
    if (square_footage !== undefined) {
      updates.push(`square_footage = $${idx}`);
      params.push(square_footage);
      idx++;
    }
    if (price !== undefined) {
      updates.push(`price = $${idx}`);
      params.push(price);
      idx++;
    }
    if (currency !== undefined) {
      updates.push(`currency = $${idx}`);
      params.push(String(currency || 'USD').toUpperCase());
      idx++;
    }
    if (image_url !== undefined) {
      updates.push(`image_url = $${idx}`);
      params.push(image_url);
      idx++;
    }
    if (furnished_status !== undefined) {
      updates.push(`furnished_status = $${idx}`);
      params.push(furnished_status);
      idx++;
    }
    if (isAdminRole(req.userRole)) {
      if (b.featured !== undefined) {
        updates.push(`featured = $${idx}`);
        params.push(b.featured ? 1 : 0);
        idx++;
      }
      if (b.is_new !== undefined) {
        updates.push(`is_new = $${idx}`);
        params.push(b.is_new ? 1 : 0);
        idx++;
      }
    }

    if (amenities !== undefined) {
      const amenitiesStr = typeof amenities === 'string' ? amenities : (Array.isArray(amenities) ? JSON.stringify(amenities) : null);
      updates.push(`amenities = $${idx}`);
      params.push(amenitiesStr);
      idx++;
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
      updates.push(`authenticity_status = $${idx}`);
      params.push('pending');
      idx++;
    }

    if (listingStateNew !== undefined) {
      if (!LISTING_STATE_VALUES.includes(listingStateNew)) {
        return res.status(400).json({ error: 'Invalid listing_state' });
      }
      const from = normalizeListingState(row);
      const effectiveOwnershipProofUrl =
        ownership_proof_url !== undefined ? normalizeProofUrl(ownership_proof_url) : row.ownership_proof_url;
      const effectiveMandateProofUrl =
        mandate_proof_url !== undefined ? normalizeProofUrl(mandate_proof_url) : row.mandate_proof_url;
      const effectiveAuthenticityStatus =
        authenticity_status !== undefined
          ? authenticity_status
          : req.userRole === 'vendor' &&
              (ownership_proof_url !== undefined || mandate_proof_url !== undefined) &&
              row.authenticity_status !== 'approved'
            ? 'pending'
            : row.authenticity_status;
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
        listingPurpose: 'rent',
      });
      if (!tCheck.ok) return res.status(400).json({ error: tCheck.error });
      const sync = getSyncedColumnsForListingState(listingStateNew);
      updates.push(`listing_state = $${idx}`);
      params.push(listingStateNew);
      idx++;
      updates.push(`moderation_status = $${idx}`);
      params.push(sync.moderation_status);
      idx++;
      updates.push(`publish_status = $${idx}`);
      params.push(sync.publish_status);
      idx++;
      updates.push(`status = $${idx}`);
      params.push(sync.status);
      idx++;
      updates.push(`availability_status = $${idx}`);
      params.push(sync.availability_status);
      idx++;
    }

    if (b.slug !== undefined || title !== undefined) {
      const slugBase = toSlug(b.slug || title || row.title);
      const slug = await ensureUniqueSlug(slugBase, id);
      updates.push(`slug = $${idx}`);
      params.push(slug);
      idx++;
    }

    if (updates.length === 0 && sub_images === undefined) {
      const { rows } = await pool.query('SELECT * FROM properties WHERE id = $1', [id]);
      return res.json(rows[0]);
    }
    if (updates.length > 0) {
      params.push(id);
    await pool.query(
      `UPDATE properties SET ${updates.join(', ')}, listing_purpose = 'rent', updated_at = CURRENT_TIMESTAMP WHERE id = $${idx}`,
      params
    );
    }
    if (sub_images !== undefined) {
      const currentMainImage =
        image_url !== undefined ? (typeof image_url === 'string' ? image_url.trim() : '') : (row.image_url || '');
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

/** Admin upload rental image (cover + gallery) */
router.post('/:id/upload-image', authMiddleware, requireAdmin, rentalUpload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const { rows: rentalRows } = await pool.query(
      "SELECT id FROM properties WHERE id = $1 AND listing_purpose = 'rent' LIMIT 1",
      [req.params.id]
    );
    if (!rentalRows.length) return res.status(404).json({ error: 'Rental not found' });

    let imageUrl = null;
    if (isS3Configured()) {
      const key = `rentals/${req.file.filename || `rental-${uuidv4()}`}`;
      imageUrl = await uploadToS3(req.file.buffer, key, req.file.mimetype || 'application/octet-stream');
    }
    if (!imageUrl) {
      imageUrl = `/uploads/rental-images/${req.file.filename}`;
    }

    await pool.query(
      'UPDATE properties SET image_url = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [imageUrl, req.params.id]
    );

    const { rows: orderRows } = await pool.query(
      'SELECT COALESCE(MAX(sort_order), -1) AS max_sort FROM property_images WHERE property_id = $1',
      [req.params.id]
    );
    const sortOrder = Number(orderRows?.[0]?.max_sort ?? -1) + 1;
    const imageId = uuidv4();
    await pool.query(
      'INSERT INTO property_images (id, property_id, file_url, sort_order) VALUES ($1, $2, $3, $4)',
      [imageId, req.params.id, imageUrl, sortOrder]
    );

    res.status(201).json({ id: imageId, image_url: imageUrl, sort_order: sortOrder });
  } catch (err) {
    next(err);
  }
});

/** Admin delete rental */
router.delete('/:id', authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query("DELETE FROM properties WHERE id = $1 AND listing_purpose = 'rent'", [req.params.id]);
    if ((result.rowCount ?? 0) === 0) return res.status(404).json({ error: 'Rental not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
