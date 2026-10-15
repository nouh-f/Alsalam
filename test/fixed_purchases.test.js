'use strict';
// 🔁 المشتريات الثابتة كل يوم (لحوح، كدر وكبان…): تنسجل لحالها مرة وحدة في اليوم، والجمعة لها كميتها
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

let srv, B, T;
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-fixed-'));
  const port = 42000 + Math.floor(Math.random() * 400); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
});
test.after(() => srv.kill());

test('fixed daily purchases: added once per day, Friday list on Fridays, skipped when already entered by hand', async () => {
  const { id: zak } = await call('POST', '/api/users', { name: 'مشتري ثابت', role: 'purchaser', pin: '8181' });
  const { id: bread } = await call('POST', '/api/items', { name: 'لحوح ث', unit: 'حبة', daily: 1, kind: 'raw' });
  const { id: kadar } = await call('POST', '/api/items', { name: 'كدر ث', unit: 'حبة', daily: 1, kind: 'raw' });
  await call('PUT', '/api/fixed-purchases', { user_id: zak, list: [
    { supplier: 'ام محمد ث', payment: 'credit', lines: [{ item_id: bread, qty: 200, unit_price: 0.5 }], fri: [{ item_id: bread, qty: 300, unit_price: 0.5 }] },
    { supplier: 'كدر ث', payment: 'paid', lines: [{ item_id: kadar, qty: 50, unit_price: 1 }] },
  ] });
  const ofDay = async d => call('GET', `/api/purchases?from=${d}&to=${d}`);
  // الخميس ١٥ أكتوبر
  const thu = '2026-10-15';
  // الكدر انسجل باليد قبل => ما يتكرر
  await call('POST', '/api/purchases', { date: thu, supplier: 'كدر ث', payment: 'paid', lines: [{ item_id: kadar, qty: 40, unit_price: 1 }] });
  const r = await call('POST', '/api/fixed-purchases/run', { date: thu, force: true });
  assert.deepStrictEqual(r.added.map(x => x.supplier), ['ام محمد ث']);
  let ps = await ofDay(thu);
  const um = ps.find(p => p.supplier === 'ام محمد ث');
  assert.strictEqual(um.total, 100); assert.strictEqual(um.payment, 'credit'); assert.strictEqual(um.user_id, zak); assert.strictEqual(um.note, 'ثابت يومي');
  assert.strictEqual(ps.filter(p => p.supplier === 'كدر ث').length, 1);
  // مرة ثانية نفس اليوم => ولا شي
  assert.deepStrictEqual((await call('POST', '/api/fixed-purchases/run', { date: thu })).added, []);
  // الجمعة: قائمة الجمعة
  const fri = '2026-10-16';
  await call('POST', '/api/fixed-purchases/run', { date: fri, force: true });
  ps = await ofDay(fri);
  assert.strictEqual(ps.find(p => p.supplier === 'ام محمد ث').total, 150);
  assert.strictEqual(ps.find(p => p.supplier === 'كدر ث').total, 50);
});
