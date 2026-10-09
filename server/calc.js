'use strict';
// الحسابات: يوم العمل، المحضّر، المستودع، التكلفة، المطابقة، التنبيهات
const { all, get, run, tx, getSetting } = require('./db');

const TZ_OFFSET_H = 3; // توقيت السعودية

function pad(n) { return String(n).padStart(2, '0'); }

// يوم العمل: اللي قبل ساعة بداية اليوم (مثلاً 4 الفجر) يُحسب على اليوم اللي قبله
function businessDate(at = new Date()) {
  const startH = Number(getSetting('day_start_hour', '4')) || 0;
  const d = new Date(new Date(at).getTime() + (TZ_OFFSET_H - startH) * 3600e3);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// حدود يوم العمل بتوقيت UTC (لاستعلام لويفرس)
function dayRangeUTC(date) {
  const startH = Number(getSetting('day_start_hour', '4')) || 0;
  const start = new Date(Date.parse(date + 'T00:00:00Z') + (startH - TZ_OFFSET_H) * 3600e3);
  return { start, end: new Date(start.getTime() + 864e5) };
}
function riyadhHour(at = new Date()) { return (new Date(at).getUTCHours() + TZ_OFFSET_H) % 24; }

const r3 = x => Math.round((Number(x) || 0) * 1000) / 1000;
const r2 = x => Math.round((Number(x) || 0) * 100) / 100;

// ===== التكلفة =====
// تكلفة الوحدة: للخام سعر الشراء، للمحضّر مجموع مكوناته (إذا ما له سعر)
function itemCostMap() {
  const items = all('SELECT id, cost, kind, extra_cost FROM items');
  const comps = all('SELECT * FROM item_components');
  const byItem = new Map();
  for (const c of comps) { if (!byItem.has(c.item_id)) byItem.set(c.item_id, []); byItem.get(c.item_id).push(c); }
  const base = new Map(items.map(i => [i.id, i]));
  const memo = new Map();
  const cost = (id, depth = 0) => {
    if (memo.has(id)) return memo.get(id);
    const it = base.get(id); if (!it) return 0;
    let v = it.cost;
    if (!v && byItem.has(id) && depth < 6) v = byItem.get(id).reduce((s, c) => s + c.qty * cost(c.component_id, depth + 1), 0);
    v += it.extra_cost || 0; // غاز وغيره
    memo.set(id, v);
    return v;
  };
  for (const i of items) cost(i.id);
  return memo;
}

function recipeMap() {
  const m = new Map();
  for (const l of all('SELECT * FROM recipe_lines')) {
    if (!m.has(l.product_id)) m.set(l.product_id, []);
    m.get(l.product_id).push(l);
  }
  return m;
}

function noteRules() {
  return all('SELECT * FROM note_rules').map(r => ({ ...r, only: safeJSON(r.only_items, []) }));
}
function safeJSON(s, d) { try { return JSON.parse(s); } catch { return d; } }

// وصفة البيع بعد تطبيق الملاحظات ("مرسة عسل بس")
function effectiveRecipe(sale, recipes, rules) {
  let lines = recipes.get(sale.product_id) || [];
  let only = sale.only_items ? safeJSON(sale.only_items, null) : null;
  if ((!only || !only.length) && sale.note) {
    const note = sale.note;
    const rule = rules.find(r => (r.product_id == null || r.product_id === sale.product_id) && note.includes(r.keyword));
    if (rule) only = rule.only;
  }
  if (only && only.length) lines = lines.filter(l => only.includes(l.item_id));
  return lines;
}

function productCost(productId, recipes, costs) {
  return (recipes.get(productId) || []).reduce((s, l) => s + l.qty * (costs.get(l.item_id) || 0), 0);
}

// ===== الاستهلاك النظري حسب الوصفات =====
function theoreticalUsage(date) {
  const recipes = recipeMap(), rules = noteRules();
  // المكان من الصنف نفسه: اللي ينجرد يوميًا ينخصم من الجرد، وغيره من المستودع
  // (لو انخصم صنف مستودع من «المحضّر» كان يضيع — لأنه ما يطلع في الجرد اليومي)
  const daily = new Set(all('SELECT id FROM items WHERE daily = 1').map(i => i.id));
  const use = { floor: new Map(), warehouse: new Map() };
  for (const s of all('SELECT * FROM sales WHERE date = ?', date)) {
    for (const l of effectiveRecipe(s, recipes, rules)) {
      const m = use[daily.has(l.item_id) ? 'floor' : 'warehouse'];
      m.set(l.item_id, (m.get(l.item_id) || 0) + l.qty * s.qty);
    }
  }
  return use;
}

// حركات سحب المستودع حسب المبيعات تنبني من جديد كل ما تغيرت المبيعات/الوصفات
function rebuildSaleUse(date) {
  if (get('SELECT 1 AS x FROM day_status WHERE date = ?', date)) return; // اليوم مقفل
  // سجل لويفرس القديم (قبل ما يبدأ النظام) للتوقعات بس — ما ينخصم من المستودع
  if (date < getSetting('stock_start_date', '')) { run("DELETE FROM moves WHERE date = ? AND type = 'sale_use'", date); return; }
  const use = theoreticalUsage(date);
  tx(() => {
    run("DELETE FROM moves WHERE date = ? AND type = 'sale_use'", date);
    for (const [itemId, q] of use.warehouse) if (q) run("INSERT INTO moves(date, item_id, location, qty, type, note) VALUES(?,?,'warehouse',?,'sale_use','سحب حسب الوصفات')", date, itemId, -r3(q));
  });
}

// ===== المستودع =====
function warehouseBalances() {
  const m = new Map();
  for (const r of all("SELECT item_id, SUM(qty) AS q FROM moves WHERE location = 'warehouse' GROUP BY item_id")) m.set(r.item_id, r3(r.q));
  return m;
}

// ===== الجرد اليومي =====
function responsibleFor(item, section, phase) {
  if (phase === 'opening') return item.opening_user_id || (section && section.opening_user_id) || null;
  return item.closing_user_id || (section && section.closing_user_id) || null;
}

function dailyBoard(date) {
  const sections = all('SELECT * FROM sections ORDER BY sort, id');
  const secMap = new Map(sections.map(s => [s.id, s]));
  const users = new Map(all('SELECT id, name FROM users').map(u => [u.id, u.name]));
  const items = all('SELECT * FROM items WHERE active = 1 AND daily = 1 ORDER BY sort, id');
  const counts = new Map(all('SELECT * FROM counts WHERE date = ?', date).map(c => [c.item_id, c]));
  const prev = new Map(all('SELECT item_id, closing FROM counts WHERE date = ?', addDays(date, -1)).map(c => [c.item_id, c.closing]));
  const received = new Map(all("SELECT item_id, SUM(qty) AS q FROM moves WHERE date = ? AND location = 'floor' GROUP BY item_id", date).map(r => [r.item_id, r.q]));
  const use = theoreticalUsage(date).floor;
  const costs = itemCostMap();
  const approvals = all('SELECT * FROM section_approvals WHERE date = ?', date);
  const approvers = all('SELECT * FROM section_approvers');

  const rows = items.map(it => {
    const sec = secMap.get(it.section_id);
    const c = counts.get(it.id) || {};
    // «يبدأ من الشراء» (لحوح، كدر، رز مطبوخ…): ما له جرد أول اليوم — يبدأ من صفر، والوارد هو الرصيد
    // واللي يقعد لبكرة (الشطة): أول اليوم = آخر أمس لحاله، والمسؤول يأكد الباقي آخر اليوم بس
    const o = it.no_opening ? (c.opening ?? (it.carry_over && prev.has(it.id) ? (prev.get(it.id) ?? 0) : 0)) : (c.opening ?? null), cl = c.closing ?? null;
    const rec = r3(received.get(it.id) || 0);
    const theo = r3(use.get(it.id) || 0);
    const prevClose = prev.has(it.id) ? prev.get(it.id) : null;
    const suggestedOpening = prevClose == null ? null : (it.carry_over ? prevClose : 0);
    let actual = null, diff = null, waste = null;
    if (o != null && cl != null) {
      actual = r3(o + rec - cl);
      diff = r3(actual - theo);                     // موجب = نقص
      waste = it.carry_over ? 0 : cl;               // الباقي آخر اليوم هالك
    }
    const unitValue = it.sale_value || costs.get(it.id) || 0;
    const openUser = it.no_opening ? null : responsibleFor(it, sec, 'opening'), closeUser = responsibleFor(it, sec, 'closing');
    return {
      item_id: it.id, name: it.name, unit: it.unit, note: it.note, carry_over: it.carry_over, kind: it.kind,
      section_id: it.section_id, section: sec ? sec.name : 'بدون قسم',
      opening: o, opening_by: c.opening_by ? users.get(c.opening_by) : null, opening_at: c.opening_at || null,
      closing: cl, closing_by: c.closing_by ? users.get(c.closing_by) : null, closing_at: c.closing_at || null,
      count_note: c.note || '',
      opening_user_id: openUser, opening_user: users.get(openUser) || '—',
      closing_user_id: closeUser, closing_user: users.get(closeUser) || '—',
      prev_closing: prevClose, suggested_opening: suggestedOpening,
      // للدجاج (يسحبون من الثلاجة أول اليوم): الزيادة سحب طبيعي، والنقص بس هو المشكلة
      opening_gap: (!it.no_opening && o != null && suggestedOpening != null && (!it.pull_on_open || o < suggestedOpening)) ? r3(o - suggestedOpening) : null,
      pulled: (it.pull_on_open && o != null && prevClose != null && o > prevClose) ? r3(o - prevClose) : 0,
      pull_on_open: it.pull_on_open, no_opening: it.no_opening ? 1 : 0,
      received: rec, theoretical: theo, actual, diff, waste,
      remaining_expected: o != null ? r3(o + rec - theo) : null,  // "هذا باقي كذا"
      diff_value: diff != null ? r2(diff * unitValue) : null,
      waste_value: waste ? r2(waste * (costs.get(it.id) || 0)) : 0,
    };
  });

  const secs = sections.map(s => {
    const its = rows.filter(r => r.section_id === s.id);
    const ap = ph => { const a = approvals.find(x => x.section_id === s.id && x.phase === ph); return a ? { by: users.get(a.user_id), at: a.at } : null; };
    return {
      id: s.id, name: s.name,
      opening_user: users.get(s.opening_user_id) || '—', closing_user: users.get(s.closing_user_id) || '—',
      opening_user_id: s.opening_user_id, closing_user_id: s.closing_user_id,
      approvers: approvers.filter(a => a.section_id === s.id).map(a => ({ id: a.user_id, name: users.get(a.user_id) })),
      items: its.length,
      opening_done: its.filter(r => r.opening != null).length,
      closing_done: its.filter(r => r.closing != null).length,
      opening_approved: ap('opening'), closing_approved: ap('closing'),
      shortage_value: r2(its.reduce((t, r) => t + (r.diff_value > 0 ? r.diff_value : 0), 0)),
    };
  }).filter(s => s.items > 0);

  return { date, rows, sections: secs };
}

// ===== المبيعات المدمجة (لويفرس + التذكرة) =====
function mergedSales(date) {
  const costs = itemCostMap(), recipes = recipeMap();
  const rows = all(`SELECT s.product_id, p.name, p.variant, p.price, p.recipe_status, s.source,
      SUM(s.qty) AS qty, SUM(s.amount) AS amount, SUM(s.list_amount) AS list_amount
    FROM sales s LEFT JOIN products p ON p.id = s.product_id WHERE s.date = ?
    GROUP BY s.product_id, s.source`, date);
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.product_id)) m.set(r.product_id, {
      product_id: r.product_id, name: r.name || 'غير معروف', variant: r.variant || '', price: r.price || 0,
      recipe_status: r.recipe_status || 'none', loyverse_qty: 0, ticket_qty: 0, qty: 0, amount: 0, list_amount: 0, ticket_amount: 0,
    });
    const x = m.get(r.product_id);
    if (r.source === 'ticket') { x.ticket_qty += r.qty; x.ticket_amount += r.amount; } else x.loyverse_qty += r.qty;
    x.qty += r.qty; x.amount += r.amount; x.list_amount += r.list_amount;
  }
  return [...m.values()].map(x => {
    const unitCost = productCost(x.product_id, recipes, costs);
    return { ...x, qty: r3(x.qty), loyverse_qty: r3(x.loyverse_qty), ticket_qty: r3(x.ticket_qty), amount: r2(x.amount), ticket_amount: r2(x.ticket_amount),
      list_amount: r2(x.list_amount), unit_cost: r2(unitCost), cost: r2(unitCost * x.qty), profit: r2(x.amount - unitCost * x.qty) };
  }).sort((a, b) => b.amount - a.amount);
}

