'use strict';
// قاعدة البيانات (SQLite مدمج في Node) + الجداول + البيانات الأولية للمطعم
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'alsalam.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'worker',          -- owner | supervisor | purchaser | worker
  pin TEXT NOT NULL DEFAULT '0000',
  salary REAL NOT NULL DEFAULT 0,               -- الراتب الشهري
  no_sales INTEGER NOT NULL DEFAULT 0,          -- 1 = المشرف ما يشوف المبيعات والتقارير
  no_recipes INTEGER NOT NULL DEFAULT 0,        -- 1 = المشرف ما يشوف الوصفات
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  opening_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  closing_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

-- من يستلم/يقفل القسم (غير المشرفين العامّين)
CREATE TABLE IF NOT EXISTS section_approvers (
  section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (section_id, user_id)
);

-- أصناف المخزون (اللي أشتريها أو أحضّرها)
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'حبة',
  section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'raw',             -- raw = يُشترى | prepared = يُحضّر من أصناف أخرى
  cost REAL NOT NULL DEFAULT 0,                 -- سعر الشراء للوحدة (متوسط)
  sale_value REAL NOT NULL DEFAULT 0,           -- قيمة البيع المتوقعة للوحدة (لحساب نقص الفلوس)
  carry_over INTEGER NOT NULL DEFAULT 1,        -- 1 يقعد لبكرة | 0 آخر اليوم هالك
  daily INTEGER NOT NULL DEFAULT 1,             -- يدخل الجرد اليومي
  pull_on_open INTEGER NOT NULL DEFAULT 0,      -- أول اليوم يسحبون من الثلاجة ويدخلونه في الجرد (الزيادة تنخصم من المستودع)
  opening_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  closing_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

-- وصفة التحضير للأصناف المحضّرة (تسحب من المستودع)
CREATE TABLE IF NOT EXISTS item_components (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  component_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  qty REAL NOT NULL,
  PRIMARY KEY (item_id, component_id)
);

