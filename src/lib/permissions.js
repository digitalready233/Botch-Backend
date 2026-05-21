const ROLE_KEYS = ['client', 'buyer', 'vendor', 'vendor_admin', 'finance_admin', 'moderator', 'editor', 'admin', 'super_admin', 'agent'];

export const PRIVILEGE_CATALOG = [
  {
    key: 'dashboard.view',
    group: 'General',
    label: 'View dashboard',
    description: 'Allows access to dashboard pages and metrics.',
  },
  {
    key: 'projects.manage',
    group: 'Operations',
    label: 'Manage projects',
    description: 'Create, edit, and manage project execution data.',
  },
  {
    key: 'messages.manage',
    group: 'Operations',
    label: 'Manage messages',
    description: 'Access and moderate operational conversations.',
  },
  {
    key: 'moderation.manage',
    group: 'Marketplace',
    label: 'Moderate listings & reviews',
    description: 'Moderate marketplace content and review queues.',
  },
  {
    key: 'vendors.approve',
    group: 'Marketplace',
    label: 'Approve vendors',
    description: 'Approve or reject vendor onboarding and verification.',
  },
  {
    key: 'reports.view',
    group: 'Analytics',
    label: 'View reports',
    description: 'Access reports, insights, and executive summaries.',
  },
  {
    key: 'billing.manage',
    group: 'Finance',
    label: 'Manage billing',
    description: 'View and manage invoices, payments, and billing operations.',
  },
  {
    key: 'users.manage',
    group: 'Administration',
    label: 'Manage users',
    description: 'Manage user profile status and account-level controls.',
  },
  {
    key: 'admins.manage',
    group: 'Administration',
    label: 'Manage admin accounts',
    description: 'Create/remove admin accounts and view admin registry.',
  },
  {
    key: 'settings.manage_privileges',
    group: 'Administration',
    label: 'Manage privileges',
    description: 'Toggle role privileges from Settings.',
  },
];

const DEFAULT_ROLE_PERMISSIONS = {
  client: ['dashboard.view'],
  buyer: ['dashboard.view'],
  agent: ['dashboard.view'],
  vendor: ['dashboard.view', 'messages.manage'],
  vendor_admin: [
    'dashboard.view',
    'messages.manage',
    'moderation.manage',
    'vendors.approve',
    'reports.view',
  ],
  finance_admin: ['dashboard.view', 'billing.manage', 'reports.view'],
  moderator: ['dashboard.view', 'messages.manage', 'moderation.manage', 'reports.view'],
  editor: ['dashboard.view', 'projects.manage', 'messages.manage', 'reports.view'],
  admin: [
    'dashboard.view',
    'projects.manage',
    'messages.manage',
    'moderation.manage',
    'vendors.approve',
    'reports.view',
    'billing.manage',
    'users.manage',
    'admins.manage',
    'settings.manage_privileges',
  ],
  super_admin: PRIVILEGE_CATALOG.map((item) => item.key),
};

export function getRoleKeys() {
  return [...ROLE_KEYS];
}

export function getDefaultRoleMatrix() {
  const matrix = {};
  for (const role of ROLE_KEYS) {
    matrix[role] = {};
    const set = new Set(DEFAULT_ROLE_PERMISSIONS[role] || []);
    for (const item of PRIVILEGE_CATALOG) {
      matrix[role][item.key] = set.has(item.key);
    }
  }
  return matrix;
}

export function isKnownRole(role) {
  return ROLE_KEYS.includes(role);
}

export function isKnownPermission(permissionKey) {
  return PRIVILEGE_CATALOG.some((item) => item.key === permissionKey);
}

export function canManageRolePrivileges(actorRole, targetRole) {
  if (actorRole === 'super_admin') return true;
  if (actorRole === 'admin') return targetRole !== 'super_admin';
  return false;
}

function toBool(value) {
  if (value === true || value === 1 || value === '1') return true;
  return false;
}

export async function getRoleOverrides(db) {
  const { rows } = await db.query(
    'SELECT role, permission_key, is_enabled FROM role_permissions'
  );
  const overrides = new Map();
  for (const row of rows || []) {
    if (!isKnownRole(row.role) || !isKnownPermission(row.permission_key)) continue;
    if (!overrides.has(row.role)) overrides.set(row.role, new Map());
    overrides.get(row.role).set(row.permission_key, toBool(row.is_enabled));
  }
  return overrides;
}

export function applyRoleOverrides(baseMatrix, overrides) {
  const next = JSON.parse(JSON.stringify(baseMatrix));
  for (const role of ROLE_KEYS) {
    if (role === 'super_admin') {
      for (const item of PRIVILEGE_CATALOG) {
        next.super_admin[item.key] = true;
      }
      continue;
    }
    const roleMap = overrides.get(role);
    if (!roleMap) continue;
    for (const [permissionKey, enabled] of roleMap.entries()) {
      next[role][permissionKey] = Boolean(enabled);
    }
  }
  return next;
}

export async function getRolePermissionMatrix(db) {
  const base = getDefaultRoleMatrix();
  const overrides = await getRoleOverrides(db);
  return applyRoleOverrides(base, overrides);
}

export async function getUserPermissions(db, role) {
  if (!isKnownRole(role)) return [];
  if (role === 'super_admin') return PRIVILEGE_CATALOG.map((item) => item.key);
  const matrix = await getRolePermissionMatrix(db);
  return Object.entries(matrix[role] || {})
    .filter(([, enabled]) => Boolean(enabled))
    .map(([key]) => key);
}
