'use strict';
// «📄 ورقة المصاريف»: ورقة مكتوبة باليد في المحل (نقص دجاج فاشتروا، حاسبوا فلان، غاز…)
// الذكاء الاصطناعي يقرأ كل سطر ويفرزه: شراء (صنف مخزون) / مصروف / سداد مورد — مسودة للمراجعة، ما ينحفظ شي هنا
const { all, get } = require('./db');
const AI = require('./ai');
const { similarity } = require('./match');

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['lines', 'date', 'cash', 'card', 'spent', 'total', 'credit', 'credit_paid', 'meals'],
  properties: {
    date: { type: ['string', 'null'], description: 'تاريخ الورقة YYYY-MM-DD لو مكتوب، وإلا null' },
    cash: { type: ['number', 'null'], description: 'الكاش اللي في الدرج آخر اليوم (دخل الكاش) لو مكتوب، وإلا null' },
    card: { type: ['number', 'null'], description: 'الشبكة لليوم («كمبيوتر» أو «مكينة» أو «شبكة» أو «مدى») لو مكتوب، وإلا null' },
    spent: { type: ['number', 'null'], description: '«خرج»: مجموع المصاريف المكتوب في أسفل الورقة لو مكتوب، وإلا null' },
    total: { type: ['number', 'null'], description: 'المجموع النهائي المكتوب تحت الخط (كاش + شبكة + خرج) لو مكتوب، وإلا null' },
    credit: { type: ['number', 'null'], description: '«آجل» أو «دين» أو «على الحساب»: مجموع اللي أكلوا اليوم وما دفعوا لو مكتوب، وإلا null' },
    credit_paid: { type: ['number', 'null'], description: '«سداد» أو «تحصيل» أو «دفع حسابه»: فلوس آجل قديم دخلت الدرج اليوم لو مكتوب، وإلا null' },
    meals: { type: ['number', 'null'], description: '«عمال» أو «وجبات» أو «أهل»: قيمة أكل العمال/الأهل اليوم لو مكتوب، وإلا null' },
    lines: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['date', 'text', 'kind', 'item_id', 'qty', 'unit', 'amount', 'category', 'supplier_id', 'supplier_name', 'uncertain'],
      properties: {
        date: { type: ['string', 'null'], description: 'تاريخ السطر YYYY-MM-DD لو مكتوب في الورقة (أو تاريخ القسم اللي هو تحته)، وإلا null' },
        text: { type: 'string', description: 'السطر كما هو مكتوب' },
        kind: { type: 'string', enum: ['purchase', 'expense', 'supplier', 'taken'], description: 'purchase = صنف من قائمة المخزون انشرى | expense = مصروف (غاز، نقل، صيانة، أجرة، تنظيف…) | supplier = حاسبوا/سددوا مورد من قائمة الموردين | taken = المشتري (مسؤول المشتريات) أخذ فلوس من الدرج عشان يشتري — بدون تفاصيل وش اشترى' },
        item_id: { type: ['integer', 'null'], description: 'للشراء: رقم الصنف من قائمة المخزون، وإلا null' },
        qty: { type: ['number', 'null'], description: 'للشراء: العدد/الكمية لو مكتوبة' },
        unit: { type: 'string', description: 'وحدة الشراء المكتوبة (كرتون، كيس، كيلو…) أو فارغ' },
        amount: { type: ['number', 'null'], description: 'المبلغ اللي انصرف في هذا السطر' },
        category: { type: 'string', description: 'للمصروف: البند بكلمة (غاز، نقل، صيانة…)، وإلا فارغ' },
        supplier_id: { type: ['integer', 'null'], description: 'للسداد: رقم المورد من قائمة الموردين، وإلا null' },
        supplier_name: { type: 'string', description: 'للسداد: اسم المورد كما هو مكتوب أو معروف (مثلاً «مندوب دجاج» => مورد الدجاج) لو مو في القائمة، وإلا فارغ' },
        uncertain: { type: 'boolean', description: 'true إذا الخط مو واضح أو مو متأكد من الرقم أو النوع' },
      } } },
  },
};

