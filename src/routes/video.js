/**
 * Video call token endpoint for Twilio Video (1-on-1 and group calls).
 * Requires TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET in env.
 * Important: Use an API Key (create in Twilio Console → Account → API keys), NOT the main Auth Token.
 * API Key SID starts with "SK"; Account SID starts with "AC". Video requires the API Key to be US1 region.
 */
import express from 'express';
import twilio from 'twilio';
import { body, validationResult } from 'express-validator';
import pool from '../db/index.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();
const AccessToken = twilio.jwt.AccessToken;
const VideoGrant = twilio.jwt.AccessToken.VideoGrant;

function sanitizeIdentity(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 255) || 'user';
}

/** Twilio room names: alphanumeric, hyphens, underscores only (max 128 chars). */
function sanitizeRoomName(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'room';
}

/**
 * POST /api/v1/video/token
 * Body: { roomName: string, identity?: string }
 * Returns: { token: string } — short-lived Twilio Video access token.
 * Room name should be project-scoped (e.g. "project-<projectId>") so only that conversation can join.
 */
router.post('/token', authMiddleware, [
  body('roomName').isString().trim().notEmpty().isLength({ max: 128 }).withMessage('roomName required, max 128 chars'),
  body('identity').optional().isString().trim().isLength({ max: 255 }),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const userId = req.userId;
    const role = req.userRole;
    const { roomName, identity: identityOverride } = req.body;

    // Room name must be project-scoped: "project-<uuid>" so we can authorize
    const projectIdMatch = roomName.startsWith('project-') && roomName.slice(9);
    const projectId = projectIdMatch ? roomName.slice(8) : null;

    if (projectId) {
      const { rows } = await pool.query('SELECT id, client_id, vendor_id FROM projects WHERE id = $1', [projectId]);
      if (rows.length === 0) {
        return res.status(404).json({ error: 'Project not found' });
      }
      const project = rows[0];
      const allowed =
        role === 'admin' || role === 'super_admin' || (role === 'client' && project.client_id === userId);
      if (!allowed) {
        return res.status(403).json({ error: 'Not allowed to join this call' });
      }
    }

    const accountSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
    const apiKeySid = (process.env.TWILIO_API_KEY_SID || '').trim();
    const apiKeySecret = (process.env.TWILIO_API_KEY_SECRET || '').trim();

    if (!accountSid || !apiKeySid || !apiKeySecret) {
      console.error('[video/token] Missing Twilio env (TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET)');
      return res.status(503).json({
        error: 'Video and voice calls are not configured. In the backend folder, add to .env: TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET. Get an API Key in Twilio Console → Account → API keys & tokens → Create API key (use the SID starting with SK and the Secret; the Secret is shown only once).',
      });
    }

    if (apiKeySid.startsWith('AC')) {
      return res.status(400).json({
        error: 'Video token must use an API Key, not your Account SID. In Twilio Console go to Account → API keys & tokens → Create API key. Use the SID (starts with SK) and Secret for TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET. Do not use your main Auth Token.',
      });
    }

    const authToken = (process.env.TWILIO_AUTH_TOKEN || '').trim();
    if (apiKeySecret === authToken && authToken) {
      return res.status(400).json({
        error: 'Video requires an API Key Secret, not your main Auth Token. In Twilio Console go to Account → API keys & tokens → Create API key. Use the new key’s SID (SK...) and Secret for TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET.',
      });
    }

    const identity = sanitizeIdentity(
      identityOverride && typeof identityOverride === 'string'
        ? identityOverride
        : `user-${userId}`
    );

    const safeRoomName = sanitizeRoomName(roomName);

    const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, {
      identity,
      ttl: 60 * 60,
    });

    const videoGrant = new VideoGrant({ room: safeRoomName });
    token.addGrant(videoGrant);

    const jwt = token.toJwt();
    return res.json({ token: jwt, roomName: safeRoomName });
  } catch (err) {
    next(err);
  }
});

export default router;
