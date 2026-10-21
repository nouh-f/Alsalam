'use strict';
// 🔢 بيبسي وموية: ينعد آخر الليل بس (المحل علبة + فوق كرتون×24) — العامل ما عنده «أضفت»، والشراء يدخل المحل على طول
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-cnt-'));
  const port = 48500 + Math.floor(Math.random() * 90); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir }, stdio: 'inherit' });
  for (let i = 0; i < 100; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  today = (await req(T, 'GET', '/api/me')).today;
});
test.after(() => srv.kill());

test('count-only item: worker cannot «أضفت»; purchases go straight in; night count = shop + cartons upstairs; sold = the difference', async () => {
  const { id: w } = await req(T, 'POST', '/api/users', { name: 'عبدالله مشروبات', role: 'worker', pin: '5151' });
  const WT = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: w, pin: '5151' }) })).json()).token;
  const { id } = await req(T, 'POST', '/api/items', { name: 'بيبسي عد', unit: 'علبة', daily: 1, kind: 'raw', no_opening: true, carry_over: true, buy_store: false, count_only: true,
    parts: [{ name: 'المحل (علبة)', factor: 1, drop: false }, { name: 'فوق (كرتون)', factor: 24, drop: false }] });
  await req(T, 'POST', '/api/responsibility', { item_ids: [id], user_id: w });
  await assert.rejects(req(WT, 'POST', '/api/add', { date: today, item_id: id, qty: 48 }), e => e.status === 403 && /ما له «أضفت»/.test(e.message));
  await req(T, 'POST', '/api/purchases', { date: today, payment: 'cash', lines: [{ item_id: id, qty: 20, unit: 'كرتون', factor: 24, line_total: 400 }] });
  await req(WT, 'POST', '/api/count', { date: today, item_id: id, phase: 'closing', parts: { 'المحل (علبة)': 30, 'فوق (كرتون)': 18 } });
  const row = (await req(T, 'GET', '/api/board?date=' + today)).rows.find(x => x.item_id === id);
  assert.strictEqual(row.count_only, 1);
  assert.strictEqual(row.received, 480, 'الشراء دخل المحل على طول');
  assert.strictEqual(row.closing, 462, '30 + 18×24');
  assert.strictEqual(row.actual, 18, 'انصرف 18 علبة');
});
