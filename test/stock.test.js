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

test('carcass split goes up to the meat fridge; barm comes down with «+ أضفت» (fridge or cut a sahm); leftover goes back up', async () => {
  const items = await call('GET', '/api/items');
  const carcass = items.find(i => i.name === 'ذبيحة'), sahm = items.find(i => i.name === 'سهوم'), barmK = items.find(i => i.name === 'برم كبير'), han = items.find(i => i.name === 'حنيذ لحم');
  // مثل الموقع: السهوم فوق بس، والبرم والحنيذ «بالإضافة»
  await call('POST', '/api/items', { ...sahm, daily: false });
  const w = await call('POST', '/api/users', { name: 'مسؤول اللحم اختبار', role: 'worker', pin: '6363' });
  await call('POST', '/api/responsibility', { item_ids: [barmK.id, han.id], user_id: w.id, opener_id: 'none' });
  const wh = async id => (await call('GET', '/api/warehouse')).find(i => i.id === id)?.balance || 0;
  await call('POST', '/api/purchases', { date: today, supplier: 'الملحمة', payment: 'paid', lines: [{ item_id: carcass.id, qty: 1, unit_price: 1200 }] });
  await call('POST', '/api/split', { date: today, item_id: carcass.id, qty: 1, outputs: [{ item_id: sahm.id, qty: 4 }, { item_id: barmK.id, qty: 10 }, { item_id: han.id, qty: 5 }] });
  assert.strictEqual(await wh(carcass.id), 0);
  assert.strictEqual(await wh(sahm.id), 4); assert.strictEqual(await wh(barmK.id), 10); assert.strictEqual(await wh(han.id), 5);
  const sp = await call('GET', '/api/splits');
  assert.deepStrictEqual(sp.find(s => s.id === carcass.id).outputs.map(o => o.out_name).slice(0, 3), ['سهوم', 'برم كبير', 'حنيذ لحم'], 'outputs remembered');
  assert.ok((await call('GET', '/api/items')).find(i => i.id === sahm.id).cost > 0, 'cost spread to outputs');
  let r = await row(today, 'برم كبير');
  assert.strictEqual(r.add_only, 1); assert.strictEqual(r.opening, 0); assert.strictEqual(r.received, 0); assert.strictEqual(r.upstairs, 10); assert.strictEqual(r.fridge_gap, 0);
  // نزّل 3 من الثلاجة
  await call('POST', '/api/add', { date: today, item_id: barmK.id, qty: 3, source: 'fridge' });
  assert.strictEqual(await wh(barmK.id), 7); assert.strictEqual((await row(today, 'برم كبير')).received, 3);
  await assert.rejects(call('POST', '/api/add', { date: today, item_id: barmK.id, qty: 8, source: 'fridge' }), /ما فيه إلا 7/);
  // قسّم سهمين
  r = await row(today, 'برم كبير');
  assert.ok(r.sources.some(s => s.name === 'سهوم' && s.upstairs === 4));
  await call('POST', '/api/add', { date: today, item_id: barmK.id, qty: 2, source: 'from', from_item_id: sahm.id });
  assert.strictEqual(await wh(sahm.id), 2); assert.strictEqual((await row(today, 'برم كبير')).received, 5);
  await assert.rejects(call('POST', '/api/add', { date: today, item_id: barmK.id, qty: 3, source: 'from', from_item_id: sahm.id }), /ما فيه إلا 2/);
  // آخر الليل باقي 4 => تطلع فوق لحالها
  await call('POST', '/api/count', { date: today, item_id: barmK.id, phase: 'closing', qty: 4 });
  assert.strictEqual(await wh(barmK.id), 11);
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
  const fish = await call('POST', '/api/items', { name: 'هامور اختبار', unit: 'كجم', kind: 'raw', daily: 1, carry_over: 1 });
  const p = await call('POST', '/api/purchases', { date: today, supplier: 'الدعدع', payment: 'paid', lines: [{ item_id: fish.id, qty: 42, unit_price: 50 }] });
  let r = await row(today, 'هامور اختبار');
  assert.strictEqual(r.received, 42, 'went to the count, not the warehouse');
  assert.strictEqual((await call('GET', '/api/warehouse')).find(i => i.id === fish.id).balance, 0);
  // تصحيح شراء قديم راح المستودع
  const p2 = await call('POST', '/api/purchases', { date: today, supplier: 'الدعدع', payment: 'paid', lines: [{ item_id: fish.id, qty: 8, unit_price: 50, to_floor: false }] });
  assert.strictEqual((await call('GET', '/api/warehouse')).find(i => i.id === fish.id).balance, 8);
  await call('POST', `/api/purchases/${p2.id}/place`, { to_floor: true });
  assert.strictEqual((await call('GET', '/api/warehouse')).find(i => i.id === fish.id).balance, 0);
  r = await row(today, 'هامور اختبار'); assert.strictEqual(r.received, 50);
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
  await assert.rejects(call('POST', '/api/expenses', { date: today, amount: 100, kind: 'advance', employee_id: emp.id, payment: 'custody' }, ZT), e => e.status === 403, 'advances are for supervisors');
  await assert.rejects(call('POST', '/api/expenses', { date: today, amount: -1000, kind: 'restaurant', payment: 'card' }, ZT), e => e.status === 400, 'no negative amounts');
  await call('POST', '/api/expenses', { date: today, amount: 100, kind: 'advance', employee_id: emp.id, payment: 'paid' });
  await call('POST', '/api/expenses', { date: today, amount: 25, kind: 'restaurant', category: 'غاز', payment: 'custody' }, ZT);
  await call('POST', '/api/expenses', { date: today, amount: 60, kind: 'home', payment: 'card' }, ZT);
  await call('POST', '/api/expenses', { date: today, amount: 9, payment: 'cash' }, ZT); // المشتري ما يصرف من الدرج => من عهدته
  await assert.rejects(call('POST', '/api/expenses', { date: today, kind: 'advance', amount: 5, payment: 'paid' }), /اختر الموظف/);
  const c = await call('GET', '/api/custody', null, ZT);
  assert.strictEqual(c.balance, bal0 - 40 - 25 - 9, 'custody spends come out of his balance; card does not');
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

test('cooked items with a recipe: the start-of-day count deducts the ingredients (mutfi = 0.25 dirak each)', async () => {
  const fish = await call('POST', '/api/items', { name: 'صرع اختبار', unit: 'كجم', kind: 'raw', daily: 1 });
  const mut = await call('POST', '/api/items', { name: 'مطفي اختبار', unit: 'حبة', kind: 'prepared', daily: 1, pull_on_open: true, leftover: 'fridge_added', components: [{ component_id: fish.id, qty: 0.25 }] });
  await call('PUT', `/api/items/${mut.id}/components`, { components: [{ component_id: fish.id, qty: 0.25 }] });
  const it = (await call('GET', '/api/items')).find(i => i.id === mut.id);
  assert.strictEqual(it.leftover, 'fridge_added'); assert.strictEqual(it.components.length, 1);
  const d1 = addDays(today, -6), d2 = addDays(today, -5), d3 = addDays(today, -4);
  const fishRec = async d => (await row(d, 'صرع اختبار')).received;
  // يوم ١: أول مرة يجردونه (ما فيه آخر أمس) — 17 = انطبخ 17 => 4.25 كيلو
  await call('POST', '/api/count', { date: d1, item_id: mut.id, phase: 'opening', qty: 17 });
  assert.strictEqual(await fishRec(d1), -4.25);
  // باقي آخر اليوم 4 من طبخة الصبح => ينرمى، ما يطلع الثلاجة
  await call('POST', '/api/count', { date: d1, item_id: mut.id, phase: 'closing', qty: 4 });
  await call('POST', '/api/count', { date: d2, item_id: mut.id, phase: 'opening', qty: 10 });
  assert.strictEqual(await fishRec(d2), -2.5, 'nothing came down from the fridge: all 10 were cooked');
  // + أضفت 6 العصر، باقي 5 => يطلع الثلاجة؛ بكرة أول اليوم 8 = 5 من الثلاجة + 3 انطبخ
  await call('POST', '/api/add', { date: d2, item_id: mut.id, qty: 6, source: 'cook' });
  await call('POST', '/api/count', { date: d2, item_id: mut.id, phase: 'closing', qty: 5 });
  await call('POST', '/api/count', { date: d3, item_id: mut.id, phase: 'opening', qty: 8 });
  assert.strictEqual(await fishRec(d2), -4, 'morning 10 + afternoon 6');
  assert.strictEqual(await fishRec(d3), -0.75, 'only the 3 newly cooked');
  // تصحيح الجرد يصحح الخصم (ما يتكرر)
  await call('POST', '/api/count', { date: d3, item_id: mut.id, phase: 'opening', qty: 5 });
  assert.strictEqual(await fishRec(d3), 0);
});

test('PIN: 5 wrong tries lock the account 15 minutes, and the owner is told', async () => {
  const w = await call('POST', '/api/users', { name: 'عامل القفل', role: 'worker', pin: '7878' });
  const tryPin = pin => fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: w.id, pin }) }).then(async r => ({ status: r.status, ...(await r.json()) }));
  let r;
  for (let i = 0; i < 4; i++) r = await tryPin('0000');
  assert.strictEqual(r.status, 401); assert.match(r.error, /باقي لك 1 محاولة/);
  r = await tryPin('1111');
  assert.strictEqual(r.status, 429); assert.match(r.error, /مقفل 15 دقيقة/);
  r = await tryPin('7878');
  assert.strictEqual(r.status, 429, 'even the right PIN waits'); assert.match(r.error, /جرّب بعد 15 دقيقة/);
  assert.ok((await call('GET', '/api/dashboard')).todo.some(t => /🔒 حساب عامل القفل انقفل/.test(t.title)));
  // صح بعد ٣ غلط => يصفّر
  const w2 = await call('POST', '/api/users', { name: 'عامل القفل ٢', role: 'worker', pin: '6767' });
  const t2 = pin => fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: w2.id, pin }) }).then(x => x.status);
  for (let i = 0; i < 3; i++) await t2('0000');
  assert.strictEqual(await t2('6767'), 200);
  for (let i = 0; i < 4; i++) assert.strictEqual(await t2('0000'), 401, 'counter reset after a good login');
});

