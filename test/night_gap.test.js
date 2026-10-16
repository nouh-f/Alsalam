'use strict';
// 🌙 الصبح أقل من (باقي أمس − اللي انباع في الطابعة بعد جرد آخر الدوام) => ملاحظة للعامل + واتساب لنوح
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

let srv, B, T, DIR, today;
const req = async (tok, method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const login = async (id, pin) => (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: id, pin }) })).json()).token;
const OWN = '966500000970';

test.before(async () => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-ngap-'));
  const port = 47700 + Math.floor(Math.random() * 300); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: DIR, WA_TEST_INJECT: '1', NIGHT_GAP_DELAY_MS: '300' }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = await login(1, '1234');
  today = (await req(T, 'GET', '/api/me')).today;
  const me = (await req(T, 'GET', '/api/users')).find(x => x.id === 1);
  await req(T, 'POST', '/api/users', { id: 1, name: me.name, role: 'owner', pin: '1234', phone: '0500000970' });
});
test.after(() => srv.kill());

test('3 left last night, 1 sold on the printer after the count, 1 in the morning => 1 missing: note + owner alert; matching count => nothing', async () => {
  const { id: w } = await req(T, 'POST', '/api/users', { name: 'عامل ليل', role: 'worker', pin: '8181' });
  const { id: box } = await req(T, 'POST', '/api/items', { name: 'علبة ليل', unit: 'حبة', daily: 1, kind: 'raw', carry_over: 1 });
  const { id: ok } = await req(T, 'POST', '/api/items', { name: 'علبة مضبوطة', unit: 'حبة', daily: 1, kind: 'raw', carry_over: 1 });
  for (const x of [box, ok]) await req(T, 'POST', '/api/responsibility', { item_id: x, user_id: w, opener_id: w });
  const yday = new Date(Date.parse(today + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
  for (const x of [box, ok]) await req(T, 'POST', '/api/count', { date: yday, item_id: x, phase: 'closing', qty: 3 });
  const db = new DatabaseSync(path.join(DIR, 'alsalam.db'));
  db.prepare('UPDATE counts SET closing_at = ? WHERE date = ?').run(new Date(Date.now() - 2 * 3600e3).toISOString(), yday);
  const pid = Number(db.prepare("INSERT INTO products(name) VALUES('علبة ليل بيع')").run().lastInsertRowid);
  db.prepare('INSERT INTO recipe_lines(product_id, item_id, qty) VALUES(?,?,1)').run(pid, box);
  db.prepare("INSERT INTO printer_jobs(id, at, raw_file) VALUES(9001, ?, '')").run(new Date(Date.now() - 3600e3).toISOString().replace('T', ' ').slice(0, 19));
  db.prepare("INSERT INTO printer_orders(job_id, date, kind, ticket_no, items) VALUES(9001, ?, 'order', '01-1', ?)").run(today, JSON.stringify([{ name: 'علبة ليل بيع', product_id: pid, qty: 1 }]));
  db.close();
  const WT = await login(w, '8181');
  const n0 = (await req(T, 'GET', '/api/whatsapp/_outbox')).length;
  const r = await req(WT, 'POST', '/api/count', { date: today, item_id: box, phase: 'opening', qty: 1 });
  assert.match(r.note || '', /انباع بعد الجرد 1/); assert.match(r.note, /المفروض 2/); assert.match(r.note, /ناقص 1/);
  const r2 = await req(WT, 'POST', '/api/count', { date: today, item_id: ok, phase: 'opening', qty: 3 });
  assert.strictEqual(r2.note, undefined);
  let ob = [];
  for (let i = 0; i < 40; i++) { ob = (await req(T, 'GET', '/api/whatsapp/_outbox')).slice(n0); if (ob.some(x => x.to === OWN)) break; await new Promise(res => setTimeout(res, 50)); }
  const al = ob.filter(x => x.to === OWN && /نقص بالليل/.test(x.text));
  assert.strictEqual(al.length, 1, JSON.stringify(ob)); assert.match(al[0].text, /علبة ليل/); assert.match(al[0].text, /ناقص \*1 حبة\*/);
});
