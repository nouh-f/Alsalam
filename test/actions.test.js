'use strict';
// المساعد يسجل الشغل: كروت «تأكيد» حسب صلاحية كل موظف (ردود جاهزة بدل الاتصال)
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const tu = (...uses) => ({ stop_reason: 'tool_use', content: uses.map(([name, input], i) => ({ type: 'tool_use', id: 't' + name + i, name, input })) });
const end = text => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const FX = [
  // ١. زكريا: شراء بالكلام
  tu(['propose_purchase', { supplier: 'خضار الوادي', payment: 'cash', note: null, lines: [{ item: 'طماط', qty: 2, unit: 'كرتون', unit_price: null, line_total: 60 }] }]), end('شيك الكرت واضغط تأكيد'),
  // ٢. العامل: انرمى + جرد آخر الدوام (واحد مو عليه) + يحاول شراء (ممنوع)
  tu(['propose_move', { mode: 'waste', item: 'حنيذ دجاج', qty: 1, unit: null, note: 'طاح' }], ['propose_count', { phase: 'closing', entries: [{ item: 'حنيذ دجاج', qty: 7 }, { item: 'سلطة', qty: 3 }] }],
    ['propose_purchase', { supplier: null, payment: 'cash', note: null, lines: [{ item: 'طماطم', qty: 1, unit: null, unit_price: 5, line_total: null }] }]), end('شيك الكروت'),
  // ٣. العامل: تذكير
  tu(['set_reminder', { text: 'اطلب فحم', date: null }]), end('تمام'),
  // ٤. المالك (بعد ما العامل وصل حده)
  end('أهلين'),
  // ٥. المالك: صور التذكرة
  tu(['propose_ticket', { date: null }]), end('اضغط تأكيد'),
];

let srv, B, T, LOG, today, dir;
const login = async (user_id, pin) => (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id, pin }) })).json()).token;
const call = async (method, p, body, tok = T) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const confirm = async (card, tok, extra = {}) => { let last; for (const r of card.requests) last = await call('POST', r.endpoint, { ...r.body, ...extra }, tok); return last; };

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-act-'));
  const fx = path.join(dir, 'ai.json'); fs.writeFileSync(fx, JSON.stringify(FX)); LOG = path.join(dir, 'ai.log');
  const port = 30000 + Math.floor(Math.random() * 3000); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, DATA_DIR: dir, AI_FIXTURE: fx, AI_FIXTURE_LOG: LOG }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = await login(1, '1234');
  today = (await call('GET', '/api/me')).today;
  await call('POST', '/api/settings', { anthropic_key: 'sk-test' });
});
test.after(() => srv.kill());

