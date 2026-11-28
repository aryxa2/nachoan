const assert = require('assert');
const getDb = require('../lib/db');
const { getTopSellingProduct } = require('../lib/orders');
const { parseMenuSummaryCounts } = require('../lib/sheets');
const { now } = require('../lib/helpers');

console.log('=== TESTING SINGLE BEST SELLER SELECTION ===\n');

const db = getDb();
const t = now();
const testOrderNumbers = ['NCH-BS001', 'NCH-BS002', 'NCH-BS003', 'NCH-BS004'];
const testProductSlugs = ['test-bs-unavail'];

try {
  // 1. Verify parseMenuSummaryCounts (Google Sheets Orders format)
  console.log('1. Testing Google Sheets Ringkasan Menu parser');
  const parsed = parseMenuSummaryCounts([
    { 'Status Pembayaran': 'PAID', 'Status Pesanan': 'COMPLETED', 'Ringkasan Menu': '2x Beefy Nacho, 1x Cheezy Corn' },
    { 'Status Pembayaran': 'PAID', 'Status Pesanan': 'PREPARING', 'Ringkasan Menu': '3x Cheezy Corn, 1x Cheese Dip (Bonus Promo)' },
    { 'Status Pembayaran': 'UNPAID', 'Status Pesanan': 'NEW', 'Ringkasan Menu': '50x Beefy Nacho' },
    { 'Status Pembayaran': 'PAID', 'Status Pesanan': 'CANCELLED', 'Ringkasan Menu': '20x Beefy Nacho' },
    { 'Status Pembayaran': 'PAID', 'Status Pesanan': 'REJECTED', 'Ringkasan Menu': '15x Beefy Nacho' }
  ]);
  assert.strictEqual(parsed.get('beefy nacho'), 2, 'Only PAID non-cancelled/rejected Beefy Nacho counts');
  assert.strictEqual(parsed.get('cheezy corn'), 4, 'Cheezy Corn sums across valid PAID orders');
  assert.strictEqual(parsed.get('cheese dip (bonus promo)'), undefined, 'Bonus Promo gift items are excluded');
  console.log('✔ Sheets parser verified.');

  // 2. Verify salesOverrideMap ranking & tie-break
  console.log('\n2. Testing salesOverrideMap ranking');
  const overrideWinner = getTopSellingProduct(parsed);
  assert(overrideWinner && overrideWinner.product, 'Must return a winning product');
  assert.strictEqual(overrideWinner.product.slug, 'cheezy-corn', 'Cheezy Corn (4) beats Beefy Nacho (2)');
  assert.strictEqual(overrideWinner.totalSold, 4);

  const emptyOverride = getTopSellingProduct(new Map());
  assert(emptyOverride && emptyOverride.product, 'Fallback must return first active product on 0 sales');
  assert.strictEqual(emptyOverride.totalSold, 0);
  console.log('✔ salesOverrideMap ranking and fallback verified.');

  // 3. Verify SQLite aggregation (PAID only, non-cancelled, non-gift, available & non-archived only)
  console.log('\n3. Testing SQLite top-selling product query');
  const beefy = db.prepare('SELECT id FROM products WHERE slug = ?').get('beefy-nacho');
  const cheezy = db.prepare('SELECT id FROM products WHERE slug = ?').get('cheezy-corn');
  assert(beefy && cheezy, 'Seeded products must exist');

  // Insert an unavailable product with huge sales to ensure it is skipped
  const unavailRes = db.prepare(`
    INSERT INTO products (category_id, name, slug, description, price, image, available, archived, created_at, updated_at)
    VALUES (1, 'Test Unavail Best', 'test-bs-unavail', 'Unavailable', 10000, '/images/cone.jpg', 0, 0, ?, ?)
  `).run(t, t);
  const unavailId = unavailRes.lastInsertRowid;

  // Insert controlled orders
  const oPaidCheezy = db.prepare(`
    INSERT INTO orders (order_number, access_token, customer_name, customer_phone, method, subtotal, total, payment_status, order_status, created_at, updated_at)
    VALUES ('NCH-BS001', 'tok_bs_1', 'Test A', '+628111', 'pickup', 130000, 130000, 'PAID', 'COMPLETED', ?, ?)
  `).run(t, t).lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id, product_id, name, price, quantity, is_gift) VALUES (?, ?, ?, ?, ?, 0)')
    .run(oPaidCheezy, cheezy.id, 'Cheezy Corn', 13000, 100);
  // Gift item on Beefy Nacho shouldn't count
  db.prepare('INSERT INTO order_items (order_id, product_id, name, price, quantity, is_gift) VALUES (?, ?, ?, ?, ?, 1)')
    .run(oPaidCheezy, beefy.id, 'Beefy Nacho (Bonus Promo)', 0, 500);

  // Unpaid order with 500 Beefy Nacho shouldn't count
  const oUnpaidBeefy = db.prepare(`
    INSERT INTO orders (order_number, access_token, customer_name, customer_phone, method, subtotal, total, payment_status, order_status, created_at, updated_at)
    VALUES ('NCH-BS002', 'tok_bs_2', 'Test B', '+628222', 'pickup', 7500000, 7500000, 'UNPAID', 'NEW', ?, ?)
  `).run(t, t).lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id, product_id, name, price, quantity, is_gift) VALUES (?, ?, ?, ?, ?, 0)')
    .run(oUnpaidBeefy, beefy.id, 'Beefy Nacho', 15000, 500);

  // Paid but cancelled order shouldn't count
  const oCancelledBeefy = db.prepare(`
    INSERT INTO orders (order_number, access_token, customer_name, customer_phone, method, subtotal, total, payment_status, order_status, created_at, updated_at)
    VALUES ('NCH-BS003', 'tok_bs_3', 'Test C', '+628333', 'pickup', 3000000, 3000000, 'PAID', 'CANCELLED', ?, ?)
  `).run(t, t).lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id, product_id, name, price, quantity, is_gift) VALUES (?, ?, ?, ?, ?, 0)')
    .run(oCancelledBeefy, beefy.id, 'Beefy Nacho', 15000, 200);

  // Paid order for unavailable product shouldn't win
  const oUnavail = db.prepare(`
    INSERT INTO orders (order_number, access_token, customer_name, customer_phone, method, subtotal, total, payment_status, order_status, created_at, updated_at)
    VALUES ('NCH-BS004', 'tok_bs_4', 'Test D', '+628444', 'pickup', 9990000, 9990000, 'PAID', 'COMPLETED', ?, ?)
  `).run(t, t).lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id, product_id, name, price, quantity, is_gift) VALUES (?, ?, ?, ?, ?, 0)')
    .run(oUnavail, unavailId, 'Test Unavail Best', 10000, 999);

  const sqlWinner = getTopSellingProduct();
  assert(sqlWinner && sqlWinner.product, 'SQLite top seller must return a product');
  assert.strictEqual(sqlWinner.product.slug, 'cheezy-corn', 'Cheezy Corn must win over unavailable, unpaid, cancelled, and gift items');
  assert(sqlWinner.totalSold >= 100, 'Total sold must reflect paid non-gift Cheezy Corn quantity');
  console.log(`✔ SQLite ranking verified (winner: ${sqlWinner.product.name}, sold: ${sqlWinner.totalSold}).`);
} finally {
  // Clean up test rows
  const placeholders = testOrderNumbers.map(() => '?').join(',');
  db.prepare(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE order_number IN (${placeholders}))`).run(...testOrderNumbers);
  db.prepare(`DELETE FROM orders WHERE order_number IN (${placeholders})`).run(...testOrderNumbers);
  db.prepare('DELETE FROM products WHERE slug = ?').run(...testProductSlugs);
}

console.log('\nALL BEST SELLER TESTS PASSED! 🎉');
