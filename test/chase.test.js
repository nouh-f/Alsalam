'use strict';
// 🔁 ملاحقة اللي ما جرد في الخاص (بأصنافه، والنبرة تشد)، وبعد ٣: القروب + نوح (فترة التعليم) أو مشكلة «الجرد». و⚖️ وزن القارورة ينطرح
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

let srv, B, T, today, AT;
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const OWN = '966500000900', W1 = '966500000902', W2 = '966500000903';
const outbox = () => call('GET', '/api/whatsapp/_outbox');

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-chase-'));
  const port = 45000 + Math.floor(Math.random() * 900); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir, WA_TEST_INJECT: '1' }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  today = (await call('GET', '/api/me')).today;
  AT = today + 'T10:00:00Z'; // ١ الظهر بالسعودي — بعد موعد جرد أول اليوم
  const me = (await call('GET', '/api/users')).find(x => x.id === 1);
  await call('POST', '/api/users', { id: 1, name: me.name, role: 'owner', pin: '1234', phone: '0500000900' });
  await call('POST', '/api/whatsapp/groups', { groups: [{ id: 'g1@g.us', role: 'restaurant' }] });
});
test.after(() => srv.kill());

test('who has not counted is chased privately with item names; after 3: group + owner (training, no issue)', async () => {
  const { id: w } = await call('POST', '/api/users', { name: 'سالم ملاحق', role: 'worker', pin: '6161', phone: '0500000902' });
  const { id: it } = await call('POST', '/api/items', { name: 'فول ملاحقة', unit: 'قدر', daily: 1, kind: 'prepared' });
  await call('POST', '/api/responsibility', { item_id: it, user_id: w, opener_id: '' });
  const { id: done } = await call('POST', '/api/items', { name: 'خبز مجرود', unit: 'حبة', daily: 1, kind: 'raw' });
  await call('POST', '/api/count', { date: today, item_id: done, phase: 'opening', qty: 5 }); // يوم شغل
  const before = (await outbox()).length;
  const r1 = await call('POST', '/api/whatsapp/chase', { at: AT });
  assert.ok(r1.sent.some(x => x.to === W1 && x.n === 1));
  let ob = (await outbox()).slice(before);
  assert.ok(ob.some(x => x.to === W1 && /فول ملاحقة/.test(x.text) && /سالم ملاحق/.test(x.text)), JSON.stringify(ob));
  await call('POST', '/api/whatsapp/chase', { at: AT });
  await call('POST', '/api/whatsapp/chase', { at: AT });
  ob = (await outbox()).slice(before);
  assert.ok(ob.some(x => x.to === W1 && /ثالث تذكير/.test(x.text) && /نوح والقروب/.test(x.text)));
  assert.ok(ob.some(x => x.to === 'g1@g.us' && /سالم ملاحق/.test(x.text)), 'اسمه في القروب');
  assert.ok(ob.some(x => x.to === OWN && /سالم ملاحق ما دخّل جرده بعد ٣ تذكيرات: فول ملاحقة/.test(x.text)), 'يوصل لنوح');
  assert.ok(!ob.some(x => x.to === W1 && /انذكر في القروب/.test(x.text)), 'فترة التعليم: ما تنسجل مشكلة');
  // دخّل جرده => ما عاد يلاحقه
  await call('POST', '/api/count', { date: today, item_id: it, phase: 'opening', qty: 1 });
  assert.ok(!(await call('POST', '/api/whatsapp/chase', { at: AT })).sent.some(x => x.to === W1));
});

test('after training (wa_chase_record=1) the third reminder records a «الجرد» issue', async () => {
  await call('POST', '/api/settings', { wa_chase_record: '1' });
  const { id: w } = await call('POST', '/api/users', { name: 'مهدي ملاحق', role: 'worker', pin: '6262', phone: '0500000903' });
  const { id: it } = await call('POST', '/api/items', { name: 'عدس ملاحقة', unit: 'قدر', daily: 1, kind: 'prepared' });
  await call('POST', '/api/responsibility', { item_id: it, user_id: w, opener_id: '' });
  const before = (await outbox()).length;
  for (let i = 0; i < 3; i++) await call('POST', '/api/whatsapp/chase', { at: AT });
  const ob = (await outbox()).slice(before);
  assert.ok(ob.some(x => x.to === W2 && /تنسجل عليك في الجرد/.test(x.text)));
  assert.ok(ob.some(x => x.to === W2 && /انذكر في القروب: ما دخّل جرده بعد ٣ تذكيرات: عدس ملاحقة/.test(x.text)), JSON.stringify(ob.filter(x => x.to === W2)));
  await call('POST', '/api/settings', { wa_chase: '0' });
});

