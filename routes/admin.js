const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const getDb = require('../lib/db');
const { now, formatDate, getStatusInfo } = require('../lib/helpers');
const { deleteOrdersService } = require('../lib/orders');

// Multer storage for admin product, QRIS, and carousel uploads
const adminUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    let dir = path.join(__dirname, '..', 'public', 'uploads');
    if (process.env.VERCEL) {
      dir = path.join('/tmp', 'uploads');
    } else {
      if (file.fieldname === 'qris_file') {
        dir = path.join(__dirname, '..', 'public', 'images');
      } else if (file.fieldname === 'slide_image') {
        dir = path.join(__dirname, '..', 'public', 'uploads', 'carousel');
      }
    }
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.fieldname === 'qris_file') {
      cb(null, `qris_${Date.now()}${ext}`);
    } else if (file.fieldname === 'slide_image') {
      cb(null, `slide_${Date.now()}${ext}`);
    } else {
      cb(null, `prod_${Date.now()}${ext}`);
    }
  }
});

const uploadAdmin = multer({
  storage: adminUploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 }
});

// Middleware: Require Admin Authentication
function requireAuth(req, res, next) {
  if (req.session && req.session.admin) {
    return next();
  }
  if (req.xhr || req.headers.accept?.includes('json') || req.is('json')) {
    return res.status(401).json({ success: false, message: 'Sesi admin tidak valid atau telah berakhir. Silakan login kembali.' });
  }
  return res.redirect('/admin/login');
}

// Admin Login Form
router.get('/login', (req, res) => {
  if (req.session && req.session.admin) {
    return res.redirect('/admin');
  }
  res.render('admin/login', {
    title: 'Login Admin - NACHOAN',
    error: null
  });
});

// Admin Login Action
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const db = getDb();

  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.render('admin/login', {
      title: 'Login Admin - NACHOAN',
      error: 'Username atau password salah.'
    });
  }

  req.session.admin = {
    id: admin.id,
    username: admin.username,
    name: admin.name
  };

  res.redirect('/admin');
});

// Admin Logout
router.get('/logout', (req, res) => {
  if (req.session && typeof req.session.destroy === 'function') {
    req.session.destroy(() => res.redirect('/admin/login'));
  } else {
    req.session = null;
    res.redirect('/admin/login');
  }
});

// Apply auth to all subsequent routes
router.use(requireAuth);

// Dashboard
router.get('/', async (req, res) => {
  try {
    const sheets = require('../lib/sheets');
    await Promise.all([
      sheets.syncCatalogFromAppsScriptIfVercel(),
      sheets.syncOrdersFromAppsScriptIfVercel()
    ]);
  } catch (e) {}
  const db = getDb();

  // 1. Verified Revenue = sum of PAID orders ONLY
  const revRow = db.prepare(`
    SELECT COALESCE(SUM(total), 0) as verified_revenue 
    FROM orders 
    WHERE payment_status = 'PAID'
  `).get();
  const verifiedRevenue = revRow ? revRow.verified_revenue : 0;

  // 2. Pending payment verification count
  const pendingRow = db.prepare(`
    SELECT COUNT(*) as count 
    FROM orders 
    WHERE order_status = 'WAITING_CONFIRMATION'
  `).get();
  const pendingVerification = pendingRow ? pendingRow.count : 0;

  // 3. Total orders count
  const totalOrdersRow = db.prepare('SELECT COUNT(*) as count FROM orders').get();
  const totalOrders = totalOrdersRow ? totalOrdersRow.count : 0;

  // 4. Active products count
  const activeProdsRow = db.prepare('SELECT COUNT(*) as count FROM products WHERE available = 1 AND archived = 0').get();
  const activeBundlesRow = db.prepare('SELECT COUNT(*) as count FROM bundles WHERE available = 1 AND archived = 0').get();
  const activeMenuItems = (activeProdsRow ? activeProdsRow.count : 0) + (activeBundlesRow ? activeBundlesRow.count : 0);

  // 5. Recent 10 orders
  const recentOrders = db.prepare(`
    SELECT * FROM orders 
    ORDER BY id DESC LIMIT 10
  `).all();

  res.render('admin/dashboard', {
    title: 'Dashboard Admin - NACHOAN',
    verifiedRevenue,
    pendingVerification,
    totalOrders,
    activeMenuItems,
    recentOrders,
    formatDate,
    getStatusInfo
  });
});

// Orders Management
router.get('/orders', async (req, res) => {
  try {
    const sheets = require('../lib/sheets');
    await Promise.all([
      sheets.syncOrdersFromAppsScriptIfVercel(),
      sheets.syncCatalogFromAppsScriptIfVercel()
    ]);
  } catch (e) {}
  const db = getDb();
  const { status, search } = req.query;

  let query = "SELECT * FROM orders WHERE order_status != 'DELETED'";
  const params = [];

  if (status && status !== 'all') {
    if (status === 'PAID') {
      query += " AND payment_status = 'PAID'";
    } else if (status === 'UNPAID') {
      query += " AND payment_status = 'UNPAID'";
    } else {
      query += ' AND order_status = ?';
      params.push(status);
    }
  }

  if (search && search.trim()) {
    query += ' AND (order_number LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)';
    const term = `%${search.trim()}%`;
    params.push(term, term, term);
  }

  query += ' ORDER BY id DESC';

  const orders = db.prepare(query).all(...params);

  // Status counts for filters
  const counts = {
    all: db.prepare("SELECT COUNT(*) as count FROM orders WHERE order_status != 'DELETED'").get().count,
    waiting: db.prepare("SELECT COUNT(*) as count FROM orders WHERE order_status = 'WAITING_CONFIRMATION'").get().count,
    paid: db.prepare("SELECT COUNT(*) as count FROM orders WHERE payment_status = 'PAID' AND order_status != 'DELETED'").get().count,
    unpaid: db.prepare("SELECT COUNT(*) as count FROM orders WHERE payment_status = 'UNPAID' AND order_status != 'DELETED'").get().count,
    cancelled: db.prepare("SELECT COUNT(*) as count FROM orders WHERE order_status = 'CANCELLED'").get().count,
  };

  // Active products for manual order modal
  const activeProducts = db.prepare('SELECT id, name, slug, price FROM products WHERE available = 1 AND archived = 0 ORDER BY id ASC').all();

  res.render('admin/orders', {
    title: 'Kelola Pesanan - Admin NACHOAN',
    orders,
    currentStatus: status || 'all',
    currentSearch: search || '',
    counts,
    activeProducts,
    formatDate,
    getStatusInfo
  });
});

