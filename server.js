const express = require('express');
const session = require('express-session');
const path = require('path');
const getDb = require('./lib/db');
const { formatRupiah } = require('./lib/helpers');

const app = express();
const PORT = process.env.PORT || 3000;

// --- View engine ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- Static files ---
app.use(express.static(path.join(__dirname, 'public')));
if (process.env.VERCEL) {
  app.use('/uploads', express.static(path.join('/tmp', 'uploads')));
}

// --- Body parsers ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Session ---
app.use(session({
  secret: process.env.SESSION_SECRET || 'nachoan-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true,
  },
}));

// --- Global locals ---
app.use((req, res, next) => {
  res.locals.formatRupiah = formatRupiah;
  res.locals.admin = req.session.admin || null;
  res.locals.path = req.path;
  res.locals.req = req;

  // Load store settings
  try {
    const db = getDb();
    const rows = db.prepare('SELECT key, value FROM store_settings').all();
    const settings = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    res.locals.settings = settings;
  } catch (e) {
    res.locals.settings = {};
  }

  next();
});

// --- Routes ---
const customerRoutes = require('./routes/customer');
const adminRoutes = require('./routes/admin');
const apiRoutes = require('./routes/api');

app.use('/', customerRoutes);
app.use('/admin', adminRoutes);
app.use('/api', apiRoutes);

// --- 404 handler ---
app.use((req, res) => {
  res.status(404).render('error', { title: '404 - Halaman tidak ditemukan', message: 'Halaman yang Anda cari tidak ditemukan.' });
});

// --- Global error handler ---
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).render('error', { title: 'Terjadi Kesalahan', message: 'Terjadi kesalahan pada server.' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`NACHOAN server running at http://localhost:${PORT}`);
  });
}

module.exports = app;
