'use strict';
// المساعد: أدوات القراءة، الملخص، التوصيات، الحد الشهري، والصلاحيات — بردود جاهزة بدل الاتصال
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

let receipts = [];
const rc = (n, date, qty) => ({ receipt_number: n, receipt_type: 'SALE', created_at: date + 'T12:00:00Z', receipt_date: date + 'T12:00:00Z', total_money: qty * 3,
  line_items: [{ item_id: 'i1', variant_id: 'v1', item_name: 'بيبسي', quantity: qty, price: 3, total_money: qty * 3 }], payments: [{ name: 'نقدي', type: 'CASH', money_amount: qty * 3 }] });
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json');
  if (u.pathname === '/items') return res.end(JSON.stringify({ items: [{ id: 'i1', item_name: 'بيبسي', variants: [{ variant_id: 'v1', default_price: 3 }] }] }));
  if (u.pathname === '/categories') return res.end('{"categories":[]}');
  if (u.pathname === '/receipts') return res.end(JSON.stringify({ receipts }));
  res.statusCode = 404; res.end('{}');
});

const FX = [
  { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'sales', input: { from: 'TODAY', to: 'TODAY', product: 'بيبسي' } }], usage: { input_tokens: 1000 } },
  { stop_reason: 'end_turn', content: [{ type: 'text', text: 'بعتوا **3** بيبسي اليوم' }], usage: { input_tokens: 1000000, output_tokens: 0 } },
  { stop_reason: 'end_turn', content: [{ type: 'text', text: '• المبيعات 9 ريال' }], usage: {} },
  { stop_reason: 'end_turn', content: [{ type: 'text', text: '• جهّز بيبسي 5' }], usage: {} },
];
let srv, B, T, LOG, today;
const call = async (method, p, body, tok = T) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

test.before(async () => {
  await new Promise(r => mock.listen(0, r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-ai-'));
  const fx = path.join(dir, 'ai.json'); LOG = path.join(dir, 'ai.log');
  const port = 41000 + Math.floor(Math.random() * 4000); B = `http://127.0.0.1:${port}`;
  // التاريخ يتعبّى بعد ما نعرف «اليوم» — نكتب الملف قبل التشغيل ونعدّله بعدين (يتقرا وقت كل نداء)
  fs.writeFileSync(fx, '[]');
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: port, DATA_DIR: dir, AI_FIXTURE: fx, AI_FIXTURE_LOG: LOG, LOYVERSE_BASE: `http://127.0.0.1:${mock.address().port}` }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  today = (await call('GET', '/api/me')).today;
  fs.writeFileSync(fx, JSON.stringify(FX).replaceAll('TODAY', today));
  // اليوم 3 بيبسي، ونفس يوم بكرة من الأسبوعين اللي فاتت 10 و 20
  receipts = [rc('a', today, 3), rc('b', addDays(today, -6), 10), rc('c', addDays(today, -13), 20)];
  await call('POST', '/api/settings', { loyverse_token: 'x', anthropic_key: 'sk-test' });
  assert.ok((await call('POST', '/api/sync', { full: true })).ok);
});
test.after(() => { srv.kill(); mock.close(); });

test('assistant: tool loop, summary, reco, forecast, cap, permissions', async () => {
  const r = await call('POST', '/api/assistant', { question: 'كم بعنا بيبسي اليوم؟', history: [] });
  assert.match(r.answer, /بيبسي/);
  assert.deepStrictEqual(r.tools, ['sales']);
  assert.ok(r.cost > 0.09 && r.cost < 0.11, 'haiku price: 1M input = $0.10');
  // الأداة رجّعت الرقم الصح للنموذج
  const sent = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(JSON.parse);
  assert.match(sent[0].content, new RegExp(today));
  const toolRes = JSON.parse(sent[1].content[0].content);
  assert.strictEqual(toolRes.products[0].qty, 3);

  // الملخص ينحفظ ولا يتكرر الصرف
  const s1 = await call('POST', '/api/assistant/summary', { date: today });
  assert.match(s1.text, /المبيعات/);
  const saved = await call('GET', '/api/assistant/saved?kind=summary&date=' + today);
  assert.strictEqual(saved.saved.text, s1.text);
  const s2 = await call('POST', '/api/assistant/summary', { date: today });
  assert.strictEqual(fs.readFileSync(LOG, 'utf8').trim().split('\n').length, 3, 'saved summary reused');
  assert.strictEqual(s2.text, s1.text);

  // التوقع: متوسط بكرة من الأسبوعين اللي فاتت = 15 بيبسي
  const fc = await call('GET', '/api/forecast');
  assert.strictEqual(fc.date, addDays(today, 1));
  assert.strictEqual(fc.samples, 2);
  assert.strictEqual(fc.products.find(p => p.name === 'بيبسي').qty, 15);
  const reco = await call('POST', '/api/assistant/reco', {});
  assert.match(reco.text, /جهّز/);
  const reqReco = JSON.parse(fs.readFileSync(LOG, 'utf8').trim().split('\n').at(-1));
  assert.match(reqReco.content, /"samples":2/);

  // الحد الشهري
  await call('POST', '/api/settings', { ai_monthly_cap: '0.05' });
  await assert.rejects(call('POST', '/api/assistant', { question: 'كم؟' }), e => e.status === 400 && /حد الشهر/.test(e.message));
  const st = await call('GET', '/api/settings');
  assert.ok(st.ai_cost_month >= 0.1);

  // العامل ما يوصل
  const w = await call('POST', '/api/users', { name: 'عامل اختبار', role: 'worker', pin: '5555' });
  const wt = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: w.id, pin: '5555' }) })).json()).token;
  await assert.rejects(call('POST', '/api/assistant', { question: 'كم؟' }, wt), e => e.status === 403);
  await assert.rejects(call('GET', '/api/forecast', null, wt), e => e.status === 403);
});

test('history before stock start does not touch the warehouse', async () => {
  const st = await call('GET', '/api/settings');
  assert.ok(st.history_from <= addDays(today, -13));
  // سحب سجل قديم (قبل بداية المخزون) ما يسوي حركات خصم
  receipts.push(rc('old', addDays(today, -200), 50));
  await call('POST', '/api/sync', { days: 365 });
  for (let i = 0; i < 50; i++) { if ((await call('GET', '/api/sales?date=' + addDays(today, -200))).length) break; await new Promise(r => setTimeout(r, 100)); }
  assert.strictEqual((await call('GET', '/api/sales?date=' + addDays(today, -200)))[0].qty, 50);
  const moves = await call('GET', '/api/moves?date=' + addDays(today, -200));
  assert.strictEqual(moves.filter(m => m.type === 'sale_use').length, 0);
});