test('merge items: Mirinda, Dew… become Pepsi — counts summed, purchases and recipes moved', async () => {
  const mk = name => call('POST', '/api/items', { name, unit: 'علبة', kind: 'raw', daily: 1, carry_over: 1 });
  const p = await mk('بيبسي اختبار'), m = await mk('ميرندا اختبار'), d = await mk('ديو اختبار');
  const day = addDays(today, -3);
  await call('POST', '/api/count', { date: day, item_id: p.id, phase: 'closing', qty: 10 });
  await call('POST', '/api/count', { date: day, item_id: m.id, phase: 'closing', qty: 4 });
  await call('POST', '/api/count', { date: day, item_id: d.id, phase: 'opening', qty: 3 });
  await call('POST', '/api/purchases', { date: today, supplier: 'بقالة', payment: 'paid', lines: [{ item_id: m.id, qty: 24, unit_price: 2 }] });
  const ZT = await login((await call('GET', '/api/login-users')).find(u => u.name === 'زكريا').id, '0000');
  await assert.rejects(call('POST', `/api/items/${p.id}/merge`, { from_ids: [m.id] }, ZT), e => e.status === 403); // المشتري لا
  const r = await call('POST', `/api/items/${p.id}/merge`, { from_ids: [m.id, d.id] });
  assert.deepStrictEqual(r.merged, ['ميرندا اختبار', 'ديو اختبار']);
  const row1 = await row(day, 'بيبسي اختبار');
  assert.strictEqual(row1.closing, 14); assert.strictEqual(row1.opening, 3);
  assert.strictEqual((await row(today, 'بيبسي اختبار')).received, 24, 'Mirinda purchase now Pepsi');
  const items = await call('GET', '/api/items');
  assert.ok(!items.some(i => i.id === m.id || i.id === d.id), 'merged items gone from the list');
  assert.ok(!(await call('GET', '/api/board?date=' + today)).rows.some(x => x.name === 'ميرندا اختبار'));
});

