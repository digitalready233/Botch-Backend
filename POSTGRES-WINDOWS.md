# Starting PostgreSQL on Windows

**Note:** This backend uses **SQLite** by default. You only need PostgreSQL if you switch the app to use it. For normal setup, see [SETUP.md](./SETUP.md).

If you do use PostgreSQL, `pg_ctl` is not in your PATH by default on Windows. Use one of these methods:

## Option 1: Windows Service (recommended)

If PostgreSQL was installed with the default “Install as a Windows Service” option:

1. Press **Win + R**, type `services.msc`, press Enter.
2. Find **postgresql-x64-15** (or **postgresql-x64-16** / your version).
3. Right‑click → **Start**.

Or in **PowerShell (Run as Administrator)**:

```powershell
# Replace 16 with your major version if different
net start postgresql-x64-16
```

To see the exact service name:

```powershell
Get-Service -Name *postgres*
```

## Option 2: pg_ctl with full path

Use the full path to `pg_ctl` in the PostgreSQL install folder:

```powershell
# Typical path – change 16 to your version
& "C:\Program Files\PostgreSQL\16\bin\pg_ctl.exe" -D "C:\Program Files\PostgreSQL\16\data" start
```

To stop:

```powershell
& "C:\Program Files\PostgreSQL\16\bin\pg_ctl.exe" -D "C:\Program Files\PostgreSQL\16\data" stop
```

## Option 3: Add PostgreSQL to PATH

1. **Win + R** → `sysdm.cpl` → **Advanced** tab → **Environment Variables**.
2. Under **System variables**, select **Path** → **Edit** → **New**.
3. Add: `C:\Program Files\PostgreSQL\16\bin` (use your version number).
4. OK out, then **close and reopen** PowerShell/terminal.

Then you can run:

```powershell
pg_ctl -D "C:\Program Files\PostgreSQL\16\data" start
```

## After PostgreSQL is running

From the project root:

```powershell
cd backend
npm run db:migrate
npm run db:seed
npm run dev
```

Default connection: `postgresql://postgres:postgres@localhost:5432/botch_db` (create the `botch_db` database in pgAdmin or with `createdb` if needed).
