'use strict';
// 📱 الواتساب: العامل يرسل الجرد => الملخص => «تمام» => يتسجل باسمه
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const sent = [], stt = [];
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && /\/audio\/transcriptions$/.test(req.url)) { stt.push({ auth: req.headers.authorization, len: b.length }); return res.end(JSON.stringify({ text: 'آخر الدوام فول ٣' })); }
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
    env: { ...process.env, PORT: port, DATA_DIR: dir, AI_FIXTURE: FX, WA_API_BASE: `http://127.0.0.1:${mock.address().port}`, WA_TEST_INJECT: '1', STT_API_BASE: `http://127.0.0.1:${mock.address().port}`, WA_TEST_MEMBERS: JSON.stringify([{ phone: '966500000201', name: 'سامي سحب' }, { phone: '966500000202', name: '' }, { phone: '966500000102', name: 'صادق' }]) }, stdio: 'inherit' });
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
  assert.strictEqual(r.closing, null, 'ما يتسجل قبل «تمام»');

  // نفس الرسالة مرة ثانية من ميتا (إعادة إرسال) => تنتجاهل
  await hook('966500000001', 'تمام', { id: 'wamid.same' });
  await waitSent(3);
  await hook('966500000001', 'تمام', { id: 'wamid.same' });
  assert.match(sent[2].text.body, /✓ اتسجل: جرد آخر الدوام/);
  r = (await call('GET', '/api/board?date=' + today)).rows.find(x => x.item_id === item);
  assert.strictEqual(r.closing, 3);
  assert.strictEqual(r.closing_user, 'عامل واتس');
  await new Promise(res => setTimeout(res, 300));
  assert.strictEqual(sent.length, 3, 'المكرر ما ينرد عليه');

  // العامل ما يقدر يسجل مشتريات (نفس صلاحياته في البرنامج)
  await hook('966500000001', 'اشتريت فول بعشرة');
  assert.doesNotMatch((await waitSent(4)).text.body, /رد \*تمام\*/);
  await hook('966500000001', 'تمام');
  assert.doesNotMatch((await waitSent(5)).text.body, /اتسجل/, 'ما فيه كرت ينتظر');

  const st = await call('GET', '/api/whatsapp/status');
  assert.ok(st.ready); assert.ok(st.log.some(l => l.dir === 'in' && l.name === 'عامل واتس'));
  await assert.rejects(call('GET', '/api/whatsapp/status', null, (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: wid, pin: '4321' }) })).json()).token), e => e.status === 403);
});

