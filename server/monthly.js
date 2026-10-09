'use strict';
// تقرير الشهر للمحاسب: الملخص + كل يوم + المشتريات + المصروفات + سداد الموردين + الرواتب + مبيعات الأصناف
const { all, get } = require('./db');
const C = require('./calc');
const X = require('./xlsx');

const PAYMENT = { cash: 'من الدرج', paid: 'مدفوع برا الدرج', credit: 'آجل' };
const PAY = { salary: 'راتب', advance: 'سلفة/سحب', settle: 'صرف الباقي', bonus: 'مكافأة', deduct: 'خصم' };

function monthRange(month) {
  const from = month + '-01';
  const to = C.addDays(C.addDays(from, 32).slice(0, 7) + '-01', -1);
  return { from, to };
}

function monthlyReport(month) {
  const { from, to } = monthRange(month);
  const today = C.businessDate();
  const last = to < today ? to : today;
  const days = [];
  for (let d = from; d <= last; d = C.addDays(d, 1)) {
    if (!get('SELECT 1 AS x FROM sales WHERE date = ? UNION SELECT 1 FROM purchases WHERE date = ? UNION SELECT 1 FROM expenses WHERE date = ? LIMIT 1', d, d, d)) continue;
    const m = C.dailyReport(d).money;
    days.push({ date: d, loyverse: m.loyverse_total, ticket: m.ticket_total, sales: m.total_sales, discounts: m.discounts, cash: m.cash_payments, card: m.card_payments,
      counted_cash: m.counted_cash, cash_shortage: m.cash_shortage, cogs: m.cogs, purchases: m.purchases_total, expenses: m.expenses_total,
      shortage: m.inventory_shortage_value, waste: m.waste_value, closed: !!get('SELECT 1 AS x FROM day_status WHERE date = ?', d) });
  }
  const purchases = all(`SELECT p.*, u.name AS user FROM purchases p LEFT JOIN users u ON u.id = p.user_id WHERE p.date BETWEEN ? AND ? ORDER BY p.date, p.id`, from, to)
    .map(p => ({ ...p, items: all('SELECT i.name, l.qty, i.unit, l.unit_price FROM purchase_lines l LEFT JOIN items i ON i.id = l.item_id WHERE purchase_id = ?', p.id) }));
  const expenses = all('SELECT e.*, u.name AS user FROM expenses e LEFT JOIN users u ON u.id = e.user_id WHERE e.date BETWEEN ? AND ? ORDER BY e.date, e.id', from, to);
  const supPay = all('SELECT sp.*, s.name AS supplier FROM supplier_payments sp JOIN suppliers s ON s.id = sp.supplier_id WHERE sp.date BETWEEN ? AND ? ORDER BY sp.date', from, to);
  const payroll = all(`SELECT p.*, u.name FROM payroll p JOIN users u ON u.id = p.user_id WHERE (p.type = 'salary' AND p.month = ?) OR (p.type != 'salary' AND p.date BETWEEN ? AND ?) ORDER BY u.name, p.date`, month, from, to);
  const costs = C.itemCostMap(), recipes = C.recipeMap();
  const products = all(`SELECT p.id, p.name, p.variant, p.category, SUM(s.qty) AS qty, SUM(s.amount) AS amount FROM sales s LEFT JOIN products p ON p.id = s.product_id
    WHERE s.date BETWEEN ? AND ? GROUP BY s.product_id ORDER BY amount DESC`, from, to).map(r => {
    const cost = C.productCost(r.id, recipes, costs) * r.qty;
    return { name: (r.name || '?') + (r.variant ? ' ' + r.variant : ''), category: r.category || '', qty: C.r3(r.qty), amount: C.r2(r.amount), cost: C.r2(cost), profit: C.r2(r.amount - cost) };
  });
  const sum = (a, k) => C.r2(a.reduce((s, x) => s + (Number(x[k]) || 0), 0));
  const payT = t => C.r2(payroll.filter(p => p.type === t).reduce((s, p) => s + p.amount, 0));
  const sales = sum(days, 'sales'), cogs = sum(days, 'cogs'), exp = C.r2(expenses.reduce((s, e) => s + e.amount, 0));
  const salaries = C.r2(payT('salary') + payT('bonus') - payT('deduct'));
  const summary = {
    month, from, to: last, days: days.length, days_not_closed: days.filter(d => !d.closed).length,
    sales, loyverse: sum(days, 'loyverse'), ticket: sum(days, 'ticket'), discounts: sum(days, 'discounts'), cash: sum(days, 'cash'), card: sum(days, 'card'),
    cogs, gross_profit: C.r2(sales - cogs),
    purchases: C.r2(purchases.reduce((s, p) => s + p.total, 0)),
    purchases_cash: C.r2(purchases.filter(p => p.payment === 'cash').reduce((s, p) => s + p.total, 0)),
    purchases_credit: C.r2(purchases.filter(p => p.payment === 'credit').reduce((s, p) => s + p.total, 0)),
    supplier_payments: C.r2(supPay.reduce((s, p) => s + p.amount, 0)),
    expenses: exp, salaries, advances: payT('advance'),
    inventory_shortage: sum(days, 'shortage'), waste: sum(days, 'waste'), cash_shortage: sum(days, 'cash_shortage'),
    net_estimate: C.r2(sales - cogs - exp - salaries),
    suppliers_owed: C.r2((get("SELECT SUM(total) AS a FROM purchases WHERE payment = 'credit' AND date <= ?", to).a || 0) - (get('SELECT SUM(amount) AS a FROM supplier_payments WHERE date <= ?', to).a || 0)),
  };
  return { summary, days, purchases, expenses, supplier_payments: supPay, payroll, products };
}

