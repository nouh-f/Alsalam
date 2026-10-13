'use strict';
// 🖨️ «طابعة المحل»: الجسر (جوال في المحل) يستقبل أوراق الكاشير ويرفعها — ولو فصل النت يحفظها لين يرجع، وبوقتها الأصلي، ومرة وحدة بس
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

let srv, bridge, B, T, PORT, DIR, QDIR, BP;
const startServer = async () => {
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT, PRINTER_PORT: 0, DATA_DIR: DIR, CAM_POLL_MS: '500' }, stdio: 'inherit' });
  for (let i = 0; i < 80; i++) { try { await fetch(B + '/api/login-users'); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
};
const stopServer = () => new Promise(r => { srv.once('exit', r); srv.kill(); });
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const until = async (fn, n = 200) => { for (let i = 0; i < n; i++) { const v = await fn().catch(() => null); if (v) return v; await new Promise(r => setTimeout(r, 100)); } throw new Error('ما صار'); };
const slip = t => Buffer.concat([Buffer.from([0x1b, 0x40, 0x1b, 0x61, 0x01]), Buffer.from(`*** المطبخ ***\n${t}\n1 x ماء صغير\n`.padEnd(80, ' ')), Buffer.from([0x1d, 0x56, 0x00])]);
const toBridge = (buf, { reply = false } = {}) => new Promise((resolve, reject) => {
  const s = net.connect(BP, '127.0.0.1'); const got = [];
  s.on('data', d => got.push(d)); s.on('error', reject);
  s.on('connect', () => { s.write(buf); if (!reply) s.end(); else setTimeout(() => s.end(), 300); });
  s.on('close', () => resolve(Buffer.concat(got)));
});

test.before(async () => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-bp-'));
  QDIR = path.join(DIR, 'queue');
  PORT = 41500 + Math.floor(Math.random() * 400); B = `http://127.0.0.1:${PORT}`; BP = PORT + 1000;
  await startServer();
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
});
test.after(() => { if (bridge) bridge.kill(); if (srv) srv.kill(); });

test('the shop phone is the printer: answers status, uploads slips, keeps them while offline and sends once when back', async () => {
  const { code } = await call('POST', '/api/cam/pair');
  bridge = spawn(process.execPath, [path.join(__dirname, '..', 'deploy', 'bridge.js'), B], {
    env: { ...process.env, CAM_CONFIG: path.join(DIR, 'bridge.json'), CAM_CODE: code, NVR_URL: 'none', BRIDGE_PRINTER_PORT: BP, BRIDGE_QUEUE: QDIR }, stdio: 'ignore' });
  await until(async () => (await call('GET', '/api/printer/jobs')).bridge.online);

  // «وش حالك؟» => شغالة (الكاشير يحسبها طابعة)
  assert.deepStrictEqual([...await toBridge(Buffer.from([0x10, 0x04, 0x01]), { reply: true })], [0x12]);
  // فحص/زبالة ما تنحفظ
  await toBridge(Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n'.padEnd(100, ' ')));

  await toBridge(slip('#06-1'));
  const j1 = await until(async () => { const r = await call('GET', '/api/printer/jobs'); return r.total === 1 && r; });
  assert.strictEqual(j1.jobs[0].ip, 'bridge'); assert.match(j1.jobs[0].text, /#06-1/);

  // النت فاصل: الأوراق تقعد في الجوال
  await stopServer();
  const before = new Date();
  await toBridge(slip('#06-2')); await toBridge(slip('#06-3'));
  await until(async () => fs.readdirSync(QDIR).filter(f => f.endsWith('.json')).length === 2);
  await new Promise(r => setTimeout(r, 1500));
  const back = new Date();
  await startServer();
  const r = await until(async () => { const x = await call('GET', '/api/printer/jobs'); return x.total === 3 && x; });
  assert.strictEqual(fs.readdirSync(QDIR).filter(f => f.endsWith('.json')).length, 0, 'انمسحت من الجوال بعد ما وصلت');
  const late = r.jobs.filter(x => /#06-[23]/.test(x.text));
  assert.strictEqual(late.length, 2);
  for (const x of late) {
    const t = Date.parse(x.at.replace(' ', 'T') + 'Z');
    assert.ok(t >= before.getTime() - 2000 && t < back.getTime(), `بوقتها الأصلي: ${x.at}`);
  }

  // نفس الورقة مرتين (الجوال ما وصله الرد) => تنحفظ مرة
  const token = JSON.parse(fs.readFileSync(path.join(DIR, 'bridge.json'), 'utf8')).token;
  const post = () => fetch(B + '/api/cam/bridge/print', { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': token }, body: JSON.stringify({ id: 'x-1', at: new Date().toISOString(), raw_b64: slip('#06-4').toString('base64') }) }).then(x => x.json());
  const a = await post(), b2 = await post();
  assert.ok(a.id && b2.dup && a.id === b2.id);
  assert.strictEqual((await call('GET', '/api/printer/jobs')).total, 4);
  // بدون توكن الجسر ما يقدر
  assert.strictEqual((await fetch(B + '/api/cam/bridge/print', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"y","raw_b64":"AA=="}' })).status, 401);
});
