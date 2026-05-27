/**
 * Converts src/db/schema.sql (PostgreSQL) → src/db/schema.mysql.sql
 * Run: node scripts/generate-schema-mysql.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(__dirname, '../src/db/schema.sql');
const out = path.join(__dirname, '../src/db/schema.mysql.sql');

/** Column names reserved in MySQL/MariaDB — backtick in DDL and CHECK clauses. */
const MYSQL_RESERVED_COLUMNS = ['interval', 'role'];

function columnNameFromDef(line) {
  const m = line.trim().match(/^(?:`(\w+)`|(\w+))\s/);
  return m ? (m[1] || m[2]) : null;
}

function fixCheckConstraintOrder(sql) {
  /** MariaDB: DEFAULT must precede CHECK. Multiline IN only when IN (...) spans a line break. */
  let out = sql.replace(
    /(\n  (?:`\w+`|\w+) VARCHAR\(\d+\)) CHECK \(((?:`\w+`|\w+) IN \([^)]*\n[^)]*\))\)\s+DEFAULT ('[^']*')(,?)/g,
    (_, col, checkExpr, def, comma) => `${col} DEFAULT ${def} CHECK (${checkExpr})${comma}`
  );

  const fixLine = (line) => {
    /** Use [^)]* for CHECK body — greedy .+ would treat 'pending' inside IN (...) as DEFAULT. */
    let m = line.match(
      /^(\s+(?:`\w+`|\w+)\s+.+?) CHECK \(((?:`\w+`|\w+) IN \([^)]*\))\) DEFAULT (.+)$/
    );
    if (m) {
      let defaultPart = m[3];
      const hadComma = /,\s*$/.test(defaultPart);
      if (hadComma) defaultPart = defaultPart.replace(/,\s*$/, '');
      return `${m[1]} DEFAULT ${defaultPart} CHECK (${m[2]})${hadComma ? ',' : ''}`;
    }
    m = line.match(/^(\s+(?:`\w+`|\w+)\s+.+?) CHECK \(([^)]+)\) DEFAULT (.+)$/);
    if (m) {
      let defaultPart = m[3];
      const hadComma = /,\s*$/.test(defaultPart);
      if (hadComma) defaultPart = defaultPart.replace(/,\s*$/, '');
      return `${m[1]} DEFAULT ${defaultPart} CHECK (${m[2]})${hadComma ? ',' : ''}`;
    }
    m = line.match(
      /^(\s+(?:`\w+`|\w+)\s+.+?) CHECK \(((?:`\w+`|\w+) IN \([^)]*\))\) NOT NULL(,?\s*)$/
    );
    if (m) return `${m[1]} NOT NULL CHECK (${m[2]})${m[3]}`;
    m = line.match(/^(\s+(?:`\w+`|\w+)\s+.+?) CHECK \(([^)]+)\) NOT NULL(,?\s*)$/);
    if (m) return `${m[1]} NOT NULL CHECK (${m[2]})${m[3]}`;
    return line;
  };

  out = out
    .split('\n')
    .map(fixLine)
    .join('\n')
    .replace(
      /^ALTER TABLE (\w+) ADD COLUMN (\w+) (VARCHAR\(\d+\)) CHECK \((.+?)\) DEFAULT ('[^']*');$/gm,
      "ALTER TABLE $1 ADD COLUMN $2 $3 DEFAULT $5 CHECK ($4);"
    );

  return out;
}

function fixAlterAddColumnForeignKeys(sql) {
  return sql.replace(
    /^ALTER TABLE (\w+) ADD COLUMN (\w+) (CHAR\(36\)) REFERENCES (\w+)\((\w+)\) ON DELETE (SET NULL|CASCADE|RESTRICT);$/gm,
    (_, table, col, type, refTable, refCol, onDelete) => {
      const fk = `fk_${table}_${col}`.slice(0, 64);
      return `ALTER TABLE ${table}\n  ADD COLUMN ${col} ${type} NULL,\n  ADD CONSTRAINT ${fk} FOREIGN KEY (${col}) REFERENCES ${refTable}(${refCol}) ON DELETE ${onDelete};`;
    }
  );
}

function quoteMysqlReservedColumns(sql) {
  for (const col of MYSQL_RESERVED_COLUMNS) {
    sql = sql.replace(new RegExp(`(^|\\n)(  )(${col})( VARCHAR| INT| TEXT)`, 'gm'), '$1$2`$3`$4');
    sql = sql.replace(new RegExp(`CHECK \\(${col} IN`, 'g'), `CHECK (\`${col}\` IN`);
    sql = sql.replace(new RegExp(`CHECK \\(${col} >=`, 'g'), `CHECK (\`${col}\` >=`);
    sql = sql.replace(new RegExp(`UNIQUE\\(${col},`, 'g'), `UNIQUE(\`${col}\`,`);
    sql = sql.replace(new RegExp(`, ${col}\\)`, 'g'), `, \`${col}\`)`);
    sql = sql.replace(new RegExp(`\\(${col},`, 'g'), `(\`${col}\`,`);
    sql = sql.replace(new RegExp(`, ${col}\\)`, 'g'), `, \`${col}\`)`);
    sql = sql.replace(new RegExp(`ADD COLUMN ${col} `, 'g'), `ADD COLUMN \`${col}\` `);
    sql = sql.replace(new RegExp(`ON (\\w+)\\(${col}\\)`, 'g'), `ON $1(\`${col}\`)`);
  }
  return sql;
}

