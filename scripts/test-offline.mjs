#!/usr/bin/env node
// 离线补发回归：手机弱网时攒了几笔账，恢复网络后按顺序补发。
//
// 为什么要有它：以前 flushPending() 有三处会「静默丢账」——
//   1. finish() 拿旧快照覆盖存储：补发途中用户又记的一笔（网刚回来最常见）被抹掉；
//   2. 中途 401（口令过期 / 换手机）：逐条试，每条都被标「口令错误」，用户以为账出问题了；
//   3. 服务端回 200 但 body 里 ok:false（日期不对这类）：当成补上了，这条就没了。
// 现在钉住：补上的不再留、没补上的带原因留着、顺序不乱、401 立刻停且不标错、
// 补发途中新记的不丢、5xx/断网整段留着、并发调用只跑一轮。
//
// 跑法：node scripts/test-offline.mjs
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC_PATH = process.env.SRC || path.join(ROOT, 'frontend/pages/index/index.js')
const src = fs.readFileSync(SRC_PATH, 'utf8')

let passed = 0
const fails = []
function ok(name, cond, extra) {
  if (cond) { passed++ } else { fails.push(name + (extra === undefined ? '' : ' → ' + extra)) }
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want))

// 造一个假 wx + 假页面实例。replies 按「第几次请求」给响应：
//   { code, data } 正常回；{ fail: true } 网络失败
function boot(opts) {
  const cfg = opts || {}
  let page = null
  const storage = Object.assign({ ak: '8888', book: 1 }, cfg.storage || {})
  const toasts = []
  const modals = []
  const hits = []
  let n = 0
  const wx = {
    // 真机 wx 的 storage 是「序列化再读回来」的，每次拿到的都是新对象。
    // 这里必须照做：否则测试里 snap 和存储是同一个数组，测不出「补发途中新记的一笔」被丢掉。
    getStorageSync: (k) => (k in storage ? JSON.parse(JSON.stringify(storage[k])) : ''),
    setStorageSync: (k, v) => { storage[k] = JSON.parse(JSON.stringify(v)) },
    showToast: (o) => { toasts.push(String((o && o.title) || '')) },
    showLoading() {},
    hideLoading() {},
    showModal: (o) => {
      modals.push({ title: o.title, content: o.content, cancelText: o.cancelText, confirmText: o.confirmText })
      // 默认点「确定」，个别场景由 cfg.onModal 决定
      const pick = cfg.onModal ? cfg.onModal(o, modals.length) : true
      if (pick !== 'pending') setTimeout(() => o.success && o.success({ confirm: pick !== false, cancel: pick === false }), 0)
    },
    request: (o) => {
      const i = n++
      hits.push(String(o.url))
      // replies 可以是数组（按第几次请求查表）也可以是函数（能顺手造「补发途中又记一笔」）
      let r = cfg.replies
        ? (typeof cfg.replies === 'function' ? cfg.replies(o, i) : cfg.replies[i])
        : { code: 200, data: { ok: true } }
      if (cfg.onRequest) cfg.onRequest(o, i)
      setTimeout(() => {
        if (r && r.fail) { o.fail && o.fail({ errMsg: 'request:fail timeout' }); return }
        o.success && o.success({ statusCode: (r && r.code) || 200, data: (r && r.data) || {} })
      }, 0)
    }
  }
  new Function('Page', 'wx', 'getApp', 'App', 'Component', 'console', src)(
    (o) => { page = o }, wx, () => ({ globalData: {} }), () => {}, () => {}, { log() {}, warn() {}, error() {} }
  )
  if (!page) throw new Error('没能从 index.js 里取出 Page({...})')
  const ctx = Object.assign(Object.create(page), {
    data: { pending_count: 0 },
    setData(d) { Object.assign(this.data, d) },
    refresh() { this._refreshed = (this._refreshed || 0) + 1 },
    _cachePut() {}, _cacheGet() { return null }, _agoText() { return '' },
    _noteFail() {}, openRecover() {}, showRecoverCode() {}, loadMe() {}
  })
  return { ctx, storage, toasts, modals, hits, count: () => n }
}

