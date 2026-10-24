'use strict';
// 👋 «بدأت دوامي / انتهى دوامي»: ينقبل بس من نت المحل (نفس إنترنت الجسر)، مع سيلفي يتقارن بصورة وجه الموظف،
// ولقطة من كاميرات المطبخ والكاشير. جوال واحد لاثنين، أو وجه مو صاحبه => تنبيه للمالك
// صور الوجوه والسيلفي في مجلد خاص (مو تحت /uploads/ المفتوح) — المالك بس يشوفها
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { all, get, run, getSetting, setSetting, UPLOAD_DIR } = require('./db');
const C = require('./calc');
const AI = require('./ai');

const DIR = path.join(UPLOAD_DIR, 'faces');
const SHOP_IP_HOURS = 3; // عنوان نت المحل ينقبل لو الجسر اتصل منه آخر ٣ ساعات

// عنوان العميل: ورا Caddy (على نفس الجهاز) ناخذ آخر عنوان في X-Forwarded-For — Caddy يحطه بنفسه وما يصدّق اللي جاي من برا
function clientIp(req) {
  const ra = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return (ra === '127.0.0.1' || ra === '::1') && xff.length ? xff.at(-1).replace(/^::ffff:/, '') : ra;
}
const shopIps = () => { try { return JSON.parse(getSetting('shop_ips') || '{}'); } catch { return {}; } };
// الجسر اتصل => هذا نت المحل
function sawShop(ip) {
  if (!ip) return;
  const m = shopIps(), now = Date.now();
  m[ip] = new Date(now).toISOString();
  for (const [k, at] of Object.entries(m)) if (now - Date.parse(at) > 24 * 3600e3) delete m[k];
  setSetting('shop_ips', JSON.stringify(m));
}
// 'shop' = من نت المحل | 'outside' = من برا | 'unknown' = ما نعرف نت المحل (الجسر مو مربوط)
function netOf(ip) {
  const m = shopIps(), fresh = Object.entries(m).filter(([, at]) => Date.now() - Date.parse(at) < SHOP_IP_HOURS * 3600e3);
  if (!fresh.length) return 'unknown';
  return fresh.some(([k]) => k === ip) ? 'shop' : 'outside';
}

