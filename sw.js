/* ================================================
   SERVICE WORKER – HSD Saigon Co.op  v3
   Chiến lược lịch thông báo đáng tin cậy:
   1. Periodic Background Sync (Chrome Android)
   2. Fallback: kiểm tra khi app được mở (iOS & mọi nền tảng)
   3. Khi SW còn sống: setTimeout chỉ là "bonus"
   ================================================ */

const SW_VERSION = "hsd-sw-v3";

/* ── Cài đặt & kích hoạt ── */
self.addEventListener("install",  () => self.skipWaiting());
self.addEventListener("activate", e  => e.waitUntil(self.clients.claim()));

/* ================================================
   1. PERIODIC BACKGROUND SYNC
   Chrome Android hỗ trợ, khoảng 12-24h / lần.
   Đây là cơ chế "thức dậy" đáng tin nhất khi SW bị suspend.
   ================================================ */
self.addEventListener("periodicsync", e => {
  if(e.tag === "hsd-daily-check"){
    e.waitUntil(checkWithStoredProducts());
  }
});

/* ================================================
   2. NHẬN MESSAGE TỪ APP CHÍNH
   ================================================ */
self.addEventListener("message", e => {
  const type = e.data && e.data.type;

  if(type === "SCHEDULE_DAILY"){
    // SW vừa được đăng ký/cập nhật → chạy lại timer bonus
    scheduleBonusTimers();
  }
  if(type === "CHECK_NOW"){
    // Nút "Test thông báo"
    doCheckAndNotify(e.data.products || []);
  }
  if(type === "PRODUCTS_DATA"){
    // App trả data về cho SW sau REQUEST_PRODUCTS
    doCheckAndNotify(e.data.products || []);
  }
  if(type === "APP_OPENED"){
    // App vừa mở → SW nhận data & kiểm tra nếu đến giờ
    maybeCheckOnOpen(e.data.products || []);
  }
});

/* ================================================
   3. FALLBACK TIMER (bonus, không đáng tin khi SW bị kill)
   Chỉ chạy được khi SW không bị terminate.
   ================================================ */
let _t08 = null, _t14 = null;

function msUntilHour(hour){
  const now  = new Date();
  const next = new Date();
  next.setHours(hour, 0, 0, 0);
  if(now >= next) next.setDate(next.getDate() + 1);
  return next - now;
}

function scheduleBonusTimers(){
  if(_t08) clearTimeout(_t08);
  if(_t14) clearTimeout(_t14);

  _t08 = setTimeout(() => { broadcastRequestData(); _t08 = setInterval(broadcastRequestData, 86400000); }, msUntilHour(8));
  _t14 = setTimeout(() => { broadcastRequestData(); _t14 = setInterval(broadcastRequestData, 86400000); }, msUntilHour(14));
}

/* Gửi yêu cầu data đến tab đang mở */
function broadcastRequestData(){
  self.clients.matchAll({ includeUncontrolled: true, type: "window" }).then(clients => {
    if(clients.length > 0) clients[0].postMessage({ type: "REQUEST_PRODUCTS" });
  });
}

/* ================================================
   4. KIỂM TRA KHI APP ĐƯỢC MỞ (iOS fallback)
   Lưu timestamp lần cuối notify vào IndexedDB-lite (SW cache storage).
   Nếu chưa gửi thông báo hôm nay trong giờ hiện tại → gửi.
   ================================================ */
const CACHE_KEY   = "hsd-notif-state";
const CACHE_NAME  = "hsd-sw-meta-v3";

async function getNotifState(){
  try{
    const cache = await caches.open(CACHE_NAME);
    const res   = await cache.match(CACHE_KEY);
    if(!res) return {};
    return res.json();
  } catch(e){ return {}; }
}

