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
  const res = await AI.create('strong', { max_tokens: 6000, output_config: { format: { type: 'json_schema', schema: SCHEMA } }, messages: [{ role: 'user', content: prompt }] });
  const cost = AI.costOf(res.usage, 'strong');
  let r; try { r = JSON.parse(AI.textOf(res)); } catch { r = { lessons: [] }; }
  const owner = get("SELECT * FROM users WHERE role = 'owner' AND active = 1 AND bot = 0 ORDER BY id LIMIT 1") || { id: null };
  const ids = (r.lessons || []).slice(0, 10).map(l => SG.add(owner, { kind: 'learn', summary: `📘 ${l.text}${l.why ? ` (عرفتها من: ${l.why})` : ''}`, action: { learn: { topic: l.topic, text: l.text, source: 'review' } } }));
  AI.log(null, 'kb_review', 'مراجعة الأسبوع', `${ids.length} درس`, cost, AI.MODELS.strong.id);
  return { lessons: r.lessons || [], ids, cost };
}

module.exports = { TOPICS, seed, seed2, seed3, add, list, text, generated, weeklyReview };