// Order Detail
router.get('/orders/:id', async (req, res) => {
  try {
    await require('../lib/sheets').syncOrdersFromAppsScriptIfVercel();
  } catch (e) {}
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);

  if (!order) {
    return res.status(404).render('error', { title: 'Pesanan Tidak Ditemukan', message: 'Pesanan tidak ditemukan.' });
  }

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC').all(order.id);
  const submissions = db.prepare('SELECT * FROM payment_submissions WHERE order_id = ? ORDER BY version DESC').all(order.id);
  const history = db.prepare('SELECT * FROM order_status_history WHERE order_id = ? ORDER BY id ASC').all(order.id);

  res.render('admin/order-detail', {
    title: `Detail Pesanan ${order.order_number} - Admin NACHOAN`,
    order,
    items,
    submissions,
    history,
    formatDate,
    getStatusInfo
  });
});

// Verify Payment (Accept / Reject)
router.post('/orders/:id/verify-payment', async (req, res) => {
  const { id } = req.params;
  const { action, reason, reference } = req.body || {};
  const db = getDb();
  const currentTime = now();
  const adminName = req.session.admin.name || req.session.admin.username;

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) {
    return res.status(404).json({ success: false, message: 'Pesanan tidak ditemukan.' });
  }

  // Get latest submission
  const latestSub = db.prepare('SELECT * FROM payment_submissions WHERE order_id = ? ORDER BY version DESC LIMIT 1').get(id);

  if (action === 'accept') {
    const approveTx = db.transaction(() => {
      // 1. Update order payment & status
      db.prepare(`
        UPDATE orders 
        SET payment_status = 'PAID', order_status = 'PAID', updated_at = ?
        WHERE id = ?
      `).run(currentTime, id);

      // 2. Update payment submission
      if (latestSub) {
        db.prepare(`
          UPDATE payment_submissions 
          SET status = 'approved', reviewer_id = ?, review_reference = ?, reviewed_at = ?
          WHERE id = ?
        `).run(req.session.admin.id, reference || null, currentTime, latestSub.id);
      }

      // 3. Log history
      db.prepare(`
        INSERT INTO order_status_history (
          order_id, field, old_value, new_value, actor, reason, created_at
        ) VALUES (
          ?, 'payment_status', ?, 'PAID', ?, ?, ?
        )
      `).run(
        id,
        order.payment_status,
        `admin (${adminName})`,
        reference ? `Pembayaran disetujui. Ref: ${reference}` : 'Pembayaran disetujui setelah diverifikasi pada rekening/QRIS merchant',
        currentTime
      );
    });

    approveTx();
    try {
      const sheets = require('../lib/sheets');
      await sheets.updateOrderStatusInAppsScript(order.order_number, 'PAID', 'PAID');
      if (!process.env.VERCEL) sheets.syncOrdersToSpreadsheet();
    } catch (e) {
      console.error('Sheets sync error:', e.message);
    }
    return res.redirect(`/admin/orders/${id}?msg=approved`);
  } else if (action === 'reject') {
    if (!reason || !reason.trim()) {
      return res.redirect(`/admin/orders/${id}?error=Alasan+penolakan+wajib+diisi.`);
    }

    const rejectTx = db.transaction(() => {
      // 1. Update order status
      db.prepare(`
        UPDATE orders 
        SET payment_status = 'REJECTED', order_status = 'REJECTED', updated_at = ?
        WHERE id = ?
      `).run(currentTime, id);

      // 2. Update payment submission
      if (latestSub) {
        db.prepare(`
          UPDATE payment_submissions 
          SET status = 'rejected', reviewer_id = ?, reviewer_note = ?, reviewed_at = ?
          WHERE id = ?
        `).run(req.session.admin.id, reason.trim(), currentTime, latestSub.id);
      }

      // 3. Log history
      db.prepare(`
        INSERT INTO order_status_history (
          order_id, field, old_value, new_value, actor, reason, created_at
        ) VALUES (
          ?, 'payment_status', ?, 'REJECTED', ?, ?, ?
        )
      `).run(
        id,
        order.payment_status,
        `admin (${adminName})`,
        `Pembayaran ditolak: ${reason.trim()}`,
        currentTime
      );
    });

    rejectTx();
    try {
      const sheets = require('../lib/sheets');
      await sheets.updateOrderStatusInAppsScript(order.order_number, 'REJECTED', 'REJECTED');
      if (!process.env.VERCEL) sheets.syncOrdersToSpreadsheet();
    } catch (e) {
      console.error('Sheets sync error:', e.message);
    }
    return res.redirect(`/admin/orders/${id}?msg=rejected`);
  }

  res.redirect(`/admin/orders/${id}`);
});

// Update Operational Order Status (PREPARING, READY, COMPLETED, CANCELLED)
router.post('/orders/:id/status', async (req, res) => {
  const { id } = req.params;
  const { order_status, note } = req.body;
  const db = getDb();
  const currentTime = now();
  const adminName = req.session.admin.name || req.session.admin.username;

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) {
    return res.status(404).send('Pesanan tidak ditemukan.');
  }

  const validStatuses = ['NEW', 'WAITING_CONFIRMATION', 'PAID', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED'];
  if (!validStatuses.includes(order_status)) {
    return res.status(400).send('Status tidak valid.');
  }

  const updateTx = db.transaction(() => {
    db.prepare('UPDATE orders SET order_status = ?, updated_at = ? WHERE id = ?')
      .run(order_status, currentTime, id);

    db.prepare(`
      INSERT INTO order_status_history (
        order_id, field, old_value, new_value, actor, reason, created_at
      ) VALUES (?, 'order_status', ?, ?, ?, ?, ?)
    `).run(
      id,
      order.order_status,
      order_status,
      `admin (${adminName})`,
      note || `Status pesanan diubah menjadi ${order_status}`,
      currentTime
    );
  });

  updateTx();
  try {
    const sheets = require('../lib/sheets');
    await sheets.updateOrderStatusInAppsScript(order.order_number, null, order_status);
    if (!process.env.VERCEL) sheets.syncOrdersToSpreadsheet();
  } catch (e) {
    console.error('Sheets sync error:', e.message);
  }
  res.redirect(`/admin/orders/${id}?msg=status_updated`);
});

