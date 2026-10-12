'use strict';
// 📱 الواتساب (WhatsApp Business Cloud API من ميتا): باب ثاني لنفس المساعد
// العامل يرسل «آخر الدوام: فول ٣ قدور…» => المساعد يجهّز الكرت باسم الموظف (نفس صلاحياته) => يرد بالملخص => «تمام» => ينسجل على نفس المسارات
const crypto = require('node:crypto');
const { all, get, run, getSetting } = require('./db');
const AS = require('./assistant');

const API = () => process.env.WA_API_BASE || 'https://graph.facebook.com/v21.0';
const PENDING_MIN = 30; // الكرت ينتظر «تمام» نص ساعة
const YES = /^(تمام|تم|نعم|ايه|إيه|اي|أي|اكيد|أكيد|سجل|سجّل|سجله|سجّله|اوكي|أوكي|ok|okay|yes|y|👍|✅|✔️|✔)[\s.!،]*$/i;
const NO = /^(لا|إلغاء|الغاء|الغ|ألغ|كنسل|cancel|no|❌)[\s.!،]*$/i;

// 0550000000 / 550000000 / +966 55… / ٠٥٥… => 966550000000
function normPhone(v) {
  let d = String(v || '').replace(/[٠-٩]/g, c => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace(/[۰-۹]/g, c => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c)).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (/^05\d{8}$/.test(d)) d = '966' + d.slice(1);
  else if (/^5\d{8}$/.test(d)) d = '966' + d;
  return d;
}
const ready = () => !!(getSetting('wa_token') && getSetting('wa_phone_id'));

// توقيع ميتا: X-Hub-Signature-256 = sha256=HMAC(app_secret, الجسم كما هو)
function validSignature(raw, header) {
  const secret = getSetting('wa_app_secret');
  if (!secret || !header || !raw) return false;
  const want = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(String(header)), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function log(dir, phone, userId, text, msgId = null) {
  try { run("INSERT INTO wa_log(dir, phone, user_id, text, msg_id, at) VALUES(?,?,?,?,?,datetime('now'))", dir, phone, userId || null, String(text || '').slice(0, 4000), msgId); }
  catch (e) { if (!/UNIQUE/.test(e.message)) throw e; return false; }
  return true;
}

async function sendText(to, text) {
  text = String(text || '').slice(0, 4000);
  const r = await fetch(`${API()}/${getSetting('wa_phone_id')}/messages`, {
    method: 'POST', headers: { authorization: 'Bearer ' + getSetting('wa_token'), 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: false } }),
  });
  if (!r.ok) throw new Error('واتساب ما قبل الرسالة: ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const u = get('SELECT id FROM users WHERE phone = ?', to);
  log('out', to, u && u.id, text);
}

// صورة من الواتساب => data URL (نفس اللي يرسله البرنامج للمساعد)
async function mediaDataUrl(id) {
  const h = { authorization: 'Bearer ' + getSetting('wa_token') };
  const meta = await (await fetch(`${API()}/${id}`, { headers: h })).json();
  if (!meta || !meta.url) throw new Error('ما قدرت أنزل الصورة');
  const r = await fetch(meta.url, { headers: h });
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 12 * 1024 * 1024) throw new Error('الصورة كبيرة');
  const type = /png|webp/.test(meta.mime_type || '') ? meta.mime_type : 'image/jpeg';
  return `data:${type};base64,${buf.toString('base64')}`;
}

// آخر الكلام مع هالرقم (عشان «صحّح العدس ٣» يفهم وش قبله)
function history(phone) {
  return all("SELECT dir, text FROM wa_log WHERE phone = ? AND at >= datetime('now', '-2 hours') ORDER BY id DESC LIMIT 6", phone).reverse()
    .map(m => ({ role: m.dir === 'in' ? 'user' : 'assistant', text: m.text }));
}

const cardText = c => `*${c.title}*\n${(c.lines || []).map(l => '• ' + l).join('\n')}`;

