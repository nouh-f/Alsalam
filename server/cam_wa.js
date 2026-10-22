'use strict';
// 📹 «صوّر الكاشير / صوّر كل الكاميرات» من الواتساب (المالك والمشرفين بس): لقطات الحين في صورة وحدة — بدون ذكاء (ببلاش)
const CAM = require('./cameras');
const { all, getSetting } = require('./db');

const ASK = /(صو[ّ]?ر|صوره|صورة|لقط[ةه]|لقطات|وريني|ورني)/;
const LOOK = /(^|\s)(أ|ا)?شوف(\s|$)/; // «شوف/أبغى أشوف» — بس مع مكان أو «الكاميرات»
const CAMS = /كامير|كمر/;
const WHERE = { cashier: /كاشير/, kitchen: /مطبخ|مرسل/, store: /مستودع|مخزن/, hall: /صال[ةه]|عوائل|شباب|جالس|زباين|زبائن/, door: /باب|مدخل|برا|قدام المحل/ };
const ALL = /كل|جميع|زوايا|المحل|المطعم|الحين|الان|الآن|دحين|حين/;
const NOT = /^\[|فاتور|ورق|حساب|منيو|الطلب|واتس/; // «أرسلت صور الفاتورة الحين» مو طلب كاميرا
// يرجع الأدوار المطلوبة ([] = كل الكاميرات)، أو null لو مو طلب صور
function match(text) {
  const t = String(text || '').trim();
  if (t.length > 140 || NOT.test(t)) return null;
  const ask = ASK.test(t), look = LOOK.test(t), cams = CAMS.test(t);
  if (!ask && !look && !cams) return null;
  const roles = Object.keys(WHERE).filter(k => WHERE[k].test(t));
  if (roles.length) return roles;
  if (cams && (ask || look || /كل|جميع/.test(t))) return [];
  if (ask && (ALL.test(t) || t.split(/\s+/).length <= 2)) return []; // «صوّر» / «صور الحين»
  return null;
}

const last = new Map(); // ما يتكرر أكثر من مرة كل ٢٠ ثانية لنفس المحادثة
async function shot(chat, roles, { wait = 35000 } = {}) { // الجسر ياخذ الكاميرات وحدة وحدة (٩ × ~٢ ثانية)
  if (!getSetting('cam_bridge_token')) return { error: 'الكاميرات مو مربوطة' };
  if (Date.now() - (last.get(chat) || 0) < 20e3) return { error: 'صوّرت قبل ثواني — الصورة جاية، أو جرّب بعد شوي' };
  last.set(chat, Date.now());
  const chans = roles.length ? all(`SELECT ch, name FROM cam_channels WHERE role IN (${roles.map(() => '?').join(',')}) ORDER BY ch`, ...roles)
    : all("SELECT ch, name FROM cam_channels WHERE name NOT LIKE '%ما ترد%' ORDER BY ch");
  if (!chans.length) return { error: 'ما فيه كاميرا بهالاسم' };
  const ids = await Promise.all(chans.map(c => CAM.snapNow(c.ch, 'wa', `wa:${chat}`, wait)));
  const got = chans.map((c, i) => ({ ...c, sid: ids[i] })).filter(c => c.sid);
  if (!got.length) return { error: 'ما وصلت ولا لقطة — شيك إن جوال الجسر شغال' };
  const sharp = require('sharp');
  const W = 704, H = 576, cols = got.length === 1 ? 1 : got.length <= 4 ? 2 : 3, rows = Math.ceil(got.length / cols);
  const tiles = await Promise.all(got.map(async (c, i) => {
    const s = all('SELECT * FROM cam_snaps WHERE id = ?', c.sid)[0];
    return { input: await sharp(CAM.file(s)).resize(W, H, { fit: 'fill' }).toBuffer(), left: (i % cols) * W, top: Math.floor(i / cols) * H };
  }));
  const buf = await sharp({ create: { width: cols * W, height: rows * H, channels: 3, background: '#ffffff' } }).composite(tiles).jpeg({ quality: 72 }).toBuffer();
  return { buf, names: got.map(c => c.name), missing: chans.filter((c, i) => !ids[i]).map(c => c.name) };
}

module.exports = { match, shot };
