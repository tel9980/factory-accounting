#!/usr/bin/env node
// 全接口冒烟：把所有 GET 接口挨个打一遍，只看「5xx 就算坏」，参数缺失导致的 4xx 不算。
//
// 为什么要有它：有些坑静态检查看不出来 —— 变量名写错（`await pbP`、`labor is not defined`）、
// 老库缺列（`no such column: s.resolved_at`），一律表现为某个接口 500，
// 而人不会把 224 个接口挨个点一遍。第一次跑就抓到 3 个躺着的 500（客户信用整页、使用向导、争议台账）。
//
// 用法：
//   node scripts/smoke.mjs                                  # 默认打 http://127.0.0.1:8791
//   node scripts/smoke.mjs --base http://127.0.0.1:8792 --key 8888
//
// 前置：本机已经起着 `wrangler dev --local`（CI 里由 workflow 负责起，见 deploy.yml）。
// 只对本机/测试库跑：少数 GET 接口会顺手补建表、写默认值（设计上是幂等的自愈，不碰线上）。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const argOf = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const BASE = argOf('base', 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = argOf('key', '8888')
const CONCURRENCY = Number(argOf('concurrency', '4')) || 4
const TIMEOUT_MS = Number(argOf('timeout', '20000')) || 20000

// 从后端源码里抽 GET 路由，`:id` 换成一个数字（能过路由、多半会返回 400/404，那是正常的）
const src = fs.readFileSync(path.join(ROOT, 'backend/index.js'), 'utf8')
const routes = [...new Set([...src.matchAll(/\bapp\.get\(\s*'([^']+)'/g)].map((m) => m[1]))]
const paths = routes.map((p) => p.replace(/:[a-z_]+/g, '1'))
// 哪些路径本来是带参数的（查 1 号单确实「不存在」，404 是正常的）
const HAS_PARAM = new Set(routes.filter((p) => /:[a-z_]+/.test(p)).map((p) => p.replace(/:[a-z_]+/g, '1')))

const hit = async (p, opt = {}) => {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(BASE + p, { ...opt, signal: ac.signal })
    const text = await r.text()
    return { status: r.status, text }
  } catch (e) {
    return { status: 0, text: String(e && e.message ? e.message : e) }
  } finally { clearTimeout(timer) }
}

// 等服务起来（CI 里 wrangler dev 刚启动时要等十几秒）
const ready = async () => {
  for (let i = 0; i < 60; i++) {
    const r = await hit('/')
    if (r.status > 0) return true
    await new Promise((ok) => setTimeout(ok, 1000))
  }
  return false
}
if (!(await ready())) {
  console.log(`❌ 等 60 秒也没起来：${BASE}（是不是 wrangler dev 没起？看它的日志）`)
  process.exit(1)
}

// 先设一次口令（库是新的就必须设；已经设过会返回 409/400，无所谓）
const setup = await hit('/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: KEY }) })
console.log(`口令准备：/auth/setup → ${setup.status || 'x'}（已有口令的地方返回 4xx 也算正常）`)

const bad = []
let i = 0
const worker = async () => {
  while (i < paths.length) {
    const p = paths[i++]
    const r = await hit(p, { headers: { 'x-access-key': KEY } })
    if (r.status === 0) bad.push([0, p, '请求失败：' + r.text.slice(0, 120)])
    // 404 也算坏：路由表里有、实际打不通，通常是改名了没同步前端（历史上真出过）。
    // 带 :id 的路径除外 —— 空库里查 1 号单确实是「不存在」，那是对的。
    else if (r.status === 404 && !HAS_PARAM.has(p)) {
      // 分清两种 404：
      //   · 框架自己吐的「404 Not Found」纯文本 = 路由根本不存在（改名了、被删了）→ 算坏
      //   · 接口自己 return 的 JSON（{"error":"备份不存在"}）= 数据确实没有 → 正常
      let isJson = false
      try { JSON.parse(r.text); isJson = true } catch (e) { isJson = false }
      if (!isJson) bad.push([404, p, '路由不在（改名了？）' + r.text.replace(/\s+/g, ' ').slice(0, 120)])
    }
    else if (r.status >= 500) bad.push([r.status, p, r.text.replace(/\s+/g, ' ').slice(0, 160)])
  }
}
await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker))

// 只看状态码不够：字段改名、返回空数组，CI 照样绿（历史上有过「界面空白但 CI 全绿」）。
// 这里对几个最关键的接口做「形状」断言。
const contractFails = []
const shape = async (path, fn) => {
  const r = await hit(path, { headers: { 'x-access-key': KEY } })
  let d = null
  try { d = JSON.parse(r.text) } catch (e) { d = null }
  if (r.status !== 200 || d === null) return contractFails.push(`${path} → ${r.status}`)
  const why = fn(d)
  if (why) contractFails.push(`${path} → ${why}`)
}
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
await shape('/version', (d) => (d.ok === true ? '' : 'ok 不是 true'))
await shape('/dashboard', (d) => (isNum(d.ar_total) && isNum(d.ap_total) && isNum(d.month_income) ? '' : 'ar_total/ap_total/month_income 不是数字'))
await shape('/ar', (d) => (Array.isArray(d) ? '' : '返回的不是数组'))
await shape('/ap', (d) => (Array.isArray(d) ? '' : '返回的不是数组'))
await shape('/selfcheck', (d) => (d && typeof d.bad === 'number' ? '' : '没有 bad 计数'))
await shape('/accounts', (d) => (Array.isArray(d) || (d && Array.isArray(d.accounts)) ? '' : '返回的不是数组'))
if (contractFails.length) {
  console.log(`❌ 接口形状变了 ${contractFails.length} 处：`)
  for (const f of contractFails) console.log(`   · ${f}`)
  bad.push([200, 'contract', contractFails.join('；')])
}

if (!bad.length) {
  console.log(`✅ 冒烟通过：${paths.length} 个 GET 接口没有一个 5xx`)
  process.exit(0)
}
console.log(`❌ ${paths.length} 个 GET 接口里有 ${bad.length} 个 5xx：`)
for (const [st, p, msg] of bad) console.log(`   ${st} ${p}\n      ${msg}`)
console.log('\n提示：设置 → 数据体检 → 🐞 运行日志（GET /error-log）里有完整堆栈')
process.exit(1)
