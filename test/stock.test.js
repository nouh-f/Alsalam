'use strict';
// الجرد الأسهل: الثلاجة فوق لحالها، «+ أضفت» من فين، تقسيم الذبيحة، صور الهالك والباقي، المحضّر، كل البضاعة
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

let srv, B, T, today, yest, tom;
const IMG = 'data:image/jpeg;base64,/9j/AAAA';
const login = async (user_id, pin) => (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id, pin }) })).json()).token;
const call = async (method, p, body, tok = T) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const row = async (date, name, tok = T) => (await call('GET', '/api/board?date=' + date, null, tok)).rows.find(r => r.name === name);

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-st-'));
  const port = 27000 + Math.floor(Math.random() * 3000); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, DATA_DIR: dir }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = await login(1, '1234');
  today = (await call('GET', '/api/me')).today; yest = addDays(today, -2); tom = addDays(today, -1);
  // أصناف مثل المحل (القاعدة الجديدة فيها أسماء ثانية)
  const mk = b => call('POST', '/api/items', { unit: 'حبة', kind: 'prepared', daily: 1, ...b });
  const sahm = await mk({ name: 'سهوم', leftover: 'fridge' });
  const bk = await mk({ name: 'برم كبير', leftover: 'fridge', sources: [{ from_item_id: sahm.id, ratio: 1 }] });
  await mk({ name: 'برم صغير', leftover: 'fridge' });
  await mk({ name: 'مطفي ديراك', leftover: 'fridge_added' });
  await mk({ name: 'مطفي بياض', leftover: 'fridge_added' });
});
test.after(() => srv.kill());

test('fridge items: leftover goes up by itself, comes down next morning; extra asks «from where?»', async () => {
  const items = await call('GET', '/api/items');
  const barm = items.find(i => i.name === 'برم صغير');
  assert.strictEqual(barm.leftover, 'fridge', 'seeded as fridge');
  // يوم ١: أول 10، آخر 5 ← يطلع فوق 5، ولا هالك
  await call('POST', '/api/count', { date: yest, item_id: barm.id, phase: 'opening', qty: 10 });
  await call('POST', '/api/count', { date: yest, item_id: barm.id, phase: 'closing', qty: 5 });
  let r = await row(yest, 'برم صغير');
  assert.strictEqual(r.waste, 0); assert.strictEqual(r.to_fridge, 5); assert.strictEqual(r.upstairs, 5);
  // يوم ٢: أول الدوام 8 ← نزل 5، والزيادة 3 «من فين؟»
  await call('POST', '/api/count', { date: tom, item_id: barm.id, phase: 'opening', qty: 8 });
  r = await row(tom, 'برم صغير');
  assert.strictEqual(r.up_before, 5); assert.strictEqual(r.from_fridge, 5); assert.strictEqual(r.fridge_gap, 3); assert.strictEqual(r.upstairs, 0);
  assert.ok((await call('GET', '/api/dashboard?date=' + tom)).todo.some(t => /من فين/.test(t.title)));
  // صحّح لـ 5 ← ما فيه زيادة
  await call('POST', '/api/count', { date: tom, item_id: barm.id, phase: 'opening', qty: 5 });
  r = await row(tom, 'برم صغير');
  assert.strictEqual(r.fridge_gap, 0); assert.strictEqual(r.upstairs, 0);
});

test('mutfi: what was added later goes to the fridge, the morning batch leftover is waste', async () => {
  const it = (await call('GET', '/api/items')).find(i => i.name === 'مطفي ديراك');
  assert.strictEqual(it.leftover, 'fridge_added');
  await call('POST', '/api/count', { date: today, item_id: it.id, phase: 'opening', qty: 10 });
  await call('POST', '/api/add', { date: today, item_id: it.id, qty: 5, source: 'cook' });
  await call('POST', '/api/count', { date: today, item_id: it.id, phase: 'closing', qty: 7 });
  const r = await row(today, 'مطفي ديراك');
  assert.strictEqual(r.added, 5); assert.strictEqual(r.received, 5); assert.strictEqual(r.to_fridge, 5); assert.strictEqual(r.waste, 2);
});

