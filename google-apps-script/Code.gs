/**
 * =======================================================================
 * NACHOAN Google Apps Script Backend API (Two-Way Sync + Drive Upload)
 * Spreadsheet ID: 1YDenYpVKZVnhv5jBxp4iMdxxLMgHGOSTn3qjkBmEmJ8
 * =======================================================================
 *
 * PANDUAN DEPLOY:
 * 1. Buka link Apps Script: https://script.google.com/d/1Ejhcd1kojOqqyRBgxo6Y3d9iMNB5AT2D-1WhgjACBb1N3WdMXnEgcZ9S/edit
 * 2. Hapus semua kode lama di Code.gs, lalu PASTE SELURUH isi file ini.
 * 3. Klik menu "Deploy" (pojok kanan atas) -> "New deployment" (atau "Manage deployments" -> Edit -> New version).
 * 4. Pilih tipe: "Web app".
 * 5. Description: "NACHOAN Sync + Drive Upload v3".
 * 6. Execute as: "Me" (email Google Anda).
 * 7. Who has access: "Anyone" (Penting agar website & admin bisa sync).
 * 8. Klik "Deploy" & Authorize akses Google Sheets + Google Drive -> Salin "Web App URL" (/exec).
 * 9. Paste URL tersebut di Dashboard Admin Website NACHOAN pada Pengaturan Toko.
 */

const SPREADSHEET_ID = "1YDenYpVKZVnhv5jBxp4iMdxxLMgHGOSTn3qjkBmEmJ8";
const FOLDER_ID = "1ov09rQDC59bA_tlw7HpvlpngfPSJgcDT";
const PROOF_FOLDER_NAME = "NACHOAN - Bukti Pembayaran";
const PRODUCT_FOLDER_NAME = "NACHOAN - Foto Produk";

function getSpreadsheet() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function getOrCreateFolder(folderName) {
  const folders = DriveApp.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(folderName);
}

function getOrCreateProofFolder() {
  if (FOLDER_ID) {
    try {
      return DriveApp.getFolderById(FOLDER_ID);
    } catch (err) {
      console.warn("Folder ID fallback to name:", err);
    }
  }
  return getOrCreateFolder(PROOF_FOLDER_NAME);
}

function ensureOrdersProofColumn(oSheet) {
  const lastCol = oSheet.getLastColumn();
  if (lastCol === 0) return 17;
  const headers = oSheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const idx = headers.indexOf("Bukti Pembayaran");
  if (idx !== -1) return idx + 1;
  const targetCol = lastCol + 1;
  oSheet.getRange(1, targetCol).setValue("Bukti Pembayaran");
  return targetCol;
}

function findOrderRowIndex(oSheet, orderNumber) {
  if (!orderNumber || String(orderNumber).trim() === "") return -1;
  const data = oSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(orderNumber).trim()) {
      return i + 1;
    }
  }
  return -1;
}

