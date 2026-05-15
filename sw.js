/* ================================================
   SERVICE WORKER – HSD Saigon Co.op  v4
   Chiến lược lịch thông báo đáng tin cậy:
   1. Periodic Background Sync (Chrome Android)
   2. Fallback: kiểm tra khi app được mở (iOS & mọi nền tảng)
   3. Khi SW còn sống: bonus timer (setTimeout)

   FIX v4:
   - [F1] PRODUCTS_DATA qua periodicsync cũng đi qua maybeCheckOnOpen để dedup đúng slot
   - [F2] broadcastRequestData (bonus timer) ghi rõ nguồn "timer" → maybeCheckOnOpen xử lý dedup
   - [F3] CHECK_NOW (test) bỏ qua dedup đúng mục đích — giữ nguyên nhưng rõ ràng hơn
   - [F4] Lưu products snapshot vào SW cache sau mỗi lần APP_OPENED → periodicsync có data kể cả khi không có tab
   - [F5] Không có fix ở SW (F5 là icon bell ở app chính)
   ================================================ */

const SW_VERSION = "hsd-sw-v5";
const CACHE_NAME = "hsd-sw-meta-v5";
const CACHE_KEY_STATE    = "hsd-notif-state";
const CACHE_KEY_PRODUCTS = "hsd-products-snapshot";
const CACHE_KEY_REMIND   = "hsd-notif-remind";   /* Theo dõi nhắc lại */
const REMIND_AFTER_MS    = 2 * 60 * 60 * 1000;   /* Nhắc lại sau 2 giờ */

/* ── Cài đặt & kích hoạt ── */
self.addEventListener("install",  () => self.skipWaiting());
self.addEventListener("activate", e  => e.waitUntil(
  /* Xóa cache cũ của v3, v4 khi nâng cấp */
  Promise.all([
    caches.delete("hsd-sw-meta-v3"),
    caches.delete("hsd-sw-meta-v4"),
  ]).then(() => self.clients.claim())
));

/* ================================================
   CACHE HELPERS
   ================================================ */
async function getCacheJson(key) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const res   = await cache.match(key);
    if (!res) return null;
    return await res.json();
  } catch(e) { return null; }
}

async function setCacheJson(key, obj) {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(key, new Response(JSON.stringify(obj), {
      headers: { "Content-Type": "application/json" }
    }));
  } catch(e) {}
}

/* ================================================
   1. PERIODIC BACKGROUND SYNC
   Chrome Android – khoảng 12-24h / lần.
   [F4] Nếu không có tab → dùng products snapshot từ cache.
   ================================================ */
self.addEventListener("periodicsync", e => {
  if (e.tag === "hsd-daily-check") {
    e.waitUntil(checkWithStoredProducts());
  }
});

async function checkWithStoredProducts() {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });

  if (clients.length > 0) {
    /* Có tab đang mở → yêu cầu data mới nhất, nguồn "sync" */
    clients[0].postMessage({ type: "REQUEST_PRODUCTS", source: "sync" });
    /* doCheckAndNotify sẽ được gọi qua PRODUCTS_DATA */
  } else {
    /* [F4] Không có tab → dùng snapshot đã lưu từ lần mở app trước */
    const snapshot = await getCacheJson(CACHE_KEY_PRODUCTS);
    if (snapshot && Array.isArray(snapshot.products)) {
      await maybeCheckOnOpen(snapshot.products, "sync");
    }
  }
}

/* ================================================
   2. NHẬN MESSAGE TỪ APP CHÍNH
   ================================================ */
self.addEventListener("message", e => {
  const type   = e.data && e.data.type;
  const source = e.data && e.data.source;

  if (type === "SCHEDULE_DAILY") {
    scheduleBonusTimers();
  }

  if (type === "CHECK_NOW") {
    /* [F3] Test thông báo — cố ý bỏ qua dedup để test ngay lập tức */
    doCheckAndNotify(e.data.products || []);
  }

  if (type === "PRODUCTS_DATA") {
    /* [F2] Phân biệt nguồn: timer/sync đi qua maybeCheckOnOpen để dedup đúng slot */
    const products = e.data.products || [];
    if (source === "timer" || source === "sync") {
      maybeCheckOnOpen(products, source);
    } else {
      /* Không rõ nguồn (gọi cũ) → vẫn dedup để an toàn */
      maybeCheckOnOpen(products, "unknown");
    }
  }

  if (type === "APP_OPENED") {
    const products = e.data.products || [];
    /* [F4] Lưu snapshot để periodicsync dùng khi không có tab */
    setCacheJson(CACHE_KEY_PRODUCTS, { products, savedAt: Date.now() });
    /* Kiểm tra và thông báo nếu đến slot */
    maybeCheckOnOpen(products, "app");
    /* Khi app mở → user đang xem, xóa lịch nhắc lại để không nhắc thừa */
    setCacheJson(CACHE_KEY_REMIND, { clearedAt: Date.now() });
  }

  if (type === "PRODUCTS_COMPLETED") {
    /* App báo user vừa hoàn thành xử lý → xóa lịch nhắc lại */
    setCacheJson(CACHE_KEY_REMIND, { clearedAt: Date.now() });
  }
});

