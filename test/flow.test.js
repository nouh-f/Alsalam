'use strict';
// اختبار شامل: لويفرس وهمي + جرد + وصفات + تذكرة + تقرير
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const now = new Date();
const receipts = [
  { receipt_number: '1-1', receipt_type: 'SALE', created_at: now.toISOString(), receipt_date: now.toISOString(), total_money: 23,
    line_items: [
      { item_id: 'i1', variant_id: 'v1', item_name: 'بيبسي', quantity: 3, price: 3, total_money: 9, gross_total_money: 9 },
      { item_id: 'i2', variant_id: 'v2', item_name: 'حنيذ لحم', quantity: 1, price: 50, total_money: 45, gross_total_money: 50 },
    ],
    payments: [{ name: 'نقدي', type: 'CASH', money_amount: 54 }] },
  { receipt_number: '1-2', receipt_type: 'SALE', created_at: now.toISOString(), cancelled_at: now.toISOString(), total_money: 3,
    line_items: [{ item_id: 'i1', variant_id: 'v1', item_name: 'بيبسي', quantity: 100, price: 3, total_money: 300 }], payments: [] },
];
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json');
  if (req.headers.authorization !== 'Bearer TOK') { res.statusCode = 401; return res.end('{}'); }
  if (u.pathname === '/items') return res.end(JSON.stringify({ items: [
    { id: 'i1', item_name: 'بيبسي', category_id: 'c1', variants: [{ variant_id: 'v1', default_price: 3 }] },
    { id: 'i2', item_name: 'حنيذ لحم', category_id: 'c2', variants: [{ variant_id: 'v2', default_price: 50 }] },
    { id: 'i3', item_name: 'دراك', category_id: 'c2', variants: [{ variant_id: 'v3', option1_value: 'ني', default_price: 40 }, { variant_id: 'v4', option1_value: 'قلي', default_price: 45 }] },
  ] }));
  if (u.pathname === '/categories') return res.end(JSON.stringify({ categories: [{ id: 'c1', name: 'مشروبات' }, { id: 'c2', name: 'وجبات' }] }));
  if (u.pathname === '/receipts') return res.end(JSON.stringify({ receipts }));
  res.statusCode = 404; res.end('{}');
});

let srv, B, T;
const call = async (method, p, body, tok = T) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status });
  return j;
};

test.before(async () => {
  await new Promise(r => mock.listen(0, r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-'));
  const port = 40000 + Math.floor(Math.random() * 5000);
  B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: port, DATA_DIR: dir, LOYVERSE_BASE: `http://127.0.0.1:${mock.address().port}` }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await call('POST', '/api/login', { user_id: 1, pin: '1234' }, null)).token;
});
test.after(() => { srv.kill(); mock.close(); });