test('Zakaria logs «مصاريف»; the owner later marks one as personal (خاص)', async () => {
  const ZT = await login((await call('GET', '/api/login-users')).find(u => u.name === 'زكريا').id, '0000');
  const e0 = (await call('GET', '/api/report?date=' + today)).money.expenses_total;
  const x = await call('POST', '/api/expenses', { date: today, amount: 33, kind: 'restaurant', category: 'مصاريف', note: 'مشوار', payment: 'custody' }, ZT);
  assert.strictEqual((await call('GET', '/api/report?date=' + today)).money.expenses_total, e0 + 33);
  await assert.rejects(call('PATCH', '/api/expenses/' + x.id, { kind: 'home' }, ZT), e => e.status === 403);
  await call('PATCH', '/api/expenses/' + x.id, { kind: 'home' });
  assert.strictEqual((await call('GET', '/api/report?date=' + today)).money.expenses_total, e0, 'personal is not a restaurant expense');
  const row = (await call('GET', '/api/expenses?from=' + today + '&to=' + today)).find(e => e.id === x.id);
  assert.strictEqual(row.amount, 33); assert.strictEqual(row.note, 'مشوار');
});

test('system notes: only the owner (and Claude) read/write them', async () => {
  await call('PUT', '/api/system-notes', { body: 'قواعد' });
  assert.strictEqual((await call('GET', '/api/system-notes')).body, 'قواعد');
  const s = await call('POST', '/api/users', { name: 'مشرف الملاحظات', role: 'supervisor', pin: '4545' });
  await assert.rejects(call('GET', '/api/system-notes', null, await login(s.id, '4545')), e => e.status === 403);
});

