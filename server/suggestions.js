'use strict';
// 💡 اقتراحات العمال (من المساعد): 🟡 تغيير يحتاج موافقة نوح (مسؤول صنف، اسم صنف، تصحيح جرد عامل ثاني/يوم فات)
// و💡 تطوير للنظام (تنجمع وتنعرض كل أسبوع). المالك يوافق بكلمة («موافق 3») وتتنفذ باسمه.
const { all, get, run } = require('./db');

const KIND = { learn: '📘 معلومة للدليل', item_responsible: 'مسؤول صنف', rename_item: 'اسم صنف', count_fix: 'تصحيح جرد', feature: '💡 تطوير للنظام', other: 'اقتراح' };

function add(u, { kind, summary, action }) {
  const id = Number(run("INSERT INTO suggestions(at, user_id, kind, summary, action, status) VALUES(datetime('now'),?,?,?,?,'pending')",
    u.id, KIND[kind] ? kind : 'other', String(summary || '').slice(0, 600), action ? JSON.stringify(action) : '').lastInsertRowid);
  return id;
}
const ownerText = (s, by) => `💡 اقتراح #${s.id} من ${by}${s.kind === 'feature' ? ' (تطوير للنظام)' : ''}:\n«${s.summary}»\n\n${s.kind === 'learn' ? `رد *موافق ${s.id}* وتنضاف للدليل، أو *ارفض ${s.id}*.` : s.action ? `رد *موافق ${s.id}* وينفذ، أو *ارفض ${s.id}*.` : `رد *موافق ${s.id}* (تنحفظ للتطوير) أو *ارفض ${s.id}*.`}`;

// قرار المالك: موافق => ينفذ (لو له تنفيذ) باسم المالك
async function decide(id, approve, owner, runAs) {
  const s = get('SELECT * FROM suggestions WHERE id = ?', Number(id));
  if (!s) throw Object.assign(new Error(`ما فيه اقتراح #${id}`), { status: 404 });
  if (s.status !== 'pending') return { ...s, already: true };
  if (!approve) { run("UPDATE suggestions SET status = 'rejected', decided_at = datetime('now') WHERE id = ?", s.id); return { ...s, status: 'rejected' }; }
  let status = 'approved', result = '';
  if (s.action) {
    try {
      const a = JSON.parse(s.action);
      if (a.learn) require('./kb').add({ ...a.learn, by: s.user_id, source: a.learn.source || 'worker' });
      for (const r of a.requests || []) await runAs(owner, r.endpoint, r.body);
      status = 'done';
    } catch (e) { status = 'failed'; result = e.message; }
  }
  run("UPDATE suggestions SET status = ?, result = ?, decided_at = datetime('now') WHERE id = ?", status, result, s.id);
  return { ...s, status, result };
}
const list = (status) => all(`SELECT s.*, u.name AS by_name FROM suggestions s LEFT JOIN users u ON u.id = s.user_id ${status ? 'WHERE s.status = ?' : ''} ORDER BY s.id DESC LIMIT 200`, ...(status ? [status] : []));

module.exports = { add, decide, list, ownerText, KIND };
