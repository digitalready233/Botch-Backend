-- Channel posting plans and subscriptions (properties / rentals)

CREATE TABLE IF NOT EXISTS vendor_channel_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel VARCHAR(20) NOT NULL CHECK (channel IN ('properties', 'rentals')),
  name VARCHAR(120) NOT NULL,
  duration_months INT NOT NULL CHECK (duration_months IN (1, 12, 24, 36)),
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

CREATE INDEX IF NOT EXISTS idx_vendor_channel_plans_channel ON vendor_channel_plans(channel, sort_order);
CREATE INDEX IF NOT EXISTS idx_vendor_channel_plans_active ON vendor_channel_plans(channel, is_active);

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

CREATE INDEX IF NOT EXISTS idx_vendor_channel_subs_org_channel ON vendor_channel_subscriptions(vendor_org_id, channel);
CREATE INDEX IF NOT EXISTS idx_vendor_channel_subs_status ON vendor_channel_subscriptions(status, current_period_end DESC);

-- Allow channel_subscription payment type (PostgreSQL: drop/recreate check if needed)
ALTER TABLE vendor_billing_payments DROP CONSTRAINT IF EXISTS vendor_billing_payments_payment_type_check;
ALTER TABLE vendor_billing_payments ADD CONSTRAINT vendor_billing_payments_payment_type_check
  CHECK (payment_type IN ('onboarding_fee', 'subscription', 'channel_subscription'));
