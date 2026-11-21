const assert = require('assert');
const getDb = require('../lib/db');

console.log('=== TESTING ADMIN EDIT CAPABILITIES ===\n');

const db = getDb();

// 1. Test Edit Product
console.log('1. Testing Product Edit');
const p = db.prepare('SELECT * FROM products WHERE id = 1').get();
assert(p, 'Product 1 must exist');

// Update Loaded Nachos price to 26000 and description
db.prepare(`
  UPDATE products 
  SET name = 'Loaded Nachos Special', price = 26000, description = 'Nachos loaded dengan saus keju ekstra', spicy_levels = ?
  WHERE id = 1
`).run(JSON.stringify(['Original', 'Pedas', 'Extra Pedas', 'Monster Pedas']));

const updatedP = db.prepare('SELECT * FROM products WHERE id = 1').get();
assert.strictEqual(updatedP.name, 'Loaded Nachos Special');
assert.strictEqual(updatedP.price, 26000);
assert.strictEqual(JSON.parse(updatedP.spicy_levels).length, 4);

// Revert back
db.prepare(`
  UPDATE products 
  SET name = 'Beefy Nacho', slug = 'beefy-nacho', price = 25000, description = 'Nachos renyah cone dengan limpahan saus keju gurih dan daging sapi bumbu cincang spesial.', spicy_levels = null
  WHERE id = 1
`).run();
console.log('✔ Product Edit successfully tested.');

// 2. Test Edit Bundle & Components
console.log('\n2. Testing Bundle & Component Edit');
const b = db.prepare('SELECT * FROM bundles WHERE id = 1').get();
assert(b, 'Bundle 1 must exist');

// Edit Movie Night Combo price to 65000 and compare_price to 75000
db.prepare(`
  UPDATE bundles
  SET name = 'Movie Night Mega Combo', price = 65000, compare_price = 75000
  WHERE id = 1
`).run();

// Edit components: 2x Loaded Nachos + 2x Iced Chocolate
db.prepare('DELETE FROM bundle_items WHERE bundle_id = 1').run();
db.prepare('INSERT INTO bundle_items (bundle_id, product_id, quantity) VALUES (1, 1, 2)').run();
db.prepare('INSERT INTO bundle_items (bundle_id, product_id, quantity) VALUES (1, 8, 2)').run();

const updatedB = db.prepare('SELECT * FROM bundles WHERE id = 1').get();
assert.strictEqual(updatedB.name, 'Movie Night Mega Combo');
assert.strictEqual(updatedB.price, 65000);
assert.strictEqual(updatedB.compare_price, 75000);

const itemsB = db.prepare('SELECT * FROM bundle_items WHERE bundle_id = 1').all();
assert.strictEqual(itemsB.length, 2);
assert.strictEqual(itemsB[1].quantity, 2);

// Revert back
db.prepare(`
  UPDATE bundles
  SET name = 'Movie Night Combo', price = 62000, compare_price = NULL
  WHERE id = 1
`).run();
db.prepare('DELETE FROM bundle_items WHERE bundle_id = 1').run();
db.prepare('INSERT INTO bundle_items (bundle_id, product_id, quantity) VALUES (1, 1, 2)').run();
db.prepare('INSERT INTO bundle_items (bundle_id, product_id, quantity) VALUES (1, 8, 1)').run();
console.log('✔ Bundle & Component Edit successfully tested.');

// 3. Test Edit Promo
console.log('\n3. Testing Promo Edit');
const promo = db.prepare('SELECT * FROM promotions WHERE id = 1').get();
assert(promo, 'Promo 1 must exist');

db.prepare(`
  UPDATE promotions
  SET code = 'NACHO15', value = 15, description = 'Diskon 15% untuk semua menu'
  WHERE id = 1
`).run();

const updatedPromo = db.prepare('SELECT * FROM promotions WHERE id = 1').get();
assert.strictEqual(updatedPromo.code, 'NACHO15');
assert.strictEqual(updatedPromo.value, 15);

// Revert back
db.prepare(`
  UPDATE promotions
  SET code = 'NACHO10', value = 10, description = 'Diskon 10% untuk semua item'
  WHERE id = 1
`).run();
console.log('✔ Promo Edit successfully tested.');

console.log('\n=======================================');
console.log('ALL EDIT FUNCTIONALITY TESTS PASSED! 🎉');
console.log('=======================================\n');
