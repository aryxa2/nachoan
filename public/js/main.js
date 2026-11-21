/**
 * NACHOAN - Main Application Scripts
 */

// Mobile navigation toggle
document.addEventListener('DOMContentLoaded', () => {
  const toggleBtn = document.getElementById('mobile-toggle-btn');
  const mobileMenu = document.getElementById('mobile-menu');

  if (toggleBtn && mobileMenu) {
    toggleBtn.addEventListener('click', () => {
      mobileMenu.classList.toggle('open');
    });
  }
});

// Copy to Clipboard Utility
function copyToClipboard(text, successMsg = 'Tersalin!') {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => {
      Cart.showToast(successMsg);
    }).catch(err => {
      fallbackCopy(text, successMsg);
    });
  } else {
    fallbackCopy(text, successMsg);
  }
}

function fallbackCopy(text, successMsg) {
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.left = '-999999px';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    document.execCommand('copy');
    Cart.showToast(successMsg);
  } catch (err) {
    console.error('Fallback copy failed', err);
  }
  document.body.removeChild(textArea);
}

// Generate or get client idempotency key
function getIdempotencyKey() {
  let key = sessionStorage.getItem('nachoan_idempotency_key');
  if (!key) {
    key = 'idemp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
    sessionStorage.setItem('nachoan_idempotency_key', key);
  }
  return key;
}

// Polling for Order Page
function initOrderPolling(token, currentStatus, currentPaymentStatus) {
  if (!token) return;

  // Poll every 6 seconds if status is still pending or not completed/cancelled
  const terminalStatuses = ['COMPLETED', 'CANCELLED'];
  if (terminalStatuses.includes(currentStatus)) return;

  const interval = setInterval(async () => {
    try {
      const res = await fetch(`/api/order/${token}/status`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.success) {
        if (data.order_status !== currentStatus || data.payment_status !== currentPaymentStatus) {
          // Status changed! Refresh page to update view
          console.log('Status updated, reloading page...');
          window.location.reload();
        }
      }
    } catch (e) {
      console.warn('Polling error:', e);
    }
  }, 6000);
}
