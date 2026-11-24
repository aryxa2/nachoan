const http = require('http');
const assert = require('assert');
const fs = require('fs');

function request(url, options = {}, postData = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: data
      }));
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

const BASE = 'http://localhost:3000';
const qcReport = {
  productsCRUD: [],
  bundlesCRUD: [],
  promosCRUD: [],
  customerFlow: [],
  adminFlow: [],
  allPassed: true
};

function logQC(section, testName, passed, details = '') {
  qcReport[section].push({ testName, passed, details });
  if (!passed) qcReport.allPassed = false;
  const icon = passed ? '✔' : '❌';
  console.log(`  ${icon} [${section.toUpperCase()}] ${testName}: ${passed ? 'PASSED' : 'FAILED'}${details ? ' - ' + details : ''}`);
}

(async () => {
  console.log('===============================================================');
  console.log('   NACHOAN QUALITY CONTROL: FULL CRUD & TWO-ROLE SIMULATION    ');
  console.log('===============================================================\n');

  // --- DB Cleanup of previous QC artifacts ---
  try {
    const getDb = require('../lib/db');
    const db = getDb();
    db.prepare("DELETE FROM bundle_items WHERE bundle_id IN (SELECT id FROM bundles WHERE name LIKE 'QC %' OR slug LIKE 'qc-%')").run();
    db.prepare("DELETE FROM bundles WHERE name LIKE 'QC %' OR slug LIKE 'qc-%'").run();
    db.prepare("DELETE FROM order_items WHERE product_id IN (SELECT id FROM products WHERE name LIKE 'QC %' OR slug LIKE 'qc-%')").run();
    db.prepare("DELETE FROM products WHERE name LIKE 'QC %' OR slug LIKE 'qc-%'").run();
    db.prepare("DELETE FROM promotions WHERE code LIKE 'QCSPECIAL%'").run();
  } catch (e) {
    console.error('Cleanup error:', e);
  }

  // --- Admin Login Setup ---
  let adminCookies = '';
  try {
    const loginBody = 'username=admin&password=nachoan2026';
    const res = await request(BASE + '/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(loginBody) }
    }, loginBody);
    adminCookies = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  } catch (err) {
    console.error('Admin login error:', err);
  }

  // =========================================================
  // 1. QC PRODUCT CRUD (TAMBAH, BACA, UPDATE, HAPUS)
  // =========================================================
  console.log('--- 1. Testing Product Full CRUD ---');
  let prodId = null;

  // 1.1 Create Product
  try {
    const boundary = '----WebKitFormBoundaryQCProductCRUD';
    const body = 
      `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nQC Nacho Deluxe\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="category_id"\r\n\r\n1\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="price"\r\n\r\n22000\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="description"\r\n\r\nDelicious Nacho for QC test\r\n` +
      `--${boundary}--\r\n`;

    const res = await request(BASE + '/admin/products/new', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': Buffer.byteLength(body), 'Cookie': adminCookies }
    }, body);

    const getDb = require('../lib/db');
    const db = getDb();
    const pRow = db.prepare('SELECT id FROM products WHERE name = ? ORDER BY id DESC LIMIT 1').get('QC Nacho Deluxe');
    if (pRow) prodId = pRow.id;

    logQC('productsCRUD', 'CREATE Product (POST /admin/products/new)', res.statusCode === 302 && Boolean(prodId), `Created ID: ${prodId}`);
  } catch (err) {
    logQC('productsCRUD', 'CREATE Product', false, err.message);
  }

  // 1.2 Read Product on Customer Menu & Detail
  try {
    const menuRes = await request(BASE + '/menu');
    const hasInMenu = menuRes.body.includes('QC Nacho Deluxe') && menuRes.body.includes('22.000');
    const detailRes = await request(BASE + '/product/qc-nacho-deluxe');
    const hasDetail = detailRes.statusCode === 200 && detailRes.body.includes('QC Nacho Deluxe');
    logQC('productsCRUD', 'READ Product on Customer Menu & Detail', hasInMenu && hasDetail, 'Visible in /menu and /product/:slug');
  } catch (err) {
    logQC('productsCRUD', 'READ Product', false, err.message);
  }

  // 1.3 Update Product
  try {
    const boundary = '----WebKitFormBoundaryQCProductEdit';
    const body = 
      `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nQC Nacho Super Deluxe\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="category_id"\r\n\r\n1\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="price"\r\n\r\n25000\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="description"\r\n\r\nUpdated description\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="available"\r\n\r\n1\r\n` +
      `--${boundary}--\r\n`;

    const res = await request(BASE + `/admin/products/${prodId}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': Buffer.byteLength(body), 'Cookie': adminCookies }
    }, body);

    const checkRes = await request(BASE + '/menu');
    const updated = checkRes.body.includes('QC Nacho Super Deluxe') && checkRes.body.includes('25.000');
    logQC('productsCRUD', 'UPDATE Product (POST /admin/products/:id/edit)', res.statusCode === 302 && updated, 'Updated to Rp25.000');
  } catch (err) {
    logQC('productsCRUD', 'UPDATE Product', false, err.message);
  }

  // 1.4 Toggle Availability
  try {
    const res = await request(BASE + `/admin/products/${prodId}/toggle`, {
      method: 'POST',
      headers: { 'Cookie': adminCookies }
    });
    // Check in DB
    const getDb = require('../lib/db');
    const db = getDb();
    const prod = db.prepare('SELECT available FROM products WHERE id = ?').get(prodId);
    logQC('productsCRUD', 'TOGGLE Product Availability (POST /admin/products/:id/toggle)', res.statusCode === 302 && prod.available === 0, 'Status switched to Habis (available = 0)');
  } catch (err) {
    logQC('productsCRUD', 'TOGGLE Product', false, err.message);
  }

  // 1.5 Delete Product (Archive)
  try {
    const getDb = require('../lib/db');
    const db = getDb();
    const prodBefore = db.prepare('SELECT slug FROM products WHERE id = ?').get(prodId);
    const prodSlug = prodBefore ? prodBefore.slug : 'qc-nacho-deluxe';

    const res = await request(BASE + `/admin/products/${prodId}/delete`, {
      method: 'POST',
      headers: { 'Cookie': adminCookies }
    });
    // Verify it is archived in DB and completely gone from customer menu and detail
    const prod = db.prepare('SELECT archived FROM products WHERE id = ?').get(prodId);
    const menuRes = await request(BASE + '/menu');
    const goneFromMenu = !menuRes.body.includes('QC Nacho Super Deluxe');
    const detailRes = await request(BASE + `/product/${prodSlug}`);
    const goneFromDetail = detailRes.statusCode === 404;

    logQC('productsCRUD', 'DELETE Product (POST /admin/products/:id/delete)', res.statusCode === 302 && prod.archived === 1 && goneFromMenu && goneFromDetail, 'Archived = 1, hidden from /menu & 404 on detail');
  } catch (err) {
    logQC('productsCRUD', 'DELETE Product', false, err.message);
  }

  // =========================================================
  // 2. QC BUNDLES CRUD (TAMBAH, BACA, UPDATE, HAPUS)
  // =========================================================
  console.log('\n--- 2. Testing Bundles Full CRUD ---');
  let bundleId = null;

  // 2.1 Create Bundle
  try {
    const boundary = '----WebKitFormBoundaryQCBundle';
    const body = 
      `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nQC Party Box Combo\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="description"\r\n\r\nBundle created for QC\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="price"\r\n\r\n27000\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="compare_price"\r\n\r\n30000\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="product_ids"\r\n\r\n1\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="quantities"\r\n\r\n2\r\n` +
      `--${boundary}--\r\n`;

    const res = await request(BASE + '/admin/bundles/new', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': Buffer.byteLength(body), 'Cookie': adminCookies }
    }, body);

    const getDb = require('../lib/db');
    const db = getDb();
    const bRow = db.prepare('SELECT id FROM bundles WHERE name = ? ORDER BY id DESC LIMIT 1').get('QC Party Box Combo');
    if (bRow) bundleId = bRow.id;

    logQC('bundlesCRUD', 'CREATE Bundle (POST /admin/bundles/new)', res.statusCode === 302 && Boolean(bundleId), `Created ID: ${bundleId}`);
  } catch (err) {
    logQC('bundlesCRUD', 'CREATE Bundle', false, err.message);
  }

  // 2.2 Read Bundle on Customer Menu & Detail
  try {
    const menuRes = await request(BASE + '/menu');
    const hasInMenu = menuRes.body.includes('QC Party Box Combo') && menuRes.body.includes('27.000');
    const detailRes = await request(BASE + '/bundle/qc-party-box-combo');
    const hasDetail = detailRes.statusCode === 200 && detailRes.body.includes('QC Party Box Combo');
    logQC('bundlesCRUD', 'READ Bundle on Customer Menu & Detail', hasInMenu && hasDetail, 'Visible in /menu#bundling and /bundle/:slug');
  } catch (err) {
    logQC('bundlesCRUD', 'READ Bundle', false, err.message);
  }

  // 2.3 Update Bundle
  try {
    const boundary = '----WebKitFormBoundaryQCBundleEdit';
    const body = 
      `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nQC Ultimate Party Box\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="description"\r\n\r\nUpdated bundle description\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="price"\r\n\r\n29000\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="compare_price"\r\n\r\n35000\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="available"\r\n\r\n1\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="product_ids"\r\n\r\n1\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="quantities"\r\n\r\n2\r\n` +
      `--${boundary}--\r\n`;

    const res = await request(BASE + `/admin/bundles/${bundleId}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': Buffer.byteLength(body), 'Cookie': adminCookies }
    }, body);

    const checkRes = await request(BASE + '/menu');
    const updated = checkRes.body.includes('QC Ultimate Party Box') && checkRes.body.includes('29.000');
    logQC('bundlesCRUD', 'UPDATE Bundle (POST /admin/bundles/:id/edit)', res.statusCode === 302 && updated, 'Updated to Rp29.000');
  } catch (err) {
    logQC('bundlesCRUD', 'UPDATE Bundle', false, err.message);
  }

  // 2.4 Toggle Bundle Availability
  try {
    const res = await request(BASE + `/admin/bundles/${bundleId}/toggle`, {
      method: 'POST',
      headers: { 'Cookie': adminCookies }
    });
    const getDb = require('../lib/db');
    const db = getDb();
    const b = db.prepare('SELECT available FROM bundles WHERE id = ?').get(bundleId);
    logQC('bundlesCRUD', 'TOGGLE Bundle Availability (POST /admin/bundles/:id/toggle)', res.statusCode === 302 && b.available === 0, 'Status switched to Nonaktif');
  } catch (err) {
    logQC('bundlesCRUD', 'TOGGLE Bundle', false, err.message);
  }

  // 2.5 Delete Bundle (NEW CRUD FEATURE)
  try {
    const getDb = require('../lib/db');
    const db = getDb();
    const bundleBefore = db.prepare('SELECT slug FROM bundles WHERE id = ?').get(bundleId);
    const bundleSlug = bundleBefore ? bundleBefore.slug : 'qc-party-box-combo';

    const res = await request(BASE + `/admin/bundles/${bundleId}/delete`, {
      method: 'POST',
      headers: { 'Cookie': adminCookies }
    });

    const b = db.prepare('SELECT archived FROM bundles WHERE id = ?').get(bundleId);
    const menuRes = await request(BASE + '/menu');
    const goneFromMenu = !menuRes.body.includes('QC Ultimate Party Box');
    const detailRes = await request(BASE + `/bundle/${bundleSlug}`);
    const goneFromDetail = detailRes.statusCode === 404;

    logQC('bundlesCRUD', 'DELETE Bundle (POST /admin/bundles/:id/delete)', res.statusCode === 302 && b.archived === 1 && goneFromMenu && goneFromDetail, 'Archived = 1, removed from /menu & 404 on detail');
  } catch (err) {
    logQC('bundlesCRUD', 'DELETE Bundle', false, err.message);
  }

  // =========================================================
  // 3. QC PROMOS CRUD (TAMBAH, BACA, UPDATE, HAPUS)
  // =========================================================
  console.log('\n--- 3. Testing Promos Full CRUD ---');
  let promoId = null;

  // 3.1 Create Promo
  try {
    const postPayload = new URLSearchParams({
      code: 'QCSPECIAL20',
      type: 'percentage',
      value: '20',
      min_purchase: '20000',
      description: 'QC 20% discount voucher'
    }).toString();

    const res = await request(BASE + '/admin/promos/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postPayload), 'Cookie': adminCookies }
    }, postPayload);

    const getDb = require('../lib/db');
    const db = getDb();
    const pRow = db.prepare('SELECT id FROM promotions WHERE code = ? ORDER BY id DESC LIMIT 1').get('QCSPECIAL20');
    if (pRow) promoId = pRow.id;

    logQC('promosCRUD', 'CREATE Promo Voucher (POST /admin/promos/new)', res.statusCode === 302 && Boolean(promoId), `Created code QCSPECIAL20, ID: ${promoId}`);
  } catch (err) {
    logQC('promosCRUD', 'CREATE Promo', false, err.message);
  }

  // 3.2 Read Promo & Test Validation on Cart
  try {
    const cartPayload = JSON.stringify({
      items: [{ id: 1, quantity: 2 }], // 30.000
      promoCode: 'QCSPECIAL20',
      method: 'pickup'
    });
    const res = await request(BASE + '/api/cart/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(cartPayload) }
    }, cartPayload);

    const data = JSON.parse(res.body);
    const valid = data.data.promo && data.data.promo.valid;
    const discount20 = data.data.discount === 6000; // 20% of 30.000 = 6.000
    logQC('promosCRUD', 'READ Promo & Validate on Cart (/api/cart/validate)', res.statusCode === 200 && valid && discount20, '20% discount (Rp6.000) applied');
  } catch (err) {
    logQC('promosCRUD', 'READ Promo', false, err.message);
  }

  // 3.3 Update Promo
  try {
    const editPayload = new URLSearchParams({
      code: 'QCSPECIAL30',
      type: 'percentage',
      value: '30',
      min_purchase: '25000',
      description: 'Updated QC 30% discount voucher',
      active: '1'
    }).toString();

    const res = await request(BASE + `/admin/promos/${promoId}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(editPayload), 'Cookie': adminCookies }
    }, editPayload);

    // Validate updated code on cart
    const cartPayload = JSON.stringify({
      items: [{ id: 1, quantity: 2 }], // 30.000
      promoCode: 'QCSPECIAL30',
      method: 'pickup'
    });
    const cartRes = await request(BASE + '/api/cart/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(cartPayload) }
    }, cartPayload);

    const data = JSON.parse(cartRes.body);
    const discount30 = data.data.discount === 9000; // 30% of 30.000 = 9.000
    logQC('promosCRUD', 'UPDATE Promo (POST /admin/promos/:id/edit)', res.statusCode === 302 && discount30, 'Updated code to QCSPECIAL30 (30% = Rp9.000)');
  } catch (err) {
    logQC('promosCRUD', 'UPDATE Promo', false, err.message);
  }

  // 3.4 Toggle Promo Active
  try {
    const res = await request(BASE + `/admin/promos/${promoId}/toggle`, {
      method: 'POST',
      headers: { 'Cookie': adminCookies }
    });
    const getDb = require('../lib/db');
    const db = getDb();
    const p = db.prepare('SELECT active FROM promotions WHERE id = ?').get(promoId);
    logQC('promosCRUD', 'TOGGLE Promo Active (POST /admin/promos/:id/toggle)', res.statusCode === 302 && p.active === 0, 'Status switched to Nonaktif');
  } catch (err) {
    logQC('promosCRUD', 'TOGGLE Promo', false, err.message);
  }

  // 3.5 Delete Promo (NEW CRUD FEATURE)
  try {
    const res = await request(BASE + `/admin/promos/${promoId}/delete`, {
      method: 'POST',
      headers: { 'Cookie': adminCookies }
    });

    const getDb = require('../lib/db');
    const db = getDb();
    const p = db.prepare('SELECT * FROM promotions WHERE id = ?').get(promoId);

    // Verify it fails on cart validation now
    const cartPayload = JSON.stringify({
      items: [{ id: 1, quantity: 2 }],
      promoCode: 'QCSPECIAL30',
      method: 'pickup'
    });
    const cartRes = await request(BASE + '/api/cart/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(cartPayload) }
    }, cartPayload);
    const data = JSON.parse(cartRes.body);
    const noLongerValid = !data.data.promo || !data.data.promo.valid;

    logQC('promosCRUD', 'DELETE Promo (POST /admin/promos/:id/delete)', res.statusCode === 302 && !p && noLongerValid, 'Permanently deleted, rejected on cart validation');
  } catch (err) {
    logQC('promosCRUD', 'DELETE Promo', false, err.message);
  }

  // =========================================================
  // 4. QC CUSTOMER END-TO-END FLOW
  // =========================================================
  console.log('\n--- 4. Testing Customer End-to-End Simulation ---');
  let customerOrderToken = null;
  let customerCookies = '';

  // 4.1 Checkout
  try {
    const checkoutBody = new URLSearchParams({
      customer_name: 'Dewi Sartika (QC User)',
      customer_phone: '081234567899',
      method: 'delivery',
      address: 'Kos Putri Telkom University Blok A No. 12',
      delivery_zone_id: '1',
      items: JSON.stringify([{ id: 1, quantity: 1, variant: 'Pedas Normal' }]),
      notes: 'Tolong jangan pakai saus mayo'
    }).toString();

    const res = await request(BASE + '/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(checkoutBody) }
    }, checkoutBody);

    const data = JSON.parse(res.body);
    customerOrderToken = data.token;
    customerCookies = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    logQC('customerFlow', 'Customer Order Creation & Token Generation', res.statusCode === 200 && data.success, `Order: ${data.orderNumber}`);
  } catch (err) {
    logQC('customerFlow', 'Customer Order Creation', false, err.message);
  }

  // 4.2 Tracking & Payment Proof Upload
  try {
    const receiptRes = await request(BASE + '/order/' + customerOrderToken, { headers: { 'Cookie': customerCookies } });
    const receiptOk = receiptRes.statusCode === 200 && receiptRes.body.includes('Dewi Sartika');

    const boundary = '----WebKitFormBoundaryQCDewi';
    const fakeImage = 'BUKTI_TRANSFER_DEWI_QC';
    const uploadBody = 
      `--${boundary}\r\nContent-Disposition: form-data; name="payment_proof"; filename="struk_dewi.jpg"\r\nContent-Type: image/jpeg\r\n\r\n${fakeImage}\r\n--${boundary}--\r\n`;

    const upRes = await request(BASE + `/order/${customerOrderToken}/upload`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': Buffer.byteLength(uploadBody), 'Cookie': customerCookies }
    }, uploadBody);

    const pollingRes = await request(BASE + `/api/order/${customerOrderToken}/status`);
    const statusData = JSON.parse(pollingRes.body);
    const uploadOk = upRes.statusCode === 302 && statusData.order_status === 'WAITING_CONFIRMATION';

    logQC('customerFlow', 'Receipt Access & Payment Proof Upload', receiptOk && uploadOk, 'Status transitioned to WAITING_CONFIRMATION');
  } catch (err) {
    logQC('customerFlow', 'Receipt Access & Payment Upload', false, err.message);
  }

  // =========================================================
  // 5. QC ADMIN END-TO-END FLOW
  // =========================================================
  console.log('\n--- 5. Testing Admin End-to-End Simulation ---');

  // 5.1 Admin Order Verification & Status Progression
  try {
    const getDb = require('../lib/db');
    const db = getDb();
    const orderRow = db.prepare('SELECT id FROM orders WHERE access_token = ?').get(customerOrderToken);
    const orderId = orderRow.id;

    // Verify payment (Accept)
    const acceptBody = 'action=accept';
    const approveRes = await request(BASE + `/admin/orders/${orderId}/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(acceptBody), 'Cookie': adminCookies }
    }, acceptBody);

    // Update operational status to COMPLETED
    const compBody = 'order_status=COMPLETED';
    const compRes = await request(BASE + `/admin/orders/${orderId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(compBody), 'Cookie': adminCookies }
    }, compBody);

    // Verify customer sees COMPLETED and PAID
    const customerCheck = await request(BASE + `/api/order/${customerOrderToken}/status`);
    const finalData = JSON.parse(customerCheck.body);
    const flowComplete = finalData.payment_status === 'PAID' && finalData.order_status === 'COMPLETED';

    logQC('adminFlow', 'Admin Payment Verification & Status Progression to COMPLETED', approveRes.statusCode === 302 && compRes.statusCode === 302 && flowComplete, 'Customer live status: PAID & COMPLETED');
  } catch (err) {
    logQC('adminFlow', 'Admin Order Workflow', false, err.message);
  }

  console.log('\n===============================================================');
  console.log('   FULL QC TEST RESULT: ' + (qcReport.allPassed ? 'ALL SCENARIOS PASSED 100%! 🎉' : 'FAILURES DETECTED!'));
  console.log('===============================================================');

  fs.writeFileSync('tests/qc-full-report.json', JSON.stringify(qcReport, null, 2));
})();
