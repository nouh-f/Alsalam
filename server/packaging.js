'use strict';
// 🥡 البلاستيك والتغليف: كم المفروض راح (حسب طلبات السفري والتوصيل من أوراق المطبخ) مقابل كم انشرى
// مبدئيًا بالمشتريات بس (بدون جرد) — فالمقارنة الصح على شهر، لأن المشتريات تجي دفعات
const { all, get, run } = require('./db');
const AI = require('./ai');
const C = require('./calc');
const PR = require('./printer_read');

const OUT = new Set(['takeaway', 'delivery']);
const fits = (rule, dining) => rule.dining === 'out' ? OUT.has(dining) : rule.dining === dining;
// أصناف المستودع اللي شكلها تغليف (للاقتراح والقائمة) + أي صنف عليه قاعدة
const LOOKS = /علب|علبة|كيس|أكياس|اكياس|صحن|صحون|كوب|أكواب|اكواب|ملاعق|ملعق|شوك|سفري|بلاست|غطا|قصدير|ألمن|المن|منديل|مناديل|سحاره|تغليف|فويل/;
function packItems() {
  const used = new Set(all('SELECT DISTINCT item_id FROM packaging_rules').map(r => r.item_id));
  return all("SELECT id, name, unit, cost FROM items WHERE active = 1 AND kind = 'raw' ORDER BY name")
    .filter(i => used.has(i.id) || (LOOKS.test(i.name) && !/عسل|سمن|نفايات/.test(i.name)));
}

function rules() {
  return all(`SELECT r.*, p.name AS product, p.variant, i.name AS item, i.unit FROM packaging_rules r
    LEFT JOIN products p ON p.id = r.product_id JOIN items i ON i.id = r.item_id ORDER BY r.product_id IS NOT NULL, p.name, i.name`);
}

function compute(from, to = from) {
  const T = PR.tickets(from, to), R = all('SELECT * FROM packaging_rules');
  const exp = new Map(), days = new Map();
  const add = (id, q) => exp.set(id, C.r3((exp.get(id) || 0) + q));
  let out = 0, noRule = new Map();
  for (const t of T.tickets) {
    if (!['open', 'edited'].includes(t.status)) continue;
    const d = days.get(t.date) || { date: t.date, dine_in: 0, takeaway: 0, delivery: 0, unknown: 0 };
    d[t.dining || 'unknown']++; days.set(t.date, d);
    if (!OUT.has(t.dining)) continue;
    out++;
    for (const r of R) if (!r.product_id && fits(r, t.dining)) add(r.item_id, r.qty);
    for (const l of t.lines) {
      if (l.qty <= 0) continue;
      const mine = R.filter(r => r.product_id && r.product_id === l.product_id && fits(r, t.dining));
      for (const r of mine) add(r.item_id, r.qty * l.qty);
      if (!mine.length) noRule.set(l.name, (noRule.get(l.name) || 0) + l.qty);
    }
  }
  const bought = new Map(all(`SELECT pl.item_id, SUM(pl.qty) AS q, SUM(pl.qty * pl.unit_price) AS v FROM purchase_lines pl JOIN purchases p ON p.id = pl.purchase_id
    WHERE p.date BETWEEN ? AND ? GROUP BY pl.item_id`, from, to).map(r => [r.item_id, r]));
  const units = new Set(all('SELECT DISTINCT item_id FROM item_units').map(r => r.item_id));
  const items = packItems().map(i => {
    const e = exp.get(i.id) || 0, b = bought.get(i.id), q = b ? C.r3(b.q) : 0;
    return {
      item_id: i.id, name: i.name, unit: i.unit, expected: e, bought: q, bought_value: b ? C.r2(b.v) : 0, diff: C.r3(q - e),
      // «حبة» وسعرها كبير وما لها وحدة شراء => غالبًا الكرتون انسجل كحبة
      unit_warn: i.unit === 'حبة' && i.cost >= 10 && !units.has(i.id),
    };
  }).filter(i => i.expected || i.bought || R.some(r => r.item_id === i.item_id));
  return {
    from, to, orders: { out, days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) },
    items, no_rule: [...noRule.entries()].map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty),
    drafts: R.filter(r => r.status === 'draft').length, unread: T.unread,
  };
}

