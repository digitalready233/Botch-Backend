/**
 * Shared SQL helpers for SQLite and MySQL adapters (PostgreSQL-style $1 placeholders).
 */

export function convertPlaceholders(sql, params = []) {
  if (!sql || typeof sql !== 'string' || !/\$\d/.test(sql)) {
    return { sql, params };
  }
  const convertedParams = [];
  const convertedSql = sql.replace(/\$(\d+)(?!\$)/g, (_, rawIndex) => {
    const idx = Number(rawIndex) - 1;
    if (idx < 0 || idx >= params.length) {
      throw new Error(`SQL placeholder $${rawIndex} is out of range for ${params.length} bound parameters`);
    }
    convertedParams.push(params[idx]);
    return '?';
  });
  return { sql: convertedSql, params: convertedParams };
}

export function normalizeParams(params = []) {
  return params.map((p) => {
    if (p === true) return 1;
    if (p === false) return 0;
    return p;
  });
}

export function isMysqlUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim().toLowerCase();
  return u.startsWith('mysql://') || u.startsWith('mariadb://');
}

/**
 * Rewrite PostgreSQL `ORDER BY col DESC NULLS LAST` for MySQL/MariaDB (unsupported syntax).
 * Uses `(col IS NULL), col DESC` so non-null rows sort first, then nulls — same intent as NULLS LAST.
 */
export function adaptOrderByForMysql(sql) {
  if (!sql || typeof sql !== 'string') return sql;
  return sql.replace(
    /([\w.]+)\s+(DESC|ASC)\s+NULLS\s+LAST/gi,
    (_, col, dir) => `${col} IS NULL, ${col} ${dir.toUpperCase()}`
  );
}
