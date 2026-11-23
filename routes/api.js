const express = require('express');
const router = express.Router();
const getDb = require('../lib/db');
const { calculateCart } = require('../lib/cart');
const { findOrderByToken } = require('../lib/orders');

// Polling endpoint for live order status
router.get('/order/:token/status', (req, res) => {
  const { token } = req.params;
  const db = getDb();

  const order = findOrderByToken(token, req);

  if (!order) {
    return res.status(404).json({ success: false, message: 'Pesanan tidak ditemukan' });
  }

  // Also check latest payment submission note/status
  const latestSubmission = db.prepare(`
    SELECT status, reviewer_note, reviewed_at 
    FROM payment_submissions 
    WHERE order_id = (SELECT id FROM orders WHERE access_token = ?)
    ORDER BY version DESC LIMIT 1
  `).get(token);

  res.json({
    success: true,
    order_number: order.order_number,
    order_status: order.order_status,
    payment_status: order.payment_status,
    updated_at: order.updated_at,
    submission: latestSubmission || null
  });
});

// Cart & promo calculation endpoint
router.post('/cart/validate', (req, res) => {
  try {
    const { items = [], promoCode = null, method = 'pickup', zoneId = null } = req.body;
    const result = calculateCart(items, { promoCode, method, zoneId });
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Cart calculation error:', err);
    res.status(500).json({ success: false, message: 'Gagal menghitung keranjang.' });
  }
});

module.exports = router;
