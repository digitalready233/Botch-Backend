/**
 * Unit tests for feed-url.js (CCTV / stream URL validation).
 * Run: node --test tests/unit/feed-url.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateFeedUrl, isExternalTabOnlyFeedUrl } from '../../src/lib/feed-url.js';

describe('feed-url validateFeedUrl', () => {
  it('returns null for valid HTTPS URL', () => {
    assert.strictEqual(validateFeedUrl('https://example.com/stream.m3u8'), null);
    assert.strictEqual(validateFeedUrl('https://live.example.com/embed/123'), null);
  });

  it('returns error for RTSP URL', () => {
    const msg = validateFeedUrl('rtsp://camera.local/stream');
    assert.ok(msg && msg.includes('RTSP') && msg.includes('browser'));
  });

  it('returns error for HTTP URL', () => {
    const msg = validateFeedUrl('http://example.com/stream.m3u8');
    assert.ok(msg && msg.includes('HTTPS'));
  });

  it('returns error for invalid URL', () => {
    const msg = validateFeedUrl('not-a-url');
    assert.ok(msg && msg.includes('invalid'));
  });

  it('returns error for known non-embeddable host', () => {
    const msg = validateFeedUrl('https://www.skylinewebcams.com/en/webcam/espana/canarias/santa-cruz-de-tenerife/playa-los-cristianos.html');
    assert.ok(msg && msg.includes('blocks iframe embedding'));
  });

  it('returns null for empty or whitespace', () => {
    assert.strictEqual(validateFeedUrl(''), null);
    assert.strictEqual(validateFeedUrl('   '), null);
    assert.strictEqual(validateFeedUrl(null), null);
    assert.strictEqual(validateFeedUrl(undefined), null);
  });

  it('returns null for valid HTTPS with query string', () => {
    assert.strictEqual(validateFeedUrl('https://ivs.example.com/stream.m3u8?token=abc'), null);
  });
});

describe('feed-url isExternalTabOnlyFeedUrl', () => {
  it('is true for EarthCam hosts', () => {
    assert.strictEqual(
      isExternalTabOnlyFeedUrl('https://www.earthcam.com/usa/newyork/timessquare/?cam=tsrobo1'),
      true
    );
    assert.strictEqual(isExternalTabOnlyFeedUrl('https://earthcam.com/foo'), true);
  });

  it('is true for SkylineWebcams', () => {
    assert.strictEqual(
      isExternalTabOnlyFeedUrl('https://www.skylinewebcams.com/en/webcam/foo.html'),
      true
    );
  });

  it('is false for generic embed or HLS URLs', () => {
    assert.strictEqual(isExternalTabOnlyFeedUrl('https://example.com/live/embed'), false);
    assert.strictEqual(isExternalTabOnlyFeedUrl('https://streams.example.com/out.m3u8'), false);
  });
});
