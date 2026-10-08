'use strict';
// تذكرة حقيقية من مطعم السلام: ورقة طويلة متصورة ٣ صور متداخلة (الأسطر منسوخة من الصور كما هي)
const test = require('node:test');
const assert = require('node:assert');
const { stitch, checkTotal, matchProduct, lineFlag } = require('../server/ticket');

const L = (name, qty, unit_price, amount) => ({ name, qty, unit_price, amount, note: '' });
const top = { ticket_label: 'التذكرة - 11:47 م', has_header: true, total_due: null, lines: [
  L('دجاج مقلقل حراق', 1, 22, 22), L('مرسه وسط (وسط)', 1, 18, 18), L('مرسة صغير (صغير)', 1, 12, 12), L('دجاج مقلقل عادي', 1, 21, 21),
  L('مرسه وسط (وسط)', 1, 18, 18), L('إيدام بطاطس', 1, 10, 10), L('لص دجاج مقلقل عادي (بدون رز)', 1, 15, 15), L('مرسة كبير (ساده)', 1, 12, 12),
  L('ملوخية', 1, 10, 10), L('شعور (قلي)', 0.32, 70, 22.4), L('قوار مكشن بالسليط', 2, 15, 30), L('لحم حنيذ مع الرز', 3, 80, 240),
  L('هامور (قلي)', 0.36, 70, 25.2), L('راس مندي', 1, 30, 30), L('لص دجاج حنيذ مع الرز', 1, 21, 21), L('مطفي (صرع)', 1, 30, 30),
  L('مرسة صغير (صغير)', 2, 12, 24), L('فتة زبيدي بالقشطة (وسط)', 1, 18, 18), L('روبيان (قلي)', 0.645, 120, 77.4), L('ديراك (مبفا)', 1.1, 120, 132),
  L('لبن القريه', 1, 3, 3), L('مرسة سلام (صغير)', 1, 33, 33), L('لحم برم صغير مع الرز', 2, 50, 100), L('لص دجاج مضغوط', 1, 21, 21),
] };
const middle = { ticket_label: '', has_header: false, total_due: null, lines: [
  L('روبيان (قلي)', 0.645, 120, 77.4), L('ديراك (مبفا)', 1.1, 120, 132), L('لبن القريه', 1, 3, 3), L('مرسة سلام (صغير)', 1, 33, 33),
  L('لحم برم صغير مع الرز', 2, 50, 100), L('لص دجاج مضغوط', 1, 21, 21), L('بيبسي', 5, 3, 15), L('لحم برم كبير مع الرز', 1, 80, 80),
  L('ديراك (ني)', 0.57, 100, 57), L('قوار غير مستوي', 0.5, 40, 20), L('ربع حنيذ مع الرز', 1, 11, 11), L('هامور (مبفا)', 0.53, 70, 37.1),
  L('مرسة صغير (صغير)', 1, 12, 12), L('مرسة صغير (ساده)', 2, 8, 16), L('فتة زبيدي بالقشطة (صغير)', 1, 12, 12), L('مطفي (ديراك)', 5, 35, 175),
  L('رز', 4, 8, 32), L('هامور (قلي)', 1.2, 70, 84), L('فتة (فتة ناشف دخن)', 3, 5, 15), L('هامور (مبفا)', 1.5, 70, 105),
  L('سحاوق جبن', 3, 5, 15), L('حمضيات', 3, 3, 9), L('حلبة حمر', 3, 4, 12), L('حلبة حمر شطه', 8, 4, 32), L('حبسية خضار (لحوح)', 1, 25, 25),
] };
const bottom = { ticket_label: '', has_header: false, total_due: 1935.6, lines: [
  L('ربع حنيذ مع الرز', 1, 11, 11), L('هامور (مبفا)', 0.53, 70, 37.1), L('مرسة صغير (صغير)', 1, 12, 12), L('مرسة صغير (ساده)', 2, 8, 16),
  L('فتة زبيدي بالقشطة (صغير)', 1, 12, 12), L('مطفي (ديراك)', 5, 35, 175), L('رز', 4, 8, 32), L('هامور (قلي)', 1.2, 70, 84),
  L('فتة (فتة ناشف دخن)', 3, 5, 15), L('هامور (مبفا)', 1.5, 70, 105), L('سحاوق جبن', 3, 5, 15), L('حمضيات', 3, 3, 9),
  L('حلبة حمر', 3, 4, 12), L('حلبة حمر شطه', 8, 4, 32), L('حبسية خضار (لحوح)', 1, 25, 25), L('كدر', 6, 3, 18), L('كبان', 14, 4, 56),
  L('لحوح', 102, 1, 102), L('بقل ربطه', 2, 5, 10), L('فتة (فتة ناشف ابيض)', 6, 5, 30), L('ماء صغير', 13, 0.5, 6.5), L('شطه فلافلو صغير', 2, 2, 4),
] };

