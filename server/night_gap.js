'use strict';
// 🌙 نقص الليل: الصبح أقل من (باقي أمس − اللي انباع في الطابعة بعد جرد آخر الدوام) => ملاحظة للعامل + واتساب لنوح
// (بعد دقيقتين — لو صلّح رقمه في وقت التعديل ما يوصل شي)
const { get, all, getSetting, setSetting } = require('./db');
const C = require('./calc');

const isWeight = u => /^(كجم|كيلو|كغ|kg)$/i.test(String(u || '').trim());
// وقت الطابعة: «2026-10-16 09:00:00» (UTC من sqlite) أو ISO من الجسر
const atMs = s => { s = String(s || ''); if (!s) return NaN; return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z'); };
const hhmm = ms => { const d = new Date(ms + 3 * 3600e3); const h = d.getUTCHours(), m = String(d.getUTCMinutes()).padStart(2, '0'); return `${h % 12 || 12}:${m} ${h >= 12 ? 'م' : 'ص'}`; };

// كم انصرف من كل صنف حسب الوصفات من تذاكر الطابعة بين وقتين (الإلغاء ينطرح)
function useBetween(fromMs, toMs) {
  const use = new Map();
  if (!(toMs > fromMs)) return use;
  const d1 = C.businessDate(new Date(fromMs)), d2 = C.businessDate(new Date(toMs));
  const recipes = C.recipeMap();
  for (const o of all("SELECT o.kind, o.items, j.at FROM printer_orders o JOIN printer_jobs j ON j.id = o.job_id WHERE o.date BETWEEN ? AND ? AND o.kind IN ('order', 'cancel')", d1, d2)) {
    const t = atMs(o.at); if (!(t > fromMs && t <= toMs)) continue;
    const sign = o.kind === 'cancel' ? -1 : 1;
    for (const i of C.safeJSON(o.items, [])) {
      if (!i.product_id) continue;
      for (const l of recipes.get(i.product_id) || []) use.set(l.item_id, (use.get(l.item_id) || 0) + sign * l.qty * (Number(i.qty) || 0));
    }
  }
  return use;
}

// بعد ما ينحفظ أول اليوم: يرجع { note, alert } لو فيه نقص — وإلا null
function check(date, itemId) {
  const r = C.dailyBoard(date).rows.find(x => x.item_id === itemId);
  if (!r || r.opening == null || r.suggested_opening == null || r.no_opening) return null;
  const hb = require('./honey').bottle(); if (hb && hb.item.id === itemId) return null; // القارورة لها تنبيهها
  const prev = get('SELECT closing_at FROM counts WHERE date = ? AND item_id = ?', C.addDays(date, -1), itemId) || {};
  const to = Date.parse(r.opening_at) || Date.now();
  const from = Date.parse(prev.closing_at) || to;
  const sold = C.r3(Math.max(0, useBetween(from, to).get(itemId) || 0));
  const expected = C.r3(Math.max(0, r.suggested_opening - sold));
  const gap = C.r3(expected - r.opening);
  const tol = isWeight(r.unit) ? Math.max(0.05, expected * 0.03) : 0.5;
  if (!(gap > tol)) return null;
  const u = r.unit || '';
  const note = `🌙 أمس باقي ${r.suggested_opening}${sold ? ` وانباع بعد الجرد ${sold}` : ''} — المفروض ${expected}، وكتبت ${r.opening}: ناقص ${gap} ${u}. لو غلطت صلّحه الحين`;
  const alert = `🌙 نقص بالليل — ${r.name}: آخر أمس ${r.suggested_opening}${sold ? `، وانباع بعد الجرد ${sold}` : ''} => المفروض ${expected}، والصبح ${r.opening} (${r.opening_by || ''}). ناقص *${gap} ${u}*${prev.closing_at ? ` بين ${hhmm(from)} و${hhmm(to)}` : ''}`;
  return { note, alert, gap };
}

// تنبيه نوح مرة وحدة لكل صنف باليوم
function alertOnce(date, itemId, send) {
  const res = check(date, itemId); if (!res) return false;
  let seen = {}; try { seen = JSON.parse(getSetting('night_gap_alerts') || '{}'); } catch { /* */ }
  if (seen.date !== date) seen = { date, ids: [] };
  if (seen.ids.includes(itemId)) return false;
  seen.ids.push(itemId); setSetting('night_gap_alerts', JSON.stringify(seen));
  send(res.alert);
  return true;
}

module.exports = { useBetween, check, alertOnce, atMs };