function makeWhatsApp({ runAs }) {
  const queue = new Map(); // رسالة وحدة في نفس الوقت لكل رقم
  const chain = (phone, fn) => { const p = (queue.get(phone) || Promise.resolve()).then(fn, fn); queue.set(phone, p.catch(() => {})); return p; };

  async function handle(msg) {
    const phone = normPhone(msg.from);
    const u = get('SELECT * FROM users WHERE phone = ? AND active = 1 AND bot = 0', phone);
    const text = String((msg.text && msg.text.body) || (msg.image && msg.image.caption) || '').trim();
    if (!log('in', phone, u && u.id, text || (msg.image ? '[صورة]' : `[${msg.type}]`), msg.id)) return; // مكررة
    if (!u) return sendText(phone, 'رقمك مو مسجل في نظام مطعم السلام — كلم المشرف يضيف جوالك في صفحة الموظفين.');
    if (!['text', 'image'].includes(msg.type)) return sendText(phone, 'أقدر أقرأ الكتابة والصور بس.');

    run(`DELETE FROM wa_pending WHERE created_at < datetime('now', '-${PENDING_MIN} minutes')`);
    const pend = get('SELECT * FROM wa_pending WHERE phone = ?', phone);
    if (pend && msg.type === 'text' && NO.test(text)) { run('DELETE FROM wa_pending WHERE phone = ?', phone); return sendText(phone, 'انلغى — ما انسجل شي.'); }
    if (pend && msg.type === 'text' && YES.test(text)) {
      run('DELETE FROM wa_pending WHERE phone = ?', phone);
      const { actions, images } = JSON.parse(pend.data);
      const done = [], fail = [];
      for (const c of actions) {
        try {
          for (const r of c.requests) {
            const b = { ...r.body };
            if (r.attach_images) b.images = images;
            if (r.attach_image && images.length) b.image = images[0];
            await runAs(u, r.endpoint, b);
          }
          done.push(c.title);
        } catch (e) { fail.push(`${c.title}: ${e.message}`); }
      }
      return sendText(phone, [done.length ? `✓ انسجل: ${done.join('، ')}` : '', fail.length ? `⚠️ ما انسجل: ${fail.join('\n')}` : ''].filter(Boolean).join('\n'));
    }

    if (!ready()) return;
    const images = msg.type === 'image' ? [await mediaDataUrl(msg.image.id)] : [];
    const r = await AS.ask(u, (text || (images.length ? 'شوف الصورة' : '')) + '\n\n(يكلمك من الواتساب: لو جهزت كرت قله يرد «تمام» عشان ينسجل — مو «اضغط تأكيد». خل ردك قصير.)', history(phone).slice(0, -1), { images });
    let reply = String(r.answer || '').replace(/اضغط «?تأكيد»?/g, 'رد «تمام»');
    if (r.actions && r.actions.length) {
      run('INSERT INTO wa_pending(phone, user_id, data, created_at) VALUES(?,?,?,datetime(\'now\')) ON CONFLICT(phone) DO UPDATE SET user_id = excluded.user_id, data = excluded.data, created_at = excluded.created_at',
        phone, u.id, JSON.stringify({ actions: r.actions, images: r.actions.some(c => c.requests.some(x => x.attach_images || x.attach_image)) ? images : [] }));
      reply = `${reply}\n\n${r.actions.map(cardText).join('\n\n')}\n\nرد *تمام* عشان أسجله، أو *لا* للإلغاء، أو اكتب التصحيح.`;
    }
    return sendText(phone, reply.trim() || 'ما فهمت — اكتبها بطريقة ثانية.');
  }

  // ميتا ترسل كل التحديثات هنا: الرسائل (نشتغل عليها) وحالات الإرسال (نتجاهلها)
  function receive(raw, signature) {
    if (!validSignature(raw, signature)) { const e = new Error('توقيع غلط'); e.status = 401; throw e; }
    let body; try { body = JSON.parse(raw.toString('utf8')); } catch { const e = new Error('بيانات غير صحيحة'); e.status = 400; throw e; }
    const msgs = [];
    for (const en of body.entry || []) for (const ch of en.changes || []) for (const m of (ch.value && ch.value.messages) || []) msgs.push(m);
    // نرد ٢٠٠ على طول (ميتا تعيد الإرسال لو تأخرنا) والشغل يكمل بالخلفية
    const work = Promise.all(msgs.map(m => chain(normPhone(m.from), () => handle(m).catch(async e => {
      console.error('whatsapp', e.message);
      try { await sendText(normPhone(m.from), '⚠️ ' + (e.status && e.status < 500 ? e.message : 'صار خطأ — جرّب مرة ثانية')); } catch { /* */ }
    }))));
    return { ok: true, work };
  }

  function verify(q) {
    const want = getSetting('wa_verify_token');
    if (q['hub.mode'] === 'subscribe' && want && q['hub.verify_token'] === want) return String(q['hub.challenge'] || '');
    const e = new Error('غير مسموح'); e.status = 403; throw e;
  }

  return { receive, verify, sendText, ready };
}

module.exports = { makeWhatsApp, normPhone };
