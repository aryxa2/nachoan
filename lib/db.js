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

  return db;
}

module.exports = getDb;
