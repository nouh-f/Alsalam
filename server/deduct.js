'use strict';
// ✂️ الخصم من الواتساب (القروب أو الخاص) — مكان واحد للقاعدة:
// - يتنفذ خصمهم: المالك + مشرفين المحل (wa_deduct_ids، الافتراضي خلوف وإبراهيم وعمار). مشرفين برا المحل يطّلعون بس.
// - على عامل/مشتري => ينسجل في الرواتب على طول، والعامل يوصله خبر، ونوح يدري لو كتبه مشرف
// - على مشرف (وكاتبه مو المالك) => كرت تأكيد لنوح
const { all, get, run, getSetting } = require('./db');

const deps = { send: null, ownerCard: null }; // whatsapp.js يعبيها

// فاضي = كل المشرفين (نوح: «المشرف يخصم، مو كل شي يروح لي»)
const allowedIds = () => {
  const ids = String(getSetting('wa_deduct_ids') || '').split(/[,\s،]+/).map(Number).filter(Boolean);
  return ids.length ? ids : all("SELECT id FROM users WHERE role = 'supervisor' AND active = 1").map(r => r.id);
};
const canDeduct = u => !!u && (u.role === 'owner' || allowedIds().includes(u.id));
const NOT_ALLOWED = 'الخصم لنوح ومشرفين المحل بس 🙏 — لو تشوف شي يستاهل خصم بلّغ نوح.';
const owner = () => get("SELECT * FROM users WHERE role = 'owner' AND active = 1 AND bot = 0 AND phone != '' ORDER BY id LIMIT 1");
const dayWage = w => Math.round((Number((get('SELECT salary FROM users WHERE id = ?', w.id) || {}).salary) || 0) / 30);

// 📋 جدول المخالفات (نوح اعتمده): السبب => المبلغ. المشرف يكتب «خصم فلان تأخير» والمبلغ من هنا (حتى لو كتب رقم ثاني).
// المالك: رقمه هو اللي يمشي، ولو ما كتب رقم => من الجدول. الترتيب مهم (الأدق أول)
const RULES = [
  [/غياب|غايب|ما\s*جا|ماجا/, 'day', 'غياب'],
  [/(تأخ|تاخ|متأخر).*ساع|ساع.*(تأخ|تاخ)/, 50, 'تأخير أكثر من ساعة'],
  [/تأخ|تاخ|متأخر/, 20, 'تأخير'],
  [/زبون|زباين|زبائن|صياح|صراخ|أسلوب|اسلوب|معامل/, 100, 'معاملة سيئة مع زبون'],
  [/متعمد|تزوير/, 50, 'تسجيل غلط متعمد'],
  [/نقص|ناقص/, 50, 'نقص بدون تبرير'],
  [/جرد/, 20, 'ما دخّل جرده في وقته'],
  [/غطا|طاقية|كاب|قفاز|شراب|كمام/, 20, 'بدون غطا الراس أو القفاز أو شراب اليد أو الكمام'],
  [/\bزي\b|الزي|قميص|يونيفورم/, 20, 'بدون الزي'],
  [/شبشب|صندل|نعال/, 20, 'شبشب وقت الشغل'],
  [/جوال|تلفون/, 20, 'الجوال وقت الشغل'],
  [/قاعد|جالس|نايم/, 20, 'قاعد وقت الشغل'],
  [/ممسح|سطل|أكياس|اكياس|نظاف|وساخ|وسخ/, 20, 'النظافة / أدوات قدام الزباين'],
];
function tableFine(why, w) {
  const r = RULES.find(([re]) => re.test(String(why || ''))); if (!r) return null;
  return { amount: r[1] === 'day' ? dayWage(w) : r[1], rule: r[2] };
}

// خصم واحد. where = اسم القروب أو «الخاص». يرجّع { done, card, text }
function deduct({ by, worker: w, amount, reason, date, where }) {
  amount = Math.round(Number(amount) * 100) / 100;
  const t = tableFine(reason, w);
  const fromTable = !!(t && t.amount > 0 && (by.role !== 'owner' || !(amount > 0)));
  if (fromTable) amount = t.amount;
  if (!(amount > 0)) return { error: 'كم المبلغ؟ (السبب مو في جدول المخالفات)' };
  const why = (String(reason || '').trim() || 'خصم') + (fromTable ? ' (حسب جدول المخالفات)' : '');
  const note = `${why} (${by.name} في ${where})`;
  const title = `خصم ${w.name} ${amount} ريال`;
  const msg = `انخصم عليك ${amount} ريال — ${why}${where === 'الخاص' ? '' : ` (${where})`}`;
  const body = { user_id: w.id, type: 'deduct', amount, note, date };
  if (by.role !== 'owner' && !['worker', 'purchaser'].includes(w.role)) {
    const card = { id: 'd' + Date.now(), type: 'deduct', title, lines: [why, `كتبه ${by.name} في ${where}`], requests: [{ endpoint: '/api/payroll', body }],
      notify: w.phone ? [{ phone: w.phone, text: msg }] : [] };
    return { done: false, card, text: `${title} — على مشرف، فراح لنوح يأكده` };
  }
  run('INSERT INTO payroll(user_id, date, type, amount, note, month) VALUES(?,?,?,?,?,?)', w.id, date, 'deduct', amount, note, '');
  const send = deps.send;
  if (send) {
    if (w.phone) send(w.phone, msg).catch(() => {});
    const o = owner();
    if (o && o.id !== by.id) send(o.phone, `✓ انسجل ${title} — ${why} (كتبه ${by.name} في ${where}). لو تبغى تلغيه: «الغي الخصم على ${w.name}».`).catch(() => {});
  }
  return { done: true, text: `✓ اتسجل ${title} — ${why}` };
}

module.exports = { deps, deduct, tableFine, RULES, canDeduct, allowedIds, dayWage, owner, NOT_ALLOWED, staff: () => all('SELECT id, name, phone, role FROM users WHERE active = 1 AND bot = 0') };
