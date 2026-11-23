// 加一本账（最多 9 本）：node scripts/book-add.mjs [--book 4] [--yes] [--no-schema]
//
// 为什么需要它：
//   代码从第 10 轮起就按「绑定枚举」认账套（bookDbs()，BOOK_MAX=9），本机版也真的建 9 本；
//   但**线上只有 3 个 D1 绑定**（wrangler.toml 里的 DB / DB2 / DB3），
//   所以小程序里第 4 本账根本不出现 —— 想开一家新厂，得手工做三步：
//     npx wrangler d1 create factory-db4
//     把返回的 database_id 抄进 wrangler.toml
//     npx wrangler d1 execute factory-db4 --remote --file=schema.sql
//   抄漏一位、忘了灌表结构、绑定名写错（DB4 写成 db4）都会变成「切过去一片 500」，
//   而且现场没人看得出是哪一步错的。这个脚本把三步合成一条命令，并且**不抄错**。
//
// 不传 --yes 只打印计划（不建库、不改文件），可以先看清楚再真跑。
// 只用 Node 内置模块 + backend 里的 wrangler，不装新依赖。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readD1Bindings } from './d1-migrate.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const BACKEND = path.join(ROOT, 'backend')
const TOML = path.join(BACKEND, 'wrangler.toml')
const SCHEMA = path.join(BACKEND, 'schema.sql')
const INDEX = path.join(BACKEND, 'index.js')

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1]
  return def
}
const has = (name) => process.argv.includes('--' + name)

const yes = has('yes')
const noSchema = has('no-schema')
const wantBook = Number(arg('book', '') || 0)

if (!fs.existsSync(TOML) || !fs.existsSync(SCHEMA)) {
  console.error('❌ 找不到 backend/wrangler.toml 或 backend/schema.sql（在仓库根目录跑）')
  process.exit(1)
}

// 账套上限以代码里的 BOOK_MAX 为准：wrangler.toml 里多写了绑定、代码不认也白搭
const idxSrc = fs.readFileSync(INDEX, 'utf8')
const maxMatch = idxSrc.match(/const\s+BOOK_MAX\s*=\s*(\d+)/)
const BOOK_MAX = maxMatch ? Number(maxMatch[1]) : 9

const bindings = readD1Bindings(TOML)
// 绑定名 → 账套号：DB 是第 1 本，DB2…DB9 是第 N 本
function bookOf(binding) {
  const m = String(binding || '').match(/^DB(\d*)$/i)
  if (!m) return 0
  return m[1] ? Number(m[1]) : 1
}
const used = new Map()
for (const b of bindings) {
  const n = bookOf(b.binding)
  if (n >= 1 && n <= BOOK_MAX) used.set(n, b)
}

console.log('账套上限（backend/index.js 的 BOOK_MAX）：' + BOOK_MAX)
console.log('现在线上绑了 ' + bindings.length + ' 本：')
for (const [n, b] of [...used.entries()].sort((a, b2) => a[0] - b2[0])) {
  console.log('  第 ' + n + ' 本  ' + b.binding + '  ' + b.database_name + '  ' + b.database_id)
}
const free = []
for (let n = 1; n <= BOOK_MAX; n++) if (!used.has(n)) free.push(n)
if (!free.length) {
  console.log('')
  console.log('✅ 已经绑满 ' + BOOK_MAX + ' 本，不用再加（再多就要先改代码里的 BOOK_MAX）')
  process.exit(0)
}
const target = wantBook || free[0]
if (target < 1 || target > BOOK_MAX) {
  console.error('❌ --book 只能填 1–' + BOOK_MAX)
  process.exit(1)
}
if (used.has(target)) {
  const b = used.get(target)
  console.error('❌ 第 ' + target + ' 本已经有了（' + b.binding + ' → ' + b.database_name + '），换一个号：' + free.join(' / '))
  process.exit(1)
}

const binding = target === 1 ? 'DB' : 'DB' + target
const dbName = target === 1 ? 'factory-db' : 'factory-db' + target
const block = [
  '',
  '# 第 ' + target + ' 本账（scripts/book-add.mjs 生成）',
  '[[d1_databases]]',
  'binding = "' + binding + '"',
  'database_name = "' + dbName + '"',
  'database_id = "请填入 scripts/book-add.mjs 输出里给出的 id"',
  '',
].join('\n')

