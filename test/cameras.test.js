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
// صورة JPEG حقيقية صغيرة (8×8) — عشان تنفتح لما تنجمع في صورة وحدة
const JPEG = Buffer.from('/9j/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJ4BYz//2Q==', 'base64');
const NONCE = 'abc123', REALM = 'IP Camera(TEST)';
const pics = [];
let FIELD = '<?xml version="1.0"?><FieldDetection><id>2</id><enabled>false</enabled><FieldDetectionRegionList size="2"><FieldDetectionRegion><id>1</id><sensitivityLevel>50</sensitivityLevel><RegionCoordinatesList></RegionCoordinatesList><humanMisinfoFilterEnabled>false</humanMisinfoFilterEnabled></FieldDetectionRegion></FieldDetectionRegionList><humanMisinfoFilterEnabled>false</humanMisinfoFilterEnabled></FieldDetection>';
const streams = []; // alertStream المفتوح من الجسر
// كاميرا ١ رخيصة: «دخول المنطقة» يرفضه (invalidOperation) => «الحركة ٢.٠» بهدف إنسان
let MOTION = '<?xml version="1.0"?><MotionDetection version="2.0"><enabled>true</enabled><regionType>grid</regionType><Grid><rowGranularity>18</rowGranularity><columnGranularity>22</columnGranularity></Grid><MotionDetectionLayout><sensitivityLevel>60</sensitivityLevel><layout><gridMap>' + '0'.repeat(108) + '</gridMap></layout><targetType>human,vehicle</targetType></MotionDetectionLayout></MotionDetection>';
const emit = (ch, type = 'fielddetection') => { for (const s of streams) s.write(`--boundary\r\nContent-Type: application/xml\r\n\r\n<EventNotificationAlert><channelID>${ch}</channelID><eventType>${type}</eventType><eventState>active</eventState></EventNotificationAlert>\r\n`); };
const nvr = http.createServer((req, res) => {
  const a = String(req.headers.authorization || '');
  const p = k => (a.match(new RegExp(`${k}="?([^",]+)"?`)) || [])[1];
  const ok = /^Digest /.test(a) && p('username') === 'view' &&
    p('response') === md5(`${md5(`view:${REALM}:pw`)}:${NONCE}:${p('nc')}:${p('cnonce')}:auth:${md5(`${req.method}:${p('uri')}`)}`);
  if (!ok) { res.writeHead(401, { 'WWW-Authenticate': `Digest qop="auth", realm="${REALM}", nonce="${NONCE}", stale="FALSE"` }); return res.end(); }
  if (req.url === '/ISAPI/System/deviceInfo') return res.end('<DeviceInfo><model>TEST</model></DeviceInfo>');
  if (req.url === '/ISAPI/Smart/FieldDetection/2') {
    if (req.method === 'PUT') { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { FIELD = b; res.end('<ResponseStatus><statusCode>1</statusCode></ResponseStatus>'); }); return; }
    return res.end(FIELD);
  }
  if (req.url === '/ISAPI/Smart/FieldDetection/1') {
    if (req.method === 'PUT') { req.resume(); res.writeHead(403); return res.end('<ResponseStatus><statusCode>4</statusCode><statusString>Invalid Operation</statusString><subStatusCode>invalidOperation</subStatusCode></ResponseStatus>'); }
    return res.end(FIELD.replace('<id>2</id>', '<id>1</id>'));
  }
  if (req.url === '/ISAPI/System/Video/inputs/channels/1/motionDetection') {
    if (req.method === 'PUT') { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { MOTION = b; res.end('<ResponseStatus><statusCode>1</statusCode></ResponseStatus>'); }); return; }
    return res.end(MOTION);
  }
  if (req.url === '/ISAPI/Event/notification/alertStream') { res.writeHead(200, { 'content-type': 'multipart/mixed; boundary=boundary' }); streams.push(res); return; }
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
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
    { content: [{ type: 'text', text: JSON.stringify({ inspector: true, confidence: 90, note: 'عند ثلاجة العرض' }) }] }, // ⚠️ إجادة
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
test.after(() => { for (const s of streams) s.destroy(); if (bridge) bridge.kill(); srv.kill(); nvr.close(); });

