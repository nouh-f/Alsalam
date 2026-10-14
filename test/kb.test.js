'use strict';
// 📘 دليل المطعم: المساعد يتعلم من نوح (على طول)، من العامل (بموافقة نوح)، ومن مراجعة الأسبوع — والدليل ينقرا في كل محادثة
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

let srv, B, T, SYS;
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const U = { input_tokens: 1, output_tokens: 1 };
const tool = (name, input) => ({ stop_reason: 'tool_use', usage: U, content: [{ type: 'tool_use', id: 't' + Math.random(), name, input }] });
const say = text => ({ stop_reason: 'end_turn', usage: U, content: [{ type: 'text', text }] });
const OWN = '966500000900', WK = '966500000902';
let n = 0;
const send = async (phone, text) => {
  const before = (await call('GET', '/api/whatsapp/_outbox')).length;
  await call('POST', '/api/whatsapp/_inject', { id: 'k' + (++n), phone, chat: phone, text });
  for (let i = 0; i < 80; i++) { const o = (await call('GET', '/api/whatsapp/_outbox')).slice(before); if (o.some(x => x.to === phone)) return o; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('ما رد');
};

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-kb-'));
  const FX = path.join(dir, 'ai.json'); SYS = path.join(dir, 'sys.log');
  fs.writeFileSync(FX, JSON.stringify([
    tool('learn', { topic: 'الأصناف وطريقتها', text: 'الحريد ينزل صندوق للمحل', replaces: null }), say('حفظتها'), // 0-1 نوح
    say('الحريد ينزل صندوق'), // 2
    tool('learn', { topic: 'الأصناف وطريقتها', text: 'الصرع ينظف قبل الجرد', replaces: null }), say('وصلت لنوح'), // 3-4 عامل
    { stop_reason: 'end_turn', usage: U, content: [{ type: 'text', text: JSON.stringify({ lessons: [{ topic: 'الشراء', text: 'زكريا يشتري الخبز كل صباح', why: 'محادثة الأسبوع' }] }) }] }, // 5 مراجعة
  ]));
  const port = 44000 + Math.floor(Math.random() * 900); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir, AI_FIXTURE: FX, AI_FIXTURE_SYSLOG: SYS, WA_TEST_INJECT: '1' }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  await call('POST', '/api/settings', { anthropic_key: 'sk-test' });
  const me = (await call('GET', '/api/users')).find(x => x.id === 1);
  await call('POST', '/api/users', { id: 1, name: me.name, role: 'owner', pin: '1234', phone: '0500000900' });
  await call('POST', '/api/users', { name: 'صادق ت', role: 'worker', pin: '5151', phone: '0500000902' });
});
test.after(() => srv.kill());

test('the handbook starts seeded, learns from the owner at once and is read in the next chat', async () => {
  const k0 = await call('GET', '/api/kb');
  assert.ok(k0.rows.length >= 15 && k0.rows.some(x => /دعدع/.test(x.text)), 'البذرة');
  await send(OWN, 'اعرف إن الحريد ينزل صندوق للمحل');
  assert.ok((await call('GET', '/api/kb')).rows.some(x => x.text === 'الحريد ينزل صندوق للمحل' && x.source === 'owner'));
  await send(OWN, 'وش تعرف عن الحريد؟');
  assert.match(fs.readFileSync(SYS, 'utf8').trim().split('\n').at(-1), /الحريد ينزل صندوق للمحل/);
});

test('a worker teaching goes to the owner first; «موافق N» adds it', async () => {
  await send(WK, 'الصرع لازم ينظف قبل الجرد');
  assert.ok(!(await call('GET', '/api/kb')).rows.some(x => /الصرع/.test(x.text)), 'ما انحفظ قبل الموافقة');
  const m = (await call('GET', '/api/whatsapp/_outbox')).find(x => x.to === OWN && /📘 الصرع ينظف قبل الجرد/.test(x.text));
  assert.ok(m);
  await send(OWN, 'موافق ' + /#(\d+)/.exec(m.text)[1]);
  assert.ok((await call('GET', '/api/kb')).rows.some(x => x.text === 'الصرع ينظف قبل الجرد' && x.source === 'worker'));
});

test('weekly review turns the week into handbook suggestions; owner can edit and delete', async () => {
  const r = await call('POST', '/api/kb/review');
  assert.strictEqual(r.ids.length, 1);
  assert.ok((await call('GET', '/api/suggestions?status=pending')).rows.some(x => x.kind === 'learn' && /الخبز/.test(x.summary)));
  const { id } = await call('POST', '/api/kb', { topic: 'عام', text: 'معلومة تجربة' });
  const { id: id2 } = await call('POST', '/api/kb', { topic: 'عام', text: 'معلومة تجربة معدلة', replaces: id });
  let rows = (await call('GET', '/api/kb')).rows;
  assert.ok(!rows.some(x => x.id === id) && rows.some(x => x.id === id2));
  await call('DELETE', '/api/kb/' + id2);
  rows = (await call('GET', '/api/kb')).rows;
  assert.ok(!rows.some(x => x.id === id2));
});
