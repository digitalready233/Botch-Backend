/**
 * Unit tests for auth middleware helpers (requireAdmin, sessionActivityMiddleware, etc.).
 * Run: node --test tests/unit/auth-helpers.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
// Import auth-session only so tests do not load better-sqlite3 via db/index.js (native build must match Node version).
import { requireAdmin, requireClient, sessionActivityMiddleware } from '../../src/middleware/auth-session.js';

function res() {
  const out = { statusCode: 200, body: null };
  return {
    status(code) {
      out.statusCode = code;
      return this;
    },
    json(obj) {
      out.body = obj;
      return this;
    },
    get statusCode() {
      return out.statusCode;
    },
    get body() {
      return out.body;
    },
  };
}

describe('requireAdmin', () => {
  it('calls next when req.userRole is admin', () => {
    const r = { userRole: 'admin' };
    const resOut = res();
    let nextCalled = false;
    requireAdmin(r, resOut, () => {
      nextCalled = true;
    });
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(resOut.statusCode, 200);
  });

  it('returns 403 when req.userRole is client', () => {
    const r = { userRole: 'client' };
    const resOut = res();
    requireAdmin(r, resOut, () => {});
    assert.strictEqual(resOut.statusCode, 403);
    assert.strictEqual(resOut.body?.error, 'Admin access required');
  });

  it('returns 403 when req.userRole is vendor', () => {
    const r = { userRole: 'vendor' };
    const resOut = res();
    requireAdmin(r, resOut, () => {});
    assert.strictEqual(resOut.statusCode, 403);
  });
});

describe('requireClient', () => {
  it('calls next when req.userRole is client', () => {
    const r = { userRole: 'client' };
    const resOut = res();
    let nextCalled = false;
    requireClient(r, resOut, () => {
      nextCalled = true;
    });
    assert.strictEqual(nextCalled, true);
  });

  it('calls next when req.userRole is admin', () => {
    const r = { userRole: 'admin' };
    const resOut = res();
    let nextCalled = false;
    requireClient(r, resOut, () => {
      nextCalled = true;
    });
    assert.strictEqual(nextCalled, true);
  });

  it('returns 403 when req.userRole is vendor', () => {
    const r = { userRole: 'vendor' };
    const resOut = res();
    requireClient(r, resOut, () => {});
    assert.strictEqual(resOut.statusCode, 403);
    assert.strictEqual(resOut.body?.error, 'Client access required');
  });

  it('returns 403 when req.userRole is buyer', () => {
    const r = { userRole: 'buyer' };
    const resOut = res();
    requireClient(r, resOut, () => {});
    assert.strictEqual(resOut.statusCode, 403);
    assert.strictEqual(resOut.body?.error, 'Client access required');
  });
});

describe('sessionActivityMiddleware', () => {
  it('calls next and does not throw when req.userId is set', () => {
    const r = { userId: 'user-1' };
    const resOut = res();
    let nextCalled = false;
    sessionActivityMiddleware(r, resOut, () => {
      nextCalled = true;
    });
    assert.strictEqual(nextCalled, true);
  });

  it('calls next when req.userId is missing', () => {
    const r = {};
    let nextCalled = false;
    sessionActivityMiddleware(r, {}, () => {
      nextCalled = true;
    });
    assert.strictEqual(nextCalled, true);
  });
});
