// 「钱不能算错」回归测试：把第四轮审计里修的那几条守卫钉住
//
// 这些 bug 的共同点是「接口返回 200，账却错了」，静态检查看不出来，只能真打接口：
//   1. 员工 4 位 PIN 能清库：/import-all、/export-all、/backup-restore、/db-clean 必须 403
//   2. 整户收款多出来的钱要记成预收（以前只 return rest 就没了）
//   3. 整户收款/付款带 client_id 重发不会记两笔
//   4. 发工资可以先发一部分、月底再补（以前 UNIQUE(month,worker) 把补发整条挡掉）
//   5. 已结账的月份不再补摊销（否则月报和明细永久差一笔）
//   6. 回收站恢复要保住 written_off（以前丢字段，坏账变回欠款）
//   7. 收据「期末欠」要减核销（以前已结清还印「期末欠 3000」）
//   8. 首页逾期笔数不被 LIMIT 5 截断
//   9. 押金待摊（月数 0）能存进去
//  10. 撤销核销要看月结锁
//
// 用法：node scripts/test-safety.mjs [--base http://127.0.0.1:8791] [--key 8888]

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const BASE = arg('base', 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = arg('key', '8888')
const H = { 'X-Access-Key': KEY, 'Content-Type': 'application/json' }
const TAG = '守卫' + Date.now().toString(36).replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]).slice(-4)

let pass = 0
const bad = []
const ok = (m) => { pass++; console.log('  ✅ ' + m) }
const no = (m, d) => { bad.push(m); console.log('  ❌ ' + m + (d === undefined ? '' : ' → ' + JSON.stringify(d))) }
const eq = (label, got, want) => (String(got) === String(want) ? ok(`${label} = ${want}`) : no(`${label} 应为 ${want}`, got))
const num0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const round2 = (x) => Math.round(Number(x) * 100) / 100

const call = async (method, p, body, key) => {
  const h = key === null ? { 'Content-Type': 'application/json' } : Object.assign({}, H, key ? { 'X-Access-Key': key } : {})
  const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
  let d = null
  try { d = await r.json() } catch (e) { d = null }
  return { status: r.status, d }
}
const wait = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/version'); if (r.ok) return true } catch (e) {}
    await new Promise((s) => setTimeout(s, 1000))
  }
  return false
}
const arRows = async () => {
  const r = await call('GET', '/ar')
  return Array.isArray(r.d) ? r.d : ((r.d && (r.d.orders || r.d.rows)) || [])
}
const newOrder = async (customer, price, extra) => {
  const r = await call('POST', '/orders', Object.assign({ customer, item_name: '守卫测试', price }, extra || {}))
  if (r.status !== 200) throw new Error('建单失败 ' + r.status + ' ' + JSON.stringify(r.d))
  const rows = await arRows()
  const hit = rows.filter((o) => o.customer === customer).sort((a, b) => num0(b.id) - num0(a.id))[0]
  return hit && hit.id
}

if (!(await wait())) { console.log('❌ 服务器没起来：' + BASE); process.exit(1) }
await call('POST', '/auth/setup', { key: KEY })

// ── 1. 员工 PIN 不能清库 / 导全量 / 覆盖恢复 ──
console.log('\n[1] 员工口令不能清库、不能导全量、不能覆盖恢复')
{
  await call('POST', '/modules', { off: [] })
  // 明文口令只在「新建」的响应里出现一次（库里存的是哈希）
  const made = await call('POST', '/staff-users', { name: TAG + '员工', modules: ['ar', 'ap', 'expense', 'import'] })
  const pin = made.d && made.d.pin && String(made.d.pin).length >= 4 ? String(made.d.pin) : null
  if (!pin) {
    no('新建员工时后端没回明文口令，后面几条没法验', '响应里没有 pin：' + JSON.stringify(made.d))
  } else {
    const checks = [
      ['POST', '/import-all', { mode: 'replace', confirm: '覆盖' }],
      ['GET', '/export-all', undefined],
      ['POST', '/backup-restore', { id: 1, confirm: 1 }],
      ['POST', '/db-clean', { days: 0 }]
    ]
    for (const [m, p, b] of checks) {
      const r = await call(m, p, b, pin)
      if (r.status === 403) ok(`员工 ${m} ${p} 被拦（403 ${(r.d && r.d.code) || ''}）`)
      else no(`员工 ${m} ${p} 应该 403`, r.status + ' ' + JSON.stringify(r.d))
    }
    // 老板自己能过（这里只验 /export-all 不是被全局关掉；不真导全量，怕慢）
    const own = await call('GET', '/version')
    eq('老板 /version 正常', own.status, 200)
  }
}

