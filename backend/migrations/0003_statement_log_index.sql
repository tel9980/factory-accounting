-- 第 13 轮 E7：idx_statement_log_party 在 schema.sql 里是 (party)，在 0001 迁移里是 (party, type)。
-- 新库（靠 schema.sql 建）和老库（靠迁移建）拿到的是两个不同定义的索引；
-- 谁先建成谁生效，之后再改都不生效（CREATE INDEX IF NOT EXISTS 看到同名就跳过）。
-- 这条把两边统一成 (party, type)：对账确认的「这家这个月发过没」查询正好用这两个字段。
DROP INDEX IF EXISTS idx_statement_log_party;
CREATE INDEX IF NOT EXISTS idx_statement_log_party ON statement_log(party, type);
