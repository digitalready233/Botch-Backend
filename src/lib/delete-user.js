import pool from '../db/index.js';
import { getDbKind } from '../db/index.js';

/**
 * Delete a user and related rows (messages, attachments). Works on SQLite and MySQL.
 */
export async function deleteUserById(userId) {
  if (getDbKind() === 'sqlite') {
    const { db } = await import('../db/sqlite.js');
    const deleteUser = db.transaction((id) => {
      const msgIds = db
        .prepare('SELECT id FROM messages WHERE sender_id = ? OR recipient_id = ?')
        .all(id, id)
        .map((r) => r.id);
      if (msgIds.length > 0) {
        const placeholders = msgIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM message_attachments WHERE message_id IN (${placeholders})`).run(...msgIds);
        db.prepare('DELETE FROM messages WHERE sender_id = ? OR recipient_id = ?').run(id, id);
      }
      db.prepare('UPDATE media SET uploaded_by = NULL WHERE uploaded_by = ?').run(id);
      try {
        db.prepare('UPDATE project_documents SET uploaded_by = NULL WHERE uploaded_by = ?').run(id);
      } catch (_) {}
      try {
        db.prepare('UPDATE kyc_documents SET reviewed_by = NULL WHERE reviewed_by = ?').run(id);
      } catch (_) {}
      try {
        db.prepare('UPDATE audit_logs SET user_id = NULL WHERE user_id = ?').run(id);
      } catch (_) {}
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    });
    deleteUser(userId);
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [msgRows] = await conn.query(
      'SELECT id FROM messages WHERE sender_id = ? OR recipient_id = ?',
      [userId, userId]
    );
    const msgIds = (msgRows || []).map((r) => r.id);
    if (msgIds.length > 0) {
      await conn.query('DELETE FROM message_attachments WHERE message_id IN (?)', [msgIds]);
      await conn.query('DELETE FROM messages WHERE sender_id = ? OR recipient_id = ?', [userId, userId]);
    }
    await conn.query('UPDATE media SET uploaded_by = NULL WHERE uploaded_by = ?', [userId]);
    try {
      await conn.query('UPDATE project_documents SET uploaded_by = NULL WHERE uploaded_by = ?', [userId]);
    } catch (_) {}
    try {
      await conn.query('UPDATE kyc_documents SET reviewed_by = NULL WHERE reviewed_by = ?', [userId]);
    } catch (_) {}
    try {
      await conn.query('UPDATE audit_logs SET user_id = NULL WHERE user_id = ?', [userId]);
    } catch (_) {}
    await conn.query('DELETE FROM users WHERE id = ?', [userId]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}
