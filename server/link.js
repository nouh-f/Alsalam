'use strict';
// ربط أصناف لويفرس بأصناف الجرد/المخزون (بالاسم): كل صنف بيع لازم يعرف وش ينخصم منه
const { all } = require('./db');
const { normalize, similarity } = require('./match');

// أقرب صنف مخزون لاسم لويفرس (الاسم بدون النوع أولاً، ثم مع النوع)
function suggestItem(name, variants, items) {
  let best = null;
  for (const i of items) {
    let s = similarity(name, i.name);
    for (const v of variants) if (v) s = Math.max(s, similarity(`${name} ${v}`, i.name));
    // اسم صنف المخزون كله موجود في اسم لويفرس («هامور» ← «هامور مقلي»)
    const iw = normalize(i.name).split(' '), nw = new Set(normalize(name).split(' '));
    if (iw.length && iw.every(w => nw.has(w))) s = Math.max(s, 0.75);
    if (!best || s > best.score) best = { item_id: i.id, name: i.name, score: Math.round(s * 100) / 100 };
  }
  return best && best.score >= 0.5 ? best : null;
}

// أصناف لويفرس اللي ما لها وصفة (ولا انعلّمت «ما ينجرد»)، مجمّعة حسب الصنف، والأكثر بيعًا أول
function unlinked({ includeSkipped = false } = {}) {
  const items = all('SELECT id, name, unit, daily FROM items WHERE active = 1');
  const sold = new Map(all("SELECT product_id, SUM(qty) AS q FROM sales WHERE date >= date('now', '-30 days') GROUP BY product_id").map(r => [r.product_id, r.q]));
  const rows = all(`SELECT * FROM products WHERE active = 1 AND id NOT IN (SELECT product_id FROM recipe_lines)
    ${includeSkipped ? '' : "AND recipe_status != 'skip'"} ORDER BY name, variant`);
  const groups = new Map();
  for (const p of rows) {
    const key = p.loyverse_item_id || p.name;
    const g = groups.get(key) || { key, name: p.name, category: p.category || '', sold: 0, variants: [] };
    g.variants.push({ id: p.id, variant: p.variant || '', price: p.price, sold: Math.round((sold.get(p.id) || 0) * 1000) / 1000, skipped: p.recipe_status === 'skip' });
    g.sold += sold.get(p.id) || 0;
    groups.set(key, g);
  }
  return [...groups.values()].map(g => {
    const s = suggestItem(g.name, g.variants.map(v => v.variant), items);
    // يتباع بالوزن (كسور) ← كيلو
    const byWeight = g.variants.some(v => v.sold % 1);
    return { ...g, sold: Math.round(g.sold * 1000) / 1000, suggestion: s && { ...s, daily: items.find(i => i.id === s.item_id).daily }, unit: byWeight ? 'كيلو' : 'حبة' };
  }).sort((a, b) => b.sold - a.sold || a.name.localeCompare(b.name, 'ar'));
}

module.exports = { suggestItem, unlinked };

// ===== توحيد الأسماء مع لويفرس =====
// صنف مخزون اسمه قريب من صنف لويفرس بس مكتوب غير (حنيد/حنيذ، فته/فتة، شطه/شطة…)
// => نقترح نسمّيه بنفس كتابة لويفرس بالضبط. (نفس عدد الكلمات بس — عشان «دجاج» ما يصير «دجاج مندي»)
function nameFixes() {
  const items = all('SELECT id, name FROM items WHERE active = 1');
  const taken = new Set(items.map(i => i.name.trim()));
  const labels = new Map();
  for (const p of all('SELECT name, variant FROM products WHERE active = 1')) {
    for (const l of [p.name, p.variant ? `${p.name} ${p.variant}` : null]) if (l && l.trim()) labels.set(l.trim().replace(/\s+/g, ' '), 1);
  }
  const words = s => normalize(s).split(' ').filter(Boolean).length;
  const out = [];
  for (const i of items) {
    const name = i.name.trim();
    if (labels.has(name)) continue; // مطابق بالضبط
    let best = null;
    for (const l of labels.keys()) {
      if (words(l) !== words(name)) continue;
      const s = normalize(l) === normalize(name) ? 1 : similarity(name, l);
      if (s >= 0.7 && (!best || s > best.score)) best = { loyverse: l, score: Math.round(s * 100) / 100 };
    }
    if (best && !taken.has(best.loyverse)) out.push({ item_id: i.id, name: i.name, ...best });
  }
  // صنفين على نفس الاسم: الأقرب بس
  const keep = new Map();
  for (const f of out) if (!keep.has(f.loyverse) || keep.get(f.loyverse).score < f.score) keep.set(f.loyverse, f);
  return [...keep.values()].sort((a, b) => b.score - a.score);
}

module.exports.nameFixes = nameFixes;
