-- 第 1 号迁移：给查得最勤的三张表补索引。
--
-- 幂等说明（老库兼容）：
--   · 建索引用 `CREATE INDEX IF NOT EXISTS`，重复跑不会报错。
--   · 下面两段补列用的是 `ALTER TABLE ... ADD COLUMN`，SQLite **没有** IF NOT EXISTS，
--     在已经有该列的库上会报 "duplicate column name"。
--     迁移执行器（scripts/d1-migrate.mjs 跑远程 D1；server/d1.mjs 跑本机库）
--     是**逐条语句**执行的，只把 "duplicate column name" / "already exists"
--     这两类错误当成功跳过，其余错误一律报错中断（不吞错误）。
--     所以本文件重复执行多少次都不会失败，也不会把库改坏。
--   · 索引建在 written_off 上，所以必须先把这一列补上，
--     否则老库直接报「no such column: written_off」，整份迁移失败。

-- 已销账金额：单据被核销掉多少（0 = 没销账）
-- 老库里没有这一列，先补上；已经有就跳过（执行器负责幂等）。
ALTER TABLE orders ADD COLUMN written_off REAL NOT NULL DEFAULT 0;

-- 应付单同理
ALTER TABLE payables ADD COLUMN written_off REAL NOT NULL DEFAULT 0;

-- 流水按「来源单据」查得最勤（核销记录、预收预付、工资都靠它回溯是哪张单）
CREATE INDEX IF NOT EXISTS idx_ledger_ref_dir ON ledger(ref_type, ref_id, direction);

-- 「还没结清的单」这个条件全库出现几十次，但之前只有 orders/payables 各自的 day 索引
CREATE INDEX IF NOT EXISTS idx_orders_paid ON orders(paid, written_off);
CREATE INDEX IF NOT EXISTS idx_payables_paid ON payables(paid, written_off);

-- 到期提醒按到期日排序取最急的几条
CREATE INDEX IF NOT EXISTS idx_statement_log_party ON statement_log(party, type);
