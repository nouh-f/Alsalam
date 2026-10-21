'use strict';
// 📊 ورقة الحساب في جروب «حساب اليوم»: تنقرا وتنحفظ، والتقرير (الطابعة − اللي باسم ⇔ الورقة) ينزل في نفس الجروب
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

let srv, B, T, DIR, FX, today;
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const G = 'daily1@g.us', PH = '966500000931';
const sheet = o => ({ stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify({ date: null, lines: [], ...o }) }] });

test.before(async () => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-dsheet-'));
  FX = path.join(DIR, 'ai.json');
  fs.writeFileSync(FX, JSON.stringify([
    sheet({ card: null, cash: null, spent: null, total: null }), // صورة أكل — مو ورقة الحساب
    sheet({ card: 100, cash: 40, spent: 5, total: 145 }),
  ]));
  const port = 45200 + Math.floor(Math.random() * 300); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: DIR, AI_FIXTURE: FX, WA_TEST_INJECT: '1' }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  today = (await call('GET', '/api/me')).today;
  await call('POST', '/api/settings', { anthropic_key: 'sk-test' });
  await call('POST', '/api/whatsapp/groups', { groups: [{ id: G, role: 'daily' }] });
});
test.after(() => srv.kill());

test('the totals sheet in «حساب اليوم» is saved and the report (printer − named tickets vs the sheet) goes to the same group', async () => {
  await call('POST', '/api/users', { name: 'كاشير ورقة', role: 'supervisor', pin: '9393', phone: '0500000931' });
  const db = new DatabaseSync(path.join(DIR, 'alsalam.db'));
  const pid = Number(db.prepare("INSERT INTO products(loyverse_item_id, loyverse_variant_id, name, variant, category, price, sku, active) VALUES('x','v1','مرسة','','',10,'',1)").run().lastInsertRowid);
  let job = 0;
  const slip = (ticket, name, qty) => {
    const id = ++job;
    db.prepare("INSERT INTO printer_jobs(id, at, raw_file) VALUES(?, ?, '')").run(id, today + ' 10:00:0' + id);
    db.prepare("INSERT INTO printer_orders(job_id, date, kind, ticket_no, ticket_name, employee, items) VALUES(?,?,'order',?,?,'المالك',?)").run(id, today, ticket, name, JSON.stringify([{ name: 'مرسة', product_id: pid, qty }]));
  };
  slip('06-001', 'التذكرة - 4:53 م', 10); // 100
  slip('06-002', 'سفري', 6); // 60
  slip('06-003', 'عمار', 2); // 20 باسم
  db.close();
  const n0 = (await call('GET', '/api/whatsapp/_outbox')).length;
  await call('POST', '/api/whatsapp/_inject', { id: 'p1', phone: PH, chat: G, isGroup: true, groupName: 'حساب اليوم', image_b64: 'AAAA' });
  await new Promise(r => setTimeout(r, 400));
  assert.ok(!(await call('GET', '/api/whatsapp/_outbox')).slice(n0).length, 'صورة مو ورقة الحساب => سكوت');
  await call('POST', '/api/whatsapp/_inject', { id: 'p2', phone: PH, chat: G, isGroup: true, groupName: 'حساب اليوم', image_b64: 'BBBB' });
  let ob = [];
  for (let i = 0; i < 60 && !ob.length; i++) { ob = (await call('GET', '/api/whatsapp/_outbox')).slice(n0).filter(x => x.to === G); if (!ob.length) await new Promise(r => setTimeout(r, 50)); }
  const t = ob[0].text;
  assert.match(t, /المبيعات من الطابعة: \*180\* \(3 طلب\)/);
  assert.match(t, /• عمار — \*20\*: 2 مرسة/);
  assert.match(t, /المفروض يوصل .*\*160\*/);
  assert.match(t, /= \*145\*/);
  assert.match(t, /نقص 15 ريال/);
  const m = (await call('GET', '/api/dashboard?date=' + today)).money;
  assert.strictEqual(m.sheet.card, 100); assert.strictEqual(m.sheet.cash, 40); assert.strictEqual(m.sheet.spent, 5);
});

