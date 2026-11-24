const getDb = require('../lib/db');
const db = getDb();

db.prepare("DELETE FROM bundle_items WHERE bundle_id IN (SELECT id FROM bundles WHERE name LIKE 'QC %' OR slug LIKE 'qc-%')").run();
db.prepare("DELETE FROM bundles WHERE name LIKE 'QC %' OR slug LIKE 'qc-%'").run();
db.prepare("DELETE FROM order_items WHERE product_id IN (SELECT id FROM products WHERE name LIKE 'QC %' OR slug LIKE 'qc-%' OR name LIKE 'QC-TEST%')").run();
db.prepare("DELETE FROM products WHERE name LIKE 'QC %' OR slug LIKE 'qc-%' OR name LIKE 'QC-TEST%'").run();
db.prepare("DELETE FROM promotions WHERE code LIKE 'QCSPECIAL%'").run();
// Also clean test orders from the QC run
db.prepare("DELETE FROM payment_submissions WHERE order_id IN (SELECT id FROM orders WHERE customer_name LIKE '%QC%')").run();
db.prepare("DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM orders WHERE customer_name LIKE '%QC%')").run();
db.prepare("DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_name LIKE '%QC%')").run();
db.prepare("DELETE FROM orders WHERE customer_name LIKE '%QC%'").run();

console.log('Database cleanly reset to production state.');
