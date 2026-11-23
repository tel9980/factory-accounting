// 给远程 D1 补表结构：node scripts/d1-seed-schema.mjs [--db factory-db3] [--dry]
//
// 为什么需要它：
//   backend/schema.sql 里全是 `CREATE ... IF NOT EXISTS`，可以在**有数据的库上重复跑**，
//   一个字段都不会丢。但线上是「每本账一个独立 D1」，新开一本账（或第 3 本演示账）如果
//   没人手动灌过 schema，那本账就是空库：
//     · 切过去首页一片 500；
//     · 演示口令进去会 503「演示账套还没准备好」 —— **微信审核员正好会撞上这个**。
//   所以部署时统一补一次，幂等、便宜。
//
// 只补表结构，不写任何种子数据（schema.sql 里本来就没有 INSERT）。
// 库名从 backend/wrangler.toml 的 [[d1_databases]] 里读，不写死。
//
// 只用 Node 内置模块 + 后端目录里的 wrangler，不装新依赖。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readD1Bindings } from './d1-migrate.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const BACKEND = path.join(ROOT, 'backend')
const SCHEMA = path.join(BACKEND, 'schema.sql')

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return def
}
const has = (name) => process.argv.includes('--' + name)

const only = arg('db', '')
const dry = has('dry')

if (!fs.existsSync(SCHEMA)) {
  console.error('❌ 找不到 ' + SCHEMA)
  process.exit(1)
}
const bindings = readD1Bindings(path.join(BACKEND, 'wrangler.toml'))
// 第 13 轮 E9：--db 以前只认 database_name，而 scripts/d1-migrate.mjs 同时认 binding ——
// 同一个参数在两个脚本里行为不同，照 A 脚本的习惯用 B 脚本就「找不到库」。
// 现在两处都按「database_name 或 binding」匹配。
const targets = only ? bindings.filter((b) => b.database_name === only || b.binding === only) : bindings
if (!targets.length) {
  console.error('❌ wrangler.toml 里没有' + (only ? '名为 ' + only + ' 的' : '任何') + ' d1 绑定')
  process.exit(1)
}

const okNames = []
const failed = []
for (const b of targets) {
  const label = b.database_name + '（' + b.binding + '）'
  if (dry) { console.log('· 会补 ' + label); okNames.push(b.database_name); continue }
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', b.database_name, '--remote', '--file=' + SCHEMA], {
    cwd: BACKEND, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    // 第 11 轮 F3：以前没超时。wrangler 卡在网络上时这一步会一直挂着，整个 job 被拖到 6 小时上限。
    timeout: 180000,
  })
  const out = String(r.stdout || '') + String(r.stderr || '')
  if (r.status === 0) {
    console.log('✅ ' + label + ' 表结构已补齐')
    okNames.push(b.database_name)
  } else {
    // 第 11 轮 F3：以前「输出里出现过 already exists」就整条当成功 ——
    // 一条无关的重名错误会把「别的表根本没建」一起盖住，演示账没表也是绿的。
    // 现在逐行看：每一行报错都必须是「已经存在」，只要有一行是别的原因就算失败。
    const errLines = out.split('\n').map((x) => x.trim()).filter((x) => /error|错误|failed/i.test(x))
    const realErr = errLines.filter((x) => !/already exists|已存在/i.test(x))
    if (r.error && r.error.code === 'ETIMEDOUT') {
      console.log('❌ ' + label + ' 超时（180 秒没跑完）')
      failed.push(b.database_name)
    } else if (!realErr.length && errLines.length) {
      console.log('✅ ' + label + ' 表结构已是最新（' + errLines.length + ' 条「已存在」被跳过）')
      okNames.push(b.database_name)
    } else {
      console.log('❌ ' + label + ' 补表结构失败')
      console.log((realErr.length ? realErr : out.split('\n')).slice(-12).join('\n'))
      failed.push(b.database_name)
    }
  }
}

console.log('')
console.log(`[d1-seed-schema] 成功 ${okNames.length} 本${failed.length ? '，失败 ' + failed.length + ' 本：' + failed.join(', ') : ''}`)
// 失败要红：演示账（第 3 本）没表结构 = 审核员点「先看看演示」就 503
process.exit(failed.length ? 1 : 0)
