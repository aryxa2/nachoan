const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const getDb = require('./db');
const { now, formatDate } = require('./helpers');

const SPREADSHEET_ID = '1YDenYpVKZVnhv5jBxp4iMdxxLMgHGOSTn3qjkBmEmJ8';
const TMP_DIR = process.env.VERCEL
  ? path.join('/tmp', 'csv_export')
  : path.join(__dirname, '..', 'storage', 'csv_export');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

/**
 * Standard RFC 4180 CSV serializer
 */
function toCSV(headers, rows) {
  const escapeCol = (val) => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };
  const headerLine = headers.map(escapeCol).join(',');
  const rowLines = rows.map(r => headers.map(h => escapeCol(r[h])).join(','));
  return [headerLine, ...rowLines].join('\n');
}

/**
 * Robust CSV parser for reading Sheets exports
 */
function parseCSV(text) {
  const lines = [];
  let row = [];
  let inQuotes = false;
  let current = '';

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      row.push(current.trim());
      current = '';
    } else if ((c === '\r' || c === '\n') && !inQuotes) {
      if (c === '\r' && next === '\n') i++;
      row.push(current.trim());
      if (row.some(cell => cell.length > 0)) lines.push(row);
      row = [];
      current = '';
    } else {
      current += c;
    }
  }
  if (current.length > 0 || row.length > 0) {
    row.push(current.trim());
    if (row.some(cell => cell.length > 0)) lines.push(row);
  }

  if (lines.length < 2) return [];
  const headers = lines[0].map(h => h.replace(/^"|"$/g, '').trim());
  return lines.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, idx) => {
      let val = r[idx] !== undefined ? r[idx] : '';
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      obj[h] = val;
    });
    return obj;
  });
}

/**
 * Helper to import CSV to Google Sheets via gsheets CLI
 */
function importCSVToSheet(sheetName, csvFile) {
  try {
    // Clear old contents first so no orphaned trailing rows remain
    try {
      execSync(`gsheets mutate clear ${SPREADSHEET_ID} "${sheetName}!A1:Z1000"`, { stdio: 'pipe' });
    } catch (clearErr) {
      // Ignore if range is already empty
    }

    execSync(`gsheets mutate import-csv ${SPREADSHEET_ID} "${csvFile}" --sheet "${sheetName}"`, { stdio: 'pipe' });
    return true;
  } catch (err) {
    console.error(`Error importing CSV to sheet ${sheetName}:`, err.message);
    return false;
  }
}

/**
 * Helper to export sheet from Google Sheets to CSV via gsheets CLI (with curl fallback for Vercel)
 */
function exportSheetToCSV(sheetName, outputFile) {
  try {
    execSync(`gsheets readonly export ${SPREADSHEET_ID} "${outputFile}" --sheet "${sheetName}" --format csv`, { stdio: 'pipe' });
    return true;
  } catch (err) {
    // Fallback: fetch directly from Google Sheets public visualization endpoint (works on Vercel and any environment without gsheets CLI)
    try {
      const curlCmd = `curl -sL "https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}" -o "${outputFile}"`;
      execSync(curlCmd, { stdio: 'pipe' });
      return fs.existsSync(outputFile) && fs.statSync(outputFile).size > 0;
    } catch (curlErr) {
      console.error(`Error exporting sheet ${sheetName}:`, err.message);
      return false;
    }
  }
}

// ==========================================
// DATA FORMATTERS WITH TIDY INDONESIAN HEADERS
// ==========================================

function getOrdersSheetData() {
  const db = getDb();
  const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();

  return orders.map(o => {
    const items = db.prepare('SELECT name, quantity, price FROM order_items WHERE order_id = ?').all(o.id);
    const itemSummary = items.map(i => `${i.quantity}x ${i.name}`).join(', ');
    const latestProof = db.prepare('SELECT drive_url FROM payment_submissions WHERE order_id = ? ORDER BY version DESC LIMIT 1').get(o.id);

    return {
      'No Pesanan': o.order_number,
      'Waktu Pemesanan': o.created_at ? o.created_at.replace('T', ' ') : '',
      'Nama Pelanggan': o.customer_name,
      'Nomor WhatsApp': o.customer_phone,
      'Metode': o.method === 'delivery' ? 'Delivery' : 'Ambil di Pick Up Point',
      'Zona Pengiriman': o.method === 'delivery' ? 'Diluar Telkom' : '-',
      'Alamat Pengantaran': o.address || '-',
      'Ringkasan Menu': itemSummary,
      'Subtotal (Rp)': o.subtotal,
      'Ongkir (Rp)': o.delivery_fee,
      'Total Pembayaran (Rp)': o.total,
      'Status Pembayaran': o.payment_status,
      'Status Pesanan': o.order_status,
      'Catatan Pemesan': o.notes || '-',
      'Terakhir Diperbarui': o.updated_at ? o.updated_at.replace('T', ' ') : '',
      'Token Akses': o.access_token,
      'Bukti Pembayaran': (latestProof && latestProof.drive_url) ? latestProof.drive_url : '-',
      'Kode Referral': o.referral_code || '-'
    };
  });
}

