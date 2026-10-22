'use strict';
// ⚠️ «إجادة في المحل»: كل شوي لقطة من كاميرات الكاشير (اللي تشوف الداخل أول ما يدخل)، والرخيص (Haiku) يشوف:
// فيه مفتش بزي إجادة (كحلي + خطوط عاكسة + كاب)؟ => تنبيه بالصورة في جروب المطعم ولنوح، مرة كل نص ساعة.
// اللقطة اللي ما فيها شي تنمسح على طول (ما تتكدس). ولو اللقطة ما تغيّرت عن اللي قبلها ما نسأل الذكاء (توفير)
const fs = require('node:fs');
const path = require('node:path');
const { all, get, run, getSetting, setSetting } = require('./db');
const CAM = require('./cameras');
const AI = require('./ai');
const C = require('./calc');

const cfg = () => ({
  on: getSetting('inspect_watch', '0') === '1',
  // events = يفحص بس لما جهاز التسجيل يقول «دخل شخص» (رخيص) | interval = كل «every» ثانية
  mode: getSetting('inspect_mode', 'events') === 'interval' ? 'interval' : 'events',
  every: Math.max(15, Number(getSetting('inspect_every', '30')) || 30), // ثانية
  from: Number(getSetting('inspect_from', '7')), to: Number(getSetting('inspect_to', '25')), // ساعات الدوام (25 = ١ الفجر)
});
const COOLDOWN = 30 * 60e3;
const inHours = (c, h = C.riyadhHour()) => (c.to > 24 ? h >= c.from || h < c.to - 24 : h >= c.from && h < c.to);

const SCHEMA = { type: 'object', additionalProperties: false, required: ['inspector', 'confidence', 'note'], properties: {
  inspector: { type: 'boolean' }, confidence: { type: 'integer', description: '0-100' },
  note: { type: 'string', description: 'وين واقف ووش يسوي، قصير بالعربي' } } };
const PROMPT = `هذي لقطة الحين من كاميرات كاشير مطعم (من فوق). هل فيها مفتش رقابة بلدية («إجادة»)؟
شكله: زي كحلي كامل (قميص نص كم كحلي + بنطلون كحلي)، وعلى القميص خطوط عاكسة أفقية رمادية/فضية على الصدر والظهر، وشعار أبيض صغير على الصدر، وكاب كحلي، وغالبًا كمامة وقفاز أسود وجوال في يده يصوّر.
عمال المطعم لابسين قميص بني، والمشرفين ثوب أبيض — هذولا مو مفتشين. الزباين بلبس عادي.
قل inspector=true بس لو فيه شخص بهالزي بالذات (الكحلي مع الخطوط العاكسة). لو مو متأكد خل الثقة أقل من 60.`;

let busy = false, prev = null, lastRun = 0;
const state = { last: null, last_hit: getSetting('inspect_cam_at') || null, checks: 0, ai_calls: 0 };

