'use strict';
// 🗜️ الصور تتصغر قبل Claude: الكلام 800، والأوراق 1280، JPEG — وصورة خربانة ترجع زي ما هي (مع تحذير)
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-img-'));
const sharp = require('sharp');
const IMG = require('../server/img');

test('big photos shrink to 800 (chat) / 1280 (documents); a broken image is passed through and logged', async () => {
  const big = (await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#fafafa' } }).png().toBuffer()).toString('base64');
  for (const [kind, max] of [['chat', 800], ['doc', 1280]]) {
    const r = await IMG.shrinkB64(big, 'image/png', kind);
    const m = await sharp(Buffer.from(r.data, 'base64')).metadata();
    assert.strictEqual(r.media_type, 'image/jpeg'); assert.strictEqual(Math.max(m.width, m.height), max);
  }
  const bad = await IMG.shrinkB64('AAAA', 'image/png', 'chat');
  assert.strictEqual(bad.data, 'AAAA');
  const { all } = require('../server/db');
  assert.ok(all("SELECT * FROM ai_log WHERE kind = 'img_fail'").length >= 1, 'التحذير انكتب في السجل');
  assert.ok(IMG.ready());
});