test('groups: a supervisor\'s «خصم» goes to the owner to confirm, then payroll + the worker is told; requests go to Zakaria; short confirmations in the group', async () => {
  const fx = obj => fs.writeFileSync(FX, JSON.stringify([say(JSON.stringify(obj))]));
  const owner = (await call('GET', '/api/users')).find(x => x.id === 1);
  await call('POST', '/api/users', { id: 1, name: owner.name, role: 'owner', pin: '1234', phone: '0500000100' });
  const { id: sup } = await call('POST', '/api/users', { name: 'إبراهيم قروب', role: 'supervisor', pin: '2222', phone: '0500000101' });
  const { id: wk } = await call('POST', '/api/users', { name: 'صادق قروب', role: 'worker', pin: '3333', phone: '0500000102' });
  const { id: pu } = await call('POST', '/api/users', { name: 'زكريا قروب', role: 'purchaser', pin: '4444', phone: '0500000103' });
  await call('POST', '/api/whatsapp/groups', { groups: [{ id: 'g1@g.us', role: 'restaurant' }, { id: 'g2@g.us', role: '' }] });
  const n0 = sent.length;
  const inject = (phone, text, chat = 'g1@g.us') => call('POST', '/api/whatsapp/_inject', { id: 'gm' + (++mid), phone, chat, isGroup: true, groupName: 'جروب المطعم', text });

  fx({ deductions: [{ employee: 'صادق قروب', amount: 50, reason: 'تأخير' }], requests: [] });
  await inject('966500000101', 'خصم صادق 50 تأخير');
  const toOwner = await waitSent(n0 + 1);
  assert.strictEqual(toOwner.to, '966500000100'); assert.match(toOwner.text.body, /خصم صادق قروب 50/); assert.match(toOwner.text.body, /تمام/);
  // عامل يكتب خصم => يتجاهل؛ قروب مو مفعّل => يتجاهل
  await inject('966500000102', 'خصم إبراهيم 100');
  await inject('966500000101', 'خصم صادق 70', 'g2@g.us');
  await new Promise(r => setTimeout(r, 300));
  assert.strictEqual(sent.length, n0 + 1);
  assert.ok(sent.every(x => !/@g\.us/.test(x.to)), 'ما يرسل في القروب أبدًا');

  // المالك يرد «تمام» => الرواتب + رسالة للعامل
  await hook('966500000100', 'تمام');
  await waitSent(n0 + 3);
  const tail = sent.slice(n0 + 1);
  assert.ok(tail.some(x => x.to === '966500000102' && /انخصم عليك 50 ريال — تأخير/.test(x.text.body)), 'العامل انبلغ');
  assert.ok(tail.some(x => x.to === '966500000100' && /✓ اتسجل: خصم صادق قروب 50/.test(x.text.body)));
  const pr = (await call('GET', '/api/payroll')).find(x => x.id === wk);
  assert.ok(pr.entries.some(e => e.type === 'deduct' && e.amount === 50 && /تأخير/.test(e.note)));

  // طلبات => زكريا
  // طلبات: العادي يتجمع (ما يوصل على طول)، المستعجل يوصل على طول
  fx({ deductions: [], requests: [{ item: 'طماطم', qty: '2 كرتون', urgent: false }, { item: 'خبز', qty: '', urgent: false }] });
  await inject('966500000102', 'ناقص طماطم كرتونين وخبز');
  fx({ deductions: [], requests: [{ item: 'غاز', qty: '', urgent: true }, { item: 'طماطم', qty: 'كرتون', urgent: false }] });
  await inject('966500000101', 'الغاز خلص ضروري، وطماطم كرتون');
  const z = await waitSent(n0 + 4);
  assert.strictEqual(z.to, '966500000103'); assert.match(z.text.body, /🚨 مستعجل/); assert.match(z.text.body, /غاز/); assert.doesNotMatch(z.text.body, /طماطم/);
  // القائمة (الحين بدل وقتها): نفس الصنف ينجمع
  const fl = await call('POST', '/api/whatsapp/requests/send', {});
  assert.strictEqual(fl.items, 2);
  const list = await waitSent(n0 + 5);
  assert.strictEqual(list.to, '966500000103'); assert.match(list.text.body, /• طماطم — 2 كرتون \+ كرتون \(صادق قروب، إبراهيم قروب\)/); assert.match(list.text.body, /• خبز \(صادق قروب\)/);
  assert.strictEqual((await call('POST', '/api/whatsapp/requests/send', {})).items, 0, 'ما تتكرر');
  // يكتب في القروب: تأكيد الخصم والطلبات
  const ob = await call('GET', '/api/whatsapp/_outbox');
  assert.ok(ob.some(x => x.to === 'g1@g.us' && x.text === '✓ اتسجل خصم صادق قروب 50 ريال — تأخير'), JSON.stringify(ob));
  assert.ok(ob.some(x => x.to === 'g1@g.us' && /📝 انضاف للقائمة: طماطم 2 كرتون، خبز/.test(x.text)), JSON.stringify(ob));
  assert.ok(ob.some(x => x.to === 'g1@g.us' && /✓ وصل المستعجل لـزكريا قروب: غاز/.test(x.text)));
  assert.ok(ob.some(x => x.to === 'g1@g.us' && /✓ راحت قائمة الطلبات لـزكريا قروب \(2 صنف\)/.test(x.text)));
  assert.ok(ob.every(x => x.to === 'g1@g.us'), 'القروب المتجاهل ما ينكتب فيه');
  assert.ok(sup && pu);
});

