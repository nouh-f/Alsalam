'use strict';
// «اسأل المساعد» + «لخّص لي اليوم» + «توصيات بكرة»
// المساعد ما يحفظ شي بنفسه: أدوات القراءة تنادي نفس حسابات التطبيق، وأدوات «اقتراح» تجهّز كرت
// والموظف يضغط «تأكيد» — والتأكيد ينادي نفس الـ API (نفس الصلاحيات والتحقق)
const { all, get, run } = require('./db');
const C = require('./calc');
const F = require('./forecast');
const AI = require('./ai');
const { similarity } = require('./match');

const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
const MAX_DAYS = 62;
function range(from, to, today) {
  to = isDate(to) ? to : today; from = isDate(from) ? from : to;
  if (from > to) [from, to] = [to, from];
  if (C.addDays(from, MAX_DAYS) < to) from = C.addDays(to, -MAX_DAYS);
  return { from, to };
}
function days(from, to) { const out = []; for (let d = from; d <= to; d = C.addDays(d, 1)) out.push(d); return out; }
const label = r => r.name + (r.variant ? ' ' + r.variant : '');

// ===== الأدوات =====
const S = (props, desc) => ({ type: 'object', additionalProperties: false, required: Object.keys(props), properties: props, ...(desc ? { description: desc } : {}) });
const DATE = { type: 'string', description: 'تاريخ يوم العمل YYYY-MM-DD' };
const OPT = d => ({ type: ['string', 'null'], description: d });
const TOOLS = [
  { name: 'day_report', description: 'تقرير يوم كامل: المبيعات والكاش والشبكة والمصروفات والمشتريات والنقص لكل موظف والتنبيهات، وأكثر الأصناف بيعًا.', input_schema: S({ date: DATE }) },
  { name: 'count_board', description: 'جرد يوم: لكل صنف أول اليوم والوارد وآخر اليوم والمفروض ينصرف حسب المبيعات والفرق (موجب = نقص) ومين الفاتح والمقفل.', input_schema: S({ date: DATE }) },
  { name: 'sales', description: 'مبيعات فترة (حد أقصى شهرين): كمية ومبلغ كل صنف، ومجموع كل يوم. product اختياري: جزء من اسم الصنف.', input_schema: S({ from: DATE, to: DATE, product: OPT('جزء من اسم صنف البيع أو null') }) },
  { name: 'shortages', description: 'النقص في الجرد لفترة (حد أقصى شهرين): لكل موظف مقفل ولكل صنف كم مرة نقص وكم قيمته. employee اختياري.', input_schema: S({ from: DATE, to: DATE, employee: OPT('اسم الموظف أو null') }) },
  { name: 'purchases', description: 'المشتريات لفترة (حد أقصى شهرين): كل صنف كم انشرى وبكم ومن أي مورد. item اختياري: جزء من اسم الصنف.', input_schema: S({ from: DATE, to: DATE, item: OPT('جزء من اسم صنف المخزون أو null') }) },
  { name: 'item_info', description: 'معلومات صنف مخزون: وحدته وتكلفته ورصيده في المستودع ومكوناته ومين مسؤول عنه وأي أصناف بيع تنخصم منه وبكم.', input_schema: S({ name: { type: 'string', description: 'اسم الصنف' } }) },
  { name: 'forecast', description: 'توقع يوم (عادة بكرة) من السجل: متوسط نفس اليوم من الأسابيع اللي فاتت مع أثر الراتب والموسم، وكم يتجهّز من كل صنف وكم ينشرى، والمستودع اللي قرب يخلص.', input_schema: S({ date: DATE }) },
].map(t => ({ ...t, strict: true }));

