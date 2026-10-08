'use strict';
// ربط الأسماء حتى لو اختلفت الكتابة (حنيذ/حنيد، موية/مويه/ماء، ...)

// مرادفات على مستوى الكلمة (بعد التطبيع)
const WORD_SYN = {
  'ماء': 'مويه', 'مويا': 'مويه', 'ميه': 'مويه', 'مياه': 'مويه', 'موي': 'مويه',
  'سيفن': 'سفن', 'بيبس': 'بيبسي', 'ببسي': 'بيبسي', 'رجيم': 'دايت', 'دايات': 'دايت',
  'حنيد': 'حنيذ', 'مكشنه': 'مكشن', 'لحوحه': 'لحوح', 'نص': 'نصف', 'فته': 'فته',
};
// كلمات أعداد تنحذف من الاسم (الكمية تجي لحالها)
const NUM_WORDS = new Set(['واحد', 'واحده', 'اثنين', 'اثنان', 'ثنين', 'ثلاث', 'ثلاثه', 'اربع', 'اربعه', 'خمس', 'خمسه', 'ست', 'سته', 'سبع', 'سبعه', 'ثمان', 'ثمانيه', 'تسع', 'تسعه', 'عشر', 'عشره', 'عشرين', 'ثلاثين', 'اربعين', 'خمسين', 'ستين', 'سبعين', 'ثمانين', 'تسعين', 'حبه', 'حبات', 'عدد', 'x']);
const PHRASE_SYN = [[' سفن اب ', ' سفن '], [' 7 اب ', ' سفن '], [' سفن ب ', ' سفن ']];

function normalize(s) {
  let t = String(s || '').toLowerCase();
  t = t.replace(/[ً-ْٰـ]/g, '');           // تشكيل وتطويل
  t = t.replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي');
  t = t.replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  t = t.split(/\s+/).filter(Boolean).map(w => (w.length > 3 && w.startsWith('ال') ? w.slice(2) : w)).join(' ');
  t = t.split(' ').filter(w => !NUM_WORDS.has(w) && !/^\d+([.,]\d+)?$/.test(w)).map(w => WORD_SYN[w] || w).join(' ');
  t = ' ' + t + ' ';
  for (const [a, b] of PHRASE_SYN) t = t.split(a).join(b);
  return t.replace(/\s+/g, ' ').trim();
}

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// تشابه 0..1 بين نصّين بعد التطبيع
function similarity(a, b) {
  const x = normalize(a), y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const ed = 1 - lev(x, y) / Math.max(x.length, y.length);
  const tx = new Set(x.split(' ')), ty = new Set(y.split(' '));
  let common = 0;
  for (const w of tx) {
    if (ty.has(w)) { common++; continue; }
    for (const v of ty) if (w.length > 2 && v.length > 2 && 1 - lev(w, v) / Math.max(w.length, v.length) >= 0.75) { common += 0.8; break; }
  }
  const tok = common / Math.max(tx.size, ty.size);
  const contain = (x.includes(y) || y.includes(x)) ? 0.85 : 0;
  return Math.max(ed, tok, contain * Math.min(x.length, y.length) / Math.max(x.length, y.length) + (contain ? 0.1 : 0));
}

// candidates: [{id, label}] ; aliases: Map(normalizedAlias -> id)
function bestMatch(name, candidates, aliases) {
  const n = normalize(name);
  if (aliases && aliases.has(n)) return { id: aliases.get(n), score: 1 };
  let best = null;
  for (const c of candidates) {
    const s = similarity(name, c.label);
    if (!best || s > best.score) best = { id: c.id, score: s };
  }
  return best && best.score >= 0.55 ? best : { id: null, score: best ? best.score : 0 };
}

module.exports = { normalize, similarity, bestMatch };