// ==========================================
// BULK CRUD OPERATIONS FOR ORDERS (/admin/orders)
// ==========================================

// Bulk Update Order Status and/or Payment Status
router.post('/orders/bulk-update', async (req, res) => {
  const db = getDb();
  let { order_ids, order_numbers, order_status, payment_status } = req.body;
  const currentTime = now();
  const adminName = req.session.admin.name || req.session.admin.username;

  let rawList = order_numbers || order_ids;
  if (typeof rawList === 'string') {
    try {
      rawList = JSON.parse(rawList);
    } catch (e) {
      rawList = rawList.split(',').map(x => x.trim()).filter(Boolean);
    }
  }

  if (!Array.isArray(rawList) || rawList.length === 0) {
    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.status(400).json({ success: false, message: 'Pilih minimal satu pesanan.' });
    }
    return res.redirect('/admin/orders?error=Pilih+minimal+satu+pesanan.');
  }

  const updatedOrders = [];
  const bulkTx = db.transaction(() => {
    for (const rawId of rawList) {
      const s = String(rawId).trim();
      let existing = null;
      if (/^\d+$/.test(s)) {
        existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(parseInt(s, 10));
      }
      if (!existing) {
        existing = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(s);
      }
      if (!existing) continue;

      updatedOrders.push(existing);

      if (payment_status && payment_status.trim()) {
        const newPay = payment_status.trim();
        db.prepare(`
          UPDATE orders 
          SET payment_status = ?, 
              updated_at = ? 
          WHERE id = ?
        `).run(newPay, currentTime, existing.id);

        db.prepare(`
          INSERT INTO order_status_history (order_id, field, old_value, new_value, actor, reason, created_at)
          VALUES (?, 'payment_status', ?, ?, ?, 'Bulk update oleh admin', ?)
        `).run(existing.id, existing.payment_status, newPay, `admin (${adminName})`, currentTime);
      }

      if (order_status && order_status.trim()) {
        const newStatus = order_status.trim();
        db.prepare('UPDATE orders SET order_status = ?, updated_at = ? WHERE id = ?')
          .run(newStatus, currentTime, existing.id);

        db.prepare(`
          INSERT INTO order_status_history (order_id, field, old_value, new_value, actor, reason, created_at)
          VALUES (?, 'order_status', ?, ?, ?, 'Bulk update oleh admin', ?)
        `).run(existing.id, existing.order_status, newStatus, `admin (${adminName})`, currentTime);
      }
    }
  });

  bulkTx();

  // Asynchronously sync each updated order to Google Sheets via Apps Script
  const sheets = require('../lib/sheets');
  const payVal = payment_status && payment_status.trim() ? payment_status.trim() : null;
  const statusVal = order_status && order_status.trim() ? order_status.trim() : null;

  for (const o of updatedOrders) {
    try {
      await sheets.updateOrderStatusInAppsScript(o.order_number, payVal, statusVal);
    } catch (e) {
      console.error(`Error updating order ${o.order_number} to sheets:`, e.message);
    }
  }

  if (!process.env.VERCEL) {
    try {
      sheets.syncOrdersToSpreadsheet();
    } catch (_) {}
  }

  if (req.xhr || req.headers.accept?.includes('json')) {
    return res.json({ success: true, count: updatedOrders.length, message: `Berhasil memperbarui ${updatedOrders.length} pesanan!` });
  }
  res.redirect(`/admin/orders?msg=Berhasil+memperbarui+${updatedOrders.length}+pesanan.`);
});

// Bulk Delete Orders (via unified deleteOrdersService)
router.post('/orders/bulk-delete', async (req, res) => {
  let { order_ids, order_numbers } = req.body;
  const list = order_numbers || order_ids;

  const result = await deleteOrdersService({
    orderIdentifiers: list,
    adminUser: req.session.admin
  });

  if (req.xhr || req.headers.accept?.includes('json') || req.is('json')) {
    return res.status(result.success ? 200 : 400).json(result);
  }

  if (result.success) {
    return res.redirect(`/admin/orders?msg=${encodeURIComponent(result.message)}`);
  } else {
    return res.redirect(`/admin/orders?error=${encodeURIComponent(result.message)}`);
  }
});

// Delete All Cancelled Orders
router.post('/orders/delete-cancelled', async (req, res) => {
  const db = getDb();
  const cancelledOrders = db.prepare("SELECT order_number FROM orders WHERE order_status = 'CANCELLED'").all();
  if (cancelledOrders.length === 0) {
    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.json({ success: true, message: 'Tidak ada pesanan berstatus Dibatalkan (CANCELLED).', deletedCount: 0 });
    }
    return res.redirect('/admin/orders?msg=Tidak+ada+pesanan+berstatus+Dibatalkan.');
  }

  const list = cancelledOrders.map(o => o.order_number);
  const result = await deleteOrdersService({
    orderIdentifiers: list,
    adminUser: req.session.admin
  });

  if (req.xhr || req.headers.accept?.includes('json') || req.is('json')) {
    return res.status(result.success ? 200 : 400).json(result);
  }
  if (result.success) {
    return res.redirect(`/admin/orders?msg=${encodeURIComponent(result.message)}`);
  } else {
    return res.redirect(`/admin/orders?error=${encodeURIComponent(result.message)}`);
  }
});