function getOrderItemsSheetData() {
  const db = getDb();
  const items = db.prepare(`
    SELECT oi.id, o.order_number, oi.name, oi.price, oi.quantity, (oi.price * oi.quantity) as subtotal, oi.variant
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    ORDER BY oi.id DESC
  `).all();

  return items.map(i => ({
    'Item ID': i.id,
    'No Pesanan': i.order_number,
    'Nama Menu': i.name,
    'Harga Satuan (Rp)': i.price,
    'Jumlah': i.quantity,
    'Subtotal (Rp)': i.subtotal,
    'Catatan / Varian': i.variant || '-'
  }));
}

function getProductsSheetData() {
  const db = getDb();
  const products = db.prepare(`
    SELECT p.id, p.name, p.price, COALESCE(c.name, '') as category_name, p.available, p.description, p.image
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.archived = 0
    ORDER BY p.id ASC
  `).all();

  return products.map(p => ({
    'ID': p.id,
    'Nama Menu': p.name,
    'Harga (Rp)': p.price,
    'Kategori': p.category_name,
    'Status Ketersediaan': p.available === 1 ? 'Tersedia' : 'Habis',
    'Deskripsi': p.description,
    'File Gambar': p.image
  }));
}

function getBundlesSheetData() {
  const db = getDb();
  const bundles = db.prepare('SELECT * FROM bundles WHERE archived = 0 ORDER BY id ASC').all();

  return bundles.map(b => {
    const items = db.prepare(`
      SELECT bi.quantity, p.name 
      FROM bundle_items bi 
      JOIN products p ON bi.product_id = p.id 
      WHERE bi.bundle_id = ?
    `).all(b.id);
    const compStr = items.map(it => `${it.quantity}x ${it.name}`).join(' + ');

    return {
      'ID': b.id,
      'Nama Paket': b.name,
      'Harga Paket (Rp)': b.price,
      'Harga Coret (Rp)': b.compare_price || '-',
      'Komposisi Menu': compStr,
      'Status Ketersediaan': b.available === 1 ? 'Tersedia' : 'Coming Soon',
      'Deskripsi': b.description
    };
  });
}

function getDeliveryZonesSheetData() {
  const db = getDb();
  const zones = db.prepare('SELECT * FROM delivery_zones ORDER BY id ASC').all();

  return zones.map(z => ({
    'ID': z.id,
    'Nama Zona': z.name,
    'Tarif Ongkir (Rp)': z.fee,
    'Status': z.active === 1 ? 'Aktif' : 'Nonaktif'
  }));
}

function getStoreSettingsSheetData() {
  const db = getDb();
  const settings = db.prepare('SELECT key, value FROM store_settings ORDER BY key ASC').all();

  const labels = {
    'store_name': 'Nama Brand Toko',
    'address': 'Alamat Outlet NACHOAN',
    'phone': 'Nomor WhatsApp Pemesanan',
    'hours': 'Jam Operasional Toko',
    'instagram': 'Akun Media Sosial Instagram',
    'demo_mode': 'Mode Demo / Simulasi',
    'apps_script_url': 'URL Web App Google Apps Script'
  };

  return settings.map(s => ({
    'Parameter': s.key,
    'Nilai': s.value,
    'Keterangan': labels[s.key] || s.key
  }));
}

// ==========================================
// SYNC ACTIONS: WEBSITE -> SPREADSHEET
// ==========================================

/**
 * Pushes orders and order items to Google Sheets
 */
function syncOrdersToSpreadsheet() {
  const ordersData = getOrdersSheetData();
  const orderHeaders = [
    'No Pesanan', 'Waktu Pemesanan', 'Nama Pelanggan', 'Nomor WhatsApp', 'Metode',
    'Zona Pengiriman', 'Alamat Pengantaran', 'Ringkasan Menu', 'Subtotal (Rp)',
    'Ongkir (Rp)', 'Total Pembayaran (Rp)', 'Status Pembayaran', 'Status Pesanan',
    'Catatan Pemesan', 'Terakhir Diperbarui', 'Token Akses', 'Bukti Pembayaran',
    'Kode Referral'
  ];
  const ordersCSV = toCSV(orderHeaders, ordersData);
  const ordersFile = path.join(TMP_DIR, 'clean_orders.csv');
  fs.writeFileSync(ordersFile, ordersCSV, 'utf8');
  const ok1 = importCSVToSheet('Orders', ordersFile);

  const itemsData = getOrderItemsSheetData();
  const itemHeaders = ['Item ID', 'No Pesanan', 'Nama Menu', 'Harga Satuan (Rp)', 'Jumlah', 'Subtotal (Rp)', 'Catatan / Varian'];
  const itemsCSV = toCSV(itemHeaders, itemsData);
  const itemsFile = path.join(TMP_DIR, 'clean_order_items.csv');
  fs.writeFileSync(itemsFile, itemsCSV, 'utf8');
  const ok2 = importCSVToSheet('OrderItems', itemsFile);

  return ok1 && ok2;
}

