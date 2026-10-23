'use strict';
// 🧯 مشاكل البرنامج عند العمال: الجوال يبلّغ (حتى لو انمسح دخوله)، ونوح بس يشوفها
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

let srv, B;
const j = async (method, p, body, tok) => { const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json() }; };
test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-applog-'));
  const port = 46000 + Math.floor(Math.random() * 900); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
});
test.after(() => srv.kill());

test('a worker\'s phone reports problems; only the owner reads them', async () => {
  const T = (await j('POST', '/api/login', { user_id: 1, pin: '1234' })).data.token;
  await j('POST', '/api/users', { name: 'صابر س', role: 'worker', pin: '1111' }, T);
  const id = (await j('GET', '/api/users', null, T)).data.find(u => u.name === 'صابر س').id;
  const W = (await j('POST', '/api/login', { user_id: id, pin: '1111' })).data.token;
  await j('POST', '/api/app-log', { kind: 'reject', msg: 'صوّر الصنف أول — POST /api/count', page: '#/count', dev: 'd1' }, W);
  await j('POST', '/api/app-log', { kind: 'out', msg: '/api/board', who: 'صابر س', dev: 'd1' }, 'expired-token'); // انمسح دخوله: الاسم من الجوال
  await j('POST', '/api/app-log', { kind: 'weird', msg: 'x', dev: 'd1' });
  assert.strictEqual((await j('GET', '/api/app-log', null, W)).status, 403);
  const r = (await j('GET', '/api/app-log', null, T)).data;
  assert.strictEqual(r.rows.length, 3);
  assert.ok(r.rows.some(x => x.kind === 'reject' && x.user_id === id && x.who === 'صابر س' && /صوّر/.test(x.msg)));
  assert.ok(r.rows.some(x => x.kind === 'out' && !x.user_id && x.who === 'صابر س'));
  assert.ok(r.rows.some(x => x.kind === 'error'), 'نوع غريب => خطأ');
});
