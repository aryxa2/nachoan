/**
 * NACHOAN - Persistent Shopping Cart Engine
 */
const Cart = {
  KEY: 'nachoan_cart_v1',

  get() {
    try {
      const data = localStorage.getItem(this.KEY);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      console.error('Failed to read cart', e);
      return [];
    }
  },

  save(items) {
    try {
      localStorage.setItem(this.KEY, JSON.stringify(items));
      this.updateUI();
    } catch (e) {
      console.error('Failed to save cart', e);
    }
  },

  add(item) {
    const items = this.get();
    // Match by id, type, and variant (spicy level)
    const existingIndex = items.findIndex(i => 
      i.id === item.id && 
      i.type === item.type && 
      (i.variant || '') === (item.variant || '')
    );

    if (existingIndex > -1) {
      items[existingIndex].quantity += (item.quantity || 1);
    } else {
      items.push({
        id: item.id,
        type: item.type || 'product',
        name: item.name,
        price: Number(item.price),
        quantity: Number(item.quantity) || 1,
        variant: item.variant || null,
        image: item.image || ''
      });
    }

    this.save(items);
    this.showToast(`Berhasil menambahkan ${item.name} ke keranjang!`);
  },

  updateQty(index, qty) {
    const items = this.get();
    if (items[index]) {
      const newQty = parseInt(qty, 10);
      if (newQty <= 0) {
        items.splice(index, 1);
      } else {
        items[index].quantity = newQty;
      }
      this.save(items);
    }
  },

  remove(index) {
    const items = this.get();
    if (items[index]) {
      items.splice(index, 1);
      this.save(items);
    }
  },

  clear() {
    localStorage.removeItem(this.KEY);
    this.updateUI();
  },

  count() {
    const items = this.get();
    return items.reduce((sum, item) => sum + (item.quantity || 0), 0);
  },

  subtotal() {
    const items = this.get();
    return items.reduce((sum, item) => sum + ((item.price || 0) * (item.quantity || 0)), 0);
  },

  updateUI() {
    const count = this.count();
    const subtotal = this.subtotal();

    // 1. Update header badges
    const badges = document.querySelectorAll('.cart-badge');
    badges.forEach(b => {
      b.textContent = count;
      b.style.display = count > 0 ? 'flex' : 'none';
    });

    // 2. Update sticky bottom bar
    const bar = document.getElementById('cart-sticky-bar');
    if (bar) {
      if (count > 0 && !window.location.pathname.includes('/checkout') && !window.location.pathname.includes('/order/')) {
        bar.style.display = 'flex';
        const countEl = bar.querySelector('.cart-sticky-count');
        const totalEl = bar.querySelector('.cart-sticky-total');
        if (countEl) countEl.textContent = `${count} item`;
        if (totalEl) totalEl.textContent = 'Rp' + subtotal.toLocaleString('id-ID');
      } else {
        bar.style.display = 'none';
      }
    }

    // Trigger custom event for checkout page
    window.dispatchEvent(new CustomEvent('cart-updated', { detail: { items: this.get(), count, subtotal } }));
  },

  showToast(msg) {
    let toast = document.getElementById('nachoan-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'nachoan-toast';
      toast.style.position = 'fixed';
      toast.style.bottom = '80px';
      toast.style.left = '50%';
      toast.style.transform = 'translateX(-50%)';
      toast.style.background = '#1E1E1E';
      toast.style.color = '#FFF';
      toast.style.padding = '10px 20px';
      toast.style.borderRadius = '9999px';
      toast.style.fontWeight = '700';
      toast.style.fontSize = '14px';
      toast.style.boxShadow = '0 6px 16px rgba(0,0,0,0.2)';
      toast.style.zIndex = '9999';
      toast.style.transition = 'opacity 0.3s';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    toast.style.display = 'block';

    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => { toast.style.display = 'none'; }, 300);
    }, 2200);
  }
};

document.addEventListener('DOMContentLoaded', () => {
  Cart.updateUI();
});
