import pool from '../db/index.js';
import { getChannelSubscriptionsForOrg } from './vendor-channel-subscriptions.js';

export async function resolveVendorBusinessStatus(db, userId) {
  const queryable = db || pool;
  const { rows: userRows } = await queryable.query(
    'SELECT id, role, verified, vendor_org_id FROM users WHERE id = $1',
    [userId]
  );
  if (!userRows.length) {
    return { active: false, code: 'user_not_found', reason: 'User not found' };
  }
  const user = userRows[0];

  if (user.role !== 'vendor') {
    return { active: true, code: 'not_vendor', reason: 'User is not a vendor' };
  }
  if (!user.vendor_org_id) {
    return { active: false, code: 'no_vendor_org', reason: 'Vendor is not linked to an organization' };
  }

  const { rows: orgRows } = await queryable.query(
    `SELECT id, legal_name, status,
            module_marketplace_enabled, module_properties_enabled, module_rentals_enabled
     FROM vendor_organizations WHERE id = $1`,
    [user.vendor_org_id]
  );
  if (!orgRows.length) {
    return { active: false, code: 'vendor_org_missing', reason: 'Vendor organization record is missing' };
  }
  const org = orgRows[0];

  const modules = {
    marketplace: org.module_marketplace_enabled !== false && org.module_marketplace_enabled !== 0,
    properties: org.module_properties_enabled === true || org.module_properties_enabled === 1,
    rentals: org.module_rentals_enabled === true || org.module_rentals_enabled === 1,
  };

  const channel_subscriptions = await getChannelSubscriptionsForOrg(queryable, org.id);

  const orgApproved = org.status === 'approved';
  const active = orgApproved;
  let code = 'active';
  let reason = 'Vendor organization is approved';
  if (!orgApproved) {
    code = 'org_not_approved';
    reason = 'Vendor organization has not been approved';
  }

  return {
    active,
    code,
    reason,
    vendor_org_id: org.id,
    vendor_org_status: org.status,
    user_verified: user.verified === true || user.verified === 1,
    modules,
    channel_subscriptions,
  };
}
