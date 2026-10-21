'use strict';
// 🍯 قارورة عسل السلام: خلوف يصوّرها الصبح على الميزان، والدعدع يصوّرها بالليل قبل ما يعبّي — النازل = الصبح − الليل مقابل المبيوع
// والمعبّى بالليل يطلع من فرق (الصبح − ليلة أمس) وينخصم من الدبة. النظام يقرر الخطوة، مو البوت
const crypto = require('node:crypto');
const { get, all, run, getSetting, setSetting } = require('./db');
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
const ownersOf = (date, id) => { const r = rowOf(date, id); return r ? [r.opening_user_id, r.closing_user_id].filter(Boolean) : []; };
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
// 🔁 الطريقة (من ٢١ أكتوبر): خلوف يوزنها الصبح (أول اليوم)، والدعدع يوزنها بالليل قبل ما يعبّي (آخر اليوم) ثم يعبّيها.
// المعبّى بالليل = وزن الصبح − وزن الليل حق أمس ← ينخصم من الدبة. التعبئة وسط اليوم: المشرف بس (خلوف).
const log = (date, kind, weight, image, u) => run("INSERT INTO honey_log(date, kind, weight, image, user_id, at) VALUES(?,?,?,?,?,datetime('now'))", date, kind, weight, image || '', u.id);
const takeFromTub = (u, date, b, qty) => { // التعبئة بالليل: الدبة بس (القارورة انجردت الصبح بوزنها الجديد)
  run("INSERT INTO moves(date, item_id, location, qty, type, ref, user_id, note) VALUES(?,?,?,?,'convert',?,?,?)", date, b.src.id,
    get('SELECT daily FROM items WHERE id = ?', b.src.id).daily ? 'floor' : 'warehouse', -qty, 'cv:' + crypto.randomUUID(), u.id, `إلى ${b.item.name} (تعبئة الليل)`);
};
function step(u, { weight = null, empty_tub = false, end = false, image = '' } = {}, now = new Date()) {
  const b = bottle(); if (!b) return { error: 'ما فيه قارورة مربوطة بمصدر' };
  const date = C.businessDate(now), s = state(date), notify = [];
  const name = b.item.name, w = Number(weight);
  if (empty_tub) {
    notify.push({ to: 'owners', text: `🍯 ${u.name}: ${b.src.name} خلصت — ما قدر يعبّي ${name}` }, { to: 'buyers', text: `🚨 ${b.src.name} خلصت (قاله ${u.name}) — نبغى نشتري` });
    log(date, 'empty_tub', null, image, u);
    return { ok: true, say: `تمام، وصل خبر لنوح وزكريا إن ${b.src.name} خلصت 🙏`, notify };
  }
  if (!(w > 0)) return { error: 'ما قريت الوزن — صوّر القارورة على الميزان والرقم واضح' };
  const row = rowOf(date, b.item.id), sup = ['owner', 'supervisor'].includes(u.role);
  const opener = row.opening_user_id, closer = row.closing_user_id;
  const isOpen = u.id === opener || (sup && u.id !== closer), isClose = u.id === closer;
  // ١- الصبح (خلوف): أول اليوم — والزيادة عن الليل = اللي عبّاه الدعدع بالليل
  if (row.opening == null && isOpen && !end) {
    setCount(u, date, b.item.id, 'opening', w); log(date, 'opening', w, image, u);
    let say = `✓ سجلت ${name} أول اليوم: ${g(w)} جرام.`;
    if (row.prev_closing != null) {
      const fill = C.r3(w - row.prev_closing);
      if (fill > 0.01) { takeFromTub(u, date, b, fill); say += `\nانعبّى بالليل ${g(fill)} جرام من ${b.src.name}.`; }
      else if (fill < -0.005) notify.push({ to: 'owners', text: `⚠️ ${name} الصبح ${g(w)} جرام، وبالليل كانت ${g(row.prev_closing)} — ناقصة ${g(-fill)} جرام بالليل (وزنها ${u.name})` });
    } else notify.push({ to: 'owners', text: `🍯 ${name} الصبح ${g(w)} جرام (${u.name}) — أمس بالليل ما انوزنت، فالتعبئة ما انحسبت` });
    Object.assign(s, { step: 'day', last: w }); save(s);
    return { ok: true, say, notify };
  }
  // ٢- تعبئة وسط اليوم: المشرف بس
  const last = s.last != null ? s.last : row.opening;
  if (sup && !isClose && !end && last != null && w - last > 0.01) {
    const q = C.r3(w - last); refill(u, date, b, q); log(date, 'fill', w, image, u);
    Object.assign(s, { step: 'day', last: w }); save(s);
    return { ok: true, say: `✓ عبّيت ${g(q)} جرام من ${b.src.name} — القارورة الحين ${g(w)} جرام.`, notify };
  }
  if (!isClose && !sup) return { error: 'القارورة مو عليك' };
  if (!isClose && !end) return { ok: true, say: `✓ شفت الوزن ${g(w)} جرام.`, notify };
  // ٣- بالليل (الدعدع): آخر اليوم — قبل ما يعبّي
  setCount(u, date, b.item.id, 'closing', w); log(date, 'closing', w, image, u);
  if (image) run('UPDATE counts SET closing_image = ? WHERE date = ? AND item_id = ?', image, date, b.item.id);
  Object.assign(s, { step: 'done', last: w }); save(s);
  const r = rowOf(date, b.item.id);
  if (r.opening == null) {
    notify.push({ to: 'owners', text: `🍯 ${u.name} وزن ${name} بالليل ${g(w)} جرام — بس الصبح ما انوزنت (خلوف)، فما نقدر نحسب اللي نزل` });
    return { ok: true, say: `✓ سجلت آخر اليوم: ${g(w)} جرام. الحين عبّيها 🍯`, notify };
  }
  const used = C.r3((r.opening || 0) + (r.received || 0) - w), sold = C.r3(r.theoretical || 0), diff = C.r3(used - sold);
  const cost = b.src.cost || b.item.cost || 0;
  const line = `${name}: الصبح ${g(r.opening)}${r.received ? ` + المعبّى ${g(r.received)}` : ''} − الليل ${g(w)} = نزل *${g(used)} جرام*، والمبيوع ${g(sold)} جرام`;
  const verdict = Math.abs(diff) <= 0.03 ? 'مضبوط ✓' : diff > 0 ? `ناقص *${g(diff)} جرام*` : `زيادة ${g(-diff)} جرام`;
  notify.push({ to: 'owners', text: `🍯 ${u.name} — ${line} ← ${verdict}${diff > 0.03 && cost ? ` (≈ ${C.r2(diff * cost)} ريال)` : ''}` });
  return { ok: true, say: `✓ سجلت آخر اليوم: ${g(w)} جرام. الحين عبّيها 🍯`, notify };
}

