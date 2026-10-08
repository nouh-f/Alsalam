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
  if (u.pathname === '/items') return res.end(JSON.stringify({ items: [...extraItems,
    { id: 'i1', item_name: 'بيبسي', category_id: 'c1', variants: [{ variant_id: 'v1', default_price: 3 }] },
    { id: 'i2', item_name: 'حنيذ لحم', category_id: 'c2', variants: [{ variant_id: 'v2', default_price: 50 }] },
    { id: 'i3', item_name: 'دراك', category_id: 'c2', variants: [{ variant_id: 'v3', option1_value: 'ني', default_price: 40 }, { variant_id: 'v4', option1_value: 'قلي', default_price: 45 }] },
  ] }));
  if (u.pathname === '/categories') return res.end(JSON.stringify({ categories: [{ id: 'c1', name: 'مشروبات' }, { id: 'c2', name: 'وجبات' }] }));
  if (u.pathname === '/receipts') return res.end(JSON.stringify({ receipts }));
  res.statusCode = 404; res.end('{}');
});

const extraItems = [];
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

test('salads made in-house, bread bought; Zakaria sees and adds only warehouse items', async () => {
  const all = await call('GET', '/api/items');
  const by = n => all.find(i => i.name === n);
  for (const n of ['حلبة', 'شطة فلافل كبير', 'سحاوق جبن', 'طحينة']) assert.strictEqual(by(n).kind, 'prepared', n);
  for (const n of ['لحوح', 'كدر', 'كبان']) assert.strictEqual(by(n).kind, 'raw', n);
  assert.strictEqual(by('حمص'), undefined);
  assert.strictEqual(by('كدر').daily, 1);

  const z = (await call('GET', '/api/login-users')).find(x => x.name === 'زكريا');
  const zt = (await call('POST', '/api/login', { user_id: z.id, pin: '0000' }, null)).token;
  const zItems = await call('GET', '/api/items', null, zt);
  assert.ok(zItems.length > 5 && zItems.every(i => i.kind === 'raw'));
  assert.ok((await call('GET', '/api/warehouse', null, zt)).every(i => i.kind === 'raw'));
  // يضيف صنف جديد بنفسه => يُشترى، مستودع بس (ما يدخل الجرد اليومي)
  const t = await call('POST', '/api/items', { name: 'طماطم', unit: 'كجم', kind: 'prepared', daily: true }, zt);
  const tom = (await call('GET', '/api/items')).find(i => i.id === t.id);
  assert.strictEqual(tom.kind, 'raw'); assert.strictEqual(tom.daily, 0); assert.strictEqual(tom.section, 'المستودع (مواد خام)');
  await assert.rejects(call('POST', '/api/items', { name: 'طماطم', unit: 'كجم' }, zt), e => e.status === 400);
  await call('POST', '/api/purchases', { date: '2030-06-01', lines: [{ item_id: t.id, qty: 10, unit_price: 4 }] }, zt);
  // ما يلمس المحضّر
  await assert.rejects(call('POST', '/api/items', { id: by('حلبة').id, name: 'حلبة', unit: 'حبة' }, zt), e => e.status === 403);
  await assert.rejects(call('POST', '/api/purchases', { date: '2030-06-01', lines: [{ item_id: by('حلبة').id, qty: 1, unit_price: 1 }] }, zt), e => e.status === 400);
  await assert.rejects(call('PUT', `/api/items/${t.id}/components`, { components: [] }, zt), e => e.status === 403);
  await assert.rejects(call('DELETE', '/api/items/' + by('حلبة').id, null, zt), e => e.status === 403);
  // يعدّل اسم صنفه
  await call('POST', '/api/items', { id: t.id, name: 'طماطم بلدي', unit: 'كجم' }, zt);
  assert.ok((await call('GET', '/api/items', null, zt)).some(i => i.name === 'طماطم بلدي'));
});