test('sheet lines are NOT saved on their own: Nouh gets one numbered card; «تمام» saves drawer expenses, salary withdrawals, bonuses — once even if the sheet is re-sent; a written «تعديل» is a card too', async () => {
  const owner = (await call('GET', '/api/users')).find(x => x.id === 1);
  await call('POST', '/api/users', { id: 1, name: owner.name, role: 'owner', pin: '1234', phone: '0500000930' });
  const { id: wk } = await call('POST', '/api/users', { name: 'صادق ورقة', role: 'worker', pin: '9494' });
  const L = (o) => ({ date: null, item_id: null, qty: null, unit: '', category: '', supplier_id: null, supplier_name: '', employee: '', uncertain: false, ...o });
  const full = sheet({ card: 100, cash: 40, transfer: 30, spent: 280, total: 450, lines: [
    L({ text: 'غاز 40', kind: 'expense', amount: 40, category: 'غاز' }),
    L({ text: 'صادق 200 باقي', kind: 'salary', amount: 200, employee: 'صادق ورقة' }),
    L({ text: 'مكافأة 15', kind: 'bonus', amount: 15, employee: 'صادق ورقة' }),
    L({ text: 'خالد 25 سحبية', kind: 'salary', amount: 25, employee: 'خالد' }),
  ] });
  const bad = sheet({ card: 100, cash: 40, transfer: 0, spent: 280, total: 999, lines: [L({ text: 'غاز 280', kind: 'expense', amount: 280 })] });
  const edit = { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify({ total: 512, lines: [{ text: 'لحوح 62', kind: 'expense', amount: 62, employee: '' }] }) }] };
  const runs = JSON.parse(fs.readFileSync(FX, 'utf8'));
  const say = t => ({ stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: t }] });
  fs.writeFileSync(FX, JSON.stringify([...runs.slice(0, 2), full, say('طيب'), full, edit, bad, bad]));
  const sent = async (n0, f) => { for (let i = 0; i < 80; i++) { const x = (await call('GET', '/api/whatsapp/_outbox')).slice(n0).filter(f); if (x.length) return x; await new Promise(r => setTimeout(r, 50)); } return []; };
  const sheetExp = async () => (await call('GET', '/api/report?date=' + today)).expenses.filter(e => /\[ورقة /.test(e.note));
  for (const id of ['p3', 'p4']) { // نفس الورقة مرتين => كرت، و«تمام» ما يكرر شي
    const n0 = (await call('GET', '/api/whatsapp/_outbox')).length;
    await call('POST', '/api/whatsapp/_inject', { id, phone: PH, chat: G, isGroup: true, groupName: 'حساب اليوم', image_b64: 'CCCC' });
    const o = await sent(n0, x => x.to === '966500000930');
    assert.ok(o.length, 'نوح وصله الكرت');
    assert.match(o[0].text, /سحب من الراتب:\n\d- صادق ورقة 200/); assert.match(o[0].text, /مكافآت:\n\d- صادق ورقة 15/); assert.match(o[0].text, /رد \*تمام\*/);
    assert.match(o[0].text, /تحويل 30/); assert.match(o[0].text, /4- ❓ مين؟ 25/); assert.match(o[0].text, /تعدّل: «3 = 120»/);
    assert.strictEqual((await sheetExp()).length, id === 'p3' ? 0 : 4, 'قبل «تمام» ما ينسجل شي');
    if (id === 'p3') { // ✏️ نوح يعدّل بالأرقام قبل «تمام»
      const ed = async (t, re) => { const m0 = (await call('GET', '/api/whatsapp/_outbox')).length; await call('POST', '/api/whatsapp/_inject', { id: 'ed' + t, phone: '966500000930', text: t }); const x = await sent(m0, y => y.to === '966500000930'); assert.match(x[0].text, re, t); return x[0].text; };
      await ed('٢ = ١٥٠', /✓ 2 صار 150/);
      await ed('احذف 1', /✓ انشال 1/);
      await ed('زيد غاز 50', /✓ انضاف 5- غاز 50/);
      const last = await ed('4 سحب صادق ورقة', /✓ 4 صار سحب من الراتب — صادق ورقة/);
      assert.match(last, /2- صادق ورقة 150/); assert.doesNotMatch(last, /1- غاز 40/); assert.match(last, /5- غاز 50/);
      await ed('9 = 10', /⚠️ ما فيه سطر 9/);
      await call('POST', '/api/whatsapp/_inject', { id: 'wrong1', phone: '966500000930', text: 'فيه غلط بسيط' }); // كلمة «غلط» ما تمسح كرت الورقة
      await new Promise(r => setTimeout(r, 300));
    }
    await call('POST', '/api/whatsapp/_inject', { id: id + 'ok', phone: '966500000930', text: 'تمام' });
    await sent(n0, x => x.to === '966500000930' && /✓ اتسجل/.test(x.text || ''));
    assert.strictEqual((await sheetExp()).length, id === 'p3' ? 4 : 3, 'تنسجل بالتعديلات، ومرة وحدة');
    if (id === 'p3') { const e = await sheetExp(); assert.ok(e.some(x => x.amount === 150) && e.some(x => x.amount === 50 && /غاز/.test(x.note)) && !e.some(x => x.amount === 40)); }
  }
  const rep = await call('GET', '/api/report?date=' + today);
  assert.strictEqual(rep.money.sheet.transfer, 30); assert.strictEqual(rep.money.sheet.total, 450);
  const pr = (await call('GET', '/api/payroll')).find(x => x.id === wk);
  assert.strictEqual(pr.entries.filter(e => e.type === 'advance' && e.amount === 200).length, 1);
  // تعديل مكتوب => المجموع يتحدث، والسطر كرت لنوح
  const n1 = (await call('GET', '/api/whatsapp/_outbox')).length;
  await call('POST', '/api/whatsapp/_inject', { id: 'e1', phone: PH, chat: G, isGroup: true, groupName: 'حساب اليوم', text: 'تعديل بالخرج لحوح ٦٢ اجمالي ٥١٢' });
  const g = await sent(n1, x => x.to === G);
  assert.match(g[0].text, /تعديل كاشير ورقة: خرج \+62/);
  const m2 = (await call('GET', '/api/report?date=' + today)).money.sheet;
  assert.strictEqual(m2.spent, 342); assert.strictEqual(m2.total, 512);
  await call('POST', '/api/whatsapp/_inject', { id: 'e1ok', phone: '966500000930', text: 'تمام' });
  await sent(n1, x => x.to === '966500000930' && /✓ اتسجل: تعديل ورقة/.test(x.text || ''));
  assert.ok((await sheetExp()).some(e => /لحوح 62/.test(e.note)));
  // نوح يلغي السحب من الخاص
  await call('POST', '/api/whatsapp/_inject', { id: 'c1', phone: '966500000930', text: 'الغي سحب صادق ورقة' });
  const c = await sent(n1, x => x.to === '966500000930' && /انلغى سحب/.test(x.text || ''));
  assert.ok(c.length);
  assert.ok(!(await call('GET', '/api/payroll')).find(x => x.id === wk).entries.some(e => e.type === 'advance'));
  // أرقام ما تركب => تنعاد القراءة مرة، وبعدها تحذير في القروب وفي الكرت
  const n2 = (await call('GET', '/api/whatsapp/_outbox')).length;
  await call('POST', '/api/whatsapp/_inject', { id: 'p5', phone: PH, chat: G, isGroup: true, groupName: 'حساب اليوم', image_b64: 'DDDD' });
  const w = await sent(n2, x => x.to === G);
  assert.match(w[0].text, /أرقام الورقة ما تركب/);
  const ow = await sent(n2, x => x.to === '966500000930');
  assert.match(ow[0].text, /الأرقام ما تركب/);
});

