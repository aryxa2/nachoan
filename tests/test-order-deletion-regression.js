/**
 * Comprehensive Regression Test: Order Deletion, Persistence, Anti-Resurrection,
 * WhatsApp Phone Validation, and Access Control.
 * 
 * Run with: node tests/test-order-deletion-regression.js
 */

const http = require('http');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const app = require('../server');
const getDb = require('../lib/db');
const sheets = require('../lib/sheets');
const helpers = require('../lib/helpers');

// Helper to make HTTP request to server
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

// In-Memory Simulated Google Apps Script / Google Sheets
class MockGoogleAppsScript {
  constructor() {
    this.ordersSheet = []; // Array of row objects
    this.orderItemsSheet = [];
    this.failureMode = null; // 'error', 'timeout', etc.
    this.secret = 'test-secret-12345';
  }

  reset() {
    this.ordersSheet = [];
    this.orderItemsSheet = [];
    this.failureMode = null;
  }

  handle(method, payload) {
    if (this.failureMode === 'error') {
      return { success: false, message: 'Google Apps Script internal execution error (Simulated 500).' };
    }
    if (this.failureMode === 'timeout') {
      return { success: false, message: 'The script completed but the returned value is not a valid JSON.' };
    }

    if (method === 'GET') {
      if (payload.action === 'getOrders') {
        // Return active and deleted rows from sheet as Apps Script does
        return { success: true, data: this.ordersSheet };
      }
      return { success: true, data: [] };
    }

    if (method === 'POST') {
      const action = payload.action;

      if (action === 'createOrder') {
        const o = payload.order;
        const items = payload.items || [];
        this.ordersSheet.push({
          'No Pesanan': o.order_number,
          'Waktu Pemesanan': o.created_at,
          'Nama Pelanggan': o.customer_name,
          'Nomor WhatsApp': o.customer_phone,
          'Metode': o.method,
          'Zona Pengiriman': o.method === 'delivery' ? 'Diluar Telkom' : '-',
          'Alamat Pengantaran': o.address || '-',
          'Ringkasan Menu': items.map(i => `${i.quantity}x ${i.name}`).join(', '),
          'Subtotal (Rp)': o.subtotal,
          'Ongkir (Rp)': o.delivery_fee || 0,
          'Total Pembayaran (Rp)': o.total,
          'Status Pembayaran': o.payment_status || 'UNPAID',
          'Status Pesanan': o.order_status || 'NEW',
          'Catatan Pemesan': o.notes || '-',
          'Terakhir Diperbarui': o.updated_at,
          'Token Akses': o.access_token || '',
          'Bukti Pembayaran': '-'
        });

        items.forEach(it => {
          this.orderItemsSheet.push({
            'No Pesanan': o.order_number,
            'Nama Menu': it.name,
            'Harga Satuan (Rp)': it.price,
            'Jumlah': it.quantity
          });
        });

        return { success: true, order_number: o.order_number };
      }

      if (action === 'deleteOrders' || action === 'deleteOrder') {
        // Verify secret if provided
        if (this.secret && payload.secret !== this.secret) {
          return { success: false, message: 'Unauthorized: Invalid secret.' };
        }

        const numbers = payload.order_numbers || [];
        const result = { success: true, deleted: [], notFound: [], failed: [] };

        for (const num of numbers) {
          const row = this.ordersSheet.find(r => r['No Pesanan'] === num);
          if (!row) {
            result.notFound.push(num);
            continue;
          }

          // Permanent deletion marker in Sheet
          row['Status Pembayaran'] = 'DELETED';
          row['Status Pesanan'] = 'DELETED';
          row['Terakhir Diperbarui'] = new Date().toISOString();

          // Remove items
          this.orderItemsSheet = this.orderItemsSheet.filter(it => it['No Pesanan'] !== num);
          result.deleted.push(num);
        }

        return result;
      }
    }

    return { success: false, message: 'Unknown action' };
  }
}

