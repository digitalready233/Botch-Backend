# Security Audit & Hardening Plan

**Date:** 2025  
**Scope:** Backend (Node.js/Express) on Render; real estate/construction platform.  
**Constraints:** No breaking changes; preserve route contracts; backward compatibility where possible.

---

## Phase 1: Current Risk List

| # | Risk | Severity | Current state | File(s) |
|---|------|----------|----------------|---------|
| 1 | **Uploads publicly accessible** | High | `/uploads` served via `express.static`; anyone with URL can access files | `index.js` L139-144 |
| 2 | **UPLOADS_PATH not enforced in prod** | Medium | Warning only; uploads may go to app root and be lost / not under /data | `index.js`, `upload-paths.js` |
| 3 | **MFA not enforced for admin/agent** | High | 2FA optional; no middleware requiring MFA for privileged roles | `auth.js`, `middleware/auth.js` |
| 4 | **Session timeout middleware not applied** | Low | `sessionTimeoutMiddleware` exists but not mounted in app | `index.js`, `middleware/auth.js` |
| 5 | **Auth rate limit too coarse** | Medium | 20/15min for all of /auth (login, register, forgot-password together) | `index.js` L147-154 |
| 6 | **No login failure / MFA audit logs** | Medium | Audit used for some actions; failed logins and MFA events not logged | `auth.js`, `lib/audit.js` |
| 7 | **Webhook secrets optional** | Medium | KYC webhook skips secret check if `KYC_WEBHOOK_SECRET` unset | `kyc.js` L318 |
| 8 | **Production error handler logs full error** | Low | `console.error(err)` can log stack traces to stdout | `index.js` L324 |
| 9 | **No startup validation for webhooks/uploads** | Low | Only JWT_SECRET validated at startup | `index.js` L3-11 |
| 10 | **Appointments PATCH ownership** | Medium | PATCH /:id may lack explicit admin/client ownership check | `appointments.js` |
| 11 | **Stripe webhook idempotency** | Low | By payment id; no event-id dedup; duplicate events could retry | `payments.js` |
| 12 | **Double extension / filename sanitization** | Medium | Multer uses UUID; originalname not sanitized for display/DB | Various upload routes |
| 13 | **CORS allowedHeaders** | Low | Only Content-Type, Authorization; multipart uses Content-Type | `index.js` |
| 14 | **Refresh token rotation** | Medium | Refresh tokens not rotated on use (same secret, long-lived) | `auth.js` |

---

## Phase 1: Exact Files to Change

| File | Changes | Risk |
|------|---------|------|
| `backend/src/index.js` | Startup validator, error handler (no stack in prod), rate limits (auth split), optional /uploads removal + protected route | Low–Medium |
| `backend/src/lib/startup-config.js` | **New.** Validate NODE_ENV, JWT_SECRET, UPLOADS_PATH (prod), webhook secrets if used | Low |
| `backend/src/lib/upload-paths.js` | Prefer /data/private_uploads when UPLOADS_PATH set; keep backward compat | Medium |
| `backend/src/middleware/auth.js` | requireMfaForPrivileged (admin/agent), optional step-up helper | Medium |
| `backend/src/routes/auth.js` | Failed login audit, MFA audit events, stricter rate limit for login/forgot-password, MFA verify limits | Low–Medium |
| `backend/src/routes/payments.js` | Stripe event-id idempotency, log webhook failures; sanitize error response | Low |
| `backend/src/routes/kyc.js` | Require KYC_WEBHOOK_SECRET in prod when Sumsub used; log webhook failures | Low |
| `backend/src/routes/appointments.js` | PATCH /:id: ensure admin or appointment client only | Low |
| `backend/src/lib/audit.js` | No change; ensure used for login failure, MFA, role change, file access | — |
| `backend/src/lib/userFriendlyErrors.js` | Already production-safe; no change | — |
| `backend/docs/SECURITY.md` | Update with hardening summary, ENV checklist, migration, QA, rollback | Low |
| `backend/.env.example` | Document UPLOADS_PATH=/data/private_uploads, MFA_ENFORCE_ADMIN_AGENT | Low |

---

## Phase 1: Risk Level per Change

- **Low-risk:** Startup config validator, production error handler (no stack), auth rate limit split, audit logs for failed login/MFA, webhook secret check in prod, appointments PATCH fix, Stripe event idempotency, SECURITY.md and ENV checklist.
- **Medium-risk:** Private uploads under /data + protected download (new route; existing URLs can redirect or 404 with compatibility period), MFA enforcement for admin/agent (feature flag or gradual rollout), refresh token rotation (add rotation; keep old valid for 1 window).
- **Breaking-risk:** Removing `/uploads` static without a protected replacement (avoid; add protected route first, then deprecate static).

---

## Implementation Order

1. **Phase 2 (Low-risk):** Startup validator, error handler, rate limits, audit (failed login, MFA), webhook hardening, appointments RBAC, docs. ✅
2. **Phase 3 (Medium-risk):** Centralized validation where missing, rate limit for MFA verify and forgot-password, file upload allowlist and filename sanitization, audit (document download, mfa_enabled/disabled). ✅
3. **Phase 4:** Private storage under /data (startup writable check), protected file routes (`/api/v1/files/chat|invoice|receipt|media/:id`), MFA required for admin/agent (`requireMfaForPrivileged`), refresh token rotation. ✅
4. **Phase 5:** Docs (SECURITY.md, ENV checklist, QA, rollback). ✅

---

## Rollback Strategy

- Each phase in a separate commit; feature flags where possible (e.g. `MFA_ENFORCE_ADMIN_AGENT=false`).
- Keep existing env vars working; add new ones as optional with safe defaults.
- If private uploads are enabled, keep `UPLOADS_PATH` pointing to same base until protected endpoint is verified.
