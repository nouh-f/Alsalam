'use strict';
// 🐟 ملخص السمك لنوح + 🍽️ أكل الشباب (ما ينحسب نقص، فوق الحد نوح يدري) + 📉 الناقص في التقرير الأسبوعي
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let srv, B, T;
const req = async (tok, method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const login = async (id, pin) => (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: id, pin }) })).json()).token;
const OWN = '966500000990';

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-fsum-'));
  const port = 40500 + Math.floor(Math.random() * 400); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir, WA_TEST_INJECT: '1' }, stdio: 'inherit' });
  for (let i = 0; i < 80; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = await login(1, '1234');
});
test.after(() => srv.kill());

test('staff meal is not a shortage (owner told over the limit); nightly fish summary; weekly report has meals', async () => {
  const me = (await req(T, 'GET', '/api/users')).find(x => x.id === 1);
  await req(T, 'POST', '/api/users', { id: 1, name: me.name, role: 'owner', pin: '1234', phone: '0500000990' });
  const { id: w } = await req(T, 'POST', '/api/users', { name: 'محمد ملخص', role: 'worker', pin: '8484' });
  const WT = await login(w, '8484');
  const { id: fish } = await req(T, 'POST', '/api/items', { name: 'هامور ملخص', unit: 'كجم', daily: 1, kind: 'raw', carry_over: 1, leftover: 'fridge', buy_store: true, no_opening: true, cost: 40 });
  await req(T, 'POST', '/api/responsibility', { item_id: fish, user_id: w });
  const today = (await req(WT, 'GET', '/api/me')).today;
  await req(T, 'POST', '/api/purchases', { date: today, supplier: 'دعدع', payment: 'cash', lines: [{ item_id: fish, qty: 20, unit_price: 40, to_floor: false }] });
  await req(WT, 'POST', '/api/add', { date: today, item_id: fish, qty: 5, source: 'fridge' });

  // 🍽️ أكل ١ كيلو (٤٠ ريال > الحد ٢٥) => نوح يدري، وما ينحسب نقص
  const n0 = (await req(T, 'GET', '/api/whatsapp/_outbox')).length;
  await assert.rejects(req(WT, 'POST', '/api/transfer', { date: today, item_id: fish, qty: 1, mode: 'meal' }), /صوّر الأكل/);
  await req(WT, 'POST', '/api/transfer', { date: today, item_id: fish, qty: 1, mode: 'meal', note: 'فؤاد', image: IMG });
  let ob = [];
  for (let i = 0; i < 60; i++) { ob = (await req(T, 'GET', '/api/whatsapp/_outbox')).slice(n0); if (ob.some(x => /أكل الشباب/.test(x.text))) break; await new Promise(r => setTimeout(r, 50)); }
  assert.ok(ob.some(x => x.to === OWN && /محمد ملخص سجّل أكل الشباب اليوم بـ 40 ريال/.test(x.text)), JSON.stringify(ob));
  await req(WT, 'POST', '/api/count', { date: today, item_id: fish, phase: 'closing', qty: 4 });
  const row = (await req(T, 'GET', '/api/board?date=' + today)).rows.find(r => r.item_id === fish);
  assert.strictEqual(row.meal, 1); assert.strictEqual(row.diff, 0, 'الأكل ما هو نقص');

  // 🐟 الملخص
  const s = await req(T, 'POST', '/api/whatsapp/fish-summary', {});
  assert.match(s.text, /هامور ملخص: نزل 5 · انباع 0 · باقي 4 · انرمى 1 · مضبوط ✓/);

  // 📊 التقرير الأسبوعي فيه أكل الشباب
  const wk = await req(T, 'POST', '/api/whatsapp/weekly', {});
  assert.ok(wk.sent.some(t => /🍽️ أكل الشباب: محمد ملخص 40 ريال/.test(t)), JSON.stringify(wk.sent));
});
