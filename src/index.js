import "./env.js";
import { validateStartupConfig } from './lib/startup-config.js';
import { initSentryBackend, attachExpressErrorHandler } from './lib/sentry.js';
import http from "http";
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import authRoutes from "./routes/auth.js";
import { getEmailStatus } from './lib/email.js';
import { getUploadsBase } from './lib/upload-paths.js';
import usersRoutes from "./routes/users.js";
import projectAgentAssignmentsRoutes from "./routes/project-agent-assignments.js";
import projectsRoutes from "./routes/projects.js";
import documentsRoutes from "./routes/documents.js";
import invoicesRoutes from "./routes/invoices.js";
import paymentsRoutes, { stripeWebhookHandler } from "./routes/payments.js";
import mediaRoutes from "./routes/media.js";
import messagesRoutes from "./routes/messages.js";
import notificationsRoutes from "./routes/notifications.js";
import videoRoutes from "./routes/video.js";
import kycRoutes from "./routes/kyc.js";
import propertiesRoutes from "./routes/properties.js";
import vendorOrganizationsRoutes from "./routes/vendor-organizations.js";
import vendorBillingRoutes from "./routes/vendor-billing.js";
import vendorListingsRoutes from "./routes/vendor-listings.js";
import rentalsRoutes from "./routes/rentals.js";
import housePlansRoutes from "./routes/house-plans.js";
import appointmentsRoutes from "./routes/appointments.js";
import listingInquiriesRoutes from "./routes/listing-inquiries.js";
import listingOffersRoutes from "./routes/listing-offers.js";
import rentalApplicationsRoutes from "./routes/rental-applications.js";
import inspectionsRoutes from "./routes/inspections.js";
import progressReportsRoutes from "./routes/progress-reports.js";
import supportRoutes from './routes/support.js';
import filesRoutes from './routes/files.js';
import analyticsRoutes from './routes/analytics.js';
import privilegesRoutes from './routes/privileges.js';
import botchAiRoutes from './routes/botch-ai.js';
import fraudReportsRoutes from './routes/fraud-reports.js';
import { authMiddleware, requireAdmin, requireMfaForPrivileged } from './middleware/auth.js';
import { requireUploadsProxySecret } from './middleware/uploads-access.js';
import pool from './db/index.js';
import { runMilestoneReminders } from './lib/milestone-reminders.js';
import { startHousePlanTokenCleanupJob } from './lib/house-plan-token-cleanup.js';
import { runSavedSearchAlerts } from './lib/saved-search-alerts.js';
import { toUserFriendlyMessage } from './lib/userFriendlyErrors.js';
import { getDashboardRisks, getContractorsReputation } from './lib/dashboard-metrics.js';
import { createSocketServer } from './socket.js';
import { arcjetExpressMiddleware } from './lib/arcjet.js';
import swaggerUi from 'swagger-ui-express';
import { openApiSpec } from './openapi.js';

// Security: require JWT_SECRET in production
if (
  process.env.NODE_ENV === "production" &&
  (!process.env.JWT_SECRET || process.env.JWT_SECRET === "dev-secret-change-me")
) {
  console.error(
    "FATAL: JWT_SECRET must be set in production. Set a strong secret in your environment."
  );
  process.exit(1);
}
if (process.env.NODE_ENV === "production" && !(process.env.UPLOADS_PROXY_SECRET || "").trim()) {
  console.error(
    "FATAL: UPLOADS_PROXY_SECRET must be set in production to protect uploaded files."
  );
  process.exit(1);
}
validateStartupConfig();
initSentryBackend();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 4000;
const API_VERSION = process.env.API_VERSION || "v1";

// Allow your Vercel frontend + local dev (comma-separated for multiple URLs)
const FRONTEND_URL = process.env.FRONTEND_URL || "https://my-app-digitalready233s-projects.vercel.app";

/** Extra allowed origins (e.g. preview deploys, staging). Comma-separated full URLs. */
const ADDITIONAL_CORS_ORIGINS = (process.env.ADDITIONAL_CORS_ORIGINS || "")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean);

/** Given a single frontend URL, add both www and non-www variants so CORS works for botchrealty.com and www.botchrealty.com */
function originsWithWwwVariant(url) {
  const list = [url.replace(/\/+$/, '')];
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) {
      const apex = host.slice(4);
      if (apex) list.push(`${u.protocol}//${apex}`);
    } else if (!host.includes('localhost') && !host.startsWith('127.0.0.1')) {
      list.push(`${u.protocol}//www.${host}`);
    }
  } catch (_) {}
  return list;
}

