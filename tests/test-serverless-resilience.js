const assert = require('assert');
const http = require('http');
const getDb = require('../lib/db');

const PORT = 3000;

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: PORT,
      path: path,
      method: method,
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
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function testResilience() {
  console.log('=== TESTING SERVERLESS RESILIENCE & MULTI-INSTANCE PERSISTENCE ===\n');
  const db = getDb();

  // 1. Admin Stateless Navigation (No more stuck when ganti slash!)
  console.log('1. Testing Admin Login and Multi-Route Navigation');
  const loginRes = await request('POST', '/admin/login',
    'username=admin&password=nachoan2026',
    { 'Content-Type': 'application/x-www-form-urlencoded' }
  );
  assert.strictEqual(loginRes.statusCode, 302);
  const sessionCookies = loginRes.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
  console.log('✔ Admin logged in, stateless signed cookie received.');

  const adminRoutes = [
    '/admin',
    '/admin/',
    '/admin/orders',
    '/admin/products',
    '/admin/bundles',
    '/admin/promos',
    '/admin/carousel',
    '/admin/settings'
  ];

  for (const r of adminRoutes) {
    const res = await request('GET', r, null, { 'Cookie': sessionCookies });
    assert.strictEqual(res.statusCode, 200, `Route ${r} must return 200 OK, got ${res.statusCode}`);
    console.log(`✔ Navigated to ${r}: 200 OK`);
  }
  console.log('✔ Admin can navigate freely between all routes without getting stuck!\n');

  // 2. Order Creation & Auto-Rehydration across separate instances
  console.log('2. Testing Order Rehydration (Simulating Cold Start / Fresh Instance)');
  const checkoutRes = await request('POST', '/checkout', {
    customer_name: 'Simulated Cold Lambda User',
    customer_phone: '081234567890',
    method: 'pickup',
    items: [{ type: 'product', id: 1, quantity: 2 }]
  });
  assert.strictEqual(checkoutRes.statusCode, 200);
  const orderData = JSON.parse(checkoutRes.body);
  const token = orderData.token;
  const clientCookies = checkoutRes.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
  console.log(`✔ Order created: Token ${token.slice(0, 16)}...`);

  // Now simulate a fresh cold Lambda container: DELETE the order from local SQLite!
  console.log('   Simulating cold container: deleting order from current SQLite...');
  db.prepare('DELETE FROM order_status_history WHERE order_id = (SELECT id FROM orders WHERE access_token = ?)').run(token);
  db.prepare('DELETE FROM order_items WHERE order_id = (SELECT id FROM orders WHERE access_token = ?)').run(token);
  db.prepare('DELETE FROM orders WHERE access_token = ?').run(token);
  const checkDeleted = db.prepare('SELECT * FROM orders WHERE access_token = ?').get(token);
  assert.strictEqual(checkDeleted, undefined, 'Order must be absent in cold container database');

  // Now customer accesses /order/:token with their cookie
  console.log('   Customer accesses /order/:token on fresh container...');
  const orderPageRes = await request('GET', `/order/${token}`, null, { 'Cookie': clientCookies });
  assert.strictEqual(orderPageRes.statusCode, 200, 'Must return 200 OK instead of 404');
  assert(orderPageRes.body.includes(orderData.orderNumber), 'Must render order details');
  console.log('✔ Order was automatically rehydrated into the fresh container database!');

  // Now customer uploads payment proof on fresh container
  console.log('   Customer submits payment proof on fresh container...');
  const boundary = '----WebKitFormBoundaryTest' + Date.now();
  const dummyFile = 'dummy jpeg bytes';
  const multipartBody = 
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="payment_proof"; filename="struk.jpg"\r\n` +
    `Content-Type: image/jpeg\r\n\r\n` +
    dummyFile + `\r\n` +
    `--${boundary}--\r\n`;

  const uploadRes = await request('POST', `/order/${token}/upload`, multipartBody, {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Cookie': clientCookies
  });
  assert.strictEqual(uploadRes.statusCode, 302, 'Upload must redirect to /order/:token?uploaded=1');
  console.log('✔ Payment proof uploaded successfully on fresh container without "Pesanan Tidak Ditemukan"!');

  // Clean up
  db.prepare('DELETE FROM payment_submissions WHERE order_id = (SELECT id FROM orders WHERE access_token = ?)').run(token);
  db.prepare('DELETE FROM order_status_history WHERE order_id = (SELECT id FROM orders WHERE access_token = ?)').run(token);
  db.prepare('DELETE FROM order_items WHERE order_id = (SELECT id FROM orders WHERE access_token = ?)').run(token);
  db.prepare('DELETE FROM orders WHERE access_token = ?').run(token);

  console.log('\n=============================================================');
  console.log('ALL SERVERLESS RESILIENCE TESTS PASSED 100%! 🎉');
  console.log('=============================================================');
}

testResilience().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});
