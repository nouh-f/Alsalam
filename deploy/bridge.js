#!/usr/bin/env node
'use strict';
// 📹 جسر الكاميرات — يشتغل على جوال أندرويد قديم في المحل (Termux) أو أي جهاز على شبكة المحل.
// يكلم جهاز التسجيل (هيك فيژن، ISAPI) محليًا، ويرسل اللقطات لنظام مطعم السلام. اتصال طالع بس.
// كلمة سر الكاميرات تنحفظ في هذا الجهاز بس — ما تروح للنظام.
// وكمان «طابعة المحل»: الكاشير يطبع أوراق المطبخ على هذا الجهاز (منفذ 9100 في شبكة المحل)، والأوراق تنحفظ هنا
// وترتفع للنظام — لو فصل النت تقعد لين يرجع وترتفع بوقتها الأصلي.
// التشغيل: node bridge.js https://عنوان-النظام   (--cams يعيد سؤال جهاز التسجيل)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const readline = require('node:readline');
const net = require('node:net');

const CONF = process.env.CAM_CONFIG || path.join(os.homedir(), '.alsalam-cam.json');
const log = (...a) => console.log(new Date().toLocaleTimeString('en-GB'), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const md5 = s => crypto.createHash('md5').update(s).digest('hex');

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch { /* أول مرة */ }
const save = () => { fs.writeFileSync(CONF, JSON.stringify(cfg, null, 1)); try { fs.chmodSync(CONF, 0o600); } catch { /* */ } };

async function ask(q, def = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise(r => rl.question(`${q}${def ? ` [${def}]` : ''}: `, r));
  rl.close();
  return String(a || def).trim();
}

// ===== جهاز التسجيل (HTTP + Digest) =====
function raw(url, headers = {}, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url), mod = u.protocol === 'https:' ? https : http;
    if (body != null) headers = { ...headers, 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(body) };
    const rq = mod.request(u, { method, headers, timeout: 15000, rejectUnauthorized: false }, res => {
      const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(ch) }));
    });
    rq.on('timeout', () => rq.destroy(new Error('جهاز التسجيل ما رد')));
    rq.on('error', reject); rq.end(body != null ? body : undefined);
  });
}
let dig = null, nc = 0;
function authHeader(uri, method = 'GET') {
  if (!dig) return {};
  if (dig.basic) return { Authorization: 'Basic ' + Buffer.from(`${cfg.nvr_user}:${cfg.nvr_pass}`).toString('base64') };
  const ha1 = md5(`${cfg.nvr_user}:${dig.realm}:${cfg.nvr_pass}`), ha2 = md5(`${method}:${uri}`);
  const n = (++nc).toString(16).padStart(8, '0'), cn = crypto.randomBytes(8).toString('hex');
  const resp = dig.qop ? md5(`${ha1}:${dig.nonce}:${n}:${cn}:auth:${ha2}`) : md5(`${ha1}:${dig.nonce}:${ha2}`);
  return { Authorization: `Digest username="${cfg.nvr_user}", realm="${dig.realm}", nonce="${dig.nonce}", uri="${uri}", ${dig.qop ? `qop=auth, nc=${n}, cnonce="${cn}", ` : ''}response="${resp}"${dig.opaque ? `, opaque="${dig.opaque}"` : ''}` };
}
async function nvr(uri, method = 'GET', body = null) {
  for (let i = 0; i < 2; i++) {
    const r = await raw(cfg.nvr + uri, authHeader(uri, method), method, body);
    if (r.status !== 401) {
      if (r.status >= 400) { // سبب الرفض من الجهاز (statusString / subStatusCode) يساعد نعرف وش الغلط
        const t = r.body.toString('utf8'), why = ['statusString', 'subStatusCode', 'errorMsg'].map(k => (t.match(new RegExp(`<${k}>([^<]*)<`)) || [])[1]).filter(Boolean).join(' / ');
        throw new Error(`جهاز التسجيل رد ${r.status}${why ? ` (${why})` : ''}`);
      }
      return r.body;
    }
    const h = String(r.headers['www-authenticate'] || '');
    if (/^basic/i.test(h)) { if (dig && dig.basic) break; dig = { basic: true }; continue; }
    const p = k => (h.match(new RegExp(`${k}="?([^",]+)"?`, 'i')) || [])[1] || '';
    const stale = dig && !dig.basic && /stale="?true/i.test(h);
    if (dig && !dig.basic && !stale && i > 0) break;
    dig = { realm: p('realm'), nonce: p('nonce'), opaque: p('opaque'), qop: /auth/i.test(p('qop')) }; nc = 0;
  }
  throw new Error('اسم المستخدم أو كلمة سر جهاز التسجيل غلط');
}
async function channels() {
  const xml = s => [...s.matchAll(/<(?:InputProxyChannel|VideoInputChannel)\b[^>]*>([\s\S]*?)<\/(?:InputProxyChannel|VideoInputChannel)>/g)]
    .map(m => ({ ch: Number((m[1].match(/<id>(\d+)<\/id>/) || [])[1]), name: ((m[1].match(/<name>([^<]*)<\/name>/) || [])[1] || '').trim() })).filter(c => c.ch > 0);
  for (const uri of ['/ISAPI/ContentMgmt/InputProxy/channels', '/ISAPI/System/Video/inputs/channels']) {
    try { const l = xml((await nvr(uri)).toString('utf8')); if (l.length) return l; } catch (e) { if (/كلمة سر/.test(e.message)) throw e; }
  }
  return [];
}

