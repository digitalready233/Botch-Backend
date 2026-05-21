-- Vendor signup: primary channel intent (marketplace | properties | rentals)
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_vendor_channel VARCHAR(30)
  CHECK (signup_vendor_channel IN ('marketplace', 'properties', 'rentals'));
