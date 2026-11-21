const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const getDb = require('../lib/db');
const { calculateCart } = require('../lib/cart');
const { generateOrderNumber, generateToken, normalizePhone, now, formatDate, getStatusInfo } = require('../lib/helpers');

// Multer storage for payment proofs
const paymentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    let dir = path.join(__dirname, '..', 'storage', 'payments');
    if (process.env.VERCEL) {
      dir = path.join('/tmp', 'payments');
    }
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const token = req.params.token || 'proof';
    cb(null, `proof_${token.slice(0, 8)}_${Date.now()}${ext}`);
  }
});

const uploadPayment = multer({
  storage: paymentStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format file tidak didukung. Harap unggah file JPG, PNG, atau PDF.'));
    }
  }
});

// Homepage
router.get('/', (req, res) => {
  const db = getDb();
  const bestSellers = db.prepare('SELECT * FROM products WHERE available = 1 AND archived = 0 ORDER BY id ASC LIMIT 4').all();
  const bundles = db.prepare('SELECT * FROM bundles WHERE available = 1 AND archived = 0 ORDER BY id ASC LIMIT 2').all();
  const promos = db.prepare('SELECT * FROM promotions WHERE active = 1 ORDER BY id ASC').all();
  const heroSlides = db.prepare('SELECT * FROM hero_slides WHERE active = 1 ORDER BY sort_order ASC, id ASC').all();

  res.render('index', {
    title: 'NACHOAN - Good Food. Good Mood. Extra Crunch.',
    bestSellers,
    bundles,
    promos,
    heroSlides
  });
});

// Menu Catalog
router.get('/menu', (req, res) => {
  const db = getDb();
  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order ASC').all();
  const products = db.prepare('SELECT * FROM products WHERE available = 1 AND archived = 0 ORDER BY category_id ASC, id ASC').all();
  const bundles = db.prepare('SELECT * FROM bundles WHERE available = 1 AND archived = 0 ORDER BY id ASC').all();

  res.render('menu', {
    title: 'Menu NACHOAN - Nachos, Snacks & Combos',
    categories,
    products,
    bundles
  });
});

// Product Detail
router.get('/product/:slug', (req, res) => {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE slug = ? AND archived = 0').get(req.params.slug);

  if (!product) {
    return res.status(404).render('error', { title: 'Produk Tidak Ditemukan', message: 'Produk yang Anda cari tidak tersedia.' });
  }

  let spicyLevels = [];
  if (product.spicy_levels) {
    try {
      spicyLevels = JSON.parse(product.spicy_levels);
    } catch (e) {
      spicyLevels = [];
    }
  }

  const related = db.prepare('SELECT * FROM products WHERE id != ? AND category_id = ? AND available = 1 LIMIT 3')
    .all(product.id, product.category_id);

  res.render('product', {
    title: `${product.name} - NACHOAN`,
    product,
    spicyLevels,
    related
  });
});

// Bundle Detail
router.get('/bundle/:slug', (req, res) => {
  const db = getDb();
  const bundle = db.prepare('SELECT * FROM bundles WHERE slug = ? AND archived = 0').get(req.params.slug);

  if (!bundle) {
    return res.status(404).render('error', { title: 'Paket Tidak Ditemukan', message: 'Paket bundling tidak ditemukan.' });
  }

  const items = db.prepare(`
    SELECT bi.quantity, p.id, p.name, p.price, p.image, p.spicy_levels
    FROM bundle_items bi
    JOIN products p ON bi.product_id = p.id
    WHERE bi.bundle_id = ?
  `).all(bundle.id);

  res.render('bundle', {
    title: `${bundle.name} - NACHOAN`,
    bundle,
    items
  });
});

// Promo & Bundling redirect (Promo removed, only Bundling exists)
router.get('/promo', (req, res) => {
  res.redirect('/menu#bundling');
});

router.get('/bundling', (req, res) => {
  res.redirect('/menu#bundling');
});

// About Us & Cone Packaging
router.get('/about', (req, res) => {
  res.render('about', {
    title: 'Tentang NACHOAN - Kemasan Cone & Cerita Kami'
  });
});

// Checkout Page
router.get('/checkout', (req, res) => {
  const db = getDb();
  const deliveryZones = db.prepare('SELECT * FROM delivery_zones WHERE active = 1 ORDER BY id ASC').all();

  res.render('checkout', {
    title: 'Checkout Pesanan - NACHOAN',
    deliveryZones
  });
});

