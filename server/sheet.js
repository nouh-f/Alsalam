'use strict';
// «📄 ورقة المصاريف»: ورقة مكتوبة باليد في المحل (نقص دجاج فاشتروا، حاسبوا فلان، غاز…)
// الذكاء الاصطناعي يقرأ كل سطر ويفرزه: شراء (صنف مخزون) / مصروف / سداد مورد — مسودة للمراجعة، ما ينحفظ شي هنا
const { all, get } = require('./db');
const AI = require('./ai');
const { similarity } = require('./match');

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['lines', 'date', 'cash', 'card', 'transfer', 'spent', 'total'],
  properties: {
    date: { type: ['string', 'null'], description: 'تاريخ الورقة YYYY-MM-DD لو مكتوب، وإلا null' },
    cash: { type: ['number', 'null'], description: 'الكاش اللي في الدرج آخر اليوم (دخل الكاش) لو مكتوب، وإلا null' },
    card: { type: ['number', 'null'], description: 'الشبكة لليوم («كمبيوتر» أو «مكينة» أو «شبكة» أو «مدى») لو مكتوب، وإلا null' },
    transfer: { type: ['number', 'null'], description: '«تحويل» أو «حوالة» أو «STC» أو «بنكي»: اللي انحوّل لحساب المطعم اليوم لو مكتوب، وإلا null' },
    spent: { type: ['number', 'null'], description: '«خرج»: مجموع المصاريف المكتوب في أسفل الورقة لو مكتوب، وإلا null' },
    total: { type: ['number', 'null'], description: 'المجموع النهائي المكتوب تحت الخط (كاش + شبكة + خرج) لو مكتوب، وإلا null' },
    lines: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['date', 'text', 'kind', 'item_id', 'qty', 'unit', 'amount', 'category', 'supplier_id', 'supplier_name', 'employee', 'uncertain'],
      properties: {
        date: { type: ['string', 'null'], description: 'تاريخ السطر YYYY-MM-DD لو مكتوب في الورقة (أو تاريخ القسم اللي هو تحته)، وإلا null' },
        text: { type: 'string', description: 'السطر كما هو مكتوب' },
        kind: { type: 'string', enum: ['purchase', 'expense', 'supplier', 'taken', 'salary', 'bonus', 'custody'], description: 'purchase = صنف من قائمة المخزون انشرى | expense = مصروف (غاز، نقل، صيانة، أجرة، تنظيف…) | supplier = حاسبوا/سددوا مورد من قائمة الموردين | taken = المشتري (مسؤول المشتريات) أخذ فلوس من الدرج عشان يشتري — بدون تفاصيل وش اشترى' },
        item_id: { type: ['integer', 'null'], description: 'للشراء: رقم الصنف من قائمة المخزون، وإلا null' },
        qty: { type: ['number', 'null'], description: 'للشراء: العدد/الكمية لو مكتوبة' },
        unit: { type: 'string', description: 'وحدة الشراء المكتوبة (كرتون، كيس، كيلو…) أو فارغ' },
        amount: { type: ['number', 'null'], description: 'المبلغ اللي انصرف في هذا السطر' },
        category: { type: 'string', description: 'للمصروف: البند بكلمة (غاز، نقل، صيانة…)، وإلا فارغ' },
        supplier_id: { type: ['integer', 'null'], description: 'للسداد: رقم المورد من قائمة الموردين، وإلا null' },
        supplier_name: { type: 'string', description: 'للسداد: اسم المورد كما هو مكتوب أو معروف (مثلاً «مندوب دجاج» => مورد الدجاج) لو مو في القائمة، وإلا فارغ' },
        employee: { type: 'string', description: 'للسحب من الراتب أو المكافأة: اسم الموظف من قائمة الموظفين (أقرب اسم)، وإلا فارغ' },
        uncertain: { type: 'boolean', description: 'true إذا الخط مو واضح أو مو متأكد من الرقم أو النوع' },
      } } },
  },
};

