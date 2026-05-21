/**
 * Generate a simple receipt PDF when a payment is completed.
 * Saves to uploads/receipts/ or uploads to S3 if configured. Non-blocking; failures are logged.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/index.js';
import { uploadToS3, isS3Configured } from './s3.js';
import { getUploadsBase } from './upload-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const receiptsDir = path.join(getUploadsBase(path.join(__dirname, '..', '..', 'uploads')), 'receipts');

/**
 * Generate receipt PDF and store URL. Call after payment is marked completed.
 * @param {object} payment - Row from payments table (id, invoice_id, client_id, amount, currency, payment_method, transaction_id, created_at)
 * @param {object} [invoice] - Optional invoice row (invoice_number, project_id)
 * @param {object} [user] - Optional user row (full_name, email)
 * @returns {Promise<string|null>} - receipt_url to save, or null
 */
export async function generateReceiptPdf(payment, invoice = null, user = null) {
  try {
    const pdfContent = buildReceiptHtml(payment, invoice, user);
    const filename = `receipt-${payment.id}.html`;
    // Use HTML as simple "receipt" that can be printed to PDF by browser; for real PDF use pdfkit if added
    const buffer = Buffer.from(pdfContent, 'utf-8');
    const contentType = 'text/html';

    if (isS3Configured()) {
      const key = `receipts/${payment.id}.html`;
      const url = await uploadToS3(buffer, key, contentType);
      if (url) return url;
    }

    try {
      fs.mkdirSync(receiptsDir, { recursive: true });
    } catch (_) {}
    const localPath = path.join(receiptsDir, filename);
    fs.writeFileSync(localPath, buffer);
    return `/uploads/receipts/${filename}`;
  } catch (err) {
    console.error('[receipt-pdf] Generate failed:', err.message);
    return null;
  }
}

function buildReceiptHtml(payment, invoice, user) {
  const date = payment.created_at ? new Date(payment.created_at).toISOString().slice(0, 19).replace('T', ' ') : '';
  const invNum = invoice?.invoice_number || payment.invoice_id?.slice(0, 8) || '—';
  const name = user?.full_name || user?.email || 'Client';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Receipt ${payment.id}</title></head><body style="font-family:sans-serif;max-width:480px;margin:2em auto;padding:1em;">
<h2>Payment Receipt</h2>
<p><strong>Receipt ID</strong>: ${payment.id}</p>
<p><strong>Invoice</strong>: ${invNum}</p>
<p><strong>Amount</strong>: ${payment.currency || 'USD'} ${Number(payment.amount).toFixed(2)}</p>
<p><strong>Method</strong>: ${payment.payment_method || 'N/A'}</p>
<p><strong>Transaction</strong>: ${payment.transaction_id || '—'}</p>
<p><strong>Date</strong>: ${date}</p>
<p><strong>Payee</strong>: ${name}</p>
<hr><p style="color:#666;font-size:0.9em;">Botch Realty — This is a computer-generated receipt.</p>
</body></html>`;
}

/**
 * After payment is completed, generate receipt and update payment.receipt_url if not already set.
 */
export async function ensureReceiptForPayment(paymentId) {
  try {
    const { rows: payRows } = await pool.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
    if (payRows.length === 0) return;
    const payment = payRows[0];
    if (payment.receipt_url) return;

    const { rows: invRows } = await pool.query('SELECT * FROM invoices WHERE id = $1', [payment.invoice_id]);
    const { rows: userRows } = await pool.query('SELECT full_name, email FROM users WHERE id = $1', [payment.client_id]);
    const url = await generateReceiptPdf(payment, invRows[0], userRows[0]);
    if (url) {
      await pool.query('UPDATE payments SET receipt_url = $1 WHERE id = $2', [url, paymentId]);
    }
  } catch (err) {
    console.error('[receipt-pdf] ensureReceipt failed:', err.message);
  }
}
