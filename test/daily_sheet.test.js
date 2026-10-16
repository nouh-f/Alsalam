'use strict';
// 📊 ورقة الحساب في جروب «حساب اليوم»: تنقرا وتنحفظ، والتقرير (الطابعة − اللي باسم ⇔ الورقة) ينزل في نفس الجروب
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

let srv, B, T, DIR, today;
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const G = 'daily1@g.us', PH = '966500000931';
const sheet = o => ({ stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify({ date: null, lines: [], ...o }) }] });

test.before(async () => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-dsheet-'));
  const FX = path.join(DIR, 'ai.json');
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
