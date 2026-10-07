'use strict';
// السحب من لويفرس: الأصناف + الإيصالات المكتملة. يشتغل لحاله كل ١٠ دقايق.
const { all, get, run, tx, getSetting, setSetting } = require('./db');
const { businessDate, addDays, rebuildSaleUse, r2, r3 } = require('./calc');
const { normalize, similarity } = require('./match');

const BASE = process.env.LOYVERSE_BASE || 'https://api.loyverse.com/v1.0';

async function api(path, params = {}) {
  const token = getSetting('loyverse_token');
  if (!token) throw new Error('رمز لويفرس غير موجود');
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
      if (res.status === 429 || res.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
      if (res.status === 401) throw new Error('رمز لويفرس غير صحيح (401)');
      if (!res.ok) throw new Error(`لويفرس رد بخطأ ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } catch (e) {
      if (attempt === 3 || /401|رمز/.test(e.message)) throw e;
      await sleep(2000 * (attempt + 1));
    } finally { clearTimeout(timer); }
  }
  throw new Error('تعذر الاتصال بلويفرس');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function paged(path, key, params = {}) {
  const out = [];
  let cursor;
  for (let i = 0; i < 400; i++) {
    const data = await api(path, { ...params, limit: 250, cursor });
    out.push(...(data[key] || []));
    cursor = data.cursor;
    if (!cursor) break;
  }
  return out;
}

// ===== الأصناف =====
async function syncItems() {
  const [items, categories] = await Promise.all([paged('/items', 'items', { show_deleted: 'true' }), paged('/categories', 'categories').catch(() => [])]);
  const catName = new Map(categories.map(c => [c.id, c.name]));
  let added = 0;
  const seen = new Set();
  tx(() => {
    for (const it of items) {
      const deleted = !!it.deleted_at;
      for (const v of (it.variants || [])) {
        const variant = [v.option1_value, v.option2_value, v.option3_value].filter(Boolean).join(' / ');
        const price = v.default_price ?? (v.stores && v.stores[0] && v.stores[0].price) ?? 0;
        const ex = get('SELECT id FROM products WHERE loyverse_variant_id = ?', v.variant_id);
        if (ex) {
          run('UPDATE products SET loyverse_item_id=?, name=?, variant=?, category=?, price=?, sku=?, active=?, demo=0 WHERE id=?',
            it.id, it.item_name, variant, catName.get(it.category_id) || '', price || 0, v.sku || '', deleted || v.deleted_at ? 0 : 1, ex.id);
        } else {
          run('INSERT INTO products(loyverse_item_id, loyverse_variant_id, name, variant, category, price, sku, active) VALUES(?,?,?,?,?,?,?,?)',
            it.id, v.variant_id, it.item_name, variant, catName.get(it.category_id) || '', price || 0, v.sku || '', deleted || v.deleted_at ? 0 : 1);
          added++;
        }
        seen.add(v.variant_id);
      }
    }
    // التجريبي واللي مو موجود في لويفرس ينمسح (أو يتعطل لو عليه مبيعات)
    run('DELETE FROM products WHERE demo = 1');
    for (const p of all('SELECT id, loyverse_variant_id FROM products')) {
      if (p.loyverse_variant_id && seen.has(p.loyverse_variant_id)) continue;
      if (get('SELECT 1 AS x FROM sales WHERE product_id = ? LIMIT 1', p.id)) run('UPDATE products SET active = 0 WHERE id = ?', p.id);
      else run('DELETE FROM products WHERE id = ?', p.id);
    }
  });
  const drafted = draftRecipes();
  return { products: seen.size, added, drafted };
}

// وصفات مبدئية: يربط صنف البيع بصنف المخزون الأقرب اسمًا (تعدلها بعدين)
const HINTS = [
  { match: ['حنيذ لحم', 'لحم حنيذ'], item: 'لحم', qty: 0.4 },
  { match: ['فته', 'فتة'], item: 'فتة', qty: 1 },
];
function draftRecipes() {
  const items = all('SELECT id, name FROM items WHERE active = 1');
  const byName = new Map(items.map(i => [normalize(i.name), i.id]));
  let n = 0;
  tx(() => {
    for (const p of all("SELECT * FROM products WHERE active = 1 AND id NOT IN (SELECT product_id FROM recipe_lines) AND recipe_status = 'none'")) {
      const full = `${p.name} ${p.variant}`.trim();
      const hint = HINTS.find(h => h.match.some(m => normalize(full).includes(normalize(m))));
      let itemId = hint ? byName.get(normalize(hint.item)) : null, qty = hint ? hint.qty : 1;
      if (!itemId) {
        let best = null;
        for (const i of items) {
          const s = Math.max(similarity(full, i.name), similarity(p.name, i.name));
          if (!best || s > best.s) best = { id: i.id, s };
        }
        if (best && best.s >= 0.8) itemId = best.id;
      }
      if (itemId) {
        run("INSERT INTO recipe_lines(product_id, item_id, qty, source) VALUES(?,?,?,'floor')", p.id, itemId, qty);
        run("UPDATE products SET recipe_status = 'draft' WHERE id = ?", p.id);
        n++;
      }
    }
  });
  return n;
}

// ===== الإيصالات =====
function receiptDate(r) { return businessDate(r.receipt_date || r.created_at); }

async function syncReceipts(fromISO, toISO) {
  const receipts = await paged('/receipts', 'receipts', { created_at_min: fromISO, created_at_max: toISO });
  const dates = new Set();
  tx(() => {
    for (const r of receipts) {
      const date = receiptDate(r);
      const prev = get('SELECT date FROM loyverse_receipts WHERE receipt_number = ?', r.receipt_number);
      if (prev) dates.add(prev.date);
      dates.add(date);
      run(`INSERT INTO loyverse_receipts(receipt_number, date, created_at, receipt_type, cancelled, total, json) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(receipt_number) DO UPDATE SET date=excluded.date, receipt_type=excluded.receipt_type, cancelled=excluded.cancelled, total=excluded.total, json=excluded.json`,
        r.receipt_number, date, r.created_at, r.receipt_type || 'SALE', r.cancelled_at ? 1 : 0, r.total_money || 0, JSON.stringify(r));
    }
  });
  for (const d of dates) rebuildLoyverseSales(d);
  return { receipts: receipts.length, dates: [...dates].sort() };
}

// يبني مبيعات لويفرس المجمّعة لليوم من الإيصالات المحفوظة
function rebuildLoyverseSales(date) {
  const productByVariant = new Map(all('SELECT id, loyverse_variant_id FROM products').map(p => [p.loyverse_variant_id, p.id]));
  const productByItem = new Map(all('SELECT id, loyverse_item_id FROM products').map(p => [p.loyverse_item_id, p.id]));
  const agg = new Map(), pay = new Map();
  for (const row of all('SELECT json, receipt_type FROM loyverse_receipts WHERE date = ? AND cancelled = 0', date)) {
    const r = JSON.parse(row.json);
    const sign = row.receipt_type === 'REFUND' ? -1 : 1;
    for (const li of (r.line_items || [])) {
      let pid = productByVariant.get(li.variant_id) || productByItem.get(li.item_id);
      if (!pid) {
        // صنف جديد ما انسحب بعد: نضيفه عشان ما تضيع المبيعات
        pid = Number(run('INSERT INTO products(loyverse_item_id, loyverse_variant_id, name, variant, price) VALUES(?,?,?,?,?)',
          li.item_id || null, li.variant_id || null, li.item_name || 'صنف', li.variant_name || '', li.price || 0).lastInsertRowid);
        productByVariant.set(li.variant_id, pid);
      }
      const note = (li.line_note || '').trim();
      const k = pid + '|' + note;
      const a = agg.get(k) || { pid, note, qty: 0, amount: 0, list: 0 };
      a.qty += sign * (li.quantity || 0);
      a.amount += sign * (li.total_money ?? li.gross_total_money ?? 0);
      a.list += sign * (li.quantity || 0) * (li.price || 0);
      agg.set(k, a);
    }
    for (const p of (r.payments || [])) {
      const name = p.name || p.type || 'دفع';
      const x = pay.get(name) || { type: p.type || 'OTHER', amount: 0 };
      x.amount += sign * (p.money_amount || 0);
      pay.set(name, x);
    }
  }
  tx(() => {
    run("DELETE FROM sales WHERE date = ? AND source = 'loyverse'", date);
    for (const a of agg.values()) if (a.qty)
      run("INSERT INTO sales(date, product_id, qty, amount, list_amount, source, note) VALUES(?,?,?,?,?,'loyverse',?)", date, a.pid, r3(a.qty), r2(a.amount), r2(a.list), a.note);
    run('DELETE FROM payments WHERE date = ?', date);
    for (const [name, x] of pay) run('INSERT INTO payments(date, name, type, amount) VALUES(?,?,?,?)', date, name, x.type, r2(x.amount));
  });
  rebuildSaleUse(date);
}

let running = null;
async function syncAll({ full = false } = {}) {
  if (running) return running;
  running = (async () => {
    try {
      if (!getSetting('loyverse_token')) return { skipped: true };
      const itemsRes = await syncItems();
      const last = getSetting('last_receipt_sync');
      const daysBack = Number(getSetting('sync_days_back', '30')) || 30;
      const from = (!full && last) ? new Date(Date.parse(last) - 36 * 3600e3) : new Date(Date.now() - daysBack * 864e5);
      const to = new Date();
      const rec = await syncReceipts(from.toISOString(), to.toISOString());
      setSetting('last_receipt_sync', to.toISOString());
      const msg = `تم: ${itemsRes.products} صنف (${itemsRes.added} جديد، ${itemsRes.drafted} وصفة مبدئية)، ${rec.receipts} إيصال`;
      run('INSERT INTO sync_log(ok, message) VALUES(1, ?)', msg);
      run('DELETE FROM sync_log WHERE id NOT IN (SELECT id FROM sync_log ORDER BY id DESC LIMIT 200)');
      return { ok: true, message: msg, ...rec };
    } catch (e) {
      run('INSERT INTO sync_log(ok, message) VALUES(0, ?)', String(e.message || e));
      return { ok: false, message: String(e.message || e) };
    } finally { running = null; }
  })();
  return running;
}

function startScheduler() {
  const tick = () => syncAll().catch(() => {});
  setTimeout(tick, 5000);
  setInterval(tick, 10 * 60 * 1000);
}

module.exports = { syncAll, syncItems, startScheduler, rebuildLoyverseSales, draftRecipes, addDays };
