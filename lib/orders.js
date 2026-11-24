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

module.exports = {
  findOrderByToken,
  deleteOrdersService
};
