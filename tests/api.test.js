/**
 * Basic API tests. Run with: node --test tests/api.test.js
 * Requires backend running on PORT (default 4000) or set BASE_URL.
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';
const API = BASE_URL + '/api/v1';

async function fetchJson(url, opts) {
  const res = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ 'Content-Type': 'application/json' }, opts && opts.headers) }));
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (e) {
    body = null;
  }
  return { status: res.status, body, ok: res.ok };
}

async function testHealth() {
  const { status, body } = await fetchJson(BASE_URL + '/api/health');
  if (status !== 200 || body?.status !== 'ok') throw new Error('Health check failed: ' + JSON.stringify(body));
}

async function testAuthRequired() {
  const { status } = await fetchJson(API + '/payments/bank-details');
  if (status !== 401) throw new Error('Expected 401 for unauthenticated bank-details');
}

(async function run() {
  try {
    await testHealth();
    await testAuthRequired();
    console.log('API tests passed');
  } catch (err) {
    console.error('Test failed:', err.message);
    process.exit(1);
  }
})();
