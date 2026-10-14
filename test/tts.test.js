'use strict';
// 🔊 رسالة للعمال بالصوت: يتولّد الصوت مرة وحدة، ويوصل صوت وبعده نفس الكلام كتابة. بدون مفتاح => كتابة بس
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

let srv, B, T, got = null;
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    if (req.url === '/audio/speech') { got = JSON.parse(b); res.setHeader('content-type', 'audio/ogg'); return res.end(Buffer.alloc(321, 7)); }
    res.statusCode = 404; res.end('{}');
  });
});
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const WK = '966500000601';

test.before(async () => {
  await new Promise(r => mock.listen(0, r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-tts-'));
  const FX = path.join(dir, 'ai.json');
  fs.writeFileSync(FX, JSON.stringify([{ stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'هلا محمد، صوّر الميزان' }] },
    { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'هلا' }] }]));
  const port = 47000 + Math.floor(Math.random() * 900); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir, WA_TEST_INJECT: '1', AI_FIXTURE: FX, STT_API_BASE: `http://127.0.0.1:${mock.address().port}` }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
});
test.after(() => { srv.kill(); mock.close(); });

test('a message to one worker goes as a voice note, then the same text', async () => {
  const { id } = await call('POST', '/api/users', { name: 'محمد صوت', role: 'worker', pin: '6161', phone: '0500000601' });
  // بدون مفتاح: كتابة بس، ويقول ليش
  let r = await call('POST', '/api/whatsapp/broadcast', { text: 'تجربة', user_ids: [id], voice: true });
  assert.strictEqual(r.voice, false); assert.match(r.voice_error, /مو مفعّل/);
  await call('POST', '/api/settings', { stt_key: 'sk-test' });
  const before = (await call('GET', '/api/whatsapp/_outbox')).length;
  r = await call('POST', '/api/whatsapp/broadcast', { text: 'السلام عليكم يا *محمد* 🌹 وزّن السمك', user_ids: [id], voice: true });
  assert.strictEqual(r.voice, true);
  let ob = [];
  for (let i = 0; i < 40 && ob.length < 2; i++) { ob = (await call('GET', '/api/whatsapp/_outbox')).slice(before).filter(x => x.to === WK); await new Promise(r => setTimeout(r, 50)); }
  assert.strictEqual(ob[0].audio, 321, 'الصوت أول');
  assert.match(ob[1].text, /وزّن السمك/);
  assert.strictEqual(got.input, 'السلام عليكم يا محمد وزّن السمك', 'بدون إيموجي ونجوم');
  assert.strictEqual(got.response_format, 'opus');
});

test('🔊 a worker who cannot read gets the assistant reply as voice too; others get text only', async () => {
  await call('POST', '/api/settings', { anthropic_key: 'sk-test' });
  const id = (await call('GET', '/api/users')).find(x => x.name === 'محمد صوت').id;
  await call('POST', `/api/users/${id}/voice`, { on: true });
  let before = (await call('GET', '/api/whatsapp/_outbox')).length;
  await call('POST', '/api/whatsapp/_inject', { id: 'v1', phone: WK, chat: WK, text: 'السلام' });
  let ob = [];
  for (let i = 0; i < 80 && !ob.some(x => x.text); i++) { ob = (await call('GET', '/api/whatsapp/_outbox')).slice(before).filter(x => x.to === WK); await new Promise(r => setTimeout(r, 50)); }
  assert.ok(ob[0].audio > 0, 'صوت أول'); assert.match(ob[1].text, /صوّر الميزان/);
  assert.match(got.input, /صوّر الميزان/);
  await call('POST', `/api/users/${id}/voice`, { on: false });
  before = (await call('GET', '/api/whatsapp/_outbox')).length;
  await call('POST', '/api/whatsapp/_inject', { id: 'v2', phone: WK, chat: WK, text: 'هلا' });
  ob = [];
  for (let i = 0; i < 80 && !ob.some(x => x.text); i++) { ob = (await call('GET', '/api/whatsapp/_outbox')).slice(before).filter(x => x.to === WK); await new Promise(r => setTimeout(r, 50)); }
  ob = (await call('GET', '/api/whatsapp/_outbox')).slice(before).filter(x => x.to === WK);
  assert.ok(ob.length && ob.every(x => !x.audio), 'كتابة بس');
});
