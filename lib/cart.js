const getDb = require('./db');

/**
 * Validates cart items and calculates totals with authoritative DB values.
 * 
 * Input items format:
 * [
 *   { type: 'product', id: 1, quantity: 2, variant: 'Pedas' },
 *   { type: 'bundle', id: 1, quantity: 1 }
 * ]
 * 
 * Returns:
 * {
 *   valid: true,
 *   items: [...validated items with authoritative name, price, subtotal, components...],
 *   subtotal: number,
 *   giftItem: { ... } or null,
 *   promo: { valid: bool, code: string, discount: number, message: string } or null,
 *   deliveryFee: number,
 *   total: number,
 *   errors: []
 * }
 */
function calculateCart(rawItems, options = {}) {
  const db = getDb();
  const { promoCode = null, method = 'pickup', zoneId = null } = options;

  const errors = [];
  const validatedItems = [];
  let subtotal = 0;
  let loadedNachosCount = 0;

  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return {
      valid: false,
      errors: ['Keranjang belanja kosong.'],
      items: [],
      subtotal: 0,
      giftItem: null,
      promo: null,
      deliveryFee: 0,
      total: 0
    };
  }

  // Pre-load products and bundles
  const prodStmt = db.prepare('SELECT * FROM products WHERE id = ? AND available = 1 AND archived = 0');
  const bundleStmt = db.prepare('SELECT * FROM bundles WHERE id = ? AND available = 1 AND archived = 0');
  const bundleItemsStmt = db.prepare(`
    SELECT bi.quantity, p.id as product_id, p.name, p.price 
    FROM bundle_items bi
    JOIN products p ON bi.product_id = p.id
    WHERE bi.bundle_id = ?
  `);

  for (const item of rawItems) {
    const qty = parseInt(item.quantity, 10);
    if (isNaN(qty) || qty <= 0) continue;

    if (item.type === 'bundle' || item.bundle_id) {
      const bundleId = item.id || item.bundle_id;
      let bundle = null;
      if (bundleId) {
        bundle = bundleStmt.get(bundleId);
      }
      if (!bundle && item.name) {
        bundle = db.prepare('SELECT * FROM bundles WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND available = 1 AND archived = 0').get(item.name);
      }
      if (!bundle) {
        errors.push(`Paket bundle ${item.name ? `"${item.name}" ` : ''}tidak ditemukan atau sedang tidak tersedia.`);
        continue;
      }
      const itemSubtotal = bundle.price * qty;
      subtotal += itemSubtotal;

      const components = bundleItemsStmt.all(bundle.id);

      validatedItems.push({
        type: 'bundle',
        bundle_id: bundle.id,
        product_id: null,
        name: bundle.name,
        price: bundle.price,
        compare_price: bundle.compare_price,
        quantity: qty,
        variant: null,
        is_gift: 0,
        subtotal: itemSubtotal,
        image: bundle.image,
        components: JSON.stringify(components.map(c => `${c.quantity * qty}x ${c.name}`))
      });
    } else {
      const prodId = item.id || item.product_id;
      let product = null;
      if (prodId) {
        product = prodStmt.get(prodId);
      }
      if (!product && item.name) {
        product = db.prepare('SELECT * FROM products WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND available = 1 AND archived = 0').get(item.name);
      }
      if (!product && item.slug) {
        product = db.prepare('SELECT * FROM products WHERE slug = ? AND available = 1 AND archived = 0').get(item.slug);
      }
      if (!product) {
        errors.push(`Produk ${item.name ? `"${item.name}" ` : ''}tidak ditemukan atau sedang tidak tersedia.`);
        continue;
      }

      // Check variant (spicy level)
      let variant = item.variant || null;
      if (product.spicy_levels) {
        try {
          const levels = JSON.parse(product.spicy_levels);
          if (!variant || !levels.includes(variant)) {
            variant = levels[0] || 'Original';
          }
        } catch (e) {
          variant = 'Original';
        }
      } else {
        variant = null;
      }

      const itemSubtotal = product.price * qty;
      subtotal += itemSubtotal;

      // Track Loaded Nachos (id 1) for auto gift promo
      if (product.id === 1) {
        loadedNachosCount += qty;
      }

      validatedItems.push({
        type: 'product',
        product_id: product.id,
        bundle_id: null,
        name: product.name,
        price: product.price,
        quantity: qty,
        variant: variant,
        is_gift: 0,
        subtotal: itemSubtotal,
        image: product.image,
        components: null
      });
    }
  }

  // Auto Gift Check: only if promo AUTO_GIFT is active
  let giftItem = null;
  const autoGiftPromo = db.prepare("SELECT * FROM promotions WHERE code = 'AUTO_GIFT' AND active = 1").get();
  if (autoGiftPromo && loadedNachosCount >= 2) {
    const giftProd = db.prepare('SELECT * FROM products WHERE id = ? AND available = 1 AND archived = 0').get(autoGiftPromo.gift_product_id || 5);
    if (giftProd) {
      giftItem = {
        type: 'product',
        product_id: giftProd.id,
        bundle_id: null,
        name: `${giftProd.name} (Bonus Promo)`,
        price: 0,
        quantity: 1,
        variant: null,
        is_gift: 1,
        subtotal: 0,
        image: giftProd.image,
        components: null
      };
      validatedItems.push(giftItem);
    }
  }

  // Delivery fee calculation
  let deliveryFee = 0;
  if (method === 'delivery') {
    let zone = null;
    if (zoneId) {
      zone = db.prepare('SELECT * FROM delivery_zones WHERE id = ? AND active = 1').get(zoneId);
    }
    if (!zone) {
      // Default to first active delivery zone
      zone = db.prepare('SELECT * FROM delivery_zones WHERE active = 1 ORDER BY id ASC LIMIT 1').get();
    }
    deliveryFee = zone ? zone.fee : 2000;
  }

  // Promo code calculation
  let promoResult = null;
  let discount = 0;

  if (promoCode && String(promoCode).trim() !== '') {
    const cleanCode = String(promoCode).trim().toUpperCase();
    const promo = db.prepare('SELECT * FROM promotions WHERE UPPER(code) = ? AND active = 1').get(cleanCode);

    if (!promo) {
      promoResult = { valid: false, code: cleanCode, discount: 0, message: 'Kode promo tidak valid atau sudah kadaluarsa.' };
    } else {
      if (promo.min_purchase && subtotal < promo.min_purchase) {
        promoResult = {
          valid: false,
          code: cleanCode,
          discount: 0,
          message: `Minimal pembelian untuk promo ${cleanCode} adalah Rp${promo.min_purchase.toLocaleString('id-ID')}.`
        };
      } else {
        if (promo.type === 'percentage') {
          discount = Math.round((subtotal * promo.value) / 100);
        } else if (promo.type === 'fixed') {
          discount = Math.min(subtotal, promo.value);
        } else if (promo.type === 'gift') {
          // If gift promo is used explicitly
          discount = 0;
        }

        promoResult = {
          valid: true,
          id: promo.id,
          code: promo.code,
          discount: discount,
          description: promo.description,
          message: `Promo ${promo.code} berhasil diterapkan! Hemat Rp${discount.toLocaleString('id-ID')}`
        };
      }
    }
  }

  const total = Math.max(0, subtotal - discount + deliveryFee);

  return {
    valid: errors.length === 0 && validatedItems.length > 0,
    errors,
    items: validatedItems,
    subtotal,
    discount,
    promo: promoResult,
    deliveryFee,
    total,
    loadedNachosCount,
    hasGift: !!giftItem
  };
}

module.exports = {
  calculateCart
};
