'use strict';
// 🤫 الواتساب ما يلخبط العامل: الملصق والإيموجي ما لها رد، الكرت يقعد ينتظر «تمام» حتى لو المساعد سأل سؤال ثاني،
// وحد الأسئلة رسالة وحدة بس (ونوح يدري)
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const sent = [];
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && /\/PHONE1\/messages$/.test(req.url)) { sent.push(JSON.parse(b)); return res.end('{"messages":[{"id":"out"}]}'); }
    res.statusCode = 404; res.end('{}');
  });
});
let srv, B, T, today;
const SECRET = 'calm-secret';
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
let mid = 0;
const hook = (from, text) => {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ from, id: 'wamid.c' + (++mid), type: 'text', text: { body: text } }] } }] }] });
  return fetch(B + '/api/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex') }, body: raw });
};
const waitSent = async n => { for (let i = 0; i < 100 && sent.length < n; i++) await new Promise(r => setTimeout(r, 50)); assert.ok(sent.length >= n, `انتظرت ${n} رسالة، وصل ${sent.length}`); return sent[n - 1]; };
const quiet = async () => new Promise(r => setTimeout(r, 400));
const tool = (name, input) => ({ stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 't' + name, name, input }] });
const say = text => ({ stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text }] });
const W = '966500000301';

