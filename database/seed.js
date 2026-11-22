const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const setup = require('./setup');
const getDb = require('../lib/db');
const { now } = require('../lib/helpers');

function seed() {
  // Ensure tables exist
  setup();

  const db = getDb();
  const timestamp = now();

  // --- Admin ---
  const passwordHash = bcrypt.hashSync('nachoan2026', 10);
  db.prepare(`INSERT OR IGNORE INTO admins (username, password_hash, name, created_at) VALUES (?, ?, ?, ?)`)
    .run('admin', passwordHash, 'Administrator', timestamp);

  // --- Categories ---
  const categories = [
    { id: 1, name: 'Nachos', slug: 'nachos', sort_order: 1 },
    { id: 2, name: 'Snacks', slug: 'snacks', sort_order: 2 },
    { id: 3, name: 'Drinks', slug: 'drinks', sort_order: 3 },
    { id: 4, name: 'Bundling', slug: 'bundling', sort_order: 4 },
  ];
  const insertCat = db.prepare(`INSERT OR IGNORE INTO categories (id, name, slug, sort_order) VALUES (@id, @name, @slug, @sort_order)`);
  for (const c of categories) insertCat.run(c);

  // --- Products ---
  const products = [
    { id: 1, category_id: 1, name: 'Beefy Nacho', slug: 'beefy-nacho', description: 'Perpaduan tortilla cone yang renyah dengan limpahan saus bolognese dan daging cincang spesial bertopping keju.', price: 25000, image: '/images/products/beefy-nacho.jpg', spicy_levels: null, available: 1, archived: 0 },
    { id: 2, category_id: 1, name: 'Cheezy Corn', slug: 'cheezy-corn', description: 'Perpaduan renyahnya cone tortilla dengan jagung manis segar pilihan serta lelehan keju lumer yang gurih dan nikmat.', price: 22000, image: '/images/products/cheezy-corn.jpg', spicy_levels: null, available: 1, archived: 0 },
    { id: 3, category_id: 1, name: 'Spicy Beef Nachos', slug: 'spicy-beef-nachos', description: 'Nachos dengan daging sapi pedas', price: 27000, image: '/images/products/spicy-beef-nachos.jpg', spicy_levels: null, available: 0, archived: 1 },
    { id: 4, category_id: 1, name: 'Chicken Nachos', slug: 'chicken-nachos', description: 'Nachos dengan ayam crispy', price: 26000, image: '/images/products/chicken-nachos.jpg', spicy_levels: null, available: 0, archived: 1 },
    { id: 5, category_id: 2, name: 'Cheese Dip', slug: 'cheese-dip', description: 'Saus keju premium untuk celupan', price: 8000, image: '/images/products/cheese-dip.jpg', spicy_levels: null, available: 0, archived: 1 },
    { id: 6, category_id: 2, name: 'Jalapeño Popper', slug: 'jalapeno-popper', description: 'Jalapeño renyah isi keju', price: 12000, image: '/images/products/jalapeno-popper.jpg', spicy_levels: null, available: 0, archived: 1 },
    { id: 7, category_id: 2, name: 'French Fries', slug: 'french-fries', description: 'Kentang goreng renyah', price: 15000, image: '/images/products/french-fries.jpg', spicy_levels: null, available: 0, archived: 1 },
    { id: 8, category_id: 3, name: 'Iced Chocolate', slug: 'iced-chocolate', description: 'Cokelat dingin yang menyegarkan', price: 12000, image: '/images/products/iced-chocolate.jpg', spicy_levels: null, available: 0, archived: 1 },
  ];
  const insertProd = db.prepare(`INSERT INTO products (id, category_id, name, slug, description, price, image, spicy_levels, available, archived, created_at, updated_at)
    VALUES (@id, @category_id, @name, @slug, @description, @price, @image, @spicy_levels, @available, @archived, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      category_id = @category_id,
      name = @name,
      slug = @slug,
      description = @description,
      price = @price,
      image = @image,
      spicy_levels = @spicy_levels,
      available = @available,
      archived = @archived,
      updated_at = @updated_at`);
  for (const p of products) {
    insertProd.run({ ...p, created_at: timestamp, updated_at: timestamp });
  }

  // --- Bundles ---
  const bundles = [
    { id: 1, name: 'Movie Night Combo', slug: 'movie-night-combo', description: '2× Beefy Nacho + 1× Iced Chocolate', price: 62000, compare_price: null, image: '/images/bundles/movie-night-combo.jpg', available: 0, archived: 0 },
    { id: 2, name: 'Duo Pedas', slug: 'duo-pedas', description: '2× Beefy Nacho + 1× Cheese Dip', price: 54000, compare_price: 62000, image: '/images/bundles/duo-pedas.jpg', available: 0, archived: 0 },
  ];
  const insertBundle = db.prepare(`INSERT INTO bundles (id, name, slug, description, price, compare_price, image, available, archived, created_at, updated_at)
    VALUES (@id, @name, @slug, @description, @price, @compare_price, @image, @available, @archived, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      name = @name,
      slug = @slug,
      description = @description,
      price = @price,
      compare_price = @compare_price,
      image = @image,
      available = @available,
      archived = @archived,
      updated_at = @updated_at`);
  for (const b of bundles) {
    insertBundle.run({ ...b, created_at: timestamp, updated_at: timestamp });
  }

  // --- Bundle Items ---
  const bundleItems = [
    { bundle_id: 1, product_id: 1, quantity: 2 },
    { bundle_id: 1, product_id: 8, quantity: 1 },
    { bundle_id: 2, product_id: 1, quantity: 2 },
    { bundle_id: 2, product_id: 5, quantity: 1 },
  ];
  const insertBI = db.prepare(`INSERT OR IGNORE INTO bundle_items (bundle_id, product_id, quantity) VALUES (@bundle_id, @product_id, @quantity)`);
  for (const bi of bundleItems) insertBI.run(bi);

  // --- Promotions (Kept for admin configuration) ---
  const promos = [
    { id: 1, code: 'NACHO10', type: 'percentage', value: 10, gift_product_id: null, min_purchase: 0, eligible_type: 'all', eligible_products: null, starts_at: null, ends_at: null, active: 1, description: 'Diskon 10% untuk semua item' },
    { id: 2, code: 'HEMAT5', type: 'fixed', value: 5000, gift_product_id: null, min_purchase: 50000, eligible_type: 'all', eligible_products: null, starts_at: null, ends_at: null, active: 1, description: 'Potongan Rp5.000 untuk pesanan min Rp50.000' },
  ];
  const insertPromo = db.prepare(`INSERT INTO promotions (id, code, type, value, gift_product_id, min_purchase, eligible_type, eligible_products, starts_at, ends_at, active, description, created_at, updated_at)
    VALUES (@id, @code, @type, @value, @gift_product_id, @min_purchase, @eligible_type, @eligible_products, @starts_at, @ends_at, @active, @description, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      code = @code,
      type = @type,
      value = @value,
      min_purchase = @min_purchase,
      active = @active,
      description = @description,
      updated_at = @updated_at`);
  for (const p of promos) {
    insertPromo.run({ ...p, created_at: timestamp, updated_at: timestamp });
  }

  // --- Delivery Zones ---
  db.prepare(`
    INSERT INTO delivery_zones (id, name, fee, active)
    VALUES (1, 'Diluar Telkom', 2000, 1)
    ON CONFLICT(id) DO UPDATE SET
      name = 'Diluar Telkom',
      fee = 2000,
      active = 1
  `).run();

  // --- Store Settings ---
  const settings = {
    store_name: 'NACHOAN',
    address: '',
    phone: '+6281234567890',
    hours: 'PO Batch 1 (23-27 Nov) | Next Batch & Expo Coming Soon',
    instagram: '@nachoan_',
    demo_mode: 'true',
  };
  const insertSetting = db.prepare(`INSERT OR REPLACE INTO store_settings (key, value) VALUES (?, ?)`);
  for (const [key, value] of Object.entries(settings)) {
    insertSetting.run(key, value);
  }

  // --- Copy QRIS image ---
  const qrisSrc = 'C:/Users/aryak/.gemini/antigravity/brain/63a41194-1c69-4c62-a3dd-e2b8fa55f5f5/.user_uploaded/media_1795171344758_5a8506e5.jpg';
  const qrisDest = path.join(__dirname, '..', 'public', 'images', 'qris.jpg');
  const qrisDestDir = path.dirname(qrisDest);
  if (!fs.existsSync(qrisDestDir)) {
    fs.mkdirSync(qrisDestDir, { recursive: true });
  }
  if (fs.existsSync(qrisSrc)) {
    fs.copyFileSync(qrisSrc, qrisDest);
    console.log('QRIS image copied.');
    // Record QRIS asset
    db.prepare(`INSERT OR IGNORE INTO qris_assets (id, file_path, version, active, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(1, '/images/qris.jpg', 1, 1, timestamp);
  } else {
    console.warn('QRIS source image not found at:', qrisSrc);
  }

  // --- Hero Carousel Slides ---
  const initialSlides = [
    {
      id: 1,
      title: 'Beefy Nacho Cone',
      caption: 'Renyah, gurih, dan penuh limpahan keju & daging cincang spesial!',
      image_url: '/images/products/beefy-nacho.jpg',
      link_url: '/menu',
      sort_order: 1,
      active: 1
    },
    {
      id: 2,
      title: 'Cheezy Corn Cone',
      caption: 'Perpaduan jagung manis segar pilihan & keju lumer istimewa!',
      image_url: '/images/products/cheezy-corn.jpg',
      link_url: '/menu',
      sort_order: 2,
      active: 1
    },
    {
      id: 3,
      title: 'Inovasi Kemasan Anti-Tumpah',
      caption: 'Praktis dan seru dinikmati di mana saja tanpa ribet!',
      image_url: '/images/cone.jpg',
      link_url: '/menu',
      sort_order: 3,
      active: 1
    }
  ];

  const insertSlide = db.prepare(`
    INSERT INTO hero_slides (id, title, caption, image_url, link_url, sort_order, active, created_at, updated_at)
    VALUES (@id, @title, @caption, @image_url, @link_url, @sort_order, @active, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      title = @title,
      caption = @caption,
      image_url = @image_url,
      link_url = @link_url,
      sort_order = @sort_order,
      active = @active,
      updated_at = @updated_at
  `);

  for (const s of initialSlides) {
    insertSlide.run({ ...s, created_at: timestamp, updated_at: timestamp });
  }

  console.log('Seed data inserted successfully.');
}

if (require.main === module) {
  seed();
}

module.exports = seed;
