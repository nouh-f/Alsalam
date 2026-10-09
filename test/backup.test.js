'use strict';
// النسخة على قوقل درايف (قوقل وهمي) + تقرير الشهر للمحاسب (Excel)
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
const { spawn } = require('node:child_process');

// ===== قوقل وهمي =====
const G = { files: new Map(), n: 0, tokens: [], deleted: 0, puts: new Map() };
const google = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const json = (code, j, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(j)); };
  if (u.pathname === '/token') {
    const p = new URLSearchParams(body.toString());
    G.tokens.push(p.get('grant_type'));
    if (p.get('client_secret') !== 'SECRET-123456') return json(401, { error: 'invalid_client' });
    if (p.get('grant_type') === 'authorization_code') return p.get('code') === 'C1' ? json(200, { access_token: 'A1', refresh_token: 'R1', expires_in: 3600 }) : json(400, { error: 'invalid_grant' });
    return p.get('refresh_token') === 'R1' ? json(200, { access_token: 'A2', expires_in: 3600 }) : json(400, { error: 'invalid_grant' });
  }
  if (!/^Bearer A[12]$/.test(req.headers.authorization || '') && !u.pathname.startsWith('/put/')) return json(401, { error: { message: 'no auth' } });
  if (u.pathname === '/drive/v3/files' && req.method === 'POST') { const m = JSON.parse(body); const id = 'F' + (++G.n); G.files.set(id, { id, ...m, parent: (m.parents || [])[0], t: G.n }); return json(200, { id }); }
  if (u.pathname === '/drive/v3/files' && req.method === 'GET') {
    const parent = /'([^']+)' in parents/.exec(u.searchParams.get('q'))[1];
    return json(200, { files: [...G.files.values()].filter(f => f.parent === parent).sort((a, b) => b.t - a.t).map(f => ({ id: f.id, name: f.name })) });
  }
  const m = /^\/drive\/v3\/files\/(.+)$/.exec(u.pathname);
  if (m && req.method === 'GET') return G.files.has(m[1]) ? json(200, { id: m[1], trashed: false }) : json(404, { error: { message: 'nf' } });
  if (m && req.method === 'DELETE') { G.files.delete(m[1]); G.deleted++; res.writeHead(204); return res.end(); }
  if (u.pathname === '/upload/drive/v3/files') {
    const meta = JSON.parse(body); const k = 'U' + (++G.n);
    G.puts.set(k, meta);
    res.writeHead(200, { location: `http://127.0.0.1:${google.address().port}/put/${k}` }); return res.end();
  }
  const pm = /^\/put\/(.+)$/.exec(u.pathname);
  if (pm) { const meta = G.puts.get(pm[1]); const id = 'F' + (++G.n); G.files.set(id, { id, name: meta.name, parent: meta.parents[0], data: body, t: G.n }); return json(200, { id }); }
  json(404, {});
});

let srv, B, T, today;
const call = async (method, p, body, tok = T) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  if (r.status === 302) return { location: r.headers.get('location') };
  if ((r.headers.get('content-type') || '').includes('spreadsheet')) return { buf: Buffer.from(await r.arrayBuffer()), disp: r.headers.get('content-disposition') };
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const byName = re => [...G.files.values()].filter(f => re.test(f.name));

