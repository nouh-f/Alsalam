'use strict';
// قراءة صورة تذكرة الكاشير (ورقة آجل/ديون) بالذكاء الاصطناعي: الاسم + العدد + السعر
const fs = require('node:fs');
const Anthropic = require('@anthropic-ai/sdk');
const { all, getSetting } = require('./db');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lines'],
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'qty', 'unit_price', 'total', 'customer', 'note', 'product_id'],
        properties: {
          name: { type: 'string', description: 'اسم الصنف كما هو مكتوب' },
          qty: { type: 'number', description: 'العدد أو الوزن' },
          unit_price: { type: 'number', description: 'سعر الوحدة إن وُجد وإلا 0' },
          total: { type: 'number', description: 'المبلغ الإجمالي للسطر إن وُجد وإلا 0' },
          customer: { type: 'string', description: 'اسم الزبون/الدين إن وُجد وإلا فارغ' },
          note: { type: 'string', description: 'ملاحظة مكتوبة على الصنف مثل "عسل بس" وإلا فارغ' },
          product_id: { type: ['integer', 'null'], description: 'رقم الصنف المطابق من القائمة أو null' },
        },
      },
    },
  },
};

async function readTicketImages(paths) {
  const key = getSetting('anthropic_key') || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('مفتاح القراءة الآلية غير موجود — حطه في الإعدادات، أو أدخل الأسطر يدويًا');
  const client = new Anthropic({ apiKey: key, timeout: 180000, maxRetries: 2 });
  const products = all('SELECT id, name, variant, price FROM products WHERE active = 1 ORDER BY name');
  const list = products.map(p => `${p.id}: ${p.name}${p.variant ? ' — ' + p.variant : ''} (${p.price})`).join('\n');

  const content = [];
  for (const p of paths) {
    const data = fs.readFileSync(p).toString('base64');
    const media = p.endsWith('.png') ? 'image/png' : 'image/jpeg';
    content.push({ type: 'image', source: { type: 'base64', media_type: media, data } });
  }
  content.push({ type: 'text', text:
`هذي صور ورقة الكاشير (تذكرة آجل/ديون) من مطعم شعبي يمني/سعودي. الكتابة غالبًا بخط اليد وبالعامية.
استخرج كل صنف مكتوب: الاسم، العدد (أو الوزن بالكيلو)، سعر الوحدة والمبلغ إذا مكتوبين، واسم الزبون إذا السطر تحت اسم زبون، وأي ملاحظة على الصنف.
- الأرقام قد تكون عربية (١٢٣) أو مكتوبة كلمات (عشرة لحوح = 10). "نص" = 0.5، "ربع" = 0.25.
- لا تجمع صور مكررة مرتين إذا كانت نفس الورقة مصورة أكثر من مرة.
- لا تحط المجاميع النهائية أو أسطر "الإجمالي" كأصناف.
- اربط كل سطر بأقرب صنف من قائمة أصناف المطعم التالية (حتى لو الكتابة مختلفة)، وحط product_id، وإذا ما فيه تطابق واضح حط null.
- إذا الصنف له نوع (مثل دراك ني / دراك قلي، مكشن دراك / مكشن قنبري) اختر النوع المطابق.

قائمة الأصناف (رقم: اسم — نوع (السعر)):
${list}` });

  const res = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content }],
  });
  if (res.stop_reason === 'refusal') throw new Error('تعذرت قراءة الصورة — أدخل الأسطر يدويًا');
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('ما قدرت أقرأ الرد — جرّب صورة أوضح'); }
  const valid = new Set(products.map(p => p.id));
  return (parsed.lines || []).map(l => ({ ...l, product_id: valid.has(l.product_id) ? l.product_id : null }));
}

module.exports = { readTicketImages };
