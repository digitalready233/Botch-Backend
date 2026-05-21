/**
 * Shared uploads base path. When UPLOADS_PATH is set (e.g. /data/uploads on Render disk),
 * all uploads (chat, receipts, invoices, documents, KYC, media) go there so they persist.
 */

import path from 'path';

/**
 * @param {string} defaultPath - Fallback when UPLOADS_PATH is not set (e.g. path.join(__dirname, '..', '..', 'uploads'))
 * @returns {string}
 */
export function getUploadsBase(defaultPath) {
  return process.env.UPLOADS_PATH ? path.resolve(process.env.UPLOADS_PATH) : defaultPath;
}
