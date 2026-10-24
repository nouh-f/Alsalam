'use strict';
// 👀 مراقبة المحل: كل «floor_every» دقيقة لقطة من كل الكاميرات، والرخيص (Haiku) يشوف الغلط:
// الزي، غطا الراس، القفاز، شراب اليد، الكمام، الشبشب، الجوال، القعدة، غريب في المطبخ، أدوات تنظيف قدام الزباين، الوساخة، الكاشير فاضي.
// اللي يطلع غلط => الأقوى (Sonnet) يتأكد على صورة الكاميرا نفسها => تنبيه بالصورة (لنوح بس أول، وبعدين للمشرفين).
// نفس الغلط في نفس الكاميرا ما يتكرر قبل «floor_repeat» دقيقة. وكل جولة تحط درجة لكل كاميرا => تقرير آخر اليوم بالنسبة.
// والحدث (جهاز التسجيل قال «حركة» في كاميرا من «floor_event_chans») => فحص على طول لهالكاميرا بس (مرة كل «floor_event_gap» دقيقة).
const fs = require('node:fs');
const path = require('node:path');
const { all, get, run, getSetting, setSetting, UPLOAD_DIR } = require('./db');
const CAM = require('./cameras');
const AI = require('./ai');
const C = require('./calc');

const KINDS = {
  uniform: 'بدون الزي', cap: 'بدون غطا الراس', gloves: 'بدون قفاز', sleeves: 'بدون شراب اليد', mask: 'بدون كمام',
  shoes: 'شبشب/صندل', phone: 'على الجوال', sitting: 'قاعد وقت الشغل', stranger: 'غريب أو أطفال في المطبخ',
  tools: 'أدوات تنظيف/أكياس قدام الزباين', dirty: 'المكان وسخ', food: 'أكل مكشوف', cashier: 'الكاشير فاضي والزباين ينتظرون', other: 'غيره',
};
const list = k => { try { return JSON.parse(getSetting(k) || '[]').map(Number).filter(Boolean); } catch { return []; } };
const cfg = () => ({
  on: getSetting('floor_watch', '0') === '1',
  every: Math.max(2, Number(getSetting('floor_every', '5')) || 5), // دقايق
  from: Number(getSetting('floor_from', '7')), to: Number(getSetting('floor_to', '25')), // ساعات الدوام (25 = ١ الفجر)
  repeat: Math.max(10, Number(getSetting('floor_repeat', '45')) || 45), // دقايق — نفس الغلط ما يتكرر قبلها
  sups: getSetting('floor_sups', '0') === '1', // الأسبوع الأول لنوح بس
  chans: list('floor_chans'), // فاضي = كل الكاميرات
  event_chans: list('floor_event_chans'),
  event_gap: Math.max(1, Number(getSetting('floor_event_gap', '3')) || 3),
  skip: (getSetting('floor_skip', '') || '').split(',').map(s => s.trim()).filter(Boolean), // أنواع غلط نوح قال ما يبغاها
});
const inHours = (c, h = C.riyadhHour()) => (c.to > 24 ? h >= c.from || h < c.to - 24 : h >= c.from && h < c.to);
const camName = ch => (get('SELECT name FROM cam_channels WHERE ch = ?', ch) || {}).name || `كاميرا ${ch}`;
const camRole = ch => (get('SELECT role FROM cam_channels WHERE ch = ?', ch) || {}).role || '';

