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
const AI = require('./ai');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');

// ===================== أدوات =====================
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = msg => { throw new HttpError(400, msg); };
const forbid = (msg = 'ما عندك صلاحية') => { throw new HttpError(403, msg); };
const num = (v, name) => { const n = Number(v); if (!Number.isFinite(n)) bad(`${name || 'الرقم'} غير صحيح`); return n; };
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
  try {
    const res = await readAndCheck(imgs);
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
      run("UPDATE tickets SET status = 'draft', ocr_error = '', label = ?, paper_total = ?, lines_total = ?, discount = ?, check_status = ?, check_note = ?, ocr_cost = COALESCE(ocr_cost, 0) + ? WHERE id = ?",
        label, paper, linesTotal, C.r2(res.tickets.reduce((x, c) => x + c.discount, 0)), status, notes.join('\n'), res.cost || 0, ticketId);
    });
  } catch (e) {
    run("UPDATE tickets SET status = 'draft', ocr_error = ? WHERE id = ?", String(e.message || e), ticketId);
  }
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
function transfer(u, { date, item_id, qty, note, mode, unit }) {
  const item = get('SELECT * FROM items WHERE id = ?', item_id) || bad('الصنف غير موجود');
  qty = num(qty, 'الكمية'); if (!qty) bad('حط الكمية');
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
    run("INSERT INTO moves(date, item_id, location, qty, type, ref, user_id, note) VALUES(?,?,'floor',?,'waste',?,?,?)", date, item.id, -qty, ref, u.id, note || 'انرمى');
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
    run("INSERT INTO moves(date, item_id, location, qty, type, ref, user_id, note) VALUES(?,?,'floor',?,'transfer',?,?,?)", date, item.id, qty, ref, u.id, note || '');
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
function syncOpeningPull(date, itemId) {
  const item = get('SELECT pull_on_open, kind FROM items WHERE id = ?', itemId);
  const ref = `op:${date}:${itemId}`;
  run('DELETE FROM moves WHERE ref = ?', ref);
  if (!item || !item.pull_on_open) return;
  const today = get('SELECT opening FROM counts WHERE date = ? AND item_id = ?', date, itemId);
  const prev = get('SELECT closing FROM counts WHERE date = ? AND item_id = ?', C.addDays(date, -1), itemId);
  if (!today || today.opening == null || !prev || prev.closing == null) return; // ما نعرف آخر أمس: ما نخمّن
  const pulled = C.r3(today.opening - prev.closing);
  if (pulled <= 0) return;
  // المحضّر (الفت الناشف مثلاً): اللي تجهّز أول اليوم تنخصم مكوناته. الخام (الدجاج): ينخصم هو من المستودع
  const comps = item.kind === 'prepared' ? all('SELECT c.component_id, c.qty, i.daily FROM item_components c JOIN items i ON i.id = c.component_id WHERE c.item_id = ?', itemId) : [];
  if (comps.length) {
    for (const c of comps) run("INSERT INTO moves(date, item_id, location, qty, type, ref, note) VALUES(?,?,?,?,'prep_use',?,?)",
      date, c.component_id, c.daily ? 'floor' : 'warehouse', -C.r3(c.qty * pulled), ref, `تحضير أول اليوم ${C.r3(pulled)}`);
  } else run("INSERT INTO moves(date, item_id, location, qty, type, ref, note) VALUES(?,?,'warehouse',?,'opening_pull',?,'سحب من الثلاجة أول اليوم')", date, itemId, -pulled, ref);
}

// تحويل بين أصناف المحضّر (صهوم ما انباع => برم/حنيذ)
function convert(u, { date, from_item_id, to_item_id, qty_from, qty_to, note }) {
  const a = get('SELECT * FROM items WHERE id = ?', from_item_id) || bad('الصنف الأول غير موجود');
  const b = get('SELECT * FROM items WHERE id = ?', to_item_id) || bad('الصنف الثاني غير موجود');
  qty_from = num(qty_from, 'الكمية'); qty_to = num(qty_to ?? qty_from, 'الكمية');
  const ref = 'cv:' + crypto.randomUUID();
  tx(() => {
    run("INSERT INTO moves(date, item_id, location, qty, type, ref, user_id, note) VALUES(?,?,'floor',?,'convert',?,?,?)", date, a.id, -qty_from, ref, u.id, `إلى ${b.name} ${note || ''}`.trim());
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
const PAYMENTS = ['cash', 'paid', 'credit'];

function savePurchase(u, b) {
  const date = dateOr(b.date);
  const payment = PAYMENTS.includes(b.payment) ? b.payment : (b.paid_from_cash ? 'cash' : 'paid');
  // كل سطر: الكمية بوحدة الشراء (3 كرتون) + سعرها (40) أو مبلغ السطر (120) => يتحول للوحدة الأساسية (72 علبة بـ 1.667)
  const lines = (b.lines || []).filter(l => l.item_id && Number(l.qty)).map(l => {
    const item = get('SELECT id, name, unit, kind, daily, carry_over, no_opening FROM items WHERE id = ?', Number(l.item_id)) || bad('الصنف غير موجود');
    if (onlyPurch(u) && item.kind !== 'raw') bad(`«${item.name}» صنف محضّر، مو من المشتريات`);
    const unitName = String(l.unit || '').trim();
    let factor = 1;
    if (unitName && unitName !== item.unit) {
      const u = get('SELECT factor FROM item_units WHERE item_id = ? AND name = ?', item.id, unitName);
      if (u) factor = u.factor;
      else if (Number(l.factor) > 0) factor = Number(l.factor);
      else bad(`كم ${item.unit} في ${unitName} (${item.name})؟`);
    }
    const puQty = num(l.qty, 'الكمية');
    const puPrice = Number(l.unit_price) > 0 ? Number(l.unit_price) : (Number(l.line_total) > 0 ? Number(l.line_total) / puQty : 0);
    return { item, unitName: factor === 1 && !unitName ? '' : unitName, factor, newUnit: unitName && unitName !== item.unit && Number(l.factor) > 0,
      puQty, puPrice, qty: C.r3(puQty * factor), price: factor ? puPrice / factor : 0, to_floor: l.to_floor ?? (!!item.daily && (!item.carry_over || !!item.no_opening)) }; // الطازج (لحوح، كدر، الشطة…) يدخل الجرد على طول
  });
  const image = b.image ? saveImage(b.image) : '';
  const total = C.r2(b.total != null && b.total !== '' && !lines.length ? Number(b.total) : lines.reduce((s, l) => s + l.puQty * l.puPrice, 0));
  if (!lines.length && !image && !b.note) bad('حط أصناف أو صورة أو كتابة');
  if (payment === 'credit' && !b.supplier_id && !String(b.supplier || '').trim()) bad('الشراء الآجل لازم له مورد');
  if (payment === 'credit' && !total) bad('الشراء الآجل لازم له مبلغ');
  return tx(() => {
    const sid = supplierId(b);
    const sname = sid ? get('SELECT name FROM suppliers WHERE id = ?', sid).name : '';
    const id = Number(run('INSERT INTO purchases(date, user_id, supplier, supplier_id, note, image, total, paid_from_cash, payment) VALUES(?,?,?,?,?,?,?,?,?)',
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
        date, l.item_id, l.to_floor ? 'floor' : 'warehouse', qty, 'pu:' + id, u.id, sname);
      if (price > 0) { // متوسط سعر الشراء
        const it = get('SELECT cost FROM items WHERE id = ?', l.item_id);
        const have = Math.max(0, bal.get(Number(l.item_id)) || 0);
        const newCost = have > 0 && it.cost > 0 ? (have * it.cost + qty * price) / (have + qty) : price;
        run('UPDATE items SET cost = ? WHERE id = ?', C.r3(newCost), l.item_id);
      }
    }
    return { id };
  });
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
R('POST', '/api/login', ({ body, res }) => {
  const u = get('SELECT * FROM users WHERE id = ? AND active = 1 AND bot = 0', Number(body.user_id));
  if (!u || String(u.pin) !== String(body.pin || '').trim()) throw new HttpError(401, 'الرقم السري غلط');
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
}));
R('POST', '/api/me/pin', ({ u, body }) => {
  if (!/^\d{4,8}$/.test(String(body.pin || ''))) bad('الرقم السري ٤ إلى ٨ أرقام');
  run('UPDATE users SET pin = ? WHERE id = ?', String(body.pin), u.id); return { ok: true };
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
    if (board.rows.some(r => r.opening_user_id === u.id || r.closing_user_id === u.id))
      add('info', 'طلّعت شي من المستودع أو جهّزت شي؟', 'سجّله على طول — اللي ما يتسجل يطلع نقص عليك', '#/transfer', 'سجّل سحب / تحضير');
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
  if (!out.some(t => t.level !== 'green' && t.level !== 'info')) add('green', 'ما عليك شي الحين 👍', '', '', '');
  const rank = { red: 0, amber: 1, info: 2, green: 3 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

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
  if (isSup(u)) return b;
  const mySecs = approverSections(u);
  b.rows = b.rows.filter(r => r.opening_user_id === u.id || r.closing_user_id === u.id || mySecs.includes(r.section_id)).map(r => {
    if (mySecs.includes(r.section_id)) return r;
    const { theoretical, actual, diff, diff_value, remaining_expected, waste_value, ...rest } = r; return rest;
  });
  const secIds = new Set(b.rows.map(r => r.section_id));
  b.sections = b.sections.filter(s => secIds.has(s.id)).map(s => ({ ...s, shortage_value: mySecs.includes(s.id) ? s.shortage_value : undefined }));
  return b;
});

R('POST', '/api/count', ({ u, body }) => {
  const date = dateOr(body.date);
  const phase = body.phase === 'closing' ? 'closing' : 'opening';
  const item = get('SELECT * FROM items WHERE id = ?', Number(body.item_id)) || bad('الصنف غير موجود');
  const sec = item.section_id ? get('SELECT * FROM sections WHERE id = ?', item.section_id) : null;
  const responsible = phase === 'opening' ? (item.opening_user_id || (sec && sec.opening_user_id)) : (item.closing_user_id || (sec && sec.closing_user_id));
  const approver = sec && approverSections(u).includes(sec.id);
  if (!isSup(u) && responsible !== u.id && !approver) forbid('هذا الصنف مو عليك');
  if (dayClosed(date) && !isOwner(u)) forbid('اليوم مقفل');
  if (sec && !isSup(u) && !approver && get('SELECT 1 AS x FROM section_approvals WHERE date = ? AND section_id = ? AND phase = ?', date, sec.id, phase)) forbid('المشرف استلم — كلم المشرف يعدّل');
  const qty = optNum(body.qty);
  if (qty != null && (!Number.isFinite(qty) || qty < 0)) bad('الكمية غير صحيحة');
  run('INSERT INTO counts(date, item_id) VALUES(?,?) ON CONFLICT DO NOTHING', date, item.id);
  run(`UPDATE counts SET ${phase} = ?, ${phase}_by = ?, ${phase}_at = ?${body.note != null ? ', note = ?' : ''} WHERE date = ? AND item_id = ?`,
    ...[qty, qty == null ? null : u.id, qty == null ? null : nowISO()], ...(body.note != null ? [String(body.note)] : []), date, item.id);
  // إغلاق اليوم يأثر على سحب بكرة، والافتتاح يأثر على سحب اليوم
  syncOpeningPull(phase === 'opening' ? date : C.addDays(date, 1), item.id);
  return { ok: true };
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
R('POST', '/api/transfer', ({ u, body }) => transfer(u, { ...body, date: dateOr(body.date), item_id: Number(body.item_id) }));
R('POST', '/api/convert', ({ u, body }) => convert(u, { ...body, date: dateOr(body.date), from_item_id: Number(body.from_item_id), to_item_id: Number(body.to_item_id) }));
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
  if (m.ref) run('DELETE FROM moves WHERE ref = ?', m.ref); else run('DELETE FROM moves WHERE id = ?', m.id);
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
  needPurch(u);
  const date = dateOr(body.date);
  const bal = C.warehouseBalances(), costs = C.itemCostMap();
  const result = [];
  tx(() => {
    for (const c of body.counts || []) {
      if (c.qty === '' || c.qty == null) continue;
      const id = Number(c.item_id), counted = num(c.qty), cur = bal.get(id) || 0, diff = C.r3(counted - cur);
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
  return all(`SELECT i.*, s.name AS section FROM items i LEFT JOIN sections s ON s.id = i.section_id WHERE i.active = 1 ${onlyPurch(u) ? "AND i.kind = 'raw'" : ''} ORDER BY s.sort, i.sort, i.id`)
    .map(i => ({ ...i, unit_cost: C.r3(costs.get(i.id) || 0), components: comps.filter(c => c.item_id === i.id), units: units.filter(x => x.item_id === i.id) }));
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
  const old = body.id ? get('SELECT section_id, opening_user_id, closing_user_id FROM items WHERE id = ?', Number(body.id)) || {} : {};
  const keep = (k) => (body[k] === undefined ? (old[k] ?? null) : optNum(body[k]));
  const f = [name, body.unit || 'حبة', keep('section_id'), body.kind === 'prepared' ? 'prepared' : 'raw', Number(body.cost) || 0, Number(body.sale_value) || 0,
    body.carry_over ? 1 : 0, body.daily ? 1 : 0, keep('opening_user_id'), keep('closing_user_id'), body.note || '', body.pull_on_open ? 1 : 0, Number(body.extra_cost) || 0];
  if (body.id) { run('UPDATE items SET name=?, unit=?, section_id=?, kind=?, cost=?, sale_value=?, carry_over=?, daily=?, opening_user_id=?, closing_user_id=?, note=?, pull_on_open=?, extra_cost=? WHERE id=?', ...f, Number(body.id)); return { id: Number(body.id) }; }
  const sort = (get('SELECT MAX(sort) AS m FROM items').m || 0) + 1;
  return { id: Number(run('INSERT INTO items(name, unit, section_id, kind, cost, sale_value, carry_over, daily, opening_user_id, closing_user_id, note, pull_on_open, extra_cost, sort) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', ...f, sort).lastInsertRowid) };
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
  });
  return { ok: true };
});
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
R('GET', '/api/users', ({ u }) => { needSup(u); return all((isOwner(u) ? 'SELECT id, name, role, salary, active, no_sales, no_recipes, pin' : 'SELECT id, name, role, active') + ' FROM users WHERE bot = 0 ORDER BY active DESC, id'); });
R('POST', '/api/users', ({ u, body }) => {
  needOwner(u);
  const name = String(body.name || '').trim(); if (!name) bad('حط الاسم');
  const role = ['owner', 'supervisor', 'purchaser', 'worker'].includes(body.role) ? body.role : 'worker';
  const pin = String(body.pin || '0000');
  if (!/^\d{4,8}$/.test(pin)) bad('الرقم السري ٤ إلى ٨ أرقام');
  if (body.id) {
    if (Number(body.id) === u.id && role !== 'owner') bad('ما تقدر تشيل صلاحية المالك عن نفسك');
    run('UPDATE users SET name=?, role=?, pin=?, salary=?, active=?, no_sales=?, no_recipes=? WHERE id=?', name, role, pin, Number(body.salary) || 0, body.active === false || body.active === 0 ? 0 : 1, body.no_sales ? 1 : 0, body.no_recipes ? 1 : 0, Number(body.id));
    return { id: Number(body.id) };
  }
  return { id: Number(run('INSERT INTO users(name, role, pin, salary, no_sales, no_recipes) VALUES(?,?,?,?,?,?)', name, role, pin, Number(body.salary) || 0, body.no_sales ? 1 : 0, body.no_recipes ? 1 : 0).lastInsertRowid) };
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
    user_id: active.has(r.closing_user_id) ? r.closing_user_id : null, opener_id: active.has(r.opening_user_id) ? r.opening_user_id : null }));
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
  run('INSERT INTO note_rules(product_id, keyword, only_items) VALUES(?,?,?)', optNum(body.product_id), kw, JSON.stringify((body.only || []).map(Number)));
  recomputeRecent(); return { ok: true };
});
R('DELETE', '/api/note-rules/:id', ({ u, params }) => { needRecipes(u); run('DELETE FROM note_rules WHERE id = ?', Number(params.id)); recomputeRecent(); return { ok: true }; });

// ---- المبيعات والتقرير (للمشرفين بس) ----
R('GET', '/api/sales', ({ u, q }) => { needSales(u); return C.mergedSales(dateOr(q.date)); });
R('GET', '/api/report', ({ u, q }) => { needSales(u); return C.dailyReport(dateOr(q.date)); });
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
  const date = dateOr(body.date);
  run(`INSERT INTO cash_counts(date, cash, card, note, user_id, at) VALUES(?,?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET cash=excluded.cash, card=excluded.card, note=excluded.note, user_id=excluded.user_id, at=excluded.at`,
    date, Number(body.cash) || 0, Number(body.card) || 0, body.note || '', u.id, nowISO());
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
  const rows = all(`SELECT p.*, us.name AS user FROM purchases p LEFT JOIN users us ON us.id = p.user_id WHERE date BETWEEN ? AND ? ORDER BY date DESC, id DESC`, from, to);
  return rows.map(p => ({ ...p, lines: all('SELECT l.*, i.name AS item, i.unit FROM purchase_lines l LEFT JOIN items i ON i.id = l.item_id WHERE purchase_id = ?', p.id) }));
});
R('POST', '/api/purchases', ({ u, body }) => { needPurch(u); return savePurchase(u, body); });
R('DELETE', '/api/purchases/:id', ({ u, params }) => {
  const p = get('SELECT * FROM purchases WHERE id = ?', Number(params.id)) || bad('غير موجود');
  needPurch(u);
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
  const payments = all('SELECT sp.*, us.name AS user FROM supplier_payments sp LEFT JOIN users us ON us.id = sp.user_id WHERE sp.supplier_id = ? ORDER BY sp.date DESC, sp.id DESC', id);
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
  const amount = num(body.amount, 'المبلغ'); if (amount <= 0) bad('حط المبلغ');
  const image = body.image ? saveImage(body.image) : '';
  run('INSERT INTO supplier_payments(date, supplier_id, amount, paid_from_cash, note, image, user_id) VALUES(?,?,?,?,?,?,?)', dateOr(body.date), id, amount, body.paid_from_cash ? 1 : 0, body.note || '', image, u.id);
  return { ok: true };
});
R('DELETE', '/api/supplier-payments/:id', ({ u, params }) => { needSup(u); run('DELETE FROM supplier_payments WHERE id = ?', Number(params.id)); return { ok: true }; });

// ---- المصروفات ----
R('GET', '/api/expenses', ({ u, q }) => {
  needSup(u);
  const from = isDate(q.from) ? q.from : C.addDays(C.businessDate(), -30), to = isDate(q.to) ? q.to : C.businessDate();
  return all('SELECT e.*, us.name AS user FROM expenses e LEFT JOIN users us ON us.id = e.user_id WHERE date BETWEEN ? AND ? ORDER BY date DESC, id DESC', from, to);
});
R('POST', '/api/expenses', ({ u, body }) => {
  needSup(u);
  const image = body.image ? saveImage(body.image) : '';
  const amount = Number(body.amount) || 0;
  if (!amount && !image) bad('حط المبلغ أو صورة الورقة');
  return { id: Number(run('INSERT INTO expenses(date, user_id, amount, category, note, image, paid_from_cash) VALUES(?,?,?,?,?,?,?)', dateOr(body.date), u.id, amount, body.category || '', body.note || '', image, body.paid_from_cash === false ? 0 : 1).lastInsertRowid) };
});
R('PATCH', '/api/expenses/:id', ({ u, params, body }) => { needSup(u); run('UPDATE expenses SET amount = ?, note = ?, category = ? WHERE id = ?', Number(body.amount) || 0, body.note || '', body.category || '', Number(params.id)); return { ok: true }; });
R('DELETE', '/api/expenses/:id', ({ u, params }) => { needSup(u); run('DELETE FROM expenses WHERE id = ?', Number(params.id)); return { ok: true }; });

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
  if (!amount) bad('حط المبلغ');
  const date = dateOr(body.date);
  run('INSERT INTO payroll(user_id, date, type, amount, note, month) VALUES(?,?,?,?,?,?)', uid, date, type, amount, body.note || '', type === 'salary' ? (body.month || date.slice(0, 7)) : '');
  return { ok: true };
});
R('DELETE', '/api/payroll/:id', ({ u, params }) => { needOwner(u); run('DELETE FROM payroll WHERE id = ?', Number(params.id)); return { ok: true }; });

