/**
 * Validation for live CCTV / stream feed URLs.
 * Browsers cannot play RTSP; playback URLs must be HTTPS (HLS, embed pages, etc.).
 */

/**
 * Feeds that should not be shown in an iframe (blocked, hostile top-navigation, heavy third-party scripts).
 * Keep in sync with frontend `isExternalTabOnlyLiveStreamUrl` in live-stream.ts.
 * @param {string} url
 * @returns {boolean}
 */
export function isExternalTabOnlyFeedUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    if (host === 'skylinewebcams.com' || host === 'www.skylinewebcams.com') return true;
    if (host === 'earthcam.com' || host.endsWith('.earthcam.com')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Validate browser-safe feed URL: must be HTTPS, not RTSP.
 * @param {string} url - live_stream_url or ivs_playback_url
 * @returns {string|null} Error message or null if valid
 */
export function validateFeedUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const u = url.trim();
  if (!u) return null;
  if (u.toLowerCase().startsWith('rtsp://')) {
    return 'RTSP URLs cannot be played in the browser. Use a media server or gateway to convert RTSP to HLS or WebRTC, then enter the playback URL here.';
  }
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'https:') return 'Feed URL must use HTTPS for secure browser playback.';
    const blockedEmbedHosts = ['skylinewebcams.com', 'www.skylinewebcams.com'];
    if (blockedEmbedHosts.includes(parsed.hostname.toLowerCase())) {
      return 'This provider blocks iframe embedding (refused to connect). Use a direct HLS/WebRTC playback URL or another embeddable feed. You can still open this link in a new tab.';
    }
    return null;
  } catch {
    return 'Feed URL is invalid.';
  }
}
