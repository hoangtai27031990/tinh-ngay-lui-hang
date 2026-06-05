/* ================================================
   SERVICE WORKER – HSD Saigon Co.op  v8
   
   Fix so với v7 (v8):
   - [F10] icon path đúng /tinh-ngay-lui-hang/
   - [F11] Thêm ca nhắc 16:30
   - [F12] Notification actions (Xem ngay / Bỏ qua)
   - [F13] notificationclick xử lý action dismiss
   ─────────────────────────
   Fix từ v6:
   - [F1] Timer tự reschedule sau khi SW wake — không mất khi bị kill
   - [F2] Bỏ setInterval trong SW (không đáng tin), dùng setTimeout tự lặp
   - [F3] Gộp nhiều cấp cảnh báo thành 1 notification duy nhất
   - [F4] Fix race condition trong maybeCheckOnOpen bằng lock đơn giản
   - [F5] Mở rộng slot cho ca sáng sớm (07:00)
   - [F6] Handshake ready khi click notification mở tab mới
   - [F7] Thêm fetch handler — offline cơ bản
   - [F8] activate tự xóa tất cả cache version cũ
   - [F9] scheduleRemind atomic — không mất firedAt khi SW bị kill giữa chừng
   ================================================ */

const SW_VERSION           = "hsd-sw-v8";
const CACHE_NAME           = "hsd-sw-meta-v8";
const CACHE_KEY_STATE      = "hsd-notif-state-v8";
const CACHE_KEY_PRODUCTS   = "hsd-products-snapshot";
const CACHE_KEY_REMIND     = "hsd-notif-remind";
const REMIND_AFTER_MS      = 2 * 60 * 60 * 1000;   /* Nhắc lại sau 2 giờ */
const WARN_BEFORE_M30_DAYS = 15;

/* ── Cài đặt ── */
self.addEventListener("install", () => self.skipWaiting());

/* ── Kích hoạt: xóa TẤT CẢ cache version cũ ── */
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(keys =>
    Promise.all(
      keys
        .filter(k => k.startsWith("hsd-sw-meta-") && k !== CACHE_NAME)
        .map(k => caches.delete(k))
    )
  ).then(() => self.clients.claim())
  .then(() => {
    /* [F1] Reschedule timer ngay khi activate (sau restart / update SW) */
    scheduleBonusTimers();
  })
));

/* ================================================
   OFFLINE FETCH HANDLER [F7]
   Cache-first cho tài nguyên tĩnh (html, js, css, icon).
   Giúp app dùng được khi mất mạng sau lần đầu mở.
   ================================================ */
const STATIC_EXTS = [".html", ".js", ".css", ".png", ".ico", ".json", ".webmanifest"];

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  const isStatic = STATIC_EXTS.some(ext => url.pathname.endsWith(ext));
  /* Chỉ cache GET, cùng origin, tài nguyên tĩnh */
  if (e.request.method !== "GET" || url.origin !== self.location.origin || !isStatic) return;

  e.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      const cached = await cache.match(e.request);
      /* Network-first: thử lấy mới, nếu fail thì dùng cache */
      try {
        const fresh = await fetch(e.request);
        if (fresh.ok) cache.put(e.request, fresh.clone());
        return fresh;
      } catch {
        return cached || fetch(e.request);
      }
    })
  );
});

/* ================================================
   CACHE HELPERS
   ================================================ */
async function getCacheJson(key) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const res   = await cache.match(key);
    if (!res) return null;
    return await res.json();
  } catch { return null; }
}

async function setCacheJson(key, obj) {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(key, new Response(JSON.stringify(obj), {
      headers: { "Content-Type": "application/json" }
    }));
  } catch {}
}

/* ================================================
   1. PERIODIC BACKGROUND SYNC
   Chrome Android – khoảng 12–24h / lần.
   ================================================ */
self.addEventListener("periodicsync", e => {
  if (e.tag === "hsd-daily-check") {
    e.waitUntil(checkWithStoredProducts("sync"));
  }
});