const PROMPT = PURCH => `هذي صورة (أو صور) ورقة مصاريف يومية لمطعم السلام، مكتوبة بالقلم بالعربي (خط يد).
يسجلون فيها أي فلوس طلعت من المحل: أشياء نقصت فاشتروها (دجاج، خبز، خضار…)، مصاريف (غاز، نقل، صيانة، أجرة…)، أو حاسبوا مورد.
اقرأ كل سطر لحاله وحدد نوعه:
- purchase: إذا الشي صنف من قائمة المخزون تحت — اختر رقمه في item_id (نفس الشي حتى لو مكتوب غير: «دجاجه» = دجاج).
- supplier: إذا مكتوب إنهم حاسبوا/سددوا/عطوا مورد أو «مندوب» (مثلاً «مندوب دجاج ٥٠٠» = دفعنا لمورد الدجاج، مو شراء دجاج) — اختر رقمه من قائمة الموردين، ولو مو فيها خل supplier_id = null واكتب اسمه في supplier_name.
- taken: إذا مكتوب إن مسؤول المشتريات (${PURCH}) أخذ فلوس («${PURCH.split('، ')[0]} أخذ ٣٠٠»، «للمشتريات ٢٠٠») بدون ما يقول وش اشترى.
- expense: غير كذا.
amount = المبلغ المكتوب للسطر. لا تخترع أسطر ولا أرقام. إذا كلمة أو رقم مو واضح اكتب أقرب قراءة وحط uncertain = true.
تحت الأسطر فيه حساب اليوم (مو أسطر مصاريف):
- «كمبيوتر» أو «مكينة» أو «شبكة» = card
- «كاش» = cash (الكاش اللي في الدرج آخر اليوم)
- «خرج» = spent (مجموع المصاريف زي ما كتبوه)
- الرقم تحت الخط = total (المجموع)
- «آجل»/«دين»/«على الحساب» = credit، «سداد»/«تحصيل» = credit_paid، «عمال»/«وجبات»/«أهل» = meals
اكتبهم زي ما هم مكتوبين بالضبط حتى لو الحساب ما يطابق. اللي مو مكتوب null.
تجاهل مجموع المصاريف والتوقيعات والكلام اللي مو مصروف.`;

const pos = v => Number(v) > 0 ? Math.round(Number(v) * 100) / 100 : null;
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

// كل اللي اتسجل «من الدرج» في يوم (مشتريات، مصاريف، سداد)، مين سجله
function drawerOf(date) {
  const out = [];
  for (const p of all("SELECT p.id, p.total AS amount, p.supplier, u.name AS by, u.role AS role FROM purchases p LEFT JOIN users u ON u.id = p.user_id WHERE p.date = ? AND p.payment = 'cash'", date)) {
    const its = all('SELECT l.item_id, i.name FROM purchase_lines l JOIN items i ON i.id = l.item_id WHERE l.purchase_id = ?', p.id);
    out.push({ key: 'p' + p.id, type: 'purchase', amount: p.amount, by: p.by || '', purch: p.role === 'purchaser', item_ids: its.map(x => x.item_id), label: `شراء ${its.map(x => x.name).join('، ') || p.supplier} — سجّله ${p.by || '؟'}` });
  }
  for (const e of all("SELECT e.id, e.amount, e.category, u.name AS by, u.role AS role FROM expenses e LEFT JOIN users u ON u.id = e.user_id WHERE e.date = ? AND (e.payment = 'cash' OR (e.payment = '' AND e.paid_from_cash = 1))", date))
    out.push({ key: 'e' + e.id, type: 'expense', amount: e.amount, by: e.by || '', purch: e.role === 'purchaser', item_ids: [], label: `مصروف ${e.category} — سجّله ${e.by || '؟'}` });
  for (const s of all("SELECT sp.id, sp.amount, s.name AS supplier, u.name AS by, u.role AS role FROM supplier_payments sp JOIN suppliers s ON s.id = sp.supplier_id LEFT JOIN users u ON u.id = sp.user_id WHERE sp.date = ? AND sp.paid_from_cash = 1", date))
    out.push({ key: 's' + s.id, type: 'supplier', amount: s.amount, by: s.by || '', purch: s.role === 'purchaser', item_ids: [], label: `سداد ${s.supplier} — سجّله ${s.by || '؟'}` });
  return out;
}