/** Every frontend base URL plus www/apex pair (comma-separated FRONTEND_URL supported). */
function buildAllowedOrigins() {
  const segments = FRONTEND_URL.split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean);
  const expanded = segments.flatMap((s) => originsWithWwwVariant(s));
  const local = [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
  ];
  return [...new Set([...expanded, ...local, ...ADDITIONAL_CORS_ORIGINS])];
}

const allowedOrigins = buildAllowedOrigins();
const FRONTEND_HAS_VERCEL = FRONTEND_URL.includes("vercel.app");

/** Shared HTTP + Socket.IO origin check (preview *.vercel.app when main app is on Vercel). */
function isHttpOriginAllowed(origin) {
  if (!origin) return true;
  const normalized = origin.replace(/\/+$/, '');
  if (allowedOrigins.some((o) => o.replace(/\/+$/, '') === normalized)) return true;
  if (ADDITIONAL_CORS_ORIGINS.includes(normalized)) return true;
  if (FRONTEND_HAS_VERCEL && origin.startsWith('https://') && origin.endsWith('.vercel.app')) return true;
  try {
    const u = new URL(origin);
    const host = u.hostname.toLowerCase();
    const otherHost = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
    const otherOrigin = `${u.protocol}//${otherHost}`;
    if (allowedOrigins.some((o) => o.replace(/\/+$/, '') === otherOrigin)) return true;
  } catch (_) {}
  return false;
}

/** For Socket.IO: same rules as REST CORS. */
function socketCorsOrigin(origin, cb) {
  if (!origin) return cb(null, true);
  if (isHttpOriginAllowed(origin)) return cb(null, true);
  cb(new Error('CORS not allowed'), false);
}

// Trust first proxy (e.g. Nginx, Vercel) so HSTS and rate limits see real IP
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

