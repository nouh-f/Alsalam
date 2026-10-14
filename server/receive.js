'use strict';
// 📦 استلام بالوزن (سمك الدعدع): العامل يوزن أول ما يوصل => شراء آجل «ينتظر الحساب» والكمية تدخل الجرد على طول
// ولما يوصل الحساب: نقارن كيلو بكيلو — الناقص ناخذه من المورد، والزايد نسكت عنه
const { all, get } = require('./db');
const C = require('./calc');

const TOL = 0.05; // فرق الميزان المقبول (كجم)

// آخر شراء ينتظر الحساب لهالمورد (أو بتاريخ معيّن)
function awaitingFor(supplier, date) {
  const s = String(supplier || '').trim();
  const rows = all(`SELECT p.* FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.awaiting_invoice = 1
    ${s ? "AND (s.name LIKE ? OR p.supplier LIKE ?)" : ''} ${date ? 'AND p.date = ?' : ''} ORDER BY p.date DESC, p.id DESC LIMIT 1`,
    ...(s ? ['%' + s + '%', '%' + s + '%'] : []), ...(date ? [date] : []));
  return rows[0] || null;
}

// inv: [{item_id, qty, unit_price}] — يرجع المقارنة سطر سطر + كم لنا عند المورد
function compare(pid, inv) {
  const got = new Map(all('SELECT l.item_id, SUM(l.qty) AS q, i.name, i.unit FROM purchase_lines l JOIN items i ON i.id = l.item_id WHERE l.purchase_id = ? GROUP BY l.item_id', pid).map(r => [r.item_id, r]));
  const rows = [], seen = new Set();
  let owed = 0;
  for (const l of inv) {
    const it = get('SELECT name, unit FROM items WHERE id = ?', l.item_id) || { name: '؟', unit: '' };
    const g = got.get(l.item_id); seen.add(l.item_id);
    const price = Number(l.unit_price) || 0;
    if (!g) { rows.push({ item_id: l.item_id, name: it.name, unit: it.unit, invoice: C.r3(l.qty), weighed: 0, status: 'not_received', text: `❓ ${it.name}: في الحساب ${C.r3(l.qty)} ${it.unit} وما انوزن عندنا` }); owed += l.qty * price; continue; }
    const d = C.r3(g.q - l.qty);
    const status = Math.abs(d) <= TOL ? 'match' : d < 0 ? 'short' : 'extra';
    if (status === 'short') owed += -d * price;
    rows.push({ item_id: l.item_id, name: it.name, unit: it.unit, invoice: C.r3(l.qty), weighed: C.r3(g.q), diff: d, status,
      text: status === 'match' ? `✓ ${it.name}: مطابق (${C.r3(g.q)} ${it.unit})`
        : status === 'short' ? `⚠️ ${it.name}: الحساب ${C.r3(l.qty)} — وزنّا ${C.r3(g.q)} ← ناقص ${C.r3(-d)} ${it.unit}${price ? ` (≈${C.r2(-d * price)} ريال)` : ''}`
        : `➕ ${it.name}: الحساب ${C.r3(l.qty)} — وزنّا ${C.r3(g.q)} ← زيادة ${C.r3(d)} ${it.unit}` });
  }
  for (const [id, g] of got) if (!seen.has(id)) rows.push({ item_id: id, name: g.name, unit: g.unit, invoice: 0, weighed: C.r3(g.q), status: 'not_invoiced', text: `📦 ${g.name}: انوزن ${C.r3(g.q)} ${g.unit} وما هو في الحساب` });
  return { rows, owed: C.r2(owed) };
}

module.exports = { awaitingFor, compare, TOL };