async function readSheet(u, images, pageDate) {
  const imgs = (images || []).map(d => /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/s.exec(d || '')).filter(Boolean);
  if (!imgs.length) throw Object.assign(new Error('صوّر الورقة أول'), { status: 400 });
  AI.checkCap();
  const items = all("SELECT id, name, unit FROM items WHERE active = 1 AND kind = 'raw' ORDER BY name");
  const units = all('SELECT item_id, name, factor FROM item_units');
  const sups = all('SELECT id, name FROM suppliers WHERE active = 1 ORDER BY name');
  const purch = all("SELECT id, name FROM users WHERE active = 1 AND bot = 0 AND role = 'purchaser' ORDER BY id");
  const content = [
    ...imgs.map(m => ({ type: 'image', source: { type: 'base64', media_type: m[1] === 'jpg' ? 'image/jpeg' : 'image/' + m[1], data: m[2] } })),
    { type: 'text', text: `${PROMPT(purch.map(x => x.name).join('، ') || 'المشتري')}\n\nأصناف المخزون (رقم: الاسم (الوحدة، وحدات الشراء)):\n${items.map(i => `${i.id}: ${i.name} (${i.unit}${units.filter(x => x.item_id === i.id).map(x => '، ' + x.name).join('')})`).join('\n')}\n\nالموردين (رقم: الاسم):\n${sups.map(s => `${s.id}: ${s.name}`).join('\n') || '—'}` },
  ];
  // الخط باليد: النموذج القوي على طول
  const res = await AI.create('strong', { max_tokens: 16000, messages: [{ role: 'user', content }], output_config: { format: { type: 'json_schema', schema: SCHEMA } } });
  const cost = AI.costOf(res.usage, 'strong');
  let parsed = null; try { parsed = JSON.parse(AI.textOf(res)); } catch { /* */ }
  if (!parsed) throw Object.assign(new Error('ما قدرت أقرأ الورقة — جرّب صورة أوضح'), { status: 400 });
  const validItem = new Map(items.map(i => [i.id, i])), validSup = new Map(sups.map(s => [s.id, s]));
  const lines = (parsed.lines || []).filter(l => l && String(l.text || '').trim()).map(l => {
    let kind = ['purchase', 'expense', 'supplier', 'taken'].includes(l.kind) ? l.kind : 'expense';
    let item = validItem.get(l.item_id) || null, sup = validSup.get(l.supplier_id) || null;
    if (kind === 'purchase' && !item) { // بالكلمات: «دجاجه ٥ ب ١٠٠» ≈ «دجاج»
      const words = String(l.text).split(/[^\p{L}]+/u).filter(w => w.length > 1);
      const score = i => Math.max(similarity(l.text, i.name), ...words.flatMap(w => [similarity(w, i.name), ...i.name.split(/\s+/).map(n => similarity(w, n))]));
      const b = items.map(i => ({ i, s: score(i) })).sort((a, c) => c.s - a.s)[0]; if (b && b.s >= 0.8) item = b.i;
    }
    if (kind === 'purchase' && !item) kind = 'expense'; // صنف مو في المخزون => مصروف (يقدر يبدّله)
    const supName = String(l.supplier_name || '').trim();
    if (kind === 'supplier' && !sup && supName) { // اسم قريب من مورد موجود؟
      const b = sups.map(x => ({ x, s: similarity(supName, x.name) })).sort((a, c) => c.s - a.s)[0]; if (b && b.s >= 0.8) sup = b.x;
    }
    if (kind === 'supplier' && !sup && !supName) kind = 'expense';
    const known = item && units.find(x => x.item_id === item.id && x.name === String(l.unit || '').trim());
    return { date: isDate(l.date) ? l.date : null, text: String(l.text).trim(), kind,
      item_id: kind === 'purchase' ? item.id : null, item: kind === 'purchase' ? item.name : '', qty: Number(l.qty) > 0 ? Number(l.qty) : (kind === 'purchase' ? 1 : null),
      unit: known ? known.name : '', amount: Number(l.amount) > 0 ? Number(l.amount) : null, category: String(l.category || '').trim(),
      supplier_id: kind === 'supplier' && sup ? sup.id : null, supplier: kind === 'supplier' ? (sup ? sup.name : supName) : '', new_supplier: kind === 'supplier' && !sup, uncertain: !!l.uncertain || !(Number(l.amount) > 0) };
  });
  AI.log(u.id, 'sheet', `${imgs.length} صورة`, `${lines.length} سطر`, cost, AI.MODELS.strong.id);
  const date = isDate(parsed.date) ? parsed.date : isDate(pageDate) ? pageDate : null;
  const had = date ? get('SELECT cash, card FROM cash_counts WHERE date = ?', date) : null; // جرد كاش سابق لنفس اليوم (بينستبدل)
  // اللي اتسجل من الدرج لنفس اليوم (المشتري يسجل مشترياته «من الدرج» بنفسه): نعلّم الأسطر المكررة عشان ما تنحسب مرتين
  const drawn = date ? drawerOf(date) : [];
  const used = new Set();
  for (const l of lines) {
    if (l.kind === 'taken' || !l.amount || (l.date && l.date !== date)) continue;
    const m = drawn.find(d => !used.has(d.key) && Math.abs(d.amount - l.amount) < 0.01 && (l.kind !== 'purchase' || d.type !== 'purchase' || d.item_ids.includes(l.item_id)));
    if (m) { used.add(m.key); l.dup = m.label; }
  }
  return { drawn, taken: Math.round(lines.filter(l => l.kind === 'taken').reduce((t, l) => t + (l.amount || 0), 0) * 100) / 100, date, cash: pos(parsed.cash), card: pos(parsed.card), spent: pos(parsed.spent), total_written: pos(parsed.total), credit: pos(parsed.credit), credit_paid: pos(parsed.credit_paid), meals: pos(parsed.meals), existing: had ? { cash: had.cash, card: had.card } : null, lines, total: Math.round(lines.reduce((s, l) => s + (l.amount || 0), 0) * 100) / 100, cost: Math.round(cost * 10000) / 10000 };
}

module.exports = { readSheet };
