import bcrypt from 'bcryptjs';
import pool from './index.js';

const SALT_ROUNDS = 12;

/**
 * Published sale/rent properties + vendor marketplace rows so the landing page and /rentals have demo images.
 * Safe to run repeatedly (INSERT OR IGNORE / best-effort UPDATE).
 */
async function seedLandingShowcase() {
  const adminId = 'a0000000-0000-0000-0000-000000000001';
  const vendorId = 'a0000000-0000-0000-0000-000000000003';

  try {
    await pool.query(`UPDATE users SET verification_status = 'approved', phone = '+233241000100' WHERE id = ?`, [vendorId]);
  } catch (_) {}

  const saleRows = [
    {
      id: 'seed-prop-004',
      title: 'Ocean-view penthouse, Airport Residential',
      description: 'Floor-to-ceiling glass, concierge, and rooftop pool. Short drive from Kotoka.',
      property_type: 'apartment',
      bedrooms: 3,
      bathrooms: 3,
      location: 'Accra',
      area: 'Airport Residential',
      price: 275000,
      currency: 'USD',
      image_url: 'https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?w=800&q=85',
      amenities: '["pool","concierge","gym","parking"]',
    },
    {
      id: 'seed-prop-005',
      title: 'Hillside cabin near Aburi',
      description: 'Cool climate escape with wraparound deck and mountain breezes.',
      property_type: 'cabin',
      bedrooms: 2,
      bathrooms: 1,
      location: 'Eastern Region',
      area: 'Aburi',
      price: 198000,
      currency: 'USD',
      image_url: 'https://images.unsplash.com/photo-1449844908441-8829872d5227?w=800&q=85',
      amenities: '["deck","fireplace","parking"]',
    },
    {
      id: 'seed-prop-006',
      title: 'Contemporary treehouse lodge, Kakum',
      description: 'Eco lodge steps from the canopy walkway — unique short-stay investment.',
      property_type: 'treehouse',
      bedrooms: 1,
      bathrooms: 1,
      location: 'Central Region',
      area: 'Kakum',
      price: 310000,
      currency: 'USD',
      image_url: 'https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=800&q=85',
      amenities: '["eco","deck","wifi"]',
    },
    {
      id: 'seed-prop-007',
      title: 'Family house with garden, Tema Community 12',
      description: 'Corner plot, double garage, great schools nearby.',
      property_type: 'house',
      bedrooms: 5,
      bathrooms: 4,
      location: 'Tema',
      area: 'Community 12',
      price: 425000,
      currency: 'USD',
      image_url: 'https://images.unsplash.com/photo-1600585154526-990dced4db0d?w=800&q=85',
      amenities: '["garden","garage","security"]',
    },
  ];

  for (const row of saleRows) {
    try {
      await pool.query(
        `INSERT OR IGNORE INTO properties (
          id, title, description, property_type, bedrooms, bathrooms, location, area, price, currency, image_url, amenities,
          created_by, listing_purpose, listing_state, publish_status, moderation_status, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sale', 'published', 'published', 'approved', 'published')`,
        [
          row.id,
          row.title,
          row.description,
          row.property_type,
          row.bedrooms,
          row.bathrooms,
          row.location,
          row.area,
          row.price,
          row.currency,
          row.image_url,
          row.amenities,
          adminId,
        ]
      );
    } catch (_) {}
  }

  const rentalRows = [
    {
      id: 'seed-rent-001',
      title: 'Serviced 2BR near Labadi Beach',
      slug: 'serviced-2br-labadi-beach',
      description: 'Generator, pool access, housekeeping weekly.',
      property_type: 'apartment',
      bedrooms: 2,
      bathrooms: 2,
      location: 'Accra',
      area: 'Labadi',
      city: 'Accra',
      region: 'Greater Accra',
      price: 2200,
      currency: 'USD',
      image_url: 'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=800&q=85',
      rent_type: 'long_term',
      furnished_status: 'furnished',
    },
    {
      id: 'seed-rent-002',
      title: 'Short-stay loft, Osu',
      slug: 'short-stay-loft-osu',
      description: 'Walk to Oxford Street — ideal for executives.',
      property_type: 'apartment',
      bedrooms: 1,
      bathrooms: 1,
      location: 'Accra',
      area: 'Osu',
      city: 'Accra',
      region: 'Greater Accra',
      price: 95,
      currency: 'USD',
      image_url: 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800&q=85',
      rent_type: 'short_stay',
      furnished_status: 'furnished',
    },
    {
      id: 'seed-rent-003',
      title: 'Family townhouse, Spintex',
      slug: 'family-townhouse-spintex',
      description: 'Compound security, backup power, fenced yard.',
      property_type: 'house',
      bedrooms: 4,
      bathrooms: 3,
      location: 'Accra',
      area: 'Spintex Road',
      city: 'Accra',
      region: 'Greater Accra',
      price: 2800,
      currency: 'USD',
      image_url: 'https://images.unsplash.com/photo-1605276374104-dee2a0ed3cd6?w=800&q=85',
      rent_type: 'long_term',
      furnished_status: 'part_furnished',
    },
    {
      id: 'seed-rent-004',
      title: 'Garden villa rental, Trasacco',
      slug: 'garden-villa-trasacco',
      description: 'Private pool, chef’s kitchen, ideal for events.',
      property_type: 'villa',
      bedrooms: 5,
      bathrooms: 5,
      location: 'Accra',
      area: 'Trasacco Valley',
      city: 'Accra',
      region: 'Greater Accra',
      price: 5200,
      currency: 'USD',
      image_url: 'https://images.unsplash.com/photo-1613490493576-7fde63acd811?w=800&q=85',
      rent_type: 'long_term',
      furnished_status: 'furnished',
    },
    {
      id: 'seed-rent-005',
      title: 'Cozy studio, West Legon',
      slug: 'cozy-studio-west-legon',
      description: 'University district — high-yield rental.',
      property_type: 'apartment',
      bedrooms: 1,
      bathrooms: 1,
      location: 'Accra',
      area: 'West Legon',
      city: 'Accra',
      region: 'Greater Accra',
      price: 650,
      currency: 'USD',
      image_url: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=800&q=85',
      rent_type: 'long_term',
      furnished_status: 'unfurnished',
    },
    {
      id: 'seed-rent-006',
      title: 'Boutique cabin retreat, Shai Hills',
      slug: 'boutique-cabin-shai-hills',
      description: 'Weekend escapes with hiking trails at your doorstep.',
      property_type: 'cabin',
      bedrooms: 2,
      bathrooms: 1,
      location: 'Greater Accra',
      area: 'Shai Hills',
      city: 'Dodowa',
      region: 'Greater Accra',
      price: 140,
      currency: 'USD',
      image_url: 'https://images.unsplash.com/photo-1499793983690-e29da59ef1c2?w=800&q=85',
      rent_type: 'short_stay',
      furnished_status: 'furnished',
    },
  ];

  for (const row of rentalRows) {
    try {
      await pool.query(
        `INSERT OR IGNORE INTO properties (
          id, title, description, property_type, bedrooms, bathrooms, location, area, price, currency, image_url, amenities,
          slug, listing_purpose, rent_type, furnished_status, region, city,
          created_by, listing_state, publish_status, moderation_status, status, featured
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          '["ac","water","security"]',
          ?, 'rent', ?, ?, ?, ?, ?,
          'published', 'published', 'approved', 'published', 1
        )`,
        [
          row.id,
          row.title,
          row.description,
          row.property_type,
          row.bedrooms,
          row.bathrooms,
          row.location,
          row.area,
          row.price,
          row.currency,
          row.image_url,
          row.slug,
          row.rent_type,
          row.furnished_status,
          row.region,
          row.city,
          adminId,
        ]
      );
    } catch (_) {}
  }

  const vendorRows = [
    {
      id: 'seed-vl-001',
      listing_type: 'material',
      category: 'Structural steel',
      title: 'Galvanized reinforcement bundles — grade 60',
      description: 'Mill certificates included. Delivery within Greater Accra.',
      price: 4200,
      currency: 'USD',
      location: 'Tema Port logistics hub',
      media_url: 'https://images.unsplash.com/photo-1581092160562-40aa08e78837?w=1200&q=85',
    },
    {
      id: 'seed-vl-002',
      listing_type: 'material',
      category: 'Tiles & finishes',
      title: 'Premium porcelain tiles (large format)',
      description: 'Stocked SKUs for residential and hospitality projects.',
      price: 28,
      currency: 'USD',
      location: 'Accra — Kokomlemle showroom',
      media_url: 'https://images.unsplash.com/photo-1615874959474-d609969a20ed?w=1200&q=85',
    },
    {
      id: 'seed-vl-003',
      listing_type: 'material',
      category: 'CPVC & plumbing',
      title: 'Industrial PVC piping kits (bulk)',
      description: 'Pressure-rated fittings for multi-unit developments.',
      price: 1850,
      currency: 'USD',
      location: 'Kumasi warehouse',
      media_url: 'https://images.unsplash.com/photo-1504309092620-7d0ec066e8c4?w=1200&q=85',
    },
    {
      id: 'seed-vl-004',
      listing_type: 'service',
      category: 'MEP design',
      title: 'Licensed electrical & mechanical design',
      description: 'Load calculations, ECOWAS-compliant drawings, as-built packages.',
      price: null,
      currency: 'USD',
      location: 'Remote + site visits nationwide',
      media_url: 'https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=1200&q=85',
    },
    {
      id: 'seed-vl-005',
      listing_type: 'service',
      category: 'Site supervision',
      title: 'Resident engineer — multi-phase builds',
      description: 'Weekly QA logs, RFI coordination, snag lists.',
      price: 3500,
      currency: 'USD',
      location: 'Accra & Tema corridor',
      media_url: 'https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=1200&q=85',
    },
    {
      id: 'seed-vl-006',
      listing_type: 'service',
      category: 'Interior fit-out',
      title: 'Turnkey cabinetry & stone countertops',
      description: 'Template-to-install for kitchens, wet bars, and vanities.',
      price: null,
      currency: 'USD',
      location: 'East Legon workshop',
      media_url: 'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=1200&q=85',
    },
  ];

  const now = new Date().toISOString();
  for (const row of vendorRows) {
    try {
      await pool.query(
        `INSERT OR IGNORE INTO vendor_listings (
          id, vendor_org_id, created_by, listing_type, category, title, description, price, currency, location, media_url,
          workflow_state, approved_by, approved_at, submitted_at
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)`,
        [
          row.id,
          vendorId,
          row.listing_type,
          row.category,
          row.title,
          row.description,
          row.price,
          row.currency,
          row.location,
          row.media_url,
          adminId,
          now,
          now,
        ]
      );
    } catch (_) {}
  }

  console.log('✓ Landing showcase: extra properties, rentals, and vendor marketplace (demo)');
}

