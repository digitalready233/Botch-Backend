# Committed upload fixtures (demo / seed)

These files are **intentional repo fixtures**: JPEGs used for a **consistent local dev experience**, shared demos, and tests (e.g. landing rentals, house plans, vendor listings). They are referenced by seeded or demo data in the app.

## What to commit

- **Images** under `house-plan-covers/`, `house-plan-previews/`, `rental-images/`, `vendor-listings/` — small, static, safe to version.

## What to keep out of git

- **`receipts/`** — generated HTML/PDF artifacts from running the app; regenerate locally or omit from commits.
- **User-uploaded production files** — never commit real customer uploads; use environment-specific storage in production.

## Refreshing fixtures

If you delete this folder, restore from git (`git checkout -- uploads/`) or re-run your DB seed scripts and re-upload; filenames in the database must match paths under `/uploads/...`.
