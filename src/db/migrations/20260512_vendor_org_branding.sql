-- Vendor company profile: cover (wallpaper) and logo URLs (uploaded files or external URLs)
ALTER TABLE vendor_organizations ADD COLUMN IF NOT EXISTS cover_photo_url TEXT;
ALTER TABLE vendor_organizations ADD COLUMN IF NOT EXISTS logo_url TEXT;
