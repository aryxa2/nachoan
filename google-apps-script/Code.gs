/**
 * =======================================================================
 * NACHOAN Google Apps Script Backend API (Two-Way Sync)
 * Spreadsheet ID: 1YDenYpVKZVnhv5jBxp4iMdxxLMgHGOSTn3qjkBmEmJ8
 * =======================================================================
 * 
 * PANDUAN DEPLOY:
 * 1. Buka link Apps Script: https://script.google.com/d/1Ejhcd1kojOqqyRBgxo6Y3d9iMNB5AT2D-1WhgjACBb1N3WdMXnEgcZ9S/edit
 * 2. Hapus semua kode lama di Code.gs, lalu PASTE SELURUH isi file ini.
 * 3. Klik menu "Deploy" (pojok kanan atas) -> "New deployment".
 * 4. Pilih tipe: "Web app".
 * 5. Description: "NACHOAN Two-Way Sync API v2".
 * 6. Execute as: "Me" (email Google Anda).
 * 7. Who has access: "Anyone" (Penting agar website & admin bisa sync).
 * 8. Klik "Deploy" -> Salin "Web App URL" (berakhiran /exec).
 * 9. Paste URL tersebut di Dashboard Admin Website NACHOAN pada Pengaturan Toko.
 */

const SPREADSHEET_ID = "1YDenYpVKZVnhv5jBxp4iMdxxLMgHGOSTn3qjkBmEmJ8";

function getSpreadsheet() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function sheetToObjects(sheet) {
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const headers = data[0];
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = data[i][j];
    }
    rows.push(row);
  }
  return rows;
}

