-- 第 20 轮 B5：给「还没结清」的行加部分索引。
-- 老库升级时补上；新库由 backend/schema.sql 一起建（两边定义必须一致，check.mjs [4.15]/[4.20] 会校）。
CREATE INDEX IF NOT EXISTS idx_orders_open ON orders(due_date) WHERE COALESCE(paid,0) + COALESCE(written_off,0) < price;
CREATE INDEX IF NOT EXISTS idx_payables_open ON payables(due_date) WHERE COALESCE(paid,0) + COALESCE(written_off,0) < amount;
