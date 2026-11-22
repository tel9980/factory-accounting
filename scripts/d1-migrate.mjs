// 线上远程 D1 的迁移执行器：node scripts/d1-migrate.mjs [--db factory-db] [--dir backend/migrations]
//
// 为什么需要它：wrangler d1 execute --file=xxx.sql 是**整份文件**一起跑的，
// 文件里只要有一条语句在老库上报错（比如 SQLite 没有 ADD COLUMN IF NOT EXISTS，
// 重复加列会报 "duplicate column name"），整份文件就失败，
// 后面的索引一条也建不成。
//
// 所以这里改成**逐条语句**跑：
//   · 拆语句用 scripts/migrations-lib.mjs 的 splitStatements；
//   · 每条语句单独 `wrangler d1 execute --command`，失败时只把
//     「列已存在 / 已存在」当成功跳过，其余错误立刻报错中断（不吞错误）。
//
// 幂等 + 记账：每个迁移文件跑完，在 migrations 表里记一行
//   INSERT OR IGNORE INTO migrations (name, applied_at) VALUES ('<file>', datetime('now'))
// 已经记过的文件直接跳过（除非 --force）。
//
// 只用 Node 内置模块 + 后端目录里的 wrangler，不装任何新依赖。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { listMigrations, splitStatements, isDuplicateColumnError, isAlreadyExistsError } from './migrations-lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return def
}
const has = (name) => process.argv.includes('--' + name)

// 从 backend/wrangler.toml 里读出所有 d1 绑定（database_name + binding）
export function readD1Bindings(tomlPath) {
  const src = fs.readFileSync(tomlPath, 'utf8')
  const out = []
  const blocks = src.split('[[d1_databases]]').slice(1)
  for (const b of blocks) {
    const binding = (b.match(/^\s*binding\s*=\s*"([^"]+)"/m) || [])[1]
    const name = (b.match(/^\s*database_name\s*=\s*"([^"]+)"/m) || [])[1]
    if (name) out.push({ binding: binding || name, database_name: name })
  }
  return out
}

function wrangler(db, sql, cwd) {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', db, '--remote', '--command', sql], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const text = ((r.stdout || '') + '\n' + (r.stderr || '')).trim()
  return { code: r.status, text }
}

function main() {
  const dir = path.resolve(ROOT, arg('dir', 'backend/migrations'))
  const backendDir = path.join(ROOT, 'backend')
  const force = has('force')
  const only = arg('db', null)

  const bindings = readD1Bindings(path.join(backendDir, 'wrangler.toml'))
  if (!bindings.length) {
    console.error('❌ backend/wrangler.toml 里没读到 [[d1_databases]] 绑定，迁移没跑')
    process.exit(1)
  }
  const targets = only ? bindings.filter((b) => b.database_name === only || b.binding === only) : bindings
  if (!targets.length) {
    console.error('❌ 指定的库不在 backend/wrangler.toml 的绑定里：' + only)
    process.exit(1)
  }

  const files = listMigrations(dir)
  if (!files.length) {
    console.log('ℹ️ 没有迁移文件，跳过')
    return
  }

  let failed = 0
  for (const t of targets) {
    // 先保证 migrations 表在
    let r = wrangler(t.database_name, "CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)", backendDir)
    if (r.code !== 0) {
      console.error(`❌ ${t.database_name} 建 migrations 表失败：${r.text}`)
      failed++
      continue
    }
    for (const f of files) {
      const esc = f.name.replace(/'/g, "''")
      if (!force) {
        const q = wrangler(t.database_name, `SELECT name FROM migrations WHERE name = '${esc}'`, backendDir)
        if (q.code === 0 && /^\s*\S/m.test(q.text) && q.text.includes(f.name)) {
          console.log(`· ${t.database_name} ${f.name} 跑过了，跳过`)
          continue
        }
      }
      const sql = fs.readFileSync(f.path, 'utf8')
      const stmts = splitStatements(sql)
      let ok = true
      for (const s of stmts) {
        const rr = wrangler(t.database_name, s, backendDir)
        if (rr.code === 0) continue
        if (isDuplicateColumnError(rr.text) || isAlreadyExistsError(rr.text)) continue // 幂等跳过
        console.error(`❌ ${t.database_name} ${f.name} 这条语句失败：${s.slice(0, 120)}\n${rr.text}`)
        ok = false
        break
      }
      if (!ok) { failed++; continue }
      const ins = wrangler(t.database_name, `INSERT OR IGNORE INTO migrations (name, applied_at) VALUES ('${esc}', datetime('now'))`, backendDir)
      if (ins.code !== 0) {
        console.error(`❌ ${t.database_name} 记 migrations 失败：${ins.text}`)
        failed++
        continue
      }
      console.log(`✅ ${t.database_name} ${f.name} 跑完了`)
    }
  }
  if (failed) {
    console.error(`❌ 迁移有 ${failed} 处没跑成功`)
    process.exit(1)
  }
  console.log('✅ 迁移全部跑完')
}

if (import.meta.main) main()
