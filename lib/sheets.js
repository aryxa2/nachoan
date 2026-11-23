const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const getDb = require('./db');
const { now, formatDate } = require('./helpers');

const SPREADSHEET_ID = '1YDenYpVKZVnhv5jBxp4iMdxxLMgHGOSTn3qjkBmEmJ8';
const TMP_DIR = path.join(__dirname, '..', 'storage', 'csv_export');
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
      'Token Akses': o.access_token
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
    'Catatan Pemesan', 'Terakhir Diperbarui', 'Token Akses'
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

      const existing = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(orderNum);
      if (!existing) continue;

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

module.exports = {
  SPREADSHEET_ID,
  toCSV,
  parseCSV,
  syncOrdersToSpreadsheet,
  syncAllToSpreadsheet,
  pullOrdersFromSpreadsheet,
  resetSpreadsheet,
  getAppsScriptUrl,
  setAppsScriptUrl
};
