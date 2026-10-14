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
  // ٢. المشرف: انرمى (بصورة) + جرد آخر الدوام
  tu(['propose_move', { mode: 'waste', item: 'حنيذ دجاج', qty: 1, unit: null, note: 'طاح' }], ['propose_count', { phase: 'closing', entries: [{ item: 'حنيذ دجاج', qty: 7 }, { item: 'سلطة', qty: 3 }] }]), end('شيك الكروت'),
  // ٣. تذكير
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

  // ٢. العامل ما عنده مساعد — المشرف يسجل
  await assert.rejects(call('POST', '/api/assistant', { question: 'وش علي؟' }, WT), e => e.status === 403);
  await call('POST', '/api/count', { date: today, item_id: hn.id, phase: 'opening', qty: 8 }, WT);
  const IMG = 'data:image/jpeg;base64,/9j/AAAA';
  const r2 = await call('POST', '/api/assistant', { question: 'انرمى حنيذ وحدة، وآخر الدوام حنيذ 7 وسلطة 3', images: [IMG] });
  assert.deepStrictEqual(r2.actions.map(a => a.type), ['move', 'count']);
  assert.strictEqual(r2.actions[0].requests[0].attach_image, true);
  assert.strictEqual(r2.actions[1].requests.length, 2);
  await confirm(r2.actions[0], T, { image: IMG });
  await confirm(r2.actions[1], T);
  const sent = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(JSON.parse);
  const row = (await call('GET', '/api/board?date=' + today)).rows.find(x => x.item_id === hn.id);
  assert.strictEqual(row.wasted, 1); assert.strictEqual(row.closing, 7); assert.strictEqual(row.diff, 0);

  // ٣. تذكير (زكريا)
  const r3 = await call('POST', '/api/assistant', { question: 'ذكرني أطلب فحم' }, ZT);
  await confirm(r3.actions[0], ZT);
  let todo = (await call('GET', '/api/dashboard', null, ZT)).todo;
  const rem = todo.find(t => t.title === '⏰ اطلب فحم');
  assert.ok(rem && rem.done_id);
  await call('POST', `/api/reminders/${rem.done_id}/done`, {}, ZT);
  todo = (await call('GET', '/api/dashboard', null, ZT)).todo;
  assert.ok(!todo.some(t => t.title === '⏰ اطلب فحم'));

  // ٤. الحد اليومي: زكريا يوقف، والمالك لا
  await call('POST', '/api/settings', { ai_user_daily: '2' });
  await assert.rejects(call('POST', '/api/assistant', { question: 'وش علي؟' }, ZT), e => e.status === 400 && /حد الأسئلة اليومي/.test(e.message));
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
  // مخطط الأدوات لازم يقبله Anthropic: enum مع نوع واحد بس (مو [string, null]) — وإلا الواتساب كله يوقف
  const bad = [];
  const walk = (x, at) => { if (!x || typeof x !== 'object') return; if (x.enum && Array.isArray(x.type)) bad.push(at); for (const [k, v] of Object.entries(x)) walk(v, at + '.' + k); };
  for (const t of AS.toolsFor({ role: 'owner', id: 1 })) walk(t.input_schema, t.name);
  assert.deepStrictEqual(bad, [], 'enum مع نوع مركّب');
  assert.ok(AS.toolsFor({ role: 'owner', id: 1 }).filter(t => t.strict).length <= 20, 'Anthropic: أقصى ٢٠ أداة strict');
  let unions = 0;
  const cnt = x => { if (!x || typeof x !== 'object') return; if (Array.isArray(x.type) || x.anyOf) unions++; for (const v of Object.values(x)) cnt(v); };
  for (const t of AS.toolsFor({ role: 'owner', id: 1 }).filter(t => t.strict)) cnt(t.input_schema);
  assert.ok(unions <= 16, `Anthropic: أقصى ١٦ خانة null في الأدوات strict (عندنا ${unions})`);
  // 🧠 القوي للشغل والصور والمشرفين، والسريع للسوالف
  assert.strictEqual(AS.pickTier({ role: 'worker' }, 'السلام عليكم', 0), 'fast');
  assert.strictEqual(AS.pickTier({ role: 'supervisor' }, 'هلا والله', 0), 'fast');
  assert.strictEqual(AS.pickTier({ role: 'worker' }, 'شي', 1), 'mid');
  assert.strictEqual(AS.pickTier({ role: 'worker' }, 'جرد الفول ٣', 0), 'fast');
  assert.strictEqual(AS.pickTier({ role: 'supervisor' }, 'مين ما جرد', 0), 'mid');
  // 💰 الكاش: علامة وحدة على آخر رسالة بس
  const msgs = [{ role: 'user', content: 'سلام' }, { role: 'assistant', content: [{ type: 'text', text: 'هلا' }] }, { role: 'user', content: [{ type: 'image', source: {} }, { type: 'text', text: 'جرد' }] }];
  AS.markCache(msgs); AS.markCache(msgs);
  assert.strictEqual(JSON.stringify(msgs).split('cache_control').length - 1, 1);
  assert.ok(msgs[2].content[1].cache_control);
  const AI = require('../server/ai'); assert.strictEqual(AI.costOf({ input_tokens: 1e6, output_tokens: 1e6 }, 'mid'), 12);
  assert.strictEqual(AS.pickTier({ role: 'worker' }, 'ايوه', 0, true), 'fast', 'العامل: الرخيص');
  assert.strictEqual(AS.pickTier({ role: 'supervisor' }, 'ايوه', 0, true), 'mid', 'المشرف وسط محادثة');
  assert.strictEqual(AS.pickTier({ role: 'worker' }, 'السلام عليكم', 0, true), 'fast');
  const pool = [{ id: 1, name: 'فتة أحمر' }, { id: 2, name: 'فتة أبيض' }, { id: 3, name: 'حنيذ دجاج' }];
  assert.strictEqual(AS.resolveItem('حنيذ', pool).item.id, 3);
  assert.ok(AS.resolveItem('فتة', pool).err, 'ambiguous asks');
  assert.strictEqual(AS.resolveItem('فته احمر', pool).item.id, 1);
});