test('full day flow', async () => {
  const me = await call('GET', '/api/me');
  const date = me.today;
  await call('POST', '/api/settings', { loyverse_token: 'TOK' });
  const s = await call('POST', '/api/sync', { full: true });
  assert.ok(s.ok, s.message);

  const sales = await call('GET', '/api/sales?date=' + date);
  const pepsi = sales.find(x => x.name === 'بيبسي');
  assert.strictEqual(pepsi.qty, 3, 'cancelled receipt ignored');
  const products = await call('GET', '/api/products');
  const pp = products.find(p => p.name === 'بيبسي');
  assert.strictEqual(pp.recipe_status, 'draft', 'draft recipe made');
  assert.strictEqual(pp.lines[0].item, 'بيبسي');
  const hn = products.find(p => p.name === 'حنيذ لحم');
  assert.strictEqual(hn.lines[0].qty, 0.4);
  assert.strictEqual(products.filter(p => p.name === 'دراك').length, 2, 'variants are not new items');

  // ticket (credit): 50 pepsi + unmatched name
  const items = await call('GET', '/api/items');
  const pepsiItem = items.find(i => i.name === 'بيبسي');
  const tk = await call('POST', '/api/tickets', { date, images: [] });
  const t2 = await call('PUT', `/api/tickets/${tk.id}/lines`, { lines: [{ raw_name: 'خمسين ببسي', product_id: pp.id, qty: 50, price: 0, customer: 'أبو علي' }] });
  assert.strictEqual(t2.lines.length, 1);
  const sales2 = await call('GET', '/api/sales?date=' + date);
  const p2 = sales2.find(x => x.name === 'بيبسي');
  assert.strictEqual(p2.qty, 53); assert.strictEqual(p2.ticket_qty, 50); assert.strictEqual(p2.amount, 9 + 150);

  // purchase -> warehouse, transfer -> floor
  await call('POST', '/api/purchases', { date, supplier: 'المورد', lines: [{ item_id: pepsiItem.id, qty: 100, unit_price: 1.5 }] });
  await call('POST', '/api/transfer', { date, item_id: pepsiItem.id, qty: 60 });
  const wh = await call('GET', '/api/warehouse');
  assert.strictEqual(wh.find(w => w.id === pepsiItem.id).balance, 40);

  // counts: opening 10, received 60, sold 53 => expected 17, counted 15 => shortage 2
  const worker = (await call('GET', '/api/login-users')).find(u => u.name === 'عبدالله سليمان');
  const wt = (await call('POST', '/api/login', { user_id: worker.id, pin: '0000' }, null)).token;
  await call('POST', '/api/count', { date, item_id: pepsiItem.id, phase: 'opening', qty: 10 }, wt);
  await call('POST', '/api/count', { date, item_id: pepsiItem.id, phase: 'closing', qty: 15 }, wt);
  // worker can't count another's item / can't see sales
  const fish = items.find(i => i.name === 'سمك الباغة');
  await assert.rejects(call('POST', '/api/count', { date, item_id: fish.id, phase: 'opening', qty: 1 }, wt), e => e.status === 403);
  await assert.rejects(call('GET', '/api/sales?date=' + date, null, wt), e => e.status === 403);
  const wb = await call('GET', '/api/board?date=' + date, null, wt);
  assert.ok(wb.rows.every(r => r.diff === undefined), 'worker sees no calc');

  const board = await call('GET', '/api/board?date=' + date);
  const row = board.rows.find(r => r.item_id === pepsiItem.id);
  assert.strictEqual(row.received, 60); assert.strictEqual(row.theoretical, 53); assert.strictEqual(row.remaining_expected, 17); assert.strictEqual(row.diff, 2);

  // supervisor approve
  const sec = board.sections.find(x => x.name === 'المشروبات');
  await assert.rejects(call('POST', '/api/approve', { date, section_id: sec.id, phase: 'opening' }), e => e.status === 400);

  // recipe editing: decimal + delete one line only
  const ln = await call('POST', '/api/recipe-lines', { product_id: hn.id, item_id: items.find(i => i.name === 'ملح').id, qty: 0.005, source: 'warehouse' });
  let hn2 = (await call('GET', '/api/products')).find(p => p.id === hn.id);
  assert.strictEqual(hn2.lines.length, 2);
  await call('DELETE', '/api/recipe-lines/' + ln.id);
  hn2 = (await call('GET', '/api/products')).find(p => p.id === hn.id);
  assert.strictEqual(hn2.lines.length, 1);

  // report
  await call('POST', '/api/cash', { date, cash: 50, card: 0 });
  const rep = await call('GET', '/api/report?date=' + date);
  assert.strictEqual(rep.money.ticket_total, 150);
  assert.strictEqual(rep.money.loyverse_total, 54);
  assert.strictEqual(rep.money.cash_shortage, 4);
  assert.ok(rep.money.cogs > 0);
  assert.ok(rep.alerts.some(a => a.type === 'shortage'));
  // التذكرة مبيعات مو دين: ما فيه صفحة ديون
  await assert.rejects(call('GET', '/api/debts'), e => e.status === 404);

  // payroll
  const u = (await call('GET', '/api/users')).find(x => x.name === 'صادق');
  await call('POST', '/api/users', { ...u, salary: 2000, active: true });
  await call('POST', '/api/payroll', { user_id: u.id, type: 'advance', amount: 300 });
  let pr = (await call('GET', '/api/payroll')).find(x => x.id === u.id);
  assert.strictEqual(pr.balance, 1700);
  await call('POST', '/api/payroll', { user_id: u.id, type: 'settle' });
  pr = (await call('GET', '/api/payroll')).find(x => x.id === u.id);
  assert.strictEqual(pr.balance, 0);

  // close day locks workers
  await call('POST', '/api/day/close', { date });
  await assert.rejects(call('POST', '/api/count', { date, item_id: pepsiItem.id, phase: 'closing', qty: 1 }, wt), e => e.status === 403);
});