test('⚖️ a bottle is weighed with the bottle; the empty bottle weight is subtracted', async () => {
  const { id } = await call('POST', '/api/items', { name: 'عسل قارورة ت', unit: 'كجم', daily: 1, kind: 'raw', tare: 0.3 });
  assert.strictEqual((await call('GET', '/api/items')).find(i => i.id === id).tare, 0.3);
  await call('POST', '/api/count', { date: today, item_id: id, phase: 'opening', qty: 1.5 });
  const row = (await call('GET', '/api/board?date=' + today)).rows.find(r => r.item_id === id);
  assert.strictEqual(row.opening, 1.2); assert.strictEqual(row.tare, 0.3);
});

test('⏰ Nouh\'s hours: from 10am (before the 12 deadline), nothing at 9; closing from 11pm; then a summary to Nouh + خلوف once a night', async () => {
  await call('POST', '/api/settings', { wa_chase_record: '0' });
  const W3 = '966500000904', KH = '966500000905';
  const { id: w } = await call('POST', '/api/users', { name: 'علي ت', role: 'worker', pin: '6363', phone: '0500000904' });
  const { id: kh } = await call('POST', '/api/users', { name: 'خلوف ت', role: 'worker', pin: '6464', phone: '0500000905' });
  await call('POST', '/api/settings', { wa_chase_notify: JSON.stringify([kh]) });
  const { id: it } = await call('POST', '/api/items', { name: 'بطاطس ملاحقة', unit: 'قدر', daily: 1, kind: 'prepared' });
  await call('POST', '/api/responsibility', { item_id: it, user_id: w, opener_id: '' });
  assert.deepStrictEqual((await call('POST', '/api/whatsapp/chase', { at: today + 'T06:00:00Z' })).sent, [], 'الساعة ٩ بدري');
  let before = (await outbox()).length;
  await call('POST', '/api/whatsapp/chase', { at: today + 'T07:30:00Z' }); // ١٠:٣٠
  await call('POST', '/api/whatsapp/chase', { at: today + 'T08:30:00Z' });
  let ob = (await outbox()).slice(before).filter(x => x.to === W3);
  assert.match(ob[0].text, /صباح الخير يا علي ت[\s\S]*أول شي تسويه لما توصل: الجرد[\s\S]*بطاطس ملاحقة/);
  assert.doesNotMatch(ob[0].text, /آخر وقت/, 'أول رسالة بدون موعد');
  assert.match(ob[1].text, /آخر وقت الساعة 12[\s\S]*أكمل وجه/);
  // الليل: عداد آخر اليوم لحاله
  before = (await outbox()).length;
  await call('POST', '/api/whatsapp/chase', { at: today + 'T20:15:00Z' }); // ١١:١٥ الليل
  ob = (await outbox()).slice(before);
  assert.ok(ob.some(x => x.to === W3 && /قبل ما تقفل: باقي عليك جرد[\s\S]*بطاطس ملاحقة/.test(x.text)), JSON.stringify(ob));
  assert.ok(!ob.some(x => /باقي جرد الليلة/.test(x.text)), 'الملخص بعد ساعة');
  before = (await outbox()).length;
  await call('POST', '/api/whatsapp/chase', { at: today + 'T21:15:00Z' }); // ١٢:١٥
  ob = (await outbox()).slice(before);
  for (const to of [OWN, KH]) assert.ok(ob.some(x => x.to === to && /باقي جرد الليلة[\s\S]*علي ت: [^\n]*بطاطس ملاحقة/.test(x.text)), to);
  before = (await outbox()).length;
  await call('POST', '/api/whatsapp/chase', { at: today + 'T21:45:00Z' });
  ob = (await outbox()).slice(before);
  assert.ok(!ob.some(x => /باقي جرد الليلة/.test(x.text)), 'مرة وحدة في الليلة');
  assert.ok(ob.some(x => x.to === KH && /علي ت ما دخّل جرده بعد ٣ تذكيرات/.test(x.text)), 'خلوف يوصله خبر الثالث');
});

test('early morning with nothing counted yet still chases when last night was counted', async () => {
  const { id: done } = await call('POST', '/api/items', { name: 'خبز أمس', unit: 'حبة', daily: 1, kind: 'raw' });
  await call('POST', '/api/count', { date: today, item_id: done, phase: 'closing', qty: 1 });
  const tmr = (() => { const x = new Date(today + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); })();
  const r = await call('POST', '/api/whatsapp/chase', { at: tmr + 'T07:30:00Z' });
  assert.ok(r.sent.some(x => x.to === '966500000904' && x.kind === 'o'), JSON.stringify(r.sent));
});
