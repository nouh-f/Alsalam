'use strict';
// 🔢 رقم كبير مرة (٥١٣٠ بدل ٥.١٣ كيلو) => سؤال فيه الاقتراح، ومع force ينحفظ — و🌅 ملخص أخطاء الأمس للمشرفين
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-big-'));
  const port = 48400 + Math.floor(Math.random() * 90); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir, WA_TEST_INJECT: '1' }, stdio: 'inherit' });
  for (let i = 0; i < 100; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  today = (await req(T, 'GET', '/api/me')).today;
});
test.after(() => srv.kill());

test('a huge number asks first (grams => kg suggestion); force saves; normal numbers pass', async () => {
  const { id } = await req(T, 'POST', '/api/items', { name: 'هامور كبير', unit: 'كجم', daily: 1, kind: 'raw', no_opening: true });
  await req(T, 'POST', '/api/add', { date: today, item_id: id, qty: 6 });
  await assert.rejects(req(T, 'POST', '/api/add', { date: today, item_id: id, qty: 5130 }), e => e.status === 409 && /يمكن قصدك 5.13/.test(e.message));
  await req(T, 'POST', '/api/add', { date: today, item_id: id, qty: 4 }); // عادي
  await req(T, 'POST', '/api/add', { date: today, item_id: id, qty: 5.13, net: true, force: true });
  await assert.rejects(req(T, 'POST', '/api/count', { date: today, item_id: id, phase: 'closing', qty: 9000 }), e => e.status === 409);
  await req(T, 'POST', '/api/count', { date: today, item_id: id, phase: 'closing', qty: 9 });
  const row = (await req(T, 'GET', '/api/board?date=' + today)).rows.find(x => x.item_id === id);
  assert.strictEqual(row.added, 15.13); assert.strictEqual(row.closing, 9);
});

test('🌅 morning summary for supervisors lists yesterday items with no closing count', async () => {
  const { id: sup } = await req(T, 'POST', '/api/users', { name: 'خلوف صباح', role: 'supervisor', pin: '7171', phone: '0500000771' });
  await req(T, 'POST', '/api/settings', { wa_sup_morning: String(sup) });
  const { id } = await req(T, 'POST', '/api/items', { name: 'برم صباح', unit: 'حبة', daily: 1, kind: 'raw', no_opening: true });
  const y = new Date(Date.parse(today + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
  await req(T, 'POST', '/api/add', { date: y, item_id: id, qty: 5 });
  const r = await req(T, 'POST', '/api/whatsapp/sup-morning', {});
  assert.match(r.text, /ما انجرد آخر الليل/); assert.match(r.text, /برم صباح/);
  assert.ok((await req(T, 'GET', '/api/whatsapp/_outbox')).some(x => x.to === '966500000771' && /برم صباح/.test(x.text)));
});
