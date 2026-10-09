'use strict';
// توقع بكرة من سجلّكم (بدون ذكاء اصطناعي — حساب بس، ببلاش):
// متوسط نفس اليوم من الأسابيع اللي فاتت × أثر الراتب × الموسم ← يتحول عبر الوصفات لأصناف الجرد والمستودع
const { all, getSetting } = require('./db');
const C = require('./calc');

const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const weekday = d => new Date(d + 'T00:00:00Z').getUTCDay();
// أيام الراتب: من 25 لين 2 من الشهر اللي بعده (الرواتب تنزل حوالي 27)
const isPayday = d => { const x = Number(d.slice(8, 10)); return x >= 25 || x <= 2; };
const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

function seasonOf(date) {
  const list = C.safeJSON(getSetting('seasons', '[]'), []);
  return list.find(s => s && s.from <= date && date <= (s.to || s.from)) || null;
}

// مجموع المبيعات لكل يوم (لويفرس + التذكرة)
function dayTotals(from, to) {
  return new Map(all('SELECT date, SUM(amount) AS a FROM sales WHERE date BETWEEN ? AND ? GROUP BY date HAVING a > 0', from, to).map(r => [r.date, r.a]));
}

// أثر الراتب: متوسط أيام الراتب ÷ متوسط باقي الأيام (آخر 120 يوم). يحتاج 3 أيام على الأقل من كل نوع
function paydayRatio(before) {
  const totals = dayTotals(C.addDays(before, -120), C.addDays(before, -1));
  const pay = [], other = [];
  for (const [d, a] of totals) (isPayday(d) ? pay : other).push(a);
  if (pay.length < 3 || other.length < 3) return { ratio: 1, enough: false, pay_days: pay.length, other_days: other.length };
  const r = avg(pay) / avg(other);
  return { ratio: Math.min(1.6, Math.max(0.7, r)), enough: true, pay_days: pay.length, other_days: other.length };
}

function forecast(date, { weeks = 8, margin = 0.1 } = {}) {
  const wd = weekday(date);
  const pr = paydayRatio(date);
  const season = seasonOf(date);
  const factor = (isPayday(date) ? pr.ratio : 1) * (season ? Number(season.factor) || 1 : 1);
  // نفس يوم الأسبوع في الأسابيع اللي فاتت (بس الأيام اللي فيها بيع)
  const totals = dayTotals(C.addDays(date, -7 * weeks), C.addDays(date, -1));
  const samples = [];
  for (let i = 1; i <= weeks; i++) { const d = C.addDays(date, -7 * i); if (totals.has(d)) samples.push(d); }
  // كل يوم ينقسم على أثر الراتب حقه، عشان المتوسط يصير «يوم عادي»
  const norm = d => (isPayday(d) ? pr.ratio : 1);
  const perProduct = new Map();
  for (const d of samples) {
    for (const r of all('SELECT product_id, SUM(qty) AS q FROM sales WHERE date = ? GROUP BY product_id', d))
      perProduct.set(r.product_id, (perProduct.get(r.product_id) || 0) + r.q / norm(d));
  }
  const n = samples.length || 1;
  const products = new Map(all('SELECT id, name, variant FROM products').map(p => [p.id, p]));
  const expected = [...perProduct].map(([pid, q]) => ({ product_id: pid, qty: (q / n) * factor }))
    .filter(x => x.qty > 0.05);

  // عبر الوصفات ← أصناف الجرد والمستودع
  const recipes = C.recipeMap();
  const need = new Map();
  for (const e of expected) for (const l of recipes.get(e.product_id) || []) need.set(l.item_id, (need.get(l.item_id) || 0) + l.qty * e.qty);

  const items = new Map(all('SELECT * FROM items WHERE active = 1').map(i => [i.id, i]));
  // الباقي من اليوم اللي قبل (اللي يقعد لبكرة بس)
  const prevBoard = new Map(C.dailyBoard(C.addDays(date, -1)).rows.map(r => [r.item_id, r]));
  const bal = C.warehouseBalances();
  const prep = [], buy = [];
  for (const [id, q] of need) {
    const it = items.get(id); if (!it || !it.daily) continue;
    const r = prevBoard.get(id);
    const left = it.carry_over && r ? (r.closing ?? r.remaining_expected ?? 0) : 0;
    const make = Math.max(0, q * (1 + margin) - Math.max(0, left));
    const row = { item_id: id, name: it.name, unit: it.unit, expected: C.r2(q), left: C.r2(Math.max(0, left)), make: Math.ceil(make * 10) / 10,
      opener_id: r ? r.opening_user_id || r.closing_user_id : null, opener: r ? (r.opening_user_id ? r.opening_user : r.closing_user) : '—' };
    // الطازج اللي ينشرى كل يوم (لحوح، كدر…) = «اشترِ»، وغيره = «جهّز»
    if (it.kind === 'raw' && it.no_opening) buy.push(row); else prep.push(row);
  }
  // المستودع: كم يوم يكفي (من استهلاك آخر 14 يوم الفعلي)
  const lowStock = stockDays(date, bal, items);
  const sortQ = (a, b) => b.make - a.make;
  return {
    date, weekday: WEEKDAYS[wd], payday: isPayday(date), payday_ratio: C.r2(pr.ratio), payday_known: pr.enough,
    season: season ? season.name : '', factor: C.r2(factor), samples: samples.length, history_days: totals.size,
    expected_sales: C.r2(avg(samples.map(d => totals.get(d) / norm(d))) * factor),
    products: expected.sort((a, b) => b.qty - a.qty).slice(0, 40).map(e => {
      const p = products.get(e.product_id) || {};
      return { product_id: e.product_id, name: (p.name || '?') + (p.variant ? ' ' + p.variant : ''), qty: C.r2(e.qty) };
    }),
    prep: prep.sort(sortQ), buy: buy.sort(sortQ), low_stock: lowStock,
  };
}

// كم يوم يكفي المستودع: الصرف اليومي من الحركات (سحب، تحضير، وصفات) آخر 14 يوم
function stockDays(date, bal = C.warehouseBalances(), items = null) {
  items = items || new Map(all('SELECT * FROM items WHERE active = 1').map(i => [i.id, i]));
  const from = C.addDays(date, -14);
  const out = [];
  for (const r of all(`SELECT item_id, -SUM(qty) AS used, COUNT(DISTINCT date) AS days FROM moves
      WHERE location = 'warehouse' AND type IN ('transfer','prep_use','sale_use','opening_pull') AND qty < 0 AND date >= ? AND date < ? GROUP BY item_id`, from, date)) {
    const it = items.get(r.item_id); if (!it || r.used <= 0) continue;
    const perDay = r.used / 14;
    const have = bal.get(r.item_id) || 0;
    const days = perDay > 0 ? have / perDay : null;
    if (days != null && days < 3) out.push({ item_id: r.item_id, name: it.name, unit: it.unit, balance: C.r2(have), per_day: C.r2(perDay), days_left: C.r2(Math.max(0, days)) });
  }
  return out.sort((a, b) => a.days_left - b.days_left);
}

module.exports = { forecast, stockDays, isPayday, paydayRatio, seasonOf, WEEKDAYS };
