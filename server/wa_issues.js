'use strict';
// 🛠️ مشاكل الشغل من القروب: تنسجل كلها. لو مشرف/المالك كتب مشكلة على عامل => متابعة بالتدرّج في الخاص:
// ١) تذكير لطيف  ٢) تنبيه واضح  ٣+) توصل للمالك يقرر (ولا خصم بدون قراره). التصحيح في الخاص، والمدح في القروب.
const { all, get, run } = require('./db');
const C = require('./calc');

const TYPES = {
  late: 'تأخير', absent: 'غياب', count: 'الجرد', cleanliness: 'النظافة', behavior: 'التعامل', waste: 'هدر/خراب أكل',
  order: 'طلب غلط/تأخر على زبون', customer: 'شكوى زبون', equipment: 'جهاز/عطل', supply: 'نقص بضاعة', other: 'ثانية',
};
const ABOUT_WORKER = new Set(['late', 'absent', 'count', 'cleanliness', 'behavior', 'waste', 'order', 'customer', 'other']);

// الكلام: محترم وواضح — وش الغلط ووش المطلوب
const STEP1 = (n, what, sum) => `السلام عليكم يا ${n} 🌹\nانذكر في القروب: ${sum}\nالله يعافيك انتبه لـ«${what}» المرة الجاية — نبغاك دايم مرتب 👍`;
const STEP2 = (n, what, sum) => `يا ${n}، هذي ثاني مرة هالشهر في «${what}»:\n${sum}\nنبغى نشوف التزام — المرة الجاية بيوصل الموضوع لنوح 🙏`;
const OWNER = (n, what, cnt, sums) => `🛠️ ${n}: «${what}» تكررت ${cnt} مرات هالشهر:\n${sums.map(s => '• ' + s).join('\n')}\n\nانبّه مرتين في الخاص. القرار لك: لو تبغى تخصم اكتب في القروب «خصم ${n} <المبلغ> ${what}»، أو كلمه وعطه فرصة.`;

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
    // يتابع العامل بس لو الكلام من مشرف/المالك، وعن عامل (مو عن نفسه)
    const follow = !!(w && isBoss && ABOUT_WORKER.has(type) && w.id !== by.id && w.role !== 'owner');
    let step = 0;
    if (follow) step = get("SELECT COUNT(*) AS n FROM wa_issues WHERE user_id = ? AND type = ? AND step > 0 AND date LIKE ?", w.id, type, month + '%').n + 1;
    run("INSERT INTO wa_issues(date, user_id, type, summary, by_id, chat, step, at) VALUES(?,?,?,?,?,?,?,datetime('now'))", today, w ? w.id : null, type, summary, by.id, chat || '', step);
    if (!follow) continue;
    const what = TYPES[type];
    if (step === 1 && w.phone) { await send(w.phone, STEP1(w.name, what, summary)); out.push({ to: w.phone, step }); }
    else if (step === 2 && w.phone) { await send(w.phone, STEP2(w.name, what, summary)); out.push({ to: w.phone, step }); }
    else if (step >= 3) {
      const sums = all("SELECT summary FROM wa_issues WHERE user_id = ? AND type = ? AND step > 0 AND date LIKE ? ORDER BY id", w.id, type, month + '%').map(r => r.summary);
      for (const o of all("SELECT phone FROM users WHERE role = 'owner' AND active = 1 AND bot = 0 AND phone != ''")) { await send(o.phone, OWNER(w.name, what, step, sums)); out.push({ to: o.phone, step }); }
    }
  }
  return out;
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
    for (const r of b.rows) for (const [uid, done] of [[r.opening_user_id, r.opening != null || r.no_opening], [r.closing_user_id, r.closing != null]]) {
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

module.exports = { record, weekly, TYPES };