function savePic(dataUrl, prefix) {
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!m) throw Object.assign(new Error('صوّر وجهك أول'), { status: 400 });
  if (m[2].length > 8 * 1024 * 1024) throw Object.assign(new Error('الصورة كبيرة'), { status: 400 });
  fs.mkdirSync(DIR, { recursive: true });
  const name = `${prefix}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}.${m[1] === 'png' ? 'png' : m[1] === 'webp' ? 'webp' : 'jpg'}`;
  fs.writeFileSync(path.join(DIR, name), Buffer.from(m[2], 'base64'));
  return name;
}
// الوقت بتوقيت السعودية «2:05 م»
function hhmm(iso) {
  const d = new Date(Date.parse(iso) + 3 * 3600e3), h = d.getUTCHours(), m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h % 12 || 12}:${m} ${h < 12 ? 'ص' : 'م'}`;
}
const picFile = name => path.join(DIR, path.basename(name));
const picType = name => (/\.png$/.test(name) ? 'image/png' : /\.webp$/.test(name) ? 'image/webp' : 'image/jpeg');
const b64 = name => ({ type: 'image', source: { type: 'base64', media_type: picType(name), data: fs.readFileSync(picFile(name)).toString('base64') } });

// 📸 صورة الوجه المرجعية (المالك يرفعها مرة)
function setFace(userId, dataUrl) {
  const u = get('SELECT id, face FROM users WHERE id = ?', Number(userId));
  if (!u) throw Object.assign(new Error('الموظف غير موجود'), { status: 404 });
  const name = dataUrl ? savePic(dataUrl, 'ref') : '';
  if (u.face) try { fs.unlinkSync(picFile(u.face)); } catch { /* */ }
  run('UPDATE users SET face = ? WHERE id = ?', name, u.id);
  return { ok: true, has_face: !!name };
}

const ROW = `SELECT a.*, u.name FROM attendance a JOIN users u ON u.id = a.user_id`;
const today = () => C.businessDate();
const mine = (userId, date = today()) => ({
  in: get(`${ROW} WHERE a.user_id = ? AND a.date = ? AND a.kind = 'in'`, userId, date) || null,
  out: get(`${ROW} WHERE a.user_id = ? AND a.date = ? AND a.kind = 'out'`, userId, date) || null,
});
const pub = r => r && ({ id: r.id, user_id: r.user_id, name: r.name, kind: r.kind, at: r.at, net: r.net, face: r.face, face_score: r.face_score, face_note: r.face_note, shared_with: r.shared_with, cam_ref: r.cam_ref, has_selfie: !!r.selfie });

// ✋ تسجيل الدخول/الخروج — يرجع السطر، والتشييك على الوجه يكمل بالخلفية (onFlag للتنبيه)
function clock(u, { kind, selfie, device }, ip, { camEvent, onFlag } = {}) {
  kind = kind === 'out' ? 'out' : 'in';
  if (u.role === 'owner' || u.bot) throw Object.assign(new Error('المالك ما يحتاج يسجل حضور'), { status: 400 });
  const date = today(), cur = mine(u.id, date);
  if (cur[kind]) throw Object.assign(new Error(kind === 'in' ? 'سجّلت دخولك اليوم من قبل ✓' : 'سجّلت خروجك اليوم من قبل ✓'), { status: 400 });
  if (kind === 'out' && !cur.in) throw Object.assign(new Error('ما سجّلت «بدأت دوامي» اليوم'), { status: 400 });
  const net = netOf(ip);
  if (net === 'outside') throw Object.assign(new Error('لازم تكون في المطعم ومتصل على واي فاي المطعم — اتصل عليه وجرّب مرة ثانية'), { status: 400 });
  const dev = String(device || '').replace(/[^\w-]/g, '').slice(0, 64);
  const selfieName = savePic(selfie, 'self');
  // نفس الجوال سجّل لموظف ثاني اليوم؟
  const shared = dev ? all("SELECT DISTINCT u.name FROM attendance a JOIN users u ON u.id = a.user_id WHERE a.date = ? AND a.device = ? AND a.user_id != ?", date, dev, u.id).map(r => r.name) : [];
  const ref = `att:${crypto.randomBytes(6).toString('hex')}`;
  const ref_face = (get('SELECT face FROM users WHERE id = ?', u.id) || {}).face || '';
  const face = !ref_face ? 'no_ref' : AI.apiKey() || process.env.AI_FIXTURE ? 'pending' : 'skipped';
  const id = Number(run(`INSERT INTO attendance(user_id, date, kind, at, ip, net, device, selfie, face, shared_with, cam_ref) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    u.id, date, kind, new Date().toISOString(), ip || '', net, dev, selfieName, face, shared.join('، '), ref).lastInsertRowid);
  // 📹 لقطة من المطبخ والكاشير في نفس اللحظة (لو الجسر مربوط)
  if (camEvent) try { camEvent('kitchen', 'attendance', ref); camEvent('cashier', 'attendance', ref); } catch (e) { console.error('attendance cam', e.message); }
  const flags = [];
  if (shared.length) flags.push(`📱 نفس الجوال سجّل اليوم لـ ${shared.join('، ')}`);
  if (face === 'pending') setImmediate(() => checkFace(id, u, ref_face, selfieName).then(r => { if (r && r.face === 'mismatch') onFlag?.(id, [...flags, `🧑 الوجه في السيلفي مو ${u.name}${r.note ? ` (${r.note})` : ''}`]); else if (flags.length) onFlag?.(id, flags); }).catch(e => console.error('face', e.message)));
  else if (flags.length) onFlag?.(id, flags);
  return pub(get(`${ROW} WHERE a.id = ?`, id));
}

