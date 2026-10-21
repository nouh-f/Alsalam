'use strict';
// ↩️ العامل يصلّح غلطته اليوم: يعدّل «أضفت» أو استلامه (ينتظر الحساب) — ونوح يدري لو نقص كثير؛ وما يلمس حركة غيره
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

let srv, B, T;
const req = async (tok, method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const login = async (id, pin) => (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: id, pin }) })).json()).token;

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-undo-'));
  const port = 39500 + Math.floor(Math.random() * 400); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir, WA_TEST_INJECT: '1' }, stdio: 'inherit' });
  for (let i = 0; i < 80; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = await login(1, '1234');
});
test.after(() => srv.kill());

test('worker fixes own add and own receive today; owner told on a big cut; cannot touch another worker\'s move', async () => {
  const me = (await req(T, 'GET', '/api/users')).find(x => x.id === 1);
  await req(T, 'POST', '/api/users', { id: 1, name: me.name, role: 'owner', pin: '1234', phone: '0500000970' });
  const { id: w } = await req(T, 'POST', '/api/users', { name: 'عامل تراجع', role: 'worker', pin: '8181' });
  const { id: w2 } = await req(T, 'POST', '/api/users', { name: 'عامل ثاني', role: 'worker', pin: '8282' });
  const WT = await login(w, '8181'), W2 = await login(w2, '8282');
  const { id: it } = await req(T, 'POST', '/api/items', { name: 'هامور تراجع', unit: 'كجم', daily: 1, kind: 'raw', carry_over: 1 });
  await req(T, 'POST', '/api/responsibility', { item_id: it, user_id: w, opener_id: w });
  const today = (await req(WT, 'GET', '/api/me')).today;
  const row = async () => (await req(T, 'GET', '/api/board?date=' + today)).rows.find(r => r.item_id === it);

  // + أضفت 50 بالغلط => يعدّلها 5
  await req(WT, 'POST', '/api/add', { date: today, item_id: it, qty: 50, force: true });
  const mv = (await req(WT, 'GET', '/api/moves?date=' + today)).find(m => m.item_id === it && m.qty > 0);
  await assert.rejects(req(W2, 'PATCH', '/api/moves/' + mv.id, { qty: 1 }), /حركتك/);
  const n0 = (await req(T, 'GET', '/api/whatsapp/_outbox')).length;
  await req(WT, 'PATCH', '/api/moves/' + mv.id, { qty: 5 });
  assert.strictEqual((await row()).added, 5);
  let ob = [];
  for (let i = 0; i < 60; i++) { ob = (await req(T, 'GET', '/api/whatsapp/_outbox')).slice(n0); if (ob.length) break; await new Promise(r => setTimeout(r, 50)); }
  assert.ok(ob.some(x => x.to === '966500000970' && /عامل تراجع عدّل أضاف هامور تراجع من 50 إلى 5/.test(x.text)), JSON.stringify(ob));

  // 📦 استلام 40 بالغلط => 4
  await req(WT, 'POST', '/api/receive', { date: today, supplier: 'مورد تراجع', lines: [{ item_id: it, qty: 40 }] });
  const mine = await req(WT, 'GET', '/api/receive/mine');
  assert.strictEqual(mine.length, 1); assert.strictEqual(mine[0].qty, 40);
  await req(WT, 'PATCH', '/api/receive/line', { purchase_id: mine[0].purchase_id, item_id: it, qty: 4 });
  assert.strictEqual((await req(WT, 'GET', '/api/receive/mine'))[0].qty, 4);
  await assert.rejects(req(W2, 'PATCH', '/api/receive/line', { purchase_id: mine[0].purchase_id, item_id: it, qty: 1 }), /استلامك/);
});
