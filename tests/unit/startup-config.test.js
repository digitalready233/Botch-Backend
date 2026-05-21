/**
 * Unit tests for startup-config.js
 * Run: node --test tests/unit/startup-config.test.js
 * In development mode, validateStartupConfig must not exit and must return { ok: true }.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { validateStartupConfig } from '../../src/lib/startup-config.js';

const origEnv = { ...process.env };

describe('startup-config', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'development';
  });
  afterEach(() => {
    Object.keys(process.env).forEach((k) => {
      if (!(k in origEnv)) delete process.env[k];
    });
    Object.assign(process.env, origEnv);
  });

  it('returns ok: true in development without exiting', () => {
    process.env.NODE_ENV = 'development';
    const result = validateStartupConfig();
    assert.strictEqual(result.ok, true);
  });

  it('returns ok: true in production when JWT_SECRET is set and not default', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'a-strong-random-secret-at-least-32-chars-long';
    const result = validateStartupConfig();
    assert.strictEqual(result.ok, true);
  });

  it('in production with UPLOADS_PATH set, returns ok', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'another-strong-secret-32-chars';
    process.env.UPLOADS_PATH = '/data/uploads';
    const result = validateStartupConfig();
    assert.strictEqual(result.ok, true);
  });
});
