'use strict';
// 🍯 القارورة: الصبح (ناقص عن أمس = من الليل) ← فل (المعبّى من الدبة) ← آخر الدوام (النازل مقابل المبيوع)، والدبة خلصت => نوح وزكريا
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
const U = { input_tokens: 1, output_tokens: 1 };
const hb = (id, input) => [{ stop_reason: 'tool_use', usage: U, content: [{ type: 'tool_use', id, name: 'honey_bottle', input: { weight: null, empty_tub: false, end: false, ...input } }] },
  { stop_reason: 'end_turn', usage: U, content: [{ type: 'text', text: 'تمام' }] }];
const OWN = '966500000960', W = '966500000961', BUY = '966500000962';

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-honey-'));
  const FX = path.join(dir, 'ai.json');
  fs.writeFileSync(FX, JSON.stringify([...hb('h1', { weight: 0.5 }), ...hb('h2', { weight: 0.8 }), ...hb('h3', { weight: 0.7, end: true }), ...hb('h4', { empty_tub: true })]));
  const port = 46400 + Math.floor(Math.random() * 300); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir, AI_FIXTURE: FX, WA_TEST_INJECT: '1' }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  today = (await call('GET', '/api/me')).today;
  await call('POST', '/api/settings', { anthropic_key: 'sk-test' });
  const me = (await call('GET', '/api/users')).find(x => x.id === 1);
  await call('POST', '/api/users', { id: 1, name: me.name, role: 'owner', pin: '1234', phone: '0500000960' });
});
test.after(() => srv.kill());

const waitFor = async (n0, pred) => { let ob = []; for (let i = 0; i < 80; i++) { ob = (await call('GET', '/api/whatsapp/_outbox')).slice(n0); if (pred(ob)) return ob; await new Promise(r => setTimeout(r, 50)); } return ob; };

test('morning photo vs last night, refill from the tub, end of day used vs sold, empty tub alert', async () => {
  const { id: w } = await call('POST', '/api/users', { name: 'دعدع عسل', role: 'worker', pin: '9696', phone: '0500000961' });
  await call('POST', '/api/users', { name: 'مشتري عسل', role: 'purchaser', pin: '9697', phone: '0500000962' });
  const { id: tub } = await call('POST', '/api/items', { name: 'عسل سلام دبة ت', unit: 'كجم', daily: 1, kind: 'raw', cost: 250 });
  const { id: bot } = await call('POST', '/api/items', { name: 'عسل سلام قارورة ت', unit: 'كجم', daily: 1, kind: 'raw', carry_over: 1, sources: [{ from_item_id: tub, ratio: 1 }] });
  await call('POST', '/api/responsibility', { item_id: bot, user_id: w, opener_id: w });
  const yday = new Date(Date.parse(today + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
  await call('POST', '/api/count', { date: yday, item_id: bot, phase: 'closing', qty: 0.52 });
  await call('POST', '/api/count', { date: today, item_id: tub, phase: 'opening', qty: 3 });
  const row = async () => (await call('GET', '/api/board?date=' + today)).rows.find(r => r.item_id === bot);

  let n = (await call('GET', '/api/whatsapp/_outbox')).length;
  await call('POST', '/api/whatsapp/_inject', { id: 'w1', phone: W, chat: W, text: 'شوف الصورة' });
  let ob = await waitFor(n, o => o.some(x => x.to === W) && o.some(x => x.to === OWN));
  assert.ok(ob.some(x => x.to === W && /أول اليوم: 500 جرام/.test(x.text) && /فل/.test(x.text)), JSON.stringify(ob));
  assert.ok(ob.some(x => x.to === OWN && /ناقصة 20 جرام بالليل/.test(x.text)));
  assert.strictEqual((await row()).opening, 0.5);

  n = (await call('GET', '/api/whatsapp/_outbox')).length;
  await call('POST', '/api/whatsapp/_inject', { id: 'w2', phone: W, chat: W, text: 'شوف الصورة' });
  ob = await waitFor(n, o => o.some(x => x.to === W));
  assert.ok(ob.some(x => x.to === W && /عبّيت 300 جرام/.test(x.text)), JSON.stringify(ob));
  assert.strictEqual((await row()).received, 0.3);
  assert.strictEqual((await call('GET', '/api/board?date=' + today)).rows.find(r => r.item_id === tub).received, -0.3);

  n = (await call('GET', '/api/whatsapp/_outbox')).length;
  await call('POST', '/api/whatsapp/_inject', { id: 'w3', phone: W, chat: W, text: 'آخر الدوام' });
  ob = await waitFor(n, o => o.some(x => x.to === W) && o.some(x => x.to === OWN));
  assert.strictEqual((await row()).closing, 0.7);
  assert.ok(ob.some(x => x.to === W && /نزل \*100 جرام\*/.test(x.text) && /ناقص \*100 جرام\*/.test(x.text) && !/ريال/.test(x.text)), JSON.stringify(ob));
  assert.ok(ob.some(x => x.to === OWN && /ناقص \*100 جرام\*/.test(x.text) && /25 ريال/.test(x.text)));

  n = (await call('GET', '/api/whatsapp/_outbox')).length;
  await call('POST', '/api/whatsapp/_inject', { id: 'w4', phone: W, chat: W, text: 'العسل خلص' });
  ob = await waitFor(n, o => o.some(x => x.to === BUY) && o.some(x => x.to === OWN));
  assert.ok(ob.some(x => x.to === BUY && /خلصت/.test(x.text)), JSON.stringify(ob));
  assert.ok(ob.some(x => x.to === OWN && /خلصت/.test(x.text)));
});
