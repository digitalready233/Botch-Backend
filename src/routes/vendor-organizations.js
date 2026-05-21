import express from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { body, param, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/index.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';
import { moduleFlagToDb, moduleFlagsForSignupVendorChannel } from '../lib/vendor-org-modules.js';
import { uploadToS3, isS3Configured } from '../lib/s3.js';
import { fileFilter, ALLOWED_IMAGE_MIMES } from '../lib/upload-validation.js';
import { getUploadsBase } from '../lib/upload-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = getUploadsBase(path.join(__dirname, '..', '..', 'uploads'));
const brandingDir = path.join(uploadsDir, 'vendor-branding');
try {
  fs.mkdirSync(brandingDir, { recursive: true });
} catch (_) {}

const BRAND_MAX_BYTES = 5 * 1024 * 1024;
const brandDiskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, brandingDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, uuidv4() + ext);
  },
});
const brandMemoryStorage = multer.memoryStorage();
const brandUpload = multer({
  storage: isS3Configured() ? brandMemoryStorage : brandDiskStorage,
  limits: { fileSize: BRAND_MAX_BYTES },
  fileFilter: fileFilter(ALLOWED_IMAGE_MIMES, 'Branding image'),
});

/** Stored URLs: relative uploads, or http(s) — reject javascript/data. */
function isSafeAssetUrl(s) {
  if (s == null) return true;
  const t = String(s).trim();
  if (!t) return false;
  if (t.length > 2048) return false;
  const lower = t.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('data:')) return false;
  return t.startsWith('/uploads/') || t.startsWith('https://') || t.startsWith('http://');
}

const router = express.Router();
const SALT_ROUNDS = 12;

function isPartnerOrgSql(alias = 'vo') {
  return `(${alias}.is_partner = 1 OR LOWER(CAST(${alias}.is_partner AS TEXT)) IN ('true', '1'))`;
}

function isUniqueEmailError(err) {
  if (!err) return false;
  if (err.code === '23505') return true;
  const code = String(err.code || '');
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
  if (code.includes('SQLITE_CONSTRAINT') && /unique|primary/i.test(String(err.message || ''))) return true;
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('unique constraint failed') || msg.includes('unique failed');
}

router.get('/me', authMiddleware, async (req, res, next) => {
  try {
    if (req.userRole !== 'vendor' && req.userRole !== 'admin' && req.userRole !== 'super_admin') {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }
    const { rows: userRows } = await pool.query(
      'SELECT id, vendor_org_id, full_name, email, phone FROM users WHERE id = $1',
      [req.userId]
    );
    if (!userRows.length) return res.status(404).json({ error: 'User not found' });
    const me = userRows[0];
    if (!me.vendor_org_id) {
      return res.json({
        vendor_org: null,
        primary_contact: {
          user_id: me.id,
          full_name: me.full_name,
          email: me.email,
          phone: me.phone,
        },
      });
    }
    const { rows: orgRows } = await pool.query(
      `SELECT vo.*,
              COUNT(DISTINCT vm.user_id) AS member_count
       FROM vendor_organizations vo
       LEFT JOIN vendor_memberships vm ON vm.vendor_org_id = vo.id
       WHERE vo.id = $1
       GROUP BY vo.id`,
      [me.vendor_org_id]
    );
    const { rows: primaryRows } = await pool.query(
      `SELECT vm.user_id, u.full_name, u.email, u.phone
       FROM vendor_memberships vm
       INNER JOIN users u ON u.id = vm.user_id
       WHERE vm.vendor_org_id = $1 AND (vm.is_primary_contact = 1 OR vm.is_primary_contact = TRUE)
       ORDER BY vm.updated_at DESC
       LIMIT 1`,
      [me.vendor_org_id]
    );
    return res.json({
      vendor_org: orgRows[0] || null,
      primary_contact:
        primaryRows[0] || {
          user_id: me.id,
          full_name: me.full_name,
          email: me.email,
          phone: me.phone,
        },
    });
  } catch (err) {
    next(err);
  }
});

