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
  { name: 'customers', description: 'العملاء من أسماء تذاكر الكاشير: كل اسم كم مرة جا وكم صرف وآخر زيارة ووش أخذ. name اختياري: جزء من اسم العميل.', input_schema: S({ from: DATE, to: DATE, name: OPT('جزء من اسم العميل أو null') }) },
  { name: 'shortages', description: 'النقص في الجرد لفترة (حد أقصى شهرين): لكل موظف مقفل ولكل صنف كم مرة نقص وكم قيمته. employee اختياري.', input_schema: S({ from: DATE, to: DATE, employee: OPT('اسم الموظف أو null') }) },
  { name: 'purchases', description: 'المشتريات لفترة (حد أقصى شهرين): كل صنف كم انشرى وبكم ومن أي مورد. item اختياري: جزء من اسم الصنف.', input_schema: S({ from: DATE, to: DATE, item: OPT('جزء من اسم صنف المخزون أو null') }) },
  { name: 'item_info', description: 'معلومات صنف مخزون: وحدته وتكلفته ورصيده في المستودع ومكوناته ومين مسؤول عنه وأي أصناف بيع تنخصم منه وبكم.', input_schema: S({ name: { type: 'string', description: 'اسم الصنف' } }) },
  { name: 'forecast', description: 'توقع يوم (عادة بكرة) من السجل: متوسط نفس اليوم من الأسابيع اللي فاتت مع أثر الراتب والموسم، وكم يتجهّز من كل صنف وكم ينشرى، والمستودع اللي قرب يخلص.', input_schema: S({ date: DATE }) },
]; // أدوات القراءة بدون strict — Anthropic يسمح بـ20 أداة strict بس في الطلب

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
      const units = new Map(); for (const x of all('SELECT item_id, name, factor FROM item_units')) { if (!units.has(x.item_id)) units.set(x.item_id, []); units.get(x.item_id).push(x); }
      return { date: d, rows: C.dailyBoard(d).rows.map(r => ({ name: r.name, unit: r.unit, opening: r.opening, received: r.received, closing: r.closing,
        should_use: r.theoretical, used: r.actual, shortage: r.diff, shortage_value: r.diff_value, waste: r.waste, opener: r.no_opening ? 'يبدأ من الشراء' : r.opening_user, closer: r.closing_user,
        ...(units.has(r.item_id) ? { by_weight: units.get(r.item_id).map(x => `١ ${x.name} = ${x.factor} ${r.unit}`).join('، ') + (r.tare ? `؛ الصحن الفاضي ${r.tare} كجم` : '؛ وزن الصحن الفاضي مو معروف') } : {}) })) };
    }
    case 'customers': {
      const { from, to } = range(input.from, input.to, today);
      const q = String(input.name || '').trim();
      const list = require('./printer_read').customers(from, to).customers.filter(c => !q || c.name.includes(q));
      return { from, to, customers: list.slice(0, 40).map(c => ({ name: c.name, visits: c.visits, total: c.total, first: c.first, last: c.last,
        ...(q ? { tickets: c.tickets.slice(0, 15) } : {}) })) };
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
  return { owner, sup, purch: sup || u.role === 'purchaser', onlyPurch: u.role === 'purchaser', sales: owner || (sup && !u.no_sales), recipes: owner || (sup && !u.no_recipes) };
};
const deps = { todoFor: null }; // index.js يعطينا «المطلوب منك الحين»