// Process Checkout
router.post('/checkout', (req, res) => {
  const db = getDb();
  const {
    customer_name,
    customer_phone,
    customer_email,
    method,
    address,
    delivery_zone_id,
    notes,
    items: rawItems,
    promo_code,
    idempotency_key
  } = req.body;

  // Validation
  if (!customer_name || !customer_name.trim()) {
    return res.status(400).json({ success: false, message: 'Nama lengkap wajib diisi.' });
  }

  const normalizedPhone = normalizePhone(customer_phone);
  if (!normalizedPhone || normalizedPhone.length < 9) {
    return res.status(400).json({ success: false, message: 'Nomor WhatsApp / HP tidak valid.' });
  }

  if (method === 'delivery' && (!address || !address.trim())) {
    return res.status(400).json({ success: false, message: 'Alamat pengantaran wajib diisi untuk layanan delivery.' });
  }

  // Idempotency check: if key already exists, return existing order access token
  if (idempotency_key) {
    const existing = db.prepare('SELECT access_token, order_number FROM orders WHERE idempotency_key = ?').get(idempotency_key);
    if (existing) {
      return res.json({ success: true, token: existing.access_token, orderNumber: existing.order_number, redirect: `/order/${existing.access_token}` });
    }
  }

  // Parse items if stringified JSON
  let cartItems = rawItems;
  if (typeof rawItems === 'string') {
    try {
      cartItems = JSON.parse(rawItems);
    } catch (e) {
      return res.status(400).json({ success: false, message: 'Format keranjang tidak valid.' });
    }
  }

  // Authoritative server-side cart & promo calculation
  const calc = calculateCart(cartItems, {
    promoCode: promo_code,
    method: method || 'pickup',
    zoneId: delivery_zone_id ? parseInt(delivery_zone_id, 10) : null
  });

  if (!calc.valid || calc.items.length === 0) {
    return res.status(400).json({
      success: false,
      message: calc.errors.length ? calc.errors.join(' ') : 'Keranjang Anda kosong atau produk tidak valid.'
    });
  }

  const orderNumber = generateOrderNumber();
  const accessToken = generateToken();
  const currentTime = now();

  // Begin transaction
  const insertOrder = db.transaction(() => {
    // 1. Insert order
    const orderStmt = db.prepare(`
      INSERT INTO orders (
        order_number, access_token, customer_name, customer_phone, customer_email,
        method, address, delivery_zone_id, delivery_fee, notes,
        subtotal, discount, promo_id, promo_code, total,
        payment_status, order_status, qris_version, idempotency_key, created_at, updated_at
      ) VALUES (
        @order_number, @access_token, @customer_name, @customer_phone, @customer_email,
        @method, @address, @delivery_zone_id, @delivery_fee, @notes,
        @subtotal, @discount, @promo_id, @promo_code, @total,
        'UNPAID', 'NEW', 1, @idempotency_key, @created_at, @updated_at
      )
    `);

    const orderInfo = orderStmt.run({
      order_number: orderNumber,
      access_token: accessToken,
      customer_name: customer_name.trim(),
      customer_phone: normalizedPhone,
      customer_email: customer_email ? customer_email.trim() : null,
      method: method === 'delivery' ? 'delivery' : 'pickup',
      address: method === 'delivery' ? address.trim() : null,
      delivery_zone_id: method === 'delivery' ? (calc.deliveryFee > 0 ? (delivery_zone_id || 1) : null) : null,
      delivery_fee: calc.deliveryFee,
      notes: notes ? notes.trim() : null,
      subtotal: calc.subtotal,
      discount: calc.discount,
      promo_id: calc.promo && calc.promo.valid ? calc.promo.id : null,
      promo_code: calc.promo && calc.promo.valid ? calc.promo.code : null,
      total: calc.total,
      idempotency_key: idempotency_key || null,
      created_at: currentTime,
      updated_at: currentTime
    });

    const orderId = orderInfo.lastInsertRowid;

    // 2. Insert order items
    const itemStmt = db.prepare(`
      INSERT INTO order_items (
        order_id, product_id, bundle_id, name, variant, price, quantity, is_gift, components
      ) VALUES (
        @order_id, @product_id, @bundle_id, @name, @variant, @price, @quantity, @is_gift, @components
      )
    `);

    for (const item of calc.items) {
      itemStmt.run({
        order_id: orderId,
        product_id: item.product_id || null,
        bundle_id: item.bundle_id || null,
        name: item.name,
        variant: item.variant || null,
        price: item.price,
        quantity: item.quantity,
        is_gift: item.is_gift ? 1 : 0,
        components: item.components || null
      });
    }

    // 3. Initial history log
    db.prepare(`
      INSERT INTO order_status_history (
        order_id, field, old_value, new_value, actor, reason, created_at
      ) VALUES (
        ?, 'order_status', NULL, 'NEW', 'customer', 'Pesanan berhasil dibuat oleh pelanggan', ?
      )
    `).run(orderId, currentTime);

    return { orderId, accessToken, orderNumber };
  });

  try {
    const result = insertOrder();

    // Asynchronously push to Google Sheets (Orders & OrderItems)
    if (process.env.NODE_ENV !== 'test') {
      setImmediate(() => {
        try {
          const sheets = require('../lib/sheets');
          sheets.syncOrdersToSpreadsheet();
        } catch (err) {
          console.error('Auto sync to sheets error:', err.message);
        }
      });
    }

    res.json({
      success: true,
      orderNumber: result.orderNumber,
      token: result.accessToken,
      redirect: `/order/${result.accessToken}`
    });
  } catch (err) {
    console.error('Order creation error:', err);
    res.status(500).json({ success: false, message: 'Gagal membuat pesanan. Silakan coba kembali.' });
  }
});

