-- 应收来源：加工订单（沿用）
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer TEXT NOT NULL,
  item_name TEXT,
  price REAL NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0,   -- 0待加工 1加工中 2已交付
  paid REAL NOT NULL DEFAULT 0,
  due_date TEXT,
  deliver_date TEXT,                        -- 约定收款日（可选，用于到期提醒）
  operator TEXT,                        -- 经手人
  progress TEXT DEFAULT '',             -- 当前工序（如 备料/加工/喷涂/包装）
  created_at TEXT NOT NULL,
  month TEXT,                         -- =substr(created_at,1,7)，触发器自动填，首页走索引
  created_by TEXT,                    -- 谁录的（'老板' / '员工·小王'），员工「只看自己录的单」用这个
  delivered_at TEXT,                  -- 实际交付时间
  cost REAL DEFAULT 0,                -- 这一单的材料/外协成本，算真实毛利用
  written_off REAL DEFAULT 0,         -- 已核销（坏账/抹零），算欠款时要扣掉
  rev INTEGER DEFAULT 0,              -- 反结账标记：1 = 这单是红冲的倒记账
  no_invoice INTEGER DEFAULT 0,       -- 客户说不要票，不进「待开票」清单
  import_batch TEXT,                  -- 从 Excel 一次导入的批次号，导错了整批撤回
  -- 税：税率不固定（13/9/6/3/1 都有，也有按点数谈的），所以记「含税/不含税 + 税率 + 税额」三样。
  -- 税额有值时以手填为准（票面常跟算出来的差几分），否则按 kind+rate 推：含税单 tax=总额-总额/(1+r)。
  tax_kind TEXT DEFAULT '',           -- '含税' / '不含税' / 空=没标
  tax_rate REAL DEFAULT 0,            -- 税率百分比，如 13
  tax_amt REAL DEFAULT 0              -- 这一单的税额
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_month ON orders(month);
CREATE INDEX IF NOT EXISTS idx_orders_deliver ON orders(deliver_date);
CREATE INDEX IF NOT EXISTS idx_orders_by ON orders(created_by);
CREATE TRIGGER IF NOT EXISTS trg_orders_month AFTER INSERT ON orders WHEN NEW.month IS NULL
BEGIN UPDATE orders SET month=substr(NEW.created_at,1,7) WHERE id=NEW.id; END;

-- 订单工序流水
CREATE TABLE IF NOT EXISTS process_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  progress TEXT NOT NULL,
  operator TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_process_order ON process_log(order_id);

-- 说明：cost / written_off / rev / no_invoice / import_batch 这些列早年是用 ALTER 加到线上库的，
-- 现在直接写进上面的建表语句，新装也能一次建全（老库 IF NOT EXISTS 不受影响）。

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
  created_at TEXT NOT NULL,
  month TEXT,                         -- =substr(created_at,1,7)，触发器自动填
  created_by TEXT,                    -- 谁录的（'老板' / '员工·小王'）
  written_off REAL DEFAULT 0,         -- 已核销，算欠款时要扣掉
  rev INTEGER DEFAULT 0,              -- 反结账标记
  import_batch TEXT,                  -- 导入批次号
  tax_kind TEXT DEFAULT '',           -- 含税 / 不含税 / 空=没标（同 orders）
  tax_rate REAL DEFAULT 0,
  tax_amt REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_payables_supplier ON payables(supplier);
