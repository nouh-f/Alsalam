'use strict';
/* نظام جرد السلام — الواجهة */

// ===================== أدوات عامة =====================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 2) => (n == null || n === '' || Number.isNaN(Number(n))) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
const money = n => fmt(n, 2);
const qtyFmt = n => fmt(n, 3);
const ROLE = { owner: 'المالك', supervisor: 'مشرف', purchaser: 'مسؤول المشتريات', worker: 'عامل' };
const PAYMENT = { cash: 'من الدرج', paid: 'مدفوع (برا الدرج)', credit: 'آجل' };

const S = {
  token: lsGet('token'),
  me: null,
  date: null,
  cache: {},
};
function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } }
function lsSet(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* */ } }

function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.className = ''; }, err ? 4500 : 2200);
}

// طلب للسيرفر: ما يطلعك أبدًا إلا إذا السيرفر قال الجلسة غير موجودة
async function api(method, url, body) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
      const res = await fetch(url, {
        method, signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      $('#net').hidden = true;
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && url !== '/api/login') { S.token = ''; lsSet('token', ''); renderLogin(); throw new Error('سجّل دخول'); }
      if (!res.ok) throw Object.assign(new Error(data.error || 'خطأ ' + res.status), { data });
      return data;
    } catch (e) {
      const network = e.name === 'AbortError' || e instanceof TypeError;
      if (network && method === 'GET' && attempt < 5) { $('#net').hidden = false; await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
      if (network) { $('#net').hidden = false; throw new Error('ما فيه اتصال — جرّب مرة ثانية'); }
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
function showImage(src) { modal('صورة', `<img src="${esc(src)}" style="width:100%;border-radius:8px"><div class="row" style="margin-top:8px"><button class="btn" data-close>إغلاق</button></div>`); }

// تصغير الصورة قبل الرفع (أسرع وما يعلق)
function readImage(file, max = 1800) {
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
        resolve(c.toDataURL('image/jpeg', 0.82));
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
  { id: 'count', t: 'الجرد اليومي', f: pageCount, noPurch: 1 },
  { id: 'transfer', t: 'السحب والتحضير', f: pageTransfer, noPurch: 1 },
  { id: 'tickets', t: 'تذكرة الكاشير', f: pageTickets, sales: 1 },
  { id: 'sales', t: 'المبيعات', f: pageSales, sales: 1 },
  { id: 'report', t: 'تقرير اليوم', f: pageReport, sales: 1 },
  // الثلاث أنواع: المستودع (ينشرى) ← التحضير (يتسوى) ← أصناف البيع (لويفرس)
  { id: 'warehouse', t: '① المستودع — الكميات', f: pageWarehouse, purch: 1 },
  { id: 'items', t: '① المستودع — الأصناف', f: (m, a) => pageItems(m, a, 'raw'), purch: 1 },
  { id: 'prep', t: '② التحضير', f: (m, a) => pageItems(m, a, 'prepared'), sup: 1 },
  { id: 'recipes', t: '③ أصناف البيع (لويفرس)', f: pageRecipes, recipes: 1 },
  { id: 'link', t: 'ربط أصناف البيع', f: pageLink, recipes: 1, hidden: 1 },
  { id: 'purchases', t: 'المشتريات', f: pagePurchases, purch: 1 },
  { id: 'suppliers', t: 'الموردين (الآجل)', f: pageSuppliers, purch: 1 },
  { id: 'expenses', t: 'المصروفات', f: pageExpenses, sup: 1 },
  { id: 'staff', t: 'الموظفين والمسؤوليات', f: pageStaff, sup: 1 },
  { id: 'payroll', t: 'الرواتب والسحبيات', f: pagePayroll, owner: 1 },
  { id: 'days', t: 'الأيام السابقة', f: pageDays, sales: 1 },
  { id: 'settings', t: 'الإعدادات', f: pageSettings },
];
// المشرف يشوف «الأقسام» بس — الموظفين وصلاحياتهم للمالك
const titleOf = p => (p.id === 'staff' && !isOwner() ? 'المسؤوليات' : p.t);
// مسؤول المشتريات يشوف بس المشتريات والموردين والمستودع وأصنافه
const onlyPurch = () => S.me && S.me.role === 'purchaser';
const allowed = p => (!p.sup || isSup()) && (!p.purch || isPurch()) && (!p.owner || isOwner()) && !(p.noPurch && onlyPurch())
  && (!p.sales || (S.me && S.me.can_sales)) && (!p.recipes || (S.me && S.me.can_recipes));

function shell() {
  const app = $('#app');
  app.innerHTML = `
  <header class="top">
    <button class="btn small menu-btn" id="menuBtn" aria-label="القائمة">☰</button>
    <div class="title" id="pageTitle"></div>
    <input type="date" id="dateSel" aria-label="اليوم">
    <button class="btn small" id="todayBtn">اليوم</button>
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
    S.token = ''; lsSet('token', ''); S.me = null; renderLogin();
  };
}


// ===================== شرح كل صفحة =====================
// خطوات قصيرة بكلام بسيط. تنفتح أول مرة، و«فهمت» تصغّرها (وتقدر تفتحها متى ما بغيت)
const GUIDES = {
  home: () => ['فوق تحصل «المطلوب منك الحين» — امش عليه من فوق لتحت.', 'الأحمر لازم الحين، والأصفر لا تنساه، والأخضر خلص.', 'اضغط الزر اللي جنب كل سطر يوديك للمكان على طول.'],
  count: () => isSup() || (S.me.approver_sections || []).length
    ? ['اختر «أول الدوام» أو «آخر الدوام» من فوق.', 'اكتب العدد قدام كل صنف — ينحفظ لحاله (تطلع ✓).', 'لما يخلص القسم اضغط «استلام» — بعدها العامل ما يقدر يغيّر.', 'عمود «الفرق»: نقص بالأحمر يعني فيه شي ناقص.']
    : ['أول ما تبدأ الدوام اضغط «أول الدوام».', 'عدّ كل صنف واكتب الرقم قدامه — ينحفظ لحاله (تطلع ✓).', 'لو نفس آخر أمس اضغط الزر اللي فيه الرقم.', 'قبل ما تطلع اضغط «آخر الدوام» واكتب الباقي.'],
  transfer: () => ['كل ما تطلّع شي من المستودع للمحل سجّله هنا.', 'اختر الصنف، اكتب الكمية، واضغط «سحب».', 'لو جهّزت شي (حنيذ، فتة…) سجّله بنفس الطريقة — مكوناته تنخصم لحالها.', 'اللي ما يتسجل يطلع نقص عليك في الجرد.'],
  purchases: () => ['اكتب اسم المحل أو المورد.', 'اختر طريقة الدفع: من الدرج، أو مدفوع برا، أو آجل.', 'اكتب اسم الصنف واختاره — لو مو موجود اضغط «+ أضفه».', 'اكتب العدد والسعر (أو مبلغ السطر).', 'صوّر الفاتورة واضغط «حفظ الشراء».'],
  tickets: () => ['صوّر تذكرة الكاشير — لو طويلة صوّرها كذا صورة.', 'ارفع الصور كلها مرة وحدة، والنظام يقراها لحاله.', 'لو طلع أخضر اضغط «تأكيد».', 'لو طلع أحمر: صحح السطر الغلط أو صوّر من جديد.'],
  link: () => ['هنا أصناف لويفرس اللي ما تعرف وش تنخصم.', 'لو فيه «أسماء مكتوبة غير عن لويفرس» اضغط «وحّد» أول.', 'بعدها اضغط «اربط المقترحات المطابقة».', 'الباقي واحد واحد: «اربط» بصنف موجود، أو «صنف جديد بنفس الاسم»، أو «ما ينجرد» للخدمة والتوصيل.', 'الطبق اللي له مقادير (مثل المرسة): اضغط «طبق له مقادير» واكتب كم من كل مكوّن لكل نوع.'],
  recipes: () => ['أصناف البيع = اللي في لويفرس. كل صنف: وش ياخذ من التحضير أو المستودع لما ينباع.', 'اضغط على الصنف عشان تفتح وصفته.', 'أضف المكوّن والكمية لكل وحدة تنباع (تقبل كسور مثل 0.4).', 'الوصفة الصفراء «مبدئية»: شيكها واضغط «اعتمد».'],
  items: () => ['هنا كل شي ينشرى ويدخل المستودع (دقيق، زيت، بيبسي، لحم…).', 'اللي ينباع زي ما هو (بيبسي، لحوح) علّمه «يدخل الجرد اليومي» وحدد المسؤول عنه.', 'اللي يدخل في التحضير بس (دقيق، بهارات) يبقى في المستودع، وينجرد مرة بالأسبوع.'],
  prep: () => ['هنا كل شي يتسوى في المحل (فتة، حنيذ، برم، إيدامات…).', 'لكل صنف حط مكوناته من المستودع لكل وحدة، وتكلفة الغاز إن وجدت.', 'حدد المسؤول عنه — يجرده أول وآخر الدوام، والنقص عليه.'],
  staff: () => ['كل موظف له أصنافه: يجردها أول وآخر الدوام، والنقص عليه.', 'تحت اسم الموظف اختر «+ أضف صنف عليه».', 'الأصناف اللي ما لها مسؤول تطلع فوق — حطها عند أحد.'],
  warehouse: () => ['هنا اللي في المستودع الحين حسب النظام.', 'مرة في الأسبوع عدّ المستودع واكتب الموجود — النظام يصحح ويبين الفرق.'],
  report: () => ['آخر الليل: اكتب كم كاش في الدرج وكم شبكة.', 'شيك النقص في البضاعة والكاش.', 'إذا كل شي تمام اضغط «قفل اليوم».'],
  suppliers: () => ['هنا اللي علينا لكل مورد (الآجل).', 'لما تسدد اضغط «سداد» واكتب المبلغ — ينخصم من الأقدم أول.'],
  sales: () => ['مبيعات اليوم من لويفرس + التذكرة، وتكلفة كل صنف.', 'الصنف المكتوب عليه «ما فيه» وصفة: اربطه من «ربط لويفرس بالجرد».'],
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
  const id = (location.hash.replace('#/', '') || 'home').split('?')[0];
  const page = PAGES.find(p => p.id === id && allowed(p)) || PAGES.find(p => p.id === (onlyPurch() ? 'purchases' : 'home') && allowed(p)) || PAGES.find(allowed);
  S.page = page.id;
  $$('#side a').forEach(a => a.classList.toggle('on', a.dataset.p === page.id));
  $('#pageTitle').textContent = titleOf(page);
  const root = $('#main');
  delete root.dataset.dirty;
  const seq = ++routeSeq;
  // فوق كل صفحة: «وش أسوي هنا؟» بخطوات قصيرة، وتحته محتوى الصفحة
  root.innerHTML = guideHtml(page.id) + '<div id="pageBody"><div class="muted">جاري التحميل…</div></div>';
  bindGuide(root, page.id);
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
    const oldToday = S.me.today;
    S.me = me;
    if (me.today !== oldToday && S.date === oldToday) {
      S.date = me.today;
      const sel = $('#dateSel'); if (sel) sel.value = S.date;
      toast('بدأ يوم جديد: ' + S.date);
      if (!busyPage()) return route();
    }
  } catch { /* بدون اتصال: نجرب المرة الجاية */ }
  // تحديث خفيف للصفحة الرئيسية بس (عشان ما يضيع شي تكتبه)
  // (S.page = الصفحة المعروضة فعلاً — مسؤول المشتريات بدون رابط تنفتح له المشتريات مو الرئيسية)
  if (S.page === 'home' && !busyPage()) route();
}
// أي كتابة في الصفحة = فيها شي ما انحفظ، فالتحديث التلقائي ما يمسحه
document.addEventListener('input', e => { const m = e.target.closest && e.target.closest('#main'); if (m) m.dataset.dirty = '1'; });
document.addEventListener('change', e => { const m = e.target.closest && e.target.closest('#main'); if (m) m.dataset.dirty = '1'; });

async function boot() {
  if (!S.token) return renderLogin();
  try { S.me = await GET('/api/me'); }
  catch (e) { if (!S.token) return; $('#app').innerHTML = `<div class="login err-card">${esc(e.message)}<br><button class="btn" id="rb">إعادة المحاولة</button></div>`; $('#rb').onclick = boot; return; }
  S.date = S.date || S.me.today;
  shell();
  route();
  clearInterval(quietTimer);
  quietTimer = setInterval(refreshQuiet, 60000);
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
    <div class="card todo-card"><h3>المطلوب منك الحين</h3>
      ${(d.todo || []).map(t => `<div class="todo ${t.level}">
        <div class="grow"><div class="todo-t">${esc(t.title)}</div>${t.detail ? `<div class="todo-d">${esc(t.detail)}</div>` : ''}</div>
        ${t.href ? `<a class="btn ${t.level === 'red' || t.level === 'amber' ? 'primary' : ''}" href="${esc(t.href)}">${esc(t.btn || 'افتح')}</a>` : ''}</div>`).join('')}
    </div>
    ${m ? `<div class="grid" style="margin-bottom:12px">
      <div class="stat"><div class="k">مبيعات لويفرس</div><div class="v">${money(m.loyverse_total)}</div></div>
      <div class="stat"><div class="k">مبيعات التذكرة</div><div class="v">${money(m.ticket_total)}</div></div>
      <div class="stat"><div class="k">المجموع</div><div class="v">${money(m.total_sales)}</div></div>
      <div class="stat"><div class="k">تكلفة الوجبات</div><div class="v">${money(m.cogs)}</div></div>
      <div class="stat ${m.inventory_shortage_value > 0 ? 'red' : ''}"><div class="k">نقص البضاعة (ريال)</div><div class="v">${money(m.inventory_shortage_value)}</div></div>
      <div class="stat ${m.cash_shortage > 0 ? 'red' : m.cash_shortage != null ? 'green' : ''}"><div class="k">نقص الكاش</div><div class="v">${m.cash_shortage == null ? 'ما انجرد' : money(m.cash_shortage)}</div></div>
    </div>` : ''}
    ${(d.alerts || []).length && (isSup() || (S.me.approver_sections || []).length) ? `<div class="card"><h3>التنبيهات</h3>${alertsHtml(d.alerts)}</div>` : ''}
    ${isSup() || (S.me.approver_sections || []).length ? `<div class="card"><h3>الأقسام</h3><div class="tbl-wrap"><table>
      <thead><tr><th>القسم</th><th>أول اليوم</th><th>آخر اليوم</th>${isSup() ? '<th class="n">نقص</th>' : ''}</tr></thead><tbody>
      ${d.sections.map(s => `<tr><td class="item-name">${esc(s.name)}</td>
        <td>${esc(s.opening_user)} <span class="badge ${s.opening_done === s.items ? 'green' : 'red'}">${s.opening_done}/${s.items}</span> ${s.opening_approved ? `<span class="badge brand">استلم ${esc(s.opening_approved.by)}</span>` : ''}</td>
        <td>${esc(s.closing_user)} <span class="badge ${s.closing_done === s.items ? 'green' : 'amber'}">${s.closing_done}/${s.items}</span> ${s.closing_approved ? `<span class="badge brand">استلم ${esc(s.closing_approved.by)}</span>` : ''}</td>
        ${isSup() ? `<td class="n ${s.shortage_value > 0 ? 'pos' : ''}">${money(s.shortage_value)}</td>` : ''}</tr>`).join('')}
      </tbody></table></div></div>` : ''}
    ${d.last_sync ? `<div class="muted small">آخر سحب من لويفرس: ${new Date(d.last_sync.at + 'Z').toLocaleString('ar-SA')} — ${esc(d.last_sync.message)}</div>` : ''}`;
}

// ===================== الجرد اليومي =====================
async function pageCount(main, alive) {
  const b = await GET('/api/board?date=' + S.date);
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
  let phase = qs.get('p') || (myOpenMissing ? 'opening' : 'closing');
  let lastMine = [];

  const draw = () => {
    const rowsFor = tab === 'mine' ? b.rows.filter(r => r.opening_user_id === me.id || r.closing_user_id === me.id)
      : tab === 'all' ? b.rows : b.rows.filter(r => String(r.section_id) === tab);
    const showCalc = r => sup || approverOf.has(r.section_id);
    const canOpen = r => !b.closed && (sup || r.opening_user_id === me.id || approverOf.has(r.section_id));
    const canClose = r => !b.closed && (sup || r.closing_user_id === me.id || approverOf.has(r.section_id));
    const groups = groupBy(rowsFor, r => r.section_id);
    const simple = !rowsFor.some(r => showCalc(r)); // العامل: عمود واحد
    const show = ph => !simple || phase === ph;
    const mineIn = rowsFor.filter(r => (phase === 'opening' ? canOpen(r) : canClose(r)));
    const left = mineIn.filter(r => r[phase] == null).length;
    lastMine = simple ? mineIn : [];
    main.innerHTML = `
      ${b.closed ? '<div class="alert amber">اليوم مقفل — التعديل للمالك بس</div>' : ''}
      ${simple ? `<div class="phase-sw no-print"><button data-ph="opening" class="${phase === 'opening' ? 'on' : ''}">أول الدوام</button><button data-ph="closing" class="${phase === 'closing' ? 'on' : ''}">آخر الدوام</button></div>
        ${mineIn.length ? (left ? `<div class="progress">باقي ${left} من ${mineIn.length} — اكتب العدد قدام كل صنف</div>`
          : `<div class="alert" style="background:var(--green-soft);color:var(--green)"><b>خلصت ${phase === 'opening' ? 'أول الدوام' : 'آخر الدوام'} ✓</b> — كل الأرقام انحفظت. <a href="#/home">ارجع للرئيسية</a></div>`) : ''}` : ''}
      <div class="tabs no-print" ${(sup || approverOf.size) ? '' : 'hidden'}>
        <button data-tab="mine" class="${tab === 'mine' ? 'on' : ''}">أصنافي</button>
        ${(sup || approverOf.size) ? `<button data-tab="all" class="${tab === 'all' ? 'on' : ''}">الكل</button>` : ''}
        ${secs.map(s => `<button data-tab="${s.id}" class="${tab === String(s.id) ? 'on' : ''}">${esc(s.name)}</button>`).join('')}
      </div>
      ${!rowsFor.length ? '<div class="card muted">ما فيه أصناف عليك هنا. اختر قسم من فوق.</div>' : ''}
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
              <td><div class="item-name">${esc(r.name)} <span class="muted small">${esc(r.unit)}</span>${r.carry_over ? '' : ' <span class="badge amber">هالك آخر اليوم</span>'}</div>
                ${r.note ? `<div class="item-note">${esc(r.note)}</div>` : ''}
                ${sup ? `<div class="item-note">${esc(r.opening_user)} ← ${esc(r.closing_user)}</div>` : ''}</td>
              ${show('opening') ? `<td>${canOpen(r) ? qtyInput(r, 'opening') : qtyFmt(r.opening)}
                ${r.suggested_opening != null && r.opening == null && canOpen(r) ? `<button class="btn small" data-same="${r.suggested_opening}" title="نفس آخر أمس">= ${qtyFmt(r.suggested_opening)}</button>` : ''}
                <div class="item-note">${r.opening_by ? 'دخّله ' + esc(r.opening_by) : ''}${r.opening_gap ? ` <span class="badge amber">آخر أمس ${qtyFmt(r.prev_closing)}</span>` : ''}${r.pulled ? ` <span class="badge brand">من الثلاجة ${qtyFmt(r.pulled)}</span>` : ''}</div></td>` : ''}
              ${calc ? `<td class="n">${qtyFmt(r.received)}</td><td class="n">${qtyFmt(r.theoretical)}</td><td class="n"><b>${qtyFmt(r.remaining_expected)}</b></td>` : ''}
              ${show('closing') ? `<td>${canClose(r) ? qtyInput(r, 'closing') : qtyFmt(r.closing)}<div class="item-note">${r.closing_by ? 'دخّله ' + esc(r.closing_by) : ''}</div></td>` : ''}
              ${calc ? `<td class="n">${r.diff == null ? '—' : `<span class="${r.diff > 0 ? 'pos' : r.diff < 0 ? 'neg' : ''}">${r.diff > 0 ? 'نقص ' : r.diff < 0 ? 'زيادة ' : ''}${qtyFmt(Math.abs(r.diff))}</span>${r.diff_value ? `<div class="item-note">${money(r.diff_value)} ريال</div>` : ''}`}${r.waste ? `<div class="item-note">هالك ${qtyFmt(r.waste)}</div>` : ''}</td>` : ''}
            </tr>`).join('')}
          </tbody></table></div></div>`;
      }).join('')}`;

    $$('[data-tab]', main).forEach(x => x.onclick = () => { tab = x.dataset.tab; sessionStorage.setItem('countTab', tab); draw(); });
    $$('[data-ph]', main).forEach(x => x.onclick = () => { phase = x.dataset.ph; draw(); });
    $$('input[data-phase]', main).forEach(inp => {
      inp.addEventListener('change', () => saveCount(inp));
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const all = $$('input[data-phase]', main); const i = all.indexOf(inp); (all[i + 1] || inp).focus(); } });
    });
    $$('[data-same]', main).forEach(btn => btn.onclick = () => { const inp = $('input[data-phase="opening"]', btn.closest('td')); inp.value = btn.dataset.same; saveCount(inp); btn.remove(); });
    $$('[data-appr]', main).forEach(btn => btn.onclick = () => busy(btn, async () => {
      const [phase, sec, undo] = btn.dataset.appr.split(':');
      await POST('/api/approve', { date: S.date, section_id: Number(sec), phase, undo: undo === 'undo' });
      toast(undo ? 'تم إلغاء الاستلام' : 'تم الاستلام ✓');
      Object.assign(b, await GET('/api/board?date=' + S.date)); draw();
    }));
  };

  function apprBtn(s, phase, can) {
    const a = s[phase + '_approved'], label = phase === 'opening' ? 'أول اليوم' : 'آخر اليوم';
    if (a) return `<span class="badge brand">استلم ${label}: ${esc(a.by)}</span>${can && !b.closed ? ` <button class="btn small" data-appr="${phase}:${s.id}:undo">إلغاء</button>` : ''}`;
    return can && !b.closed ? `<button class="btn small primary" data-appr="${phase}:${s.id}">استلام ${label}</button>` : `<span class="badge">${label}: ما استلم</span>`;
  }
  function qtyInput(r, phase) {
    const v = r[phase];
    return `<input class="qty" type="text" inputmode="decimal" data-phase="${phase}" value="${v == null ? '' : v}" placeholder="${phase === 'opening' && r.suggested_opening != null ? r.suggested_opening : ''}" aria-label="${esc(r.name)}"><span class="saved"></span>`;
  }
  async function saveCount(inp) {
    const tr = inp.closest('tr'), mark = inp.nextElementSibling;
    const raw = inp.value.trim().replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace('٫', '.').replace(',', '.');
    if (raw !== '' && !Number.isFinite(Number(raw))) { toast('اكتب رقم', true); inp.focus(); return; }
    mark.textContent = '…';
    try {
      await POST('/api/count', { date: S.date, item_id: Number(tr.dataset.item), phase: inp.dataset.phase, qty: raw === '' ? null : Number(raw) });
      mark.textContent = ' ✓';
      const r = b.rows.find(x => x.item_id === Number(tr.dataset.item)); if (r) r[inp.dataset.phase] = raw === '' ? null : Number(raw);
      // العدّاد «باقي كذا»: يتحدث على طول، ولما يخلص تطلع «خلصت ✓»
      if (lastMine.length && inp.dataset.phase === phase) {
        const left = lastMine.filter(x => x[phase] == null).length, pr = $('.progress', main);
        if (!left) draw(); else if (pr) pr.textContent = `باقي ${left} من ${lastMine.length} — اكتب العدد قدام كل صنف`;
      }
    } catch (e) { mark.textContent = ' ✗'; toast(e.message, true); }
  }
  draw();
}