/**
 * Full sync of all sheets from database to Google Sheets
 */
function syncAllToSpreadsheet() {
  // 1. Orders & Items
  syncOrdersToSpreadsheet();

  // 2. Products
  const prodData = getProductsSheetData();
  const prodHeaders = ['ID', 'Nama Menu', 'Harga (Rp)', 'Kategori', 'Status Ketersediaan', 'Deskripsi', 'File Gambar'];
  const prodFile = path.join(TMP_DIR, 'clean_products.csv');
  fs.writeFileSync(prodFile, toCSV(prodHeaders, prodData), 'utf8');
  importCSVToSheet('Products', prodFile);

  // 3. Bundles
  const bData = getBundlesSheetData();
  const bHeaders = ['ID', 'Nama Paket', 'Harga Paket (Rp)', 'Harga Coret (Rp)', 'Komposisi Menu', 'Status Ketersediaan', 'Deskripsi'];
  const bFile = path.join(TMP_DIR, 'clean_bundles.csv');
  fs.writeFileSync(bFile, toCSV(bHeaders, bData), 'utf8');
  importCSVToSheet('Bundles', bFile);

  // 4. DeliveryZones
  const dzData = getDeliveryZonesSheetData();
  const dzHeaders = ['ID', 'Nama Zona', 'Tarif Ongkir (Rp)', 'Status'];
  const dzFile = path.join(TMP_DIR, 'clean_delivery_zones.csv');
  fs.writeFileSync(dzFile, toCSV(dzHeaders, dzData), 'utf8');
  importCSVToSheet('DeliveryZones', dzFile);

  // 5. StoreSettings
  const setHeaders = ['Parameter', 'Nilai', 'Keterangan'];
  const setFile = path.join(TMP_DIR, 'clean_store_settings.csv');
  fs.writeFileSync(setFile, toCSV(setHeaders, getStoreSettingsSheetData()), 'utf8');
  importCSVToSheet('StoreSettings', setFile);

  return true;
}

// ==========================================
// SYNC ACTION: SPREADSHEET -> WEBSITE (TWO-WAY)
// ==========================================

/**
 * Pulls changes made directly in Google Sheets Orders tab into local SQLite database
 */
