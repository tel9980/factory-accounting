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
