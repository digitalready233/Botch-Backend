import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

describe('uploads-access requireUploadsProxySecret', async () => {
  const { requireUploadsProxySecret } = await import('../../src/middleware/uploads-access.js');

  beforeEach(() => {
    delete process.env.UPLOADS_PROXY_SECRET;
  });
  afterEach(() => {
    delete process.env.UPLOADS_PROXY_SECRET;
  });

  it('calls next when UPLOADS_PROXY_SECRET is unset', () => {
    let called = false;
    const req = { get: () => '' };
    const res = { status: () => ({ send: () => {} }), type: () => ({ send: () => {} }) };
    requireUploadsProxySecret(req, res, () => {
      called = true;
    });
    assert.strictEqual(called, true);
  });

  it('calls next when header matches secret', () => {
    process.env.UPLOADS_PROXY_SECRET = 'abc123';
    let called = false;
    const req = { get: (h) => (h === 'x-botch-uploads-proxy' ? 'abc123' : '') };
    const res = { status: () => assert.fail('should not 403'), type: () => assert.fail('should not 403') };
    requireUploadsProxySecret(req, res, () => {
      called = true;
    });
    assert.strictEqual(called, true);
  });

  it('sends 403 when secret is set and header wrong', () => {
    process.env.UPLOADS_PROXY_SECRET = 'secret';
    let statusCode;
    const req = { get: () => 'wrong' };
    const res = {
      status(c) {
        statusCode = c;
        return this;
      },
      type() {
        return this;
      },
      send() {},
    };
    requireUploadsProxySecret(req, res, () => assert.fail('should not next'));
    assert.strictEqual(statusCode, 403);
  });
});
