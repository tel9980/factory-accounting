-- 应收来源：加工订单（沿用）
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer TEXT NOT NULL,
  item_name TEXT,
  price REAL NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0,   -- 0待加工 1加工中 2已交付
  paid REAL NOT NULL DEFAULT 0,
  due_date TEXT,                        -- 约定收款日（可选，用于到期提醒）
  operator TEXT,                        -- 经手人
  progress TEXT DEFAULT '',             -- 当前工序（如 备料/加工/喷涂/包装）
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

-- 订单工序流水
CREATE TABLE IF NOT EXISTS process_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  progress TEXT NOT NULL,
  operator TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_process_order ON process_log(order_id);

-- orders.cost：这一单的材料/外协成本（算真实毛利用）
-- ALTER TABLE orders ADD COLUMN cost REAL DEFAULT 0;

-- 应付来源：应付单
CREATE TABLE IF NOT EXISTS payables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  paid REAL NOT NULL DEFAULT 0,
  category TEXT,
  remark TEXT,
  operator TEXT,                        -- 经手人
  due_date TEXT,                        -- 约定付款日
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payables_supplier ON payables(supplier);
CREATE INDEX IF NOT EXISTS idx_payables_created ON payables(created_at);

-- 收付流水（统一收入/支出）
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL,   -- in 收钱 / out 付钱
  ref_type TEXT NOT NULL,    -- order 收客户款 / payable 付供应商 / expense 现付支出
  ref_id INTEGER,
  amount REAL NOT NULL,
  category TEXT,
  remark TEXT,
  operator TEXT,             -- 经手人
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON ledger(created_at);

-- 系统设置（访问口令等）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 云端快照备份（全量 JSON，自动+手动）
CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 固定支出（每月自动记一笔：工资、房租等）
CREATE TABLE IF NOT EXISTS fixed_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amount REAL NOT NULL DEFAULT 0,
  category TEXT,
  remark TEXT,
  day INTEGER NOT NULL DEFAULT 1,   -- 每月几号记（1–28）
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_fixed ON ledger(ref_type, ref_id);

-- 月度结账锁定（锁定后该月账目不可增删改）
CREATE TABLE IF NOT EXISTS month_lock (
  month TEXT PRIMARY KEY,            -- 如 2026-11
  locked_at TEXT NOT NULL
);

-- 操作日志（谁在什么时候动了哪笔账）
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

-- 回收站（删除的单据先放这里，30天内可恢复）
CREATE TABLE IF NOT EXISTS trash (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,      -- order / payable / ledger / process
  ref_id INTEGER NOT NULL,
  data TEXT NOT NULL,      -- 原记录完整 JSON
  batch TEXT NOT NULL,     -- 同批删除（如订单+它的收款流水）
  deleted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trash_batch ON trash(batch);

-- 支出预算（按分类设月度额度，超了首页提醒）
CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 常用短语模板（一句话记账/备注常用语，点一下填入）
CREATE TABLE IF NOT EXISTS phrases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  kind TEXT,                        -- 收 / 付 / 支 可选，仅作分组提示
  created_at TEXT NOT NULL
);

-- 资金账户（现金/银行卡/微信/支付宝）
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT DEFAULT 'cash',
  opening REAL DEFAULT 0,
  created_at TEXT NOT NULL
);
-- 预收款/预付款（客户先打钱、先付供应商定金）
CREATE TABLE IF NOT EXISTS advances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  party TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  used REAL NOT NULL DEFAULT 0,
  remark TEXT,
  account_id INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
-- 收支分类（可自定义）
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  sort INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
-- ledger 增加：所属账户、是否现金流水（预收抵扣这类不算现金）
-- ALTER TABLE ledger ADD COLUMN account_id INTEGER DEFAULT 0;
-- ALTER TABLE ledger ADD COLUMN cash INTEGER DEFAULT 1;

-- ── 第一档：资金账户 / 收支分类 / 预收预付（2026-11 新增）──
-- 已用 ALTER 加到线上三库：
--   ALTER TABLE ledger ADD COLUMN account_id INTEGER DEFAULT 0;
--   ALTER TABLE ledger ADD COLUMN cash INTEGER DEFAULT 1;   -- 0 = 预收/预付抵扣，不动现金

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,            -- 现金 / 银行卡 / 微信 / 支付宝 / 自定义
  kind TEXT DEFAULT 'cash',
  opening REAL DEFAULT 0,        -- 期初余额
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,            -- out=支出类 in=收入类
  name TEXT NOT NULL,
  sort INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS advances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,            -- in=客户预收 out=供应商预付
  party TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  used REAL NOT NULL DEFAULT 0,
  remark TEXT,
  account_id INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger(account_id);
CREATE INDEX IF NOT EXISTS idx_advances_party ON advances(type, party);
CREATE INDEX IF NOT EXISTS idx_categories_type ON categories(type);

-- 员工借支与报销（借支=现金先给员工，不冲成本；报销=按分类记支出，冲借支不动现金）
CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  used REAL NOT NULL DEFAULT 0,
  returned REAL NOT NULL DEFAULT 0,
  remark TEXT,
  account_id INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loans_staff ON loans(staff);

-- 月度结转归档（月结后打快照，报表以快照为准）
CREATE TABLE IF NOT EXISTS month_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT UNIQUE,
  data TEXT,
  created_at TEXT
);

-- 对账台账：每次核对留一条，月底能看谁对过、还差几家没处理
CREATE TABLE IF NOT EXISTS recon_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT,
  type TEXT,
  party TEXT,
  imported REAL DEFAULT 0,
  system REAL DEFAULT 0,
  diff REAL DEFAULT 0,
  state TEXT,
  done INTEGER DEFAULT 0,
  note TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_recon_log_month ON recon_log(month);

-- 导入批次留痕：每批导入留一条，导错了可整批撤回
CREATE TABLE IF NOT EXISTS import_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT,
  cnt INTEGER DEFAULT 0,
  total REAL DEFAULT 0,
  dup_count INTEGER DEFAULT 0,
  skipped_locked INTEGER DEFAULT 0,
  ids TEXT,
  src TEXT,
  undone INTEGER DEFAULT 0,
  created_at TEXT
);

-- 账期与对账周期：客户月结 N 天、每 N 天对一次账
CREATE TABLE IF NOT EXISTS party_terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  party TEXT UNIQUE,
  kind TEXT DEFAULT 'ar',
  term_days INTEGER DEFAULT 0,
  recon_cycle INTEGER DEFAULT 0,
  note TEXT,
  created_at TEXT
);

-- 往来单位档案（电话/联系人/地址/备注）：催款拨号、对账单抬头
CREATE TABLE IF NOT EXISTS party_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  party TEXT NOT NULL UNIQUE,
  kind TEXT, contact TEXT, phone TEXT, addr TEXT, note TEXT, created_at TEXT
);

-- 催款记录（哪天跟谁催过）
CREATE TABLE IF NOT EXISTS dunning_log (id INTEGER PRIMARY KEY AUTOINCREMENT, party TEXT, type TEXT, channel TEXT, note TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS idx_dunning_party ON dunning_log(party);

-- 催款时对方答应的付款日（答应 X 日付，过了没付就提醒）
ALTER TABLE dunning_log ADD COLUMN promise_date TEXT;
