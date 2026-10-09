'use strict';
// «اسأل المساعد» + «لخّص لي اليوم» + «توصيات بكرة»
// المساعد يقرأ بس (ما يغيّر شي): أدوات تنادي نفس حسابات التطبيق
const { all, get, run } = require('./db');
const C = require('./calc');
const F = require('./forecast');
const AI = require('./ai');
const { similarity } = require('./match');

const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
const MAX_DAYS = 62;
function range(from, to, today) {
  to = isDate(to) ? to : today; from = isDate(from) ? from : to;
  if (from > to) [from, to] = [to, from];
  if (C.addDays(from, MAX_DAYS) < to) from = C.addDays(to, -MAX_DAYS);
  return { from, to };
}
function days(from, to) { const out = []; for (let d = from; d <= to; d = C.addDays(d, 1)) out.push(d); return out; }
const label = r => r.name + (r.variant ? ' ' + r.variant : '');

// ===== الأدوات =====
const S = (props, desc) => ({ type: 'object', additionalProperties: false, required: Object.keys(props), properties: props, ...(desc ? { description: desc } : {}) });
const DATE = { type: 'string', description: 'تاريخ يوم العمل YYYY-MM-DD' };
const OPT = d => ({ type: ['string', 'null'], description: d });
const TOOLS = [
  { name: 'day_report', description: 'تقرير يوم كامل: المبيعات والكاش والشبكة والمصروفات والمشتريات والنقص لكل موظف والتنبيهات، وأكثر الأصناف بيعًا.', input_schema: S({ date: DATE }) },
  { name: 'count_board', description: 'جرد يوم: لكل صنف أول اليوم والوارد وآخر اليوم والمفروض ينصرف حسب المبيعات والفرق (موجب = نقص) ومين الفاتح والمقفل.', input_schema: S({ date: DATE }) },
  { name: 'sales', description: 'مبيعات فترة (حد أقصى شهرين): كمية ومبلغ كل صنف، ومجموع كل يوم. product اختياري: جزء من اسم الصنف.', input_schema: S({ from: DATE, to: DATE, product: OPT('جزء من اسم صنف البيع أو null') }) },
  { name: 'shortages', description: 'النقص في الجرد لفترة (حد أقصى شهرين): لكل موظف مقفل ولكل صنف كم مرة نقص وكم قيمته. employee اختياري.', input_schema: S({ from: DATE, to: DATE, employee: OPT('اسم الموظف أو null') }) },
  { name: 'purchases', description: 'المشتريات لفترة (حد أقصى شهرين): كل صنف كم انشرى وبكم ومن أي مورد. item اختياري: جزء من اسم الصنف.', input_schema: S({ from: DATE, to: DATE, item: OPT('جزء من اسم صنف المخزون أو null') }) },
  { name: 'item_info', description: 'معلومات صنف مخزون: وحدته وتكلفته ورصيده في المستودع ومكوناته ومين مسؤول عنه وأي أصناف بيع تنخصم منه وبكم.', input_schema: S({ name: { type: 'string', description: 'اسم الصنف' } }) },
  { name: 'forecast', description: 'توقع يوم (عادة بكرة) من السجل: متوسط نفس اليوم من الأسابيع اللي فاتت مع أثر الراتب والموسم، وكم يتجهّز من كل صنف وكم ينشرى، والمستودع اللي قرب يخلص.', input_schema: S({ date: DATE }) },
].map(t => ({ ...t, strict: true }));

