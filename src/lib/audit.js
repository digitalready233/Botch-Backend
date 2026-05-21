/**
 * Audit log for admin actions.
 */

import pool from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';

export async function logAudit(opts) {
  const { userId, action, resourceType, resourceId, details, ip, userAgent } = opts || {};
  if (!userId || !action) return;
  const id = uuidv4();
  try {
    await pool.query(
      `INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, details, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, userId, action, resourceType || null, resourceId || null, details || null, ip || null, userAgent || null]
    );
  } catch (err) {
    console.error('[audit] Failed to write log:', err.message);
  }
}