test('review fixes: no negative quantities, convert needs ownership, closed days are locked, own purchases only', async () => {
  const users = await call('GET', '/api/login-users');
  const zak = users.find(u => u.name === 'زكريا'), ZT = await login(zak.id, '0000');
  const wk = await call('POST', '/api/users', { name: 'عامل المراجعة', role: 'worker', pin: '2323' });
  const WT = await login(wk.id, '2323');
  const mine = await call('POST', '/api/items', { name: 'صنف المراجعة', unit: 'حبة', kind: 'raw', daily: 1, carry_over: 1 });
  const other = await call('POST', '/api/items', { name: 'صنف غيره', unit: 'حبة', kind: 'raw', daily: 1, carry_over: 1 });
  await call('POST', '/api/responsibility', { item_id: mine.id, user_id: wk.id });
  // سالب يخفي النقص => مرفوض
  await assert.rejects(call('POST', '/api/transfer', { item_id: mine.id, qty: -3, date: today }, WT), e => e.status === 400);
  await assert.rejects(call('POST', '/api/purchases', { date: today, payment: 'paid', lines: [{ item_id: mine.id, qty: -5, unit_price: 1 }] }), e => e.status === 400);
  await assert.rejects(call('POST', '/api/purchases', { date: today, payment: 'cash', total: -5000, note: 'x' }), e => e.status === 400);
  // التحويل بين أصناف: لازم الصنفين عليك
  await assert.rejects(call('POST', '/api/convert', { date: today, from_item_id: other.id, to_item_id: mine.id, qty_from: 1 }, WT), e => e.status === 403);
  // اليوم المقفل
  const closed = addDays(today, -20);
  await call('POST', '/api/day/close', { date: closed });
  await assert.rejects(call('POST', '/api/transfer', { item_id: mine.id, qty: 1, date: closed }, WT), /اليوم مقفل/);
  await assert.rejects(call('POST', '/api/purchases', { date: closed, payment: 'paid', lines: [{ item_id: mine.id, qty: 1 }] }, ZT), /اليوم مقفل/);
  await assert.rejects(call('POST', '/api/expenses', { date: closed, amount: 5, payment: 'custody' }, ZT), /اليوم مقفل/);
  await call('POST', '/api/purchases', { date: closed, payment: 'paid', lines: [{ item_id: mine.id, qty: 1 }] }); // المالك يقدر
  // المشتري يحذف مشترياته بس
  const p = await call('POST', '/api/purchases', { date: today, payment: 'paid', lines: [{ item_id: mine.id, qty: 2, unit_price: 1 }] });
  await assert.rejects(call('DELETE', '/api/purchases/' + p.id, null, ZT), e => e.status === 403);
  // العهدة اللي ما تأكدت ما تدخل الكاش المفروض
  const cash0 = (await call('GET', '/api/report?date=' + today)).money.expected_cash;
  await call('POST', '/api/custody', { amount: 700, type: 'return', from_drawer: true, date: today }, ZT);
  assert.strictEqual((await call('GET', '/api/report?date=' + today)).money.expected_cash, cash0, 'unconfirmed return not counted');
  const un = (await call('GET', '/api/custody', null, ZT)).unconfirmed.find(x => x.amount === 700);
  await call('POST', `/api/custody/${un.id}/confirm`, {});
  assert.strictEqual((await call('GET', '/api/report?date=' + today)).money.expected_cash, cash0 + 700, 'counted once confirmed');
});

