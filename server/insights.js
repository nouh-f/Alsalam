'use strict';
// تحليلات بدون ذكاء اصطناعي (حساب بس): أسعار الشراء، ربح الأطباق، اقتراح تعديل الوصفات، النقص الشهري لكل موظف
const { all, getSetting } = require('./db');
const C = require('./calc');

const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

// ===== أسعار الشراء: «الدقيق غلي 12%» و«المورد فلان أرخص» =====
// السعر بالوحدة الأساسية للصنف، آخر 30 يوم مقابل الـ60 يوم اللي قبلها
function purchasePrices(today) {
  const from = C.addDays(today, -90), mid = C.addDays(today, -30);
  const rows = all(`SELECT l.item_id, i.name, i.unit, p.date, p.supplier, l.qty, l.unit_price FROM purchase_lines l
    JOIN purchases p ON p.id = l.purchase_id JOIN items i ON i.id = l.item_id WHERE p.date >= ? AND l.unit_price > 0 ORDER BY p.date, p.id`, from);
  const by = new Map();
  for (const r of rows) { if (!by.has(r.item_id)) by.set(r.item_id, []); by.get(r.item_id).push(r); }
  const wavg = rs => { const q = rs.reduce((s, r) => s + r.qty, 0); return q ? rs.reduce((s, r) => s + r.qty * r.unit_price, 0) / q : 0; };
  const out = [];
  for (const [id, rs] of by) {
    const now = rs.filter(r => r.date >= mid), before = rs.filter(r => r.date < mid);
    const a = wavg(now), b = wavg(before);
    const sup = new Map();
    for (const r of rs) if (r.supplier) { if (!sup.has(r.supplier)) sup.set(r.supplier, []); sup.get(r.supplier).push(r); }
    const suppliers = [...sup].map(([name, x]) => ({ name, price: C.r3(wavg(x)), times: x.length })).sort((x, y) => x.price - y.price);
    const last = rs[rs.length - 1];
    out.push({
      item_id: id, name: last.name, unit: last.unit, last_price: C.r3(last.unit_price), last_date: last.date, last_supplier: last.supplier,
      avg_30: a ? C.r3(a) : null, avg_before: b ? C.r3(b) : null, change_pct: a && b ? Math.round((a / b - 1) * 1000) / 10 : null,
      cheapest: suppliers.length > 1 ? suppliers[0] : null, suppliers,
    });
  }
  return out.sort((x, y) => Math.abs(y.change_pct || 0) - Math.abs(x.change_pct || 0));
}

// ===== ربح كل طبق: التكلفة من الوصفة وسعر الشراء، والبيع من لويفرس =====
function menuProfit(today) {
  const costs = C.itemCostMap(), recipes = C.recipeMap();
  const maxFc = Number(getSetting('max_food_cost', '35')) || 35;
  const sold = new Map(all('SELECT product_id, SUM(qty) AS q, SUM(amount) AS a FROM sales WHERE date >= ? GROUP BY product_id', C.addDays(today, -30)).map(r => [r.product_id, r]));
  const out = [];
  for (const p of all("SELECT * FROM products WHERE active = 1 AND recipe_status != 'skip'")) {
    const lines = recipes.get(p.id); if (!lines || !lines.length) continue;
    const cost = C.productCost(p.id, recipes, costs);
    const s = sold.get(p.id) || { q: 0, a: 0 };
    const price = p.price || (s.q ? s.a / s.q : 0);
    const fc = price ? (cost / price) * 100 : null;
    out.push({ product_id: p.id, name: p.name + (p.variant ? ' ' + p.variant : ''), category: p.category || '', price: C.r2(price), cost: C.r2(cost), profit: C.r2(price - cost),
      food_cost_pct: fc == null ? null : Math.round(fc * 10) / 10, high: fc != null && fc > maxFc, missing_cost: lines.some(l => !costs.get(l.item_id)),
      sold_30: C.r3(s.q), profit_30: C.r2(s.a - cost * s.q), draft: p.recipe_status === 'draft' });
  }
  return { max_food_cost: maxFc, rows: out.sort((a, b) => (b.food_cost_pct ?? -1) - (a.food_cost_pct ?? -1)) };
}

