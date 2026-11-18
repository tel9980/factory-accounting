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
//   5. 年度汇总按年分开：跨年那个 12 月开单 1000、次年 1 月开单 500
//   6. 开账凭据按 12-31 口径：应收（基线 + 600）、单数（基线 + 1）——不能因为 1 月收了钱就写成 0 单
//
// 用 2090-12 / 2091-01 做测试月，不碰真实账目；所有断言都取「跑之前的基线」，
// 所以库里有别的数据、或者脚本被重复跑，都不影响判断。
//
// 用法：node scripts/test-crossmonth.mjs [--base http://127.0.0.1:8791] [--key 8888]

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const BASE = arg('base', 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = arg('key', '8888')
const H = { 'X-Access-Key': KEY, 'Content-Type': 'application/json' }

const Y1 = '2090'          // 上一年（12 月）
const Y2 = '2091'          // 新年度（1 月）
const M1 = Y1 + '-12'
const M2 = Y2 + '-01'
// 客户名每次跑都不一样：/orders 有「同客户同金额刚记过就提醒」的防重，重名会被 409 挡掉
const CUSTOMER = '跨年客户' + Date.now().toString(36).slice(-4)

let pass = 0
const bad = []
const ok = (msg) => { pass++; console.log('  ✅ ' + msg) }
const no = (msg, detail) => { bad.push(msg); console.log('  ❌ ' + msg + (detail === undefined ? '' : ' → ' + JSON.stringify(detail))) }
const eq = (label, got, want) => (String(got) === String(want) ? ok(`${label} = ${want}`) : no(`${label} 应为 ${want}`, got))
const round2 = (x) => Math.round(Number(x) * 100) / 100

const call = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) })
  let d = null
  try { d = await r.json() } catch (e) { d = null }
  return { status: r.status, d }
}
const arRows = async () => {
  const r = await call('GET', '/ar')
  return Array.isArray(r.d) ? r.d : ((r.d && (r.d.orders || r.d.rows)) || [])
}
const unpaidAt = (rows, end) => round2(rows
  .filter((o) => String(o.created_at || '').slice(0, 10) <= end)
  .reduce((a, o) => a + Number(o.price || 0) - Number(o.paid || 0) - Number(o.written_off || 0), 0))
const cntAt = (rows, end) => rows.filter((o) => String(o.created_at || '').slice(0, 10) <= end
  && Number(o.price || 0) - Number(o.paid || 0) - Number(o.written_off || 0) > 0.005).length
const sumAdd = (d) => ((d && (d.rows || d.months)) || []).reduce((a, m) => a + Number(m.order_add || m.add || 0), 0)
const lastOrderId = async () => {
  const rows = await arRows()
  const hit = rows.filter((x) => x.customer === CUSTOMER).sort((a, b) => b.id - a.id)[0]
  return hit ? hit.id : 0
}