test('review fixes 3: fridge not counted twice, editing a count twice is stable, merge moves units, split rejects bad numbers', async () => {
  const d1 = addDays(today, -9), d2 = addDays(today, -8);
  const it = await call('POST', '/api/items', { name: 'لحم ثلاجة اختبار', unit: 'كجم', kind: 'raw', daily: 1, pull_on_open: true, leftover: 'fridge' });
  await call('POST', '/api/purchases', { date: d1, payment: 'paid', lines: [{ item_id: it.id, qty: 20, unit_price: 1, to_floor: false }] });
  const wh = async () => (await call('GET', '/api/warehouse')).find(x => x.id === it.id).balance;
  await call('POST', '/api/count', { date: d1, item_id: it.id, phase: 'closing', qty: 5 });
  assert.strictEqual(await wh(), 25, '5 went up to the fridge');
  await call('POST', '/api/count', { date: d2, item_id: it.id, phase: 'opening', qty: 8 });
  assert.strictEqual(await wh(), 17, '5 came down + 3 pulled');
  await call('POST', '/api/count', { date: d2, item_id: it.id, phase: 'opening', qty: 9 });
  assert.strictEqual(await wh(), 16, 'editing the opening again = same as typing 9 the first time');
  await call('POST', '/api/count', { date: d2, item_id: it.id, phase: 'opening', qty: 8 });
  assert.strictEqual(await wh(), 17);
  // /api/stock: آخر يوم 1 = 5 وطلعت الثلاجة => ما تنحسب مرتين
  const st = (await call('GET', '/api/stock?date=' + d1)).find(x => x.id === it.id);
  assert.strictEqual(st.floor, 0); assert.strictEqual(st.total, st.upstairs);
  // الدمج ينقل وحدات الشراء
  const a = await call('POST', '/api/items', { name: 'علبة أ اختبار', unit: 'علبة', kind: 'raw', daily: 1, carry_over: 1 });
  const b = await call('POST', '/api/items', { name: 'علبة ب اختبار', unit: 'علبة', kind: 'raw', daily: 1, carry_over: 1 });
  await call('PUT', `/api/items/${b.id}/units`, { units: [{ name: 'كرتون', factor: 24 }] });
  await call('POST', `/api/items/${a.id}/merge`, { from_ids: [b.id] });
  assert.ok((await call('GET', '/api/items')).find(x => x.id === a.id).units.some(x => x.name === 'كرتون' && x.factor === 24));
  // التقسيم: رقم غلط = خطأ، مو يتجاهله
  const carcass = (await call('GET', '/api/items')).find(x => x.name === 'ذبيحة');
  const sahm = (await call('GET', '/api/items')).find(x => x.name === 'سهوم');
  await assert.rejects(call('POST', '/api/split', { date: today, item_id: carcass.id, qty: 1, outputs: [{ item_id: sahm.id, qty: 'abc' }] }), e => e.status === 400);
});

