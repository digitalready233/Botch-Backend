-- Botch field agents (subcontractors): no vendor org; work only via admin-assigned project tasks.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (
  role IN ('client', 'buyer', 'vendor', 'vendor_admin', 'finance_admin', 'moderator', 'editor', 'admin', 'super_admin', 'agent')
);

ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_role_check;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_role_check CHECK (
  role IN ('client', 'buyer', 'vendor', 'vendor_admin', 'finance_admin', 'moderator', 'editor', 'admin', 'super_admin', 'agent')
);

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
