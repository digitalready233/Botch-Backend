/**
 * Unit tests for project-sanitize.js (client stream URL stripping).
 * Run: node --test tests/unit/project-sanitize.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { sanitizeProjectListForClient } from '../../src/lib/project-sanitize.js';

describe('project-sanitize sanitizeProjectListForClient', () => {
  it('strips stream URLs for client when client_can_view_live_stream is false', () => {
    const rows = [
      {
        id: 'p1',
        client_id: 'c1',
        live_stream_url: 'https://secret.com/stream',
        ivs_playback_url: 'https://ivs.com/master.m3u8',
        client_can_view_live_stream: false,
      },
    ];
    const out = sanitizeProjectListForClient(rows, 'client');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].can_view_live_stream, false);
    assert.strictEqual(out[0].live_stream_url, null);
    assert.strictEqual(out[0].ivs_playback_url, null);
  });

  it('keeps stream URLs for client when client_can_view_live_stream is true', () => {
    const rows = [
      {
        id: 'p1',
        client_id: 'c1',
        live_stream_url: 'https://ok.com/stream',
        ivs_playback_url: 'https://ivs.com/master.m3u8',
        client_can_view_live_stream: true,
      },
    ];
    const out = sanitizeProjectListForClient(rows, 'client');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].can_view_live_stream, true);
    assert.strictEqual(out[0].live_stream_url, 'https://ok.com/stream');
    assert.strictEqual(out[0].ivs_playback_url, 'https://ivs.com/master.m3u8');
  });

  it('returns rows unchanged for admin role', () => {
    const rows = [
      {
        id: 'p1',
        live_stream_url: 'https://secret.com/stream',
        client_can_view_live_stream: false,
      },
    ];
    const out = sanitizeProjectListForClient(rows, 'admin');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].live_stream_url, 'https://secret.com/stream');
    assert.strictEqual(out[0].client_can_view_live_stream, false);
  });

  it('returns rows unchanged for vendor role', () => {
    const rows = [{ id: 'p1', live_stream_url: 'https://x.com', client_can_view_live_stream: false }];
    const out = sanitizeProjectListForClient(rows, 'vendor');
    assert.strictEqual(out[0].live_stream_url, 'https://x.com');
  });

  it('handles multiple projects with mixed can_view', () => {
    const rows = [
      { id: 'p1', live_stream_url: 'https://a.com', ivs_playback_url: null, client_can_view_live_stream: true },
      { id: 'p2', live_stream_url: 'https://b.com', ivs_playback_url: 'https://b.m3u8', client_can_view_live_stream: false },
    ];
    const out = sanitizeProjectListForClient(rows, 'client');
    assert.strictEqual(out[0].live_stream_url, 'https://a.com');
    assert.strictEqual(out[0].ivs_playback_url, null);
    assert.strictEqual(out[1].live_stream_url, null);
    assert.strictEqual(out[1].ivs_playback_url, null);
  });
});
