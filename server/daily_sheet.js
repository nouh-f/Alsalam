'use strict';
// 📊 «حساب اليوم»: ورقة آخر اليوم (كمبيوتر + كاش + خرج = المجموع) تنزل في الجروب => نقرأها، نحفظها، ونرد بالتقرير في نفس الجروب
// المفروض يوصل = مبيعات الطابعة − التذاكر اللي باسم (أخذوها باسمهم)، ونقارنه بالورقة
const { get, all, run } = require('./db');
const AI = require('./ai');
const C = require('./calc');
const PR = require('./printer_read');
const { readSheet } = require('./sheet');

const WD = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const M = n => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
const daysApart = (a, b) => Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 864e5;

function summary(date, sheet) {
  const t = PR.tickets(date, date);
  const live = t.tickets.filter(x => !['cancelled', 'cancel_only'].includes(x.status));
  const sales = C.r2(live.reduce((s, x) => s + (x.value || 0), 0));
  const named = PR.customers(date).customers.filter(c => c.total > 0).map(c => {
    const items = new Map();
    for (const k of c.tickets) if (k.status !== 'cancelled') for (const l of k.items) items.set(l.name, C.r3((items.get(l.name) || 0) + l.qty));
    return { name: c.name, total: c.total, items: [...items].map(([n, q]) => `${q} ${n}`) };
  });
  const namedTotal = C.r2(named.reduce((s, c) => s + c.total, 0));
  const expected = C.r2(sales - namedTotal);
  const paper = C.r2((sheet.card || 0) + (sheet.cash || 0) + (sheet.transfer || 0) + (sheet.spent || 0));
  const diff = C.r2(expected - paper);
  return { date, sales, tickets: live.length, named, namedTotal, expected, paper, diff, ...sheet };
}

function text(s) {
  const d = new Date(s.date + 'T00:00:00Z');
  const L = [`📊 *حساب اليوم — ${WD[d.getUTCDay()]} ${s.date}*`, '', `🖨️ المبيعات من الطابعة: *${M(s.sales)}* (${s.tickets} طلب)`, ''];
  if (s.named.length) {
    L.push(`👤 *اللي أخذوا باسم (${s.named.length}):*`);
    for (const c of s.named) L.push(`• ${c.name} — *${M(c.total)}*: ${c.items.join('، ')}`);
    L.push(`المجموع باسم: *${M(s.namedTotal)}*`, '');
  } else L.push('👤 ما فيه تذاكر باسم', '');
  L.push(`✅ المفروض يوصل (المبيعات − اللي باسم): *${M(s.expected)}*`, '', '📄 *الورقة:*',
    `💳 كمبيوتر: ${s.card == null ? '—' : M(s.card)}`, `💵 كاش: ${s.cash == null ? '—' : M(s.cash)}`, ...(s.transfer ? [`🏦 تحويل: ${M(s.transfer)}`] : []), `💸 خرج: ${s.spent == null ? '—' : M(s.spent)}`,
    `= *${M(s.paper)}*${s.total_written != null && Math.abs(s.total_written - s.paper) > 0.5 ? ` ⚠️ (المكتوب في الورقة ${M(s.total_written)} — الجمع غلط)` : ''}`, '');
  L.push(Math.abs(s.diff) <= 0.5 ? '⚖️ *مطابق* ✓' : s.diff > 0 ? `⚖️ *نقص ${M(s.diff)} ريال* 🔴` : `⚖️ *زيادة ${M(-s.diff)} ريال*`);
  return L.join('\n');
}

