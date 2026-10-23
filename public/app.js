'use strict';
/* نظام جرد السلام — الواجهة */

// ===================== أدوات عامة =====================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 2) => (n == null || n === '' || Number.isNaN(Number(n))) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
const money = n => fmt(n, 2);
// الوقت بتوقيت السعودية (السيرفر يحفظ UTC): «2026-10-13 11:38 ص»
function ksa(t) {
  if (!t) return '';
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : String(t).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return String(t);
  const k = new Date(d.getTime() + 3 * 3600e3), p = n => String(n).padStart(2, '0'), h = k.getUTCHours();
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${h % 12 || 12}:${p(k.getUTCMinutes())} ${h < 12 ? 'ص' : 'م'}`;
}
const qtyFmt = n => fmt(n, 3);
const ROLE = { owner: 'المالك', supervisor: 'مشرف', purchaser: 'مسؤول المشتريات', worker: 'عامل' };
const PAYMENT = { cash: 'من الدرج', paid: 'مدفوع (برا الدرج)', credit: 'آجل', custody: 'من عهدتي (الكاش اللي معي)', card: 'بالبطاقة' };

const S = {
  token: lsGet('token'),
  me: null,
  date: null,
  cache: {},
};
function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } }
function lsSet(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* */ } }
// 🧯 مشكلة صارت للعامل => توصل نوح (صفحة «مشاكل البرنامج») — بدون ما توقف شي
function appLog(kind, msg) {
  try {
    let dev = lsGet('dev_id'); if (!dev) { dev = Math.random().toString(36).slice(2) + Date.now().toString(36); lsSet('dev_id', dev); }
    fetch('/api/app-log', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
      body: JSON.stringify({ kind, msg: String(msg || '').slice(0, 300), page: location.hash.slice(0, 80), who: lsGet('last_who'), dev }) }).catch(() => {});
  } catch { /* */ }
}
window.addEventListener('error', e => { if (e && e.message) appLog('error', `${e.message} (${String(e.filename || '').split('/').pop()}:${e.lineno || ''})`); });

function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.className = ''; }, err ? 4500 : 2200);
}

// طلب للسيرفر: ما يطلعك أبدًا إلا إذا السيرفر قال الجلسة غير موجودة
async function api(method, url, body, timeout = 90000) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method, signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      $('#net').hidden = true;
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && url !== '/api/login') { appLog('out', url); clearInterval(quietTimer); S.token = ''; S.me = null; lsSet('token', ''); renderLogin(); throw new Error('سجّل دخول'); }
      // 🐟 العرض أكثر من اللي نزّله: يسجّل «نزّلت» من ورا ويحفظ — أو «ما نزّلت» (نوح يدري)
      if (res.status === 409 && data.needDown && body && !body.force && url === '/api/count') {
        const pick = await choiceBox(data.error, [{ label: `+ نزّلت ${data.extra} من ورا`, value: 'down' }, { label: 'لا، ما نزّلت', value: 'no' }, { label: 'رجوع', value: null }]);
        if (!pick) throw Object.assign(new Error('ما انحفظ — صحّح الرقم'), { data: {} });
        if (pick === 'down') { await api('POST', '/api/add', { date: body.date, item_id: body.item_id, qty: data.extra, source: 'fridge', net: true, force: true }, timeout); return api(method, url, body, timeout); }
        return api(method, url, { ...body, force: true }, timeout);
      }
      // 📦 نفس البضاعة استلمها عامل وتنتظر الحساب: الأسعار تروح على الاستلام بدل ما تنسجل مرتين
      if (res.status === 409 && data.awaitingReceive && body && !body.force && !body.into_receive && url === '/api/purchases') {
        const pick = await choiceBox(data.error, [{ label: '🧾 إيه نفسها — حط الأسعار على الاستلام', value: 'rc' }, { label: 'لا، هذي بضاعة ثانية', value: 'new' }, { label: 'رجوع', value: null }]);
        if (!pick) throw Object.assign(new Error('ما انحفظ'), { data: {} });
        return api(method, url, { ...body, ...(pick === 'rc' ? { into_receive: data.awaitingReceive } : { force: true }) }, timeout);
      }
      // 🔢 رقم كبير مرة / مكرر (أضفت والجرد): نسأل — الرقم المقترح، أو «إيه صح»، أو رجوع
      if (res.status === 409 && data.needForce && body && !body.force && /^\/api\/(add|count)$/.test(url)) {
        const opts = [...(data.suggest != null ? [{ label: `قصدي ${data.suggest}`, value: 'fix' }] : []), { label: `إيه ${body.qty} صح`, value: 'yes' }, { label: 'رجوع', value: null }];
        const pick = await choiceBox(data.error, opts);
        if (!pick) throw Object.assign(new Error('ما انحفظ — صحّح الرقم'), { data: {} });
        return api(method, url, { ...body, force: true, ...(pick === 'fix' ? { qty: data.suggest, net: true } : {}) }, timeout);
      }
      if (!res.ok) { if (url !== '/api/login') appLog('reject', `${data.error || res.status} — ${method} ${url.split('?')[0]}`); throw Object.assign(new Error(data.error || 'خطأ ' + res.status), { data }); }
      return data;
    } catch (e) {
      const network = e.name === 'AbortError' || e instanceof TypeError;
      if (network && method === 'GET' && attempt < 5) { $('#net').hidden = false; await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
      if (network) { $('#net').hidden = false; if (method !== 'GET') appLog('net', `${method} ${url.split('?')[0]}`); throw new Error('ما فيه اتصال — جرّب مرة ثانية'); }
      throw e;
    } finally { clearTimeout(timer); }
  }
}
const GET = u => api('GET', u), POST = (u, b) => api('POST', u, b || {}), PUT = (u, b) => api('PUT', u, b), PATCH = (u, b) => api('PATCH', u, b), DEL = u => api('DELETE', u);

// زر يشتغل مرة وحدة لين يخلص (ما تعلق الصفحة ولا يتكرر)
async function busy(btn, fn) {
  if (btn && btn.disabled) return;
  const old = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span> ' + old; }
  try { return await fn(); }
  catch (e) { toast(e.message, true); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = old; } }
}

function modal(title, html, onMount) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h2>${esc(title)}</h2>${html}</div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.addEventListener('click', e => { if (e.target === bg) close(); });
  $$('[data-close]', bg).forEach(b => b.addEventListener('click', close));
  if (onMount) onMount($('.modal', bg), close);
  return close;
}
function confirmBox(msg) {
  return new Promise(resolve => {
    modal('تأكيد', `<p>${esc(msg)}</p><div class="row"><button class="btn primary" data-yes>نعم</button><button class="btn" data-close>لا</button></div>`, (m, close) => {
      $('[data-yes]', m).onclick = () => { close(); resolve(true); };
      $$('[data-close]', m).forEach(b => b.addEventListener('click', () => resolve(false)));
    });
  });
}
// خيارين (زر لكل واحد) — يرجع قيمة الزر، أو null لو قفل
function choiceBox(msg, opts) {
  return new Promise(resolve => {
    modal('تأكيد', `<p style="font-size:17px">${esc(msg)}</p><div class="row" style="gap:8px">${opts.map((o, i) => `<button class="btn ${i ? '' : 'primary'}" data-opt="${i}" style="min-height:48px;font-size:17px">${esc(o.label)}</button>`).join('')}</div>`, (m, close) => {
      $$('[data-opt]', m).forEach(b => b.onclick = () => { close(); resolve(opts[Number(b.dataset.opt)].value); });
      m.parentElement.addEventListener('click', e => { if (e.target === m.parentElement) resolve(null); });
    });
  });
}
function showImage(src) { modal('صورة', `<img src="${esc(src)}" style="width:100%;border-radius:8px"><div class="row" style="margin-top:8px"><button class="btn" data-close>إغلاق</button></div>`); }

// تصغير الصورة قبل الرفع (أسرع وما يعلق)
function readImage(file, max = 1280) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('ما قدرت أقرأ الصورة'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => resolve(fr.result);
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.7));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}
async function readImages(input) { const out = []; for (const f of input.files || []) out.push(await readImage(f)); return out; }

function photoInputs(name, multiple = true) {
  return `<div class="row">
    <label class="btn"><input type="file" accept="image/*" capture="environment" ${multiple ? 'multiple' : ''} data-photo="${name}" hidden>📷 الكاميرا</label>
    <label class="btn"><input type="file" accept="image/*" ${multiple ? 'multiple' : ''} data-photo="${name}" hidden>🖼️ من الجهاز</label>
    <span class="muted small" data-photo-count="${name}"></span></div>`;
}
function bindPhotos(root, name, store) {
  $$(`[data-photo="${name}"]`, root).forEach(inp => inp.addEventListener('change', async () => {
    try { store.push(...await readImages(inp)); } catch (e) { toast(e.message, true); }
    inp.value = '';
    const c = $(`[data-photo-count="${name}"]`, root); if (c) c.textContent = store.length ? `${store.length} صورة جاهزة` : '';
  }));
}

// شاشة ما تنطفي وقت الجرد (إذا الجهاز يدعم)
let wakeLock = null;
async function keepAwake() { try { if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch { /* */ } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { keepAwake(); if (S.me) refreshQuiet(); } });

// أي خطأ يطلع رسالة — ما تصير الصفحة فاضية
window.addEventListener('error', e => toast('خطأ: ' + (e.message || ''), true));
window.addEventListener('unhandledrejection', e => toast((e.reason && e.reason.message) || 'خطأ', true));

const isSup = () => S.me && (S.me.role === 'owner' || S.me.role === 'supervisor');
const isPurch = () => isSup() || (S.me && S.me.role === 'purchaser');
const isOwner = () => S.me && S.me.role === 'owner';

// ===================== الدخول =====================
async function renderLogin() {
  const app = $('#app');
  app.innerHTML = `<div class="login card"><h1>جرد السلام</h1><p class="muted">اختر اسمك ودخّل الرقم السري</p><div class="users"></div>
    <label class="f">الرقم السري<input type="password" inputmode="numeric" autocomplete="current-password" id="pin"></label>
    <button class="btn primary" style="width:100%;margin-top:12px" id="go">دخول</button></div>`;
  let users = [];
  try { users = await GET('/api/login-users'); } catch (e) { $('.users', app).innerHTML = `<div class="err-card">${esc(e.message)}</div>`; return; }
  let sel = Number(lsGet('last_user')) || null;
  const draw = () => { $('.users', app).innerHTML = users.map(u => `<button data-id="${u.id}" class="${u.id === sel ? 'on' : ''}">${esc(u.name)}</button>`).join(''); };
  draw();
  $('.users', app).onclick = e => { const b = e.target.closest('button'); if (!b) return; sel = Number(b.dataset.id); draw(); $('#pin').focus(); };
  const go = () => busy($('#go'), async () => {
    if (!sel) throw new Error('اختر اسمك');
    const r = await POST('/api/login', { user_id: sel, pin: $('#pin').value });
    S.token = r.token; lsSet('token', r.token); lsSet('last_user', String(sel));
    await boot();
  });
  $('#go').onclick = go;
  $('#pin').onkeydown = e => { if (e.key === 'Enter') go(); };
}

// ===================== الهيكل =====================
const PAGES = [
  { id: 'home', t: 'الرئيسية', f: pageHome, noPurch: 1 },
  { id: 'assistant', t: '🤖 المساعد', f: pageAssistant, noWorker: 1 },
  { id: 'count', t: 'الجرد اليومي', f: pageCount, noPurch: 1 },
  { id: 'transfer', t: '🐑 تقسيم الذبيحة', f: pageTransfer, noPurch: 1, split: 1 },
  { id: 'tickets', t: 'تذكرة الكاشير', f: pageTickets, sales: 1 },
  { id: 'sales', t: 'المبيعات', f: pageSales, sales: 1 },
  { id: 'report', t: 'تقرير اليوم', f: pageReport, sales: 1 },
  { id: 'usage', t: 'انصرف حسب الوصفات', f: pageUsage, sales: 1 },
  // الثلاث أنواع: المستودع (ينشرى) ← التحضير (يتسوى) ← أصناف البيع (لويفرس)
  { id: 'stock', t: '📦 كل البضاعة', f: pageStock, sup: 1 },
  { id: 'warehouse', t: '① المستودع — الكميات', f: pageWarehouse, purch: 1 },
  { id: 'items', t: '① المستودع — الأصناف', f: (m, a) => pageItems(m, a, 'raw'), purch: 1 },
  { id: 'prep', t: '② التحضير', f: (m, a) => pageItems(m, a, 'prepared'), sup: 1 },
  { id: 'recipes', t: '③ أصناف البيع (لويفرس)', f: pageRecipes, recipes: 1 },
  { id: 'link', t: 'ربط أصناف البيع', f: pageLink, recipes: 1, hidden: 1 },
  { id: 'purchases', t: 'المشتريات', f: pagePurchases, purch: 1 },
  { id: 'buyunits', t: '📦 وحدات الشراء', f: pageBuyUnits, purch: 1 },
  { id: 'suppliers', t: 'الموردين (الآجل)', f: pageSuppliers, purch: 1 },
  { id: 'expenses', t: 'المصروفات', f: pageExpenses, sup: 1 },
  { id: 'spending', t: '💸 كل المصروفات', f: pageSpending, sales: 1 },
  { id: 'issues', t: '🛠️ مشاكل الشغل', f: pageIssues, sales: 1 },
  { id: 'applog', t: '🧯 مشاكل البرنامج عند العمال', f: pageAppLog, owner: 1 },
  { id: 'staff', t: 'الموظفين والمسؤوليات', f: pageStaff, sup: 1 },
  { id: 'attendance', t: '🕒 الحضور', f: pageAttendance, sup: 1 },
  { id: 'payroll', t: 'الرواتب والسحبيات', f: pagePayroll, owner: 1 },
  { id: 'days', t: 'الأيام السابقة', f: pageDays, sales: 1 },
  { id: 'profit', t: '💰 ربح الأطباق', f: pageProfit, recipes: 1 },
  { id: 'shortmonth', t: 'النقص الشهري للموظفين', f: pageShortMonth, sales: 1 },
  { id: 'monthly', t: 'تقرير الشهر / الفترة', f: pageMonthly, owner: 1 },
  { id: 'printer', t: '🖨️ تذاكر الكاشير (الطابعة)', f: pagePrinter, sales: 1 },
  { id: 'customers', t: '👥 العملاء', f: pageCustomers, sales: 1 },
  { id: 'packaging', t: '🥡 السفري والبلاستيك', f: pagePackaging, sales: 1 },
  { id: 'cameras', t: '📹 الكاميرات', f: pageCameras, sales: 1 },
  { id: 'suggestions', t: '💡 اقتراحات العمال', f: pageSuggestions, owner: 1 },
  { id: 'kb', t: '📘 دليل المطعم', f: pageKb, sup: 1 },
  { id: 'settings', t: 'الإعدادات', f: pageSettings },
];
// المشرف يشوف «الأقسام» بس — الموظفين وصلاحياتهم للمالك
const titleOf = p => (p.id === 'staff' && !isOwner() ? 'المسؤوليات' : p.t);
// مسؤول المشتريات يشوف بس المشتريات والموردين والمستودع وأصنافه
const onlyPurch = () => S.me && S.me.role === 'purchaser';
const allowed = p => (!p.sup || isSup()) && (!p.purch || isPurch()) && (!p.owner || isOwner()) && !(p.noPurch && onlyPurch()) && !(p.noWorker && S.me && S.me.role === 'worker') && (!p.split || (S.me && S.me.split_meat))
  && (!p.sales || (S.me && S.me.can_sales)) && (!p.recipes || (S.me && S.me.can_recipes));

function shell() {
  const app = $('#app');
  app.innerHTML = `
  <header class="top">
    <button class="btn small menu-btn" id="menuBtn" aria-label="القائمة">☰</button>
    <div class="title" id="pageTitle"></div>
    <input type="date" id="dateSel" aria-label="اليوم" ${S.me.role === 'worker' ? 'hidden' : ''}>
    <button class="btn small" id="todayBtn" ${S.me.role === 'worker' ? 'hidden' : ''}>اليوم</button>
  </header>
  <div class="layout">
    <nav class="side" id="side">
      ${PAGES.filter(p => allowed(p) && !p.hidden).map(p => `<a href="#/${p.id}" data-p="${p.id}">${titleOf(p)}</a>`).join('')}
      <div class="who">${esc(S.me.name)} · ${ROLE[S.me.role]}<br><button class="btn small" id="logout" style="margin-top:6px">خروج</button></div>
    </nav>
    <main id="main"></main>
  </div>`;
  $('#dateSel').value = S.date;
  $('#dateSel').onchange = e => { S.date = e.target.value || S.me.today; route(); };
  $('#todayBtn').onclick = () => { S.date = S.me.today; $('#dateSel').value = S.date; route(); };
  $('#menuBtn').onclick = () => $('#side').classList.toggle('open');
  $('#side').addEventListener('click', e => { if (e.target.tagName === 'A') $('#side').classList.remove('open'); });
  $('#logout').onclick = async () => {
    if (!await confirmBox('تبي تطلع من النظام؟')) return;
    try { await POST('/api/logout'); } catch { /* */ }
    clearInterval(quietTimer); S.token = ''; lsSet('token', ''); S.me = null; renderLogin();
  };
}


// ===================== شرح كل صفحة =====================
// خطوات قصيرة بكلام بسيط. تنفتح أول مرة، و«فهمت» تصغّرها (وتقدر تفتحها متى ما بغيت)
const GUIDES = {
  home: () => ['فوق تحصل «المطلوب منك الحين» — امش عليه من فوق لتحت.', 'الأحمر لازم الحين، والأصفر لا تنساه، والأخضر خلص.', 'اضغط الزر اللي جنب كل سطر يوديك للمكان على طول.'],
  transfer: () => ['الذبيحة: اختر «ذبيحة» واكتب كم، وتحت اكتب كم طلع سهوم وبرم وحنيذ… واضغط «قسّم» — يدخل الجرد على طول.', 'السهوم اللي ما انباعت: اختر «سهوم» وقسّمها برم وحنيذ بنفس الطريقة.'],
  stock: () => ['هنا كل البضاعة: اللي في المحل (آخر جرد) واللي فوق في الثلاجة والمستودع.', 'الأصناف اللي «الباقي يطلع الثلاجة» تطلع وتنزل لحالها من الجرد — ما تحتاج تسجل شي.'],
  count: () => isSup() || (S.me.approver_sections || []).length
    ? ['اختر «أول الدوام» أو «آخر الدوام» من فوق.', 'اكتب العدد قدام كل صنف — ينحفظ لحاله (تطلع ✓).', 'لما يخلص القسم اضغط «استلام» — بعدها العامل ما يقدر يغيّر.', 'عمود «الفرق»: نقص بالأحمر يعني فيه شي ناقص.']
    : ['أول الدوام: عدّ اللي قدامك واكتب الرقم — ينحفظ لحاله (تطلع ✓). اللي نزل من الثلاجة فوق ينحسب لحاله.', 'طبخت أو زوّدت شي وسط اليوم؟ اضغط «+ أضفت».', 'شي خرب أو طاح؟ اضغط «🗑️ انرمى» وصوّره.', 'آخر الدوام: اكتب اللي باقي قدامك (وصوّره إذا طلب). الباقي يطلع الثلاجة أو ينرمى لحاله حسب الصنف.'],
  purchases: () => ['📷 صوّر الفاتورة — أعبّيها لك لحالي.', 'أو 🎤 قول وش اشتريت: «كرتونين طماطم بستين من خضار الوادي».', 'أو اضغط على الصنف (يجيك بآخر سعر) وعدّل العدد بـ − و +.', 'اختر المحل وطريقة الدفع واضغط «✓ سجّل الشراء».'],
  tickets: () => ['صوّر تذكرة الكاشير — لو طويلة صوّرها كذا صورة.', 'ارفع الصور كلها مرة وحدة، والنظام يقراها لحاله.', 'لو طلع أخضر اضغط «تأكيد».', 'لو طلع أحمر: صحح السطر الغلط أو صوّر من جديد.'],
  link: () => ['هنا أصناف لويفرس اللي ما تعرف وش تنخصم.', 'لو فيه «أسماء مكتوبة غير عن لويفرس» اضغط «وحّد» أول.', 'بعدها اضغط «اربط المقترحات المطابقة».', 'الباقي واحد واحد: «اربط» بصنف موجود، أو «صنف جديد بنفس الاسم»، أو «ما ينجرد» للخدمة والتوصيل.', 'الطبق اللي له مقادير (مثل المرسة): اضغط «طبق له مقادير» واكتب كم من كل مكوّن لكل نوع.'],
  recipes: () => ['أصناف البيع = اللي في لويفرس. كل صنف: وش ياخذ من التحضير أو المستودع لما ينباع.', 'اضغط على الصنف عشان تفتح وصفته.', 'أضف المكوّن والكمية لكل وحدة تنباع (تقبل كسور مثل 0.4).', 'الوصفة الصفراء «مبدئية»: شيكها واضغط «اعتمد».'],
  items: () => ['هنا كل شي ينشرى. لكل صنف اختر «وين ينجرد؟» من تعديل:', '① المستودع: يتخزن (دقيق، رز، بهارات…) — ينجرد مرة بالأسبوع.', '② الطازج: لحوح، كدر، كبان… — زكريا يسجله أول اليوم ويدخل جرد المسؤول على طول، والباقي هالك.', 'يومي ويتخزن: مثل المشروبات — تنسحب من المستودع للثلاجة.'],
  prep: () => ['هنا كل شي يتسوى في المحل (فتة، حنيذ، برم، إيدامات…).', 'لكل صنف حط مكوناته من المستودع لكل وحدة، وتكلفة الغاز إن وجدت.', 'حدد المسؤول عنه — يجرده أول وآخر الدوام، والنقص عليه.'],
  staff: () => ['كل موظف له أصنافه: يجردها أول وآخر الدوام، والنقص عليه.', 'تحت اسم الموظف اختر «+ أضف صنف عليه».', 'الأصناف اللي ما لها مسؤول تطلع فوق — حطها عند أحد.'],
  warehouse: () => ['هنا اللي في المستودع الحين حسب النظام.', 'مرة في الأسبوع عدّ المستودع واكتب الموجود — النظام يصحح ويبين الفرق.'],
  report: () => ['آخر الليل: اكتب كم كاش في الدرج وكم شبكة.', 'شيك النقص في البضاعة والكاش.', 'إذا كل شي تمام اضغط «قفل اليوم».'],
  suppliers: () => ['هنا اللي علينا لكل مورد (الآجل).', 'لما تسدد اضغط «سداد» واكتب المبلغ — ينخصم من الأقدم أول.'],
  sales: () => ['مبيعات اليوم من لويفرس + التذكرة، وتكلفة كل صنف.', 'الصنف المكتوب عليه «ما فيه» وصفة: اربطه من «ربط لويفرس بالجرد».'],
  assistant: () => ['اكتب أو اضغط 🎤 وتكلم — بأي لغة (اختر لغتك تحت).', 'قله وش سويت: «طلّعت 5 حنيذ»، «اشتريت…»، «الكاش 2300» — يطلع لك كرت، شيكه واضغط «✓ تأكيد».', 'صوّر الفاتورة أو التذكرة بزر 📷 وقله وش هي.', 'اسأله «وش علي الحين؟» أو «ليش طلع علي نقص أمس؟».', ...(S.me.can_sales ? ['«ملخص اليوم» و«توصيات بكرة» من فوق.'] : [])],
  usage: () => ['كل صنف: كم انخصم منه حسب الأطباق اللي انباعت.', 'اضغط الصنف تشوف الأطباق اللي خصمت منه، وكم لكل طبق.', 'أصناف الجرد تبين كمان كم انصرف فعلًا والنقص.', 'الرقم غريب؟ الغالب الوصفة غلط — عدّلها من «أصناف البيع».'],
  profit: () => ['كل طبق: كم يكلّف من الوصفة وكم ينباع وكم يربح.', 'الأحمر: تكلفته عالية — يا ترفع السعر يا تراجع الوصفة.', 'فوق: أصناف تنقص كل يوم بنفس النسبة — يمكن الوصفة ناقصة. «طبّق» يعدّلها.'],
  monthly: () => ['اختر الشهر، وتأكد إن كل الأيام مقفلة.', 'اضغط «تنزيل Excel» وأرسله للمحاسب (واتساب أو إيميل).', 'إذا ربطت قوقل درايف، التقرير ينحط هناك لحاله أول كل شهر.'],
  shortmonth: () => ['النقص لكل موظف في الشهر (على اللي يقفل الصنف).', '«التفاصيل» تبين وش الأصناف.', 'المالك يقدر يخصم من الراتب بضغطة، أو ينزّل الجدول Excel.'],
  expenses: () => ['سجّل أي مصروف: غاز، صيانة، نقل…', 'اختر إذا انصرف من الدرج عشان ينحسب في الكاش.'],
};
function guideHtml(id) {
  const g = GUIDES[id]; if (!g) return '';
  const steps = g(); if (!steps || !steps.length) return '';
  const seen = lsGet('guide_' + id);
  return `<details class="guide no-print" ${seen ? '' : 'open'}><summary>وش أسوي هنا؟</summary>
    <ol>${steps.map(x => `<li>${esc(x)}</li>`).join('')}</ol>
    ${seen ? '' : '<button class="btn small" data-guide-ok>فهمت ✓</button>'}</details>`;
}
function bindGuide(root, id) {
  const ok = $('[data-guide-ok]', root);
  if (ok) ok.onclick = () => { lsSet('guide_' + id, '1'); ok.closest('details').open = false; ok.remove(); };
}

let routeSeq = 0;
async function route() {
  if (!S.me) return;
  const id = (location.hash.replace('#/', '') || (S.me.role === 'worker' ? 'count' : 'home')).split('?')[0]; // العامل: يفتح الرابط ويجرد على طول
  const qd = new URLSearchParams(location.hash.split('?')[1] || '').get('date'); // رابط لتاريخ معيّن (سجّل شراء أمس)
  if (qd && /^\d{4}-\d{2}-\d{2}$/.test(qd)) {
    if (qd !== S.date) { S.date = qd; const ds = $('#dateSel'); if (ds) ds.value = qd; }
    const rest = new URLSearchParams(location.hash.split('?')[1] || ''); rest.delete('date');
    history.replaceState(null, '', '#/' + id + (rest.toString() ? '?' + rest : '')); // ما يعلق على أمس
  }
  const page = PAGES.find(p => p.id === id && allowed(p)) || PAGES.find(p => p.id === (onlyPurch() ? 'purchases' : 'home') && allowed(p)) || PAGES.find(allowed);
  S.page = page.id;
  $$('#side a').forEach(a => a.classList.toggle('on', a.dataset.p === page.id));
  $('#pageTitle').textContent = titleOf(page);
  const root = $('#main');
  delete root.dataset.dirty;
  const seq = ++routeSeq;
  // فوق كل صفحة: «وش أسوي هنا؟» بخطوات قصيرة، وتحته محتوى الصفحة
  root.innerHTML = attBar() + (page.id === 'count' && S.me.role === 'worker' ? '' : guideHtml(page.id)) + '<div id="pageBody"><div class="muted">جاري التحميل…</div></div>';
  bindGuide(root, page.id); bindAtt(root);
  const main = $('#pageBody', root);
  try {
    await page.f(main, () => seq === routeSeq);
  } catch (e) {
    if (seq !== routeSeq) return;
    main.innerHTML = `<div class="err-card">${esc(e.message)}<br><button class="btn" style="margin-top:8px" id="retry">إعادة المحاولة</button></div>`;
    $('#retry').onclick = route;
  }
  keepAwake();
}
window.addEventListener('hashchange', route);

let quietTimer = null;
async function refreshQuiet() {
  // إذا الصفحة مفتوحة من أمس ويوم العمل تغيّر: ننتقل لليوم الجديد لحالنا
  // (عشان العامل ما يدخل جرد اليوم على تاريخ أمس)
  // ما نعيد رسم صفحة فيها شي مكتوب أو نافذة مفتوحة (مثل فاتورة شراء نص مكتوبة)
  const busyPage = () => document.querySelector('.modal-bg') || ($('#main') && $('#main').dataset.dirty);
  try {
    const me = await GET('/api/me');
    // نزل تحديث للنظام: نعيد تحميل الصفحة (إذا ما فيه شي مكتوب ما انحفظ)
    if (me.version && S.me.version && me.version !== S.me.version) {
      if (!busyPage()) { location.reload(); return; }
      if (!refreshQuiet.told) { refreshQuiet.told = 1; toast('نزل تحديث جديد — احفظ شغلك وحدّث الصفحة'); }
    }
    const oldToday = S.me.today;
    S.me = { ...me, version: S.me.version };
    if (me.today !== oldToday && S.date === oldToday) {
      S.date = me.today;
      const sel = $('#dateSel'); if (sel) sel.value = S.date;
      toast('بدأ يوم جديد: ' + S.date);
      await loadAtt();
      if (!busyPage()) return route();
    }
  } catch { /* بدون اتصال: نجرب المرة الجاية */ }
  // تحديث خفيف للصفحة الرئيسية بس (عشان ما يضيع شي تكتبه)
  // (S.page = الصفحة المعروضة فعلاً — مسؤول المشتريات بدون رابط تنفتح له المشتريات مو الرئيسية)
  if (S.page === 'home' && !busyPage()) route();
}
// أي كتابة في الصفحة = فيها شي ما انحفظ، فالتحديث التلقائي ما يمسحه
document.addEventListener('input', e => { const m = e.target.closest && e.target.closest('#main'); if (m) m.dataset.dirty = '1'; if (S.page === 'count' || document.querySelector('#one')) lsSet('counting', String(Date.now())); });
document.addEventListener('change', e => { const m = e.target.closest && e.target.closest('#main'); if (m) m.dataset.dirty = '1'; });

async function boot() {
  if (!S.token) return renderLogin();
  try { S.me = await GET('/api/me'); }
  catch (e) { if (!S.token) return; $('#app').innerHTML = `<div class="login err-card">${esc(e.message)}<br><button class="btn" id="rb">إعادة المحاولة</button></div>`; $('#rb').onclick = boot; return; }
  S.date = S.date || S.me.today;
  lsSet('last_who', S.me.name);
  // 📱 كان يكتب في الجرد قبل أقل من ٥ دقايق والصفحة رجعت من جديد (الكاميرا قفلتها؟ النت؟) => نسجلها
  const wasCounting = Number(lsGet('counting')) || 0; lsSet('counting', '');
  if (wasCounting && Date.now() - wasCounting < 5 * 60e3) appLog('reload', `آخر كتابة قبل ${Math.round((Date.now() - wasCounting) / 1000)} ثانية`);
  await loadAtt();
  shell();
  route();
  clearInterval(quietTimer);
  quietTimer = setInterval(refreshQuiet, 60000);
}

// ===================== 👋 الحضور =====================
// «بدأت دوامي» فوق كل صفحة لين يسجّل: سيلفي + لازم على واي فاي المطعم (السيرفر يشيك)
const devId = () => { let d = lsGet('dev_id'); if (!d) { d = Math.random().toString(36).slice(2) + Date.now().toString(36); lsSet('dev_id', d); } return d; };
const attTime = iso => new Date(iso).toLocaleTimeString('ar-SA', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Riyadh' });
async function loadAtt() { try { S.att = await GET('/api/attendance/me'); } catch { S.att = null; } }
function attBar() {
  const a = S.att; if (!a || !a.need) return '';
  if (!a.in) return `<div class="alert amber no-print" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b style="flex:1">👋 وصلت الدوام؟ سجّل وأنت على واي فاي المطعم</b><button class="btn primary" data-att="in" style="min-height:48px;font-size:17px">👋 بدأت دوامي</button></div>`;
  return `<div class="small muted no-print" style="margin-bottom:8px">✓ بدأت دوامك ${esc(attTime(a.in.at))}${a.out ? ` · انتهى ${esc(attTime(a.out.at))}` : ` <button class="btn small" data-att="out">انتهى دوامي</button>`}</div>`;
}
function bindAtt(root) { $$('[data-att]', root).forEach(b => b.onclick = () => clockModal(b.dataset.att)); }
function clockModal(kind) {
  let pic = '';
  modal(kind === 'in' ? '👋 بدأت دوامي' : 'انتهى دوامي', `
    <p>صوّر وجهك بالكاميرا الأمامية (سيلفي) — خل وجهك واضح.</p>
    <label class="btn" style="width:100%;min-height:52px;font-size:18px"><input type="file" accept="image/*" capture="user" id="attPic" hidden>🤳 صوّر وجهك</label>
    <img id="attPrev" alt="" style="display:none;width:100%;max-height:260px;object-fit:contain;margin-top:8px;border-radius:8px">
    <p class="muted small">لازم تكون في المطعم ومتصل على واي فاي المطعم.</p>
    <div class="row" style="margin-top:8px"><button class="btn primary" id="attGo" disabled>تسجيل</button><button class="btn" data-close>إلغاء</button></div>`, (m, close) => {
    $('#attPic', m).onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try { pic = await readImage(f, 900); $('#attPrev', m).src = pic; $('#attPrev', m).style.display = ''; $('#attGo', m).disabled = false; } catch (er) { toast(er.message, true); }
    };
    $('#attGo', m).onclick = ev => busy(ev.currentTarget, async () => {
      if (!pic) throw new Error('صوّر وجهك أول');
      const r = await POST('/api/attendance', { kind, selfie: pic, device: devId() });
      close(); toast(`✓ ${kind === 'in' ? 'سجّلت دخولك' : 'سجّلت خروجك'} ${attTime(r.at)}`);
      await loadAtt(); route();
    });
  });
}
// صورة محمية (سيلفي / وجه / لقطة) — تنجاب بالتوكن
async function authImg(url) { const res = await fetch(url, { headers: { Authorization: 'Bearer ' + S.token } }); if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'ما فيه صورة'); return URL.createObjectURL(await res.blob()); }
const FACE_ST = { match: '✅ نفس الشخص', mismatch: '🔴 الوجه مو هو!', unsure: '🟡 الوجه مو واضح', no_ref: '— ما فيه صورة وجه في ملفه', skipped: '', pending: '⏳ يتشيك الوجه…', error: '⚠️ ما تشيك الوجه' };
const NET_ST = { shop: '✅ من نت المحل', unknown: '🟡 ما تأكد من النت (الجسر مو متصل)' };
async function pageAttendance(main, alive) {
  const d = await GET('/api/attendance?date=' + S.date);
  if (!alive()) return;
  const cell = r => !r ? '<span class="muted">—</span>' : `<b>${esc(attTime(r.at))}</b>
    <div class="small">${NET_ST[r.net] || esc(r.net)}${FACE_ST[r.face] ? ` · ${FACE_ST[r.face]}` : ''}${r.face_note && r.face !== 'match' ? ` <span class="muted">(${esc(r.face_note)})</span>` : ''}</div>
    ${r.shared_with ? `<div class="small" style="color:var(--red)">📱 نفس الجوال سجّل لـ ${esc(r.shared_with)}</div>` : ''}
    <div class="row" style="gap:4px;margin-top:4px">${isOwner() && r.has_selfie ? `<button class="btn small" data-self="${r.id}">🤳 السيلفي</button>` : ''}${S.me.can_sales && r.cam_ref ? `<button class="btn small" data-camref="${esc(r.cam_ref)}">📹 الكاميرا</button>` : ''}</div>`;
  main.innerHTML = `<div class="card"><h3>🕒 الحضور ${esc(d.date)}</h3>
      <p class="small muted">كل موظف يضغط «بدأت دوامي» و«انتهى دوامي» من جواله وهو على واي فاي المطعم، ويصوّر وجهه. النظام يقارن الوجه بصورته (من «الموظفين»)، وياخذ لقطة من المطبخ والكاشير.</p>
      ${d.shop_known ? '' : '<div class="alert amber small">الجسر مو متصل — ما أقدر أتأكد إن التسجيل من نت المحل</div>'}
      <div class="tbl-wrap"><table><thead><tr><th>الموظف</th><th>بدأ دوامه</th><th>انتهى</th></tr></thead><tbody>
      ${d.people.map(p => `<tr><td>${esc(p.name)}${p.absent ? ` <span class="badge red" title="${esc(p.absent.face_note || '')}">🚫 غايب</span>` : ''}</td><td>${cell(p.in)}</td><td>${cell(p.out)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">ما أحد سجّل للحين</td></tr>'}
      </tbody></table></div></div>
    ${d.missing.length ? `<div class="card"><h3>ما سجّلوا (${d.missing.length})</h3><div class="chips">${d.missing.map(u => `<span class="badge">${esc(u.name)}</span>`).join(' ')}</div></div>` : ''}`;
  $$('[data-self]', main).forEach(b => b.onclick = () => busy(b, async () => showImage(await authImg('/api/attendance/' + b.dataset.self + '/selfie'))));
  $$('[data-camref]', main).forEach(b => b.onclick = () => busy(b, async () => {
    const snaps = await GET('/api/cam/snaps?ref=' + encodeURIComponent(b.dataset.camref));
    if (!snaps.length) throw new Error('ما وصلت لقطة (الجسر مو متصل؟)');
    modal('📹 لحظة التسجيل', `<div class="grid">${snaps.map(x => `<div><img data-cimg="${x.id}" alt="" style="width:100%;border-radius:6px;background:#000"><div class="small muted">${esc(x.cam)}</div></div>`).join('')}</div><div class="row" style="margin-top:8px"><button class="btn" data-close>إغلاق</button></div>`, m => camImg(m));
  }));
}

// ===================== بيانات مشتركة =====================
async function itemsList(force) { if (force || !S.cache.items) S.cache.items = await GET('/api/items'); return S.cache.items; }
async function usersList() {
  if (!S.cache.users) S.cache.users = isSup() ? await GET('/api/users') : (await GET('/api/login-users')).map(u => ({ ...u, active: 1 }));
  return S.cache.users;
}
async function suppliersList() { return GET('/api/suppliers'); }
const payOptions = sel => Object.entries(PAYMENT).map(([k, v]) => `<label class="small" style="display:flex;gap:4px;align-items:center"><input type="radio" name="pPay" value="${k}" ${k === sel ? 'checked' : ''} style="width:20px;height:20px;min-height:0">${v}</label>`).join('');
const itemOptions = (items, sel, empty = 'اختر الصنف') => `<option value="">${empty}</option>` + groupBy(items, i => i.section || 'بدون قسم')
  .map(([g, list]) => `<optgroup label="${esc(g)}">${list.map(i => `<option value="${i.id}" ${Number(sel) === i.id ? 'selected' : ''}>${esc(i.name)} (${esc(i.unit)})</option>`).join('')}</optgroup>`).join('');
function groupBy(arr, fn) { const m = new Map(); for (const x of arr) { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return [...m.entries()]; }
const userOptions = (users, sel, empty = '—') => `<option value="">${empty}</option>` + users.filter(u => u.active).map(u => `<option value="${u.id}" ${Number(sel) === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
const alertsHtml = list => list && list.length ? list.map(a => `<div class="alert ${a.level}">${esc(a.text)}${a.type === 'no_recipe' && S.me && S.me.can_recipes ? ' — <a href="#/link">اربطها</a>' : ''}</div>`).join('') : '<div class="muted">ما فيه تنبيهات 👍</div>';

// ===================== الرئيسية =====================
async function pageHome(main, alive) {
  const d = await GET('/api/dashboard?date=' + S.date);
  if (!alive()) return;
  const m = d.money;
  main.innerHTML = `
    ${d.closed ? '<div class="alert amber">هذا اليوم مقفل</div>' : ''}
    ${S.me.role === 'worker' ? `<div class="big-tiles no-print">
      <a class="tile" href="#/count"><b>📋</b><span>الجرد</span></a>
      <a class="tile" href="#/count?one=1"><b>▶️</b><span>صنف صنف</span></a>
      <a class="tile" href="#/count?add=1"><b>➕</b><span>أضفت</span></a>
      ${S.me.has_receive ? '<a class="tile" href="#/count?recv=1"><b>📦</b><span>وصل سمك</span></a>' : ''}
      <a class="tile" href="#/count"><b>🗑️</b><span>انرمى</span></a></div>
      <p class="small muted" style="margin:-4px 0 12px">انرمى: افتح الجرد واضغط الزر جنب الصنف.</p>` : ''}
    <div class="card todo-card"><h3>المطلوب منك الحين</h3>
      ${(d.todo || []).map(t => `<div class="todo ${t.level}">
        <div class="grow"><div class="todo-t">${esc(t.title)}</div>${t.detail ? `<div class="todo-d">${esc(t.detail)}</div>` : ''}</div>
        ${t.href ? `<a class="btn ${t.level === 'red' || t.level === 'amber' ? 'primary' : ''}" href="${esc(t.href)}">${esc(t.btn || 'افتح')}</a>` : ''}${t.done_id ? `<button class="btn" data-rdone="${t.done_id}">تم ✓</button>` : ''}</div>`).join('')}
    </div>
    ${m ? `<div class="grid" style="margin-bottom:12px">
      ${m.from_printer ? `<div class="stat"><div class="k">مبيعات أوراق الطابعة 🖨️</div><div class="v">${money(m.printer_total)}</div></div>` : `<div class="stat"><div class="k">مبيعات لويفرس</div><div class="v">${money(m.loyverse_total)}</div></div>
      <div class="stat"><div class="k">مبيعات التذكرة</div><div class="v">${money(m.ticket_total)}</div></div>`}
      <div class="stat"><div class="k">المجموع</div><div class="v">${money(m.total_sales)}</div></div>
      <div class="stat"><div class="k">تكلفة الوجبات</div><div class="v">${money(m.cogs)}</div></div>
      <div class="stat ${m.inventory_shortage_value > 0 ? 'red' : ''}"><div class="k">نقص البضاعة (ريال)</div><div class="v">${money(m.inventory_shortage_value)}</div></div>
      <div class="stat ${m.cash_shortage > 0 ? 'red' : m.cash_shortage != null ? 'green' : ''}"><div class="k">نقص الكاش</div><div class="v">${m.cash_shortage == null ? 'ما انجرد' : money(m.cash_shortage)}</div></div>
    </div>` : ''}
    ${S.me.has_ai && S.me.role !== 'worker' ? `<div class="card no-print"><div class="row" style="justify-content:space-between"><h3 style="margin:0">🤖 المساعد</h3>
      <div class="row">${S.me.can_sales ? '<a class="btn" href="#/assistant?tab=summary">لخّص لي اليوم</a><a class="btn" href="#/assistant?tab=reco">توصيات بكرة</a>' : ''}<a class="btn primary" href="#/assistant">🎤 كلّم المساعد</a></div></div></div>` : ''}
    ${(d.alerts || []).length && (isSup() || (S.me.approver_sections || []).length) ? `<div class="card"><h3>التنبيهات</h3>${alertsHtml(d.alerts)}</div>` : ''}
    ${isSup() || (S.me.approver_sections || []).length ? `<div class="card"><h3>الأقسام</h3><div class="tbl-wrap"><table>
      <thead><tr><th>القسم</th><th>أول اليوم</th><th>آخر اليوم</th>${isSup() ? '<th class="n">نقص</th>' : ''}</tr></thead><tbody>
      ${d.sections.map(s => `<tr><td class="item-name">${esc(s.name)}</td>
        <td>${esc(s.opening_user)} <span class="badge ${s.opening_done === s.items ? 'green' : 'red'}">${s.opening_done}/${s.items}</span> ${s.opening_approved ? `<span class="badge brand">استلم ${esc(s.opening_approved.by)}</span>` : ''}</td>
        <td>${esc(s.closing_user)} <span class="badge ${s.closing_done === s.items ? 'green' : 'amber'}">${s.closing_done}/${s.items}</span> ${s.closing_approved ? `<span class="badge brand">استلم ${esc(s.closing_approved.by)}</span>` : ''}</td>
        ${isSup() ? `<td class="n ${s.shortage_value > 0 ? 'pos' : ''}">${money(s.shortage_value)}</td>` : ''}</tr>`).join('')}
      </tbody></table></div></div>` : ''}
    ${d.last_sync ? `<div class="muted small">آخر سحب من لويفرس: ${ksa(d.last_sync.at)} — ${esc(d.last_sync.message)}</div>` : ''}`;
  $$('[data-rdone]', main).forEach(b => b.onclick = () => busy(b, async () => { await POST(`/api/reminders/${b.dataset.rdone}/done`); b.closest('.todo').remove(); }));
}

// الأرقام: عربي/فارسي، «1,500» = 1500، «2,5» = 2.5
const numStr = v => {
  let t = String(v ?? '').trim().replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/٫/g, '.').replace(/[٬\s]/g, '');
  return /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t) ? t.replace(/,/g, '') : t.replace(/,/g, '.');
};
const numIn = v => Number(numStr(v)) || 0;

// ===================== الصوت =====================
const SR = () => window.SpeechRecognition || window.webkitSpeechRecognition;
const normAr = t => String(t || '').replace(/[ًٌٍَُِّْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[^\p{L}\p{N}. ]/gu, ' ').replace(/\s+/g, ' ').trim();
const bigrams = t => { const x = ' ' + normAr(t) + ' ', out = []; for (let i = 0; i < x.length - 1; i++) out.push(x.slice(i, i + 2)); return out; };
function simAr(a, b) {
  const A = bigrams(a), B = bigrams(b); if (!A.length || !B.length) return 0;
  const m = new Map(); for (const g of B) m.set(g, (m.get(g) || 0) + 1);
  let hit = 0; for (const g of A) if (m.get(g)) { hit++; m.set(g, m.get(g) - 1); }
  return (2 * hit) / (A.length + B.length);
}
const AR_NUM = { 'صفر': 0, 'واحد': 1, 'وحده': 1, 'اثنين': 2, 'ثنين': 2, 'ثلاث': 3, 'ثلاثه': 3, 'اربع': 4, 'اربعه': 4, 'خمس': 5, 'خمسه': 5, 'ست': 6, 'سته': 6, 'سبع': 7, 'سبعه': 7, 'ثمان': 8, 'ثمانيه': 8, 'تسع': 9, 'تسعه': 9, 'عشر': 10, 'عشره': 10, 'نص': 0.5, 'ربع': 0.25 };
// «حنيذ دجاج 12» ← {الصنف الأقرب، 12}
function voiceMatch(said, rows) {
  const t = normAr(String(said).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace('٫', '.'));
  let qty = null, name = t;
  const m = /(\d+(?:\.\d+)?)(?!.*\d)/.exec(t);
  if (m) { qty = Number(m[1]); name = (t.slice(0, m.index) + t.slice(m.index + m[1].length)).trim(); }
  else { const w = t.split(' '); const last = w[w.length - 1]; if (last in AR_NUM) { qty = AR_NUM[last]; name = w.slice(0, -1).join(' '); } }
  if (qty == null || !name) return null;
  let best = null;
  for (const x of rows) { if (!x.r) continue; const sc = simAr(name, x.r.name); if (!best || sc > best.sc) best = { ...x, sc }; }
  return best && best.sc >= 0.45 ? { ...best, qty } : null;
}

// ===================== الجرد اليومي =====================
async function pageCount(main, alive) {
  const day = S.date; // اليوم اللي قدامهم — ما يتغير لو بدأ يوم جديد والصفحة مفتوحة
  const b = await GET('/api/board?date=' + day);
  if (!alive()) return;
  const me = S.me;
  const sup = isSup();
  const approverOf = new Set(me.approver_sections || []);
  const secs = b.sections;
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  let tab = qs.get('s') || sessionStorage.getItem('countTab') || (sup ? 'all' : 'mine');
  if (!sup && !approverOf.size) tab = 'mine';
  if (!['mine', 'all'].includes(tab) && !secs.find(s => String(s.id) === tab)) tab = 'mine';
  // أول/آخر الدوام: العامل يشوف عمود واحد بس (الأسهل). يبدأ بأول الدوام لين يخلص
  const myOpenMissing = b.rows.some(r => r.opening_user_id === me.id && r.opening == null);
  const win = me.count_window || {}, lockPhase = !sup && !approverOf.size && win.on; // ⏰ العامل: الوقت يحدد أول/آخر الدوام
  let phase = lockPhase ? (win.night ? 'closing' : 'opening') : qs.get('p') || (!sup && win.evening ? 'closing' : myOpenMissing ? 'opening' : 'closing'); // الصبح أول الدوام، ومن العصر آخر الدوام (ويقدر يبدّل)
  let lastMine = [], lastPrep = [];

  const draw = () => {
    const rowsFor = (tab === 'mine' ? b.rows.filter(r => !r.prep_only && (r.opening_user_id === me.id || r.closing_user_id === me.id))
      : tab === 'all' ? b.rows : b.rows.filter(r => String(r.section_id) === tab))
      .filter(r => sup || approverOf.has(r.section_id) || !r.empty || r.closing != null || (r.opening > 0 && !r.no_opening)); // 🐟 العامل يشوف بس اللي موجود عنده («يبدأ من الشراء» صفره مو جرد)
    const showCalc = r => sup || approverOf.has(r.section_id);
    const canOpen = r => !b.closed && !r.no_opening && (sup || r.opening_user_id === me.id || approverOf.has(r.section_id));
    const canClose = r => !b.closed && (sup || r.closing_user_id === me.id || approverOf.has(r.section_id));
    const canAct = r => !b.closed && (canOpen(r) || canClose(r) || r.prep_user_id === me.id || r.opening_user_id === me.id);
    const simple = !rowsFor.some(r => showCalc(r)); // العامل: عمود واحد
    const show = ph => !simple || phase === ph;
    const mineIn = rowsFor.filter(r => (phase === 'opening' ? canOpen(r) : canClose(r)));
    // العامل يشوف بس اللي عليه في هالوقت (فؤاد يفتح الإيدامات، وباسم يقفلها)
    const groups = groupBy(simple ? mineIn : rowsFor, r => r.section_id);
    // 🍳 اللي يقفله وما له جرد أول اليوم (اللحم: يبدأ من «طبخت» من المقسم): يطلع الصبح كمان عشان يضيف عليه
    const cookNow = b.closed || !simple || phase !== 'opening' ? [] : rowsFor.filter(r => r.no_opening && canClose(r));
    const prepRows = b.closed ? [] : [...b.rows.filter(r => r.prep_only), ...cookNow];
    lastPrep = prepRows;
    const onlyPrep = prepRows.length > 0 && !rowsFor.length && !sup;
    const left = mineIn.filter(r => r[phase] == null).length;
    lastMine = simple ? mineIn : [];
    // 🟢 العامل: شاشة وحدة بسيطة — «ابدأ الجرد» كبير (صنف صنف)، والجدول ورا «عرض كل الأصناف»
    const full = (() => { try { return sessionStorage.getItem('countFull') === '1'; } catch { return false; } })();
    if (simple && !sup && !approverOf.size && !full && !b.closed && mineIn.length && (left ? oneList().length : true)) {
      const photoLeft = phase === 'closing' && mineIn.some(r => r.closing_user_id === me.id && r.closing > 0 && !r.closing_image);
      main.innerHTML = `<div class="easy">
        <div class="easy-phase">${phase === 'opening' ? '☀️ أول الدوام' : '🌙 آخر الدوام'}</div>
        ${left ? `<div class="easy-left">باقي عليك <b>${left}</b> ${left === 1 ? 'صنف' : 'أصناف'}</div>
          <button class="btn primary easy-go" id="oneBtn">▶️ ابدأ الجرد</button>`
        : `<div class="easy-done">✓ خلصت جردك<small>الله يعطيك العافية 🌹</small></div>`}
        ${photoLeft ? '<label class="btn easy-sub"><input type="file" accept="image/*" capture="environment" hidden id="photoAll">📷 صوّر الباقي — صورة وحدة تكفي</label>' : ''}
        ${!isSup() && myRows().some(r => r.buy_store) ? '<button class="btn easy-sub" id="rcvBtn">📦 وصل سمك / بضاعة</button>' : ''}
        ${prepRows.length ? '<button class="btn easy-sub" id="easyAdd">🍳 طبخت أو زوّدت؟</button>' : ''}
        <button class="btn small easy-full" id="showFull">عرض كل الأصناف</button></div>`;
      const ob = $('#oneBtn', main); if (ob) ob.onclick = openOne;
      const pa = $('#photoAll', main); if (pa) pa.onchange = () => photoAll(pa);
      const rb = $('#rcvBtn', main); if (rb) rb.onclick = openReceive;
      const ea = $('#easyAdd', main); if (ea) ea.onclick = openPicker;
      $('#showFull', main).onclick = () => { try { sessionStorage.setItem('countFull', '1'); } catch { /* */ } draw(); };
      if (autoOne && ob) { autoOne = false; openOne(); }
      return;
    }
    main.innerHTML = `
      ${b.closed ? '<div class="alert amber">اليوم مقفل — التعديل للمالك بس</div>' : ''}
      ${!b.closed && !isSup() && myRows().some(r => r.buy_store) ? '<button class="btn no-print one-open" id="rcvBtn">📦 وصل سمك / بضاعة</button>' : ''}
      ${simple && !onlyPrep ? `${lockPhase ? `<div class="phase-sw no-print"><button class="on">${phase === 'opening' ? '☀️ أول الدوام' : '🌙 آخر الدوام'}</button></div>${phase === 'opening' ? `<p class="small muted no-print">آخر الدوام يفتح الساعة ${win.close % 12 || 12} بالليل 🌙</p>` : ''}` : `<div class="phase-sw no-print"><button data-ph="opening" class="${phase === 'opening' ? 'on' : ''}">أول الدوام</button><button data-ph="closing" class="${phase === 'closing' ? 'on' : ''}">آخر الدوام</button></div>`}
        ${mineIn.length ? (left ? `<div class="progress">باقي ${left} من ${mineIn.length} — اكتب العدد قدام كل صنف</div>
          ${oneList().length ? '<button class="btn primary no-print one-open" id="oneBtn">▶️ جرد صنف صنف</button>' : ''}
          <p class="small muted no-print">الرقم الرمادي مكتوب جاهز — غيّر بس اللي يختلف. زوّدت شي؟ «+ أضفت» واكتب الوزن.</p>
          ${mineIn.some(r => r[phase] == null && defQty(r, phase) != null) ? '<button class="btn primary no-print" id="doneAll" style="margin-bottom:8px">✓ خلصت — احفظ الباقي مثل ما هو مكتوب</button>' : ''}`
          : `<div class="alert" style="background:var(--green-soft);color:var(--green)"><b>خلصت ${phase === 'opening' ? 'أول الدوام' : 'آخر الدوام'} ✓</b> — كل الأرقام انحفظت. <a href="#/home">ارجع للرئيسية</a></div>`) : ''}` : ''}
      ${prepRows.length ? `<div class="card"><h3 style="margin-top:0">🍳 تطبخها / تضيف عليها</h3><p class="small muted">طبخت أو زوّدت؟ اضغط «+ أضفت» واكتب كم.</p>
        ${prepRows.map(r => `<div class="row" style="justify-content:space-between;margin:6px 0"><span>${r.photo ? `<img src="/uploads/${esc(r.photo)}" data-img class="item-ico" alt="">` : r.icon ? `<span class="item-ico">${esc(r.icon)}</span>` : ''}<b>${esc(r.name)}</b>${r.added ? ` <span class="muted small">أضفت اليوم ${qtyFmt(r.added)} ${esc(r.unit)}</span>` : ''}</span>
          <button class="btn primary" data-add="${r.item_id}">+ أضفت</button></div>`).join('')}</div>` : ''}
      ${!b.closed && phase === 'closing' && rowsFor.some(r => r.closing_user_id === me.id && r.closing > 0 && !r.closing_image) ? `<div class="row no-print" style="margin-bottom:8px"><label class="btn"><input type="file" accept="image/*" capture="environment" hidden id="photoAll">📷 صورة وحدة لكل الباقي</label><span class="small muted">صوّر الثلاجة أو الرف — صورة وحدة تكفي لكل أصنافك</span></div>` : ''}
      ${!b.closed && SR() && rowsFor.some(r => phase === 'opening' ? canOpen(r) : canClose(r)) ? `<div class="row no-print" style="margin-bottom:8px"><button class="btn" id="voice">🎤 جرد بالصوت</button><span class="small muted">قل اسم الصنف والعدد: «حنيذ دجاج 12»</span></div>` : ''}
      ${onlyPrep ? '' : `<div class="tabs no-print" ${(sup || approverOf.size) ? '' : 'hidden'}>
        <button data-tab="mine" class="${tab === 'mine' ? 'on' : ''}">أصنافي</button>
        ${(sup || approverOf.size) ? `<button data-tab="all" class="${tab === 'all' ? 'on' : ''}">الكل</button>` : ''}
        ${secs.map(s => `<button data-tab="${s.id}" class="${tab === String(s.id) ? 'on' : ''}">${esc(s.name)}</button>`).join('')}
      </div>`}
      ${!rowsFor.length && !onlyPrep ? '<div class="card muted">ما فيه أصناف عليك هنا. اختر قسم من فوق.</div>' : ''}
      ${groups.map(([secId, rows]) => {
        const s = secs.find(x => x.id === secId) || { name: 'بدون قسم', approvers: [] };
        const canApprove = sup || approverOf.has(secId);
        const calc = showCalc(rows[0]);
        return `<div class="card" data-sec="${secId}">
          <div class="sec-head"><h3 style="margin:0">${esc(s.name)}</h3>
            <div class="row small">
              <span class="muted">أول اليوم: ${esc(s.opening_user)} · آخر اليوم: ${esc(s.closing_user)}</span>
              ${simple && !canApprove ? '' : `${apprBtn(s, 'opening', canApprove)} ${apprBtn(s, 'closing', canApprove)}`}
            </div></div>
          <div class="tbl-wrap"><table><thead><tr>
            <th>الصنف</th>${show('opening') ? '<th>أول اليوم</th>' : ''}${calc ? '<th class="n">انسحب للمحضّر</th><th class="n">المفروض انصرف</th><th class="n">المفروض باقي</th>' : ''}
            ${show('closing') ? '<th>آخر اليوم</th>' : ''}${calc ? '<th class="n">الفرق</th>' : ''}</tr></thead><tbody>
            ${rows.map(r => `<tr data-item="${r.item_id}">
              <td><div class="item-name">${r.photo ? `<img src="/uploads/${esc(r.photo)}" data-img class="item-ico" alt="">` : r.icon ? `<span class="item-ico">${esc(r.icon)}</span>` : ''}${S.me && S.me.voice_reply ? `<button class="btn small no-print" data-say="${r.item_id}" data-name="${esc(r.name)}" style="padding:2px 8px;margin-inline-end:6px">🔊</button>` : ''}${esc(r.name)} <span class="muted small">${esc(r.unit)}</span>${r.leftover === 'waste' ? ' <span class="badge amber">الباقي ينرمى</span>' : r.leftover === 'fridge' ? ' <span class="badge brand">الباقي يطلع الثلاجة</span>' : r.leftover === 'fridge_added' ? ' <span class="badge brand">المضاف يطلع الثلاجة</span>' : ''}</div>
                ${r.note ? `<div class="item-note">${esc(r.note)}</div>` : ''}
                ${isHoney(r) && b.honey.log.length && (sup || approverOf.has(r.section_id)) ? `<div class="item-note">🍯 ${b.honey.log.map(l => `${l.kind === 'opening' ? 'الصبح' : l.kind === 'fill' ? 'فل' : l.kind === 'closing' ? 'الليل' : 'خلصت'}${l.weight != null ? ' ' + Math.round(l.weight * 1000) + 'ج' : ''}${l.image ? ` <img src="/uploads/${esc(l.image)}" data-img class="thumb-s" alt="">` : ''}`).join(' · ')}</div>` : ''}
                ${sup ? `<div class="item-note">${esc(r.opening_user)} ← ${esc(r.closing_user)}${r.prep_user ? ` · يطبخه ${esc(r.prep_user)}` : ''}</div>` : ''}
                ${r.add_only ? `<div class="item-note">❄️ فوق في ثلاجة اللحم: <b>${qtyFmt(r.upstairs)}</b>${r.sources.filter(x => x.upstairs != null).map(x => ` · ${esc(x.name)} فوق: <b>${qtyFmt(x.upstairs)}</b>`).join('')}</div>` : r.up_before != null && (r.up_before > 0 || r.from_fridge) ? `<div class="item-note">❄️ فوق في الثلاجة: <b>${qtyFmt(r.up_before)}</b>${r.from_fridge ? ` · نزل ${qtyFmt(r.from_fridge)}` : ''}</div>` : r.upstairs > 0 && sup ? `<div class="item-note">في المستودع: ${qtyFmt(r.upstairs)}</div>` : ''}
                ${r.fridge_gap > 0 ? `<div class="alert red small" style="margin:4px 0">كتبت ${qtyFmt(r.opening)} وفوق كان ${qtyFmt(r.up_before)} — الزيادة ${qtyFmt(r.fridge_gap)} من فين؟ إذا طبخت جديد اضغط «+ أضفت» وصحّح الرقم.</div>` : ''}
                ${r.added ? `<div class="item-note">أضافوا اليوم: ${qtyFmt(r.added)}</div>` : ''}
                ${canAct(r) ? `<div class="row no-print" style="gap:4px;margin-top:4px">
                  ${(isHoney(r) || r.count_only) && !sup ? '' : `<button class="btn small ${r.add_only ? 'primary' : ''}" data-add="${r.item_id}">+ أضفت</button>`}
                  <button class="btn small" data-mv="waste:${r.item_id}" title="خربان، طاح — ما ينحسب نقص عليك">🗑️ انرمى</button>
                  <button class="btn small" data-mv="meal:${r.item_id}" title="أكل الشباب — ما ينحسب نقص عليك">🍽️ أكل</button></div>` : ''}
                ${r.wasted ? `<div class="item-note">انرمى ${qtyFmt(r.wasted)}${r.waste_image && (sup || approverOf.has(r.section_id)) ? ` <img src="/uploads/${esc(r.waste_image)}" data-img class="thumb-s" alt="صورة اللي انرمى">` : ''}</div>` : ''}</td>
              ${show('opening') ? `<td>${r.empty && r.opening == null ? '<div class="item-note"><span class="small muted">ما فيه (صفر) — لو وصل اكتبه</span></div>' : ''}${r.sold_no_stock ? `<div class="item-note"><span class="badge red">انباع ${qtyFmt(r.sold_no_stock)} وما له جرد ولا استلام</span></div>` : ''}${r.add_only ? '<span class="small muted">بالإضافة (+ أضفت)</span>' : r.prev_missing && !b.closed && (sup || r.opening_user_id === me.id || r.closing_user_id === me.id) ? `${qtyInput(r, 'opening')}<div class="item-note"><span class="badge amber">آخر أمس ما انجرد — اكتب الموجود</span></div>` : r.from_prev ? `<span class="small muted">من آخر أمس${r.opening != null ? ' (' + qtyFmt(r.opening) + ')' : ''}</span>` : r.no_opening ? '<span class="small muted">يبدأ من الشراء</span>' : canOpen(r) ? qtyInput(r, 'opening') : qtyFmt(r.opening)}
                ${r.suggested_opening != null && r.opening == null && canOpen(r) ? `<button class="btn small" data-same="${r.suggested_opening}" title="نفس آخر أمس">= ${qtyFmt(r.suggested_opening)}</button>` : ''}
                <div class="item-note">${r.opening_by ? 'دخّله ' + esc(r.opening_by) : ''}${r.opening_gap ? ` <span class="badge amber">آخر أمس ${qtyFmt(r.prev_closing)}</span>` : ''}${r.pulled ? ` <span class="badge brand">من الثلاجة ${qtyFmt(r.pulled)}</span>` : ''}${r.cooked ? ` <span class="badge brand">انطبخ اليوم ${qtyFmt(r.cooked)}</span>` : ''}</div></td>` : ''}
              ${calc ? `<td class="n">${r.missing_in ? `<span class="badge red">ما اتسجل شراه</span>` : qtyFmt(r.received)}</td><td class="n">${qtyFmt(r.theoretical)}</td><td class="n"><b>${qtyFmt(r.remaining_expected)}</b></td>` : ''}
              ${show('closing') ? `<td>${canClose(r) ? qtyInput(r, 'closing') : qtyFmt(r.closing)}<div class="item-note">${r.closing_by ? 'دخّله ' + esc(r.closing_by) : ''}${r.to_fridge ? ` · طلع الثلاجة ${qtyFmt(r.to_fridge)}` : ''}</div>
                ${(r.need_photo && (r.closing > 0 || r.closing_image)) ? (r.closing_image ? `<img src="/uploads/${esc(r.closing_image)}" data-img class="thumb-s" alt="صورة الباقي">${canClose(r) ? `<label class="btn small no-print"><input type="file" accept="image/*" capture="environment" hidden data-cphoto="${r.item_id}">📷 غيّر</label>` : ''}`
                  : canClose(r) ? `<label class="btn small no-print"><input type="file" accept="image/*" capture="environment" hidden data-cphoto="${r.item_id}">📷 صوّر</label>` : '<span class="badge red">ما انصوّر</span>') : ''}</td>` : ''}
              ${calc ? `<td class="n">${r.missing_in && r.closing != null ? '<span class="small pos">نسجل الشراء أول — بعدها يطلع النقص</span>' : r.diff == null ? '—' : `<span class="${r.diff > 0 ? 'pos' : r.diff < 0 ? 'neg' : ''}">${r.diff > 0 ? 'نقص ' : r.diff < 0 ? 'زيادة ' : ''}${qtyFmt(Math.abs(r.diff))}</span>${r.diff_value ? `<div class="item-note">${money(r.diff_value)} ريال</div>` : ''}`}${r.waste ? `<div class="item-note">هالك ${qtyFmt(r.waste)}</div>` : ''}</td>` : ''}
            </tr>`).join('')}
          </tbody></table></div></div>`;
      }).join('')}
      ${!sup && !b.closed ? '<div id="myToday"></div>' : ''}`;

    $$('[data-tab]', main).forEach(x => x.onclick = () => { tab = x.dataset.tab; sessionStorage.setItem('countTab', tab); draw(); });
    $$('[data-ph]', main).forEach(x => x.onclick = () => { phase = x.dataset.ph; draw(); });
    $$('input[data-part]', main).forEach(inp => inp.addEventListener('change', () => saveParts(inp.closest('td'))));
    $$('input[data-phase]', main).forEach(inp => {
      inp.addEventListener('change', () => saveCount(inp));
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const all = $$('input[data-phase]', main); const i = all.indexOf(inp); (all[i + 1] || inp).focus(); } });
    });
    // 🗑️ انرمى: الكمية + صورة (لازم) + السبب — ما ينحسب نقص على الموظف
    $$('[data-mv]', main).forEach(btn => btn.onclick = () => {
      const [mode, idS] = btn.dataset.mv.split(':'), id = Number(idS); const r = b.rows.find(x => x.item_id === id);
      const meal = mode === 'meal', pics = [];
      modal(meal ? `🍽️ أكل الشباب من ${r.name}` : `انرمى من ${r.name}`, `
        <p class="muted small">${meal ? 'كم أكلتوا؟ صوّر الصحن — نوح يشوفه، وما ينحسب نقص عليك. اكتب مين أكل.' : 'كم انرمى (خربان، طاح، رجع من زبون)؟ صوّره — المشرف يشوف الصورة، وما ينحسب نقص عليك.'}</p>
        <div class="row"><input id="mvQ" class="qty" inputmode="decimal" style="font-size:20px;width:120px" placeholder="0"> <span class="muted">${esc(r.unit)}</span></div>
        <div style="margin-top:8px">${photoInputs('wst', false)}</div>
        <label class="f" style="margin-top:8px">${meal ? 'مين أكل؟' : 'السبب'}<input id="mvN" placeholder="${meal ? 'فؤاد، باسم…' : 'خربان، طاح…'}"></label>
        <div class="row" style="margin-top:12px"><button class="btn primary" id="mvOk">سجّل</button><button class="btn" data-close>إلغاء</button></div>`, (m, close) => {
        bindPhotos(m, 'wst', pics);
        $('#mvQ', m).focus();
        $('#mvOk', m).onclick = e => busy(e.currentTarget, async () => {
          const v = numIn($('#mvQ', m).value); if (!(v > 0)) throw new Error('اكتب الكمية');
          if (!pics.length) throw new Error(meal ? 'صوّر الأكل أول 📷' : 'صوّر اللي انرمى أول 📷');
          await POST('/api/transfer', { date: day, item_id: r.item_id, qty: v, mode: meal ? 'meal' : 'waste', note: ($('#mvN', m).value || '').trim(), image: pics[0] });
          close(); toast('انكتب ✓');
          Object.assign(b, await GET('/api/board?date=' + day)); draw();
        });
      });
    });
    // 🔊 اسم الصنف بالصوت (لو الصوت من السيرفر ما اشتغل => صوت الجوال)
    $$('[data-say]', main).forEach(btn => btn.onclick = e => { e.stopPropagation();
      const fall = () => { try { const u = new SpeechSynthesisUtterance(btn.dataset.name); u.lang = 'ar-SA'; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch { /* */ } };
      const a = new Audio('/api/items/' + btn.dataset.say + '/voice'); a.onerror = fall; a.play().catch(fall); });
    // + أضفت: كم؟ ومن فين؟ (طبخة جديدة / من السهوم / من الثلاجة فوق)
    $$('[data-add]', main).forEach(btn => btn.onclick = () => openAdd(b.rows.find(x => x.item_id === Number(btn.dataset.add))));
    // 📷 صورة الباقي آخر الدوام
    const pa = $('#photoAll', main); if (pa) pa.onchange = () => photoAll(pa);
    $$('[data-cphoto]', main).forEach(inp => inp.onchange = async () => {
      try {
        const [img] = await readImages(inp); if (!img) return;
        await POST('/api/count/photo', { date: day, item_id: Number(inp.dataset.cphoto), image: img });
        toast('انحفظت الصورة ✓');
        Object.assign(b, await GET('/api/board?date=' + day)); draw();
      } catch (e) { toast(e.message, true); }
    });
    $$('img[data-img]', main).forEach(img => img.onclick = () => showImage(img.src));
    // جرد بالصوت: يسمع «اسم الصنف + العدد» ويكتبه في خانته (${phase})
    const vb = $('#voice', main);
    if (vb) vb.onclick = () => {
      if (vb.dataset.on) { vb.rec && vb.rec.stop(); return; }
      const rec = new (SR())(); rec.lang = 'ar-SA'; rec.continuous = true; rec.interimResults = false;
      vb.rec = rec; vb.dataset.on = '1'; vb.textContent = '⏹️ وقّف الصوت';
      rec.onresult = e => {
        const said = e.results[e.results.length - 1][0].transcript;
        const hit = voiceMatch(said, $$(`input[data-phase="${phase}"]`, main).map(inp => ({ inp, r: b.rows.find(x => x.item_id === Number(inp.closest('tr').dataset.item)) })));
        if (!hit) return toast(`ما فهمت: «${said}» — قل الاسم والعدد`, true);
        hit.inp.value = hit.qty; saveCount(hit.inp); hit.inp.scrollIntoView({ block: 'center' });
        toast(`${hit.r.name} = ${hit.qty} ✓`);
      };
      rec.onerror = ev => { if (ev.error !== 'no-speech') toast('الصوت ما اشتغل — جرّب مرة ثانية', true); };
      rec.onend = () => { delete vb.dataset.on; vb.textContent = '🎤 جرد بالصوت'; };
      rec.start();
    };
    const ob = $('#oneBtn', main); if (ob) ob.onclick = openOne;
    if ($('#myToday', main)) loadMyToday();
    const rb = $('#rcvBtn', main); if (rb) rb.onclick = openReceive;
    if (autoRecv) { autoRecv = false; setTimeout(openReceive, 50); }
    if (autoPick) { autoPick = false; setTimeout(openPicker, 50); }
    if (autoOne && ob) { autoOne = false; openOne(); }
    const da = $('#doneAll', main);
    if (da) da.onclick = () => busy(da, async () => {
      const todo = lastMine.filter(r => r[phase] == null && defQty(r, phase) != null && !isHoney(r)).length;
      if (!await confirmBox(`بنحفظ ${todo} صنف بالرقم الرمادي المكتوب — متأكد إنها كلها صح؟`)) return;
      const need = [];
      for (const inp of $$(`input[data-phase="${phase}"]`, main)) {
        if (numStr(inp.value) !== '') continue;
        const r = b.rows.find(x => x.item_id === Number(inp.closest('tr').dataset.item)); if (!r) continue;
        const d = defQty(r, phase);
        if (d == null) { need.push(r.name); continue; }
        inp.value = d; await saveCount(inp, true);
      }
      if (need.length) toast('هذي لازم تكتبها بيدك: ' + need.join('، '), true); else draw();
    });
    // 🍯 القارورة
    const hsend = async (btn, body) => {
      try {
        const res = await POST('/api/honey', body); honeySay = res.say || '';
        Object.assign(b, await GET('/api/board?date=' + day)); draw(); toast('انحفظ ✓');
      } catch (e) { toast(e.message, true); }
    };
    $$('[data-hp]', main).forEach(inp => inp.onchange = async () => {
      const box = inp.closest('[data-honey]'), w = numStr($('[data-hw]', box).value);
      const [img] = await readImages(inp); if (!img) return;
      toast('⏳ أقرأ الميزان…');
      await hsend(inp, { ...(Number(w) > 0 ? { weight: Number(w) } : {}), image: img, end: box.dataset.honey === 'night' });
    });
    $$('[data-hempty]', main).forEach(btn => btn.onclick = () => confirm(`${b.honey.src} خلصت؟`) && hsend(btn, { empty_tub: true }));
    $$('[data-same]', main).forEach(btn => btn.onclick = () => { const inp = $('input[data-phase="opening"]', btn.closest('td')); inp.value = btn.dataset.same; saveCount(inp); btn.remove(); });
    $$('[data-appr]', main).forEach(btn => btn.onclick = () => busy(btn, async () => {
      const [phase, sec, undo] = btn.dataset.appr.split(':');
      await POST('/api/approve', { date: day, section_id: Number(sec), phase, undo: undo === 'undo' });
      toast(undo ? 'تم إلغاء الاستلام' : 'تم الاستلام ✓');
      Object.assign(b, await GET('/api/board?date=' + day)); draw();
    }));
  };

  // ↩️ اللي سجلته اليوم: أضفت/زودت/انرمى + الاستلام — يعدّل أو يمسح لو غلط (نوح يدري لو نقص كثير)
  async function loadMyToday() {
    const box = $('#myToday', main); if (!box) return;
    let mv = [], rc = [];
    try { [mv, rc] = await Promise.all([GET('/api/moves?date=' + day), GET('/api/receive/mine')]); } catch { return; }
    const seen = new Set(), NAME = { add: '+ أضفت', transfer: '+ نزّلت', convert: '+ سويت', waste: '🗑️ انرمى' };
    const rows = mv.filter(m => m.user_id === me.id && NAME[m.type] && (m.type === 'waste' || (m.location === 'floor' && m.qty > 0)))
      .filter(m => !m.ref || (seen.has(m.ref) ? false : seen.add(m.ref)));
    if (!rows.length && !rc.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="card no-print"><h3 style="margin-top:0">↩️ اللي سجلته اليوم</h3><p class="small muted">غلطت في رقم؟ عدّله أو امسحه.</p>
      ${rc.map(l => `<div class="row" style="justify-content:space-between;margin:6px 0"><span>📦 وصل ${esc(l.name)}: <b>${qtyFmt(l.qty)}</b> ${esc(l.unit)}</span><span><button class="btn small" data-rcv="${l.purchase_id}:${l.item_id}:${l.qty}">✏️ عدّل</button></span></div>`).join('')}
      ${rows.map(m => `<div class="row" style="justify-content:space-between;margin:6px 0"><span>${NAME[m.type]} ${esc(m.item)}: <b>${qtyFmt(Math.abs(m.qty))}</b> ${esc(m.unit)}</span><span><button class="btn small" data-mvx="${m.id}:${Math.abs(m.qty)}">✏️ عدّل</button> <button class="btn small" data-mvd="${m.id}">🗑️</button></span></div>`).join('')}</div>`;
    const ask = async old => { const v = prompt(`الكمية الصحيحة — كانت ${old}`, old); if (v == null) return null; const raw = numStr(v); if (raw === '' || !(Number(raw) >= 0)) { toast('اكتب رقم', true); return null; } return Number(raw); };
    const reload = async () => { Object.assign(b, await GET('/api/board?date=' + day)); draw(); toast('انعدّل ✓'); };
    $$('[data-mvx]', box).forEach(x => x.onclick = () => busy(x, async () => { const [id, old] = x.dataset.mvx.split(':'); const n = await ask(old); if (n == null) return; await PATCH('/api/moves/' + id, { qty: n }); await reload(); }));
    $$('[data-mvd]', box).forEach(x => x.onclick = async () => { if (await confirmBox('تمسحها؟')) busy(x, async () => { await DEL('/api/moves/' + x.dataset.mvd); await reload(); }); });
    $$('[data-rcv]', box).forEach(x => x.onclick = () => busy(x, async () => { const [pid, iid, old] = x.dataset.rcv.split(':'); const n = await ask(old); if (n == null) return; await PATCH('/api/receive/line', { purchase_id: Number(pid), item_id: Number(iid), qty: n }); await reload(); }));
  }
  function apprBtn(s, phase, can) {
    const a = s[phase + '_approved'], label = phase === 'opening' ? 'أول اليوم' : 'آخر اليوم';
    if (a) return `<span class="badge brand">استلم ${label}: ${esc(a.by)}</span>${can && !b.closed ? ` <button class="btn small" data-appr="${phase}:${s.id}:undo">إلغاء</button>` : ''}`;
    return can && !b.closed ? `<button class="btn small primary" data-appr="${phase}:${s.id}">استلام ${label}</button>` : `<span class="badge">${label}: ما استلم</span>`;
  }
  // الرقم الجاهز (رمادي): أول الدوام = آخر أمس، وآخر الدوام = صفر بس للي المفروض ما بقى منه شي — اللي فيه باقي لازم يكتبه بنفسه
  function defQty(r, phase) {
    if (phase === 'opening') return r.suggested_opening != null ? r.suggested_opening : null;
    return r.zero_ok ? 0 : null;
  }
  // 🍯 قارورة عسل السلام: صورة + وزن، والنظام يعرف الخطوة (الصبح ← فل بعد التعبئة ← آخر الدوام)
  const isHoney = r => b.honey && r.item_id === b.honey.item_id;
  // خلوف يصوّرها الصبح، والدعدع بالليل قبل ما يعبّي — الوزن ينقرا من الصورة
  function honeyCell(r) {
    const H = b.honey, opener = r.opening_user_id === me.id && r.opening == null, closer = r.closing_user_id === me.id && r.closing == null;
    const said = honeySay ? `<div class="item-note">${esc(honeySay).replace(/\n/g, '<br>')}</div>` : '';
    if (!opener && !closer) return `<span class="small">✓ ${qtyFmt(r.closing ?? r.opening)}</span>${said}`;
    const head = opener ? '☀️ أول الدوام: حط القارورة على الميزان وصوّرها' : '🌙 آخر الدوام: حط القارورة على الميزان وصوّرها <b>قبل ما تعبّيها</b> — بعدها عبّيها';
    return `<div data-honey="${opener ? 'open' : 'night'}"><div class="small">${head}</div>
      <div class="row no-print" style="gap:4px;margin-top:4px;flex-wrap:wrap">
      <label class="btn primary"><input type="file" accept="image/*" capture="environment" hidden data-hp>📷 صوّر القارورة</label>
      <input class="qty" data-hw inputmode="decimal" placeholder="الوزن (لو تبغى)" style="width:110px">
      ${closer ? `<button class="btn small" data-hempty>${esc(H.src)} خلصت</button>` : ''}</div>${said}</div>`;
  }
  // 📷 العامل يصوّر كل صنف آخر الدوام (الصفر بدون صورة)
  const photoReq = r => !!(me.count_photo && !isSup() && !approverOf.has(r.section_id) && r.closing_user_id === me.id && !b.closed);
  function qtyInput(r, phase) {
    if (isHoney(r) && (phase === 'opening' ? r.opening_user_id : r.closing_user_id) === me.id) return honeyCell(r); // 🍯 خلوف الصبح، الدعدع بالليل
    const v = r[phase];
    // جرد على أجزاء (آخر اليوم): خانة لكل جزء، والمجموع يتحسب
    if (phase === 'closing' && r.parts && r.parts.length) {
      const cp = r.closing_parts || {};
      return `<div class="row" style="gap:4px;flex-wrap:wrap" data-parts>${r.parts.map(pt => `<label class="small" style="display:flex;flex-direction:column;align-items:center">${esc(pt.name)}${pt.factor !== 1 ? ` ×${pt.factor}` : ''}${pt.drop ? ' 🗑️' : ''}<input class="qty" type="text" inputmode="decimal" data-part="${esc(pt.name)}" value="${cp[pt.name] ?? ''}" style="width:64px" aria-label="${esc(r.name + ' ' + pt.name)}"></label>`).join('')}</div><span class="small muted" data-ptot>${v == null ? '' : '= ' + qtyFmt(v)}</span><span class="saved"></span>`;
    }
    const fresh = v != null && isFresh(r, phase);
    if (v != null && !isSup() && !approverOf.has(r.section_id) && !fresh) return `<b>${qtyFmt(v)}</b> <span class="small muted">🔒 للتعديل كلّم المشرف</span>`; // العامل: مرة وحدة (بعد ١٠ دقايق)
    return `<input class="qty" type="text" inputmode="decimal" data-phase="${phase}" value="${v == null ? '' : v}" placeholder="${defQty(r, phase) ?? ''}" aria-label="${esc(r.name)}"><span class="saved"></span>${fresh && !isSup() ? '<div class="item-note">✏️ تقدر تعدّله لين يخلص وقت الجرد</div>' : ''}${r.tare ? `<div class="item-note">⚖️ اكتب الوزن مع الوعاء — ينطرح ${qtyFmt(r.tare)}</div>` : ''}`;
  }
  async function saveParts(td) {
    const tr = td.closest('tr'), mark = $('.saved', td), parts = {};
    for (const inp of $$('input[data-part]', td)) { const raw = numStr(inp.value); if (raw === '') continue; if (!(Number(raw) >= 0)) { toast('اكتب رقم', true); return; } parts[inp.dataset.part] = Number(raw); }
    mark.textContent = '…';
    try {
      const res = await POST('/api/count', { date: day, item_id: Number(tr.dataset.item), phase: 'closing', parts });
      const r = b.rows.find(x => x.item_id === Number(tr.dataset.item));
      const tot = r ? r.parts.reduce((t, pt) => t + (parts[pt.name] || 0) * (pt.factor || 1), 0) : 0;
      if (r) { r.closing = Object.keys(parts).length ? Math.round(tot * 1000) / 1000 : null; r.closing_parts = parts; }
      $('[data-ptot]', td).textContent = r && r.closing != null ? '= ' + qtyFmt(r.closing) : '';
      mark.textContent = ' ✓';
    } catch (e) { mark.textContent = ' ✗'; toast(e.message, true); }
  }
  // ⏱️ رقمي وانحفظ قبل أقل من ١٠ دقايق => أقدر أعدّله
  function isFresh(r, ph) { return r[ph + '_by_id'] === S.me.id && !!(S.me.edit_open && S.me.edit_open[ph]); } // ✏️ رقمه: يعدّله لين يخلص وقت الجرد
  // 🤔 رقم غريب: أكبر بكثير من المعتاد، أو «٨٠٠» بالكيلو وهو يقصد ٠.٨٠٠ — يرجع الرقم (يمكن مصحّح) أو null = ألغى
  async function checkQty(r, ph, n) {
    if (isSup() || !(n > 0)) return n;
    const ref = Math.max(0, ...[defQty(r, ph), r.suggested_opening, r.prev_closing, r.opening, r.received, r.added].map(Number).filter(Number.isFinite));
    if (/^(كجم|كيلو|كغ|لتر)$/.test(String(r.unit).trim()) && n >= 50 && ref < 10) {
      const k = Math.round(n) / 1000;
      return await choiceBox(`كتبت ${n} ${r.unit} لـ«${r.name}». تقصد ${k} ${r.unit}؟`, [{ label: `إيه، ${k}`, value: k }, { label: `لا، ${n}`, value: n }]);
    }
    if (ref > 0 && n > ref * 4 && n - ref > 10) return await confirmBox(`كتبت ${n} ${r.unit} لـ«${r.name}» — هذا كثير مقابل المعتاد (${qtyFmt(ref)}). متأكد؟`) ? n : null;
    return n;
  }
  async function saveCount(inp, skipCheck = false) {
    const tr = inp.closest('tr'), mark = inp.nextElementSibling;
    let raw = numStr(inp.value);
    if (raw !== '' && !(Number.isFinite(Number(raw)) && Number(raw) >= 0)) { toast('اكتب رقم', true); inp.focus(); return; }
    const r0 = b.rows.find(x => x.item_id === Number(tr.dataset.item));
    if (raw !== '' && !skipCheck && r0) {
      const n = await checkQty(r0, inp.dataset.phase, Number(raw));
      if (n == null) { inp.value = ''; mark.textContent = ''; inp.focus(); return; }
      raw = String(n); inp.value = raw;
    }
    mark.textContent = '…';
    try {
      const res = await POST('/api/count', { date: day, item_id: Number(tr.dataset.item), phase: inp.dataset.phase, qty: raw === '' ? null : Number(raw) });
      mark.textContent = res && res.need_photo ? ' ✓ 📷' : ' ✓'; if (res && res.note) toast(res.note, true);
      if (res && res.fixed) { toast('⚖️ ' + res.fixed); raw = String(res.saved); inp.value = raw; } // ٥١٣٠ => ٥.١٣
      const r = r0; if (r) { r[inp.dataset.phase] = raw === '' ? null : Number(raw); r[inp.dataset.phase + '_at'] = new Date().toISOString(); r[inp.dataset.phase + '_by_id'] = S.me.id; }
      // العدّاد «باقي كذا»: يتحدث على طول، ولما يخلص تطلع «خلصت ✓»
      if (lastMine.length && inp.dataset.phase === phase) {
        const left = lastMine.filter(x => x[phase] == null).length, pr = $('.progress', main);
        if (!left) draw(); else if (pr) pr.textContent = `باقي ${left} من ${lastMine.length} — اكتب العدد قدام كل صنف`;
      }
    } catch (e) { mark.textContent = ' ✗'; toast(e.message, true); }
  }
  // ▶️ جرد صنف صنف: صنف واحد بالشاشة — صورة كبيرة، الاسم بالصوت، لوحة أرقام، «حفظ والتالي»
  // 💡 سطر شرح يطلع أول ٣ مرات بس لكل شاشة (ولمحمد بالصوت)
  function hint(key, text) {
    let n = 0; try { n = Number(localStorage.getItem('hint:' + key)) || 0; localStorage.setItem('hint:' + key, String(n + 1)); } catch { /* */ }
    if (n >= 3) return '';
    if (S.me.voice_reply) setTimeout(() => { try { const u = new SpeechSynthesisUtterance(text); u.lang = 'ar-SA'; speechSynthesis.speak(u); } catch { /* */ } }, 900);
    return `<div class="hint">💡 ${esc(text)}</div>`;
  }
  const myRows = () => b.rows.filter(r => r.opening_user_id === S.me.id || r.closing_user_id === S.me.id || r.prep_user_id === S.me.id || isSup() || approverOf.has(r.section_id));
  const tileHtml = r => `<button class="pick-tile" data-pick="${r.item_id}">${r.photo ? `<img src="/uploads/${esc(r.photo)}" alt="">` : `<b>${esc(r.icon || '📦')}</b>`}<span>${esc(r.name)}</span></button>`;
  // ➕ أضفت من الرئيسية: شبكة صور أصنافه ← نفس كروت «أضفت»
  function openPicker() {
    const rows = myRows().filter(r => !isHoney(r)); if (!rows.length) return toast('ما عليك أصناف', true);
    modal('➕ أضفت — وش الصنف؟', `${hint('pick', 'اضغط صورة الصنف اللي زوّدته')}<div class="pick-grid">${rows.map(tileHtml).join('')}</div><button class="btn" data-close style="margin-top:8px;width:100%">إلغاء</button>`, (m, close) => {
      $$('[data-pick]', m).forEach(x => x.onclick = () => { close(); openAdd(b.rows.find(r => r.item_id === Number(x.dataset.pick))); });
    });
  }
  // 📦 وصل سمك/بضاعة: الصنف ← الوزن + صورة الميزان ← (صنف ثاني) ← سجّل الاستلام (ينتظر الحساب، ونوح يحط السعر بعدين)
  function openReceive() {
    const mine = myRows().filter(r => r.buy_store); if (!mine.length) return toast('ما عليك أصناف تستلمها', true);
    const sups = new Set(mine.map(r => r.last_supplier).filter(Boolean)); // + اللي يجي من نفس المورد ولو عهدة غيره (الديراك من الدعدع)
    const rows = mine.concat(b.rows.filter(r => !mine.includes(r) && r.kind === 'raw' && sups.has(r.last_supplier)));
    const lines = []; let supplier = '', img = '';
    modal('📦 وصل سمك', '<div class="one" id="rcBox"></div>', (m, close) => {
      const box = $('#rcBox', m);
      const pickItem = () => {
        box.innerHTML = `${hint('rc1', 'اضغط صورة السمك اللي وصل')}<div class="one-prog">وش وصل؟</div><div class="pick-grid">${rows.map(tileHtml).join('')}</div>
          ${lines.length ? '<button class="btn" id="rcSum" style="width:100%">رجوع</button>' : '<button class="btn" id="rcCancel" style="width:100%">إلغاء</button>'}`;
        $$('[data-pick]', box).forEach(x => x.onclick = () => weigh(rows.find(r => r.item_id === Number(x.dataset.pick))));
        const sb = $('#rcSum', box); if (sb) sb.onclick = summary;
        const cb = $('#rcCancel', box); if (cb) cb.onclick = close;
      };
      const weigh = r => {
        let buf = '', photo = '';
        if (!supplier) supplier = r.last_supplier || (rows.find(x => x.last_supplier) || {}).last_supplier || '';
        box.innerHTML = `${hint('rc2', 'حطه على الميزان، اكتب الوزن، وصوّر الميزان')}
          <div class="one-pic" style="max-width:200px">${r.photo ? `<img src="/uploads/${esc(r.photo)}" alt="">` : `<span>${esc(r.icon || '📦')}</span>`}</div>
          <button class="one-name" id="rcSay">${esc(r.name)} 🔊</button><span class="one-unit">${esc(r.unit)}</span>
          <div class="one-num def" id="rcNum">كم؟</div>
          <div class="one-pad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'].map(k => `<button data-k="${k}">${k}</button>`).join('')}</div>
          <label class="btn one-go" id="rcPh" style="cursor:pointer"><input type="file" accept="image/*" capture="environment" hidden id="rcFile"><span>📷 صوّر الميزان</span></label>
          <div class="one-act"><button class="btn primary one-go" id="rcOk">✓ تمام</button><button class="btn" id="rcBack">رجوع</button></div>`;
        const num = $('#rcNum', box), paint = () => { num.textContent = buf || 'كم؟'; num.classList.toggle('def', !buf); };
        $$('[data-k]', box).forEach(k => k.onclick = () => { const c = k.dataset.k; buf = c === '⌫' ? buf.slice(0, -1) : (c === '.' && buf.includes('.')) ? buf : (buf + c).slice(0, 8); paint(); });
        $('#rcSay', box).onclick = () => sayName(r);
        $('#rcBack', box).onclick = pickItem;
        $('#rcFile', box).onchange = async e => { const [d] = await readImages(e.target); if (d) { photo = d; $('#rcPh', box).classList.add('primary'); $('#rcPh span', box).textContent = '📷 ✓ انصوّر'; } };
        $('#rcOk', box).onclick = () => {
          const q = numIn(buf); if (!(q > 0)) return toast('اكتب الوزن', true);
          if (!photo) return toast('صوّر الميزان أول 📷', true);
          if (!img) img = photo;
          const ex = lines.find(l => l.item_id === r.item_id); if (ex) ex.qty = Math.round((ex.qty + q) * 1000) / 1000; else lines.push({ item_id: r.item_id, name: r.name, unit: r.unit, qty: q });
          summary();
        };
        if (S.me.voice_reply) sayName(r);
      };
      const summary = () => {
        const sups = [...new Set(rows.map(r => r.last_supplier).filter(Boolean))];
        box.innerHTML = `<div class="one-prog">الاستلام</div>
          <div style="width:100%;max-width:320px">${lines.map(l => `<div class="row" style="justify-content:space-between;font-size:18px;padding:6px 0;border-bottom:1px solid var(--line)"><b>${esc(l.name)}</b><span>${qtyFmt(l.qty)} ${esc(l.unit)}</span></div>`).join('')}</div>
          <div class="small muted">من مين؟</div>
          <div class="ad-units">${sups.map(x => `<button class="ad-unit ${x === supplier ? 'on' : ''}" data-sup="${esc(x)}">${esc(x)}</button>`).join('')}</div>
          <input id="rcSup" value="${esc(supplier)}" placeholder="اسم المورد" style="max-width:300px">
          <button class="btn one-go" id="rcMore">➕ سمك ثاني</button>
          <div class="one-act"><button class="btn primary one-go" id="rcSave">✓ سجّل الاستلام</button><button class="btn" id="rcCancel2">إلغاء</button></div>`;
        $$('[data-sup]', box).forEach(x => x.onclick = () => { supplier = x.dataset.sup; $('#rcSup', box).value = supplier; $$('[data-sup]', box).forEach(y => y.classList.toggle('on', y === x)); });
        $('#rcSup', box).oninput = e => { supplier = e.target.value.trim(); };
        $('#rcMore', box).onclick = pickItem;
        $('#rcCancel2', box).onclick = close;
        $('#rcSave', box).onclick = e => busy(e.currentTarget, async () => {
          if (!supplier) throw new Error('من مين وصل؟ اختر المورد');
          await POST('/api/receive', { date: day, supplier, lines: lines.map(l => ({ item_id: l.item_id, qty: l.qty })), image: img, notify: true });
          close(); toast('📦 انسجل الاستلام ✓');
          Object.assign(b, await GET('/api/board?date=' + day)); draw();
        });
      };
      pickItem();
    });
  }
  // ➕ أضفت (كروت): من الزر جنب الصنف، ومن شبكة «➕ أضفت»، ومن نهاية «صنف صنف»
  async function openAdd(r) {
    if (!r) return;
    const it = (await itemsList().catch(() => [])).find(i => i.id === r.item_id) || {};
    const units = it.units || [];
    // اللحم والمطفي «بالإضافة»: من الثلاجة فوق، أو من السهوم (يتقسم سهم)، والمطفي طبخة جديدة
    const fridgeOpt = r.upstairs > 0 || r.buy_store ? [['fridge', `من الثلاجة فوق${r.add_only && r.can_cook ? ' (حق أمس)' : ''} — فيها ${qtyFmt(r.upstairs)}`]] : [];
    const srcOpts = r.sources.map(s => [`from:${s.item_id}`, s.upstairs != null ? `من ${s.name} — أقسم (فوق ${qtyFmt(s.upstairs)})` : `من ${s.name} (الواحد = ${qtyFmt(s.ratio)} ${r.unit})`]);
    // 🐑 ناتج تقسيم (حنيذ/برم/مغش): «طبخت جديد» = من المقسوم فوق (نفس الصنف)، «من السهوم»، «من القديم» — مو من «لحم»
    const opts = r.split_pack ? [['pack', ''], ...(r.upstairs > 0 ? [['fridge', '']] : [])] // 📦 كرتون أبو عصاية: «فكيت كرتون» يدخلها على طول
      : r.split_out
      ? [['fridge', ''], ...r.sources.filter(x => x.item_id !== r.old_item_id).map(x => [`from:${x.item_id}`, '']), ...r.sources.filter(x => x.item_id === r.old_item_id).map(x => [`from:${x.item_id}`, ''])]
      : r.add_only
      ? (r.can_cook ? [['cook', 'طبخة جديدة (تنخصم مكوناتها)'], ...fridgeOpt] : [...fridgeOpt, ...srcOpts])
      : [['cook', r.can_cook ? `طبخة / تجهيز جديد (تنخصم مكوناته)` : 'جبته / جهّزته جديد'], ...srcOpts, ...fridgeOpt];
    if (!opts.length) return toast(r.sources.some(x => x.upstairs != null) ? 'ما فيه شي فوق — قسّم ذبيحة أول من «🐑 تقسيم الذبيحة»' : 'ما فيه شي مسجّل في الثلاجة اللي ورا — سجّل الاستلام أول، أو اكتب الموجود في الجرد', true);
    // 🃏 كروت: «من وين؟» (لو أكثر من خيار) ← «كم؟» بلوحة الأرقام — نفس الخيارات ونفس اللي ينرسل
    const card = ([k, v]) => k === 'pack' ? { ic: '📦', t: `فكيت ${r.split_pack.name}`, d: `اكتب كم ${r.unit} طلعت` }
      : k === 'cook' ? { ic: r.can_cook ? '🍳' : '🛒', t: r.can_cook ? 'طبخت جديد' : 'جبته جديد', d: r.can_cook ? 'تنخصم مكوناته' : '' }
      : k === 'fridge' ? (r.split_out && !r.split_pack ? { ic: '🍳', t: 'طبخت جديد', d: r.upstairs > 0 ? `من المقسوم — فوق ${qtyFmt(r.upstairs)}` : 'ما فيه مقسوم فوق — قسّم ذبيحة أول 🐑', off: !(r.upstairs > 0) }
        : { ic: '❄️', t: r.buy_store ? 'من الثلاجة اللي ورا' : 'من الثلاجة فوق', d: r.upstairs > 0 ? `فيها ${qtyFmt(r.upstairs)}` : 'ما انسجل فيها شي — نزّله عادي' })
      : (() => { const sx = r.sources.find(x => String(x.item_id) === k.slice(5)) || {};
        if (r.split_out && sx.item_id === r.old_item_id) return { ic: '🧊', t: 'من القديم (حق أمس)', d: `فيه ${qtyFmt(sx.upstairs || 0)}`, off: !(sx.upstairs > 0) };
        return { ic: r.split_out ? '🐑' : '📦', t: `من ${sx.name || ''}`, d: sx.upstairs != null ? `فوق ${qtyFmt(sx.upstairs)}` : `الواحد = ${qtyFmt(sx.ratio)} ${r.unit}` }; })();
    modal(`+ أضفت ${r.name}`, '<div class="one" id="adBox"></div>', (m, close) => {
      const box = $('#adBox', m);
      let src = opts.length === 1 && (!r.split_out || r.split_pack) ? opts[0][0] : null, unit = '', buf = '';
      const pick = () => {
        box.innerHTML = `${hint('add1', 'اختر من وين جبته')}<div class="one-prog">من وين؟</div><div class="ad-cards">${opts.map((o, i) => { const c = card(o); return `<button class="ad-card ${c.off ? 'off' : ''}" data-src="${i}"><b>${c.ic}</b><span>${esc(c.t)}</span>${c.d ? `<small>${esc(c.d)}</small>` : ''}</button>`; }).join('')}</div>
          ${r.split_out && !r.split_pack && S.me.split_meat ? '<a class="btn" href="#/transfer" data-close style="margin-top:6px">🐑 قسّم ذبيحة</a>' : ''}
          <button class="btn" data-close style="margin-top:6px">إلغاء</button>`;
        $$('[data-src]', box).forEach(x => x.onclick = () => { const o = opts[Number(x.dataset.src)]; if (card(o).off) return toast(card(o).d, true); src = o[0]; qty(); });
        $$('[data-close]', box).forEach(x => x.addEventListener('click', close));
      };
      const qty = () => {
        const c = card(opts.find(o => o[0] === src)), from = src.startsWith('from:');
        const fromName = from ? (r.sources.find(x => String(x.item_id) === src.slice(5)) || {}).name : '';
        buf = '';
        box.innerHTML = `<div class="one-pic" style="max-width:200px">${r.photo ? `<img src="/uploads/${esc(r.photo)}" alt="">` : `<span>${esc(r.icon || '📦')}</span>`}</div>
          <button class="one-name" id="adSay">${esc(r.name)} 🔊</button>
          <div class="row" style="justify-content:center;gap:6px"><span class="one-part">${c.ic} ${esc(c.t)}</span>${opts.length > 1 ? '<button class="btn small" id="adBack">تغيير</button>' : ''}</div>
          <div class="ad-units" ${src === 'pack' || !isPurch() ? 'hidden' : ''}>${[['', r.unit], ...units.map(u => [u.name, `${u.name} = ${qtyFmt(u.factor)}`])].map(([k, lbl]) => `<button class="ad-unit ${k === unit ? 'on' : ''}" data-u="${esc(k)}">${esc(lbl)}</button>`).join('')}</div>
          ${hint('add2', 'اكتب الكمية بالأزرار، واضغط «سجّل»')}
          ${r.tare && src !== 'pack' ? `<div class="item-note">⚖️ زن مع الوعاء واكتب الرقم مثل الميزان — ينطرح ${qtyFmt(r.tare)}</div>` : ''}
          <div class="one-num def" id="adNum">كم؟</div>
          <div class="one-pad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'].map(k => `<button data-k="${k}">${k}</button>`).join('')}</div>
          ${from ? `<details class="small" style="width:100%;max-width:300px"><summary>كتبت كم استخدمت من ${esc(fromName)}؟ (اختياري)</summary><input id="adFq" class="qty" inputmode="decimal" placeholder="تلقائي" style="margin-top:6px"></details>` : ''}
          <div class="one-act"><button class="btn primary one-go" id="adOk">✓ سجّل</button><button class="btn" id="adCancel">إلغاء</button></div>`;
        const num = $('#adNum', box), paint = () => { num.textContent = buf || 'كم؟'; num.classList.toggle('def', !buf); };
        $$('[data-k]', box).forEach(k => k.onclick = () => { const ch = k.dataset.k; buf = ch === '⌫' ? buf.slice(0, -1) : (ch === '.' && buf.includes('.')) ? buf : (buf + ch).slice(0, 8); paint(); });
        $$('[data-u]', box).forEach(x => x.onclick = () => { unit = x.dataset.u; $$('[data-u]', box).forEach(y => y.classList.toggle('on', y === x)); });
        $('#adSay', box).onclick = () => sayName(r);
        const bk = $('#adBack', box); if (bk) bk.onclick = pick;
        $('#adCancel', box).onclick = close;
        $('#adOk', box).onclick = e => busy(e.currentTarget, async () => {
          const q = numIn(buf); if (!(q > 0)) throw new Error('كم أضفت؟');
          const body = { date: day, item_id: r.item_id, qty: q, unit };
          if (src === 'pack') { // فكّ الكرتون = تقسيم بناتج واحد (يدخل الجرد على طول)
            await POST('/api/split', { date: day, item_id: r.split_pack.id, qty: 1, outputs: [{ item_id: r.item_id, qty: q }] });
            close(); toast(`${r.name} +${q} ✓`); Object.assign(b, await GET('/api/board?date=' + day)); draw(); return;
          }
          if (from) Object.assign(body, { source: 'from', from_item_id: Number(src.slice(5)), from_qty: numIn(($('#adFq', box) || {}).value || '') || undefined });
          else body.source = src;
          let res;
          try { res = await POST('/api/add', body); }
          catch (err) { // 🔁 سجّلها قبل شوي — نتأكد قبل ما تنحسب مرتين
            if (!err.data || !err.data.needForce) throw err;
            if (!await confirmBox(err.message)) return;
            res = await POST('/api/add', { ...body, force: true });
          }
          close(); toast(res && res.fixed ? `⚖️ ${r.name}: ${res.fixed}` : res && res.net != null ? `${r.name} +${qtyFmt(res.net)} ✓ (الصافي بعد وزن الوعاء ${qtyFmt(r.tare)})` : `${r.name} +${q}${unit ? ' ' + unit : ''} ✓`);
          Object.assign(b, await GET('/api/board?date=' + day)); draw();
        });
      };
      if (src) qty(); else pick();
      if (S.me.voice_reply) sayName(r);
    });

  }
  function oneList() {
    return lastMine.filter(r => r[phase] == null && !isHoney(r) && !(phase === 'opening' && r.add_only))
      .sort((x, y) => (x.empty ? 1 : 0) - (y.empty ? 1 : 0)); // اللي فيه شي أول
  }
  function sayName(r) {
    const fall = () => { try { const u = new SpeechSynthesisUtterance(r.name); u.lang = 'ar-SA'; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch { /* */ } };
    try { const a = new Audio('/api/items/' + r.item_id + '/voice'); a.onerror = fall; a.play().catch(fall); } catch { fall(); }
  }
  // 📷 صورة وحدة (الثلاجة أو الرف) تنحط على كل أصنافه اللي فيها باقي
  async function photoAll(inp) {
    try {
      const [img] = await readImages(inp); if (!img) return;
      const r = await POST('/api/count/photo-all', { date: day, image: img });
      toast(`انحفظت الصورة ✓ (${r.items} صنف)`);
      Object.assign(b, await GET('/api/board?date=' + day)); draw();
    } catch (e) { toast(e.message, true); }
  }
  function openOne() {
    const list = oneList(); if (!list.length) return toast('ما فيه أصناف باقية ✓');
    // خطوة لكل صنف — والصنف اللي بالأجزاء (ديراك: كامل/مقطّع) خطوة لكل جزء، وينحفظ مع بعض بعد آخر جزء
    const steps = list.flatMap(r => phase === 'closing' && r.parts && r.parts.length ? r.parts.map((pt, k) => ({ r, pt, last: k === r.parts.length - 1 })) : [{ r }]);
    const partsBuf = new Map(), shots = new Map(); // 📷 صورة كل صنف (آخر الدوام)
    const saveParts = async r => {
      const got = partsBuf.get(r.item_id); partsBuf.delete(r.item_id); if (!got) return; // تخطّى كل الأجزاء: ما ينحفظ شي
      const any = Object.values(got).some(v => v > 0);
      await POST('/api/count', { date: day, item_id: r.item_id, phase: 'closing', parts: got, ...(shots.get(r.item_id) ? { image: shots.get(r.item_id) } : {}) });
      r.closing = Math.round(r.parts.reduce((t, p) => t + (got[p.name] || 0) * (p.factor || 1), 0) * 1000) / 1000; r.closing_parts = got;
      r.closing_at = new Date().toISOString(); r.closing_by_id = S.me.id; toast(`${r.name} = ${qtyFmt(r.closing)} ✓`);
    };
    let i = 0, buf = '';
    modal('▶️ جرد صنف صنف', '<div class="one" id="one"></div>', (m, close) => {
      const box = $('#one', m), done = () => { close(); draw(); };
      const end = () => {
        const honeyLeft = lastMine.some(r => isHoney(r)) && b.honey && b.honey.step !== 'done';
        box.innerHTML = `<div class="one-done">✓ خلصت</div>
          ${lastPrep.length ? '<div class="small muted">طبخت أو زوّدت؟</div>' + lastPrep.map(r => `<button class="btn one-go" data-endadd="${r.item_id}">🍳 ${esc(r.name)}</button>`).join('') : ''}
          ${S.me.split_meat ? '<a class="btn one-go" href="#/transfer">🐑 قسّم ذبيحة</a>' : ''}
          ${honeyLeft ? '<button class="btn one-go" id="oneHoney">🍯 القارورة</button>' : ''}
          ${phase === 'closing' && lastMine.some(r => r.closing > 0 && !r.closing_image) ? '<label class="btn one-go"><input type="file" accept="image/*" capture="environment" hidden id="oneAll">📷 صوّر الباقي — صورة وحدة تكفي</label>' : ''}
          <button class="btn primary one-go" id="oneBack">${isSup() ? 'رجوع للجدول' : 'تم ✓'}</button>`;
        const oa = $('#oneAll', box); if (oa) oa.onchange = () => photoAll(oa);
        $('#oneBack', box).onclick = done;
        const hb = $('#oneHoney', box); if (hb) hb.onclick = () => { done(); setTimeout(() => { const h = $('[data-honey]', main); if (h) h.scrollIntoView({ block: 'center' }); }, 100); };
        $$('[data-endadd]', box).forEach(x => x.onclick = () => { done(); setTimeout(() => openAdd(b.rows.find(y => y.item_id === Number(x.dataset.endadd))), 100); });
        $$('a.one-go', box).forEach(x => x.addEventListener('click', close));
      };
      const show = () => {
        if (i >= steps.length) return end();
        const { r, pt, last } = steps[i], d = pt ? null : defQty(r, phase); buf = '';
        if (!isSup() && (!pt || pt === r.parts[0])) setTimeout(() => sayName(r), 200); // 🔊 اسم الصنف بالصوت لحاله (للي ما يقرأ زين)
        // 📷 ما فيه صورة لكل صنف (صورة وحدة للكل في الآخر) — بس الوزن: صورة الميزان تقرا الرقم بداله (اختياري)
        const weigh = phase === 'closing' && photoReq(r) && /^(كجم|كيلو|كغ)$/.test(String(r.unit).trim()) && !pt, cam = weigh;
        let readNet = false;
        box.innerHTML = `<div class="one-prog">${i + 1} من ${steps.length}</div>
          <div class="one-pic${r.photo ? '' : ' small'}">${r.photo ? `<img src="/uploads/${esc(r.photo)}" alt="">` : `<span>${esc(r.icon || '📦')}</span>`}</div>
          <button class="one-name" id="oneSay">${esc(r.name)} 🔊</button>
          ${pt ? `<span class="one-part">${esc(pt.name)}${pt.factor !== 1 ? ` ×${pt.factor}` : ''}${pt.drop ? ' 🗑️' : ''}</span>` : ''}
          <span class="one-unit">${esc(r.unit)}</span>
          ${cam ? `<label class="btn ${shots.get(r.item_id) ? '' : 'primary'} one-go" style="font-size:20px"><input type="file" accept="image/*" capture="environment" hidden id="oneCam">📷 ${shots.get(r.item_id) ? 'انصوّر ✓ — صوّر مرة ثانية' : weigh ? 'حطه على الميزان وصوّر' : 'صوّر الصنف'}</label>
            ${shots.get(r.item_id) ? `<img src="${shots.get(r.item_id)}" class="thumb-s" alt="">` : ''}<div class="small muted" id="oneRead"></div>` : ''}
          <div class="one-num def" id="oneNum">${d ?? '—'}</div>
          <div class="one-pad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'].map(k => `<button data-k="${k}">${k}</button>`).join('')}</div>
          <div class="one-act"><button class="btn primary one-go" id="oneGo">✓ ${pt && !last ? 'التالي' : 'حفظ والتالي'}</button><button class="btn" id="oneSkip">تخطّي</button></div>`;
        const num = $('#oneNum', box);
        const paint = () => { num.textContent = buf || (d ?? '—'); num.classList.toggle('def', !buf); };
        $$('[data-k]', box).forEach(k => k.onclick = () => { readNet = false; const c = k.dataset.k; buf = c === '⌫' ? buf.slice(0, -1) : (c === '.' && buf.includes('.')) ? buf : (buf + c).slice(0, 8); paint(); });
        $('#oneSay', box).onclick = () => sayName(r);
        const camIn = $('#oneCam', box);
        if (camIn) camIn.onchange = async () => {
          const [img] = await readImages(camIn); if (!img) return;
          shots.set(r.item_id, img);
          const lbl = camIn.parentElement; lbl.classList.remove('primary'); lbl.lastChild.textContent = 'انصوّر ✓ — صوّر مرة ثانية';
          if (!weigh) return;
          const out = $('#oneRead', box); out.textContent = '⏳ أقرأ الميزان…';
          try {
            const res = await POST('/api/count/read', { item_id: r.item_id, image: img });
            if (res.unreadable) { out.textContent = 'ما قدرت أقرأ الرقم — صوّر قريب من الشاشة، أو اكتبه'; return; }
            buf = String(res.weight); readNet = true; paint();
            out.textContent = `⚖️ الميزان ${qtyFmt(res.gross)}${res.tare ? ` − الوعاء ${qtyFmt(res.tare)}` : ''} — لو صح اضغط ✓`;
          } catch (e) { out.textContent = e.message; }
        };
        // تخطّي = هالشاشة بس (الجزء الثاني يطلع بعدها) — وبعد آخر جزء ينحفظ اللي انكتب
        $('#oneSkip', box).onclick = () => busy($('#oneSkip', box), async () => { if (pt && last) await saveParts(r); i++; show(); });
        $('#oneGo', box).onclick = () => busy($('#oneGo', box), async () => {
          let n = buf !== '' ? Number(buf) : d;
          if (n == null || !Number.isFinite(n)) return toast('اكتب الرقم', true);
          if (pt) { // جزء: نجمّع، ونحفظ بعد آخر جزء (نفس الجدول)
            const got = partsBuf.get(r.item_id) || {}; got[pt.name] = n; partsBuf.set(r.item_id, got);
            if (last) await saveParts(r);
            i++; return show();
          }
          if (buf !== '' && !readNet) { n = await checkQty(r, phase, n); if (n == null) { buf = ''; paint(); return; } }
          const res = await POST('/api/count', { date: day, item_id: r.item_id, phase, qty: n, ...(cam && shots.get(r.item_id) ? { image: shots.get(r.item_id) } : {}), ...(readNet ? { net: true } : {}) });
          if (res && res.note) toast(res.note, true);
          if (res && res.fixed) { n = res.saved; toast('⚖️ ' + res.fixed); }
          r[phase] = n; r[phase + '_at'] = new Date().toISOString(); r[phase + '_by_id'] = S.me.id;
          toast(`${r.name} = ${n} ✓`); i++; show();
        });
        if (S.me.voice_reply && !pt || (S.me.voice_reply && pt && steps[i - 1]?.r !== r)) sayName(r);
      };
      show();
      m.parentElement.addEventListener('click', e => { if (e.target === m.parentElement) draw(); });
    });
  }
  let autoRecv = qs.get('recv') === '1', autoPick = qs.get('add') === '1';
  // العامل: كل ما فتح الرابط وعليه أصناف، يبدأ صنف صنف على طول (إلا لو اختار «عرض كل الأصناف»)
  let autoOne = !autoRecv && !autoPick && (qs.get('one') === '1' || !!(S.me && S.me.role === 'worker' && (() => { try { return sessionStorage.getItem('countFull') !== '1'; } catch { return true; } })()));
  draw();
}

// 🍯 رد آخر خطوة للقارورة + عداد التعبئة (١٥ دقيقة)
let honeySay = '';
setInterval(() => {
  for (const el of document.querySelectorAll('[data-honey-t]')) {
    const left = Number(el.dataset.honeyT) + 15 * 60e3 - Date.now();
    el.textContent = left > 0 ? `— باقي ${Math.floor(left / 60e3)}:${String(Math.floor(left / 1e3) % 60).padStart(2, '0')}` : '— ⏰ تأخرت!';
  }
}, 1000);
const C_parts = v => { try { return v ? JSON.parse(v) : null; } catch { return null; } };

// ===================== السحب والتحضير =====================
async function pageTransfer(main, alive) {
  const day = S.date;
  const [items, splits, moves] = await Promise.all([itemsList(true), GET('/api/splits'), GET('/api/moves?types=split,add,convert,transfer&date=' + day)]);
  if (!alive()) return;
  const daily = items.filter(i => i.daily);
  let src = splits[0] ? splits[0].id : '', outs = [];
  const loadOuts = () => { const sp = splits.find(x => x.id === Number(src)); outs = sp ? sp.outputs.map(o => ({ item_id: o.out_item_id, qty: '' })) : []; };
  loadOuts();
  const floorMoves = moves.filter(m => m.location === 'floor' || m.type === 'split');
  main.innerHTML = `
    <div class="card"><h3>🐑 قسّم ذبيحة أو سهوم</h3>
      <p class="muted small">الذبيحة تجي من المشتريات. لما تقسمها اكتب كم طلع من كل صنف — يدخل الجرد على طول. والسهوم اللي ما انباعت تتقسم برم وحنيذ بنفس الطريقة.</p>
      <div class="row"><label class="f grow">وش تقسم؟<select id="sSrc">${itemOptions(items, src)}</select></label>
        <label class="f">كم؟<input id="sQty" class="qty" inputmode="decimal" value="1"></label></div>
      <div id="sOuts" style="margin-top:8px"></div>
      <div class="row" style="margin-top:6px"><button class="btn small" id="sAdd">+ صنف</button></div>
      <button class="btn primary" id="sGo" style="margin-top:10px">قسّم</button></div>
    <div class="card"><h3>حركات اليوم</h3><div class="tbl-wrap"><table><thead><tr><th>الصنف</th><th class="n">الكمية</th><th>النوع</th><th>مين</th><th>ملاحظة</th><th></th></tr></thead><tbody>
      ${floorMoves.map(m => `<tr><td>${esc(m.item)}</td><td class="n">${qtyFmt(m.qty)} ${esc(m.unit)}</td><td>${MOVE[m.type] || m.type}</td><td>${esc(m.user || '')}</td><td class="small">${esc(m.note)}</td>
        <td>${isSup() || m.user === S.me.name ? `<button class="btn small danger" data-del="${m.id}">حذف</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">ما فيه</td></tr>'}
    </tbody></table></div></div>
    ${isSup() ? `<details class="card"><summary><b>حركات متقدمة (للمشرف)</b></summary>
      <p class="muted small">سحب يدوي من المستودع للمحل، أو تحويل صنف لصنف. العامل ما يحتاجها — يستخدم «+ أضفت» و«انرمى» من الجرد.</p>
      <div class="row"><label class="f grow">الصنف<select id="tItem">${itemOptions(daily)}</select></label>
      <label class="f">الكمية<input id="tQty" inputmode="decimal" class="qty"></label>
      <label class="f grow">ملاحظة<input id="tNote"></label>
      <button class="btn" id="tGo" style="align-self:flex-end">سحب للمحل</button></div>
      <div class="row" style="margin-top:8px"><label class="f grow">حوّل من<select id="cFrom">${itemOptions(daily)}</select></label>
      <label class="f">كمية<input id="cQf" inputmode="decimal" class="qty"></label>
      <label class="f grow">إلى<select id="cTo">${itemOptions(daily)}</select></label>
      <label class="f">كمية<input id="cQt" inputmode="decimal" class="qty" placeholder="نفسها"></label>
      <button class="btn" id="cGo" style="align-self:flex-end">تحويل</button></div></details>` : ''}`;
  const drawOuts = () => {
    $('#sOuts', main).innerHTML = outs.map((o, i) => `<div class="row" data-oi="${i}" style="margin-top:6px"><select class="grow" data-of="item_id">${itemOptions(daily, o.item_id)}</select>
      <input class="qty" data-of="qty" inputmode="decimal" placeholder="كم" value="${esc(o.qty)}"><button class="btn small danger" data-orm="${i}">×</button></div>`).join('') || '<p class="muted small">اضغط «+ صنف» واكتب وش طلع</p>';
    $$('[data-of]', main).forEach(inp => inp.oninput = inp.onchange = () => { outs[Number(inp.closest('[data-oi]').dataset.oi)][inp.dataset.of] = inp.value; });
    $$('[data-orm]', main).forEach(b => b.onclick = () => { outs.splice(Number(b.dataset.orm), 1); drawOuts(); });
  };
  drawOuts();
  $('#sSrc', main).onchange = e => { src = e.target.value; loadOuts(); drawOuts(); };
  $('#sAdd', main).onclick = () => { outs.push({ item_id: '', qty: '' }); drawOuts(); };
  $('#sGo', main).onclick = e => busy(e.currentTarget, async () => {
    const it = items.find(i => i.id === Number(src));
    const list = outs.filter(o => o.item_id && Number(o.qty) > 0);
    if (!list.length) throw new Error('اكتب كم طلع من كل صنف');
    if (!await confirmBox(`تقسيم ${$('#sQty', main).value} ${it ? it.name : ''} ← ${list.map(o => `${(items.find(i => i.id === Number(o.item_id)) || {}).name} ${o.qty}`).join('، ')}`)) return;
    await POST('/api/split', { date: day, item_id: src, qty: $('#sQty', main).value, outputs: list });
    toast('انقسمت ✓ — دخلت الجرد'); route();
  });
  if (isSup()) {
    $('#tGo', main).onclick = e => busy(e.currentTarget, async () => { await POST('/api/transfer', { date: day, item_id: $('#tItem', main).value, qty: $('#tQty', main).value, note: $('#tNote', main).value }); toast('تم ✓'); route(); });
    $('#cGo', main).onclick = e => busy(e.currentTarget, async () => { await POST('/api/convert', { date: day, from_item_id: $('#cFrom', main).value, to_item_id: $('#cTo', main).value, qty_from: $('#cQf', main).value, qty_to: $('#cQt', main).value || $('#cQf', main).value }); toast('تم ✓'); route(); });
  }
  $$('[data-del]', main).forEach(b => b.onclick = async () => { if (await confirmBox('تحذف الحركة؟')) busy(b, async () => { await DEL('/api/moves/' + b.dataset.del); route(); }); });
}

// ===================== كل البضاعة: في المحل + فوق/المستودع =====================
async function pageStock(main, alive) {
  const rows = await GET('/api/stock?date=' + S.date);
  if (!alive()) return;
  let q = '';
  const LO = { fridge: 'الباقي يطلع الثلاجة', fridge_added: 'المضاف يطلع الثلاجة', waste: 'الباقي ينرمى', stay: '' };
  const total = rows.reduce((t, r) => t + (r.value || 0), 0);
  main.innerHTML = `<div class="grid" style="margin-bottom:12px"><div class="stat"><div class="k">قيمة كل البضاعة تقريبًا</div><div class="v">${money(total)}</div></div></div>
    <div class="card no-print"><input id="kQ" placeholder="ابحث…"></div><div id="kList"></div>
    <p class="small muted">«في المحل» = آخر جرد اليوم (أو المفروض باقي إذا ما انجرد). «فوق / المستودع» = اللي في الثلاجة فوق والمستودع حسب الحركات.</p>`;
  const draw = () => {
    const list = rows.filter(r => !q || r.name.includes(q));
    $('#kList', main).innerHTML = groupBy(list, r => r.daily ? '② المحل (الجرد اليومي)' : '① المستودع').map(([g, rs]) => `<div class="card"><h3>${g}</h3><div class="tbl-wrap"><table>
      <thead><tr><th>الصنف</th>${rs[0].daily ? '<th class="n">في المحل</th><th class="n">فوق</th>' : '<th class="n">المستودع</th>'}<th class="n">المجموع</th><th class="n">القيمة</th></tr></thead><tbody>
      ${rs.map(r => `<tr><td>${esc(r.name)} <span class="muted small">${esc(r.unit)}</span>${LO[r.leftover] && r.daily ? `<div class="item-note">${LO[r.leftover]}</div>` : ''}</td>
        ${r.daily ? `<td class="n">${r.floor == null ? '—' : qtyFmt(r.floor)}${r.floor != null && !r.floor_counted ? ' <span class="muted small">تقريبًا</span>' : ''}</td><td class="n">${r.upstairs ? `<b>${qtyFmt(r.upstairs)}</b>` : '—'}</td>` : `<td class="n">${qtyFmt(r.upstairs)}</td>`}
        <td class="n">${qtyFmt(r.total)}</td><td class="n">${money(r.value)}</td></tr>`).join('')}</tbody></table></div></div>`).join('');
  };
  draw();
  $('#kQ', main).oninput = e => { q = e.target.value.trim(); draw(); };
}

// ===================== تذكرة الكاشير =====================
async function productsList(force) { if (force || !S.cache.products) S.cache.products = await GET('/api/products'); return S.cache.products; }
const pLabel = p => `${p.name}${p.variant ? ' — ' + p.variant : ''} #${p.id}`;

async function pageTickets(main, alive) {
  const [tickets, products] = await Promise.all([GET('/api/tickets?date=' + S.date), productsList()]);
  if (!alive()) return;
  const pById = new Map(products.map(p => [p.id, p]));
  const pending = [];
  main.innerHTML = `
    <div class="card no-print"><h3>صوّر ورقة الكاشير</h3>
      <p class="muted small">صوّر التذكرة كاملة من رأسها لين «المبلغ المستحق». إذا طويلة صوّرها على أجزاء، وخلّ كل صورة تاخذ شوي من آخر اللي قبلها، والنظام يشيل المكرر لحاله.
        يقرأ الأصناف بأسمائها في لويفرس، ويطابق مجموع الأسطر مع المبلغ المستحق. إذا الفرق كبير يعيد القراءة لحاله، وإذا ما ضبط تطلع بالأحمر وما تنحسب لين تراجعها.</p>
      ${S.me.has_ai ? '' : '<div class="alert amber">القراءة الآلية مو مفعّلة (حط المفتاح في الإعدادات). تقدر تدخل الأسطر يدوي.</div>'}
      ${photoInputs('tk')}
      <div class="row" style="margin-top:8px"><button class="btn primary" id="tkUp">رفع وقراءة</button><button class="btn" id="tkManual">تذكرة يدوية بدون صورة</button></div>
    </div>
    <datalist id="plist">${products.map(p => `<option value="${esc(pLabel(p))}">`).join('')}</datalist>
    <div id="tkList"></div>`;
  bindPhotos(main, 'tk', pending);
  $('#tkUp').onclick = e => busy(e.currentTarget, async () => {
    if (!pending.length) throw new Error('صوّر الورقة أول');
    await POST('/api/tickets', { date: S.date, images: pending.splice(0) });
    toast('انرفعت — جاري القراءة'); route();
  });
  $('#tkManual').onclick = e => busy(e.currentTarget, async () => { await POST('/api/tickets', { date: S.date, images: [] }); route(); });

  const list = $('#tkList');
  if (!tickets.length) list.innerHTML = '<div class="card muted">ما فيه تذاكر لهذا اليوم</div>';
  for (const t of tickets) list.appendChild(ticketCard(t, pById, products));
  // متابعة القراءة: كل 5 ثواني نشيك، ولما تخلص نعرضها (إذا فيه شي مكتوب ما انحفظ نطلع رسالة بدال ما نمسحه)
  const reading = tickets.filter(t => t.status === 'reading').map(t => t.id);
  if (reading.length) {
    const poll = async () => {
      if (!alive()) return;
      try {
        const now = await Promise.all(reading.map(id => GET('/api/tickets/' + id)));
        if (!alive()) return;
        if (now.some(t => t.status !== 'reading')) {
          if (!document.querySelector('.modal-bg') && !$('#main').dataset.dirty) return route();
          toast('خلصت قراءة التذكرة ✓ — حدّث الصفحة تشوفها');
          return;
        }
        $$('[data-since]', main).forEach(b => { b.textContent = since(b.dataset.since); });
      } catch { /* نجرب المرة الجاية */ }
      setTimeout(poll, 5000);
    };
    setTimeout(poll, 5000);
  }
}
// «من 3 دقايق» (التاريخ من السيرفر بتوقيت UTC)
function since(at) {
  const m = Math.floor((Date.now() - Date.parse(String(at).replace(' ', 'T') + 'Z')) / 60000);
  return !(m >= 1) ? '' : ` — من ${m} دقيقة`;
}

function ticketCard(t, pById, products) {
  const el = document.createElement('div');
  el.className = 'card';
  const extra = [];
  const prep = ls => ls.map(l => ({ ...l, orig_product_id: l.product_id, only_items: l.only_items ? JSON.parse(l.only_items) : [] }));
  let lines = prep(t.lines);
  const locked = t.status === 'confirmed' && !isOwner();
  // مبلغ السطر: المطبوع إذا العدد والسعر ما تغيروا، وإلا العدد × السعر
  const amt = l => { const c = (Number(l.qty) || 0) * (Number(l.price) || 0); return l.amount != null && Math.abs(l.amount - c) <= 0.05 ? Number(l.amount) : c; };
  const CHECK = { ok: ['green', '✓ المجموع مطابق للتذكرة'], items_ok: ['green', '✓ صحيحة حسب الأصناف (الاسم والسعر والحساب) — المبلغ المستحق ما انصور'], small_diff: ['amber', 'فرق بسيط في المجموع (يمكن خصم)'], mismatch: ['red', '✗ المجموع ما يطابق — ما انحسبت لين تراجعها'],
    no_total: ['amber', 'المبلغ المستحق ما انقرا — صوّر آخر التذكرة'], duplicate: ['red', '✗ التذكرة مرفوعة قبل — ما انحسبت مرتين'] };
  const MATCH = { alias: ['', 'محفوظ'], ai: ['amber', 'تأكد'], fuzzy: ['amber', 'تأكد'] };
  const draw = () => {
    const total = lines.reduce((s, l) => s + amt(l), 0);
    const ck = CHECK[t.check_status];
    el.innerHTML = `
      <div class="sec-head"><h3 style="margin:0">تذكرة #${t.id}
        ${t.status === 'reading' ? `<span class="badge amber"><span class="spin"></span> جاري القراءة<span data-since="${esc(t.created_at)}">${since(t.created_at)}</span></span>` : t.status === 'confirmed' ? '<span class="badge green">متأكدة</span>' : '<span class="badge">مسودة</span>'}</h3>
        <div class="thumbs">${t.images.map(i => `<img src="/uploads/${esc(i.path)}" data-img alt="صورة التذكرة" loading="lazy">`).join('')}</div></div>
      ${t.status === 'reading' ? '<div class="small muted">تاخذ عادة من دقيقة إلى ٥ (أكثر إذا المجموع ما طابق وانعادت القراءة). تقدر تطلع من الصفحة وترجع — ما توقف.</div>' : ''}
      ${t.ocr_error ? `<div class="alert red">${esc(t.ocr_error)}</div>` : ''}
      ${t.label || t.ocr_cost ? `<div class="small muted">${esc(t.label || '')}${t.ocr_cost ? ` · تكلفة القراءة ≈ ${(t.ocr_cost * 100).toFixed(1)} سنت` : ''}${t.read_seconds ? ` · انقرت في ${t.read_seconds < 90 ? t.read_seconds + ' ثانية' : Math.round(t.read_seconds / 60) + ' دقيقة'}` : ''}</div>` : ''}
      ${ck ? `<div class="alert ${ck[0] === 'green' ? '' : ck[0]}" style="${ck[0] === 'green' ? 'background:var(--green-soft);color:var(--green)' : ''}"><b>${ck[1]}</b>
        ${t.paper_total != null ? `<div class="small">مجموع الأسطر ${money(total)} · المبلغ المستحق المطبوع ${money(t.paper_total)}${Math.abs(total - t.paper_total) > 0.05 ? ` · الفرق ${money(total - t.paper_total)}` : ''}</div>` : ''}
        ${t.check_note ? `<div class="small" style="white-space:pre-line;margin-top:4px">${esc(t.check_note)}</div>` : ''}</div>` : ''}
      <div class="tbl-wrap"><table><thead><tr><th>المكتوب</th><th>الصنف (لويفرس)</th><th>العدد</th><th>السعر</th><th class="n">المبلغ</th><th>ملاحظة</th><th></th></tr></thead><tbody>
      ${lines.map((l, i) => {
        const p = pById.get(Number(l.product_id));
        const recipeItems = p ? p.lines : [];
        return `<tr data-i="${i}">
          <td><input data-f="raw_name" value="${esc(l.raw_name)}" ${locked ? 'disabled' : ''} style="min-width:110px"></td>
          <td><input data-f="product" list="plist" value="${p ? esc(pLabel(p)) : ''}" placeholder="اختر الصنف" ${locked ? 'disabled' : ''} style="min-width:170px;${p ? (MATCH[l.match] && MATCH[l.match][0] ? 'border-color:#f59e0b' : '') : 'border-color:var(--red)'}">
            ${p && MATCH[l.match] && l.product_id === l.orig_product_id ? `<span class="badge ${MATCH[l.match][0]}">${MATCH[l.match][1]}</span>` : ''}${l.flag ? `<div class="small pos">${esc(l.flag)}</div>` : ''}</td>
          <td><input data-f="qty" class="qty" inputmode="decimal" value="${l.qty ?? ''}" ${locked ? 'disabled' : ''}></td>
          <td><input data-f="price" class="qty" inputmode="decimal" value="${l.price || ''}" placeholder="${p ? p.price : ''}" ${locked ? 'disabled' : ''}></td>
          <td class="n">${money(amt(l) || (Number(l.qty) || 0) * (p ? p.price : 0))}</td>
          <td><input data-f="note" value="${esc(l.note)}" ${locked ? 'disabled' : ''} style="min-width:100px">
            ${recipeItems.length > 1 ? `<details><summary class="small muted">يسحب بس من…</summary><div class="chips">${recipeItems.map(ri => `<label><input type="checkbox" data-only="${ri.item_id}" ${l.only_items.includes(ri.item_id) ? 'checked' : ''} ${locked ? 'disabled' : ''}>${esc(ri.item)}</label>`).join('')}</div></details>` : ''}</td>
          <td>${locked ? '' : `<button class="btn small danger" data-rm="${i}">×</button>`}</td></tr>`;
      }).join('') || '<tr><td colspan="7" class="muted">ما فيه أسطر</td></tr>'}
      </tbody><tfoot><tr><td colspan="4">مجموع مبيعات التذكرة</td><td class="n">${money(total || lines.reduce((s, l) => s + (Number(l.qty) || 0) * (pById.get(Number(l.product_id))?.price || 0), 0))}</td><td colspan="2"></td></tr></tfoot></table></div>
      ${locked ? '' : `<div class="row" style="margin-top:8px">
        <button class="btn" data-add>+ سطر</button>
        <button class="btn primary" data-save>حفظ</button>
        ${t.status !== 'confirmed' ? '<button class="btn primary" data-confirm>تأكيد ✓</button>' : '<button class="btn" data-unconfirm>إلغاء التأكيد</button>'}
        ${photoInputs('more' + t.id)}<button class="btn small" data-more title="تنقرا كل صور التذكرة من جديد مع بعض">رفع الصور الإضافية (يعيد القراءة)</button>
        <button class="btn danger" data-del>حذف التذكرة</button></div>`}`;
    bindPhotos(el, 'more' + t.id, extra);
    $$('[data-img]', el).forEach(img => img.onclick = () => showImage(img.src));
    $$('tr[data-i] input', el).forEach(inp => inp.addEventListener('change', () => {
      const i = Number(inp.closest('tr').dataset.i), l = lines[i];
      el.closest('main') && (el.closest('main').dataset.dirty = '1');
      if (inp.dataset.only) {
        const id = Number(inp.dataset.only);
        l.only_items = inp.checked ? [...new Set([...l.only_items, id])] : l.only_items.filter(x => x !== id);
        return;
      }
      const f = inp.dataset.f;
      if (f === 'product') {
        const m = /#(\d+)\s*$/.exec(inp.value);
        if (m) l.product_id = Number(m[1]);
        else { const hit = products.find(p => pLabel(p).startsWith(inp.value.trim())); l.product_id = hit ? hit.id : null; }
        draw();
      } else { l[f] = inp.value; if (f === 'qty' || f === 'price') draw(); }
    }));
    $$('[data-rm]', el).forEach(b => b.onclick = () => { lines.splice(Number(b.dataset.rm), 1); draw(); });
    const add = $('[data-add]', el); if (add) add.onclick = () => { lines.push({ raw_name: '', product_id: null, qty: 1, price: '', note: '', only_items: [] }); draw(); };
    const save = async () => {
      const r = await PUT(`/api/tickets/${t.id}/lines`, { lines: lines.map(l => ({ ...l, price: l.price === '' ? 0 : l.price })) });
      lines = prep(r.lines);
      Object.assign(t, { check_status: r.check_status, check_note: r.check_note, paper_total: r.paper_total });
      const main = el.closest('main'); if (main) delete main.dataset.dirty;
    };
    const sv = $('[data-save]', el); if (sv) sv.onclick = e => busy(e.currentTarget, async () => { await save(); toast('انحفظت ✓'); draw(); });
    const cf = $('[data-confirm]', el); if (cf) cf.onclick = e => busy(e.currentTarget, async () => {
      await save();
      try { await POST(`/api/tickets/${t.id}/confirm`, {}); }
      catch (err) {
        if (!err.data || !err.data.needForce) throw err;
        if (!await confirmBox(`${err.message}\n\nمتأكد إن الأسطر صحيحة وتبي تحسبها؟`)) return;
        await POST(`/api/tickets/${t.id}/confirm`, { force: true });
      }
      toast('تأكدت ✓'); route();
    });
    const uc = $('[data-unconfirm]', el); if (uc) uc.onclick = e => busy(e.currentTarget, async () => { await POST(`/api/tickets/${t.id}/confirm`, { undo: true }); route(); });
    const mo = $('[data-more]', el); if (mo) mo.onclick = e => busy(e.currentTarget, async () => { if (!extra.length) throw new Error('اختر الصور أول'); await save(); await POST(`/api/tickets/${t.id}/images`, { images: extra.splice(0) }); route(); });
    const dl = $('[data-del]', el); if (dl) dl.onclick = async () => { if (await confirmBox('تحذف التذكرة كلها؟')) busy(dl, async () => { await DEL('/api/tickets/' + t.id); route(); }); };
  };
  draw();
  return el;
}

// ===================== المبيعات =====================
async function pageSales(main, alive) {
  const rows = await GET('/api/sales?date=' + S.date);
  if (!alive()) return;
  const sum = k => rows.reduce((s, r) => s + (r[k] || 0), 0);
  main.innerHTML = `
    <div class="row no-print" style="margin-bottom:10px"><button class="btn" id="sync">سحب من لويفرس الحين</button><span class="muted small">يسحب لحاله كل ١٠ دقايق</span></div>
    <div class="card"><div class="tbl-wrap"><table><thead><tr><th>الصنف</th><th class="n">لويفرس</th><th class="n">التذكرة</th><th class="n">المجموع</th><th class="n">المبلغ الفعلي</th><th class="n">المتوقع (سعر القائمة)</th><th class="n">تكلفة الوجبة</th><th class="n">التكلفة</th><th class="n">الربح</th><th>الوصفة</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td class="item-name">${esc(r.name)}${r.variant ? ` <span class="muted">${esc(r.variant)}</span>` : ''}</td>
      <td class="n">${qtyFmt(r.loyverse_qty)}</td><td class="n">${qtyFmt(r.ticket_qty)}</td><td class="n"><b>${qtyFmt(r.qty)}</b></td>
      <td class="n">${money(r.amount)}</td><td class="n">${money(r.list_amount)}</td><td class="n">${money(r.unit_cost)}</td><td class="n">${money(r.cost)}</td><td class="n">${money(r.profit)}</td>
      <td>${r.recipe_status === 'ok' ? '<span class="badge green">جاهزة</span>' : r.recipe_status === 'draft' ? '<span class="badge amber">مبدئية</span>' : r.recipe_status === 'skip' ? '<span class="badge">ما ينجرد</span>' : '<span class="badge red">ما فيه</span>'}</td></tr>`).join('') || '<tr><td colspan="10" class="muted">ما فيه مبيعات</td></tr>'}
    </tbody><tfoot><tr><td>المجموع</td><td class="n">${qtyFmt(sum('loyverse_qty'))}</td><td class="n">${qtyFmt(sum('ticket_qty'))}</td><td class="n">${qtyFmt(sum('qty'))}</td><td class="n">${money(sum('amount'))}</td><td class="n">${money(sum('list_amount'))}</td><td></td><td class="n">${money(sum('cost'))}</td><td class="n">${money(sum('profit'))}</td><td></td></tr></tfoot></table></div></div>`;
  $('#sync').onclick = e => busy(e.currentTarget, async () => { const r = await POST('/api/sync', {}); toast(r.message || 'تم', r.ok === false); route(); });
}

// ===================== تقرير اليوم =====================
async function pageReport(main, alive) {
  const r = await GET('/api/report?date=' + S.date);
  if (!alive()) return;
  const m = r.money;
  const bySec = groupBy(r.board.rows, x => x.section);
  main.innerHTML = `
    <div class="row no-print" style="margin-bottom:10px">
      ${r.closed ? `<span class="badge green">اليوم مقفل — ${esc(r.closed.by_name || '')}</span>${isOwner() ? '<button class="btn" id="reopen">فتح اليوم</button>' : ''}` : '<button class="btn primary" id="closeDay">✓ إقفال اليوم</button>'}
      <button class="btn" onclick="print()">طباعة</button>${isOwner() ? '<button class="btn" id="dayPdf">📄 تقرير اليوم PDF</button>' : ''}</div>
    <div class="card"><h3>التنبيهات</h3>${alertsHtml(r.alerts)}</div>
    ${m.sheet ? `<div class="card"><h3>📄 حساب اليوم من الورقة</h3><div class="grid">
      <div class="stat"><div class="k">💳 الشبكة (كمبيوتر)</div><div class="v">${money(m.sheet.card)}</div></div>
      <div class="stat"><div class="k">💵 الكاش</div><div class="v">${money(m.sheet.cash)}</div></div>
      <div class="stat"><div class="k">💸 الخرج</div><div class="v">${money(m.sheet.spent)}</div></div>
      <div class="stat"><div class="k">المجموع</div><div class="v">${money(m.sheet.total)}</div></div>
      <div class="stat"><div class="k">المبيعات في النظام</div><div class="v">${money(m.total_sales)}</div></div>
      ${m.named_total ? `<div class="stat"><div class="k">👤 على الحساب</div><div class="v">− ${money(m.named_total)}</div></div><div class="stat"><div class="k">المفروض يوصل</div><div class="v">${money(m.expected_in)}</div></div>` : ''}
      <div class="stat ${m.sheet.shortage > 0.01 ? 'red' : 'green'}"><div class="k">${m.sheet.shortage > 0.01 ? 'نقص' : m.sheet.shortage < -0.01 ? 'زيادة' : 'مطابق'}</div><div class="v">${money(Math.abs(m.sheet.shortage))}</div></div></div>
      <p class="small muted">المجموع = الشبكة + الكاش + الخرج (زي ما مكتوب في الورقة). الفرق = المبيعات في النظام (${m.from_printer ? 'أوراق الطابعة' : 'لويفرس + التذكرة'})${m.named_total ? ' − على الحساب' : ''} − المجموع.</p></div>` : ''}
    <div class="card"><h3>الفلوس</h3><div class="grid">
      ${m.from_printer ? `<div class="stat"><div class="k">مبيعات أوراق الطابعة 🖨️</div><div class="v">${money(m.printer_total)}</div></div>` : `<div class="stat"><div class="k">مبيعات لويفرس</div><div class="v">${money(m.loyverse_total)}</div></div>
      <div class="stat"><div class="k">مبيعات التذكرة</div><div class="v">${money(m.ticket_total)}</div></div>`}
      <div class="stat"><div class="k">مجموع المبيعات</div><div class="v">${money(m.total_sales)}</div></div>
      <div class="stat"><div class="k">المتوقع بسعر البيع</div><div class="v">${money(m.list_total)}</div></div>
      <div class="stat"><div class="k">خصومات/فرق سعر</div><div class="v">${money(m.discounts)}</div></div>
      <div class="stat"><div class="k">كاش لويفرس</div><div class="v">${money(m.cash_payments)}</div></div>
      <div class="stat"><div class="k">شبكة/غيره</div><div class="v">${money(m.card_payments)}</div></div>
      <div class="stat"><div class="k">مصروف من الدرج</div><div class="v">${money(m.cash_expenses)}</div></div>
      ${m.sheet ? '' : `<div class="stat"><div class="k">الكاش المفروض</div><div class="v">${money(m.expected_cash)}</div></div>`}
      <div class="stat ${m.cash_shortage > 0 ? 'red' : m.cash_shortage != null ? 'green' : ''}"><div class="k">${m.sheet ? 'النقص (المبيعات − الورقة)' : 'نقص الكاش'}</div><div class="v">${m.cash_shortage == null ? 'ما انجرد' : money(m.cash_shortage)}</div></div>
      <div class="stat ${m.card_shortage > 0 ? 'red' : ''}"><div class="k">نقص الشبكة</div><div class="v">${m.card_shortage == null ? '—' : money(m.card_shortage)}</div></div>
      <div class="stat"><div class="k">تكلفة الوجبات (من الوصفات)</div><div class="v">${money(m.cogs)}</div></div>
      <div class="stat green"><div class="k">الربح الإجمالي</div><div class="v">${money(m.gross_profit)}</div></div>
      <div class="stat ${m.inventory_shortage_value > 0 ? 'red' : ''}"><div class="k">نقص البضاعة (ريال)</div><div class="v">${money(m.inventory_shortage_value)}</div></div>
      <div class="stat"><div class="k">هالك آخر اليوم</div><div class="v">${money(m.waste_value)}</div></div>
      <div class="stat"><div class="k">المشتريات (منها آجل ${money(m.purchases_credit)})</div><div class="v">${money(m.purchases_total)}</div></div>
      <div class="stat"><div class="k">سداد موردين من الدرج</div><div class="v">${money(m.supplier_payments_cash)}</div></div>
      <div class="stat ${m.suppliers_owed > 0 ? 'red' : ''}"><div class="k">علينا للموردين (الكل)</div><div class="v">${money(m.suppliers_owed)}</div></div>
      <div class="stat"><div class="k">المصروفات</div><div class="v">${money(m.expenses_total)}</div></div>
    </div>
    ${m.payments.length ? `<p class="small muted">طرق الدفع: ${m.payments.map(p => `${esc(p.name)} ${money(p.amount)}`).join(' · ')}</p>` : ''}
    <div class="row no-print" style="margin-top:10px">
      <label class="f">الكاش اللي بالدرج<input id="cash" inputmode="decimal" value="${m.counted_cash ?? ''}"></label>
      <label class="f">الشبكة<input id="card" inputmode="decimal" value="${m.counted_card ?? ''}"></label>
      <button class="btn primary" id="saveCash" style="align-self:flex-end">حفظ جرد الفلوس</button>${sheetBtn()}</div></div>
    <div class="card"><h3>النقص حسب الموظف</h3><div class="tbl-wrap"><table><thead><tr><th>الموظف (آخر اليوم)</th><th class="n">أصناف</th><th class="n">نقص (ريال)</th></tr></thead><tbody>
      ${r.by_person.map(p => `<tr><td>${esc(p.person)}</td><td class="n">${p.items}</td><td class="n ${p.shortage_value > 0 ? 'pos' : ''}">${money(p.shortage_value)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">الجرد ما اكتمل</td></tr>'}
    </tbody></table></div></div>
    <div class="row no-print" style="margin-bottom:8px"><a class="btn" href="#/usage">انصرف حسب الوصفات — التفصيل ←</a></div>
    ${bySec.map(([sec, rows]) => `<div class="card"><h3>${esc(sec)}</h3><div class="tbl-wrap"><table><thead><tr><th>الصنف</th><th class="n">أول اليوم</th><th class="n">انسحب</th><th class="n">انباع حسب الوصفة</th><th class="n">المفروض باقي</th><th class="n">آخر اليوم</th><th class="n">الفرق</th><th class="n">ريال</th></tr></thead><tbody>
      ${rows.map(x => `<tr><td>${esc(x.name)} <span class="muted small">${esc(x.unit)}</span></td><td class="n">${qtyFmt(x.opening)}</td><td class="n">${qtyFmt(x.received)}</td><td class="n">${qtyFmt(x.theoretical)}</td><td class="n">${qtyFmt(x.remaining_expected)}</td><td class="n">${qtyFmt(x.closing)}</td>
        <td class="n ${x.diff > 0 ? 'pos' : x.diff < 0 ? 'neg' : ''}">${x.diff == null ? '—' : qtyFmt(x.diff)}</td><td class="n">${x.diff_value == null ? '—' : money(x.diff_value)}</td></tr>`).join('')}
    </tbody></table></div></div>`).join('')}
    <p class="small muted">الفرق الموجب = نقص (انصرف أكثر من المباع حسب الوصفة). قيمة النقص بسعر البيع المحدد للصنف، وإذا ما فيه فبسعر الشراء.</p>`;
  { const dp = $('#dayPdf', main); if (dp) dp.onclick = e => busy(e.currentTarget, () => download('/api/day-report.pdf?date=' + S.date, `تقرير-السلام-${S.date}.pdf`)); }
  bindSheet(main);
  $('#saveCash').onclick = e => busy(e.currentTarget, async () => { await POST('/api/cash', { date: S.date, cash: $('#cash').value, card: $('#card').value }); toast('انحفظ ✓'); route(); });
  const cd = $('#closeDay'); if (cd) cd.onclick = async () => { if (await confirmBox('تقفل اليوم؟ التذاكر بتتأكد وما يقدر أحد يعدل إلا المالك.')) busy(cd, async () => { await POST('/api/day/close', { date: S.date }); toast('انقفل ✓'); route(); }); };
  const ro = $('#reopen'); if (ro) ro.onclick = () => busy(ro, async () => { await POST('/api/day/close', { date: S.date, undo: true }); route(); });
}

// ===================== انصرف حسب الوصفات =====================
async function pageUsage(main, alive) {
  const r = await GET('/api/recipe-usage?date=' + S.date);
  if (!alive()) return;
  let q = '', place = sessionStorage.getItem('usagePlace') || 'all';
  main.innerHTML = `
    ${r.no_recipe.length ? `<div class="alert amber">أطباق انباعت بدون وصفة (ما انخصم لها شي): ${r.no_recipe.slice(0, 15).map(x => `${esc(x.name)} ×${qtyFmt(x.sold)}`).join('، ')}${r.no_recipe.length > 15 ? '…' : ''}${S.me.can_recipes ? ' — <a href="#/link">اربطها</a>' : ''}</div>` : ''}
    ${r.no_cost.length ? `<div class="alert small">ما لها سعر شراء (قيمتها صفر): ${r.no_cost.slice(0, 15).map(esc).join('، ')}${r.no_cost.length > 15 ? '…' : ''}</div>` : ''}
    <div class="card no-print"><div class="row"><input id="uQ" placeholder="ابحث عن صنف…" class="grow">
      <div class="tabs" style="margin:0">${[['all', 'الكل'], ['floor', 'الجرد'], ['warehouse', 'المستودع']].map(([k, v]) => `<button data-pl="${k}" class="${k === place ? 'on' : ''}">${v}</button>`).join('')}</div></div>
      <p class="small muted" style="margin:6px 0 0">${r.rows.length} صنف انخصم منه حسب الأطباق اللي انباعت يوم ${r.date}. اضغط الصنف تشوف الأطباق.</p></div>
    <div id="uList"></div>`;
  const draw = () => {
    const rows = r.rows.filter(x => (place === 'all' || x.place === place) && (!q || x.name.includes(q) || x.from.some(f => f.product.includes(q))));
    $('#uList', main).innerHTML = rows.map(x => {
      const c = x.count;
      const cnt = !c ? '' : c.actual == null ? `<span class="small muted"> · الجرد ما اكتمل</span>`
        : ` · انصرف فعلًا <b>${qtyFmt(c.actual)}</b>${c.diff ? ` · <span class="${c.diff > 0 ? 'pos' : 'neg'}">${c.diff > 0 ? 'نقص' : 'زيادة'} ${qtyFmt(Math.abs(c.diff))}${c.diff_value ? ` (${money(Math.abs(c.diff_value))} ريال)` : ''}</span>` : ' · <span style="color:var(--green)">مضبوط ✓</span>'}`;
      return `<details class="card" style="padding:10px 12px;margin-bottom:8px"><summary style="cursor:pointer">
        <b>${esc(x.name)}</b> <span class="badge ${x.place === 'floor' ? 'brand' : ''}">${x.place === 'floor' ? 'الجرد' : 'المستودع'}</span>
        <div class="small">انخصم حسب الوصفات <b>${qtyFmt(x.total)} ${esc(x.unit)}</b>${x.value ? ` (${money(x.value)} ريال)` : ''}${cnt}</div></summary>
        <div class="tbl-wrap" style="margin-top:8px"><table><thead><tr><th>الطبق</th><th class="n">انباع</th><th class="n">لكل واحد</th><th class="n">انخصم</th></tr></thead><tbody>
        ${x.from.map(f => `<tr><td>${esc(f.product)}${f.ticket ? ` <span class="badge">تذكرة ${qtyFmt(f.ticket)}</span>` : ''}</td><td class="n">${qtyFmt(f.sold)}</td><td class="n">${qtyFmt(f.per_one)}</td><td class="n"><b>${qtyFmt(f.qty)}</b></td></tr>`).join('')}
        </tbody></table></div>
        ${c && c.actual != null ? `<div class="small muted" style="margin-top:6px">الجرد: أول اليوم ${qtyFmt(c.opening)} + الوارد ${qtyFmt(c.received)}${c.wasted ? ` − انرمى ${qtyFmt(c.wasted)}` : ''} − آخر اليوم ${qtyFmt(c.closing)} = انصرف ${qtyFmt(c.actual)} · المقفل ${esc(c.closer || '—')}</div>` : ''}
        ${S.me.can_recipes ? '<div class="small" style="margin-top:6px">الرقم غريب؟ الغالب الوصفة — عدّلها من <a href="#/recipes">أصناف البيع</a></div>' : ''}</details>`;
    }).join('') || '<div class="card muted">ما فيه شي انخصم حسب الوصفات لهذا اليوم</div>';
  };
  draw();
  $('#uQ', main).oninput = e => { q = e.target.value.trim(); draw(); };
  $$('[data-pl]', main).forEach(b => b.onclick = () => { place = b.dataset.pl; sessionStorage.setItem('usagePlace', place); $$('[data-pl]', main).forEach(x => x.classList.toggle('on', x === b)); draw(); });
}

// ===================== المستودع =====================
async function pageWarehouse(main, alive) {
  const [rows, moves, items] = await Promise.all([GET('/api/warehouse'), GET('/api/moves?types=purchase,transfer,prep_use,adjust,sale_use,opening_pull'), itemsList(true)]);
  if (!alive()) return;
  const itemOf = new Map(items.map(i => [i.id, i]));
  const total = rows.reduce((s, r) => s + r.value, 0);
  main.innerHTML = `
    <div class="card"><div class="sec-head"><h3 style="margin:0">رصيد المستودع</h3><span class="badge brand">القيمة ${money(total)} ريال</span></div>
      <p class="muted small">المشتريات تدخل هنا، والسحب للمحضّر والوصفات اللي تسحب من المستودع تطلع منه. للجرد: اكتب الموجود فعليًا واضغط حفظ.</p>
      <div class="tbl-wrap"><table><thead><tr><th>الصنف</th><th>القسم</th><th class="n">الرصيد</th><th class="n">سعر الشراء</th><th class="n">القيمة</th><th>الموجود فعليًا</th><th>آخر جرد</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td class="item-name">${esc(r.name)} <span class="muted small">${esc(r.unit)}</span></td><td class="small">${esc(r.section)}</td>
        <td class="n ${r.balance < 0 ? 'pos' : ''}">${unitsFmt(r.balance, itemOf.get(r.id) || { unit: r.unit })}</td><td class="n">${money(r.cost)}</td><td class="n">${money(r.value)}</td>
        <td><input class="qty" inputmode="decimal" data-wc="${r.id}"></td><td class="small muted">${r.last_count || '—'}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="row" style="margin-top:8px"><button class="btn primary" id="wcSave">حفظ جرد المستودع</button></div><div id="wcRes"></div></div>
    <div class="card"><details><summary><b>آخر الحركات</b></summary><div class="tbl-wrap"><table><thead><tr><th>التاريخ</th><th>الصنف</th><th class="n">الكمية</th><th>النوع</th><th>مين</th><th>ملاحظة</th></tr></thead><tbody>
      ${moves.filter(m => m.location === 'warehouse').slice(0, 200).map(m => `<tr><td class="small">${m.date}</td><td>${esc(m.item)}</td><td class="n ${m.qty < 0 ? 'pos' : 'neg'}">${qtyFmt(m.qty)}</td><td class="small">${MOVE[m.type] || m.type}</td><td class="small">${esc(m.user || '')}</td><td class="small">${esc(m.note)}</td></tr>`).join('')}
    </tbody></table></div></details></div>`;
  $('#wcSave').onclick = e => busy(e.currentTarget, async () => {
    const counts = $$('[data-wc]', main).filter(i => i.value.trim() !== '').map(i => ({ item_id: i.dataset.wc, qty: i.value }));
    if (!counts.length) throw new Error('اكتب الموجود لصنف واحد على الأقل');
    const res = await POST('/api/warehouse/count', { date: S.date, counts });
    $('#wcRes').innerHTML = `<div class="tbl-wrap" style="margin-top:10px"><table><thead><tr><th>الصنف</th><th class="n">المفروض</th><th class="n">الموجود</th><th class="n">الفرق</th><th class="n">ريال</th></tr></thead><tbody>
      ${res.map(x => `<tr><td>${esc(x.name)}</td><td class="n">${qtyFmt(x.expected)}</td><td class="n">${qtyFmt(x.counted)}</td><td class="n ${x.diff < 0 ? 'pos' : x.diff > 0 ? 'neg' : ''}">${qtyFmt(x.diff)}</td><td class="n">${money(x.value)}</td></tr>`).join('')}</tbody></table></div>`;
    toast('انحفظ الجرد ✓');
  });
}
// 77 علبة => «3 كرتون + 5 علبة» (بأكبر وحدة شراء ثابتة)
function unitsFmt(qty, it) {
  const u = it && it.units && it.units[0];
  if (!u || u.factor <= 1 || Math.abs(qty) < u.factor) return `${qtyFmt(qty)} ${esc(it ? it.unit : '')}`;
  const big = Math.trunc(qty / u.factor), rest = Math.round((qty - big * u.factor) * 1000) / 1000;
  return `${big} ${esc(u.name)}${rest ? ` + ${qtyFmt(rest)} ${esc(it.unit)}` : ''}`;
}
const MOVE = { add: 'أضاف', split: 'تقسيم', fridge_in: 'طلع الثلاجة آخر اليوم', fridge_out: 'نزل من الثلاجة أول اليوم', waste: 'انرمى', purchase: 'شراء', transfer: 'سحب للمحضّر', prep_use: 'تحضير', sale_use: 'حسب الوصفات', adjust: 'جرد', convert: 'تحويل', opening_pull: 'سحب من الثلاجة أول اليوم' };

// ===================== المشتريات =====================
// وحدة الشراء لكل صنف: «الدقيق يشتريه بالكيس — الكيس فيه ٤٥ كجم». الشراء يكون بالكبير وينقسم لوحدة الجرد لحاله
const BUY_NAMES = ['كرتون', 'كيس', 'باكت', 'دبة', 'ربطة', 'صندوق', 'شدة', 'جالون'];
const unitLabel = (it, name) => { const x = (it.units || []).find(y => y.name === name); return x ? `${name} (${qtyFmt(x.factor)} ${it.unit})` : (name || it.unit); };
async function setBuyUnit(it, { name, factor, plain }) {
  if (plain) return PUT(`/api/items/${it.id}/units`, { units: it.units || [], buy_unit: it.unit });
  name = String(name || '').trim(); factor = numIn(factor);
  if (!name) throw new Error('اكتب الوحدة: كرتون، كيس…');
  if (!(factor > 0)) throw new Error(`كم ${it.unit} في ال${name}؟`);
  const units = (it.units || []).filter(y => y.name !== name).concat([{ name, factor }]);
  return PUT(`/api/items/${it.id}/units`, { units, buy_unit: name });
}
// نافذة صغيرة: «تشتريه بإيش؟» (أول مرة ينشرى صنف ما له وحدة)
function askBuyUnit(it) {
  return new Promise(resolve => modal(`📦 ${esc(it.name)} — تشتريه بإيش؟`, `<p class="small muted">مرة وحدة بس — بعدها تختار العدد والنظام يحسب ${esc(it.unit)} لحاله.</p>
    <div class="row" style="gap:6px;flex-wrap:wrap">${BUY_NAMES.map(n => `<button class="qb-chip" data-bn="${n}">${n}</button>`).join('')}<button class="qb-chip" data-bn="__plain">بال${esc(it.unit)} (بدون تعبئة)</button></div>
    <div id="buF" hidden style="margin-top:10px"><label class="f"><span id="buQ"></span><input id="buN" inputmode="decimal" style="font-size:22px;text-align:center"></label></div>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="buOk" hidden>حفظ</button><button class="btn" data-close>بعدين</button></div>`, (m, close) => {
    let name = '';
    $$('[data-bn]', m).forEach(b => b.onclick = () => busy(b, async () => {
      if (b.dataset.bn === '__plain') { await setBuyUnit(it, { plain: true }); it.buy_unit = it.unit; close(); return resolve(it.unit); }
      name = b.dataset.bn; $$('[data-bn]', m).forEach(x => x.classList.toggle('on', x === b));
      $('#buF', m).hidden = false; $('#buOk', m).hidden = false; $('#buQ', m).textContent = `ال${name} فيه كم ${it.unit}؟`; $('#buN', m).focus();
    }));
    $('#buOk', m).onclick = e => busy(e.currentTarget, async () => {
      const f = numIn($('#buN', m).value);
      await setBuyUnit(it, { name, factor: f });
      it.units = (it.units || []).filter(y => y.name !== name).concat([{ name, factor: f }]); it.buy_unit = name;
      close(); resolve(name);
    });
  }));
}
async function pageBuyUnits(main, alive) {
  const items = (await GET('/api/items')).filter(i => i.kind === 'raw');
  if (!alive()) return;
  const left = items.filter(i => !i.buy_unit);
  items.sort((a, b) => (!!a.buy_unit - !!b.buy_unit) || a.daily - b.daily);
  main.innerHTML = `<div class="card"><h3>📦 وحدات الشراء</h3>
    <p class="small muted">كل صنف ينشرى بالكبير (كرتون، كيس، باكت…) والنظام يقسمه لوحدة الجرد لحاله. مثال: الدقيق بالكيس — الكيس ٤٥ كجم ⇒ «٢ كيس» = ٩٠ كجم.<br>اللي ينشرى بالوزن (السمك، اللحم) اختر «بدون تعبئة».</p>
    ${left.length ? `<div class="alert amber small">باقي ${left.length} صنف ما له وحدة شراء</div>` : '<div class="alert green small">كل الأصناف لها وحدة شراء ✓</div>'}
    <datalist id="buNames">${BUY_NAMES.map(n => `<option value="${n}">`).join('')}</datalist>
    ${items.map(i => { const plain = i.buy_unit && i.buy_unit === i.unit; const cur = (i.units || []).find(y => y.name === i.buy_unit);
      return `<div data-bu="${i.id}" style="border:1px solid var(--line);border-radius:12px;padding:10px;margin-top:8px">
        <div class="row" style="justify-content:space-between;align-items:center"><b>${esc(i.name)}</b><span class="small ${i.buy_unit ? 'muted' : 'pos'}">${i.buy_unit ? (plain ? 'بدون تعبئة' : `${esc(i.buy_unit)} = ${qtyFmt(cur ? cur.factor : 0)} ${esc(i.unit)}`) : 'ما تحدد'}</span></div>
        <div class="row" style="gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap">
          <input data-k="name" list="buNames" value="${esc(plain ? '' : i.buy_unit)}" placeholder="كرتون، كيس…" style="width:100px">
          <span class="small">فيه</span><input data-k="factor" inputmode="decimal" value="${cur ? cur.factor : ''}" style="width:64px"><span class="small muted">${esc(i.unit)}</span>
          <button class="btn small primary" data-save>حفظ</button><button class="btn small ${plain ? 'primary' : ''}" data-plain>بدون تعبئة</button></div></div>`; }).join('')}
  </div>`;
  $$('[data-bu]', main).forEach(tr => {
    const it = items.find(i => i.id === Number(tr.dataset.bu));
    $('[data-save]', tr).onclick = e => busy(e.currentTarget, async () => { await setBuyUnit(it, { name: $('[data-k=name]', tr).value, factor: $('[data-k=factor]', tr).value }); S.cache.items = null; toast(`✓ ${it.name}`); route(); });
    $('[data-plain]', tr).onclick = e => busy(e.currentTarget, async () => { await setBuyUnit(it, { plain: true }); S.cache.items = null; toast(`✓ ${it.name} بدون تعبئة`); route(); });
  });
}

// «📄 ورقة المصاريف»: صورة الورقة المكتوبة باليد => الذكاء يفرز كل سطر (شراء / مصروف / سداد مورد) => تراجع وتسجّل الكل
// يدخلها المشرفين والمالك بس (فيها دخل اليوم: الكاش والشبكة)
const canSheet = () => S.me.has_ai && S.me.can_sales;
const sheetBtn = () => canSheet() ? `<label class="btn" style="cursor:pointer;align-self:flex-end"><input type="file" accept="image/*" capture="environment" multiple hidden data-sheet>📷 صوّر الورقة اليومية</label><label class="btn" style="cursor:pointer;align-self:flex-end"><input type="file" accept="image/*" multiple hidden data-sheet>🖼️ ارفع الورقة من الجهاز</label>` : '';
function bindSheet(root) {
  $$('[data-sheet]', root).forEach(inp => inp.onchange = () => busy(null, async () => {
    const imgs = await readImages(inp); inp.value = ''; if (!imgs.length) return;
    toast('📄 أقرأ الورقة… لحظة (الخط باليد ياخذ وقت)');
    const [r, items, sups] = await Promise.all([api('POST', '/api/sheet/read', { images: imgs, date: S.date }, 240000), itemsList(true), suppliersList()]);
    sheetReview(r, imgs, items.filter(i => i.kind === 'raw'), sups);
  }));
}
function sheetReview(r, imgs, items, sups) {
  const lines = r.lines;
  lines.forEach(l => { if (l.dup) l.skip = true; l._newName = l.new_supplier ? l.supplier : ''; }); // مسجّل من قبل (المشتري سجله «من الدرج») => ما نسجله مرة ثانية
  const byPurch = (r.drawn || []).filter(d => d.purch), drawnSum = byPurch.reduce((t, d) => t + d.amount, 0); // اللي سجله المشتري بنفسه «من الدرج»
  const payment = 'cash'; // الورقة = اللي طلع من درج المحل (عهدة زكريا يسجلها هو من صفحته)
  const KIND = [['purchase', '🛒 شراء'], ['expense', '💸 مصروف'], ['supplier', '📒 سداد مورد'], ['taken', '👤 أخذها المشتري']];
  const ex = r.existing;
  modal('📄 الورقة اليومية — راجعها', `<div class="card" style="margin:0 0 8px;padding:10px"><b>💰 حساب اليوم من الورقة</b> <span class="small muted">(هذي الأرقام المعتمدة)</span>
      <div class="row" style="gap:6px;margin-top:6px;flex-wrap:wrap"><label class="f grow">💳 الشبكة (كمبيوتر)<input class="qty" id="shCard" inputmode="decimal" value="${r.card ?? ''}" placeholder="مو مكتوب"></label>
      <label class="f grow">💵 الكاش<input class="qty" id="shCash" inputmode="decimal" value="${r.cash ?? ''}" placeholder="مو مكتوب"></label>
      <label class="f grow">💸 الخرج<input class="qty" id="shSpent" inputmode="decimal" value="${r.spent ?? ''}" placeholder="مو مكتوب"></label></div>
      <div class="small" id="shSum" style="margin-top:4px"></div>
      ${ex ? `<p class="small" style="color:#b45309;margin:4px 0 0">فيه جرد كاش لهذا اليوم (كاش ${money(ex.cash)} · شبكة ${money(ex.card)}) — بنستبدله</p>` : ''}</div>
    <p class="small muted">قرأت ${lines.length} سطر مصاريف. شيك النوع والمبلغ — الأصفر مو متأكد منه. تقدر تبدّل النوع أو تحذف السطر.</p>
    <p class="small" style="margin:0">كل المصاريف هنا تتسجل <b>💵 من الدرج</b>. اللي أخذه المشتري من الدرج ما يتسجل هنا — هو يسجل وش اشترى فيه.</p>
    <div id="shTaken"></div>
    <label class="f" style="margin-top:6px">تاريخ الورقة<input type="date" id="shDate" value="${r.date || S.date}"></label>
    <div id="shRows" style="margin-top:8px"></div>
    <div class="qb-total" id="shTot"></div>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="shOk">✓ سجّل الكل</button><button class="btn" data-close>إلغاء</button></div>`, (m, close) => {
    const draw = () => {
      $('#shRows', m).innerHTML = lines.map((l, i) => `<div data-sh="${i}" style="border:1px solid var(--line);border-radius:10px;padding:8px;margin-top:6px;${l.skip ? 'opacity:.55;' : ''}${l.uncertain ? 'background:#fff7e6' : ''}">
        <div class="row" style="justify-content:space-between;align-items:center"><span class="small">«${esc(l.text)}»</span><button class="btn small danger" data-shx="${i}">✕</button></div>
        ${l.dup ? `<div class="small" style="margin-top:4px">✓ مسجّل من قبل: ${esc(l.dup)} — <button class="btn small" data-shs>${l.skip ? 'لا، سجّله برضو' : 'لا تسجله (مكرر)'}</button></div>` : ''}
        <div class="row" style="gap:4px;margin-top:4px;flex-wrap:wrap">${KIND.map(([k, v]) => `<button class="btn small ${l.kind === k ? 'primary' : ''}" data-shk="${k}">${v}</button>`).join('')}</div>
        <div class="row" style="gap:6px;margin-top:6px;align-items:center;flex-wrap:wrap">
          ${l.kind === 'taken' ? '<span class="small muted" style="flex:1">ما يتسجل — المشتري يسجل وش اشترى فيها</span>'
            : l.kind === 'purchase' ? `<select data-shf="item_id" style="min-width:120px;flex:1">${itemOptions(items, l.item_id)}</select><input class="qty" data-shf="qty" inputmode="decimal" value="${esc(l.qty ?? '')}" placeholder="العدد" style="width:60px">`
            : l.kind === 'supplier' ? `<select data-shf="supplier_id" style="flex:1 1 100%;min-width:160px"><option value="">اختر المورد</option>${l._newName ? `<option value="new" ${l.new_supplier ? 'selected' : ''}>+ مورد جديد: ${esc(l._newName)}</option>` : ''}${sups.map(x => `<option value="${x.id}" ${x.id === l.supplier_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`
            : `<input data-shf="category" value="${esc(l.category)}" placeholder="البند: غاز، نقل…" style="flex:1">`}
          <input class="qty" data-shf="amount" inputmode="decimal" value="${esc(l.amount ?? '')}" placeholder="المبلغ" style="width:80px">
          <input type="date" data-shf="date" value="${l.date || ''}" style="width:auto" title="تاريخ السطر (فاضي = التاريخ فوق)"></div></div>`).join('') || '<p class="muted">ما فيه أسطر</p>';
      $$('[data-sh]', m).forEach(row => {
        const l = lines[Number(row.dataset.sh)];
        $$('[data-shk]', row).forEach(b => b.onclick = () => { l.kind = b.dataset.shk; draw(); });
        const sk = $('[data-shs]', row); if (sk) sk.onclick = () => { l.skip = !l.skip; draw(); };
        $$('[data-shf]', row).forEach(inp => inp.onchange = () => { const k = inp.dataset.shf; if (k === 'supplier_id') l.new_supplier = inp.value === 'new'; l[k] = ['item_id', 'supplier_id'].includes(k) ? Number(inp.value) || null : k === 'qty' || k === 'amount' ? numIn(inp.value) || null : inp.value; tot(); });
        $('[data-shx]', row).onclick = () => { lines.splice(Number(row.dataset.sh), 1); draw(); };
      });
      tot();
    };
    const tot = () => {
      // الخرج المكتوب مقابل مجموع الأسطر (للعلم — المعتمد اللي في الورقة)
      const linesSum = lines.reduce((t, l) => t + (Number(l.amount) || 0), 0), sp = numIn($('#shSpent', m).value), all3 = numIn($('#shCash', m).value) + numIn($('#shCard', m).value) + sp;
      $('#shSum', m).innerHTML = `المجموع: <b>${money(all3)}</b>${r.total_written && Math.abs(r.total_written - all3) > 0.01 ? ` <span class="pos">(المكتوب تحت الخط ${money(r.total_written)})</span>` : ''}${sp && Math.abs(sp - linesSum) > 0.01 ? `<br><span class="muted">الخرج المكتوب ${money(sp)} وأسطر المصاريف ${money(linesSum)} — المعتمد الخرج المكتوب</span>` : ''}`;
      const save = lines.filter(l => l.kind !== 'taken' && !l.skip), n = k => save.filter(l => l.kind === k).length;
      const taken = lines.filter(l => l.kind === 'taken').reduce((t, l) => t + (Number(l.amount) || 0), 0);
      // المشتري أخذ من الدرج X — وسجّل «من الدرج» Y: الفرق ما اتسجل
      $('#shTaken', m).innerHTML = taken || drawnSum ? `<div class="card" style="margin:6px 0;padding:8px"><b>👤 فلوس المشتري من الدرج</b>
        <div class="small">الورقة تقول أخذ: <b>${money(taken)}</b> · سجّل المشتري «من الدرج» هاليوم: <b>${money(drawnSum)}</b>${byPurch.length ? ` <span class="muted">(${byPurch.map(d => esc(d.label) + ' ' + money(d.amount)).join('، ')})</span>` : ''}</div>
        ${taken > drawnSum + 0.01 ? `<div class="small pos">فيه <b>${money(taken - drawnSum)}</b> ريال أخذها المشتري وما سجّل وش اشترى فيها للحين</div>` : ''}</div>` : '';
      $('#shTot', m).innerHTML = `يتسجل: <b>${money(save.reduce((t, l) => t + (Number(l.amount) || 0), 0))}</b> ريال — ${n('purchase')} شراء · ${n('expense')} مصروف · ${n('supplier')} سداد${lines.length - save.length ? ` · ${lines.length - save.length} ما يتسجل` : ''}`;
    };
    draw();
    $$('#shCash, #shCard, #shSpent', m).forEach(i => i.oninput = tot);
    $('#shOk', m).onclick = e => busy(e.currentTarget, async () => {
      const def = $('#shDate', m).value || S.date, dOf = l => l.date || def;
      const todo = lines.filter(l => l.kind !== 'taken' && !l.skip);
      const bad = todo.find(l => !(Number(l.amount) > 0) || (l.kind === 'purchase' && !l.item_id) || (l.kind === 'supplier' && !l.supplier_id && !(l.new_supplier && l._newName)));
      if (bad) throw new Error(`كمّل السطر «${bad.text}»: ${!(Number(bad.amount) > 0) ? 'المبلغ' : bad.kind === 'purchase' ? 'الصنف' : 'المورد'}`);
      const img = imgs[0] || '';
      const done = { p: 0, e: 0, s: 0, cash: false }, fail = [];
      const cash = numIn($('#shCash', m).value) || 0, card = numIn($('#shCard', m).value) || 0, spentIn = $('#shSpent', m).value.trim();
      if (cash > 0 || card > 0) {
        const spent = spentIn === '' ? lines.reduce((t, l) => t + (Number(l.amount) || 0), 0) : numIn(spentIn); // الخرج المكتوب هو المعتمد
        try { await POST('/api/cash', { date: def, cash, card, spent, note: 'من الورقة اليومية' }); done.cash = true; }
        catch (er) { fail.push(`الكاش والشبكة: ${er.message}`); }
      }
      // المشتريات: شراء واحد لكل تاريخ
      const byDate = new Map();
      for (const l of todo.filter(x => x.kind === 'purchase')) { const d = dOf(l); if (!byDate.has(d)) byDate.set(d, []); byDate.get(d).push(l); }
      for (const [d, ls] of byDate) {
        try { await POST('/api/purchases', { date: d, payment, image: img, note: 'من الورقة اليومية', lines: ls.map(l => ({ item_id: l.item_id, qty: Number(l.qty) || 1, unit: l.unit || '', line_total: Number(l.amount) })) }); done.p += ls.length; }
        catch (er) { fail.push(`شراء ${d}: ${er.message}`); }
      }
      for (const l of todo.filter(x => x.kind === 'expense')) {
        try { await POST('/api/expenses', { date: dOf(l), amount: Number(l.amount), category: l.category || 'مصاريف', note: 'من الورقة اليومية: ' + l.text, payment, image: img }); done.e++; }
        catch (er) { fail.push(`«${l.text}»: ${er.message}`); }
      }
      for (const l of todo.filter(x => x.kind === 'supplier')) {
        try {
          if (!l.supplier_id && l.new_supplier) { // مورد جديد من الورقة («مندوب دجاج» => شركة التنمية)
            const f = (await suppliersList()).find(x => x.name === l._newName);
            l.supplier_id = f ? f.id : (await POST('/api/suppliers', { name: l._newName })).id;
          }
          await POST(`/api/suppliers/${l.supplier_id}/pay`, { date: dOf(l), amount: Number(l.amount), payment, note: 'من الورقة اليومية: ' + l.text, image: img }); done.s++; }
        catch (er) { fail.push(`«${l.text}»: ${er.message}`); }
      }
      S.cache.items = null; close();
      toast(`✓ اتسجل ${done.p} شراء و${done.e} مصروف${done.s ? ` و${done.s} سداد` : ''}${done.cash ? ' + الكاش والشبكة' : ''}${fail.length ? ` — ما اتسجل: ${fail.join('، ')}` : ''}`, !!fail.length);
      route();
    });
  });
}

// تعديل شراء (قبل الاعتماد): المورد، الدفع، التاريخ، والأسطر
function editPurchase(p, items, suppliers) {
  const rows = p.lines.map(l => ({ item_id: l.item_id, qty: l.pu_name ? l.pu_qty : l.qty, unit: l.pu_name || '', unit_price: l.pu_name ? l.pu_price : l.unit_price, to_floor: !!l.to_floor }));
  let payment = p.payment;
  const PAY = [['custody', '👛 من العهدة'], ['card', '💳 بطاقة'], ['cash', '💵 من الدرج'], ['paid', 'مدفوع برا'], ['credit', '📒 آجل']];
  modal('✏️ تعديل الشراء', `<div class="row"><label class="f grow">المورد<input id="eSup" list="eSupL" value="${esc(p.supplier)}"></label><label class="f">التاريخ<input type="date" id="eDate" value="${p.date}"></label></div>
    <datalist id="eSupL">${suppliers.map(x => `<option value="${esc(x.name)}">`).join('')}</datalist>
    <div class="row" style="gap:6px;flex-wrap:wrap;margin:8px 0" id="ePay"></div>
    <div id="eLines"></div><button class="btn small" id="eAdd">+ صنف</button>
    <label class="f" style="margin-top:8px">ملاحظة<input id="eNote" value="${esc(p.note || '')}"></label>
    <div class="qb-total" id="eTot" style="margin-top:8px"></div>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="eOk">حفظ التعديل</button><button class="btn" data-close>إلغاء</button></div>`, (m, close) => {
    const itemOf = id => items.find(i => i.id === Number(id));
    const draw = () => {
      $('#ePay', m).innerHTML = PAY.map(([k, v]) => `<button class="btn small ${k === payment ? 'primary' : ''}" data-epay="${k}">${v}</button>`).join('');
      $$('[data-epay]', m).forEach(b => b.onclick = () => { payment = b.dataset.epay; draw(); });
      $('#eLines', m).innerHTML = rows.map((r, i) => { const it = itemOf(r.item_id);
        return `<div class="row" data-er="${i}" style="gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap"><select data-ef="item_id" style="min-width:120px;flex:1">${itemOptions(items, r.item_id)}</select>
          <input class="qty" data-ef="qty" inputmode="decimal" value="${esc(r.qty)}" style="width:64px">
          ${it && it.units && it.units.length ? `<select data-ef="unit" style="width:auto"><option value="">${esc(it.unit)}</option>${it.units.map(x => `<option value="${esc(x.name)}" ${x.name === r.unit ? 'selected' : ''}>${esc(x.name)} (${qtyFmt(x.factor)} ${esc(it.unit)})</option>`).join('')}</select>` : `<span class="small muted">${esc(it ? it.unit : '')}</span>`}
          <span class="small">× سعر ${esc(r.unit || (it ? it.unit : ''))}</span><input class="qty" data-ef="unit_price" inputmode="decimal" placeholder="السعر" value="${esc(r.unit_price || '')}" style="width:72px">
          <button class="btn small danger" data-erm="${i}">×</button></div>`; }).join('');
      $$('[data-ef]', m).forEach(inp => inp.onchange = () => { const r = rows[Number(inp.closest('[data-er]').dataset.er)]; r[inp.dataset.ef] = inp.value; if (inp.dataset.ef === 'item_id' || inp.dataset.ef === 'unit') { if (inp.dataset.ef === 'item_id') { const ni = itemOf(r.item_id); r.unit = ni && ni.buy_unit && ni.buy_unit !== ni.unit ? ni.buy_unit : ''; } draw(); } else tot(); });
      $$('[data-erm]', m).forEach(b => b.onclick = () => { rows.splice(Number(b.dataset.erm), 1); draw(); });
      tot();
    };
    const tot = () => { $('#eTot', m).innerHTML = `المجموع: <b>${money(rows.reduce((t, r) => t + numIn(r.qty) * numIn(r.unit_price), 0))}</b> ريال`; };
    draw();
    $('#eAdd', m).onclick = () => { rows.push({ item_id: '', qty: 1, unit: '', unit_price: '', to_floor: undefined }); draw(); };
    $('#eOk', m).onclick = e => busy(e.currentTarget, async () => {
      const lines = rows.filter(r => r.item_id && numIn(r.qty) > 0).map(r => ({ item_id: Number(r.item_id), qty: numIn(r.qty), unit: r.unit || '', unit_price: numIn(r.unit_price) || '', to_floor: r.to_floor }));
      if (!lines.length && !p.note && !p.image) throw new Error('وش اشتريت؟');
      await PUT('/api/purchases/' + p.id, { date: $('#eDate', m).value, supplier: $('#eSup', m).value.trim(), payment, note: $('#eNote', m).value, lines, total: lines.length ? undefined : p.total });
      S.cache.items = null; close(); toast('انعدّل ✓'); route();
    });
  });
}
async function pagePurchases(main, alive) {
  let items = (await itemsList(true)).filter(i => i.kind === 'raw');
  const [list, summary, suppliers] = await Promise.all([GET('/api/purchases'), isPurch() ? GET('/api/purchases/summary') : Promise.resolve(null), suppliersList()]);
  if (!alive()) return;
  const photos = [];
  let lines = [{ item_id: '', qty: '', unit_price: '', to_floor: false }];
  main.innerHTML = `${isSup() ? '<div id="cust"></div>' : ''}<div id="qb"></div>
    <details class="card"><summary><b>الطريقة الكاملة</b> <span class="small muted">(صنف جديد، وحدة جديدة، آجل بتفاصيل…)</span></summary>
      <p class="muted small">اختر الأصناف أو صوّر الفاتورة أو اكتب. الصنف اللي ينجرد يوميًا يدخل جرد المسؤول على طول، وغيره المستودع.</p>
      <div class="row"><label class="f grow">المورد/المحل<input id="pSup" list="supList" placeholder="اختر أو اكتب اسم جديد"></label><label class="f">التاريخ<input type="date" id="pDate" value="${S.date}"></label></div>
      <datalist id="supList">${suppliers.map(x => `<option value="${esc(x.name)}">`).join('')}</datalist>
      <div class="row" style="margin-top:8px"><span class="small muted">الدفع:</span>${payOptions('cash')}</div>
      <p class="muted small" style="margin:4px 0 0">«آجل» ينضاف على حساب المورد، وتسدده بعدين من صفحة الموردين.</p>
      <datalist id="puItems"></datalist>
      <div id="pLines" style="margin-top:8px"></div>
      <button class="btn small" id="pAdd">+ صنف</button>
      <label class="f" style="margin-top:8px">كتابة / ملاحظة<textarea id="pNote" rows="2"></textarea></label>
      <label class="f">المبلغ الكلي (إذا ما حددت أصناف)<input id="pTotal" inputmode="decimal"></label>
      <div style="margin-top:8px">${photoInputs('pu', false)}</div>
      ${S.me.has_ai ? `<div class="row" style="margin-top:6px"><button class="btn" id="pRead">🤖 اقرأ الفاتورة وعبّي الأسطر</button><span class="small muted">صوّر الفاتورة أول — بعدين شيك الأسطر قبل الحفظ</span></div><div id="pReadOut"></div>` : ''}
      <button class="btn primary" id="pSave" style="margin-top:10px">حفظ الشراء</button></details>
    ${summary ? `<div class="card"><details><summary><b>جرد المشتريات (آخر ٣٠ يوم)</b></summary><div class="tbl-wrap"><table><thead><tr><th>الصنف</th><th class="n">اشتريت</th><th class="n">انصرف</th><th class="n">تعديل جرد</th><th class="n">الرصيد</th><th class="n">صرفت ريال</th></tr></thead><tbody>
      ${summary.map(s => `<tr><td>${esc(s.name)}</td><td class="n">${qtyFmt(s.bought)} ${esc(s.unit)}</td><td class="n">${qtyFmt(s.used)}</td><td class="n ${s.adjust < 0 ? 'pos' : ''}">${qtyFmt(s.adjust)}</td><td class="n">${qtyFmt(s.balance)}</td><td class="n">${money(s.spent)}</td></tr>`).join('')}
    </tbody></table></div></details></div>` : ''}
    <div class="card"><div class="sec-head"><h3 style="margin:0">المشتريات</h3>${isSup() && list.some(p => !p.approved) ? `<button class="btn small primary" id="apAll">✓ اعتمد الكل (${list.filter(p => !p.approved).length})</button>` : ''}</div>
      <p class="small muted">زكريا يقدر يعدّل مشترياته لين تنعتمد — بعد الاعتماد تنقفل.</p><div class="tbl-wrap"><table><thead><tr><th>التاريخ</th><th>مين</th><th>المورد</th><th>الأصناف</th><th class="n">المبلغ</th><th>الدفع</th><th></th></tr></thead><tbody>
      ${list.map(p => `<tr><td class="small">${p.date}</td><td>${esc(p.user || '')}</td><td>${esc(p.supplier)}</td>
        <td class="small">${p.lines.map(l => l.pu_name ? `${esc(l.item)} ${qtyFmt(l.pu_qty)} ${esc(l.pu_name)}${l.pu_price ? ' × ' + money(l.pu_price) : ''} (= ${qtyFmt(l.qty)} ${esc(l.unit)})${l.to_floor ? ' (للجرد)' : ''}`
          : `${esc(l.item)} ${qtyFmt(l.qty)} ${esc(l.unit || '')}${l.unit_price ? ' × ' + money(l.unit_price) : ''}${l.to_floor ? ' (للجرد)' : ''}`).join('، ')}${p.note ? `<div class="muted">${esc(p.note)}</div>` : ''}</td>
        <td class="n">${money(p.total)}</td><td><span class="badge ${p.payment === 'credit' ? 'amber' : ''}">${PAYMENT[p.payment] || ''}</span>${p.awaiting_invoice ? ` <span class="badge amber">⏳ ينتظر الحساب</span>${isSup() ? ` <button class="btn small primary" data-inv="${p.id}">🧾 وصل الحساب</button>` : ''}` : ''}${p.lines.some(l => l.invoice_qty != null && Math.abs(l.invoice_qty - l.qty) > 0.05) ? ` <span class="badge red" title="${esc(p.lines.filter(l => l.invoice_qty != null && Math.abs(l.invoice_qty - l.qty) > 0.05).map(l => `${l.item}: الحساب ${qtyFmt(l.invoice_qty)} — وزنّا ${qtyFmt(l.qty)}`).join('\n'))}">⚖️ فرق بالوزن</span>` : ''}</td>
        <td>${p.image ? `<img src="/uploads/${esc(p.image)}" data-img style="width:44px;height:44px;object-fit:cover;border-radius:6px;cursor:zoom-in">` : ''} ${p.approved ? `<span class="badge green">✓ معتمد${p.approved_by_name ? ' · ' + esc(p.approved_by_name) : ''}</span>${isOwner() ? ` <button class="btn small" data-unap="${p.id}">رجّعه للتعديل</button>` : ''}`
          : `<span class="badge amber">ينتظر الاعتماد</span>${isSup() || p.user_id === S.me.id ? ` <button class="btn small" data-pedit="${p.id}">✏️ تعديل</button> <button class="btn small danger" data-del="${p.id}">حذف</button>` : ''}${isSup() ? ` <button class="btn small primary" data-ap="${p.id}">✓ اعتمد</button>` : ''}`}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">ما فيه</td></tr>'}
    </tbody></table></div></div>`;
  bindPhotos(main, 'pu', photos);
  // 🧾 حساب المورد وصل: الكمية اللي في الحساب (افتراضياً اللي وزناها) + سعر الوحدة => يتأكد الشراء ويطلع الفرق
  $$('[data-inv]', main).forEach(btn => btn.onclick = () => {
    const p = list.find(x => x.id === Number(btn.dataset.inv)); if (!p) return;
    modal(`🧾 حساب ${p.supplier}`, `<p class="small muted">الكمية مكتوبة من الوزن — غيّرها لو الحساب غير. واكتب سعر الوحدة.</p>
      ${p.lines.map(l => `<div class="row" data-l="${l.item_id}" style="gap:6px;align-items:end;margin:6px 0"><b style="flex:1">${esc(l.item)}<div class="small muted">وزنّا ${qtyFmt(l.qty)} ${esc(l.unit || '')}</div></b>
        <label class="f">في الحساب<input class="qty" data-q inputmode="decimal" value="${l.qty}" style="width:80px"></label>
        <label class="f">السعر<input class="qty" data-pr inputmode="decimal" value="${l.unit_price || ''}" style="width:80px"></label></div>`).join('')}
      <div class="row" style="margin-top:8px"><b>المجموع: <span id="invT">0</span></b></div>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="invOk">✓ اعتمد الحساب</button><button class="btn" data-close>إلغاء</button></div>`, (m, close) => {
      const calc = () => { $('#invT', m).textContent = money($$('[data-l]', m).reduce((t, d) => t + numIn($('[data-q]', d).value) * numIn($('[data-pr]', d).value), 0)); };
      $$('input', m).forEach(i => i.oninput = calc); calc();
      $('#invOk', m).onclick = e => busy(e.currentTarget, async () => {
        const lines = $$('[data-l]', m).map(d => ({ item_id: Number(d.dataset.l), qty: numIn($('[data-q]', d).value), unit_price: numIn($('[data-pr]', d).value) }));
        if (lines.some(l => !(l.unit_price > 0))) throw new Error('اكتب سعر كل صنف');
        const r = await POST(`/api/purchases/${p.id}/invoice`, { lines });
        close(); toast(`انعتمد الحساب ✓ — ${money(r.total)} ريال`); route();
      });
    });
  });
  quickBuy($('#qb', main));
  if (isSup()) custodyCard($('#cust', main));
  // وحدة الشراء: زكريا يكتب «3 كرتون بـ 40»، والنظام يحولها للوحدة الأساسية (72 علبة، العلبة 1.67)
  const itemById = id => items.find(x => x.id === Number(id));
  const factorOf = l => {
    const it = itemById(l.item_id); if (!it) return 1;
    if (!l.unit || l.unit === it.unit) return 1;
    if (l.unit === '__new') return Number(l.factor) || 0;
    const u = it.units.find(x => x.name === l.unit); return u ? u.factor : 0;
  };
  const hint = l => {
    const it = itemById(l.item_id); if (!it || !Number(l.qty)) return '';
    const f = factorOf(l), q = Number(l.qty);
    const price = Number(l.unit_price) || (Number(l.line_total) ? Number(l.line_total) / q : 0);
    if (!f) return `<span class="pos">اكتب كم ${esc(it.unit)} في ${esc(l.unit === '__new' ? (l.new_name || 'الوحدة') : l.unit)}</span>`;
    return `= <b>${qtyFmt(q * f)} ${esc(it.unit)}</b>${price ? ` · ال${esc(it.unit)} بـ <b>${money(price / f)}</b> · المجموع ${money(price * q)}` : ''}`;
  };
  const drawLines = () => {
    $('#pLines').innerHTML = lines.map((l, i) => {
      const it = itemById(l.item_id);
      const unitSel = it ? `<select data-f="unit" style="width:auto">
          <option value="">${esc(it.unit)}</option>${it.units.map(u => `<option value="${esc(u.name)}" ${l.unit === u.name ? 'selected' : ''}>${esc(u.name)} (${qtyFmt(u.factor)} ${esc(it.unit)})</option>`).join('')}
          <option value="__new" ${l.unit === '__new' ? 'selected' : ''}>+ وحدة جديدة…</option></select>` : '';
      return `<div class="card" data-i="${i}" style="padding:10px;margin-bottom:8px;background:#fafafa">
        <div class="row"><input class="grow" data-f="item_text" list="puItems" placeholder="اكتب اسم الصنف…" value="${esc(it ? it.name : (l.item_text || ''))}" autocomplete="off">${unitSel}<button class="btn small danger" data-rm="${i}">×</button></div>
        ${!it && (l.item_text || '').trim() ? `<div class="row" style="margin-top:6px"><span class="small muted">«${esc(l.item_text.trim())}» مو موجود</span><button class="btn small primary" data-newitem="${i}">+ أضفه صنف جديد</button></div>` : ''}
        ${l.unit === '__new' && it ? `<div class="row" style="margin-top:6px"><input class="grow" data-f="new_name" placeholder="اسم الوحدة (كرتون، شدّة، كيس…)" value="${esc(l.new_name || '')}">
          <input class="qty" data-f="factor" inputmode="decimal" placeholder="كم ${esc(it.unit)} فيها" value="${esc(l.factor || '')}"></div>` : ''}
        <div class="row" style="margin-top:6px">
          <input class="qty" data-f="qty" inputmode="decimal" placeholder="العدد" value="${esc(l.qty)}">
          <input class="qty" data-f="unit_price" inputmode="decimal" placeholder="سعر ${l.unit && l.unit !== '__new' ? esc(l.unit) : 'الوحدة'}" value="${esc(l.unit_price)}">
          <span class="small muted">أو</span>
          <input class="qty" data-f="line_total" inputmode="decimal" placeholder="مبلغ السطر" value="${esc(l.line_total || '')}">
          <label class="small" style="display:flex;gap:4px;align-items:center"><input type="checkbox" data-f="to_floor" ${l.to_floor ? 'checked' : ''}>يدخل جرد المسؤول على طول</label></div>
        <div class="small" data-hint style="margin-top:4px">${hint(l)}</div></div>`;
    }).join('');
    $$('#pLines [data-f]').forEach(inp => {
      const ev = inp.tagName === 'SELECT' || inp.type === 'checkbox' ? 'onchange' : 'oninput';
      inp[ev] = () => {
        const box = inp.closest('[data-i]'), l = lines[Number(box.dataset.i)], f = inp.dataset.f;
        l[f] = inp.type === 'checkbox' ? inp.checked : inp.value;
        if (f === 'item_text') {
          // يختار من القائمة بالاسم (البحث من الخانة نفسها)
          const hit = items.find(x => x.name === inp.value.trim());
          // الطازج اليومي (لحوح، كدر، كبان — يخلص نفس اليوم) يدخل جرد اليوم على طول. البيبسي وغيره يروح المستودع
          if (hit && Number(l.item_id) !== hit.id) { l.item_id = hit.id; l.unit = hit.units.length ? hit.units[0].name : ''; l.factor = ''; l.new_name = ''; l.to_floor = !!hit.daily && !hit.pull_on_open && hit.leftover !== 'fridge'; return drawLines(); }
          if (!hit) { l.item_id = ''; if (ev === 'oninput') { clearTimeout(drawLines.t); drawLines.t = setTimeout(() => { drawLines(); const x = $(`[data-i="${box.dataset.i}"] [data-f="item_text"]`); if (x) { x.focus(); x.setSelectionRange(x.value.length, x.value.length); } }, 700); } }
          return;
        }
        if (f === 'unit') return drawLines();
        $('[data-hint]', box).innerHTML = hint(l);
      };
    });
    $$('#pLines [data-rm]').forEach(b => b.onclick = () => { lines.splice(Number(b.dataset.rm), 1); drawLines(); });
    // صنف جديد من نفس الشاشة: الاسم والوحدة، ويحفظ في أصناف المستودع
    $$('#pLines [data-newitem]').forEach(b => b.onclick = () => {
      const l = lines[Number(b.dataset.newitem)];
      modal('صنف جديد للمستودع', `<label class="f">الاسم<input id="niName" value="${esc(l.item_text.trim())}"></label>
        <label class="f">الوحدة اللي ينجرد وينحسب فيها<input id="niUnit" list="niUnits" placeholder="كجم، حبة، لتر…"></label>
        <datalist id="niUnits">${['كجم', 'حبة', 'لتر', 'علبة', 'ربطة', 'كيس', 'صحن'].map(x => `<option value="${x}">`).join('')}</datalist>
        <p class="small muted">مثلًا الطماطم «كجم»، والبيض «حبة». وإذا تشتريه بالكرتون، تختار «كرتون» بعدين من خانة الوحدة في سطر الشراء.</p>
        <div class="row" style="margin-top:10px"><button class="btn primary" id="niSave">إضافة</button><button class="btn" data-close>إلغاء</button></div>`, (m, close) => {
        $('#niSave', m).onclick = e => busy(e.currentTarget, async () => {
          const unit = $('#niUnit', m).value.trim(); if (!unit) throw new Error('اختر الوحدة');
          const r = await POST('/api/items', { name: $('#niName', m).value, unit });
          items = (await itemsList(true)).filter(i => i.kind === 'raw');
          refreshItemList();
          Object.assign(l, { item_id: r.id, item_text: '', unit: '', factor: '', new_name: '' });
          close(); toast('انضاف ✓'); drawLines();
        });
      });
    });
  };
  const refreshItemList = () => { $('#puItems').innerHTML = items.map(i => `<option value="${esc(i.name)}">${esc(i.section || '')}</option>`).join(''); };
  refreshItemList();
  drawLines();
  $('#pAdd').onclick = () => { lines.push({ item_id: '', qty: '', unit_price: '', to_floor: false }); drawLines(); };
  const rd = $('#pRead');
  if (rd) rd.onclick = () => busy(rd, async () => {
    if (!photos.length) throw new Error('صوّر الفاتورة أول (📷 الكاميرا)');
    const r = await api('POST', '/api/purchases/read', { images: photos }, 240000);
    if (r.supplier && !$('#pSup').value) $('#pSup').value = r.supplier;
    if (r.date) $('#pDate').value = r.date;
    lines = r.lines.map(l => {
      const it = itemById(l.item_id);
      return { item_id: l.item_id || '', item_text: l.item_id ? '' : l.name, qty: String(l.qty), unit: l.unit || '', unit_price: l.unit_price != null ? String(l.unit_price) : '', line_total: l.line_total != null ? String(l.line_total) : '',
        to_floor: it ? !!it.daily && !it.buy_store && (!it.carry_over || !!it.no_opening) : false };
    });
    if (!lines.length) lines = [{ item_id: '', qty: '', unit_price: '', to_floor: false }];
    drawLines();
    const miss = r.lines.filter(l => !l.item_id).length;
    $('#pReadOut').innerHTML = `<div class="alert ${miss || (r.total && Math.abs(r.total - r.lines_total) > 1) ? 'amber' : ''}" style="margin-top:6px">قريت ${r.lines.length} سطر${r.total ? ` · مجموع الفاتورة ${money(r.total)} ومجموع الأسطر ${money(r.lines_total)}` : ''}${miss ? ` · ${miss} صنف ما عرفته — اختره أو أضفه` : ''} · التكلفة ${cents(r.cost)}<br><b>شيك كل سطر قبل «حفظ الشراء».</b></div>`;
    $('#main').dataset.dirty = '1';
  });
  $('#pSave').onclick = e => busy(e.currentTarget, async () => {
    const payment = ($('input[name="pPay"]:checked', main) || {}).value || 'cash';
    if (lines.some(l => l.unit === '__new' && l.item_id && Number(l.qty) && (!String(l.new_name || '').trim() || !(Number(l.factor) > 0)))) throw new Error('اكتب اسم الوحدة الجديدة وكم فيها');
    const send = lines.map(l => l.unit === '__new' ? { ...l, unit: l.new_name.trim() } : l);
    await POST('/api/purchases', { check_receive: true, date: $('#pDate').value, supplier: $('#pSup').value, note: $('#pNote').value, total: $('#pTotal').value, payment, image: photos[0] || '', lines: send });
    S.cache.items = null; toast('انحفظ الشراء ✓'); route();
  });
  $$('[data-img]', main).forEach(img => img.onclick = () => showImage(img.src));
  $$('[data-ap]', main).forEach(b => b.onclick = () => busy(b, async () => { await POST(`/api/purchases/${b.dataset.ap}/approve`); toast('انعتمد ✓'); route(); }));
  $$('[data-unap]', main).forEach(b => b.onclick = () => busy(b, async () => { await POST(`/api/purchases/${b.dataset.unap}/approve`, { undo: true }); toast('رجع للتعديل'); route(); }));
  const apAll = $('#apAll', main);
  if (apAll) apAll.onclick = async () => { if (await confirmBox('تعتمد كل المشتريات اللي تنتظر؟ بعدها زكريا ما يقدر يعدّلها.')) busy(apAll, async () => { const r = await POST('/api/purchases/approve-all', { date: S.me.today }); toast(`انعتمد ${r.approved} ✓`); route(); }); };
  $$('[data-pedit]', main).forEach(b => b.onclick = () => editPurchase(list.find(p => p.id === Number(b.dataset.pedit)), items, suppliers));
  $$('[data-del]', main).forEach(b => b.onclick = async () => { if (await confirmBox('تحذف الشراء؟ بيطلع من المستودع.')) busy(b, async () => { await DEL('/api/purchases/' + b.dataset.del); route(); }); });
}

// ===================== عهدة الكاش =====================
async function custodyStatement(userId) {
  const c = await GET('/api/custody?user_id=' + userId);
  const K = { give: ['أعطاه', 'neg'], return: ['رجّع', ''], buy: ['اشترى', 'pos'], spend: ['صرف', 'pos'], supplier: ['سدد مورد', 'pos'] };
  const SP = { home: '🧾 خاص', advance: '👤 سلفة', restaurant: '🔧 مصروف' };
  modal('👛 كشف عهدة ' + c.name, `<div class="grid" style="margin-bottom:8px">
      <div class="stat"><div class="k">استلم</div><div class="v">${money(c.given)}</div></div>
      <div class="stat"><div class="k">صرف</div><div class="v">${money(c.spent)}</div>${c.spent_other ? `<div class="small muted">مشتريات ${money(c.spent_buy)} · غيرها ${money(c.spent_other)}</div>` : ''}</div>
      ${c.returned ? `<div class="stat"><div class="k">رجّع</div><div class="v">${money(c.returned)}</div></div>` : ''}
      <div class="stat ${c.balance < 0 ? 'red' : 'green'}"><div class="k">${c.balance >= 0 ? 'المفروض معه' : 'له عندك'}</div><div class="v">${money(Math.abs(c.balance))}</div></div></div>
    ${c.no_photo ? `<div class="alert amber small">${c.no_photo} بدون صورة فاتورة</div>` : ''}
    <div class="tbl-wrap"><table><thead><tr><th>التاريخ</th><th></th><th class="n">المبلغ</th><th>تفاصيل</th><th class="n">الباقي</th></tr></thead><tbody>
    ${c.entries.map(e => `<tr><td class="small">${e.date}</td><td>${K[e.kind][0]}</td><td class="n ${K[e.kind][1]}">${money(e.amount)}</td>
      <td class="small">${e.kind === 'spend' ? `<span class="badge">${SP[e.spend] || 'صرف'}</span> ` : ''}${e.self && e.kind !== 'buy' && e.kind !== 'spend' ? (e.confirmed ? '<span class="badge green">سجّلها هو · متأكد</span> ' : `<span class="badge amber">سجّلها هو · ما تأكد</span> ${isSup() ? `<button class="btn small" data-conf="${e.id}">أكّد ✓</button> ` : ''}`) : ''}${esc(e.note || '')}${e.from_drawer ? ' (من الدرج)' : ''}${e.image ? ` <img src="/uploads/${esc(e.image)}" data-img class="thumb-s" alt="الفاتورة">` : e.no_photo && (e.kind === 'buy' || e.kind === 'spend') ? ' <span class="badge amber">بدون فاتورة</span>' : ''}${e.by ? ` <span class="muted">· ${esc(e.by)}</span>` : ''}</td>
      <td class="n">${money(e.balance)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">ما فيه</td></tr>'}
    </tbody></table></div>
    ${c.card.length ? `<h4>💳 بالبطاقة — هالشهر ${money(c.card_total_month)} ريال</h4><div class="tbl-wrap"><table><tbody>${c.card.map(p => `<tr><td class="small">${p.date}</td><td class="n">${money(p.amount)}</td><td class="small">${esc(p.note)}${p.image ? ` <img src="/uploads/${esc(p.image)}" data-img class="thumb-s" alt="الفاتورة">` : ' <span class="badge amber">بدون فاتورة</span>'}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="row" style="margin-top:10px"><button class="btn" data-close>إغلاق</button></div>`, (m, close) => {
    $$('img[data-img]', m).forEach(img => img.onclick = () => showImage(img.src));
    $$('[data-conf]', m).forEach(b => b.onclick = () => busy(b, async () => { await POST(`/api/custody/${b.dataset.conf}/confirm`); close(); toast('تأكد ✓'); custodyStatement(userId); }));
  });
}
async function custodyCard(box) {
  const list = await GET('/api/custody');
  const users = (await usersList()).filter(u => u.active && u.role === 'purchaser');
  const ids = new Set(list.map(c => c.user_id));
  const rows = [...list, ...users.filter(u => !ids.has(u.id)).map(u => ({ user_id: u.id, name: u.name, given: 0, spent: 0, balance: 0, no_photo: 0 }))];
  box.innerHTML = `<div class="card"><h3>👛 عهدة الكاش</h3>
    <p class="small muted">الكاش اللي تعطيه للمشتري. كل شراء يسجله «من عهدتي» ينخصم منها — واللي باقي لازم يكون معه.</p>
    ${rows.map(c => `<div class="row" style="justify-content:space-between;align-items:center;margin:8px 0;padding:8px;border:1px solid var(--line);border-radius:10px">
      <div><b>${esc(c.name)}</b><div class="small">${c.balance >= 0 ? 'المفروض معه' : 'له عندك'} <b class="${c.balance < 0 ? 'pos' : ''}">${money(Math.abs(c.balance))}</b> ريال · استلم ${money(c.given)} · صرف ${money(c.spent)}${c.no_photo ? ` · <span class="pos">${c.no_photo} بدون فاتورة</span>` : ''}</div></div>
      <div class="row"><button class="btn small primary" data-cgive="${c.user_id}">+ أعطيته كاش</button><button class="btn small" data-cret="${c.user_id}">رجّع</button><button class="btn small" data-cst="${c.user_id}">الكشف</button></div></div>`).join('') || '<p class="muted small">ما فيه مسؤول مشتريات</p>'}</div>`;
  const ask = (uid, type) => modal(type === 'return' ? 'رجّع من العهدة' : 'أعطيته كاش', `<label class="f">المبلغ<input id="cA" inputmode="decimal" style="font-size:20px"></label>
      <label class="small" style="display:flex;gap:6px;align-items:center;margin:8px 0"><input type="checkbox" id="cD" checked> ${type === 'return' ? 'رجع للدرج' : 'من درج المطعم'} (ينحسب في الكاش المفروض)</label>
      <label class="f">ملاحظة<input id="cN"></label>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="cOk">حفظ</button><button class="btn" data-close>إلغاء</button></div>`, (m, close) => {
    $('#cA', m).focus();
    $('#cOk', m).onclick = e => busy(e.currentTarget, async () => {
      await POST('/api/custody', { user_id: uid, amount: $('#cA', m).value, type, from_drawer: $('#cD', m).checked, note: $('#cN', m).value, date: S.date });
      close(); toast('انحفظ ✓'); custodyCard(box);
    });
  });
  $$('[data-cgive]', box).forEach(b => b.onclick = () => ask(Number(b.dataset.cgive), 'give'));
  $$('[data-cret]', box).forEach(b => b.onclick = () => ask(Number(b.dataset.cret), 'return'));
  $$('[data-cst]', box).forEach(b => b.onclick = () => custodyStatement(Number(b.dataset.cst)));
}

// ===================== الشراء السريع (لزكريا): صوّر، تكلّم، أو اضغط على الصنف =====================
async function quickBuy(box) {
  const d = await GET('/api/purchases/quick');
  const cu = d.custody || {};
  let basket = [], supplier = '', payment = cu.has ? 'custody' : 'cash', photos = [], q = '', mode = 'buy';
  const sp = { kind: 'restaurant', amount: '', note: '', payment: 'custody', photos: [] };
  const PAY = [['custody', '👛 من عهدتي'], ['card', '💳 بالبطاقة'], ['cash', '💵 من الدرج'], ['paid', 'مدفوع برا'], ['credit', '📒 آجل']];
  const findItem = id => d.items.find(i => i.id === id) || d.all.find(i => i.id === id);
  // السطر: العدد بوحدة الشراء (كيس) + «المبلغ كله» أو «سعر الكيس» — والنظام يقسمه لوحدة الجرد (كجم)
  const addItem = async (id, over = {}) => {
    const it = findItem(Number(id)); if (!it) return;
    const ex = basket.find(b => b.item_id === it.id && !over.fromRead);
    if (ex) { ex.qty = Math.round((numIn(ex.qty) + 1) * 1000) / 1000; return draw(); }
    if (!it.buy_unit && !over.fromRead) await askBuyUnit(it); // أول مرة: تشتريه بإيش؟
    const last = it.last || {};
    const buyUnit = over.buyUnit ?? (it.buy_unit && it.buy_unit !== it.unit ? it.buy_unit : (last.unit || ''));
    const fromOver = over.line_total ? { mode: 'total', amount: over.line_total } : over.price ? { mode: 'each', amount: over.price } : { mode: 'total', amount: '' };
    basket.push({ item_id: it.id, name: it.name, unit: it.unit, units: it.units || [], cost: it.cost || 0, lastPrice: last.unit === buyUnit ? last.price : '', qty: over.qty || 1, to_floor: it.to_floor, ...fromOver, buyUnit });
    if (!supplier && last.supplier) supplier = last.supplier;
    draw();
  };
  const factorOfB = b => (b.buyUnit && (b.units.find(u => u.name === b.buyUnit) || {}).factor) || 1;
  const lineTotal = b => b.mode === 'each' ? numIn(b.qty) * numIn(b.amount) : numIn(b.amount);
  const perBase = b => { const q = numIn(b.qty) * factorOfB(b); return q ? lineTotal(b) / q : 0; };
  const oddPrice = b => b.cost > 0 && perBase(b) > 0 && (perBase(b) > b.cost * 3 || perBase(b) < b.cost / 3);
  const lineInfo = b => `<div class="small ${oddPrice(b) ? 'pos' : 'muted'}" style="margin-top:4px">${esc(explain(b))}${b.lastPrice && !numIn(b.amount) ? ` · آخر مرة ال${esc(b.buyUnit || b.unit)} بـ ${money(b.lastPrice)}` : ''}${oddPrice(b) ? `<br>⚠️ ال${esc(b.unit)} صار ${money(perBase(b))} وآخر مرة ${money(b.cost)} — متأكد من الوحدة والسعر؟` : ''}</div>`;
  const explain = b => {
    const u = b.buyUnit || b.unit, f = factorOfB(b), t = lineTotal(b);
    const parts = [`${qtyFmt(numIn(b.qty))} ${u}${f !== 1 ? ` = ${qtyFmt(numIn(b.qty) * f)} ${b.unit}` : ''}`];
    if (t) parts.push(`المجموع ${money(t)}`, `${b.buyUnit && f !== 1 ? 'ال' + b.buyUnit : 'ال' + b.unit} بـ ${money(t / (numIn(b.qty) || 1))}`);
    if (t && f !== 1) parts.push(`ال${b.unit} بـ ${money(perBase(b))}`);
    return parts.join(' — ');
  };
  function draw() {
    // سلة فيها أصناف = شغل ما انحفظ: التحديث التلقائي ما يمسحها
    const pb = box.closest('#main'); if (pb) { if (basket.length || sp.amount || sp.note) pb.dataset.dirty = '1'; else delete pb.dataset.dirty; }
    if (mode === 'spend') return drawSpend();
    const tiles = (q ? d.all.filter(i => i.name.includes(q)).slice(0, 24).map(i => findItem(i.id)) : d.items);
    const total = basket.reduce((t, b) => t + lineTotal(b), 0);
    box.innerHTML = `<div class="card qb">
      ${headHtml('🛒 وش اشتريت؟')}
      ${tabsHtml()}
      <div class="qb-big">
        <label class="btn qb-btn"><input type="file" accept="image/*" capture="environment" hidden id="qbCam">📷<span>صوّر الفاتورة</span></label>
        ${SR() && S.me.has_ai ? '<button class="btn qb-btn" id="qbMic">🎤<span>قول وش اشتريت</span></button>' : ''}
      </div>
      <div id="qbMsg"></div>
      <input id="qbQ" placeholder="🔍 ابحث عن صنف…" value="${esc(q)}" style="margin:8px 0">
      <div class="qb-tiles">${tiles.filter(Boolean).map(i => `<button class="qb-tile ${basket.some(b => b.item_id === i.id) ? 'on' : ''}" data-tile="${i.id}"><b>${esc(i.name)}</b>${i.last ? `<span>آخر مرة ${qtyFmt(i.last.qty)} ${esc(i.last.unit || i.unit)}${i.last.price ? ' × ' + money(i.last.price) : ''}</span>` : `<span>${esc(i.unit)}</span>`}</button>`).join('') || '<p class="muted small">ما لقيت — جرّب «الطريقة الكاملة» تحت وأضفه</p>'}</div>
      ${basket.length ? `<div class="qb-basket">${basket.map((b, i) => `<div class="qb-line" data-bi="${i}">
          <div class="row" style="justify-content:space-between"><b>${esc(b.name)}</b><button class="btn small" data-brm="${i}" aria-label="شيل">✕</button></div>
          <div class="row" style="gap:6px;align-items:center">
            <button class="btn qb-step" data-step="-1">−</button><input class="qty" data-bf="qty" inputmode="decimal" value="${esc(b.qty)}" style="width:70px;text-align:center;font-size:18px"><button class="btn qb-step" data-step="1">+</button>
            ${b.units.length ? `<select data-bf="buyUnit" style="width:auto"><option value="">${esc(b.unit)}</option>${b.units.map(u => `<option value="${esc(u.name)}" ${u.name === b.buyUnit ? 'selected' : ''}>${esc(u.name)} (${qtyFmt(u.factor)} ${esc(b.unit)})</option>`).join('')}</select>` : `<span class="muted">${esc(b.unit)}</span>`}</div>
          <div class="row" style="gap:6px;align-items:center;margin-top:6px">
            <button class="qb-chip ${b.mode === 'total' ? 'on' : ''}" data-mode-l="total">المبلغ كله</button><button class="qb-chip ${b.mode === 'each' ? 'on' : ''}" data-mode-l="each">سعر ${b.buyUnit ? 'ال' + esc(b.buyUnit) : 'ال' + esc(b.unit)} الواحد</button>
            <input class="qty" data-bf="amount" inputmode="decimal" placeholder="${b.mode === 'total' ? 'كم دفعت؟' : 'السعر'}" value="${esc(b.amount)}" style="width:90px;font-size:18px"></div>
          <div class="qb-exp">${lineInfo(b)}</div></div>`).join('')}</div>
        <div class="small" style="margin-top:8px">من وين؟</div>
        <div class="row" style="gap:6px;flex-wrap:wrap">${d.suppliers.map(s => `<button class="qb-chip ${s.name === supplier ? 'on' : ''}" data-sup="${esc(s.name)}">${esc(s.name)}</button>`).join('')}<input id="qbSup" placeholder="محل ثاني…" value="${esc(d.suppliers.some(s => s.name === supplier) ? '' : supplier)}" style="max-width:150px"></div>
        <div class="row" style="gap:6px;margin-top:8px">${PAY.map(([k, v]) => `<button class="qb-chip ${k === payment ? 'on' : ''}" data-pay="${k}">${v}</button>`).join('')}</div>
        <div class="qb-total">المجموع: <b id="qbTotV">${money(total)}</b> ريال${photos.length ? ' · 📷 الفاتورة معك' : ''}</div>
        ${payment === 'custody' ? `<div class="small ${total > cu.balance ? 'pos' : 'muted'}" style="margin-bottom:8px">${total > cu.balance ? `⚠️ المبلغ أكثر من اللي معك (${money(cu.balance)}) — الفرق يصير لك عند نوح` : `بعد الشراء يبقى معك ${money(cu.balance - total)} ريال`}${photos.length ? '' : ' · صوّر الفاتورة عشان تبرّر الصرف'}</div>` : ''}
        <button class="btn primary qb-save" id="qbSave">✓ سجّل الشراء</button>` : '<p class="small muted" style="margin-top:8px">اضغط على الصنف اللي اشتريته — أو صوّر الفاتورة وأنا أعبّيها لك.</p>'}
    </div>`;
    bind();
  }
  function headHtml(title) {
    return `<div class="row" style="justify-content:space-between;align-items:center"><h3 style="margin:0">${title}</h3>
        <div class="small">${d.today.count ? `اليوم سجّلت <b>${d.today.count}</b> · ${money(d.today.total)} ريال` : 'ما سجّلت شي اليوم'}${d.streak > 1 ? ` · 🔥 ${d.streak} أيام ورا بعض` : ''}</div></div>
      <div class="qb-wallet"><span>👛 ${cu.balance >= 0 ? 'باقي عندك من عهدة الكاش' : 'لك عند نوح'}</span><b>${money(Math.abs(cu.balance))} ريال</b>
        <span class="row" style="gap:4px"><button class="btn small primary" id="qbGot">+ استلمت كاش</button><button class="btn small" id="qbStmt">الكشف</button></span></div>`;
  }
  function tabsHtml() {
    return `<div class="qb-tabs"><button class="qb-tab ${mode === 'buy' ? 'on' : ''}" data-mode="buy">🛒 شراء<span>بضاعة للمطعم</span></button><button class="qb-tab ${mode === 'spend' ? 'on' : ''}" data-mode="spend">💸 مصاريف<span>فلوس طلعت وما هي بضاعة</span></button></div>`;
  }
  // المصاريف من العهدة أو البطاقة — فلوس طلعت وما هي بضاعة (المالك يصنّفها بعدين من «المصروفات»)
  function drawSpend() {
    box.innerHTML = `<div class="card qb">${headHtml('💸 مصاريف')}${tabsHtml()}
        <label class="f" style="margin-top:8px">كم؟<input id="spAmt" inputmode="decimal" placeholder="المبلغ بالريال" value="${esc(sp.amount)}" style="font-size:24px;text-align:center"></label>
        <label class="f" style="margin-top:6px">وش هي؟<input id="spNote" placeholder="مثلًا: غاز، مشوار، غرض طلبه نوح…" value="${esc(sp.note)}"></label>
        <div class="row" style="gap:6px;margin-top:8px">${[['custody', '👛 من عهدتي'], ['card', '💳 بالبطاقة']].map(([k, v]) => `<button class="qb-chip ${k === sp.payment ? 'on' : ''}" data-spay="${k}">${v}</button>`).join('')}
          <label class="qb-chip"><input type="file" accept="image/*" capture="environment" hidden id="spCam">📷 ${sp.photos.length ? 'الصورة معك ✓' : 'صوّر الفاتورة'}</label></div>
        <div class="small" id="spLeft" style="margin:8px 0"></div>
        <button class="btn primary qb-save" id="spSave" style="margin-top:8px">✓ سجّل</button>
    </div>`;
    bindTop();
    $$('[data-spay]', box).forEach(b => b.onclick = () => { sp.payment = b.dataset.spay; draw(); });
    const keep = (id, k) => { const el = $(id, box); if (el) el.oninput = el.onchange = () => { sp[k] = el.value; if (k === 'amount') left(); }; };
    const left = () => {
      const el = $('#spLeft', box), amt = numIn(sp.amount); if (!el) return;
      el.className = 'small ' + (amt > cu.balance ? 'pos' : 'muted');
      el.textContent = sp.payment !== 'custody' || !amt ? '' : amt > cu.balance ? `⚠️ أكثر من اللي معك (${money(cu.balance)})` : `يبقى معك ${money(cu.balance - amt)} ريال`;
    };
    keep('#spAmt', 'amount'); keep('#spNote', 'note'); left();
    const cam = $('#spCam', box); if (cam) cam.onchange = e => busy(null, async () => { sp.photos = await readImages(e.target); draw(); });
    const sv = $('#spSave', box);
    if (sv) sv.onclick = () => busy(sv, async () => {
      sp.amount = $('#spAmt', box).value; sp.note = $('#spNote', box).value;
      const a = numIn(sp.amount);
      if (!a) throw new Error('كم صرفت؟');
      if (!sp.note.trim()) throw new Error('اكتب وش هي');
      if (!sp.photos.length && !await confirmBox('ما صوّرت الفاتورة — تسجلها كذا؟')) return;
      const r = await POST('/api/expenses', { date: S.date, amount: a, kind: sp.kind, category: 'مصاريف', note: sp.note, payment: sp.payment, image: sp.photos[0] || '' });
      if (r && sp.payment === 'custody') cu.balance = Math.round((cu.balance - a) * 100) / 100;
      toast(`✓ اتسجل — ${money(a)} ريال مصاريف`);
      Object.assign(sp, { amount: '', note: '', photos: [] });
      draw();
    });
  }
  function bindTop() {
    $$('[data-mode]', box).forEach(b => b.onclick = () => { mode = b.dataset.mode; draw(); });
    const st = $('#qbStmt', box); if (st) st.onclick = () => custodyStatement(S.me.id);
    const got = $('#qbGot', box); if (got) got.onclick = () => modal('👛 استلمت كاش', `<p class="small muted">كم أعطاك نوح؟ ينضاف لعهدتك — ونوح يأكده.</p>
        <label class="f">المبلغ<input id="gA" inputmode="decimal" style="font-size:22px"></label>
        <label class="f">ملاحظة<input id="gN" placeholder="مثلًا: لمشتريات الأسبوع"></label>
        <div class="row" style="margin-top:12px"><button class="btn primary" id="gOk">حفظ</button><button class="btn" data-close>إلغاء</button></div>`, (m, close) => {
      $('#gA', m).focus();
      $('#gOk', m).onclick = e => busy(e.currentTarget, async () => {
        const c = await POST('/api/custody', { amount: $('#gA', m).value, note: $('#gN', m).value, type: 'give', date: S.date });
        cu.balance = c.balance; cu.given = c.given; cu.has = true; close(); toast('انضاف ✓ — نوح بيأكده'); draw();
      });
    });
  }
  function bind() {
    bindTop();
    $$('[data-tile]', box).forEach(b => b.onclick = () => addItem(b.dataset.tile));
    const qi = $('#qbQ', box); qi.oninput = e => { q = e.target.value.trim(); draw(); const x = $('#qbQ', box); x.focus(); x.setSelectionRange(x.value.length, x.value.length); };
    $$('[data-brm]', box).forEach(b => b.onclick = () => { basket.splice(Number(b.dataset.brm), 1); draw(); });
    $$('[data-bi]', box).forEach(row => {
      const b = basket[Number(row.dataset.bi)];
      $$('[data-step]', row).forEach(s => s.onclick = () => { b.qty = Math.max(0, Math.round((numIn(b.qty) + Number(s.dataset.step)) * 1000) / 1000); draw(); });
      // الكتابة: نحدّث الحساب تحت السطر بس (بدون ما نعيد رسم الصفحة — عشان الضغطة الجاية ما تضيع)
      $$('[data-bf]', row).forEach(inp => {
        if (inp.dataset.bf === 'buyUnit') { inp.onchange = () => { b.buyUnit = inp.value; draw(); }; return; }
        inp.oninput = inp.onchange = () => {
          b[inp.dataset.bf] = numStr(inp.value);
          $('.qb-exp', row).innerHTML = lineInfo(b);
          const tv = $('#qbTotV', box); if (tv) tv.textContent = money(basket.reduce((t, x) => t + lineTotal(x), 0));
        };
      });
      $$('[data-mode-l]', row).forEach(c => c.onclick = () => { b.mode = c.dataset.modeL; draw(); });
    });
    $$('[data-sup]', box).forEach(c => c.onclick = () => { supplier = c.dataset.sup; draw(); });
    const si = $('#qbSup', box); if (si) si.onchange = () => { supplier = si.value.trim(); draw(); };
    $$('[data-pay]', box).forEach(c => c.onclick = () => { payment = c.dataset.pay; draw(); });
    $('#qbCam', box).onchange = e => busy(null, async () => {
      const imgs = await readImages(e.target); if (!imgs.length) return;
      photos = imgs; msg('📷 أقرأ الفاتورة… لحظة');
      if (!S.me.has_ai) { msg('📷 الصورة انحفظت مع الشراء — اختر الأصناف'); return draw(); }
      try {
        const r = await api('POST', '/api/purchases/read', { images: imgs }, 240000);
        if (r.supplier && !supplier) supplier = r.supplier;
        const miss = [];
        for (const l of r.lines) {
          if (l.item_id) addItem(l.item_id, { fromRead: true, qty: l.qty, buyUnit: l.unit || '', price: l.unit_price || '', line_total: l.line_total || '' });
          else miss.push(l);
        }
        draw();
        // الصنف اللي ما عرفته ما ينرمى: «➕ صنف جديد» يضيفه للمخزون ويحطه في السلة، أو «🔍 موجود» يدوّره بالبحث — والفاتورة تقعد شراء
        const showMiss = () => {
          const left = miss.filter(l => !l.done);
          msg(`✓ قريت ${r.lines.length} سطر. شيك الأرقام واضغط «سجّل».${left.length ? `<div style="margin-top:6px"><b>ما عرفت ${left.length} صنف — اختر لكل واحد:</b>${miss.map((l, i) => l.done ? '' : `<div class="row" style="justify-content:space-between;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap"><span>${esc(l.name)}${l.qty ? ` · ${qtyFmt(l.qty)} ${esc(l.unit || '')}` : ''}${l.line_total ? ` · ${money(l.line_total)}` : ''}</span><span><button class="btn small primary" data-mnew="${i}">➕ صنف جديد</button> <button class="btn small" data-mfind="${i}">🔍 موجود</button></span></div>`).join('')}</div>` : ''}`);
          $$('[data-mnew]', box).forEach(btn => btn.onclick = () => busy(btn, async () => {
            const l = miss[Number(btn.dataset.mnew)];
            const unit = /^(كجم|كيلو|لتر|حبة|علبة|كيس|كرتون|باكت|ربطة)$/.test(String(l.unit || '').trim()) ? String(l.unit).trim() : 'حبة';
            const { id } = await POST('/api/items', { name: String(l.name).trim(), unit, kind: 'raw', daily: 0, carry_over: 1, note: 'انضاف من فاتورة' });
            d.all.push({ id, name: String(l.name).trim(), unit, units: [], cost: 0, buy_unit: unit, last: null, to_floor: false });
            l.done = true; await addItem(id, { fromRead: true, qty: l.qty || 1, buyUnit: '', price: l.unit_price || '', line_total: l.line_total || '' });
            toast(`انضاف «${l.name}» ✓`); showMiss();
          }));
          $$('[data-mfind]', box).forEach(btn => btn.onclick = () => { const l = miss[Number(btn.dataset.mfind)]; l.done = true; q = String(l.name).split(/\s+/)[0] || ''; draw(); showMiss(); toast('اختر الصنف من القائمة وحط المبلغ'); });
        };
        showMiss();
      } catch (er) { draw(); msg('ما قدرت أقرأها — اختر الأصناف بيدك، والصورة تنحفظ مع الشراء'); }
    });
    const mic = $('#qbMic', box);
    if (mic) mic.onclick = () => {
      const rec = new (SR())(); rec.lang = 'ar-SA';
      mic.classList.add('on'); msg('🎤 تكلّم… مثلًا: «كرتونين طماطم بستين من خضار الوادي كاش»');
      rec.onresult = ev => busy(null, async () => {
        const t = ev.results[0][0].transcript; msg(`سمعت: «${esc(t)}» — لحظة…`);
        const r = await api('POST', '/api/assistant', { question: t }, 240000);
        const card = (r.actions || []).find(a => a.type === 'purchase');
        if (!card) { msg(esc(r.answer)); return; }
        const body = card.requests[0].body;
        if (body.supplier) supplier = body.supplier;
        if (body.payment) payment = body.payment;
        for (const l of body.lines) addItem(l.item_id, { fromRead: true, qty: l.qty, buyUnit: l.unit || '', price: l.unit_price || '', line_total: l.line_total || '' });
        draw(); msg('✓ جهزتها — شيك واضغط «سجّل»');
      });
      rec.onerror = () => msg('ما سمعتك — جرّب مرة ثانية');
      rec.onend = () => mic.classList.remove('on');
      rec.start();
    };
    const sv = $('#qbSave', box);
    if (sv) sv.onclick = () => busy(sv, async () => {
      const lines = basket.filter(b => numIn(b.qty) > 0);
      if (!lines.length) throw new Error('وش اشتريت؟');
      if (payment === 'credit' && !supplier) throw new Error('الآجل لازم له اسم المحل');
      if (lines.some(b => !numIn(b.amount)) && !await confirmBox('فيه صنف بدون سعر — تسجله كذا؟')) return;
      const odd = lines.filter(oddPrice);
      if (odd.length && !await confirmBox(`⚠️ السعر غريب: ${odd.map(b => `${b.name} — ال${b.unit} صار ${money(perBase(b))} وآخر مرة ${money(b.cost)}`).join('، ')}. متأكد إنك اخترت الوحدة الصح (كيس/كرتون…)؟`)) return;
      if (payment === 'custody' && !photos.length && !await confirmBox('ما صوّرت الفاتورة — نوح بيشوفها «بدون فاتورة» في الكشف. تسجلها كذا؟')) return;
      await POST('/api/purchases', { check_receive: true, date: S.date, supplier, payment, image: photos[0] || '',
        lines: lines.map(b => ({ item_id: b.item_id, qty: numIn(b.qty), unit: b.buyUnit || '', unit_price: b.mode === 'each' ? numIn(b.amount) || '' : '', line_total: b.mode === 'total' ? numIn(b.amount) || '' : '', to_floor: b.to_floor })) });
      const n = d.today.count + 1;
      toast(['🎉 كفو يا بطل!', '👏 تمام — انحفظ', '💪 شغل نظيف', '⭐ ممتاز'][n % 4] + ` — فاتورة رقم ${n} اليوم`);
      S.cache.items = null; route();
    });
  }
  const msg = h => { const m = $('#qbMsg', box); if (m) m.innerHTML = h ? `<div class="alert" style="margin-top:8px">${h}</div>` : ''; };
  draw();
}

// ===================== الموردين (الشراء الآجل) =====================
async function pageSuppliers(main, alive) {
  const [list, prices, us] = await Promise.all([suppliersList(), GET('/api/prices'), isSup() ? usersList() : Promise.resolve([])]);
  if (!alive()) return;
  const payers = us.filter(y => y.active && !y.bot && ['owner', 'supervisor', 'purchaser'].includes(y.role)); // مين يحاسب الموردين
  const owed = list.reduce((s, x) => s + (x.balance > 0 ? x.balance : 0), 0);
  main.innerHTML = `
    <div class="grid" style="margin-bottom:12px"><div class="stat ${owed > 0 ? 'red' : ''}"><div class="k">علينا للموردين</div><div class="v">${money(owed)}</div></div></div>
    <div class="card"><div class="sec-head"><h3 style="margin:0">الموردين</h3><button class="btn small primary" id="sNew">+ مورد</button></div>
      <p class="muted small">الشراء «آجل» ينضاف على المورد، والسداد ينقص منه. السداد من الدرج ينخصم من الكاش المفروض في تقرير اليوم.</p>
      <div class="tbl-wrap"><table><thead><tr><th>المورد</th><th class="n">كل المشتريات</th><th class="n">آجل</th><th class="n">سددنا</th><th class="n">الباقي علينا</th><th></th></tr></thead><tbody>
      ${list.map(x => `<tr${x.active ? '' : ' style="opacity:.5"'}><td class="item-name">${esc(x.name)}${x.phone ? `<div class="item-note">${esc(x.phone)}</div>` : ''}</td>
        <td class="n">${money(x.total_purchases)}</td><td class="n">${money(x.credit)}</td><td class="n">${money(x.paid)}</td>
        <td class="n ${x.balance > 0 ? 'pos' : ''}">${money(x.balance)}</td>
        <td><div class="row"><button class="btn small" data-st="${x.id}">كشف حساب</button>${x.balance > 0 ? `<button class="btn small primary" data-pay="${x.id}">سداد</button>` : ''}<button class="btn small" data-ed="${x.id}">تعديل</button></div></td></tr>`).join('') || '<tr><td colspan="6" class="muted">ما فيه موردين — ينضافون لحالهم أول ما تسجل شراء باسمهم</td></tr>'}
      </tbody></table></div></div>
    <div class="card"><h3>أسعار الشراء</h3>
      <p class="muted small">سعر الوحدة آخر ٣٠ يوم مقابل الشهرين اللي قبلها، وأرخص مورد لكل صنف (آخر ٣ شهور).</p>
      <div class="tbl-wrap"><table><thead><tr><th>الصنف</th><th class="n">آخر سعر</th><th class="n">متوسط الشهر</th><th class="n">قبل</th><th class="n">التغيّر</th><th>أرخص مورد</th></tr></thead><tbody>
      ${prices.map(r => `<tr><td>${esc(r.name)} <span class="muted small">${esc(r.unit)}</span></td><td class="n">${money(r.last_price)}<div class="item-note">${esc(r.last_supplier || '')} ${r.last_date}</div></td>
        <td class="n">${r.avg_30 == null ? '—' : money(r.avg_30)}</td><td class="n">${r.avg_before == null ? '—' : money(r.avg_before)}</td>
        <td class="n ${r.change_pct >= 10 ? 'pos' : r.change_pct <= -10 ? 'neg' : ''}">${r.change_pct == null ? '—' : (r.change_pct > 0 ? '+' : '') + r.change_pct + '%'}</td>
        <td class="small">${r.cheapest ? `${esc(r.cheapest.name)} ${money(r.cheapest.price)}${r.suppliers.length > 1 ? `<div class="item-note">${r.suppliers.slice(1).map(x => `${esc(x.name)} ${money(x.price)}`).join('، ')}</div>` : ''}` : '—'}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">ما فيه مشتريات بأسعار</td></tr>'}
      </tbody></table></div></div>`;
  const edit = x => {
    x = x || { name: '', phone: '', note: '', active: 1 };
    modal(x.id ? 'تعديل مورد' : 'مورد جديد', `<label class="f">الاسم<input id="sn" value="${esc(x.name)}"></label>
      <label class="f">الجوال<input id="sp" inputmode="tel" value="${esc(x.phone)}"></label><label class="f">ملاحظة<input id="so" value="${esc(x.note)}"></label>
      ${x.id ? `<label class="small" style="display:flex;gap:6px;align-items:center;margin-top:8px"><input type="checkbox" id="sa" ${x.active ? 'checked' : ''}> نتعامل معه</label>` : ''}
      <div class="row" style="margin-top:12px"><button class="btn primary" id="ss">حفظ</button><button class="btn" data-close>إلغاء</button></div>`, (m, close) => {
      $('#ss', m).onclick = e => busy(e.currentTarget, async () => {
        await POST('/api/suppliers', { id: x.id, name: $('#sn', m).value, phone: $('#sp', m).value, note: $('#so', m).value, active: x.id ? $('#sa', m).checked : true });
        close(); route();
      });
    });
  };
  $('#sNew').onclick = () => edit(null);
  $$('[data-ed]', main).forEach(b => b.onclick = () => edit(list.find(x => x.id === Number(b.dataset.ed))));
  $$('[data-pay]', main).forEach(b => b.onclick = () => {
    const x = list.find(y => y.id === Number(b.dataset.pay));
    const photos = [];
    modal('سداد — ' + x.name, `<p class="muted small">الباقي علينا: ${money(x.balance)}. تقدر تسدد دفعة بأي مبلغ، والدفعات تسدد الفواتير الأقدم أول.</p>
      <label class="f">المبلغ<input id="pa" inputmode="decimal" value="${x.balance}"></label>
      ${isSup() ? `<label class="f" style="margin-top:8px">مين دفع؟<select id="pPayer">${payers.map(y => `<option value="${y.id}" ${y.id === S.me.id ? 'selected' : ''}>${esc(y.id === S.me.id ? 'أنا (' + y.name + ')' : y.name)}</option>`).join('')}</select></label>` : ''}
      <div class="small" style="margin-top:8px">من وين؟</div>
      <div class="row" style="gap:6px;flex-wrap:wrap" id="pFrom"></div>
      <div class="small muted" id="pLeft" style="margin-top:4px"></div>
      <label class="f">ملاحظة<input id="pn" placeholder="تحويل، شيك…"></label>
      <div style="margin-top:8px">${photoInputs('sp', false)}</div>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="pg">حفظ السداد</button><button class="btn" data-close>إلغاء</button></div>`, (m, close) => {
      bindPhotos(m, 'sp', photos);
      // من وين: عهدة اللي دفع / الدرج / البطاقة / برا الدرج (المالك)
      let from = 'custody';
      const FROM = [['custody', '👛 من عهدته'], ['cash', '💵 من الدرج'], ['card', '💳 بطاقة'], ...(isSup() ? [['paid', 'مدفوع برا']] : [])];
      const drawFrom = async () => {
        $('#pFrom', m).innerHTML = FROM.map(([k, v]) => `<button class="btn small ${k === from ? 'primary' : ''}" data-pf="${k}">${v}</button>`).join('');
        $$('[data-pf]', m).forEach(b => b.onclick = () => { from = b.dataset.pf; drawFrom(); });
        const who = $('#pPayer', m) ? Number($('#pPayer', m).value) : S.me.id;
        $('#pLeft', m).textContent = '';
        if (from === 'custody') try { const c = await GET('/api/custody?user_id=' + who); $('#pLeft', m).textContent = `في عهدة ${c.name}: ${money(c.balance)} ريال`; } catch { /* */ }
      };
      drawFrom();
      if ($('#pPayer', m)) $('#pPayer', m).onchange = drawFrom;
      $('#pg', m).onclick = e => busy(e.currentTarget, async () => {
        await POST(`/api/suppliers/${x.id}/pay`, { amount: $('#pa', m).value, payment: from, payer_id: $('#pPayer', m) ? $('#pPayer', m).value : S.me.id, note: $('#pn', m).value, date: S.date, image: photos[0] || '' });
        close(); toast('انحفظ السداد ✓'); route();
      });
    });
  });
  $$('[data-st]', main).forEach(b => b.onclick = () => busy(b, async () => {
    const st = await GET('/api/suppliers/' + b.dataset.st);
    const rows = [
      ...st.purchases.map(p => ({ date: p.date, kind: 'شراء ' + (PAYMENT[p.payment] || ''), amount: p.total, credit: p.payment === 'credit', detail: p.lines.map(l => `${l.item} ${qtyFmt(l.qty)}`).join('، ') || p.note, img: p.image,
        status: p.payment !== 'credit' ? '' : p.remaining <= 0 ? '<span class="badge green">مسددة</span>' : p.paid > 0 ? `<span class="badge amber">باقي ${money(p.remaining)}</span>` : '<span class="badge red">ما تسددت</span>' })),
      ...st.payments.map(p => ({ date: p.date, kind: 'سداد' + (p.payer ? ' — ' + p.payer : '') + (p.payment === 'custody' ? ' (من عهدته)' : p.payment === 'cash' || (!p.payment && p.paid_from_cash) ? ' (من الدرج)' : p.payment === 'card' ? ' (بطاقة)' : ''), amount: -p.amount, detail: p.note, img: p.image, pid: p.id })),
    ].sort((a, c) => c.date.localeCompare(a.date));
    modal('كشف حساب — ' + st.name, `<p>الباقي علينا: <b class="${st.balance > 0 ? 'pos' : ''}">${money(st.balance)}</b></p>
      <div class="tbl-wrap"><table><thead><tr><th>التاريخ</th><th>النوع</th><th class="n">المبلغ</th><th>التفاصيل</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td class="small">${r.date}</td><td>${esc(r.kind)}</td><td class="n ${r.credit ? 'pos' : r.amount < 0 ? 'neg' : ''}">${money(Math.abs(r.amount))}</td>
        <td class="small">${r.status || ''} ${esc(r.detail || '')}${r.img ? ` <a href="/uploads/${esc(r.img)}" target="_blank">صورة</a>` : ''}${r.pid && isSup() ? ` <button class="btn small danger" data-pdel="${r.pid}">حذف</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">ما فيه</td></tr>'}
      </tbody></table></div><div class="row" style="margin-top:10px"><button class="btn" data-close>إغلاق</button></div>`, (m, close) => {
      $$('[data-pdel]', m).forEach(d => d.onclick = async () => { if (await confirmBox('تحذف السداد؟')) busy(d, async () => { await DEL('/api/supplier-payments/' + d.dataset.pdel); close(); route(); }); });
    });
  }));
}

// ===================== المصروفات =====================
// «💸 كل المصروفات»: كل فلوس طلعت لفترة — من وين (الدرج، العهدة، البطاقة…) وعلى وش (بضاعة، مصاريف، سداد)
async function pageSpending(main, alive) {
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  const dPlus = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const from = qs.get('from') || S.date, to = qs.get('to') || S.date, src = qs.get('src') || '';
  const r = await GET(`/api/spending?from=${from}&to=${to}`);
  if (!alive()) return;
  const SRC = { cash: '💵 من الدرج', custody: '👛 من العهدة', card: '💳 بالبطاقة', paid: 'مدفوع برا', credit: '📒 آجل' };
  const TYPE = { purchase: '🛒 بضاعة', expense: '💸 مصاريف المحل', supplier: '📒 سداد موردين', home: '🏠 خاص', advance: '👤 سلف موظفين' };
  const go = (f, t, s2 = src) => { location.hash = `#/spending?from=${f}&to=${t}${s2 ? '&src=' + s2 : ''}`; };
  const st = (k, v, cls = '', s2 = null) => `<div class="stat ${cls}" ${s2 != null ? `data-src="${s2}" style="cursor:pointer;${src === s2 ? 'outline:2px solid var(--accent, #2563eb)' : ''}"` : ''}><div class="k">${k}</div><div class="v">${money(v)}</div></div>`;
  const rows = r.rows.filter(x => !src || x.source === src);
  const QUICK = [['اليوم', S.date, S.date], ['أمس', dPlus(S.date, -1), dPlus(S.date, -1)], ['آخر ٧ أيام', dPlus(S.date, -6), S.date], ['هالشهر', S.date.slice(0, 8) + '01', S.date]];
  main.innerHTML = `<div class="card"><div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:8px">${QUICK.map(([t, f, e]) => `<button class="btn small ${f === from && e === to ? 'primary' : ''}" data-q="${f}|${e}">${t}</button>`).join('')}</div>
      <div class="row"><label class="f">من<input type="date" id="spF" value="${from}"></label><label class="f">إلى<input type="date" id="spT" value="${to}"></label><button class="btn" id="spGo" style="align-self:flex-end">اعرض</button></div></div>
    <div class="grid" style="margin-bottom:8px">${st('طلع فعلاً', r.out, 'red', '')}${st(SRC.cash, r.by_source.cash, '', 'cash')}${st(SRC.custody, r.by_source.custody, '', 'custody')}${st(SRC.card, r.by_source.card, '', 'card')}${r.by_source.paid ? st(SRC.paid, r.by_source.paid, '', 'paid') : ''}${st(SRC.credit + ' (لسه)', r.credit, '', 'credit')}</div>
    <div class="card"><b>على وش راحت</b> <span class="small muted">(بدون الآجل)</span><div class="row" style="gap:12px;flex-wrap:wrap;margin-top:6px">${Object.entries(TYPE).filter(([k]) => r.by_type[k] || ['purchase', 'expense', 'supplier'].includes(k)).map(([k, v]) => `<span>${v}: <b>${money(r.by_type[k])}</b></span>`).join('')}</div>
      <p class="small muted" style="margin:6px 0 0">«من الدرج» = اللي سجله المحل (الورقة اليومية) + اللي سجله المشتري إنه أخذه من الدرج — وهذا ينخصم من الكاش المتوقع في تقرير اليوم.
      الآجل ما ينحسب «طلع» لين ينسدد، وسداده ينحسب — عشان ما تنحسب نفس الفلوس مرتين.${r.custody_from_drawer ? ` عطيتوا المشتري عهدة من الدرج <b>${money(r.custody_from_drawer)}</b> — مو محسوبة هنا لأن اللي يشتريه منها ينحسب «من العهدة».` : ''}</p></div>
    <div class="card"><h3>${src ? SRC[src] : 'كل الحركات'} <span class="small muted">(${rows.length})</span>${src ? ' <button class="btn small" id="spAll">الكل</button>' : ''}</h3><div class="tbl-wrap"><table><thead><tr><th>اليوم</th><th>وش</th><th>النوع</th><th>من وين</th><th>سجّله</th><th class="n">المبلغ</th></tr></thead><tbody>
      ${rows.map(x => `<tr style="${x.source === 'credit' ? 'opacity:.6' : ''}"><td class="small">${x.date.slice(5)}</td><td>${esc(x.what)}${x.who && x.type === 'purchase' ? ` <span class="small muted">· ${esc(x.who)}</span>` : ''}${x.pending ? ' <span class="badge amber">ينتظر اعتماد</span>' : ''}${x.note ? `<div class="small muted">${esc(x.note)}</div>` : ''}</td>
        <td class="small">${TYPE[x.type]}</td><td class="small">${SRC[x.source]}</td><td class="small">${esc(x.by)}</td><td class="n">${money(x.amount)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">ما فيه شي</td></tr>'}
    </tbody></table></div></div>`;
  $$('[data-q]', main).forEach(b => b.onclick = () => { const [f, t] = b.dataset.q.split('|'); go(f, t); });
  $$('[data-src]', main).forEach(b => b.onclick = () => go(from, to, b.dataset.src));
  if ($('#spAll')) $('#spAll').onclick = () => go(from, to, '');
  $('#spGo').onclick = () => { const f = $('#spF').value, t = $('#spT').value; if (!f || !t) return toast('اختر التاريخين', true); go(f, t); };
}

// 🛠️ مشاكل الشغل من القروب: كل شي يتسجل، واللي على عامل له تدرّج (تذكير ← تنبيه ← للمالك)
async function pageIssues(main, alive) {
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  const r = await GET('/api/issues'), type = qs.get('t') || '', who = qs.get('w') || '';
  if (!alive()) return;
  const STEP = ['📝 اتسجل', '🌹 تذكير', '⚠️ تنبيه', '🛑 للمالك'];
  const rows = r.rows.filter(x => (!type || x.type === type) && (!who || x.employee === who));
  const count = (k, f) => r.rows.filter(f).length;
  const people = [...new Set(r.rows.map(x => x.employee).filter(Boolean))];
  main.innerHTML = `<div class="card"><h3>🛠️ مشاكل الشغل <span class="small muted">(آخر ٣٠ يوم — من القروب)</span></h3>
      <p class="small muted">اللي يكتبه المشرف أو المالك على عامل: أول مرة تذكير لطيف في الخاص، الثانية تنبيه، الثالثة توصل للمالك يقرر. التصحيح في الخاص، والمدح في القروب.</p>
      <div class="row" style="gap:6px;flex-wrap:wrap"><button class="btn small ${type ? '' : 'primary'}" data-it="">الكل (${r.rows.length})</button>${Object.entries(r.types).filter(([k]) => count(k, x => x.type === k)).map(([k, v]) => `<button class="btn small ${type === k ? 'primary' : ''}" data-it="${k}">${esc(v)} (${count(k, x => x.type === k)})</button>`).join('')}</div>
      ${people.length ? `<div class="row" style="gap:6px;flex-wrap:wrap;margin-top:6px"><button class="btn small ${who ? '' : 'primary'}" data-iw="">كل الموظفين</button>${people.map(p => `<button class="btn small ${who === p ? 'primary' : ''}" data-iw="${esc(p)}">${esc(p)} (${count(p, x => x.employee === p)})</button>`).join('')}</div>` : ''}
      ${isOwner() ? '<button class="btn" id="iwk" style="margin-top:8px">📊 أرسل لي تقرير الأسبوع الحين</button>' : ''}</div>
    <div class="card">${rows.map(x => `<div style="border-bottom:1px solid var(--line);padding:6px 0"><div class="row" style="justify-content:space-between"><b>${esc(r.types[x.type] || x.type)}${x.employee ? ' — ' + esc(x.employee) : ''}</b><span class="small muted">${esc(x.date)}</span></div>
      <div>${esc(x.summary)}</div><div class="small muted">كتبها ${esc(x.by_name || '')} · ${STEP[Math.min(x.step, 3)]}</div></div>`).join('') || '<p class="muted">ما فيه شي — الحمد لله 👌</p>'}</div>`;
  const go = (t, w) => { location.hash = `#/issues?${t ? 't=' + t + '&' : ''}${w ? 'w=' + encodeURIComponent(w) : ''}`; };
  $$('[data-it]', main).forEach(b => b.onclick = () => go(b.dataset.it, who));
  $$('[data-iw]', main).forEach(b => b.onclick = () => go(type, b.dataset.iw));
  const wk = $('#iwk'); if (wk) wk.onclick = e => busy(e.currentTarget, async () => { const x = await POST('/api/whatsapp/weekly', {}); toast(x.sent.length ? 'انرسل ✓' : 'سجّل جوالك أول (صفحة الموظفين)'); });
}

// 🧯 وش صار للعمال في البرنامج: طلّعه، رفض يحفظ (بالرسالة اللي شافها)، الصفحة رجعت وهو يجرد
async function pageAppLog(main, alive) {
  const r = await GET('/api/app-log?days=3');
  if (!alive()) return;
  const by = new Map(); for (const x of r.rows) { const k = x.who || 'ما نعرف (ما دخل)'; if (!by.has(k)) by.set(k, []); by.get(k).push(x); }
  const t = s => new Date(s.replace(' ', 'T') + 'Z').toLocaleString('ar-SA', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  main.innerHTML = `<div class="card"><h3>🧯 مشاكل البرنامج عند العمال <span class="small muted">(آخر ٣ أيام)</span></h3>
      <p class="small muted">كل مرة البرنامج طلّع واحد، أو رفض يحفظ له (والرسالة اللي طلعت له)، أو الصفحة رجعت من جديد وهو يجرد.</p></div>
    ${r.edits && r.edits.length ? `<div class="card"><h3>✏️ تعديلات الجرد <span class="small muted">(${r.edits.length})</span></h3>${r.edits.slice(0, 60).map(e => `<div class="small" style="border-bottom:1px solid var(--line);padding:3px 0"><b>${esc(e.who || '')}</b> — ${esc(e.item)} (${e.phase === 'closing' ? 'آخر' : 'أول'} الدوام ${esc(e.date)}): ${e.old ?? '—'} ← <b>${e.new ?? 'مسح'}</b> ${esc(e.unit || '')} <span class="muted">${t(e.at)}</span></div>`).join('')}</div>` : ''}
    ${[...by].map(([who, list]) => `<div class="card"><h3>${esc(who)} <span class="small muted">(${list.length})</span></h3>${list.slice(0, 40).map(x => `<div style="border-bottom:1px solid var(--line);padding:4px 0"><b>${esc(r.kinds[x.kind] || x.kind)}</b> <span class="small muted">${t(x.at)}</span><div class="small">${esc(x.msg)}</div></div>`).join('')}</div>`).join('') || '<div class="card"><p class="muted">ما فيه مشاكل مسجلة 👌</p></div>'}`;
}

async function pageExpenses(main, alive) {
  const list = isSup() ? await GET('/api/expenses') : [];
  if (!alive()) return;
  const photos = [];
  const EK = { restaurant: 'المطعم', home: '🧾 خاص', advance: '👤 سلفة' };
  const users = await usersList();
  if (!alive()) return;
  main.innerHTML = `<div class="card"><h3>تسجيل مصروف</h3>
      <div class="row"><label class="f">لمين؟<select id="eKind"><option value="restaurant">مصروف للمطعم</option><option value="home">🧾 مصروف خاص (مو من المطعم)</option><option value="advance">👤 سلفة لموظف</option></select></label>
      <label class="f" id="eEmpW" hidden>الموظف<select id="eEmp"><option value="">اختر</option>${users.filter(x => x.active && !x.bot).map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></label></div>
      <div class="row"><label class="f">المبلغ<input id="eAmt" inputmode="decimal"></label><label class="f grow">النوع<input id="eCat" list="ecats" placeholder="غاز، كهرباء، نقل…"></label>
      <label class="f">التاريخ<input type="date" id="eDate" value="${S.date}"></label>
      <label class="f" style="flex-direction:row;align-items:center;gap:6px;align-self:flex-end"><input type="checkbox" id="eCash" checked> من الدرج</label></div>
      <datalist id="ecats">${['غاز', 'كهرباء', 'ماء', 'نقل', 'صيانة', 'تنظيف', 'أكياس وعلب', 'إيجار', 'أخرى'].map(c => `<option value="${c}">`).join('')}</datalist>
      <label class="f" style="margin-top:8px">ملاحظة<input id="eNote"></label>
      <div style="margin-top:8px">${photoInputs('ex', false)}</div>
      <button class="btn primary" id="eSave" style="margin-top:10px">حفظ</button></div>
    ${isSup() ? `<div class="card"><h3>المصروفات (آخر ٣٠ يوم)</h3><div class="tbl-wrap"><table><thead><tr><th>التاريخ</th><th>النوع</th><th>ملاحظة</th><th>مين</th><th class="n">المبلغ</th><th></th></tr></thead><tbody>
      ${list.map(x => `<tr><td class="small">${x.date}</td><td>${x.kind === 'advance' ? `<span class="badge">${EK.advance}</span> ` : `<select data-ekind="${x.id}" style="width:auto;padding:2px 4px;font-size:12px"><option value="restaurant">للمطعم</option><option value="home" ${x.kind === 'home' ? 'selected' : ''}>🧾 خاص</option></select> `}${esc(x.category)}</td><td class="small">${esc(x.note)}${x.payment === 'custody' ? ' <span class="badge amber">من العهدة</span>' : x.payment === 'card' ? ' <span class="badge">💳 بطاقة</span>' : ''}</td><td class="small">${esc(x.user || '')}</td><td class="n">${money(x.amount)}</td>
        <td>${x.image ? `<img src="/uploads/${esc(x.image)}" data-img style="width:44px;height:44px;object-fit:cover;border-radius:6px;cursor:zoom-in">` : ''} <button class="btn small danger" data-del="${x.id}">حذف</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">ما فيه</td></tr>'}
      </tbody><tfoot><tr><td colspan="4">مصاريف المطعم</td><td class="n">${money(list.filter(x => !x.kind || x.kind === 'restaurant').reduce((s, x) => s + x.amount, 0))}</td><td></td></tr>
      ${list.some(x => x.kind === 'home') ? `<tr><td colspan="4">مصاريف خاصة</td><td class="n">${money(list.filter(x => x.kind === 'home').reduce((s, x) => s + x.amount, 0))}</td><td></td></tr>` : ''}</tfoot></table></div></div>` : ''}`;
  bindPhotos(main, 'ex', photos);
  $('#eKind').onchange = () => { const k = $('#eKind').value; $('#eEmpW').hidden = k !== 'advance'; $('#eCat').disabled = k !== 'restaurant'; };
  $('#eSave').onclick = e => busy(e.currentTarget, async () => {
    await POST('/api/expenses', { kind: $('#eKind').value, employee_id: $('#eEmp').value, amount: $('#eAmt').value, category: $('#eCat').value, note: $('#eNote').value, date: $('#eDate').value, paid_from_cash: $('#eCash').checked, image: photos[0] || '' });
    toast('انحفظ ✓'); route();
  });
  $$('[data-ekind]', main).forEach(sel => sel.onchange = () => busy(null, async () => { await PATCH('/api/expenses/' + sel.dataset.ekind, { kind: sel.value }); toast('تغيّر ✓'); route(); }));
  $$('[data-img]', main).forEach(img => img.onclick = () => showImage(img.src));
  $$('[data-del]', main).forEach(b => b.onclick = async () => { if (await confirmBox('تحذف المصروف؟')) busy(b, async () => { await DEL('/api/expenses/' + b.dataset.del); route(); }); });
}


// وصفة لكل نوع مع بعض (مثل مرسة: ساده / سمن / عسل): المكوّنات صفوف، والأنواع أعمدة، وفي كل خانة الكمية
// variants: [{ id, variant, lines: [{item_id, qty}] }]
function recipeMatrix(title, variants, items, onSaved, base) {
  const rows = [];
  const byItem = new Map();
  for (const v of variants) for (const l of (v.lines || [])) {
    if (!byItem.has(l.item_id)) { byItem.set(l.item_id, { item_id: l.item_id, q: {} }); rows.push(byItem.get(l.item_id)); }
    byItem.get(l.item_id).q[v.id] = l.qty;
  }
  // اقتراح لطبق جديد: الصنف الأساسي (لو معروف) واحد لكل الأنواع، واسم النوع نفسه صنف مخزون (سمن، عسل…) => سطر له
  if (!rows.length) {
    if (base) { byItem.set(base, { item_id: base, q: Object.fromEntries(variants.map(v => [v.id, 1])) }); rows.push(byItem.get(base)); }
    const norm = x => String(x || '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').trim();
    for (const v of variants) {
      const it = items.find(i => norm(i.name) === norm(v.variant) || norm(i.name).startsWith(norm(v.variant) + ' '));
      if (it && v.variant && !byItem.has(it.id)) { byItem.set(it.id, { item_id: it.id, q: {} }); rows.push(byItem.get(it.id)); }
    }
  }
  if (!rows.length) rows.push({ item_id: '', q: {} });
  modal(title, `<p class="muted small">كل سطر مكوّن من المخزون، وتحت كل نوع اكتب كم ينخصم منه لما ينباع واحد. اترك الخانة فاضية إذا النوع ما فيه هذا المكوّن.</p>
    <div class="tbl-wrap"><table class="matrix"><thead><tr><th>المكوّن</th>${variants.map(v => `<th class="n">${esc(v.variant || '—')}</th>`).join('')}<th></th></tr></thead><tbody id="mxBody"></tbody></table></div>
    <button class="btn small" id="mxAdd" style="margin-top:6px">+ مكوّن</button>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="mxSave">احفظ الوصفة</button><button class="btn" data-close>إلغاء</button></div>`, (m, close) => {
    const draw = () => {
      $('#mxBody', m).innerHTML = rows.map((r, i) => `<tr data-r="${i}"><td><select data-mi style="min-width:110px">${itemOptions(items, r.item_id, 'اختر المكوّن')}</select></td>
        ${variants.map(v => `<td><input class="qty" style="width:56px" inputmode="decimal" data-v="${v.id}" value="${r.q[v.id] ?? ''}"></td>`).join('')}
        <td><button class="btn small danger" data-rm="${i}">×</button></td></tr>`).join('');
      $$('[data-mi]', m).forEach(sel => sel.onchange = () => { rows[Number(sel.closest('[data-r]').dataset.r)].item_id = Number(sel.value) || ''; });
      $$('[data-v]', m).forEach(inp => inp.oninput = () => { rows[Number(inp.closest('[data-r]').dataset.r)].q[inp.dataset.v] = inp.value; });
      $$('[data-rm]', m).forEach(b => b.onclick = () => { rows.splice(Number(b.dataset.rm), 1); draw(); });
    };
    draw();
    $('#mxAdd', m).onclick = () => { rows.push({ item_id: '', q: {} }); draw(); };
    $('#mxSave', m).onclick = e => busy(e.currentTarget, async () => {
      const recipe = [];
      for (const r of rows) for (const v of variants) {
        const q = String(r.q[v.id] ?? '').replace('٫', '.').trim();
        if (!q) continue;
        if (!r.item_id) throw new Error('اختر المكوّن لكل سطر فيه كميات');
        recipe.push({ product_id: v.id, item_id: r.item_id, qty: q });
      }
      const empty = variants.filter(v => !recipe.some(x => x.product_id === v.id));
      if (empty.length && !await confirmBox(`هذي الأنواع ما لها ولا مكوّن: ${empty.map(v => v.variant || '—').join('، ')} — تحفظ كذا؟`)) return;
      await POST('/api/link', { action: 'recipe', lines: variants.map(v => ({ product_id: v.id })), recipe });
      close(); toast('انحفظت الوصفة ✓'); await onSaved();
    });
  });
}

// ===================== ربط لويفرس بالجرد =====================
// كل صنف في لويفرس لازم يعرف وش ينخصم منه في الجرد/المستودع — وإلا ما ينحسب النقص
async function pageLink(main, alive) {
  const [items, staffAll] = await Promise.all([itemsList(true), usersList()]);
  const staff = staffAll.filter(u => u.active && u.role !== 'purchaser');
  let showSkipped = false, groups = [], fixes = [];
  const load = async () => { [groups, fixes] = await Promise.all([GET('/api/link' + (showSkipped ? '?skipped=1' : '')), GET('/api/link/names')]); };
  await load();
  if (!alive()) return;
  const UNITS = ['حبة', 'كيلو', 'علبة', 'كرتون', 'لتر', 'صحن', 'حبة/قطعة'];
  const pct = s => Math.round(s * 100) + '%';
  const draw = () => {
    const strong = groups.filter(g => g.suggestion && g.suggestion.score >= 0.8 && !g.variants.every(v => v.skipped));
    main.innerHTML = `
    ${fixes.length ? `<div class="card" id="fixCard"><h3>أسماء مكتوبة غير عن لويفرس (${fixes.length})</h3>
      <p class="muted small">نفس الصنف بس الكتابة تختلف. «وحّد» يسمّي صنف المخزون بنفس كتابة لويفرس بالضبط — وبعدها الربط يصير لحاله.</p>
      <div class="tbl-wrap"><table><thead><tr><th></th><th>في المخزون</th><th>في لويفرس</th></tr></thead><tbody>
      ${fixes.map((f, i) => `<tr><td><input type="checkbox" data-fix="${i}" checked></td><td>${esc(f.name)}</td><td><b>${esc(f.loyverse)}</b></td></tr>`).join('')}
      </tbody></table></div>
      <div class="row" style="margin-top:8px"><button class="btn primary" id="fixGo">وحّد الأسماء المختارة</button></div></div>` : ''}
    <div class="card"><h3>ربط أصناف لويفرس بالجرد</h3>
      <p class="muted small">هذي أصناف البيع اللي ما تعرف للحين وش تسحب من المخزون — يعني لو انباعت ما ينخصم شي ولا يبان النقص. لكل صنف اختر:
      <b>ينسحب من</b> صنف مخزون موجود (والكمية مع كل بيعة)، أو <b>صنف جديد بنفس اسم لويفرس</b> (ينجرد هو نفسه)، أو <b>ما ينجرد</b> (مثل الخدمة والتوصيل).</p>
      <div class="row">
        ${strong.length ? `<button class="btn primary" id="lkAll">اربط المقترحات المطابقة (${strong.length})</button>` : ''}
        <button class="btn" id="lkSync">سحب الأصناف من لويفرس</button>
        <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="lkSk" ${showSkipped ? 'checked' : ''}> اعرض اللي «ما ينجرد»</label>
      </div></div>
    ${groups.map((g, gi) => {
      const sg = g.suggestion, skipped = g.variants.every(v => v.skipped);
      return `<div class="card" data-g="${gi}" ${skipped ? 'style="opacity:.6"' : ''}>
      <div class="row"><div class="grow"><span class="item-name">${esc(g.name)}</span> <span class="muted small">${esc(g.category)}${g.sold ? ` · انباع ${qtyFmt(g.sold)} آخر ٣٠ يوم` : ''}</span></div>
        ${skipped ? '<span class="badge">ما ينجرد</span>' : sg ? `<span class="badge ${sg.score >= 0.8 ? 'green' : 'amber'}">مقترح: ${esc(sg.name)} ${pct(sg.score)}</span>` : '<span class="badge red">ما لقيت له اسم مطابق</span>'}</div>
      <div class="tbl-wrap"><table><thead><tr><th>النوع</th><th class="n">السعر</th><th class="n">انباع</th><th>ينخصم مع كل بيعة</th></tr></thead><tbody>
        ${g.variants.map(v => `<tr><td>${esc(v.variant || '—')}</td><td class="n">${money(v.price)}</td><td class="n">${qtyFmt(v.sold)}</td>
          <td><input class="qty" data-v="${v.id}" inputmode="decimal" value="1"> <span class="small muted" data-u></span></td></tr>`).join('')}
      </tbody></table></div>
      ${skipped ? `<div class="row" style="margin-top:6px"><button class="btn small" data-unskip>رجّعه للربط</button></div>` : `
      <div class="row" style="margin-top:6px">
        <select data-item class="grow">${itemOptions(items, sg ? sg.item_id : '', 'ينسحب من صنف المخزون…')}</select>
        <button class="btn primary" data-link>اربط</button></div>
      <div class="row" style="margin-top:6px">
        <button class="btn small" data-mx>🍽 طبق له مقادير (وصفة لكل نوع)</button>
        <button class="btn small" data-new>+ صنف جديد بنفس اسم لويفرس</button>
        <button class="btn small" data-skip>ما ينجرد</button></div>
      <div data-newbox hidden style="margin-top:8px;border-top:1px dashed var(--line);padding-top:8px">
        <div class="row"><input class="grow" data-nn value="${esc(g.name)}" placeholder="اسم الصنف">
          <select data-nu style="width:auto">${UNITS.map(x => `<option ${x === g.unit ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
        <div class="row" style="margin-top:6px">
          <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-nd checked> ينجرد يوميًا (أول وآخر اليوم)</label>
          <select data-ns style="width:auto"><option value="">مين مسؤول عنه؟</option>${staff.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>
          <button class="btn primary small" data-nsave>أضفه واربطه</button></div>
        <p class="muted small" style="margin:4px 0 0">ينضاف في «أصناف المخزون»، وتقدر بعدين تحدد مين يجرده أول وآخر اليوم.</p></div>`}
    </div>`; }).join('') || '<div class="card muted">كل أصناف لويفرس مربوطة بالجرد 👍</div>'}`;

    const unitOf = id => (items.find(i => i.id === Number(id)) || {}).unit || '';
    $$('[data-g]', main).forEach(box => {
      const g = groups[Number(box.dataset.g)];
      const lines = () => $$('[data-v]', box).map(i => ({ product_id: Number(i.dataset.v), qty: i.value }));
      const sel = $('[data-item]', box);
      const showUnit = u => $$('[data-u]', box).forEach(s => s.textContent = u);
      if (sel) { showUnit(unitOf(sel.value)); sel.onchange = () => showUnit(unitOf(sel.value)); }
      const done = async msg => { toast(msg); S.cache.items = null; await load(); draw(); };
      const b = sel => $(sel, box);
      if (b('[data-link]')) b('[data-link]').onclick = e => busy(e.currentTarget, async () => {
        if (!sel.value) throw new Error('اختر صنف المخزون');
        await POST('/api/link', { action: 'item', item_id: sel.value, lines: lines() });
        await done(`${g.name} ← ${sel.selectedOptions[0].textContent.trim()} ✓`);
      });
      if (b('[data-mx]')) b('[data-mx]').onclick = () => recipeMatrix(`وصفة ${g.name}`, g.variants.map(v => ({ id: v.id, variant: v.variant, lines: [] })), items, async () => { await load(); draw(); }, g.suggestion && g.suggestion.item_id);
      if (b('[data-new]')) b('[data-new]').onclick = () => { b('[data-newbox]').hidden = !b('[data-newbox]').hidden; showUnit(b('[data-nu]').value); };
      if (b('[data-nu]')) b('[data-nu]').onchange = e => showUnit(e.target.value);
      if (b('[data-nsave]')) b('[data-nsave]').onclick = e => busy(e.currentTarget, async () => {
        if (b('[data-nd]').checked && !b('[data-ns]').value) throw new Error('اختر مين مسؤول عنه — عشان يطلع له في الجرد');
        const r = await POST('/api/link', { action: 'new', name: b('[data-nn]').value, unit: b('[data-nu]').value, daily: b('[data-nd]').checked, lines: lines() });
        if (b('[data-nd]').checked) await POST('/api/responsibility', { item_id: r.item_id, user_id: b('[data-ns]').value });
        await done(`انضاف «${b('[data-nn]').value}» للمخزون وانربط ✓`);
      });
      if (b('[data-skip]')) b('[data-skip]').onclick = e => busy(e.currentTarget, async () => { await POST('/api/link', { action: 'skip', lines: lines() }); await done('تمام — ما ينجرد'); });
      if (b('[data-unskip]')) b('[data-unskip]').onclick = e => busy(e.currentTarget, async () => { await POST('/api/link', { action: 'unskip', lines: lines() }); await done('رجع للربط'); });
    });
    const all = $('#lkAll');
    if (all) all.onclick = e => busy(e.currentTarget, async () => {
      if (!await confirmBox(`يربط ${strong.length} صنف بالمقترح (كمية 1 مع كل بيعة):\n${strong.map(g => g.name + ' ← ' + g.suggestion.name).join('، ')}`)) return;
      for (const g of strong) await POST('/api/link', { action: 'item', item_id: g.suggestion.item_id, lines: g.variants.map(v => ({ product_id: v.id, qty: 1 })) });
      await done(`انربط ${strong.length} صنف ✓`);
    });
    const fg = $('#fixGo');
    if (fg) fg.onclick = e => busy(e.currentTarget, async () => {
      const pick = $$('[data-fix]', main).filter(c => c.checked).map(c => fixes[Number(c.dataset.fix)]);
      if (!pick.length) throw new Error('اختر صنف');
      const r = await POST('/api/link/rename', { items: pick.map(f => ({ item_id: f.item_id, name: f.loyverse })) });
      S.cache.items = null; items.splice(0, items.length, ...await itemsList(true));
      toast(`توحّد ${r.renamed} اسم ✓`); await load(); draw();
    });
    $('#lkSync').onclick = e => busy(e.currentTarget, async () => { const r = await POST('/api/sync', {}); toast(r.message || 'تم', r.ok === false); await load(); draw(); });
    $('#lkSk').onchange = e => busy(null, async () => { showSkipped = e.target.checked; await load(); draw(); });
  };
  const done = async msg => { toast(msg); await load(); draw(); };
  draw();
}

// ===================== الوصفات =====================
async function pageRecipes(main, alive) {
  const [products, items, rules, unlinked] = await Promise.all([productsList(true), itemsList(), GET('/api/note-rules'), GET('/api/link').catch(() => [])]);
  if (!alive()) return;
  let q = sessionStorage.getItem('recQ') || '', filter = new URLSearchParams(location.hash.split('?')[1] || '').get('f') || sessionStorage.getItem('recF') || 'all';
  const open = new Set();
  main.innerHTML = `
    ${unlinked.length ? `<div class="alert amber"><b>${unlinked.length} صنف من لويفرس ما يعرف وش ينخصم</b> — <a href="#/link">اربطها هنا</a></div>` : ''}
    <div class="card no-print"><div class="row">
      <input class="grow" id="rq" placeholder="ابحث عن صنف…" value="${esc(q)}">
      <select id="rf" style="width:auto"><option value="all">الكل</option><option value="none">بدون وصفة</option><option value="draft">مبدئية</option><option value="ok">جاهزة</option></select>
      <button class="btn" id="rSync">سحب الأصناف من لويفرس</button></div>
      <p class="muted small" style="margin-bottom:0">أصناف البيع تجي من لويفرس بس. الوصفة تاخذ من أصناف المخزون (اللي تشتريها/تحضّرها)، والكميات تقبل كسور (0.4 كيلو مثلاً). المكوّن اللي ينجرد يوميًا ينخصم من الجرد، وغيره ينخصم من المستودع — لحاله.</p></div>
    <div id="rList"></div>
    <div class="card"><h3>قواعد الملاحظات</h3><p class="muted small">مثال: الملاحظة فيها "عسل بس" على المرسة ← تسحب العسل بس من الوصفة.</p>
      <div class="tbl-wrap"><table><tbody>${rules.map(r => `<tr><td>${esc(r.product ? r.product + (r.variant ? ' ' + r.variant : '') : 'كل الأصناف')}</td><td>"${esc(r.keyword)}"</td><td class="small">يسحب بس: ${r.only.map(id => esc(items.find(i => i.id === id)?.name || id)).join('، ')}</td><td><button class="btn small danger" data-rdel="${r.id}">حذف</button></td></tr>`).join('') || '<tr><td class="muted">ما فيه</td></tr>'}</tbody></table></div>
      <div class="row" style="margin-top:8px"><select id="nrP" class="grow"><option value="">كل الأصناف</option>${products.map(p => `<option value="${p.id}">${esc(p.name)}${p.variant ? ' — ' + esc(p.variant) : ''}</option>`).join('')}</select>
        <input id="nrK" class="grow" placeholder="كلمة الملاحظة (عسل بس)"><select id="nrI" class="grow">${itemOptions(items, '', 'يسحب بس هذا الصنف')}</select><button class="btn primary" id="nrAdd">إضافة</button></div></div>`;
  $('#rf').value = filter;
  const drawList = () => {
    const nq = q.trim();
    const shown = products.filter(p => (filter === 'all' || p.recipe_status === filter || (filter === 'none' && !p.lines.length)) && (!nq || (p.name + ' ' + p.variant + ' ' + p.category).includes(nq)));
    $('#rList').innerHTML = groupBy(shown, p => p.category || 'بدون فئة').map(([cat, ps]) => `<div class="card"><h3>${esc(cat)}</h3>${ps.map(p => `
      <div style="border-bottom:1px solid var(--line);padding:8px 0" data-p="${p.id}">
        <div class="row" style="cursor:pointer" data-toggle>
          <div class="grow"><span class="item-name">${esc(p.name)}</span>${p.variant ? ` <span class="badge">${esc(p.variant)}</span>` : ''}
            <span class="muted small"> · بيع ${money(p.price)} · تكلفة ${money(p.cost)}</span></div>
          ${p.recipe_status === 'ok' ? '<span class="badge green">جاهزة</span>' : p.recipe_status === 'draft' ? '<span class="badge amber">مبدئية</span>' : p.recipe_status === 'skip' ? '<span class="badge">ما ينجرد</span>' : '<span class="badge red">بدون وصفة</span>'}
        </div>
        ${open.has(p.id) ? recipeEditor(p) : ''}
      </div>`).join('')}</div>`).join('') || '<div class="card muted">ما فيه أصناف — حط رمز لويفرس في الإعدادات واسحب</div>';
    $$('[data-toggle]', $('#rList')).forEach(t => t.onclick = () => { const id = Number(t.closest('[data-p]').dataset.p); open.has(id) ? open.delete(id) : open.add(id); drawList(); });
    $$('[data-p]', $('#rList')).forEach(box => bindEditor(box, products.find(p => p.id === Number(box.dataset.p))));
  };
  const recipeEditor = p => `<div style="padding:8px 0 4px">
    <div class="tbl-wrap"><table><thead><tr><th>المكوّن (من المخزون)</th><th>الكمية</th><th>ينخصم من</th><th class="n">التكلفة</th><th></th></tr></thead><tbody>
    ${p.lines.map(l => `<tr data-l="${l.id}"><td><select data-lf="item_id">${itemOptions(items, l.item_id)}</select></td>
      <td><input class="qty" data-lf="qty" inputmode="decimal" value="${l.qty}"> <span class="small muted">${esc(l.unit || '')}</span></td>
      <td class="small">${l.source === 'floor' ? 'الجرد اليومي' : 'المستودع'}</td>
      <td class="n">${money(l.cost)}</td><td><button class="btn small danger" data-ldel="${l.id}">حذف</button></td></tr>`).join('')}
    <tr class="no-print"><td><select data-new="item_id">${itemOptions(items)}</select></td><td><input class="qty" data-new="qty" inputmode="decimal" placeholder="0.4"></td>
      <td class="small muted">لحاله</td><td></td><td><button class="btn small primary" data-ladd>إضافة</button></td></tr>
    </tbody></table></div>
    <div class="row" style="margin-top:6px">
      ${p.recipe_status !== 'ok' && p.lines.length ? '<button class="btn small primary" data-ok>اعتمد الوصفة</button>' : ''}
      ${products.filter(x => (x.loyverse_item_id || x.name) === (p.loyverse_item_id || p.name)).length > 1 ? `<button class="btn small" data-mx>كل أنواع «${esc(p.name)}» مع بعض</button>` : ''}
      <select data-copy style="width:auto"><option value="">نسخ وصفة من…</option>${products.filter(x => x.id !== p.id && x.lines.length).map(x => `<option value="${x.id}">${esc(x.name)}${x.variant ? ' — ' + esc(x.variant) : ''}</option>`).join('')}</select>
    </div></div>`;
  const reload = async () => { const fresh = await productsList(true); products.splice(0, products.length, ...fresh); drawList(); };
  const bindEditor = (box, p) => {
    if (!open.has(p.id)) return;
    $$('[data-lf]', box).forEach(inp => inp.onchange = () => busy(null, async () => {
      const tr = inp.closest('[data-l]');
      await PATCH('/api/recipe-lines/' + tr.dataset.l, { [inp.dataset.lf]: inp.value });
      toast('انحفظ ✓'); await reload();
    }));
    $$('[data-ldel]', box).forEach(b => b.onclick = () => busy(b, async () => { await DEL('/api/recipe-lines/' + b.dataset.ldel); await reload(); }));
    const add = $('[data-ladd]', box);
    if (add) add.onclick = () => busy(add, async () => {
      await POST('/api/recipe-lines', { product_id: p.id, item_id: $('[data-new="item_id"]', box).value, qty: $('[data-new="qty"]', box).value.replace('٫', '.') });
      await reload();
    });
    const mx = $('[data-mx]', box);
    if (mx) mx.onclick = () => recipeMatrix(`وصفة ${p.name}`, products.filter(x => (x.loyverse_item_id || x.name) === (p.loyverse_item_id || p.name))
      .map(x => ({ id: x.id, variant: x.variant, lines: x.lines })), items, reload);
    const ok = $('[data-ok]', box); if (ok) ok.onclick = () => busy(ok, async () => { await POST(`/api/products/${p.id}/status`, { status: 'ok' }); await reload(); });
    const cp = $('[data-copy]', box); if (cp) cp.onchange = () => cp.value && busy(null, async () => { await POST(`/api/products/${p.id}/copy-recipe`, { from: Number(cp.value) }); await reload(); });
  };
  $('#rq').oninput = e => { q = e.target.value; sessionStorage.setItem('recQ', q); drawList(); };
  $('#rf').onchange = e => { filter = e.target.value; sessionStorage.setItem('recF', filter); drawList(); };
  $('#rSync').onclick = e => busy(e.currentTarget, async () => { const r = await POST('/api/sync', {}); toast(r.message || 'تم', r.ok === false); await reload(); });
  $('#nrAdd').onclick = e => busy(e.currentTarget, async () => { await POST('/api/note-rules', { product_id: $('#nrP').value, keyword: $('#nrK').value, only: [$('#nrI').value].filter(Boolean) }); route(); });
  $$('[data-rdel]', main).forEach(b => b.onclick = () => busy(b, async () => { await DEL('/api/note-rules/' + b.dataset.rdel); route(); }));
  drawList();
}

// ===================== أصناف المخزون =====================
// kind: raw = أصناف المستودع (اللي ينشرى) | prepared = التحضير (اللي يتسوى في المحل)
// دمج: «كل أنواع البيبسي = بيبسي» — يجردونها رقم واحد، والوصفات والمشتريات تصير عليه
function mergeInto(it, all_) {
  const pick = new Set();
  const cand = all_.filter(x => x.id !== it.id && x.active !== 0 && (x.unit === it.unit || x.section_id === it.section_id))
    .sort((a, b) => (b.section_id === it.section_id) - (a.section_id === it.section_id));
  modal(`🔗 ادمج في «${it.name}»`, `<p class="small muted">اختر الأصناف اللي تصير «${esc(it.name)}» — يجردونها كلها رقم واحد، ومبيعاتها ومشترياتها تنخصم وتنضاف عليه. الجرد اللي فات ينجمع.</p>
    <div style="max-height:50vh;overflow:auto">${cand.map(x => `<label style="display:flex;gap:8px;align-items:center;padding:8px;border-bottom:1px solid var(--line)"><input type="checkbox" data-mg="${x.id}"> <b>${esc(x.name)}</b> <span class="small muted">${esc(x.unit)}</span></label>`).join('') || '<p class="muted">ما فيه</p>'}</div>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="mgOk">ادمج</button><button class="btn" data-close>إلغاء</button></div>`, (m, close) => {
    $$('[data-mg]', m).forEach(c => c.onchange = () => { c.checked ? pick.add(Number(c.dataset.mg)) : pick.delete(Number(c.dataset.mg)); });
    $('#mgOk', m).onclick = e => busy(e.currentTarget, async () => {
      if (!pick.size) throw new Error('اختر صنف واحد على الأقل');
      const names = cand.filter(x => pick.has(x.id)).map(x => x.name).join('، ');
      if (!await confirmBox(`${names} — كلها تصير «${it.name}»؟ ما ترجع بسهولة.`)) return;
      const r = await POST(`/api/items/${it.id}/merge`, { from_ids: [...pick] });
      S.cache.items = null; close(); toast(`✓ صارت كلها «${r.target}»`); route();
    });
  });
}
async function pageItems(main, alive, kind = 'raw') {
  const [all_, sections, users] = await Promise.all([itemsList(true), GET('/api/sections'), usersList()]);
  if (!alive()) return;
  const items = all_.filter(i => i.kind === kind);
  const respOf = i => i.closing_user_id || (sections.find(s => s.id === i.section_id) || {}).closing_user_id || '';
  const uName = id => (users.find(u => u.id === id) || {}).name || '';
  // المستودع: ① مستودع (أسبوعي) / ② طازج (من الشراء للجرد، هالك) / يومي يتخزن. التحضير: حسب المسؤول عنه
  const groupOf = kind === 'prepared'
    ? i => (!i.daily ? 'ما ينجرد يوميًا' : uName(respOf(i)) ? 'مسؤول: ' + uName(respOf(i)) : 'بدون مسؤول')
    : i => (!i.daily ? '① المستودع — ينجرد مرة بالأسبوع' : !i.carry_over ? '② الطازج — يدخل الجرد من الشراء على طول، والباقي هالك' : 'يومي ويتخزن (مشروبات وغيرها)');
  items.sort((a, b) => groupOf(a).localeCompare(groupOf(b), 'ar'));
  main.innerHTML = `<div class="row no-print" style="margin-bottom:10px"><button class="btn primary" id="iNew">${kind === 'prepared' ? '+ صنف تحضير' : '+ صنف مستودع'}</button></div>
    ${groupBy(items, groupOf).map(([sec, list]) => `<div class="card"><h3>${esc(sec)}</h3><div class="tbl-wrap"><table><thead><tr><th>الصنف</th><th>الوحدة</th><th>النوع</th><th class="n">سعر الشراء</th><th class="n">قيمة البيع</th><th>الجرد</th><th></th></tr></thead><tbody>
      ${list.map(i => `<tr><td class="item-name">${esc(i.name)}${i.note ? `<div class="item-note">${esc(i.note)}</div>` : ''}${i.components.length ? `<div class="item-note">من: ${i.components.map(c => `${esc(c.component)} ${c.qty}`).join('، ')}</div>` : ''}${i.units && i.units.length ? `<div class="item-note">الشراء: ${i.units.map(x => `${esc(x.name)} = ${qtyFmt(x.factor)} ${esc(i.unit)}`).join('، ')}</div>` : ''}</td>
        <td>${esc(i.unit)}</td><td>${i.kind === 'prepared' ? 'محضّر' : 'يُشترى'}</td><td class="n">${money(i.unit_cost)}</td><td class="n">${money(i.sale_value)}</td>
        <td class="small">${i.daily ? (uName(respOf(i)) ? 'عند ' + esc(uName(respOf(i))) : '<span class="pos">بدون مسؤول</span>') : 'مستودع'}${i.carry_over ? '' : ' · هالك'}</td>
        <td><button class="btn small" data-edit="${i.id}">تعديل</button></td></tr>`).join('')}
    </tbody></table></div></div>`).join('')}`;
  const edit = it => {
    it = it || { name: '', unit: 'حبة', kind, cost: 0, sale_value: 0, carry_over: 1, daily: 1, components: [], note: '' };
    let comps = (it.components || []).map(c => ({ component_id: c.component_id, qty: c.qty }));
    const units = (it.units || []).map(x => ({ name: x.name, factor: x.factor }));
    modal(it.id ? 'تعديل صنف' : 'صنف جديد', `
      <div class="row"><label class="f grow">الاسم<input data-k="name" value="${esc(it.name)}"></label><label class="f">الوحدة<input data-k="unit" list="units" value="${esc(it.unit)}"></label></div>
      <datalist id="units">${['كجم', 'جرام', 'حبة', 'علبة', 'كرتون', 'لتر', 'صحن', 'قرورة', 'دبة', 'ربطة'].map(u => `<option value="${u}">`).join('')}</datalist>
      <div class="row" ${onlyPurch() ? 'hidden' : ''}><label class="f grow">المسؤول عنه (يجرده والنقص عليه)<select id="iResp"><option value="">—</option>${users.filter(u => u.active && u.role !== 'purchaser').map(u => `<option value="${u.id}" ${u.id === respOf(it) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
        <label class="f">النوع<select data-k="kind"><option value="raw">يُشترى</option><option value="prepared" ${it.kind === 'prepared' ? 'selected' : ''}>محضّر</option></select></label></div>
      <div class="row" ${onlyPurch() ? 'hidden' : ''}><label class="f">سعر الشراء للوحدة<input data-k="cost" inputmode="decimal" value="${it.cost || ''}"></label><label class="f">قيمة البيع للوحدة (للنقص)<input data-k="sale_value" inputmode="decimal" value="${it.sale_value || ''}"></label>
        <label class="f">تكلفة إضافية للوحدة (غاز…)<input data-k="extra_cost" inputmode="decimal" value="${it.extra_cost || ''}"></label></div>
      <label class="f" ${onlyPurch() ? 'hidden' : ''}>⚡ طريقة الجرد (اختيار سريع)<select id="iPreset">
        <option value="">— مخصص (زي ما هو تحت) —</option>
        <option value="fish">🐟 يدخل بالشراء على طول، ويتجرد آخر اليوم بس، والباقي يقعد (السمك)</option>
        <option value="cooked">🍲 ينطبخ أول اليوم (يكتب كم انطبخ)، والباقي آخر اليوم يترمى (الفتة، الإيدام)</option>
        <option value="stays">🥗 يقعد لبكرة، ولما يسوي زيادة «+ أضفت»، وآخر اليوم يجرد الباقي (السحاوق، السلطات)</option>
        <option value="store">🥤 المستودع فوق، والثلاجة تنملى بـ«+ أضفت من فوق»، وآخر اليوم يجرد الثلاجة (البيبسي)</option></select></label>
      <div class="row" style="margin:8px 0" ${onlyPurch() ? 'hidden' : ''}>
        <label class="f grow">وين ينجرد؟<select id="iType">
          <option value="store" ${!it.daily ? 'selected' : ''}>① المستودع — ينجرد مرة بالأسبوع</option>
          <option value="fresh" ${it.daily && (it.leftover === 'waste' || (!it.leftover && !it.carry_over)) ? 'selected' : ''}>${kind === 'prepared' ? 'يومي — الباقي آخر اليوم ينرمى' : '② طازج — يدخل الجرد من الشراء، والباقي ينرمى'}</option>
          <option value="keep" ${it.daily && (it.leftover === 'stay' || (!it.leftover && it.carry_over)) ? 'selected' : ''}>يومي — الباقي يقعد مكانه لبكرة</option>
          <option value="fridge" ${it.daily && it.leftover === 'fridge' ? 'selected' : ''}>يومي — الباقي يطلع الثلاجة فوق لحاله، وينزل الصبح (برم، حنيذ…)</option>
          <option value="fridge_added" ${it.daily && it.leftover === 'fridge_added' ? 'selected' : ''}>يومي — اللي ينضاف وسط اليوم يطلع الثلاجة، وطبخة الصبح ينرمى باقيها (مطفي)</option></select></label>
        <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-k="count_only" ${it.count_only ? 'checked' : ''}> 🔢 ينعد آخر الليل بس (المحل + فوق) — العامل ما عنده «أضفت»، والشراء يدخل على طول</label>
        <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-k="morning_only" ${it.morning_only ? 'checked' : ''}> 🌅 ينجرد الصبح بس — اللي يسويه يأكد الكمية الصبح، وما ينجرد بالليل</label>
        <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-k="no_opening" ${it.no_opening ? 'checked' : ''}> ما يحتاج جرد أول اليوم (يبدأ من آخر أمس أو الشراء)</label>
        <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-k="buy_store" ${it.buy_store ? 'checked' : ''}> الشراء يروح المستودع فوق، والمحل ياخذ منه بـ«+ أضفت»</label>
        <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-k="need_photo" ${it.need_photo ? 'checked' : ''}> 📷 يحتاج صورة للباقي آخر الدوام</label>
        <label class="f" style="max-width:260px">⚖️ وزن القارورة/الوعاء الفاضي (لو يوزنونه معها) — ينطرح لحاله<input data-k="tare" inputmode="decimal" value="${it.tare || ''}" placeholder="0"></label>
        <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-k="pull_on_open" ${it.pull_on_open ? 'checked' : ''}> يتجهّز أو ينسحب أول اليوم ويدخلونه في جرد أول اليوم (الزيادة عن آخر أمس: الخام ينخصم من المستودع، والمحضّر تنخصم مكوناته)</label></div>
      <div class="row" style="gap:8px;align-items:flex-end;margin:6px 0"><label class="f" style="max-width:130px">الأيقونة (إيموجي)<input data-k="icon" value="${esc(it.icon || '')}" placeholder="🐟" style="font-size:22px;text-align:center"></label>
        ${it.id ? `<span id="iPhotoBox">${it.photo ? `<img src="/uploads/${esc(it.photo)}" class="item-ico" style="width:48px;height:48px">` : ''}</span><label class="btn small">📷 صورة الصنف<input type="file" accept="image/*" id="iPhoto" hidden></label>${it.photo ? '<button class="btn small danger" id="iPhotoDel">✕</button>' : ''}` : ''}</div>
      <label class="f">ملاحظة / طريقة الشغل (المساعد يقرأها عشان يفهم العامل — مثل «ينزل كراتين، كل ما تفك كرتون قل كم حبة»)<input data-k="note" value="${esc(it.note)}"></label>
      <label class="f" ${onlyPurch() || !it.daily ? 'hidden' : ''}>جرد آخر اليوم على أجزاء (اختياري) — مثل «كامل، مقطّع×1.25» أو «ني، مستوي يترمى»<input data-k="parts_text" value="${esc((C_parts(it.parts) || []).map(p => p.name + (p.factor !== 1 ? '×' + p.factor : '') + (p.drop ? ' يترمى' : '')).join('، '))}"></label>
      <div style="margin-top:10px"><b class="small">${it.kind === 'prepared' ? `وحدات التحضير (مثل الرز: «كيلو ني» = 2.5 ${esc(it.unit)} مطبوخ، «مكيال» = …)` : `وحدات الشراء (مثل: كرتون = 24 ${esc(it.unit)})`}</b><div id="units"></div><button class="btn small" id="uAdd">+ وحدة</button></div>
      <div style="margin-top:10px" ${onlyPurch() ? 'hidden' : ''}><b class="small">وصفة التحضير (للمحضّر — تسحب من المستودع لكل ١ ${esc(it.unit)})</b><div id="comps"></div><button class="btn small" id="cAdd">+ مكوّن</button></div>
      <div style="margin-top:10px" ${onlyPurch() || !it.daily ? 'hidden' : ''}><b class="small">يجي من (لما يضيفون منه «+ أضفت» يسألهم «من فين؟») — مثل البرم من السهوم: كم ${esc(it.unit)} من الواحد</b><div id="srcs"></div><button class="btn small" id="sAdd">+ مصدر</button></div>
      <div class="row" style="margin-top:14px"><button class="btn primary" id="iSave">حفظ</button><button class="btn" data-close>إلغاء</button>${it.id && isPurch() ? '<button class="btn danger" id="iDel">حذف الصنف</button>' : ''}${it.id && isSup() ? '<button class="btn" id="iMerge">🔗 ادمج فيه أصناف</button>' : ''}</div>`, (m, close) => {
      const drawC = () => {
        $('#comps', m).innerHTML = comps.map((c, i) => `<div class="row" data-ci="${i}" style="margin-top:6px"><select class="grow" data-cf="component_id">${itemOptions(all_.filter(x => x.id !== it.id), c.component_id)}</select><input class="qty" data-cf="qty" inputmode="decimal" value="${c.qty || ''}"><button class="btn small danger" data-crm="${i}">×</button></div>`).join('');
        $$('[data-cf]', m).forEach(inp => inp.onchange = () => { comps[Number(inp.closest('[data-ci]').dataset.ci)][inp.dataset.cf] = inp.value; });
        $$('[data-crm]', m).forEach(b => b.onclick = () => { comps.splice(Number(b.dataset.crm), 1); drawC(); });
      };
      drawC();
      // ⚡ اختيار سريع: يضبط الإعدادات تحت
      const pre = $('#iPreset', m);
      if (pre) pre.onchange = () => {
        const P = { fish: ['keep', 1, 0, 0], cooked: ['fresh', 0, 1, 0], stays: ['keep', 1, 0, 0], store: ['keep', 1, 0, 1] }[pre.value]; if (!P) return;
        $('#iType', m).value = P[0];
        $('[data-k="no_opening"]', m).checked = !!P[1]; $('[data-k="pull_on_open"]', m).checked = !!P[2]; $('[data-k="buy_store"]', m).checked = !!P[3];
      };
      $('#cAdd', m).onclick = () => { comps.push({ component_id: '', qty: '' }); drawC(); };
      const srcs = (it.sources || []).map(x => ({ from_item_id: x.from_item_id, ratio: x.ratio }));
      const drawS = () => {
        $('#srcs', m).innerHTML = srcs.map((c, i) => `<div class="row" data-si="${i}" style="margin-top:6px"><span class="small">من</span><select class="grow" data-sf="from_item_id">${itemOptions(all_.filter(x => x.id !== it.id && x.daily), c.from_item_id)}</select><span class="small">الواحد =</span><input class="qty" data-sf="ratio" inputmode="decimal" value="${c.ratio || 1}"><button class="btn small danger" data-srm="${i}">×</button></div>`).join('');
        $$('[data-sf]', m).forEach(inp => inp.onchange = () => { srcs[Number(inp.closest('[data-si]').dataset.si)][inp.dataset.sf] = inp.value; });
        $$('[data-srm]', m).forEach(b => b.onclick = () => { srcs.splice(Number(b.dataset.srm), 1); drawS(); });
      };
      drawS();
      $('#sAdd', m).onclick = () => { srcs.push({ from_item_id: '', ratio: 1 }); drawS(); };
      const drawU = () => {
        $('#units', m).innerHTML = units.map((x, i) => `<div class="row" data-ui="${i}" style="margin-top:6px"><input class="grow" data-uf="name" placeholder="كرتون" value="${esc(x.name)}">
          <span class="small muted">=</span><input class="qty" data-uf="factor" inputmode="decimal" value="${x.factor || ''}"><span class="small muted">${esc(it.unit || 'وحدة')}</span><button class="btn small danger" data-urm="${i}">×</button></div>`).join('');
        $$('[data-uf]', m).forEach(inp => inp.oninput = () => { units[Number(inp.closest('[data-ui]').dataset.ui)][inp.dataset.uf] = inp.value; });
        $$('[data-urm]', m).forEach(b => b.onclick = () => { units.splice(Number(b.dataset.urm), 1); drawU(); });
      };
      drawU();
      $('#uAdd', m).onclick = () => { units.push({ name: '', factor: '' }); drawU(); };
      const ph = $('#iPhoto', m);
      if (ph) ph.onchange = async () => { const f = ph.files[0]; if (!f) return; const image = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
        const r = await PUT(`/api/items/${it.id}/photo`, { image }); $('#iPhotoBox', m).innerHTML = `<img src="/uploads/${esc(r.photo)}" class="item-ico" style="width:48px;height:48px">`; toast('انحفظت الصورة ✓'); };
      const pd = $('#iPhotoDel', m); if (pd) pd.onclick = async () => { await PUT(`/api/items/${it.id}/photo`, { image: '' }); $('#iPhotoBox', m).innerHTML = ''; pd.remove(); toast('انشالت ✓'); };
      $('#iSave', m).onclick = e => busy(e.currentTarget, async () => {
        const body = { id: it.id };
        $$('[data-k]', m).forEach(inp => { body[inp.dataset.k] = inp.type === 'checkbox' ? inp.checked : inp.value; });
        if ('parts_text' in body) { body.parts = body.parts_text; delete body.parts_text; }
        // اختيار واحد بدل علامتين: مستودع / طازج (هالك) / يومي يقعد لبكرة
        const t = $('#iType', m).value;
        body.daily = t !== 'store'; body.carry_over = t !== 'fresh';
        body.leftover = { fresh: 'waste', keep: 'stay', fridge: 'fridge', fridge_added: 'fridge_added', store: 'stay' }[t];
        if (!onlyPurch()) body.sources = srcs.filter(x => x.from_item_id);
        const r = await POST('/api/items', body);
        if (!onlyPurch()) await PUT(`/api/items/${r.id}/components`, { components: comps });
        // المسؤول: يتسجل في «عهدته» (للأصناف اللي تنجرد يوميًا)
        const resp = $('#iResp', m);
        if (!onlyPurch() && body.daily && resp && String(resp.value) !== String(respOf(it))) await POST('/api/responsibility', { item_id: r.id, user_id: resp.value || null });
        await PUT(`/api/items/${r.id}/units`, { units });
        S.cache.items = null; close(); toast('انحفظ ✓'); route();
      });
      const mg = $('#iMerge', m);
      if (mg) mg.onclick = () => { close(); mergeInto(it, all_); };
      const del = $('#iDel', m);
      if (del) del.onclick = async () => { if (await confirmBox(`تحذف "${it.name}"؟ بينشال من الوصفات.`)) busy(del, async () => { await DEL('/api/items/' + it.id); S.cache.items = null; close(); route(); }); };
    });
  };
  $('#iNew').onclick = () => edit(null);
  $$('[data-edit]', main).forEach(b => b.onclick = () => edit(items.find(i => i.id === Number(b.dataset.edit))));
}

// ===================== الأقسام والموظفين =====================
async function pageStaff(main, alive) {
  S.cache.users = null;
  const [resp, users] = await Promise.all([GET('/api/responsibility'), usersList()]);
  if (!alive()) return;
  const { items } = resp;
  const staff = resp.users;
  const uName = id => users.find(u => u.id === id)?.name || '—';
  const itemOpt = (list, label) => `<option value="">${label}</option>` + list.map(i => `<option value="${i.id}">${esc(i.name)}${i.user_id ? ` — عند ${esc(uName(i.user_id))}` : ''}</option>`).join('');
  const nobody = items.filter(i => !i.user_id);
  main.innerHTML = `
    <div class="card"><h3>المسؤوليات — كل موظف وأصنافه</h3>
      <p class="muted small">كل صنف في الجرد اليومي له موظف واحد مسؤول عنه: يجرده أول وآخر الدوام، وإذا طلع نقص يكون عليه. المشرفين يستلمون الكل.</p></div>
    ${nobody.length ? `<div class="card" style="border-color:var(--amber)"><h3>أصناف ما لها مسؤول (${nobody.length})</h3>
      <div class="tbl-wrap"><table><tbody>${nobody.map(i => `<tr><td class="item-name">${esc(i.name)} <span class="muted small">${esc(i.unit)}</span></td>
        <td><select data-assign="${i.id}"><option value="">حطه عند…</option>${staff.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table></div></div>` : ''}
    ${staff.map(u => {
      const mine = items.filter(i => i.user_id === u.id);
      const opensOnly = items.filter(i => i.opener_id === u.id && i.user_id !== u.id);
      const prepOnly = items.filter(i => i.preparer_id === u.id && i.user_id !== u.id && i.opener_id !== u.id);
      const chip = (i, extra) => `<span class="badge brand" style="font-size:14px;padding:6px 10px;cursor:pointer" data-chip="${i.id}" title="مين يفتحه ومين يقفله">${esc(i.name)}${extra}</span>`;
      return `<div class="card" data-staff="${u.id}"><div class="sec-head"><h3 style="margin:0">${esc(u.name)} <span class="muted small">· ${ROLE[u.role]} · ${mine.length + opensOnly.length} صنف</span></h3></div>
        <div class="small muted" style="margin-top:6px">يقفلها آخر اليوم (النقص عليه):</div>
        ${mine.length ? `<div class="chips" style="margin:6px 0">${mine.map(i => chip(i, i.no_opening ? ' <span class="muted">(يبدأ من الشراء)</span>' : i.opener_id && i.opener_id !== u.id ? ` <span class="muted">(يفتحه ${esc(uName(i.opener_id))})</span>` : '')).join('')}</div>` : '<p class="muted small">ما فيه</p>'}
        ${prepOnly.length ? `<div class="small muted">يطبخها / يضيف عليها بس:</div><div class="chips" style="margin:6px 0">${prepOnly.map(i => chip(i, '')).join('')}</div>` : ''}
        ${opensOnly.length ? `<div class="small muted">يجردها أول اليوم بس:</div><div class="chips" style="margin:6px 0">${opensOnly.map(i => chip(i, ` <span class="muted">(يقفله ${esc(uName(i.user_id))})</span>`)).join('')}</div>` : ''}
        <div class="row"><select class="grow" data-add="${u.id}">${itemOpt(items.filter(i => i.user_id !== u.id), '+ أضف صنف عليه…')}</select></div></div>`;
    }).join('')}
    ${isOwner() ? `<div class="card"><div class="sec-head"><h3 style="margin:0">الموظفين</h3><div class="row" style="gap:6px"><button class="btn small" id="uPull">📲 سحب الأرقام من جروب المطعم</button><button class="btn small primary" id="uNew">+ موظف</button></div></div>
      <div class="tbl-wrap"><table><thead><tr><th>الاسم</th><th>الصلاحية</th><th>الرقم السري</th><th class="n">الراتب</th><th></th></tr></thead><tbody>
      ${users.map(u => `<tr${u.active ? '' : ' style="opacity:.5"'}><td>${esc(u.name)}${u.active ? '' : ' (موقوف)'}</td><td>${ROLE[u.role]}${u.role === 'supervisor' && (u.no_sales || u.no_recipes) ? `<div class="item-note">بدون: ${[u.no_sales ? 'المبيعات والتقارير' : '', u.no_recipes ? 'الوصفات' : ''].filter(Boolean).join('، ')}</div>` : ''}</td><td>${esc(u.pin)}</td><td class="n">${money(u.salary)}</td><td><button class="btn small" data-u="${u.id}">تعديل</button></td></tr>`).join('')}
      </tbody></table></div></div>` : ''}`;
  const assign = (itemId, userId) => busy(null, async () => { await POST('/api/responsibility', { item_id: Number(itemId), user_id: userId ? Number(userId) : null }); toast('انحفظ ✓'); route(); });
  $$('[data-assign]', main).forEach(sel => sel.onchange = () => sel.value && assign(sel.dataset.assign, sel.value));
  $$('[data-add]', main).forEach(sel => sel.onchange = () => sel.value && assign(sel.value, sel.dataset.add));
  // الضغط على صنف: مين يجرده أول اليوم، ومين يقفله آخر اليوم (والنقص عليه)
  $$('[data-chip]', main).forEach(c => c.onclick = () => {
    const i = items.find(x => x.id === Number(c.dataset.chip));
    const opts = sel => staff.map(u => `<option value="${u.id}" ${u.id === sel ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
    modal(i.name, `
      <label class="f">أول اليوم — مين يجرده؟<select id="rOpen">
        <option value="same">نفس اللي يقفله</option>
        <option value="none" ${i.no_opening ? 'selected' : ''}>ما يحتاج — يبدأ من الشراء/التحضير</option>
        ${staff.map(u => `<option value="${u.id}" ${!i.no_opening && i.opener_id === u.id && i.opener_id !== i.user_id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
      <label class="f">آخر اليوم — مين يقفله؟ (النقص عليه)<select id="rClose"><option value="">— بدون مسؤول —</option>${opts(i.user_id)}</select></label>
      <label class="f">مين يطبخه / يضيف عليه وسط اليوم؟ (يقدر يضيف بس — ما يجرد)<select id="rPrep"><option value="">— الفاتح والمقفل بس —</option>${opts(i.preparer_id)}</select></label>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="rSave">حفظ</button><button class="btn" data-close>إلغاء</button></div>`, (m, close) => {
      $('#rSave', m).onclick = e => busy(e.currentTarget, async () => {
        const op = $('#rOpen', m).value;
        await POST('/api/responsibility', { item_id: i.id, user_id: $('#rClose', m).value || null, opener_id: op === 'same' ? '' : op, preparer_id: $('#rPrep', m).value });
        close(); toast('انحفظ ✓'); route();
      });
    });
  });
  const editUser = u => {
    u = u || { name: '', role: 'worker', pin: '', salary: 0, active: 1 };
    modal(u.id ? 'تعديل موظف' : 'موظف جديد', `
      <label class="f">الاسم<input id="un" value="${esc(u.name)}"></label>
      <div class="row"><label class="f grow">الصلاحية<select id="ur">${Object.entries(ROLE).map(([k, v]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="f">الرقم السري<input id="up" inputmode="numeric" value="${esc(u.pin)}" placeholder="0000"></label><label class="f">الراتب الشهري<input id="us" inputmode="decimal" value="${u.salary || ''}"></label></div>
      <label class="f">📱 جوال الواتساب (يرسل منه الجرد والمشتريات)<input id="uph" inputmode="tel" dir="ltr" value="${esc(u.phone || '')}" placeholder="05xxxxxxxx"></label>
      <div id="supPerms" style="margin-top:8px">
        <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="uSales" ${u.no_sales ? '' : 'checked'}> يشوف المبيعات والتقارير وتذكرة الكاشير</label>
        <label class="small" style="display:flex;gap:6px;align-items:center;margin-top:4px"><input type="checkbox" id="uRec" ${u.no_recipes ? '' : 'checked'}> يشوف الوصفات</label></div>
      <label class="small" style="display:flex;gap:6px;align-items:center;margin-top:8px"><input type="checkbox" id="uVoice" ${u.voice_reply ? 'checked' : ''}> 🔊 المساعد يرد عليه بالصوت كمان (للي ما يقرأ)</label>
      ${u.id ? `<label class="small" style="display:flex;gap:6px;align-items:center;margin-top:8px"><input type="checkbox" id="ua" ${u.active ? 'checked' : ''}> شغّال</label>` : ''}
      ${u.id && u.role !== 'owner' ? `<div style="margin-top:10px;border-top:1px solid var(--line);padding-top:8px"><b class="small">📸 صورة الوجه (للحضور)</b> <span class="small muted" id="uFaceSt">${u.has_face ? '✓ موجودة' : 'ما فيه'}</span>
        <div class="small muted">صورة واضحة لوجهه من قدام — النظام يقارن فيها السيلفي لما يسجل «بدأت دوامي». ما يشوفها إلا أنت.</div>
        <div class="row" style="gap:6px;margin-top:6px"><label class="btn small"><input type="file" accept="image/*" capture="user" id="uFace" hidden>📷 صوّر / غيّر</label>
        ${u.has_face ? '<button class="btn small" id="uFaceView">👁️ شوف</button><button class="btn small danger" id="uFaceDel">حذف</button>' : ''}</div></div>` : ''}
      <div class="row" style="margin-top:14px"><button class="btn primary" id="usv">حفظ</button><button class="btn" data-close>إلغاء</button></div>`, (m, close) => {
      // صلاحيات المبيعات والوصفات تخص المشرف (المالك يشوف كل شي، والعامل ومسؤول المشتريات ما يشوفونها أصلًا)
      const perms = () => { $('#supPerms', m).hidden = $('#ur', m).value !== 'supervisor'; };
      $('#ur', m).onchange = perms; perms();
      const fi = $('#uFace', m); if (fi) fi.onchange = async e => {
        const f = e.target.files[0]; if (!f) return;
        try { await POST(`/api/users/${u.id}/face`, { image: await readImage(f, 1000) }); S.cache.users = null; $('#uFaceSt', m).textContent = '✓ انحفظت'; toast('انحفظت صورة الوجه ✓'); } catch (er) { toast(er.message, true); }
      };
      const fv = $('#uFaceView', m); if (fv) fv.onclick = () => busy(fv, async () => showImage(await authImg(`/api/users/${u.id}/face`)));
      const fd = $('#uFaceDel', m); if (fd) fd.onclick = () => busy(fd, async () => { if (!await confirmBox('تحذف صورة وجهه؟')) return; await POST(`/api/users/${u.id}/face`, { image: '' }); S.cache.users = null; close(); toast('انحذفت'); route(); });
      $('#usv', m).onclick = e => busy(e.currentTarget, async () => {
        await POST('/api/users', { id: u.id, name: $('#un', m).value, role: $('#ur', m).value, pin: $('#up', m).value || '0000', salary: $('#us', m).value, active: u.id ? $('#ua', m).checked : true,
          no_sales: !$('#uSales', m).checked, no_recipes: !$('#uRec', m).checked, phone: $('#uph', m).value, voice_reply: $('#uVoice', m).checked });
        S.cache.users = null; close(); toast('انحفظ ✓'); route();
      });
    });
  };
  const un = $('#uNew'); if (un) un.onclick = () => editUser(null);
  // 📲 جوالات الموظفين من أعضاء «جروب المطعم» (الرقم المربوط لازم يكون فيه)
  const up = $('#uPull'); if (up) up.onclick = e => busy(e.currentTarget, async () => {
    const r = await GET('/api/whatsapp/members');
    modal('📲 أرقام جروب المطعم', `<p class="small muted">لكل رقم اختر مين هو من الموظفين. اللي مو موظف خله «تجاهل».</p>
      ${r.members.map((m, i) => `<div class="row" style="align-items:center;gap:6px;border-bottom:1px solid var(--line);padding:6px 0;flex-wrap:wrap">
        <span style="flex:1;min-width:140px"><span dir="ltr">+${esc(m.phone)}</span>${m.name ? `<div class="small muted">${esc(m.name)}</div>` : ''}</span>
        ${m.user_id ? `<span class="small">✓ ${esc((r.staff.find(x => x.id === m.user_id) || {}).name || '')}</span>`
          : `<select data-pm="${i}" style="width:auto;min-width:130px"><option value="">تجاهل</option>${r.staff.map(x => `<option value="${x.id}" ${m.suggest === x.id ? 'selected' : ''}>${esc(x.name)}${x.phone ? ' (له رقم)' : ''}</option>`).join('')}</select>`}</div>`).join('') || '<p class="muted">ما فيه أعضاء</p>'}
      <div class="row" style="margin-top:12px"><button class="btn primary" id="pmOk">حفظ</button><button class="btn" data-close>إلغاء</button></div>`, (m, close) => {
      $('#pmOk', m).onclick = e2 => busy(e2.currentTarget, async () => {
        const links = $$('[data-pm]', m).filter(x => x.value).map(x => ({ user_id: Number(x.value), phone: r.members[Number(x.dataset.pm)].phone }));
        if (!links.length) return close();
        const res = await POST('/api/whatsapp/members', { links });
        S.cache.users = null; close();
        toast(`✓ انحفظ ${res.saved.length} رقم${res.failed.length ? ` — ما انحفظ: ${res.failed.join('، ')}` : ''}`, !!res.failed.length); route();
      });
    });
  });
  $$('[data-u]', main).forEach(b => b.onclick = () => editUser(users.find(u => u.id === Number(b.dataset.u))));
}

// ===================== الرواتب والسحبيات =====================
const PAY = { salary: 'راتب مستحق', advance: 'سحب', settle: 'صرف الباقي (سفر)', bonus: 'مكافأة', deduct: 'خصم' };
async function pagePayroll(main, alive) {
  const list = await GET('/api/payroll');
  if (!alive()) return;
  main.innerHTML = `<p class="muted small">الراتب ينضاف لحاله أول كل شهر. الموظف يسحب شوي شوي، وإذا سافر "صرف الباقي" يعطيه كل اللي له.</p>
    ${list.filter(u => u.active).map(u => `<div class="card"><div class="sec-head"><h3 style="margin:0">${esc(u.name)}</h3>
      <div class="row"><span class="badge">الراتب ${money(u.salary)}</span><span class="badge">سحب هالشهر ${money(u.advances_this_month)}</span>
      <span class="badge ${u.balance > 0 ? 'brand' : u.balance < 0 ? 'red' : ''}">${u.balance >= 0 ? 'له' : 'عليه'} ${money(Math.abs(u.balance))}</span></div></div>
      <div class="row"><select data-t style="width:auto">${Object.entries(PAY).map(([k, v]) => `<option value="${k}" ${k === 'advance' ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <input class="qty" data-a inputmode="decimal" placeholder="المبلغ"><input class="grow" data-n placeholder="ملاحظة"><button class="btn primary" data-go="${u.id}">حفظ</button></div>
      <details style="margin-top:6px"><summary class="small muted">الحركات</summary><div class="tbl-wrap"><table><tbody>${u.entries.map(e => `<tr><td class="small">${e.date}</td><td>${PAY[e.type]}</td><td class="n ${['salary', 'bonus'].includes(e.type) ? 'neg' : 'pos'}">${money(e.amount)}</td><td class="small">${esc(e.note)}</td><td><button class="btn small danger" data-del="${e.id}">حذف</button></td></tr>`).join('')}</tbody></table></div></details></div>`).join('')}`;
  $$('[data-go]', main).forEach(b => b.onclick = () => busy(b, async () => {
    const card = b.closest('.card');
    await POST('/api/payroll', { user_id: Number(b.dataset.go), type: $('[data-t]', card).value, amount: $('[data-a]', card).value, note: $('[data-n]', card).value, date: S.date });
    toast('انحفظ ✓'); route();
  }));
  $$('[data-del]', main).forEach(b => b.onclick = async () => { if (await confirmBox('تحذف الحركة؟')) busy(b, async () => { await DEL('/api/payroll/' + b.dataset.del); route(); }); });
}

// ===================== الأيام السابقة =====================
async function pageDays(main, alive) {
  const days = await GET('/api/days');
  if (!alive()) return;
  main.innerHTML = `<div class="card"><div class="tbl-wrap"><table><thead><tr><th>اليوم</th><th class="n">المبيعات</th><th class="n">منها تذكرة</th><th>الحالة</th><th></th></tr></thead><tbody>
    ${days.map(d => `<tr><td>${d.date}</td><td class="n">${money(d.sales)}</td><td class="n">${money(d.tickets)}</td><td>${d.closed ? '<span class="badge green">مقفل</span>' : '<span class="badge amber">مفتوح</span>'}</td>
      <td><button class="btn small" data-d="${d.date}">التقرير</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">ما فيه</td></tr>'}</tbody></table></div></div>`;
  $$('[data-d]', main).forEach(b => b.onclick = () => { S.date = b.dataset.d; $('#dateSel').value = S.date; location.hash = '#/report'; });
}

// ===================== الإعدادات =====================
// ===================== ربح الأطباق واقتراح تعديل الوصفات =====================
async function pageProfit(main, alive) {
  const [mp, sug] = await Promise.all([GET('/api/menu-profit'), GET('/api/recipe-suggestions')]);
  if (!alive()) return;
  main.innerHTML = `
    ${sug.length ? `<div class="card"><h3>وصفات يمكن تحتاج تعديل</h3>
      <p class="muted small">هذي الأصناف تنقص أغلب الأيام بنفس النسبة تقريبًا — غالبًا الوصفة أقل من الحقيقة، مو سرقة. شيك مع المسؤول قبل ما تطبّق.</p>
      ${sug.map(x => `<div class="alert amber" style="margin:6px 0"><b>${esc(x.name)}</b>: نقص ${x.short_days} من ${x.days} أيام، متوسط ${qtyFmt(x.avg_short)} ${esc(x.unit)} (${x.pct}%) — المقفل ${esc(x.closer)}
        <div class="small" style="margin-top:4px">الاقتراح: كل الوصفات ×${x.factor}: ${x.lines.slice(0, 6).map(l => `${esc(l.product)} ${qtyFmt(l.qty)} ← <b>${qtyFmt(l.suggested)}</b>`).join('، ')}${x.lines.length > 6 ? '…' : ''}</div>
        <button class="btn small primary" data-apply="${x.item_id}:${x.factor}" style="margin-top:6px">طبّق ×${x.factor}</button></div>`).join('')}</div>` : ''}
    <div class="card"><h3>ربح كل طبق</h3>
      <p class="muted small">التكلفة من الوصفة وأسعار الشراء. النسبة المعقولة لتكلفة الأكل ٢٨–٣٥٪ من سعر البيع — الأحمر فوق ${mp.max_food_cost}% (تغيّرها من الإعدادات).</p>
      <input id="pfQ" placeholder="ابحث…" style="margin-bottom:8px">
      <div class="tbl-wrap"><table><thead><tr><th>الطبق</th><th class="n">السعر</th><th class="n">التكلفة</th><th class="n">الربح</th><th class="n">نسبة التكلفة</th><th class="n">انباع (٣٠ يوم)</th><th class="n">ربح ٣٠ يوم</th></tr></thead><tbody id="pfRows"></tbody></table></div></div>`;
  const draw = q => { $('#pfRows').innerHTML = mp.rows.filter(r => !q || r.name.includes(q)).map(r => `<tr><td>${esc(r.name)}${r.draft ? ' <span class="badge amber">مبدئية</span>' : ''}${r.missing_cost ? ' <span class="badge">مكوّن بدون سعر</span>' : ''}</td>
      <td class="n">${money(r.price)}</td><td class="n">${money(r.cost)}</td><td class="n">${money(r.profit)}</td>
      <td class="n ${r.high ? 'pos' : ''}">${r.food_cost_pct == null ? '—' : r.food_cost_pct + '%'}</td><td class="n">${qtyFmt(r.sold_30)}</td><td class="n">${money(r.profit_30)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">ما فيه</td></tr>'; };
  draw('');
  $('#pfQ').oninput = e => draw(e.target.value.trim());
  $$('[data-apply]', main).forEach(b => b.onclick = async () => {
    const [id, f] = b.dataset.apply.split(':');
    if (await confirmBox(`كل وصفة تاخذ من هالصنف تتضرب ×${f}. تكمّل؟`)) busy(b, async () => { await POST('/api/recipe-suggestions/apply', { item_id: Number(id), factor: Number(f) }); toast('تعدّلت ✓'); route(); });
  });
}

// ===================== النقص الشهري لكل موظف =====================
async function pageShortMonth(main, alive) {
  const month = new URLSearchParams(location.hash.split('?')[1] || '').get('m') || S.date.slice(0, 7);
  const d = await GET('/api/shortage-month?month=' + month);
  if (!alive()) return;
  main.innerHTML = `<div class="card"><div class="row"><label class="f">الشهر<input type="month" id="smM" value="${month}"></label>
      <button class="btn" id="smCsv" style="align-self:flex-end">تنزيل Excel (CSV)</button></div>
      <p class="muted small">من ${d.from} إلى ${d.to}. النقص على اللي يقفل الصنف آخر اليوم، بقيمة الصنف.</p>
      <div class="tbl-wrap"><table><thead><tr><th>الموظف</th><th class="n">أيام</th><th class="n">مرات النقص</th><th class="n">قيمة النقص</th><th class="n">زيادة</th><th></th></tr></thead><tbody>
      ${d.rows.map((r, i) => `<tr><td class="item-name">${esc(r.name)}</td><td class="n">${r.days}</td><td class="n">${r.short_times} من ${r.counted}</td>
        <td class="n ${r.short_value > 0 ? 'pos' : ''}">${money(r.short_value)}</td><td class="n">${money(r.over_value)}</td>
        <td><div class="row"><button class="btn small" data-det="${i}">التفاصيل</button>${isOwner() && r.user_id && r.short_value > 0 ? `<button class="btn small danger" data-ded="${i}">خصم من الراتب</button>` : ''}</div></td></tr>`).join('') || '<tr><td colspan="6" class="muted">ما فيه جرد مكتمل هالشهر</td></tr>'}
      </tbody></table></div></div>`;
  $('#smM').onchange = e => { location.hash = '#/shortmonth?m=' + e.target.value; };
  $$('[data-det]', main).forEach(b => b.onclick = () => { const r = d.rows[Number(b.dataset.det)];
    modal('نقص ' + r.name, `<div class="tbl-wrap"><table><thead><tr><th>الصنف</th><th class="n">مرات</th><th class="n">الكمية</th><th class="n">ريال</th></tr></thead><tbody>
      ${r.items.map(x => `<tr><td>${esc(x.item)}</td><td class="n">${x.times}</td><td class="n">${qtyFmt(x.qty)} ${esc(x.unit)}</td><td class="n">${money(x.value)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">ما فيه نقص</td></tr>'}
      </tbody></table></div><div class="row" style="margin-top:10px"><button class="btn" data-close>إغلاق</button></div>`); });
  $$('[data-ded]', main).forEach(b => b.onclick = () => { const r = d.rows[Number(b.dataset.ded)];
    modal('خصم من راتب ' + r.name, `<p class="small muted">نقص ${month}: ${money(r.short_value)} ريال. تقدر تخصم كله أو جزء.</p>
      <label class="f">المبلغ<input id="dA" inputmode="decimal" value="${r.short_value}"></label>
      <div class="row" style="margin-top:10px"><button class="btn danger" id="dOk">خصم</button><button class="btn" data-close>إلغاء</button></div>`, (m, close) => {
      $('#dOk', m).onclick = e => busy(e.currentTarget, async () => { await POST('/api/payroll', { user_id: r.user_id, type: 'deduct', amount: $('#dA', m).value, note: 'نقص الجرد ' + month, date: S.date }); close(); toast('انخصم ✓'); });
    }); });
  $('#smCsv').onclick = () => {
    const rows = [['الموظف', 'الصنف', 'مرات', 'الكمية', 'الوحدة', 'ريال']];
    for (const r of d.rows) { rows.push([r.name, 'المجموع', r.short_times, '', '', r.short_value]); for (const x of r.items) rows.push([r.name, x.item, x.times, x.qty, x.unit, x.value]); }
    const csv = '\ufeff' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = `نقص-${month}.csv`; a.click();
  };
}

// ===================== المساعد (ذكاء اصطناعي) =====================
// نص الرد: نقاط وسطور وعريض (**كذا**) — بدون HTML من الرد نفسه
const aiText = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').split('\n').map(l => l.trim() ? `<div>${l}</div>` : '<div style="height:6px"></div>').join('');
const cents = c => `${fmt(c * 3.75 * 100, 1)} هللة`;
const kTok = n => n >= 1000 ? fmt(n / 1000, 1) + 'k' : String(n || 0);
const usdC = c => `${fmt((c || 0) * 100, 2)}¢`;
// 💰 لوحة صرف الذكاء: بالسنت لكل نداء — مدخل / كتابة كاش / قراءة كاش / مخرج
function aiUsageHtml(r) {
  const row = x => `<td class="n">${x.calls ?? ''}</td><td class="n">${kTok(x.input_tokens)}</td><td class="n">${kTok(x.cache_write)}</td><td class="n">${kTok(x.cache_read)}</td><td class="n">${kTok(x.output_tokens)}</td><td class="n">${x.images || 0}</td><td class="n"><b>${usdC(x.cost)}</b></td>`;
  const head = first => `<tr><th>${first}</th><th class="n">نداء</th><th class="n">مدخل</th><th class="n">كتابة كاش</th><th class="n">قراءة كاش</th><th class="n">مخرج</th><th class="n">صور</th><th class="n">التكلفة</th></tr>`;
  return `<div class="card" style="margin-top:8px"><h3>💰 صرف الذكاء — آخر ${r.days} أيام</h3>
    <p class="small">هالشهر: <b>${fmt(r.month)} دولار</b> من حد ${fmt(r.cap)} · تصغير الصور: ${r.images_ready ? '✅ شغّال' : '<b class="pos">❌ مو شغّال — الصور تروح بحجمها الكامل</b>'}${r.kb ? ` · الدليل: ${r.kb.same ? 'محدّث' : 'فيه تعديلات تنتظر الفجر'}` : ''}</p>
    ${r.warnings.length ? `<div class="alert red">⚠️ تصغير صور فشل ${r.warnings.length} مرة: ${r.warnings.slice(0, 3).map(w => esc(ksa(w.at) + ' — ' + w.question)).join('<br>')}</div>` : ''}
    <h4>حسب اليوم</h4><div class="tbl-wrap"><table><thead>${head('اليوم')}</thead><tbody>${r.by_day.map(x => `<tr><td>${esc(x.day)}</td>${row(x)}</tr>`).join('') || '<tr><td colspan="8" class="muted">ما فيه</td></tr>'}</tbody></table></div>
    <h4>حسب النوع والنموذج</h4><div class="tbl-wrap"><table><thead>${head('النوع')}</thead><tbody>${r.by_kind.map(x => `<tr><td>${esc(x.kind)} <span class="muted small">${esc(String(x.model).replace('claude-', ''))}</span></td>${row(x)}</tr>`).join('')}</tbody></table></div>
    <details><summary class="small">آخر ${r.calls.length} نداء</summary><div class="tbl-wrap"><table><thead>${head('الوقت')}</thead><tbody>${r.calls.map(x => `<tr><td class="small">${esc(ksa(x.at))}<br>${esc(x.kind)} · ${esc(String(x.model).replace('claude-', ''))}${x.user ? ' · ' + esc(x.user) : ''}</td>${row({ ...x, calls: 1, cache_write: x.cache_write, cache_read: x.cache_read })}</tr>`).join('')}</tbody></table></div></details></div>`;
}
async function pageAssistant(main, alive) {
  let tab = new URLSearchParams(location.hash.split('?')[1] || '').get('tab') || 'ask';
  if (!S.me.has_ai) { main.innerHTML = `<div class="card"><p>المساعد يحتاج مفتاح Anthropic.</p>${isOwner() ? '<a class="btn primary" href="#/settings">حطه من الإعدادات</a>' : '<p class="muted">كلم المالك يحطه من الإعدادات.</p>'}</div>`; return; }
  if (!S.me.can_sales) tab = 'ask'; // الملخص والتوصيات لمن يشوف المبيعات
  main.innerHTML = `${S.me.can_sales ? `<div class="tabs no-print">${[['ask', 'كلّم المساعد'], ['summary', 'ملخص اليوم'], ['reco', 'توصيات بكرة']].map(([k, v]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${v}</button>`).join('')}</div>` : ''}<div id="aiBody"></div>`;
  $$('[data-tab]', main).forEach(b => b.onclick = () => { location.hash = '#/assistant?tab=' + b.dataset.tab; });
  const body = $('#aiBody', main);
  if (tab === 'ask') return assistantAsk(body, alive);
  return assistantSaved(body, tab, alive);
}

// ===== كلّم المساعد: كتابة، صوت، صور — وكروت «تأكيد» للي يسجله =====
const AI_LANGS = [['ar-SA', 'العربي'], ['en-US', 'English'], ['bn-BD', 'বাংলা'], ['hi-IN', 'हिन्दी'], ['ur-PK', 'اردو'], ['ne-NP', 'नेपाली'], ['fil-PH', 'Filipino']];
const aiImgs = new Map(); // صور كل رسالة (بالذاكرة بس — للتأكيد)
function speak(text) {
  if (!('speechSynthesis' in window) || lsGet('aiVoice') !== '1') return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text).replace(/[*•#]/g, ' ').slice(0, 1500));
    u.lang = lsGet('aiLang') || 'ar-SA'; speechSynthesis.speak(u);
  } catch { /* */ }
}
function aiExamples() {
  const r = S.me.role;
  if (r === 'purchaser') return ['اشتريت كرتونين طماطم بستين من خضار الوادي كاش', 'كم آخر سعر للدقيق؟', 'وش علي الحين؟', 'ذكّرني بكرة أطلب رز'];
  if (r === 'worker') return ['وش علي الحين؟', 'طلّعت 5 حنيذ دجاج من الثلاجة', 'انرمى صحنين سلطة خربانة', 'ليش طلع علي نقص أمس؟'];
  const base = ['وش علي الحين؟', 'الكاش 2300 والشبكة 1400', 'سجّل مصروف غاز 45 من الدرج', 'مين عليه نقص هالأسبوع؟'];
  return S.me.can_sales ? [...base, 'كم بعنا اليوم؟', 'كم أجهّز حنيذ بكرة؟'] : base;
}
async function assistantAsk(body, alive) {
  let chat = []; try { chat = JSON.parse(sessionStorage.getItem('aiChat') || '[]'); } catch { chat = []; }
  const save = () => { try { sessionStorage.setItem('aiChat', JSON.stringify(chat.slice(-20))); } catch { /* */ } };
  const photos = [];
  const lang = lsGet('aiLang') || 'ar-SA';
  const reminders = await GET('/api/reminders').catch(() => []);
  if (alive && !alive()) return;
  body.innerHTML = `${reminders.length ? `<div class="card"><h3 style="margin-top:0">⏰ تذكيراتك</h3>${reminders.map(r => `<div class="row" style="justify-content:space-between;margin:4px 0"><span>${esc(r.text)} <span class="muted small">${r.due_date}</span></span><button class="btn small" data-rdone="${r.id}">تم ✓</button></div>`).join('')}</div>` : ''}
    <div class="card"><div id="chat"></div>
    <div class="row" style="margin-top:8px;align-items:flex-end">
      <textarea id="aiQ" rows="2" placeholder="اكتب أو اضغط 🎤 وتكلم…" style="flex:1;min-width:200px"></textarea>
      ${SR() ? '<button class="btn" id="aiMic" aria-label="تكلم">🎤</button>' : ''}
      <label class="btn" aria-label="صورة"><input type="file" accept="image/*" capture="environment" multiple hidden id="aiCam">📷</label>
      <button class="btn primary" id="aiGo">أرسل</button></div>
    <div class="small muted" id="aiPh"></div>
    <div class="row small" style="margin-top:8px">
      <select id="aiLang" style="width:auto">${AI_LANGS.map(([k, v]) => `<option value="${k}" ${k === lang ? 'selected' : ''}>${v}</option>`).join('')}</select>
      ${'speechSynthesis' in window ? `<button class="btn small" id="aiVoice">${lsGet('aiVoice') === '1' ? '🔊 الرد بالصوت: شغّال' : '🔇 الرد بالصوت: طافي'}</button>` : ''}
      ${chat.length ? '<button class="btn small" id="aiClear">محادثة جديدة</button>' : ''}</div>
    <div class="row small" style="margin-top:8px">${aiExamples().map(x => `<button class="btn small" data-ex="${esc(x)}">${esc(x)}</button>`).join('')}</div></div>`;
  const cardHtml = (c, mi) => `<div class="card" style="margin:6px 0;border:2px solid ${c.status === 'done' ? 'var(--green)' : c.status === 'cancel' ? 'var(--line)' : 'var(--brand)'}">
      <b>${esc(c.title)}</b>${c.lines.map(l => `<div class="small">${esc(l)}</div>`).join('')}
      ${c.status === 'done' ? `<div class="small" style="color:var(--green);margin-top:4px">انحفظ ✓ ${c.result ? esc(c.result) : ''}</div>`
        : c.status === 'cancel' ? '<div class="small muted">انلغى</div>'
        : `<div class="row" style="margin-top:6px"><button class="btn primary small" data-ok="${mi}:${c.id}">✓ تأكيد</button><button class="btn small" data-no="${mi}:${c.id}">✗ إلغاء</button></div>`}</div>`;
  const draw = () => {
    $('#chat', body).innerHTML = chat.map((m, i) => m.role === 'user'
      ? `<div class="alert" style="background:#eef4ff;margin:6px 0"><b>${esc(S.me.name)}:</b> ${esc(m.text)}${m.imgs ? ` <span class="muted small">📷 ${m.imgs}</span>` : ''}</div>`
      : `<div class="card" style="margin:6px 0;background:#fafafa">${aiText(m.text)}
          ${(m.actions || []).map(c => cardHtml(c, i)).join('')}
          <div class="small muted" style="margin-top:6px">${m.model === 'strong' ? '🔬 Opus' : m.model === 'mid' ? 'Sonnet' : 'Haiku'} · ${cents(m.cost || 0)} (${usdC(m.cost || 0)})${m.usage ? ` · ${kTok(m.usage.in + m.usage.cw + m.usage.cr)} داخل (${kTok(m.usage.cr)} من الكاش) · ${kTok(m.usage.out)} طالع` : ''}
          ${isOwner() && m.model !== 'strong' && i === chat.length - 1 && !(m.actions || []).length ? ' · <button class="btn small" id="aiMore">🔬 تحليل عميق (Opus)</button>' : ''}</div></div>`).join('')
      || '<p class="muted">اسألني أو قلّي وش سويت وأنا أسجله لك — كل شي يحتاج «تأكيد» منك قبل ما ينحفظ.</p>';
    const more = $('#aiMore', body);
    if (more) more.onclick = async e => {
      const btn = e.currentTarget;
      if (!await confirmBox('🔬 التحليل العميق يشتغل على Opus — أغلى من العادي بحوالي ٤٠ مرة (تقريبًا ١٠ إلى ٤٠ سنت = ٤٠ إلى ١٥٠ هللة للسؤال). تكمل؟')) return;
      const q = [...chat].reverse().find(m => m.role === 'user'); if (q) { chat.pop(); chat.pop(); send(q.text, true, btn); }
    };
    $$('[data-ok]', body).forEach(b => b.onclick = () => busy(b, () => confirmCard(b.dataset.ok)));
    $$('[data-no]', body).forEach(b => b.onclick = () => { const [mi, id] = b.dataset.no.split(':'); const c = chat[mi].actions.find(x => x.id === id); c.status = 'cancel'; save(); draw(); });
  };
  // التأكيد: نفس الـ API العادي (نفس الصلاحيات والتحقق)
  async function confirmCard(key) {
    const [mi, id] = key.split(':'); const c = chat[Number(mi)].actions.find(x => x.id === id);
    const imgs = aiImgs.get(chat[Number(mi) - 1] && chat[Number(mi) - 1].key) || [];
    if (c.requests.some(r => r.attach_images) && !imgs.length) throw new Error('الصور راحت (انفتحت الصفحة من جديد) — أرسلها مرة ثانية');
    let last;
    for (const r of c.requests) {
      const b = { ...r.body };
      if (r.attach_images) b.images = imgs;
      if (r.attach_image && imgs.length) b.image = imgs[0];
      last = await POST(r.endpoint, b);
    }
    c.status = 'done'; save(); draw(); toast('انحفظ ✓');
    if (c.type === 'ticket' && last && last.id) watchTicket(c, last.id);
    S.cache.items = null;
  }
  async function watchTicket(c, id) {
    c.result = '— جاري القراءة…'; save(); draw();
    for (let i = 0; i < 180; i++) {
      await new Promise(r => setTimeout(r, 5000));
      if (!body.isConnected) return;
      const t = await GET('/api/tickets/' + id).catch(() => null);
      if (t && t.status !== 'reading') {
        const ok = ['ok', 'items_ok'].includes(t.check_status);
        c.result = t.ocr_error ? '— ' + t.ocr_error : `— ${t.lines.length} سطر${t.paper_total != null ? ` · المطبوع ${money(t.paper_total)} والأسطر ${money(t.lines_total)}` : ''} · ${ok ? 'طابقت ✓' : 'تحتاج مراجعة'} — افتح «تذكرة الكاشير» وأكّدها`;
        save(); draw(); speak(ok ? 'التذكرة طابقت' : 'التذكرة تحتاج مراجعة'); return;
      }
    }
  }
  const send = (q, detailed, btn) => busy(btn || $('#aiGo', body), async () => {
    q = String(q || '').trim(); if (!q && !photos.length) throw new Error('اكتب أو تكلم أو صوّر');
    const history = chat.slice(-6).map(m => ({ role: m.role, text: m.role === 'assistant' && (m.actions || []).length ? m.text + '\n[كروت: ' + m.actions.map(c => c.title + (c.status === 'done' ? ' (انحفظ)' : c.status === 'cancel' ? ' (انلغى)' : ' (ينتظر تأكيد)')).join('، ') + ']' : m.text }));
    const imgs = photos.splice(0); $('#aiPh', body).textContent = '';
    const key = 'm' + Date.now();
    if (imgs.length) aiImgs.set(key, imgs);
    chat.push({ role: 'user', text: q || 'شوف الصور', imgs: imgs.length, key }); draw();
    try {
      const r = await api('POST', '/api/assistant', { question: q, history, detailed, images: imgs }, 240000);
      chat.push({ role: 'assistant', text: r.answer, cost: r.cost, model: r.model, usage: r.usage, actions: (r.actions || []).map(c => ({ ...c, status: 'new' })) });
      $('#aiQ', body).value = '';
      speak(r.answer);
    } catch (e) { chat.pop(); photos.push(...imgs); throw e; } finally { save(); draw(); }
  });
  draw();
  $('#aiGo', body).onclick = () => send($('#aiQ', body).value);
  $('#aiQ', body).onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($('#aiQ', body).value); } };
  $$('[data-ex]', body).forEach(b => b.onclick = () => send(b.dataset.ex, false, b));
  $$('[data-rdone]', body).forEach(b => b.onclick = () => busy(b, async () => { await POST(`/api/reminders/${b.dataset.rdone}/done`); b.closest('.row').remove(); }));
  $('#aiCam', body).onchange = async e => { try { photos.push(...await readImages(e.target)); } catch (er) { toast(er.message, true); } e.target.value = ''; $('#aiPh', body).textContent = photos.length ? `📷 ${photos.length} صورة جاهزة — اكتب وش هي (فاتورة، تذكرة…) واضغط أرسل` : ''; };
  $('#aiLang', body).onchange = e => lsSet('aiLang', e.target.value);
  const vb = $('#aiVoice', body); if (vb) vb.onclick = () => { lsSet('aiVoice', lsGet('aiVoice') === '1' ? '' : '1'); vb.textContent = lsGet('aiVoice') === '1' ? '🔊 الرد بالصوت: شغّال' : '🔇 الرد بالصوت: طافي'; if (lsGet('aiVoice') !== '1') try { speechSynthesis.cancel(); } catch { /* */ } };
  const cl = $('#aiClear', body); if (cl) cl.onclick = () => { chat = []; save(); assistantAsk(body, alive); };
  const mic = $('#aiMic', body);
  if (mic) mic.onclick = () => {
    const rec = new (SR())(); rec.lang = lsGet('aiLang') || 'ar-SA'; rec.interimResults = false;
    mic.textContent = '⏺️'; mic.disabled = true;
    rec.onresult = e => { const t = e.results[0][0].transcript; $('#aiQ', body).value = t; send(t); };
    rec.onerror = () => toast('ما سمعتك — جرّب مرة ثانية', true);
    rec.onend = () => { mic.textContent = '🎤'; mic.disabled = false; };
    rec.start();
  };
}

async function assistantSaved(body, kind, alive) {
  const date = kind === 'reco' ? null : S.date;
  const s = await GET(`/api/assistant/saved?kind=${kind}${date ? '&date=' + date : ''}`);
  if (!alive()) return;
  const fc = kind === 'reco' ? await GET('/api/forecast?date=' + s.date) : null;
  if (!alive()) return;
  const title = kind === 'reco' ? `توصيات ${s.date}${fc ? ' (' + fc.weekday + ')' : ''}` : `ملخص يوم ${s.date}`;
  const tbl = (rows, h) => rows.length ? `<div class="tbl-wrap"><table><thead><tr><th>الصنف</th><th class="n">المتوقع ينصرف</th><th class="n">باقي من أمس</th><th class="n">${h}</th><th>المسؤول</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${esc(r.name)}</td><td class="n">${qtyFmt(r.expected)}</td><td class="n">${qtyFmt(r.left)}</td><td class="n"><b>${qtyFmt(r.make)}</b> <span class="muted small">${esc(r.unit)}</span></td><td>${esc(r.opener || '—')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">ما فيه</p>';
  body.innerHTML = `<div class="card"><h3>${esc(title)}</h3>
      <div id="aiOut">${s.saved ? aiText(s.saved.text) + `<div class="small muted" style="margin-top:6px">${cents(s.saved.cost)} · ${ksa(s.saved.at)}</div>` : '<p class="muted">ما انسوى للحين.</p>'}</div>
      <div class="row" style="margin-top:8px"><button class="btn primary" id="aiMake">${s.saved ? 'حدّث' : kind === 'reco' ? 'اكتب لي التوصيات' : 'لخّص لي اليوم'}</button>
      ${s.saved ? `<a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(title + '\n' + s.saved.text)}">أرسل على واتساب</a>` : ''}</div>
      <p class="small muted">صرف الذكاء الاصطناعي هالشهر: ${fmt(s.spent)} من ${fmt(s.cap)} دولار</p></div>
    ${fc ? `<div class="card"><h3>الحساب من السجل (ببلاش)</h3>
      <p class="small">${fc.samples ? `من آخر ${fc.samples} ${esc(fc.weekday)}` : '<b>السجل قليل</b> — اسحب سجل أطول من الإعدادات'}${fc.payday ? ` · يوم راتب (×${fc.payday_ratio})` : ''}${fc.season ? ` · موسم: ${esc(fc.season)}` : ''} · المبيعات المتوقعة تقريبًا <b>${money(fc.expected_sales)}</b> ريال</p>
      <h4>جهّز</h4>${tbl(fc.prep, 'جهّز')}
      <h4>اشترِ (طازج)</h4>${tbl(fc.buy, 'اشترِ')}
      ${fc.low_stock.length ? `<h4>المستودع قرب يخلص</h4>${fc.low_stock.map(r => `<div class="alert amber">${esc(r.name)}: باقي ${qtyFmt(r.balance)} ${esc(r.unit)} — يكفي ${fmt(r.days_left, 1)} يوم</div>`).join('')}` : ''}
      <details><summary class="small">المتوقع ينباع من كل صنف</summary>${fc.products.map(p => `<div class="small">${esc(p.name)}: ${qtyFmt(p.qty)}</div>`).join('')}</details></div>` : ''}`;
  $('#aiMake', body).onclick = e => busy(e.currentTarget, async () => {
    const r = await api('POST', '/api/assistant/' + kind, { date: s.date, refresh: !!s.saved }, 240000);
    $('#aiOut', body).innerHTML = aiText(r.text) + `<div class="small muted" style="margin-top:6px">${cents(r.cost)}</div>`;
    toast('تم ✓');
  });
}

// ===================== قوقل درايف (النسخة الاحتياطية) =====================
const gdRedirect = () => location.origin + '/api/gdrive/callback';
function gdriveCard(gd) {
  const when = t => t ? ksa(t) : 'ما انسخ للحين';
  return `<div class="card"><h3>☁️ النسخة الاحتياطية على قوقل درايف</h3>
    ${gd.connected ? `<div class="alert" style="background:var(--green-soft);color:var(--green)"><b>مربوط ✓</b> — ينسخ كل يوم الفجر لحاله: قاعدة البيانات (آخر 30 يوم)، وصور التذاكر والفواتير، وتقرير المحاسب أول كل شهر.</div>
      <p class="small">آخر نسخة: <b>${esc(when(gd.last_backup))}</b> · صور انرفعت: ${gd.images}${gd.last_report ? ` · آخر تقرير محاسب: ${esc(gd.last_report)}` : ''}</p>
      ${gd.last_error ? `<div class="alert red small">آخر خطأ: ${esc(gd.last_error)}</div>` : ''}
      <div class="row"><button class="btn primary" id="gdNow">انسخ الحين</button>${gd.folder_url ? `<a class="btn" href="${esc(gd.folder_url)}" target="_blank" rel="noopener">افتح المجلد في درايف</a>` : ''}<button class="btn danger" id="gdOff">إلغاء الربط</button></div>`
    : `<p class="muted small">مرة وحدة بس (ربع ساعة). النظام يشوف بس الملفات اللي يسويها هو — ما يشوف باقي ملفاتك في الدرايف.</p>
      <details ${gd.configured ? '' : 'open'}><summary><b>الخطوات</b></summary><ol class="small" style="padding-inline-start:20px;line-height:1.9">
        <li>افتح <a href="https://console.cloud.google.com/" target="_blank" rel="noopener" dir="ltr">console.cloud.google.com</a> بحساب قوقل اللي تبي النسخ فيه.</li>
        <li>فوق: <b dir="ltr">Select a project</b> ← <b dir="ltr">New project</b> ← الاسم <b dir="ltr">alsalam</b> ← <b dir="ltr">Create</b>.</li>
        <li>في البحث فوق اكتب <b dir="ltr">Google Drive API</b> ← افتحه ← <b dir="ltr">Enable</b>.</li>
        <li>في البحث اكتب <b dir="ltr">OAuth consent screen</b> ← <b dir="ltr">Get started</b>: اسم التطبيق «السلام»، إيميلك، <b dir="ltr">External</b> ← <b dir="ltr">Create</b>.</li>
        <li>من القائمة يسار: <b dir="ltr">Audience</b> ← <b dir="ltr">Publish app</b> ← <b dir="ltr">Confirm</b> (عشان الربط ما ينتهي بعد أسبوع).</li>
        <li>من القائمة يسار: <b dir="ltr">Clients</b> ← <b dir="ltr">Create client</b> ← النوع <b dir="ltr">Web application</b>.</li>
        <li>تحت <b dir="ltr">Authorized redirect URIs</b> اضغط <b dir="ltr">Add URI</b> وحط هذا الرابط بالضبط:
          <div class="row" style="margin:4px 0"><input id="gdRedir" readonly dir="ltr" value="${esc(gdRedirect())}" style="font-family:monospace;font-size:12px"><button class="btn small" id="gdCopy">نسخ</button></div> ← <b dir="ltr">Create</b>.</li>
        <li>انسخ <b dir="ltr">Client ID</b> و <b dir="ltr">Client secret</b> وحطهم تحت، واضغط «حفظ» ثم «اربط».</li>
        <li>قوقل بيقول <b dir="ltr">Google hasn't verified this app</b> — عادي لأنه تطبيقك أنت: <b dir="ltr">Advanced</b> ← <b dir="ltr">Go to السلام</b> ← <b dir="ltr">Continue</b>.</li></ol></details>
      <label class="f" style="margin-top:8px">Client ID<input id="gdId" dir="ltr" value="${esc(gd.client_id || '')}" placeholder="....apps.googleusercontent.com" autocomplete="off"></label>
      <label class="f">Client secret<input id="gdSec" dir="ltr" value="${gd.configured ? '••••••••' : ''}" autocomplete="off"></label>
      <div class="row" style="margin-top:8px"><button class="btn" id="gdSave">حفظ</button><button class="btn primary" id="gdAuth" ${gd.configured ? '' : 'disabled'}>اربط قوقل درايف</button></div>
      ${gd.last_error ? `<div class="alert red small" style="margin-top:8px">${esc(gd.last_error)}</div>` : ''}`}</div>`;
}
function bindGdrive(main, gd) {
  const on = (id, fn) => { const el = $('#' + id, main); if (el) el.onclick = e => busy(e.currentTarget, () => fn(e)); };
  on('gdCopy', async () => { const v = $('#gdRedir', main); v.select(); try { await navigator.clipboard.writeText(v.value); } catch { document.execCommand('copy'); } toast('انتسخ ✓'); });
  on('gdSave', async () => { await POST('/api/gdrive/config', { client_id: $('#gdId', main).value, client_secret: $('#gdSec', main).value }); toast('انحفظ ✓ — اضغط «اربط»'); route(); });
  on('gdAuth', async () => { const r = await POST('/api/gdrive/auth', { redirect: gdRedirect() }); location.href = r.url; });
  on('gdNow', async () => { const r = await api('POST', '/api/gdrive/backup', {}, 600000); toast(`انسخ ✓${r.images ? ` + ${r.images} صورة` : ''}${r.report ? ' + تقرير المحاسب' : ''}`); route(); });
  on('gdOff', async () => { if (await confirmBox('تلغي ربط قوقل درايف؟ النسخ اللي هناك تبقى.')) { await DEL('/api/gdrive'); route(); } });
}

// ===================== تقرير الشهر للمحاسب =====================
const addDaysStr = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
async function download(url, name) {
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + S.token } });
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'خطأ ' + res.status); }
  const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = name; document.body.appendChild(a); a.click(); a.remove();
}
async function pageMonthly(main, alive) {
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  const month = qs.get('m') || S.date.slice(0, 7);
  // فترة: من تاريخ لتاريخ (بدل الشهر)
  const rf = qs.get('from'), rt = qs.get('to'), range = rf && rt;
  const query = range ? `from=${rf}&to=${rt}` : 'month=' + month;
  const [r, gd] = await Promise.all([GET('/api/monthly-report?' + query), GET('/api/gdrive')]);
  if (!alive()) return;
  const m = r.summary;
  const st = (k, v, cls = '') => `<div class="stat ${cls}"><div class="k">${k}</div><div class="v">${money(v)}</div></div>`;
  main.innerHTML = `<div class="card"><div class="row" style="gap:6px;margin-bottom:8px"><button class="btn small ${range ? '' : 'primary'}" id="mrMode1">شهر</button><button class="btn small ${range ? 'primary' : ''}" id="mrMode2">من تاريخ لتاريخ</button></div>
      <div class="row">${range ? `<label class="f">من<input type="date" id="mrF" value="${rf}"></label><label class="f">إلى<input type="date" id="mrT" value="${rt}"></label><button class="btn" id="mrGo" style="align-self:flex-end">اعرض</button>` : `<label class="f">الشهر<input type="month" id="mrM" value="${month}"></label>`}
      <button class="btn primary" id="mrX" style="align-self:flex-end">⬇️ تنزيل Excel للمحاسب</button>
      <button class="btn" id="mrP" style="align-self:flex-end">📄 PDF للفترة</button>
      ${gd.connected ? '<button class="btn" id="mrD" style="align-self:flex-end">☁️ حطه في قوقل درايف</button>' : ''}</div>
      <p class="small muted">من ${m.from} إلى ${m.to} · ${m.days} يوم فيه حركة${m.days_not_closed ? ` · <span class="pos">${m.days_not_closed} يوم ما انقفل — اقفلها من «تقرير اليوم» قبل ما ترسله</span>` : ''}.
      الملف فيه: الملخص، كل يوم، المشتريات، المصروفات، سداد الموردين، الرواتب، ومبيعات الأصناف.</p>
      <div class="row" style="gap:6px;margin-top:6px">${[['week', 'آخر أسبوع'], ['month', 'آخر شهر'], ['quarter', 'آخر ٣ شهور'], ['year', 'آخر سنة']].map(([k, l]) => `<button class="btn small" data-pp="${k}">📄 ${l}</button>`).join('')}</div></div>
    <div class="grid" style="margin-bottom:12px">
      ${st('المبيعات', m.sales)}${st('تكلفة الوجبات', m.cogs)}${st('الربح الإجمالي', m.gross_profit, 'green')}
      ${st('المشتريات', m.purchases)}${st('المصروفات', m.expenses)}${st('الرواتب', m.salaries)}
      ${st('الربح التقريبي', m.net_estimate, m.net_estimate >= 0 ? 'green' : 'red')}
      ${st('نقص البضاعة', m.inventory_shortage, m.inventory_shortage > 0 ? 'red' : '')}${st('نقص الكاش', m.cash_shortage, m.cash_shortage > 0 ? 'red' : '')}
      ${st('علينا للموردين', m.suppliers_owed)}</div>
    <p class="small muted">«الربح التقريبي» = المبيعات − تكلفة الوجبات − المصروفات − الرواتب. الإيجار والضريبة وغيرها لو ما اتسجلت كمصروفات ما تدخل.</p>
    <div class="card"><h3>الأيام</h3><div class="tbl-wrap"><table><thead><tr><th>اليوم</th><th class="n">المبيعات</th><th class="n">كاش</th><th class="n">شبكة</th><th class="n">نقص الكاش</th><th class="n">المشتريات</th><th class="n">المصروفات</th><th class="n">نقص البضاعة</th></tr></thead><tbody>
      ${r.days.map(d => `<tr><td class="small">${d.date}${d.closed ? '' : ' <span class="badge amber">مو مقفل</span>'}</td><td class="n">${money(d.sales)}</td><td class="n">${money(d.cash)}</td><td class="n">${money(d.card)}</td>
        <td class="n ${d.cash_shortage > 0 ? 'pos' : ''}">${d.cash_shortage == null ? '—' : money(d.cash_shortage)}</td><td class="n">${money(d.purchases)}</td><td class="n">${money(d.expenses)}</td><td class="n">${money(d.shortage)}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">ما فيه</td></tr>'}
    </tbody></table></div></div>`;
  if ($('#mrM')) $('#mrM').onchange = e => { location.hash = '#/monthly?m=' + e.target.value; };
  $('#mrMode1').onclick = () => { location.hash = '#/monthly?m=' + month; };
  $('#mrMode2').onclick = () => { location.hash = `#/monthly?from=${rf || month + '-01'}&to=${rt || S.date}`; };
  if ($('#mrGo')) $('#mrGo').onclick = () => { const f = $('#mrF').value, t = $('#mrT').value; if (!f || !t) return toast('اختر التاريخين', true); location.hash = `#/monthly?from=${f}&to=${t}`; };
  $('#mrX').onclick = e => busy(e.currentTarget, () => download('/api/monthly-report/xlsx?' + query, range ? `تقرير-${rf}-إلى-${rt}.xlsx` : `تقرير-${month}.xlsx`));
  // 📄 PDF بنفس شكل تقرير اليوم: للفترة المعروضة، أو آخر أسبوع/شهر/٣ شهور/سنة لين أمس
  $('#mrP').onclick = e => busy(e.currentTarget, () => download(`/api/period-report.pdf?from=${m.from}&to=${m.to}`, `تقرير-${m.from}-${m.to}.pdf`));
  $$('[data-pp]', main).forEach(b => b.onclick = e => busy(e.currentTarget, () => {
    const to = addDaysStr(S.date, -1), back = { week: 6, month: 29, quarter: 90, year: 364 }[b.dataset.pp], from = addDaysStr(to, -back);
    return download(`/api/period-report.pdf?from=${from}&to=${to}&kind=${b.dataset.pp}`, `تقرير-${from}-${to}.pdf`);
  }));
  const d = range ? null : $('#mrD'); if ($('#mrD') && range) $('#mrD').hidden = true;
  if (d) d.onclick = e => busy(e.currentTarget, async () => { const x = await POST('/api/gdrive/report', { month }); toast('انحط في درايف ✓ ' + x.name); });
}

async function pageSettings(main, alive) {
  const s = isOwner() ? await GET('/api/settings') : null;
  const ck = isOwner() ? await GET('/api/settings/claude-key') : null;
  const gd = isOwner() ? await GET('/api/gdrive') : null;
  if (!alive()) return;
  const gq = new URLSearchParams(location.hash.split('?')[1] || '').get('gdrive');
  if (gq) { toast(gq === 'ok' ? 'انربط قوقل درايف ✓ — أول نسخة بدأت' : gq, gq !== 'ok'); history.replaceState(null, '', '#/settings'); }
  main.innerHTML = `
    ${s ? `<div class="card"><h3>لويفرس</h3>
      <p class="muted small">حط الرمز مرة وحدة (Loyverse ← الإعدادات ← Access Tokens). يسحب الأصناف والمبيعات المكتملة لحاله كل ١٠ دقايق ويحفظ كل الأيام، ويسوي وصفات مبدئية تعدلها.</p>
      <label class="f">رمز لويفرس<input id="lt" value="${esc(s.loyverse_token)}" autocomplete="off"></label>
      <div class="row"><label class="f">كم يوم يسحب أول مرة<input id="sd" inputmode="numeric" value="${esc(s.sync_days_back)}"></label>
        <label class="f">بداية يوم العمل (الساعة)<input id="dh" inputmode="numeric" value="${esc(s.day_start_hour)}"></label>
        <label class="f">آخر وقت لجرد أول اليوم (الساعة)<input id="oh" inputmode="numeric" value="${esc(s.opening_deadline_hour)}"></label></div>
      <label class="small" style="display:flex;gap:6px;align-items:center;margin-top:8px"><input type="checkbox" id="tc" ${s.ticket_in_cash === '1' ? 'checked' : ''}> فلوس تذكرة الكاشير تدخل الدرج كاش (تنضاف للكاش المفروض في التقرير)</label>
      <label class="f" style="margin-top:8px;max-width:320px">الفرق المقبول في مجموع التذكرة (ريال) — أكبر منه يعيد القراءة، وإذا ما ضبط ما تنحسب لين تراجعها<input id="tt" inputmode="decimal" value="${esc(s.ticket_tolerance || '10')}"></label>
      <h3 style="margin-top:14px">قراءة صور التذكرة</h3>
      <label class="f">مفتاح Anthropic API<input id="ak" value="${esc(s.anthropic_key)}" autocomplete="off" placeholder="sk-ant-…"></label>
      <p class="small muted">القراءة الأولى بنموذج سريع رخيص، وإذا المجموع ما طابق تنعاد بنموذج أقوى. تكلفة القراءة هالشهر تقريبًا: <b>${s.ocr_cost_month || 0} دولار</b></p>
      <h3 style="margin-top:14px">🤖 المساعد والتوصيات</h3>
      <p class="small muted">صرف المساعد هالشهر: <b>${s.ai_cost_month || 0} دولار</b> + قراءة التذاكر ${s.ocr_cost_month || 0}. إذا وصل الحد يوقف لين الشهر الجاي.</p>
      <div class="row"><label class="f" style="max-width:220px">الحد الشهري (دولار)<input id="aiCap" inputmode="decimal" value="${esc(s.ai_monthly_cap)}"></label>
        <label class="f" style="max-width:260px">أعلى نسبة تكلفة أكل مقبولة (%)<input id="mfc" inputmode="decimal" value="${esc(s.max_food_cost)}"></label></div>
      <div class="row" style="margin-top:6px"><button class="btn" id="aiUse">💰 صرف الذكاء بالتفصيل</button><button class="btn" id="kbFreeze">🧊 حدّث الدليل الحين</button></div>
      <div id="aiUseOut"></div>
      <p class="small muted">التوصيات تعتمد على سجل المبيعات. السجل عندنا من: <b>${esc(s.history_from || '—')}</b>. اسحب سنة كاملة من لويفرس (ببلاش، ياخذ دقايق — والأيام القديمة ما تأثر على المستودع).</p>
      <button class="btn" id="hist">اسحب سجل سنة من لويفرس</button>
      <details style="margin-top:10px"><summary class="small">المواسم (رمضان، العيد…) — تاريخها ونسبة الزيادة</summary>
        <div id="seasons"></div><button class="btn small" id="addSeason">+ موسم</button>
        <p class="small muted">النسبة 1.2 = البيع يزيد 20%، و1 = نفس العادة. عدّل التواريخ كل سنة (هجري).</p></details>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="save">حفظ</button><button class="btn" id="sync">اسحب الحين</button><button class="btn" id="full">اسحب كل الأيام من جديد</button></div>
      <p class="small muted">آخر سحب: ${s.last_receipt_sync ? ksa(s.last_receipt_sync) : 'ما سحب'}</p>
      <details><summary class="small">سجل السحب</summary>${s.log.map(l => `<div class="small ${l.ok ? '' : 'pos'}">${ksa(l.at)} — ${esc(l.message)}</div>`).join('')}</details></div>
    <div class="card"><h3>ربط Claude (المساعد)</h3>
      <p class="muted small">مفتاح يخلي Claude يدخل على النظام ويشوف كل شي ويضيف الوصفات. كل شي يسويه ينكتب باسم «Claude (المساعد)» وتقدر تعدّل عليه. تقدر تلغيه متى ما بغيت.</p>
      <div id="ckState" class="small" style="margin-bottom:8px">${ck && ck.active ? '<span class="badge green">المفتاح شغّال</span>' : '<span class="badge">ما فيه مفتاح</span>'}</div>
      <div class="row"><button class="btn primary" id="ckNew">${ck && ck.active ? 'سوّ مفتاح جديد (القديم يبطل)' : 'سوّ مفتاح لـ Claude'}</button>${ck && ck.active ? '<button class="btn danger" id="ckDel">إلغاء المفتاح</button>' : ''}</div>
      ${ck && ck.active ? `<label class="row small" style="margin-top:10px;gap:8px"><input type="checkbox" id="ckOwner" ${ck.owner ? 'checked' : ''}> 👑 Claude يقدر يسوي كل شي زي المالك (الإعدادات، الموظفين، تعديل المعتمد)</label>` : ''}
      <div id="ckOut"></div></div>` : ''}
    ${s ? '<div id="waCard"></div>' : ''}
    ${gd ? gdriveCard(gd) : ''}
    <div class="card"><h3>رقمي السري</h3><div class="row"><input id="np" inputmode="numeric" type="password" placeholder="الرقم الجديد" style="max-width:200px"><button class="btn" id="cp">تغيير</button></div></div>`;
  if (s) {
  const au = $('#aiUse'); if (au) au.onclick = () => busy(au, async () => { $('#aiUseOut').innerHTML = aiUsageHtml(await GET('/api/ai/usage?days=7')); });
  const kf = $('#kbFreeze'); if (kf) kf.onclick = () => busy(kf, async () => { await POST('/api/kb/refresh', {}); toast('انحدّث الدليل ✓ (الكاش بيتكتب من جديد مرة وحدة)'); });
    $('#save').onclick = e => busy(e.currentTarget, async () => {
      const seasons = $$('[data-season]', main).map(r => ({ name: $('[data-k=name]', r).value, from: $('[data-k=from]', r).value, to: $('[data-k=to]', r).value, factor: $('[data-k=factor]', r).value }));
      await POST('/api/settings', { loyverse_token: $('#lt').value, anthropic_key: $('#ak').value, sync_days_back: $('#sd').value, day_start_hour: $('#dh').value, opening_deadline_hour: $('#oh').value, ticket_in_cash: $('#tc').checked ? '1' : '0', ticket_tolerance: $('#tt').value, ai_monthly_cap: $('#aiCap').value, max_food_cost: $('#mfc').value, seasons });
      S.me = await GET('/api/me'); toast('انحفظ ✓ — السحب بدأ'); route();
    });
    $('#sync').onclick = e => busy(e.currentTarget, async () => { const r = await POST('/api/sync', {}); toast(r.message || 'تم', r.ok === false); route(); });
    $('#full').onclick = e => busy(e.currentTarget, async () => { const r = await POST('/api/sync', { full: true }); toast(r.message || 'تم', r.ok === false); route(); });
    $('#hist').onclick = e => busy(e.currentTarget, async () => { const r = await POST('/api/sync', { days: 365 }); toast(r.message || 'تم', r.ok === false); route(); });
    let seasons = []; try { seasons = JSON.parse(s.seasons || '[]'); } catch { seasons = []; }
    const seasonRow = x => `<div class="row" data-season style="margin:4px 0"><input data-k="name" value="${esc(x.name || '')}" placeholder="الاسم" style="max-width:140px">
      <input type="date" data-k="from" value="${esc(x.from || '')}"><input type="date" data-k="to" value="${esc(x.to || '')}">
      <input data-k="factor" inputmode="decimal" value="${esc(x.factor ?? 1)}" style="max-width:70px"><button class="btn small danger" data-del-season>✕</button></div>`;
    const drawSeasons = () => { $('#seasons').innerHTML = seasons.map(seasonRow).join(''); $$('[data-del-season]', main).forEach((b, i) => b.onclick = () => { seasons.splice(i, 1); drawSeasons(); }); };
    drawSeasons();
    $('#addSeason').onclick = () => { seasons = $$('[data-season]', main).map(r => ({ name: $('[data-k=name]', r).value, from: $('[data-k=from]', r).value, to: $('[data-k=to]', r).value, factor: $('[data-k=factor]', r).value })); seasons.push({ name: '', from: '', to: '', factor: 1 }); drawSeasons(); };
    // مفتاح Claude: يطلع مرة وحدة بس — ينسخ ويتحط في إعدادات بيئة Claude باسم ALSALAM_TOKEN
    $('#ckNew').onclick = e => busy(e.currentTarget, async () => {
      if (ck && ck.active && !await confirmBox('المفتاح القديم بيبطل. تكمّل؟')) return;
      const r = await POST('/api/settings/claude-key', {});
      $('#ckState').innerHTML = '<span class="badge green">المفتاح شغّال</span>';
      $('#ckOut').innerHTML = `<div class="alert amber" style="margin-top:10px"><b>انسخ المفتاح الحين — ما يطلع مرة ثانية.</b>
        <input id="ckVal" readonly value="${esc(r.token)}" style="margin:8px 0;direction:ltr;font-family:monospace;font-size:13px">
        <button class="btn primary" id="ckCopy">نسخ</button>
        <ol class="small" style="margin:8px 0 0;padding-inline-start:20px">
          <li>في Claude: من قائمة البيئة فوق في عنوان الجلسة ← Edit.</li>
          <li>تحت Network secrets (أو متغيّرات البيئة) أضف الاسم <b dir="ltr">ALSALAM_TOKEN</b> والقيمة هذا المفتاح.</li>
          <li>افتح جلسة جديدة مع Claude.</li>
          <li><b>لا ترسل المفتاح في المحادثة.</b></li></ol></div>`;
      $('#ckCopy').onclick = async () => {
        const v = $('#ckVal'); v.select();
        try { await navigator.clipboard.writeText(v.value); } catch { document.execCommand('copy'); }
        toast('انتسخ ✓');
      };
    });
    const co = $('#ckOwner');
    if (co) co.onchange = async () => {
      if (co.checked && !await confirmBox('Claude بيصير له صلاحية المالك كاملة. تكمّل؟')) { co.checked = false; return; }
      await PUT('/api/settings/claude-role', { owner: co.checked }); toast(co.checked ? 'صار مالك ✓' : 'رجع مشرف ✓');
    };
    const cd = $('#ckDel');
    if (cd) cd.onclick = async () => { if (await confirmBox('تلغي مفتاح Claude؟ ما يقدر يدخل بعدها.')) busy(cd, async () => { await DEL('/api/settings/claude-key'); toast('انلغى ✓'); route(); }); };
  }
  if (gd) bindGdrive(main, gd);
  if (s) waSettings($('#waCard'), s);
  $('#cp').onclick = e => busy(e.currentTarget, async () => { await POST('/api/me/pin', { pin: $('#np').value }); toast('تغيّر ✓'); $('#np').value = ''; });
}

// 🖨️ أرشيف «الطابعة»: كل تذكرة يحفظها الكاشير توصل هنا — نسخة ما تنحذف حتى لو انحذفت من الكاشير
// 👥 العملاء: الأسماء اللي ينكتب على التذاكر في الكاشير — كل واحد كم جا وكم صرف ووش أخذ
async function pageCustomers(main) {
  const r = await GET('/api/customers');
  let q = '';
  const draw = () => {
    const list = r.customers.filter(c => !q || c.name.includes(q));
    $('#custList', main).innerHTML = list.length ? `<div class="tbl-wrap"><table><thead><tr><th>العميل</th><th class="n">الزيارات</th><th class="n">المجموع</th><th>آخر زيارة</th></tr></thead><tbody>
      ${list.map(c => `<tr data-cust="${esc(c.name)}" style="cursor:pointer"><td><b>${esc(c.name)}</b></td><td class="n">${c.visits}</td><td class="n">${money(c.total)}</td><td class="small">${c.last}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">ما فيه عملاء بالاسم — لما الكاشير يكتب اسم الزبون على التذكرة يطلع هنا.</p>';
    $$('[data-cust]', main).forEach(tr => tr.onclick = () => {
      const c = r.customers.find(x => x.name === tr.dataset.cust); if (!c) return;
      modal('👤 ' + c.name, `<div class="grid" style="margin-bottom:8px">
          <div class="stat"><div class="k">الزيارات</div><div class="v">${c.visits}</div></div>
          <div class="stat"><div class="k">المجموع</div><div class="v">${money(c.total)}</div></div>
          <div class="stat"><div class="k">أول / آخر</div><div class="v small">${c.first} — ${c.last}</div></div></div>
        ${c.tickets.map(t => `<div class="card" style="margin:6px 0;padding:10px"><div class="row" style="justify-content:space-between"><b>${t.date} · #${esc(t.ticket_no || '')}</b>
          <span>${t.status === 'cancelled' ? '<span class="badge red">انلغت</span>' : money(t.value) + ' ريال'} <span class="muted small">${esc(t.dining || '')}</span></span></div>
          <div class="small">${t.items.map(i => `${esc(i.name)} × ${qtyFmt(i.qty)}${i.price ? ` <span class="muted">(${money(i.qty * i.price)})</span>` : ''}`).join(' · ') || '—'}</div>
          ${t.cancelled.length ? `<div class="small" style="color:var(--red)">ملغي: ${t.cancelled.map(i => `<s>${esc(i.name)} × ${qtyFmt(i.qty)}</s>`).join(' · ')}</div>` : ''}</div>`).join('')}
        <div class="row" style="margin-top:10px"><button class="btn" data-close>إغلاق</button></div>`);
    });
  };
  main.innerHTML = `<div class="card"><h3 style="margin-top:0">👥 العملاء</h3>
    <p class="small muted">من أسماء التذاكر في الكاشير (من ${r.from}). كل ما ينكتب نفس الاسم ينضاف عليه.</p>
    <input id="custQ" placeholder="ابحث بالاسم" style="margin-bottom:8px"><div id="custList"></div></div>`;
  $('#custQ', main).oninput = e => { q = e.target.value.trim(); draw(); };
  draw();
}

async function pagePrinter(main, alive) {
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  const day = qs.get('date') || S.date;
  const [r, tk] = await Promise.all([GET('/api/printer/jobs'), GET(`/api/printer/tickets?date=${day}`)]);
  if (!alive()) return;
  const real = r.jobs.filter(j => !j.junk), junk = r.jobs.filter(j => j.junk);
  const ips = r.ips, lastIp = real[0] && real[0].ip; // «اعتمد» بس لعنوان جا منه طباعة حقيقية
  main.innerHTML = `<div class="card"><h3>🖨️ تذاكر الكاشير</h3>
      <p class="small">كل تذكرة يحفظها الكاشير توصل هنا على طول. <b>هذي نسخة ما تنحذف ولا تتعدل — حتى لو انحذفت أو انلغت من الكاشير.</b> يشوفها المالك والمشرفين اللي لهم صلاحية المبيعات.</p>
      <p class="small muted">في جهاز الكاشير: الإعدادات ← الطابعات ← إضافة طابعة ← طابعة مطبخ، الاتصال Ethernet/Wi-Fi، وعنوان IP: <b dir="ltr">${esc(location.hostname.replace(/\.sslip\.io$/, '').replace(/-/g, '.'))}</b>، وحط عليها كل الفئات.</p>
      ${!isOwner() ? '' : `<p class="small">${ips.length ? `🔒 تقبل من: <span dir="ltr">${ips.map(esc).join('، ')}</span> <button class="btn small" id="prOpen">افتحها للكل</button>` : `🔓 تقبل من أي عنوان${lastIp ? ` — <button class="btn small primary" id="prLock">اعتمد جهاز المحل (<span dir="ltr">${esc(lastIp)}</span>) بس</button>` : ' — أول ما توصل تذكرة حقيقية من الكاشير يطلع لك زر تعتمد عنوانه'}`}</p>`}
      ${r.bridge.lan || r.bridge.online ? `<div class="alert ${r.bridge.online ? 'green' : 'amber'} small">📱 <b>طابعة المحل (جوال الجسر)</b> ${r.bridge.online ? 'متصلة' : 'مو متصلة الحين'}${r.bridge.lan ? ` — في الكاشير حط IP: <b dir="ltr">${esc(r.bridge.lan)}</b>` : ''}. لو فصل النت، الأوراق تنحفظ في الجوال وترتفع أول ما يرجع${r.bridge.queued ? ` — <b>تنتظر الحين ${r.bridge.queued} ورقة</b>` : ''}.
        <br><span class="muted">ثبّت عنوان الجوال (من إعدادات الواي فاي ← IP ثابت، أو من الراوتر) عشان ما يتغيّر.</span></div>` : `<p class="small muted">💡 أفضل: خلّ الكاشير يطبع على <b>جوال الجسر</b> في المحل (صفحة 📹 الكاميرات) — يشتغل حتى لو فصل النت.</p>`}
      ${isOwner() ? `<p class="small">🌐 منفذ الإنترنت: ${r.internet ? `<b>مفتوح</b> <button class="btn small" id="prNet" data-on="0">اقفله (بعد ما الكاشير ينقل للجوال)</button>` : `<b>مقفول</b> — الأوراق توصل من جوال المحل بس <button class="btn small" id="prNet" data-on="1">افتحه</button>`}</p>` : ''}
      ${r.junk && r.junk.n ? `<p class="small muted">🛡️ انرفض ${r.junk.n} طلب من برامج على الإنترنت تفحص المنافذ (مو من الكاشير) — عادي ومو خطر، المنفذ ما يعطي شي.</p>` : ''}
      ${isOwner() && r.rejected && r.rejected.ip ? `<div class="alert amber small">وصل ${r.rejected.n} طلب من عنوان مو معتمد <span dir="ltr">${esc(r.rejected.ip)}</span> (${esc(ksa(r.rejected.at))}) وما انحفظ. لو هذا المحل (تغيّر عنوان النت) <button class="btn small" id="prAdd">اعتمده</button></div>` : ''}
      <p class="small muted">المجموع: ${r.total}</p></div>
    ${printerTickets(tk, day)}
    <h3 style="margin:14px 4px 6px">🧾 الأوراق الخام</h3>
    ${real.map(j => `<div class="card"><div class="row" style="justify-content:space-between"><b>#${j.id}</b><span class="small muted">${esc(ksa(j.at))} · <span dir="ltr">${esc(j.ip)}</span> · ${j.bytes} بايت</span></div>
      ${j.text ? `<pre style="white-space:pre-wrap;font-family:inherit;margin:6px 0;max-height:320px;overflow:auto">${esc(j.text)}</pre>` : ''}
      ${j.has_image ? `<img data-pimg="${j.id}" alt="" style="max-width:100%;background:#fff;border:1px solid var(--line)">` : ''}
      ${!j.text && !j.has_image ? '<p class="small muted">ما فيه نص ولا صورة مقروءة</p>' : ''}
      <button class="btn small" data-praw="${j.id}">تنزيل الخام</button></div>`).join('') || '<div class="card muted">ما وصل شي من الكاشير للحين</div>'}
    ${junk.length ? `<details class="card"><summary class="small">🗑️ طلبات من الإنترنت (مو من الكاشير): ${junk.length}</summary>${junk.map(j => `<p class="small muted">#${j.id} · ${esc(ksa(j.at))} · <span dir="ltr">${esc(j.ip)}</span> · ${j.bytes} بايت</p>`).join('')}</details>` : ''}`;
  // الصور والخام بالتوكن (مو روابط مفتوحة)
  $$('[data-pimg]', main).forEach(async im => { try { const res = await fetch(`/api/printer/jobs/${im.dataset.pimg}/image`, { headers: { Authorization: 'Bearer ' + S.token } }); if (res.ok) im.src = URL.createObjectURL(await res.blob()); } catch { /* */ } });
  $$('[data-praw]', main).forEach(b => b.onclick = e => busy(e.currentTarget, () => download(`/api/printer/jobs/${b.dataset.praw}/raw`, `printer-${b.dataset.praw}.bin`)));
  const setIps = list => busy(null, async () => { await POST('/api/printer/ips', { ips: list }); toast('انحفظ ✓'); route(); });
  if ($('#prLock')) $('#prLock').onclick = () => setIps([lastIp]);
  if ($('#prOpen')) $('#prOpen').onclick = async () => { if (await confirmBox('تخليها تقبل من أي عنوان؟')) setIps([]); };
  if ($('#prAdd')) $('#prAdd').onclick = () => setIps([...ips, r.rejected.ip]);
  if ($('#prNet')) $('#prNet').onclick = async e => { const on = e.currentTarget.dataset.on === '1'; if (!on && !await confirmBox('تقفل منفذ الإنترنت؟ تأكد إن الكاشير صار يطبع على جوال المحل، وإلا الأوراق ما توصل.')) return; busy(null, async () => { await POST('/api/printer/internet', { on }); toast('انحفظ ✓'); route(); }); };
  $('#ptDay').onchange = e => { location.hash = `#/printer?date=${e.target.value}`; };
  if ($('#ptRead')) $('#ptRead').onclick = e => busy(e.currentTarget, async () => { await POST('/api/printer/read', {}); toast('انقرت ✓'); route(); });
  $$('details', main).forEach(d => d.addEventListener('toggle', () => { if (d.open) camImg(d); }, { once: true }));
  $$('[data-reread]', main).forEach(b => b.onclick = e => busy(e.currentTarget, async () => { await POST('/api/printer/read', { job_id: Number(b.dataset.reread) }); toast('انعادت القراءة ✓'); route(); }));
}

// التذاكر مجمّعة من أوراق المطبخ: الأصناف الحالية = اللي انطبع − اللي انلغى
const PT_STATUS = { open: ['مفتوحة', 'green'], edited: ['انشال منها شي', 'amber'], cancelled: ['انلغت بعد ما انطبعت', 'red'], cancel_only: ['إلغاء بس (انفتحت قبل الطابعة)', ''] };
const PT_KIND = { order: '🖨️ انطبع', cancel: '❌ انلغى' };
function printerTickets(tk, day) {
  const t = tk.total, by = t.by_dining;
  return `<div class="card"><h3>🎫 تذاكر اليوم <span class="small muted">(من أوراق المطبخ)</span></h3>
    <div class="row" style="align-items:flex-end;flex-wrap:wrap"><label class="f">اليوم<input type="date" id="ptDay" value="${day}"></label>
      ${tk.unread ? `<button class="btn small" id="ptRead">اقرأ الأوراق اللي ما انقرت (${tk.unread})</button>` : ''}</div>
    <div class="grid" style="margin:8px 0"><div class="stat"><div class="k">تذاكر</div><div class="v">${t.tickets}</div></div><div class="stat"><div class="k">قيمتها تقريبًا</div><div class="v">${money(t.value)}</div></div>
      <div class="stat ${t.cancelled ? 'red' : ''}"><div class="k">انلغت بعد ما انطبعت</div><div class="v">${t.cancelled}</div></div>
      <div class="stat"><div class="k">📸 التذاكر المصوّرة</div><div class="v">${money(tk.photo.value)}</div><div class="small muted">${tk.photo.tickets} تذكرة</div></div></div>
    <p class="small">🍽️ محلي ${by.dine_in || 0} · 🥡 سفري ${by.takeaway || 0} · 🛵 توصيل ${by.delivery || 0}${by[''] ? ` · ❔ ما ندري ${by['']}` : ''}</p>
    <p class="small muted">القيمة من أسعار لويفرس (ورقة المطبخ ما فيها أسعار). المقارنة مع المصوّرة أسبوع، وبعدها نقرر نوقف التصوير.</p>
    ${tk.errors.map(e => `<div class="alert amber small">ورقة #${e.job_id}: ${esc(e.error)} <button class="btn small" data-reread="${e.job_id}">أعد القراءة</button></div>`).join('')}</div>
    ${tk.tickets.map(x => `<div class="card"><div class="row" style="justify-content:space-between;flex-wrap:wrap"><b>${x.ticket_no ? '#' + esc(x.ticket_no) : 'بدون رقم'} — ${esc(x.name || '')}</b>
        <span><span class="badge">${esc(x.dining_label)}</span> <span class="badge ${PT_STATUS[x.status][1]}">${PT_STATUS[x.status][0]}</span></span></div>
      ${x.employee ? `<div class="small muted">${esc(x.employee)}</div>` : ''}
      <table style="margin-top:6px"><tbody>${x.lines.map(l => `<tr style="${l.qty <= 0 ? 'text-decoration:line-through;opacity:.6' : ''}"><td>${esc(l.name)}${l.product_id ? '' : ' <span class="badge amber">ما انربط</span>'}</td><td class="n">${fmt(Math.max(l.qty, 0), 3)}</td><td class="n small muted">${l.price ? money(l.price * Math.max(l.qty, 0)) : ''}</td></tr>`).join('')}</tbody></table>
      ${x.value ? `<p style="margin:4px 0"><b>${money(x.value)}</b>${x.unpriced ? ' <span class="small muted">(فيه أصناف بدون سعر)</span>' : ''}</p>` : ''}
      <details><summary class="small">السجل (${x.events.length})</summary>${x.events.map(e => `<div class="small">${PT_KIND[e.kind]} <span class="muted">${esc(e.printed_at || ksa(e.at))}</span> — ${e.items.map(i => `${fmt(i.qty, 3)} ${esc(i.name)}`).join('، ')} <button class="btn small" data-reread="${e.job_id}">أعد القراءة</button>${e.snap ? `<img data-cimg="${e.snap}" alt="" style="display:block;max-width:100%;margin-top:4px;border-radius:6px">` : ''}</div>`).join('')}</details></div>`).join('') || '<div class="card muted">ما فيه تذاكر مقروءة لهذا اليوم</div>'}`;
}

// 🥡 السفري والبلاستيك: المفروض راح (حسب طلبات السفري والتوصيل) مقابل اللي انشرى
const DIN = { out: 'سفري + توصيل', takeaway: 'سفري', delivery: 'توصيل' };
async function pagePackaging(main, alive) {
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  const from = qs.get('from') || S.date.slice(0, 8) + '01', to = qs.get('to') || S.date;
  const r = await GET(`/api/packaging?from=${from}&to=${to}`);
  if (!alive()) return;
  const sum = k => r.orders.days.reduce((s, d) => s + d[k], 0);
  const opt = (list, sel, lab) => list.map(x => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(lab(x))}</option>`).join('');
  const pLab = p => p.name + (p.variant ? ' — ' + p.variant : '');
  main.innerHTML = `<div class="card"><h3>🥡 السفري والبلاستيك</h3>
      <p class="small muted">من أوراق المطبخ نعرف كل طلب محلي ولا سفري ولا توصيل. ومن «وش ياخذ كل صنف» نحسب كم بلاستيك المفروض راح، ونقارنه باللي انشرى. <b>المشتريات تجي دفعات — فشوفها على شهر مو يوم.</b></p>
      <div class="row" style="flex-wrap:wrap"><label class="f">من<input type="date" id="pkF" value="${from}"></label><label class="f">إلى<input type="date" id="pkT" value="${to}"></label><button class="btn" id="pkGo" style="align-self:flex-end">اعرض</button></div></div>
    <div class="grid" style="margin-bottom:8px"><div class="stat"><div class="k">🍽️ محلي</div><div class="v">${sum('dine_in')}</div></div><div class="stat"><div class="k">🥡 سفري</div><div class="v">${sum('takeaway')}</div></div><div class="stat"><div class="k">🛵 توصيل</div><div class="v">${sum('delivery')}</div></div>${sum('unknown') ? `<div class="stat"><div class="k">❔ ما ندري</div><div class="v">${sum('unknown')}</div></div>` : ''}</div>
    ${r.unread ? `<div class="alert amber small">فيه ${r.unread} ورقة ما انقرت للحين — من صفحة «تذاكر الكاشير».</div>` : ''}
    <div class="card"><h3>المفروض مقابل اللي انشرى</h3><div class="tbl-wrap"><table><thead><tr><th>الصنف</th><th class="n">المفروض راح</th><th class="n">انشرى</th><th class="n">الفرق</th></tr></thead><tbody>
      ${r.items.map(i => `<tr><td>${esc(i.name)} <span class="small muted">${esc(i.unit)}</span>${i.unit_warn ? '<div class="small" style="color:var(--amber,#b45309)">⚠️ الوحدة «حبة» وسعرها كبير — غالبًا كرتون. حدد كم حبة فيه من «📦 وحدات الشراء»</div>' : ''}</td><td class="n">${fmt(i.expected, 1)}</td><td class="n">${fmt(i.bought, 1)}</td><td class="n" style="${i.diff > 0 && i.expected ? 'color:var(--red,#b91c1c)' : ''}">${i.expected ? fmt(i.diff, 1) : '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">ما فيه شي للحين</td></tr>'}
    </tbody></table></div><p class="small muted">الفرق = انشرى − المفروض. لو كبير على شهر: يا تغليف يروح زيادة (للمحلي، للعمال، أكثر من اللازم)، يا القاعدة تحتاج تعديل.</p>
    ${r.no_rule.length ? `<details><summary class="small">أصناف سفري ما لها قاعدة (${r.no_rule.length})</summary><p class="small">${r.no_rule.map(x => `${esc(x.name)} (${fmt(x.qty, 1)})`).join('، ')}</p></details>` : ''}</div>
    <div class="card"><h3>وش ياخذ كل صنف ${r.drafts ? `<span class="badge amber">${r.drafts} مسودة</span>` : ''}</h3>
      <div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:8px"><button class="btn primary" id="pkSug">🤖 اقترح التغليف</button>${r.drafts ? '<button class="btn" id="pkOk">اعتمد كل المسودات</button>' : ''}</div>
      <div class="tbl-wrap"><table><thead><tr><th>صنف البيع</th><th>للطلب</th><th>التغليف</th><th class="n">الكمية</th><th></th></tr></thead><tbody>
      ${r.rules.map(x => `<tr data-rule="${x.id}"><td><select data-k="product_id"><option value="">— لكل طلب —</option>${opt(r.products, x.product_id, pLab)}</select></td>
        <td><select data-k="dining">${Object.entries(DIN).map(([k, v]) => `<option value="${k}" ${x.dining === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
        <td><select data-k="item_id">${opt(r.pack_items, x.item_id, i => i.name)}</select></td><td><input data-k="qty" inputmode="decimal" value="${x.qty}" style="max-width:70px"></td>
        <td style="white-space:nowrap">${x.status === 'draft' ? '<span class="badge amber">مسودة</span> ' : ''}<button class="btn small" data-save>حفظ</button> <button class="btn small" data-del>✕</button></td></tr>`).join('')}
      <tr data-rule=""><td><select data-k="product_id"><option value="">— لكل طلب —</option>${opt(r.products, null, pLab)}</select></td><td><select data-k="dining">${Object.entries(DIN).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></td>
        <td><select data-k="item_id"><option value="">اختر</option>${opt(r.pack_items, null, i => i.name)}</select></td><td><input data-k="qty" inputmode="decimal" value="1" style="max-width:70px"></td><td><button class="btn small primary" data-save>➕ أضف</button></td></tr>
      </tbody></table></div></div>`;
  $('#pkGo').onclick = () => { location.hash = `#/packaging?from=${$('#pkF').value}&to=${$('#pkT').value}`; };
  $('#pkSug').onclick = e => busy(e.currentTarget, async () => { if (r.rules.some(x => x.status === 'draft') && !await confirmBox('المسودات الحالية تنمسح ويجي بدالها اقتراح جديد (المعتمد يبقى). نكمل؟')) return; const x = await POST('/api/packaging/suggest', {}); toast(`اقترح ${x.added} قاعدة — راجعها واعتمدها`); route(); });
  if ($('#pkOk')) $('#pkOk').onclick = e => busy(e.currentTarget, async () => { await POST('/api/packaging/rules', { approve_all: true }); toast('اعتمدت ✓'); route(); });
  $$('[data-rule]', main).forEach(tr => {
    const v = k => $(`[data-k="${k}"]`, tr).value;
    $('[data-save]', tr).onclick = e => busy(e.currentTarget, async () => { await POST('/api/packaging/rules', { id: Number(tr.dataset.rule) || undefined, product_id: v('product_id') || null, dining: v('dining'), item_id: Number(v('item_id')), qty: numIn(v('qty')) }); toast('انحفظ ✓'); route(); });
    const d = $('[data-del]', tr); if (d) d.onclick = e => busy(e.currentTarget, async () => { await DEL(`/api/packaging/rules/${tr.dataset.rule}`); route(); });
  });
}

// 📹 الكاميرات: جسر (جوال قديم في المحل) يكلم جهاز التسجيل ويرسل اللقطات — كلمة سر الكاميرات تقعد في الجوال بس
const CAM_REASON = { manual: '📸 يدوي', print: '🖨️ ورقة كاشير', cash: '💵 تسجيل الكاش', announce: '📢 تعريف', playback: '⏪ من التسجيل', attendance: '👋 حضور', inspect: '⚠️ فحص إجادة', wa: '📹 واتساب' };
const CAM_INTRO = 'السلام عليكم 👋\nمن اليوم النظام *مربوط بالكاميرات* 📹 — يشوف المحل والكاشير والمطبخ، ويحفظ صورة مع كل تذكرة وكل تسجيل كاش.\nهذي لقطة من الحين 👇\nخلونا نشتغل مرتبين والله يوفقكم 🌹';
const camImg = (box) => $$('[data-cimg]', box).forEach(async im => { try { const res = await fetch(`/api/cam/snaps/${im.dataset.cimg}/image`, { headers: { Authorization: 'Bearer ' + S.token } }); if (res.ok) im.src = URL.createObjectURL(await res.blob()); } catch { /* */ } });
async function pageCameras(main, alive) {
  const r = await GET('/api/cam');
  if (!alive()) return;
  const host = location.origin;
  // 📋 أوامر جوال الجسر — كل أمر بزر نسخ. التنزيل بـ node (curl في Termux أحيانًا يخرب: CANNOT LINK EXECUTABLE)
  const CMDS = [
    ['١- تحديث Termux (مرة وحدة) — لو سأل سؤال اضغط Enter', 'apt update && apt full-upgrade -y'],
    ['٢- تثبيت البرنامج', 'pkg install -y nodejs'],
    ['٣- ربط الجسر (في المحل: بعد واي فاي المحل، واطلع رمز الربط تحت قبلها)', `node -e "fetch('${host}/api/cam/bridge.js').then(r=>r.text()).then(t=>require('fs').writeFileSync('bridge.js',t))" && while true; do BRIDGE_LOOP=1 node bridge.js ${host}; sleep 5; done`],
    ['٤- تشغيله مرة ثانية (لو انطفى الجوال أو سكّرت Termux)', `while true; do BRIDGE_LOOP=1 node bridge.js ${host}; sleep 5; done`],
    ['٥- «⏪ رجوع للتسجيل» (مرة وحدة): يثبّت ffmpeg ويحدّث الجسر ويشغّله', `pkg install -y ffmpeg && node -e "fetch('${host}/api/cam/bridge.js').then(r=>r.text()).then(t=>require('fs').writeFileSync('bridge.js',t))" && while true; do BRIDGE_LOOP=1 node bridge.js ${host}; sleep 5; done`],
  ];
  const cmdBox = (t, c, i) => `<div style="margin:6px 0"><div class="small"><b>${esc(t)}</b></div><div class="row" style="gap:6px;align-items:stretch"><pre dir="ltr" data-cmd="${i}" style="flex:1;margin:0;white-space:pre-wrap;word-break:break-all;user-select:all;background:var(--soft,#f3f4f6);padding:6px;border-radius:6px">${esc(c)}</pre><button class="btn small" data-copy="${i}">📋 نسخ</button></div></div>`;
  main.innerHTML = `<div class="card"><h3>📹 الكاميرات ${r.online ? '<span class="badge green">الجسر متصل</span>' : r.linked ? '<span class="badge amber">الجسر مو متصل</span>' : '<span class="badge">مو مربوط</span>'}</h3>
      <p class="small">جوال قديم في المحل (على الشاحن والواي فاي) يصير <b>جسر</b>: يكلم جهاز تسجيل الكاميرات ويرسل اللقطات، ويصير كمان <b>طابعة المحل</b> للكاشير (الأوراق تنحفظ فيه لو فصل النت). جهاز التسجيل ما ينفتح للإنترنت، و<b>كلمة سر الكاميرات تنكتب في الجوال بس</b>.</p>
      ${r.seen ? `<p class="small muted">آخر اتصال: ${esc(ksa(r.seen))}</p>` : ''}
      ${r.errors.length ? `<div class="alert amber small">${r.errors.map(e => `كاميرا ${e.ch}: ${esc(e.error)}`).join('<br>')}</div>` : ''}
      ${r.linked && isSup() ? `<div class="alert amber small" style="margin:8px 0"><b>🔄 تحديث الجسر (مرة وحدة — بعدها يحدّث نفسه):</b> في جوال الجسر افتح Termux ← اضغط <b>CTRL</b> وبعدها حرف <b>c</b> ← انسخ الأمر تحت والصقه (ضغطة طويلة ← Paste) ← Enter. ما بيسألك شي.${cmdBox('أمر التحديث', CMDS[2][1], 'u')}</div>` : ''}
      ${isOwner() ? `<details ${r.linked ? '' : 'open'}><summary><b>${r.linked ? 'إعادة ربط الجسر' : 'كيف أربط؟'}</b></summary><ol class="small" style="padding-inline-start:18px;line-height:1.9">
        <li>في جهاز التسجيل (أو تطبيق Hik-Connect): سوّ <b>مستخدم جديد صلاحيته «مشاهدة بس»</b>.</li>
        <li>في الجوال القديم: ثبّت <b>Termux</b> من متجر F-Droid (مو من قوقل بلاي).</li>
        <li>افتح Termux، وانسخ الأوامر بالترتيب (زر «📋 نسخ») والصقها (ضغطة طويلة في الشاشة السودا ← Paste) واضغط Enter:${CMDS.slice(0, 4).map(([t, c], i) => cmdBox(t, c, i)).join('')}</li>
        <li>بيسألك: عنوان جهاز التسجيل (مثل 192.168.1.64) — <b>اتركه فاضي لو تبغى الطابعة بس للحين</b> — والمستخدم وكلمة السر، و<b>رمز الربط</b>:</li><li>بيطلع لك <b>IP الجوال</b> — حطه في الكاشير: الإعدادات ← الطابعات ← طابعتنا ← عنوان IP.</li></ol>
        <button class="btn primary" id="camPair">اطلع رمز ربط</button> <span id="camCode" style="font-size:1.4em;font-weight:700;letter-spacing:3px" dir="ltr"></span>
        ${r.linked ? '<button class="btn small" id="camUnlink" style="margin-inline-start:8px">فك الربط</button>' : ''}
        <p class="small muted">خلّ الجوال على الشاحن، وفي إعدادات البطارية: Termux «بدون تقييد».</p></details>` : ''}</div>
    ${r.channels.length ? `<div class="card"><h3>الكاميرات (${r.channels.length})</h3><p class="small muted">حدد كاميرا <b>الكاشير</b> — منها تنحفظ لقطة مع كل ورقة طابعة وكل تسجيل كاش.</p>
      ${r.channels.map(c => `<div class="row" style="align-items:center;gap:6px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding:6px 0" data-ch="${c.ch}">
        ${isOwner() ? `<input data-k="name" value="${esc(c.name)}" style="max-width:160px"><select data-k="role" style="width:auto"><option value="">—</option>${Object.entries(r.roles).map(([k, v]) => `<option value="${k}" ${c.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select>` : `<b>${esc(c.name)}</b> ${c.role ? `<span class="badge">${r.roles[c.role]}</span>` : ''}`}
        <button class="btn small" data-snap="${c.ch}" ${r.online ? '' : 'disabled'}>📸 لقطة الحين</button></div>`).join('')}
      ${isOwner() ? '<button class="btn primary" id="camSave" style="margin-top:8px">حفظ الأسماء</button>' : ''}</div>` : ''}
    ${isOwner() && r.channels.length ? `<div class="card"><h3>📢 عرّف العمال</h3><p class="small muted">مرة وحدة: رسالة في جروب المطعم ومعها لقطة حيّة من كاميرا تختارها — عشان يعرفون إن النظام مربوط. بعدها ولا صورة في القروب (التنبيهات لك وللمشرفين في الخاص).</p>
      <textarea id="camTxt" rows="5" style="width:100%">${esc(CAM_INTRO)}</textarea>
      <div class="row" style="align-items:flex-end;gap:6px"><label class="f">من كاميرا<select id="camAnCh">${r.channels.map(c => `<option value="${c.ch}" ${c.role === 'kitchen' || c.role === 'hall' ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label><button class="btn primary" id="camAnn" ${r.online ? '' : 'disabled'}>📢 أرسل</button></div></div>
    <div class="card"><h3>⚙️</h3><div class="row" style="align-items:flex-end;flex-wrap:wrap;gap:6px"><label class="f">تنحفظ (يوم)<input id="camKeep" inputmode="numeric" value="${r.keep_days}" style="max-width:80px"></label>
      <label class="f">نبّهني لو نقص الكاش أكثر من (ريال)<input id="camShort" inputmode="numeric" value="${r.alert_short}" style="max-width:80px"></label><button class="btn" id="camSet">حفظ</button></div></div>` : ''}
    ${isOwner() && r.channels.length ? `<div class="card"><h3>⏪ رجوع للتسجيل</h3><p class="small muted">لقطات من وقت فات (من جهاز التسجيل): اختر الكاميرا والوقت، وكم لقطة وكل كم دقيقة. يحتاج في جوال الجسر <b dir="ltr">pkg install -y ffmpeg</b>، ومستخدم الجسر في جهاز التسجيل له صلاحية «تشغيل التسجيل».</p>
      <details class="small" style="margin-bottom:8px"><summary><b>أول مرة: أمر جوال الجسر</b> — في Termux اضغط CTRL وبعدها c، وانسخ الأمر والصقه واضغط Enter</summary>${cmdBox('ثبّت ffmpeg وحدّث الجسر', CMDS[4][1], 4)}</details>
      <div class="row" style="align-items:flex-end;flex-wrap:wrap;gap:6px"><label class="f">الكاميرا<select id="pbCh">${r.channels.map(c => `<option value="${c.ch}">${esc(c.name)}</option>`).join('')}</select></label>
        <label class="f">من<input type="datetime-local" id="pbFrom" value="${esc(S.date)}T09:00"></label>
        <label class="f">كل (دقيقة)<input id="pbEvery" inputmode="decimal" value="2" style="max-width:70px"></label>
        <label class="f">كم لقطة<input id="pbCount" inputmode="numeric" value="12" style="max-width:70px"></label>
        <button class="btn primary" id="pbGo" ${r.online ? '' : 'disabled'}>⏪ جيب</button></div><div id="pbOut" style="margin-top:8px"></div></div>` : ''}
    ${isOwner() && r.channels.length ? `<div class="card" id="iwCard"><h3>⚠️ تنبيه «إجادة في المحل»</h3><p class="small muted">كل شوي لقطة من كاميرات الكاشير، والذكاء (الرخيص) يشوف: فيه مفتش بزي إجادة (كحلي + خطوط عاكسة + كاب)؟ لو فيه => صورة وتنبيه في جروب المطعم ولك، مرة كل نص ساعة. اللقطة اللي ما فيها شي تنمسح، ولو المنظر ما تغيّر ما ينسأل الذكاء.</p><div id="iwBody" class="small muted">…</div></div>` : ''}
    <div class="card"><h3>آخر اللقطات</h3><div class="grid">${r.snaps.map(x => `<div><img data-cimg="${x.id}" alt="" style="width:100%;border-radius:6px;background:#000;aspect-ratio:16/9;object-fit:cover"><div class="small muted">${esc(x.cam)} · ${CAM_REASON[x.reason] || esc(x.reason)}<br>${esc(ksa(x.at))}</div></div>`).join('') || '<p class="muted">ما فيه لقطات للحين</p>'}</div></div>`;
  camImg(main);
  const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = e => busy(e.currentTarget, fn); };
  $$('[data-copy]', main).forEach(b => b.onclick = async () => {
    const c = CMDS[b.dataset.copy === 'u' ? 2 : Number(b.dataset.copy)][1];
    try { await navigator.clipboard.writeText(c); toast('انسخ ✓ — الصقه في Termux'); }
    catch { const pre = $(`[data-cmd="${b.dataset.copy}"]`, main), r = document.createRange(); r.selectNodeContents(pre); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('حددته — اضغط نسخ من القائمة'); }
  });
  on('camPair', async () => { const x = await POST('/api/cam/pair', {}); $('#camCode').textContent = x.code; toast(`الرمز يشتغل ${x.minutes} دقائق ومرة وحدة`); });
  on('camUnlink', async () => { if (await confirmBox('تفك ربط الجسر؟ يوقف لين تربطه من جديد.')) { await POST('/api/cam/unlink', {}); route(); } });
  on('camSave', async () => { await POST('/api/cam/channels', { channels: $$('[data-ch]', main).map(x => ({ ch: Number(x.dataset.ch), name: $('[data-k="name"]', x).value, role: $('[data-k="role"]', x).value })) }); toast('انحفظ ✓'); route(); });
  on('camAnn', async () => { if (!await confirmBox('ترسل الرسالة واللقطة في جروب المطعم؟')) return; await POST('/api/cam/announce', { ch: Number($('#camAnCh').value), text: $('#camTxt').value }); toast('انرسلت ✓'); });
  on('pbGo', async () => {
    const x = await POST('/api/cam/playback', { ch: Number($('#pbCh').value), from: $('#pbFrom').value, every: numIn($('#pbEvery').value), count: numIn($('#pbCount').value) });
    const out = $('#pbOut'); let shown = 0;
    for (let i = 0; i < 300; i++) {
      const p = await GET('/api/cam/playback/' + x.ref);
      if (p.snaps.length !== shown) {
        shown = p.snaps.length;
        out.innerHTML = `<div class="grid">${p.snaps.map(s => `<div><img data-cimg="${s.id}" alt="" style="width:100%;border-radius:6px;background:#000;aspect-ratio:16/9;object-fit:cover"><div class="small muted">${esc(s.pb_at.replace('T', ' ').slice(0, 16))}</div></div>`).join('')}</div>`;
        camImg(out);
      }
      const msg = p.waiting ? `⏳ باقي ${p.waiting}…` : `✓ وصلت ${p.snaps.length}${p.failed ? ` — ما وصلت ${p.failed}` : ''}`;
      out.insertAdjacentHTML('afterbegin', `<div class="small" data-pbst>${esc(msg)}${p.errors.length ? `<div class="alert amber small">${p.errors.map(esc).join('<br>')}</div>` : ''}</div>`);
      $$('[data-pbst]', out).slice(1).forEach(e => e.remove());
      if (!p.waiting) break;
      await new Promise(res => setTimeout(res, 2000));
    }
  });
  const iw = $('#iwBody');
  if (iw) {
    const drawIw = x => {
      iw.innerHTML = `<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="iwOn" ${x.on ? 'checked' : ''}> <b>شغّال</b></label>
        <label class="f" style="margin-top:6px">متى يفحص؟<select id="iwMode"><option value="events" ${x.mode === 'events' ? 'selected' : ''}>🧍 بس لما الجهاز يشوف شخص داخل (أرخص)</option><option value="interval" ${x.mode === 'interval' ? 'selected' : ''}>⏱️ كل كم ثانية</option></select></label>
        <div class="row" style="align-items:flex-end;flex-wrap:wrap;gap:6px;margin-top:6px"><label class="f">كشف الإنسان في جهاز التسجيل على<select id="iwDetCh">${r.channels.map(c => `<option value="${c.ch}" ${c.ch === 15 ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
          <button class="btn" id="iwDet">🧍 فعّل</button><button class="btn small" id="iwDetOff">طفّه</button></div>
        <div class="small muted">${x.events_seen ? `آخر حدث من الجهاز: ${esc(ksa(x.events_seen))}` : 'للحين ما وصل حدث من الجهاز'}${x.events ? ` · ${x.events} حدث من آخر تشغيل` : ''}</div>
        <div class="row" style="align-items:flex-end;flex-wrap:wrap;gap:6px;margin-top:6px"><label class="f">كل (ثانية)<input id="iwEvery" inputmode="numeric" value="${x.every}" style="max-width:70px"></label>
          <label class="f">من الساعة<input id="iwFrom" inputmode="numeric" value="${x.from}" style="max-width:60px"></label><label class="f">لين (25 = 1 الفجر)<input id="iwTo" inputmode="numeric" value="${x.to}" style="max-width:60px"></label>
          <button class="btn primary" id="iwSave">حفظ</button><button class="btn" id="iwTest">🔍 جرّب الحين</button></div>
        <div class="small muted" style="margin-top:6px">صرف هالشهر: ${money(x.ai_month)}$ · ${x.on ? `أقصى ${x.per_day} فحص باليوم` : 'مطفي'}${x.last ? ` · آخر فحص ${esc(ksa(x.last))}` : ''}${x.last_hit ? ` · آخر مرة شافهم: ${esc(ksa(x.last_hit))}` : ''}</div>`;
      $('#iwDet').onclick = e => busy(e.currentTarget, async () => { if (!await confirmBox('تفعّل «كشف دخول الإنسان» في جهاز التسجيل على هالكاميرا؟ (يغيّر هالإعداد بس)')) return; const d = await POST('/api/cam/detect', { ch: Number($('#iwDetCh').value) }); toast(d.enabled ? '✓ انفعّل في الجهاز' : '⚠️ ما انفعّل — شيك الجهاز', !d.enabled); });
      $('#iwDetOff').onclick = e => busy(e.currentTarget, async () => { await POST('/api/cam/detect', { ch: Number($('#iwDetCh').value), on: false }); toast('انطفى'); });
      $('#iwSave').onclick = e => busy(e.currentTarget, async () => { drawIw(await POST('/api/cam/inspect-watch', { on: $('#iwOn').checked, mode: $('#iwMode').value, every: numIn($('#iwEvery').value), from: numIn($('#iwFrom').value), to: numIn($('#iwTo').value) })); toast('انحفظ ✓'); });
      $('#iwTest').onclick = e => busy(e.currentTarget, async () => { const y = await POST('/api/cam/inspect-watch', { test: true }); drawIw(y); const t = y.test || {}; toast(t.error ? '⚠️ ' + t.error : t.inspector ? `⚠️ شاف مفتش (${t.confidence}٪) — ${t.note || ''}` : t.skipped ? t.skipped : '✓ ما فيه مفتش الحين', !!t.error); });
    };
    GET('/api/cam/inspect-watch').then(drawIw).catch(er => { iw.textContent = er.message; });
  }
  on('camSet', async () => { await POST('/api/cam/settings', { keep_days: numIn($('#camKeep').value), alert_short: numIn($('#camShort').value) }); toast('انحفظ ✓'); });
  $$('[data-snap]', main).forEach(b => b.onclick = e => busy(e.currentTarget, async () => { await POST('/api/cam/snap', { ch: Number(b.dataset.snap) }); route(); }));
}

// 💡 اقتراحات العمال (من المساعد): توافق => تنفذ لحالها، والتطوير ينجمع للبرمجة
const SG_STATUS = { pending: ['ينتظر ردك', 'amber'], done: ['اتنفذ', 'green'], approved: ['موافق', 'green'], rejected: ['مرفوض', ''], failed: ['ما قدر ينفذ', 'red'] };
async function pageSuggestions(main, alive) {
  const r = await GET('/api/suggestions');
  if (!alive()) return;
  const row = x => `<div class="card"><div class="row" style="justify-content:space-between;flex-wrap:wrap"><b>#${x.id} ${esc(r.kinds[x.kind] || x.kind)}</b><span class="badge ${SG_STATUS[x.status][1]}">${SG_STATUS[x.status][0]}</span></div>
    <p style="margin:6px 0">${esc(x.summary)}</p><p class="small muted">${esc(x.by_name || '')} · ${esc(ksa(x.at))}${x.result ? ' · ' + esc(x.result) : ''}</p>
    ${x.status === 'pending' ? `<div class="row" style="gap:6px"><button class="btn primary small" data-sg="${x.id}" data-ok="1">✓ موافق${x.action ? ' (ينفذ)' : ''}</button><button class="btn small" data-sg="${x.id}" data-ok="0">✗ ارفض</button></div>` : ''}</div>`;
  const pend = r.rows.filter(x => x.status === 'pending'), rest = r.rows.filter(x => x.status !== 'pending');
  main.innerHTML = `<div class="card"><h3>💡 اقتراحات العمال</h3><p class="small muted">المساعد ينفذ الشي العادي لحاله (شراء، جرد الموظف نفسه، صنف جديد من فاتورة…). اللي يأثر كثير (مسؤول صنف، اسم صنف، جرد يوم فات أو موظف ثاني) يوصلك هنا وفي الواتساب — ترد «موافق رقم» أو «ارفض رقم». و«تطوير للنظام» ينجمع وتوصلك قائمته كل خميس.</p></div>
    ${pend.map(row).join('') || '<div class="card muted">ما فيه شي ينتظر 👌</div>'}
    ${rest.length ? `<details class="card"><summary>اللي انحسم (${rest.length})</summary>${rest.map(row).join('')}</details>` : ''}`;
  $$('[data-sg]', main).forEach(b => b.onclick = e => busy(e.currentTarget, async () => { const x = await POST('/api/suggestions/' + b.dataset.sg, { approve: b.dataset.ok === '1' }); toast(SG_STATUS[x.status] ? SG_STATUS[x.status][0] : 'تم'); route(); }));
}

// 📘 دليل المطعم: اللي يعرفه المساعد عن شغل المحل — يتعلم منك ومن المشرفين على طول، ومن العمال بموافقتك، وكل خميس يراجع الأسبوع
const KB_SRC = { seed: 'البداية', owner: 'نوح', sup: 'مشرف', worker: 'عامل (بموافقتك)', review: 'مراجعة الخميس' };
async function pageKb(main, alive) {
  const r = await GET('/api/kb');
  if (!alive()) return;
  const own = isOwner();
  main.innerHTML = `<div class="card"><h3>📘 دليل المطعم</h3><p class="small muted">هذا اللي يعرفه المساعد عن شغلكم — يقراه في كل محادثة. يتعلم لحاله: لما تقول له أنت أو المشرف «اعرف إن…» أو تصححه يحفظها على طول؛ اللي يقوله العامل يوصلك تعتمده («موافق رقم»)؛ وكل خميس يراجع محادثات الأسبوع ويقترح عليك اللي تعلمه.</p>
      ${own ? `<div class="row" style="flex-wrap:wrap;align-items:flex-end;gap:6px"><label class="f">الموضوع<select id="kbT">${r.topics.map(t => `<option>${esc(t)}</option>`).join('')}</select></label><label class="f grow">المعلومة<input id="kbX" placeholder="مثلًا: الحريد ينزل صندوق للمحل ويتنظف قبل الجرد"></label><button class="btn primary" id="kbAdd">➕ أضف</button><button class="btn" id="kbRev">🔁 راجع الأسبوع الحين</button></div>` : ''}</div>
    ${r.topics.map(t => { const rows = r.rows.filter(x => x.topic === t); return rows.length ? `<div class="card"><h4 style="margin:0 0 6px">${esc(t)}</h4>${rows.map(x => `<div class="row" style="justify-content:space-between;align-items:flex-start;border-bottom:1px solid var(--line);padding:6px 0;gap:6px"><div><span class="small muted">[${x.id}]</span> ${esc(x.text)}<div class="small muted">${esc(KB_SRC[x.source] || x.source)}${x.by_name ? ' · ' + esc(x.by_name) : ''} · ${esc(ksa(x.at))}</div></div>${own ? `<span style="white-space:nowrap"><button class="btn small" data-kbe="${x.id}">✏️</button> <button class="btn small" data-kbd="${x.id}">✕</button></span>` : ''}</div>`).join('')}</div>` : ''; }).join('')}
    ${r.generated ? `<details class="card"><summary class="small">من النظام (يتحدث لحاله: الأقسام، طريقة الأصناف، الموردين)</summary><pre style="white-space:pre-wrap;font-family:inherit" class="small">${esc(r.generated)}</pre></details>` : ''}`;
  const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = e => busy(e.currentTarget, fn); };
  on('kbAdd', async () => { const x = $('#kbX').value.trim(); if (!x) throw new Error('اكتب المعلومة'); await POST('/api/kb', { topic: $('#kbT').value, text: x }); toast('انحفظت ✓'); route(); });
  on('kbRev', async () => { const x = await POST('/api/kb/review', {}); toast(x.lessons && x.lessons.length ? `طلع ${x.lessons.length} شي جديد — شوفها في «اقتراحات العمال»` : 'ما فيه شي جديد هالأسبوع'); });
  $$('[data-kbd]', main).forEach(b => b.onclick = async () => { if (await confirmBox('تحذف المعلومة من الدليل؟')) busy(b, async () => { await DEL('/api/kb/' + b.dataset.kbd); route(); }); });
  $$('[data-kbe]', main).forEach(b => b.onclick = () => {
    const x = r.rows.find(y => y.id === Number(b.dataset.kbe));
    modal('تعديل المعلومة', `<label class="f">الموضوع<select id="kbeT">${r.topics.map(t => `<option ${t === x.topic ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label><label class="f">المعلومة<textarea id="kbeX" rows="4" style="width:100%">${esc(x.text)}</textarea></label><div class="row" style="margin-top:10px"><button class="btn primary" id="kbeOk">حفظ</button><button class="btn" data-close>إلغاء</button></div>`, (m, close) => {
      $('#kbeOk', m).onclick = e => busy(e.currentTarget, async () => { await POST('/api/kb', { topic: $('#kbeT', m).value, text: $('#kbeX', m).value, replaces: x.id }); close(); route(); });
    });
  });
}

// رسالة التعريف الجاهزة (📢 رسالة للكل)
const WA_INTRO = "السلام عليكم ورحمة الله وبركاته 👋\n\nمعكم *النظام الجديد* — نظام الذكاء الاصطناعي الخاص بمطعم السلام 🤖\n\nأنا زميلكم، أساعدكم وأسهّل عليكم الشغل… بس انتبهوا: *أنا أسجّل كل شي، وما يفوتني شي* 👀\n\n📋 *الجرد أهم شي — وما فيه تهاون:*\n• *أول الدوام:* الجرد قبل الساعة ١٢ الظهر\n• *آخر الدوام:* الجرد قبل ما تقفل وتطلع\n• *الأرقام لازم تكون صحيحة* — عدّ زين قبل ما ترسل\n• اللي ما يجرد في وقته *يتسجل عليه*، ويطلع اسمه هنا قدام الكل\n• *النقص ينحسب على اللي قفل الجرد*\n\nالجرد هو اللي يحمي المطعم ويحميك أنت. لو أرقامك صحيحة ما أحد يقدر يتكلم عليك.\n\n*كيف تجرد؟* أرسل لي في الخاص:\n«آخر الدوام: فول ٣، عدس ٢»\nأرد عليك بالملخص ← ترد *تمام* ← يتسجل باسمك.\n\n⚠️ *النظام:*\nلو انذكرت عليك مشكلة (تأخير، جرد ناقص، إهمال…):\n• *أول مرة:* تذكير في الخاص\n• *ثاني مرة:* تنبيه\n• *ثالث مرة بنفس الشهر:* خصم 🤏 — *وما فيه نقاش*\n• وكل مرة بعدها الخصم يزيد\n\n🛒 *الطلبات:* ناقصكم شي؟ اكتبوه هنا في القروب ويوصل لزكريا.\n\n🛠️ *مشكلة حقيقية؟* لو صار لك غلط في الأرقام أو لخبطة في النظام، أرسلها لي في الخاص *على طول* — توصل لنوح ونحلها. بس العذر بعد ما يفوت الوقت *ما ينقبل* 🙏\n\n👏 *والملتزم له تقدير:* كل خميس أذكر الملتزمين هنا بالاسم — اللي جرده في وقته وبدون نقص يستاهل الكل يعرفه 🌹\n\nالشغل الزين يبان… والإهمال يبان 💪";
// 📱 الواتساب: العمال يرسلون الجرد والمشتريات لرقم المطعم => المساعد يجهّز => «تمام» => يتسجل
// الطريقة: ربط رقم (QR، يدخل القروبات) أو واتساب الرسمي
async function waSettings(box, s) {
  const [st, ln] = await Promise.all([GET('/api/whatsapp/status'), GET('/api/whatsapp/link')]);
  if (!box.isConnected) return;
  const hook = location.origin + '/api/whatsapp';
  const link = ln.mode === 'link';
  const ROLES = [['', 'تجاهل'], ['restaurant', 'جروب المطعم'], ['daily', 'حساب اليوم']];
  let chaseNotify = []; try { chaseNotify = JSON.parse(s.wa_chase_notify || '[]').map(Number); } catch { /* */ }
  const linkHtml = `
    <p class="small">رقم واتساب عادي (يفضّل رقم خاص بالشغل) ينربط كجهاز مرتبط: يرسل له الموظفين الجرد والمشتريات، ويقرأ القروبات اللي تفعّلها (ما يرد فيها أبدًا). <b>يرسل للموظفين المسجلين بس.</b></p>
    ${ln.status === 'open' ? `<p>✅ مربوط${ln.me ? ` — <span dir="ltr">${esc(ln.me)}</span>` : ''}</p>`
      : ln.status === 'qr' && ln.qr ? `<p class="small">في جوال الرقم: واتساب ← ⋮ ← <b>الأجهزة المرتبطة</b> ← ربط جهاز، وامسح:</p><img src="${ln.qr}" style="width:240px;max-width:100%;background:#fff;padding:6px;border-radius:8px">`
      : ln.status === 'closed' ? '<p class="small">⏳ انقطع — يحاول يرجع لحاله…</p>'
      : `<p class="small muted">${ln.error ? esc(ln.error) : 'مو مربوط'}</p>`}
    <div class="row" style="margin:8px 0;flex-wrap:wrap">${ln.status === 'open' ? '<button class="btn" id="waLogout">فك الربط</button>' : `<button class="btn primary" id="waLink">${ln.status === 'qr' ? 'QR جديد' : 'اربط الرقم'}</button>`}
      <button class="btn" id="waTest" ${st.ready ? '' : 'disabled'}>أرسل رسالة تجربة لجوالي</button></div>
    ${ln.status === 'open' ? `<h4 style="margin:10px 0 4px">القروبات</h4><p class="small muted">«جروب المطعم» و«حساب اليوم»: يقرأ الخصومات (يرسلها لك تأكدها، وبعدها ينبلغ العامل) والطلبات (ترسل لزكريا). الباقي يتجاهله.</p>
      ${ln.groups.map(g => `<div class="row" style="align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);padding:4px 0"><span>${esc(g.name)} <span class="small muted">(${g.size})</span></span>
        <select data-wg="${esc(g.id)}" style="width:auto">${ROLES.map(([k, v]) => `<option value="${k}" ${g.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>`).join('') || '<p class="small muted">الرقم مو في ولا قروب — ضيفه للقروبات من الجوال</p>'}
      ${ln.groups.length ? '<button class="btn primary" id="waGroups" style="margin-top:8px">حفظ القروبات</button>' : ''}
      <h4 style="margin:14px 0 4px">📢 رسالة للكل</h4>
      <p class="small muted">تنرسل في جروب المطعم، ولكل موظف جواله مسجل في الخاص (بفاصل ٤ ثواني بينهم). عدّلها قبل الإرسال لو تبغى.</p>
      <textarea id="waBc" rows="10" style="width:100%">${esc(WA_INTRO)}</textarea>
      <div class="row" style="flex-wrap:wrap;gap:12px;margin:6px 0"><label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="waBcG" checked> جروب المطعم</label><label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="waBcP" checked> الخاص لكل موظف</label><label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="waBcV"> 🔊 صوت كمان</label></div>
      <button class="btn primary" id="waBcSend">📢 أرسل</button>
      <h4 style="margin:14px 0 4px">📣 تنبيهات في جروب المطعم</h4>
      <p class="small muted">يكتب في «جروب المطعم» بأسمائهم: اللي ما دخّل جرد أول اليوم (بعد الموعد)، واللي ما قفل جرد أمس، والنقص — كل تنبيه مرة وحدة في اليوم. ويأكد في القروب لما يتسجل خصم أو توصل الطلبات لزكريا.</p>
      <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="waNudge" ${s.wa_nudge === '0' ? '' : 'checked'}> شغّالة</label>
      <button class="btn" id="waNudgeNow" style="margin-top:6px">جرّب: أرسل تنبيه اليوم الحين</button>
      <h4 style="margin:14px 0 4px">🔁 ملاحقة اللي ما جرد (في الخاص)</h4>
      <p class="small muted">كل ساعة يرسل في الخاص لكل واحد جرده ناقص بأصنافه بالاسم: أول اليوم من الساعة ١٠ (وآخر وقت الموعد)، وآخر اليوم من ١١ الليل. النبرة تشد كل مرة. بعد ٣ تذكيرات: اسمه في جروب المطعم ويوصلك. وبعد ساعة القفل بشوي يوصلك ملخص الباقي عشان تكمّله. <b>فترة التعليم</b>: بدون خصم — ولما تخلص فعّل «تنسجل مشكلة» وتمشي على التذكير/التنبيه/القرصة.</p>
      <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="waChase" ${s.wa_chase === '0' ? '' : 'checked'}> شغّالة</label>
      <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="waChaseRec" ${s.wa_chase_record === '1' ? 'checked' : ''}> ⚖️ انتهت فترة التعليم: بعد ٣ تذكيرات تنسجل مشكلة «الجرد» (وتدخل في الخصم)</label>
      <div class="row" style="align-items:flex-end;flex-wrap:wrap"><label class="f">جرد أول اليوم من الساعة<input id="waChaseOpenH" inputmode="numeric" value="${esc(s.wa_chase_open_hour || '10')}" style="max-width:90px"></label><label class="f">جرد آخر اليوم من الساعة (٢٤ ساعة)<input id="waCloseH" inputmode="numeric" value="${esc(s.wa_close_hour || '23')}" style="max-width:90px"></label><label class="f">كل كم دقيقة<input id="waChaseMin" inputmode="numeric" value="${esc(s.wa_chase_min || '60')}" style="max-width:90px"></label><label class="f">ملخص الباقي لي بعد (دقيقة)<input id="waOwnRem" inputmode="numeric" value="${esc(s.wa_owner_remind_after || '60')}" style="max-width:90px"></label></div>
      <p class="small" style="margin:6px 0 2px">يوصلهم ملخص الناقص معي:</p>
      <div class="row" style="flex-wrap:wrap;gap:10px">${st.users.filter(x => x.role !== 'owner').map(x => `<label class="small" style="display:flex;gap:4px;align-items:center"><input type="checkbox" data-cn="${x.id}" ${chaseNotify.includes(x.id) ? 'checked' : ''}> ${esc(x.name)}</label>`).join('') || '<span class="small muted">سجّل جوالات الموظفين أول</span>'}</div>
      <div class="row" style="margin-top:6px;flex-wrap:wrap"><button class="btn" id="waChaseSave">حفظ</button><button class="btn" id="waChaseNow">جرّب الملاحقة الحين</button></div>
      <h4 style="margin:14px 0 4px">✅ الاقتراحات الصغيرة</h4>
      <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="waAuto" ${s.auto_approve === '0' ? '' : 'checked'}> تتنفذ لحالها (تصحيح جرد، مسؤول صنف، معلومة للدليل…) وأراجعها في تقرير الخميس — أو اكتب للمساعد «وش اتنفذ لحاله؟» و«رجّع رقم»</label>
      <h4 style="margin:14px 0 4px">🤏 قرصة الإذن</h4>
      <p class="small muted">لو مشرف أو أنت كتبت مشكلة على عامل في القروب: أول مرة تذكير في الخاص، الثانية تنبيه، الثالثة خصم صغير لحاله (ويزيد نفسه كل مرة بعدها بنفس الشهر لين الحد). يوصلك للعلم وتقدر تمسحه من الرواتب. العداد يرجع صفر كل شهر. (0 = بدون خصم)</p>
      <div class="row" style="align-items:flex-end;flex-wrap:wrap"><label class="f">المبلغ (ريال)<input id="waPinch" inputmode="numeric" value="${esc(s.wa_pinch || '20')}" style="max-width:90px"></label><label class="f">أعلى شي<input id="waPinchMax" inputmode="numeric" value="${esc(s.wa_pinch_max || '100')}" style="max-width:90px"></label><button class="btn" id="waPinchSave">حفظ</button></div>
      <h4 style="margin:14px 0 4px">🛒 طلبات القروب لزكريا</h4>
      <p class="small muted">المستعجل («ضروري»، «الحين»، «خلص») يوصل لزكريا على طول. الباقي يتجمع ويوصله قائمة وحدة في الأوقات هذي (ساعات، مفصولة بفاصلة، بنظام ٢٤ ساعة: 10,16 = ١٠ الصبح و٤ العصر).</p>
      <div class="row" style="align-items:flex-end;flex-wrap:wrap"><label class="f">الأوقات<input id="waReqT" dir="ltr" value="${esc(ln.req_times)}" style="max-width:140px"></label><button class="btn" id="waReqSave">حفظ</button>
        <button class="btn" id="waReqNow" ${ln.req_pending.length ? '' : 'disabled'}>أرسل القائمة الحين (${ln.req_pending.length})</button></div>
      ${ln.req_pending.length ? `<p class="small">تنتظر: ${ln.req_pending.map(x => esc(x.item + (x.qty ? ' ' + x.qty : ''))).join('، ')}</p>` : ''}` : ''}`;
  const cloudHtml = `
    <p class="small muted">واتساب الرسمي من ميتا (رقم جديد، ما يدخل القروبات).</p>
    <label class="f">رابط الـWebhook (ينحط في ميتا)<input readonly value="${esc(hook)}" style="direction:ltr"></label>
    <div class="row" style="flex-wrap:wrap"><label class="f grow">Access token<input id="waT" style="direction:ltr" value="${esc(s.wa_token || '')}" placeholder="EAAG…"></label>
      <label class="f grow">Phone number ID<input id="waP" style="direction:ltr" inputmode="numeric" value="${esc(s.wa_phone_id || '')}"></label></div>
    <div class="row" style="flex-wrap:wrap"><label class="f grow">App secret<input id="waS" style="direction:ltr" value="${esc(s.wa_app_secret || '')}"></label>
      <label class="f grow">Verify token (كلمة تختارها وتحطها نفسها في ميتا)<input id="waV" style="direction:ltr" value="${esc(s.wa_verify_token || '')}"></label></div>
    <div class="row" style="margin-top:8px"><button class="btn primary" id="waSave">حفظ</button><button class="btn" id="waTest" ${st.ready ? '' : 'disabled'}>أرسل رسالة تجربة لجوالي</button></div>`;
  box.innerHTML = `<div class="card"><h3>📱 الواتساب ${st.ready ? '<span class="badge green">مربوط</span>' : '<span class="badge amber">مو مربوط</span>'}</h3>
    <div class="row" style="gap:6px;margin-bottom:8px"><button class="btn small ${link ? 'primary' : ''}" data-wm="link">ربط رقم (QR)</button><button class="btn small ${link ? '' : 'primary'}" data-wm="cloud">واتساب الرسمي</button></div>
    ${link ? linkHtml : cloudHtml}
    <h4 style="margin:14px 0 4px">🎤 الرسائل الصوتية ${s.stt_key ? '<span class="badge green">مفعّلة</span>' : '<span class="badge amber">مو مفعّلة</span>'}</h4>
    <p class="small muted">عشان يفهم الرسائل الصوتية (يحوّلها كتابة). مفتاح من platform.openai.com ← API keys ← Create، واشحن فيه ٥ دولار تكفي شهور (الرسالة تقريبًا هللة). <b>حطه هنا بس — لا ترسله لأحد.</b></p>
    <div class="row" style="align-items:flex-end;flex-wrap:wrap"><label class="f grow">مفتاح OpenAI<input id="sttK" dir="ltr" value="${esc(s.stt_key || '')}" placeholder="sk-…"></label><button class="btn" id="sttSave">حفظ</button></div>
    <p class="small" style="margin-top:8px">الجوالات المسجلة: ${st.users.map(x => `${esc(x.name)} <span dir="ltr">${esc(x.phone)}</span>`).join(' · ') || '<span class="muted">ولا واحد — حطها من صفحة الموظفين</span>'}</p>
    ${st.log.length ? `<details><summary class="small">آخر الرسائل (${st.log.length})</summary><div style="max-height:360px;overflow:auto">${st.log.map(l => `<div class="small" style="border-bottom:1px solid var(--line);padding:4px 0"><b>${l.dir === 'in' ? '⬅️ ' + esc(l.name || l.phone) : '➡️ النظام'}</b> <span class="muted">${esc(ksa(l.at))}</span><div style="white-space:pre-wrap">${esc(l.text)}</div></div>`).join('')}</div></details>` : ''}</div>`;
  const again = () => waSettings(box, s);
  $$('[data-wm]', box).forEach(b => b.onclick = e => busy(e.currentTarget, async () => { await POST('/api/settings', { wa_mode: b.dataset.wm }); again(); }));
  const on = (id, fn) => { const el = $('#' + id, box); if (el) el.onclick = e => busy(e.currentTarget, fn); };
  on('waLink', async () => { await POST('/api/whatsapp/link', { action: 'start' }); toast('لحظة… يطلع QR'); setTimeout(again, 2500); });
  on('waLogout', async () => { if (await confirmBox('تفك ربط الرقم؟')) { await POST('/api/whatsapp/link', { action: 'logout' }); again(); } });
  on('waGroups', async () => { await POST('/api/whatsapp/groups', { groups: $$('[data-wg]', box).map(x => ({ id: x.dataset.wg, role: x.value })) }); toast('انحفظ ✓'); });
  on('waSave', async () => { await POST('/api/settings', { wa_token: $('#waT', box).value, wa_phone_id: $('#waP', box).value, wa_app_secret: $('#waS', box).value, wa_verify_token: $('#waV', box).value }); toast('انحفظ ✓'); again(); });
  on('waTest', async () => { await POST('/api/whatsapp/test', {}); toast('انرسلت ✓ — شيك الواتساب'); });
  on('sttSave', async () => { await POST('/api/settings', { stt_key: $('#sttK', box).value }); s.stt_key = $('#sttK', box).value ? '••••' : ''; toast('انحفظ ✓'); again(); });
  on('waPinchSave', async () => { const a = Math.max(0, numIn($('#waPinch', box).value)), m = Math.max(0, numIn($('#waPinchMax', box).value)); await POST('/api/settings', { wa_pinch: String(a), wa_pinch_max: String(m) }); s.wa_pinch = String(a); s.wa_pinch_max = String(m); toast('انحفظ ✓'); });
  on('waReqSave', async () => { const v = $('#waReqT', box).value.split(/[,،\s]+/).map(Number).filter(h => Number.isInteger(h) && h >= 0 && h < 24); if (!v.length) throw new Error('اكتب ساعات مثل 10,16'); await POST('/api/settings', { wa_req_times: v.join(',') }); toast('انحفظ ✓'); again(); });
  on('waReqNow', async () => { const r = await POST('/api/whatsapp/requests/send', {}); toast(r.items ? `راحت القائمة (${r.items} صنف) ✓` : 'ما فيه طلبات'); again(); });
  on('waBcSend', async () => {
    const text = $('#waBc', box).value.trim(), g = $('#waBcG', box).checked, p = $('#waBcP', box).checked;
    if (!text || (!g && !p)) throw new Error('اكتب الرسالة واختر وين');
    if (!await confirmBox(`ترسلها${g ? ' في جروب المطعم' : ''}${g && p ? ' و' : ''}${p ? ' لكل موظف في الخاص' : ''}؟`)) return;
    const r = await POST('/api/whatsapp/broadcast', { text, group: g, private: p, voice: $('#waBcV', box).checked });
    if (r.voice_error) toast('⚠️ الصوت ما زبط: ' + r.voice_error + ' — راحت كتابة بس');
    toast(`انرسلت${r.voice ? ' بالصوت' : ''} ✓${r.group ? ' في القروب' : ''}${r.private.length ? ` — والخاص لـ${r.private.length} موظف (تمشي وحدة وحدة)` : ''}`);
  });
  on('waNudgeNow', async () => { const r = await POST('/api/whatsapp/nudge', { force: true }); toast(r.sent.length ? `انرسل ${r.sent.length} تنبيه في القروب ✓` : 'ما فيه شي ينبَّه عليه الحين 👌'); });
  on('waChaseSave', async () => {
    const hr = (id, d) => { const v = Math.round(numIn($('#' + id, box).value)); return String(Number.isFinite(v) && v >= 0 && v < 24 ? v : d); };
    const v = { wa_chase_open_hour: hr('waChaseOpenH', 10), wa_close_hour: hr('waCloseH', 23), wa_chase_min: String(Math.max(30, numIn($('#waChaseMin', box).value) || 60)),
      wa_owner_remind_after: String(Math.max(0, numIn($('#waOwnRem', box).value))), wa_chase_notify: JSON.stringify($$('[data-cn]', box).filter(x => x.checked).map(x => Number(x.dataset.cn))) };
    await POST('/api/settings', v); Object.assign(s, v); toast('انحفظ ✓'); again();
  });
  on('waChaseNow', async () => { const r = await POST('/api/whatsapp/chase', {}); toast(r.sent.length ? `انرسل ${r.sent.length} تذكير ✓` : 'ما فيه أحد جرده ناقص الحين 👌'); });
  for (const [id, k, onV, offV] of [['waChase', 'wa_chase', '1', '0'], ['waChaseRec', 'wa_chase_record', '1', '0'], ['waAuto', 'auto_approve', '1', '0']]) {
    const el = $('#' + id, box); if (el) el.onchange = () => busy(null, async () => { const v = el.checked ? onV : offV; await POST('/api/settings', { [k]: v }); s[k] = v; toast('انحفظ ✓'); });
  }
  const nt = $('#waNudge', box); if (nt) nt.onchange = () => busy(null, async () => { await POST('/api/settings', { wa_nudge: nt.checked ? '1' : '0' }); s.wa_nudge = nt.checked ? '1' : '0'; toast('انحفظ ✓'); });
  // QR يتجدد / ينتظر المسح
  if (link && ['qr', 'closed'].includes(ln.status)) setTimeout(() => { if (box.isConnected) again(); }, 4000);
}

boot();