function runTool(name, input, today) {
  switch (name) {
    case 'day_report': {
      const d = isDate(input.date) ? input.date : today;
      const r = C.dailyReport(d);
      return {
        date: d, closed: !!r.closed, money: r.money && Object.fromEntries(Object.entries(r.money).filter(([k]) => k !== 'payments')),
        payments: r.money.payments, by_person: r.by_person, alerts: r.alerts.map(a => a.text),
        top_sales: r.sales.slice(0, 25).map(s => ({ name: label(s), qty: s.qty, amount: s.amount, unit_cost: s.unit_cost })),
        expenses: r.expenses.map(e => ({ amount: e.amount, note: e.note, category: e.category })),
      };
    }
    case 'count_board': {
      const d = isDate(input.date) ? input.date : today;
      return { date: d, rows: C.dailyBoard(d).rows.map(r => ({ name: r.name, unit: r.unit, opening: r.opening, received: r.received, closing: r.closing,
        should_use: r.theoretical, used: r.actual, shortage: r.diff, shortage_value: r.diff_value, waste: r.waste, opener: r.no_opening ? 'يبدأ من الشراء' : r.opening_user, closer: r.closing_user })) };
    }
    case 'sales': {
      const { from, to } = range(input.from, input.to, today);
      const like = input.product ? `%${String(input.product).trim()}%` : null;
      const rows = all(`SELECT p.name, p.variant, SUM(s.qty) AS qty, SUM(s.amount) AS amount FROM sales s LEFT JOIN products p ON p.id = s.product_id
        WHERE s.date BETWEEN ? AND ? ${like ? "AND (p.name || ' ' || COALESCE(p.variant, '')) LIKE ?" : ''} GROUP BY s.product_id ORDER BY amount DESC LIMIT 80`, from, to, ...(like ? [like] : []));
      const perDay = all(`SELECT s.date, SUM(s.amount) AS amount ${like ? ', SUM(s.qty) AS qty' : ''} FROM sales s LEFT JOIN products p ON p.id = s.product_id
        WHERE s.date BETWEEN ? AND ? ${like ? "AND (p.name || ' ' || COALESCE(p.variant, '')) LIKE ?" : ''} GROUP BY s.date ORDER BY s.date`, from, to, ...(like ? [like] : []));
      return { from, to, products: rows.map(r => ({ name: label(r), qty: C.r3(r.qty), amount: C.r2(r.amount) })),
        per_day: perDay.map(r => ({ date: r.date, weekday: F.WEEKDAYS[new Date(r.date + 'T00:00:00Z').getUTCDay()], amount: C.r2(r.amount), ...(r.qty != null ? { qty: C.r3(r.qty) } : {}) })) };
    }
    case 'shortages': {
      const { from, to } = range(input.from, input.to, today);
      const emp = input.employee ? String(input.employee).trim() : '';
      const people = {}, itemsMap = {};
      for (const d of days(from, to)) for (const r of C.dailyBoard(d).rows) {
        if (r.diff == null || r.diff <= 0.0001) continue;
        if (emp && !String(r.closing_user).includes(emp)) continue;
        const p = people[r.closing_user] = people[r.closing_user] || { employee: r.closing_user, times: 0, value: 0 };
        p.times++; p.value = C.r2(p.value + (r.diff_value || 0));
        const k = r.name + '|' + r.closing_user;
        const it = itemsMap[k] = itemsMap[k] || { item: r.name, unit: r.unit, employee: r.closing_user, days: 0, qty: 0, value: 0 };
        it.days++; it.qty = C.r3(it.qty + r.diff); it.value = C.r2(it.value + (r.diff_value || 0));
      }
      return { from, to, by_employee: Object.values(people).sort((a, b) => b.value - a.value), by_item: Object.values(itemsMap).sort((a, b) => b.value - a.value).slice(0, 60) };
    }
    case 'purchases': {
      const { from, to } = range(input.from, input.to, today);
      const like = input.item ? `%${String(input.item).trim()}%` : null;
      const rows = all(`SELECT p.date, p.supplier, i.name AS item, i.unit, l.qty, l.unit_price, l.pu_name, l.pu_qty, l.pu_price FROM purchase_lines l
        JOIN purchases p ON p.id = l.purchase_id LEFT JOIN items i ON i.id = l.item_id WHERE p.date BETWEEN ? AND ? ${like ? 'AND i.name LIKE ?' : ''} ORDER BY p.date`, from, to, ...(like ? [like] : []));
      const tot = {};
      for (const r of rows) { const t = tot[r.item] = tot[r.item] || { item: r.item, unit: r.unit, qty: 0, spent: 0 }; t.qty = C.r3(t.qty + r.qty); t.spent = C.r2(t.spent + r.qty * r.unit_price); }
      return { from, to, total: C.r2(Object.values(tot).reduce((s, t) => s + t.spent, 0)), by_item: Object.values(tot).sort((a, b) => b.spent - a.spent), lines: rows.slice(-120) };
    }
    case 'item_info': {
      const q = String(input.name || '').trim();
      const items = all('SELECT * FROM items WHERE active = 1');
      const best = items.map(i => ({ i, s: i.name === q ? 2 : i.name.includes(q) ? 1.5 : similarity(q, i.name) })).sort((a, b) => b.s - a.s)[0];
      if (!best || best.s < 0.5) return { found: false, hint: 'ما لقيت صنف بهالاسم' };
      const it = best.i;
      const costs = C.itemCostMap(), bal = C.warehouseBalances();
      const row = C.dailyBoard(today).rows.find(r => r.item_id === it.id);
      return {
        found: true, name: it.name, unit: it.unit, kind: it.kind === 'prepared' ? 'تحضير' : 'خام', counted_daily: !!it.daily, unit_cost: C.r3(costs.get(it.id) || 0),
        warehouse_balance: bal.get(it.id) || 0, opener: row ? (row.no_opening ? 'يبدأ من الشراء' : row.opening_user) : null, closer: row ? row.closing_user : null,
        components: all('SELECT i.name, c.qty, i.unit FROM item_components c JOIN items i ON i.id = c.component_id WHERE c.item_id = ?', it.id),
        used_in: all('SELECT p.name, p.variant, r.qty FROM recipe_lines r JOIN products p ON p.id = r.product_id WHERE r.item_id = ? AND p.active = 1', it.id).map(r => ({ product: label(r), qty: r.qty })),
      };
    }
    case 'forecast': return F.forecast(isDate(input.date) ? input.date : C.addDays(today, 1));
    default: return { error: 'أداة غير معروفة' };
  }
}