const SCHEMA = { type: 'object', additionalProperties: false, required: ['same', 'confidence', 'note'], properties: {
  same: { type: 'string', enum: ['yes', 'no', 'unsure'], description: 'هل الشخص في السيلفي هو نفس الشخص في الصورة المرجعية؟' },
  confidence: { type: 'integer', description: '0-100' },
  note: { type: 'string', description: 'سبب قصير بالعربي (مثلًا: الصورة مو واضحة، شخص ثاني، ما فيه وجه)' } } };
async function checkFace(id, u, refName, selfieName) {
  let face = 'error', score = null, note = '';
  try {
    AI.checkCap();
    const res = await AI.create('mid', { max_tokens: 400, messages: [{ role: 'user', content: [
      b64(refName), b64(selfieName),
      { type: 'text', text: `الصورة الأولى: صورة الوجه المرجعية للموظف «${u.name}» (رفعها صاحب المطعم بموافقة الموظف). الصورة الثانية: سيلفي التقطه الحين وهو يسجل حضوره.
هل اللي في السيلفي هو نفس الشخص؟ قارن ملامح الوجه (مو اللبس). إذا ما فيه وجه واضح، أو الصورة صورة لشاشة/صورة ثانية، قل unsure واذكر السبب.` }] }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } } }, { kind: 'attendance', userId: u.id, imgKind: 'chat' });
    const r = JSON.parse(AI.textOf(res));
    face = r.same === 'yes' ? 'match' : r.same === 'no' ? 'mismatch' : 'unsure';
    score = Math.max(0, Math.min(100, Number(r.confidence) || 0)); note = String(r.note || '').slice(0, 200);
    AI.log(u.id, 'attendance', `وجه ${u.name}`, `${face} ${score}`, AI.costOf(res.usage, 'mid'), AI.MODELS.mid.id);
  } catch (e) { note = String(e.message || e).slice(0, 200); }
  run('UPDATE attendance SET face = ?, face_score = ?, face_note = ? WHERE id = ?', face, score, note, id);
  return { face, score, note };
}

// 🗓️ حضور يوم: الدخول والخروج لكل موظف، ومين ما سجّل
function day(date) {
  const rows = all(`${ROW} WHERE a.date = ? ORDER BY a.at`, date).map(pub);
  const by = new Map();
  for (const r of rows) { const e = by.get(r.user_id) || { user_id: r.user_id, name: r.name, in: null, out: null }; e[r.kind] = r; by.set(r.user_id, e); }
  const missing = all("SELECT id, name FROM users WHERE active = 1 AND bot = 0 AND role != 'owner' ORDER BY id").filter(u => !by.has(u.id));
  return { date, people: [...by.values()], missing, shop_known: netOf('') !== 'unknown' };
}

// 🚫 غياب: سطر في الحضور (kind = absent) + ما يجيه تذكير جرد اليوم — ولو انسجل قبل كتنبيه (خطوات) يرجع بدون خطوات
function markAbsent(userId, date, note = '') {
  run("INSERT OR IGNORE INTO attendance(user_id, date, kind, at, face_note) VALUES(?, ?, 'absent', ?, ?)", userId, date, new Date().toISOString(), String(note).slice(0, 300));
  run("UPDATE wa_issues SET step = 0 WHERE user_id = ? AND date = ? AND type = 'absent'", userId, date);
  try {
    const a = JSON.parse(getSetting('wa_absent') || '{}'), ids = a.date === date ? (a.ids || []).map(Number) : [];
    if (!ids.includes(userId)) setSetting('wa_absent', JSON.stringify({ date, ids: [...ids, userId] }));
  } catch { /* */ }
  return { ok: true };
}
// الرسالة للعامل نفسه في الخاص (خبر بس — بدون تنبيه ولا قرصة إذن)
const absentMsg = (name, by) => `${name}، انسجل عليك غياب اليوم${by ? ` (سجّله ${by})` : ''}. لو عندك عذر أو هذا غلط كلّم المشرف 🙏`;
module.exports = { absentMsg, markAbsent, hhmm, clientIp, sawShop, netOf, setFace, clock, mine, pub, day, picFile, picType, DIR };