-- أصناف البيع (من لويفرس فقط)
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  loyverse_item_id TEXT,
  loyverse_variant_id TEXT UNIQUE,
  name TEXT NOT NULL,
  variant TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  sku TEXT NOT NULL DEFAULT '',
  recipe_status TEXT NOT NULL DEFAULT 'none',   -- none | draft | ok
  active INTEGER NOT NULL DEFAULT 1,
  demo INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS product_aliases (
  alias TEXT PRIMARY KEY,                       -- الاسم بعد التطبيع
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recipe_lines (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  qty REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'floor'          -- floor = من المحضّر/المعروض | warehouse = من المستودع
);

-- ملاحظة على صنف تغيّر السحب: "مرسة عسل بس" => يسحب العسل بس
CREATE TABLE IF NOT EXISTS note_rules (
  id INTEGER PRIMARY KEY,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  only_items TEXT NOT NULL DEFAULT '[]'         -- JSON [item_id,...]
);

CREATE TABLE IF NOT EXISTS loyverse_receipts (
  receipt_number TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  receipt_type TEXT NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lr_date ON loyverse_receipts(date);

-- المبيعات المجمّعة لكل يوم (لويفرس + التذكرة)
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  qty REAL NOT NULL,
  amount REAL NOT NULL DEFAULT 0,               -- الفعلي
  list_amount REAL NOT NULL DEFAULT 0,          -- المتوقع بسعر القائمة
  source TEXT NOT NULL,                         -- loyverse | ticket
  note TEXT NOT NULL DEFAULT '',
  only_items TEXT NOT NULL DEFAULT '',
  ref INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date);

CREATE TABLE IF NOT EXISTS payments (
  date TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  PRIMARY KEY (date, name)
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',         -- draft | confirmed
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at TEXT,
  ocr_error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS ticket_images (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_lines (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  raw_name TEXT NOT NULL DEFAULT '',
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  qty REAL NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  customer TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  only_items TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS debt_payments (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  customer TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  paid_cash INTEGER NOT NULL DEFAULT 1           -- 1 دخل الدرج كاش
);

-- الجرد اليومي
CREATE TABLE IF NOT EXISTS counts (
  date TEXT NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  opening REAL, opening_by INTEGER, opening_at TEXT,
  closing REAL, closing_by INTEGER, closing_at TEXT,
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (date, item_id)
);

CREATE TABLE IF NOT EXISTS section_approvals (
  date TEXT NOT NULL,
  section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,                          -- opening | closing
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (date, section_id, phase)
);

-- حركات المخزون: مستودع (warehouse) أو محضّر/معروض (floor)
CREATE TABLE IF NOT EXISTS moves (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  location TEXT NOT NULL,
  qty REAL NOT NULL,
  type TEXT NOT NULL,          -- purchase | transfer | prep_use | sale_use | adjust | convert | waste
  ref TEXT NOT NULL DEFAULT '',
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_moves_date ON moves(date);
CREATE INDEX IF NOT EXISTS idx_moves_item ON moves(item_id, location);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  supplier TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  total REAL NOT NULL DEFAULT 0,
  paid_from_cash INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS purchase_lines (
  id INTEGER PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
  qty REAL NOT NULL,
  unit_price REAL NOT NULL DEFAULT 0,          -- سعر الوحدة الأساسية
  to_floor INTEGER NOT NULL DEFAULT 0,
  pu_name TEXT NOT NULL DEFAULT '',             -- وحدة الشراء كما سجلها (كرتون)
  pu_qty REAL,                                  -- العدد بوحدة الشراء (3)
  pu_price REAL                                 -- سعر وحدة الشراء (40)
);

-- وحدات الشراء: كرتون = 24 علبة، دبة = 28 كجم... (الوصفة والجرد بالوحدة الأساسية للصنف)
CREATE TABLE IF NOT EXISTS item_units (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  factor REAL NOT NULL,                         -- كم وحدة أساسية فيها
  UNIQUE (item_id, name)
);

-- الموردين وحساباتهم (الشراء الآجل)
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS supplier_payments (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  paid_from_cash INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  amount REAL NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  paid_from_cash INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cash_counts (
  date TEXT PRIMARY KEY,
  cash REAL NOT NULL DEFAULT 0,
  card REAL NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- الرواتب والسحبيات: salary (+ مستحق) | advance (- سحب) | settle (- صرف الباقي) | bonus (+) | deduct (-)
CREATE TABLE IF NOT EXISTS payroll (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  month TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS day_status (
  date TEXT PRIMARY KEY,
  closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  closed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  ok INTEGER NOT NULL,
  message TEXT NOT NULL
);
`);

// ===== ترقية قاعدة البيانات الموجودة (بدون ما تنمسح البيانات) =====
function hasColumn(table, col) { return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col); }
if (!hasColumn('purchases', 'payment')) {
  // cash = من الدرج | paid = مدفوع من برا الدرج | credit = آجل على المورد
  db.exec("ALTER TABLE purchases ADD COLUMN payment TEXT NOT NULL DEFAULT 'paid'");
  db.exec("UPDATE purchases SET payment = CASE paid_from_cash WHEN 1 THEN 'cash' ELSE 'paid' END");
}
if (!hasColumn('purchases', 'supplier_id')) {
  db.exec('ALTER TABLE purchases ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL');
  for (const r of db.prepare("SELECT DISTINCT TRIM(supplier) AS n FROM purchases WHERE TRIM(supplier) != ''").all()) {
    db.prepare('INSERT OR IGNORE INTO suppliers(name) VALUES(?)').run(r.n);
    db.prepare('UPDATE purchases SET supplier_id = (SELECT id FROM suppliers WHERE name = ?) WHERE TRIM(supplier) = ?').run(r.n, r.n);
  }
}
// تكلفة إضافية لكل وحدة من المحضّر (غاز، كهرباء…) فوق مكوناته
if (!hasColumn('items', 'extra_cost')) db.exec('ALTER TABLE items ADD COLUMN extra_cost REAL NOT NULL DEFAULT 0');
if (!hasColumn('items', 'pull_on_open')) {
  db.exec('ALTER TABLE items ADD COLUMN pull_on_open INTEGER NOT NULL DEFAULT 0');
  db.exec("UPDATE items SET pull_on_open = 1 WHERE name IN ('دجاج', 'لحم')");
}
if (!hasColumn('users', 'no_sales')) db.exec('ALTER TABLE users ADD COLUMN no_sales INTEGER NOT NULL DEFAULT 0');
if (!hasColumn('users', 'no_recipes')) db.exec('ALTER TABLE users ADD COLUMN no_recipes INTEGER NOT NULL DEFAULT 0');
if (!hasColumn('purchase_lines', 'pu_name')) {
  db.exec("ALTER TABLE purchase_lines ADD COLUMN pu_name TEXT NOT NULL DEFAULT ''");
  db.exec('ALTER TABLE purchase_lines ADD COLUMN pu_qty REAL');
  db.exec('ALTER TABLE purchase_lines ADD COLUMN pu_price REAL');
}
// تذكرة الكاشير المطبوعة: مطابقة المجموع وطريقة ربط كل سطر
if (!hasColumn('tickets', 'check_status')) {
  db.exec("ALTER TABLE tickets ADD COLUMN label TEXT NOT NULL DEFAULT ''");
  db.exec('ALTER TABLE tickets ADD COLUMN paper_total REAL');           // «المبلغ المستحق» المطبوع
  db.exec('ALTER TABLE tickets ADD COLUMN lines_total REAL');           // مجموع الأسطر
  db.exec('ALTER TABLE tickets ADD COLUMN discount REAL NOT NULL DEFAULT 0');
  db.exec("ALTER TABLE tickets ADD COLUMN check_status TEXT NOT NULL DEFAULT ''"); // ok | small_diff | mismatch | no_total | duplicate
  db.exec("ALTER TABLE tickets ADD COLUMN check_note TEXT NOT NULL DEFAULT ''");
}
if (!hasColumn('tickets', 'ocr_cost')) db.exec('ALTER TABLE tickets ADD COLUMN ocr_cost REAL NOT NULL DEFAULT 0'); // دولار تقريبًا
if (!hasColumn('ticket_lines', 'match')) {
  db.exec('ALTER TABLE ticket_lines ADD COLUMN amount REAL');
  db.exec("ALTER TABLE ticket_lines ADD COLUMN match TEXT NOT NULL DEFAULT ''");   // exact | alias | ai | fuzzy | manual | none
  db.exec("ALTER TABLE ticket_lines ADD COLUMN flag TEXT NOT NULL DEFAULT ''");
}
if (!hasColumn('debt_payments', 'paid_cash')) db.exec('ALTER TABLE debt_payments ADD COLUMN paid_cash INTEGER NOT NULL DEFAULT 1');

// ===== مساعدات =====
function all(sql, ...p) { return db.prepare(sql).all(...p); }
function get(sql, ...p) { return db.prepare(sql).get(...p); }
function run(sql, ...p) { return db.prepare(sql).run(...p); }
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
function getSetting(key, def = '') {
  const r = get('SELECT value FROM settings WHERE key = ?', key);
  return r ? r.value : def;
}
function setSetting(key, value) {
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}

// ===== البيانات الأولية (مرة وحدة فقط) =====
function seed() {
  if (get('SELECT COUNT(*) AS n FROM users').n > 0) return;
  tx(() => {
    const U = {};
    const addUser = (name, role) => { U[name] = Number(run('INSERT INTO users(name, role, pin) VALUES(?,?,?)', name, role, role === 'owner' ? '1234' : '0000').lastInsertRowid); };
    addUser('نوح', 'owner');
    addUser('خلوف', 'supervisor');
    addUser('إبراهيم', 'supervisor');
    for (const n of ['محمد عبدالله', 'صادق', 'عبدالله دبوس', 'عبدالله سليمان', 'فؤاد', 'سليمان', 'الدعدع', 'عمار']) addUser(n, 'worker');

    let sort = 0;
    const S = {};
    const addSection = (name, open, close, approvers = []) => {
      const id = Number(run('INSERT INTO sections(name, opening_user_id, closing_user_id, sort) VALUES(?,?,?,?)', name, U[open] || null, U[close] || null, sort++).lastInsertRowid);
      for (const a of approvers) run('INSERT INTO section_approvers(section_id, user_id) VALUES(?,?)', id, U[a]);
      S[name] = id;
    };
    addSection('الأسماك', 'محمد عبدالله', 'محمد عبدالله');
    addSection('الدراك', 'صادق', 'صادق');
    addSection('اللحم والدجاج', 'عبدالله دبوس', 'عبدالله دبوس');
    addSection('المشروبات', 'عبدالله سليمان', 'عبدالله سليمان');
    addSection('السلطات (الثلاجات)', 'فؤاد', 'سليمان');
    addSection('الخضار البلدية', 'خلوف', 'سليمان');
    addSection('الفتات والسمن والعسل', 'فؤاد', 'الدعدع', ['عمار']);
    addSection('عسل السلام والسمن الممتاز', 'عمار', 'عمار', ['عمار']);
    addSection('المستودع (مواد خام)', null, null);

    const addItem = (name, unit, section, opts = {}) => {
      const r = run(`INSERT INTO items(name, unit, section_id, kind, carry_over, daily, pull_on_open, note, sort) VALUES(?,?,?,?,?,?,?,?,?)`,
        name, unit, S[section], opts.kind || 'raw', opts.carry ?? 1, opts.daily ?? 1, opts.pull ? 1 : 0, opts.note || '', sort++);
      return Number(r.lastInsertRowid);
    };
    // الأسماك كلها بالوزن، إلا أبو عصاية بالحبة. نص ورا (مستودع/ثلاجة) ونص قدام.
    addItem('سمك الباغة', 'كجم', 'الأسماك', { note: 'بالوزن' });
    addItem('سمك أبو عصاية', 'حبة', 'الأسماك', { note: 'بالحبة — مو الباغة' });
    addItem('دراك', 'كجم', 'الدراك', { note: 'يُعرض كامل، والزايد ورا' });
    const lahm = addItem('لحم', 'كجم', 'اللحم والدجاج', { note: 'ذبيحة', pull: 1 });
    addItem('صهوم', 'حبة', 'اللحم والدجاج', { kind: 'prepared', note: 'السهم 200–230 جرام' });
    addItem('برم', 'كجم', 'اللحم والدجاج', { kind: 'prepared' });
    addItem('حنيذ لحم', 'كجم', 'اللحم والدجاج', { kind: 'prepared' });
    addItem('مكشن لحم', 'كجم', 'اللحم والدجاج', { kind: 'prepared' });
    addItem('دجاج', 'حبة', 'اللحم والدجاج', { pull: 1 });
    for (const n of ['حنيذ دجاج', 'مضغوط دجاج', 'مقلقل دجاج', 'مرق دجاج']) addItem(n, 'حبة', 'اللحم والدجاج', { kind: 'prepared' });
    for (const n of ['بيبسي', 'ميرندا', 'سفن', 'بيبسي دايت', 'سفن دايت', 'حمضيات']) addItem(n, 'علبة', 'المشروبات', n === 'حمضيات' ? { note: 'مردّى بالليمون' } : {});
    addItem('موية ريال', 'حبة', 'المشروبات');
    addItem('موية ريال ونص', 'حبة', 'المشروبات');
    // السلطات تنسوي في المحل (محضّرة)، والخبز (لحوح، كدر، كبان) ينشرى من برا
    for (const n of ['شطة فلافل كبير', 'شطة فلافل وسط', 'شطة فلافل صغير', 'حلبة', 'طحينة', 'سحاوق جبن'])
      addItem(n, 'حبة', 'السلطات (الثلاجات)', { kind: 'prepared' });
    for (const n of ['لحوح', 'كدر', 'كبان']) addItem(n, 'حبة', 'السلطات (الثلاجات)', { carry: 0 });
    for (const n of ['قوار', 'دبة', 'موز', 'فجل', 'غلف']) addItem(n, 'حبة', 'الخضار البلدية');
    addItem('فتة', 'صحن', 'الفتات والسمن والعسل', { kind: 'prepared', carry: 0 });
    addItem('سمن', 'كجم', 'الفتات والسمن والعسل');
    addItem('عسل (قرورة الفتة)', 'كجم', 'الفتات والسمن والعسل', { note: 'قرورة ~1 كجم من الدبة. الدعدع يدخل الوزن، ويقفل عمار/إبراهيم/خلوف' });
    addItem('عسل السلام', 'كجم', 'عسل السلام والسمن الممتاز', { note: 'سعر خاص' });
    addItem('السمن الممتاز', 'كجم', 'عسل السلام والسمن الممتاز', { note: 'سعر خاص' });
    const daqiq = addItem('دقيق', 'كجم', 'المستودع (مواد خام)', { daily: 0 });
    const zait = addItem('زيت', 'لتر', 'المستودع (مواد خام)', { daily: 0 });
    const milh = addItem('ملح', 'كجم', 'المستودع (مواد خام)', { daily: 0 });
    addItem('عسل (دبة)', 'كجم', 'المستودع (مواد خام)', { daily: 0, note: 'الدبة 28 كجم' });
    addItem('كمون', 'كجم', 'المستودع (مواد خام)', { daily: 0 });
    addItem('فلفل أسود', 'كجم', 'المستودع (مواد خام)', { daily: 0 });

    // وصفات تحضير مبدئية (عدّلها من صفحة الأصناف)
    const fatta = get("SELECT id FROM items WHERE name = 'فتة'").id;
    run('INSERT INTO item_components VALUES(?,?,?)', fatta, daqiq, 0.25);
    run('INSERT INTO item_components VALUES(?,?,?)', fatta, zait, 0.03);
    run('INSERT INTO item_components VALUES(?,?,?)', fatta, milh, 0.005);
    const hl = get("SELECT id FROM items WHERE name = 'حنيذ لحم'").id;
    run('INSERT INTO item_components VALUES(?,?,?)', hl, lahm, 1);

    setSetting('day_start_hour', '4');
    setSetting('sync_days_back', '30');
    setSetting('opening_deadline_hour', '12');
    setSetting('closing_deadline_hour', '2');
  });
}
seed();

// المالك اسمه نوح (مرة وحدة: نغيّر اسم «المالك» القديم)
if (!getSetting('renamed_owner')) {
  if (!get("SELECT 1 AS x FROM users WHERE name = 'نوح'")) run("UPDATE users SET name = 'نوح' WHERE name = 'المالك' AND role = 'owner'");
  setSetting('renamed_owner', '1');
}

// خلوف: مشرف، بس ما يشوف الوصفات ولا تقارير المبيعات (مرة وحدة، والمالك يغيّرها من صفحة الموظفين)
if (!getSetting('restricted_khalouf')) {
  run("UPDATE users SET no_sales = 1, no_recipes = 1 WHERE name = 'خلوف'");
  setSetting('restricted_khalouf', '1');
}

// وحدات الشراء المعروفة: السمن كرتون 25 كجم، العسل دبة 28 كجم (مرة وحدة)
if (!getSetting('seeded_units')) {
  for (const [item, unit, factor] of [['سمن', 'كرتون', 25], ['عسل (دبة)', 'دبة', 28]]) {
    const it = get('SELECT id FROM items WHERE name = ?', item);
    if (it) run('INSERT OR IGNORE INTO item_units(item_id, name, factor) VALUES(?,?,?)', it.id, unit, factor);
  }
  run("UPDATE items SET note = 'الدبة 28 كجم' WHERE name = 'عسل (دبة)' AND note = 'الدبة ~7 كجم'");
  setSetting('seeded_units', '1');
}

// ترتيب السلطات (مرة وحدة): تنسوي في المحل، الخبز ينشرى، والحمص ما عندنا
if (!getSetting('fixed_salads')) {
  const sec = get("SELECT id FROM sections WHERE name = 'السلطات (الثلاجات)'");
  run("UPDATE items SET kind = 'prepared' WHERE name IN ('حلبة', 'شطة فلافل كبير', 'شطة فلافل وسط', 'شطة فلافل صغير', 'سحاوق جبن', 'طحينة')");
  const hummus = get("SELECT id FROM items WHERE name = 'حمص'");
  if (hummus) {
    const used = get('SELECT 1 AS x FROM moves WHERE item_id = ? UNION SELECT 1 FROM counts WHERE item_id = ? LIMIT 1', hummus.id, hummus.id);
    run('DELETE FROM recipe_lines WHERE item_id = ?', hummus.id);
    if (used) run('UPDATE items SET active = 0 WHERE id = ?', hummus.id); else run('DELETE FROM items WHERE id = ?', hummus.id);
  }
  const lahouh = get("SELECT * FROM items WHERE name = 'لحوح'");
  for (const n of ['كدر', 'كبان']) if (!get('SELECT 1 AS x FROM items WHERE name = ?', n)) {
    run(`INSERT INTO items(name, unit, section_id, kind, carry_over, daily, opening_user_id, closing_user_id, sort)
      VALUES(?, 'حبة', ?, 'raw', ?, 1, ?, ?, ?)`, n, lahouh ? lahouh.section_id : (sec && sec.id), lahouh ? lahouh.carry_over : 0,
      lahouh ? lahouh.opening_user_id : null, lahouh ? lahouh.closing_user_id : null, lahouh ? lahouh.sort : 0);
  }
  setSetting('fixed_salads', '1');
}

// زكريا: المسؤول الرئيسي عن المشتريات (ينضاف مرة وحدة، ولو انحذف بعدين ما يرجع)
if (!getSetting('added_zakaria')) {
  if (!get("SELECT 1 AS x FROM users WHERE name = 'زكريا'")) run("INSERT INTO users(name, role, pin) VALUES('زكريا', 'purchaser', '0000')");
  setSetting('added_zakaria', '1');
}

// الفتة: ثلاث أنواع (أبيض، أحمر، دخن) — تتجهّز أول اليوم وتدخل الجرد، ومكوناتها تنخصم من المستودع.
// تنباع لحالها وتدخل في المرسة. (مرة وحدة — وبعدها تتعدّل من «أصناف المخزون»)
if (!getSetting('seeded_fatta')) {
  tx(() => {
    const id = n => (get('SELECT id FROM items WHERE name = ? AND active = 1', n) || {}).id;
    const wh = (get("SELECT id FROM sections WHERE name LIKE 'المستودع%' ORDER BY id LIMIT 1") || {}).id || null;
    const sec = (get("SELECT id FROM sections WHERE name LIKE 'الفتات%' ORDER BY id LIMIT 1") || {}).id || null;
    const sortNext = () => (get('SELECT MAX(sort) AS m FROM items').m || 0) + 1;
    // الدقيق لكل نوع (الأبيض = الدقيق الموجود)
    const flour = { 'أبيض': id('دقيق') };
    for (const [k, n] of [['أحمر', 'دقيق أحمر'], ['دخن', 'دقيق دخن']])
      flour[k] = id(n) || Number(run("INSERT INTO items(name, unit, section_id, kind, daily, carry_over, sort) VALUES(?, 'كجم', ?, 'raw', 0, 1, ?)", n, wh, sortNext()).lastInsertRowid);
    // «فتة» القديمة تصير «فتة أبيض» (عشان ما تضيع حركاتها)
    if (id('فتة') && !id('فتة أبيض')) run("UPDATE items SET name = 'فتة أبيض' WHERE id = ?", id('فتة'));
    const zait = id('زيت'), milh = id('ملح');
    for (const k of ['أبيض', 'أحمر', 'دخن']) {
      const name = 'فتة ' + k;
      let it = id(name);
      if (!it) it = Number(run("INSERT INTO items(name, unit, section_id, kind, daily, carry_over, sort) VALUES(?, 'حبة', ?, 'prepared', 1, 1, ?)", name, sec, sortNext()).lastInsertRowid);
      run("UPDATE items SET kind = 'prepared', unit = 'حبة', daily = 1, carry_over = 1, pull_on_open = 1, section_id = COALESCE(?, section_id) WHERE id = ?", sec, it);
      // المكونات لكل حبة (مبدئية — عدّلها): دقيق النوع + زيت + ملح
      if (!get('SELECT 1 AS x FROM item_components WHERE item_id = ?', it)) {
        if (flour[k]) run('INSERT INTO item_components VALUES(?,?,?)', it, flour[k], 0.25);
        if (zait) run('INSERT INTO item_components VALUES(?,?,?)', it, zait, 0.03);
        if (milh) run('INSERT INTO item_components VALUES(?,?,?)', it, milh, 0.005);
      }
    }
  });
  setSetting('seeded_fatta', '1');
}

// مستخدم «Claude (المساعد)»: يدخل بمفتاح يسويه المالك من الإعدادات — ما يطلع في شاشة الدخول ولا في الموظفين
if (!hasColumn('users', 'bot')) db.exec('ALTER TABLE users ADD COLUMN bot INTEGER NOT NULL DEFAULT 0');

// أصناف بدون جرد أول اليوم (لحوح، كدر، كبان، رز مطبوخ): رصيدها من الشراء/التحضير
if (!hasColumn('items', 'no_opening')) db.exec('ALTER TABLE items ADD COLUMN no_opening INTEGER NOT NULL DEFAULT 0');

// الذكاء الاصطناعي: سجل كل سؤال وتكلفته، والملخصات والتوصيات المحفوظة (عشان ما يتكرر الصرف)
db.exec(`
CREATE TABLE IF NOT EXISTS ai_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,                 -- ask | summary | reco | invoice
  question TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  cost REAL NOT NULL DEFAULT 0,       -- دولار تقريبًا
  model TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS ai_summaries (
  date TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- summary | reco
  text TEXT NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (date, kind)
);
`);
// سجل لويفرس القديم (للتوقعات) ما ينخصم من المستودع: الخصم يبدأ من أول يوم اشتغل فيه النظام
if (!getSetting('stock_start_date')) {
  const first = get("SELECT MIN(date) AS d FROM moves WHERE type = 'sale_use'").d;
  const d = new Date(Date.now() - 60 * 864e5);
  setSetting('stock_start_date', first || d.toISOString().slice(0, 10));
}
// تغيّر أسعار البيع في لويفرس (ينكتب وقت المزامنة)
db.exec(`CREATE TABLE IF NOT EXISTS price_log (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  old_price REAL NOT NULL, new_price REAL NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')))`);
// المواسم (تتعدّل من الإعدادات): التاريخ بالميلادي تقريبًا، والنسبة = كم يزيد/ينقص البيع
if (!getSetting('seasons')) setSetting('seasons', JSON.stringify([
  { name: 'اليوم الوطني', from: '2026-09-23', to: '2026-09-23', factor: 1.2 },
  { name: 'يوم التأسيس', from: '2027-02-22', to: '2027-02-22', factor: 1.15 },
  { name: 'رمضان', from: '2027-02-08', to: '2027-03-08', factor: 1 },
  { name: 'عيد الفطر', from: '2027-03-09', to: '2027-03-12', factor: 1.3 },
  { name: 'عيد الأضحى', from: '2027-05-16', to: '2027-05-19', factor: 1.3 },
]));

module.exports = { db, all, get, run, tx, getSetting, setSetting, DATA_DIR, UPLOAD_DIR };
