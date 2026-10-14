'use strict';
// 📱 الواتساب: باب ثاني لنفس المساعد — بطريقتين: ربط رقم كجهاز مرتبط (link، يدخل القروبات) أو واتساب الرسمي (cloud)
// الخاص: العامل يرسل «آخر الدوام: فول ٣ قدور…» => المساعد يجهّز الكرت باسم الموظف (نفس صلاحياته) => يرد بالملخص => «تمام» => يتسجل
// القروبات (المفعّلة بس): يقرأ وما يرد أبدًا — «خصم فلان 50» => تأكيد من المالك في الخاص => الرواتب + رسالة للعامل؛ الطلبات => زكريا
const crypto = require('node:crypto');
const { all, get, run, getSetting, setSetting } = require('./db');
const AS = require('./assistant');
const AI = require('./ai');
const LINK = require('./wa_link');
const STT = require('./stt');

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
// الطريقة: link (الافتراضي) أو cloud (لو مسجل توكن ميتا وما اختار)
const mode = () => getSetting('wa_mode') || (getSetting('wa_token') ? 'cloud' : 'link');
const ready = () => mode() === 'cloud' ? !!(getSetting('wa_token') && getSetting('wa_phone_id')) : LINK.status().status === 'open';
const groupsOn = () => { try { return JSON.parse(getSetting('wa_groups') || '{}'); } catch { return {}; } }; // {jid: 'restaurant' | 'daily'}
const GROUP_LABEL = { restaurant: 'جروب المطعم', daily: 'حساب اليوم' };

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

// تنسيق الواتساب: *عريض* بنجمة وحدة، والعناوين (##) ما لها شكل هناك
const waFormat = t => String(t || '').replace(/\*\*([^*\n]+?)\*\*/g, '*$1*').replace(/^#{1,6}\s+/gm, '');
async function sendText(to, text) {
  text = waFormat(text).slice(0, 4000);
  if (mode() === 'link') { await LINK.sendText(to, text); const u = get('SELECT id FROM users WHERE phone = ?', to); log('out', to, u && u.id, text); return; }
  const r = await fetch(`${API()}/${getSetting('wa_phone_id')}/messages`, {
    method: 'POST', headers: { authorization: 'Bearer ' + getSetting('wa_token'), 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: false } }),
  });
  if (!r.ok) throw new Error('واتساب ما قبل الرسالة: ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const u = get('SELECT id FROM users WHERE phone = ?', to);
  log('out', to, u && u.id, text);
}

// صورة من الواتساب => data URL (نفس اللي يرسله البرنامج للمساعد)
async function mediaDataUrl(id, any = false) {
  const h = { authorization: 'Bearer ' + getSetting('wa_token') };
  const meta = await (await fetch(`${API()}/${id}`, { headers: h })).json();
  if (!meta || !meta.url) throw new Error('ما قدرت أنزل الصورة');
  const r = await fetch(meta.url, { headers: h });
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 12 * 1024 * 1024) throw new Error('الصورة كبيرة');
  const type = any ? (meta.mime_type || 'application/octet-stream') : /png|webp/.test(meta.mime_type || '') ? meta.mime_type : 'image/jpeg';
  return `data:${type};base64,${buf.toString('base64')}`;
}

// آخر الكلام مع هالرقم (عشان «صحّح العدس ٣» يفهم وش قبله)
function history(phone) {
  return all("SELECT dir, text FROM wa_log WHERE phone = ? AND at >= datetime('now', '-2 hours') ORDER BY id DESC LIMIT 10", phone).reverse()
    .map(m => ({ role: m.dir === 'in' ? 'user' : 'assistant', text: m.text }));
}

const cardText = c => `*${c.title}*\n${(c.lines || []).map(l => '• ' + l).join('\n')}`;

