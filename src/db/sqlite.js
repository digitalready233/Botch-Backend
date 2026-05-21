import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultPath = path.join(__dirname, '../../botch.db');
const dbPath = process.env.SQLITE_PATH ? path.resolve(process.env.SQLITE_PATH) : defaultPath;

// Ensure the directory exists so better-sqlite3 can create the file (e.g. /data for SQLITE_PATH=/data/botch.db on Render)
const dbDir = path.dirname(dbPath);
try {
  fs.mkdirSync(dbDir, { recursive: true });
} catch (err) {
  throw new Error(
    `Cannot create database directory "${dbDir}". On Render, add a Disk with mount path /data and set SQLITE_PATH=/data/botch.db. ${err.message}`
  );
}

const db = new Database(dbPath);

if (process.env.NODE_ENV === 'production' && !process.env.SQLITE_PATH) {
  console.warn(
    '[sqlite] Production with default DB path. Data (including created admins) may be lost on restart/deploy. Set SQLITE_PATH to a persistent volume path (e.g. /data/botch.db). See docs/PRODUCTION-DATABASE.md'
  );
}

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Initialize schema if not exists
const initSchema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  phone TEXT,
  country TEXT,
  role TEXT CHECK (role IN ('client', 'buyer', 'vendor', 'vendor_admin', 'finance_admin', 'moderator', 'editor', 'admin', 'super_admin', 'agent')) DEFAULT 'client',
  verified INTEGER DEFAULT 0,
  verification_status TEXT CHECK (verification_status IN ('submitted', 'pending_review', 'approved', 'rejected')) DEFAULT 'submitted',
  verified_at DATETIME,
  verification_level TEXT DEFAULT 'basic',
  verification_notes TEXT,
  two_fa_enabled INTEGER DEFAULT 0,
  two_fa_secret TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS role_permissions (
  id TEXT PRIMARY KEY,
  role TEXT CHECK (role IN ('client', 'buyer', 'vendor', 'vendor_admin', 'finance_admin', 'moderator', 'editor', 'admin', 'super_admin', 'agent')) NOT NULL,
  permission_key TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (role, permission_key)
);

