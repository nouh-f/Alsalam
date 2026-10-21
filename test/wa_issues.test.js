'use strict';
// 🤏 المتابعة: العامل اللي ما له جوال — التذكير ما يضيع، يوصل للمالك تنبيه
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-wi-'));
const { run, get, all } = require('../server/db');
const I = require('../server/wa_issues');

test('no phone => owner is told the reminder did not reach the worker', async () => {
  run("UPDATE users SET phone = '966500000100' WHERE id = 1");
  const w = Number(run("INSERT INTO users(name, role, active) VALUES('عامل بلا جوال', 'worker', 1)").lastInsertRowid);
  const sup = get("SELECT * FROM users WHERE role = 'supervisor' LIMIT 1") || get('SELECT * FROM users WHERE id = 1');
  const staff = all('SELECT id, name, role, phone FROM users WHERE active = 1');
  const sent = [];
  await I.record([{ type: 'late', employee: 'عامل بلا جوال', summary: 'متأخر' }], { by: sup, chat: 'g@g.us', staff, send: async (to, text) => { sent.push({ to, text }); } });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].to, '966500000100');
  assert.match(sent[0].text, /ما وصل التذكير لـعامل بلا جوال/);
  assert.strictEqual(get('SELECT step FROM wa_issues WHERE user_id = ?', w).step, 1);
});

test('📜 penalty rules: small mistakes go reminder → warning → 15; big ones deduct from the first time; over the cap goes to the owner', async () => {
  const { setSetting } = require('../server/db');
  setSetting('penalty_on', '1');
  run("UPDATE users SET phone = '966500000100' WHERE id = 1");
  const sup = Number(run("INSERT INTO users(name, role, active, phone) VALUES('مشرف لائحة', 'supervisor', 1, '966500000111')").lastInsertRowid);
  setSetting('wa_deduct_ids', String(sup));
  const w = Number(run("INSERT INTO users(name, role, active, phone, salary) VALUES('عامل لائحة', 'worker', 1, '966500000112', 1500)").lastInsertRowid);
  const by = get('SELECT * FROM users WHERE id = ?', sup), staff = all('SELECT id, name, role, phone FROM users WHERE active = 1');
  const sent = [], rec = x => I.record([{ employee: 'عامل لائحة', ...x }], { by, chat: 'g@g.us', staff, send: async (to, text) => { sent.push({ to, text }); } });
  const deducts = () => all("SELECT amount FROM payroll WHERE user_id = ? AND type = 'deduct' ORDER BY id", w).map(r => r.amount);

  await rec({ type: 'late', summary: 'تأخر ١' }); await rec({ type: 'late', summary: 'تأخر ٢' });
  assert.deepStrictEqual(deducts(), [], 'أول مرتين بدون خصم');
  await rec({ type: 'late', summary: 'تأخر ٣' });
  assert.deepStrictEqual(deducts(), [15]);
  assert.ok(sent.some(s => s.to === '966500000112' && /حسب لائحة المطعم/.test(s.text) && /15 ريال/.test(s.text)));

  await rec({ type: 'behavior', summary: 'صياح قدام الزباين' });
  assert.deepStrictEqual(deducts(), [15, 100], 'الكبير من أول مرة');
  await rec({ type: 'behavior', summary: 'صياح مرة ثانية' }); // ١٧٥ => المجموع ٢٩٠ (أقل من الربع ٣٧٥)
  const n = sent.length;
  await rec({ type: 'behavior', summary: 'صياح ثالث' }); // ٢٥٠ => ٥٤٠ > ٣٧٥ => لنوح
  assert.deepStrictEqual(deducts(), [15, 100, 175]);
  assert.ok(sent.slice(n).some(s => s.to === '966500000100' && /قرارك/.test(s.text) && /ربع الراتب/.test(s.text)), JSON.stringify(sent.slice(n)));
  assert.match(I.rulesText(), /التعامل: من أول مرة 100 ريال ← 175 ريال ← 250 ريال/);
  setSetting('penalty_on', '0');
});