const PROMPT = (PURCH, STAFF = '', BOSSES = '') => `هذي صورة (أو صور) ورقة مصاريف يومية لمطعم السلام، مكتوبة بالقلم بالعربي (خط يد).
يسجلون فيها أي فلوس طلعت من المحل: أشياء نقصت فاشتروها (دجاج، خبز، خضار…)، مصاريف (غاز، نقل، صيانة، أجرة…)، أو حاسبوا مورد.
اقرأ كل سطر لحاله وحدد نوعه:
- purchase: إذا الشي صنف من قائمة المخزون تحت — اختر رقمه في item_id (نفس الشي حتى لو مكتوب غير: «دجاجه» = دجاج).
- supplier: إذا مكتوب إنهم حاسبوا/سددوا/عطوا مورد أو «مندوب» (مثلاً «مندوب دجاج ٥٠٠» = دفعنا لمورد الدجاج، مو شراء دجاج) — اختر رقمه من قائمة الموردين، ولو مو فيها خل supplier_id = null واكتب اسمه في supplier_name.
- taken: إذا مكتوب إن مسؤول المشتريات (${PURCH}) أخذ فلوس («${PURCH.split('، ')[0]} أخذ ٣٠٠»، «للمشتريات ٢٠٠») بدون ما يقول وش اشترى.
- salary: موظف سحب من راتبه أو أخذ باقي راتبه («صادق ٢٠٠ باقي»، «سحبية باسم ١٥٠ من راتبه»، «راتب فلان») — اكتب اسمه في employee.
- custody: اسم مشرف أو مسؤول مشتريات + مبلغ بس، بدون شي ثاني («إبراهيم فيل ٢٧٠»، «زكريا ٥٠») = فلوس طلعت له من الدرج عهدة — اسمه في employee. لو فيه شي اشتراه («بنزين إبراهيم ٥٠»، «زكريا أكياس ورق ١٢٠») = expense أو purchase مو custody.
- bonus: مكافأة لموظف («مكافأة ١٥»، «مكافأة فلان ٢٠») — اسمه في employee لو مذكور.
- expense: غير كذا.
انتبه (من أوراق المحل الحقيقية):
- «فلان ١٠٠ متبقي ١٤٠٠» = salary بمبلغ ١٠٠ — الرقم بعد «متبقي/باقي له» معلومة بس (الباقي من راتبه)، مو المبلغ.
- «(سحب)» أو «سحبة» أو «سحبية» جنب الاسم = salary.
- السطر المشطوب بخط: تجاهله تمامًا.
- «فيل» جزء من الاسم (إبراهيم فيل، عبده فيل) — مو صنف.
- صنف من المخزون (لحوح، حليب، زبادي…) = purchase حتى لو جنبه اسم موظف («لحوح خلوف ٥٠» = شراء لحوح بـ ٥٠، والشاري خلوف — مو سحب راتب).
- مشوار، غاز، فيدي، علاج، بنزين… = expense.
amount = المبلغ المكتوب للسطر. لا تخترع أسطر ولا أرقام. إذا كلمة أو رقم مو واضح اكتب أقرب قراءة وحط uncertain = true.
تحت الأسطر فيه حساب اليوم (مو أسطر مصاريف):
- «كمبيوتر» أو «مكينة» أو «شبكة» = card
- «كاش» = cash (الكاش اللي في الدرج آخر اليوم)
- «تحويل» أو «حوالة» = transfer
- «خرج» = spent (مجموع المصاريف زي ما كتبوه)
- الرقم تحت الخط = total (المجموع)
لو مكتوب جمع («٤٠+٢٦٠» أو «٢٠+١٣٦٥») اكتب المجموع. اكتبهم زي ما هم مكتوبين حتى لو الحساب ما يطابق. اللي مو مكتوب null. الترتيب في الورقة عادة: كمبيوتر ثم كاش ثم خرج ثم تحويل — اقرأ الكلمة اللي جنب كل رقم.
تجاهل مجموع المصاريف والتوقيعات والكلام اللي مو مصروف.${STAFF ? `\n\nالموظفين: ${STAFF}` : ''}${BOSSES ? `\nالمشرفين والمشتريات (فلوسهم من الدرج = custody): ${BOSSES}` : ''}`;

