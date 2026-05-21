-- Admin-managed featured boost plans (properties / rentals / marketplace)

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

ALTER TABLE featured_listing_payments ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES vendor_featured_plans(id) ON DELETE SET NULL;
ALTER TABLE featured_listing_payments ADD COLUMN IF NOT EXISTS plan_name VARCHAR(120);
ALTER TABLE featured_listing_payments ADD COLUMN IF NOT EXISTS duration_days INT;

ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured_duration_days INT;
ALTER TABLE vendor_listings ADD COLUMN IF NOT EXISTS featured_duration_days INT;