CREATE INDEX IF NOT EXISTS idx_payables_created ON payables(created_at);
CREATE INDEX IF NOT EXISTS idx_payables_month ON payables(month);
CREATE INDEX IF NOT EXISTS idx_payables_by ON payables(created_by);
CREATE TRIGGER IF NOT EXISTS trg_payables_month AFTER INSERT ON payables WHEN NEW.month IS NULL
BEGIN UPDATE payables SET month=substr(NEW.created_at,1,7) WHERE id=NEW.id; END;

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
  created_at TEXT NOT NULL,
  month TEXT,                -- =substr(created_at,1,7)，触发器自动填
  account_id INTEGER DEFAULT 0,   -- 哪张卡/哪个钱包（0 = 没指定，算默认账户）
  cash INTEGER DEFAULT 1,         -- 1 = 真金白银进出；0 = 预收预付抵扣/摊销，不动现金
  import_batch TEXT,              -- 导入批次号
  -- 有没有票 / 税金：用户说「有些是要等到实际收付才知道的」，所以票和税记在流水上，不记在单上。
  inv_state TEXT DEFAULT '',      -- 'yes' 有票 / 'no' 没票 / 'part' 部分 / 空=没标
  inv_no TEXT DEFAULT '',         -- 票号（有就填，没有不影响）
  tax REAL DEFAULT 0              -- 这一笔里的税额（含税单 = 金额里的税；税金单独收付时 = 金额本身）
);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON ledger(created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_month ON ledger(month);
CREATE TRIGGER IF NOT EXISTS trg_ledger_month AFTER INSERT ON ledger WHEN NEW.month IS NULL
BEGIN UPDATE ledger SET month=substr(NEW.created_at,1,7) WHERE id=NEW.id; END;

-- 系统设置（访问口令等）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 云端快照备份（全量 JSON，自动+手动）
CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  -- 真实字符数。内容超过 90 万字符（D1 单行上限 2MB 的一半）就切成多片存 backup_parts，
  -- content 留空、长度记在这里，读的时候按 seq 拼回去（对外还是同一份 JSON）。
  size INTEGER DEFAULT 0,
  -- 摘要（订单/应付/流水各多少笔、金额合计）。备份列表只要这些数字，
  -- 以前每次把最近 12 份备份整份读回来再 JSON.parse，几千单的账本一打开就卡。
  stat TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

-- 备份分片：整库备份到几千单就超过 D1 单行上限，超了 INSERT 直接被拒 →
-- 表现是「每天备份静默失败、列表里只剩很久以前那份」，而本机 SQLite 没这个限制、测不出来。
CREATE TABLE IF NOT EXISTS backup_parts (
  bid INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (bid, seq)
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
-- 自动记账（固定支出 / 摊销 / 折旧 / 预提利息）每月只该有一条。
-- 以前靠「先 SELECT COUNT 再 INSERT」，两个 cron 或连点两次就会提两遍，成本凭空多一笔。
-- 用条件唯一索引从数据库这层挡住，代码里改成 INSERT OR IGNORE 即可。
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_once ON ledger(ref_type, ref_id, month)
  WHERE ref_type IN ('fixed','amort','dep','debt_int');

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
  ref_type TEXT,           -- 挂在哪种单据上：order / payable（老库用 ALTER TABLE 补）
  ref_id TEXT,
  by TEXT,                 -- 谁动的手：老板 / 员工（老库用 ALTER TABLE 补）
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

-- （资金账户 / 预收预付 / 收支分类三张表建在下面「第一档」那一段，这里不再重复建）
-- account_id / cash 早年单独 ALTER 加过，现在已并入上面的建表语句，新装一次到位。

-- ── 第一档：资金账户 / 收支分类 / 预收预付（2026-11 新增）──

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,            -- 现金 / 银行卡 / 微信 / 支付宝 / 自定义
  kind TEXT DEFAULT 'cash',
  opening REAL DEFAULT 0,        -- 期初余额
  created_at TEXT NOT NULL,
  -- 这个账户平时收付「有没有票」的习惯：'yes' 有票 / 'no' 没票 / 'part' 部分 / 空=每次现问。
  -- 对公户一般有票、个人户一般没票，收付款时按它带出默认值，省得每笔都点。
  inv_default TEXT DEFAULT ''
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
  import_batch TEXT,
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
  batch TEXT,                      -- 本批批次号，和 orders/payables/ledger.import_batch 对得上
  created_at TEXT
);

-- 账期与对账周期：客户月结 N 天、每 N 天对一次账
CREATE TABLE IF NOT EXISTS party_terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  party TEXT UNIQUE,
  kind TEXT DEFAULT 'ar',
  term_days INTEGER DEFAULT 0,
  recon_cycle INTEGER DEFAULT 0,
  recon_day INTEGER DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS dunning_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  party TEXT,
  type TEXT,
  channel TEXT,             -- 微信 / 电话 / 当面 / 短信
  note TEXT,
  promise_date TEXT,        -- 对方答应的付款日（答应了没付就提醒）——早年是 ALTER 加的，新装直接建
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_dunning_party ON dunning_log(party);

-- 对账单送达记录（哪天把对账单发给谁了）
CREATE TABLE IF NOT EXISTS statement_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  party TEXT,
  type TEXT,
  month TEXT,
  channel TEXT,
  note TEXT,
  ack TEXT,                 -- 客户那边的回执：收到 / 有异议
  ack_at TEXT,              -- 点开确认的时间
  resolved_at TEXT,         -- 有异议的那家，哪天处理完的
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_statement_log_party ON statement_log(party);

-- 运行出错留痕（线上 5xx 会记一条，报表页「数据体检」里能查）
CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book INTEGER,
  method TEXT,
  path TEXT,
  status INTEGER,
  msg TEXT,
  ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_error_created ON error_log(created_at);

-- 慢接口留痕（超过 800ms 记一条，同一接口每小时最多一条）
CREATE TABLE IF NOT EXISTS slow_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT, method TEXT, dur INTEGER, book INTEGER, created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_slow_created ON slow_log(created_at);

-- 客户进度页查看留痕
CREATE TABLE IF NOT EXISTS track_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  party TEXT NOT NULL,
  ua TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_track_log_party ON track_log(party);

-- 断网补发去重：手机端断网时把记账先存本地，联网后重发；同一 client_id 只入账一次
CREATE TABLE IF NOT EXISTS op_dedupe (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT UNIQUE,
  kind TEXT,
  ref_id INTEGER,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_op_client ON op_dedupe(client_id);

-- 家底存档：每个月末的现金/应收/应付/借款/净资产，存下来就不会被后来的改单带偏
CREATE TABLE IF NOT EXISTS net_snapshots (
  month TEXT PRIMARY KEY,       -- YYYY-MM
  cash REAL DEFAULT 0,
  ar REAL DEFAULT 0,
  ap REAL DEFAULT 0,
  debt REAL DEFAULT 0,
  net REAL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL
);

-- 固定资产与折旧（老库用 ALTER TABLE 补 disposed_at / dispose_amount）
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  cost REAL NOT NULL,
  buy_date TEXT,
  life_years REAL DEFAULT 5,
  residual_rate REAL DEFAULT 5,   -- 残值率 %
  disposed_at TEXT,               -- 卖掉/报废那天（空=还在用）
  dispose_amount REAL DEFAULT 0,  -- 卖了多少钱（报废填 0）
  maint_months INTEGER DEFAULT 0,  -- 每几个月保养一次（0=不提醒）
  maint_last TEXT,                 -- 上次保养日期
  created_at TEXT NOT NULL
);


-- 单据照片（送货单/验收单/发票照片，压缩后存 base64）
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_type TEXT NOT NULL, ref_id INTEGER NOT NULL,
  name TEXT, mime TEXT, size INTEGER, b64 TEXT, created_at TEXT NOT NULL,
  r2_key TEXT                  -- 有 R2 时照片本体存在对象存储，这里只存 key
);
CREATE INDEX IF NOT EXISTS idx_att_ref ON attachments(ref_type, ref_id);

