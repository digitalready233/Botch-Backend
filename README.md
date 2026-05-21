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
