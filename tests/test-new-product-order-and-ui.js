const http = require('http');
const assert = require('assert');
const app = require('../server');
const getDb = require('../lib/db');
const sheets = require('../lib/sheets');

async function test() {
  console.log('Testing newly added product checkout & OrderItems deletion...');
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  const db = getDb();
  // Ensure product 10 exists
  db.prepare(`
    INSERT OR REPLACE INTO products (id, category_id, name, slug, description, price, image, available, archived, created_at, updated_at)
    VALUES (10, 1, 'hihu', 'hihu', 'hihu', 1000, '/images/test.jpg', 1, 0, datetime('now'), datetime('now'))
  `).run();

  // 1. Test POST /checkout with product 10
  const payload = JSON.stringify({
    customer_name: 'Tester Hihu',
    customer_phone: '081234567890',
    method: 'pickup',
    items: [{ id: 10, name: 'hihu', price: 1000, quantity: 2 }]
  });

  const res = await fetch(`http://127.0.0.1:${port}/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload
  });
  const data = await res.json();
  console.log('Checkout response:', data);
  assert.strictEqual(data.success, true, 'Checkout produk 10 (hihu) harus sukses');
  assert(data.token, 'Token harus ada');

  // Verify DB
  const order = db.prepare('SELECT * FROM orders WHERE access_token = ?').get(data.token);
  assert.strictEqual(order.total, 2000, 'Total harus 2000 (1000 x 2)');
  console.log('✔ Checkout produk baru (hihu) berhasil dibuat dengan total Rp' + order.total);

  // 2. Test GET /checkout renders modal & loading markup
  const pageRes = await fetch(`http://127.0.0.1:${port}/checkout`);
  const html = await pageRes.text();
  assert(html.includes('nachoan-dialog-backdrop'), 'Modal dialog backdrop harus ada di checkout page');
  assert(html.includes('nachoan-loading-backdrop'), 'Loading backdrop harus ada di checkout page');
  console.log('✔ Modal dialog dan loading overlay terpasang di tampilan checkout');

  // 3. Test POST /api/cart/validate with product 10
  const valRes = await fetch(`http://127.0.0.1:${port}/api/cart/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ id: 10, quantity: 2 }] })
  });
  const valData = await valRes.json();
  assert.strictEqual(valData.success, true);
  assert.strictEqual(valData.data.valid, true);
  assert.strictEqual(valData.data.total, 2000);
  console.log('✔ Endpoint validate keranjang berhasil mengenali produk baru dengan total Rp' + valData.data.total);

  // 4. Clean up
  db.prepare('DELETE FROM order_items WHERE order_id = ?').run(order.id);
  db.prepare('DELETE FROM payment_submissions WHERE order_id = ?').run(order.id);
  db.prepare('DELETE FROM order_status_history WHERE order_id = ?').run(order.id);
  db.prepare('DELETE FROM orders WHERE id = ?').run(order.id);
  server.close();
  console.log('🎉 Semua pengujian spesifik lulus 100%!');
}

test().catch(e => {
  console.error('FAILED:', e);
  process.exit(1);
});