/* ================================================
   3. BONUS TIMER (fallback khi SW còn sống)
   [F2] Truyền source "timer" → REQUEST_PRODUCTS → PRODUCTS_DATA
        → maybeCheckOnOpen sẽ dedup đúng cách.
   ================================================ */
let _t08 = null, _t14 = null;

function msUntilHour(hour) {
  const now  = new Date();
  const next = new Date();
  next.setHours(hour, 0, 0, 0);
  if (now >= next) next.setDate(next.getDate() + 1);
  return next - now;
}

function scheduleBonusTimers() {
  if (_t08) clearTimeout(_t08);
  if (_t14) clearTimeout(_t14);

  _t08 = setTimeout(() => {
    broadcastRequestData();
    _t08 = setInterval(broadcastRequestData, 86400000);
  }, msUntilHour(8));

  _t14 = setTimeout(() => {
    broadcastRequestData();
    _t14 = setInterval(broadcastRequestData, 86400000);
  }, msUntilHour(14));
}

/* [F2] Truyền source "timer" để PRODUCTS_DATA handler biết đây là bonus timer */
function broadcastRequestData() {
  self.clients.matchAll({ includeUncontrolled: true, type: "window" }).then(clients => {
    if (clients.length > 0) {
      clients[0].postMessage({ type: "REQUEST_PRODUCTS", source: "timer" });
    } else {
      /* Không có tab → dùng snapshot */
      getCacheJson(CACHE_KEY_PRODUCTS).then(snapshot => {
        if (snapshot && Array.isArray(snapshot.products)) {
          maybeCheckOnOpen(snapshot.products, "timer");
        }
      });
    }
  });
}

/* ================================================
   3b. NHẮC LẠI SAU 2 GIỜ
   Nếu đã bắn thông báo mà user chưa mở app xử lý,
   nhắc lại 1 lần sau REMIND_AFTER_MS.
   ================================================ */
let _tRemind = null;

function scheduleRemind(products) {
  if (_tRemind) clearTimeout(_tRemind);
  _tRemind = setTimeout(async () => {
    /* Kiểm tra xem user đã mở app / hoàn thành chưa */
    const remind = await getCacheJson(CACHE_KEY_REMIND) || {};
    const firedAt = remind.firedAt || 0;
    const clearedAt = remind.clearedAt || 0;
    /* Nếu clearedAt > firedAt → user đã mở app sau lần bắn → không nhắc */
    if (clearedAt > firedAt) return;

    /* Lấy snapshot mới nhất để kiểm tra còn sản phẩm chưa xử lý không */
    const snapshot = await getCacheJson(CACHE_KEY_PRODUCTS);
    const prods = snapshot && Array.isArray(snapshot.products) ? snapshot.products : products;
    const pending = getPendingProducts(prods);
    if (!pending.allItems.length) return;

    /* Đánh dấu đã nhắc */
    await setCacheJson(CACHE_KEY_REMIND, { firedAt: Date.now(), clearedAt: 0 });

    const total = pending.allItems.length;
    fire(
      "⏰ Nhắc lại – Co.op",
      `Còn ${total} sản phẩm chưa xử lý: ${fmt(pending.allItems.map(i => i.TenSP || ("BC: " + (i.Barcode || "?"))))}`,
      "remind",
      pending.allItems
    );
  }, REMIND_AFTER_MS);
}

/* ================================================
   4. DEDUP THEO SLOT (logic trung tâm)
   Mọi nguồn thông báo tự động (app, timer, sync) đều
   đi qua đây → tránh bắn trùng trong cùng 1 slot.
   slot = "YYYY-MM-DD-08" hoặc "YYYY-MM-DD-14"
   ================================================ */
function todaySlot() {
  const n    = new Date();
  const h    = n.getHours();
  const slot = (h >= 8 && h < 14) ? "08" : (h >= 14) ? "14" : "skip";
  if (slot === "skip") return null;
  const d = n.toISOString().slice(0, 10);
  return `${d}-${slot}`;
}

