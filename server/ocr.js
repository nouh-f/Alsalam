'use strict';
// قراءة صور تذكرة الكاشير المطبوعة (تذكرة لويفرس ما انقفلت) بالذكاء الاصطناعي.
// كل صورة تنقرا لحالها بالترتيب، والدمج والتأكد من المجموع يصير في ticket.js
const fs = require('node:fs');
const Anthropic = require('@anthropic-ai/sdk');
const { all, getSetting } = require('./db');

const LINE = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'qty', 'unit_price', 'amount', 'note', 'product_id'],
  properties: {
    name: { type: 'string', description: 'اسم الصنف مثل ما هو مطبوع بالضبط، مع اللي بين القوسين' },
    qty: { type: 'number', description: 'الرقم قبل x (العدد أو الوزن مثل 0.530)' },
    unit_price: { type: 'number', description: 'الرقم بعد x (سعر الوحدة)' },
    amount: { type: 'number', description: 'مبلغ السطر المطبوع على اليسار' },
    note: { type: 'string', description: 'ملاحظة مطبوعة تحت الصنف إن وُجدت وإلا فارغ' },
    product_id: { type: ['integer', 'null'], description: 'رقم الصنف المطابق من القائمة أو null' },
  },
};
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['images'],
  properties: {
    images: {
      type: 'array',
      description: 'صورة لكل صورة مرفقة، بنفس ترتيب الإرفاق',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['image_number', 'has_header', 'ticket_label', 'total_due', 'discount', 'lines'],
        properties: {
          image_number: { type: 'integer' },
          has_header: { type: 'boolean', description: 'الصورة فيها رأس التذكرة (الطلب/التذكرة/الموظف)' },
          ticket_label: { type: 'string', description: 'سطر «الطلب: التذكرة - ...» كما هو، وإلا فارغ' },
          total_due: { type: ['number', 'null'], description: '«المبلغ المستحق» إذا ظاهر في هذي الصورة، وإلا null' },
          discount: { type: 'number', description: 'مجموع الخصم المطبوع في هذي الصورة إن وجد وإلا 0' },
          lines: { type: 'array', items: LINE },
        },
      },
    },
  },
};

const PROMPT = `هذي صور تذكرة كاشير مطبوعة من نظام لويفرس (مطعم السلام). التذكرة الطويلة متصورة على أكثر من صورة، والصور ممكن تتداخل (آخر الصورة يتكرر أول اللي بعدها) — هذا طبيعي.
اقرأ كل صورة لحالها، من فوق لتحت، ورجّع أسطرها بالترتيب:
- كل صنف: الاسم مطبوع على اليمين، وتحته «العدد x السعر»، ومبلغ السطر على اليسار. مثال: «هامور (مبفا)» ثم «0.530 x 70.00 SAR» والمبلغ «37.10 SAR».
- انسخ الاسم بالضبط كما هو مطبوع مع اللي بين القوسين (النوع). لا تصحح الإملاء ولا تختصر.
- كل سطر مطبوع ينحسب لحاله حتى لو نفس الصنف تكرر في نفس الصورة — لا تدمج ولا تحذف الأسطر المكررة.
- السطر المقصوص في طرف الصورة (ما يبان اسمه أو أرقامه كاملة) لا ترجعه.
- لا ترجع أسطر المجموع والضريبة كأصناف. «المبلغ المستحق» حطه في total_due للصورة اللي يبان فيها.
- الأرقام اقرأها بدقة (الكسور مثل 0.645 مهمة).
- product_id: رقم الصنف من القائمة اللي اسمه «الصنف — النوع» يطابق الاسم المطبوع «الصنف (النوع)»، وإلا null.`;

const { MODELS } = require('./ai');

// للاختبار بس: قراءات جاهزة بدل الاتصال (كل نداء ياخذ اللي بعده)
let fixtureCall = 0;
async function readTicketImages(paths, { feedback = '', tier = 'fast' } = {}) {
  if (process.env.OCR_FIXTURE) {
    const runs = JSON.parse(fs.readFileSync(process.env.OCR_FIXTURE, 'utf8'));
    if (process.env.OCR_FIXTURE_LOG) fs.appendFileSync(process.env.OCR_FIXTURE_LOG, tier + '\n');
    return { images: runs[Math.min(fixtureCall++, runs.length - 1)], cost: 0, tier };
  }
  const M = MODELS[tier] || MODELS.fast;
  const key = getSetting('anthropic_key') || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('مفتاح القراءة الآلية غير موجود — حطه في الإعدادات، أو أدخل الأسطر يدويًا');
  const client = new Anthropic({ apiKey: key, timeout: 300000, maxRetries: 2 });
  const products = all('SELECT id, name, variant, price FROM products WHERE active = 1 ORDER BY name');
  const list = products.map(p => `${p.id}: ${p.name}${p.variant ? ' — ' + p.variant : ''} (${p.price})`).join('\n');

  const content = [];
  paths.forEach((p, i) => {
    content.push({ type: 'text', text: `الصورة ${i + 1}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: p.endsWith('.png') ? 'image/png' : 'image/jpeg', data: fs.readFileSync(p).toString('base64') } });
  });
  content.push({ type: 'text', text: `${PROMPT}\n\nقائمة الأصناف (رقم: الصنف — النوع (السعر)):\n${list}${feedback ? `\n\n${feedback}` : ''}` });

  const params = {
    model: M.id,
    max_tokens: 32000,
    output_config: { effort: M.effort, format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content }],
  };
  // القوي: لو رفض لأي سبب، يكمل بنموذج بديل من نفس الطلب
  const stream = tier === 'strong'
    ? client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : client.messages.stream(params);
  const res = await stream.finalMessage();
  const u = res.usage || {};
  const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const cost = (inTok * M.price[0] + (u.output_tokens || 0) * M.price[1]) / 1e6;
  if (res.stop_reason === 'refusal') throw new Error('تعذرت قراءة الصورة — أدخل الأسطر يدويًا');
  if (res.stop_reason === 'max_tokens') throw new Error('التذكرة طويلة مرة — قسّمها على أكثر من رفع');
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('ما قدرت أقرأ الرد — جرّب صورة أوضح'); }
  const valid = new Set(products.map(p => p.id));
  const images = (parsed.images || []).map(im => ({
    ...im,
    lines: (im.lines || []).map(l => ({ ...l, product_id: valid.has(l.product_id) ? l.product_id : null })),
  }));
  return { images, cost, tier };
}

module.exports = { readTicketImages };
