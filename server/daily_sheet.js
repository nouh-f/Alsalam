'use strict';
// 📊 «حساب اليوم»: ورقة آخر اليوم (كمبيوتر + كاش + خرج = المجموع) تنزل في الجروب => نقرأها، نحفظها، ونرد بالتقرير في نفس الجروب
// المفروض يوصل = مبيعات الطابعة − التذاكر اللي باسم (أخذوها باسمهم)، ونقارنه بالورقة
const { get } = require('./db');
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
  const paper = C.r2((sheet.card || 0) + (sheet.cash || 0) + (sheet.spent || 0));
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
    `💳 كمبيوتر: ${s.card == null ? '—' : M(s.card)}`, `💵 كاش: ${s.cash == null ? '—' : M(s.cash)}`, `💸 خرج: ${s.spent == null ? '—' : M(s.spent)}`,
    `= *${M(s.paper)}*${s.total_written != null && Math.abs(s.total_written - s.paper) > 0.5 ? ` ⚠️ (المكتوب في الورقة ${M(s.total_written)} — الجمع غلط)` : ''}`, '');
  L.push(Math.abs(s.diff) <= 0.5 ? '⚖️ *مطابق* ✓' : s.diff > 0 ? `⚖️ *نقص ${M(s.diff)} ريال* 🔴` : `⚖️ *زيادة ${M(-s.diff)} ريال*`);
  return L.join('\n');
}

// صورة في جروب «حساب اليوم»: لو هي ورقة الحساب (فيها كمبيوتر/كاش ومجموع/خرج) => تنحفظ ويطلع التقرير. غير كذا نسكت
async function handle({ by, images, runAs, now = new Date() }) {
  const today = C.businessDate(now);
  const r = await readSheet(by, images, today);
  const isTotals = (r.card != null || r.cash != null) && (r.total_written != null || r.spent != null);
  if (!isTotals) return null;
  const date = isDate(r.date) && daysApart(r.date, today) <= 2 ? r.date : today;
  const sheet = { card: r.card, cash: r.cash, spent: r.spent, total_written: r.total_written };
  const owner = get("SELECT * FROM users WHERE role = 'owner' AND active = 1 AND bot = 0 ORDER BY id LIMIT 1");
  if (owner) await runAs(owner, '/api/cash', { date, card: sheet.card || 0, cash: sheet.cash || 0, spent: sheet.spent || 0, total: sheet.total_written || '', note: `من الورقة — ${by.name} (جروب حساب اليوم)` });
  const s = summary(date, sheet);
  return { ...s, text: text(s) };
}

module.exports = { handle, summary, text };
