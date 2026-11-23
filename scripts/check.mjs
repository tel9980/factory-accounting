#!/usr/bin/env node
// 上线前自检（不联网、不改数据）：node scripts/check.mjs
// 起因：README 里记过的几个坑全是「机器一秒能看出来、但当时没人看」——路由重名被顶掉、
// reconRate 双重计数、loadHealth 定义了两次首页分数条一直不渲染、按 schema.sql 新装建不出表。
// 这里把这些都变成一条命令，CI 里先跑它，红了就别部署。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { extractRoutes, scanScriptUsage, uncoveredWrites } from './_route-usage.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const BE = path.join(ROOT, 'backend/index.js')
const SCHEMA = path.join(ROOT, 'backend/schema.sql')
const FE = path.join(ROOT, 'frontend/pages/index/index.js')
const WXML = path.join(ROOT, 'frontend/pages/index/index.wxml')
// 本机版（免安装 exe / Docker 镜像）的入口：同一份 backend/index.js 换成本机 SQLite 跑
const SERVER = ['server/main.mjs', 'server/d1.mjs'].map((f) => path.join(ROOT, f))

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
for (const f of [BE, FE, ...SERVER]) {
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

// [2.6] 双引号/单引号字符串里写 ${} —— 只有模板串（反引号）才会替换，普通字符串会原封不动
// 交给 SQLite，报 unrecognized token: "$"。这坑真踩过：monthSnapshot 里那句
// "… WHERE ${CASH_EXP_WHERE} AND month=?" 一调 /month-archive 就 500。
function dollarInQuotes(src) {
  const out = []
  let i = 0
  let line = 1
  let inTpl = 0
  let lineC = false
  let blockC = false
  while (i < src.length) {
    const ch = src[i]
    const nx = src[i + 1]
    if (ch === '\n') { line += 1; lineC = false; i += 1; continue }
    if (lineC) { i += 1; continue }
    if (blockC) { if (ch === '*' && nx === '/') { blockC = false; i += 2 } else i += 1; continue }
    if (inTpl > 0) {
      if (ch === '\\') { i += 2; continue }
      if (ch === '`') { inTpl -= 1; i += 1; continue }
      i += 1
      continue
    }
    if (ch === '/' && nx === '/') { lineC = true; i += 2; continue }
    if (ch === '/' && nx === '*') { blockC = true; i += 2; continue }
    if (ch === '`') { inTpl += 1; i += 1; continue }
    if (ch === '"' || ch === "'") {
      const q = ch
      let j = i + 1
      let hit = false
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === '\n') break
        if (src[j] === '$' && src[j + 1] === '{') hit = true
        if (src[j] === q) break
        j += 1
      }
      const lit = src.slice(i, j + 1)
      // `"${x}"` 这种「给列名加引号」是故意的，不算
      const identOnly = /^["']\$\{[A-Za-z_$][\w$.]*\}["']$/.test(lit)
      if (hit && !identOnly) out.push(`${line}: ${src.slice(i, Math.min(j + 1, i + 90))}`)
      i = j + 1
      continue
    }
    i += 1
  }
  return out
}
{
  const bad2 = []
  for (const [f, src] of [[BE, beSrc], [FE, feSrc]]) {
    for (const x of dollarInQuotes(src)) bad2.push(`${path.relative(ROOT, f)} 第 ${x}`)
  }
  for (const x of bad2) fail('把 ${} 写进了普通字符串（只有反引号才替换）：' + x)
  say(bad2.length === 0, '没有把 ${} 写进普通字符串')
}

// [2.7] 页面 data 里不许有重复的顶层键 —— 重复声明时后一个把前一个悄悄覆盖掉，
// 表现是「界面上某个开关点了没反应」「同一块数据一会儿是布尔一会儿是对象」。
// 这坑真踩过：data 里同时有 `mg: null`（合并结算用）和 `mg: false`（老账搬家面板用），
// 后者赢了，于是搬家面板的 wx:if="{{mg}}" 永远是 false。
{
  const src = fs.readFileSync(FE, 'utf8')
  const at = src.indexOf('  data: {')
  const start = at < 0 ? -1 : src.indexOf('{', at)
  const dups = []
  if (start >= 0) {
    let depthBrace = 0
    let endB = -1
    for (let k = start; k < src.length; k += 1) {
      if (src[k] === '{') depthBrace += 1
      else if (src[k] === '}') { depthBrace -= 1; if (depthBrace === 0) { endB = k; break } }
    }
    const body = src.slice(start + 1, endB)
    let depth = 0
    let quote = null
    const seen = new Set()
    for (let k = 0; k < body.length; k += 1) {
      const c = body[k]
      if (quote) {
        if (c === '\\') { k += 1; continue }
        if (c === quote) quote = null
        continue
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue }
      if ('{[('.includes(c)) { depth += 1; continue }
      if ('}])'.includes(c)) { depth -= 1; continue }
      if (depth === 0 && /[A-Za-z_$]/.test(c) && (k === 0 || /[,\s{]/.test(body[k - 1]))) {
        const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(k, k + 60))
        if (m) {
          if (seen.has(m[1])) dups.push(m[1])
          else seen.add(m[1])
        }
      }
    }
  }
  for (const d of dups) fail(`页面 data 里「${d}」声明了两遍，后一个会把前一个覆盖掉`)
  say(dups.length === 0, '页面 data 没有重复的顶层键')
}

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
const colMeta = new Map() // 表 -> Map(列 -> {type,notnull,dflt})
for (const m of schemaSrc.replace(/--[^\n]*/g, '').matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\);/g)) {
  // 第 12 轮 F3：切列定义要躲开单引号字符串里的逗号，否则
  // `modules TEXT DEFAULT 'ar,ap,exp,…'` 会被切成 ap/exp 等假列，
  // 数据库里凭空多出几列，check 和 baseline 一起错所以一直绿。
  // 复用 server/d1.mjs completeColumns 的同一套逻辑（引号 + 括号 + 注释）。
  const parts = []
  let depth = 0
  let cur = ''
  let quote = false
  for (const ch of m[2]) {
    if (quote) { cur += ch; if (ch === "'") quote = false; continue }
    if (ch === "'") { quote = true; cur += ch; continue }
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue }
    cur += ch
  }
  parts.push(cur)
  const cols = []
  const meta = colMeta.get(m[1]) || new Map()
  for (const raw of parts) {
    const s = raw.trim()
    if (!s) continue
    const name = (s.match(/^([A-Za-z_][\w]*)/) || [])[1]
    if (!name) continue
    const low = s.toLowerCase()
    if (low.startsWith('primary ') || low.startsWith('unique') || low.startsWith('foreign') || low.startsWith('check') || low.startsWith('constraint')) continue
    cols.push(name)
    const type = (s.match(/^[A-Za-z_][\w]*\s+([A-Za-z]+)/) || [])[1] || ''
    const notnull = /\bNOT\s+NULL\b/i.test(s) ? 1 : 0
    const dm = s.match(/DEFAULT\s+('([^']*)'|[^\s,]+)/i)
    const dflt = dm ? dm[1] : ''
    meta.set(name, { type, notnull, dflt })
  }
  colMeta.set(m[1], meta)
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