function jsonResponse(data, status = 200) {
  return ContentService.createTextOutput(JSON.stringify({
    status: status,
    timestamp: new Date().toISOString(),
    ...data
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Handle HTTP GET Requests (Tarik data dari Spreadsheet ke Website)
 * Endpoints:
 * - ?action=getAll
 * - ?action=getOrders
 * - ?action=getProducts
 * - ?action=getBundles
 * - ?action=getDeliveryZones
 * - ?action=getSettings
 */
function doGet(e) {
  try {
    const ss = getSpreadsheet();
    const action = (e && e.parameter && e.parameter.action) ? e.parameter.action : "getAll";

    if (action === "getOrders") {
      const sheet = ss.getSheetByName("Orders");
      const orders = sheetToObjects(sheet);
      return jsonResponse({ success: true, data: orders });
    }

    if (action === "getProducts") {
      const sheet = ss.getSheetByName("Products");
      const products = sheetToObjects(sheet);
      return jsonResponse({ success: true, data: products });
    }

    if (action === "getBundles") {
      const bSheet = ss.getSheetByName("Bundles");
      const bundles = sheetToObjects(bSheet);
      return jsonResponse({ success: true, data: bundles });
    }

    if (action === "getDeliveryZones") {
      const sheet = ss.getSheetByName("DeliveryZones");
      const zones = sheetToObjects(sheet);
      return jsonResponse({ success: true, data: zones });
    }

    if (action === "getSettings") {
      const sheet = ss.getSheetByName("StoreSettings");
      const raw = sheetToObjects(sheet);
      const settings = {};
      raw.forEach(r => { settings[r.Pengaturan || r.key] = r.Nilai || r.value; });
      return jsonResponse({ success: true, data: settings });
    }

    // Default: getAll
    const orderSheet = ss.getSheetByName("Orders");
    const prodSheet = ss.getSheetByName("Products");
    const bundleSheet = ss.getSheetByName("Bundles");
    const zoneSheet = ss.getSheetByName("DeliveryZones");
    const settingSheet = ss.getSheetByName("StoreSettings");

    const orders = sheetToObjects(orderSheet);
    const products = sheetToObjects(prodSheet);
    const bundles = sheetToObjects(bundleSheet);
    const deliveryZones = sheetToObjects(zoneSheet);
    const rawSettings = sheetToObjects(settingSheet);

    const settings = {};
    rawSettings.forEach(r => { settings[r.Pengaturan || r.key] = r.Nilai || r.value; });

    return jsonResponse({
      success: true,
      data: {
        orders: orders,
        products: products,
        bundles: bundles,
        deliveryZones: deliveryZones,
        settings: settings
      }
    });

  } catch (error) {
    return jsonResponse({ success: false, error: error.toString() }, 500);
  }
}

/**
 * Handle HTTP POST Requests (Website mengirim data ke Spreadsheet)
 * Endpoints:
 * - action: "createOrder"
 * - action: "updateOrderStatus"
 * - action: "bulkUpdateOrders"
 */
function doPost(e) {
  try {
    const ss = getSpreadsheet();
    let payload = {};

    if (e && e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    } else if (e && e.parameter) {
      payload = e.parameter;
    }

    const action = payload.action;

    // 1. Create New Order (Append row to Orders & OrderItems)
    if (action === "createOrder") {
      const oSheet = ss.getSheetByName("Orders");
      const oiSheet = ss.getSheetByName("OrderItems");
      const o = payload.order;
      const items = payload.items || [];
      const itemSummary = items.map(i => `${i.quantity}x ${i.name}`).join(", ");

      const nowStr = Utilities.formatDate(new Date(), "Asia/Jakarta", "yyyy-MM-dd HH:mm:ss");

      oSheet.appendRow([
        o.order_number,
        nowStr,
        o.customer_name,
        o.customer_phone,
        o.method === 'delivery' ? 'Delivery' : 'Ambil di Toko',
        o.method === 'delivery' ? 'Diluar Telkom' : '-',
        o.address || '-',
        itemSummary,
        o.subtotal,
        o.delivery_fee || 0,
        o.total,
        o.payment_status || "UNPAID",
        o.order_status || "NEW",
        o.notes || "-",
        nowStr,
        o.access_token || ""
      ]);

      if (oiSheet) {
        items.forEach((it, idx) => {
          oiSheet.appendRow([
            oiSheet.getLastRow(),
            o.order_number,
            it.name,
            it.price,
            it.quantity,
            it.price * it.quantity,
            it.variant || "-"
          ]);
        });
      }

      return jsonResponse({ success: true, order_number: o.order_number });
    }

    // 2. Update Order Status
    if (action === "updateOrderStatus") {
      const oSheet = ss.getSheetByName("Orders");
      const data = oSheet.getDataRange().getValues();
      const orderNum = payload.order_number;
      const nowStr = Utilities.formatDate(new Date(), "Asia/Jakarta", "yyyy-MM-dd HH:mm:ss");

      for (let i = 1; i < data.length; i++) {
        if (String(data[i][0]).trim() === String(orderNum).trim()) {
          // Column 11: Status Pembayaran (L)
          if (payload.payment_status) {
            oSheet.getRange(i + 1, 12).setValue(payload.payment_status);
          }
          // Column 12: Status Pesanan (M)
          if (payload.order_status) {
            oSheet.getRange(i + 1, 13).setValue(payload.order_status);
          }
          // Column 14: Terakhir Diperbarui (O)
          oSheet.getRange(i + 1, 15).setValue(nowStr);

          return jsonResponse({ success: true, message: `Pesanan ${orderNum} berhasil diperbarui di spreadsheet.` });
        }
      }
      return jsonResponse({ success: false, message: `Pesanan ${orderNum} tidak ditemukan di spreadsheet.` }, 404);
    }

    return jsonResponse({ success: false, message: "Action tidak dikenali." }, 400);

  } catch (error) {
    return jsonResponse({ success: false, error: error.toString() }, 500);
  }
}

/**
 * Otomatis memperbarui kolom 'Terakhir Diperbarui' saat ada edit manual di Google Sheet
 */
function onEdit(e) {
  try {
    const range = e.range;
    const sheet = range.getSheet();
    if (sheet.getName() === "Orders" && range.getRow() > 1) {
      const nowStr = Utilities.formatDate(new Date(), "Asia/Jakarta", "yyyy-MM-dd HH:mm:ss");
      // Set Column 15 (Terakhir Diperbarui)
      sheet.getRange(range.getRow(), 15).setValue(nowStr);
    }
  } catch (err) {
    // Silent catch
  }
}
