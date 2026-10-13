'use strict';
// 🖨️ «طابعة» على المنفذ 9100: الكاشير (لويفرس) يحسبنا طابعة مطبخ — كل تذكرة تنحفظ «تنطبع» عندنا
// نحفظ كل طلب كما هو (الخام + النص + الصورة) في أرشيف ما ينحذف ولا يتعدل. المنفذ يستقبل بس — ما يعطي بيانات لأحد
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { get, run, getSetting, setSetting, UPLOAD_DIR } = require('./db');

const DIR = path.join(UPLOAD_DIR, 'print'); // مو تحت /uploads/ المفتوح — يطلع من مسارات المالك بس
const MAX = 2 * 1024 * 1024, PER_HOUR = 300, IDLE_MS = 3000;
const ESC = 0x1b, GS = 0x1d, FS = 0x1c, DLE = 0x10;

// ===== قراءة أوامر الطابعة (ESC/POS): النص + الصور النقطية، والرد على «وش حالك؟» =====
function parse(buf, reply = () => {}) {
  const text = [], stripes = [];
  let i = 0;
  const n = k => buf[i + k] ?? 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b === ESC) {
      const c = n(1);
      if (c === 0x2a) { // ESC * m nL nH: صورة عمودية (8 أو 24 نقطة)
        const m = n(2), w = n(3) + n(4) * 256, h = m >= 32 ? 24 : 8, per = h / 8;
        const data = buf.subarray(i + 5, i + 5 + w * per);
        const rowBytes = Math.ceil(w / 8), out = Buffer.alloc(rowBytes * h);
        for (let x = 0; x < w; x++) for (let k = 0; k < per; k++) {
          const byte = data[x * per + k] || 0;
          for (let bit = 0; bit < 8; bit++) if (byte & (0x80 >> bit)) { const y = k * 8 + bit; out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7); }
        }
        stripes.push({ w: rowBytes, h, data: out }); i += 5 + w * per; continue;
      }
      if (c === 0x40 || c === 0x32 || c === 0x3c) { i += 2; continue; } // @ 2 <
      if (c === 0x70) { i += 5; continue; } // ESC p m t1 t2
      if (c === 0x44) { let j = i + 2; while (j < buf.length && buf[j] !== 0) j++; i = j + 1; continue; } // ESC D … NUL
      if (c === 0x24 || c === 0x5c) { i += 4; continue; } // ESC $ / ESC \ nL nH
      i += 3; continue; // أغلب أوامر ESC: حرف + رقم
    }
    if (b === GS) {
      const c = n(1);
      if (c === 0x76 && n(2) === 0x30) { // GS v 0 m xL xH yL yH: صورة نقطية
        const w = n(4) + n(5) * 256, h = n(6) + n(7) * 256;
        stripes.push({ w, h, data: Buffer.from(buf.subarray(i + 8, i + 8 + w * h)) }); i += 8 + w * h; continue;
      }
      if (c === 0x28) { i += 5 + n(3) + n(4) * 256; continue; } // GS ( fn pL pH …
      if (c === 0x56) { i += n(2) >= 65 ? 4 : 3; continue; } // قص الورق
      if (c === 0x4c || c === 0x57 || c === 0x24 || c === 0x5c || c === 0x50) { i += 4; continue; }
      if (c === 0x6b) { const m = n(2); if (m <= 6) { let j = i + 3; while (j < buf.length && buf[j] !== 0) j++; i = j + 1; } else i += 4 + n(3); continue; } // باركود
      if (c === 0x72 || c === 0x49) { reply(Buffer.from([0x00])); i += 3; continue; } // طلب حالة/معلومات
      if (c === 0x61) { i += 3; continue; }
      i += 3; continue;
    }
    if (b === FS) { const c = n(1); i += c === 0x26 || c === 0x2e ? 2 : c === 0x70 ? 4 : 3; continue; }
    if (b === DLE && (n(1) === 0x04 || n(1) === 0x05)) { if (n(1) === 0x04) reply(Buffer.from([0x12])); i += 3; continue; } // «وش حالك؟» => شغالة
    if (b === 0x0a || b === 0x0d) { text.push(0x0a); i++; continue; }
    if (b === 0x09) { text.push(0x20); i++; continue; }
    if (b >= 0x20) text.push(b);
    i++;
  }
  return { text: decode(Buffer.from(text)), stripes };
}

