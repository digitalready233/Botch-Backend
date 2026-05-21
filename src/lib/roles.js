/**
 * Role model (see plan: Buyer vs Client):
 * - `client` — project homeowner / assigned construction client (projects, invoices, site visits).
 * - `buyer` — transactional customer (marketplace, property/rental inquiries, offers); no project shell unless promoted.
 * - Commerce APIs should use {@link isCustomerRole} for actions that apply to either.
 */

/** @param {string | null | undefined} role */
export function isCustomerRole(role) {
  return role === 'client' || role === 'buyer';
}

/** @param {string | null | undefined} role */
export function isProjectClientRole(role) {
  return role === 'client';
}
