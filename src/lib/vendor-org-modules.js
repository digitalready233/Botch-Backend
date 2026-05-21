/** Whether a value from PG (boolean) or SQLite (0/1) is enabled. */
export function moduleFlagEnabled(value) {
  return value === true || value === 1 || value === '1';
}

/** Store module flags as 0/1 for SQLite; PG accepts both boolean and integer. */
export function moduleFlagToDb(value) {
  return moduleFlagEnabled(value) ? 1 : 0;
}

const SIGNUP_CHANNELS = new Set(['marketplace', 'properties', 'rentals']);

/** Map vendor signup channel choice to org module flags (only the selected channel is enabled). */
export function moduleFlagsForSignupVendorChannel(channel) {
  const ch = SIGNUP_CHANNELS.has(channel) ? channel : 'marketplace';
  return {
    module_marketplace_enabled: moduleFlagToDb(ch === 'marketplace'),
    module_properties_enabled: moduleFlagToDb(ch === 'properties'),
    module_rentals_enabled: moduleFlagToDb(ch === 'rentals'),
  };
}

/**
 * @param {import('pg').Pool | import('pg').PoolClient} queryable
 * @param {string} userId
 * @param {'marketplace' | 'properties' | 'rentals'} moduleKey
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function assertVendorOrgModuleEnabled(queryable, userId, moduleKey) {
  const col =
    moduleKey === 'marketplace'
      ? 'module_marketplace_enabled'
      : moduleKey === 'properties'
        ? 'module_properties_enabled'
        : moduleKey === 'rentals'
          ? 'module_rentals_enabled'
          : null;
  if (!col) return { ok: false, error: 'Invalid module' };

  const { rows } = await queryable.query(
    `SELECT vo.${col} AS enabled
     FROM users u
     INNER JOIN vendor_organizations vo ON vo.id = u.vendor_org_id
     WHERE u.id = $1 AND u.role = 'vendor'`,
    [userId]
  );
  if (!rows.length) {
    return { ok: false, error: 'Vendor organization not found. Complete company setup first.' };
  }
  if (!moduleFlagEnabled(rows[0].enabled)) {
    return {
      ok: false,
      error: `The ${moduleKey} channel is turned off for your business. Enable it under Billing → Channel access.`,
    };
  }
  return { ok: true };
}