const RULES = `أنت مشرف في مطعم «السلام» (أكل يمني شعبي) تشوف لقطات من كاميرات المحل (من فوق). تحت كل لقطة رقمها واسم مكانها.
عمال المطعم: قميص/تيشيرت بني. في المطبخ لازم: غطا راس (كاب أو طاقية)، قفاز، شراب اليد (كم أسود على الساعد)، كمام، وجزمة مقفولة.
اللي يقدّم في الصالة والعوائل: قميص بني وجزمة مقفولة. المشرفين بثوب أبيض (عادي، مو غلط). الزباين لبسهم عادي — الزبون ما يتسجّل عليه شي أبدًا.
سجّل غلط بس لو واضح في الصورة:
- uniform: عامل يشتغل (في المطبخ أو ورا الكاشير أو يقدّم) بدون القميص البني (تيشيرت أبيض/ملوّن).
- cap / gloves / sleeves / mask: عامل في المطبخ يشتغل في الأكل بدونها (لو ما تبان اليد أو الوجه لا تسجّل).
- shoes: عامل في المطبخ أو يقدّم وهو لابس شبشب/صندل.
- phone: عامل ماسك جواله ويطالع فيه وقت الشغل.
- sitting: عامل قاعد في المطبخ أو الكاشير والشغل قايم (مو وقت فاضي).
- stranger: شخص مو عامل (لبس عادي) أو أطفال داخل المطبخ.
- tools: ممسحة/سطل/خرقة/أكياس زبالة/كراتين مرمية في مكان الزباين أو قدام الكاشير.
- dirty: أرض أو طاولة وسخة بوضوح (أكل مكبوب، ماء، زبالة)، أو طاولة زباين ما انشالت بعد ما قاموا بوقت.
- food: أكل أو لحم/سمك مكشوف برا الثلاجة بدون غطا وما أحد يشتغل فيه.
- cashier: الكاشير ما فيه أحد وفيه زباين واقفين ينتظرون.
لكل غلط: tile = رقم اللقطة، who = وصف الشخص بالشكل (وين واقف ولبسه) بدون أسماء، note = جملة قصيرة، confidence 0-100.
وحط لكل لقطة score من 100: 100 = كل شي مضبوط، وتنقص على كل غلط حسب كبره. لقطة فاضية أو مظلمة = 100.
كلامك بالعربي البسيط (سعودي)، قصير.`;
const SCHEMA = { type: 'object', additionalProperties: false, required: ['tiles', 'findings'], properties: {
  tiles: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['tile', 'score'], properties: { tile: { type: 'integer' }, score: { type: 'integer' }, why: { type: 'string' } } } },
  findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['tile', 'kind', 'who', 'note', 'confidence'], properties: {
    tile: { type: 'integer' }, kind: { type: 'string', enum: Object.keys(KINDS) }, who: { type: 'string' }, note: { type: 'string' }, confidence: { type: 'integer' } } } } } };
const CONFIRM = `نموذج ثاني شاف هذي اللقطات وقال فيها الأغلاط اللي تحت. هو كثير يغلط (يحسب الزبون عامل، أو يقول «بدون قفاز» واليد ما تبان). تأكد بصرامة من كل واحد على الصورة نفسها.
أكّد بس اللي تشوفه بعينك واضح. الزبون ما يتسجّل عليه شي. المشرف بثوب أبيض مو غلط. لو شاك قل لا.`;
const CSCHEMA = { type: 'object', additionalProperties: false, required: ['ok'], properties: {
  ok: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['i', 'who', 'note', 'name'], properties: { i: { type: 'integer' }, who: { type: 'string' }, note: { type: 'string' },
    name: { type: 'string', description: 'اسم العامل من «صور العمال» لو متأكد إنه هو (الوجه أو الشكل واضح)، وإلا فارغ' } } } } } };
// 🧑‍🍳 صور العمال اللي نوح سمّاهم (٣ لكل عامل بالأكثر) — تروح مع التأكيد بس
const refs = () => {
  const out = [], per = new Map();
  for (const r of all('SELECT f.user_id, f.file, u.name FROM floor_refs f JOIN users u ON u.id = f.user_id WHERE u.active = 1 ORDER BY f.id DESC')) {
    if ((per.get(r.user_id) || 0) >= 3 || out.length >= 30) continue;
    try { out.push({ ...r, buf: fs.readFileSync(path.join(UPLOAD_DIR, path.basename(r.file))) }); per.set(r.user_id, (per.get(r.user_id) || 0) + 1); } catch { /* انمسحت */ }
  }
  return out;
};

