import pool from '../db/index.js';
import { getDbKind } from '../db/index.js';

let _sqliteCache;

/** True when the app database is SQLite (not PostgreSQL or MySQL). */
export async function isSqliteDatabase() {
  if (getDbKind() === 'sqlite') return true;
  if (getDbKind() === 'mysql') return false;
  if (_sqliteCache !== undefined) return _sqliteCache;
  try {
    const { rows } = await pool.query('SELECT sqlite_version() AS v');
    _sqliteCache = Boolean(rows?.[0]?.v);
  } catch {
    _sqliteCache = false;
  }
  return _sqliteCache;
}

export async function isMysqlDatabase() {
  return getDbKind() === 'mysql';
}

/**
 * Scalar subquery that returns a JSON array of gallery URLs for property row `p`.
 */
export async function sqlPropertyGalleryUrlsSubquery() {
  if (await isSqliteDatabase()) {
    return `(
      SELECT COALESCE(
        (SELECT json_group_array(file_url) FROM (
          SELECT pi.file_url
          FROM property_images pi
          WHERE pi.property_id = p.id
          ORDER BY pi.sort_order ASC, pi.created_at ASC
        )),
        '[]'
      )
    )`;
  }
  if (await isMysqlDatabase()) {
    return `(
      SELECT COALESCE(
        JSON_ARRAYAGG(pi.file_url ORDER BY pi.sort_order ASC, pi.created_at ASC),
        JSON_ARRAY()
      )
      FROM property_images pi
      WHERE pi.property_id = p.id
    )`;
  }
  return `(
    SELECT COALESCE(json_agg(pi.file_url ORDER BY pi.sort_order ASC, pi.created_at ASC), '[]'::json)
    FROM property_images pi
    WHERE pi.property_id = p.id
  )`;
}