if (!yes) {
  console.log('')
  console.log('下一步会做（第 ' + target + ' 本，现在还什么都没做）：')
  console.log('  1) npx wrangler d1 create ' + dbName + '        # 建库，返回 database_id')
  console.log('  2) 把这段追加到 backend/wrangler.toml 末尾：')
  console.log(block.split('\n').map((l) => '       ' + l).join('\n'))
  if (!noSchema) console.log('  3) npx wrangler d1 execute ' + dbName + ' --remote --file=schema.sql   # 灌表结构，否则切过去一片 500')
  console.log('  4) git add backend/wrangler.toml && git commit && git push   # CI 部署后小程序里就有第 ' + target + ' 本了')
  console.log('')
  console.log('确认无误就加 --yes 真跑：node scripts/book-add.mjs --book ' + target + ' --yes')
  process.exit(0)
}

// ── 真跑 ──
console.log('')
console.log('▶ 建库 ' + dbName + ' …')
const cr = spawnSync('npx', ['wrangler', 'd1', 'create', dbName], {
  cwd: BACKEND, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000,
})
const crOut = String(cr.stdout || '') + String(cr.stderr || '')
if (cr.status !== 0) {
  console.error('❌ 建库失败（wrangler 退出码 ' + cr.status + '）：')
  console.error(crOut.trim().split('\n').slice(-12).join('\n'))
  console.error('')
  console.error('常见原因：没登录（npx wrangler login）／没有 CLOUDFLARE_API_TOKEN／同名库已存在（去控制台删掉旧的再跑）')
  process.exit(1)
}
const idm = crOut.match(/database_id\s*=\s*"([0-9a-f-]{36})"/i) || crOut.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
if (!idm) {
  console.error('❌ 库建了但没从输出里认出 database_id，别手工猜 —— 把下面这段发给我：')
  console.error(crOut.trim().split('\n').slice(-15).join('\n'))
  process.exit(1)
}
const dbId = idm[1]
console.log('✅ 库建好：' + dbName + '  ' + dbId)

// 写回 wrangler.toml（先备份，写坏了能立刻回退）
const before = fs.readFileSync(TOML, 'utf8')
if (before.indexOf('database_name = "' + dbName + '"') >= 0) {
  console.error('❌ wrangler.toml 里已经有 ' + dbName + ' 了，没动文件（避免写重）')
  process.exit(1)
}
const filled = block.replace('请填入 scripts/book-add.mjs 输出里给出的 id', dbId)
fs.writeFileSync(TOML, before.replace(/\s*$/, '\n') + filled, 'utf8')
console.log('✅ backend/wrangler.toml 已加第 ' + target + ' 本绑定（' + binding + '）')

if (!noSchema) {
  console.log('▶ 灌表结构 ' + dbName + ' …')
  const ex = spawnSync('npx', ['wrangler', 'd1', 'execute', dbName, '--remote', '--file=' + SCHEMA], {
    cwd: BACKEND, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000,
  })
  const exOut = String(ex.stdout || '') + String(ex.stderr || '')
  // schema.sql 全是 IF NOT EXISTS，重复跑正常；只把真错误当失败
  const hardFail = ex.status !== 0 && !/already exists/i.test(exOut)
  if (hardFail) {
    console.error('❌ 表结构没灌进去：')
    console.error(exOut.trim().split('\n').slice(-12).join('\n'))
    console.error('')
    console.error('绑定已经写进 wrangler.toml 了，先别部署；把上面这段发给我，或手工重跑：')
    console.error('  cd backend && npx wrangler d1 execute ' + dbName + ' --remote --file=schema.sql')
    process.exit(1)
  }
  console.log('✅ 表结构灌好了（' + dbName + '）')
}

console.log('')
console.log('收尾两步（手工）：')
console.log('  1) git add backend/wrangler.toml && git commit -m "加第 ' + target + ' 本账" && git push')
console.log('  2) 等 CI 部署完成；小程序「设置 → 账套切换」里会出现第 ' + target + ' 本，第一次进去先设口令')
console.log('     （CI 会给远程库补表结构 + 跑迁移，不用再手工灌）')