async function maybeCheckOnOpen(products, source) {
  const slot = todaySlot();
  if (!slot) return; /* Ngoài giờ 08:00–23:59 → im lặng */

  const state = await getCacheJson(CACHE_KEY_STATE) || {};
  if (state.lastSlot === slot) return; /* Đã gửi slot này rồi */

  /* Đánh dấu slot đã gửi TRƯỚC khi fire để tránh race condition */
  await setCacheJson(CACHE_KEY_STATE, { lastSlot: slot, source, firedAt: Date.now() });
  doCheckAndNotify(products);
}

/* ================================================
   5. PHÂN TÍCH DATA → BẮN THÔNG BÁO
   ================================================ */

/* Hàm dùng chung: phân loại sản phẩm cần xử lý */
function getPendingProducts(products) {
  if (!Array.isArray(products)) return { items30: [], items20: [], itemsExp: [], allItems: [] };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const items30 = [], items20 = [], itemsExp = [];

  products.forEach(item => {
    if (item.completed) return;
    const m30 = new Date(item.M30); m30.setHours(0, 0, 0, 0);
    const m20 = new Date(item.M20); m20.setHours(0, 0, 0, 0);
    const hsd = new Date(item.HSD); hsd.setHours(0, 0, 0, 0);

    if (hsd <= today)        { itemsExp.push(item); }
    else if (today >= m20)   { items20.push(item); }
    else if (today >= m30)   { items30.push(item); }
    else {
      const diff = Math.round((m30 - today) / 86400000);
      if (diff <= 15) items30.push(item);
    }
  });

  /* allItems: ưu tiên exp → 20% → 30% */
  return { items30, items20, itemsExp, allItems: [...itemsExp, ...items20, ...items30] };
}

function doCheckAndNotify(products) {
  if (!Array.isArray(products) || !products.length) return;

  const { items30, items20, itemsExp, allItems } = getPendingProducts(products);
  if (!allItems.length) return;

  /* Bắn thông báo theo mức độ khẩn — ưu tiên cao nhất lên trước */
  if (itemsExp.length) {
    const names = itemsExp.map(i => i.TenSP || ("BC: " + (i.Barcode || "?")));
    fire("❌ Sản phẩm HẾT HẠN – Co.op",
      `${itemsExp.length} SP hết hạn: ${fmt(names)}`, "exp", allItems);
  }
  if (items20.length) {
    const names = items20.map(i => i.TenSP || ("BC: " + (i.Barcode || "?")));
    fire("🔴 RÚT HÀNG ngay – Co.op",
      `${items20.length} SP qua mốc 20%: ${fmt(names)}`, "20", allItems);
  }
  if (items30.length && !itemsExp.length && !items20.length) {
    /* Chỉ bắn 30% nếu không có loại khẩn hơn */
    const names = items30.map(i => i.TenSP || ("BC: " + (i.Barcode || "?")));
    fire("⚠️ GIẢI TỒN – Co.op",
      `${items30.length} SP đến mốc 30%: ${fmt(names)}`, "30", allItems);
  }

  /* Lên lịch nhắc lại sau 2 giờ nếu chưa xử lý */
  scheduleRemind(products);
  setCacheJson(CACHE_KEY_REMIND, { firedAt: Date.now(), clearedAt: 0 });
}

function fmt(arr) { return arr.slice(0, 3).join(", ") + (arr.length > 3 ? "…" : ""); }

function fire(title, body, tag, items) {
  return self.registration.showNotification(title, {
    body,
    tag,
    renotify : true,
    icon     : "/tinh-ngay-lui-hang/icon-192.png",
    badge    : "/tinh-ngay-lui-hang/icon-192.png",
    vibrate  : [200, 100, 200],
    data     : { url: self.registration.scope, tag, items: items || [] }
  });
}

/* ================================================
   6. CLICK VÀO THÔNG BÁO → MỞ APP + HIỂN THỊ TOÀN BỘ SẢN PHẨM
   data.items luôn chứa allItems (exp + 20% + 30%) bất kể tag nào.
   ================================================ */
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const { url, tag, items } = e.notification.data || {};

  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async clients => {
      let client;
      if (clients.length > 0) {
        client = clients[0];
        await client.focus();
      } else {
        client = await self.clients.openWindow(url || "/tinh-ngay-lui-hang/");
        /* Chờ app load xong trước khi gửi message */
        await new Promise(r => setTimeout(r, 1200));
      }
      if (client && items && items.length) {
        client.postMessage({ type: "SHOW_NOTIF_PRODUCTS", tag, items });
      }
    })
  );
});

/* Khởi timer bonus ngay khi SW activate */
scheduleBonusTimers();