function mergeImmediateAlterColumns(sql) {
  const lines = sql.split('\n');
  const merged = [];
  let i = 0;

  while (i < lines.length) {
    const createMatch = lines[i].match(/^CREATE TABLE IF NOT EXISTS (\w+) \(/);
    if (!createMatch) {
      merged.push(lines[i]);
      i += 1;
      continue;
    }

    const table = createMatch[1];
    const block = [lines[i]];
    i += 1;
    while (i < lines.length && !/^\);$/.test(lines[i])) {
      block.push(lines[i]);
      i += 1;
    }
    if (i < lines.length) {
      block.push(lines[i]);
      i += 1;
    }

    const extraCols = [];
    while (i < lines.length) {
      const alterMatch = lines[i].match(
        new RegExp(`^ALTER TABLE ${table} ADD COLUMN (.+);$`)
      );
      if (!alterMatch) break;
      extraCols.push(`  ${alterMatch[1]}`);
      i += 1;
    }

    if (extraCols.length > 0) {
      const existingCols = new Set();
      for (let b = 1; b < block.length; b++) {
        const name = columnNameFromDef(block[b]);
        if (name) existingCols.add(name);
      }
      const toAdd = extraCols.filter((col) => {
        const name = columnNameFromDef(col);
        return !name || !existingCols.has(name);
      });
      if (toAdd.length > 0) {
        const closeParen = block.pop();
        const lastColLine = block[block.length - 1];
        if (!lastColLine.trimEnd().endsWith(',')) {
          block[block.length - 1] = `${lastColLine.trimEnd()},`;
        }
        for (let j = 0; j < toAdd.length; j++) {
          const comma = j < toAdd.length - 1 ? ',' : '';
          block.push(`${toAdd[j]}${comma}`);
        }
        block.push(closeParen);
      }
    }

    merged.push(...block);
  }

  return merged.join('\n');
}

/**
 * PostgreSQL partial UNIQUE (vendor_org_id WHERE is_primary_contact) is not portable on
 * Hostinger MariaDB 10.6+ (#1901: IF/CASE forbidden in GENERATED columns). Enforced in
 * vendor-organizations.js when setting is_primary_contact.
 */
function fixMariaDbVendorMembershipsPrimaryContact(sql) {
  sql = sql.replace(/^\s*primary_contact_org_key CHAR\(36\)[^\n]*,?\n/gm, '');
  sql = sql.replace(
    /CREATE UNIQUE INDEX (?:IF NOT EXISTS )?idx_vendor_memberships_primary_contact[^\n]*\n/g,
    ''
  );
  sql = sql.replace(
    /CREATE UNIQUE INDEX idx_vendor_memberships_primary_contact\s+ON vendor_memberships \(\(CASE WHEN[^\n]*\n/g,
    ''
  );
  if (!sql.includes('idx_vendor_memberships_primary')) {
    sql = sql.replace(
      /CREATE INDEX IF NOT EXISTS idx_vendor_memberships_user ON vendor_memberships\(user_id\);/,
      `CREATE INDEX IF NOT EXISTS idx_vendor_memberships_user ON vendor_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_vendor_memberships_primary ON vendor_memberships(vendor_org_id, is_primary_contact);`
    );
  }
  return sql;
}

let sql = fs.readFileSync(src, 'utf8');

sql = sql.replace(/^--.*PostgreSQL.*\n/m, '-- Botch — MySQL / MariaDB schema (generated from schema.sql)\n');
sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS[^;]+;/g, '');
sql = sql.replace(/\bUUID\b/g, 'CHAR(36)');
sql = sql.replace(/gen_random_uuid\(\)/g, '(UUID())');
sql = sql.replace(/\bTIMESTAMPTZ\b/g, 'DATETIME(3)');
sql = sql.replace(/\bBOOLEAN\b/g, 'TINYINT(1)');
sql = sql.replace(/\bDEFAULT FALSE\b/g, 'DEFAULT 0');
sql = sql.replace(/\bDEFAULT TRUE\b/g, 'DEFAULT 1');
sql = sql.replace(/\bJSONB\b/g, 'JSON');
sql = sql.replace(/DEFAULT\s+'\[\]'::jsonb/gi, "DEFAULT ('[]')");
sql = sql.replace(/,\s*'([^']*)'::json\b/g, ", '$1'");
sql = sql.replace(/\bNOW\(\)/g, 'CURRENT_TIMESTAMP(3)');
/** PostgreSQL partial unique index → MariaDB generated column + unique index (Hostinger). */
sql = sql.replace(
  /CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_memberships_primary_contact\s+ON vendor_memberships\(vendor_org_id\) WHERE is_primary_contact = TRUE;\s*/gi,
  ''
);
sql = sql.replace(
  /CREATE UNIQUE INDEX IF NOT EXISTS idx_house_plan_paid_unique ON house_plan_purchases\(house_plan_id, user_id, status\);/,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_house_plan_paid_unique ON house_plan_purchases (house_plan_id, user_id, status);'
);

/** MySQL does not support ADD COLUMN IF NOT EXISTS (MariaDB-only); indexes keep IF NOT EXISTS for safe re-runs. */
sql = sql.replace(/ADD COLUMN IF NOT EXISTS/gi, 'ADD COLUMN');

sql = mergeImmediateAlterColumns(sql);
sql = fixCheckConstraintOrder(sql);
sql = fixAlterAddColumnForeignKeys(sql);
sql = fixMariaDbVendorMembershipsPrimaryContact(sql);
sql = quoteMysqlReservedColumns(sql);

const header = `-- Generated by scripts/generate-schema-mysql.mjs — do not edit schema.sql only; re-run generator.
-- Compatible with MySQL 8+ and MariaDB 10.3+ (Hostinger). CHECK constraints use DEFAULT before CHECK (MariaDB requirement).
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

`;

const footer = `
SET FOREIGN_KEY_CHECKS = 1;
`;

fs.writeFileSync(out, header + sql.trim() + '\n' + footer);
console.log('Wrote', out);
