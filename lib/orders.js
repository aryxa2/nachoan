const getDb = require('./db');
const { now } = require('./helpers');

/**
 * Finds an order by its access_token.
 * In a serverless environment (like Vercel) where different containers have isolated /tmp filesystems,
 * this function automatically rehydrates the order and its items into the local SQLite instance
 * using the client's signed cookie cache if not yet present in the local database.
 * 
 * CRITICAL: If an order has been deleted (present in deleted_orders or marked DELETED in primary storage),
 * this function MUST NEVER rehydrate the order. It permanently clears the cookie and returns null.
 */
async function findOrderByToken(token, req, res) {
  if (!token) return null;
  const db = getDb();

  // 1. Check if token or order is in deleted_orders tombstone
  const isDeleted = db.prepare('SELECT 1 FROM deleted_orders WHERE access_token = ?').get(token);
  if (isDeleted) {
    if (res && res.clearCookie) {
      res.clearCookie('nch_ord_' + token.slice(0, 16));
    }
    return null;
  }

  let order = db.prepare('SELECT * FROM orders WHERE access_token = ?').get(token);
  if (order) {
    if (order.order_status === 'DELETED' || order.payment_status === 'DELETED') {
      if (res && res.clearCookie) res.clearCookie('nch_ord_' + token.slice(0, 16));
      return null;
    }
    return order;
  }

  // 2. Fallback: Rehydrate from client cookie (essential for Vercel multi-instance serverless)
  if (req && req.cookies) {
    const cookieKey = 'nch_ord_' + token.slice(0, 16);
    const rawVal = req.cookies[cookieKey];
    if (rawVal) {
      try {
        const cached = typeof rawVal === 'string' ? JSON.parse(rawVal) : rawVal;
        if (cached && cached.order && cached.order.access_token === token) {
          const o = cached.order;

          // Check if order_number is in deleted_orders
          if (o.order_number) {
            const numDeleted = db.prepare('SELECT 1 FROM deleted_orders WHERE order_number = ?').get(o.order_number);
            if (numDeleted) {
              if (res && res.clearCookie) res.clearCookie(cookieKey);
              return null;
            }
          }

          // Before rehydrating, verify with Google Sheets via Apps Script if configured or on Vercel
          const sheets = require('./sheets');
          if (sheets.getAppsScriptUrl() || process.env.VERCEL) {
            try {
              await sheets.syncOrdersFromAppsScriptIfVercel(true);
            } catch (_) {}
            
            // Re-check after sync
            const recheckDeleted = db.prepare('SELECT 1 FROM deleted_orders WHERE access_token = ? OR order_number = ?').get(token, o.order_number || '');
            if (recheckDeleted) {
              if (res && res.clearCookie) res.clearCookie(cookieKey);
              return null;
            }

            // Check if the order is now loaded in SQLite
            const syncedOrder = db.prepare('SELECT * FROM orders WHERE access_token = ?').get(token);
            if (syncedOrder) {
              if (syncedOrder.order_status === 'DELETED' || syncedOrder.payment_status === 'DELETED') {
                if (res && res.clearCookie) res.clearCookie(cookieKey);
                return null;
              }
              return syncedOrder;
            }
          }

          // Insert order into SQLite
          db.prepare(`
            INSERT OR IGNORE INTO orders (
              id, order_number, access_token, customer_name, customer_phone, customer_email,
              method, address, delivery_zone_id, delivery_fee, notes,
              subtotal, discount, promo_id, promo_code, total,
              payment_status, order_status, qris_version, idempotency_key, created_at, updated_at
            ) VALUES (
              @id, @order_number, @access_token, @customer_name, @customer_phone, @customer_email,
              @method, @address, @delivery_zone_id, @delivery_fee, @notes,
              @subtotal, @discount, @promo_id, @promo_code, @total,
              @payment_status, @order_status, 1, @idempotency_key, @created_at, @updated_at
            )
          `).run(o);

          if (cached.items && Array.isArray(cached.items)) {
            const itemStmt = db.prepare(`
              INSERT OR IGNORE INTO order_items (
                order_id, product_id, bundle_id, name, variant, price, quantity, is_gift, components
              ) VALUES (
                @order_id, @product_id, @bundle_id, @name, @variant, @price, @quantity, @is_gift, @components
              )
            `);
            for (const it of cached.items) {
              itemStmt.run({
                order_id: o.id,
                product_id: it.product_id || null,
                bundle_id: it.bundle_id || null,
                name: it.name,
                variant: it.variant || null,
                price: it.price,
                quantity: it.quantity,
                is_gift: it.is_gift ? 1 : 0,
                components: it.components || null
              });
            }
          }

          // Initial history log if empty
          const histCount = db.prepare('SELECT COUNT(*) as c FROM order_status_history WHERE order_id = ?').get(o.id);
          if (!histCount || histCount.c === 0) {
            db.prepare(`
              INSERT INTO order_status_history (order_id, field, old_value, new_value, actor, reason, created_at)
              VALUES (?, 'order_status', NULL, 'NEW', 'customer', 'Pesanan berhasil dibuat oleh pelanggan', ?)
            `).run(o.id, o.created_at || now());
          }

          return db.prepare('SELECT * FROM orders WHERE access_token = ?').get(token);
        }
      } catch (err) {
        console.error('Order rehydration error:', err);
      }
    }
  }

  return null;
}

