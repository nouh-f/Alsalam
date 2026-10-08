'use strict';
// مسار التذكرة كامل: رفع → قراءة → دمج التداخل → مطابقة المجموع → إعادة القراءة → حجز/تكرار
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const L = (name, qty, unit_price, amount) => ({ name, qty, unit_price, amount, note: '', product_id: null });
const img = (lines, extra = {}) => ({ image_number: 1, has_header: false, ticket_label: '', total_due: null, discount: 0, lines, ...extra });
const H1 = L('هامور (مبفا)', 0.53, 70, 37.1), H2 = L('هامور (قلي)', 1.2, 70, 84), M = L('مرسة صغير (ساده)', 2, 8, 16), P = L('بيبسي', 5, 3, 15);
const good = label => [img([M, P], { total_due: 152.1 }), img([H1, H2, M], { has_header: true, ticket_label: label })]; // صورتين متداخلتين (المرسة)
const bad = label => [img([M], { total_due: 152.1 }), img([H1, H2, M], { has_header: true, ticket_label: label })];   // البيبسي ضاع
const runs = [good('التذكرة - 1'), bad('التذكرة - 2'), good('التذكرة - 2'), bad('التذكرة - 3'), bad('التذكرة - 3'), good('التذكرة - 1')];

const mock = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/items') return res.end(JSON.stringify({ items: [
    { id: 'h', item_name: 'هامور', variants: [{ variant_id: 'h1', option1_value: 'مبفا', default_price: 70 }, { variant_id: 'h2', option1_value: 'قلي', default_price: 70 }] },
    { id: 'm', item_name: 'مرسة صغير', variants: [{ variant_id: 'm1', option1_value: 'صغير', default_price: 12 }, { variant_id: 'm2', option1_value: 'ساده', default_price: 8 }] },
    { id: 'p', item_name: 'بيبسي', variants: [{ variant_id: 'p1', default_price: 3 }] },
  ] }));
  if (u.pathname === '/categories') return res.end('{"categories":[]}');
  if (u.pathname === '/receipts') return res.end('{"receipts":[]}');
  res.statusCode = 404; res.end('{}');
});

let srv, B, T;
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status, data: j }); return j;
};
test.before(async () => {
  await new Promise(r => mock.listen(0, r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-tk-'));
  const fx = path.join(dir, 'fixture.json'); fs.writeFileSync(fx, JSON.stringify(runs));
  const port = 45000 + Math.floor(Math.random() * 4000); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: port, DATA_DIR: dir, OCR_FIXTURE: fx, LOYVERSE_BASE: `http://127.0.0.1:${mock.address().port}` }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  await call('POST', '/api/settings', { loyverse_token: 'x' });
  assert.ok((await call('POST', '/api/sync', { full: true })).ok);
});
test.after(() => { srv.kill(); mock.close(); });

const D = '2030-05-05';
async function upload() {
  const { id } = await call('POST', '/api/tickets', { date: D, images: ['data:image/jpeg;base64,AAAA', 'data:image/jpeg;base64,BBBB'] });
  for (let i = 0; i < 50; i++) { const t = await call('GET', '/api/tickets/' + id); if (t.status !== 'reading') return t; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('reading never finished');
}
const ticketSales = async () => (await call('GET', '/api/sales?date=' + D)).reduce((m, r) => (m[`${r.name} ${r.variant}`.trim()] = r.ticket_qty, m), {});

test('printed ticket: overlap removed, exact names, total checked, re-read, hold and duplicate', async () => {
  // ١. قراءة سليمة: التداخل انشال، والأسماء انربطت بالضبط، والمجموع مطابق
  const a = await upload();
  assert.strictEqual(a.check_status, 'ok', JSON.stringify(a));
  assert.strictEqual(a.lines.length, 4);
  assert.ok(a.lines.every(l => l.match === 'exact'));
  assert.strictEqual(a.paper_total, 152.1); assert.strictEqual(a.lines_total, 152.1);
  let s = await ticketSales();
  assert.strictEqual(s['هامور مبفا'], 0.53); assert.strictEqual(s['مرسة صغير ساده'], 2); assert.strictEqual(s['بيبسي'], 5);

  // ٢. القراءة الأولى ناقصة => يعيد القراءة لحاله ويضبط
  const b = await upload();
  assert.strictEqual(b.check_status, 'ok');
  assert.ok(b.check_note.includes('انعادت القراءة'));

  // ٣. القراءتين غلط => محجوزة: ما تنحسب، وتنبيه، والتأكيد يطلب تأكيد زيادة
  const c = await upload();
  assert.strictEqual(c.check_status, 'mismatch');
  s = await ticketSales();
  assert.strictEqual(s['هامور مبفا'], 1.06, 'held ticket is not counted (only tickets 1 and 2)');
  const rep = await call('GET', '/api/report?date=' + D);
  assert.ok(rep.alerts.some(x => x.type === 'ticket_check'));
  await assert.rejects(call('POST', '/api/day/close', { date: D }), e => e.status === 400);
  await assert.rejects(call('POST', `/api/tickets/${c.id}/confirm`, {}), e => e.status === 409 && e.data.needForce);
  // يصلّحها بإضافة السطر الناقص => تصير مطابقة وتنحسب
  const fixed = await call('PUT', `/api/tickets/${c.id}/lines`, { lines: [...c.lines.map(l => ({ ...l, orig_product_id: l.product_id })), { raw_name: 'بيبسي', product_id: a.lines.find(l => l.raw_name === 'بيبسي').product_id, qty: 5, price: 3 }] });
  assert.strictEqual(fixed.check_status, 'ok');
  s = await ticketSales();
  assert.strictEqual(s['بيبسي'], 15); assert.strictEqual(s['هامور مبفا'], 1.59);

  // ٤. نفس التذكرة انرفعت مرة ثانية => مكررة وما تنحسب
  const d = await upload();
  assert.strictEqual(d.check_status, 'duplicate');
  s = await ticketSales();
  assert.strictEqual(s['بيبسي'], 15, 'duplicate not counted');
  await call('POST', `/api/tickets/${d.id}/confirm`, { force: true }).catch(() => {});
  await call('DELETE', '/api/tickets/' + d.id);
  await call('POST', '/api/day/close', { date: D });
});