// Create Order Manually from Admin
router.post('/orders/create-manual', (req, res) => {
  const db = getDb();
  const {
    customer_name,
    customer_phone,
    method,
    address,
    notes,
    payment_status = 'PAID',
    order_status = 'NEW',
    items: rawItems
  } = req.body;

  if (!customer_name || !customer_phone) {
    return res.status(400).json({ success: false, message: 'Nama dan nomor telepon pemesan wajib diisi.' });
  }

  let items = rawItems;
  if (typeof rawItems === 'string') {
    try { items = JSON.parse(rawItems); } catch (e) { items = []; }
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Pilih minimal 1 menu pesanan.' });
  }

  const { generateOrderNumber, generateToken, normalizePhone } = require('../lib/helpers');
  const currentTime = now();
  const orderNumber = generateOrderNumber();
  const accessToken = generateToken();
  const deliveryFee = method === 'delivery' ? 2000 : 0;

  let subtotal = 0;
  const processedItems = [];

  for (const it of items) {
    const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(it.product_id);
    if (!prod) continue;
    const qty = Math.max(1, parseInt(it.quantity, 10) || 1);
    const itemSub = prod.price * qty;
    subtotal += itemSub;
    processedItems.push({
      product_id: prod.id,
      name: prod.name,
      price: prod.price,
      quantity: qty
    });
  }

  const total = subtotal + deliveryFee;

  const insertTx = db.transaction(() => {
    const resOrder = db.prepare(`
      INSERT INTO orders (
        order_number, access_token, customer_name, customer_phone,
        method, address, delivery_fee, notes, subtotal, total,
        payment_status, order_status, created_at, updated_at
      ) VALUES (
        @order_number, @access_token, @customer_name, @customer_phone,
        @method, @address, @delivery_fee, @notes, @subtotal, @total,
        @payment_status, @order_status, @created_at, @updated_at
      )
    `).run({
      order_number: orderNumber,
      access_token: accessToken,
      customer_name: customer_name.trim(),
      customer_phone: normalizePhone(customer_phone),
      method: method || 'pickup',
      address: method === 'delivery' ? (address || '').trim() : null,
      delivery_fee: deliveryFee,
      notes: (notes || '').trim() || null,
      subtotal,
      total,
      payment_status,
      order_status,
      created_at: currentTime,
      updated_at: currentTime
    });

    const orderId = resOrder.lastInsertRowid;

    for (const pit of processedItems) {
      db.prepare(`
        INSERT INTO order_items (order_id, product_id, name, price, quantity)
        VALUES (?, ?, ?, ?, ?)
      `).run(orderId, pit.product_id, pit.name, pit.price, pit.quantity);
    }

    db.prepare(`
      INSERT INTO order_status_history (order_id, field, old_value, new_value, actor, reason, created_at)
      VALUES (?, 'order_status', NULL, ?, 'admin', 'Pesanan dibuat manual oleh admin', ?)
    `).run(orderId, order_status, currentTime);

    return orderId;
  });

  const newOrderId = insertTx();

  // Sync to Google Sheets
  setImmediate(async () => {
    try {
      const sheets = require('../lib/sheets');
      const orderRecord = db.prepare('SELECT * FROM orders WHERE id = ?').get(newOrderId);
      const itemRecords = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(newOrderId);
      if (orderRecord) {
        await sheets.pushOrderToAppsScript(orderRecord, itemRecords);
      }
      if (!process.env.VERCEL) {
        sheets.syncOrdersToSpreadsheet();
      }
    } catch (e) {
      console.error('Manual order sync to sheets error:', e.message);
    }
  });

  res.json({
    success: true,
    message: `Pesanan manual ${orderNumber} berhasil dibuat dan dikirim ke Google Sheets!`,
    orderId: newOrderId,
    orderNumber
  });
});

// Preview Parsed Bulk Orders from Text
router.post('/orders/preview-bulk-text', (req, res) => {
  const db = getDb();
  const { rawText } = req.body;
  const { parseBulkOrdersText } = require('../lib/orders');
  const activeProducts = db.prepare('SELECT id, name, slug, price FROM products WHERE available = 1 AND archived = 0 ORDER BY id ASC').all();
  const parsed = parseBulkOrdersText(rawText || '', activeProducts);

  const preview = parsed.map(o => {
    const deliveryFee = o.method === 'delivery' ? 2000 : 0;
    const items = o.items || [];
    const subtotal = items.reduce((sum, it) => sum + (it.price * it.quantity), 0);
    const total = subtotal + deliveryFee;
    const warnings = [];
    if (!o.customer_name) warnings.push('Nama pemesan belum terisi');
    if (!o.customer_phone) warnings.push('Nomor WA belum terisi');
    if (items.length === 0) warnings.push('Tidak ada item menu yang terdeteksi');
    if (o.method === 'delivery' && !o.address) warnings.push('Alamat delivery belum diisi');

    return {
      ...o,
      subtotal,
      delivery_fee: deliveryFee,
      total,
      isValid: warnings.length === 0,
      warnings
    };
  });

  res.json({
    success: true,
    totalParsed: preview.length,
    validCount: preview.filter(p => p.isValid).length,
    orders: preview
  });
});

// Create Bulk Orders via Text Format from Admin
router.post('/orders/create-bulk-text', (req, res) => {
  const db = getDb();
  const { rawText, orders: incomingOrders } = req.body;
  const adminName = (req.session && req.session.admin && req.session.admin.username) ? req.session.admin.username : 'admin';
  const { parseBulkOrdersText, createBulkOrdersService } = require('../lib/orders');

  let ordersToCreate = [];

  if (Array.isArray(incomingOrders) && incomingOrders.length > 0) {
    ordersToCreate = incomingOrders;
  } else if (rawText && typeof rawText === 'string') {
    const activeProducts = db.prepare('SELECT id, name, slug, price FROM products WHERE available = 1 AND archived = 0 ORDER BY id ASC').all();
    ordersToCreate = parseBulkOrdersText(rawText, activeProducts);
  }

  if (!ordersToCreate || ordersToCreate.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'Tidak ada format pesanan valid yang terdeteksi. Silakan periksa format teks masukan.'
    });
  }

  try {
    const created = createBulkOrdersService(ordersToCreate, db, adminName);
    if (created.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Gagal membuat pesanan. Pastikan setiap pesanan memiliki nama, no WhatsApp, dan menu yang valid.'
      });
    }

    res.json({
      success: true,
      message: `Berhasil membuat ${created.length} pesanan manual dan disinkronkan ke Google Sheets!`,
      count: created.length,
      orders: created
    });
  } catch (err) {
    console.error('Error in create-bulk-text:', err);
    res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan sistem saat memproses pesanan massal: ' + err.message
    });
  }
});

