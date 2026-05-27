/**
 * Builds schema.mysql.phpmyadmin.sql from schema.mysql.sql for Hostinger phpMyAdmin SQL tab.
 * Run: node scripts/generate-schema-mysql-phpmyadmin.mjs
 * (Run generate-schema-mysql.mjs first if schema.mysql.sql is stale.)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(__dirname, '../src/db/schema.mysql.sql');
const out = path.join(__dirname, '../src/db/schema.mysql.phpmyadmin.sql');

function splitSqlStatements(sql) {
  const lines = sql.split('\n');
  const statements = [];
  let buf = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!buf.length && (trimmed.startsWith('--') || trimmed === '')) {
      continue;
    }
    buf.push(line);
    if (trimmed.endsWith(';')) {
      const stmt = buf.join('\n').trim();
      if (stmt) statements.push(stmt);
      buf = [];
    }
  }
  if (buf.length) {
    const stmt = buf.join('\n').trim();
    if (stmt) statements.push(stmt);
  }
  return statements;
}

/** phpMyAdmin sometimes runs only the first clause of a multi-action ALTER. */
function splitAlterTableStatements(stmt) {
  const m = stmt.match(
    /^ALTER TABLE (\w+)\s+ADD COLUMN (\w+) (CHAR\(36\)) NULL,\s+ADD CONSTRAINT (\w+) FOREIGN KEY \((\w+)\) REFERENCES (\w+)\((\w+)\) ON DELETE (SET NULL|CASCADE|RESTRICT);$/s
  );
  if (!m) return [stmt];

  const [, table, col, type, constraint, fkCol, refTable, refCol, onDelete] = m;
  return [
    `ALTER TABLE ${table} ADD COLUMN ${col} ${type} NULL;`,
    `ALTER TABLE ${table} ADD CONSTRAINT ${constraint} FOREIGN KEY (${fkCol}) REFERENCES ${refTable}(${refCol}) ON DELETE ${onDelete};`,
  ];
}

/** MariaDB: DEFAULT must precede CHECK (including after statements are collapsed to one line). */
function fixMariaDbCheckDefaultOrder(stmt) {
  return stmt
    .replace(
      /((?:`\w+`|\w+) VARCHAR\(\d+\)) CHECK \(((?:`\w+`|\w+) IN \([^)]*\))\)\s+DEFAULT ('[^']*')/g,
      '$1 DEFAULT $4 CHECK ($2)'
    )
    .replace(
      /((?:`\w+`|\w+) VARCHAR\(\d+\)) CHECK \(((?:`\w+`|\w+) IN \([^)]*\))\)\s+NOT NULL/g,
      '$1 NOT NULL CHECK ($2)'
    )
    .replace(
      /((?:`\w+`|\w+) VARCHAR\(\d+\)) CHECK \(([^()]+)\)\s+DEFAULT ('[^']*')/g,
      '$1 DEFAULT $4 CHECK ($2)'
    )
    .replace(
      /((?:`\w+`|\w+) VARCHAR\(\d+\)) CHECK \(([^()]+)\)\s+NOT NULL/g,
      '$1 NOT NULL CHECK ($2)'
    );
}

function toPhpMyAdminSql(stmt) {
  return fixMariaDbCheckDefaultOrder(
    stmt
      .replace(/DEFAULT \(UUID\(\)\),/g, ',')
      .replace(/DEFAULT \(UUID\(\)\)/g, '')
      .replace(/\n\s+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function buildPhpMyAdminFile(rawSql) {
  const body = rawSql
    .replace(/^-- Generated[\s\S]*?SET FOREIGN_KEY_CHECKS = 0;\s*/m, '')
    .replace(/\s*SET FOREIGN_KEY_CHECKS = 1;\s*$/m, '')
    .trim();

  const statements = splitSqlStatements(body).flatMap((stmt) => {
    const normalized = toPhpMyAdminSql(stmt);
    return splitAlterTableStatements(normalized);
  });

  const header = `-- Botch — Hostinger phpMyAdmin schema
-- How to run:
--   1. In hPanel → Databases → phpMyAdmin, click your database name on the left.
--   2. Open the SQL tab.
--   3. Import this file, OR paste and click Go.
--   4. If import fails, run one numbered block at a time until you find the error.
--   5. Then run seed: src/db/seed.mysql.sql (same SQL tab or Import).
--
-- Generated from schema.mysql.sql by scripts/generate-schema-mysql-phpmyadmin.mjs

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

`;

  const blocks = statements.map((stmt, i) => {
    const oneLine = stmt.replace(/\s+/g, ' ').trim();
    const label = oneLine.slice(0, 72);
    return `-- [${i + 1}/${statements.length}] ${label}${label.length < oneLine.length ? '…' : ''}\n${stmt}`;
  });

  const footer = `\nSET FOREIGN_KEY_CHECKS = 1;\n`;

  return header + blocks.join('\n\n') + footer;
}

if (!fs.existsSync(src)) {
  console.error('Missing', src, '— run: node scripts/generate-schema-mysql.mjs');
  process.exit(1);
}

const raw = fs.readFileSync(src, 'utf8');
const output = buildPhpMyAdminFile(raw);
fs.writeFileSync(out, output);
console.log('Wrote', out, `(${output.split('\n').length} lines, ${splitSqlStatements(output).length} statements)`);