function save(b) {
  const item = get("SELECT id FROM items WHERE id = ? AND active = 1", Number(b.item_id));
  if (!item) throw Object.assign(new Error('اختر صنف التغليف'), { status: 400 });
  const pid = b.product_id ? Number(b.product_id) : null;
  if (pid && !get('SELECT 1 AS x FROM products WHERE id = ?', pid)) throw Object.assign(new Error('صنف البيع غير موجود'), { status: 400 });
  const dining = ['takeaway', 'delivery', 'out'].includes(b.dining) ? b.dining : 'out';
  const qty = Number(b.qty);
  if (!(qty > 0)) throw Object.assign(new Error('الكمية لازم أكبر من صفر'), { status: 400 });
  const status = b.status === 'draft' ? 'draft' : 'ok';
  if (b.id) run('UPDATE packaging_rules SET product_id = ?, dining = ?, item_id = ?, qty = ?, status = ? WHERE id = ?', pid, dining, item.id, qty, status, Number(b.id));
  else run('INSERT INTO packaging_rules(product_id, dining, item_id, qty, status) VALUES(?,?,?,?,?)', pid, dining, item.id, qty, status);
}

// 🤖 اقتراح مبدئي: الذكاء يشوف أصناف البيع وأصناف التغليف ويقترح — كلها مسودة لين نوح يعتمدها
const SUGGEST = {
  type: 'object', additionalProperties: false, required: ['rules'],
  properties: { rules: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['product_id', 'dining', 'item_id', 'qty'], properties: {
    product_id: { type: ['integer', 'null'], description: 'صنف البيع، أو null = لكل طلب (مثل الكيس)' },
    dining: { type: 'string', enum: ['out', 'takeaway', 'delivery'] },
    item_id: { type: 'integer' }, qty: { type: 'number' },
  } } } },
};
async function suggest(userId) {
  AI.checkCap();
  const products = all("SELECT id, name, variant, category FROM products WHERE active = 1 AND recipe_status != 'skip' ORDER BY category, name");
  const items = packItems();
  if (!items.length) throw Object.assign(new Error('ما فيه أصناف تغليف في المستودع (قصدير، علب، أكياس…) — ضيفها أول'), { status: 400 });
  const done = new Set(all("SELECT DISTINCT COALESCE(product_id, 0) AS p FROM packaging_rules WHERE status = 'ok'").map(r => r.p));
  const prompt = `مطعم السلام (مندي ومأكولات شعبية في جدة). نبغى نعرف كل صنف بيع لما ينطلب سفري أو توصيل وش ياخذ من التغليف.
أصناف التغليف الموجودة في المستودع (رقم: الاسم [الوحدة]):
${items.map(i => `${i.id}: ${i.name} [${i.unit}]`).join('\n')}

أصناف البيع (رقم: الاسم — النوع | الفئة):
${products.map(p => `${p.id}: ${p.name}${p.variant ? ' — ' + p.variant : ''}${p.category ? ' | ' + p.category : ''}`).join('\n')}

اقترح قواعد معقولة:
- لكل صنف أكل يحتاج تغليف: وش ياخذ وكم (مثلاً قصدير ١، ملعقة ١). الكمية بوحدة صنف التغليف.
- المشروبات المعلبة والماء غالبًا ما تحتاج شي.
- قاعدة أو قاعدتين لكل طلب (product_id = null) مثل الكيس.
- dining = out إلا لو التوصيل يختلف عن السفري.
- استخدم أرقام التغليف من القائمة بس. لا تقترح لصنف ما تعرف وش هو.`;
  const res = await AI.create('strong', { max_tokens: 16000, output_config: { format: { type: 'json_schema', schema: SUGGEST } }, messages: [{ role: 'user', content: prompt }] });
  const cost = AI.costOf(res.usage, 'strong');
  let r; try { r = JSON.parse(AI.textOf(res)); } catch { throw Object.assign(new Error('ما قدرت أقرأ الاقتراح — جرب مرة ثانية'), { status: 400 }); }
  const pids = new Set(products.map(p => p.id)), iids = new Set(items.map(i => i.id));
  const ok = (r.rules || []).filter(x => iids.has(x.item_id) && Number(x.qty) > 0 && (x.product_id == null || pids.has(x.product_id)) && !done.has(x.product_id || 0));
  // المسودات القديمة تنمسح (المعتمد يبقى)
  run("DELETE FROM packaging_rules WHERE status = 'draft'");
  for (const x of ok) run("INSERT INTO packaging_rules(product_id, dining, item_id, qty, status) VALUES(?,?,?,?,'draft')", x.product_id || null, ['out', 'takeaway', 'delivery'].includes(x.dining) ? x.dining : 'out', x.item_id, Number(x.qty));
  AI.log(userId, 'packaging', 'اقتراح التغليف', `${ok.length} قاعدة`, cost, AI.MODELS.strong.id);
  return { added: ok.length, cost };
}

module.exports = { compute, rules, save, suggest, packItems, fits };