-- 员工改单申请（员工不能直接删改单据，提申请由老板一键同意/驳回）
-- 员工账号：一人一个口令，各自授权限（老的整体员工口令继续可用）
CREATE TABLE IF NOT EXISTS staff_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  pin TEXT NOT NULL UNIQUE,             -- 老库里是明文，现已改成占位符（'@'+id）
  pin_hash TEXT,                        -- sha256(staff_salt|sp|口令)，登录按它查
  modules TEXT NOT NULL DEFAULT 'ar,ap,exp,import,contact,asset',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_staff_pin ON staff_users(pin);
CREATE INDEX IF NOT EXISTS idx_staff_hash ON staff_users(pin_hash);

CREATE TABLE IF NOT EXISTS edit_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- ar | ap | expense
  ref_id INTEGER NOT NULL,
  changes TEXT,                    -- JSON：要改成什么
  reason TEXT,
  by TEXT,                         -- 员工 | 老板
  status TEXT DEFAULT 'pending',   -- pending | ok | no
  note TEXT,
  created_at TEXT,
  done_at TEXT,
  done_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_edit_req ON edit_requests(status, kind, ref_id);

-- 对账结论确认（对方回「对」了，记一笔，作为这期结清的证据）
CREATE TABLE IF NOT EXISTS recon_confirm (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT, type TEXT, party TEXT,
  amount REAL, imported REAL, system REAL, diff REAL,
  note TEXT, by TEXT, created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_recon_confirm ON recon_confirm(month, type, party);

-- 客户不要发票的单据（不进待开票清单）
-- no_invoice 已并入 orders 建表语句。

-- 报价单：先报价、客户点头再转成应收单（status: draft/sent/accepted/rejected/ordered）
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  no TEXT,
  party TEXT NOT NULL,
  item TEXT,
  qty REAL DEFAULT 1,
  price REAL DEFAULT 0,
  cost REAL DEFAULT 0,
  margin REAL DEFAULT 0,
  note TEXT,
  valid_days INTEGER DEFAULT 15,
  status TEXT DEFAULT 'draft',
  token TEXT,
  order_id INTEGER,
  sent_at TEXT,
  decided_at TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status, created_at);

