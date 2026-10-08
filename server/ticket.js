'use strict';
// تذكرة الكاشير المطبوعة: دمج الصور المتداخلة، وربط الأسماء، ومطابقة المجموع
// (منطق بحت بدون قاعدة بيانات — عشان ينختبر على تذاكر حقيقية)
const { normalize, similarity, bestMatch } = require('./match');

const near = (a, b, eps) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= eps;
const r2 = x => Math.round((Number(x) || 0) * 100) / 100;

// مبلغ السطر: المطبوع، وإذا ما انقرا فالعدد × السعر
const lineAmount = l => (Number(l.amount) ? Number(l.amount) : r2((Number(l.qty) || 0) * (Number(l.unit_price) || 0)));

// نفس السطر في صورتين (للتداخل): نفس المبلغ والعدد، والاسم قريب (القراءة ممكن تختلف بحرف)
function sameLine(a, b) {
  return near(lineAmount(a), lineAmount(b), 0.011) && near(a.qty, b.qty, 0.0005) && similarity(a.name, b.name) >= 0.6;
}

// أكبر عدد أسطر في آخر A = أول B (الجزء المصوّر مرتين)
function overlap(A, B) {
  for (let k = Math.min(A.length, B.length); k >= 1; k--) {
    let ok = true;
    for (let i = 0; i < k; i++) if (!sameLine(A[A.length - k + i], B[i])) { ok = false; break; }
    if (ok) return k;
  }
  return 0;
}

