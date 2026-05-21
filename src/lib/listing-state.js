/**
 * Listing lifecycle helpers: public visibility and admin moderation rules.
 */

/**
 * SQL AND conditions for a property row to appear on the public site.
 * Prefer canonical listing_state = 'published'; treat admin-moderation 'approved' as visible too
 * (vendor listings often stop there until authenticity/publish checklist completes).
 * Fall back for rows not migrated yet.
 * @param {string} [alias] - Table alias with trailing dot, e.g. "p."
 */
export function publicPropertyFilterSql(alias = '') {
  const a = alias;
  return `(
    COALESCE(${a}listing_state, '') = 'published'
    OR COALESCE(${a}listing_state, '') = 'approved'
    OR (
      ${a}listing_state IS NULL
      AND COALESCE(${a}publish_status, 'published') = 'published'
      AND COALESCE(${a}status, 'published') = 'published'
      AND COALESCE(${a}moderation_status, 'approved') = 'approved'
    )
  )`
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string | null | undefined} moderation
 * @param {string | null | undefined} publishStatus
 */
export function canSetPublishStatus(moderation, publishStatus) {
  if (publishStatus === 'published' && moderation !== 'approved') {
    return { ok: false, error: 'Cannot publish listing until moderation_status is approved' };
  }
  return { ok: true };
}

/** @param {string} from @param {string} to */
export function canTransitionModeration(from, to) {
  const allowed = {
    pending: ['approved', 'rejected'],
    rejected: ['pending', 'approved'],
    approved: ['pending'],
  };
  const f = from || 'approved';
  if (f === to) return true;
  const next = allowed[f];
  return Boolean(next && next.includes(to));
}

/** @param {string} av */
export function canTransitionAvailability(av) {
  return ['available', 'unavailable', 'booked'].includes(av);
}