test.before(async () => {
  await new Promise(r => mock.listen(0, r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-calm-'));
  const FX = path.join(dir, 'ai.json');
  fs.writeFileSync(FX, JSON.stringify([
    tool('propose_count', { phase: 'closing', entries: [{ item: 'قشطه ت', qty: 20 }] }), say('جهزت كرت قشطه ٢٠.'),
    say('وفتة أبيض ١٤ كيس — يعني ١٤ حبة باقية؟'),
    tool('propose_count', { phase: 'closing', entries: [{ item: 'كدر ت', qty: 12 }] }), say('جهزت كرت كدر ١٢.'),
    tool('propose_move', { mode: 'prep', item: 'قوار ت', qty: 2, unit: null, note: null }), say('جهزت: قوار ٢'),
    tool('propose_count', { phase: 'opening', entries: [{ item: 'مطفي ت', qty: 9 }] }), say('جهزت: مطفي ٩'),
    tool('propose_move', { mode: 'pull', item: 'حلبة ت', qty: 50, unit: null, note: null }), say('جهزت: حلبة ٥٠'),
    tool('propose_move', { mode: 'old', item: 'حنيذ ت', qty: 2, unit: null, note: null }), say('جهزت: نزلت من القديم حنيذ ٢'),
    tool('propose_move', { mode: 'old', item: 'قارورة ت', qty: 0.6, unit: null, note: null }), say('عبّيت ٠.٦ (١.٠٦ − ٠.٤٦)'),
  ]));
  const port = 41500 + Math.floor(Math.random() * 400); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir, AI_FIXTURE: FX, WA_API_BASE: `http://127.0.0.1:${mock.address().port}`, WA_TEST_INJECT: '1' }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  today = (await call('GET', '/api/me')).today;
  await call('POST', '/api/settings', { anthropic_key: 'sk-test', wa_count_bot: '1', wa_token: 'TOK', wa_phone_id: 'PHONE1', wa_app_secret: SECRET, wa_verify_token: 'v' });
});
test.after(() => { srv.kill(); mock.close(); });

test('a card waits for «تمام» even after the assistant asks another question; stickers and emoji get no reply', async () => {
  const { id: w } = await call('POST', '/api/users', { name: 'دعدع ت', role: 'worker', pin: '7171', phone: '0500000301' });
  const { id: it } = await call('POST', '/api/items', { name: 'قشطه ت', unit: 'حبة', daily: 1, kind: 'raw' });
  await call('POST', '/api/responsibility', { item_id: it, user_id: w, opener_id: '' });
  await hook(W, 'القشطه باقي 20');
  assert.match((await waitSent(1)).text.body, /قشطه ت: 20/);
  await hook(W, 'الفته الناشف أبيض 14 كيس'); // المساعد يسأل — بدون كرت جديد
  assert.match((await waitSent(2)).text.body, /١٤ حبة/);
  await hook(W, 'تمام');
  assert.match((await waitSent(3)).text.body, /✓ اتسجل/, 'الكرت ما انمسح بالسؤال');
  assert.strictEqual((await call('GET', '/api/board?date=' + today)).rows.find(r => r.item_id === it).closing, 20);
  // ملصق وإيموجي => سكوت
  await call('POST', '/api/whatsapp/_inject', { id: 'st1', phone: W, chat: W, type: 'sticker' });
  await hook(W, '💓🤣');
  await quiet();
  assert.strictEqual(sent.length, 3, JSON.stringify(sent.slice(3)));
});

test('a card nobody answered comes back once («تبغاني أسجله؟»), then «تمام» still saves it', async () => {
  const { id: w } = await call('POST', '/api/users', { name: 'ناسي ت', role: 'worker', pin: '7676', phone: '0500000305' });
  const { id: it } = await call('POST', '/api/items', { name: 'كدر ت', unit: 'حبة', daily: 1, kind: 'raw' });
  await call('POST', '/api/responsibility', { item_id: it, user_id: w, opener_id: '' });
  const n0 = sent.length;
  await hook('966500000305', 'كدر 12');
  assert.match((await waitSent(n0 + 1)).text.body, /كدر ت: 12/);
  assert.deepStrictEqual((await call('POST', '/api/whatsapp/_remind')).sent, ['966500000305']);
  assert.match((await waitSent(n0 + 2)).text.body, /^⏳ هذا ما انسجل للحين[\s\S]*كدر ت: 12/);
  assert.deepStrictEqual((await call('POST', '/api/whatsapp/_remind')).sent, [], 'مرة وحدة بس');
  await hook('966500000305', 'تمام');
  assert.match((await waitSent(n0 + 3)).text.body, /✓ اتسجل/);
});

test('a short name means the worker\'s own item («قوار» for the one who boils it = «قوار مسلوق»)', async () => {
  const { id: boiler } = await call('POST', '/api/users', { name: 'سالق ت', role: 'worker', pin: '7777', phone: '0500000306' });
  const { id: veg } = await call('POST', '/api/users', { name: 'خضار ت', role: 'worker', pin: '7878' });
  const { id: raw } = await call('POST', '/api/items', { name: 'قوار ت', unit: 'كجم', daily: 1, kind: 'raw' });
  const { id: boiled } = await call('POST', '/api/items', { name: 'قوار ت مسلوق', unit: 'كجم', daily: 1, kind: 'prepared' });
  await call('POST', '/api/responsibility', { item_id: raw, user_id: veg, opener_id: '' });
  await call('POST', '/api/responsibility', { item_id: boiled, user_id: veg, opener_id: boiler, preparer_id: boiler });
  const n0 = sent.length;
  await hook('966500000306', 'اضافه 2 كيلو قوار');
  assert.match((await waitSent(n0 + 1)).text.body, /قوار ت مسلوق[\s\S]*2 كجم/);
});

test('the preparer\'s morning number for an item with no opening count = what he made today (مطفي)', async () => {
  const { id: prep } = await call('POST', '/api/users', { name: 'محضر ت', role: 'worker', pin: '7979', phone: '0500000307' });
  const { id: closer } = await call('POST', '/api/users', { name: 'مقفل ت', role: 'worker', pin: '8080' });
  const { id: it } = await call('POST', '/api/items', { name: 'مطفي ت', unit: 'حبة', daily: 1, kind: 'prepared', no_opening: true });
  await call('POST', '/api/responsibility', { item_id: it, user_id: closer, opener_id: 'none', preparer_id: prep });
  const n0 = sent.length;
  await hook('966500000307', 'مطفي 9');
  assert.match((await waitSent(n0 + 1)).text.body, /مطفي ت: 9 حبة \(سوّاها اليوم\)/);
  await hook('966500000307', 'تمام');
  assert.match((await waitSent(n0 + 2)).text.body, /✓ اتسجل/);
  assert.strictEqual((await call('GET', '/api/board?date=' + today)).rows.find(r => r.item_id === it).received, 9);
});

test('«سجلت» without saving anything is caught', () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-claim-'));
  const { falseClaim } = require('../server/assistant');
  assert.ok(falseClaim('تم ✓ سجلت لك القشطه', []));
  assert.ok(falseClaim('وصلت لنوح 👍', []));
  assert.ok(falseClaim('انحفظت أرقامك كلها', []));
  assert.strictEqual(falseClaim('وصلت لنوح 👍', ['report_problem']), '');
  assert.strictEqual(falseClaim('جهزت الكرت — رد تمام عشان يتسجل', []), '');
  assert.strictEqual(falseClaim('ما انسجل شي للحين', []), '');
  assert.strictEqual(falseClaim('رد «تمام» عشان أسجله', []), '');
});

