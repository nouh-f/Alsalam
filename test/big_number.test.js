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
  // ⚖️ بالجرام والمعقول بالكيلو => يتصلّح لحاله بدون سؤال
  const fx = await req(T, 'POST', '/api/add', { date: today, item_id: id, qty: 5130 });
  assert.match(fx.fixed, /انحفظ 5.13 كجم/);
  await req(T, 'POST', '/api/add', { date: today, item_id: id, qty: 4 }); // عادي
  // كبير مرة حتى بعد ÷١٠٠٠ ما يركب (عدد بالحبة) => سؤال
  const { id: pc } = await req(T, 'POST', '/api/items', { name: 'علب كبير', unit: 'حبة', daily: 1, kind: 'raw', no_opening: true });
  await req(T, 'POST', '/api/add', { date: today, item_id: pc, qty: 10 });
  await assert.rejects(req(T, 'POST', '/api/add', { date: today, item_id: pc, qty: 500 }), e => e.status === 409 && /المعتاد 10/.test(e.message));
  await req(T, 'POST', '/api/add', { date: today, item_id: pc, qty: 500, force: true });
  const cf = await req(T, 'POST', '/api/count', { date: today, item_id: id, phase: 'closing', qty: 9000 });
  assert.strictEqual(cf.saved, 9);
  await req(T, 'POST', '/api/count', { date: today, item_id: id, phase: 'closing', qty: 9 });
  const row = (await req(T, 'GET', '/api/board?date=' + today)).rows.find(x => x.item_id === id);
  assert.strictEqual(row.added, 15.13); assert.strictEqual(row.closing, 9);
  // 📦 العامل ما يسجل بالكرتون
  const { id: w } = await req(T, 'POST', '/api/users', { name: 'عامل كرتون', role: 'worker', pin: '6161' });
  await req(T, 'POST', '/api/responsibility', { item_ids: [pc], user_id: w });
  const WT = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: w, pin: '6161' }) })).json()).token;
  await assert.rejects(req(WT, 'POST', '/api/add', { date: today, item_id: pc, qty: 2, unit: 'كرتون' }), e => e.status === 400 && /الكرتون للمشرف/.test(e.message));
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
