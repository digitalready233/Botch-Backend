/**
 * Check if a vendor has a verified agent license.
 * Returns true only when agent_licenses has status = 'verified' for the user.
 */
export async function isVendorLicenseVerified(pool, userId) {
  const { rows } = await pool.query(
    'SELECT status FROM agent_licenses WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  return rows.length > 0 && rows[0].status === 'verified';
}

export const AGENT_VERIFICATION_ERROR = {
  error: 'Complete agent verification before accessing projects and uploading progress.',
  code: 'AGENT_VERIFICATION_REQUIRED',
};
