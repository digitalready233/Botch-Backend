import pool from '../db/index.js';

/**
 * Resolve handling agent for a listing: listing_agent_id (vendor), else vendor creator,
 * else first vendor, else first admin.
 */
export async function resolveListingAgentId(propertyId) {
  const { rows: pr } = await pool.query(
    `SELECT p.listing_agent_id, p.created_by FROM properties p WHERE p.id = $1`,
    [propertyId]
  );
  if (!pr.length) return null;
  const p = pr[0];
  if (p.listing_agent_id) {
    const { rows: a } = await pool.query(
      `SELECT id
       FROM users
       WHERE id = $1
         AND role = 'vendor'
         AND verification_status = 'approved'`,
      [p.listing_agent_id]
    );
    if (a.length) return p.listing_agent_id;
  }
  if (p.created_by) {
    const { rows: v } = await pool.query(
      `SELECT id
       FROM users
       WHERE id = $1
         AND role = 'vendor'
         AND verification_status = 'approved'`,
      [p.created_by]
    );
    if (v.length) return p.created_by;
  }
  const { rows: vendors } = await pool.query(
    "SELECT id FROM users WHERE role = 'vendor' AND verification_status = 'approved' ORDER BY created_at ASC LIMIT 1"
  );
  if (vendors.length) return vendors[0].id;
  const { rows: admins } = await pool.query(
    "SELECT id FROM users WHERE role IN ('admin', 'super_admin') ORDER BY created_at ASC LIMIT 1"
  );
  return admins[0]?.id ?? null;
}