function runTool(name, input, today) {
  switch (name) {
    case 'day_report': {
      const d = isDate(input.date) ? input.date : today;
      const r = C.dailyReport(d);
      return {
        date: d, closed: !!r.closed, money: r.money && Object.fromEntries(Object.entries(r.money).filter(([k]) => k !== 'payments')),
        payments: r.money.payments, by_person: r.by_person, alerts: r.alerts.map(a => a.text),
        top_sales: r.sales.slice(0, 25).map(s => ({ name: label(s), qty: s.qty, amount: s.amount, unit_cost: s.unit_cost })),
        expenses: r.expenses.map(e => ({ amount: e.amount, note: e.note, category: e.category })),
      };
    }
    case 'count_board': {
      const d = isDate(input.date) ? input.date : today;
      return { date: d, rows: C.dailyBoard(d).rows.map(r => ({ name: r.name, unit: r.unit, opening: r.opening, received: r.received, closing: r.closing,
        should_use: r.theoretical, used: r.actual, shortage: r.diff, shortage_value: r.diff_value, waste: r.waste, opener: r.no_opening ? 'يبدأ من الشراء' : r.opening_user, closer: r.closing_user })) };
    }
    case 'sales': {
      const { from, to } = range(input.from, input.to, today);
      const like = input.product ? `%${String(input.product).trim()}%` : null;
      const rows = all(`SELECT p.name, p.variant, SUM(s.qty) AS qty, SUM(s.amount) AS amount FROM sales s LEFT JOIN products p ON p.id = s.product_id
        WHERE s.date BETWEEN ? AND ? ${like ? "AND (p.name || ' ' || COALESCE(p.variant, '')) LIKE ?" : ''} GROUP BY s.product_id ORDER BY amount DESC LIMIT 80`, from, to, ...(like ? [like] : []));
      const perDay = all(`SELECT s.date, SUM(s.amount) AS amount ${like ? ', SUM(s.qty) AS qty' : ''} FROM sales s LEFT JOIN products p ON p.id = s.product_id
        WHERE s.date BETWEEN ? AND ? ${like ? "AND (p.name || ' ' || COALESCE(p.variant, '')) LIKE ?" : ''} GROUP BY s.date ORDER BY s.date`, from, to, ...(like ? [like] : []));
      return { from, to, products: rows.map(r => ({ name: label(r), qty: C.r3(r.qty), amount: C.r2(r.amount) })),
        per_day: perDay.map(r => ({ date: r.date, weekday: F.WEEKDAYS[new Date(r.date + 'T00:00:00Z').getUTCDay()], amount: C.r2(r.amount), ...(r.qty != null ? { qty: C.r3(r.qty) } : {}) })) };
    }
    case 'shortages': {
      const { from, to } = range(input.from, input.to, today);
      const emp = input.employee ? String(input.employee).trim() : '';
      const people = {}, itemsMap = {};
      for (const d of days(from, to)) for (const r of C.dailyBoard(d).rows) {
        if (r.diff == null || r.diff <= 0.0001) continue;
        if (emp && !String(r.closing_user).includes(emp)) continue;
        const p = people[r.closing_user] = people[r.closing_user] || { employee: r.closing_user, times: 0, value: 0 };
        p.times++; p.value = C.r2(p.value + (r.diff_value || 0));
        const k = r.name + '|' + r.closing_user;
        const it = itemsMap[k] = itemsMap[k] || { item: r.name, unit: r.unit, employee: r.closing_user, days: 0, qty: 0, value: 0 };
        it.days++; it.qty = C.r3(it.qty + r.diff); it.value = C.r2(it.value + (r.diff_value || 0));
      }
      return { from, to, by_employee: Object.values(people).sort((a, b) => b.value - a.value), by_item: Object.values(itemsMap).sort((a, b) => b.value - a.value).slice(0, 60) };
    }
    case 'purchases': {
      const { from, to } = range(input.from, input.to, today);
      const like = input.item ? `%${String(input.item).trim()}%` : null;
      const rows = all(`SELECT p.date, p.supplier, i.name AS item, i.unit, l.qty, l.unit_price, l.pu_name, l.pu_qty, l.pu_price FROM purchase_lines l
        JOIN purchases p ON p.id = l.purchase_id LEFT JOIN items i ON i.id = l.item_id WHERE p.date BETWEEN ? AND ? ${like ? 'AND i.name LIKE ?' : ''} ORDER BY p.date`, from, to, ...(like ? [like] : []));
      const tot = {};
      for (const r of rows) { const t = tot[r.item] = tot[r.item] || { item: r.item, unit: r.unit, qty: 0, spent: 0 }; t.qty = C.r3(t.qty + r.qty); t.spent = C.r2(t.spent + r.qty * r.unit_price); }
      return { from, to, total: C.r2(Object.values(tot).reduce((s, t) => s + t.spent, 0)), by_item: Object.values(tot).sort((a, b) => b.spent - a.spent), lines: rows.slice(-120) };
    }
    case 'item_info': {
      const q = String(input.name || '').trim();
      const items = all('SELECT * FROM items WHERE active = 1');
      const best = items.map(i => ({ i, s: i.name === q ? 2 : i.name.includes(q) ? 1.5 : similarity(q, i.name) })).sort((a, b) => b.s - a.s)[0];
      if (!best || best.s < 0.5) return { found: false, hint: 'ما لقيت صنف بهالاسم' };
      const it = best.i;
      const costs = C.itemCostMap(), bal = C.warehouseBalances();
      const row = C.dailyBoard(today).rows.find(r => r.item_id === it.id);
      return {
        found: true, name: it.name, unit: it.unit, kind: it.kind === 'prepared' ? 'تحضير' : 'خام', counted_daily: !!it.daily, unit_cost: C.r3(costs.get(it.id) || 0),
        warehouse_balance: bal.get(it.id) || 0, opener: row ? (row.no_opening ? 'يبدأ من الشراء' : row.opening_user) : null, closer: row ? row.closing_user : null,
        components: all('SELECT i.name, c.qty, i.unit FROM item_components c JOIN items i ON i.id = c.component_id WHERE c.item_id = ?', it.id),
        used_in: all('SELECT p.name, p.variant, r.qty FROM recipe_lines r JOIN products p ON p.id = r.product_id WHERE r.item_id = ? AND p.active = 1', it.id).map(r => ({ product: label(r), qty: r.qty })),
      };
    }
    case 'forecast': return F.forecast(isDate(input.date) ? input.date : C.addDays(today, 1));
    default: return { error: 'أداة غير معروفة' };
  }
}

