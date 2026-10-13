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
