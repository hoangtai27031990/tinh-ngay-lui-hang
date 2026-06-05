/* ================================================
   SERVICE WORKER – HSD Saigon Co.op  v8

   Fix so với v7:
   - [F10] Bỏ scheduleBonusTimers() ở cuối file — chỉ gọi trong activate
           tránh double-call làm reset timer
   - [F11] _checkLock dùng cache thay vì in-memory — không bị mất khi SW restart
   - [F12] Slot window rộng hơn: 07:30–08:30 và 13:30–14:30
           để bù cho SW wake-up delay
   - [F13] APP_OPENED luôn kiểm tra nếu chưa fire slot hôm nay
           (fallback khi timer/sync không chạy được)
   - [F14] Thêm ghi chú rõ giới hạn iOS: không có thông báo nền thật,
           chỉ báo khi user mở PWA
   ================================================ */

const SW_VERSION           = "hsd-sw-v8";
const CACHE_NAME           = "hsd-sw-meta-v8";
const CACHE_KEY_STATE      = "hsd-notif-state";
const CACHE_KEY_PRODUCTS   = "hsd-products-snapshot";
const CACHE_KEY_REMIND     = "hsd-notif-remind";
const CACHE_KEY_LOCK       = "hsd-check-lock";        /* [F11] */
const REMIND_AFTER_MS      = 2 * 60 * 60 * 1000;
const WARN_BEFORE_M30_DAYS = 15;

/* ── Cài đặt ── */
self.addEventListener("install", () => self.skipWaiting());

/* ── Kích hoạt: xóa cache version cũ ── */
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(keys =>
    Promise.all(
      keys
        .filter(k => k.startsWith("hsd-sw-meta-") && k !== CACHE_NAME)
        .map(k => caches.delete(k))
    )
  )
  .then(() => self.clients.claim())
  .then(() => {
    /* [F10] Chỉ gọi ở đây — không gọi thêm ở cuối file */
    scheduleBonusTimers();
  })
));

/* ================================================
   OFFLINE FETCH HANDLER
   ================================================ */
const STATIC_EXTS = [".html", ".js", ".css", ".png", ".ico", ".json", ".webmanifest"];

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  const isStatic = STATIC_EXTS.some(ext => url.pathname.endsWith(ext));
  if (e.request.method !== "GET" || url.origin !== self.location.origin || !isStatic) return;

  e.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      const cached = await cache.match(e.request);
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
   PERIODIC BACKGROUND SYNC
   Chrome Android — khoảng 12–24h / lần.
   Đây là cơ chế DUY NHẤT đáng tin cho Android nền.
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
  } else {
    const snapshot = await getCacheJson(CACHE_KEY_PRODUCTS);
    if (snapshot && Array.isArray(snapshot.products)) {
      await maybeCheckOnOpen(snapshot.products, source);
    }
  }
}

/* ================================================
   NHẬN MESSAGE TỪ APP
   ================================================ */