// ===== الصلاحيات =====
const ROLE = u => {
  const owner = u.role === 'owner', sup = owner || u.role === 'supervisor';
  return { owner, sup, purch: sup || u.role === 'purchaser', onlyPurch: u.role === 'purchaser', sales: owner || (sup && !u.no_sales) };
};
const deps = { todoFor: null }; // index.js يعطينا «المطلوب منك الحين»

// ===== أدوات العامل والكل =====
const NUM = d => ({ type: 'number', description: d });
const NUMN = d => ({ type: ['number', 'null'], description: d });
const MODES = { pull: 'سحب من الثلاجة/المستودع', store: 'رجّع للثلاجة', waste: 'انرمى (خربان/طاح)', prep: 'تحضير جديد (تنخصم مكوناته)' };
const ACT = {
  my_tasks: { name: 'my_tasks', description: 'وش المطلوب من الموظف الحين: الجرد اللي باقي عليه، الاستلام، التذاكر، التذكيرات… (نفس «المطلوب منك الحين»).', input_schema: S({}) },
  explain_shortage: { name: 'explain_shortage', description: 'يشرح نقص (أو زيادة) صنف في يوم: أول اليوم + الوارد − اللي انرمى − آخر اليوم = اللي انصرف، مقابل المفروض حسب المبيعات، مع حركات الصنف. للعامل: أصنافه والأيام اللي فاتت بس.', input_schema: S({ item: { type: 'string', description: 'اسم الصنف' }, date: OPT('YYYY-MM-DD أو null = أمس') }) },
  set_reminder: { name: 'set_reminder', description: 'يجهّز تذكير للموظف نفسه يطلع له في «المطلوب منك الحين» في اليوم المحدد. يحتاج تأكيد.', input_schema: S({ text: { type: 'string' }, date: OPT('YYYY-MM-DD أو null = اليوم') }) },
  propose_count: { name: 'propose_count', description: 'يجهّز أرقام الجرد (أول الدوام أو آخر الدوام) لأصناف الموظف. يحتاج تأكيد.', input_schema: S({
    phase: { type: 'string', enum: ['opening', 'closing'], description: 'opening = أول الدوام، closing = آخر الدوام' },
    entries: { type: 'array', items: S({ item: { type: 'string', description: 'اسم الصنف' }, qty: NUM('العدد بوحدة الصنف') }) } }) },
  propose_move: { name: 'propose_move', description: `يجهّز حركة صنف في الجرد: ${Object.entries(MODES).map(([k, v]) => k + ' = ' + v).join('، ')}. يحتاج تأكيد.`, input_schema: S({
    mode: { type: 'string', enum: Object.keys(MODES) }, item: { type: 'string' }, qty: NUM('الكمية'), unit: OPT('وحدة ثانية للصنف (مثل «كيلو ني» للرز) أو null'), note: OPT('السبب/ملاحظة أو null') }) },
  propose_purchase: { name: 'propose_purchase', description: 'يجهّز تسجيل شراء (من الكلام أو صورة الفاتورة). يحتاج تأكيد. payment: cash = من الدرج، paid = مدفوع برا الدرج، credit = آجل على المورد.', input_schema: S({
    supplier: OPT('اسم المورد/المحل أو null'), payment: { type: 'string', enum: ['cash', 'paid', 'credit'] }, note: OPT('ملاحظة أو null'),
    lines: { type: 'array', items: S({ item: { type: 'string', description: 'اسم الصنف' }, qty: NUM('العدد'), unit: OPT('وحدة الشراء (كرتون، كيس…) أو null = وحدة الصنف'),
      unit_price: NUMN('سعر الوحدة أو null'), line_total: NUMN('مبلغ السطر أو null') }) } }) },
  prices: { name: 'prices', description: 'أسعار الشراء: آخر سعر لكل صنف، وتغيّره هالشهر، وأرخص مورد.', input_schema: S({ item: OPT('جزء من اسم الصنف أو null') }) },
  propose_expense: { name: 'propose_expense', description: 'يجهّز تسجيل مصروف (غاز، صيانة، نقل…). يحتاج تأكيد.', input_schema: S({ amount: NUM('المبلغ'), category: { type: 'string' }, note: OPT('ملاحظة أو null'), from_cash: { type: 'boolean', description: 'انصرف من الدرج؟' } }) },
  propose_cash_count: { name: 'propose_cash_count', description: 'يجهّز جرد الكاش آخر اليوم: كم كاش في الدرج وكم شبكة. يحتاج تأكيد.', input_schema: S({ cash: NUM('الكاش'), card: NUM('الشبكة'), date: OPT('YYYY-MM-DD أو null = اليوم') }) },
  propose_ticket: { name: 'propose_ticket', description: 'يجهّز رفع صور تذكرة الكاشير المرفقة مع الرسالة (تنقرا لحالها بعد التأكيد).', input_schema: S({ date: OPT('YYYY-MM-DD أو null = اليوم') }) },
};
for (const t of Object.values(ACT)) t.strict = true;
const READ = Object.fromEntries(TOOLS.map(t => [t.name, t]));

