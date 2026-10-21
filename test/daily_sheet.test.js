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

test('sheet lines are saved: drawer expenses, salary withdrawals on payroll, bonuses, transfer — once even if re-sent; a written «تعديل» adds lines; Nouh gets a summary', async () => {
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
  const edit = { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify({ total: 512, lines: [{ text: 'لحوح 62', kind: 'expense', amount: 62, employee: '' }] }) }] };
  const runs = JSON.parse(fs.readFileSync(FX, 'utf8'));
  fs.writeFileSync(FX, JSON.stringify([...runs.slice(0, 2), full, full, edit]));
  const sent = async (n0, f) => { for (let i = 0; i < 80; i++) { const x = (await call('GET', '/api/whatsapp/_outbox')).slice(n0).filter(f); if (x.length) return x; await new Promise(r => setTimeout(r, 50)); } return []; };
  for (const id of ['p3', 'p4']) { // نفس الورقة مرتين => ما يتكرر شي
    const n0 = (await call('GET', '/api/whatsapp/_outbox')).length;
    await call('POST', '/api/whatsapp/_inject', { id, phone: PH, chat: G, isGroup: true, groupName: 'حساب اليوم', image_b64: 'CCCC' });
    const o = await sent(n0, x => x.to === '966500000930');
    assert.ok(o.length, 'نوح وصله الملخص');
    assert.match(o[0].text, /سحب من الراتب: صادق ورقة 200/); assert.match(o[0].text, /مكافآت: صادق ورقة 15/); assert.match(o[0].text, /مصاريف: غاز 40 40/);
    assert.match(o[0].text, /تحويل 30/); assert.match(o[0].text, /ما عرفت أسجله: «خالد 25 سحبية»/);
  }
  const rep = await call('GET', '/api/report?date=' + today);
  const exp = rep.expenses.filter(e => /\[ورقة /.test(e.note));
  assert.strictEqual(exp.length, 3, JSON.stringify(exp));
  assert.strictEqual(rep.money.sheet.transfer, 30); assert.strictEqual(rep.money.sheet.total, 450);
  const pr = (await call('GET', '/api/payroll')).find(x => x.id === wk);
  assert.strictEqual(pr.entries.filter(e => e.type === 'advance' && e.amount === 200).length, 1);
  // تعديل مكتوب => يزيد السطر ويتحدّث المجموع
  const n1 = (await call('GET', '/api/whatsapp/_outbox')).length;
  await call('POST', '/api/whatsapp/_inject', { id: 'e1', phone: PH, chat: G, isGroup: true, groupName: 'حساب اليوم', text: 'تعديل بالخرج لحوح ٦٢ اجمالي ٥١٢' });
  const g = await sent(n1, x => x.to === G);
  assert.match(g[0].text, /تعديل كاشير ورقة: خرج \+62/);
  const m2 = (await call('GET', '/api/report?date=' + today)).money.sheet;
  assert.strictEqual(m2.spent, 342); assert.strictEqual(m2.total, 512);
  // نوح يلغي السحب من الخاص
  await call('POST', '/api/whatsapp/_inject', { id: 'c1', phone: '966500000930', text: 'الغي سحب صادق ورقة' });
  const c = await sent(n1, x => x.to === '966500000930' && /انلغى سحب/.test(x.text || ''));
  assert.ok(c.length);
  assert.ok(!(await call('GET', '/api/payroll')).find(x => x.id === wk).entries.some(e => e.type === 'advance'));
});