// Sync FROM Spreadsheet -> Website (Pull changes)
router.post('/orders/sync-from-sheets', async (req, res) => {
  try {
    const sheets = require('../lib/sheets');
    if (process.env.VERCEL || sheets.getAppsScriptUrl()) {
      await sheets.syncOrdersFromAppsScriptIfVercel(true);
      return res.json({ success: true, message: 'Sinkronisasi pesanan dari Google Sheets berhasil!' });
    } else {
      const result = sheets.pullOrdersFromSpreadsheet();
      return res.json(result);
    }
  } catch (err) {
    console.error('Sync from sheets error:', err);
    res.status(500).json({ success: false, message: 'Gagal menarik data dari Google Sheets: ' + err.message });
  }
});

// Sync TO Spreadsheet (Push all)
router.post('/orders/sync-to-sheets', (req, res) => {
  try {
    const sheets = require('../lib/sheets');
    sheets.syncAllToSpreadsheet();
    res.json({ success: true, message: 'Seluruh data berhasil disinkronkan ke Google Sheets!' });
  } catch (err) {
    console.error('Sync to sheets error:', err);
    res.status(500).json({ success: false, message: 'Gagal mengirim data ke Google Sheets: ' + err.message });
  }
});

// Reset Spreadsheet & Orders from scratch
router.post('/orders/reset-all', (req, res) => {
  try {
    const sheets = require('../lib/sheets');
    const result = sheets.resetSpreadsheet(true);
    res.json(result);
  } catch (err) {
    console.error('Reset error:', err);
    res.status(500).json({ success: false, message: 'Gagal mereset: ' + err.message });
  }
});

// Products Management
router.get('/products', async (req, res) => {
  try {
    await require('../lib/sheets').syncCatalogFromAppsScriptIfVercel();
  } catch (e) {}
  const db = getDb();
  const products = db.prepare(`
    SELECT p.*, c.name as category_name 
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.archived = 0
    ORDER BY p.category_id ASC, p.id ASC
  `).all();
  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order ASC').all();

  res.render('admin/products', {
    title: 'Kelola Menu Produk - Admin NACHOAN',
    products,
    categories
  });
});

// Create Product
router.post('/products/new', uploadAdmin.single('image_file'), async (req, res) => {
  const { name, category_id, description, price, spicy_levels, image_url } = req.body;
  const db = getDb();
  const sheets = require('../lib/sheets');
  const currentTime = now();

  let imagePath = image_url || '/images/products/beefy-nacho.jpg';
  if (req.file) {
    if (process.env.VERCEL) {
      try {
        const buf = fs.readFileSync(req.file.path);
        const up = await sheets.uploadProductImageToDrive(buf, req.file.originalname || req.file.filename, req.file.mimetype);
        if (up && up.thumbnailUrl) {
          imagePath = up.thumbnailUrl;
        } else if (req.file.size <= 35 * 1024) {
          imagePath = `data:${req.file.mimetype};base64,${buf.toString('base64')}`;
        } else {
          imagePath = `/uploads/${req.file.filename}`;
        }
      } catch (e) {
        imagePath = `/uploads/${req.file.filename}`;
      }
    } else {
      imagePath = `/uploads/${req.file.filename}`;
    }
  }

  const baseSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'menu';
  let slug = baseSlug;
  let suffix = 2;
  while (db.prepare('SELECT id FROM products WHERE slug = ?').get(slug)) {
    slug = `${baseSlug}-${suffix++}`;
  }

  let parsedSpicy = null;
  if (spicy_levels && spicy_levels.trim()) {
    parsedSpicy = JSON.stringify(spicy_levels.split(',').map(s => s.trim()).filter(Boolean));
  }

  db.prepare(`
    INSERT INTO products (
      category_id, name, slug, description, price, image, spicy_levels, available, archived, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
  `).run(parseInt(category_id, 10) || 1, name.trim(), slug, description || '', parseInt(price, 10), imagePath, parsedSpicy, currentTime, currentTime);

  try {
    sheets.invalidateCatalogCache();
    await sheets.pushProductsToAppsScript();
    if (!process.env.VERCEL) sheets.syncAllToSpreadsheet();
  } catch (e) {}

  res.redirect('/admin/products?msg=created');
});

// Edit Product
router.post('/products/:id/edit', uploadAdmin.single('image_file'), async (req, res) => {
  const { id } = req.params;
  const { name, category_id, description, price, spicy_levels, available, current_image } = req.body;
  const db = getDb();
  const sheets = require('../lib/sheets');
  const currentTime = now();

  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!existing) return res.status(404).send('Produk tidak ditemukan');

  let imagePath = existing.image;
  if (req.file) {
    if (process.env.VERCEL) {
      try {
        const buf = fs.readFileSync(req.file.path);
        const up = await sheets.uploadProductImageToDrive(buf, req.file.originalname || req.file.filename, req.file.mimetype);
        if (up && up.thumbnailUrl) {
          imagePath = up.thumbnailUrl;
        } else if (req.file.size <= 35 * 1024) {
          imagePath = `data:${req.file.mimetype};base64,${buf.toString('base64')}`;
        } else {
          imagePath = `/uploads/${req.file.filename}`;
        }
      } catch (e) {
        imagePath = `/uploads/${req.file.filename}`;
      }
    } else {
      imagePath = `/uploads/${req.file.filename}`;
    }
  } else if (current_image) {
    imagePath = current_image;
  }

  let parsedSpicy = null;
  if (spicy_levels && spicy_levels.trim()) {
    parsedSpicy = JSON.stringify(spicy_levels.split(',').map(s => s.trim()).filter(Boolean));
  }

  db.prepare(`
    UPDATE products 
    SET name = ?, category_id = ?, description = ?, price = ?, spicy_levels = ?, image = ?, available = ?, updated_at = ?
    WHERE id = ?
  `).run(
    name.trim(),
    parseInt(category_id, 10) || existing.category_id,
    description || '',
    parseInt(price, 10),
    parsedSpicy,
    imagePath,
    available !== undefined ? parseInt(available, 10) : existing.available,
    currentTime,
    id
  );

  try {
    sheets.invalidateCatalogCache();
    await sheets.pushProductsToAppsScript();
    if (!process.env.VERCEL) sheets.syncAllToSpreadsheet();
  } catch (e) {}

  res.redirect('/admin/products?msg=updated');
});

