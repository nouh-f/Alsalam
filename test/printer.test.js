'use strict';
// 🖨️ «الطابعة»: الكاشير يرسل التذاكر => أرشيف ما ينحذف، للمالك بس
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

let srv, B, T, PP, DIR;
const call = async (method, p, body, tok = T) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
// يرسل «طلب طباعة» ويرجع اللي رده السيرفر
const print = (chunks, { pauseMs = 30 } = {}) => new Promise((resolve, reject) => {
  const s = net.connect(PP, '127.0.0.1'); const got = [];
  s.on('data', d => got.push(d)); s.on('error', reject);
  s.on('connect', async () => { for (const c of chunks) { s.write(c); await new Promise(r => setTimeout(r, pauseMs)); } s.end(); });
  s.on('close', () => resolve(Buffer.concat(got)));
});
const waitJobs = async n => { for (let i = 0; i < 60; i++) { const r = await call('GET', '/api/printer/jobs'); if (r.total >= n) return r; await new Promise(r => setTimeout(r, 50)); } throw new Error('ما وصل'); };

test.before(async () => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-pr-'));
  const port = 38000 + Math.floor(Math.random() * 900); B = `http://127.0.0.1:${port}`; PP = port + 1000;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: PP, DATA_DIR: DIR }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
});
test.after(() => srv.kill());

test('cashier «prints» a saved ticket: text + raster image are archived, status queries answered', async () => {
  // «وش حالك؟» => شغالة
  const st = await print([Buffer.from([0x10, 0x04, 0x01])]);
  assert.deepStrictEqual([...st], [0x12]);
  // تذكرة نص عربي (UTF-8) مع أوامر ESC/POS
  const ticket = Buffer.concat([Buffer.from([0x1b, 0x40, 0x1b, 0x61, 0x01, 0x1d, 0x21, 0x11]), Buffer.from('طاولة ٥ — أبو فهد\n'), Buffer.from([0x1d, 0x21, 0x00]), Buffer.from('2 x مندي دجاج\n1 x مرسة كبير\n'), Buffer.from([0x1d, 0x56, 0x42, 0x00])]);
  await print([ticket]);
  // تذكرة بالصورة (GS v 0): 16×4 نقطة
  const img = Buffer.concat([Buffer.from([0x1d, 0x76, 0x30, 0x00, 0x02, 0x00, 0x04, 0x00]), Buffer.from([0xff, 0x00, 0x0f, 0xf0, 0xaa, 0x55, 0x00, 0xff])]);
  await print([Buffer.from([0x1b, 0x40]), img, Buffer.from([0x1d, 0x56, 0x00])]);
  const r = await waitJobs(2);
  assert.strictEqual(r.total, 2, 'طلب الحالة الفاضي ما ينحفظ');
  const [im, tx] = r.jobs;
  assert.match(tx.text, /طاولة ٥ — أبو فهد/); assert.match(tx.text, /2 x مندي دجاج/); assert.doesNotMatch(tx.text, /[\x1b\x1d]/);
  assert.strictEqual(im.has_image, 1);
  const png = await fetch(B + `/api/printer/jobs/${im.id}/image`, { headers: { authorization: 'Bearer ' + T } });
  assert.strictEqual(png.headers.get('content-type'), 'image/png');
  const pb = Buffer.from(await png.arrayBuffer()); assert.strictEqual(pb.toString('latin1', 1, 4), 'PNG'); assert.strictEqual(pb.readUInt32BE(16), 16); assert.strictEqual(pb.readUInt32BE(20), 4);
  const raw = Buffer.from(await (await fetch(B + `/api/printer/jobs/${tx.id}/raw`, { headers: { authorization: 'Bearer ' + T } })).arrayBuffer());
  assert.ok(raw.equals(ticket), 'الخام كما هو');

  // المشرف اللي يشوف المبيعات يشوفها (بدون قفل العنوان)؛ المشرف بدون المبيعات والعامل لا
  const tok = async (name, role, pin, extra = {}) => { const { id } = await call('POST', '/api/users', { name, role, pin, ...extra }); return (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: id, pin }) })).json()).token; };
  const sup = await tok('مشرف طابعة', 'supervisor', '5555'), noSales = await tok('مشرف بدون مبيعات', 'supervisor', '6666', { no_sales: true }), wk = await tok('عامل طابعة', 'worker', '7777');
  assert.strictEqual((await call('GET', '/api/printer/jobs', null, sup)).total, 2);
  await assert.rejects(call('POST', '/api/printer/ips', { ips: [] }, sup), e => e.status === 403);
  await assert.rejects(call('GET', '/api/printer/jobs', null, noSales), e => e.status === 403);
  assert.strictEqual((await fetch(B + `/api/printer/jobs/${tx.id}/raw`, { headers: { authorization: 'Bearer ' + wk } })).status, 403);

  // ما ينحذف ولا يتعدل — حتى من قاعدة البيانات مباشرة
  const db = new DatabaseSync(path.join(DIR, 'alsalam.db'));
  assert.throws(() => db.prepare('DELETE FROM printer_jobs').run(), /ما ينحذف/);
  assert.throws(() => db.prepare("UPDATE printer_jobs SET text = 'x'").run(), /ما يتعدل/);
  db.prepare('UPDATE printer_jobs SET ticket_id = 1 WHERE id = ?').run(tx.id); // الربط بالتذكرة مسموح
  db.close();

  // «اعتمد جهاز المحل»: من عنوان ثاني ما ينحفظ
  await call('POST', '/api/printer/ips', { ips: ['10.9.9.9'] });
  await print([Buffer.from('مزور\n')]);
  await new Promise(r => setTimeout(r, 300));
  const r2 = await call('GET', '/api/printer/jobs');
  assert.strictEqual(r2.total, 2); assert.strictEqual(r2.rejected.ip, '127.0.0.1');
  await call('POST', '/api/printer/ips', { ips: ['10.9.9.9', '127.0.0.1'] });
  await print([Buffer.from('من المحل\n')]);
  assert.match((await waitJobs(3)).jobs[0].text, /من المحل/);
});
