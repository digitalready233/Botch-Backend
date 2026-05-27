-- Botch — Hostinger phpMyAdmin schema
-- How to run:
--   1. In hPanel → Databases → phpMyAdmin, click your database name on the left.
--   2. Open the SQL tab.
--   3. Import this file, OR paste and click Go.
--   4. If import fails, run one numbered block at a time until you find the error.
--   5. Then run seed: src/db/seed.mysql.sql (same SQL tab or Import).
--
-- Generated from schema.mysql.sql by scripts/generate-schema-mysql-phpmyadmin.mjs

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- [1/191] CREATE TABLE IF NOT EXISTS users ( id CHAR(36) PRIMARY KEY , email VARCH…
CREATE TABLE IF NOT EXISTS users ( id CHAR(36) PRIMARY KEY , email VARCHAR(255) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL, full_name VARCHAR(255), phone VARCHAR(50), country VARCHAR(100), `role` VARCHAR(20) DEFAULT 'client' CHECK (`role` IN ('client', 'buyer', 'vendor', 'vendor_admin', 'finance_admin', 'moderator', 'editor', 'admin', 'super_admin', 'agent')), verified TINYINT(1) DEFAULT 0, two_fa_enabled TINYINT(1) DEFAULT 0, two_fa_secret VARCHAR(255), created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), verification_status VARCHAR(30) DEFAULT 'submitted' CHECK (verification_status IN ('submitted', 'pending_review', 'approved', 'rejected')), verified_at DATETIME(3), verification_level VARCHAR(30) DEFAULT 'basic', verification_notes TEXT );

