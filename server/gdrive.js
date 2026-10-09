'use strict';
// نسخة احتياطية على قوقل درايف: قاعدة البيانات كل يوم (آخر 30)، والصور أول بأول، وتقرير المحاسب أول كل شهر
// الربط مرة وحدة: المالك يحط «Client ID» و«Client Secret» من Google Cloud ويضغط «اربط» — والصلاحية drive.file بس
// (النظام يشوف بس الملفات اللي سواها هو — ما يشوف باقي ملفات الدرايف)
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');
const { db, all, get, run, getSetting, setSetting, DATA_DIR, UPLOAD_DIR } = require('./db');
const C = require('./calc');

const OAUTH = () => process.env.GOOGLE_OAUTH_BASE || 'https://oauth2.googleapis.com';
const AUTH = () => process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const DRIVE = () => process.env.GOOGLE_DRIVE_BASE || 'https://www.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const KEEP = 30;
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'alsalam.db');

db.exec('CREATE TABLE IF NOT EXISTS gdrive_files (path TEXT PRIMARY KEY, file_id TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime(\'now\')))');

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const configured = () => !!(getSetting('gdrive_client_id') && getSetting('gdrive_client_secret'));
const connected = () => configured() && !!getSetting('gdrive_refresh_token');

function status() {
  const f = getSetting('gdrive_folder_id');
  return { configured: configured(), connected: connected(), client_id: getSetting('gdrive_client_id'),
    last_backup: getSetting('gdrive_last_backup') || null, last_error: getSetting('gdrive_last_error') || '',
    last_report: getSetting('gdrive_report_month') || '', folder_url: f ? `https://drive.google.com/drive/folders/${f}` : '',
    images: get('SELECT COUNT(*) AS n FROM gdrive_files').n };
}

