'use strict';
// 📹 الكاميرات: جهاز تسجيل وهمي (هيك فيژن ISAPI + Digest) + الجسر الحقيقي => الربط، لقطة الحين، لقطة مع ورقة الطابعة، وتنبيه الإلغاء بالصورة
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const md5 = s => crypto.createHash('md5').update(s).digest('hex');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(300), Buffer.from([0xff, 0xd9])]);
const NONCE = 'abc123', REALM = 'IP Camera(TEST)';
const pics = [];
const nvr = http.createServer((req, res) => {
  const a = String(req.headers.authorization || '');
  const p = k => (a.match(new RegExp(`${k}="?([^",]+)"?`)) || [])[1];
  const ok = /^Digest /.test(a) && p('username') === 'view' &&
    p('response') === md5(`${md5(`view:${REALM}:pw`)}:${NONCE}:${p('nc')}:${p('cnonce')}:auth:${md5(`GET:${p('uri')}`)}`);
  if (!ok) { res.writeHead(401, { 'WWW-Authenticate': `Digest qop="auth", realm="${REALM}", nonce="${NONCE}", stale="FALSE"` }); return res.end(); }
  if (req.url === '/ISAPI/ContentMgmt/InputProxy/channels') return res.end('<?xml version="1.0"?><InputProxyChannelList><InputProxyChannel><id>1</id><name>Cashier</name></InputProxyChannel><InputProxyChannel><id>2</id><name>Kitchen</name></InputProxyChannel></InputProxyChannelList>');
  const m = req.url.match(/^\/ISAPI\/Streaming\/channels\/(\d)01\/picture$/);
  if (m) { pics.push(Number(m[1])); res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(JPEG); }
  res.writeHead(404); res.end();
});

let srv, bridge, B, T, PP, DIR;
const call = async (method, p, body, tok = T) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const until = async (fn, n = 100) => { for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 100)); } throw new Error('ما صار'); };
const print = text => new Promise((resolve, reject) => {
  const s = net.connect(PP, '127.0.0.1'); s.on('error', reject);
  s.on('connect', () => s.end(Buffer.concat([Buffer.from([0x1b, 0x40]), Buffer.from(text + '\n'), Buffer.from([0x1d, 0x56, 0x00])])));
  s.on('close', resolve);
});
const read = r => ({ content: [{ type: 'text', text: JSON.stringify({ ticket_name: 'التذكرة - 9:57 ص', printed_at: '', employee: 'عمار', dining: 'سفري', ...r }) }] });

test.before(async () => {
  await new Promise(r => nvr.listen(0, '127.0.0.1', r));
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-cam-'));
  const fx = path.join(DIR, 'ai.json');
  fs.writeFileSync(fx, JSON.stringify([
    read({ kind: 'order', ticket_no: '06-9', items: [{ name: 'ماء صغير', qty: 1, note: '', product_id: null }] }),
    read({ kind: 'cancel', ticket_no: '06-9', items: [{ name: 'ماء صغير', qty: 1, note: '', product_id: null }] }),
  ]));
  const port = 40000 + Math.floor(Math.random() * 900); B = `http://127.0.0.1:${port}`; PP = port + 1000;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: port, PRINTER_PORT: PP, DATA_DIR: DIR, AI_FIXTURE: fx, WA_TEST_INJECT: '1', CAM_POLL_MS: '800' }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  const me = (await call('GET', '/api/users')).find(x => x.id === 1);
  await call('POST', '/api/users', { id: 1, name: me.name, role: 'owner', pin: '1234', phone: '0500000700' });
  await call('POST', '/api/whatsapp/groups', { groups: [{ id: 'gR@g.us', role: 'restaurant' }] });
});
test.after(() => { if (bridge) bridge.kill(); srv.kill(); nvr.close(); });

