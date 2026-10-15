'use strict';
// 🔒 الوصفة السرّية: المساعد يعطيها للمسؤول عن الصنف والمالك بس — والقديم: الملصق والإيموجي ما لها رد، الكرت يقعد ينتظر «تمام» حتى لو المساعد سأل سؤال ثاني،
// وحد الأسئلة رسالة وحدة بس (ونوح يدري)
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const sent = [];
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && /\/PHONE1\/messages$/.test(req.url)) { sent.push(JSON.parse(b)); return res.end('{"messages":[{"id":"out"}]}'); }
    res.statusCode = 404; res.end('{}');
  });
});
let srv, B, T, today;
const SECRET = 'calm-secret';
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
let mid = 0;
const hook = (from, text) => {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ from, id: 'wamid.c' + (++mid), type: 'text', text: { body: text } }] } }] }] });
  return fetch(B + '/api/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex') }, body: raw });
};
const waitSent = async n => { for (let i = 0; i < 100 && sent.length < n; i++) await new Promise(r => setTimeout(r, 50)); assert.ok(sent.length >= n, `انتظرت ${n} رسالة، وصل ${sent.length}`); return sent[n - 1]; };
const quiet = async () => new Promise(r => setTimeout(r, 400));
const tool = (name, input) => ({ stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 't' + name, name, input }] });
const say = text => ({ stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text }] });
const W = '966500000401', W2 = '966500000402';
let LOG;

test.before(async () => {
  await new Promise(r => mock.listen(0, r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-secret-'));
  const FX = path.join(dir, 'ai.json'); LOG = path.join(dir, 'ai.log');
  fs.writeFileSync(FX, JSON.stringify([
    tool('item_info', { name: 'رز ت' }), say('تمام'),
    tool('item_info', { name: 'رز ت' }), say('تمام'),
  ]));
  const port = 42500 + Math.floor(Math.random() * 400); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir, AI_FIXTURE: FX, AI_FIXTURE_LOG: LOG, WA_API_BASE: `http://127.0.0.1:${mock.address().port}`, WA_TEST_INJECT: '1' }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  today = (await call('GET', '/api/me')).today;
  await call('POST', '/api/settings', { anthropic_key: 'sk-test', wa_token: 'TOK', wa_phone_id: 'PHONE1', wa_app_secret: SECRET, wa_verify_token: 'v' });
});
test.after(() => { srv.kill(); mock.close(); });

test('the secret recipe reaches the item\'s responsible worker only', async () => {
  const { id: cook } = await call('POST', '/api/users', { name: 'طباخ الرز ت', role: 'worker', pin: '8181', phone: '0500000401' });
  await call('POST', '/api/users', { name: 'غريب ت', role: 'worker', pin: '8282', phone: '0500000402' });
  const { id: it } = await call('POST', '/api/items', { name: 'رز ت', unit: 'كجم', daily: 1, kind: 'prepared' });
  await call('POST', '/api/responsibility', { item_id: it, user_id: cook, opener_id: '' });
  await call('PUT', `/api/items/${it}/secret-recipe`, { text: 'هيل ٣ جرام — سر' });
  const logs = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
  await hook(W, 'كم هيل في الرز؟'); await waitSent(1);
  assert.match(logs(), /هيل ٣ جرام — سر/, 'المسؤول يوصله');
  const before = logs().length;
  await hook(W2, 'كم هيل في الرز؟'); await waitSent(2);
  assert.doesNotMatch(logs().slice(before), /هيل ٣ جرام — سر/, 'الغريب ما يوصله');
  // العامل ما يقدر يحفظ وصفة
  const wt = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: cook, pin: '8181' }) })).json()).token;
  const r = await fetch(B + `/api/items/${it}/secret-recipe`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + wt }, body: '{"text":"x"}' });
  assert.strictEqual(r.status, 403);
});
