'use strict';
// 🖼️ أيقونة الصنف (إيموجي) وصورته تطلع في الجرد
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-ico-'));
  const port = 44000 + Math.floor(Math.random() * 400); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
});
test.after(() => srv.kill());

test('item icon (emoji) and photo are saved and shown on the board', async () => {
  const { id } = await call('POST', '/api/items', { name: 'حريد ت', unit: 'كجم', daily: 1, kind: 'raw', icon: '🐟' });
  const today = (await call('GET', '/api/me')).today;
  let row = (await call('GET', '/api/board?date=' + today)).rows.find(r => r.item_id === id);
  assert.strictEqual(row.icon, '🐟'); assert.strictEqual(row.photo, '');
  const png = 'data:image/png;base64,' + Buffer.from('fake-png').toString('base64');
  const { photo } = await call('PUT', `/api/items/${id}/photo`, { image: png });
  assert.match(photo, /\.png$/);
  row = (await call('GET', '/api/board?date=' + today)).rows.find(r => r.item_id === id);
  assert.strictEqual(row.photo, photo);
  await call('PUT', `/api/items/${id}/photo`, { image: '' });
  row = (await call('GET', '/api/board?date=' + today)).rows.find(r => r.item_id === id);
  assert.strictEqual(row.photo, '');
});