// Toggle Product Availability
router.post('/products/:id/toggle', async (req, res) => {
  const db = getDb();
  const prod = db.prepare('SELECT available FROM products WHERE id = ?').get(req.params.id);
  if (prod) {
    const nextVal = prod.available ? 0 : 1;
    db.prepare('UPDATE products SET available = ?, updated_at = ? WHERE id = ?')
      .run(nextVal, now(), req.params.id);
    try {
      const sheets = require('../lib/sheets');
      sheets.invalidateCatalogCache();
      await sheets.pushProductsToAppsScript();
    } catch (e) {}
  }
  res.redirect('/admin/products');
});

// Delete (Archive) Product
router.post('/products/:id/delete', async (req, res) => {
  const db = getDb();
  db.prepare('UPDATE products SET archived = 1, updated_at = ? WHERE id = ?')
    .run(now(), req.params.id);
  try {
    const sheets = require('../lib/sheets');
    sheets.invalidateCatalogCache();
    await sheets.pushProductsToAppsScript();
  } catch (e) {}
  res.redirect('/admin/products?msg=deleted');
});

// Bundles Management
router.get('/bundles', (req, res) => {
  const db = getDb();
  const bundles = db.prepare('SELECT * FROM bundles WHERE archived = 0 ORDER BY id ASC').all();
  const products = db.prepare('SELECT * FROM products WHERE archived = 0 ORDER BY name ASC').all();

  // Attach components to each bundle
  for (const b of bundles) {
    b.items = db.prepare(`
      SELECT bi.quantity, p.name, p.price 
      FROM bundle_items bi
      JOIN products p ON bi.product_id = p.id
      WHERE bi.bundle_id = ?
    `).all(b.id);
  }

  res.render('admin/bundles', {
    title: 'Kelola Bundling & Paket - Admin NACHOAN',
    bundles,
    products
  });
});