-- 计件工资：单价表 / 记工 / 发放
CREATE TABLE IF NOT EXISTS wage_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker TEXT NOT NULL DEFAULT '',
  item TEXT DEFAULT '',
  process TEXT DEFAULT '',
  rate REAL NOT NULL DEFAULT 0,
  unit TEXT DEFAULT '件',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wage_rate_worker ON wage_rates(worker);

CREATE TABLE IF NOT EXISTS wage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  month TEXT,
  order_id INTEGER DEFAULT 0,
  item TEXT DEFAULT '',
  process TEXT DEFAULT '',
  qty REAL NOT NULL DEFAULT 0,
  rate REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  by TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wage_rec_month ON wage_records(month);
CREATE INDEX IF NOT EXISTS idx_wage_rec_worker ON wage_records(worker);

CREATE TABLE IF NOT EXISTS wage_pays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL,
  worker TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  account_id INTEGER DEFAULT 0,
  note TEXT DEFAULT '',
  by TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wage_pay_month ON wage_pays(month);

-- 工资里扣的钱（宿舍水电、宿舍租金、伙食、罚款）：厂里先付给房东，再从工人工资里扣回来。
-- 应发不动，实发 = 应发 − 扣款；扣款不产生现金流水（钱在付房东那次已经出去了）。
CREATE TABLE IF NOT EXISTS wage_deduct (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL,
  worker TEXT NOT NULL DEFAULT '',
  kind TEXT DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  remark TEXT DEFAULT '',
  by TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wage_deduct ON wage_deduct(month, worker);

-- 材料台账：进货 / 领用 / 结存（材料名与单位全部自定义，不预设行业）
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE, unit TEXT DEFAULT '个',
  min_qty REAL DEFAULT 0, note TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS material_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'in',
  date TEXT, month TEXT, qty REAL NOT NULL DEFAULT 0,
  price REAL DEFAULT 0, amount REAL DEFAULT 0,
  party TEXT DEFAULT '', order_id INTEGER DEFAULT 0,
  note TEXT DEFAULT '', by TEXT DEFAULT '', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mat_move_mat ON material_moves(material, month);
CREATE INDEX IF NOT EXISTS idx_mat_move_mat_date ON material_moves(material, date);

-- 员工负责的客户：员工只看自己负责的那几家（老板在设置里可关）
CREATE TABLE IF NOT EXISTS party_staff (
  party TEXT PRIMARY KEY,
  staff TEXT NOT NULL DEFAULT '',
  updated_at TEXT
);

-- 合同 / 框架价：约定好的单价，下单低于它当场提醒（不拦）
CREATE TABLE IF NOT EXISTS frame_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  party TEXT NOT NULL DEFAULT '', item TEXT DEFAULT '',
  price REAL NOT NULL DEFAULT 0, unit TEXT DEFAULT '件',
  start_date TEXT, end_date TEXT, note TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_frame_party ON frame_prices(party, active);

-- 外协台账：发出去的活（谁、多少钱、约定什么时候回、回了没）
CREATE TABLE IF NOT EXISTS outsourcing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  party TEXT NOT NULL DEFAULT '', order_id INTEGER DEFAULT 0,
  item TEXT DEFAULT '', qty REAL DEFAULT 0, price REAL NOT NULL DEFAULT 0,
  sent_date TEXT, due_date TEXT, back_date TEXT,
  status TEXT NOT NULL DEFAULT 'open', note TEXT DEFAULT '',
  by TEXT DEFAULT '', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_os_status ON outsourcing(status, due_date);
CREATE INDEX IF NOT EXISTS idx_os_party ON outsourcing(party);

-- 返工 / 报废 / 客诉台账（只记损失金额与原因，不重复进出款）
CREATE TABLE IF NOT EXISTS reworks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'rework',
  date TEXT NOT NULL,
  month TEXT,
  party TEXT DEFAULT '',
  order_id INTEGER DEFAULT 0,
  item TEXT DEFAULT '',
  qty REAL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  reason TEXT DEFAULT '',
  fault TEXT DEFAULT '',
  fix TEXT DEFAULT '',
  note TEXT DEFAULT '',
  by TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rw_month ON reworks(month);
CREATE INDEX IF NOT EXISTS idx_rw_party ON reworks(party);

-- ===== 早期就有的表，一直漏在 schema.sql 之外 =====
-- 这 7 张表（借款、还款、发票、内部转账、核销、月度目标、信用额度）线上库早就有了
-- （是更早版本的 schema 建的），但后来的 schema.sql 里没有它们、代码里也没有建表语句。
-- 后果：线上照旧能用，但**按 schema.sql 新装一本账时，这 7 个功能全是空的**（接口 catch 掉报错返回空列表）。
-- 列是按代码里实际读写的字段反推的；线上已有的表不受影响（IF NOT EXISTS 不会改结构）。
-- scripts/check.mjs 会检查「代码里 SELECT 的表是否都有建表语句」，防止再漏。

CREATE TABLE IF NOT EXISTS debts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lender TEXT DEFAULT '',
  kind TEXT DEFAULT 'bank',
  principal REAL NOT NULL DEFAULT 0,
  rate REAL DEFAULT 0,
  start_date TEXT,
  term_months INTEGER DEFAULT 0,
  pay_kind TEXT DEFAULT 'interest',
  account_id INTEGER DEFAULT 0,
  remark TEXT DEFAULT '',
  status TEXT DEFAULT 'open',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_debts_status ON debts(status);
CREATE TABLE IF NOT EXISTS debt_repays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  debt_id INTEGER NOT NULL,
  rdate TEXT,
  amount REAL NOT NULL DEFAULT 0,
  kind TEXT DEFAULT 'interest',
  account_id INTEGER DEFAULT 0,
  remark TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_debt_repays_debt ON debt_repays(debt_id);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'out',
  no TEXT DEFAULT '',
  party TEXT DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  tax REAL DEFAULT 0,
  date TEXT,
  remark TEXT DEFAULT '',
  order_id INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(date);
CREATE INDEX IF NOT EXISTS idx_invoices_order ON invoices(order_id);
CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER DEFAULT 0,
  to_id INTEGER DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  remark TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS writeoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_type TEXT NOT NULL,
  ref_id INTEGER NOT NULL DEFAULT 0,
  party TEXT DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  reason TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_writeoffs_ref ON writeoffs(ref_type, ref_id);
CREATE TABLE IF NOT EXISTS targets (
  month TEXT PRIMARY KEY,
  receive REAL DEFAULT 0,
  order_add REAL DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS credit_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  party TEXT UNIQUE,
  limit_amount REAL DEFAULT 0,
  note TEXT DEFAULT '',
  created_at TEXT
);

-- ── 同样漏过建表语句的 4 张表（2026-11 补）──
-- prepaids / wx_users / bank_flows / month_report 和上面 7 张一个情况：线上是老库建的，schema.sql 里一直没有。
-- 列按代码实际读写反推：INTO prepaids(…)、INTO wx_users(…)、INTO bank_flows(…)、INTO month_report(…)。

-- 待摊费用（房租/保险一次付多月，按月摊销进成本，摊销流水 cash=0 不动现金）
CREATE TABLE IF NOT EXISTS prepaids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT DEFAULT '',
  total REAL NOT NULL DEFAULT 0,   -- 一次付了多少
  months INTEGER DEFAULT 1,        -- 摊几个月
  start_date TEXT,                 -- 从哪个月开始摊
  category TEXT DEFAULT '房租',
  account_id INTEGER DEFAULT 0,
  remark TEXT DEFAULT '',
  active INTEGER DEFAULT 1,        -- 1=在摊 0=摊完/停摊
  created_at TEXT NOT NULL
);

