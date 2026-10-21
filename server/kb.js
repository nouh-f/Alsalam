'use strict';
// 📘 دليل المطعم: علم المحل اللي يكبر مع الوقت — ينقرا في كل محادثة مع المساعد
// يتعلم من: نوح والمشرفين (على طول)، العمال (اقتراح ونوح يوافق)، ومراجعة الخميس (اقتراحات)
const { all, get, run, getSetting, setSetting } = require('./db');

const TOPICS = ['عام', 'الأقسام والمسؤولين', 'الأصناف وطريقتها', 'الموردين', 'الشراء', 'الجرد', 'الكاش والورقة اليومية', 'التذاكر والكاشير', 'العمال والقواعد'];
const MAX = 20000;
const topicOf = t => TOPICS.includes(t) ? t : 'عام';

function seed() {
  if (getSetting('kb_seeded')) return;
  for (const [t, x] of require('./kb_seed')) run("INSERT INTO kb(topic, text, source, at) VALUES(?,?,'seed',datetime('now'))", t, x);
  setSetting('kb_seeded', '1');
}
// دفعات بذرة جديدة: تنضاف مرة وحدة (حتى لو الدليل بدأ قبلها)
const SEED2 = [
  ['الأصناف وطريقتها', 'استلام سمك الدعدع: محمد عبدالله يوزن السمك أول ما يوصل — يرسل صورة الميزان ويقول بالصوت وش الصنف وحالته (ديراك كامل، هامور…). صورتين لنفس الصنف = الوزنين ينجمعون. ينسجل «استلام» (propose_receive) آجل على الدعدع ينتظر الحساب، والكمية تدخل الجرد على طول.'],
  ['الموردين', 'حساب الدعدع يوصل العصر أو المغرب أو ثاني يوم — نوح يرسله، وتقارنه كيلو بكيلو مع اللي وزناه (match_invoice): الوزن عندنا ناقص = ناخذ الفرق منه، زايد = نسكت، أو مطابق.'],
  ['الجرد', 'الصنف اللي ما هو موجود وما انباع = صفر، ما يحتاج جرد. بس اللي انباع وما له جرد أول اليوم ولا استلام = غلط لازم المسؤول ينتبه له.'],
];
const SEED3 = [
  ['الأصناف وطريقتها', '⭐ مهم — سمك محمد عبدالله (كل السمك إلا الديراك: الديراك عند صادق بس): الثلاجة اللي ورا = المستودع، وثلاجة العرض = البيع. الاستلام بالوزن يروح ورا. لما يرسل صورة الميزان ويقول «أخذت/زودت هامور ٥» = نزل من ورا للعرض (propose_move pull) وينخصم من اللي ورا. آخر الدوام يوزن اللي باقي في العرض بس (propose_count closing) والباقي يرجع لحاله على اللي ورا. لو قال «هذا اللي ورا/الموجود» مع صور الميزان = جرد الثلاجة اللي ورا (propose_store_count).'],
  ['العمال والقواعد', 'محمد عبدالله ما يقرأ ولا يكتب: يكلمك بالصوت والصور، وردك عليه يوصله صوت — خله قصير جدًا وبسيط، وقله «قول تمام» للتأكيد.'],
];
const SEED4 = [
  ['الجرد', 'فؤاد (الإيدامات والمشكل): يرسل صورة الميزان بس (بدون كلام) لكل طبق أول الدوام — اعرف الطبق من شكله (بامية قطع خضرا، ملوخية شوربة خضرا غامقة، بطاطس مرق أحمر وقطع، مشكل فرن صينية)، واقرأ الوزن، والنفر يتحسب من نسبة الصنف (١ كجم = كم صحن) وينطرح الصحن الفاضي. لو مو متأكد من الطبق اسأله بكلمة.'],
];
const SEED5 = [
  ['الجرد', 'الأصناف اللي تقعد لبكرة تنجرد بالليل بس: الصبح = جرد أمس لحاله، واللي يزيد يكتب «أضفت». إلا عسل/سمن/سليط خلوف: يجردها الصبح عشان يشوف لو نقص شي بالليل. الدجاج المطبوخ والراس والمرق هالك (الباقي ينرمى). اللحوم (حنيذ لحم، مغش، برم): الزايد يطلع الثلاجة فوق.'],
];
const SEED6 = [
  ['الأصناف وطريقتها', '⭐ لحم عبدالله دعبوش (حنيذ لحم، مغش، برم صغير وكبير) — ثلاث أماكن: «المقسم» (اللي قسّمه من الذبيحة/السهوم، ني)، و«القديم» (المطبوخ اللي باقي من الأيام اللي فاتت في الثلاجة)، والمحل. «قسمت…» = propose_split (يروح المقسم). «طبخت حنيذ ٥» = propose_move pull (ينخصم من المقسم). «نزلت من القديم حنيذ ٢» = propose_move old. لو قال «أخذت/طبخت» وما وضّح، اسأله: «من المقسم ولا من القديم؟». آخر الليل: كم باقي من كل صنف (رقم واحد، propose_count closing) — الباقي من طبخ اليوم يطلع القديم لحاله، واللي نزل من القديم وما انباع هالك. «كم باقي في المقسم» = propose_store_count.'],
];
function seed6() {
  // النسخة الأولى (التقسيم ينزل المحل) غلط — تتحدث
  if (getSetting('kb_seeded_v6')) { if (getSetting('kb_seeded_v6') !== '2') { run("UPDATE kb SET text = ? WHERE source = 'seed' AND text LIKE '⭐ لحم عبدالله دعبوش%'", SEED6[0][1]); setSetting('kb_seeded_v6', '2'); } return; }
  for (const [t, x] of SEED6) run("INSERT INTO kb(topic, text, source, at) VALUES(?,?,'seed',datetime('now'))", t, x);
  setSetting('kb_seeded_v6', '2');
}
function seed5() {
  if (getSetting('kb_seeded_v5')) return;
  for (const [t, x] of SEED5) run("INSERT INTO kb(topic, text, source, at) VALUES(?,?,'seed',datetime('now'))", t, x);
  setSetting('kb_seeded_v5', '1');
}
function seed4() {
  if (getSetting('kb_seeded_v4')) return;
  for (const [t, x] of SEED4) run("INSERT INTO kb(topic, text, source, at) VALUES(?,?,'seed',datetime('now'))", t, x);
  setSetting('kb_seeded_v4', '1');
}
function seed3() {
  if (getSetting('kb_seeded_v3')) return;
  for (const [t, x] of SEED3) run("INSERT INTO kb(topic, text, source, at) VALUES(?,?,'seed',datetime('now'))", t, x);
  setSetting('kb_seeded_v3', '1');
}
function seed2() {
  if (getSetting('kb_seeded_v2')) return;
  for (const [t, x] of SEED2) run("INSERT INTO kb(topic, text, source, at) VALUES(?,?,'seed',datetime('now'))", t, x);
  setSetting('kb_seeded_v2', '1');
}
function add({ topic, text, by = null, source = 'owner', replaces = null }) {
  const t = String(text || '').trim().slice(0, 800);
  if (!t) throw Object.assign(new Error('وش أحفظ؟'), { status: 400 });
  if (replaces) run('UPDATE kb SET active = 0 WHERE id = ?', Number(replaces));
  return Number(run("INSERT INTO kb(topic, text, by_id, source, at) VALUES(?,?,?,?,datetime('now'))", topicOf(topic), t, by, source).lastInsertRowid);
}
const list = () => all('SELECT k.*, u.name AS by_name FROM kb k LEFT JOIN users u ON u.id = k.by_id WHERE k.active = 1 ORDER BY k.topic, k.id');