/** PATCH /me/modules — vendor owner/manager toggles marketplace, properties, rentals channels */
router.patch(
  '/me/modules',
  authMiddleware,
  [
    body('module_marketplace_enabled').optional().isBoolean(),
    body('module_properties_enabled').optional().isBoolean(),
    body('module_rentals_enabled').optional().isBoolean(),
  ],
  async (req, res, next) => {
    try {
      if (req.userRole !== 'vendor' && req.userRole !== 'admin' && req.userRole !== 'super_admin') {
        return res.status(403).json({ error: "You don't have permission to do that." });
      }
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { rows: userRows } = await pool.query(
        'SELECT id, vendor_org_id FROM users WHERE id = $1',
        [req.userId]
      );
      if (!userRows.length) return res.status(404).json({ error: 'User not found' });
      const vendorOrgId = userRows[0].vendor_org_id;
      if (!vendorOrgId) return res.status(400).json({ error: 'Vendor organization is required first' });

      if (req.userRole === 'vendor') {
        const { rows: memRows } = await pool.query(
          `SELECT org_role FROM vendor_memberships
           WHERE vendor_org_id = $1 AND user_id = $2
           LIMIT 1`,
          [vendorOrgId, req.userId]
        );
        const role = memRows[0]?.org_role;
        if (!role || !['owner', 'manager'].includes(String(role))) {
          return res.status(403).json({ error: 'Only organization owners or managers can update channel access.' });
        }
      }

      const u = req.body;
      if (
        u.module_marketplace_enabled === undefined &&
        u.module_properties_enabled === undefined &&
        u.module_rentals_enabled === undefined
      ) {
        return res.status(400).json({ error: 'No module flags provided' });
      }

      const { rows: curRows } = await pool.query(
        'SELECT module_marketplace_enabled, module_properties_enabled, module_rentals_enabled FROM vendor_organizations WHERE id = $1',
        [vendorOrgId]
      );
      if (!curRows.length) return res.status(404).json({ error: 'Vendor organization not found' });
      const cur = curRows[0];
      const nextM = moduleFlagToDb(
        u.module_marketplace_enabled !== undefined ? u.module_marketplace_enabled : cur.module_marketplace_enabled
      );
      const nextP = moduleFlagToDb(
        u.module_properties_enabled !== undefined ? u.module_properties_enabled : cur.module_properties_enabled
      );
      const nextR = moduleFlagToDb(
        u.module_rentals_enabled !== undefined ? u.module_rentals_enabled : cur.module_rentals_enabled
      );

      await pool.query(
        `UPDATE vendor_organizations
         SET module_marketplace_enabled = $2,
             module_properties_enabled = $3,
             module_rentals_enabled = $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [vendorOrgId, nextM, nextP, nextR]
      );

      logAudit({
        userId: req.userId,
        action: 'vendor_org_modules_update',
        resourceType: 'vendor_organization',
        resourceId: vendorOrgId,
        details: JSON.stringify({
          module_marketplace_enabled: nextM,
          module_properties_enabled: nextP,
          module_rentals_enabled: nextR,
        }),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      const { rows } = await pool.query('SELECT * FROM vendor_organizations WHERE id = $1', [vendorOrgId]);
      return res.json({ vendor_org: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

async function saveVendorBrandingFile(vendorOrgId, type, file) {
  let fileUrl;
  if (isS3Configured() && file.buffer) {
    const ext = path.extname(file.originalname) || '.jpg';
    const key = `vendor-branding/${vendorOrgId}/${type}-${uuidv4()}${ext}`;
    fileUrl = await uploadToS3(file.buffer, key, file.mimetype || 'image/jpeg');
  }
  if (!fileUrl) {
    fileUrl = `/uploads/vendor-branding/${file.filename}`;
  }
  const col = type === 'logo' ? 'logo_url' : 'cover_photo_url';
  await pool.query(
    `UPDATE vendor_organizations SET ${col} = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [fileUrl, vendorOrgId]
  );
  return fileUrl;
}

/** POST /me/branding?type=cover|logo — multipart field `file` (image). Requires existing vendor org. */
router.post('/me/branding', authMiddleware, brandUpload.single('file'), async (req, res, next) => {
  try {
    if (req.userRole !== 'vendor' && req.userRole !== 'admin' && req.userRole !== 'super_admin') {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }
    const type = req.query.type === 'logo' ? 'logo' : 'cover';
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { rows: userRows } = await pool.query('SELECT id, vendor_org_id FROM users WHERE id = $1', [req.userId]);
    if (!userRows.length) return res.status(404).json({ error: 'User not found' });
    if (!userRows[0].vendor_org_id) {
      return res.status(400).json({
        error: 'Save your company legal name first, then you can add a cover image and logo.',
      });
    }
    const vendorOrgId = userRows[0].vendor_org_id;

    const fileUrl = await saveVendorBrandingFile(vendorOrgId, type, req.file);

    logAudit({
      userId: req.userId,
      action: 'vendor_org_branding_upload',
      resourceType: 'vendor_organization',
      resourceId: vendorOrgId,
      details: JSON.stringify({ type, file_url: fileUrl }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    const { rows } = await pool.query('SELECT * FROM vendor_organizations WHERE id = $1', [vendorOrgId]);
    return res.json({ vendor_org: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/me',
  authMiddleware,
  [
    body('legal_name').optional().trim().notEmpty().isLength({ max: 255 }),
    body('display_name').optional({ nullable: true }).trim().isLength({ max: 255 }),
    body('registration_country').optional({ nullable: true }).trim().isLength({ max: 100 }),
    body('phone').optional({ nullable: true }).trim().isLength({ max: 50 }),
    body('cover_photo_url')
      .optional({ nullable: true })
      .custom((v) => {
        if (v === undefined || v === null) return true;
        if (typeof v !== 'string') return false;
        const t = v.trim();
        if (t === '') return true;
        return t.length <= 2048 && isSafeAssetUrl(t);
      }),
    body('logo_url')
      .optional({ nullable: true })
      .custom((v) => {
        if (v === undefined || v === null) return true;
        if (typeof v !== 'string') return false;
        const t = v.trim();
        if (t === '') return true;
        return t.length <= 2048 && isSafeAssetUrl(t);
      }),
  ],
  async (req, res, next) => {
    try {
      if (req.userRole !== 'vendor' && req.userRole !== 'admin' && req.userRole !== 'super_admin') {
        return res.status(403).json({ error: "You don't have permission to do that." });
      }
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { rows: userRows } = await pool.query(
        'SELECT id, vendor_org_id, full_name, email, phone FROM users WHERE id = $1',
        [req.userId]
      );
      if (!userRows.length) return res.status(404).json({ error: 'User not found' });
      const me = userRows[0];

      let vendorOrgId = me.vendor_org_id;
      if (!vendorOrgId) {
        if (!req.body.legal_name || !String(req.body.legal_name).trim()) {
          return res.status(400).json({ error: 'legal_name is required when creating your company profile' });
        }
        vendorOrgId = uuidv4();
        const { rows: signupRows } = await pool.query(
          'SELECT signup_vendor_channel FROM users WHERE id = $1',
          [req.userId]
        );
        const signupChannel = signupRows[0]?.signup_vendor_channel || 'marketplace';
        const moduleFlags = moduleFlagsForSignupVendorChannel(signupChannel);
        await pool.query(
          `INSERT INTO vendor_organizations (
            id, legal_name, display_name, registration_country, status, verification_status, vendor_source,
            module_marketplace_enabled, module_properties_enabled, module_rentals_enabled
          ) VALUES ($1, $2, $3, $4, 'pending_verification', 'submitted', 'self_service', $5, $6, $7)`,
          [
            vendorOrgId,
            req.body.legal_name.trim(),
            req.body.display_name?.trim() || null,
            req.body.registration_country?.trim() || null,
            moduleFlags.module_marketplace_enabled,
            moduleFlags.module_properties_enabled,
            moduleFlags.module_rentals_enabled,
          ]
        );
        await pool.query(
          `INSERT INTO vendor_memberships (id, vendor_org_id, user_id, org_role, is_primary_contact)
           VALUES ($1, $2, $3, 'owner', 1)`,
          [uuidv4(), vendorOrgId, req.userId]
        );
        await pool.query(
          'UPDATE users SET vendor_org_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [vendorOrgId, req.userId]
        );
      } else {
        const updates = {};
        if (req.body.legal_name !== undefined) updates.legal_name = req.body.legal_name.trim();
        if (req.body.display_name !== undefined) updates.display_name = req.body.display_name?.trim() || null;
        if (req.body.registration_country !== undefined) updates.registration_country = req.body.registration_country?.trim() || null;
        if (Object.keys(updates).length) {
          const setClause = Object.keys(updates)
            .map((k, i) => `${k} = $${i + 2}`)
            .join(', ');
          await pool.query(
            `UPDATE vendor_organizations SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [vendorOrgId, ...Object.values(updates)]
          );
        }
      }

      if (vendorOrgId) {
        const brandingUpdates = {};
        if (req.body.cover_photo_url !== undefined) {
          const v = req.body.cover_photo_url;
          brandingUpdates.cover_photo_url = v === null || v === '' ? null : String(v).trim();
        }
        if (req.body.logo_url !== undefined) {
          const v = req.body.logo_url;
          brandingUpdates.logo_url = v === null || v === '' ? null : String(v).trim();
        }
        if (Object.keys(brandingUpdates).length) {
          const setClause = Object.keys(brandingUpdates)
            .map((k, i) => `${k} = $${i + 2}`)
            .join(', ');
          await pool.query(
            `UPDATE vendor_organizations SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [vendorOrgId, ...Object.values(brandingUpdates)]
          );
        }
      }

      if (req.body.phone !== undefined) {
        await pool.query('UPDATE users SET phone = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [
          req.body.phone?.trim() || null,
          req.userId,
        ]);
      }

      const { rows: orgRows } = await pool.query('SELECT * FROM vendor_organizations WHERE id = $1', [vendorOrgId]);
      const { rows: meRows } = await pool.query('SELECT id AS user_id, full_name, email, phone FROM users WHERE id = $1', [req.userId]);

      logAudit({
        userId: req.userId,
        action: 'vendor_org_self_update',
        resourceType: 'vendor_organization',
        resourceId: vendorOrgId,
        details: JSON.stringify({
          legal_name: req.body.legal_name ?? undefined,
          display_name: req.body.display_name ?? undefined,
          registration_country: req.body.registration_country ?? undefined,
          phone: req.body.phone ?? undefined,
          cover_photo_url: req.body.cover_photo_url ?? undefined,
          logo_url: req.body.logo_url ?? undefined,
        }),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      return res.json({
        vendor_org: orgRows[0] || null,
        primary_contact: meRows[0] || null,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/', authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    const { is_partner: isPartnerQ, exclude_partners: excludePartnersQ } = req.query;
    const conditions = [];
    if (isPartnerQ === '1' || isPartnerQ === 'true') {
      conditions.push(isPartnerOrgSql('vo'));
    }
    if (excludePartnersQ === '1' || excludePartnersQ === 'true') {
      conditions.push(`NOT ${isPartnerOrgSql('vo')}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT vo.*,
              COUNT(DISTINCT vm.user_id) AS member_count
       FROM vendor_organizations vo
       LEFT JOIN vendor_memberships vm ON vm.vendor_org_id = vo.id
       ${where}
       GROUP BY vo.id
       ORDER BY vo.updated_at DESC, vo.created_at DESC`
    );
    res.json(rows || []);
  } catch (err) {
    next(err);
  }
});

router.post(
  '/',
  authMiddleware,
  requireAdmin,
  [
    body('legal_name').trim().notEmpty().isLength({ max: 255 }),
    body('display_name').optional({ nullable: true }).trim().isLength({ max: 255 }),
    body('registration_country').optional({ nullable: true }).trim().isLength({ max: 100 }),
    body('status').optional().isIn(['draft', 'pending_verification', 'approved', 'suspended']),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const id = uuidv4();
      const legalName = req.body.legal_name.trim();
      const displayName = req.body.display_name?.trim() || null;
      const registrationCountry = req.body.registration_country?.trim() || null;
      const status = req.body.status || 'pending_verification';

      await pool.query(
        `INSERT INTO vendor_organizations
          (id, legal_name, display_name, registration_country, status, verification_status, verified_at, vendor_source)
         VALUES (
          $1, $2, $3, $4, $5,
          CASE WHEN $5 = 'approved' THEN 'approved' ELSE 'submitted' END,
          CASE WHEN $5 = 'approved' THEN CURRENT_TIMESTAMP ELSE NULL END,
          'self_service'
         )`,
        [id, legalName, displayName, registrationCountry, status]
      );

      logAudit({
        userId: req.userId,
        action: 'vendor_org_create',
        resourceType: 'vendor_organization',
        resourceId: id,
        details: JSON.stringify({ legal_name: legalName, status }),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      const { rows } = await pool.query('SELECT * FROM vendor_organizations WHERE id = $1', [id]);
      res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

/** POST /partners — admin: create partner vendor account + org (Botch & Partners listings) */
router.post(
  '/partners',
  authMiddleware,
  requireAdmin,
  [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }),
    body('full_name').trim().notEmpty().isLength({ max: 255 }),
    body('phone').optional({ nullable: true }).trim().isLength({ max: 50 }),
    body('country').optional({ nullable: true }).trim().isLength({ max: 100 }),
    body('legal_name').trim().notEmpty().isLength({ max: 255 }),
    body('display_name').optional({ nullable: true }).trim().isLength({ max: 255 }),
    body('registration_country').optional({ nullable: true }).trim().isLength({ max: 100 }),
    body('status').optional().isIn(['draft', 'pending_verification', 'approved', 'suspended']),
    body('verification_status').optional().isIn(['submitted', 'pending_review', 'approved', 'rejected']),
    body('verification_notes').optional({ nullable: true }).trim().isLength({ max: 2000 }),
    body('module_marketplace_enabled').optional().isBoolean(),
    body('module_properties_enabled').optional().isBoolean(),
    body('module_rentals_enabled').optional().isBoolean(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const userId = uuidv4();
      const orgId = uuidv4();
      const membershipId = uuidv4();
      const passwordHash = await bcrypt.hash(req.body.password, SALT_ROUNDS);

      const legalName = req.body.legal_name.trim();
      const displayName = req.body.display_name?.trim() || null;
      const registrationCountry = req.body.registration_country?.trim() || null;
      const status = req.body.status || 'approved';
      const verificationStatus =
        req.body.verification_status || (status === 'approved' ? 'approved' : 'submitted');
      const verificationNotes = req.body.verification_notes?.trim() || null;
      const verifiedAt = verificationStatus === 'approved' ? new Date().toISOString() : null;

      const moduleMarketplace = moduleFlagToDb(
        req.body.module_marketplace_enabled !== undefined ? req.body.module_marketplace_enabled : true
      );
      const moduleProperties = moduleFlagToDb(
        req.body.module_properties_enabled !== undefined ? req.body.module_properties_enabled : true
      );
      const moduleRentals = moduleFlagToDb(
        req.body.module_rentals_enabled !== undefined ? req.body.module_rentals_enabled : true
      );

      await pool.query('BEGIN IMMEDIATE');
      try {
        await pool.query(
          `INSERT INTO users (id, email, password_hash, full_name, phone, country, role, verified, verification_status, verified_at, vendor_org_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'vendor', 1, 'approved', CURRENT_TIMESTAMP, $7)`,
          [
            userId,
            req.body.email,
            passwordHash,
            req.body.full_name.trim(),
            req.body.phone?.trim() || null,
            req.body.country?.trim() || null,
            orgId,
          ]
        );

        await pool.query(
          `INSERT INTO vendor_organizations (
            id, legal_name, display_name, registration_country, status, verification_status,
            verified_at, verification_notes, is_partner, vendor_source,
            module_marketplace_enabled, module_properties_enabled, module_rentals_enabled
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 'admin_partner', $9, $10, $11)`,
          [
            orgId,
            legalName,
            displayName,
            registrationCountry,
            status,
            verificationStatus,
            verifiedAt,
            verificationNotes,
            moduleMarketplace,
            moduleProperties,
            moduleRentals,
          ]
        );

        await pool.query(
          `INSERT INTO vendor_memberships (id, vendor_org_id, user_id, org_role, is_primary_contact)
           VALUES ($1, $2, $3, 'owner', 1)`,
          [membershipId, orgId, userId]
        );

        await pool.query('COMMIT');
      } catch (inner) {
        await pool.query('ROLLBACK');
        throw inner;
      }

      logAudit({
        userId: req.userId,
        action: 'vendor_partner_create',
        resourceType: 'vendor_organization',
        resourceId: orgId,
        details: JSON.stringify({ legal_name: legalName, email: req.body.email, user_id: userId }),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      const { rows } = await pool.query(
        `SELECT vo.*,
                COUNT(DISTINCT vm.user_id) AS member_count
         FROM vendor_organizations vo
         LEFT JOIN vendor_memberships vm ON vm.vendor_org_id = vo.id
         WHERE vo.id = $1
         GROUP BY vo.id`,
        [orgId]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (isUniqueEmailError(err)) return res.status(409).json({ error: 'Email already exists' });
      next(err);
    }
  }
);

/** POST /:id/branding?type=cover|logo — admin upload logo or banner for any vendor org */
router.post(
  '/:id/branding',
  authMiddleware,
  requireAdmin,
  [param('id').isUUID()],
  brandUpload.single('file'),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const type = req.query.type === 'logo' ? 'logo' : 'cover';
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const vendorOrgId = req.params.id;
      const { rows: orgRows } = await pool.query('SELECT id FROM vendor_organizations WHERE id = $1', [vendorOrgId]);
      if (!orgRows.length) return res.status(404).json({ error: 'Vendor organization not found' });

      const fileUrl = await saveVendorBrandingFile(vendorOrgId, type, req.file);

      logAudit({
        userId: req.userId,
        action: 'vendor_org_branding_upload_admin',
        resourceType: 'vendor_organization',
        resourceId: vendorOrgId,
        details: JSON.stringify({ type, file_url: fileUrl }),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      const { rows } = await pool.query('SELECT * FROM vendor_organizations WHERE id = $1', [vendorOrgId]);
      return res.json(rows[0]);
    } catch (err) {
      return next(err);
    }
  }
);

/** GET /:id — admin: single vendor organization with member count */
router.get('/:id', authMiddleware, requireAdmin, [param('id').isUUID()], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { rows } = await pool.query(
      `SELECT vo.*,
              COUNT(DISTINCT vm.user_id) AS member_count
       FROM vendor_organizations vo
       LEFT JOIN vendor_memberships vm ON vm.vendor_org_id = vo.id
       WHERE vo.id = $1
       GROUP BY vo.id`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Vendor organization not found' });
    return res.json(rows[0]);
  } catch (err) {
    return next(err);
  }
});

router.patch(
  '/:id',
  authMiddleware,
  requireAdmin,
  [
    param('id').isUUID(),
    body('legal_name').optional().trim().notEmpty().isLength({ max: 255 }),
    body('display_name').optional({ nullable: true }).trim().isLength({ max: 255 }),
    body('registration_country').optional({ nullable: true }).trim().isLength({ max: 100 }),
    body('status').optional().isIn(['draft', 'pending_verification', 'approved', 'suspended']),
    body('verification_status').optional().isIn(['submitted', 'pending_review', 'approved', 'rejected']),
    body('verification_level').optional().trim().isLength({ max: 30 }),
    body('verification_notes').optional({ nullable: true }).trim().isLength({ max: 2000 }),
    body('is_partner').optional().isBoolean(),
    body('module_marketplace_enabled').optional().isBoolean(),
    body('module_properties_enabled').optional().isBoolean(),
    body('module_rentals_enabled').optional().isBoolean(),
    body('cover_photo_url')
      .optional({ nullable: true })
      .custom((v) => {
        if (v === undefined || v === null) return true;
        if (typeof v !== 'string') return false;
        const t = v.trim();
        if (t === '') return true;
        return t.length <= 2048 && isSafeAssetUrl(t);
      }),
    body('logo_url')
      .optional({ nullable: true })
      .custom((v) => {
        if (v === undefined || v === null) return true;
        if (typeof v !== 'string') return false;
        const t = v.trim();
        if (t === '') return true;
        return t.length <= 2048 && isSafeAssetUrl(t);
      }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const updates = {};
      const fields = ['legal_name', 'display_name', 'registration_country', 'status', 'verification_status', 'verification_level', 'verification_notes'];
      for (const f of fields) {
        if (req.body[f] !== undefined) updates[f] = req.body[f];
      }
      if (req.body.is_partner !== undefined) {
        updates.is_partner = req.body.is_partner ? moduleFlagToDb(true) : moduleFlagToDb(false);
      }
      if (req.body.module_marketplace_enabled !== undefined) {
        updates.module_marketplace_enabled = moduleFlagToDb(req.body.module_marketplace_enabled);
      }
      if (req.body.module_properties_enabled !== undefined) {
        updates.module_properties_enabled = moduleFlagToDb(req.body.module_properties_enabled);
      }
      if (req.body.module_rentals_enabled !== undefined) {
        updates.module_rentals_enabled = moduleFlagToDb(req.body.module_rentals_enabled);
      }
      if (req.body.cover_photo_url !== undefined) {
        const v = req.body.cover_photo_url;
        updates.cover_photo_url = v === null || v === '' ? null : String(v).trim();
      }
      if (req.body.logo_url !== undefined) {
        const v = req.body.logo_url;
        updates.logo_url = v === null || v === '' ? null : String(v).trim();
      }
      if (updates.status === 'approved' && updates.verification_status === undefined) {
        updates.verification_status = 'approved';
      }
      if (updates.verification_status === 'approved') {
        updates.verified_at = new Date().toISOString();
      } else if (updates.verification_status === 'rejected') {
        updates.verified_at = null;
      }
      if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No fields to update' });

      const setClause = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
      const values = Object.values(updates);
      const updateResult = await pool.query(
        `UPDATE vendor_organizations
         SET ${setClause}, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [req.params.id, ...values]
      );
      if (!updateResult.rowCount) return res.status(404).json({ error: 'Vendor organization not found' });

      logAudit({
        userId: req.userId,
        action: 'vendor_org_update',
        resourceType: 'vendor_organization',
        resourceId: req.params.id,
        details: JSON.stringify(updates),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      const { rows } = await pool.query('SELECT * FROM vendor_organizations WHERE id = $1', [req.params.id]);
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

router.get('/:id/members', authMiddleware, requireAdmin, [param('id').isUUID()], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { rows } = await pool.query(
      `SELECT vm.id, vm.vendor_org_id, vm.user_id, vm.org_role, vm.is_primary_contact, vm.created_at, vm.updated_at,
              u.full_name, u.email, u.role
       FROM vendor_memberships vm
       INNER JOIN users u ON u.id = vm.user_id
       WHERE vm.vendor_org_id = $1
       ORDER BY vm.is_primary_contact DESC, vm.created_at ASC`,
      [req.params.id]
    );
    res.json(rows || []);
  } catch (err) {
    next(err);
  }
});

router.post(
  '/:id/members',
  authMiddleware,
  requireAdmin,
  [
    param('id').isUUID(),
    body('user_id').isUUID(),
    body('org_role').optional().isIn(['owner', 'manager', 'member']),
    body('is_primary_contact').optional().isBoolean(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const vendorOrgId = req.params.id;
      const userId = req.body.user_id;
      const orgRole = req.body.org_role || 'member';
      const isPrimaryContact = req.body.is_primary_contact ? 1 : 0;

      const { rows: orgRows } = await pool.query('SELECT id FROM vendor_organizations WHERE id = $1', [vendorOrgId]);
      if (!orgRows.length) return res.status(404).json({ error: 'Vendor organization not found' });

      const { rows: userRows } = await pool.query("SELECT id, role FROM users WHERE id = $1 AND role = 'vendor'", [userId]);
      if (!userRows.length) return res.status(400).json({ error: 'User must have vendor role' });

      await pool.query(
        `INSERT INTO vendor_memberships (id, vendor_org_id, user_id, org_role, is_primary_contact)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (vendor_org_id, user_id) DO UPDATE SET
           org_role = EXCLUDED.org_role,
           is_primary_contact = EXCLUDED.is_primary_contact,
           updated_at = CURRENT_TIMESTAMP`,
        [uuidv4(), vendorOrgId, userId, orgRole, isPrimaryContact]
      );

      if (isPrimaryContact) {
        await pool.query(
          `UPDATE vendor_memberships
           SET is_primary_contact = 0, updated_at = CURRENT_TIMESTAMP
           WHERE vendor_org_id = $1 AND user_id <> $2`,
          [vendorOrgId, userId]
        );
      }

      await pool.query(
        'UPDATE users SET vendor_org_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [vendorOrgId, userId]
      );

      logAudit({
        userId: req.userId,
        action: 'vendor_org_member_upsert',
        resourceType: 'vendor_organization',
        resourceId: vendorOrgId,
        details: JSON.stringify({ user_id: userId, org_role: orgRole, is_primary_contact: !!isPrimaryContact }),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      const { rows } = await pool.query(
        `SELECT vm.id, vm.vendor_org_id, vm.user_id, vm.org_role, vm.is_primary_contact, vm.created_at, vm.updated_at,
                u.full_name, u.email, u.role
         FROM vendor_memberships vm
         INNER JOIN users u ON u.id = vm.user_id
         WHERE vm.vendor_org_id = $1 AND vm.user_id = $2`,
        [vendorOrgId, userId]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  '/:id/members/:userId',
  authMiddleware,
  requireAdmin,
  [param('id').isUUID(), param('userId').isUUID()],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { rowCount } = await pool.query(
        'DELETE FROM vendor_memberships WHERE vendor_org_id = $1 AND user_id = $2',
        [req.params.id, req.params.userId]
      );
      if (!rowCount) return res.status(404).json({ error: 'Membership not found' });

      await pool.query(
        'UPDATE users SET vendor_org_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND vendor_org_id = $2',
        [req.params.userId, req.params.id]
      );

      logAudit({
        userId: req.userId,
        action: 'vendor_org_member_remove',
        resourceType: 'vendor_organization',
        resourceId: req.params.id,
        details: JSON.stringify({ user_id: req.params.userId }),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

export default router;