test('workers do not see purchases or expenses; supervisors and Zakaria do', async () => {
  const users = await call('GET', '/api/login-users');
  const login = async name => (await call('POST', '/api/login', { user_id: users.find(x => x.name === name).id, pin: '0000' }, null)).token;
  const w = await login('عبدالله سليمان');
  await assert.rejects(call('GET', '/api/purchases', null, w), e => e.status === 403);
  await assert.rejects(call('POST', '/api/purchases', { note: 'x' }, w), e => e.status === 403);
  await assert.rejects(call('POST', '/api/expenses', { amount: 5 }, w), e => e.status === 403);
  const z = await login('زكريا');
  await call('GET', '/api/purchases', null, z);
  await assert.rejects(call('POST', '/api/expenses', { amount: 5 }, z), e => e.status === 403);
  const kh = await login('خلوف');
  await call('GET', '/api/purchases', null, kh);
  await call('POST', '/api/expenses', { amount: 5, category: 'غاز' }, kh);
});

test('link Loyverse products to the count by name: existing item, new item, skip', async () => {
  extraItems.push(
    { id: 'i8', item_name: 'هامور', category_id: 'c2', variants: [{ variant_id: 'v8', option1_value: 'قلي', default_price: 70 }, { variant_id: 'v9', option1_value: 'مبفا', default_price: 70 }] },
    { id: 'i9', item_name: 'لحوح', category_id: 'c2', variants: [{ variant_id: 'v10', default_price: 2 }] },
    { id: 'i10', item_name: 'توصيل', category_id: 'c2', variants: [{ variant_id: 'v11', default_price: 10 }] });
  await call('POST', '/api/sync', {});
  const groups = await call('GET', '/api/link');
  const linkedIds = new Set((await call('GET', '/api/products')).filter(p => p.lines.length).map(p => p.id));
  for (const g of groups) for (const v of g.variants) assert.ok(!linkedIds.has(v.id), 'only unlinked products listed');
  // صنف بأنواع: كل نوع ينخصم بكميته من صنف مخزون موجود
  const items = await call('GET', '/api/items');
  const g = groups.find(x => x.variants.length === 2) || groups[0];
  assert.ok(g, 'has unlinked products');
  const r = await call('POST', '/api/link', { action: 'item', item_id: items[0].id, lines: [{ product_id: g.variants[0].id, qty: '0.5' }, { product_id: g.variants[1]?.id || g.variants[0].id, qty: '' }] });
  assert.strictEqual(r.linked, 1);
  let p = (await call('GET', '/api/products')).find(x => x.id === g.variants[0].id);
  assert.strictEqual(p.recipe_status, 'ok'); assert.strictEqual(p.lines[0].qty, 0.5); assert.strictEqual(p.lines[0].item_id, items[0].id);
  // صنف جديد بنفس اسم لويفرس، ينجرد يوميًا
  const g2 = (await call('GET', '/api/link'))[0];
  const r2 = await call('POST', '/api/link', { action: 'new', name: 'صنف لويفرس تجربة', unit: 'كيلو', daily: true, lines: g2.variants.map(v => ({ product_id: v.id, qty: 1 })) });
  const it = (await call('GET', '/api/items')).find(i => i.id === r2.item_id);
  assert.strictEqual(it.name, 'صنف لويفرس تجربة'); assert.strictEqual(it.daily, 1); assert.strictEqual(it.unit, 'كيلو');
  p = (await call('GET', '/api/products')).find(x => x.id === g2.variants[0].id);
  assert.strictEqual(p.lines[0].source, 'floor');
  // ما ينجرد: يختفي من القائمة ومن تنبيه «بدون وصفة»
  const left = await call('GET', '/api/link');
  if (left.length) {
    const ids = left[0].variants.map(v => ({ product_id: v.id }));
    await call('POST', '/api/link', { action: 'skip', lines: ids });
    assert.ok(!(await call('GET', '/api/link')).some(x => x.key === left[0].key));
    assert.ok((await call('GET', '/api/link?skipped=1')).some(x => x.key === left[0].key));
    await call('POST', '/api/link', { action: 'unskip', lines: ids });
    assert.ok((await call('GET', '/api/link')).some(x => x.key === left[0].key));
  }
  await assert.rejects(call('POST', '/api/link', { action: 'item', item_id: items[0].id, lines: [] }), e => e.status === 400);
  // خلوف ما يشوف الوصفات
  const users = await call('GET', '/api/login-users');
  const kh = (await call('POST', '/api/login', { user_id: users.find(x => x.name === 'خلوف').id, pin: '0000' }, null)).token;
  await assert.rejects(call('GET', '/api/link', null, kh), e => e.status === 403);
});

