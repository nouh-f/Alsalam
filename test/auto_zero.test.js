'use strict';
// 0️⃣ اللي ما جرد بعد آخر تذكير: الفاضي ينكتب صفر لحاله، والصفر اللي «المفروض فيه باقي» يوصل خبره لنوح والعامل
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

let srv, B, T, today;
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const OWN = '966500000700', W = '966500000701';

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-zero-'));
  const port = 44500 + Math.floor(Math.random() * 400); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir, WA_TEST_INJECT: '1' }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  today = (await call('GET', '/api/me')).today;
  const me = (await call('GET', '/api/users')).find(x => x.id === 1);
  await call('POST', '/api/users', { id: 1, name: me.name, role: 'owner', pin: '1234', phone: '0500000700' });
});
test.after(() => srv.kill());

test('after the last night reminder, empty closing counts become 0 and the owner + worker hear about the ones that had stock', async () => {
  const { id: w } = await call('POST', '/api/users', { name: 'ناسي جرد', role: 'worker', pin: '7070', phone: '0500000701' });
  const { id: it } = await call('POST', '/api/items', { name: 'حريد صفر', unit: 'كجم', daily: 1, kind: 'raw' });
  await call('POST', '/api/responsibility', { item_id: it, user_id: w, opener_id: '' });
  await call('POST', '/api/count', { date: today, item_id: it, phase: 'opening', qty: 5 });
  const NIGHT = today + 'T21:30:00Z'; // ١٢:٣٠ بالليل بالسعودي
  const before = (await call('GET', '/api/whatsapp/_outbox')).length;
  for (let i = 0; i < 3; i++) await call('POST', '/api/whatsapp/chase', { at: NIGHT });
  assert.strictEqual((await call('GET', '/api/board?date=' + today)).rows.find(r => r.item_id === it).closing, null, 'قبل آخر تذكير ما ينكتب صفر');
  await call('POST', '/api/whatsapp/chase', { at: NIGHT });
  assert.strictEqual((await call('GET', '/api/board?date=' + today)).rows.find(r => r.item_id === it).closing, 0);
  const ob = (await call('GET', '/api/whatsapp/_outbox')).slice(before);
  assert.ok(ob.some(x => x.to === OWN && /انحط صفر/.test(x.text) && /حريد صفر \(المفروض باقي 5 كجم\)/.test(x.text)), JSON.stringify(ob));
  assert.ok(ob.some(x => x.to === W && /انحط \*صفر\* على: حريد صفر/.test(x.text) && !/ريال/.test(x.text)));
  // مرة وحدة بس
  const n = (await call('GET', '/api/whatsapp/_outbox')).length;
  await call('POST', '/api/whatsapp/chase', { at: NIGHT });
  assert.ok(!(await call('GET', '/api/whatsapp/_outbox')).slice(n).some(x => /انحط/.test(x.text)));
});