/**
 * Unified Order Deletion Service (used by single delete and bulk delete).
 * Ensures deletion is permanently recorded in primary data store (Google Sheets / Apps Script),
 * tombstone table in SQLite, and cleans up all related data.
 * 
 * @param {Object} options
 * @param {Array<string|number>} options.orderIdentifiers - List of order IDs or Order Numbers (e.g. ['NCH-12345', 2])
 * @param {Object} [options.adminUser] - Admin user session info
 * @returns {Promise<Object>} { success, message, deletedCount, notFoundCount, deleted, notFound, failed }
 */
async function deleteOrdersService({ orderIdentifiers = [], adminUser = null }) {
  const db = getDb();
  const sheets = require('./sheets');

  let rawList = orderIdentifiers;
  if (typeof rawList === 'string') {
    try {
      rawList = JSON.parse(rawList);
    } catch (_) {
      rawList = rawList.split(',').map(s => s.trim()).filter(Boolean);
    }
  }

  if (!Array.isArray(rawList) || rawList.length === 0) {
    return {
      success: false,
      message: 'Pilih minimal satu pesanan untuk dihapus.',
      deletedCount: 0,
      notFoundCount: 0,
      deleted: [],
      notFound: [],
      failed: []
    };
  }

  // 1. Resolve identifiers to order_numbers and existing records
  const targetMap = new Map(); // order_number -> { id, order_number, access_token }
  const notFoundList = [];

  for (const item of rawList) {
    const s = String(item).trim();
    if (!s) continue;

    let found = null;
    if (/^\d+$/.test(s)) {
      found = db.prepare('SELECT id, order_number, access_token FROM orders WHERE id = ?').get(parseInt(s, 10));
    }
    if (!found) {
      found = db.prepare('SELECT id, order_number, access_token FROM orders WHERE order_number = ?').get(s);
    }

    if (found) {
      targetMap.set(found.order_number, found);
    } else {
      // Check if it's already in deleted_orders
      const alreadyDel = db.prepare('SELECT order_number, access_token FROM deleted_orders WHERE order_number = ?').get(s);
      if (alreadyDel) {
        targetMap.set(s, { id: null, order_number: s, access_token: alreadyDel.access_token, alreadyDeleted: true });
      } else if (s.startsWith('NCH-') || s.length >= 5) {
        // Assume valid order number format even if not in local SQLite container
        targetMap.set(s, { id: null, order_number: s, access_token: null });
      } else {
        notFoundList.push(s);
      }
    }
  }

  const orderNumbers = Array.from(targetMap.keys());
  if (orderNumbers.length === 0) {
    return {
      success: false,
      message: 'Pesanan tidak ditemukan di sistem.',
      deletedCount: 0,
      notFoundCount: notFoundList.length,
      deleted: [],
      notFound: notFoundList,
      failed: []
    };
  }

  // 2. Primary Data Store Confirmation (Google Apps Script / Sheets)
  let confirmedNumbers = [];
  const scriptUrl = sheets.getAppsScriptUrl();

  if (scriptUrl) {
    const scriptRes = await sheets.deleteOrdersInAppsScript(orderNumbers);
    if (!scriptRes || scriptRes.success !== true) {
      const errDetail = scriptRes?.message || scriptRes?.error || 'Koneksi ke Google Apps Script gagal atau timeout.';
      return {
        success: false,
        message: `Gagal menghapus pesanan di penyimpanan utama (Google Sheets): ${errDetail}`,
        deletedCount: 0,
        notFoundCount: notFoundList.length,
        deleted: [],
        notFound: notFoundList,
        failed: orderNumbers
      };
    }

    const scriptDeleted = Array.isArray(scriptRes.deleted) ? scriptRes.deleted : [];
    const scriptNotFound = Array.isArray(scriptRes.notFound) ? scriptRes.notFound : [];

    // Orders confirmed deleted or already absent from primary store are safe to finalize
    confirmedNumbers = [...scriptDeleted, ...scriptNotFound];
    if (scriptNotFound.length > 0) {
      for (const nf of scriptNotFound) {
        if (!notFoundList.includes(nf)) notFoundList.push(nf);
      }
    }
  } else {
    // If Apps Script is not configured (e.g. offline local development), treat all as confirmed
    confirmedNumbers = orderNumbers;
  }

  if (confirmedNumbers.length === 0) {
    return {
      success: false,
      message: 'Tidak ada pesanan yang berhasil dikonfirmasi penghapusannya di penyimpanan utama.',
      deletedCount: 0,
      notFoundCount: notFoundList.length,
      deleted: [],
      notFound: notFoundList,
      failed: orderNumbers
    };
  }

  // 3. Local SQLite Permanent Deletion & Tombstone Recording (Atomic Transaction)
  const currentTime = now();
  const deletedFinalList = [];

  const tx = db.transaction(() => {
    for (const num of confirmedNumbers) {
      const meta = targetMap.get(num) || {};
      const existing = db.prepare('SELECT id, access_token FROM orders WHERE order_number = ?').get(num);
      const token = meta.access_token || (existing ? existing.access_token : null);
      const orderId = existing ? existing.id : meta.id;

      if (orderId) {
        db.prepare('DELETE FROM order_items WHERE order_id = ?').run(orderId);
        db.prepare('DELETE FROM payment_submissions WHERE order_id = ?').run(orderId);
        db.prepare('DELETE FROM order_status_history WHERE order_id = ?').run(orderId);
        db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
      } else {
        db.prepare('DELETE FROM orders WHERE order_number = ?').run(num);
      }

      // Record in permanent tombstone table
      db.prepare(`
        INSERT OR REPLACE INTO deleted_orders (order_number, access_token, deleted_at)
        VALUES (?, ?, ?)
      `).run(num, token, currentTime);

      deletedFinalList.push(num);
    }
  });

  tx();

  // Invalidate in-memory sync cache
  sheets.invalidateOrdersCache();

  // Non-Vercel local environment with gsheets CLI fallback
  if (!process.env.VERCEL) {
    try {
      sheets.syncOrdersToSpreadsheet();
    } catch (_) {}
  }

  const successMsg = `Berhasil menghapus permanen ${deletedFinalList.length} pesanan.${notFoundList.length > 0 ? ` (${notFoundList.length} tidak ditemukan)` : ''}`;

  return {
    success: true,
    message: successMsg,
    deletedCount: deletedFinalList.length,
    notFoundCount: notFoundList.length,
    deleted: deletedFinalList,
    notFound: notFoundList,
    failed: []
  };
}