// ===== أدوات العامل والكل =====
const NUM = d => ({ type: 'number', description: d });
const NUMN = d => ({ type: ['number', 'null'], description: d });
const MODES = { pull: 'سحب من الثلاجة/المستودع (واللحم: «طبخت» من المقسم)', store: 'رجّع للثلاجة', waste: 'انرمى (خربان/طاح)', prep: 'تحضير جديد (تنخصم مكوناته)', old: 'نزّل من القديم (اللحم المطبوخ من الأيام اللي فاتت) — أو عبّي من مصدره (قارورة العسل من عسل السلام: الكمية = الوزن بعد − قبل)' };
const ACT = {
  my_tasks: { name: 'my_tasks', description: 'وش المطلوب من الموظف الحين: الجرد اللي باقي عليه، الاستلام، التذاكر، التذكيرات… (نفس «المطلوب منك الحين»).', input_schema: S({}) },
  explain_shortage: { name: 'explain_shortage', description: 'يشرح نقص (أو زيادة) صنف في يوم: أول اليوم + الوارد − اللي انرمى − آخر اليوم = اللي انصرف، مقابل المفروض حسب المبيعات، مع حركات الصنف. للعامل: أصنافه والأيام اللي فاتت بس.', input_schema: S({ item: { type: 'string', description: 'اسم الصنف' }, date: OPT('YYYY-MM-DD أو null = أمس') }) },
  report_problem: { name: 'report_problem', description: 'يسجل مشكلة الموظف: مشكلة في النظام أو البرنامج، أرقام مو مضبوطة، صنف ناقص في قائمته (system/other = تنسجل ونوح يراجعها في تقرير الأسبوع، ما توصله على طول)، أو مشكلة في الشغل يبغاها توصل للإدارة الحين (work = توصل نوح على طول — للمهم بس: خلاف، تعطل جهاز، شي يوقف الشغل). مو للأسئلة العادية، ومو بديل عن التسجيل: لو تقدر تسجل بأداة سجل. ما يحتاج تأكيد.', input_schema: S({
    problem: { type: 'string', description: 'المشكلة بكلام واضح ومختصر (وش صار، أي صنف/يوم لو مذكور)' },
    kind: { type: 'string', enum: ['system', 'work', 'other'], description: 'system = النظام/الجرد/الأرقام، work = مشكلة شغل، other = غيرها' } }) },
  deduct: { name: 'deduct', description: 'خصم من راتب موظف — ينفذ على طول (مو كرت): على عامل/مشتري ينسجل في الرواتب ويوصله خبر، وعلى مشرف يروح لنوح يأكده. لما المالك أو مشرف المحل يقول «اخصم على فلان…» نفّذه بهالأداة. لو ما قال المبلغ ولا «أجرة يوم» اسأله كم. «أجرة يوم» = day_wage true.', input_schema: S({
    employee: { type: 'string', description: 'اسم الموظف زي ما قاله' },
    amount: NUMN('المبلغ بالريال، أو null لو day_wage'),
    day_wage: { type: 'boolean', description: 'true لو قال «أجرة يوم/يومية» بدل مبلغ' },
    reason: { type: 'string', description: 'السبب مختصر' },
    date: OPT('YYYY-MM-DD لو الخصم عن يوم فات، أو null = اليوم') }) },
  mark_absent: { name: 'mark_absent', description: 'يسجل إن موظف غايب اليوم (هو نفسه «أنا غايب»، أو زميله «فلان غايب»): ما توصله تذكيرات الجرد، ونوح يوصله خبر، واللي يغطي عنه يقدر يجرد أصنافه. ما يحتاج تأكيد.', input_schema: S({
    name: { type: 'string', description: 'اسم الغايب، أو "" لو هو نفسه' } }) },
  set_reminder: { name: 'set_reminder', description: 'يجهّز تذكير للموظف نفسه يطلع له في «المطلوب منك الحين» في اليوم المحدد. يحتاج تأكيد.', input_schema: S({ text: { type: 'string' }, date: OPT('YYYY-MM-DD أو null = اليوم') }) },
  propose_count: { name: 'propose_count', description: 'يجهّز أرقام الجرد (أول الدوام أو آخر الدوام) لأصناف الموظف. يحتاج تأكيد.', input_schema: S({
    phase: { type: 'string', enum: ['opening', 'closing'], description: 'opening = أول الدوام، closing = آخر الدوام' },
    day: { type: 'string', description: '"" = اليوم، أو "yesterday" لو يعطيك الباقي من آخر دوام أمس (مثل «هذا الباقي من أمس» — يتسجل آخر دوام أمس وينصار أول اليوم لحاله)' },
    entries: { type: 'array', items: S({ item: { type: 'string', description: 'اسم الصنف' }, qty: NUMN('العدد بوحدة الصنف، أو الوزن المقروء من الميزان لو unit = كجم (أو null لو الصنف ينجرد على أجزاء)'),
      unit: { type: 'string', description: '«كجم» لو أرسل صورة ميزان لصنف وحدته صحن/نفر وله نسبة كيلو (يتحسب: الوزن − الصحن الفاضي × النفر في الكيلو)، وإلا فاضي ""' },
      parts: { type: 'array', description: 'لو الصنف له أجزاء جرد (مثل كامل/مقطّع، ني/مستوي): كل جزء وكميته، وإلا فاضية []', items: S({ name: { type: 'string' }, qty: NUM('الكمية') }) } }) } }) },
  propose_move: { name: 'propose_move', description: `يجهّز حركة صنف في الجرد: ${Object.entries(MODES).map(([k, v]) => k + ' = ' + v).join('، ')}. يحتاج تأكيد.`, input_schema: S({
    mode: { type: 'string', enum: Object.keys(MODES) }, item: { type: 'string' }, qty: NUM('الكمية'), unit: OPT('وحدة ثانية للصنف (مثل «كيلو ني» للرز) أو null'), note: OPT('السبب/ملاحظة أو null') }) },
  propose_purchase: { name: 'propose_purchase', description: 'يجهّز تسجيل شراء (من الكلام أو صورة الفاتورة). يحتاج تأكيد. payment: cash = من الدرج، custody = من عهدة الموظف (الكاش اللي معه — زكريا)، card = بالبطاقة، paid = مدفوع برا الدرج (نوح دفع)، credit = آجل على المورد.', input_schema: S({
    supplier: OPT('اسم المورد/المحل أو null'), payment: { type: 'string', enum: ['cash', 'custody', 'card', 'paid', 'credit'] }, note: OPT('ملاحظة أو null'),
    date: OPT('YYYY-MM-DD يوم وصول البضاعة لو قال يوم ثاني («نزل الاثنين») أو null = اليوم'),
    lines: { type: 'array', items: S({ item: { type: 'string', description: 'اسم الصنف' }, qty: NUM('العدد'), unit: OPT('وحدة الشراء (كرتون، كيس…) أو null = وحدة الصنف'),
      per_unit: NUMN('كم من وحدة الصنف الأساسية في وحدة الشراء (الكيس = 40 كجم، الكرتون = 12 حبة) — لو مكتوب في الفاتورة أو قاله الموظف، وإلا null'),
      new_unit: OPT('لو الصنف مو موجود في النظام والموظف يبغى يضيفه: وحدته الأساسية (كجم، حبة، لتر…)، وإلا null'),
      unit_price: NUMN('سعر الوحدة أو null'), line_total: NUMN('مبلغ السطر أو null') }) } }) },
  propose_supplier_payment: { name: 'propose_supplier_payment', description: 'يجهّز تسجيل دفعة لمورد من حسابه الآجل (سداد): «دفعت للكدر ٢٢٠». payment: custody = من عهدة الموظف، cash = من الدرج، card = بالبطاقة، paid = نوح دفع. يحتاج تأكيد.', input_schema: S({
    supplier: { type: 'string' }, amount: NUM('المبلغ'), payment: { type: 'string', enum: ['custody', 'cash', 'card', 'paid'] }, date: OPT('YYYY-MM-DD أو null = اليوم'), note: OPT('ملاحظة أو null') }) },
  propose_purchase_payment: { name: 'propose_purchase_payment', description: 'يعدّل طريقة دفع شراء مسجّل قبل (مثل: انسجل آجل وهو مدفوع من العهدة). يحتاج تأكيد.', input_schema: S({
    supplier: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD يوم الشراء' }, payment: { type: 'string', enum: ['cash', 'custody', 'card', 'paid', 'credit'] } }) },
  honey_bottle: { name: 'honey_bottle', description: '🍯 قارورة عسل السلام: أي صورة ميزان من مسؤول القارورة = وزن القارورة. اقرأ الرقم بالكيلو (٠.٨٠٠ = 0.8) ونادها على طول — لا تسأله قبل ولا بعد ولا وش هو: النظام يعرف الخطوة (الصبح، بعد التعبئة، آخر الدوام). «العسل خلص/الدبة خلصت» => empty_tub. «آخر الدوام» => end. تنحفظ على طول — قله اللي يرجع في say حرفيًا.', input_schema: S({
    weight: { type: ['number', 'null'], description: 'الوزن بالكيلو من الميزان، أو null' },
    empty_tub: { type: 'boolean', description: 'true لو قال الدبة/العسل خلص' },
    end: { type: 'boolean', description: 'true لو قال إنها آخر الدوام' } }) },
  count_guide: { name: 'count_guide', description: 'دليل الجرد من الرابط خطوة بخطوة — ناده لو الموظف ما عرف يجرد من الرابط، أو سأل كيف، أو قال الرابط ما يفتح/ما فهمت، أو رجع يرسل جرد هنا بعد ما عطيته الرابط. الدليل ينضاف لردك لحاله: قل جملة قصيرة بس.', input_schema: S({}) },
  my_custody: { name: 'my_custody', description: 'عهدته: كم استلم وكم صرف والباقي كم، وكم صرفية بدون صورة، وآخر الحركات («كم باقي في عهدتي؟»).', input_schema: S({}) },
  prices: { name: 'prices', description: 'أسعار الشراء: آخر سعر لكل صنف، وتغيّره هالشهر، وأرخص مورد.', input_schema: S({ item: OPT('جزء من اسم الصنف أو null') }) },
  propose_expense: { name: 'propose_expense', description: 'يجهّز تسجيل مصروف (غاز، صيانة، نقل…). يحتاج تأكيد. payment: custody = من عهدته (الكاش اللي معه)، cash = من الدرج، card = بطاقة، paid = مدفوع برا. note = وش انشرى وفين (المحل).', input_schema: S({ amount: NUM('المبلغ'), category: { type: 'string' }, note: OPT('وش انشرى وفين، أو null'), from_cash: { type: 'boolean', description: 'انصرف من الدرج؟ (قديم — استخدم payment)' }, payment: OPT('cash | custody | card | paid — أو null') }) },
  propose_custody: { name: 'propose_custody', description: 'العهدة (الكاش اللي معه للصرف): «استلمت عهدة ٥٠٠ من الدرج/من نوح» = give، «رجّعت ٢٠٠» = return. يحتاج تأكيد.', input_schema: S({ type: { type: 'string', enum: ['give', 'return'] }, amount: NUM('المبلغ'), from_drawer: { type: 'boolean', description: 'من الدرج (أو رجّعها للدرج)؟' }, note: OPT('من مين/ليش، أو null') }) },
  propose_cash_count: { name: 'propose_cash_count', description: 'يجهّز جرد الكاش آخر اليوم: كم كاش في الدرج وكم شبكة. يحتاج تأكيد.', input_schema: S({ cash: NUM('الكاش'), card: NUM('الشبكة'), date: OPT('YYYY-MM-DD أو null = اليوم') }) },
  propose_ticket: { name: 'propose_ticket', description: 'يجهّز رفع صور تذكرة الكاشير المرفقة مع الرسالة (تنقرا لحالها بعد التأكيد).', input_schema: S({ date: OPT('YYYY-MM-DD أو null = اليوم') }) },
  remind_staff: { name: 'remind_staff', description: 'المشرف/المالك يرسل رسالة في الخاص (واتساب) لموظفين: اللي ما دخّلوا جرد أول الدوام، أو اللي ما قفلوا آخر الدوام، أو أسماء معيّنة. يحتاج تأكيد.', input_schema: S({
    who: { type: 'string', enum: ['missing_opening', 'missing_closing', 'names'], description: 'missing_opening = اللي باقي عليهم أول الدوام، missing_closing = اللي باقي عليهم آخر الدوام، names = الأسماء في names' },
    names: { type: 'array', items: { type: 'string' }, description: 'أسماء الموظفين (لو who = names، وإلا فاضية)' },
    text: { type: 'string', description: 'نص الرسالة — محترم وقصير' } }) },
  remember: { name: 'remember', description: 'ذاكرة دائمة للمالك/المشرف: يحفظ طريقة أو تعليمة يبغاها تتطبق في كل محادثة جاية معه (add)، أو يعرض المحفوظ (show)، أو يمسحه كله (clear). ما يحتاج تأكيد.', input_schema: S({
    action: { type: 'string', enum: ['add', 'show', 'clear'] }, text: OPT('التعليمة بكلام واضح (لـ add) أو null') }) },
  suggest_change: { name: 'suggest_change', description: 'اقتراح يحتاج موافقة نوح (المالك): تغيير مسؤول صنف (item_responsible)، اسم صنف (rename_item)، تصحيح جرد يوم فات أو جرد موظف ثاني (count_fix)، تطوير للنظام نفسه (feature)، أو غيره (other). يوصل لنوح يوافق بكلمة، ولو وافق ينفذ لحاله. الحقول اللي ما تخص النوع = null.', input_schema: S({
    kind: { type: 'string', enum: ['item_responsible', 'rename_item', 'count_fix', 'feature', 'other'] }, summary: { type: 'string', description: 'الاقتراح بجملة واضحة لنوح (وش وليش)' },
    item: OPT('الصنف أو null'), employee: OPT('الموظف (للمسؤول) أو null'), phase: { type: 'string', enum: ['opening', 'closing', 'none'], description: 'أول/آخر الدوام، أو none' },
    date: OPT('YYYY-MM-DD أو null'), qty: NUMN('الكمية الصحيحة (count_fix) أو null'), new_name: OPT('الاسم الجديد (rename_item) أو null') }) },
  learn: { name: 'learn', description: 'يحفظ معلومة عن طريقة شغل المحل في «دليل المطعم» (ينقرا في كل محادثة): طريقة صنف، مين يسوي وش، مورد، قاعدة، أو تصحيح فهمك. من المالك/المشرف تنحفظ على طول، ومن العامل تروح لنوح يوافق. replaces = رقم معلومة قديمة غلط في الدليل (بين [ ]) أو null. لا أرقام يومية ولا مبالغ ولا أسرار.', input_schema: S({
    topic: { type: 'string', enum: ['عام', 'الأقسام والمسؤولين', 'الأصناف وطريقتها', 'الموردين', 'الشراء', 'الجرد', 'الكاش والورقة اليومية', 'التذاكر والكاشير', 'العمال والقواعد'] },
    text: { type: 'string', description: 'المعلومة بجملة واضحة' }, replaces: NUMN('رقم المعلومة القديمة أو null') }) },
  propose_receive: { name: 'propose_receive', description: 'استلام بضاعة بالوزن أول ما توصل (مثل سمك الدعدع): من صورة الميزان وكلام الموظف (وش الصنف وحالته). كل صورة ميزان = وزن، وصورتين لنفس الصنف تنجمع (weights). ينسجل آجل على المورد «ينتظر الحساب» والكمية تدخل الجرد. يحتاج تأكيد.', input_schema: S({
    supplier: { type: 'string', description: 'المورد (مثل دعدع)' }, note: OPT('ملاحظة أو null'),
    lines: { type: 'array', items: S({ item: { type: 'string', description: 'اسم الصنف (ديراك، هامور…)' }, weights: { type: 'array', items: { type: 'number' }, description: 'الأوزان المقروءة من الميزان (كل صورة وزن)' } }) } }) },
  propose_store_count: { name: 'propose_store_count', description: 'جرد الموجود في الثلاجة اللي ورا / المستودع لأصناف «الشراء يروح ورا» (سمك محمد): من صور الميزان وكلامه — كل صورة وزن، وأكثر من صورة لنفس الصنف تنجمع. يصير هو الرصيد اللي ورا. بس لو قال صراحة «الباقي/الموجود ورا» أو «جرد ورا» — «طلعته من ورا للعرض/برا» مو جرد، هذا propose_move بـ pull. يحتاج تأكيد.', input_schema: S({
    lines: { type: 'array', items: S({ item: { type: 'string' }, weights: { type: 'array', items: { type: 'number' }, description: 'الأوزان (كل صورة وزن)' } }) } }) },
  match_invoice: { name: 'match_invoice', description: 'حساب (فاتورة) المورد وصل لاستلام انوزن قبل (مثل حساب الدعدع): يقارن كيلو بكيلو مع اللي وزناه، ويحط الأسعار. الناقص ناخذه من المورد والزايد نسكت. يحتاج تأكيد.', input_schema: S({
    supplier: { type: 'string', description: 'المورد' }, date: OPT('YYYY-MM-DD يوم الاستلام أو null = آخر استلام ينتظر الحساب'), total: NUMN('مجموع الحساب أو null'),
    lines: { type: 'array', items: S({ item: { type: 'string' }, qty: NUM('الكمية في الحساب'), unit_price: NUMN('السعر أو null') }) } }) },
  propose_split: { name: 'propose_split', description: 'يجهّز تقسيم ذبيحة/سهوم: كم انقسم من المصدر، وكم طلع من كل ناتج (سهوم، برم، حنيذ…). لو ما تعرف النواتج نادها بـ outputs فاضية ترجع لك القائمة واسأل الموظف. يحتاج تأكيد.', input_schema: S({
    source: { type: 'string', description: 'اللي ينقسم (ذبيحة، سهوم، كرتون…)' }, qty: NUM('كم انقسم منه'), date: OPT('YYYY-MM-DD أو null = اليوم'),
    outputs: { type: 'array', items: S({ item: { type: 'string' }, qty: NUM('كم طلع') }) } }) },
};
// strict (الإدخال مضبوط بالحرف) للي يكتب بيانات بس — الحد ٢٠ أداة strict في الطلب الواحد
// وكمان أقصى ١٦ خانة «اختيارية» (null) في كل الأدوات strict مع بعض — فنخليه للأهم (الأرقام والفلوس)
for (const k of ['set_reminder', 'propose_count', 'propose_move', 'propose_purchase', 'propose_expense', 'propose_cash_count']) ACT[k].strict = true;
const READ = Object.fromEntries(TOOLS.map(t => [t.name, t]));

function toolsFor(u) {
  const r = ROLE(u), out = [ACT.count_guide, ACT.my_tasks, ACT.set_reminder, ACT.report_problem, ACT.mark_absent, ACT.suggest_change, ACT.learn, READ.item_info, ACT.propose_receive, ACT.propose_store_count];
  if (!r.onlyPurch) out.push(READ.count_board, ACT.explain_shortage, ACT.propose_count, ACT.propose_move);
  if (r.purch) out.push(ACT.propose_purchase, ACT.propose_supplier_payment, ACT.propose_purchase_payment, READ.purchases, ACT.prices);
  if (r.sup) out.push(ACT.propose_expense, ACT.remind_staff, ACT.remember, ACT.match_invoice);
  if (require('./deduct').canDeduct(u)) out.push(ACT.deduct);
  if (r.sup || r.purch) out.push(ACT.propose_custody, ACT.my_custody);
  if (r.sup || canSplit(u)) out.push(ACT.propose_split);
  if (r.sales) out.push(READ.customers, READ.day_report, READ.sales, READ.shortages, READ.forecast, ACT.propose_cash_count, ACT.propose_ticket);
  return out;
}

// مين يقسم الذبيحة: المشرف، أو المسؤول عن نواتج التقسيم (نفس شرط /api/split)
function canSplit(u) {
  if (!u || !u.id) return false;
  return !!get(`SELECT 1 AS x FROM item_splits sp JOIN items i ON i.id = sp.out_item_id LEFT JOIN sections s ON s.id = i.section_id
    WHERE i.active = 1 AND (i.opening_user_id = ? OR i.closing_user_id = ? OR i.prep_user_id = ? OR s.opening_user_id = ? OR s.closing_user_id = ?) LIMIT 1`, u.id, u.id, u.id, u.id, u.id);
}
// تعديل صنف عن طريق /api/items لازم يرسل كل حقوله (وإلا السعر والملاحظة… ترجع افتراضي)
const itemBody = (it, over) => ({ id: it.id, name: it.name, unit: it.unit, kind: it.kind, daily: it.daily, section_id: it.section_id, cost: it.cost, sale_value: it.sale_value,
  carry_over: it.carry_over, opening_user_id: it.opening_user_id, closing_user_id: it.closing_user_id, note: it.note, pull_on_open: it.pull_on_open, extra_cost: it.extra_cost,
  leftover: it.leftover, need_photo: it.need_photo, ...over });
// 🧠 ذاكرة المالك/المشرف الدائمة (تنضاف لكل محادثة معه)
const memKey = u => 'mem:' + u.id;
const memOf = u => (get('SELECT body FROM private_notes WHERE key = ?', memKey(u)) || {}).body || '';

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
  const absent = require('./wa_nudge').absentIds(today);
  const mine = (row, phase) => r.sup || absent.includes(phase === 'opening' ? row.opening_user_id : row.closing_user_id) || (phase === 'opening' ? row.opening_user_id === u.id : phase === 'closing' ? row.closing_user_id === u.id : row.opening_user_id === u.id || row.closing_user_id === u.id || row.prep_user_id === u.id); // الحركة (أضفت/سويت): المحضّر كمان
  switch (name) {
    case 'honey_bottle': {
      const res = require('./honey').step(u, { weight: input.weight, empty_tub: !!input.empty_tub, end: !!input.end });
      if (res.notify && res.notify.length) ctx.notify = [...(ctx.notify || []), ...res.notify];
      if (res.say) ctx.say = [...(ctx.say || []), res.say]; // الرد ثابت من النظام (مو من كلام المساعد)
      return { ok: !res.error, error: res.error, note: res.say ? 'انحفظ — الرد ينرسل له لحاله، لا تكتب شي' : undefined };
    }
    case 'report_problem': { // يتسجل على طول (مو كرت) — ونوح توصله نسخة
      const problem = String(input.problem || '').trim().slice(0, 500); if (!problem) return { error: 'وش المشكلة؟' };
      run("INSERT INTO wa_issues(date, user_id, type, summary, by_id, chat, step, at) VALUES(?,?,?,?,?,?,0,datetime('now'))", today, u.id, input.kind === 'system' ? 'system' : 'other', problem, u.id, 'private');
      if (input.kind === 'work') ctx.report = problem; // بس مشاكل الشغل توصل نوح على طول — الباقي في تقرير الأسبوع
      return { ok: true, note: input.kind === 'work' ? 'اتسجلت ووصلت لنوح — طمّنه إنها وصلت.' : 'اتسجلت ونوح يراجعها آخر الأسبوع — طمّنه، وساعده باللي تقدر عليه.' };
    }
    case 'deduct': { // ✂️ ينفذ على طول — نفس قاعدة القروب (deduct.js)
      const D = require('./deduct');
      if (!D.canDeduct(u)) return { error: D.NOT_ALLOWED };
      const m = resolveItem(input.employee, D.staff());
      if (!m.item) return { error: `ما عرفت مين «${input.employee}»`, suggest: m.suggest };
      const amount = input.day_wage ? D.dayWage(m.item) : Number(input.amount);
      if (!(amount > 0)) return { error: input.day_wage ? `ما عندي راتب ${m.item.name} — اسأله كم المبلغ` : 'كم المبلغ؟ اسأله' };
      const res = D.deduct({ by: u, worker: m.item, amount, reason: input.reason, date: isDate(input.date) ? input.date : today, where: 'الخاص' });
      if (res.card && D.deps.ownerCard) {
        D.deps.ownerCard([res.card], `${u.name} طلب في الخاص:\n${res.card.title} — ${res.card.lines[0]}\n\nرد *تمام* عشان أسجله في الرواتب وأبلغ الموظف، أو *لا*.`).catch(() => {});
      }
      return res.done ? { ok: true, note: `${res.text}. ${m.item.name} وصله خبر${u.role === 'owner' ? '' : '، ونوح بعد'}. قل له كذا بسطر.` }
        : res.card ? { ok: true, note: 'هذا مشرف — راح لنوح يأكده. قل له كذا.' } : { error: res.error };
    }
    case 'mark_absent': {
      const q = String(input.name || '').trim();
      const who = !q ? u : (() => { const m = resolveItem(q, all('SELECT id, name FROM users WHERE active = 1 AND bot = 0')); return m.item; })();
      if (!who) return { error: `ما عرفت مين «${q}»` };
      const { setSetting } = require('./db');
      const ids = require('./wa_nudge').absentIds(today);
      if (!ids.includes(who.id)) { setSetting('wa_absent', JSON.stringify({ date: today, ids: [...ids, who.id] })); ctx.report = `${who.name} غايب اليوم${who.id !== u.id ? ` (قاله ${u.name})` : ''}`; }
      return { ok: true, note: `اتسجل ${who.name} غايب اليوم ووصل خبر لنوح. ما توصله تذكيرات، واللي يغطي عنه يقدر يجرد أصنافه.` };
    }
    case 'set_reminder': {
      const text = String(input.text || '').trim(); if (!text) return { error: 'وش التذكير؟' };
      return card('reminder', `⏰ تذكير ${date === today ? 'اليوم' : date}`, [text], [{ endpoint: '/api/reminders', body: { text, due_date: date } }]);
    }
    case 'propose_count': {
      const yday = input.day === 'yesterday';
      const phase = yday ? 'closing' : input.phase === 'opening' ? 'opening' : 'closing';
      const cdate = yday ? C.addDays(today, -1) : today;
      const rows = board().rows.filter(x => mine(x, phase) && !(phase === 'opening' && x.no_opening));
      const ok = [], bad = [], made = [];
      // 🥣 اللي يحضّره هو (مطفي، حلبة…) وما له جرد أول الدوام: رقمه الصبح = كم سوّى (تحضير)، مو «مو عليك»
      const mineMade = phase === 'opening' && !yday ? board().rows.filter(x => x.prep_user_id === u.id && x.no_opening) : [];
      for (const e of input.entries || []) {
        const m = resolveItem(e.item, rows.map(x => ({ id: x.item_id, name: x.name, unit: x.unit })));
        const pm = m.err && mineMade.length ? resolveItem(e.item, mineMade.map(x => ({ id: x.item_id, name: x.name, unit: x.unit }))) : null;
        if (pm && pm.item) { const q = Number(e.qty); if (q > 0) made.push({ item: pm.item, qty: n3(q) }); else bad.push(`${e.item}: الكمية غلط`); continue; }
        if (m.err) { const other = resolveItem(e.item, board().rows.map(x => ({ id: x.item_id, name: x.name }))); bad.push(other.item ? `${other.item.name}: مو عليك في ${phase === 'opening' ? 'أول' : 'آخر'} الدوام` : `${m.err}${m.suggest && m.suggest.length ? ' — يمكن: ' + m.suggest.join('، ') : ''}`); continue; }
        const row = rows.find(x => x.item_id === m.item.id);
        if (phase === 'closing' && row && row.parts && row.parts.length) { // جرد على أجزاء
          const got = {}; let tot = 0;
          for (const pt of row.parts) { const g = (e.parts || []).find(x => String(x.name).trim() === pt.name || String(x.name).includes(pt.name)); if (g && Number(g.qty) >= 0) { got[pt.name] = n3(g.qty); tot += g.qty * (pt.factor || 1); } }
          if (Object.keys(got).length < row.parts.length) { bad.push(`${m.item.name}: اسأله ${row.parts.map(pt => pt.name).join(' و')}${row.parts.some(pt => pt.factor !== 1) ? ` (${row.parts.filter(pt => pt.factor !== 1).map(pt => pt.name + ' ×' + pt.factor).join('، ')})` : ''}`); continue; }
          ok.push({ item: m.item, qty: n3(tot), parts: got }); continue;
        }
        const q = Number(e.qty);
        if (e.qty == null || !Number.isFinite(q) || q < 0) { bad.push(`${e.item}: الكمية غلط`); continue; }
        const un = String(e.unit || '').trim();
        if (un && un !== m.item.unit) { // بالوزن => نفر
          const f = get('SELECT factor FROM item_units WHERE item_id = ? AND name = ?', m.item.id, un);
          if (!f) { bad.push(`${m.item.name}: ما أعرف كم ${m.item.unit} يطلع من ${un} — اسأله، وأرسلها اقتراح لنوح (suggest_change other) يعتمدها`); continue; }
          const tare = row && row.tare || 0, net = n3(Math.max(0, q - (/^(كجم|كيلو)$/.test(un) ? tare : 0))), res = n3(net * f.factor);
          ok.push({ item: m.item, qty: res, raw: q, unit: un, show: `${n3(q)} ${un}${tare ? ` − الصحن ${tare} = ${net}` : ' (مع الصحن)'} × ${f.factor} = ` }); continue;
        }
        ok.push({ item: m.item, qty: n3(q) });
      }
      if (!r.owner && !countByBot(u) && ok.length) { // الجرد من الرابط
        if (made.length && !linkOnly(u, r)) card('move', `${MODES.prep}: ${made.map(x => x.item.name).join('، ')}`, made.map(x => `${x.item.name}: ${x.qty} ${x.item.unit} (سوّاها اليوم)`),
          made.map(x => ({ endpoint: '/api/add', body: { date: today, item_id: x.item.id, qty: x.qty, source: cookSrc(x.item.id) } })));
        return LINK_BLOCK(u, ctx);
      }
      if (made.length) card('move', `${MODES.prep}: ${made.map(x => x.item.name).join('، ')}`, made.map(x => `${x.item.name}: ${x.qty} ${x.item.unit} (سوّاها اليوم)`),
        made.map(x => ({ endpoint: '/api/add', body: { date: today, item_id: x.item.id, qty: x.qty, source: cookSrc(x.item.id) } })));
      if (!ok.length) return made.length ? { ok: true, saved_in_card: made.map(x => x.item.name), problems: bad, note: 'هذي اللي سوّاها اليوم (تحضير) — الكرت طلع، قله يرد «تمام».' } : { error: 'ما فيه أصناف أقدر أسجلها', problems: bad };
      card('count', `جرد ${phase === 'opening' ? 'أول' : 'آخر'} الدوام${yday ? ' (أمس)' : ''}`, [...ok.map(x => `${x.item.name}: ${x.parts ? Object.entries(x.parts).map(([k, v]) => `${k} ${v}`).join(' + ') + ' = ' : ''}${x.show || ''}${x.qty} ${x.item.unit}`), ...bad.map(b => '⚠️ ' + b)],
        ok.map(x => ({ endpoint: '/api/count', body: { date: cdate, item_id: x.item.id, phase, via: 'wa', ...(x.parts ? { parts: x.parts } : x.unit ? { qty: x.raw, unit: x.unit } : { qty: x.qty }) } })));
      return { ok: true, saved_in_card: [...ok, ...made].map(x => x.item.name), problems: bad, note: made.length ? `الكرت طلع — و${made.map(x => x.item.name).join('، ')} انحسبت تحضير (سوّاها اليوم). قله يضغط «تأكيد».` : 'الكرت طلع — قله يضغط «تأكيد».' };
    }
    case 'propose_move': {
      if (linkOnly(u, r)) return LINK_BLOCK(u, ctx);
      const mode = MODES[input.mode] ? input.mode : null; if (!mode) return { error: 'نوع الحركة غلط' };
      const pool = all('SELECT id, name, unit, kind FROM items WHERE active = 1 AND daily = 1');
      // أصنافه هو أول («قوار» عند فؤاد = «قوار مسلوق»، وعند محمد علي = «قوار») — وإلا كل الأصناف
      const own = new Set(board().rows.filter(x => mine(x)).map(x => x.item_id));
      const m0 = resolveItem(input.item, pool.filter(i => own.has(i.id)));
      const m = m0.item ? m0 : resolveItem(input.item, pool); if (m.err) return { error: m.err, suggest: m.suggest };
      const row = board().rows.find(x => x.item_id === m.item.id);
      if (!r.sup && (!row || !mine(row))) return { error: `${m.item.name} مو عليك` };
      const qty = Number(input.qty); if (!(qty > 0)) return { error: 'كم الكمية؟' };
      if (mode === 'waste' && !ctx.images) return { error: 'اللي انرمى لازم له صورة — قله يصوّره بزر 📷 ويرسله' };
      const full = get('SELECT old_item_id, buy_store FROM items WHERE id = ?', m.item.id) || {};
      if (mode === 'old') {
        // القديم (اللحم)، وإلا المصدر الوحيد للصنف (قارورة العسل ← عسل السلام)
        const srcs = full.old_item_id ? [] : all('SELECT s.from_item_id, i.name FROM item_sources s JOIN items i ON i.id = s.from_item_id WHERE s.item_id = ? AND i.active = 1', m.item.id);
        const from = full.old_item_id ? { id: full.old_item_id, title: 'نزّل من القديم' } : srcs.length === 1 ? { id: srcs[0].from_item_id, title: `عبّى من ${srcs[0].name}` } : null;
        if (!from) return { error: `${m.item.name} ما له «قديم» ولا مصدر واحد — يمكن يقصد سحب (pull)` };
        return card('move', `${from.title}: ${m.item.name}`, [`${n3(qty)} ${m.item.unit}`], [{ endpoint: '/api/add', body: { date: today, item_id: m.item.id, qty: n3(qty), source: 'from', from_item_id: from.id } }]);
      }
      // 🚫 سحب من المستودع لصنف شراؤه يروح العرض على طول (الديراك عند صادق) وما له رصيد ورا = يتحسب مرتين
      const lastBuy = get('SELECT l.to_floor FROM purchase_lines l JOIN purchases p ON p.id = l.purchase_id WHERE l.item_id = ? ORDER BY p.date DESC, l.id DESC LIMIT 1', m.item.id);
      if (mode === 'pull' && !full.buy_store && lastBuy && lastBuy.to_floor && !((C.warehouseBalances().get(m.item.id) || 0) > 0))
        return { error: `${m.item.name} ما له شي في المستودع — الشراء يدخل عهدته على طول، فما يحتاج سحب. لو وزن/صوّر وش عنده = جرده (آخر الدوام أو أول الدوام)، أو قل له ما يحتاج يسجل شي.` };
      if (mode === 'pull' && full.buy_store) // المقسم/الثلاجة اللي ورا: ينزل حتى لو الرصيد المسجّل أقل (ونوح يدري)
        return card('move', `${MODES.pull}: ${m.item.name}`, [`${n3(qty)} ${m.item.unit}${input.note ? ' — ' + input.note : ''}`], [{ endpoint: '/api/add', body: { date: today, item_id: m.item.id, qty: n3(qty), source: 'fridge' } }]);
      let unit = String(input.unit || '').trim();
      if (unit && unit !== m.item.unit && !get('SELECT 1 AS x FROM item_units WHERE item_id = ? AND name = ?', m.item.id, unit)) unit = '';
      return card('move', `${MODES[mode]}: ${m.item.name}`, [`${n3(qty)} ${unit || m.item.unit}${input.note ? ' — ' + input.note : ''}`],
        [mode === 'prep' ? { endpoint: '/api/add', body: { date: today, item_id: m.item.id, qty: n3(qty), unit: unit || undefined, source: cookSrc(m.item.id) } }
          : { endpoint: '/api/transfer', attach_image: mode === 'waste', body: { date: today, item_id: m.item.id, qty: n3(qty), mode, unit: unit || undefined, note: input.note || undefined } }]);
    }
    case 'propose_purchase': {
      const pool = all("SELECT id, name, unit FROM items WHERE active = 1 AND kind = 'raw'");
      const lines = [], bad = [];
      for (const l of input.lines || []) {
        let m = resolveItem(l.item, pool), isNew = false;
        const nu = String(l.new_unit || '').trim();
        if (m.err && nu && String(l.item || '').trim()) { m = { item: { id: null, name: String(l.item).trim().slice(0, 80), unit: nu } }; isNew = true; } // 🆕 صنف جديد
        if (m.err) { bad.push(`${m.err}${m.suggest && m.suggest.length ? ' — يمكن: ' + m.suggest.join('، ') : ''} — لو صنف جديد: اسأله وش وحدته (كجم، حبة…) وأرسلها في new_unit`); continue; }
        let unit = String(l.unit || '').trim(), factor = null;
        if (unit === m.item.unit) unit = '';
        if (unit && (isNew || !get('SELECT 1 AS x FROM item_units WHERE item_id = ? AND name = ?', m.item.id, unit))) {
          if (Number(l.per_unit) > 0) factor = n3(l.per_unit); // وحدة شراء جديدة: تنحفظ مع الشراء
          else { bad.push(`${m.item.name}: كم ${m.item.unit} في «${unit}»؟ (أرسلها في per_unit)`); continue; }
        }
        if (!(Number(l.qty) > 0)) { bad.push(`${m.item.name}: كم العدد؟`); continue; }
        const price = Number(l.unit_price) > 0 ? Number(l.unit_price) : null, total = Number(l.line_total) > 0 ? Number(l.line_total) : null;
        lines.push({ item: m.item, qty: n3(l.qty), unit, factor, isNew, unit_price: price, line_total: total });
      }
      if (bad.length) return { error: 'ناقص معلومات — اسأل الموظف', problems: bad, understood: lines.map(x => x.item.name) };
      if (!lines.length) return { error: 'وش الأصناف؟' };
      if (input.payment === 'credit' && !String(input.supplier || '').trim()) return { error: 'الآجل لازم له اسم المورد — اسأله' };
      const sum = lines.reduce((t, x) => t + (x.line_total || (x.unit_price || 0) * x.qty), 0);
      const PAY = { cash: 'من الدرج', custody: 'من عهدتي', card: 'بالبطاقة', paid: 'مدفوع برا الدرج', credit: 'آجل' };
      return card('purchase', `شراء${input.supplier ? ' من ' + input.supplier : ''} — ${PAY[input.payment] || PAY.cash}${date !== today ? ` (${date})` : ''}`,
        [...lines.map(x => `${x.isNew ? '🆕 ' : ''}${x.item.name}: ${x.qty} ${x.unit || x.item.unit}${x.factor ? ` (${x.factor} ${x.item.unit})` : ''}${x.unit_price ? ' × ' + x.unit_price : ''}${x.line_total ? ' = ' + x.line_total : ''}`), `المجموع ${C.r2(sum)}`],
        [{ endpoint: '/api/purchases', attach_image: ctx.images > 0, body: { date, supplier: input.supplier || '', payment: input.payment || 'cash', note: input.note || '',
          lines: lines.map(x => ({ ...(x.isNew ? { new_item: { name: x.item.name, unit: x.item.unit } } : { item_id: x.item.id }), qty: x.qty, unit: x.unit, ...(x.factor ? { factor: x.factor } : {}), unit_price: x.unit_price || '', line_total: x.line_total || '' })) } }]);
    }
    case 'propose_receive': {
      if (linkOnly(u, r)) return LINK_BLOCK(u, ctx);
      const pool = all("SELECT id, name, unit FROM items WHERE active = 1 AND kind = 'raw'");
      const sup = String(input.supplier || '').trim(); if (!sup) return { error: 'من أي مورد؟ اسأله' };
      const ok = [], bad = [];
      for (const l of input.lines || []) {
        const m = resolveItem(l.item, pool); const w = (l.weights || []).map(Number).filter(x => x > 0);
        if (m.err) { bad.push(`${m.err}${m.suggest && m.suggest.length ? ' — يمكن: ' + m.suggest.join('، ') : ''}`); continue; }
        if (!w.length) { bad.push(`${m.item.name}: كم الوزن؟ (صوّر الميزان)`); continue; }
        ok.push({ item: m.item, w, qty: n3(w.reduce((a, b) => a + b, 0)) });
      }
      if (bad.length || !ok.length) return { error: 'ناقص — اسأل الموظف', problems: bad };
      return card('receive', `📦 استلام من ${sup}${date !== today ? ` (${date})` : ''} — ينتظر الحساب`,
        ok.map(x => `${x.item.name}: ${x.w.length > 1 ? x.w.map(n3).join(' + ') + ' = ' : ''}${x.qty} ${x.item.unit}${x.w.length > 1 ? ` (${x.w.length} صور)` : ''}`),
        [{ endpoint: '/api/receive', attach_image: ctx.images > 0, body: { date, supplier: sup, note: input.note || '', lines: ok.map(x => ({ item_id: x.item.id, qty: x.qty })) } }]);
    }
    case 'propose_store_count': {
      if (!r.owner && !countByBot(u)) return LINK_BLOCK(u, ctx);
      const pool = all('SELECT id, name, unit, buy_store FROM items WHERE active = 1 AND buy_store = 1');
      const ok = [], bad = [];
      for (const l of input.lines || []) {
        const m = resolveItem(l.item, pool); const w = (l.weights || []).map(Number).filter(x => x >= 0);
        if (m.err) { bad.push(`${m.err} (الجرد اللي ورا للأصناف اللي شراها يروح ورا بس)`); continue; }
        const row = board().rows.find(x => x.item_id === m.item.id);
        if (!r.sup && (!row || !mine(row))) { bad.push(`${m.item.name} مو عليك`); continue; }
        if (!w.length) { bad.push(`${m.item.name}: كم الوزن؟`); continue; }
        ok.push({ item: m.item, w, qty: n3(w.reduce((a, b) => a + b, 0)) });
      }
      if (bad.length || !ok.length) return { error: 'ناقص', problems: bad };
      return card('store_count', '🧊 الموجود في الثلاجة اللي ورا', ok.map(x => `${x.item.name}: ${x.w.length > 1 ? x.w.map(n3).join(' + ') + ' = ' : ''}${x.qty} ${x.item.unit}`),
        [{ endpoint: '/api/warehouse/count', body: { date, counts: ok.map(x => ({ item_id: x.item.id, qty: x.qty })) } }]);
    }
    case 'match_invoice': {
      const RCV = require('./receive');
      const p = RCV.awaitingFor(input.supplier, isDate(input.date) ? input.date : null);
      if (!p) return { error: `ما فيه استلام ينتظر الحساب من «${input.supplier || ''}»${isDate(input.date) ? ' بتاريخ ' + input.date : ''} — يمكن انسجل شراء عادي؟` };
      const pool = all("SELECT id, name, unit FROM items WHERE active = 1");
      const inv = [], bad = [];
      for (const l of input.lines || []) { const m = resolveItem(l.item, pool); if (m.err) bad.push(m.err); else inv.push({ item_id: m.item.id, qty: n3(l.qty), unit_price: Number(l.unit_price) || 0 }); }
      if (bad.length || !inv.length) return { error: 'ما فهمت كل الأصناف', problems: bad };
      const cmp = RCV.compare(p.id, inv);
      const total = Number(input.total) > 0 ? C.r2(Number(input.total)) : C.r2(inv.reduce((t, l) => t + l.qty * l.unit_price, 0));
      return card('invoice', `🧾 حساب ${p.supplier || input.supplier} — استلام ${p.date}`,
        [...cmp.rows.map(x => x.text), `المجموع ${total} ريال`, cmp.owed > 0 ? `💰 لك عنده ≈ ${cmp.owed} ريال (الناقص)` : '👌 ما فيه ناقص علينا'],
        [{ endpoint: `/api/purchases/${p.id}/invoice`, body: { lines: inv, total } }]);
    }
    case 'propose_supplier_payment': {
      const sups = all('SELECT id, name FROM suppliers WHERE active = 1');
      const m = resolveItem(input.supplier, sups); if (m.err) return { error: m.err, suppliers: sups.map(x => x.name) };
      const amount = Number(input.amount); if (!(amount > 0)) return { error: 'كم المبلغ؟' };
      const PAY = { cash: 'من الدرج', custody: 'من عهدتي', card: 'بالبطاقة', paid: 'نوح دفع' };
      return card('supplier_pay', `💵 سداد لـ${m.item.name}${date !== today ? ` (${date})` : ''}`, [`${C.r2(amount)} ريال — ${PAY[input.payment] || PAY.custody}${input.note ? ' — ' + input.note : ''}`],
        [{ endpoint: `/api/suppliers/${m.item.id}/pay`, body: { date, amount: C.r2(amount), payment: input.payment || 'custody', note: input.note || '' } }]);
    }
    case 'propose_purchase_payment': {
      if (!isDate(input.date)) return { error: 'أي يوم؟' };
      const sup = String(input.supplier || '').trim();
      const ps = all("SELECT id, supplier, total, payment FROM purchases WHERE date = ? AND supplier LIKE ? ORDER BY id DESC", input.date, '%' + sup + '%');
      if (!ps.length) return { error: `ما لقيت شراء من «${sup}» يوم ${input.date}` };
      if (ps.length > 1) return { error: 'فيه أكثر من شراء — اسأله أي واحد (المبلغ)', found: ps.map(p => `${p.supplier} ${p.total} (${p.payment})`) };
      const PAY = { cash: 'من الدرج', custody: 'من عهدتي', card: 'بالبطاقة', paid: 'مدفوع برا الدرج', credit: 'آجل' };
      return card('purchase_pay', `✏️ تعديل شراء ${ps[0].supplier} يوم ${input.date}`, [`${C.r2(ps[0].total)} ريال: ${PAY[ps[0].payment] || ps[0].payment} ← ${PAY[input.payment] || input.payment}`],
        [{ endpoint: `/api/purchases/${ps[0].id}/payment`, body: { payment: input.payment } }]);
    }
    case 'suggest_change': {
      const SG = require('./suggestions');
      const summary = String(input.summary || '').trim(); if (!summary) return { error: 'وش الاقتراح؟' };
      const items = all('SELECT id, name, unit, opening_user_id, closing_user_id FROM items WHERE active = 1');
      const staff = all("SELECT id, name FROM users WHERE active = 1 AND bot = 0");
      let action = null;
      if (input.kind === 'item_responsible') {
        const m = resolveItem(input.item, items), e = resolveItem(input.employee, staff);
        if (m.err || e.err) return { error: m.err || e.err };
        const ph = input.phase === 'opening' ? 'opening' : input.phase === 'closing' ? 'closing' : null;
        const it = get('SELECT * FROM items WHERE id = ?', m.item.id);
        action = { requests: [{ endpoint: '/api/items', body: itemBody(it, ph ? { [ph + '_user_id']: e.item.id } : { opening_user_id: e.item.id, closing_user_id: e.item.id }) }] };
      } else if (input.kind === 'rename_item') {
        const m = resolveItem(input.item, items), nn = String(input.new_name || '').trim();
        if (m.err || !nn) return { error: m.err || 'وش الاسم الجديد؟' };
        const it = get('SELECT * FROM items WHERE id = ?', m.item.id);
        action = { requests: [{ endpoint: '/api/items', body: itemBody(it, { name: nn.slice(0, 80) }) }] };
      } else if (input.kind === 'count_fix') {
        const m = resolveItem(input.item, items), q = Number(input.qty);
        if (m.err || !(q >= 0) || !['opening', 'closing'].includes(input.phase)) return { error: m.err || 'ناقص: الصنف، أول/آخر الدوام، والرقم الصحيح' };
        action = { requests: [{ endpoint: '/api/count', body: { date: isDate(input.date) ? input.date : today, item_id: m.item.id, phase: input.phase, qty: n3(q) } }] };
      }
      // المالك نفسه: ينفذ على طول (ما يحتاج يوافق على نفسه)
      const id = SG.add(u, { kind: input.kind, summary, action });
      (ctx.suggestions = ctx.suggestions || []).push(id);
      const auto = require('./suggestions').auto();
      return { ok: true, id, note: auto ? (input.kind === 'feature' ? 'انحفظ للتطوير — نوح يراجعه آخر الأسبوع' : 'بيتنفذ على طول (نوح يراجع آخر الأسبوع) — قل له «اتسجل ✓»') : r.owner ? 'اتسجل — تنفذ بعد ما ترد «موافق ' + id + '»' : 'وصل الاقتراح لنوح — لو وافق ينفذ لحاله. قل للموظف إنه وصل.' };
    }
    case 'learn': {
      const KB = require('./kb'); const t = String(input.text || '').trim(); if (!t) return { error: 'وش أحفظ؟' };
      if (r.sup) { const id = KB.add({ topic: input.topic, text: t, by: u.id, source: r.owner ? 'owner' : 'sup', replaces: input.replaces || null }); return { ok: true, id, note: 'انحفظت في دليل المطعم — قل له «حفظتها»' }; }
      const id = require('./suggestions').add(u, { kind: 'learn', summary: `📘 ${t}`, action: { learn: { topic: input.topic, text: t, replaces: input.replaces || null, source: 'worker' } } });
      (ctx.suggestions = ctx.suggestions || []).push(id);
      return { ok: true, note: require('./suggestions').auto() ? 'انحفظت في الدليل على طول (نوح يراجعها آخر الأسبوع) — قل له شكرًا، حفظتها' : 'وصلت لنوح يعتمدها في الدليل — قل للموظف شكرًا، وصلت' };
    }
    case 'remind_staff': {
      const text = String(input.text || '').trim().slice(0, 1000); if (!text) return { error: 'وش الرسالة؟' };
      const staff = all("SELECT id, name, phone FROM users WHERE active = 1 AND bot = 0 AND role != 'owner'");
      let ids = [];
      if (input.who === 'names') {
        const bad = [];
        for (const n of input.names || []) { const m = resolveItem(n, staff); if (m.err) bad.push(m.err); else ids.push(m.item.id); }
        if (bad.length) return { error: 'ما عرفت بعض الأسماء', problems: bad };
      } else {
        const ph = input.who === 'missing_opening' ? 'opening' : 'closing';
        ids = board().rows.filter(x => ph === 'opening' ? x.opening == null && !x.no_opening : x.closing == null).map(x => x[ph + '_user_id']);
      }
      const people = [...new Set(ids)].map(id => staff.find(x => x.id === id)).filter(Boolean);
      if (!people.length) return { error: input.who === 'names' ? 'ما فيه أحد' : 'ما فيه أحد باقي عليه — كلهم جردوا 👍' };
      const noPhone = people.filter(x => !x.phone).map(x => x.name), go = people.filter(x => x.phone);
      if (!go.length) return { error: `ما لهم جوال مسجل: ${noPhone.join('، ')}` };
      return card('remind', `📩 رسالة في الخاص لـ${go.length}`, [go.map(x => x.name).join('، '), `«${text}»`, ...(noPhone.length ? [`⚠️ بدون جوال: ${noPhone.join('، ')}`] : [])],
        [{ endpoint: '/api/whatsapp/remind', body: { user_ids: go.map(x => x.id), text } }]);
    }
    case 'remember': {
      if (input.action === 'show') return { saved: memOf(u) || '(ما فيه شي محفوظ)' };
      if (input.action === 'clear') { run('DELETE FROM private_notes WHERE key = ?', memKey(u)); return { ok: true, note: 'انمسح كل المحفوظ' }; }
      const t = String(input.text || '').trim().slice(0, 500); if (!t) return { error: 'وش أحفظ؟' };
      const body = [memOf(u), '• ' + t].filter(Boolean).join('\n').slice(-3000);
      run("INSERT INTO private_notes(key, body, updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at", memKey(u), body);
      return { ok: true, note: 'انحفظت — بتتطبق في كل محادثة جاية معه' };
    }
    case 'propose_split': {
      const srcs = all('SELECT id, name, unit FROM items WHERE active = 1 AND id IN (SELECT item_id FROM item_splits)');
      const m = resolveItem(input.source, srcs); if (m.err) return { error: m.err, can_split: srcs.map(x => x.name) };
      const outs = all('SELECT i.id, i.name, i.unit FROM item_splits s JOIN items i ON i.id = s.out_item_id WHERE s.item_id = ? AND i.active = 1 ORDER BY s.sort', m.item.id);
      const q = Number(input.qty);
      if (!(q > 0) || !(input.outputs || []).length) return { error: `اسأله: كم ${m.item.name} قسم، وكم طلع من كل واحد`, outputs: outs.map(x => `${x.name} (${x.unit})`) };
      const ok = [], bad = [];
      for (const o of input.outputs) { const r2 = resolveItem(o.item, outs); if (r2.err || !(Number(o.qty) > 0)) bad.push(r2.err || `${o.item}: كم؟`); else ok.push({ item: r2.item, qty: n3(o.qty) }); }
      if (bad.length || !ok.length) return { error: 'ناقص', problems: bad, outputs: outs.map(x => x.name) };
      return card('split', `🔪 تقسيم ${n3(q)} ${m.item.unit} ${m.item.name}`, ok.map(x => `${x.item.name}: ${x.qty} ${x.item.unit}`),
        [{ endpoint: '/api/split', body: { date, item_id: m.item.id, qty: n3(q), outputs: ok.map(x => ({ item_id: x.item.id, qty: x.qty })) } }]);
    }
    case 'propose_expense': {
      const amount = Number(input.amount); if (!(amount > 0)) return { error: 'كم المبلغ؟' };
      const pay = ['cash', 'custody', 'card', 'paid'].includes(input.payment) ? input.payment : input.from_cash ? 'cash' : null;
      const PAYW = { cash: 'من الدرج', custody: 'من عهدتي', card: 'بالبطاقة', paid: 'مدفوع برا' };
      return card('expense', `مصروف: ${input.category || ''}`, [`${C.r2(amount)} ريال${pay ? ' — ' + PAYW[pay] : ''}${input.note ? ' — ' + input.note : ''}`],
        [{ endpoint: '/api/expenses', body: { date: today, amount: C.r2(amount), category: input.category || '', note: input.note || '', paid_from_cash: pay === 'cash', ...(pay ? { payment: pay } : {}) } }]);
    }
    case 'propose_custody': {
      const amount = Number(input.amount); if (!(amount > 0)) return { error: 'كم المبلغ؟' };
      const give = input.type !== 'return';
      return card('custody', give ? '👛 استلمت عهدة' : '👛 رجّعت من العهدة', [`${C.r2(amount)} ريال${input.from_drawer ? (give ? ' — من الدرج' : ' — للدرج') : ''}${input.note ? ' — ' + input.note : ''}`],
        [{ endpoint: '/api/custody', body: { user_id: u.id, date: today, amount: C.r2(amount), type: give ? 'give' : 'return', from_drawer: !!input.from_drawer, note: input.note || '' } }]);
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
    case 'count_guide': ctx.guide = 1; return { ok: true, note: 'الدليل ينضاف لردك لحاله — قل جملة قصيرة لطيفة بس، ولا تعيد خطواته' };
    case 'my_custody': {
      if (!deps.custodyView) return { error: 'مو متاح' };
      const v = deps.custodyView(u.id, { limit: 10 });
      return { received: v.given, returned: v.returned, spent: v.spent, balance: v.balance, no_photo: v.no_photo, unconfirmed: v.unconfirmed.length,
        last: v.entries.map(e => ({ date: e.date, kind: { give: 'استلم', return: 'رجّع', buy: 'شراء', supplier: 'سداد مورد', spend: 'مصروف' }[e.kind] || e.kind, amount: e.amount, note: e.note, balance: e.balance })) };
    }
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
        difference: x.diff, meaning: x.diff == null ? 'الجرد ما اكتمل' : x.diff > 0 ? 'نقص' : x.diff < 0 ? 'زيادة' : 'مضبوط', ...(r.sales ? { value: x.diff_value } : {}), opener: x.opening_user, closer: x.closing_user, moves, ...(r.sales ? { sold_by_product: sold } : {}) };
    }
    case 'count_board': {
      const b = runTool('count_board', input, today);
      if (r.sup) return b;
      b.rows = b.rows.filter(x => x.opener === u.name || x.closer === u.name).map(({ should_use, used, shortage, shortage_value, ...rest }) => rest);
      return b;
    }
    case 'prices': { const IN = require('./insights'); const q = String(input.item || '').trim(); return IN.purchasePrices(today).filter(x => !q || x.name.includes(q)).slice(0, 40); }
    case 'item_info':
      const out = runTool('item_info', input, today);
      if (r.onlyPurch && out.found && out.kind !== 'خام') return { found: false, hint: 'هذا صنف تحضير' };
      if (out.found && !r.recipes) delete out.used_in; // الوصفات لمن له صلاحية الوصفات بس
      // 🔒 الوصفة السرّية (مثل الرز): للمالك والمسؤول عن الصنف (فاتح/مقفل/محضّر/صاحب القسم) بس
      if (out.found) {
        const it = get('SELECT i.*, s.opening_user_id AS s_open, s.closing_user_id AS s_close FROM items i LEFT JOIN sections s ON s.id = i.section_id WHERE i.name = ? AND i.active = 1', out.name);
        const raw = it && (get('SELECT body FROM private_notes WHERE key = ?', 'recipe:' + it.id) || {}).body;
        let secret = raw, users = null;
        if (raw && raw.startsWith('{')) { try { const j = JSON.parse(raw); secret = j.text; users = (j.users || []).map(Number); } catch { /* نص عادي */ } }
        const allowed = users ? users.includes(u.id) : [it.opening_user_id, it.closing_user_id, it.prep_user_id, it.s_open, it.s_close].includes(u.id);
        if (secret && (r.owner || allowed)) out.secret_recipe = secret;
      }
      return out;
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
- فاتورة فيها صنف مو في النظام: اسأله «أضيفه صنف جديد؟ وش وحدته؟» وبعدها new_unit. وحدة شراء جديدة (كيس، كرتون): per_unit = كم وحدة أساسية فيها.
- الفاتورة في أكثر من صورة: كلها توصلك مع بعض — جهّز كرت لكل فاتورة.
- «قسم الذبيحة» أو «فكيت كرتون»: propose_split — اسأله كم قسم/فك وكم طلع (الكرتون عدده يختلف: اسأله كم حبة فيه بالضبط).
- كل موظف له «طريقة شغل أصنافه» تحت — امشِ عليها واسأله على حسبها. لو كتب كلمة ورجع صحّحها، اعتمد الأخيرة.
- الصنف اللي جرده على أجزاء (كامل/مقطّع، ني/مستوي): اسأله كل جزء لحاله وأرسلها في parts.
- أنواع الجرد: السمك والسحاوق والبيبسي «يبدأ من آخر أمس» — لا تطلب جرد أول اليوم (إلا لو «آخر أمس ما انجرد»). اللي يسويه زيادة وسط اليوم أو يعبّي الثلاجة من فوق: «+ أضفت» (propose_move pull/prep). الفتة والإيدام: أول اليوم = كم انطبخ، والباقي آخر اليوم يترمى.
- المشرف يبغى يذكّر أو يبلغ موظفين: remind_staff. «احفظ/تذكر الطريقة»: remember.
- لو غيّرت رأيك عن كرت قبل، أو الكرت غلط: الكرت القديم ينلغى لحاله — جهّز كرت جديد صحيح أو قل له إنه انلغى.
- «دليل المطعم» تحت: هو علمك عن شغل المحل — امشِ عليه. لما أحد يشرح لك طريقة شغل، أو يصحح فهمك («لا، الطريقة كذا»)، أو تفهم قاعدة جديدة: احفظها بـ learn (لو تصحح معلومة في الدليل حط رقمها في replaces). لا تحفظ أرقام يوم معيّن ولا مبالغ ولا رواتب ولا أسرار.
- درجات التنفيذ — شغلك تمشّي الشغل وتصلح اللي يتماشى مع مصلحة المطعم:
  ✅ الشي العادي اللي في أدواتك (شراء، جرد الموظف نفسه، صنف/وحدة جديدة من فاتورة، تذكير، تقسيم): جهّزه على طول وخله يأكد.
  🟡 أي شي يأثر كثير (مسؤول صنف، اسم صنف، جرد يوم فات أو جرد موظف ثاني، فلوس، وصفة، صلاحيات): لا تنفذه — suggest_change يوصل لنوح يوافق.
  ✂️ الخصم: لو عندك أداة deduct والمالك أو المشرف قال «اخصم/سجل خصم على فلان» نفّذه فيها على طول — لا تحطه في report_problem ولا suggest_change. لو ما عندك الأداة قل «الخصم لنوح ومشرفين المحل بس».
  💡 الموظف يقترح شي يحسّن النظام نفسه (ميزة، طريقة أسهل): suggest_change بنوع feature.
  ❌ لا تقبل شي يغطي نقص أو يغيّر رقم لمصلحة الموظف بدون سبب واضح — بلّغ نوح.

طريقة الرد:
- رد بنفس لغة الموظف (عربي، إنجليزي، بنغالي، هندي، أوردو…). أسماء الأصناف اكتبها بالعربي زي ما هي في النظام.
- بالعربي: اللهجة السعودية البسيطة، قصير وواضح — الكل مو محاسبين.
- استخدم الأدوات تجيب الأرقام. لا تخترع رقم أبدًا. إذا الأداة رجعت فاضي قل «ما عندي بيانات لهذا».
- المبالغ بالريال. اذكر التاريخ اللي تتكلم عنه.
- إذا السؤال عام عن إدارة المطاعم (تسعير، نسبة تكلفة الأكل، الهالك) جاوب من خبرتك العامة وقل إنها نصيحة عامة.
- رتّب الرد بنقاط قصيرة إذا فيه أكثر من رقم.
- أنت زميل يساعدهم، مو مدير عليهم: كلامك محترم ولطيف. لو الموظف عنده مشكلة (في النظام، أرقامه مو مضبوطة، لخبطة في الجرد، ما يعرف يسجل، أو مشكلة في الشغل) استعمل report_problem عشان توصل لنوح، وطمّنه إنها وصلت، وساعده باللي تقدر.
 - كل موظف يسوي شغله بأدواته: لا تحوّل لنوح ولا تسوي اقتراح (suggest_change) لشي الموظف يقدر يسويه بنفسه — شراء، سداد مورد، تعديل طريقة دفع شراءه، جرد، حركة. الاقتراح بس للي ما له أداة ولا صلاحية.
 - لا تقول إنك أرسلت أو وصّلت شي لنوح إلا لو ناديت أداة سوّت كذا فعلًا (report_problem، suggest_change، learn…). لو ما سويت، قل «بأرسلها له» وسوّها.
 - لا تقول «اتسجل/تم/انخصم» إلا لو الأداة اللي تسويه رجعت ok. لو طلبوا منك شي له أداة: نفّذه، لا تحوّله لـ report_problem.
 - صورة ميزان من الموظف لصنف عليه وله «by_weight» في count_board = جرده: اعرف الطبق من شكله، واقرأ الوزن، وجهز propose_count بـ unit «كجم» — بدون ما تسأله كم نفر.
 - 🔁 المشتريات الثابتة كل يوم (لحوح أم محمد والصفا، حبش، الكدر والكبان) تنسجل لحالها أول اليوم باسم زكريا (ملاحظتها «ثابت يومي») — لا تسجلها مرة ثانية ولا تسأل عنها. لو قال اليوم غير (كمية/سعر/ما جا): قل له يعدّلها من المشتريات في الموقع، أو بلّغ نوح.
 - «مطفي فارس» = «مطفي صرع» (الفارس هو الصرع) — سجله على مطفي صرع.
 - 🍯 قارورة عسل السلام (الصبح، التعبئة، آخر الدوام) من الرابط بس — خانة 🍯 بالصورة. لو أرسلها هنا قله يدخلها من الرابط.
 - 📲 الجرد (أول/آخر الدوام، الباقي، جرد اللي ورا، صورة ميزان للباقي) ما يتسجل هنا — من الرابط بس (تلقاه في أول الرسالة)، إلا لو أول الرسالة قال إنه «مسموح له يجرد من هنا» فجهّز له كرت الجرد عادي. لو أرسل جرد: رد بسطر لطيف فيه الرابط، ولا تجهز كرت جرد ولا تسأل عن الأصناف ولا عن نوع السمك. لو ما عرف (سأل كيف، الرابط ما فتح، ما فهم) ناد count_guide. صورة الميزان للاستلام (سمك وصل) و«أضفت/طبخت/سويت» تقعد هنا عادي. ولو عنده مشكلة (صورة أو شرح) ارفعها بـ report_problem.
 - 👛 العهدة: «من عهدتي» = payment custody (شراء، مصروف، سداد). أي صرف من العهدة لازم يكون فيه وش انشرى وفين (المحل/المورد) — لو ما قالها اسأله سؤال واحد، واطلب صورة الفاتورة لو فيه (مو شرط). «استلمت عهدة» / «رجّعت» = propose_custody، و«كم باقي في عهدتي» = my_custody.
 - 🐟 نوع السمك (وأي صنف بالكيلو يشبه غيره) ما تعرفه من الصورة أبد — السمك على الميزان كله شكل واحد. خذه من كلامه بس (صوت/كتابة/تعليق الصورة). لو ما قال: لا تجهز كرت، اسأله سؤال واحد بأصنافه مرقّمة («وش السمك؟ ١ حريد ٢ هامور ٣ فارس…») ورده برقم أو اسم يكفي. الاسم المكسّر من الصوت («حاري»، «هامر») = أقرب صنف من أصنافه.
 - «طلعته/خرّجته/نزّلته من ورا (للعرض/لبرا)» = propose_move بـ pull (للعرض)، مو propose_store_count. جرد اللي ورا بس لو قال «الباقي ورا» أو «الموجود ورا» أو «جرد ورا». لو محتار: pull وقل «لو هذا جرد اللي ورا قول لي».
 - «صنف + رقم» (مثل «بيبسي 117») بدون كلمة «أضفت/زودت/طلعت من فوق/نزّلت» = جرد: الصبح أول الدوام، وبعد المغرب آخر الدوام. «أضفت» (propose_move) بس لو قالها صراحة.
 - صورة ميزان بعد المغرب = جرد آخر الدوام على طول — لا تسأله «زودت ولا آخر الدوام؟». لو غلط بيصحح لك.
 - سؤال واحد بالكثير في الرد، وما تعيد نفس السؤال. لو مو متأكد: جهّز الكرت بأقرب فهم وقل «لو غلط قول لي». الكلام الصوتي يجي مكسّر — خذ المعنى العام ولا تسأل عن كل كلمة.
 - لو زعل أو سبّ: اعتذار بسطر واحد بس، وكمّل الشغل (لا تكرر الاعتذار ولا الأرقام).
 - «أنا غايب» أو «فلان غايب»: mark_absent. واللي يغطي عن الغايب (مثلًا سوّى سمكه) جهّز له جرد أصناف الغايب عادي.
 - «secret_recipe» في item_info وصفة سرّية: تعطيها بس للي طلعت له، ولا تذكر إنها موجودة لغيره.
 - الكرت يقعد ينتظر «تمام» حتى لو سألته سؤال ثاني — لا تقول إنه انلغى إلا لو جهزت كرت بداله.`;

// 🧠 أي نموذج: القوي للشغل المهم (صور/فواتير، فلوس، جرد، مشاكل، المالك والمشرفين)، والسريع للسوالف والأسئلة الخفيفة
// القوي هو الأساس — السريع بس للسلام/الشكر القصير وما فيه محادثة شغالة (الرد القصير وسط شغل: «ايوه»، «لا»… يحتاج يفهم السياق)
// 💰 الرخيص هو الأساس: العمال على السريع (Haiku بتفكير أعلى)، والصور والملفات على المتوسط (Sonnet)، والمالك والمشرفين على المتوسط
// 💰 الحين: الرخيص (Haiku) للكل حتى الصور — ولو ما قدر يجاوب يعيد مرة بـ Sonnet (Opus بس بزر «تحليل عميق» من المالك)
function pickTier() { return 'fast'; }
// 💰 كاش للمحادثة بين دورات الأدوات: آخر رسالة تنحط عليها علامة الكاش (والقديمة تنشال — أقصى ٤ علامات)
function markCache(messages) {
  for (const m of messages) if (Array.isArray(m.content)) for (const b of m.content) if (b && b.cache_control) delete b.cache_control;
  const last = messages[messages.length - 1];
  if (!last) return;
  if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
  const b = last.content[last.content.length - 1];
  if (b && b.type !== 'thinking' && b.type !== 'redacted_thinking') b.cache_control = { type: 'ephemeral' };
}

function checkDaily(u) {
  if (ROLE(u).owner) return;
  const cap = Number(require('./db').getSetting('ai_user_daily', '100')) || 0;
  if (cap && get("SELECT COUNT(*) AS n FROM ai_log WHERE user_id = ? AND kind = 'ask' AND at >= datetime('now', '-1 day')", u.id).n >= cap)
    throw Object.assign(new Error(`وصلت حد الأسئلة اليومي — كمّل بكرة، وجردك اكتبه في البرنامج`), { status: 400, cap });
}

// 📲 الجرد من الرابط (الموقع) — البوت ما يستلم جرد إلا من المالك
const cookSrc = id => get('SELECT 1 AS x FROM item_splits WHERE out_item_id = ? LIMIT 1', id) ? 'fridge' : 'cook'; // ناتج تقسيم (حنيذ/برم): من المقسوم فوق
const countLink = () => (require('./db').getSetting('site_url', '') || 'https://62-238-61-5.sslip.io').replace(/\/+$/, '') + '/#/count';
// (قديم) الجرد من البوت — مطفي افتراضيًا، إلا للكل (wa_count_bot) أو لموظفين معيّنين (wa_count_bot_users: [8] = فؤاد)
const countByBot = u => { const { getSetting } = require('./db'); if (getSetting('wa_count_bot', '0') === '1') return true;
  try { return !!u && JSON.parse(getSetting('wa_count_bot_users') || '[]').map(Number).includes(u.id); } catch { return false; } };
// 📖 الدليل: ينرسل بس لو ما عرف (سأل كيف، أو رجع يرسل جرد هنا ثاني مرة باليوم)
const GUIDE = () => `📖 *طريقة الجرد من الرابط:*
١- اضغط الرابط: ${countLink()}
٢- اختر اسمك، واكتب رقمك السري (نسيته؟ اسأل المشرف).
٣- فوق فيه زرين: «أول الدوام» للصبح، و«آخر الدوام» للّيل.
٤- قدام كل صنف خانة. الرقم الرمادي مكتوب جاهز: لو هو نفس الموجود خلّه، ولو غير اكتب الصح. السمك والإيدام: حطه على الميزان واكتب الوزن.
٥- آخر شي اضغط «✓ خلصت» — لما يطلع «خلصت ✓» بالأخضر يعني انحفظ.

• زوّدت أو نزّلت من الثلاجة أو طبخت؟ اضغط «+ أضفت» واكتب الكمية.
• خرب أو طاح؟ «🗑️ انرمى».
• 🔊 جنب الاسم: اضغطه ويقول لك اسم الصنف.
• غلطت في رقم؟ كلّم المشرف يعدّله.
ما فتح معك؟ صوّر الشاشة وأرسلها هنا 🙏`;
function linkAgain(u, ctx) {
  const { getSetting, setSetting } = require('./db');
  let st = {}; try { st = JSON.parse(getSetting('count_link_sent') || '{}'); } catch { /* */ }
  if (st.date !== ctx.today) st = { date: ctx.today, ids: [] };
  if (st.ids.includes(u.id)) { ctx.silent = 1; return true; } // الرابط وصله اليوم — نسكت (ما نعيد عليه)
  st.ids.push(u.id); setSetting('count_link_sent', JSON.stringify(st)); return false;
}
// 🚫 العامل (إلا اللي مسموح له: فؤاد) ما يسجّل له البوت جرد ولا استلام ولا أضفت — الرابط مرة باليوم وبعدها سكوت
const linkOnly = (u, r) => !r.owner && !r.sup && !r.purch && !countByBot(u);
const LINK_BLOCK = (u, ctx) => linkAgain(u, ctx) ? { error: 'هذا من الرابط والرابط وصله اليوم — لا ترد عليه بشي (النظام ساكت)' } : { error: 'هذا ما يتسجل هنا — من الرابط بس: ' + countLink(), link: countLink(), say: LINK_MSG() };
const LINK_MSG = () => `الجرد صار من الرابط 👇\n${countLink()}\nافتحه، اختر اسمك، واكتب الرقم قدام كل صنف — ينحفظ لحاله ✓`;
// الأدوات اللي تكتب على طول (مو كرت) — غيرها ما ينحفظ إلا بـ«تمام»
const NOW_TOOLS = new Set(['deduct', 'honey_bottle', 'report_problem', 'mark_absent', 'set_reminder', 'suggest_change', 'learn', 'remind_staff', 'remember']);
const CLAIM = /(?<![\u0600-\u06FF])(?<!ما )(?<!ما\s)(سجّ?لت(?:ه|ها|هم|لك)?|اتسجّ?ل(?:ت)?|انسجّ?ل(?:ت)?|انحفظ(?:ت)?|حفظت(?:ه|ها|هم)?|تم التسجيل|تم الحفظ|(?:وصّ?لت|أرسلت|ارسلت|رفعت)(?:ه|ها|هم)? ل?نوح)(?![\u0600-\u06FF])/;
function falseClaim(answer, tools) {
  if ((tools || []).some(t => NOW_TOOLS.has(t))) return '';
  const m = CLAIM.exec(String(answer || '')); return m ? m[1] : '';
}

async function ask(u, question, history = [], { detailed = false, images = [] } = {}) {
  question = String(question || '').trim().slice(0, 2000);
  const imgs = (Array.isArray(images) ? images : []).slice(0, 6).map(d => /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/s.exec(d || '')).filter(Boolean);
  const pdfs = (Array.isArray(images) ? images : []).slice(0, 3).map(d => /^data:application\/pdf;base64,(.+)$/s.exec(d || '')).filter(Boolean); // فاتورة PDF من الواتساب
  if (!question && !imgs.length && !pdfs.length) throw Object.assign(new Error('اكتب سؤالك'), { status: 400 });
  if (!question) question = 'شوف الصور';
  AI.checkCap();
  checkDaily(u);
  const today = C.businessDate();
  const wd = F.WEEKDAYS[new Date(today + 'T00:00:00Z').getUTCDay()];
  // المحادثة اللي قبل: نص بس — آخر 4 رسايل قصيرة (عشان «ايوه» و«الثاني» تنفهم، بدون ما نرسل السجل كله كل مرة)
  const past = (Array.isArray(history) ? history : []).slice(-4)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim())
    .map(m => ({ role: m.role, content: String(m.text).slice(0, 400) }));
  while (past.length && past[0].role !== 'user') past.shift();
  const R = ROLE(u);
  const who = R.owner ? 'المالك' : R.sup ? 'مشرف' : R.onlyPurch ? 'مسؤول المشتريات' : 'موظف';
  const mem = R.sup ? memOf(u) : '';
  // طريقة شغل أصناف هالموظف (الملاحظة + أجزاء الجرد) — عشان يفهم وش يسأله
  const how = all(`SELECT i.name, i.unit, i.note, i.parts FROM items i LEFT JOIN sections s ON s.id = i.section_id WHERE i.active = 1 AND (i.note != '' OR i.parts != '')
    AND (i.opening_user_id = ? OR i.closing_user_id = ? OR i.prep_user_id = ? OR s.opening_user_id = ? OR s.closing_user_id = ?) LIMIT 30`, u.id, u.id, u.id, u.id, u.id)
    .map(i => { let p = null; try { p = i.parts ? JSON.parse(i.parts) : null; } catch { /* */ } return `• ${i.name} (${i.unit})${i.note ? ': ' + i.note : ''}${p && p.length ? ` — جرد آخر اليوم: ${p.map(x => x.name + (x.factor !== 1 ? '×' + x.factor : '') + (x.drop ? ' (يترمى)' : '')).join(' + ')}` : ''}`; }).join('\n');
  const first = `اليوم (يوم العمل): ${today} — ${wd}. اللي يكلمك: ${u.name} (${who}). ${countByBot(u) && !R.owner ? `${u.name} مسموح له يجرد من هنا (الواتساب) — جهّز كرت الجرد عادي.` : `رابط الجرد: ${countLink()}.`}${imgs.length ? ` أرفق ${imgs.length} صورة.` : ''}${pdfs.length ? ` أرفق ${pdfs.length} ملف PDF.` : ''}${mem ? `\n\nتعليمات ${u.name} المحفوظة (طبّقها):\n${mem}` : ''}${how ? `\n\nطريقة شغل أصنافه:\n${how}` : ''}\n\n${question}`;
  const content = [...imgs.map(m => ({ type: 'image', source: { type: 'base64', media_type: m[1] === 'jpg' ? 'image/jpeg' : 'image/' + m[1], data: m[2] } })),
    ...pdfs.map(m => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: m[1] } })), { type: 'text', text: first }];
  const toolset = toolsFor(u), allowed = new Set(toolset.map(t => t.name));
  const kbText = require('./kb').frozen(); // 📘 دليل المطعم: نسخة ثابتة تتحدث الفجر بس (عشان الكاش ما ينكسر وسط الشغل)
  let cost = 0, tools = [], ctx;
  const use = { calls: 0, in: 0, cw: 0, cr: 0, out: 0, img: imgs.length + pdfs.length }; // 📊 كم توكن راح (عشان نعرف وين الفلوس)
  const loop = async (tier, warn = '') => {
    ctx = { today, actions: [], images: imgs.length };
    const messages = [...past, { role: 'user', content: warn ? [...content, { type: 'text', text: warn }] : content }];
    for (let round = 0; round < 4; round++) {
      markCache(messages);
      const res = await AI.create(tier, {
        max_tokens: deep ? 6000 : 1000,
        // 💰 system = التعليمات + الدليل بس (ثابتين — التاريخ واللي يكلمك في الرسالة) بالكاش ٥ دقايق (كتابته ×1.25 بدل ×2 للساعة)
        system: [{ type: 'text', text: SYSTEM }, { type: 'text', text: kbText, cache_control: { type: 'ephemeral' } }],
        tools: toolset, messages,
      }, { kind: 'ask', userId: u.id, imgKind: 'doc', maxOut: deep ? 6000 : 1000, manual: deep });
      cost += AI.costOf(res.usage, tier);
      { const x = res.usage || {}; use.calls++; use.in += x.input_tokens || 0; use.cw += x.cache_creation_input_tokens || 0; use.cr += x.cache_read_input_tokens || 0; use.out += x.output_tokens || 0; }
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
        return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out).slice(0, 8000) };
      }) });
    }
    return '';
  };
  const deep = !!detailed && R.owner; // 🔬 Opus: بس المالك بضغطة زر
  let tier = deep ? 'strong' : pickTier();
  let answer = await loop(tier);
  // السريع ما قدر => نعيد بالقوي (من أول — التفكير مربوط بالنموذج)
  if (tier === 'fast' && !ctx.actions.length && (!answer || /ما أعرف|ما أقدر أحدد|لا أعرف/.test(answer))) { tier = 'mid'; tools = []; answer = await loop(tier); }
  // 🚫 «سجلت» وهو ما سجل: ما فيه شي ينحفظ إلا بالكرت و«تمام» (أو أداة تكتب على طول) — نعيد مرة بتنبيه، وإلا نحط تنبيه
  if (answer && falseClaim(answer, tools)) {
    const t0 = tools;
    tools = []; answer = await loop(tier, `(تنبيه من النظام: ردك قال «${falseClaim(answer, t0)}» وما انسجل شي. ما ينسجل شي إلا بكرت والموظف يرد «تمام». لا تقول سجلت/انحفظ/وصلت لنوح — لو فيه شي يتسجل جهّز كرته، ولو يبغى يوصل لنوح استعمل الأداة.)`);
    tools = [...new Set([...t0, ...tools])];
    if (answer && falseClaim(answer, tools)) answer = '⚠️ ما انسجل شي للحين.\n' + answer;
  }
  if (ctx.say && ctx.say.length) answer = ctx.say.join('\n\n');
  if (ctx.guide && !answer.includes('طريقة الجرد من الرابط')) answer = (answer ? answer + '\n\n' : '') + GUIDE();
  answer = answer || (ctx.actions.length ? 'شيك الكرت واضغط «تأكيد».' : 'ما قدرت أطلع جواب — جرّب تسأل بطريقة ثانية.');
  AI.log(u.id, 'ask', question + (imgs.length ? ` [${imgs.length} صورة]` : '') + (pdfs.length ? ` [${pdfs.length} PDF]` : ''), answer, cost, AI.MODELS[tier].id, use);
  return { answer, cost: Math.round(cost * 10000) / 10000, model: tier, usage: use, tools: [...new Set(tools)], actions: ctx.actions, report: ctx.report || null, notify: ctx.notify || [], silent: !!ctx.silent && !ctx.actions.length, suggestions: ctx.suggestions || [] };
}

// ===== ملخص اليوم وتوصيات بكرة (Opus، مرة لكل يوم، ينحفظ) =====
function saved(date, kind) { return get('SELECT * FROM ai_summaries WHERE date = ? AND kind = ?', date, kind) || null; }
function save(date, kind, text, cost) {
  run('INSERT INTO ai_summaries(date, kind, text, cost, at) VALUES(?,?,?,?,datetime(\'now\')) ON CONFLICT(date, kind) DO UPDATE SET text = excluded.text, cost = ai_summaries.cost + excluded.cost, at = excluded.at', date, kind, text, cost);
  return saved(date, kind);
}

async function oneShot(u, kind, date, prompt, data) {
  AI.checkCap();
  const res = await AI.create('fast', {
    max_tokens: 3000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `${prompt}\n\nالبيانات (JSON):\n${JSON.stringify(data).slice(0, 60000)}` }],
  }, { kind, userId: u.id });
  const cost = AI.costOf(res.usage, 'fast');
  const text = AI.textOf(res) || 'ما طلع شي.';
  AI.log(u.id, kind, date, text, cost, AI.MODELS.fast.id);
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

module.exports = { falseClaim, pickTier, markCache, memOf, canSplit, ask, summary, recommendations, runTool, TOOLS, saved, deps, toolsFor, resolveItem };