function toolsFor(u) {
  const r = ROLE(u), out = [ACT.my_tasks, ACT.set_reminder, READ.item_info];
  if (!r.onlyPurch) out.push(READ.count_board, ACT.explain_shortage, ACT.propose_count, ACT.propose_move);
  if (r.purch) out.push(ACT.propose_purchase, READ.purchases, ACT.prices);
  if (r.sup) out.push(ACT.propose_expense);
  if (r.sales) out.push(READ.day_report, READ.sales, READ.shortages, READ.forecast, ACT.propose_cash_count, ACT.propose_ticket);
  return out;
}

// اسم الصنف ← الصنف (بالضبط، بعدين جزء من الاسم، بعدين الأقرب)
function resolveItem(name, pool) {
  const q = String(name || '').trim();
  if (!q) return { err: 'اسم الصنف فاضي' };
  const exact = pool.find(i => i.name === q); if (exact) return { item: exact };
  const ranked = pool.map(i => ({ i, s: i.name.includes(q) || q.includes(i.name) ? 0.9 + Math.min(q.length, i.name.length) / 1000 : similarity(q, i.name) })).sort((a, b) => b.s - a.s);
  if (ranked[0] && ranked[0].s >= 0.6 && !(ranked[1] && ranked[1].s >= 0.9 && ranked[0].s < 1 && ranked[0].s - ranked[1].s < 0.005)) return { item: ranked[0].i };
  return { err: `ما عرفت «${q}»`, suggest: ranked.slice(0, 3).filter(x => x.s >= 0.35).map(x => x.i.name) };
}
const n3 = x => C.r3(Number(x) || 0);

