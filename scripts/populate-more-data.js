import bcrypt from 'bcryptjs';
import pool from '../src/db/index.js';
import { v4 as uuidv4 } from 'uuid';

const SALT_ROUNDS = 12;

async function populateMoreData() {
  try {
    const adminId = 'a0000000-0000-0000-0000-000000000001';
    const passwordHash = await bcrypt.hash('Password123!', SALT_ROUNDS);
    const now = new Date().toISOString();

    console.log('Populating DB with more data...');

    // Generate 6 vendors
    const vendorIds = [];
    const orgIds = [];
    for (let i = 1; i <= 6; i++) {
      const vId = uuidv4();
      const orgId = uuidv4();
      vendorIds.push(vId);
      orgIds.push(orgId);

      // Create vendor user
      await pool.query(
        `INSERT OR IGNORE INTO users (id, email, password_hash, full_name, role, verified)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [vId, `vendor_more_${i}@botchrealties.com`, passwordHash, `New Vendor ${i}`, 'vendor', 1]
      );

      // Create vendor org
      await pool.query(
        `INSERT OR IGNORE INTO vendor_organizations (id, legal_name, display_name, registration_country, status, verification_status)
         VALUES (?, ?, ?, ?, 'approved', 'approved')`,
        [orgId, `Org ${i} Supply Ltd.`, `Vendor Org ${i}`, 'Ghana']
      );

      // Create vendor membership
      await pool.query(
        `INSERT OR IGNORE INTO vendor_memberships (id, vendor_org_id, user_id, org_role, is_primary_contact)
         VALUES (?, ?, ?, 'owner', 1)`,
        [uuidv4(), orgId, vId]
      );

      // 10 vendor listings per vendor
      for (let j = 1; j <= 10; j++) {
        const listingId = uuidv4();
        const types = ['material', 'service'];
        const listingType = types[j % 2];
        const categories = ['Structural', 'Plumbing', 'Electrical', 'Finishes', 'Roofing'];
        const category = categories[j % 5];
        
        // Let's use some real-looking unsplash IDs for construction/materials
        const unsplashIds = [
          '1581092160562-40aa08e78837',
          '1504309092620-7d0ec066e8c4',
          '1615874959474-d609969a20ed',
          '1581091226825-a6a2a5aee158',
          '1504307651254-35680f356dfd',
          '1541888086225-ee82522bdcb2',
          '1503387762-592deb58ef4e',
          '1581092335397-9583eb92d232',
          '1536882240095-0379873feb4e',
          '1581091226033-68d7120db207'
        ];
        const randomPic = unsplashIds[j % 10];
        const mediaUrl = `https://images.unsplash.com/photo-${randomPic}?w=1200&q=85`;

        await pool.query(
          `INSERT OR IGNORE INTO vendor_listings (
            id, vendor_org_id, created_by, listing_type, category, title, description, price, currency, location, media_url,
            workflow_state, approved_by, approved_at, submitted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)`,
          [
            listingId,
            orgId,
            vId,
            listingType,
            category,
            `${category} Item ${j} from Vendor ${i}`,
            `High quality ${category.toLowerCase()} posting from Vendor ${i}.`,
            100 * j,
            'USD',
            'Accra, Ghana',
            mediaUrl,
            adminId,
            now,
            now,
          ]
        );
      }
    }

    console.log('✓ Added 6 vendors with 10 postings each.');

    // Generate 4 clients
    const clientIds = [];
    for (let i = 1; i <= 4; i++) {
      const cId = uuidv4();
      clientIds.push(cId);

      await pool.query(
        `INSERT OR IGNORE INTO users (id, email, password_hash, full_name, role, verified)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [cId, `client_more_${i}@example.com`, passwordHash, `New Client ${i}`, 'client', 1]
      );

      // 3 projects per client
      for (let p = 1; p <= 3; p++) {
        const projectId = uuidv4();
        // Assign to one of the vendors
        const assignedVendorId = vendorIds[p % vendorIds.length];
        
        await pool.query(
          `INSERT OR IGNORE INTO projects (id, client_id, vendor_id, name, location, package_type, total_cost, amount_paid, progress_percent, status, start_date, estimated_completion)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            projectId,
            cId,
            assignedVendorId,
            `Project ${p}`,
            'Accra',
            'Custom Build',
            150000 + (p * 10000),
            50000,
            30,
            'active',
            '2025-01-01',
            '2026-01-01',
          ]
        );
      }
    }
    
    console.log('✓ Added 4 clients with 3 projects each.');

    console.log('\\n✅ Data population complete!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Population failed:', err.message);
    process.exit(1);
  }
}

populateMoreData();