// أوقات قائمة الطلبات (ساعات الرياض) — الافتراضي ١٠ الصبح و٤ العصر
const reqSlots = () => String(getSetting('wa_req_times', '10,16')).split(',').map(Number).filter(h => h >= 0 && h < 24);
const nextSlotText = () => {
  const h = require('./calc').riyadhHour(), s = reqSlots().sort((a, b) => a - b);
  const n = s.find(x => x > h) ?? s[0];
  if (n == null) return 'قريب';
  const t = n === 0 ? '١٢ بالليل' : n < 12 ? `${n} الصبح` : n === 12 ? '١٢ الظهر' : n < 17 ? `${n - 12} العصر` : `${n - 12} بالليل`;
  return `الساعة ${t}`;
};

// كتابة في القروب (الربط بالـQR بس — الرسمي ما يدخل قروبات)
async function sendGroupText(jid, text) {
  if (!jid) return;
  text = waFormat(text);
  try { await LINK.sendGroup(jid, text); log('out', jid, null, text); } catch (e) { console.error('wa group send', e.message); }
}

// رسائل القروب: خصومات وطلبات (أو ولا شي)
const ISSUE_TYPES = Object.keys(require('./wa_issues').TYPES);
const GROUP_SCHEMA = { type: 'object', additionalProperties: false, required: ['deductions', 'requests', 'issues'], properties: {
  issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['employee', 'type', 'summary'], properties: {
    employee: { type: ['string', 'null'], description: 'اسم الموظف اللي عليه المشكلة (من القائمة) أو null لو مشكلة عامة' },
    type: { type: 'string', enum: ISSUE_TYPES }, summary: { type: 'string', description: 'وش المشكلة بجملة قصيرة' } } } },
  deductions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['employee', 'amount', 'reason'], properties: {
    employee: { type: 'string', description: 'اسم الموظف كما في القائمة' }, amount: { type: 'number' }, reason: { type: 'string' } } } },
  requests: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['item', 'qty', 'urgent'], properties: {
    item: { type: 'string' }, qty: { type: 'string', description: 'الكمية كما هي مكتوبة أو فاضي' },
    urgent: { type: 'boolean', description: 'true لو مكتوب إنه مستعجل/ضروري/الحين/خلص تمامًا' } } } },
} };
async function classifyGroup(text, sender, group) {
  AI.checkCap();
  const staff = all("SELECT name FROM users WHERE active = 1 AND bot = 0 AND role != 'owner'").map(x => x.name);
  const res = await AI.create('fast', { max_tokens: 1500, messages: [{ role: 'user', content: `رسالة في قروب واتساب «${group}» لمطعم السلام، من ${sender}:\n«${text}»\n\nالموظفين: ${staff.join('، ')}\n\nطلّع:\n- deductions: لو فيها خصم على موظف بمبلغ («خصم صادق 50 تأخير»). اسم الموظف من القائمة.\n- requests: لو فيها أغراض ناقصة/مطلوبة تنشرى للمطعم («ناقص طماطم»، «نبغى خبز ٢٠»). urgent = true لو قال مستعجل/ضروري/الحين/خلص تمامًا.
- issues: لو فيها مشكلة شغل: تأخير (late)، غياب (absent)، الجرد ما انسوى أو غلط (count)، نظافة (cleanliness)، تعامل/أسلوب (behavior)، هدر أو أكل خربان (waste)، طلب غلط أو تأخر على زبون (order)، شكوى زبون (customer)، جهاز/عطل (equipment)، نقص بضاعة (supply)، غيرها (other). employee = اللي عليه المشكلة لو مذكور. الخصم بحد ذاته مو issue.\nلو كلام عادي رجّع القوائم فاضية. لا تخترع.` }],
    output_config: { format: { type: 'json_schema', schema: GROUP_SCHEMA } } });
  AI.log(null, 'wa_group', text.slice(0, 300), '', AI.costOf(res.usage, 'fast'), AI.MODELS.fast.id);
  try { return JSON.parse(AI.textOf(res)); } catch { return { deductions: [], requests: [], issues: [] }; }
}

