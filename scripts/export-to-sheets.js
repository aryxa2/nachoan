const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const getDb = require('../lib/db');

const SPREADSHEET_ID = '1YDenYpVKZVnhv5jBxp4iMdxxLMgHGOSTn3qjkBmEmJ8';
const db = getDb();

const tmpDir = path.join(__dirname, '..', 'storage', 'csv_export');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

function toCSV(headers, rows) {
  const escapeCol = (val) => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };
  const headerLine = headers.map(escapeCol).join(',');
  const rowLines = rows.map(r => headers.map(h => escapeCol(r[h])).join(','));
  return [headerLine, ...rowLines].join('\n');
}

// 1. Products
const products = db.prepare(`
  SELECT p.id, p.category_id, COALESCE(c.name, '') as category_name, p.name, p.slug, p.description, p.price, p.image, p.spicy_levels, p.available, p.archived
  FROM products p
  LEFT JOIN categories c ON p.category_id = c.id
`).all();
const prodHeaders = ['id', 'category_id', 'category_name', 'name', 'slug', 'description', 'price', 'image', 'spicy_levels', 'available', 'archived'];
const prodCSV = toCSV(prodHeaders, products);
const prodFile = path.join(tmpDir, 'products.csv');
fs.writeFileSync(prodFile, prodCSV, 'utf8');

// 2. Bundles
const bundles = db.prepare('SELECT id, name, slug, description, price, compare_price, image, available, archived FROM bundles').all();
const bundleHeaders = ['id', 'name', 'slug', 'description', 'price', 'compare_price', 'image', 'available', 'archived'];
const bundleCSV = toCSV(bundleHeaders, bundles);
const bundleFile = path.join(tmpDir, 'bundles.csv');
fs.writeFileSync(bundleFile, bundleCSV, 'utf8');

// 3. BundleItems
const bundleItems = db.prepare(`
  SELECT bi.id, bi.bundle_id, bi.product_id, p.name as product_name, bi.quantity
  FROM bundle_items bi
  JOIN products p ON bi.product_id = p.id
`).all();
const biHeaders = ['id', 'bundle_id', 'product_id', 'product_name', 'quantity'];
const biCSV = toCSV(biHeaders, bundleItems);
const biFile = path.join(tmpDir, 'bundle_items.csv');
fs.writeFileSync(biFile, biCSV, 'utf8');

// 4. Promotions
const promos = db.prepare('SELECT id, code, type, value, gift_product_id, min_purchase, eligible_type, active, description FROM promotions').all();
const promoHeaders = ['id', 'code', 'type', 'value', 'gift_product_id', 'min_purchase', 'eligible_type', 'active', 'description'];
const promoCSV = toCSV(promoHeaders, promos);
const promoFile = path.join(tmpDir, 'promotions.csv');
fs.writeFileSync(promoFile, promoCSV, 'utf8');

// 5. StoreSettings
const settings = db.prepare('SELECT key, value FROM store_settings').all();
const setHeaders = ['key', 'value'];
const setCSV = toCSV(setHeaders, settings);
const setFile = path.join(tmpDir, 'store_settings.csv');
fs.writeFileSync(setFile, setCSV, 'utf8');

// 6. DeliveryZones
const deliveryZones = db.prepare('SELECT id, name, fee, active FROM delivery_zones').all();
const dzHeaders = ['id', 'name', 'fee', 'active'];
const dzCSV = toCSV(dzHeaders, deliveryZones);
const dzFile = path.join(tmpDir, 'delivery_zones.csv');
fs.writeFileSync(dzFile, dzCSV, 'utf8');

// 7. Orders
const orders = db.prepare('SELECT id, order_number, access_token, customer_name, customer_phone, method, address, delivery_fee, notes, subtotal, discount, promo_code, total, payment_status, order_status, created_at FROM orders').all();
const ordHeaders = ['id', 'order_number', 'access_token', 'customer_name', 'customer_phone', 'method', 'address', 'delivery_fee', 'notes', 'subtotal', 'discount', 'promo_code', 'total', 'payment_status', 'order_status', 'created_at'];
const ordCSV = toCSV(ordHeaders, orders);
const ordFile = path.join(tmpDir, 'orders.csv');
fs.writeFileSync(ordFile, ordCSV, 'utf8');

// 8. OrderItems
const orderItems = db.prepare('SELECT id, order_id, product_id, bundle_id, name, variant, price, quantity, is_gift, components FROM order_items').all();
const oiHeaders = ['id', 'order_id', 'product_id', 'bundle_id', 'name', 'variant', 'price', 'quantity', 'is_gift', 'components'];
const oiCSV = toCSV(oiHeaders, orderItems);
const oiFile = path.join(tmpDir, 'order_items.csv');
fs.writeFileSync(oiFile, oiCSV, 'utf8');

console.log('CSVs generated successfully in', tmpDir);

// Now import into spreadsheet using gsheets CLI
const imports = [
  { sheet: 'Products', file: prodFile },
  { sheet: 'Bundles', file: bundleFile },
  { sheet: 'BundleItems', file: biFile },
  { sheet: 'Promotions', file: promoFile },
  { sheet: 'StoreSettings', file: setFile },
  { sheet: 'DeliveryZones', file: dzFile },
  { sheet: 'Orders', file: ordFile },
  { sheet: 'OrderItems', file: oiFile },
];

for (const imp of imports) {
  try {
    console.log(`Importing ${imp.sheet}...`);
    execSync(`gsheets mutate import-csv ${SPREADSHEET_ID} "${imp.file}" --sheet "${imp.sheet}"`, { stdio: 'inherit' });
    console.log(`✔ Imported ${imp.sheet}`);
  } catch (err) {
    console.error(`Failed to import ${imp.sheet}:`, err.message);
  }
}

console.log('All initial data exported to Google Sheets!');
