-- 第 1 号迁移：给查得最勤的三张表补索引。
-- 为什么放在迁移文件里而不是只靠代码里的 EXTRA_COLS：
--   EXTRA_COLS 只管「加列」，索引既没有版本号也没地方记。
--   结果就是：本地库和线上库到底有哪些索引，全靠碰运气对一下。
-- 现在每个迁移文件跑一次就跑过了，跑过的不再跑（记录在 migrations 表）。

-- 流水按「来源单据」查得最勤（核销记录、预收预付、工资都靠它回溯是哪张单）
CREATE INDEX IF NOT EXISTS idx_ledger_ref_dir ON ledger(ref_type, ref_id, direction);

-- 「还没结清的单」这个条件全库出现几十次，但之前只有 orders/payables 各自的 day 索引
CREATE INDEX IF NOT EXISTS idx_orders_paid ON orders(paid, written_off);
CREATE INDEX IF NOT EXISTS idx_payables_paid ON payables(paid, written_off);

-- 到期提醒按到期日排序取最急的几条
CREATE INDEX IF NOT EXISTS idx_statement_log_party ON statement_log(party, type);