test('carcass split; sahm converts to barm via «+ أضفت من السهوم»; costs spread', async () => {
  const items = await call('GET', '/api/items');
  const carcass = items.find(i => i.name === 'ذبيحة'), sahm = items.find(i => i.name === 'سهوم'), barmK = items.find(i => i.name === 'برم كبير'), han = items.find(i => i.name === 'حنيذ لحم');
  await call('POST', '/api/purchases', { date: today, supplier: 'الملحمة', payment: 'paid', lines: [{ item_id: carcass.id, qty: 1, unit_price: 1200 }] });
  await call('POST', '/api/split', { date: today, item_id: carcass.id, qty: 1, outputs: [{ item_id: sahm.id, qty: 4 }, { item_id: barmK.id, qty: 10 }, { item_id: han.id, qty: 5 }] });
  assert.strictEqual((await call('GET', '/api/warehouse')).find(i => i.id === carcass.id).balance, 0);
  const sp = await call('GET', '/api/splits');
  assert.deepStrictEqual(sp.find(s => s.id === carcass.id).outputs.map(o => o.out_name), ['سهوم', 'برم كبير', 'حنيذ لحم'], 'outputs remembered');
  let r = await row(today, 'سهوم');
  assert.strictEqual(r.received, 4); assert.strictEqual(r.added, 4);
  const after = await call('GET', '/api/items');
  assert.ok(after.find(i => i.id === sahm.id).cost > 0, 'cost spread to outputs');
  // + أضفت برم كبير 2 من السهوم (سهم = برم)
  assert.ok((await row(today, 'برم كبير')).sources.some(s => s.name === 'سهوم'));
  await call('POST', '/api/add', { date: today, item_id: barmK.id, qty: 2, source: 'from', from_item_id: sahm.id });
  r = await row(today, 'سهوم'); assert.strictEqual(r.received, 2);
  assert.strictEqual((await row(today, 'برم كبير')).added, 12);
});

test('photos: waste needs one; closing photo asked for chosen items', async () => {
  const items = await call('GET', '/api/items');
  const fat = items.find(i => i.name === 'فتة أبيض');
  await call('POST', '/api/items', { ...fat, need_photo: 1 });
  const w = await call('POST', '/api/users', { name: 'مقفل الفتة', role: 'worker', pin: '5151' });
  await call('POST', '/api/responsibility', { item_id: fat.id, user_id: w.id });
  const WT = await login(w.id, '5151');
  await assert.rejects(call('POST', '/api/transfer', { date: today, item_id: fat.id, qty: 1, mode: 'waste' }, WT), /صوّر/);
  await call('POST', '/api/transfer', { date: today, item_id: fat.id, qty: 1, mode: 'waste', image: IMG }, WT);
  await call('POST', '/api/count', { date: today, item_id: fat.id, phase: 'closing', qty: 10 }, WT);
  let todo = (await call('GET', '/api/dashboard', null, WT)).todo;
  assert.ok(todo.some(t => /صوّر الباقي/.test(t.title)));
  await call('POST', '/api/count/photo', { date: today, item_id: fat.id, image: IMG }, WT);
  todo = (await call('GET', '/api/dashboard', null, WT)).todo;
  assert.ok(!todo.some(t => /صوّر الباقي/.test(t.title)));
  const r = await row(today, 'فتة أبيض', WT);
  assert.ok(r.closing_image && r.waste_image);
  // العامل: ما عنده مساعد
  await assert.rejects(call('POST', '/api/assistant', { question: 'هلا' }, WT), e => e.status === 403);
});

test('preparer: only adds; a stranger cannot; everything page totals', async () => {
  const items = await call('GET', '/api/items');
  const mb = items.find(i => i.name === 'مطفي بياض');
  const cook = await call('POST', '/api/users', { name: 'طباخ', role: 'worker', pin: '6161' });
  const other = await call('POST', '/api/users', { name: 'غريب', role: 'worker', pin: '7171' });
  const closer = await call('POST', '/api/users', { name: 'مقفل المطفي', role: 'worker', pin: '8181' });
  await call('POST', '/api/responsibility', { item_id: mb.id, user_id: closer.id, preparer_id: cook.id });
  const CT = await login(cook.id, '6161'), OT = await login(other.id, '7171');
  const r = await row(today, 'مطفي بياض', CT);
  assert.strictEqual(r.prep_only, 1); assert.strictEqual(r.prep_user, 'طباخ');
  await call('POST', '/api/add', { date: today, item_id: mb.id, qty: 3, source: 'cook' }, CT);
  await assert.rejects(call('POST', '/api/add', { date: today, item_id: mb.id, qty: 3, source: 'cook' }, OT), e => e.status === 403);
  await assert.rejects(call('POST', '/api/count', { date: today, item_id: mb.id, phase: 'closing', qty: 1 }, CT), e => e.status === 403, 'preparer does not count');
  const st = await call('GET', '/api/stock');
  const barm = st.find(i => i.name === 'برم صغير');
  assert.strictEqual(barm.upstairs, 0);
  const carcass = st.find(i => i.name === 'ذبيحة'); assert.strictEqual(carcass.total, 0);
  assert.strictEqual(st.find(i => i.name === 'مطفي بياض').floor, 3);
});