// ثابت (عشان الكاش): التاريخ والسائل يجون في رسالة المستخدم
const SYSTEM = `أنت مساعد مطعم السلام (مطعم يمني/سعودي: حنيذ، مندي، مرسة، فتة، حيسية، شطات، سمك…). تجاوب صاحب المطعم ومشرفينه عن بيانات المطعم.

مصطلحات التطبيق:
- «الجرد»: كل صنف يومي له «فاتح» يكتب كم موجود أول الدوام و«مقفل» يكتب الباقي آخر الدوام.
- «المفروض ينصرف» = حسب المبيعات والوصفات. «الفرق» موجب = نقص (على المقفل)، سالب = زيادة.
- «يبدأ من الشراء»: أصناف طازجة ما لها جرد أول اليوم (لحوح، كدر، رز مطبوخ…)، رصيدها من الشراء والتحضير.
- «المستودع»: المواد الخام (دقيق، زيت، ملح…). «التحضير»: أصناف تتجهز من مكونات.
- «التذكرة»: طلبات ما انقفلت في لويفرس، تنصوّر وتنقرا.
- أيام الراتب في السعودية حوالي 25–2 من كل شهر.

طريقة الرد:
- بالعربي البسيط باللهجة السعودية، قصير وواضح، وصاحب المطعم مو محاسب.
- استخدم الأدوات تجيب الأرقام. لا تخترع رقم أبدًا. إذا الأداة رجعت فاضي قل «ما عندي بيانات لهذا».
- المبالغ بالريال. اذكر التاريخ اللي تتكلم عنه.
- إذا السؤال عام عن إدارة المطاعم (تسعير، نسبة تكلفة الأكل، الهالك) جاوب من خبرتك العامة وقل إنها نصيحة عامة.
- رتّب الرد بنقاط قصيرة إذا فيه أكثر من رقم.`;

async function ask(u, question, history = [], { detailed = false } = {}) {
  question = String(question || '').trim().slice(0, 2000);
  if (!question) throw Object.assign(new Error('اكتب سؤالك'), { status: 400 });
  AI.checkCap();
  const today = C.businessDate();
  const wd = F.WEEKDAYS[new Date(today + 'T00:00:00Z').getUTCDay()];
  // المحادثة اللي قبل: نص بس (آخر 6)
  const past = (Array.isArray(history) ? history : []).slice(-6)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim())
    .map(m => ({ role: m.role, content: String(m.text).slice(0, 4000) }));
  while (past.length && past[0].role !== 'user') past.shift();
  const first = `اليوم (يوم العمل): ${today} — ${wd}. اللي يسأل: ${u.name}.\n\n${question}`;
  let cost = 0, tools = [];
  const loop = async tier => {
    const messages = [...past, { role: 'user', content: first }];
    for (let round = 0; round < 6; round++) {
      const res = await AI.create(tier, {
        max_tokens: 8000,
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS, messages,
        output_config: { effort: 'medium' },
      });
      cost += AI.costOf(res.usage, tier);
      if (res.stop_reason === 'refusal') return 'ما أقدر أجاوب على هذا.';
      if (res.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: res.content }); continue; }
      const uses = (res.content || []).filter(b => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || !uses.length) return AI.textOf(res);
      messages.push({ role: 'assistant', content: res.content });
      messages.push({ role: 'user', content: uses.map(b => {
        tools.push(b.name);
        let out;
        try { out = runTool(b.name, b.input || {}, today); } catch (e) { return { type: 'tool_result', tool_use_id: b.id, content: 'خطأ: ' + e.message, is_error: true }; }
        return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out).slice(0, 60000) };
      }) });
    }
    return '';
  };
  let tier = detailed ? 'strong' : 'fast';
  let answer = await loop(tier);
  // السريع ما قدر => نعيد بالقوي (من أول — التفكير مربوط بالنموذج)
  if (tier === 'fast' && (!answer || /ما أعرف|ما أقدر أحدد|لا أعرف/.test(answer))) { tier = 'strong'; tools = []; answer = await loop(tier); }
  answer = answer || 'ما قدرت أطلع جواب — جرّب تسأل بطريقة ثانية.';
  AI.log(u.id, 'ask', question, answer, cost, AI.MODELS[tier].id);
  return { answer, cost: Math.round(cost * 10000) / 10000, model: tier, tools: [...new Set(tools)] };
}