// ===== التقرير اليومي =====
function dailyReport(date) {
  const sales = mergedSales(date);
  const board = dailyBoard(date);
  const payments = all('SELECT name, type, amount FROM payments WHERE date = ? ORDER BY amount DESC', date);
  const loyTotal = r2(all("SELECT SUM(amount) AS a FROM sales WHERE date = ? AND source = 'loyverse'", date)[0].a);
  const ticketTotal = r2(all("SELECT SUM(amount) AS a FROM sales WHERE date = ? AND source = 'ticket'", date)[0].a);
  const listTotal = r2(sales.reduce((s, x) => s + x.list_amount, 0));
  const cashPay = r2(payments.filter(p => p.type === 'CASH').reduce((s, p) => s + p.amount, 0));
  const cardPay = r2(payments.filter(p => p.type !== 'CASH').reduce((s, p) => s + p.amount, 0));
  const expenses = all('SELECT e.*, u.name AS user FROM expenses e LEFT JOIN users u ON u.id = e.user_id WHERE date = ?', date);
  const purchases = all('SELECT p.*, u.name AS user FROM purchases p LEFT JOIN users u ON u.id = p.user_id WHERE date = ?', date);
  const supplierCash = r2(get('SELECT SUM(amount) AS a FROM supplier_payments WHERE date = ? AND paid_from_cash = 1', date).a);
  const cashExp = r2(expenses.filter(e => e.paid_from_cash).reduce((s, e) => s + e.amount, 0)
    + purchases.filter(p => p.paid_from_cash).reduce((s, p) => s + p.total, 0) + supplierCash);
  // مبيعات التذكرة: ما تنقفل في لويفرس. إذا فلوسها تدخل الدرج كاش (من الإعدادات) تنضاف للكاش المفروض
  const ticketCash = getSetting('ticket_in_cash', '0') === '1' ? ticketTotal : 0;
  const cc = get('SELECT * FROM cash_counts WHERE date = ?', date);
  const expectedCash = r2(cashPay + ticketCash - cashExp);
  const cogs = r2(sales.reduce((s, x) => s + x.cost, 0));
  const totalSales = r2(loyTotal + ticketTotal);
  const invShortValue = r2(board.rows.reduce((s, r) => s + (r.diff_value > 0 ? r.diff_value : 0), 0));
  const invOverValue = r2(board.rows.reduce((s, r) => s + (r.diff_value < 0 ? r.diff_value : 0), 0));
  const wasteValue = r2(board.rows.reduce((s, r) => s + (r.waste_value || 0), 0));

  // النقص حسب الموظف المسؤول عن الإغلاق
  const byPerson = {};
  for (const r of board.rows) {
    if (r.diff == null) continue;
    const k = r.closing_user;
    byPerson[k] = byPerson[k] || { person: k, items: 0, shortage_value: 0 };
    byPerson[k].items++;
    if (r.diff_value > 0) byPerson[k].shortage_value = r2(byPerson[k].shortage_value + r.diff_value);
  }

  return {
    date,
    closed: get('SELECT d.*, u.name AS by_name FROM day_status d LEFT JOIN users u ON u.id = d.closed_by WHERE date = ?', date) || null,
    money: {
      loyverse_total: loyTotal, ticket_total: ticketTotal, total_sales: totalSales,
      list_total: listTotal, discounts: r2(listTotal - totalSales),
      cash_payments: cashPay, card_payments: cardPay, payments,
      cash_expenses: cashExp, expected_cash: expectedCash,
      counted_cash: cc ? cc.cash : null, counted_card: cc ? cc.card : null,
      cash_shortage: cc ? r2(expectedCash - cc.cash) : null,
      card_shortage: cc ? r2(cardPay - cc.card) : null,
      cogs, gross_profit: r2(totalSales - cogs),
      inventory_shortage_value: invShortValue, inventory_over_value: invOverValue, waste_value: wasteValue,
      expenses_total: r2(expenses.reduce((s, e) => s + e.amount, 0)),
      purchases_total: r2(purchases.reduce((s, p) => s + p.total, 0)),
      purchases_credit: r2(purchases.filter(p => p.payment === 'credit').reduce((s, p) => s + p.total, 0)),
      supplier_payments_cash: supplierCash, ticket_cash: ticketCash,
      suppliers_owed: r2((get("SELECT SUM(total) AS a FROM purchases WHERE payment = 'credit'").a || 0) - (get('SELECT SUM(amount) AS a FROM supplier_payments').a || 0)),
    },
    sales, board, expenses, purchases,
    by_person: Object.values(byPerson),
    alerts: alerts(date),
  };
}

