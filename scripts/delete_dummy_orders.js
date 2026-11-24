const getDb = require('../lib/db');
const db = getDb();
// Show orders columns
const cols = db.prepare('PRAGMA table_info(orders)').all();
console.log('Orders columns:', cols.map(c=>c.name).join(', '));
// Show sample orders
const rows = db.prepare('SELECT * FROM orders LIMIT 20').all();
console.log('Sample orders:', rows);
// Delete dummy orders where customer_name contains "Dewi Lestari"
const info = db.prepare('DELETE FROM orders WHERE customer_name LIKE ?').run('%Dewi Lestari%');
console.log('Deleted rows count:', info.changes);
