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

const login = async (id, pin) => (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: id, pin }) })).json()).token;

test('after the last night reminder, only items with nothing expected left get 0 — the ones with stock stay empty', async () => {
  const { id: w } = await call('POST', '/api/users', { name: 'ناسي جرد', role: 'worker', pin: '7070', phone: '0500000701' });
  const { id: it } = await call('POST', '/api/items', { name: 'حريد صفر', unit: 'كجم', daily: 1, kind: 'raw' });
  const { id: none } = await call('POST', '/api/items', { name: 'هامور فاضي', unit: 'كجم', daily: 1, kind: 'raw' });
  for (const x of [it, none]) await call('POST', '/api/responsibility', { item_id: x, user_id: w, opener_id: '' });
  await call('POST', '/api/count', { date: today, item_id: it, phase: 'opening', qty: 5 });
  await call('POST', '/api/count', { date: today, item_id: none, phase: 'opening', qty: 0 });
  const NIGHT = today + 'T21:30:00Z'; // ١٢:٣٠ بالليل بالسعودي
  for (let i = 0; i < 3; i++) await call('POST', '/api/whatsapp/chase', { at: NIGHT });
  const row = async id => (await call('GET', '/api/board?date=' + today)).rows.find(r => r.item_id === id);
  assert.strictEqual((await row(none)).closing, null, 'قبل آخر تذكير ما ينكتب شي');
  await call('POST', '/api/whatsapp/chase', { at: NIGHT });
  assert.strictEqual((await row(none)).closing, 0, 'ما له باقي => صفر');
  assert.strictEqual((await row(it)).closing, null, 'المفروض باقي 5 => ما نخمّن');
  assert.strictEqual((await row(it)).zero_ok, 0);
});

test('a worker counting an item with no stock alerts the owner and the item counter, once a day', async () => {
  const { id: w } = await call('POST', '/api/users', { name: 'سماك', role: 'worker', pin: '7171', phone: '0500000702' });
  const { id: it } = await call('POST', '/api/items', { name: 'حريد بدون', unit: 'كجم', daily: 1, kind: 'raw', no_opening: 1 });
  const { id: ok } = await call('POST', '/api/items', { name: 'حريد معه', unit: 'كجم', daily: 1, kind: 'raw' });
  for (const x of [it, ok]) await call('POST', '/api/responsibility', { item_id: x, user_id: w, opener_id: '' });
  await call('POST', '/api/count', { date: today, item_id: ok, phase: 'opening', qty: 4 });
  const WT = await login(w, '7171');
  const wcall = async (p, body) => { const r = await fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + WT }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };
  const before = (await call('GET', '/api/whatsapp/_outbox')).length;
  await wcall('/api/count', { date: today, item_id: it, phase: 'closing', qty: 5 });
  await wcall('/api/count', { date: today, item_id: ok, phase: 'closing', qty: 3 });
  await new Promise(r => setTimeout(r, 300));
  const ob = (await call('GET', '/api/whatsapp/_outbox')).slice(before);
  assert.ok(ob.some(x => x.to === OWN && /سماك دخّل حريد بدون 5 كجم/.test(x.text) && /بدون مخزون — فسّرها/.test(x.text)), JSON.stringify(ob));
  assert.ok(ob.some(x => x.to === '966500000702' && /حريد بدون 5 كجم/.test(x.text) && /\+ أضفت/.test(x.text)));
  assert.ok(!ob.some(x => /حريد معه/.test(x.text)), 'له أول يوم => ما فيه تنبيه');
  assert.ok(!ob.some(x => /ريال/.test(x.text)));
});