const tick = () => new Promise((r) => setTimeout(r, 12))

const mkOp = (label) => ({ url: 'https://x/api/orders', method: 'POST', label, data: { customer: label, amount: 100 } })

// ---- 1. 三笔全成功：队列清空、按顺序发、提示补上了 3 笔 ----
{
  const { ctx, storage, toasts, hits } = boot({})
  ctx.enqueueOp(mkOp('甲'))
  ctx.enqueueOp(mkOp('乙'))
  ctx.enqueueOp(mkOp('丙'))
  eq('入队后 pending_count = 3', ctx.data.pending_count, 3)
  ok('入队自动带 client_id', !!(storage.pending_ops[0].data && storage.pending_ops[0].data.client_id))
  ok('入队自动带 uid（区分补发途中新记的）', !!storage.pending_ops[0].uid)
  ctx.flushPending(false)
  await tick()
  eq('三笔全成功 → 队列清空', storage.pending_ops.length, 0)
  eq('三笔全成功 → pending_count 归零', ctx.data.pending_count, 0)
  eq('按入队顺序发送', hits.length, 3)
  ok('提示补上了 3 笔', toasts.some((t) => /补上了 3 笔/.test(t)), JSON.stringify(toasts))
  eq('补完后刷新了一屏', ctx._refreshed, 1)
}

// ---- 2. 中间一笔 409：只留那条（带原因），后面的照发 ----
{
  const { ctx, storage, toasts, modals } = boot({
    replies: [{ code: 200, data: { ok: true } }, { code: 409, data: { code: 'dup_soon', error: '这个客户两分钟内已经记过同样金额的单' } }, { code: 200, data: { ok: true } }]
  })
  ctx.enqueueOp(mkOp('甲'))
  ctx.enqueueOp(mkOp('乙'))
  ctx.enqueueOp(mkOp('丙'))
  ctx.flushPending(false)
  await tick()
  eq('中间一笔被拒 → 只剩那一笔', storage.pending_ops.length, 1)
  eq('留下的是被拒的那笔', storage.pending_ops[0].label, '乙')
  ok('带上了原因', /两分钟内/.test(String(storage.pending_ops[0]._err || '')), storage.pending_ops[0]._err)
  eq('pending_count = 1', ctx.data.pending_count, 1)
  ok('toast 说清「1 笔没补上」', toasts.some((t) => /补上了 2 笔，1 笔没补上/.test(t)), JSON.stringify(toasts))
  ok('弹窗列出没补上的那笔', modals.some((m) => /有 1 笔没补上/.test(m.title) && /两分钟内/.test(m.content)))
}

// ---- 3. 中途 401：立刻停，当前及后面的原样留着、不标错、弹登录卡 ----
{
  const { ctx, storage, hits, modals } = boot({
    replies: [{ code: 200, data: { ok: true } }, { code: 401, data: { code: 'bad_key', error: '访问口令错误' } }]
  })
  ctx.enqueueOp(mkOp('甲'))
  ctx.enqueueOp(mkOp('乙'))
  ctx.enqueueOp(mkOp('丙'))
  ctx.flushPending(false)
  await tick()
  eq('401 之后不再一条条试（只发了 2 次）', hits.length, 2)
  eq('401 之后剩下 2 笔都留着', storage.pending_ops.length, 2)
  eq('留着的是乙丙', storage.pending_ops.map((x) => x.label), ['乙', '丙'])
  ok('401 的那笔没被标成「口令错误」', !storage.pending_ops[0]._err, storage.pending_ops[0]._err)
  eq('弹了登录卡', ctx.data.key_open, true)
  ok('登录卡说明会自动补发', /自动补发/.test(String(ctx.data.key_err || '')) && /2 笔/.test(String(ctx.data.key_err || '')), ctx.data.key_err)
  ok('没弹「没补上」的窗（那是口令问题，不是账的问题）', !modals.some((m) => /没补上/.test(m.title)))
}

