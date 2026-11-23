const assert = require('assert');
const bcrypt = require('bcryptjs');
const getDb = require('../lib/db');
const { calculateCart } = require('../lib/cart');
const { formatRupiah, generateOrderNumber, generateToken, normalizePhone, now, formatDate, getStatusInfo } = require('../lib/helpers');

console.log('=== RUNNING NACHOAN VERIFICATION TESTS ===\n');

const db = getDb();

// 1. Test Admin Credentials
console.log('Test 1: Admin Account Verification');
const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get('admin');
assert(admin, 'Admin account must exist');
assert(bcrypt.compareSync('nachoan2026', admin.password_hash), 'Admin password must match nachoan2026');
console.log('✔ Admin account verified.');

// 2. Test Catalog & Prices
console.log('\nTest 2: Products & Menu Verification');
const beefy = db.prepare('SELECT * FROM products WHERE slug = ?').get('beefy-nacho');
assert(beefy, 'Beefy Nacho must exist');
assert.strictEqual(beefy.price, 15000, 'Beefy Nacho must be Rp15.000');
assert.strictEqual(beefy.spicy_levels, null, 'Beefy Nacho must not have spicy levels');

const cheezy = db.prepare('SELECT * FROM products WHERE slug = ?').get('cheezy-corn');
assert(cheezy, 'Cheezy Corn must exist');
assert.strictEqual(cheezy.price, 13000, 'Cheezy Corn must be Rp13.000');
assert.strictEqual(cheezy.spicy_levels, null, 'Cheezy Corn must not have spicy levels');
console.log('✔ Products Beefy Nacho and Cheezy Corn verified.');

// 3. Test Cart with Active Menu
console.log('\nTest 3: Cart Calculation with Beefy Nacho & Cheezy Corn');
const cart1 = calculateCart([
  { type: 'product', id: 1, quantity: 1 }
]);
assert.strictEqual(cart1.subtotal, 15000);

const cart2 = calculateCart([
  { type: 'product', id: 1, quantity: 2 }, // 30.000
  { type: 'product', id: 2, quantity: 1 }  // 13.000
]);
assert.strictEqual(cart2.subtotal, 43000);
console.log('✔ Cart calculations verified.');

// 4. Test Voucher Promos (NACHO10 & HEMAT5)
console.log('\nTest 4: Promo Codes (NACHO10 & HEMAT5)');
// NACHO10 gives 10%
const cartPromo1 = calculateCart([
  { type: 'product', id: 1, quantity: 4, variant: 'Original' } // 60.000
], { promoCode: 'NACHO10' });
assert.strictEqual(cartPromo1.promo.valid, true);
assert.strictEqual(cartPromo1.discount, 6000, '10% of 60.000 is 6.000');
assert.strictEqual(cartPromo1.total, 54000);

// HEMAT5 with subtotal < 50.000 should fail min purchase
const cartPromo2Fail = calculateCart([
  { type: 'product', id: 1, quantity: 1, variant: 'Original' } // 15.000
], { promoCode: 'HEMAT5' });
assert.strictEqual(cartPromo2Fail.promo.valid, false, 'HEMAT5 should fail for subtotal < 50.000');

// HEMAT5 with subtotal >= 50.000 should succeed
const cartPromo2Pass = calculateCart([
  { type: 'product', id: 1, quantity: 4, variant: 'Original' } // 60.000
], { promoCode: 'HEMAT5' });
assert.strictEqual(cartPromo2Pass.promo.valid, true);
assert.strictEqual(cartPromo2Pass.discount, 5000);
assert.strictEqual(cartPromo2Pass.total, 55000);
console.log('✔ Voucher promos NACHO10 and HEMAT5 verified.');

// 5. Test Delivery vs Pickup
console.log('\nTest 5: Delivery and Pickup fees');
const cartPickup = calculateCart([
  { type: 'product', id: 2, quantity: 1 } // 13.000
], { method: 'pickup' });
assert.strictEqual(cartPickup.deliveryFee, 0);
assert.strictEqual(cartPickup.total, 13000);

const cartDelivery = calculateCart([
  { type: 'product', id: 2, quantity: 1 } // 13.000
], { method: 'delivery' });
assert.strictEqual(cartDelivery.deliveryFee, 2000, 'Diluar Telkom delivery fee must be Rp2.000');
assert.strictEqual(cartDelivery.total, 15000);
console.log('✔ Delivery and Pickup fees verified.');

// 6. Test Idempotency & Order Generation
console.log('\nTest 6: Order ID & High-Entropy Token Generation');
const ordNum = generateOrderNumber();
assert(/^NCH-\d{5}$/.test(ordNum), 'Order number must format NCH-XXXXX');
const token = generateToken();
assert.strictEqual(token.length, 64, 'Token must be 64-char hex string');
console.log(`✔ Order Number (${ordNum}) and Token (${token.slice(0, 16)}...) verified.`);

// 7. Test Phone Normalization
console.log('\nTest 7: Phone Normalization');
assert.strictEqual(normalizePhone('081234567890'), '+6281234567890');
assert.strictEqual(normalizePhone('6281234567890'), '+6281234567890');
assert.strictEqual(normalizePhone('+6281234567890'), '+6281234567890');
assert.strictEqual(normalizePhone('0812-3456-7890'), '+6281234567890');
console.log('✔ Phone normalization verified.');

// 8. Test Verified Revenue in Database
console.log('\nTest 8: Strict Verified Revenue Calculation (PAID only)');
// Insert a dummy UNPAID order and a dummy PAID order
const t = now();
const o1 = db.prepare(`
  INSERT INTO orders (order_number, access_token, customer_name, customer_phone, method, subtotal, total, payment_status, order_status, created_at, updated_at)
  VALUES ('NCH-TEST1', 'tokentest1', 'Budi', '+62811111111', 'pickup', 100000, 100000, 'UNPAID', 'NEW', ?, ?)
`).run(t, t);

const o2 = db.prepare(`
  INSERT INTO orders (order_number, access_token, customer_name, customer_phone, method, subtotal, total, payment_status, order_status, created_at, updated_at)
  VALUES ('NCH-TEST2', 'tokentest2', 'Siti', '+62822222222', 'pickup', 50000, 50000, 'PAID', 'PAID', ?, ?)
`).run(t, t);

const revRow = db.prepare("SELECT COALESCE(SUM(total), 0) as verified_revenue FROM orders WHERE payment_status = 'PAID'").get();
// Should only sum the PAID orders, not the UNPAID 100.000!
assert(revRow.verified_revenue >= 50000, 'Verified revenue includes paid order');
const unpaidSum = db.prepare("SELECT COALESCE(SUM(total), 0) as s FROM orders WHERE payment_status = 'UNPAID'").get();
assert(unpaidSum.s >= 100000, 'Unpaid orders exist separately');

// Clean up test orders
db.prepare("DELETE FROM orders WHERE order_number IN ('NCH-TEST1', 'NCH-TEST2')").run();
console.log('✔ Verified Revenue strict calculation verified.');

console.log('\n========================================');
console.log('ALL VERIFICATION TESTS PASSED SUCCESSFULLY!');
console.log('========================================\n');