CREATE TABLE IF NOT EXISTS vendor_organizations (
  id TEXT PRIMARY KEY,
  legal_name TEXT NOT NULL,
  display_name TEXT,
  registration_country TEXT,
  status TEXT CHECK (status IN ('draft', 'pending_verification', 'approved', 'suspended')) DEFAULT 'pending_verification',
  verification_status TEXT CHECK (verification_status IN ('submitted', 'pending_review', 'approved', 'rejected')) DEFAULT 'submitted',
  verified_at DATETIME,
  verification_level TEXT DEFAULT 'basic',
  verification_notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vendor_memberships (
  id TEXT PRIMARY KEY,
  vendor_org_id TEXT NOT NULL REFERENCES vendor_organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_role TEXT CHECK (org_role IN ('owner', 'manager', 'member')) DEFAULT 'member',
  is_primary_contact INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(vendor_org_id, user_id)
);

CREATE TABLE IF NOT EXISTS vendor_onboarding_fees (
  id TEXT PRIMARY KEY,
  vendor_org_id TEXT NOT NULL REFERENCES vendor_organizations(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  currency TEXT DEFAULT 'USD',
  provider TEXT,
  provider_reference TEXT,
  status TEXT CHECK (status IN ('pending', 'paid', 'failed', 'refunded')) DEFAULT 'pending',
  paid_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vendor_subscriptions (
  id TEXT PRIMARY KEY,
  vendor_org_id TEXT NOT NULL REFERENCES vendor_organizations(id) ON DELETE CASCADE,
  plan_code TEXT,
  amount REAL,
  currency TEXT DEFAULT 'USD',
  interval TEXT CHECK (interval IN ('monthly', 'yearly')),
  provider TEXT,
  provider_subscription_id TEXT,
  status TEXT CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'expired')) DEFAULT 'trialing',
  current_period_start DATETIME,
  current_period_end DATETIME,
  canceled_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vendor_billing_payments (
  id TEXT PRIMARY KEY,
  vendor_org_id TEXT NOT NULL REFERENCES vendor_organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payment_type TEXT CHECK (payment_type IN ('onboarding_fee', 'subscription', 'channel_subscription')) NOT NULL,
  target_id TEXT,
  amount REAL NOT NULL,
  currency TEXT DEFAULT 'USD',
  payment_method TEXT CHECK (payment_method IN ('paystack', 'stripe')) NOT NULL,
  provider_reference TEXT,
  status TEXT CHECK (status IN ('pending', 'completed', 'failed')) DEFAULT 'pending',
  paid_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vendor_channel_plans (
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
);

CREATE TABLE IF NOT EXISTS vendor_channel_subscriptions (
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
);

CREATE TABLE IF NOT EXISTS vendor_featured_plans (
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
);

CREATE TABLE IF NOT EXISTS vendor_listings (
  id TEXT PRIMARY KEY,
  vendor_org_id TEXT REFERENCES vendor_organizations(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_type TEXT CHECK (listing_type IN ('material', 'service')) NOT NULL,
  category TEXT,
  title TEXT NOT NULL,
  description TEXT,
  price REAL,
  currency TEXT DEFAULT 'USD',
  location TEXT,
  media_url TEXT,
  metadata TEXT,
  workflow_state TEXT CHECK (workflow_state IN ('draft', 'pending_review', 'approved', 'rejected', 'published', 'unpublished')) DEFAULT 'draft',
  submitted_at DATETIME,
  approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at DATETIME,
  rejection_reason TEXT,
  featured_status TEXT CHECK (featured_status IN ('none', 'pending', 'active', 'rejected', 'expired')) DEFAULT 'none',
  featured_plan TEXT CHECK (featured_plan IN ('3_days', '7_days', '14_days')),
  featured_duration_days INTEGER,
  featured_requested_at DATETIME,
  featured_requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  featured_approved_at DATETIME,
  featured_approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  featured_expires_at DATETIME,
  featured_price REAL,
  featured_currency TEXT DEFAULT 'USD',
  featured_rejection_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vendor_reviews (
  id TEXT PRIMARY KEY,
  vendor_profile_id TEXT NOT NULL,
  vendor_profile_type TEXT CHECK (vendor_profile_type IN ('organization', 'user')) NOT NULL,
  reviewer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  moderation_status TEXT CHECK (moderation_status IN ('visible', 'flagged', 'hidden')) DEFAULT 'visible',
  moderation_reason TEXT,
  moderated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  moderated_at DATETIME,
  reports_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(vendor_profile_id, vendor_profile_type, reviewer_user_id)
);

CREATE TABLE IF NOT EXISTS vendor_review_reports (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES vendor_reviews(id) ON DELETE CASCADE,
  reporter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(review_id, reporter_user_id)
);

CREATE TABLE IF NOT EXISTS fraud_reports (
  id TEXT PRIMARY KEY,
  reporter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT CHECK (target_type IN ('message', 'property', 'vendor_listing', 'vendor_profile', 'user')) NOT NULL,
  target_id TEXT,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  details TEXT,
  risk_score INTEGER DEFAULT 0,
  risk_level TEXT CHECK (risk_level IN ('low', 'medium', 'high', 'critical')) DEFAULT 'medium',
  status TEXT CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')) DEFAULT 'open',
  admin_note TEXT,
  assigned_to TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at DATETIME,
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  location TEXT,
  package_type TEXT,
  total_cost REAL,
  amount_paid REAL DEFAULT 0,
  progress_percent INTEGER DEFAULT 0,
  status TEXT CHECK (status IN ('pending', 'active', 'completed', 'on_hold')) DEFAULT 'pending',
  start_date DATE,
  estimated_completion DATE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  vendor_org_id TEXT REFERENCES vendor_organizations(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  progress_percent INTEGER DEFAULT 0,
  amount REAL,
  is_paid INTEGER DEFAULT 0,
  order_index INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_agent_assignments (
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
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  invoice_number TEXT UNIQUE NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  milestone_id TEXT REFERENCES milestones(id),
  amount REAL NOT NULL,
  status TEXT CHECK (status IN ('pending', 'paid', 'overdue')) DEFAULT 'pending',
  due_date DATE,
  pdf_url TEXT,
  viewed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT REFERENCES invoices(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  currency TEXT DEFAULT 'USD',
  payment_method TEXT,
  transaction_id TEXT,
  status TEXT CHECK (status IN ('pending', 'completed', 'failed')) DEFAULT 'pending',
  receipt_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS featured_listing_payments (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES vendor_listings(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT CHECK (plan IN ('3_days', '7_days', '14_days')) NOT NULL,
  plan_id TEXT REFERENCES vendor_featured_plans(id) ON DELETE SET NULL,
  plan_name TEXT,
  duration_days INTEGER,
  amount REAL NOT NULL,
  currency TEXT DEFAULT 'USD',
  payment_method TEXT CHECK (payment_method IN ('paystack', 'stripe')) NOT NULL,
  provider_reference TEXT,
  status TEXT CHECK (status IN ('pending', 'completed', 'failed')) DEFAULT 'pending',
  paid_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  uploaded_by TEXT REFERENCES users(id),
  title TEXT,
  description TEXT,
  media_type TEXT CHECK (media_type IN ('photo', 'video', 'drone')),
  file_url TEXT NOT NULL,
  file_size INTEGER,
  metadata TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  sender_id TEXT REFERENCES users(id),
  recipient_id TEXT REFERENCES users(id),
  project_id TEXT REFERENCES projects(id),
  message_text TEXT NOT NULL,
  is_read INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  type TEXT,
  title TEXT,
  message TEXT,
  is_read INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  document_type TEXT DEFAULT 'contract',
  uploaded_by TEXT REFERENCES users(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS message_attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_url TEXT NOT NULL,
  file_name TEXT,
  file_type TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

try {
  // Split and run each CREATE TABLE statement separately
  initSchema.split(';').forEach(stmt => {
    if (stmt.trim()) {
      db.exec(stmt + ';');
    }
  });
  // Performance indexes (OWASP/audit recommendation)
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role)',
    'CREATE INDEX IF NOT EXISTS idx_projects_client_id ON projects(client_id)',
    'CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status)',
    'CREATE INDEX IF NOT EXISTS idx_invoices_project_id ON invoices(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_invoices_client_id ON invoices(client_id)',
    'CREATE INDEX IF NOT EXISTS idx_milestones_project_id ON milestones(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_payments_invoice_id ON payments(invoice_id)',
    'CREATE INDEX IF NOT EXISTS idx_featured_listing_payments_listing ON featured_listing_payments(listing_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_featured_listing_payments_user ON featured_listing_payments(user_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_media_project_id ON media(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_messages_project_id ON messages(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_messages_recipient_id ON messages(recipient_id)',
    'CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_users_verification_status ON users(verification_status, role)',
    'CREATE INDEX IF NOT EXISTS idx_users_verified_at ON users(verified_at)',
  ];
  indexes.forEach((sql) => { try { db.exec(sql); } catch (_) {} });
  // Add title to notifications if table existed without it (existing DBs)
  try {
    db.exec('ALTER TABLE notifications ADD COLUMN title TEXT');
  } catch (_) {
    // column already exists
  }
  // Add 2FA columns to users if missing (existing DBs)
  try {
    db.exec('ALTER TABLE users ADD COLUMN two_fa_enabled INTEGER DEFAULT 0');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE users ADD COLUMN two_fa_secret TEXT');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE users ADD COLUMN verified INTEGER DEFAULT 0');
  } catch (_) {}
  try {
    db.exec("ALTER TABLE users ADD COLUMN verification_status TEXT CHECK (verification_status IN ('submitted', 'pending_review', 'approved', 'rejected')) DEFAULT 'submitted'");
  } catch (_) {}
  try {
    db.exec('ALTER TABLE users ADD COLUMN verified_at DATETIME');
  } catch (_) {}
  try {
    db.exec("ALTER TABLE users ADD COLUMN verification_level TEXT DEFAULT 'basic'");
  } catch (_) {}
  try {
    db.exec('ALTER TABLE users ADD COLUMN verification_notes TEXT');
  } catch (_) {}
  try {
    db.exec("UPDATE users SET verification_status = CASE WHEN COALESCE(verified, 0) = 1 THEN 'approved' ELSE 'submitted' END WHERE verification_status IS NULL OR verification_status = ''");
  } catch (_) {}
  try {
    db.exec("UPDATE users SET verified_at = COALESCE(verified_at, created_at) WHERE COALESCE(verified, 0) = 1");
  } catch (_) {}
  try {
    db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE users ADD COLUMN email_verification_token TEXT');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE users ADD COLUMN email_verification_expires_at DATETIME');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE users ADD COLUMN password_reset_token TEXT');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE users ADD COLUMN password_reset_expires_at DATETIME');
  } catch (_) {}
  // KYC/AML: level = none | basic (onboarding) | full (AML done); provider = smile_id | sumsub | dojah | manual
  try {
    db.exec("ALTER TABLE users ADD COLUMN kyc_level TEXT DEFAULT 'none'");
  } catch (_) {}
  try {
    db.exec('ALTER TABLE users ADD COLUMN verification_provider TEXT');
  } catch (_) {}
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS project_documents (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      document_type TEXT DEFAULT 'contract',
      uploaded_by TEXT REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (_) {}
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS message_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      file_url TEXT NOT NULL,
      file_name TEXT,
      file_type TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (_) {}
  // Login OTP (optional step after password)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS login_otp_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      channel TEXT CHECK (channel IN ('email', 'sms')) DEFAULT 'email',
      expires_at DATETIME NOT NULL,
      used_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (_) {}
  // Audit log for admin actions
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      details TEXT,
      ip TEXT,
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (_) {}
  // KYC documents (ID upload, admin approval)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS kyc_documents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      document_type TEXT CHECK (document_type IN ('id_front', 'id_back', 'passport', 'ghana_card', 'other')) DEFAULT 'id_front',
      file_url TEXT NOT NULL,
      file_path TEXT,
      status TEXT CHECK (status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
      reviewed_by TEXT REFERENCES users(id),
      reviewed_at DATETIME,
      rejection_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (_) {}
  // KYC/AML: verification sessions (Smile ID, Sumsub, Dojah provider-agnostic)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS user_verifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT CHECK (provider IN ('smile_id', 'sumsub', 'dojah', 'manual')) DEFAULT 'manual',
      external_id TEXT,
      document_type TEXT CHECK (document_type IN ('ghana_card', 'passport')) DEFAULT 'passport',
      status TEXT CHECK (status IN ('pending', 'in_progress', 'verified', 'failed')) DEFAULT 'pending',
      liveness_status TEXT,
      aml_status TEXT,
      aml_details TEXT,
      hosted_url TEXT,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (_) {}
  // AML screenings (PEP, sanctions, OFAC; onboarding / pre-transaction / ongoing)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS aml_screenings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT,
      trigger TEXT CHECK (trigger IN ('onboarding', 'pre_transaction', 'ongoing')) DEFAULT 'onboarding',
      result TEXT CHECK (result IN ('clear', 'hit', 'pending')) DEFAULT 'pending',
      pep INTEGER DEFAULT 0,
      sanctions INTEGER DEFAULT 0,
      details TEXT,
      screened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (_) {}
  // Agent/Broker licenses (REAC Ghana)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_licenses (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
      reac_license_number TEXT NOT NULL,
      reac_id TEXT,
      status TEXT CHECK (status IN ('pending', 'verified', 'rejected')) DEFAULT 'pending',
      verified_at DATETIME,
      verified_by TEXT REFERENCES users(id),
      rejection_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (_) {}
  // Beneficial owners (UBOs): entity = project or company; natural person with stake %
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS beneficial_owners (
      id TEXT PRIMARY KEY,
      entity_type TEXT CHECK (entity_type IN ('project', 'company')) DEFAULT 'project',
      entity_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stake_percent REAL NOT NULL,
      role TEXT,
      verified INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (_) {}
  // Biometric liveness (selfie) for KYC — stored separately for security; one per user per verification flow
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS kyc_liveness (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_url TEXT NOT NULL,
      file_path TEXT,
      flow_type TEXT CHECK (flow_type IN ('ghana_card', 'passport')) DEFAULT 'passport',
      status TEXT CHECK (status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
      reviewed_by TEXT REFERENCES users(id),
      reviewed_at DATETIME,
      rejection_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (_) {}
  // Property listings (for smart search: price, type, amenities)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS properties (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      property_type TEXT CHECK (property_type IN ('apartment', 'villa', 'house', 'cabin', 'treehouse', 'other')) DEFAULT 'apartment',
      bedrooms INTEGER DEFAULT 0,
      bathrooms INTEGER DEFAULT 1,
      location TEXT,
      area TEXT,
      price REAL NOT NULL,
      currency TEXT DEFAULT 'USD',
      image_url TEXT,
      amenities TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    // Seed sample listings for smart search demo
    const seedId = 'seed-prop-001';
    try {
      db.prepare('INSERT OR IGNORE INTO properties (id, title, description, property_type, bedrooms, bathrooms, location, area, price, currency, image_url, amenities) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        seedId,
        '3-Bedroom Apartment in East Legon',
        'Spacious modern apartment with pool and backup generator. Prime East Legon location.',
        'apartment',
        3,
        2,
        'Accra',
        'East Legon',
        1850,
        'USD',
        'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?w=800&q=85',
        '["pool","generator","parking","security","ac","wifi"]'
      );
    } catch (_) {}
    try {
      db.prepare('INSERT OR IGNORE INTO properties (id, title, description, property_type, bedrooms, bathrooms, location, area, price, currency, image_url, amenities) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        'seed-prop-002',
        'Luxury 4-Bed Villa, East Legon',
        'Premium villa with pool, generator, and 24/7 security.',
        'villa',
        4,
        4,
        'Accra',
        'East Legon',
        4500,
        'USD',
        'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=800&q=85',
        '["pool","generator","parking","security","ac","wifi"]'
      );
    } catch (_) {}
    try {
      db.prepare('INSERT OR IGNORE INTO properties (id, title, description, property_type, bedrooms, bathrooms, location, area, price, currency, image_url, amenities) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        'seed-prop-003',
        '2-Bed Apartment, Cantonments',
        'Cozy apartment near business district. Backup generator included.',
        'apartment',
        2,
        1,
        'Accra',
        'Cantonments',
        1200,
        'USD',
        'https://images.unsplash.com/photo-1512917774080-9991f1c4c750?w=800&q=85',
        '["generator","parking","wifi"]'
      );
    } catch (_) {}
    try {
      db.prepare('UPDATE properties SET image_url = ? WHERE id = ? AND (image_url IS NULL OR image_url = "")').run(
        'https://images.unsplash.com/photo-1512917774080-9991f1c4c750?w=800&q=85',
        'seed-prop-003'
      );
    } catch (_) {}
    db.exec(`CREATE TABLE IF NOT EXISTS property_images (
      id TEXT PRIMARY KEY,
      property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      file_url TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    // Flexible listing model for sales + rentals
    try { db.exec("ALTER TABLE properties ADD COLUMN status TEXT CHECK (status IN ('draft', 'published')) DEFAULT 'published'"); } catch (_) {}
    try { db.exec("ALTER TABLE properties ADD COLUMN slug TEXT"); } catch (_) {}
    try { db.exec("ALTER TABLE properties ADD COLUMN listing_purpose TEXT CHECK (listing_purpose IN ('sale', 'rent')) DEFAULT 'sale'"); } catch (_) {}
    try { db.exec("ALTER TABLE properties ADD COLUMN rent_type TEXT CHECK (rent_type IN ('short_stay', 'long_term'))"); } catch (_) {}
    try { db.exec("ALTER TABLE properties ADD COLUMN furnished_status TEXT CHECK (furnished_status IN ('furnished', 'unfurnished', 'part_furnished'))"); } catch (_) {}
    try { db.exec("ALTER TABLE properties ADD COLUMN availability_status TEXT CHECK (availability_status IN ('available', 'unavailable', 'booked')) DEFAULT 'available'"); } catch (_) {}
    try { db.exec("ALTER TABLE properties ADD COLUMN featured INTEGER DEFAULT 0"); } catch (_) {}
    try { db.exec("ALTER TABLE properties ADD COLUMN is_new INTEGER DEFAULT 0"); } catch (_) {}
    try { db.exec("ALTER TABLE properties ADD COLUMN short_description TEXT"); } catch (_) {}
    try { db.exec("ALTER TABLE properties ADD COLUMN address TEXT"); } catch (_) {}
    try { db.exec("ALTER TABLE properties ADD COLUMN square_footage INTEGER"); } catch (_) {}
    try { db.exec("ALTER TABLE properties ADD COLUMN publish_status TEXT CHECK (publish_status IN ('draft', 'published', 'unpublished')) DEFAULT 'published'"); } catch (_) {}
    try { db.exec('ALTER TABLE properties ADD COLUMN region TEXT'); } catch (_) {}
    try { db.exec('ALTER TABLE properties ADD COLUMN city TEXT'); } catch (_) {}
    try { db.exec('ALTER TABLE properties ADD COLUMN created_by TEXT'); } catch (_) {}
    // No DEFAULT CURRENT_TIMESTAMP here: older SQLite rejects non-constant defaults on ADD COLUMN.
    try { db.exec('ALTER TABLE properties ADD COLUMN updated_at DATETIME'); } catch (_) {}
    try { db.exec('UPDATE properties SET updated_at = created_at WHERE updated_at IS NULL'); } catch (_) {}
    try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_properties_slug ON properties(slug)"); } catch (_) {}
    try { db.exec("CREATE INDEX IF NOT EXISTS idx_properties_listing_purpose ON properties(listing_purpose)"); } catch (_) {}
    try { db.exec("CREATE INDEX IF NOT EXISTS idx_properties_featured ON properties(featured)"); } catch (_) {}
    try { db.exec("CREATE INDEX IF NOT EXISTS idx_properties_publish_status ON properties(publish_status)"); } catch (_) {}
    try { db.exec("CREATE INDEX IF NOT EXISTS idx_properties_status ON properties(status)"); } catch (_) {}
    try { db.exec("UPDATE properties SET status = 'published' WHERE status IS NULL OR status = ''"); } catch (_) {}
    try {
      db.exec(
        "ALTER TABLE properties ADD COLUMN moderation_status TEXT CHECK (moderation_status IN ('pending', 'approved', 'rejected')) DEFAULT 'approved'"
      );
    } catch (_) {}
    try {
      db.exec("UPDATE properties SET moderation_status = 'approved' WHERE moderation_status IS NULL OR moderation_status = ''");
    } catch (_) {}
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_properties_moderation ON properties(moderation_status)');
    } catch (_) {}
    try {
      db.exec(
        "ALTER TABLE properties ADD COLUMN authenticity_status TEXT CHECK (authenticity_status IN ('not_submitted', 'pending', 'approved', 'rejected')) DEFAULT 'not_submitted'"
      );
    } catch (_) {}
    try { db.exec('ALTER TABLE properties ADD COLUMN ownership_proof_url TEXT'); } catch (_) {}
    try { db.exec('ALTER TABLE properties ADD COLUMN mandate_proof_url TEXT'); } catch (_) {}
    try { db.exec('ALTER TABLE properties ADD COLUMN authenticity_notes TEXT'); } catch (_) {}
    try { db.exec('ALTER TABLE properties ADD COLUMN authenticity_reviewed_at DATETIME'); } catch (_) {}
    try { db.exec('ALTER TABLE properties ADD COLUMN authenticity_reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL'); } catch (_) {}
    try {
      db.exec("UPDATE properties SET authenticity_status = 'not_submitted' WHERE authenticity_status IS NULL OR authenticity_status = ''");
    } catch (_) {}
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_properties_authenticity_status ON properties(authenticity_status)');
    } catch (_) {}
    try {
      db.exec(
        "ALTER TABLE properties ADD COLUMN listing_state TEXT CHECK (listing_state IN ('draft','pending_review','approved','published','paused','sold','rented','archived','rejected'))"
      );
    } catch (_) {}
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_properties_listing_state ON properties(listing_state)');
    } catch (_) {}
    try {
      db.exec(
        `UPDATE properties SET listing_state = 'published' WHERE listing_state IS NULL
         AND COALESCE(moderation_status,'approved') = 'approved'
         AND COALESCE(publish_status,'published') = 'published'
         AND COALESCE(status,'published') = 'published'`
      );
      db.exec(`UPDATE properties SET listing_state = 'rejected' WHERE listing_state IS NULL AND moderation_status = 'rejected'`);
      db.exec(
        `UPDATE properties SET listing_state = 'approved' WHERE listing_state IS NULL
         AND COALESCE(moderation_status,'') = 'approved' AND COALESCE(publish_status,'draft') = 'draft'`
      );
      db.exec(
        `UPDATE properties SET listing_state = 'pending_review' WHERE listing_state IS NULL
         AND moderation_status = 'pending' AND COALESCE(publish_status,'draft') = 'draft'`
      );
      db.exec(`UPDATE properties SET listing_state = 'draft' WHERE listing_state IS NULL`);
    } catch (_) {}
  } catch (_) {}
  // Push notification subscriptions (web push)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (_) {}
  try {
    db.exec('ALTER TABLE users ADD COLUMN login_otp_enabled INTEGER DEFAULT 0');
  } catch (_) {}
  // WebAuthn / biometric credentials (fingerprint, face)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      credential_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      webauthn_user_id TEXT NOT NULL,
      device_type TEXT,
      backed_up INTEGER DEFAULT 0,
      transports TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (_) {}
  try {
    db.exec('ALTER TABLE invoices ADD COLUMN currency TEXT');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE invoices ADD COLUMN due_notified_at DATETIME');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE project_documents ADD COLUMN file_url TEXT');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE projects ADD COLUMN live_stream_url TEXT');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE projects ADD COLUMN client_can_view_live_stream INTEGER DEFAULT 0');
  } catch (_) {}
  // AWS IVS Phase 2: live stream config per project
  try {
    db.exec('ALTER TABLE projects ADD COLUMN ivs_stream_key TEXT');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE projects ADD COLUMN ivs_ingest_url TEXT');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE projects ADD COLUMN ivs_playback_url TEXT');
  } catch (_) {}
  // Agent/vendor: projects assigned to agent for management
  try {
    db.exec('ALTER TABLE projects ADD COLUMN vendor_id TEXT');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE users ADD COLUMN vendor_org_id TEXT REFERENCES vendor_organizations(id) ON DELETE SET NULL');
  } catch (_) {}
  try {
    db.exec(
      "ALTER TABLE users ADD COLUMN signup_vendor_channel TEXT CHECK (signup_vendor_channel IN ('marketplace', 'properties', 'rentals'))"
    );
  } catch (_) {}
  try {
    db.exec('ALTER TABLE users ADD COLUMN avatar_url TEXT');
  } catch (_) {}
  try {
    db.exec("ALTER TABLE vendor_organizations ADD COLUMN verification_status TEXT CHECK (verification_status IN ('submitted', 'pending_review', 'approved', 'rejected')) DEFAULT 'submitted'");
  } catch (_) {}
  try {
    db.exec('ALTER TABLE vendor_organizations ADD COLUMN verified_at DATETIME');
  } catch (_) {}
  try {
    db.exec("ALTER TABLE vendor_organizations ADD COLUMN verification_level TEXT DEFAULT 'basic'");
  } catch (_) {}
  try {
    db.exec('ALTER TABLE vendor_organizations ADD COLUMN verification_notes TEXT');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE vendor_organizations ADD COLUMN cover_photo_url TEXT');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE vendor_organizations ADD COLUMN logo_url TEXT');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE vendor_organizations ADD COLUMN module_marketplace_enabled INTEGER');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE vendor_organizations ADD COLUMN module_properties_enabled INTEGER');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE vendor_organizations ADD COLUMN module_rentals_enabled INTEGER');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE vendor_organizations ADD COLUMN is_partner INTEGER DEFAULT 0');
  } catch (_) {}
  try {
    db.exec("ALTER TABLE vendor_organizations ADD COLUMN vendor_source TEXT DEFAULT 'self_service'");
  } catch (_) {}
  try {
    db.exec(`UPDATE vendor_organizations
      SET module_marketplace_enabled = COALESCE(module_marketplace_enabled, 1),
          module_properties_enabled = COALESCE(module_properties_enabled, 1),
          module_rentals_enabled = COALESCE(module_rentals_enabled, 1)
      WHERE module_marketplace_enabled IS NULL
         OR module_properties_enabled IS NULL
         OR module_rentals_enabled IS NULL`);
  } catch (_) {}
  try {
    db.exec("UPDATE vendor_organizations SET verification_status = CASE WHEN status = 'approved' THEN 'approved' ELSE COALESCE(verification_status, 'submitted') END");
  } catch (_) {}
  try {
    db.exec('ALTER TABLE projects ADD COLUMN vendor_org_id TEXT REFERENCES vendor_organizations(id) ON DELETE SET NULL');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_vendor_org_status ON vendor_organizations(status)');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_vendor_memberships_org ON vendor_memberships(vendor_org_id)');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_vendor_memberships_user ON vendor_memberships(user_id)');
  } catch (_) {}
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_memberships_primary_contact ON vendor_memberships(vendor_org_id) WHERE is_primary_contact = 1');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_vendor_onboarding_fees_org ON vendor_onboarding_fees(vendor_org_id)');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_vendor_onboarding_fees_status ON vendor_onboarding_fees(status)');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_vendor_subscriptions_org ON vendor_subscriptions(vendor_org_id)');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_vendor_subscriptions_status ON vendor_subscriptions(status)');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_vendor_billing_payments_org ON vendor_billing_payments(vendor_org_id, created_at)');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_vendor_billing_payments_user ON vendor_billing_payments(user_id, created_at)');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_vendor_listings_org ON vendor_listings(vendor_org_id)');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_vendor_listings_creator ON vendor_listings(created_by)');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_vendor_listings_type ON vendor_listings(listing_type)');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_vendor_listings_state ON vendor_listings(workflow_state)');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_vendor_listings_featured_status ON vendor_listings(featured_status, featured_expires_at)');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_vendor_reviews_profile ON vendor_reviews(vendor_profile_id, vendor_profile_type)');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_vendor_reviews_reviewer ON vendor_reviews(reviewer_user_id)');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_vendor_reviews_moderation ON vendor_reviews(moderation_status, reports_count)');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_vendor_review_reports_review ON vendor_review_reports(review_id)');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_fraud_reports_status ON fraud_reports(status, created_at)');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_fraud_reports_risk ON fraud_reports(status, risk_score, created_at)');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_fraud_reports_target ON fraud_reports(target_type, target_id)');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_fraud_reports_project ON fraud_reports(project_id, created_at)');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_vendor_org_id ON users(vendor_org_id)');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_projects_vendor_org_id ON projects(vendor_org_id)');
  } catch (_) {}
  try {
    db.exec("ALTER TABLE vendor_reviews ADD COLUMN moderation_status TEXT CHECK (moderation_status IN ('visible', 'flagged', 'hidden')) DEFAULT 'visible'");
  } catch (_) {}
  try {
    db.exec('ALTER TABLE vendor_reviews ADD COLUMN moderation_reason TEXT');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE vendor_reviews ADD COLUMN moderated_by TEXT REFERENCES users(id) ON DELETE SET NULL');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE vendor_reviews ADD COLUMN moderated_at DATETIME');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE vendor_reviews ADD COLUMN reports_count INTEGER DEFAULT 0');
  } catch (_) {}
  try {
    db.exec("ALTER TABLE fraud_reports ADD COLUMN risk_score INTEGER DEFAULT 0");
  } catch (_) {}
  try {
    db.exec("ALTER TABLE fraud_reports ADD COLUMN risk_level TEXT CHECK (risk_level IN ('low', 'medium', 'high', 'critical')) DEFAULT 'medium'");
  } catch (_) {}
  try {
    db.exec("UPDATE fraud_reports SET risk_level = 'medium' WHERE risk_level IS NULL OR risk_level = ''");
  } catch (_) {}
  try {
    db.exec("ALTER TABLE vendor_listings ADD COLUMN featured_status TEXT CHECK (featured_status IN ('none', 'pending', 'active', 'rejected', 'expired')) DEFAULT 'none'");
  } catch (_) {}
  try {
    db.exec("ALTER TABLE vendor_listings ADD COLUMN featured_plan TEXT CHECK (featured_plan IN ('3_days', '7_days', '14_days'))");
  } catch (_) {}
  try {
    db.exec('ALTER TABLE vendor_listings ADD COLUMN featured_requested_at DATETIME');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE vendor_listings ADD COLUMN featured_requested_by TEXT REFERENCES users(id) ON DELETE SET NULL');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE vendor_listings ADD COLUMN featured_approved_at DATETIME');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE vendor_listings ADD COLUMN featured_approved_by TEXT REFERENCES users(id) ON DELETE SET NULL');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE vendor_listings ADD COLUMN featured_expires_at DATETIME');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE vendor_listings ADD COLUMN featured_price REAL');
  } catch (_) {}
  try {
    db.exec("ALTER TABLE vendor_listings ADD COLUMN featured_currency TEXT DEFAULT 'USD'");
  } catch (_) {}
  try {
    db.exec('ALTER TABLE vendor_listings ADD COLUMN featured_rejection_reason TEXT');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE vendor_listings ADD COLUMN featured_duration_days INTEGER');
  } catch (_) {}
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS vendor_featured_plans (
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
    db.exec('CREATE INDEX IF NOT EXISTS idx_vendor_featured_plans_channel ON vendor_featured_plans(channel, sort_order)');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE featured_listing_payments ADD COLUMN plan_id TEXT REFERENCES vendor_featured_plans(id) ON DELETE SET NULL');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE featured_listing_payments ADD COLUMN plan_name TEXT');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE featured_listing_payments ADD COLUMN duration_days INTEGER');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE properties ADD COLUMN featured_duration_days INTEGER');
  } catch (_) {}
  // E2EE: user public key (for message encryption)
  try {
    db.exec('ALTER TABLE users ADD COLUMN public_key TEXT');
  } catch (_) {}
  // E2EE: messages can store encrypted payload; server never sees plaintext when is_encrypted=1
  try {
    db.exec('ALTER TABLE messages ADD COLUMN is_encrypted INTEGER DEFAULT 0');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE messages ADD COLUMN sender_public_key TEXT');
  } catch (_) {}
  // WhatsApp-style read receipts: delivered_at = recipient online; is_read = viewed
  try {
    db.exec('ALTER TABLE messages ADD COLUMN delivered_at DATETIME');
  } catch (_) {}
  // Message reactions (emoji)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS message_reactions (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(message_id, user_id, emoji)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id ON message_reactions(message_id)');
  } catch (_) {}
  // Pinned messages per project
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS pinned_messages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      pinned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, message_id)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_pinned_messages_project_id ON pinned_messages(project_id)');
  } catch (_) {}
  // Project activity timeline
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS project_activity (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      activity_type TEXT NOT NULL,
      reference_id TEXT,
      actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_project_activity_project_id ON project_activity(project_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_project_activity_created_at ON project_activity(project_id, created_at)');
  } catch (_) {}
  // Verified Construction Transparency: allow admins to mark project_activity as verified
  try {
    db.exec('ALTER TABLE project_activity ADD COLUMN verified_at DATETIME');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE project_activity ADD COLUMN verified_by TEXT REFERENCES users(id) ON DELETE SET NULL');
  } catch (_) {}
  // Media: optional GPS in metadata (JSON: { latitude, longitude })
  try {
    db.exec('ALTER TABLE media ADD COLUMN metadata TEXT');
  } catch (_) {}
  // Escalations
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS escalations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      raised_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT,
      status TEXT CHECK (status IN ('open', 'acknowledged', 'resolved')) DEFAULT 'open',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_escalations_project_id ON escalations(project_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status)');
  } catch (_) {}
  // Escrow smart contracts (per project)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS project_escrow (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE UNIQUE,
      chain TEXT NOT NULL,
      contract_address TEXT NOT NULL,
      amount REAL,
      currency TEXT DEFAULT 'USD',
      status TEXT CHECK (status IN ('active', 'released', 'disputed')) DEFAULT 'active',
      explorer_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (_) {}
  // Project mortgage (one per project: lender, amount, status)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS project_mortgage (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE UNIQUE,
      lender_name TEXT,
      amount REAL,
      interest_rate REAL,
      term_months INTEGER,
      status TEXT CHECK (status IN ('inquiry', 'applied', 'approved', 'active', 'paid_off', 'rejected')) DEFAULT 'inquiry',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (_) {}
  // Project progress notes (admin adds; client visibility toggle)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS project_progress_notes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      note TEXT NOT NULL,
      visible_to_client INTEGER DEFAULT 1,
      created_by TEXT REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (_) {}
  // Appointments: client books meeting with admin/project manager
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      property_id TEXT REFERENCES properties(id) ON DELETE SET NULL,
      agent_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      preferred_date DATE,
      preferred_time TEXT,
      scheduled_date DATE,
      scheduled_time TEXT,
      notes TEXT,
      reschedule_note TEXT,
      cancellation_reason TEXT,
      status TEXT CHECK (status IN ('pending', 'confirmed', 'rescheduled', 'cancelled', 'completed')) DEFAULT 'pending',
      reminder_at DATETIME,
      reminder_sent_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_appointments_property_id ON appointments(property_id)');
    } catch (_) {}
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_appointments_agent_id ON appointments(agent_id)');
    } catch (_) {}
    try {
      db.exec('ALTER TABLE properties ADD COLUMN listing_agent_id TEXT REFERENCES users(id) ON DELETE SET NULL');
    } catch (_) {}
    try { db.exec("ALTER TABLE properties ADD COLUMN featured_status TEXT DEFAULT 'none'"); } catch (_) {}
    try { db.exec('ALTER TABLE properties ADD COLUMN featured_plan TEXT'); } catch (_) {}
    try { db.exec('ALTER TABLE properties ADD COLUMN featured_requested_at DATETIME'); } catch (_) {}
    try { db.exec('ALTER TABLE properties ADD COLUMN featured_requested_by TEXT REFERENCES users(id) ON DELETE SET NULL'); } catch (_) {}
    try { db.exec('ALTER TABLE properties ADD COLUMN featured_approved_at DATETIME'); } catch (_) {}
    try { db.exec('ALTER TABLE properties ADD COLUMN featured_approved_by TEXT REFERENCES users(id) ON DELETE SET NULL'); } catch (_) {}
    try { db.exec('ALTER TABLE properties ADD COLUMN featured_expires_at DATETIME'); } catch (_) {}
    try { db.exec('ALTER TABLE properties ADD COLUMN featured_price REAL'); } catch (_) {}
    try { db.exec("ALTER TABLE properties ADD COLUMN featured_currency TEXT DEFAULT 'USD'"); } catch (_) {}
    try { db.exec('ALTER TABLE properties ADD COLUMN featured_rejection_reason TEXT'); } catch (_) {}
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_properties_featured_status ON properties(featured_status, featured_expires_at)');
    } catch (_) {}
    db.exec(`CREATE TABLE IF NOT EXISTS property_favorites (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, property_id)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_property_favorites_user ON property_favorites(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_property_favorites_property ON property_favorites(property_id)');
    db.exec(`CREATE TABLE IF NOT EXISTS saved_searches (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      search_scope TEXT CHECK (search_scope IN ('properties', 'rentals', 'marketplace', 'vendor_listings')) DEFAULT 'properties',
      filters_json TEXT NOT NULL,
      query_string TEXT,
      is_active INTEGER DEFAULT 1,
      alert_frequency TEXT CHECK (alert_frequency IN ('instant', 'daily', 'weekly')) DEFAULT 'instant',
      notify_email INTEGER DEFAULT 1,
      notify_push INTEGER DEFAULT 0,
      last_notified_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_saved_searches_user ON saved_searches(user_id, created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_saved_searches_active ON saved_searches(is_active)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_saved_searches_frequency ON saved_searches(alert_frequency)');
    db.exec(`CREATE TABLE IF NOT EXISTS analytics_events (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      session_id TEXT,
      event_name TEXT NOT NULL,
      event_source TEXT,
      page_path TEXT,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_analytics_events_name_time ON analytics_events(event_name, created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_analytics_events_user_time ON analytics_events(user_id, created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_analytics_events_session_time ON analytics_events(session_id, created_at)');
    try { db.exec("ALTER TABLE saved_searches ADD COLUMN alert_frequency TEXT CHECK (alert_frequency IN ('instant', 'daily', 'weekly')) DEFAULT 'instant'"); } catch (_) {}
    // Compatibility fallback for older SQLite engines that reject ADD COLUMN with CHECK.
    try { db.exec("ALTER TABLE saved_searches ADD COLUMN alert_frequency TEXT DEFAULT 'instant'"); } catch (_) {}
    try { db.exec("UPDATE saved_searches SET alert_frequency = 'instant' WHERE alert_frequency IS NULL OR alert_frequency = ''"); } catch (_) {}
    db.exec(`CREATE TABLE IF NOT EXISTS listing_inquiries (
      id TEXT PRIMARY KEY,
      property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      vendor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message TEXT,
      lead_status TEXT CHECK (lead_status IN ('new', 'contacted', 'interested', 'inspection_booked', 'negotiating', 'closed_won', 'closed_lost')) DEFAULT 'new',
      assigned_to TEXT NOT NULL REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_listing_inquiries_property ON listing_inquiries(property_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_listing_inquiries_vendor ON listing_inquiries(vendor_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_listing_inquiries_assigned_to ON listing_inquiries(assigned_to)');
    db.exec(`CREATE TABLE IF NOT EXISTS listing_offers (
      id TEXT PRIMARY KEY,
      property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      vendor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'USD',
      terms_note TEXT,
      status TEXT CHECK (status IN ('submitted', 'under_review', 'accepted', 'rejected', 'withdrawn')) DEFAULT 'submitted',
      admin_note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_listing_offers_property ON listing_offers(property_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_listing_offers_vendor ON listing_offers(vendor_id)');
    db.exec(`CREATE TABLE IF NOT EXISTS rental_applications (
      id TEXT PRIMARY KEY,
      property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      vendor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      move_in_date DATE,
      employment_note TEXT,
      notes TEXT,
      status TEXT CHECK (status IN ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'withdrawn')) DEFAULT 'draft',
      admin_note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_rental_applications_property ON rental_applications(property_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_rental_applications_vendor ON rental_applications(vendor_id)');
  } catch (_) {}
  // One-time: migrate listing_inquiries from legacy lead_status + nullable assigned_to
  try {
    try {
      db.exec('ALTER TABLE properties ADD COLUMN listing_agent_id TEXT REFERENCES users(id) ON DELETE SET NULL');
    } catch (_) {}
    const liRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='listing_inquiries'").get();
    if (liRow && liRow.sql && (liRow.sql.includes('qualified') || liRow.sql.includes('converted'))) {
      const firstAdmin = db
        .prepare("SELECT id FROM users WHERE role IN ('admin', 'super_admin') ORDER BY created_at LIMIT 1")
        .get();
      const fallbackAgent = firstAdmin?.id;
      if (!fallbackAgent) {
        console.warn('[sqlite] listing_inquiries migration skipped: no admin user');
      } else {
        db.exec('PRAGMA foreign_keys = OFF');
        db.exec(`CREATE TABLE listing_inquiries_new (
          id TEXT PRIMARY KEY,
          property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
          vendor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          message TEXT,
          lead_status TEXT CHECK (lead_status IN ('new', 'contacted', 'interested', 'inspection_booked', 'negotiating', 'closed_won', 'closed_lost')) DEFAULT 'new',
          assigned_to TEXT NOT NULL REFERENCES users(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        db.prepare(
          `INSERT INTO listing_inquiries_new (id, property_id, vendor_id, message, lead_status, assigned_to, created_at, updated_at)
           SELECT
             id, property_id, client_id, message,
             CASE lead_status
               WHEN 'qualified' THEN 'interested'
               WHEN 'converted' THEN 'closed_won'
               WHEN 'lost' THEN 'closed_lost'
               ELSE lead_status
             END,
             COALESCE(assigned_to, ?),
             created_at, updated_at
           FROM listing_inquiries`
        ).run(fallbackAgent);
        db.exec('DROP TABLE listing_inquiries');
        db.exec('ALTER TABLE listing_inquiries_new RENAME TO listing_inquiries');
        db.exec('CREATE INDEX IF NOT EXISTS idx_listing_inquiries_property ON listing_inquiries(property_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_listing_inquiries_vendor ON listing_inquiries(vendor_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_listing_inquiries_lead_status ON listing_inquiries(lead_status)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_listing_inquiries_assigned_to ON listing_inquiries(assigned_to)');
        db.exec('PRAGMA foreign_keys = ON');
        console.log('✓ Migrated listing_inquiries to new lead pipeline');
      }
    }
  } catch (e) {
    try {
      db.exec('PRAGMA foreign_keys = ON');
    } catch (_) {}
    console.error('listing_inquiries migration error:', e.message);
  }
  // One-time: marketplace lead tables client_id -> vendor_id + unique (property_id, vendor_id) on inquiries
  try {
    const colNames = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    for (const t of ['listing_inquiries', 'listing_offers', 'rental_applications']) {
      const cols = colNames(t);
      if (cols.includes('client_id') && !cols.includes('vendor_id')) {
        try {
          db.exec(`ALTER TABLE ${t} RENAME COLUMN client_id TO vendor_id`);
        } catch (err) {
          console.warn(`[sqlite] ${t} client_id->vendor_id:`, err.message);
        }
      }
    }
    db.exec('DROP INDEX IF EXISTS idx_listing_inquiries_client');
    db.exec('DROP INDEX IF EXISTS idx_listing_offers_client');
    db.exec('DROP INDEX IF EXISTS idx_rental_applications_client');
    db.exec('CREATE INDEX IF NOT EXISTS idx_listing_inquiries_vendor ON listing_inquiries(vendor_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_listing_offers_vendor ON listing_offers(vendor_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_rental_applications_vendor ON rental_applications(vendor_id)');
    try {
      db.prepare(
        `DELETE FROM listing_inquiries WHERE id IN (
          SELECT id FROM (
            SELECT id,
              ROW_NUMBER() OVER (PARTITION BY property_id, vendor_id ORDER BY datetime(created_at) DESC) AS rn
            FROM listing_inquiries
          ) WHERE rn > 1
        )`
      ).run();
    } catch (_) {}
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_inquiries_property_vendor ON listing_inquiries(property_id, vendor_id)'
    );
  } catch (e) {
    console.warn('[sqlite] marketplace vendor_id migration:', e.message);
  }
  // One-time: migrate appointments to extended booking workflow
  try {
    const apRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='appointments'").get();
    if (apRow && apRow.sql && !apRow.sql.includes('rescheduled')) {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec(`CREATE TABLE appointments_mig (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        property_id TEXT REFERENCES properties(id) ON DELETE SET NULL,
        agent_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        preferred_date DATE,
        preferred_time TEXT,
        scheduled_date DATE,
        scheduled_time TEXT,
        notes TEXT,
        reschedule_note TEXT,
        cancellation_reason TEXT,
        status TEXT CHECK (status IN ('pending', 'confirmed', 'rescheduled', 'cancelled', 'completed')) DEFAULT 'pending',
        reminder_at DATETIME,
        reminder_sent_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      const cols = db.prepare('PRAGMA table_info(appointments)').all();
      const names = new Set(cols.map((c) => c.name));
      const hasProp = names.has('property_id');
      db.prepare(
        `INSERT INTO appointments_mig (
          id, client_id, project_id, property_id, agent_id, title, preferred_date, preferred_time,
          scheduled_date, scheduled_time, notes, reschedule_note, cancellation_reason, status,
          reminder_at, reminder_sent_at, created_at, updated_at
        )
        SELECT
          id, client_id, project_id,
          ${hasProp ? 'property_id' : 'NULL'},
          NULL, title, preferred_date, preferred_time,
          NULL, NULL, notes, NULL, NULL,
          status, NULL, NULL, created_at, updated_at
        FROM appointments`
      ).run();
      db.exec('DROP TABLE appointments');
      db.exec('ALTER TABLE appointments_mig RENAME TO appointments');
      db.exec('CREATE INDEX IF NOT EXISTS idx_appointments_client_id ON appointments(client_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_appointments_property_id ON appointments(property_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_appointments_agent_id ON appointments(agent_id)');
      db.exec('PRAGMA foreign_keys = ON');
      console.log('✓ Migrated appointments table for property viewing workflow');
    }
  } catch (e) {
    try {
      db.exec('PRAGMA foreign_keys = ON');
    } catch (_) {}
    console.error('appointments migration error:', e.message);
  }
  // Site inspections: client requests, admin assigns inspector, inspector uploads report + photos
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS site_inspections (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT CHECK (status IN ('requested', 'assigned', 'scheduled', 'completed', 'cancelled')) DEFAULT 'requested',
      assigned_inspector_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      scheduled_at DATETIME,
      client_notes TEXT,
      admin_notes TEXT,
      report_text TEXT,
      report_file_url TEXT,
      reported_at DATETIME,
      reported_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS inspection_photos (
      id TEXT PRIMARY KEY,
      inspection_id TEXT NOT NULL REFERENCES site_inspections(id) ON DELETE CASCADE,
      file_url TEXT NOT NULL,
      caption TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (_) {}
  // Project progress reports: weekly summaries (milestones, photos, financial)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS project_progress_reports (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      summary_text TEXT NOT NULL,
      milestones_completed TEXT,
      new_photos_count INTEGER DEFAULT 0,
      financial_summary TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      email_sent_at DATETIME
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS project_report_preferences (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      send_weekly_email INTEGER DEFAULT 1,
      PRIMARY KEY (project_id, user_id)
    )`);
  } catch (_) {}
    // Client ratings per project (rated user may be marketplace vendor or field agent)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS contractor_ratings (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      contractor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
      comment TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, client_id)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_contractor_ratings_contractor_id ON contractor_ratings(contractor_id)');
  } catch (_) {}
  // House plans marketplace and purchase gating
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS house_plans (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      architect_name TEXT NOT NULL,
      architect_bio TEXT,
      building_type TEXT,
      category TEXT,
      description TEXT,
      tags TEXT,
      price REAL NOT NULL,
      currency TEXT DEFAULT 'USD',
      size_label TEXT,
      floors INTEGER DEFAULT 1,
      bedrooms INTEGER DEFAULT 0,
      bathrooms INTEGER DEFAULT 0,
      square_meters REAL,
      square_feet REAL,
      cover_image_url TEXT,
      pdf_path TEXT,
      featured INTEGER DEFAULT 0,
      publish_status TEXT CHECK (publish_status IN ('draft', 'published', 'unpublished')) DEFAULT 'draft',
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      owner_architect_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    try { db.exec('ALTER TABLE house_plans ADD COLUMN owner_architect_id TEXT REFERENCES users(id) ON DELETE SET NULL'); } catch (_) {}
    try { db.exec('UPDATE house_plans SET owner_architect_id = created_by WHERE owner_architect_id IS NULL'); } catch (_) {}
    db.exec(`CREATE TABLE IF NOT EXISTS house_plan_previews (
      id TEXT PRIMARY KEY,
      house_plan_id TEXT NOT NULL REFERENCES house_plans(id) ON DELETE CASCADE,
      image_url TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS house_plan_purchases (
      id TEXT PRIMARY KEY,
      house_plan_id TEXT NOT NULL REFERENCES house_plans(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'USD',
      provider TEXT CHECK (provider IN ('stripe', 'paystack')),
      provider_reference TEXT,
      status TEXT CHECK (status IN ('pending', 'paid', 'failed')) DEFAULT 'pending',
      paid_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_house_plans_publish_status ON house_plans(publish_status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_house_plans_featured ON house_plans(featured)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_house_plans_owner_architect ON house_plans(owner_architect_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_house_plan_previews_plan ON house_plan_previews(house_plan_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_house_plan_purchases_user ON house_plan_purchases(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_house_plan_purchases_plan ON house_plan_purchases(house_plan_id)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_house_plan_paid_unique ON house_plan_purchases(house_plan_id, user_id, status)');
    db.exec(`CREATE TABLE IF NOT EXISTS house_plan_access_tokens (
      id TEXT PRIMARY KEY,
      house_plan_id TEXT NOT NULL REFERENCES house_plans(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action TEXT CHECK (action IN ('preview', 'download')) NOT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_house_plan_access_tokens_plan_user ON house_plan_access_tokens(house_plan_id, user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_house_plan_access_tokens_expires ON house_plan_access_tokens(expires_at)');
  } catch (_) {}
  // One-time migration: existing DBs may have users.role CHECK missing 'super_admin' and/or 'vendor' (signup would hit SQLITE_CONSTRAINT_CHECK)
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
    const sql = row && row.sql ? row.sql : '';
    const roleCheckOk =
      sql.includes('super_admin') &&
      sql.includes("'vendor'") &&
      sql.includes("'vendor_admin'") &&
      sql.includes("'finance_admin'") &&
      sql.includes("'moderator'") &&
      sql.includes("'editor'") &&
      sql.includes("'client'") &&
      sql.includes("'buyer'") &&
      sql.includes("'agent'");
    if (row && sql && !roleCheckOk) {
      db.exec('PRAGMA foreign_keys = OFF');
      const info = db.prepare('PRAGMA table_info(users)').all();
      const cols = info.map((c) => {
        if (c.name === 'role') return "role TEXT CHECK (role IN ('client', 'buyer', 'vendor', 'vendor_admin', 'finance_admin', 'moderator', 'editor', 'admin', 'super_admin', 'agent')) DEFAULT 'client'";
        let def = `${c.name} ${(c.type || 'TEXT').toUpperCase()}`;
        if (c.pk) def += ' PRIMARY KEY';
        if (c.name === 'email') def += ' UNIQUE NOT NULL';
        else if (c.notnull && c.name !== 'id') def += ' NOT NULL';
        if (c.dflt_value != null) {
          const v = c.dflt_value;
          def += ' DEFAULT ' + (typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(String(v)) ? v : `'${String(v).replace(/'/g, "''")}'`);
        }
        return def;
      });
      db.exec(`CREATE TABLE users_new (${cols.join(', ')})`);
      const colList = info.map((c) => c.name).join(', ');
      db.exec(`INSERT INTO users_new (${colList}) SELECT ${colList} FROM users`);
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');
      db.exec('PRAGMA foreign_keys = ON');
      console.log('✓ Migrated users table role CHECK (client, buyer, admin, vendor, super_admin)');
    }
    db.exec('PRAGMA foreign_keys = ON');
  } catch (e) {
    try { db.exec('PRAGMA foreign_keys = ON'); } catch (_) {}
  }
  try {
    const rpRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='role_permissions'").get();
    const rpSql = rpRow && rpRow.sql ? rpRow.sql : '';
    if (rpRow && rpSql && !rpSql.includes("'buyer'")) {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec(`CREATE TABLE role_permissions_new (
        id TEXT PRIMARY KEY,
        role TEXT CHECK (role IN ('client', 'buyer', 'vendor', 'vendor_admin', 'finance_admin', 'moderator', 'editor', 'admin', 'super_admin')) NOT NULL,
        permission_key TEXT NOT NULL,
        is_enabled INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (role, permission_key)
      )`);
      db.exec(
        `INSERT INTO role_permissions_new (id, role, permission_key, is_enabled, updated_by, created_at, updated_at)
         SELECT id, role, permission_key, is_enabled, updated_by, created_at, updated_at FROM role_permissions`
      );
      db.exec('DROP TABLE role_permissions');
      db.exec('ALTER TABLE role_permissions_new RENAME TO role_permissions');
      db.exec('CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role)');
      db.exec('PRAGMA foreign_keys = ON');
      console.log('✓ Migrated role_permissions table role CHECK (added buyer)');
    }
  } catch (e) {
    try { db.exec('PRAGMA foreign_keys = ON'); } catch (_) {}
  }
  try {
    const rpRow2 = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='role_permissions'").get();
    const rpSql2 = rpRow2 && rpRow2.sql ? rpRow2.sql : '';
    if (rpRow2 && rpSql2 && !rpSql2.includes("'agent'")) {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec(`CREATE TABLE role_permissions_new2 (
        id TEXT PRIMARY KEY,
        role TEXT CHECK (role IN ('client', 'buyer', 'vendor', 'vendor_admin', 'finance_admin', 'moderator', 'editor', 'admin', 'super_admin', 'agent')) NOT NULL,
        permission_key TEXT NOT NULL,
        is_enabled INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (role, permission_key)
      )`);
      db.exec(
        `INSERT INTO role_permissions_new2 (id, role, permission_key, is_enabled, updated_by, created_at, updated_at)
         SELECT id, role, permission_key, is_enabled, updated_by, created_at, updated_at FROM role_permissions`
      );
      db.exec('DROP TABLE role_permissions');
      db.exec('ALTER TABLE role_permissions_new2 RENAME TO role_permissions');
      db.exec('CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role)');
      db.exec('PRAGMA foreign_keys = ON');
      console.log('✓ Migrated role_permissions table role CHECK (added agent)');
    }
  } catch (e) {
    try { db.exec('PRAGMA foreign_keys = ON'); } catch (_) {}
  }
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS project_agent_assignments (
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
    db.exec('CREATE INDEX IF NOT EXISTS idx_project_agent_assignments_agent ON project_agent_assignments(agent_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_project_agent_assignments_project ON project_agent_assignments(project_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_project_agent_assignments_status ON project_agent_assignments(status)');
  } catch (_) {}
  // Ensure at least one super_admin exists
  try {
    const hasSuper = db.prepare("SELECT 1 FROM users WHERE role = 'super_admin' LIMIT 1").get();
    if (!hasSuper) {
      const byEmail = db.prepare("SELECT id FROM users WHERE email = 'admin@botchrealties.com' AND role = 'admin' LIMIT 1").get();
      const admin = byEmail || db.prepare("SELECT id, email FROM users WHERE role = 'admin' ORDER BY email LIMIT 1").get();
      if (admin) {
        db.prepare("UPDATE users SET role = 'super_admin' WHERE id = ?").run(admin.id);
        console.log('✓ Set first admin to super_admin:', admin.email || 'admin@botchrealties.com');
      }
    }
  } catch (_) {}
  console.log('✓ SQLite database initialized');
} catch (err) {
  console.error('Failed to initialize database:', err);
}

// Convert PostgreSQL-style placeholders ($1, $2) to SQLite-style (?).
// If the statement already uses `?` only, pass params through unchanged — otherwise
// convertedParams stays empty and better-sqlite3 throws "Too few parameter values".
function convertPlaceholders(sql, params = []) {
  if (!sql || typeof sql !== 'string' || !/\$\d/.test(sql)) {
    return { sql, params };
  }
  const convertedParams = [];
  // (?!\$) avoids treating bcrypt cost segments like "$12$" inside string literals as $12 placeholders
  const convertedSql = sql.replace(/\$(\d+)(?!\$)/g, (_, rawIndex) => {
    const idx = Number(rawIndex) - 1;
    if (idx < 0 || idx >= params.length) {
      throw new Error(`SQL placeholder $${rawIndex} is out of range for ${params.length} bound parameters`);
    }
    convertedParams.push(params[idx]);
    return '?';
  });
  return { sql: convertedSql, params: convertedParams };
}

// Create a wrapper to match the pg pool interface
export default {
  query: (sql, params = []) => {
    try {
      // Convert PostgreSQL placeholders to SQLite
      const { sql: convertedSql, params: convertedParams } = convertPlaceholders(sql, params);

      // Handle different query types
      if (convertedSql.trim().toUpperCase().startsWith('SELECT')) {
        const stmt = db.prepare(convertedSql);
        const rows = stmt.all(...convertedParams);
        return { rows, rowCount: rows.length };
      } else if (convertedSql.trim().toUpperCase().startsWith('UPDATE') && /\bRETURNING\b/i.test(convertedSql)) {
        const stmt = db.prepare(convertedSql);
        const rows = stmt.all(...convertedParams);
        return { rows, rowCount: rows.length };
      } else if (convertedSql.trim().toUpperCase().startsWith('INSERT') || 
                 convertedSql.trim().toUpperCase().startsWith('UPDATE') ||
                 convertedSql.trim().toUpperCase().startsWith('DELETE')) {
        const stmt = db.prepare(convertedSql);
        const result = stmt.run(...convertedParams);
        return { 
          rows: [], 
          rowCount: result.changes,
          lastID: result.lastInsertRowid
        };
      } else {
        // For other statements, just execute
        db.exec(convertedSql);
        return { rows: [], rowCount: 0 };
      }
    } catch (err) {
      console.error('Database error:', err.message, { sql, params });
      throw err;
    }
  }
};

export { db };