// ---- الإعدادات والمزامنة ----
const SETTING_KEYS = ['loyverse_token', 'anthropic_key', 'day_start_hour', 'sync_days_back', 'opening_deadline_hour', 'restaurant_name', 'ticket_in_cash', 'ticket_tolerance', 'ai_monthly_cap', 'seasons', 'max_food_cost'];
R('GET', '/api/settings', ({ u }) => {
  needOwner(u);
  const s = {}; for (const k of SETTING_KEYS) s[k] = getSetting(k);
  for (const k of ['loyverse_token', 'anthropic_key']) s[k] = s[k] ? '••••' + s[k].slice(-4) : '';
  s.last_receipt_sync = getSetting('last_receipt_sync');
  // تكلفة قراءة التذاكر هالشهر (تقريبية، بالدولار)
  s.ocr_cost_month = Math.round((get("SELECT SUM(ocr_cost) AS c FROM tickets WHERE created_at >= date('now', 'start of month')").c || 0) * 100) / 100;
  s.ai_cost_month = Math.round((get("SELECT SUM(cost) AS c FROM ai_log WHERE at >= date('now', 'start of month')").c || 0) * 100) / 100;
  s.ai_monthly_cap = getSetting('ai_monthly_cap', '20');
  s.max_food_cost = getSetting('max_food_cost', '35');
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
  const b = get('SELECT id, active FROM users WHERE bot = 1 LIMIT 1');
  return { active: !!(b && b.active && get('SELECT 1 AS x FROM sessions WHERE user_id = ?', b.id)) };
});
R('POST', '/api/settings/claude-key', ({ u }) => {
  needOwner(u);
  let b = get('SELECT id FROM users WHERE bot = 1 LIMIT 1');
  if (!b) b = { id: Number(run("INSERT INTO users(name, role, pin, bot) VALUES(?, 'supervisor', ?, 1)", CLAUDE, crypto.randomBytes(8).toString('hex')).lastInsertRowid) };
  run("UPDATE users SET active = 1, role = 'supervisor', no_sales = 0, no_recipes = 0 WHERE id = ?", b.id);
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
R('POST', '/api/assistant', async ({ u, body }) => { needSales(u); return await AS.ask(u, body.question, body.history, { detailed: !!body.detailed }); });
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
R('GET', '/api/ai/log', ({ u }) => { needOwner(u); return all('SELECT l.*, us.name AS user FROM ai_log l LEFT JOIN users us ON us.id = l.user_id ORDER BY l.id DESC LIMIT 100'); });

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
  return get('SELECT u.id, u.name, u.role, u.no_sales, u.no_recipes FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.active = 1', token) || null;
}
function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 60 * 1024 * 1024) { reject(new HttpError(413, 'الملف كبير')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'بيانات غير صحيحة')); } });
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
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  try {
    if (p.startsWith('/api/')) {
      const route = routes.find(r => r.method === req.method && r.re.test(p));
      if (!route) return send(res, 404, { error: 'غير موجود' });
      const token = tokenOf(req);
      const u = userOf(token);
      if (!route.public && !u) return send(res, 401, { error: 'سجّل دخول' });
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      const params = route.re.exec(p).groups || {};
      const q = Object.fromEntries(url.searchParams);
      const out = await route.handler({ req, res, u, token, body, params, q });
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

if (require.main === module) {
  server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
    console.log(`نظام جرد السلام شغال على http://localhost:${PORT}`);
    L.startScheduler();
    setInterval(() => { try { accrueSalaries(); } catch (e) { console.error(e); } }, 6 * 3600e3);
    // تذاكر علقت في القراءة (السيرفر طفى) ترجع مسودة
    run("UPDATE tickets SET status = 'draft', ocr_error = 'انقطعت القراءة — أعد رفع الصورة أو أدخل يدوي' WHERE status = 'reading'");
  });
}

module.exports = { server, routes, db };
