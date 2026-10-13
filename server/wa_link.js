'use strict';
// 📱 ربط رقم واتساب عادي كـ«جهاز مرتبط» (زي واتساب ويب) — عشان يدخل القروبات الموجودة
// المكتبة: Baileys (مو رسمية). الجلسة في DATA_DIR/wa_auth (برا GitHub). ما يرسل إلا للموظفين المسجلين
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./db');

const AUTH = path.join(DATA_DIR, 'wa_auth');
const st = { status: 'idle', qr: null, me: null, error: '' };
let sock = null, onMessage = () => {}, starting = null, lastSend = 0;
const FAKE = !!process.env.WA_TEST_INJECT, outbox = []; // الاختبارات: الإرسال للقروب ينحفظ هنا بدل واتساب

const pnOf = (...jids) => { // v7: المرسل ممكن يجي LID — ناخذ الرقم (@s.whatsapp.net) من أي واحد
  for (const j of jids) if (j && /@s\.whatsapp\.net$/.test(j)) return j.split('@')[0].split(':')[0];
  return '';
};
const textOf = m => {
  const x = m.message || {};
  const inner = x.ephemeralMessage?.message || x.viewOnceMessage?.message || x;
  return { inner, text: inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption || '' };
};

async function start() {
  if (starting) return starting;
  starting = (async () => {
    const B = await import('@whiskeysockets/baileys');
    const QR = require('qrcode');
    const logger = (await import('pino')).default({ level: 'silent' });
    fs.mkdirSync(AUTH, { recursive: true });
    const { state, saveCreds } = await B.useMultiFileAuthState(AUTH);
    let version; try { version = (await B.fetchLatestBaileysVersion()).version; } catch { /* الافتراضي */ }
    const groupNames = new Map();
    sock = B.default({ auth: state, logger, ...(version ? { version } : {}), browser: B.Browsers.ubuntu('Alsalam'), markOnlineOnConnect: false, syncFullHistory: false });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async u => {
      if (u.qr) { st.status = 'qr'; st.qr = await QR.toDataURL(u.qr, { margin: 1, width: 300 }); }
      if (u.connection === 'open') { st.status = 'open'; st.qr = null; st.error = ''; st.me = pnOf(sock.user?.id?.replace(/:\d+@/, '@')) || sock.user?.id || null; }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        sock = null; starting = null;
        if (code === B.DisconnectReason.loggedOut) { // انفك الربط من الجوال => نمسح الجلسة ونرجع QR
          st.status = 'idle'; st.me = null; st.error = 'انفك الربط من الجوال — اربط من جديد';
          fs.rmSync(AUTH, { recursive: true, force: true });
        } else { st.status = 'closed'; setTimeout(() => start().catch(e => { st.error = e.message; }), 5000); } // انقطع => يعيد لحاله
      }
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        try {
          if (!m.message || m.key.fromMe) continue;
          const chat = m.key.remoteJid || '';
          if (chat === 'status@broadcast') continue;
          const isGroup = chat.endsWith('@g.us');
          const phone = isGroup ? pnOf(m.key.participantAlt, m.key.participant) : pnOf(m.key.remoteJidAlt, chat);
          const { inner, text } = textOf(m);
          let groupName = '';
          if (isGroup) {
            if (!groupNames.has(chat)) { try { groupNames.set(chat, (await sock.groupMetadata(chat)).subject); } catch { groupNames.set(chat, ''); } }
            groupName = groupNames.get(chat);
          }
          const type = inner.imageMessage ? 'image' : (text ? 'text' : 'other');
          await onMessage({
            id: m.key.id, phone, chat, isGroup, groupName, type, text: String(text).trim(),
            image: async () => {
              const buf = await B.downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
              return `data:${inner.imageMessage.mimetype && /png|webp/.test(inner.imageMessage.mimetype) ? inner.imageMessage.mimetype : 'image/jpeg'};base64,${buf.toString('base64')}`;
            },
          });
        } catch (e) { console.error('wa_link msg', e.message); }
      }
    });
  })();
  try { await starting; } catch (e) { starting = null; st.error = e.message; throw e; }
}

async function sendText(phone, text) {
  if (!sock || st.status !== 'open') throw new Error('الواتساب مو مربوط');
  const wait = 1500 - (Date.now() - lastSend); if (wait > 0) await new Promise(r => setTimeout(r, wait)); // مو ورا بعض
  lastSend = Date.now();
  await sock.sendMessage(`${phone}@s.whatsapp.net`, { text: String(text).slice(0, 4000) });
}

// كتابة في القروب (تأكيدات وتنبيهات)
async function sendGroup(jid, text) {
  if (FAKE) { outbox.push({ to: jid, text: String(text) }); return; }
  if (!sock || st.status !== 'open') throw new Error('الواتساب مو مربوط');
  const wait = 1500 - (Date.now() - lastSend); if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastSend = Date.now();
  await sock.sendMessage(jid, { text: String(text).slice(0, 4000) });
}

async function listGroups() {
  if (!sock || st.status !== 'open') return [];
  const g = await sock.groupFetchAllParticipating();
  return Object.values(g).map(x => ({ id: x.id, name: x.subject, size: (x.participants || []).length })).sort((a, b) => a.name.localeCompare(b.name));
}

async function logout() {
  try { if (sock) await sock.logout(); } catch { /* */ }
  sock = null; starting = null;
  fs.rmSync(AUTH, { recursive: true, force: true });
  Object.assign(st, { status: 'idle', qr: null, me: null, error: '' });
}

const hasSession = () => fs.existsSync(path.join(AUTH, 'creds.json'));
const status = () => ({ ...st, session: hasSession() });

module.exports = { start, sendText, sendGroup, outbox, listGroups, logout, status, hasSession, setHandler: fn => { onMessage = fn; } };