test('assistant prepares cards per role; confirming uses the normal API', async () => {
  // الصنف موجود من البداية؟ نعدّله، وإلا نضيفه
  const items0 = await call('GET', '/api/items');
  const upsert = async b => { const ex = items0.find(i => i.name === b.name); return call('POST', '/api/items', { ...(ex || {}), ...b, id: ex ? ex.id : undefined }); };
  const tom = await upsert({ name: 'طماطم', unit: 'كجم', kind: 'raw', daily: 0 });
  await call('PUT', `/api/items/${tom.id}/units`, { units: [{ name: 'كرتون', factor: 6 }] });
  const hn = await upsert({ name: 'حنيذ دجاج', unit: 'حبة', kind: 'raw', daily: 1, carry_over: 1 });
  const sl = await upsert({ name: 'سلطة', unit: 'صحن', kind: 'raw', daily: 1, carry_over: 1 });
  const w = await call('POST', '/api/users', { name: 'عامل الحنيذ', role: 'worker', pin: '1111' });
  const w2 = await call('POST', '/api/users', { name: 'عامل السلطة', role: 'worker', pin: '2222' });
  await call('POST', '/api/responsibility', { item_id: hn.id, user_id: w.id });
  await call('POST', '/api/responsibility', { item_id: sl.id, user_id: w2.id });
  const zak = (await call('GET', '/api/login-users')).find(u => u.name === 'زكريا');
  const ZT = await login(zak.id, '0000'), WT = await login(w.id, '1111');

  // ١. زكريا
  const r1 = await call('POST', '/api/assistant', { question: 'اشتريت كرتونين طماط بستين كاش' }, ZT);
  assert.strictEqual(r1.actions.length, 1);
  const pc = r1.actions[0];
  assert.strictEqual(pc.type, 'purchase');
  assert.deepStrictEqual(pc.requests[0].body.lines[0], { item_id: tom.id, qty: 2, unit: 'كرتون', unit_price: '', line_total: 60 });
  assert.strictEqual((await call('GET', '/api/warehouse', null, ZT)).find(i => i.id === tom.id).balance, 0, 'nothing saved before confirm');
  await confirm(pc, ZT);
  assert.strictEqual((await call('GET', '/api/warehouse', null, ZT)).find(i => i.id === tom.id).balance, 12);

  // ٢. العامل
  await call('POST', '/api/count', { date: today, item_id: hn.id, phase: 'opening', qty: 8 }, WT);
  const r2 = await call('POST', '/api/assistant', { question: 'انرمى حنيذ وحدة، وآخر الدوام حنيذ 7 وسلطة 3' }, WT);
  assert.deepStrictEqual(r2.actions.map(a => a.type), ['move', 'count']);
  const cnt = r2.actions[1];
  assert.strictEqual(cnt.requests.length, 1, 'only his item');
  assert.ok(cnt.lines.some(l => /سلطة: مو عليك/.test(l)));
  const sent = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(JSON.parse);
  const res2 = sent[3].content; // نتائج أدوات الرسالة الثانية
  assert.match(res2.find(x => x.tool_use_id.startsWith('tpropose_purchase')).content, /صلاحية/);
  for (const a of r2.actions) await confirm(a, WT);
  const row = (await call('GET', '/api/board?date=' + today)).rows.find(x => x.item_id === hn.id);
  assert.strictEqual(row.wasted, 1); assert.strictEqual(row.closing, 7); assert.strictEqual(row.diff, 0);

  // ٣. تذكير
  const r3 = await call('POST', '/api/assistant', { question: 'ذكرني أطلب فحم' }, WT);
  await confirm(r3.actions[0], WT);
  let todo = (await call('GET', '/api/dashboard', null, WT)).todo;
  const rem = todo.find(t => t.title === '⏰ اطلب فحم');
  assert.ok(rem && rem.done_id);
  await call('POST', `/api/reminders/${rem.done_id}/done`, {}, WT);
  todo = (await call('GET', '/api/dashboard', null, WT)).todo;
  assert.ok(!todo.some(t => t.title === '⏰ اطلب فحم'));

  // ٤. الحد اليومي: العامل يوقف، والمالك لا
  await call('POST', '/api/settings', { ai_user_daily: '2' });
  await assert.rejects(call('POST', '/api/assistant', { question: 'وش علي؟' }, WT), e => e.status === 400 && /حد الأسئلة اليومي/.test(e.message));
  assert.strictEqual((await call('POST', '/api/assistant', { question: 'هلا' })).answer, 'أهلين');

  // ٥. التذكرة بالصور
  const r5 = await call('POST', '/api/assistant', { question: 'هذي تذكرة اليوم', images: ['data:image/jpeg;base64,AAAA', 'data:image/jpeg;base64,BBBB'] });
  assert.strictEqual(r5.actions[0].type, 'ticket'); assert.strictEqual(r5.actions[0].requests[0].attach_images, true);
  const all5 = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(JSON.parse);
  const withImgs = all5.filter(m => Array.isArray(m.content) && m.content.some(c => c.type === 'image'));
  assert.strictEqual(withImgs.at(-1).content.filter(c => c.type === 'image').length, 2, 'images sent to the model');
});

test('tools per role', () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-roles-'));
  const AS = require('../server/assistant');
  const names = u => AS.toolsFor(u).map(t => t.name);
  const worker = names({ role: 'worker' }), purch = names({ role: 'purchaser' }), sup = names({ role: 'supervisor', no_sales: 1 }), owner = names({ role: 'owner' });
  for (const t of ['propose_purchase', 'propose_expense', 'sales', 'day_report', 'propose_cash_count', 'propose_ticket', 'purchases']) assert.ok(!worker.includes(t), 'worker: ' + t);
  for (const t of ['propose_count', 'propose_move', 'my_tasks', 'set_reminder', 'explain_shortage']) assert.ok(worker.includes(t), 'worker has ' + t);
  assert.ok(purch.includes('propose_purchase') && !purch.includes('propose_count') && !purch.includes('sales'));
  assert.ok(sup.includes('propose_expense') && !sup.includes('sales'), 'supervisor without sales');
  for (const t of ['propose_purchase', 'propose_expense', 'propose_cash_count', 'propose_ticket', 'sales', 'forecast']) assert.ok(owner.includes(t), 'owner has ' + t);
  assert.strictEqual(new Set(owner).size, owner.length, 'no duplicate tools');
  const pool = [{ id: 1, name: 'فتة أحمر' }, { id: 2, name: 'فتة أبيض' }, { id: 3, name: 'حنيذ دجاج' }];
  assert.strictEqual(AS.resolveItem('حنيذ', pool).item.id, 3);
  assert.ok(AS.resolveItem('فتة', pool).err, 'ambiguous asks');
  assert.strictEqual(AS.resolveItem('فته احمر', pool).item.id, 1);
});