// بصمة صغيرة (٣٢×١٨ رمادي) — لو ما تغيّرت ما نسأل الذكاء
async function thumb(buf) { return require('sharp')(buf).resize(32, 18, { fit: 'fill' }).greyscale().raw().toBuffer(); }
const diff = (a, b) => { if (!a || !b || a.length !== b.length) return 255; let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
const drop = sid => { const s = get('SELECT * FROM cam_snaps WHERE id = ?', sid); if (!s) return; try { fs.unlinkSync(path.join(CAM.DIR, path.basename(s.file))); } catch { /* */ } run('DELETE FROM cam_snaps WHERE id = ?', sid); };

async function tick({ send, force = false, snaps = null, chans: only = null } = {}) {
  const c = cfg();
  if (busy) return null;
  if (!force && !only && (!c.on || c.mode !== 'interval' || Date.now() - lastRun < c.every * 1000 - 500 || !inHours(c))) return null;
  if (!getSetting('cam_bridge_token') || !(AI.apiKey() || process.env.AI_FIXTURE)) return null;
  const hitAt = Date.parse(getSetting('inspect_cam_at') || '') || 0;
  if (!force && Date.now() - hitAt < COOLDOWN) return null;
  busy = true; lastRun = Date.now();
  const chans = only || CAM.byRole('cashier');
  const ids = [], keep = !!snaps; // لقطات جاهزة (تجربة على التسجيل) ما تنمسح
  try {
    if (snaps) ids.push(...snaps.filter(id => get('SELECT 1 AS x FROM cam_snaps WHERE id = ?', id)));
    else if (chans.length) ids.push(...(await Promise.all(chans.map(ch => CAM.snapNow(ch, 'inspect', 'inspect', 15000)))).filter(Boolean));
    if (!ids.length) return null;
    state.checks++;
    const sharp = require('sharp');
    const W = 640, H = 480;
    const tiles = await Promise.all(ids.map(async (sid, i) => ({ input: await sharp(CAM.file(get('SELECT * FROM cam_snaps WHERE id = ?', sid))).resize(W, H, { fit: 'fill' }).toBuffer(), left: i * W, top: 0 })));
    const img = await sharp({ create: { width: W * ids.length, height: H, channels: 3, background: '#000' } }).composite(tiles).jpeg({ quality: 70 }).toBuffer();
    const t = await thumb(img), d = diff(t, prev); prev = t;
    state.last = new Date().toISOString();
    if (!force && !only && d < 4) return { skipped: 'ما تغيّر شي' }; // نفس المنظر => ما نصرف
    AI.checkCap();
    state.ai_calls++;
    const res = await AI.create('fast', { max_tokens: 200, messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img.toString('base64') } }, { type: 'text', text: PROMPT }] }],
    output_config: { format: { type: 'json_schema', schema: SCHEMA } } }, { kind: 'inspect', imgKind: 'chat' });
    let r = {}; try { r = JSON.parse(AI.textOf(res)); } catch { /* */ }
    AI.log(null, 'inspect', 'لقطة الكاشير', JSON.stringify(r), AI.costOf(res.usage, 'fast'), AI.MODELS.fast.id);
    if (!(r.inspector && Number(r.confidence) >= 60)) return { inspector: false };
    // 🚨 لقيناه
    setSetting('inspect_cam_at', new Date().toISOString()); state.last_hit = getSetting('inspect_cam_at');
    ids.length = 0; // اللقطات تقعد (دليل)
    if (send) await send(img, `⚠️ *إجادة في المحل الحين!*\nتأكدوا على طول: الزي، القفازات 🧤، غطا الراس، الكمام، الجزم (ما فيه صنادل)، نظافة المكان، والأكل مغطى… وما أحد قاعد على جواله 🙏${r.note ? `\n\n(${r.note})` : ''}`).catch(e => console.error('inspect send', e.message));
    return { inspector: true, confidence: r.confidence, note: r.note };
  } catch (e) { console.error('inspect watch', e.message); return { error: e.message }; }
  finally { if (!keep) for (const sid of ids) drop(sid); busy = false; }
}

// 🔔 جهاز التسجيل قال «دخل شخص» في كاميرا => فحص وحدة (مرة كل ٨ ثواني بالأكثر)
let lastEvent = 0;
async function onEvent(ch, type, send) {
  state.events = (state.events || 0) + 1; state.last_event = new Date().toISOString();
  const c = cfg();
  if (!c.on || c.mode !== 'events' || !inHours(c) || Date.now() - lastEvent < 8000) return null;
  if (Date.now() - (Date.parse(getSetting('inspect_cam_at') || '') || 0) < COOLDOWN) return null;
  lastEvent = Date.now();
  return tick({ send, chans: [ch] });
}

function status() {
  const c = cfg(), perDay = c.on && c.mode === 'interval' ? Math.round(((c.to - c.from) * 3600) / c.every) : 0;
  return { ...c, ...state, per_day: perDay, events_seen: getSetting('cam_events_seen') || null, // كم فحص باليوم (أقصى) — أغلبها ما توصل الذكاء لو المنظر ما تغيّر
    ai_month: all("SELECT COALESCE(SUM(cost), 0) AS c FROM ai_log WHERE kind = 'inspect' AND at >= date('now', 'start of month')")[0].c };
}

module.exports = { tick, onEvent, status, inHours };