test('carcass split belongs to the meat person (and supervisors) only', async () => {
  const items = await call('GET', '/api/items');
  const carcass = items.find(i => i.name === 'ذبيحة'), sahm = items.find(i => i.name === 'سهوم'), han = items.find(i => i.name === 'حنيذ لحم');
  const meat = await call('POST', '/api/users', { name: 'مسؤول اللحم', role: 'worker', pin: '9191' });
  const other = await call('POST', '/api/users', { name: 'عامل ثاني', role: 'worker', pin: '9292' });
  for (const it of [sahm, han]) await call('POST', '/api/responsibility', { item_id: it.id, user_id: meat.id });
  const MT = await login(meat.id, '9191'), OT = await login(other.id, '9292');
  assert.strictEqual((await call('GET', '/api/me', null, MT)).can_split, true);
  assert.strictEqual((await call('GET', '/api/me', null, OT)).can_split, false);
  await call('POST', '/api/purchases', { date: today, supplier: 'الملحمة', payment: 'paid', lines: [{ item_id: carcass.id, qty: 1, unit_price: 1000 }] });
  assert.ok((await call('GET', '/api/dashboard', null, MT)).todo.some(t => t.title === 'فيه 1 ذبيحة ما انقسمت'));
  assert.ok(!(await call('GET', '/api/dashboard', null, OT)).todo.some(t => /ذبيحة/.test(t.title)));
  await assert.rejects(call('POST', '/api/split', { date: today, item_id: carcass.id, qty: 1, outputs: [{ item_id: sahm.id, qty: 4 }] }, OT), e => e.status === 403);
  await assert.rejects(call('GET', '/api/splits', null, OT), e => e.status === 403);
  await call('POST', '/api/split', { date: today, item_id: carcass.id, qty: 1, outputs: [{ item_id: sahm.id, qty: 4 }, { item_id: han.id, qty: 5 }] }, MT);
  assert.ok(!(await call('GET', '/api/dashboard', null, MT)).todo.some(t => /ذبيحة ما انقسمت/.test(t.title)));
});

test('bought daily items go straight into the responsible person\'s count; a wrong purchase can be moved', async () => {
  const fish = await call('POST', '/api/items', { name: 'سمك تجربة', unit: 'كجم', kind: 'raw', daily: 1, carry_over: 1 });
  const p = await call('POST', '/api/purchases', { date: today, supplier: 'الدعدع', payment: 'paid', lines: [{ item_id: fish.id, qty: 42, unit_price: 50 }] });
  let r = await row(today, 'سمك تجربة');
  assert.strictEqual(r.received, 42, 'went to the count, not the warehouse');
  assert.strictEqual((await call('GET', '/api/warehouse')).find(i => i.id === fish.id).balance, 0);
  // تصحيح شراء قديم راح المستودع
  const p2 = await call('POST', '/api/purchases', { date: today, supplier: 'الدعدع', payment: 'paid', lines: [{ item_id: fish.id, qty: 8, unit_price: 50, to_floor: false }] });
  assert.strictEqual((await call('GET', '/api/warehouse')).find(i => i.id === fish.id).balance, 8);
  await call('POST', `/api/purchases/${p2.id}/place`, { to_floor: true });
  assert.strictEqual((await call('GET', '/api/warehouse')).find(i => i.id === fish.id).balance, 0);
  r = await row(today, 'سمك تجربة'); assert.strictEqual(r.received, 50);
  const pl = (await call('GET', `/api/purchases?from=${today}&to=${today}`)).find(x => x.id === p2.id);
  assert.strictEqual(pl.lines[0].to_floor, 1);
  assert.ok(p.id);
});