test('a supervisor or buyer name + amount = custody; «لحوح خلوف 50» = goods into stock; «سحبية» = salary — each lands in its place after «تمام», once', async () => {
  const { id: boss } = await call('POST', '/api/users', { name: 'إبراهيم ورقة', role: 'supervisor', pin: '9595' });
  const { id: kh } = await call('POST', '/api/users', { name: 'خلوف ورقة', role: 'supervisor', pin: '9696' });
  const { id: lh } = await call('POST', '/api/items', { name: 'لحوح ورقة', unit: 'حبة', kind: 'raw', daily: 1 });
  const L = (o) => ({ date: null, item_id: null, qty: null, unit: '', category: '', supplier_id: null, supplier_name: '', employee: '', uncertain: false, ...o });
  const mix = sheet({ card: 100, cash: 50, transfer: 0, spent: 420, total: 570, lines: [
    L({ text: 'إبراهيم ورقة فيل 270', kind: 'salary', amount: 270, employee: 'إبراهيم ورقة' }), // النموذج غلط => الكود يخليها عهدة
    L({ text: 'لحوح خلوف ورقة 50', kind: 'purchase', amount: 50, item_id: lh }),
    L({ text: 'سحبية خلوف ورقة 100', kind: 'salary', amount: 100, employee: 'خلوف ورقة' }),
  ] });
  const runs = JSON.parse(fs.readFileSync(FX, 'utf8'));
  fs.writeFileSync(FX, JSON.stringify([...runs, mix, mix]));
  const sent = async (n0, f) => { for (let i = 0; i < 80; i++) { const x = (await call('GET', '/api/whatsapp/_outbox')).slice(n0).filter(f); if (x.length) return x; await new Promise(r => setTimeout(r, 50)); } return []; };
  for (const id of ['m1', 'm2']) {
    const n0 = (await call('GET', '/api/whatsapp/_outbox')).length;
    await call('POST', '/api/whatsapp/_inject', { id, phone: PH, chat: G, isGroup: true, groupName: 'حساب اليوم', image_b64: 'EEEE' });
    const o = await sent(n0, x => x.to === '966500000930');
    assert.match(o[0].text, /👛 عهدة:\n1- إبراهيم ورقة 270/); assert.match(o[0].text, /🛒 بضاعة \(تدخل المخزون\):\n2- لحوح ورقة ≈1 حبة 50/); assert.match(o[0].text, /سحب من الراتب:\n3- خلوف ورقة 100/);
    await call('POST', '/api/whatsapp/_inject', { id: id + 'ok', phone: '966500000930', text: 'تمام' });
    await sent(n0, x => x.to === '966500000930' && /✓ اتسجل/.test(x.text || ''));
  }
  const rep = await call('GET', '/api/report?date=' + today);
  assert.strictEqual(rep.purchases.filter(p => /\[ورقة /.test(p.note) && p.total === 50).length, 1, 'البضاعة مرة وحدة');
  assert.strictEqual(rep.money.custody_cash, 270, 'العهدة من الدرج مرة وحدة');
  const pr = (await call('GET', '/api/payroll')).find(x => x.id === kh);
  assert.strictEqual(pr.entries.filter(e => e.type === 'advance' && e.amount === 100).length, 1);
  assert.ok(!(await call('GET', '/api/payroll')).find(x => x.id === boss).entries.some(e => e.type === 'advance'), 'إبراهيم: عهدة مو سحب');
});
