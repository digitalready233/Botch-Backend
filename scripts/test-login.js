/**
 * Quick test that the backend login works. Run from repo root:
 *   node backend/scripts/test-login.js
 * Expected: prints "Login OK" and user/role, or an error message.
 */
const BACKEND = process.env.BACKEND_URL || 'http://localhost:4000';
const url = `${BACKEND}/api/v1/auth/login`;

async function test() {
  console.log('Testing login at', url);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'client@example.com', password: 'Password123!' }),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error('Backend did not return JSON. Status:', res.status);
      console.error('Preview:', text.slice(0, 200));
      process.exit(1);
    }
    if (!res.ok) {
      console.error('Login failed:', data?.error || data?.message || res.status);
      process.exit(1);
    }
    if (data.user && data.accessToken) {
      console.log('Login OK. User:', data.user.email, 'Role:', data.user.role);
      process.exit(0);
    }
    if (data.requiresTwoFa) {
      console.log('Login OK (2FA required). Frontend will show code step.');
      process.exit(0);
    }
    console.error('Unexpected response:', data);
    process.exit(1);
  } catch (err) {
    console.error('Request failed:', err.message);
    console.error('Is the backend running? Try: cd backend && npm run dev');
    process.exit(1);
  }
}

test();