// ── 4.7 老库补列清单（EXTRA_COLS）必须有、且不许 drift ──
// 线上 D1 是老库：schema.sql 里全是 CREATE TABLE IF NOT EXISTS，表已经在了就整句跳过，
// 于是「后来加的列」永远补不上，代码一查就 no such column → 整个接口 500。
// 补列靠 backend/index.js 里的 EXTRA_COLS（本机版还有 server/d1.mjs 按 schema 自动补）。
// 所以：schema.sql 里**新增**的列必须同时进 EXTRA_COLS，否则老库永远醒不过来。
// 基线文件 scripts/schema-baseline.json 记着「发布过的列」，新列不在基线里就会被查出来。
{
  const blk = beSrc.match(/const EXTRA_COLS = \{([\s\S]*?)\n\}/)
  const extras = new Map() // 表 -> Set(列)
  if (blk) {
    for (const m of blk[1].matchAll(/^\s{2}(\w+):\s*\[([\s\S]*?)\]\s*[,}]?\s*$/gm)) {
      const cols = new Set([...m[2].matchAll(/'([a-z_][a-z0-9_]*)'\s*,/gi)].map((x) => x[1]))
      extras.set(m[1], cols)
    }
  }
  // backend/migrations/*.sql 里 ALTER TABLE xxx ADD COLUMN yyy —— 这些列由迁移补，不算漏。
  const migCols = new Set()
  {
    const migDir = path.join(ROOT, 'backend/migrations')
    if (fs.existsSync(migDir)) {
      for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql'))) {
        const ms = fs.readFileSync(path.join(migDir, f), 'utf8')
        for (const m of ms.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/gi)) migCols.add(m[1] + '.' + m[2])
      }
    }
  }
  let bad47 = 0
  if (!blk) { fail('找不到 EXTRA_COLS（老库补列清单），老库升级会缺列'); bad47++ }
  for (const [t, cols] of extras) {
    if (!declared.has(t)) { fail(`EXTRA_COLS 里的表 ${t} 在 schema.sql 里不存在`); bad47++; continue }
    const ghost = [...cols].filter((c) => !declared.get(t).has(c))
    if (ghost.length) { fail(`EXTRA_COLS 给 ${t} 补的列 schema.sql 里没有：${ghost.join(', ')}（新库也会缺，一查就 500）`); bad47++ }
  }
  // 基线对比：现在的列 - 基线里的列 = 这次新加的，必须已经在 EXTRA_COLS 里
  const baselineFile = path.join(ROOT, 'scripts/schema-baseline.json')
  const snapshot = {}
  // 第 12 轮 F3：snapshot 升级为带类型/默认值的对象，不再只存列名。
  for (const [t, cols] of declared) if (cols.size) {
    const meta = colMeta.get(t) || new Map()
    snapshot[t] = [...cols].sort().map((c) => Object.assign({ name: c }, meta.get(c) || { type: '', notnull: 0, dflt: '' }))
  }
  const wantWrite = process.argv.includes('--update-baseline')
  if (wantWrite) {
    fs.writeFileSync(baselineFile, JSON.stringify(snapshot, null, 2) + '\n')
    console.log('  📝 已把当前列结构（含类型/默认值）写进 scripts/schema-baseline.json（下次发布后的新列才算「新增」）')
  } else if (!fs.existsSync(baselineFile)) {
    warn.push('没有 scripts/schema-baseline.json，老库补列 drift 查不了（跑 node scripts/check.mjs --update-baseline 生成）')
  } else {
    const base = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
    // 兼容老格式（base[t] 是字符串数组）：升级成对象数组
    const normBase = {}
    for (const [t, cols] of Object.entries(base)) {
      normBase[t] = (cols || []).map((c) => (typeof c === 'string' ? { name: c, type: '', notnull: 0, dflt: '' } : c))
    }
    // 第 12 轮 F3：类型等价的写法（SQLite 会规范化 VARCHAR→TEXT 等）放过，避免误红。
    const TYPE_EQ = ['TEXT', 'VARCHAR', 'CHAR', 'CLOB', 'STRING']
    const typeEq = (a, b) => {
      const na = String(a || '').toUpperCase(), nb = String(b || '').toUpperCase()
      if (!na || !nb) return true
      if (TYPE_EQ.includes(na) && TYPE_EQ.includes(nb)) return true
      return na === nb
    }
    for (const [t, colList] of Object.entries(snapshot)) {
      const old = normBase[t] || []
      if (!old.length) continue // 新表：整张表都不在老库，不需要逐列补
      const oldNames = new Set(old.map((c) => c.name))
      const fresh = colList.filter((c) => !oldNames.has(c.name)).map((c) => c.name)
      // 新列有两种合法的补法：
      //   ① 进 EXTRA_COLS（后端启动时补列）；
      //   ② 写进 backend/migrations/*.sql 的 ALTER TABLE ... ADD COLUMN（迁移时补）。
      // 只认 ① 会把走 ② 的列误报成「老库必 500」—— 迁移文件就是干这个的。
      const miss = fresh.filter((c) => !(extras.get(t) && extras.get(t).has(c)) && !migCols.has(t + '.' + c))
      if (miss.length) {
        fail(`表 ${t} 新加的列没进 EXTRA_COLS 也没有迁移补：${miss.join(', ')}（老库升级后一查就 500；补进 EXTRA_COLS 或 backend/migrations/*.sql 再跑 --update-baseline）`)
        bad47++
      }
      // 第 12 轮 F3：列的类型/默认值变了也要查（以前只比列名，改类型/改默认永远发现不了）。
      for (const oc of old) {
        const now = colList.find((c) => c.name === oc.name)
        if (!now) continue
        if (oc.type && now.type && !typeEq(oc.type, now.type)) {
          fail(`表 ${t}.${oc.name} 类型变了：${oc.type} → ${now.type}（老库用旧类型，新库用新类型，同一份代码两台机器表现不一样；要么改回，要么确认无害后跑 --update-baseline）`)
          bad47++
        }
        if (String(oc.dflt || '') !== String(now.dflt || '')) {
          fail(`表 ${t}.${oc.name} 默认值变了：${oc.dflt || '(无)'} → ${now.dflt || '(无)'}（老库用旧默认，新库用新默认，新装的表初始值不同；确认无害后跑 --update-baseline）`)
          bad47++
        }
      }
    }
    // 反向对比：基线里有、现在 schema.sql 里没有的列 = 这列被删了。
    // 以前只算「新增」，删列永远发现不了 —— 老库还留着那列，新库没有，
    // 于是同一份代码在两台机器上表现不一样（新库一查就 500，老库正常）。
    // 现在双向都查：删列要么补回 schema.sql，要么确认「老库这列留着也无害」后跑 --update-baseline。
    for (const [t, oldCols] of Object.entries(normBase)) {
      const now = declared.get(t)
      if (!now) continue // 整张表删了：另说，不在列级检查范围
      const gone = (oldCols || []).map((c) => c.name).filter((c) => !now.has(c))
      if (gone.length) {
        fail(`表 ${t} 的列被删了但基线里还在：${gone.join(', ')}（老库还留着这几列，新库没有 → 同一份代码两台机器表现不一样）。要么把列加回 schema.sql，要么确认无害后跑 node scripts/check.mjs --update-baseline`)
        bad47++
      }
    }
  }
  say(bad47 === 0, `老库补列清单对得上（${extras.size} 张表有补列规则）`, `老库补列有 ${bad47} 处问题（见上）`)
}

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

