'use strict';
// 👥 العملاء من أسماء تذاكر الكاشير: نفس الاسم يتجمّع (حتى مع «- الوقت»)، و«سفري/التذكرة» ما تنحسب
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

let srv, B, T, DIR;
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};

test.before(async () => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-cust2-'));
  const port = 43500 + Math.floor(Math.random() * 400); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: DIR }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
});
test.after(() => srv.kill());

test('ticket names become customers: same name adds up, generic names are skipped, cancelled items show', async () => {
  const db = new DatabaseSync(path.join(DIR, 'alsalam.db'));
  const pid = Number(db.prepare("INSERT INTO products(loyverse_item_id, loyverse_variant_id, name, variant, category, price, sku, active) VALUES('x','v1','مرسة','','',20,'',1)").run().lastInsertRowid);
  let job = 0;
  const slip = (date, ticket, name, kind, items) => {
    const id = ++job;
    db.prepare("INSERT INTO printer_jobs(id, at, raw_file) VALUES(?, ?, '')").run(id, date + ' 10:00:0' + (id % 10));
    db.prepare('INSERT INTO printer_orders(job_id, date, kind, ticket_no, ticket_name, employee, items) VALUES(?,?,?,?,?,?,?)').run(id, date, kind, ticket, name, 'المالك', JSON.stringify(items));
  };
  slip('2026-10-13', '06-001', 'سمير', 'order', [{ name: 'مرسة', product_id: pid, qty: 1 }]);
  slip('2026-10-14', '06-002', 'سمير - ٥:٠٤ م', 'order', [{ name: 'مرسة', product_id: pid, qty: 2 }]);
  slip('2026-10-14', '06-002', 'سمير - ٥:٠٤ م', 'cancel', [{ name: 'مرسة', product_id: pid, qty: 1 }]);
  slip('2026-10-14', '06-003', 'سفري', 'order', [{ name: 'مرسة', product_id: pid, qty: 1 }]);
  slip('2026-10-14', '06-004', 'التذكرة - 4:53 م', 'order', [{ name: 'مرسة', product_id: pid, qty: 1 }]);
  db.close();
  const r = await call('GET', '/api/customers?from=2026-10-13&to=2026-10-14');
  assert.deepStrictEqual(r.customers.map(c => c.name), ['سمير']);
  const c = r.customers[0];
  assert.strictEqual(c.visits, 2); assert.strictEqual(c.total, 40);
  assert.deepStrictEqual(c.tickets[0].cancelled, [{ name: 'مرسة', qty: 1 }]);
});
