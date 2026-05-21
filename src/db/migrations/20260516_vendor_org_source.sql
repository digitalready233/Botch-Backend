ALTER TABLE vendor_organizations ADD COLUMN IF NOT EXISTS vendor_source VARCHAR(30) DEFAULT 'self_service';
