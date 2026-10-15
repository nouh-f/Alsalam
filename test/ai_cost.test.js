'use strict';
// 💵 حساب التكلفة: كتابة كاش الساعة ×2، والخمس دقايق ×1.25، والقراءة ×0.1
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alsalam-cost-'));
const AI = require('../server/ai');

test('cache writes: 1h costs 2x input, 5m costs 1.25x; old usage without the breakdown stays 1.25x', () => {
  const p = AI.MODELS.mid.price[0];
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  near(AI.costOf({ cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 } }, 'mid'), 1000 * p * 2 / 1e6);
  near(AI.costOf({ cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 1000 } }, 'mid'), 1000 * p * 1.25 / 1e6);
  near(AI.costOf({ cache_creation_input_tokens: 1000 }, 'mid'), 1000 * p * 1.25 / 1e6);
  near(AI.costOf({ cache_read_input_tokens: 1000 }, 'mid'), 1000 * p * 0.1 / 1e6);
});
