/**
 * Test Order Full CRUD + Customer Checkout + Admin Delete Flow
 * Run with: node tests/test-order-full-crud-and-delete.js
 */

const http = require('http');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const app = require('../server');
const getDb = require('../lib/db');

function request(server, options, postData = null) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const opts = {
      hostname: '127.0.0.1',
      port: addr.port,
      path: options.path,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: data,
        location: res.headers.location
      }));
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function parseCookie(res) {
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) return '';
  return (Array.isArray(setCookie) ? setCookie : [setCookie])
    .map(c => c.split(';')[0])
    .join('; ');
}

async function runTest() {
  console.log('===============================================================');
  console.log('  TESTING SKEMA PEMESANAN MAKANAN & CRUD PESANAN ADMIN (DELETE) ');
  console.log('===============================================================\n');

  // Start server on ephemeral port
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  console.log(`[INFO] Server running on test port ${port}`);

  const db = getDb();
  const sheets = require('../lib/sheets');
  sheets.setMockAppsScriptHandler((method, payload) => {
    return { success: true, deleted: payload.order_numbers || [] };
  });

  let createdOrderId = null;
  let createdOrderToken = null;
  let createdOrderNumber = null;
  let adminCookies = '';

  try {
    // -------------------------------------------------------------
    // TAHAP 1: Customer Melakukan Pemesanan (Checkout Makanan)
    // -------------------------------------------------------------
    console.log('\n--- 1. Customer: Checkout Pesanan Makanan ---');
    
    // Cari produk aktif
    const activeProduct = db.prepare('SELECT * FROM products WHERE available = 1 AND archived = 0 LIMIT 1').get();
    assert(activeProduct, 'Harus ada minimal 1 produk aktif di database');
    console.log(`[INFO] Produk yang dipesan: ${activeProduct.name} (Rp${activeProduct.price})`);

    const checkoutPayload = new URLSearchParams({
      customer_name: 'Budi Santoso (QC Test)',
      customer_phone: '081298765432',
      customer_email: 'budi.qc@example.com',
      method: 'delivery',
      address: 'Jl. Merdeka No. 45, Coblong, Bandung',
      delivery_zone_id: '1',
      items: JSON.stringify([
        { id: activeProduct.id, quantity: 2, variant: 'Pedas Sedang' }
      ]),
      notes: 'Ekstra renyah ya, tolong sambal dipisah.'
    }).toString();

    const checkoutRes = await request(server, {
      path: '/checkout',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(checkoutPayload)
      }
    }, checkoutPayload);

    console.log(`[CHECKOUT] Status Code: ${checkoutRes.statusCode}`);
    assert.strictEqual(checkoutRes.statusCode, 200, 'Checkout harus mengembalikan 200 JSON');

    const checkoutData = JSON.parse(checkoutRes.body);
    assert.strictEqual(checkoutData.success, true, 'Checkout response harus success: true');
    createdOrderToken = checkoutData.token;
    createdOrderNumber = checkoutData.orderNumber;

    // Verifikasi data di SQLite DB dan ambil ID
    const dbOrder = db.prepare('SELECT * FROM orders WHERE access_token = ?').get(createdOrderToken);
    assert(dbOrder, 'Pesanan harus tersimpan di tabel orders');
    createdOrderId = dbOrder.id;
    console.log(`✔ [BERHASIL] Order Terbuat: ID #${createdOrderId}, Nomor: ${createdOrderNumber}, Token: ${createdOrderToken}`);
    assert.strictEqual(dbOrder.customer_name, 'Budi Santoso (QC Test)');
    assert.strictEqual(dbOrder.payment_status, 'UNPAID');
    assert.strictEqual(dbOrder.order_status, 'NEW');
    console.log(`✔ [DB VERIFIED] Order tersimpan di DB: Total Rp${dbOrder.total}, Status: ${dbOrder.payment_status}/${dbOrder.order_status}`);

    // -------------------------------------------------------------
    // TAHAP 2: Customer Mengakses Halaman Tracking Pesanan
    // -------------------------------------------------------------
    console.log('\n--- 2. Customer: Tracking & View Order Page ---');
    const orderPageRes = await request(server, {
      path: `/order/${createdOrderToken}`,
      method: 'GET'
    });

    assert.strictEqual(orderPageRes.statusCode, 200, 'Halaman tracking pesanan harus HTTP 200');
    assert(orderPageRes.body.includes(createdOrderNumber), 'Halaman harus menampilkan nomor pesanan');
    assert(orderPageRes.body.includes('Budi Santoso'), 'Halaman harus menampilkan nama customer');
    assert(orderPageRes.body.includes(activeProduct.name), 'Halaman harus menampilkan nama produk yang dipesan');
    console.log('✔ [BERHASIL] Customer dapat melihat rincian pesanan dan petunjuk QRIS.');

    // -------------------------------------------------------------
    // TAHAP 3: Customer Mengunggah Bukti Pembayaran QRIS
    // -------------------------------------------------------------
    console.log('\n--- 3. Customer: Upload Bukti Pembayaran ---');
    const boundary = '----WebKitFormBoundaryQCTestProof';
    const dummyImageContent = 'DUMMY_IMAGE_BINARY_CONTENT_FOR_QC_TEST';
    const uploadBody = 
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="payment_proof"; filename="struk_qris_budi.png"\r\n` +
      `Content-Type: image/png\r\n\r\n` +
      `${dummyImageContent}\r\n` +
      `--${boundary}--\r\n`;

    const uploadRes = await request(server, {
      path: `/order/${createdOrderToken}/upload`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': Buffer.byteLength(uploadBody)
      }
    }, uploadBody);

    assert.strictEqual(uploadRes.statusCode, 302, 'Upload harus redirect 302 kembali ke halaman order');
    
    // Cek status polling API
    const statusApiRes = await request(server, {
      path: `/api/order/${createdOrderToken}/status`,
      method: 'GET'
    });
    const statusJson = JSON.parse(statusApiRes.body);
    assert.strictEqual(statusJson.order_status, 'WAITING_CONFIRMATION', 'Status order harus WAITING_CONFIRMATION');
    console.log(`✔ [BERHASIL] Bukti pembayaran terupload. Status order beralih ke: ${statusJson.order_status}`);

    // -------------------------------------------------------------
    // TAHAP 4: Admin Login
    // -------------------------------------------------------------
    console.log('\n--- 4. Admin: Login ke Panel Admin ---');
    const loginPayload = 'username=admin&password=nachoan2026';
    const loginRes = await request(server, {
      path: '/admin/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(loginPayload)
      }
    }, loginPayload);

    assert.strictEqual(loginRes.statusCode, 302, 'Login harus redirect 302');
    adminCookies = parseCookie(loginRes);
    assert(adminCookies, 'Cookie sesi admin harus diterima');
    console.log('✔ [BERHASIL] Admin berhasil login dengan kredensial admin/nachoan2026');

    // -------------------------------------------------------------
    // TAHAP 5: Admin Memeriksa Daftar Pesanan & Detail Pesanan
    // -------------------------------------------------------------
    console.log('\n--- 5. Admin: Read Pesanan di Admin Dashboard ---');
    const ordersListRes = await request(server, {
      path: '/admin/orders',
      method: 'GET',
      headers: { 'Cookie': adminCookies }
    });
    assert.strictEqual(ordersListRes.statusCode, 200, 'Daftar pesanan harus HTTP 200');
    assert(ordersListRes.body.includes(createdOrderNumber), 'Nomor order harus tampil di tabel daftar pesanan');
    assert(ordersListRes.body.includes('Budi Santoso'), 'Nama pelanggan harus tampil di daftar pesanan');
    console.log(`✔ [BERHASIL] Pesanan #${createdOrderNumber} muncul di tabel admin.`);

    const orderDetailRes = await request(server, {
      path: `/admin/orders/${createdOrderId}`,
      method: 'GET',
      headers: { 'Cookie': adminCookies }
    });
    assert.strictEqual(orderDetailRes.statusCode, 200, 'Detail pesanan harus HTTP 200');
    assert(orderDetailRes.body.includes(createdOrderNumber), 'Detail harus memuat nomor order');
    assert(orderDetailRes.body.includes('action="/admin/orders/' + createdOrderNumber + '/delete"') || orderDetailRes.body.includes('action="/admin/orders/' + createdOrderId + '/delete"'), 'Tombol/Form Hapus Pesanan harus ada di halaman detail');
    console.log('✔ [BERHASIL] Halaman detail pesanan memuat rincian dan TOMBOL HAPUS PESANAN (DELETE).');

    // -------------------------------------------------------------
    // TAHAP 6: Admin Memverifikasi Pembayaran & Update Status (CRUD Update)
    // -------------------------------------------------------------
    console.log('\n--- 6. Admin: Update Status & Verifikasi Pembayaran ---');
    const verifyPayload = 'action=accept&reference=BCA-QC-778899';
    const verifyRes = await request(server, {
      path: `/admin/orders/${createdOrderId}/verify-payment`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(verifyPayload),
        'Cookie': adminCookies
      }
    }, verifyPayload);

    assert.strictEqual(verifyRes.statusCode, 302, 'Verifikasi pembayaran harus redirect');

    // Cek di DB apakah payment_status = PAID
    const verifiedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(createdOrderId);
    assert.strictEqual(verifiedOrder.payment_status, 'PAID', 'Payment status harus PAID');
    console.log(`✔ [UPDATE STATUS] Pembayaran diverifikasi: Payment Status = ${verifiedOrder.payment_status}`);

    // Admin update operasional status ke PREPARING
    const statusUpdatePayload = 'order_status=PREPARING&note=Sedang+digoreng+renyah';
    const statusUpdateRes = await request(server, {
      path: `/admin/orders/${createdOrderId}/status`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(statusUpdatePayload),
        'Cookie': adminCookies
      }
    }, statusUpdatePayload);
    assert.strictEqual(statusUpdateRes.statusCode, 302, 'Update status harus redirect');

    const preparingOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(createdOrderId);
    assert.strictEqual(preparingOrder.order_status, 'PREPARING');
    console.log(`✔ [UPDATE STATUS] Status operasional diubah: Order Status = ${preparingOrder.order_status}`);

    // -------------------------------------------------------------
    // TAHAP 7: Admin Menghapus Pesanan (CRUD Delete / Hard Delete)
    // -------------------------------------------------------------
    console.log('\n--- 7. Admin: Hapus Pesanan (Hard Delete) ---');
    const deleteRes = await request(server, {
      path: `/admin/orders/${createdOrderId}/delete`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': '0',
        'Cookie': adminCookies
      }
    });

    assert.strictEqual(deleteRes.statusCode, 302, 'Delete harus redirect 302 ke /admin/orders?msg=deleted');
    assert(deleteRes.location.includes('/admin/orders'), 'Redirect harus menuju /admin/orders');
    console.log(`✔ [DELETE ROUTE] POST /admin/orders/${createdOrderId}/delete berhasil dieksekusi (Redirect: ${deleteRes.location})`);

    // Verifikasi Database: Semua relasi dan order harus lenyap
    const orderAfterDelete = db.prepare('SELECT * FROM orders WHERE id = ?').get(createdOrderId);
    assert.strictEqual(orderAfterDelete, undefined, 'Order harus terhapus dari tabel orders');

    const itemsAfterDelete = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(createdOrderId);
    assert.strictEqual(itemsAfterDelete.length, 0, 'Item order harus terhapus dari order_items');

    const subsAfterDelete = db.prepare('SELECT * FROM payment_submissions WHERE order_id = ?').all(createdOrderId);
    assert.strictEqual(subsAfterDelete.length, 0, 'Submisi pembayaran harus terhapus dari payment_submissions');

    const historyAfterDelete = db.prepare('SELECT * FROM order_status_history WHERE order_id = ?').all(createdOrderId);
    assert.strictEqual(historyAfterDelete.length, 0, 'Riwayat status harus terhapus dari order_status_history');
    console.log('✔ [DB VERIFIED] Order dan seluruh relasinya (items, payment, history) telah terhapus PERMANEN dari database.');

    // Verifikasi Akses URL setelah dihapus
    const getDeletedAdmin = await request(server, {
      path: `/admin/orders/${createdOrderId}`,
      method: 'GET',
      headers: { 'Cookie': adminCookies }
    });
    assert.strictEqual(getDeletedAdmin.statusCode, 404, 'Detail order yang sudah dihapus harus 404');

    const getDeletedCustomer = await request(server, {
      path: `/order/${createdOrderToken}`,
      method: 'GET'
    });
    assert.strictEqual(getDeletedCustomer.statusCode, 404, 'Customer tracking URL order yang dihapus harus 404');
    console.log('✔ [ACCESS VERIFIED] Endpoint Admin & Customer untuk pesanan yang dihapus mengembalikan 404 Not Found.');

    console.log('\n===============================================================');
    console.log('  🎉 SEMUA PENGUJIAN SKEMA PESANAN & CRUD DELETE LULUS 100%! ');
    console.log('===============================================================');

  } finally {
    const sheets = require('../lib/sheets');
    sheets.setMockAppsScriptHandler(null);
    server.close();
  }
}

runTest().catch(err => {
  console.error('\n❌ TEST GAGAL DENGAN ERROR:', err);
  process.exit(1);
});