function pullOrdersFromSpreadsheet() {
  const exportFile = path.join(TMP_DIR, 'pulled_orders.csv');
  const success = exportSheetToCSV('Orders', exportFile);
  if (!success || !fs.existsSync(exportFile)) {
    return { success: false, message: 'Gagal mengekspor data dari Google Sheets.' };
  }

  const csvContent = fs.readFileSync(exportFile, 'utf8');
  const rows = parseCSV(csvContent);

  if (rows.length === 0) {
    return { success: true, updatedCount: 0, message: 'Tidak ada data pesanan di spreadsheet.' };
  }

  const db = getDb();
  let updatedCount = 0;
  const currentTime = now();

  const updateStmt = db.prepare(`
    UPDATE orders
    SET payment_status = @payment_status,
        order_status = @order_status,
        notes = @notes,
        updated_at = @current_time
    WHERE order_number = @order_number
  `);

  const historyStmt = db.prepare(`
    INSERT INTO order_status_history (order_id, field, old_value, new_value, actor, reason, created_at)
    VALUES (@order_id, @field, @old_value, @new_value, 'google_sheets_sync', @reason, @created_at)
  `);

  const syncTx = db.transaction(() => {
    for (const r of rows) {
      const orderNum = (r['No Pesanan'] || r['order_number'] || '').trim();
      if (!orderNum) continue;

      const paymentStatus = String(r['Status Pembayaran'] || r.payment_status || '').trim().toUpperCase();
      const orderStatus = String(r['Status Pesanan'] || r.order_status || '').trim().toUpperCase();

      // Permanent deletion marker from Google Sheets
      if (paymentStatus === 'DELETED' || orderStatus === 'DELETED') {
        const existing = db.prepare('SELECT id, access_token FROM orders WHERE order_number = ?').get(orderNum);
        if (existing) {
          db.prepare('DELETE FROM order_items WHERE order_id = ?').run(existing.id);
          db.prepare('DELETE FROM payment_submissions WHERE order_id = ?').run(existing.id);
          db.prepare('DELETE FROM order_status_history WHERE order_id = ?').run(existing.id);
          db.prepare('DELETE FROM orders WHERE id = ?').run(existing.id);
        }
        const accessToken = String(r['Token Akses'] || r.access_token || '').trim();
        const token = (accessToken && !accessToken.startsWith('sync_')) ? accessToken : (existing ? existing.access_token : null);
        db.prepare('INSERT OR REPLACE INTO deleted_orders (order_number, access_token, deleted_at) VALUES (?, ?, ?)')
          .run(orderNum, token, currentTime);
        continue;
      }

      // Guard: do not re-insert if already marked deleted locally
      const isAlreadyDeleted = db.prepare('SELECT 1 FROM deleted_orders WHERE order_number = ?').get(orderNum);
      if (isAlreadyDeleted) {
        continue;
      }

      const existing = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(orderNum);
      if (!existing) {
        // Insert new order pasted/imported from external spreadsheet
        const customerName = String(r['Nama Pelanggan'] || r.customer_name || 'Pelanggan').trim();
        const customerPhone = String(r['Nomor WhatsApp'] || r.customer_phone || '').trim();
        const methodRaw = String(r['Metode'] || r.method || '').toLowerCase();
        const method = methodRaw.includes('delivery') ? 'delivery' : 'pickup';
        const address = String(r['Alamat Pengantaran'] || r.address || '').trim();
        const subtotal = parseInt(r['Subtotal (Rp)'] || r.subtotal, 10) || 0;
        const deliveryFee = parseInt(r['Ongkir (Rp)'] || r.delivery_fee, 10) || 0;
        const total = parseInt(r['Total Pembayaran (Rp)'] || r.total, 10) || (subtotal + deliveryFee);
        const paymentStatus = String(r['Status Pembayaran'] || r.payment_status || 'PAID').trim().toUpperCase();
        const orderStatus = String(r['Status Pesanan'] || r.order_status || 'COMPLETED').trim().toUpperCase();
        const notes = String(r['Catatan Pemesan'] || r.notes || '').trim();
        const accessToken = String(r['Token Akses'] || r.access_token || '').trim() || `sync_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const createdAt = String(r['Waktu Pemesanan'] || r.created_at || currentTime).trim();
        const updatedAt = String(r['Terakhir Diperbarui'] || r.updated_at || currentTime).trim();

        const insertRes = db.prepare(`
          INSERT INTO orders (
            order_number, access_token, customer_name, customer_phone,
            method, address, delivery_fee, notes, subtotal, total,
            payment_status, order_status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          orderNum, finalAccessToken, customerName, customerPhone,
          method, address === '-' ? null : address, deliveryFee, notes === '-' ? null : notes,
          subtotal, total, paymentStatus, orderStatus, createdAt, updatedAt
        );
        const newOrderId = insertRes.lastInsertRowid;

        const menuSummary = String(r['Ringkasan Menu'] || r.summary || '').trim();
        if (menuSummary && menuSummary !== '-') {
          const parts = menuSummary.split(',');
          for (const part of parts) {
            const m = part.trim().match(/^(\d+)x\s*(.+)$/i);
            const qty = m ? parseInt(m[1], 10) : 1;
            const name = m ? m[2].trim() : part.trim();
            db.prepare(`
              INSERT INTO order_items (order_id, name, price, quantity)
              VALUES (?, ?, ?, ?)
            `).run(newOrderId, name, 0, qty);
          }
        }

        updatedCount++;
        continue;
      }

      const sheetPayStatus = (r['Status Pembayaran'] || r['payment_status'] || existing.payment_status).trim().toUpperCase();
      const sheetOrderStatus = (r['Status Pesanan'] || r['order_status'] || existing.order_status).trim().toUpperCase();
      const sheetNotes = (r['Catatan Pemesan'] || r['Catatan'] || r['notes'] || existing.notes || '').trim();

      // Check for changes
      const payChanged = sheetPayStatus !== existing.payment_status;
      const orderChanged = sheetOrderStatus !== existing.order_status;
      const notesChanged = sheetNotes !== (existing.notes || '');

      if (payChanged || orderChanged || notesChanged) {
        updateStmt.run({
          payment_status: sheetPayStatus,
          order_status: sheetOrderStatus,
          notes: sheetNotes,
          current_time: currentTime,
          order_number: orderNum
        });

        if (payChanged) {
          historyStmt.run({
            order_id: existing.id,
            field: 'payment_status',
            old_value: existing.payment_status,
            new_value: sheetPayStatus,
            reason: 'Sinkronisasi status pembayaran dari Google Sheets',
            created_at: currentTime
          });
        }

        if (orderChanged) {
          historyStmt.run({
            order_id: existing.id,
            field: 'order_status',
            old_value: existing.order_status,
            new_value: sheetOrderStatus,
            reason: 'Sinkronisasi status operasional pesanan dari Google Sheets',
            created_at: currentTime
          });
        }

        updatedCount++;
      }
    }
  });

  syncTx();

  return {
    success: true,
    updatedCount,
    totalRows: rows.length,
    message: `Berhasil memeriksa ${rows.length} pesanan dari Google Sheets, ${updatedCount} diperbarui di website.`
  };
}

/**
 * Resets the spreadsheet and database orders from scratch
 */
function resetSpreadsheet(cleanDbOrders = true) {
  const db = getDb();

  if (cleanDbOrders) {
    db.prepare('DELETE FROM order_status_history').run();
    db.prepare('DELETE FROM payment_submissions').run();
    db.prepare('DELETE FROM order_items').run();
    db.prepare('DELETE FROM orders').run();
    console.log('Database orders wiped clean for fresh start.');
  }

  // Sync fresh clean structure to all sheets
  syncAllToSpreadsheet();
  return { success: true, message: 'Spreadsheet berhasil di-reset dengan kolom rapi dan siap digunakan!' };
}

