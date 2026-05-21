import { db } from '../src/db/sqlite.js';

const orgQuery = `
  SELECT
    vo.id AS vendor_org_id,
    COALESCE(vo.display_name, vo.legal_name) AS vendor_name,
    vo.status,
    pc.full_name AS primary_contact_name,
    pc.phone AS primary_contact_phone,
    pc.email AS primary_contact_email,
    COALESCE(pub.published_count, 0) AS published_count
  FROM vendor_organizations vo
  LEFT JOIN vendor_memberships vm
    ON vm.vendor_org_id = vo.id
   AND vm.is_primary_contact = 1
  LEFT JOIN users pc ON pc.id = vm.user_id
  LEFT JOIN (
    SELECT vendor_org_id, COUNT(*) AS published_count
    FROM vendor_listings
    WHERE workflow_state = 'published'
    GROUP BY vendor_org_id
  ) pub ON pub.vendor_org_id = vo.id
  ORDER BY published_count DESC, vendor_name ASC
`;

const standaloneQuery = `
  SELECT
    u.id AS vendor_user_id,
    u.full_name AS vendor_name,
    u.email,
    u.phone,
    COALESCE(pub.published_count, 0) AS published_count
  FROM users u
  LEFT JOIN (
    SELECT created_by, COUNT(*) AS published_count
    FROM vendor_listings
    WHERE workflow_state = 'published'
      AND vendor_org_id IS NULL
    GROUP BY created_by
  ) pub ON pub.created_by = u.id
  WHERE u.role = 'vendor'
  ORDER BY published_count DESC, u.full_name ASC
`;

const listingStateQuery = `
  SELECT workflow_state, COUNT(*) AS count
  FROM vendor_listings
  GROUP BY workflow_state
  ORDER BY count DESC
`;

const publishedListingsQuery = `
  SELECT
    vl.id,
    vl.title,
    vl.listing_type,
    vl.workflow_state,
    COALESCE(vo.display_name, vo.legal_name, u.full_name, 'Verified vendor') AS vendor_name,
    COALESCE(pc.phone, u.phone) AS resolved_phone
  FROM vendor_listings vl
  LEFT JOIN vendor_organizations vo ON vo.id = vl.vendor_org_id
  LEFT JOIN users u ON u.id = vl.created_by
  LEFT JOIN vendor_memberships vm
    ON vm.vendor_org_id = vl.vendor_org_id
   AND vm.is_primary_contact = 1
  LEFT JOIN users pc ON pc.id = vm.user_id
  WHERE vl.workflow_state = 'published'
  ORDER BY vl.updated_at DESC, vl.created_at DESC
`;

const organizations = db.prepare(orgQuery).all();
const standaloneVendors = db.prepare(standaloneQuery).all();
const listingStates = db.prepare(listingStateQuery).all();
const publishedListings = db.prepare(publishedListingsQuery).all();

console.log(
  JSON.stringify(
    { organizations, standaloneVendors, listingStates, publishedListings },
    null,
    2
  )
);
