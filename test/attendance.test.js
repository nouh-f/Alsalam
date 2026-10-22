'use strict';
// 👋 «بدأت دوامي»: من نت المحل بس (عنوان الجسر)، مرة باليوم، سيلفي يتقارن بصورة الوجه، وجوال واحد لاثنين => تنبيه للمالك
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sharp = require('sharp');

let srv, B, T, PIC, bridgeTok;
const req = async (method, p, body, { tok = T, ip, headers = {} } = {}) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok, ...(ip ? { 'x-forwarded-for': ip } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const login = async (user_id, pin) => (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id, pin }) })).json()).token;
const until = async (fn, n = 100) => { for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 100)); } throw new Error('ما صار'); };
const face = (same, note) => ({ usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify({ same, confidence: 90, note }) }] });

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-att-'));
  const FX = path.join(dir, 'ai.json');
  fs.writeFileSync(FX, JSON.stringify([face('no', 'شخص ثاني')]));
  PIC = 'data:image/jpeg;base64,' + (await sharp({ create: { width: 16, height: 16, channels: 3, background: '#a33' } }).jpeg().toBuffer()).toString('base64');
  const port = 47000 + Math.floor(Math.random() * 900); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir, AI_FIXTURE: FX, WA_TEST_INJECT: '1', CAM_POLL_MS: '200' }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = await login(1, '1234');
  const me = (await req('GET', '/api/users')).find(x => x.id === 1);
  await req('POST', '/api/users', { id: 1, name: me.name, role: 'owner', pin: '1234', phone: '0500000700' });
  await req('POST', '/api/users', { name: 'صابر ح', role: 'worker', pin: '1111' });
  await req('POST', '/api/users', { name: 'باسم ح', role: 'worker', pin: '2222' });
  // الجسر في المحل (نت المحل 5.5.5.5)
  const { code } = await req('POST', '/api/cam/pair');
  bridgeTok = (await (await fetch(B + '/api/cam/bridge/hello', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) })).json()).token;
});
test.after(() => srv.kill());

test('clock in only from the shop network, once a day; face mismatch and a shared phone alert the owner', async () => {
  const users = await req('GET', '/api/users');
  const saber = users.find(u => u.name === 'صابر ح'), basim = users.find(u => u.name === 'باسم ح');
  const tS = await login(saber.id, '1111'), tB = await login(basim.id, '2222');

  // الجسر مو متصل للحين => ما نعرف نت المحل: ينقبل بس ينعلّم «ما تأكد»
  const first = await req('POST', '/api/attendance', { kind: 'in', selfie: PIC, device: 'phoneA' }, { tok: tS, ip: '9.9.9.9' });
  assert.strictEqual(first.net, 'unknown');
  assert.strictEqual(first.face, 'no_ref'); // ما له صورة وجه
  await assert.rejects(req('POST', '/api/attendance', { kind: 'in', selfie: PIC, device: 'phoneA' }, { tok: tS }), /من قبل/);

  // الجسر اتصل من نت المحل
  await fetch(B + '/api/cam/bridge/poll', { headers: { 'x-bridge-token': bridgeTok, 'x-forwarded-for': '5.5.5.5' } });
  // من برا المحل => مرفوض
  await assert.rejects(req('POST', '/api/attendance', { kind: 'in', selfie: PIC, device: 'phoneA' }, { tok: tB, ip: '9.9.9.9' }), /واي فاي المطعم/);
  // بدون سيلفي => مرفوض
  await assert.rejects(req('POST', '/api/attendance', { kind: 'in', device: 'phoneA' }, { tok: tB, ip: '5.5.5.5' }), /صوّر وجهك/);

  // المالك يرفع صورة وجه باسم (والعامل ما يقدر)
  await assert.rejects(req('POST', `/api/users/${basim.id}/face`, { image: PIC }, { tok: tS }), e => e.status === 403);
  await req('POST', `/api/users/${basim.id}/face`, { image: PIC });
  assert.strictEqual((await req('GET', '/api/users')).find(u => u.id === basim.id).has_face, 1);

  // باسم يسجّل من جوال صابر، والوجه مو هو
  const before = (await req('GET', '/api/whatsapp/_outbox')).length;
  const b = await req('POST', '/api/attendance', { kind: 'in', selfie: PIC, device: 'phoneA' }, { tok: tB, ip: '5.5.5.5' });
  assert.strictEqual(b.net, 'shop');
  assert.strictEqual(b.shared_with, 'صابر ح');
  const day = await until(async () => { const d = await req('GET', '/api/attendance'); const p = d.people.find(x => x.user_id === basim.id); return p && p.in.face !== 'pending' && d; });
  const bin = day.people.find(x => x.user_id === basim.id).in;
  assert.strictEqual(bin.face, 'mismatch');
  assert.match(bin.face_note, /شخص ثاني/);
  const msg = await until(async () => (await req('GET', '/api/whatsapp/_outbox')).slice(before).find(m => /باسم ح/.test(m.text)));
  assert.match(msg.text, /نفس الجوال/);
  assert.match(msg.text, /الوجه في السيلفي مو باسم ح/);
  assert.ok(!day.missing.some(u => u.id === 1)); // المالك ما يسجل

  // الخروج بعد الدخول بس
  await req('POST', '/api/attendance', { kind: 'out', selfie: PIC, device: 'phoneA' }, { tok: tS, ip: '5.5.5.5' });
  assert.ok((await req('GET', '/api/attendance/me', null, { tok: tS })).out);
  await assert.rejects(req('POST', '/api/attendance', { kind: 'in', selfie: PIC }, { ip: '5.5.5.5' }), /المالك/);

  // السيلفي للمالك بس، والحضور للمشرف
  assert.strictEqual((await fetch(`${B}/api/attendance/${bin.id}/selfie`, { headers: { authorization: 'Bearer ' + tS } })).status, 403);
  assert.strictEqual((await fetch(`${B}/api/attendance/${bin.id}/selfie`, { headers: { authorization: 'Bearer ' + T } })).status, 200);
  await assert.rejects(req('GET', '/api/attendance', null, { tok: tS }), e => e.status === 403);
  // الصور مو تحت /uploads/ المفتوح
  assert.strictEqual((await fetch(`${B}/uploads/faces`, { headers: { authorization: 'Bearer ' + tS } })).status, 404);
});