-- [2/191] CREATE INDEX IF NOT EXISTS idx_users_verification_status ON users(verifi…
CREATE INDEX IF NOT EXISTS idx_users_verification_status ON users(verification_status, `role`);

-- [3/191] CREATE INDEX IF NOT EXISTS idx_users_verified_at ON users(verified_at DE…
CREATE INDEX IF NOT EXISTS idx_users_verified_at ON users(verified_at DESC);

-- [4/191] CREATE TABLE IF NOT EXISTS role_permissions ( id CHAR(36) PRIMARY KEY , …
CREATE TABLE IF NOT EXISTS role_permissions ( id CHAR(36) PRIMARY KEY , `role` VARCHAR(20) NOT NULL CHECK (`role` IN ('client', 'buyer', 'vendor', 'vendor_admin', 'finance_admin', 'moderator', 'editor', 'admin', 'super_admin', 'agent')), permission_key VARCHAR(120) NOT NULL, is_enabled TINYINT(1) NOT NULL DEFAULT 1, updated_by CHAR(36) REFERENCES users(id) ON DELETE SET NULL, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), UNIQUE(`role`, permission_key) );

-- [5/191] CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions…
CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(`role`);

-- [6/191] CREATE TABLE IF NOT EXISTS vendor_organizations ( id CHAR(36) PRIMARY KE…
CREATE TABLE IF NOT EXISTS vendor_organizations ( id CHAR(36) PRIMARY KEY , legal_name VARCHAR(255) NOT NULL, display_name VARCHAR(255), registration_country VARCHAR(100), status VARCHAR(30) DEFAULT 'pending_verification' CHECK (status IN ('draft', 'pending_verification', 'approved', 'suspended')), is_partner TINYINT(1) DEFAULT 0, vendor_source VARCHAR(30) DEFAULT 'self_service', created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), verification_status VARCHAR(30) DEFAULT 'submitted' CHECK (verification_status IN ('submitted', 'pending_review', 'approved', 'rejected')), verified_at DATETIME(3), verification_level VARCHAR(30) DEFAULT 'basic', verification_notes TEXT, cover_photo_url TEXT, logo_url TEXT, module_marketplace_enabled TINYINT(1) DEFAULT 1, module_properties_enabled TINYINT(1) DEFAULT 0, module_rentals_enabled TINYINT(1) DEFAULT 0 );

-- [7/191] CREATE TABLE IF NOT EXISTS vendor_memberships ( id CHAR(36) PRIMARY KEY …
CREATE TABLE IF NOT EXISTS vendor_memberships ( id CHAR(36) PRIMARY KEY , vendor_org_id CHAR(36) NOT NULL REFERENCES vendor_organizations(id) ON DELETE CASCADE, user_id CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, org_role VARCHAR(20) DEFAULT 'member' CHECK (org_role IN ('owner', 'manager', 'member')), is_primary_contact TINYINT(1) DEFAULT 0, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), UNIQUE (vendor_org_id, user_id) );

-- [8/191] CREATE TABLE IF NOT EXISTS vendor_onboarding_fees ( id CHAR(36) PRIMARY …
CREATE TABLE IF NOT EXISTS vendor_onboarding_fees ( id CHAR(36) PRIMARY KEY , vendor_org_id CHAR(36) NOT NULL REFERENCES vendor_organizations(id) ON DELETE CASCADE, amount DECIMAL(12, 2) NOT NULL, currency VARCHAR(10) DEFAULT 'USD', provider VARCHAR(30), provider_reference VARCHAR(255), status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'refunded')), paid_at DATETIME(3), created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [9/191] CREATE TABLE IF NOT EXISTS vendor_subscriptions ( id CHAR(36) PRIMARY KE…
CREATE TABLE IF NOT EXISTS vendor_subscriptions ( id CHAR(36) PRIMARY KEY , vendor_org_id CHAR(36) NOT NULL REFERENCES vendor_organizations(id) ON DELETE CASCADE, plan_code VARCHAR(100), amount DECIMAL(12, 2), currency VARCHAR(10) DEFAULT 'USD', `interval` VARCHAR(20) CHECK (`interval` IN ('monthly', 'yearly')), provider VARCHAR(30), provider_subscription_id VARCHAR(255), status VARCHAR(20) DEFAULT 'trialing' CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'expired')), current_period_start DATETIME(3), current_period_end DATETIME(3), canceled_at DATETIME(3), created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [10/191] CREATE TABLE IF NOT EXISTS vendor_billing_payments ( id CHAR(36) PRIMARY…
CREATE TABLE IF NOT EXISTS vendor_billing_payments ( id CHAR(36) PRIMARY KEY , vendor_org_id CHAR(36) NOT NULL REFERENCES vendor_organizations(id) ON DELETE CASCADE, user_id CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, payment_type VARCHAR(30) NOT NULL CHECK (payment_type IN ('onboarding_fee', 'subscription', 'channel_subscription')), target_id CHAR(36), amount DECIMAL(12, 2) NOT NULL, currency VARCHAR(10) DEFAULT 'USD', payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('paystack', 'stripe')), provider_reference VARCHAR(255), status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')), paid_at DATETIME(3), created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [11/191] CREATE TABLE IF NOT EXISTS vendor_channel_plans ( id CHAR(36) PRIMARY KE…
CREATE TABLE IF NOT EXISTS vendor_channel_plans ( id CHAR(36) PRIMARY KEY , channel VARCHAR(20) NOT NULL CHECK (channel IN ('properties', 'rentals')), name VARCHAR(120) NOT NULL, duration_months INT NOT NULL, amount DECIMAL(12, 2) NOT NULL, currency VARCHAR(10) DEFAULT 'USD', compare_at_amount DECIMAL(12, 2), discount_percent INT, perks JSON DEFAULT ('[]'), sort_order INT DEFAULT 0, is_active TINYINT(1) DEFAULT 1, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [12/191] CREATE TABLE IF NOT EXISTS vendor_channel_subscriptions ( id CHAR(36) PR…
CREATE TABLE IF NOT EXISTS vendor_channel_subscriptions ( id CHAR(36) PRIMARY KEY , vendor_org_id CHAR(36) NOT NULL REFERENCES vendor_organizations(id) ON DELETE CASCADE, channel VARCHAR(20) NOT NULL CHECK (channel IN ('properties', 'rentals')), plan_id CHAR(36) REFERENCES vendor_channel_plans(id) ON DELETE SET NULL, plan_name VARCHAR(120), duration_months INT NOT NULL, amount DECIMAL(12, 2) NOT NULL, currency VARCHAR(10) DEFAULT 'USD', provider VARCHAR(30), provider_reference VARCHAR(255), status VARCHAR(20) DEFAULT 'past_due' CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'expired')), current_period_start DATETIME(3), current_period_end DATETIME(3), canceled_at DATETIME(3), created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [13/191] CREATE TABLE IF NOT EXISTS vendor_featured_plans ( id CHAR(36) PRIMARY K…
CREATE TABLE IF NOT EXISTS vendor_featured_plans ( id CHAR(36) PRIMARY KEY , channel VARCHAR(20) NOT NULL CHECK (channel IN ('properties', 'rentals', 'marketplace')), name VARCHAR(120) NOT NULL, duration_days INT NOT NULL, amount DECIMAL(12, 2) NOT NULL, currency VARCHAR(10) DEFAULT 'USD', compare_at_amount DECIMAL(12, 2), discount_percent INT, perks JSON DEFAULT ('[]'), sort_order INT DEFAULT 0, is_active TINYINT(1) DEFAULT 1, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [14/191] CREATE INDEX IF NOT EXISTS idx_vendor_featured_plans_channel ON vendor_f…
CREATE INDEX IF NOT EXISTS idx_vendor_featured_plans_channel ON vendor_featured_plans(channel, sort_order);

-- [15/191] CREATE TABLE IF NOT EXISTS vendor_listings ( id CHAR(36) PRIMARY KEY , v…
CREATE TABLE IF NOT EXISTS vendor_listings ( id CHAR(36) PRIMARY KEY , vendor_org_id CHAR(36) REFERENCES vendor_organizations(id) ON DELETE SET NULL, created_by CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, listing_type VARCHAR(20) NOT NULL CHECK (listing_type IN ('material', 'service')), category VARCHAR(120), title VARCHAR(255) NOT NULL, description TEXT, price DECIMAL(12, 2), currency VARCHAR(10) DEFAULT 'USD', location VARCHAR(255), media_url TEXT, metadata JSON, workflow_state VARCHAR(20) DEFAULT 'draft' CHECK (workflow_state IN ('draft', 'pending_review', 'approved', 'rejected', 'published', 'unpublished')), submitted_at DATETIME(3), approved_by CHAR(36) REFERENCES users(id) ON DELETE SET NULL, approved_at DATETIME(3), rejection_reason TEXT, featured_status VARCHAR(20) DEFAULT 'none' CHECK (featured_status IN ('none', 'pending', 'active', 'rejected', 'expired')), featured_plan VARCHAR(20) CHECK (featured_plan IN ('3_days', '7_days', '14_days')), featured_duration_days INT, featured_requested_at DATETIME(3), featured_requested_by CHAR(36) REFERENCES users(id) ON DELETE SET NULL, featured_approved_at DATETIME(3), featured_approved_by CHAR(36) REFERENCES users(id) ON DELETE SET NULL, featured_expires_at DATETIME(3), featured_price DECIMAL(12, 2), featured_currency VARCHAR(10) DEFAULT 'USD', featured_rejection_reason TEXT, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [16/191] CREATE INDEX IF NOT EXISTS idx_vendor_listings_featured_status ON vendor…
CREATE INDEX IF NOT EXISTS idx_vendor_listings_featured_status ON vendor_listings(featured_status, featured_expires_at DESC);

-- [17/191] CREATE TABLE IF NOT EXISTS projects ( id CHAR(36) PRIMARY KEY , client_i…
CREATE TABLE IF NOT EXISTS projects ( id CHAR(36) PRIMARY KEY , client_id CHAR(36) REFERENCES users(id) ON DELETE CASCADE, name VARCHAR(255) NOT NULL, location VARCHAR(255), package_type VARCHAR(100), total_cost DECIMAL(12, 2), amount_paid DECIMAL(12, 2) DEFAULT 0, progress_percent INT DEFAULT 0, status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed', 'on_hold')), start_date DATE, estimated_completion DATE, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), live_stream_url TEXT, client_can_view_live_stream TINYINT(1) DEFAULT 0, ivs_stream_key TEXT, ivs_ingest_url TEXT, ivs_playback_url TEXT, vendor_id CHAR(36) REFERENCES users(id) ON DELETE SET NULL );

-- [18/191] ALTER TABLE users ADD COLUMN vendor_org_id CHAR(36) NULL;
ALTER TABLE users ADD COLUMN vendor_org_id CHAR(36) NULL;

-- [19/191] ALTER TABLE users ADD CONSTRAINT fk_users_vendor_org_id FOREIGN KEY (ven…
ALTER TABLE users ADD CONSTRAINT fk_users_vendor_org_id FOREIGN KEY (vendor_org_id) REFERENCES vendor_organizations(id) ON DELETE SET NULL;

-- [20/191] ALTER TABLE users ADD COLUMN signup_vendor_channel VARCHAR(30) CHECK (si…
ALTER TABLE users ADD COLUMN signup_vendor_channel VARCHAR(30) CHECK (signup_vendor_channel IN ('marketplace', 'properties', 'rentals'));

-- [21/191] ALTER TABLE projects ADD COLUMN vendor_org_id CHAR(36) NULL;
ALTER TABLE projects ADD COLUMN vendor_org_id CHAR(36) NULL;

-- [22/191] ALTER TABLE projects ADD CONSTRAINT fk_projects_vendor_org_id FOREIGN KE…
ALTER TABLE projects ADD CONSTRAINT fk_projects_vendor_org_id FOREIGN KEY (vendor_org_id) REFERENCES vendor_organizations(id) ON DELETE SET NULL;

-- [23/191] CREATE TABLE IF NOT EXISTS milestones ( id CHAR(36) PRIMARY KEY , projec…
CREATE TABLE IF NOT EXISTS milestones ( id CHAR(36) PRIMARY KEY , project_id CHAR(36) REFERENCES projects(id) ON DELETE CASCADE, name VARCHAR(255) NOT NULL, description TEXT, progress_percent INT DEFAULT 0, amount DECIMAL(12, 2), is_paid TINYINT(1) DEFAULT 0, order_index INT, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [24/191] CREATE TABLE IF NOT EXISTS invoices ( id CHAR(36) PRIMARY KEY , invoice_…
CREATE TABLE IF NOT EXISTS invoices ( id CHAR(36) PRIMARY KEY , invoice_number VARCHAR(50) UNIQUE NOT NULL, project_id CHAR(36) REFERENCES projects(id) ON DELETE CASCADE, client_id CHAR(36) REFERENCES users(id) ON DELETE CASCADE, milestone_id CHAR(36) REFERENCES milestones(id), amount DECIMAL(12, 2) NOT NULL, status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'overdue')), due_date DATE, pdf_url TEXT, viewed_at DATETIME(3), created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [25/191] CREATE TABLE IF NOT EXISTS payments ( id CHAR(36) PRIMARY KEY , invoice_…
CREATE TABLE IF NOT EXISTS payments ( id CHAR(36) PRIMARY KEY , invoice_id CHAR(36) REFERENCES invoices(id) ON DELETE CASCADE, client_id CHAR(36) REFERENCES users(id) ON DELETE CASCADE, amount DECIMAL(12, 2) NOT NULL, currency VARCHAR(10) DEFAULT 'USD', payment_method VARCHAR(50), transaction_id VARCHAR(255), status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')), receipt_url TEXT, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [26/191] CREATE TABLE IF NOT EXISTS media ( id CHAR(36) PRIMARY KEY , project_id …
CREATE TABLE IF NOT EXISTS media ( id CHAR(36) PRIMARY KEY , project_id CHAR(36) REFERENCES projects(id) ON DELETE CASCADE, uploaded_by CHAR(36) REFERENCES users(id), title VARCHAR(255), description TEXT, media_type VARCHAR(50) CHECK (media_type IN ('photo', 'video', 'drone')), file_url TEXT NOT NULL, file_size BIGINT, metadata JSON, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [27/191] CREATE TABLE IF NOT EXISTS messages ( id CHAR(36) PRIMARY KEY , sender_i…
CREATE TABLE IF NOT EXISTS messages ( id CHAR(36) PRIMARY KEY , sender_id CHAR(36) REFERENCES users(id), recipient_id CHAR(36) REFERENCES users(id), project_id CHAR(36) REFERENCES projects(id), message_text TEXT NOT NULL, is_read TINYINT(1) DEFAULT 0, delivered_at DATETIME(3), created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [28/191] CREATE TABLE IF NOT EXISTS notifications ( id CHAR(36) PRIMARY KEY , use…
CREATE TABLE IF NOT EXISTS notifications ( id CHAR(36) PRIMARY KEY , user_id CHAR(36) REFERENCES users(id) ON DELETE CASCADE, type VARCHAR(50), title VARCHAR(255), message TEXT, is_read TINYINT(1) DEFAULT 0, metadata JSON, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [29/191] CREATE INDEX IF NOT EXISTS idx_projects_client_id ON projects(client_id)…
CREATE INDEX IF NOT EXISTS idx_projects_client_id ON projects(client_id);

-- [30/191] CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

-- [31/191] CREATE INDEX IF NOT EXISTS idx_invoices_project_id ON invoices(project_i…
CREATE INDEX IF NOT EXISTS idx_invoices_project_id ON invoices(project_id);

-- [32/191] CREATE INDEX IF NOT EXISTS idx_invoices_client_id ON invoices(client_id)…
CREATE INDEX IF NOT EXISTS idx_invoices_client_id ON invoices(client_id);

-- [33/191] CREATE INDEX IF NOT EXISTS idx_payments_invoice_id ON payments(invoice_i…
CREATE INDEX IF NOT EXISTS idx_payments_invoice_id ON payments(invoice_id);

-- [34/191] CREATE INDEX IF NOT EXISTS idx_media_project_id ON media(project_id);
CREATE INDEX IF NOT EXISTS idx_media_project_id ON media(project_id);

-- [35/191] CREATE INDEX IF NOT EXISTS idx_messages_project_id ON messages(project_i…
CREATE INDEX IF NOT EXISTS idx_messages_project_id ON messages(project_id);

-- [36/191] CREATE INDEX IF NOT EXISTS idx_messages_recipient_id ON messages(recipie…
CREATE INDEX IF NOT EXISTS idx_messages_recipient_id ON messages(recipient_id);

-- [37/191] CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(us…
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);

-- [38/191] CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(us…
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(user_id, is_read);

-- [39/191] CREATE INDEX IF NOT EXISTS idx_vendor_org_status ON vendor_organizations…
CREATE INDEX IF NOT EXISTS idx_vendor_org_status ON vendor_organizations(status);

-- [40/191] CREATE INDEX IF NOT EXISTS idx_vendor_memberships_org ON vendor_membersh…
CREATE INDEX IF NOT EXISTS idx_vendor_memberships_org ON vendor_memberships(vendor_org_id);

-- [41/191] CREATE INDEX IF NOT EXISTS idx_vendor_memberships_user ON vendor_members…
CREATE INDEX IF NOT EXISTS idx_vendor_memberships_user ON vendor_memberships(user_id);

-- [42/191] CREATE INDEX IF NOT EXISTS idx_vendor_memberships_primary ON vendor_memb…
CREATE INDEX IF NOT EXISTS idx_vendor_memberships_primary ON vendor_memberships(vendor_org_id, is_primary_contact);

-- [43/191] CREATE INDEX IF NOT EXISTS idx_vendor_onboarding_fees_org ON vendor_onbo…
CREATE INDEX IF NOT EXISTS idx_vendor_onboarding_fees_org ON vendor_onboarding_fees(vendor_org_id);

-- [44/191] CREATE INDEX IF NOT EXISTS idx_vendor_onboarding_fees_status ON vendor_o…
CREATE INDEX IF NOT EXISTS idx_vendor_onboarding_fees_status ON vendor_onboarding_fees(status);

-- [45/191] CREATE INDEX IF NOT EXISTS idx_vendor_subscriptions_org ON vendor_subscr…
CREATE INDEX IF NOT EXISTS idx_vendor_subscriptions_org ON vendor_subscriptions(vendor_org_id);

-- [46/191] CREATE INDEX IF NOT EXISTS idx_vendor_subscriptions_status ON vendor_sub…
CREATE INDEX IF NOT EXISTS idx_vendor_subscriptions_status ON vendor_subscriptions(status);

-- [47/191] CREATE INDEX IF NOT EXISTS idx_vendor_billing_payments_org ON vendor_bil…
CREATE INDEX IF NOT EXISTS idx_vendor_billing_payments_org ON vendor_billing_payments(vendor_org_id, created_at DESC);

-- [48/191] CREATE INDEX IF NOT EXISTS idx_vendor_billing_payments_user ON vendor_bi…
CREATE INDEX IF NOT EXISTS idx_vendor_billing_payments_user ON vendor_billing_payments(user_id, created_at DESC);

-- [49/191] CREATE INDEX IF NOT EXISTS idx_vendor_listings_org ON vendor_listings(ve…
CREATE INDEX IF NOT EXISTS idx_vendor_listings_org ON vendor_listings(vendor_org_id);

-- [50/191] CREATE INDEX IF NOT EXISTS idx_vendor_listings_creator ON vendor_listing…
CREATE INDEX IF NOT EXISTS idx_vendor_listings_creator ON vendor_listings(created_by);

-- [51/191] CREATE INDEX IF NOT EXISTS idx_vendor_listings_type ON vendor_listings(l…
CREATE INDEX IF NOT EXISTS idx_vendor_listings_type ON vendor_listings(listing_type);

-- [52/191] CREATE INDEX IF NOT EXISTS idx_vendor_listings_state ON vendor_listings(…
CREATE INDEX IF NOT EXISTS idx_vendor_listings_state ON vendor_listings(workflow_state);

-- [53/191] CREATE INDEX IF NOT EXISTS idx_users_vendor_org_id ON users(vendor_org_i…
CREATE INDEX IF NOT EXISTS idx_users_vendor_org_id ON users(vendor_org_id);

-- [54/191] CREATE INDEX IF NOT EXISTS idx_projects_vendor_org_id ON projects(vendor…
CREATE INDEX IF NOT EXISTS idx_projects_vendor_org_id ON projects(vendor_org_id);

-- [55/191] CREATE TABLE IF NOT EXISTS project_agent_assignments ( id CHAR(36) PRIMA…
CREATE TABLE IF NOT EXISTS project_agent_assignments ( id CHAR(36) PRIMARY KEY , project_id CHAR(36) NOT NULL REFERENCES projects(id) ON DELETE CASCADE, agent_id CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, assigned_by CHAR(36) REFERENCES users(id) ON DELETE SET NULL, kind VARCHAR(20) NOT NULL CHECK (kind IN ('service', 'material')), title VARCHAR(255) NOT NULL, description TEXT, status VARCHAR(40) NOT NULL DEFAULT 'assigned' CHECK (status IN ( 'assigned', 'invoice_required', 'invoice_submitted', 'completion_submitted', 'completion_approved', 'receipts_required', 'receipts_submitted', 'closed', 'cancelled' )), invoice_request_note TEXT, invoice_requested_at DATETIME(3), invoice_document_url TEXT, invoice_note TEXT, invoice_submitted_at DATETIME(3), completion_note TEXT, completion_document_url TEXT, completion_submitted_at DATETIME(3), completion_rejection_note TEXT, completion_approved_at DATETIME(3), completion_approved_by CHAR(36) REFERENCES users(id) ON DELETE SET NULL, receipts_request_note TEXT, receipts_requested_at DATETIME(3), receipt_document_url TEXT, receipts_submitted_at DATETIME(3), closed_at DATETIME(3), closed_by CHAR(36) REFERENCES users(id) ON DELETE SET NULL, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [56/191] CREATE INDEX IF NOT EXISTS idx_project_agent_assignments_agent ON projec…
CREATE INDEX IF NOT EXISTS idx_project_agent_assignments_agent ON project_agent_assignments(agent_id);

-- [57/191] CREATE INDEX IF NOT EXISTS idx_project_agent_assignments_project ON proj…
CREATE INDEX IF NOT EXISTS idx_project_agent_assignments_project ON project_agent_assignments(project_id);

-- [58/191] CREATE INDEX IF NOT EXISTS idx_project_agent_assignments_status ON proje…
CREATE INDEX IF NOT EXISTS idx_project_agent_assignments_status ON project_agent_assignments(status);

-- [59/191] CREATE TABLE IF NOT EXISTS vendor_reviews ( id CHAR(36) PRIMARY KEY , ve…
CREATE TABLE IF NOT EXISTS vendor_reviews ( id CHAR(36) PRIMARY KEY , vendor_profile_id CHAR(36) NOT NULL, vendor_profile_type VARCHAR(20) NOT NULL CHECK (vendor_profile_type IN ('organization', 'user')), reviewer_user_id CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5), comment TEXT, moderation_status VARCHAR(20) DEFAULT 'visible' CHECK (moderation_status IN ('visible', 'flagged', 'hidden')), moderation_reason TEXT, moderated_by CHAR(36) REFERENCES users(id) ON DELETE SET NULL, moderated_at DATETIME(3), reports_count INT DEFAULT 0, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), UNIQUE (vendor_profile_id, vendor_profile_type, reviewer_user_id) );

-- [60/191] CREATE INDEX IF NOT EXISTS idx_vendor_reviews_profile ON vendor_reviews(…
CREATE INDEX IF NOT EXISTS idx_vendor_reviews_profile ON vendor_reviews(vendor_profile_id, vendor_profile_type);

-- [61/191] CREATE INDEX IF NOT EXISTS idx_vendor_reviews_reviewer ON vendor_reviews…
CREATE INDEX IF NOT EXISTS idx_vendor_reviews_reviewer ON vendor_reviews(reviewer_user_id);

-- [62/191] CREATE INDEX IF NOT EXISTS idx_vendor_reviews_moderation ON vendor_revie…
CREATE INDEX IF NOT EXISTS idx_vendor_reviews_moderation ON vendor_reviews(moderation_status, reports_count);

-- [63/191] CREATE TABLE IF NOT EXISTS vendor_review_reports ( id CHAR(36) PRIMARY K…
CREATE TABLE IF NOT EXISTS vendor_review_reports ( id CHAR(36) PRIMARY KEY , review_id CHAR(36) NOT NULL REFERENCES vendor_reviews(id) ON DELETE CASCADE, reporter_user_id CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, reason TEXT, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), UNIQUE (review_id, reporter_user_id) );

-- [64/191] CREATE INDEX IF NOT EXISTS idx_vendor_review_reports_review ON vendor_re…
CREATE INDEX IF NOT EXISTS idx_vendor_review_reports_review ON vendor_review_reports(review_id);

-- [65/191] CREATE TABLE IF NOT EXISTS fraud_reports ( id CHAR(36) PRIMARY KEY , rep…
CREATE TABLE IF NOT EXISTS fraud_reports ( id CHAR(36) PRIMARY KEY , reporter_user_id CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, target_type VARCHAR(30) NOT NULL CHECK (target_type IN ('message', 'property', 'vendor_listing', 'vendor_profile', 'user')), target_id CHAR(36), project_id CHAR(36) REFERENCES projects(id) ON DELETE SET NULL, reason TEXT NOT NULL, details TEXT, risk_score INT DEFAULT 0, risk_level VARCHAR(20) DEFAULT 'medium' CHECK (risk_level IN ('low', 'medium', 'high', 'critical')), status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')), admin_note TEXT, assigned_to CHAR(36) REFERENCES users(id) ON DELETE SET NULL, resolved_at DATETIME(3), resolved_by CHAR(36) REFERENCES users(id) ON DELETE SET NULL, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [66/191] CREATE INDEX IF NOT EXISTS idx_fraud_reports_status ON fraud_reports(sta…
CREATE INDEX IF NOT EXISTS idx_fraud_reports_status ON fraud_reports(status, created_at DESC);

-- [67/191] CREATE INDEX IF NOT EXISTS idx_fraud_reports_risk ON fraud_reports(statu…
CREATE INDEX IF NOT EXISTS idx_fraud_reports_risk ON fraud_reports(status, risk_score DESC, created_at DESC);

-- [68/191] CREATE INDEX IF NOT EXISTS idx_fraud_reports_target ON fraud_reports(tar…
CREATE INDEX IF NOT EXISTS idx_fraud_reports_target ON fraud_reports(target_type, target_id);

-- [69/191] CREATE INDEX IF NOT EXISTS idx_fraud_reports_project ON fraud_reports(pr…
CREATE INDEX IF NOT EXISTS idx_fraud_reports_project ON fraud_reports(project_id, created_at DESC);

-- [70/191] CREATE TABLE IF NOT EXISTS message_attachments ( id CHAR(36) PRIMARY KEY…
CREATE TABLE IF NOT EXISTS message_attachments ( id CHAR(36) PRIMARY KEY , message_id CHAR(36) NOT NULL REFERENCES messages(id) ON DELETE CASCADE, file_url TEXT NOT NULL, file_name VARCHAR(255), file_type VARCHAR(100), created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [71/191] CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id ON message…
CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id ON message_attachments(message_id);

-- [72/191] CREATE TABLE IF NOT EXISTS message_reactions ( id CHAR(36) PRIMARY KEY ,…
CREATE TABLE IF NOT EXISTS message_reactions ( id CHAR(36) PRIMARY KEY , message_id CHAR(36) NOT NULL REFERENCES messages(id) ON DELETE CASCADE, user_id CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, emoji VARCHAR(32) NOT NULL, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), UNIQUE(message_id, user_id, emoji) );

-- [73/191] CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id ON message_r…
CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id ON message_reactions(message_id);

-- [74/191] CREATE TABLE IF NOT EXISTS pinned_messages ( id CHAR(36) PRIMARY KEY , p…
CREATE TABLE IF NOT EXISTS pinned_messages ( id CHAR(36) PRIMARY KEY , project_id CHAR(36) NOT NULL REFERENCES projects(id) ON DELETE CASCADE, message_id CHAR(36) NOT NULL REFERENCES messages(id) ON DELETE CASCADE, pinned_by CHAR(36) REFERENCES users(id) ON DELETE SET NULL, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), UNIQUE(project_id, message_id) );

-- [75/191] CREATE INDEX IF NOT EXISTS idx_pinned_messages_project_id ON pinned_mess…
CREATE INDEX IF NOT EXISTS idx_pinned_messages_project_id ON pinned_messages(project_id);

-- [76/191] CREATE TABLE IF NOT EXISTS project_activity ( id CHAR(36) PRIMARY KEY , …
CREATE TABLE IF NOT EXISTS project_activity ( id CHAR(36) PRIMARY KEY , project_id CHAR(36) NOT NULL REFERENCES projects(id) ON DELETE CASCADE, activity_type VARCHAR(50) NOT NULL, reference_id CHAR(36), actor_id CHAR(36) REFERENCES users(id) ON DELETE SET NULL, details JSON, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), verified_at DATETIME(3), verified_by CHAR(36) REFERENCES users(id) ON DELETE SET NULL );

-- [77/191] CREATE INDEX IF NOT EXISTS idx_project_activity_project_id ON project_ac…
CREATE INDEX IF NOT EXISTS idx_project_activity_project_id ON project_activity(project_id);

-- [78/191] CREATE INDEX IF NOT EXISTS idx_project_activity_created_at ON project_ac…
CREATE INDEX IF NOT EXISTS idx_project_activity_created_at ON project_activity(project_id, created_at DESC);

-- [79/191] CREATE TABLE IF NOT EXISTS escalations ( id CHAR(36) PRIMARY KEY , proje…
CREATE TABLE IF NOT EXISTS escalations ( id CHAR(36) PRIMARY KEY , project_id CHAR(36) NOT NULL REFERENCES projects(id) ON DELETE CASCADE, message_id CHAR(36) REFERENCES messages(id) ON DELETE SET NULL, raised_by CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, reason TEXT, status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')), created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), resolved_at DATETIME(3), resolved_by CHAR(36) REFERENCES users(id) ON DELETE SET NULL );

-- [80/191] CREATE INDEX IF NOT EXISTS idx_escalations_project_id ON escalations(pro…
CREATE INDEX IF NOT EXISTS idx_escalations_project_id ON escalations(project_id);

-- [81/191] CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status)…
CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status);

-- [82/191] CREATE TABLE IF NOT EXISTS properties ( id CHAR(36) PRIMARY KEY , title …
CREATE TABLE IF NOT EXISTS properties ( id CHAR(36) PRIMARY KEY , title VARCHAR(255) NOT NULL, description TEXT, property_type VARCHAR(50) DEFAULT 'apartment' CHECK (property_type IN ('apartment', 'villa', 'house', 'cabin', 'treehouse', 'other')), bedrooms INT DEFAULT 0, bathrooms INT DEFAULT 1, location VARCHAR(255), area VARCHAR(255), price DECIMAL(12, 2) NOT NULL, currency VARCHAR(10) DEFAULT 'USD', image_url TEXT, amenities TEXT, status VARCHAR(20) DEFAULT 'published' CHECK (status IN ('draft', 'published')), created_by CHAR(36) REFERENCES users(id) ON DELETE SET NULL, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [83/191] CREATE INDEX IF NOT EXISTS idx_properties_property_type ON properties(pr…
CREATE INDEX IF NOT EXISTS idx_properties_property_type ON properties(property_type);

-- [84/191] CREATE INDEX IF NOT EXISTS idx_properties_created_at ON properties(creat…
CREATE INDEX IF NOT EXISTS idx_properties_created_at ON properties(created_at DESC);

-- [85/191] CREATE INDEX IF NOT EXISTS idx_properties_status ON properties(status);
CREATE INDEX IF NOT EXISTS idx_properties_status ON properties(status);

-- [86/191] CREATE TABLE IF NOT EXISTS property_images ( id CHAR(36) PRIMARY KEY , p…
CREATE TABLE IF NOT EXISTS property_images ( id CHAR(36) PRIMARY KEY , property_id CHAR(36) NOT NULL REFERENCES properties(id) ON DELETE CASCADE, file_url TEXT NOT NULL, sort_order INT DEFAULT 0, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [87/191] CREATE INDEX IF NOT EXISTS idx_property_images_property_id ON property_i…
CREATE INDEX IF NOT EXISTS idx_property_images_property_id ON property_images(property_id);

-- [88/191] CREATE TABLE IF NOT EXISTS featured_listing_payments ( id CHAR(36) PRIMA…
CREATE TABLE IF NOT EXISTS featured_listing_payments ( id CHAR(36) PRIMARY KEY , listing_id CHAR(36) REFERENCES vendor_listings(id) ON DELETE CASCADE, property_id CHAR(36) REFERENCES properties(id) ON DELETE CASCADE, user_id CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, plan VARCHAR(20) NOT NULL CHECK (plan IN ('3_days', '7_days', '14_days')), plan_id CHAR(36) REFERENCES vendor_featured_plans(id) ON DELETE SET NULL, plan_name VARCHAR(120), duration_days INT, amount DECIMAL(12, 2) NOT NULL, currency VARCHAR(10) DEFAULT 'USD', payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('paystack', 'stripe')), provider_reference VARCHAR(255), status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')), paid_at DATETIME(3), created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), CONSTRAINT featured_listing_payments_target_chk CHECK ( (listing_id IS NOT NULL AND property_id IS NULL) OR (listing_id IS NULL AND property_id IS NOT NULL) ) );

-- [89/191] CREATE INDEX IF NOT EXISTS idx_featured_listing_payments_listing ON feat…
CREATE INDEX IF NOT EXISTS idx_featured_listing_payments_listing ON featured_listing_payments(listing_id, created_at DESC);

-- [90/191] CREATE INDEX IF NOT EXISTS idx_featured_listing_payments_property ON fea…
CREATE INDEX IF NOT EXISTS idx_featured_listing_payments_property ON featured_listing_payments(property_id, created_at DESC);

-- [91/191] CREATE INDEX IF NOT EXISTS idx_featured_listing_payments_user ON feature…
CREATE INDEX IF NOT EXISTS idx_featured_listing_payments_user ON featured_listing_payments(user_id, created_at DESC);

-- [92/191] ALTER TABLE properties ADD COLUMN slug VARCHAR(255) UNIQUE;
ALTER TABLE properties ADD COLUMN slug VARCHAR(255) UNIQUE;

-- [93/191] ALTER TABLE properties ADD COLUMN listing_purpose VARCHAR(20) DEFAULT 's…
ALTER TABLE properties ADD COLUMN listing_purpose VARCHAR(20) DEFAULT 'sale' CHECK (listing_purpose IN ('sale', 'rent'));

-- [94/191] ALTER TABLE properties ADD COLUMN rent_type VARCHAR(20) CHECK (rent_type…
ALTER TABLE properties ADD COLUMN rent_type VARCHAR(20) CHECK (rent_type IN ('short_stay', 'long_term'));

-- [95/191] ALTER TABLE properties ADD COLUMN furnished_status VARCHAR(20) CHECK (fu…
ALTER TABLE properties ADD COLUMN furnished_status VARCHAR(20) CHECK (furnished_status IN ('furnished', 'unfurnished', 'part_furnished'));

-- [96/191] ALTER TABLE properties ADD COLUMN availability_status VARCHAR(20) DEFAUL…
ALTER TABLE properties ADD COLUMN availability_status VARCHAR(20) DEFAULT 'available' CHECK (availability_status IN ('available', 'unavailable', 'booked'));

-- [97/191] ALTER TABLE properties ADD COLUMN featured TINYINT(1) DEFAULT 0;
ALTER TABLE properties ADD COLUMN featured TINYINT(1) DEFAULT 0;

-- [98/191] ALTER TABLE properties ADD COLUMN is_new TINYINT(1) DEFAULT 0;
ALTER TABLE properties ADD COLUMN is_new TINYINT(1) DEFAULT 0;

-- [99/191] ALTER TABLE properties ADD COLUMN short_description TEXT;
ALTER TABLE properties ADD COLUMN short_description TEXT;

-- [100/191] ALTER TABLE properties ADD COLUMN address TEXT;
ALTER TABLE properties ADD COLUMN address TEXT;

-- [101/191] ALTER TABLE properties ADD COLUMN square_footage INT;
ALTER TABLE properties ADD COLUMN square_footage INT;

-- [102/191] ALTER TABLE properties ADD COLUMN publish_status VARCHAR(20) DEFAULT 'pu…
ALTER TABLE properties ADD COLUMN publish_status VARCHAR(20) DEFAULT 'published' CHECK (publish_status IN ('draft', 'published', 'unpublished'));

-- [103/191] ALTER TABLE properties ADD COLUMN region VARCHAR(120);
ALTER TABLE properties ADD COLUMN region VARCHAR(120);

-- [104/191] ALTER TABLE properties ADD COLUMN city VARCHAR(120);
ALTER TABLE properties ADD COLUMN city VARCHAR(120);

-- [105/191] CREATE INDEX IF NOT EXISTS idx_properties_listing_purpose ON properties(…
CREATE INDEX IF NOT EXISTS idx_properties_listing_purpose ON properties(listing_purpose);

-- [106/191] CREATE INDEX IF NOT EXISTS idx_properties_featured ON properties(feature…
CREATE INDEX IF NOT EXISTS idx_properties_featured ON properties(featured);

-- [107/191] CREATE INDEX IF NOT EXISTS idx_properties_publish_status ON properties(p…
CREATE INDEX IF NOT EXISTS idx_properties_publish_status ON properties(publish_status);

-- [108/191] ALTER TABLE properties ADD COLUMN featured_status VARCHAR(20) DEFAULT 'n…
ALTER TABLE properties ADD COLUMN featured_status VARCHAR(20) DEFAULT 'none' CHECK (featured_status IN ('none', 'pending', 'active', 'rejected', 'expired'));

-- [109/191] ALTER TABLE properties ADD COLUMN featured_plan VARCHAR(20) CHECK (featu…
ALTER TABLE properties ADD COLUMN featured_plan VARCHAR(20) CHECK (featured_plan IN ('3_days', '7_days', '14_days'));

-- [110/191] ALTER TABLE properties ADD COLUMN featured_duration_days INT;
ALTER TABLE properties ADD COLUMN featured_duration_days INT;

-- [111/191] ALTER TABLE properties ADD COLUMN featured_requested_at DATETIME(3);
ALTER TABLE properties ADD COLUMN featured_requested_at DATETIME(3);

-- [112/191] ALTER TABLE properties ADD COLUMN featured_requested_by CHAR(36) NULL;
ALTER TABLE properties ADD COLUMN featured_requested_by CHAR(36) NULL;

-- [113/191] ALTER TABLE properties ADD CONSTRAINT fk_properties_featured_requested_b…
ALTER TABLE properties ADD CONSTRAINT fk_properties_featured_requested_by FOREIGN KEY (featured_requested_by) REFERENCES users(id) ON DELETE SET NULL;

-- [114/191] ALTER TABLE properties ADD COLUMN featured_approved_at DATETIME(3);
ALTER TABLE properties ADD COLUMN featured_approved_at DATETIME(3);

-- [115/191] ALTER TABLE properties ADD COLUMN featured_approved_by CHAR(36) NULL;
ALTER TABLE properties ADD COLUMN featured_approved_by CHAR(36) NULL;

-- [116/191] ALTER TABLE properties ADD CONSTRAINT fk_properties_featured_approved_by…
ALTER TABLE properties ADD CONSTRAINT fk_properties_featured_approved_by FOREIGN KEY (featured_approved_by) REFERENCES users(id) ON DELETE SET NULL;

-- [117/191] ALTER TABLE properties ADD COLUMN featured_expires_at DATETIME(3);
ALTER TABLE properties ADD COLUMN featured_expires_at DATETIME(3);

-- [118/191] ALTER TABLE properties ADD COLUMN featured_price DECIMAL(12, 2);
ALTER TABLE properties ADD COLUMN featured_price DECIMAL(12, 2);

-- [119/191] ALTER TABLE properties ADD COLUMN featured_currency VARCHAR(10) DEFAULT …
ALTER TABLE properties ADD COLUMN featured_currency VARCHAR(10) DEFAULT 'USD';

-- [120/191] ALTER TABLE properties ADD COLUMN featured_rejection_reason TEXT;
ALTER TABLE properties ADD COLUMN featured_rejection_reason TEXT;

-- [121/191] CREATE INDEX IF NOT EXISTS idx_properties_featured_status ON properties(…
CREATE INDEX IF NOT EXISTS idx_properties_featured_status ON properties(featured_status, featured_expires_at DESC);

-- [122/191] CREATE INDEX IF NOT EXISTS idx_properties_slug ON properties(slug);
CREATE INDEX IF NOT EXISTS idx_properties_slug ON properties(slug);

-- [123/191] ALTER TABLE properties ADD COLUMN moderation_status VARCHAR(20) DEFAULT …
ALTER TABLE properties ADD COLUMN moderation_status VARCHAR(20) DEFAULT 'approved' CHECK (moderation_status IN ('pending', 'approved', 'rejected'));

-- [124/191] CREATE INDEX IF NOT EXISTS idx_properties_moderation ON properties(moder…
CREATE INDEX IF NOT EXISTS idx_properties_moderation ON properties(moderation_status);

-- [125/191] ALTER TABLE properties ADD COLUMN authenticity_status VARCHAR(20) DEFAUL…
ALTER TABLE properties ADD COLUMN authenticity_status VARCHAR(20) DEFAULT 'not_submitted' CHECK (authenticity_status IN ('not_submitted', 'pending', 'approved', 'rejected'));

-- [126/191] ALTER TABLE properties ADD COLUMN ownership_proof_url TEXT;
ALTER TABLE properties ADD COLUMN ownership_proof_url TEXT;

-- [127/191] ALTER TABLE properties ADD COLUMN mandate_proof_url TEXT;
ALTER TABLE properties ADD COLUMN mandate_proof_url TEXT;

-- [128/191] ALTER TABLE properties ADD COLUMN authenticity_notes TEXT;
ALTER TABLE properties ADD COLUMN authenticity_notes TEXT;

-- [129/191] ALTER TABLE properties ADD COLUMN authenticity_reviewed_at DATETIME(3);
ALTER TABLE properties ADD COLUMN authenticity_reviewed_at DATETIME(3);

-- [130/191] ALTER TABLE properties ADD COLUMN authenticity_reviewed_by CHAR(36) NULL…
ALTER TABLE properties ADD COLUMN authenticity_reviewed_by CHAR(36) NULL;

-- [131/191] ALTER TABLE properties ADD CONSTRAINT fk_properties_authenticity_reviewe…
ALTER TABLE properties ADD CONSTRAINT fk_properties_authenticity_reviewed_by FOREIGN KEY (authenticity_reviewed_by) REFERENCES users(id) ON DELETE SET NULL;

-- [132/191] CREATE INDEX IF NOT EXISTS idx_properties_authenticity_status ON propert…
CREATE INDEX IF NOT EXISTS idx_properties_authenticity_status ON properties(authenticity_status);

-- [133/191] ALTER TABLE properties ADD COLUMN listing_state VARCHAR(30) CHECK (listi…
ALTER TABLE properties ADD COLUMN listing_state VARCHAR(30) CHECK (listing_state IN ( 'draft', 'pending_review', 'approved', 'published', 'paused', 'sold', 'rented', 'archived', 'rejected' ));

-- [134/191] CREATE INDEX IF NOT EXISTS idx_properties_listing_state ON properties(li…
CREATE INDEX IF NOT EXISTS idx_properties_listing_state ON properties(listing_state);

-- [135/191] ALTER TABLE properties ADD COLUMN listing_agent_id CHAR(36) NULL;
ALTER TABLE properties ADD COLUMN listing_agent_id CHAR(36) NULL;

-- [136/191] ALTER TABLE properties ADD CONSTRAINT fk_properties_listing_agent_id FOR…
ALTER TABLE properties ADD CONSTRAINT fk_properties_listing_agent_id FOREIGN KEY (listing_agent_id) REFERENCES users(id) ON DELETE SET NULL;

-- [137/191] CREATE INDEX IF NOT EXISTS idx_properties_listing_agent ON properties(li…
CREATE INDEX IF NOT EXISTS idx_properties_listing_agent ON properties(listing_agent_id);

-- [138/191] CREATE TABLE IF NOT EXISTS property_favorites ( id CHAR(36) PRIMARY KEY …
CREATE TABLE IF NOT EXISTS property_favorites ( id CHAR(36) PRIMARY KEY , user_id CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, property_id CHAR(36) NOT NULL REFERENCES properties(id) ON DELETE CASCADE, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), UNIQUE (user_id, property_id) );

-- [139/191] CREATE INDEX IF NOT EXISTS idx_property_favorites_user ON property_favor…
CREATE INDEX IF NOT EXISTS idx_property_favorites_user ON property_favorites(user_id);

-- [140/191] CREATE INDEX IF NOT EXISTS idx_property_favorites_property ON property_f…
CREATE INDEX IF NOT EXISTS idx_property_favorites_property ON property_favorites(property_id);

-- [141/191] CREATE TABLE IF NOT EXISTS saved_searches ( id CHAR(36) PRIMARY KEY , us…
CREATE TABLE IF NOT EXISTS saved_searches ( id CHAR(36) PRIMARY KEY , user_id CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, name VARCHAR(140) NOT NULL, search_scope VARCHAR(30) DEFAULT 'properties' CHECK (search_scope IN ('properties', 'rentals', 'marketplace', 'vendor_listings')), filters_json JSON NOT NULL, query_string TEXT, is_active TINYINT(1) DEFAULT 1, alert_frequency VARCHAR(20) DEFAULT 'instant' CHECK (alert_frequency IN ('instant', 'daily', 'weekly')), notify_email TINYINT(1) DEFAULT 1, notify_push TINYINT(1) DEFAULT 0, last_notified_at DATETIME(3), created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [142/191] CREATE INDEX IF NOT EXISTS idx_saved_searches_user ON saved_searches(use…
CREATE INDEX IF NOT EXISTS idx_saved_searches_user ON saved_searches(user_id, created_at DESC);

-- [143/191] CREATE INDEX IF NOT EXISTS idx_saved_searches_active ON saved_searches(i…
CREATE INDEX IF NOT EXISTS idx_saved_searches_active ON saved_searches(is_active);

-- [144/191] CREATE INDEX IF NOT EXISTS idx_saved_searches_frequency ON saved_searche…
CREATE INDEX IF NOT EXISTS idx_saved_searches_frequency ON saved_searches(alert_frequency);

-- [145/191] CREATE TABLE IF NOT EXISTS analytics_events ( id CHAR(36) PRIMARY KEY , …
CREATE TABLE IF NOT EXISTS analytics_events ( id CHAR(36) PRIMARY KEY , user_id CHAR(36) REFERENCES users(id) ON DELETE SET NULL, session_id VARCHAR(128), event_name VARCHAR(80) NOT NULL, event_source VARCHAR(50), page_path TEXT, metadata JSON, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [146/191] CREATE INDEX IF NOT EXISTS idx_analytics_events_name_time ON analytics_e…
CREATE INDEX IF NOT EXISTS idx_analytics_events_name_time ON analytics_events(event_name, created_at DESC);

-- [147/191] CREATE INDEX IF NOT EXISTS idx_analytics_events_user_time ON analytics_e…
CREATE INDEX IF NOT EXISTS idx_analytics_events_user_time ON analytics_events(user_id, created_at DESC);

-- [148/191] CREATE INDEX IF NOT EXISTS idx_analytics_events_session_time ON analytic…
CREATE INDEX IF NOT EXISTS idx_analytics_events_session_time ON analytics_events(session_id, created_at DESC);

-- [149/191] CREATE TABLE IF NOT EXISTS listing_inquiries ( id CHAR(36) PRIMARY KEY ,…
CREATE TABLE IF NOT EXISTS listing_inquiries ( id CHAR(36) PRIMARY KEY , property_id CHAR(36) NOT NULL REFERENCES properties(id) ON DELETE CASCADE, vendor_id CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, message TEXT, lead_status VARCHAR(30) DEFAULT 'new' CHECK (lead_status IN ( 'new', 'contacted', 'interested', 'inspection_booked', 'negotiating', 'closed_won', 'closed_lost' )), assigned_to CHAR(36) NOT NULL REFERENCES users(id) ON DELETE RESTRICT, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [150/191] CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_inquiries_property_vendor …
CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_inquiries_property_vendor ON listing_inquiries(property_id, vendor_id);

-- [151/191] CREATE INDEX IF NOT EXISTS idx_listing_inquiries_property ON listing_inq…
CREATE INDEX IF NOT EXISTS idx_listing_inquiries_property ON listing_inquiries(property_id);

-- [152/191] CREATE INDEX IF NOT EXISTS idx_listing_inquiries_vendor ON listing_inqui…
CREATE INDEX IF NOT EXISTS idx_listing_inquiries_vendor ON listing_inquiries(vendor_id);

-- [153/191] CREATE INDEX IF NOT EXISTS idx_listing_inquiries_lead_status ON listing_…
CREATE INDEX IF NOT EXISTS idx_listing_inquiries_lead_status ON listing_inquiries(lead_status);

-- [154/191] CREATE INDEX IF NOT EXISTS idx_listing_inquiries_assigned_to ON listing_…
CREATE INDEX IF NOT EXISTS idx_listing_inquiries_assigned_to ON listing_inquiries(assigned_to);

-- [155/191] CREATE TABLE IF NOT EXISTS listing_offers ( id CHAR(36) PRIMARY KEY , pr…
CREATE TABLE IF NOT EXISTS listing_offers ( id CHAR(36) PRIMARY KEY , property_id CHAR(36) NOT NULL REFERENCES properties(id) ON DELETE CASCADE, vendor_id CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, amount DECIMAL(12, 2) NOT NULL, currency VARCHAR(10) DEFAULT 'USD', terms_note TEXT, status VARCHAR(30) DEFAULT 'submitted' CHECK (status IN ('submitted', 'under_review', 'accepted', 'rejected', 'withdrawn')), admin_note TEXT, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [156/191] CREATE INDEX IF NOT EXISTS idx_listing_offers_property ON listing_offers…
CREATE INDEX IF NOT EXISTS idx_listing_offers_property ON listing_offers(property_id);

-- [157/191] CREATE INDEX IF NOT EXISTS idx_listing_offers_vendor ON listing_offers(v…
CREATE INDEX IF NOT EXISTS idx_listing_offers_vendor ON listing_offers(vendor_id);

-- [158/191] CREATE INDEX IF NOT EXISTS idx_listing_offers_status ON listing_offers(s…
CREATE INDEX IF NOT EXISTS idx_listing_offers_status ON listing_offers(status);

-- [159/191] CREATE TABLE IF NOT EXISTS rental_applications ( id CHAR(36) PRIMARY KEY…
CREATE TABLE IF NOT EXISTS rental_applications ( id CHAR(36) PRIMARY KEY , property_id CHAR(36) NOT NULL REFERENCES properties(id) ON DELETE CASCADE, vendor_id CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, move_in_date DATE, employment_note TEXT, notes TEXT, status VARCHAR(30) DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'withdrawn')), admin_note TEXT, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [160/191] CREATE INDEX IF NOT EXISTS idx_rental_applications_property ON rental_ap…
CREATE INDEX IF NOT EXISTS idx_rental_applications_property ON rental_applications(property_id);

-- [161/191] CREATE INDEX IF NOT EXISTS idx_rental_applications_vendor ON rental_appl…
CREATE INDEX IF NOT EXISTS idx_rental_applications_vendor ON rental_applications(vendor_id);

-- [162/191] CREATE INDEX IF NOT EXISTS idx_rental_applications_status ON rental_appl…
CREATE INDEX IF NOT EXISTS idx_rental_applications_status ON rental_applications(status);

-- [163/191] CREATE TABLE IF NOT EXISTS house_plans ( id CHAR(36) PRIMARY KEY , slug …
CREATE TABLE IF NOT EXISTS house_plans ( id CHAR(36) PRIMARY KEY , slug VARCHAR(255) UNIQUE NOT NULL, title VARCHAR(255) NOT NULL, architect_name VARCHAR(255) NOT NULL, architect_bio TEXT, building_type VARCHAR(100), category VARCHAR(100), description TEXT, tags TEXT, price DECIMAL(12, 2) NOT NULL, currency VARCHAR(10) DEFAULT 'USD', size_label VARCHAR(100), floors INT DEFAULT 1, bedrooms INT DEFAULT 0, bathrooms INT DEFAULT 0, square_meters DECIMAL(10, 2), square_feet DECIMAL(10, 2), cover_image_url TEXT, pdf_path TEXT, featured TINYINT(1) DEFAULT 0, publish_status VARCHAR(20) DEFAULT 'draft' CHECK (publish_status IN ('draft', 'published', 'unpublished')), created_by CHAR(36) REFERENCES users(id) ON DELETE SET NULL, owner_architect_id CHAR(36) REFERENCES users(id) ON DELETE SET NULL, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [164/191] CREATE INDEX IF NOT EXISTS idx_house_plans_slug ON house_plans(slug);
CREATE INDEX IF NOT EXISTS idx_house_plans_slug ON house_plans(slug);

-- [165/191] CREATE INDEX IF NOT EXISTS idx_house_plans_publish_status ON house_plans…
CREATE INDEX IF NOT EXISTS idx_house_plans_publish_status ON house_plans(publish_status);

-- [166/191] CREATE INDEX IF NOT EXISTS idx_house_plans_featured ON house_plans(featu…
CREATE INDEX IF NOT EXISTS idx_house_plans_featured ON house_plans(featured);

-- [167/191] CREATE INDEX IF NOT EXISTS idx_house_plans_owner_architect ON house_plan…
CREATE INDEX IF NOT EXISTS idx_house_plans_owner_architect ON house_plans(owner_architect_id);

-- [168/191] CREATE TABLE IF NOT EXISTS house_plan_previews ( id CHAR(36) PRIMARY KEY…
CREATE TABLE IF NOT EXISTS house_plan_previews ( id CHAR(36) PRIMARY KEY , house_plan_id CHAR(36) NOT NULL REFERENCES house_plans(id) ON DELETE CASCADE, image_url TEXT NOT NULL, sort_order INT DEFAULT 0, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [169/191] CREATE INDEX IF NOT EXISTS idx_house_plan_previews_plan ON house_plan_pr…
CREATE INDEX IF NOT EXISTS idx_house_plan_previews_plan ON house_plan_previews(house_plan_id);

-- [170/191] CREATE TABLE IF NOT EXISTS house_plan_purchases ( id CHAR(36) PRIMARY KE…
CREATE TABLE IF NOT EXISTS house_plan_purchases ( id CHAR(36) PRIMARY KEY , house_plan_id CHAR(36) NOT NULL REFERENCES house_plans(id) ON DELETE CASCADE, user_id CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, amount DECIMAL(12, 2) NOT NULL, currency VARCHAR(10) DEFAULT 'USD', provider VARCHAR(20) CHECK (provider IN ('stripe', 'paystack')), provider_reference VARCHAR(255), status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed')), paid_at DATETIME(3), created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [171/191] CREATE INDEX IF NOT EXISTS idx_house_plan_purchases_user ON house_plan_p…
CREATE INDEX IF NOT EXISTS idx_house_plan_purchases_user ON house_plan_purchases(user_id);

-- [172/191] CREATE INDEX IF NOT EXISTS idx_house_plan_purchases_plan ON house_plan_p…
CREATE INDEX IF NOT EXISTS idx_house_plan_purchases_plan ON house_plan_purchases(house_plan_id);

-- [173/191] CREATE UNIQUE INDEX IF NOT EXISTS idx_house_plan_paid_unique ON house_pl…
CREATE UNIQUE INDEX IF NOT EXISTS idx_house_plan_paid_unique ON house_plan_purchases (house_plan_id, user_id, status);

-- [174/191] CREATE TABLE IF NOT EXISTS house_plan_access_tokens ( id CHAR(36) PRIMAR…
CREATE TABLE IF NOT EXISTS house_plan_access_tokens ( id CHAR(36) PRIMARY KEY , house_plan_id CHAR(36) NOT NULL REFERENCES house_plans(id) ON DELETE CASCADE, user_id CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, action VARCHAR(20) NOT NULL CHECK (action IN ('preview', 'download')), expires_at DATETIME(3) NOT NULL, used_at DATETIME(3), created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [175/191] CREATE INDEX IF NOT EXISTS idx_house_plan_access_tokens_plan_user ON hou…
CREATE INDEX IF NOT EXISTS idx_house_plan_access_tokens_plan_user ON house_plan_access_tokens(house_plan_id, user_id);

-- [176/191] CREATE INDEX IF NOT EXISTS idx_house_plan_access_tokens_expires ON house…
CREATE INDEX IF NOT EXISTS idx_house_plan_access_tokens_expires ON house_plan_access_tokens(expires_at);

-- [177/191] CREATE TABLE IF NOT EXISTS appointments ( id CHAR(36) PRIMARY KEY , clie…
CREATE TABLE IF NOT EXISTS appointments ( id CHAR(36) PRIMARY KEY , client_id CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, project_id CHAR(36) REFERENCES projects(id) ON DELETE SET NULL, property_id CHAR(36) REFERENCES properties(id) ON DELETE SET NULL, agent_id CHAR(36) REFERENCES users(id) ON DELETE SET NULL, title VARCHAR(500) NOT NULL, preferred_date DATE, preferred_time VARCHAR(100), scheduled_date DATE, scheduled_time VARCHAR(100), notes TEXT, reschedule_note TEXT, cancellation_reason TEXT, status VARCHAR(30) DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rescheduled', 'cancelled', 'completed')), reminder_at DATETIME(3), reminder_sent_at DATETIME(3), created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [178/191] CREATE INDEX IF NOT EXISTS idx_appointments_client_id ON appointments(cl…
CREATE INDEX IF NOT EXISTS idx_appointments_client_id ON appointments(client_id);

-- [179/191] CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(statu…
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);

-- [180/191] CREATE INDEX IF NOT EXISTS idx_appointments_property_id ON appointments(…
CREATE INDEX IF NOT EXISTS idx_appointments_property_id ON appointments(property_id);

-- [181/191] CREATE INDEX IF NOT EXISTS idx_appointments_agent_id ON appointments(age…
CREATE INDEX IF NOT EXISTS idx_appointments_agent_id ON appointments(agent_id);

-- [182/191] CREATE TABLE IF NOT EXISTS site_inspections ( id CHAR(36) PRIMARY KEY , …
CREATE TABLE IF NOT EXISTS site_inspections ( id CHAR(36) PRIMARY KEY , project_id CHAR(36) NOT NULL REFERENCES projects(id) ON DELETE CASCADE, requested_by CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, status VARCHAR(30) DEFAULT 'requested' CHECK (status IN ('requested', 'assigned', 'scheduled', 'completed', 'cancelled')), assigned_inspector_id CHAR(36) REFERENCES users(id) ON DELETE SET NULL, scheduled_at DATETIME(3), client_notes TEXT, admin_notes TEXT, report_text TEXT, report_file_url TEXT, reported_at DATETIME(3), reported_by CHAR(36) REFERENCES users(id) ON DELETE SET NULL, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [183/191] CREATE INDEX IF NOT EXISTS idx_site_inspections_project_id ON site_inspe…
CREATE INDEX IF NOT EXISTS idx_site_inspections_project_id ON site_inspections(project_id);

-- [184/191] CREATE INDEX IF NOT EXISTS idx_site_inspections_assigned ON site_inspect…
CREATE INDEX IF NOT EXISTS idx_site_inspections_assigned ON site_inspections(assigned_inspector_id);

-- [185/191] CREATE TABLE IF NOT EXISTS inspection_photos ( id CHAR(36) PRIMARY KEY ,…
CREATE TABLE IF NOT EXISTS inspection_photos ( id CHAR(36) PRIMARY KEY , inspection_id CHAR(36) NOT NULL REFERENCES site_inspections(id) ON DELETE CASCADE, file_url TEXT NOT NULL, caption TEXT, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) );

-- [186/191] CREATE INDEX IF NOT EXISTS idx_inspection_photos_inspection_id ON inspec…
CREATE INDEX IF NOT EXISTS idx_inspection_photos_inspection_id ON inspection_photos(inspection_id);

-- [187/191] CREATE TABLE IF NOT EXISTS project_progress_reports ( id CHAR(36) PRIMAR…
CREATE TABLE IF NOT EXISTS project_progress_reports ( id CHAR(36) PRIMARY KEY , project_id CHAR(36) NOT NULL REFERENCES projects(id) ON DELETE CASCADE, period_start DATE NOT NULL, period_end DATE NOT NULL, summary_text TEXT NOT NULL, milestones_completed JSON, new_photos_count INT DEFAULT 0, financial_summary JSON, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), email_sent_at DATETIME(3) );

-- [188/191] CREATE INDEX IF NOT EXISTS idx_project_progress_reports_project_id ON pr…
CREATE INDEX IF NOT EXISTS idx_project_progress_reports_project_id ON project_progress_reports(project_id);

-- [189/191] CREATE TABLE IF NOT EXISTS project_report_preferences ( project_id CHAR(…
CREATE TABLE IF NOT EXISTS project_report_preferences ( project_id CHAR(36) NOT NULL REFERENCES projects(id) ON DELETE CASCADE, user_id CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, send_weekly_email TINYINT(1) DEFAULT 1, PRIMARY KEY (project_id, user_id) );

-- [190/191] CREATE TABLE IF NOT EXISTS contractor_ratings ( id CHAR(36) PRIMARY KEY …
CREATE TABLE IF NOT EXISTS contractor_ratings ( id CHAR(36) PRIMARY KEY , project_id CHAR(36) NOT NULL REFERENCES projects(id) ON DELETE CASCADE, contractor_id CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, client_id CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5), comment TEXT, created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), UNIQUE(project_id, client_id) );

-- [191/191] CREATE INDEX IF NOT EXISTS idx_contractor_ratings_contractor_id ON contr…
CREATE INDEX IF NOT EXISTS idx_contractor_ratings_contractor_id ON contractor_ratings(contractor_id);
SET FOREIGN_KEY_CHECKS = 1;
