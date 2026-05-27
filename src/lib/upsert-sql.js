import { getDbKind } from '../db/index.js';

/**
 * Replaces PostgreSQL `excluded.col` with MySQL `VALUES(col)` in assignment expressions.
 */
function mapExcludedToValues(expr) {
  return expr.replace(/\bexcluded\.(\w+)/gi, 'VALUES($1)');
}

/**
 * @param {string} uniqueCols - e.g. "(property_id, vendor_id)"
 * @param {string} setClause - e.g. "message = COALESCE(excluded.message, message)"
 */
export function sqlConflictDoUpdate(uniqueCols, setClause) {
  if (getDbKind() === 'mysql') {
    return `ON DUPLICATE KEY UPDATE ${mapExcludedToValues(setClause)}`;
  }
  return `ON CONFLICT ${uniqueCols} DO UPDATE SET ${setClause}`;
}

/**
 * @param {string} uniqueCols - e.g. "(email)" or "(review_id, reporter_user_id)"
 */
export function sqlConflictDoNothing(uniqueCols) {
  if (getDbKind() === 'mysql') {
    return '';
  }
  return `ON CONFLICT ${uniqueCols} DO NOTHING`;
}

/** Prefix for INSERT when DO NOTHING on MySQL (no ON CONFLICT). */
export function sqlInsertVerb() {
  return getDbKind() === 'mysql' ? 'INSERT IGNORE' : 'INSERT';
}