async function setNotifState(obj){
  try{
    const cache = await caches.open(CACHE_NAME);
    await cache.put(CACHE_KEY, new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" }}));
  } catch(e){}
}

function todaySlot(){
  // Trả về chuỗi "YYYY-MM-DD-HH" → dùng làm key dedup
  const n = new Date();
  const h = n.getHours();
  // Gộp 08:00–13:59 vào slot "08", 14:00–23:59 vào slot "14", còn lại "skip"
  const slot = (h >= 8 && h < 14) ? "08" : (h >= 14) ? "14" : "skip";
  if(slot === "skip") return null;
  const d = n.toISOString().slice(0,10);
  return `${d}-${slot}`;
}

async function maybeCheckOnOpen(products){
  const slot = todaySlot();
  if(!slot) return;                          // Ngoài giờ 08–22 → im lặng

  const state = await getNotifState();
  if(state.lastSlot === slot) return;        // Đã gửi slot này rồi

  await setNotifState({ lastSlot: slot });
  doCheckAndNotify(products);
}

/* Dùng cho Periodic Background Sync (không có tab nào mở) */
async function checkWithStoredProducts(){
  // SW không thể đọc localStorage trực tiếp.
  // Nếu có tab đang mở → request data.
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  if(clients.length > 0){
    clients[0].postMessage({ type: "REQUEST_PRODUCTS" });
    // doCheckAndNotify sẽ được gọi khi nhận PRODUCTS_DATA
  }
  // Nếu không có tab → không có data → bỏ qua (SW không thể đọc localStorage)
}

/* ================================================
   5. PHÂN TÍCH DATA → BẮN THÔNG BÁO
   ================================================ */
function doCheckAndNotify(products){
  if(!Array.isArray(products) || !products.length) return;

  const today = new Date(); today.setHours(0,0,0,0);

  const list30  = [];
  const list20  = [];
  const listExp = [];

  products.forEach(item => {
    if(item.completed) return;

    const m30 = new Date(item.M30); m30.setHours(0,0,0,0);
    const m20 = new Date(item.M20); m20.setHours(0,0,0,0);
    const hsd = new Date(item.HSD); hsd.setHours(0,0,0,0);
    const name = item.TenSP || ("BC: " + (item.Barcode || "?"));

    if(hsd <= today){
      listExp.push(name);
    } else if(today >= m20){
      list20.push(name);
    } else if(today >= m30){
      list30.push(name);
    } else {
      const diff = Math.round((m30 - today) / 86400000);
      if(diff <= 3) list30.push(`${name} (còn ${diff}n→30%)`);
    }
  });

  if(listExp.length){
    fire("❌ Sản phẩm HẾT HẠN – Co.op",
      `${listExp.length} SP hết hạn: ${fmt(listExp)}`, "exp");
  }
  if(list20.length){
    fire("🔴 RÚT HÀNG ngay – Co.op",
      `${list20.length} SP qua mốc 20%: ${fmt(list20)}`, "20");
  }
  if(list30.length){
    fire("⚠️ GIẢI TỒN – Co.op",
      `${list30.length} SP đến mốc 30%: ${fmt(list30)}`, "30");
  }
}

function fmt(arr){ return arr.slice(0,3).join(", ") + (arr.length > 3 ? "…" : ""); }

function fire(title, body, tag){
  return self.registration.showNotification(title, {
    body,
    tag,
    renotify : true,
    icon     : "/tinh-ngay-lui-hang/icon-192.png",
    badge    : "/tinh-ngay-lui-hang/icon-192.png",
    vibrate  : [200, 100, 200],
    data     : { url: self.registration.scope }
  });
}

/* ================================================
   6. CLICK VÀO THÔNG BÁO → MỞ APP
   ================================================ */
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
      if(clients.length > 0) return clients[0].focus();
      return self.clients.openWindow(e.notification.data?.url || "/tinh-ngay-lui-hang/");
    })
  );
});

/* Khởi timer bonus ngay khi SW activate */
scheduleBonusTimers();