// ── 4.8 账套不能写死 3 本（BOOK_MAX=9，写死 DB/DB2/DB3 会让第 4 本开始的功能静默失效）──
console.log('\n[4.8] 多账套')
{
  const hard = []
  // 允许 bookBindingName() 里那次字面量拼装（它就是按 DB+n 生成绑定名的），其余出现算写死。
  for (const m of beSrc.matchAll(/\b(?:all|c\.env\.ENV_ALL|envAll|ENV_ALL)\s*\.\s*(DB2|DB3)\b|\b(?:DB2|DB3)\s*:/g)) {
    const line = beSrc.slice(0, m.index).split('\n').length
    hard.push(line)
  }
  say(hard.length === 0, '账套入口没有写死 DB2/DB3（统一走 bookDbs()）', `backend/index.js 第 ${[...new Set(hard)].join('、')} 行写死了第二/第三本账`)
  // 白名单单一事实源：后端和权限测试必须都 import perm-rules.mjs，不能各存一份
  const permSrc = fs.readFileSync(path.join(ROOT, 'backend/perm-rules.mjs'), 'utf8')
  const permTest = fs.readFileSync(path.join(ROOT, 'scripts/test-perm.mjs'), 'utf8')
  say(permSrc.includes('export const STAFF_WRITE_OK') && beSrc.includes("from './perm-rules.mjs'") && permTest.includes("perm-rules.mjs"), '员工写接口白名单后端和测试共用一份', '员工写接口白名单出现第二份拷贝（改一处会漏另一处）')
}

