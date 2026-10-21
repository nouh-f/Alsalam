'use strict';
// 🐟 السمك اللي من الثلاجة اللي ورا: العرض بالليل أكثر من اللي نزّله => يسأله «نزّلت وما سجّلت؟» — يسجّل «نزّلت» ويحفظ، أو «ما نزّلت» ونوح يدري
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

let srv, B, T;
const raw = async (tok, method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, j: await r.json() };
};
const req = async (tok, method, p, body) => { const { status, j } = await raw(tok, method, p, body); if (status >= 400) throw Object.assign(new Error(j.error), { status }); return j; };
const login = async (id, pin) => (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: id, pin }) })).json()).token;

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-down-'));
  const port = 40000 + Math.floor(Math.random() * 400); B = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, PRINTER_PORT: 0, DATA_DIR: dir, WA_TEST_INJECT: '1' }, stdio: 'inherit' });
  for (let i = 0; i < 80; i++) { try { await fetch(B + '/api/login-users'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  T = await login(1, '1234');
});
test.after(() => srv.kill());

test('display fish counted above what was brought down: asks, «brought down» fixes it, «no» tells the owner', async () => {
  const me = (await req(T, 'GET', '/api/users')).find(x => x.id === 1);
  await req(T, 'POST', '/api/users', { id: 1, name: me.name, role: 'owner', pin: '1234', phone: '0500000980' });
  const { id: w } = await req(T, 'POST', '/api/users', { name: 'محمد سمك', role: 'worker', pin: '8383' });
  const WT = await login(w, '8383');
  const mk = async name => {
    const { id } = await req(T, 'POST', '/api/items', { name, unit: 'كجم', daily: 1, kind: 'raw', carry_over: 1, leftover: 'fridge', buy_store: true, no_opening: true });
    await req(T, 'POST', '/api/responsibility', { item_id: id, user_id: w });
    return id;
  };
  const ham = await mk('هامور نزول'), har = await mk('حريد نزول');
  const today = (await req(WT, 'GET', '/api/me')).today;
  for (const id of [ham, har]) await req(T, 'POST', '/api/purchases', { date: today, supplier: 'دعدع', payment: 'cash', lines: [{ item_id: id, qty: 20, unit_price: 40, to_floor: false }] });
  await req(WT, 'POST', '/api/add', { date: today, item_id: ham, qty: 5, source: 'fridge' });
  await req(WT, 'POST', '/api/add', { date: today, item_id: har, qty: 2, source: 'fridge' });

  // نزّل ٥ وما انباع شي، وكتب ٨ => يسأله (المفروض ٥، الزيادة ٣)
  const r1 = await raw(WT, 'POST', '/api/count', { date: today, item_id: ham, phase: 'closing', qty: 8 });
  assert.strictEqual(r1.status, 409); assert.ok(r1.j.needDown); assert.strictEqual(r1.j.extra, 3); assert.strictEqual(r1.j.expected, 5);
  // «نزّلت ٣ من ورا» => ينحفظ ٨، واللي ورا نقص ٨
  await req(WT, 'POST', '/api/add', { date: today, item_id: ham, qty: 3, source: 'fridge', net: true, force: true });
  await req(WT, 'POST', '/api/count', { date: today, item_id: ham, phase: 'closing', qty: 8 });
  const st = (await req(T, 'GET', '/api/warehouse')).find(i => i.id === ham);
  assert.strictEqual(st.balance ?? st.qty ?? st.upstairs, 12 + 8, 'ورا: ٢٠ − ٨ نزل + ٨ رجع بالليل');

  // «ما نزّلت» => ينحفظ ونوح يدري
  const n0 = (await req(T, 'GET', '/api/whatsapp/_outbox')).length;
  await req(WT, 'POST', '/api/count', { date: today, item_id: har, phase: 'closing', qty: 4, force: true });
  let ob = [];
  for (let i = 0; i < 60; i++) { ob = (await req(T, 'GET', '/api/whatsapp/_outbox')).slice(n0); if (ob.some(x => /قال ما نزّل/.test(x.text))) break; await new Promise(r => setTimeout(r, 50)); }
  assert.ok(ob.some(x => x.to === '966500000980' && /محمد سمك: حريد نزول في العرض 4 والمفروض 2/.test(x.text)), JSON.stringify(ob));
});