async function checkWithStoredProducts(source) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  if (clients.length > 0) {
    clients[0].postMessage({ type: "REQUEST_PRODUCTS", source });
    /* doCheckAndNotify sẽ được gọi qua PRODUCTS_DATA */
  } else {
    const snapshot = await getCacheJson(CACHE_KEY_PRODUCTS);
    if (snapshot && Array.isArray(snapshot.products)) {
      await maybeCheckOnOpen(snapshot.products, source);
    }
  }
}

/* ================================================
   2. NHẬN MESSAGE TỪ APP
   ================================================ */
self.addEventListener("message", e => {
  const { type, source, products } = e.data || {};

  if (type === "SCHEDULE_DAILY") {
    /* [F1] App gửi → reschedule (vd: sau khi cấp quyền) */
    scheduleBonusTimers();
  }

  if (type === "CHECK_NOW") {
    /* Test: bỏ qua dedup, bắn luôn */
    doCheckAndNotify(products || []);
  }

  if (type === "PRODUCTS_DATA") {
    const prods = products || [];
    const src   = source || "unknown";
    if (src === "timer" || src === "sync") {
      maybeCheckOnOpen(prods, src);
    } else {
      maybeCheckOnOpen(prods, "unknown");
    }
  }

  if (type === "APP_OPENED") {
    const prods = products || [];
    /* Lưu snapshot để dùng khi không có tab */
    setCacheJson(CACHE_KEY_PRODUCTS, { products: prods, savedAt: Date.now() });
    maybeCheckOnOpen(prods, "app");
    /* User đang xem app → xóa lịch nhắc lại */
    getCacheJson(CACHE_KEY_REMIND).then(prev => {
      setCacheJson(CACHE_KEY_REMIND, {
        firedAt  : (prev && prev.firedAt)   ? prev.firedAt   : 0,
        clearedAt: Date.now()
      });
    });
  }

  if (type === "PRODUCTS_COMPLETED") {
    getCacheJson(CACHE_KEY_REMIND).then(prev => {
      setCacheJson(CACHE_KEY_REMIND, {
        firedAt  : (prev && prev.firedAt)   ? prev.firedAt   : 0,
        clearedAt: Date.now()
      });
    });
  }

  /* [F6] App báo đã sẵn sàng nhận message (sau khi load xong) */
  if (type === "APP_READY") {
    const pending = _pendingNotifClick;
    if (pending) {
      _pendingNotifClick = null;
      e.source && e.source.postMessage({ type: "SHOW_NOTIF_PRODUCTS", tag: pending.tag, items: pending.items });
    }
  }
});

/* ================================================
   3. BONUS TIMER [F1][F2]
   - setTimeout tự lặp, reschedule sau mỗi lần fire
   - scheduleBonusTimers() được gọi khi: activate, SCHEDULE_DAILY, sau mỗi timer fire
   - Không dùng setInterval (SW có thể bị kill trước khi interval kịp fire)
   ================================================ */
let _t08 = null, _t14 = null, _t16 = null;

function msUntilHour(hour, minute = 0) {
  const now  = new Date();
  const next = new Date();
  next.setHours(hour, minute, 0, 0);
  if (now >= next) next.setDate(next.getDate() + 1);
  return next - now;
}

function scheduleBonusTimers() {
  /* Xóa timer cũ nếu đang chạy */
  if (_t08) { clearTimeout(_t08); _t08 = null; }
  if (_t14) { clearTimeout(_t14); _t14 = null; }
  if (_t16) { clearTimeout(_t16); _t16 = null; }

  /* 08:00 */
  _t08 = setTimeout(() => {
    checkWithStoredProducts("timer");
    /* Tự lặp lại vào 08:00 ngày hôm sau */
    _t08 = setTimeout(function loop08() {
      checkWithStoredProducts("timer");
      _t08 = setTimeout(loop08, msUntilHour(8));
    }, msUntilHour(8));
  }, msUntilHour(8));

  /* 14:00 */
  _t14 = setTimeout(() => {
    checkWithStoredProducts("timer");
    _t14 = setTimeout(function loop14() {
      checkWithStoredProducts("timer");
      _t14 = setTimeout(loop14, msUntilHour(14));
    }, msUntilHour(14));
  }, msUntilHour(14));

  /* 16:30 — ca chiều muộn */
  _t16 = setTimeout(() => {
    checkWithStoredProducts("timer");
    _t16 = setTimeout(function loop16() {
      checkWithStoredProducts("timer");
      _t16 = setTimeout(loop16, msUntilHour(16, 30));
    }, msUntilHour(16, 30));
  }, msUntilHour(16, 30));
}

