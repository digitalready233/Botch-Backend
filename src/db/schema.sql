-- Botch Realty Diaspora Build Platform - PostgreSQL Schema
-- Run this to create all tables (or use migrations)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255),
  phone VARCHAR(50),
  country VARCHAR(100),
  role VARCHAR(20) CHECK (role IN ('client', 'buyer', 'vendor', 'vendor_admin', 'finance_admin', 'moderator', 'editor', 'admin', 'super_admin', 'agent')) DEFAULT 'client',
  verified BOOLEAN DEFAULT FALSE,
  two_fa_enabled BOOLEAN DEFAULT FALSE,
  two_fa_secret VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_status VARCHAR(30) CHECK (verification_status IN ('submitted', 'pending_review', 'approved', 'rejected')) DEFAULT 'submitted';
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_level VARCHAR(30) DEFAULT 'basic';
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_notes TEXT;
CREATE INDEX IF NOT EXISTS idx_users_verification_status ON users(verification_status, role);
CREATE INDEX IF NOT EXISTS idx_users_verified_at ON users(verified_at DESC);

-- Role-level permission overrides (RBAC toggles from admin settings)
CREATE TABLE IF NOT EXISTS role_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role VARCHAR(20) CHECK (role IN ('client', 'buyer', 'vendor', 'vendor_admin', 'finance_admin', 'moderator', 'editor', 'admin', 'super_admin', 'agent')) NOT NULL,
  permission_key VARCHAR(120) NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(role, permission_key)
);
CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role);

CREATE TABLE IF NOT EXISTS vendor_organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name VARCHAR(255) NOT NULL,
  display_name VARCHAR(255),
  registration_country VARCHAR(100),
  status VARCHAR(30) CHECK (status IN ('draft', 'pending_verification', 'approved', 'suspended')) DEFAULT 'pending_verification',
  is_partner BOOLEAN DEFAULT FALSE,
  vendor_source VARCHAR(30) DEFAULT 'self_service',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE vendor_organizations ADD COLUMN IF NOT EXISTS verification_status VARCHAR(30) CHECK (verification_status IN ('submitted', 'pending_review', 'approved', 'rejected')) DEFAULT 'submitted';
ALTER TABLE vendor_organizations ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE vendor_organizations ADD COLUMN IF NOT EXISTS verification_level VARCHAR(30) DEFAULT 'basic';
ALTER TABLE vendor_organizations ADD COLUMN IF NOT EXISTS verification_notes TEXT;
ALTER TABLE vendor_organizations ADD COLUMN IF NOT EXISTS cover_photo_url TEXT;
ALTER TABLE vendor_organizations ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE vendor_organizations ADD COLUMN IF NOT EXISTS module_marketplace_enabled BOOLEAN DEFAULT TRUE;
ALTER TABLE vendor_organizations ADD COLUMN IF NOT EXISTS module_properties_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE vendor_organizations ADD COLUMN IF NOT EXISTS module_rentals_enabled BOOLEAN DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS vendor_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_org_id UUID NOT NULL REFERENCES vendor_organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_role VARCHAR(20) CHECK (org_role IN ('owner', 'manager', 'member')) DEFAULT 'member',
  is_primary_contact BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (vendor_org_id, user_id)
);

CREATE TABLE IF NOT EXISTS vendor_onboarding_fees (
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
);

CREATE TABLE IF NOT EXISTS vendor_subscriptions (
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
);