test('credit purchases, suppliers, purchaser role, cash, prep from floor', async () => {
  const date = (await call('GET', '/api/me')).today;
  const d2 = '2030-01-15'; // يوم مفتوح جديد عشان ما يتأثر بإقفال اليوم في الاختبار الأول
  const items = await call('GET', '/api/items');
  const flour = items.find(i => i.name === 'دقيق');
  const chicken = items.find(i => i.name === 'دجاج');
  const hanith = items.find(i => i.name === 'حنيذ دجاج');

  // زكريا ينضاف مسؤول مشتريات
  const z = (await call('GET', '/api/login-users')).find(x => x.name === 'زكريا');
  assert.strictEqual(z.role, 'purchaser');
  // مسؤول المشتريات
  const pu = await call('POST', '/api/users', { name: 'مسؤول المشتريات', role: 'purchaser', pin: '5555' });
  const pt = (await call('POST', '/api/login', { user_id: pu.id, pin: '5555' }, null)).token;
  await assert.rejects(call('GET', '/api/sales?date=' + d2, null, pt), e => e.status === 403);
  await call('GET', '/api/warehouse', null, pt);

  // شراء آجل بدون مورد = خطأ
  await assert.rejects(call('POST', '/api/purchases', { date: d2, payment: 'credit', lines: [{ item_id: flour.id, qty: 10, unit_price: 5 }] }, pt), e => e.status === 400);
  await call('POST', '/api/purchases', { date: d2, supplier: 'مطاحن الخير', payment: 'credit', lines: [{ item_id: flour.id, qty: 10, unit_price: 5 }] }, pt);
  await call('POST', '/api/purchases', { date: d2, supplier: 'مطاحن الخير', payment: 'cash', lines: [{ item_id: flour.id, qty: 2, unit_price: 5 }] }, pt);
  let sup = (await call('GET', '/api/suppliers', null, pt)).find(s => s.name === 'مطاحن الخير');
  assert.strictEqual(sup.credit, 50); assert.strictEqual(sup.balance, 50); assert.strictEqual(sup.total_purchases, 60);
  await call('POST', `/api/suppliers/${sup.id}/pay`, { date: d2, amount: 30, paid_from_cash: true }, pt);
  sup = (await call('GET', '/api/suppliers', null, pt)).find(s => s.name === 'مطاحن الخير');
  assert.strictEqual(sup.balance, 20);
  const st = await call('GET', '/api/suppliers/' + sup.id, null, pt);
  assert.strictEqual(st.purchases.length, 2); assert.strictEqual(st.payments.length, 1);
  // السداد على دفعات: الفاتورة الآجلة (50) انسدد منها 30
  const inv = st.purchases.find(p => p.payment === 'credit');
  assert.strictEqual(inv.paid, 30); assert.strictEqual(inv.remaining, 20);
  await call('POST', `/api/suppliers/${sup.id}/pay`, { date: d2, amount: 20 }, pt);
  const st2 = await call('GET', '/api/suppliers/' + sup.id, null, pt);
  assert.strictEqual(st2.purchases.find(p => p.payment === 'credit').remaining, 0);
  assert.strictEqual(st2.balance, 0);
  await call('DELETE', '/api/supplier-payments/' + st2.payments[0].id);

  // الكاش: كاش الشراء (10) + سداد المورد من الدرج (30) ينقصون
  const rep = await call('GET', '/api/report?date=' + d2);
  assert.strictEqual(rep.money.expected_cash, -10 - 30);
  assert.strictEqual(rep.money.purchases_credit, 50);
  assert.strictEqual(rep.money.suppliers_owed, 20);

  // التحضير: الدجاج (جرد يومي) ينسحب من المحضّر، مو من المستودع
  await call('PUT', `/api/items/${hanith.id}/components`, { components: [{ component_id: chicken.id, qty: 1 }] });
  await call('POST', '/api/transfer', { date: d2, item_id: chicken.id, qty: 10 });
  await call('POST', '/api/transfer', { date: d2, item_id: hanith.id, qty: 4 });
  const board = await call('GET', '/api/board?date=' + d2);
  assert.strictEqual(board.rows.find(r => r.item_id === chicken.id).received, 6);
  assert.strictEqual(board.rows.find(r => r.item_id === hanith.id).received, 4);
});