/* ================================================
   3b. NHẮC LẠI SAU 2 GIỜ [F9]
   ================================================ */
let _tRemind = null;

function scheduleRemind(products) {
  if (_tRemind) clearTimeout(_tRemind);
  _tRemind = setTimeout(async () => {
    _tRemind = null;
    const remind    = await getCacheJson(CACHE_KEY_REMIND) || {};
    const firedAt   = remind.firedAt   || 0;
    const clearedAt = remind.clearedAt || 0;
    if (clearedAt > firedAt) return; /* User đã mở app sau khi bắn → bỏ qua */

    const snapshot  = await getCacheJson(CACHE_KEY_PRODUCTS);
    const prods     = (snapshot && Array.isArray(snapshot.products)) ? snapshot.products : products;
    const pending   = getPendingProducts(prods);
    if (!pending.allItems.length) return;

    /* [F9] Ghi firedAt trước khi fire để không mất nếu SW bị kill */
    await setCacheJson(CACHE_KEY_REMIND, { firedAt: Date.now(), clearedAt: clearedAt });

    const total = pending.allItems.length;
    const names = pending.allItems.map(i => i.TenSP || ("BC: " + (i.Barcode || "?")));
    fire(
      "⏰ Nhắc lại – Co.op",
      `Còn ${total} sản phẩm chưa xử lý: ${fmt(names)}`,
      "remind",
      pending.allItems
    );
  }, REMIND_AFTER_MS);
}

/* ================================================
   4. DEDUP THEO SLOT [F4][F5]
   slot = "YYYY-MM-DD-07" | "YYYY-MM-DD-08" | "YYYY-MM-DD-14"
   Dùng lock in-memory để tránh race condition.
   ================================================ */
let _checkLock = false; /* [F4] Lock đơn giản */