// اللي يتولّد من النظام نفسه: الأقسام ومسؤوليها، وطريقة كل صنف، والموردين
function generated() {
  const out = [];
  const secs = all(`SELECT s.name, o.name AS op, c.name AS cl, (SELECT COUNT(*) FROM items i WHERE i.section_id = s.id AND i.active = 1 AND i.daily = 1) AS n
    FROM sections s LEFT JOIN users o ON o.id = s.opening_user_id LEFT JOIN users c ON c.id = s.closing_user_id ORDER BY s.sort`).filter(s => s.n);
  if (secs.length) out.push('الأقسام: ' + secs.map(s => `${s.name}${s.op || s.cl ? ' (' + [s.op && 'يفتح ' + s.op, s.cl && 'يقفل ' + s.cl].filter(Boolean).join('، ') + ')' : ''}`).join('؛ '));
  const how = all("SELECT name, unit, note, parts FROM items WHERE active = 1 AND (note != '' OR parts != '') ORDER BY name LIMIT 80").map(i => {
    let p = null; try { p = i.parts ? JSON.parse(i.parts) : null; } catch { /* */ }
    return `${i.name} (${i.unit})${i.note ? ': ' + i.note : ''}${p && p.length ? ` — آخر اليوم: ${p.map(x => x.name + (x.factor !== 1 ? '×' + x.factor : '') + (x.drop ? ' يترمى' : '')).join(' + ')}` : ''}`;
  });
  if (how.length) out.push('طريقة الأصناف:\n' + how.map(x => '- ' + x).join('\n'));
  const sup = all('SELECT name FROM suppliers WHERE active = 1 ORDER BY name').map(s => s.name);
  if (sup.length) out.push('الموردين المسجلين: ' + sup.join('، '));
  return out.join('\n');
}

// النص اللي ينقرا في المحادثة (بلوك system مع الكاش)
function text() {
  const by = new Map();
  for (const k of list()) { if (!by.has(k.topic)) by.set(k.topic, []); by.get(k.topic).push(`- [${k.id}] ${k.text}`); }
  let t = `# دليل مطعم السلام (اللي تعلمته عن شغل المحل — امشِ عليه)\n${TOPICS.filter(x => by.has(x)).map(x => `\n## ${x}\n${by.get(x).join('\n')}`).join('\n')}`;
  const g = generated(); if (g) t += `\n\n## من النظام (يتحدث لحاله)\n${g}`;
  return t.slice(0, MAX);
}

