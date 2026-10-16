'use strict';
// 📄 تقرير اليوم (PDF): الفلوس، المبيعات، المشتريات، المصاريف، وجرد كل صنف — من الموقع نفسه (بدون ذكاء صناعي)
// نفس شكل التقرير الكبير، وينرسل في جروب «حساب اليوم» بعد ما تنزل الورقة
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { get, all } = require('./db');
const C = require('./calc');
const PR = require('./printer_read');

const E = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const N0 = n => Math.round(Number(n) || 0).toLocaleString('en-US');
const N2 = n => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
const Q = n => n == null ? '—' : String(Math.round(n * 1000) / 1000);
const WD = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const AR_MONTH = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const atMs = s => { s = String(s || ''); if (!s) return NaN; return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z'); };
const rHour = ms => new Date(ms + 3 * 3600e3).getUTCHours();
const hh = h => `${h % 12 || 12}`;

function data(date) {
  const rep = C.dailyReport(date), m = rep.money, rows = rep.board.rows || [];
  const cc = get('SELECT cash, card, spent, total FROM cash_counts WHERE date = ?', date);
  const DS = require('./daily_sheet');
  const sheet = DS.summary(date, cc ? { card: cc.card, cash: cc.cash, spent: cc.spent, total_written: cc.total } : {});
  const t = PR.tickets(date);
  const live = t.tickets.filter(x => x.status === 'open' || x.status === 'edited');
  const hours = new Map();
  for (const k of live) {
    const first = (k.events || []).map(e => atMs(e.at)).filter(Number.isFinite).sort((a, b) => a - b)[0];
    if (!Number.isFinite(first)) continue;
    const h = rHour(first), x = hours.get(h) || { n: 0, v: 0 }; x.n++; x.v += k.value || 0; hours.set(h, x);
  }
  const lines = all(`SELECT p.id, p.supplier, p.total, p.payment, p.awaiting_invoice, i.name, i.unit, l.qty, l.unit_price FROM purchases p
    LEFT JOIN purchase_lines l ON l.purchase_id = p.id LEFT JOIN items i ON i.id = l.item_id WHERE p.date = ? ORDER BY p.total DESC, p.id`, date);
  const purchases = []; const pm = new Map();
  for (const l of lines) {
    if (!pm.has(l.id)) { const p = { supplier: l.supplier || '', total: l.total, payment: l.payment, awaiting: !!l.awaiting_invoice, items: [] }; pm.set(l.id, p); purchases.push(p); }
    if (l.name) pm.get(l.id).items.push(`${l.name} ${Q(l.qty)} ${l.unit || ''}`.trim());
  }
  const counted = rows.filter(r => r.opening != null || r.closing != null || r.received || r.added);
  const missing = rows.filter(r => !r.empty && r.closing == null && (r.opening != null || r.received || r.added || r.theoretical));
  // 🌙 نقص الليل: الصبح أقل من (باقي أمس − اللي انباع بعد جرد الليل)
  const NG = require('./night_gap'), night = [];
  for (const r of rows) {
    if (r.no_opening || r.opening == null || r.suggested_opening == null || r.opening >= r.suggested_opening) continue;
    const prev = get('SELECT closing_at FROM counts WHERE date = ? AND item_id = ?', C.addDays(date, -1), r.item_id) || {};
    const to = Date.parse(r.opening_at) || Date.now(), from = Date.parse(prev.closing_at) || to;
    const sold = Math.max(0, NG.useBetween(from, to).get(r.item_id) || 0);
    const gap = C.r3(r.suggested_opening - sold - r.opening);
    if (gap > (/^(كجم|كيلو)$/.test(r.unit) ? 0.05 : 0.5)) night.push({ name: r.name, unit: r.unit, gap, by: r.opening_by || '' });
  }
  const honey = require('./honey').info(date);
  return { date, rep, m, rows, counted, missing, sheet, live, hours, purchases, night, honey, cc };
}

function chartHours(hours) {
  const order = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3];
  const vals = order.map(h => (hours.get(h) || { v: 0 }).v), mx = Math.max(1, ...vals);
  const W = 720, H = 170, bw = (W - 20) / order.length; let s = '';
  order.forEach((h, i) => {
    const v = vals[i], bh = (v / mx) * (H - 44), x = 10 + i * bw, peak = v === mx && v > 0;
    s += `<rect class="bar${peak ? ' fri' : ''}" x="${(x + 2).toFixed(1)}" y="${(H - 26 - bh).toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${bh.toFixed(1)}"/>`;
    if (v > 0) s += `<text class="ax" x="${(x + bw / 2).toFixed(1)}" y="${(H - 30 - bh).toFixed(1)}" text-anchor="middle">${N0(v)}</text>`;
    s += `<text class="ax" x="${(x + bw / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle">${hh(h)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" direction="ltr"><line class="gl" x1="10" x2="${W - 10}" y1="${H - 26}" y2="${H - 26}"/>${s}</svg>`;
}

function html(d) {
  const { date, m, rep, rows, sheet, live } = d;
  const dt = new Date(date + 'T00:00:00Z');
  const title = `${WD[dt.getUTCDay()]} ${dt.getUTCDate()} ${AR_MONTH[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
  const sales = m.total_sales || sheet.sales || 0, take = live.filter(k => k.dining === 'takeaway').length;
  const avg = live.length ? sales / live.length : 0;
  const foodPct = sales ? Math.round(100 * (m.cogs || 0) / sales) : 0;
  const shortItems = rows.filter(r => r.diff != null && (r.diff_value || 0) > 0.5).sort((a, b) => b.diff_value - a.diff_value);
  const shortVal = shortItems.reduce((s, r) => s + r.diff_value, 0);
  const wasteVal = rows.reduce((s, r) => s + (r.waste_value || 0), 0);
  const purchTot = d.purchases.reduce((s, p) => s + (p.total || 0), 0);
  const expTot = (rep.expenses || []).reduce((s, e) => s + (e.amount || 0), 0);
  const profit = sales - (m.cogs || 0) - expTot;
  const diff = sheet.diff, hasSheet = d.cc != null;
  const cashLine = !hasSheet ? '<span class="chip mute">ما وصلت الورقة</span>' : Math.abs(diff) <= 0.5 ? '<span class="chip ok">مطابق ✓</span>' : diff > 0 ? `<span class="chip crit">نقص ${N2(diff)}</span>` : `<span class="chip warn">زيادة ${N2(-diff)}</span>`;
  const tiles = [
    [N0(sales), 'المبيعات من الطابعة (ريال)'], [String(live.length), 'طلب'], [N0(avg), 'متوسط الطلب'],
    [`${foodPct}%`, 'تكلفة الأكل حسب الوصفات'], [N0(shortVal), 'نقص الجرد (ريال)', shortVal > 100 ? 'bad' : ''], [N0(profit), 'ربح تقديري (قبل الرواتب)', 'honey'],
  ].map(([b, s, c]) => `<div class="tile ${c || ''}"><b>${b}</b><span>${s}</span></div>`).join('');
  // الخلاصة
  const pts = [];
  pts.push(`<b>الفلوس:</b> المفروض يوصل ${N2(sheet.expected)}${hasSheet ? `، والورقة ${N2(sheet.paper)} — ${cashLine}` : ' — الورقة ما وصلت'}.`);
  pts.push(`<b>المبيعات ${N0(sales)} ريال</b> من ${live.length} طلب (${live.length ? Math.round(100 * take / live.length) : 0}% سفري).`);
  if (shortItems.length) pts.push(`<b>نقص الجرد ${N0(shortVal)} ريال</b> في ${shortItems.length} صنف — أكبرها: ${shortItems.slice(0, 3).map(r => `${E(r.name)} (${N0(r.diff_value)})`).join('، ')}.`);
  else pts.push('<b>الجرد:</b> ما فيه نقص يُذكر ✓');
  if (d.missing.length) pts.push(`<b>${d.missing.length} صنف ما انجرد آخر الدوام</b> — نقصها ما ينحسب.`);
  if (d.night.length) pts.push(`<b>نقص بالليل:</b> ${d.night.map(n => `${E(n.name)} ${Q(n.gap)} ${E(n.unit)}`).join('، ')}.`);
  pts.push(`<b>المشتريات ${N0(purchTot)}</b> و<b>المصاريف ${N0(expTot)}</b>.`);
  // التذاكر باسم
  const named = sheet.named.length ? `<div class="tbl"><table><thead><tr><th>الاسم</th><th>المبلغ</th><th>الأصناف</th></tr></thead><tbody>${sheet.named.map(c => `<tr><td>${E(c.name)}</td><td class="n">${N2(c.total)}</td><td class="sub2">${E(c.items.join('، '))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="sub">ما فيه تذاكر باسم.</p>';
  const prods = (rep.sales || []).slice().sort((a, b) => b.amount - a.amount).slice(0, 12)
    .map(p => `<tr><td>${E(p.name)}${p.variant ? ' ' + E(p.variant) : ''}</td><td class="n">${Q(p.qty)}</td><td class="n">${N0(p.amount)}</td><td class="n">${p.amount ? Math.round(100 * p.cost / p.amount) : 0}%</td></tr>`).join('');
  const purch = d.purchases.map(p => `<tr><td>${E(p.supplier || 'بدون اسم مورد')}${p.awaiting ? ' <span class="chip warn">ينتظر الحساب</span>' : ''}</td><td class="sub2">${E(p.items.join('، '))}</td><td class="n">${N0(p.total)}</td></tr>`).join('') || '<tr><td colspan="3" class="sub">ما فيه</td></tr>';
  const exps = (rep.expenses || []).map(e => `<tr><td>${E(e.category || '—')}</td><td class="sub2">${E(e.note || '')}${e.user ? ' — ' + E(e.user) : ''}</td><td class="n">${N2(e.amount)}</td></tr>`).join('') || '<tr><td colspan="3" class="sub">ما فيه</td></tr>';
  // الجرد: كل صنف، بالعهدة، النقص الأكبر فوق
  const secs = new Map();
  for (const r of d.counted) { const k = r.section || 'بدون عهدة'; if (!secs.has(k)) secs.set(k, []); secs.get(k).push(r); }
  const secList = [...secs.entries()].map(([k, rs]) => ({ k, rs: rs.sort((a, b) => (b.diff_value || 0) - (a.diff_value || 0)), short: rs.reduce((s, r) => s + Math.max(0, r.diff_value || 0), 0) })).sort((a, b) => b.short - a.short);
  const cell = r => {
    const dv = r.diff_value || 0, cls = r.diff == null ? '' : dv > 0.5 ? 'neg' : r.diff < -0.0001 ? 'pos' : 'zero';
    return `<tr class="${cls}"><td>${E(r.name)} <span class="sub2">${E(r.unit)}</span>${r.closing == null ? ' <span class="chip mute">ما انجرد</span>' : ''}</td><td class="n">${Q(r.opening)}</td><td class="n">${Q((r.received || 0) + (r.added || 0)) === '0' ? '—' : Q((r.received || 0) + (r.added || 0))}</td><td class="n">${Q(r.theoretical)}</td><td class="n">${Q(r.actual)}</td><td class="n">${Q(r.closing)}</td><td class="n">${r.diff == null ? '—' : Q(r.diff)}</td><td class="n">${r.diff == null ? '—' : N0(dv)}</td></tr>`;
  };
  const inv = secList.map(s => `<h3>${E(s.k)}${s.short > 0.5 ? ` <span class="chip crit">نقص ${N0(s.short)}</span>` : ''}</h3>
    <div class="tbl"><table><thead><tr><th>الصنف</th><th>أول</th><th>دخل</th><th>المفروض انصرف</th><th>انصرف فعلاً</th><th>آخر</th><th>الفرق</th><th>القيمة</th></tr></thead><tbody>${s.rs.map(cell).join('')}</tbody></table></div>`).join('');
  const byPerson = (rep.by_person || []).filter(p => p.shortage_value > 0.5).sort((a, b) => b.shortage_value - a.shortage_value)
    .map(p => `<tr><td>${E(p.person)}</td><td class="n">${p.items}</td><td class="n">${N0(p.shortage_value)}</td></tr>`).join('');
  const waste = rows.filter(r => r.wasted > 0).map(r => `<tr><td>${E(r.name)}</td><td class="n">${Q(r.wasted)} ${E(r.unit)}</td><td class="n">${N0(r.waste_value)}</td></tr>`).join('');
  const H = d.honey;
  const honey = H && H.log.length ? `<div class="flow">${H.log.map(l => `<div><b>${l.weight != null ? Math.round(l.weight * 1000) + ' جرام' : '—'}</b><span>${({ opening: 'القارورة الصبح', fill: 'بعد التعبئة', closing: 'آخر الدوام', empty: 'الدبة خلصت' })[l.kind] || l.kind}</span></div>`).join('')}</div>` : '<p class="sub">ما انصوّرت القارورة اليوم.</p>';
  // التوصيات
  const recs = [];
  if (hasSheet && diff > 0.5) recs.push(`الدرج ناقص ${N2(diff)} ريال — راجع التذاكر اللي انطبعت بعد الورقة قبل ما تحاسب.`);
  for (const r of shortItems.slice(0, 3)) recs.push(`${E(r.name)}: ناقص ${Q(r.diff)} ${E(r.unit)} (${N0(r.diff_value)} ريال) — جرده ${E(r.closing_by || r.closing_user || '')}.`);
  if (d.missing.length) recs.push(`${d.missing.length} صنف ما انجرد: ${d.missing.slice(0, 8).map(r => E(r.name)).join('، ')}${d.missing.length > 8 ? '…' : ''}.`);
  const noSup = d.purchases.filter(p => !p.supplier).length; if (noSup) recs.push(`${noSup} فاتورة شراء بدون اسم مورد.`);
  for (const n of d.night) recs.push(`${E(n.name)} نقص بالليل ${Q(n.gap)} ${E(n.unit)} — جرد الصبح ${E(n.by)}.`);
  if (!recs.length) recs.push('كل شي مضبوط اليوم 👌');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تقرير السلام ${date}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600&family=Readex+Pro:wght@500;700&display=swap">
<style>
@page{size:A4;margin:12mm 10mm}
:root{--bg:#fff;--surface:#fff;--ink:#17302f;--muted:#5d6e6b;--line:#dde3e0;--sea:#0f6b66;--honey:#c9861a;--honey-soft:#f6e7c9;
  --crit:#b3261e;--crit-bg:#fbe6e4;--warn:#9a6200;--warn-bg:#fdf0d5;--ok:#2f6b3a;--ok-bg:#e3f1e5;--mute-bg:#eceeed;
  --display:"Readex Pro","Noto Kufi Arabic","IBM Plex Sans Arabic","Noto Sans Arabic",sans-serif;--body:"IBM Plex Sans Arabic","Noto Sans Arabic","Noto Naskh Arabic","DejaVu Sans",sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--body);font-size:11.5px;line-height:1.6;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.wrap{display:flex;flex-direction:column;gap:18px}
h1,h2,h3{font-family:var(--display);margin:0;line-height:1.3}
h1{font-size:22px} h2{font-size:15px;color:var(--sea);border-bottom:2px solid var(--line);padding-bottom:4px} h3{font-size:12.5px;margin-top:4px}
p{margin:0}
section{display:flex;flex-direction:column;gap:8px;break-inside:auto}
.lede{color:var(--muted)}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.tile{border:1px solid var(--line);border-radius:8px;padding:7px 10px;display:flex;flex-direction:column}
.tile b{font-family:var(--display);font-size:17px;font-variant-numeric:tabular-nums}
.tile span{color:var(--muted);font-size:10px}
.tile.honey{background:var(--honey-soft);border-color:transparent} .tile.bad{background:var(--crit-bg);border-color:transparent} .tile.bad b{color:var(--crit)}
ul.points{margin:0;padding-inline-start:18px;display:flex;flex-direction:column;gap:3px}
.tbl{border:1px solid var(--line);border-radius:8px;overflow:hidden}
table{border-collapse:collapse;width:100%;font-size:10.5px}
th,td{padding:4px 8px;text-align:start;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:9.5px;background:#f6f7f5;white-space:nowrap}
th:not(:first-child){text-align:end}
tr{break-inside:avoid} tr:last-child td{border-bottom:0}
td.n{font-variant-numeric:tabular-nums;white-space:nowrap;text-align:end}
tr.neg td{background:var(--crit-bg)} tr.neg td:nth-last-child(-n+2){color:var(--crit);font-weight:600}
tr.pos td:nth-last-child(-n+2){color:var(--ok)}
.sub{color:var(--muted);font-size:10px} .sub2{color:var(--muted);font-size:10px}
.chip{display:inline-block;font-size:9.5px;font-weight:600;padding:0 7px;border-radius:99px;white-space:nowrap}
.chip.crit{background:var(--crit-bg);color:var(--crit)} .chip.warn{background:var(--warn-bg);color:var(--warn)} .chip.ok{background:var(--ok-bg);color:var(--ok)} .chip.mute{background:var(--mute-bg);color:var(--muted)}
.fig{border:1px solid var(--line);border-radius:8px;padding:8px}
.fig svg{width:100%;height:auto;display:block}
.bar{fill:var(--sea)} .bar.fri{fill:var(--honey)} .gl{stroke:var(--line)} .ax{fill:var(--muted);font-size:10px;font-family:var(--body)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:10px} .cols>*{min-width:0;display:flex;flex-direction:column;gap:6px}
.money{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.money div{border:1px solid var(--line);border-radius:8px;padding:6px 10px} .money b{display:block;font-family:var(--display);font-size:14px;font-variant-numeric:tabular-nums} .money span{color:var(--muted);font-size:10px}
.flow{display:flex;flex-wrap:wrap;gap:6px} .flow div{border:1px solid var(--line);border-radius:8px;padding:6px 10px} .flow b{display:block;font-family:var(--display)} .flow span{color:var(--muted);font-size:10px}
ol.recs{margin:0;padding-inline-start:18px;display:flex;flex-direction:column;gap:3px}
footer{color:var(--muted);font-size:9.5px}
</style></head><body><div class="wrap">
<header><h1>تقرير مطعم السلام</h1><p class="lede">${title} — من نظام المطعم</p></header>
<section><h2>الخلاصة</h2><div class="tiles">${tiles}</div><ul class="points">${pts.map(p => `<li>${p}</li>`).join('')}</ul></section>
<section><h2>الفلوس</h2>
  <div class="money"><div><b>${N2(sheet.sales)}</b><span>مبيعات الطابعة</span></div><div><b>${N2(sheet.namedTotal)}</b><span>باسم (${sheet.named.length})</span></div><div><b>${N2(sheet.expected)}</b><span>المفروض يوصل</span></div><div><b>${hasSheet ? N2(sheet.paper) : '—'}</b><span>الورقة ${hasSheet ? `(كمبيوتر ${N2(sheet.card)} + كاش ${N2(sheet.cash)} + خرج ${N2(sheet.spent)})` : ''}</span></div></div>
  <p>النتيجة: ${cashLine}</p>
  <h3>اللي أخذوا باسم</h3>${named}</section>
<section><h2>المبيعات</h2><div class="fig">${chartHours(d.hours)}</div><p class="sub">المبيعات بالساعة (ريال). الأعلى بالذهبي.</p>
  <div class="tbl"><table><thead><tr><th>الطبق</th><th>الكمية</th><th>الدخل</th><th>تكلفته</th></tr></thead><tbody>${prods}</tbody></table></div></section>
<section><h2>المشتريات والمصاريف</h2><div class="cols">
  <div><h3>المشتريات (${N0(purchTot)})</h3><div class="tbl"><table><thead><tr><th>المورد</th><th>الأصناف</th><th>المبلغ</th></tr></thead><tbody>${purch}</tbody></table></div></div>
  <div><h3>المصاريف (${N0(expTot)})</h3><div class="tbl"><table><thead><tr><th>النوع</th><th>التفاصيل</th><th>المبلغ</th></tr></thead><tbody>${exps}</tbody></table></div></div></div></section>
<section><h2>الجرد — كل صنف</h2>
  <p class="sub">المفروض انصرف = حسب البيع والوصفات. انصرف فعلاً = أول + دخل − آخر. الأحمر نقص، والأخضر زيادة.</p>
  ${byPerson ? `<h3>النقص حسب العهدة</h3><div class="tbl"><table><thead><tr><th>العهدة</th><th>أصناف</th><th>النقص (ريال)</th></tr></thead><tbody>${byPerson}</tbody></table></div>` : ''}
  ${inv || '<p class="sub">ما فيه جرد اليوم.</p>'}
  ${waste ? `<h3>المنرمي</h3><div class="tbl"><table><thead><tr><th>الصنف</th><th>الكمية</th><th>القيمة</th></tr></thead><tbody>${waste}</tbody></table></div>` : ''}
  <h3>🍯 قارورة العسل</h3>${honey}</section>
<section><h2>يبغى متابعة</h2><ol class="recs">${recs.map(r => `<li>${r}</li>`).join('')}</ol></section>
<footer>تقرير آلي من نظام مطعم السلام — ${date}. الأرقام بالريال.</footer>
</div></body></html>`;
}

// المتصفح اللي على السيرفر (Chromium) يطبع الصفحة PDF
function chromePath() {
  const list = [process.env.CHROME_PATH, 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'].filter(Boolean);
  for (const c of list) {
    if (c.includes('/')) { if (fs.existsSync(c)) return c; continue; }
    try { return execFileSync('which', [c], { encoding: 'utf8' }).trim() || null; } catch { /* */ }
  }
  return null;
}
function pdf(date) {
  const bin = chromePath();
  if (!bin) return Promise.reject(new Error('ما فيه متصفح على السيرفر — شغّل التحديث'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayrep-')), inp = path.join(dir, 'r.html'), out = path.join(dir, 'r.pdf');
  fs.writeFileSync(inp, html(data(date)));
  return new Promise((resolve, reject) => {
    execFile(bin, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-pdf-header-footer', `--user-data-dir=${path.join(dir, 'u')}`, '--virtual-time-budget=6000', `--print-to-pdf=${out}`, 'file://' + inp],
      { timeout: 90e3, env: { ...process.env, HOME: dir } }, err => {
        try {
          if (!fs.existsSync(out)) return reject(err || new Error('ما طلع PDF'));
          resolve(fs.readFileSync(out));
        } finally { fs.rm(dir, { recursive: true, force: true }, () => {}); }
      });
  });
}

module.exports = { data, html, pdf, chromePath };
