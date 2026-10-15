'use strict';
// 📲 الجرد من الرابط: البوت ما يسجل جرد العامل (يرد بالرابط)، والتذكير فيه الرابط
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

let srv, B, T, today;
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const U = { input_tokens: 1, output_tokens: 1 };
const PH = '966500000811';

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-link-'));
  const FX = path.join(dir, 'ai.json');
  fs.writeFileSync(FX, JSON.stringify([
    { stop_reason: 'tool_use', usage: U, content: [{ type: 'tool_use', id: 't1', name: 'propose_count', input: { phase: 'closing', day: null, entries: [{ item: 'حريد رابط', qty: 6.34, unit: null, parts: null }] } }] },
    { stop_reason: 'end_turn', usage: U, content: [{ type: 'text', text: 'الجرد صار من الرابط 👇 https://x.test/#/count' }] },
  ]));
  const port = 44800 + Math.floor(Math.random() * 150); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir, AI_FIXTURE: FX, WA_TEST_INJECT: '1' }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  today = (await call('GET', '/api/me')).today;
  await call('POST', '/api/settings', { anthropic_key: 'sk-test', site_url: 'https://x.test/' });
});
test.after(() => srv.kill());

test('a worker\'s count on WhatsApp is not saved — the reply points to the link; reminders carry the link', async () => {
  const { id: w } = await call('POST', '/api/users', { name: 'جارد رابط', role: 'worker', pin: '8181', phone: '0500000811' });
  const { id: it } = await call('POST', '/api/items', { name: 'حريد رابط', unit: 'كجم', daily: 1, kind: 'raw' });
  await call('POST', '/api/responsibility', { item_id: it, user_id: w, opener_id: '' });
  await call('POST', '/api/count', { date: today, item_id: it, phase: 'opening', qty: 9 });
  await call('POST', '/api/whatsapp/_inject', { id: 'l1', phone: PH, chat: PH, text: 'حريد 6.34 آخر الدوام' });
  let ob = [];
  for (let i = 0; i < 60 && !ob.length; i++) { ob = (await call('GET', '/api/whatsapp/_outbox')).filter(x => x.to === PH); if (!ob.length) await new Promise(r => setTimeout(r, 50)); }
  assert.match(ob[0].text, /\/#\/count/); assert.doesNotMatch(ob[0].text, /رد \*تمام\*/, 'ما فيه كرت جرد');
  assert.strictEqual((await call('GET', '/api/board?date=' + today)).rows.find(r => r.item_id === it).closing, null);
  const n = (await call('GET', '/api/whatsapp/_outbox')).length;
  await call('POST', '/api/whatsapp/chase', { at: today + 'T21:30:00Z' });
  const rem = (await call('GET', '/api/whatsapp/_outbox')).slice(n).find(x => x.to === PH);
  assert.ok(rem && /📲 https:\/\/x\.test\/#\/count/.test(rem.text), JSON.stringify(rem));
});