// ===== التنبيهات: مين ما دخّل، مين ما استلم =====
function alerts(date) {
  const out = [];
  const today = businessDate();
  const hour = riyadhHour();
  const openDeadline = Number(getSetting('opening_deadline_hour', '12'));
  const board = dailyBoard(date);
  const isPast = date < today;
  const openLate = isPast || hour >= openDeadline;
  const groupMissing = (phase) => {
    const g = {};
    for (const r of board.rows) if (r[phase] == null) {
      const who = r[phase + '_user'];
      (g[who] = g[who] || []).push(r.name);
    }
    return g;
  };
  if (openLate) for (const [who, names] of Object.entries(groupMissing('opening')))
    out.push({ level: 'red', type: 'opening_missing', text: `${who} ما دخّل كمية أول اليوم: ${names.join('، ')}` });
  if (isPast || (board.rows.some(r => r.closing != null))) for (const [who, names] of Object.entries(groupMissing('closing')))
    out.push({ level: isPast ? 'red' : 'amber', type: 'closing_missing', text: `${who} ما دخّل كمية آخر اليوم: ${names.join('، ')}` });
  for (const s of board.sections) {
    if (openLate && s.opening_done === s.items && !s.opening_approved) out.push({ level: 'amber', type: 'opening_unapproved', text: `قسم ${s.name}: أول اليوم ما استلمه المشرف` });
    if (s.closing_done === s.items && !s.closing_approved) out.push({ level: 'amber', type: 'closing_unapproved', text: `قسم ${s.name}: آخر اليوم ما استلمه المشرف` });
  }
  for (const r of board.rows) {
    if (r.opening_gap) out.push({ level: 'amber', type: 'opening_gap', text: `${r.name}: أول اليوم (${r.opening}) غير عن آخر أمس (${r.suggested_opening})` });
    if (r.diff != null && r.diff > 0.0001) out.push({ level: 'red', type: 'shortage', text: `نقص ${r.name}: ${r.diff} ${r.unit}${r.diff_value ? ` (${r.diff_value} ريال)` : ''} — ${r.closing_user}` });
  }
  for (const tk of all("SELECT id, label, check_status, paper_total, lines_total FROM tickets WHERE date = ? AND status != 'confirmed' AND check_status IN ('mismatch', 'duplicate')", date))
    out.push({ level: 'red', type: 'ticket_check', text: tk.check_status === 'duplicate'
      ? `تذكرة ${tk.label || '#' + tk.id} مرفوعة مرتين — ما انحسبت`
      : `تذكرة ${tk.label || '#' + tk.id}: المجموع ما يطابق (الأسطر ${tk.lines_total} والمطبوع ${tk.paper_total}) — ما انحسبت لين تراجعها` });
  const t = get("SELECT COUNT(*) AS n FROM tickets WHERE date = ? AND status = 'draft'", date).n;
  if (t) out.push({ level: 'amber', type: 'ticket_draft', text: `فيه ${t} تذكرة ما تأكدت` });
  if (isPast && !get('SELECT 1 AS x FROM tickets WHERE date = ?', date)) out.push({ level: 'amber', type: 'ticket_missing', text: 'ما انرفعت صورة تذكرة الكاشير لهذا اليوم' });
  const un = get(`SELECT COUNT(*) AS n FROM ticket_lines l JOIN tickets t ON t.id = l.ticket_id WHERE t.date = ? AND l.product_id IS NULL`, date).n;
  if (un) out.push({ level: 'red', type: 'ticket_unmatched', text: `${un} سطر في التذكرة ما انربط بصنف` });
  const noRecipe = all(`SELECT DISTINCT p.name, p.variant FROM sales s JOIN products p ON p.id = s.product_id WHERE s.date = ? AND p.recipe_status != 'skip' AND p.id NOT IN (SELECT product_id FROM recipe_lines)`, date);
  if (noRecipe.length) out.push({ level: 'amber', type: 'no_recipe', text: `أصناف انباعت بدون وصفة: ${noRecipe.slice(0, 12).map(p => p.name + (p.variant ? ' ' + p.variant : '')).join('، ')}${noRecipe.length > 12 ? '…' : ''}` });
  if (isPast && !get('SELECT 1 AS x FROM cash_counts WHERE date = ?', date)) out.push({ level: 'amber', type: 'cash_missing', text: 'ما انجرد الكاش لهذا اليوم' });
  const lastSync = get('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1');
  if (lastSync && !lastSync.ok) out.push({ level: 'red', type: 'sync', text: `سحب لويفرس فشل: ${lastSync.message}` });
  if (!getSetting('loyverse_token')) out.push({ level: 'amber', type: 'sync', text: 'رمز لويفرس ما انحط — روح الإعدادات' });
  return out;
}

module.exports = {
  businessDate, addDays, dayRangeUTC, riyadhHour, r2, r3, safeJSON,
  itemCostMap, recipeMap, productCost, theoreticalUsage, rebuildSaleUse,
  warehouseBalances, dailyBoard, mergedSales, dailyReport, alerts,
};