// يجهّز الكرت — أو يرجّع للنموذج وش الناقص عشان يسأل الموظف
function propose(name, input, u, ctx) {
  const r = ROLE(u), today = ctx.today, date = isDate(input.date) ? input.date : today;
  const card = (type, title, lines, requests) => { const c = { id: 'a' + (ctx.actions.length + 1), type, title, lines, requests }; ctx.actions.push(c); return { ok: true, card: title, lines, note: 'الكرت طلع للموظف — قله يشيكه ويضغط «تأكيد». لا تقول انحفظ.' }; };
  const board = () => ctx.board || (ctx.board = C.dailyBoard(today));
  const mine = (row, phase) => r.sup || (phase === 'opening' ? row.opening_user_id === u.id : phase === 'closing' ? row.closing_user_id === u.id : row.opening_user_id === u.id || row.closing_user_id === u.id);
  switch (name) {
    case 'set_reminder': {
      const text = String(input.text || '').trim(); if (!text) return { error: 'وش التذكير؟' };
      return card('reminder', `⏰ تذكير ${date === today ? 'اليوم' : date}`, [text], [{ endpoint: '/api/reminders', body: { text, due_date: date } }]);
    }
    case 'propose_count': {
      const phase = input.phase === 'opening' ? 'opening' : 'closing';
      const rows = board().rows.filter(x => mine(x, phase) && !(phase === 'opening' && x.no_opening));
      const ok = [], bad = [];
      for (const e of input.entries || []) {
        const q = Number(e.qty);
        if (!Number.isFinite(q) || q < 0) { bad.push(`${e.item}: الكمية غلط`); continue; }
        const m = resolveItem(e.item, rows.map(x => ({ id: x.item_id, name: x.name, unit: x.unit })));
        if (m.err) { const other = resolveItem(e.item, board().rows.map(x => ({ id: x.item_id, name: x.name }))); bad.push(other.item ? `${other.item.name}: مو عليك في ${phase === 'opening' ? 'أول' : 'آخر'} الدوام` : `${m.err}${m.suggest && m.suggest.length ? ' — يمكن: ' + m.suggest.join('، ') : ''}`); continue; }
        ok.push({ item: m.item, qty: n3(q) });
      }
      if (!ok.length) return { error: 'ما فيه أصناف أقدر أسجلها', problems: bad };
      card('count', `جرد ${phase === 'opening' ? 'أول' : 'آخر'} الدوام`, [...ok.map(x => `${x.item.name}: ${x.qty} ${x.item.unit}`), ...bad.map(b => '⚠️ ' + b)],
        ok.map(x => ({ endpoint: '/api/count', body: { date: today, item_id: x.item.id, phase, qty: x.qty } })));
      return { ok: true, saved_in_card: ok.map(x => x.item.name), problems: bad, note: 'الكرت طلع — قله يضغط «تأكيد».' };
    }
    case 'propose_move': {
      const mode = MODES[input.mode] ? input.mode : null; if (!mode) return { error: 'نوع الحركة غلط' };
      const pool = all('SELECT id, name, unit, kind FROM items WHERE active = 1 AND daily = 1');
      const m = resolveItem(input.item, pool); if (m.err) return { error: m.err, suggest: m.suggest };
      const row = board().rows.find(x => x.item_id === m.item.id);
      if (!r.sup && (!row || !mine(row))) return { error: `${m.item.name} مو عليك` };
      const qty = Number(input.qty); if (!(qty > 0)) return { error: 'كم الكمية؟' };
      let unit = String(input.unit || '').trim();
      if (unit && unit !== m.item.unit && !get('SELECT 1 AS x FROM item_units WHERE item_id = ? AND name = ?', m.item.id, unit)) unit = '';
      return card('move', `${MODES[mode]}: ${m.item.name}`, [`${n3(qty)} ${unit || m.item.unit}${input.note ? ' — ' + input.note : ''}`],
        [{ endpoint: '/api/transfer', body: { date: today, item_id: m.item.id, qty: n3(qty), mode: mode === 'prep' ? undefined : mode, unit: unit || undefined, note: input.note || undefined } }]);
    }
    case 'propose_purchase': {
      const pool = all("SELECT id, name, unit FROM items WHERE active = 1 AND kind = 'raw'");
      const lines = [], bad = [];
      for (const l of input.lines || []) {
        const m = resolveItem(l.item, pool);
        if (m.err) { bad.push(`${m.err}${m.suggest && m.suggest.length ? ' — يمكن: ' + m.suggest.join('، ') : ' — ضيفه من صفحة المشتريات'}`); continue; }
        let unit = String(l.unit || '').trim();
        if (unit === m.item.unit) unit = '';
        if (unit && !get('SELECT 1 AS x FROM item_units WHERE item_id = ? AND name = ?', m.item.id, unit)) { bad.push(`${m.item.name}: كم ${m.item.unit} في «${unit}»؟ (أو سجّله بـ${m.item.unit})`); continue; }
        if (!(Number(l.qty) > 0)) { bad.push(`${m.item.name}: كم العدد؟`); continue; }
        const price = Number(l.unit_price) > 0 ? Number(l.unit_price) : null, total = Number(l.line_total) > 0 ? Number(l.line_total) : null;
        lines.push({ item: m.item, qty: n3(l.qty), unit, unit_price: price, line_total: total });
      }
      if (bad.length) return { error: 'ناقص معلومات — اسأل الموظف', problems: bad, understood: lines.map(x => x.item.name) };
      if (!lines.length) return { error: 'وش الأصناف؟' };
      if (input.payment === 'credit' && !String(input.supplier || '').trim()) return { error: 'الآجل لازم له اسم المورد — اسأله' };
      const sum = lines.reduce((t, x) => t + (x.line_total || (x.unit_price || 0) * x.qty), 0);
      const PAY = { cash: 'من الدرج', paid: 'مدفوع برا الدرج', credit: 'آجل' };
      return card('purchase', `شراء${input.supplier ? ' من ' + input.supplier : ''} — ${PAY[input.payment] || PAY.cash}`,
        [...lines.map(x => `${x.item.name}: ${x.qty} ${x.unit || x.item.unit}${x.unit_price ? ' × ' + x.unit_price : ''}${x.line_total ? ' = ' + x.line_total : ''}`), `المجموع ${C.r2(sum)}`],
        [{ endpoint: '/api/purchases', attach_image: ctx.images > 0, body: { date: today, supplier: input.supplier || '', payment: input.payment || 'cash', note: input.note || '',
          lines: lines.map(x => ({ item_id: x.item.id, qty: x.qty, unit: x.unit, unit_price: x.unit_price || '', line_total: x.line_total || '' })) } }]);
    }
    case 'propose_expense': {
      const amount = Number(input.amount); if (!(amount > 0)) return { error: 'كم المبلغ؟' };
      return card('expense', `مصروف: ${input.category || ''}`, [`${C.r2(amount)} ريال${input.from_cash ? ' — من الدرج' : ''}${input.note ? ' — ' + input.note : ''}`],
        [{ endpoint: '/api/expenses', body: { date: today, amount: C.r2(amount), category: input.category || '', note: input.note || '', paid_from_cash: !!input.from_cash } }]);
    }
    case 'propose_cash_count':
      if (!(Number(input.cash) >= 0) || !(Number(input.card) >= 0)) return { error: 'كم الكاش وكم الشبكة؟' };
      return card('cash', `جرد الكاش ${date}`, [`كاش ${C.r2(input.cash)} · شبكة ${C.r2(input.card)}`], [{ endpoint: '/api/cash', body: { date, cash: C.r2(input.cash), card: C.r2(input.card) } }]);
    case 'propose_ticket':
      if (!ctx.images) return { error: 'ما فيه صور — قله يصوّر التذكرة بزر 📷 ويرسلها' };
      return card('ticket', `رفع تذكرة ${date}`, [`${ctx.images} صورة — تنقرا لحالها بعد التأكيد`], [{ endpoint: '/api/tickets', attach_images: true, body: { date } }]);
  }
  return null;
}