test('recipe deducts from the count if the item is counted daily, otherwise from the warehouse', async () => {
  const today = (await call('GET', '/api/me')).today;
  await call('POST', '/api/day/close', { date: today, undo: true }); // اليوم المقفل ما تتغير حركاته
  const items = await call('GET', '/api/items');
  const flour = items.find(i => i.name === 'دقيق'); // ما ينجرد يوميًا
  const p = (await call('GET', '/api/products')).find(x => x.name === 'بيبسي');
  // حتى لو انحفظ «من المحضّر»، الدقيق ينخصم من المستودع
  const l = await call('POST', '/api/recipe-lines', { product_id: p.id, item_id: flour.id, qty: 0.1, source: 'floor' });
  const moves = (await call('GET', '/api/moves?date=' + today)).filter(m => m.item_id === flour.id && m.type === 'sale_use');
  assert.strictEqual(moves.length, 1); assert.strictEqual(moves[0].location, 'warehouse'); assert.ok(moves[0].qty < 0);
  assert.strictEqual((await call('GET', '/api/products')).find(x => x.id === p.id).lines.find(x => x.id === l.id).source, 'warehouse');
  await call('DELETE', '/api/recipe-lines/' + l.id);
  assert.strictEqual((await call('GET', '/api/moves?date=' + today)).filter(m => m.item_id === flour.id && m.type === 'sale_use').length, 0);
});

test('dry fatt: made at opening deducts flour/oil/salt; gas in its cost; sold alone and inside marsa', async () => {
  const d0 = '2031-03-01', d1 = '2031-03-02';
  const items = await call('GET', '/api/items');
  const by = n => items.find(i => i.name === n);
  await call('POST', '/api/items', { id: by('دقيق').id, name: 'دقيق', unit: 'كجم', kind: 'raw', cost: 4, carry_over: 1 });
  const fatt = await call('POST', '/api/items', { name: 'فت ناشف أبيض', unit: 'حبة', kind: 'prepared', daily: true, carry_over: true, pull_on_open: true, extra_cost: 0.5 });
  await call('PUT', `/api/items/${fatt.id}/components`, { components: [{ component_id: by('دقيق').id, qty: 0.25 }] });
  const f = (await call('GET', '/api/items')).find(i => i.id === fatt.id);
  assert.strictEqual(f.unit_cost, 1.5); // 0.25 × 4 + غاز 0.5
  // آخر أمس باقي 2، أول اليوم 10 => تجهّز 8 => دقيق 2 كيلو من المستودع
  await call('POST', '/api/count', { date: d0, item_id: fatt.id, phase: 'closing', qty: 2 });
  await call('POST', '/api/count', { date: d1, item_id: fatt.id, phase: 'opening', qty: 10 });
  const mv = (await call('GET', '/api/moves?date=' + d1)).filter(m => m.ref === `op:${d1}:${fatt.id}`);
  assert.strictEqual(mv.length, 1); assert.strictEqual(mv[0].item_id, by('دقيق').id); assert.strictEqual(mv[0].qty, -2); assert.strictEqual(mv[0].location, 'warehouse');
  // تعديل أول اليوم يعيد الحساب
  await call('POST', '/api/count', { date: d1, item_id: fatt.id, phase: 'opening', qty: 6 });
  assert.strictEqual((await call('GET', '/api/moves?date=' + d1)).find(m => m.ref === `op:${d1}:${fatt.id}`).qty, -1);
  const row = (await call('GET', '/api/board?date=' + d1)).rows.find(r => r.item_id === fatt.id);
  assert.strictEqual(row.opening_gap, null); assert.strictEqual(row.pulled, 4);
});

