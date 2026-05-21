/**
 * Sanitize project list/detail for clients so stream URLs are only present when allowed.
 */

import { isCustomerRole } from './roles.js';

/**
 * @param {Array<Record<string,unknown>>} rows - project rows from DB
 * @param {string} role - requester role
 * @returns {Array<Record<string,unknown>>} projects with can_view_live_stream set; stream URLs stripped for client/buyer when not allowed
 */
export function sanitizeProjectListForClient(rows, role) {
  if (!isCustomerRole(role)) return rows;
  return rows.map((p) => {
    const canView = !!p.client_can_view_live_stream;
    const out = { ...p, can_view_live_stream: canView };
    if (!canView) {
      out.live_stream_url = null;
      out.ivs_playback_url = null;
    }
    return out;
  });
}