function monthlyXlsx(month, restaurant = 'مطعم السلام') {
  const r = monthlyReport(month), s = r.summary;
  const L = [
    ['البند', 'المبلغ (ريال)', 'ملاحظة'],
    ['المطعم', restaurant, ''], ['الشهر', month, `من ${s.from} إلى ${s.to}`],
    ['أيام فيها حركة', s.days, s.days_not_closed ? `${s.days_not_closed} يوم ما انقفل` : 'كل الأيام مقفلة'],
    ['', '', ''],
    ['المبيعات (لويفرس + التذكرة)', s.sales, 'كما في لويفرس — شاملة الضريبة إذا أسعاركم شاملة'],
    ['  منها لويفرس', s.loyverse, ''], ['  منها التذكرة', s.ticket, ''], ['  الخصومات / فرق السعر', s.discounts, ''],
    ['  كاش (لويفرس)', s.cash, ''], ['  شبكة وغيره', s.card, ''],
    ['تكلفة الوجبات (من الوصفات)', s.cogs, 'تقديرية حسب الوصفات وأسعار الشراء'],
    ['الربح الإجمالي', s.gross_profit, 'المبيعات − تكلفة الوجبات'],
    ['المشتريات', s.purchases, `كاش ${s.purchases_cash} · آجل ${s.purchases_credit}`],
    ['سداد الموردين', s.supplier_payments, ''],
    ['المصروفات', s.expenses, ''],
    ['الرواتب (راتب + مكافأة − خصم)', s.salaries, `السلف المسحوبة ${s.advances}`],
    ['نقص البضاعة (الجرد)', s.inventory_shortage, ''], ['الهالك', s.waste, ''], ['نقص الكاش', s.cash_shortage, ''],
    ['الربح التقريبي', s.net_estimate, 'الربح الإجمالي − المصروفات − الرواتب (بدون إيجار/ضريبة ما انسجلت)'],
    ['علينا للموردين آخر الشهر', s.suppliers_owed, ''],
  ];
  const buf = X.build([
    { name: 'الملخص', rows: L, widths: [34, 18, 60] },
    { name: 'الأيام', rows: [['التاريخ', 'لويفرس', 'التذكرة', 'المبيعات', 'كاش', 'شبكة', 'الكاش المجرود', 'نقص الكاش', 'تكلفة الوجبات', 'المشتريات', 'المصروفات', 'نقص البضاعة', 'الهالك', 'مقفل'],
      ...r.days.map(d => [d.date, d.loyverse, d.ticket, d.sales, d.cash, d.card, d.counted_cash, d.cash_shortage, d.cogs, d.purchases, d.expenses, d.shortage, d.waste, d.closed ? 'نعم' : 'لا'])] },
    { name: 'المشتريات', rows: [['التاريخ', 'المورد', 'الدفع', 'المبلغ', 'الأصناف', 'سجّلها', 'ملاحظة'],
      ...r.purchases.map(p => [p.date, p.supplier, PAYMENT[p.payment] || p.payment, p.total, p.items.map(i => `${i.name} ${C.r3(i.qty)} ${i.unit}${i.unit_price ? ' × ' + C.r2(i.unit_price) : ''}`).join('، '), p.user || '', p.note])] },
    { name: 'المصروفات', rows: [['التاريخ', 'البند', 'المبلغ', 'من الدرج', 'سجّلها', 'ملاحظة'], ...r.expenses.map(e => [e.date, e.category, e.amount, e.paid_from_cash ? 'نعم' : 'لا', e.user || '', e.note])] },
    { name: 'سداد الموردين', rows: [['التاريخ', 'المورد', 'المبلغ', 'من الدرج', 'ملاحظة'], ...r.supplier_payments.map(p => [p.date, p.supplier, p.amount, p.paid_from_cash ? 'نعم' : 'لا', p.note])] },
    { name: 'الرواتب', rows: [['الموظف', 'النوع', 'المبلغ', 'التاريخ', 'ملاحظة'], ...r.payroll.map(p => [p.name, PAY[p.type] || p.type, p.amount, p.date, p.note])] },
    { name: 'مبيعات الأصناف', rows: [['الصنف', 'التصنيف', 'الكمية', 'المبلغ', 'التكلفة', 'الربح'], ...r.products.map(p => [p.name, p.category, p.qty, p.amount, p.cost, p.profit])] },
  ]);
  return { buf, name: `تقرير-${month}.xlsx`, report: r };
}

module.exports = { monthlyReport, monthlyXlsx, monthRange };
