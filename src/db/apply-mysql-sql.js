import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { isMysqlUrl } from './sql-utils.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveUrl() {
  const url = (process.env.DATABASE_URL || '').trim();
  if (!isMysqlUrl(url)) {
    throw new Error('DATABASE_URL must be mysql:// or mariadb:// to apply MySQL SQL files');
  }
  return url;
}

export async function applySqlFile(relativePath) {
  const fullPath = path.join(__dirname, relativePath);
  const sql = fs.readFileSync(fullPath, 'utf8');
  const conn = await mysql.createConnection({
    uri: resolveUrl(),
    multipleStatements: true,
  });
  try {
    await conn.query(sql);
    console.log(`Applied SQL from ${relativePath}`);
  } finally {
    await conn.end();
  }
}

const __file = fileURLToPath(import.meta.url);
const isRunDirect = process.argv[1] && path.resolve(process.argv[1]) === __file;
if (isRunDirect && process.argv[2]) {
  applySqlFile(process.argv[2]).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
