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

// 🔁 الملاحقة في الخاص: اللي ما دخّل جرده (أول اليوم بعد الموعد، وآخر اليوم بالليل) — كل ساعة بأصنافه بالاسم، والنبرة تشد
// بعد ٣ مرات: اسمه في القروب + (بعد فترة التعليم wa_chase_record=1) تنسجل مشكلة «الجرد» => تذكير/تنبيه/قرصة. قبلها توصل لنوح بس
const CHASE = [
  (n, list) => `السلام عليكم يا ${n} 🌹\nجردك ناقص: ${list}\nدخّله الله يعافيك 🙏`,
  (n, list) => `يا ${n}، للحين ما دخّلت: ${list}\nالجرد مهم في وقته — دخّله الحين ⏰`,
  (n, list) => `⚠️ يا ${n}، هذا ثالث تذكير: ${list}\n${'${REC}'}`,
  (n, list) => `⛔ يا ${n}، للحين ما دخّلت جردك: ${list}. الكل دخّل إلا أنت.`,
];
function chaseState(today) {
  let st = {}; try { st = JSON.parse(getSetting('wa_chase_state') || '{}'); } catch { /* */ }
  return st.date === today ? st : { date: today, u: {} };
}
async function chase({ sendPrivate, sendGroup, record = null, force = false, now = new Date() } = {}) {
  if (!force && (getSetting('wa_nudge', '1') === '0' || getSetting('wa_chase', '1') === '0')) return [];
  const { setSetting } = require('./db');
  const today = C.businessDate(now), h = C.riyadhHour(now), out = [];
  const openH = Number(getSetting('opening_deadline_hour', '12')), closeH = Number(getSetting('wa_close_hour', '23')), startH = Number(getSetting('day_start_hour', '4'));
  const every = Math.max(30, Number(getSetting('wa_chase_min', '60')) || 60) * 60e3;
  const night = h >= closeH || h < startH;
  const b = C.dailyBoard(today);
  if (!b.rows.some(r => r.opening != null || r.closing != null)) return []; // اليوم مو يوم شغل (مسكّر)
  const miss = new Map(); // user_id => [names]
  const add = (uid, name) => { if (!uid) return; if (!miss.has(uid)) miss.set(uid, []); miss.get(uid).push(name); };
  if (h >= openH || night) for (const r of b.rows) if (r.opening == null && (!r.no_opening || r.prev_missing)) add(r.opening_user_id || (r.prev_missing ? r.closing_user_id : null), r.name);
  if (night) for (const r of b.rows) if (r.closing == null) add(r.closing_user_id, r.name);
  if (!miss.size) return [];
  const st = chaseState(today), rec = getSetting('wa_chase_record', '0') === '1';
  const REC = rec ? 'المرة الجاية تنسجل عليك في الجرد (وتدخل في الخصم) 🤏' : 'لو ما دخّلته بيوصل اسمك لنوح والقروب 🙏';
  const gname = []; const owners = all("SELECT phone FROM users WHERE role = 'owner' AND active = 1 AND bot = 0 AND phone != ''");
  for (const [uid, items] of miss) {
    const u = get('SELECT id, name, phone, role FROM users WHERE id = ? AND active = 1 AND bot = 0', uid);
    if (!u || u.role === 'owner') continue;
    const s = st.u[uid] || { n: 0, at: 0 };
    if (!force && s.at && now.getTime() - s.at < every) continue;
    if (s.n >= 6) continue;
    const list = items.slice(0, 12).join('، ') + (items.length > 12 ? ` (+${items.length - 12})` : '');
    if (u.phone) { try { await sendPrivate(u.phone, CHASE[Math.min(s.n, 3)](u.name, list).replace('${REC}', REC)); out.push({ to: u.phone, n: s.n + 1 }); } catch (e) { console.error('chase', e.message); } }
    s.n++; s.at = now.getTime(); st.u[uid] = s;
    if (s.n === 3) {
      gname.push(u.name);
      if (rec && record) { try { await record(u, items); } catch (e) { console.error('chase record', e.message); } }
      else for (const o of owners) { try { await sendPrivate(o.phone, `📋 ${u.name} ما دخّل جرده بعد ٣ تذكيرات: ${list}`); } catch { /* */ } }
    }
  }
  setSetting('wa_chase_state', JSON.stringify(st));
  const jid = restaurantGroup();
  if (gname.length && jid && sendGroup) { const t = `📋 ${gname.join('، ')} — جردكم ناقص بعد ٣ تذكيرات في الخاص. ننتظركم 👀`; await sendGroup(jid, t); out.push({ to: jid }); }
  return out;
}

module.exports = { nudge, chase, restaurantGroup };
