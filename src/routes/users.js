import express from 'express';
import pool from '../db/index.js';
import { deleteUserById } from '../lib/delete-user.js';
import { authMiddleware, requireAdmin, requireSuperAdmin, loadUser } from '../middleware/auth.js';
import { body, validationResult, query } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../lib/audit.js';
import { sendMail } from '../lib/email.js';
import { publicPropertyFilterSql } from '../lib/listing-state.js';
import { isCustomerRole } from '../lib/roles.js';

const router = express.Router();
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:3000').trim();

const validRoleList = ['client', 'buyer', 'vendor', 'vendor_admin', 'finance_admin', 'moderator', 'editor', 'admin', 'super_admin', 'agent'];

/** GET /api/v1/users - list users (admin) or own profile */
router.get('/', authMiddleware, [
  query('role').optional().isString().trim().isLength({ max: 100 }),
  query('country').optional().isString().trim().isLength({ max: 100 }),
  query('verified').optional().isIn(['true', 'false', '1', '0', '']),
  query('join_date_from').optional().isString().trim().isLength({ max: 32 }),
  query('join_date_to').optional().isString().trim().isLength({ max: 32 }),
  query('search').optional().isString().trim().isLength({ max: 200 }),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    if (req.userRole === 'admin' || req.userRole === 'super_admin') {
      let sql = `
        SELECT id, email, full_name, phone, country, role, verified, verification_status, verified_at, verification_level, verification_notes, email_verified, two_fa_enabled, created_at,
         (SELECT COUNT(*) FROM projects WHERE client_id = users.id) AS project_count
         FROM users WHERE 1=1`;
      const params = [];
      if (req.query.role) {
        const roleParam = String(req.query.role).trim();
        const roles = roleParam.split(',').map((r) => r.trim()).filter(Boolean);
        const validRoles = roles.filter((r) => validRoleList.includes(r));
        if (validRoles.length > 0) {
          sql += ` AND role IN (${validRoles.map((_, i) => `$${params.length + i + 1}`).join(',')})`;
          params.push(...validRoles);
        }
      }
      if (req.query.country) { params.push(req.query.country); sql += ` AND country = $${params.length}`; }
      if (req.query.verified !== undefined && req.query.verified !== '') {
        params.push(req.query.verified === 'true' || req.query.verified === '1' ? 1 : 0);
        sql += ` AND verified = $${params.length}`;
      }
      if (req.query.join_date_from) { params.push(req.query.join_date_from); sql += ` AND DATE(created_at) >= $${params.length}`; }
      if (req.query.join_date_to) { params.push(req.query.join_date_to); sql += ` AND DATE(created_at) <= $${params.length}`; }
      if (req.query.search) {
        const term = `%${String(req.query.search).trim()}%`;
        params.push(term, term);
        sql += ` AND (full_name LIKE $${params.length - 1} OR email LIKE $${params.length})`;
      }
      sql += ' ORDER BY created_at DESC';
      const { rows } = await pool.query(sql, params);
      return res.json(rows);
    }
    const { rows } = await pool.query(
      'SELECT id, email, full_name, phone, country, role, verified, verification_status, verified_at, verification_level, verification_notes, two_fa_enabled, created_at FROM users WHERE id = $1',
      [req.userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/users/pending-approvals - list vendors awaiting admin approval (admin only) */
router.get('/pending-approvals', authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, full_name, phone, country, role, verified, created_at
       FROM users WHERE role = 'vendor' AND COALESCE(verification_status, 'submitted') <> 'approved'
       ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/v1/users/:id/approve - approve a vendor and send approval email (admin only) */
router.patch('/:id/approve', authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      'SELECT id, email, full_name, role, verified, verification_status FROM users WHERE id = $1',
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = rows[0];
    if (user.role !== 'vendor') {
      return res.status(400).json({ error: 'Only vendor (agent/contractor) accounts can be approved via this endpoint' });
    }
    /** Admin queue uses `verification_status`; `verified` is a legacy/active flag that may be true before admin review — do not gate on it. */
    if (user.verification_status === 'approved') {
      return res.status(400).json({ error: 'User is already approved' });
    }
    try {
      await pool.query(
        'UPDATE users SET verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [id]
      );
    } catch (err) {
      // Backward compatibility for older SQLite schemas missing updated_at.
      const msg = err instanceof Error ? err.message : String(err);
      if (/no such column:\s*updated_at/i.test(msg)) {
        await pool.query('UPDATE users SET verified = 1 WHERE id = $1', [id]);
      } else {
        throw err;
      }
    }
    await pool.query(
      `UPDATE users
       SET verification_status = 'approved',
           verified_at = COALESCE(verified_at, CURRENT_TIMESTAMP),
           verification_level = COALESCE(verification_level, 'basic'),
           verification_notes = COALESCE(verification_notes, 'Approved by admin review')
       WHERE id = $1`,
      [id]
    ).catch(() => {});
    const loginUrl = `${FRONTEND_URL}/login`;
    await sendMail({
      to: user.email,
      subject: 'Botch Realty — Your account has been approved',
      text: `Your account has been approved. You can sign in now at ${loginUrl}`,
      html: `<p>Your account has been approved.</p><p>You can sign in now at <a href="${loginUrl}">${loginUrl}</a>.</p><p>— Botch Realty</p>`,
    }).catch((err) => console.error('[users] Approval email failed:', err.message));
    logAudit({
      userId: req.userId,
      action: 'user_approve',
      resourceType: 'user',
      resourceId: id,
      details: JSON.stringify({ email: user.email }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    const { rows: updated } = await pool.query(
      'SELECT id, email, full_name, phone, country, role, verified, verification_status, verified_at, verification_level, verification_notes, created_at FROM users WHERE id = $1',
      [id]
    );
    res.json(updated[0]);
  } catch (err) {
    // Return friendlier operational errors instead of generic 500 where possible.
    if (err?.code === 'SQLITE_BUSY' || err?.code === '40P01') {
      return res.status(503).json({ error: 'Approval is temporarily unavailable. Please retry in a moment.' });
    }
    next(err);
  }
});

/** GET /api/v1/users/me/favorites - current user's saved listings */
router.get('/me/favorites', authMiddleware, async (req, res, next) => {
  try {
    const pub = publicPropertyFilterSql('');
    const { rows } = await pool.query(
      `SELECT p.*, pf.created_at AS saved_at
       FROM property_favorites pf
       JOIN properties p ON p.id = pf.property_id
       WHERE pf.user_id = $1 AND ${pub}
       ORDER BY pf.created_at DESC`,
      [req.userId]
    );
    res.json(rows || []);
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/users/:id/public-key - get user's public key for E2EE (only for messaging partners) */
router.get('/:id/public-key', authMiddleware, async (req, res, next) => {
  try {
    const targetId = req.params.id;
    if (targetId === req.userId) {
      const { rows } = await pool.query('SELECT public_key FROM users WHERE id = $1', [req.userId]);
      return res.json({ public_key: rows[0]?.public_key || null });
    }
    const { rows: target } = await pool.query('SELECT id, role FROM users WHERE id = $1', [targetId]);
    if (target.length === 0) return res.status(404).json({ error: 'User not found' });
    const isAdmin = req.userRole === 'admin' || req.userRole === 'super_admin';
    const targetRole = target[0].role;
    // Allow if we can message each other: admin can get any user's key; client can get admin's key; admin can get client's key (same project)
    const allowed =
      isAdmin ||
      (isCustomerRole(req.userRole) && targetRole === 'admin') ||
      (req.userRole === 'admin' && (targetRole === 'client' || targetRole === 'buyer')) ||
      req.userRole === 'super_admin';
    if (!allowed) return res.status(403).json({ error: "You don't have permission to do that." });
    const { rows } = await pool.query('SELECT public_key FROM users WHERE id = $1', [targetId]);
    res.json({ public_key: rows[0]?.public_key || null });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/users/:id - get user by id (admin) or self */
router.get('/:id', authMiddleware, async (req, res, next) => {
  try {
    if (req.userRole !== 'admin' && req.userRole !== 'super_admin' && req.params.id !== req.userId) {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }
    const { rows } = await pool.query(
      'SELECT id, email, full_name, phone, country, role, verified, verification_status, verified_at, verification_level, verification_notes, two_fa_enabled, created_at FROM users WHERE id = $1',
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/v1/users/:id - update user (admin or self for profile) */
router.patch('/:id', authMiddleware, [
  body('full_name').optional().trim().isLength({ max: 255 }),
  body('phone').optional().trim().isLength({ max: 50 }),
  body('country').optional().trim().isLength({ max: 100 }),
  body('verified').optional().isBoolean(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    if (req.userRole !== 'admin' && req.userRole !== 'super_admin' && req.params.id !== req.userId) {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }
    const allowed = ['full_name', 'phone', 'country'];
    if (req.userRole === 'admin' || req.userRole === 'super_admin') allowed.push('verified', 'verification_status', 'verification_level', 'verification_notes');
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] === undefined) continue;
      if (key === 'verified') {
        updates[key] = req.body[key] ? 1 : 0;
      } else if (key === 'verification_status') {
        const normalized = String(req.body[key] || '').trim();
        if (!['submitted', 'pending_review', 'approved', 'rejected'].includes(normalized)) {
          return res.status(400).json({ error: 'Invalid verification_status' });
        }
        updates[key] = normalized;
        if (normalized === 'approved') {
          updates.verified = 1;
          updates.verified_at = new Date().toISOString();
        } else if (normalized === 'rejected') {
          updates.verified = 0;
        }
      } else {
        updates[key] = req.body[key];
      }
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    const setClause = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = Object.values(updates);
    // Placeholders in SQL: $2, $3... (SET), then $1 (WHERE). SQLite ? order = appearance order, so pass values first then id.
    await pool.query(
      `UPDATE users SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [...values, req.params.id]
    );
    logAudit({
      userId: req.userId,
      action: (req.userRole === 'admin' || req.userRole === 'super_admin') ? 'user_update' : 'profile_update',
      resourceType: 'user',
      resourceId: req.params.id,
      details: JSON.stringify(updates),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    const { rows } = await pool.query(
      'SELECT id, email, full_name, phone, country, role, verified, verification_status, verified_at, verification_level, verification_notes FROM users WHERE id = $1',
      [req.params.id]
    );
    res.json(rows[0] || {});
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/users - create user (admin/super_admin: client or vendor; super_admin only: admin or super_admin) */
router.post('/', authMiddleware, requireAdmin, [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  body('full_name').optional().trim(),
  body('phone').optional().trim(),
  body('country').optional().trim(),
  body('role').optional().isIn(['client', 'buyer', 'vendor', 'vendor_admin', 'finance_admin', 'moderator', 'editor', 'admin', 'super_admin', 'agent']),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const role = req.body.role || 'client';
    // Only super_admin can create admin or super_admin users.
    if ((role === 'admin' || role === 'super_admin') && req.userRole !== 'super_admin') {
      return res.status(403).json({ error: 'Only a super admin can add admin or super admin users' });
    }
    // Scoped admin roles can be created by admin-class users.
    if (['vendor_admin', 'finance_admin', 'moderator', 'editor'].includes(role)) {
      const canCreateScopedRole = ['admin', 'super_admin', 'vendor_admin', 'finance_admin', 'moderator', 'editor'].includes(req.userRole);
      if (!canCreateScopedRole) {
        return res.status(403).json({ error: 'Only admin-level accounts can assign scoped admin roles' });
      }
    }
    const bcrypt = (await import('bcryptjs')).default;
    const passwordHash = await bcrypt.hash(req.body.password, 12);
    const id = uuidv4();
    if (role === 'agent') {
      await pool.query(
        `INSERT INTO users (id, email, password_hash, full_name, phone, country, role, verified, verification_status, verified_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'approved', CURRENT_TIMESTAMP)`,
        [id, req.body.email, passwordHash, req.body.full_name || null, req.body.phone || null, req.body.country || null, role]
      );
    } else {
      await pool.query(
        `INSERT INTO users (id, email, password_hash, full_name, phone, country, role) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, req.body.email, passwordHash, req.body.full_name || null, req.body.phone || null, req.body.country || null, role]
      );
    }
    logAudit({
      userId: req.userId,
      action: 'user_create',
      resourceType: 'user',
      resourceId: id,
      details: JSON.stringify({ email: req.body.email, role }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    const { rows } = await pool.query(
      'SELECT id, email, full_name, phone, country, role, verified, created_at FROM users WHERE id = $1',
      [id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    if (err.code === 'SQLITE_CONSTRAINT' && (err.message || '').toLowerCase().includes('unique')) return res.status(409).json({ error: 'Email already exists' });
    console.error('[POST /users]', err.message || err);
    next(err);
  }
});

/** DELETE /api/v1/users/:id - admin: clients only; super_admin: clients or admin-class roles (not self, not super_admin) */
router.delete('/:id', authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    const targetId = req.params.id;
    if (targetId === req.userId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    const { rows } = await pool.query(
      'SELECT id, role FROM users WHERE id = $1',
      [targetId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const role = rows[0].role;
    const isSuperAdmin = req.userRole === 'super_admin';
    const scopedAdminRoles = ['vendor_admin', 'finance_admin', 'moderator', 'editor'];
    if (role === 'client' || role === 'buyer' || role === 'agent') {
      // admin or super_admin can delete clients, buyers, and Botch subcontractor agents
    } else if (role === 'admin' && isSuperAdmin) {
      // only super_admin can delete admins
    } else if (scopedAdminRoles.includes(role) && isSuperAdmin) {
      // only super_admin can delete scoped admin roles
    } else if (role === 'super_admin') {
      return res.status(403).json({ error: 'Super admin accounts cannot be deleted via this endpoint' });
    } else {
      return res.status(403).json({ error: 'Can only delete client, buyer, or agent accounts; super admin can also delete admin-class roles' });
    }

    await deleteUserById(targetId);

    logAudit({
      userId: req.userId,
      action: 'user_delete',
      resourceType: 'user',
      resourceId: targetId,
      details: JSON.stringify({ deletedRole: role }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