// ── 4.9 文档里「总共几张表」跟 schema.sql 对齐（README/DEPLOYMENT 写死 57 就再也改不动）──
console.log('\n[4.9] 文档表数')
{
  // 期望值**自动推导**：数 backend/schema.sql 里真正建出来的表（不是手写清单），
  // 加表/删表以后这条断言自己就跟着变。
  const schemaTables = new Set()
  for (const m of schemaSrc.replace(/--[^\n]*/g, '').matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)) schemaTables.add(m[1])
  const expect = schemaTables.size

  // 扫描范围：README / DEPLOYMENT / Dockerfile / docker-compose / 所有 workflow / docs 下所有 md
  const scopeFiles = [
    'README.md', 'DEPLOYMENT.md', 'Dockerfile', 'docker-compose.yml',
    ...fs.readdirSync(path.join(ROOT, '.github/workflows')).filter((f) => f.endsWith('.yml')).map((f) => '.github/workflows/' + f),
    ...(fs.existsSync(path.join(ROOT, 'docs')) ? fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => 'docs/' + f) : []),
  ]
  // 只盯「新装时建几张表」这种当前口径的句子；编年史里「当时是 54/56/57 张」是历史记录，不拦。
  // 第 11 轮 F8：以前只认「建全/建库/自动建好/建出全部」，Dockerfile 里写的是
  // 「首次启动要建 60 张表」—— 句式不在名单里就永远检不到（数字刚好对才没暴露）。
  // 现在把「要建 / 创建」也算进来。
  const docChecks = [
    /建全\s*(\d+)\s*张表/g,
    /建库\s*(\d+)\s*张表/g,       // 「确认建库 N 张」也命中这条
    /自动建好\s*(\d+)\s*张表/g,
    /建出全部\s*(\d+)\s*张表/g,
    /要建\s*(\d+)\s*张表/g,
    /创建\s*(\d+)\s*张表/g,
  ]
  let bad9 = 0
  for (const rel of scopeFiles) {
    const abs = path.join(ROOT, rel)
    if (!fs.existsSync(abs)) continue
    const src = fs.readFileSync(abs, 'utf8')
    for (const re of docChecks) {
      for (const m of src.matchAll(re)) {
        const line = src.slice(0, m.index).split('\n').length
        if (Number(m[1]) !== expect) {
          fail(`${rel} 第 ${line} 行写「${m[1]} 张表」，但 schema.sql 实际建 ${expect} 张——加表/删表后记得改文档`)
          bad9++
        }
      }
    }
  }
  say(bad9 === 0, `${scopeFiles.length} 个文件里「建 N 张表」都和 schema.sql（${expect} 张）一致`)
}

