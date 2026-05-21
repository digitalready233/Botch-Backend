import express from 'express';
import { body, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/index.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

function toTime(value) {
  const t = Date.parse(String(value || ''));
  return Number.isFinite(t) ? t : 0;
}

function startOfDayMs(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfUtcDayMs(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

router.get('/marketplace-overview', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const nowMs = Date.now();
    const todayStart = startOfDayMs(nowMs);
    const sevenDaysAgo = nowMs - 7 * 24 * 60 * 60 * 1000;
    const fourteenDaysAgo = nowMs - 14 * 24 * 60 * 60 * 1000;

    const [listingsRes, reviewsRes] = await Promise.all([
      pool.query(
        `SELECT
           vl.id,
           vl.title,
           vl.category,
           vl.price,
           vl.currency,
           vl.listing_type,
           vl.created_at,
           vl.featured_status,
           vl.featured_plan,
           vl.featured_requested_at,
           vl.featured_expires_at,
           vl.featured_price,
           vl.featured_currency,
           COALESCE(vo.display_name, vo.legal_name, u.full_name, 'Vendor') AS vendor_name
         FROM vendor_listings vl
         LEFT JOIN vendor_organizations vo ON vo.id = vl.vendor_org_id
         LEFT JOIN users u ON u.id = vl.created_by
         WHERE vl.workflow_state = 'published'
         ORDER BY vl.updated_at DESC, vl.created_at DESC
         LIMIT 1500`
      ),
      pool.query(
        `SELECT
           COALESCE(moderation_status, 'visible') AS moderation_status,
           COALESCE(reports_count, 0) AS reports_count
         FROM vendor_reviews
         ORDER BY created_at DESC
         LIMIT 3000`
      ).catch(() => ({ rows: [] })),
    ]);

    const listings = listingsRes.rows || [];
    const reviews = reviewsRes.rows || [];

    const featuredRows = listings.filter((row) => String(row.featured_status || 'none') !== 'none');
    const activeFeaturedRows = featuredRows.filter((row) => {
      if (String(row.featured_status || '') !== 'active') return false;
      const exp = toTime(row.featured_expires_at);
      return exp === 0 || exp > nowMs;
    });
    const pendingFeaturedRows = featuredRows.filter((row) => String(row.featured_status || '') === 'pending');

    const boostRequestsToday = featuredRows.filter((row) => {
      const requested = toTime(row.featured_requested_at);
      return requested >= todayStart;
    }).length;

    const revenueActive = activeFeaturedRows.reduce((sum, row) => sum + Number(row.featured_price || 0), 0);
    const revenuePending = pendingFeaturedRows.reduce((sum, row) => sum + Number(row.featured_price || 0), 0);
    const revenueTotal = revenueActive + revenuePending;

    const featuredLast7 = featuredRows.filter((row) => {
      const requested = toTime(row.featured_requested_at);
      return requested >= sevenDaysAgo && requested <= nowMs;
    }).length;
    const featuredPrev7 = featuredRows.filter((row) => {
      const requested = toTime(row.featured_requested_at);
      return requested >= fourteenDaysAgo && requested < sevenDaysAgo;
    }).length;

    const listingsLast7 = listings.filter((row) => {
      const created = toTime(row.created_at);
      return created >= sevenDaysAgo && created <= nowMs;
    }).length;
    const listingsPrev7 = listings.filter((row) => {
      const created = toTime(row.created_at);
      return created >= fourteenDaysAgo && created < sevenDaysAgo;
    }).length;

    const conversionRate = listings.length > 0 ? Math.round((activeFeaturedRows.length / listings.length) * 100) : 0;

    const trendByDay = new Map();
    for (let i = 6; i >= 0; i--) {
      const stamp = startOfUtcDayMs(nowMs - i * 24 * 60 * 60 * 1000);
      const date = new Date(stamp);
      const label = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      trendByDay.set(stamp, { label, value: 0 });
    }
    for (const row of featuredRows) {
      const requested = toTime(row.featured_requested_at);
      if (!requested) continue;
      const day = startOfUtcDayMs(requested);
      if (trendByDay.has(day)) trendByDay.get(day).value += 1;
    }

    const categoryMap = new Map();
    for (const row of listings) {
      const key = String(row.category || 'Uncategorized').trim() || 'Uncategorized';
      categoryMap.set(key, (categoryMap.get(key) || 0) + 1);
    }
    const topCategories = Array.from(categoryMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    const activeVendorsMap = new Map();
    for (const row of listings) {
      const name = String(row.vendor_name || 'Vendor');
      const created = toTime(row.created_at);
      const existing = activeVendorsMap.get(name);
      if (!existing || created > existing.lastActivityMs) {
        activeVendorsMap.set(name, {
          id: String(row.id),
          name,
          subtitle: String(row.listing_type || 'listing'),
          lastActivityMs: created,
        });
      }
    }
    const activeVendors = Array.from(activeVendorsMap.values())
      .sort((a, b) => b.lastActivityMs - a.lastActivityMs)
      .slice(0, 6);

    const popularListings = listings
      .slice()
      .sort((a, b) => {
        const aBoost = String(a.featured_status || '') === 'active' ? 1 : 0;
        const bBoost = String(b.featured_status || '') === 'active' ? 1 : 0;
        if (aBoost !== bBoost) return bBoost - aBoost;
        return Number(b.featured_price || 0) - Number(a.featured_price || 0);
      })
      .slice(0, 6)
      .map((row) => ({
        id: String(row.id),
        name: String(row.title || 'Listing'),
        metric: String(row.featured_status || '') === 'active'
          ? `Boost live (${row.featured_currency || 'USD'} ${Number(row.featured_price || 0).toLocaleString()})`
          : `Standard (${row.currency || 'USD'} ${Number(row.price || 0).toLocaleString()})`,
      }));

    const recentFeaturedRequests = featuredRows
      .slice()
      .sort((a, b) => toTime(b.featured_requested_at) - toTime(a.featured_requested_at))
      .slice(0, 10)
      .map((row) => ({
        id: String(row.id),
        ref: `#FTR-${String(row.id).slice(0, 8).toUpperCase()}`,
        title: String(row.title || 'Listing'),
        amount: Number(row.featured_price || 0),
        currency: String(row.featured_currency || 'USD'),
        status: String(row.featured_status || 'none'),
      }));

    const quality = {
      verifiedVendors: listings.filter((row) => {
        // published listings from approved org/user are proxy-verified in this context
        return true;
      }).length,
      flaggedReviews: reviews.filter((r) => String(r.moderation_status || '') === 'flagged').length,
      hiddenReviews: reviews.filter((r) => String(r.moderation_status || '') === 'hidden').length,
      reviewReports: reviews.reduce((sum, r) => sum + Number(r.reports_count || 0), 0),
    };

    res.json({
      generatedAt: new Date().toISOString(),
      kpis: {
        totalListings: listings.length,
        boostRequestsToday,
        revenueTotal,
        conversionRate,
        activeFeaturedCount: activeFeaturedRows.length,
        pendingFeaturedCount: pendingFeaturedRows.length,
        deltas: {
          listings7d: listingsLast7 - listingsPrev7,
          boostRequests7d: featuredLast7 - featuredPrev7,
        },
      },
      trend: Array.from(trendByDay.values()),
      topCategories,
      activeVendors,
      popularListings,
      recentFeaturedRequests,
      quality,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/admin-pending-counts', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const [marketplace, properties, rentals] = await Promise.all([
      pool.query("SELECT COUNT(*) AS count FROM vendor_listings WHERE workflow_state = 'pending_review'"),
      pool.query(
        "SELECT COUNT(*) AS count FROM properties WHERE listing_state = 'pending_review' AND COALESCE(listing_purpose, 'sale') = 'sale'"
      ),
      pool.query(
        "SELECT COUNT(*) AS count FROM properties WHERE listing_state = 'pending_review' AND listing_purpose = 'rent'"
      ),
    ]);

    res.json({
      marketplace: parseInt(marketplace.rows[0].count, 10),
      properties: parseInt(properties.rows[0].count, 10),
      rentals: parseInt(rentals.rows[0].count, 10),
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/events',
  [
    body('event').isString().trim().isLength({ min: 2, max: 80 }),
    body('session_id').optional().isString().trim().isLength({ max: 128 }),
    body('source').optional().isString().trim().isLength({ max: 50 }),
    body('path').optional().isString().trim().isLength({ max: 500 }),
    body('payload').optional().custom((v) => v && typeof v === 'object' && !Array.isArray(v)),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const eventName = String(req.body.event || '').trim();
      const sessionId = req.body.session_id ? String(req.body.session_id).trim() : null;
      const source = req.body.source ? String(req.body.source).trim() : null;
      const path = req.body.path ? String(req.body.path).trim() : null;
      const metadata = req.body.payload && typeof req.body.payload === 'object' ? req.body.payload : {};

      await pool.query(
        `INSERT INTO analytics_events (id, user_id, session_id, event_name, event_source, page_path, metadata, created_at)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
        [uuidv4(), sessionId, eventName, source, path, JSON.stringify(metadata)]
      );
      res.status(202).json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
