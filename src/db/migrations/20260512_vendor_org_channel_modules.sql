-- Channel modules: existing orgs keep full access; new rows default marketplace on, properties/rentals off.
ALTER TABLE vendor_organizations ADD COLUMN IF NOT EXISTS module_marketplace_enabled BOOLEAN;
ALTER TABLE vendor_organizations ADD COLUMN IF NOT EXISTS module_properties_enabled BOOLEAN;
ALTER TABLE vendor_organizations ADD COLUMN IF NOT EXISTS module_rentals_enabled BOOLEAN;

UPDATE vendor_organizations
SET module_marketplace_enabled = COALESCE(module_marketplace_enabled, TRUE),
    module_properties_enabled = COALESCE(module_properties_enabled, TRUE),
    module_rentals_enabled = COALESCE(module_rentals_enabled, TRUE)
WHERE module_marketplace_enabled IS NULL
   OR module_properties_enabled IS NULL
   OR module_rentals_enabled IS NULL;

ALTER TABLE vendor_organizations ALTER COLUMN module_marketplace_enabled SET DEFAULT TRUE;
ALTER TABLE vendor_organizations ALTER COLUMN module_properties_enabled SET DEFAULT FALSE;
ALTER TABLE vendor_organizations ALTER COLUMN module_rentals_enabled SET DEFAULT FALSE;
