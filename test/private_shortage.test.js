'use strict';
// 🔎 رسالة الصبح في الخاص: «👍 جردك مضبوط» بس للي جرد بنفسه — اللي انحط له الرقم الجاهز (ما جرد) ما ينقال له مضبوط
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-ps-'));

test('«مضبوط» only for a worker who counted himself; the auto-filled count is not a count', () => {
  const { run } = require('../server/db');
  const { privateShortage } = require('../server/wa_nudge');
  const add = n => Number(run("INSERT INTO users(name, role, pin, phone) VALUES(?, 'worker', '1', ?)", n, '05' + Math.floor(Math.random() * 1e8)).lastInsertRowid);
  const ali = add('علي ج'), bas = add('باسم ج'), sab = add('صابر ج'), yus = add('يوسف ج');
  const row = (uid, auto, diff, name = 'صنف') => ({ name, unit: 'حبة', closing_user_id: uid, closing_auto: auto, closing: 0, diff });
  const out = privateShortage([
    row(ali, false, 0),            // جرد بنفسه (أو المالك كتبه عنه من الورقة) ومطابق => مضبوط
    row(bas, true, 0),          // ما جرد — انحط له الرقم الجاهز => ولا رسالة
    row(bas, true, 0, 'ثاني'),
    row(sab, false, 3, 'لبن'),     // جرد بنفسه وفيه نقص => النقص
    row(yus, false, 0), row(yus, true, 0, 'ثاني'), // جرد بعض وانحط الباقي => لا «مضبوط»
  ], '2026-10-22');
  const of = id => out.find(m => m.user_id === id);
  assert.match(of(ali).text, /مضبوط/);
  assert.strictEqual(of(bas), undefined);
  assert.match(of(sab).text, /لبن: ناقص 3/);
  assert.strictEqual(of(yus), undefined);
});

test('the board carries the auto flag from the saved count', () => {
  const { run } = require('../server/db');
  const C = require('../server/calc');
  const it = Number(run("INSERT INTO items(name, unit, daily, kind) VALUES('علبة جاهزة', 'حبة', 1, 'raw')").lastInsertRowid);
  run("INSERT INTO counts(date, item_id, opening, closing, closing_auto) VALUES('2026-10-22', ?, 5, 0, 1)", it);
  assert.strictEqual(C.dailyBoard('2026-10-22').rows.find(r => r.item_id === it).closing_auto, true);
});
