'use strict';
// 📄 تقرير فترة (أسبوع، شهر، ربع، سنة): نفس شكل تقرير اليوم — المبيعات، المشتريات، المصاريف، الرواتب، الجرد، الفلوس
// وينرسل لحاله في جروب «حساب اليوم»: السبت (الأسبوع اللي فات)، يوم ١ (الشهر)، ١ يناير/أبريل/يوليو/أكتوبر (الربع)، ١ يناير (السنة)
const { get, all, run, getSetting } = require('./db');
const C = require('./calc');
const MR = require('./monthly');
const DR = require('./day_report');
const { E, N0, N2, Q, AR_MONTH, WD, CSS } = DR;

const KINDS = { week: 'الأسبوع', month: 'الشهر', quarter: 'الربع', year: 'السنة' };
const span = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 864e5) + 1;
const dLabel = d => { const x = new Date(d + 'T00:00:00Z'); return `${x.getUTCDate()} ${AR_MONTH[x.getUTCMonth()]}`; };
const pct = (a, b) => b ? Math.round(100 * (a - b) / Math.abs(b)) : null;

function data(from, to) {
  const mr = MR.monthlyReport(null, { from, to });
  const n = span(from, to), pf = C.addDays(from, -n), pt = C.addDays(from, -1);
  const prev = MR.monthlyReport(null, { from: pf, to: pt }).summary;
  // الجرد: نجمع كل يوم
  const items = new Map(), people = new Map(), waste = new Map(); let fullDays = 0, countDays = 0;
  const last = to < C.businessDate() ? to : C.businessDate();
  for (let day = from; day <= last; day = C.addDays(day, 1)) { // كل يوم في الفترة (حتى اللي ما فيه بيع)
    if (!get('SELECT 1 AS x FROM counts WHERE date = ? LIMIT 1', day)) continue;
    const rows = C.dailyBoard(day).rows || [];
    const act = rows.filter(r => r.opening != null || r.closing != null || r.received || r.added);
    if (!act.length) continue;
    countDays++;
    if (act.every(r => r.empty || r.closing != null)) fullDays++;
    for (const r of rows) {
      if (r.diff != null && (r.diff_value || 0) > 0.5) {
        const x = items.get(r.name) || { name: r.name, unit: r.unit, days: 0, qty: 0, val: 0, who: new Set() };
        x.days++; x.qty += r.diff; x.val += r.diff_value; x.who.add(r.closing_user || r.closing_by || '—'); items.set(r.name, x);
        const p = r.closing_user || r.closing_by || '—'; people.set(p, (people.get(p) || 0) + r.diff_value);
      }
      if (r.wasted > 0) { const w = waste.get(r.name) || { name: r.name, unit: r.unit, qty: 0, val: 0 }; w.qty += r.wasted; w.val += r.waste_value || 0; waste.set(r.name, w); }
    }
  }
  // الفلوس: كل يوم فيه ورقة
  const DS = require('./daily_sheet');
  const cash = all('SELECT date, cash, card, spent, total FROM cash_counts WHERE date BETWEEN ? AND ? ORDER BY date', from, to)
    .map(c => { const s = DS.summary(c.date, { card: c.card, cash: c.cash, spent: c.spent, total_written: c.total }); return { date: c.date, expected: s.expected, paper: s.paper, diff: s.diff }; });
  return { from, to, n, mr, prev, items: [...items.values()].sort((a, b) => b.val - a.val), people: [...people].sort((a, b) => b[1] - a[1]),
    waste: [...waste.values()].sort((a, b) => b.val - a.val), fullDays, countDays, cash };
}

