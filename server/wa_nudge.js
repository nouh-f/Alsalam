'use strict';
// 📣 «يلسعهم»: تنبيهات في «جروب المطعم» — اللي ما دخّل جرده، والنقص — بأسمائهم، مرة وحدة في اليوم لكل تنبيه
// قوالب ثابتة (مو ذكاء اصطناعي): قرصة خفيفة بدون إهانة — وبدون مبالغ في القروب (العمال ما لهم في الفلوس، الكمية بس)
// المبالغ تروح للمالك والمشرفين (صلاحية المبيعات) في الخاص
const { all, get, run, getSetting } = require('./db');
const C = require('./calc');

const pick = list => list[Math.floor(Math.random() * list.length)];
const names = arr => [...new Set(arr.filter(x => x && x !== '—'))];

const OPEN = [
  n => `⏰ ${n} — جرد أول اليوم ينتظركم 😴 دخّلوه قبل ما يزعل المشرف!`,
  n => `👀 ${n} — نسيتوا جرد أول اليوم؟ الأصناف تسأل عنكم`,
  n => `☕ صباح الخير ${n}… جرد أول اليوم قبل، وبعدين الشاهي 😉`,
];
const CLOSE = [
  n => `🌙 جرد آخر أمس ناقص عند: ${n} — الليلة نبغاه قبل ما تقفلون 😉`,
  n => `📋 ${n} — آخر أمس ما انجرد! لا تخلونا نحسبه عليكم 😅`,
];

const restaurantGroup = () => {
  let g = {}; try { g = JSON.parse(getSetting('wa_groups') || '{}'); } catch { /* */ }
  return Object.keys(g).find(k => g[k] === 'restaurant') || null;
};
const once = (date, key) => {
  if (get('SELECT 1 AS x FROM wa_nudges WHERE date = ? AND key = ?', date, key)) return false;
  run('INSERT INTO wa_nudges(date, key) VALUES(?,?)', date, key); return true;
};

// يرجع الرسائل اللي انرسلت. force: «جرّب الحين» (حتى لو المفتاح طافي، وبدون حد المرة الوحدة)
async function nudge(sendGroup, { force = false, sendPrivate = null } = {}) {
  if (!force && getSetting('wa_nudge', '1') === '0') return [];
  const jid = restaurantGroup(); if (!jid) return [];
  const today = C.businessDate(), yday = C.addDays(today, -1), out = [];
  const send = async (date, key, text) => { if (text && (force || once(date, key))) { await sendGroup(jid, text); out.push(text); } };

  // اليوم: أول اليوم (بعد الموعد — نفس منطق التنبيهات)
  if (C.alerts(today).some(a => a.type === 'opening_missing')) {
    const who = names(C.dailyBoard(today).rows.filter(r => r.opening == null && !r.no_opening).map(r => r.opening_user));
    if (who.length) await send(today, 'opening', pick(OPEN)(who.join('، ')));
  }
  // أمس: آخر اليوم + النقص
  const yb = C.dailyBoard(yday);
  if (yb.rows.some(r => r.opening != null || r.closing != null)) { // أمس كان يوم شغل
    const who = names(yb.rows.filter(r => r.closing == null).map(r => r.closing_user));
    if (who.length) await send(today, 'closing:' + yday, pick(CLOSE)(who.join('، ')));
    const short = yb.rows.filter(r => r.diff != null && r.diff > 0.0001).sort((a, b) => (b.diff_value || 0) - (a.diff_value || 0)).slice(0, 8);
    if (short.length) await send(today, 'shortage:' + yday, `🔎 نقص أمس:\n${short.map(r => `• ${r.name}: ${C.r3(r.diff)} ${r.unit} — ${r.closing_user}`).join('\n')}\n\nاللي عنده تفسير يكلم المشرف 🙏`);
    // المالك والمشرفين (صلاحية المبيعات): نفس النقص بالمبلغ — في الخاص
    const allShort = yb.rows.filter(r => r.diff != null && r.diff > 0.0001).sort((a, b) => (b.diff_value || 0) - (a.diff_value || 0));
    if (allShort.length && sendPrivate && (force || once(today, 'shortage_money:' + yday))) {
      const total = allShort.reduce((t, r) => t + (r.diff_value || 0), 0);
      const text = `🔎 نقص ${yday} (بالمبلغ — لك بس):\n${allShort.slice(0, 15).map(r => `• ${r.name}: ${C.r3(r.diff)} ${r.unit}${r.diff_value ? ` = ${C.r2(r.diff_value)} ريال` : ''} — ${r.closing_user}`).join('\n')}${total ? `\n\nالمجموع: ${C.r2(total)} ريال` : ''}`;
      for (const m of all("SELECT phone FROM users WHERE active = 1 AND bot = 0 AND phone != '' AND (role = 'owner' OR (role = 'supervisor' AND no_sales = 0))")) {
        try { await sendPrivate(m.phone, text); out.push(text); } catch (e) { console.error('nudge private', e.message); }
      }
    }
  }
  return out;
}

module.exports = { nudge, restaurantGroup };
