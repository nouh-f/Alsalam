'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, all, get, run, tx, getSetting, setSetting, UPLOAD_DIR } = require('./db');
const C = require('./calc');
const L = require('./loyverse');
const { normalize, bestMatch } = require('./match');
const { readTicketImages } = require('./ocr');
const T = require('./ticket');
const LK = require('./link');
const AS = require('./assistant');
const F = require('./forecast');
const IN = require('./insights');
const { readInvoice } = require('./invoice');
const { readSheet } = require('./sheet');
const SP = require('./spending');
const WA = require('./whatsapp');
const PRN = require('./printer');
const PR = require('./printer_read');
const PK = require('./packaging');
const CAM = require('./cameras');
const GD = require('./gdrive');
const MR = require('./monthly');
const AI = require('./ai');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');
// نسخة الواجهة: تتغيّر مع كل تحديث — المتصفح المفتوح من قبل يعيد التحميل لحاله
const VERSION = crypto.createHash('sha1').update(['app.js', 'style.css', 'index.html'].map(f => { try { return fs.readFileSync(path.join(PUBLIC, f)); } catch { return ''; } }).join('')).digest('hex').slice(0, 10);

// ===================== أدوات =====================
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = msg => { throw new HttpError(400, msg); };
const forbid = (msg = 'ما عندك صلاحية') => { throw new HttpError(403, msg); };
const num = (v, name) => { const n = Number(v); if (!Number.isFinite(n)) bad(`${name || 'الرقم'} غير صحيح`); return n; };
// الأرقام العربية/الفارسية، والفاصلة: «1,500» = 1500 و«2,5» = 2.5
const normNum = v => {
  let t = String(v ?? '').trim().replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/٫/g, '.').replace(/[٬\s]/g, '');
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, ''); else t = t.replace(/,/g, '.');
  return t;
};
// كمية/مبلغ لازم أكبر من صفر (السالب كان يخفي النقص)
const pos = (v, name = 'الكمية') => { const n = Number(normNum(v)); if (!Number.isFinite(n) || !(n > 0)) bad(`${name} لازم رقم أكبر من صفر`); return n; };
// اليوم المقفل: ما يتعدل إلا من المالك
const guardDay = (u, date) => { if (dayClosed(date) && !isOwner(u)) forbid('اليوم مقفل'); };
const optNum = v => (v === '' || v == null ? null : Number(v));
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
const dateOr = d => (isDate(d) ? d : C.businessDate());
const isSup = u => u.role === 'owner' || u.role === 'supervisor';
const isOwner = u => u.role === 'owner';
// مسؤول المشتريات: المشتريات والموردين والمستودع والأصناف (بدون المبيعات)
const isPurch = u => isSup(u) || u.role === 'purchaser';
const needSup = u => { if (!isSup(u)) forbid('هذي للمشرفين بس'); };
const needPurch = u => { if (!isPurch(u)) forbid('هذي للمشرفين ومسؤول المشتريات'); };
// صلاحيات لكل مشرف (المالك يحددها): يشوف المبيعات والتقارير؟ يشوف الوصفات؟
const canSales = u => isOwner(u) || (isSup(u) && !u.no_sales);
const canRecipes = u => isOwner(u) || (isSup(u) && !u.no_recipes);
const needSales = u => { if (!canSales(u)) forbid('ما عندك صلاحية على المبيعات والتقارير'); };
const needRecipes = u => { if (!canRecipes(u)) forbid('ما عندك صلاحية على الوصفات'); };
const needOwner = u => { if (!isOwner(u)) forbid('هذي للمالك بس'); };
const dayClosed = d => !!get('SELECT 1 AS x FROM day_status WHERE date = ?', d);
const nowISO = () => new Date().toISOString();
const approverSections = u => all('SELECT section_id FROM section_approvers WHERE user_id = ?', u.id).map(r => r.section_id);

function saveImage(dataUrl) {
  if (!dataUrl) return '';
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/s.exec(dataUrl);
  if (!m) bad('صيغة الصورة غير مدعومة');
  if (m[2].length > 16 * 1024 * 1024) bad('الصورة كبيرة — صوّرها مرة ثانية بحجم أصغر');
  const ext = m[1] === 'png' ? 'png' : m[1] === 'webp' ? 'webp' : 'jpg';
  const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(m[2], 'base64'));
  return name;
}

function recomputeRecent() {
  const today = C.businessDate();
  for (let i = 0; i < 7; i++) C.rebuildSaleUse(C.addDays(today, -i));
}

// ===================== التذاكر =====================
// التذكرة اللي مجموعها ما يطابق (أو مكررة) ما تنحسب في المبيعات لين تتراجع وتتأكد
const TICKET_HOLD = ['mismatch', 'duplicate'];
function rebuildTicketSales(ticketId) {
  const t = get('SELECT * FROM tickets WHERE id = ?', ticketId);
  tx(() => {
    run("DELETE FROM sales WHERE source = 'ticket' AND ref = ?", ticketId);
    if (!t || (t.status !== 'confirmed' && TICKET_HOLD.includes(t.check_status))) return;
    if (C.usesPrinter(t.date)) return; // من يوم الطابعة: التذكرة المصوّرة ما تدخل المبيعات
    const lines = all('SELECT l.*, p.price AS list_price FROM ticket_lines l LEFT JOIN products p ON p.id = l.product_id WHERE ticket_id = ?', ticketId);
    for (const l of lines) if (l.product_id && l.qty) {
      const price = l.price || l.list_price || 0;
      run("INSERT INTO sales(date, product_id, qty, amount, list_amount, source, note, only_items, ref) VALUES(?,?,?,?,?,'ticket',?,?,?)",
        t.date, l.product_id, l.qty, C.r2(l.amount || l.qty * price), C.r2(l.qty * (l.list_price || price)), l.note || '', l.only_items || '', ticketId);
    }
  });
  if (t) C.rebuildSaleUse(t.date);
}

const ticketTolerance = () => Number(getSetting('ticket_tolerance', '10')) || 10;
const RANK = { duplicate: 5, mismatch: 4, no_total: 3, small_diff: 2, ok: 1, '': 0 };
const CHECK_TEXT = { items_ok: 'صحيحة حسب الأصناف', ok: 'المجموع مطابق', small_diff: 'فرق بسيط', mismatch: 'المجموع ما يطابق', no_total: 'المجموع المطبوع ما انقرا', duplicate: 'التذكرة مرفوعة قبل' };

// يقرأ كل صور التذكرة، يدمج التداخل، ويطابق المجموع. إذا الفرق كبير يعيد القراءة مرة لحاله
async function readAndCheck(paths) {
  const tol = ticketTolerance();
  const evaluate = readings => {
    const { tickets, warnings } = T.stitch(readings);
    const checks = tickets.map(c => ({ ...T.checkTotal(c.lines, c.total_due, c.discount, tol), label: c.label }));
    const worst = checks.reduce((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), checks.length ? 'ok' : 'no_total');
    const off = checks.reduce((t, c) => t + Math.abs(c.diff || 0), 0);
    return { tickets, warnings, checks, worst, off };
  };
  AI.checkCap(); // سقف تكلفة الذكاء الشهري
  let cost = 0;
  const read = async (tier, feedback) => { const r = await readTicketImages(paths, { tier, feedback }); cost += r.cost || 0; return r.images; };
  // ١. القراءة الأولى بالنموذج السريع الرخيص
  let res = null;
  try { res = evaluate(await read('fast')); }
  catch (e) { if (/مفتاح/.test(e.message)) throw e; res = null; }
  // ٢. المجموع ما طابق، أو سطر حسابه غلط، أو القراءة فشلت => نعيدها بالنموذج القوي
  const badLines = res ? res.tickets.flatMap(c => c.lines).filter(l => T.lineFlag(l)) : [];
  if (!res || res.worst === 'mismatch' || badLines.length) {
    let feedback = '';
    if (res) {
      const fb = res.checks.filter(c => c.status === 'mismatch').map(c => `تذكرة «${c.label || 'بدون اسم'}»: مجموع الأسطر اللي قريتها ${c.sum} والمبلغ المستحق المطبوع ${c.total} (فرق ${c.diff}).`);
      if (badLines.length) fb.push(`أسطر العدد × السعر فيها ما يساوي المبلغ: ${badLines.map(l => l.name).join('، ')}`);
      const prev = res.tickets.map(c => c.lines.map(l => `${l.name} | ${l.qty} x ${l.unit_price} = ${l.amount}`).join('\n')).join('\n---\n');
      feedback = `تنبيه: قراءة سابقة فيها أخطاء:\n${fb.join('\n')}\nراجع كل صورة سطر سطر: فيه سطر ناقص؟ رقم انقرا غلط؟ سطر محسوب مرتين داخل نفس الصورة؟ ورجّع القراءة الصحيحة كاملة.\nالقراءة السابقة (بعد دمج الصور):\n${prev}`;
    }
    let capOk = true; try { AI.checkCap(); } catch { capOk = false; }
    if (!capOk && res) return { ...res, cost };
    const again = evaluate(await read('strong', feedback));
    again.reread = true;
    if (!res || again.off <= res.off) res = again; else res.reread = true;
  }
  res.cost = cost;
  return res;
}

async function ocrTicket(ticketId) {
  const t0 = get('SELECT * FROM tickets WHERE id = ?', ticketId);
  const imgs = all('SELECT path FROM ticket_images WHERE ticket_id = ? ORDER BY id', ticketId).map(r => path.join(UPLOAD_DIR, r.path));
  const started = Date.now();
  const LIMIT = Number(process.env.OCR_LIMIT_MS) || 12 * 60000;
  let timer;
  try {
    // ما تعلق للأبد: بعد 12 دقيقة تطلع مسودة برسالة (تقدر تعيد الرفع أو تدخل يدوي)
    const res = await Promise.race([readAndCheck(imgs), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('القراءة طوّلت مرة — أعد رفع الصور، أو أدخل الأسطر يدوي')), LIMIT); })]);
    const products = all('SELECT id, name, variant, price FROM products WHERE active = 1');
    const productById = new Map(products.map(p => [p.id, p]));
    const aliases = new Map(all('SELECT * FROM product_aliases').map(a => [a.alias, a.product_id]));
    const label = res.tickets.map(c => c.label).filter(Boolean).join(' + ');
    const paper = res.checks.every(c => c.total != null) && res.checks.length ? C.r2(res.checks.reduce((x, c) => x + c.total, 0)) : null;
    const linesTotal = C.r2(res.checks.reduce((x, c) => x + c.sum, 0));
    let status = res.worst;
    const notes = [...res.warnings];
    if (res.reread) notes.push('انعادت القراءة بالنموذج الأقوى (فرق في المجموع أو الحساب)');
    for (const c of res.checks) if (c.status !== 'ok') notes.push(`${c.label || 'التذكرة'}: ${CHECK_TEXT[c.status]}${c.diff != null ? ` — الأسطر ${c.sum} والمطبوع ${c.total} (فرق ${c.diff})` : ''}`);
    // نفس التذكرة (نفس الاسم والمبلغ) مرفوعة قبل لنفس اليوم
    if (label && paper != null && get("SELECT id FROM tickets WHERE id != ? AND date = ? AND label = ? AND ABS(COALESCE(paper_total, 0) - ?) < 0.01", ticketId, t0.date, label, paper)) {
      status = 'duplicate'; notes.unshift('نفس التذكرة مرفوعة قبل لهذا اليوم — ما انحسبت مرتين');
    }
    const rows = res.tickets.flatMap(c => c.lines).map(l => {
      const m = T.matchProduct(l, products, aliases);
      const price = Number(l.unit_price) || (Number(l.amount) && Number(l.qty) ? l.amount / l.qty : 0);
      return { l, ...m, price, flag: T.lineFlags(l, productById.get(m.product_id)) };
    });
    const flagged = rows.filter(r => r.flag).length;
    if (flagged) notes.push(`${flagged} سطر يحتاج مراجعة (السعر أو الحساب)`);
    // ما فيه مبلغ مستحق؟ نتأكد من الأصناف: الاسم بالضبط، والسعر = لويفرس، والحساب مضبوط
    if (status === 'no_total' && T.itemsVerified(rows)) {
      status = 'items_ok';
      notes.splice(0, notes.length, ...notes.filter(n => !n.includes(CHECK_TEXT.no_total)), `المجموع المفروض ${linesTotal}`);
    }
    tx(() => {
      run('DELETE FROM ticket_lines WHERE ticket_id = ?', ticketId);
      for (const r of rows)
        run('INSERT INTO ticket_lines(ticket_id, raw_name, product_id, qty, price, amount, customer, note, match, flag) VALUES(?,?,?,?,?,?,?,?,?,?)',
          ticketId, r.l.name, r.product_id, Number(r.l.qty) || 0, C.r2(r.price), Number(r.l.amount) || null, '', r.l.note || '', r.match, r.flag);
      run("UPDATE tickets SET status = 'draft', ocr_error = '', label = ?, paper_total = ?, lines_total = ?, discount = ?, check_status = ?, check_note = ?, ocr_cost = COALESCE(ocr_cost, 0) + ?, read_seconds = ? WHERE id = ?",
        label, paper, linesTotal, C.r2(res.tickets.reduce((x, c) => x + c.discount, 0)), status, notes.join('\n'), res.cost || 0, Math.round((Date.now() - started) / 1000), ticketId);
    });
  } catch (e) {
    run("UPDATE tickets SET status = 'draft', ocr_error = ?, read_seconds = ? WHERE id = ?", String(e.message || e), Math.round((Date.now() - started) / 1000), ticketId);
  } finally { clearTimeout(timer); }
  rebuildTicketSales(ticketId);
}

// بعد ما تعدّل الأسطر بيدك: نعيد مطابقة المجموع
function recheckTicket(ticketId) {
  const t = get('SELECT * FROM tickets WHERE id = ?', ticketId);
  if (!t) return;
  const rows = all('SELECT product_id, match, flag, qty, price, amount FROM ticket_lines WHERE ticket_id = ?', ticketId);
  const lines = rows.map(l => ({ qty: l.qty, unit_price: l.price, amount: l.amount }));
  const c = T.checkTotal(lines, t.paper_total, t.discount, ticketTolerance());
  const fromPhoto = !!get('SELECT 1 AS x FROM ticket_images WHERE ticket_id = ?', ticketId);
  const status = t.check_status === 'duplicate' ? 'duplicate'
    : t.paper_total != null ? c.status
    : !fromPhoto ? '' : T.itemsVerified(rows) ? 'items_ok' : 'no_total';
  const note = status === 'duplicate' ? t.check_note
    : status === 'items_ok' ? `المجموع المفروض ${c.sum}`
    : (c.diff != null && status !== 'ok' ? `${CHECK_TEXT[status]} — الأسطر ${c.sum} والمطبوع ${c.total} (فرق ${c.diff})` : '');
  run('UPDATE tickets SET lines_total = ?, check_status = ?, check_note = ? WHERE id = ?', c.sum, status, note, ticketId);
}

function ticketView(t) {
  return {
    ...t,
    images: all('SELECT id, path FROM ticket_images WHERE ticket_id = ?', t.id),
    lines: all(`SELECT l.*, p.name AS product_name, p.variant AS product_variant, p.price AS list_price
      FROM ticket_lines l LEFT JOIN products p ON p.id = l.product_id WHERE ticket_id = ? ORDER BY l.id`, t.id),
  };
}

// ===================== المخزون =====================
// سحب من المستودع للمحضّر/المعروض. الصنف المحضّر يسحب مكوناته:
// المكوّن اللي يدخل الجرد اليومي (دجاج، لحم) من المحضّر، وغيره (دقيق، زيت) من المستودع.
// mode: (فاضي) = سحب من المستودع، والمحضّر = تحضير جديد (تنخصم مكوناته)
//       pull  = سحب من الثلاجة/المستودع زي ما هو (الباقي المحفوظ — بدون مكونات)
//       store = رجّع الباقي للثلاجة (يطلع من الجرد ويدخل المستودع)
function transfer(u, { date, item_id, qty, note, mode, unit, image, moveType = 'transfer' }) {
  const item = get('SELECT * FROM items WHERE id = ?', item_id) || bad('الصنف غير موجود');
  qty = pos(qty, 'الكمية');
  // بوحدة ثانية (مثل الرز: «كيلو ني» أو «مكيال» = كذا كيلو مطبوخ) => تتحول لوحدة الصنف
  if (unit && unit !== item.unit) {
    const f = get('SELECT factor FROM item_units WHERE item_id = ? AND name = ?', item.id, String(unit)) || bad(`الوحدة «${unit}» مو معرّفة لـ ${item.name}`);
    note = [note, `${qty} ${unit}`].filter(Boolean).join(' — ');
    qty = C.r3(qty * f.factor);
  }
  const ref = 'tr:' + crypto.randomUUID();
  // انرمى (خربان، طاح، رجع من زبون…): يطلع من الجرد كهالك — ما ينحسب نقص على الموظف
  if (mode === 'waste') {
    if (qty < 0) bad('الكمية غير صحيحة');
    if (!image) bad('صوّر اللي انرمى أول');
    const img = image ? saveImage(image) : '';
    run("INSERT INTO moves(date, item_id, location, qty, type, ref, user_id, note, image) VALUES(?,?,'floor',?,'waste',?,?,?,?)", date, item.id, -qty, ref, u.id, note || 'انرمى', img);
    return { ok: true, ref };
  }
  if (mode === 'pull' || mode === 'store') {
    const s = mode === 'store' ? -1 : 1;
    const label = note || (mode === 'store' ? 'رجع للثلاجة' : 'سحب من الثلاجة');
    tx(() => {
      run("INSERT INTO moves(date, item_id, location, qty, type, ref, user_id, note) VALUES(?,?,'floor',?,'transfer',?,?,?)", date, item.id, s * qty, ref, u.id, label);
      run("INSERT INTO moves(date, item_id, location, qty, type, ref, user_id, note) VALUES(?,?,'warehouse',?,'transfer',?,?,?)", date, item.id, -s * qty, ref, u.id, label);
    });
    return { ok: true, ref };
  }
  const comps = all('SELECT * FROM item_components WHERE item_id = ?', item.id);
  tx(() => {
    run("INSERT INTO moves(date, item_id, location, qty, type, ref, user_id, note) VALUES(?,?,'floor',?,?,?,?,?)", date, item.id, qty, moveType, ref, u.id, note || '');
    if (item.kind === 'prepared' && comps.length) {
      for (const c of comps) {
        const comp = get('SELECT daily FROM items WHERE id = ?', c.component_id);
        run("INSERT INTO moves(date, item_id, location, qty, type, ref, user_id, note) VALUES(?,?,?,?,'prep_use',?,?,?)",
          date, c.component_id, comp && comp.daily ? 'floor' : 'warehouse', -C.r3(c.qty * qty), ref, u.id, `تحضير ${item.name}`);
      }
    } else {
      run("INSERT INTO moves(date, item_id, location, qty, type, ref, user_id, note) VALUES(?,?,'warehouse',?,'transfer',?,?,?)", date, item.id, -qty, ref, u.id, note || '');
    }
  });
  return { ok: true, ref };
}

// أصناف «يسحبون من الثلاجة أول اليوم» (الدجاج): العامل يطلّع من الثلاجة ويدخله في جرد أول اليوم،
// فالزيادة عن آخر أمس = اللي انسحب من المستودع، وتنخصم منه لحالها.
// المطبوخ اللي له وصفة (المطفي، الإيدام…): جرد أول اليوم = انطبخ، وتنخصم مكوناته (المطفي 0.25 ديراك للحبة):
//   ينرمى باقيه بالليل => كل اللي قدامه انطبخ اليوم | الثلاجة => قدامه − اللي نزل من الثلاجة | غيره => قدامه − آخر أمس
// لازم ينادى بعد syncFridge لنفس اليوم
// اليوم اللي بعده (إذا مو مقفل): الثلاجة وتحضير أول اليوم يعتمدون على اليوم
function resyncNext(date, itemId) {
  const next = C.addDays(date, 1);
  if (dayClosed(next)) return;
  syncFridge(next, itemId); syncOpeningPull(next, itemId);
}
function syncOpeningPull(date, itemId) {
  const item = get('SELECT pull_on_open, kind, leftover FROM items WHERE id = ?', itemId);
  const ref = `op:${date}:${itemId}`;
  run('DELETE FROM moves WHERE ref = ?', ref);
  if (!item || !item.pull_on_open) return;
  const today = get('SELECT opening FROM counts WHERE date = ? AND item_id = ?', date, itemId);
  if (!today || today.opening == null) return;
  const prev = get('SELECT closing FROM counts WHERE date = ? AND item_id = ?', C.addDays(date, -1), itemId);
  // المحضّر (الفت الناشف مثلاً): اللي تجهّز أول اليوم تنخصم مكوناته. الخام (الدجاج): ينخصم هو من المستودع
  const comps = item.kind === 'prepared' ? all('SELECT c.component_id, c.qty, i.daily FROM item_components c JOIN items i ON i.id = c.component_id WHERE c.item_id = ?', itemId) : [];
  const fridge = ['fridge', 'fridge_added'].includes(item.leftover);
  if (fridge && !comps.length) return; // الخام اللي في الثلاجة: «نزل من الثلاجة» (syncFridge) هو السحب — ما ينخصم مرتين
  let pulled;
  if (comps.length && item.leftover === 'waste') pulled = today.opening;
  else if (comps.length && ['fridge', 'fridge_added'].includes(item.leftover)) pulled = today.opening + (get('SELECT SUM(qty) AS q FROM moves WHERE ref = ?', `fr:out:${date}:${itemId}`).q || 0);
  else if (!prev || prev.closing == null) return; // ما نعرف آخر أمس: ما نخمّن
  else pulled = today.opening - prev.closing;
  pulled = C.r3(pulled);
  if (pulled <= 0) return;
  if (comps.length) {
    for (const c of comps) run("INSERT INTO moves(date, item_id, location, qty, type, ref, note) VALUES(?,?,?,?,'prep_use',?,?)",
      date, c.component_id, c.daily ? 'floor' : 'warehouse', -C.r3(c.qty * pulled), ref, `تحضير أول اليوم ${C.r3(pulled)}`);
  } else run("INSERT INTO moves(date, item_id, location, qty, type, ref, note) VALUES(?,?,'warehouse',?,'opening_pull',?,'سحب من الثلاجة أول اليوم')", date, itemId, -pulled, ref);
}

// الثلاجة فوق (البرم، الحنيذ، المطفي…): العامل يكتب الأرقام بس، والنظام يطلّع وينزّل لحاله
// آخر الدوام: الباقي يطلع فوق (المطفي: اللي انضاف اليوم بس، وطبخة الصبح ينرمى باقيها)
// أول الدوام: اللي قدامه نزل من فوق (بحد اللي فوق) — والزيادة «من فين؟»
// الحركتين على المستودع بس: الجرد نفسه (أول/آخر اليوم) هو اللي يعرف المحل
function syncFridge(date, itemId) {
  const it = get('SELECT id, leftover, no_opening, old_item_id FROM items WHERE id = ?', itemId);
  const refIn = `fr:in:${date}:${itemId}`, refOut = `fr:out:${date}:${itemId}`;
  run('DELETE FROM moves WHERE ref IN (?, ?)', refIn, refOut);
  // 🍖 اللحم: الباقي آخر اليوم من طبخ اليوم (من المقسم) يطلع «القديم» — واللي نزل من القديم وما انباع هالك
  if (it && it.leftover === 'old' && it.old_item_id) {
    const cl = (get('SELECT closing FROM counts WHERE date = ? AND item_id = ?', date, itemId) || {}).closing;
    const up = C.r3(Math.min(cl || 0, C.cookedToday(date, itemId)));
    if (up > 0) run("INSERT INTO moves(date, item_id, location, qty, type, ref, note) VALUES(?,?,'warehouse',?,'fridge_in',?,'الباقي طلع القديم آخر اليوم')", date, it.old_item_id, up, refIn);
    return;
  }
  if (!it || !['fridge', 'fridge_added'].includes(it.leftover)) return;
  const c = get('SELECT opening, closing FROM counts WHERE date = ? AND item_id = ?', date, itemId) || {};
  if (c.opening != null && c.opening > 0 && !it.no_opening) {
    const up = (get("SELECT SUM(qty) AS q FROM moves WHERE item_id = ? AND location = 'warehouse' AND (date < ? OR (date = ? AND type != 'fridge_in' AND COALESCE(ref, '') != ?))", itemId, date, date, `op:${date}:${itemId}`).q) || 0;
    const down = C.r3(Math.min(c.opening, Math.max(0, up)));
    if (down > 0) run("INSERT INTO moves(date, item_id, location, qty, type, ref, note) VALUES(?,?,'warehouse',?,'fridge_out',?,'نزل من الثلاجة أول اليوم')", date, itemId, -down, refOut);
  }
  if (c.closing != null && c.closing > 0) {
    let up = c.closing;
    if (it.leftover === 'fridge_added') {
      // اللي انضاف وسط اليوم يطلع الثلاجة. صنف «بالإضافة بس»: أول طبخة باليوم = طبخة الصبح (ينرمى باقيها)
      const adds = all("SELECT qty FROM moves WHERE date = ? AND item_id = ? AND location = 'floor' AND type IN ('add', 'convert', 'split') AND qty > 0 ORDER BY id", date, itemId).map(m => m.qty);
      const later = (it.no_opening ? adds.slice(1) : adds).reduce((t, q) => t + q, 0);
      up = Math.min(c.closing, later);
    }
    if (up > 0) run("INSERT INTO moves(date, item_id, location, qty, type, ref, note) VALUES(?,?,'warehouse',?,'fridge_in',?,'طلع الثلاجة آخر اليوم')", date, itemId, C.r3(up), refIn);
  }
}

// «كامل، مقطّع×1.25» / «ني، مستوي (يترمى)» => [{name, factor, drop}]
function parseParts(v) {
  if (Array.isArray(v)) return v.filter(x => x && String(x.name || '').trim()).slice(0, 4).map(x => ({ name: String(x.name).trim().slice(0, 20), factor: Number(x.factor) > 0 ? Number(x.factor) : 1, drop: !!x.drop }));
  return String(v || '').split(/[,،]/).map(t => t.trim()).filter(Boolean).slice(0, 4).map(t => {
    const drop = /يترمى|ينرمى|رمي|-\s*$/.test(t);
    const f = /[×x*]\s*([0-9.]+)/.exec(t);
    const name = t.replace(/\(?\s*(يترمى|ينرمى|رمي)\s*\)?/g, '').replace(/[×x*]\s*[0-9.]+/, '').replace(/-\s*$/, '').trim().slice(0, 20);
    return { name, factor: f && Number(f[1]) > 0 ? Number(f[1]) : 1, drop };
  }).filter(x => x.name);
}

