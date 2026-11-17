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

  ctx._bq = boot.map((p) => ({ path: p, opts: { url: 'https://x' + p, success: () => delivered.add(p) } }))
  ctx._bt = 1
  ctx._batchFlush.call(ctx)
  await new Promise((ok) => setTimeout(ok, 60))
  return { batches, singles, delivered, chunkHint }
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

if (bad) {
  console.log(`\n❌ 合批回归测试失败：${bad} 项`)
  process.exit(1)
}
console.log('\n✅ 合批回归测试通过：首屏 18 个请求全走批量，不退回逐个发')
