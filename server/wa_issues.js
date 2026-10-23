'use strict';
// 🛠️ مشاكل الشغل من القروب: تتسجل كلها. لو مشرف/المالك كتب مشكلة على عامل => متابعة بالتدرّج في الخاص:
// ١) تذكير لطيف  ٢) تنبيه واضح  ٣+) «قرصة إذن»: خصم صغير لحاله (نوح طلبها — قلبه طيب وما بيخصم) ويزيد شوي لو تكرر، والمالك يدري ويقدر يلغيه
// العداد لكل نوع ويرجع صفر كل شهر. التصحيح في الخاص، والمدح في القروب.
const { all, get, run, getSetting } = require('./db');
const C = require('./calc');

const TYPES = {
  late: 'تأخير', absent: 'غياب', count: 'الجرد', cleanliness: 'النظافة', behavior: 'التعامل', waste: 'هدر/خراب أكل',
  order: 'طلب غلط/تأخر على زبون', customer: 'شكوى زبون', equipment: 'جهاز/عطل', supply: 'نقص بضاعة', system: 'مشكلة في النظام', other: 'ثانية',
};
const ABOUT_WORKER = new Set(['late', 'absent', 'count', 'cleanliness', 'behavior', 'waste', 'order', 'customer', 'other']);

// الكلام: محترم وواضح — وش الغلط ووش المطلوب
const STEP1 = (n, what, sum) => `السلام عليكم يا ${n} 🌹\nانذكر في القروب: ${sum}\nالله يعافيك انتبه لـ«${what}» المرة الجاية — نبغاك دايم مرتب 👍`;
const STEP2 = (n, what, sum) => `يا ${n}، هذي ثاني مرة هالشهر في «${what}»:\n${sum}\nنبغى نشوف التزام — المرة الجاية بيوصل الموضوع لنوح 🙏`;
const PINCH = (n, what, cnt, amount) => `يا ${n}، هذي ${cnt === 3 ? 'ثالث' : 'رقم ' + cnt} مرة هالشهر في «${what}»، فانخصم عليك ${amount} ريال — اعتبرها قرصة إذن 🤏\nنعرف إنك قدها، والشهر الجاي صفحة جديدة 💪`;
const OWNER = (n, what, cnt, amount, sums) => `🤏 قرصة إذن: ${n} — «${what}» تكررت ${cnt} مرات هالشهر، فانخصم عليه ${amount} ريال:\n${sums.map(s => '• ' + s).join('\n')}\n\nلو حنّيت عليه: امسحه من صفحة الرواتب.`;
// المرة الثالثة = المبلغ (الافتراضي 20)، وكل مرة بعدها تزيد نفسه — وأعلى شي wa_pinch_max (100)
const pinchAmount = step => Math.min(Number(getSetting('wa_pinch', '20')) * (step - 2), Number(getSetting('wa_pinch_max', '100')));

// 📜 لائحة الجزاءات (penalty_on = '1'): لكل نوع خطوات بالترتيب خلال الشهر — 0 = تذكير/تنبيه بدون خصم، رقم = خصم بالريال، «dN» = أجر N يوم
// الصغيرة تتدرج (تذكير، تنبيه، بعدين خصم)، والكبيرة خصم من أول مرة. الحد: الغلط ما يتعدى أجر ٥ أيام، والشهر ما يتعدى ربع الراتب — غيرها لنوح
const RULES = {
  late: [0, 0, 15, 30, 60], count: [0, 0, 15, 30, 60], waste: [0, 0, 15, 30, 60], order: [0, 0, 15, 30, 60], other: [0, 0, 15, 30, 60],
  cleanliness: [25, 50, 100], behavior: [100, 175, 250], customer: [75, 150, 250], absent: ['d1', 'd2', 'd3'],
};
const rules = () => { try { return { ...RULES, ...JSON.parse(getSetting('penalty_rules') || '{}') }; } catch { return RULES; } };
const penaltyOn = () => getSetting('penalty_on', '0') === '1';
function ruleAmount(type, step, w) {
  const steps = rules()[type] || rules().other, v = steps[Math.min(step, steps.length) - 1];
  if (typeof v === 'string' && /^d\d+$/.test(v)) return Math.round(Number(v.slice(1)) * (Number(w.salary) || 0) / 30);
  return Number(v) || 0;
}
function overCap(w, amount, month) {
  const sal = Number(w.salary) || 0; if (!sal) return '';
  if (amount > sal / 30 * 5) return 'أكثر من أجر ٥ أيام';
  const done = get("SELECT COALESCE(SUM(amount), 0) AS s FROM payroll WHERE user_id = ? AND type = 'deduct' AND date LIKE ?", w.id, month + '%').s;
  return done + amount > sal / 4 ? `مجموع خصمه هالشهر بيصير ${done + amount} (أكثر من ربع الراتب)` : '';
}
const RULE_MSG = (n, what, cnt, amount) => `يا ${n}، حسب لائحة المطعم: «${what}» ${cnt === 1 ? 'من أول مرة عليها خصم' : `هذي المرة رقم ${cnt} هالشهر`}، فانخصم عليك ${amount} ريال.\nنعرف إنك قدها 💪`;