let busy = false, lastRound = 0;
const lastEvent = new Map();
const state = { last: null, rounds: 0, ai_calls: 0, found: 0, sent: 0, rejected: 0 };
const drop = sid => { const s = get('SELECT * FROM cam_snaps WHERE id = ?', sid); if (!s) return; try { fs.unlinkSync(path.join(CAM.DIR, path.basename(s.file))); } catch { /* */ } run('DELETE FROM cam_snaps WHERE id = ?', sid); };
const allChans = () => { const c = cfg(); return c.chans.length ? c.chans : all('SELECT ch FROM cam_channels ORDER BY ch').map(r => r.ch); };
const img = buf => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } });
const hhmm = (at = new Date()) => { const d = new Date(new Date(at).getTime() + 3 * 3600e3); return `${d.getUTCHours() % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };

// جولة: لقطات (وحدة وحدة — مع بعض يرجع ٤٠٠ أحيانًا) => الرخيص => الأقوى يتأكد => تنبيه
async function round({ send, force = false, snaps = null, chans: only = null } = {}) {
  const c = cfg();
  if (busy) return null;
  if (!force && !only && (!c.on || Date.now() - lastRound < c.every * 60e3 - 2000 || !inHours(c))) return null;
  if (!getSetting('cam_bridge_token') || !(AI.apiKey() || process.env.AI_FIXTURE)) return null;
  busy = true; if (!only) lastRound = Date.now();
  const got = []; const keep = new Set(); const mine = !snaps;
  try {
    if (snaps) for (const id of snaps) { const s = get('SELECT * FROM cam_snaps WHERE id = ?', Number(id)); if (s) got.push(s); }
    else for (const ch of only || allChans()) { const sid = await CAM.snapNow(ch, 'floor', 'floor', 12000); if (sid) got.push(get('SELECT * FROM cam_snaps WHERE id = ?', sid)); }
    if (!got.length) return null;
    state.rounds++; state.last = new Date().toISOString();
    const bufs = got.map(s => CAM.file(s));
    const content = [];
    got.forEach((s, i) => { content.push({ type: 'text', text: `لقطة ${i + 1}: ${camName(s.ch)}` }, img(bufs[i])); });
    AI.checkCap();
    const res = await AI.create('fast', { max_tokens: 1500, messages: [{ role: 'user', content: [...content, { type: 'text', text: RULES }] }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } } }, { kind: 'floor', imgKind: 'cam' });
    state.ai_calls++;
    let r = {}; try { r = JSON.parse(AI.textOf(res)); } catch { /* */ }
    AI.log(null, 'floor', `جولة ${got.length} كاميرا`, JSON.stringify(r).slice(0, 2000), AI.costOf(res.usage, 'fast'), AI.MODELS.fast.id);
    const date = C.businessDate();
    for (const t of r.tiles || []) { const s = got[t.tile - 1]; if (s) run('INSERT INTO floor_rounds(date, ch, score, why) VALUES(?,?,?,?)', date, s.ch, Math.max(0, Math.min(100, Number(t.score) || 0)), String(t.why || '').slice(0, 200)); }
    // المستودع ما يدخله زباين => «أكياس/كراتين قدام الزباين» فيه مو غلط
    const cand = (r.findings || []).filter(f => got[f.tile - 1] && KINDS[f.kind] && Number(f.confidence) >= 60 && !c.skip.includes(f.kind)
      && !(f.kind === 'tools' && camRole(got[f.tile - 1].ch) === 'store'));
    if (!cand.length) return { found: 0 };
    // ✋ الأقوى يتأكد — بس على الكاميرات اللي فيها غلط
    const tiles = [...new Set(cand.map(f => f.tile))];
    const c2 = [];
    tiles.forEach(t => c2.push({ type: 'text', text: `لقطة ${t}: ${camName(got[t - 1].ch)}` }, img(bufs[t - 1])));
    const claims = cand.map((f, i) => `${i + 1}) لقطة ${f.tile} — ${KINDS[f.kind]}: ${f.who} (${f.note})`).join('\n');
    const R = refs(), gallery = R.length ? [{ type: 'text', text: 'صور العمال (عشان تعرف مين هو بس — مو لقطات للفحص):' }, ...R.flatMap(x => [{ type: 'text', text: `«${x.name}»` }, img(x.buf)])] : [];
    const res2 = await AI.create('mid', { max_tokens: 800, messages: [{ role: 'user', content: [...gallery, ...c2, { type: 'text', text: `${CONFIRM}\n\n${claims}\n\nرجّع أرقام اللي تأكدت منها بس (i)، ووصف الشخص (who) والملاحظة (note) بكلامك${R.length ? '، واسمه (name) لو شكله واضح يطابق واحد من «صور العمال» — لو شاك خله فارغ، الاسم الغلط أسوأ من بدون اسم' : '، و name فارغ'}.` }] }],
      output_config: { format: { type: 'json_schema', schema: CSCHEMA } } }, { kind: 'floor', imgKind: 'cam' });
    state.ai_calls++;
    let r2 = {}; try { r2 = JSON.parse(AI.textOf(res2)); } catch { /* */ }
    AI.log(null, 'floor', 'تأكيد المراقبة', JSON.stringify(r2).slice(0, 2000), AI.costOf(res2.usage, 'mid'), AI.MODELS.mid.id);
    const ok = (r2.ok || []).filter(o => cand[o.i - 1]);
    state.rejected += cand.length - ok.length;
    if (!ok.length) return { found: 0, rejected: cand.length };
    // 🔁 نفس الغلط في نفس الكاميرا ما يتكرر قبل «repeat» دقيقة
    const byCam = new Map();
    for (const o of ok) {
      const f = cand[o.i - 1], s = got[f.tile - 1];
      const recent = get(`SELECT at FROM floor_findings WHERE ch = ? AND kind = ? AND sent = 1 AND wrong = 0 AND at >= datetime('now', '-${c.repeat} minutes') ORDER BY id DESC LIMIT 1`, s.ch, f.kind);
      const again = !recent && get(`SELECT 1 AS x FROM floor_findings WHERE ch = ? AND kind = ? AND sent = 1 AND wrong = 0 AND at >= datetime('now', '-${c.repeat + 15} minutes')`, s.ch, f.kind);
      const who = R.find(x => x.name === String(o.name || '').trim());
      const id = Number(run('INSERT INTO floor_findings(date, ch, kind, who, note, snap_id, sent, user_id) VALUES(?,?,?,?,?,?,?,?)', date, s.ch, f.kind, String(o.who || f.who).slice(0, 200), String(o.note || f.note).slice(0, 300), s.id, recent ? 0 : 1, who ? who.user_id : null).lastInsertRowid);
      keep.add(s.id); state.found++;
      if (recent) continue;
      if (!byCam.has(s.ch)) byCam.set(s.ch, { s, buf: bufs[f.tile - 1], lines: [] });
      byCam.get(s.ch).lines.push(`${again ? '🔁 لسه: ' : '• '}${who ? `*${who.name}*: ` : ''}*${KINDS[f.kind]}* — ${o.who || f.who} (#${id})`);
    }
    for (const { s, buf, lines } of byCam.values()) {
      state.sent++;
      if (send) await send(buf, `👀 *${camName(s.ch)}* — ${hhmm()}\n${lines.join('\n')}`, { sups: c.sups }).catch(e => console.error('floor send', e.message));
    }
    return { found: ok.length, sent: byCam.size };
  } catch (e) { console.error('floor watch', e.message); return { error: e.message }; }
  finally { if (mine) for (const s of got) if (!keep.has(s.id)) drop(s.id); busy = false; }
}

