#!/usr/bin/env node
// 上线前自检（不联网、不改数据）：node scripts/check.mjs
// 起因：README 里记过的几个坑全是「机器一秒能看出来、但当时没人看」——路由重名被顶掉、
// reconRate 双重计数、loadHealth 定义了两次首页分数条一直不渲染、按 schema.sql 新装建不出表。
// 这里把这些都变成一条命令，CI 里先跑它，红了就别部署。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const BE = path.join(ROOT, 'backend/index.js')
const SCHEMA = path.join(ROOT, 'backend/schema.sql')
const FE = path.join(ROOT, 'frontend/pages/index/index.js')
const WXML = path.join(ROOT, 'frontend/pages/index/index.wxml')

const bad = []   // 必须修，修了才能部署
const warn = []  // 知道了但先不动
const fail = (msg) => { bad.push(msg); console.log(`  ❌ ${msg}`) }
const say = (ok, okMsg, badMsg) => {
  if (ok) return console.log(`  ✅ ${okMsg}`)
  const m = badMsg || okMsg
  bad.push(m)
  console.log(`  ❌ ${m}`)
}

const beSrc = fs.readFileSync(BE, 'utf8')
const schemaSrc = fs.readFileSync(SCHEMA, 'utf8')
const feSrc = fs.readFileSync(FE, 'utf8')
const wxmlSrc = fs.readFileSync(WXML, 'utf8')

// ── 1. 语法能不能过 ──
console.log('\n[1] 语法')
for (const f of [BE, FE]) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' })
  say(r.status === 0, `${path.relative(ROOT, f)} 能解析`, `${path.relative(ROOT, f)} 语法过不去：` + (r.stderr || '').split('\n').filter(Boolean).slice(0, 3).join(' '))
}

// ── 2. 路由重名（Hono 后注册的会顶掉先注册的，表现是新功能"没生效"）──
console.log('\n[2] 后台路由')
const routes = []
for (const m of beSrc.matchAll(/\bapp\.(get|post|patch|delete|put)\(\s*'([^']+)'/g)) routes.push({ m: m[1].toUpperCase(), p: m[2] })
const seen = new Map()
for (const r of routes) {
  const k = r.m + ' ' + r.p
  if (seen.has(k)) fail(`路由重名：${k}（注册了两次，后一条会顶掉前一条）`)
  seen.set(k, 1)
}
say(bad.filter((x) => x.startsWith('路由重名')).length === 0, `${routes.length} 条路由，没有重名`)

// ── 2.5 「await 一个不存在的变量」：ReferenceError 的典型写法，接口整个 500 ──
// 这一类事故真实发生过：`const pb = await pbP` 让「客户信用」整页 500，访问向导里抄来一句
// `if (labor > 0)` 让使用向导 500。注意这个静态检查的边界：
//   只抓「整个文件里都没声明过」的变量（纯手滑打错名字那种）；
//   变量在别处声明、只是这里拿不到的（就是上面那两例）静态看不出来 —— 那种由 scripts/smoke.mjs
//   逐个接口打一遍来抓，所以 CI 里两步都要跑。
// 扫之前先把行尾 // 注释去掉，免得文档里写一句 `await xxx` 就把构建搞红。
console.log('\n[2.5] await 未声明的变量')
const declNames = new Set()
for (const m of beSrc.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declNames.add(m[1])
for (const m of beSrc.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) declNames.add(m[1])
for (const m of beSrc.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
  for (const f of m[1].split(',')) {
    const n = f.split(':').pop().trim()
    if (/^[A-Za-z_$][\w$]*$/.test(n)) declNames.add(n)
  }
}
for (const m of beSrc.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]\s*=/g)) {
  for (const f of m[1].split(',')) {
    const n = f.trim()
    if (/^[A-Za-z_$][\w$]*$/.test(n)) declNames.add(n)
  }
}
const JS_WORDS = new Set(['new', 'this', 'typeof', 'void', 'delete', 'await', 'async', 'super', 'import', 'yield'])
const orphanAwaits = []
beSrc.split('\n').forEach((rawLine, i) => {
  // 去掉行尾注释（只认「空白 + //」开头的，别把 'https://…' 截了）
  const line = rawLine.replace(/(^|\s)\/\/.*$/, '')
  for (const m of line.matchAll(/await\s+([A-Za-z_$][\w$]*)(?![A-Za-z0-9_$])\s*(?![.(])/g)) {
    if (JS_WORDS.has(m[1]) || declNames.has(m[1])) continue
    orphanAwaits.push(`第 ${i + 1} 行：await ${m[1]} —— 全文没有声明过这个变量，运行时必然 ReferenceError`)
  }
})
for (const o of orphanAwaits) fail(o)
say(orphanAwaits.length === 0, '没有「await 一个没声明过的变量」这种必崩写法')

// ── 3. schema.sql 按新库能不能一次建起来（新装唯一入口，坏了等于装不上）──
console.log('\n[3] schema.sql 新装')
let db = null
try {
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  db.exec(schemaSrc)
  const n = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().c
  say(true, `新库能建出 ${n} 张表`)
} catch (e) {
  if (db) { say(false, 'schema.sql 能一次建起新库', `schema.sql 按新库执行失败：${e.message}（照 README 新装会卡在这里）`); db = null }
  else {
    // 以前这里只 warn 一句就跳过：等于「建库检查」这一步永远绿。
    // 没跑过就是没验过，必须红 —— CI 用 Node 24，本地缺就是环境不对。
    fail('本机 node 没有 node:sqlite（要 Node 22+，CI 用 24），建库检查没法跑')
  }
}

// ── 4. 代码要用的表和列，schema 里得有（线上是老库所以不报错，新装就空）──
console.log('\n[4] 表结构')
const declared = new Map() // 表 -> Set(列)
for (const m of schemaSrc.replace(/--[^\n]*/g, '').matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\);/g)) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of m[2]) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(cur); cur = '' } else cur += ch
  }
  parts.push(cur)
  const cols = parts.map((s) => s.trim().split(/\s+/)[0]).filter((c) => c && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(c))
  declared.set(m[1], new Set([...(declared.get(m[1]) || []), ...cols]))
}
// 运行时兜底建的表（ensureBaseTables 里那批）也算已声明
for (const m of beSrc.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)) if (!declared.has(m[1])) declared.set(m[1], new Set())

