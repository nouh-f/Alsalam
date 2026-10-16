'use strict';
// 💲 السعر من لويفرس: سعر الفرع (اللي يبيع فيه الكاشير) أول — default_price يقعد قديم لو انعدّل السعر في المحل بس
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json');
  if (u.pathname === '/items') return res.end(JSON.stringify({ items: [
    { id: 'a', item_name: 'سمك ابو عصايه', variants: [{ variant_id: 'a1', default_price: 10, stores: [{ store_id: 's', price: 15, available_for_sale: true }] }] },
    { id: 'b', item_name: 'رز سعر', variants: [{ variant_id: 'b1', default_price: 8, stores: [{ store_id: 's', price: null, available_for_sale: true }] }] },
    { id: 'c', item_name: 'كبان سعر', variants: [{ variant_id: 'c1', default_price: 4 }] }] }));
  if (u.pathname === '/categories') return res.end('{"categories":[]}');
  if (u.pathname === '/receipts') return res.end('{"receipts":[]}');
  res.statusCode = 404; res.end('{}');
});
let srv, B, T;
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};

test.before(async () => {
  await new Promise(r => mock.listen(0, r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-sp-'));
  const port = 46000 + Math.floor(Math.random() * 300); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir, LOYVERSE_BASE: `http://127.0.0.1:${mock.address().port}` }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  await call('POST', '/api/settings', { loyverse_token: 'x' });
  assert.ok((await call('POST', '/api/sync', { full: true })).ok);
});
test.after(() => { srv.kill(); mock.close(); });

test('the store price wins over an old default price; no store price => default', async () => {
  const ps = await call('GET', '/api/products');
  const price = n => ps.find(p => p.name === n).price;
  assert.strictEqual(price('سمك ابو عصايه'), 15);
  assert.strictEqual(price('رز سعر'), 8);
  assert.strictEqual(price('كبان سعر'), 4);
});
