'use strict';
// 🖨️ أوراق المطبخ تنقرا => تذاكر (المطبوع − الملغي) + 🥡 البلاستيك: المفروض (سفري/توصيل) مقابل اللي انشرى
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json');
  if (u.pathname === '/items') return res.end(JSON.stringify({ items: [
    { id: 'm', item_name: 'مندي دجاج', variants: [{ variant_id: 'm1', default_price: 30 }] },
    { id: 'w', item_name: 'ماء صغير', variants: [{ variant_id: 'w1', default_price: 1 }] }] }));
  if (u.pathname === '/categories') return res.end('{"categories":[]}');
  if (u.pathname === '/receipts') return res.end('{"receipts":[]}');
  res.statusCode = 404; res.end('{}');
});
let srv, B, T, PP, today;
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const print = text => new Promise((resolve, reject) => {
  const s = net.connect(PP, '127.0.0.1'); s.on('error', reject);
  s.on('connect', () => s.end(Buffer.concat([Buffer.from([0x1b, 0x40]), Buffer.from(text + '\n'), Buffer.from([0x1d, 0x56, 0x00])])));
  s.on('close', resolve);
});
const read = r => ({ content: [{ type: 'text', text: JSON.stringify({ ticket_name: '', printed_at: '', employee: 'المالك', ...r }) }] });
const FIX = [
  read({ kind: 'order', ticket_no: '06-1', dining: 'سفري', items: [{ name: 'مندي دجاج', qty: 2, note: '', product_id: null }, { name: 'ماء صغير', qty: 1, note: '', product_id: null }] }),
  read({ kind: 'order', ticket_no: '06-2', dining: 'محلي', items: [{ name: 'مندي دجاج', qty: 1, note: '', product_id: null }] }),
  read({ kind: 'order', ticket_no: '06-3', dining: 'توصيل', items: [{ name: 'مندي دجاج', qty: 1, note: '', product_id: null }] }),
  read({ kind: 'cancel', ticket_no: '06-3', dining: 'توصيل', items: [{ name: 'مندي دجاج', qty: 1, note: '', product_id: null }] }),
  read({ kind: 'reprint', ticket_no: '06-1', dining: 'سفري', items: [{ name: 'مندي دجاج', qty: 2, note: '', product_id: null }] }),
  read({ kind: 'test', ticket_no: '', dining: '', items: [] }),
];

test.before(async () => {
  await new Promise(r => mock.listen(0, r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-pk-'));
  const fx = path.join(dir, 'ai.json'); fs.writeFileSync(fx, JSON.stringify(FIX));
  const port = 39000 + Math.floor(Math.random() * 900); B = `http://127.0.0.1:${port}`; PP = port + 1000;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: port, PRINTER_PORT: PP, DATA_DIR: dir, AI_FIXTURE: fx, LOYVERSE_BASE: `http://127.0.0.1:${mock.address().port}` }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  today = (await call('GET', '/api/me')).today;
  await call('POST', '/api/settings', { loyverse_token: 'x' });
  assert.ok((await call('POST', '/api/sync', { full: true })).ok);
});
test.after(() => { srv.kill(); mock.close(); });

test('kitchen slips => tickets (printed − cancelled), takeaway packaging vs purchases', async () => {
  for (let i = 1; i <= FIX.length; i++) await print('slip ' + i);
  let tk;
  for (let i = 0; i < 80; i++) { tk = await call('GET', '/api/printer/tickets?date=' + today); if (!tk.unread && tk.tickets.length === 3) break; await new Promise(r => setTimeout(r, 50)); }
  assert.strictEqual(tk.unread, 0);
  const byNo = Object.fromEntries(tk.tickets.map(t => [t.ticket_no, t]));
  assert.deepStrictEqual(Object.keys(byNo).sort(), ['06-1', '06-2', '06-3'], 'التجربة وإعادة الطباعة ما تطلع');
  assert.strictEqual(byNo['06-1'].value, 61); assert.strictEqual(byNo['06-1'].dining, 'takeaway'); assert.strictEqual(byNo['06-1'].status, 'open');
  assert.strictEqual(byNo['06-3'].status, 'cancelled'); assert.strictEqual(byNo['06-3'].value, 0); assert.strictEqual(byNo['06-3'].events.length, 2);
  assert.deepStrictEqual(tk.total, { tickets: 2, value: 91, cancelled: 1, by_dining: { takeaway: 1, dine_in: 1 } });

  // التغليف: المندي سفري/توصيل = ١ قصدير، وكل طلب = ١ كيس
  const foil = (await call('POST', '/api/items', { name: 'قصدير', unit: 'حبة', daily: 0, kind: 'raw' })).id;
  const bag = (await call('POST', '/api/items', { name: 'كيس ورق ٥', unit: 'حبة', daily: 0, kind: 'raw' })).id;
  const mandi = (await call('GET', '/api/packaging')).products.find(p => p.name === 'مندي دجاج').id;
  await call('POST', '/api/packaging/rules', { product_id: mandi, dining: 'out', item_id: foil, qty: 1 });
  await call('POST', '/api/packaging/rules', { product_id: null, dining: 'out', item_id: bag, qty: 1 });
  await call('POST', '/api/purchases', { date: today, payment: 'paid', lines: [{ item_id: foil, qty: 10, unit_price: 1 }] });
  const pk = await call('GET', `/api/packaging?from=${today}&to=${today}`);
  const it = Object.fromEntries(pk.items.map(i => [i.name, i]));
  // سفري ٠٦-١ بس (المحلي ما ياخذ، والتوصيل انلغى)
  assert.strictEqual(it['قصدير'].expected, 2); assert.strictEqual(it['قصدير'].bought, 10); assert.strictEqual(it['قصدير'].diff, 8);
  assert.strictEqual(it['كيس ورق ٥'].expected, 1);
  assert.deepStrictEqual(pk.no_rule, [{ name: 'ماء صغير', qty: 1 }]);
  assert.deepStrictEqual(pk.orders.days, [{ date: today, dine_in: 1, takeaway: 1, delivery: 0, unknown: 0 }]);
  await assert.rejects(call('POST', '/api/packaging/rules', { product_id: mandi, item_id: foil, qty: 0 }), /أكبر من صفر/);
});
