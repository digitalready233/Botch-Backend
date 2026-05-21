/**
 * Canonical property listing workflow (single listing_state column).
 * Legacy moderation_status / publish_status / status are derived and updated in sync.
 */

export const LISTING_STATES = Object.freeze({
  DRAFT: 'draft',
  PENDING_REVIEW: 'pending_review',
  APPROVED: 'approved',
  PUBLISHED: 'published',
  PAUSED: 'paused',
  SOLD: 'sold',
  RENTED: 'rented',
  ARCHIVED: 'archived',
  REJECTED: 'rejected',
});

/** All valid listing_state values (for validators / CHECK constraints). */
export const LISTING_STATE_VALUES = Object.freeze(Object.values(LISTING_STATES));

/**
 * Allowed transitions (directed edges). Same-state is always idempotent (handled before graph check).
 * @type {Record<string, string[]>}
 */
export const LISTING_STATE_TRANSITIONS = Object.freeze({
  draft: ['pending_review'],
  pending_review: ['approved', 'rejected'],
  approved: ['published'],
  published: ['paused', 'sold', 'rented', 'archived'],
  paused: ['published'],
  rejected: ['draft'],
  sold: ['archived'],
  rented: ['archived'],
  archived: [],
});

/** DB + API row shape for normalization */
export function normalizeListingState(row) {
  if (!row) return LISTING_STATES.DRAFT;
  const ls = row.listing_state;
  if (ls && LISTING_STATE_VALUES.includes(ls)) return ls;
  if (row.moderation_status === 'rejected') return LISTING_STATES.REJECTED;
  const pub = row.publish_status || 'published';
  const st = row.status || 'published';
  const mod = row.moderation_status || 'approved';
  if (mod === 'approved' && pub === 'published' && st === 'published') return LISTING_STATES.PUBLISHED;
  if (mod === 'approved' && pub === 'draft') return LISTING_STATES.APPROVED;
  if (mod === 'pending' && pub === 'draft') return LISTING_STATES.PENDING_REVIEW;
  return LISTING_STATES.DRAFT;
}

/**
 * Legacy columns kept in sync for older code paths and reporting.
 * @param {string} listingState
 */
export function getSyncedColumnsForListingState(listingState) {
  switch (listingState) {
    case LISTING_STATES.DRAFT:
    case LISTING_STATES.PENDING_REVIEW:
      return {
        moderation_status: 'pending',
        publish_status: 'draft',
        status: 'draft',
        availability_status: 'available',
      };
    case LISTING_STATES.APPROVED:
      return {
        moderation_status: 'approved',
        publish_status: 'draft',
        status: 'draft',
        availability_status: 'available',
      };
    case LISTING_STATES.PUBLISHED:
      return {
        moderation_status: 'approved',
        publish_status: 'published',
        status: 'published',
        availability_status: 'available',
      };
    case LISTING_STATES.PAUSED:
      return {
        moderation_status: 'approved',
        publish_status: 'unpublished',
        status: 'published',
        availability_status: 'unavailable',
      };
    case LISTING_STATES.SOLD:
    case LISTING_STATES.RENTED:
      return {
        moderation_status: 'approved',
        publish_status: 'unpublished',
        status: 'published',
        availability_status: 'unavailable',
      };
    case LISTING_STATES.ARCHIVED:
      return {
        moderation_status: 'approved',
        publish_status: 'unpublished',
        status: 'draft',
        availability_status: 'unavailable',
      };
    case LISTING_STATES.REJECTED:
      return {
        moderation_status: 'rejected',
        publish_status: 'draft',
        status: 'draft',
        availability_status: 'unavailable',
      };
    default:
      return getSyncedColumnsForListingState(LISTING_STATES.DRAFT);
  }
}

/**
 * @param {string} role - JWT role
 * @returns {boolean}
 */
function isAdminRole(role) {
  return role === 'admin' || role === 'super_admin';
}

function isVendorRole(role) {
  return role === 'vendor';
}

/**
 * Strict transition + role check.
 * @param {{ from: string, to: string, role: string, listingPurpose?: string }} args
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateListingStateTransition({ from, to, role, listingPurpose }) {
  const purpose = listingPurpose || 'sale';
  if (to === from) return { ok: true };

  if (!LISTING_STATE_VALUES.includes(to)) {
    return { ok: false, error: `Invalid listing_state: ${to}` };
  }

  const allowed = LISTING_STATE_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    return { ok: false, error: `Transition from "${from}" to "${to}" is not allowed` };
  }

  if (to === LISTING_STATES.SOLD && purpose !== 'sale') {
    return { ok: false, error: 'State "sold" applies only to sale listings' };
  }
  if (to === LISTING_STATES.RENTED && purpose !== 'rent') {
    return { ok: false, error: 'State "rented" applies only to rent listings' };
  }

  if (from === LISTING_STATES.PENDING_REVIEW && (to === LISTING_STATES.APPROVED || to === LISTING_STATES.REJECTED)) {
    if (!isAdminRole(role)) {
      return { ok: false, error: 'Only administrators can approve or reject listings' };
    }
    return { ok: true };
  }

  if (
    (from === LISTING_STATES.DRAFT && to === LISTING_STATES.PENDING_REVIEW) ||
    (from === LISTING_STATES.REJECTED && to === LISTING_STATES.DRAFT)
  ) {
    if (!isAdminRole(role) && !isVendorRole(role)) {
      return { ok: false, error: 'Insufficient permissions to submit or reset this listing' };
    }
    return { ok: true };
  }

  if (!isAdminRole(role)) {
    return { ok: false, error: 'Only administrators can perform this transition' };
  }

  return { ok: true };
}

/**
 * Initial states allowed on create (POST). Stricter than full graph.
 */
export const LISTING_STATE_ON_CREATE = Object.freeze([LISTING_STATES.DRAFT, LISTING_STATES.PENDING_REVIEW]);

export function validateInitialListingState(listingState, role) {
  if (!listingState || listingState === LISTING_STATES.DRAFT) return { ok: true };
  if (!LISTING_STATE_ON_CREATE.includes(listingState)) {
    return { ok: false, error: `New listings may only start as ${LISTING_STATE_ON_CREATE.join(' or ')}` };
  }
  if (listingState === LISTING_STATES.PENDING_REVIEW && !isAdminRole(role) && !isVendorRole(role)) {
    return { ok: false, error: 'Insufficient permissions for initial state' };
  }
  return { ok: true };
}

/**
 * Targets the current user may move to (for admin/vendor UIs).
 * @param {string} from
 * @param {string} role
 * @param {string} [listingPurpose]
 * @returns {string[]}
 */
export function allowedListingStateTargets(from, role, listingPurpose) {
  const raw = LISTING_STATE_TRANSITIONS[from] || [];
  return raw.filter((to) => validateListingStateTransition({ from, to, role, listingPurpose }).ok);
}
