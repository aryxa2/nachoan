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

async function testCarouselFlow() {
  console.log('=== TESTING HERO CAROUSEL CRUD & HOMEPAGE RENDERING ===\n');
  const db = getDb();

  // 1. Homepage render verification
  console.log('1. Checking Homepage Hero Carousel');
  const homeRes = await request('GET', '/');
  assert.strictEqual(homeRes.statusCode, 200);
  assert(homeRes.body.includes('id="heroCarousel"'), 'Hero carousel must be rendered on homepage');
  assert(homeRes.body.includes('Beefy Nacho Cone'), 'Beefy Nacho slide must be present');
  console.log('✔ Homepage renders carousel with active slides.');

  // 2. Admin Login
  console.log('\n2. Admin Authentication');
  const loginRes = await request('POST', '/admin/login',
    'username=admin&password=nachoan2026',
    { 'Content-Type': 'application/x-www-form-urlencoded' }
  );
  assert.strictEqual(loginRes.statusCode, 302);
  const sessionCookie = loginRes.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
  console.log('✔ Admin logged in.');

  // 3. GET /admin/carousel
  console.log('\n3. GET /admin/carousel');
  const carouselPageRes = await request('GET', '/admin/carousel', null, {
    'Cookie': sessionCookie
  });
  assert.strictEqual(carouselPageRes.statusCode, 200);
  assert(carouselPageRes.body.includes('Kelola Hero Carousel'), 'Admin carousel page must render');
  console.log('✔ Admin carousel management page rendered successfully.');

  // 4. Add new carousel slide
  console.log('\n4. POST /admin/carousel/add');
  const addParams = new URLSearchParams({
    title: 'Test Slide Promo Ramadan',
    caption: 'Diskon spesial dan kemasan eksklusif',
    image_url: '/images/products/beefy-nacho.jpg',
    link_url: '/menu',
    sort_order: '4',
    active: '1'
  }).toString();

  const addRes = await request('POST', '/admin/carousel/add', addParams, {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Cookie': sessionCookie
  });
  assert.strictEqual(addRes.statusCode, 302);
  
  const addedSlide = db.prepare('SELECT * FROM hero_slides WHERE title = ?').get('Test Slide Promo Ramadan');
  assert(addedSlide, 'Added slide must exist in DB');
  assert.strictEqual(addedSlide.active, 1);
  assert.strictEqual(addedSlide.sort_order, 4);
  console.log(`✔ New slide added: ID ${addedSlide.id}.`);

  // 5. Toggle active status
  console.log('\n5. POST /admin/carousel/:id/toggle');
  const toggleRes = await request('POST', `/admin/carousel/${addedSlide.id}/toggle`, null, {
    'Cookie': sessionCookie
  });
  assert.strictEqual(toggleRes.statusCode, 302);
  const toggledSlide = db.prepare('SELECT * FROM hero_slides WHERE id = ?').get(addedSlide.id);
  assert.strictEqual(toggledSlide.active, 0, 'Slide must now be deactivated');
  console.log('✔ Slide successfully toggled to inactive.');

  // 6. Edit slide
  console.log('\n6. POST /admin/carousel/:id/edit');
  const editParams = new URLSearchParams({
    title: 'Updated Test Slide Title',
    caption: 'Updated caption',
    image_url: '/images/products/cheezy-corn.jpg',
    link_url: '/about',
    sort_order: '10',
    active: '1'
  }).toString();

  const editRes = await request('POST', `/admin/carousel/${addedSlide.id}/edit`, editParams, {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Cookie': sessionCookie
  });
  assert.strictEqual(editRes.statusCode, 302);
  const updatedSlide = db.prepare('SELECT * FROM hero_slides WHERE id = ?').get(addedSlide.id);
  assert.strictEqual(updatedSlide.title, 'Updated Test Slide Title');
  assert.strictEqual(updatedSlide.active, 1);
  assert.strictEqual(updatedSlide.sort_order, 10);
  console.log('✔ Slide successfully updated.');

  // 7. Delete test slide
  console.log('\n7. POST /admin/carousel/:id/delete');
  const deleteRes = await request('POST', `/admin/carousel/${addedSlide.id}/delete`, null, {
    'Cookie': sessionCookie
  });
  assert.strictEqual(deleteRes.statusCode, 302);
  const deletedSlide = db.prepare('SELECT * FROM hero_slides WHERE id = ?').get(addedSlide.id);
  assert.strictEqual(deletedSlide, undefined, 'Slide must be removed from DB');
  console.log('✔ Test slide deleted cleanly.');

  console.log('\n===========================================');
  console.log('ALL HERO CAROUSEL TESTS PASSED CLEANLY! 🎉');
  console.log('===========================================');
}

testCarouselFlow().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});
