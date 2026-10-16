'use strict';
// 📦 كرتون ← حبات (أبو عصاية): صنفه يطلع له «فكيت كرتون» مو «قسّم ذبيحة» — و🐑 بس للي عليه لحم
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

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-carton-'));
  const port = 47100 + Math.floor(Math.random() * 300); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = await login(1, '1234');
  today = (await req(T, 'GET', '/api/me')).today;
});
test.after(() => srv.kill());

test('carton worker: split_pack on the row, opening a carton adds the pieces, no meat split screens', async () => {
  const { id: w } = await req(T, 'POST', '/api/users', { name: 'صادق ك', role: 'worker', pin: '7171' });
  const { id: box } = await req(T, 'POST', '/api/items', { name: 'كرتون عصاية ك', unit: 'كرتون', daily: 0, kind: 'raw' });
  const { id: fish } = await req(T, 'POST', '/api/items', { name: 'أبو عصاية ك', unit: 'حبة', daily: 1, kind: 'raw' });
  await req(T, 'POST', '/api/splits/link', { item_id: box, outputs: [fish] });
  await req(T, 'POST', '/api/responsibility', { item_id: fish, user_id: w });
  const WT = await login(w, '7171');
  const me = await req(WT, 'GET', '/api/me');
  assert.strictEqual(me.split_meat, false);
  let row = (await req(WT, 'GET', '/api/board?date=' + today)).rows.find(r => r.item_id === fish);
  assert.deepStrictEqual(row.split_pack, { id: box, name: 'كرتون عصاية ك' });
  await req(WT, 'POST', '/api/split', { date: today, item_id: box, qty: 1, outputs: [{ item_id: fish, qty: 24 }] });
  row = (await req(T, 'GET', '/api/board?date=' + today)).rows.find(r => r.item_id === fish);
  assert.strictEqual(row.received, 24); assert.strictEqual(row.upstairs, 0);
  assert.strictEqual((await req(T, 'GET', '/api/me')).split_meat, true, 'المشرف يشوف التقسيم');
});
