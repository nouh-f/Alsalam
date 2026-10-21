'use strict';
// الذكاء الاصطناعي المشترك: النماذج، الأسعار، حساب التكلفة، السجل، والحد الشهري
const fs = require('node:fs');
const Anthropic = require('@anthropic-ai/sdk');
const { get, run, getSetting } = require('./db');

// «سريع» رخيص للأسئلة والقراءة الأولى، و«قوي» للتحليل والتوصيات وإعادة القراءة
// الأسعار بالدولار لكل مليون توكن (مدخل، مخرج)
const MODELS = {
  fast: { id: 'claude-haiku-5-5', price: [0.10, 0.50], effort: 'medium' },
  mid: { id: 'claude-sonnet-5-5', price: [2, 10], effort: 'medium' }, // العمال: ذكي ونص سعر القوي
  strong: { id: 'claude-opus-5-5', price: [4, 20], effort: 'medium' },
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
  // كتابة الكاش: ساعة = ×2، خمس دقايق = ×1.25 (لو ما فيه تفصيل نحسبها كلها ×1.25)
  const cc = u.cache_creation || {}, h1 = cc.ephemeral_1h_input_tokens || 0, m5 = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : Math.max(0, (u.cache_creation_input_tokens || 0) - h1);
  return ((u.input_tokens || 0) * M.price[0] + m5 * M.price[0] * 1.25 + h1 * M.price[0] * 2
    + (u.cache_read_input_tokens || 0) * M.price[0] * 0.1 + (u.output_tokens || 0) * M.price[1]) / 1e6;
}

const cap = () => Number(getSetting('ai_monthly_cap', '15')) || 0;
function monthSpent() {
  const a = get("SELECT SUM(cost) AS c FROM ai_log WHERE at >= date('now', 'start of month')").c || 0;
  const t = get("SELECT SUM(ocr_cost) AS c FROM tickets WHERE created_at >= date('now', 'start of month')").c || 0;
  return a + t;
}
function checkCap() {
  const c = cap();
  if (c > 0 && monthSpent() >= c) throw Object.assign(new Error(`وصل صرف الذكاء الاصطناعي حد الشهر (${c} دولار) — ارفع الحد من الإعدادات أو انتظر الشهر الجاي`), { status: 400 });
}
function log(userId, kind, question, answer, cost, model, usage = null) {
  run('INSERT INTO ai_log(user_id, kind, question, answer, cost, model, usage) VALUES(?,?,?,?,?,?,?)', userId || null, kind, question || '', answer || '', cost || 0, model || '', usage ? JSON.stringify(usage) : '');
}

// للاختبار بس: ردود جاهزة بدل الاتصال (كل نداء ياخذ اللي بعده)
let fixtureCall = 0;
function fixture(params) {
  if (!process.env.AI_FIXTURE) return null;
  if (process.env.AI_FIXTURE_LOG) fs.appendFileSync(process.env.AI_FIXTURE_LOG, JSON.stringify((params.messages || []).at(-1)) + '\n');
  if (process.env.AI_FIXTURE_SYSLOG) fs.appendFileSync(process.env.AI_FIXTURE_SYSLOG, JSON.stringify(params.system || '') + '\n');
  const runs = JSON.parse(fs.readFileSync(process.env.AI_FIXTURE, 'utf8'));
  return runs[Math.min(fixtureCall++, runs.length - 1)];
}

// 📊 كل نداء ينسجل بتوكناته (عشان لوحة «صرف الذكاء» تعرف وين تروح الفلوس بالضبط)
function logCall(meta, model, usage, cost) {
  const u = usage || {};
  try {
    run('INSERT INTO ai_calls(kind, user_id, model, input_tokens, cache_write, cache_read, output_tokens, images, cost) VALUES(?,?,?,?,?,?,?,?,?)',
      meta.kind || '', meta.userId || null, model, u.input_tokens || 0, u.cache_creation_input_tokens || 0, u.cache_read_input_tokens || 0, u.output_tokens || 0, meta.images || 0, cost || 0);
  } catch (e) { console.error('ai_calls', e.message); }
}

// 🗜️ الصور تتصغر قبل ما تطلع (800 للكلام، 1280 للأوراق)
async function shrinkImages(messages, kind) {
  let IMG = null, n = 0; // sharp ينحمّل بس لو فيه صورة
  for (const m of messages || []) if (Array.isArray(m.content)) for (const b of m.content) {
    if (b && b.type === 'image' && b.source && b.source.type === 'base64' && !b._small) {
      IMG = IMG || require('./img');
      const r = await IMG.shrinkB64(b.source.data, b.source.media_type, kind);
      b.source.media_type = r.media_type; b.source.data = r.data; Object.defineProperty(b, '_small', { value: true, enumerable: false }); n++;
    }
  }
  return n;
}

// نداء واحد (بدون أدوات أو معها)
// 💰 قواعد التوفير: Opus (strong) مقفول إلا بضغطة زر من المالك (meta.manual) — غيره ينزل Sonnet.
// التفكير مطفي للرخيص (Haiku) ومحدود للمتوسط، والجهد «low»، والرد محدود (meta.maxOut أو 3000)
async function create(tier, params, meta = {}) {
  if (tier === 'strong' && !meta.manual) tier = 'mid';
  const images = await shrinkImages(params.messages, meta.imgKind || 'doc');
  const fx = fixture(params);
  if (fx) { const usage = fx.usage || {}; logCall({ ...meta, images }, (MODELS[tier] || MODELS.fast).id, usage, costOf(usage, tier)); return { ...fx, usage }; }
  const M = MODELS[tier] || MODELS.fast;
  const c = client();
  const cheap = !meta.manual;
  const p = { model: M.id, ...params,
    max_tokens: Math.min(Number(params.max_tokens) || 3000, meta.maxOut || (cheap ? 3000 : 16000)),
    output_config: { effort: cheap ? 'low' : M.effort, ...(params.output_config || {}), ...(cheap ? { effort: 'low' } : {}) } };
  if (cheap && !params.thinking) p.thinking = tier === 'fast' ? { type: 'disabled' } : { type: 'between_tools' };
  try {
    const stream = tier === 'strong'
      ? c.beta.messages.stream({ ...p, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : c.messages.stream(p);
    const res = await stream.finalMessage();
    logCall({ ...meta, images }, M.id, res.usage, costOf(res.usage, tier));
    return res;
  } catch (e) {
    // أخطاء Anthropic (مفتاح غلط 401، زحمة 529…) ترجع للمستخدم كرسالة — مو كـ«سجّل دخول»
    const msg = e.status === 401 ? 'مفتاح الذكاء الاصطناعي غلط — غيّره من الإعدادات'
      : e.status === 429 || e.status === 529 ? 'الذكاء الاصطناعي زحمة الحين — جرّب بعد دقيقة'
      : 'تعذر الاتصال بالذكاء الاصطناعي: ' + (e.message || e);
    throw Object.assign(new Error(msg), { status: 400 });
  }
}
const textOf = res => (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();

module.exports = { MODELS, apiKey, client, costOf, cap, monthSpent, checkCap, log, logCall, create, textOf };
