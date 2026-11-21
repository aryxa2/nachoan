const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

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

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return db;
}

module.exports = getDb;
