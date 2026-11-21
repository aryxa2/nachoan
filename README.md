# 🌮 NACHOAN - Good Food. Good Mood. Extra Crunch.

Aplikasi pemesanan camilan nachos modern dalam kemasan cone ergonomis anti-tumpah, lengkap dengan katalog menu, keranjang belanja real-time, sistem checkout cerdas, integrasi QRIS, sinkronisasi dua arah Google Sheets via Google Apps Script, dan Admin Panel dengan manajemen Hero Carousel interaktif.

---

## 🌟 Fitur Utama

### 📱 Sisi Pelanggan (Customer Experience)
- **Hero Carousel Interaktif**: Banner visual berputar dinamis dengan kontrol panah, indikator titik, auto-play, dan dukungan sentuh/swipe.
- **Menu Utama & Bundling**:
  - **Beefy Nacho**: Rp25.000 (Nachos cone dengan keju leleh & limpahan daging sapi cincang).
  - **Cheezy Corn**: Rp22.000 (Nachos cone dengan jagung manis segar & keju gurih).
  - Menu minuman & paket bundling berstatus *Coming Soon*.
- **Keranjang Belanja Real-Time**: Hitung otomatis subtotal, diskon voucher, dan ongkir.
- **Zona Pengiriman Transparan**:
  - Pickup di Outlet (Gratis / Rp0).
  - Diluar Telkom (Rp2.000).
- **Voucher Promo Otomatis**: Kode promo `NACHO10` (diskon 10%) dan `HEMAT5` (potongan Rp5.000).
- **Pembayaran QRIS & Upload Bukti**: Halaman pelacakan pesanan dengan QRIS dinamis dan fitur unggah bukti transfer.
- **Kontak & Outlet**: Tombol kontak WhatsApp langsung terhubung ke admin dengan pesan template.

### 🛡️ Sisi Admin (Admin Dashboard & Management)
- **Kelola Hero Carousel (`/admin/carousel`)**:
  - Upload foto slide baru langsung dari komputer.
  - Pilih atau masukkan URL foto produk yang tersedia.
  - Atur judul, caption, tombol link, dan nomor urutan tampil (*sort order*).
  - Aktifkan atau sembunyikan slide dengan 1 klik toggle.
- **Kelola Pesanan (`/admin/orders`)**:
  - Filter pesanan berdasarkan status (`ALL`, `UNPAID`, `WAITING_CONFIRMATION`, `PAID`, `PREPARING`, `READY`, `COMPLETED`, `CANCELLED`, `REJECTED`).
  - Fitur **Bulk CRUD**: Update status massal dan hapus pesanan terpilih.
  - Input pesanan manual via modal.
  - Verifikasi bukti pembayaran dengan alasan terstruktur jika menolak.
- **Sinkronisasi Dua Arah Google Sheets (`/admin/orders/pull-sheets` & `/push-sheets`)**:
  - Sinkronisasi otomatis dan manual antara database lokal SQLite dan Google Spreadsheet via Google Apps Script Web App.
- **Menu Produk & Bundling (`/admin/products`, `/admin/bundles`)**: Edit harga, nama, deskripsi, dan ketersediaan menu.
- **Pengaturan & QRIS (`/admin/settings`)**: Ubah informasi toko dan upload banner QRIS baru.

---

## 🚀 Panduan Menjalankan Aplikasi

### 1. Prasyarat
- [Node.js](https://nodejs.org/) (versi 18 ke atas disarankan)
- Git

### 2. Instalasi & Setup
```bash
# Clone repository
git clone https://github.com/aryxa2/nachoan.git
cd nachoan

# Install dependencies
npm install

# Seed database awal
npm run seed

# Jalankan server
npm start
```
Server akan berjalan di: **`http://localhost:3000`**

### 3. Akun Admin Default
- **URL Login**: `http://localhost:3000/admin/login`
- **Username**: `admin`
- **Password**: `nachoan2026`

---

## 🧪 Menjalankan Pengujian (Testing)

Untuk memverifikasi fungsionalitas cart, pricing, voucher, dan hero carousel:
```bash
npm test
```

---

## 📊 Google Spreadsheet & Apps Script Integration
- **Google Spreadsheet**: [Link Spreadsheet NACHOAN](https://docs.google.com/spreadsheets/d/1YDenYpVKZVnhv5jBxp4iMdxxLMgHGOSTn3qjkBmEmJ8/edit?usp=sharing)
- Kode Apps Script tersedia di folder `google-apps-script/Code.gs`.