/**
 * Match a product query string against active product list
 */
function matchProduct(query, products) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return null;
  const byId = products.find(p => String(p.id) === q);
  if (byId) return byId;
  const byExact = products.find(p => p.name.toLowerCase() === q || (p.slug && p.slug.toLowerCase() === q));
  if (byExact) return byExact;
  const byIncludes = products.find(p => p.name.toLowerCase().includes(q) || q.includes(p.name.toLowerCase()));
  if (byIncludes) return byIncludes;
  return null;
}

/**
 * Parses a single item line to extract quantity and product name
 * e.g. '2x Beefy Nacho', 'Beefy Nacho 3x', 'hihu', '- 5x Cheezy Corn'
 */
function parseQtyAndName(line) {
  let text = String(line || '').trim().replace(/^[-*•]\s*/, '');
  let m = text.match(/^(\d+)\s*[xX*]?\s+(.+)$/);
  if (m) return { qty: parseInt(m[1], 10), name: m[2].trim() };
  m = text.match(/^(.+?)\s+(?:[xX*]\s*(\d+)|(\d+)\s*[xX*]|\((\d+)\))$/);
  if (m) {
    const qty = parseInt(m[2] || m[3] || m[4] || '1', 10);
    return { qty: qty || 1, name: m[1].trim() };
  }
  m = text.match(/^([a-zA-Z\s]+?)\s+(\d+)$/);
  if (m) return { qty: parseInt(m[2], 10), name: m[1].trim() };
  return { qty: 1, name: text };
}