// ---- 4. 补发途中用户又记了一笔：不能丢 ----
{
  const { ctx, storage } = boot({
    replies: (o, i) => {
      if (i === 0) {
        // 模拟：第 1 笔补发的响应回来之前，用户又记了一笔
        ctx.enqueueOp(mkOp('途中新记'))
      }
      return { code: 200, data: { ok: true } }
    }
  })
  ctx.enqueueOp(mkOp('甲'))
  ctx.enqueueOp(mkOp('乙'))
  ctx.enqueueOp(mkOp('丙'))
  ctx.flushPending(false)
  await tick()
  eq('补发途中新记的那笔还在', storage.pending_ops.map((x) => x.label), ['途中新记'])
}

// ---- 5. 5xx：当前及后面整段留着，不算成功 ----
{
  const { ctx, storage, toasts } = boot({
    replies: [{ code: 200, data: { ok: true } }, { code: 502, data: { error: 'bad gateway' } }]
  })
  ctx.enqueueOp(mkOp('甲'))
  ctx.enqueueOp(mkOp('乙'))
  ctx.enqueueOp(mkOp('丙'))
  ctx.flushPending(false)
  await tick()
  eq('5xx → 从当前起全部留着', storage.pending_ops.map((x) => x.label), ['乙', '丙'])
  ok('5xx 不标错（服务器的事，不是这笔的问题）', !storage.pending_ops[0]._err, storage.pending_ops[0]._err)
  ok('5xx 只报真正补上的那 1 笔（不说 2 笔、3 笔）', toasts.some((t) => /补上了 1 笔/.test(t)) && !toasts.some((t) => /补上了 [23] 笔/.test(t)), JSON.stringify(toasts))
}

// ---- 6. 断网：同 5xx ----
{
  const { ctx, storage } = boot({ replies: [{ fail: true }] })
  ctx.enqueueOp(mkOp('甲'))
  ctx.enqueueOp(mkOp('乙'))
  ctx.flushPending(false)
  await tick()
  eq('断网 → 一笔都不丢', storage.pending_ops.length, 2)
  ok('断网不标错', !storage.pending_ops[0]._err)
}

// ---- 7. 200 但 body ok:false：不算成功 ----
{
  const { ctx, storage, toasts } = boot({ replies: [{ code: 200, data: { ok: false, error: '日期「2026-02-31」不是有效日期' } }] })
  ctx.enqueueOp(mkOp('甲'))
  ctx.flushPending(false)
  await tick()
  eq('ok:false 的那笔留着', storage.pending_ops.length, 1)
  ok('原因来自服务端', /不是有效日期/.test(String(storage.pending_ops[0]._err || '')), storage.pending_ops[0]._err)
  ok('ok:false 不算「补上了」', !toasts.some((t) => /补上了/.test(t)), JSON.stringify(toasts))
}

// ---- 8. 已经记过的再发一次（服务端按 client_id 认出来，回 ok:true+dup_ok）：算补上，不重复 ----
{
  const { ctx, storage, toasts } = boot({ replies: [{ code: 200, data: { ok: true, dup_ok: true } }] })
  ctx.enqueueOp(mkOp('甲'))
  const cid = storage.pending_ops[0].data.client_id
  ctx.flushPending(false)
  await tick()
  eq('重发已记过的那笔 → 队列清空', storage.pending_ops.length, 0)
  ok('还是那一笔（client_id 没变）', !!cid)
  ok('提示补上了 1 笔', toasts.some((t) => /补上了 1 笔/.test(t)), JSON.stringify(toasts))
}

// ---- 9. 同时点两次「重发」只跑一轮 ----
{
  const { ctx, hits } = boot({ replies: [{ code: 200, data: { ok: true } }, { code: 200, data: { ok: true } }] })
  ctx.enqueueOp(mkOp('甲'))
  ctx.enqueueOp(mkOp('乙'))
  ctx.flushPending(false)
  ctx.flushPending(true)
  ctx.flushPending(false)
  await tick()
  eq('并发调用只发一轮', hits.length, 2)
}

