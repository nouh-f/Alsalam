'use strict';
// 🛠️ العامل يرسل مشكلة في الخاص (للرقم المربوط) => تتسجل ونوح توصله نسخة
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

let srv, B, T;
const call = async (method, p, body, tok = T) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const U = { input_tokens: 1, output_tokens: 1 };

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-wp-'));
  const FX = path.join(dir, 'ai.json');
  fs.writeFileSync(FX, JSON.stringify([
    { stop_reason: 'tool_use', usage: U, content: [{ type: 'tool_use', id: 't1', name: 'report_problem', input: { problem: 'جرد الفول أمس طلع ناقص وهو مو ناقص', kind: 'work' } }] },
    { stop_reason: 'end_turn', usage: U, content: [{ type: 'text', text: 'وصلت لنوح 👍 وبنشوف لها حل.' }] },
  ]));
  const port = 38000 + Math.floor(Math.random() * 900); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir, AI_FIXTURE: FX, WA_TEST_INJECT: '1' }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  await call('POST', '/api/settings', { anthropic_key: 'sk-test' });
});
test.after(() => srv.kill());

test('a worker reports a problem in private => logged + the owner gets a copy + the worker is reassured', async () => {
  const me = (await call('GET', '/api/users')).find(x => x.id === 1);
  await call('POST', '/api/users', { id: 1, name: me.name, role: 'owner', pin: '1234', phone: '0500000900' });
  await call('POST', '/api/users', { name: 'فؤاد مشكلة', role: 'worker', pin: '4545', phone: '0500000901' });
  await call('POST', '/api/whatsapp/_inject', { id: 'p1', phone: '966500000901', chat: '966500000901', text: 'الجرد حقي أمس غلط، الفول طلع ناقص وأنا عديته صح' });
  let ob = [];
  for (let i = 0; i < 60 && ob.length < 2; i++) { ob = await call('GET', '/api/whatsapp/_outbox'); await new Promise(r => setTimeout(r, 50)); }
  assert.ok(ob.some(x => x.to === '966500000900' && /🛠️ فؤاد مشكلة في الخاص/.test(x.text) && /جرد الفول/.test(x.text)), JSON.stringify(ob));
  assert.ok(ob.some(x => x.to === '966500000901' && /وصلت لنوح/.test(x.text)));
  const iss = await call('GET', '/api/issues');
  assert.ok(iss.rows.some(x => x.type === 'other' && x.employee === 'فؤاد مشكلة' && x.step === 0)); // مشاكل النظام (system) تنسجل بس وتطلع في تقرير الأسبوع
});

test('📢 broadcast: restaurant group + every registered employee in private', async () => {
  await call('POST', '/api/whatsapp/groups', { groups: [{ id: 'gR@g.us', role: 'restaurant' }] });
  const before = (await call('GET', '/api/whatsapp/_outbox')).length;
  const r = await call('POST', '/api/whatsapp/broadcast', { text: 'رسالة تعريف' });
  assert.ok(r.group); assert.deepStrictEqual(r.private, ['فؤاد مشكلة']);
  let ob = [];
  for (let i = 0; i < 40 && ob.length < before + 2; i++) { ob = await call('GET', '/api/whatsapp/_outbox'); await new Promise(x => setTimeout(x, 50)); }
  const nw = ob.slice(before);
  assert.ok(nw.some(x => x.to === 'gR@g.us' && x.text === 'رسالة تعريف'));
  assert.ok(nw.some(x => x.to === '966500000901' && x.text === 'رسالة تعريف'));
  assert.ok(!nw.some(x => x.to === '966500000900'), 'المالك (اللي أرسل) ما توصله');
});