// تقسيم: الذبيحة ← سهوم وبرم وحنيذ… | السهوم ← برم وحنيذ. المصدر ينقص والنواتج تدخل المحل، والتكلفة تتوزع
function splitItem(u, { date, item_id, qty, outputs, note }) {
  const src = get('SELECT * FROM items WHERE id = ?', Number(item_id)) || bad('اختر اللي تقسمه');
  qty = num(qty, 'العدد'); if (!(qty > 0)) bad('كم تقسم؟');
  const outs = (outputs || []).filter(o => String(o.qty ?? '').trim() !== '').map(o => ({ id: Number(o.item_id), qty: pos(o.qty, 'كمية الناتج') })).filter(o => o.id && o.id !== src.id);
  if (!outs.length) bad('اكتب وش طلع منها');
  const items = new Map(all('SELECT * FROM items WHERE active = 1').map(i => [i.id, i]));
  for (const o of outs) if (!items.has(o.id)) bad('صنف غير موجود');
  const ref = 'sp:' + crypto.randomUUID();
  const srcCost = C.itemCostMap().get(src.id) || 0;
  const shares = new Map(all('SELECT out_item_id, share FROM item_splits WHERE item_id = ?', src.id).map(r => [r.out_item_id, r.share || 1]));
  for (const o of outs) { const kg = items.get(o.id).portion_kg; if (kg > 0) shares.set(o.id, kg); } // وزن النفر = نصيبه من التكلفة
  const weight = outs.reduce((t, o) => t + o.qty * (shares.get(o.id) || 1), 0);
  tx(() => {
    run("INSERT INTO moves(date, item_id, location, qty, type, ref, user_id, note) VALUES(?,?,?,?,'split',?,?,?)", date, src.id, src.daily ? 'floor' : 'warehouse', -qty, ref, u.id, `تقسيم ${note || ''}`.trim());
    let sort = 0;
    for (const o of outs) {
      const oi = items.get(o.id); // «المقسم»: البرم والحنيذ والمغش والسهوم فوق — ينزل منه اللي ينطبخ («طبخت حنيذ ٥»)
      run("INSERT INTO moves(date, item_id, location, qty, type, ref, user_id, note) VALUES(?,?,?,?,'split',?,?,?)", date, o.id, !oi.daily || oi.buy_store || ['fridge', 'fridge_added', 'old'].includes(oi.leftover) ? 'warehouse' : 'floor', C.r3(o.qty), ref, u.id, `من ${src.name}`);
      if (srcCost > 0 && weight > 0) { // نصيب الناتج من تكلفة الذبيحة
        const unit = (srcCost * qty * (shares.get(o.id) || 1)) / weight;
        const old = items.get(o.id).cost || 0;
        run('UPDATE items SET cost = ? WHERE id = ?', C.r3(old > 0 ? (old + unit) / 2 : unit), o.id);
      }
      run('INSERT INTO item_splits(item_id, out_item_id, sort) VALUES(?,?,?) ON CONFLICT DO UPDATE SET sort = excluded.sort', src.id, o.id, sort++);
    }
  });
  return { ok: true, ref };
}

// مين يقسم الذبيحة: المشرف، أو المسؤول عن اللحم (فاتح/مقفل/محضّر لصنف من نواتج التقسيم) — عبدالله دعبوش
function canSplit(u) {
  if (isSup(u)) return true;
  return !!get(`SELECT 1 AS x FROM item_splits sp JOIN items i ON i.id = sp.out_item_id LEFT JOIN sections s ON s.id = i.section_id
    WHERE i.active = 1 AND (i.opening_user_id = ? OR i.closing_user_id = ? OR i.prep_user_id = ? OR s.opening_user_id = ? OR s.closing_user_id = ?) LIMIT 1`, u.id, u.id, u.id, u.id, u.id);
}

// مين يقدر يسجل حركة على صنف: الفاتح، المقفل، المحضّر، مستلم القسم، أو المشرف
function canTouch(u, item) {
  if (isSup(u)) return true;
  const sec = item.section_id ? get('SELECT * FROM sections WHERE id = ?', item.section_id) : null;
  const ids = [item.opening_user_id, item.closing_user_id, item.prep_user_id, sec && sec.opening_user_id, sec && sec.closing_user_id];
  return ids.includes(u.id) || (sec && approverSections(u).includes(sec.id));
}

// تحويل بين أصناف المحضّر (صهوم ما انباع => برم/حنيذ)
function convert(u, { date, from_item_id, to_item_id, qty_from, qty_to, note }) {
  const a = get('SELECT * FROM items WHERE id = ?', from_item_id) || bad('الصنف الأول غير موجود');
  const b = get('SELECT * FROM items WHERE id = ?', to_item_id) || bad('الصنف الثاني غير موجود');
  qty_from = pos(qty_from, 'الكمية'); qty_to = pos(qty_to ?? qty_from, 'الكمية');
  const ref = 'cv:' + crypto.randomUUID();
  tx(() => {
    run("INSERT INTO moves(date, item_id, location, qty, type, ref, user_id, note) VALUES(?,?,?,?,'convert',?,?,?)", date, a.id, a.daily ? 'floor' : 'warehouse', -qty_from, ref, u.id, `إلى ${b.name} ${note || ''}`.trim());
    run("INSERT INTO moves(date, item_id, location, qty, type, ref, user_id, note) VALUES(?,?,'floor',?,'convert',?,?,?)", date, b.id, qty_to, ref, u.id, `من ${a.name} ${note || ''}`.trim());
  });
  return { ok: true };
}

function supplierId(b) {
  if (b.supplier_id) return (get('SELECT id FROM suppliers WHERE id = ?', Number(b.supplier_id)) || bad('المورد غير موجود')).id;
  const name = String(b.supplier || '').trim();
  if (!name) return null;
  const ex = get('SELECT id FROM suppliers WHERE name = ?', name);
  return ex ? ex.id : Number(run('INSERT INTO suppliers(name) VALUES(?)', name).lastInsertRowid);
}
const PAYMENTS = ['cash', 'paid', 'credit', 'custody', 'card'];

// الصنف اللي ينجرد يوميًا (سمك، مشروبات، لحوح…) لما ينشرى يدخل عهدة المسؤول عنه على طول — والمبيعات تنخصم منه
// إلا اللي «ينسحب من الثلاجة أول اليوم» (الدجاج) أو «يطلع الثلاجة فوق» (البرم): هذول ينشرون للمستودع/الثلاجة
const toFloorDefault = item => !!item.daily && !item.pull_on_open && item.leftover !== 'fridge' && !item.buy_store;

// existing = تعديل شراء موجود: نفس الحساب، ونرجع نكتب أسطره وحركاته
function savePurchase(u, b, existing) {
  const date = dateOr(b.date); guardDay(u, date);
  const payment = PAYMENTS.includes(b.payment) ? b.payment : (b.paid_from_cash ? 'cash' : 'paid');
  // كل سطر: الكمية بوحدة الشراء (3 كرتون) + سعرها (40) أو مبلغ السطر (120) => يتحول للوحدة الأساسية (72 علبة بـ 1.667)
  // 🆕 صنف جديد من الفاتورة (المساعد): ينضاف صنف مستودع — أو يستخدم الموجود بنفس الاسم
  for (const l of b.lines || []) if (!l.item_id && l.new_item && String(l.new_item.name || '').trim()) {
    const name = String(l.new_item.name).trim().slice(0, 80);
    const ex = get("SELECT id FROM items WHERE active = 1 AND name = ?", name);
    if (ex) l.item_id = ex.id;
    else {
      const wh = get("SELECT id FROM sections WHERE name LIKE 'المستودع%' ORDER BY id LIMIT 1");
      const sort = (get('SELECT MAX(sort) AS m FROM items').m || 0) + 1;
      l.item_id = Number(run("INSERT INTO items(name, unit, section_id, kind, daily, carry_over, note, sort) VALUES(?,?,?,'raw',0,1,?,?)", name, String(l.new_item.unit || 'حبة').trim().slice(0, 20) || 'حبة', wh ? wh.id : null, 'انضاف من فاتورة', sort).lastInsertRowid);
    }
  }
  const lines = (b.lines || []).filter(l => l.item_id && String(l.qty ?? '').trim() !== '' && Number(normNum(l.qty)) !== 0).map(l => {
    const item = get('SELECT id, name, unit, kind, daily, carry_over, no_opening, pull_on_open, leftover, buy_store FROM items WHERE id = ?', Number(l.item_id)) || bad('الصنف غير موجود');
    if (onlyPurch(u) && item.kind !== 'raw') bad(`«${item.name}» صنف محضّر، مو من المشتريات`);
    const unitName = String(l.unit || '').trim();
    let factor = 1;
    if (unitName && unitName !== item.unit) {
      const u = get('SELECT factor FROM item_units WHERE item_id = ? AND name = ?', item.id, unitName);
      if (u) factor = u.factor;
      else if (Number(l.factor) > 0) factor = Number(l.factor);
      else bad(`كم ${item.unit} في ${unitName} (${item.name})؟`);
    }
    const puQty = pos(l.qty, `كمية ${item.name}`);
    const puPrice = Number(l.unit_price) > 0 ? Number(l.unit_price) : (Number(l.line_total) > 0 ? Number(l.line_total) / puQty : 0);
    return { item, unitName: factor === 1 && !unitName ? '' : unitName, factor, newUnit: unitName && unitName !== item.unit && Number(l.factor) > 0,
      puQty, puPrice, qty: C.r3(puQty * factor), price: factor ? puPrice / factor : 0, to_floor: l.to_floor ?? toFloorDefault(item) };
  });
  const image = b.image ? saveImage(b.image) : (existing ? existing.image : '');
  const total = C.r2(b.total != null && b.total !== '' && !lines.length ? Number(normNum(b.total)) : lines.reduce((s, l) => s + l.puQty * l.puPrice, 0));
  if (!Number.isFinite(total) || total < 0) bad('المبلغ غير صحيح');
  if (!lines.length && !image && !b.note) bad('حط أصناف أو صورة أو كتابة');
  if (payment === 'credit' && !b.supplier_id && !String(b.supplier || '').trim()) bad('الشراء الآجل لازم له مورد');
  if (payment === 'credit' && !total && !b.awaiting_invoice) bad('الشراء الآجل لازم له مبلغ');
  if (payment === 'custody' && !total) bad('اكتب السعر — عشان ينخصم من العهدة');
  return tx(() => {
    const sid = supplierId(b);
    const sname = sid ? get('SELECT name FROM suppliers WHERE id = ?', sid).name : '';
    let id;
    if (existing) {
      id = existing.id;
      run('DELETE FROM moves WHERE ref = ?', 'pu:' + id);
      run('DELETE FROM purchase_lines WHERE purchase_id = ?', id);
      run('UPDATE purchases SET date = ?, supplier = ?, supplier_id = ?, note = ?, image = ?, total = ?, paid_from_cash = ?, payment = ? WHERE id = ?',
        date, sname, sid, b.note || '', image, total, payment === 'cash' ? 1 : 0, payment, id);
    } else id = Number(run('INSERT INTO purchases(date, user_id, supplier, supplier_id, note, image, total, paid_from_cash, payment) VALUES(?,?,?,?,?,?,?,?,?)',
      date, u.id, sname, sid, b.note || '', image, total, payment === 'cash' ? 1 : 0, payment).lastInsertRowid);
    const bal = C.warehouseBalances();
    for (const l of lines) {
      const qty = l.qty, price = l.price;
      l.item_id = l.item.id;
      // أول مرة يشتري بوحدة جديدة: تنحفظ للصنف
      if (l.newUnit && !get('SELECT 1 AS x FROM item_units WHERE item_id = ? AND name = ?', l.item_id, l.unitName)) run('INSERT INTO item_units(item_id, name, factor) VALUES(?,?,?)', l.item_id, l.unitName, l.factor);
      run('INSERT INTO purchase_lines(purchase_id, item_id, qty, unit_price, to_floor, pu_name, pu_qty, pu_price) VALUES(?,?,?,?,?,?,?,?)',
        id, l.item_id, qty, C.r3(price), l.to_floor ? 1 : 0, l.unitName, l.puQty, l.puPrice);
      run("INSERT INTO moves(date, item_id, location, qty, type, ref, user_id, note) VALUES(?,?,?,?,'purchase',?,?,?)",
        date, l.item_id, l.to_floor ? 'floor' : 'warehouse', qty, 'pu:' + id, existing ? existing.user_id : u.id, sname);
      if (price > 0) { // متوسط سعر الشراء
        const it = get('SELECT cost FROM items WHERE id = ?', l.item_id);
        const have = Math.max(0, bal.get(Number(l.item_id)) || 0);
        const newCost = have > 0 && it.cost > 0 ? (have * it.cost + qty * price) / (have + qty) : price;
        run('UPDATE items SET cost = ? WHERE id = ?', C.r3(newCost), l.item_id);
      }
    }
    if (b.awaiting_invoice !== undefined) run('UPDATE purchases SET awaiting_invoice = ? WHERE id = ?', b.awaiting_invoice ? 1 : 0, id);
    return { id };
  });
}

// 🔁 المشتريات الثابتة كل يوم (لحوح أم محمد والصفا، حبش، الكدر والكبان): تنسجل لحالها باسم المشتري
// { supplier, payment, lines: [{item_id, qty, unit_price}], fri?: [...] (الجمعة), off? } — والمشتري يعدّل اليوم لو اختلف
const fixedList = () => { try { return JSON.parse(getSetting('fixed_purchases', '[]')) || []; } catch { return []; } };
function addFixedPurchases(date = C.businessDate()) {
  const list = fixedList(), by = get('SELECT * FROM users WHERE id = ? AND active = 1', Number(getSetting('fixed_purchases_user', '0')));
  if (!list.length || !by || getSetting('fixed_purchases_done', '') >= date) return [];
  const fri = new Date(date + 'T12:00:00Z').getUTCDay() === 5, out = [];
  for (const f of list) {
    const lines = ((fri && f.fri && f.fri.length) ? f.fri : f.lines || []).filter(l => get('SELECT 1 AS x FROM items WHERE id = ? AND active = 1', Number(l.item_id)));
    if (f.off || !lines.length) continue;
    // انسجل قبل باليد؟ (نفس المورد، أو بدون مورد بنفس الأصناف)
    const ids = lines.map(l => Number(l.item_id));
    if (get(`SELECT 1 AS x FROM purchases p WHERE p.date = ? AND (p.supplier = ? OR (p.supplier = '' AND EXISTS (SELECT 1 FROM purchase_lines pl WHERE pl.purchase_id = p.id AND pl.item_id IN (${ids.map(() => '?').join(',')}))))`, date, f.supplier, ...ids)) continue;
    try { out.push({ supplier: f.supplier, ...savePurchase(by, { date, supplier: f.supplier, payment: f.payment || 'credit', note: 'ثابت يومي', lines: lines.map(l => ({ item_id: l.item_id, qty: l.qty, unit_price: l.unit_price })) }) }); }
    catch (e) { console.error('fixed purchase', f.supplier, e.message); }
  }
  setSetting('fixed_purchases_done', date);
  return out;
}
// أول مرة: قائمة زكريا (١٤ أكتوبر) — الجمعة أم محمد والصفا بـ١٥٠ (٣٠٠ حبة)
if (getSetting('fixed_purchases', '') === '') {
  const id = n => (get('SELECT id FROM items WHERE active = 1 AND name = ?', n) || {}).id;
  const z = get("SELECT id FROM users WHERE active = 1 AND name = 'زكريا'");
  const L = (n, qty, unit_price) => ({ item_id: id(n), qty, unit_price });
  const seed = [
    { supplier: 'ام محمد', payment: 'credit', lines: [L('لحوح', 200, 0.5)], fri: [L('لحوح', 300, 0.5)] },
    { supplier: 'لحوح الصفا', payment: 'credit', lines: [L('لحوح', 200, 0.5)], fri: [L('لحوح', 300, 0.5)] },
    { supplier: 'حبش', payment: 'credit', lines: [L('لحوح حبشي', 20, 1.25)] },
    { supplier: 'كدر وكبان', payment: 'custody', lines: [L('كدر', 50, 1), L('كبان', 30, 2)] },
  ];
  if (z && seed.every(f => f.lines.every(l => l.item_id))) { setSetting('fixed_purchases', JSON.stringify(seed)); setSetting('fixed_purchases_user', String(z.id)); }
  else setSetting('fixed_purchases', '[]');
}

// ===================== الرواتب =====================
function accrueSalaries() {
  const month = C.businessDate().slice(0, 7);
  for (const u of all('SELECT id, salary FROM users WHERE active = 1 AND salary > 0')) {
    if (!get("SELECT 1 AS x FROM payroll WHERE user_id = ? AND type = 'salary' AND month = ?", u.id, month))
      run("INSERT INTO payroll(user_id, date, type, amount, note, month) VALUES(?,?,'salary',?,'راتب الشهر',?)", u.id, month + '-01', u.salary, month);
  }
}
const SIGN = { salary: 1, bonus: 1, advance: -1, settle: -1, deduct: -1 };
function payrollView() {
  accrueSalaries();
  return all('SELECT id, name, role, salary, active FROM users WHERE bot = 0 ORDER BY active DESC, id').map(u => {
    const entries = all('SELECT * FROM payroll WHERE user_id = ? ORDER BY date DESC, id DESC', u.id);
    const balance = C.r2(entries.reduce((s, e) => s + (SIGN[e.type] || 0) * e.amount, 0));
    const month = C.businessDate().slice(0, 7);
    const advMonth = C.r2(entries.filter(e => e.type === 'advance' && e.date.startsWith(month)).reduce((s, e) => s + e.amount, 0));
    return { ...u, balance, advances_this_month: advMonth, entries: entries.slice(0, 60) };
  });
}

// ===================== المسارات =====================
const routes = [];
const R = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, ...opts });

// ---- الدخول (ما ينتهي إلا إذا ضغطت خروج) ----
R('GET', '/api/login-users', () => all("SELECT id, name, role FROM users WHERE active = 1 AND bot = 0 ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'supervisor' THEN 1 ELSE 2 END, id"), { public: true });
const LOGIN_TRIES = 5;
R('POST', '/api/login', ({ body, res }) => {
  const u = get('SELECT * FROM users WHERE id = ? AND active = 1 AND bot = 0', Number(body.user_id));
  const lf = u && get('SELECT * FROM login_fails WHERE user_id = ?', u.id);
  if (lf && lf.locked_until && lf.locked_until > nowISO()) throw new HttpError(429, `غلطت بالرقم السري كثير — جرّب بعد ${Math.ceil((Date.parse(lf.locked_until) - Date.now()) / 60000)} دقيقة`);
  if (!u || String(u.pin) !== String(body.pin || '').trim()) {
    if (!u) throw new HttpError(401, 'الرقم السري غلط');
    let fails = ((lf && lf.fails) || 0) + 1, locks = (lf && lf.locks) || 0, until = null;
    if (fails >= LOGIN_TRIES) { locks++; fails = 0; until = new Date(Date.now() + Math.min(15 * 2 ** (locks - 1), 1440) * 60000).toISOString(); }
    run('INSERT INTO login_fails(user_id, fails, locks, locked_until, last_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET fails = excluded.fails, locks = excluded.locks, locked_until = COALESCE(excluded.locked_until, locked_until), last_at = excluded.last_at',
      u.id, fails, locks, until, nowISO());
    if (until) throw new HttpError(429, `غلطت بالرقم السري ${LOGIN_TRIES} مرات — الحساب مقفل ${Math.round((Date.parse(until) - Date.now()) / 60000)} دقيقة`);
    throw new HttpError(401, `الرقم السري غلط — باقي لك ${LOGIN_TRIES - fails} ${LOGIN_TRIES - fails === 1 ? 'محاولة' : 'محاولات'}`);
  }
  run('DELETE FROM login_fails WHERE user_id = ?', u.id);
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions(token, user_id) VALUES(?,?)', token, u.id);
  res.setHeader('Set-Cookie', `t=${token}; Path=/; Max-Age=315360000; HttpOnly; SameSite=Lax`);
  return { token, user: { id: u.id, name: u.name, role: u.role } };
}, { public: true });
R('POST', '/api/logout', ({ token, res }) => { run('DELETE FROM sessions WHERE token = ?', token); res.setHeader('Set-Cookie', 't=; Path=/; Max-Age=0'); return { ok: true }; });
R('GET', '/api/me', ({ u }) => ({
  id: u.id, name: u.name, role: u.role, today: C.businessDate(),
  approver_sections: approverSections(u),
  can_sales: canSales(u), can_recipes: canRecipes(u),
  has_ai: !!(getSetting('anthropic_key') || process.env.ANTHROPIC_API_KEY),
  has_loyverse: !!getSetting('loyverse_token'),
  can_split: canSplit(u),
  voice_reply: !!(get('SELECT voice_reply FROM users WHERE id = ?', u.id) || {}).voice_reply,
  version: VERSION,
}));
R('POST', '/api/me/pin', ({ u, body, token }) => {
  if (!/^\d{4,8}$/.test(String(body.pin || ''))) bad('الرقم السري ٤ إلى ٨ أرقام');
  run('UPDATE users SET pin = ? WHERE id = ?', String(body.pin), u.id);
  run('DELETE FROM sessions WHERE user_id = ? AND token != ?', u.id, token || ''); // الأجهزة الثانية تطلع
  return { ok: true };
});