// ── 4.12 老库升级：迁移文件能不能在「旧结构」的库上跑通（SQLite 没有 ADD COLUMN IF NOT EXISTS）──
console.log('\n[4.12] 迁移在老库上干跑')
{
  const migDir = path.join(ROOT, 'backend/migrations')
  const migFiles = fs.existsSync(migDir) ? fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort() : []
  if (!migFiles.length) {
    say(true, '没有迁移文件（不用干跑）')
  } else {
    const { listMigrations, splitStatements, runStatement } = await import('./migrations-lib.mjs')
    let err = null
    let addedCols = []
    const addColsSkipped = []
    const renamed = []
    try {
      const { DatabaseSync } = await import('node:sqlite')
      const old = new DatabaseSync(':memory:')
      old.exec(schemaSrc)
      // 模拟「老版本 schema」：把两列改名（老库里就没这些新列的名字）
      old.exec('ALTER TABLE orders RENAME COLUMN written_off TO old_written_off')
      old.exec('ALTER TABLE payables RENAME COLUMN written_off TO old_written_off')
      // 第 11 轮 F7：以前只模拟 orders/payables 的 written_off，
      // 0002 里那句 `ALTER TABLE writeoffs ADD COLUMN month` 其实是「新库里已经有这列」，
      // 干跑能过只是因为「重复列」被当成幂等跳过 —— 等于这条迁移从没被真跑过一次。
      // 现在把所有迁移里的 ADD COLUMN 都扒出来，能在不影响索引/触发器的前提下先改名，
      // 让它们真的走一遍「老库没这列」的路径。
      const addCols = []
      for (const f of listMigrations(migDir)) {
        const src0 = fs.readFileSync(f.path, 'utf8')
        for (const m of src0.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/gi)) {
          const t = m[1]; const col = m[2]
          if (t === 'orders' || t === 'payables') continue
          addCols.push({ t, col })
        }
      }
      for (const { t, col } of addCols) {
        try {
          old.exec(`ALTER TABLE ${t} RENAME COLUMN ${col} TO old_${col}`)
          renamed.push(t + '.' + col)
        } catch (e) {
          // 第 13 轮 E6：被索引引用时 SQLite 不许改名（writeoffs.month 就被 idx_writeoffs_m 挡着）。
          // 以前这时把列塞进 addColsSkipped，然后照样 say(!err) 打绿 —— 等于这条迁移
          // 从来没被真跑过一次（「新库本来就有这列」和「迁移能补上这列」是两回事）。
          // 现在先把挡路的索引删掉（模拟真正的老库：老库里连索引都还没有），再改名重试。
          let retried = false
          try {
            const idxs = old.prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=?`).all(t)
            for (const ix of idxs) {
              if (!ix.name || !ix.sql) continue
              if (!new RegExp('\\b' + col + '\\b').test(String(ix.sql))) continue
              old.exec(`DROP INDEX IF EXISTS ${ix.name}`)
            }
            old.exec(`ALTER TABLE ${t} RENAME COLUMN ${col} TO old_${col}`)
            renamed.push(t + '.' + col)
            retried = true
          } catch (e2) { retried = false }
          if (!retried) addColsSkipped.push(t + '.' + col)
        }
      }
      for (const f of listMigrations(migDir)) {
        for (const stmt of splitStatements(fs.readFileSync(f.path, 'utf8'))) {
          const r = runStatement((x) => old.exec(x), stmt)
          if (r.error) throw new Error(f.name + ' 这条跑挂了：' + stmt.slice(0, 80) + ' → ' + r.error.message)
        }
      }
      for (const t of ['orders', 'payables']) {
        const cols = old.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
        addedCols.push(t + ':' + (cols.includes('written_off') ? '有' : '缺'))
      }
      for (const { t, col } of addCols) {
        if (!renamed.includes(t + '.' + col)) continue
        const cols = old.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
        addedCols.push(t + '.' + col + ':' + (cols.includes(col) ? '有' : '缺'))
      }
      const miss = addedCols.filter((x) => x.endsWith('缺'))
      if (miss.length) throw new Error('迁移跑完了但列还没补上：' + miss.join('、'))
      // 再跑一遍（幂等性）：同一个文件跑两次不能报错
      for (const f of listMigrations(migDir)) {
        for (const stmt of splitStatements(fs.readFileSync(f.path, 'utf8'))) {
          const r = runStatement((x) => old.exec(x), stmt)
          if (r.error) throw new Error(f.name + ' 第二遍跑挂了（不幂等）：' + r.error.message)
        }
      }
    } catch (e) {
      err = e
    }
    const extra = renamed.length ? `，另模拟了 ${renamed.length} 个新增列（${renamed.join('、')}）` : ''
    // 第 13 轮 E6：还有列没法模拟成「老库没有」时，不能打绿 —— 那等于这条迁移没被测过。
    const skipNote = addColsSkipped.length ? `；⚠️ 这些列没法模拟成老库缺列，迁移没被真测过：${addColsSkipped.join('、')}` : ''
    say(!err && !addColsSkipped.length,
      `${migFiles.length} 个迁移文件在老库上跑通（含第二遍幂等复跑）${extra}${skipNote}`,
      err ? `迁移在老库上跑挂了：${err.message}` : `有 ${addColsSkipped.length} 个 ADD COLUMN 没能模拟成「老库缺列」：${addColsSkipped.join('、')} —— 这几列到底补得上没补上，这次没验证`)
  }
}

// ── 4.13 每个 d1 绑定都有迁移覆盖（写死的库名迟早跟 wrangler.toml 对不上）──
console.log('\n[4.13] d1 绑定与迁移')
{
  const tomlPath = path.join(ROOT, 'backend/wrangler.toml')
  const tomlSrc = fs.readFileSync(tomlPath, 'utf8')
  const bindings = []
  for (const blk of tomlSrc.split('[[d1_databases]]').slice(1)) {
    const binding = (blk.match(/^\s*binding\s*=\s*"([^"]+)"/m) || [])[1]
    const name = (blk.match(/^\s*database_name\s*=\s*"([^"]+)"/m) || [])[1]
    if (name) bindings.push({ binding: binding || name, database_name: name })
  }
  // 第 13 轮 E5：以前这一条是 `migSrc.includes(name) || /readD1Bindings/.test(migSrc)` ——
  // 只要 d1-migrate.mjs 里出现过 readD1Bindings 这个词就恒真，等于什么都没查（写死库名也绿）。
  // 现在真去调 readD1Bindings()，把它读出来的库名跟 wrangler.toml 对一遍，
  // 并确认它确实读了 wrangler.toml（而不是别的路径）。
  let read = []
  let readErr = null
  try {
    const mod = await import(path.join(ROOT, 'scripts/d1-migrate.mjs').replace(/\\/g, '/'))
    read = mod.readD1Bindings(tomlPath) || []
  } catch (e) { readErr = e }
  const wantNames = bindings.map((b) => b.database_name).sort().join(',')
  const gotNames = read.map((b) => b.database_name).sort().join(',')
  const migSrc = fs.readFileSync(path.join(ROOT, 'scripts/d1-migrate.mjs'), 'utf8')
  // 必须真的遍历绑定（bindings.map / for (const b of bindings)），不能只 import 不调用
  const reallyLoops = /readD1Bindings\s*\(/.test(migSrc) && /for\s*\(\s*const\s+\w+\s+of\s+(bindings|rows|dbs)\b|\bbindings\.(map|forEach|filter)/.test(migSrc)
  const covers = !readErr && wantNames === gotNames && reallyLoops
  say(bindings.length > 0 && covers,
    `${bindings.length} 个 d1 绑定（${bindings.map((b) => b.database_name).join('、')}）由 scripts/d1-migrate.mjs 逐个跑迁移（实测 readD1Bindings 读出的库名与 wrangler.toml 一致）`,
    readErr
      ? `跑不起来 readD1Bindings：${readErr.message}`
      : `迁移没真覆盖所有绑定：wrangler.toml 是 [${wantNames}]，readD1Bindings 读出 [${gotNames}]，真遍历=${reallyLoops}`)
}

// ── 4.15 schema.sql 与迁移里的同名索引必须定义一致 ──
// 第 13 轮 E7：同一个索引名在两个地方定义成不同的列，新库和老库就会拿到不同的索引，
// 而 `CREATE INDEX IF NOT EXISTS` 会静默保留先建好的那个 —— 之后谁再改都不生效，
// 排查性能问题时看 schema 和看迁移会得出两个结论。这里直接对一遍定义。
console.log('\n[4.15] 索引定义一致（schema.sql vs 迁移）')
{
  const idxOf = (src) => {
    const m = new Map()
    for (const x of src.matchAll(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)/gi)) {
      const cols = x[3].split(',').map((c) => c.trim().replace(/\s+/g, ' ').toLowerCase()).filter(Boolean).join(',')
      m.set(x[1], { table: x[2], cols })
    }
    return m
  }
  const inSchema = idxOf(schemaSrc)
  const migDir = path.join(ROOT, 'backend/migrations')
  const migFiles = fs.existsSync(migDir) ? fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort() : []
  const clashes = []
  for (const f of migFiles) {
    const inMig = idxOf(fs.readFileSync(path.join(migDir, f), 'utf8'))
    for (const [name, def] of inMig) {
      const s0 = inSchema.get(name)
      if (!s0) continue // 只在迁移里出现的索引（schema.sql 没建）不算冲突
      if (s0.table !== def.table || s0.cols !== def.cols) {
        clashes.push(`${name}：schema.sql 是 ${def2s(s0)}，${f} 是 ${def2s(def)}`)
      }
    }
  }
  function def2s(d) { return d.table + '(' + d.cols + ')' }
  say(!clashes.length,
    `schema.sql 与 ${migFiles.length} 个迁移里的同名索引定义一致`,
    `索引同名但定义不同（新库老库会长得不一样）：${clashes.join('；')}`)
}

// ── 4.14 后端引用的 D1 绑定都要在 wrangler.toml 里声明（先报不拦）──
// 第 12 轮 F5：本地 server/main.mjs 会自动建 9 本账、自动 ensureSchema，
// 本地跑得过不代表线上能跑 —— 线上只绑 wrangler.toml 里声明的库，引用没声明的
// D1 绑定本地绿、线上 500。这里只盯 D1 数据库类绑定（DB/DB2/DB3…），
// BOOK（按请求注入）、ENV_ALL（聚合对象）、INSTALL_TOKEN（secret）、ATTACH（KV）
// 这些运行时注入的不算 D1 绑定，不查，避免误报。
// 先报不拦：历史上有宽松 SQL，一次性全修要分批，先让漂移可见。
// ── 4.16 灌表结构要跑两遍：schema.sql 里有索引引用了「迁移才加上的列」──
// 第 16 轮 C3。老库里 writeoffs 表早就存在（CREATE TABLE IF NOT EXISTS 整句跳过），
// 而 month 列是 0002 迁移才加的 —— 所以 schema.sql 里的
// `CREATE INDEX IF NOT EXISTS idx_writeoffs_m ON writeoffs(month)` 在老库上一定
// `no such column: month`。只灌一遍的后果二选一：整步红（看着像发布失败），
// 或者被当成「幂等跳过」而索引永久缺失（查询慢一辈子没人发现）。
// 这里做两件事：① 把这类「依赖迁移列的索引」找出来并打印；
// ② 要求 deploy.yml 与 scripts/deploy.sh 都是「建表 → 迁移 → 再补一遍」的顺序。
console.log('\n[4.16] 灌表结构两遍（依赖迁移列的索引）')
{
  const migCols = new Set()
  const migDir = path.join(ROOT, 'backend/migrations')
  if (fs.existsSync(migDir)) {
    for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql'))) {
      const ms = fs.readFileSync(path.join(migDir, f), 'utf8')
      for (const m of ms.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/gi)) migCols.add(m[1] + '.' + m[2])
    }
  }
  const dep = []
  for (const m of schemaSrc.matchAll(/CREATE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)/gi)) {
    const name = m[1]; const t = m[2]
    const cols = m[3].split(',').map((x) => x.trim())
    for (const c of cols) {
      if (!/^[a-z_][a-z0-9_]*$/i.test(c)) continue // 表达式（substr(...)）不算
      // 注意：这里不能只比 declared（schema.sql 的建表语句）——
      // writeoffs.month 在 schema.sql 里**有**，但老库的 writeoffs 表早就存在，
      // `CREATE TABLE IF NOT EXISTS` 整句被跳过，所以老库照样没有 month。
      // 真正的判据是「这一列由迁移补」：那种列在老库上都不存在。
      if (migCols.has(t + '.' + c)) dep.push(name + ' → ' + t + '.' + c)
    }
  }
  // 顺序检查：两个入口都必须「seed → migrate → seed」
  const dep2 = path.join(ROOT, '.github/workflows/deploy.yml')
  const yml = fs.existsSync(dep2) ? fs.readFileSync(dep2, 'utf8') : ''
  const sh = fs.readFileSync(path.join(ROOT, 'scripts/deploy.sh'), 'utf8')
  const seeds = (src) => [...src.matchAll(/d1-seed-schema\.mjs/g)].map((x) => x.index)
  const migs = (src) => [...src.matchAll(/d1-migrate\.mjs/g)].map((x) => x.index)
  const orderOK = (src, what) => {
    const sd = seeds(src); const mg = migs(src)
    if (!mg.length) { fail(`${what} 里没有跑迁移`); return false }
    const before = sd.filter((i) => i < mg[0]).length
    const after = sd.filter((i) => i > mg[0]).length
    if (!before || !after) {
      fail(`${what} 里灌表结构的顺序不对（迁移前 ${before} 遍、迁移后 ${after} 遍）：依赖迁移列的索引（${dep.join('、') || '暂无'}）会建不出来`)
      return false
    }
    return true
  }
  const okY = yml ? orderOK(yml, 'deploy.yml') : (fail('找不到 .github/workflows/deploy.yml'), false)
  const okS = orderOK(sh, 'scripts/deploy.sh')
  say(okY && okS,
    dep.length
      ? `发现 ${dep.length} 个索引依赖迁移才加的列（${dep.join('、')}），两个发布入口都是「建表 → 迁移 → 再补一遍」`
      : '没有索引依赖迁移才加的列（一遍也能过，但两遍仍然更稳）',
    `索引与灌表结构顺序有问题（见上面逐条）`)
}

console.log('\n[4.14] D1 绑定引用')
{
  const tomlSrc = fs.readFileSync(path.join(ROOT, 'backend/wrangler.toml'), 'utf8')
  const d1Bindings = []
  for (const blk of tomlSrc.split('[[d1_databases]]').slice(1)) {
    const b = (blk.match(/^\s*binding\s*=\s*"([^"]+)"/m) || [])[1]
    if (b) d1Bindings.push(b)
  }
  const declared = new Set(d1Bindings)
  const idxSrc = fs.readFileSync(path.join(ROOT, 'backend/index.js'), 'utf8')
  // 只收 D1 数据库类绑定：名字形如 DB / DB2 / DB3 …（后端建库习惯）
  const used = new Set()
  for (const m of idxSrc.matchAll(/c\.env\.(DB[0-9]*)/g)) used.add(m[1])
  const orphan = [...used].filter((n) => !declared.has(n))
  if (orphan.length) {
    warn.push(`后端引用了 wrangler.toml 里没声明的 D1 绑定：${orphan.join('、')}（本地能跑、线上 500；要么在 wrangler.toml 补 [[d1_databases]]，要么去掉这段引用）`)
  }
  say(orphan.length === 0,
    `后端引用的 ${used.size} 个 D1 绑定（${[...used].join('、') || '无'}）都在 wrangler.toml 里声明了`,
    `有 ${orphan.length} 个 D1 绑定没在 wrangler.toml 声明（见上，先报不拦）`)
}

// ── 4.10 SQL 排除口径一致（ref_type NOT IN 的名单，改一处漏一处会静默串账）──
console.log('\n[4.10] SQL 排除口径')
{
  // 全库「排除内部转账/税金往来」和「排除借支/转账」这两类口径，名单必须逐字一致。
  // 有人要是只改其中一处（比如给某个报表多排一个 ref_type、或漏一个），就会变成新名单 → 这里红。
  const canonical = new Set([
    "('transfer','tax_ar','tax_ap')",
    "('loan','transfer')",
  ])
  const drift = []
  for (const m of beSrc.matchAll(/ref_type\s+NOT\s+IN\s*(\([^)]*\))/g)) {
    const norm = m[1].replace(/\s+/g, '')
    if (!canonical.has(norm)) {
      const line = beSrc.slice(0, m.index).split('\n').length
      drift.push(`第 ${line} 行：${m[1]}`)
    }
  }
  say(drift.length === 0, `「ref_type NOT IN」排除名单全部是标准口径（两种，共 ${[...beSrc.matchAll(/ref_type\s+NOT\s+IN/g)].length} 处）`, `出现非标准排除名单 ${drift.length} 处：${drift.slice(0, 5).join('；')}`)
}

// ── 4.11 账套数口径统一（backend 的 BOOK_MAX 和本机版 server/books.mjs 的 BOOKS 不能漂移）──
console.log('\n[4.11] 账套数')
{
  const beMax = Number((beSrc.match(/const\s+BOOK_MAX\s*=\s*(\d+)/) || [])[1])
  const serverBooks = Number((fs.readFileSync(path.join(ROOT, 'server/books.mjs'), 'utf8').match(/export\s+const\s+BOOKS\s*=\s*(\d+)/) || [])[1])
  say(beMax === 9 && serverBooks === 9, '账套数口径一致：backend BOOK_MAX=9、server BOOKS=9（可扩九本，最多 9 本）', `账套数漂移：backend BOOK_MAX=${beMax}、server BOOKS=${serverBooks}，两处必须都是 9（改库位数时两处一起改）`)
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

// ── 5.6 写接口有没有人真跑过（没人跑 = 出了事也没人知道）──
// 判定方式统一走 scripts/_route-usage.mjs：**方法 + 逐段严格比对**。
// 以前这里用宽松正则分段拼接，`DELETE /staff-users/:id` 会被 `POST /staff-users` 命中 ——
// 门禁一直是绿的，几十条写路由其实从没执行过一次。现在差集就是红的（除非在下面的白名单里）。
{
  const routesAll = extractRoutes(beSrc)
  const used = scanScriptUsage(path.join(ROOT, 'scripts'))
  const never = uncoveredWrites(routesAll, used)
  // 故意不测的写路由：一条一行，写清为什么。
  // 加白名单的人得负责说明理由，别把白名单当成垃圾桶。
  const SKIP = [
    // 'POST /xxx' — 为什么故意不测
  ]
  const skipKeys = new Set(SKIP.map((x) => x.trim()))
  const hard = never.filter((r) => !skipKeys.has(r.m + ' ' + r.p))
  if (never.length) {
    console.log(`  ℹ️ 写路由 ${routesAll.filter((r) => r.m !== 'GET').length} 条，其中 ${never.length} 条脚本没碰过：`)
    for (const r of never) console.log(`      ${skipKeys.has(r.m + ' ' + r.p) ? '（白名单）' : '❌'} ${r.m} ${r.p}`)
  }
  for (const r of hard) fail(`写接口 ${r.m} ${r.p} 从没被任何脚本调用过（真实执行路径没人验）——补 scripts/test-write-methods.mjs，或在 check.mjs 的 SKIP 白名单里写清为什么故意不测`)
  say(hard.length === 0, `${routesAll.filter((r) => r.m !== 'GET').length} 个写接口全部有脚本真跑过（${never.length - hard.length} 条在白名单里）`)
}

// ── 5.7 接口清单跟后端实际注册的路由对得上（清单是自动生成的，别让它悄悄过期）──
console.log('\n[5.7] 接口清单')
{
  const routesAll = extractRoutes(beSrc)
  const uniq = new Set(routesAll.map((r) => r.m + ' ' + r.p))
  const readmeTxt = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  const bi = readmeTxt.indexOf('<!-- API-LIST:BEGIN -->')
  const ej = readmeTxt.indexOf('<!-- API-LIST:END -->')
  const block = bi >= 0 && ej > bi ? readmeTxt.slice(bi, ej) : ''
  const listed = new Set([...block.matchAll(/^- `([A-Z]+ [^`]+)`/gm)].map((m) => m[1]))
  const missing = [...uniq].filter((k) => !listed.has(k))
  say(missing.length === 0 && listed.size === uniq.size,
    `README 接口清单跟后端一致（${uniq.size} 条）`,
    `README 接口清单跟后端对不上：后端 ${uniq.size} 条，清单 ${listed.size} 条，缺 ${missing.length} 条${missing.length ? '（例如 ' + missing.slice(0, 5).join('、') + '）' : ''}——跑 node scripts/gen-api-list.mjs 同步`)
}

// ── 5.8 员工能不能看到成本/毛利（漏过一次：/price-lookup 把成本单价发给员工）──
console.log('\n[5.8] 员工看不到成本')
{
  const { scanMoneyRoutes, staffLists, denyStaffRegexes, classify } = await import('./_staff-leak.mjs')
  const lists = staffLists(beSrc)
  const extra = denyStaffRegexes(beSrc)
  const rows = scanMoneyRoutes(beSrc)
  const bad = rows.filter((r) => classify(r.path, lists, extra) === 'none')
  if (bad.length) {
    for (const r of bad) fail(`GET ${r.path} 的响应里带「${r.words.join('/')}」这类钱数，但它不在 STAFF_MONEY_DENY / STAFF_MONEY_SCRUB / STAFF_COST_PATHS 也不在 denyStaff 的拦截名单里——员工能看到钱数`)
  }
  say(bad.length === 0, `${rows.length} 个带成本/利润字段的 GET 路由全部在员工拦截/脱敏名单里（denyStaff 内联规则 ${extra.length} 条 + 三张名单）`)
}

// ── 5.9 链接有效期的时间戳不许用 num() ──
// num() 是为了挡「1e300 这种越界金额」，它把 |v| > 1e12 归 0。
// 但毫秒时间戳是 1.7e12 —— 第 10/12/13 轮给公开链接加有效期时，
// 签名里的有效期和 linkExpired() 都用了 num()，于是签名恒为 '|x0'、过期判断恒真：
// 对账单/工资单/进度/报价/体检/年度那些打印链接一点开就「链接已失效」，
// 但接口返回 200、测试里也没人真去打开链接，一直没被发现。
console.log('\n[5.9] 链接有效期用时间戳解析器（numTs），不用金额解析器 num')
{
  const badTs = []
  // ① linkExpired 内部必须走 numTs
  const leM = beSrc.match(/const linkExpired = \(exp\) => \{([\s\S]{0,200}?)\n\}/)
  if (!leM) badTs.push('找不到 linkExpired 的实现')
  else if (!/numTs\(exp\)/.test(leM[1])) badTs.push('linkExpired() 里没用 numTs(exp)')
  // ② 签名里拼有效期必须走 numTs
  const expPartM = beSrc.matchAll(/const expPart = exp \? '\|x' \+ String\(num(\w*)\(/g)
  const expParts = [...beSrc.matchAll(/const expPart = exp \? '\|x' \+ String\((\w+)\(/g)].map((m) => m[1])
  if (!expParts.length) badTs.push('找不到签名里拼 expPart 的地方')
  for (const f of expParts) if (f !== 'numTs') badTs.push(`签名里的有效期用了 ${f}()，应为 numTs()`)
  // ③ 从 ?x= 读出来的有效期不许再用 num()
  for (const m of beSrc.matchAll(/=\s*num\(c\.req\.query\('x'\)\)/g)) badTs.push('有地方用 num() 解析 ?x= 的有效期')
  void expPartM
  // ④ numTs 必须真的存在且上限够（> 1e12）
  if (!/const numTs = /.test(beSrc)) badTs.push('缺少 numTs() 定义')
  else if (!/n > 1e15/.test(beSrc)) badTs.push('numTs() 的上限没放到 1e15，毫秒时间戳会被挡')
  say(badTs.length === 0, '链接有效期全部走 numTs（时间戳），没有误用金额解析器 num', badTs.join('；'))
}

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