test('ticket money in cash setting, chicken pulled from fridge at opening', async () => {
  const d = '2030-02-10', prev = '2030-02-09';
  const items = await call('GET', '/api/items');
  const chicken = items.find(i => i.name === 'دجاج');
  assert.strictEqual(chicken.pull_on_open, 1);
  const pp = (await call('GET', '/api/products')).find(p => p.name === 'بيبسي');

  // التذكرة مبيعات، وفلوسها تدخل الكاش إذا الإعداد مفعّل
  const tk = await call('POST', '/api/tickets', { date: d, images: [] });
  await call('PUT', `/api/tickets/${tk.id}/lines`, { lines: [{ raw_name: 'بيبسي', product_id: pp.id, qty: 10, price: 3 }] });
  let rep = await call('GET', '/api/report?date=' + d);
  assert.strictEqual(rep.money.ticket_total, 30);
  assert.strictEqual(rep.money.expected_cash, 0);
  await call('POST', '/api/settings', { ticket_in_cash: '1' });
  rep = await call('GET', '/api/report?date=' + d);
  assert.strictEqual(rep.money.expected_cash, 30);
  await call('POST', '/api/settings', { ticket_in_cash: '0' });

  // الدجاج: آخر أمس 3، أول اليوم 13 => انسحب 10 من الثلاجة (المستودع)
  const wb = () => call('GET', '/api/warehouse').then(r => r.find(x => x.id === chicken.id).balance);
  const before = await wb();
  await call('POST', '/api/count', { date: prev, item_id: chicken.id, phase: 'closing', qty: 3 });
  await call('POST', '/api/count', { date: d, item_id: chicken.id, phase: 'opening', qty: 13 });
  assert.strictEqual(await wb(), before - 10);
  let row = (await call('GET', '/api/board?date=' + d)).rows.find(r => r.item_id === chicken.id);
  assert.strictEqual(row.pulled, 10); assert.strictEqual(row.opening_gap, null); assert.strictEqual(row.received, 0);
  // تعديل الرقم يعدّل السحب (ما يتكرر)
  await call('POST', '/api/count', { date: d, item_id: chicken.id, phase: 'opening', qty: 11 });
  assert.strictEqual(await wb(), before - 8);
  // تعديل آخر أمس يعدّل سحب اليوم
  await call('POST', '/api/count', { date: prev, item_id: chicken.id, phase: 'closing', qty: 5 });
  assert.strictEqual(await wb(), before - 6);
  // أقل من آخر أمس = تنبيه، ولا سحب
  await call('POST', '/api/count', { date: d, item_id: chicken.id, phase: 'opening', qty: 4 });
  assert.strictEqual(await wb(), before);
  row = (await call('GET', '/api/board?date=' + d)).rows.find(r => r.item_id === chicken.id);
  assert.strictEqual(row.opening_gap, -1);
});