// سطور الورقة => مصاريف من الدرج / سحب من الراتب / مكافآت / سداد مورد. كلها معلّمة «[ورقة <اليوم>]»
// عشان لو الورقة نزلت مرة ثانية تنمسح وتنسجل من جديد (ما تتكرر)
const TAG = date => `[ورقة ${date}]`;
function clearSheet(date) {
  const like = `%${TAG(date)}%`;
  for (const e of all('SELECT id, payroll_id FROM expenses WHERE date = ? AND note LIKE ? AND note NOT LIKE ?', date, like, '%[تعديل]%')) {
    if (e.payroll_id) run('DELETE FROM payroll WHERE id = ?', e.payroll_id);
    run('DELETE FROM expenses WHERE id = ?', e.id);
  }
  run('DELETE FROM supplier_payments WHERE date = ? AND note LIKE ?', date, like);
  run('DELETE FROM cash_custody WHERE date = ? AND note LIKE ? AND note NOT LIKE ?', date, like, '%[تعديل]%');
  for (const p of all('SELECT id FROM purchases WHERE date = ? AND note LIKE ? AND note NOT LIKE ?', date, like, '%[تعديل]%')) {
    run('DELETE FROM moves WHERE ref = ?', 'pu:' + p.id); run('DELETE FROM purchase_lines WHERE purchase_id = ?', p.id); run('DELETE FROM purchases WHERE id = ?', p.id);
  }
}
// 🎯 السطور ما تنسجل لحالها: تصير كرت واحد لنوح في الخاص (مرقّم) — يعدّله بالأرقام («3 = 120»، «احذف 3»…)
// و«تمام» يسجلها كلها، «لا» يلغيها. السطور محفوظة في الكرت (items) والنص والطلبات تنبني منها كل مرة
// (أول طلب يمسح اللي انسجل قبل من نفس الورقة — عشان لو الورقة نزلت مرتين ما يتكرر شي)
const KINDS = { expense: '💸 مصاريف من الدرج', purchase: '🛒 بضاعة (تدخل المخزون)', custody: '👛 عهدة', supplier: '📒 سداد موردين', salary: '👤 سحب من الراتب', bonus: '🎁 مكافآت' };
function renderSheetCard(card) {
  const tag = TAG(card.date) + (card.edit ? ' [تعديل]' : '');
  const requests = card.edit ? [] : [{ endpoint: '/api/sheet/clear', body: { date: card.date } }];
  const g = Object.fromEntries(Object.keys(KINDS).map(k => [k, []]));
  for (const it of card.items) {
    const note = `${it.text} — من ورقة ${card.by} ${tag}`;
    const miss = (it.kind === 'salary' || it.kind === 'custody') && !it.employee_id;
    if (!miss) {
      if (it.kind === 'custody') requests.push({ endpoint: '/api/custody', body: { date: card.date, user_id: it.employee_id, amount: it.amount, from_drawer: 1, note } });
      else if (it.kind === 'purchase') requests.push({ endpoint: '/api/purchases', body: { date: card.date, payment: 'cash', note, lines: [{ item_id: it.item_id, qty: it.qty, line_total: it.amount }] } });
      else if (it.kind === 'salary') requests.push({ endpoint: '/api/expenses', body: { date: card.date, amount: it.amount, kind: 'advance', employee_id: it.employee_id, payment: 'cash', note } });
      else if (it.kind === 'supplier') requests.push({ endpoint: `/api/suppliers/${it.supplier_id}/pay`, body: { date: card.date, amount: it.amount, payment: 'cash', note } });
      else requests.push({ endpoint: '/api/expenses', body: { date: card.date, amount: it.amount, category: it.kind === 'bonus' ? 'مكافآت' : (it.category || 'مصاريف'), payment: 'cash', note: it.kind === 'bonus' && it.employee_name ? `مكافأة ${it.employee_name} — ${note}` : note } });
    }
    const who = it.kind === 'salary' || it.kind === 'custody' ? (it.employee_name || '❓ مين؟') : it.kind === 'bonus' ? (it.employee_name || it.text)
      : it.kind === 'supplier' ? it.supplier : it.kind === 'purchase' ? `${it.item} ≈${M(it.qty)} ${it.unit || ''}`.trim() : it.text;
    g[it.kind].push(`${it.n}- ${who} ${M(it.amount)}${it.kind !== 'expense' && it.text !== who ? `  «${it.text}»` : ''}${it.uncertain ? ' ❓' : ''}${miss ? ` ← اكتب «${it.n} ${it.kind === 'custody' ? 'عهدة' : 'سحب'} <الاسم>»` : ''}`);
  }
  const L = [];
  if (card.problems && card.problems.length) L.push(`⚠️ الأرقام ما تركب: ${card.problems.join('؛ ')} — راجعها قبل «تمام»`);
  for (const k of Object.keys(KINDS)) if (g[k].length) L.push(`${KINDS[k]}:\n${g[k].join('\n')}`);
  if (card.skipped && card.skipped.length) L.push(`↪️ ما بيتسجل (مكرر/المشتري): ${card.skipped.join('، ')}`);
  if (card.unknown && card.unknown.length) L.push(`⚠️ بدون مبلغ: ${card.unknown.join('، ')}`);
  const total = card.items.reduce((t, it) => t + it.amount, 0);
  card.lines = L; card.requests = requests;
  card.title = `${card.edit ? 'تعديل ' : ''}ورقة حساب اليوم ${card.date} (${card.items.length} سطر = ${M(total)})`;
  return card;
}
// 🛒 البضاعة: الكمية التقريبية = المبلغ ÷ آخر سعر (لو ما فيه سعر: ١) — نوح يصححها بـ«N عدد 120»
function goods(itemId, amount) {
  const it = get('SELECT id, name, unit FROM items WHERE id = ?', itemId) || { id: itemId, name: '؟', unit: '' };
  const cost = C.itemCostMap().get(it.id) || 0;
  return { item_id: it.id, item: it.name, unit: it.unit, qty: cost > 0 ? Math.max(1, Math.round(amount / cost)) : 1 };
}
function sheetCard(lines, { date, by, edit = false, problems = [] }) {
  const items = [], skipped = [], unknown = [];
  for (const l of lines) {
    const amount = Number(l.amount) || 0;
    if (!(amount > 0) || l.kind === 'taken') { if (amount > 0) skipped.push(`${l.text} (أخذها المشتري)`); else unknown.push(`«${l.text}»`); continue; }
    if (l.dup) { skipped.push(`${l.text} (مسجّل قبل: ${l.dup})`); continue; }
    const kind = ['salary', 'bonus', 'custody'].includes(l.kind) ? l.kind : l.kind === 'supplier' && l.supplier_id ? 'supplier' : l.kind === 'purchase' && l.item_id ? 'purchase' : 'expense';
    items.push({ n: items.length + 1, kind, text: l.text, amount, uncertain: !!l.uncertain, employee_id: l.employee_id || null, employee_name: l.employee_name || '',
      supplier_id: kind === 'supplier' ? l.supplier_id : null, supplier: l.supplier || '', category: l.kind === 'purchase' ? 'مشتريات' : (l.category || ''), ...(kind === 'purchase' ? goods(l.item_id, amount) : {}) });
  }
  if (!items.length) return null;
  return renderSheetCard({ id: 's' + Date.now(), type: 'sheet', sheet: true, date, by: by.name, edit, items, skipped, unknown, problems });
}

