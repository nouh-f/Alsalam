'use strict';
// 📄 تقرير الأسبوع/الشهر/الربع/السنة: نفس شكل تقرير اليوم — ينحمّل من الموقع، والسبت الظهر ينرسل الأسبوعي في جروب «حساب اليوم» مرة وحدة
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', process.env.CHROME_PATH].find(p => p && fs.existsSync(p));
let srv, B, T, DIR, today;
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const G = 'daily3@g.us';

test.before(async () => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-period-'));
  const port = 48000 + Math.floor(Math.random() * 90); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: DIR, WA_TEST_INJECT: '1', CHROME_PATH: CHROME || '/nonexistent' }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  today = (await call('GET', '/api/me')).today;
  await call('POST', '/api/whatsapp/groups', { groups: [{ id: G, role: 'daily' }] });
});
test.after(() => srv.kill());

test('a period with shortage on 3 days: HTML shows totals, the item marked, PDF downloads, Saturday noon sends the weekly once', { skip: !CHROME && 'ما فيه متصفح' }, async () => {
  const { id: it } = await call('POST', '/api/items', { name: 'صنف أسبوع', unit: 'حبة', daily: 1, kind: 'raw', cost: 10 });
  const days = [3, 2, 1].map(n => new Date(Date.parse(today + 'T00:00:00Z') - n * 864e5).toISOString().slice(0, 10));
  for (const d of days) { await call('POST', '/api/count', { date: d, item_id: it, phase: 'opening', qty: 10 }); await call('POST', '/api/count', { date: d, item_id: it, phase: 'closing', qty: 8 }); }
  await call('POST', '/api/expenses', { date: days[0], amount: 75, category: 'غاز', note: 'اسطوانة' }).catch(() => {});
  process.env.DATA_DIR = DIR;
  const PRD = require('../server/period_report');
  const h = PRD.html(PRD.data(days[0], days[2]), 'week');
  assert.match(h, /تقرير الأسبوع/); assert.match(h, /صنف أسبوع/); assert.match(h, /<tr class="neg"><td>صنف أسبوع<\/td><td class="n">3<\/td>/);
  const r = await fetch(`${B}/api/period-report.pdf?from=${days[0]}&to=${days[2]}&kind=week`, { headers: { authorization: 'Bearer ' + T } });
  assert.strictEqual(r.status, 200); assert.strictEqual(Buffer.from(await r.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.deepStrictEqual(PRD.due('2026-10-17').map(x => [x.kind, x.from, x.to]), [['week', '2026-10-10', '2026-10-16']]);
  assert.deepStrictEqual(PRD.due('2027-01-01').map(x => x.kind), ['month', 'quarter', 'year']);
  const n0 = (await call('GET', '/api/whatsapp/_outbox')).length;
  const s1 = await call('POST', '/api/period-report/send', { now: '2026-10-17T10:00:00Z' });
  assert.deepStrictEqual(s1.sent, ['week']);
  const ob = (await call('GET', '/api/whatsapp/_outbox')).slice(n0).filter(x => x.to === G && x.document);
  assert.strictEqual(ob.length, 1); assert.strictEqual(ob[0].head, '%PDF-'); assert.match(ob[0].fileName, /تقرير الأسبوع 2026-10-10 - 2026-10-16\.pdf/);
  assert.deepStrictEqual((await call('POST', '/api/period-report/send', { now: '2026-10-17T11:00:00Z' })).sent, [], 'مرة وحدة');
});
