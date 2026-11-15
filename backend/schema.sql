-- 应收来源：加工订单（沿用）
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer TEXT NOT NULL,
  item_name TEXT,
  price REAL NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0,   -- 0待加工 1加工中 2已交付
  paid REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

-- 应付来源：应付单
CREATE TABLE IF NOT EXISTS payables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  paid REAL NOT NULL DEFAULT 0,
  category TEXT,
  remark TEXT,
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
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON ledger(created_at);