/**
 * Rich demo rows for dashboards: vendor org, CRM (inquiries/offers/rentals), appointments,
 * notifications, project chat, documents, contractor rating, house plan sample.
 * Safe to run repeatedly (INSERT OR IGNORE + fixed ids).
 */
async function seedExtendedDummyData({ adminId, clientId, vendorId, projectId }) {
  const orgId = 'seed-vendor-org-demo';
  const now = new Date().toISOString();

  try {
    await pool.query(
      `INSERT OR IGNORE INTO vendor_organizations (id, legal_name, display_name, registration_country, status, verification_status)
       VALUES (?, ?, ?, ?, 'approved', 'approved')`,
      [orgId, 'Adinkra Construction Supply Ltd.', 'Adinkra Supply', 'Ghana']
    );
  } catch (_) {}

  try {
    await pool.query(
      `INSERT OR IGNORE INTO vendor_memberships (id, vendor_org_id, user_id, org_role, is_primary_contact)
       VALUES (?, ?, ?, 'owner', 1)`,
      ['seed-vmembership-demo-001', orgId, vendorId]
    );
  } catch (_) {}

  try {
    await pool.query(`UPDATE projects SET vendor_org_id = ? WHERE id = ?`, [orgId, projectId]);
  } catch (_) {}

  const favoritePairs = [
    ['seed-fav-demo-001', 'seed-prop-004'],
    ['seed-fav-demo-002', 'seed-rent-001'],
    ['seed-fav-demo-003', 'seed-prop-001'],
  ];
  for (const [fid, pid] of favoritePairs) {
    try {
      await pool.query(`INSERT OR IGNORE INTO property_favorites (id, user_id, property_id) VALUES (?, ?, ?)`, [
        fid,
        clientId,
        pid,
      ]);
    } catch (_) {}
  }

  try {
    await pool.query(
      `INSERT OR IGNORE INTO saved_searches (id, user_id, name, search_scope, filters_json, query_string, is_active, alert_frequency, notify_email, notify_push, updated_at)
       VALUES (?, ?, ?, 'properties', ?, ?, 1, 'weekly', 1, 0, ?)`,
      [
        'seed-savedsearch-demo-001',
        clientId,
        'Villas under $500k — Accra',
        JSON.stringify({ property_type: 'villa', listing_purpose: 'sale', max_price: 500000 }),
        'property_type=villa',
        now,
      ]
    );
  } catch (_) {}

  try {
    await pool.query(
      `INSERT OR IGNORE INTO saved_searches (id, user_id, name, search_scope, filters_json, query_string, is_active, alert_frequency, notify_email, notify_push, updated_at)
       VALUES (?, ?, ?, 'rentals', ?, ?, 1, 'daily', 1, 0, ?)`,
      [
        'seed-savedsearch-demo-002',
        clientId,
        'Long-term 2BR — Greater Accra',
        JSON.stringify({ rent_type: 'long_term', bedrooms: 2, region: 'Greater Accra' }),
        'rent_type=long_term&bedrooms=2',
        now,
      ]
    );
  } catch (_) {}

  try {
    await pool.query(
      `INSERT OR IGNORE INTO listing_inquiries (id, property_id, vendor_id, message, lead_status, assigned_to, updated_at)
       VALUES (?, 'seed-prop-004', ?, ?, 'interested', ?, ?)`,
      [
        'seed-inquiry-demo-001',
        clientId,
        'We are relocating from London next year and want a sea-view option for viewing in December.',
        adminId,
        now,
      ]
    );
  } catch (_) {}

  try {
    await pool.query(
      `INSERT OR IGNORE INTO listing_inquiries (id, property_id, vendor_id, message, lead_status, assigned_to, updated_at)
       VALUES (?, 'seed-prop-007', ?, ?, 'new', ?, ?)`,
      [
        'seed-inquiry-demo-002',
        clientId,
        'Interested in the Tema family house — can we schedule a virtual walkthrough?',
        adminId,
        now,
      ]
    );
  } catch (_) {}

  try {
    await pool.query(
      `INSERT OR IGNORE INTO listing_offers (id, property_id, vendor_id, amount, currency, terms_note, status, updated_at)
       VALUES (?, 'seed-prop-005', ?, 265000, 'USD', 'Cash buyer; flexible on closing within 45 days.', 'under_review', ?)`,
      ['seed-offer-demo-001', clientId, now]
    );
  } catch (_) {}

  try {
    await pool.query(
      `INSERT OR IGNORE INTO rental_applications (id, property_id, vendor_id, move_in_date, employment_note, notes, status, updated_at)
       VALUES (?, 'seed-rent-002', ?, '2026-07-01', 'Remote software engineer (EU employer).', 'Quiet tenant; no pets. Prefer 12-month lease.', 'submitted', ?)`,
      ['seed-rental-app-demo-001', clientId, now]
    );
  } catch (_) {}

  try {
    await pool.query(
      `INSERT OR IGNORE INTO appointments (id, client_id, project_id, property_id, agent_id, title, preferred_date, preferred_time, notes, status, updated_at)
       VALUES (?, ?, ?, NULL, ?, 'Site visit — East Legon apartment', '2026-06-15', '10:00', 'Client flying in; prefers morning slot.', 'confirmed', ?)`,
      ['seed-appt-demo-001', clientId, projectId, adminId, now]
    );
  } catch (_) {}

  try {
    await pool.query(
      `INSERT OR IGNORE INTO appointments (id, client_id, project_id, property_id, agent_id, title, preferred_date, preferred_time, notes, status, updated_at)
       VALUES (?, ?, NULL, 'seed-rent-003', ?, 'Virtual tour — Spintex townhouse', '2026-06-20', '16:00', 'Video call via WhatsApp.', 'pending', ?)`,
      ['seed-appt-demo-002', clientId, adminId, now]
    );
  } catch (_) {}

  const notifications = [
    ['seed-notif-demo-001', clientId, 'milestone', 'Foundation milestone paid', 'Invoice INV-SEED-001 was marked paid. Next: superstructure draw.'],
    ['seed-notif-demo-002', clientId, 'listing', 'New inquiry on your saved search', 'A villa listing in Airport Residential matches your alert.'],
    ['seed-notif-demo-003', vendorId, 'vendor', 'Listing approved', 'Your marketplace listing “Galvanized reinforcement bundles” is live.'],
    ['seed-notif-demo-004', adminId, 'admin', 'Rental application pending', 'A new long-term rental application awaits review (Spintex).'],
  ];
  for (const [nid, uid, type, title, message] of notifications) {
    try {
      await pool.query(`INSERT OR IGNORE INTO notifications (id, user_id, type, title, message) VALUES (?, ?, ?, ?, ?)`, [
        nid,
        uid,
        type,
        title,
        message,
      ]);
    } catch (_) {}
  }

  try {
    await pool.query(
      `INSERT OR IGNORE INTO messages (id, sender_id, recipient_id, project_id, message_text, is_read)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [
        'seed-msg-demo-001',
        clientId,
        vendorId,
        projectId,
        'Hi — can we get an updated photo set after the next concrete pour? Thanks!',
      ]
    );
  } catch (_) {}

  try {
    await pool.query(
      `INSERT OR IGNORE INTO messages (id, sender_id, recipient_id, project_id, message_text, is_read)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [
        'seed-msg-demo-002',
        vendorId,
        clientId,
        projectId,
        'Yes — we will upload drone stills by Friday. Steel delivery is on track for next week.',
      ]
    );
  } catch (_) {}

  try {
    await pool.query(
      `INSERT OR IGNORE INTO project_documents (id, project_id, name, file_path, document_type, uploaded_by)
       VALUES (?, ?, ?, ?, 'contract', ?)`,
      [
        'seed-doc-demo-001',
        projectId,
        'Build contract (executed)',
        '/uploads/demo/executed-build-contract.pdf',
        adminId,
      ]
    );
  } catch (_) {}

  try {
    await pool.query(
      `INSERT OR IGNORE INTO project_progress_notes (id, project_id, note, visible_to_client, created_by)
       VALUES (?, ?, ?, 1, ?)`,
      [
        'seed-pnote-demo-001',
        projectId,
        'Client requested gold accent tiles in master bath — quote pending from supplier.',
        vendorId,
      ]
    );
  } catch (_) {}

  try {
    await pool.query(
      `INSERT OR IGNORE INTO contractor_ratings (id, project_id, contractor_id, client_id, rating, comment)
       VALUES (?, ?, ?, ?, 5, ?)`,
      [
        'seed-contractor-rating-demo-001',
        projectId,
        vendorId,
        clientId,
        'Excellent communication and weekly site reports. Highly recommend for diaspora builds.',
      ]
    );
  } catch (_) {}

  try {
    await pool.query(
      `INSERT OR IGNORE INTO vendor_reviews (id, vendor_profile_id, vendor_profile_type, reviewer_user_id, rating, comment, moderation_status)
       VALUES (?, ?, 'organization', ?, 5, ?, 'visible')`,
      [
        'seed-vendor-review-demo-001',
        orgId,
        clientId,
        'Fast delivery on rebar and clear mill certs. Will order again for Phase 2.',
      ]
    );
  } catch (_) {}

  try {
    await pool.query(
      `INSERT OR IGNORE INTO vendor_listings (
        id, vendor_org_id, created_by, listing_type, category, title, description, price, currency, location, media_url,
        workflow_state, approved_by, approved_at, submitted_at
      ) VALUES (?, ?, ?, 'material', 'Roofing', 'Standing seam metal roofing — coastal grade', 'Aluminum-zinc coated sheets, wind-rated for coastal Ghana. Cut lists from your drawings.', 8900, 'USD', 'Tema / Accra delivery', 'https://images.unsplash.com/photo-1632778149955-e80f8ceca729?w=1200&q=85', 'published', ?, ?, ?)`,
      ['seed-vl-demo-007', orgId, vendorId, adminId, now, now]
    );
  } catch (_) {}

  try {
    await pool.query(
      `INSERT OR IGNORE INTO vendor_listings (
        id, vendor_org_id, created_by, listing_type, category, title, description, price, currency, location, media_url,
        workflow_state, approved_by, approved_at, submitted_at
      ) VALUES (?, ?, ?, 'service', 'Quantity surveying', 'Independent BOQ & payment certificate reviews', 'Third-party QS for milestone sign-off and bank draw support.', 1200, 'USD', 'Nationwide (remote + site)', 'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=1200&q=85', 'published', ?, ?, ?)`,
      ['seed-vl-demo-008', orgId, vendorId, adminId, now, now]
    );
  } catch (_) {}

  try {
    await pool.query(
      `INSERT OR IGNORE INTO house_plans (id, slug, title, architect_name, architect_bio, building_type, category, description, tags, price, currency, size_label, floors, bedrooms, bathrooms, square_meters, cover_image_url, publish_status, created_by, owner_architect_id)
       VALUES (?, ?, ?, ?, ?, 'residential', 'modern', ?, ?, 149, 'USD', '240 m²', 2, 4, 3, 240, ?, 'published', ?, ?)`,
      [
        'seed-houseplan-demo-001',
        'modern-courtyard-villa-gh',
        'Modern courtyard villa — Ghana diaspora edition',
        'Studio Nsroma',
        'Accra-based practice focused on cross-ventilation and generator-ready layouts.',
        'Open-plan living around a shaded courtyard; staff quarters and double garage. PDF includes structural notes for local blocks.',
        '["courtyard","diaspora","generator"]',
        'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=1200&q=85',
        adminId,
        adminId,
      ]
    );
  } catch (_) {}

  try {
    await pool.query(
      `INSERT OR IGNORE INTO house_plan_previews (id, house_plan_id, image_url, sort_order)
       VALUES (?, 'seed-houseplan-demo-001', ?, 0)`,
      ['seed-hp-preview-demo-001', 'https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?w=1200&q=85']
    );
  } catch (_) {}

  try {
    const paidInv = await pool.query(`SELECT id FROM invoices WHERE invoice_number = $1 LIMIT 1`, ['INV-SEED-001']);
    const paidInvoiceId = paidInv.rows?.[0]?.id;
    if (paidInvoiceId) {
      await pool.query(
        `INSERT OR IGNORE INTO payments (id, invoice_id, client_id, amount, currency, payment_method, transaction_id, status)
         VALUES (?, ?, ?, 46000, 'USD', 'paystack', 'demo_txn_seed_001', 'completed')`,
        ['seed-payment-demo-001', paidInvoiceId, clientId]
      );
    }
  } catch (_) {}

  console.log('✓ Extended dummy data: CRM, rentals, appointments, messaging, vendor org, house plan');
}

