'use strict';
// «📄 ورقة المصاريف»: ورقة مكتوبة باليد في المحل (نقص دجاج فاشتروا، حاسبوا فلان، غاز…)
// الذكاء الاصطناعي يقرأ كل سطر ويفرزه: شراء (صنف مخزون) / مصروف / سداد مورد — مسودة للمراجعة، ما ينحفظ شي هنا
const { all } = require('./db');
const AI = require('./ai');
const { similarity } = require('./match');

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['lines'],
  properties: {
    lines: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['date', 'text', 'kind', 'item_id', 'qty', 'unit', 'amount', 'category', 'supplier_id', 'uncertain'],
      properties: {
        date: { type: ['string', 'null'], description: 'تاريخ السطر YYYY-MM-DD لو مكتوب في الورقة (أو تاريخ القسم اللي هو تحته)، وإلا null' },
        text: { type: 'string', description: 'السطر كما هو مكتوب' },
        kind: { type: 'string', enum: ['purchase', 'expense', 'supplier'], description: 'purchase = صنف من قائمة المخزون انشرى | expense = مصروف (غاز، نقل، صيانة، أجرة، تنظيف…) | supplier = حاسبوا/سددوا مورد من قائمة الموردين' },
        item_id: { type: ['integer', 'null'], description: 'للشراء: رقم الصنف من قائمة المخزون، وإلا null' },
        qty: { type: ['number', 'null'], description: 'للشراء: العدد/الكمية لو مكتوبة' },
        unit: { type: 'string', description: 'وحدة الشراء المكتوبة (كرتون، كيس، كيلو…) أو فارغ' },
        amount: { type: ['number', 'null'], description: 'المبلغ اللي انصرف في هذا السطر' },
        category: { type: 'string', description: 'للمصروف: البند بكلمة (غاز، نقل، صيانة…)، وإلا فارغ' },
        supplier_id: { type: ['integer', 'null'], description: 'للسداد: رقم المورد من قائمة الموردين، وإلا null' },
        uncertain: { type: 'boolean', description: 'true إذا الخط مو واضح أو مو متأكد من الرقم أو النوع' },
      } } },
  },
};

const PROMPT = `هذي صورة (أو صور) ورقة مصاريف يومية لمطعم السلام، مكتوبة بالقلم بالعربي (خط يد).
يسجلون فيها أي فلوس طلعت من المحل: أشياء نقصت فاشتروها (دجاج، خبز، خضار…)، مصاريف (غاز، نقل، صيانة، أجرة…)، أو حاسبوا مورد.
اقرأ كل سطر لحاله وحدد نوعه:
- purchase: إذا الشي صنف من قائمة المخزون تحت — اختر رقمه في item_id (نفس الشي حتى لو مكتوب غير: «دجاجه» = دجاج).
- supplier: إذا مكتوب إنهم حاسبوا/سددوا/عطوا مورد من قائمة الموردين — اختر رقمه.
- expense: غير كذا.
amount = المبلغ المكتوب للسطر. لا تخترع أسطر ولا أرقام. إذا كلمة أو رقم مو واضح اكتب أقرب قراءة وحط uncertain = true.
تجاهل المجاميع والتوقيعات والكلام اللي مو مصروف.`;

async function readSheet(u, images) {
  const imgs = (images || []).map(d => /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/s.exec(d || '')).filter(Boolean);
  if (!imgs.length) throw Object.assign(new Error('صوّر الورقة أول'), { status: 400 });
  AI.checkCap();
  const items = all("SELECT id, name, unit FROM items WHERE active = 1 AND kind = 'raw' ORDER BY name");
  const units = all('SELECT item_id, name, factor FROM item_units');
  const sups = all('SELECT id, name FROM suppliers WHERE active = 1 ORDER BY name');
  const content = [
    ...imgs.map(m => ({ type: 'image', source: { type: 'base64', media_type: m[1] === 'jpg' ? 'image/jpeg' : 'image/' + m[1], data: m[2] } })),
    { type: 'text', text: `${PROMPT}\n\nأصناف المخزون (رقم: الاسم (الوحدة، وحدات الشراء)):\n${items.map(i => `${i.id}: ${i.name} (${i.unit}${units.filter(x => x.item_id === i.id).map(x => '، ' + x.name).join('')})`).join('\n')}\n\nالموردين (رقم: الاسم):\n${sups.map(s => `${s.id}: ${s.name}`).join('\n') || '—'}` },
  ];
  // الخط باليد: النموذج القوي على طول
  const res = await AI.create('strong', { max_tokens: 16000, messages: [{ role: 'user', content }], output_config: { format: { type: 'json_schema', schema: SCHEMA } } });
  const cost = AI.costOf(res.usage, 'strong');
  let parsed = null; try { parsed = JSON.parse(AI.textOf(res)); } catch { /* */ }
  if (!parsed) throw Object.assign(new Error('ما قدرت أقرأ الورقة — جرّب صورة أوضح'), { status: 400 });
  const validItem = new Map(items.map(i => [i.id, i])), validSup = new Map(sups.map(s => [s.id, s]));
  const lines = (parsed.lines || []).filter(l => l && String(l.text || '').trim()).map(l => {
    let kind = ['purchase', 'expense', 'supplier'].includes(l.kind) ? l.kind : 'expense';
    let item = validItem.get(l.item_id) || null, sup = validSup.get(l.supplier_id) || null;
    if (kind === 'purchase' && !item) { // بالكلمات: «دجاجه ٥ ب ١٠٠» ≈ «دجاج»
      const words = String(l.text).split(/[^\p{L}]+/u).filter(w => w.length > 1);
      const score = i => Math.max(similarity(l.text, i.name), ...words.flatMap(w => [similarity(w, i.name), ...i.name.split(/\s+/).map(n => similarity(w, n))]));
      const b = items.map(i => ({ i, s: score(i) })).sort((a, c) => c.s - a.s)[0]; if (b && b.s >= 0.8) item = b.i;
    }
    if (kind === 'purchase' && !item) kind = 'expense'; // صنف مو في المخزون => مصروف (يقدر يبدّله)
    if (kind === 'supplier' && !sup) kind = 'expense';
    const known = item && units.find(x => x.item_id === item.id && x.name === String(l.unit || '').trim());
    return { date: /^\d{4}-\d{2}-\d{2}$/.test(l.date || '') ? l.date : null, text: String(l.text).trim(), kind,
      item_id: kind === 'purchase' ? item.id : null, item: kind === 'purchase' ? item.name : '', qty: Number(l.qty) > 0 ? Number(l.qty) : (kind === 'purchase' ? 1 : null),
      unit: known ? known.name : '', amount: Number(l.amount) > 0 ? Number(l.amount) : null, category: String(l.category || '').trim(),
      supplier_id: kind === 'supplier' ? sup.id : null, supplier: kind === 'supplier' ? sup.name : '', uncertain: !!l.uncertain || !(Number(l.amount) > 0) };
  });
  AI.log(u.id, 'sheet', `${imgs.length} صورة`, `${lines.length} سطر`, cost, AI.MODELS.strong.id);
  return { lines, total: Math.round(lines.reduce((s, l) => s + (l.amount || 0), 0) * 100) / 100, cost: Math.round(cost * 10000) / 10000 };
}

module.exports = { readSheet };