test('bridge pairs once, sends channels, snapshots on demand and with each printed slip; cancel alert goes to the owner with the photo', async () => {
  assert.strictEqual((await call('GET', '/api/cam')).linked, false);
  const { code } = await call('POST', '/api/cam/pair');
  const conf = path.join(DIR, 'bridge.json');
  bridge = spawn(process.execPath, [path.join(__dirname, '..', 'deploy', 'bridge.js'), B], {
    env: { ...process.env, CAM_CONFIG: conf, CAM_CODE: code, NVR_URL: `http://127.0.0.1:${nvr.address().port}`, NVR_USER: 'view', NVR_PASS: 'pw' }, stdio: 'ignore' });
  const st = await until(async () => { const r = await call('GET', '/api/cam'); return r.online && r.channels.length === 2 && r; });
  assert.deepStrictEqual(st.channels.map(c => c.name), ['Cashier', 'Kitchen']);
  // الرمز مرة وحدة، وكلمة سر الكاميرات ما وصلت للنظام
  const r2 = await fetch(B + '/api/cam/bridge/hello', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  assert.strictEqual(r2.status, 403);
  const token = JSON.parse(fs.readFileSync(conf, 'utf8')).token;
  assert.ok(!fs.readFileSync(path.join(DIR, 'alsalam.db')).includes(Buffer.from('"pw"')));
  // توكن الجسر ما يفتح غير الجسر
  assert.strictEqual((await fetch(B + '/api/report', { headers: { 'x-bridge-token': token, authorization: 'Bearer ' + token } })).status, 401);

  // الأسماء والأدوار
  await call('POST', '/api/cam/channels', { channels: [{ ch: 1, name: 'الكاشير', role: 'cashier' }, { ch: 2, name: 'المطبخ', role: 'kitchen' }] });
  // اسم الجسر ما يغيّر اللي سمّاه المالك
  await fetch(B + '/api/cam/bridge/channels', { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': token }, body: JSON.stringify({ channels: [{ ch: 1, name: 'Cashier' }] }) });
  assert.strictEqual((await call('GET', '/api/cam')).channels[0].name, 'الكاشير');

  // 🔍 قراءة إعدادات جهاز التسجيل (GET)
  const info = await call('POST', '/api/cam/isapi', { path: '/ISAPI/ContentMgmt/InputProxy/channels' });
  assert.match(info.text || JSON.stringify(info), /Cashier/);

  // 📸 لقطة الحين
  const { id } = await call('POST', '/api/cam/snap', { ch: 2 });
  const img = await fetch(`${B}/api/cam/snaps/${id}/image`, { headers: { authorization: 'Bearer ' + T } });
  assert.strictEqual(img.headers.get('content-type'), 'image/jpeg');
  assert.ok(Buffer.from(await img.arrayBuffer()).equals(JPEG));

  // ورقة طابعة => لقطة من كاميرا الكاشير مربوطة بها، والإلغاء بعد ما انطبعت => للمالك بالصورة
  await print('slip 1');
  await until(async () => (await call('GET', '/api/cam/snaps')).some(s => s.reason === 'print'));
  await print('slip 2');
  const ob = await until(async () => { const o = await call('GET', '/api/whatsapp/_outbox'); return o.find(x => x.image && /انلغت تذكرة #06-9/.test(x.text)) && o; });
  const alert = ob.find(x => /انلغت تذكرة/.test(x.text));
  assert.strictEqual(alert.to, '966500000700'); assert.match(alert.text, /1 ماء صغير/);
  const tk = await until(async () => { const t = await call('GET', '/api/printer/tickets'); return t.tickets.length && t.tickets[0].events.length === 2 && t; });
  assert.ok(tk.tickets[0].events.every(e => e.snap), 'كل ورقة معها لقطة');
  assert.ok(pics.filter(c => c === 1).length >= 2, 'اللقطات من كاميرا الكاشير');

  // 📢 التعريف: رسالة + لقطة وحدة في جروب المطعم
  await call('POST', '/api/cam/announce', { ch: 2, text: 'النظام مربوط بالكاميرات' });
  assert.ok((await call('GET', '/api/whatsapp/_outbox')).some(x => x.to === 'gR@g.us' && x.image && x.text === 'النظام مربوط بالكاميرات'));

  // العامل ما يشوف الكاميرات
  await call('POST', '/api/users', { name: 'عامل كاميرا', role: 'worker', pin: '7171' });
  const wid = (await call('GET', '/api/users')).find(x => x.name === 'عامل كاميرا').id;
  const wt = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: wid, pin: '7171' }) })).json()).token;
  await assert.rejects(call('GET', '/api/cam', null, wt), e => e.status === 403);
  await assert.rejects(call('POST', '/api/cam/snap', { ch: 1 }, wt), e => e.status === 403);

  // فك الربط => الجسر يوقف
  await call('POST', '/api/cam/unlink');
  await until(async () => bridge.exitCode === 1);
});