// Create Bundle
router.post('/bundles/new', uploadAdmin.single('bundle_image'), (req, res) => {
  const { name, description, price, compare_price, product_ids, quantities } = req.body;
  const db = getDb();
  const currentTime = now();

  let imagePath = '/images/bundles/movie-night-combo.jpg';
  if (req.file) {
    imagePath = `/uploads/${req.file.filename}`;
  }

  const baseSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'bundle';
  let slug = baseSlug;
  let suffix = 2;
  while (db.prepare('SELECT id FROM bundles WHERE slug = ?').get(slug)) {
    slug = `${baseSlug}-${suffix++}`;
  }

  const createTx = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO bundles (
        name, slug, description, price, compare_price, image, available, archived, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
    `).run(name, slug, description, parseInt(price, 10), compare_price ? parseInt(compare_price, 10) : null, imagePath, currentTime, currentTime);

    const bundleId = result.lastInsertRowid;

    if (Array.isArray(product_ids)) {
      for (let i = 0; i < product_ids.length; i++) {
        const pid = parseInt(product_ids[i], 10);
        const qty = parseInt(quantities[i], 10) || 1;
        if (pid) {
          db.prepare('INSERT INTO bundle_items (bundle_id, product_id, quantity) VALUES (?, ?, ?)').run(bundleId, pid, qty);
        }
      }
    } else if (product_ids) {
      db.prepare('INSERT INTO bundle_items (bundle_id, product_id, quantity) VALUES (?, ?, ?)')
        .run(bundleId, parseInt(product_ids, 10), parseInt(quantities, 10) || 1);
    }
  });

  createTx();

  try {
    const { syncAllToSpreadsheet } = require('../lib/sheets');
    syncAllToSpreadsheet();
  } catch (e) {}

  res.redirect('/admin/bundles?msg=created');
});

// Edit Bundle
router.post('/bundles/:id/edit', uploadAdmin.single('bundle_image'), (req, res) => {
  const { id } = req.params;
  const { name, description, price, compare_price, available, product_ids, quantities } = req.body;
  const db = getDb();
  const currentTime = now();

  const existing = db.prepare('SELECT * FROM bundles WHERE id = ?').get(id);
  if (!existing) return res.status(404).send('Bundle tidak ditemukan');

  let imagePath = existing.image;
  if (req.file) {
    imagePath = `/uploads/${req.file.filename}`;
  }

  const editTx = db.transaction(() => {
    db.prepare(`
      UPDATE bundles
      SET name = ?, description = ?, price = ?, compare_price = ?, image = ?, available = ?, updated_at = ?
      WHERE id = ?
    `).run(
      name,
      description,
      parseInt(price, 10),
      compare_price ? parseInt(compare_price, 10) : null,
      imagePath,
      available !== undefined ? parseInt(available, 10) : existing.available,
      currentTime,
      id
    );

    // Re-insert bundle items
    db.prepare('DELETE FROM bundle_items WHERE bundle_id = ?').run(id);
    if (Array.isArray(product_ids)) {
      for (let i = 0; i < product_ids.length; i++) {
        const pid = parseInt(product_ids[i], 10);
        const qty = parseInt(quantities[i], 10) || 1;
        if (pid) {
          db.prepare('INSERT INTO bundle_items (bundle_id, product_id, quantity) VALUES (?, ?, ?)').run(id, pid, qty);
        }
      }
    } else if (product_ids) {
      db.prepare('INSERT INTO bundle_items (bundle_id, product_id, quantity) VALUES (?, ?, ?)')
        .run(id, parseInt(product_ids, 10), parseInt(quantities, 10) || 1);
    }
  });

  editTx();

  try {
    const { syncAllToSpreadsheet } = require('../lib/sheets');
    syncAllToSpreadsheet();
  } catch (e) {}

  res.redirect('/admin/bundles?msg=updated');
});

// Toggle Bundle Availability
router.post('/bundles/:id/toggle', (req, res) => {
  const db = getDb();
  const bundle = db.prepare('SELECT available FROM bundles WHERE id = ?').get(req.params.id);
  if (bundle) {
    db.prepare('UPDATE bundles SET available = ?, updated_at = ? WHERE id = ?')
      .run(bundle.available ? 0 : 1, now(), req.params.id);
  }
  res.redirect('/admin/bundles');
});

// Delete Bundle (Archive)
router.post('/bundles/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE bundles SET archived = 1, available = 0, updated_at = ? WHERE id = ?')
    .run(now(), req.params.id);
  try {
    const { syncAllToSpreadsheet } = require('../lib/sheets');
    syncAllToSpreadsheet();
  } catch (e) {}
  res.redirect('/admin/bundles?msg=deleted');
});

// Promos Management
router.get('/promos', (req, res) => {
  const db = getDb();
  const promos = db.prepare('SELECT * FROM promotions ORDER BY id ASC').all();
  const products = db.prepare('SELECT * FROM products WHERE archived = 0 ORDER BY name ASC').all();

  res.render('admin/promos', {
    title: 'Kelola Promo & Diskon - Admin NACHOAN',
    promos,
    products
  });
});

// Create Promo
router.post('/promos/new', (req, res) => {
  const { code, type, value, gift_product_id, min_purchase, description } = req.body;
  const db = getDb();
  const currentTime = now();

  db.prepare(`
    INSERT INTO promotions (
      code, type, value, gift_product_id, min_purchase, active, description, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    code.trim().toUpperCase(),
    type,
    value ? parseInt(value, 10) : 0,
    gift_product_id ? parseInt(gift_product_id, 10) : null,
    min_purchase ? parseInt(min_purchase, 10) : 0,
    description,
    currentTime,
    currentTime
  );

  try {
    const { syncAllToSpreadsheet } = require('../lib/sheets');
    syncAllToSpreadsheet();
  } catch (e) {}

  res.redirect('/admin/promos?msg=created');
});

// Edit Promo
router.post('/promos/:id/edit', (req, res) => {
  const { id } = req.params;
  const { code, type, value, gift_product_id, min_purchase, description, active } = req.body;
  const db = getDb();
  const currentTime = now();

  db.prepare(`
    UPDATE promotions
    SET code = ?, type = ?, value = ?, gift_product_id = ?, min_purchase = ?, description = ?, active = ?, updated_at = ?
    WHERE id = ?
  `).run(
    code.trim().toUpperCase(),
    type,
    value ? parseInt(value, 10) : 0,
    gift_product_id ? parseInt(gift_product_id, 10) : null,
    min_purchase ? parseInt(min_purchase, 10) : 0,
    description,
    active !== undefined ? parseInt(active, 10) : 1,
    currentTime,
    id
  );

  try {
    const { syncAllToSpreadsheet } = require('../lib/sheets');
    syncAllToSpreadsheet();
  } catch (e) {}

  res.redirect('/admin/promos?msg=updated');
});

// Toggle Promo Active
router.post('/promos/:id/toggle', (req, res) => {
  const db = getDb();
  const promo = db.prepare('SELECT active FROM promotions WHERE id = ?').get(req.params.id);
  if (promo) {
    db.prepare('UPDATE promotions SET active = ?, updated_at = ? WHERE id = ?')
      .run(promo.active ? 0 : 1, now(), req.params.id);
  }
  res.redirect('/admin/promos');
});

// Delete Promo
router.post('/promos/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM promotions WHERE id = ?').run(req.params.id);
  try {
    const { syncAllToSpreadsheet } = require('../lib/sheets');
    syncAllToSpreadsheet();
  } catch (e) {}
  res.redirect('/admin/promos?msg=deleted');
});

// Store Settings & QRIS
router.get('/settings', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM store_settings').all();
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;

  const currentQris = db.prepare('SELECT * FROM qris_assets WHERE active = 1 ORDER BY version DESC LIMIT 1').get();
  const deliveryZone = db.prepare('SELECT * FROM delivery_zones WHERE id = 1').get();

  res.render('admin/settings', {
    title: 'Pengaturan Toko & QRIS - Admin NACHOAN',
    settings,
    currentQris,
    deliveryZone
  });
});

// Save Store Settings
router.post('/settings', (req, res) => {
  const { store_name, address, phone, hours, instagram, delivery_fee, apps_script_url } = req.body;
  const db = getDb();

  const updateTx = db.transaction(() => {
    const upsert = db.prepare('INSERT OR REPLACE INTO store_settings (key, value) VALUES (?, ?)');
    upsert.run('store_name', store_name);
    upsert.run('address', address);
    upsert.run('phone', phone);
    upsert.run('hours', hours);
    upsert.run('instagram', instagram);
    if (apps_script_url !== undefined) {
      upsert.run('apps_script_url', apps_script_url.trim());
    }

    if (delivery_fee) {
      db.prepare('UPDATE delivery_zones SET fee = ? WHERE id = 1').run(parseInt(delivery_fee, 10));
    }
  });

  updateTx();
  res.redirect('/admin/settings?msg=saved');
});

// Trigger Manual Sync to Google Sheets
router.post('/settings/sync-sheets', (req, res) => {
  try {
    const { syncAllToSpreadsheet } = require('../lib/sheets');
    syncAllToSpreadsheet();
    res.redirect('/admin/settings?msg=synced');
  } catch (err) {
    res.redirect('/admin/settings?error=' + encodeURIComponent(err.message));
  }
});