const pos = v => Number(v) > 0 ? Math.round(Number(v) * 100) / 100 : null;
// الأرقام تركب؟ (كمبيوتر + كاش + تحويل + خرج = المجموع، ومجموع السطور = الخرج)
function sheetProblems(x) {
  if (!x) return ['ما انقرت'];
  const n = v => Number(v) || 0, out = [];
  if (x.total != null && (x.card != null || x.cash != null)) {
    const sum = n(x.card) + n(x.cash) + n(x.transfer) + n(x.spent);
    if (Math.abs(sum - n(x.total)) > 1) out.push(`كمبيوتر ${n(x.card)} + كاش ${n(x.cash)} + تحويل ${n(x.transfer)} + خرج ${n(x.spent)} = ${Math.round(sum * 100) / 100} والمكتوب تحت الخط ${n(x.total)}`);
  }
  const lines = (x.lines || []).filter(l => l && l.kind !== 'taken');
  if (lines.length && x.spent != null) {
    const ls = lines.reduce((t, l) => t + n(l.amount), 0) + (x.lines || []).filter(l => l && l.kind === 'taken').reduce((t, l) => t + n(l.amount), 0);
    if (Math.abs(ls - n(x.spent)) > 1) out.push(`مجموع السطور ${Math.round(ls * 100) / 100} والخرج ${n(x.spent)}`);
  }
  return out;
}
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

// كل اللي اتسجل «من الدرج» في يوم (مشتريات، مصاريف، سداد)، مين سجله
function drawerOf(date, skipSheet = false) {
  const own = skipSheet ? " AND e.note NOT LIKE '%[ورقة %'" : '', ownS = skipSheet ? " AND sp.note NOT LIKE '%[ورقة %'" : ''; // ورقة الجروب تنسجل من جديد — لا تعتبر سطورها القديمة مكررة
  const out = [];
  for (const p of all("SELECT p.id, p.total AS amount, p.supplier, u.name AS by, u.role AS role FROM purchases p LEFT JOIN users u ON u.id = p.user_id WHERE p.date = ? AND p.payment = 'cash'" + (skipSheet ? " AND p.note NOT LIKE '%[ورقة %'" : ''), date)) {
    const its = all('SELECT l.item_id, i.name FROM purchase_lines l JOIN items i ON i.id = l.item_id WHERE l.purchase_id = ?', p.id);
    out.push({ key: 'p' + p.id, type: 'purchase', amount: p.amount, by: p.by || '', purch: p.role === 'purchaser', item_ids: its.map(x => x.item_id), label: `شراء ${its.map(x => x.name).join('، ') || p.supplier} — سجّله ${p.by || '؟'}` });
  }
  for (const e of all("SELECT e.id, e.amount, e.category, u.name AS by, u.role AS role FROM expenses e LEFT JOIN users u ON u.id = e.user_id WHERE e.date = ? AND (e.payment = 'cash' OR (e.payment = '' AND e.paid_from_cash = 1))" + own, date))
    out.push({ key: 'e' + e.id, type: 'expense', amount: e.amount, by: e.by || '', purch: e.role === 'purchaser', item_ids: [], label: `مصروف ${e.category} — سجّله ${e.by || '؟'}` });
  for (const s of all("SELECT sp.id, sp.amount, s.name AS supplier, u.name AS by, u.role AS role FROM supplier_payments sp JOIN suppliers s ON s.id = sp.supplier_id LEFT JOIN users u ON u.id = sp.user_id WHERE sp.date = ? AND sp.paid_from_cash = 1" + ownS + "", date))
    out.push({ key: 's' + s.id, type: 'supplier', amount: s.amount, by: s.by || '', purch: s.role === 'purchaser', item_ids: [], label: `سداد ${s.supplier} — سجّله ${s.by || '؟'}` });
  return out;
}

