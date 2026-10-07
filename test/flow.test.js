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
  const debts = await call('GET', '/api/debts');
  assert.strictEqual(debts.rows.find(r => r.customer === 'أبو علي').balance, 150);

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
