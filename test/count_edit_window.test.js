'use strict';
// ✏️ العامل يقدر يصلّح رقمه لين يخلص وقت الجرد (حتى بعد ربع ساعة) — كل تعديل ينسجل لنوح، ويوم ثاني ينقفل (والمالك يعدّل دايم)
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

test.before(async () => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-editwin-'));
  const port = 46800 + Math.floor(Math.random() * 300); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: DIR }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = await login(1, '1234');
  today = (await req(T, 'GET', '/api/me')).today;
});
test.after(() => srv.kill());

test('a worker can fix their own count while the count is open (edits are logged); another day is locked; the owner can always edit', async () => {
  const { id: w } = await req(T, 'POST', '/api/users', { name: 'مصلّح', role: 'worker', pin: '5151' });
  const { id: it } = await req(T, 'POST', '/api/items', { name: 'صنف تصحيح', unit: 'حبة', daily: 1, kind: 'raw' });
  await req(T, 'POST', '/api/responsibility', { item_id: it, user_id: w, opener_id: w });
  const WT = await login(w, '5151');
  await req(WT, 'POST', '/api/count', { date: today, item_id: it, phase: 'closing', qty: 50 });
  await req(WT, 'POST', '/api/count', { date: today, item_id: it, phase: 'closing', qty: 5 }); // صلّحها على طول
  let r = (await req(T, 'GET', '/api/board?date=' + today)).rows.find(x => x.item_id === it);
  assert.strictEqual(r.closing, 5); assert.strictEqual(r.closing_by_id, w);
  const db = new DatabaseSync(path.join(DIR, 'alsalam.db'));
  db.prepare('UPDATE counts SET closing_at = ? WHERE date = ? AND item_id = ?').run(new Date(Date.now() - 11 * 60e3).toISOString(), today, it);
  db.close();
  await req(WT, 'POST', '/api/count', { date: today, item_id: it, phase: 'closing', qty: 6 }); // بعد ١١ دقيقة: لسه وقت الجرد
  const edits = (await req(T, 'GET', '/api/app-log')).edits.filter(e => e.item === 'صنف تصحيح').map(e => [e.old, e.new]);
  assert.deepStrictEqual(edits.reverse(), [[50, 5], [5, 6]]);
  const yday = (() => { const x = new Date(today + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); })();
  await req(T, 'POST', '/api/count', { date: yday, item_id: it, phase: 'closing', qty: 3 });
  await assert.rejects(req(WT, 'POST', '/api/count', { date: yday, item_id: it, phase: 'closing', qty: 2 }), e => e.status === 403);
  await req(T, 'POST', '/api/count', { date: today, item_id: it, phase: 'closing', qty: 7 });
  r = (await req(T, 'GET', '/api/board?date=' + today)).rows.find(x => x.item_id === it);
  assert.strictEqual(r.closing, 7);
});
