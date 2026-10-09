'use strict';
// الذكاء الاصطناعي المشترك: النماذج، الأسعار، حساب التكلفة، السجل، والحد الشهري
const fs = require('node:fs');
const Anthropic = require('@anthropic-ai/sdk');
const { get, run, getSetting } = require('./db');

// «سريع» رخيص للأسئلة والقراءة الأولى، و«قوي» للتحليل والتوصيات وإعادة القراءة
// الأسعار بالدولار لكل مليون توكن (مدخل، مخرج)
const MODELS = {
  fast: { id: 'claude-haiku-5-5', price: [0.10, 0.50], effort: 'medium' },
  strong: { id: 'claude-opus-5-5', price: [4, 20], effort: 'high' },
};

function apiKey() { return getSetting('anthropic_key') || process.env.ANTHROPIC_API_KEY || ''; }
function client(timeout = 300000) {
  const key = apiKey();
  if (!key) throw Object.assign(new Error('مفتاح الذكاء الاصطناعي غير موجود — حطه في الإعدادات'), { status: 400 });
  return new Anthropic({ apiKey: key, timeout, maxRetries: 2 });
}

// تقريبي: الكاش المقروء بعُشر السعر، والمكتوب بزيادة الربع
function costOf(usage, tier) {
  const M = MODELS[tier] || MODELS.fast, u = usage || {};
  return ((u.input_tokens || 0) * M.price[0] + (u.cache_creation_input_tokens || 0) * M.price[0] * 1.25
    + (u.cache_read_input_tokens || 0) * M.price[0] * 0.1 + (u.output_tokens || 0) * M.price[1]) / 1e6;
}

const cap = () => Number(getSetting('ai_monthly_cap', '20')) || 0;
function monthSpent() {
  const a = get("SELECT SUM(cost) AS c FROM ai_log WHERE at >= date('now', 'start of month')").c || 0;
  const t = get("SELECT SUM(ocr_cost) AS c FROM tickets WHERE created_at >= date('now', 'start of month')").c || 0;
  return a + t;
}
function checkCap() {
  const c = cap();
  if (c > 0 && monthSpent() >= c) throw Object.assign(new Error(`وصل صرف الذكاء الاصطناعي حد الشهر (${c} دولار) — ارفع الحد من الإعدادات أو انتظر الشهر الجاي`), { status: 400 });
}
function log(userId, kind, question, answer, cost, model) {
  run('INSERT INTO ai_log(user_id, kind, question, answer, cost, model) VALUES(?,?,?,?,?,?)', userId || null, kind, question || '', answer || '', cost || 0, model || '');
}

// للاختبار بس: ردود جاهزة بدل الاتصال (كل نداء ياخذ اللي بعده)
let fixtureCall = 0;
function fixture(params) {
  if (!process.env.AI_FIXTURE) return null;
  if (process.env.AI_FIXTURE_LOG) fs.appendFileSync(process.env.AI_FIXTURE_LOG, JSON.stringify((params.messages || []).at(-1)) + '\n');
  const runs = JSON.parse(fs.readFileSync(process.env.AI_FIXTURE, 'utf8'));
  return runs[Math.min(fixtureCall++, runs.length - 1)];
}

// نداء واحد (بدون أدوات أو معها). القوي: لو رفض لأي سبب يكمل بنموذج بديل من نفس الطلب
async function create(tier, params) {
  const fx = fixture(params);
  if (fx) return { ...fx, usage: fx.usage || {} };
  const M = MODELS[tier] || MODELS.fast;
  const c = client();
  const p = { model: M.id, max_tokens: 16000, ...params, output_config: { effort: M.effort, ...(params.output_config || {}) } };
  try {
    const stream = tier === 'strong'
      ? c.beta.messages.stream({ ...p, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : c.messages.stream(p);
    return await stream.finalMessage();
  } catch (e) {
    // أخطاء Anthropic (مفتاح غلط 401، زحمة 529…) ترجع للمستخدم كرسالة — مو كـ«سجّل دخول»
    const msg = e.status === 401 ? 'مفتاح الذكاء الاصطناعي غلط — غيّره من الإعدادات'
      : e.status === 429 || e.status === 529 ? 'الذكاء الاصطناعي زحمة الحين — جرّب بعد دقيقة'
      : 'تعذر الاتصال بالذكاء الاصطناعي: ' + (e.message || e);
    throw Object.assign(new Error(msg), { status: 400 });
  }
}
const textOf = res => (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();

module.exports = { MODELS, apiKey, client, costOf, cap, monthSpent, checkCap, log, create, textOf };