test('home: «المطلوب منك الحين» tells each person exactly what to do', async () => {
  const users = await call('GET', '/api/login-users');
  const login = async name => (await call('POST', '/api/login', { user_id: users.find(x => x.name === name).id, pin: '0000' }, null)).token;
  const d = '2031-05-01';
  const w = await login('فؤاد');
  let todo = (await call('GET', '/api/dashboard?date=' + d, null, w)).todo;
  assert.ok(todo[0].title.includes('جرد أول الدوام') && todo[0].href.includes('p=opening'), JSON.stringify(todo[0]));
  assert.ok(!todo.some(t => t.href === '#/link'), 'worker does not get owner set-up tasks');
  // خلّص أول الدوام => يطلع «خلص ✓» وينتقل لآخر الدوام
  const board = await call('GET', '/api/board?date=' + d, null, w);
  for (const r of board.rows.filter(r => r.opening_user_id === users.find(x => x.name === 'فؤاد').id))
    await call('POST', '/api/count', { date: d, item_id: r.item_id, phase: 'opening', qty: 1 }, w);
  todo = (await call('GET', '/api/dashboard?date=' + d, null, w)).todo;
  assert.ok(todo.some(t => t.level === 'green' && t.title.includes('أول الدوام')));
  // المشرف: القسم اللي خلص ينطلب منه «استلام»
  const sup = await login('إبراهيم');
  const st = (await call('GET', '/api/dashboard?date=' + d, null, sup)).todo;
  assert.ok(st.some(t => t.level === 'red' && t.title.startsWith('استلم أول الدوام')), JSON.stringify(st.map(t => t.title)));
});

test('names: stock items spelled differently from Loyverse get renamed to the Loyverse spelling', async () => {
  extraItems.push({ id: 'i20', item_name: 'ميرنده', category_id: 'c1', variants: [{ variant_id: 'v20', default_price: 3 }] },
    { id: 'i21', item_name: 'دجاج مندي', category_id: 'c2', variants: [{ variant_id: 'v21', default_price: 25 }] });
  await call('POST', '/api/sync', {});
  const fixes = await call('GET', '/api/link/names');
  const f = fixes.find(x => x.name === 'ميرندا');
  assert.ok(f && f.loyverse === 'ميرنده', JSON.stringify(fixes));
  assert.ok(!fixes.some(x => x.name === 'دجاج'), 'دجاج is not renamed to دجاج مندي');
  await call('POST', '/api/link/rename', { items: [{ item_id: f.item_id, name: f.loyverse }] });
  assert.ok((await call('GET', '/api/items')).some(i => i.id === f.item_id && i.name === 'ميرنده'));
  assert.ok(!(await call('GET', '/api/link/names')).some(x => x.item_id === f.item_id));
  // وينربط: إما انربط لحاله وقت السحب، أو مقترحه صار 100%
  const g = (await call('GET', '/api/link')).find(x => x.name === 'ميرنده');
  const p = (await call('GET', '/api/products')).find(x => x.name === 'ميرنده');
  assert.ok(g ? g.suggestion.score === 1 : p.lines[0].item_id === f.item_id);
});

test('dish with a recipe per variant: marsa plain / ghee / honey', async () => {
  extraItems.push({ id: 'i30', item_name: 'مرسة صغير', category_id: 'c2', variants: ['ساده', 'سمن', 'عسل'].map((o, k) => ({ variant_id: 'm' + k, option1_value: o, default_price: 10 })) });
  await call('POST', '/api/sync', {});
  const g = (await call('GET', '/api/link')).find(x => x.name === 'مرسة صغير');
  assert.strictEqual(g.variants.length, 3);
  const items = await call('GET', '/api/items');
  const id = n => items.find(i => i.name === n).id;
  const v = o => g.variants.find(x => x.variant === o).id;
  const recipe = [
    ...g.variants.map(x => ({ product_id: x.id, item_id: id('فتة أبيض'), qty: 1 })),
    { product_id: v('سمن'), item_id: id('سمن'), qty: '0.05' },
    { product_id: v('عسل'), item_id: id('عسل (قرورة الفتة)'), qty: '0.04' },
    { product_id: v('ساده'), item_id: id('موز'), qty: '' }, // فاضي = ما فيه
  ];
  await call('POST', '/api/link', { action: 'recipe', lines: g.variants.map(x => ({ product_id: x.id })), recipe });
  const ps = (await call('GET', '/api/products')).filter(p => p.name === 'مرسة صغير');
  const lines = o => ps.find(p => p.variant === o).lines.map(l => `${l.item}:${l.qty}`).sort().join('|');
  assert.strictEqual(lines('ساده'), 'فتة أبيض:1');
  assert.strictEqual(lines('سمن'), 'سمن:0.05|فتة أبيض:1');
  assert.strictEqual(lines('عسل'), 'عسل (قرورة الفتة):0.04|فتة أبيض:1');
  assert.ok(ps.every(p => p.recipe_status === 'ok'));
  assert.ok(!(await call('GET', '/api/link')).some(x => x.name === 'مرسة صغير'));
  // تعديل: يستبدل (ما يكرر)
  await call('POST', '/api/link', { action: 'recipe', lines: [{ product_id: v('سمن') }], recipe: [{ product_id: v('سمن'), item_id: id('سمن'), qty: 0.06 }] });
  assert.strictEqual((await call('GET', '/api/products')).find(p => p.id === v('سمن')).lines.map(l => `${l.item}:${l.qty}`).join('|'), 'سمن:0.06');
});

