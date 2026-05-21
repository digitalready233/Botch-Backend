/**
 * Test Paystack secret key directly.
 * Run from backend folder: node scripts/test-paystack-key.js
 * If you see "Invalid Key", get a new Secret Key from Paystack Dashboard → Settings → API Keys.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const key = (process.env.PAYSTACK_SECRET_KEY || '').replace(/\s+/g, '').trim();
if (!key) {
  console.error('No PAYSTACK_SECRET_KEY in .env');
  process.exit(1);
}
if (key.startsWith('pk_')) {
  console.error('You set the PUBLIC key. Use the SECRET key (sk_test_...) from Dashboard → Settings → API Keys.');
  process.exit(1);
}

const res = await fetch('https://api.paystack.co/transaction/initialize', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + key,
  },
  body: JSON.stringify({
    email: 'test@example.com',
    amount: '10000',
    currency: 'GHS',
  }),
});
const data = await res.json();

if (data.status && data.data?.authorization_url) {
  console.log('OK – Key is valid. Paystack returned authorization_url.');
} else {
  console.log('Paystack response:', data.message || data);
  if ((data.message || '').toLowerCase().includes('invalid') && (data.message || '').toLowerCase().includes('key')) {
    console.error('\n→ Get a new Secret Key from https://dashboard.paystack.com → Settings → API Keys & Webhooks.');
    console.error('→ Copy the "Secret Key" (starts with sk_test_), put it in backend/.env as PAYSTACK_SECRET_KEY=sk_test_...');
    console.error('→ Restart the backend (npm run dev).');
  }
  process.exit(1);
}
