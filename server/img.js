'use strict';
// 🗜️ تصغير الصور قبل Claude: الصورة الكاملة من الجوال ≈ 4800 توكن — بعد التصغير ≈ 300-1500
// كلام/كاميرا: أطول ضلع 800، والأوراق والفواتير المكتوبة باليد: 1280 (أقل من كذا الخط ما ينقرا). JPEG جودة 70
// لو التصغير فشل: الصورة تروح زي ما هي، بس ينكتب تحذير «img_fail» في سجل الذكاء (يطلع في اللوحة بالأحمر)
const SIZE = { chat: 800, doc: 1280 };
let sharp = null, loadErr = '';
try { sharp = require('sharp'); sharp.concurrency(1); sharp.cache(false); } catch (e) { loadErr = e.message; } // خيط واحد: السيرفر صغير، والصور قليلة

const logFail = (why) => {
  try { require('./ai').log(null, 'img_fail', why.slice(0, 300), '', 0, 'sharp'); } catch { /* */ }
  console.error('⚠️ تصغير الصورة فشل:', why);
};

// base64 (بدون data:) => { media_type, data } مصغّرة
async function shrinkB64(b64, mediaType = 'image/jpeg', kind = 'chat') {
  const max = SIZE[kind] || SIZE.chat;
  if (!sharp) { logFail(`sharp مو موجود: ${loadErr}`); return { media_type: mediaType, data: b64 }; }
  try {
    const out = await sharp(Buffer.from(b64, 'base64'), { failOn: 'none' }).rotate()
      .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
    return { media_type: 'image/jpeg', data: out.toString('base64') };
  } catch (e) { logFail(e.message); return { media_type: mediaType, data: b64 }; }
}

// data URL => data URL مصغّر (للي يتعاملون مع data:image/...;base64,...)
async function shrinkDataUrl(d, kind = 'chat') {
  const m = /^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/s.exec(d || '');
  if (!m) return d;
  const r = await shrinkB64(m[2], m[1] === 'image/jpg' ? 'image/jpeg' : m[1], kind);
  return `data:${r.media_type};base64,${r.data}`;
}
const shrinkAll = (list, kind) => Promise.all((list || []).map(d => shrinkDataUrl(d, kind)));

// للفحص في التحديث
const ready = () => !!sharp;

module.exports = { shrinkB64, shrinkDataUrl, shrinkAll, ready, SIZE };
