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
 * Normalize and strictly validate Indonesian phone numbers.
 * Accepts formats: 08xx, +628xx, 628xx (and standard landlines 02x, 03x, etc.)
 * Strips whitespace, hyphens, dots, and parentheses.
 * Returns normalized '+62...' or null if invalid (e.g. letters, invalid length/prefix).
 */
function normalizePhone(phone) {
  if (!phone) return null;
  const str = String(phone).trim();
  if (!str) return null;

  // Clean allowed delimiters: spaces, dashes, dots, parentheses
  const cleaned = str.replace(/[\s\-().]/g, '');

  // Must consist only of digits, optionally starting with a single '+'
  if (!/^\+?\d+$/.test(cleaned)) {
    return null;
  }

  let digits = cleaned;
  if (digits.startsWith('+62')) {
    digits = digits.slice(3);
  } else if (digits.startsWith('62')) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0')) {
    digits = digits.slice(1);
  } else {
    // Missing required Indonesian country/national prefix (0, 62, or +62)
    return null;
  }

  // Indonesian national digits after country prefix must be between 8 and 13 digits
  // Mobile / WhatsApp numbers typically start with '8' (e.g. 812..., 857...)
  if (!/^\d{8,13}$/.test(digits)) {
    return null;
  }

  return '+62' + digits;
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
 * Safely parse a date string into a Date object, ensuring Asia/Jakarta (+07:00)
 * alignment if no timezone offset is explicitly provided.
 */
function parseToJakartaDate(dateStr) {
  if (!dateStr) return null;
  let str = String(dateStr).trim();
  if (!str) return null;
  // If no timezone indicator, treat as Asia/Jakarta (+07:00)
  if (!str.includes('Z') && !/[+-]\d{2}(:\d{2})?$/.test(str)) {
    str = str.replace(' ', 'T') + '+07:00';
  }
  const d = new Date(str);
  if (isNaN(d.getTime())) return null;
  return d;
}

/**
 * Format ISO datetime string to Indonesian human readable format in WIB (Asia/Jakarta)
 * e.g. "2026-11-20T14:27:00" → "20 Nov 2026, 14:27 WIB"
 * Consistent regardless of host server timezone (e.g. UTC on Vercel or local machine).
 */
function formatDate(dateStr) {
  if (!dateStr) return '-';
  try {
    const d = parseToJakartaDate(dateStr);
    if (!d) return dateStr;
    const formatter = new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const parts = formatter.formatToParts(d);
    let day = '', month = '', year = '', hour = '', minute = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.type === 'day') day = part.value;
      if (part.type === 'month') month = part.value;
      if (part.type === 'year') year = part.value;
      if (part.type === 'hour') hour = part.value;
      if (part.type === 'minute') minute = part.value;
    }
    return `${day} ${month} ${year}, ${hour}:${minute} WIB`;
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