// ===================== السحب والتحضير =====================
async function pageTransfer(main, alive) {
  const [items, moves] = await Promise.all([itemsList(), GET('/api/moves?types=transfer,convert&date=' + S.date)]);
  if (!alive()) return;
  const daily = items.filter(i => i.daily);
  const floorMoves = moves.filter(m => m.location === 'floor');
  main.innerHTML = `
    <div class="card"><h3>سحب من المستودع للمحضّر / العرض</h3>
      <p class="muted small">مثال: نزلت ٥ كيلو سمك من الثلاجة ورا، أو حضّرت ٢٠ حنيذ دجاج. الصنف المحضّر يسحب مكوناته من المستودع لحاله.</p>
      <div class="row"><label class="f grow">الصنف<select id="tItem">${itemOptions(daily)}</select></label>
      <label class="f">الكمية<input id="tQty" inputmode="decimal" class="qty"></label>
      <label class="f grow">ملاحظة<input id="tNote"></label>
      <button class="btn primary" id="tGo" style="align-self:flex-end">سحب</button></div></div>
    <div class="card"><h3>تحويل صنف لصنف</h3>
      <p class="muted small">مثال: الصهوم اللي ما انباع صار برم أو حنيذ.</p>
      <div class="row"><label class="f grow">من<select id="cFrom">${itemOptions(daily)}</select></label>
      <label class="f">كمية<input id="cQf" inputmode="decimal" class="qty"></label>
      <label class="f grow">إلى<select id="cTo">${itemOptions(daily)}</select></label>
      <label class="f">كمية<input id="cQt" inputmode="decimal" class="qty" placeholder="نفسها"></label>
      <button class="btn primary" id="cGo" style="align-self:flex-end">تحويل</button></div></div>
    <div class="card"><h3>حركات اليوم</h3><div class="tbl-wrap"><table><thead><tr><th>الصنف</th><th class="n">الكمية</th><th>النوع</th><th>مين</th><th>ملاحظة</th><th></th></tr></thead><tbody>
      ${floorMoves.map(m => `<tr><td>${esc(m.item)}</td><td class="n">${qtyFmt(m.qty)} ${esc(m.unit)}</td><td>${m.type === 'convert' ? 'تحويل' : 'سحب'}</td><td>${esc(m.user || '')}</td><td class="small">${esc(m.note)}</td>
        <td><button class="btn small danger" data-del="${m.id}">حذف</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">ما فيه</td></tr>'}
    </tbody></table></div></div>`;
  $('#tGo').onclick = e => busy(e.currentTarget, async () => {
    await POST('/api/transfer', { date: S.date, item_id: $('#tItem').value, qty: $('#tQty').value, note: $('#tNote').value });
    toast('تم السحب ✓'); route();
  });
  $('#cGo').onclick = e => busy(e.currentTarget, async () => {
    await POST('/api/convert', { date: S.date, from_item_id: $('#cFrom').value, to_item_id: $('#cTo').value, qty_from: $('#cQf').value, qty_to: $('#cQt').value || $('#cQf').value });
    toast('تم التحويل ✓'); route();
  });
  $$('[data-del]', main).forEach(b => b.onclick = async () => { if (await confirmBox('تحذف الحركة؟')) busy(b, async () => { await DEL('/api/moves/' + b.dataset.del); route(); }); });
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
  if (tickets.some(t => t.status === 'reading')) setTimeout(() => { if (alive() && !document.querySelector('.modal-bg') && !$('#main').dataset.dirty) route(); }, 4000);
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
        ${t.status === 'reading' ? '<span class="badge amber"><span class="spin"></span> جاري القراءة</span>' : t.status === 'confirmed' ? '<span class="badge green">متأكدة</span>' : '<span class="badge">مسودة</span>'}</h3>
        <div class="thumbs">${t.images.map(i => `<img src="/uploads/${esc(i.path)}" data-img alt="صورة التذكرة" loading="lazy">`).join('')}</div></div>
      ${t.ocr_error ? `<div class="alert red">${esc(t.ocr_error)}</div>` : ''}
      ${t.label || t.ocr_cost ? `<div class="small muted">${esc(t.label || '')}${t.ocr_cost ? ` · تكلفة القراءة ≈ ${(t.ocr_cost * 100).toFixed(1)} سنت` : ''}</div>` : ''}
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
      <button class="btn" onclick="print()">طباعة</button></div>
    <div class="card"><h3>التنبيهات</h3>${alertsHtml(r.alerts)}</div>
    <div class="card"><h3>الفلوس</h3><div class="grid">
      <div class="stat"><div class="k">مبيعات لويفرس</div><div class="v">${money(m.loyverse_total)}</div></div>
      <div class="stat"><div class="k">مبيعات التذكرة</div><div class="v">${money(m.ticket_total)}</div></div>
      <div class="stat"><div class="k">مجموع المبيعات</div><div class="v">${money(m.total_sales)}</div></div>
      <div class="stat"><div class="k">المتوقع بسعر البيع</div><div class="v">${money(m.list_total)}</div></div>
      <div class="stat"><div class="k">خصومات/فرق سعر</div><div class="v">${money(m.discounts)}</div></div>
      <div class="stat"><div class="k">كاش لويفرس</div><div class="v">${money(m.cash_payments)}</div></div>
      <div class="stat"><div class="k">شبكة/غيره</div><div class="v">${money(m.card_payments)}</div></div>
      <div class="stat"><div class="k">مصروف من الدرج</div><div class="v">${money(m.cash_expenses)}</div></div>
      <div class="stat"><div class="k">الكاش المفروض</div><div class="v">${money(m.expected_cash)}</div></div>
      <div class="stat ${m.cash_shortage > 0 ? 'red' : m.cash_shortage != null ? 'green' : ''}"><div class="k">نقص الكاش</div><div class="v">${m.cash_shortage == null ? 'ما انجرد' : money(m.cash_shortage)}</div></div>
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
      <button class="btn primary" id="saveCash" style="align-self:flex-end">حفظ جرد الفلوس</button></div></div>
    <div class="card"><h3>النقص حسب الموظف</h3><div class="tbl-wrap"><table><thead><tr><th>الموظف (آخر اليوم)</th><th class="n">أصناف</th><th class="n">نقص (ريال)</th></tr></thead><tbody>
      ${r.by_person.map(p => `<tr><td>${esc(p.person)}</td><td class="n">${p.items}</td><td class="n ${p.shortage_value > 0 ? 'pos' : ''}">${money(p.shortage_value)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">الجرد ما اكتمل</td></tr>'}
    </tbody></table></div></div>
    ${bySec.map(([sec, rows]) => `<div class="card"><h3>${esc(sec)}</h3><div class="tbl-wrap"><table><thead><tr><th>الصنف</th><th class="n">أول اليوم</th><th class="n">انسحب</th><th class="n">انباع حسب الوصفة</th><th class="n">المفروض باقي</th><th class="n">آخر اليوم</th><th class="n">الفرق</th><th class="n">ريال</th></tr></thead><tbody>
      ${rows.map(x => `<tr><td>${esc(x.name)} <span class="muted small">${esc(x.unit)}</span></td><td class="n">${qtyFmt(x.opening)}</td><td class="n">${qtyFmt(x.received)}</td><td class="n">${qtyFmt(x.theoretical)}</td><td class="n">${qtyFmt(x.remaining_expected)}</td><td class="n">${qtyFmt(x.closing)}</td>
        <td class="n ${x.diff > 0 ? 'pos' : x.diff < 0 ? 'neg' : ''}">${x.diff == null ? '—' : qtyFmt(x.diff)}</td><td class="n">${x.diff_value == null ? '—' : money(x.diff_value)}</td></tr>`).join('')}
    </tbody></table></div></div>`).join('')}
    <p class="small muted">الفرق الموجب = نقص (انصرف أكثر من المباع حسب الوصفة). قيمة النقص بسعر البيع المحدد للصنف، وإذا ما فيه فبسعر الشراء.</p>`;
  $('#saveCash').onclick = e => busy(e.currentTarget, async () => { await POST('/api/cash', { date: S.date, cash: $('#cash').value, card: $('#card').value }); toast('انحفظ ✓'); route(); });
  const cd = $('#closeDay'); if (cd) cd.onclick = async () => { if (await confirmBox('تقفل اليوم؟ التذاكر بتتأكد وما يقدر أحد يعدل إلا المالك.')) busy(cd, async () => { await POST('/api/day/close', { date: S.date }); toast('انقفل ✓'); route(); }); };
  const ro = $('#reopen'); if (ro) ro.onclick = () => busy(ro, async () => { await POST('/api/day/close', { date: S.date, undo: true }); route(); });
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
const MOVE = { purchase: 'شراء', transfer: 'سحب للمحضّر', prep_use: 'تحضير', sale_use: 'حسب الوصفات', adjust: 'جرد', convert: 'تحويل', opening_pull: 'سحب من الثلاجة أول اليوم' };

// ===================== المشتريات =====================
async function pagePurchases(main, alive) {
  let items = (await itemsList(true)).filter(i => i.kind === 'raw');
  const [list, summary, suppliers] = await Promise.all([GET('/api/purchases'), isPurch() ? GET('/api/purchases/summary') : Promise.resolve(null), suppliersList()]);
  if (!alive()) return;
  const photos = [];
  let lines = [{ item_id: '', qty: '', unit_price: '', to_floor: false }];
  main.innerHTML = `<div class="card"><h3>تسجيل شراء</h3>
      <p class="muted small">اللي اشترى يسجل: اختر الأصناف أو صوّر الفاتورة أو اكتب. الشراء يدخل المستودع (أو المحضّر مباشرة إذا اخترت).</p>
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
      <button class="btn primary" id="pSave" style="margin-top:10px">حفظ الشراء</button></div>
    ${summary ? `<div class="card"><details><summary><b>جرد المشتريات (آخر ٣٠ يوم)</b></summary><div class="tbl-wrap"><table><thead><tr><th>الصنف</th><th class="n">اشتريت</th><th class="n">انصرف</th><th class="n">تعديل جرد</th><th class="n">الرصيد</th><th class="n">صرفت ريال</th></tr></thead><tbody>
      ${summary.map(s => `<tr><td>${esc(s.name)}</td><td class="n">${qtyFmt(s.bought)} ${esc(s.unit)}</td><td class="n">${qtyFmt(s.used)}</td><td class="n ${s.adjust < 0 ? 'pos' : ''}">${qtyFmt(s.adjust)}</td><td class="n">${qtyFmt(s.balance)}</td><td class="n">${money(s.spent)}</td></tr>`).join('')}
    </tbody></table></div></details></div>` : ''}
    <div class="card"><h3>المشتريات</h3><div class="tbl-wrap"><table><thead><tr><th>التاريخ</th><th>مين</th><th>المورد</th><th>الأصناف</th><th class="n">المبلغ</th><th>الدفع</th><th></th></tr></thead><tbody>
      ${list.map(p => `<tr><td class="small">${p.date}</td><td>${esc(p.user || '')}</td><td>${esc(p.supplier)}</td>
        <td class="small">${p.lines.map(l => l.pu_name ? `${esc(l.item)} ${qtyFmt(l.pu_qty)} ${esc(l.pu_name)}${l.pu_price ? ' × ' + money(l.pu_price) : ''} (= ${qtyFmt(l.qty)} ${esc(l.unit)})${l.to_floor ? ' (للمحضّر)' : ''}`
          : `${esc(l.item)} ${qtyFmt(l.qty)} ${esc(l.unit || '')}${l.unit_price ? ' × ' + money(l.unit_price) : ''}${l.to_floor ? ' (للمحضّر)' : ''}`).join('، ')}${p.note ? `<div class="muted">${esc(p.note)}</div>` : ''}</td>
        <td class="n">${money(p.total)}</td><td><span class="badge ${p.payment === 'credit' ? 'amber' : ''}">${PAYMENT[p.payment] || ''}</span></td>
        <td>${p.image ? `<img src="/uploads/${esc(p.image)}" data-img style="width:44px;height:44px;object-fit:cover;border-radius:6px;cursor:zoom-in">` : ''} <button class="btn small danger" data-del="${p.id}">حذف</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">ما فيه</td></tr>'}
    </tbody></table></div></div>`;
  bindPhotos(main, 'pu', photos);
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
          <label class="small" style="display:flex;gap:4px;align-items:center"><input type="checkbox" data-f="to_floor" ${l.to_floor ? 'checked' : ''}>يدخل جرد اليوم على طول</label></div>
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
          if (hit && Number(l.item_id) !== hit.id) { l.item_id = hit.id; l.unit = hit.units.length ? hit.units[0].name : ''; l.factor = ''; l.new_name = ''; l.to_floor = !!hit.daily && !hit.carry_over; return drawLines(); }
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
  $('#pSave').onclick = e => busy(e.currentTarget, async () => {
    const payment = ($('input[name="pPay"]:checked', main) || {}).value || 'cash';
    if (lines.some(l => l.unit === '__new' && l.item_id && Number(l.qty) && (!String(l.new_name || '').trim() || !(Number(l.factor) > 0)))) throw new Error('اكتب اسم الوحدة الجديدة وكم فيها');
    const send = lines.map(l => l.unit === '__new' ? { ...l, unit: l.new_name.trim() } : l);
    await POST('/api/purchases', { date: $('#pDate').value, supplier: $('#pSup').value, note: $('#pNote').value, total: $('#pTotal').value, payment, image: photos[0] || '', lines: send });
    S.cache.items = null; toast('انحفظ الشراء ✓'); route();
  });
  $$('[data-img]', main).forEach(img => img.onclick = () => showImage(img.src));
  $$('[data-del]', main).forEach(b => b.onclick = async () => { if (await confirmBox('تحذف الشراء؟ بيطلع من المستودع.')) busy(b, async () => { await DEL('/api/purchases/' + b.dataset.del); route(); }); });
}

// ===================== الموردين (الشراء الآجل) =====================
async function pageSuppliers(main, alive) {
  const list = await suppliersList();
  if (!alive()) return;
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
      <label class="small" style="display:flex;gap:6px;align-items:center;margin:8px 0"><input type="checkbox" id="pc"> دفعته من الدرج</label>
      <label class="f">ملاحظة<input id="pn" placeholder="تحويل، شيك…"></label>
      <div style="margin-top:8px">${photoInputs('sp', false)}</div>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="pg">حفظ السداد</button><button class="btn" data-close>إلغاء</button></div>`, (m, close) => {
      bindPhotos(m, 'sp', photos);
      $('#pg', m).onclick = e => busy(e.currentTarget, async () => {
        await POST(`/api/suppliers/${x.id}/pay`, { amount: $('#pa', m).value, paid_from_cash: $('#pc', m).checked, note: $('#pn', m).value, date: S.date, image: photos[0] || '' });
        close(); toast('انحفظ السداد ✓'); route();
      });
    });
  });
  $$('[data-st]', main).forEach(b => b.onclick = () => busy(b, async () => {
    const st = await GET('/api/suppliers/' + b.dataset.st);
    const rows = [
      ...st.purchases.map(p => ({ date: p.date, kind: 'شراء ' + (PAYMENT[p.payment] || ''), amount: p.total, credit: p.payment === 'credit', detail: p.lines.map(l => `${l.item} ${qtyFmt(l.qty)}`).join('، ') || p.note, img: p.image,
        status: p.payment !== 'credit' ? '' : p.remaining <= 0 ? '<span class="badge green">مسددة</span>' : p.paid > 0 ? `<span class="badge amber">باقي ${money(p.remaining)}</span>` : '<span class="badge red">ما تسددت</span>' })),
      ...st.payments.map(p => ({ date: p.date, kind: 'سداد' + (p.paid_from_cash ? ' (من الدرج)' : ''), amount: -p.amount, detail: p.note, img: p.image, pid: p.id })),
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
async function pageExpenses(main, alive) {
  const list = isSup() ? await GET('/api/expenses') : [];
  if (!alive()) return;
  const photos = [];
  main.innerHTML = `<div class="card"><h3>تسجيل مصروف</h3>
      <div class="row"><label class="f">المبلغ<input id="eAmt" inputmode="decimal"></label><label class="f grow">النوع<input id="eCat" list="ecats" placeholder="غاز، كهرباء، نقل…"></label>
      <label class="f">التاريخ<input type="date" id="eDate" value="${S.date}"></label>
      <label class="f" style="flex-direction:row;align-items:center;gap:6px;align-self:flex-end"><input type="checkbox" id="eCash" checked> من الدرج</label></div>
      <datalist id="ecats">${['غاز', 'كهرباء', 'ماء', 'نقل', 'صيانة', 'تنظيف', 'أكياس وعلب', 'إيجار', 'أخرى'].map(c => `<option value="${c}">`).join('')}</datalist>
      <label class="f" style="margin-top:8px">ملاحظة<input id="eNote"></label>
      <div style="margin-top:8px">${photoInputs('ex', false)}</div>
      <button class="btn primary" id="eSave" style="margin-top:10px">حفظ</button></div>
    ${isSup() ? `<div class="card"><h3>المصروفات (آخر ٣٠ يوم)</h3><div class="tbl-wrap"><table><thead><tr><th>التاريخ</th><th>النوع</th><th>ملاحظة</th><th>مين</th><th class="n">المبلغ</th><th></th></tr></thead><tbody>
      ${list.map(x => `<tr><td class="small">${x.date}</td><td>${esc(x.category)}</td><td class="small">${esc(x.note)}</td><td class="small">${esc(x.user || '')}</td><td class="n">${money(x.amount)}</td>
        <td>${x.image ? `<img src="/uploads/${esc(x.image)}" data-img style="width:44px;height:44px;object-fit:cover;border-radius:6px;cursor:zoom-in">` : ''} <button class="btn small danger" data-del="${x.id}">حذف</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">ما فيه</td></tr>'}
      </tbody><tfoot><tr><td colspan="4">المجموع</td><td class="n">${money(list.reduce((s, x) => s + x.amount, 0))}</td><td></td></tr></tfoot></table></div></div>` : ''}`;
  bindPhotos(main, 'ex', photos);
  $('#eSave').onclick = e => busy(e.currentTarget, async () => {
    await POST('/api/expenses', { amount: $('#eAmt').value, category: $('#eCat').value, note: $('#eNote').value, date: $('#eDate').value, paid_from_cash: $('#eCash').checked, image: photos[0] || '' });
    toast('انحفظ ✓'); route();
  });
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
async function pageItems(main, alive, kind = 'raw') {
  const [all_, sections, users] = await Promise.all([itemsList(true), GET('/api/sections'), usersList()]);
  if (!alive()) return;
  const items = all_.filter(i => i.kind === kind);
  const respOf = i => i.closing_user_id || (sections.find(s => s.id === i.section_id) || {}).closing_user_id || '';
  const uName = id => (users.find(u => u.id === id) || {}).name || '';
  main.innerHTML = `<div class="row no-print" style="margin-bottom:10px"><button class="btn primary" id="iNew">${kind === 'prepared' ? '+ صنف تحضير' : '+ صنف مستودع'}</button></div>
    ${groupBy(items, i => (i.daily ? 'ينجرد يوميًا' : 'ما ينجرد يوميًا (المستودع)')).map(([sec, list]) => `<div class="card"><h3>${esc(sec)}</h3><div class="tbl-wrap"><table><thead><tr><th>الصنف</th><th>الوحدة</th><th>النوع</th><th class="n">سعر الشراء</th><th class="n">قيمة البيع</th><th>الجرد</th><th></th></tr></thead><tbody>
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
      <div class="row" style="margin:8px 0" ${onlyPurch() ? 'hidden' : ''}><label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-k="daily" ${it.daily ? 'checked' : ''}> يدخل الجرد اليومي</label>
        <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-k="carry_over" ${it.carry_over ? 'checked' : ''}> يقعد لبكرة (إذا لا = هالك آخر اليوم)</label>
        <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-k="pull_on_open" ${it.pull_on_open ? 'checked' : ''}> يتجهّز أو ينسحب أول اليوم ويدخلونه في جرد أول اليوم (الزيادة عن آخر أمس: الخام ينخصم من المستودع، والمحضّر تنخصم مكوناته)</label></div>
      <label class="f">ملاحظة<input data-k="note" value="${esc(it.note)}"></label>
      <div style="margin-top:10px"><b class="small">وحدات الشراء (مثل: كرتون = 24 ${esc(it.unit)})</b><div id="units"></div><button class="btn small" id="uAdd">+ وحدة</button></div>
      <div style="margin-top:10px" ${onlyPurch() ? 'hidden' : ''}><b class="small">وصفة التحضير (للمحضّر — تسحب من المستودع لكل ١ ${esc(it.unit)})</b><div id="comps"></div><button class="btn small" id="cAdd">+ مكوّن</button></div>
      <div class="row" style="margin-top:14px"><button class="btn primary" id="iSave">حفظ</button><button class="btn" data-close>إلغاء</button>${it.id && isPurch() ? '<button class="btn danger" id="iDel">حذف الصنف</button>' : ''}</div>`, (m, close) => {
      const drawC = () => {
        $('#comps', m).innerHTML = comps.map((c, i) => `<div class="row" data-ci="${i}" style="margin-top:6px"><select class="grow" data-cf="component_id">${itemOptions(items.filter(x => x.id !== it.id), c.component_id)}</select><input class="qty" data-cf="qty" inputmode="decimal" value="${c.qty || ''}"><button class="btn small danger" data-crm="${i}">×</button></div>`).join('');
        $$('[data-cf]', m).forEach(inp => inp.onchange = () => { comps[Number(inp.closest('[data-ci]').dataset.ci)][inp.dataset.cf] = inp.value; });
        $$('[data-crm]', m).forEach(b => b.onclick = () => { comps.splice(Number(b.dataset.crm), 1); drawC(); });
      };
      drawC();
      $('#cAdd', m).onclick = () => { comps.push({ component_id: '', qty: '' }); drawC(); };
      const drawU = () => {
        $('#units', m).innerHTML = units.map((x, i) => `<div class="row" data-ui="${i}" style="margin-top:6px"><input class="grow" data-uf="name" placeholder="كرتون" value="${esc(x.name)}">
          <span class="small muted">=</span><input class="qty" data-uf="factor" inputmode="decimal" value="${x.factor || ''}"><span class="small muted">${esc(it.unit || 'وحدة')}</span><button class="btn small danger" data-urm="${i}">×</button></div>`).join('');
        $$('[data-uf]', m).forEach(inp => inp.oninput = () => { units[Number(inp.closest('[data-ui]').dataset.ui)][inp.dataset.uf] = inp.value; });
        $$('[data-urm]', m).forEach(b => b.onclick = () => { units.splice(Number(b.dataset.urm), 1); drawU(); });
      };
      drawU();
      $('#uAdd', m).onclick = () => { units.push({ name: '', factor: '' }); drawU(); };
      $('#iSave', m).onclick = e => busy(e.currentTarget, async () => {
        const body = { id: it.id };
        $$('[data-k]', m).forEach(inp => { body[inp.dataset.k] = inp.type === 'checkbox' ? inp.checked : inp.value; });
        const r = await POST('/api/items', body);
        if (!onlyPurch()) await PUT(`/api/items/${r.id}/components`, { components: comps });
        // المسؤول: يتسجل في «عهدته» (للأصناف اللي تنجرد يوميًا)
        const resp = $('#iResp', m);
        if (!onlyPurch() && body.daily && resp && String(resp.value) !== String(respOf(it))) await POST('/api/responsibility', { item_id: r.id, user_id: resp.value || null });
        await PUT(`/api/items/${r.id}/units`, { units });
        S.cache.items = null; close(); toast('انحفظ ✓'); route();
      });
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
      return `<div class="card" data-staff="${u.id}"><div class="sec-head"><h3 style="margin:0">${esc(u.name)} <span class="muted small">· ${ROLE[u.role]} · ${mine.length} صنف</span></h3></div>
        ${mine.length ? `<div class="chips" style="margin:8px 0">${mine.map(i => `<span class="badge brand" style="font-size:14px;padding:6px 10px">${esc(i.name)}${i.opener_id && i.opener_id !== u.id ? ` <span class="muted">(يفتحه ${esc(uName(i.opener_id))})</span>` : ''} <button class="btn small" data-unassign="${i.id}" title="شيله" style="padding:0 6px;min-height:0">×</button></span>`).join('')}</div>` : '<p class="muted small">ما عليه أصناف</p>'}
        <div class="row"><select class="grow" data-add="${u.id}">${itemOpt(items.filter(i => i.user_id !== u.id), '+ أضف صنف عليه…')}</select></div></div>`;
    }).join('')}
    ${isOwner() ? `<div class="card"><div class="sec-head"><h3 style="margin:0">الموظفين</h3><button class="btn small primary" id="uNew">+ موظف</button></div>
      <div class="tbl-wrap"><table><thead><tr><th>الاسم</th><th>الصلاحية</th><th>الرقم السري</th><th class="n">الراتب</th><th></th></tr></thead><tbody>
      ${users.map(u => `<tr${u.active ? '' : ' style="opacity:.5"'}><td>${esc(u.name)}${u.active ? '' : ' (موقوف)'}</td><td>${ROLE[u.role]}${u.role === 'supervisor' && (u.no_sales || u.no_recipes) ? `<div class="item-note">بدون: ${[u.no_sales ? 'المبيعات والتقارير' : '', u.no_recipes ? 'الوصفات' : ''].filter(Boolean).join('، ')}</div>` : ''}</td><td>${esc(u.pin)}</td><td class="n">${money(u.salary)}</td><td><button class="btn small" data-u="${u.id}">تعديل</button></td></tr>`).join('')}
      </tbody></table></div></div>` : ''}`;
  const assign = (itemId, userId) => busy(null, async () => { await POST('/api/responsibility', { item_id: Number(itemId), user_id: userId ? Number(userId) : null }); toast('انحفظ ✓'); route(); });
  $$('[data-assign]', main).forEach(sel => sel.onchange = () => sel.value && assign(sel.dataset.assign, sel.value));
  $$('[data-add]', main).forEach(sel => sel.onchange = () => sel.value && assign(sel.value, sel.dataset.add));
  $$('[data-unassign]', main).forEach(b => b.onclick = async () => { if (await confirmBox('تشيله عنه؟ بيصير بدون مسؤول.')) assign(b.dataset.unassign, null); });
  const editUser = u => {
    u = u || { name: '', role: 'worker', pin: '', salary: 0, active: 1 };
    modal(u.id ? 'تعديل موظف' : 'موظف جديد', `
      <label class="f">الاسم<input id="un" value="${esc(u.name)}"></label>
      <div class="row"><label class="f grow">الصلاحية<select id="ur">${Object.entries(ROLE).map(([k, v]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="f">الرقم السري<input id="up" inputmode="numeric" value="${esc(u.pin)}" placeholder="0000"></label><label class="f">الراتب الشهري<input id="us" inputmode="decimal" value="${u.salary || ''}"></label></div>
      <div id="supPerms" style="margin-top:8px">
        <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="uSales" ${u.no_sales ? '' : 'checked'}> يشوف المبيعات والتقارير وتذكرة الكاشير</label>
        <label class="small" style="display:flex;gap:6px;align-items:center;margin-top:4px"><input type="checkbox" id="uRec" ${u.no_recipes ? '' : 'checked'}> يشوف الوصفات</label></div>
      ${u.id ? `<label class="small" style="display:flex;gap:6px;align-items:center;margin-top:8px"><input type="checkbox" id="ua" ${u.active ? 'checked' : ''}> شغّال</label>` : ''}
      <div class="row" style="margin-top:14px"><button class="btn primary" id="usv">حفظ</button><button class="btn" data-close>إلغاء</button></div>`, (m, close) => {
      // صلاحيات المبيعات والوصفات تخص المشرف (المالك يشوف كل شي، والعامل ومسؤول المشتريات ما يشوفونها أصلًا)
      const perms = () => { $('#supPerms', m).hidden = $('#ur', m).value !== 'supervisor'; };
      $('#ur', m).onchange = perms; perms();
      $('#usv', m).onclick = e => busy(e.currentTarget, async () => {
        await POST('/api/users', { id: u.id, name: $('#un', m).value, role: $('#ur', m).value, pin: $('#up', m).value || '0000', salary: $('#us', m).value, active: u.id ? $('#ua', m).checked : true,
          no_sales: !$('#uSales', m).checked, no_recipes: !$('#uRec', m).checked });
        S.cache.users = null; close(); toast('انحفظ ✓'); route();
      });
    });
  };
  const un = $('#uNew'); if (un) un.onclick = () => editUser(null);
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
async function pageSettings(main, alive) {
  const s = isOwner() ? await GET('/api/settings') : null;
  const ck = isOwner() ? await GET('/api/settings/claude-key') : null;
  if (!alive()) return;
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
      <div class="row" style="margin-top:12px"><button class="btn primary" id="save">حفظ</button><button class="btn" id="sync">اسحب الحين</button><button class="btn" id="full">اسحب كل الأيام من جديد</button></div>
      <p class="small muted">آخر سحب: ${s.last_receipt_sync ? new Date(s.last_receipt_sync).toLocaleString('ar-SA') : 'ما سحب'}</p>
      <details><summary class="small">سجل السحب</summary>${s.log.map(l => `<div class="small ${l.ok ? '' : 'pos'}">${new Date(l.at + 'Z').toLocaleString('ar-SA')} — ${esc(l.message)}</div>`).join('')}</details></div>
    <div class="card"><h3>ربط Claude (المساعد)</h3>
      <p class="muted small">مفتاح يخلي Claude يدخل على النظام ويشوف كل شي ويضيف الوصفات. كل شي يسويه ينكتب باسم «Claude (المساعد)» وتقدر تعدّل عليه. تقدر تلغيه متى ما بغيت.</p>
      <div id="ckState" class="small" style="margin-bottom:8px">${ck && ck.active ? '<span class="badge green">المفتاح شغّال</span>' : '<span class="badge">ما فيه مفتاح</span>'}</div>
      <div class="row"><button class="btn primary" id="ckNew">${ck && ck.active ? 'سوّ مفتاح جديد (القديم يبطل)' : 'سوّ مفتاح لـ Claude'}</button>${ck && ck.active ? '<button class="btn danger" id="ckDel">إلغاء المفتاح</button>' : ''}</div>
      <div id="ckOut"></div></div>` : ''}
    <div class="card"><h3>رقمي السري</h3><div class="row"><input id="np" inputmode="numeric" type="password" placeholder="الرقم الجديد" style="max-width:200px"><button class="btn" id="cp">تغيير</button></div></div>`;
  if (s) {
    $('#save').onclick = e => busy(e.currentTarget, async () => {
      await POST('/api/settings', { loyverse_token: $('#lt').value, anthropic_key: $('#ak').value, sync_days_back: $('#sd').value, day_start_hour: $('#dh').value, opening_deadline_hour: $('#oh').value, ticket_in_cash: $('#tc').checked ? '1' : '0', ticket_tolerance: $('#tt').value });
      S.me = await GET('/api/me'); toast('انحفظ ✓ — السحب بدأ'); route();
    });
    $('#sync').onclick = e => busy(e.currentTarget, async () => { const r = await POST('/api/sync', {}); toast(r.message || 'تم', r.ok === false); route(); });
    $('#full').onclick = e => busy(e.currentTarget, async () => { const r = await POST('/api/sync', { full: true }); toast(r.message || 'تم', r.ok === false); route(); });
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
    const cd = $('#ckDel');
    if (cd) cd.onclick = async () => { if (await confirmBox('تلغي مفتاح Claude؟ ما يقدر يدخل بعدها.')) busy(cd, async () => { await DEL('/api/settings/claude-key'); toast('انلغى ✓'); route(); }); };
  }
  $('#cp').onclick = e => busy(e.currentTarget, async () => { await POST('/api/me/pin', { pin: $('#np').value }); toast('تغيّر ✓'); $('#np').value = ''; });
}

boot();
