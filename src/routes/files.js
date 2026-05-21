/**
 * Protected file delivery. All routes require auth and object-level permission.
 * Use these URLs instead of direct /uploads/* so files are not publicly accessible.
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { param, validationResult } from 'express-validator';
import pool from '../db/index.js';
import { authMiddleware } from '../middleware/auth.js';
import { getUploadsBase } from '../lib/upload-paths.js';
import { logAudit } from '../lib/audit.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsBase = getUploadsBase(path.join(__dirname, '..', '..', 'uploads'));
const chatDir = path.join(uploadsBase, 'chat');
const invoicesDir = path.join(uploadsBase, 'invoices');
const receiptsDir = path.join(uploadsBase, 'receipts');

const router = express.Router();

function isLocalUploadUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return url.includes('/uploads/') && !url.includes('amazonaws.com') && !url.includes('s3.');
}

/** GET /api/v1/files/chat/:attachmentId - stream chat attachment if user has access to the message */
router.get('/chat/:attachmentId', authMiddleware, [param('attachmentId').isUUID()], async (req, res, next) => {
  try {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    const { attachmentId } = req.params;
    const { rows: att } = await pool.query(
      `SELECT a.id, a.message_id, a.file_url, a.file_name FROM message_attachments a
       JOIN messages m ON m.id = a.message_id
       WHERE a.id = $1`,
      [attachmentId]
    );
    if (att.length === 0) return res.status(404).json({ error: 'Attachment not found' });
    const a = att[0];
    if (!isLocalUploadUrl(a.file_url)) return res.status(404).json({ error: 'File not available for download' });
    const filename = a.file_url.replace(/^.*\/chat\//, '').replace(/\?.*$/, '').trim();
    if (!filename || filename.includes('..')) return res.status(400).json({ error: 'Invalid path' });
    const fullPath = path.join(chatDir, path.basename(filename));
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File not found' });

    const { rows: msg } = await pool.query(
      'SELECT sender_id, recipient_id, project_id FROM messages WHERE id = $1',
      [a.message_id]
    );
    if (msg.length === 0) return res.status(404).json({ error: 'Message not found' });
    const m = msg[0];
    let canAccess = req.userId === m.sender_id || req.userId === m.recipient_id
      || (m.project_id && (req.userRole === 'admin' || req.userRole === 'super_admin'));
    if (!canAccess && m.project_id) {
      const { rows: proj } = await pool.query('SELECT client_id FROM projects WHERE id = $1', [m.project_id]);
      if (proj.length && proj[0].client_id === req.userId) canAccess = true;
    }
    if (!canAccess) return res.status(403).json({ error: "You don't have permission to access this file." });

    logAudit({
      userId: req.userId,
      action: 'file_download',
      resourceType: 'message_attachment',
      resourceId: attachmentId,
      details: JSON.stringify({ message_id: a.message_id }),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.download(fullPath, a.file_name || path.basename(filename));
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/files/invoice/:invoiceId - stream invoice PDF if user has access */
router.get('/invoice/:invoiceId', authMiddleware, [param('invoiceId').isUUID()], async (req, res, next) => {
  try {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    const { invoiceId } = req.params;
    const { rows } = await pool.query(
      `SELECT i.id, i.client_id, i.pdf_url
       FROM invoices i
       JOIN projects p ON i.project_id = p.id
       WHERE i.id = $1`,
      [invoiceId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    const inv = rows[0];
    let canAccess =
      req.userRole === 'admin' ||
      req.userRole === 'super_admin' ||
      inv.client_id === req.userId;
    if (!canAccess) return res.status(403).json({ error: "You don't have permission to access this file." });
    if (!inv.pdf_url) return res.status(404).json({ error: 'Invoice PDF not yet uploaded' });

    if (isLocalUploadUrl(inv.pdf_url)) {
      const filename = inv.pdf_url.replace(/^.*\/invoices\//, '').replace(/\?.*$/, '').trim();
      if (filename && !filename.includes('..')) {
        const fullPath = path.join(invoicesDir, path.basename(filename));
        if (fs.existsSync(fullPath)) {
          logAudit({
            userId: req.userId,
            action: 'file_download',
            resourceType: 'invoice',
            resourceId: invoiceId,
            details: JSON.stringify({ type: 'pdf' }),
            ip: req.ip,
            userAgent: req.headers['user-agent'],
          });
          return res.download(fullPath, `invoice-${invoiceId}.pdf`);
        }
      }
    }
    return res.status(404).json({ error: 'File not available for download' });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/files/receipt/:paymentId - stream receipt file if user has access */
router.get('/receipt/:paymentId', authMiddleware, [param('paymentId').isUUID()], async (req, res, next) => {
  try {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    const { paymentId } = req.params;
    const { rows } = await pool.query('SELECT id, client_id, receipt_url FROM payments WHERE id = $1', [paymentId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Payment not found' });
    const pay = rows[0];
    const canAccess = req.userRole === 'admin' || req.userRole === 'super_admin' || pay.client_id === req.userId;
    if (!canAccess) return res.status(403).json({ error: "You don't have permission to access this file." });
    if (!pay.receipt_url) return res.status(404).json({ error: 'Receipt not yet generated' });

    if (isLocalUploadUrl(pay.receipt_url)) {
      const filename = `receipt-${paymentId}.html`;
      const fullPath = path.join(receiptsDir, filename);
      if (fs.existsSync(fullPath)) {
        logAudit({
          userId: req.userId,
          action: 'file_download',
          resourceType: 'payment',
          resourceId: paymentId,
          details: JSON.stringify({ type: 'receipt' }),
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
        return res.download(fullPath, filename);
      }
    }
    return res.status(404).json({ error: 'File not available for download' });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/files/media/:mediaId - stream media file if user has project access */
router.get('/media/:mediaId', authMiddleware, [param('mediaId').isUUID()], async (req, res, next) => {
  try {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    const { mediaId } = req.params;
    const { rows } = await pool.query('SELECT id, project_id, file_url FROM media WHERE id = $1', [mediaId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Media not found' });
    const med = rows[0];
    const { rows: proj } = await pool.query('SELECT client_id FROM projects WHERE id = $1', [med.project_id]);
    if (proj.length === 0) return res.status(404).json({ error: 'Project not found' });
    const p = proj[0];
    const canAccess = req.userRole === 'admin' || req.userRole === 'super_admin' || p.client_id === req.userId;
    if (!canAccess) return res.status(403).json({ error: "You don't have permission to access this file." });
    if (!med.file_url) return res.status(404).json({ error: 'File not available' });

    if (isLocalUploadUrl(med.file_url)) {
      const afterUploads = med.file_url.split('/uploads/')[1];
      const baseName = afterUploads ? path.basename(afterUploads.replace(/\?.*$/, '').trim()) : null;
      if (baseName && !baseName.includes('..')) {
        const fullPath = path.join(uploadsBase, baseName);
        if (fs.existsSync(fullPath)) {
          logAudit({
            userId: req.userId,
            action: 'file_download',
            resourceType: 'media',
            resourceId: mediaId,
            details: JSON.stringify({ project_id: med.project_id }),
            ip: req.ip,
            userAgent: req.headers['user-agent'],
          });
          return res.download(fullPath, baseName);
        }
      }
    }
    return res.status(404).json({ error: 'File not available for download' });
  } catch (err) {
    next(err);
  }
});

export default router;