async function runRegressionTests() {
  console.log('======================================================================');
  console.log('  NACHOAN REGRESSION TEST: ORDER DELETION & VALIDATION SUITE          ');
  console.log('======================================================================\n');

  const mockAppsScript = new MockGoogleAppsScript();
  sheets.setMockAppsScriptHandler((method, payload) => mockAppsScript.handle(method, payload));
  process.env.APPS_SCRIPT_SECRET = mockAppsScript.secret;

  const db = getDb();
  const origScriptRow = db.prepare("SELECT value FROM store_settings WHERE key = 'apps_script_url'").get();
  const origScriptUrl = origScriptRow ? origScriptRow.value : null;

  // Set fake apps_script_url in store_settings to enable Apps Script sync pathways
  db.prepare("INSERT OR REPLACE INTO store_settings (key, value) VALUES ('apps_script_url', 'https://script.google.com/macros/s/SIMULATED_TEST/exec')").run();

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  console.log(`[INIT] Test server running on http://127.0.0.1:${port}`);

  let adminCookies = '';

  try {
    // =====================================================================
    // BAGIAN 1: Validasi Nomor WhatsApp & Checkout Delivery
    // =====================================================================
    console.log('\n--- [TEST 1] Secondary: WhatsApp Phone Validation ---');
    
    // 1.1 Sembilan huruf tanpa angka harus DITOLAK
    const letterPayload = new URLSearchParams({
      customer_name: 'Tester Huruf',
      customer_phone: 'abcdefghi',
      method: 'pickup',
      items: JSON.stringify([{ id: 1, quantity: 1 }])
    }).toString();
    const resLetter = await request(server, {
      path: '/checkout',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(letterPayload) }
    }, letterPayload);
    assert.strictEqual(resLetter.statusCode, 400, 'Sembilan huruf tanpa angka harus ditolak (400)');
    const jsonLetter = JSON.parse(resLetter.body);
    assert.strictEqual(jsonLetter.success, false);
    assert(jsonLetter.message.toLowerCase().includes('tidak valid'), 'Harus menampilkan pesan nomor tidak valid');
    console.log('✔ [1.1] Sembilan huruf tanpa angka berhasil ditolak dengan 400 Bad Request.');

    // 1.2 Format tidak valid lainnya
    const invalidPhones = ['0812abc345', '12345678', '08', '+1234567890'];
    for (const badPhone of invalidPhones) {
      const p = new URLSearchParams({
        customer_name: 'Bad Phone',
        customer_phone: badPhone,
        method: 'pickup',
        items: JSON.stringify([{ id: 1, quantity: 1 }])
      }).toString();
      const r = await request(server, {
        path: '/checkout',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(p) }
      }, p);
      assert.strictEqual(r.statusCode, 400, `Nomor '${badPhone}' harus ditolak`);
    }
    console.log('✔ [1.2] Berbagai format nomor tidak valid (mengandung huruf, terlalu pendek, prefix non-ID) ditolak.');

    // 1.3 Format Indonesia valid harus DITERIMA: 08..., 62..., +62..., pemisah spasi/dash
    const validPhones = ['081234567890', '+6281234567890', '628123456789', '0812-3456-7890', '(0812) 3456 7890'];
    for (const goodPhone of validPhones) {
      const norm = helpers.normalizePhone(goodPhone);
      assert(norm && norm.startsWith('+628') && norm.length >= 12, `Nomor '${goodPhone}' harus dinormalisasi dengan benar`);
    }
    console.log('✔ [1.3] Format nomor Indonesia (08..., 62..., +62..., simbol/spasi) dinormalisasi dengan benar ke +628...');

    // =====================================================================
    // BAGIAN 2: Keamanan Akses (Pelanggan Tanpa Sesi Admin Ditolak)
    // =====================================================================
    console.log('\n--- [TEST 2] Access Control: Unauthenticated User Cannot Delete ---');
    const unauthDetail = await request(server, {
      path: '/admin/orders/NCH-99999/delete',
      method: 'POST',
      headers: { 'Accept': 'application/json' }
    });
    assert.strictEqual(unauthDetail.statusCode, 401, 'Hapus detail tanpa login admin harus ditolak (401)');
    console.log('✔ [2.1] Hapus dari detail tanpa sesi admin ditolak dengan 401 Unauthorized.');

    const unauthBulk = await request(server, {
      path: '/admin/orders/bulk-delete',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    }, JSON.stringify({ order_ids: ['NCH-99999'] }));
    assert.strictEqual(unauthBulk.statusCode, 401, 'Hapus massal tanpa login admin harus ditolak (401)');
    console.log('✔ [2.2] Hapus massal tanpa sesi admin ditolak dengan 401 Unauthorized.');

    // Admin login
    const loginPayload = 'username=admin&password=nachoan2026';
    const loginRes = await request(server, {
      path: '/admin/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(loginPayload) }
    }, loginPayload);
    adminCookies = parseCookie(loginRes);
    assert(adminCookies, 'Admin login harus menghasilkan cookie');
    console.log('✔ [2.3] Admin berhasil login.');

    // =====================================================================
    // BAGIAN 3: Pembuatan Dua Pesanan Sintetis Milik Pelanggan Berbeda
    // =====================================================================
    console.log('\n--- [TEST 3] Setup: Membuat 2 Pesanan Sintetis (Target & Kontrol) ---');
    
    // Pesanan A: Target yang akan dihapus
    const orderAPayload = new URLSearchParams({
      customer_name: 'Rina Melati (Pelanggan Target A)',
      customer_phone: '081211112222',
      customer_email: 'rina@example.com',
      method: 'delivery',
      address: 'Jl. Melati No. 10 Bandung',
      delivery_zone_id: '1',
      items: JSON.stringify([{ id: 1, quantity: 2, variant: 'Pedas' }]),
      notes: 'Pesanan Target A'
    }).toString();
    const resA = await request(server, {
      path: '/checkout',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(orderAPayload) }
    }, orderAPayload);
    const dataA = JSON.parse(resA.body);
    const tokenA = dataA.token;
    const numberA = dataA.orderNumber;
    const cookieA = `nch_ord_${tokenA.slice(0, 16)}=${encodeURIComponent(JSON.stringify({ order: { access_token: tokenA, order_number: numberA, customer_name: 'Rina Melati' } }))}`;

    // Pesanan B: Kontrol (tidak boleh terhapus)
    const orderBPayload = new URLSearchParams({
      customer_name: 'Bambang Wijaya (Pelanggan Kontrol B)',
      customer_phone: '081233334444',
      customer_email: 'bambang@example.com',
      method: 'pickup',
      items: JSON.stringify([{ id: 1, quantity: 1, variant: 'Original' }]),
      notes: 'Pesanan Kontrol B'
    }).toString();
    const resB = await request(server, {
      path: '/checkout',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(orderBPayload) }
    }, orderBPayload);
    const dataB = JSON.parse(resB.body);
    const tokenB = dataB.token;
    const numberB = dataB.orderNumber;
    const cookieB = `nch_ord_${tokenB.slice(0, 16)}=${encodeURIComponent(JSON.stringify({ order: { access_token: tokenB, order_number: numberB, customer_name: 'Bambang Wijaya' } }))}`;

    console.log(`✔ [3.1] Pesanan Target A terbuat: ${numberA} (Token: ${tokenA.slice(0, 10)}...)`);
    console.log(`✔ [3.2] Pesanan Kontrol B terbuat: ${numberB} (Token: ${tokenB.slice(0, 10)}...)`);

    // =====================================================================
    // BAGIAN 4: Skenario 1 — Hapus dari Halaman Detail Pesanan
    // =====================================================================
    console.log('\n--- [TEST 4] Skenario 1: Hapus Pesanan Target A dari Detail Page ---');
    
    // Admin mengeksekusi POST /admin/orders/:id/delete untuk Pesanan A
    const delResA = await request(server, {
      path: `/admin/orders/${numberA}/delete`,
      method: 'POST',
      headers: { 'Cookie': adminCookies, 'Accept': 'application/json' }
    });
    assert.strictEqual(delResA.statusCode, 200, 'Hapus detail harus berhasil (200 JSON)');
    const delJsonA = JSON.parse(delResA.body);
    assert.strictEqual(delJsonA.success, true);
    assert.strictEqual(delJsonA.deletedCount, 1);
    console.log('✔ [4.1] Handler delete mengembalikan sukses setelah dikonfirmasi oleh Sheets.');

    // Verifikasi 1: Muat ulang daftar admin, paksa sinkronisasi dari Sheets, lalu cek DB
    const adminOrdersRes1 = await request(server, {
      path: '/admin/orders',
      method: 'GET',
      headers: { 'Cookie': adminCookies }
    });
    assert(!adminOrdersRes1.body.includes(numberA), 'Pesanan Target A tidak boleh muncul di daftar admin');
    assert(adminOrdersRes1.body.includes(numberB), 'Pesanan Kontrol B harus tetap muncul di daftar admin');

    // Paksa sinkronisasi dari Sheets
    await sheets.syncOrdersFromAppsScriptIfVercel(true);
    const adminOrdersAfterSync = await request(server, {
      path: '/admin/orders',
      method: 'GET',
      headers: { 'Cookie': adminCookies }
    });
    assert(!adminOrdersAfterSync.body.includes(numberA), 'Setelah paksa sinkronisasi Sheets, Pesanan A tetap tidak muncul');

    // Simulasi instance Vercel baru dengan SQLite fresh:
    // Hapus records dari tabel orders lokal, lalu jalankan syncOrdersFromAppsScriptIfVercel
    db.prepare('DELETE FROM orders WHERE order_number = ?').run(numberA);
    await sheets.syncOrdersFromAppsScriptIfVercel(true);
    const orderInDbAfterSync = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(numberA);
    assert.strictEqual(orderInDbAfterSync, undefined, 'Pesanan A tidak boleh di-insert kembali ke SQLite oleh sync Sheets');
    console.log('✔ [4.2] Verifikasi 1: Daftar admin & sinkronisasi instance fresh tidak memunculkan Pesanan A kembali.');

    // Verifikasi 2: Buka tautan pelacakan lama dari browser asal yang menyimpan cookie
    const customerTrackingA = await request(server, {
      path: `/order/${tokenA}`,
      method: 'GET',
      headers: { 'Cookie': cookieA }
    });
    assert.strictEqual(customerTrackingA.statusCode, 404, 'Pelacakan Pesanan A yang dihapus harus 404');
    const orderRecreated = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(numberA);
    assert.strictEqual(orderRecreated, undefined, 'Pesanan A TIDAK BOLEH dibuat ulang dari cookie pelanggan');
    console.log('✔ [4.3] Verifikasi 2: Tautan pelacakan lama dengan cookie mengembalikan 404 dan TIDAK membuat ulang pesanan.');

    // Verifikasi 3: Pastikan pesanan pembanding B beserta item dan statusnya tetap utuh
    const orderBCheck = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(numberB);
    assert(orderBCheck, 'Pesanan Kontrol B harus tetap utuh di DB');
    const itemsBCheck = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderBCheck.id);
    assert.strictEqual(itemsBCheck.length, 1, 'Item Pesanan Kontrol B harus utuh');
    const customerTrackingB = await request(server, {
      path: `/order/${tokenB}`,
      method: 'GET',
      headers: { 'Cookie': cookieB }
    });
    assert.strictEqual(customerTrackingB.statusCode, 200, 'Customer pelacakan Pesanan Kontrol B tetap dapat diakses normal');
    console.log('✔ [4.4] Verifikasi 3: Pesanan pembanding B dan seluruh itemnya tetap 100% utuh.');

    // =====================================================================
    // BAGIAN 5: Skenario 2 — Hapus dari Halaman Daftar (Bulk Delete)
    // =====================================================================
    console.log('\n--- [TEST 5] Skenario 2: Hapus Pesanan Target C dari Daftar (Bulk Delete) ---');
    
    // Buat Pesanan C
    const orderCPayload = new URLSearchParams({
      customer_name: 'Citra Kirana (Target C)',
      customer_phone: '081255556666',
      method: 'pickup',
      items: JSON.stringify([{ id: 1, quantity: 1, variant: 'Pedas' }])
    }).toString();
    const resC = await request(server, {
      path: '/checkout',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(orderCPayload) }
    }, orderCPayload);
    const dataC = JSON.parse(resC.body);
    const tokenC = dataC.token;
    const numberC = dataC.orderNumber;
    const cookieC = `nch_ord_${tokenC.slice(0, 16)}=${encodeURIComponent(JSON.stringify({ order: { access_token: tokenC, order_number: numberC } }))}`;
    console.log(`✔ [5.1] Pesanan Target C terbuat: ${numberC}`);

    // Hapus massal dengan nomor pesanan yang stabil
    const bulkDelRes = await request(server, {
      path: '/admin/orders/bulk-delete',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': adminCookies, 'Accept': 'application/json' },
    }, JSON.stringify({ order_ids: [numberC] }));

    assert.strictEqual(bulkDelRes.statusCode, 200, 'Bulk delete harus HTTP 200');
    const bulkJson = JSON.parse(bulkDelRes.body);
    assert.strictEqual(bulkJson.success, true);
    assert.strictEqual(bulkJson.deletedCount, 1);
    console.log('✔ [5.2] Bulk delete berhasil mengonfirmasi penghapusan Pesanan C.');

    // Verifikasi 1: Daftar admin & sinkronisasi Sheets
    await sheets.syncOrdersFromAppsScriptIfVercel(true);
    const adminOrdersRes2 = await request(server, {
      path: '/admin/orders',
      method: 'GET',
      headers: { 'Cookie': adminCookies }
    });
    assert(!adminOrdersRes2.body.includes(numberC), 'Pesanan C tidak boleh muncul di daftar admin');
    assert(adminOrdersRes2.body.includes(numberB), 'Pesanan Kontrol B tetap ada');

    // Verifikasi 2: Pelacakan dengan cookie
    const customerTrackingC = await request(server, {
      path: `/order/${tokenC}`,
      method: 'GET',
      headers: { 'Cookie': cookieC }
    });
    assert.strictEqual(customerTrackingC.statusCode, 404, 'Pelacakan Pesanan C harus 404');
    const orderCRecreated = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(numberC);
    assert.strictEqual(orderCRecreated, undefined, 'Pesanan C tidak dibuat ulang dari cookie');
    console.log('✔ [5.3] Verifikasi 1 & 2 pada Skenario Bulk Delete lulus sempurna.');

    // Verifikasi 3: Pesanan Kontrol B tetap utuh
    const orderBCheck2 = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(numberB);
    assert(orderBCheck2, 'Pesanan Kontrol B harus tetap utuh');
    console.log('✔ [5.4] Pesanan kontrol B tetap utuh setelah bulk delete.');

    // =====================================================================
    // BAGIAN 6: Kegagalan Apps Script, Timeout, Not Found, dan Idempotency
    // =====================================================================
    console.log('\n--- [TEST 6] Edge Cases: Apps Script Error, Timeout, Not Found, Idempotency ---');
    
    // 6.1 Apps Script Mengalami Error / 500
    mockAppsScript.failureMode = 'error';
    const failRes = await request(server, {
      path: '/admin/orders/bulk-delete',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': adminCookies, 'Accept': 'application/json' },
    }, JSON.stringify({ order_ids: [numberB] }));

    assert.strictEqual(failRes.statusCode, 400, 'Kegagalan Apps Script harus menghasilkan error 400');
    const failJson = JSON.parse(failRes.body);
    assert.strictEqual(failJson.success, false);
    assert(failJson.message.includes('Gagal menghapus pesanan di penyimpanan utama'), 'Pesan error harus akurat mencerminkan kegagalan Sheets');
    
    // Pastikan pesanan B TIDAK dihapus dari SQLite karena penyimpanan utama gagal!
    const orderBStillExists = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(numberB);
    assert(orderBStillExists, 'Pesanan B TIDAK boleh dihapus jika penyimpanan utama gagal mengonfirmasi');
    console.log('✔ [6.1] Ketika Apps Script error, sistem melaporkan kegagalan dan TIDAK menghapus pesanan di SQLite (storage truth preserved).');

    // 6.2 Apps Script Timeout
    mockAppsScript.failureMode = 'timeout';
    const timeoutRes = await request(server, {
      path: `/admin/orders/${numberB}/delete`,
      method: 'POST',
      headers: { 'Cookie': adminCookies, 'Accept': 'application/json' }
    });
    assert.strictEqual(timeoutRes.statusCode, 400);
    const timeoutJson = JSON.parse(timeoutRes.body);
    assert.strictEqual(timeoutJson.success, false);
    const orderBStillAlive = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(numberB);
    assert(orderBStillAlive, 'Pesanan B tetap utuh pasca timeout');
    console.log('✔ [6.2] Ketika Apps Script timeout, sistem melaporkan kegagalan dan pesanan tetap aman.');

    mockAppsScript.failureMode = null; // Normal kembali

    // 6.3 Nomor Pesanan Tidak Ditemukan
    const notFoundRes = await request(server, {
      path: '/admin/orders/bulk-delete',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': adminCookies, 'Accept': 'application/json' },
    }, JSON.stringify({ order_ids: ['NCH-9999999'] }));
    const nfJson = JSON.parse(notFoundRes.body);
    assert.strictEqual(nfJson.notFoundCount, 1);
    console.log('✔ [6.3] Nomor pesanan tidak ditemukan dilaporkan dengan akurat (notFoundCount: 1).');

    // 6.4 Permintaan Hapus Berulang (Idempotency)
    // Menghapus kembali Pesanan A yang sudah terhapus
    const repeatRes = await request(server, {
      path: `/admin/orders/${numberA}/delete`,
      method: 'POST',
      headers: { 'Cookie': adminCookies, 'Accept': 'application/json' }
    });
    const repeatJson = JSON.parse(repeatRes.body);
    assert.strictEqual(repeatJson.success, true, 'Permintaan hapus ulang harus aman dan sukses (idempotent)');
    console.log('✔ [6.4] Permintaan hapus berulang (retry) aman dan idempotent.');

    console.log('\n======================================================================');
    console.log('  🎉 SELURUH PENGUJIAN REGRESI DAN KEAMANAN LULUS 100%!               ');
    console.log('======================================================================\n');

  } finally {
    server.close();
    sheets.setMockAppsScriptHandler(null);
    if (origScriptUrl) {
      db.prepare("INSERT OR REPLACE INTO store_settings (key, value) VALUES ('apps_script_url', ?)").run(origScriptUrl);
    } else {
      db.prepare("DELETE FROM store_settings WHERE key = 'apps_script_url'").run();
    }
  }
}

runRegressionTests().catch(err => {
  console.error('\n❌ REGRESSION TEST GAGAL DENGAN ERROR:\n', err);
  process.exit(1);
});