function bars(points, W = 720, H = 180) {
  const mx = Math.max(1, ...points.map(p => p.v)), bw = (W - 20) / Math.max(1, points.length); let s = '';
  const every = points.length > 16 ? Math.ceil(points.length / 12) : 1;
  points.forEach((p, i) => {
    const bh = (p.v / mx) * (H - 46), x = 10 + i * bw, top = p.v === mx && p.v > 0;
    s += `<rect class="bar${top ? ' fri' : ''}" x="${(x + 1.5).toFixed(1)}" y="${(H - 26 - bh).toFixed(1)}" width="${Math.max(1, bw - 3).toFixed(1)}" height="${bh.toFixed(1)}"/>`;
    if (points.length <= 16 && p.v > 0) s += `<text class="ax" x="${(x + bw / 2).toFixed(1)}" y="${(H - 30 - bh).toFixed(1)}" text-anchor="middle">${N0(p.v)}</text>`;
    if (i % every === 0) s += `<text class="ax" x="${(x + bw / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle">${E(p.l)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" direction="ltr"><line class="gl" x1="10" x2="${W - 10}" y1="${H - 26}" y2="${H - 26}"/>${s}</svg>`;
}

function html(d, kind = '') {
  const { mr, prev } = d, S = mr.summary;
  const label = KINDS[kind] ? `تقرير ${KINDS[kind]}` : 'تقرير الفترة';
  const sub = `${dLabel(d.from)} ← ${dLabel(d.to)} ${d.to.slice(0, 4)} (${d.n} يوم)`;
  const days = mr.days, avg = days.length ? S.sales / days.length : 0;
  const food = S.sales ? Math.round(100 * S.cogs / S.sales) : 0;
  const chg = (a, b) => { const p = pct(a, b); return p == null ? '' : `<em class="${p >= 0 ? 'up' : 'down'}">${p >= 0 ? '↑' : '↓'} ${Math.abs(p)}%</em>`; };
  const tiles = [
    [N0(S.sales), 'المبيعات', chg(S.sales, prev.sales)], [N0(avg), 'متوسط اليوم', ''], [`${food}%`, 'تكلفة الأكل', ''],
    [N0(S.purchases), 'المشتريات', chg(S.purchases, prev.purchases)], [N0(S.expenses), 'المصاريف', chg(S.expenses, prev.expenses)], [N0(S.salaries), 'الرواتب', ''],
    [N0(S.inventory_shortage), 'نقص الجرد', chg(S.inventory_shortage, prev.inventory_shortage), S.inventory_shortage > 500 ? 'bad' : ''], [N0(S.suppliers_owed), 'علينا للموردين', ''], [N0(S.net_estimate), 'ربح تقديري', chg(S.net_estimate, prev.net_estimate), 'honey'],
  ].map(([b, s, c, cls]) => `<div class="tile ${cls || ''}"><b>${b} ${c}</b><span>${s}</span></div>`).join('');
  // الرسم: يوم يوم (لين ٣١ يوم)، أسبوع أسبوع (لين ١٠٠)، وغيره شهر شهر
  let pts;
  if (d.n <= 31) pts = days.map(x => ({ l: x.date.slice(8), v: x.sales }));
  else if (d.n <= 100) { const m = new Map(); for (const x of days) { const k = Math.floor(span(d.from, x.date) - 1) / 7 | 0; m.set(k, (m.get(k) || 0) + x.sales); } pts = [...m].map(([k, v]) => ({ l: `أ${k + 1}`, v })); }
  else { const m = new Map(); for (const x of days) { const k = x.date.slice(0, 7); m.set(k, (m.get(k) || 0) + x.sales); } pts = [...m].map(([k, v]) => ({ l: AR_MONTH[Number(k.slice(5)) - 1].slice(0, 3), v })); }
  const wk = new Map(); for (const x of days) { const w = new Date(x.date + 'T00:00:00Z').getUTCDay(); const o = wk.get(w) || { n: 0, v: 0 }; o.n++; o.v += x.sales; wk.set(w, o); }
  const wkRows = [...wk].sort((a, b) => b[1].v / b[1].n - a[1].v / a[1].n).map(([w, o]) => `<tr><td>${WD[w]}</td><td class="n">${o.n}</td><td class="n">${N0(o.v / o.n)}</td></tr>`).join('');
  const best = days.slice().sort((a, b) => b.sales - a.sales)[0], worst = days.slice().sort((a, b) => a.sales - b.sales)[0];
  const prods = mr.products.slice(0, 15).map(p => `<tr><td>${E(p.name)}</td><td class="n">${Q(p.qty)}</td><td class="n">${N0(p.amount)}</td><td class="n">${p.amount ? Math.round(100 * p.cost / p.amount) : 0}%</td></tr>`).join('') || '<tr><td colspan="4" class="sub">ما فيه</td></tr>';
  const sup = new Map(), pit = new Map();
  for (const p of mr.purchases) {
    const k = p.supplier || 'بدون اسم مورد', o = sup.get(k) || { n: 0, v: 0 }; o.n++; o.v += p.total; sup.set(k, o);
    for (const l of p.items || []) { const x = pit.get(l.name) || { unit: l.unit, qty: 0, v: 0 }; x.qty += l.qty || 0; x.v += (l.qty || 0) * (l.unit_price || 0); pit.set(l.name, x); }
  }
  const supRows = [...sup].sort((a, b) => b[1].v - a[1].v).slice(0, 12).map(([k, o]) => `<tr><td>${E(k)}</td><td class="n">${o.n}</td><td class="n">${N0(o.v)}</td></tr>`).join('') || '<tr><td colspan="3" class="sub">ما فيه</td></tr>';
  const pitRows = [...pit].filter(([, x]) => x.v > 0).sort((a, b) => b[1].v - a[1].v).slice(0, 12).map(([k, x]) => `<tr><td>${E(k)}</td><td class="n">${Q(x.qty)} ${E(x.unit || '')}</td><td class="n">${N0(x.v)}</td></tr>`).join('') || '<tr><td colspan="3" class="sub">ما فيه</td></tr>';
  const cat = new Map(); for (const e of mr.expenses) cat.set(e.category || '—', (cat.get(e.category || '—') || 0) + e.amount);
  const expRows = [...cat].sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${E(k)}</td><td class="n">${N2(v)}</td></tr>`).join('') || '<tr><td colspan="2" class="sub">ما فيه</td></tr>';
  const pay = t => mr.payroll.filter(p => p.type === t).reduce((s, p) => s + p.amount, 0);
  const deducts = mr.payroll.filter(p => p.type === 'deduct');
  const itemRows = d.items.slice(0, 25).map(x => `<tr class="${x.days >= 3 ? 'neg' : ''}"><td>${E(x.name)}</td><td class="n">${x.days}</td><td class="n">${Q(x.qty)} ${E(x.unit)}</td><td class="n">${N0(x.val)}</td><td class="sub2">${E([...x.who].join('، '))}</td></tr>`).join('') || '<tr><td colspan="5" class="sub">ما فيه نقص 👌</td></tr>';
  const pplRows = d.people.map(([k, v]) => `<tr><td>${E(k)}</td><td class="n">${N0(v)}</td></tr>`).join('');
  const wasteRows = d.waste.slice(0, 12).map(x => `<tr><td>${E(x.name)}</td><td class="n">${Q(x.qty)} ${E(x.unit)}</td><td class="n">${N0(x.val)}</td></tr>`).join('');
  const cashShort = d.cash.filter(c => c.diff > 0.5), cashOver = d.cash.filter(c => c.diff < -0.5);
  const cashRows = d.cash.map(c => `<tr class="${c.diff > 0.5 ? 'neg' : ''}"><td>${dLabel(c.date)}</td><td class="n">${N2(c.expected)}</td><td class="n">${N2(c.paper)}</td><td class="n">${Math.abs(c.diff) <= 0.5 ? '✓' : c.diff > 0 ? 'نقص ' + N2(c.diff) : 'زيادة ' + N2(-c.diff)}</td></tr>`).join('');
  // الخلاصة والمتابعة
  const pts2 = [`<b>المبيعات ${N0(S.sales)} ريال</b> في ${days.length} يوم${prev.sales ? ` — ${pct(S.sales, prev.sales) >= 0 ? 'أكثر' : 'أقل'} من الفترة اللي قبلها بـ${Math.abs(pct(S.sales, prev.sales))}%` : ''}.`];
  if (best) pts2.push(`<b>أحسن يوم:</b> ${WD[new Date(best.date + 'T00:00:00Z').getUTCDay()]} ${dLabel(best.date)} (${N0(best.sales)})، و<b>أضعف يوم:</b> ${WD[new Date(worst.date + 'T00:00:00Z').getUTCDay()]} ${dLabel(worst.date)} (${N0(worst.sales)}).`);
  pts2.push(`<b>الربح التقديري ${N0(S.net_estimate)}</b> = المبيعات − تكلفة الأكل (${N0(S.cogs)}) − المصاريف (${N0(S.expenses)}) − الرواتب (${N0(S.salaries)}).`);
  pts2.push(`<b>نقص الجرد ${N0(S.inventory_shortage)}</b> والهدر ${N0(S.waste)}${d.items[0] ? ` — أكبره ${E(d.items[0].name)} (${N0(d.items[0].val)})` : ''}.`);
  if (d.cash.length) pts2.push(`<b>الفلوس:</b> ${d.cash.length} يوم فيه ورقة — ${cashShort.length ? `${cashShort.length} يوم نقص (${N2(cashShort.reduce((s, c) => s + c.diff, 0))})` : 'ما فيه نقص'}${cashOver.length ? `، و${cashOver.length} يوم زيادة` : ''}.`);
  const recs = [];
  for (const x of d.items.filter(x => x.days >= 3).slice(0, 5)) recs.push(`${E(x.name)} ناقص ${x.days} أيام (${N0(x.val)} ريال) — عهدة ${E([...x.who].join('، '))}.`);
  if (d.countDays && d.fullDays < d.countDays) recs.push(`الجرد انجرد كامل ${d.fullDays} يوم من ${d.countDays}.`);
  const noSup = mr.purchases.filter(p => !p.supplier).length; if (noSup) recs.push(`${noSup} فاتورة بدون اسم مورد.`);
  const unappr = mr.purchases.filter(p => !p.approved_at).length; if (unappr) recs.push(`${unappr} فاتورة ما انعتمدت.`);
  if (cashShort.length) recs.push(`نقص الدرج في: ${cashShort.map(c => `${dLabel(c.date)} (${N2(c.diff)})`).join('، ')}.`);
  if (!recs.length) recs.push('كل شي مضبوط 👌');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${E(label)} ${d.from}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600&family=Readex+Pro:wght@500;700&display=swap">
<style>${CSS}
.tile em{font-style:normal;font-size:10px;font-family:var(--body)} .tile em.up{color:var(--ok)} .tile em.down{color:var(--crit)}
</style></head><body><div class="wrap">
<header><h1>${E(label)} — مطعم السلام</h1><p class="lede">${sub}. الأسهم مقارنة بالفترة اللي قبلها.</p></header>
<section><h2>الخلاصة</h2><div class="tiles">${tiles}</div><ul class="points">${pts2.map(p => `<li>${p}</li>`).join('')}</ul></section>
<section><h2>المبيعات</h2><div class="fig">${bars(pts)}</div>
  <div class="cols"><div><h3>متوسط كل يوم بالأسبوع</h3><div class="tbl"><table><thead><tr><th>اليوم</th><th>أيام</th><th>المتوسط</th></tr></thead><tbody>${wkRows}</tbody></table></div></div>
  <div><h3>أكثر الأطباق دخلاً</h3><div class="tbl"><table><thead><tr><th>الطبق</th><th>الكمية</th><th>الدخل</th><th>تكلفته</th></tr></thead><tbody>${prods}</tbody></table></div></div></div></section>
<section><h2>المشتريات</h2><div class="cols">
  <div><h3>حسب المورد (${N0(S.purchases)})</h3><div class="tbl"><table><thead><tr><th>المورد</th><th>فواتير</th><th>المبلغ</th></tr></thead><tbody>${supRows}</tbody></table></div></div>
  <div><h3>أكبر الأصناف شراء</h3><div class="tbl"><table><thead><tr><th>الصنف</th><th>الكمية</th><th>المبلغ</th></tr></thead><tbody>${pitRows}</tbody></table></div></div></div></section>
<section><h2>المصاريف والرواتب</h2><div class="cols">
  <div><div class="tbl"><table><thead><tr><th>النوع</th><th>المبلغ</th></tr></thead><tbody>${expRows}</tbody></table></div></div>
  <div><div class="money" style="grid-template-columns:1fr 1fr"><div><b>${N0(pay('salary'))}</b><span>رواتب</span></div><div><b>${N0(pay('advance'))}</b><span>سلف</span></div><div><b>${N0(pay('bonus'))}</b><span>مكافآت</span></div><div><b>${N0(pay('deduct'))}</b><span>خصومات (${deducts.length})</span></div></div></div></div></section>
<section><h2>الجرد</h2><p class="sub">انجرد كامل ${d.fullDays} يوم من ${d.countDays}. الأحمر: ناقص ٣ أيام أو أكثر.</p>
  <div class="tbl"><table><thead><tr><th>الصنف</th><th>أيام النقص</th><th>الكمية</th><th>القيمة</th><th>عهدة</th></tr></thead><tbody>${itemRows}</tbody></table></div>
  ${pplRows ? `<div class="cols"><div><h3>النقص حسب العهدة</h3><div class="tbl"><table><thead><tr><th>العهدة</th><th>القيمة</th></tr></thead><tbody>${pplRows}</tbody></table></div></div>
  <div><h3>المنرمي</h3><div class="tbl"><table><thead><tr><th>الصنف</th><th>الكمية</th><th>القيمة</th></tr></thead><tbody>${wasteRows || '<tr><td colspan="3" class="sub">ما فيه</td></tr>'}</tbody></table></div></div></div>` : ''}</section>
${cashRows ? `<section><h2>الفلوس كل يوم</h2><div class="tbl"><table><thead><tr><th>اليوم</th><th>المفروض</th><th>الورقة</th><th>النتيجة</th></tr></thead><tbody>${cashRows}</tbody></table></div></section>` : ''}
<section><h2>يبغى متابعة</h2><ol class="recs">${recs.map(r => `<li>${r}</li>`).join('')}</ol></section>
<footer>تقرير آلي من نظام مطعم السلام — ${d.from} ← ${d.to}. الأرقام بالريال.</footer>
</div></body></html>`;
}

const pdf = (from, to, kind) => DR.pdfOf(html(data(from, to), kind));

// وش اللي ينرسل اليوم (اليوم = يوم المطعم)
function due(today) {
  const t = new Date(today + 'T00:00:00Z'), out = [];
  if (t.getUTCDay() === 6) out.push({ kind: 'week', from: C.addDays(today, -7), to: C.addDays(today, -1) });
  if (today.slice(8) === '01') {
    const end = C.addDays(today, -1);
    out.push({ kind: 'month', from: end.slice(0, 8) + '01', to: end });
    const m = t.getUTCMonth();
    if (m % 3 === 0) { const f = new Date(Date.UTC(t.getUTCFullYear(), m - 3, 1)).toISOString().slice(0, 10); out.push({ kind: 'quarter', from: f, to: end }); }
    if (m === 0) out.push({ kind: 'year', from: `${t.getUTCFullYear() - 1}-01-01`, to: end });
  }
  return out;
}

// الساعة ١٢ الظهر: كل تقرير مستحق ينرسل مرة وحدة لجروبات «حساب اليوم»
async function autoSend(sendDoc, { now = new Date(), force = false } = {}) {
  const today = C.businessDate(now);
  if (!force && C.riyadhHour(now) < 12) return [];
  let groups = {}; try { groups = JSON.parse(getSetting('wa_groups') || '{}'); } catch { /* */ }
  const jids = Object.keys(groups).filter(j => groups[j] === 'daily');
  if (!jids.length) return [];
  const sent = [];
  for (const p of due(today)) {
    const key = 'period:' + p.kind;
    if (get('SELECT 1 AS x FROM wa_nudges WHERE date = ? AND key = ?', today, key)) continue;
    run('INSERT INTO wa_nudges(date, key) VALUES(?,?)', today, key);
    const buf = await pdf(p.from, p.to, p.kind);
    for (const j of jids) await sendDoc(j, buf, `تقرير ${KINDS[p.kind]} ${p.from} - ${p.to}.pdf`, `📄 تقرير ${KINDS[p.kind]} (${p.from} ← ${p.to})`);
    sent.push(p.kind);
  }
  return sent;
}

module.exports = { data, html, pdf, due, autoSend, KINDS };
