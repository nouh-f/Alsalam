'use strict';
// ⚖️ وزن الوعاء (سلة 1.44): ينطرح في «أضفت» وفي الجرد للأصناف اللي بالكيلو — والحبة ما تتأثر
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
test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-tare-'));
  const port = 48200 + Math.floor(Math.random() * 90); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir }, stdio: 'inherit' });
  for (let i = 0; i < 100; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  today = (await req(T, 'GET', '/api/me')).today;
});
test.after(() => srv.kill());

test('basket weight comes off «أضفت» and the count for kg items only', async () => {
  const { id: kg } = await req(T, 'POST', '/api/items', { name: 'قوار سلة', unit: 'كجم', daily: 1, kind: 'raw', no_opening: true, tare: 1.44 });
  const { id: pc } = await req(T, 'POST', '/api/items', { name: 'فجل سلة', unit: 'حبة', daily: 1, kind: 'raw', no_opening: true, tare: 1.44 });
  const r = await req(T, 'POST', '/api/add', { date: today, item_id: kg, qty: 5 });
  assert.strictEqual(r.net, 3.56);
  await req(T, 'POST', '/api/add', { date: today, item_id: pc, qty: 5 });
  await assert.rejects(req(T, 'POST', '/api/add', { date: today, item_id: kg, qty: 1 }), /أقل من وزن الوعاء/);
  await req(T, 'POST', '/api/count', { date: today, item_id: kg, phase: 'closing', qty: 4 });
  const rows = (await req(T, 'GET', '/api/board?date=' + today)).rows;
  const a = rows.find(x => x.item_id === kg), b = rows.find(x => x.item_id === pc);
  assert.strictEqual(a.added, 3.56); assert.strictEqual(a.closing, 2.56);
  assert.strictEqual(b.added, 5);
});
