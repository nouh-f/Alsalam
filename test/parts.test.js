'use strict';
// 🧮 جرد آخر اليوم على أجزاء: الديراك «كامل + مقطّع×1.25»، أبو عصاية «ني (يقعد) + مستوي (يترمى)»
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
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-parts-'));
  const port = 43000 + Math.floor(Math.random() * 900); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  today = (await call('GET', '/api/me')).today;
});
test.after(() => srv.kill());

test('closing in parts: whole + cut×1.25; raw stays and cooked is thrown away', async () => {
  const d = await call('POST', '/api/items', { name: 'ديراك ت', unit: 'كجم', kind: 'raw', daily: 1, leftover: 'stay', cost: 46, note: 'صندوق في ثلاجة العرض', parts: 'كامل، مقطّع×1.25' });
  const f = await call('POST', '/api/items', { name: 'أبو عصاية ت', unit: 'حبة', kind: 'raw', daily: 1, leftover: 'stay', parts: 'ني، مستوي يترمى' });
  const it = (await call('GET', '/api/items')).find(i => i.id === d.id);
  assert.deepStrictEqual(JSON.parse(it.parts), [{ name: 'كامل', factor: 1, drop: false }, { name: 'مقطّع', factor: 1.25, drop: false }]);
  assert.strictEqual(it.cost, 46); assert.strictEqual(it.note, 'صندوق في ثلاجة العرض');

  const d1 = addDays(today, -1);
  await call('POST', '/api/count', { date: d1, item_id: d.id, phase: 'opening', qty: 10 });
  await call('POST', '/api/count', { date: d1, item_id: d.id, phase: 'closing', parts: { 'كامل': 3, 'مقطّع': 1.2 } });
  await call('POST', '/api/count', { date: d1, item_id: f.id, phase: 'opening', qty: 20 });
  await call('POST', '/api/count', { date: d1, item_id: f.id, phase: 'closing', parts: { 'ني': 8, 'مستوي': 3 } });
  const b1 = (await call('GET', '/api/board?date=' + d1)).rows;
  const rd = b1.find(r => r.item_id === d.id), rf = b1.find(r => r.item_id === f.id);
  assert.strictEqual(rd.closing, 4.5); assert.deepStrictEqual(rd.closing_parts, { 'كامل': 3, 'مقطّع': 1.2 });
  assert.strictEqual(rf.closing, 11); assert.strictEqual(rf.waste, 3, 'المستوي هالك');
  assert.strictEqual(rf.actual, 9, 'المنصرف = ٢٠ − ١١');

  const b2 = (await call('GET', '/api/board?date=' + today)).rows;
  assert.strictEqual(b2.find(r => r.item_id === f.id).prev_closing, 8, 'بكرة يبدأ من الني بس');
  assert.strictEqual(b2.find(r => r.item_id === d.id).prev_closing, 4.5);
  await assert.rejects(call('POST', '/api/count', { date: d1, item_id: f.id, phase: 'closing', parts: { 'ني': -1 } }), /غير صحيحة/);
});

test('a carton can be linked to its pieces before the first split, then «فكيت كرتون فيه 27» works', async () => {
  const pcs = (await call('GET', '/api/items')).find(i => i.name === 'أبو عصاية ت');
  const box = await call('POST', '/api/items', { name: 'كرتون أبو عصاية ت', unit: 'كرتون', kind: 'raw', daily: 0 });
  await call('POST', '/api/splits/link', { item_id: box.id, outputs: [pcs.id] });
  assert.ok((await call('GET', '/api/splits')).some(s => s.id === box.id && s.outputs.some(o => o.out_item_id === pcs.id)));
  await call('POST', '/api/split', { date: today, item_id: box.id, qty: 1, outputs: [{ item_id: pcs.id, qty: 27 }] });
  const row = (await call('GET', '/api/board?date=' + today)).rows.find(r => r.item_id === pcs.id);
  assert.strictEqual(row.received, 27);
});

test('count types: fish starts from last night (no opening), missing last night is not guessed, Pepsi buys go upstairs and fill the fridge with «+ أضفت»', async () => {
  const d1 = addDays(today, -1);
  const fish = await call('POST', '/api/items', { name: 'حريد ت', unit: 'كجم', kind: 'raw', daily: 1, leftover: 'stay', no_opening: true });
  const fish2 = await call('POST', '/api/items', { name: 'صرع ت', unit: 'كجم', kind: 'raw', daily: 1, leftover: 'stay', no_opening: true });
  const pep = await call('POST', '/api/items', { name: 'بيبسي ت', unit: 'علبة', kind: 'raw', daily: 1, leftover: 'stay', no_opening: true, buy_store: true });
  await call('POST', '/api/count', { date: d1, item_id: fish.id, phase: 'closing', qty: 4 });
  await call('POST', '/api/count', { date: d1, item_id: pep.id, phase: 'closing', qty: 10 });
  await call('POST', '/api/purchases', { date: today, payment: 'paid', lines: [{ item_id: fish.id, qty: 33, unit_price: 24 }, { item_id: pep.id, qty: 24, unit_price: 2 }] });
  await call('POST', '/api/count', { date: today, item_id: fish.id, phase: 'closing', qty: 30 });
  let rows = (await call('GET', '/api/board?date=' + today)).rows;
  const f = rows.find(r => r.item_id === fish.id);
  assert.strictEqual(f.opening, 4, 'من آخر أمس'); assert.strictEqual(f.from_prev, 1); assert.strictEqual(f.received, 33); assert.strictEqual(f.diff, 7);
  const f2 = rows.find(r => r.item_id === fish2.id);
  assert.strictEqual(f2.opening, null); assert.strictEqual(f2.prev_missing, 1, 'أمس ما انجرد — ما نخمّن');
  await call('POST', '/api/count', { date: today, item_id: fish2.id, phase: 'opening', qty: 5 });
  assert.strictEqual((await call('GET', '/api/board?date=' + today)).rows.find(r => r.item_id === fish2.id).opening, 5);
  const p = rows.find(r => r.item_id === pep.id);
  assert.strictEqual(p.received, 0, 'شراء البيبسي راح فوق'); assert.strictEqual(p.upstairs, 24);
  await call('POST', '/api/add', { date: today, item_id: pep.id, qty: 6, source: 'fridge' });
  rows = (await call('GET', '/api/board?date=' + today)).rows;
  assert.strictEqual(rows.find(r => r.item_id === pep.id).received, 6);
});

test('⚖️ dish by weight: (scale − empty pot) × portions per kilo; a plate count without unit keeps the number', async () => {
  const { id } = await call('POST', '/api/items', { name: 'إيدام بامية ت', unit: 'صحن', kind: 'prepared', daily: 1, leftover: 'waste', tare: 0.55 });
  await call('PUT', `/api/items/${id}/units`, { units: [{ name: 'كجم', factor: 3 }] });
  await call('POST', '/api/count', { date: today, item_id: id, phase: 'opening', qty: 4.55, unit: 'كجم' });
  let row = (await call('GET', '/api/board?date=' + today)).rows.find(r => r.item_id === id);
  assert.strictEqual(row.opening, 12);
  await call('POST', '/api/count', { date: today, item_id: id, phase: 'opening', qty: 5 });
  row = (await call('GET', '/api/board?date=' + today)).rows.find(r => r.item_id === id);
  assert.strictEqual(row.opening, 5, 'بالصحن: الصحن الفاضي ما ينطرح');
  await assert.rejects(call('POST', '/api/count', { date: today, item_id: id, phase: 'opening', qty: 2, unit: 'كرتون' }), /كم صحن في كرتون/);
});
