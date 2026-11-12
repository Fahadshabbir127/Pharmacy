/**
 * Seeding.
 *
 *  - seedDemoCatalog: optional sample catalogue offered by the first-run wizard
 *    ("load demo data"). It creates NO login accounts and no known passwords.
 *  - seedLegacyTestData: the original application's demo seed (demo logins
 *    admin/admin123, staff/staff123, a customer123 portal user and the
 *    superadmin/admin123 platform account). Used ONLY when the environment
 *    variable PHARMACY_TEST_LEGACY_SEED=1 is set by the test suite; never in
 *    the desktop app.
 *
 * Product data and sample sale are the original app's seed (server.ts @ ec90af3), unchanged.
 */
import bcrypt from 'bcryptjs';
import type { DbAdapter } from './db/adapter';
import { createBatch } from './inventory/batches';

function catalog(db: DbAdapter, saleCreatorId: number) {
  // Seed Categories
  const categories = [
    'Tablets', 'Capsules', 'Syrups', 'Injections', 'Surgical', 
    'Medical Devices', 'Baby Products', 'Personal Care', 'Food Items', 'Beverages', 'Tissue'
  ];
  categories.forEach(cat => {
    db.run("INSERT INTO categories (name, description) VALUES (?, ?)", [cat, `${cat} section`]);
  });

  // Seed Suppliers
  db.run("INSERT INTO suppliers (name, phone, company, address) VALUES (?, ?, ?, ?)", [
    'GlaxoSmithKline (GSK) Pakistan', '042-35800100', 'GSK Pharma', 'Gulberg III, Lahore'
  ]);
  db.run("INSERT INTO suppliers (name, phone, company, address) VALUES (?, ?, ?, ?)", [
    'Sami Pharmaceuticals', '021-35061200', 'Sami Pharma', 'Korangi Industrial Area, Karachi'
  ]);
  db.run("INSERT INTO suppliers (name, phone, company, address) VALUES (?, ?, ?, ?)", [
    'Abbott Laboratories Pakistan', '021-35610211', 'Abbott', 'Landhi, Karachi'
  ]);

  // Seed Customers
  db.run("INSERT INTO customers (name, phone, address, opening_balance, current_balance, login_id) VALUES (?, ?, ?, ?, ?, ?)", [
    'Chaudhry Muhammad Ali', '03001234567', 'House #42, Street 5, Main Bazaar, Lahore', 0, 2450.00, '03001234567'
  ]);
  db.run("INSERT INTO customers (name, phone, address, opening_balance, current_balance, login_id) VALUES (?, ?, ?, ?, ?, ?)", [
    'Tariq Mahmood', '03219876543', 'Plaza #12, Commercial Market, Rawalpindi', 1200.00, 1200.00, '03219876543'
  ]);
  // Phase 7: the demo balance is a recorded opening balance (the original demo data had no record explaining it)
  db.run(`INSERT INTO customer_ledger (customer_id, type, reference, debit, credit, balance_after, notes)
    VALUES (2, 'ADJUSTMENT', 'Opening Balance', 1200, 0, 1200, 'Initial opening balance')`);
  db.run("INSERT INTO customers (name, phone, address, opening_balance, current_balance, login_id) VALUES (?, ?, ?, ?, ?, ?)", [
    'Dr. Rashid Ahmad', '03335554433', 'Civil Hospital Road, Multan', 0, 0.00, '03335554433'
  ]);

  // Seed Products
  const sampleProducts = [
    ['Panadol Extra 500mg', 'Pack', 180, 220, 15, 120, 'B-8910', '2027-10-15', 1, '3004.90', 0, 'Rack A1', 1],
    ['Augmentin 625mg Tablets', 'Pack', 310, 380, 10, 45, 'AG-442', '2026-11-20', 1, '3004.90', 0, 'Rack A2', 1],
    ['Brufen 400mg Tablets', 'Pack', 140, 175, 20, 80, 'BF-109', '2027-04-10', 1, '3004.90', 0, 'Rack A1', 2],
    ['Risek 20mg Capsules', 'Pack', 240, 310, 15, 60, 'RK-221', '2026-12-05', 2, '3004.90', 0, 'Rack B1', 3],
    ['Hydryllin Syrup 120ml', 'Bottle', 110, 145, 10, 35, 'HY-908', '2026-09-30', 3, '3004.90', 0, 'Rack C1', 2],
    ['Calamox 625mg Tablets', 'Pack', 290, 360, 10, 8, 'CX-771', '2026-08-15', 1, '3004.90', 0, 'Rack A3', 2], // Low stock!
    ['Cac 1000 Effervescent', 'Tube', 210, 260, 10, 25, 'CAC-33', '2026-08-01', 3, '3004.90', 0, 'Rack B2', 3], // Expiring soon!
    ['Dettol Antiseptic Liquid 100ml', 'Bottle', 160, 200, 12, 40, 'DT-001', '2028-01-01', 8, '3401.11', 18, 'Rack E1', 1],
    ['Pampers Baby Wipes 64s', 'Pack', 350, 430, 8, 22, 'PW-64', '2027-06-30', 7, '3401.11', 18, 'Rack F2', 3],
    ['Johnson Baby Lotion 200ml', 'Bottle', 420, 520, 10, 18, 'JBL-20', '2027-08-12', 7, '3401.11', 18, 'Rack F1', 3],
    ['Rose Petal Tissue Box 200s', 'Box', 180, 230, 15, 50, 'RP-200', '2029-01-01', 11, '4818.10', 18, 'Rack G1', 2],
    ['Nestle Pure Life Water 1.5L', 'Bottle', 80, 110, 24, 60, 'NW-15', '2027-01-01', 10, '2201.10', 18, 'Rack H1', 2]
  ];

  // Phase 6: a product starts with stock 0; its stock is an OPENING batch (products.stock follows the batches)
  sampleProducts.forEach(p => {
    const [name, unit, purchasePrice, salePrice, minStock, stock, batchNumber, expiry, categoryId, hsn, gst, rack, supplierId] = p as any[];
    const productId = db.run(
      `INSERT INTO products 
      (name, unit, purchase_price, sale_price, min_stock, stock, batch_number, expiry_date, category_id, hsn_code, gst_rate, rack_location, supplier_id) 
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      [name, unit, purchasePrice, salePrice, minStock, batchNumber, expiry, categoryId, hsn, gst, rack, supplierId]
    ).lastInsertRowid;
    createBatch(db, { productId, batchNumber, expiryDate: expiry, purchasePrice, salePrice, quantity: stock, supplierId, source: 'OPENING' });
  });

  // Seed Initial Customer Ledger & Sale
  const today = new Date().toISOString().split('T')[0];
  db.run(`INSERT INTO sales_headers 
    (invoice_number, customer_id, sale_date, total_amount, discount_percent, discount_amount, net_amount, total_gst, grand_total, payment_method, amount_paid, amount_due, payment_status, created_by_user_id) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['INV-1001', 1, `${today} 10:30:00`, 2650.00, 0, 0, 2650.00, 0, 2650.00, 'PARTIAL', 200.00, 2450.00, 'PARTIAL', saleCreatorId]
  );

  db.run(`INSERT INTO sale_items (sale_id, product_id, quantity, unit, sale_price, cost_price, discount_percent, discount_amount, gst_amount, batch_number, expiry_date, subtotal)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [1, 1, 2, 'Pack', 220, 180, 0, 0, 0, 'B-8910', '2027-10-15', 440]
  );
  db.run(`INSERT INTO sale_items (sale_id, product_id, quantity, unit, sale_price, cost_price, discount_percent, discount_amount, gst_amount, batch_number, expiry_date, subtotal)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [1, 2, 5, 'Pack', 380, 310, 0, 0, 0, 'AG-442', '2026-11-20', 1900]
  );

  db.run(`INSERT INTO customer_ledger (customer_id, transaction_date, type, reference, debit, credit, balance_after, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [1, `${today} 10:30:00`, 'SALE', 'Invoice #INV-1001', 2650.00, 200.00, 2450.00, 'Partial cash payment Rs. 200, Udhar Rs. 2450']
  );

  // Phase 7: the Rs. 200 paid at the demo sale is a payment record applied to that invoice
  const demoPay = db.run(`INSERT INTO payments (tenant_id, customer_id, sale_id, invoice_number, direction, kind, method, amount, client_txn_id, received_by_user_id, received_at, source, notes)
    VALUES (1, 1, 1, 'INV-1001', 'IN', 'SALE_TENDER', 'CASH', 200, 'demo-seed-inv-1001', ?, ?, 'SYSTEM', 'Demo data')`, [saleCreatorId, `${today} 10:30:00`]).lastInsertRowid;
  db.run(`INSERT INTO payment_allocations (payment_id, customer_id, target, sale_id, invoice_number, kind, amount, source, created_by_user_id, created_at)
    VALUES (?, 1, 'SALE', 1, 'INV-1001', 'APPLY', 200, 'SYSTEM', ?, ?)`, [demoPay, saleCreatorId, `${today} 10:30:00`]);

  db.run(`INSERT INTO sms_queue (customer_id, phone, message, type, status) VALUES (?, ?, ?, ?, ?)`,
    [1, '03001234567', 'Dear Chaudhry Muhammad Ali, thank you for visiting our pharmacy. Invoice #INV-1001. Amount Paid: Rs. 200. Current Udhar Balance: Rs. 2450.', 'PAYMENT_CONFIRMATION', 'PENDING']
  );

}

export function seedDemoCatalog(db: DbAdapter, saleCreatorId: number) {
  catalog(db, saleCreatorId);
}

export function seedLegacyTestData(db: DbAdapter) {
  const adminPassHash = bcrypt.hashSync('admin123', 10);
  const staffPassHash = bcrypt.hashSync('staff123', 10);
  const customerPassHash = bcrypt.hashSync('customer123', 10);
  db.run("INSERT INTO users (username, password_hash, role, full_name, phone) VALUES (?, ?, ?, ?, ?)", ['admin', adminPassHash, 'ADMIN', 'Muhammad Asghar (Owner)', '03000000000']);
  db.run("INSERT INTO users (username, password_hash, role, full_name, phone) VALUES (?, ?, ?, ?, ?)", ['staff', staffPassHash, 'STAFF', 'Hamza Khan (Pharmacist)', '03111111111']);
  catalog(db, 1);
  db.run("INSERT INTO users (username, password_hash, role, full_name, phone, customer_id) VALUES (?, ?, ?, ?, ?, ?)", ['03001234567', customerPassHash, 'CUSTOMER', 'Chaudhry Muhammad Ali', '03001234567', 1]);
  db.run(
    "INSERT INTO users (username, password_hash, role, full_name, email, phone, status) VALUES (?, ?, 'SUPER_ADMIN', ?, ?, ?, 'APPROVED')",
    ['superadmin', bcrypt.hashSync('admin123', 10), 'Super Platform Administrator', 'superadmin@khushipos.com', '03000000000'],
  );
  db.run(`INSERT INTO tenants (id, name, owner_name, owner_email, phone, address, city, status, plan)
          VALUES (1, 'Khushi Medical Hall', 'Muhammad Asghar', 'admin@khushipos.com', '03000000000', 'Main Bazaar, Lahore', 'Lahore', 'ACTIVE', 'PRO')`);
  // Default Settings
    const defaultSettings = [
      ['store_name', 'Khushi Medical Hall'],
      ['store_urdu_name', 'خوشی میڈیکل ہال'],
      ['address', 'Main Bazaar, Near Civil Hospital, Lahore'],
      ['phone', '0300-1234567 / 042-35551234'],
      ['ntn_number', 'NTN-7894561-2'],
      ['receipt_footer', 'Get well soon! Check expiry before use. Goods once sold are not returnable without bill.'],
      ['printer_type', 'THERMAL_80MM'],
      ['printer_address', 'USB001'],
      ['smtp_host', 'smtp.gmail.com'],
      ['smtp_port', '587'],
      ['smtp_user', 'khushi.pharmacy@gmail.com'],
      ['smtp_pass', ''],
      ['smtp_secure', 'tls'],
      ['smtp_from_email', 'khushi.pharmacy@gmail.com'],
      ['smtp_from_name', 'Khushi Medical Hall'],
      ['smtp_enabled', 'true'],
      ['twilio_account_sid', ''],
      ['twilio_auth_token', ''],
      ['twilio_from_phone', ''],
      ['sms_enabled', 'true'],
      ['auto_backup_enabled', 'true'],
      ['backup_interval_hours', '24']
    ];
  defaultSettings.forEach(([k, v]) => db.run("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", [k, v]));
}

/** Settings for a fresh desktop install (no third-party accounts, nothing enabled that needs internet). */
export function defaultSettingsForNewStore(store: { name: string; address?: string; phone?: string }): [string, string][] {
  return [
    ['store_name', store.name],
    ['store_urdu_name', ''],
    ['address', store.address || ''],
    ['phone', store.phone || ''],
    ['ntn_number', ''],
    ['receipt_footer', 'Thank you! Please check expiry dates before use.'],
    ['printer_type', 'THERMAL_80MM'],
    ['printer_address', ''],
    ['smtp_host', ''],
    ['smtp_port', '587'],
    ['smtp_user', ''],
    ['smtp_pass', ''],
    ['smtp_secure', 'tls'],
    ['smtp_from_email', ''],
    ['smtp_from_name', store.name],
    ['smtp_enabled', 'false'],
    ['twilio_account_sid', ''],
    ['twilio_auth_token', ''],
    ['twilio_from_phone', ''],
    ['sms_enabled', 'false'],
    ['auto_backup_enabled', 'true'],
    ['backup_interval_hours', '24'],
  ];
}