// CORS: explicit methods and headers so preflight (OPTIONS) returns required Access-Control-* headers (fixes PreflightMissingAllowOriginHeaders on Vercel)
app.use(
  cors({
    origin(origin, callback) {
      if (isHttpOriginAllowed(origin)) {
        return callback(null, origin || true);
      }
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
  })
);

// Security headers (X-Content-Type-Options, X-Frame-Options, etc.); CSP not set for API (frontend sets it)
// In production, enable HSTS so browsers use HTTPS only
app.use(helmet({
  contentSecurityPolicy: false,
  hsts: process.env.NODE_ENV === 'production'
    ? { maxAge: 63072000, includeSubDomains: true, preload: true }
    : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// Remove or obscure Server header to reduce fingerprinting (host may still set it)
app.use((_req, res, next) => {
  res.removeHeader('Server');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(arcjetExpressMiddleware);

app.post(`/api/${API_VERSION}/payments/stripe-webhook`, express.raw({ type: 'application/json' }), stripeWebhookHandler);

app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));

const uploadsDir = getUploadsBase(path.join(__dirname, '..', 'uploads'));
const receiptsDir = path.join(uploadsDir, 'receipts');
const invoicesDir = path.join(uploadsDir, 'invoices');
const chatDir = path.join(uploadsDir, 'chat');
const documentsDir = path.join(uploadsDir, 'documents');
try {
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(receiptsDir, { recursive: true });
  fs.mkdirSync(invoicesDir, { recursive: true });
  fs.mkdirSync(chatDir, { recursive: true });
  fs.mkdirSync(documentsDir, { recursive: true });
} catch (e) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[uploads] Failed to create upload directories:', e.message);
    process.exit(1);
  }
}
if (process.env.NODE_ENV === 'production' && process.env.UPLOADS_PATH) {
  try {
    fs.accessSync(uploadsDir, fs.constants.W_OK);
  } catch (e) {
    console.error('[uploads] UPLOADS_PATH directory is not writable:', uploadsDir, e.message);
    process.exit(1);
  }
}
if (process.env.NODE_ENV === 'production' && !process.env.UPLOADS_PATH) {
  console.warn('[uploads] Production without UPLOADS_PATH. Uploads may be lost on restart. Set UPLOADS_PATH to a persistent path (e.g. /data/private_uploads).');
}
// Stricter cap on hotlinked/static reads (optional UPLOADS_PROXY_SECRET adds another gate below)
const uploadsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 800,
  message: { error: 'Too many upload requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(
  '/uploads',
  uploadsLimiter,
  requireUploadsProxySecret,
  express.static(uploadsDir, {
    setHeaders: (res, filePath) => {
      if (filePath && filePath.includes('chat') && filePath.endsWith('.webm')) {
        res.setHeader('Content-Type', 'audio/webm');
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  })
);

// Stricter rate limit for auth: login + register + OTP share one window; prevents brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(`/api/${API_VERSION}/auth`, authLimiter);

// General API rate limit — high enough for normal use (dashboard, messages, etc.)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1200, // Increased to accommodate multi-row discovery layouts (3 requests per page load)
  message: { error: 'Too many requests. Please slow down and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', limiter);

// OpenAPI UI exposes route surface; off in production unless explicitly enabled
const exposeApiDocs =
  process.env.NODE_ENV !== 'production' || process.env.ENABLE_API_DOCS === 'true';

app.get('/', (req, res) => {
  res.json({
    message: 'Botch API',
    docs:
      exposeApiDocs
        ? `OpenAPI at /api-docs — use the frontend at ${FRONTEND_URL} or API at http://localhost:${PORT}/api/${API_VERSION}`
        : `Use the frontend at ${FRONTEND_URL} or API at http://localhost:${PORT}/api/${API_VERSION}`,
  });
});

app.get('/api/health', async (req, res, next) => {
  try {
    const email = getEmailStatus();
    let database = 'unknown';
    try {
      await pool.query('SELECT 1 AS ok');
      database = 'ok';
    } catch (dbErr) {
      database = 'error';
      console.error('[health] Database check failed:', dbErr.message || dbErr);
    }
    const ok = database === 'ok';
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      version: API_VERSION,
      database,
      email: { configured: email.configured, from: email.from },
    });
  } catch (err) {
    next(err);
  }
});

/** Public config for frontend calculators and UI defaults. */
app.get(`/api/${API_VERSION}/public-config`, (_req, res) => {
  const usdToGhs = Number.parseFloat(String(process.env.PAYSTACK_USD_TO_GHS || '15'));
  const calculatorBasePerSqmGhs = Number.parseFloat(String(process.env.CALCULATOR_BASE_PER_SQM_GHS || '4200'));
  const calculatorBasePerSqmNgn = Number.parseFloat(String(process.env.CALCULATOR_BASE_PER_SQM_NGN || '135000'));
  res.json({
    usd_to_ghs: Number.isFinite(usdToGhs) && usdToGhs > 0 ? usdToGhs : 15,
    calculator_base_per_sqm_ghs:
      Number.isFinite(calculatorBasePerSqmGhs) && calculatorBasePerSqmGhs > 0 ? calculatorBasePerSqmGhs : 4200,
    calculator_base_per_sqm_ngn:
      Number.isFinite(calculatorBasePerSqmNgn) && calculatorBasePerSqmNgn > 0 ? calculatorBasePerSqmNgn : 135000,
  });
});

/** Used by frontend (Vercel) to discover backend origin for Socket.IO. Without this, client falls back to window.location.origin and tries to connect to Vercel, causing connect_error. */
app.get('/api/ws-origin', (req, res) => {
  const origin = process.env.BACKEND_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
  const url = origin
    ? origin.replace(/\/+$/, '')
    : `${req.protocol}://${req.get('host') || `localhost:${PORT}`}`.replace(/\/+$/, '');
  res.json({ origin: url });
});

if (exposeApiDocs) {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, { customCss: '.swagger-ui .topbar { display: none }' }));
  app.get('/api-docs.json', (req, res) => res.json(openApiSpec));
}