function readFor(name, input, u, ctx) {
  const r = ROLE(u), today = ctx.today;
  switch (name) {
    case 'my_tasks': return deps.todoFor ? deps.todoFor(u, today, C.dailyBoard(today)).map(t => ({ level: { red: 'لازم الحين', amber: 'لا تنساه', info: 'للعلم', green: 'تمام' }[t.level], title: t.title, detail: t.detail })) : [];
    case 'explain_shortage': {
      const date = isDate(input.date) ? input.date : C.addDays(today, -1);
      // العامل يشوف حساب المفروض بعد ما يخلص اليوم بس (عشان ما يعدّل رقمه على المفروض)
      if (!r.sup && date >= today) return { error: 'شرح النقص يكون للأيام اللي فاتت — اليوم للحين ما خلص' };
      const rows = C.dailyBoard(date).rows.filter(x => r.sup || x.opening_user_id === u.id || x.closing_user_id === u.id);
      const m = resolveItem(input.item, rows.map(x => ({ id: x.item_id, name: x.name })));
      if (m.err) return { error: r.sup ? m.err : `${m.err} — أو مو من أصنافك`, suggest: m.suggest };
      const x = rows.find(y => y.item_id === m.item.id);
      const moves = all('SELECT m.type, m.qty, m.location, m.note, us.name AS user FROM moves m LEFT JOIN users us ON us.id = m.user_id WHERE m.date = ? AND m.item_id = ? AND m.type != ? ORDER BY m.id', date, x.item_id, 'sale_use');
      const sold = all(`SELECT p.name, p.variant, SUM(s.qty) AS q, MAX(rl.qty) AS per FROM sales s JOIN products p ON p.id = s.product_id JOIN recipe_lines rl ON rl.product_id = s.product_id AND rl.item_id = ?
        WHERE s.date = ? GROUP BY s.product_id ORDER BY q DESC LIMIT 15`, x.item_id, date).map(s => ({ product: label(s), sold: C.r3(s.q), per_one: s.per }));
      return { date, item: x.name, unit: x.unit, opening: x.opening, received: x.received, thrown_away: x.wasted, closing: x.closing, used: x.actual, should_use_by_sales: x.theoretical,
        difference: x.diff, meaning: x.diff == null ? 'الجرد ما اكتمل' : x.diff > 0 ? 'نقص' : x.diff < 0 ? 'زيادة' : 'مضبوط', value: x.diff_value, opener: x.opening_user, closer: x.closing_user, moves, sold_by_product: sold };
    }
    case 'count_board': {
      const b = runTool('count_board', input, today);
      if (r.sup) return b;
      b.rows = b.rows.filter(x => x.opener === u.name || x.closer === u.name).map(({ should_use, used, shortage, shortage_value, ...rest }) => rest);
      return b;
    }
    case 'prices': { const IN = require('./insights'); const q = String(input.item || '').trim(); return IN.purchasePrices(today).filter(x => !q || x.name.includes(q)).slice(0, 40); }
    case 'item_info':
      if (r.onlyPurch) { const out = runTool('item_info', input, today); if (out.found && out.kind !== 'خام') return { found: false, hint: 'هذا صنف تحضير' }; return out; }
      return runTool('item_info', input, today);
  }
  return runTool(name, input, today);
}

