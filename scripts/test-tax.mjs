// 「税和票」回归测试：含税 / 不含税、有票 / 没票、税金另外收付
//
// 这几条错了不报错，只让账慢慢歪：
//   1. 税率不固定（13/9/6/3/1 都见过），所以要能逐单填税率，也要能手填票面税额
//   2. 含税单：税额 = 金额 - 金额/(1+税率)，不含税 = 金额 - 税额
//   3. 不含税单：税额 = 金额 × 税率，不含税 = 金额（税在价外）
//   4. 有票/没票记在「流水」上（用户说：有些要等实际收付才知道），不记在单据上
//   5. 工行对公户平时有票、农行个人户平时没票 → 账户上设一次，收付款自动带出
//   6. 税金另外收付 → 单独记一笔，原单欠款一分不动（不能把 paid 冲掉）
//   7. 删单要连带删掉它的税金流水，否则流水里留孤儿
//
// 用法：node scripts/test-tax.mjs [--base http://127.0.0.1:8791] [--key 8888]

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const BASE = arg('base', 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = arg('key', '8888')
const H = { 'X-Access-Key': KEY, 'Content-Type': 'application/json' }
// 名字不能带数字：带数字的会被导入解析当成金额（这个坑踩过两次）
const TAG = '税' + Date.now().toString(36).replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]).slice(-4)
const TODAY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const MONTH = TODAY.slice(0, 7)

let pass = 0
const bad = []
const ok = (m) => { pass++; console.log('  ✅ ' + m) }
const no = (m, d) => { bad.push(m); console.log('  ❌ ' + m + (d === undefined ? '' : ' → ' + JSON.stringify(d))) }
const eq = (label, got, want) => (String(got) === String(want) ? ok(`${label} = ${want}`) : no(`${label} 应为 ${want}`, got))
const r2 = (x) => Math.round(Number(x) * 100) / 100

const call = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) })
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
const apRows = async () => {
  const r = await call('GET', '/ap')
  return Array.isArray(r.d) ? r.d : ((r.d && (r.d.payables || r.d.rows)) || [])
}
const findAr = async (name, price) => {
  // 结清的单不在默认列表里，所以要 ?status=all 才找得到
  const rows = await (async () => {
    const r = await call('GET', '/ar?status=all')
    return Array.isArray(r.d) ? r.d : ((r.d && (r.d.orders || r.d.rows)) || [])
  })()
  return rows.filter((o) => o.customer === name && (!price || r2(o.price) === r2(price))).sort((a, b) => Number(b.id) - Number(a.id))[0] || null
}
const findAp = async (name) => {
  const rows = await apRows()
  return rows.filter((o) => o.supplier === name).sort((a, b) => Number(b.id) - Number(a.id))[0] || null
}