app.use(`/api/${API_VERSION}/auth`, authRoutes);
app.use(`/api/${API_VERSION}/users`, usersRoutes);
app.use(`/api/${API_VERSION}/project-agent-assignments`, projectAgentAssignmentsRoutes);
app.use(`/api/${API_VERSION}/projects`, projectsRoutes);
app.use(`/api/${API_VERSION}/projects/:projectId/documents`, documentsRoutes);
app.use(`/api/${API_VERSION}/invoices`, invoicesRoutes);
app.use(`/api/${API_VERSION}/payments`, paymentsRoutes);
app.use(`/api/${API_VERSION}/media`, mediaRoutes);
app.use(`/api/${API_VERSION}/messages`, messagesRoutes);
app.use(`/api/${API_VERSION}/notifications`, notificationsRoutes);
app.use(`/api/${API_VERSION}/video`, videoRoutes);
app.use(`/api/${API_VERSION}/kyc`, kycRoutes);
app.use(`/api/${API_VERSION}/properties`, propertiesRoutes);
app.use(`/api/${API_VERSION}/vendor-organizations`, vendorOrganizationsRoutes);
app.use(`/api/${API_VERSION}/vendor-billing`, vendorBillingRoutes);
app.use(`/api/${API_VERSION}/vendor-listings`, vendorListingsRoutes);
app.use(`/api/${API_VERSION}/rentals`, rentalsRoutes);
app.use(`/api/${API_VERSION}/house-plans`, housePlansRoutes);
app.use(`/api/${API_VERSION}/appointments`, appointmentsRoutes);
app.use(`/api/${API_VERSION}/listing-inquiries`, listingInquiriesRoutes);
app.use(`/api/${API_VERSION}/listing-offers`, listingOffersRoutes);
app.use(`/api/${API_VERSION}/rental-applications`, rentalApplicationsRoutes);
app.use(`/api/${API_VERSION}/inspections`, inspectionsRoutes);
app.use(`/api/${API_VERSION}/progress-reports`, progressReportsRoutes);
app.use(`/api/${API_VERSION}`, supportRoutes);
app.use(`/api/${API_VERSION}/files`, filesRoutes);
app.use(`/api/${API_VERSION}/analytics`, analyticsRoutes);
app.use(`/api/${API_VERSION}/privileges`, privilegesRoutes);
app.use(`/api/${API_VERSION}/botch-ai`, botchAiRoutes);
app.use(`/api/${API_VERSION}/fraud-reports`, fraudReportsRoutes);

