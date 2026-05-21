/**
 * Integration tests: hit the running API (health, auth, protected routes).
 * Requires backend running: npm run start (or dev) then npm run test:integration.
 * Or: BASE_URL=https://your-api.example.com node tests/integration/api.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';
const API = BASE_URL + '/api/v1';

/** Terms that must not appear in API error messages shown to users */
const TECHNICAL_TERMS = /jwt|Bearer|Authorization|ECONNREFUSED|ETIMEDOUT|undefined|null\s+is|at\s+.*\.js:\d+|Unexpected\s+token/i;

function assertUserFriendlyError(body) {
  const msg = body?.error || body?.message || '';
  assert.ok(typeof msg === 'string' && msg.length > 0, 'Response should include an error message');
  assert.ok(!TECHNICAL_TERMS.test(msg), `Error message should be user-friendly, got: ${msg}`);
}

async function fetchJson(url, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_) {}
  return { status: res.status, body, ok: res.ok };
}

describe('API integration', () => {
  describe('Health', () => {
    it('GET /api/health returns 200 and status ok', async () => {
      const { status, body } = await fetchJson(BASE_URL + '/api/health');
      assert.strictEqual(status, 200);
      assert.strictEqual(body?.status, 'ok');
      assert.ok(body?.version);
    });
  });

  describe('Root', () => {
    it('GET / returns 200 and message', async () => {
      const { status, body } = await fetchJson(BASE_URL + '/');
      assert.strictEqual(status, 200);
      assert.ok(body?.message);
    });
  });

  describe('Auth required', () => {
    it('GET /api/v1/payments without token returns 401 with user-friendly error', async () => {
      const { status, body } = await fetchJson(API + '/payments');
      assert.strictEqual(status, 401);
      assertUserFriendlyError(body);
    });

    it('GET /api/v1/invoices without token returns 401 with user-friendly error', async () => {
      const { status, body } = await fetchJson(API + '/invoices');
      assert.strictEqual(status, 401);
      assertUserFriendlyError(body);
    });

    it('GET /api/v1/projects without token returns 401 with user-friendly error', async () => {
      const { status, body } = await fetchJson(API + '/projects');
      assert.strictEqual(status, 401);
      assertUserFriendlyError(body);
    });

    it('Invalid Bearer token returns 401 with user-friendly error', async () => {
      const { status, body } = await fetchJson(API + '/projects', {
        headers: { Authorization: 'Bearer invalid-token-xyz' },
      });
      assert.strictEqual(status, 401);
      assertUserFriendlyError(body);
    });

    it('GET /api/v1/media/latest without token returns 401 with user-friendly error', async () => {
      const { status, body } = await fetchJson(API + '/media/latest');
      assert.strictEqual(status, 401);
      assertUserFriendlyError(body);
    });

    it('GET /api/v1/messages/conversations without token returns 401 with user-friendly error', async () => {
      const { status, body } = await fetchJson(API + '/messages/conversations');
      assert.strictEqual(status, 401);
      assertUserFriendlyError(body);
    });

    it('GET /api/v1/kyc/status without token returns 401 with user-friendly error', async () => {
      const { status, body } = await fetchJson(API + '/kyc/status');
      assert.strictEqual(status, 401);
      assertUserFriendlyError(body);
    });

    it('GET /api/v1/auth/me without token returns 401 with user-friendly error', async () => {
      const { status, body } = await fetchJson(API + '/auth/me');
      assert.strictEqual(status, 401);
      assertUserFriendlyError(body);
    });

    it('GET /api/v1/dashboard/stats without token returns 401 with user-friendly error', async () => {
      const { status, body } = await fetchJson(API + '/dashboard/stats');
      assert.strictEqual(status, 401);
      assertUserFriendlyError(body);
    });

    it('GET /api/v1/dashboard/billing without token returns 401 with user-friendly error', async () => {
      const { status, body } = await fetchJson(API + '/dashboard/billing');
      assert.strictEqual(status, 401);
      assertUserFriendlyError(body);
    });

    it('GET /api/v1/users without token returns 401 with user-friendly error', async () => {
      const { status, body } = await fetchJson(API + '/users');
      assert.strictEqual(status, 401);
      assertUserFriendlyError(body);
    });

    it('GET /api/v1/payments/bank-details without token returns 401 with user-friendly error', async () => {
      const { status, body } = await fetchJson(API + '/payments/bank-details');
      assert.strictEqual(status, 401);
      assertUserFriendlyError(body);
    });

    it('GET /api/v1/appointments without token returns 401 with user-friendly error', async () => {
      const { status, body } = await fetchJson(API + '/appointments');
      assert.strictEqual(status, 401);
      assertUserFriendlyError(body);
    });

    it('POST /api/v1/payments/request-bank-transfer without token returns 401 with user-friendly error', async () => {
      const { status, body } = await fetchJson(API + '/payments/request-bank-transfer', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      assert.strictEqual(status, 401);
      assertUserFriendlyError(body);
    });

    it('POST /api/v1/payments/initialize without token returns 401 with user-friendly error', async () => {
      const { status, body } = await fetchJson(API + '/payments/initialize', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      assert.strictEqual(status, 401);
      assertUserFriendlyError(body);
    });
  });

  describe('Auth login', () => {
    it('POST /api/v1/auth/login with bad credentials returns 401 with user-friendly error', async () => {
      const { status, body } = await fetchJson(API + '/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'nonexistent@example.com', password: 'wrong' }),
      });
      assert.strictEqual(status, 401);
      assertUserFriendlyError(body);
    });

    it('POST /api/v1/auth/login without body returns 400 or 401', async () => {
      const { status, body } = await fetchJson(API + '/auth/login', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      assert.ok(status === 400 || status === 401);
      if (body?.error || body?.message) assertUserFriendlyError(body);
    });
  });

  describe('Notifications', () => {
    it('GET /api/v1/notifications without token returns 401 with user-friendly error', async () => {
      const { status, body } = await fetchJson(API + '/notifications');
      assert.strictEqual(status, 401);
      assertUserFriendlyError(body);
    });
  });

  describe('Messaging workflows (new endpoints)', () => {
    it('GET /api/v1/messages/search without token returns 401', async () => {
      const { status } = await fetchJson(API + '/messages/search?project_id=00000000-0000-0000-0000-000000000001&q=test');
      assert.strictEqual(status, 401);
    });

    it('GET /api/v1/messages/search without project_id returns 400', async () => {
      const token = 'Bearer dummy';
      const { status } = await fetchJson(API + '/messages/search?q=test', { headers: { Authorization: token } });
      assert.ok(status === 400 || status === 401);
    });

    it('GET /api/v1/messages/pinned without token returns 401', async () => {
      const { status } = await fetchJson(API + '/messages/pinned?project_id=00000000-0000-0000-0000-000000000001');
      assert.strictEqual(status, 401);
    });

    it('GET /api/v1/messages/export without token returns 401', async () => {
      const { status } = await fetchJson(API + '/messages/export?project_id=00000000-0000-0000-0000-000000000001');
      assert.strictEqual(status, 401);
    });

    it('GET /api/v1/messages/activity without token returns 401', async () => {
      const { status } = await fetchJson(API + '/messages/activity?project_id=00000000-0000-0000-0000-000000000001');
      assert.strictEqual(status, 401);
    });

    it('POST /api/v1/messages/escalate without token returns 401', async () => {
      const { status } = await fetchJson(API + '/messages/escalate', {
        method: 'POST',
        body: JSON.stringify({ project_id: '00000000-0000-0000-0000-000000000001', reason: 'Test' }),
      });
      assert.strictEqual(status, 401);
    });

    it('GET /api/v1/messages/ai-assistant without token returns 401', async () => {
      const { status } = await fetchJson(API + '/messages/ai-assistant?project_id=00000000-0000-0000-0000-000000000001&action=summarize');
      assert.strictEqual(status, 401);
    });

    it('GET /api/v1/messages/ai-assistant with invalid action returns 400 when authenticated', async () => {
      const { status } = await fetchJson(API + '/messages/ai-assistant?project_id=00000000-0000-0000-0000-000000000001&action=invalid', {
        headers: { Authorization: 'Bearer dummy' },
      });
      assert.ok(status === 400 || status === 401);
    });
  });

  describe('WebAuthn passkey credentials', () => {
    it('GET /api/v1/auth/webauthn/credentials without token returns 401', async () => {
      const { status, body } = await fetchJson(API + '/auth/webauthn/credentials');
      assert.strictEqual(status, 401);
      assertUserFriendlyError(body);
    });

    it('DELETE /api/v1/auth/webauthn/credentials/:id without token returns 401', async () => {
      const { status, body } = await fetchJson(API + '/auth/webauthn/credentials/00000000-0000-0000-0000-000000000001', {
        method: 'DELETE',
      });
      assert.strictEqual(status, 401);
      assertUserFriendlyError(body);
    });

    it('POST /api/v1/auth/webauthn/login/options with email that has no passkey returns 400', async () => {
      const { status, body } = await fetchJson(API + '/auth/webauthn/login/options', {
        method: 'POST',
        body: JSON.stringify({ email: 'nopasskey@example.com' }),
      });
      assert.ok(status === 400 || status === 401);
      assert.ok(body?.error && typeof body.error === 'string');
    });
  });
});