// 🧊 النسخة اللي تروح لـ Claude: ثابتة لين الفجر (أو «حدّث الدليل الحين») — كل تعديل صغير كان يكسر الكاش ويدفع كتابته من جديد
function refreshFrozen() {
  const { setSetting } = require('./db');
  const t = text(); setSetting('kb_frozen', JSON.stringify({ at: new Date().toISOString(), day: require('./calc').businessDate(), text: t }));
  return t;
}
function frozen() {
  const { getSetting } = require('./db');
  let f = null; try { f = JSON.parse(getSetting('kb_frozen') || 'null'); } catch { /* */ }
  return f && typeof f.text === 'string' ? f.text : refreshFrozen();
}
// يتحدث مرة باليوم (أول نداء بعد بداية يوم العمل — الفجر)
function dailyRefresh() {
  const { getSetting } = require('./db');
  let f = null; try { f = JSON.parse(getSetting('kb_frozen') || 'null'); } catch { /* */ }
  if (!f || f.day !== require('./calc').businessDate()) { refreshFrozen(); return true; }
  return false;
}
const frozenInfo = () => { try { const f = JSON.parse(require('./db').getSetting('kb_frozen') || 'null'); return f ? { at: f.at, same: f.text === text() } : null; } catch { return null; } };

// 🔁 مراجعة الخميس: النموذج القوي يقرأ الأسبوع ويطلع «وش تعلمت» => اقتراحات لنوح
const SCHEMA = { type: 'object', additionalProperties: false, required: ['lessons'], properties: { lessons: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['topic', 'text', 'why'], properties: {
  topic: { type: 'string', enum: TOPICS }, text: { type: 'string', description: 'المعلومة الجديدة بجملة أو جملتين، تنحفظ في الدليل' }, why: { type: 'string', description: 'من وين عرفتها (مين قال/وش صار)' } } } } } };
async function weeklyReview() {
  const AI = require('./ai'), SG = require('./suggestions');
  AI.checkCap();
  const msgs = all("SELECT l.dir, l.text, l.at, u.name FROM wa_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.at >= datetime('now', '-7 days') AND l.phone NOT LIKE '%@g.us' ORDER BY l.id").map(m => `${m.dir === 'in' ? (m.name || '؟') : 'المساعد'}: ${String(m.text).slice(0, 300)}`);
  const issues = all("SELECT type, summary FROM wa_issues WHERE at >= datetime('now', '-7 days')").map(i => `${i.type}: ${i.summary}`);
  if (!msgs.length && !issues.length) return { lessons: [] };
  const prompt = `هذا دليل مطعم السلام الحالي:\n${text()}\n\nوهذي محادثات الواتساب مع المساعد هالأسبوع والمشاكل اللي انسجلت:\n${msgs.slice(-400).join('\n').slice(-60000)}\n\nالمشاكل:\n${issues.join('\n').slice(0, 8000)}\n\n`
    + 'طلّع الأشياء الجديدة اللي تعلمناها عن طريقة شغل المحل وما هي في الدليل: طريقة صنف، تصحيح فهم غلط، قاعدة، مين يسوي وش، مورد، أو غلط تكرر من المساعد وكيف يتجنبه. لا تطلع أرقام يومية ولا مبالغ ولا أسرار. ولا تكرر اللي في الدليل. أقصى ١٠.';
  const res = await AI.create('fast', { max_tokens: 3000, output_config: { format: { type: 'json_schema', schema: SCHEMA } }, messages: [{ role: 'user', content: prompt }] }, { kind: 'kb_review' });
  const cost = AI.costOf(res.usage, 'fast');
  let r; try { r = JSON.parse(AI.textOf(res)); } catch { r = { lessons: [] }; }
  const owner = get("SELECT * FROM users WHERE role = 'owner' AND active = 1 AND bot = 0 ORDER BY id LIMIT 1") || { id: null };
  const ids = (r.lessons || []).slice(0, 10).map(l => SG.add(owner, { kind: 'learn', summary: `📘 ${l.text}${l.why ? ` (عرفتها من: ${l.why})` : ''}`, action: { learn: { topic: l.topic, text: l.text, source: 'review' } } }));
  if (SG.auto() && owner.id) for (const id of ids) { try { await SG.decide(id, true, owner, async () => {}); } catch (e) { console.error('kb auto', e.message); } }
  AI.log(null, 'kb_review', 'مراجعة الأسبوع', `${ids.length} درس`, cost, AI.MODELS.fast.id);
  return { lessons: r.lessons || [], ids, cost };
}

module.exports = { TOPICS, seed, seed2, seed3, seed4, seed5, seed6, add, list, text, generated, weeklyReview, frozen, refreshFrozen, dailyRefresh, frozenInfo };