app.get(`/api/${API_VERSION}/dashboard/stats`, authMiddleware, requireAdmin, requireMfaForPrivileged, async (req, res, next) => {
  try {
    const [clients, projectsRes, invoices, payments, paymentsThisMonth] = await Promise.all([
      pool.query('SELECT COUNT(*) AS count FROM users WHERE role = $1', ['client']),
      pool.query('SELECT id, client_id, name, status, total_cost, updated_at FROM projects'),
      pool.query("SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total FROM invoices WHERE status = 'pending'"),
      pool.query("SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE status = 'completed'"),
      pool.query(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE status = 'completed' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')"
      ),
    ]);
    const getCount = (rows) => (rows.rows?.[0]?.count != null ? parseInt(rows.rows[0].count, 10) : 0);
    const getTotal = (rows) => (rows.rows?.[0]?.total != null ? parseFloat(rows.rows[0].total) : 0);
    const dedupedProjects = dedupeProjectsByName(projectsRes.rows || []);
    const liveProjects = dedupedProjects.filter((p) => p.status === 'active').length;
    const totalProjectValue = dedupedProjects.reduce((sum, p) => sum + Number(p.total_cost || 0), 0);

    res.json({
      activeClients: getCount(clients),
      liveProjects,
      pendingInvoicesCount: getCount(invoices),
      pendingAmount: getTotal(invoices),
      totalCollected: getTotal(payments),
      totalProjectValue,
      totalOutstandingBalance: getTotal(invoices),
      paymentsThisMonth: getTotal(paymentsThisMonth),
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/admin/jobs/milestone-reminders — run due/approaching invoice reminders (admin; avoids coupling to dashboard GET). */
app.post(
  `/api/${API_VERSION}/admin/jobs/milestone-reminders`,
  authMiddleware,
  requireAdmin,
  requireMfaForPrivileged,
  async (req, res, next) => {
    try {
      const io = req.app.get('io');
      const result = await runMilestoneReminders(io);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

/** POST /api/v1/admin/jobs/saved-search-alerts — run saved-search matcher + notifications */
app.post(
  `/api/${API_VERSION}/admin/jobs/saved-search-alerts`,
  authMiddleware,
  requireAdmin,
  requireMfaForPrivileged,
  async (_req, res, next) => {
    try {
      const result = await runSavedSearchAlerts({ db: pool });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

/** GET /api/v1/dashboard/search - admin global search (clients, projects, invoices, media) */
app.get(`/api/${API_VERSION}/dashboard/search`, authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ clients: [], projects: [], invoices: [], media: [] });
    const term = `%${q}%`;
    const [clientsRes, projectsRes, invoicesRes, mediaRes] = await Promise.all([
      pool.query(
        "SELECT id, full_name, email FROM users WHERE role = 'client' AND (lower(full_name) LIKE lower($1) OR lower(email) LIKE lower($2)) LIMIT 20",
        [term, term]
      ),
      pool.query(
        'SELECT id, name, location, status, client_id FROM projects WHERE lower(name) LIKE lower($1) OR (location IS NOT NULL AND lower(location) LIKE lower($2)) LIMIT 20',
        [term, term]
      ),
      pool.query(
        "SELECT id, invoice_number, project_id, amount, status FROM invoices WHERE lower(invoice_number) LIKE lower($1) LIMIT 20",
        [term]
      ),
      pool.query(
        'SELECT id, title, project_id FROM media WHERE title IS NOT NULL AND lower(title) LIKE lower($1) LIMIT 20',
        [term]
      ),
    ]);
    res.json({
      clients: clientsRes.rows || [],
      projects: projectsRes.rows || [],
      invoices: invoicesRes.rows || [],
      media: mediaRes.rows || [],
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/dashboard/conversion-funnel - basic marketplace conversion KPIs from analytics events */
app.get(`/api/${API_VERSION}/dashboard/conversion-funnel`, authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const nowMs = Date.now();
    const thirtyDaysAgoMs = nowMs - 30 * 24 * 60 * 60 * 1000;
    const { rows } = await pool.query(
      `SELECT event_name, session_id, created_at
       FROM analytics_events
       ORDER BY created_at DESC`,
      []
    );
    const filteredRows = (rows || []).filter((r) => {
      const t = Date.parse(String(r.created_at || ''));
      return Number.isFinite(t) && t >= thirtyDaysAgoMs && t <= nowMs;
    });
    const stageDefs = [
      { key: 'list_view', events: new Set(['property_search']) },
      { key: 'listing_detail', events: new Set(['property_detail_view']) },
      { key: 'saved_or_inquiry', events: new Set(['property_saved', 'listing_inquiry_created']) },
      { key: 'offer_or_viewing', events: new Set(['listing_offer_created', 'listing_viewing_requested']) },
    ];
    const stageSessions = Object.fromEntries(stageDefs.map((s) => [s.key, new Set()]));
    for (const row of filteredRows) {
      const sid = row.session_id || `anon:${new Date(row.created_at || 0).toISOString().slice(0, 13)}:${row.event_name}`;
      for (const stage of stageDefs) {
        if (stage.events.has(row.event_name)) stageSessions[stage.key].add(sid);
      }
    }
    const stages = stageDefs.map((stage, idx) => {
      const count = stageSessions[stage.key].size;
      const prevCount = idx === 0 ? count : stageSessions[stageDefs[idx - 1].key].size;
      const conversionRate = idx === 0 ? 1 : prevCount > 0 ? count / prevCount : 0;
      return {
        stage: stage.key,
        sessions: count,
        conversionRate,
      };
    });
    res.json({
      windowDays: 30,
      stages,
      eventCount: filteredRows.length,
    });
  } catch (err) {
    next(err);
  }
});

/** Deduplicate project list by (client_id, name), keeping latest updated_at then id. */
function dedupeProjectsByName(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.client_id ?? ''}\0${(row.name ?? '').trim()}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    const rowUpdated = row.updated_at ? new Date(row.updated_at).getTime() : 0;
    const existingUpdated = existing.updated_at ? new Date(existing.updated_at).getTime() : 0;
    if (rowUpdated > existingUpdated || (rowUpdated === existingUpdated && (row.id || '') > (existing.id || ''))) {
      byKey.set(key, row);
    }
  }
  return Array.from(byKey.values());
}

/** GET /api/v1/dashboard/projects - admin: projects with health aggregates (location, overdue count, milestones, invoice/media counts). Deduplicated by client+name. */
app.get(`/api/${API_VERSION}/dashboard/projects`, authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    const status = req.query.status;
    const clientId = req.query.client_id;
    let sql = `
      SELECT p.id, p.name, p.client_id, p.location, p.status, p.progress_percent, p.total_cost, p.amount_paid, p.updated_at, p.vendor_id,
             u.full_name AS client_name
      FROM projects p
      LEFT JOIN users u ON p.client_id = u.id
      WHERE 1=1
    `;
    const params = [];
    if (status) { params.push(status); sql += ` AND p.status = $${params.length}`; }
    if (clientId) { params.push(clientId); sql += ` AND p.client_id = $${params.length}`; }
    sql += ' ORDER BY p.updated_at DESC';
    const { rows: rawProjects } = await pool.query(sql, params);
    const projects = dedupeProjectsByName(rawProjects);
    if (projects.length === 0) return res.json([]);

    const projectIds = projects.map((p) => p.id);
    const placeholders = projectIds.map((_, i) => `$${i + 1}`).join(', ');
    const overduePlaceholders = projectIds.map((_, i) => `$${i + 2}`).join(', ');
    const today = new Date().toISOString().slice(0, 10);
    const [overdueRes, milestonesRes, invoiceCountRes, mediaCountRes] = await Promise.all([
      pool.query(
        `SELECT project_id, COUNT(*) AS count FROM invoices WHERE status = 'pending' AND due_date IS NOT NULL AND due_date < $1 AND project_id IN (${overduePlaceholders}) GROUP BY project_id`,
        [today, ...projectIds]
      ),
      pool.query(
        `SELECT project_id, COUNT(*) AS total, SUM(CASE WHEN is_paid = 1 THEN 1 ELSE 0 END) AS completed FROM milestones WHERE project_id IN (${placeholders}) GROUP BY project_id`,
        projectIds
      ),
      pool.query(
        `SELECT project_id, COUNT(*) AS count FROM invoices WHERE project_id IN (${placeholders}) GROUP BY project_id`,
        projectIds
      ),
      pool.query(
        `SELECT project_id, COUNT(*) AS count FROM media WHERE project_id IN (${placeholders}) GROUP BY project_id`,
        projectIds
      ),
    ]);
    const overdueMap = (overdueRes.rows || []).reduce((acc, r) => { acc[r.project_id] = r.count; return acc; }, {});
    const milestonesMap = (milestonesRes.rows || []).reduce((acc, r) => { acc[r.project_id] = { total: r.total, completed: r.completed || 0 }; return acc; }, {});
    const invoiceCountMap = (invoiceCountRes.rows || []).reduce((acc, r) => { acc[r.project_id] = r.count; return acc; }, {});
    const mediaCountMap = (mediaCountRes.rows || []).reduce((acc, r) => { acc[r.project_id] = r.count; return acc; }, {});

    const result = projects.map((p) => {
      const ms = milestonesMap[p.id] || { total: 0, completed: 0 };
      return {
        ...p,
        overdue_invoices_count: overdueMap[p.id] || 0,
        milestones_completed: Number(ms.completed),
        milestones_total: Number(ms.total),
        invoice_count: invoiceCountMap[p.id] || 0,
        media_count: mediaCountMap[p.id] || 0,
      };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/dashboard/risks - admin: project risk monitoring (overdue invoices, missing updates) */
app.get(`/api/${API_VERSION}/dashboard/risks`, authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    const risks = await getDashboardRisks(pool);
    res.json(risks);
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/dashboard/contractors - admin: field agents on client projects (assignments, completion, client ratings) */
app.get(`/api/${API_VERSION}/dashboard/contractors`, authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    const contractors = await getContractorsReputation(pool);
    res.json(contractors);
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/dashboard/billing - admin: projects with milestones and invoice summary (milestone billing view) */
app.get(`/api/${API_VERSION}/dashboard/billing`, authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    const { rows: projects } = await pool.query(
      `SELECT p.id, p.name, p.client_id, p.total_cost, p.amount_paid, p.status, u.full_name AS client_name
       FROM projects p LEFT JOIN users u ON p.client_id = u.id ORDER BY p.updated_at DESC`
    );
    if (projects.length === 0) return res.json([]);

    const projectIds = projects.map((p) => p.id);
    const placeholders = projectIds.map((_, i) => `$${i + 1}`).join(', ');
    const [milestonesRes, invoicesRes] = await Promise.all([
      pool.query(
        `SELECT * FROM milestones WHERE project_id IN (${placeholders}) ORDER BY order_index, created_at`,
        projectIds
      ),
      pool.query(
        `SELECT id, invoice_number, milestone_id, amount, status, pdf_url, due_date, project_id FROM invoices WHERE project_id IN (${placeholders}) ORDER BY created_at`,
        projectIds
      ),
    ]);
    const milestonesByProject = (milestonesRes.rows || []).reduce((acc, m) => {
      (acc[m.project_id] = acc[m.project_id] || []).push(m);
      return acc;
    }, {});
    const invoicesByProject = (invoicesRes.rows || []).reduce((acc, i) => {
      (acc[i.project_id] = acc[i.project_id] || []).push(i);
      return acc;
    }, {});

    const result = projects.map((proj) => {
      const milestones = milestonesByProject[proj.id] || [];
      const invs = invoicesByProject[proj.id] || [];
      return {
        ...proj,
        milestones,
        invoices: invs,
        totalInvoiced: invs.reduce((s, i) => s + Number(i.amount), 0),
        totalPaid: invs.filter((i) => i.status === 'paid').reduce((s, i) => s + Number(i.amount), 0),
      };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Error handler: never leak stack or internals in production. Set security headers on error responses so scanners don't warn.
attachExpressErrorHandler(app);
app.use((err, req, res, next) => {
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) {
    console.error('[error]', err.message || err.code || 'Unknown error');
  } else {
    console.error(err);
  }
  const isUploadReject =
    err.message &&
    (err.message.includes("only allowed file types") ||
      err.code === "LIMIT_FILE_SIZE");
  const status = err.status || (isUploadReject ? 400 : 500);
  const message = toUserFriendlyMessage(err.message, status, isProduction);
  // Ensure security headers are set on error responses (status code indicates error)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store');
  if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.status(status).json({ error: message });
});

// Create server + socket
const server = http.createServer(app);
const io = createSocketServer(server, { origin: socketCorsOrigin, credentials: true });
app.set("io", io);

const runMilestoneJob = () => {
  runMilestoneReminders(io)
    .then((r) => {
      if (r.dueSent > 0 || r.approachingSent > 0) {
        console.log(`[milestone-reminders] due=${r.dueSent} approaching=${r.approachingSent}`);
      }
    })
    .catch((e) => console.error('[milestone-reminders]', e.message || e));
};
setTimeout(runMilestoneJob, 5 * 60 * 1000);
setInterval(runMilestoneJob, 6 * 60 * 60 * 1000);
startHousePlanTokenCleanupJob();

const runSavedSearchAlertsJob = () => {
  runSavedSearchAlerts({ db: pool })
    .then((r) => {
      if ((r.notificationsCreated || 0) > 0) {
        console.log(
          `[saved-search-alerts] scanned=${r.scanned} notifications=${r.notificationsCreated} users=${r.notifiedUsers}`
        );
      }
    })
    .catch((e) => console.error('[saved-search-alerts]', e.message || e));
};
setTimeout(runSavedSearchAlertsJob, 2 * 60 * 1000);
setInterval(runSavedSearchAlertsJob, 30 * 60 * 1000);

app.get(`/api/${API_VERSION}`, (req, res) => {
  res.send("Botch API running");
});
// Weekly progress reports job (runs every 7 days; first run after 60s to avoid blocking startup)
import('./lib/weekly-reports-job.js').then(({ runWeeklyReports }) => {
  const run = () => {
    runWeeklyReports().then((r) => {
      if (r.generated > 0 || r.emailsSent > 0) {
        console.log(`[weekly-reports] Generated ${r.generated} reports, sent ${r.emailsSent} emails`);
      }
    }).catch((e) => console.error('[weekly-reports]', e.message));
  };
  setTimeout(run, 60 * 1000);
  setInterval(run, 7 * 24 * 60 * 60 * 1000);
}).catch(() => {});

// Start server
const LISTEN_HOST = process.env.LISTEN_HOST || '0.0.0.0';

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught exception:', err);
  process.exit(1);
});

server.listen(Number(PORT), LISTEN_HOST, () => {
  console.log(`Botch API running at http://127.0.0.1:${PORT}/api/${API_VERSION}`);
  console.log(`Listening on ${LISTEN_HOST}:${PORT} (set LISTEN_HOST to change bind address)`);
  console.log(`Socket.IO enabled at ws://127.0.0.1:${PORT}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\nPort ${PORT} is already in use. Stop the other process using it, or set PORT to a different number.`
    );
    process.exit(1);
  }
  throw err;
});

// ✅ Remove these duplicates:
// app.use(cors({ origin: "https://my-app-digitalready233s-projects.vercel.app" }));
// app.use(express.json());
// app.get("/api/v1", (req, res) => { res.send("Botch API running"); });