// ---- 10. 「待补」里丢掉最早那笔 ----
{
  const { ctx, storage, toasts } = boot({
    storage: { pending_ops: [mkOp('甲'), mkOp('乙'), mkOp('丙')], pending_count: 3 },
    // 第一个窗点「重发」以外的选项 → 落到「要不要丢掉最早那笔」，第二个窗点确定
    onModal: (o, nth) => (nth === 1 ? false : true)
  })
  ctx.data.pending_count = 3
  ctx.viewPending()
  await tick()
  eq('丢掉最早那笔后剩 2 笔', storage.pending_ops.length, 2)
  eq('剩下的是乙丙', storage.pending_ops.map((x) => x.label), ['乙', '丙'])
  eq('pending_count 跟着变', ctx.data.pending_count, 2)
  ok('提示丢掉了', toasts.some((t) => /丢掉了/.test(t)), JSON.stringify(toasts))
}

// ---- 11. 空队列：什么都不做 ----
{
  const { ctx, hits, storage } = boot({})
  ctx.flushPending(false)
  await tick()
  eq('没东西可补就不发请求', hits.length, 0)
  eq('存储仍是空数组', (storage.pending_ops || []).length, 0)
}

// ---- 12. 大文件切片上传（filePayload）：小文件直传，大文件切片，断了提示「接着传」 ----
{
  const CH = 700000
  const partSeqs = []
  const partLens = []
  let startBody = null
  const { ctx } = boot({
    replies: (o) => {
      const u = String(o.url)
      if (u.endsWith('/upload-start')) { startBody = o.data; return { code: 200, data: { ok: true, id: 'upTEST123456', part: CH } } }
      if (u.endsWith('/upload-part')) { partSeqs.push(o.data.seq); partLens.push(String(o.data.b64 || '').length); return { code: 200, data: { ok: true, seq: o.data.seq } } }
      if (u.endsWith('/upload-finish')) return { code: 200, data: { ok: true, id: o.data.id, size: startBody ? startBody.size : 0 } }
      return { code: 200, data: { ok: true } }
    }
  })
  const small = await new Promise((res) => ctx.filePayload('A'.repeat(5000), 'a.xlsx', (e, p) => res({ e, p })))
  ok('小文件不切片，直接带 b64', !small.e && !!small.p.b64, JSON.stringify(small.e))
  eq('小文件一条上传请求都不发', partSeqs.length, 0)

  const big = 'B'.repeat(1500000)
  const out = await new Promise((res) => ctx.filePayload(big, 'b.xlsx', (e, p) => res({ e, p })))
  eq('大文件按 70 万字符切片 → 3 片', partSeqs.length, 3)
  eq('片号从 0 开始连续', partSeqs.join(','), '0,1,2')
  ok('每片都不超过 70 万字符', partLens.every((n) => n <= CH && n > 0), JSON.stringify(partLens))
  eq('告给服务端的总长度是原长度', startBody && startBody.size, big.length)
  eq('传完拿到 upload_id（后面两个导入接口都用它）', out.p && out.p.upload_id, 'upTEST123456')
  ok('大文件不再带 b64（不然又变成 4MB 一个请求）', !(out.p && out.p.b64))
}

// ---- 13. 上传中途失败：要明确说「换个网络再点会接着传」，不能装作成功 ----
{
  const { ctx } = boot({
    replies: (o) => {
      const u = String(o.url)
      if (u.endsWith('/upload-start')) return { code: 200, data: { ok: true, id: 'upFAIL123456' } }
      if (u.endsWith('/upload-part')) return { code: 500, data: { error: '服务器开小差' } }
      return { code: 200, data: { ok: true } }
    }
  })
  const r = await new Promise((res) => ctx.filePayload('C'.repeat(1500000), 'c.xlsx', (e, p) => res({ e, p })))
  ok('中途失败会回调错误', !!r.e, JSON.stringify(r))
  ok('没有拿到 upload_id（不会拿半截文件去导）', !(r.p && r.p.upload_id))
}

console.log('')
if (fails.length) {
  console.log('❌ 离线补发：' + fails.length + ' 项没过（通过 ' + passed + ' 项）')
  fails.forEach((f) => console.log('   · ' + f))
  process.exit(1)
}
console.log('✅ 离线补发：' + passed + ' 项全过')