// يسجل ويتابع. send(phone, text). يرجع وش انرسل (للاختبار)
async function record(issues, { by, chat, staff, send }) {
  const today = C.businessDate(), month = today.slice(0, 7), out = [];
  const isBoss = ['owner', 'supervisor'].includes(by.role);
  for (const x of issues) {
    const type = TYPES[x.type] ? x.type : 'other', summary = String(x.summary || '').trim().slice(0, 300);
    if (!summary) continue;
    const AS = require('./assistant');
    const m = x.employee ? AS.resolveItem(x.employee, staff) : null;
    const w = m && m.item ? staff.find(s => s.id === m.item.id) : null;
    // 🚫 غياب (من مشرف/المالك): ينسجل غياب في الحضور على طول — بدون تذكير ولا تنبيه ولا قرصة إذن (نوح طلب)
    if (type === 'absent' && w && isBoss && w.id !== by.id && w.role !== 'owner' && !penaltyOn()) {
      run("INSERT INTO wa_issues(date, user_id, type, summary, by_id, chat, step, at) VALUES(?,?,?,?,?,?,0,datetime('now'))", today, w.id, type, summary, by.id, chat || '');
      require('./attendance').markAbsent(w.id, today, `${summary} — قاله ${by.name}`);
      for (const o of all("SELECT phone FROM users WHERE role = 'owner' AND active = 1 AND bot = 0 AND phone != ''")) { await send(o.phone, `🚫 انسجل غياب: ${w.name} اليوم (قاله ${by.name})
${summary}`); out.push({ to: o.phone, absent: true }); }
      continue;
    }
    // يتابع العامل بس لو الكلام من مشرف/المالك، وعن عامل (مو عن نفسه)
    const follow = !!(w && isBoss && ABOUT_WORKER.has(type) && w.id !== by.id && w.role !== 'owner');
    let step = 0;
    if (follow) step = get("SELECT COUNT(*) AS n FROM wa_issues WHERE user_id = ? AND type = ? AND step > 0 AND date LIKE ?", w.id, type, month + '%').n + 1;
    run("INSERT INTO wa_issues(date, user_id, type, summary, by_id, chat, step, at) VALUES(?,?,?,?,?,?,?,datetime('now'))", today, w ? w.id : null, type, summary, by.id, chat || '', step);
    if (!follow) continue;
    const what = TYPES[type];
    if (penaltyOn()) { out.push(...await applyRule({ w, by, type, what, step, summary, today, month, send })); continue; }
    // ما له جوال => التذكير ما يوصل: نقول للمالك بدل ما يضيع
    if (!w.phone && step < 3) {
      for (const o of all("SELECT phone FROM users WHERE role = 'owner' AND active = 1 AND bot = 0 AND phone != ''")) { await send(o.phone, `⚠️ ما وصل ${step === 1 ? 'التذكير' : 'التنبيه'} لـ${w.name} («${what}»: ${summary}) — ما له جوال مسجل. حطه من صفحة الموظفين.`); out.push({ to: o.phone, step, no_phone: true }); }
      continue;
    }
    if (step === 1 && w.phone) { await send(w.phone, STEP1(w.name, what, summary)); out.push({ to: w.phone, step }); }
    else if (step === 2 && w.phone) { await send(w.phone, STEP2(w.name, what, summary)); out.push({ to: w.phone, step }); }
    else if (step >= 3) {
      const amount = pinchAmount(step);
      const sums = all("SELECT summary FROM wa_issues WHERE user_id = ? AND type = ? AND step > 0 AND date LIKE ? ORDER BY id", w.id, type, month + '%').map(r => r.summary);
      if (amount > 0) run('INSERT INTO payroll(user_id, date, type, amount, note, month) VALUES(?,?,?,?,?,?)', w.id, today, 'deduct', amount, `قرصة إذن: ${what} (${step} مرات هالشهر)`, '');
      if (w.phone && amount > 0) { await send(w.phone, PINCH(w.name, what, step, amount)); out.push({ to: w.phone, step }); }
      for (const o of all("SELECT phone FROM users WHERE role = 'owner' AND active = 1 AND bot = 0 AND phone != ''")) { await send(o.phone, OWNER(w.name, what, step, amount, sums)); out.push({ to: o.phone, step }); }
    }
  }
  return out;
}

