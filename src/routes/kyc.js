import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import pool from '../db/index.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { body, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../lib/audit.js';
import { uploadToS3, isS3Configured } from '../lib/s3.js';
import { fileFilter, ALLOWED_KYC_MIMES } from '../lib/upload-validation.js';
import { getUploadsBase } from '../lib/upload-paths.js';
import {
  isSumsubConfigured,
  createAccessToken,
  getSumsubWebSdkBaseUrl,
} from '../lib/sumsub.js';
import { isCustomerRole } from '../lib/roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const kycDir = path.join(getUploadsBase(path.join(__dirname, '..', '..', 'uploads')), 'kyc');
try {
  fs.mkdirSync(kycDir, { recursive: true });
} catch (_) {}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, kycDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.bin';
    cb(null, uuidv4() + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: fileFilter(ALLOWED_KYC_MIMES, 'KYC document') }); // 10MB

const router = express.Router();

/** GET /api/v1/kyc/config - public config for client UI (e.g. is hosted verification available, Sumsub Web SDK) */
router.get('/config', (_req, res) => {
  const template = process.env.KYC_HOSTED_URL_TEMPLATE;
  const isDev = process.env.NODE_ENV !== 'production';
  const sumsub = isSumsubConfigured();
  res.json({
    hosted_verification_available: Boolean(template) || sumsub || isDev,
    sumsub_web_sdk_available: sumsub,
    sumsub_web_sdk_base_url: sumsub ? getSumsubWebSdkBaseUrl() : undefined,
  });
});

/**
 * GET /api/v1/kyc/nav-reminders — actionable verification / KYC reminders for nav + notification bell.
 * Returns { count, items } where items have title + href for the current app shell (client, vendor, agent).
 */
