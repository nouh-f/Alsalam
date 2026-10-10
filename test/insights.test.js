'use strict';
// الهالك، فاتورة الشراء بالصورة، أسعار الموردين، ربح الأطباق، اقتراح تعديل الوصفة، النقص الشهري، تنبيهات الأسعار
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

let receipts = [], price = 20;
const rc = (n, date, qty) => ({ receipt_number: n, receipt_type: 'SALE', created_at: date + 'T12:00:00Z', receipt_date: date + 'T12:00:00Z', total_money: qty * 20,
  line_items: [{ item_id: 'k', variant_id: 'k1', item_name: 'كبده', quantity: qty, price: 20, total_money: qty * 20 }], payments: [{ name: 'نقدي', type: 'CASH', money_amount: qty * 20 }] });
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json');
  if (u.pathname === '/items') return res.end(JSON.stringify({ items: [{ id: 'k', item_name: 'كبده', variants: [{ variant_id: 'k1', default_price: price }] }] }));
  if (u.pathname === '/categories') return res.end('{"categories":[]}');
  if (u.pathname === '/receipts') return res.end(JSON.stringify({ receipts }));
  res.statusCode = 404; res.end('{}');
});
let srv, B, T, today, FX;
const call = async (method, p, body, tok = T) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

test.before(async () => {
  await new Promise(r => mock.listen(0, r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-in-'));
  FX = path.join(dir, 'ai.json'); fs.writeFileSync(FX, '[]');
  const port = 36000 + Math.floor(Math.random() * 3000); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: port, DATA_DIR: dir, AI_FIXTURE: FX, LOYVERSE_BASE: `http://127.0.0.1:${mock.address().port}` }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  today = (await call('GET', '/api/me')).today;
  receipts = [1, 2, 3, 4, 5].map(i => rc('r' + i, addDays(today, -i), 10));
  await call('POST', '/api/settings', { loyverse_token: 'x', anthropic_key: 'sk-test' });
  assert.ok((await call('POST', '/api/sync', { full: true })).ok);
});
test.after(() => { srv.kill(); mock.close(); });

test('thrown away is waste, not a shortage', async () => {
  const { id } = await call('POST', '/api/items', { name: 'سلطة اختبار', unit: 'صحن', daily: 1, carry_over: 1, kind: 'prepared' });
  await call('POST', '/api/count', { date: today, item_id: id, phase: 'opening', qty: 10 });
  await call('POST', '/api/transfer', { date: today, item_id: id, qty: 2, mode: 'waste', note: 'خربانة' });
  await call('POST', '/api/count', { date: today, item_id: id, phase: 'closing', qty: 8 });
  const r = (await call('GET', '/api/board?date=' + today)).rows.find(x => x.item_id === id);
  assert.strictEqual(r.diff, 0); assert.strictEqual(r.wasted, 2); assert.strictEqual(r.waste, 2); assert.strictEqual(r.received, 0);
  const mv = (await call('GET', '/api/moves?date=' + today)).find(m => m.type === 'waste');
  assert.strictEqual(mv.note, 'خربانة');
});

test('recipe suggestion from a steady shortage, profit per dish, monthly shortage', async () => {
  const { id } = await call('POST', '/api/items', { name: 'كبدة', unit: 'كجم', daily: 1, carry_over: 1, kind: 'raw', cost: 5 });
  const prod = (await call('GET', '/api/products')).find(p => p.name === 'كبده');
  await call('POST', '/api/link', { action: 'recipe', lines: [{ product_id: prod.id }], recipe: [{ product_id: prod.id, item_id: id, qty: 1 }] });
  const w = await call('POST', '/api/users', { name: 'مقفل الكبدة', role: 'worker', pin: '4444' });
  await call('POST', '/api/responsibility', { item_id: id, user_id: w.id });
  // كل يوم: انباع 10 (المفروض ينصرف 10) والفعلي 12 — نقص 20%
  for (let i = 1; i <= 5; i++) {
    await call('POST', '/api/count', { date: addDays(today, -i), item_id: id, phase: 'opening', qty: 20 });
    await call('POST', '/api/count', { date: addDays(today, -i), item_id: id, phase: 'closing', qty: 8 });
  }
  const sug = await call('GET', '/api/recipe-suggestions');
  const s = sug.find(x => x.item_id === id);
  assert.ok(s, 'suggested'); assert.strictEqual(s.pct, 20); assert.strictEqual(s.factor, 1.2); assert.strictEqual(s.lines[0].suggested, 1.2);

  const mp = await call('GET', '/api/menu-profit');
  const row = mp.rows.find(r => r.product_id === prod.id);
  assert.strictEqual(row.cost, 5); assert.strictEqual(row.food_cost_pct, 25); assert.strictEqual(row.high, false); assert.strictEqual(row.sold_30, 50);

  const months = [...new Set([1, 2, 3, 4, 5].map(i => addDays(today, -i).slice(0, 7)))];
  let times = 0;
  for (const m of months) { const ms = await call('GET', '/api/shortage-month?month=' + m); const p = ms.rows.find(r => r.user_id === w.id); if (p) { times += p.short_times; assert.strictEqual(p.items[0].item, 'كبدة'); } }
  assert.strictEqual(times, 5);

  await call('POST', '/api/recipe-suggestions/apply', { item_id: id, factor: 1.2 });
  assert.strictEqual((await call('GET', '/api/products')).find(p => p.id === prod.id).lines[0].qty, 1.2);
  assert.ok(!(await call('GET', '/api/recipe-suggestions')).find(x => x.item_id === id), 'fixed after apply');
});

test('invoice photo fills purchase lines; supplier prices and cheapest supplier', async () => {
  const { id } = await call('POST', '/api/items', { name: 'طماطم', unit: 'كجم', kind: 'raw' });
  await call('PUT', `/api/items/${id}/units`, { units: [{ name: 'كرتون', factor: 6 }] });
  fs.writeFileSync(FX, JSON.stringify([{ stop_reason: 'end_turn', usage: { input_tokens: 2000, output_tokens: 300 }, content: [{ type: 'text', text: JSON.stringify({
    supplier: 'خضار الوادي', date: null, total: 60, lines: [{ name: 'طماط', qty: 2, unit: 'كرتون', unit_price: 30, line_total: 60, item_id: null }, { name: 'شي غريب', qty: 1, unit: '', unit_price: null, line_total: null, item_id: 99999 }] }) }] }]));
  const r = await call('POST', '/api/purchases/read', { images: ['data:image/jpeg;base64,AAAA'] });
  assert.strictEqual(r.supplier, 'خضار الوادي');
  assert.strictEqual(r.lines[0].item_id, id, 'طماط ≈ طماطم'); assert.strictEqual(r.lines[0].unit, 'كرتون');
  assert.strictEqual(r.lines[1].item_id, null, 'unknown id dropped');
  assert.strictEqual(r.model, 'fast');
  // سعرين: قبل شهرين 4 للكيلو من مورد، والحين 5 من مورد ثاني
  await call('POST', '/api/purchases', { date: addDays(today, -50), supplier: 'أبو سالم', payment: 'paid', lines: [{ item_id: id, qty: 10, unit_price: 4 }] });
  await call('POST', '/api/purchases', { date: today, supplier: 'خضار الوادي', payment: 'paid', lines: [{ item_id: id, qty: 2, unit: 'كرتون', unit_price: 30 }] });
  const p = (await call('GET', '/api/prices')).find(x => x.item_id === id);
  assert.strictEqual(p.last_price, 5); assert.strictEqual(p.avg_before, 4); assert.strictEqual(p.change_pct, 25);
  assert.strictEqual(p.cheapest.name, 'أبو سالم');
});

test('alerts: ticket price differs from Loyverse; Loyverse price changed', async () => {
  const prod = (await call('GET', '/api/products')).find(p => p.name === 'كبده');
  const tk = await call('POST', '/api/tickets', { date: today, images: [] });
  await call('PUT', `/api/tickets/${tk.id}/lines`, { lines: [{ raw_name: 'كبده', product_id: prod.id, qty: 1, price: 25 }] });
  let al = (await call('GET', '/api/report?date=' + today)).alerts;
  assert.ok(al.some(a => a.type === 'ticket_price' && /25 بدل 20/.test(a.text)));
  price = 25;
  await call('POST', '/api/sync', {});
  al = (await call('GET', '/api/report?date=' + today)).alerts;
  assert.ok(al.some(a => a.type === 'price_change' && /20 ← 25/.test(a.text)));
  assert.ok(!al.some(a => a.type === 'ticket_price'), 'prices match now');
});

test('recipe usage: per item and per dish, same numbers as the count board', async () => {
  const d = addDays(today, -1);
  const r = await call('GET', '/api/recipe-usage?date=' + d);
  const kb = r.rows.find(x => x.name === 'كبدة');
  assert.ok(kb, 'item listed'); assert.strictEqual(kb.place, 'floor');
  const board = (await call('GET', '/api/board?date=' + d)).rows.find(x => x.name === 'كبدة');
  assert.strictEqual(kb.total, board.theoretical);
  assert.strictEqual(kb.from[0].product, 'كبده'); assert.strictEqual(kb.from[0].sold, 10);
  assert.strictEqual(kb.from[0].qty, C3(kb.from[0].sold * kb.from[0].per_one));
  assert.strictEqual(kb.count.actual, 12); assert.strictEqual(kb.count.diff, C3(12 - kb.total));
  // طبق بدون وصفة يطلع في القائمة
  const prod = (await call('GET', '/api/products')).find(p => p.name === 'كبده');
  const line = prod.lines[0];
  await call('DELETE', '/api/recipe-lines/' + line.id);
  const r2 = await call('GET', '/api/recipe-usage?date=' + d);
  assert.ok(r2.no_recipe.some(x => x.name === 'كبده' && x.sold === 10));
  assert.ok(!r2.rows.find(x => x.name === 'كبدة'));
});
const C3 = x => Math.round(x * 1000) / 1000;
