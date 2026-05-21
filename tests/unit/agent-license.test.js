/**
 * Unit tests for agent-license.js (exports and behavior with mock pool).
 * Run: node --test tests/unit/agent-license.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AGENT_VERIFICATION_ERROR, isVendorLicenseVerified } from '../../src/lib/agent-license.js';

describe('agent-license', () => {
  describe('AGENT_VERIFICATION_ERROR', () => {
    it('has error message and code', () => {
      assert.strictEqual(typeof AGENT_VERIFICATION_ERROR.error, 'string');
      assert.strictEqual(AGENT_VERIFICATION_ERROR.code, 'AGENT_VERIFICATION_REQUIRED');
      assert.match(AGENT_VERIFICATION_ERROR.error, /verification/);
    });
  });

  describe('isVendorLicenseVerified', () => {
    it('returns false when pool returns no rows', async () => {
      const pool = {
        query: async () => ({ rows: [] }),
      };
      const result = await isVendorLicenseVerified(pool, 'user-123');
      assert.strictEqual(result, false);
    });

    it('returns false when status is not verified', async () => {
      const pool = {
        query: async () => ({ rows: [{ status: 'pending' }] }),
      };
      const result = await isVendorLicenseVerified(pool, 'user-123');
      assert.strictEqual(result, false);
    });

    it('returns true when status is verified', async () => {
      const pool = {
        query: async () => ({ rows: [{ status: 'verified' }] }),
      };
      const result = await isVendorLicenseVerified(pool, 'user-123');
      assert.strictEqual(result, true);
    });
  });
});