async function readSheet(u, images, pageDate, opts = {}) {
  const imgs = (images || []).map(d => /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/s.exec(d || '')).filter(Boolean);
  if (!imgs.length) throw Object.assign(new Error('صوّر الورقة أول'), { status: 400 });
  AI.checkCap();
  const items = all("SELECT id, name, unit FROM items WHERE active = 1 AND kind = 'raw' ORDER BY name");
  const units = all('SELECT item_id, name, factor FROM item_units');
  const sups = all('SELECT id, name FROM suppliers WHERE active = 1 ORDER BY name');
  const purch = all("SELECT id, name FROM users WHERE active = 1 AND bot = 0 AND role = 'purchaser' ORDER BY id");
  const staff = all("SELECT id, name, role FROM users WHERE active = 1 AND bot = 0 AND role != 'owner' ORDER BY id");
  const bosses = staff.filter(x => x.role === 'supervisor' || x.role === 'purchaser');
  const content = [
    ...imgs.map(m => ({ type: 'image', source: { type: 'base64', media_type: m[1] === 'jpg' ? 'image/jpeg' : 'image/' + m[1], data: m[2] } })),
    { type: 'text', text: `${PROMPT(purch.map(x => x.name).join('، ') || 'المشتري', staff.map(x => x.name).join('، '), bosses.map(x => x.name).join('، '))}\n\nأصناف المخزون (رقم: الاسم (الوحدة، وحدات الشراء)):\n${items.map(i => `${i.id}: ${i.name} (${i.unit}${units.filter(x => x.item_id === i.id).map(x => '، ' + x.name).join('')})`).join('\n')}\n\nالموردين (رقم: الاسم):\n${sups.map(s => `${s.id}: ${s.name}`).join('\n') || '—'}` },
  ];
  // 🎯 الدقة أول: Sonnet على طول (Haiku جربناه على أوراق المحل وغلط كثير) — وبعدها نفحص الأرقام:
  // كمبيوتر + كاش + تحويل + خرج = اللي تحت الخط، ومجموع السطور = الخرج. ما طابق => نعيد مرة ونقول له وين الفرق
  let cost = 0; const model = 'mid';
  const readAs = async (fb = '') => {
    const msg = fb ? [...content, { type: 'text', text: fb }] : content;
    const res = await AI.create(model, { max_tokens: 4000, messages: [{ role: 'user', content: msg }], output_config: { format: { type: 'json_schema', schema: SCHEMA } } }, { kind: 'sheet', userId: u.id, imgKind: 'sheet', maxOut: 4000 });
    cost += AI.costOf(res.usage, model);
    try { return JSON.parse(AI.textOf(res)); } catch { return null; }
  };
  let parsed = await readAs();
  // 🔁 قراءة ثانية مستقلة (ما تشوف الأولى) ونقارن خانة خانة — اللي يختلف تحسمه قراءة ثالثة، ولو ما انحسم ينعلّم ❓
  const DIGITS = 'اقرأ كل مبلغ في الورقة رقم رقم ببطء — بخط اليد الأرقام تتشابه: ٢ و٣ و٤، و٥ و٧، و٦ و٩، و١ و٧. ركّز على مبلغ كل سطر وعلى الأرقام تحت الخط (الشبكة/الكمبيوتر، الكاش، التحويل، الخرج، الإجمالي).';
  const unsure = [];
  if (parsed && process.env.SHEET_DOUBLE !== '0') {
    const F = { card: 'الشبكة', cash: 'الكاش', transfer: 'التحويل', spent: 'الخرج', total: 'الإجمالي' };
    const amt = (x, i) => Number(((x.lines || [])[i] || {}).amount) || 0;
    const diffs = x => [...Object.keys(F).filter(k => (Number(x[k]) || 0) !== (Number(parsed[k]) || 0)),
      ...((x.lines || []).length === (parsed.lines || []).length ? (parsed.lines || []).map((_, i) => i).filter(i => amt(x, i) !== amt(parsed, i)).map(i => 'L' + i) : [])];
    const second = await readAs(DIGITS);
    const d1 = second ? diffs(second) : [];
    if (d1.length) {
      const third = await readAs(DIGITS + ' هذي قراءة للتأكيد — شيك كل خانة مرة ثانية.');
      const val = (x, k) => !x ? null : k[0] === 'L' ? amt(x, Number(k.slice(1))) : Number(x[k]) || 0;
      for (const k of d1) {
        const a = val(parsed, k), b = val(second, k), c = val(third, k);
        const win = a === c ? a : b === c ? b : null; // الأغلبية
        if (win != null) { if (k[0] === 'L') parsed.lines[Number(k.slice(1))].amount = win; else parsed[k] = win; }
        else {
          const label = k[0] === 'L' ? `«${String(parsed.lines[Number(k.slice(1))].text || '').slice(0, 30)}»` : F[k];
          unsure.push(`${label}: ${a} أو ${b}؟`);
          if (k[0] === 'L') parsed.lines[Number(k.slice(1))].uncertain = true;
        }
      }
    }
  }
  let problems = sheetProblems(parsed);
  if (problems.length) {
    const again = await readAs(`تنبيه: قراءتك السابقة فيها أرقام ما تركب: ${problems.join('، ')}. ارجع للصورة سطر سطر: رقم انقرا غلط؟ كمبيوتر وكاش متبدلين؟ سطر مشطوب حسبته؟ «متبقي» حسبته مبلغ؟ واكتب القراءة الصحيحة كاملة.`);
    const p2 = sheetProblems(again);
    if (again && p2.length <= problems.length) { parsed = again; problems = p2; }
  }
  // 💰 الإجمالي مقابل مبيعات النظام لليوم: فرق أكثر من ١٥٪ = غالبًا رقم انقرا غلط (٢↔٤، ٥↔٧ — الغلطتين نفس الفرق فالجمع يطلع صح)
  // نعيد القراءة مرة ونركّز على الأرقام الكبيرة، ولو بقى الفرق ينكتب تحذير فوق الكرت
  const salesGap = x => {
    const d = isDate(x && x.date) ? x.date : isDate(pageDate) ? pageDate : null;
    let s = 0; try { s = d ? require('./calc').dailyReport(d).money.total_sales || 0 : 0; } catch { /* */ }
    const t = Number(x && x.total) || 0;
    return s > 0 && t > 0 && Math.abs(t - s) / s > 0.15 ? { s: Math.round(s), t } : null;
  };
  let gap = parsed && !problems.length && process.env.SHEET_DOUBLE !== '0' ? salesGap(parsed) : null;
  if (gap) {
    const again = await readAs(`تنبيه: الإجمالي اللي قريته ${gap.t} بعيد عن مبيعات النظام لليوم (${gap.s}). ارجع للأرقام الكبيرة رقم رقم: الشبكة/الكمبيوتر، والكاش، والتحويل، والخرج، والإجمالي. بخط اليد الأرقام ٢ و٤ و٣ تتشابه، و٥ و٧، و٦ و٩ — شيك كل خانة. واكتب القراءة كاملة.`);
    if (again && !sheetProblems(again).length) { const g2 = salesGap(again); if (!g2 || Math.abs(g2.t - g2.s) < Math.abs(gap.t - gap.s)) { parsed = again; gap = g2; } }
  }
  if (gap) problems.push(`الإجمالي ${gap.t} يختلف عن مبيعات النظام ${gap.s} — شيك الشبكة والإجمالي في الصورة`);
  if (unsure.length) problems.push(`القراءتين اختلفت — شيك في الصورة: ${unsure.join('، ')}`);
  if (!parsed) throw Object.assign(new Error('ما قدرت أقرأ الورقة — جرّب صورة أوضح'), { status: 400 });
  const validItem = new Map(items.map(i => [i.id, i])), validSup = new Map(sups.map(s => [s.id, s]));
  const lines = (parsed.lines || []).filter(l => l && String(l.text || '').trim()).map(l => {
    let kind = ['purchase', 'expense', 'supplier', 'taken', 'salary', 'bonus', 'custody'].includes(l.kind) ? l.kind : 'expense';
    let emp = null;
    const pick = (q, pool) => { q = String(q || '').trim(); const b = q ? pool.map(x => ({ x, s: x.name === q ? 1 : x.name.includes(q) || q.includes(x.name) ? 0.9 : similarity(q, x.name) })).sort((a, c) => c.s - a.s) : [];
      return b[0] && b[0].s >= 0.75 && !(b[1] && b[1].s >= b[0].s - 0.01) ? b[0].x : null; };
    // 👛 اسم مشرف/مشتري + مبلغ بس (ولا فيه سحب/راتب/متبقي) = عهدة — حتى لو النموذج قال غير كذا. والمشتري «أخذ» = عهدة بعد
    const named = staff.filter(x => String(l.text).includes(x.name)).sort((a, c) => c.name.length - a.name.length)[0]; // «محمد علي» قبل «محمد»
    const boss = named ? (bosses.includes(named) ? named : null) : (kind === 'custody' || kind === 'taken' ? pick(l.employee, bosses) : null);
    const STOP = new Set(['فيل', 'من', 'بيد', 'ل', 'لـ', 'عهدة', 'أخذ', 'اخذ', 'ريال']);
    const rest = boss ? String(l.text).replace(boss.name, ' ').split(/\s+/).filter(w => w && !STOP.has(w) && !/^[\d٠-٩.,،()\-+=:]+$/.test(w)).join(' ') : 'x';
    if (opts.people && boss && (kind === 'custody' || kind === 'taken' || (!rest && !/سحب|راتب|متبقي|باقي/.test(l.text) && kind !== 'bonus'))) { kind = 'custody'; emp = boss; } // جروب الحساب بس — صفحة الورقة على حالها
    else if (kind === 'custody') kind = 'expense'; // اسم مو لمشرف => مصروف (نوح يعدّله)
    if (kind === 'salary' || kind === 'bonus') emp = pick(l.employee, staff);
    if (!opts.people && ['salary', 'bonus', 'custody'].includes(kind)) { l.category = kind === 'salary' ? 'سحب راتب' : kind === 'bonus' ? 'مكافآت' : 'عهدة'; kind = 'expense'; } // صفحة الورقة: مصروف
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
      supplier_id: kind === 'supplier' && sup ? sup.id : null, supplier: kind === 'supplier' ? (sup ? sup.name : supName) : '', new_supplier: kind === 'supplier' && !sup, uncertain: !!l.uncertain || !(Number(l.amount) > 0), employee: String(l.employee || '').trim(), employee_id: emp ? emp.id : null, employee_name: emp ? emp.name : '' };
  });
  AI.log(u.id, 'sheet', `${imgs.length} صورة`, `${lines.length} سطر${problems.length ? ' — ⚠️ ' + problems.join('، ') : ''}`, cost, AI.MODELS[model].id);
  const date = isDate(parsed.date) ? parsed.date : isDate(pageDate) ? pageDate : null;
  const had = date ? get('SELECT cash, card FROM cash_counts WHERE date = ?', date) : null; // جرد كاش سابق لنفس اليوم (بينستبدل)
  // اللي اتسجل من الدرج لنفس اليوم (المشتري يسجل مشترياته «من الدرج» بنفسه): نعلّم الأسطر المكررة عشان ما تنحسب مرتين
  const drawn = date ? drawerOf(date, !!opts.people) : [];
  const used = new Set();
  for (const l of lines) {
    if (l.kind === 'taken' || !l.amount || (l.date && l.date !== date)) continue;
    const m = drawn.find(d => !used.has(d.key) && Math.abs(d.amount - l.amount) < 0.01 && (l.kind !== 'purchase' || d.type !== 'purchase' || d.item_ids.includes(l.item_id)));
    if (m) { used.add(m.key); l.dup = m.label; }
  }
  return { check: problems.length ? 'mismatch' : 'ok', problems, drawn, taken: Math.round(lines.filter(l => l.kind === 'taken').reduce((t, l) => t + (l.amount || 0), 0) * 100) / 100, date, cash: pos(parsed.cash), card: pos(parsed.card), spent: pos(parsed.spent), transfer: pos(parsed.transfer), total_written: pos(parsed.total), existing: had ? { cash: had.cash, card: had.card } : null, lines, total: Math.round(lines.reduce((s, l) => s + (l.amount || 0), 0) * 100) / 100, cost: Math.round(cost * 10000) / 10000 };
}

module.exports = { readSheet };