function todaySlot() {
  const n = new Date();
  const h = n.getHours();
  /* [F5] Mở rộng: 07:00 cho ca sáng sớm, 08:00–13:59, 14:00+ */
  let slot;
  if      (h === 7)               slot = "07";
  else if (h >= 8  && h < 14)     slot = "08";
  else if (h >= 14)                slot = "14";
  else                             return null; /* 00:00–06:59 → im lặng */
  const y = n.getFullYear();
  const m = String(n.getMonth() + 1).padStart(2, "0");
  const d = String(n.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}-${slot}`;
}

async function maybeCheckOnOpen(products, source) {
  const slot = todaySlot();
  if (!slot) return;

  /* [F4] Kiểm tra lock trước — tránh race condition */
  if (_checkLock) return;
  _checkLock = true;

  try {
    const state = await getCacheJson(CACHE_KEY_STATE) || {};
    if (state.lastSlot === slot) return;
    /* Ghi slot ngay lập tức trước khi fire */
    await setCacheJson(CACHE_KEY_STATE, { lastSlot: slot, source, firedAt: Date.now() });
    doCheckAndNotify(products);
  } finally {
    /* Giải lock sau 3 giây để tránh kẹt nếu có lỗi */
    setTimeout(() => { _checkLock = false; }, 3000);
  }
}

/* ================================================
   5. PHÂN TÍCH & BẮN THÔNG BÁO [F3]
   Gộp tất cả cấp cảnh báo thành 1 notification duy nhất.
   ================================================ */
function getPendingProducts(products) {
  if (!Array.isArray(products)) return { items30: [], items20: [], itemsExp: [], allItems: [] };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const items30 = [], items20 = [], itemsExp = [];

  products.forEach(item => {
    if (item.completed) return;
    const m30 = new Date(item.M30); if (isNaN(m30)) return; m30.setHours(0, 0, 0, 0);
    const m20 = new Date(item.M20); if (isNaN(m20)) return; m20.setHours(0, 0, 0, 0);
    const hsd = new Date(item.HSD); if (isNaN(hsd)) return; hsd.setHours(0, 0, 0, 0);

    if      (hsd <= today)  { itemsExp.push(item); }
    else if (today >= m20)  { items20.push(item);  }
    else if (today >= m30)  { items30.push(item);  }
    else {
      const diff = Math.round((m30 - today) / 86400000);
      if (diff <= WARN_BEFORE_M30_DAYS) items30.push(item);
    }
  });

  return { items30, items20, itemsExp, allItems: [...itemsExp, ...items20, ...items30] };
}

function doCheckAndNotify(products) {
  if (!Array.isArray(products) || !products.length) return;
  const { items30, items20, itemsExp, allItems } = getPendingProducts(products);
  if (!allItems.length) return;

  /* [F3] Gộp thành 1 notification duy nhất thay vì bắn nhiều cái */
  const parts = [];
  if (itemsExp.length) parts.push(`❌ ${itemsExp.length} hết hạn`);
  if (items20.length)  parts.push(`🔴 ${items20.length} rút hàng`);
  if (items30.length)  parts.push(`⚠️ ${items30.length} giải tồn`);

  const urgentTag = itemsExp.length ? "exp" : items20.length ? "20" : "30";
  const icon      = itemsExp.length ? "❌" : items20.length ? "🔴" : "⚠️";

  const names = allItems.slice(0, 3).map(i => i.TenSP || ("BC:" + (i.Barcode || "?")));
  const body  = `${parts.join("  •  ")}\n${fmt(names)}`;

  fire(`${icon} Kiểm tra HSD – Co.op`, body, urgentTag, allItems);

  /* Lưu firedAt ngay, giữ nguyên clearedAt [F9] */
  getCacheJson(CACHE_KEY_REMIND).then(prev => {
    setCacheJson(CACHE_KEY_REMIND, {
      firedAt  : Date.now(),
      clearedAt: (prev && prev.clearedAt) ? prev.clearedAt : 0
    });
  });
  scheduleRemind(products);
}

function fmt(arr) {
  return arr.slice(0, 3).join(", ") + (arr.length > 3 ? `… (+${arr.length - 3})` : "");
}

function fire(title, body, tag, items) {
  return self.registration.showNotification(title, {
    body,
    tag,
    renotify  : true,
    icon      : "/tinh-ngay-lui-hang/icon-192.png",
    badge     : "/tinh-ngay-lui-hang/icon-192.png",
    vibrate   : [200, 100, 200],
    silent    : false,
    data      : { url: self.registration.scope || "/tinh-ngay-lui-hang/", tag, items: items || [] },
    actions   : [{ action: "open", title: "Xem ngay" }, { action: "dismiss", title: "Bỏ qua" }]
  });
}

/* ================================================
   6. CLICK VÀO THÔNG BÁO [F6]
   Dùng handshake APP_READY thay vì setTimeout cố định.
   ================================================ */
let _pendingNotifClick = null;

self.addEventListener("notificationclick", e => {
  e.notification.close();
  if(e.action === "dismiss") return; /* User bấm "Bỏ qua" → không mở app */
  const { url, tag, items } = e.notification.data || {};

  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async clients => {
      if (clients.length > 0) {
        /* Tab đang mở → focus và gửi luôn */
        try { await clients[0].focus(); } catch {}
        try { clients[0].postMessage({ type: "SHOW_NOTIF_PRODUCTS", tag, items: items || [] }); } catch {}
      } else {
        /* Mở tab mới — lưu pending, app sẽ nhận khi gửi APP_READY */
        _pendingNotifClick = { tag, items: items || [] };
        try {
          await self.clients.openWindow(url || self.registration.scope);
          /* App sẽ postMessage APP_READY → SW gửi SHOW_NOTIF_PRODUCTS */
        } catch {
          _pendingNotifClick = null;
        }
      }
    })
  );
});

/* ── Khởi timer khi SW load lần đầu ── */
scheduleBonusTimers();
