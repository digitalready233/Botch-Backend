import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** True when the error indicates we're talking to SQLite (no PG extensions/syntax) */
function isSqliteError(err) {
  const msg = err && (err.message || '');
  return msg.includes('EXTENSION') || msg.includes('SQLITE_ERROR') || err.code === 'SQLITE_ERROR';
}

export async function migrate() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  let usedPgSchema = false;

  // Try PostgreSQL schema first; if it fails (e.g. SQLite), skip and run only universal steps
  try {
    const sql = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(sql);
    usedPgSchema = true;
  } catch (e) {
    if (isSqliteError(e)) {
      console.log('Database is SQLite; skipping PostgreSQL schema (tables already created at startup).');
    } else {
      throw e;
    }
  }

  // PostgreSQL-only: add columns and role constraint
  if (usedPgSchema) {
    try {
      const alterColumns = [
        { column: 'live_stream_url', type: 'TEXT' },
        { column: 'client_can_view_live_stream', type: 'BOOLEAN DEFAULT FALSE' },
        { column: 'ivs_stream_key', type: 'TEXT' },
        { column: 'ivs_ingest_url', type: 'TEXT' },
        { column: 'ivs_playback_url', type: 'TEXT' },
      ];
      for (const { column, type } of alterColumns) {
        try {
          await pool.query(
            `ALTER TABLE projects ADD COLUMN IF NOT EXISTS ${column} ${type}`
          );
        } catch (e) {
          if (e.code !== '42701') throw e;
        }
      }
      await pool.query(`ALTER TABLE vendor_organizations ADD COLUMN IF NOT EXISTS cover_photo_url TEXT`);
      await pool.query(`ALTER TABLE vendor_organizations ADD COLUMN IF NOT EXISTS logo_url TEXT`);
      await pool.query(`ALTER TABLE vendor_organizations ADD COLUMN IF NOT EXISTS module_marketplace_enabled BOOLEAN`);
      await pool.query(`ALTER TABLE vendor_organizations ADD COLUMN IF NOT EXISTS module_properties_enabled BOOLEAN`);
      await pool.query(`ALTER TABLE vendor_organizations ADD COLUMN IF NOT EXISTS module_rentals_enabled BOOLEAN`);
      await pool.query(`
        UPDATE vendor_organizations
        SET module_marketplace_enabled = COALESCE(module_marketplace_enabled, TRUE),
            module_properties_enabled = COALESCE(module_properties_enabled, TRUE),
            module_rentals_enabled = COALESCE(module_rentals_enabled, TRUE)
        WHERE module_marketplace_enabled IS NULL
           OR module_properties_enabled IS NULL
           OR module_rentals_enabled IS NULL
      `);
      await pool.query(`ALTER TABLE vendor_organizations ALTER COLUMN module_marketplace_enabled SET DEFAULT TRUE`);
      await pool.query(`ALTER TABLE vendor_organizations ALTER COLUMN module_properties_enabled SET DEFAULT FALSE`);
      await pool.query(`ALTER TABLE vendor_organizations ALTER COLUMN module_rentals_enabled SET DEFAULT FALSE`);
      await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;`);
      await pool.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('client', 'buyer', 'vendor', 'vendor_admin', 'finance_admin', 'moderator', 'editor', 'admin', 'super_admin', 'agent'));`);
      await pool.query(
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_vendor_channel VARCHAR(30) CHECK (signup_vendor_channel IN ('marketplace', 'properties', 'rentals'))`
      );
      // Messaging UX: ensure new tables exist (for DBs created before these were added to schema.sql)
      await pool.query(`CREATE TABLE IF NOT EXISTS message_reactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        emoji VARCHAR(32) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(message_id, user_id, emoji)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS pinned_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        pinned_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(project_id, message_id)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS project_activity (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        activity_type VARCHAR(50) NOT NULL,
        reference_id UUID,
        actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
        details JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS escalations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
        raised_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason TEXT,
        status VARCHAR(20) CHECK (status IN ('open', 'acknowledged', 'resolved')) DEFAULT 'open',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        resolved_by UUID REFERENCES users(id) ON DELETE SET NULL
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS vendor_organizations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        legal_name VARCHAR(255) NOT NULL,
        display_name VARCHAR(255),
        registration_country VARCHAR(100),
        status VARCHAR(30) CHECK (status IN ('draft', 'pending_verification', 'approved', 'suspended')) DEFAULT 'pending_verification',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS vendor_memberships (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        vendor_org_id UUID NOT NULL REFERENCES vendor_organizations(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        org_role VARCHAR(20) CHECK (org_role IN ('owner', 'manager', 'member')) DEFAULT 'member',
        is_primary_contact BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (vendor_org_id, user_id)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS vendor_onboarding_fees (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        vendor_org_id UUID NOT NULL REFERENCES vendor_organizations(id) ON DELETE CASCADE,
        amount DECIMAL(12, 2) NOT NULL,
        currency VARCHAR(10) DEFAULT 'USD',
        provider VARCHAR(30),
        provider_reference VARCHAR(255),
        status VARCHAR(20) CHECK (status IN ('pending', 'paid', 'failed', 'refunded')) DEFAULT 'pending',
        paid_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS vendor_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        vendor_org_id UUID NOT NULL REFERENCES vendor_organizations(id) ON DELETE CASCADE,
        plan_code VARCHAR(100),
        amount DECIMAL(12, 2),
        currency VARCHAR(10) DEFAULT 'USD',
        interval VARCHAR(20) CHECK (interval IN ('monthly', 'yearly')),
        provider VARCHAR(30),
        provider_subscription_id VARCHAR(255),
        status VARCHAR(20) CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'expired')) DEFAULT 'trialing',
        current_period_start TIMESTAMPTZ,
        current_period_end TIMESTAMPTZ,
        canceled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS vendor_billing_payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        vendor_org_id UUID NOT NULL REFERENCES vendor_organizations(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        payment_type VARCHAR(30) CHECK (payment_type IN ('onboarding_fee', 'subscription')) NOT NULL,
        target_id UUID,
        amount DECIMAL(12, 2) NOT NULL,
        currency VARCHAR(10) DEFAULT 'USD',
        payment_method VARCHAR(20) CHECK (payment_method IN ('paystack', 'stripe')) NOT NULL,
        provider_reference VARCHAR(255),
        status VARCHAR(20) CHECK (status IN ('pending', 'completed', 'failed')) DEFAULT 'pending',
        paid_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS vendor_listings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        vendor_org_id UUID REFERENCES vendor_organizations(id) ON DELETE SET NULL,
        created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        listing_type VARCHAR(20) CHECK (listing_type IN ('material', 'service')) NOT NULL,
        category VARCHAR(120),
        title VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(12, 2),
        currency VARCHAR(10) DEFAULT 'USD',
        location VARCHAR(255),
        media_url TEXT,
        metadata JSONB,
        workflow_state VARCHAR(20) CHECK (workflow_state IN ('draft', 'pending_review', 'approved', 'rejected', 'published', 'unpublished')) DEFAULT 'draft',
        submitted_at TIMESTAMPTZ,
        approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
        approved_at TIMESTAMPTZ,
        rejection_reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS vendor_reviews (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        vendor_profile_id UUID NOT NULL,
        vendor_profile_type VARCHAR(20) CHECK (vendor_profile_type IN ('organization', 'user')) NOT NULL,
        reviewer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
        comment TEXT,
        moderation_status VARCHAR(20) CHECK (moderation_status IN ('visible', 'flagged', 'hidden')) DEFAULT 'visible',
        moderation_reason TEXT,
        moderated_by UUID REFERENCES users(id) ON DELETE SET NULL,
        moderated_at TIMESTAMPTZ,
        reports_count INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (vendor_profile_id, vendor_profile_type, reviewer_user_id)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS vendor_review_reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        review_id UUID NOT NULL REFERENCES vendor_reviews(id) ON DELETE CASCADE,
        reporter_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (review_id, reporter_user_id)
      )`);
      await pool.query("ALTER TABLE vendor_reviews ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(20) CHECK (moderation_status IN ('visible', 'flagged', 'hidden')) DEFAULT 'visible'");
      await pool.query('ALTER TABLE vendor_reviews ADD COLUMN IF NOT EXISTS moderation_reason TEXT');
      await pool.query('ALTER TABLE vendor_reviews ADD COLUMN IF NOT EXISTS moderated_by UUID REFERENCES users(id) ON DELETE SET NULL');
      await pool.query('ALTER TABLE vendor_reviews ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ');
      await pool.query('ALTER TABLE vendor_reviews ADD COLUMN IF NOT EXISTS reports_count INT DEFAULT 0');
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS vendor_org_id UUID REFERENCES vendor_organizations(id) ON DELETE SET NULL');
      await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS vendor_org_id UUID REFERENCES vendor_organizations(id) ON DELETE SET NULL');
      await pool.query("ALTER TABLE saved_searches ADD COLUMN IF NOT EXISTS alert_frequency VARCHAR(20) CHECK (alert_frequency IN ('instant', 'daily', 'weekly')) DEFAULT 'instant'");
      await pool.query("ALTER TABLE vendor_listings ADD COLUMN IF NOT EXISTS featured_status VARCHAR(20) CHECK (featured_status IN ('none', 'pending', 'active', 'rejected', 'expired')) DEFAULT 'none'");
      await pool.query("ALTER TABLE vendor_listings ADD COLUMN IF NOT EXISTS featured_plan VARCHAR(20) CHECK (featured_plan IN ('3_days', '7_days', '14_days'))");
      await pool.query('ALTER TABLE vendor_listings ADD COLUMN IF NOT EXISTS featured_requested_at TIMESTAMPTZ');
      await pool.query('ALTER TABLE vendor_listings ADD COLUMN IF NOT EXISTS featured_requested_by UUID REFERENCES users(id) ON DELETE SET NULL');
      await pool.query('ALTER TABLE vendor_listings ADD COLUMN IF NOT EXISTS featured_approved_at TIMESTAMPTZ');
      await pool.query('ALTER TABLE vendor_listings ADD COLUMN IF NOT EXISTS featured_approved_by UUID REFERENCES users(id) ON DELETE SET NULL');
      await pool.query('ALTER TABLE vendor_listings ADD COLUMN IF NOT EXISTS featured_expires_at TIMESTAMPTZ');
      await pool.query('ALTER TABLE vendor_listings ADD COLUMN IF NOT EXISTS featured_price DECIMAL(12, 2)');
      await pool.query("ALTER TABLE vendor_listings ADD COLUMN IF NOT EXISTS featured_currency VARCHAR(10) DEFAULT 'USD'");
      await pool.query('ALTER TABLE vendor_listings ADD COLUMN IF NOT EXISTS featured_rejection_reason TEXT');
      await pool.query(`CREATE TABLE IF NOT EXISTS role_permissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        role VARCHAR(20) CHECK (role IN ('client', 'buyer', 'vendor', 'vendor_admin', 'finance_admin', 'moderator', 'editor', 'admin', 'super_admin')) NOT NULL,
        permission_key VARCHAR(120) NOT NULL,
        is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(role, permission_key)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS featured_listing_payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        listing_id UUID REFERENCES vendor_listings(id) ON DELETE CASCADE,
        property_id UUID REFERENCES properties(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan VARCHAR(20) CHECK (plan IN ('3_days', '7_days', '14_days')) NOT NULL,
        amount DECIMAL(12, 2) NOT NULL,
        currency VARCHAR(10) DEFAULT 'USD',
        payment_method VARCHAR(20) CHECK (payment_method IN ('paystack', 'stripe')) NOT NULL,
        provider_reference VARCHAR(255),
        status VARCHAR(20) CHECK (status IN ('pending', 'completed', 'failed')) DEFAULT 'pending',
        paid_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT featured_listing_payments_target_chk CHECK (
          (listing_id IS NOT NULL AND property_id IS NULL)
          OR (listing_id IS NULL AND property_id IS NOT NULL)
        )
      )`);
      try {
        await pool.query(
          `ALTER TABLE featured_listing_payments ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES properties(id) ON DELETE CASCADE`
        );
        await pool.query(`ALTER TABLE featured_listing_payments ALTER COLUMN listing_id DROP NOT NULL`);
        await pool.query(`ALTER TABLE featured_listing_payments DROP CONSTRAINT IF EXISTS featured_listing_payments_target_chk`);
        await pool.query(`ALTER TABLE featured_listing_payments ADD CONSTRAINT featured_listing_payments_target_chk CHECK (
          (listing_id IS NOT NULL AND property_id IS NULL) OR (listing_id IS NULL AND property_id IS NOT NULL)
        )`);
      } catch (e) {
        if (e.code !== '42701' && e.code !== '42P16' && e.code !== '23514') throw e;
      }
      await pool.query("ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured_status VARCHAR(20) CHECK (featured_status IN ('none', 'pending', 'active', 'rejected', 'expired')) DEFAULT 'none'");
      await pool.query("ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured_plan VARCHAR(20) CHECK (featured_plan IN ('3_days', '7_days', '14_days'))");
      await pool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured_requested_at TIMESTAMPTZ');
      await pool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured_requested_by UUID REFERENCES users(id) ON DELETE SET NULL');
      await pool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured_approved_at TIMESTAMPTZ');
      await pool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured_approved_by UUID REFERENCES users(id) ON DELETE SET NULL');
      await pool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured_expires_at TIMESTAMPTZ');
      await pool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured_price DECIMAL(12, 2)');
      await pool.query("ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured_currency VARCHAR(10) DEFAULT 'USD'");
      await pool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured_rejection_reason TEXT');
      await pool.query(`CREATE TABLE IF NOT EXISTS analytics_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        session_id VARCHAR(128),
        event_name VARCHAR(80) NOT NULL,
        event_source VARCHAR(50),
        page_path TEXT,
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      try {
        await pool.query('CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id ON message_reactions(message_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_pinned_messages_project_id ON pinned_messages(project_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_project_activity_project_id ON project_activity(project_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_project_activity_created_at ON project_activity(project_id, created_at DESC)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_escalations_project_id ON escalations(project_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_org_status ON vendor_organizations(status)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_memberships_org ON vendor_memberships(vendor_org_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_memberships_user ON vendor_memberships(user_id)');
        await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_memberships_primary_contact ON vendor_memberships(vendor_org_id) WHERE is_primary_contact = TRUE');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_onboarding_fees_org ON vendor_onboarding_fees(vendor_org_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_onboarding_fees_status ON vendor_onboarding_fees(status)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_subscriptions_org ON vendor_subscriptions(vendor_org_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_subscriptions_status ON vendor_subscriptions(status)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_billing_payments_org ON vendor_billing_payments(vendor_org_id, created_at DESC)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_billing_payments_user ON vendor_billing_payments(user_id, created_at DESC)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_listings_org ON vendor_listings(vendor_org_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_listings_creator ON vendor_listings(created_by)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_listings_type ON vendor_listings(listing_type)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_listings_state ON vendor_listings(workflow_state)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_reviews_profile ON vendor_reviews(vendor_profile_id, vendor_profile_type)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_reviews_reviewer ON vendor_reviews(reviewer_user_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_reviews_moderation ON vendor_reviews(moderation_status, reports_count)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_review_reports_review ON vendor_review_reports(review_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_users_vendor_org_id ON users(vendor_org_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_projects_vendor_org_id ON projects(vendor_org_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_saved_searches_frequency ON saved_searches(alert_frequency)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_listings_featured_status ON vendor_listings(featured_status, featured_expires_at DESC)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_featured_listing_payments_listing ON featured_listing_payments(listing_id, created_at DESC)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_featured_listing_payments_property ON featured_listing_payments(property_id, created_at DESC)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_featured_listing_payments_user ON featured_listing_payments(user_id, created_at DESC)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_properties_featured_status ON properties(featured_status, featured_expires_at DESC)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_analytics_events_name_time ON analytics_events(event_name, created_at DESC)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_analytics_events_user_time ON analytics_events(user_id, created_at DESC)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_analytics_events_session_time ON analytics_events(session_id, created_at DESC)');
        try {
          await pool.query('ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_role_check');
        } catch (e) {
          if (e.code !== '42704' && e.code !== '42P01') throw e;
        }
        try {
          await pool.query(
            `ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_role_check CHECK (role IN ('client', 'buyer', 'vendor', 'vendor_admin', 'finance_admin', 'moderator', 'editor', 'admin', 'super_admin', 'agent'))`
          );
        } catch (e) {
          if (e.code !== '42P01' && e.code !== '42710') throw e;
        }
      } catch (_) {}
    } catch (e) {
      if (e.code !== '42701' && e.code !== '42P16') throw e;
    }
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS project_agent_assignments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
        kind VARCHAR(20) NOT NULL CHECK (kind IN ('service', 'material')),
        title VARCHAR(255) NOT NULL,
        description TEXT,
        status VARCHAR(40) NOT NULL DEFAULT 'assigned' CHECK (status IN (
          'assigned', 'invoice_required', 'invoice_submitted', 'completion_submitted', 'completion_approved',
          'receipts_required', 'receipts_submitted', 'closed', 'cancelled'
        )),
        invoice_request_note TEXT,
        invoice_requested_at TIMESTAMPTZ,
        invoice_document_url TEXT,
        invoice_note TEXT,
        invoice_submitted_at TIMESTAMPTZ,
        completion_note TEXT,
        completion_document_url TEXT,
        completion_submitted_at TIMESTAMPTZ,
        completion_rejection_note TEXT,
        completion_approved_at TIMESTAMPTZ,
        completion_approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
        receipts_request_note TEXT,
        receipts_requested_at TIMESTAMPTZ,
        receipt_document_url TEXT,
        receipts_submitted_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        closed_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_project_agent_assignments_agent ON project_agent_assignments(agent_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_project_agent_assignments_project ON project_agent_assignments(project_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_project_agent_assignments_status ON project_agent_assignments(status)');
    } catch (_) {}
  }

  if (!usedPgSchema) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS project_agent_assignments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (kind IN ('service', 'material')),
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN (
          'assigned', 'invoice_required', 'invoice_submitted', 'completion_submitted', 'completion_approved',
          'receipts_required', 'receipts_submitted', 'closed', 'cancelled'
        )),
        invoice_request_note TEXT,
        invoice_requested_at DATETIME,
        invoice_document_url TEXT,
        invoice_note TEXT,
        invoice_submitted_at DATETIME,
        completion_note TEXT,
        completion_document_url TEXT,
        completion_submitted_at DATETIME,
        completion_rejection_note TEXT,
        completion_approved_at DATETIME,
        completion_approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        receipts_request_note TEXT,
        receipts_requested_at DATETIME,
        receipt_document_url TEXT,
        receipts_submitted_at DATETIME,
        closed_at DATETIME,
        closed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_project_agent_assignments_agent ON project_agent_assignments(agent_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_project_agent_assignments_project ON project_agent_assignments(project_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_project_agent_assignments_status ON project_agent_assignments(status)');
    } catch (_) {}
  }

  // Marketplace leads: client_id -> vendor_id (users.id; one inquiry per property + participant)
  if (usedPgSchema) {
    try {
      const renameIfNeeded = async (table) => {
        const { rows } = await pool.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1 AND column_name IN ('client_id', 'vendor_id')`,
          [table]
        );
        const names = rows.map((r) => r.column_name);
        if (names.includes('client_id') && !names.includes('vendor_id')) {
          await pool.query(`ALTER TABLE ${table} RENAME COLUMN client_id TO vendor_id`);
        }
      };
      await renameIfNeeded('listing_inquiries');
      await renameIfNeeded('listing_offers');
      await renameIfNeeded('rental_applications');
      await pool.query('DROP INDEX IF EXISTS idx_listing_inquiries_client');
      await pool.query('DROP INDEX IF EXISTS idx_listing_offers_client');
      await pool.query('DROP INDEX IF EXISTS idx_rental_applications_client');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_listing_inquiries_vendor ON listing_inquiries(vendor_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_listing_offers_vendor ON listing_offers(vendor_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_rental_applications_vendor ON rental_applications(vendor_id)');
      await pool.query(`
        DELETE FROM listing_inquiries a
        WHERE EXISTS (
          SELECT 1 FROM listing_inquiries b
          WHERE b.property_id = a.property_id
            AND b.vendor_id = a.vendor_id
            AND b.created_at > a.created_at
        )
      `);
      await pool.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_inquiries_property_vendor ON listing_inquiries(property_id, vendor_id)'
      );
    } catch (e) {
      if (e.code !== '42P07' && e.code !== '23505' && e.code !== '42703') {
        console.warn('[migrate] marketplace vendor_id migration:', e.message);
      }
    }
  }

  // Channel posting plans & subscriptions
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS vendor_channel_plans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel VARCHAR(20) NOT NULL CHECK (channel IN ('properties', 'rentals')),
      name VARCHAR(120) NOT NULL,
      duration_months INT NOT NULL,
      amount DECIMAL(12, 2) NOT NULL,
      currency VARCHAR(10) DEFAULT 'USD',
      compare_at_amount DECIMAL(12, 2),
      discount_percent INT,
      perks JSONB DEFAULT '[]'::jsonb,
      sort_order INT DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS vendor_channel_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      vendor_org_id UUID NOT NULL REFERENCES vendor_organizations(id) ON DELETE CASCADE,
      channel VARCHAR(20) NOT NULL CHECK (channel IN ('properties', 'rentals')),
      plan_id UUID REFERENCES vendor_channel_plans(id) ON DELETE SET NULL,
      plan_name VARCHAR(120),
      duration_months INT NOT NULL,
      amount DECIMAL(12, 2) NOT NULL,
      currency VARCHAR(10) DEFAULT 'USD',
      provider VARCHAR(30),
      provider_reference VARCHAR(255),
      status VARCHAR(20) CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'expired')) DEFAULT 'past_due',
      current_period_start TIMESTAMPTZ,
      current_period_end TIMESTAMPTZ,
      canceled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_channel_plans_channel ON vendor_channel_plans(channel, sort_order)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_channel_subs_org ON vendor_channel_subscriptions(vendor_org_id, channel)');
    if (usedPgSchema) {
      await pool.query('ALTER TABLE vendor_billing_payments DROP CONSTRAINT IF EXISTS vendor_billing_payments_payment_type_check');
      await pool.query(`ALTER TABLE vendor_billing_payments ADD CONSTRAINT vendor_billing_payments_payment_type_check
        CHECK (payment_type IN ('onboarding_fee', 'subscription', 'channel_subscription'))`);
    }
  } catch (e) {
    if (!isSqliteError(e)) console.warn('[migrate] vendor channel subscriptions:', e.message);
  }

  if (!usedPgSchema) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS vendor_channel_plans (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL CHECK (channel IN ('properties', 'rentals')),
        name TEXT NOT NULL,
        duration_months INTEGER NOT NULL,
        amount REAL NOT NULL,
        currency TEXT DEFAULT 'USD',
        compare_at_amount REAL,
        discount_percent INTEGER,
        perks TEXT DEFAULT '[]',
        sort_order INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS vendor_channel_subscriptions (
        id TEXT PRIMARY KEY,
        vendor_org_id TEXT NOT NULL REFERENCES vendor_organizations(id) ON DELETE CASCADE,
        channel TEXT NOT NULL CHECK (channel IN ('properties', 'rentals')),
        plan_id TEXT REFERENCES vendor_channel_plans(id) ON DELETE SET NULL,
        plan_name TEXT,
        duration_months INTEGER NOT NULL,
        amount REAL NOT NULL,
        currency TEXT DEFAULT 'USD',
        provider TEXT,
        provider_reference TEXT,
        status TEXT CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'expired')) DEFAULT 'past_due',
        current_period_start DATETIME,
        current_period_end DATETIME,
        canceled_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_channel_plans_channel ON vendor_channel_plans(channel, sort_order)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_channel_subs_org ON vendor_channel_subscriptions(vendor_org_id, channel)');
    } catch (e) {
      console.warn('[migrate] sqlite vendor channel tables:', e.message);
    }
  }

  // Partner org flag + onboarding source (self_service vs admin_partner)
  try {
    await pool.query(`ALTER TABLE vendor_organizations ADD COLUMN IF NOT EXISTS is_partner BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE vendor_organizations ADD COLUMN IF NOT EXISTS vendor_source VARCHAR(30) DEFAULT 'self_service'`);
    await pool.query(`UPDATE vendor_organizations SET vendor_source = 'self_service' WHERE vendor_source IS NULL`);
  } catch (e) {
    if (!isSqliteError(e)) console.warn('[migrate] vendor org partner/source:', e.message);
  }

  if (!usedPgSchema) {
    try {
      try { await pool.query('ALTER TABLE vendor_organizations ADD COLUMN is_partner INTEGER DEFAULT 0'); } catch (_) {}
      try { await pool.query("ALTER TABLE vendor_organizations ADD COLUMN vendor_source TEXT DEFAULT 'self_service'"); } catch (_) {}
      await pool.query(`UPDATE vendor_organizations SET vendor_source = 'self_service' WHERE vendor_source IS NULL`);
    } catch (e) {
      console.warn('[migrate] sqlite vendor org partner/source:', e.message);
    }
  }

  // Featured boost plans (admin catalog)
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS vendor_featured_plans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel VARCHAR(20) NOT NULL CHECK (channel IN ('properties', 'rentals', 'marketplace')),
      name VARCHAR(120) NOT NULL,
      duration_days INT NOT NULL,
      amount DECIMAL(12, 2) NOT NULL,
      currency VARCHAR(10) DEFAULT 'USD',
      compare_at_amount DECIMAL(12, 2),
      discount_percent INT,
      perks JSONB DEFAULT '[]'::jsonb,
      sort_order INT DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_featured_plans_channel ON vendor_featured_plans(channel, sort_order)');
    await pool.query('ALTER TABLE featured_listing_payments ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES vendor_featured_plans(id) ON DELETE SET NULL');
    await pool.query('ALTER TABLE featured_listing_payments ADD COLUMN IF NOT EXISTS plan_name VARCHAR(120)');
    await pool.query('ALTER TABLE featured_listing_payments ADD COLUMN IF NOT EXISTS duration_days INT');
    await pool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured_duration_days INT');
    await pool.query('ALTER TABLE vendor_listings ADD COLUMN IF NOT EXISTS featured_duration_days INT');
  } catch (e) {
    if (!isSqliteError(e)) console.warn('[migrate] vendor featured plans:', e.message);
  }

  if (!usedPgSchema) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS vendor_featured_plans (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL CHECK (channel IN ('properties', 'rentals', 'marketplace')),
        name TEXT NOT NULL,
        duration_days INTEGER NOT NULL,
        amount REAL NOT NULL,
        currency TEXT DEFAULT 'USD',
        compare_at_amount REAL,
        discount_percent INTEGER,
        perks TEXT DEFAULT '[]',
        sort_order INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_vendor_featured_plans_channel ON vendor_featured_plans(channel, sort_order)');
      try { await pool.query('ALTER TABLE featured_listing_payments ADD COLUMN plan_id TEXT REFERENCES vendor_featured_plans(id) ON DELETE SET NULL'); } catch (_) {}
      try { await pool.query('ALTER TABLE featured_listing_payments ADD COLUMN plan_name TEXT'); } catch (_) {}
      try { await pool.query('ALTER TABLE featured_listing_payments ADD COLUMN duration_days INTEGER'); } catch (_) {}
      try { await pool.query('ALTER TABLE properties ADD COLUMN featured_duration_days INTEGER'); } catch (_) {}
      try { await pool.query('ALTER TABLE vendor_listings ADD COLUMN featured_duration_days INTEGER'); } catch (_) {}
    } catch (e) {
      console.warn('[migrate] sqlite vendor featured plans:', e.message);
    }
  }

  // Profile image on users (property/rental/listing vendor branding fallbacks)
  try {
    await pool.query('ALTER TABLE users ADD COLUMN avatar_url TEXT');
  } catch (e) {
    if (!isSqliteError(e) && e.code !== '42701') console.warn('[migrate] users.avatar_url:', e.message);
  }

  console.log('Database schema applied successfully.');

  // Both: ensure at least one super_admin exists
  try {
    const { rows: superRows } = await pool.query("SELECT id FROM users WHERE role = 'super_admin' LIMIT 1");
    if (superRows.length === 0) {
      const { rows: admins } = await pool.query("SELECT id, email FROM users WHERE role = 'admin' ORDER BY email LIMIT 1");
      if (admins.length > 0) {
        await pool.query("UPDATE users SET role = 'super_admin' WHERE id = $1", [admins[0].id]);
        console.log('Upgraded', admins[0].email || admins[0].id, 'to super_admin.');
      } else {
        await pool.query(
          "UPDATE users SET role = 'super_admin' WHERE role = 'admin' AND email = 'admin@botchrealties.com'"
        );
      }
    }
  } catch (_) {}

  // Both: ensure 2-Bed Cantonments has image (LIKE works in PostgreSQL and SQLite)
  try {
    await pool.query(
      `UPDATE properties SET image_url = $1 WHERE (image_url IS NULL OR image_url = '') AND title LIKE '%2-Bed%' AND title LIKE '%Cantonments%'`,
      ['https://images.unsplash.com/photo-1512917774080-9991f1c4c750?w=800&q=85']
    );
  } catch (_) {}
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
