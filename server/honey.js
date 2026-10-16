'use strict';
// 🍯 قارورة عسل السلام: الصبح صورة (نقارنها بآخر أمس — الناقص من الليل) ← يعبّيها من الدبة ويصوّرها فل (المعبّى ينخصم من الدبة)
// ← آخر الدوام صورة: النازل = الصبح + المعبّى − الليل، مقابل المبيوع حسب الوصفة. النظام يقرر الخطوة، مو البوت
const crypto = require('node:crypto');
const { get, run, getSetting, setSetting } = require('./db');
const C = require('./calc');

const g = kg => Math.round((Number(kg) || 0) * 1000); // جرام
const nowISO = () => new Date().toISOString();

// القارورة = صنف «قارورة» له مصدر (الدبة)
function bottle() {
  const it = get("SELECT i.*, s.from_item_id AS src_id FROM items i JOIN item_sources s ON s.item_id = i.id WHERE i.active = 1 AND i.name LIKE '%قارورة%' ORDER BY i.id LIMIT 1");
  if (!it) return null;
  const src = get('SELECT id, name, unit, cost FROM items WHERE id = ?', it.src_id);
  return { item: it, src };
}
const rowOf = (date, id) => C.dailyBoard(date).rows.find(r => r.item_id === id) || null;
const ownerOf = (date, id) => { const r = rowOf(date, id); return r ? (r.closing_user_id || r.opening_user_id) : null; };
const state = date => { let s = {}; try { s = JSON.parse(getSetting('honey_flow') || '{}'); } catch { /* */ } return s.date === date ? s : { date, step: '' }; };
const save = s => setSetting('honey_flow', JSON.stringify(s));

function setCount(u, date, itemId, phase, qty) {
  run('INSERT INTO counts(date, item_id) VALUES(?,?) ON CONFLICT DO NOTHING', date, itemId);
  run(`UPDATE counts SET ${phase} = ?, ${phase}_by = ?, ${phase}_at = ? WHERE date = ? AND item_id = ?`, qty, u.id, nowISO(), date, itemId);
}
function refill(u, date, b, qty) {
  const ref = 'cv:' + crypto.randomUUID(), srcLoc = get('SELECT daily FROM items WHERE id = ?', b.src.id).daily ? 'floor' : 'warehouse';
  run("INSERT INTO moves(date, item_id, location, qty, type, ref, user_id, note) VALUES(?,?,?,?,'convert',?,?,?)", date, b.src.id, srcLoc, -qty, ref, u.id, `إلى ${b.item.name} (تعبئة)`);
  run("INSERT INTO moves(date, item_id, location, qty, type, ref, user_id, note) VALUES(?,?,'floor',?,'convert',?,?,?)", date, b.item.id, qty, ref, u.id, `من ${b.src.name} (تعبئة)`);
}

