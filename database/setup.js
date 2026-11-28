const getDb = require('../lib/db');

function setup() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      sort_order INTEGER
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      category_id INTEGER,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      description TEXT,
      price INTEGER NOT NULL,
      image TEXT,
      spicy_levels TEXT,
      available INTEGER DEFAULT 1,
      archived INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    );

    CREATE TABLE IF NOT EXISTS bundles (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      description TEXT,
      price INTEGER NOT NULL,
      compare_price INTEGER,
      image TEXT,
      available INTEGER DEFAULT 1,
      archived INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS bundle_items (
      id INTEGER PRIMARY KEY,
      bundle_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      FOREIGN KEY (bundle_id) REFERENCES bundles(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS promotions (
      id INTEGER PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      value INTEGER,
      gift_product_id INTEGER,
      min_purchase INTEGER DEFAULT 0,
      eligible_type TEXT DEFAULT 'all',
      eligible_products TEXT,
      starts_at TEXT,
      ends_at TEXT,
      active INTEGER DEFAULT 1,
      description TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS delivery_zones (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      fee INTEGER NOT NULL,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY,
      order_number TEXT UNIQUE NOT NULL,
      access_token TEXT UNIQUE NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT,
      customer_email TEXT,
      method TEXT NOT NULL,
      address TEXT,
      delivery_zone_id INTEGER,
      delivery_fee INTEGER DEFAULT 0,
      notes TEXT,
      subtotal INTEGER NOT NULL,
      discount INTEGER DEFAULT 0,
      promo_id INTEGER,
      promo_code TEXT,
      referral_code TEXT,
      total INTEGER NOT NULL,
      payment_status TEXT DEFAULT 'UNPAID',
      order_status TEXT DEFAULT 'NEW',
      qris_version INTEGER,
      idempotency_key TEXT UNIQUE,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL,
      product_id INTEGER,
      bundle_id INTEGER,
      name TEXT NOT NULL,
      variant TEXT,
      price INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      is_gift INTEGER DEFAULT 0,
      components TEXT,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS payment_submissions (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER,
      drive_url TEXT,
      version INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      reviewer_id INTEGER,
      reviewer_note TEXT,
      review_reference TEXT,
      reviewed_at TEXT,
      created_at TEXT,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS order_status_history (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL,
      field TEXT,
      old_value TEXT,
      new_value TEXT,
      actor TEXT,
      reason TEXT,
      created_at TEXT,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS deleted_orders (
      order_number TEXT PRIMARY KEY,
      access_token TEXT,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deleted_orders_token ON deleted_orders(access_token);

    CREATE TABLE IF NOT EXISTS store_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS qris_assets (
      id INTEGER PRIMARY KEY,
      file_path TEXT NOT NULL,
      version INTEGER NOT NULL,
      active INTEGER DEFAULT 1,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS hero_slides (
      id INTEGER PRIMARY KEY,
      title TEXT,
      caption TEXT,
      image_url TEXT NOT NULL,
      link_url TEXT,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT,
      updated_at TEXT
    );
  `);

  console.log('Database tables created successfully.');
}

if (require.main === module) {
  setup();
}

module.exports = setup;
