# Botch Backend

Express API for Botch Realty (`botch-backend`).

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your secrets
npm run db:migrate
npm run dev
```

API base: `http://127.0.0.1:4000/api/v1`  
Health: `http://127.0.0.1:4000/api/health`

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Dev server with auto-restart |
| `npm run start` | Production start |
| `npm run db:migrate` | Apply SQLite migrations |
| `npm run rebuild:sqlite` | Rebuild `better-sqlite3` native module |

See `SETUP.md` for full configuration.

## Dokploy (Botch-Backend repo only)

| Setting | Value |
|--------|--------|
| Repository | `digitalready233/Botch-Backend` |
| Branch | `main` |
| **Build path** | **`.`** (not `backend`) |
| **Publish directory** | **`.`** |
| Port | `4000` |
| Build type | **Dockerfile** (recommended) or Nixpacks |

**Required production env** (in Dokploy → Environment):

- `NODE_ENV=production`
- `PORT=4000`
- `JWT_SECRET` — strong random string
- `UPLOADS_PROXY_SECRET` — strong random string (app exits without it in production)
- `FRONTEND_URL` — e.g. `https://botchrealty.com` (no trailing slash)
- `BACKEND_URL` / `BACKEND_PUBLIC_URL` — your API URL, e.g. `https://api.botchrealty.com`
- `UPLOADS_PATH` — persistent path, e.g. `/data/uploads` (mount a volume at `/data`)
- `SQLITE_PATH` — e.g. `/data/botch.db` (same volume as uploads)

Optional: Paystack, Resend, Twilio keys from your local `.env`.