// weight بالكيلو (من صورة الميزان) | empty_tub: الدبة خلصت | end: قال «آخر الدوام»
function step(u, { weight = null, empty_tub = false, end = false } = {}, now = new Date()) {
  const b = bottle(); if (!b) return { error: 'ما فيه قارورة مربوطة بمصدر' };
  const date = C.businessDate(now), s = state(date), notify = [];
  const name = b.item.name, w = Number(weight);
  if (empty_tub) {
    notify.push({ to: 'owners', text: `🍯 ${u.name}: ${b.src.name} خلصت — ما قدر يعبّي ${name}` }, { to: 'buyers', text: `🚨 ${b.src.name} خلصت (قاله ${u.name}) — نبغى نشتري` });
    s.step = 'day'; save(s);
    return { ok: true, say: `تمام، وصل خبر لنوح وزكريا إن ${b.src.name} خلصت 🙏 وآخر الدوام صوّر القارورة على الميزان.`, notify };
  }
  if (!(w > 0)) return { error: 'ما قريت الوزن — قله يصوّر القارورة على الميزان والرقم واضح' };
  const row = rowOf(date, b.item.id);
  // ١- الصبح: أول اليوم
  if (row.opening == null) {
    setCount(u, date, b.item.id, 'opening', w);
    if (row.prev_closing != null && row.prev_closing - w > 0.005)
      notify.push({ to: 'owners', text: `⚠️ ${name} الصبح ${g(w)} جرام، وآخر أمس كانت ${g(row.prev_closing)} — ناقصة ${g(row.prev_closing - w)} جرام بالليل (مو من ${u.name})` });
    Object.assign(s, { step: 'fill', at: Date.now(), last: w, r1: 0, r2: 0 }); save(s);
    return { ok: true, say: `✓ سجلت أول اليوم: ${g(w)} جرام.\nالحين روح عبّيها من ${b.src.name} وصوّرها وهي *فل* ⏱️\nولو العسل خلص قل لي «العسل خلص».`, notify };
  }
  const last = s.last != null ? s.last : row.opening;
  const night = end || C.riyadhHour(now) >= Number(getSetting('wa_close_hour', '23')) - 3 || C.riyadhHour(now) < Number(getSetting('day_start_hour', '4'));
  // ٢- تعبئة (الوزن زاد)
  if (w - last > 0.01 && !end) {
    const q = C.r3(w - last); refill(u, date, b, q);
    Object.assign(s, { step: 'day', last: w }); save(s);
    return { ok: true, say: `✓ عبّيت ${g(q)} جرام من ${b.src.name} — القارورة الحين ${g(w)} جرام.\nآخر الدوام صوّرها مرة ثانية 🙏`, notify };
  }
  if (s.step === 'fill' && !night) return { ok: true, say: `ما عبّيتها؟ الوزن ما زاد (${g(w)} جرام). عبّها من ${b.src.name} وصوّرها وهي فل — ولو العسل خلص قل لي «العسل خلص».`, notify };
  if (!night) { s.last = w; save(s); return { ok: true, say: `✓ شفت الوزن ${g(w)} جرام. آخر الدوام صوّرها مرة ثانية 🙏`, notify }; }
  // ٣- آخر الدوام
  setCount(u, date, b.item.id, 'closing', w);
  Object.assign(s, { step: 'done', last: w }); save(s);
  const r = rowOf(date, b.item.id);
  const used = C.r3((r.opening || 0) + (r.received || 0) - w), sold = C.r3(r.theoretical || 0), diff = C.r3(used - sold);
  const cost = b.src.cost || b.item.cost || 0;
  const line = `${name}: الصبح ${g(r.opening)} + المعبّى ${g(r.received)} − الليل ${g(w)} = نزل *${g(used)} جرام*، والمبيوع ${g(sold)} جرام`;
  const verdict = Math.abs(diff) <= 0.02 ? 'مضبوط ✓' : diff > 0 ? `ناقص *${g(diff)} جرام*` : `زيادة ${g(-diff)} جرام`;
  notify.push({ to: 'owners', text: `🍯 ${u.name} — ${line} ← ${verdict}${diff > 0.02 && cost ? ` (≈ ${C.r2(diff * cost)} ريال)` : ''}` });
  return { ok: true, say: `✓ سجلت آخر الدوام.\n${line}\n${verdict}${diff > 0.02 ? ' — وش صار فيها؟ اشرح لنا 🙏' : ''}`, notify };
}

// ⏱️ العداد: ما صوّرها فل بعد ١٥ دقيقة ← تذكير، وبعد ٣٠ ← نوح
async function timer({ sendPrivate, owners, now = new Date() }) {
  const b = bottle(); if (!b) return [];
  const date = C.businessDate(now), s = state(date), out = [];
  if (s.step !== 'fill' || !s.at) return out;
  const min = (now.getTime() - s.at) / 60e3;
  const uid = ownerOf(date, b.item.id), w = uid ? get("SELECT name, phone FROM users WHERE id = ? AND active = 1 AND phone != ''", uid) : null;
  if (min >= 15 && !s.r1 && w) { s.r1 = 1; save(s); try { await sendPrivate(w.phone, `🍯 يا ${w.name}، عبّيت القارورة؟ صوّرها وهي فل وأرسلها هنا ⏱️`); out.push({ to: w.phone, kind: 'honey' }); } catch { /* */ } }
  if (min >= 30 && !s.r2) { s.r2 = 1; save(s); for (const o of owners) { try { await sendPrivate(o.phone, `🍯 ${w ? w.name : 'مسؤول القارورة'} صوّر ${b.item.name} الصبح، وله ٣٠ دقيقة ما صوّرها بعد التعبئة`); out.push({ to: o.phone, kind: 'honey_owner' }); } catch { /* */ } } }
  return out;
}

module.exports = { bottle, step, timer, ownerOf };