// ثابت (عشان الكاش): التاريخ والسائل يجون في رسالة المستخدم
const SYSTEM = `أنت مساعد مطعم السلام (مطعم يمني/سعودي: حنيذ، مندي، مرسة، فتة، حيسية، شطات، سمك…). تساعد صاحب المطعم والمشرفين والموظفين — كل واحد حسب صلاحياته (الأدوات اللي معك هي اللي يسمح له فيها).

مصطلحات التطبيق:
- «الجرد»: كل صنف يومي له «فاتح» يكتب كم موجود أول الدوام و«مقفل» يكتب الباقي آخر الدوام.
- «المفروض ينصرف» = حسب المبيعات والوصفات. «الفرق» موجب = نقص (على المقفل)، سالب = زيادة.
- «يبدأ من الشراء»: أصناف طازجة ما لها جرد أول اليوم (لحوح، كدر، رز مطبوخ…)، رصيدها من الشراء والتحضير.
- «المستودع»: المواد الخام (دقيق، زيت، ملح…). «التحضير»: أصناف تتجهز من مكونات.
- «التذكرة»: طلبات ما انقفلت في لويفرس، تنصوّر وتنقرا.
- أيام الراتب في السعودية حوالي 25–2 من كل شهر.

تسجيل الشغل (مشتريات، جرد، سحب، هالك، مصروف، كاش، تذكرة، تذكير):
- استخدم أداة propose_ (أو set_reminder) المناسبة. هي ما تحفظ — تطلع للموظف «كرت» ويضغط «تأكيد». قل له يشيك الكرت ويضغط تأكيد، ولا تقول «انحفظ».
- إذا ناقص شي (الكمية، السعر، الوحدة، المورد، اسم الصنف مو واضح) اسأله سؤال واحد قصير قبل ما تجهّز.
- لا تخمّن أرقام. الصورة (فاتورة) اقرأ أسطرها بدقة.
- أصناف التحضير: «تحضير» (prep) تنخصم مكوناته، و«سحب» (pull) من الثلاجة زي ما هو.

طريقة الرد:
- رد بنفس لغة الموظف (عربي، إنجليزي، بنغالي، هندي، أوردو…). أسماء الأصناف اكتبها بالعربي زي ما هي في النظام.
- بالعربي: اللهجة السعودية البسيطة، قصير وواضح — الكل مو محاسبين.
- استخدم الأدوات تجيب الأرقام. لا تخترع رقم أبدًا. إذا الأداة رجعت فاضي قل «ما عندي بيانات لهذا».
- المبالغ بالريال. اذكر التاريخ اللي تتكلم عنه.
- إذا السؤال عام عن إدارة المطاعم (تسعير، نسبة تكلفة الأكل، الهالك) جاوب من خبرتك العامة وقل إنها نصيحة عامة.
- رتّب الرد بنقاط قصيرة إذا فيه أكثر من رقم.`;

function checkDaily(u) {
  if (ROLE(u).owner) return;
  const cap = Number(require('./db').getSetting('ai_user_daily', '40')) || 0;
  if (cap && get("SELECT COUNT(*) AS n FROM ai_log WHERE user_id = ? AND kind = 'ask' AND at >= datetime('now', '-1 day')", u.id).n >= cap)
    throw Object.assign(new Error(`وصلت حد الأسئلة اليومي (${cap}) — كمّل بكرة أو كلم المالك`), { status: 400 });
}

async function ask(u, question, history = [], { detailed = false, images = [] } = {}) {
  question = String(question || '').trim().slice(0, 2000);
  const imgs = (Array.isArray(images) ? images : []).slice(0, 6).map(d => /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/s.exec(d || '')).filter(Boolean);
  if (!question && !imgs.length) throw Object.assign(new Error('اكتب سؤالك'), { status: 400 });
  if (!question) question = 'شوف الصور';
  AI.checkCap();
  checkDaily(u);
  const today = C.businessDate();
  const wd = F.WEEKDAYS[new Date(today + 'T00:00:00Z').getUTCDay()];
  // المحادثة اللي قبل: نص بس (آخر 6)
  const past = (Array.isArray(history) ? history : []).slice(-6)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim())
    .map(m => ({ role: m.role, content: String(m.text).slice(0, 4000) }));
  while (past.length && past[0].role !== 'user') past.shift();
  const R = ROLE(u);
  const who = R.owner ? 'المالك' : R.sup ? 'مشرف' : R.onlyPurch ? 'مسؤول المشتريات' : 'موظف';
  const first = `اليوم (يوم العمل): ${today} — ${wd}. اللي يكلمك: ${u.name} (${who}).${imgs.length ? ` أرفق ${imgs.length} صورة.` : ''}\n\n${question}`;
  const content = [...imgs.map(m => ({ type: 'image', source: { type: 'base64', media_type: m[1] === 'jpg' ? 'image/jpeg' : 'image/' + m[1], data: m[2] } })), { type: 'text', text: first }];
  const toolset = toolsFor(u), allowed = new Set(toolset.map(t => t.name));
  let cost = 0, tools = [], ctx;
  const loop = async tier => {
    ctx = { today, actions: [], images: imgs.length };
    const messages = [...past, { role: 'user', content }];
    for (let round = 0; round < 6; round++) {
      const res = await AI.create(tier, {
        max_tokens: 8000,
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: toolset, messages,
        output_config: { effort: 'medium' },
      });
      cost += AI.costOf(res.usage, tier);
      if (res.stop_reason === 'refusal') return 'ما أقدر أجاوب على هذا.';
      if (res.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: res.content }); continue; }
      const uses = (res.content || []).filter(b => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || !uses.length) return AI.textOf(res);
      messages.push({ role: 'assistant', content: res.content });
      messages.push({ role: 'user', content: uses.map(b => {
        tools.push(b.name);
        let out;
        try {
          if (!allowed.has(b.name)) out = { error: 'ما عندك صلاحية على هذا' };
          else out = propose(b.name, b.input || {}, u, ctx) || readFor(b.name, b.input || {}, u, ctx);
        } catch (e) { return { type: 'tool_result', tool_use_id: b.id, content: 'خطأ: ' + e.message, is_error: true }; }
        return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out).slice(0, 60000) };
      }) });
    }
    return '';
  };
  let tier = detailed ? 'strong' : 'fast';
  let answer = await loop(tier);
  // السريع ما قدر => نعيد بالقوي (من أول — التفكير مربوط بالنموذج)
  if (tier === 'fast' && !ctx.actions.length && (!answer || /ما أعرف|ما أقدر أحدد|لا أعرف/.test(answer))) { tier = 'strong'; tools = []; answer = await loop(tier); }
  answer = answer || (ctx.actions.length ? 'شيك الكرت واضغط «تأكيد».' : 'ما قدرت أطلع جواب — جرّب تسأل بطريقة ثانية.');
  AI.log(u.id, 'ask', question + (imgs.length ? ` [${imgs.length} صورة]` : ''), answer, cost, AI.MODELS[tier].id);
  return { answer, cost: Math.round(cost * 10000) / 10000, model: tier, tools: [...new Set(tools)], actions: ctx.actions };
}

