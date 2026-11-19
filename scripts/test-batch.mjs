#!/usr/bin/env node
// 合批回归测试：不联网、不需要小程序环境，只把 index.js 灌进一个假的 wx 里跑。
//
// 为什么要有它：首屏 `refresh()` 一次排 18 个 GET，全压在 `/batch` 上（上限 16/24 条）。
// 这里曾经有个坑 —— 18 条 > 后端上限 16，后端静悄悄截断，前端发现「回来的条数不对」就整批作废、
// 退回逐个发，等于每次进首页都白跑 16 次查询再发 18 个请求（看似合并、其实没合并）。
// 这个脚本就是钉住这个行为：
//   1. 18 个请求必须全部靠批量发出去（不许退回逐个发）
//   2. 每批不超过 16 条（兼容还没升级的后端）
//   3. 18 份数据一份不少地回到各自的 success 回调
// 跑法：node scripts/test-batch.mjs
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
// 想拿老版本对照：SRC=/tmp/old-index.js node scripts/test-batch.mjs
const SRC_PATH = process.env.SRC || path.join(ROOT, 'frontend/pages/index/index.js')
const src = fs.readFileSync(SRC_PATH, 'utf8')

// ── 一个够用的假 wx：只实现被合批逻辑用到的几个 API ──
const run = async ({ boot, serverCap, chunkHint }) => {
  let page = null
  const storage = { ak: 'test-key', book: 1 }
  const batches = []
  const singles = []
  const delivered = new Set()
  let calls = 0
  const wx = {
    getStorageSync: (k) => (k in storage ? storage[k] : ''),
    setStorageSync: (k, v) => { storage[k] = v },
    request: (o) => {
      const qs = (o.data && o.data.qs) || []
      if (String(o.url).endsWith('/batch')) {
        batches.push(qs)
        // 模拟后端：超过上限就截断（前端必须能从条数不对里发现）
        const results = qs.slice(0, serverCap).map((p) => ({ ok: true, path: p }))
        setTimeout(() => o.success({ statusCode: 200, data: { ok: true, results } }), 0)
      } else {
        singles.push(String(o.url))
        setTimeout(() => o.success({ statusCode: 200, data: { ok: true } }), 0)
      }
    }
  }
  new Function('Page', 'wx', 'getApp', 'App', 'Component', 'console', src)(
    (o) => { page = o }, wx, () => ({ globalData: {} }), () => {}, () => {}, { log() {}, warn() {}, error() {} })
  if (!page) throw new Error('没能从 index.js 里取出 Page({...})')

  const ctx = Object.assign(Object.create(page), {
    data: {},
    setData() {},
    _cachePut() {},
    _cacheGet() { return null },
    _agoText() { return '' },
    _send(o) { singles.push(String(o.url)); setTimeout(() => o.success && o.success({ statusCode: 200, data: { ok: true } }), 0) }
  })

  ctx._bq = boot.map((p) => ({ path: p, opts: { url: 'https://x' + p, success: () => { calls++; delivered.add(p) } } }))
  ctx._bt = 1
  ctx._batchFlush.call(ctx)
  await new Promise((ok) => setTimeout(ok, 60))
  return { batches, singles, delivered, calls, chunkHint }
}

const boot = ['/dashboard', '/reminders', '/me', '/books', '/accounts', '/categories', '/onboarding',
  '/cashflow?days=45', '/target', '/pipeline', '/health-check', '/my-work', '/my-day', '/funding',
  '/cash-forecast?days=14', '/next-step', '/month-end', '/term-default']

let bad = 0
const check = (ok, msg) => {
  console.log(`  ${ok ? '✅' : '❌'} ${msg}`)
  if (!ok) bad++
}

for (const [label, cap] of [['新后端（上限 24）', 24], ['老后端（上限 16）', 16]]) {
  console.log(`\n[首屏 ${boot.length} 个请求 / ${label}]`)
  const r = await run({ boot, serverCap: cap })
  const maxChunk = r.batches.reduce((a, b) => Math.max(a, b.length), 0)
  check(r.singles.length === 0, `没有退回逐个发（实际 ${r.singles.length} 个）`)
  check(maxChunk <= 16, `每批都不超过 16 条（最大 ${maxChunk} 条）`)
  check(r.batches.length >= 1, `确实走了批量（${r.batches.map((b) => b.length + '条').join(' + ')}）`)
  check(r.delivered.size === boot.length, `18 份数据都回到了各自的回调（${r.delivered.size}/${boot.length}）`)
}