const need = new Map()
for (const m of beSrc.matchAll(/INSERT INTO\s+(\w+)\s*\(([^)]*)\)/g)) {
  const t = m[1]
  const cols = m[2].split(',').map((s) => s.trim().replace(/['"`]/g, '')).filter((c) => /^[a-z_][a-z0-9_]*$/i.test(c))
  if (!need.has(t)) need.set(t, new Set())
  for (const c of cols) need.get(t).add(c)
}
let schemaBad = 0
for (const [t, cols] of need) {
  if (!declared.has(t)) { fail(`表 ${t}：代码在往里写，但 schema.sql 没有建表语句（新装这个功能直接空）`); schemaBad++; continue }
  const miss = [...cols].filter((c) => !declared.get(t).has(c))
  if (miss.length) { fail(`表 ${t} 缺列：${miss.join(', ')}（代码写入会报 no such column）`); schemaBad++ }
}
if (db) for (const [t, cols] of need) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)) continue
  const real = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name))
  const miss = [...cols].filter((c) => !real.has(c))
  if (miss.length) { fail(`表 ${t} 建出来后缺列：${miss.join(', ')}`); schemaBad++ }
}
say(schemaBad === 0, `${declared.size} 张表声明完整，代码写入的列都在`, `表结构有 ${schemaBad} 处问题（见上面逐条）`)

