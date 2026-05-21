import pool from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';
import { sendSms, isSmsConfigured } from './sms.js';
import { sendMail, isEmailConfigured } from './email.js';

const SMS_NOTIFICATION_TYPES = ['payment_received', 'invoice_ready', 'invoice_pdf_ready', 'bank_transfer_requested', 'kyc_approved', 'media_uploaded'];
const EMAIL_NOTIFICATION_TYPES = [
  'invoice_ready',
  'invoice_pdf_ready',
  'media_uploaded',
  /** Admins get booking details in inbox when email is configured */
  'appointment_request',
  /** Admins get bank-transfer alerts in email when SMS is not the primary channel */
  'bank_transfer_requested',
  /** Trust & safety alerts for moderation team */
  'fraud_report_opened',
];

/**
 * Create an in-app notification and optionally send SMS + email when configured.
 */
export async function createNotificationForUser(userId, type, title, message = null) {
  const id = uuidv4();
  await pool.query(
    `INSERT INTO notifications (id, user_id, type, title, message) VALUES ($1, $2, $3, $4, $5)`,
    [id, userId, type || null, title, message]
  );
  const { rows: userRows } = await pool.query('SELECT email, phone FROM users WHERE id = $1', [userId]);
  const user = userRows[0];
  if (isSmsConfigured() && SMS_NOTIFICATION_TYPES.includes(type) && user?.phone && user.phone.replace(/\D/g, '').length >= 10) {
    sendSms(user.phone, [title, message].filter(Boolean).join(' — ').slice(0, 160)).catch(() => {});
  }
  if (isEmailConfigured() && EMAIL_NOTIFICATION_TYPES.includes(type) && user?.email) {
    const text = [title, message].filter(Boolean).join('\n\n');
    sendMail({ to: user.email, subject: title, text }).catch(() => {});
  }
  return id;
}
