import { body, param, query } from 'express-validator';

/**
 * Projects (and related rows) use TEXT ids in SQLite; production may use UUIDs while seeds use slugs.
 * Allow alphanumeric, underscore, hyphen; length-bounded. Excludes slashes and spaces to avoid path/query issues.
 */
const PLAIN_RESOURCE_ID = /^[a-zA-Z0-9_-]{1,200}$/;

function idChain(chain, message) {
  return chain.trim().isLength({ min: 1, max: 200 }).matches(PLAIN_RESOURCE_ID).withMessage(message);
}

/** `param('projectId')` for `/projects/:projectId/...` */
export function paramProjectId() {
  return idChain(param('projectId'), 'Invalid project id');
}

/** `param('docId')` (and similar resource ids stored as TEXT, including seed slugs) */
export function paramDocId() {
  return idChain(param('docId'), 'Invalid document id');
}

/** `query('project_id')` */
export function queryProjectId() {
  return idChain(query('project_id'), 'Invalid project id');
}

/** `body('project_id')` */
export function bodyProjectId() {
  return idChain(body('project_id'), 'Invalid project id');
}
