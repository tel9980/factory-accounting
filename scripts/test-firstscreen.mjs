#!/usr/bin/env node
// 首屏分波回归测试：不联网、不需要小程序环境，把 index.js 灌进假 wx 里跑。
//
// 为什么要它：微信开发者工具里 `Page.onShow took 915ms`，原因是 onShow → refresh() 一次排了
// 20 多个请求（首屏数字 + 体检分数 + 目标 + 在制 + 资金预测 + 账本 + 分类 + 账期 + 本月提示…），
// 首屏要等这些全回来才算完。现在拆成两波：
//   第一波：首页第一眼要看的（数字、提醒、我的今天、下一步、应收应付汇总、当前这一屏）
//   第二波：晚 150 毫秒再拉（体检、目标、在制、预收预付、资金预测、现金流、账本、分类、账期、我的活、本月提示）
// 这个脚本钉住三件事：
//   1. 第一波不许包含第二波那些路径（拆开了才算真拆开）
//   2. 第一波条数不超过 16（后端 /batch 一次最多 16，多了会截断→整批作废）
//   3. 第二波真的会来，而且两波合起来把该拉的都拉了
// 跑法：node scripts/test-firstscreen.mjs
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC_PATH = process.env.SRC || path.join(ROOT, 'frontend/pages/index/index.js')
const src = fs.readFileSync(SRC_PATH, 'utf8')

// 第二波（慢一点无所谓的那些）：这些路径在第一波里一个都不许出现
const SLOW = [
  '/health-check', '/target', '/pipeline', '/funding', '/cash-forecast',
  '/cashflow', '/books', '/categories', '/term-default', '/my-work'
]
// 注意：/month-end（本月提示）在 22 号之前根本不会发请求，所以不列在这里
// 第一波必须有的（首屏第一眼）
const FAST = ['/dashboard', '/reminders', '/me', '/accounts', '/onboarding', '/next-step']

const bad = []
const ok = (cond, msg) => { if (!cond) bad.push(msg) }

let page = null
const storage = { ak: 'test-key', book: 1 }
const wx = {
  getStorageSync: (k) => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => { storage[k] = v },
  request: () => {},
  showToast: () => {},
  showModal: () => {}
}
new Function('Page', 'wx', 'getApp', 'App', 'Component', 'console', src)(
  (o) => { page = o }, wx, () => ({ globalData: {} }), () => {}, () => {}, { log() {}, warn() {}, error() {} }
)
if (!page) {
  console.error('❌ 没能从 index.js 里取出 Page({...})')
  process.exit(1)
}

const paths = []
const ctx = Object.assign(Object.create(page), {
  data: {},
  setData() {},
  _cachePut() {},
  _cacheGet() { return null },
  _agoText() { return '' },
  // 只记录请求路径，不真发
  req(o) {
    const u = String((o && o.url) || '')
    paths.push(u.replace(/^https?:\/\/[^/]+/, ''))
  }
})

ctx.refresh()
const wave1 = paths.slice()
await new Promise((r) => setTimeout(r, 320))
const wave2 = paths.slice(wave1.length)

// 1) 第一波里不许有第二波的路径
const leaked = wave1.filter((p) => SLOW.some((s) => p.split('?')[0] === s))
ok(leaked.length === 0, `第一波里混进了本该延后的路径：${leaked.join('、')}`)

// 2) 第一波去重后不超过 /batch 单批上限 16（_batchFlush 会按路径去重，重复的只发一条）
const uniq1 = [...new Set(wave1.map((p) => p.split('?')[0]))]
ok(uniq1.length <= 16, `第一波去重后还有 ${uniq1.length} 条，超过单批上限 16（会被后端截断→整批作废）`)

// 3) 首屏该有的都在第一波
const miss = FAST.filter((p) => !wave1.some((x) => x.split('?')[0] === p))
ok(miss.length === 0, `第一波缺了首屏要用的：${miss.join('、')}`)

// 4) 第二波真的来了，而且把延后的都补上
ok(wave2.length > 0, '第二波一个请求都没发（延后逻辑没生效）')
const miss2 = SLOW.filter((p) => !wave2.some((x) => x.split('?')[0] === p))
ok(miss2.length === 0, `第二波缺了：${miss2.join('、')}`)

// 5) 备份时间 5 分钟内只问一次
const before = paths.length
ctx.loadCloudBackupLazy()
ctx.loadCloudBackupLazy()
const cb = paths.slice(before).filter((p) => p.split('?')[0] === '/backup-list')
ok(cb.length === 1, `备份时间问了 ${cb.length} 次（5 分钟内应该只问 1 次）`)

const total = wave1.length + wave2.length
console.log(`第一波 ${wave1.length} 次调用（去重 ${uniq1.length} 条）/ 第二波 ${wave2.length} 条（合计 ${total}）`)
console.log(`  第一波：${wave1.map((p) => p.split('?')[0]).join(' ')}`)
console.log(`  第二波：${wave2.map((p) => p.split('?')[0]).join(' ')}`)

if (bad.length) {
  console.error('\n❌ 首屏分波有问题：')
  bad.forEach((m) => console.error('  · ' + m))
  process.exit(1)
}
console.log('\n✅ 首屏分波正常：第一波去重 ' + uniq1.length + ' 条先出来，第二波 ' + wave2.length + ' 条 150ms 后补上')
