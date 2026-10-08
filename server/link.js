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
