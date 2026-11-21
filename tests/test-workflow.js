const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const app = require('../server');
const getDb = require('../lib/db');

const PORT = 3002;
let server;

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

async function testPaymentVerificationWorkflow() {
  console.log('=== TESTING COMPLETE PAYMENT VERIFICATION & ADMIN AUDIT FLOW ===\n');

  server = app.listen(PORT, async () => {
    try {
      const db = getDb();

      // 1. Create a fresh order
      console.log('Step 1: Create Order via Checkout');
      const checkoutRes = await request('POST', '/checkout', {
        customer_name: 'Dewi Lestari',
        customer_phone: '081298765432',
        method: 'pickup',
        notes: 'Extra tissue',
        items: [
          { type: 'product', id: 1, quantity: 2, variant: 'Pedas' } // 50.000 + free Cheese Dip
        ]
      });
      const orderData = JSON.parse(checkoutRes.body);
      assert(orderData.success, 'Order must succeed');
      const token = orderData.token;
      const order = db.prepare('SELECT * FROM orders WHERE access_token = ?').get(token);
      console.log(`✔ Order created: ID ${order.id}, Number ${order.order_number}, Total ${order.total}`);

      // 2. Simulate Upload Payment Proof (Multipart)
      console.log('\nStep 2: Upload Payment Proof');
      const boundary = '----WebKitFormBoundaryTest' + Date.now();
      const fakeImageContent = 'fake jpeg image bytes for verification test';
      const multipartBody = 
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="payment_proof"; filename="transfer_struk.jpg"\r\n` +
        `Content-Type: image/jpeg\r\n\r\n` +
        fakeImageContent + `\r\n` +
        `--${boundary}--\r\n`;

      const uploadRes = await request('POST', `/order/${token}/upload`, multipartBody, {
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      });
      assert.strictEqual(uploadRes.statusCode, 302, 'Should redirect to /order/:token after upload');

      // Check DB submission
      const sub = db.prepare('SELECT * FROM payment_submissions WHERE order_id = ? ORDER BY version DESC LIMIT 1').get(order.id);
      assert(sub, 'Payment submission record must exist');
      assert.strictEqual(sub.version, 1);
      assert.strictEqual(sub.status, 'pending');

      const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
      assert.strictEqual(updatedOrder.order_status, 'WAITING_CONFIRMATION', 'Order status must be WAITING_CONFIRMATION');
      console.log('✔ Payment proof uploaded, submission record created, status WAITING_CONFIRMATION.');

      // 3. Admin Login
      console.log('\nStep 3: Admin Login');
      const loginRes = await request('POST', '/admin/login', 
        'username=admin&password=nachoan2026',
        { 'Content-Type': 'application/x-www-form-urlencoded' }
      );
      const sessionCookie = loginRes.headers['set-cookie'][0].split(';')[0];
      console.log('✔ Admin logged in.');

      // 4. Admin Rejects Proof First (e.g. Nominal Kurang) to test Rejection & Audit trail
      console.log('\nStep 4: Admin Rejects Payment with Mandatory Reason');
      const rejectRes = await request('POST', `/admin/orders/${order.id}/verify-payment`,
        'action=reject&reason=Nominal+transfer+kurang+Rp5.000',
        {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': sessionCookie
        }
      );
      assert.strictEqual(rejectRes.statusCode, 302);

      const rejectedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
      assert.strictEqual(rejectedOrder.payment_status, 'REJECTED');
      assert.strictEqual(rejectedOrder.order_status, 'REJECTED');

      const rejectedSub = db.prepare('SELECT * FROM payment_submissions WHERE id = ?').get(sub.id);
      assert.strictEqual(rejectedSub.status, 'rejected');
      assert.strictEqual(rejectedSub.reviewer_note, 'Nominal transfer kurang Rp5.000');
      console.log('✔ Rejection logged with mandatory reason & order marked REJECTED.');

      // 5. Customer re-uploads payment proof (Version 2)
      console.log('\nStep 5: Customer Re-uploads Proof (Version 2)');
      const boundary2 = '----WebKitFormBoundaryTest2' + Date.now();
      const multipartBody2 = 
        `--${boundary2}\r\n` +
        `Content-Disposition: form-data; name="payment_proof"; filename="transfer_struk_lunas.jpg"\r\n` +
        `Content-Type: image/jpeg\r\n\r\n` +
        fakeImageContent + `\r\n` +
        `--${boundary2}--\r\n`;

      const reuploadRes = await request('POST', `/order/${token}/upload`, multipartBody2, {
        'Content-Type': `multipart/form-data; boundary=${boundary2}`
      });
      assert.strictEqual(reuploadRes.statusCode, 302);

      const sub2 = db.prepare('SELECT * FROM payment_submissions WHERE order_id = ? ORDER BY version DESC LIMIT 1').get(order.id);
      assert.strictEqual(sub2.version, 2, 'New submission should be version 2');
      console.log('✔ Customer re-uploaded proof successfully (Version 2).');

      // 6. Admin Approves Payment (Accept)
      console.log('\nStep 6: Admin Approves Payment');
      const approveRes = await request('POST', `/admin/orders/${order.id}/verify-payment`,
        'action=accept&reference=BCA-TRX-888999',
        {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': sessionCookie
        }
      );
      assert.strictEqual(approveRes.statusCode, 302);

      const paidOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
      assert.strictEqual(paidOrder.payment_status, 'PAID', 'Order payment status MUST be PAID');
      assert.strictEqual(paidOrder.order_status, 'PAID', 'Order status MUST be PAID');

      const approvedSub = db.prepare('SELECT * FROM payment_submissions WHERE id = ?').get(sub2.id);
      assert.strictEqual(approvedSub.status, 'approved');
      assert.strictEqual(approvedSub.review_reference, 'BCA-TRX-888999');
      console.log('✔ Admin approved payment. Order is now PAID.');

      // 7. Advance Operational Status: PREPARING -> READY -> COMPLETED
      console.log('\nStep 7: Advance Order Operational Status to PREPARING, READY, COMPLETED');
      await request('POST', `/admin/orders/${order.id}/status`,
        'order_status=PREPARING&note=Sedang+dimasak+di+dapur',
        { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': sessionCookie }
      );
      assert.strictEqual(db.prepare('SELECT order_status FROM orders WHERE id = ?').get(order.id).order_status, 'PREPARING');

      await request('POST', `/admin/orders/${order.id}/status`,
        'order_status=READY&note=Pesanan+siap+diambil',
        { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': sessionCookie }
      );
      assert.strictEqual(db.prepare('SELECT order_status FROM orders WHERE id = ?').get(order.id).order_status, 'READY');

      await request('POST', `/admin/orders/${order.id}/status`,
        'order_status=COMPLETED&note=Pesanan+telah+diambil+oleh+pelanggan',
        { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': sessionCookie }
      );
      assert.strictEqual(db.prepare('SELECT order_status FROM orders WHERE id = ?').get(order.id).order_status, 'COMPLETED');
      console.log('✔ Status successfully transitioned to COMPLETED.');

      // 8. Verify Audit Trail in order_status_history
      console.log('\nStep 8: Audit Trail Verification');
      const history = db.prepare('SELECT * FROM order_status_history WHERE order_id = ? ORDER BY id ASC').all(order.id);
      assert(history.length >= 5, 'Must have at least 5 audit history entries');
      console.log(`✔ Audit history contains ${history.length} events logged chronologically.`);

      console.log('\n======================================================');
      console.log('COMPLETE PAYMENT & AUDIT WORKFLOW VERIFIED 100%! 🎉');
      console.log('======================================================\n');

      server.close();
      process.exit(0);
    } catch (err) {
      console.error('Workflow Test Failure:', err);
      if (server) server.close();
      process.exit(1);
    }
  });
}

testPaymentVerificationWorkflow();
