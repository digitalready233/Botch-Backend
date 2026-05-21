import nodemailer from 'nodemailer';

const MAIL_FROM_NAME = (process.env.MAIL_FROM || process.env.MAIL_FROM_NAME || 'Botch Realty').toString().trim();
const MAIL_FROM_EMAIL = process.env.MAIL_FROM_EMAIL?.trim();
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY?.trim();
const RESEND_API_KEY = process.env.RESEND_API_KEY?.trim();
const MAIL_HOST = process.env.MAIL_HOST?.trim();
const MAIL_PORT = parseInt(process.env.MAIL_PORT || '587', 10);
const MAIL_USER = process.env.MAIL_USER?.trim();
const MAIL_PASS = process.env.MAIL_PASS?.trim();

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (SENDGRID_API_KEY) {
    transporter = nodemailer.createTransport({
      host: 'smtp.sendgrid.net',
      port: 587,
      secure: false,
      auth: { user: 'apikey', pass: SENDGRID_API_KEY },
    });
    return transporter;
  }
  if (RESEND_API_KEY) {
    transporter = nodemailer.createTransport({
      host: 'smtp.resend.com',
      port: 465,
      secure: true,
      auth: { user: 'resend', pass: RESEND_API_KEY },
    });
    return transporter;
  }
  if (MAIL_HOST && MAIL_USER && MAIL_PASS) {
    transporter = nodemailer.createTransport({
      host: MAIL_HOST,
      port: MAIL_PORT,
      secure: MAIL_PORT === 465,
      auth: { user: MAIL_USER, pass: MAIL_PASS },
    });
    return transporter;
  }
  return null;
}

export function isEmailConfigured() {
  return !!(SENDGRID_API_KEY || RESEND_API_KEY || (MAIL_HOST && MAIL_USER && MAIL_PASS));
}

/** Returns email config status for health/status checks (no secrets). */
export function getEmailStatus() {
  const configured = isEmailConfigured();
  if (!configured) return { configured: false, from: null };
  const from = MAIL_FROM_EMAIL
    ? `"${MAIL_FROM_NAME}" <${MAIL_FROM_EMAIL}>`
    : MAIL_FROM_NAME.includes('@')
      ? MAIL_FROM_NAME
      : `"${MAIL_FROM_NAME}" <noreply@botchrealties.com>`;
  return { configured: true, from };
}

/**
 * Send an email. No-op if email is not configured (dev-friendly).
 * @param {{ to: string; subject: string; text: string; html?: string }} options
 * @returns {Promise<{ sent: boolean; messageId?: string; error?: string }>}
 */
export async function sendMail({ to, subject, text, html }) {
  const trans = getTransporter();
  if (!trans) {
    if (process.env.NODE_ENV !== 'production') {
      console.log('[email] Not configured — would send:', { to, subject: subject.slice(0, 50) });
    }
    return { sent: false };
  }
  try {
    const from = MAIL_FROM_EMAIL
      ? `"${MAIL_FROM_NAME}" <${MAIL_FROM_EMAIL}>`
      : MAIL_FROM_NAME.includes('@')
        ? MAIL_FROM_NAME
        : `"${MAIL_FROM_NAME}" <noreply@botchrealties.com>`;
    const info = await trans.sendMail({
      from,
      to,
      subject,
      text: text || (html && html.replace(/<[^>]+>/g, ' ').trim()) || '',
      html: html || text,
    });
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error('[email] Send failed:', err.message);
    return { sent: false, error: err.message };
  }
}
