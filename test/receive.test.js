'use strict';
// 📦 استلام سمك الدعدع بالوزن (صورة الميزان) => ينتظر الحساب، والكمية تدخل الجرد. 🧾 الحساب يوصل => كيلو بكيلو
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
const tool = (name, input) => ({ stop_reason: 'tool_use', usage: U, content: [{ type: 'tool_use', id: 't' + Math.random(), name, input }] });
const say = text => ({ stop_reason: 'end_turn', usage: U, content: [{ type: 'text', text }] });
const OWN = '966500000700', WK = '966500000701';
let n = 0;
const send = async (phone, text, extra = {}) => {
  const before = (await call('GET', '/api/whatsapp/_outbox')).length;
  await call('POST', '/api/whatsapp/_inject', { id: 'r' + (++n), phone, chat: phone, text, ...extra });
  for (let i = 0; i < 80; i++) { const o = (await call('GET', '/api/whatsapp/_outbox')).slice(before).filter(x => x.to === phone); if (o.length) return o.at(-1).text; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('ما رد');
};

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-rcv-'));
  const FX = path.join(dir, 'ai.json');
  fs.writeFileSync(FX, JSON.stringify([
    tool('propose_receive', { supplier: 'دعدع', note: null, lines: [{ item: 'ديراك ر', weights: [12.4, 3.1] }] }), say('شيك الكرت'), // 0-1
    tool('propose_receive', { supplier: 'دعدع', note: null, lines: [{ item: 'هامور ر', weights: [5] }, { item: 'ديراك ر', weights: [0.5] }] }), say('شيك'), // 2-3
    tool('match_invoice', { supplier: 'دعدع', date: null, total: null, lines: [{ item: 'ديراك ر', qty: 16.5, unit_price: 46 }, { item: 'هامور ر', qty: 5, unit_price: 60 }, { item: 'حريد ر', qty: 2, unit_price: 30 }] }), say('هذي المقارنة'), // 4-5
    tool('propose_count', { phase: 'opening', entries: [{ item: 'مشكل فرن ر', qty: 4.45, unit: 'كجم', parts: [] }] }), say('جهزته'), // 6-7
    tool('propose_receive', { supplier: 'دعدع', note: null, lines: [{ item: 'حريد ر', weights: [3] }] }), say('شيك'), // 8-9
  ]));
  const port = 46000 + Math.floor(Math.random() * 900); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir, AI_FIXTURE: FX, WA_TEST_INJECT: '1' }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  today = (await call('GET', '/api/me')).today;
  await call('POST', '/api/settings', { anthropic_key: 'sk-test' });
  const me = (await call('GET', '/api/users')).find(x => x.id === 1);
  await call('POST', '/api/users', { id: 1, name: me.name, role: 'owner', pin: '1234', phone: '0500000700' });
  await call('POST', '/api/users', { name: 'محمد عبدالله ر', role: 'worker', pin: '7171', phone: '0500000701' });
  for (const name of ['ديراك ر', 'هامور ر', 'حريد ر']) await call('POST', '/api/items', { name, unit: 'كجم', daily: 1, kind: 'raw', leftover: 'stay', no_opening: true });
});
test.after(() => srv.kill());

const rowsOf = async () => (await call('GET', '/api/board?date=' + today)).rows;
const itemId = async name => (await call('GET', '/api/items')).find(i => i.name === name).id;

test('a worker weighs on arrival: two scale photos are summed, recorded as «waiting for the invoice», and counted at once', async () => {
  let r = await send(WK, 'ديراك كامل', { image_b64: '/9j/AAAA' });
  assert.match(r, /12\.4 \+ 3\.1 = 15\.5 كجم/);
  await send(WK, 'تمام');
  const dk = await itemId('ديراك ر');
  assert.strictEqual((await rowsOf()).find(x => x.item_id === dk).received, 15.5);
  // استلام ثاني بنفس اليوم => نفس الشراء
  r = await send(WK, 'هامور', { image_b64: '/9j/BBBB' });
  await send(WK, 'تمام');
  const ps = (await call('GET', '/api/purchases')).filter(p => p.awaiting_invoice);
  assert.strictEqual(ps.length, 1, 'شراء واحد ينتظر الحساب');
  assert.strictEqual(ps[0].supplier, 'دعدع'); assert.strictEqual(ps[0].payment, 'credit');
  assert.strictEqual(ps[0].lines.find(l => l.item_id === dk).qty, 16);
  assert.strictEqual((await rowsOf()).find(x => x.item_id === dk).received, 16);
});

