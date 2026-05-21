import express from 'express';
import { body, validationResult } from 'express-validator';
import pool from '../db/index.js';
import { authMiddleware, requireAdmin, requirePermission } from '../middleware/auth.js';
import {
  PRIVILEGE_CATALOG,
  canManageRolePrivileges,
  getRoleKeys,
  getRolePermissionMatrix,
  isKnownPermission,
  isKnownRole,
} from '../lib/permissions.js';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../lib/audit.js';

const router = express.Router();

router.get('/settings', authMiddleware, requireAdmin, requirePermission('settings.manage_privileges'), async (req, res, next) => {
  try {
    const matrix = await getRolePermissionMatrix(pool);
    const roles = getRoleKeys();
    const editableRoles = roles.filter((role) => canManageRolePrivileges(req.userRole, role));
    res.json({
      roles,
      editableRoles,
      catalog: PRIVILEGE_CATALOG,
      matrix,
    });
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/settings',
  authMiddleware,
  requireAdmin,
  requirePermission('settings.manage_privileges'),
  [
    body('role').isString().trim().notEmpty(),
    body('permission').isString().trim().notEmpty(),
    body('enabled').isBoolean(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const role = String(req.body.role || '').trim();
      const permission = String(req.body.permission || '').trim();
      const enabled = Boolean(req.body.enabled);

      if (!isKnownRole(role)) return res.status(400).json({ error: 'Unknown role' });
      if (!isKnownPermission(permission)) return res.status(400).json({ error: 'Unknown permission' });
      if (role === 'super_admin') {
        return res.status(403).json({ error: 'super_admin privileges are immutable and always enabled' });
      }
      if (!canManageRolePrivileges(req.userRole, role)) {
        return res.status(403).json({ error: 'You cannot change privileges for this role' });
      }

      const rowId = uuidv4();
      await pool.query(
        `INSERT INTO role_permissions (id, role, permission_key, is_enabled, updated_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(role, permission_key)
         DO UPDATE SET is_enabled = excluded.is_enabled, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
        [rowId, role, permission, enabled ? 1 : 0, req.userId]
      );

      logAudit({
        userId: req.userId,
        action: 'role_permission_update',
        resourceType: 'role_permissions',
        resourceId: `${role}:${permission}`,
        details: JSON.stringify({ role, permission, enabled }),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({ ok: true, role, permission, enabled });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