// 📜 خطوة اللائحة: تذكير/تنبيه أو خصم — الخصم من نوح ومشرفين المحل بس، واللي فوق الحد يروح لنوح يقرر
async function applyRule({ w, by, type, what, step, summary, today, month, send }) {
  const out = [], owners = all("SELECT phone FROM users WHERE role = 'owner' AND active = 1 AND bot = 0 AND phone != ''");
  const full = get('SELECT * FROM users WHERE id = ?', w.id) || w, amount = ruleAmount(type, step, full);
  if (!amount) {
    const txt = step <= 1 ? STEP1(w.name, what, summary) : STEP2(w.name, what, summary);
    if (w.phone) { await send(w.phone, txt); out.push({ to: w.phone, step }); }
    else for (const o of owners) { await send(o.phone, `⚠️ ما وصل التنبيه لـ${w.name} («${what}»: ${summary}) — ما له جوال مسجل.`); out.push({ to: o.phone, step, no_phone: true }); }
    return out;
  }
  const D = require('./deduct'), cap = overCap(full, amount, month);
  if (!D.canDeduct(by) || cap) {
    for (const o of owners) { await send(o.phone, `📜 ${w.name} — «${what}» (المرة ${step} هالشهر): اللائحة تقول خصم ${amount} ريال، بس ${cap || `${by.name} مو من مشرفين المحل`} — قرارك. لو تبغاه: «اخصم على ${w.name} ${amount} ${what}».\n${summary}`); out.push({ to: o.phone, step, held: true }); }
    return out;
  }
  run('INSERT INTO payroll(user_id, date, type, amount, note, month) VALUES(?,?,?,?,?,?)', w.id, today, 'deduct', amount, `اللائحة: ${what} (المرة ${step}) (${by.name} في القروب)`, '');
  if (w.phone) { await send(w.phone, RULE_MSG(w.name, what, step, amount)); out.push({ to: w.phone, step }); }
  for (const o of owners) { await send(o.phone, `📜 انخصم على ${w.name} ${amount} ريال — «${what}» المرة ${step} هالشهر (كتبه ${by.name}):\n${summary}\nلو تبغى تلغيه: «الغي الخصم على ${w.name}».`); out.push({ to: o.phone, step }); }
  return out;
}

// نص اللائحة (للنشر في القروب بعد ما نوح يوافق)
function rulesText() {
  const r = rules(), f = v => typeof v === 'string' ? `أجر ${v.slice(1)} يوم` : v ? `${v} ريال` : null;
  const line = t => { const s = r[t] || []; const first = s.findIndex(Boolean); return `• ${TYPES[t]}: ${first > 0 ? `${first === 1 ? 'أول مرة تذكير' : 'أول مرة تذكير، وثاني مرة تنبيه'}، بعدها ` : 'من أول مرة '}${s.filter(Boolean).map(f).join(' ← ')}`; };
  return ['📜 *لائحة مطعم السلام*', '', 'الأغلاط الصغيرة (تتدرج):', ...['late', 'count', 'waste', 'order'].map(line), '', 'الأغلاط الكبيرة (خصم من أول مرة):', ...['behavior', 'customer', 'cleanliness', 'absent'].map(line),
    '', 'العداد يرجع صفر كل شهر. واللي يلتزم الشهر كامل له مكافأة 🌹'].join('\n');
}

// تقرير الأسبوع للمالك + مدح الملتزمين في القروب
function weekly(today = C.businessDate()) {
  const from = C.addDays(today, -6);
  const rows = all(`SELECT i.type, u.name FROM wa_issues i LEFT JOIN users u ON u.id = i.user_id WHERE i.date BETWEEN ? AND ?`, from, today);
  const byType = {};
  for (const r of rows) { const t = (byType[r.type] = byType[r.type] || { n: 0, who: {} }); t.n++; if (r.name) t.who[r.name] = (t.who[r.name] || 0) + 1; }
  const report = Object.entries(byType).sort((a, b) => b[1].n - a[1].n).map(([k, v]) =>
    `• ${TYPES[k] || k}: ${v.n}${Object.keys(v.who).length ? ` (${Object.entries(v.who).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join('، ')})` : ''}`);
  // الملتزم: جرد أول وآخر اليوم كله في وقته وبدون نقص، وبدون مشاكل عليه هالأسبوع
  const score = new Map(); // user => {days, bad}
  for (let d = from; d <= today; d = C.addDays(d, 1)) {
    const b = C.dailyBoard(d); if (!b.rows.some(r => r.opening != null || r.closing != null)) continue;
    for (const r of b.rows) for (const [uid, done] of [[r.opening_user_id, r.opening != null || r.no_opening || r.empty], [r.closing_user_id, r.closing != null || r.empty]]) {
      if (!uid) continue; const s = score.get(uid) || { days: new Set(), bad: 0 }; s.days.add(d);
      if (!done || (uid === r.closing_user_id && r.diff != null && r.diff > 0.0001)) s.bad++;
      score.set(uid, s);
    }
  }
  const flagged = new Set(all('SELECT DISTINCT user_id FROM wa_issues WHERE date BETWEEN ? AND ? AND step > 0', from, today).map(r => r.user_id));
  const stars = [...score.entries()].filter(([id, s]) => s.bad === 0 && s.days.size >= 3 && !flagged.has(id))
    .map(([id]) => (get("SELECT name, role FROM users WHERE id = ? AND active = 1 AND role != 'owner'", id) || {}).name).filter(Boolean);
  return { from, report, stars };
}

module.exports = { rulesText, RULES, record, weekly, TYPES };