router.get('/nav-reminders', authMiddleware, async (req, res, next) => {
  try {
    const userId = req.userId;
    const role = req.userRole;
    const items = [];

    if (isCustomerRole(role)) {
      const { rows: userRows } = await pool.query(
        `SELECT verified, verification_status FROM users WHERE id = $1 AND role IN ('client', 'buyer')`,
        [userId]
      );
      const u = userRows[0];
      if (!u) return res.json({ count: 0, items: [] });
      const vs = String(u.verification_status || 'submitted').trim();
      const approved = vs === 'approved' && Boolean(u.verified);

      if (vs === 'rejected') {
        items.push({ kind: 'verification', title: 'Identity verification was rejected', href: '/dashboard/verification' });
      } else if (!approved) {
        const { rows: docRows } = await pool.query(
          `SELECT document_type, status FROM kyc_documents WHERE user_id = $1`,
          [userId]
        );
        const types = new Set((docRows || []).map((r) => r.document_type));
        const rejectedDocs = (docRows || []).filter((r) => r.status === 'rejected').length;
        if (rejectedDocs > 0) {
          items.push({
            kind: 'kyc',
            title: rejectedDocs === 1 ? '1 document was rejected — re-upload' : `${rejectedDocs} documents were rejected — re-upload`,
            href: '/dashboard/verification',
          });
        } else {
          const hasPassport = types.has('passport');
          const hasGhana = types.has('id_front') && types.has('id_back');
          if (!hasPassport && !hasGhana) {
            items.push({ kind: 'kyc', title: 'Upload ID to finish verification', href: '/dashboard/verification' });
          } else {
            const { rows: pendVer } = await pool.query(
              `SELECT COUNT(*)::int AS c FROM user_verifications WHERE user_id = $1 AND status IN ('failed')`,
              [userId]
            );
            const failedV = pendVer[0]?.c ?? 0;
            if (failedV > 0) {
              items.push({ kind: 'kyc', title: 'Verification session failed — try again', href: '/dashboard/verification' });
            } else if (vs !== 'approved') {
              items.push({ kind: 'verification', title: 'Verification in progress or awaiting review', href: '/dashboard/verification' });
            }
          }
        }
      }

      return res.json({ count: items.length, items });
    }

    if (role === 'vendor' || role === 'agent') {
      const base = role === 'agent' ? '/agent' : '/vendor';
      const { rows: userRows } = await pool.query(
        `SELECT u.verification_status, u.verified, u.vendor_org_id,
                vo.verification_status AS org_verification_status
         FROM users u
         LEFT JOIN vendor_organizations vo ON vo.id = u.vendor_org_id
         WHERE u.id = $1`,
        [userId]
      );
      const u = userRows[0];
      if (!u) return res.json({ count: 0, items: [] });
      const uvs = String(u.verification_status || 'submitted').trim();
      const userOk = uvs === 'approved' && Boolean(u.verified);
      if (uvs === 'rejected') {
        items.push({ kind: 'user_verification', title: 'Your account verification was rejected', href: `${base}/verification` });
      } else if (!userOk) {
        items.push({ kind: 'user_verification', title: 'Complete account verification', href: `${base}/verification` });
      }
      if (u.vendor_org_id) {
        const ovs = String(u.org_verification_status || 'submitted').trim();
        if (ovs !== 'approved') {
          items.push({
            kind: 'org_verification',
            title: ovs === 'rejected' ? 'Business verification was rejected' : 'Business verification pending',
            href: `${base}/company`,
          });
        }
      }
      if (role === 'agent') {
        const { rows: licRows } = await pool.query(
          `SELECT status FROM agent_licenses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [userId]
        );
        const lic = licRows[0];
        const lst = lic?.status ? String(lic.status) : '';
        if (!lic || lst === 'rejected') {
          items.push({
            kind: 'agent_license',
            title: lst === 'rejected' ? 'REAC license rejected — resubmit' : 'Submit your REAC license',
            href: '/agent/verification',
          });
        }
      }

      return res.json({ count: items.length, items });
    }

    return res.json({ count: 0, items: [] });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/kyc/status - client: my KYC status; admin: all pending */
router.get('/status', authMiddleware, async (req, res, next) => {
  try {
    if (req.userRole === 'admin' || req.userRole === 'super_admin') {
      const audience = String(req.query.audience || '').trim().toLowerCase();
      const clientOnly =
        audience === 'clients' || audience === 'client' ? " AND u.role IN ('client', 'buyer') " : '';
      const { rows } = await pool.query(
        `SELECT k.*, u.full_name, u.email FROM kyc_documents k JOIN users u ON k.user_id = u.id WHERE k.status = 'pending'${clientOnly} ORDER BY k.created_at DESC`
      );
      const { rows: verRows } = await pool.query(
        `SELECT v.*, u.full_name, u.email FROM user_verifications v JOIN users u ON v.user_id = u.id WHERE (v.status = 'pending' OR v.status = 'in_progress')${clientOnly} ORDER BY v.created_at DESC`
      );
      const { rows: livenessRows } = await pool.query(
        `SELECT l.*, u.full_name, u.email FROM kyc_liveness l JOIN users u ON l.user_id = u.id WHERE l.status = 'pending'${clientOnly} ORDER BY l.created_at DESC`
      );
      return res.json({ pending: rows, pendingVerifications: verRows || [], pendingLiveness: livenessRows || [] });
    }
    const { rows } = await pool.query(
      'SELECT * FROM kyc_documents WHERE user_id = $1 ORDER BY created_at DESC',
      [req.userId]
    );
    const verified = (await pool.query('SELECT verified, kyc_level, verification_provider FROM users WHERE id = $1', [req.userId])).rows[0];
    const { rows: verifications } = await pool.query(
      'SELECT * FROM user_verifications WHERE user_id = $1 ORDER BY created_at DESC',
      [req.userId]
    );
    const { rows: aml } = await pool.query(
      'SELECT * FROM aml_screenings WHERE user_id = $1 ORDER BY screened_at DESC',
      [req.userId]
    );
    const { rows: agentLicense } = await pool.query(
      'SELECT * FROM agent_licenses WHERE user_id = $1 LIMIT 1',
      [req.userId]
    );
    const { rows: livenessRows } = await pool.query(
      'SELECT * FROM kyc_liveness WHERE user_id = $1 ORDER BY created_at DESC',
      [req.userId]
    );
    res.json({
      documents: rows,
      verified: Boolean(verified?.verified),
      kyc_level: verified?.kyc_level || 'none',
      verification_provider: verified?.verification_provider,
      verifications: verifications || [],
      aml_screenings: aml || [],
      agent_license: agentLicense?.[0] || null,
      liveness: livenessRows || [],
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/kyc/admin/user/:userId/documents — admin: all KYC document rows for a user (review queue context) */
router.get('/admin/user/:userId/documents', authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    const userId = String(req.params.userId || '').trim();
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const { rows } = await pool.query(
      `SELECT k.id, k.user_id, k.document_type, k.file_url, k.file_path, k.status, k.created_at, k.reviewed_at, k.rejection_reason
       FROM kyc_documents k
       WHERE k.user_id = $1
       ORDER BY k.created_at DESC`,
      [userId]
    );
    res.json({ documents: rows || [] });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/kyc/upload - client upload ID document */
router.post('/upload', authMiddleware, upload.single('file'), [
  body('document_type').optional().isIn(['id_front', 'id_back', 'passport', 'ghana_card', 'other']),
], async (req, res, next) => {
  try {
    if (!isCustomerRole(req.userRole) && req.userRole !== 'admin') return res.status(403).json({ error: 'Only buyers and project clients can upload KYC documents' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const documentType = (req.body && req.body.document_type) || 'id_front';
    const contentType = req.file.mimetype || '';
    if (!contentType.startsWith('image/') && contentType !== 'application/pdf') {
      return res.status(400).json({ error: 'Only images and PDF are allowed' });
    }

    let fileUrl;
    if (isS3Configured()) {
      const ext = path.extname(req.file.originalname) || '.bin';
      const key = `kyc/${req.userId}/${uuidv4()}${ext}`;
      const buffer = fs.readFileSync(req.file.path);
      fileUrl = await uploadToS3(buffer, key, req.file.mimetype || 'application/octet-stream');
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
    if (!fileUrl) {
      fileUrl = `/uploads/kyc/${req.file.filename}`;
    }

    const id = uuidv4();
    await pool.query(
      `INSERT INTO kyc_documents (id, user_id, document_type, file_url, file_path, status) VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [id, req.userId, documentType, fileUrl, req.file.filename]
    );
    const { rows } = await pool.query('SELECT * FROM kyc_documents WHERE id = $1', [id]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/kyc/liveness - client upload selfie for biometric liveness (secure; images only) */
router.post('/liveness', authMiddleware, upload.single('file'), [
  body('flow_type').optional().isIn(['ghana_card', 'passport']),
], async (req, res, next) => {
  try {
    if (!isCustomerRole(req.userRole) && req.userRole !== 'admin') return res.status(403).json({ error: 'Only buyers and project clients can submit liveness' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const mimetype = req.file.mimetype || '';
    if (!mimetype.startsWith('image/')) return res.status(400).json({ error: 'Only images allowed for liveness' });
    const flowType = (req.body && req.body.flow_type) || 'passport';

    let fileUrl;
    if (isS3Configured()) {
      const ext = path.extname(req.file.originalname) || '.jpg';
      const key = `kyc/${req.userId}/liveness-${uuidv4()}${ext}`;
      const buffer = fs.readFileSync(req.file.path);
      fileUrl = await uploadToS3(buffer, key, req.file.mimetype || 'image/jpeg');
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
    if (!fileUrl) {
      fileUrl = `/uploads/kyc/${req.file.filename}`;
    }

    const id = uuidv4();
    await pool.query(
      `INSERT INTO kyc_liveness (id, user_id, file_url, file_path, flow_type, status) VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [id, req.userId, fileUrl, req.file.filename, flowType]
    );
    const { rows } = await pool.query('SELECT * FROM kyc_liveness WHERE id = $1', [id]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/v1/kyc/liveness/:id/review - admin approve or reject liveness */
router.patch('/liveness/:id/review', authMiddleware, requireAdmin, [
  body('status').isIn(['approved', 'rejected']),
  body('rejection_reason').optional().trim(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { id } = req.params;
    const { status, rejection_reason } = req.body;
    const { rows: livenessRows } = await pool.query('SELECT * FROM kyc_liveness WHERE id = $1', [id]);
    if (livenessRows.length === 0) return res.status(404).json({ error: 'Liveness record not found' });
    const rec = livenessRows[0];
    await pool.query(
      `UPDATE kyc_liveness SET status = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP, rejection_reason = $3 WHERE id = $4`,
      [status, req.userId, status === 'rejected' ? (rejection_reason || null) : null, id]
    );
    const { rows } = await pool.query('SELECT * FROM kyc_liveness WHERE id = $1', [id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/v1/kyc/:id/review - admin approve or reject */
router.patch('/:id/review', authMiddleware, requireAdmin, [
  body('status').isIn(['approved', 'rejected']),
  body('rejection_reason').optional().trim(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { id } = req.params;
    const { status, rejection_reason } = req.body;
    const { rows: kycRows } = await pool.query('SELECT * FROM kyc_documents WHERE id = $1', [id]);
    if (kycRows.length === 0) return res.status(404).json({ error: 'KYC document not found' });
    const kyc = kycRows[0];

    await pool.query(
      `UPDATE kyc_documents SET status = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP, rejection_reason = $3 WHERE id = $4`,
      [status, req.userId, status === 'rejected' ? (rejection_reason || null) : null, id]
    );
    if (status === 'approved') {
      const isGhanaPath = ['ghana_card', 'id_front', 'id_back'].includes(String(kyc.document_type));
      const provider = isGhanaPath ? 'nia_biometric' : 'passport_ocr_liveness';
      await pool.query(
        'UPDATE users SET verified = 1, verification_provider = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [provider, kyc.user_id]
      );
    }
    logAudit({
      userId: req.userId,
      action: 'kyc_review',
      resourceType: 'kyc',
      resourceId: id,
      details: JSON.stringify({ status, userId: kyc.user_id }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    const { rows } = await pool.query('SELECT * FROM kyc_documents WHERE id = $1', [id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/kyc/verification/session - create verification session (Sumsub Web SDK or hosted URL) */
router.post('/verification/session', authMiddleware, [
  body('document_type').optional().isIn(['ghana_card', 'passport']),
], async (req, res, next) => {
  try {
    const documentType = req.body?.document_type || 'passport';
    const provider = process.env.KYC_PROVIDER || 'manual';
    const useSumsub = provider === 'sumsub' && isSumsubConfigured();

    if (!useSumsub) {
      if (documentType === 'ghana_card') {
        const { rows: frontRows } = await pool.query(
          'SELECT id FROM kyc_documents WHERE user_id = $1 AND document_type = $2 LIMIT 1',
          [req.userId, 'id_front']
        );
        const { rows: backRows } = await pool.query(
          'SELECT id FROM kyc_documents WHERE user_id = $1 AND document_type = $2 LIMIT 1',
          [req.userId, 'id_back']
        );
        if (!frontRows?.length || !backRows?.length) {
          return res.status(400).json({
            error: 'Please complete Step 1: upload both front and back of your Ghana Card first.',
          });
        }
      } else {
        const { rows: docRows } = await pool.query(
          'SELECT id FROM kyc_documents WHERE user_id = $1 AND document_type = $2 LIMIT 1',
          [req.userId, 'passport']
        );
        if (!docRows || docRows.length === 0) {
          return res.status(400).json({
            error: 'Please complete Step 1: upload your passport first.',
          });
        }
      }
    }

    const id = uuidv4();
    let hostedUrl = null;
    let access_token = null;
    let sumsub_web_sdk_base_url = null;

    if (useSumsub) {
      const { rows: userRows } = await pool.query(
        'SELECT email FROM users WHERE id = $1 LIMIT 1',
        [req.userId]
      );
      const email = userRows?.[0]?.email || undefined;
      const { token } = await createAccessToken(req.userId, { levelName: process.env.SUMSUB_LEVEL_NAME || undefined, email });
      access_token = token;
      sumsub_web_sdk_base_url = getSumsubWebSdkBaseUrl();
    } else if (process.env.KYC_HOSTED_URL_TEMPLATE) {
      hostedUrl = process.env.KYC_HOSTED_URL_TEMPLATE
        .replace('{userId}', encodeURIComponent(req.userId))
        .replace('{sessionId}', id)
        .replace('{documentType}', documentType);
    }

    await pool.query(
      `INSERT INTO user_verifications (id, user_id, provider, document_type, status, hosted_url, updated_at) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
      [id, req.userId, provider, documentType, (hostedUrl || access_token) ? 'in_progress' : 'pending', hostedUrl]
    );
    const { rows } = await pool.query('SELECT * FROM user_verifications WHERE id = $1', [id]);
    const payload = { session: rows[0], hosted_url: hostedUrl };
    if (access_token) {
      payload.access_token = access_token;
      payload.sumsub_web_sdk_base_url = sumsub_web_sdk_base_url;
    }
    res.status(201).json(payload);
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/kyc/webhook - provider callback (Sumsub applicantReviewed, or generic) */
router.post('/webhook', async (req, res) => {
  try {
    const headerSecret =
      req.headers['x-webhook-secret'] || req.headers['x-payload-digest'] || req.query?.secret;
    const isProduction = process.env.NODE_ENV === 'production';
    const configuredSecret = (process.env.KYC_WEBHOOK_SECRET || '').trim();

    if (isProduction) {
      if (!configuredSecret) {
        console.warn('[kyc webhook] KYC_WEBHOOK_SECRET is required in production. Rejecting webhook.');
        return res.status(503).json({ error: 'Webhook not configured' });
      }
      if (headerSecret !== configuredSecret) {
        return res.status(401).json({ error: 'Invalid webhook secret' });
      }
    } else if (configuredSecret && headerSecret !== configuredSecret) {
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }
    const body = req.body || {};
    const isSumsubPayload = body.type === 'applicantReviewed' || (body.reviewResult && (body.externalUserId != null || body.userId != null));
    let userId = body.user_id || body.userId || body.applicant_id;
    let sessionId = body.session_id || body.sessionId || body.external_id || body.id;
    let verified = false;
    let failed = false;

    if (isSumsubPayload) {
      userId = body.externalUserId ?? body.userId ?? userId;
      const answer = body.reviewResult?.reviewAnswer;
      verified = answer === 'GREEN';
      failed = answer === 'RED';
      sessionId = body.applicantId || sessionId;
    } else {
      const status = (body.status || body.reviewResult?.reviewStatus)?.toLowerCase?.();
      verified = status === 'approved' || status === 'verified' || body.verified === true;
      failed = status === 'rejected' || status === 'failed' || body.verified === false;
    }

    let rows = [];
    if (isSumsubPayload && userId) {
      const { rows: byUser } = await pool.query(
        'SELECT * FROM user_verifications WHERE user_id = $1 AND (status = $2 OR status = $3) ORDER BY created_at DESC LIMIT 1',
        [userId, 'in_progress', 'pending']
      );
      rows = byUser;
    }
    if (rows.length === 0 && sessionId) {
      const { rows: bySession } = await pool.query('SELECT * FROM user_verifications WHERE id = $1 OR external_id = $1', [sessionId]);
      rows = bySession;
    }
    if (rows.length > 0) {
      const v = rows[0];
      const externalId = isSumsubPayload ? (body.applicantId || v.external_id) : v.external_id;
      await pool.query(
        `UPDATE user_verifications SET status = $1, completed_at = CURRENT_TIMESTAMP, liveness_status = $2, aml_status = $3, aml_details = $4, external_id = COALESCE($5, external_id), updated_at = CURRENT_TIMESTAMP WHERE id = $6`,
        [verified ? 'verified' : failed ? 'failed' : 'pending', body.liveness_status || null, body.aml_result || null, JSON.stringify(body), externalId || null, v.id]
      );
      if (verified) {
        const provider = v.provider === 'sumsub' ? 'sumsub' : (v.document_type === 'ghana_card') ? 'nia_biometric' : 'passport_ocr_liveness';
        await pool.query(
          'UPDATE users SET verified = 1, kyc_level = $1, verification_provider = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
          ['full', provider, v.user_id]
        );
        const amlId = uuidv4();
        await pool.query(
          `INSERT INTO aml_screenings (id, user_id, provider, trigger, result, pep, sanctions, details, screened_at) VALUES ($1, $2, $3, 'onboarding', 'clear', 0, 0, $4, CURRENT_TIMESTAMP)`,
          [amlId, v.user_id, v.provider, JSON.stringify(body)]
        );
      }
    } else if (userId) {
      await pool.query(
        'UPDATE users SET verified = $1, kyc_level = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [verified ? 1 : 0, verified ? 'full' : 'none', userId]
      );
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[kyc webhook]', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

router.get('/agent-license', authMiddleware, async (req, res, next) => {
  try {
    if (req.userRole === 'admin' || req.userRole === 'super_admin') {
      const { rows } = await pool.query(
        `SELECT a.*, u.full_name, u.email FROM agent_licenses a JOIN users u ON a.user_id = u.id ORDER BY a.created_at DESC`
      );
      return res.json({ licenses: rows });
    }
    const { rows } = await pool.query('SELECT * FROM agent_licenses WHERE user_id = $1 LIMIT 1', [req.userId]);
    res.json(rows[0] || null);
  } catch (err) {
    next(err);
  }
});

router.post('/agent-license', authMiddleware, [
  body('reac_license_number').trim().notEmpty(),
  body('reac_id').optional().trim(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { reac_license_number, reac_id } = req.body;
    const { rows: existing } = await pool.query('SELECT id FROM agent_licenses WHERE user_id = $1', [req.userId]);
    const id = uuidv4();
    if (existing.length > 0) {
      await pool.query(
        `UPDATE agent_licenses SET reac_license_number = $1, reac_id = $2, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE user_id = $3`,
        [reac_license_number, reac_id || null, req.userId]
      );
    } else {
      await pool.query(
        `INSERT INTO agent_licenses (id, user_id, reac_license_number, reac_id, status) VALUES ($1, $2, $3, $4, 'pending')`,
        [id, req.userId, reac_license_number, reac_id || null]
      );
    }
    const { rows } = await pool.query('SELECT * FROM agent_licenses WHERE user_id = $1 LIMIT 1', [req.userId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.patch('/agent-license/:id/review', authMiddleware, requireAdmin, [
  body('status').isIn(['verified', 'rejected']),
  body('rejection_reason').optional().trim(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { id } = req.params;
    const { status, rejection_reason } = req.body;
    await pool.query(
      `UPDATE agent_licenses SET status = $1, verified_at = $2, verified_by = $3, rejection_reason = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5`,
      [status, status === 'verified' ? 'CURRENT_TIMESTAMP' : null, req.userId, status === 'rejected' ? (rejection_reason || null) : null, id]
    );
    const { rows } = await pool.query('SELECT * FROM agent_licenses WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get('/beneficial-owners', authMiddleware, async (req, res, next) => {
  try {
    const entityType = req.query.entity_type || 'project';
    const entityId = req.query.entity_id;
    if (!entityId) return res.status(400).json({ error: 'entity_id required' });
    const { rows } = await pool.query(
      `SELECT b.*, u.full_name, u.email FROM beneficial_owners b JOIN users u ON b.user_id = u.id WHERE b.entity_type = $1 AND b.entity_id = $2`,
      [entityType, entityId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/beneficial-owners', authMiddleware, [
  body('entity_type').optional().isIn(['project', 'company']),
  body('entity_id').trim().notEmpty(),
  body('user_id').trim().notEmpty(),
  body('stake_percent').isFloat({ min: 0, max: 100 }),
  body('role').optional().trim(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { entity_type = 'project', entity_id, user_id, stake_percent, role } = req.body;
    const id = uuidv4();
    await pool.query(
      `INSERT INTO beneficial_owners (id, entity_type, entity_id, user_id, stake_percent, role) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, entity_type, entity_id, user_id, stake_percent, role || null]
    );
    const { rows } = await pool.query('SELECT * FROM beneficial_owners WHERE id = $1', [id]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

export default router;
