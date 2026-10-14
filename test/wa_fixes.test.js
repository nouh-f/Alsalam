'use strict';
// 🛠️ مشاكل العمال مع المساعد في الواتساب: الكرت القديم ما يتسجل بالغلط، الصور تنتذكر، صنف/وحدة جديدة من الفاتورة،
// المشرف يذكّر اللي ما جردوا، ذاكرة دائمة، وتنسيق الواتساب (*عريض*)
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

let srv, B, T, LOG;
const call = async (method, p, body, tok = T) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const U = { input_tokens: 1, output_tokens: 1 };
const tool = (name, input) => ({ stop_reason: 'tool_use', usage: U, content: [{ type: 'tool_use', id: 't' + name + Math.random(), name, input }] });
const say = text => ({ stop_reason: 'end_turn', usage: U, content: [{ type: 'text', text }] });
const line = (item, qty, extra = {}) => ({ item, qty, unit: null, per_unit: null, new_unit: null, unit_price: null, line_total: null, ...extra });
const SUP = '966500000801', WK = '966500000802', OWN = '966500000800';
let n = 0;
const send = async (phone, text, extra = {}) => {
  const before = (await call('GET', '/api/whatsapp/_outbox')).length;
  await call('POST', '/api/whatsapp/_inject', { id: 'm' + (++n), phone, chat: phone, text, ...extra });
  for (let i = 0; i < 80; i++) { const o = await call('GET', '/api/whatsapp/_outbox'); const mine = o.slice(before).filter(x => x.to === phone); if (mine.length) return { reply: mine.at(-1).text, all: o.slice(before) }; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('ما رد');
};

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-wf-'));
  const FX = path.join(dir, 'ai.json'); LOG = path.join(dir, 'ai.log');
  fs.writeFileSync(FX, JSON.stringify([
    tool('propose_purchase', { supplier: 'مركز', payment: 'cash', note: null, lines: [line('دقيق ت', 2, { unit_price: 45 })] }), say('شيك الكرت'), // 0-1
    say('صح الكرت غلط — أرسل الفاتورة مرة ثانية'), // 2
    say('وصلت الأولى — أرسل الثانية'), // 3
    tool('propose_purchase', { supplier: 'مركز الشهري', payment: 'cash', note: null, lines: [line('سكر ناعم ت', 2, { unit: 'كيس', per_unit: 50, new_unit: 'كجم', unit_price: 100 }), line('دقيق ت', 1, { unit: 'كيس', per_unit: 45, unit_price: 90 })] }), say('جهزت الكرت'), // 4-5
    tool('remind_staff', { who: 'missing_closing', names: [], text: 'قفلوا الجرد الله يعافيكم' }), say('جهزت'), // 6-7
    tool('remember', { action: 'add', text: 'كشف حساب دعدع: المجموع ناقص الرصيد السابق' }), say('حفظتها'), // 8-9
    say('هلا **نوح**\n## ملخص\nتمام'), // 10
    tool('suggest_change', { kind: 'item_responsible', summary: 'إبراهيم ت يفتح فول ت بدال فؤاد', item: 'فول ت', employee: 'إبراهيم ت', phase: 'opening', date: null, qty: null, new_name: null }), say('وصل اقتراحك لنوح'), // 11-12
  ]));
  const port = 42000 + Math.floor(Math.random() * 900); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir, AI_FIXTURE: FX, AI_FIXTURE_LOG: LOG, WA_TEST_INJECT: '1' }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  await call('POST', '/api/settings', { anthropic_key: 'sk-test', auto_approve: '0' }); // الاختبارات القديمة: بموافقة نوح
  const me = (await call('GET', '/api/users')).find(x => x.id === 1);
  await call('POST', '/api/users', { id: 1, name: me.name, role: 'owner', pin: '1234', phone: '0500000800' });
  await call('POST', '/api/users', { name: 'إبراهيم ت', role: 'supervisor', pin: '4141', phone: '0500000801' });
  const w = await call('POST', '/api/users', { name: 'فؤاد ت', role: 'worker', pin: '4242', phone: '0500000802' });
  await call('POST', '/api/items', { name: 'دقيق ت', unit: 'كجم', kind: 'raw', daily: 0 });
  const it = await call('POST', '/api/items', { name: 'فول ت', unit: 'صحن', kind: 'prepared', daily: 1 });
  await call('POST', '/api/items', { id: it.id, name: 'فول ت', unit: 'صحن', kind: 'prepared', daily: 1, closing_user_id: w.id, opening_user_id: w.id });
});
test.after(() => srv.kill());