// ✏️ نوح يعدّل الكرت بالأرقام: «3 = 120» · «احذف 3» · «3 سحب صابر» / «3 مكافأة صابر» / «3 مصروف» · «زيد غاز 50» / «زيد سحب باسم 100»
const AR = s => String(s || '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/٫/g, '.').trim();
const KIND_W = w => /^سحب/.test(w) ? 'salary' : /^مكاف/.test(w) ? 'bonus' : /^عهد/.test(w) ? 'custody' : /^بضاع/.test(w) ? 'purchase' : /^(مصروف|مصاريف|خرج)/.test(w) ? 'expense' : null;
function editSheetCard(card, text) {
  const t = AR(text);
  const staff = all('SELECT id, name FROM users WHERE active = 1 AND bot = 0');
  const who = q => { const r = require('./assistant').resolveItem(q, staff); return r.item || null; };
  const find = n => card.items.find(x => x.n === Number(n));
  let m;
  if ((m = /^(?:سطر\s*)?(\d+)\s*(?:=|:|بـ|ب)?\s*(\d+(?:\.\d+)?)\s*(?:ريال)?$/.exec(t))) {
    const it = find(m[1]); if (!it) return { err: `ما فيه سطر ${m[1]}` };
    it.amount = Number(m[2]); it.uncertain = false; return { ok: `✓ ${it.n} صار ${M(it.amount)}` };
  }
  if ((m = /^(?:احذف|شيل|امسح|الغ(?:ي|ى)?)\s*(?:سطر\s*)?(\d+)$/.exec(t))) {
    const it = find(m[1]); if (!it) return { err: `ما فيه سطر ${m[1]}` };
    card.items = card.items.filter(x => x !== it); return { ok: `✓ انشال ${it.n} (${it.text})` };
  }
  if ((m = /^(?:سطر\s*)?(\d+)\s+(?:عدد|كمية)\s*(\d+(?:\.\d+)?)$/.exec(t))) {
    const it = find(m[1]); if (!it) return { err: `ما فيه سطر ${m[1]}` };
    if (it.kind !== 'purchase') return { err: `${it.n} مو بضاعة — العدد للبضاعة بس` };
    it.qty = Number(m[2]); return { ok: `✓ ${it.n} صار ${M(it.qty)} ${it.unit || ''}`.trim() };
  }
  if ((m = /^(?:سطر\s*)?(\d+)\s+(سحب\S*|مكاف\S*|عهد\S*|بضاع\S*|مصروف|مصاريف)\s*(.*)$/.exec(t))) {
    const it = find(m[1]); if (!it) return { err: `ما فيه سطر ${m[1]}` };
    const kind = KIND_W(m[2]);
    if (kind === 'purchase') {
      const its = all("SELECT id, name FROM items WHERE active = 1 AND kind = 'raw'");
      const r = m[3] ? require('./assistant').resolveItem(m[3], its) : {};
      if (!r.item) return { err: `وش الصنف؟ مثال: «${it.n} بضاعة لحوح»` };
      Object.assign(it, { kind, employee_id: null, employee_name: '' }, goods(r.item.id, it.amount));
    } else if (kind === 'salary' || kind === 'bonus' || kind === 'custody') {
      const p = m[3] ? who(m[3]) : null;
      if (kind !== 'bonus' && !p) return { err: `مين «${m[3] || '؟'}»؟ اكتب الاسم مثل ما هو في النظام` };
      it.kind = kind; it.employee_id = p ? p.id : null; it.employee_name = p ? p.name : '';
    } else { it.kind = 'expense'; it.employee_id = null; it.employee_name = ''; }
    return { ok: `✓ ${it.n} صار ${KINDS[it.kind].replace(/^\S+ /, '')}${it.employee_name ? ' — ' + it.employee_name : ''}` };
  }
  if ((m = /^(?:زيد|زد|اضف|أضف|ضيف|زود)\s+(?:(سحب\S*|مكاف\S*|عهد\S*)\s+)?(.+?)\s+(\d+(?:\.\d+)?)$/.exec(t))) {
    const kind = m[1] ? KIND_W(m[1]) : 'expense';
    const p = kind !== 'expense' ? who(m[2]) : null;
    if ((kind === 'salary' || kind === 'custody') && !p) return { err: `مين «${m[2]}»؟ اكتب الاسم مثل ما هو في النظام` };
    const n = card.items.reduce((x, it) => Math.max(x, it.n), 0) + 1;
    card.items.push({ n, kind, text: m[2], amount: Number(m[3]), uncertain: false, employee_id: p ? p.id : null, employee_name: p ? p.name : '', supplier_id: null, supplier: '', category: '' });
    return { ok: `✓ انضاف ${n}- ${p ? p.name : m[2]} ${M(Number(m[3]))}` };
  }
  return null;
}
const EDIT_HELP = 'تعدّل: «3 = 120» · «احذف 3» · «3 سحب صابر» · «3 عهدة إبراهيم» · «3 بضاعة لحوح» · «3 عدد 100» · «زيد غاز 50»';
// رسالة الكرت لنوح
function cardMessage(card, head = '') {
  return [head || `📋 ${card.title}`, '', ...card.lines, '', 'رد *تمام* عشان أسجلها كلها (المصاريف وسحب الرواتب)، أو *لا*.', EDIT_HELP].join('\n');
}
function ownerText(date, s, card, by, edit, problems = []) {
  const L = [`📋 ${edit ? 'تعديل ' : ''}ورقة حساب اليوم ${date} (${by.name})`];
  if (!edit) L.push(`💳 كمبيوتر ${s.card == null ? '—' : M(s.card)} · 💵 كاش ${s.cash == null ? '—' : M(s.cash)}${s.transfer ? ` · 🏦 تحويل ${M(s.transfer)}` : ''} · 💸 خرج ${s.spent == null ? '—' : M(s.spent)} = *${M(s.paper)}*${s.total_written != null && Math.abs(s.total_written - s.paper) > 1 ? ` ⚠️ (المكتوب ${M(s.total_written)})` : ''}`);
  if (!card) { if (problems.length) L.push(`⚠️ الأرقام ما تركب: ${problems.join('؛ ')}`); L.push('ما فيه سطور تنسجل.'); return L.join('\n'); }
  card.head = L.join('\n');
  return cardMessage(card, card.head);
}

// صورة في جروب «حساب اليوم»: لو هي ورقة الحساب (فيها كمبيوتر/كاش ومجموع/خرج) => المجاميع تنحفظ ويطلع التقرير،
// والسطور كرت لنوح يأكده (ما ينسجل شي لحاله)
async function handle({ by, images, runAs, now = new Date() }) {
  const today = C.businessDate(now);
  const r = await readSheet(by, images, today, { people: true });
  const isTotals = (r.card != null || r.cash != null) && (r.total_written != null || r.spent != null);
  if (!isTotals) return null;
  const date = isDate(r.date) && daysApart(r.date, today) <= 2 ? r.date : today;
  const sheet = { card: r.card, cash: r.cash, transfer: r.transfer || 0, spent: r.spent, total_written: r.total_written };
  const owner = get("SELECT * FROM users WHERE role = 'owner' AND active = 1 AND bot = 0 ORDER BY id LIMIT 1");
  if (owner) await runAs(owner, '/api/cash', { date, card: sheet.card || 0, cash: sheet.cash || 0, transfer: sheet.transfer, spent: sheet.spent || 0, total: sheet.total_written || '', image: images[0], note: `من الورقة — ${by.name} (جروب حساب اليوم)` });
  const s = summary(date, sheet);
  const card = sheetCard((r.lines || []).filter(l => !l.date || l.date === date), { date, by, problems: r.problems || [] });
  const warn = (r.problems || []).length ? `\n\n⚠️ أرقام الورقة ما تركب (${r.problems.join('؛ ')}) — راجعوها` : '';
  return { ...s, text: text(s) + warn, card, owner_text: owner ? ownerText(date, s, card, by, false, r.problems || []) : null };
}

// ✏️ تعديل مكتوب في الجروب («تعديل بالخرج… لحوح ٦٢ … اجمالي ١٦٢٦٠») => يزيد السطور على آخر ورقة ويحدّث الخرج والمجموع
const EDIT = /تعديل|تصحيح|نسي|ناقص.*الخرج|زيادة.*الخرج/;
const EDIT_SCHEMA = { type: 'object', additionalProperties: false, required: ['lines', 'total'], properties: {
  total: { type: ['number', 'null'], description: 'الإجمالي الجديد لو مكتوب، وإلا null' },
  lines: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'kind', 'amount', 'employee'], properties: {
    text: { type: 'string' }, kind: { type: 'string', enum: ['expense', 'salary', 'bonus'] }, amount: { type: 'number' },
    employee: { type: 'string', description: 'للسحب من الراتب أو المكافأة: اسم الموظف من القائمة، وإلا فارغ' } } } } } };
