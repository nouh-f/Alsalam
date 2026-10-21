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
}
// 🎯 السطور ما تنسجل لحالها: تصير كرت واحد لنوح في الخاص (مرقّمة) — «تمام» يسجلها كلها، «لا» يلغيها
// (أول طلب في الكرت يمسح اللي انسجل قبل من نفس الورقة — عشان لو الورقة نزلت مرتين ما يتكرر شي)
function sheetCard(lines, { date, by, edit = false, problems = [] }) {
  const tag = TAG(date) + (edit ? ' [تعديل]' : '');
  const requests = edit ? [] : [{ endpoint: '/api/sheet/clear', body: { date } }];
  const g = { expenses: [], salary: [], bonus: [], supplier: [], unknown: [], skipped: [] };
  let n = 0;
  for (const l of lines) {
    const amount = Number(l.amount) || 0;
    if (!(amount > 0) || l.kind === 'taken') { if (amount > 0) g.skipped.push(`${l.text} (أخذها المشتري)`); else g.unknown.push(`«${l.text}» (بدون مبلغ)`); continue; }
    if (l.dup) { g.skipped.push(`${l.text} (مسجّل قبل: ${l.dup})`); continue; }
    const note = `${l.text} — من ورقة ${by.name} ${tag}`;
    if (l.kind === 'salary') {
      if (!l.employee_id) { g.unknown.push(`«${l.text}» ${M(amount)} (ما عرفت الموظف)`); continue; }
      requests.push({ endpoint: '/api/expenses', body: { date, amount, kind: 'advance', employee_id: l.employee_id, payment: 'cash', note } });
      g.salary.push(`${++n}- ${l.employee_name} ${M(amount)}  «${l.text}»`);
    } else if (l.kind === 'supplier' && l.supplier_id) {
      requests.push({ endpoint: `/api/suppliers/${l.supplier_id}/pay`, body: { date, amount, payment: 'cash', note } });
      g.supplier.push(`${++n}- ${l.supplier} ${M(amount)}  «${l.text}»`);
    } else {
      const category = l.kind === 'bonus' ? 'مكافآت' : (l.category || (l.kind === 'purchase' ? 'مشتريات' : 'مصاريف'));
      requests.push({ endpoint: '/api/expenses', body: { date, amount, category, payment: 'cash', note: l.kind === 'bonus' && l.employee_name ? `مكافأة ${l.employee_name} — ${note}` : note } });
      (l.kind === 'bonus' ? g.bonus : g.expenses).push(`${++n}- ${l.kind === 'bonus' ? (l.employee_name || l.text) : l.text} ${M(amount)}${l.uncertain ? ' ❓' : ''}`);
    }
  }
  const L = [];
  if (problems.length) L.push(`⚠️ الأرقام ما تركب: ${problems.join('؛ ')} — راجعها قبل «تمام»`);
  if (g.expenses.length) L.push(`💸 مصاريف من الدرج:\n${g.expenses.join('\n')}`);
  if (g.supplier.length) L.push(`📒 سداد موردين:\n${g.supplier.join('\n')}`);
  if (g.salary.length) L.push(`👤 سحب من الراتب:\n${g.salary.join('\n')}`);
  if (g.bonus.length) L.push(`🎁 مكافآت:\n${g.bonus.join('\n')}`);
  if (g.skipped.length) L.push(`↪️ ما بيتسجل (مكرر/المشتري): ${g.skipped.join('، ')}`);
  if (g.unknown.length) L.push(`⚠️ ما عرفت أسجله: ${g.unknown.join('، ')}`);
  if (!n) return null;
  return { id: 's' + Date.now(), type: 'sheet', sheet: true, title: `${edit ? 'تعديل ' : ''}ورقة حساب اليوم ${date} (${n} سطر)`, lines: L, requests };
}
// رسالة الكرت لنوح
function ownerText(date, s, card, by, edit, problems = []) {
  const L = [`📋 ${edit ? 'تعديل ' : ''}ورقة حساب اليوم ${date} (${by.name})`];
  if (!edit) L.push(`💳 كمبيوتر ${s.card == null ? '—' : M(s.card)} · 💵 كاش ${s.cash == null ? '—' : M(s.cash)}${s.transfer ? ` · 🏦 تحويل ${M(s.transfer)}` : ''} · 💸 خرج ${s.spent == null ? '—' : M(s.spent)} = *${M(s.paper)}*${s.total_written != null && Math.abs(s.total_written - s.paper) > 1 ? ` ⚠️ (المكتوب ${M(s.total_written)})` : ''}`);
  if (!card) { if (problems.length) L.push(`⚠️ الأرقام ما تركب: ${problems.join('؛ ')}`); L.push('ما فيه سطور تنسجل.'); return L.join('\n'); }
  L.push('', ...card.lines, '', 'رد *تمام* عشان أسجلها كلها (المصاريف وسحب الرواتب)، أو *لا*. الغلط تصححه من صفحة الورقة في الموقع.');
  return L.join('\n');
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

module.exports = { handle, handleEdit, summary, text, clearSheet };