const main = async () => {
  if (!(await wait())) { console.error('服务没起来：' + BASE); process.exit(1) }
  let r = await call('POST', '/auth/setup', { key: KEY })
  if (r.status !== 200 && r.status !== 400 && r.status !== 409) { console.error('设口令失败', r.status, r.d); process.exit(1) }

  // ── 1. 不含税 13%：金额 1000 → 税额 130，不含税 1000
  const cA = '税测试甲' + TAG
  r = await call('POST', '/orders', { customer: cA, item_name: '加工', price: 1000, tax_kind: '不含税', tax_rate: 13 })
  eq('不含税单建单状态', r.status, 200)
  let o = await findAr(cA, 1000)
  if (!o) no('不含税单没找到')
  else {
    eq('不含税 tax_kind', o.tax_kind, '不含税')
    eq('不含税 tax_rate', o.tax_rate, 13)
    eq('不含税 tax_amt（1000×13%）', o.tax_amt, 130)
    eq('不含税 tax_net（不含税还是 1000）', o.tax_net, 1000)
    eq('不含税 gross_net 不减税', r2(Number(o.price) - Number(o.tax_amt)), 870)
  }

  // ── 2. 含税 13%：金额 1130 → 税额 130，不含税 1000
  const cB = '税测试乙' + TAG
  r = await call('POST', '/orders', { customer: cB, item_name: '加工', price: 1130, tax_kind: '含税', tax_rate: 13 })
  eq('含税单建单状态', r.status, 200)
  const oB = await findAr(cB, 1130)
  if (!oB) no('含税单没找到')
  else {
    eq('含税 tax_amt（1130-1130/1.13）', oB.tax_amt, 130)
    eq('含税 tax_net（不含税 1000）', oB.tax_net, 1000)
  }

  // ── 3. 手填税额优先（票面跟算出来的常差几分）
  const cC = '税测试丙' + TAG
  r = await call('POST', '/orders', { customer: cC, item_name: '加工', price: 1000, tax_kind: '含税', tax_rate: 13, tax_amt: 87.5 })
  eq('手填税额建单状态', r.status, 200)
  const oC = await findAr(cC, 1000)
  if (!oC) no('手填税额的单没找到')
  else {
    eq('手填税额优先（87.5 而不是 115.04）', oC.tax_amt, 87.5)
    eq('手填税额后不含税', oC.tax_net, 912.5)
  }

  // ── 4. 改税率会重算税额
  if (oC) {
    r = await call('PATCH', '/orders/' + oC.id, { tax_rate: 6 })
    eq('改税率状态', r.status, 200)
    const oC2 = await findAr(cC, 1000)
    eq('改成含税 6% 后税额', oC2 && oC2.tax_amt, 56.6)
  }

  // ── 5. 账户「平时有没有票」设一次，收付款自动带出
  r = await call('GET', '/accounts')
  const accs = (r.d && r.d.accounts) || []
  if (!accs.length) no('没有账户')
  const accA = accs[0]
  const accB = accs[1] || accs[0]
  r = await call('PATCH', '/accounts/' + accA.id, { inv_default: 'yes' })
  eq('给账户标「有票」状态', r.status, 200)
  r = await call('PATCH', '/accounts/' + accB.id, { inv_default: 'no' })
  eq('给账户标「没票」状态', r.status, 200)
  r = await call('GET', '/accounts')
  const accs2 = (r.d && r.d.accounts) || []
  const a1 = accs2.find((x) => x.id === accA.id) || {}
  const a2 = accs2.find((x) => x.id === accB.id) || {}
  eq('账户① 带出 inv_default', a1.inv_default, 'yes')
  eq('账户① 带出中文', a1.inv_text, '有票')

  // ── 6. 收款时标「没票」+ 记这笔里的税
  if (o) {
    r = await call('POST', '/orders/' + o.id + '/receive', { amount: 400, inv: 'no', tax: 46, account_id: accB.id, client_id: 'tax1-' + TAG })
    eq('收款（标没票）状态', r.status, 200)
    const o2 = await findAr(cA, 1000)
    eq('收款后 paid', o2 && o2.paid, 400)
    const fr = await call('GET', '/flows')
    const rows = (fr.d && fr.d.rows) || []
    const hit = rows.filter((x) => String(x.ref_id) === String(o.id) && x.dir === 'in')[0]
    if (!hit) no('流水里没找到这笔收款')
    else {
      eq('流水上记了「没票」', hit.inv_state, 'no')
      eq('流水上中文', hit.inv_text, '没票')
      eq('流水上的税额', hit.tax, 46)
    }
  }

  // ── 7. 税金另外收付：原单欠款一分不动
  if (o) {
    const before = await findAr(cA, 1000)
    r = await call('POST', '/orders/' + o.id + '/receive', { amount: 130, kind: 'tax', inv: 'yes', account_id: accA.id, client_id: 'tax2-' + TAG })
    eq('单独收税金状态', r.status, 200)
    eq('返回 tax_only', r.d && r.d.tax_only, true)
    const after = await findAr(cA, 1000)
    eq('税金不动 paid（还是 400）', after && after.paid, before && before.paid)
    const fr2 = await call('GET', '/flows')
    const taxRow = ((fr2.d && fr2.d.rows) || []).filter((x) => x.ref_type === 'tax_ar' && String(x.ref_id) === String(o.id))[0]
    if (!taxRow) no('流水里没找到税金那一笔')
    else {
      eq('税金流水金额', taxRow.amount, 130)
      eq('税金流水分类', taxRow.category, '税金')
    }
  }

  // ── 8. 应付同样算：含税 9%
  const sA = '税测试供应商' + TAG
  r = await call('POST', '/payables', { supplier: sA, amount: 1090, category: '硫酸', tax_kind: '含税', tax_rate: 9 })
  eq('应付含税建单状态', r.status, 200)
  const p = await findAp(sA)
  if (!p) no('应付单没找到')
  else {
    eq('应付含税 tax_amt（1090-1090/1.09）', p.tax_amt, 90)
    eq('应付含税 tax_net', p.tax_net, 1000)
    r = await call('POST', '/payables/' + p.id + '/pay', { amount: 500, inv: 'no', tax: 41.28, account_id: accB.id, client_id: 'tax3-' + TAG })
    eq('付款（标没票）状态', r.status, 200)
    r = await call('POST', '/payables/' + p.id + '/pay', { amount: 90, kind: 'tax', inv: 'yes', account_id: accA.id, client_id: 'tax4-' + TAG })
    eq('单独付税金状态', r.status, 200)
    const p2 = await findAp(sA)
    eq('税金不动 paid（还是 500）', p2 && p2.paid, 500)
  }

  // ── 9. 本月税金汇总
  r = await call('GET', '/tax-summary?month=' + MONTH)
  eq('税金汇总状态', r.status, 200)
  const ts = r.d || {}
  eq('汇总 ok', ts.ok, true)
  eq('汇总月份', ts.month, MONTH)
  if (!(Number(ts.sales_tax) >= 176)) no('销项税应 ≥ 176（46+130）', ts.sales_tax)
  else ok('销项税 ≥ 176（收款里的 46 + 单独收的 130）')
  if (!(Number(ts.buy_tax) >= 131)) no('进项税应 ≥ 131（41.28+90）', ts.buy_tax)
  else ok('进项税 ≥ 131（付款里的 41.28 + 单独付的 90）')
  eq('净额 = 销项 - 进项', r2(Number(ts.sales_tax) - Number(ts.buy_tax)), ts.net)
  if (!ts.no_inv_out || !(Number(ts.no_inv_out.count) >= 1)) no('没票的支出应 ≥1 笔', ts.no_inv_out)
  else ok('没票的支出统计到了（' + ts.no_inv_out.count + ' 笔 ¥' + ts.no_inv_out.amount + '）')
  if (!Array.isArray(ts.by_account) || !ts.by_account.length) no('按账户分解是空的')
  else ok('按账户分解有 ' + ts.by_account.length + ' 个账户')

  // ── 9.5 不开票收 1000、开票收 1000 + 税点 100（用户的原话口径）
  //        货款照冲这张单，税点单独一笔，而且**不算收入**（代收的钱不是赚的钱）
  const cD = '税点客户' + TAG
  r = await call('POST', '/orders', { customer: cD, item_name: '加工', price: 1000, tax_kind: '不含税', tax_rate: 10 })
  eq('不含税 10% 建单状态', r.status, 200)
  const oD = await findAr(cD, 1000)
  if (!oD) no('税点测试的单没找到')
  else {
    eq('开单时算出的税点（1000×10%）', oD.tax_amt, 100)
    const incBefore = Number(((await call('GET', '/dashboard')).d || {}).month_income || 0)
    r = await call('POST', '/orders/' + oD.id + '/receive', { amount: 1000, tax_extra: 100, inv: 'yes', account_id: accA.id, client_id: 'tex-' + TAG })
    eq('货款+税点一起收的状态', r.status, 200)
    eq('返回里带出另收的税点', r.d && r.d.tax_extra, 100)
    const oD2 = await findAr(cD, 1000)
    eq('货款 1000 全额冲掉这张单', oD2 && oD2.paid, 1000)
    eq('这单结清了', oD2 && r2(Number(oD2.unpaid) || 0), 0)
    const fr3 = await call('GET', '/flows')
    const tRow = ((fr3.d && fr3.d.rows) || []).filter((x) => x.ref_type === 'tax_ar' && String(x.ref_id) === String(oD.id))[0]
    if (!tRow) no('税点那笔流水没记上')
    else eq('税点单独一笔 100', tRow.amount, 100)
    // 代收的税点不算收入：收到 1100，收入只应该涨 1000
    const incAfter = Number(((await call('GET', '/dashboard')).d || {}).month_income || 0)
    eq('本月收入只涨货款 1000（税点不算收入）', r2(incAfter - incBefore), 1000)
  }

  // ── 10. 删单连带删税金流水（否则流水里留孤儿）
  if (o) {
    r = await call('GET', '/flows')
    const before = ((r.d && r.d.rows) || []).filter((x) => String(x.ref_id) === String(o.id)).length
    if (!(before > 0)) no('删单前应该还有流水')
    r = await call('DELETE', '/orders/' + o.id)
    eq('删单状态', r.status, 200)
    const r2b = await call('GET', '/flows')
    const after = ((r2b.d && r2b.d.rows) || []).filter((x) => String(x.ref_id) === String(o.id) && (x.ref_type === 'order' || x.ref_type === 'tax_ar')).length
    eq('删单后这张单的流水（含税金）都清了', after, 0)
  }

  console.log('')
  if (bad.length) {
    console.log(`❌ ${bad.length} 项没过（通过 ${pass} 项）：`)
    bad.forEach((m) => console.log('   · ' + m))
    process.exit(1)
  }
  console.log(`✅ 税和票 ${pass} 项全过`)
}

main().catch((e) => { console.error(e); process.exit(1) })