test('Claude key: owner creates it, it reads and edits recipes, hidden from login, revoke locks it out', async () => {
  const users = await call('GET', '/api/login-users');
  const sup = (await call('POST', '/api/login', { user_id: users.find(x => x.name === 'إبراهيم').id, pin: '0000' }, null)).token;
  await assert.rejects(call('POST', '/api/settings/claude-key', {}, sup), e => e.status === 403); // المالك بس
  const { token } = await call('POST', '/api/settings/claude-key', {});
  assert.ok(token.startsWith('cl_'));
  assert.ok((await call('GET', '/api/settings/claude-key')).active);
  assert.ok(!(await call('GET', '/api/login-users')).some(x => x.name.startsWith('Claude')));
  assert.ok(!(await call('GET', '/api/users')).some(x => x.name.startsWith('Claude')));
  const me = await call('GET', '/api/me', null, token);
  assert.ok(me.can_recipes && me.can_sales);
  const p = (await call('GET', '/api/products', null, token)).find(x => x.name === 'بيبسي');
  const item = (await call('GET', '/api/items', null, token)).find(i => i.name === 'ملح');
  const l = await call('POST', '/api/recipe-lines', { product_id: p.id, item_id: item.id, qty: 0.001 }, token);
  await call('DELETE', '/api/recipe-lines/' + l.id, null, token);
  await assert.rejects(call('GET', '/api/settings', null, token), e => e.status === 403); // ما يشوف رمز لويفرس ولا يسوي مفاتيح
  // مفتاح جديد يبطّل القديم، والإلغاء يقفل
  const t2 = (await call('POST', '/api/settings/claude-key', {})).token;
  await assert.rejects(call('GET', '/api/me', null, token), e => e.status === 401);
  await call('GET', '/api/me', null, t2);
  await call('DELETE', '/api/settings/claude-key');
  await assert.rejects(call('GET', '/api/me', null, t2), e => e.status === 401);
  assert.ok(!(await call('GET', '/api/settings/claude-key')).active);
});

test('names: warehouse raw materials are never renamed (ملح is not ملوح)', async () => {
  extraItems.push({ id: 'i40', item_name: 'ملوح', category_id: 'c2', variants: [{ variant_id: 'v40', default_price: 2 }] });
  await call('POST', '/api/sync', {});
  assert.ok(!(await call('GET', '/api/link/names')).some(f => f.name === 'ملح'));
});

test('supervisors see staff names only — no permissions, salaries or PINs', async () => {
  const users = await call('GET', '/api/login-users');
  const sup = (await call('POST', '/api/login', { user_id: users.find(x => x.name === 'إبراهيم').id, pin: '0000' }, null)).token;
  const list = await call('GET', '/api/users', null, sup);
  assert.ok(list.length && list.every(x => Object.keys(x).sort().join() === 'active,id,name,role'), JSON.stringify(list[0]));
  assert.ok('pin' in (await call('GET', '/api/users'))[0]);
});

