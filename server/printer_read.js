'use strict';
// 🖨️ قراءة أوراق المطبخ اللي وصلت للطابعة حقنا (صور من لويفرس) => طلب أو إلغاء لتذكرة برقمها
// وتجميعها: الأصناف الحالية لكل تذكرة = المطبوع − الملغي. الأرشيف الخام (printer_jobs) ما يتغير أبد
const fs = require('node:fs');
const path = require('node:path');
const { all, get, run, tx } = require('./db');
const AI = require('./ai');
const C = require('./calc');
const T = require('./ticket');
const PRN = require('./printer');

const ITEM = {
  type: 'object', additionalProperties: false, required: ['name', 'qty', 'note', 'product_id'],
  properties: {
    name: { type: 'string', description: 'اسم الصنف مثل ما هو مطبوع بالضبط' },
    qty: { type: 'number', description: 'العدد قبل x. لو مطبوع بثلاث خانات بعد النقطة (1.000 أو 0.500 أو 1.250) فهو وزن بالكيلو: 1.000 = 1، 0.500 = 0.5 — مو ألف ولا خمسمية' },
    note: { type: 'string', description: 'ملاحظة/إضافة مطبوعة تحت الصنف، وإلا فارغ' },
    product_id: { type: ['integer', 'null'], description: 'رقم الصنف المطابق من القائمة أو null' },
  },
};
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['kind', 'ticket_no', 'ticket_name', 'printed_at', 'employee', 'dining', 'items'],
  properties: {
    kind: { type: 'string', enum: ['order', 'cancel', 'reprint', 'test', 'other'], description: 'order = ورقة مطبخ عادية، cancel = فوقها «ملغاة»، reprint = مكتوب «إعادة طباعة/Reprint»، test = إيصال تجريبي' },
    ticket_no: { type: 'string', description: 'رقم الطلب مثل #06-783 (بدون #)، وإلا فارغ' },
    ticket_name: { type: 'string', description: 'سطر اسم التذكرة مثل «التذكرة - 9:57 ص» أو اسم الزبون/الطاولة' },
    printed_at: { type: 'string', description: 'التاريخ والوقت المطبوع بصيغة YYYY-MM-DD HH:MM (24 ساعة) إن وجد، وإلا فارغ' },
    employee: { type: 'string', description: 'اسم الموظف/الكاشير إن وجد' },
    dining: { type: 'string', description: 'نوع الطلب مثل ما هو مطبوع: محلي/سفري/توصيل… وإلا فارغ' },
    items: { type: 'array', items: ITEM },
  },
};
const PROMPT = `هذي ورقة مطبخ طبعها نظام الكاشير لويفرس (مطعم السلام). اقرأها ورجّع:
- النوع: ورقة طلب عادية، أو «ملغاة» (إلغاء أصناف)، أو «إعادة طباعة»، أو إيصال تجريبي.
- رقم الطلب (مثل #06-783)، واسم التذكرة، والوقت، والموظف، ونوع الطلب (محلي/سفري/توصيل) مثل ما هو مطبوع.
- الأصناف: الاسم بالضبط مثل ما هو مطبوع، والعدد، والملاحظة تحته إن وجدت. لا تخترع شي ما هو مطبوع.
- product_id: رقم الصنف من القائمة اللي يطابق الاسم، وإلا null.`;

// محلي/سفري/توصيل => قيمة ثابتة
function normDining(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return '';
  if (/توصيل|deliver|هنقر|جاهز|مرسول|طلبات|كيتا|تويو|نينجا/.test(t)) return 'delivery';
  if (/سفري|خارج|تيك|take|to ?go|carry/.test(t)) return 'takeaway';
  if (/محل|داخل|صال|طاول|dine|eat in|here/.test(t)) return 'dine_in';
  return '';
}
const DINING = { dine_in: 'محلي', takeaway: 'سفري', delivery: 'توصيل', '': 'غير معروف' };

// وقت الورقة (UTC من السيرفر) => يوم العمل
const dateOfJob = at => C.businessDate(new Date(String(at).replace(' ', 'T') + 'Z'));

const isReal = job => { try { return PRN.looksPrint(fs.readFileSync(path.join(PRN.DIR, path.basename(job.raw_file)))); } catch { return false; } };

