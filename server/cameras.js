'use strict';
// 📹 الكاميرات (هيك فيژن) عن طريق «جسر» في المحل (جوال أندرويد قديم + Termux):
// الجسر يكلم جهاز التسجيل محليًا ويرسل اللقطات هنا — جهاز التسجيل ما ينفتح للإنترنت، وكلمة سر الكاميرات تقعد في الجوال بس
// الجسر يسأل («فيه طلب لقطة؟») كل شوي، وتوكنه يرسل لقطات بس
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { all, get, run, getSetting, setSetting, UPLOAD_DIR } = require('./db');

const DIR = path.join(UPLOAD_DIR, 'cam'); // مو تحت /uploads/ المفتوح
const POLL_MS = Number(process.env.CAM_POLL_MS) || 25000;
const ROLES = { cashier: 'الكاشير', kitchen: 'المطبخ', hall: 'الصالة', door: 'الباب', store: 'المستودع' };
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

// ===== الربط: رمز مؤقت (١٠ دقائق، مرة وحدة) => توكن للجسر =====
function pairCode() {
  const code = String(crypto.randomInt(100000, 1000000));
  setSetting('cam_pair', JSON.stringify({ h: sha(code), exp: Date.now() + 10 * 60e3 }));
  return { code, minutes: 10 };
}
function hello(code) {
  let p = {}; try { p = JSON.parse(getSetting('cam_pair') || '{}'); } catch { /* */ }
  if (!p.h || p.exp < Date.now() || p.h !== sha(String(code || '').trim())) {
    // ٥ محاولات غلط => الرمز ينلغى (ما أحد يجرّب الأرقام كلها)
    if (p.h) { p.bad = (p.bad || 0) + 1; setSetting('cam_pair', p.bad >= 5 ? '' : JSON.stringify(p)); }
    throw Object.assign(new Error('رمز الربط غلط أو انتهى — اطلع رمز جديد من صفحة الكاميرات'), { status: 403 });
  }
  setSetting('cam_pair', '');
  const token = crypto.randomBytes(32).toString('hex');
  setSetting('cam_bridge_token', sha(token));
  setSetting('cam_bridge_seen', '');
  return { token };
}
const bridgeOk = req => {
  const t = String(req.headers['x-bridge-token'] || ''), h = getSetting('cam_bridge_token');
  if (!t || !h || sha(t) !== h) throw Object.assign(new Error('الجسر مو مربوط'), { status: 401 });
  setSetting('cam_bridge_seen', new Date().toISOString());
};
const unlink = () => { setSetting('cam_bridge_token', ''); setSetting('cam_bridge_seen', ''); };

// ===== الكاميرات =====
function setChannels(list, { names = true, roles = false } = {}) {
  for (const c of list || []) {
    const ch = Number(c.ch); if (!(ch > 0 && ch < 256)) continue;
    const name = String(c.name || '').trim().slice(0, 60) || `كاميرا ${ch}`;
    const role = roles ? (ROLES[c.role] ? c.role : '') : null;
    if (!get('SELECT 1 AS x FROM cam_channels WHERE ch = ?', ch)) run('INSERT INTO cam_channels(ch, name, role) VALUES(?,?,?)', ch, name, role || '');
    else {
      if (names) run('UPDATE cam_channels SET name = ? WHERE ch = ?', name, ch);
      if (roles) run('UPDATE cam_channels SET role = ? WHERE ch = ?', role, ch);
    }
  }
}
const byRole = role => all('SELECT ch FROM cam_channels WHERE role = ? ORDER BY ch', role).map(r => r.ch);