// ---- الرئيسية ----
// «المطلوب منك الحين»: قائمة بسيطة لكل شخص — كل سطر جملة واضحة وزر يوديه للمكان بالضبط
// level: red = لازم الحين | amber = لا تنساه | green = تمام | info = للعلم
function todoFor(u, date, board) {
  const out = [];
  const add = (level, title, detail, href, btn) => out.push({ level, title, detail: detail || '', href: href || '', btn: btn || '' });
  const names = rs => rs.slice(0, 6).map(r => r.name).join('، ') + (rs.length > 6 ? '…' : '');
  const today = date === C.businessDate();
  const closed = dayClosed(date);
  // ---- جردي ----
  if (!closed && !onlyPurch(u)) {
    const openMiss = board.rows.filter(r => r.opening_user_id === u.id && r.opening == null);
    const closeMiss = board.rows.filter(r => r.closing_user_id === u.id && r.closing == null);
    const mineOpen = board.rows.filter(r => r.opening_user_id === u.id).length;
    const h = C.riyadhHour();
    const late = today && (h >= Number(getSetting('opening_deadline_hour', '12')) || h < Number(getSetting('day_start_hour', '4')));
    if (openMiss.length) add(late || !today ? 'red' : 'amber', `جرد أول الدوام: باقي عليك ${openMiss.length} صنف`, `اكتب كم موجود من: ${names(openMiss)}`, '#/count?p=opening', 'ابدأ جرد أول الدوام');
    else if (mineOpen) add('green', 'جرد أول الدوام خلص ✓', '', '', '');
    if (closeMiss.length) add(openMiss.length ? 'info' : 'amber', `جرد آخر الدوام: ${closeMiss.length} صنف`, `قبل ما تطلع اكتب الباقي من: ${names(closeMiss)}`, '#/count?p=closing', 'جرد آخر الدوام');
    else if (board.rows.some(r => r.closing_user_id === u.id)) add('green', 'جرد آخر الدوام خلص ✓', '', '', '');
    const noPhoto = board.rows.filter(r => r.closing_user_id === u.id && r.need_photo && r.closing > 0 && !r.closing_image);
    if (noPhoto.length) add('amber', `صوّر الباقي: ${noPhoto.length} صنف`, names(noPhoto), '#/count?p=closing', 'صوّر');
    const myGap = board.rows.filter(r => r.opening_user_id === u.id && r.fridge_gap > 0);
    if (myGap.length) add('amber', 'كتبت أكثر من اللي كان في الثلاجة', myGap.map(r => `${r.name}: زيادة ${r.fridge_gap} — من فين؟ (إذا طبخت جديد اضغط «+ أضفت»)`).join('، '), '#/count?p=opening', 'الجرد');
    if (canSplit(u)) {
      const car = get("SELECT id FROM items WHERE name = 'ذبيحة' AND active = 1");
      const n = car ? C.r3(C.warehouseBalances().get(car.id) || 0) : 0;
      if (n > 0) add('amber', `فيه ${n} ذبيحة ما انقسمت`, 'قسّمها واكتب كم طلع سهوم وبرم وحنيذ… — يدخل الجرد على طول', '#/transfer', 'قسّم');
    }
    const prepMine = board.rows.filter(r => r.prep_user_id === u.id);
    if (prepMine.length) add('info', 'طبخت أو أضفت شي؟', `اضغط «+ أضفت» على الصنف: ${names(prepMine)}`, '#/count', 'سجّل الإضافة');
  }
  // ---- الاستلام (المشرف ومستلم القسم) ----
  if (!closed && !onlyPurch(u)) {
    const mySecs = isSup(u) ? null : new Set(approverSections(u));
    const behind = [];
    for (const sc of board.sections) {
      if (mySecs && !mySecs.has(sc.id)) continue;
      for (const [ph, label] of [['opening', 'أول الدوام'], ['closing', 'آخر الدوام']]) {
        if (sc[ph + '_approved']) continue;
        const done = sc[ph + '_done'];
        if (done === sc.items) add('red', `استلم ${label}: ${sc.name}`, 'الجرد خلص — راجعه واضغط «استلام»', `#/count?s=${sc.id}&p=${ph}`, 'راجع واستلم');
        else if (ph === 'opening' || sc.opening_done === sc.items)
          behind.push(`${sc.name} ${sc.items - done} (${ph === 'opening' ? sc.opening_user : sc.closing_user})`);
      }
    }
    // الأقسام اللي ما خلصت: سطر واحد بس (عشان ما تزحم الشاشة)
    if (behind.length) add('info', `${behind.length} قسم ما خلص جرده — تابعهم`, behind.join('، '), mySecs ? '#/count' : '#/count?s=all', 'شوف الجرد');
  }
  // ---- المبيعات والكاش ----
  if (canSales(u)) {
    const held = get("SELECT COUNT(*) AS n FROM tickets WHERE date = ? AND status != 'confirmed' AND check_status IN ('mismatch', 'duplicate')", date).n;
    const draft = get("SELECT COUNT(*) AS n FROM tickets WHERE date = ? AND status = 'draft'", date).n;
    if (held) add('red', `تذكرة الكاشير فيها مشكلة (${held})`, 'المجموع ما طابق أو مرفوعة مرتين — افتحها وصحح', '#/tickets', 'راجع التذكرة');
    else if (draft) add('amber', `تذكرة الكاشير تنتظر تأكيدك (${draft})`, 'شيك الأسطر واضغط «تأكيد»', '#/tickets', 'أكّد التذكرة');
    if (!get('SELECT 1 AS x FROM tickets WHERE date = ?', date) && (!today || C.riyadhHour() >= 20))
      add('amber', 'صوّر تذكرة الكاشير وارفعها', 'كل صور التذكرة — النظام يقراها لحاله', '#/tickets', 'ارفع التذكرة');
    const y = today ? C.addDays(date, -1) : date;
    if (!get('SELECT 1 AS x FROM cash_counts WHERE date = ?', y) && get('SELECT 1 AS x FROM sales WHERE date = ?', y))
      add('amber', `اجرد الكاش ليوم ${y}`, 'اكتب كم كاش في الدرج وكم شبكة', '#/report', 'جرد الكاش');
  }
  // ---- الترتيب (المالك ومن له الوصفات) ----
  if (canRecipes(u)) {
    if (isOwner(u) && !getSetting('loyverse_token')) add('red', 'حط رمز لويفرس', 'عشان المبيعات تنسحب لحالها', '#/settings', 'الإعدادات');
    if (isOwner(u)) for (const f of all("SELECT f.*, us.name FROM login_fails f JOIN users us ON us.id = f.user_id WHERE f.locks > 0 AND f.last_at > ?", new Date(Date.now() - 86400e3).toISOString()))
      add('red', `🔒 حساب ${f.name} انقفل ${f.locks === 1 ? 'مرة' : f.locks + ' مرات'}`, `أحد غلط بالرقم السري ${LOGIN_TRIES} مرات${f.locks > 1 ? ' ورا بعض' : ''} — إذا مو هو، غيّر رقمه السري`, '#/staff', 'الموظفين');
    const unlinked = get(`SELECT COUNT(DISTINCT COALESCE(loyverse_item_id, name)) AS n FROM products WHERE active = 1 AND recipe_status != 'skip'
      AND id NOT IN (SELECT product_id FROM recipe_lines)`).n;
    const fixes = LK.nameFixes().length;
    if (fixes) add('amber', `${fixes} صنف اسمه مكتوب غير عن لويفرس`, 'وحّد الكتابة بضغطة — عشان ينربطون صح', '#/link', 'وحّد الأسماء');
    if (unlinked) add('amber', `فيه ${unlinked} صنف من لويفرس ما يعرف وش ينخصم`, 'بدونها ما يبان النقص — اربطها بضغطة', '#/link', 'اربطها');
    if (isOwner(u) && today) {
      try {
        const sug = IN.recipeSuggestions(date);
        if (sug.length) add('info', `${sug.length} صنف ينقص كل يوم بنفس النسبة — يمكن الوصفة ناقصة`, sug.slice(0, 4).map(x => `${x.name} ${x.pct}%`).join('، '), '#/profit', 'شوف الاقتراح');
        const high = IN.menuProfit(date).rows.filter(r => r.high && r.sold_30 > 0);
        if (high.length) add('info', `${high.length} طبق تكلفته عالية (فوق ${getSetting('max_food_cost', '35')}% من سعره)`, high.slice(0, 4).map(r => `${r.name} ${r.food_cost_pct}%`).join('، '), '#/profit', 'ربح الأطباق');
      } catch (e) { console.error('insights', e); }
    }
    const drafts = get("SELECT COUNT(*) AS n FROM products WHERE active = 1 AND recipe_status = 'draft'").n;
    if (drafts) add('info', `${drafts} وصفة سواها النظام لحاله`, 'شيكها واضغط «اعتمد»', '#/recipes?f=draft', 'راجع الوصفات');
  }
  if (isSup(u)) {
    const noSec = board.rows.filter(r => !r.section_id);
    if (noSec.length) add('amber', `${noSec.length} صنف في الجرد ما له مسؤول`, `حطه عند موظف: ${names(noSec)}`, '#/staff', 'حدد المسؤول');
    for (const cv of all("SELECT DISTINCT user_id FROM cash_custody").map(x => custodyView(x.user_id, { limit: 0 }))) {
      for (const m of cv.unconfirmed) add('amber', `👛 ${cv.name} كتب إنه ${m.kind === 'give' ? 'استلم منك' : 'رجّع لك'} ${m.amount} ريال — صح؟`, `${m.date}${m.note ? ' — ' + m.note : ''}`, '#/purchases', 'أكّد');
      if (Math.abs(cv.balance) >= 1) add('info', `👛 عهدة ${cv.name}: ${cv.balance > 0 ? 'باقي عنده' : 'له عندك'} ${Math.abs(cv.balance)} ريال`, `أعطيته ${cv.given} · صرف ${cv.spent}${cv.returned ? ` · رجّع ${cv.returned}` : ''}${cv.no_photo ? ` · ${cv.no_photo} شراء بدون صورة فاتورة` : ''}`, '#/purchases', 'كشف العهدة');
    }
    const gaps = board.rows.filter(r => r.fridge_gap > 0);
    if (gaps.length) add('red', `زيادة ما نعرف من فين (${gaps.length})`, gaps.map(r => `${r.name}: كتب ${r.opening} وفوق كان ${r.up_before} — ${r.opening_user}`).join('، '), '#/count?s=all&p=opening', 'شوف');
    const photosMissing = board.rows.filter(r => r.need_photo && r.closing > 0 && !r.closing_image);
    if (photosMissing.length && !today) add('amber', `ما صوّروا الباقي (${photosMissing.length})`, photosMissing.map(r => `${r.name} — ${r.closing_user}`).join('، '), '#/count?s=all&p=closing', 'شوف');
    const noOne = board.rows.filter(r => r.section_id && (!r.opening_user_id || !r.closing_user_id));
    if (noOne.length) add('amber', `${noOne.length} صنف في الجرد ما له مسؤول`, `حدد مين يجرده: ${names(noOne)}`, '#/staff', 'حدد المسؤول');
  }
  // ---- التجهيز المتوقع اليوم (من السجل) والمستودع اللي قرب يخلص ----
  if (today && !closed && !onlyPurch(u)) {
    try {
      const fc = F.forecast(date);
      if (fc.samples >= 2) {
        const mine = [...fc.prep, ...fc.buy].filter(r => r.opener_id === u.id && r.make > 0);
        if (mine.length) add('info', 'المتوقع ينباع اليوم — جهّز تقريبًا', mine.slice(0, 8).map(r => `${r.name} ${r.make} ${r.unit}`).join('، '), canSales(u) ? '#/assistant?tab=reco' : '', canSales(u) ? 'التوصيات' : '');
      }
      if (isPurch(u)) {
        const low = F.stockDays(date);
        const up = IN.purchasePrices(date).filter(r => r.change_pct >= 10);
        if (up.length && isSup(u)) add('info', `${up.length} صنف غلي سعره هالشهر`, up.slice(0, 5).map(r => `${r.name} +${r.change_pct}%`).join('، '), '#/suppliers', 'الأسعار');
        if (low.length) add('amber', `المستودع قرب يخلص (${low.length})`, low.slice(0, 6).map(r => `${r.name} يكفي ${r.days_left < 1 ? 'أقل من يوم' : Math.floor(r.days_left) + ' يوم'}`).join('، '), '#/purchases', 'سجّل شراء');
      }
    } catch (e) { console.error('forecast', e); }
  }
  // ---- وحدات الشراء اللي ما تحددت ----
  if (isPurch(u)) {
    const n = get("SELECT COUNT(*) AS n FROM items WHERE active = 1 AND kind = 'raw' AND buy_unit = ''").n;
    if (n) add('info', `حدّد وحدة الشراء لـ ${n} صنف`, 'كرتون، كيس، باكت… وفيه كم — عشان الشراء ينحسب صح', '#/buyunits', 'حدّدها');
  }
  // ---- مشتريات تنتظر الاعتماد ----
  if (isSup(u)) {
    const n = get('SELECT COUNT(*) AS n FROM purchases WHERE approved_at IS NULL AND date BETWEEN ? AND ?', C.addDays(date, -7), date).n;
    if (n) add('amber', `فيه ${n} شراء ينتظر اعتمادك`, 'راجعها — بعد الاعتماد زكريا ما يقدر يعدّلها', '#/purchases', 'اعتمد');
  }
  // ---- «يبدأ من الشراء» (اللحوح، الكدر…): انباع وما اتسجل شراه — اليوم وأمس ----
  if (isPurch(u) || isSup(u)) for (const d of [date, C.addDays(date, -1)]) {
    const rs = (d === date && board ? board : C.dailyBoard(d)).rows.filter(r => r.missing_in && (r.kind === 'raw' || isSup(u)));
    if (rs.length) add('red', `${d === date ? 'اليوم' : 'أمس'}: انباع ${names(rs)} وما اتسجل ${rs.every(r => r.kind === 'raw') ? 'شراه' : 'شراه/طبخه'}`,
      `${rs.map(r => `${r.name} انباع ${C.r3(r.missing_in)}`).join('، ')} — سجّل الشراء بتاريخ ${d} عشان جرده يطلع صح`, '#/purchases?date=' + d, 'سجّل الشراء');
  }
  // ---- التذكيرات اللي جا وقتها ----
  for (const r of all('SELECT * FROM reminders WHERE user_id = ? AND done = 0 AND due_date <= ? ORDER BY due_date, id', u.id, date))
    out.push({ level: 'amber', title: '⏰ ' + r.text, detail: r.due_date < date ? 'من ' + r.due_date : '', href: '', btn: '', done_id: r.id });
  if (!out.some(t => t.level !== 'green' && t.level !== 'info')) add('green', 'ما عليك شي الحين 👍', '', '', '');
  const rank = { red: 0, amber: 1, info: 2, green: 3 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

AS.deps.todoFor = todoFor;
AS.deps.custodyView = custodyView;
R('GET', '/api/dashboard', ({ u, q }) => {
  const date = dateOr(q.date);
  const board = C.dailyBoard(date);
  const mine = board.rows.filter(r => r.opening_user_id === u.id || r.closing_user_id === u.id);
  const out = {
    date, today: C.businessDate(), closed: dayClosed(date),
    my_tasks: {
      opening_missing: mine.filter(r => r.opening_user_id === u.id && r.opening == null).length,
      closing_missing: mine.filter(r => r.closing_user_id === u.id && r.closing == null).length,
      total: mine.length,
    },
    sections: board.sections.map(s => ({ id: s.id, name: s.name, items: s.items, opening_done: s.opening_done, closing_done: s.closing_done,
      opening_user: s.opening_user, closing_user: s.closing_user, opening_approved: s.opening_approved, closing_approved: s.closing_approved,
      shortage_value: isSup(u) ? s.shortage_value : undefined })),
    todo: todoFor(u, date, board),
  };
  if (canSales(u)) {
    const rep = C.dailyReport(date);
    out.money = rep.money; out.alerts = rep.alerts;
    out.last_sync = get('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1') || null;
  } else if (isSup(u)) {
    // مشرف بدون صلاحية المبيعات: تنبيهات الجرد بس
    const salesTypes = ['ticket_draft', 'ticket_missing', 'ticket_unmatched', 'ticket_check', 'cash_missing', 'sync', ...(canRecipes(u) ? [] : ['no_recipe'])];
    out.alerts = C.alerts(date).filter(a => !salesTypes.includes(a.type));
    out.last_sync = get('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1') || null;
  } else {
    out.alerts = C.alerts(date).filter(a => a.text.includes(u.name));
  }
  return out;
});

// ---- الجرد اليومي ----
R('GET', '/api/board', ({ u, q }) => {
  const date = dateOr(q.date);
  const b = C.dailyBoard(date);
  b.closed = dayClosed(date);
  b.honey = require('./honey').info(date); // 🍯 القارورة: خطوة اليوم والصور
  if (isSup(u)) return b;
  const mySecs = approverSections(u);
  b.rows = b.rows.filter(r => r.opening_user_id === u.id || r.closing_user_id === u.id || r.prep_user_id === u.id || mySecs.includes(r.section_id)).map(r => {
    if (mySecs.includes(r.section_id)) return r;
    if (r.opening_user_id !== u.id && r.closing_user_id !== u.id) r = { ...r, prep_only: 1 }; // يحضّره بس: «+ أضفت»
    const { theoretical, actual, diff, diff_value, remaining_expected, waste_value, ...rest } = r; return rest;
  });
  const secIds = new Set(b.rows.map(r => r.section_id));
  b.sections = b.sections.filter(s => secIds.has(s.id)).map(s => ({ ...s, shortage_value: mySecs.includes(s.id) ? s.shortage_value : undefined }));
  return b;
});

const isWeightUnit = x => /^(كجم|كيلو|كغ|kg)$/i.test(String(x || '').trim());
R('POST', '/api/count', ({ u, body }) => {
  const date = dateOr(body.date);
  const phase = body.phase === 'closing' ? 'closing' : 'opening';
  const item = get('SELECT * FROM items WHERE id = ?', Number(body.item_id)) || bad('الصنف غير موجود');
  const sec = item.section_id ? get('SELECT * FROM sections WHERE id = ?', item.section_id) : null;
  const closer = item.closing_user_id || (sec && sec.closing_user_id);
  // «يبدأ من آخر أمس»: لو أمس ما انجرد، المقفل يكتب أول اليوم هالمرة
  const responsible = phase === 'opening' ? (item.opening_user_id || (sec && sec.opening_user_id) || (item.no_opening ? closer : null)) : closer;
  const approver = sec && approverSections(u).includes(sec.id);
  if (!isSup(u) && responsible !== u.id && !approver && !require('./wa_nudge').absentIds(date).includes(responsible)) forbid('هذا الصنف مو عليك'); // اللي يغطي عن الغايب يجرد أصنافه
  if (dayClosed(date) && !isOwner(u)) forbid('اليوم مقفل');
  if (sec && !isSup(u) && !approver && get('SELECT 1 AS x FROM section_approvals WHERE date = ? AND section_id = ? AND phase = ?', date, sec.id, phase)) forbid('المشرف استلم — كلم المشرف يعدّل');
  // 🔒 العامل يدخل رقمه مرة وحدة — لو غلط، المشرف يعدّله (الأجزاء: يكمّل الناقص منها بس)
  { const hb = require('./honey').bottle(); if (hb && hb.item.id === item.id && !isSup(u)) forbid('القارورة من خانة 🍯 بالصورة'); }
  if (!isSup(u) && !approver) {
    const ex = get(`SELECT ${phase} AS v, closing_parts AS cp FROM counts WHERE date = ? AND item_id = ?`, date, item.id);
    const pts = phase === 'closing' ? C.safeJSON(item.parts || '', null) : null;
    const partial = Array.isArray(pts) && pts.length && ex && Object.keys(C.safeJSON(ex.cp || '', {}) || {}).length < pts.length;
    if (ex && ex.v != null && !partial) forbid('دخلت رقمك قبل 🔒 — لو غلط كلّم المشرف يعدّله');
  }
  let qty = optNum(body.qty), partsJson = '', keepQty = null;
  // جرد على أجزاء (آخر اليوم): المجموع = كل جزء × معامله، واللي «يترمى» ما يقعد لبكرة
  const parts = C.safeJSON(item.parts || '', null);
  if (phase === 'closing' && Array.isArray(parts) && parts.length && body.parts && typeof body.parts === 'object') {
    let tot = 0, keepT = 0, any = false; const got = {};
    for (const pt of parts) {
      const v = optNum(body.parts[pt.name]);
      if (v == null) continue;
      if (!Number.isFinite(v) || v < 0) bad(`${pt.name}: الكمية غير صحيحة`);
      any = true; got[pt.name] = v;
      const w = v * (Number(pt.factor) || 1); tot += w; if (!pt.drop) keepT += w;
    }
    if (any) { qty = C.r3(tot); keepQty = C.r3(keepT); partsJson = JSON.stringify(got); } else qty = null;
  }
  if (qty != null && (!Number.isFinite(qty) || qty < 0)) bad('الكمية غير صحيحة');
  // بالوزن: «إيدام بامية ٤.٥٥ كجم» => (الوزن − الصحن الفاضي) × كم نفر في الكيلو. والقارورة (الصنف نفسه بالكيلو): ننطرح وزنها
  const unitIn = String(body.unit || '').trim();
  if (qty != null && unitIn && unitIn !== item.unit && !partsJson) {
    const f = get('SELECT factor FROM item_units WHERE item_id = ? AND name = ?', item.id, unitIn) || bad(`كم ${item.unit} في ${unitIn} (${item.name})؟`);
    qty = C.r3(Math.max(0, qty - (isWeightUnit(unitIn) && !body.net ? (item.tare || 0) : 0)) * f.factor);
  } else if (qty != null && item.tare > 0 && !partsJson && !body.net && isWeightUnit(item.unit)) qty = C.r3(Math.max(0, qty - item.tare));
  run('INSERT INTO counts(date, item_id) VALUES(?,?) ON CONFLICT DO NOTHING', date, item.id);
  if (phase === 'closing') run('UPDATE counts SET closing_parts = ?, closing_keep = ? WHERE date = ? AND item_id = ?', partsJson, keepQty, date, item.id);
  run(`UPDATE counts SET ${phase} = ?, ${phase}_by = ?, ${phase}_at = ?${body.note != null ? ', note = ?' : ''} WHERE date = ? AND item_id = ?`,
    ...[qty, qty == null ? null : u.id, qty == null ? null : nowISO()], ...(body.note != null ? [String(body.note)] : []), date, item.id);
  // إغلاق اليوم يأثر على سحب بكرة، والافتتاح يأثر على سحب اليوم
  syncFridge(date, item.id); syncOpeningPull(date, item.id);
  resyncNext(date, item.id); // اللي ينزل بكرة يعتمد على اللي طلع/بقي اليوم
  if (phase === 'closing' && qty > 0 && !isOwner(u)) noStockAlert(u, item, date);
  return { ok: true };
});
// ⚠️ «راح بدون مخزون»: انكتب باقي آخر الدوام والصنف ما له أول يوم ولا استلام ولا إضافة — لنوح + المسؤول عن جرده (مرة باليوم لكل صنف)
function noStockAlert(u, item, date) {
  const r = C.dailyBoard(date).rows.find(x => x.item_id === item.id);
  if (!r || (r.opening || 0) + (r.received || 0) + (r.added || 0) + (r.from_fridge || 0) > 0.0001) return;
  let seen = {}; try { seen = JSON.parse(getSetting('no_stock_alerts') || '{}'); } catch { /* */ }
  if (seen.date !== date) seen = { date, ids: [] };
  if (seen.ids.includes(item.id)) return;
  seen.ids.push(item.id); setSetting('no_stock_alerts', JSON.stringify(seen));
  const what = `${item.name} ${C.r3(r.closing)} ${item.unit}`, sent = new Set([u.id]);
  const owners = all("SELECT id, phone FROM users WHERE role = 'owner' AND active = 1 AND bot = 0 AND phone != ''");
  const resp = get("SELECT id, name, phone FROM users WHERE id = ? AND active = 1 AND bot = 0 AND phone != ''", r.closing_user_id || r.opening_user_id || 0);
  setImmediate(async () => {
    for (const o of owners) { sent.add(o.id); await wa.sendText(o.phone, `⚠️ ${u.name} دخّل ${what} آخر الدوام — وما له مخزون (لا أول اليوم ولا استلام ولا إضافة). هذي راحت بدون مخزون — فسّرها 🤔`).catch(() => {}); }
    if (resp && (!sent.has(resp.id) || resp.id === u.id)) await wa.sendText(resp.phone, `⚠️ يا ${resp.name}، ${what} انكتب آخر الدوام وما له مخزون أول اليوم ولا استلام — من وين جا؟\nلو نزّلته من الثلاجة أو طبخته: افتح الرابط واضغط «+ أضفت» واكتب الوزن 🙏`).catch(() => {});
  });
}
// 🍯 قارورة عسل السلام من الرابط: صورة + وزن — النظام يعرف الخطوة (الصبح، فل بعد التعبئة، آخر الدوام)
R('POST', '/api/honey', ({ u, body }) => {
  const H = require('./honey'), hb = H.bottle() || bad('ما فيه قارورة');
  const date = C.businessDate();
  if (!isSup(u) && H.ownerOf(date, hb.item.id) !== u.id) forbid('القارورة مو عليك');
  if (dayClosed(date) && !isOwner(u)) forbid('اليوم مقفل');
  const empty = !!body.empty_tub;
  const image = saveImage(body.image || '') || (empty ? '' : bad('صوّر القارورة على الميزان أول 📷'));
  let w = Number(normNum(body.weight));
  if (!empty && !(w > 0)) bad('اكتب الوزن اللي على الميزان');
  if (w > 20) w = w / 1000; // كتبه بالجرام
  const r = H.step(u, { weight: empty ? null : w, empty_tub: empty, end: !!body.end, image });
  if (r.error) bad(r.error);
  setImmediate(async () => {
    for (const n of r.notify || []) {
      const to = n.to === 'buyers' ? all("SELECT phone FROM users WHERE role = 'purchaser' AND active = 1 AND bot = 0 AND phone != ''") : all("SELECT phone FROM users WHERE role = 'owner' AND active = 1 AND bot = 0 AND phone != ''");
      for (const o of to) await wa.sendText(o.phone, n.text).catch(() => {});
    }
  });
  return { ok: true, say: r.say, honey: H.info(date) };
});
// صورة الباقي آخر الدوام (للأصناف اللي «تحتاج صورة»)
R('POST', '/api/count/photo', ({ u, body }) => {
  const date = dateOr(body.date);
  const item = get('SELECT * FROM items WHERE id = ?', Number(body.item_id)) || bad('الصنف غير موجود');
  if (!canTouch(u, item)) forbid('هذا الصنف مو عليك');
  if (dayClosed(date) && !isOwner(u)) forbid('اليوم مقفل');
  const img = saveImage(body.image || '') || bad('صوّر أول');
  run('INSERT INTO counts(date, item_id) VALUES(?,?) ON CONFLICT DO NOTHING', date, item.id);
  run('UPDATE counts SET closing_image = ? WHERE date = ? AND item_id = ?', img, date, item.id);
  return { ok: true, image: img };
});
// «+ أضفت»: طبخة جديدة (تنخصم مكوناتها)، من صنف ثاني (السهوم ← برم)، أو من الثلاجة فوق
R('POST', '/api/add', ({ u, body }) => {
  const date = dateOr(body.date);
  const item = get('SELECT * FROM items WHERE id = ?', Number(body.item_id)) || bad('الصنف غير موجود');
  if (!canTouch(u, item)) forbid('هذا الصنف مو عليك');
  if (dayClosed(date) && !isOwner(u)) forbid('اليوم مقفل');
  const qty = num(String(body.qty ?? '').replace('٫', '.'), 'الكمية'); if (!(qty > 0)) bad('كم أضفت؟');
  let r;
  const upOf = id => C.r3(C.warehouseBalances().get(id) || 0);
  if (body.source === 'from') {
    const src = get('SELECT * FROM item_sources WHERE item_id = ? AND from_item_id = ?', item.id, Number(body.from_item_id)) || bad('اختر من فين');
    const fq = Number(body.from_qty) > 0 ? Number(body.from_qty) : C.r3(qty / (src.ratio || 1));
    const fi = get('SELECT name, daily FROM items WHERE id = ?', src.from_item_id);
    if (fi && !fi.daily && fq > upOf(src.from_item_id) + 1e-9) bad(`${fi.name} فوق ما فيه إلا ${upOf(src.from_item_id)} — قسّم ذبيحة أول`);
    r = convert(u, { date, from_item_id: src.from_item_id, to_item_id: item.id, qty_from: fq, qty_to: qty, note: '' });
  } else if (body.source === 'fridge') {
    // «مستودع + ثلاجة» (السمك اللي ورا، البيبسي فوق): الرصيد ممكن ما يكون مسجّل أول مرة — نمشي ونبلّغ نوح بدل الرفض
    if (qty > upOf(item.id) + 1e-9) {
      if (!item.buy_store) bad(`فوق في الثلاجة ما فيه إلا ${upOf(item.id)}`);
      const have = upOf(item.id);
      setImmediate(() => { for (const o of all("SELECT phone FROM users WHERE role = 'owner' AND active = 1 AND bot = 0 AND phone != ''")) wa.sendText(o.phone, `📦 ${u.name} نزّل ${qty} ${item.unit} ${item.name} للعرض، والمسجّل ورا ${have} بس — يمكن الرصيد اللي ورا ما انسجل (أو شراء ما اتسجل).`).catch(() => {}); });
    }
    r = transfer(u, { date, item_id: item.id, qty, mode: 'pull', note: 'نزل من الثلاجة' });
  } else r = transfer(u, { date, item_id: item.id, qty, unit: body.unit, note: body.note || 'أضفت', moveType: 'add' });
  syncFridge(date, item.id); resyncNext(date, item.id);
  return r;
});
R('POST', '/api/split', ({ u, body }) => {
  const src = get('SELECT * FROM items WHERE id = ?', Number(body.item_id)) || bad('اختر اللي تقسمه');
  const outsOk = (body.outputs || []).every(o => { const it = get('SELECT * FROM items WHERE id = ?', Number(o.item_id)); return it && canTouch(u, it); });
  if (!isSup(u) && (!canSplit(u) || !outsOk || (src.daily && !canTouch(u, src)))) forbid('التقسيم للمشرف أو المسؤول عن اللحم');
  guardDay(u, dateOr(body.date));
  return splitItem(u, { ...body, date: dateOr(body.date) });
});
R('GET', '/api/splits', ({ u }) => {
  if (!canSplit(u)) forbid('التقسيم للمسؤول عن اللحم');
  const rows = all('SELECT s.item_id, s.out_item_id, s.share, i.name AS out_name, i.unit AS out_unit FROM item_splits s JOIN items i ON i.id = s.out_item_id WHERE i.active = 1 ORDER BY s.sort');
  return all('SELECT id, name, unit, daily FROM items WHERE active = 1 AND id IN (SELECT item_id FROM item_splits)').map(i => ({ ...i, outputs: rows.filter(r => r.item_id === i.id) }));
});
// ربط مصدر بنواتجه بدون ما ينقسم (كرتون أبو عصاية ← حبات) — عشان «فكيت كرتون» يشتغل من أول مرة
R('POST', '/api/splits/link', ({ u, body }) => {
  if (!isSup(u)) forbid('للمشرف والمالك');
  const src = get('SELECT id FROM items WHERE id = ? AND active = 1', Number(body.item_id)) || bad('اختر المصدر');
  const outs = (Array.isArray(body.outputs) ? body.outputs : []).map(Number).filter(id => id && id !== src.id);
  if (!outs.length) bad('اختر النواتج');
  for (const id of outs) {
    get('SELECT id FROM items WHERE id = ? AND active = 1', id) || bad('صنف غير موجود');
    if (body.remove) run('DELETE FROM item_splits WHERE item_id = ? AND out_item_id = ?', src.id, id);
    else run('INSERT INTO item_splits(item_id, out_item_id, sort) VALUES(?,?,?) ON CONFLICT DO NOTHING', src.id, id, (get('SELECT MAX(sort) AS m FROM item_splits WHERE item_id = ?', src.id).m ?? -1) + 1);
  }
  return { ok: true };
});
// كل البضاعة: في المحل + فوق/المستودع
R('GET', '/api/stock', ({ u, q }) => {
  needPurch(u);
  const date = dateOr(q.date);
  const board = new Map(C.dailyBoard(date).rows.map(r => [r.item_id, r]));
  const bal = C.warehouseBalances(), costs = C.itemCostMap();
  return all(`SELECT * FROM items WHERE active = 1 ${onlyPurch(u) ? "AND kind = 'raw'" : ''} ORDER BY sort, id`).map(i => {
    const b = board.get(i.id);
    let floor = b ? (b.closing ?? b.remaining_expected ?? b.opening ?? (b.received ? C.r3(b.received - b.theoretical - (b.wasted || 0)) : null)) : null;
    if (b && b.closing != null && b.to_fridge) floor = C.r3(b.closing - b.to_fridge); // اللي طلع الثلاجة محسوب فوق
    const wh = bal.get(i.id) || 0, unit = costs.get(i.id) || 0;
    const total = C.r3((floor || 0) + wh);
    return { id: i.id, name: i.name, unit: i.unit, kind: i.kind, daily: i.daily, leftover: i.leftover, floor, floor_counted: b ? b.closing != null : false, upstairs: C.r3(wh), total, value: C.r2(total * unit) };
  });
});

R('POST', '/api/approve', ({ u, body }) => {
  const date = dateOr(body.date);
  const phase = body.phase === 'closing' ? 'closing' : 'opening';
  const secId = Number(body.section_id);
  if (!isSup(u) && !approverSections(u).includes(secId)) forbid('الاستلام للمشرف');
  if (body.undo) { run('DELETE FROM section_approvals WHERE date = ? AND section_id = ? AND phase = ?', date, secId, phase); return { ok: true }; }
  const b = C.dailyBoard(date);
  const missing = b.rows.filter(r => r.section_id === secId && r[phase] == null);
  if (missing.length) bad(`باقي ما انجرد: ${missing.map(r => r.name).join('، ')}`);
  run('INSERT INTO section_approvals(date, section_id, phase, user_id, at) VALUES(?,?,?,?,?) ON CONFLICT DO UPDATE SET user_id = excluded.user_id, at = excluded.at', date, secId, phase, u.id, nowISO());
  return { ok: true };
});

// ---- السحب للمحضّر والتحويل ----
R('POST', '/api/transfer', ({ u, body }) => {
  const item = get('SELECT * FROM items WHERE id = ?', Number(body.item_id)) || bad('الصنف غير موجود');
  if (!canTouch(u, item) && !isPurch(u)) forbid('هذا الصنف مو عليك');
  guardDay(u, dateOr(body.date));
  const r = transfer(u, { ...body, moveType: undefined, date: dateOr(body.date), item_id: item.id });
  syncFridge(dateOr(body.date), item.id);
  return r;
});
R('POST', '/api/convert', ({ u, body }) => {
  const date = dateOr(body.date); guardDay(u, date);
  for (const id of [body.from_item_id, body.to_item_id]) {
    const it = get('SELECT * FROM items WHERE id = ?', Number(id)) || bad('الصنف غير موجود');
    if (!canTouch(u, it)) forbid('هذا الصنف مو عليك');
  }
  return convert(u, { ...body, date, from_item_id: Number(body.from_item_id), to_item_id: Number(body.to_item_id) });
});
R('GET', '/api/moves', ({ u, q }) => {
  const where = [], p = [];
  if (isDate(q.date)) { where.push('m.date = ?'); p.push(q.date); }
  if (q.item_id) { where.push('m.item_id = ?'); p.push(Number(q.item_id)); }
  if (q.types) { const t = String(q.types).split(','); where.push(`m.type IN (${t.map(() => '?').join(',')})`); p.push(...t); }
  if (!isSup(u)) { where.push('m.user_id = ?'); p.push(u.id); }
  return all(`SELECT m.*, i.name AS item, i.unit, us.name AS user FROM moves m JOIN items i ON i.id = m.item_id LEFT JOIN users us ON us.id = m.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.id DESC LIMIT 500`, ...p);
});
R('DELETE', '/api/moves/:id', ({ u, params }) => {
  const m = get('SELECT * FROM moves WHERE id = ?', Number(params.id)) || bad('غير موجود');
  if (!isSup(u) && !(m.user_id === u.id && m.date === C.businessDate())) forbid();
  if (m.type === 'sale_use' || m.type === 'purchase') bad('هذي تنحذف من مكانها (المشتريات/الوصفات)');
  guardDay(u, m.date);
  if (m.ref) run('DELETE FROM moves WHERE ref = ?', m.ref); else run('DELETE FROM moves WHERE id = ?', m.id);
  syncFridge(m.date, m.item_id); syncOpeningPull(m.date, m.item_id);
  return { ok: true };
});

// ---- المستودع ----
R('GET', '/api/warehouse', ({ u }) => {
  needPurch(u);
  const bal = C.warehouseBalances(), costs = C.itemCostMap();
  const lastCount = new Map(all("SELECT item_id, MAX(date) AS d FROM moves WHERE type = 'adjust' GROUP BY item_id").map(r => [r.item_id, r.d]));
  return all(`SELECT i.*, s.name AS section FROM items i LEFT JOIN sections s ON s.id = i.section_id WHERE i.active = 1 ${onlyPurch(u) ? "AND i.kind = 'raw'" : ''} ORDER BY s.sort, i.sort, i.id`).map(i => ({
    id: i.id, name: i.name, unit: i.unit, section: i.section || '', kind: i.kind,
    balance: bal.get(i.id) || 0, cost: C.r2(costs.get(i.id) || 0), value: C.r2((bal.get(i.id) || 0) * (costs.get(i.id) || 0)), last_count: lastCount.get(i.id) || null,
  }));
});
R('POST', '/api/warehouse/count', ({ u, body }) => {
  // المسؤول يجرد «اللي ورا» لأصنافه اللي شراها يروح ورا (السمك عند محمد)
  if (!isPurch(u)) for (const c of body.counts || []) { const it = get('SELECT * FROM items WHERE id = ?', Number(c.item_id)); if (!it || !it.buy_store || !canTouch(u, it)) forbid('جرد المستودع للمشتريات والمشرف'); }
  const date = dateOr(body.date); guardDay(u, date);
  const bal = C.warehouseBalances(), costs = C.itemCostMap();
  const result = [];
  tx(() => {
    for (const c of body.counts || []) {
      if (c.qty === '' || c.qty == null) continue;
      const id = Number(c.item_id), counted = num(normNum(c.qty)), cur = bal.get(id) || 0, diff = C.r3(counted - cur);
      if (counted < 0) bad('الجرد ما يكون سالب');
      bal.set(id, counted);
      if (diff) run("INSERT INTO moves(date, item_id, location, qty, type, user_id, note) VALUES(?,?,'warehouse',?,'adjust',?,?)", date, id, diff, u.id, `جرد مستودع: كان ${cur} وطلع ${counted}`);
      else run("INSERT INTO moves(date, item_id, location, qty, type, user_id, note) VALUES(?,?,'warehouse',0,'adjust',?,?)", date, id, u.id, 'جرد مستودع: مطابق');
      const it = get('SELECT name, unit FROM items WHERE id = ?', id);
      result.push({ item_id: id, name: it && it.name, unit: it && it.unit, expected: cur, counted, diff, value: C.r2(diff * (costs.get(id) || 0)) });
    }
  });
  return result;
});

// ---- أصناف المخزون ----
// مسؤول المشتريات يشوف بس اللي ينشرى (أصناف المستودع) — عشان ما يتشتت
const onlyPurch = u => u.role === 'purchaser';
R('GET', '/api/items', ({ u }) => {
  const comps = all('SELECT c.*, i.name AS component, i.unit FROM item_components c JOIN items i ON i.id = c.component_id');
  const units = all('SELECT * FROM item_units ORDER BY factor DESC');
  const costs = C.itemCostMap();
  const srcs = all('SELECT * FROM item_sources');
  return all(`SELECT i.*, s.name AS section FROM items i LEFT JOIN sections s ON s.id = i.section_id WHERE i.active = 1 ${onlyPurch(u) ? "AND i.kind = 'raw'" : ''} ORDER BY s.sort, i.sort, i.id`)
    .map(i => ({ ...i, unit_cost: C.r3(costs.get(i.id) || 0), components: comps.filter(c => c.item_id === i.id), units: units.filter(x => x.item_id === i.id), sources: srcs.filter(x => x.item_id === i.id) }));
});
R('POST', '/api/items', ({ u, body }) => {
  needPurch(u);
  const name = String(body.name || '').trim(); if (!name) bad('حط اسم الصنف');
  if (get('SELECT 1 AS x FROM items WHERE name = ? AND active = 1 AND id != ?', name, Number(body.id) || 0)) bad('فيه صنف بنفس الاسم');
  if (onlyPurch(u)) {
    // مسؤول المشتريات: يضيف ويعدّل أصناف المستودع (الاسم، الوحدة، الملاحظة) — والباقي يرتبه المالك
    if (body.id) {
      const ex = get('SELECT * FROM items WHERE id = ?', Number(body.id)) || bad('الصنف غير موجود');
      if (ex.kind !== 'raw') forbid('هذا صنف محضّر — مو من أصناف المستودع');
      run('UPDATE items SET name = ?, unit = ?, note = ? WHERE id = ?', name, body.unit || ex.unit, body.note ?? ex.note, ex.id);
      return { id: ex.id };
    }
    const wh = get("SELECT id FROM sections WHERE name LIKE 'المستودع%' ORDER BY id LIMIT 1");
    const sort = (get('SELECT MAX(sort) AS m FROM items').m || 0) + 1;
    return { id: Number(run("INSERT INTO items(name, unit, section_id, kind, daily, carry_over, note, sort) VALUES(?,?,?,'raw',0,1,?,?)", name, body.unit || 'حبة', wh ? wh.id : null, body.note || '', sort).lastInsertRowid) };
  }
  // المسؤول (القسم/الموظف) يتغيّر من صفحة المسؤوليات — إذا ما انرسل يبقى زي ما هو
  const old = body.id ? get('SELECT section_id, opening_user_id, closing_user_id, leftover, need_photo FROM items WHERE id = ?', Number(body.id)) || {} : {};
  // الباقي آخر اليوم: ينرمى | يبقى | يطلع الثلاجة | اللي انضاف يطلع الثلاجة — carry_over ينضبط منه
  const LO = ['waste', 'stay', 'fridge', 'fridge_added', 'old'];
  const leftover = LO.includes(body.leftover) ? body.leftover : body.carry_over !== undefined && !LO.includes(old.leftover) ? (body.carry_over ? 'stay' : 'waste') : body.carry_over !== undefined && ['waste', 'stay'].includes(old.leftover) ? (body.carry_over ? 'stay' : 'waste') : (old.leftover || (body.carry_over ? 'stay' : 'waste'));
  if (body.leftover) body.carry_over = leftover !== 'waste';
  const keep = (k) => (body[k] === undefined ? (old[k] ?? null) : optNum(body[k]));
  const f = [name, body.unit || 'حبة', keep('section_id'), body.kind === 'prepared' ? 'prepared' : 'raw', Number(body.cost) || 0, Number(body.sale_value) || 0,
    body.carry_over ? 1 : 0, body.daily ? 1 : 0, keep('opening_user_id'), keep('closing_user_id'), body.note || '', body.pull_on_open ? 1 : 0, Number(body.extra_cost) || 0];
  const needPhoto = body.need_photo === undefined ? (old.need_photo || 0) : (body.need_photo ? 1 : 0);
  let id;
  if (body.id) { run('UPDATE items SET name=?, unit=?, section_id=?, kind=?, cost=?, sale_value=?, carry_over=?, daily=?, opening_user_id=?, closing_user_id=?, note=?, pull_on_open=?, extra_cost=? WHERE id=?', ...f, Number(body.id)); id = Number(body.id); }
  else id = Number(run('INSERT INTO items(name, unit, section_id, kind, cost, sale_value, carry_over, daily, opening_user_id, closing_user_id, note, pull_on_open, extra_cost, sort) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', ...f, (get('SELECT MAX(sort) AS m FROM items').m || 0) + 1).lastInsertRowid);
  run('UPDATE items SET leftover = ?, need_photo = ? WHERE id = ?', leftover, needPhoto, id);
  // أجزاء جرد آخر اليوم: «كامل، مقطّع×1.25» أو «ني، مستوي-يترمى»
  if (body.parts !== undefined) run('UPDATE items SET parts = ? WHERE id = ?', JSON.stringify(parseParts(body.parts)), id);
  // طريقة الجرد: «ما يحتاج أول اليوم» و«الشراء يروح المستودع» (لو انرسلت)
  if (body.no_opening !== undefined) run('UPDATE items SET no_opening = ? WHERE id = ?', body.no_opening ? 1 : 0, id);
  if (body.buy_store !== undefined) run('UPDATE items SET buy_store = ? WHERE id = ?', body.buy_store ? 1 : 0, id);
  if (body.tare !== undefined) run('UPDATE items SET tare = ? WHERE id = ?', Math.max(0, Number(body.tare) || 0), id);
  if (body.portion_kg !== undefined) run('UPDATE items SET portion_kg = ? WHERE id = ?', Math.max(0, Number(body.portion_kg) || 0), id);
  // 🖼️ أيقونة الصنف (إيموجي) — عشان العامل يعرفه من شكله
  if (body.icon !== undefined) run('UPDATE items SET icon = ? WHERE id = ?', [...String(body.icon || '').trim()].slice(0, 4).join(''), id);
  // 🍖 «القديم» (اللحم المطبوخ اللي يطلع الثلاجة): صنفه + ينربط مصدر عشان «نزلت من القديم»
  if (body.old_item_id !== undefined) {
    const oid = optNum(body.old_item_id);
    if (oid && (oid === id || !get('SELECT 1 AS x FROM items WHERE id = ? AND active = 1', oid))) bad('صنف القديم غير موجود');
    run('UPDATE items SET old_item_id = ? WHERE id = ?', oid, id);
    if (oid) run('INSERT OR REPLACE INTO item_sources(item_id, from_item_id, ratio) VALUES(?,?,1)', id, oid);
  }
  // «يجي من»: البرم من السهوم…
  if (Array.isArray(body.sources)) tx(() => {
    run('DELETE FROM item_sources WHERE item_id = ?', id);
    for (const s of body.sources) if (Number(s.from_item_id) && Number(s.from_item_id) !== id) run('INSERT OR REPLACE INTO item_sources(item_id, from_item_id, ratio) VALUES(?,?,?)', id, Number(s.from_item_id), Number(s.ratio) > 0 ? Number(s.ratio) : 1);
  });
  return { id };
});
// 🔒 وصفة سرّية لصنف (الرز): المساعد يعطيها للمالك والمسؤول عن الصنف بس
R('PUT', '/api/items/:id/secret-recipe', ({ u, params, body }) => {
  needSup(u);
  const id = Number(params.id);
  get('SELECT 1 AS x FROM items WHERE id = ?', id) || bad('الصنف غير موجود');
  const text = String(body.text || '').trim().slice(0, 4000);
  // user_ids: يشوفها هذول بس (مع المالك) — وبدونها المسؤول عن الصنف
  const users = Array.isArray(body.user_ids) ? body.user_ids.map(Number).filter(Boolean) : [];
  const val = users.length ? JSON.stringify({ text, users }) : text;
  if (text) run("INSERT INTO private_notes(key, body, updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at", 'recipe:' + id, val, nowISO());
  else run('DELETE FROM private_notes WHERE key = ?', 'recipe:' + id);
  return { ok: true };
});
R('DELETE', '/api/items/:id', ({ u, params }) => {
  needPurch(u);
  const id = Number(params.id);
  if (onlyPurch(u) && (get('SELECT kind FROM items WHERE id = ?', id) || {}).kind !== 'raw') forbid('هذا صنف محضّر — مو من أصناف المستودع');
  const used = get('SELECT 1 AS x FROM moves WHERE item_id = ? UNION SELECT 1 FROM counts WHERE item_id = ? LIMIT 1', id, id);
  tx(() => {
    run('DELETE FROM recipe_lines WHERE item_id = ?', id);
    run('DELETE FROM item_components WHERE item_id = ? OR component_id = ?', id, id);
    if (used) run('UPDATE items SET active = 0 WHERE id = ?', id); else run('DELETE FROM items WHERE id = ?', id);
  });
  recomputeRecent();
  return { ok: true };
});
R('PUT', '/api/items/:id/units', ({ u, params, body }) => {
  needPurch(u);
  const id = Number(params.id);
  const item = get('SELECT unit, kind FROM items WHERE id = ?', id) || bad('الصنف غير موجود');
  if (onlyPurch(u) && item.kind !== 'raw') forbid('هذا صنف محضّر — مو من أصناف المستودع');
  tx(() => {
    run('DELETE FROM item_units WHERE item_id = ?', id);
    for (const x of body.units || []) {
      const name = String(x.name || '').trim(), factor = Number(x.factor);
      if (!name || name === item.unit || !(factor > 0)) continue;
      run('INSERT OR REPLACE INTO item_units(item_id, name, factor) VALUES(?,?,?)', id, name, factor);
    }
    // وحدة الشراء المعتادة: وحدة من الوحدات، أو نفس وحدة الصنف (بالوزن/بالحبة)
    if (body.buy_unit !== undefined) {
      const bu = String(body.buy_unit || '').trim();
      if (bu && bu !== item.unit && !get('SELECT 1 AS x FROM item_units WHERE item_id = ? AND name = ?', id, bu)) bad(`كم ${item.unit} في ${bu}؟`);
      run('UPDATE items SET buy_unit = ? WHERE id = ?', bu, id);
    }
  });
  return { ok: true };
});
// دمج أصناف في صنف واحد (ميرندا، ديو، حمضيات… => بيبسي): الوصفات والمشتريات والحركات والجرد كلها تصير عليه، والمدموج يتوقف
// «بس هذي الأصناف» على البيع/التذكرة: الرقم القديم يصير الجديد
function remapOnly(fromId, toId) {
  for (const t of ['sales', 'ticket_lines', 'note_rules']) for (const r of all(`SELECT id, only_items FROM ${t} WHERE only_items LIKE ?`, `%${fromId}%`)) {
    let ids; try { ids = JSON.parse(r.only_items || '[]'); } catch { continue; }
    if (!Array.isArray(ids) || !ids.some(x => Number(x) === fromId)) continue;
    run(`UPDATE ${t} SET only_items = ? WHERE id = ?`, JSON.stringify([...new Set(ids.map(x => Number(x) === fromId ? toId : Number(x)))]), r.id);
  }
}
function mergeItems(targetId, fromIds) {
  const target = get('SELECT * FROM items WHERE id = ? AND active = 1', targetId) || bad('الصنف غير موجود');
  const froms = [...new Set(fromIds.map(Number))].filter(id => id && id !== target.id).map(id => get('SELECT * FROM items WHERE id = ? AND active = 1', id) || bad('صنف غير موجود'));
  if (!froms.length) bad('اختر الأصناف اللي تندمج فيه');
  tx(() => { for (const f of froms) {
    // الوصفات: لو نفس الطبق فيه الاثنين => الكمية تنجمع
    for (const l of all('SELECT * FROM recipe_lines WHERE item_id = ?', f.id)) {
      const ex = get('SELECT id FROM recipe_lines WHERE product_id = ? AND item_id = ? AND source = ?', l.product_id, target.id, l.source);
      if (ex) { run('UPDATE recipe_lines SET qty = qty + ? WHERE id = ?', l.qty, ex.id); run('DELETE FROM recipe_lines WHERE id = ?', l.id); }
      else run('UPDATE recipe_lines SET item_id = ? WHERE id = ?', target.id, l.id);
    }
    for (const c of all('SELECT * FROM item_components WHERE component_id = ?', f.id)) {
      if (c.item_id === target.id) { run('DELETE FROM item_components WHERE item_id = ? AND component_id = ?', c.item_id, f.id); continue; }
      run('INSERT INTO item_components(item_id, component_id, qty) VALUES(?,?,?) ON CONFLICT(item_id, component_id) DO UPDATE SET qty = qty + excluded.qty', c.item_id, target.id, c.qty);
      run('DELETE FROM item_components WHERE item_id = ? AND component_id = ?', c.item_id, f.id);
    }
    run('DELETE FROM item_components WHERE item_id = ?', f.id);
    // حركات الثلاجة وتحضير أول اليوم مربوطة برقم الصنف القديم: تنمسح وتنحسب من جديد على الصنف الجديد
    run("DELETE FROM moves WHERE item_id = ? AND (ref LIKE 'op:%' OR ref LIKE 'fr:%')", f.id);
    run('UPDATE moves SET item_id = ? WHERE item_id = ?', target.id, f.id);
    remapOnly(f.id, target.id);
    run('INSERT OR IGNORE INTO item_units(item_id, name, factor) SELECT ?, name, factor FROM item_units WHERE item_id = ?', target.id, f.id);
    run('DELETE FROM item_units WHERE item_id = ?', f.id);
    run('UPDATE purchase_lines SET item_id = ? WHERE item_id = ?', target.id, f.id);
    // الجرد: نفس اليوم => ينجمع (فاضي + فاضي = فاضي)
    for (const c of all('SELECT * FROM counts WHERE item_id = ?', f.id)) {
      const t = get('SELECT * FROM counts WHERE date = ? AND item_id = ?', c.date, target.id);
      if (!t) { run('UPDATE counts SET item_id = ? WHERE date = ? AND item_id = ?', target.id, c.date, f.id); continue; }
      const add = (a, b) => a == null && b == null ? null : (a || 0) + (b || 0);
      run('UPDATE counts SET opening = ?, closing = ?, opening_by = COALESCE(opening_by, ?), closing_by = COALESCE(closing_by, ?) WHERE date = ? AND item_id = ?',
        add(t.opening, c.opening), add(t.closing, c.closing), c.opening_by, c.closing_by, c.date, target.id);
      run('DELETE FROM counts WHERE date = ? AND item_id = ?', c.date, f.id);
    }
    run('DELETE FROM item_sources WHERE item_id = ? OR from_item_id = ?', f.id, f.id);
    run('DELETE FROM item_splits WHERE item_id = ? OR out_item_id = ?', f.id, f.id);
    run("UPDATE items SET active = 0, note = TRIM(note || ' اندمج في ' || ?) WHERE id = ?", target.name, f.id);
  }
  for (const c of all('SELECT date FROM counts WHERE item_id = ? AND date >= ? ORDER BY date', target.id, getSetting('stock_start_date', ''))) { syncFridge(c.date, target.id); syncOpeningPull(c.date, target.id); }
  });
  return { ok: true, target: target.name, merged: froms.map(f => f.name) };
}
R('POST', '/api/items/:id/merge', ({ u, params, body }) => { needSup(u); return mergeItems(Number(params.id), body.from_ids || []); });
R('PUT', '/api/items/:id/components', ({ u, params, body }) => {
  needSup(u);
  const id = Number(params.id);
  tx(() => {
    run('DELETE FROM item_components WHERE item_id = ?', id);
    for (const c of body.components || []) if (c.component_id && Number(c.qty) && Number(c.component_id) !== id)
      run('INSERT OR REPLACE INTO item_components VALUES(?,?,?)', id, Number(c.component_id), Number(c.qty));
  });
  return { ok: true };
});

// ---- الأقسام والموظفين ----
R('GET', '/api/sections', () => all('SELECT * FROM sections ORDER BY sort, id').map(s => ({ ...s, approvers: all('SELECT user_id FROM section_approvers WHERE section_id = ?', s.id).map(a => a.user_id) })));
R('POST', '/api/sections', ({ u, body }) => {
  needSup(u);
  const name = String(body.name || '').trim(); if (!name) bad('حط اسم القسم');
  return tx(() => {
    let id = Number(body.id);
    if (id) run('UPDATE sections SET name=?, opening_user_id=?, closing_user_id=? WHERE id=?', name, optNum(body.opening_user_id), optNum(body.closing_user_id), id);
    else id = Number(run('INSERT INTO sections(name, opening_user_id, closing_user_id, sort) VALUES(?,?,?,?)', name, optNum(body.opening_user_id), optNum(body.closing_user_id), (get('SELECT MAX(sort) AS m FROM sections').m || 0) + 1).lastInsertRowid);
    run('DELETE FROM section_approvers WHERE section_id = ?', id);
    for (const a of body.approvers || []) run('INSERT OR IGNORE INTO section_approvers VALUES(?,?)', id, Number(a));
    return { id };
  });
});
R('DELETE', '/api/sections/:id', ({ u, params }) => { needOwner(u); run('DELETE FROM sections WHERE id = ?', Number(params.id)); return { ok: true }; });
// المشرف يحتاج الأسماء بس (يختار مين يجرد القسم) — الصلاحيات والرواتب والأرقام السرية للمالك
R('GET', '/api/users', ({ u }) => { needSup(u); return all((isOwner(u) ? 'SELECT id, name, role, salary, active, no_sales, no_recipes, pin, phone, voice_reply' : 'SELECT id, name, role, active') + ' FROM users WHERE bot = 0 ORDER BY active DESC, id'); });
R('POST', '/api/users', ({ u, body, token }) => {
  needOwner(u);
  const name = String(body.name || '').trim(); if (!name) bad('حط الاسم');
  const role = ['owner', 'supervisor', 'purchaser', 'worker'].includes(body.role) ? body.role : 'worker';
  const pin = String(body.pin || '0000');
  if (!/^\d{4,8}$/.test(pin)) bad('الرقم السري ٤ إلى ٨ أرقام');
  // جوال الواتساب (يرسل منه الجرد والمشتريات)
  const phone = body.phone === undefined ? null : WA.normPhone(body.phone);
  if (phone && !/^\d{9,15}$/.test(phone)) bad('رقم الجوال غير صحيح');
  if (phone && get('SELECT 1 AS x FROM users WHERE phone = ? AND id != ?', phone, Number(body.id) || 0)) bad('هذا الجوال مسجل لموظف ثاني');
  const setPhone = id => { if (phone !== null) run('UPDATE users SET phone = ? WHERE id = ?', phone, id); return { id }; };
  if (body.id) {
    if (Number(body.id) === u.id && role !== 'owner') bad('ما تقدر تشيل صلاحية المالك عن نفسك');
    const old = get('SELECT pin FROM users WHERE id = ?', Number(body.id));
    if (old && String(old.pin) !== pin) run('DELETE FROM sessions WHERE user_id = ? AND token != ?', Number(body.id), token || ''); // تغيّر رقمه => يطلع من كل الأجهزة (إلا جهازك)
    run('UPDATE users SET name=?, role=?, pin=?, salary=?, active=?, no_sales=?, no_recipes=? WHERE id=?', name, role, pin, Number(body.salary) || 0, body.active === false || body.active === 0 ? 0 : 1, body.no_sales ? 1 : 0, body.no_recipes ? 1 : 0, Number(body.id));
    if (body.voice_reply !== undefined) run('UPDATE users SET voice_reply = ? WHERE id = ?', body.voice_reply ? 1 : 0, Number(body.id));
    return setPhone(Number(body.id));
  }
  return setPhone(Number(run('INSERT INTO users(name, role, pin, salary, no_sales, no_recipes) VALUES(?,?,?,?,?,?)', name, role, pin, Number(body.salary) || 0, body.no_sales ? 1 : 0, body.no_recipes ? 1 : 0).lastInsertRowid));
});

// ---- أصناف البيع والوصفات ----
R('GET', '/api/products', ({ u, q }) => {
  if (!canRecipes(u) && !canSales(u)) forbid();
  const hideCost = !canRecipes(u); // التذكرة تحتاج الأصناف، بس الوصفات والتكلفة لمن له صلاحية
  const costs = C.itemCostMap(), recipes = C.recipeMap();
  const items = new Map(all('SELECT id, name, unit, daily FROM items').map(i => [i.id, i]));
  return all(`SELECT * FROM products WHERE active = 1 ${q.all ? '' : ''} ORDER BY category, name, variant`).map(p => ({
    ...p,
    lines: (recipes.get(p.id) || []).map(l => hideCost ? { id: l.id, item_id: l.item_id, item: items.get(l.item_id)?.name }
      : ({ ...l, item: items.get(l.item_id)?.name, unit: items.get(l.item_id)?.unit, source: items.get(l.item_id)?.daily ? 'floor' : 'warehouse', cost: C.r2(l.qty * (costs.get(l.item_id) || 0)) })),
    cost: hideCost ? undefined : C.r2(C.productCost(p.id, recipes, costs)),
  }));
});
R('POST', '/api/recipe-lines', ({ u, body }) => {
  needRecipes(u);
  const pid = Number(body.product_id), iid = Number(body.item_id);
  if (!get('SELECT 1 AS x FROM products WHERE id = ?', pid)) bad('صنف البيع غير موجود');
  if (!get('SELECT 1 AS x FROM items WHERE id = ? AND active = 1', iid)) bad('اختر المكوّن من قائمة المخزون');
  const id = Number(run('INSERT INTO recipe_lines(product_id, item_id, qty, source) VALUES(?,?,?,?)', pid, iid, num(body.qty, 'الكمية'), body.source === 'warehouse' ? 'warehouse' : 'floor').lastInsertRowid);
  run("UPDATE products SET recipe_status = 'ok' WHERE id = ?", pid);
  recomputeRecent();
  return { id };
});
R('PATCH', '/api/recipe-lines/:id', ({ u, params, body }) => {
  needRecipes(u);
  const l = get('SELECT * FROM recipe_lines WHERE id = ?', Number(params.id)) || bad('غير موجود');
  run('UPDATE recipe_lines SET item_id=?, qty=?, source=? WHERE id=?', Number(body.item_id ?? l.item_id), num(body.qty ?? l.qty, 'الكمية'), (body.source ?? l.source) === 'warehouse' ? 'warehouse' : 'floor', l.id);
  run("UPDATE products SET recipe_status = 'ok' WHERE id = ?", l.product_id);
  recomputeRecent();
  return { ok: true };
});
R('DELETE', '/api/recipe-lines/:id', ({ u, params }) => {
  needRecipes(u);
  const l = get('SELECT product_id FROM recipe_lines WHERE id = ?', Number(params.id));
  run('DELETE FROM recipe_lines WHERE id = ?', Number(params.id));
  // آخر مكوّن انحذف = الصنف رجع بدون وصفة (ويطلع في «ربط لويفرس بالجرد»)
  if (l && !get('SELECT 1 AS x FROM recipe_lines WHERE product_id = ?', l.product_id)) run("UPDATE products SET recipe_status = 'none' WHERE id = ?", l.product_id);
  recomputeRecent();
  return { ok: true };
});
R('POST', '/api/products/:id/status', ({ u, params, body }) => { needRecipes(u); run('UPDATE products SET recipe_status = ? WHERE id = ?', ['ok', 'skip', 'none'].includes(body.status) ? body.status : 'draft', Number(params.id)); return { ok: true }; });
R('POST', '/api/products/:id/copy-recipe', ({ u, params, body }) => {
  needRecipes(u);
  const to = Number(params.id), from = Number(body.from);
  tx(() => { for (const l of all('SELECT * FROM recipe_lines WHERE product_id = ?', from)) run('INSERT INTO recipe_lines(product_id, item_id, qty, source) VALUES(?,?,?,?)', to, l.item_id, l.qty, l.source); });
  run("UPDATE products SET recipe_status = 'ok' WHERE id = ?", to);
  recomputeRecent();
  return { ok: true };
});
// ---- المسؤوليات (بدل الأقسام): كل موظف له أصنافه — يجردها أول وآخر الدوام، والنقص عليه ----
// داخليًا كل موظف له «عهدة <اسمه>» (قسم باسمه) عشان الجرد والاستلام والنقص يمشون مثل ما هم
R('GET', '/api/responsibility', ({ u }) => {
  needSup(u);
  migrateToCustody();
  const users = all("SELECT id, name, role FROM users WHERE active = 1 AND bot = 0 AND role != 'purchaser' ORDER BY CASE role WHEN 'worker' THEN 0 ELSE 1 END, id");
  const active = new Set(users.map(x => x.id)); // موظف موقوف (مثل اللي ترك) = الصنف بدون مسؤول
  const items = C.dailyBoard(C.businessDate()).rows.map(r => ({ id: r.item_id, name: r.name, unit: r.unit, kind: r.kind, no_opening: r.no_opening,
    user_id: active.has(r.closing_user_id) ? r.closing_user_id : null, opener_id: active.has(r.opening_user_id) ? r.opening_user_id : null,
    preparer_id: active.has(r.prep_user_id) ? r.prep_user_id : null }));
  return { users, items };
});
// مرة وحدة: الأقسام القديمة تتحول لعهد — كل صنف يومي يروح لعهدة اللي يقفله (إذا شغّال)، وإلا بدون مسؤول
function migrateToCustody() {
  if (getSetting('custody_migrated')) return;
  const rows = C.dailyBoard(C.businessDate()).rows;
  const active = new Set(all('SELECT id FROM users WHERE active = 1 AND bot = 0').map(x => x.id));
  tx(() => {
    for (const r of rows) {
      const uid = active.has(r.closing_user_id) ? r.closing_user_id : active.has(r.opening_user_id) ? r.opening_user_id : null;
      run('UPDATE items SET section_id = ?, opening_user_id = NULL, closing_user_id = NULL WHERE id = ?', uid ? custodySection(uid) : null, r.item_id);
    }
    run(`DELETE FROM sections WHERE id NOT IN (SELECT section_id FROM items WHERE section_id IS NOT NULL)
      AND id NOT IN (SELECT section_id FROM section_approvals) AND name NOT LIKE 'المستودع%'`);
  });
  setSetting('custody_migrated', '1');
}
function custodySection(userId) {
  const usr = get('SELECT id, name FROM users WHERE id = ? AND active = 1 AND bot = 0', userId) || bad('الموظف غير موجود');
  const name = 'عهدة ' + usr.name;
  let s = get('SELECT id FROM sections WHERE name = ?', name);
  if (!s) s = { id: Number(run('INSERT INTO sections(name, opening_user_id, closing_user_id, sort) VALUES(?,?,?,?)', name, usr.id, usr.id, (get('SELECT MAX(sort) AS m FROM sections').m || 0) + 1).lastInsertRowid) };
  else run('UPDATE sections SET opening_user_id = ?, closing_user_id = ? WHERE id = ?', usr.id, usr.id, s.id);
  return s.id;
}
R('POST', '/api/responsibility', ({ u, body }) => {
  needSup(u);
  migrateToCustody(); // قبل أي تعديل — عشان التحويل القديم ما يمسح اللي ينحفظ الحين
  const ids = [].concat(body.item_ids || body.item_id || []).map(Number).filter(Boolean);
  if (!ids.length) bad('اختر الصنف');
  const sec = body.user_id ? custodySection(Number(body.user_id)) : null;
  // الفاتح: نفس المقفل (فاضي) | موظف ثاني | 'none' = ما يحتاج جرد أول اليوم (يبدأ من الشراء/التحضير)
  const op = body.opener_id;
  const noOpen = op === 'none' ? 1 : 0;
  const opener = op && op !== 'none' && Number(op) !== Number(body.user_id) ? Number(op) : null;
  if (opener && !get('SELECT 1 AS x FROM users WHERE id = ? AND active = 1', opener)) bad('الموظف غير موجود');
  tx(() => {
    for (const id of ids) {
      if (op === undefined) run('UPDATE items SET section_id = ?, closing_user_id = NULL WHERE id = ?', sec, id); // يبقى الفاتح زي ما هو
      else run('UPDATE items SET section_id = ?, opening_user_id = ?, closing_user_id = NULL, no_opening = ? WHERE id = ?', sec, opener, noOpen, id);
      // مين يحضّره / يضيف عليه (غير الفاتح والمقفل) — '' = ما فيه
      if (body.preparer_id !== undefined) run('UPDATE items SET prep_user_id = ? WHERE id = ?', optNum(body.preparer_id), id);
    }
  });
  // الأقسام القديمة اللي فضت ما لها داعي
  // (اللي له استلامات سابقة يبقى عشان السجل — بس ما يطلع لأنه فاضي)
  run(`DELETE FROM sections WHERE id NOT IN (SELECT section_id FROM items WHERE section_id IS NOT NULL)
    AND id NOT IN (SELECT section_id FROM section_approvals) AND name NOT LIKE 'المستودع%'`);
  run('DELETE FROM section_approvers WHERE section_id NOT IN (SELECT id FROM sections)');
  return { ok: true };
});

// ---- ربط لويفرس بالجرد ----
R('GET', '/api/link', ({ u, q }) => { needRecipes(u); return LK.unlinked({ includeSkipped: !!q.skipped }); });
R('GET', '/api/link/names', ({ u }) => { needRecipes(u); return LK.nameFixes(); });
// يسمّي أصناف المخزون بنفس كتابة لويفرس
R('POST', '/api/link/rename', ({ u, body }) => {
  needRecipes(u);
  let n = 0;
  tx(() => {
    for (const r of body.items || []) {
      const name = String(r.name || '').trim(), id = Number(r.item_id);
      if (!name || !id) continue;
      if (get('SELECT 1 AS x FROM items WHERE name = ? AND active = 1 AND id != ?', name, id)) bad(`فيه صنف ثاني اسمه «${name}»`);
      run('UPDATE items SET name = ? WHERE id = ?', name, id); n++;
    }
  });
  return { ok: true, renamed: n };
});
// action: item = ينسحب من صنف موجود | new = صنف جديد بنفس اسم لويفرس | skip = ما ينجرد | unskip
R('POST', '/api/link', ({ u, body }) => {
  needRecipes(u);
  const lines = (body.lines || []).map(l => ({ product_id: Number(l.product_id), qty: Number(String(l.qty ?? '').replace('٫', '.')) }))
    .filter(l => l.product_id && get('SELECT 1 AS x FROM products WHERE id = ?', l.product_id));
  if (!lines.length) bad('اختر صنف من لويفرس');
  if (body.action === 'skip' || body.action === 'unskip') {
    for (const l of lines) run('UPDATE products SET recipe_status = ? WHERE id = ?', body.action === 'skip' ? 'skip' : 'none', l.product_id);
    return { ok: true };
  }
  // طبق بمقادير: كل نوع وصفته (مرسة ساده/سمن/عسل…) — يستبدل وصفات الأنواع المختارة
  if (body.action === 'recipe') {
    const rows = (body.recipe || []).map(r => ({ product_id: Number(r.product_id), item_id: Number(r.item_id), qty: Number(String(r.qty ?? '').replace('٫', '.')) }))
      .filter(r => r.product_id && r.item_id && r.qty > 0);
    if (!rows.length) bad('حط مكوّن واحد على الأقل بكميته');
    const daily = new Map(all('SELECT id, daily FROM items WHERE active = 1').map(i => [i.id, i.daily]));
    for (const r of rows) if (!daily.has(r.item_id)) bad('اختر المكوّن من قائمة المخزون');
    tx(() => {
      for (const l of lines) run('DELETE FROM recipe_lines WHERE product_id = ?', l.product_id);
      for (const r of rows) {
        if (!lines.some(l => l.product_id === r.product_id)) continue;
        run('INSERT INTO recipe_lines(product_id, item_id, qty, source) VALUES(?,?,?,?)', r.product_id, r.item_id, r.qty, daily.get(r.item_id) ? 'floor' : 'warehouse');
        run("UPDATE products SET recipe_status = 'ok' WHERE id = ?", r.product_id);
      }
    });
    recomputeRecent();
    return { ok: true, linked: new Set(rows.map(r => r.product_id)).size };
  }
  const use = lines.filter(l => l.qty > 0);
  if (!use.length) bad('حط الكمية اللي تنخصم مع كل بيعة');
  const res = tx(() => {
    let itemId = Number(body.item_id), daily;
    if (body.action === 'new') {
      const name = String(body.name || '').trim() || bad('حط اسم الصنف');
      const ex = get('SELECT id, daily FROM items WHERE name = ? AND active = 1', name);
      if (ex) { itemId = ex.id; daily = ex.daily; }
      else {
        daily = body.daily ? 1 : 0;
        // اللي ينجرد يوميًا بدون قسم مختار: يبقى «بدون قسم» (ويطلع للمشرف «حدد المسؤول») — ما نرميه في أول قسم
        const sec = optNum(body.section_id) || (daily ? null : (get("SELECT id FROM sections WHERE name LIKE 'المستودع%' ORDER BY sort, id LIMIT 1") || {}).id) || null;
        const sort = (get('SELECT MAX(sort) AS m FROM items').m || 0) + 1;
        itemId = Number(run("INSERT INTO items(name, unit, section_id, kind, daily, carry_over, sort) VALUES(?,?,?,'raw',?,1,?)", name, body.unit || 'حبة', sec, daily, sort).lastInsertRowid);
      }
    } else {
      const it = get('SELECT id, daily FROM items WHERE id = ? AND active = 1', itemId) || bad('اختر صنف المخزون');
      daily = it.daily;
    }
    // الصنف اللي ينجرد يوميًا ينخصم من الجرد، وغيره من المستودع
    const source = daily ? 'floor' : 'warehouse';
    for (const l of use) {
      run('INSERT INTO recipe_lines(product_id, item_id, qty, source) VALUES(?,?,?,?)', l.product_id, itemId, l.qty, source);
      run("UPDATE products SET recipe_status = 'ok' WHERE id = ?", l.product_id);
    }
    return { ok: true, item_id: itemId, linked: use.length };
  });
  recomputeRecent();
  return res;
});
R('GET', '/api/note-rules', ({ u }) => { needRecipes(u); return all('SELECT r.*, p.name AS product, p.variant FROM note_rules r LEFT JOIN products p ON p.id = r.product_id').map(r => ({ ...r, only: C.safeJSON(r.only_items, []) })); });
R('POST', '/api/note-rules', ({ u, body }) => {
  needRecipes(u);
  const kw = String(body.keyword || '').trim(); if (!kw) bad('حط كلمة الملاحظة');
  const swapFrom = optNum(body.swap_from), swapTo = optNum(body.swap_to);
  if ((swapFrom == null) !== (swapTo == null)) bad('التبديل يحتاج الصنفين: من وإلى');
  run('INSERT INTO note_rules(product_id, keyword, only_items, swap_from, swap_to) VALUES(?,?,?,?,?)', optNum(body.product_id), kw, JSON.stringify((body.only || []).map(Number)), swapFrom, swapTo);
  recomputeRecent(); return { ok: true };
});
R('DELETE', '/api/note-rules/:id', ({ u, params }) => { needRecipes(u); run('DELETE FROM note_rules WHERE id = ?', Number(params.id)); recomputeRecent(); return { ok: true }; });

// ---- المبيعات والتقرير (للمشرفين بس) ----
R('GET', '/api/sales', ({ u, q }) => { needSales(u); return C.mergedSales(dateOr(q.date)); });
R('GET', '/api/report', ({ u, q }) => { needSales(u); return C.dailyReport(dateOr(q.date)); });
// انصرف حسب الوصفات: كل صنف ومن أي طبق — والأصناف اليومية مع اللي انصرف فعلًا من الجرد
R('GET', '/api/recipe-usage', ({ u, q }) => {
  needSales(u);
  const date = dateOr(q.date);
  const r = C.recipeUsage(date);
  const board = new Map(C.dailyBoard(date).rows.map(x => [x.item_id, x]));
  r.rows = r.rows.map(x => { const b = board.get(x.item_id); return b ? { ...x, count: { opening: b.opening, received: b.received, wasted: b.wasted, closing: b.closing, actual: b.actual, diff: b.diff, diff_value: b.diff_value, closer: b.closing_user } } : x; });
  return r;
});
R('GET', '/api/days', ({ u }) => {
  needSales(u);
  const dates = all(`SELECT date FROM (SELECT date FROM sales UNION SELECT date FROM counts UNION SELECT date FROM tickets UNION SELECT date FROM purchases) GROUP BY date ORDER BY date DESC LIMIT 120`);
  return dates.map(({ date }) => ({
    date,
    sales: C.r2(get('SELECT SUM(amount) AS a FROM sales WHERE date = ?', date).a),
    tickets: C.r2(get("SELECT SUM(amount) AS a FROM sales WHERE date = ? AND source = 'ticket'", date).a),
    closed: dayClosed(date),
  }));
});
R('POST', '/api/cash', ({ u, body }) => {
  needSales(u);
  const date = dateOr(body.date); guardDay(u, date);
  // من الورقة اليومية: الخرج (اللي انصرف من الدرج) والمجموع المكتوب — أرقام الورقة هي المعتمدة
  const N = v => Number(normNum(v)) || 0;
  const cash = N(body.cash), card = N(body.card);
  const old = get('SELECT spent, total FROM cash_counts WHERE date = ?', date);
  const given = body.spent !== undefined && body.spent !== null && body.spent !== '';
  const spent = given ? Math.max(0, N(body.spent)) : (body.spent === undefined && old ? old.spent : null); // تعديل الكاش من التقرير يخلي خرج الورقة
  const total = spent == null ? null : (given && N(body.total) > 0 ? N(body.total) : Math.round((cash + card + spent) * 100) / 100);
  run(`INSERT INTO cash_counts(date, cash, card, note, user_id, at, spent, total) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET cash=excluded.cash, card=excluded.card, note=excluded.note, user_id=excluded.user_id, at=excluded.at, spent=excluded.spent, total=excluded.total`,
    date, cash, card, body.note || '', u.id, nowISO(), spent, total);
  // لقطة الكاشير وقت تسجيل الكاش، ولو فيه نقص كبير توصل للمالك والمشرفين مع الصورة
  CAM.event('cashier', 'cash', `cash:${date}:${Date.now()}`).length && (async () => {
    const short = C.dailyReport(date).cash_shortage, lim = Number(getSetting('cam_alert_short', '20')) || 0;
    if (short != null && lim && short > lim) await camAlert(`💵 نقص في الكاش ${date}: ${C.r2(short)} ريال (سجّله ${u.name}). هذي لقطة الكاشير وقت التسجيل:`, (all("SELECT ref FROM cam_jobs WHERE reason = 'cash' ORDER BY id DESC LIMIT 1")[0] || {}).ref);
  })().catch(e => console.error('cam cash', e.message));
  return { ok: true };
});
R('POST', '/api/day/close', ({ u, body }) => {
  needSales(u);
  const date = dateOr(body.date);
  if (body.undo) { needOwner(u); run('DELETE FROM day_status WHERE date = ?', date); C.rebuildSaleUse(date); return { ok: true }; }
  const held = get("SELECT COUNT(*) AS n FROM tickets WHERE date = ? AND status != 'confirmed' AND check_status IN ('mismatch', 'duplicate')", date).n;
  if (held) bad('فيه تذكرة مجموعها ما يطابق أو مكررة — راجعها أول من صفحة التذكرة');
  if (get("SELECT 1 AS x FROM tickets WHERE date = ? AND status = 'reading'", date)) bad('فيه تذكرة للحين تنقرا — انتظر شوي');
  C.rebuildSaleUse(date);
  tx(() => {
    run("UPDATE tickets SET status = 'confirmed', confirmed_by = ?, confirmed_at = ? WHERE date = ? AND status = 'draft'", u.id, nowISO(), date);
    run('INSERT INTO day_status(date, closed_by, closed_at) VALUES(?,?,?) ON CONFLICT DO NOTHING', date, u.id, nowISO());
  });
  return { ok: true };
});

// ---- التذاكر ----
R('GET', '/api/tickets', ({ u, q }) => { needSales(u); return all('SELECT * FROM tickets WHERE date = ? ORDER BY id DESC', dateOr(q.date)).map(ticketView); });
R('GET', '/api/tickets/:id', ({ u, params }) => { needSales(u); const t = get('SELECT * FROM tickets WHERE id = ?', Number(params.id)) || bad('غير موجود'); return ticketView(t); });
R('POST', '/api/tickets', ({ u, body }) => {
  needSales(u);
  const date = dateOr(body.date);
  const imgs = (body.images || []).map(saveImage);
  const id = Number(run("INSERT INTO tickets(date, status, created_by) VALUES(?,?,?)", date, imgs.length ? 'reading' : 'draft', u.id).lastInsertRowid);
  for (const p of imgs) run('INSERT INTO ticket_images(ticket_id, path) VALUES(?,?)', id, p);
  if (imgs.length) ocrTicket(id); // يشتغل بالخلفية — الصفحة ما تعلق
  return { id };
});
R('POST', '/api/tickets/:id/images', ({ u, params, body }) => {
  needSales(u);
  const id = Number(params.id);
  const t = get('SELECT * FROM tickets WHERE id = ?', id) || bad('غير موجود');
  if (t.status === 'confirmed' && !isOwner(u)) forbid('التذكرة متأكدة');
  if (t.status === 'reading') bad('التذكرة للحين تنقرا — انتظر لين تخلص');
  const imgs = (body.images || []).map(saveImage);
  for (const p of imgs) run('INSERT INTO ticket_images(ticket_id, path) VALUES(?,?)', id, p);
  // صور زيادة لنفس التذكرة: تنقرا كل الصور من جديد مع بعض (عشان التداخل ينحسب صح)
  if (imgs.length) { run("UPDATE tickets SET status = 'reading' WHERE id = ?", id); ocrTicket(id); }
  return { ok: true };
});
R('PUT', '/api/tickets/:id/lines', ({ u, params, body }) => {
  needSales(u);
  const id = Number(params.id);
  const t = get('SELECT * FROM tickets WHERE id = ?', id) || bad('غير موجود');
  if (t.status === 'confirmed' && !isOwner(u)) forbid('التذكرة متأكدة');
  if (t.status === 'reading') bad('التذكرة للحين تنقرا — انتظر لين تخلص');
  if (dayClosed(t.date) && !isOwner(u)) forbid('اليوم مقفل');
  tx(() => {
    run('DELETE FROM ticket_lines WHERE ticket_id = ?', id);
    for (const l of body.lines || []) {
      const pid = optNum(l.product_id);
      if (!Number(l.price) && pid) l.price = (get('SELECT price FROM products WHERE id = ?', pid) || {}).price || 0;
      const qty = Number(l.qty) || 0, price = Number(l.price) || 0;
      // المبلغ المطبوع يبقى إذا العدد والسعر ما تغيروا، وإلا يتحسب من جديد
      const amount = l.amount != null && l.amount !== '' && Math.abs(Number(l.amount) - qty * price) <= 0.05 ? Number(l.amount) : C.r2(qty * price);
      const match = pid && pid === optNum(l.orig_product_id) ? (l.match || 'manual') : (pid ? 'manual' : 'none');
      const flag = T.lineFlags({ qty, unit_price: price, amount }, pid ? get('SELECT price FROM products WHERE id = ?', pid) : null);
      run('INSERT INTO ticket_lines(ticket_id, raw_name, product_id, qty, price, amount, customer, note, only_items, match, flag) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        id, l.raw_name || '', pid, qty, price, amount, '', l.note || '', l.only_items && l.only_items.length ? JSON.stringify(l.only_items.map(Number)) : '', match, flag);
      // يتعلم: الاسم المكتوب => الصنف (عشان المرة الجاية يربطه لحاله)
      if (pid && l.raw_name && normalize(l.raw_name)) run('INSERT INTO product_aliases(alias, product_id) VALUES(?,?) ON CONFLICT(alias) DO UPDATE SET product_id = excluded.product_id', normalize(l.raw_name), pid);
    }
  });
  recheckTicket(id);
  rebuildTicketSales(id);
  return ticketView(get('SELECT * FROM tickets WHERE id = ?', id));
});
R('POST', '/api/tickets/:id/confirm', ({ u, params, body }) => {
  needSales(u);
  const id = Number(params.id);
  const tk = get('SELECT date FROM tickets WHERE id = ?', id) || bad('غير موجود');
  guardDay(u, tk.date);
  if (body.undo && !isOwner(u)) forbid('التراجع عن تأكيد التذكرة للمالك');
  if (body.undo) run("UPDATE tickets SET status = 'draft', confirmed_by = NULL, confirmed_at = NULL WHERE id = ?", id);
  else {
    if (get('SELECT 1 AS x FROM ticket_lines WHERE ticket_id = ? AND product_id IS NULL', id)) bad('فيه أسطر ما انربطت بصنف');
    const t = get('SELECT check_status, check_note FROM tickets WHERE id = ?', id) || bad('غير موجود');
    if (TICKET_HOLD.includes(t.check_status) && !body.force) throw Object.assign(new HttpError(409, t.check_note || CHECK_TEXT[t.check_status]), { needForce: true });
    run("UPDATE tickets SET status = 'confirmed', confirmed_by = ?, confirmed_at = ? WHERE id = ?", u.id, nowISO(), id);
  }
  rebuildTicketSales(id);
  return { ok: true };
});
R('DELETE', '/api/tickets/:id', ({ u, params }) => {
  needSales(u);
  const id = Number(params.id);
  const t = get('SELECT * FROM tickets WHERE id = ?', id) || bad('غير موجود');
  if (t.status === 'confirmed' && !isOwner(u)) forbid('التذكرة متأكدة');
  guardDay(u, t.date);
  run('DELETE FROM tickets WHERE id = ?', id);
  rebuildTicketSales(id);
  C.rebuildSaleUse(t.date);
  return { ok: true };
});

// ---- المشتريات ----
// المشتريات للمشرفين ومسؤول المشتريات بس، والمصروفات للمشرفين بس (العمال ما يشوفونها)
R('GET', '/api/purchases', ({ u, q }) => {
  needPurch(u);
  const from = isDate(q.from) ? q.from : C.addDays(C.businessDate(), -30), to = isDate(q.to) ? q.to : C.businessDate();
  const rows = all(`SELECT p.*, us.name AS user, ap.name AS approved_by_name, p.approved_at IS NOT NULL AS approved FROM purchases p LEFT JOIN users us ON us.id = p.user_id
    LEFT JOIN users ap ON ap.id = p.approved_by WHERE date BETWEEN ? AND ? ORDER BY date DESC, id DESC`, from, to);
  return rows.map(p => ({ ...p, lines: all('SELECT l.*, i.name AS item, i.unit FROM purchase_lines l LEFT JOIN items i ON i.id = l.item_id WHERE purchase_id = ?', p.id) }));
});
R('POST', '/api/purchases', ({ u, body }) => { needPurch(u); return savePurchase(u, body); });
R('GET', '/api/fixed-purchases', ({ u }) => { needPurch(u); return { list: fixedList(), user_id: Number(getSetting('fixed_purchases_user', '0')) || null }; });
R('PUT', '/api/fixed-purchases', ({ u, body }) => {
  needPurch(u);
  const list = (Array.isArray(body.list) ? body.list : []).map(f => {
    const ln = a => (Array.isArray(a) ? a : []).map(l => ({ item_id: Number(l.item_id), qty: Number(normNum(l.qty)), unit_price: Number(normNum(l.unit_price)) || 0 }))
      .filter(l => get('SELECT 1 AS x FROM items WHERE id = ?', l.item_id) || bad('الصنف غير موجود')).filter(l => l.qty > 0);
    const supplier = String(f.supplier || '').trim().slice(0, 80) || bad('اسم المورد');
    return { supplier, payment: PAYMENTS.includes(f.payment) ? f.payment : 'credit', lines: ln(f.lines), ...(f.fri && f.fri.length ? { fri: ln(f.fri) } : {}), ...(f.off ? { off: true } : {}) };
  });
  setSetting('fixed_purchases', JSON.stringify(list));
  if (body.user_id !== undefined) setSetting('fixed_purchases_user', String(Number(body.user_id) || ''));
  return { ok: true, list };
});
R('POST', '/api/fixed-purchases/run', ({ u, body }) => { needPurch(u); const date = dateOr(body.date); if (body.force) setSetting('fixed_purchases_done', ''); return { added: addFixedPurchases(date) }; });
// تعديل: لصاحبه (أو المشرف) لين ينعتمد — بعد الاعتماد المالك بس
const canEditPurchase = (u, p) => {
  if (!isSup(u) && p.user_id !== u.id) forbid('تعدّل مشترياتك بس');
  if (p.approved_at && !isOwner(u)) forbid('المشتريات معتمدة — ما تتعدل');
  guardDay(u, p.date);
};
R('PUT', '/api/purchases/:id', ({ u, params, body }) => {
  needPurch(u);
  const p = get('SELECT * FROM purchases WHERE id = ?', Number(params.id)) || bad('غير موجود');
  canEditPurchase(u, p);
  return savePurchase(u, body, p);
});
// 📦 استلام بالوزن (أي موظف): شراء آجل «ينتظر الحساب» — والكمية تدخل الجرد على طول. نفس اليوم ونفس المورد => ينضاف لنفس الشراء
const RCV = require('./receive');
R('POST', '/api/receive', ({ u, body }) => {
  const date = dateOr(body.date);
  if (!String(body.supplier || '').trim() && !body.supplier_id) bad('من أي مورد؟');
  const add = (body.lines || []).filter(l => l.item_id && Number(l.qty) > 0).map(l => ({ item_id: Number(l.item_id), qty: C.r3(Number(l.qty)) }));
  if (!add.length) bad('وش الأصناف وكم وزنها؟');
  const sid = supplierId(body);
  const ex = get('SELECT * FROM purchases WHERE awaiting_invoice = 1 AND approved_at IS NULL AND supplier_id = ? AND date = ? ORDER BY id DESC LIMIT 1', sid, date);
  const merged = new Map();
  if (ex) for (const l of all('SELECT item_id, qty, to_floor FROM purchase_lines WHERE purchase_id = ?', ex.id)) merged.set(l.item_id, { item_id: l.item_id, qty: l.qty, to_floor: l.to_floor });
  for (const l of add) { const m = merged.get(l.item_id); if (m) m.qty = C.r3(m.qty + l.qty); else merged.set(l.item_id, l); }
  const b = { date, supplier_id: sid, payment: 'credit', awaiting_invoice: 1, note: ex ? ex.note : (body.note || 'استلام بالوزن — ينتظر الحساب'), image: body.image,
    lines: [...merged.values()].map(l => ({ item_id: l.item_id, qty: l.qty, ...(l.to_floor != null ? { to_floor: !!l.to_floor } : {}) })) };
  const r = savePurchase(u, b, ex || undefined);
  return { id: r.id, merged: !!ex, lines: all('SELECT l.item_id, l.qty, i.name, i.unit FROM purchase_lines l JOIN items i ON i.id = l.item_id WHERE l.purchase_id = ?', r.id) };
});
// 🧾 حساب المورد وصل: الأسعار من الحساب، والكمية تبقى اللي وزناها — ويرجع الفرق (الناقص ناخذه منه)
R('POST', '/api/purchases/:id/invoice', ({ u, params, body }) => {
  needSup(u);
  const p = get('SELECT * FROM purchases WHERE id = ?', Number(params.id)) || bad('غير موجود');
  const inv = (body.lines || []).filter(l => l.item_id && Number(l.qty) >= 0).map(l => ({ item_id: Number(l.item_id), qty: Number(l.qty), unit_price: Number(l.unit_price) || 0 }));
  if (!inv.length) bad('وش في الحساب؟');
  const cmp = RCV.compare(p.id, inv);
  const total = Number(body.total) > 0 ? C.r2(Number(body.total)) : C.r2(inv.reduce((s, l) => s + l.qty * l.unit_price, 0));
  tx(() => {
    const bal = C.warehouseBalances();
    for (const l of inv) {
      const lines = all('SELECT id, qty FROM purchase_lines WHERE purchase_id = ? AND item_id = ?', p.id, l.item_id);
      for (const pl of lines) run("UPDATE purchase_lines SET unit_price = ?, pu_price = CASE WHEN pu_name = '' THEN ? ELSE pu_price END, invoice_qty = ? WHERE id = ?", C.r3(l.unit_price), C.r3(l.unit_price), C.r3(l.qty), pl.id);
      const q = lines.reduce((s, x) => s + x.qty, 0);
      if (l.unit_price > 0 && q > 0) {
        const it = get('SELECT cost FROM items WHERE id = ?', l.item_id), have = Math.max(0, (bal.get(l.item_id) || 0) - q);
        run('UPDATE items SET cost = ? WHERE id = ?', C.r3(have > 0 && it.cost > 0 ? (have * it.cost + q * l.unit_price) / (have + q) : l.unit_price), l.item_id);
      }
    }
    run('UPDATE purchases SET total = ?, awaiting_invoice = 0 WHERE id = ?', total, p.id);
  });
  return { ok: true, total, ...cmp };
});
// ✏️ طريقة الدفع بس (انسجل آجل وهو من العهدة…): لصاحبه أو المشرف — حتى بعد الاعتماد
R('POST', '/api/purchases/:id/payment', ({ u, params, body }) => {
  needPurch(u);
  const p = get('SELECT * FROM purchases WHERE id = ?', Number(params.id)) || bad('غير موجود');
  if (!isSup(u) && p.user_id !== u.id) forbid('تعدّل مشترياتك بس');
  const payment = PAYMENTS.includes(body.payment) ? body.payment : bad('طريقة الدفع غلط');
  if (payment === 'credit' && !p.supplier_id) bad('الآجل لازم له مورد');
  run('UPDATE purchases SET payment = ?, paid_from_cash = ? WHERE id = ?', payment, payment === 'cash' ? 1 : 0, p.id);
  return { ok: true };
});
R('POST', '/api/purchases/:id/approve', ({ u, params, body }) => {
  needSup(u);
  const p = get('SELECT * FROM purchases WHERE id = ?', Number(params.id)) || bad('غير موجود');
  if (body.undo) { needOwner(u); run('UPDATE purchases SET approved_by = NULL, approved_at = NULL WHERE id = ?', p.id); return { ok: true }; }
  run('UPDATE purchases SET approved_by = ?, approved_at = ? WHERE id = ? AND approved_at IS NULL', u.id, nowISO(), p.id);
  return { ok: true };
});
R('POST', '/api/purchases/approve-all', ({ u, body }) => {
  needSup(u);
  const n = run('UPDATE purchases SET approved_by = ?, approved_at = ? WHERE approved_at IS NULL AND date <= ?', u.id, nowISO(), dateOr(body.date)).changes;
  return { ok: true, approved: Number(n) };
});
// الشراء السريع: الأصناف اللي يشتريها كثير (بآخر سعر ووحدة ومورد)، والموردين، وإنجاز اليوم
R('GET', '/api/purchases/quick', ({ u }) => {
  needPurch(u);
  const today = C.businessDate(), from = C.addDays(today, -90);
  const lastOf = new Map();
  for (const l of all(`SELECT l.item_id, l.pu_name, l.pu_price, l.unit_price, l.qty, l.pu_qty, p.supplier, p.date FROM purchase_lines l JOIN purchases p ON p.id = l.purchase_id
      WHERE p.date >= ? ORDER BY p.date, p.id, l.id`, from)) lastOf.set(l.item_id, l);
  const freq = all(`SELECT l.item_id, COUNT(*) AS n FROM purchase_lines l JOIN purchases p ON p.id = l.purchase_id WHERE p.date >= ? GROUP BY l.item_id ORDER BY n DESC LIMIT 24`, from);
  const items = new Map(all("SELECT id, name, unit, daily, pull_on_open, leftover, buy_unit FROM items WHERE active = 1 AND kind = 'raw'").map(i => [i.id, i]));
  const costs = C.itemCostMap();
  const units = all('SELECT item_id, name, factor FROM item_units ORDER BY factor DESC');
  const tile = (id, n) => {
    const i = items.get(id); if (!i) return null;
    const l = lastOf.get(id);
    return { id, name: i.name, unit: i.unit, buy_unit: i.buy_unit, cost: C.r3(costs.get(id) || 0), times: n || 0, units: units.filter(x => x.item_id === id).map(x => ({ name: x.name, factor: x.factor })),
      last: l ? { unit: l.pu_name || '', qty: l.pu_qty ?? l.qty, price: l.pu_price ?? l.unit_price, supplier: l.supplier, date: l.date } : null,
      to_floor: toFloorDefault(i) };
  };
  const top = freq.map(f => tile(f.item_id, f.n)).filter(Boolean);
  // الطازج اليومي (لحوح، كدر، كبان…) دايم فوق حتى لو ما انشرى قبل
  for (const i of items.values()) if (top.length < 16 && i.daily && !top.some(t => t.id === i.id)) top.push(tile(i.id, 0));
  const suppliers = all(`SELECT supplier AS name, COUNT(*) AS n FROM purchases WHERE supplier != '' AND date >= ? GROUP BY supplier ORDER BY n DESC LIMIT 8`, from);
  const mine = all("SELECT date, COUNT(*) AS n, SUM(total) AS t FROM purchases WHERE user_id = ? GROUP BY date ORDER BY date DESC LIMIT 60", u.id);
  let streak = 0;
  for (let d = today, i = 0; i < 60; i++, d = C.addDays(d, -1)) { if (mine.some(m => m.date === d)) streak++; else if (d !== today) break; }
  const t = mine.find(m => m.date === today);
  const cv = custodyView(u.id, { limit: 0 });
  return { items: top, all: [...items.values()].map(i => tile(i.id, 0)), suppliers, today: { count: t ? t.n : 0, total: t ? C.r2(t.t) : 0 }, streak,
    custody: { balance: cv.balance, given: cv.given, spent: cv.spent, has: cv.given > 0 || cv.spent > 0 } };
});

// ===== عهدة الكاش (للمشتري) =====
// الرصيد = اللي أعطيته − اللي رجّعه − المشتريات «من العهدة»
function custodyView(userId, { limit = 200 } = {}) {
  const usr = get('SELECT id, name, role FROM users WHERE id = ?', userId) || bad('الموظف غير موجود');
  const moves = all('SELECT c.*, b.name AS by_name FROM cash_custody c LEFT JOIN users b ON b.id = c.by_user_id WHERE c.user_id = ? ORDER BY c.date, c.id', userId);
  const buys = all("SELECT id, date, supplier, total, image, note, created_at FROM purchases WHERE user_id = ? AND payment = 'custody' ORDER BY date, id", userId);
  const card = all(`SELECT id, date, supplier, total, image, note, created_at FROM purchases WHERE user_id = ? AND payment = 'card'
    UNION ALL SELECT id, date, category AS supplier, amount AS total, image, note, created_at FROM expenses WHERE user_id = ? AND payment = 'card'
    UNION ALL SELECT sp.id, sp.date, 'سداد ' || s.name AS supplier, sp.amount AS total, sp.image, sp.note, sp.created_at FROM supplier_payments sp JOIN suppliers s ON s.id = sp.supplier_id WHERE sp.payer_id = ? AND sp.payment = 'card'
    ORDER BY date DESC LIMIT 60`, userId, userId, userId);
  const supPays = all("SELECT sp.id, sp.date, sp.amount, sp.note, sp.image, sp.created_at, s.name AS supplier FROM supplier_payments sp JOIN suppliers s ON s.id = sp.supplier_id WHERE sp.payer_id = ? AND sp.payment = 'custody' ORDER BY sp.date, sp.id", userId);
  const spends = all("SELECT id, date, amount, category, kind, note, image, created_at FROM expenses WHERE user_id = ? AND payment = 'custody' ORDER BY date, id", userId);
  const given = C.r2(moves.filter(m => m.amount > 0).reduce((s, m) => s + m.amount, 0));
  const returned = C.r2(-moves.filter(m => m.amount < 0).reduce((s, m) => s + m.amount, 0));
  const spent = C.r2(buys.reduce((s, p) => s + p.total, 0) + spends.reduce((s, e) => s + e.amount, 0) + supPays.reduce((s, p) => s + p.amount, 0));
  const entries = [
    ...moves.map(m => ({ kind: m.amount > 0 ? 'give' : 'return', id: m.id, date: m.date, amount: C.r2(Math.abs(m.amount)), note: m.note, by: m.by_name, self: m.by_user_id === userId, confirmed: !!m.confirmed, from_drawer: m.from_drawer, at: m.created_at })),
    ...buys.map(p => ({ kind: 'buy', id: p.id, date: p.date, amount: p.total, note: [p.supplier, p.note].filter(Boolean).join(' — '), image: p.image, no_photo: !p.image, at: p.created_at })),
    ...supPays.map(p => ({ kind: 'supplier', id: p.id, date: p.date, amount: p.amount, note: [p.supplier, p.note].filter(Boolean).join(' — '), image: p.image, no_photo: !p.image, at: p.created_at })),
    ...spends.map(e => ({ kind: 'spend', spend: e.kind, id: e.id, date: e.date, amount: e.amount, note: [e.kind === 'restaurant' ? e.category : '', e.note].filter(Boolean).join(' — '), image: e.image, no_photo: !e.image && e.kind !== 'advance', at: e.created_at })),
  ].sort((a, b) => (a.date + a.at).localeCompare(b.date + b.at));
  let run_ = 0; for (const e of entries) { run_ += e.kind === 'give' ? e.amount : -e.amount; e.balance = C.r2(run_); }
  return { user_id: usr.id, name: usr.name, given, returned, spent, balance: C.r2(given - returned - spent), no_photo: buys.filter(p => !p.image).length + spends.filter(e => !e.image && e.kind !== 'advance').length + supPays.filter(p => !p.image).length,
    spent_buy: C.r2(buys.reduce((s, p) => s + p.total, 0)), spent_other: C.r2(spends.reduce((s, e) => s + e.amount, 0)), spent_suppliers: C.r2(supPays.reduce((s, p) => s + p.amount, 0)),
    unconfirmed: moves.filter(m => !m.confirmed).map(m => ({ id: m.id, date: m.date, amount: C.r2(Math.abs(m.amount)), kind: m.amount > 0 ? 'give' : 'return', note: m.note })),
    card_total_month: C.r2(card.filter(p => p.date.slice(0, 7) === C.businessDate().slice(0, 7)).reduce((s, p) => s + p.total, 0)),
    card: limit ? card.map(p => ({ date: p.date, amount: p.total, note: [p.supplier, p.note].filter(Boolean).join(' — '), image: p.image })) : [],
    entries: entries.slice(-limit).reverse() };
}
R('GET', '/api/custody', ({ u, q }) => {
  const uid = Number(q.user_id) || u.id;
  if (uid !== u.id && !isSup(u)) forbid();
  if (!q.user_id && isSup(u)) // المشرف: كل اللي عندهم عهدة (أو مسؤولين مشتريات)
    return all("SELECT id FROM users WHERE active = 1 AND bot = 0 AND (role = 'purchaser' OR id IN (SELECT user_id FROM cash_custody) OR id IN (SELECT user_id FROM purchases WHERE payment = 'custody') OR id IN (SELECT payer_id FROM supplier_payments WHERE payment = 'custody'))").map(x => custodyView(x.id, { limit: 60 }));
  return custodyView(uid);
});
R('POST', '/api/custody', ({ u, body }) => {
  // المشرف يسجل لأي واحد (متأكد)، والمشتري يسجل لنفسه «استلمت / رجّعت» (يحتاج تأكيد المالك)
  const uid = isSup(u) ? Number(body.user_id) || u.id : u.id;
  if (!isSup(u) && !isPurch(u)) forbid();
  get('SELECT 1 AS x FROM users WHERE id = ?', uid) || bad('اختر الموظف');
  const amount = pos(body.amount, 'المبلغ');
  guardDay(u, dateOr(body.date));
  const sign = body.type === 'return' ? -1 : 1;
  run('INSERT INTO cash_custody(user_id, date, amount, from_drawer, note, by_user_id, confirmed) VALUES(?,?,?,?,?,?,?)', uid, dateOr(body.date), sign * C.r2(amount), body.from_drawer ? 1 : 0, String(body.note || ''), u.id, isSup(u) ? 1 : 0);
  return custodyView(uid);
});
R('POST', '/api/custody/:id/confirm', ({ u, params }) => { needSup(u); run('UPDATE cash_custody SET confirmed = 1 WHERE id = ?', Number(params.id)); return { ok: true }; });
R('DELETE', '/api/custody/:id', ({ u, params }) => { needOwner(u); run('DELETE FROM cash_custody WHERE id = ?', Number(params.id)); return { ok: true }; });

// تصحيح: شراء راح المستودع وهو المفروض يدخل الجرد (أو العكس) — line_id اختياري (وإلا كل الأسطر)
R('POST', '/api/purchases/:id/place', ({ u, params, body }) => {
  needSup(u);
  const p = get('SELECT * FROM purchases WHERE id = ?', Number(params.id)) || bad('غير موجود');
  if (dayClosed(p.date) && !isOwner(u)) forbid('اليوم مقفل');
  const toFloor = body.to_floor ? 1 : 0;
  const lines = all('SELECT * FROM purchase_lines WHERE purchase_id = ?' + (body.line_id ? ' AND id = ?' : ''), p.id, ...(body.line_id ? [Number(body.line_id)] : []));
  tx(() => { for (const l of lines) {
    run('UPDATE purchase_lines SET to_floor = ? WHERE id = ?', toFloor, l.id);
    run('UPDATE moves SET location = ? WHERE ref = ? AND item_id = ? AND type = ?', toFloor ? 'floor' : 'warehouse', 'pu:' + p.id, l.item_id, 'purchase');
  } });
  return { ok: true, lines: lines.length };
});
R('DELETE', '/api/purchases/:id', ({ u, params }) => {
  const p = get('SELECT * FROM purchases WHERE id = ?', Number(params.id)) || bad('غير موجود');
  needPurch(u);
  canEditPurchase(u, p);
  tx(() => { run('DELETE FROM moves WHERE ref = ?', 'pu:' + p.id); run('DELETE FROM purchases WHERE id = ?', p.id); });
  return { ok: true };
});
// جرد المشتريات: كم اشتريت وكم انصرف حسب الوصفات/السحب للفترة
R('GET', '/api/purchases/summary', ({ u, q }) => {
  needPurch(u);
  const from = isDate(q.from) ? q.from : C.addDays(C.businessDate(), -30), to = isDate(q.to) ? q.to : C.businessDate();
  const costs = C.itemCostMap(), bal = C.warehouseBalances();
  return all(`SELECT i.id, i.name, i.unit,
      SUM(CASE WHEN m.type = 'purchase' THEN m.qty ELSE 0 END) AS bought,
      -SUM(CASE WHEN m.type IN ('transfer','prep_use','sale_use','opening_pull') AND m.location = 'warehouse' THEN m.qty ELSE 0 END) AS used,
      SUM(CASE WHEN m.type = 'adjust' THEN m.qty ELSE 0 END) AS adjust,
      (SELECT SUM(pl.qty * pl.unit_price) FROM purchase_lines pl JOIN purchases p ON p.id = pl.purchase_id WHERE pl.item_id = i.id AND p.date BETWEEN ? AND ?) AS spent
    FROM items i JOIN moves m ON m.item_id = i.id AND m.date BETWEEN ? AND ? GROUP BY i.id ORDER BY i.sort`, from, to, from, to)
    .map(r => ({ ...r, bought: C.r3(r.bought), used: C.r3(r.used), adjust: C.r3(r.adjust), spent: C.r2(r.spent), balance: bal.get(r.id) || 0, adjust_value: C.r2(r.adjust * (costs.get(r.id) || 0)) }));
});

// ---- الموردين (الشراء الآجل والسداد) ----
function supplierBalances() {
  const owed = new Map(all("SELECT supplier_id AS id, SUM(total) AS t, MAX(date) AS d FROM purchases WHERE payment = 'credit' AND supplier_id IS NOT NULL GROUP BY supplier_id").map(r => [r.id, r]));
  const paid = new Map(all('SELECT supplier_id AS id, SUM(amount) AS t FROM supplier_payments GROUP BY supplier_id').map(r => [r.id, r.t]));
  const all_ = new Map(all('SELECT supplier_id AS id, SUM(total) AS t FROM purchases WHERE supplier_id IS NOT NULL GROUP BY supplier_id').map(r => [r.id, r.t]));
  return all('SELECT * FROM suppliers ORDER BY active DESC, name').map(s => {
    const o = owed.get(s.id), credit = o ? o.t : 0, pay = paid.get(s.id) || 0;
    return { ...s, credit: C.r2(credit), paid: C.r2(pay), balance: C.r2(credit - pay), total_purchases: C.r2(all_.get(s.id) || 0), last_credit: o ? o.d : null };
  });
}
R('GET', '/api/suppliers', ({ u }) => {
  // كل الموظفين يشوفون الأسماء (عشان يختارون المورد وقت الشراء)، والأرصدة لمسؤول المشتريات والمشرفين
  if (!isPurch(u)) return all('SELECT id, name FROM suppliers WHERE active = 1 ORDER BY name');
  return supplierBalances();
});
R('GET', '/api/suppliers/:id', ({ u, params }) => {
  needPurch(u);
  const id = Number(params.id);
  const s = supplierBalances().find(x => x.id === id) || bad('المورد غير موجود');
  const purchases = all("SELECT p.id, p.date, p.total, p.payment, p.note, p.image, us.name AS user FROM purchases p LEFT JOIN users us ON us.id = p.user_id WHERE p.supplier_id = ? ORDER BY p.date DESC, p.id DESC LIMIT 300", id)
    .map(p => ({ ...p, lines: all('SELECT l.qty, l.unit_price, l.pu_name, l.pu_qty, l.pu_price, i.name AS item, i.unit FROM purchase_lines l LEFT JOIN items i ON i.id = l.item_id WHERE purchase_id = ?', p.id) }));
  const payments = all('SELECT sp.*, us.name AS user, py.name AS payer FROM supplier_payments sp LEFT JOIN users us ON us.id = sp.user_id LEFT JOIN users py ON py.id = sp.payer_id WHERE sp.supplier_id = ? ORDER BY sp.date DESC, sp.id DESC', id);
  // السداد على دفعات: الدفعات تسدد الفواتير الآجلة الأقدم أول
  let pool = payments.reduce((t, p) => t + p.amount, 0);
  const alloc = new Map();
  for (const p of all("SELECT id, total FROM purchases WHERE supplier_id = ? AND payment = 'credit' ORDER BY date, id", id)) {
    const paid = Math.min(pool, p.total); pool -= paid;
    alloc.set(p.id, { paid: C.r2(paid), remaining: C.r2(p.total - paid) });
  }
  for (const p of purchases) if (alloc.has(p.id)) Object.assign(p, alloc.get(p.id));
  return { ...s, purchases, payments };
});
R('POST', '/api/suppliers', ({ u, body }) => {
  needPurch(u);
  const name = String(body.name || '').trim(); if (!name) bad('حط اسم المورد');
  const dup = get('SELECT id FROM suppliers WHERE name = ?', name);
  if (dup && dup.id !== Number(body.id)) bad('المورد موجود من قبل');
  if (body.id) { run('UPDATE suppliers SET name=?, phone=?, note=?, active=? WHERE id=?', name, body.phone || '', body.note || '', body.active === false ? 0 : 1, Number(body.id)); run('UPDATE purchases SET supplier = ? WHERE supplier_id = ?', name, Number(body.id)); return { id: Number(body.id) }; }
  return { id: Number(run('INSERT INTO suppliers(name, phone, note) VALUES(?,?,?)', name, body.phone || '', body.note || '').lastInsertRowid) };
});
R('POST', '/api/suppliers/:id/pay', ({ u, params, body }) => {
  needPurch(u);
  const id = Number(params.id);
  if (!get('SELECT 1 AS x FROM suppliers WHERE id = ?', id)) bad('المورد غير موجود');
  const amount = pos(body.amount, 'المبلغ');
  guardDay(u, dateOr(body.date));
  // مين دفع: المشرف يختار (زكريا، إبراهيم، عمار، خلوف، نوح)، والمشتري هو نفسه
  let payer = u.id;
  if (isSup(u) && body.payer_id) payer = (get("SELECT id FROM users WHERE id = ? AND active = 1 AND bot = 0 AND role IN ('owner', 'supervisor', 'purchaser')", Number(body.payer_id)) || bad('اختر مين دفع')).id;
  let payment = ['cash', 'custody', 'card', 'paid'].includes(body.payment) ? body.payment : (body.paid_from_cash ? 'cash' : 'paid');
  if (!isSup(u) && payment === 'paid') payment = 'custody';
  const image = body.image ? saveImage(body.image) : '';
  run('INSERT INTO supplier_payments(date, supplier_id, amount, paid_from_cash, note, image, user_id, payment, payer_id) VALUES(?,?,?,?,?,?,?,?,?)',
    dateOr(body.date), id, amount, payment === 'cash' ? 1 : 0, body.note || '', image, u.id, payment, payer);
  return { ok: true };
});
R('DELETE', '/api/supplier-payments/:id', ({ u, params }) => {
  needSup(u);
  const sp = get('SELECT date FROM supplier_payments WHERE id = ?', Number(params.id));
  if (sp) guardDay(u, sp.date);
  run('DELETE FROM supplier_payments WHERE id = ?', Number(params.id)); return { ok: true };
});

// ---- المصروفات ----
R('GET', '/api/expenses', ({ u, q }) => {
  needSup(u);
  const from = isDate(q.from) ? q.from : C.addDays(C.businessDate(), -30), to = isDate(q.to) ? q.to : C.businessDate();
  return all('SELECT e.*, us.name AS user FROM expenses e LEFT JOIN users us ON us.id = e.user_id WHERE date BETWEEN ? AND ? ORDER BY date DESC, id DESC', from, to);
});
// الصرف: المشرف (أي طريقة)، والمشتري (من عهدته أو البطاقة). «سلفة لموظف» تنكتب في رواتبه كسحب
const EXP_KINDS = ['restaurant', 'home', 'advance'];
R('POST', '/api/expenses', ({ u, body }) => {
  if (!isSup(u) && !isPurch(u)) forbid();
  const image = body.image ? saveImage(body.image) : '';
  const amount = String(body.amount ?? '').trim() === '' && image ? 0 : pos(body.amount, 'المبلغ');
  const kind = EXP_KINDS.includes(body.kind) ? body.kind : 'restaurant';
  if (kind === 'advance' && !isSup(u)) forbid('السلفة للمشرف');
  let payment = ['cash', 'custody', 'card', 'paid'].includes(body.payment) ? body.payment : (body.paid_from_cash === false ? 'paid' : 'cash');
  if (!isSup(u) && !['custody', 'card'].includes(payment)) payment = 'custody';
  if (payment === 'custody' && !amount) bad('اكتب المبلغ — عشان ينخصم من العهدة');
  const date = dateOr(body.date); guardDay(u, date);
  return tx(() => {
    let payrollId = null, note = String(body.note || '');
    if (kind === 'advance') {
      const emp = get('SELECT id, name FROM users WHERE id = ? AND active = 1', Number(body.employee_id)) || bad('اختر الموظف');
      if (!amount) bad('اكتب المبلغ');
      if (emp.id === u.id && !isOwner(u)) forbid('ما تسجل سلفة لنفسك');
      payrollId = Number(run("INSERT INTO payroll(user_id, date, type, amount, note, month) VALUES(?,?,'advance',?,?,'')", emp.id, date, amount, `سلفة — أعطاه ${u.name}${note ? ' — ' + note : ''}`).lastInsertRowid);
      note = `سلفة ${emp.name}${note ? ' — ' + note : ''}`;
    }
    const category = kind === 'home' ? 'خاص' : kind === 'advance' ? 'سلفة موظف' : (body.category || '');
    return { id: Number(run('INSERT INTO expenses(date, user_id, amount, category, note, image, paid_from_cash, kind, payment, payroll_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
      date, u.id, amount, category, note, image, payment === 'cash' ? 1 : 0, kind, payment, payrollId).lastInsertRowid) };
  });
});
R('PATCH', '/api/expenses/:id', ({ u, params, body }) => {
  needSup(u);
  const e = get('SELECT * FROM expenses WHERE id = ?', Number(params.id)) || bad('غير موجود');
  guardDay(u, e.date);
  if (body.amount === undefined && ['restaurant', 'home'].includes(body.kind)) { // المالك يصنّف المصروف: للمطعم ولا خاص
    run("UPDATE expenses SET kind = ? WHERE id = ? AND kind != 'advance'", body.kind, e.id); return { ok: true };
  }
  const amount = pos(body.amount, 'المبلغ');
  tx(() => {
    run('UPDATE expenses SET amount = ?, note = ?, category = ? WHERE id = ?', amount, body.note || '', body.category || '', e.id);
    if (e.payroll_id) run('UPDATE payroll SET amount = ? WHERE id = ?', amount, e.payroll_id); // السلفة المربوطة تتعدل معه
  });
  return { ok: true };
});
R('DELETE', '/api/expenses/:id', ({ u, params }) => {
  needSup(u);
  const e = get('SELECT payroll_id, date FROM expenses WHERE id = ?', Number(params.id));
  if (e) guardDay(u, e.date);
  tx(() => { if (e && e.payroll_id) run('DELETE FROM payroll WHERE id = ?', e.payroll_id); run('DELETE FROM expenses WHERE id = ?', Number(params.id)); });
  return { ok: true };
});

// ---- الرواتب والسحبيات (المالك) ----
R('GET', '/api/payroll', ({ u }) => { needOwner(u); return payrollView(); });
R('POST', '/api/payroll', ({ u, body }) => {
  needOwner(u);
  const type = ['salary', 'advance', 'settle', 'bonus', 'deduct'].includes(body.type) ? body.type : 'advance';
  const uid = Number(body.user_id);
  let amount = Number(body.amount);
  if (type === 'settle' && !amount) { // صرف الباقي كله (سفر)
    amount = payrollView().find(x => x.id === uid)?.balance || 0;
    if (amount <= 0) bad('ما له باقي');
  }
  if (!(amount > 0)) bad('حط المبلغ (أكبر من صفر)');
  get('SELECT 1 AS x FROM users WHERE id = ?', uid) || bad('اختر الموظف');
  const date = dateOr(body.date);
  run('INSERT INTO payroll(user_id, date, type, amount, note, month) VALUES(?,?,?,?,?,?)', uid, date, type, amount, body.note || '', type === 'salary' ? (body.month || date.slice(0, 7)) : '');
  return { ok: true };
});
R('DELETE', '/api/payroll/:id', ({ u, params }) => { needOwner(u); run('DELETE FROM payroll WHERE id = ?', Number(params.id)); return { ok: true }; });

// ---- الإعدادات والمزامنة ----
const SETTING_KEYS = ['site_url', 'wa_count_bot', 'wa_count_bot_users', 'loyverse_token', 'anthropic_key', 'day_start_hour', 'sync_days_back', 'opening_deadline_hour', 'restaurant_name', 'ticket_in_cash', 'ticket_tolerance', 'ai_monthly_cap', 'seasons', 'max_food_cost', 'ai_user_daily', 'wa_token', 'wa_phone_id', 'wa_app_secret', 'wa_verify_token', 'wa_mode', 'wa_nudge', 'wa_req_times', 'stt_key', 'stt_model', 'wa_pinch', 'wa_pinch_max', 'wa_chase', 'wa_chase_record', 'wa_chase_min', 'wa_close_hour', 'wa_chase_open_hour', 'wa_owner_remind_after', 'wa_chase_notify', 'auto_approve', 'sales_from_printer'];
R('GET', '/api/settings', ({ u }) => {
  needOwner(u);
  const s = {}; for (const k of SETTING_KEYS) s[k] = getSetting(k);
  for (const k of ['loyverse_token', 'anthropic_key', 'wa_token', 'wa_app_secret', 'stt_key']) s[k] = s[k] ? '••••' + s[k].slice(-4) : '';
  s.last_receipt_sync = getSetting('last_receipt_sync');
  // تكلفة قراءة التذاكر هالشهر (تقريبية، بالدولار)
  s.ocr_cost_month = Math.round((get("SELECT SUM(ocr_cost) AS c FROM tickets WHERE created_at >= date('now', 'start of month')").c || 0) * 100) / 100;
  s.ai_cost_month = Math.round((get("SELECT SUM(cost) AS c FROM ai_log WHERE at >= date('now', 'start of month')").c || 0) * 100) / 100;
  s.ai_monthly_cap = getSetting('ai_monthly_cap', '20');
  s.max_food_cost = getSetting('max_food_cost', '35');
  s.ai_user_daily = getSetting('ai_user_daily', '100');
  s.history_from = get('SELECT MIN(date) AS d FROM sales').d || '';
  s.log = all('SELECT * FROM sync_log ORDER BY id DESC LIMIT 20');
  return s;
});
// ---- مفتاح Claude (المساعد) ----
// المالك يسوي المفتاح ويحطه في إعدادات بيئة Claude (مو في المحادثة). Claude يشوف كل شي ويضيف الوصفات،
// وكل شي يسويه ينكتب باسم «Claude (المساعد)». «إلغاء المفتاح» يقفله على طول.
const CLAUDE = 'Claude (المساعد)';
R('GET', '/api/settings/claude-key', ({ u }) => {
  needOwner(u);
  const b = get('SELECT id, active, role FROM users WHERE bot = 1 LIMIT 1');
  return { active: !!(b && b.active && get('SELECT 1 AS x FROM sessions WHERE user_id = ?', b.id)), owner: !!(b && b.role === 'owner') };
});
// 👑 صلاحية Claude: مشرف (الأصل) أو مالك — المالك بس يغيّرها، والمفتاح يبقى نفسه
R('PUT', '/api/settings/claude-role', ({ u, body }) => {
  needOwner(u); if (u.bot) forbid('هذي للمالك بس');
  const b = get('SELECT id FROM users WHERE bot = 1 LIMIT 1') || bad('سوّ مفتاح لـ Claude أول');
  run('UPDATE users SET role = ? WHERE id = ?', body.owner ? 'owner' : 'supervisor', b.id);
  return { ok: true, owner: !!body.owner };
});
R('POST', '/api/settings/claude-key', ({ u }) => {
  needOwner(u);
  let b = get('SELECT id FROM users WHERE bot = 1 LIMIT 1');
  if (!b) b = { id: Number(run("INSERT INTO users(name, role, pin, bot) VALUES(?, 'supervisor', ?, 1)", CLAUDE, crypto.randomBytes(8).toString('hex')).lastInsertRowid) };
  run("UPDATE users SET active = 1, role = CASE WHEN role = 'owner' THEN 'owner' ELSE 'supervisor' END, no_sales = 0, no_recipes = 0 WHERE id = ?", b.id);
  run('DELETE FROM sessions WHERE user_id = ?', b.id); // المفتاح القديم يبطل
  const token = 'cl_' + crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions(token, user_id) VALUES(?,?)', token, b.id);
  return { token };
});
R('DELETE', '/api/settings/claude-key', ({ u }) => {
  needOwner(u);
  const b = get('SELECT id FROM users WHERE bot = 1 LIMIT 1');
  if (b) { run('DELETE FROM sessions WHERE user_id = ?', b.id); run('UPDATE users SET active = 0 WHERE id = ?', b.id); }
  return { ok: true };
});
// ملاحظات النظام (القواعد اللي اتفقنا عليها): في قاعدة البيانات بس — مو في GitHub، وما لها صفحة.
// يقرأها ويكتبها المالك وClaude بس
R('GET', '/api/system-notes', ({ u }) => { if (!isOwner(u) && !u.bot) forbid(); return get("SELECT body, updated_at FROM private_notes WHERE key = 'system'") || { body: '', updated_at: null }; });
R('PUT', '/api/system-notes', ({ u, body }) => {
  if (!isOwner(u) && !u.bot) forbid();
  run("INSERT INTO private_notes(key, body, updated_at) VALUES('system', ?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at", String(body.body || ''), nowISO());
  return { ok: true };
});
R('POST', '/api/settings', ({ u, body }) => {
  needOwner(u);
  let tokenChanged = false;
  if (body.seasons != null) {
    const list = typeof body.seasons === 'string' ? C.safeJSON(body.seasons, null) : body.seasons;
    if (!Array.isArray(list)) bad('المواسم غير صحيحة');
    body.seasons = JSON.stringify(list.filter(x => x && String(x.name || '').trim() && isDate(x.from)).map(x => ({ name: String(x.name).trim(), from: x.from, to: isDate(x.to) ? x.to : x.from, factor: Number(x.factor) > 0 ? Number(x.factor) : 1 })));
  }
  for (const k of SETTING_KEYS) if (body[k] != null && !String(body[k]).startsWith('••••')) {
    if (k === 'loyverse_token' && body[k] !== getSetting(k)) tokenChanged = true;
    setSetting(k, String(body[k]).trim());
  }
  if (tokenChanged) { setSetting('last_receipt_sync', ''); L.syncAll({ full: true }); }
  return { ok: true };
});
R('POST', '/api/sync', async ({ u, body }) => {
  needSup(u);
  // سجل طويل (سنة): يشتغل بالخلفية — النتيجة تطلع في «سجل السحب»
  if (Number(body.days) > 0) { L.syncAll({ full: true, days: Math.min(730, Number(body.days)) }); return { ok: true, message: 'بدأ سحب السجل — ياخذ دقايق، شيك «سجل السحب» بعدين' }; }
  return await L.syncAll({ full: !!body.full });
});

// ---- الذكاء الاصطناعي: اسأل المساعد، ملخص اليوم، توصيات بكرة ----
// للمالك والمشرفين اللي يشوفون المبيعات بس
// كل موظف يكلمه — والأدوات حسب صلاحياته (العامل جرده، زكريا مشترياته، والمبيعات لمن له صلاحية)
R('POST', '/api/assistant', async ({ u, body }) => (u.role === 'worker' ? forbid('المساعد للمشرفين والمشتريات') : null) || await AS.ask(u, body.question, body.history, { detailed: !!body.detailed, images: body.images }));
// التذكيرات (كل واحد لنفسه)
R('GET', '/api/reminders', ({ u }) => all('SELECT * FROM reminders WHERE user_id = ? AND done = 0 ORDER BY due_date, id', u.id));
R('POST', '/api/reminders', ({ u, body }) => {
  const text = String(body.text || '').trim().slice(0, 300); if (!text) bad('وش التذكير؟');
  return { id: Number(run('INSERT INTO reminders(user_id, text, due_date) VALUES(?,?,?)', u.id, text, dateOr(body.due_date)).lastInsertRowid) };
});
R('POST', '/api/reminders/:id/done', ({ u, params }) => { run('UPDATE reminders SET done = 1 WHERE id = ? AND user_id = ?', Number(params.id), u.id); return { ok: true }; });
R('GET', '/api/assistant/saved', ({ u, q }) => {
  needSales(u);
  const kind = q.kind === 'reco' ? 'reco' : 'summary';
  const date = isDate(q.date) ? q.date : (kind === 'reco' ? C.addDays(C.businessDate(), 1) : C.businessDate());
  return { date, kind, saved: AS.saved(date, kind), has_ai: !!AI.apiKey(), spent: C.r2(AI.monthSpent()), cap: AI.cap() };
});
R('POST', '/api/assistant/summary', async ({ u, body }) => { needSales(u); return await AS.summary(u, dateOr(body.date), { refresh: !!body.refresh }); });
R('POST', '/api/assistant/reco', async ({ u, body }) => { needSales(u); return await AS.recommendations(u, isDate(body.date) ? body.date : C.addDays(C.businessDate(), 1), { refresh: !!body.refresh }); });
R('GET', '/api/forecast', ({ u, q }) => { needSales(u); return F.forecast(isDate(q.date) ? q.date : C.addDays(C.businessDate(), 1)); });
// ---- التحليلات (حساب بس) ----
R('POST', '/api/purchases/read', async ({ u, body }) => { needPurch(u); return await readInvoice(u, body.images); });
// «📄 ورقة المصاريف» المكتوبة باليد: يقرأ ويفرز (شراء / مصروف / سداد مورد) — مسودة، الحفظ من المسارات العادية
R('POST', '/api/sheet/read', async ({ u, body }) => { needSales(u); return await readSheet(u, body.images, body.date); }); // يدخلها المشرفين والمالك (فيها دخل اليوم)
R('GET', '/api/prices', ({ u }) => { needPurch(u); return IN.purchasePrices(C.businessDate()); });
R('GET', '/api/menu-profit', ({ u }) => { needRecipes(u); return IN.menuProfit(C.businessDate()); });
R('GET', '/api/recipe-suggestions', ({ u }) => { needRecipes(u); return IN.recipeSuggestions(C.businessDate()); });
// يطبّق الاقتراح: كل وصفة تاخذ من الصنف تتضرب في النسبة
R('POST', '/api/recipe-suggestions/apply', ({ u, body }) => {
  needRecipes(u);
  const item = Number(body.item_id), f = Number(body.factor);
  if (!item || !(f > 0.5 && f < 2)) bad('النسبة غير صحيحة');
  tx(() => { for (const l of all('SELECT id, qty FROM recipe_lines WHERE item_id = ?', item)) run('UPDATE recipe_lines SET qty = ? WHERE id = ?', C.r3(l.qty * f), l.id); });
  recomputeRecent();
  return { ok: true };
});
R('GET', '/api/shortage-month', ({ u, q }) => { needSales(u); return IN.monthShortage(/^\d{4}-\d{2}$/.test(q.month || '') ? q.month : C.businessDate().slice(0, 7), C.businessDate()); });
// ---- تقرير الشهر للمحاسب (المالك — فيه الرواتب) ----
const monthOr = m => (/^\d{4}-\d{2}$/.test(m || '') ? m : C.businessDate().slice(0, 7));
// فترة: من تاريخ لتاريخ (لازم «من» قبل «إلى»، وما تتعدى سنة)
const rangeOf = q => {
  if (!isDate(q.from) || !isDate(q.to)) return null;
  if (q.from > q.to) bad('«من» لازم قبل «إلى»');
  if (C.addDays(q.from, 370) < q.to) bad('الفترة طويلة — أقصى شي سنة');
  return { from: q.from, to: q.to };
};
// ---- 📱 الواتساب ----
// المالك + حساب Claude (نوح طلب: «اعطي نفسك صلاحية») — الواتساب بس: الإرسال والقروبات والأرقام والحالة. المفاتيح والرواتب للمالك بس
const needWa = u => { if (!isOwner(u) && !u.bot) forbid('هذي للمالك بس'); };
// تنفيذ كرت المساعد باسم الموظف: نفس المسار ونفس الصلاحيات (زي زر «تأكيد» في البرنامج)
const runAs = async (u, endpoint, body) => {
  const route = routes.find(r => r.method === 'POST' && r.re.test(endpoint));
  if (!route || route.public) bad('ما أقدر أسجل هذا');
  return await route.handler({ u, body, params: route.re.exec(endpoint).groups || {}, q: {}, req: null, res: null, token: null });
};
const wa = WA.makeWhatsApp({ runAs });
R('GET', '/api/whatsapp', ({ q }) => ({ __text: wa.verify(q) }), { public: true });
R('POST', '/api/whatsapp', ({ req, body }) => { wa.receive(body, req.headers['x-hub-signature-256']); return { ok: true }; }, { public: true, raw: true });
// 💬 محادثة موظف (المالك/حساب المساعد): داخل وطالع
// 🔊 المساعد يرد على الموظف بالصوت كمان (للي ما يقرأ) — المالك/حساب المساعد
R('POST', '/api/users/:id/voice', ({ u, params, body }) => { needWa(u); run('UPDATE users SET voice_reply = ? WHERE id = ? AND bot = 0', body.on ? 1 : 0, Number(params.id)); return { ok: true }; });
R('GET', '/api/whatsapp/chat', ({ u, q }) => {
  needWa(u);
  const days = Math.min(60, Math.max(1, Number(q.days) || 7));
  const w = get('SELECT id, phone FROM users WHERE id = ?', Number(q.user_id)) || bad('الموظف غير موجود');
  const ph = w.phone ? WA.normPhone(w.phone) : '-';
  return all(`SELECT l.dir, l.text, l.at FROM wa_log l WHERE (l.user_id = ? OR l.phone = ?) AND l.at >= datetime('now', ?) ORDER BY l.id`, w.id, ph, `-${days} days`);
});
R('GET', '/api/whatsapp/status', ({ u }) => {
  needWa(u);
  return { ready: wa.ready(), mode: wa.mode(), has_secret: !!getSetting('wa_app_secret'), has_verify: !!getSetting('wa_verify_token'),
    users: all("SELECT id, name, phone, role FROM users WHERE bot = 0 AND active = 1 AND phone != '' ORDER BY id"),
    log: all('SELECT l.dir, l.phone, l.text, l.at, u.name FROM wa_log l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT 60') };
});
// للاختبارات بس: رسالة كأنها جت من الرقم المربوط (قروب أو خاص) — ما يشتغل إلا بمتغيّر البيئة
if (process.env.WA_TEST_INJECT) R('GET', '/api/whatsapp/_outbox', ({ u }) => { needOwner(u); return WA.LINK.outbox; });
if (process.env.WA_TEST_INJECT) R('POST', '/api/whatsapp/_remind', async ({ u }) => { needOwner(u); run("UPDATE wa_pending SET created_at = datetime(created_at, '-30 minutes')"); run("UPDATE wa_log SET at = datetime(at, '-30 minutes') WHERE at >= datetime('now', '-5 minutes')"); return { sent: await wa.remindPending() }; });
if (process.env.WA_TEST_INJECT) R('POST', '/api/whatsapp/_inject', async ({ u, body }) => { needOwner(u); await wa.dispatch({ type: 'text', isGroup: false, groupName: '', ...body, phone: WA.normPhone(body.phone), ...(body.audio_b64 ? { type: 'audio', audio: async () => Buffer.from(body.audio_b64, 'base64'), mime: 'audio/ogg', seconds: 5 } : {}),
  ...(body.image_b64 ? { type: 'image', image: async () => 'data:image/jpeg;base64,' + body.image_b64 } : {}), ...(body.pdf_b64 ? { type: 'pdf', pdf: async () => 'data:application/pdf;base64,' + body.pdf_b64 } : {}) }); return { ok: true }; });
// ربط رقم كجهاز مرتبط (QR) + القروبات
R('GET', '/api/whatsapp/link', async ({ u }) => {
  needWa(u);
  const g = (() => { try { return JSON.parse(getSetting('wa_groups') || '{}'); } catch { return {}; } })();
  let groups = []; try { groups = await WA.LINK.listGroups(); } catch { /* */ }
  return { mode: wa.mode(), ...WA.LINK.status(), groups: groups.map(x => ({ ...x, role: g[x.id] || '' })), saved: g,
    req_pending: all('SELECT item, qty, by_name FROM wa_requests WHERE sent_at IS NULL ORDER BY id'), req_times: getSetting('wa_req_times', '10,16') };
});
R('POST', '/api/whatsapp/link', async ({ u, body }) => {
  needOwner(u);
  if (body.action === 'logout') { await WA.LINK.logout(); return { ok: true }; }
  setSetting('wa_mode', 'link');
  WA.LINK.start().catch(e => console.error('wa_link', e.message));
  return { ok: true };
});
// 📲 سحب الأرقام من جروب المطعم: كل عضو + الموظف المقترح (بالاسم)
R('GET', '/api/whatsapp/members', async ({ u, q }) => {
  needWa(u);
  const jid = q.group || require('./wa_nudge').restaurantGroup();
  if (!jid) bad('اختر «جروب المطعم» من القروبات أول');
  const staff = all('SELECT id, name, phone FROM users WHERE active = 1 AND bot = 0 ORDER BY id');
  const members = (await WA.LINK.groupMembers(jid)).map(m => {
    const phone = WA.normPhone(m.phone), owner = staff.find(x => x.phone === phone);
    const sug = !owner && m.name ? AS.resolveItem(m.name, staff.filter(x => !x.phone)) : null;
    return { phone, name: m.name, user_id: owner ? owner.id : null, suggest: sug && sug.item ? sug.item.id : null };
  });
  return { members, staff: staff.map(x => ({ id: x.id, name: x.name, phone: x.phone })) };
});
R('POST', '/api/whatsapp/members', ({ u, body }) => {
  needWa(u);
  const saved = [], failed = [], used = new Set();
  for (const l of Array.isArray(body.links) ? body.links : []) {
    const id = Number(l.user_id), phone = WA.normPhone(l.phone), who = get('SELECT name FROM users WHERE id = ? AND bot = 0', id);
    if (!who || !/^\d{9,15}$/.test(phone)) { failed.push(`${l.phone}: غير صحيح`); continue; }
    if (used.has(id)) { failed.push(`${phone}: ${who.name} اختاريته لرقمين`); continue; }
    used.add(id);
    const other = get('SELECT name FROM users WHERE phone = ? AND id != ?', phone, id);
    if (other) { failed.push(`${phone}: مسجل لـ${other.name}`); continue; }
    run('UPDATE users SET phone = ? WHERE id = ?', phone, id); saved.push(who.name);
  }
  return { saved, failed };
});
R('POST', '/api/whatsapp/groups', ({ u, body }) => {
  needWa(u);
  const out = {};
  for (const x of Array.isArray(body.groups) ? body.groups : []) if (/@g\.us$/.test(String(x.id)) && ['restaurant', 'daily'].includes(x.role)) out[x.id] = x.role;
  setSetting('wa_groups', JSON.stringify(out));
  return { groups: out };
});
// 📣 تنبيهات القروب: «جرّب الحين» (force) أو التشغيل العادي
const NUDGE = require('./wa_nudge');
R('POST', '/api/whatsapp/nudge', async ({ u, body }) => {
  needWa(u);
  if (!NUDGE.restaurantGroup()) bad('اختر «جروب المطعم» من القروبات أول');
  const sent = await NUDGE.nudge(wa.sendGroupText, { force: !!body.force, sendPrivate: wa.sendText });
  return { sent };
});
R('POST', '/api/whatsapp/requests/send', async ({ u }) => { needWa(u); return (await wa.flushRequests({ force: true })) || { items: 0, told: [] }; });
// 🛠️ مشاكل الشغل + التقرير الأسبوعي
const ISS = require('./wa_issues');
async function weeklyReport({ force = false } = {}) {
  const today = C.businessDate();
  if (!force) {
    if (new Date(today + 'T00:00:00Z').getUTCDay() !== 4 || C.riyadhHour() < 22) return null; // الخميس ١٠ بالليل
    if (get('SELECT 1 AS x FROM wa_nudges WHERE date = ? AND key = ?', today, 'weekly')) return null;
    run('INSERT INTO wa_nudges(date, key) VALUES(?,?)', today, 'weekly');
  }
  const w = ISS.weekly(today), sent = [];
  // 🔁 «وش تعلمت هالأسبوع» => اقتراحات للدليل (تطلع تحت مع اللي ينتظر)
  try { await KB.weeklyReview(); } catch (e) { console.error('kb review', e.message); }
  const pend = require('./suggestions').list('pending'), feats = require('./suggestions').list('approved').filter(x => x.kind === 'feature');
  const autoDone = require('./suggestions').listSince(w.from).filter(x => x.status === 'done');
  const text = `📊 تقرير الأسبوع (${w.from} ← ${today})\n\n${w.report.length ? 'المشاكل:\n' + w.report.join('\n') : 'ما اتسجلت مشاكل 👌'}${w.stars.length ? `\n\n👏 الملتزمين: ${w.stars.join('، ')}` : ''}`
    + (pend.length ? `\n\n💡 اقتراحات تنتظر ردك:\n${pend.slice(0, 10).map(x => `#${x.id} ${x.by_name || ''}: ${x.summary}`).join('\n')}\n(رد «موافق رقم» أو «ارفض رقم»)` : '')
    + (autoDone.length ? `\n\n✅ اتنفذ لحاله هالأسبوع (${autoDone.length}):\n${autoDone.slice(-15).map(x => `#${x.id} ${x.by_name || ''}: ${x.summary}`).join('\n')}\n(تبغى ترجّع واحد؟ «رجّع رقم»)` : '')
    + (feats.length ? `\n\n🛠️ تطويرات وافقت عليها (للبرمجة):\n${feats.slice(0, 10).map(x => `• ${x.summary}`).join('\n')}` : '');
  for (const o of all("SELECT phone FROM users WHERE role = 'owner' AND active = 1 AND bot = 0 AND phone != ''")) { await wa.sendText(o.phone, text); sent.push(text); }
  const g = NUDGE.restaurantGroup();
  if (g && w.stars.length) { const t = `👏 ما شاء الله تبارك الله: ${w.stars.join('، ')} — جرودكم هالأسبوع كلها في وقتها وبدون نقص. الله يعطيكم العافية 🌹`; await wa.sendGroupText(g, t); sent.push(t); }
  return { ...w, sent };
}
R('POST', '/api/whatsapp/weekly', async ({ u }) => { needWa(u); return await weeklyReport({ force: true }); });
// تسجيل «ما جرد» كمشكلة باسم المالك (يمشي على التذكير/التنبيه/القرصة)
const chaseNow = (opts = {}) => NUDGE.chase({ sendPrivate: wa.sendText, sendGroup: wa.sendGroupText, ...opts,
  zero: async (itemId, phase, date, qty = 0) => { const o = get("SELECT * FROM users WHERE role = 'owner' AND active = 1 AND bot = 0 ORDER BY id LIMIT 1"); if (o) await runAs(o, '/api/count', { date, item_id: itemId, phase, qty }); },
  record: async (w, items) => {
  const owner = get("SELECT * FROM users WHERE role = 'owner' AND active = 1 AND bot = 0 ORDER BY id LIMIT 1");
  if (!owner) return;
  await ISS.record([{ type: 'count', employee: w.name, summary: `ما دخّل جرده بعد ٣ تذكيرات: ${items.slice(0, 8).join('، ')}` }],
    { by: owner, chat: 'system', staff: all('SELECT id, name, phone, role FROM users WHERE active = 1 AND bot = 0'), send: wa.sendText });
} });
R('POST', '/api/whatsapp/chase', async ({ u, body }) => { needWa(u); return { sent: await chaseNow({ force: true, now: process.env.WA_TEST_INJECT && body.at ? new Date(body.at) : undefined }) }; });
// 📘 دليل المطعم: المشرفين يقرون، والمالك يضيف/يعدّل/يحذف — والمساعد يتعلم منه
const KB = require('./kb'); KB.seed(); KB.seed2(); KB.seed3(); KB.seed4(); KB.seed5(); KB.seed6();
// حد أسئلة العامل: ٤٠ كان قليل (محمد وقف في نص جرده) — مرة وحدة يصير ١٠٠
// 🖨️ المبيعات من أوراق الطابعة من 2026-10-13 (أول يوم فيه أوراق) — مرة وحدة، وبعدها نعيد حساب الأيام
if (!getSetting('sales_from_printer') && get("SELECT 1 AS x FROM printer_orders WHERE date >= '2026-10-13' LIMIT 1")) setSetting('sales_from_printer', '2026-10-13');
if (getSetting('sales_from_printer') && getSetting('sales_printer_synced') !== getSetting('sales_from_printer')) {
  for (const r of all('SELECT DISTINCT date FROM printer_orders WHERE date >= ? ORDER BY date', getSetting('sales_from_printer'))) try { PR.syncSales(r.date); } catch (e) { console.error('printer sales', r.date, e.message); }
  setSetting('sales_printer_synced', getSetting('sales_from_printer'));
}
if (!getSetting('ai_cap_v2')) { if (getSetting('ai_user_daily') === '40') setSetting('ai_user_daily', '100'); setSetting('ai_cap_v2', '1'); }
R('GET', '/api/kb', ({ u }) => { if (!isSup(u)) forbid(); return { topics: KB.TOPICS, rows: KB.list(), generated: KB.generated() }; });
R('POST', '/api/kb', ({ u, body }) => { needOwner(u); return { id: KB.add({ topic: body.topic, text: body.text, by: u.id, source: 'owner', replaces: body.replaces || null }) }; });
R('DELETE', '/api/kb/:id', ({ u, params }) => { needOwner(u); run('UPDATE kb SET active = 0 WHERE id = ?', Number(params.id)); return { ok: true }; });
R('POST', '/api/kb/review', async ({ u }) => { needOwner(u); return await KB.weeklyReview(); });
// 💡 الاقتراحات: المالك يشوفها ويوافق/يرفض (نفس «موافق 3» في الواتساب)
const SG = require('./suggestions');
R('GET', '/api/suggestions', ({ u, q }) => { needOwner(u); return { kinds: SG.KIND, rows: SG.list(q.status || '') }; });
R('POST', '/api/suggestions/:id', async ({ u, params, body }) => { needOwner(u); return await SG.decide(Number(params.id), !!body.approve, u, runAs); });
R('GET', '/api/issues', ({ u, q }) => {
  needSales(u);
  const from = isDate(q.from) ? q.from : C.addDays(C.businessDate(), -30);
  return { types: ISS.TYPES, rows: all(`SELECT i.*, w.name AS employee, b.name AS by_name FROM wa_issues i LEFT JOIN users w ON w.id = i.user_id LEFT JOIN users b ON b.id = i.by_id WHERE i.date >= ? ORDER BY i.id DESC LIMIT 300`, from) };
});
// 📢 رسالة للكل: جروب المطعم + كل موظف مسجل في الخاص (بفاصل بين الرسايل — مو ورا بعض)
R('POST', '/api/whatsapp/broadcast', async ({ u, body }) => {
  needWa(u);
  const text = String(body.text || '').trim().slice(0, 4000); if (!text) bad('اكتب الرسالة');
  if (wa.mode() !== 'link' || !wa.ready()) bad('اربط الرقم أول (الإعدادات ← الواتساب)');
  // user_ids: لموظفين معيّنين في الخاص بس (بدون القروب)
  const ids = Array.isArray(body.user_ids) ? body.user_ids.map(Number).filter(Boolean) : null;
  const g = !ids && body.group !== false ? NUDGE.restaurantGroup() : null;
  if (!ids && body.group !== false && !g) bad('اختر «جروب المطعم» من القروبات أول');
  const people = ids ? ids.map(id => get("SELECT name, phone FROM users WHERE id = ? AND active = 1 AND bot = 0", id) || bad('الموظف غير موجود'))
    : body.private !== false ? all("SELECT name, phone FROM users WHERE active = 1 AND bot = 0 AND phone != '' AND id != ?", u.id) : [];
  if (ids) { const no = people.filter(p => !p.phone); if (no.length) bad(`ما له جوال مسجل: ${no.map(p => p.name).join('، ')}`); }
  // 🔊 صوت كمان: يتولّد مرة وحدة — ولو فشل تروح الكتابة بس
  let audio = null, voiceError = null;
  if (body.voice) { try { audio = await require('./tts').speak(text, u.id); } catch (e) { voiceError = e.message; } }
  // 🖼️ صورة شرح (data:image/… base64) تنرسل قبل الكتابة
  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image || ''));
  if (body.image && !m) bad('الصورة لازم data:image base64');
  const img = m ? Buffer.from(m[2], 'base64') : null;
  if (img && img.length > 5e6) bad('الصورة كبيرة');
  if (g) { if (img) try { await WA.LINK.sendImage(g, img); } catch (e) { console.error('broadcast image', e.message); } if (audio) try { await WA.LINK.sendVoice(g, audio); } catch (e) { console.error('broadcast voice', e.message); } await wa.sendGroupText(g, text); }
  // الخاص بالخلفية: ٤ ثواني بين كل واحد عشان الرقم ما ينحظر
  (async () => { for (const p of people) { try { if (img) await WA.LINK.sendImage(p.phone, img); if (audio) await WA.LINK.sendVoice(p.phone, audio); await wa.sendText(p.phone, text); } catch (e) { console.error('broadcast', p.name, e.message); } if (!process.env.WA_TEST_INJECT) await new Promise(r => setTimeout(r, 4000)); } })();
  return { group: !!g, private: people.map(p => p.name), voice: !!audio, image: !!img, ...(voiceError ? { voice_error: voiceError } : {}) };
});
// 📩 المشرف/المالك يرسل رسالة في الخاص لموظفين (تذكير الجرد…) — من كرت المساعد
R('POST', '/api/whatsapp/remind', async ({ u, body }) => {
  if (!isSup(u)) forbid('للمشرف والمالك بس');
  const text = String(body.text || '').trim().slice(0, 1000); if (!text) bad('اكتب الرسالة');
  if (!wa.ready()) bad('الواتساب مو مربوط');
  const ids = (Array.isArray(body.user_ids) ? body.user_ids : []).map(Number).filter(Boolean).slice(0, 40);
  const people = ids.map(id => get("SELECT name, phone FROM users WHERE id = ? AND active = 1 AND bot = 0 AND phone != ''", id)).filter(Boolean);
  if (!people.length) bad('ما فيه أحد له جوال');
  const from = isOwner(u) ? '' : `\n\n— ${u.name}`;
  for (const p of people) { try { await wa.sendText(p.phone, text + from); } catch (e) { console.error('remind', p.name, e.message); } }
  return { sent: people.map(p => p.name) };
});
R('POST', '/api/whatsapp/test', async ({ u }) => {
  needOwner(u);
  if (!wa.ready()) bad(wa.mode() === 'link' ? 'اربط الرقم أول' : 'حط التوكن ورقم Phone number ID أول');
  const me = get('SELECT phone FROM users WHERE id = ?', u.id);
  if (!me || !me.phone) bad('حط جوالك في صفحة الموظفين أول');
  await wa.sendText(me.phone, '✓ نظام مطعم السلام مربوط بالواتساب. أرسل لي الجرد أو المشتريات هنا.');
  return { ok: true };
});

// ---- 🖨️ أرشيف الطابعة (تذاكر الكاشير) — المالك والمشرف اللي يشوف المبيعات، وما ينحذف ----
R('GET', '/api/printer/jobs', ({ u, q }) => {
  needSales(u);
  const before = Number(q.before) || 1e15;
  return {
    jobs: all('SELECT id, at, ip, bytes, text, has_image, ticket_id, raw_file FROM printer_jobs WHERE id < ? ORDER BY id DESC LIMIT 100', before).map(({ raw_file, ...j }) => {
      let junk = false; try { junk = !PRN.looksPrint(fs.readFileSync(path.join(PRN.DIR, path.basename(raw_file)))); } catch { /* */ }
      return { ...j, junk };
    }),
    junk: C.safeJSON(getSetting('printer_junk') || 'null', null),
    total: get('SELECT COUNT(*) AS n FROM printer_jobs').n,
    ips: String(getSetting('printer_ips') || '').split(',').map(s => s.trim()).filter(Boolean),
    rejected: C.safeJSON(getSetting('printer_rejected') || 'null', null),
    internet: getSetting('printer_internet') !== '0',
    bridge: { online: CAM.status().online, lan: getSetting('cam_bridge_lan') || '', queued: Number(getSetting('cam_bridge_queued') || 0) },
  };
});
// منفذ الإنترنت: يتقفل بعد ما الكاشير ينقل لطابعة المحل (الجسر)
R('POST', '/api/printer/internet', ({ u, body }) => { needOwner(u); setSetting('printer_internet', body.on ? '1' : '0'); return { ok: true }; });
const printerFile = (u, id, col, type) => {
  needSales(u);
  const j = get(`SELECT ${col} AS f FROM printer_jobs WHERE id = ?`, Number(id));
  if (!j || !j.f) bad('غير موجود');
  return { __file: { name: j.f, type, buf: fs.readFileSync(path.join(PRN.DIR, path.basename(j.f))) } };
};
R('GET', '/api/printer/jobs/:id/raw', ({ u, params }) => printerFile(u, params.id, 'raw_file', 'application/octet-stream'));
R('GET', '/api/printer/jobs/:id/image', ({ u, params }) => printerFile(u, params.id, 'image_file', 'image/png'));
// «اعتمد هذا الجهاز»: المنفذ يقبل من عناوين المحل بس (فاضي = يقبل الكل)
R('POST', '/api/printer/ips', ({ u, body }) => {
  needOwner(u);
  const ips = [...new Set((Array.isArray(body.ips) ? body.ips : []).map(s => String(s).trim()).filter(s => /^[0-9a-f.:]{3,45}$/i.test(s)))];
  setSetting('printer_ips', ips.join(','));
  if (ips.length) setSetting('printer_rejected', '');
  return { ips };
});

// تذاكر الكاشير مجمّعة من أوراق المطبخ (المطبوع − الملغي) + مقارنة بالتذاكر المصوّرة
R('GET', '/api/printer/tickets', ({ u, q }) => {
  needSales(u);
  const r = rangeOf(q) || { from: dateOr(q.date), to: dateOr(q.date) };
  const t = PR.tickets(r.from, r.to);
  // لقطة الكاشير وقت كل ورقة (لو الكاميرات مربوطة)
  const snap = new Map(all("SELECT ref, MAX(id) AS id FROM cam_snaps WHERE ref LIKE 'print:%' GROUP BY ref").map(x => [x.ref, x.id]));
  for (const k of t.tickets) for (const e of k.events) e.snap = snap.get('print:' + e.job_id) || null;
  return { ...t, photo: PR.photoTotal(r.from, r.to) };
});
// 🔊 اسم الصنف بالصوت (للي ما يقرأ): يتولد مرة وحدة وينحفظ
R('GET', '/api/items/:id/voice', async ({ params }) => {
  const it = get('SELECT id, name, unit FROM items WHERE id = ?', Number(params.id)) || bad('الصنف غير موجود');
  const text = `${it.name}، بال${it.unit === 'كجم' ? 'كيلو' : it.unit}`;
  const file = `voice-${it.id}-${crypto.createHash('md5').update(text).digest('hex').slice(0, 10)}.ogg`, full = path.join(UPLOAD_DIR, file);
  if (!fs.existsSync(full)) fs.writeFileSync(full, await require('./tts').speak(text));
  return { __file: { name: file, type: 'audio/ogg', buf: fs.readFileSync(full) } };
});
// 📷 صورة الصنف (تغطي على الإيموجي) — image فاضي = تنشال
R('PUT', '/api/items/:id/photo', ({ u, params, body }) => {
  needSup(u);
  const it = get('SELECT id FROM items WHERE id = ?', Number(params.id)) || bad('الصنف غير موجود');
  const name = body.image ? saveImage(body.image) : '';
  run('UPDATE items SET photo = ? WHERE id = ?', name, it.id);
  return { ok: true, photo: name };
});
// 👥 العملاء من أسماء التذاكر (من أول ما بدت الأوراق)
R('GET', '/api/customers', ({ u, q }) => {
  needSales(u);
  const to = isDate(q.to) ? q.to : C.businessDate(), from = isDate(q.from) ? q.from : (getSetting('sales_from_printer', '') || C.addDays(to, -90));
  return PR.customers(from, to);
});
// 🖨️ إعادة حساب مبيعات يوم من أوراق الطابعة (بعد تغيير الإعداد أو تصحيح قراءة)
R('POST', '/api/printer/sales_sync', ({ u, body }) => {
  needSales(u);
  const from = isDate(body.from) ? body.from : dateOr(body.date), to = isDate(body.to) ? body.to : from;
  const out = {};
  for (const r of all('SELECT DISTINCT date FROM printer_orders WHERE date BETWEEN ? AND ? ORDER BY date', from, to)) out[r.date] = PR.syncSales(r.date);
  return out;
});
R('POST', '/api/printer/read', async ({ u, body }) => {
  needSales(u);
  if (body.job_id) await PR.reread(Number(body.job_id)); else await PR.backfill();
  return { ok: true };
});

// ---- 🥡 السفري والبلاستيك ----
R('GET', '/api/packaging', ({ u, q }) => {
  needSales(u);
  const r = rangeOf(q) || { from: C.businessDate().slice(0, 8) + '01', to: C.businessDate() };
  return { ...PK.compute(r.from, r.to), rules: PK.rules(), pack_items: PK.packItems(), products: all("SELECT id, name, variant FROM products WHERE active = 1 ORDER BY name") };
});
R('POST', '/api/packaging/rules', ({ u, body }) => {
  needSales(u);
  if (body.approve_all) run("UPDATE packaging_rules SET status = 'ok' WHERE status = 'draft'");
  else PK.save(body);
  return { ok: true };
});
R('DELETE', '/api/packaging/rules/:id', ({ u, params }) => { needSales(u); run('DELETE FROM packaging_rules WHERE id = ?', Number(params.id)); return { ok: true }; });
R('POST', '/api/packaging/suggest', async ({ u }) => { needSales(u); return await PK.suggest(u.id); });

// ---- 📹 الكاميرات (عن طريق الجسر في المحل) ----
// تنبيه بالصورة للمالك والمشرفين اللي لهم المبيعات — دليل، والقرار لهم (الكاميرا ما تخصم)
async function camAlert(text, ref) {
  if (wa.mode() !== 'link' || !wa.ready()) return;
  const s = ref ? await CAM.snapFor(ref) : null;
  for (const m of all("SELECT phone FROM users WHERE active = 1 AND bot = 0 AND phone != '' AND (role = 'owner' OR (role = 'supervisor' AND no_sales = 0))")) {
    try { if (s) await WA.LINK.sendImage(m.phone, CAM.file(s), text); else await wa.sendText(m.phone, text + '\n(ما وصلت لقطة من الكاميرا)'); } catch (e) { console.error('camAlert', e.message); }
  }
}
// تذكرة انلغت بعد ما انطبعت => للمالك والمشرفين مع لقطة الكاشير وقت الإلغاء
PR.setOnRead(async r => {
  if (r.kind !== 'cancel' || !r.ticket_no) return;
  if (!get("SELECT 1 AS x FROM printer_orders WHERE ticket_no = ? AND kind = 'order' AND job_id < ?", r.ticket_no, r.job_id)) return;
  await camAlert(`❌ انلغت تذكرة #${r.ticket_no}${r.ticket_name ? ' (' + r.ticket_name + ')' : ''} بعد ما انطبعت:\n${r.items.map(i => `• ${i.qty} ${i.name}`).join('\n')}\nهذي لقطة الكاشير وقت الإلغاء:`, 'print:' + r.job_id);
});
R('GET', '/api/cam', ({ u }) => { needSales(u); return { ...CAM.status(), snaps: CAM.snaps() }; });
R('GET', '/api/cam/snaps', ({ u, q }) => { needSales(u); return CAM.snaps({ ref: q.ref || '', before: q.before }); });
R('GET', '/api/cam/snaps/:id/image', ({ u, params }) => {
  needSales(u);
  const s = get('SELECT * FROM cam_snaps WHERE id = ?', Number(params.id)) || bad('غير موجود');
  return { __file: { name: s.file, type: 'image/jpeg', buf: CAM.file(s) } };
});
R('POST', '/api/cam/snap', async ({ u, body }) => {
  needSales(u);
  if (!CAM.status().linked) bad('اربط الجسر أول');
  const ch = Number(body.ch); if (!get('SELECT 1 AS x FROM cam_channels WHERE ch = ?', ch)) bad('الكاميرا غير موجودة');
  const id = await CAM.snapNow(ch, 'manual', 'manual:' + u.id);
  if (!id) bad('ما وصلت اللقطة — شيك إن جوال الجسر شغال وعلى نت المحل');
  return { id };
});
R('POST', '/api/cam/pair', ({ u }) => { needOwner(u); return CAM.pairCode(); });
R('POST', '/api/cam/unlink', ({ u }) => { needOwner(u); CAM.unlink(); return { ok: true }; });
R('POST', '/api/cam/channels', ({ u, body }) => { needOwner(u); CAM.setChannels(body.channels, { names: true, roles: true }); return CAM.status(); });
R('POST', '/api/cam/settings', ({ u, body }) => {
  needOwner(u);
  if (body.keep_days != null) setSetting('cam_keep_days', String(Math.min(365, Math.max(7, Number(body.keep_days) || 60))));
  if (body.alert_short != null) setSetting('cam_alert_short', String(Math.max(0, Number(body.alert_short) || 0)));
  return { ok: true };
});
// 📢 مرة وحدة: نعرّف العمال إن النظام مربوط بالكاميرات (رسالة + لقطة حيّة وحدة في جروب المطعم)
R('POST', '/api/cam/announce', async ({ u, body }) => {
  needOwner(u);
  const text = String(body.text || '').trim().slice(0, 1000); if (!text) bad('اكتب الرسالة');
  if (wa.mode() !== 'link' || !wa.ready()) bad('اربط الواتساب أول');
  const g = NUDGE.restaurantGroup() || bad('اختر «جروب المطعم» من القروبات أول');
  const id = await CAM.snapNow(Number(body.ch), 'announce', 'announce');
  if (!id) bad('ما وصلت اللقطة — جرّب مرة ثانية');
  await WA.LINK.sendImage(g, CAM.file(get('SELECT * FROM cam_snaps WHERE id = ?', id)), text);
  setSetting('cam_announced', new Date().toISOString());
  return { ok: true };
});
// الجسر (بدون دخول — توكنه الخاص بس)
R('POST', '/api/cam/bridge/hello', ({ body }) => CAM.hello(body.code), { public: true });
R('POST', '/api/cam/bridge/channels', ({ req, body }) => { CAM.bridgeOk(req); CAM.setChannels(body.channels, { names: false }); return { ok: true }; }, { public: true });
R('GET', '/api/cam/bridge/poll', async ({ req, q }) => {
  CAM.bridgeOk(req);
  // الجسر يقول: كم ورقة تنتظر عنده (النت فاصل) وعنوانه في شبكة المحل (يتحط في الكاشير)
  if (q.queued != null) setSetting('cam_bridge_queued', String(Math.max(0, Number(q.queued) || 0)));
  if (q.lan && /^[0-9.]{7,15}$/.test(q.lan)) setSetting('cam_bridge_lan', q.lan);
  if (q.cams != null) setSetting('cam_bridge_cams', q.cams === '1' ? '1' : '0');
  return await CAM.poll();
}, { public: true });
// 🖨️ ورقة من «طابعة المحل» (الجسر) — توصل حتى لو تأخرت (فصل النت) بوقتها الأصلي، وما تنحفظ مرتين
R('POST', '/api/cam/bridge/print', ({ req, body }) => {
  CAM.bridgeOk(req);
  const buf = Buffer.from(String(body.raw_b64 || ''), 'base64');
  if (!buf.length) bad('ورقة فاضية');
  const id = String(body.id || '').replace(/[^\w.-]/g, '').slice(0, 80);
  if (!id) bad('ناقص رقم الورقة');
  const r = PRN.ingest('bridge', buf, { at: body.at, srcId: 'b:' + id });
  return { ok: true, ...r };
}, { public: true, max: 6 * 1024 * 1024 });
R('POST', '/api/cam/bridge/snap/:id', ({ req, params, body }) => { CAM.bridgeOk(req); return CAM.result(params.id, body); }, { public: true, max: 8 * 1024 * 1024 });
R('GET', '/api/cam/bridge.js', () => ({ __text: fs.readFileSync(path.join(__dirname, '..', 'deploy', 'bridge.js'), 'utf8') }), { public: true });

// «💸 كل المصروفات» لفترة: مشتريات + مصاريف + سداد موردين، من وين طلعت وعلى وش (الخاص والسلف للمالك بس)
R('GET', '/api/spending', ({ u, q }) => {
  needSales(u);
  const r = rangeOf(q) || { from: dateOr(q.date), to: dateOr(q.date) };
  return SP.spending(r.from, r.to, { privateToo: isOwner(u) });
});
// 🕐 البيع بالساعة ويوم الأسبوع (من فواتير لويفرس) — عشان ترتيب الدوامات
R('GET', '/api/insights/hourly', ({ u, q }) => {
  needSales(u);
  const r = rangeOf(q) || { from: C.addDays(C.businessDate(), -30), to: C.businessDate() };
  const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, receipts: 0, total: 0 })), week = DAYS.map(d => ({ day: d, receipts: 0, total: 0, days: new Set() }));
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0)), dates = new Set();
  for (const x of all("SELECT date, created_at, receipt_type, total FROM loyverse_receipts WHERE date BETWEEN ? AND ? AND cancelled = 0", r.from, r.to)) {
    const t = new Date(new Date(x.created_at).getTime() + 3 * 3600e3), h = t.getUTCHours(), wd = t.getUTCDay();
    const sign = x.receipt_type === 'REFUND' ? -1 : 1;
    hours[h].receipts += sign; hours[h].total += sign * (x.total || 0);
    const bd = new Date(x.date + 'T00:00:00Z').getUTCDay();
    week[bd].receipts += sign; week[bd].total += sign * (x.total || 0); week[bd].days.add(x.date);
    grid[bd][h] += sign; dates.add(x.date);
  }
  const n = dates.size || 1;
  return { from: r.from, to: r.to, days: dates.size,
    hours: hours.map(x => ({ ...x, total: C.r2(x.total), per_day: C.r2(x.receipts / n), total_per_day: C.r2(x.total / n) })),
    week: week.map(x => ({ day: x.day, n: x.days.size, receipts: x.receipts, total: C.r2(x.total), per_day: x.days.size ? C.r2(x.total / x.days.size) : 0 })),
    grid };
});
R('GET', '/api/monthly-report', ({ u, q }) => { needOwner(u); const r = MR.monthlyReport(monthOr(q.month), rangeOf(q)); return { ...r, purchases: undefined, products: r.products.slice(0, 15) }; });
R('GET', '/api/monthly-report/xlsx', ({ u, q }) => {
  needOwner(u);
  const x = MR.monthlyXlsx(monthOr(q.month), getSetting('restaurant_name') || 'مطعم السلام', rangeOf(q));
  return { __file: { name: x.name, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf: x.buf } };
});