test('bridge pairs once, sends channels, snapshots on demand and with each printed slip; cancel alert goes to the owner with the photo', async () => {
  assert.strictEqual((await call('GET', '/api/cam')).linked, false);
  const { code } = await call('POST', '/api/cam/pair');
  const conf = path.join(DIR, 'bridge.json');
  // ffmpeg وهمي: يسجّل الرابط ويطلع صورة (والوقت 03:00 ما فيه تسجيل)
  const ff = path.join(DIR, 'ffmpeg'), ffLog = path.join(DIR, 'ff.log');
  fs.writeFileSync(ff, `#!${process.execPath}\nconst a = process.argv.slice(2), u = a[a.indexOf('-i') + 1];\nrequire('fs').appendFileSync(${JSON.stringify(ffLog)}, u + '\\n');\nif (/T030000Z/.test(u)) { process.stderr.write('404 Not Found'); process.exit(1); }\nprocess.stdout.write(Buffer.from(${JSON.stringify(JPEG.toString('base64'))}, 'base64'));\n`);
  fs.chmodSync(ff, 0o755);
  bridge = spawn(process.execPath, [path.join(__dirname, '..', 'deploy', 'bridge.js'), B], {
    env: { ...process.env, CAM_CONFIG: conf, CAM_CODE: code, NVR_URL: `http://127.0.0.1:${nvr.address().port}`, NVR_USER: 'view', NVR_PASS: 'pw', BRIDGE_FFMPEG: ff }, stdio: 'ignore' });
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
  await assert.rejects(call('POST', '/api/cam/playback', { ch: 1, from: '2026-10-22T11:10' }, wt), e => e.status === 403);

  // ⏪ شريط من التسجيل: ٣ لقطات كل دقيقتين — الوقت بتوقيت السعودية يروح لجهاز التسجيل زي ما هو
  const pb = await call('POST', '/api/cam/playback', { ch: 2, from: '2026-10-22T11:10', every: 2, count: 3 });
  const done = await until(async () => { const r = await call('GET', '/api/cam/playback/' + pb.ref); return r.snaps.length === 3 && r; });
  assert.deepStrictEqual(done.snaps.map(x => x.pb_at), ['2026-10-22T11:10:00', '2026-10-22T11:12:00', '2026-10-22T11:14:00']);
  const urls = fs.readFileSync(ffLog, 'utf8').trim().split('\n');
  assert.match(urls[0], /^rtsp:\/\/view:pw@127\.0\.0\.1:554\/Streaming\/tracks\/201\?starttime=20261022T111000Z$/);
  // وقت ما فيه تسجيل => سبب واضح، وكلمة السر ما تطلع
  const bad = await call('POST', '/api/cam/playback', { ch: 2, from: '2026-10-22 03:00' });
  const br = await until(async () => { const r = await call('GET', '/api/cam/playback/' + bad.ref); return r.failed && r; });
  assert.match(br.errors[0], /ما فيه تسجيل/);
  await assert.rejects(call('POST', '/api/cam/playback', { ch: 2, from: '2099-01-01T10:00' }), /ما جا/);

  // 📹 «صور لي جميع زوايا المطعم» في الجروب من المالك/المشرف => صورة وحدة فيها كل الكاميرات في نفس الجروب
  const ob0 = (await call('GET', '/api/whatsapp/_outbox')).length;
  await call('POST', '/api/whatsapp/_inject', { id: 'cw1', phone: '0500000700', chat: 'gR@g.us', isGroup: true, groupName: 'المطعم', text: 'صور لي جميع زوايا المطعم' });
  const shot = await until(async () => (await call('GET', '/api/whatsapp/_outbox')).slice(ob0).find(x => x.to === 'gR@g.us' && x.image));
  assert.match(shot.text, /كل الكاميرات/);
  // في الخاص: «صوّر الكاشير» => الكاشير بس
  await call('POST', '/api/whatsapp/_inject', { id: 'cw2', phone: '0500000700', text: 'صوّر الكاشير' });
  const one = await until(async () => (await call('GET', '/api/whatsapp/_outbox')).slice(ob0).find(x => x.to === '966500000700' && x.image));
  assert.match(one.text, /الكاشير/); assert.doesNotMatch(one.text, /المطبخ/);

  // 🧍 كشف الإنسان في الجهاز (المالك): منطقة + فلتر الإنسان — والكتابة محصورة على هالإعداد
  const det = await call('POST', '/api/cam/detect', { ch: 2 });
  assert.strictEqual(det.enabled, true);
  assert.match(FIELD, /<positionX>470<\/positionX>/); assert.match(FIELD, /<humanMisinfoFilterEnabled>true/);
  await assert.rejects(call('POST', '/api/cam/detect', { ch: 2 }, wt), e => e.status === 403);
  // 🔔 الجهاز قال «دخل شخص» في كاميرا ٢ => فحص وحدة => إجادة => الجروب
  const ob2 = (await call('GET', '/api/whatsapp/_outbox')).length;
  await call('POST', '/api/cam/inspect-watch', { on: true, mode: 'events', from: 0, to: 24 });
  await until(async () => streams.length > 0);
  emit(2);
  await until(async () => (await call('GET', '/api/whatsapp/_outbox')).slice(ob2).some(x => x.to === 'gR@g.us' && x.image && /إجادة في المحل/.test(x.text)));
  assert.ok((await call('GET', '/api/cam/inspect-watch')).events >= 1);

  // ⚠️ «إجادة في المحل»: فحص كاميرات الكاشير => صورة وتنبيه في جروب المطعم ولنوح
  const ob1 = (await call('GET', '/api/whatsapp/_outbox')).length;
  const iw = await call('POST', '/api/cam/inspect-watch', { on: true, every: 20, test: true, send: true });
  assert.strictEqual(iw.on, true); assert.strictEqual(iw.every, 20);
  assert.strictEqual(iw.test.inspector, true);
  const out = (await call('GET', '/api/whatsapp/_outbox')).slice(ob1);
  assert.ok(out.some(x => x.to === 'gR@g.us' && x.image && /إجادة في المحل/.test(x.text)));
  assert.ok(out.some(x => x.to === '966500000700' && x.image));
  await assert.rejects(call('GET', '/api/cam/inspect-watch', null, wt), e => e.status === 403);

  // 🧍 كاميرا ترفض «دخول المنطقة» => «الحركة ٢.٠»: الأعمدة من النص لليمين، والهدف «إنسان» بس
  const mo = await call('POST', '/api/cam/detect', { ch: 1, x1: 500 });
  assert.strictEqual(mo.kind, 'motion'); assert.strictEqual(mo.enabled, true);
  assert.match(MOTION, /<gridMap>(001ffc){18}<\/gridMap>/); assert.match(MOTION, /<targetType>human<\/targetType>/);
  assert.strictEqual((await call('POST', '/api/cam/detect', { ch: 2, on: false })).enabled, false);
  // أحداث الحركة: من كاميرا ١ (مراقبة) تنحسب، ومن كاميرا ٢ (مو مراقبة) لا
  await new Promise(r => setTimeout(r, 800)); // الجسر ياخذ القائمة مع السحب الجاي
  const e0 = (await call('GET', '/api/cam/inspect-watch')).events;
  emit(2, 'VMD'); emit(1, 'VMD');
  await until(async () => (await call('GET', '/api/cam/inspect-watch')).events === e0 + 1);
  await new Promise(r => setTimeout(r, 500));
  assert.strictEqual((await call('GET', '/api/cam/inspect-watch')).events, e0 + 1);
  await call('POST', '/api/cam/inspect-watch', { on: false });

  // فك الربط => الجسر يوقف
  await call('POST', '/api/cam/unlink');
  await until(async () => bridge.exitCode === 1);
});
