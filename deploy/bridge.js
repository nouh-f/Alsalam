#!/usr/bin/env node
'use strict';
// 📹 جسر الكاميرات — يشتغل على جوال أندرويد قديم في المحل (Termux) أو أي جهاز على شبكة المحل.
// يكلم جهاز التسجيل (هيك فيژن، ISAPI) محليًا، ويرسل اللقطات لنظام مطعم السلام. اتصال طالع بس.
// كلمة سر الكاميرات تنحفظ في هذا الجهاز بس — ما تروح للنظام.
// التشغيل: node bridge.js https://عنوان-النظام
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const readline = require('node:readline');

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
function raw(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url), mod = u.protocol === 'https:' ? https : http;
    const rq = mod.request(u, { method: 'GET', headers, timeout: 15000, rejectUnauthorized: false }, res => {
      const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(ch) }));
    });
    rq.on('timeout', () => rq.destroy(new Error('جهاز التسجيل ما رد')));
    rq.on('error', reject); rq.end();
  });
}
let dig = null, nc = 0;
function authHeader(uri) {
  if (!dig) return {};
  if (dig.basic) return { Authorization: 'Basic ' + Buffer.from(`${cfg.nvr_user}:${cfg.nvr_pass}`).toString('base64') };
  const ha1 = md5(`${cfg.nvr_user}:${dig.realm}:${cfg.nvr_pass}`), ha2 = md5(`GET:${uri}`);
  const n = (++nc).toString(16).padStart(8, '0'), cn = crypto.randomBytes(8).toString('hex');
  const resp = dig.qop ? md5(`${ha1}:${dig.nonce}:${n}:${cn}:auth:${ha2}`) : md5(`${ha1}:${dig.nonce}:${ha2}`);
  return { Authorization: `Digest username="${cfg.nvr_user}", realm="${dig.realm}", nonce="${dig.nonce}", uri="${uri}", ${dig.qop ? `qop=auth, nc=${n}, cnonce="${cn}", ` : ''}response="${resp}"${dig.opaque ? `, opaque="${dig.opaque}"` : ''}` };
}
async function nvr(uri) {
  for (let i = 0; i < 2; i++) {
    const r = await raw(cfg.nvr + uri, authHeader(uri));
    if (r.status !== 401) {
      if (r.status >= 400) throw new Error(`جهاز التسجيل رد ${r.status}`);
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

// ===== النظام =====
async function api(method, p, body) {
  const r = await fetch(cfg.server + p, { method, headers: { 'content-type': 'application/json', 'x-bridge-token': cfg.token || '' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'خطأ ' + r.status), { status: r.status });
  return j;
}

async function setup() {
  const env = process.env;
  cfg.server = String(process.argv[2] || env.ALSALAM_SERVER || cfg.server || '').replace(/\/+$/, '') || await ask('عنوان النظام (https://...)');
  if (!cfg.nvr) cfg.nvr = env.NVR_URL || ('http://' + (await ask('عنوان جهاز التسجيل في شبكة المحل (مثل 192.168.1.64)')).replace(/^https?:\/\//, ''));
  if (!cfg.nvr_user) cfg.nvr_user = env.NVR_USER || await ask('اسم مستخدم جهاز التسجيل (يفضّل مستخدم «مشاهدة بس»)', 'admin');
  if (!cfg.nvr_pass) cfg.nvr_pass = env.NVR_PASS || await ask('كلمة سره (تنحفظ في هذا الجوال بس)');
  save();
  // نتأكد من جهاز التسجيل قبل الربط
  const cams = await channels();
  log(`✓ جهاز التسجيل شغال — ${cams.length} كاميرا`);
  if (!cfg.token) {
    const code = env.CAM_CODE || await ask('رمز الربط (من صفحة الكاميرات في النظام)');
    cfg.token = (await api('POST', '/api/cam/bridge/hello', { code })).token; save();
    log('✓ انربط بالنظام');
  }
  await api('POST', '/api/cam/bridge/channels', { channels: cams });
}

async function main() {
  try { require('node:child_process').spawn('termux-wake-lock', { stdio: 'ignore' }).on('error', () => {}); } catch { /* مو Termux */ }
  for (;;) {
    try { await setup(); break; } catch (e) {
      log('⚠️', e.message);
      if (/كلمة سر/.test(e.message)) { cfg.nvr_pass = ''; cfg.nvr_user = ''; save(); }
      if (/رمز الربط/.test(e.message)) { cfg.token = ''; save(); }
      if (process.env.CAM_CODE && /رمز الربط/.test(e.message)) process.exit(2);
      await sleep(5000);
    }
  }
  log('📹 الجسر شغال — خله على الشاحن والواي فاي');
  let wait = 1000, lastCh = Date.now();
  for (;;) {
    try {
      if (Date.now() - lastCh > 30 * 60e3) { lastCh = Date.now(); api('POST', '/api/cam/bridge/channels', { channels: await channels() }).catch(() => {}); }
      const { jobs } = await api('GET', '/api/cam/bridge/poll');
      for (const j of jobs) {
        try {
          const img = await nvr(`/ISAPI/Streaming/channels/${j.ch}01/picture`);
          await api('POST', `/api/cam/bridge/snap/${j.id}`, { jpeg_b64: img.toString('base64') });
        } catch (e) { log('⚠️ كاميرا', j.ch, e.message); await api('POST', `/api/cam/bridge/snap/${j.id}`, { error: e.message }).catch(() => {}); }
      }
      wait = 1000;
    } catch (e) {
      if (e.status === 401) { log('⛔ الربط انلغى من النظام — شغّل الجسر من جديد برمز ربط جديد'); cfg.token = ''; save(); process.exit(1); }
      log('⚠️ النظام:', e.message); await sleep(wait); wait = Math.min(wait * 2, 60000);
    }
  }
}
main();