// ---- النسخة الاحتياطية على قوقل درايف (المالك) ----
R('GET', '/api/gdrive', ({ u }) => { needOwner(u); return GD.status(); });
R('POST', '/api/gdrive/config', ({ u, body }) => {
  needOwner(u);
  const id = String(body.client_id || '').trim(), sec = String(body.client_secret || '').trim();
  if (!/\.apps\.googleusercontent\.com$/.test(id)) bad('Client ID لازم ينتهي بـ .apps.googleusercontent.com');
  if (!sec.startsWith('••••')) { if (sec.length < 10) bad('حط Client Secret'); setSetting('gdrive_client_secret', sec); }
  if (id !== getSetting('gdrive_client_id')) { setSetting('gdrive_client_id', id); setSetting('gdrive_refresh_token', ''); }
  return GD.status();
});
R('POST', '/api/gdrive/auth', ({ u, body }) => { needOwner(u); return { url: GD.authUrl(String(body.redirect || '')) }; });
// قوقل يرجّع المتصفح هنا بعد الموافقة (الكوكي تعرّف المالك)
R('GET', '/api/gdrive/callback', async ({ u, q }) => {
  if (!u || !isOwner(u)) return { __redirect: '/#/settings?gdrive=' + encodeURIComponent('افتح الرابط من نفس الجوال اللي داخل فيه المالك') };
  if (q.error) return { __redirect: '/#/settings?gdrive=' + encodeURIComponent('رفضت الصلاحية') };
  try { await GD.callback(q.code, q.state); } catch (e) { return { __redirect: '/#/settings?gdrive=' + encodeURIComponent(e.message) }; }
  GD.backupNow().catch(e => console.error('gdrive first backup', e.message));
  return { __redirect: '/#/settings?gdrive=ok' };
}, { public: true });
R('POST', '/api/gdrive/backup', async ({ u }) => { needOwner(u); return await GD.backupNow(); });
R('POST', '/api/gdrive/report', async ({ u, body }) => { needOwner(u); if (!GD.connected()) bad('قوقل درايف مو مربوط'); return { name: await GD.uploadReport(monthOr(body.month)) }; });
R('DELETE', '/api/gdrive', ({ u }) => { needOwner(u); GD.disconnect(); return GD.status(); });
R('GET', '/api/ai/log', ({ u }) => { needWa(u); return all('SELECT l.*, us.name AS user FROM ai_log l LEFT JOIN users us ON us.id = l.user_id ORDER BY l.id DESC LIMIT 100'); });