// كرت ينتظر «تمام» لهالرقم (لو فيه كرت قبل، ينضاف معه)
function addPending(phone, userId, actions, images = []) {
  const old = get('SELECT data FROM wa_pending WHERE phone = ?', phone);
  const prev = old ? JSON.parse(old.data) : { actions: [], images: [] };
  run("INSERT INTO wa_pending(phone, user_id, data, created_at) VALUES(?,?,?,datetime('now')) ON CONFLICT(phone) DO UPDATE SET user_id = excluded.user_id, data = excluded.data, created_at = excluded.created_at",
    phone, userId, JSON.stringify({ actions: [...prev.actions, ...actions], images: images.length ? images : prev.images }));
}

function makeWhatsApp({ runAs }) {
  const queue = new Map(); // رسالة وحدة في نفس الوقت لكل محادثة
  const recent = new Map(); // phone => { files: [data URL], at } — آخر الصور/الملفات
  const chain = (key, fn) => { const p = (queue.get(key) || Promise.resolve()).then(fn, fn); queue.set(key, p.catch(() => {})); return p; };

  // 🚨 «بلدية»: أي موظف يكتبها (القروب أو الخاص) => كل العمال يتنبهون في الخاص، والمالك يدري. مرة كل ٣٠ دقيقة
  const INSPECT = /^\s*(🚨\s*)?(ال)?(بلدي[ةه]|تفتيش|مفتش|مفتشين)(\s+(جت|جا|جاء|جو|وصل[تو]?|هنا|الحين|في المحل|دخل[تو]?))*\s*[!.؟?]*\s*$/;
  async function inspectAlert(u) {
    const last = Date.parse(getSetting('inspect_at') || '') || 0;
    if (Date.now() - last < 30 * 60e3) return false;
    setSetting('inspect_at', new Date().toISOString());
    const people = all("SELECT name, phone, role FROM users WHERE active = 1 AND bot = 0 AND phone != ''");
    for (const p of people) {
      const text = p.role === 'owner' ? `🚨 ${u.name} بلّغ: البلدية/التفتيش في المحل الحين — انرسل تنبيه لكل العمال.`
        : '🚨 *تفتيش في المحل الحين!*\nتأكدوا على طول: القفازات 🧤، غطا الراس، الكمام، نظافة المكان والأسطح، والأكل مغطى… وما أحد على جواله 🙏';
      try { await sendText(p.phone, text); } catch (e) { console.error('inspect', p.name, e.message); }
    }
    return true;
  }

  // القروب: يقرأ بس — ما يرد في القروب أبدًا
  async function handleGroup(msg, u) {
    const role = groupsOn()[msg.chat];
    if (!role || !u || msg.type !== 'text' || msg.text.length < 3) return;
    const group = msg.groupName || GROUP_LABEL[role];
    if (!log('in', msg.chat, u.id, `[${group}] ${msg.text}`, msg.id)) return; // باسم القروب (ما يدخل في محادثته الخاصة)
    if (INSPECT.test(msg.text)) return inspectAlert(u);
    const r = await classifyGroup(msg.text, u.name, group);
    const today = require('./calc').businessDate();
    // 🛠️ المشاكل: تتسجل كلها؛ اللي على عامل ومن مشرف/المالك => تذكير ثم تنبيه في الخاص، والثالثة للمالك
    if ((r.issues || []).length) await require('./wa_issues').record(r.issues, { by: u, chat: msg.chat, staff: all('SELECT id, name, phone, role FROM users WHERE active = 1 AND bot = 0'), send: sendText });
    // خصم: من المشرف أو المالك بس، والرواتب للمالك => ينرسل للمالك يأكده
    if (r.deductions.length && ['owner', 'supervisor'].includes(u.role)) {
      const owner = get("SELECT * FROM users WHERE role = 'owner' AND active = 1 AND bot = 0 AND phone != '' ORDER BY id LIMIT 1");
      const staff = all('SELECT id, name, phone FROM users WHERE active = 1 AND bot = 0');
      const cards = [];
      for (const d of r.deductions) {
        const m = AS.resolveItem(d.employee, staff); const amount = Number(d.amount);
        if (!m.item || !(amount > 0)) continue;
        const w = staff.find(x => x.id === m.item.id), note = `${d.reason || 'خصم'} (${u.name} في ${group})`;
        cards.push({ id: 'd' + Date.now() + cards.length, type: 'deduct', title: `خصم ${w.name} ${amount} ريال`, lines: [d.reason || '—', `كتبه ${u.name} في ${group}`],
          requests: [{ endpoint: '/api/payroll', body: { user_id: w.id, type: 'deduct', amount, note, date: today } }], group: msg.chat,
          notify: w.phone ? [{ phone: w.phone, text: `انخصم عليك ${amount} ريال — ${d.reason || 'خصم'} (${group})` }] : [] });
      }
      if (cards.length && owner) {
        addPending(owner.phone, owner.id, cards);
        await sendText(owner.phone, `${u.name} كتب في ${group}:\n«${msg.text}»\n\n${cards.map(cardText).join('\n\n')}\n\nرد *تمام* عشان أسجله في الرواتب وأبلغ الموظف، أو *لا*.`);
      }
    }
    // طلبات: المستعجل => زكريا على طول؛ الباقي يتجمع ويروح قائمة وحدة في أوقات محددة (wa_req_times)
    const urgent = r.requests.filter(x => x.urgent), later = r.requests.filter(x => !x.urgent);
    for (const x of later) run("INSERT INTO wa_requests(date, item, qty, by_name, chat, at) VALUES(?,?,?,?,?,datetime('now'))", today, String(x.item).trim(), String(x.qty || '').trim(), u.name, msg.chat);
    if (later.length) await sendGroupText(msg.chat, `📝 انضاف للقائمة: ${later.map(x => `${x.item}${x.qty ? ' ' + x.qty : ''}`).join('، ')} — تروح لزكريا ${nextSlotText()}`);
    if (urgent.length) {
      const list = urgent.map(x => `${x.item}${x.qty ? ' ' + x.qty : ''}`).join('، ');
      const told = await toBuyers(`🚨 مستعجل من ${group} (${u.name}): ${list}`, `🚨 ${list} — طلبها ${u.name}`, today);
      if (told.length) await sendGroupText(msg.chat, `✓ وصل المستعجل لـ${told.join(' و')}: ${list}`);
    }
  }

  // رسالة لمسؤولي المشتريات (اللي لهم جوال) + تذكير في «المطلوب منك الحين»
  async function toBuyers(text, reminder, today) {
    const told = [];
    for (const p of all("SELECT * FROM users WHERE role = 'purchaser' AND active = 1 AND bot = 0")) {
      if (p.phone) { await sendText(p.phone, text); told.push(p.name); }
      await runAs(p, '/api/reminders', { text: reminder.slice(0, 300), due_date: today });
    }
    return told;
  }
  // قائمة الطلبات المتجمعة: تنرسل في وقتها (أو force) — نفس الصنف ينجمع
  async function flushRequests({ force = false } = {}) {
    const C = require('./calc'), today = C.businessDate(), h = C.riyadhHour();
    if (!force) {
      if (!reqSlots().includes(h)) return null;
      if (get('SELECT 1 AS x FROM wa_nudges WHERE date = ? AND key = ?', today, 'req:' + h)) return null;
      run('INSERT INTO wa_nudges(date, key) VALUES(?,?)', today, 'req:' + h);
    }
    const rows = all('SELECT * FROM wa_requests WHERE sent_at IS NULL ORDER BY id');
    if (!rows.length) return null;
    const by = new Map();
    for (const x of rows) { const k = x.item.replace(/\s+/g, ' '); const e = by.get(k) || { item: k, qty: [], who: new Set() }; if (x.qty) e.qty.push(x.qty); e.who.add(x.by_name); by.set(k, e); }
    const lines = [...by.values()].map(e => `• ${e.item}${e.qty.length ? ' — ' + e.qty.join(' + ') : ''} (${[...e.who].join('، ')})`);
    const told = await toBuyers(`🛒 قائمة الطلبات (${lines.length}):\n${lines.join('\n')}`, `🛒 قائمة الطلبات: ${[...by.keys()].join('، ')}`, today);
    run("UPDATE wa_requests SET sent_at = datetime('now') WHERE id IN (" + rows.map(x => x.id).join(',') + ')');
    if (told.length) for (const chat of new Set(rows.map(x => x.chat).filter(Boolean))) await sendGroupText(chat, `✓ راحت قائمة الطلبات لـ${told.join(' و')} (${lines.length} صنف)`);
    return { items: lines.length, told };
  }

  async function handle(msg) {
    const phone = msg.phone;
    const u = phone ? get('SELECT * FROM users WHERE phone = ? AND active = 1 AND bot = 0', phone) : null;
    // 🎤 صوت => كتابة (للموظفين المسجلين بس، وفي القروبات المفعّلة بس — عشان التكلفة)
    if (msg.type === 'audio' && u && (!msg.isGroup || groupsOn()[msg.chat])) {
      if (!STT.ready()) {
        if (msg.isGroup) return;
        if (!log('in', phone, u.id, '[🎤 صوت]', msg.id)) return;
        return sendText(phone, 'الرسائل الصوتية مو مفعّلة للحين — اكتبها كتابة 🙏');
      }
      try { msg = { ...msg, type: 'text', text: await STT.transcribe(await msg.audio(), msg.mime, msg.seconds, u.id), heard: true }; }
      catch (e) { if (msg.isGroup) return; if (!log('in', phone, u.id, '[🎤 صوت]', msg.id)) return; return sendText(phone, '⚠️ ' + e.message); }
      if (!msg.text) { if (msg.isGroup) return; return sendText(phone, 'ما سمعت شي واضح — أرسلها مرة ثانية أو اكتبها'); }
    }
    if (msg.isGroup) return handleGroup(msg, u);
    const text = msg.text;
    if (!log('in', phone, u && u.id, (msg.heard ? '🎤 ' : '') + (text || (msg.type === 'image' ? '[صورة]' : `[${msg.type}]`)), msg.id)) return; // مكررة
    const heard = t => msg.heard ? `🎤 سمعت: «${text}»\n\n${t}` : t; // يتأكد إنه فهم صوته صح
    if (!u) return mode() === 'link' ? null : sendText(phone, 'رقمك مو مسجل في نظام مطعم السلام — كلم المشرف يضيف جوالك في صفحة الموظفين.'); // الرقم المربوط ما يرد على الغرباء
    if (!['text', 'image', 'pdf'].includes(msg.type)) return sendText(phone, 'أقدر أقرأ الكتابة والصور وملفات PDF بس.');
    if (msg.type === 'text' && INSPECT.test(text)) return sendText(phone, await inspectAlert(u) ? '✓ انرسل التنبيه لكل العمال' : '✓ التنبيه انرسل قبل شوي');

    // 💡 المالك يرد على اقتراح: «موافق 3» / «ارفض 3»
    const dec = msg.type === 'text' && u.role === 'owner' && /^\s*(موافق|وافق|اعتمد|نفذ|نفّذ|ارفض|رفض|لا)\s*#?\s*(\d+)\s*$/.exec(text);
    if (dec) {
      const SG = require('./suggestions');
      try {
        const r = await SG.decide(Number(dec[2]), !/رفض|لا/.test(dec[1]), u, runAs);
        const by = r.user_id && get('SELECT name, phone FROM users WHERE id = ?', r.user_id);
        const word = r.already ? `#${r.id} انحسم قبل (${r.status})` : r.status === 'rejected' ? `✗ انرفض #${r.id}` : r.status === 'done' ? `✓ اتنفذ #${r.id}` : r.status === 'failed' ? `⚠️ ما قدرت أنفذ #${r.id}: ${r.result}` : `✓ انحفظ #${r.id} للتطوير`;
        await sendText(phone, word);
        if (!r.already && by && by.phone && by.phone !== phone) try { await sendText(by.phone, r.status === 'rejected' ? `اقتراحك «${r.summary}» ما انعتمد — شكرًا على المبادرة 🌹` : `👍 نوح وافق على اقتراحك: «${r.summary}»`); } catch { /* */ }
      } catch (e) { await sendText(phone, '⚠️ ' + e.message); }
      return;
    }

    run(`DELETE FROM wa_pending WHERE created_at < datetime('now', '-${PENDING_MIN} minutes')`);
    const pend = get('SELECT * FROM wa_pending WHERE phone = ?', phone);
    if (pend && msg.type === 'text' && NO.test(text)) { run('DELETE FROM wa_pending WHERE phone = ?', phone); recent.delete(phone); return sendText(phone, heard('انلغى — ما اتسجل شي.')); }
    if (!pend && msg.type === 'text' && YES.test(text)) return sendText(phone, heard('ما فيه شي ينتظر التأكيد — وش تبغى أسجل؟'));
    if (pend && msg.type === 'text' && YES.test(text)) {
      run('DELETE FROM wa_pending WHERE phone = ?', phone);
      recent.delete(phone); // اتسجل — الصور اللي قبل خلاص
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
          for (const n of c.notify || []) try { await sendText(n.phone, n.text); } catch { /* */ }
          if (c.group) await sendGroupText(c.group, `✓ اتسجل ${c.title} — ${c.lines[0]}`);
        } catch (e) { fail.push(`${c.title}: ${e.message}`); }
      }
      return sendText(phone, heard([done.length ? `✓ اتسجل: ${done.join('، ')}` : '', fail.length ? `⚠️ ما اتسجل: ${fail.join('\n')}` : ''].filter(Boolean).join('\n')));
    }

    if (!ready()) return;
    // الصور/الملفات: تنحفظ ٢٠ دقيقة وتنرسل مع الرسائل اللي بعدها (فاتورة في أكثر من صورة، «سجلها»، «فاتورتين»…)
    const rc = recent.get(phone);
    let files = rc && Date.now() - rc.at < 20 * 60e3 ? rc.files : [];
    if (msg.type === 'image') files = [...files, await msg.image()].slice(-6);
    if (msg.type === 'pdf') files = [...files, await msg.pdf()].slice(-6);
    if (files.length) recent.set(phone, { files, at: Date.now() }); else recent.delete(phone);
    const images = files;
    const r = await AS.ask(u, (text || (msg.type === 'pdf' ? 'شوف الملف' : images.length ? 'شوف الصورة' : '')) + `${images.length > 1 ? `\n\n(معك ${images.length} صور/ملفات من آخر رسائله — الجديدة آخر وحدة)` : ''}\n\n(يكلمك من الواتساب: لو جهزت كرت قله يرد «تمام» عشان يتسجل — مو «اضغط تأكيد». خل ردك قصير.)`, history(phone).slice(0, -1), { images });
    let reply = String(r.answer || '').replace(/اضغط «?تأكيد»?/g, 'رد «تمام»');
    // 🛠️ مشكلة من الموظف في الخاص => اتسجلت، ونسخة لنوح
    if (r.report && u.role !== 'owner') for (const o of all("SELECT phone FROM users WHERE role = 'owner' AND active = 1 AND bot = 0 AND phone != ''"))
      try { await sendText(o.phone, `🛠️ ${u.name} في الخاص:\n«${r.report}»\n\n(آخر كلامه: «${text.slice(0, 200)}»)`); } catch { /* */ }
    // 💡 الاقتراحات توصل لنوح يوافق بكلمة
    if ((r.suggestions || []).length) {
      const SG = require('./suggestions');
      for (const id of r.suggestions) {
        const sg = get('SELECT * FROM suggestions WHERE id = ?', id); if (!sg) continue;
        for (const o of all("SELECT phone FROM users WHERE role = 'owner' AND active = 1 AND bot = 0 AND phone != ''")) try { await sendText(o.phone, SG.ownerText(sg, u.name)); } catch { /* */ }
      }
    }
    run('DELETE FROM wa_pending WHERE phone = ?', phone); // أي رد جديد يلغي الكرت القديم (ما يتسجل كرت تراجع عنه المساعد)
    if (r.actions && r.actions.length) {
      addPending(phone, u.id, r.actions, r.actions.some(c => c.requests.some(x => x.attach_images || x.attach_image)) ? images.filter(d => /^data:image\//.test(d)) : []);
      reply = `${reply}\n\n${r.actions.map(cardText).join('\n\n')}\n\nرد *تمام* عشان أسجله، أو *لا* للإلغاء، أو اكتب التصحيح.`;
    }
    // 🔊 الموظف اللي ما يقرأ: الرد صوت كمان (بدون تفاصيل الكرت — يكفي «قول تمام»)
    if (u.voice_reply && mode() === 'link' && STT.ready()) {
      const said = String(r.answer || '').replace(/اضغط «?تأكيد»?/g, 'قول تمام') + (r.actions && r.actions.length ? `\n${r.actions.map(c => c.title + ': ' + c.lines.join('، ')).join('\n')}\nإذا صحيح قول تمام عشان يتسجل.` : '');
      try { await LINK.sendVoice(phone, await require('./tts').speak(said, u.id)); } catch (e) { console.error('voice reply', e.message); }
    }
    return sendText(phone, heard(reply.trim() || 'ما فهمت — اكتبها بطريقة ثانية.'));
  }

  // ميتا ترسل كل التحديثات هنا: الرسائل (نشتغل عليها) وحالات الإرسال (نتجاهلها)
  function receive(raw, signature) {
    if (!validSignature(raw, signature)) { const e = new Error('توقيع غلط'); e.status = 401; throw e; }
    let body; try { body = JSON.parse(raw.toString('utf8')); } catch { const e = new Error('بيانات غير صحيحة'); e.status = 400; throw e; }
    const msgs = [];
    for (const en of body.entry || []) for (const ch of en.changes || []) for (const m of (ch.value && ch.value.messages) || []) msgs.push(m);
    // نرد ٢٠٠ على طول (ميتا تعيد الإرسال لو تأخرنا) والشغل يكمل بالخلفية
    const work = Promise.all(msgs.map(m => dispatch({ id: m.id, phone: normPhone(m.from), chat: normPhone(m.from), isGroup: false, groupName: '', type: m.type,
      text: String((m.text && m.text.body) || (m.image && m.image.caption) || '').trim(), image: () => mediaDataUrl(m.image.id),
      audio: async () => Buffer.from((await mediaDataUrl(m.audio.id, true)).split(',')[1], 'base64'), mime: m.audio && m.audio.mime_type, seconds: 0 })));
    return { ok: true, work };
  }
  // كل رسالة (من أي طريقة) تمر من هنا
  function dispatch(msg) {
    return chain(msg.chat || msg.phone, () => handle(msg).catch(async e => {
      console.error('whatsapp', e.message);
      if (msg.isGroup || !msg.phone) return; // ما نرد في القروب أبدًا
      try { await sendText(msg.phone, '⚠️ ' + (e.status && e.status < 500 ? e.message : 'صار خطأ — جرّب مرة ثانية')); } catch { /* */ }
    }));
  }
  LINK.setHandler(msg => { if (mode() === 'link') return dispatch({ ...msg, phone: normPhone(msg.phone) }); });

  function verify(q) {
    const want = getSetting('wa_verify_token');
    if (q['hub.mode'] === 'subscribe' && want && q['hub.verify_token'] === want) return String(q['hub.challenge'] || '');
    const e = new Error('غير مسموح'); e.status = 403; throw e;
  }

  return { receive, verify, sendText, sendGroupText, ready, dispatch, mode, flushRequests };
}

module.exports = { makeWhatsApp, normPhone, LINK, GROUP_LABEL };