self.addEventListener("message", e => {
  const { type, source, products } = e.data || {};

  if (type === "SCHEDULE_DAILY") {
    scheduleBonusTimers();
  }

  if (type === "CHECK_NOW") {
    /* Test: bỏ qua dedup, bắn luôn */
    doCheckAndNotify(products || []);
  }

  if (type === "PRODUCTS_DATA") {
    const prods = products || [];
    const src   = source || "unknown";
    maybeCheckOnOpen(prods, src);
  }

  if (type === "APP_OPENED") {
    const prods = products || [];
    /* Lưu snapshot để dùng khi không có tab */
    setCacheJson(CACHE_KEY_PRODUCTS, { products: prods, savedAt: Date.now() });

    /* [F13] APP_OPENED luôn thử kiểm tra —
       đây là fallback quan trọng cho iOS và Android khi timer/sync không chạy */
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

  if (type === "APP_READY") {
    const pending = _pendingNotifClick;
    if (pending) {
      _pendingNotifClick = null;
      e.source && e.source.postMessage({ type: "SHOW_NOTIF_PRODUCTS", tag: pending.tag, items: pending.items });
    }
  }
});

/* ================================================
   BONUS TIMER [F10]
   setTimeout tự lặp — chỉ BACKUP cho Periodic Sync.
   Android: SW thường bị kill sau ~30s không hoạt động,
   nên timer này chỉ fire được nếu có tab đang mở
   hoặc SW vừa được wake bởi event khác.

   [F10] scheduleBonusTimers() CHỈ gọi từ activate + SCHEDULE_DAILY
   KHÔNG gọi ở cuối file để tránh double-call reset timer.
   ================================================ */
let _t08 = null, _t14 = null;

function msUntilHour(hour, minute = 0) {
  const now  = new Date();
  const next = new Date();
  next.setHours(hour, minute, 0, 0);
  if (now >= next) next.setDate(next.getDate() + 1);
  return next - now;
}

function scheduleBonusTimers() {
  if (_t08) { clearTimeout(_t08); _t08 = null; }
  if (_t14) { clearTimeout(_t14); _t14 = null; }

  /* 08:00 */
  _t08 = setTimeout(function fire08() {
    checkWithStoredProducts("timer");
    _t08 = setTimeout(fire08, msUntilHour(8));
  }, msUntilHour(8));

  /* 14:00 */
  _t14 = setTimeout(function fire14() {
    checkWithStoredProducts("timer");
    _t14 = setTimeout(fire14, msUntilHour(14));
  }, msUntilHour(14));
}

/* ================================================
   NHẮC LẠI SAU 2 GIỜ
   ================================================ */
let _tRemind = null;

function scheduleRemind(products) {
  if (_tRemind) clearTimeout(_tRemind);
  _tRemind = setTimeout(async () => {
    _tRemind = null;
    const remind    = await getCacheJson(CACHE_KEY_REMIND) || {};
    const firedAt   = remind.firedAt   || 0;
    const clearedAt = remind.clearedAt || 0;
    if (clearedAt > firedAt) return;

    const snapshot  = await getCacheJson(CACHE_KEY_PRODUCTS);
    const prods     = (snapshot && Array.isArray(snapshot.products)) ? snapshot.products : products;
    const pending   = getPendingProducts(prods);
    if (!pending.allItems.length) return;

    await setCacheJson(CACHE_KEY_REMIND, { firedAt: Date.now(), clearedAt });

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
   DEDUP THEO SLOT [F11][F12]

   [F12] Mở rộng window slot:
     07:30–08:29 → slot "08"  (ca sáng, bù wake-up delay)
     13:30–14:29 → slot "14"  (ca chiều)
     14:30+      → slot "14b" (cho phép fire thêm 1 lần nếu 14:00 bị miss)
     00:00–07:29 → null (im lặng)

   [F11] Lock dùng cache — không mất khi SW restart
   ================================================ */

function todaySlot() {
  const n = new Date();
  const h = n.getHours();
  const m = n.getMinutes();
  const hm = h * 60 + m;

  let slot;
  if      (hm >= 7*60+30  && hm < 8*60+30)  slot = "08";
  else if (hm >= 13*60+30 && hm < 14*60+30) slot = "14";
  else if (hm >= 14*60+30 && hm < 20*60)    slot = "14b";
  else if (hm >= 8*60+30  && hm < 13*60+30) slot = null; /* giữa 2 ca → im lặng */
  else                                        return null; /* đêm → im lặng */

  if (!slot) return null;
  const y = n.getFullYear();
  const mo = String(n.getMonth() + 1).padStart(2, "0");
  const d  = String(n.getDate()).padStart(2, "0");
  return `${y}-${mo}-${d}-${slot}`;
}

async function maybeCheckOnOpen(products, source) {
  const slot = todaySlot();
  if (!slot) return;

  /* [F11] Lock dùng cache thay vì in-memory
     Nếu lock cũ hơn 10 giây → coi như đã giải phóng (SW không bị kill giữa chừng) */
  const lockData = await getCacheJson(CACHE_KEY_LOCK);
  const now      = Date.now();
  if (lockData && lockData.slot === slot && (now - lockData.at) < 10000) return;

  /* Ghi lock ngay */
  await setCacheJson(CACHE_KEY_LOCK, { slot, at: now });

  try {
    const state = await getCacheJson(CACHE_KEY_STATE) || {};
    if (state.lastSlot === slot) return;
    await setCacheJson(CACHE_KEY_STATE, { lastSlot: slot, source, firedAt: now });
    doCheckAndNotify(products);
  } finally {
    /* Giải lock sau 5 giây */
    setTimeout(async () => {
      const current = await getCacheJson(CACHE_KEY_LOCK);
      if (current && current.slot === slot) {
        await setCacheJson(CACHE_KEY_LOCK, { slot: null, at: 0 });
      }
    }, 5000);
  }
}

/* ================================================
   PHÂN TÍCH & BẮN THÔNG BÁO
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

  const parts = [];
  if (itemsExp.length) parts.push(`❌ ${itemsExp.length} hết hạn`);
  if (items20.length)  parts.push(`🔴 ${items20.length} rút hàng`);
  if (items30.length)  parts.push(`⚠️ ${items30.length} giải tồn`);

  const urgentTag = itemsExp.length ? "exp" : items20.length ? "20" : "30";
  const icon      = itemsExp.length ? "❌" : items20.length ? "🔴" : "⚠️";

  const names = allItems.slice(0, 3).map(i => i.TenSP || ("BC:" + (i.Barcode || "?")));
  const body  = `${parts.join("  •  ")}\n${fmt(names)}`;

  fire(`${icon} Kiểm tra HSD – Co.op`, body, urgentTag, allItems);

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
    renotify : true,
    icon     : "/icon-192.png",
    badge    : "/icon-192.png",
    vibrate  : [200, 100, 200],
    data     : { url: self.registration.scope, tag, items: items || [] }
  });
}

/* ================================================
   CLICK VÀO THÔNG BÁO
   ================================================ */
let _pendingNotifClick = null;

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const { url, tag, items } = e.notification.data || {};

  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async clients => {
      if (clients.length > 0) {
        try { await clients[0].focus(); } catch {}
        try { clients[0].postMessage({ type: "SHOW_NOTIF_PRODUCTS", tag, items: items || [] }); } catch {}
      } else {
        _pendingNotifClick = { tag, items: items || [] };
        try {
          await self.clients.openWindow(url || self.registration.scope);
        } catch {
          _pendingNotifClick = null;
        }
      }
    })
  );
});

/* ================================================
   [F10] KHÔNG gọi scheduleBonusTimers() ở đây.
   Chỉ gọi trong sự kiện activate ở trên.
   Gọi 2 lần → activate clear timer của lần đầu → sai giờ.
   ================================================ */
