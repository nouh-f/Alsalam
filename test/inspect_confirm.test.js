'use strict';
// ✋ «إجادة»: الرخيص قال مفتش بس الأقوى رفض (زبون بتيشيرت أزرق) => ما ينرسل شي، والتنبيه الحقيقي ما يتوقف
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-insp-'));
const FX = path.join(dir, 'ai.json');
const say = o => ({ usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify(o) }] });
fs.writeFileSync(FX, JSON.stringify([say({ inspector: true, confidence: 80, note: 'لابس أزرق' }), say({ inspector: false, confidence: 90, note: 'تيشيرت أزرق وجينز — زبون' })]));
Object.assign(process.env, { DATA_DIR: dir, AI_FIXTURE: FX });

test('a cheap-model hit the stronger model rejects sends nothing', async () => {
  const { run, setSetting, getSetting } = require('../server/db');
  const CAM = require('../server/cameras');
  const IW = require('../server/inspect_watch');
  setSetting('cam_bridge_token', 'x');
  fs.mkdirSync(CAM.DIR, { recursive: true });
  fs.writeFileSync(path.join(CAM.DIR, 't.jpg'), await require('sharp')({ create: { width: 16, height: 16, channels: 3, background: '#24a' } }).jpeg().toBuffer());
  const sid = Number(run("INSERT INTO cam_snaps(at, ch, reason, ref, file, bytes) VALUES(datetime('now'), 15, 'inspect', 'inspect', 't.jpg', 1)").lastInsertRowid);
  const sent = [];
  const r = await IW.tick({ force: true, snaps: [sid], send: async (img, text) => sent.push(text) });
  assert.strictEqual(r.inspector, false);
  assert.match(r.why, /زبون/);
  assert.strictEqual(sent.length, 0);
  assert.ok(!getSetting('inspect_cam_at'));
  assert.strictEqual(IW.status().rejected, 1);
});
