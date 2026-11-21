#!/usr/bin/env node
// 列表分页回归：不联网、不需要小程序环境，把 index.js 灌进假 wx 里跑。
//
// 为什么要有它：`_appendPage(cur, page, more)` 曾经把 `more` 参数丢掉（非数组加固时顺手改坏），
// 变成「永远在旧列表后面追加、按 id 去重、旧行先到先得」。后果全都发生在老板每天都在做的动作上：
//   1. 收了 5000，列表里那张单还写着「欠 5000」（同 id 的旧行赢了新行），只有首页数字变了
//   2. 删掉的单还挂在列表上，再点收款就 404
//   3. ar_off 只增不减，切了筛选以后 offset=120 去请求第 120 条 → 中间 60 条被跳过，还翻不到
//   4. 切账套（两本账单号都从 1 开始）→ 新账套的行全被当重复丢掉，页面显示的是上一本的单
// 这个脚本钉住四件事：
//   1. more=false（重新拉第一页）时，旧列表必须被丢掉，同 id 的行要用**新**数据
//   2. more=true 时才追加，且按 id 去重（同一个 id 不出现两遍）
//   3. ar_off 跟着列表长度走，不累加
//   4. 后端回的不是数组时不抛错、也不把旧列表带死
// 跑法：node scripts/test-list.mjs
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC_PATH = process.env.SRC || path.join(ROOT, 'frontend/pages/index/index.js')
const src = fs.readFileSync(SRC_PATH, 'utf8')

const bad = []
const ok = (cond, msg) => { if (!cond) bad.push(msg) }
const eq = (name, got, want) => ok(JSON.stringify(got) === JSON.stringify(want), `${name}：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)

let page = null
const storage = { ak: 'test-key', book: 1 }
const wx = {
  getStorageSync: (k) => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => { storage[k] = v },
  request: () => {},
  showToast: () => {},
  showModal: () => {},
  showLoading: () => {},
  hideLoading: () => {}
}
new Function('Page', 'wx', 'getApp', 'App', 'Component', 'console', src)(
  (o) => { page = o }, wx, () => ({ globalData: {} }), () => {}, () => {}, { log() {}, warn() {}, error() {} }
)
if (!page) {
  console.error('❌ 没能从 index.js 里取出 Page({...})')
  process.exit(1)
}

// 假页面实例：setData 真合并、req 由每个用例自己塞「后端会回什么」
const mkCtx = (pages) => {
  const queue = pages.slice()
  const ctx = Object.assign(Object.create(page), {
    data: { ar_kw: '', ar_filter: 'open', ar_sort: '', ap_kw: '', ap_filter: 'open', ap_sort: '', ap_cat: '', ex_kw: '', ar_off: 0, ap_off: 0, ex_off: 0 },
    _arAll: [], _apAll: [], _expAll: [],
    setData(d) { Object.assign(this.data, d) },
    filterAr: (all) => all,
    filterAp: (all) => all,
    filterEx: (all) => all,
    req(o) {
      const next = queue.shift()
      const res = typeof next === 'function' ? next() : next
      if (o.success) o.success({ statusCode: 200, data: res })
      if (o.complete) o.complete({ statusCode: 200, data: res })
    }
  })
  return ctx
}

// —— 1. pure function：more=false 时旧行不能赢 ——
{
  const ctx = mkCtx([])
  const old = [{ id: 1, price: 100 }, { id: 2, price: 100 }]
  const fresh = [{ id: 1, price: 40 }, { id: 3, price: 100 }]
  const got = ctx._appendPage(old, fresh, false)
  eq('重新拉第一页：旧列表要丢掉', got, fresh)
  const got2 = ctx._appendPage(old, fresh, true)
  eq('加载更多：追加并按 id 去重，旧行保留', got2, [{ id: 1, price: 100 }, { id: 2, price: 100 }, { id: 3, price: 100 }])
  const got3 = ctx._appendPage(old, { ok: true, error: '后端抽风' }, false)
  ok(Array.isArray(got3), '后端回的不是数组时也不能抛错')
  eq('后端回非数组：第一页当成空', got3, [])
}

// —— 2. loadAr：收完款列表要跟着变（本脚本存在的理由） ——
{
  const ctx = mkCtx([
    [{ id: 1, price: 100, paid: 0 }, { id: 2, price: 300, paid: 0 }], // 首屏
    [{ id: 1, price: 100, paid: 100 }], // 收到钱以后重新拉第一页（这张单已结清，正常不会再出现）
    [{ id: 1, price: 100, paid: 100 }] // 同一个 id 但数据变了：必须用新的
  ])
  ctx.loadAr(false)
  eq('首屏两行', ctx._arAll.length, 2)
  eq('首屏 ar_off', ctx.data.ar_off, 2)
  ctx.loadAr(false)
  eq('重新拉第一页不许累加', ctx._arAll.length, 1)
  eq('重新拉第一页 ar_off 要跟着减', ctx.data.ar_off, 1)
  ctx.loadAr(false)
  eq('同 id 用新数据（收完款不能还显示欠 100）', ctx._arAll[0].paid, 100)
}

// —— 3. loadAr(true)：翻页追加、去重、offset 跟着长度 ——
{
  const ctx = mkCtx([
    [{ id: 1 }, { id: 2 }],
    [{ id: 3 }, { id: 4 }],
    [{ id: 4 }, { id: 5 }] // 后端有重叠（新单插到前面时很常见）
  ])
  ctx.loadAr(false)
  ctx.loadAr(true)
  eq('第二页追加后 4 行', ctx._arAll.map((x) => x.id), [1, 2, 3, 4])
  eq('ar_off 跟着长度', ctx.data.ar_off, 4)
  ctx.loadAr(true)
  eq('重叠 id 不重复', ctx._arAll.map((x) => x.id), [1, 2, 3, 4, 5])
  eq('ar_off 继续跟着长度', ctx.data.ar_off, 5)
}

// —— 4. 分页 busy 标记：翻页在途时不重复发 ——
{
  const ctx = mkCtx([[{ id: 1 }], [{ id: 2 }]])
  ctx.loadAr(false)
  let calls = 0
  const rawReq = ctx.req
  ctx.req = (o) => { calls += 1; rawReq.call(ctx, o) }
  ctx._pagBusy = { ar: true }
  ctx.loadAr(true)
  eq('翻页在途时不重复发请求', calls, 0)
  ctx._pagBusy = { ar: false }
  ctx.loadAr(true)
  eq('不忙的时候正常发', calls, 1)
}

if (bad.length) {
  console.error('❌ 列表分页回归没过：')
  for (const b of bad) console.error('   - ' + b)
  process.exit(1)
}
console.log('✅ 列表分页回归全过（重新拉第一页不累加 / 翻页追加去重 / offset 跟长度 / 非数组不崩 / busy 不重发）')
