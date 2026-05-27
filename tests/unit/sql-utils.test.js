import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { adaptOrderByForMysql } from '../../src/db/sql-utils.js';

describe('adaptOrderByForMysql', () => {
  it('rewrites DESC NULLS LAST for MySQL', () => {
    const sql =
      'ORDER BY current_period_end DESC NULLS LAST, created_at DESC';
    const out = adaptOrderByForMysql(sql);
    assert.match(out, /current_period_end IS NULL, current_period_end DESC/);
    assert.doesNotMatch(out, /NULLS LAST/i);
  });

  it('rewrites qualified column names', () => {
    const sql = 'ORDER BY vl.price DESC NULLS LAST, vl.approved_at DESC';
    const out = adaptOrderByForMysql(sql);
    assert.match(out, /vl\.price IS NULL, vl\.price DESC/);
  });
});