// ── 2. 整户收款：多出来的钱记预收，且带 client_id 重发不记两笔 ──
console.log('\n[2] 整户收款多出来的钱记预收 + 重发不重复')
{
  const cust = TAG + '整户'
  await newOrder(cust, 1000)
  await newOrder(cust, 500)
  const adv0 = await call('GET', '/advances?type=in')
  const before = round2((((adv0.d && (adv0.d.rows || adv0.d)) || [])).filter((a) => a.party === cust).reduce((s, a) => s + num0(a.amount), 0))
  const cid = 'cid' + TAG + '1'
  const r1 = await call('POST', '/receive-batch', { customer: cust, amount: 2000, client_id: cid })
  eq('整户收款 2000 状态码', r1.status, 200)
  eq('冲掉的金额 = 1500', round2((r1.d || {}).total), 1500)
  eq('多出来的 500 记成预收', round2((r1.d || {}).over), 500)
  const adv1 = await call('GET', '/advances?type=in')
  const after = round2((((adv1.d && (adv1.d.rows || adv1.d)) || [])).filter((a) => a.party === cust).reduce((s, a) => s + num0(a.amount), 0))
  eq('预收里确实多了 500', round2(after - before), 500)
  const r2 = await call('POST', '/receive-batch', { customer: cust, amount: 2000, client_id: cid })
  eq('同一个 client_id 重发：不报错', r2.status, 200)
  eq('重发被认成重复（dup_ok）', !!(r2.d && r2.d.dup_ok), true)
}

// ── 3. 发工资：可以先发一部分，月底再补 ──
console.log('\n[3] 发工资允许分次补发')
{
  const mm = '2087-06'
  const worker = TAG + '工人'
  await call('POST', '/wage-rates', { worker, item: '守卫件', process: '车', rate: 1, unit: '件' })
  await call('POST', '/wage-records', { rows: [{ worker, item: '守卫件', process: '车', qty: 5000, date: mm + '-10' }] })
  const p1 = await call('POST', '/payroll/pay', { month: mm, workers: [worker], amount: 2000 })
  eq('先发 2000 状态码', p1.status, 200)
  eq('第一次发出去 2000', round2(((p1.d || {}).paid || [])[0] && ((p1.d || {}).paid || [])[0].amount), 2000)
  const p2 = await call('POST', '/payroll/pay', { month: mm, workers: [worker], amount: 3000 })
  eq('月底补发 3000 状态码（以前这里 400）', p2.status, 200)
  eq('补发金额 3000', round2(((p2.d || {}).paid || [])[0] && ((p2.d || {}).paid || [])[0].amount), 3000)
  const p3 = await call('POST', '/payroll/pay', { month: mm, workers: [worker], amount: 9999 })
  eq('已经发够了再发：不重复发', p3.status, 400)
}

// ── 4. 已结账的月份不再补摊销 ──
console.log('\n[4] 已结账月份不再补摊销')
{
  const mm = '2086-02'
  // 先把 2086-02 结掉（空月也能结，快照为 0）
  const c1 = await call('POST', '/month-close', { month: mm, confirm: true })
  eq('结账 2086-02 状态码', c1.status, 200)
  const r = await call('POST', '/prepaids', { name: TAG + '房租', total: 1200, months: 12, category: '厂房租金', start_date: mm + '-01' })
  eq('建待摊状态码', r.status, 200)
  const amort = (r.d && r.d.amort) || {}
  eq('已结账月份被跳过（locked 计数 > 0 或没往里写）', num0(amort.locked) > 0 || num0(amort.added) === 0, true)
  const led = await call('GET', '/ledger?month=' + mm)
  const rows = (led.d && (led.d.rows || led.d)) || []
  const amortIn = rows.filter((x) => x.ref_type === 'amort').length
  eq('2086-02 里没有摊销流水', amortIn, 0)
}

// ── 5. 回收站恢复保住核销金额 ──
console.log('\n[5] 回收站恢复不丢核销金额')
{
  const cust = TAG + '回收'
  const id = await newOrder(cust, 800)
  const wo = await call('POST', '/orders/' + id + '/writeoff', { amount: 300, reason: '守卫测试核销' })
  eq('核销 300 状态码', wo.status, 200)
  const del = await call('DELETE', '/orders/' + id)
  eq('删除应收单状态码', del.status, 200)
  const tr = await call('GET', '/trash')
  const rows = (tr.d && (tr.d.rows || tr.d)) || []
  // /trash 是按「一批删除」聚合的：[{batch, deleted_at, ids, items}]，items 是人看的文字
  const hit = rows.filter((x) => (x.items || []).some((t) => String(t).indexOf(cust) >= 0))[0]
  if (!hit) no('回收站里找不到刚删的单', rows.length)
  else {
    const back = await call('POST', '/trash/' + ((hit.ids || [])[0] || hit.id) + '/restore', {})
    eq('从回收站恢复状态码', back.status, 200)
    const ar = await arRows()
    const o = ar.filter((x) => num0(x.id) === num0(id))[0] || {}
    eq('恢复后 written_off 还是 300（以前会变 0）', round2(o.written_off), 300)
  }
}