/**
 * Parses items text separated by commas or newlines
 */
function parseItemsText(itemsText, products) {
  if (!itemsText) return [];
  const lines = itemsText.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
  const items = [];
  for (const line of lines) {
    const parsed = parseQtyAndName(line);
    const prod = matchProduct(parsed.name, products);
    if (prod) {
      const existing = items.find(it => it.product_id === prod.id);
      if (existing) {
        existing.quantity += parsed.qty;
      } else {
        items.push({
          product_id: prod.id,
          name: prod.name,
          price: prod.price,
          quantity: parsed.qty
        });
      }
    }
  }
  return items;
}

/**
 * Robust bulk orders parser supporting both:
 * 1) Chat / Block format separated by '---' or blank lines
 * 2) Pipe '|' delimited format (1 order per line)
 */
function parseBulkOrdersText(rawText, products) {
  if (!rawText || !rawText.trim()) return [];
  const text = rawText.trim();
  const orders = [];

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const pipeLines = lines.filter(l => l.includes('|'));
  
  if (pipeLines.length > 0 && pipeLines.length === lines.length) {
    for (const line of pipeLines) {
      const parts = line.split('|').map(p => p.trim());
      if (parts.length < 2) continue;
      const name = parts[0] || '';
      const phone = parts[1] || '';
      const method = (parts[2] && parts[2].toLowerCase().includes('deliv')) ? 'delivery' : 'pickup';
      const address = parts[3] || '';
      const itemsRaw = parts[4] || '';
      const notes = parts[5] || '';
      const items = parseItemsText(itemsRaw, products);
      orders.push({
        customer_name: name,
        customer_phone: phone,
        method,
        address: method === 'delivery' ? (address || '') : null,
        items,
        notes,
        payment_status: 'PAID',
        order_status: 'NEW'
      });
    }
    return orders;
  }

  const blocks = text.split(/(?:\r?\n){2,}|(?:\r?\n)?-{3,}(?:\r?\n)?/).map(b => b.trim()).filter(Boolean);
  
  for (const block of blocks) {
    const bLines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const order = {
      customer_name: '',
      customer_phone: '',
      method: 'pickup',
      address: '',
      notes: '',
      payment_status: 'PAID',
      order_status: 'NEW',
      items: []
    };
    
    let collectingItems = false;
    const itemsLines = [];

    for (const line of bLines) {
      if (/^(nama|name|pelanggan)\s*[:=]/i.test(line)) {
        order.customer_name = line.replace(/^(nama|name|pelanggan)\s*[:=]\s*/i, '').trim();
        collectingItems = false;
      } else if (/^(wa|whatsapp|no\s*hp|telepon|hp|phone)\s*[:=]/i.test(line)) {
        order.customer_phone = line.replace(/^(wa|whatsapp|no\s*hp|telepon|hp|phone)\s*[:=]\s*/i, '').trim();
        collectingItems = false;
      } else if (/^(metode|pengiriman|pengambilan|type)\s*[:=]/i.test(line)) {
        const mVal = line.replace(/^(metode|pengiriman|pengambilan|type)\s*[:=]\s*/i, '').trim().toLowerCase();
        order.method = mVal.includes('deliv') || mVal.includes('antar') ? 'delivery' : 'pickup';
        collectingItems = false;
      } else if (/^(alamat|address)\s*[:=]/i.test(line)) {
        order.address = line.replace(/^(alamat|address)\s*[:=]\s*/i, '').trim();
        collectingItems = false;
      } else if (/^(status\s*bayar|bayar|payment)\s*[:=]/i.test(line)) {
        const pVal = line.replace(/^(status\s*bayar|bayar|payment)\s*[:=]\s*/i, '').trim().toUpperCase();
        order.payment_status = (pVal.includes('UNPAID') || pVal.includes('BELUM')) ? 'UNPAID' : 'PAID';
        collectingItems = false;
      } else if (/^(status\s*pesanan|status)\s*[:=]/i.test(line)) {
        const sVal = line.replace(/^(status\s*pesanan|status)\s*[:=]\s*/i, '').trim().toUpperCase();
        if (sVal.includes('PREP')) order.order_status = 'PREPARING';
        else if (sVal.includes('READY')) order.order_status = 'READY';
        else if (sVal.includes('COMPLET') || sVal.includes('SELESAI')) order.order_status = 'COMPLETED';
        else order.order_status = 'NEW';
        collectingItems = false;
      } else if (/^(catatan|note|notes|keterangan)\s*[:=]/i.test(line)) {
        order.notes = line.replace(/^(catatan|note|notes|keterangan)\s*[:=]\s*/i, '').trim();
        collectingItems = false;
      } else if (/^(pesanan|item|items|menu|order)\s*[:=]/i.test(line)) {
        const rest = line.replace(/^(pesanan|item|items|menu|order)\s*[:=]\s*/i, '').trim();
        if (rest) itemsLines.push(rest);
        collectingItems = true;
      } else if (collectingItems || line.startsWith('-') || line.startsWith('*') || /^\d+[xX]/.test(line)) {
        itemsLines.push(line);
      }
    }

    if (itemsLines.length > 0) {
      order.items = parseItemsText(itemsLines.join('\n'), products);
    }

    if (order.customer_name || order.customer_phone || order.items.length > 0) {
      orders.push(order);
    }
  }

  return orders;
}

