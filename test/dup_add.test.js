'use strict';
// 🔁 «أضفت» نفس الكمية مرتين خلال نص ساعة: الثانية تسأل (needForce) — ومع force تنحسب
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-dup-'));
  const port = 48300 + Math.floor(Math.random() * 90); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir }, stdio: 'inherit' });
  for (let i = 0; i < 100; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  today = (await req(T, 'GET', '/api/me')).today;
});
test.after(() => srv.kill());

test('same add twice asks before counting it again', async () => {
  const { id } = await req(T, 'POST', '/api/items', { name: 'قوار مكرر', unit: 'كجم', daily: 1, kind: 'raw', no_opening: true });
  await req(T, 'POST', '/api/add', { date: today, item_id: id, qty: 4 });
  await assert.rejects(req(T, 'POST', '/api/add', { date: today, item_id: id, qty: 4 }), e => e.status === 409 && /مرة ثانية/.test(e.message));
  await req(T, 'POST', '/api/add', { date: today, item_id: id, qty: 3 }); // كمية ثانية تمشي عادي
  await req(T, 'POST', '/api/add', { date: today, item_id: id, qty: 4, force: true });
  const row = (await req(T, 'GET', '/api/board?date=' + today)).rows.find(x => x.item_id === id);
  assert.strictEqual(row.added, 11);
});
