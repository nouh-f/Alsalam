'use strict';
// 🎤 الصوت => كتابة (رسائل الواتساب الصوتية). OpenAI: gpt-4o-mini-transcribe — عربي ممتاز وتقريبًا 0.003$ للدقيقة
// المفتاح يحطه المالك في الإعدادات (stt_key). التكلفة تنحسب في سجل الذكاء الاصطناعي وحده الشهري
const { getSetting, all } = require('./db');
const AI = require('./ai');

const PRICE_MIN = { 'gpt-4o-mini-transcribe': 0.003, 'gpt-4o-transcribe': 0.006, 'whisper-1': 0.006 };
const MAX_SEC = 120;
const ready = () => !!getSetting('stt_key');
const model = () => getSetting('stt_model') || 'gpt-4o-mini-transcribe';

const PROMPT = 'مطعم السلام: جرد، فول، عدس، دجاج، مندي، مرسة، فتة، حنيذ، طماطم، خبز، كرتون، كيس، قدر، تمام، خصم.';
const words = p => new Set(String(p).replace(/[:،.,()]/g, ' ').split(/\s+/).filter(Boolean));
// 🐟 أسماء أصناف الموظف نفسه (حريد، هامور، فارس…) تنضاف للتلميح عشان يسمعها صح
function promptFor(userId) {
  if (!userId) return PROMPT;
  const names = all(`SELECT i.name FROM items i LEFT JOIN sections s ON s.id = i.section_id WHERE i.active = 1
    AND ? IN (COALESCE(i.opening_user_id, s.opening_user_id), COALESCE(i.closing_user_id, s.closing_user_id), i.prep_user_id) ORDER BY i.sort, i.id LIMIT 30`, userId).map(r => r.name);
  return names.length ? `${PROMPT} ${names.join('، ')}.` : PROMPT;
}
function echoesPrompt(t, prompt = PROMPT) {
  const pw = words(prompt), w = String(t || '').replace(/[:،.,()]/g, ' ').split(/\s+/).filter(Boolean);
  return w.length >= 4 && w.filter(x => pw.has(x)).length / w.length >= 0.7;
}

async function transcribe(buf, mime = 'audio/ogg', seconds = 0, userId = null) {
  if (!ready()) throw Object.assign(new Error('الرسائل الصوتية مو مفعّلة — اكتبها كتابة'), { status: 400 });
  if (seconds > MAX_SEC) throw Object.assign(new Error('الرسالة الصوتية طويلة — قسّمها أو اكتبها'), { status: 400 });
  AI.checkCap();
  const ext = /mpeg|mp3/.test(mime) ? 'mp3' : /mp4|m4a|aac/.test(mime) ? 'm4a' : /wav/.test(mime) ? 'wav' : /webm/.test(mime) ? 'webm' : 'ogg';
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: String(mime).split(';')[0] || 'audio/ogg' }), 'voice.' + ext);
  fd.append('model', model());
  fd.append('language', 'ar');
  const prompt = promptFor(userId);
  fd.append('prompt', prompt);
  const r = await fetch(`${process.env.STT_API_BASE || 'https://api.openai.com/v1'}/audio/transcriptions`, {
    method: 'POST', headers: { authorization: 'Bearer ' + getSetting('stt_key') }, body: fd, signal: AbortSignal.timeout(60000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error('ما قدرت أسمع الصوت' + (r.status === 401 ? ' — مفتاح الصوت غلط' : '')), { status: 400 });
  let text = String(j.text || '').trim();
  if (echoesPrompt(text, prompt)) text = ''; // صوت فاضي => يرجع كلمات التلميح نفسها («مطعم السلام: جرد، فول…»)
  AI.log(userId, 'stt', `[صوت ${seconds || '?'} ث]`, text, (Math.max(seconds, 5) / 60) * (PRICE_MIN[model()] || 0.006), model());
  return text;
}

module.exports = { transcribe, ready, echoesPrompt, promptFor };
