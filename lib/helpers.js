const crypto = require('crypto');

/**
 * Format number as Indonesian Rupiah: 25000 → 'Rp25.000'
 */
function formatRupiah(num) {
  if (num == null || isNaN(num)) return 'Rp0';
  return 'Rp' + Math.round(Number(num)).toLocaleString('id-ID');
}

/**
 * Generate order number: 'NCH-' + 5 random digits
 */
function generateOrderNumber() {
  const digits = Math.floor(10000 + Math.random() * 90000).toString();
  return 'NCH-' + digits;
}

/**
 * Normalize Indonesian phone number.
 * Accepts 08xx, +62xx, 62xx → returns +62xx
 */
function normalizePhone(phone) {
  if (!phone) return '';
  let cleaned = String(phone).replace(/[\s\-().]/g, '');
  if (cleaned.startsWith('+62')) {
    return cleaned;
  }
  if (cleaned.startsWith('62')) {
    return '+' + cleaned;
  }
  if (cleaned.startsWith('0')) {
    return '+62' + cleaned.slice(1);
  }
  return cleaned;
}

/**
 * Generate a secure random token (64 hex chars)
 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Current ISO datetime string in Asia/Jakarta timezone
 */
function now() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }).replace(' ', 'T');
}

/**
 * Format ISO datetime string to Indonesian human readable format
 * e.g. "2026-11-20T14:27:00" → "20 Nov 2026, 14:27 WIB"
 */
function formatDate(dateStr) {
  if (!dateStr) return '-';
  try {
    const d = new Date(dateStr);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    const day = d.getDate();
    const month = months[d.getMonth()];
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const mins = String(d.getMinutes()).padStart(2, '0');
    return `${day} ${month} ${year}, ${hours}:${mins} WIB`;
  } catch (e) {
    return dateStr;
  }
}

/**
 * Return badge class and label for order & payment status
 */
function getStatusInfo(orderStatus, paymentStatus) {
  if (paymentStatus === 'PAID') {
    switch (orderStatus) {
      case 'PREPARING':
        return { label: 'Sedang Diproses', bg: '#fef3c7', text: '#92400e', color: 'orange' };
      case 'READY':
        return { label: 'Siap Diambil/Diantar', bg: '#e0e7ff', text: '#3730a3', color: 'indigo' };
      case 'COMPLETED':
        return { label: 'Pesanan Selesai', bg: '#dcfce7', text: '#166534', color: 'green' };
      default:
        return { label: 'Pembayaran Terverifikasi', bg: '#dcfce7', text: '#166534', color: 'green' };
    }
  }

  if (orderStatus === 'WAITING_CONFIRMATION') {
    return { label: 'Menunggu Verifikasi Admin', bg: '#fef3c7', text: '#92400e', color: 'amber' };
  }

  if (paymentStatus === 'REJECTED' || orderStatus === 'REJECTED') {
    return { label: 'Bukti Pembayaran Ditolak', bg: '#fee2e2', text: '#991b1b', color: 'red' };
  }

  if (orderStatus === 'CANCELLED') {
    return { label: 'Pesanan Dibatalkan', bg: '#f3f4f6', text: '#374151', color: 'gray' };
  }

  return { label: 'Menunggu Pembayaran', bg: '#fee2e2', text: '#b91c1c', color: 'red' };
}

module.exports = {
  formatRupiah,
  generateOrderNumber,
  normalizePhone,
  generateToken,
  now,
  formatDate,
  getStatusInfo,
};