test('quick buy for the purchaser: frequent items with last price, suppliers, today and streak', async () => {
  const zak = (await call('GET', '/api/login-users')).find(u => u.name === 'زكريا');
  const ZT = await login(zak.id, '0000');
  const tom8 = (await call('GET', '/api/items')).find(i => i.name === 'طماطم') || await call('POST', '/api/items', { name: 'طماطم', unit: 'كجم', kind: 'raw' });
  await call('PUT', `/api/items/${tom8.id}/units`, { units: [{ name: 'كرتون', factor: 6 }] });
  await call('POST', '/api/purchases', { date: tom, supplier: 'خضار الوادي', payment: 'cash', lines: [{ item_id: tom8.id, qty: 2, unit: 'كرتون', unit_price: 30 }] }, ZT);
  await call('POST', '/api/purchases', { date: today, supplier: 'خضار الوادي', payment: 'cash', lines: [{ item_id: tom8.id, qty: 3, unit: 'كرتون', unit_price: 32 }] }, ZT);
  const q = await call('GET', '/api/purchases/quick', null, ZT);
  const t = q.items.find(i => i.id === tom8.id);
  assert.ok(t, 'frequent item is a tile');
  assert.deepStrictEqual([t.last.unit, t.last.qty, t.last.price, t.last.supplier], ['كرتون', 3, 32, 'خضار الوادي']);
  assert.deepStrictEqual(t.units, [{ name: 'كرتون', factor: 6 }]);
  assert.strictEqual(q.suppliers[0].name, 'خضار الوادي');
  assert.strictEqual(q.today.count, 1); assert.strictEqual(q.today.total, 96);
  assert.strictEqual(q.streak, 2);
  const w = await call('POST', '/api/users', { name: 'عامل بدون مشتريات', role: 'worker', pin: '4545' });
  await assert.rejects(call('GET', '/api/purchases/quick', null, await login(w.id, '4545')), e => e.status === 403);
});

test('cash custody: the owner gives Zakaria cash, custody purchases come out of it, the rest must be with him', async () => {
  const zak = (await call('GET', '/api/login-users')).find(u => u.name === 'زكريا');
  const ZT = await login(zak.id, '0000');
  const it = (await call('GET', '/api/items')).find(i => i.name === 'دقيق');
  const cash0 = (await call('GET', '/api/report?date=' + today)).money.expected_cash;
  await call('POST', '/api/custody', { user_id: zak.id, amount: '١٠٠٠', from_drawer: true, date: today });
  assert.strictEqual((await call('GET', '/api/report?date=' + today)).money.expected_cash, cash0 - 1000, 'came out of the drawer');
  // زكريا يسجل بنفسه «استلمت» — ينضاف، ويحتاج تأكيد المالك
  const self = await call('POST', '/api/custody', { user_id: 1, amount: 50, note: 'من نوح', date: today }, ZT);
  assert.strictEqual(self.user_id, zak.id, 'always his own custody');
  assert.strictEqual(self.balance, 1050); assert.strictEqual(self.unconfirmed.length, 1);
  const td = (await call('GET', '/api/dashboard')).todo.find(t => /زكريا كتب إنه استلم منك 50/.test(t.title));
  assert.ok(td, 'owner is asked to confirm');
  await call('POST', `/api/custody/${self.unconfirmed[0].id}/confirm`, {});
  assert.strictEqual((await call('GET', '/api/custody', null, ZT)).unconfirmed.length, 0);
  await call('POST', '/api/custody', { user_id: zak.id, amount: 50, type: 'return', date: today }); // نرجعها للحساب
  // بالبطاقة: ما يمس العهدة ولا الدرج
  await call('POST', '/api/purchases', { date: today, supplier: 'بنده', payment: 'card', lines: [{ item_id: it.id, qty: 1, unit_price: 77 }] }, ZT);
  assert.strictEqual((await call('GET', '/api/custody', null, ZT)).card_total_month, 77);
  await call('POST', '/api/purchases', { date: today, supplier: 'أبو سالم', payment: 'custody', image: IMG, lines: [{ item_id: it.id, qty: 3, unit_price: 100 }] }, ZT);
  await call('POST', '/api/purchases', { date: today, supplier: 'أبو سالم', payment: 'custody', lines: [{ item_id: it.id, qty: 2, unit_price: 100 }] }, ZT);
  await assert.rejects(call('POST', '/api/purchases', { date: today, payment: 'custody', lines: [{ item_id: it.id, qty: 2 }] }, ZT), /ينخصم من العهدة/);
  assert.strictEqual((await call('GET', '/api/report?date=' + today)).money.expected_cash, cash0 - 1000, 'custody purchases do not touch the drawer again');
  let c = await call('GET', '/api/custody', null, ZT);
  assert.deepStrictEqual([c.given, c.spent, c.balance, c.no_photo], [1050, 500, 500, 1]);
  assert.strictEqual(c.entries[0].balance, 500);
  await call('POST', '/api/custody', { user_id: zak.id, amount: 400, type: 'return', from_drawer: true, date: today });
  c = await call('GET', '/api/custody?user_id=' + zak.id);
  assert.strictEqual(c.balance, 100); assert.strictEqual(c.returned, 450);
  assert.strictEqual((await call('GET', '/api/purchases/quick', null, ZT)).custody.balance, 100);
  assert.ok((await call('GET', '/api/dashboard')).todo.some(t => /عهدة زكريا: باقي عنده 100/.test(t.title)));
  const w = await call('POST', '/api/users', { name: 'عامل العهدة', role: 'worker', pin: '3434' });
  await assert.rejects(call('GET', '/api/custody?user_id=' + zak.id, null, await login(w.id, '3434')), e => e.status === 403);
});

