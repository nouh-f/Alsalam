'use strict';
// 🔒 العامل يدخل جرده مرة وحدة — التعديل عند المشرف
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

let srv, B, T, today;
const req = async (method, p, body, tok = T) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const login = async (user_id, pin) => (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id, pin }) })).json()).token;
test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-once-'));
  const port = 44950 + Math.floor(Math.random() * 40); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = await login(1, '1234');
  today = (await req('GET', '/api/me')).today;
});
test.after(() => srv.kill());

test('a worker enters a count once; a second try is refused; the supervisor can fix it; split counts can be completed', async () => {
  const { id: w } = await req('POST', '/api/users', { name: 'مرة وحدة', role: 'worker', pin: '9191' });
  const { id: sup } = await req('POST', '/api/users', { name: 'مشرف مرة', role: 'supervisor', pin: '9292' });
  const { id: it } = await req('POST', '/api/items', { name: 'فول مرة', unit: 'قدر', daily: 1, kind: 'prepared' });
  const { id: dk } = await req('POST', '/api/items', { name: 'ديراك مرة', unit: 'كجم', daily: 1, kind: 'raw', parts: 'كامل, مقطّع×1.25' });
  await req('POST', '/api/responsibility', { item_ids: [it, dk], user_id: w, opener_id: '' });
  const wt = await login(w, '9191'), st = await login(sup, '9292');
  await req('POST', '/api/count', { date: today, item_id: it, phase: 'closing', qty: 3 }, wt);
  await assert.rejects(req('POST', '/api/count', { date: today, item_id: it, phase: 'closing', qty: 4 }, wt), e => e.status === 403 && /كلّم المشرف/.test(e.message));
  await req('POST', '/api/count', { date: today, item_id: it, phase: 'closing', qty: 4 }, st);
  assert.strictEqual((await req('GET', '/api/board?date=' + today)).rows.find(r => r.item_id === it).closing, 4);
  // الأجزاء: جزء جزء يكمّل، وبعدها ينقفل
  await req('POST', '/api/count', { date: today, item_id: dk, phase: 'closing', parts: { 'كامل': 5 } }, wt);
  await req('POST', '/api/count', { date: today, item_id: dk, phase: 'closing', parts: { 'كامل': 5, 'مقطّع': 2 } }, wt);
  await assert.rejects(req('POST', '/api/count', { date: today, item_id: dk, phase: 'closing', parts: { 'كامل': 6, 'مقطّع': 2 } }, wt), e => e.status === 403);
});