// B موجودة كاملة داخل A (نفس الصورة انرفعت مرتين)
function contains(A, B) {
  if (!B.length || B.length > A.length) return false;
  for (let s = 0; s + B.length <= A.length; s++) {
    let ok = true;
    for (let i = 0; i < B.length; i++) if (!sameLine(A[s + i], B[i])) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

// images: [{ ticket_label, has_header, total_due, discount, lines: [{name, qty, unit_price, amount, note}] }]
// => تذاكر (كل رأس تذكرة يبدأ تذكرة)، كل وحدة أسطرها بالترتيب بدون تكرار التداخل
function stitch(images) {
  const imgs = (images || []).map((im, i) => ({ ...im, i, lines: (im.lines || []).filter(l => l && String(l.name || '').trim() && (Number(l.qty) || lineAmount(l))) }));
  const warnings = [];
  const used = new Set();

  // صورة مكررة بالكامل (إلا إذا فيها رأس التذكرة أو المبلغ المستحق — هذي معلومة ما تنفقد)
  for (const b of imgs) for (const a of imgs) {
    if (a === b || used.has(a.i) || used.has(b.i) || b.has_header || b.total_due != null) continue;
    if (b.lines.length && a.lines.length >= b.lines.length && contains(a.lines, b.lines) && !(a.lines.length === b.lines.length && a.i > b.i)) {
      used.add(b.i); warnings.push(`الصورة ${b.i + 1} مكررة — ما انحسبت`);
    }
  }

  // بداية كل تذكرة: الصورة اللي فيها رأس التذكرة. وإذا ما فيه، الصورة اللي ما قبلها شي
  let starts = imgs.filter(im => im.has_header && !used.has(im.i));
  if (!starts.length) {
    const rest = imgs.filter(im => !used.has(im.i));
    const head = rest.find(b => !rest.some(a => a !== b && overlap(a.lines, b.lines) > 0)) || rest[0];
    starts = head ? [head] : [];
  }

  const chains = [];
  for (const s of starts) {
    if (used.has(s.i)) continue;
    used.add(s.i);
    chains.push({ label: s.ticket_label || '', images: [s.i], lines: [...s.lines], total_due: s.total_due ?? null, discount: Number(s.discount) || 0 });
  }
  if (!chains.length) return { tickets: [], warnings };

  // نلصق الصور حسب التداخل: كل مرة الصورة اللي أكثر تداخل مع آخر تذكرة
  for (;;) {
    let best = null;
    for (const c of chains) for (const im of imgs) {
      if (used.has(im.i) || im.has_header) continue;
      const k = overlap(c.lines, im.lines);
      if (k > 0 && (!best || k > best.k)) best = { c, im, k };
    }
    if (!best) break;
    used.add(best.im.i);
    best.c.images.push(best.im.i);
    best.c.lines.push(...best.im.lines.slice(best.k));
    if (best.im.total_due != null) best.c.total_due = best.im.total_due;
    best.c.discount += Number(best.im.discount) || 0;
  }

  // صور ما لها تداخل: تنضاف بالترتيب (والمجموع يكشف إذا فيه نقص أو تكرار)
  for (const im of imgs) {
    if (used.has(im.i) || !im.lines.length) continue;
    used.add(im.i);
    const c = chains[chains.length - 1];
    c.images.push(im.i);
    c.lines.push(...im.lines);
    if (im.total_due != null) c.total_due = im.total_due;
    warnings.push(`الصورة ${im.i + 1} ما لقيت لها تداخل مع غيرها — انضافت بالترتيب`);
  }
  return { tickets: chains, warnings };
}

// مطابقة مجموع الأسطر مع «المبلغ المستحق» المطبوع
// ok: مطابق | small_diff: فرق بسيط (خصم مثلاً) | mismatch: فرق كبير | no_total: المجموع ما انقرا
function checkTotal(lines, totalDue, discount = 0, tolerance = 10) {
  const sum = r2(lines.reduce((t, l) => t + lineAmount(l), 0) - (Number(discount) || 0));
  if (totalDue == null || !Number(totalDue)) return { status: 'no_total', sum, total: null, diff: null };
  const diff = r2(sum - Number(totalDue));
  const status = Math.abs(diff) <= 0.05 ? 'ok' : Math.abs(diff) <= tolerance ? 'small_diff' : 'mismatch';
  return { status, sum, total: r2(totalDue), diff };
}

// سطر فيه العدد × السعر ما يساوي المبلغ المطبوع
const lineFlag = l => (Number(l.amount) && Number(l.unit_price) && Number(l.qty) && !near(Number(l.qty) * Number(l.unit_price), Number(l.amount), 0.05) ? 'العدد × السعر ≠ المبلغ' : '');

// السعر المطبوع لازم يساوي سعر الصنف (والنوع) في لويفرس
function priceFlag(line, product) {
  const p = Number(line.unit_price), lp = product && Number(product.price);
  return p && lp && !near(p, lp, 0.01) ? `السعر ${p} وسعر لويفرس ${lp}` : '';
}
const lineFlags = (line, product) => [lineFlag(line), priceFlag(line, product)].filter(Boolean).join('، ');

// التذكرة صحيحة حسب الأصناف (حتى لو المبلغ المستحق ما انصور):
// كل سطر مربوط بالاسم بالضبط (أو محفوظ/مختار يدوي)، والسعر = لويفرس، والعدد × السعر = المبلغ
const itemsVerified = lines => lines.length > 0 && lines.every(l => l.product_id && ['exact', 'alias', 'manual'].includes(l.match) && !l.flag);

// ربط الاسم بصنف لويفرس: الاسم المطبوع = «الصنف (النوع)» بالضبط
// products: [{id, name, variant}] ; aliases: Map(normalized -> id)
function matchProduct(line, products, aliases) {
  const n = normalize(line.name);
  const exact = products.filter(p => normalize(p.variant ? `${p.name} ${p.variant}` : p.name) === n);
  if (exact.length === 1) return { product_id: exact[0].id, match: 'exact' };
  if (aliases && aliases.has(n)) return { product_id: aliases.get(n), match: 'alias' };
  const valid = new Set(products.map(p => p.id));
  if (line.product_id && valid.has(line.product_id)) return { product_id: line.product_id, match: 'ai' };
  const fz = bestMatch(line.name, products.map(p => ({ id: p.id, label: `${p.name} ${p.variant || ''}`.trim() })), aliases);
  return fz.id ? { product_id: fz.id, match: 'fuzzy' } : { product_id: null, match: 'none' };
}

module.exports = { stitch, checkTotal, lineAmount, lineFlag, priceFlag, lineFlags, itemsVerified, matchProduct, overlap, sameLine };