CREATE TABLE IF NOT EXISTS vendor_billing_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_org_id UUID NOT NULL REFERENCES vendor_organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payment_type VARCHAR(30) CHECK (payment_type IN ('onboarding_fee', 'subscription', 'channel_subscription')) NOT NULL,
  target_id UUID,
  amount DECIMAL(12, 2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'USD',
  payment_method VARCHAR(20) CHECK (payment_method IN ('paystack', 'stripe')) NOT NULL,
  provider_reference VARCHAR(255),
  status VARCHAR(20) CHECK (status IN ('pending', 'completed', 'failed')) DEFAULT 'pending',
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vendor_channel_plans (
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
);

CREATE TABLE IF NOT EXISTS vendor_channel_subscriptions (
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
);

CREATE TABLE IF NOT EXISTS vendor_featured_plans (
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
);
CREATE INDEX IF NOT EXISTS idx_vendor_featured_plans_channel ON vendor_featured_plans(channel, sort_order);

CREATE TABLE IF NOT EXISTS vendor_listings (
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
  featured_status VARCHAR(20) CHECK (featured_status IN ('none', 'pending', 'active', 'rejected', 'expired')) DEFAULT 'none',
  featured_plan VARCHAR(20) CHECK (featured_plan IN ('3_days', '7_days', '14_days')),
  featured_duration_days INT,
  featured_requested_at TIMESTAMPTZ,
  featured_requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  featured_approved_at TIMESTAMPTZ,
  featured_approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  featured_expires_at TIMESTAMPTZ,
  featured_price DECIMAL(12, 2),
  featured_currency VARCHAR(10) DEFAULT 'USD',
  featured_rejection_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vendor_listings_featured_status ON vendor_listings(featured_status, featured_expires_at DESC);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  location VARCHAR(255),
  package_type VARCHAR(100),
  total_cost DECIMAL(12, 2),
  amount_paid DECIMAL(12, 2) DEFAULT 0,
  progress_percent INT DEFAULT 0,
  status VARCHAR(50) CHECK (status IN ('pending', 'active', 'completed', 'on_hold')) DEFAULT 'pending',
  start_date DATE,
  estimated_completion DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  live_stream_url TEXT,
  client_can_view_live_stream BOOLEAN DEFAULT FALSE,
  ivs_stream_key TEXT,
  ivs_ingest_url TEXT,
  ivs_playback_url TEXT,
  vendor_id UUID REFERENCES users(id) ON DELETE SET NULL
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS vendor_org_id UUID REFERENCES vendor_organizations(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_vendor_channel VARCHAR(30) CHECK (signup_vendor_channel IN ('marketplace', 'properties', 'rentals'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS vendor_org_id UUID REFERENCES vendor_organizations(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  progress_percent INT DEFAULT 0,
  amount DECIMAL(12, 2),
  is_paid BOOLEAN DEFAULT FALSE,
  order_index INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number VARCHAR(50) UNIQUE NOT NULL,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  client_id UUID REFERENCES users(id) ON DELETE CASCADE,
  milestone_id UUID REFERENCES milestones(id),
  amount DECIMAL(12, 2) NOT NULL,
  status VARCHAR(50) CHECK (status IN ('pending', 'paid', 'overdue')) DEFAULT 'pending',
  due_date DATE,
  pdf_url TEXT,
  viewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID REFERENCES invoices(id) ON DELETE CASCADE,
  client_id UUID REFERENCES users(id) ON DELETE CASCADE,
  amount DECIMAL(12, 2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'USD',
  payment_method VARCHAR(50),
  transaction_id VARCHAR(255),
  status VARCHAR(50) CHECK (status IN ('pending', 'completed', 'failed')) DEFAULT 'pending',
  receipt_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  uploaded_by UUID REFERENCES users(id),
  title VARCHAR(255),
  description TEXT,
  media_type VARCHAR(50) CHECK (media_type IN ('photo', 'video', 'drone')),
  file_url TEXT NOT NULL,
  file_size BIGINT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID REFERENCES users(id),
  recipient_id UUID REFERENCES users(id),
  project_id UUID REFERENCES projects(id),
  message_text TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50),
  title VARCHAR(255),
  message TEXT,
  is_read BOOLEAN DEFAULT FALSE,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_projects_client_id ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_invoices_project_id ON invoices(project_id);
CREATE INDEX IF NOT EXISTS idx_invoices_client_id ON invoices(client_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice_id ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_media_project_id ON media(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_project_id ON messages(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_recipient_id ON messages(recipient_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_vendor_org_status ON vendor_organizations(status);
CREATE INDEX IF NOT EXISTS idx_vendor_memberships_org ON vendor_memberships(vendor_org_id);
CREATE INDEX IF NOT EXISTS idx_vendor_memberships_user ON vendor_memberships(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_memberships_primary_contact
  ON vendor_memberships(vendor_org_id) WHERE is_primary_contact = TRUE;
CREATE INDEX IF NOT EXISTS idx_vendor_onboarding_fees_org ON vendor_onboarding_fees(vendor_org_id);
CREATE INDEX IF NOT EXISTS idx_vendor_onboarding_fees_status ON vendor_onboarding_fees(status);
CREATE INDEX IF NOT EXISTS idx_vendor_subscriptions_org ON vendor_subscriptions(vendor_org_id);
CREATE INDEX IF NOT EXISTS idx_vendor_subscriptions_status ON vendor_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_vendor_billing_payments_org ON vendor_billing_payments(vendor_org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_billing_payments_user ON vendor_billing_payments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_listings_org ON vendor_listings(vendor_org_id);
CREATE INDEX IF NOT EXISTS idx_vendor_listings_creator ON vendor_listings(created_by);
CREATE INDEX IF NOT EXISTS idx_vendor_listings_type ON vendor_listings(listing_type);
CREATE INDEX IF NOT EXISTS idx_vendor_listings_state ON vendor_listings(workflow_state);
CREATE INDEX IF NOT EXISTS idx_users_vendor_org_id ON users(vendor_org_id);
CREATE INDEX IF NOT EXISTS idx_projects_vendor_org_id ON projects(vendor_org_id);

-- Botch subcontractor agents: assigned by admin only; no vendor/client messaging in this flow.
CREATE TABLE IF NOT EXISTS project_agent_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('service', 'material')),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(40) NOT NULL DEFAULT 'assigned' CHECK (status IN (
    'assigned',
    'invoice_required',
    'invoice_submitted',
    'completion_submitted',
    'completion_approved',
    'receipts_required',
    'receipts_submitted',
    'closed',
    'cancelled'
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
);
CREATE INDEX IF NOT EXISTS idx_project_agent_assignments_agent ON project_agent_assignments(agent_id);
CREATE INDEX IF NOT EXISTS idx_project_agent_assignments_project ON project_agent_assignments(project_id);
CREATE INDEX IF NOT EXISTS idx_project_agent_assignments_status ON project_agent_assignments(status);

CREATE TABLE IF NOT EXISTS vendor_reviews (
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
);
CREATE INDEX IF NOT EXISTS idx_vendor_reviews_profile ON vendor_reviews(vendor_profile_id, vendor_profile_type);
CREATE INDEX IF NOT EXISTS idx_vendor_reviews_reviewer ON vendor_reviews(reviewer_user_id);
CREATE INDEX IF NOT EXISTS idx_vendor_reviews_moderation ON vendor_reviews(moderation_status, reports_count);

CREATE TABLE IF NOT EXISTS vendor_review_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL REFERENCES vendor_reviews(id) ON DELETE CASCADE,
  reporter_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (review_id, reporter_user_id)
);
CREATE INDEX IF NOT EXISTS idx_vendor_review_reports_review ON vendor_review_reports(review_id);

-- Scam / abuse reports (chat, listings, profiles) for trust & safety operations
CREATE TABLE IF NOT EXISTS fraud_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type VARCHAR(30) CHECK (target_type IN ('message', 'property', 'vendor_listing', 'vendor_profile', 'user')) NOT NULL,
  target_id UUID,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  details TEXT,
  risk_score INT DEFAULT 0,
  risk_level VARCHAR(20) CHECK (risk_level IN ('low', 'medium', 'high', 'critical')) DEFAULT 'medium',
  status VARCHAR(20) CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')) DEFAULT 'open',
  admin_note TEXT,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fraud_reports_status ON fraud_reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fraud_reports_risk ON fraud_reports(status, risk_score DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fraud_reports_target ON fraud_reports(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_fraud_reports_project ON fraud_reports(project_id, created_at DESC);

-- Message attachments (file sharing in chat)
CREATE TABLE IF NOT EXISTS message_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_url TEXT NOT NULL,
  file_name VARCHAR(255),
  file_type VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id ON message_attachments(message_id);

-- Message reactions (emoji reactions on messages)
CREATE TABLE IF NOT EXISTS message_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id ON message_reactions(message_id);

-- Pinned messages per project (conversation)
CREATE TABLE IF NOT EXISTS pinned_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_pinned_messages_project_id ON pinned_messages(project_id);

-- Project activity timeline (messages, media, milestones, payments, escalations)
-- Verified Construction Transparency: every update has uploader, timestamp, project; admins can mark verified
CREATE TABLE IF NOT EXISTS project_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  activity_type VARCHAR(50) NOT NULL,
  reference_id UUID,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  verified_at TIMESTAMPTZ,
  verified_by UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_project_activity_project_id ON project_activity(project_id);
CREATE INDEX IF NOT EXISTS idx_project_activity_created_at ON project_activity(project_id, created_at DESC);

-- Escalations (client/agent can flag conversation for admin attention)
CREATE TABLE IF NOT EXISTS escalations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  raised_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT,
  status VARCHAR(20) CHECK (status IN ('open', 'acknowledged', 'resolved')) DEFAULT 'open',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_escalations_project_id ON escalations(project_id);
CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status);

-- Property listings (admin-created; shown on landing + /properties)
CREATE TABLE IF NOT EXISTS properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  property_type VARCHAR(50) CHECK (property_type IN ('apartment', 'villa', 'house', 'cabin', 'treehouse', 'other')) DEFAULT 'apartment',
  bedrooms INT DEFAULT 0,
  bathrooms INT DEFAULT 1,
  location VARCHAR(255),
  area VARCHAR(255),
  price DECIMAL(12, 2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'USD',
  image_url TEXT,
  amenities TEXT,
  status VARCHAR(20) CHECK (status IN ('draft', 'published')) DEFAULT 'published',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_properties_property_type ON properties(property_type);
CREATE INDEX IF NOT EXISTS idx_properties_created_at ON properties(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_properties_status ON properties(status);

-- Multiple images per property (Airbnb-style gallery)
CREATE TABLE IF NOT EXISTS property_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  file_url TEXT NOT NULL,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_property_images_property_id ON property_images(property_id);

-- Featured placement payments: exactly one of marketplace listing or property row (sale/rent)
CREATE TABLE IF NOT EXISTS featured_listing_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES vendor_listings(id) ON DELETE CASCADE,
  property_id UUID REFERENCES properties(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan VARCHAR(20) CHECK (plan IN ('3_days', '7_days', '14_days')) NOT NULL,
  plan_id UUID REFERENCES vendor_featured_plans(id) ON DELETE SET NULL,
  plan_name VARCHAR(120),
  duration_days INT,
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
);
CREATE INDEX IF NOT EXISTS idx_featured_listing_payments_listing ON featured_listing_payments(listing_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_featured_listing_payments_property ON featured_listing_payments(property_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_featured_listing_payments_user ON featured_listing_payments(user_id, created_at DESC);

-- Flexible listing fields: keep one model for sales + rentals
ALTER TABLE properties ADD COLUMN IF NOT EXISTS slug VARCHAR(255) UNIQUE;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS listing_purpose VARCHAR(20) CHECK (listing_purpose IN ('sale', 'rent')) DEFAULT 'sale';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS rent_type VARCHAR(20) CHECK (rent_type IN ('short_stay', 'long_term'));
ALTER TABLE properties ADD COLUMN IF NOT EXISTS furnished_status VARCHAR(20) CHECK (furnished_status IN ('furnished', 'unfurnished', 'part_furnished'));
ALTER TABLE properties ADD COLUMN IF NOT EXISTS availability_status VARCHAR(20) CHECK (availability_status IN ('available', 'unavailable', 'booked')) DEFAULT 'available';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured BOOLEAN DEFAULT FALSE;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS is_new BOOLEAN DEFAULT FALSE;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS short_description TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS square_footage INT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS publish_status VARCHAR(20) CHECK (publish_status IN ('draft', 'published', 'unpublished')) DEFAULT 'published';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS region VARCHAR(120);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS city VARCHAR(120);
CREATE INDEX IF NOT EXISTS idx_properties_listing_purpose ON properties(listing_purpose);
CREATE INDEX IF NOT EXISTS idx_properties_featured ON properties(featured);
CREATE INDEX IF NOT EXISTS idx_properties_publish_status ON properties(publish_status);

-- Paid featured workflow for property/rental listings (mirrors vendor_listings)
ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured_status VARCHAR(20) CHECK (featured_status IN ('none', 'pending', 'active', 'rejected', 'expired')) DEFAULT 'none';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured_plan VARCHAR(20) CHECK (featured_plan IN ('3_days', '7_days', '14_days'));
ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured_duration_days INT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured_requested_at TIMESTAMPTZ;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured_requested_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured_approved_at TIMESTAMPTZ;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured_approved_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured_expires_at TIMESTAMPTZ;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured_price DECIMAL(12, 2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured_currency VARCHAR(10) DEFAULT 'USD';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured_rejection_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_properties_featured_status ON properties(featured_status, featured_expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_properties_slug ON properties(slug);

-- Admin moderation (draft workflow): only approved listings may be published to the public site
ALTER TABLE properties ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(20) CHECK (moderation_status IN ('pending', 'approved', 'rejected')) DEFAULT 'approved';
CREATE INDEX IF NOT EXISTS idx_properties_moderation ON properties(moderation_status);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS authenticity_status VARCHAR(20) CHECK (authenticity_status IN ('not_submitted', 'pending', 'approved', 'rejected')) DEFAULT 'not_submitted';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS ownership_proof_url TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS mandate_proof_url TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS authenticity_notes TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS authenticity_reviewed_at TIMESTAMPTZ;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS authenticity_reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_properties_authenticity_status ON properties(authenticity_status);

-- Canonical workflow (see listing-workflow.js); legacy columns above are synced from this.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS listing_state VARCHAR(30) CHECK (listing_state IN (
  'draft', 'pending_review', 'approved', 'published', 'paused', 'sold', 'rented', 'archived', 'rejected'
));
CREATE INDEX IF NOT EXISTS idx_properties_listing_state ON properties(listing_state);

-- Optional: listing-level agent for routing inquiries (falls back to vendor creator / pool)
ALTER TABLE properties ADD COLUMN IF NOT EXISTS listing_agent_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_properties_listing_agent ON properties(listing_agent_id);

-- User saved listings (favorites)
CREATE TABLE IF NOT EXISTS property_favorites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, property_id)
);
CREATE INDEX IF NOT EXISTS idx_property_favorites_user ON property_favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_property_favorites_property ON property_favorites(property_id);

-- Saved searches + alert preferences (consumer retention loop)
CREATE TABLE IF NOT EXISTS saved_searches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(140) NOT NULL,
  search_scope VARCHAR(30) CHECK (search_scope IN ('properties', 'rentals', 'marketplace', 'vendor_listings')) DEFAULT 'properties',
  filters_json JSONB NOT NULL,
  query_string TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  alert_frequency VARCHAR(20) CHECK (alert_frequency IN ('instant', 'daily', 'weekly')) DEFAULT 'instant',
  notify_email BOOLEAN DEFAULT TRUE,
  notify_push BOOLEAN DEFAULT FALSE,
  last_notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saved_searches_user ON saved_searches(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_searches_active ON saved_searches(is_active);
CREATE INDEX IF NOT EXISTS idx_saved_searches_frequency ON saved_searches(alert_frequency);

-- Product analytics event stream (for conversion funnel)
CREATE TABLE IF NOT EXISTS analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  session_id VARCHAR(128),
  event_name VARCHAR(80) NOT NULL,
  event_source VARCHAR(50),
  page_path TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_analytics_events_name_time ON analytics_events(event_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_user_time ON analytics_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session_time ON analytics_events(session_id, created_at DESC);

-- Listing inquiries (leads): property + marketplace participant (users.id) + assigned agent; pipeline statuses
CREATE TABLE IF NOT EXISTS listing_inquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT,
  lead_status VARCHAR(30) CHECK (lead_status IN (
    'new', 'contacted', 'interested', 'inspection_booked', 'negotiating', 'closed_won', 'closed_lost'
  )) DEFAULT 'new',
  assigned_to UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_inquiries_property_vendor ON listing_inquiries(property_id, vendor_id);
CREATE INDEX IF NOT EXISTS idx_listing_inquiries_property ON listing_inquiries(property_id);
CREATE INDEX IF NOT EXISTS idx_listing_inquiries_vendor ON listing_inquiries(vendor_id);
CREATE INDEX IF NOT EXISTS idx_listing_inquiries_lead_status ON listing_inquiries(lead_status);
CREATE INDEX IF NOT EXISTS idx_listing_inquiries_assigned_to ON listing_inquiries(assigned_to);

-- Purchase offers (sale listings)
CREATE TABLE IF NOT EXISTS listing_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount DECIMAL(12, 2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'USD',
  terms_note TEXT,
  status VARCHAR(30) CHECK (status IN ('submitted', 'under_review', 'accepted', 'rejected', 'withdrawn')) DEFAULT 'submitted',
  admin_note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_listing_offers_property ON listing_offers(property_id);
CREATE INDEX IF NOT EXISTS idx_listing_offers_vendor ON listing_offers(vendor_id);
CREATE INDEX IF NOT EXISTS idx_listing_offers_status ON listing_offers(status);

-- Rental applications (rent listings)
CREATE TABLE IF NOT EXISTS rental_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  move_in_date DATE,
  employment_note TEXT,
  notes TEXT,
  status VARCHAR(30) CHECK (status IN ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'withdrawn')) DEFAULT 'draft',
  admin_note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rental_applications_property ON rental_applications(property_id);
CREATE INDEX IF NOT EXISTS idx_rental_applications_vendor ON rental_applications(vendor_id);
CREATE INDEX IF NOT EXISTS idx_rental_applications_status ON rental_applications(status);

-- House plan marketplace
CREATE TABLE IF NOT EXISTS house_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(255) UNIQUE NOT NULL,
  title VARCHAR(255) NOT NULL,
  architect_name VARCHAR(255) NOT NULL,
  architect_bio TEXT,
  building_type VARCHAR(100),
  category VARCHAR(100),
  description TEXT,
  tags TEXT,
  price DECIMAL(12, 2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'USD',
  size_label VARCHAR(100),
  floors INT DEFAULT 1,
  bedrooms INT DEFAULT 0,
  bathrooms INT DEFAULT 0,
  square_meters DECIMAL(10, 2),
  square_feet DECIMAL(10, 2),
  cover_image_url TEXT,
  pdf_path TEXT,
  featured BOOLEAN DEFAULT FALSE,
  publish_status VARCHAR(20) CHECK (publish_status IN ('draft', 'published', 'unpublished')) DEFAULT 'draft',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  owner_architect_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE house_plans ADD COLUMN IF NOT EXISTS owner_architect_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_house_plans_slug ON house_plans(slug);
CREATE INDEX IF NOT EXISTS idx_house_plans_publish_status ON house_plans(publish_status);
CREATE INDEX IF NOT EXISTS idx_house_plans_featured ON house_plans(featured);
CREATE INDEX IF NOT EXISTS idx_house_plans_owner_architect ON house_plans(owner_architect_id);

CREATE TABLE IF NOT EXISTS house_plan_previews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  house_plan_id UUID NOT NULL REFERENCES house_plans(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_house_plan_previews_plan ON house_plan_previews(house_plan_id);

CREATE TABLE IF NOT EXISTS house_plan_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  house_plan_id UUID NOT NULL REFERENCES house_plans(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount DECIMAL(12, 2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'USD',
  provider VARCHAR(20) CHECK (provider IN ('stripe', 'paystack')),
  provider_reference VARCHAR(255),
  status VARCHAR(20) CHECK (status IN ('pending', 'paid', 'failed')) DEFAULT 'pending',
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_house_plan_purchases_user ON house_plan_purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_house_plan_purchases_plan ON house_plan_purchases(house_plan_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_house_plan_paid_unique ON house_plan_purchases(house_plan_id, user_id, status);

-- Single-use signed access links for house plan preview/download (replay protection)
CREATE TABLE IF NOT EXISTS house_plan_access_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  house_plan_id UUID NOT NULL REFERENCES house_plans(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action VARCHAR(20) CHECK (action IN ('preview', 'download')) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_house_plan_access_tokens_plan_user ON house_plan_access_tokens(house_plan_id, user_id);
CREATE INDEX IF NOT EXISTS idx_house_plan_access_tokens_expires ON house_plan_access_tokens(expires_at);

-- Appointments (client books viewing/meeting; admin confirms)
CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  property_id UUID REFERENCES properties(id) ON DELETE SET NULL,
  agent_id UUID REFERENCES users(id) ON DELETE SET NULL,
  title VARCHAR(500) NOT NULL,
  preferred_date DATE,
  preferred_time VARCHAR(100),
  scheduled_date DATE,
  scheduled_time VARCHAR(100),
  notes TEXT,
  reschedule_note TEXT,
  cancellation_reason TEXT,
  status VARCHAR(30) CHECK (status IN ('pending', 'confirmed', 'rescheduled', 'cancelled', 'completed')) DEFAULT 'pending',
  reminder_at TIMESTAMPTZ,
  reminder_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_appointments_client_id ON appointments(client_id);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
CREATE INDEX IF NOT EXISTS idx_appointments_property_id ON appointments(property_id);
CREATE INDEX IF NOT EXISTS idx_appointments_agent_id ON appointments(agent_id);

-- Site inspections (client requests, admin assigns inspector, inspector uploads report + photos)
CREATE TABLE IF NOT EXISTS site_inspections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(30) CHECK (status IN ('requested', 'assigned', 'scheduled', 'completed', 'cancelled')) DEFAULT 'requested',
  assigned_inspector_id UUID REFERENCES users(id) ON DELETE SET NULL,
  scheduled_at TIMESTAMPTZ,
  client_notes TEXT,
  admin_notes TEXT,
  report_text TEXT,
  report_file_url TEXT,
  reported_at TIMESTAMPTZ,
  reported_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_site_inspections_project_id ON site_inspections(project_id);
CREATE INDEX IF NOT EXISTS idx_site_inspections_assigned ON site_inspections(assigned_inspector_id);

CREATE TABLE IF NOT EXISTS inspection_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id UUID NOT NULL REFERENCES site_inspections(id) ON DELETE CASCADE,
  file_url TEXT NOT NULL,
  caption TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inspection_photos_inspection_id ON inspection_photos(inspection_id);

-- Project progress reports (weekly summaries: milestones, photos, financial)
CREATE TABLE IF NOT EXISTS project_progress_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  summary_text TEXT NOT NULL,
  milestones_completed JSONB,
  new_photos_count INT DEFAULT 0,
  financial_summary JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  email_sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_project_progress_reports_project_id ON project_progress_reports(project_id);

CREATE TABLE IF NOT EXISTS project_report_preferences (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  send_weekly_email BOOLEAN DEFAULT TRUE,
  PRIMARY KEY (project_id, user_id)
);

-- Client ratings per project (rated user may be marketplace vendor or field agent user id)
CREATE TABLE IF NOT EXISTS contractor_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_contractor_ratings_contractor_id ON contractor_ratings(contractor_id);