// 🔔 جهاز التسجيل قال «حركة» في كاميرا نراقبها بالحدث => فحص لهالكاميرا بس
async function onEvent(ch, type, send) {
  const c = cfg();
  ch = Number(ch);
  if (!c.on || !c.event_chans.includes(ch) || !inHours(c) || busy) return null;
  if (Date.now() - (lastEvent.get(ch) || 0) < c.event_gap * 60e3) return null;
  lastEvent.set(ch, Date.now());
  state.events = (state.events || 0) + 1;
  return round({ send, chans: [ch] });
}

// 📊 تقرير اليوم: نسبة كل مكان (متوسط الدرجات) + كم غلط من كل نوع + أكثر الكاميرات
function report(date = C.businessDate()) {
  const rows = all('SELECT ch, AVG(score) AS avg, COUNT(*) AS n FROM floor_rounds WHERE date = ? GROUP BY ch ORDER BY ch', date);
  const areas = new Map();
  for (const r of rows) {
    const role = camRole(r.ch), name = CAM.ROLES[role] || camName(r.ch);
    const a = areas.get(name) || { sum: 0, n: 0 }; a.sum += r.avg * r.n; a.n += r.n; areas.set(name, a);
  }
  const f = all('SELECT kind, COUNT(*) AS n FROM floor_findings WHERE date = ? AND wrong = 0 GROUP BY kind ORDER BY n DESC', date);
  const total = rows.reduce((s, r) => s + r.avg * r.n, 0) / (rows.reduce((s, r) => s + r.n, 0) || 1);
  return { date, rounds: rows.reduce((m, r) => Math.max(m, r.n), 0), score: rows.length ? Math.round(total) : null,
    areas: [...areas].map(([name, a]) => ({ name, score: Math.round(a.sum / a.n) })),
    kinds: f.map(x => ({ kind: x.kind, label: KINDS[x.kind] || x.kind, n: x.n })),
    findings: all('SELECT f.id, f.at, f.ch, f.kind, f.who, f.note, f.snap_id, f.sent, u.name AS worker FROM floor_findings f LEFT JOIN users u ON u.id = f.user_id WHERE f.date = ? AND f.wrong = 0 ORDER BY f.id', date).map(x => ({ ...x, cam: camName(x.ch), label: KINDS[x.kind] || x.kind })) };
}
function reportText(r) {
  if (r.score == null) return '';
  return [`📊 *مراقبة المحل — ${r.date}*`, `الدرجة: *${r.score}٪* (${r.rounds} جولة)`, '',
    ...r.areas.map(a => `${a.score >= 90 ? '🟢' : a.score >= 75 ? '🟡' : '🔴'} ${a.name}: ${a.score}٪`),
    ...(r.kinds.length ? ['', '*الأغلاط:*', ...r.kinds.map(k => `• ${k.label}: ${k.n}`)] : ['', 'ما فيه أغلاط 👍'])].join('\n');
}
// آخر الدوام: التقرير لنوح مرة وحدة
async function dailyReport(sendText) {
  const c = cfg();
  if (!c.on || inHours(c)) return null;
  const date = C.businessDate(new Date(Date.now() - 2 * 3600e3)); // الدوام خلص — اليوم اللي قبل شوي
  if (getSetting('floor_report_for') === date) return null;
  const r = report(date); const t = reportText(r);
  setSetting('floor_report_for', date);
  if (t && sendText) await sendText(t);
  return r;
}
// ✂️ الرد على التنبيه: «فؤاد» => نفس الغلط | «فؤاد جوال» => الغلط اللي قاله | «ما في مشكلة» => ينشال
// الخصم من جدول المخالفات (floor_fines، يتعدّل) وينسجل على طول، والعامل توصله الصورة والسبب والوقت
const FINE_DEFAULT = 20;
const fines = () => { try { return JSON.parse(getSetting('floor_fines') || '{}'); } catch { return {}; } };
const fineOf = kind => { const f = fines(); return Number(f[kind] ?? f.default ?? FINE_DEFAULT) || 0; };
const WORDS = [[/جوال|تلفون/, 'phone'], [/قفاز|جوانتي/, 'gloves'], [/شراب|كم اليد|الساعد/, 'sleeves'], [/كمام|كمامة/, 'mask'], [/شبشب|صندل|نعال/, 'shoes'],
  [/غطا|طاقية|كاب|شعر/, 'cap'], [/زي|قميص|تيشيرت/, 'uniform'], [/قاعد|جالس|نايم/, 'sitting'], [/ممسحة|سطل|أكياس|اكياس|كراتين/, 'tools'], [/وسخ|وساخة|نظاف/, 'dirty'], [/مكشوف/, 'food']];