/**
 * Get Apps Script Web App URL from store_settings
 */
function getAppsScriptUrl() {
  const db = getDb();
  const row = db.prepare("SELECT value FROM store_settings WHERE key = 'apps_script_url'").get();
  return row ? row.value : (process.env.APPS_SCRIPT_URL || '');
}

/**
 * Save Apps Script Web App URL to store_settings
 */
function setAppsScriptUrl(url) {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO store_settings (key, value) VALUES ('apps_script_url', ?)").run(url.trim());
}

let _mockAppsScriptHandler = null;
function setMockAppsScriptHandler(handler) {
  _mockAppsScriptHandler = handler;
}

/**
 * Send JSON payload to Google Apps Script Web App (/exec)
 */
async function postToAppsScript(payload, timeoutMs = 10000) {
  if (_mockAppsScriptHandler) {
    return _mockAppsScriptHandler('POST', payload);
  }
  if (process.env.NODE_ENV === 'test') {
    return { success: false, skipped: true };
  }
  const url = getAppsScriptUrl();
  if (!url) {
    return { success: false, message: 'Apps Script URL belum dikonfigurasi.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: controller.signal
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (_) {
      return { success: res.ok, raw: text.slice(0, 200) };
    }
  } catch (err) {
    console.error('Apps Script POST error:', err.message);
    return { success: false, message: err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function pushOrderToAppsScript(order, items) {
  return postToAppsScript({ action: 'createOrder', order, items });
}

async function deleteOrdersInAppsScript(orderNumbers, timeoutMs = 15000) {
  const secret = process.env.APPS_SCRIPT_SECRET || '';
  const numbers = Array.isArray(orderNumbers) ? orderNumbers : [orderNumbers];

  // 1. Try action: 'deleteOrders' with secret (native endpoint in new Code.gs)
  const res = await postToAppsScript({
    action: 'deleteOrders',
    secret,
    order_numbers: numbers
  }, timeoutMs);

  // If response has structured delete results or succeeded, return it
  if (res && (res.deleted || res.notFound || (res.success && !String(res.message || '').includes('tidak dikenali')))) {
    return res;
  }

  // 2. Seamless Fallback: If deployed Apps Script version doesn't recognize 'deleteOrders' yet (e.g. returns "Action tidak dikenali."),
  // fallback to updateOrderStatus setting Status Pesanan & Status Pembayaran = 'DELETED'
  if (res && String(res.message || '').includes('tidak dikenali')) {
    const fallbackResults = {
      success: true,
      deleted: [],
      notFound: [],
      failed: []
    };

    for (const num of numbers) {
      try {
        const updateRes = await postToAppsScript({
          action: 'updateOrderStatus',
          order_number: num,
          payment_status: 'DELETED',
          order_status: 'DELETED'
        }, timeoutMs);

        if (updateRes && updateRes.success) {
          fallbackResults.deleted.push(num);
        } else if (updateRes && (updateRes.status === 404 || String(updateRes.message || '').includes('tidak ditemukan'))) {
          // Absent from primary spreadsheet: safe to finalize locally
          fallbackResults.notFound.push(num);
        } else {
          fallbackResults.failed.push({ order_number: num, error: updateRes?.message || 'Update failed' });
        }
      } catch (err) {
        fallbackResults.failed.push({ order_number: num, error: err.message });
      }
    }

    if (fallbackResults.failed.length > 0 && fallbackResults.deleted.length === 0 && fallbackResults.notFound.length === 0) {
      fallbackResults.success = false;
      fallbackResults.message = 'Gagal memperbarui status hapus di spreadsheet.';
    }
    // Clean up orphan OrderItems in sheet
    try { getFromAppsScript('cleanupOrderItems', 5000); } catch (_) {}
    return fallbackResults;
  }

  // Clean up orphan OrderItems in sheet
  try { getFromAppsScript('cleanupOrderItems', 5000); } catch (_) {}
  return res;
}

async function uploadPaymentProofToDrive({ order, items, fileBuffer, fileName, mimeType, version }) {
  return postToAppsScript({
    action: 'uploadPaymentProof',
    order_number: order.order_number,
    order,
    items,
    version,
    file_name: fileName,
    mime_type: mimeType,
    file_base64: fileBuffer.toString('base64')
  }, 15000);
}

async function updateOrderStatusInAppsScript(orderNumber, paymentStatus, orderStatus) {
  return postToAppsScript({
    action: 'updateOrderStatus',
    order_number: orderNumber,
    payment_status: paymentStatus,
    order_status: orderStatus
  });
}

async function uploadProductImageToDrive(fileBuffer, fileName, mimeType) {
  return postToAppsScript({
    action: 'uploadProductImage',
    file_name: fileName,
    mime_type: mimeType,
    file_base64: fileBuffer.toString('base64')
  }, 15000);
}

async function pushProductsToAppsScript() {
  const db = getDb();
  const products = db.prepare(`
    SELECT p.id, p.category_id, p.name, p.slug, p.price, COALESCE(c.name, '') as category_name, p.available, p.description, p.image, p.spicy_levels
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.archived = 0
    ORDER BY p.id ASC
  `).all();
  return postToAppsScript({ action: 'syncProducts', products });
}

async function getFromAppsScript(action, timeoutMs = 5000) {
  if (_mockAppsScriptHandler) {
    return _mockAppsScriptHandler('GET', { action });
  }
  if (process.env.NODE_ENV === 'test') return null;
  const url = getAppsScriptUrl();
  if (!url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetch(`${url}${sep}action=${encodeURIComponent(action)}`, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal
    });
    if (!res.ok) return null;
    const text = await res.text();
    return JSON.parse(text);
  } catch (err) {
    console.error(`Apps Script GET ${action} error:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let _lastCatalogSyncAt = 0;
let _lastOrdersSyncAt = 0;
let _lastSalesSyncAt = 0;
let _cachedSalesMap = null;
const SERVERLESS_SYNC_TTL_MS = 5000;
const SALES_CACHE_TTL_MS = 60000;

function invalidateCatalogCache() { _lastCatalogSyncAt = 0; }
function invalidateOrdersCache() { _lastOrdersSyncAt = 0; _lastSalesSyncAt = 0; _cachedSalesMap = null; }

/**
 * Parse Google Sheets Orders rows into a Map<lowercaseProductName, totalPaidQty>.
 * Counts only PAID orders that are not CANCELLED or REJECTED.
 */
function parseMenuSummaryCounts(rows) {
  const counts = new Map();
  if (!Array.isArray(rows)) return counts;

  for (const r of rows) {
    const payStatus = String(r['Status Pembayaran'] || r.payment_status || '').trim().toUpperCase();
    const orderStatus = String(r['Status Pesanan'] || r.order_status || '').trim().toUpperCase();
    if (payStatus !== 'PAID' || orderStatus === 'CANCELLED' || orderStatus === 'REJECTED' || orderStatus === 'DELETED') {
      continue;
    }

    const summary = String(r['Ringkasan Menu'] || r.item_summary || '').trim();
    if (!summary) continue;

    for (const part of summary.split(',')) {
      const match = part.trim().match(/^(\d+)\s*x\s+(.+)$/i);
      if (!match) continue;
      const qty = parseInt(match[1], 10);
      const name = match[2].trim();
      if (!qty || qty <= 0 || /\(Bonus Promo\)$/i.test(name)) continue;
      const key = name.toLowerCase();
      counts.set(key, (counts.get(key) || 0) + qty);
    }
  }
  return counts;
}

/**
 * Fetch cached paid sales counts from Google Sheets on Vercel serverless containers.
 * Returns null if not on Vercel (unless forced) or if Apps Script is unreachable.
 */
async function getSalesCountMapFromSheets(force = false) {
  if (!process.env.VERCEL && !force) return null;
  if (!force && _cachedSalesMap && (Date.now() - _lastSalesSyncAt < SALES_CACHE_TTL_MS)) {
    return _cachedSalesMap;
  }

  const json = await getFromAppsScript('getOrders', 3500);
  const rows = (json && (json.success === true || json.status === 'success') && Array.isArray(json.data)) ? json.data : null;
  if (!rows) return null;

  _cachedSalesMap = parseMenuSummaryCounts(rows);
  _lastSalesSyncAt = Date.now();
  return _cachedSalesMap;
}

function resolveCategoryId(rawCatId, rawCatName) {
  const parsed = parseInt(rawCatId, 10);
  if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  const name = String(rawCatName || '').trim().toLowerCase();
  if (name.includes('add-on') || name.includes('addon')) return 5;
  if (name.includes('snack')) return 2;
  if (name.includes('drink') || name.includes('minum')) return 3;
  if (name.includes('bundl') || name.includes('combo')) return 4;
  return 1;
}

/**
 * Sync Products from Google Sheets into /tmp/nachoan.db on Vercel multi-instance containers.
 * Safe no-op if Apps Script is still v1 or unreachable.
 */
async function syncCatalogFromAppsScriptIfVercel(force = false) {
  if (!process.env.VERCEL && !getAppsScriptUrl() && !force) return false;
  if (!force && Date.now() - _lastCatalogSyncAt < SERVERLESS_SYNC_TTL_MS) return false;

  const json = await getFromAppsScript('getProducts', 4500);
  if (!json || json.success !== true || !Array.isArray(json.data) || json.data.length === 0) {
    return false;
  }

  // Guard: ensure rows are actually products (not v1 Orders array)
  const first = json.data[0];
  if (!first || (!('Nama Menu' in first) && !('name' in first))) {
    return false;
  }

  const db = getDb();
  const ts = now();
  const seenIds = [];

  const upsertTx = db.transaction(() => {
    for (const r of json.data) {
      const name = String(r['Nama Menu'] || r.name || '').trim();
      if (!name) continue;
      const id = parseInt(r['ID'] || r.id, 10);
      const price = parseInt(r['Harga (Rp)'] || r.price, 10) || 0;
      const categoryId = resolveCategoryId(r['CategoryID'] || r.category_id, r['Kategori'] || r.category_name);
      const availRaw = String(r['Status Ketersediaan'] ?? r.available ?? 'Tersedia').trim().toLowerCase();
      const available = (availRaw === '0' || availRaw === 'habis' || availRaw === 'false') ? 0 : 1;
      const description = String(r['Deskripsi'] || r.description || '').trim();
      const image = String(r['File Gambar'] || r.image || '/images/products/beefy-nacho.jpg').trim();
      const slug = String(r['Slug'] || r.slug || '').trim() ||
        name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + (id ? '' : `-${Date.now()}`);
      let finalSlug = slug;
      const existingSlug = db.prepare('SELECT id FROM products WHERE slug = ?').get(finalSlug);
      if (existingSlug && existingSlug.id !== id) {
        finalSlug = `${slug}-${id}`;
      }
      const spicyLevels = r['SpicyLevels'] || r.spicy_levels || null;

      if (!Number.isNaN(id) && id > 0) {
        seenIds.push(id);
        db.prepare(`
          INSERT INTO products (id, category_id, name, slug, description, price, image, spicy_levels, available, archived, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            category_id = excluded.category_id,
            name = excluded.name,
            slug = excluded.slug,
            description = excluded.description,
            price = excluded.price,
            image = excluded.image,
            spicy_levels = excluded.spicy_levels,
            available = excluded.available,
            archived = 0,
            updated_at = excluded.updated_at
        `).run(id, categoryId, name, finalSlug, description, price, image, spicyLevels || null, available, ts, ts);
      }
    }

    if (seenIds.length > 0) {
      const placeholders = seenIds.map(() => '?').join(',');
      db.prepare(`UPDATE products SET archived = 1 WHERE archived = 0 AND id NOT IN (${placeholders})`).run(...seenIds);
    }
  });

  try {
    upsertTx();
    _lastCatalogSyncAt = Date.now();
    return true;
  } catch (err) {
    console.error('Catalog rehydration error:', err.message);
    return false;
  }
}

/**
 * Sync Orders & Drive proof links from Google Sheets into /tmp/nachoan.db on Vercel.
 */
async function syncOrdersFromAppsScriptIfVercel(force = false) {
  if (!process.env.VERCEL && !getAppsScriptUrl() && !force) return false;
  if (!force && Date.now() - _lastOrdersSyncAt < SERVERLESS_SYNC_TTL_MS) return false;

  const json = await getFromAppsScript('getOrders', 4500);
  const rows = (json && (json.success === true || json.status === 'success') && Array.isArray(json.data)) ? json.data : null;
  if (!rows || rows.length === 0) return false;

  const db = getDb();
  const ts = now();

  const upsertTx = db.transaction(() => {
    for (const r of rows) {
      const orderNum = String(r['No Pesanan'] || r.order_number || '').trim();
      if (!orderNum) continue;

      const paymentStatus = String(r['Status Pembayaran'] || r.payment_status || 'UNPAID').trim().toUpperCase();
      const orderStatus = String(r['Status Pesanan'] || r.order_status || 'NEW').trim().toUpperCase();
      const accessToken = String(r['Token Akses'] || r.access_token || '').trim();
      const updatedAt = String(r['Terakhir Diperbarui'] || r.updated_at || ts).trim();

      // Permanent deletion marker from Google Sheets
      if (paymentStatus === 'DELETED' || orderStatus === 'DELETED') {
        const existing = db.prepare('SELECT id, access_token FROM orders WHERE order_number = ?').get(orderNum);
        if (existing) {
          db.prepare('DELETE FROM order_items WHERE order_id = ?').run(existing.id);
          db.prepare('DELETE FROM payment_submissions WHERE order_id = ?').run(existing.id);
          db.prepare('DELETE FROM order_status_history WHERE order_id = ?').run(existing.id);
          db.prepare('DELETE FROM orders WHERE id = ?').run(existing.id);
        }
        const token = (accessToken && !accessToken.startsWith('sync_')) ? accessToken : (existing ? existing.access_token : null);
        db.prepare('INSERT OR REPLACE INTO deleted_orders (order_number, access_token, deleted_at) VALUES (?, ?, ?)')
          .run(orderNum, token, updatedAt || ts);
        continue;
      }

      // Guard: do not re-insert if already marked deleted locally
      const isAlreadyDeleted = db.prepare('SELECT 1 FROM deleted_orders WHERE order_number = ?').get(orderNum);
      if (isAlreadyDeleted) {
        continue;
      }

      const customerName = String(r['Nama Pelanggan'] || r.customer_name || 'Pelanggan').trim();
      const customerPhone = String(r['Nomor WhatsApp'] || r.customer_phone || '').trim();
      const methodRaw = String(r['Metode'] || r.method || '').toLowerCase();
      const method = methodRaw.includes('delivery') ? 'delivery' : 'pickup';
      const address = String(r['Alamat Pengantaran'] || r.address || '').trim();
      const subtotal = parseInt(r['Subtotal (Rp)'] || r.subtotal, 10) || 0;
      const deliveryFee = parseInt(r['Ongkir (Rp)'] || r.delivery_fee, 10) || 0;
      const total = parseInt(r['Total Pembayaran (Rp)'] || r.total, 10) || (subtotal + deliveryFee);
      const notes = String(r['Catatan Pemesan'] || r.notes || '').trim();
      const finalAccessToken = accessToken || `sync_${orderNum}`;
      const createdAt = String(r['Waktu Pemesanan'] || r.created_at || ts).trim();
      const proofUrl = String(r['Bukti Pembayaran'] || r.proof_url || '').trim();
      const rawReferral = String(r['Kode Referral'] || r.referral_code || '').trim();
      const referralCode = (rawReferral && rawReferral !== '-') ? rawReferral.toUpperCase().slice(0, 50) : null;

      const existing = db.prepare('SELECT id FROM orders WHERE order_number = ?').get(orderNum);
      let orderId;
      if (existing) {
        orderId = existing.id;
        db.prepare(`
          UPDATE orders SET payment_status = ?, order_status = ?, referral_code = COALESCE(?, referral_code), updated_at = ? WHERE id = ?
        `).run(paymentStatus, orderStatus, referralCode, updatedAt, orderId);
      } else {
        const res = db.prepare(`
          INSERT OR IGNORE INTO orders (
            order_number, access_token, customer_name, customer_phone,
            method, address, delivery_fee, notes, referral_code, subtotal, total,
            payment_status, order_status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          orderNum, finalAccessToken, customerName, customerPhone,
          method, address === '-' ? null : address, deliveryFee, notes === '-' ? null : notes,
          referralCode, subtotal, total, paymentStatus, orderStatus, createdAt, updatedAt
        );
        orderId = res.lastInsertRowid;
        const menuSummary = String(r['Ringkasan Menu'] || r.summary || '').trim();
        if (orderId && menuSummary && menuSummary !== '-') {
          const parts = menuSummary.split(',');
          for (const part of parts) {
            const m = part.trim().match(/^(\d+)x\s*(.+)$/i);
            const qty = m ? parseInt(m[1], 10) : 1;
            const name = m ? m[2].trim() : part.trim();
            db.prepare(`
              INSERT INTO order_items (order_id, name, price, quantity)
              VALUES (?, ?, ?, ?)
            `).run(orderId, name, 0, qty);
          }
        }
      }

      if (orderId && proofUrl && proofUrl.startsWith('http')) {
        const hasProof = db.prepare('SELECT id, drive_url FROM payment_submissions WHERE order_id = ? ORDER BY version DESC LIMIT 1').get(orderId);
        if (!hasProof) {
          db.prepare(`
            INSERT INTO payment_submissions (order_id, file_path, mime_type, file_size, drive_url, version, status, created_at)
            VALUES (?, 'drive_synced', 'image/jpeg', 0, ?, 1, ?, ?)
          `).run(orderId, proofUrl, paymentStatus === 'PAID' ? 'approved' : 'pending', updatedAt);
        } else if (!hasProof.drive_url) {
          db.prepare('UPDATE payment_submissions SET drive_url = ? WHERE id = ?').run(proofUrl, hasProof.id);
        }
      }
    }
  });

  try {
    upsertTx();
    _lastOrdersSyncAt = Date.now();
    return true;
  } catch (err) {
    console.error('Orders rehydration error:', err.message);
    return false;
  }
}

module.exports = {
  SPREADSHEET_ID,
  toCSV,
  parseCSV,
  getOrdersSheetData,
  getOrderItemsSheetData,
  getProductsSheetData,
  getBundlesSheetData,
  getDeliveryZonesSheetData,
  getStoreSettingsSheetData,
  syncOrdersToSpreadsheet,
  syncAllToSpreadsheet,
  pullOrdersFromSpreadsheet,
  resetSpreadsheet,
  getAppsScriptUrl,
  setAppsScriptUrl,
  postToAppsScript,
  getFromAppsScript,
  pushOrderToAppsScript,
  uploadPaymentProofToDrive,
  uploadProductImageToDrive,
  updateOrderStatusInAppsScript,
  pushProductsToAppsScript,
  deleteOrdersInAppsScript,
  setMockAppsScriptHandler,
  syncCatalogFromAppsScriptIfVercel,
  syncOrdersFromAppsScriptIfVercel,
  resolveCategoryId,
  parseMenuSummaryCounts,
  getSalesCountMapFromSheets,
  invalidateCatalogCache,
  invalidateOrdersCache
};
