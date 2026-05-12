/* ================================================
   SERVICE WORKER – HSD Saigon Co.op
   Nhắc kiểm date lúc 08:00 & 14:00 hàng ngày
   ================================================ */

const SW_VERSION = "hsd-sw-v2";

/* ── Cài đặt SW ── */
self.addEventListener("install", e => {
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(self.clients.claim());
});

/* ================================================
   NHẬN MESSAGE TỪ APP CHÍNH
   ================================================ */
self.addEventListener("message", e => {
  if(e.data && e.data.type === "SCHEDULE_DAILY"){
    scheduleDailyCheck();
  }
  if(e.data && e.data.type === "CHECK_NOW"){
    doCheckAndNotify(e.data.products || []);
  }
  if(e.data && e.data.type === "PRODUCTS_DATA"){
    doCheckAndNotify(e.data.products || []);
  }
});

/* ================================================
   LẬP LỊCH 08:00 & 14:00 MỖI NGÀY
   ================================================ */
let timer08 = null;
let timer14 = null;

function msUntilHour(hour){
  const now  = new Date();
  const next = new Date();
  next.setHours(hour, 0, 0, 0);
  if(now >= next) next.setDate(next.getDate() + 1);
  return next - now;
}

function scheduleAt(hour, timerRef){
  return setTimeout(() => {
    broadcastRequestData();
    // Lặp lại mỗi 24h
    setInterval(() => broadcastRequestData(), 24 * 60 * 60 * 1000);
  }, msUntilHour(hour));
}

function scheduleDailyCheck(){
  if(timer08) clearTimeout(timer08);
  if(timer14) clearTimeout(timer14);
  timer08 = scheduleAt(8,  timer08);
  timer14 = scheduleAt(14, timer14);
}

/* Gửi message xuống tất cả tab đang mở để lấy data */
function broadcastRequestData(){
  self.clients.matchAll({ includeUncontrolled: true, type: "window" }).then(clients => {
    if(clients.length > 0){
      clients[0].postMessage({ type: "REQUEST_PRODUCTS" });
    }
    // Không có tab nào mở → bỏ qua
  });
}

/* ================================================
   PHÂN TÍCH DATA → BẮN THÔNG BÁO
   ================================================ */
function doCheckAndNotify(products){
  if(!products.length) return;

  const today = new Date(); today.setHours(0,0,0,0);

  let list30  = [];
  let list20  = [];
  let listExp = [];

  products.forEach(item => {
    if(item.completed) return;

    const m30 = new Date(item.M30); m30.setHours(0,0,0,0);
    const m20 = new Date(item.M20); m20.setHours(0,0,0,0);
    const hsd = new Date(item.HSD); hsd.setHours(0,0,0,0);

    const name = item.TenSP || ("Barcode: " + (item.Barcode || "?"));

    if(hsd <= today){
      listExp.push(name);
    } else if(today >= m20){
      list20.push(name);
    } else if(today >= m30){
      list30.push(name);
    } else {
      const diff = Math.round((m30 - today) / 86400000);
      if(diff <= 3) list30.push(name + ` (còn ${diff} ngày đến mốc 30%)`);
    }
  });

  if(listExp.length){
    fireNotification(
      "❌ Sản phẩm HẾT HẠN – Saigon Co.op",
      `${listExp.length} sản phẩm đã hết hạn: ${listExp.slice(0,3).join(", ")}${listExp.length > 3 ? "…" : ""}`,
      "exp"
    );
  }
  if(list20.length){
    fireNotification(
      "🔴 Cần RÚT HÀNG ngay – Saigon Co.op",
      `${list20.length} sản phẩm đã qua mốc 20%: ${list20.slice(0,3).join(", ")}${list20.length > 3 ? "…" : ""}`,
      "20"
    );
  }
  if(list30.length){
    fireNotification(
      "⚠️ Cần GIẢI TỒN – Saigon Co.op",
      `${list30.length} sản phẩm đến mốc 30%: ${list30.slice(0,3).join(", ")}${list30.length > 3 ? "…" : ""}`,
      "30"
    );
  }
  // Không có sản phẩm cần xử lý → im lặng
}

function fireNotification(title, body, tag){
  self.registration.showNotification(title, {
    body,
    tag,
    renotify: true,
    icon:    "/icon-192.png",
    badge:   "/icon-192.png",
    vibrate: [200, 100, 200],
    data: { url: self.registration.scope }
  });
}

/* Khi bấm vào thông báo → mở app */
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
      if(clients.length > 0){
        clients[0].focus();
      } else {
        self.clients.openWindow(e.notification.data.url || "/tinh-ngay-lui-hang/");
      }
    })
  );
});

/* Khởi động lịch ngay khi SW được activate */
scheduleDailyCheck();
