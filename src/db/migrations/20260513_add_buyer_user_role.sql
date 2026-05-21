-- Add buyer role for marketplace / property / rental shoppers (distinct from project clients).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (
  role IN ('client', 'buyer', 'vendor', 'vendor_admin', 'finance_admin', 'moderator', 'editor', 'admin', 'super_admin')
);

ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_role_check;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_role_check CHECK (
  role IN ('client', 'buyer', 'vendor', 'vendor_admin', 'finance_admin', 'moderator', 'editor', 'admin', 'super_admin')
);
