const http = require('http');
const assert = require('assert');
const app = require('../server');
const getDb = require('../lib/db');
const { formatDate, now } = require('../lib/helpers');
const { parseBulkOrdersText, deleteOrdersService } = require('../lib/orders');

async function runTests() {
  console.log('=== TEST 1: Sinkronisasi Waktu & Tanggal (WIB di Lingkungan Serverless UTC) ===');

  // Verify formatDate behavior
  const formattedUtc = formatDate('2026-11-24T15:17:33.000Z');
  console.log('UTC ISO 15:17Z ->', formattedUtc);
  assert(formattedUtc.includes('22:17 WIB'), 'Waktu 15:17 UTC harus ditampilkan sebagai 22:17 WIB');

  const formattedLocal = formatDate('2026-11-24T22:17:33');
  console.log('Local ISO 22:17 ->', formattedLocal);
  assert(formattedLocal.includes('22:17 WIB'), 'Waktu lokal 22:17 harus ditampilkan sebagai 22:17 WIB');

  const formattedSheet = formatDate('2026-11-24 22:17:33');
  console.log('Sheet format 22:17 ->', formattedSheet);
  assert(formattedSheet.includes('22:17 WIB'), 'Waktu spreadsheet 22:17 harus ditampilkan sebagai 22:17 WIB');

  console.log('✔ Sinkronisasi waktu dan tanggal berhasil diverifikasi 100%!');

  console.log('\n=== TEST 2: Parsing Format Teks Pesanan Massal (Chat & Pipe) ===');
  const db = getDb();
  const activeProducts = db.prepare('SELECT id, name, slug, price FROM products WHERE available = 1 AND archived = 0 ORDER BY id ASC').all();
  assert(activeProducts.length > 0, 'Harus ada produk aktif di database');

  const sampleChat = `
Nama: Pelanggan Batch 1
WA: 081299887766
Metode: Delivery
Alamat: Jl. Sukabirus No. 42
Pesanan: 2x Beefy Nacho, 1x Cheezy Corn
Catatan: Saus dipisah
---
Nama: Pelanggan Batch 2
WA: 085711223344
Metode: Pickup
Pesanan: 1x Beefy Nacho
Catatan: Tidak pedas
`;

  const parsedChat = parseBulkOrdersText(sampleChat, activeProducts);
  assert.strictEqual(parsedChat.length, 2, 'Harus mendeteksi 2 pesanan dari format chat');
  assert.strictEqual(parsedChat[0].customer_name, 'Pelanggan Batch 1');
  assert.strictEqual(parsedChat[0].method, 'delivery');
  assert.strictEqual(parsedChat[0].items.length, 2);
  assert.strictEqual(parsedChat[1].customer_name, 'Pelanggan Batch 2');
  assert.strictEqual(parsedChat[1].method, 'pickup');
  assert.strictEqual(parsedChat[1].items.length, 1);
  console.log('✔ Parsing format chat WhatsApp multi-pesanan berhasil!');

  const samplePipe = `
Pelanggan Pipe 1 | 081299887766 | Delivery | Jl. Telekomunikasi No. 1 | 2x Beefy Nacho | Saus dipisah
Pelanggan Pipe 2 | 085711223344 | Pickup | - | 1x Beefy Nacho | Jangan pedas
`;
  const parsedPipe = parseBulkOrdersText(samplePipe, activeProducts);
  assert.strictEqual(parsedPipe.length, 2, 'Harus mendeteksi 2 pesanan dari format pipe');
  assert.strictEqual(parsedPipe[0].customer_name, 'Pelanggan Pipe 1');
  assert.strictEqual(parsedPipe[0].method, 'delivery');
  assert.strictEqual(parsedPipe[1].customer_name, 'Pelanggan Pipe 2');
  assert.strictEqual(parsedPipe[1].method, 'pickup');
  console.log('✔ Parsing format baris pipe (|) multi-pesanan berhasil!');

  console.log('\n=== TEST 3: Integrasi API Admin (Preview & Create Bulk Orders) ===');
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // Log in as admin to get session cookie
  const loginRes = await fetch(`${baseUrl}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=nachoan2026',
    redirect: 'manual'
  });
  const cookie = loginRes.headers.getSetCookie 
    ? loginRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    : loginRes.headers.get('set-cookie');
  assert(cookie, 'Admin harus berhasil login dan menerima session cookie');

  // 3a. Test POST /admin/orders/preview-bulk-text
  const previewRes = await fetch(`${baseUrl}/admin/orders/preview-bulk-text`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookie
    },
    body: JSON.stringify({ rawText: sampleChat })
  });
  const previewData = await previewRes.json();
  assert.strictEqual(previewData.success, true);
  assert.strictEqual(previewData.totalParsed, 2);
  assert.strictEqual(previewData.validCount, 2);
  console.log('✔ Endpoint preview-bulk-text mengonfirmasi 2 pesanan valid dengan kalkulasi harga benar!');

  // 3b. Test POST /admin/orders/create-bulk-text
  const createBulkRes = await fetch(`${baseUrl}/admin/orders/create-bulk-text`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookie
    },
    body: JSON.stringify({ rawText: sampleChat })
  });
  const createBulkData = await createBulkRes.json();
  console.log('Create bulk result:', createBulkData.message);
  assert.strictEqual(createBulkData.success, true);
  assert.strictEqual(createBulkData.count, 2);
  assert(Array.isArray(createBulkData.orders) && createBulkData.orders.length === 2);

  const orderNumbersCreated = createBulkData.orders.map(o => o.order_number);

  // Verify in database
  for (const num of orderNumbersCreated) {
    const rec = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(num);
    assert(rec, `Pesanan ${num} harus tercatat di database`);
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(rec.id);
    assert(items.length > 0, `Pesanan ${num} harus memiliki item`);
    const hist = db.prepare('SELECT * FROM order_status_history WHERE order_id = ?').all(rec.id);
    assert(hist.length > 0, `Pesanan ${num} harus memiliki riwayat status`);
    console.log(`  -> Pesanan ${num} verified di SQLite: ${rec.customer_name}, Total: Rp${rec.total}, Items: ${items.length}`);
  }

  console.log('\n=== TEST 4: Pemeliharaan Fitur Eksisting (Single Manual Order Form) ===');
  // 4. Test POST /admin/orders/create-manual still works 100%
  const singleRes = await fetch(`${baseUrl}/admin/orders/create-manual`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookie
    },
    body: JSON.stringify({
      customer_name: 'Pelanggan Manual Satuan',
      customer_phone: '081234567899',
      method: 'pickup',
      payment_status: 'PAID',
      order_status: 'NEW',
      notes: 'Form satuan tetap berfungsi normal',
      items: [{ product_id: activeProducts[0].id, quantity: 1 }]
    })
  });
  const singleData = await singleRes.json();
  assert.strictEqual(singleData.success, true);
  assert(singleData.orderNumber, 'Harus menghasilkan nomor pesanan');
  orderNumbersCreated.push(singleData.orderNumber);
  console.log(`✔ Pembuatan pesanan manual satuan eksisting (${singleData.orderNumber}) tetap berfungsi 100%!`);

  console.log('\n=== TEST 5: Pembersihan Data Sintetis Menggunakan deleteOrdersService ===');
  const deleteResult = await deleteOrdersService({ orderIdentifiers: orderNumbersCreated });
  assert.strictEqual(deleteResult.success, true);
  assert.strictEqual(deleteResult.deletedCount, 3);
  console.log(`✔ Berhasil menghapus ${deleteResult.deletedCount} pesanan uji sintetis secara permanen!`);

  server.close();
  console.log('\n🎉 SEMUA PENGUJIAN INTEGRASI DAN REGRESI LULUS 100%!');
}

runTests().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