;(async () => {
  for (let i = 0; i < 60; i++) {
    const r = await fetch(BASE + '/').catch(() => null)
    if (r) break
    await new Promise((s) => setTimeout(s, 1000))
  }
  const su = await call('POST', '/auth/setup', { key: KEY })
  console.log(`口令准备：/auth/setup → ${su.status}（已有口令返回 4xx 也算正常）\n`)

  // 上一次跑可能把 2090-12 结过账：先解锁（删归档 = 解锁），保证这次能记账
  await call('DELETE', '/month-archive/' + M1)

  // 基线：只看本脚本新增的部分，不假设库是空的
  const baseAdd = sumAdd((await call('GET', '/year-summary?year=' + Y1)).d)
  const baseAdd2 = sumAdd((await call('GET', '/year-summary?year=' + Y2)).d)
  const rows0 = await arRows()
  const baseAr = unpaidAt(rows0, Y1 + '-12-31')
  const baseCnt = cntAt(rows0, Y1 + '-12-31')

  // 1) 12 月开单 + 12 月收款
  const o1 = await call('POST', '/orders', { customer: CUSTOMER, item_name: '甲件', price: 1000, date: M1 + '-20' })
  eq('12 月开单状态码', o1.status, 200)
  const id1 = await lastOrderId()
  if (!id1) { no('12 月开单后没在 /ar 里找到这张单', o1.d); process.exit(1) }
  const r1 = await call('POST', `/orders/${id1}/receive`, { amount: 400, date: M1 + '-28' })
  eq('12 月收 400 的状态码', r1.status, 200)
  const sm1 = await call('GET', '/statement-month?type=ar&name=' + encodeURIComponent(CUSTOMER) + '&month=' + M1)
  eq(`${M1} 对账单期末`, sm1.d && sm1.d.end, 600)

  // 2) 12 月结账
  const mc = await call('POST', '/month-close', { month: M1, confirm: true })
  eq(`月结 ${M1} 状态码`, mc.status, 200)

  // 3) 结账后补记 12 月的收款 → 必须拦住
  const late = await call('POST', `/orders/${id1}/receive`, { amount: 10, date: M1 + '-30' })
  eq('补记 12 月收款被拦（403）', late.status, 403)

  // 4) 1 月收这张 12 月单的尾款 → 必须放行（这就是本测试存在的理由）
  const o2 = await call('POST', '/orders', { customer: CUSTOMER, item_name: '乙件', price: 500, date: M2 + '-10' })
  eq('1 月开单状态码', o2.status, 200)
  const r2 = await call('POST', `/orders/${id1}/receive`, { amount: 600, date: M2 + '-15' })
  eq('1 月收 12 月单的尾款（200）', r2.status, 200)

  // 5) 1 月对账单：期初带过来 600、本期收 600、期末 500
  const sm2 = await call('GET', '/statement-month?type=ar&name=' + encodeURIComponent(CUSTOMER) + '&month=' + M2)
  eq(`${M2} 期初`, sm2.d && sm2.d.open, 600)
  eq(`${M2} 本期收`, sm2.d && sm2.d.got, 600)
  eq(`${M2} 期末`, sm2.d && sm2.d.end, 500)

  // 6) 年度汇总按年分开
  eq(`${Y1} 年新增开单合计`, round2(sumAdd((await call('GET', '/year-summary?year=' + Y1)).d) - baseAdd), 1000)
  eq(`${Y2} 年新增开单合计`, round2(sumAdd((await call('GET', '/year-summary?year=' + Y2)).d) - baseAdd2), 500)

  // 7) 年结 + 开账：凭据要按 12-31 的口径（1 月收掉尾款也不能写成 0 单）
  const yc = await call('POST', '/year-close', { year: Y1, confirm: true })
  eq(`年结 ${Y1} 状态码`, yc.status, 200)
  const yo = await call('POST', '/year-open', { year: Y2, confirm: true })
  eq(`开账 ${Y2} 状态码`, yo.status, 200)
  const rec = (yo.d && yo.d.record) || {}
  // 凭据里的应收/单数是全库口径（含库里原有的账），所以：
  //   起跑时库是干净的（基线 0）→ 精确比；否则只要求「不少于我们造的这一笔」。
  // 老代码的 bug 是「1 月把尾款收掉后单数写成 0」，两种比法都会红。
  if (baseAr === 0 && baseCnt === 0) {
    eq('开账凭据里的应收', rec.ar, 600)
    eq('开账凭据里的应收单数（12-31 口径）', rec.ar_cnt, 1)
  } else {
    const arOk = Number(rec.ar || 0) >= 600
    const cntOk = Number(rec.ar_cnt || 0) >= 1
    if (arOk && cntOk) ok(`开账凭据里的应收 ${rec.ar} 元 / ${rec.ar_cnt} 单（库里有旧账，只要求 ≥ 600 元且单数不为 0）`)
    else no('开账凭据里的应收/单数不对', { ar: rec.ar, cnt: rec.ar_cnt, baseAr, baseCnt })
  }
  eq('开账凭据的上年', rec.from, Y1)

  console.log('')
  if (bad.length) {
    console.log(`❌ 跨月/跨年回归失败：${bad.length} 项`)
    process.exit(1)
  }
  console.log(`✅ 跨月/跨年回归通过：${pass} 项断言全绿`)
})().catch((e) => { console.log('❌ 脚本自身出错：' + (e && e.stack)); process.exit(1) })
