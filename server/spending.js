'use strict';
// «💸 كل المصروفات»: كل فلوس طلعت من المحل لفترة — مشتريات + مصاريف + سداد موردين — مفروزة من وين طلعت وعلى وش راحت
// الآجل ما ينحسب طالع لين ينسدد (سداده ينحسب) عشان ما تنحسب نفس الفلوس مرتين
const { all, get } = require('./db');

const r2 = x => Math.round((x || 0) * 100) / 100;
const SOURCES = ['cash', 'custody', 'card', 'paid', 'credit'];
const srcOf = (payment, fromCash) => SOURCES.includes(payment) ? payment : (fromCash ? 'cash' : 'paid');

function spending(from, to, { privateToo = false } = {}) {
  const rows = [];
  for (const p of all(`SELECT p.id, p.date, p.supplier, p.total, p.payment, p.paid_from_cash, p.note, p.approved_at, u.name AS by
      FROM purchases p LEFT JOIN users u ON u.id = p.user_id WHERE p.date BETWEEN ? AND ? ORDER BY p.date, p.id`, from, to)) {
    const items = all('SELECT i.name FROM purchase_lines l JOIN items i ON i.id = l.item_id WHERE l.purchase_id = ? ORDER BY l.id', p.id).map(x => x.name);
    rows.push({ type: 'purchase', id: p.id, date: p.date, what: items.join('، ') || p.note || 'شراء', who: p.supplier, amount: r2(p.total),
      source: srcOf(p.payment, p.paid_from_cash), by: p.by || '', note: p.note, pending: !p.approved_at });
  }
  for (const e of all(`SELECT e.id, e.date, e.amount, e.category, e.note, e.kind, e.payment, e.paid_from_cash, u.name AS by
      FROM expenses e LEFT JOIN users u ON u.id = e.user_id WHERE e.date BETWEEN ? AND ? ORDER BY e.date, e.id`, from, to)) {
    const type = e.kind === 'home' ? 'home' : e.kind === 'advance' ? 'advance' : 'expense';
    if (type !== 'expense' && !privateToo) continue; // الخاص والسلف للمالك بس
    rows.push({ type, id: e.id, date: e.date, what: e.category || 'مصاريف', who: '', amount: r2(e.amount), source: srcOf(e.payment, e.paid_from_cash), by: e.by || '', note: e.note });
  }
  for (const s of all(`SELECT sp.id, sp.date, sp.amount, sp.payment, sp.paid_from_cash, sp.note, s.name AS supplier, COALESCE(py.name, u.name) AS by
      FROM supplier_payments sp JOIN suppliers s ON s.id = sp.supplier_id LEFT JOIN users py ON py.id = sp.payer_id LEFT JOIN users u ON u.id = sp.user_id
      WHERE sp.date BETWEEN ? AND ? ORDER BY sp.date, sp.id`, from, to))
    rows.push({ type: 'supplier', id: s.id, date: s.date, what: 'سداد ' + s.supplier, who: s.supplier, amount: r2(s.amount), source: srcOf(s.payment, s.paid_from_cash), by: s.by || '', note: s.note });
  rows.sort((a, b) => a.date.localeCompare(b.date));

  const sum = f => r2(rows.filter(f).reduce((t, r) => t + r.amount, 0));
  const by_source = Object.fromEntries(SOURCES.map(k => [k, sum(r => r.source === k)]));
  const by_type = Object.fromEntries(['purchase', 'expense', 'supplier', 'home', 'advance'].map(k => [k, sum(r => r.type === k && r.source !== 'credit')]));
  return {
    from, to, rows, by_source, by_type,
    out: sum(r => r.source !== 'credit'), // الفلوس اللي طلعت فعلاً
    credit: by_source.credit, // انشرى آجل — لسه ما طلع (يطلع لما ينسدد)
    drawer: by_source.cash, // اللي طلع من الدرج (المحل يسجله) — ينخصم من الكاش المتوقع
    // عهدة عطيناها للمشتري من الدرج: مو مصروف بحد ذاتها (اللي يشتريه منها ينحسب «من العهدة»)
    custody_from_drawer: r2(get('SELECT SUM(amount) AS a FROM cash_custody WHERE date BETWEEN ? AND ? AND from_drawer = 1 AND confirmed = 1', from, to).a),
  };
}

module.exports = { spending };