test('Zakaria spends from custody: home, an advance to a worker, a restaurant expense, and by card', async () => {
  const zak = (await call('GET', '/api/login-users')).find(u => u.name === 'زكريا');
  const ZT = await login(zak.id, '0000');
  const bal0 = (await call('GET', '/api/custody', null, ZT)).balance;
  const exp0 = (await call('GET', '/api/report?date=' + today)).money.expenses_total;
  const cash0 = (await call('GET', '/api/report?date=' + today)).money.expected_cash;
  const emp = await call('POST', '/api/users', { name: 'عامل السلفة', role: 'worker', pin: '5656' });
  await call('POST', '/api/expenses', { date: today, amount: '٤٠', kind: 'home', note: 'مقاضي', payment: 'custody', image: IMG }, ZT);
  await call('POST', '/api/expenses', { date: today, amount: 100, kind: 'advance', employee_id: emp.id, payment: 'custody' }, ZT);
  await call('POST', '/api/expenses', { date: today, amount: 25, kind: 'restaurant', category: 'غاز', payment: 'custody' }, ZT);
  await call('POST', '/api/expenses', { date: today, amount: 60, kind: 'home', payment: 'card' }, ZT);
  await call('POST', '/api/expenses', { date: today, amount: 9, payment: 'cash' }, ZT); // المشتري ما يصرف من الدرج => من عهدته
  await assert.rejects(call('POST', '/api/expenses', { date: today, kind: 'advance', amount: 5, payment: 'custody' }, ZT), /اختر الموظف/);
  const c = await call('GET', '/api/custody', null, ZT);
  assert.strictEqual(c.balance, bal0 - 40 - 100 - 25 - 9, 'custody spends come out of his balance; card does not');
  assert.ok(c.entries.some(e => e.kind === 'spend' && e.spend === 'home' && /مقاضي/.test(e.note)));
  assert.ok(c.card.some(x => x.amount === 60));
  const m = (await call('GET', '/api/report?date=' + today)).money;
  assert.strictEqual(m.expenses_total, exp0 + 25 + 9, 'home spends and advances are not restaurant expenses');
  assert.strictEqual(m.expected_cash, cash0, 'custody spends do not touch the drawer');
  const p = (await call('GET', '/api/payroll')).find(x => x.id === emp.id);
  assert.ok(p.entries.some(e => e.type === 'advance' && e.amount === 100), 'the advance lands in his payroll');
  const list = await call('GET', '/api/expenses?from=' + today + '&to=' + today);
  const adv = list.find(x => x.kind === 'advance' && x.payroll_id);
  await call('DELETE', '/api/expenses/' + adv.id);
  assert.ok(!(await call('GET', '/api/payroll')).find(x => x.id === emp.id).entries.some(e => e.type === 'advance'), 'deleting it removes the payroll advance');
  const mr = await call('GET', '/api/monthly-report?month=' + today.slice(0, 7));
  assert.ok(mr.summary.home >= 100);
});
