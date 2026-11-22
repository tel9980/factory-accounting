-- 第 10 轮 C2 配套：writeoffs（坏账核销）新增 month 列（核销归属哪个月）。
--
-- 为什么要在迁移里补：schema.sql 里全是 CREATE TABLE IF NOT EXISTS，老库（线上 D1）
-- 早就建过 writeoffs，新列不会被建出来 → 一查就 no such column: month → 接口 500。
--
-- 幂等：SQLite 的 ADD COLUMN 没有 IF NOT EXISTS，所以重复执行会报
-- "duplicate column name"。这个错误由执行器（scripts/migrations-lib.mjs 的
-- runStatement / scripts/d1-migrate.mjs）当成「这列已经在了」跳过，不会中断迁移。
-- 所以这个文件可以反复跑。
ALTER TABLE writeoffs ADD COLUMN month TEXT DEFAULT '';

-- 同样的原因给这一个索引也补上（老库没有，新库 schema.sql 里已经有）。
CREATE INDEX IF NOT EXISTS idx_writeoffs_m ON writeoffs(month);
