'use strict';
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID ? process.env.TWILIO_ACCOUNT_SID.trim() : '';
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN ? process.env.TWILIO_AUTH_TOKEN.trim() : '';
const TWILIO_FROM = process.env.TWILIO_PHONE_NUMBER ? process.env.TWILIO_PHONE_NUMBER.trim() : '';

export function isSmsConfigured() {
  return !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM);
}

export async function sendSms(to, body) {
  if (!isSmsConfigured()) return false;
  try {
    const twilio = await import('twilio');
    const client = twilio.default(TWILIO_SID, TWILIO_TOKEN);
    await client.messages.create({ body: body || '', from: TWILIO_FROM, to });
    return true;
  } catch (err) {
    console.error('[sms] Send failed:', err.message);
    return false;
  }
}
