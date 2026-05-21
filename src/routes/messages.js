import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import pool from '../db/index.js';
import { createNotificationForUser } from '../lib/notifications.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { body, validationResult, query } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../lib/audit.js';
import { sanitizeDisplayName } from '../lib/upload-validation.js';
import { isUserInProjectRoom } from '../socket.js';
import { fileFilter, ALLOWED_CHAT_MIMES } from '../lib/upload-validation.js';
import { getUploadsBase } from '../lib/upload-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chatDir = path.join(getUploadsBase(path.join(__dirname, '..', '..', 'uploads')), 'chat');
try { fs.mkdirSync(chatDir, { recursive: true }); } catch (_) {}
const chatStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, chatDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, uuidv4() + (ext || '.bin'));
  },
});
const chatUpload = multer({ storage: chatStorage, limits: { fileSize: 15 * 1024 * 1024 }, fileFilter: fileFilter(ALLOWED_CHAT_MIMES, 'Chat attachment') }); // 15MB

const router = express.Router();

/** Roles that see all project threads in GET /messages/conversations (ops inbox). */
function isInboxAdminRole(role) {
  return ['admin', 'super_admin', 'vendor_admin', 'finance_admin', 'moderator', 'editor'].includes(role);
}

/** Client project chat always delivers to platform ops (admin or super_admin), preferring super_admin. */
async function resolvePrimaryAdminRecipientId(pool) {
  const { rows } = await pool.query(
    `SELECT id FROM users
     WHERE role IN ('admin', 'super_admin')
     ORDER BY CASE role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, created_at ASC
     LIMIT 1`
  );
  return rows[0]?.id ?? null;
}

/** Client project messages must go only to the primary platform inbox user (see resolvePrimaryAdminRecipientId). */
async function resolveClientOutboundRecipientId(pool, requestedRecipientId) {
  const inboxId = await resolvePrimaryAdminRecipientId(pool);
  if (!inboxId) return { error: 'no_inbox', recipient_id: null };
  const rid = requestedRecipientId && String(requestedRecipientId).trim();
  if (rid && rid !== inboxId) {
    return { error: 'forbidden_recipient', recipient_id: null };
  }
  return { recipient_id: inboxId };
}

/**
 * Message recipient must be the project client or an admin/super_admin.
 * Prevents clients from addressing arbitrary user IDs while in a project thread.
 * When `clientSender` is true, only admin/super_admin recipients are allowed.
 */
async function isRecipientAllowedForProject(pool, proj, recipientId, options = {}) {
  if (!recipientId || !proj) return false;
  if (options.clientSender) {
    const { rows } = await pool.query(
      "SELECT 1 FROM users WHERE id = $1 AND role IN ('admin', 'super_admin') LIMIT 1",
      [recipientId]
    );
    return rows.length > 0;
  }
  if (recipientId === proj.client_id) return true;
  const { rows } = await pool.query(
    "SELECT 1 FROM users WHERE id = $1 AND role IN ('admin', 'super_admin') LIMIT 1",
    [recipientId]
  );
  return rows.length > 0;
}