// ===== اقتراح تعديل الوصفة: نفس الصنف ينقص أغلب الأيام بنسبة ثابتة =====
// يمكن الوصفة ناقصة (0.25 والصح 0.3) — مو بالضرورة سرقة. نقترح بس، وصاحب المطعم يقرر
function recipeSuggestions(today, days = 7) {
  const per = new Map();
  for (let i = 1; i <= days; i++) {
    for (const r of C.dailyBoard(C.addDays(today, -i)).rows) {
      if (r.diff == null || !r.theoretical) continue;
      const x = per.get(r.item_id) || { item_id: r.item_id, name: r.name, unit: r.unit, closer: r.closing_user, counted: 0, short: 0, diffs: [], theo: [] };
      x.counted++; if (r.diff > 0.0001) x.short++;
      x.diffs.push(r.diff); x.theo.push(r.theoretical);
      per.set(r.item_id, x);
    }
  }
  const out = [];
  for (const x of per.values()) {
    if (x.counted < 4 || x.short < Math.ceil(x.counted * 0.7)) continue;
    const ratio = avg(x.diffs) / avg(x.theo);
    // ثابت = كل يوم قريب من المتوسط (مو يوم واحد كبير)
    const ratios = x.diffs.map((d, i) => d / x.theo[i]);
    const steady = ratios.filter(r => Math.abs(r - ratio) <= Math.max(0.1, ratio * 0.5)).length >= Math.ceil(x.counted * 0.7);
    if (ratio < 0.05 || ratio > 0.6 || !steady) continue;
    const factor = Math.round((1 + ratio) * 100) / 100;
    const lines = all('SELECT r.id, r.qty, p.name, p.variant FROM recipe_lines r JOIN products p ON p.id = r.product_id WHERE r.item_id = ? AND p.active = 1', x.item_id)
      .map(l => ({ id: l.id, product: l.name + (l.variant ? ' ' + l.variant : ''), qty: l.qty, suggested: C.r3(l.qty * factor) }));
    if (!lines.length) continue;
    out.push({ item_id: x.item_id, name: x.name, unit: x.unit, closer: x.closer, days: x.counted, short_days: x.short, avg_short: C.r3(avg(x.diffs)), pct: Math.round(ratio * 100), factor, lines });
  }
  return out.sort((a, b) => b.pct - a.pct);
}

// ===== النقص الشهري لكل موظف (للخصومات والمكافآت) =====
function monthShortage(month, today) {
  const from = month + '-01';
  const end = C.addDays(C.addDays(from, 32).slice(0, 7) + '-01', -1);
  const to = end < today ? end : today;
  const people = new Map();
  for (let d = from; d <= to; d = C.addDays(d, 1)) {
    for (const r of C.dailyBoard(d).rows) {
      if (r.diff == null) continue;
      const k = r.closing_user_id || 0;
      const p = people.get(k) || { user_id: r.closing_user_id, name: r.closing_user, counted: 0, short_times: 0, short_value: 0, over_value: 0, days: new Set(), items: new Map() };
      p.counted++; p.days.add(d); people.set(k, p);
      if (r.diff > 0.0001) {
        p.short_times++; p.short_value += r.diff_value || 0;
        const it = p.items.get(r.name) || { item: r.name, unit: r.unit, times: 0, qty: 0, value: 0 };
        it.times++; it.qty += r.diff; it.value += r.diff_value || 0; p.items.set(r.name, it);
      } else if (r.diff < -0.0001) p.over_value += -(r.diff_value || 0);
    }
  }
  return { month, from, to, rows: [...people.values()].map(p => ({
    user_id: p.user_id, name: p.name, days: p.days.size, counted: p.counted, short_times: p.short_times, short_value: C.r2(p.short_value), over_value: C.r2(p.over_value),
    items: [...p.items.values()].map(i => ({ ...i, qty: C.r3(i.qty), value: C.r2(i.value) })).sort((a, b) => b.value - a.value),
  })).sort((a, b) => b.short_value - a.short_value) };
}

module.exports = { purchasePrices, menuProfit, recipeSuggestions, monthShortage };
