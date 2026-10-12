'use strict';
// 📱 الواتساب: العامل يرسل الجرد => الملخص => «تمام» => ينسجل باسمه
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
    if (req.method === 'POST' && /\/PHONE1\/messages$/.test(req.url)) { sent.push({ auth: req.headers.authorization, ...JSON.parse(b) }); return res.end('{"messages":[{"id":"out"}]}'); }
    res.statusCode = 404; res.end('{}');
  });
});
let srv, B, T, today, FX;
const SECRET = 'app-secret-test';
const call = async (method, p, body, tok = T) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
let mid = 0;
const hook = async (from, text, { secret = SECRET, id } = {}) => {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ from, id: id || 'wamid.' + (++mid), type: 'text', text: { body: text } }] } }] }] });
  return fetch(B + '/api/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex') }, body: raw });
};
const waitSent = async n => { for (let i = 0; i < 100 && sent.length < n; i++) await new Promise(r => setTimeout(r, 50)); assert.ok(sent.length >= n, `انتظرت ${n} رسالة، وصل ${sent.length}`); return sent[n - 1]; };
const tool = (name, input) => ({ stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 't' + name, name, input }] });
const say = text => ({ stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text }] });

test.before(async () => {
  await new Promise(r => mock.listen(0, r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-wa-'));
  FX = path.join(dir, 'ai.json');
  fs.writeFileSync(FX, JSON.stringify([
    tool('propose_count', { phase: 'closing', entries: [{ item: 'فول واتس', qty: 3 }, { item: 'شي غريب', qty: 1 }] }), say('جهزت لك جرد آخر الدوام — اضغط «تأكيد».'),
    tool('propose_purchase', { supplier: null, payment: 'cash', lines: [{ item: 'فول واتس', qty: 1, total: 10 }] }), say('ما تقدر تسجل مشتريات.'),
  ]));
  const port = 39500 + Math.floor(Math.random() * 400); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: port, DATA_DIR: dir, AI_FIXTURE: FX, WA_API_BASE: `http://127.0.0.1:${mock.address().port}` }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  today = (await call('GET', '/api/me')).today;
  await call('POST', '/api/settings', { anthropic_key: 'sk-test', wa_token: 'TOK', wa_phone_id: 'PHONE1', wa_app_secret: SECRET, wa_verify_token: 'verify-me' });
});
test.after(() => { srv.kill(); mock.close(); });

test('meta webhook verification', async () => {
  const ok = await fetch(B + '/api/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345');
  assert.strictEqual(ok.status, 200); assert.strictEqual(await ok.text(), '12345');
  assert.strictEqual((await fetch(B + '/api/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1')).status, 403);
  assert.strictEqual((await hook('966500000001', 'هلا', { secret: 'wrong' })).status, 401, 'توقيع غلط');
});

test('worker sends the closing count on WhatsApp, confirms with «تمام», and it is saved under their name', async () => {
  // رقم مو مسجل
  assert.strictEqual((await hook('966500000009', 'فول ٣')).status, 200);
  assert.match((await waitSent(1)).text.body, /رقمك مو مسجل/);
  assert.strictEqual(sent[0].to, '966500000009'); assert.strictEqual(sent[0].auth, 'Bearer TOK');

  const { id: wid } = await call('POST', '/api/users', { name: 'عامل واتس', role: 'worker', pin: '4321', phone: '0500000001' });
  assert.strictEqual((await call('GET', '/api/users')).find(x => x.id === wid).phone, '966500000001', '05… => 9665…');
  await assert.rejects(call('POST', '/api/users', { name: 'ثاني', role: 'worker', pin: '1111', phone: '+966 50 000 0001' }), /مسجل لموظف ثاني/);
  const { id: item } = await call('POST', '/api/items', { name: 'فول واتس', unit: 'قدر', daily: 1, kind: 'prepared' });
  await call('POST', '/api/responsibility', { item_id: item, user_id: wid, opener_id: '' });

  await hook('966500000001', 'آخر الدوام: فول ٣ قدور، وشي غريب ١');
  const m = (await waitSent(2)).text.body;
  assert.match(m, /فول واتس: 3/); assert.match(m, /تمام/); assert.doesNotMatch(m, /اضغط «تأكيد»/);
  let r = (await call('GET', '/api/board?date=' + today)).rows.find(x => x.item_id === item);
  assert.strictEqual(r.closing, null, 'ما ينسجل قبل «تمام»');

  // نفس الرسالة مرة ثانية من ميتا (إعادة إرسال) => تنتجاهل
  await hook('966500000001', 'تمام', { id: 'wamid.same' });
  await waitSent(3);
  await hook('966500000001', 'تمام', { id: 'wamid.same' });
  assert.match(sent[2].text.body, /✓ انسجل: جرد آخر الدوام/);
  r = (await call('GET', '/api/board?date=' + today)).rows.find(x => x.item_id === item);
  assert.strictEqual(r.closing, 3);
  assert.strictEqual(r.closing_user, 'عامل واتس');
  await new Promise(res => setTimeout(res, 300));
  assert.strictEqual(sent.length, 3, 'المكرر ما ينرد عليه');

  // العامل ما يقدر يسجل مشتريات (نفس صلاحياته في البرنامج)
  await hook('966500000001', 'اشتريت فول بعشرة');
  assert.doesNotMatch((await waitSent(4)).text.body, /رد \*تمام\*/);
  await hook('966500000001', 'تمام');
  assert.doesNotMatch((await waitSent(5)).text.body, /انسجل/, 'ما فيه كرت ينتظر');

  const st = await call('GET', '/api/whatsapp/status');
  assert.ok(st.ready); assert.ok(st.log.some(l => l.dir === 'in' && l.name === 'عامل واتس'));
  await assert.rejects(call('GET', '/api/whatsapp/status', null, (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: wid, pin: '4321' }) })).json()).token), e => e.status === 403);
});
