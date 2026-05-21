import pool from '../db/index.js';

let _sqliteCache;

/** True when the app database is SQLite (not PostgreSQL). */
export async function isSqliteDatabase() {
  if (_sqliteCache !== undefined) return _sqliteCache;
  try {
    const { rows } = await pool.query('SELECT sqlite_version() AS v');
    _sqliteCache = Boolean(rows?.[0]?.v);
  } catch {
    _sqliteCache = false;
  }
  return _sqliteCache;
}

/**
 * Scalar subquery that returns a JSON array of gallery URLs for property row `p`.
 * PostgreSQL: json_agg + ::json. SQLite: json_group_array (text JSON).
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
  return `(
    SELECT COALESCE(json_agg(pi.file_url ORDER BY pi.sort_order ASC, pi.created_at ASC), '[]'::json)
    FROM property_images pi
    WHERE pi.property_id = p.id
  )`;
}