// Upload New QRIS
router.post('/settings/qris', uploadAdmin.single('qris_file'), (req, res) => {
  if (!req.file) {
    return res.redirect('/admin/settings?error=Pilih+file+gambar+QRIS+terlebih+dahulu.');
  }

  const db = getDb();
  const currentTime = now();
  const relativePath = `/images/${req.file.filename}`;

  const qrisTx = db.transaction(() => {
    // 1. Deactivate all existing QRIS
    db.prepare('UPDATE qris_assets SET active = 0').run();

    // 2. Get last version
    const lastRow = db.prepare('SELECT MAX(version) as max_v FROM qris_assets').get();
    const nextVer = (lastRow && lastRow.max_v ? lastRow.max_v : 0) + 1;

    // 3. Insert new QRIS asset
    db.prepare(`
      INSERT INTO qris_assets (file_path, version, active, created_at)
      VALUES (?, ?, 1, ?)
    `).run(relativePath, nextVer, currentTime);
  });

  qrisTx();
  res.redirect('/admin/settings?msg=qris_updated');
});

// --- Hero Carousel Management ---
// List all slides
router.get('/carousel', (req, res) => {
  const db = getDb();
  const slides = db.prepare('SELECT * FROM hero_slides ORDER BY sort_order ASC, id ASC').all();
  const activeCount = slides.filter(s => s.active === 1).length;

  res.render('admin/carousel', {
    title: 'Kelola Hero Carousel - Admin NACHOAN',
    path: '/admin/carousel',
    slides,
    activeCount,
    msg: req.query.msg,
    error: req.query.error
  });
});

// Add new slide
router.post('/carousel/add', uploadAdmin.single('slide_image'), (req, res) => {
  const db = getDb();
  const { title, caption, link_url, sort_order, active, image_url } = req.body;

  let finalImage = '';
  if (req.file) {
    finalImage = `/uploads/carousel/${req.file.filename}`;
  } else if (image_url && image_url.trim()) {
    finalImage = image_url.trim();
  }

  if (!finalImage) {
    return res.redirect('/admin/carousel?error=Harap+unggah+foto+atau+pilih+gambar+yang+tersedia.');
  }

  const timestamp = now();
  const sort = parseInt(sort_order, 10) || 0;
  const isActive = active === '1' || active === 'on' || active === 1 ? 1 : 0;

  db.prepare(`
    INSERT INTO hero_slides (title, caption, image_url, link_url, sort_order, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    title ? title.trim() : '',
    caption ? caption.trim() : '',
    finalImage,
    link_url ? link_url.trim() : '',
    sort,
    isActive,
    timestamp,
    timestamp
  );

  res.redirect('/admin/carousel?msg=added');
});

// Edit slide
router.post('/carousel/:id/edit', uploadAdmin.single('slide_image'), (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const { title, caption, link_url, sort_order, active, image_url } = req.body;

  const existing = db.prepare('SELECT * FROM hero_slides WHERE id = ?').get(id);
  if (!existing) {
    return res.redirect('/admin/carousel?error=Slide+tidak+ditemukan.');
  }

  let finalImage = existing.image_url;
  if (req.file) {
    // If there was an old uploaded file in /uploads/carousel/, remove it safely
    if (existing.image_url && existing.image_url.startsWith('/uploads/carousel/')) {
      const oldPath = path.join(__dirname, '..', 'public', existing.image_url);
      if (fs.existsSync(oldPath)) {
        try { fs.unlinkSync(oldPath); } catch (e) { console.error('Failed to unlink old slide:', e); }
      }
    }
    finalImage = `/uploads/carousel/${req.file.filename}`;
  } else if (image_url && image_url.trim()) {
    finalImage = image_url.trim();
  }

  const timestamp = now();
  const sort = parseInt(sort_order, 10) || 0;
  const isActive = active === '1' || active === 'on' || active === 1 ? 1 : 0;

  db.prepare(`
    UPDATE hero_slides
    SET title = ?, caption = ?, image_url = ?, link_url = ?, sort_order = ?, active = ?, updated_at = ?
    WHERE id = ?
  `).run(
    title ? title.trim() : '',
    caption ? caption.trim() : '',
    finalImage,
    link_url ? link_url.trim() : '',
    sort,
    isActive,
    timestamp,
    id
  );

  res.redirect('/admin/carousel?msg=updated');
});

// Toggle slide active status
router.post('/carousel/:id/toggle', (req, res) => {
  const db = getDb();
  const { id } = req.params;

  const existing = db.prepare('SELECT * FROM hero_slides WHERE id = ?').get(id);
  if (!existing) {
    return res.redirect('/admin/carousel?error=Slide+tidak+ditemukan.');
  }

  const newStatus = existing.active === 1 ? 0 : 1;
  db.prepare('UPDATE hero_slides SET active = ?, updated_at = ? WHERE id = ?')
    .run(newStatus, now(), id);

  res.redirect('/admin/carousel?msg=toggled');
});

// Delete slide
router.post('/carousel/:id/delete', (req, res) => {
  const db = getDb();
  const { id } = req.params;

  const existing = db.prepare('SELECT * FROM hero_slides WHERE id = ?').get(id);
  if (existing) {
    if (existing.image_url && existing.image_url.startsWith('/uploads/carousel/')) {
      const filePath = path.join(__dirname, '..', 'public', existing.image_url);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) { console.error('Failed to unlink slide:', e); }
      }
    }
    db.prepare('DELETE FROM hero_slides WHERE id = ?').run(id);
  }

  res.redirect('/admin/carousel?msg=deleted');
});

// Delete Order (Single, via unified deleteOrdersService)
router.post('/orders/:id/delete', async (req, res) => {
  const { id } = req.params;
  const result = await deleteOrdersService({
    orderIdentifiers: [id],
    adminUser: req.session.admin
  });

  if (req.xhr || req.headers.accept?.includes('json') || req.is('json')) {
    return res.status(result.success ? 200 : (result.notFoundCount > 0 ? 404 : 400)).json(result);
  }

  if (result.success) {
    return res.redirect(`/admin/orders?msg=${encodeURIComponent(result.message)}`);
  } else {
    return res.redirect(`/admin/orders?error=${encodeURIComponent(result.message)}`);
  }
});

module.exports = router;