test('«يلسعهم»: who has not counted gets named in the restaurant group — once a day; off switch', async () => {
  await call('POST', '/api/settings', { opening_deadline_hour: '4', day_start_hour: '4' }); // الموعد عدّى
  const { id: lazy } = await call('POST', '/api/users', { name: 'فؤاد كسلان', role: 'worker', pin: '8888' });
  const { id: it } = await call('POST', '/api/items', { name: 'فلافل لسعة', unit: 'صحن', daily: 1, kind: 'prepared' });
  await call('POST', '/api/responsibility', { item_id: it, user_id: lazy, opener_id: '' });
  const before = (await call('GET', '/api/whatsapp/_outbox')).length;
  const r1 = await call('POST', '/api/whatsapp/nudge', {});
  assert.ok(r1.sent.some(t => /فؤاد كسلان/.test(t) && /أول اليوم/.test(t)), JSON.stringify(r1.sent));
  const ob = await call('GET', '/api/whatsapp/_outbox');
  assert.ok(ob.slice(before).every(x => x.to === 'g1@g.us'));
  assert.deepStrictEqual((await call('POST', '/api/whatsapp/nudge', {})).sent, [], 'مرة وحدة في اليوم');
  assert.ok((await call('POST', '/api/whatsapp/nudge', { force: true })).sent.length, '«جرّب الحين» يرسل');
  // النقص: بالكمية بس — بدون مبالغ (العمال ما لهم في الفلوس)
  const yday = (() => { const x = new Date(today + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); })();
  const { id: kb } = await call('POST', '/api/items', { name: 'كبدة لسعة', unit: 'كجم', daily: 1, kind: 'raw', cost: 40, sale_value: 40 });
  await call('POST', '/api/responsibility', { item_id: kb, user_id: lazy, opener_id: '' });
  await call('POST', '/api/count', { date: yday, item_id: kb, phase: 'opening', qty: 10 });
  await call('POST', '/api/count', { date: yday, item_id: kb, phase: 'closing', qty: 8 });
  const sh = (await call('POST', '/api/whatsapp/nudge', { force: true })).sent.find(t => /نقص أمس/.test(t));
  assert.ok(sh && /كبدة لسعة: 2 كجم — فؤاد كسلان/.test(sh), sh);
  assert.doesNotMatch(sh, /ريال/);
  // المالك (جواله مسجل) يوصله نفس النقص بالمبلغ في الخاص — والعامل لا
  const priv = sent.filter(x => /بالمبلغ — لك بس/.test(x.text.body));
  assert.ok(priv.some(x => x.to === '966500000100' && /كبدة لسعة: 2 كجم = 80 ريال — فؤاد كسلان/.test(x.text.body)), JSON.stringify(priv.map(x => x.to)));
  assert.ok(priv.every(x => x.to !== '966500000102'), 'العامل ما يوصله المبلغ');
  await call('POST', '/api/settings', { wa_nudge: '0' });
  await call('POST', '/api/count', { date: today, item_id: it, phase: 'opening', qty: 1 }).catch(() => {});
  assert.deepStrictEqual((await call('POST', '/api/whatsapp/nudge', {})).sent, [], 'المفتاح طافي');
});

test('📲 pull staff phones from the restaurant group members', async () => {
  const { id: sami } = await call('POST', '/api/users', { name: 'سامي سحب', role: 'worker', pin: '9191' });
  const r = await call('GET', '/api/whatsapp/members');
  const m1 = r.members.find(x => x.phone === '966500000201'), m3 = r.members.find(x => x.phone === '966500000102');
  assert.strictEqual(m1.suggest, sami, 'الاسم في واتساب => الموظف');
  assert.ok(m3.user_id, 'الرقم مسجل من قبل => ✓');
  const res = await call('POST', '/api/whatsapp/members', { links: [{ user_id: sami, phone: '966500000201' }, { user_id: sami, phone: '966500000202' }, { user_id: 1, phone: '966500000102' }] });
  assert.deepStrictEqual(res.saved, ['سامي سحب']);
  assert.strictEqual(res.failed.length, 2, JSON.stringify(res.failed));
  assert.strictEqual((await call('GET', '/api/users')).find(x => x.id === sami).phone, '966500000201');
});