function appendOrderToSheet(ss, o, items) {
  const oSheet = ss.getSheetByName("Orders");
  const oiSheet = ss.getSheetByName("OrderItems");
  if (!oSheet || !o || !o.order_number) return -1;

  const proofCol = ensureOrdersProofColumn(oSheet);
  const existingRow = findOrderRowIndex(oSheet, o.order_number);
  const nowStr = Utilities.formatDate(new Date(), "Asia/Jakarta", "yyyy-MM-dd HH:mm:ss");

  if (existingRow !== -1) {
    if (o.payment_status) oSheet.getRange(existingRow, 12).setValue(o.payment_status);
    if (o.order_status) oSheet.getRange(existingRow, 13).setValue(o.order_status);
    if (o.proof_url) oSheet.getRange(existingRow, proofCol).setValue(o.proof_url);
    oSheet.getRange(existingRow, 15).setValue(nowStr);
    return existingRow;
  }

  const itemSummary = (items || []).map(i => `${i.quantity}x ${i.name}`).join(", ");
  const rowValues = [
    o.order_number,
    nowStr,
    o.customer_name,
    o.customer_phone,
    o.method === 'delivery' ? 'Delivery' : 'Ambil di Pick Up Point',
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
  ];

  // Pad up to proofCol if sheet has extra columns
  while (rowValues.length < proofCol - 1) {
    rowValues.push("");
  }
  rowValues[proofCol - 1] = o.proof_url || "-";
  oSheet.appendRow(rowValues);

  if (oiSheet && Array.isArray(items)) {
    items.forEach((it) => {
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

  return oSheet.getLastRow();
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
 */
function doGet(e) {
  try {
    const ss = getSpreadsheet();
    const action = (e && e.parameter && e.parameter.action) ? e.parameter.action : "getAll";

    if (action === "getOrders") {
      return jsonResponse({ success: true, data: sheetToObjects(ss.getSheetByName("Orders")) });
    }

    if (action === "getProducts") {
      return jsonResponse({ success: true, data: sheetToObjects(ss.getSheetByName("Products")) });
    }

    if (action === "getBundles") {
      return jsonResponse({ success: true, data: sheetToObjects(ss.getSheetByName("Bundles")) });
    }

    if (action === "getDeliveryZones") {
      return jsonResponse({ success: true, data: sheetToObjects(ss.getSheetByName("DeliveryZones")) });
    }

    if (action === "getSettings") {
      const raw = sheetToObjects(ss.getSheetByName("StoreSettings"));
      const settings = {};
      raw.forEach(r => { settings[r.Parameter || r.Pengaturan || r.key] = r.Nilai || r.value; });
      return jsonResponse({ success: true, data: settings });
    }

    const rawSettings = sheetToObjects(ss.getSheetByName("StoreSettings"));
    const settings = {};
    rawSettings.forEach(r => { settings[r.Parameter || r.Pengaturan || r.key] = r.Nilai || r.value; });

    return jsonResponse({
      success: true,
      data: {
        orders: sheetToObjects(ss.getSheetByName("Orders")),
        products: sheetToObjects(ss.getSheetByName("Products")),
        bundles: sheetToObjects(ss.getSheetByName("Bundles")),
        deliveryZones: sheetToObjects(ss.getSheetByName("DeliveryZones")),
        settings: settings
      }
    });

  } catch (error) {
    return jsonResponse({ success: false, error: error.toString() }, 500);
  }
}

/**
 * Handle HTTP POST Requests (Website mengirim data & bukti foto ke Spreadsheet + Google Drive)
 * Actions:
 * - "createOrder"
 * - "uploadPaymentProof"
 * - "updateOrderStatus"
 * - "syncProducts"
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

    // 1. Create New Order
    if (action === "createOrder") {
      const o = payload.order;
      const items = payload.items || [];
      appendOrderToSheet(ss, o, items);
      return jsonResponse({ success: true, order_number: o.order_number });
    }

    // 2. Upload Payment Proof Photo/PDF to Google Drive + Link in Orders Sheet
    if (action === "uploadPaymentProof") {
      const orderNum = payload.order_number;
      if (!orderNum || !payload.file_base64) {
        return jsonResponse({ success: false, message: "order_number dan file_base64 wajib diisi." }, 400);
      }

      const folder = getOrCreateProofFolder();
      const bytes = Utilities.base64Decode(payload.file_base64);
      const mimeType = payload.mime_type || "image/jpeg";
      const safeName = `${orderNum}_v${payload.version || 1}_${payload.file_name || "bukti.jpg"}`;
      const blob = Utilities.newBlob(bytes, mimeType, safeName);
      const file = folder.createFile(blob);

      try {
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      } catch (shareErr) {
        // Fallback if domain policy restricts public link sharing
      }

      const fileUrl = file.getUrl();
      const oSheet = ss.getSheetByName("Orders");
      const nowStr = Utilities.formatDate(new Date(), "Asia/Jakarta", "yyyy-MM-dd HH:mm:ss");

      if (oSheet) {
        const proofCol = ensureOrdersProofColumn(oSheet);
        let rowIdx = findOrderRowIndex(oSheet, orderNum);

        if (rowIdx === -1 && payload.order) {
          const orderWithProof = { ...payload.order, order_status: "WAITING_CONFIRMATION", proof_url: fileUrl };
          rowIdx = appendOrderToSheet(ss, orderWithProof, payload.items || []);
        } else if (rowIdx !== -1) {
          oSheet.getRange(rowIdx, proofCol).setValue(fileUrl);
          oSheet.getRange(rowIdx, 13).setValue(payload.order_status || "WAITING_CONFIRMATION");
          oSheet.getRange(rowIdx, 15).setValue(nowStr);
        }
      }

      return jsonResponse({
        success: true,
        order_number: orderNum,
        fileId: file.getId(),
        fileUrl: fileUrl
      });
    }

    // 3. Update Order Status
    if (action === "updateOrderStatus") {
      const oSheet = ss.getSheetByName("Orders");
      const orderNum = payload.order_number;
      const nowStr = Utilities.formatDate(new Date(), "Asia/Jakarta", "yyyy-MM-dd HH:mm:ss");
      const rowIdx = oSheet ? findOrderRowIndex(oSheet, orderNum) : -1;

      if (rowIdx !== -1) {
        if (payload.payment_status) {
          oSheet.getRange(rowIdx, 12).setValue(payload.payment_status);
        }
        if (payload.order_status) {
          oSheet.getRange(rowIdx, 13).setValue(payload.order_status);
        }
        oSheet.getRange(rowIdx, 15).setValue(nowStr);

        return jsonResponse({ success: true, message: `Pesanan ${orderNum} berhasil diperbarui di spreadsheet.` });
      }
      return jsonResponse({ success: false, message: `Pesanan ${orderNum} tidak ditemukan di spreadsheet.` }, 404);
    }

    // 4. Upload Product Image to Google Drive
    if (action === "uploadProductImage") {
      if (!payload.file_base64) {
        return jsonResponse({ success: false, message: "file_base64 wajib diisi." }, 400);
      }
      const folder = getOrCreateFolder(PRODUCT_FOLDER_NAME);
      const bytes = Utilities.base64Decode(payload.file_base64);
      const mimeType = payload.mime_type || "image/jpeg";
      const safeName = `prod_${Date.now()}_${payload.file_name || "menu.jpg"}`;
      const blob = Utilities.newBlob(bytes, mimeType, safeName);
      const file = folder.createFile(blob);
      try {
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      } catch (shareErr) {}
      const fileId = file.getId();
      return jsonResponse({
        success: true,
        fileId: fileId,
        fileUrl: file.getUrl(),
        thumbnailUrl: `https://drive.google.com/thumbnail?id=${fileId}&sz=w1000`
      });
    }

    // 5. Sync Products Tab
    if (action === "syncProducts") {
      const pSheet = ss.getSheetByName("Products");
      if (!pSheet) {
        return jsonResponse({ success: false, message: "Sheet Products tidak ditemukan." }, 404);
      }
      const products = payload.products || [];
      pSheet.clearContents();
      pSheet.appendRow(["ID", "Nama Menu", "Harga (Rp)", "Kategori", "Status Ketersediaan", "Deskripsi", "File Gambar", "Slug", "CategoryID", "SpicyLevels"]);
      products.forEach(p => {
        pSheet.appendRow([
          p.id,
          p.name,
          p.price,
          p.category_name || "",
          p.available === 1 ? "Tersedia" : "Habis",
          p.description || "",
          p.image || "",
          p.slug || "",
          p.category_id || 1,
          p.spicy_levels || ""
        ]);
      });
      return jsonResponse({ success: true, count: products.length });
    }

    // 6. Delete Orders (Permanent Deletion Marker in Sheet)
    if (action === "deleteOrders" || action === "deleteOrder") {
      const expectedSecret = PropertiesService.getScriptProperties().getProperty("APPS_SCRIPT_SECRET");
      if (expectedSecret && expectedSecret.trim() !== "") {
        const providedSecret = payload.secret || (e && e.parameter && e.parameter.secret) || "";
        if (providedSecret !== expectedSecret) {
          return jsonResponse({ success: false, message: "Unauthorized: Invalid secret." }, 401);
        }
      }

      const oSheet = ss.getSheetByName("Orders");
      const oiSheet = ss.getSheetByName("OrderItems");
      if (!oSheet) {
        return jsonResponse({ success: false, message: "Sheet Orders tidak ditemukan." }, 404);
      }

      let orderNumbers = payload.order_numbers || (payload.order_number ? [payload.order_number] : []);
      if (!Array.isArray(orderNumbers) || orderNumbers.length === 0) {
        return jsonResponse({ success: false, message: "order_numbers wajib diisi berupa array." }, 400);
      }

      const nowStr = Utilities.formatDate(new Date(), "Asia/Jakarta", "yyyy-MM-dd HH:mm:ss");
      const results = {
        success: true,
        deleted: [],
        notFound: [],
        failed: []
      };

      for (let k = 0; k < orderNumbers.length; k++) {
        const orderNum = String(orderNumbers[k]).trim();
        if (!orderNum) continue;

        const rowIdx = findOrderRowIndex(oSheet, orderNum);
        if (rowIdx === -1) {
          results.notFound.push(orderNum);
          continue;
        }

        try {
          // Tandai status pembayaran & status pesanan sebagai DELETED
          oSheet.getRange(rowIdx, 12).setValue("DELETED");
          oSheet.getRange(rowIdx, 13).setValue("DELETED");
          oSheet.getRange(rowIdx, 15).setValue(nowStr);

          // Hapus baris item terkait di sheet OrderItems
          if (oiSheet) {
            const oiData = oiSheet.getDataRange().getValues();
            for (let r = oiData.length - 1; r >= 1; r--) {
              if (String(oiData[r][1]).trim() === orderNum) {
                oiSheet.deleteRow(r + 1);
              }
            }
          }

          results.deleted.push(orderNum);
        } catch (itemErr) {
          results.failed.push({ order_number: orderNum, error: itemErr.toString() });
        }
      }

      if (results.failed.length > 0 && results.deleted.length === 0) {
        results.success = false;
      }

      return jsonResponse(results);
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
      // 1. Jika yang diedit/dihapus adalah kolom 'Terakhir Diperbarui' (kolom 15 / O) itu sendiri, jangan timpa lagi
      if (range.getColumn() === 15) return;

      const row = range.getRow();
      // 2. Jangan isi jika baris kosong / No Pesanan (kolom 1 / A) tidak ada
      const orderNumber = sheet.getRange(row, 1).getValue();
      if (!orderNumber || String(orderNumber).trim() === "") return;

      const nowStr = Utilities.formatDate(new Date(), "Asia/Jakarta", "yyyy-MM-dd HH:mm:ss");
      sheet.getRange(row, 15).setValue(nowStr);
    }
  } catch (err) {
    // Silent catch
  }
}