async function handleEdit({ by, text: msg, runAs, now = new Date() }) {
  if (!EDIT.test(msg) || !/[0-9٠-٩]/.test(msg)) return null;
  const today = C.businessDate(now);
  const cc = get('SELECT * FROM cash_counts WHERE date <= ? AND spent IS NOT NULL ORDER BY date DESC LIMIT 1', today);
  if (!cc || daysApart(cc.date, today) > 2) return null;
  const owner = get("SELECT * FROM users WHERE role = 'owner' AND active = 1 AND bot = 0 ORDER BY id LIMIT 1");
  if (!owner) return null;
  AI.checkCap();
  const staff = all("SELECT id, name FROM users WHERE active = 1 AND bot = 0 AND role != 'owner' ORDER BY id");
  const res = await AI.create('fast', { max_tokens: 800, messages: [{ role: 'user', content: `رسالة تعديل على ورقة حساب اليوم لمطعم السلام من ${by.name}:\n«${msg}»\n\nالموظفين: ${staff.map(x => x.name).join('، ')}\n\nطلّع السطور الجديدة (المصروف ومبلغه) — salary لو سحب من راتب موظف، bonus لو مكافأة، وإلا expense. total = «اجمالي» الجديد لو مكتوب. لا تخترع.` }],
    output_config: { format: { type: 'json_schema', schema: EDIT_SCHEMA } } }, { kind: 'sheet_edit', userId: by.id, maxOut: 800 });
  AI.log(by.id, 'sheet_edit', msg.slice(0, 300), '', AI.costOf(res.usage, 'fast'), AI.MODELS.fast.id);
  let p = null; try { p = JSON.parse(AI.textOf(res)); } catch { /* */ }
  const lines = ((p && p.lines) || []).filter(l => Number(l.amount) > 0).map(l => {
    const q = String(l.employee || '').trim(), emp = q ? staff.find(x => x.name === q) || staff.find(x => x.name.includes(q) || q.includes(x.name)) : null;
    return { text: String(l.text || '').trim() || '—', kind: l.kind, amount: Number(l.amount), employee_id: emp ? emp.id : null, employee_name: emp ? emp.name : '' };
  });
  if (!lines.length && !(p && p.total > 0)) return null;
  const added = C.r2(lines.reduce((t, l) => t + l.amount, 0));
  const spent = C.r2((cc.spent || 0) + added);
  const total = p && p.total > 0 ? p.total : C.r2((cc.cash || 0) + (cc.card || 0) + (cc.transfer || 0) + spent);
  await runAs(owner, '/api/cash', { date: cc.date, card: cc.card, cash: cc.cash, transfer: cc.transfer || 0, spent, total, note: `${cc.note || ''} + تعديل ${by.name}`.trim() });
  const card = sheetCard(lines, { date: cc.date, by, edit: true });
  const s = summary(cc.date, { card: cc.card, cash: cc.cash, transfer: cc.transfer || 0, spent, total_written: total });
  return { ...s, text: `✏️ تعديل ${by.name}: خرج +${M(added)}\n\n` + text(s), card, owner_text: ownerText(cc.date, s, card, by, true) };
}

module.exports = { handle, handleEdit, summary, text, clearSheet, editSheetCard, renderSheetCard, cardMessage };
