'use strict';
// 📹 «صوّر» من الواتساب: يفهم طريقة كلام المشرفين الحقيقية (من رسايلهم)، وما يصوّر لما الكلام عن فاتورة أو صورة مرسلة
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-camwa-'));
const { match } = require('../server/cam_wa');

test('camera requests in the words supervisors actually use', () => {
  const all = ['صور', 'صور الان', 'كل الكمرات', 'كل الكمرات الان', 'صور لكل المحل', 'صور الكاميرات كلها', 'صورة لكل الكاميرات', 'صور لي جميع زوايا المطعم', 'صور اي شي بالمطعم'];
  for (const t of all) assert.deepStrictEqual(match(t), [], t);
  assert.deepStrictEqual(match('صور الان الجالسين'), ['hall']);
  assert.deepStrictEqual(match('شوف مين جالس الان'), ['hall']);
  assert.deepStrictEqual(match('ابغا أشوف جهه الكاشير'), ['cashier']);
  assert.deepStrictEqual(match('صوّر الكاشير'), ['cashier']);
  for (const t of ['ارسلت صور الفاتورة الحين', 'شوف الحين وش ناقص', 'ملاعق \nدخن', 'تمام', '[صورة]', 'ياساتر']) assert.strictEqual(match(t), null, t);
});
