process.env.NODE_ENV = 'test';
const assert = require('assert');
const http = require('http');
const app = require('../server');

// Run tests using http.request against running server
const PORT = 3001;
let server;

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: PORT,
      path: path,
      method: method,
      headers: {
        ...headers
      }
    };

    let postData = null;
    if (body) {
      if (typeof body === 'object') {
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

async function runE2E() {
  console.log('=== RUNNING END-TO-END HTTP INTEGRATION TESTS ===\n');

  server = app.listen(PORT, async () => {
    try {
      // 1. Homepage
      console.log('1. Testing GET / (Homepage)');
      const homeRes = await request('GET', '/');
      assert.strictEqual(homeRes.statusCode, 200);
      assert(homeRes.body.includes('GOOD FOOD.'), 'Must contain hero title');
      assert(homeRes.body.includes('BEST SELLER'), 'Must contain best seller');
      console.log('✔ Homepage rendered successfully.');

      // 2. Menu
      console.log('\n2. Testing GET /menu');
      const menuRes = await request('GET', '/menu');
      assert.strictEqual(menuRes.statusCode, 200);
      assert(menuRes.body.includes('Beefy Nacho'), 'Must contain Beefy Nacho');
      assert(menuRes.body.includes('Cheezy Corn'), 'Must contain Cheezy Corn');
      console.log('✔ Menu page rendered successfully.');

      // 3. Product detail
      console.log('\n3. Testing GET /product/beefy-nacho');
      const prodRes = await request('GET', '/product/beefy-nacho');
      assert.strictEqual(prodRes.statusCode, 200);
      assert(prodRes.body.includes('Beefy Nacho'), 'Must show product name');
      console.log('✔ Product detail rendered successfully.');

      // 4. Bundle detail
      console.log('\n4. Testing GET /bundle/movie-night-combo');
      const bundleRes = await request('GET', '/bundle/movie-night-combo');
      assert.strictEqual(bundleRes.statusCode, 200);
      assert(bundleRes.body.includes('Isi Paket yang Didapat'), 'Must show components list');
      console.log('✔ Bundle detail rendered successfully.');

      // 5. Promo redirect to Bundling
      console.log('\n5. Testing GET /promo redirect to /menu#bundling');
      const promoRes = await request('GET', '/promo');
      assert.strictEqual(promoRes.statusCode, 302);
      assert.strictEqual(promoRes.headers.location, '/menu#bundling');
      console.log('✔ Promo redirect to Bundling verified.');

      // 6. About page
      console.log('\n6. Testing GET /about');
      const aboutRes = await request('GET', '/about');
      assert.strictEqual(aboutRes.statusCode, 200);
      assert(aboutRes.body.includes('Inovasi Kemasan Cone'), 'Must show cone packaging info');
      console.log('✔ About page rendered successfully.');

      // 7. Checkout Page
      console.log('\n7. Testing GET /checkout');
      const checkoutRes = await request('GET', '/checkout');
      assert.strictEqual(checkoutRes.statusCode, 200);
      assert(checkoutRes.body.includes('Diluar Telkom - Rp2.000'), 'Checkout must show Diluar Telkom - Rp2.000 in delivery zones');
      console.log('✔ Checkout page rendered successfully with Diluar Telkom - Rp2.000.');

      // 8. API Cart Validate
      console.log('\n8. Testing POST /api/cart/validate');
      const cartValRes = await request('POST', '/api/cart/validate', {
        items: [
          { type: 'product', id: 1, quantity: 2 } // 2x Beefy Nacho = 50.000
        ],
        promoCode: 'NACHO10',
        method: 'delivery'
      });
      assert.strictEqual(cartValRes.statusCode, 200);
      const cartVal = JSON.parse(cartValRes.body);
      assert.strictEqual(cartVal.success, true);
      assert.strictEqual(cartVal.data.subtotal, 50000);
      assert.strictEqual(cartVal.data.discount, 5000);
      assert.strictEqual(cartVal.data.deliveryFee, 2000);
      assert.strictEqual(cartVal.data.total, 47000); // 50000 - 5000 + 2000
      console.log('✔ Cart API calculation verified.');

      // 9. Real Checkout POST
      console.log('\n9. Testing POST /checkout (Real Order Creation)');
      const orderPostRes = await request('POST', '/checkout', {
        customer_name: 'Budi Santoso',
        customer_phone: '081234567890',
        method: 'delivery',
        address: 'Jl. Merdeka No. 45, RT 01 / RW 02',
        delivery_zone_id: 1,
        notes: 'Minta saus dipisah',
        promo_code: 'NACHO10',
        idempotency_key: 'test_order_key_002',
        items: [
          { type: 'product', id: 1, quantity: 2 }
        ]
      });
      assert.strictEqual(orderPostRes.statusCode, 200);
      const orderPost = JSON.parse(orderPostRes.body);
      assert(orderPost.success, 'Order creation must succeed');
      assert(orderPost.token, 'Must return order token');
      const token = orderPost.token;
      console.log(`✔ Order created: ${orderPost.orderNumber} (Token: ${token.slice(0, 16)}...)`);

      // 10. Order Tracking Page
      console.log('\n10. Testing GET /order/:token');
      const orderGetRes = await request('GET', `/order/${token}`);
      assert.strictEqual(orderGetRes.statusCode, 200);
      assert(orderGetRes.body.includes('ID1026642568079'), 'Must contain QRIS NMID');
      assert(orderGetRes.body.includes('Budi Santoso'), 'Must contain customer name');
      console.log('✔ Order tracking & QRIS page rendered successfully.');

      // 11. API Order Status Polling
      console.log('\n11. Testing GET /api/order/:token/status');
      const pollRes = await request('GET', `/api/order/${token}/status`);
      assert.strictEqual(pollRes.statusCode, 200);
      const pollData = JSON.parse(pollRes.body);
      assert.strictEqual(pollData.success, true);
      assert.strictEqual(pollData.order_status, 'NEW');
      assert.strictEqual(pollData.payment_status, 'UNPAID');
      console.log('✔ Order polling API verified.');

      // 12. Admin Login & Authentication
      console.log('\n12. Testing Admin Login Flow');
      // Login POST
      const loginRes = await request('POST', '/admin/login', 
        'username=admin&password=nachoan2026',
        { 'Content-Type': 'application/x-www-form-urlencoded' }
      );
      assert.strictEqual(loginRes.statusCode, 302, 'Login should redirect to /admin on success');
      const sessionCookie = loginRes.headers['set-cookie'][0].split(';')[0];
      console.log('✔ Admin logged in successfully with session cookie.');

      // 13. Admin Dashboard (Authenticated)
      console.log('\n13. Testing GET /admin (Dashboard)');
      const dashRes = await request('GET', '/admin', null, { 'Cookie': sessionCookie });
      assert.strictEqual(dashRes.statusCode, 200);
      assert(dashRes.body.includes('Dashboard Toko'), 'Must contain Dashboard title');
      assert(dashRes.body.includes('Pendapatan Terverifikasi'), 'Must contain verified revenue metric');
      console.log('✔ Admin dashboard rendered successfully.');

      // 14. Admin Orders List
      console.log('\n14. Testing GET /admin/orders');
      const admOrdersRes = await request('GET', '/admin/orders', null, { 'Cookie': sessionCookie });
      assert.strictEqual(admOrdersRes.statusCode, 200);
      assert(admOrdersRes.body.includes('Budi Santoso'), 'Must list newly created order');
      console.log('✔ Admin orders list rendered successfully.');

      // 15. Admin Products List
      console.log('\n15. Testing GET /admin/products');
      const admProdsRes = await request('GET', '/admin/products', null, { 'Cookie': sessionCookie });
      assert.strictEqual(admProdsRes.statusCode, 200);
      console.log('✔ Admin products page rendered successfully.');

      // 16. Admin Bundles List
      console.log('\n16. Testing GET /admin/bundles');
      const admBundlesRes = await request('GET', '/admin/bundles', null, { 'Cookie': sessionCookie });
      assert.strictEqual(admBundlesRes.statusCode, 200);
      console.log('✔ Admin bundles page rendered successfully.');

      // 17. Admin Promos List
      console.log('\n17. Testing GET /admin/promos');
      const admPromosRes = await request('GET', '/admin/promos', null, { 'Cookie': sessionCookie });
      assert.strictEqual(admPromosRes.statusCode, 200);
      console.log('✔ Admin promos page rendered successfully.');

      // 18. Admin Settings & QRIS
      console.log('\n18. Testing GET /admin/settings');
      const admSettingsRes = await request('GET', '/admin/settings', null, { 'Cookie': sessionCookie });
      assert.strictEqual(admSettingsRes.statusCode, 200);
      assert(admSettingsRes.body.includes('ID1026642568079'), 'Must contain QRIS info');
      console.log('✔ Admin settings page rendered successfully.');

      console.log('\n======================================================');
      console.log('ALL 18 END-TO-END INTEGRATION TESTS PASSED CLEANLY! 🎉');
      console.log('======================================================\n');

      server.close();
      process.exit(0);
    } catch (err) {
      console.error('E2E TEST FAILURE:', err);
      if (server) server.close();
      process.exit(1);
    }
  });
}

runE2E();
