import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const SESSION_TIMEOUT_MS = Number(process.env.SESSION_TIMEOUT_MS) || 30 * 60 * 1000; // 30 min

const lastActivityByUserId = new Map();

/**
 * Reset inactivity timer when a user logs in or refreshes tokens.
 * Without this, a stale timestamp from a previous session can cause immediate
 * "session expired due to inactivity" on the first API call after login.
 */
export function touchSessionActivity(userId) {
  if (!userId || SESSION_TIMEOUT_MS <= 0) return;
  lastActivityByUserId.set(userId, Date.now());
}

/**
 * Clear activity (e.g. optional future use on logout).
 */
export function clearSessionActivity(userId) {
  if (userId) lastActivityByUserId.delete(userId);
}

/**
 * Update last activity for session timeout. Call after authMiddleware.
 */
export function sessionActivityMiddleware(req, res, next) {
  if (req.userId) lastActivityByUserId.set(req.userId, Date.now());
  next();
}

/**
 * Enforce session timeout (inactivity). Use after authMiddleware + sessionActivityMiddleware.
 */
export function sessionTimeoutMiddleware(req, res, next) {
  if (!req.userId) return next();
  const last = lastActivityByUserId.get(req.userId);
  if (last != null && Date.now() - last > SESSION_TIMEOUT_MS) {
    lastActivityByUserId.delete(req.userId);
    return res.status(401).json({ error: 'Session expired due to inactivity. Please log in again.' });
  }
  next();
}

/**
 * Verify JWT and attach user to req. Requires Authorization: Bearer <token>
 * Also enforces session timeout (30 min inactivity) when SESSION_TIMEOUT_MS is set.
 */
export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userRole = decoded.role;
    if (SESSION_TIMEOUT_MS > 0) {
      const last = lastActivityByUserId.get(req.userId);
      if (last != null && Date.now() - last > SESSION_TIMEOUT_MS) {
        lastActivityByUserId.delete(req.userId);
        return res.status(401).json({ error: 'Session expired due to inactivity. Please log in again.' });
      }
      lastActivityByUserId.set(req.userId, Date.now());
    }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Require admin role (admin or super_admin can access admin routes)
 */
export function requireAdmin(req, res, next) {
  if (!['admin', 'super_admin', 'vendor_admin', 'finance_admin', 'moderator', 'editor'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Require super_admin role (only super_admin can add/remove admins)
 */
export function requireSuperAdmin(req, res, next) {
  if (req.userRole !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}

/**
 * Require client role (or admin)
 */
export function requireClient(req, res, next) {
  if (req.userRole !== 'client' && !['admin', 'super_admin', 'vendor_admin', 'finance_admin', 'moderator', 'editor'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Client access required' });
  }
  next();
}

/** Vendor (agent) or admin — for future agent-scoped listing tools */
export function requireVendor(req, res, next) {
  if (req.userRole !== 'vendor' && !['admin', 'super_admin', 'vendor_admin', 'finance_admin', 'moderator', 'editor'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Agent access required' });
  }
  next();
}

/** Require JWT role to be one of the allowed values */
export function requireRole(...allowed) {
  return (req, res, next) => {
    if (allowed.includes(req.userRole)) return next();
    return res.status(403).json({ error: 'Access denied' });
  };
}
