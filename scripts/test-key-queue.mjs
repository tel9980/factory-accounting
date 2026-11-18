#!/usr/bin/env node
// 口令排队回归测试：不联网、不需要小程序环境，把 index.js 灌进假 wx 里跑。
//
// 为什么要有它：首屏 refresh() 一次发 18+13 个请求。换手机 / 清了缓存 / 口令被改之后，
// 这几十个请求会同时 401。旧代码在 401 分支里 `if (this._askingKey) return` —— 直接返回，
// 既不 success 也不 fail，于是除第一个以外全部人间蒸发：用户输完口令，看到一屏空白
// （而且没有下拉刷新，只能杀进程重进）。
// 现在改成排队：等待口令期间的 401 请求进 _keyQueue，拿到口令后原样重放。
// 这个脚本钉住三件事：
//   1. 所有 401 请求最终都拿到了数据（success 恰好各一次）
//   2. 口令只弹一次窗（不会每个请求都弹）
//   3. 用户取消时不重放、不留队列
// 跑法：node scripts/test-key-queue.mjs
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC_PATH = process.env.SRC || path.join(ROOT, 'frontend/pages/index/index.js')
const src = fs.readFileSync(SRC_PATH, 'utf8')

const run = async ({ boot, cancel }) => {
  let page = null
  const storage = { ak: '', book: 1 }
  const modals = []
  const hits = []
  let authOk = false
  const delivered = []
  const wx = {
    getStorageSync: (k) => (k in storage ? storage[k] : ''),
    setStorageSync: (k, v) => { storage[k] = v },
    showToast() {},
    showLoading() {},
    hideLoading() {},
    showModal: (o) => {
      modals.push(o.title)
      setTimeout(() => {
        if (cancel) o.success && o.success({ confirm: false, cancel: true })
        else o.success && o.success({ confirm: true, content: '1234' })
      }, 0)
    },
    request: (o) => {
      const url = String(o.url)
      hits.push(url)
      if (url.endsWith('/auth/setup')) {
        authOk = true
        return setTimeout(() => o.success && o.success({ statusCode: 200, data: { ok: true } }), 0)
      }
      if (!authOk) {
        return setTimeout(() => o.success && o.success({ statusCode: 401, data: { ok: false, code: 'no_key' } }), 0)
      }
      setTimeout(() => o.success && o.success({ statusCode: 200, data: { ok: true, path: url } }), 0)
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
    openRecover() { modals.push('（忘了口令）') }
  })

  for (const p of boot) {
    ctx._send({ url: 'https://x' + p, method: 'GET', __rel: p, success: () => delivered.push(p) })
  }
  await new Promise((ok) => setTimeout(ok, 120))
  return { modals, delivered, hits, queued: (ctx._keyQueue || []).length }
}

let bad = 0
const ok = (cond, msg) => { if (cond) console.log('  ✅ ' + msg); else { bad++; console.log('  ❌ ' + msg) } }

const boot = ['/dashboard', '/reminders', '/me', '/accounts', '/categories', '/onboarding', '/cashflow', '/target',
  '/pipeline', '/health-check', '/my-work', '/my-day', '/funding', '/cash-forecast', '/next-step', '/month-end',
  '/term-default', '/books']

console.log('18 个请求同时 401（换手机 / 清了缓存）：')
{
  const r = await run({ boot })
  ok(r.delivered.length === boot.length, `18 份数据都拿到了（实际 ${r.delivered.length}/18）`)
  ok(new Set(r.delivered).size === boot.length, '没有重复回调（每份数据只送一次）')
  ok(r.modals.filter((t) => t === '首次使用').length === 1, `口令只问一次（实际弹了 ${r.modals.filter((t) => t === '首次使用').length} 次）`)
  ok(r.queued === 0, '队列清空了')
  const setup = r.hits.filter((u) => u.endsWith('/auth/setup')).length
  ok(setup === 1, `只调了一次 /auth/setup（实际 ${setup}）`)
}

console.log('用户点取消（不输口令）：')
{
  const r = await run({ boot, cancel: true })
  ok(r.delivered.length === 0, '取消时不该假装成功')
  ok(r.queued === 0, '队列已清空，不会在别的时机偷偷重放')
  ok(r.hits.filter((u) => u.endsWith('/auth/setup')).length === 0, '取消时没有去设口令')
}

if (bad) { console.log(`\n❌ ${bad} 项不符合预期`); process.exit(1) }
console.log('\n✅ 口令排队回归测试通过：401 的请求会排队，拿到口令后原样重放')