// ✍️ الكتابة في جهاز التسجيل: «كشف دخول المنطقة/عبور الخط» بس (المالك فعّلها للتنبيهات) — ولا شي غيرها
const PUT_OK = p => /^\/ISAPI\/Smart\/(FieldDetection|LineDetection)\/\d+$/.test(p) || /^\/ISAPI\/System\/Video\/inputs\/channels\/\d+\/motionDetection$/.test(p);

// 🔔 أحداث جهاز التسجيل (شخص دخل المنطقة…) => للنظام على طول. اتصال واحد مفتوح (alertStream)، يرجع لو انقطع
// «vmd» = الحركة (٢.٠ بهدف «إنسان») — تجي من كل الكاميرات وتتكرر، فناخذها بس من الكاميرات اللي النظام يراقبها
const EVENTS = /^(fielddetection|linedetection|vmd)$/i;
let watch = new Set();
function events() {
  if (!cams()) return;
  const uri = '/ISAPI/Event/notification/alertStream';
  const again = ms => setTimeout(events, ms);
  const last = new Map();
  (async () => {
    try { await nvr('/ISAPI/System/deviceInfo'); } catch { return again(30000); } // يجهّز الـ Digest
    const u = new URL(cfg.nvr + uri), mod = u.protocol === 'https:' ? https : http;
    const rq = mod.request(u, { method: 'GET', headers: authHeader(uri), rejectUnauthorized: false }, res => {
      if (res.statusCode !== 200) { res.resume(); return again(res.statusCode === 401 ? 5000 : 30000); }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => {
        buf += c;
        let m;
        while ((m = /<EventNotificationAlert[\s\S]*?<\/EventNotificationAlert>/.exec(buf))) {
          buf = buf.slice(m.index + m[0].length);
          const x = k => (m[0].match(new RegExp(`<${k}>([^<]*)</${k}>`)) || [])[1] || '';
          const type = x('eventType'), ch = Number(x('channelID') || x('dynChannelID')), state = x('eventState');
          if (!EVENTS.test(type) || state === 'inactive' || !ch) continue;
          if (/^vmd$/i.test(type) && !watch.has(ch)) continue;
          if (Date.now() - (last.get(ch) || 0) < 3000) continue; last.set(ch, Date.now());
          api('POST', '/api/cam/bridge/event', { ch, type: type.toLowerCase() }).catch(() => {});
        }
        if (buf.length > 200000) buf = buf.slice(-20000);
      });
      res.on('end', () => again(2000)); res.on('error', () => again(5000));
    });
    rq.on('error', () => again(10000)); rq.end();
  })();
}