// ── 4.5 代码里写死的 SQL，拿来真跑一遍（prepare 就会报 no such column / no such table）──
console.log('\n[4.5] SQL 语句')
if (db) {
  const sqls = new Set()
  const grab = (re) => { for (const m of beSrc.matchAll(re)) sqls.add(m[2]) }
  grab(/(['"`])((?:SELECT|WITH|INSERT INTO|UPDATE|DELETE FROM)[^'"`]{10,}?)\1/gs)
  let sqlBad = 0
  let checked = 0
  for (const q of sqls) {
    if (q.includes('${') || /\?\s*\|\||\\n/.test(q)) continue
    try { db.prepare(q); checked++ } catch (e) {
      if (/incomplete input/i.test(e.message)) continue // 字符串拼一半的残句（'... WHERE ' + x），本来就不完整
      if (/no such (column|table)|syntax error/i.test(e.message) && !/near "\$|unrecognized token/.test(e.message)) {
        // 动态拼接的残句（如 'UPDATE ' + tbl + ' SET ...'）本来就不完整，跳过
        if (/^UPDATE\s*$|^INSERT INTO\s*$|^DELETE FROM\s*$|^SELECT\s*$/.test(q.trim())) continue
        fail(`SQL 跑不通（${e.message}）：${q.replace(/\s+/g, ' ').slice(0, 110)}`)
        sqlBad++
      }
    }
  }
  say(sqlBad === 0, `${checked} 条写死的 SQL 都能在真库上 prepare 通过`, `有 ${sqlBad} 条 SQL 在真库上跑不通`)
} else console.log('  ⚠️ 没有 node:sqlite，SQL 检查没法跑（上面已经记了一条失败）')

// ── 4.6 /schema-check 自己列的那份「必须有」清单，schema.sql 得对得上 ──
const reqBlock = beSrc.match(/const REQ_SCHEMA = \{([\s\S]*?)\n\}/)
if (reqBlock) {
  const req = {}
  for (const m of reqBlock[1].matchAll(/(\w+)\s*:\s*\[([^\]]*)\]/g)) {
    req[m[1]] = m[2].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean)
  }
  let miss = 0
  for (const [t, cols] of Object.entries(req)) {
    const have = declared.get(t)
    if (!have) { fail(`/schema-check 要求表 ${t}，schema.sql 里没有`); miss++; continue }
    const gap = cols.filter((c) => !have.has(c))
    if (gap.length) { fail(`/schema-check 要求 ${t}.${gap.join('/')}，schema.sql 没建这一列`); miss++ }
  }
  say(miss === 0, `/schema-check 列的 ${Object.keys(req).length} 张表要求，schema.sql 都对得上`, `和 /schema-check 的要求有 ${miss} 处不一致`)
}

// ── 5. 前端调的接口，后台有没有 ──
console.log('\n[5] 前端调后台')
const norm = (p) => p.split('?')[0].replace(/\$\{[^}]*\}/g, ':x').replace(/\/\d+/g, '/:x').replace(/\/$/, '') || '/'
const routeSet = new Set(routes.map((r) => norm(r.p)))
const calls = new Set()
for (const m of feSrc.matchAll(/API_BASE\s*\+\s*'([^']+)'/g)) calls.add(norm(m[1]))
for (const m of feSrc.matchAll(/API_BASE\s*\+\s*`([^`]+)`/g)) calls.add(norm(m[1]))
const dead = [...calls].filter((p) => !routeSet.has(p) && p !== '/')
// 逐段前缀匹配：/orders/:x/receipt 这种动态拼的，只要前缀族存在就算过
const familyOk = (p) => [...routeSet].some((r) => r.startsWith(p) || p.startsWith(r.split('/:x')[0] + '/'))
const really = dead.filter((p) => !familyOk(p))
// 以前这里只 warn：「前端调了后台没有的路由」在 CI 里是黄的，没人管。
// 这类问题的真实后果就是点一下报「url 不合法」—— 直接算失败。
for (const p of really) fail(`前端调了 ${p}，后台没有这个路由（真机上点一下就是 404 / url 不合法）`)
if (dead.length && !really.length) warn.push(`这 ${dead.length} 个前端路径没直接命中路由、但前缀族对得上（动态拼的）：${dead.join('、')}`)
say(true, `${calls.size} 个前端调用，${dead.length} 个没直接命中（${really.length} 个需要人工看）`)

// ── 6. 页面绑定和方法重名（README 227/229 两个 bug 都出在这）──
console.log('\n[6] 页面绑定')
const dupFn = []
const fnSeen = new Set()
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try'])
for (const m of feSrc.matchAll(/^\s{0,4}(?:async\s+)?([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) {
  if (KEYWORDS.has(m[1])) continue
  if (fnSeen.has(m[1])) dupFn.push(m[1])
  fnSeen.add(m[1])
}
say(dupFn.length === 0, '页面方法没有重名', `页面方法重名：${[...new Set(dupFn)].join(', ')}（后定义的会顶掉先定义的）`)
const bound = new Set()
for (const m of wxmlSrc.matchAll(/\b(?:bind|catch)[a-zA-Z]*\s*=\s*"([a-zA-Z_$][\w$]*)"/g)) bound.add(m[1])
const missingFn = [...bound].filter((n) => !new RegExp(`\\b${n}\\s*\\(`).test(feSrc))
say(missingFn.length === 0, `${bound.size} 个页面绑定都有对应方法`, `wxml 绑了、js 里没有的方法：${missingFn.slice(0, 10).join(', ')}`)

// ── 收尾 ──
if (warn.length) { console.log('\n⚠️ 提醒（不拦）：'); for (const w of warn) console.log('   · ' + w) }
if (bad.length) { console.log(`\n❌ 有 ${bad.length} 个问题，修完再部署\n`); process.exit(1) }
console.log('\n✅ 自检通过\n')
