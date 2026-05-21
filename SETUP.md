# Botch Backend – Setup

This backend uses **SQLite** by default. You do **not** need PostgreSQL or `psql`.

## Quick start

1. **Seed the database** (creates `botch.db` and test users):

   ```powershell
   cd c:\Users\samue\BotchBuild\backend
   npm run db:seed
   ```

2. **Start the API**:

   ```powershell
   npm run dev
   ```

3. **Log in** on the frontend with:
   - **Client:** `client@example.com` / `Password123!`
   - **Admin:** `admin@botchrealties.com` / `Password123!`

For a consolidated env var checklist (JWT, `BACKEND_URL`, SQLite paths, Paystack, Sentry), see [ENV.md](../docs/ENV.md) in the repo root.

---

## If you prefer PostgreSQL

See [POSTGRES-WINDOWS.md](./POSTGRES-WINDOWS.md) for starting PostgreSQL on Windows. You would need to switch the backend to use `pg` and run migrations instead of the SQLite setup.
