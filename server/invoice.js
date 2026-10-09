'use strict';
// قراءة فاتورة الشراء بالصورة: زكريا يصوّر، والنظام يعبّي الأسطر (مسودة يشيكها قبل الحفظ)
const { all } = require('./db');
const AI = require('./ai');
const { similarity } = require('./match');

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['supplier', 'date', 'total', 'lines'],
  properties: {
    supplier: { type: 'string', description: 'اسم المحل أو المورد المطبوع، وإلا فارغ' },
    date: { type: ['string', 'null'], description: 'تاريخ الفاتورة YYYY-MM-DD إن وُجد' },
    total: { type: ['number', 'null'], description: 'المجموع النهائي المطبوع (بعد الضريبة)' },
    lines: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['name', 'qty', 'unit', 'unit_price', 'line_total', 'item_id'],
      properties: {
        name: { type: 'string', description: 'اسم الصنف كما هو مكتوب' },
        qty: { type: 'number' },
        unit: { type: 'string', description: 'وحدة الشراء المكتوبة (كرتون، كيس، كجم…) أو فارغ' },
        unit_price: { type: ['number', 'null'], description: 'سعر الوحدة شامل الضريبة إن أمكن' },
        line_total: { type: ['number', 'null'], description: 'مبلغ السطر' },
        item_id: { type: ['integer', 'null'], description: 'رقم الصنف المطابق من قائمة المستودع أو null' },
      } } },
  },
};

const PROMPT = `هذي صورة (أو صور) فاتورة شراء لمطعم السلام (فاتورة مورد، أو ورقة بقالة/خضار مكتوبة باليد).
اقرأ كل سطر: الصنف، العدد، الوحدة، سعر الوحدة، ومبلغ السطر. إذا الفاتورة فيها ضريبة 15% مضافة على المجموع بس، حط السعر قبل الضريبة في السطر — المجموع (total) هو المطبوع النهائي.
item_id: اختر الصنف الأقرب من قائمة المستودع (نفس الشي حتى لو مكتوب غير: «طماط» = طماطم). إذا ما فيه صنف يناسب حط null.
لا تخترع أسطر. الأرقام اقرأها بدقة.`;

async function readInvoice(u, images) {
  const imgs = (images || []).map(d => /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/s.exec(d || '')).filter(Boolean);
  if (!imgs.length) throw Object.assign(new Error('صوّر الفاتورة أول'), { status: 400 });
  AI.checkCap();
  const items = all("SELECT id, name, unit FROM items WHERE active = 1 AND kind = 'raw' ORDER BY name");
  const units = all('SELECT item_id, name, factor FROM item_units');
  const list = items.map(i => `${i.id}: ${i.name} (${i.unit}${units.filter(x => x.item_id === i.id).map(x => '، ' + x.name).join('')})`).join('\n');
  const content = [
    ...imgs.map(m => ({ type: 'image', source: { type: 'base64', media_type: m[1] === 'jpg' ? 'image/jpeg' : 'image/' + m[1], data: m[2] } })),
    { type: 'text', text: `${PROMPT}\n\nقائمة أصناف المستودع (رقم: الاسم (الوحدة، وحدات الشراء)):\n${list}` },
  ];
  let cost = 0, tier = 'fast', parsed = null;
  const read = async t => {
    const res = await AI.create(t, { max_tokens: 16000, messages: [{ role: 'user', content }], output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } } });
    cost += AI.costOf(res.usage, t);
    try { return JSON.parse(AI.textOf(res)); } catch { return null; }
  };
  parsed = await read('fast');
  // المجموع ما يطابق الأسطر (أكثر من 3%) => نعيد بالقوي مرة
  const sum = p => (p && p.lines || []).reduce((s, l) => s + (Number(l.line_total) || (Number(l.qty) || 0) * (Number(l.unit_price) || 0)), 0);
  const off = p => !p || (p.total && Math.abs(sum(p) - p.total) > Math.max(1, p.total * 0.03) && Math.abs(sum(p) * 1.15 - p.total) > Math.max(1, p.total * 0.03));
  if (off(parsed)) { tier = 'strong'; const again = await read('strong'); if (again && (!parsed || !off(again))) parsed = again; }
  if (!parsed) throw Object.assign(new Error('ما قدرت أقرأ الفاتورة — جرّب صورة أوضح'), { status: 400 });
  const valid = new Map(items.map(i => [i.id, i]));
  const lines = (parsed.lines || []).filter(l => l && String(l.name || '').trim() && Number(l.qty) > 0).map(l => {
    let item = valid.get(l.item_id) || null;
    if (!item) { const b = items.map(i => ({ i, s: similarity(l.name, i.name) })).sort((a, c) => c.s - a.s)[0]; if (b && b.s >= 0.8) item = b.i; }
    // الوحدة: لو هي وحدة شراء معروفة للصنف نستخدمها، وإلا الوحدة الأساسية
    const known = item && units.find(x => x.item_id === item.id && x.name === String(l.unit || '').trim());
    return { name: l.name, item_id: item ? item.id : null, item: item ? item.name : '', qty: Number(l.qty), unit: known ? known.name : '', unit_text: l.unit || '',
      unit_price: Number(l.unit_price) || null, line_total: Number(l.line_total) || null };
  });
  AI.log(u.id, 'invoice', `${imgs.length} صورة`, `${lines.length} سطر — ${parsed.supplier || ''} ${parsed.total || ''}`, cost, AI.MODELS[tier].id);
  return { supplier: parsed.supplier || '', date: /^\d{4}-\d{2}-\d{2}$/.test(parsed.date || '') ? parsed.date : null, total: parsed.total || null,
    lines_total: Math.round(sum({ lines }) * 100) / 100, lines, cost: Math.round(cost * 10000) / 10000, model: tier };
}

module.exports = { readInvoice };
