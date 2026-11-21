const getDb = require('../lib/db');
const { now } = require('../lib/helpers');

const db = getDb();
const currentTime = now();

// 1. Archive previous products
db.prepare('UPDATE products SET archived = 1, available = 0').run();

// 2. Insert or update Beefy Nacho and Cheezy Corn
const upsertProd = db.prepare(`
  INSERT INTO products (id, category_id, name, slug, description, price, image, spicy_levels, available, archived, created_at, updated_at)
  VALUES (@id, @category_id, @name, @slug, @description, @price, @image, @spicy_levels, 1, 0, @created_at, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    category_id = @category_id,
    name = @name,
    slug = @slug,
    description = @description,
    price = @price,
    image = @image,
    spicy_levels = @spicy_levels,
    available = 1,
    archived = 0,
    updated_at = @updated_at
`);

upsertProd.run({
  id: 1,
  category_id: 1,
  name: 'Beefy Nacho',
  slug: 'beefy-nacho',
  description: 'Nachos renyah cone dengan limpahan saus keju gurih dan daging sapi bumbu cincang spesial.',
  price: 25000,
  image: '/images/products/beefy-nacho.jpg',
  spicy_levels: null, // Tidak ada level kepedasan
  created_at: currentTime,
  updated_at: currentTime
});

upsertProd.run({
  id: 2,
  category_id: 1,
  name: 'Cheezy Corn',
  slug: 'cheezy-corn',
  description: 'Perpaduan renyah cone nacho, jagung manis segar pilihan, dan lelehan keju lumer yang gurih nikmat.',
  price: 22000,
  image: '/images/products/cheezy-corn.jpg',
  spicy_levels: null, // Tidak ada level kepedasan
  created_at: currentTime,
  updated_at: currentTime
});

// 3. Bundles: mark available = 0
db.prepare('UPDATE bundles SET available = 0').run();

// 4. Update Promo: keep NACHO10 and HEMAT5 active for admin management
db.prepare(`UPDATE promotions SET active = 1 WHERE code IN ('NACHO10', 'HEMAT5')`).run();

// 5. Update Delivery Zones: Diluar Telkom - Rp2.000
db.prepare(`
  INSERT INTO delivery_zones (id, name, fee, active)
  VALUES (1, 'Diluar Telkom', 2000, 1)
  ON CONFLICT(id) DO UPDATE SET
    name = 'Diluar Telkom',
    fee = 2000,
    active = 1
`).run();

console.log('Database updated with Beefy Nacho, Cheezy Corn, and Delivery Zone Diluar Telkom - Rp2.000!');