function dedupeConversations(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const key =
      row.project_id != null && String(row.project_id).trim()
        ? String(row.project_id).trim()
        : `${row.client_id ?? ''}\0${String(row.project_name ?? '').trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

/**
 * Filter project threads by vendor org workspace modules (marketplace / properties / rentals).
 * Used for admin inbox. When workspace is omitted or invalid, no extra filter (legacy behavior).
 */
function projectWorkspaceFilterSql(workspaceRaw) {
  const w = String(workspaceRaw || '').trim().toLowerCase();
  if (!['marketplace', 'properties', 'rentals'].includes(w)) {
    return { join: '', where: '' };
  }
  const join = ' LEFT JOIN vendor_organizations vo ON p.vendor_org_id = vo.id ';
  if (w === 'marketplace') {
    return {
      join,
      where:
        ' AND (p.vendor_org_id IS NULL OR COALESCE(CAST(vo.module_marketplace_enabled AS INTEGER), 1) = 1) ',
    };
  }
  if (w === 'properties') {
    return {
      join,
      where:
        ' AND p.vendor_org_id IS NOT NULL AND COALESCE(CAST(vo.module_properties_enabled AS INTEGER), 0) = 1 ',
    };
  }
  return {
    join,
    where: ' AND p.vendor_org_id IS NOT NULL AND COALESCE(CAST(vo.module_rentals_enabled AS INTEGER), 0) = 1 ',
  };
}

/**
 * Previously correlated construction `projects` rows with listing/rental commerce (inquiries, offers,
 * appointments with both project_id and property_id). That coupling is removed: workspace filters
 * use only `projectWorkspaceFilterSql` (vendor org module flags), not property/listing tables.
 */
function visitorCommerceIntentWhereSql(_workspaceRaw) {
  return '';
}

/**
 * SQL predicate: message is between the project's assigned homeowner (`client` role) and an ops-inbox user.
 * Excludes vendor↔inbox and client↔vendor traffic in the same project row.
 */
function adminClientThreadMessageSql(alias = 'm', projectAlias = 'p') {
  const inboxRoles = `('admin', 'super_admin', 'vendor_admin', 'finance_admin', 'moderator', 'editor')`;
  return `(
    (${alias}.sender_id = ${projectAlias}.client_id AND EXISTS (SELECT 1 FROM users _inbox_r WHERE _inbox_r.id = ${alias}.recipient_id AND _inbox_r.role IN ${inboxRoles}))
    OR
    (${alias}.recipient_id = ${projectAlias}.client_id AND EXISTS (SELECT 1 FROM users _inbox_s WHERE _inbox_s.id = ${alias}.sender_id AND _inbox_s.role IN ${inboxRoles}))
  )`;
}

/** GET /api/v1/messages/conversations - list projects with last message (for chat inbox). SQLite & PG compatible. */
router.get('/conversations', authMiddleware, async (req, res) => {
  const userId = req.userId;
  const isVendor = req.userRole === 'vendor';
  if (!userId) return res.status(401).json({ error: 'Authentication required' });

  try {
    if (isInboxAdminRole(req.userRole)) {
      const ac = adminClientThreadMessageSql('m', 'p');
      const { join: voJoin, where: voWhere } = projectWorkspaceFilterSql(req.query.workspace);
      const visitorWhere = visitorCommerceIntentWhereSql(req.query.workspace);
      const { rows } = await pool.query(
        `SELECT p.id AS project_id, p.name AS project_name, p.client_id, p.vendor_id,
         (SELECT message_text FROM messages m WHERE m.project_id = p.id AND ${ac} ORDER BY m.created_at DESC LIMIT 1) AS last_message_text,
         (SELECT created_at FROM messages m WHERE m.project_id = p.id AND ${ac} ORDER BY m.created_at DESC LIMIT 1) AS last_message_at,
         (SELECT COUNT(*) FROM messages m WHERE m.project_id = p.id AND m.recipient_id = $1 AND (m.is_read = 0 OR m.is_read IS NULL) AND ${ac}) AS unread_count,
         u.full_name AS client_name, u.email AS client_email
         FROM projects p
         INNER JOIN users u ON p.client_id = u.id AND u.role = 'client'
         ${voJoin}
         WHERE 1=1 ${voWhere}${visitorWhere}
         ORDER BY COALESCE(p.updated_at, p.created_at) DESC`,
        [userId]
      );
      return res.json(dedupeConversations(rows));
    }
    if (isVendor) {
      return res.json([]);
    }
    const { rows } = await pool.query(
      `SELECT p.id AS project_id, p.name AS project_name, p.client_id,
       (SELECT message_text FROM messages m WHERE m.project_id = p.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_text,
       (SELECT created_at FROM messages m WHERE m.project_id = p.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at,
       (SELECT COUNT(*) FROM messages m WHERE m.project_id = p.id AND m.recipient_id = $1 AND (m.is_read = 0 OR m.is_read IS NULL)) AS unread_count
       FROM projects p
       WHERE p.client_id = $1
       ORDER BY COALESCE(p.updated_at, p.created_at) DESC`,
      [userId]
    );
    return res.json(dedupeConversations(rows));
  } catch (err) {
    console.error('[GET /messages/conversations]', err);
    try {
      const isAdmin = isInboxAdminRole(req.userRole);
      const { join: voJoin, where: voWhere } = isAdmin ? projectWorkspaceFilterSql(req.query.workspace) : { join: '', where: '' };
      const visitorWhere = isAdmin ? visitorCommerceIntentWhereSql(req.query.workspace) : '';
      const fallbackQuery = isAdmin
        ? `SELECT p.id AS project_id, p.name AS project_name, p.client_id, p.vendor_id, NULL AS last_message_text, NULL AS last_message_at, 0 AS unread_count, u.full_name AS client_name, u.email AS client_email
           FROM projects p INNER JOIN users u ON p.client_id = u.id AND u.role = 'client' ${voJoin} WHERE 1=1 ${voWhere}${visitorWhere} ORDER BY p.created_at DESC`
        : `SELECT p.id AS project_id, p.name AS project_name, p.client_id, NULL AS last_message_text, NULL AS last_message_at, 0 AS unread_count
             FROM projects p WHERE p.client_id = $1 ORDER BY p.created_at DESC`;
      const params = isAdmin ? [] : [userId];
      const { rows } = await pool.query(fallbackQuery, params);
      return res.json(dedupeConversations(rows));
    } catch (fallbackErr) {
      console.error('[GET /messages/conversations] fallback', fallbackErr.message);
      return res.status(200).json([]);
    }
  }
});

/**
 * POST /api/v1/messages/mark-projects-read
 * Inbox roles: mark all unread admin↔client-thread messages read for the current user across given projects.
 * Workspace filter matches GET /messages/conversations when workspace query/body is provided.
 */
router.post('/mark-projects-read', authMiddleware, async (req, res, next) => {
  try {
    if (!isInboxAdminRole(req.userRole)) {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const raw = req.body?.project_ids;
    if (!Array.isArray(raw) || raw.length === 0) {
      return res.status(400).json({ error: 'project_ids must be a non-empty array' });
    }
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const projectIds = [...new Set(raw.map((id) => String(id || '').trim()).filter((id) => uuidRe.test(id)))].slice(0, 100);
    if (projectIds.length === 0) return res.status(400).json({ error: 'No valid project_ids' });

    const ac = adminClientThreadMessageSql('m', 'p');
    const workspace = req.body?.workspace ?? req.query?.workspace;
    const { join: voJoin, where: voWhere } = projectWorkspaceFilterSql(workspace);
    const visitorWhere = visitorCommerceIntentWhereSql(workspace);

    const { rows } = await pool.query(
      `UPDATE messages AS m SET
         is_read = 1,
         delivered_at = COALESCE(m.delivered_at, CURRENT_TIMESTAMP)
       FROM projects AS p${voJoin}
       WHERE m.project_id = p.id
         AND m.project_id = ANY($1::uuid[])
         AND m.recipient_id = $2
         AND (m.is_read = 0 OR m.is_read IS NULL)
         AND ${ac}
         ${voWhere}${visitorWhere}
       RETURNING m.id, m.sender_id`,
      [projectIds, userId]
    );

    const io = req.app && typeof req.app.get === 'function' ? req.app.get('io') : null;
    if (io && Array.isArray(rows)) {
      for (const r of rows) {
        if (r.sender_id) io.to(`user:${r.sender_id}`).emit('message:read', { id: r.id, is_read: true });
      }
    }

    res.json({ ok: true, marked: rows?.length ?? 0 });
  } catch (err) {
    console.error('[POST /messages/mark-projects-read]', err);
    next(err);
  }
});

/** GET /api/v1/messages/unread-total - total unread message count for nav badge. */
router.get('/unread-total', authMiddleware, async (req, res) => {
  const userId = req.userId;
  const isVendor = req.userRole === 'vendor';
  if (!userId) return res.status(401).json({ error: 'Authentication required' });
  try {
    let count = 0;
    if (isInboxAdminRole(req.userRole)) {
      const ac = adminClientThreadMessageSql('m', 'p');
      const { rows } = await pool.query(
        `SELECT COUNT(*) AS total FROM messages m
         INNER JOIN projects p ON p.id = m.project_id
         INNER JOIN users uc ON uc.id = p.client_id AND uc.role = 'client'
         WHERE m.recipient_id = $1 AND (m.is_read = 0 OR m.is_read IS NULL) AND ${ac}`,
        [userId]
      );
      count = parseInt(rows?.[0]?.total ?? '0', 10);
    } else if (isVendor) {
      count = 0;
    } else {
      const { rows } = await pool.query(
        `SELECT COUNT(*) AS total FROM messages m
         INNER JOIN projects p ON p.id = m.project_id AND p.client_id = $1
         WHERE m.recipient_id = $2 AND (m.is_read = 0 OR m.is_read IS NULL)`,
        [userId, userId]
      );
      count = parseInt(rows?.[0]?.total ?? '0', 10);
    }
    res.json({ count });
  } catch (err) {
    console.error('[GET /messages/unread-total]', err);
    res.json({ count: 0 });
  }
});

/** GET /api/v1/messages/recipient - get the other party's user id for a project (for E2EE key lookup) */
router.get('/recipient', authMiddleware, async (req, res, next) => {
  try {
    const project_id = req.query.project_id;
    if (!project_id || typeof project_id !== 'string') return res.status(400).json({ error: 'project_id is required' });
    const { rows: project } = await pool.query('SELECT id, client_id, vendor_id FROM projects WHERE id = $1', [project_id.trim()]);
    if (!project.length) return res.status(404).json({ error: 'Project not found' });
    const proj = project[0];
    const isClient = req.userRole === 'client' && proj.client_id === req.userId;
    const isAdmin = req.userRole === 'admin' || req.userRole === 'super_admin';
    if (req.userRole === 'vendor') {
      return res.status(403).json({ error: 'Project messaging is not available for vendor accounts.' });
    }
    if (!isClient && !isAdmin) return res.status(403).json({ error: "You don't have permission to do that." });
    const recipient_id = isClient
      ? await resolvePrimaryAdminRecipientId(pool)
      : proj.client_id;
    if (!recipient_id) return res.status(404).json({ error: 'Recipient not found' });
    res.json({ recipient_id });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/messages - list messages for a project */
router.get('/', authMiddleware, async (req, res, next) => {
  try {
    const project_id = req.query.project_id;
    if (!project_id || typeof project_id !== 'string' || project_id.trim() === '') {
      return res.status(400).json({ error: 'project_id is required' });
    }
    const { rows: project } = await pool.query('SELECT * FROM projects WHERE id = $1', [project_id.trim()]);
    if (!project || project.length === 0) return res.status(404).json({ error: 'Project not found' });
    const proj = project[0];
    const isClient = req.userRole === 'client' && proj.client_id === req.userId;
    const isAdmin = req.userRole === 'admin' || req.userRole === 'super_admin';
    if (req.userRole === 'vendor') {
      return res.status(403).json({ error: 'Project messaging is not available for vendor accounts.' });
    }
    if (!isClient && !isAdmin) return res.status(403).json({ error: "You don't have permission to do that." });
    const ac = adminClientThreadMessageSql('m', 'p');
    const { rows } = await pool.query(
      `SELECT m.*, sender.full_name AS sender_name FROM messages m
       LEFT JOIN users sender ON m.sender_id = sender.id
       INNER JOIN projects p ON p.id = m.project_id
       WHERE m.project_id = $1 AND ${ac}
       ORDER BY m.created_at ASC`,
      [project_id]
    );
    const messageList = Array.isArray(rows) ? rows : [];
    // Opening the thread marks inbound messages read for the viewer (client or admin) so unread counts clear for this project.
    if (isClient || isAdmin) {
      const { rows: toMark } = await pool.query(
        `SELECT m.id, m.sender_id FROM messages m
         INNER JOIN projects p ON p.id = m.project_id
         WHERE m.project_id = $1 AND m.recipient_id = $2 AND (m.is_read = 0 OR m.is_read IS NULL) AND ${ac}`,
        [project_id, req.userId]
      );
      await pool.query(
        `UPDATE messages m SET is_read = 1, delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP)
         FROM projects p
         WHERE m.project_id = p.id AND m.project_id = $1 AND m.recipient_id = $2 AND ${ac}
         AND (m.is_read = 0 OR m.is_read IS NULL)`,
        [project_id, req.userId]
      );
      const io = req.app && typeof req.app.get === 'function' ? req.app.get('io') : null;
      if (io && Array.isArray(toMark)) {
        for (const r of toMark) {
          if (r.sender_id) io.to(`user:${r.sender_id}`).emit('message:read', { id: r.id, is_read: true });
        }
      }
      const nowIso = new Date().toISOString();
      for (const m of messageList) {
        if (m.recipient_id === req.userId && (m.is_read === 0 || m.is_read === null || m.is_read === false)) {
          m.is_read = 1;
          if (!m.delivered_at) m.delivered_at = nowIso;
        }
      }
    }
    const messageIds = messageList.map((r) => r.id);
    if (messageIds.length > 0) {
      try {
        const placeholders = messageIds.map((_, i) => `$${i + 1}`).join(',');
        const { rows: attRows } = await pool.query(
          `SELECT message_id, file_url, file_name, file_type FROM message_attachments WHERE message_id IN (${placeholders})`,
          messageIds
        );
        const byMessage = {};
        for (const a of attRows || []) {
          if (!byMessage[a.message_id]) byMessage[a.message_id] = [];
          byMessage[a.message_id].push({ file_url: a.file_url, file_name: a.file_name, file_type: a.file_type });
        }
        messageList.forEach((m) => { m.attachments = byMessage[m.id] || []; });
      } catch (_) {
        messageList.forEach((m) => { m.attachments = []; });
      }
      try {
        const placeholders = messageIds.map((_, i) => `$${i + 1}`).join(',');
        const { rows: reactRows } = await pool.query(
          `SELECT message_id, user_id, emoji FROM message_reactions WHERE message_id IN (${placeholders})`,
          messageIds
        );
        const reactionsByMessage = {};
        for (const r of reactRows || []) {
          if (!reactionsByMessage[r.message_id]) reactionsByMessage[r.message_id] = [];
          reactionsByMessage[r.message_id].push({ user_id: r.user_id, emoji: r.emoji });
        }
        messageList.forEach((m) => { m.reactions = reactionsByMessage[m.id] || []; });
      } catch (_) {
        messageList.forEach((m) => { m.reactions = []; });
      }
      try {
        const { rows: pinnedRows } = await pool.query(
          'SELECT message_id FROM pinned_messages WHERE project_id = $1',
          [project_id]
        );
        const pinnedSet = new Set((pinnedRows || []).map((p) => p.message_id));
        messageList.forEach((m) => { m.pinned = pinnedSet.has(m.id); });
      } catch (_) {
        messageList.forEach((m) => { m.pinned = false; });
      }
    } else {
      messageList.forEach((m) => { m.attachments = []; m.reactions = []; m.pinned = false; });
    }
    res.json(messageList);
  } catch (err) {
    console.error('[GET /messages]', err);
    next(err);
  }
});

/** POST /api/v1/messages/:id/mark-received - recipient marks message as delivered+read (when viewing via socket) */
router.post('/:id/mark-received', authMiddleware, async (req, res, next) => {
  try {
    const messageId = req.params.id;
    const { rows } = await pool.query('SELECT * FROM messages WHERE id = $1', [messageId]);
    if (!rows.length) return res.status(404).json({ error: 'Message not found' });
    const msg = rows[0];
    if (msg.recipient_id !== req.userId) return res.status(403).json({ error: 'Only the recipient can mark as received' });
    await pool.query(
      'UPDATE messages SET delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP), is_read = 1 WHERE id = $1',
      [messageId]
    );
    const io = req.app && typeof req.app.get === 'function' ? req.app.get('io') : null;
    if (io) io.to(`user:${msg.sender_id}`).emit('message:delivered', { id: messageId, delivered_at: new Date().toISOString() });
    if (io) io.to(`user:${msg.sender_id}`).emit('message:read', { id: messageId });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/messages/send - send message with optional file attachments (multipart/form-data) */
router.post('/send', authMiddleware, chatUpload.array('files', 5), async (req, res, next) => {
  try {
    const project_id = req.body.project_id && String(req.body.project_id).trim() || null;
    let message_text = (req.body.message_text && String(req.body.message_text).trim()) || '';
    const files = req.files || [];
    const is_encrypted = req.body.is_encrypted === 'true' || req.body.is_encrypted === true;
    const encrypted_content = req.body.encrypted_content && String(req.body.encrypted_content).trim();
    const sender_public_key = req.body.sender_public_key && String(req.body.sender_public_key).trim();

    if (!project_id) return res.status(400).json({ error: 'project_id is required' });
    if (is_encrypted) {
      if (!encrypted_content || !sender_public_key) return res.status(400).json({ error: 'encrypted_content and sender_public_key required when is_encrypted is true' });
      message_text = encrypted_content;
    }
    if (!message_text && files.length === 0) return res.status(400).json({ error: 'message_text or at least one file is required' });

    const { rows: project } = await pool.query('SELECT * FROM projects WHERE id = $1', [project_id]);
    if (!project || project.length === 0) return res.status(404).json({ error: 'Project not found' });
    const proj = project[0];
    const isClient = req.userRole === 'client' && proj.client_id === req.userId;
    const isAdmin = req.userRole === 'admin' || req.userRole === 'super_admin';
    if (req.userRole === 'vendor') {
      return res.status(403).json({ error: 'Project messaging is not available for vendor accounts.' });
    }
    if (!isClient && !isAdmin) return res.status(403).json({ error: "You don't have permission to do that." });

    let recipient_id = req.body.recipient_id && String(req.body.recipient_id).trim() || null;
    if (isClient) {
      const resolved = await resolveClientOutboundRecipientId(pool, recipient_id);
      if (resolved.error === 'no_inbox') {
        return res.status(503).json({ error: 'No administrator available to receive messages.' });
      }
      if (resolved.error === 'forbidden_recipient') {
        return res.status(403).json({ error: 'Messages from clients are delivered to platform administrators only.' });
      }
      recipient_id = resolved.recipient_id;
    }
    if (isAdmin && !recipient_id) recipient_id = proj.client_id;
    if (!recipient_id) return res.status(400).json({ error: 'recipient_id required' });
    const allowed = await isRecipientAllowedForProject(pool, proj, recipient_id, { clientSender: isClient });
    if (!allowed) return res.status(403).json({ error: 'Invalid recipient for this project.' });

    const id = uuidv4();
    const io = req.app && typeof req.app.get === 'function' ? req.app.get('io') : null;
    await pool.query(
      `INSERT INTO messages (id, sender_id, recipient_id, project_id, message_text, is_encrypted, sender_public_key) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, req.userId, recipient_id, project_id, message_text || ' ', is_encrypted ? 1 : 0, is_encrypted ? sender_public_key : null]
    );
    if (io && project_id && isUserInProjectRoom(io, project_id, recipient_id)) {
      await pool.query('UPDATE messages SET delivered_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
    }
    const actId = uuidv4();
    try {
      await pool.query(
        'INSERT INTO project_activity (id, project_id, activity_type, reference_id, actor_id, details) VALUES ($1, $2, $3, $4, $5, $6)',
        [actId, project_id, 'message', id, req.userId, JSON.stringify({ message_text: (message_text || '').slice(0, 200), has_attachments: files.length > 0 })]
      );
    } catch (_) {}

    const attachments = [];
    for (const file of files) {
      const attId = uuidv4();
      const fileUrl = `/uploads/chat/${file.filename}`;
      const fileName = sanitizeDisplayName(file.originalname || file.filename);
      const fileType = file.mimetype || null;
      await pool.query(
        `INSERT INTO message_attachments (id, message_id, file_url, file_name, file_type) VALUES ($1, $2, $3, $4, $5)`,
        [attId, id, fileUrl, fileName, fileType]
      );
      attachments.push({ file_url: fileUrl, file_name: fileName, file_type: fileType });
    }

    const { rows } = await pool.query(
      `SELECT m.*, u.full_name AS sender_name FROM messages m LEFT JOIN users u ON m.sender_id = u.id WHERE m.id = $1`,
      [id]
    );
    const message = rows[0];
    if (message) message.attachments = attachments;
    if (io) {
      io.to(`project:${project_id}`).emit('message:new', message);
      io.to(`user:${recipient_id}`).emit('message:new', message);
      if (message.delivered_at) io.to(`user:${req.userId}`).emit('message:delivered', { id: message.id, delivered_at: message.delivered_at });
    }
    const { rows: senderRow } = await pool.query('SELECT full_name FROM users WHERE id = $1', [req.userId]);
    const senderName = senderRow[0]?.full_name || 'Team';
    const notifText = message_text || (files.length ? `${files.length} file(s)` : '');
    await createNotificationForUser(recipient_id, 'new_message', 'New message', `${senderName}: ${notifText.slice(0, 80)}${notifText.length > 80 ? '…' : ''}`);
    if (io) io.to(`user:${recipient_id}`).emit('notification:new', { type: 'new_message', title: 'New message', message: `${senderName}: ${notifText.slice(0, 80)}${notifText.length > 80 ? '…' : ''}` });
    const { rows: adminRows } = await pool.query("SELECT id FROM users WHERE role IN ('admin', 'super_admin')");
    for (const admin of adminRows) {
      if (admin.id !== recipient_id) {
        await createNotificationForUser(admin.id, 'client_message', 'Client message', `${senderName}: ${notifText.slice(0, 80)}${notifText.length > 80 ? '…' : ''}`);
        if (io) io.to(`user:${admin.id}`).emit('notification:new', { type: 'client_message', title: 'Client message', message: `${senderName}: ${notifText.slice(0, 80)}${notifText.length > 80 ? '…' : ''}` });
      }
    }
    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/messages - send message */
router.post('/', authMiddleware, [
  body('project_id').optional({ nullable: true }).isString().trim(),
  body('recipient_id').optional({ nullable: true }).isString().trim(),
  body('message_text').optional().trim(),
  body('is_encrypted').optional().isBoolean(),
  body('encrypted_content').optional().isString().trim(),
  body('sender_public_key').optional().isString().trim(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    let { project_id, recipient_id, message_text } = req.body;
    message_text = typeof message_text === 'string' ? message_text.trim() : '';
    const is_encrypted = req.body.is_encrypted === true;
    const encrypted_content = req.body.encrypted_content && String(req.body.encrypted_content).trim();
    const sender_public_key = req.body.sender_public_key && String(req.body.sender_public_key).trim();
    if (is_encrypted && encrypted_content && sender_public_key) {
      message_text = encrypted_content;
    }
    if (!message_text) return res.status(400).json({ error: 'message_text or encrypted_content (with sender_public_key) is required' });
    project_id = project_id && String(project_id).trim() || null;
    recipient_id = recipient_id && String(recipient_id).trim() || null;
    let projForRecipient = null;
    if (project_id) {
      const { rows: project } = await pool.query('SELECT * FROM projects WHERE id = $1', [project_id]);
      if (project.length === 0) return res.status(404).json({ error: 'Project not found' });
      const proj = project[0];
      projForRecipient = proj;
      const isClient = req.userRole === 'client' && proj.client_id === req.userId;
      const isAdmin = req.userRole === 'admin' || req.userRole === 'super_admin';
      if (req.userRole === 'vendor') {
        return res.status(403).json({ error: 'Project messaging is not available for vendor accounts.' });
      }
      if (!isClient && !isAdmin) return res.status(403).json({ error: "You don't have permission to do that." });
      if (isClient) {
        const resolved = await resolveClientOutboundRecipientId(pool, recipient_id);
        if (resolved.error === 'no_inbox') {
          return res.status(503).json({ error: 'No administrator available to receive messages.' });
        }
        if (resolved.error === 'forbidden_recipient') {
          return res.status(403).json({ error: 'Messages from clients are delivered to platform administrators only.' });
        }
        recipient_id = resolved.recipient_id;
      }
      if (isAdmin && !recipient_id) recipient_id = proj.client_id;
    } else {
      if (req.userRole !== 'admin' && req.userRole !== 'super_admin') return res.status(403).json({ error: 'Only admin can send broadcast' });
    }
    if (!recipient_id) {
      const msg = project_id && (req.userRole === 'admin' || req.userRole === 'super_admin')
        ? 'This project has no client assigned. Assign a client to this project in the Projects section to send messages.'
        : 'recipient_id required';
      return res.status(400).json({ error: msg });
    }
    if (projForRecipient) {
      const isClientSender = req.userRole === 'client' && projForRecipient.client_id === req.userId;
      const allowed = await isRecipientAllowedForProject(pool, projForRecipient, recipient_id, {
        clientSender: isClientSender,
      });
      if (!allowed) return res.status(403).json({ error: 'Invalid recipient for this project.' });
    }
    const id = uuidv4();
    const isEncryptedFlag = is_encrypted && encrypted_content && sender_public_key;
    await pool.query(
      `INSERT INTO messages (id, sender_id, recipient_id, project_id, message_text, is_encrypted, sender_public_key) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, req.userId, recipient_id, project_id || null, message_text, isEncryptedFlag ? 1 : 0, isEncryptedFlag ? sender_public_key : null]
    );
    const io = req.app && typeof req.app.get === 'function' ? req.app.get('io') : null;
    if (io && project_id && isUserInProjectRoom(io, project_id, recipient_id)) {
      await pool.query('UPDATE messages SET delivered_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
    }
    if (project_id) {
      const actId = uuidv4();
      try {
        await pool.query(
          'INSERT INTO project_activity (id, project_id, activity_type, reference_id, actor_id, details) VALUES ($1, $2, $3, $4, $5, $6)',
          [actId, project_id, 'message', id, req.userId, JSON.stringify({ message_text: message_text.slice(0, 200), has_attachments: false })]
        );
      } catch (_) {}
    }
    const { rows } = await pool.query(
      `SELECT m.*, u.full_name AS sender_name FROM messages m LEFT JOIN users u ON m.sender_id = u.id WHERE m.id = $1`,
      [id]
    );
    const message = rows[0];
    if (io) {
      if (project_id) io.to(`project:${project_id}`).emit('message:new', message);
      io.to(`user:${recipient_id}`).emit('message:new', message);
      if (message.delivered_at) io.to(`user:${req.userId}`).emit('message:delivered', { id: message.id, delivered_at: message.delivered_at });
    }
    const { rows: senderRow } = await pool.query('SELECT full_name FROM users WHERE id = $1', [req.userId]);
    const senderName = senderRow[0]?.full_name || 'Team';
    await createNotificationForUser(recipient_id, 'new_message', 'New message', `${senderName}: ${message_text.slice(0, 80)}${message_text.length > 80 ? '…' : ''}`);
    if (io) io.to(`user:${recipient_id}`).emit('notification:new', { type: 'new_message', title: 'New message', message: `${senderName}: ${message_text.slice(0, 80)}${message_text.length > 80 ? '…' : ''}` });
    const { rows: adminRows } = await pool.query("SELECT id FROM users WHERE role IN ('admin', 'super_admin')");
    for (const admin of adminRows) {
      if (admin.id !== recipient_id) {
        await createNotificationForUser(admin.id, 'client_message', 'Client message', `${senderName}: ${message_text.slice(0, 80)}${message_text.length > 80 ? '…' : ''}`);
        if (io) io.to(`user:${admin.id}`).emit('notification:new', { type: 'client_message', title: 'Client message', message: `${senderName}: ${message_text.slice(0, 80)}${message_text.length > 80 ? '…' : ''}` });
      }
    }
    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/messages/:id/mark-received - recipient marks message as delivered+read (when receiving via socket while viewing chat) */
router.post('/:id/mark-received', authMiddleware, async (req, res, next) => {
  try {
    const messageId = req.params.id;
    const { rows } = await pool.query('SELECT * FROM messages WHERE id = $1', [messageId]);
    if (!rows.length) return res.status(404).json({ error: 'Message not found' });
    const msg = rows[0];
    if (msg.recipient_id !== req.userId) return res.status(403).json({ error: 'Not the recipient' });
    const hadDelivered = !!msg.delivered_at;
    const hadRead = !!msg.is_read;
    await pool.query(
      'UPDATE messages SET delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP), is_read = 1 WHERE id = $1',
      [messageId]
    );
    const io = req.app && typeof req.app.get === 'function' ? req.app.get('io') : null;
    if (io && msg.sender_id) {
      if (!hadDelivered) io.to(`user:${msg.sender_id}`).emit('message:delivered', { id: messageId, delivered_at: new Date().toISOString() });
      if (!hadRead) io.to(`user:${msg.sender_id}`).emit('message:read', { id: messageId, is_read: true });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/v1/messages/:id - delete a message (sender or admin only) */
router.delete('/:id', authMiddleware, async (req, res, next) => {
  try {
    const messageId = req.params.id;
    const { rows: msgRows } = await pool.query('SELECT * FROM messages WHERE id = $1', [messageId]);
    if (!msgRows.length) return res.status(404).json({ error: 'Message not found' });
    const msg = msgRows[0];
    const canDelete = msg.sender_id === req.userId || req.userRole === 'admin' || req.userRole === 'super_admin';
    if (!canDelete) return res.status(403).json({ error: 'You can only delete your own messages' });
    await pool.query('DELETE FROM messages WHERE id = $1', [messageId]);
    logAudit({
      userId: req.userId,
      action: 'message_delete',
      resourceType: 'message',
      resourceId: messageId,
      details: JSON.stringify({ project_id: msg.project_id, sender_id: msg.sender_id }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    const io = req.app && typeof req.app.get === 'function' ? req.app.get('io') : null;
    if (io && msg.project_id) {
      io.to(`project:${msg.project_id}`).emit('message:deleted', { id: messageId });
      io.to(`user:${msg.recipient_id}`).emit('message:deleted', { id: messageId });
    }
    res.json({ ok: true, message: 'Message deleted' });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/messages/forward - forward a message to another conversation (same text + attachments) */
router.post('/forward', authMiddleware, [
  body('message_id').isUUID(),
  body('project_id').isUUID(),
  body('recipient_id').optional().isUUID(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { message_id, project_id, recipient_id: bodyRecipientId } = req.body;
    const { rows: msgRows } = await pool.query('SELECT * FROM messages WHERE id = $1', [message_id]);
    if (!msgRows.length) return res.status(404).json({ error: 'Message not found' });
    const orig = msgRows[0];
    const { rows: projRows } = await pool.query('SELECT * FROM projects WHERE id = $1', [project_id]);
    if (!projRows.length) return res.status(404).json({ error: 'Project not found' });
    const proj = projRows[0];
    const isAdmin = req.userRole === 'admin' || req.userRole === 'super_admin';
    const isClient = req.userRole === 'client' && proj.client_id === req.userId;
    if (!isAdmin && !isClient) return res.status(403).json({ error: "You don't have permission to do that." });
    if (isClient && orig.sender_id !== req.userId) return res.status(403).json({ error: 'You can only forward your own messages' });
    let recipient_id = bodyRecipientId;
    if (isClient) {
      const resolved = await resolveClientOutboundRecipientId(pool, recipient_id);
      if (resolved.error === 'no_inbox') {
        return res.status(503).json({ error: 'No administrator available to receive messages.' });
      }
      if (resolved.error === 'forbidden_recipient') {
        return res.status(403).json({ error: 'Messages from clients are delivered to platform administrators only.' });
      }
      recipient_id = resolved.recipient_id;
    } else if (!recipient_id && isAdmin) recipient_id = proj.client_id;
    if (!recipient_id) return res.status(400).json({ error: 'recipient_id required' });
    const allowedRecipient = await isRecipientAllowedForProject(pool, proj, recipient_id, { clientSender: isClient });
    if (!allowedRecipient) return res.status(403).json({ error: 'Invalid recipient for this project.' });
    const newId = uuidv4();
    await pool.query(
      `INSERT INTO messages (id, sender_id, recipient_id, project_id, message_text) VALUES ($1, $2, $3, $4, $5)`,
      [newId, req.userId, recipient_id, project_id, orig.message_text]
    );
    const { rows: attRows } = await pool.query('SELECT file_url, file_name, file_type FROM message_attachments WHERE message_id = $1', [message_id]);
    for (const a of attRows || []) {
      const attId = uuidv4();
      await pool.query(
        `INSERT INTO message_attachments (id, message_id, file_url, file_name, file_type) VALUES ($1, $2, $3, $4, $5)`,
        [attId, newId, a.file_url, a.file_name || null, a.file_type || null]
      );
    }
    const { rows: newRows } = await pool.query(
      `SELECT m.*, u.full_name AS sender_name FROM messages m LEFT JOIN users u ON m.sender_id = u.id WHERE m.id = $1`,
      [newId]
    );
    const newMsg = newRows[0];
    const { rows: newAttRows } = await pool.query('SELECT file_url, file_name, file_type FROM message_attachments WHERE message_id = $1', [newId]);
    if (newMsg) newMsg.attachments = newAttRows || [];
    const io = req.app && typeof req.app.get === 'function' ? req.app.get('io') : null;
    if (io) {
      io.to(`project:${project_id}`).emit('message:new', newMsg);
      io.to(`user:${recipient_id}`).emit('message:new', newMsg);
    }
    const senderName = newMsg?.sender_name || 'Team';
    const notifText = (orig.message_text || '').slice(0, 80);
    await createNotificationForUser(recipient_id, 'new_message', 'New message', `${senderName}: ${notifText}${notifText.length >= 80 ? '…' : ''}`);
    if (io) io.to(`user:${recipient_id}`).emit('notification:new', { type: 'new_message', title: 'New message', message: `${senderName}: ${notifText}` });
    if (req.userRole === 'admin' || req.userRole === 'super_admin') {
      logAudit({
        userId: req.userId,
        action: 'message_forward',
        resourceType: 'message',
        resourceId: newId,
        details: JSON.stringify({ from_message: message_id, project_id, recipient_id }),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
    }
    res.status(201).json(newMsg);
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/messages/broadcast - admin sends to one or many clients (or all) */
router.post('/broadcast', authMiddleware, requireAdmin, [
  body('message_text').trim().notEmpty(),
  body('recipient_ids').optional().isArray(),
  body('recipient_ids.*').optional().isUUID(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { message_text, recipient_ids } = req.body;
    let targetIds = Array.isArray(recipient_ids) ? recipient_ids.filter(Boolean) : [];
    if (targetIds.length === 0) {
      const { rows } = await pool.query("SELECT id FROM users WHERE role IN ('client', 'buyer')");
      targetIds = rows.map((r) => r.id);
    }
    const io = req.app && typeof req.app.get === 'function' ? req.app.get('io') : null;
    const { rows: senderRow } = await pool.query('SELECT full_name FROM users WHERE id = $1', [req.userId]);
    const senderName = senderRow[0]?.full_name || 'Botch Team';
    const created = [];
    for (const recipient_id of targetIds) {
      const id = uuidv4();
      await pool.query(
        `INSERT INTO messages (id, sender_id, recipient_id, project_id, message_text) VALUES ($1, $2, $3, NULL, $4)`,
        [id, req.userId, recipient_id, message_text]
      );
      const { rows } = await pool.query(
        `SELECT m.*, u.full_name AS sender_name FROM messages m LEFT JOIN users u ON m.sender_id = u.id WHERE m.id = $1`,
        [id]
      );
      created.push(rows[0]);
      await createNotificationForUser(recipient_id, 'broadcast', 'Announcement', `${senderName}: ${message_text.slice(0, 80)}${message_text.length > 80 ? '…' : ''}`);
      if (io) {
        io.to(`user:${recipient_id}`).emit('message:new', rows[0]);
        io.to(`user:${recipient_id}`).emit('notification:new', { type: 'broadcast', title: 'Announcement', message: message_text.slice(0, 100) });
      }
    }
    logAudit({
      userId: req.userId,
      action: 'message_broadcast',
      resourceType: 'message',
      resourceId: null,
      details: JSON.stringify({ recipient_count: targetIds.length, recipient_ids: targetIds.slice(0, 10) }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.status(201).json({ count: created.length, message: 'Broadcast sent', created });
  } catch (err) {
    next(err);
  }
});

// ---------- Project access helper for new messaging features ----------
async function ensureProjectAccess(req, projectId) {
  const { rows: project } = await pool.query('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (!project.length) return { error: 404, message: 'Project not found' };
  const proj = project[0];
  if (req.userRole === 'vendor') {
    return { error: 403, message: 'Project messaging is not available for vendor accounts.' };
  }
  const isClient = req.userRole === 'client' && proj.client_id === req.userId;
  const isAdmin = req.userRole === 'admin' || req.userRole === 'super_admin';
  if (!isClient && !isAdmin) return { error: 403, message: "You don't have permission to do that." };
  return { project: proj };
}

/** GET /api/v1/messages/search - search messages in a project */
router.get('/search', authMiddleware, [
  query('project_id').isUUID(),
  query('q').trim().notEmpty().isLength({ max: 200 }),
], async (req, res, next) => {
  try {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    const access = await ensureProjectAccess(req, req.query.project_id);
    if (access.error) return res.status(access.error).json({ error: access.message });
    const q = `%${String(req.query.q).trim().replace(/%/g, '\\%')}%`;
    const isAdminViewer = req.userRole === 'admin' || req.userRole === 'super_admin';
    const ac = adminClientThreadMessageSql('m', 'p');
    let sql = `SELECT m.id, m.sender_id, m.recipient_id, m.project_id, m.message_text, m.created_at, m.delivered_at, m.is_read,
        u.full_name AS sender_name
       FROM messages m
       LEFT JOIN users u ON m.sender_id = u.id`;
    if (isAdminViewer) sql += ' INNER JOIN projects p ON p.id = m.project_id';
    sql += ' WHERE m.project_id = $1 AND m.message_text LIKE $2';
    if (isAdminViewer) sql += ` AND ${ac}`;
    sql += ' ORDER BY m.created_at DESC LIMIT 50';
    const params = [req.query.project_id, q];
    const { rows } = await pool.query(sql, params);
    res.json(rows || []);
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/messages/:id/reactions - add or remove reaction (emoji) */
router.post('/:id/reactions', authMiddleware, [
  body('emoji').trim().notEmpty().isLength({ max: 32 }),
], async (req, res, next) => {
  try {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    const messageId = req.params.id;
    const emoji = String(req.body.emoji).trim();
    const { rows: msgRows } = await pool.query('SELECT id, project_id FROM messages WHERE id = $1', [messageId]);
    if (!msgRows.length) return res.status(404).json({ error: 'Message not found' });
    const access = await ensureProjectAccess(req, msgRows[0].project_id);
    if (access.error) return res.status(access.error).json({ error: access.message });
    const { rows: existing } = await pool.query(
      'SELECT id FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
      [messageId, req.userId, emoji]
    );
    const io = req.app?.get?.('io');
    if (existing.length > 0) {
      await pool.query('DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3', [messageId, req.userId, emoji]);
      if (io) io.to(`project:${msgRows[0].project_id}`).emit('message:reaction_removed', { messageId, userId: req.userId, emoji });
      return res.json({ action: 'removed', emoji });
    }
    const id = uuidv4();
    await pool.query(
      'INSERT INTO message_reactions (id, message_id, user_id, emoji) VALUES ($1, $2, $3, $4)',
      [id, messageId, req.userId, emoji]
    );
    if (io) io.to(`project:${msgRows[0].project_id}`).emit('message:reaction_added', { messageId, userId: req.userId, emoji });
    res.status(201).json({ action: 'added', emoji, id });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/messages/pinned - list pinned messages for project */
router.get('/pinned', authMiddleware, [query('project_id').isUUID()], async (req, res, next) => {
  try {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    const access = await ensureProjectAccess(req, req.query.project_id);
    if (access.error) return res.status(access.error).json({ error: access.message });
    const sql = `SELECT pm.id, pm.message_id, pm.pinned_by, pm.created_at,
        m.message_text, m.sender_id, m.created_at AS message_created_at,
        u.full_name AS sender_name
       FROM pinned_messages pm
       JOIN messages m ON m.id = pm.message_id
       LEFT JOIN users u ON m.sender_id = u.id
       WHERE pm.project_id = $1
       ORDER BY pm.created_at DESC`;
    const { rows } = await pool.query(sql, [req.query.project_id]);
    res.json(rows || []);
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/messages/:id/pin - pin message (admin/client in project) */
router.post('/:id/pin', authMiddleware, async (req, res, next) => {
  try {
    const messageId = req.params.id;
    const { rows: msgRows } = await pool.query('SELECT id, project_id FROM messages WHERE id = $1', [messageId]);
    if (!msgRows.length) return res.status(404).json({ error: 'Message not found' });
    const access = await ensureProjectAccess(req, msgRows[0].project_id);
    if (access.error) return res.status(access.error).json({ error: access.message });
    const projectId = msgRows[0].project_id;
    const { rows: existing } = await pool.query('SELECT id FROM pinned_messages WHERE project_id = $1 AND message_id = $2', [projectId, messageId]);
    if (existing.length > 0) return res.json({ pinned: true, message: 'Already pinned' });
    const id = uuidv4();
    await pool.query('INSERT INTO pinned_messages (id, project_id, message_id, pinned_by) VALUES ($1, $2, $3, $4)', [id, projectId, messageId, req.userId]);
    const io = req.app?.get?.('io');
    if (io) io.to(`project:${projectId}`).emit('message:pinned', { messageId, projectId });
    res.status(201).json({ pinned: true, id });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/v1/messages/:id/pin - unpin message */
router.delete('/:id/pin', authMiddleware, async (req, res, next) => {
  try {
    const messageId = req.params.id;
    const { rows: msgRows } = await pool.query('SELECT id, project_id FROM messages WHERE id = $1', [messageId]);
    if (!msgRows.length) return res.status(404).json({ error: 'Message not found' });
    const access = await ensureProjectAccess(req, msgRows[0].project_id);
    if (access.error) return res.status(access.error).json({ error: access.message });
    await pool.query('DELETE FROM pinned_messages WHERE message_id = $1 AND project_id = $2', [messageId, msgRows[0].project_id]);
    const io = req.app?.get?.('io');
    if (io) io.to(`project:${msgRows[0].project_id}`).emit('message:unpinned', { messageId });
    res.json({ pinned: false });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/messages/export - export conversation as JSON */
router.get('/export', authMiddleware, [
  query('project_id').isUUID(),
  query('format').optional().isIn(['json']),
], async (req, res, next) => {
  try {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    const access = await ensureProjectAccess(req, req.query.project_id);
    if (access.error) return res.status(access.error).json({ error: access.message });
    const msgSql = `SELECT m.*, u.full_name AS sender_name
       FROM messages m LEFT JOIN users u ON m.sender_id = u.id
       WHERE m.project_id = $1
       ORDER BY m.created_at ASC`;
    const { rows } = await pool.query(msgSql, [req.query.project_id]);
    const attSub =
      'SELECT message_id, file_url, file_name, file_type FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE project_id = $1)';
    const attParams = [req.query.project_id];
    const { rows: attRows } = await pool.query(attSub, attParams);
    const byMsg = {};
    for (const a of attRows || []) {
      if (!byMsg[a.message_id]) byMsg[a.message_id] = [];
      byMsg[a.message_id].push({ file_url: a.file_url, file_name: a.file_name, file_type: a.file_type });
    }
    const exportData = (rows || []).map((m) => ({ ...m, attachments: byMsg[m.id] || [] }));
    res.json({ project_id: req.query.project_id, messages: exportData, exported_at: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/messages/activity - project activity timeline */
router.get('/activity', authMiddleware, [query('project_id').isUUID()], async (req, res, next) => {
  try {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    const access = await ensureProjectAccess(req, req.query.project_id);
    if (access.error) return res.status(access.error).json({ error: access.message });
    const { rows } = await pool.query(
      `SELECT pa.*, u.full_name AS actor_name
       FROM project_activity pa LEFT JOIN users u ON pa.actor_id = u.id
       WHERE pa.project_id = $1 ORDER BY pa.created_at DESC LIMIT 100`,
      [req.query.project_id]
    );
    const list = (rows || []).map((r) => ({
      ...r,
      details: typeof r.details === 'string' ? (r.details ? JSON.parse(r.details) : null) : r.details,
    }));
    res.json(list);
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/messages/escalate - raise escalation for project */
router.post('/escalate', authMiddleware, [
  body('project_id').isUUID(),
  body('message_id').optional().isUUID(),
  body('reason').optional().trim().isLength({ max: 2000 }),
], async (req, res, next) => {
  try {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    const access = await ensureProjectAccess(req, req.body.project_id);
    if (access.error) return res.status(access.error).json({ error: access.message });
    const id = uuidv4();
    await pool.query(
      'INSERT INTO escalations (id, project_id, message_id, raised_by, reason, status) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, req.body.project_id, req.body.message_id || null, req.userId, req.body.reason || null, 'open']
    );
    const { rows } = await pool.query(
      'SELECT e.*, u.full_name AS raised_by_name FROM escalations e LEFT JOIN users u ON e.raised_by = u.id WHERE e.id = $1',
      [id]
    );
    const escalation = rows[0];
    const io = req.app?.get?.('io');
    if (io) io.to(`project:${req.body.project_id}`).emit('escalation:new', escalation);
    const adminIds = (await pool.query("SELECT id FROM users WHERE role IN ('admin', 'super_admin')")).rows?.map((r) => r.id) || [];
    for (const adminId of adminIds) {
      await createNotificationForUser(adminId, 'escalation', 'Conversation escalated', `A conversation was escalated for attention.`);
      if (io) io.to(`user:${adminId}`).emit('notification:new', { type: 'escalation', title: 'Conversation escalated' });
    }
    logAudit({
      userId: req.userId,
      action: 'escalation_raised',
      resourceType: 'escalation',
      resourceId: id,
      details: JSON.stringify({ project_id: req.body.project_id, message_id: req.body.message_id }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.status(201).json(escalation);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/v1/messages/escalations/:id - admin acknowledge or resolve */
router.patch('/escalations/:id', authMiddleware, requireAdmin, [
  body('status').isIn(['acknowledged', 'resolved']),
], async (req, res, next) => {
  try {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    const { rows } = await pool.query('SELECT * FROM escalations WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Escalation not found' });
    const status = req.body.status;
    if (status === 'resolved') {
      await pool.query(
        'UPDATE escalations SET status = $1, resolved_at = CURRENT_TIMESTAMP, resolved_by = $2 WHERE id = $3',
        [status, req.userId, req.params.id]
      );
    } else {
      await pool.query('UPDATE escalations SET status = $1 WHERE id = $2', [status, req.params.id]);
    }
    const { rows: updated } = await pool.query('SELECT * FROM escalations WHERE id = $1', [req.params.id]);
    const io = req.app?.get?.('io');
    if (io && updated[0]?.project_id) io.to(`project:${updated[0].project_id}`).emit('escalation:updated', updated[0]);
    res.json(updated[0]);
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/messages/ai-assistant - AI summary, weekly report, or pending actions (stub / simple text) */
router.get('/ai-assistant', authMiddleware, [
  query('project_id').isUUID(),
  query('action').isIn(['summarize', 'weekly_report', 'pending_actions']),
  query('from_date').optional().isString().trim().isLength({ max: 32 }),
  query('to_date').optional().isString().trim().isLength({ max: 32 }),
], async (req, res, next) => {
  try {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    const access = await ensureProjectAccess(req, req.query.project_id);
    if (access.error) return res.status(access.error).json({ error: access.message });
    const projectId = req.query.project_id;
    const action = req.query.action;
    const fromDate = req.query.from_date || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const toDate = req.query.to_date || new Date().toISOString().slice(0, 10);

    const { rows: messages } = await pool.query(
      'SELECT id, sender_id, message_text, created_at FROM messages WHERE project_id = $1 AND created_at >= $2 AND created_at <= $3 ORDER BY created_at ASC',
      [projectId, fromDate, toDate + 'T23:59:59.999Z']
    );
    const { rows: milestones } = await pool.query(
      'SELECT id, name, progress_percent, created_at FROM milestones WHERE project_id = $1 AND created_at >= $2 ORDER BY created_at DESC LIMIT 20',
      [projectId, fromDate]
    );
    const { rows: media } = await pool.query(
      'SELECT id, media_type, created_at FROM media WHERE project_id = $1 AND created_at >= $2 ORDER BY created_at DESC LIMIT 20',
      [projectId, fromDate]
    );

    let text = '';
    if (action === 'summarize') {
      const count = messages.length;
      const snippet = messages.slice(-5).map((m) => m.message_text?.slice(0, 80)).filter(Boolean).join(' … ');
      text = `Conversation summary (last 7 days): ${count} messages. Recent: ${snippet || 'No recent messages.'}`;
    } else if (action === 'weekly_report') {
      const msgCount = messages.length;
      const mileCount = milestones.length;
      const mediaCount = media.length;
      text = `Weekly project report (${fromDate} to ${toDate}). Messages: ${msgCount}. Milestone updates: ${mileCount}. Media uploads: ${mediaCount}.`;
      if (milestones.length) text += ` Latest milestones: ${milestones.slice(0, 3).map((m) => `${m.name} (${m.progress_percent}%)`).join(', ')}.`;
    } else {
      const openEsc = (await pool.query("SELECT id FROM escalations WHERE project_id = $1 AND status = 'open'", [projectId])).rows?.length || 0;
      const pending = (milestones || []).filter((m) => m.progress_percent < 100).length;
      text = `Pending actions: ${openEsc} open escalation(s). ${pending} milestone(s) not yet 100% complete. ${(messages || []).length} messages in period.`;
    }
    res.json({ action, project_id: projectId, from_date: fromDate, to_date: toDate, text, generated_at: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

export default router;
