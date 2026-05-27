import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { adaptOrderByForMysql, convertPlaceholders, normalizeParams, isMysqlUrl } from './sql-utils.js';

dotenv.config();

function resolveConfig() {
  const url = (process.env.DATABASE_URL || '').trim();
  if (isMysqlUrl(url)) {
    return url;
  }
  const host = process.env.MYSQL_HOST || 'localhost';
  const user = process.env.MYSQL_USER || 'root';
  const password = process.env.MYSQL_PASSWORD || '';
  const database = process.env.MYSQL_DATABASE || 'botch_db';
  const port = Number(process.env.MYSQL_PORT || 3306);
  return { host, user, password, database, port, waitForConnections: true, connectionLimit: 10 };
}

const pool = isMysqlUrl((process.env.DATABASE_URL || '').trim())
  ? mysql.createPool(resolveConfig())
  : mysql.createPool(resolveConfig());

export async function pingMysql() {
  const [rows] = await pool.query('SELECT VERSION() AS v');
  return rows?.[0]?.v;
}

const adapter = {
  async query(sql, params = []) {
    const { sql: convertedSql, params: convertedParams } = convertPlaceholders(
      adaptOrderByForMysql(sql),
      params
    );
    const bound = normalizeParams(convertedParams);
    try {
      const [result, fields] = await pool.query(convertedSql, bound);
      if (Array.isArray(result)) {
        return { rows: result, rowCount: result.length };
      }
      const header = result && typeof result === 'object' ? result : {};
      const affected = header.affectedRows ?? 0;
      const insertId = header.insertId;
      let rows = [];
      if (/\bRETURNING\b/i.test(convertedSql) && Array.isArray(fields)) {
        rows = Array.isArray(result) ? result : [];
      }
      return {
        rows,
        rowCount: affected,
        insertId,
      };
    } catch (err) {
      err.code = err.code || err.errno;
      console.error('[mysql] Query error:', err.message, { sql: convertedSql.slice(0, 200) });
      throw err;
    }
  },

  async getConnection() {
    return pool.getConnection();
  },
};

export default adapter;