// ===== ملخص اليوم وتوصيات بكرة (Opus، مرة لكل يوم، ينحفظ) =====
function saved(date, kind) { return get('SELECT * FROM ai_summaries WHERE date = ? AND kind = ?', date, kind) || null; }
function save(date, kind, text, cost) {
  run('INSERT INTO ai_summaries(date, kind, text, cost, at) VALUES(?,?,?,?,datetime(\'now\')) ON CONFLICT(date, kind) DO UPDATE SET text = excluded.text, cost = ai_summaries.cost + excluded.cost, at = excluded.at', date, kind, text, cost);
  return saved(date, kind);
}

async function oneShot(u, kind, date, prompt, data) {
  AI.checkCap();
  const res = await AI.create('strong', {
    max_tokens: 6000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `${prompt}\n\nالبيانات (JSON):\n${JSON.stringify(data).slice(0, 150000)}` }],
    output_config: { effort: 'medium' },
  });
  const cost = AI.costOf(res.usage, 'strong');
  const text = AI.textOf(res) || 'ما طلع شي.';
  AI.log(u.id, kind, date, text, cost, AI.MODELS.strong.id);
  return save(date, kind, text, cost);
}

async function summary(u, date, { refresh = false } = {}) {
  const s = saved(date, 'summary');
  if (s && !refresh) return s;
  const data = {
    day: runTool('day_report', { date }, date),
    shortages: C.dailyBoard(date).rows.filter(r => r.diff != null && Math.abs(r.diff) > 0.0001).map(r => ({ item: r.name, unit: r.unit, diff: r.diff, value: r.diff_value, closer: r.closing_user })),
    tickets: all('SELECT label, status, check_status, check_note, paper_total, lines_total FROM tickets WHERE date = ?', date),
  };
  return oneShot(u, 'summary', date, `لخّص يوم ${date} لصاحب المطعم في 5 إلى 8 نقاط قصيرة:
١. وش صار (المبيعات والكاش).
٢. وين النقص ومين عليه (بالأسماء والقيمة).
٣. الشي الغريب: صنف انباع بدون وصفة، كاش ناقص، تذكرة ما طابقت، سعر تغيّر.
٤. وش يسوي بكرة.
بدون مقدمة. كل نقطة سطر يبدأ بـ «•».`, data);
}

async function recommendations(u, date, { refresh = false } = {}) {
  const s = saved(date, 'reco');
  if (s && !refresh) return s;
  const today = C.businessDate();
  const fc = F.forecast(date);
  const last7 = runTool('shortages', { from: C.addDays(today, -7), to: C.addDays(today, -1), employee: null }, today);
  const waste = [];
  for (const d of days(C.addDays(today, -7), C.addDays(today, -1))) for (const r of C.dailyBoard(d).rows) if (r.waste) waste.push({ date: d, item: r.name, waste: r.waste, value: r.waste_value });
  return oneShot(u, 'reco', date, `هذي أرقام توقع يوم ${date} (${fc.weekday}) من سجل المطعم، مع النقص والهالك آخر أسبوع.
اكتب 4 إلى 6 توصيات واضحة لصاحب المطعم: كم يجهّز من الأصناف المهمة، وش يشتري، وش يقلّل لأنه ينرمى، ومين يتابع لأن النقص يتكرر عنده، وهل بكرة يوم راتب أو موسم.
إذا السجل قليل (samples أقل من 3) قلها بصراحة إن التوقع تقريبي.
بدون مقدمة. كل توصية سطر يبدأ بـ «•».`, { forecast: fc, shortages_last_7_days: last7, waste_last_7_days: waste.slice(0, 80) });
}

module.exports = { ask, summary, recommendations, runTool, TOOLS, saved, deps, toolsFor, resolveItem };
