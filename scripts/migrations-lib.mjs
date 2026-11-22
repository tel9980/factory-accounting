// 迁移文件（backend/migrations/*.sql）的公共处理：拆语句 + 幂等容错。
//
// 为什么需要单独一个文件：SQLite 的 `ALTER TABLE ... ADD COLUMN` **没有** IF NOT EXISTS，
// 在已经有那一列的老库上会报 "duplicate column name"，把整份迁移打断。
// 所以迁移必须**逐条语句**执行，并且只把「列已存在」这一个错误当成功跳过，
// 其余错误一律报错中断（不许吞错误——吞了就等于迁移没跑）。
//
// 这里是 scripts/ 和 server/ 各自实现同一套逻辑的**唯一定义处**：
//   · scripts/d1-migrate.mjs    —— 线上远程 D1（wrangler d1 execute）
//   · scripts/test-migrations.mjs —— 本机 node:sqlite 干跑
//   · server/d1.mjs             —— 本机版启动时补迁移（自带一份精简实现，
//                                   因为 exe/Docker 镜像里没有 scripts/ 目录）

import fs from 'node:fs'
import path from 'node:path'

// 按文件名顺序取迁移文件（0000_xxx.sql → 0001_xxx.sql → …）
export function listMigrations(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f, path: path.join(dir, f) }))
}

// 把一份 .sql 拆成一条条语句。
// 做法：去掉整行 -- 注释，按 ';' 切。迁移文件里没有 BEGIN…END 的触发器块，
// 所以这样切是安全的（schema.sql 有触发器，但那份不拆，整段 exec）。
export function splitStatements(sql) {
  const clean = sql
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n')
  const out = []
  for (const raw of clean.split(';')) {
    const s = raw.trim()
    if (!s) continue
    out.push(s)
  }
  return out
}

// 「这一列已经有了」——这类错误要当成功（幂等）。
export function isDuplicateColumnError(msg) {
  return /duplicate column name/i.test(String(msg || ''))
}

// 「这张表/索引已经在了」——同样是幂等语义。
export function isAlreadyExistsError(msg) {
  return /already exists/i.test(String(msg || ''))
}

// 执行一条语句，返回 { skipped:boolean, error:Error|null }
//   exec(stmt) => 同步执行并抛错（node:sqlite 风格）
export function runStatement(exec, stmt) {
  try {
    exec(stmt)
    return { skipped: false, error: null }
  } catch (e) {
    const msg = String((e && e.message) || e)
    if (isDuplicateColumnError(msg) || isAlreadyExistsError(msg)) return { skipped: true, error: null }
    return { skipped: false, error: e }
  }
}