function authUrl(redirect) {
  if (!configured()) throw err('حط Client ID و Client Secret أول');
  if (!/^https?:\/\/[^/]+\/api\/gdrive\/callback$/.test(redirect || '')) throw err('رابط الرجوع غير صحيح');
  const state = crypto.randomBytes(16).toString('hex');
  setSetting('gdrive_state', state); setSetting('gdrive_redirect', redirect);
  const q = new URLSearchParams({ client_id: getSetting('gdrive_client_id'), redirect_uri: redirect, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  return `${AUTH()}?${q}`;
}

async function tokenCall(params) {
  const res = await fetch(`${OAUTH()}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: getSetting('gdrive_client_id'), client_secret: getSetting('gdrive_client_secret'), ...params }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw err(j.error === 'invalid_grant' ? 'انتهى ربط قوقل درايف — اضغط «اربط» من جديد' : `قوقل رفض: ${j.error_description || j.error || res.status}`);
  return j;
}

async function callback(code, state) {
  if (!state || state !== getSetting('gdrive_state')) throw err('الرابط قديم — اضغط «اربط» من جديد');
  const j = await tokenCall({ code, grant_type: 'authorization_code', redirect_uri: getSetting('gdrive_redirect') });
  if (!j.refresh_token) throw err('قوقل ما أعطى صلاحية دائمة — اضغط «اربط» مرة ثانية');
  setSetting('gdrive_refresh_token', j.refresh_token); setSetting('gdrive_state', '');
  setSetting('gdrive_last_error', '');
  access = { token: j.access_token, until: Date.now() + (j.expires_in || 3600) * 1000 - 60000 };
}

let access = null;
async function token() {
  if (access && access.until > Date.now()) return access.token;
  const j = await tokenCall({ refresh_token: getSetting('gdrive_refresh_token'), grant_type: 'refresh_token' });
  access = { token: j.access_token, until: Date.now() + (j.expires_in || 3600) * 1000 - 60000 };
  return access.token;
}

async function api(method, p, { query, json, body, headers = {}, raw } = {}) {
  const url = `${DRIVE()}${p}${query ? '?' + new URLSearchParams(query) : ''}`;
  const res = await fetch(url, { method, headers: { authorization: 'Bearer ' + await token(), ...(json ? { 'content-type': 'application/json; charset=UTF-8' } : {}), ...headers },
    body: json ? JSON.stringify(json) : body });
  if (raw) return res;
  const j = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw err(`قوقل درايف: ${(j.error && j.error.message) || res.status}`);
  return j;
}

async function folder(key, name, parent) {
  const id = getSetting(key);
  if (id) {
    const res = await api('GET', `/drive/v3/files/${id}`, { query: { fields: 'id,trashed' }, raw: true });
    if (res.ok) { const j = await res.json(); if (!j.trashed) return id; }
  }
  const f = await api('POST', '/drive/v3/files', { query: { fields: 'id' }, json: { name, mimeType: 'application/vnd.google-apps.folder', ...(parent ? { parents: [parent] } : {}) } });
  setSetting(key, f.id);
  return f.id;
}

// رفع على دفعة وحدة (resumable) — يشتغل لأي حجم
async function upload(name, mime, buf, parent) {
  const start = await api('POST', '/upload/drive/v3/files', { query: { uploadType: 'resumable', fields: 'id' }, json: { name, parents: [parent] },
    headers: { 'x-upload-content-type': mime, 'x-upload-content-length': String(buf.length) }, raw: true });
  if (!start.ok) throw err(`قوقل درايف: رفع ${name} فشل (${start.status})`);
  const loc = start.headers.get('location');
  const res = await fetch(loc, { method: 'PUT', headers: { 'content-type': mime }, body: buf });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw err(`قوقل درايف: رفع ${name} فشل (${res.status})`);
  return j.id;
}

let running = null;
async function backupNow({ images = 300 } = {}) {
  if (!connected()) throw err('قوقل درايف مو مربوط');
  if (running) return running;
  running = (async () => {
    const out = { db: null, images: 0, deleted: 0, report: null };
    try {
      const root = await folder('gdrive_folder_id', 'نسخ مطعم السلام');
      const dbDir = await folder('gdrive_db_folder', 'قاعدة البيانات', root);
      // ١. قاعدة البيانات (نسخة آمنة وهي شغالة) مضغوطة
      const tmp = path.join(os.tmpdir(), `alsalam-${process.pid}-${Date.now()}.db`);
      try {
        await backup(new DatabaseSync(DB_FILE, { readOnly: true }), tmp);
        const stamp = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 16).replace('T', '-').replace(':', '');
        out.db = `alsalam-${stamp}.db.gz`;
        await upload(out.db, 'application/gzip', zlib.gzipSync(fs.readFileSync(tmp)), dbDir);
      } finally { fs.rmSync(tmp, { force: true }); }
      // آخر 30 نسخة بس
      const list = await api('GET', '/drive/v3/files', { query: { q: `'${dbDir}' in parents and trashed = false`, orderBy: 'createdTime desc', fields: 'files(id,name)', pageSize: '200' } });
      for (const f of (list.files || []).slice(KEEP)) { await api('DELETE', `/drive/v3/files/${f.id}`); out.deleted++; }
      // ٢. الصور (التذاكر والفواتير) — الجديدة بس
      const done = new Set(all('SELECT path FROM gdrive_files').map(r => r.path));
      const todo = fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR).filter(n => !done.has(n) && fs.statSync(path.join(UPLOAD_DIR, n)).isFile()).sort().slice(0, images) : [];
      if (todo.length) {
        const imgDir = await folder('gdrive_img_folder', 'الصور', root);
        for (const n of todo) {
          const mime = n.endsWith('.png') ? 'image/png' : n.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
          const id = await upload(n, mime, fs.readFileSync(path.join(UPLOAD_DIR, n)), imgDir);
          run('INSERT OR REPLACE INTO gdrive_files(path, file_id) VALUES(?,?)', n, id); out.images++;
        }
      }
      // ٣. تقرير المحاسب للشهر اللي فات (مرة وحدة)
      const prev = C.addDays(C.businessDate().slice(0, 7) + '-01', -1).slice(0, 7);
      if ((getSetting('gdrive_report_month') || '') < prev) { out.report = await uploadReport(prev, root); }
      setSetting('gdrive_last_backup', new Date().toISOString()); setSetting('gdrive_last_error', '');
      return out;
    } catch (e) {
      setSetting('gdrive_last_error', `${new Date().toISOString().slice(0, 16).replace('T', ' ')} — ${e.message}`);
      throw e;
    } finally { running = null; }
  })();
  return running;
}

async function uploadReport(month, root) {
  const { monthlyXlsx } = require('./monthly');
  root = root || await folder('gdrive_folder_id', 'نسخ مطعم السلام');
  const dir = await folder('gdrive_report_folder', 'تقارير المحاسب', root);
  const x = monthlyXlsx(month, getSetting('restaurant_name') || 'مطعم السلام');
  await upload(x.name, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', x.buf, dir);
  if ((getSetting('gdrive_report_month') || '') < month && month < C.businessDate().slice(0, 7)) setSetting('gdrive_report_month', month);
  return x.name;
}

function disconnect() {
  const t = getSetting('gdrive_refresh_token');
  if (t) fetch(`${OAUTH()}/revoke?token=${encodeURIComponent(t)}`, { method: 'POST' }).catch(() => {});
  setSetting('gdrive_refresh_token', ''); access = null;
}

// كل نص ساعة: إذا مر يوم من آخر نسخة، ونحن بعد 4 الفجر (أو مر يوم ونص) — ينسخ
function startScheduler() {
  const tick = () => {
    if (!connected()) return;
    const last = Date.parse(getSetting('gdrive_last_backup') || 0) || 0, age = Date.now() - last;
    const h = C.riyadhHour();
    if ((age > 20 * 3600e3 && h >= 4 && h < 10) || age > 30 * 3600e3) backupNow().then(r => console.log('gdrive backup', r)).catch(e => console.error('gdrive backup', e.message));
  };
  setTimeout(tick, 60000);
  setInterval(tick, 30 * 60000);
}

module.exports = { status, authUrl, callback, backupNow, uploadReport, disconnect, startScheduler, configured, connected };