const NO_ISSUE = /ما\s*(في|فيه|فيها)\s*(مشكل|شي|غلط)|مو\s*(غلط|مشكل)|مافي\s*مشكل|مافيه|غلط\s*منك|تجاهل/;
const idOf = (text, quoted) => { const m = /#\s*(\d+)/.exec(quoted || '') || /#\s*(\d+)/.exec(text || ''); return m && (quoted ? /👀/.test(quoted) : true) ? Number(m[1]) : null; };
async function decide({ by, text, quoted, deduct, sendImage }) {
  const fid = idOf(text, quoted); if (!fid) return null;
  const f = get('SELECT * FROM floor_findings WHERE id = ?', fid); if (!f) return `ما لقيت التنبيه #${fid}`;
  const t = String(text || '').replace(/#\s*\d+/, '').trim();
  if (f.decided_by) return `#${fid} انحسم قبل${f.fine ? ` (انخصم ${f.fine} ريال)` : ' (ما فيه مشكلة)'}`;
  if (NO_ISSUE.test(t)) { run('UPDATE floor_findings SET wrong = 1, decided_by = ? WHERE id = ?', by.id, fid); return `✓ #${fid} انشال — ما فيه شي على أحد`; }
  const staff = all("SELECT * FROM users WHERE active = 1 AND bot = 0 AND role != 'owner'").sort((a, b) => b.name.length - a.name.length);
  const w = staff.find(x => t.includes(x.name)) || staff.find(x => t.includes(x.name.split(' ')[0]) && staff.filter(y => y.name.split(' ')[0] === x.name.split(' ')[0]).length === 1);
  if (!w) return `#${fid}: مين العامل؟ اكتب اسمه مثل ما هو في النظام (مثال: «فؤاد» أو «فؤاد جوال»)`;
  const rest = t.replace(w.name, '').replace(w.name.split(' ')[0], '');
  const kind = (WORDS.find(([re]) => re.test(rest)) || [])[1] || f.kind, label = KINDS[kind] || kind, amount = fineOf(kind);
  const at = `${hhmm(f.at.replace(' ', 'T') + 'Z')}`, cam = camName(f.ch);
  const res = amount > 0 ? deduct({ by, worker: w, amount, reason: `${label} — ${cam} الساعة ${at}`, date: f.date, where: 'الخاص' }) : { done: true };
  if (res.error) return '⚠️ ' + res.error;
  run('UPDATE floor_findings SET user_id = ?, kind = ?, decided_by = ?, fine = ? WHERE id = ?', w.id, kind, by.id, res.done ? amount : 0, fid);
  // الصورة للعامل (الخصم نفسه وصله نص من deduct)
  const s = f.snap_id && get('SELECT * FROM cam_snaps WHERE id = ?', f.snap_id);
  if (s && w.phone && sendImage) { try { await sendImage(w.phone, CAM.file(s), `📷 ${label} — ${cam} الساعة ${at}${amount ? `\nالخصم ${amount} ريال حسب جدول المخالفات` : ''}`); } catch { /* */ } }
  return res.done ? `✓ ${w.name}: ${label} — انخصم ${amount} ريال، ووصلته الصورة` : res.text;
}

// ❌ نوح قال «هذا غلط» => ما يدخل في التقرير
const wrong = id => run('UPDATE floor_findings SET wrong = 1 WHERE id = ?', Number(id));

function status() {
  const c = cfg(), perDay = c.on ? Math.round(((c.to - c.from) * 60) / c.every) : 0;
  return { ...c, ...state, busy, per_day: perDay, kinds: KINDS, fines: Object.fromEntries(Object.keys(KINDS).map(k => [k, fineOf(k)])),
    ai_month: all("SELECT COALESCE(SUM(cost), 0) AS c FROM ai_log WHERE kind = 'floor' AND at >= date('now', 'start of month')")[0].c,
    ai_today: all("SELECT COALESCE(SUM(cost), 0) AS c FROM ai_log WHERE kind = 'floor' AND at >= datetime('now', '-24 hours')")[0].c };
}

module.exports = { round, onEvent, report, reportText, dailyReport, wrong, decide, fines, status, inHours, KINDS };