test.before(async () => {
  await new Promise(r => google.listen(0, r));
  const g = `http://127.0.0.1:${google.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-gd-'));
  const port = 33000 + Math.floor(Math.random() * 3000); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: port, DATA_DIR: dir, GOOGLE_OAUTH_BASE: g, GOOGLE_DRIVE_BASE: g, GOOGLE_AUTH_URL: g + '/auth' }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1, pin: '1234' }) })).json()).token;
  today = (await call('GET', '/api/me')).today;
});
test.after(() => { srv.kill(); google.close(); });

test('google drive: connect once, daily backup of db + images + accountant report, keep 30', async () => {
  await assert.rejects(call('POST', '/api/gdrive/config', { client_id: 'abc', client_secret: 'x' }), /googleusercontent/);
  let st = await call('POST', '/api/gdrive/config', { client_id: 'ID1.apps.googleusercontent.com', client_secret: 'SECRET-123456' });
  assert.strictEqual(st.configured, true); assert.strictEqual(st.connected, false);
  const redirect = B + '/api/gdrive/callback';
  const { url } = await call('POST', '/api/gdrive/auth', { redirect });
  const q = new URL(url).searchParams;
  assert.strictEqual(q.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.strictEqual(q.get('redirect_uri'), redirect); assert.strictEqual(q.get('access_type'), 'offline');
  // رابط قديم/مزوّر: ما يربط
  assert.match((await call('GET', '/api/gdrive/callback?code=C1&state=bad')).location, /gdrive=/);
  assert.strictEqual((await call('GET', '/api/gdrive')).connected, false);
  // بدون تسجيل دخول: يرجع للإعدادات برسالة
  assert.match((await call('GET', `/api/gdrive/callback?code=C1&state=${q.get('state')}`, null, 'nope')).location, /gdrive=/);
  // صورة تذكرة (تنرفع مع النسخة)
  await call('POST', '/api/tickets', { date: today, images: [] });
  await call('POST', '/api/purchases', { date: today, supplier: 'محل', payment: 'cash', total: 50, image: 'data:image/jpeg;base64,/9j/AAAA' });
  assert.strictEqual((await call('GET', `/api/gdrive/callback?code=C1&state=${q.get('state')}`)).location, '/#/settings?gdrive=ok');
  // أول نسخة تبدأ لحالها بعد الربط — ننتظرها
  for (let i = 0; i < 50 && !(await call('GET', '/api/gdrive')).last_backup; i++) await new Promise(r => setTimeout(r, 100));
  st = await call('GET', '/api/gdrive');
  assert.strictEqual(st.connected, true); assert.ok(st.last_backup); assert.strictEqual(st.last_error, ''); assert.match(st.folder_url, /drive\.google\.com\/drive\/folders\/F/);
  const dbs = byName(/^alsalam-.*\.db\.gz$/);
  assert.strictEqual(dbs.length, 1);
  assert.strictEqual(zlib.gunzipSync(dbs[0].data).subarray(0, 15).toString(), 'SQLite format 3');
  assert.strictEqual(st.images, 1); assert.strictEqual(byName(/\.jpg$/).length, 1);
  const prev = new Date(Date.parse(today.slice(0, 7) + '-01T00:00:00Z') - 864e5).toISOString().slice(0, 7);
  assert.strictEqual(byName(/^تقرير-.*\.xlsx$/)[0].name, `تقرير-${prev}.xlsx`);
  assert.strictEqual(st.last_report, prev);

  // نسخة ثانية: الصور والتقرير ما يتكررون، والقديم فوق 30 ينحذف
  const dbFolder = dbs[0].parent;
  for (let i = 0; i < 31; i++) G.files.set('OLD' + i, { id: 'OLD' + i, name: `alsalam-old-${i}.db.gz`, parent: dbFolder, t: -i });
  const r = await call('POST', '/api/gdrive/backup', {});
  assert.strictEqual(r.images, 0); assert.strictEqual(r.report, null);
  assert.strictEqual([...G.files.values()].filter(f => f.parent === dbFolder).length, 30);
  assert.strictEqual(byName(/^تقرير-/).length, 1);
  assert.ok(G.tokens.filter(t => t === 'refresh_token').length <= 1, 'access token reused');

  st = await call('DELETE', '/api/gdrive');
  assert.strictEqual(st.connected, false);
  await assert.rejects(call('POST', '/api/gdrive/backup', {}), /مو مربوط/);
});

test('monthly accountant report: summary, Excel file, owner only', async () => {
  const month = today.slice(0, 7);
  await call('POST', '/api/expenses', { date: today, amount: 30, category: 'غاز', note: 'دبة' });
  await call('POST', '/api/payroll', { user_id: 2, type: 'bonus', amount: 100, date: today });
  const r = await call('GET', '/api/monthly-report?month=' + month);
  assert.strictEqual(r.summary.purchases, 50); assert.strictEqual(r.summary.expenses, 30);
  assert.ok(r.summary.salaries >= 100);
  assert.ok(r.days.some(d => d.date === today));
  const x = await call('GET', '/api/monthly-report/xlsx?month=' + month);
  assert.strictEqual(x.buf.subarray(0, 2).toString(), 'PK');
  assert.match(decodeURIComponent(x.disp), new RegExp(`تقرير-${month}\\.xlsx`));
  // كل الأوراق موجودة (أسماء الأوراق في workbook.xml — مضغوطة، فنفك الزيب البسيط)
  const names = [], buf = x.buf;
  for (let i = 0; i + 30 < buf.length;) {
    if (buf.readUInt32LE(i) !== 0x04034b50) break;
    const csize = buf.readUInt32LE(i + 18), nlen = buf.readUInt16LE(i + 26), elen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nlen).toString();
    const data = zlib.inflateRawSync(buf.subarray(i + 30 + nlen + elen, i + 30 + nlen + elen + csize)).toString();
    if (name === 'xl/workbook.xml') names.push(...[...data.matchAll(/sheet name="([^"]+)"/g)].map(m => m[1]));
    i += 30 + nlen + elen + csize;
  }
  assert.deepStrictEqual(names, ['الملخص', 'الأيام', 'المشتريات', 'المصروفات', 'سداد الموردين', 'الرواتب', 'مبيعات الأصناف']);
  // المشرف ما يشوفه (فيه الرواتب)
  const sup = await call('POST', '/api/users', { name: 'مشرف تقرير', role: 'supervisor', pin: '7777' });
  const st = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: sup.id, pin: '7777' }) })).json()).token;
  await assert.rejects(call('GET', '/api/monthly-report', null, st), e => e.status === 403);
  await assert.rejects(call('GET', '/api/gdrive', null, st), e => e.status === 403);
});