test('Khalouf: supervisor without sales reports or recipes', async () => {
  const d = '2030-03-01';
  const kh = (await call('GET', '/api/users')).find(x => x.name === 'خلوف');
  assert.strictEqual(kh.no_sales, 1); assert.strictEqual(kh.no_recipes, 1);
  const kt = (await call('POST', '/api/login', { user_id: kh.id, pin: '0000' }, null)).token;
  const me = await call('GET', '/api/me', null, kt);
  assert.strictEqual(me.can_sales, false); assert.strictEqual(me.can_recipes, false);
  for (const p of ['/api/sales?date=' + d, '/api/report?date=' + d, '/api/days', '/api/tickets?date=' + d, '/api/products', '/api/note-rules'])
    await assert.rejects(call('GET', p, null, kt), e => e.status === 403, p);
  await assert.rejects(call('POST', '/api/recipe-lines', { product_id: 1, item_id: 1, qty: 1 }, kt), e => e.status === 403);
  await assert.rejects(call('POST', '/api/cash', { date: d, cash: 1 }, kt), e => e.status === 403);
  // الجرد والاستلام والمستودع شغالة عادي
  const dash = await call('GET', '/api/dashboard?date=' + d, null, kt);
  assert.strictEqual(dash.money, undefined);
  const b = await call('GET', '/api/board?date=' + d, null, kt);
  assert.ok(b.rows.length > 10);
  await call('GET', '/api/warehouse', null, kt);
  // إبراهيم مشرف كامل
  const ib = (await call('GET', '/api/users')).find(x => x.name === 'إبراهيم');
  const it = (await call('POST', '/api/login', { user_id: ib.id, pin: '0000' }, null)).token;
  await call('GET', '/api/report?date=' + d, null, it);
  await call('GET', '/api/products', null, it);
  // المالك يرجّع لخلوف الصلاحية
  await call('POST', '/api/users', { ...kh, no_sales: false, no_recipes: true });
  await call('GET', '/api/report?date=' + d, null, kt);
  const prods = await call('GET', '/api/products', null, kt); // للتذكرة، بدون التكلفة
  assert.ok(prods.every(p => p.cost === undefined));
  await assert.rejects(call('GET', '/api/note-rules', null, kt), e => e.status === 403);
});

test('purchase units: carton converts to cans, cost per can, units learned once', async () => {
  const d = '2030-04-01';
  const items = await call('GET', '/api/items');
  const ghee = items.find(i => i.name === 'سمن'), honey = items.find(i => i.name === 'عسل (دبة)');
  assert.deepStrictEqual(ghee.units.map(u => [u.name, u.factor]), [['كرتون', 25]]);
  assert.deepStrictEqual(honey.units.map(u => [u.name, u.factor]), [['دبة', 28]]);
  const mir = items.find(i => i.name === 'ميرندا');
  const wb = id => call('GET', '/api/warehouse').then(r => r.find(x => x.id === id).balance);
  const before = await wb(mir.id);

  // وحدة جديدة بدون «كم فيها» = خطأ
  await assert.rejects(call('POST', '/api/purchases', { date: d, lines: [{ item_id: mir.id, unit: 'كرتون', qty: 3, unit_price: 36 }] }), e => e.status === 400);
  // أول مرة: كرتون = 24 علبة
  await call('POST', '/api/purchases', { date: d, lines: [{ item_id: mir.id, unit: 'كرتون', factor: 24, qty: 3, unit_price: 36 }] });
  assert.strictEqual(await wb(mir.id), before + 72);
  let it = (await call('GET', '/api/items')).find(i => i.id === mir.id);
  assert.strictEqual(it.units[0].factor, 24);
  assert.strictEqual(it.unit_cost, 1.5);
  // المرة الثانية بمبلغ السطر بدون ما يسأل
  await call('POST', '/api/purchases', { date: d, lines: [{ item_id: mir.id, unit: 'كرتون', qty: 1, line_total: 36 }] });
  assert.strictEqual(await wb(mir.id), before + 96);
  const pu = (await call('GET', `/api/purchases?from=${d}&to=${d}`)).find(p => p.lines[0].item_id === mir.id && p.lines[0].pu_qty === 3);
  assert.strictEqual(pu.total, 108); assert.strictEqual(pu.lines[0].qty, 72); assert.strictEqual(pu.lines[0].pu_name, 'كرتون');
  // السمن: كرتون 25 كجم بـ 500 => الكيلو 20
  await call('POST', '/api/purchases', { date: d, lines: [{ item_id: ghee.id, unit: 'كرتون', qty: 2, unit_price: 500 }] });
  it = (await call('GET', '/api/items')).find(i => i.id === ghee.id);
  assert.strictEqual(it.unit_cost, 20);
});
