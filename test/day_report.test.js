'use strict';
// 📄 تقرير اليوم PDF: بعد ورقة الحساب في جروب «حساب اليوم» ينرسل الملف في نفس الجروب — وينحمّل من الموقع
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', process.env.CHROME_PATH].find(p => p && fs.existsSync(p));
let srv, B, T, DIR, today;
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const G = 'daily2@g.us', PH = '966500000941';
const sheet = o => ({ stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify({ date: null, lines: [], ...o }) }] });

test.before(async () => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-dayrep-'));
  const FX = path.join(DIR, 'ai.json');
  fs.writeFileSync(FX, JSON.stringify([sheet({ card: 100, cash: 40, spent: 5, total: 145 })]));
  const port = 47900 + Math.floor(Math.random() * 90); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: DIR, AI_FIXTURE: FX, WA_TEST_INJECT: '1', CHROME_PATH: CHROME || '/nonexistent' }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  today = (await call('GET', '/api/me')).today;
  await call('POST', '/api/settings', { anthropic_key: 'sk-test' });
  await call('POST', '/api/whatsapp/groups', { groups: [{ id: G, role: 'daily' }] });
});
test.after(() => srv.kill());

test('day report HTML has the money, named tickets and every counted item with its shortage', { skip: !CHROME && 'ما فيه متصفح' }, async () => {
  const { id: w } = await call('POST', '/api/users', { name: 'عامل تقرير', role: 'worker', pin: '4242' });
  const { id: it } = await call('POST', '/api/items', { name: 'صنف تقرير', unit: 'حبة', daily: 1, kind: 'raw', cost: 10 });
  await call('POST', '/api/responsibility', { item_id: it, user_id: w, opener_id: w });
  await call('POST', '/api/count', { date: today, item_id: it, phase: 'opening', qty: 10 });
  await call('POST', '/api/count', { date: today, item_id: it, phase: 'closing', qty: 7 });
  const db = new DatabaseSync(path.join(DIR, 'alsalam.db'));
  const pid = Number(db.prepare("INSERT INTO products(loyverse_item_id, loyverse_variant_id, name, variant, category, price, sku, active) VALUES('x','v9','مرسة تقرير','','',10,'',1)").run().lastInsertRowid);
  db.prepare("INSERT INTO printer_jobs(id, at, raw_file) VALUES(501, ?, '')").run(today + ' 10:00:01');
  db.prepare("INSERT INTO printer_orders(job_id, date, kind, ticket_no, ticket_name, employee, items) VALUES(501,?,'order','06-001','عمار','المالك',?)").run(today, JSON.stringify([{ name: 'مرسة تقرير', product_id: pid, qty: 3 }]));
  db.close();
  const n0 = (await call('GET', '/api/whatsapp/_outbox')).length;
  await call('POST', '/api/users', { name: 'كاشير تقرير', role: 'supervisor', pin: '9494', phone: '0500000941' });
  await call('POST', '/api/whatsapp/_inject', { id: 'd1', phone: PH, chat: G, isGroup: true, groupName: 'حساب اليوم', image_b64: 'BBBB' });
  let ob = [];
  for (let i = 0; i < 300 && !ob.some(x => x.document); i++) { ob = (await call('GET', '/api/whatsapp/_outbox')).slice(n0).filter(x => x.to === G); await new Promise(r => setTimeout(r, 100)); }
  assert.ok(ob.some(x => /حساب اليوم/.test(x.text)), 'الرسالة القصيرة أول');
  const doc = ob.find(x => x.document);
  assert.ok(doc, JSON.stringify(ob)); assert.strictEqual(doc.head, '%PDF-'); assert.match(doc.fileName, new RegExp(`تقرير السلام ${today}\\.pdf`));
  const r = await fetch(B + '/api/day-report.pdf?date=' + today, { headers: { authorization: 'Bearer ' + T } });
  assert.strictEqual(r.status, 200); assert.strictEqual((await r.arrayBuffer()).byteLength > 5000, true);
  // نفس الصفحة (HTML) قبل الطباعة
  process.env.DATA_DIR = DIR;
  const DR = require('../server/day_report');
  const h = DR.html(DR.data(today));
  assert.match(h, /صنف تقرير/); assert.match(h, /عمار/); assert.match(h, /المفروض يوصل/); assert.match(h, /الجرد — كل صنف/);
});