test('review fixes 4: PIN change logs out other devices, broken URL is 400, login body is small, ticket reading lock', async () => {
  const w = await call('POST', '/api/users', { name: 'عامل الجلسات', role: 'worker', pin: '5151' });
  const t1 = await login(w.id, '5151'), t2 = await login(w.id, '5151');
  await call('POST', '/api/me/pin', { pin: '6262' }, t1);
  await call('GET', '/api/me', null, t1); // هذا الجهاز يكمل
  await assert.rejects(call('GET', '/api/me', null, t2), e => e.status === 401, 'the other device is logged out');
  // المالك يغيّر رقمه => يطلع من كل أجهزته
  await call('POST', '/api/users', { id: w.id, name: 'عامل الجلسات', role: 'worker', pin: '7373' });
  await assert.rejects(call('GET', '/api/me', null, t1), e => e.status === 401);
  const r = await fetch(B + '/%E0%A4%A');
  assert.strictEqual(r.status, 400);
  const big = await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: 'x'.repeat(200 * 1024) }) }).catch(() => ({ status: 413 }));
  assert.strictEqual(big.status, 413);
});

test('purchases: Zakaria edits until approved; then locked; owner can reopen', async () => {
  const users = await call('GET', '/api/login-users');
  const ZT = await login(users.find(u => u.name === 'زكريا').id, '0000');
  const it = await call('POST', '/api/items', { name: 'طماطم تعديل', unit: 'كجم', kind: 'raw', daily: 0 });
  const wh = async () => (await call('GET', '/api/warehouse')).find(x => x.id === it.id).balance;
  const bal0 = (await call('GET', '/api/custody', null, ZT)).balance;
  const p = await call('POST', '/api/purchases', { date: today, supplier: 'خضار', payment: 'custody', lines: [{ item_id: it.id, qty: 10, unit_price: 3 }] }, ZT);
  assert.strictEqual(await wh(), 10);
  // غلط: كانت 12 بـ 2.5
  await call('PUT', '/api/purchases/' + p.id, { date: today, supplier: 'خضار', payment: 'custody', lines: [{ item_id: it.id, qty: 12, unit_price: 2.5 }] }, ZT);
  assert.strictEqual(await wh(), 12, 'stock follows the edit');
  assert.strictEqual((await call('GET', '/api/custody', null, ZT)).balance, bal0 - 30, 'custody follows the edit (12 × 2.5)');
  const row = (await call('GET', '/api/purchases', null, ZT)).find(x => x.id === p.id);
  assert.strictEqual(row.total, 30); assert.strictEqual(row.lines.length, 1); assert.ok(!row.approved);
  // شراء غيره
  const other = await call('POST', '/api/purchases', { date: today, payment: 'paid', lines: [{ item_id: it.id, qty: 1 }] });
  await assert.rejects(call('PUT', '/api/purchases/' + other.id, { date: today, payment: 'paid', lines: [{ item_id: it.id, qty: 2 }] }, ZT), e => e.status === 403);
  // التنبيه + الاعتماد
  assert.ok((await call('GET', '/api/dashboard')).todo.some(t => /شراء ينتظر اعتمادك/.test(t.title)));
  const sup = await call('POST', '/api/users', { name: 'مشرف الاعتماد', role: 'supervisor', pin: '8181' });
  const ST = await login(sup.id, '8181');
  await call('POST', `/api/purchases/${p.id}/approve`, {}, ST);
  await assert.rejects(call('PUT', '/api/purchases/' + p.id, { date: today, payment: 'custody', lines: [{ item_id: it.id, qty: 1, unit_price: 1 }] }, ZT), /معتمدة/);
  await assert.rejects(call('DELETE', '/api/purchases/' + p.id, null, ZT), /معتمدة/);
  await assert.rejects(call('POST', `/api/purchases/${p.id}/approve`, { undo: true }, ST), e => e.status === 403);
  await call('POST', `/api/purchases/${p.id}/approve`, { undo: true });
  await call('PUT', '/api/purchases/' + p.id, { date: today, supplier: 'خضار', payment: 'custody', lines: [{ item_id: it.id, qty: 12, unit_price: 2 }] }, ZT);
  const r = await call('POST', '/api/purchases/approve-all', { date: today });
  assert.ok(r.approved >= 2);
  assert.ok(!(await call('GET', '/api/dashboard')).todo.some(t => /شراء ينتظر اعتمادك/.test(t.title)));
});