// ===== ملخص اليوم وتوصيات بكرة (Opus، مرة لكل يوم، ينحفظ) =====
function saved(date, kind) { return get('SELECT * FROM ai_summaries WHERE date = ? AND kind = ?', date, kind) || null; }
function save(date, kind, text, cost) {
  run('INSERT INTO ai_summaries(date, kind, text, cost, at) VALUES(?,?,?,?,datetime(\'now\')) ON CONFLICT(date, kind) DO UPDATE SET text = excluded.text, cost = ai_summaries.cost + excluded.cost, at = excluded.at', date, kind, text, cost);
  return saved(date, kind);
}

async function oneShot(u, kind, date, prompt, data) {
  AI.checkCap();
  const res = await AI.create('strong', {
    max_tokens: 6000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `${prompt}\n\nالبيانات (JSON):\n${JSON.stringify(data).slice(0, 150000)}` }],
    output_config: { effort: 'medium' },
  });
  const cost = AI.costOf(res.usage, 'strong');
  const text = AI.textOf(res) || 'ما طلع شي.';
  AI.log(u.id, kind, date, text, cost, AI.MODELS.strong.id);
  return save(date, kind, text, cost);
}

async function summary(u, date, { refresh = false } = {}) {
  const s = saved(date, 'summary');
  if (s && !refresh) return s;
  const data = {
    day: runTool('day_report', { date }, date),
    shortages: C.dailyBoard(date).rows.filter(r => r.diff != null && Math.abs(r.diff) > 0.0001).map(r => ({ item: r.name, unit: r.unit, diff: r.diff, value: r.diff_value, closer: r.closing_user })),
    tickets: all('SELECT label, status, check_status, check_note, paper_total, lines_total FROM tickets WHERE date = ?', date),
  };
  return oneShot(u, 'summary', date, `لخّص يوم ${date} لصاحب المطعم في 5 إلى 8 نقاط قصيرة:
١. وش صار (المبيعات والكاش).
٢. وين النقص ومين عليه (بالأسماء والقيمة).
٣. الشي الغريب: صنف انباع بدون وصفة، كاش ناقص، تذكرة ما طابقت، سعر تغيّر.
٤. وش يسوي بكرة.
بدون مقدمة. كل نقطة سطر يبدأ بـ «•».`, data);
}

async function recommendations(u, date, { refresh = false } = {}) {
  const s = saved(date, 'reco');
  if (s && !refresh) return s;
  const today = C.businessDate();
  const fc = F.forecast(date);
  const last7 = runTool('shortages', { from: C.addDays(today, -7), to: C.addDays(today, -1), employee: null }, today);
  const waste = [];
  for (const d of days(C.addDays(today, -7), C.addDays(today, -1))) for (const r of C.dailyBoard(d).rows) if (r.waste) waste.push({ date: d, item: r.name, waste: r.waste, value: r.waste_value });
  return oneShot(u, 'reco', date, `هذي أرقام توقع يوم ${date} (${fc.weekday}) من سجل المطعم، مع النقص والهالك آخر أسبوع.
اكتب 4 إلى 6 توصيات واضحة لصاحب المطعم: كم يجهّز من الأصناف المهمة، وش يشتري، وش يقلّل لأنه ينرمى، ومين يتابع لأن النقص يتكرر عنده، وهل بكرة يوم راتب أو موسم.
إذا السجل قليل (samples أقل من 3) قلها بصراحة إن التوقع تقريبي.
بدون مقدمة. كل توصية سطر يبدأ بـ «•».`, { forecast: fc, shortages_last_7_days: last7, waste_last_7_days: waste.slice(0, 80) });
}

module.exports = { ask, summary, recommendations, runTool, TOOLS, saved };