test('📢 to one employee only (user_ids): private, no group', async () => {
  const w = (await call('GET', '/api/users')).find(x => x.name === 'فؤاد مشكلة');
  const before = (await call('GET', '/api/whatsapp/_outbox')).length;
  const r = await call('POST', '/api/whatsapp/broadcast', { text: 'تذكير تأخير', user_ids: [w.id] });
  assert.strictEqual(r.group, false); assert.deepStrictEqual(r.private, ['فؤاد مشكلة']);
  let ob = [];
  for (let i = 0; i < 40 && ob.length < before + 1; i++) { ob = await call('GET', '/api/whatsapp/_outbox'); await new Promise(x => setTimeout(x, 50)); }
  assert.deepStrictEqual(ob.slice(before), [{ to: '966500000901', text: 'تذكير تأخير' }]);
  // 🖼️ صورة شرح قبل الكتابة
  const png = 'data:image/png;base64,' + Buffer.from('fake-png').toString('base64');
  const before2 = ob.length;
  assert.strictEqual((await call('POST', '/api/whatsapp/broadcast', { text: 'شرح الجرد', user_ids: [w.id], image: png })).image, true);
  for (let i = 0; i < 40 && ob.length < before2 + 2; i++) { ob = await call('GET', '/api/whatsapp/_outbox'); await new Promise(x => setTimeout(x, 50)); }
  assert.deepStrictEqual(ob.slice(before2), [{ to: '966500000901', text: '', image: 8 }, { to: '966500000901', text: 'شرح الجرد' }]);
  await assert.rejects(call('POST', '/api/whatsapp/broadcast', { text: 'x', user_ids: [w.id], image: 'not-an-image' }), /data:image/);
  const { id } = await call('POST', '/api/users', { name: 'بدون جوال', role: 'worker', pin: '4646' });
  await assert.rejects(call('POST', '/api/whatsapp/broadcast', { text: 'x', user_ids: [id] }), /ما له جوال/);
});

test('🚨 «بلدية» in the group => every worker gets a private heads-up, the owner is told, once per 30 min', async () => {
  await call('POST', '/api/whatsapp/groups', { groups: [{ id: 'gR@g.us', role: 'restaurant' }] });
  const before = (await call('GET', '/api/whatsapp/_outbox')).length;
  await call('POST', '/api/whatsapp/_inject', { id: 'b1', phone: '966500000901', chat: 'gR@g.us', isGroup: true, groupName: 'المطعم', text: 'البلدية جت' });
  let ob = [];
  for (let i = 0; i < 40 && ob.length < before + 2; i++) { ob = await call('GET', '/api/whatsapp/_outbox'); await new Promise(x => setTimeout(x, 50)); }
  const nw = ob.slice(before);
  assert.ok(nw.some(x => x.to === '966500000901' && /تفتيش في المحل/.test(x.text)));
  assert.ok(nw.some(x => x.to === '966500000900' && /بلّغ: البلدية/.test(x.text)));
  assert.ok(!nw.some(x => x.to === 'gR@g.us'), 'ما يكتب في القروب');
  await call('POST', '/api/whatsapp/_inject', { id: 'b2', phone: '966500000901', chat: 'gR@g.us', isGroup: true, groupName: 'المطعم', text: 'بلدية' });
  await new Promise(x => setTimeout(x, 300));
  assert.strictEqual((await call('GET', '/api/whatsapp/_outbox')).length, ob.length, 'مرة وحدة كل ٣٠ دقيقة');
});

test('Claude bot account can use WhatsApp (broadcast, status) but not payroll or settings', async () => {
  const { token } = await call('POST', '/api/settings/claude-key', {});
  assert.ok((await call('GET', '/api/whatsapp/status', null, token)).log);
  assert.ok((await call('POST', '/api/whatsapp/broadcast', { text: 'من Claude', private: false }, token)).group);
  await assert.rejects(call('GET', '/api/payroll', null, token), e => e.status === 403);
  await assert.rejects(call('GET', '/api/settings', null, token), e => e.status === 403);
  await assert.rejects(call('POST', '/api/whatsapp/link', { action: 'logout' }, token), e => e.status === 403);
});
