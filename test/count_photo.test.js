'use strict';
// 📷 آخر الدوام بالصورة: العامل ما يحفظ باقي بدون صورة (الصفر عادي)، والوزن ينقرا من صورة الميزان؛ والصنف «ما فيه» ما يطلع ناقص
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const U = { input_tokens: 1, output_tokens: 1 };
const say = text => ({ stop_reason: 'end_turn', usage: U, content: [{ type: 'text', text }] });
let srv, B, T, FX;
const req = async (tok, method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-cp-'));
  FX = path.join(dir, 'ai.json');
  fs.writeFileSync(FX, JSON.stringify([say('{"reading": 5.2, "unit": "kg"}'), say('{"reading": null, "unit": null}'), say('{"reading": null, "unit": null}')]));
  const port = 39000 + Math.floor(Math.random() * 900); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir, AI_FIXTURE: FX, COUNT_PHOTO: '1', COUNT_WINDOW: '0' }, stdio: 'inherit' });
  for (let i = 0; i < 80; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  await req(T, 'POST', '/api/settings', { anthropic_key: 'sk-test' });
});
test.after(() => srv.kill());

test('worker: closing needs a photo (zero does not); scale photo is read; empty item is not missing', async () => {
  const { id: w } = await req(T, 'POST', '/api/users', { name: 'عامل صورة', role: 'worker', pin: '7171' });
  const WT = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: w, pin: '7171' }) })).json()).token;
  const mk = async (name, unit) => {
    const { id } = await req(T, 'POST', '/api/items', { name, unit, daily: 1, kind: 'raw', carry_over: 1 });
    await req(T, 'POST', '/api/responsibility', { item_id: id, user_id: w, opener_id: w });
    return id;
  };
  const fish = await mk('سمك صورة', 'كجم'), bread = await mk('خبز صورة', 'حبة'), none = await mk('صنف فاضي', 'حبة');
  await req(T, 'PUT', '/api/items/' + fish + '/units', { units: [] });
  const today = (await req(WT, 'GET', '/api/me')).today;
  assert.strictEqual((await req(WT, 'GET', '/api/me')).count_photo, true);
  await req(T, 'POST', '/api/count', { date: today, item_id: bread, phase: 'opening', qty: 10 });
  await req(T, 'POST', '/api/count', { date: today, item_id: fish, phase: 'opening', qty: 8 });

  // بدون صورة => ينحفظ الرقم (الصورة ما توقف الجرد) ويطلع «صوّر الباقي»؛ بالصورة => الصورة معه؛ الصفر بدون صورة عادي
  assert.strictEqual((await req(WT, 'POST', '/api/count', { date: today, item_id: bread, phase: 'closing', qty: 4 })).need_photo, true);
  await req(WT, 'POST', '/api/count', { date: today, item_id: bread, phase: 'closing', qty: 4, image: IMG });
  const row = id => req(T, 'GET', '/api/board?date=' + today).then(b => b.rows.find(r => r.item_id === id));
  assert.ok((await row(bread)).closing_image, 'الصورة انحفظت');

  // ⚖️ صورة الميزان => الوزن (ناقص الوعاء لو فيه)، وبعدها يحفظ بالصورة
  const rd = await req(WT, 'POST', '/api/count/read', { item_id: fish, image: IMG });
  assert.strictEqual(rd.weight, 5.2);
  await req(WT, 'POST', '/api/count', { date: today, item_id: fish, phase: 'closing', qty: rd.weight, net: true, image: IMG });
  assert.strictEqual((await row(fish)).closing, 5.2);
  // ما انقرى => unreadable
  assert.ok((await req(WT, 'POST', '/api/count/read', { item_id: fish, image: IMG })).unreadable);

  // 🐟 «ما فيه»: ما يطلع ناقص عليه
  const r0 = await row(none);
  assert.strictEqual(r0.empty, 1);
  const todo = await req(WT, 'GET', '/api/dashboard');
  assert.ok(!JSON.stringify(todo).includes('صنف فاضي'), 'الفاضي ما يطلع في المطلوب');
  await req(WT, 'POST', '/api/count', { date: today, item_id: none, phase: 'closing', qty: 0 });
});
