'use strict';
// 📣 «يلسعهم»: تنبيهات في «جروب المطعم» — اللي ما دخّل جرده، والنقص — بأسمائهم، مرة وحدة في اليوم لكل تنبيه
// قوالب ثابتة (مو ذكاء اصطناعي): قرصة خفيفة بدون إهانة — وبدون مبالغ في القروب (العمال ما لهم في الفلوس، الكمية بس)
// المبالغ تروح للمالك والمشرفين (صلاحية المبيعات) في الخاص
const { all, get, run, getSetting } = require('./db');
const C = require('./calc');

const pick = list => list[Math.floor(Math.random() * list.length)];
const names = arr => [...new Set(arr.filter(x => x && x !== '—'))];
// نقص حقيقي: الصنف اللي ينسحب الصبح للطبخ (دجاج/لحم نيّ) وما له مبيعات مربوطة — اللي انسحب انطبخ، مو نقص
const realShort = r => r.diff != null && r.diff > 0.0001 && !(r.pull_on_open && !(r.theoretical > 0));

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
    const short = yb.rows.filter(realShort).sort((a, b) => (b.diff_value || 0) - (a.diff_value || 0)).slice(0, 8);
    if (short.length) await send(today, 'shortage:' + yday, `🔎 نقص أمس:\n${short.map(r => `• ${r.name}: ${C.r3(r.diff)} ${r.unit} — ${r.closing_user}`).join('\n')}\n\nاللي عنده تفسير يكلم المشرف 🙏`);
    // المالك والمشرفين (صلاحية المبيعات): نفس النقص بالمبلغ — في الخاص
    const allShort = yb.rows.filter(realShort).sort((a, b) => (b.diff_value || 0) - (a.diff_value || 0));
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

