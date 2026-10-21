'use strict';
// ⏰ العامل: أول الدوام من ٤ الفجر لين ١١ الليل، وآخر الدوام من ١١ لين ٤ — ويوم ثاني للمشرف بس
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SRV = [];
test.after(() => { for (const s of SRV) s.kill(); });
const boot = async hour => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-win-'));
  const port = 47400 + Math.floor(Math.random() * 300), B = `http://127.0.0.1:${port}`;
  const srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir, COUNT_WINDOW: '1', FAKE_HOUR: String(hour) }, stdio: 'inherit' });
  SRV.push(srv);
  for (let i = 0; i < 150; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const req = async (tok, method, p, body) => {
    const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
  };
  const login = async (id, pin) => (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: id, pin }) })).json()).token;
  const T = await login(1, '1234'), today = (await req(T, 'GET', '/api/me')).today;
  const { id: w } = await req(T, 'POST', '/api/users', { name: 'عامل وقت', role: 'worker', pin: '6161' });
  const { id: it } = await req(T, 'POST', '/api/items', { name: 'صنف وقت', unit: 'حبة', daily: 1, kind: 'raw' });
  await req(T, 'POST', '/api/responsibility', { item_id: it, user_id: w, opener_id: w });
  return { srv, req, T, WT: await login(w, '6161'), today, it };
};

test('daytime: worker can count opening only, not closing, not another day; owner any time', async () => {
  const { srv, req, T, WT, today, it } = await boot(13);
  try {
    assert.strictEqual((await req(WT, 'GET', '/api/me')).count_window.night, false);
    await req(WT, 'POST', '/api/count', { date: today, item_id: it, phase: 'opening', qty: 5 });
    await assert.rejects(req(WT, 'POST', '/api/count', { date: today, item_id: it, phase: 'closing', qty: 3 }), /آخر الدوام يفتح الساعة 11 بالليل/);
    const yday = new Date(Date.parse(today + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
    await assert.rejects(req(WT, 'POST', '/api/count', { date: yday, item_id: it, phase: 'opening', qty: 3 }), /يوم ثاني/);
    await req(T, 'POST', '/api/count', { date: today, item_id: it, phase: 'closing', qty: 3 });
  } finally { srv.kill(); }
});

test('night: worker can count closing only', async () => {
  const { srv, req, WT, today, it } = await boot(23);
  try {
    await req(WT, 'POST', '/api/count', { date: today, item_id: it, phase: 'closing', qty: 2 });
    await assert.rejects(req(WT, 'POST', '/api/count', { date: today, item_id: it, phase: 'opening', qty: 5 }), /أول الدوام خلص/);
  } finally { srv.kill(); }
});

test('count_window off: worker counts opening or closing any time — but still only today', async () => {
  const { srv, req, T, WT, today, it } = await boot(13);
  try {
    await req(T, 'POST', '/api/settings', { count_window: '0' });
    assert.strictEqual((await req(WT, 'GET', '/api/me')).count_window.on, false);
    await req(WT, 'POST', '/api/count', { date: today, item_id: it, phase: 'closing', qty: 3 });
    await req(WT, 'POST', '/api/count', { date: today, item_id: it, phase: 'opening', qty: 5 });
    const yday = new Date(Date.parse(today + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
    await assert.rejects(req(WT, 'POST', '/api/count', { date: yday, item_id: it, phase: 'opening', qty: 3 }), /يوم ثاني/);
  } finally { srv.kill(); }
});
