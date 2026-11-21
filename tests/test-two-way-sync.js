const assert = require('assert');
const http = require('http');
const getDb = require('../lib/db');
const sheets = require('../lib/sheets');

console.log('=== TESTING TWO-WAY SYNC & BULK CRUD ===\n');

function postJSON(path, payload, cookies = '') {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Accept': 'application/json',
        'Cookie': cookies
      }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(path, cookies = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: path,
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/html',
        'Cookie': cookies
      }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  try {
    const db = getDb();

    // 1. Reset from scratch
    console.log('1. Resetting database orders and spreadsheet to fresh state...');
    sheets.resetSpreadsheet(true);
    const initialOrders = db.prepare('SELECT COUNT(*) as count FROM orders').get().count;
    assert.strictEqual(initialOrders, 0, 'Orders should be 0 after reset');
    console.log('✔ Reset verified: 0 orders in database.');

    // 2. User places order via /checkout
    console.log('\n2. Testing Customer Order Creation via /checkout...');
    const orderRes = await postJSON('/checkout', {
      customer_name: 'Aditya Pratama',
      customer_phone: '081234567890',
      method: 'delivery',
      delivery_zone_id: 1,
      address: 'Jl. Telekomunikasi No. 1, Bojongsoang',
      notes: 'Ekstra saus keju',
      items: [
        { type: 'product', id: 1, quantity: 2 }, // 2x Beefy Nacho = 50.000
        { type: 'product', id: 2, quantity: 1 }  // 1x Cheezy Corn = 22.000
      ]
    });
    assert.strictEqual(orderRes.status, 200);
    assert(orderRes.data.success);
    const orderNumber1 = orderRes.data.orderNumber;
    console.log(`✔ Customer order created: ${orderNumber1} (Total: Rp74.000)`);

    // Allow async push to Google Sheets
    await new Promise(r => setTimeout(r, 2500));

    // Verify order exists in DB
    const o1 = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(orderNumber1);
    assert(o1, 'Order must exist in database');
    assert.strictEqual(o1.total, 74000); // 50000 + 22000 + 2000 delivery fee
    assert.strictEqual(o1.payment_status, 'UNPAID');
    assert.strictEqual(o1.order_status, 'NEW');

    // 3. Admin Login
    console.log('\n3. Testing Admin Login...');
    const querystring = require('querystring');
    const loginData = querystring.stringify({ username: 'admin', password: 'nachoan2026' });
    const loginRes = await new Promise(resolve => {
      const req = http.request({
        hostname: 'localhost',
        port: 3000,
        path: '/admin/login',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(loginData)
        }
      }, r => resolve(r));
      req.write(loginData);
      req.end();
    });
    const setCookie = loginRes.headers['set-cookie'];
    assert(setCookie, 'Must receive session cookie');
    const adminCookie = setCookie.map(c => c.split(';')[0]).join('; ');
    console.log('✔ Admin logged in successfully.');

    // 4. Create another manual order from Admin
    console.log('\n4. Testing Admin Manual Order Creation (/admin/orders/create-manual)...');
    const manOrderRes = await postJSON('/admin/orders/create-manual', {
      customer_name: 'Maya Indah',
      customer_phone: '081299998888',
      method: 'pickup',
      payment_status: 'PAID',
      order_status: 'PREPARING',
      notes: 'Langsung ambil di toko',
      items: [
        { product_id: 1, quantity: 1 } // 1x Beefy Nacho = 25.000
      ]
    }, adminCookie);
    assert.strictEqual(manOrderRes.status, 200);
    assert(manOrderRes.data.success);
    const orderNumber2 = manOrderRes.data.orderNumber;
    console.log(`✔ Admin manual order created: ${orderNumber2}`);

    await new Promise(r => setTimeout(r, 2000));

    // 5. Test Bulk Status Update
    console.log('\n5. Testing Bulk Status Update (/admin/orders/bulk-update)...');
    const allOrders = db.prepare('SELECT id FROM orders').all();
    assert.strictEqual(allOrders.length, 2);
    const orderIds = allOrders.map(o => o.id);

    const bulkRes = await postJSON('/admin/orders/bulk-update', {
      order_ids: orderIds,
      order_status: 'READY',
      payment_status: 'PAID'
    }, adminCookie);
    assert.strictEqual(bulkRes.status, 200);
    assert(bulkRes.data.success);
    console.log(`✔ Bulk update response: ${bulkRes.data.message}`);

    // Verify DB updated
    const updatedOrders = db.prepare('SELECT id, payment_status, order_status FROM orders').all();
    for (const u of updatedOrders) {
      assert.strictEqual(u.payment_status, 'PAID');
      assert.strictEqual(u.order_status, 'READY');
    }
    console.log('✔ Both orders in database now have payment_status=PAID and order_status=READY.');

    // 6. Test Two-Way Sync (Spreadsheet -> Website)
    console.log('\n6. Testing Two-Way Sync Pull (/admin/orders/sync-from-sheets)...');
    const pullRes = await postJSON('/admin/orders/sync-from-sheets', {}, adminCookie);
    assert.strictEqual(pullRes.status, 200);
    assert(pullRes.data.success);
    console.log(`✔ Two-way sync pulled successfully: ${pullRes.data.message}`);

    // 7. Verify /admin/orders renders HTML with bulk tools
    console.log('\n7. Verifying /admin/orders renders bulk tools and checkboxes...');
    const pageRes = await get('/admin/orders', adminCookie);
    assert.strictEqual(pageRes.status, 200);
    assert(pageRes.body.includes('bulk-bar'), 'Must include bulk-bar');
    assert(pageRes.body.includes('check-all'), 'Must include master checkbox');
    assert(pageRes.body.includes('manual-order-modal'), 'Must include manual order modal');
    assert(pageRes.body.includes('Tarik dari Spreadsheet'), 'Must include sync from sheets button');
    console.log('✔ Admin orders page UI verified.');

    console.log('\n======================================================');
    console.log('ALL TWO-WAY SYNC & BULK CRUD TESTS PASSED 100%! 🎉');
    console.log('======================================================\n');
    process.exit(0);

  } catch (err) {
    console.error('TEST FAILED:', err);
    process.exit(1);
  }
})();
