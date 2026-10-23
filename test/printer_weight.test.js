'use strict';
// 🍌 «موز x 1.000» = كيلو (مو ألف)، ونفس رقم التذكرة في يوم ثاني = تذكرة ثانية (ما تنضم للقديمة)
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-pw-'));
const { run } = require('../server/db');
const PR = require('../server/printer_read');

test('a weighed item printed as 1.000 is one kilo; counted items stay as they are', () => {
  const banana = Number(run("INSERT INTO products(name, price) VALUES('موز', 8)").lastInsertRowid);
  const bread = Number(run("INSERT INTO products(name, price) VALUES('لحوح', 1)").lastInsertRowid);
  run("INSERT INTO sales(date, product_id, qty, amount, source) VALUES('2026-10-20', ?, 0.5, 4, 'loyverse')", banana); // ينباع بالوزن
  assert.strictEqual(PR.weightQty(1000, banana, 'موز'), 1);
  assert.strictEqual(PR.weightQty(500, banana, 'موز'), 0.5);
  assert.strictEqual(PR.weightQty(2, banana, 'موز'), 2);
  assert.strictEqual(PR.weightQty(100, bread, 'لحوح'), 100); // ١٠٠ لحوح عدد حقيقي
});

test('the same ticket number on another day is a separate ticket', () => {
  for (const [id, at, date] of [[1, '2026-10-15 20:12:05', '2026-10-15'], [2, '2026-10-23 07:12:33', '2026-10-23']]) {
    run("INSERT INTO printer_jobs(id, at, raw_file) VALUES(?, ?, 'x')", id, at);
    run("INSERT INTO printer_orders(job_id, date, kind, ticket_no, items) VALUES(?, ?, 'order', '06-249', ?)", id, date, JSON.stringify([{ name: 'كبان', qty: id, product_id: null }]));
  }
  const t = PR.tickets('2026-10-10', '2026-10-23').tickets.filter(x => x.ticket_no === '06-249');
  assert.strictEqual(t.length, 2);
  assert.deepStrictEqual(t.map(x => x.date).sort(), ['2026-10-15', '2026-10-23']);
});