// ⚖️ «موز x 1.000» = كيلو واحد — لو انقرا ١٠٠٠ (أو ٥٠٠) وهو صنف ينباع بالوزن: نرجّعه كيلو (ما فيه أحد يشتري ٥٠ كيلو موز في تذكرة)
const weighed = pid => !!(pid && get('SELECT 1 AS x FROM sales WHERE product_id = ? AND qty > 0 AND qty != CAST(qty AS INTEGER) LIMIT 1', pid));
function weightQty(q, pid, name) {
  if (!(q >= 50) || !Number.isInteger(q)) return q;
  return weighed(pid) || /كيلو|كجم|وزن/.test(String(name || '')) ? Math.round(q) / 1000 : q;
}
async function readJob(jobId) {
  const job = get('SELECT * FROM printer_jobs WHERE id = ?', jobId);
  if (!job || get('SELECT 1 AS x FROM printer_orders WHERE job_id = ?', jobId)) return null;
  if (!isReal(job) || (!job.has_image && !job.text)) return null;
  const date = dateOfJob(job.at);
  AI.checkCap();
  const products = all('SELECT id, name, variant, price FROM products WHERE active = 1 ORDER BY name');
  const content = [];
  if (job.has_image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: fs.readFileSync(path.join(PRN.DIR, path.basename(job.image_file))).toString('base64') } });
  if (job.text) content.push({ type: 'text', text: 'النص المطبوع:\n' + job.text.slice(0, 4000) });
  if (!content.length) content.push({ type: 'text', text: '—' });
  // 💰 التعليمات وقائمة الأصناف ثابتة => في system بالكاش (تتغير بس لما ينضاف صنف)، والورقة نفسها بس في الرسالة
  const system = [{ type: 'text', text: `${PROMPT}\n\nقائمة الأصناف (رقم: الصنف — النوع):\n${products.map(p => `${p.id}: ${p.name}${p.variant ? ' — ' + p.variant : ''}`).join('\n')}`, cache_control: { type: 'ephemeral' } }];
  const res = await AI.create('fast', { max_tokens: 3000, system, output_config: { format: { type: 'json_schema', schema: SCHEMA } }, messages: [{ role: 'user', content }] }, { kind: 'printer', imgKind: 'doc' });
  const cost = AI.costOf(res.usage, 'fast');
  let r;
  try { r = JSON.parse(AI.textOf(res)); } catch { r = null; }
  if (!r || res.stop_reason === 'refusal') {
    run("INSERT OR IGNORE INTO printer_orders(job_id, date, kind, error, cost) VALUES(?,?,'error',?,?)", jobId, date, 'ما قدرت أقرأ الورقة', cost);
    AI.log(null, 'printer', `#${jobId}`, 'error', cost, AI.MODELS.fast.id);
    return { kind: 'error' };
  }
  const aliases = new Map(all('SELECT * FROM product_aliases').map(a => [a.alias, a.product_id]));
  const items = (r.items || []).filter(i => String(i.name || '').trim() && Number(i.qty) > 0).map(i => {
    const m = T.matchProduct(i, products, aliases);
    return { name: String(i.name).trim(), qty: weightQty(Number(i.qty), m.product_id, i.name), note: String(i.note || '').trim(), product_id: m.product_id, match: m.match };
  });
  const no = String(r.ticket_no || '').replace(/^#/, '').trim();
  run(`INSERT OR IGNORE INTO printer_orders(job_id, date, kind, ticket_no, ticket_name, employee, dining, dining_raw, items, printed_at, cost) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    jobId, date, r.kind, no, String(r.ticket_name || '').trim(), String(r.employee || '').trim(), normDining(r.dining), String(r.dining || '').trim(), JSON.stringify(items), String(r.printed_at || '').trim(), cost);
  AI.log(null, 'printer', `#${jobId}`, `${r.kind} ${no} ${items.length}`, cost, AI.MODELS.fast.id);
  const out = { kind: r.kind, ticket_no: no, ticket_name: String(r.ticket_name || '').trim(), items, job_id: jobId, date };
  syncSales(date);
  if (onRead) try { await onRead(out); } catch (e) { console.error('printer onRead', e.message); }
  return out;
}

let onRead = null; // بعد القراءة (تنبيه الإلغاء مع لقطة الكاميرا)
// طابور: ورقة ورقة (ما نضغط على الذكاء)
let chain = Promise.resolve();
function enqueue(jobId) {
  if (!AI.apiKey() && !process.env.AI_FIXTURE) return chain;
  chain = chain.then(() => readJob(jobId)).catch(e => console.error('printer_read', jobId, e.message));
  return chain;
}
// اللي ما انقرا (السيرفر كان طافي، أو قبل هالميزة)
// الأوراق الحقيقية اللي ما انقرت (فحص الإنترنت ما ينحسب)
const unreadJobs = () => all("SELECT id, raw_file FROM printer_jobs WHERE (has_image = 1 OR text != '') AND id NOT IN (SELECT job_id FROM printer_orders) ORDER BY id").filter(isReal);
function backfill() {
  for (const j of unreadJobs()) enqueue(j.id);
  return chain;
}
// إعادة قراءة ورقة (لو انقرت غلط) — القراءة تنمسح، الأرشيف الخام يبقى
function reread(jobId) { run('DELETE FROM printer_orders WHERE job_id = ?', jobId); return enqueue(jobId); }

// ===== التجميع: كل تذكرة برقمها =====
function tickets(from, to = from) {
  const rows = all("SELECT o.*, j.at AS job_at FROM printer_orders o JOIN printer_jobs j ON j.id = o.job_id WHERE o.date BETWEEN ? AND ? ORDER BY o.job_id", from, to);
  // السعر: آخر سعر انباع فيه فعلًا في الكاشير (لو السعر انرفع والكاشير يكتبه بيده — أبو عصاية ١٠ => ١٥)، وإلا سعر القائمة
  // (لو سعر القائمة في لويفرس اتعدّل بعد آخر بيعة => سعر القائمة الجديد)
  const price = new Map(all('SELECT id, price FROM products').map(p => [p.id, p.price]));
  const changed = new Map(all('SELECT product_id, MAX(at) AS at FROM price_log GROUP BY product_id').map(r => [r.product_id, r.at.slice(0, 10)]));
  for (const r of all(`SELECT s.product_id, s.amount, s.qty, s.date FROM sales s WHERE s.source = 'loyverse' AND s.qty > 0 AND s.amount > 0 AND s.date <= ?
      AND s.date = (SELECT MAX(x.date) FROM sales x WHERE x.product_id = s.product_id AND x.source = 'loyverse' AND x.qty > 0 AND x.amount > 0 AND x.date <= ?)`, to, to))
    if (!(changed.get(r.product_id) > r.date && price.get(r.product_id) > 0)) price.set(r.product_id, Math.round((r.amount / r.qty) * 100) / 100);
  const map = new Map(), errors = [];
  for (const o of rows) {
    if (o.kind === 'error') { errors.push({ job_id: o.job_id, error: o.error }); continue; }
    if (!['order', 'cancel'].includes(o.kind)) continue; // إعادة الطباعة والتجربة ما تنحسب
    const key = o.ticket_no ? `${o.date}|${o.ticket_no}` : `job-${o.job_id}`; // نفس الرقم يرجع بعد أيام — كل يوم تذكرته
    const t = map.get(key) || { ticket_no: o.ticket_no, name: '', employee: '', dining: '', dining_raw: '', date: o.date, lines: new Map(), events: [], printed: false, cancelled: false };
    if (o.ticket_name) t.name = o.ticket_name;
    if (o.employee) t.employee = o.employee;
    if (o.dining && !t.dining) { t.dining = o.dining; t.dining_raw = o.dining_raw; }
    const items = C.safeJSON(o.items, []), sign = o.kind === 'cancel' ? -1 : 1;
    if (sign > 0) t.printed = true; else t.cancelled = true;
    for (const i of items) {
      const k = i.product_id ? 'p' + i.product_id : 'n' + i.name;
      const l = t.lines.get(k) || { name: i.name, product_id: i.product_id, qty: 0, printed: 0, cancelled: 0 };
      l.qty = C.r3(l.qty + sign * i.qty); if (sign > 0) l.printed += i.qty; else l.cancelled += i.qty;
      t.lines.set(k, l);
    }
    t.events.push({ job_id: o.job_id, kind: o.kind, at: o.job_at, printed_at: o.printed_at, items: items.map(i => ({ name: i.name, qty: i.qty })) });
    map.set(key, t);
  }
  const list = [...map.values()].map(t => {
    const lines = [...t.lines.values()].map(l => ({ ...l, price: l.product_id ? price.get(l.product_id) || 0 : 0 }));
    const live = lines.filter(l => l.qty > 0);
    const value = C.r2(live.reduce((s, l) => s + l.qty * l.price, 0));
    const status = live.length ? (t.cancelled ? 'edited' : 'open') : t.printed ? 'cancelled' : 'cancel_only';
    return { ticket_no: t.ticket_no, name: t.name, employee: t.employee, dining: t.dining, dining_label: DINING[t.dining] || DINING[''], dining_raw: t.dining_raw, date: t.date, lines, value, status, unpriced: live.filter(l => !l.price).length, events: t.events };
  });
  const live = list.filter(t => t.status === 'open' || t.status === 'edited');
  const by = {}; for (const t of live) by[t.dining || ''] = (by[t.dining || ''] || 0) + 1;
  return {
    from, to, tickets: list.reverse(), errors,
    total: { tickets: live.length, value: C.r2(live.reduce((s, t) => s + t.value, 0)), cancelled: list.filter(t => t.status === 'cancelled').length, by_dining: by },
    unread: unreadJobs().length,
  };
}

// 👥 العملاء: كل اسم ينكتب على التذكرة في الكاشير = عميل (يرجع ينضاف عليه) — بدون «سفري/محلي/التذكرة - الوقت» والأرقام
const AR_DIG = s => String(s || '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
function customerName(raw, employee = '') {
  let n = AR_DIG(raw).replace(/\s+/g, ' ').trim();
  n = n.replace(/\s*-\s*\d{1,2}:\d{2}\s*(ص|م|am|pm)?\s*$/i, '').trim(); // «سمير - 5:04 م» => سمير
  if (!n || /^(التذكرة|تذكرة|ticket)(\s|-|$)/i.test(n)) return '';
  if (/^(سفري|محلي|توصيل|طلب|طاولة|takeaway|dine ?in|delivery)$/i.test(n)) return '';
  if (/^#?[\d\s\-]+$/.test(n)) return ''; // «#06-025»، «5551»
  if (employee && n === AR_DIG(employee).replace(/\s+/g, ' ').trim()) return ''; // اسم حساب الكاشير
  if (/مطعم السلام|^المالك/.test(n)) return '';
  return n;
}
function customers(from, to = from) {
  const by = new Map();
  for (const t of tickets(from, to).tickets) {
    const name = customerName(t.name, t.employee); if (!name) continue;
    if (t.status === 'cancel_only') continue;
    const c = by.get(name) || { name, visits: 0, total: 0, first: t.date, last: t.date, tickets: [] };
    const live = t.status !== 'cancelled';
    if (live) { c.visits++; c.total = C.r2(c.total + t.value); }
    if (t.date < c.first) c.first = t.date; if (t.date > c.last) c.last = t.date;
    c.tickets.push({ ticket_no: t.ticket_no, date: t.date, value: t.value, status: t.status, dining: t.dining_label,
      items: t.lines.filter(l => l.qty > 0).map(l => ({ name: l.name, qty: l.qty, price: l.price })),
      cancelled: t.lines.filter(l => l.cancelled > 0).map(l => ({ name: l.name, qty: C.r3(l.cancelled) })) });
    by.set(name, c);
  }
  const list = [...by.values()].map(c => ({ ...c, tickets: c.tickets.sort((a, b) => b.date.localeCompare(a.date)) })).sort((a, b) => b.total - a.total);
  return { from, to, customers: list };
}

// 🖨️ مبيعات اليوم من أوراق الطابعة (من يوم sales_from_printer): كل صنف انطبع وما انلغى = انباع
// ويمسح مبيعات لويفرس والتذكرة المصوّرة لنفس اليوم (ما تنحسب مرتين)
function syncSales(date) {
  if (!C.usesPrinter(date)) return { skipped: true };
  run("DELETE FROM sales WHERE date = ? AND source IN ('loyverse', 'ticket')", date); // قبل الحساب — عشان السعر ما ياخذ من بيع لويفرس لنفس اليوم
  const t = tickets(date), agg = new Map();
  let unmatched = 0;
  const list = new Map(all('SELECT id, price FROM products').map(p => [p.id, p.price]));
  for (const k of t.tickets) {
    if (k.status !== 'open' && k.status !== 'edited') continue;
    for (const l of k.lines) {
      if (!(l.qty > 0)) continue;
      if (!l.product_id) { unmatched++; continue; }
      const a = agg.get(l.product_id) || { qty: 0, amount: 0, list: 0 };
      a.qty += l.qty; a.amount += l.qty * (l.price || 0); a.list += l.qty * (list.get(l.product_id) || l.price || 0);
      agg.set(l.product_id, a);
    }
  }
  tx(() => {
    run("DELETE FROM sales WHERE date = ? AND source IN ('printer', 'loyverse', 'ticket')", date);
    for (const [pid, a] of agg) run("INSERT INTO sales(date, product_id, qty, amount, list_amount, source, note) VALUES(?,?,?,?,?,'printer','')", date, pid, C.r3(a.qty), C.r2(a.amount), C.r2(a.list));
  });
  C.rebuildSaleUse(date);
  return { products: agg.size, unmatched };
}

// التذاكر المصوّرة لنفس الأيام (للمقارنة أسبوع قبل ما نوقف التصوير)
function photoTotal(from, to = from) {
  const r = get("SELECT COUNT(DISTINCT t.id) AS n, SUM(l.qty * l.price) AS v FROM tickets t JOIN ticket_lines l ON l.ticket_id = t.id WHERE t.date BETWEEN ? AND ? AND t.status != 'duplicate'", from, to);
  return { tickets: r.n || 0, value: C.r2(r.v || 0) };
}

module.exports = { weightQty, setOnRead: fn => { onRead = fn; }, readJob, enqueue, backfill, reread, tickets, customers, customerName, syncSales, photoTotal, normDining, DINING, SCHEMA };
