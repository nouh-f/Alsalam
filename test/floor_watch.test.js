'use strict';
// 👀 مراقبة المحل: الرخيص يطلّع أغلاط، الأقوى يأكد بعضها بس => ينرسل اللي تأكد، ونفس الغلط ما يتكرر، والتقرير بالنسبة
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-floor-'));
const FX = path.join(dir, 'ai.json');
const say = o => ({ usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify(o) }] });
const fast = say({ tiles: [{ tile: 1, score: 70 }, { tile: 2, score: 90 }], findings: [
  { tile: 1, kind: 'gloves', who: 'اللي عند المغسلة بقميص بني', note: 'يغسل بدون قفاز', confidence: 85 },
  { tile: 2, kind: 'tools', who: '', note: 'ممسحة قدام الكاشير', confidence: 70 },
  { tile: 1, kind: 'phone', who: 'القاعد', note: 'يمكن جوال', confidence: 40 }] });
const mid = say({ ok: [{ i: 1, who: 'العامل اللي عند المغسلة', note: 'بدون قفاز', name: 'فؤاد' }] });
fs.writeFileSync(FX, JSON.stringify([fast, mid, fast, mid]));
Object.assign(process.env, { DATA_DIR: dir, AI_FIXTURE: FX });

test('confirmed findings are sent once per camera, unconfirmed and low-confidence ones are dropped, and the day gets a score', async () => {
  const { run, setSetting, all, UPLOAD_DIR } = require('../server/db');
  const CAM = require('../server/cameras');
  const FW = require('../server/floor_watch');
  setSetting('cam_bridge_token', 'x');
  CAM.setChannels([{ ch: 7, name: 'المطبخ', role: 'kitchen' }, { ch: 11, name: 'كاشير 1', role: 'cashier' }], { roles: true });
  fs.mkdirSync(CAM.DIR, { recursive: true });
  const pic = await require('sharp')({ create: { width: 16, height: 16, channels: 3, background: '#864' } }).jpeg().toBuffer();
  const snap = ch => { fs.writeFileSync(path.join(CAM.DIR, `f${ch}.jpg`), pic); return Number(run("INSERT INTO cam_snaps(at, ch, reason, ref, file, bytes) VALUES(datetime('now'), ?, 'floor', 'floor', ?, 1)", ch, `f${ch}.jpg`).lastInsertRowid); };
  // 🧑‍🍳 صورة فؤاد (نوح سمّاه) => الاسم يطلع في التنبيه
  const fid = (all("SELECT id FROM users WHERE name = 'فؤاد'")[0] || {}).id || Number(run("INSERT INTO users(name, role) VALUES('فؤاد', 'worker')").lastInsertRowid);
  fs.writeFileSync(path.join(UPLOAD_DIR, 'fuad.jpg'), pic);
  run('INSERT INTO floor_refs(user_id, file) VALUES(?,?)', fid, 'fuad.jpg');
  const sent = [];
  const send = async (img, text) => sent.push(text);

  const r = await FW.round({ force: true, snaps: [snap(7), snap(11)], send });
  assert.deepStrictEqual(r, { found: 1, sent: 1 });
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /المطبخ/);
  assert.match(sent[0], /بدون قفاز/);
  assert.match(sent[0], /\*فؤاد\*/);
  assert.strictEqual(all('SELECT user_id FROM floor_findings')[0].user_id, fid);
  assert.doesNotMatch(sent[0], /ممسحة|جوال/);

  // نفس الغلط بعد شوي => ينحفظ بس ما ينرسل
  const r2 = await FW.round({ force: true, snaps: [snap(7), snap(11)], send });
  assert.strictEqual(r2.sent, 0);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(all('SELECT * FROM floor_findings').length, 2);

  const rep = FW.report();
  assert.strictEqual(rep.score, 80);
  assert.deepStrictEqual(rep.areas.map(a => [a.name, a.score]), [['المطبخ', 70], ['الكاشير', 90]]);
  assert.deepStrictEqual(rep.kinds.map(k => [k.kind, k.n]), [['gloves', 2]]);
  assert.match(FW.reportText(rep), /80٪/);

  // نوح قال «غلط» => يطلع من التقرير
  FW.wrong(rep.findings[0].id);
  assert.strictEqual(FW.report().kinds[0].n, 1);
});

test('a reply naming the worker deducts from the fines table and sends him the photo; «ما في مشكلة» clears it; a named fault overrides', async () => {
  const { run, get, all } = require('../server/db');
  const FW = require('../server/floor_watch');
  const owner = get("SELECT * FROM users WHERE role = 'owner' LIMIT 1");
  const fuad = get("SELECT * FROM users WHERE name = 'فؤاد'");
  run("UPDATE users SET phone = '0500000888' WHERE id = ?", fuad.id);
  const cuts = [], pics = [];
  const deps = { by: owner, deduct: d => { cuts.push(d); return { done: true }; }, sendImage: async (to, buf, cap) => pics.push({ to, cap }) };
  const [a, b] = all('SELECT id FROM floor_findings ORDER BY id').map(r => r.id);
  // ↩️ رد على التنبيه نفسه (مو آخر رسالة) باسم العامل
  const r1 = await FW.decide({ ...deps, text: 'فؤاد', quoted: `👀 *المطبخ* — 2:30\n• *بدون قفاز* — العامل (#${a})` });
  assert.match(r1, /فؤاد.*20 ريال/);
  assert.strictEqual(cuts[0].worker.id, fuad.id);
  assert.strictEqual(cuts[0].amount, 20);
  assert.match(cuts[0].reason, /بدون قفاز/);
  assert.strictEqual(pics[0].to, '0500000888');
  assert.match(await FW.decide({ ...deps, text: 'فؤاد', quoted: `👀 (#${a})` }), /انحسم قبل/);
  assert.strictEqual(cuts.length, 1);
  // «ما في مشكلة» => ينشال وما يدخل التقرير
  assert.match(await FW.decide({ ...deps, text: 'ما في مشكلة', quoted: `👀 (#${b})` }), /انشال/);
  assert.strictEqual(get('SELECT wrong FROM floor_findings WHERE id = ?', b).wrong, 1);
  // نوح يصحح الغلط: «فؤاد جوال» => الغلط جوال، والمبلغ من الجدول
  run("INSERT INTO settings(key, value) VALUES('floor_fines', '{\"phone\":30}') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const c = Number(run("INSERT INTO floor_findings(date, ch, kind, who, note) VALUES('2026-10-24', 7, 'gloves', '', '')").lastInsertRowid);
  assert.match(await FW.decide({ ...deps, text: 'فؤاد جوال', quoted: `👀 (#${c})` }), /على الجوال.*30 ريال/);
  assert.strictEqual(get('SELECT kind FROM floor_findings WHERE id = ?', c).kind, 'phone');
  // بدون اسم معروف => يسأل
  const d = Number(run("INSERT INTO floor_findings(date, ch, kind, who, note) VALUES('2026-10-24', 7, 'cap', '', '')").lastInsertRowid);
  assert.match(await FW.decide({ ...deps, text: 'هذا واحد ما أعرفه', quoted: `👀 (#${d})` }), /مين العامل/);
});