/**
 * Service to create multiple orders in a single atomic transaction and sync to sheets
 */
function createBulkOrdersService(ordersList, db, adminName = 'admin') {
  const { generateOrderNumber, generateToken, normalizePhone, now } = require('./helpers');
  const sheets = require('./sheets');
  const currentTime = now();
  const createdOrders = [];

  const tx = db.transaction(() => {
    for (const rawOrder of ordersList) {
      const customerName = String(rawOrder.customer_name || '').trim();
      const rawPhone = String(rawOrder.customer_phone || '').trim();
      if (!customerName || !rawPhone) continue;

      const phone = normalizePhone(rawPhone) || rawPhone;
      const method = rawOrder.method === 'delivery' ? 'delivery' : 'pickup';
      const address = method === 'delivery' ? String(rawOrder.address || '').trim() : null;
      const deliveryFee = method === 'delivery' ? 2000 : 0;
      const paymentStatus = rawOrder.payment_status === 'UNPAID' ? 'UNPAID' : 'PAID';
      const orderStatus = ['NEW', 'PREPARING', 'READY', 'COMPLETED'].includes(rawOrder.order_status)
        ? rawOrder.order_status
        : 'NEW';
      const notes = String(rawOrder.notes || '').trim() || null;

      const items = Array.isArray(rawOrder.items) ? rawOrder.items : [];
      if (items.length === 0) continue;

      let subtotal = 0;
      const processedItems = [];

      for (const it of items) {
        const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(it.product_id);
        if (!prod) continue;
        const qty = Math.max(1, parseInt(it.quantity, 10) || 1);
        subtotal += prod.price * qty;
        processedItems.push({
          product_id: prod.id,
          name: prod.name,
          price: prod.price,
          quantity: qty
        });
      }

      if (processedItems.length === 0) continue;

      const total = subtotal + deliveryFee;
      const orderNumber = generateOrderNumber();
      const accessToken = generateToken();

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
        customer_name: customerName,
        customer_phone: phone,
        method,
        address,
        delivery_fee: deliveryFee,
        notes,
        subtotal,
        total,
        payment_status: paymentStatus,
        order_status: orderStatus,
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
        VALUES (?, 'order_status', NULL, ?, ?, 'Pesanan massal dibuat oleh admin', ?)
      `).run(orderId, orderStatus, `admin (${adminName})`, currentTime);

      createdOrders.push({
        id: orderId,
        order_number: orderNumber,
        access_token: accessToken,
        customer_name: customerName,
        customer_phone: phone,
        method,
        total,
        payment_status: paymentStatus,
        order_status: orderStatus
      });
    }
  });

  tx();

  // Async sync all newly created orders to Sheets
  if (createdOrders.length > 0) {
    setImmediate(async () => {
      try {
        for (const o of createdOrders) {
          const orderRecord = db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
          const itemRecords = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(o.id);
          if (orderRecord) {
            await sheets.pushOrderToAppsScript(orderRecord, itemRecords);
          }
        }
        if (!process.env.VERCEL) {
          sheets.syncOrdersToSpreadsheet();
        }
      } catch (e) {
        console.error('Bulk order sync to sheets error:', e.message);
      }
    });
  }

  return createdOrders;
}

module.exports = {
  findOrderByToken,
  deleteOrdersService,
  matchProduct,
  parseQtyAndName,
  parseItemsText,
  parseBulkOrdersText,
  createBulkOrdersService
};
