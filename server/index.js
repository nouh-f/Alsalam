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
function rebuildTicketSales(ticketId) {
  const t = get('SELECT * FROM tickets WHERE id = ?', ticketId);
  tx(() => {
    run("DELETE FROM sales WHERE source = 'ticket' AND ref = ?", ticketId);
    if (!t) return;
    const lines = all('SELECT l.*, p.price AS list_price FROM ticket_lines l LEFT JOIN products p ON p.id = l.product_id WHERE ticket_id = ?', ticketId);
    for (const l of lines) if (l.product_id && l.qty) {
      const price = l.price || l.list_price || 0;
      run("INSERT INTO sales(date, product_id, qty, amount, list_amount, source, note, only_items, ref) VALUES(?,?,?,?,?,'ticket',?,?,?)",
        t.date, l.product_id, l.qty, C.r2(l.qty * price), C.r2(l.qty * (l.list_price || price)), l.note || '', l.only_items || '', ticketId);
    }
  });
  if (t) C.rebuildSaleUse(t.date);
}

async function ocrTicket(ticketId, imagePaths) {
  try {
    const lines = await readTicketImages(imagePaths.map(p => path.join(UPLOAD_DIR, p)));
    const products = all('SELECT id, name, variant FROM products WHERE active = 1').map(p => ({ id: p.id, label: `${p.name} ${p.variant}`.trim() }));
    const aliases = new Map(all('SELECT * FROM product_aliases').map(a => [a.alias, a.product_id]));
    tx(() => {
      for (const l of lines) {
        let pid = l.product_id;
        const alias = aliases.get(normalize(l.name));
        if (alias) pid = alias;
        if (!pid) pid = bestMatch(l.name, products, aliases).id;
        const price = l.unit_price || (l.total && l.qty ? l.total / l.qty : 0);
        run('INSERT INTO ticket_lines(ticket_id, raw_name, product_id, qty, price, customer, note) VALUES(?,?,?,?,?,?,?)',
          ticketId, l.name, pid || null, l.qty || 0, C.r2(price), l.customer || '', l.note || '');
      }
      run("UPDATE tickets SET status = 'draft', ocr_error = '' WHERE id = ?", ticketId);
    });
  } catch (e) {
    run("UPDATE tickets SET status = 'draft', ocr_error = ? WHERE id = ?", String(e.message || e), ticketId);
  }
  rebuildTicketSales(ticketId);
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
function transfer(u, { date, item_id, qty, note }) {
  const item = get('SELECT * FROM items WHERE id = ?', item_id) || bad('الصنف غير موجود');
  qty = num(qty, 'الكمية'); if (!qty) bad('حط الكمية');
  const ref = 'tr:' + crypto.randomUUID();
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
  const lines = (b.lines || []).filter(l => l.item_id && Number(l.qty));
  const image = b.image ? saveImage(b.image) : '';
  const total = C.r2(b.total != null && b.total !== '' && !lines.length ? Number(b.total) : lines.reduce((s, l) => s + Number(l.qty) * Number(l.unit_price || 0), 0));
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
      const qty = num(l.qty), price = Number(l.unit_price) || 0;
      run('INSERT INTO purchase_lines(purchase_id, item_id, qty, unit_price, to_floor) VALUES(?,?,?,?,?)', id, l.item_id, qty, price, l.to_floor ? 1 : 0);
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
  return all('SELECT id, name, role, salary, active FROM users ORDER BY active DESC, id').map(u => {
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
R('GET', '/api/login-users', () => all("SELECT id, name, role FROM users WHERE active = 1 ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'supervisor' THEN 1 ELSE 2 END, id"), { public: true });
R('POST', '/api/login', ({ body, res }) => {
  const u = get('SELECT * FROM users WHERE id = ? AND active = 1', Number(body.user_id));
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
  has_ai: !!(getSetting('anthropic_key') || process.env.ANTHROPIC_API_KEY),
  has_loyverse: !!getSetting('loyverse_token'),
}));
R('POST', '/api/me/pin', ({ u, body }) => {
  if (!/^\d{4,8}$/.test(String(body.pin || ''))) bad('الرقم السري ٤ إلى ٨ أرقام');
  run('UPDATE users SET pin = ? WHERE id = ?', String(body.pin), u.id); return { ok: true };
});

// ---- الرئيسية ----
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
  };
  if (isSup(u)) {
    const rep = C.dailyReport(date);
    out.money = rep.money; out.alerts = rep.alerts;
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
  return all('SELECT i.*, s.name AS section FROM items i LEFT JOIN sections s ON s.id = i.section_id WHERE i.active = 1 ORDER BY s.sort, i.sort, i.id').map(i => ({
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
R('GET', '/api/items', () => {
  const comps = all('SELECT c.*, i.name AS component, i.unit FROM item_components c JOIN items i ON i.id = c.component_id');
  const costs = C.itemCostMap();
  return all('SELECT i.*, s.name AS section FROM items i LEFT JOIN sections s ON s.id = i.section_id WHERE i.active = 1 ORDER BY s.sort, i.sort, i.id')
    .map(i => ({ ...i, unit_cost: C.r3(costs.get(i.id) || 0), components: comps.filter(c => c.item_id === i.id) }));
});
R('POST', '/api/items', ({ u, body }) => {
  needPurch(u);
  const name = String(body.name || '').trim(); if (!name) bad('حط اسم الصنف');
  const f = [name, body.unit || 'حبة', optNum(body.section_id), body.kind === 'prepared' ? 'prepared' : 'raw', Number(body.cost) || 0, Number(body.sale_value) || 0,
    body.carry_over ? 1 : 0, body.daily ? 1 : 0, optNum(body.opening_user_id), optNum(body.closing_user_id), body.note || ''];
  if (body.id) { run('UPDATE items SET name=?, unit=?, section_id=?, kind=?, cost=?, sale_value=?, carry_over=?, daily=?, opening_user_id=?, closing_user_id=?, note=? WHERE id=?', ...f, Number(body.id)); return { id: Number(body.id) }; }
  const sort = (get('SELECT MAX(sort) AS m FROM items').m || 0) + 1;
  return { id: Number(run('INSERT INTO items(name, unit, section_id, kind, cost, sale_value, carry_over, daily, opening_user_id, closing_user_id, note, sort) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', ...f, sort).lastInsertRowid) };
});
R('DELETE', '/api/items/:id', ({ u, params }) => {
  needSup(u);
  const id = Number(params.id);
  const used = get('SELECT 1 AS x FROM moves WHERE item_id = ? UNION SELECT 1 FROM counts WHERE item_id = ? LIMIT 1', id, id);
  tx(() => {
    run('DELETE FROM recipe_lines WHERE item_id = ?', id);
    run('DELETE FROM item_components WHERE item_id = ? OR component_id = ?', id, id);
    if (used) run('UPDATE items SET active = 0 WHERE id = ?', id); else run('DELETE FROM items WHERE id = ?', id);
  });
  recomputeRecent();
  return { ok: true };
});
R('PUT', '/api/items/:id/components', ({ u, params, body }) => {
  needPurch(u);
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
R('GET', '/api/users', ({ u }) => { needSup(u); return all('SELECT id, name, role, salary, active' + (isOwner(u) ? ', pin' : '') + ' FROM users ORDER BY active DESC, id'); });
R('POST', '/api/users', ({ u, body }) => {
  needOwner(u);
  const name = String(body.name || '').trim(); if (!name) bad('حط الاسم');
  const role = ['owner', 'supervisor', 'purchaser', 'worker'].includes(body.role) ? body.role : 'worker';
  const pin = String(body.pin || '0000');
  if (!/^\d{4,8}$/.test(pin)) bad('الرقم السري ٤ إلى ٨ أرقام');
  if (body.id) {
    if (Number(body.id) === u.id && role !== 'owner') bad('ما تقدر تشيل صلاحية المالك عن نفسك');
    run('UPDATE users SET name=?, role=?, pin=?, salary=?, active=? WHERE id=?', name, role, pin, Number(body.salary) || 0, body.active === false || body.active === 0 ? 0 : 1, Number(body.id));
    return { id: Number(body.id) };
  }
  return { id: Number(run('INSERT INTO users(name, role, pin, salary) VALUES(?,?,?,?)', name, role, pin, Number(body.salary) || 0).lastInsertRowid) };
});

// ---- أصناف البيع والوصفات ----
R('GET', '/api/products', ({ u, q }) => {
  needSup(u);
  const costs = C.itemCostMap(), recipes = C.recipeMap();
  const items = new Map(all('SELECT id, name, unit FROM items').map(i => [i.id, i]));
  return all(`SELECT * FROM products WHERE active = 1 ${q.all ? '' : ''} ORDER BY category, name, variant`).map(p => ({
    ...p,
    lines: (recipes.get(p.id) || []).map(l => ({ ...l, item: items.get(l.item_id)?.name, unit: items.get(l.item_id)?.unit, cost: C.r2(l.qty * (costs.get(l.item_id) || 0)) })),
    cost: C.r2(C.productCost(p.id, recipes, costs)),
  }));
});
R('POST', '/api/recipe-lines', ({ u, body }) => {
  needSup(u);
  const pid = Number(body.product_id), iid = Number(body.item_id);
  if (!get('SELECT 1 AS x FROM products WHERE id = ?', pid)) bad('صنف البيع غير موجود');
  if (!get('SELECT 1 AS x FROM items WHERE id = ? AND active = 1', iid)) bad('اختر المكوّن من قائمة المخزون');
  const id = Number(run('INSERT INTO recipe_lines(product_id, item_id, qty, source) VALUES(?,?,?,?)', pid, iid, num(body.qty, 'الكمية'), body.source === 'warehouse' ? 'warehouse' : 'floor').lastInsertRowid);
  run("UPDATE products SET recipe_status = 'ok' WHERE id = ?", pid);
  recomputeRecent();
  return { id };
});
R('PATCH', '/api/recipe-lines/:id', ({ u, params, body }) => {
  needSup(u);
  const l = get('SELECT * FROM recipe_lines WHERE id = ?', Number(params.id)) || bad('غير موجود');
  run('UPDATE recipe_lines SET item_id=?, qty=?, source=? WHERE id=?', Number(body.item_id ?? l.item_id), num(body.qty ?? l.qty, 'الكمية'), (body.source ?? l.source) === 'warehouse' ? 'warehouse' : 'floor', l.id);
  run("UPDATE products SET recipe_status = 'ok' WHERE id = ?", l.product_id);
  recomputeRecent();
  return { ok: true };
});
R('DELETE', '/api/recipe-lines/:id', ({ u, params }) => {
  needSup(u);
  run('DELETE FROM recipe_lines WHERE id = ?', Number(params.id));
  recomputeRecent();
  return { ok: true };
});
R('POST', '/api/products/:id/status', ({ u, params, body }) => { needSup(u); run('UPDATE products SET recipe_status = ? WHERE id = ?', body.status === 'ok' ? 'ok' : 'draft', Number(params.id)); return { ok: true }; });
R('POST', '/api/products/:id/copy-recipe', ({ u, params, body }) => {
  needSup(u);
  const to = Number(params.id), from = Number(body.from);
  tx(() => { for (const l of all('SELECT * FROM recipe_lines WHERE product_id = ?', from)) run('INSERT INTO recipe_lines(product_id, item_id, qty, source) VALUES(?,?,?,?)', to, l.item_id, l.qty, l.source); });
  run("UPDATE products SET recipe_status = 'ok' WHERE id = ?", to);
  recomputeRecent();
  return { ok: true };
});
R('GET', '/api/note-rules', ({ u }) => { needSup(u); return all('SELECT r.*, p.name AS product, p.variant FROM note_rules r LEFT JOIN products p ON p.id = r.product_id').map(r => ({ ...r, only: C.safeJSON(r.only_items, []) })); });
R('POST', '/api/note-rules', ({ u, body }) => {
  needSup(u);
  const kw = String(body.keyword || '').trim(); if (!kw) bad('حط كلمة الملاحظة');
  run('INSERT INTO note_rules(product_id, keyword, only_items) VALUES(?,?,?)', optNum(body.product_id), kw, JSON.stringify((body.only || []).map(Number)));
  recomputeRecent(); return { ok: true };
});
R('DELETE', '/api/note-rules/:id', ({ u, params }) => { needSup(u); run('DELETE FROM note_rules WHERE id = ?', Number(params.id)); recomputeRecent(); return { ok: true }; });

// ---- المبيعات والتقرير (للمشرفين بس) ----
R('GET', '/api/sales', ({ u, q }) => { needSup(u); return C.mergedSales(dateOr(q.date)); });
R('GET', '/api/report', ({ u, q }) => { needSup(u); return C.dailyReport(dateOr(q.date)); });
R('GET', '/api/days', ({ u }) => {
  needSup(u);
  const dates = all(`SELECT date FROM (SELECT date FROM sales UNION SELECT date FROM counts UNION SELECT date FROM tickets UNION SELECT date FROM purchases) GROUP BY date ORDER BY date DESC LIMIT 120`);
  return dates.map(({ date }) => ({
    date,
    sales: C.r2(get('SELECT SUM(amount) AS a FROM sales WHERE date = ?', date).a),
    tickets: C.r2(get("SELECT SUM(amount) AS a FROM sales WHERE date = ? AND source = 'ticket'", date).a),
    closed: dayClosed(date),
  }));
});
R('POST', '/api/cash', ({ u, body }) => {
  needSup(u);
  const date = dateOr(body.date);
  run(`INSERT INTO cash_counts(date, cash, card, note, user_id, at) VALUES(?,?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET cash=excluded.cash, card=excluded.card, note=excluded.note, user_id=excluded.user_id, at=excluded.at`,
    date, Number(body.cash) || 0, Number(body.card) || 0, body.note || '', u.id, nowISO());
  return { ok: true };
});
R('POST', '/api/day/close', ({ u, body }) => {
  needSup(u);
  const date = dateOr(body.date);
  if (body.undo) { needOwner(u); run('DELETE FROM day_status WHERE date = ?', date); C.rebuildSaleUse(date); return { ok: true }; }
  C.rebuildSaleUse(date);
  tx(() => {
    run("UPDATE tickets SET status = 'confirmed', confirmed_by = ?, confirmed_at = ? WHERE date = ? AND status = 'draft'", u.id, nowISO(), date);
    run('INSERT INTO day_status(date, closed_by, closed_at) VALUES(?,?,?) ON CONFLICT DO NOTHING', date, u.id, nowISO());
  });
  return { ok: true };
});

// ---- التذاكر ----
R('GET', '/api/tickets', ({ u, q }) => { needSup(u); return all('SELECT * FROM tickets WHERE date = ? ORDER BY id DESC', dateOr(q.date)).map(ticketView); });
R('GET', '/api/tickets/:id', ({ u, params }) => { needSup(u); const t = get('SELECT * FROM tickets WHERE id = ?', Number(params.id)) || bad('غير موجود'); return ticketView(t); });
R('POST', '/api/tickets', ({ u, body }) => {
  needSup(u);
  const date = dateOr(body.date);
  const imgs = (body.images || []).map(saveImage);
  const id = Number(run("INSERT INTO tickets(date, status, created_by) VALUES(?,?,?)", date, imgs.length ? 'reading' : 'draft', u.id).lastInsertRowid);
  for (const p of imgs) run('INSERT INTO ticket_images(ticket_id, path) VALUES(?,?)', id, p);
  if (imgs.length) ocrTicket(id, imgs); // يشتغل بالخلفية — الصفحة ما تعلق
  return { id };
});
R('POST', '/api/tickets/:id/images', ({ u, params, body }) => {
  needSup(u);
  const id = Number(params.id);
  const t = get('SELECT * FROM tickets WHERE id = ?', id) || bad('غير موجود');
  if (t.status === 'confirmed' && !isOwner(u)) forbid('التذكرة متأكدة');
  const imgs = (body.images || []).map(saveImage);
  for (const p of imgs) run('INSERT INTO ticket_images(ticket_id, path) VALUES(?,?)', id, p);
  if (imgs.length) { run("UPDATE tickets SET status = 'reading' WHERE id = ?", id); ocrTicket(id, imgs); }
  return { ok: true };
});
R('PUT', '/api/tickets/:id/lines', ({ u, params, body }) => {
  needSup(u);
  const id = Number(params.id);
  const t = get('SELECT * FROM tickets WHERE id = ?', id) || bad('غير موجود');
  if (t.status === 'confirmed' && !isOwner(u)) forbid('التذكرة متأكدة');
  if (dayClosed(t.date) && !isOwner(u)) forbid('اليوم مقفل');
  tx(() => {
    run('DELETE FROM ticket_lines WHERE ticket_id = ?', id);
    for (const l of body.lines || []) {
      const pid = optNum(l.product_id);
      if (!Number(l.price) && pid) l.price = (get('SELECT price FROM products WHERE id = ?', pid) || {}).price || 0;
      run('INSERT INTO ticket_lines(ticket_id, raw_name, product_id, qty, price, customer, note, only_items) VALUES(?,?,?,?,?,?,?,?)',
        id, l.raw_name || '', pid, Number(l.qty) || 0, Number(l.price) || 0, l.customer || '', l.note || '', l.only_items && l.only_items.length ? JSON.stringify(l.only_items.map(Number)) : '');
      // يتعلم: الاسم المكتوب => الصنف (عشان المرة الجاية يربطه لحاله)
      if (pid && l.raw_name && normalize(l.raw_name)) run('INSERT INTO product_aliases(alias, product_id) VALUES(?,?) ON CONFLICT(alias) DO UPDATE SET product_id = excluded.product_id', normalize(l.raw_name), pid);
    }
  });
  rebuildTicketSales(id);
  return ticketView(get('SELECT * FROM tickets WHERE id = ?', id));
});
R('POST', '/api/tickets/:id/confirm', ({ u, params, body }) => {
  needSup(u);
  const id = Number(params.id);
  if (body.undo) run("UPDATE tickets SET status = 'draft', confirmed_by = NULL, confirmed_at = NULL WHERE id = ?", id);
  else {
    if (get('SELECT 1 AS x FROM ticket_lines WHERE ticket_id = ? AND product_id IS NULL', id)) bad('فيه أسطر ما انربطت بصنف');
    run("UPDATE tickets SET status = 'confirmed', confirmed_by = ?, confirmed_at = ? WHERE id = ?", u.id, nowISO(), id);
  }
  return { ok: true };
});
R('DELETE', '/api/tickets/:id', ({ u, params }) => {
  needSup(u);
  const id = Number(params.id);
  const t = get('SELECT * FROM tickets WHERE id = ?', id) || bad('غير موجود');
  if (t.status === 'confirmed' && !isOwner(u)) forbid('التذكرة متأكدة');
  run('DELETE FROM tickets WHERE id = ?', id);
  rebuildTicketSales(id);
  C.rebuildSaleUse(t.date);
  return { ok: true };
});

// ---- الديون (التذكرة = آجل) ----
R('GET', '/api/debts', ({ u }) => {
  needSup(u);
  const owed = all(`SELECT COALESCE(NULLIF(l.customer, ''), 'بدون اسم') AS customer, SUM(l.qty * COALESCE(NULLIF(l.price, 0), p.price, 0)) AS amount, MAX(t.date) AS last_date
    FROM ticket_lines l JOIN tickets t ON t.id = l.ticket_id LEFT JOIN products p ON p.id = l.product_id GROUP BY 1`);
  const paid = new Map(all("SELECT COALESCE(NULLIF(customer, ''), 'بدون اسم') AS customer, SUM(amount) AS a FROM debt_payments GROUP BY 1").map(r => [r.customer, r.a]));
  const rows = owed.map(o => ({ customer: o.customer, owed: C.r2(o.amount), paid: C.r2(paid.get(o.customer) || 0), balance: C.r2(o.amount - (paid.get(o.customer) || 0)), last_date: o.last_date }));
  for (const [c, a] of paid) if (!rows.find(r => r.customer === c)) rows.push({ customer: c, owed: 0, paid: C.r2(a), balance: -C.r2(a) });
  return { rows: rows.sort((a, b) => b.balance - a.balance), payments: all('SELECT d.*, u.name AS user FROM debt_payments d LEFT JOIN users u ON u.id = d.user_id ORDER BY id DESC LIMIT 200') };
});
R('POST', '/api/debts/pay', ({ u, body }) => {
  needSup(u);
  run('INSERT INTO debt_payments(date, customer, amount, note, user_id, paid_cash) VALUES(?,?,?,?,?,?)', dateOr(body.date), body.customer || '', num(body.amount, 'المبلغ'), body.note || '', u.id, body.paid_cash === false ? 0 : 1);
  return { ok: true };
});
R('DELETE', '/api/debts/pay/:id', ({ u, params }) => { needSup(u); run('DELETE FROM debt_payments WHERE id = ?', Number(params.id)); return { ok: true }; });

// ---- المشتريات ----
R('GET', '/api/purchases', ({ u, q }) => {
  const from = isDate(q.from) ? q.from : C.addDays(C.businessDate(), -30), to = isDate(q.to) ? q.to : C.businessDate();
  const rows = all(`SELECT p.*, us.name AS user FROM purchases p LEFT JOIN users us ON us.id = p.user_id WHERE date BETWEEN ? AND ? ${isPurch(u) ? '' : 'AND p.user_id = ' + Number(u.id)} ORDER BY date DESC, id DESC`, from, to);
  return rows.map(p => ({ ...p, lines: all('SELECT l.*, i.name AS item, i.unit FROM purchase_lines l LEFT JOIN items i ON i.id = l.item_id WHERE purchase_id = ?', p.id) }));
});
R('POST', '/api/purchases', ({ u, body }) => savePurchase(u, body));
R('DELETE', '/api/purchases/:id', ({ u, params }) => {
  const p = get('SELECT * FROM purchases WHERE id = ?', Number(params.id)) || bad('غير موجود');
  if (!isPurch(u) && !(p.user_id === u.id && p.date === C.businessDate())) forbid();
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
      -SUM(CASE WHEN m.type IN ('transfer','prep_use','sale_use') AND m.location = 'warehouse' THEN m.qty ELSE 0 END) AS used,
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
    .map(p => ({ ...p, lines: all('SELECT l.qty, l.unit_price, i.name AS item, i.unit FROM purchase_lines l LEFT JOIN items i ON i.id = l.item_id WHERE purchase_id = ?', p.id) }));
  const payments = all('SELECT sp.*, us.name AS user FROM supplier_payments sp LEFT JOIN users us ON us.id = sp.user_id WHERE sp.supplier_id = ? ORDER BY sp.date DESC, sp.id DESC', id);
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
const SETTING_KEYS = ['loyverse_token', 'anthropic_key', 'day_start_hour', 'sync_days_back', 'opening_deadline_hour', 'restaurant_name'];
R('GET', '/api/settings', ({ u }) => {
  needOwner(u);
  const s = {}; for (const k of SETTING_KEYS) s[k] = getSetting(k);
  for (const k of ['loyverse_token', 'anthropic_key']) s[k] = s[k] ? '••••' + s[k].slice(-4) : '';
  s.last_receipt_sync = getSetting('last_receipt_sync');
  s.log = all('SELECT * FROM sync_log ORDER BY id DESC LIMIT 20');
  return s;
});
R('POST', '/api/settings', ({ u, body }) => {
  needOwner(u);
  let tokenChanged = false;
  for (const k of SETTING_KEYS) if (body[k] != null && !String(body[k]).startsWith('••••')) {
    if (k === 'loyverse_token' && body[k] !== getSetting(k)) tokenChanged = true;
    setSetting(k, String(body[k]).trim());
  }
  if (tokenChanged) { setSetting('last_receipt_sync', ''); L.syncAll({ full: true }); }
  return { ok: true };
});
R('POST', '/api/sync', async ({ u, body }) => { needSup(u); return await L.syncAll({ full: !!body.full }); });

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
  return get('SELECT u.id, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.active = 1', token) || null;
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
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'صار خطأ في السيرفر: ' + e.message : e.message });
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