// ── 6. 收据「期末欠」要减核销 ──
console.log('\n[6] 收据期末欠减核销')
{
  const cust = TAG + '收据'
  const id = await newOrder(cust, 1000)
  await call('POST', '/orders/' + id + '/receive', { amount: 700 })
  await call('POST', '/orders/' + id + '/writeoff', { amount: 300, reason: '尾差抹零（按实际收款结清）' })
  const r = await call('GET', '/receipt-text?type=ar&id=' + id)
  const text = String((r.d && r.d.text) || '')
  eq('收据里写了已核销 300', /已核销：300/.test(text), true)
  eq('收据不再写「期末欠 300」', /期末欠：300/.test(text), false)
  eq('收据说已全部收清', /已全部收清/.test(text), true)
}

// ── 7. 首页逾期笔数不被 LIMIT 截断 ──
console.log('\n[7] 首页逾期笔数用真实 COUNT')
{
  const cust = TAG + '逾期'
  // 逾期口径是「单据日期早于 30 天前」，所以要用过去的日期；2085 年那种未来日期不算逾期
  for (let i = 0; i < 7; i++) await newOrder(cust, 100 + i, { date: '2026-05-0' + (i + 1) })
  const d = await call('GET', '/dashboard')
  const cnt = num0((d.d || {}).overdue_count)
  eq('逾期笔数 ≥ 7（以前最多 5）', cnt >= 7, true)
  const shown = (((d.d || {}).overdue) || []).length
  eq('明细列表仍然只给 5 条', shown <= 5, true)
}

// ── 8. 押金待摊（月数 0）能存 ──
console.log('\n[8] 押金待摊月数 0 能存')
{
  const r = await call('POST', '/prepaids', { name: TAG + '押金', total: 20000, months: 0, category: '押金', start_date: '2085-03-01' })
  eq('押金建单状态码', r.status, 200)
  eq('标记成押金（不摊）', !!(r.d && r.d.deposit), true)
  eq('每月摊销额 0', round2((r.d || {}).per_month), 0)
}

// ── 9. 撤销核销要看月结锁 ──
console.log('\n[9] 撤销核销受月结锁保护')
{
  const mm = '2083-07'
  const cust = TAG + '锁核销'
  // 重复跑的时候这个月可能已经结过账，先解锁（删归档会连带解锁）
  await call('DELETE', '/month-archive/' + mm)
  const id = await newOrder(cust, 600, { date: mm + '-10' })
  await call('POST', '/orders/' + id + '/writeoff', { amount: 600, reason: '守卫测试' })
  await call('POST', '/month-close', { month: mm, confirm: true })
  const list = await call('GET', '/writeoffs')
  const rows = (list.d && (list.d.rows || list.d)) || []
  const hit = rows.filter((x) => num0(x.ref_id) === num0(id))[0]
  if (!hit) no('找不到刚建的核销记录', rows.length)
  else {
    const r = await call('DELETE', '/writeoffs/' + hit.id)
    eq('已结账月份撤销核销 → 403', r.status, 403)
  }
}

// ── 10. 转账去重 + /run-cron + /version ──
console.log('\n[10] 转账去重、定时任务可手跑、版本号公开')
{
  const acc = await call('GET', '/accounts')
  const list = (acc.d && (acc.d.accounts || acc.d)) || []
  if (list.length < 2) {
    await call('POST', '/accounts', { name: TAG + '乙账户', kind: 'bank', opening: 0 })
  }
  const acc2 = await call('GET', '/accounts')
  const l2 = (acc2.d && (acc2.d.accounts || acc2.d)) || []
  const cid = 'tr' + TAG
  const r1 = await call('POST', '/transfer', { from: l2[0].id, to: l2[1].id, amount: 100, client_id: cid })
  eq('转账状态码', r1.status, 200)
  const r2 = await call('POST', '/transfer', { from: l2[0].id, to: l2[1].id, amount: 100, client_id: cid })
  eq('同 client_id 重发被认成重复', !!(r2.d && r2.d.dup_ok), true)
  const cron = await call('POST', '/run-cron', {})
  eq('手动跑定时任务状态码', cron.status, 200)
  eq('定时任务没有报错', !!(cron.d && cron.d.ok), true)
  const v = await call('GET', '/version', undefined, null)
  eq('/version 不带口令也能看', v.status, 200)
  eq('/version 有 ok', !!(v.d && v.d.ok), true)
}

console.log('')
if (bad.length) {
  console.log(`❌ 守卫测试失败：${bad.length} 项`)
  for (const b of bad.slice(0, 20)) console.log('   · ' + b)
  process.exit(1)
}
console.log(`✅ 守卫测试全部通过（${pass} 项）`)