// ===================== السيرفر =====================
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function tokenOf(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  const m = /(?:^|;\s*)t=([a-f0-9]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : '';
}
function userOf(token) {
  if (!token) return null;
  return get('SELECT u.id, u.name, u.role, u.no_sales, u.no_recipes, u.bot FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.active = 1', token) || null;
}
function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, max = 60 * 1024 * 1024, raw = false) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > max) { reject(new HttpError(413, 'الملف كبير')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (raw) return resolve(Buffer.concat(chunks)); try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'بيانات غير صحيحة')); } });
    req.on('error', reject);
  });
}
function serveFile(res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': cache });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  let url, p;
  try { url = new URL(req.url, 'http://x'); p = decodeURIComponent(url.pathname); }
  catch { return send(res, 400, { error: 'رابط غير صحيح' }); }
  try {
    if (p.startsWith('/api/')) {
      const route = routes.find(r => r.method === req.method && r.re.test(p));
      if (!route) return send(res, 404, { error: 'غير موجود' });
      const token = tokenOf(req);
      const u = userOf(token);
      if (!route.public && !u) return send(res, 401, { error: 'سجّل دخول' });
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req, route.max || (route.public && !u ? 100 * 1024 : undefined), !!route.raw) : {}; // بدون دخول: طلب صغير بس
      const params = route.re.exec(p).groups || {};
      const q = Object.fromEntries(url.searchParams);
      const out = await route.handler({ req, res, u, token, body, params, q });
      if (out && out.__text != null) { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(out.__text); }
      if (out && out.__redirect) { res.writeHead(302, { Location: out.__redirect, 'Cache-Control': 'no-store' }); return res.end(); }
      if (out && out.__file) {
        res.writeHead(200, { 'Content-Type': out.__file.type, 'Content-Length': out.__file.buf.length, 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="report.xlsx"; filename*=UTF-8''${encodeURIComponent(out.__file.name)}` });
        return res.end(out.__file.buf);
      }
      return send(res, 200, out ?? { ok: true });
    }
    if (p.startsWith('/uploads/')) {
      if (!userOf(tokenOf(req))) { res.writeHead(401); return res.end(); }
      return serveFile(res, path.join(UPLOAD_DIR, path.basename(p)), 'private, max-age=31536000, immutable');
    }
    const file = path.join(PUBLIC, path.normalize(p === '/' ? '/index.html' : p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(file)) return serveFile(res, path.join(PUBLIC, 'index.html'), 'no-cache');
    return serveFile(res, file, 'no-cache');
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'صار خطأ في السيرفر: ' + e.message : e.message, ...(e.needForce ? { needForce: true } : {}) });
  }
});

process.on('unhandledRejection', e => console.error('unhandled', e));
process.on('uncaughtException', e => console.error('uncaught', e));

// مرة وحدة: الأصناف اللي اندمجت قبل هالإصلاح — «بس هذي الأصناف» ووحدات الشراء تنتقل للصنف الجديد
if (!getSetting('merge_fix_v1')) {
  try {
    for (const f of all("SELECT id, note FROM items WHERE active = 0 AND note LIKE '%اندمج في %'")) {
      const name = f.note.split('اندمج في ').pop().trim();
      const t = get('SELECT id FROM items WHERE name = ? AND active = 1', name); if (!t) continue;
      tx(() => {
        remapOnly(f.id, t.id);
        run('INSERT OR IGNORE INTO item_units(item_id, name, factor) SELECT ?, name, factor FROM item_units WHERE item_id = ?', t.id, f.id);
        run('DELETE FROM item_units WHERE item_id = ?', f.id);
      });
    }
    setSetting('merge_fix_v1', '1');
  } catch (e) { console.error('merge_fix', e); }
}
// مرة وحدة: المطبوخ اللي يطلع الثلاجة (المطفي) — نعيد خصم مكوناته من جرد أول اليوم بالقاعدة الجديدة
if (!getSetting('resync_open_pull_v1')) {
  try {
    const its = all("SELECT id FROM items WHERE pull_on_open = 1 AND kind = 'prepared' AND leftover IN ('fridge', 'fridge_added') AND id IN (SELECT item_id FROM item_components)");
    for (const it of its) for (const c of all('SELECT date FROM counts WHERE item_id = ? AND date >= ? ORDER BY date', it.id, getSetting('stock_start_date', ''))) tx(() => { syncFridge(c.date, it.id); syncOpeningPull(c.date, it.id); });
    setSetting('resync_open_pull_v1', '1');
  } catch (e) { console.error('resync_open_pull', e); }
}

if (require.main === module) {
  server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
    console.log(`نظام جرد السلام شغال على http://localhost:${PORT}`);
    L.startScheduler();
    GD.startScheduler();
    setInterval(() => { try { accrueSalaries(); } catch (e) { console.error(e); } }, 6 * 3600e3);
    // 🔁 المشتريات الثابتة: أول ما يبدأ اليوم (ومرة كل نص ساعة يشيك)
    const fx = () => { try { addFixedPurchases(); } catch (e) { console.error('fixed purchases', e.message); } };
    setTimeout(fx, 5000); setInterval(fx, 30 * 60e3);
    // تذاكر علقت في القراءة (السيرفر طفى) ترجع مسودة
    run("UPDATE tickets SET status = 'draft', ocr_error = 'انقطعت القراءة — أعد رفع الصورة أو أدخل يدوي' WHERE status = 'reading'");
  });
  // 🖨️ «الطابعة»: الكاشير يرسل التذاكر المحفوظة هنا (PRINTER_PORT=0 يطفيها)
  const pp = process.env.PRINTER_PORT === undefined ? 9100 : Number(process.env.PRINTER_PORT);
  // كل ورقة جديدة (من منفذ الإنترنت أو من جسر المحل): لقطة الكاشير + القراءة بالخلفية
  PRN.setOnJob(id => { CAM.event('cashier', 'print', 'print:' + id); PR.enqueue(id); });
  if (pp) try { PRN.start(pp); } catch (e) { console.error('printer', e.message); }
  // الأوراق اللي ما انقرت (السيرفر كان طافي، أو قبل القراءة)
  setTimeout(() => PR.backfill(), 3000);
  // 📱 الرقم المربوط: يرجع يتصل لحاله بعد التشغيل
  if (wa.mode() === 'link' && WA.LINK.hasSession()) WA.LINK.start().catch(e => console.error('wa_link', e.message));
  // 📣 «يلسعهم»: كل نص ساعة يشيك (كل تنبيه مرة وحدة في اليوم)
  setInterval(() => { if (wa.mode() === 'link' && wa.ready()) NUDGE.nudge(wa.sendGroupText, { sendPrivate: wa.sendText }).catch(e => console.error('nudge', e.message)); }, 30 * 60e3);
  // 🔁 ملاحقة اللي ما دخّل جرده في الخاص (كل ساعة) — بعد ٣ مرات: القروب + (بعد فترة التعليم) مشكلة «الجرد»
  setInterval(() => { if (wa.ready()) chaseNow().catch(e => console.error('chase', e.message)); }, 10 * 60e3);
  // 📊 الخميس بالليل: تقرير المشاكل للمالك + مدح الملتزمين في جروب المطعم
  setInterval(() => { if (wa.mode() === 'link' && wa.ready()) weeklyReport().catch(e => console.error('weekly', e.message)); }, 30 * 60e3);
  // 🛒 قائمة الطلبات لزكريا في أوقاتها
  // 📹 اللقطات الأقدم من المدة تنمسح (مرة كل ٦ ساعات)
  setInterval(() => { try { CAM.cleanup(); } catch (e) { console.error('cam cleanup', e.message); } }, 6 * 3600e3);
  setInterval(() => { if (wa.ready()) wa.flushRequests().catch(e => console.error('requests', e.message)); }, 5 * 60e3);
  // ⏳ الكرت اللي ما انرد عليه يرجع للموظف مرة وحدة
  setInterval(() => { if (wa.ready()) wa.remindPending().catch(e => console.error('remind pending', e.message)); }, 5 * 60e3);
}

module.exports = { server, routes, db };
