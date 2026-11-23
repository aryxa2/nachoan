const getDb = require('./db');
const { now } = require('./helpers');

/**
 * Finds an order by its access_token.
 * In a serverless environment (like Vercel) where different containers have isolated /tmp filesystems,
 * this function automatically rehydrates the order and its items into the local SQLite instance
 * using the client's signed cookie cache if not yet present in the local database.
 */
function findOrderByToken(token, req) {
  if (!token) return null;
  const db = getDb();
  let order = db.prepare('SELECT * FROM orders WHERE access_token = ?').get(token);
  if (order) return order;

  // Fallback: Rehydrate from client cookie (essential for Vercel multi-instance serverless)
  if (req && req.cookies) {
    const cookieKey = 'nch_ord_' + token.slice(0, 16);
    const rawVal = req.cookies[cookieKey];
    if (rawVal) {
      try {
        const cached = typeof rawVal === 'string' ? JSON.parse(rawVal) : rawVal;
        if (cached && cached.order && cached.order.access_token === token) {
          const o = cached.order;
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

module.exports = { findOrderByToken };