async function seed() {
  try {
    const adminId = 'a0000000-0000-0000-0000-000000000001';
    const clientId = 'a0000000-0000-0000-0000-000000000002';
    const vendorId = 'a0000000-0000-0000-0000-000000000003';
    const adminEmail = 'admin@botchrealties.com';
    const clientEmail = 'client@example.com';
    const vendorEmail = 'partner@botchrealties.com';
    const passwordHash = await bcrypt.hash('Password123!', SALT_ROUNDS);

    console.log('Seeding database with test users...');

    // Insert admin user (super_admin so they can add other admins)
    await pool.query(
      `INSERT OR IGNORE INTO users (id, email, password_hash, full_name, role, verified)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [adminId, adminEmail, passwordHash, 'Botch Admin', 'super_admin', 1]
    );

    // Insert client user
    await pool.query(
      `INSERT OR IGNORE INTO users (id, email, password_hash, full_name, role, verified)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [clientId, clientEmail, passwordHash, 'Diaspora Client', 'client', 1]
    );

    // Insert partner/vendor user (contractors, engineers, suppliers)
    await pool.query(
      `INSERT OR IGNORE INTO users (id, email, password_hash, full_name, role, verified)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [vendorId, vendorEmail, passwordHash, 'Site Partner', 'vendor', 1]
    );

    console.log('✓ Test accounts created:');
    console.log(`  Admin: ${adminEmail} / Password123!`);
    console.log(`  Client: ${clientEmail} / Password123!`);
    console.log(`  Partner/Vendor: ${vendorEmail} / Password123!`);

    // Demo build project (stable id so seed + dummy CRM rows are idempotent)
    const projectId = 'seed-demo-project-east-legon';
    await pool.query(
      `INSERT OR IGNORE INTO projects (id, client_id, vendor_id, name, location, package_type, total_cost, amount_paid, progress_percent, status, start_date, estimated_completion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        clientId,
        vendorId,
        'East Legon 3BR Villa',
        'East Legon, Accra',
        '3BR Villa',
        185000,
        46000,
        28,
        'active',
        '2024-06-01',
        '2025-06-01',
      ]
    );

    console.log('✓ Sample project created (or already present)');

    const milestones = [
      {
        id: 'seed-milestone-demo-1',
        name: 'Foundation',
        description: 'Foundation work complete',
        amount: 46000,
        isPaid: 1,
        order: 1,
      },
      {
        id: 'seed-milestone-demo-2',
        name: 'Superstructure',
        description: 'Walls and roofing',
        amount: 55000,
        isPaid: 0,
        order: 2,
      },
      {
        id: 'seed-milestone-demo-3',
        name: 'Finishes',
        description: 'Electrical, plumbing, finishes',
        amount: 42000,
        isPaid: 0,
        order: 3,
      },
      {
        id: 'seed-milestone-demo-4',
        name: 'Handover',
        description: 'Final inspection and keys',
        amount: 42000,
        isPaid: 0,
        order: 4,
      },
    ];
    const milestoneIds = [];
    for (const milestone of milestones) {
      milestoneIds.push(milestone.id);
      await pool.query(
        `INSERT OR IGNORE INTO milestones (id, project_id, name, description, progress_percent, amount, is_paid, order_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          milestone.id,
          projectId,
          milestone.name,
          milestone.description,
          100,
          milestone.amount,
          milestone.isPaid,
          milestone.order,
        ]
      );
    }

    console.log('✓ Sample milestones created (or already present)');

    const invoiceId1 = 'seed-invoice-demo-001';
    const invoiceId2 = 'seed-invoice-demo-002';
    await pool.query(
      `INSERT OR IGNORE INTO invoices (id, invoice_number, project_id, client_id, milestone_id, amount, status, due_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [invoiceId1, 'INV-SEED-001', projectId, clientId, milestoneIds[0], 46000, 'paid', '2024-08-01']
    );
    await pool.query(
      `INSERT OR IGNORE INTO invoices (id, invoice_number, project_id, client_id, milestone_id, amount, status, due_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [invoiceId2, 'INV-SEED-002', projectId, clientId, milestoneIds[1], 55000, 'pending', '2025-02-15']
    );
    console.log('✓ Sample invoices created (or already present)');

    const placeholderPhoto = 'https://images.unsplash.com/photo-1503387762-592deb58ef4e?w=800';
    const placeholderVideo = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
    await pool.query(
      `INSERT OR IGNORE INTO media (id, project_id, uploaded_by, title, description, media_type, file_url, file_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['seed-media-demo-001', projectId, adminId, 'Foundation progress', 'Concrete pour complete for East Legon villa', 'photo', placeholderPhoto, 0]
    );
    await pool.query(
      `INSERT OR IGNORE INTO media (id, project_id, uploaded_by, title, description, media_type, file_url, file_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['seed-media-demo-002', projectId, adminId, 'Site walkthrough', 'Weekly site update video', 'video', placeholderVideo, 0]
    );
    await pool.query(
      `INSERT OR IGNORE INTO media (id, project_id, uploaded_by, title, description, media_type, file_url, file_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['seed-media-demo-003', projectId, adminId, 'Aerial view', 'Drone footage of roof structure', 'drone', placeholderVideo, 0]
    );
    console.log('✓ Sample media created (photo, video, drone)');

    await seedLandingShowcase();
    await seedExtendedDummyData({ adminId, clientId, vendorId, projectId });

    console.log('\n✅ Database seeded successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  }
}

seed();