test('responsibilities: each employee has his own items; shortage on him; editing an item keeps it', async () => {
  const r0 = await call('GET', '/api/responsibility');
  const w = r0.users.find(u => u.name === 'فؤاد'), w2 = r0.users.find(u => u.name === 'صادق');
  const [a, b] = r0.items.filter(i => i.user_id !== w.id).slice(0, 2);
  await call('POST', '/api/responsibility', { item_ids: [a.id, b.id], user_id: w.id });
  let r = await call('GET', '/api/responsibility');
  assert.ok([a.id, b.id].every(id => r.items.find(i => i.id === id).user_id === w.id));
  // الجرد: يطلع له في «أصنافي»، والقسم اسمه «عهدة فؤاد»
  const board = await call('GET', '/api/board?date=' + (await call('GET', '/api/me')).today);
  const row = board.rows.find(x => x.item_id === a.id);
  assert.strictEqual(row.opening_user_id, w.id); assert.strictEqual(row.closing_user_id, w.id); assert.strictEqual(row.section, 'عهدة فؤاد');
  // تعديل الصنف من صفحة الأصناف (بدون قسم) ما يشيله عنه
  const it = (await call('GET', '/api/items')).find(i => i.id === a.id);
  await call('POST', '/api/items', { id: it.id, name: it.name, unit: it.unit, kind: it.kind, daily: true, carry_over: !!it.carry_over });
  assert.strictEqual((await call('GET', '/api/responsibility')).items.find(i => i.id === a.id).user_id, w.id);
  // ينتقل لغيره، ويشيله
  await call('POST', '/api/responsibility', { item_id: a.id, user_id: w2.id });
  assert.strictEqual((await call('GET', '/api/responsibility')).items.find(i => i.id === a.id).user_id, w2.id);
  await call('POST', '/api/responsibility', { item_id: b.id, user_id: null });
  assert.strictEqual((await call('GET', '/api/responsibility')).items.find(i => i.id === b.id).user_id, null);
  // العامل ما يغيّر المسؤوليات
  const users = await call('GET', '/api/login-users');
  const wt = (await call('POST', '/api/login', { user_id: users.find(x => x.name === 'فؤاد').id, pin: '0000' }, null)).token;
  await assert.rejects(call('POST', '/api/responsibility', { item_id: a.id, user_id: w.id }, wt), e => e.status === 403);
});

test('count page: pull leftovers from the fridge and store them back, no ingredients deducted', async () => {
  const d = '2031-07-01';
  const items = await call('GET', '/api/items');
  const it = items.find(i => i.name === 'حنيذ لحم');
  await call('POST', '/api/transfer', { date: d, item_id: it.id, qty: 3, mode: 'store' });
  await call('POST', '/api/transfer', { date: d, item_id: it.id, qty: 2, mode: 'pull' });
  const mv = (await call('GET', '/api/moves?date=' + d)).filter(m => m.date === d);
  assert.ok(mv.every(m => m.item_id === it.id && m.type === 'transfer'), 'no prep_use of components');
  const floor = mv.filter(m => m.location === 'floor').reduce((t, m) => t + m.qty, 0);
  const wh = mv.filter(m => m.location === 'warehouse').reduce((t, m) => t + m.qty, 0);
  assert.strictEqual(floor, -1); assert.strictEqual(wh, 1);
  assert.strictEqual((await call('GET', '/api/board?date=' + d)).rows.find(r => r.item_id === it.id).received, -1);
});

test('item type: warehouse / fresh (waste at night) / daily kept — saved as daily + carry_over', async () => {
  const it = await call('POST', '/api/items', { name: 'لحوح تجربة', unit: 'حبة', kind: 'raw', daily: true, carry_over: false });
  const get = async () => (await call('GET', '/api/items')).find(i => i.id === it.id);
  let x = await get(); assert.strictEqual(x.daily, 1); assert.strictEqual(x.carry_over, 0);
  // شراء الطازج يدخل جرد اليوم على طول (مو المستودع)
  const d = '2031-08-01';
  await call('POST', '/api/purchases', { date: d, lines: [{ item_id: it.id, qty: 30, unit_price: 1 }] });
  const mv = (await call('GET', '/api/moves?date=' + d)).find(m => m.item_id === it.id && m.type === 'purchase');
  assert.strictEqual(mv.location, 'floor');
  await call('POST', '/api/items', { id: it.id, name: it.name ?? 'لحوح تجربة', unit: 'حبة', kind: 'raw', daily: false, carry_over: true });
  x = await get(); assert.strictEqual(x.daily, 0);
});