// 🔁 الملاحقة في الخاص: اللي ما دخّل جرده — كل ساعة بأصنافه بالاسم، والنبرة تشد
// أول اليوم: من الساعة ١٠ (wa_chase_open_hour) والموعد ١٢. آخر اليوم: من ١١ الليل (wa_close_hour). بعدها بساعة: ملخص الباقي لنوح (+ wa_chase_notify مثل خلوف)
// بعد ٣ مرات: اسمه في القروب + (بعد فترة التعليم wa_chase_record=1) تنسجل مشكلة «الجرد» => تذكير/تنبيه/قرصة. قبلها توصل لنوح بس
const DEV = 'عندنا أشياء لسه نبغى نربطها في النظام، ولازم تكونون معنا وتخلّصون شغلكم على أكمل وجه 💪';
// 🔀 كل تذكير له أكثر من صيغة — وما تتكرر نفس الصيغة لنفس الموظف مرتين ورا بعض
const PRE = [[ // أول تذكير الصبح
  (n, list) => `صباح الخير يا ${n} 🌹\nأول شي تسويه لما توصل: الجرد 📋\nباقي عليك: ${list}\nأول بأول الله يعافيك 🙏`,
  (n, list) => `صباح النور يا ${n} ☀️\nقبل ما تبدأ شغلك: جرد ${list} 📋\nالله يعطيك العافية`,
  (n, list) => `هلا ${n} 👋\nجرد أول الدوام ينتظرك: ${list}\nرسّله لي هنا وأنا أرتبه لك 🙏`,
  (n, list) => `يا ${n} صباحك خير 🌹\nلا تنسى: ${list}\nدقيقة وتخلص منه 💪`,
], [ // الثاني (قرب آخر وقت)
  (n, list, dl) => `يا ${n}، للحين ما دخّلت: ${list}\nترى آخر وقت الساعة ${dl} ⏰\n${DEV}`,
  (n, list, dl) => `${n} الله يعافيك، باقي ${list}\nقبل الساعة ${dl} ⏰ عشان ما يتأخر الشغل`,
  (n, list, dl) => `تذكير صغير يا ${n} 🙏\n${list} ما انجرد للحين — آخر وقت ${dl} ⏰`,
]];
const CHASE = [[
  (n, list) => `السلام عليكم يا ${n} 🌹\nجردك ناقص: ${list}\nدخّله الله يعافيك 🙏`,
  (n, list) => `يا ${n} 🌹 باقي عليك: ${list}\nأرسله لي هنا متى ما فضيت 🙏`,
  (n, list) => `هلا ${n}، نسيت ${list}؟ 📋\nرسالة وحدة وتخلص 💪`,
], [
  (n, list) => `يا ${n}، للحين ما دخّلت: ${list}\n${DEV}\nدخّله الحين ⏰`,
  (n, list) => `${n} الله يعافيك، ${list} للحين ناقص ⏰\n${DEV}`,
  (n, list) => `يا ${n}، نبغى ${list} الحين لو سمحت 🙏\nالجرد هو اللي يحميك ويحمي المحل`,
], [
  (n, list) => `⚠️ يا ${n}، هذا آخر تذكير: ${list}\n${DEV}\n${'${REC}'}`,
  (n, list) => `⚠️ ${n}، آخر تذكير الليلة: ${list}\n${'${REC}'}`,
]];
const MAX = 3; // بعد الثالث نسكت — الباقي على نوح
// 🚫 الغايب اليوم: ما ينلاحق (wa_absent = {date, ids})
function absentIds(date) {
  try { const a = JSON.parse(getSetting('wa_absent') || '{}'); return a.date === date ? (a.ids || []).map(Number) : []; } catch { return []; }
}
const CLOSE1 = [
  (n, list) => `🌙 يا ${n}، قبل ما تقفل: باقي عليك جرد ${list}\nدخّله الله يعافيك 🙏`,
  (n, list) => `🌙 مساء الخير يا ${n}\nقبل ما تطلع: جرد ${list} 📋\nيعطيك العافية على تعب اليوم`,
  (n, list) => `🌙 ${n}، آخر الدوام: ${list}\nأرسل الباقي من كل واحد وأنا أرتبه لك 🙏`,
  (n, list) => `🌙 يا ${n} الله يعافيك، لا تطلع قبل جرد ${list} 📋`,
];
// صيغة غير اللي انرسلت آخر مرة لنفس الموظف
const vary = (list, last) => { const i = list.length > 1 ? (() => { let k; do { k = Math.floor(Math.random() * list.length); } while (k === last); return k; })() : 0; return [list[i], i]; };
function chaseState(today) {
  let st = {}; try { st = JSON.parse(getSetting('wa_chase_state') || '{}'); } catch { /* */ }
  return st.date === today ? { u: {}, ...st } : { date: today, u: {}, last: st.last || {} }; // الصيغة الأخيرة تقعد لبكرة (ما يبدأ بنفسها)
}
// اللي يوصلهم خبر الناقص: المالك + اللي اختارهم (مثل خلوف)
function chaseNotify() {
  let ids = []; try { ids = JSON.parse(getSetting('wa_chase_notify') || '[]').map(Number).filter(Boolean); } catch { /* */ }
  const owners = all("SELECT id, name, phone FROM users WHERE role = 'owner' AND active = 1 AND bot = 0 AND phone != ''");
  const extra = ids.length ? all(`SELECT id, name, phone FROM users WHERE active = 1 AND bot = 0 AND phone != '' AND id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
  return [...owners, ...extra.filter(x => !owners.some(o => o.id === x.id))];
}
async function chase({ sendPrivate, sendGroup, record = null, zero = null, force = false, now = new Date() } = {}) {
  if (!force && (getSetting('wa_nudge', '1') === '0' || getSetting('wa_chase', '1') === '0')) return [];
  const { setSetting } = require('./db');
  const today = C.businessDate(now), h = C.riyadhHour(now), out = [];
  const num = (k, d) => { const v = Number(getSetting(k, d)); return Number.isFinite(v) ? v : Number(d); };
  const dl = num('opening_deadline_hour', '12'), openH = Math.min(num('wa_chase_open_hour', '10'), dl), closeH = num('wa_close_hour', '23'), startH = num('day_start_hour', '4');
  const every = Math.max(30, num('wa_chase_min', '60') || 60) * 60e3;
  const night = h >= closeH || h < startH;
  const sinceClose = ((h - closeH + 24) % 24) * 60 + new Date(now).getUTCMinutes(); // دقايق من ساعة القفل
  const b = C.dailyBoard(today);
  // يوم شغل: فيه جرد اليوم، أو انجرد آخر أمس (الصبح بدري ما أحد دخّل للحين)
  const yday = (() => { const x = new Date(today + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); })();
  if (!b.rows.some(r => r.opening != null || r.closing != null) && !get('SELECT 1 AS x FROM counts WHERE date = ? AND closing IS NOT NULL LIMIT 1', yday)) return [];
  const miss = { o: new Map(), c: new Map() }; // user_id => [names]
  const add = (m, uid, name) => { if (!uid) return; if (!m.has(uid)) m.set(uid, []); m.get(uid).push(name); };
  if (h >= openH || night) for (const r of b.rows) if (!r.empty && r.opening == null && !r.no_opening) add(miss.o, r.opening_user_id, r.name); // «يبدأ من آخر أمس»: ما له جرد صبح (الناقص من أمس ينلاحق بالليل)
  if (night) for (const r of b.rows) if (!r.empty && r.closing == null) add(miss.c, r.closing_user_id, r.name);
  const st = chaseState(today);
  // 🤔 «انباع وما له وجود»: انباع اليوم وأول اليوم صفر وما وصله شي — مرة وحدة باليوم لكل صنف: المسؤول + نوح
  const sold = b.rows.filter(r => r.sold_no_stock > 0 && !(st.sold || []).includes(r.item_id));
  if (sold.length) {
    st.sold = [...(st.sold || []), ...sold.map(r => r.item_id)];
    const per = new Map();
    for (const r of sold) { const uid = r.closing_user_id || r.opening_user_id; if (uid) { if (!per.has(uid)) per.set(uid, []); per.get(uid).push(`${r.name} (${r.sold_no_stock} ${r.unit})`); } }
    for (const [uid, list] of per) {
      const u = get('SELECT id, name, phone FROM users WHERE id = ? AND active = 1 AND bot = 0', uid);
      if (u && u.phone) { try { await sendPrivate(u.phone, `🤔 يا ${u.name}، انباع اليوم: ${list.join('، ')}\nوما له جرد أول اليوم ولا استلام — دخّل جردك صح، أو قل لنا من وين جا (شراء ما انسجل؟ نقلته من مكان؟)`); out.push({ to: u.phone, kind: 'sold' }); } catch (e) { console.error('chase sold', e.message); } }
    }
    const t = `🤔 انباع وما له وجود في الجرد (لا أول اليوم ولا استلام):\n${sold.map(r => `• ${r.name}: ${r.sold_no_stock} ${r.unit} — ${r.closing_user || r.opening_user || '—'}`).join('\n')}`;
    for (const o of chaseNotify()) { try { await sendPrivate(o.phone, t); out.push({ to: o.phone, kind: 'sold_notify' }); } catch { /* */ } }
  }
  if (!miss.o.size && !miss.c.size) { setSetting('wa_chase_state', JSON.stringify(st)); return out; }
  const rec = getSetting('wa_chase_record', '0') === '1';
  const REC = rec ? 'المرة الجاية تنسجل عليك في الجرد (وتدخل في الخصم) 🤏' : 'لو ما دخّلته بيوصل اسمك لنوح والقروب 🙏';
  const gname = [], notify = chaseNotify(), dlTxt = dl > 12 ? `${dl - 12} الظهر` : `${dl} الظهر`;
  const absent = absentIds(today);
  const listOf = items => items.slice(0, 12).join('، ') + (items.length > 12 ? ` (+${items.length - 12})` : '');
  for (const kind of ['o', 'c']) for (const [uid, items] of miss[kind]) {
    const u = get('SELECT id, name, phone, role FROM users WHERE id = ? AND active = 1 AND bot = 0', uid);
    if (!u || u.role === 'owner') continue;
    const key = uid + ':' + kind, s = st.u[key] || { n: 0, at: 0 };
    if (!force && s.at && new Date(now).getTime() - s.at < every) continue;
    if (absent.includes(uid)) continue;
    // 0️⃣ بعد آخر تذكير بساعة وما جرد: الفاضي ينكتب صفر لحاله — والصفر اللي فيه بيع/المفروض باقي يوصل خبره لنوح والعامل
    if (s.n >= MAX) {
      if (zero && !s.z && getSetting('wa_auto_zero', '1') === '1' && (force || new Date(now).getTime() - s.at >= every) && (kind === 'c' || h >= dl || night)) {
        s.z = 1; st.u[key] = s;
        const ph = kind === 'c' ? 'closing' : 'opening';
        const rows = b.rows.filter(r => (kind === 'c' ? r.closing_user_id : r.opening_user_id) === uid && r[ph] == null && !r.empty && !(kind === 'o' && r.no_opening));
        const done = [];
        for (const r of rows) { try { await zero(r.item_id, ph, today); done.push(r); } catch (e) { console.error('auto zero', e.message); } }
        const after = C.dailyBoard(today).rows;
        const bad = done.map(r => after.find(x => x.item_id === r.item_id) || r).filter(r => (kind === 'c' ? (r.diff || 0) > 0.0001 : false) || r.sold_no_stock > 0); // صفر والمفروض فيه باقي (نقص) أو انباع بدون وجود
        if (bad.length) {
          const line = r => `• ${r.name}${kind === 'c' && r.diff > 0 ? ` (المفروض باقي ${C.r3(r.diff)} ${r.unit})` : ''}${r.sold_no_stock > 0 ? ` (انباع ${r.sold_no_stock} ${r.unit})` : ''}`;
          for (const o of chaseNotify()) if (o.id !== uid) { try { await sendPrivate(o.phone, `⚠️ ${u.name} ما جرد ${kind === 'c' ? 'آخر' : 'أول'} الدوام — انحط صفر لحاله، وهذي فيها باقي/بيع:\n${bad.map(line).join('\n')}`); out.push({ to: o.phone, kind: 'zero_notify' }); } catch { /* */ } }
          if (u.phone) { try { await sendPrivate(u.phone, `⚠️ يا ${u.name}، جردك ما دخل، فانحط *صفر* على: ${bad.map(r => r.name).join('، ')}\nوهذي المفروض فيها باقي أو انباع منها — كلّم المشرف وصحّح جردك 🙏`); out.push({ to: u.phone, kind: 'zero' }); } catch { /* */ } }
        }
      }
      continue;
    }
    // 💬 يكلم المساعد الحين (آخر نص ساعة) — لا نقاطعه بتذكير
    if (!force && get("SELECT 1 AS x FROM wa_log WHERE dir = 'in' AND user_id = ? AND at >= ? LIMIT 1", uid, new Date(new Date(now).getTime() - 30 * 60e3).toISOString().slice(0, 19).replace('T', ' '))) continue;
    const list = listOf(items);
    const set = kind === 'o' && !night && h < dl ? PRE[Math.min(s.n, 1)] : kind === 'c' && s.n === 0 ? CLOSE1 : CHASE[Math.min(s.n, MAX - 1)];
    const [tpl, vi] = vary(set, st.last && st.last[uid]);
    const text = tpl(u.name, list, dlTxt).replace('${REC}', REC);
    st.last = { ...(st.last || {}), [uid]: vi };
    if (u.phone) { try { await sendPrivate(u.phone, text); out.push({ to: u.phone, n: s.n + 1, kind }); } catch (e) { console.error('chase', e.message); } }
    s.n++; s.at = new Date(now).getTime(); st.u[key] = s;
    if (s.n === 3) {
      gname.push(u.name);
      if (rec && record) { try { await record(u, items); } catch (e) { console.error('chase record', e.message); } }
      else for (const o of notify) if (o.id !== u.id) { try { await sendPrivate(o.phone, `📋 ${u.name} ما دخّل جرده بعد ٣ تذكيرات: ${list}`); out.push({ to: o.phone, kind: 'notify' }); } catch { /* */ } }
    }
  }
  // 📋 بعد ساعة القفل بشوي: ملخص اللي باقي لنوح (ومن معه) — مرة وحدة في الليلة
  if (night && !st.owner && sinceClose >= num('wa_owner_remind_after', '60')) {
    const by = new Map();
    for (const kind of ['c', 'o']) for (const [uid, items] of miss[kind]) { const n = ((get('SELECT name FROM users WHERE id = ?', uid) || {}).name || '؟') + (absent.includes(uid) ? ' (غايب)' : ''); by.set(n, [...(by.get(n) || []), ...items]); }
    if (by.size) {
      const t = `📋 باقي جرد الليلة:\n${[...by].map(([n, it]) => `• ${n}: ${listOf(it)}`).join('\n')}\n\nادخل كمّله 🙏`;
      for (const o of notify) { try { await sendPrivate(o.phone, t); out.push({ to: o.phone, kind: 'summary' }); } catch { /* */ } }
      st.owner = 1;
    }
  }
  setSetting('wa_chase_state', JSON.stringify(st));
  const jid = restaurantGroup();
  if (gname.length && jid && sendGroup) { const t = `📋 ${[...new Set(gname)].join('، ')} — جردكم ناقص بعد ٣ تذكيرات في الخاص. ننتظركم 👀`; await sendGroup(jid, t); out.push({ to: jid }); }
  return out;
}

module.exports = { nudge, chase, restaurantGroup, absentIds };
