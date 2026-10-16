'use strict';
// 🌅 ينجرد الصبح بس (حلبة، طحينة…): اللي يسويه يأكد الكمية الصبح — تصير آخر أمس، والنقص يوصل نوح، وما فيه جرد بالليل
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

let srv, B, T, today;
const req = async (tok, method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const login = async (id, pin) => (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: id, pin }) })).json()).token;
const OWN = '966500000990';

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-morning-'));
  const port = 48100 + Math.floor(Math.random() * 90); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir, WA_TEST_INJECT: '1' }, stdio: 'inherit' });
  for (let i = 0; i < 100; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = await login(1, '1234');
  today = (await req(T, 'GET', '/api/me')).today;
  const me = (await req(T, 'GET', '/api/users')).find(x => x.id === 1);
  await req(T, 'POST', '/api/users', { id: 1, name: me.name, role: 'owner', pin: '1234', phone: '0500000990' });
});
test.after(() => srv.kill());

test('morning count becomes last night\'s remaining; shortage goes to Nouh; no night count for the worker', async () => {
  const { id: w } = await req(T, 'POST', '/api/users', { name: 'صانع حلبة', role: 'worker', pin: '5252' });
  const { id: it } = await req(T, 'POST', '/api/items', { name: 'حلبة صبح', unit: 'حبة', daily: 1, kind: 'raw', cost: 3, leftover: 'stay', morning_only: true });
  await req(T, 'POST', '/api/responsibility', { item_id: it, user_id: w });
  const yday = new Date(Date.parse(today + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
  await req(T, 'POST', '/api/count', { date: yday, item_id: it, phase: 'opening', qty: 10 });
  let row = (await req(T, 'GET', '/api/board?date=' + today)).rows.find(r => r.item_id === it);
  assert.strictEqual(row.opening_user_id, w); assert.strictEqual(row.closing_user_id, null); assert.strictEqual(row.morning_only, 1);
  const WT = await login(w, '5252');
  await assert.rejects(req(WT, 'POST', '/api/count', { date: today, item_id: it, phase: 'closing', qty: 7 }), /الصبح بس/);
  const n0 = (await req(T, 'GET', '/api/whatsapp/_outbox')).length;
  await req(WT, 'POST', '/api/count', { date: today, item_id: it, phase: 'opening', qty: 7 });
  const y = (await req(T, 'GET', '/api/board?date=' + yday)).rows.find(r => r.item_id === it);
  assert.strictEqual(y.closing, 7); assert.strictEqual(y.diff, 3);
  let ob = [];
  for (let i = 0; i < 40; i++) { ob = (await req(T, 'GET', '/api/whatsapp/_outbox')).slice(n0).filter(x => x.to === OWN); if (ob.length) break; await new Promise(r => setTimeout(r, 50)); }
  assert.ok(ob.some(x => /حلبة صبح/.test(x.text) && /ناقص \*3 حبة\*/.test(x.text)), JSON.stringify(ob));
});