// UTF-8 لو صحيح، وإلا CP1256 (عربي ويندوز)
function decode(b) {
  if (!b.length) return '';
  let t;
  try { t = new TextDecoder('utf-8', { fatal: true }).decode(b); }
  catch { try { t = new TextDecoder('windows-1256').decode(b); } catch { t = b.toString('latin1'); } }
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

// ===== الصور النقطية => PNG (أبيض وأسود) =====
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = b => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
function toPng(stripes) {
  if (!stripes.length) return null;
  const wBytes = Math.max(...stripes.map(s => s.w)), h = stripes.reduce((t, s) => t + s.h, 0);
  if (!wBytes || !h || h > 20000) return null;
  const rows = [];
  for (const s of stripes) for (let y = 0; y < s.h; y++) {
    const row = Buffer.alloc(1 + wBytes, 0xff); row[0] = 0; // PNG: 1 = أبيض، الطابعة: 1 = أسود
    for (let x = 0; x < s.w; x++) row[1 + x] = ~(s.data[y * s.w + x] || 0) & 0xff;
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(wBytes * 8, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 1; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

// ===== طباعة حقيقية ولا زبالة من الإنترنت؟ =====
// برامج على الإنترنت تفحص أي منفذ مفتوح (كاميرات NVMS، TLS، HTTP…) — نحفظ بس اللي فيه أوامر طابعة ESC/POS
const MARKERS = [[0x1b, 0x40], [0x1d, 0x56], [0x1d, 0x76, 0x30], [0x1b, 0x61], [0x1b, 0x45], [0x1b, 0x21], [0x1d, 0x21], [0x1b, 0x2a], [0x1b, 0x74], [0x1c, 0x26], [0x1c, 0x2e], [0x1b, 0x64]];
function looksPrint(buf) {
  if (!buf || buf.length < 2) return false;
  if (buf[0] === 0x16 && buf[1] === 0x03) return false; // TLS
  const head = buf.subarray(0, 12).toString('latin1');
  if (/^(GET |POST|HEAD |PUT |OPTIONS|<\?xml|\{|SSH-|<\?|<!DOC|<html)/i.test(head)) return false;
  if (buf[0] === 0x1b && buf[1] === 0x40) return true; // ESC @ — أي طابعة تبدأ فيه
  let n = 0;
  for (const m of MARKERS) if (buf.indexOf(Buffer.from(m)) >= 0) n++;
  return n >= 2;
}
function junkSeen(ip) {
  let r = {}; try { r = JSON.parse(getSetting('printer_junk') || '{}'); } catch { /* */ }
  setSetting('printer_junk', JSON.stringify({ n: (r.n || 0) + 1, ip, at: new Date().toISOString() }));
}

// ===== الحفظ =====
const ipsAllowed = () => String(getSetting('printer_ips') || '').split(',').map(s => s.trim()).filter(Boolean);
function save(ip, buf, parsed) {
  fs.mkdirSync(DIR, { recursive: true });
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const name = `${Date.now()}-${sha.slice(0, 10)}`;
  fs.writeFileSync(path.join(DIR, name + '.bin'), buf);
  const png = toPng(parsed.stripes);
  if (png) fs.writeFileSync(path.join(DIR, name + '.png'), png);
  return Number(run("INSERT INTO printer_jobs(at, ip, bytes, raw_file, text, has_image, image_file, sha256) VALUES(datetime('now'),?,?,?,?,?,?,?)",
    ip, buf.length, name + '.bin', parsed.text, png ? 1 : 0, png ? name + '.png' : '', sha).lastInsertRowid);
}

function start(port = 9100) {
  const hits = new Map();
  const srv = net.createServer(sock => {
    const ip = String(sock.remoteAddress || '').replace(/^::ffff:/, '');
    const chunks = []; let size = 0, done = false, timer;
    const finish = () => {
      if (done) return; done = true; clearTimeout(timer);
      try {
        if (!size) return;
        const allowed = ipsAllowed();
        if (allowed.length && !allowed.includes(ip)) { // من عنوان مو معتمد: ما ينحفظ، بس نسجل إنه حاول
          const r = JSON.parse(getSetting('printer_rejected') || '{}');
          setSetting('printer_rejected', JSON.stringify({ ip, at: new Date().toISOString(), n: (r.ip === ip ? r.n || 0 : 0) + 1 }));
          return;
        }
        const now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < 3600e3);
        if (h.length >= PER_HOUR) return;
        h.push(now); hits.set(ip, h);
        const buf = Buffer.concat(chunks);
        if (!looksPrint(buf)) { if (buf.length > 3) junkSeen(ip); return; } // فحص من الإنترنت — مو طابعة
        const parsed = parse(buf);
        if (!parsed.text && !parsed.stripes.length && buf.length <= 64) return; // سؤال حالة بس — مو تذكرة
        save(ip, buf, parsed);
      } catch (e) { console.error('printer', e.message); }
    };
    const idle = () => { clearTimeout(timer); timer = setTimeout(() => { finish(); sock.end(); }, IDLE_MS); };
    sock.on('data', c => {
      size += c.length;
      if (size > MAX) { sock.destroy(); return finish(); }
      chunks.push(c);
      // يرد على طلبات الحالة على طول (عشان الكاشير يحسبها طابعة شغالة)
      if (c.length <= 16) try { parse(c, r => { if (!sock.destroyed) sock.write(r); }); } catch { /* */ }
      idle();
    });
    sock.on('end', finish); sock.on('close', finish); sock.on('error', () => finish());
    idle();
  });
  srv.on('error', e => console.error('printer port', e.message));
  srv.listen(port, '0.0.0.0', () => console.log(`🖨️ الطابعة تستقبل على المنفذ ${port}`));
  return srv;
}

module.exports = { start, parse, toPng, looksPrint, DIR };