-- 微信小程序用户（体验额度，一个人给几次试用）
CREATE TABLE IF NOT EXISTS wx_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  openid TEXT NOT NULL UNIQUE,
  nickname TEXT DEFAULT '',
  quota INTEGER NOT NULL DEFAULT 0,  -- 还剩几次额度
  created_at TEXT,
  last_at TEXT
);

-- 银行流水（导入银行卡账单，和对账单逐笔勾对）
CREATE TABLE IF NOT EXISTS bank_flows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT,
  direction TEXT,                  -- in 收 / out 付
  amount REAL NOT NULL DEFAULT 0,
  memo TEXT DEFAULT '',
  matched_type TEXT,               -- 勾到哪种单据：order / payable / expense
  matched_id INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bank_flows_date ON bank_flows(date);

-- 月度全套报表存档（月底自动生成 Excel，存 base64 供下载；和 backups 一样不进备份）
CREATE TABLE IF NOT EXISTS month_report (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT,
  name TEXT,
  b64 TEXT,
  size INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_month_report_month ON month_report(month);

-- ─────────────────────────────────────────────────────────────────────────────
-- 表达式索引：让 substr(created_at,1,10) 这种写法也能走索引
--
-- 背景：全库有 106 处按天过滤（substr(created_at,1,10)=? / >=?）、28 处按年过滤
-- （substr(created_at,1,4)=?）、还有到期日按天比（substr(due_date,1,10)<=?）。
-- 函数包着字段，普通索引用不上，每次都扫全表 —— D1 是按「读了多少行」计费的，
-- 一次按天查流水在 4.8 万行的账本上要读 4.8 万行。
-- SQLite 支持「在表达式上建索引」，查询里的表达式和索引完全一致时照样能用，
-- 所以这 7 个索引不用改一行代码就能让上面那 134 处全都走进来。
--
-- 实测（24000 单 / 48000 条流水 / 6000 应付，node:sqlite 内存库）：
--   某天流水        3.31ms → 0.00ms（SEARCH ledger USING INDEX idx_ledger_day）
--   某段日期（三个月）2.15ms → 0.07ms（COVERING INDEX idx_orders_day）
--   某年订单        1.88ms → 0.56ms
--   到期日在一个月内  2.72ms → 0.06ms
--   建这 7 个索引本身 42ms（一次性）。
-- 注：表达式索引会随写入维护，账本这种「写少读多」的场景是净赚。
CREATE INDEX IF NOT EXISTS idx_orders_day ON orders(substr(created_at,1,10));
CREATE INDEX IF NOT EXISTS idx_orders_year ON orders(substr(created_at,1,4));
CREATE INDEX IF NOT EXISTS idx_orders_due_day ON orders(substr(due_date,1,10));
CREATE INDEX IF NOT EXISTS idx_ledger_day ON ledger(substr(created_at,1,10));
CREATE INDEX IF NOT EXISTS idx_ledger_year ON ledger(substr(created_at,1,4));
CREATE INDEX IF NOT EXISTS idx_payables_day ON payables(substr(created_at,1,10));
CREATE INDEX IF NOT EXISTS idx_payables_due_day ON payables(substr(due_date,1,10));

-- 发工资：一个人一个月可以分多次发（先发一部分、月底补），所以这里故意不加唯一索引。
-- 防重复靠 client_id 去重 + 写前按已发金额做条件插入（见 /payroll/pay）。

-- 口令试错计数（按 IP）：15 分钟内错 10 次锁 15 分钟，防止 4 位口令被爆破
CREATE TABLE IF NOT EXISTS auth_fails (
  ip TEXT PRIMARY KEY,
  n INTEGER DEFAULT 0,
  first_at INTEGER DEFAULT 0,
  locked_until INTEGER DEFAULT 0
);