test('the supplier invoice arrives: kilo by kilo — short / match / not received — prices saved, weighed qty kept', async () => {
  const r = await send(OWN, 'هذا حساب الدعدع', { image_b64: '/9j/CCCC' });
  assert.match(r, /ديراك ر: الحساب 16\.5 — وزنّا 16 ← ناقص 0\.5 كجم \(≈23 ريال\)/);
  assert.match(r, /هامور ر: مطابق/);
  assert.match(r, /حريد ر: في الحساب 2 كجم وما انوزن/);
  assert.match(r, /لك عنده ≈ 83 ريال/);
  await send(OWN, 'تمام');
  const p = (await call('GET', '/api/purchases')).find(x => x.supplier === 'دعدع');
  assert.strictEqual(p.awaiting_invoice, 0);
  assert.strictEqual(p.total, 16.5 * 46 + 5 * 60 + 2 * 30);
  const dk = p.lines.find(l => l.item === 'ديراك ر');
  assert.strictEqual(dk.qty, 16); assert.strictEqual(dk.invoice_qty, 16.5); assert.strictEqual(dk.unit_price, 46);
  assert.strictEqual((await call('GET', '/api/items')).find(i => i.name === 'هامور ر').cost, 60);
});

test('🐟 back fridge = store: weighed delivery goes behind, «زودت ٥ للعرض» comes to the display, over the recorded balance still passes', async () => {
  const { id } = await call('POST', '/api/items', { name: 'شعور ر', unit: 'كجم', daily: 1, kind: 'raw', leftover: 'stay', no_opening: true, buy_store: true });
  await call('POST', '/api/receive', { supplier: 'دعدع', lines: [{ item_id: id, qty: 30 }] });
  let row = (await rowsOf()).find(x => x.item_id === id);
  assert.strictEqual(row.received, 0); assert.strictEqual(row.upstairs, 30);
  await call('POST', '/api/add', { date: today, item_id: id, qty: 10, source: 'fridge' });
  await call('POST', '/api/add', { date: today, item_id: id, qty: 25, source: 'fridge' }); // أكثر من المسجّل — يمشي
  row = (await rowsOf()).find(x => x.item_id === id);
  assert.strictEqual(row.received, 35);
});

test('🐟 Mohammed\'s fish: he records what is behind, «زودت ٥» to the display, 2 left at night go back behind; untouched fish is not chased', async () => {
  const { id } = await call('POST', '/api/items', { name: 'قاروص ر', unit: 'كجم', daily: 1, kind: 'raw', leftover: 'fridge', no_opening: true, buy_store: true });
  const { id: idle } = await call('POST', '/api/items', { name: 'دنيس ر', unit: 'كجم', daily: 1, kind: 'raw', leftover: 'fridge', no_opening: true, buy_store: true });
  const w = (await call('GET', '/api/users')).find(x => x.name === 'محمد عبدالله ر');
  for (const it of [id, idle]) await call('POST', '/api/responsibility', { item_id: it, user_id: w.id, opener_id: 'none' });
  const wt = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: w.id, pin: '7171' }) })).json()).token;
  const as = async (p, body) => { const r = await fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + wt }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j; };
  await as('/api/warehouse/count', { date: today, counts: [{ item_id: id, qty: 20 }] }); // اللي ورا الحين
  await assert.rejects(as('/api/warehouse/count', { date: today, counts: [{ item_id: (await itemId('حريد ر')), qty: 1 }] }), e => e.status === 403);
  let row = (await rowsOf()).find(x => x.item_id === id);
  assert.strictEqual(row.upstairs, 20); assert.strictEqual(row.opening, 0);
  assert.strictEqual((await rowsOf()).find(x => x.item_id === idle).empty, 1, 'ما انلمس = ما ينلاحق');
  await as('/api/add', { date: today, item_id: id, qty: 5, source: 'fridge' });
  await as('/api/count', { date: today, item_id: id, phase: 'closing', qty: 2 });
  row = (await rowsOf()).find(x => x.item_id === id);
  assert.strictEqual(row.received, 5); assert.strictEqual(row.actual, 3); assert.strictEqual(row.upstairs, 17, '٢٠ − ٥ + ٢ رجعت ورا');
  assert.strictEqual(row.empty, 0);
});

test('📷 a scale photo of a dish => portions straight away (scale − pot) × per kilo, recorded on «تمام»', async () => {
  const { id } = await call('POST', '/api/items', { name: 'مشكل فرن ر', unit: 'صحن', kind: 'prepared', daily: 1, leftover: 'waste', tare: 0.45 });
  await call('PUT', `/api/items/${id}/units`, { units: [{ name: 'كجم', factor: 3.5 }] });
  const w = (await call('GET', '/api/users')).find(x => x.name === 'محمد عبدالله ر');
  await call('POST', '/api/responsibility', { item_id: id, user_id: w.id, opener_id: '' });
  const r = await send(WK, '', { image_b64: '/9j/DDDD' });
  assert.match(r, /مشكل فرن ر: 4\.45 كجم − الصحن 0\.45 = 4 × 3\.5 = 14 صحن/);
  await send(WK, 'تمام');
  assert.strictEqual((await rowsOf()).find(x => x.item_id === id).opening, 14);
});

test('🎤 «تمام تمام ماشي هذا خلاص» confirms the card (voice style), not only a bare «تمام»', async () => {
  const id = await itemId('حريد ر');
  const before = (await rowsOf()).find(x => x.item_id === id).received;
  await send(WK, 'حريد', { image_b64: '/9j/EEEE' });
  const r = await send(WK, 'تمام تمام ماشي هذا خلاص');
  assert.match(r, /✓/);
  assert.strictEqual((await rowsOf()).find(x => x.item_id === id).received, before + 3);
});