// ⏱️ العداد: ما صوّرها فل بعد ١٥ دقيقة ← تذكير، وبعد ٣٠ ← نوح
async function timer({ sendPrivate, owners, now = new Date() }) {
  const b = bottle(); if (!b) return [];
  const date = C.businessDate(now), s = state(date), out = [];
  if (s.step !== 'fill' || !s.at) return out;
  const min = (now.getTime() - s.at) / 60e3;
  const uid = ownerOf(date, b.item.id), w = uid ? get("SELECT name, phone FROM users WHERE id = ? AND active = 1 AND phone != ''", uid) : null;
  if (min >= 15 && !s.r1 && w) { s.r1 = 1; save(s); try { await sendPrivate(w.phone, `🍯 يا ${w.name}، عبّيت القارورة؟ صوّرها وهي فل من الرابط 🍯 ⏱️`); out.push({ to: w.phone, kind: 'honey' }); } catch { /* */ } }
  if (min >= 30 && !s.r2) { s.r2 = 1; save(s); for (const o of owners) { try { await sendPrivate(o.phone, `🍯 ${w ? w.name : 'مسؤول القارورة'} صوّر ${b.item.name} الصبح، وله ٣٠ دقيقة ما صوّرها بعد التعبئة`); out.push({ to: o.phone, kind: 'honey_owner' }); } catch { /* */ } } }
  return out;
}

// لصفحة الجرد: وين وصل اليوم + الصور
function info(date) {
  const b = bottle(); if (!b) return null;
  const s = state(date);
  return { item_id: b.item.id, src: b.src.name, step: s.step || '', at: s.at || 0, last: s.last ?? null,
    log: all('SELECT kind, weight, image, at FROM honey_log WHERE date = ? ORDER BY id', date) };
}

module.exports = { bottle, step, timer, ownerOf, ownersOf, info };
