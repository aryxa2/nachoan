const https = require('https');

function request(url, options = {}, postData = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

(async () => {
  console.log('--- Testing Live Order & Upload Flow on Vercel ---');
  // 1. Post checkout
  const checkoutPayload = new URLSearchParams({
    customer_name: 'Testing Live Vercel',
    customer_phone: '081234567890',
    delivery_method: 'pickup',
    payment_method: 'qris',
    items: JSON.stringify([{ id: 1, quantity: 2 }]) // 2x Beefy Nacho (15000) = 30000
  }).toString();

  const checkoutRes = await request('https://nachoan.vercel.app/checkout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(checkoutPayload)
    }
  }, checkoutPayload);

  console.log('Checkout Status:', checkoutRes.statusCode);
  const checkoutData = JSON.parse(checkoutRes.body);
  console.log('Checkout Response:', checkoutData);
  const cookies = (checkoutRes.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  console.log('Checkout Cookies:', cookies);

  const token = checkoutData.token;
  console.log('Order Token:', token);

  // 2. Access /order/:token
  const orderRes = await request('https://nachoan.vercel.app/order/' + token, {
    method: 'GET',
    headers: { 'Cookie': cookies }
  });
  console.log('Order page Status:', orderRes.statusCode, '(Contains Pesanan:', orderRes.body.includes('Testing Live Vercel') + ')');

  // 3. Post payment upload multipart
  const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
  const fileContent = 'fake image bytes for testing payment proof';
  const multipartBody = 
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="payment_proof"; filename="proof.jpg"\r\n` +
    `Content-Type: image/jpeg\r\n\r\n` +
    fileContent + `\r\n` +
    `--${boundary}--\r\n`;

  const uploadRes = await request('https://nachoan.vercel.app/order/' + token + '/upload', {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': Buffer.byteLength(multipartBody),
      'Cookie': cookies
    }
  }, multipartBody);

  console.log('Upload Status:', uploadRes.statusCode);
  console.log('Upload Redirect:', uploadRes.headers.location);

  if (uploadRes.statusCode === 302 && uploadRes.headers.location.includes('uploaded=1')) {
    console.log('✔ Payment proof uploaded successfully on live Vercel!');
  } else {
    console.error('❌ Upload failed:', uploadRes.statusCode, uploadRes.headers.location);
  }
})();