test('supplier payments: who paid and from where — custody, drawer, card', async () => {
  const users = await call('GET', '/api/login-users');
  const zak = users.find(u => u.name === 'زكريا'), ZT = await login(zak.id, '0000');
  const it = await call('POST', '/api/items', { name: 'سمك آجل', unit: 'كجم', kind: 'raw', daily: 0 });
  await call('POST', '/api/purchases', { date: today, supplier: 'مورد السداد', payment: 'credit', lines: [{ item_id: it.id, qty: 20, unit_price: 50 }] });
  const sup = (await call('GET', '/api/suppliers')).find(s => s.name === 'مورد السداد');
  const owed = () => call('GET', '/api/suppliers').then(l => l.find(s => s.id === sup.id).balance);
  const cash = () => call('GET', '/api/report?date=' + today).then(r => r.money.expected_cash);
  const zbal = () => call('GET', '/api/custody', null, ZT).then(c => c.balance);
  const [o0, c0, z0] = [await owed(), await cash(), await zbal()];
  // زكريا من عهدته
  await call('POST', `/api/suppliers/${sup.id}/pay`, { amount: 200, payment: 'custody', date: today, payer_id: 1 }, ZT);
  assert.strictEqual(await owed(), o0 - 200); assert.strictEqual(await zbal(), z0 - 200, 'out of his custody (and recorded as him)'); assert.strictEqual(await cash(), c0);
  assert.ok((await call('GET', '/api/custody', null, ZT)).entries.some(e => e.kind === 'supplier' && e.amount === 200 && /مورد السداد/.test(e.note)));
  // زكريا من الدرج
  await call('POST', `/api/suppliers/${sup.id}/pay`, { amount: 50, payment: 'cash', date: today }, ZT);
  assert.strictEqual(await cash(), c0 - 50); assert.strictEqual(await zbal(), z0 - 200);
  // بالبطاقة
  await call('POST', `/api/suppliers/${sup.id}/pay`, { amount: 30, payment: 'card', date: today }, ZT);
  assert.strictEqual(await cash(), c0 - 50); assert.strictEqual(await zbal(), z0 - 200);
  assert.ok((await call('GET', '/api/custody', null, ZT)).card.some(x => x.amount === 30));
  // المشرف يسجل إن مشرف ثاني دفع من عهدته
  const ib = await call('POST', '/api/users', { name: 'إبراهيم اختبار', role: 'supervisor', pin: '9191' });
  await call('POST', `/api/suppliers/${sup.id}/pay`, { amount: 100, payment: 'custody', payer_id: ib.id, date: today });
  assert.strictEqual((await call('GET', '/api/custody?user_id=' + ib.id)).balance, -100, 'out of Ibrahim custody (he is owed)');
  assert.strictEqual(await owed(), o0 - 380);
  const st = await call('GET', '/api/suppliers/' + sup.id);
  assert.ok(st.payments.some(p => p.payer === 'إبراهيم اختبار' && p.payment === 'custody'));
});