const purchases = async () => (await call('GET', '/api/purchases')).filter(p => /مركز/.test(p.supplier || ''));

test('a card the assistant backed out of is not saved by a later «تمام»', async () => {
  assert.match((await send(SUP, 'اشتريت دقيق')).reply, /تمام/);
  await send(SUP, 'الكرت غلط');
  assert.match((await send(SUP, 'تمام')).reply, /ما فيه شي ينتظر/);
  assert.strictEqual((await purchases()).length, 0);
});

test('two invoice photos in two messages are read together; new item + new purchase unit are saved', async () => {
  await send(SUP, '', { image_b64: '/9j/AAAA' });
  const r = await send(SUP, '', { image_b64: '/9j/BBBB' });
  assert.match(r.reply, /🆕 سكر ناعم ت/); assert.match(r.reply, /50 كجم/);
  const calls = fs.readFileSync(LOG, 'utf8').trim().split('\n');
  assert.strictEqual((calls[4].match(/"type":"image"/g) || []).length, 2, 'الصورتين مع بعض');
  assert.match((await send(SUP, 'تمام')).reply, /✓ اتسجل/);
  const p = await purchases();
  assert.strictEqual(p.length, 1);
  const items = await call('GET', '/api/items');
  const sugar = items.find(i => i.name === 'سكر ناعم ت');
  assert.ok(sugar, 'الصنف الجديد انضاف'); assert.strictEqual(sugar.unit, 'كجم');
  assert.ok(items.find(i => i.name === 'دقيق ت').units.some(x => x.name === 'كيس' && x.factor === 45), 'وحدة الكيس انحفظت');
  assert.strictEqual(p[0].total, 290);
});

test('supervisor reminds whoever has not closed the count — they get it in private', async () => {
  assert.match((await send(SUP, 'ذكر اللي ما قفلوا')).reply, /فؤاد ت/);
  const r = await send(SUP, 'تمام');
  assert.match(r.reply, /✓ اتسجل/);
  const o = await call('GET', '/api/whatsapp/_outbox');
  assert.ok(o.some(x => x.to === WK && /قفلوا الجرد الله يعافيكم/.test(x.text) && /إبراهيم ت/.test(x.text)));
});

test('owner memory is kept and used next time; WhatsApp bold is a single star', async () => {
  await send(OWN, 'احفظ طريقة كشف حساب دعدع');
  const r = await send(OWN, 'هلا');
  const calls = fs.readFileSync(LOG, 'utf8').trim().split('\n');
  assert.match(calls.at(-1), /كشف حساب دعدع: المجموع ناقص الرصيد السابق/);
  assert.strictEqual(r.reply, 'هلا *نوح*\nملخص\nتمام');
});

test('🟡 a worker suggestion goes to the owner; «موافق N» applies it and tells the worker', async () => {
  const r = await send(WK, 'خلوا إبراهيم يفتح الفول');
  assert.match(r.reply, /وصل اقتراحك/);
  const o = await call('GET', '/api/whatsapp/_outbox');
  const m = o.find(x => x.to === OWN && /💡 اقتراح #(\d+) من فؤاد ت/.test(x.text));
  assert.ok(m, 'وصل لنوح');
  const id = /#(\d+)/.exec(m.text)[1];
  assert.match((await send(OWN, 'موافق ' + id)).reply, /اتنفذ/);
  const sup = (await call('GET', '/api/users')).find(x => x.name === 'إبراهيم ت');
  assert.strictEqual((await call('GET', '/api/items')).find(i => i.name === 'فول ت').opening_user_id, sup.id);
  assert.ok((await call('GET', '/api/whatsapp/_outbox')).some(x => x.to === WK && /نوح وافق/.test(x.text)));
  assert.strictEqual((await call('GET', '/api/suggestions')).rows[0].status, 'done');
});