// ⏪ لقطة من التسجيل (RTSP playback) — ffmpeg ياخذ صورة وحدة. قراءة بس: ما يمسح ولا يغيّر شي
// الوقت يجي بتوقيت السعودية (نفس ساعة جهاز التسجيل)، وهيك فيژن يبغاه YYYYMMDDTHHMMSSZ
const FFMPEG = process.env.BRIDGE_FFMPEG || 'ffmpeg';
// 🕰️ ساعة الجهاز رجعت يوم => فيه تسجيلين بنفس الوقت (أمس واليوم)، والتشغيل العادي يجيب الأقدم.
// «~new» = ندوّر الملفات اللي تغطي هالوقت ونشغّل الأحدث (اسم الملف رقمه أكبر = انكتب بعد)
async function newestSegment(ch, when) {
  const at = Date.parse(when + 'Z'), iso = ms => new Date(ms).toISOString().slice(0, 19) + 'Z';
  const q = `<?xml version="1.0" encoding="UTF-8"?><CMSearchDescription><searchID>${require('node:crypto').randomUUID()}</searchID><trackList><trackID>${ch}01</trackID></trackList><timeSpanList><timeSpan><startTime>${iso(at - 120e3)}</startTime><endTime>${iso(at + 120e3)}</endTime></timeSpan></timeSpanList><maxResults>50</maxResults><searchResultPostion>0</searchResultPostion><metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList></CMSearchDescription>`;
  let x; try { x = (await nvr('/ISAPI/ContentMgmt/search', 'POST', q)).toString('utf8'); } catch (e) { throw new Error('البحث في التسجيل رفض: ' + e.message); }
  const segs = [...x.matchAll(/<searchMatchItem>([\s\S]*?)<\/searchMatchItem>/g)].map(m => {
    const g = k => ((m[1].match(new RegExp(`<${k}>([^<]*)</${k}>`)) || [])[1] || '');
    const uri = g('playbackURI').replace(/&amp;/g, '&');
    return { from: Date.parse(g('startTime')), to: Date.parse(g('endTime')), uri, name: (uri.match(/[?&]name=([^&]*)/) || [])[1] || '' };
  }).filter(s => s.uri && s.from <= at && at <= s.to);
  if (!segs.length) return null;
  segs.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  return segs[segs.length - 1].uri.replace(/^rtsp:\/\/[^/]*/, '');
}
async function recorded(ch, at) {
  const host = new URL(cfg.nvr).hostname;
  const [when, flag] = String(at).split('~');
  const t = when.replace(/[-:]/g, '').slice(0, 15) + 'Z';
  let p = `/Streaming/tracks/${ch}01?starttime=${t}`;
  if (flag === 'new') { // لو ما لقينا الملفات نقول ليش — ما نرجع للقديم بصمت (يطلع تسجيل أمس)
    const seg = await newestSegment(ch, when);
    if (!seg) throw new Error('ما لقيت ملف تسجيل يغطي هالوقت (البحث في جهاز التسجيل)');
    p = seg.replace(/starttime=[^&]*/, `starttime=${t}`);
  }
  const url = `rtsp://${encodeURIComponent(cfg.nvr_user)}:${encodeURIComponent(cfg.nvr_pass)}@${host}:${cfg.rtsp_port || 554}${p}`;
  return new Promise((resolve, reject) => {
    const p = require('node:child_process').spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', url, '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '5', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    const kill = setTimeout(() => p.kill('SIGKILL'), 30000);
    p.stdout.on('data', c => out.push(c)); p.stderr.on('data', c => err.push(c));
    p.on('error', e => { clearTimeout(kill); reject(new Error(e.code === 'ENOENT' ? 'برنامج ffmpeg مو مثبّت في الجسر — في Termux: pkg install -y ffmpeg' : e.message)); });
    p.on('close', code => {
      clearTimeout(kill);
      const img = Buffer.concat(out);
      if (img.length > 100 && img[0] === 0xff && img[1] === 0xd8) return resolve(img);
      const e = Buffer.concat(err).toString().replace(/rtsp:\/\/[^@\s]*@/g, 'rtsp://***@').trim(); // كلمة السر ما تطلع
      reject(new Error(/401|Unauthorized/i.test(e) ? 'المستخدم ما عنده صلاحية «تشغيل التسجيل» في جهاز التسجيل' : /404|Not Found/i.test(e) ? 'ما فيه تسجيل في هذا الوقت' : `ما قدر يقرأ التسجيل${e ? ': ' + e.slice(-150) : ` (${code})`}`));
    });
  });
}

