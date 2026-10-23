'use strict';
// 📋 ورقة الحساب: الفرق بين مجموع السطور والخرج — يدوّر السطور اللي مجموعها نفس الفرق، واللي «من برا الدرج» ما تنحسب
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-sp-'));
const { sheetProblems } = require('../server/sheet');

const L = (text, amount, outside = false) => ({ text, amount, kind: 'expense', outside });
test('the 550 gap is explained by the two lines that came from outside the drawer', () => {
  const lines = [L('غاز', 312), L('بضاعة مستودع كاش', 1442), L('دعدع', 150), L('لحم', 400), L('مشاوير', 4)];
  const p = sheetProblems({ spent: 1758, lines });
  assert.match(p[0], /الفرق 550 = «دعدع» \+ «لحم»/);
  // لما تنقرا «من برا» صح: الأرقام تركب
  assert.deepStrictEqual(sheetProblems({ spent: 1758, lines: [L('غاز', 312), L('بضاعة مستودع كاش', 1442), L('دعدع', 150, true), L('لحم', 400, true), L('مشاوير', 4)] }), []);
});
