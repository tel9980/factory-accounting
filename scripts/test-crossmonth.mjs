// 跨月 / 跨年 回归测试
//
// 为什么要有这个：结账锁定以前是「按单据是哪个月开的」拦的，结果 12 月一结账，
// 1 月收 12 月那笔单的尾款就被 403 挡住——跨月收尾款是最常见的事，等于结完账就收不了钱。
// 现在改成「按这笔钱是哪天发生的」拦：本月收本月的钱放行，补记已结账月份的钱仍然拦住。
//
// 断言：
//   1. 12 月开单 1000、12 月收 400，对账单期末 600
//   2. 12 月结账后，补记 12 月的收款 → 403
//   3. 12 月结账后，1 月收这张 12 月单的 600 → 200（这就是修的那个 bug）
//   4. 1 月对账单：期初 600（12 月欠的带过来）、本期收 600、期末 500（1 月新单）
//   5. 年度汇总按年分开：2026 开单 1000 / 2027 开单 500
//   6. 开账凭据按 12-31 口径：应收 600 元（1 单）——不能因为 1 月收了钱就写成 0 单
//
// 用法：node scripts/test-crossmonth.mjs [--base http://127.0.0.1:8791] [--key 8888]
// 注意：会在库里造数据，只对本地/CI 的空库跑。

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const BASE = arg('base', 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = arg('key', '8888')
const H = { 'X-Access-Key': KEY, 'Content-Type': 'application/json' }

let pass = 0
const bad = []
const ok = (msg) => { pass++; console.log('  ✅ ' + msg) }
const no = (msg, detail) => { bad.push(msg); console.log('  ❌ ' + msg + (detail === undefined ? '' : ' → ' + JSON.stringify(detail))) }
const eq = (label, got, want) => (String(got) === String(want) ? ok(`${label} = ${want}`) : no(`${label} 应为 ${want}`, got))

const call = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) })
  let d = null
  try { d = await r.json() } catch (e) { d = null }
  return { status: r.status, d }
}
const CUSTOMER = '跨年客户'
const lastOrderId = async () => {
  const r = await call('GET', '/ar')
  const rows = Array.isArray(r.d) ? r.d : ((r.d && (r.d.orders || r.d.rows)) || [])
  const hit = rows.filter((x) => x.customer === CUSTOMER).sort((a, b) => b.id - a.id)[0]
  return hit ? hit.id : 0
}

;(async () => {
  // 等服务就绪
  for (let i = 0; i < 60; i++) {
    const r = await fetch(BASE + '/').catch(() => null)
    if (r) break
    await new Promise((s) => setTimeout(s, 1000))
  }
  const su = await call('POST', '/auth/setup', { key: KEY })
  console.log(`口令准备：/auth/setup → ${su.status}（已有口令返回 4xx 也算正常）\n`)

  // 1) 12 月开单 + 12 月收款
  await call('POST', '/orders', { customer: CUSTOMER, item_name: '甲件', price: 1000, date: '2026-12-20' })
  const id1 = await lastOrderId()
  if (!id1) { no('12 月开单后没在 /ar 里找到这张单'); process.exit(1) }
  const r1 = await call('POST', `/orders/${id1}/receive`, { amount: 400, date: '2026-12-28' })
  eq('12 月收 400 的状态码', r1.status, 200)
  const sm12 = await call('GET', '/statement-month?type=ar&name=' + encodeURIComponent(CUSTOMER) + '&month=2026-12')
  eq('2026-12 对账单期末', sm12.d && sm12.d.end, 600)

  // 2) 12 月结账
  const mc = await call('POST', '/month-close', { month: '2026-12', confirm: true })
  eq('月结 2026-12 状态码', mc.status, 200)

  // 3) 结账后补记 12 月的收款 → 必须拦住
  const late = await call('POST', `/orders/${id1}/receive`, { amount: 10, date: '2026-12-30' })
  eq('补记 12 月收款被拦（403）', late.status, 403)

  // 4) 1 月收这张 12 月单的尾款 → 必须放行（这就是本测试存在的理由）
  await call('POST', '/orders', { customer: CUSTOMER, item_name: '乙件', price: 500, date: '2027-01-10' })
  const r2 = await call('POST', `/orders/${id1}/receive`, { amount: 600, date: '2027-01-15' })
  eq('1 月收 12 月单的尾款（200）', r2.status, 200)

  // 5) 1 月对账单：期初带过来 600、本期收 600、期末 500
  const sm1 = await call('GET', '/statement-month?type=ar&name=' + encodeURIComponent(CUSTOMER) + '&month=2027-01')
  eq('2027-01 期初', sm1.d && sm1.d.open, 600)
  eq('2027-01 本期收', sm1.d && sm1.d.got, 600)
  eq('2027-01 期末', sm1.d && sm1.d.end, 500)

  // 6) 年度汇总按年分开
  for (const [y, want] of [['2026', 1000], ['2027', 500]]) {
    const ys = await call('GET', '/year-summary?year=' + y)
    const rows = (ys.d && (ys.d.rows || ys.d.months)) || []
    const add = rows.reduce((a, m) => a + Number(m.order_add || m.add || 0), 0)
    eq(`${y} 年开单合计`, add, want)
  }

  // 7) 年结 + 开账：凭据要按 12-31 的口径（1 月收掉尾款也不能写成 0 单）
  const yc = await call('POST', '/year-close', { year: '2026', confirm: true })
  eq('年结 2026 状态码', yc.status, 200)
  const yo = await call('POST', '/year-open', { year: '2027' })
  eq('开账 2027 状态码', yo.status, 200)
  eq('开账凭据里的应收', yo.d && yo.d.record && yo.d.record.ar, 600)
  eq('开账凭据里的应收单数（12-31 口径）', yo.d && yo.d.record && yo.d.record.ar_cnt, 1)

  console.log('')
  if (bad.length) {
    console.log(`❌ 跨月/跨年回归失败：${bad.length} 项`)
    process.exit(1)
  }
  console.log(`✅ 跨月/跨年回归通过：${pass} 项断言全绿`)
})().catch((e) => { console.log('❌ 脚本自身出错：' + (e && e.stack)); process.exit(1) })
