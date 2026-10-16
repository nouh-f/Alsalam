'use strict';
// 🍯 القارورة من الرابط (صورة + وزن): الصبح (ناقص عن أمس = من الليل) ← فل (المعبّى من الدبة) ← آخر الدوام (النازل مقابل المبيوع)، والدبة خلصت => نوح وزكريا
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

let srv, B, T, WT, today;
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
  WT = await login(w, '9696');
  test.w = w;
});
test.after(() => srv.kill());

const waitFor = async (n0, pred) => { let ob = []; for (let i = 0; i < 80; i++) { ob = (await call('GET', '/api/whatsapp/_outbox')).slice(n0); if (pred(ob)) return ob; await new Promise(r => setTimeout(r, 50)); } return ob; };

test('morning vs last night, refill from the tub, end of day used vs sold, empty tub alert — all from the link', async () => {
  const w = test.w;
  const { id: tub } = await call('POST', '/api/items', { name: 'عسل سلام دبة ت', unit: 'كجم', daily: 1, kind: 'raw', cost: 250 });
  const { id: bot } = await call('POST', '/api/items', { name: 'عسل سلام قارورة ت', unit: 'كجم', daily: 1, kind: 'raw', carry_over: 1, sources: [{ from_item_id: tub, ratio: 1 }] });
  await call('POST', '/api/responsibility', { item_id: bot, user_id: w, opener_id: w });
  const yday = new Date(Date.parse(today + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
  await call('POST', '/api/count', { date: yday, item_id: bot, phase: 'closing', qty: 0.52 });
  const row = async () => (await call('GET', '/api/board?date=' + today)).rows.find(r => r.item_id === bot);

  await assert.rejects(wcall('POST', '/api/count', { date: today, item_id: bot, phase: 'opening', qty: 0.5 }), /خانة 🍯/, 'ما ينكتب رقم عادي');
  await assert.rejects(wcall('POST', '/api/honey', { weight: 0.5 }), /صوّر/, 'لازم صورة');

  let n = (await call('GET', '/api/whatsapp/_outbox')).length;
  let r = await wcall('POST', '/api/honey', { weight: 0.5, image: IMG });
  assert.match(r.say, /أول اليوم: 500 جرام/); assert.strictEqual(r.honey.step, 'fill');
  let ob = await waitFor(n, o => o.some(x => x.to === OWN));
  assert.ok(ob.some(x => x.to === OWN && /ناقصة 20 جرام بالليل/.test(x.text)), JSON.stringify(ob));
  assert.strictEqual((await row()).opening, 0.5);

  r = await wcall('POST', '/api/honey', { weight: 800, image: IMG }); // بالجرام
  assert.match(r.say, /عبّيت 300 جرام/);
  assert.strictEqual((await row()).received, 0.3);
  assert.strictEqual((await call('GET', '/api/board?date=' + today)).rows.find(x => x.item_id === tub).received, -0.3);

  n = (await call('GET', '/api/whatsapp/_outbox')).length;
  r = await wcall('POST', '/api/honey', { weight: 0.7, image: IMG, end: true });
  assert.match(r.say, /نزل \*100 جرام\*/); assert.match(r.say, /ناقص \*100 جرام\*/); assert.doesNotMatch(r.say, /ريال/);
  assert.strictEqual((await row()).closing, 0.7);
  ob = await waitFor(n, o => o.some(x => x.to === OWN));
  assert.ok(ob.some(x => x.to === OWN && /ناقص \*100 جرام\*/.test(x.text) && /25 ريال/.test(x.text)), JSON.stringify(ob));
  const h = (await call('GET', '/api/board?date=' + today)).honey;
  assert.deepStrictEqual(h.log.map(l => l.kind), ['opening', 'fill', 'closing']); assert.ok(h.log.every(l => l.image));

  n = (await call('GET', '/api/whatsapp/_outbox')).length;
  await wcall('POST', '/api/honey', { empty_tub: true });
  ob = await waitFor(n, o => o.some(x => x.to === BUY) && o.some(x => x.to === OWN));
  assert.ok(ob.some(x => x.to === BUY && /خلصت/.test(x.text)), JSON.stringify(ob));
});
