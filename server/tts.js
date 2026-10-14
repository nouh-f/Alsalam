'use strict';
// 🔊 الكتابة => صوت (رسالة صوتية للعمال). OpenAI gpt-4o-mini-tts بنفس مفتاح الصوت (stt_key) — بلهجة سعودية
const { getSetting } = require('./db');
const AI = require('./ai');

const MAX = 1500;
const PRICE_CHAR = 0.000015; // تقريبي
const clean = t => String(t || '').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/[*_~`#>]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, MAX);

async function speak(text, userId = null) {
  const key = getSetting('stt_key');
  if (!key) throw Object.assign(new Error('الصوت مو مفعّل — حط مفتاح OpenAI في إعدادات الواتساب'), { status: 400 });
  const input = clean(text); if (!input) throw Object.assign(new Error('وش أقول؟'), { status: 400 });
  AI.checkCap();
  const model = getSetting('tts_model') || 'gpt-4o-mini-tts';
  const r = await fetch(`${process.env.STT_API_BASE || 'https://api.openai.com/v1'}/audio/speech`, {
    method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, signal: AbortSignal.timeout(60000),
    body: JSON.stringify({ model, voice: getSetting('tts_voice') || 'ash', input, response_format: 'opus',
      instructions: 'تكلم بلهجة سعودية حجازية (جدة)، بصوت ودود وواضح وهادئ، زي زميل في المطعم يكلم زميله. لا تستعجل.' }),
  });
  if (!r.ok) throw Object.assign(new Error('ما قدرت أسوي الصوت' + (r.status === 401 ? ' — مفتاح OpenAI غلط' : '')), { status: 400 });
  const buf = Buffer.from(await r.arrayBuffer());
  AI.log(userId, 'tts', '[صوت]', input, input.length * PRICE_CHAR, model);
  return buf;
}

module.exports = { speak, clean };