// ===== النظام =====
async function api(method, p, body) {
  const r = await fetch(cfg.server + p, { method, headers: { 'content-type': 'application/json', 'x-bridge-token': cfg.token || '' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'خطأ ' + r.status), { status: r.status });
  return j;
}

async function setup() {
  const env = process.env;
  cfg.server = String(process.argv.find(a => /^https?:\/\//.test(a)) || env.ALSALAM_SERVER || cfg.server || '').replace(/\/+$/, '') || await ask('عنوان النظام (https://...)');
  if (process.argv.includes('--cams')) { cfg.nvr = ''; cfg.nvr_user = ''; cfg.nvr_pass = ''; }
  if (!cfg.nvr) {
    const a = env.NVR_URL != null ? env.NVR_URL : await ask('عنوان جهاز تسجيل الكاميرات في شبكة المحل (مثل 192.168.1.64) — اتركه فاضي لو تبغى الطابعة بس');
    cfg.nvr = !a || a === 'none' ? 'none' : 'http://' + a.replace(/^https?:\/\//, '');
  }
  if (cams()) {
    if (!cfg.nvr_user) cfg.nvr_user = env.NVR_USER || await ask('اسم مستخدم جهاز التسجيل (يفضّل مستخدم «مشاهدة بس»)', 'admin');
    if (!cfg.nvr_pass) cfg.nvr_pass = env.NVR_PASS || await ask('كلمة سره (تنحفظ في هذا الجوال بس)');
  }
  save();
  // نتأكد من جهاز التسجيل قبل الربط
  const list = cams() ? await channels() : [];
  if (cams()) log(`✓ جهاز التسجيل شغال — ${list.length} كاميرا`);
  if (!cfg.token) {
    const code = env.CAM_CODE || await ask('رمز الربط (من صفحة الكاميرات في النظام)');
    cfg.token = (await api('POST', '/api/cam/bridge/hello', { code })).token; save();
    log('✓ انربط بالنظام');
  }
  if (list.length) await api('POST', '/api/cam/bridge/channels', { channels: list });
}
const cams = () => cfg.nvr && cfg.nvr !== 'none';

// ===== 🖨️ طابعة المحل =====
const QDIR = process.env.BRIDGE_QUEUE || path.join(os.homedir(), '.alsalam-print');
const PPORT = Number(process.env.BRIDGE_PRINTER_PORT) || 9100;
const queued = () => { try { return fs.readdirSync(QDIR).filter(f => f.endsWith('.json')).sort(); } catch { return []; } };
// عنوان الجوال في شبكة المحل (يتحط في الكاشير)
function lanIp() {
  try {
    const all = Object.entries(os.networkInterfaces()).flatMap(([n, l]) => (l || []).map(a => ({ n, ...a }))).filter(a => a.family === 'IPv4' && !a.internal);
    const w = all.find(a => /wlan|wi-?fi|en/i.test(a.n)) || all[0];
    if (w) return w.address;
  } catch { /* أندرويد أحيانًا يمنعها */ }
  try { const o = require('node:child_process').execSync('ip -4 addr show wlan0 2>/dev/null', { encoding: 'utf8' }); const m = o.match(/inet (\d+\.\d+\.\d+\.\d+)/); if (m) return m[1]; } catch { /* */ }
  return '';
}
// أوامر طابعة حقيقية؟ (مو أي شي)
const MARK = [[0x1b, 0x40], [0x1d, 0x56], [0x1d, 0x76, 0x30], [0x1b, 0x61], [0x1b, 0x45], [0x1b, 0x21], [0x1d, 0x21], [0x1b, 0x2a], [0x1b, 0x74], [0x1c, 0x26], [0x1b, 0x64]];
function looksPrint(b) {
  if (b.length < 65 || (b[0] === 0x16 && b[1] === 0x03)) return false;
  if (/^(GET |POST|HEAD |PUT |OPTIONS|<\?xml|\{|SSH-|<!DOC|<html)/i.test(b.subarray(0, 12).toString('latin1'))) return false;
  if (b[0] === 0x1b && b[1] === 0x40) return true;
  return MARK.filter(m => b.indexOf(Buffer.from(m)) >= 0).length >= 2;
}
// «وش حالك؟» من الكاشير => شغالة
function replyStatus(c, sock) {
  for (let i = 0; i + 2 < c.length + 1; i++) {
    if (c[i] === 0x10 && c[i + 1] === 0x04) sock.write(Buffer.from([0x12]));
    else if (c[i] === 0x1d && (c[i + 1] === 0x72 || c[i + 1] === 0x49)) sock.write(Buffer.from([0x00]));
  }
}
function printerServer() {
  fs.mkdirSync(QDIR, { recursive: true });
  const srv = net.createServer(sock => {
    const chunks = []; let size = 0, done = false, t;
    const finish = () => {
      if (done) return; done = true; clearTimeout(t);
      const buf = Buffer.concat(chunks);
      if (!looksPrint(buf)) return;
      const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(path.join(QDIR, id + '.tmp'), JSON.stringify({ id, at: new Date().toISOString(), raw_b64: buf.toString('base64') }));
      fs.renameSync(path.join(QDIR, id + '.tmp'), path.join(QDIR, id + '.json'));
      log('🖨️ ورقة جديدة', `(${Math.round(buf.length / 1024)}KB)`);
      upload();
    };
    const idle = () => { clearTimeout(t); t = setTimeout(() => { finish(); sock.end(); }, 3000); };
    sock.on('data', c => { size += c.length; if (size > 4 * 1024 * 1024) { sock.destroy(); return; } chunks.push(c); if (c.length <= 16) try { replyStatus(c, sock); } catch { /* */ } idle(); });
    sock.on('end', finish); sock.on('close', finish); sock.on('error', () => {});
    idle();
  });
  srv.on('error', e => log('⚠️ الطابعة:', e.message));
  srv.listen(PPORT, '0.0.0.0', () => log(`🖨️ طابعة المحل شغالة — في الكاشير حط IP: ${lanIp() || '(شوف عنوان الجوال في إعدادات الواي فاي)'} والمنفذ ${PPORT}`));
}
// الرفع: ورقة ورقة بالترتيب، وما تنمسح من الجوال إلا بعد ما النظام يأكد
let uploading = false;
async function upload() {
  if (uploading || !cfg.token) return;
  uploading = true;
  try {
    for (const f of queued()) {
      const job = JSON.parse(fs.readFileSync(path.join(QDIR, f), 'utf8'));
      await api('POST', '/api/cam/bridge/print', job);
      fs.unlinkSync(path.join(QDIR, f));
    }
  } catch (e) { if (e.status === 401) throw e; /* النت فاصل — نعيد بعدين */ } finally { uploading = false; }
}

// 🔄 تحديث لحاله: كل نص ساعة يشيك نسخة النظام — لو تغيّرت ينزّلها، ولو شغّال باللفة (BRIDGE_LOOP) يطلع واللفة تشغّله من جديد
// نسخة الجسر (بصمة الملف) — النظام يعرف إذا الجسر نزّل آخر تحديث
const VER = require('node:crypto').createHash('md5').update(fs.readFileSync(__filename)).digest('hex').slice(0, 8);
async function selfUpdate() {
  try {
    const r = await fetch(cfg.server + '/api/cam/bridge.js', { signal: AbortSignal.timeout(60000) });
    if (!r.ok) return;
    const t = await r.text();
    if (t.length < 2000 || !t.includes('جسر الكاميرات') || t === fs.readFileSync(__filename, 'utf8')) return;
    fs.writeFileSync(__filename, t);
    if (process.env.BRIDGE_LOOP === '1') { log('🔄 نزل تحديث للجسر — يعيد التشغيل'); process.exit(0); }
    log('🔄 نزل تحديث للجسر — شغّله من جديد عشان يشتغل');
  } catch { /* النت */ }
}
async function main() {
  try { require('node:child_process').spawn('termux-wake-lock', { stdio: 'ignore' }).on('error', () => {}); } catch { /* مو Termux */ }
  printerServer(); // الطابعة تشتغل على طول — حتى لو النت فاصل، الأوراق تنحفظ هنا
  setInterval(() => upload().catch(() => {}), 5000);
  for (;;) {
    try { await setup(); break; } catch (e) {
      log('⚠️', e.message);
      if (/كلمة سر/.test(e.message)) { cfg.nvr_pass = ''; cfg.nvr_user = ''; save(); }
      if (/رمز الربط/.test(e.message)) { cfg.token = ''; save(); }
      if (process.env.CAM_CODE && /رمز الربط/.test(e.message)) process.exit(2);
      await sleep(5000);
    }
  }
  events();
  log(`✅ الجسر شغال${cams() ? ' (الكاميرات + الطابعة)' : ' (الطابعة)'} — خله على الشاحن والواي فاي`);
  setTimeout(() => selfUpdate(), 60e3); setInterval(() => selfUpdate(), 30 * 60e3);
  upload().catch(() => {});
  let wait = 1000, lastCh = Date.now();
  for (;;) {
    try {
      if (cams() && Date.now() - lastCh > 30 * 60e3) { lastCh = Date.now(); api('POST', '/api/cam/bridge/channels', { channels: await channels() }).catch(() => {}); }
      const { jobs, watch: w } = await api('GET', `/api/cam/bridge/poll?queued=${queued().length}&lan=${encodeURIComponent(lanIp())}&cams=${cams() ? 1 : 0}&v=${VER}`);
      if (Array.isArray(w)) watch = new Set(w.map(Number));
      for (const j of jobs) {
        try {
          if (!cams()) throw new Error('الكاميرات مو مربوطة في الجسر — شغّله بـ --cams');
          // 🔍 قراءة إعداد من الجهاز (GET بس — ما يغيّر شي، وما يقرأ الحسابات)
          if (j.put) {
            if (!PUT_OK(j.put)) throw new Error('مسار مو مسموح');
            const body = await nvr(j.put, 'PUT', String(j.body || ''));
            await api('POST', `/api/cam/bridge/snap/${j.id}`, { text: body.toString('utf8').slice(0, 20000) });
            continue;
          }
          if (j.path) {
            if (!/^\/ISAPI\/[\w\/.\-]+(\?[\w=&.\-]*)?$/.test(j.path) || /^\/ISAPI\/Security/i.test(j.path)) throw new Error('مسار مو مسموح');
            const body = await nvr(j.path);
            await api('POST', `/api/cam/bridge/snap/${j.id}`, { text: body.toString('utf8').slice(0, 200000) });
            continue;
          }
          const img = j.playback ? await recorded(j.ch, j.playback) : await nvr(`/ISAPI/Streaming/channels/${j.ch}01/picture`);
          await api('POST', `/api/cam/bridge/snap/${j.id}`, { jpeg_b64: img.toString('base64') });
        } catch (e) { log('⚠️ كاميرا', j.ch, e.message); await api('POST', `/api/cam/bridge/snap/${j.id}`, { error: e.message }).catch(() => {}); }
      }
      wait = 1000;
    } catch (e) {
      if (e.status === 401) { log('⛔ الربط انلغى من النظام — شغّل الجسر من جديد برمز ربط جديد'); cfg.token = ''; save(); process.exit(1); }
      log('⚠️ النظام:', e.message); await sleep(wait); wait = Math.min(wait * 2, 30000);
    }
  }
}
main();