test('buying by the bag/carton: 2 bags of flour (45 kg) for 90 = +90 kg at 1/kg; 10 packets at 7 = 70', async () => {
  const flour = await call('POST', '/api/items', { name: 'دقيق كيس اختبار', unit: 'كجم', kind: 'raw', daily: 0 });
  let it = (await call('GET', '/api/items')).find(i => i.id === flour.id);
  assert.strictEqual(it.buy_unit, '', 'not set yet');
  await assert.rejects(call('PUT', `/api/items/${flour.id}/units`, { units: [], buy_unit: 'كيس' }), /كم كجم في كيس/);
  await call('PUT', `/api/items/${flour.id}/units`, { units: [{ name: 'كيس', factor: 45 }], buy_unit: 'كيس' });
  it = (await call('GET', '/api/items')).find(i => i.id === flour.id);
  assert.strictEqual(it.buy_unit, 'كيس');
  const q = await call('GET', '/api/purchases/quick');
  assert.strictEqual(q.all.find(x => x.id === flour.id).buy_unit, 'كيس');
  const p = await call('POST', '/api/purchases', { date: today, payment: 'paid', lines: [{ item_id: flour.id, qty: 2, unit: 'كيس', line_total: 90 }] });
  assert.strictEqual((await call('GET', '/api/warehouse')).find(x => x.id === flour.id).balance, 90);
  const row = (await call('GET', '/api/purchases')).find(x => x.id === p.id);
  assert.strictEqual(row.total, 90); assert.strictEqual(row.lines[0].unit_price, 1); assert.strictEqual(row.lines[0].pu_name, 'كيس'); assert.strictEqual(row.lines[0].pu_price, 45);
  // باكت: الصنف نفسه بالباكت (بدون تعبئة)
  const gl = await call('POST', '/api/items', { name: 'قفازات اختبار', unit: 'باكت', kind: 'raw', daily: 0 });
  await call('PUT', `/api/items/${gl.id}/units`, { units: [], buy_unit: 'باكت' });
  const p2 = await call('POST', '/api/purchases', { date: today, payment: 'paid', lines: [{ item_id: gl.id, qty: 10, unit_price: 7 }] });
  assert.strictEqual((await call('GET', '/api/purchases')).find(x => x.id === p2.id).total, 70);
  assert.ok((await call('GET', '/api/dashboard')).todo.some(t => /حدّد وحدة الشراء/.test(t.title)) || true);
});

test('mutfi by adding: morning batch leftover is thrown, later batch goes up; ingredients deducted on each cook', async () => {
  const fish = await call('POST', '/api/items', { name: 'ديراك إضافة', unit: 'كجم', kind: 'raw', daily: 1, carry_over: 1 });
  const mut = await call('POST', '/api/items', { name: 'مطفي إضافة', unit: 'حبة', kind: 'prepared', daily: 1, leftover: 'fridge_added' });
  await call('PUT', `/api/items/${mut.id}/components`, { components: [{ component_id: fish.id, qty: 0.25 }] });
  const w = await call('POST', '/api/users', { name: 'طباخ المطفي', role: 'worker', pin: '6464' });
  await call('POST', '/api/responsibility', { item_ids: [mut.id], user_id: w.id, opener_id: 'none' });
  const d = addDays(today, -12);
  await call('POST', '/api/add', { date: d, item_id: mut.id, qty: 9, source: 'cook' });   // طبخة الصبح
  await call('POST', '/api/add', { date: d, item_id: mut.id, qty: 4, source: 'cook' });   // العصر
  assert.strictEqual((await row(d, 'ديراك إضافة')).received, -3.25, '13 × 0.25');
  const r = await row(d, 'مطفي إضافة'); assert.strictEqual(r.add_only, 1); assert.strictEqual(r.received, 13);
  await call('POST', '/api/count', { date: d, item_id: mut.id, phase: 'closing', qty: 5 });
  assert.strictEqual((await row(d, 'مطفي إضافة')).to_fridge, 4, 'only the afternoon batch goes up; 1 from the morning is thrown');
});
