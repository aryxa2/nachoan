const path = require('path');
const fs = require('fs');

function openDatabase(dbPath) {
  try {
    const Database = require('better-sqlite3');
    return new Database(dbPath);
  } catch (err) {
    // ponytail: fallback to Node 22.5+ built-in node:sqlite when better-sqlite3 native binary isn't built
    const { DatabaseSync } = require('node:sqlite');
    const nativeDb = new DatabaseSync(dbPath, {
      allowBareNamedParameters: true,
      allowUnknownNamedParameters: true,
    });
    nativeDb.pragma = (sql) => nativeDb.exec(`PRAGMA ${sql}`);
    nativeDb.transaction = (fn) => (...args) => {
      nativeDb.exec('BEGIN');
      try {
        const result = fn(...args);
        nativeDb.exec('COMMIT');
        return result;
      } catch (txErr) {
        nativeDb.exec('ROLLBACK');
        throw txErr;
      }
    };
    return nativeDb;
  }
}

let db;

function getDb() {
  if (db) return db;

  let dbPath;

  if (process.env.VERCEL) {
    // Vercel serverless environment: root filesystem is read-only, copy to /tmp
    const tmpDir = '/tmp';
    const tmpDbPath = path.join(tmpDir, 'nachoan.db');
    const bundledDbPath = path.join(__dirname, '..', 'database', 'nachoan.db');

    if (!fs.existsSync(tmpDbPath)) {
      if (fs.existsSync(bundledDbPath)) {
        fs.copyFileSync(bundledDbPath, tmpDbPath);
      }
    }
    dbPath = tmpDbPath;
  } else {
    const dbDir = path.join(__dirname, '..', 'database');
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    dbPath = path.join(dbDir, 'nachoan.db');
  }

  db = openDatabase(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Ensure payment_submissions.drive_url exists on existing SQLite databases
  try {
    const cols = db.prepare("PRAGMA table_info(payment_submissions)").all();
    if (cols.length > 0 && !cols.some(c => c.name === 'drive_url')) {
      db.exec('ALTER TABLE payment_submissions ADD COLUMN drive_url TEXT');
    }
  } catch (e) {}

  // Ensure deleted_orders tombstone table exists
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS deleted_orders (
        order_number TEXT PRIMARY KEY,
        access_token TEXT,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_deleted_orders_token ON deleted_orders(access_token);
    `);
  } catch (e) {}

  // Ensure orders.referral_code exists on existing SQLite databases
  try {
    const orderCols = db.prepare("PRAGMA table_info(orders)").all();
    if (orderCols.length > 0 && !orderCols.some(c => c.name === 'referral_code')) {
      db.exec('ALTER TABLE orders ADD COLUMN referral_code TEXT');
    }
  } catch (e) {}

  // Ensure Add-on category (id=5) exists on existing SQLite databases
  try {
    const catCols = db.prepare("PRAGMA table_info(categories)").all();
    if (catCols.length > 0) {
      db.prepare("INSERT OR IGNORE INTO categories (id, name, slug, sort_order) VALUES (5, 'Add-on', 'add-on', 5)").run();
    }
  } catch (e) {}

  return db;
}

module.exports = getDb;
