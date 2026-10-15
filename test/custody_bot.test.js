'use strict';
// 👛 العهدة من الواتساب: «استلمت عهدة ٥٠٠» ثم «صرفت ٤٠ غاز من عهدتي» => الرصيد ٤٦٠
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

let srv, B, T;
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const U = { input_tokens: 1, output_tokens: 1 };
const tool = (name, input) => ({ stop_reason: 'tool_use', usage: U, content: [{ type: 'tool_use', id: 't' + name, name, input }] });
const say = text => ({ stop_reason: 'end_turn', usage: U, content: [{ type: 'text', text }] });
const PH = '966500000611';
let mid = 0;
const inject = text => call('POST', '/api/whatsapp/_inject', { id: 'cu' + (++mid), phone: PH, chat: PH, text });
const outbox = async n => { let ob = []; for (let i = 0; i < 60 && ob.length < n; i++) { ob = (await call('GET', '/api/whatsapp/_outbox')).filter(x => x.to === PH); if (ob.length < n) await new Promise(r => setTimeout(r, 50)); } return ob; };

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-cust-'));
  const FX = path.join(dir, 'ai.json');
  fs.writeFileSync(FX, JSON.stringify([
    tool('propose_custody', { type: 'give', amount: 500, from_drawer: true, note: null }), say('جهزت: استلمت عهدة ٥٠٠ من الدرج'),
    tool('propose_expense', { amount: 40, category: 'غاز', note: 'محطة الحي', from_cash: false, payment: 'custody' }), say('جهزت: غاز ٤٠ من عهدتك'),
    tool('my_custody', {}), say('باقي في عهدتك ٤٦٠'),
  ]));
  const port = 43000 + Math.floor(Math.random() * 400); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir, AI_FIXTURE: FX, WA_TEST_INJECT: '1' }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  await call('POST', '/api/settings', { anthropic_key: 'sk-test' });
});
test.after(() => srv.kill());

test('a supervisor receives custody, spends from it, and asks the balance — all from WhatsApp', async () => {
  const { id } = await call('POST', '/api/users', { name: 'مشرف عهدة', role: 'supervisor', pin: '6161', phone: '0500000611' });
  await inject('استلمت عهدة 500 من الدرج');
  assert.match((await outbox(1))[0].text, /👛 استلمت عهدة[\s\S]*500 ريال — من الدرج/);
  await inject('تمام');
  assert.match((await outbox(2))[1].text, /✓ اتسجل/);
  await inject('صرفت 40 غاز من عهدتي من محطة الحي');
  assert.match((await outbox(3))[2].text, /40 ريال — من عهدتي — محطة الحي/);
  await inject('تمام');
  assert.match((await outbox(4))[3].text, /✓ اتسجل/);
  const v = await call('GET', '/api/custody?user_id=' + id);
  assert.strictEqual(v.given, 500); assert.strictEqual(v.spent, 40); assert.strictEqual(v.balance, 460);
  await inject('كم باقي في عهدتي؟');
  assert.match((await outbox(5))[4].text, /٤٦٠|460/);
});