// refresh() 里同一路径被重复请求（18 个 loader + 当前那一屏），这里钉住「同一条路径只发一次」
{
  console.log('\n[同一屏里 3 条重复路径]')
  const dup = ['/dashboard', '/reminders', '/dashboard', '/me', '/books', '/me', '/accounts',
    '/categories', '/onboarding', '/cashflow?days=45', '/target', '/pipeline', '/health-check',
    '/my-work', '/my-day', '/funding', '/cash-forecast?days=14', '/next-step', '/month-end',
    '/term-default', '/accounts']
  const r = await run({ boot: dup, serverCap: 24 })
  const sentPaths = r.batches.reduce((a, b) => a + b.length, 0)
  const uniq = new Set(dup).size
  check(r.singles.length === 0, `没有退回逐个发（实际 ${r.singles.length} 个）`)
  check(sentPaths === uniq, `${dup.length} 条请求去重成 ${uniq} 条发出（实际发了 ${sentPaths} 条）`)
  check(r.calls === dup.length, `${dup.length} 个回调都收到了数据（${r.calls}/${dup.length}）`)
}

// 同一个 GET 还在路上时再要一次（切页签回来 / enterTab 与 refresh 撞一起），
// 不能真发第二遍：钉住「后到的挂到前一个上，数据回来两份回调都收到」。
{
  console.log('\n[同一路径在飞时又点了同一屏]')
  let page = null
  const storage = { ak: 'test-key', book: 1 }
  const batches = []
  const singles = []
  const got = []
  const wx = {
    getStorageSync: (k) => (k in storage ? storage[k] : ''),
    setStorageSync: (k, v) => { storage[k] = v },
    request: (o) => {
      if (String(o.url).endsWith('/batch')) {
        batches.push((o.data && o.data.qs) || [])
        const results = ((o.data && o.data.qs) || []).map((p) => ({ ok: true, path: p }))
        setTimeout(() => o.success({ statusCode: 200, data: { ok: true, results } }), 5)
      } else {
        singles.push(String(o.url))
        setTimeout(() => o.success({ statusCode: 200, data: { ok: true } }), 5)
      }
    }
  }
  new Function('Page', 'wx', 'getApp', 'App', 'Component', 'console', src)(
    (o) => { page = o }, wx, () => ({ globalData: {} }), () => {}, () => {}, { log() {}, warn() {}, error() {} })
  const ctx = Object.assign(Object.create(page), {
    data: {}, setData() {}, _cachePut() {}, _cacheGet() { return null }, _agoText() { return '' }
  })
  // 必须用真的 API_BASE 前缀：req() 靠它算出相对路径才知道能不能合批
  const BS = (src.match(/const API_BASE = '([^']+)'/) || [])[1] || ''
  ctx.req({ url: BS + '/ar', success: () => got.push('a') })
  ctx.req({ url: BS + '/ar', success: () => got.push('b') })
  ctx.req({ url: BS + '/ap', success: () => got.push('c') })
  await new Promise((ok) => setTimeout(ok, 80))
  const sent = batches.reduce((a, b) => a + b.length, 0)
  check(singles.length === 0, `没有退回逐个发（实际 ${singles.length} 个）`)
  check(sent === 2, `同一路径只要了一次，实际发出 ${sent} 条（期望 2：/ar + /ap）`)
  check(got.length === 3, `3 个回调都收到数据（实际 ${got.length}）`)
  check(ctx._flight && Object.keys(ctx._flight).length === 0, '请求回来后「在飞」标记已清空')
}

if (bad) {
  console.log(`\n❌ 合批回归测试失败：${bad} 项`)
  process.exit(1)
}
console.log('\n✅ 合批回归测试通过：首屏 18 个请求全走批量，不退回逐个发')
