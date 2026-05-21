import pool from '../db/index.js';
import { getUserPermissions } from '../lib/permissions.js';

export {
  touchSessionActivity,
  clearSessionActivity,
  sessionActivityMiddleware,
  sessionTimeoutMiddleware,
  authMiddleware,
  requireAdmin,
  requireSuperAdmin,
  requireClient,
  requireVendor,
  requireRole,
} from './auth-session.js';

// Opt-in: set MFA_ENFORCE_ADMIN_AGENT=true to require 2FA for admin/vendor. Default false so existing admins can use dashboard until they enroll.
const MFA_ENFORCE_PRIVILEGED = process.env.MFA_ENFORCE_ADMIN_AGENT === 'true';

/**
 * Load full user into req.user
 */
export async function loadUser(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, full_name, phone, country, role, verified, email_verified, two_fa_enabled, verification_provider, created_at FROM users WHERE id = $1',
      [req.userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    req.user = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Require MFA for admin, super_admin, and vendor (agent) roles. Use after authMiddleware; loads user if req.user not set.
 * When MFA is not set up, returns 403 with code MFA_REQUIRED so frontend can redirect to 2FA setup.
 */
export async function requireMfaForPrivileged(req, res, next) {
  if (!MFA_ENFORCE_PRIVILEGED) return next();
  const role = req.userRole;
  if (!['admin', 'super_admin', 'vendor', 'vendor_admin', 'finance_admin', 'moderator', 'editor'].includes(role)) return next();
  try {
    let user = req.user;
    if (!user) {
      const { rows } = await pool.query(
        'SELECT id, two_fa_enabled FROM users WHERE id = $1',
        [req.userId]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
      user = rows[0];
    }
    const mfaOn = user.two_fa_enabled === true || user.two_fa_enabled === 1;
    if (!mfaOn) {
      return res.status(403).json({
        error: 'Multi-factor authentication is required for your role. Please enable 2FA in your account settings.',
        code: 'MFA_REQUIRED',
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Require a named permission from effective role privileges.
 * Use after authMiddleware.
 */
export function requirePermission(permissionKey) {
  return async (req, res, next) => {
    try {
      const role = req.userRole;
      if (!role) return res.status(401).json({ error: 'Authentication required' });
      const permissions = await getUserPermissions(pool, role);
      if (!permissions.includes(permissionKey)) {
        return res.status(403).json({ error: 'Permission denied' });
      }
      req.userPermissions = permissions;
      next();
    } catch (err) {
      next(err);
    }
  };
}