test('real ticket: 3 overlapping photos stitch to the printed total', () => {
  for (const order of [[bottom, middle, top], [top, middle, bottom], [middle, top, bottom], [bottom, top, middle]]) {
    const { tickets } = stitch(order);
    assert.strictEqual(tickets.length, 1);
    const t = tickets[0];
    assert.strictEqual(t.label, 'التذكرة - 11:47 م');
    assert.strictEqual(t.lines.length, 24 + 4 + 15 + 7);
    const c = checkTotal(t.lines, t.total_due);
    assert.strictEqual(c.status, 'ok', JSON.stringify(c));
    assert.strictEqual(c.sum, 1935.6);
    // الأصناف المكررة فعلاً في التذكرة تبقى (مرسة صغير (صغير) ٣ أسطر = ٤ حبات)
    const mursa = t.lines.filter(l => l.name === 'مرسة صغير (صغير)');
    assert.strictEqual(mursa.reduce((s, l) => s + l.qty, 0), 4);
  }
});

test('without removing the overlap the total would be far off (caught as mismatch)', () => {
  const naive = [...top.lines, ...middle.lines, ...bottom.lines];
  const c = checkTotal(naive, 1935.6);
  assert.strictEqual(c.status, 'mismatch');
});

test('same photo uploaded twice is ignored; a missing line is caught', () => {
  const { tickets, warnings } = stitch([top, middle, middle, bottom]);
  assert.strictEqual(checkTotal(tickets[0].lines, tickets[0].total_due).status, 'ok');
  assert.ok(warnings.some(w => w.includes('مكررة')));
  const misread = { ...bottom, lines: bottom.lines.filter(l => l.name !== 'لحوح') };
  const t2 = stitch([top, middle, misread]).tickets[0];
  const c = checkTotal(t2.lines, t2.total_due, 0, 10);
  assert.strictEqual(c.status, 'mismatch'); assert.strictEqual(c.diff, -102);
  assert.strictEqual(checkTotal(t2.lines.concat([L('خصم', 1, 0, 0)]), 1935.6 - 5, 0, 10).status, 'mismatch');
  assert.strictEqual(checkTotal(top.lines.concat(middle.lines.slice(6), bottom.lines.slice(15)), 1930.6, 0, 10).status, 'small_diff');
});

test('names match the Loyverse item + variant exactly', () => {
  const products = [
    { id: 1, name: 'مرسة صغير', variant: 'صغير' }, { id: 2, name: 'مرسة صغير', variant: 'ساده' },
    { id: 3, name: 'هامور', variant: 'قلي' }, { id: 4, name: 'هامور', variant: 'مبفا' },
    { id: 5, name: 'ديراك', variant: 'ني' }, { id: 6, name: 'ديراك', variant: 'مبفا' }, { id: 7, name: 'بيبسي', variant: '' },
    { id: 8, name: 'مرسة وسط', variant: 'وسط' },
  ];
  const m = n => matchProduct({ name: n }, products, new Map());
  assert.deepStrictEqual(m('مرسة صغير (ساده)'), { product_id: 2, match: 'exact' });
  assert.deepStrictEqual(m('مرسة صغير (صغير)'), { product_id: 1, match: 'exact' });
  assert.deepStrictEqual(m('هامور (مبفا)'), { product_id: 4, match: 'exact' });
  assert.deepStrictEqual(m('ديراك (ني)'), { product_id: 5, match: 'exact' });
  assert.deepStrictEqual(m('بيبسي'), { product_id: 7, match: 'exact' });
  assert.deepStrictEqual(m('مرسه وسط (وسط)'), { product_id: 8, match: 'exact' });
  assert.strictEqual(lineFlag(L('هامور (قلي)', 1.2, 70, 84)), '');
  assert.ok(lineFlag(L('هامور (قلي)', 1.2, 70, 48)));
});

test('a short last photo that only repeats lines still brings the printed total', () => {
  const lastBit = { has_header: false, total_due: 1935.6, lines: bottom.lines.slice(-2) };
  const { tickets } = stitch([top, middle, bottom, lastBit]);
  assert.strictEqual(checkTotal(tickets[0].lines, tickets[0].total_due).status, 'ok');
  const noTotalBottom = { ...bottom, total_due: null };
  const t2 = stitch([top, middle, noTotalBottom, lastBit]).tickets[0];
  assert.strictEqual(t2.total_due, 1935.6);
  assert.strictEqual(checkTotal(t2.lines, t2.total_due).status, 'ok');
});