test('🎤 voice notes: off => asks to type; on => transcribed and handled like text («🎤 سمعت»)', async () => {
  const voice = () => call('POST', '/api/whatsapp/_inject', { id: 'v' + (++mid), phone: '966500000001', chat: '966500000001', audio_b64: Buffer.from('OggS-fake').toString('base64') });
  let n = sent.length;
  await voice();
  assert.match((await waitSent(n + 1)).text.body, /الرسائل الصوتية مو مفعّلة/);
  await call('POST', '/api/settings', { stt_key: 'sk-test-voice' });
  assert.match((await call('GET', '/api/settings')).stt_key, /^••••/);
  fs.writeFileSync(FX, JSON.stringify([say('تمام، وش تبغى أسجل؟')]));
  n = sent.length;
  await voice();
  const r = await waitSent(n + 1);
  assert.match(r.text.body, /^🎤 سمعت: «آخر الدوام فول ٣»/);
  assert.strictEqual(stt.at(-1).auth, 'Bearer sk-test-voice');
  const st = await call('GET', '/api/whatsapp/status');
  assert.ok(st.log.some(l => l.dir === 'in' && /^🎤 آخر الدوام فول ٣/.test(l.text)));
});

test('🛠️ work issues from the group: logged; a supervisor\'s complaint about a worker => reminder, then warning in private, third = «قرصة إذن» (small auto deduction, owner told)', async () => {
  const fx = obj => fs.writeFileSync(FX, JSON.stringify([say(JSON.stringify(obj))]));
  const inject = (phone, text) => call('POST', '/api/whatsapp/_inject', { id: 'is' + (++mid), phone, chat: 'g1@g.us', isGroup: true, groupName: 'جروب المطعم', text });
  const late = { deductions: [], requests: [], issues: [{ employee: 'صادق قروب', type: 'late', summary: 'صادق تأخر ساعة الصبح' }] };
  let n = sent.length;
  fx(late); await inject('966500000101', 'صادق تأخر اليوم ساعة');
  let m = await waitSent(n + 1); assert.strictEqual(m.to, '966500000102'); assert.match(m.text.body, /انتبه لـ«تأخير»/);
  fx(late); await inject('966500000101', 'صادق تأخر مرة ثانية');
  m = await waitSent(n + 2); assert.strictEqual(m.to, '966500000102'); assert.match(m.text.body, /ثاني مرة/);
  fx(late); await inject('966500000101', 'صادق تأخر للمرة الثالثة');
  await waitSent(n + 4);
  const third = sent.slice(n + 2);
  assert.ok(third.some(x => x.to === '966500000102' && /انخصم عليك 20 ريال — اعتبرها قرصة إذن/.test(x.text.body)), JSON.stringify(third.map(x => x.text.body)));
  assert.ok(third.some(x => x.to === '966500000100' && /🤏 قرصة إذن: صادق قروب — «تأخير» تكررت 3 مرات/.test(x.text.body)));
  const pay = (await call('GET', '/api/payroll')).find(x => x.name === 'صادق قروب');
  assert.ok(pay.entries.some(e => e.type === 'deduct' && e.amount === 20 && /قرصة إذن/.test(e.note)));
  // الرابعة: ضعف المبلغ
  fx(late); await inject('966500000101', 'صادق تأخر الرابعة');
  await waitSent(n + 6);
  assert.ok((await call('GET', '/api/payroll')).find(x => x.name === 'صادق قروب').entries.some(e => e.type === 'deduct' && e.amount === 40));
  // عامل يشتكي على زميله => يتسجل بس؛ ومشكلة عامة (جهاز) => تتسجل بس
  n = sent.length;
  fx({ deductions: [], requests: [], issues: [{ employee: 'إبراهيم قروب', type: 'behavior', summary: 'إبراهيم صرخ علي' }] }); await inject('966500000102', 'إبراهيم صرخ علي');
  fx({ deductions: [], requests: [], issues: [{ employee: null, type: 'equipment', summary: 'الثلاجة خربانة' }] }); await inject('966500000101', 'الثلاجة خربانة');
  await new Promise(r => setTimeout(r, 300));
  assert.strictEqual(sent.length, n, 'ما ينرسل لأحد');
  const iss = await call('GET', '/api/issues');
  assert.strictEqual(iss.rows.filter(x => x.type === 'late').length, 4);
  assert.ok(iss.rows.some(x => x.type === 'equipment' && x.step === 0) && iss.rows.some(x => x.type === 'behavior' && x.step === 0));
  // تقرير الأسبوع للمالك
  const wk = await call('POST', '/api/whatsapp/weekly', {});
  assert.ok(wk.report.some(l => /تأخير: 4 \(صادق قروب 4\)/.test(l)), JSON.stringify(wk.report));
  assert.ok(sent.some(x => x.to === '966500000100' && /📊 تقرير الأسبوع/.test(x.text.body)));
});
