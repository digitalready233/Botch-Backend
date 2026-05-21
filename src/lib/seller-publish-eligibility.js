/**
 * Whether a seller (user ± linked vendor org) is allowed to have marketplace content published.
 * Org-backed vendors: company verification OR individually approved user counts (admins often approve the person first).
 */
export function isSellerVerificationApproved(row) {
  if (!row) return false;
  const userOk = row.user_verification_status === 'approved';
  const orgId = row.vendor_org_id;
  if (!orgId) return userOk;
  const orgOk =
    row.org_verification_status === 'approved' ||
    String(row.org_status ?? '').toLowerCase() === 'approved';
  return orgOk || userOk;
}