test('the preparer (علي makes the حلبة, someone else counts it) can record what he made', async () => {
  const { id: counter } = await call('POST', '/api/users', { name: 'سليمان ت', role: 'worker', pin: '7272' });
  const { id: ali } = await call('POST', '/api/users', { name: 'علي ت', role: 'worker', pin: '7373', phone: '0500000302' });
  const { id: it } = await call('POST', '/api/items', { name: 'حلبة ت', unit: 'حبة', daily: 1, kind: 'prepared' });
  await call('POST', '/api/responsibility', { item_id: it, user_id: counter, opener_id: '', preparer_id: ali });
  const n0 = sent.length;
  await hook('966500000302', 'سويت حلبة 50');
  assert.match((await waitSent(n0 + 1)).text.body, /حلبة ت[\s\S]*50/, 'طلع الكرت — مو «مو عليك»');
  await hook('966500000302', 'تمام');
  assert.match((await waitSent(n0 + 2)).text.body, /✓ اتسجل/);
});

test('meat: «نزلت من القديم» takes from the old pool into today', async () => {
  const { id: w } = await call('POST', '/api/users', { name: 'لحام ت', role: 'worker', pin: '7474', phone: '0500000303' });
  const { id: old } = await call('POST', '/api/items', { name: 'حنيذ ت قديم', unit: 'نفر', kind: 'prepared', daily: false, leftover: 'stay' });
  const { id: it } = await call('POST', '/api/items', { name: 'حنيذ ت', unit: 'نفر', daily: 1, kind: 'prepared', leftover: 'old', buy_store: true, no_opening: true, old_item_id: old });
  await call('POST', '/api/responsibility', { item_id: it, user_id: w, opener_id: 'none' });
  await call('POST', '/api/warehouse/count', { counts: [{ item_id: old, qty: 3 }] });
  const n0 = sent.length;
  await hook('966500000303', 'نزلت من القديم حنيذ 2');
  assert.match((await waitSent(n0 + 1)).text.body, /نزّل من القديم[\s\S]*حنيذ ت/);
  await hook('966500000303', 'تمام');
  assert.match((await waitSent(n0 + 2)).text.body, /✓ اتسجل/);
  assert.strictEqual((await call('GET', '/api/board?date=' + today)).rows.find(r => r.item_id === it).received, 2);
  assert.strictEqual((await call('GET', '/api/warehouse')).find(i => i.id === old).balance, 1);
});

test('honey bottle refill (before/after) comes out of its source', async () => {
  const { id: w } = await call('POST', '/api/users', { name: 'دعدع قارورة ت', role: 'worker', pin: '7575', phone: '0500000304' });
  const { id: src } = await call('POST', '/api/items', { name: 'عسل مصدر ت', unit: 'كجم', daily: 1, kind: 'raw' });
  const { id: it } = await call('POST', '/api/items', { name: 'قارورة ت', unit: 'كجم', daily: 1, kind: 'raw', sources: [{ from_item_id: src, ratio: 1 }] });
  await call('POST', '/api/responsibility', { item_id: it, user_id: w, opener_id: '' });
  const n0 = sent.length;
  await hook('966500000304', 'عبيت القارورة: قبل 0.46 وبعد 1.06');
  assert.match((await waitSent(n0 + 1)).text.body, /عبّى من عسل مصدر ت[\s\S]*0\.6/);
  await hook('966500000304', 'تمام');
  assert.match((await waitSent(n0 + 2)).text.body, /✓ اتسجل/);
  const rows = (await call('GET', '/api/board?date=' + today)).rows;
  assert.strictEqual(rows.find(r => r.item_id === it).received, 0.6);
  assert.strictEqual(rows.find(r => r.item_id === src).received, -0.6);
});

test('daily question cap: one message to the worker, then silence; the owner is told once', async () => {
  const me = (await call('GET', '/api/users')).find(x => x.id === 1);
  await call('POST', '/api/users', { id: 1, name: me.name, role: 'owner', pin: '1234', phone: '0500000300' });
  await call('POST', '/api/settings', { ai_user_daily: '1' });
  const n0 = sent.length;
  await hook(W, 'وش باقي علي؟');
  await hook(W, 'وش باقي علي؟');
  await hook(W, 'طيب');
  await quiet();
  const mine = sent.slice(n0).filter(x => x.to === W), own = sent.slice(n0).filter(x => x.to === '966500000300');
  assert.strictEqual(mine.filter(x => /حد الأسئلة/.test(x.text.body)).length, 1, JSON.stringify(mine));
  assert.strictEqual(own.filter(x => /وصل حد أسئلة المساعد/.test(x.text.body)).length, 1, JSON.stringify(own));
});
