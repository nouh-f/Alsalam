'use strict';
// ✂️ الخصم ينفّذ: نوح أو مشرف المحل في الخاص => الرواتب على طول + العامل يدري؛ على مشرف => كرت لنوح؛
// مشرف برا المحل (مو في wa_deduct_ids) => ما ينفذ
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

let srv, B, T, FX, runs = [];
const call = async (method, p, body, tok = T) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const U = { input_tokens: 1, output_tokens: 1 };
const tool = (input) => ({ stop_reason: 'tool_use', usage: U, content: [{ type: 'tool_use', id: 't' + Math.random(), name: 'deduct', input }] });
const say = text => ({ stop_reason: 'end_turn', usage: U, content: [{ type: 'text', text }] });
let mid = 0;
const inject = (phone, text, group) => call('POST', '/api/whatsapp/_inject', { id: 'dm' + (++mid), phone, chat: group || phone, ...(group ? { isGroup: true, groupName: 'جروب المطعم' } : {}), text });
async function outbox(n) {
  let ob = [];
  for (let i = 0; i < 80 && ob.length < n; i++) { ob = await call('GET', '/api/whatsapp/_outbox'); await new Promise(r => setTimeout(r, 50)); }
  return ob;
}
const feed = list => { runs = [...runs, ...list]; fs.writeFileSync(FX, JSON.stringify(runs)); }; // النداءات تمشي بالترتيب على الملف كله
const deducts = async uid => (await call('GET', '/api/payroll')).find(x => x.id === uid).entries.filter(e => e.type === 'deduct');

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-dd-'));
  FX = path.join(dir, 'ai.json');
  const port = 38000 + Math.floor(Math.random() * 900); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir, AI_FIXTURE: FX, WA_TEST_INJECT: '1' }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  await call('POST', '/api/settings', { anthropic_key: 'sk-test' });
});
test.after(() => srv.kill());

test('owner and shop supervisors deduct from private chat; supervisors outside the shop cannot', async () => {
  const me = (await call('GET', '/api/users')).find(x => x.id === 1);
  await call('POST', '/api/users', { id: 1, name: me.name, role: 'owner', pin: '1234', phone: '0500000700' });
  const { id: sup } = await call('POST', '/api/users', { name: 'إبراهيم خصم', role: 'supervisor', pin: '2121', phone: '0500000701' });
  const { id: out } = await call('POST', '/api/users', { name: 'حسن خصم', role: 'supervisor', pin: '2323', phone: '0500000702' });
  const { id: wk } = await call('POST', '/api/users', { name: 'سليمان خصم', role: 'worker', pin: '2424', phone: '0500000703', salary: 1500 });
  await call('POST', '/api/settings', { wa_deduct_ids: String(sup) });

  // 1) نوح: «أجرة يوم» => 1500 ÷ 30 = 50، ينسجل على طول والعامل يدري
  feed([tool({ employee: 'سليمان خصم', amount: null, day_wage: true, reason: 'غياب', date: null }), say('✓ اتسجل خصم سليمان خصم 50 ريال — غياب')]);
  await inject('966500000700', 'اخصم على سليمان أجرة يوم غايب');
  let ob = await outbox(2);
  assert.ok(ob.some(x => x.to === '966500000703' && /انخصم عليك 50 ريال — غياب/.test(x.text)), JSON.stringify(ob));
  let d = await deducts(wk);
  assert.strictEqual(d.length, 1); assert.strictEqual(d[0].amount, 50); assert.match(d[0].note, /نوح|في الخاص/);

  // 2) مشرف المحل على عامل => ينسجل، والعامل ونوح يدرون
  let n = ob.length;
  feed([tool({ employee: 'سليمان خصم', amount: 30, day_wage: false, reason: 'جوال وقت الدوام', date: null }), say('✓ اتسجل')]);
  await inject('966500000701', 'اخصم على سليمان 30 جوال');
  ob = await outbox(n + 3);
  assert.ok(ob.slice(n).some(x => x.to === '966500000703' && /انخصم عليك 30 ريال/.test(x.text)), JSON.stringify(ob.slice(n)));
  assert.ok(ob.slice(n).some(x => x.to === '966500000700' && /✓ انسجل خصم سليمان خصم 30/.test(x.text)));
  assert.strictEqual((await deducts(wk)).length, 2);

  // 3) مشرف المحل على مشرف => كرت لنوح، ما ينسجل لين «تمام»
  n = ob.length;
  feed([tool({ employee: 'حسن خصم', amount: 20, day_wage: false, reason: 'تأخير', date: null }), say('راح لنوح يأكده')]);
  await inject('966500000701', 'اخصم على حسن 20 تأخير');
  ob = await outbox(n + 2);
  assert.ok(ob.slice(n).some(x => x.to === '966500000700' && /خصم حسن خصم 20/.test(x.text) && /تمام/.test(x.text)), JSON.stringify(ob.slice(n)));
  assert.strictEqual((await deducts(out)).length, 0);

  // 4) مشرف برا المحل في القروب => ما ينسجل، ويوصله إن الخصم مو له
  await call('POST', '/api/whatsapp/groups', { groups: [{ id: 'gd@g.us', role: 'restaurant' }] });
  n = ob.length;
  feed([say(JSON.stringify({ deductions: [{ employee: 'سليمان خصم', amount: 40, reason: 'تأخير' }], requests: [], issues: [] }))]);
  await inject('966500000702', 'خصم سليمان 40 تأخير', 'gd@g.us');
  ob = await outbox(n + 1);
  assert.ok(ob.slice(n).some(x => x.to === '966500000702' && /الخصم لنوح ومشرفين المحل بس/.test(x.text)), JSON.stringify(ob.slice(n)));
  assert.strictEqual((await deducts(wk)).length, 2);
});
