const assert = require('assert');
const http = require('http');
const getDb = require('../lib/db');
const { getTopSellingProduct } = require('../lib/orders');
const { resolveCategoryId, getOrdersSheetData } = require('../lib/sheets');
const { now } = require('../lib/helpers');

const PORT = 3000;

function request(method, reqPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: PORT,
      path: reqPath,
      method,
      headers: { ...headers }
    };
    let postData = null;
    if (body) {
      if (typeof body === 'object' && !headers['Content-Type']) {
        postData = JSON.stringify(body);
        opts.headers['Content-Type'] = 'application/json';
      } else {
        postData = body;
      }
      opts.headers['Content-Length'] = Buffer.byteLength(postData);
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function run() {
  console.log('=== TESTING CHECKOUT ADD-ON & MANUAL REFERRAL ===\n');
  const db = getDb();
  const ts = now();
  let createdAddonId = null;
  let createdOrderToken = null;
  let createdOrderId = null;

  try {
    // 1. Auto-migration checks: Add-on category (id=5) and orders.referral_code column
    console.log('1. Verifying DB schema & Add-on category');
    const addonCat = db.prepare('SELECT * FROM categories WHERE id = 5').get();
    assert(addonCat && addonCat.slug === 'add-on', 'Category id=5 (Add-on) must exist');
    const orderCols = db.prepare('PRAGMA table_info(orders)').all();
    assert(orderCols.some(c => c.name === 'referral_code'), 'orders.referral_code column must exist');
    assert.strictEqual(resolveCategoryId(null, 'Add-on'), 5, 'resolveCategoryId must map Add-on to 5');
    console.log('✔ Schema, Add-on category, and Sheets category resolver verified.');

    // 2. Insert a temporary Add-on product and verify GET /checkout & /menu & Best Seller guard
    console.log('\n2. Testing Add-on visibility on /checkout, exclusion from /menu & Best Seller');
    const ins = db.prepare(`
      INSERT INTO products (category_id, name, slug, description, price, image, available, archived, created_at, updated_at)
      VALUES (5, 'Test Extra Cheese Sauce', 'test-extra-cheese-sauce', 'Saus keju tambahan', 4000, '/images/products/cheese-dip.jpg', 1, 0, ?, ?)
    `).run(ts, ts);
    createdAddonId = ins.lastInsertRowid;

    const checkoutPage = await request('GET', '/checkout');
    assert.strictEqual(checkoutPage.statusCode, 200);
    assert(checkoutPage.body.includes('id="checkout-addons-card"'), 'Checkout must render Menu Add-on card when active add-ons exist');
    assert(checkoutPage.body.includes('Test Extra Cheese Sauce'), 'Checkout Add-on card must list active add-on product');
    assert(checkoutPage.body.includes('id="cust-referral"'), 'Checkout must render Kode Referral input');

    const menuPage = await request('GET', '/menu');
    assert.strictEqual(menuPage.statusCode, 200);
    assert(!menuPage.body.includes('Test Extra Cheese Sauce'), 'Add-on must not appear in main /menu catalog');

    // 3. Checkout POST with main product + add-on + referral_code
    console.log('\n3. Testing POST /checkout with Add-on + Manual Referral Code');
    const checkoutRes = await request('POST', '/checkout', {
      customer_name: 'Tester Referral',
      customer_phone: '081234567899',
      method: 'pickup',
      referral_code: '  nch-rafi99  ',
      notes: 'Test catatan',
      items: [
        { type: 'product', id: 1, quantity: 1 },
        { type: 'product', id: createdAddonId, quantity: 2 }
      ]
    });
    assert.strictEqual(checkoutRes.statusCode, 200);
    const payload = JSON.parse(checkoutRes.body);
    assert.strictEqual(payload.success, true);
    createdOrderToken = payload.token;

    const savedOrder = db.prepare('SELECT * FROM orders WHERE access_token = ?').get(createdOrderToken);
    assert(savedOrder, 'Order must be saved');
    createdOrderId = savedOrder.id;
    assert.strictEqual(savedOrder.referral_code, 'NCH-RAFI99', 'Referral code must be trimmed & uppercased');
    assert.strictEqual(savedOrder.subtotal, 15000 + (4000 * 2), 'Subtotal must include add-on items');

    // Mark order PAID temporarily and ensure Add-on does not hijack #1 Best Seller even with high qty
    db.prepare("UPDATE orders SET payment_status = 'PAID', order_status = 'COMPLETED' WHERE id = ?").run(createdOrderId);
    db.prepare('UPDATE order_items SET quantity = 999 WHERE order_id = ? AND product_id = ?').run(createdOrderId, createdAddonId);
    const topSeller = getTopSellingProduct();
    assert(topSeller && topSeller.product.category_id !== 5, 'Add-on product must never become #1 Best Seller');

    // Check Sheets export includes Kode Referral
    const sheetRows = getOrdersSheetData();
    const sheetMatch = sheetRows.find(r => r['No Pesanan'] === savedOrder.order_number);
    assert(sheetMatch && sheetMatch['Kode Referral'] === 'NCH-RAFI99', 'Sheets export must contain Kode Referral');

    // 4. Verify Customer Order page + Admin Orders search & detail display referral_code + Admin Add-on filter
    console.log('\n4. Testing Customer Order view & Admin Add-on / Referral views');
    const orderPage = await request('GET', `/order/${createdOrderToken}`);
    assert.strictEqual(orderPage.statusCode, 200);
    assert(orderPage.body.includes('NCH-RAFI99'), 'Customer order page must display recorded referral code');

    const loginRes = await request('POST', '/admin/login', 'username=admin&password=nachoan2026', {
      'Content-Type': 'application/x-www-form-urlencoded'
    });
    assert.strictEqual(loginRes.statusCode, 302);
    const adminCookie = loginRes.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');

    const adminAddonRes = await request('GET', '/admin/products?filter=addon', null, { Cookie: adminCookie });
    assert.strictEqual(adminAddonRes.statusCode, 200);
    assert(adminAddonRes.body.includes('Kelola Menu Add-on'), 'Admin add-on filter view must render');
    assert(adminAddonRes.body.includes('Test Extra Cheese Sauce'), 'Admin add-on filter must list Add-on product');

    const adminSearchRes = await request('GET', '/admin/orders?search=NCH-RAFI99', null, { Cookie: adminCookie });
    assert.strictEqual(adminSearchRes.statusCode, 200);
    assert(adminSearchRes.body.includes(savedOrder.order_number), 'Admin orders search must match referral_code');
    assert(adminSearchRes.body.includes('Ref: NCH-RAFI99'), 'Admin orders table must display referral badge');

    const adminDetailRes = await request('GET', `/admin/orders/${createdOrderId}`, null, { Cookie: adminCookie });
    assert.strictEqual(adminDetailRes.statusCode, 200);
    assert(adminDetailRes.body.includes('NCH-RAFI99'), 'Admin order detail must display Kode Referral');

    console.log('✔ Customer order view, Admin Add-on filter, and Admin Referral search/detail verified.');
  } finally {
    if (createdOrderId) {
      db.prepare('DELETE FROM order_status_history WHERE order_id = ?').run(createdOrderId);
      db.prepare('DELETE FROM payment_submissions WHERE order_id = ?').run(createdOrderId);
      db.prepare('DELETE FROM order_items WHERE order_id = ?').run(createdOrderId);
      db.prepare('DELETE FROM orders WHERE id = ?').run(createdOrderId);
    }
    if (createdAddonId) {
      db.prepare('DELETE FROM products WHERE id = ?').run(createdAddonId);
    }
  }

  console.log('\nALL ADD-ON & REFERRAL TESTS PASSED! 🎉');
}

run().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});