// ===== الطلبات (long-poll) =====
let waiters = [];
const wake = () => { const w = waiters; waiters = []; for (const f of w) f(); };
const pending = new Map(); // job id => resolve (لـ«لقطة الحين»)
function request(ch, reason, ref = '', pbAt = '') {
  const id = Number(run("INSERT INTO cam_jobs(ch, reason, ref, status, at, pb_at) VALUES(?,?,?,'pending',datetime('now'),?)", ch, reason, ref, pbAt).lastInsertRowid);
  wake();
  return id;
}
// لقطة من كاميرات دور معيّن (الكاشير…) — لو الجسر مربوط
function event(role, reason, ref) {
  if (!getSetting('cam_bridge_token')) return [];
  return byRole(role).map(ch => request(ch, reason, ref));
}
async function poll() {
  const take = () => {
    // القديم (أكثر من دقيقتين) ما له فايدة — ينلغى (التسجيل: ربع ساعة، لأن الشريط ياخذ وقت)
    run("UPDATE cam_jobs SET status = 'stale' WHERE status IN ('pending', 'sent') AND at < datetime('now', CASE WHEN reason = 'playback' THEN '-15 minutes' ELSE '-2 minutes' END)");
    const jobs = all("SELECT id, ch, CASE WHEN reason = 'isapi' THEN ref END AS path, CASE WHEN reason = 'playback' THEN pb_at END AS playback FROM cam_jobs WHERE status = 'pending' ORDER BY id LIMIT 20");
    if (jobs.length) run(`UPDATE cam_jobs SET status = 'sent' WHERE id IN (${jobs.map(j => j.id).join(',')})`);
    return jobs;
  };
  let jobs = take();
  if (!jobs.length) {
    await new Promise(r => { const t = setTimeout(r, POLL_MS); waiters.push(() => { clearTimeout(t); r(); }); });
    jobs = take();
  }
  return { jobs };
}
function result(id, body) {
  const j = get('SELECT * FROM cam_jobs WHERE id = ?', Number(id));
  if (!j) throw Object.assign(new Error('غير موجود'), { status: 404 });
  if (j.reason === 'isapi') { // 🔍 قراءة إعدادات جهاز التسجيل (نص)
    run(`UPDATE cam_jobs SET status = '${body.error ? 'error' : 'done'}', error = ? WHERE id = ?`, body.error ? String(body.error).slice(0, 300) : '', j.id);
    pending.get(j.id)?.(body.error ? { error: String(body.error) } : { text: String(body.text || '').slice(0, 200000) }); pending.delete(j.id);
    return { ok: true };
  }
  if (body.error || !body.jpeg_b64) {
    run("UPDATE cam_jobs SET status = 'error', error = ? WHERE id = ?", String(body.error || 'ما وصلت صورة').slice(0, 300), j.id);
    pending.get(j.id)?.(null); pending.delete(j.id);
    return { ok: true };
  }
  const buf = Buffer.from(String(body.jpeg_b64), 'base64');
  if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) throw Object.assign(new Error('مو صورة JPEG'), { status: 400 });
  fs.mkdirSync(DIR, { recursive: true });
  const file = `${Date.now()}-${j.ch}-${crypto.randomBytes(4).toString('hex')}.jpg`;
  fs.writeFileSync(path.join(DIR, file), buf);
  const sid = Number(run("INSERT INTO cam_snaps(at, ch, reason, ref, file, bytes, job_id, pb_at) VALUES(datetime('now'),?,?,?,?,?,?,?)", j.ch, j.reason, j.ref, file, buf.length, j.id, j.pb_at || '').lastInsertRowid);
  run("UPDATE cam_jobs SET status = 'done' WHERE id = ?", j.id);
  pending.get(j.id)?.(sid); pending.delete(j.id);
  return { ok: true, id: sid };
}
// «📸 لقطة الحين»: ينتظر لين توصل (أو ١٥ ثانية)
function snapNow(ch, reason = 'manual', ref = '', wait = 15000) {
  const id = request(ch, reason, ref);
  return new Promise(resolve => {
    const t = setTimeout(() => { pending.delete(id); resolve(null); }, wait);
    pending.set(id, sid => { clearTimeout(t); resolve(sid); });
  });
}
// 🔍 يقرأ إعداد من جهاز التسجيل عن طريق الجسر — GET بس (قراءة، ما يغيّر شي)، وبدون الحسابات وكلمات السر
const ISAPI_OK = p => /^\/ISAPI\/[\w\/.\-]+(\?[\w=&.\-]*)?$/.test(p) && !/^\/ISAPI\/Security/i.test(p);
function isapiGet(p, wait = 20000) {
  if (!ISAPI_OK(p)) throw Object.assign(new Error('مسار مو مسموح'), { status: 400 });
  const id = request(0, 'isapi', p);
  return new Promise(resolve => {
    const t = setTimeout(() => { pending.delete(id); resolve({ error: 'الجسر ما رد — يمكن يحتاج تحديث' }); }, wait);
    pending.set(id, r => { clearTimeout(t); resolve(r); });
  });
}
// ⏪ شريط من التسجيل: لقطة كل «every» دقيقة من «from» (بتوقيت السعودية) — الجسر يقراها من جهاز التسجيل (قراءة بس)
// يرجع رقم الشريط على طول، واللقطات توصل وحدة وحدة (snaps?ref=)
const PB_MAX = 60;
function playback(ch, from, every = 1, count = 1) {
  if (!getSetting('cam_bridge_token')) throw Object.assign(new Error('اربط الجسر أول'), { status: 400 });
  if (!get('SELECT 1 AS x FROM cam_channels WHERE ch = ?', Number(ch))) throw Object.assign(new Error('الكاميرا غير موجودة'), { status: 400 });
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(from || '').trim());
  if (!m) throw Object.assign(new Error('الوقت لازم مثل 2026-10-22T11:45'), { status: 400 });
  const start = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4] || '00'}Z`); // نحسب «كأنه» UTC عشان ما يلعب فيه توقيت السيرفر — هو أصلًا وقت السعودية
  if (start - 3 * 3600e3 > Date.now() + 60e3) throw Object.assign(new Error('هذا وقت ما جا للحين'), { status: 400 });
  const n = Math.max(1, Math.min(PB_MAX, Math.round(Number(count) || 1))), step = Math.max(0.25, Math.min(120, Number(every) || 1)) * 60e3;
  const ref = `pb:${crypto.randomBytes(5).toString('hex')}`;
  for (let i = 0; i < n; i++) request(Number(ch), 'playback', ref, new Date(start + i * step).toISOString().slice(0, 19));
  return { ref, count: n };
}
// لقطة حدث وصلت؟ (لو لسه، ننتظرها شوي)
async function snapFor(ref, wait = 12000) {
  for (let i = 0; i < wait / 500; i++) {
    const s = get('SELECT * FROM cam_snaps WHERE ref = ? ORDER BY id DESC LIMIT 1', ref);
    if (s) return s;
    if (!get("SELECT 1 AS x FROM cam_jobs WHERE ref = ? AND status IN ('pending', 'sent')", ref)) return null;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}
const file = s => fs.readFileSync(path.join(DIR, path.basename(s.file)));

function status() {
  const seen = getSetting('cam_bridge_seen');
  return {
    linked: !!getSetting('cam_bridge_token'), seen: seen || null,
    online: !!seen && Date.now() - Date.parse(seen) < POLL_MS + 20000,
    channels: all('SELECT ch, name, role FROM cam_channels ORDER BY ch'), roles: ROLES,
    errors: all("SELECT ch, error, at FROM cam_jobs WHERE status = 'error' ORDER BY id DESC LIMIT 3"),
    keep_days: Number(getSetting('cam_keep_days', '60')), alert_short: Number(getSetting('cam_alert_short', '20')),
  };
}
function snaps({ ref, before, limit = 60 } = {}) {
  const rows = ref ? all('SELECT * FROM cam_snaps WHERE ref = ? ORDER BY pb_at, id DESC', ref)
    : all('SELECT * FROM cam_snaps WHERE id < ? ORDER BY id DESC LIMIT ?', Number(before) || 1e15, limit);
  const names = new Map(all('SELECT ch, name FROM cam_channels').map(c => [c.ch, c.name]));
  return rows.map(s => ({ id: s.id, at: s.at, ch: s.ch, cam: names.get(s.ch) || `كاميرا ${s.ch}`, reason: s.reason, ref: s.ref, bytes: s.bytes, pb_at: s.pb_at || '' }));
}
// اللي أقدم من المدة ينمسح (الصورة والسطر)
function cleanup() {
  const days = Math.max(7, Number(getSetting('cam_keep_days', '60')) || 60);
  for (const s of all(`SELECT id, file FROM cam_snaps WHERE at < datetime('now', '-${days} days')`)) {
    try { fs.unlinkSync(path.join(DIR, path.basename(s.file))); } catch { /* */ }
    run('DELETE FROM cam_snaps WHERE id = ?', s.id);
  }
  run("DELETE FROM cam_jobs WHERE at < datetime('now', '-3 days')");
}

module.exports = { playback, isapiGet, ISAPI_OK, pairCode, hello, bridgeOk, unlink, setChannels, byRole, request, event, poll, result, snapNow, snapFor, file, status, snaps, cleanup, ROLES, DIR };