// Order Tracking & Payment Page
router.get('/order/:token', (req, res) => {
  const { token } = req.params;
  const db = getDb();

  const order = db.prepare('SELECT * FROM orders WHERE access_token = ?').get(token);
  if (!order) {
    return res.status(404).render('error', {
      title: 'Pesanan Tidak Ditemukan',
      message: 'Tautan pesanan tidak valid atau telah kadaluarsa.'
    });
  }

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC').all(order.id);
  const submissions = db.prepare('SELECT * FROM payment_submissions WHERE order_id = ? ORDER BY version DESC').all(order.id);
  const history = db.prepare('SELECT * FROM order_status_history WHERE order_id = ? ORDER BY id ASC').all(order.id);

  // Active QRIS asset
  const qris = db.prepare('SELECT * FROM qris_assets WHERE active = 1 ORDER BY version DESC LIMIT 1').get();

  const statusInfo = getStatusInfo(order.order_status, order.payment_status);

  res.render('order', {
    title: `Pesanan ${order.order_number} - NACHOAN`,
    order,
    items,
    submissions,
    history,
    qrisPath: qris ? qris.file_path : '/images/qris.jpg',
    statusInfo,
    formatDate
  });
});

// Upload Payment Proof
router.post('/order/:token/upload', uploadPayment.single('payment_proof'), (req, res) => {
  const { token } = req.params;
  const db = getDb();

  const order = db.prepare('SELECT * FROM orders WHERE access_token = ?').get(token);
  if (!order) {
    return res.status(404).render('error', { title: 'Pesanan Tidak Ditemukan', message: 'Pesanan tidak ditemukan.' });
  }

  if (!req.file) {
    return res.status(400).render('error', { title: 'Upload Gagal', message: 'Harap pilih file bukti transfer (JPG, PNG, atau PDF).' });
  }

  const currentTime = now();

  // Get current max version
  const lastSub = db.prepare('SELECT MAX(version) as max_v FROM payment_submissions WHERE order_id = ?').get(order.id);
  const nextVersion = (lastSub && lastSub.max_v ? lastSub.max_v : 0) + 1;

  const saveProof = db.transaction(() => {
    // 1. Insert submission
    db.prepare(`
      INSERT INTO payment_submissions (
        order_id, file_path, mime_type, file_size, version, status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      order.id,
      req.file.filename,
      req.file.mimetype,
      req.file.size,
      nextVersion,
      currentTime
    );

    // 2. Update order status to WAITING_CONFIRMATION
    db.prepare(`
      UPDATE orders 
      SET order_status = 'WAITING_CONFIRMATION', updated_at = ?
      WHERE id = ?
    `).run(currentTime, order.id);

    // 3. Log history
    db.prepare(`
      INSERT INTO order_status_history (
        order_id, field, old_value, new_value, actor, reason, created_at
      ) VALUES (
        ?, 'order_status', ?, 'WAITING_CONFIRMATION', 'customer', ?, ?
      )
    `).run(
      order.id,
      order.order_status,
      `Customer mengunggah bukti pembayaran versi #${nextVersion}`,
      currentTime
    );
  });

  try {
    saveProof();

    // Asynchronously push update to Google Sheets
    if (process.env.NODE_ENV !== 'test') {
      setImmediate(() => {
        try {
          const sheets = require('../lib/sheets');
          sheets.syncOrdersToSpreadsheet();
        } catch (err) {
          console.error('Auto sync to sheets error:', err.message);
        }
      });
    }

    res.redirect(`/order/${token}?uploaded=1`);
  } catch (err) {
    console.error('Payment upload error:', err);
    res.status(500).render('error', { title: 'Gagal Menyimpan', message: 'Terjadi kesalahan saat menyimpan bukti transfer.' });
  }
});

// Download / View Payment Proof
router.get('/order/:token/proof/:id', (req, res) => {
  const { token, id } = req.params;
  const db = getDb();

  const submission = db.prepare(`
    SELECT ps.*, o.access_token 
    FROM payment_submissions ps
    JOIN orders o ON ps.order_id = o.id
    WHERE ps.id = ?
  `).get(id);

  if (!submission) {
    return res.status(404).send('Bukti pembayaran tidak ditemukan.');
  }

  // Verify access: either matching token or admin session
  const isAdmin = req.session && req.session.admin;
  if (!isAdmin && submission.access_token !== token) {
    return res.status(403).send('Akses tidak diizinkan.');
  }

  let filePath = path.join(__dirname, '..', 'storage', 'payments', submission.file_path);
  if (process.env.VERCEL && !fs.existsSync(filePath)) {
    filePath = path.join('/tmp', 'payments', submission.file_path);
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File bukti transfer tidak ditemukan di server.');
  }

  res.setHeader('Content-Type', submission.mime_type);
  fs.createReadStream(filePath).pipe(res);
});

module.exports = router;
