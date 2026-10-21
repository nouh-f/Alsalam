'use strict';
// 🍯 القارورة: خلوف يصوّرها الصبح (الزيادة عن ليلة أمس = المعبّى من الدبة) ← المشرف بس يعبّي وسط اليوم ← الدعدع يصوّرها بالليل قبل التعبئة (النازل مقابل المبيوع)، والدبة خلصت => نوح وزكريا
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

let srv, B, T, WT, ST, today;
const req = async (tok, method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const call = (m, p, b) => req(T, m, p, b), wcall = (m, p, b) => req(WT, m, p, b);
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const OWN = '966500000960', BUY = '966500000962';

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-honey-'));
  const port = 46400 + Math.floor(Math.random() * 300); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir, WA_TEST_INJECT: '1' }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const login = async (id, pin) => (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: id, pin }) })).json()).token;
  T = await login(1, '1234');
  today = (await call('GET', '/api/me')).today;
  const me = (await call('GET', '/api/users')).find(x => x.id === 1);
  await call('POST', '/api/users', { id: 1, name: me.name, role: 'owner', pin: '1234', phone: '0500000960' });
  const { id: w } = await call('POST', '/api/users', { name: 'دعدع عسل', role: 'worker', pin: '9696', phone: '0500000961' });
  await call('POST', '/api/users', { name: 'مشتري عسل', role: 'purchaser', pin: '9697', phone: '0500000962' });
  const { id: sp } = await call('POST', '/api/users', { name: 'خلوف عسل', role: 'supervisor', pin: '9698', phone: '0500000963' });
  WT = await login(w, '9696'); ST = await login(sp, '9698');
  test.w = w; test.sp = sp;
});
test.after(() => srv.kill());

const waitFor = async (n0, pred) => { let ob = []; for (let i = 0; i < 80; i++) { ob = (await call('GET', '/api/whatsapp/_outbox')).slice(n0); if (pred(ob)) return ob; await new Promise(r => setTimeout(r, 50)); } return ob; };

test('Khalouf weighs in the morning (night refill comes off the tub), Dadaa weighs at night before refilling; only a supervisor refills by day', async () => {
  const w = test.w, sp = test.sp, scall = (m, p, b) => req(ST, m, p, b);
  const { id: tub } = await call('POST', '/api/items', { name: 'عسل سلام دبة ت', unit: 'كجم', daily: 1, kind: 'raw', cost: 250 });
  const { id: bot } = await call('POST', '/api/items', { name: 'عسل سلام قارورة ت', unit: 'كجم', daily: 1, kind: 'raw', carry_over: 1, sources: [{ from_item_id: tub, ratio: 1 }] });
  await call('POST', '/api/responsibility', { item_id: bot, user_id: w, opener_id: sp });
  const yday = new Date(Date.parse(today + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
  await call('POST', '/api/count', { date: yday, item_id: bot, phase: 'closing', qty: 0.2 }); // الدعدع وزنها أمس بالليل قبل التعبئة
  const board = () => call('GET', '/api/board?date=' + today), row = async () => (await board()).rows.find(r => r.item_id === bot);

  await assert.rejects(wcall('POST', '/api/count', { date: today, item_id: bot, phase: 'opening', qty: 0.5 }), /خانة 🍯|مو عليك/, 'ما ينكتب رقم عادي');
  await assert.rejects(wcall('POST', '/api/honey', { weight: 0.5 }), /صوّر/, 'لازم صورة');

  // ☀️ خلوف الصبح: 500 — بالليل كانت 200 => انعبّى 300 من الدبة
  let r = await scall('POST', '/api/honey', { weight: 0.5, image: IMG });
  assert.match(r.say, /أول اليوم: 500 جرام/); assert.match(r.say, /انعبّى بالليل 300 جرام/);
  assert.strictEqual((await row()).opening, 0.5);
  assert.strictEqual((await board()).rows.find(x => x.item_id === tub).received, -0.3);

  // الدعدع وسط اليوم ما يعبّي: أي وزن منه = آخر اليوم
  // 🌙 الدعدع بالليل: 400 => نزل 100، والمبيوع صفر => ناقص 100
  const n = (await call('GET', '/api/whatsapp/_outbox')).length;
  r = await wcall('POST', '/api/honey', { weight: 400, image: IMG }); // بالجرام
  assert.match(r.say, /آخر اليوم: 400 جرام/); assert.match(r.say, /عبّيها/);
  assert.strictEqual((await row()).closing, 0.4);
  const ob = await waitFor(n, o => o.some(x => x.to === OWN));
  assert.ok(ob.some(x => x.to === OWN && /نزل \*100 جرام\*/.test(x.text) && /ناقص \*100 جرام\*/.test(x.text) && /25 ريال/.test(x.text)), JSON.stringify(ob));
  const h = (await board()).honey;
  assert.deepStrictEqual(h.log.map(l => l.kind), ['opening', 'closing']); assert.ok(h.log.every(l => l.image));
});

test('the tub ran out => owner and buyers', async () => {
  const n = (await call('GET', '/api/whatsapp/_outbox')).length;
  await wcall('POST', '/api/honey', { empty_tub: true });
  const ob = await waitFor(n, o => o.some(x => x.to === BUY) && o.some(x => x.to === OWN));
  assert.ok(ob.some(x => x.to === BUY && /خلصت/.test(x.text)), JSON.stringify(ob));
});
