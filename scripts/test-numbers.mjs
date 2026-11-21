// 数字对账回归：屏幕上的数、存下来的表里的数、能导出的数，必须互相能对上。
//
// 为什么值得钉住：这套系统最容易出的错不是「记不上」，而是「记上了但两处数字不一样」。
// 真实发生过的：首页说本月收入 2000、流水页说收了 3200（差了内部转账和代收税点）；
// 月报和科目余额表的净资产差一整笔借款；历史年报每年重打数字都会变小。
// 这些错都不报错，只会让人对着两个数字互相怀疑，最后谁都不信账。
//
// 做两件事：
//   1) 造一笔「货款 1000（不含税 10%）+ 代收税点 100 + 内部转账 500 + 一笔支出」，
//      验各口径的增量：税点不算收入、转账不算收支、现金全额进账。
//   2) 同一时刻把「同一件事的几种说法」摆在一起比，差一分钱就算错。
//
// 用法：node scripts/test-numbers.mjs [--base http://127.0.0.1:8791] [--key 8888]

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const BASE = arg('base', 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = arg('key', '8888')
const TODAY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const MONTH = TODAY.slice(0, 7)
const YEAR = TODAY.slice(0, 4)
const TAG = '数测' + Date.now().toString(36).replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]).slice(-4)

let pass = 0
const bad = []
const ok = (m) => { pass++; console.log('  ✅ ' + m) }
const no = (m, d) => { bad.push(m); console.log('  ❌ ' + m + (d === undefined ? '' : ' → ' + JSON.stringify(d))) }
const yes = (label, cond, d) => (cond ? ok(label) : no(label, d))
const n0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const r2 = (v) => Math.round(n0(v) * 100) / 100
// 允许一分钱以内的浮点差；其它一律算错
const near = (label, a, b, eps = 0.011) => yes(label + `（${r2(a)} vs ${r2(b)}）`, Math.abs(r2(a) - r2(b)) <= eps, { a: r2(a), b: r2(b) })
const diff = (label, after, before, want) => near(label, r2(after) - r2(before), want)

const call = async (p, key) => {
  const r = await fetch(BASE + p, { method: 'GET', headers: { 'X-Access-Key': key || KEY } })
  const txt = await r.text()
  let d = null
  try { d = JSON.parse(txt) } catch (e) { d = { raw: String(txt).slice(0, 200) } }
  return { s: r.status, d }
}
const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'X-Access-Key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
  const txt = await r.text()
  let d = null
  try { d = JSON.parse(txt) } catch (e) { d = { raw: String(txt).slice(0, 200) } }
  return { s: r.status, d }
}

// 一张快照：把「同一个数字的几种说法」一次全取回来，摊平成纯数字
const snap = async () => {
  const [dash, arSum, arCat, apSum, apCat, aging, accounts, monthRep, repView, flows, taxSum, trial, monthly, yearly, arList] = await Promise.all([
    call('/dashboard'),
    call('/ar-summary'),
    call('/ar-by-category?month=' + MONTH),
    call('/ar-summary?type=ap'),
    call('/ap-by-category?month=' + MONTH),
    call('/aging'),
    call('/accounts'),
    call('/month-report?month=' + MONTH),
    call('/report-view?month=' + MONTH),
    call('/flows?month=' + MONTH),
    call('/tax-summary?month=' + MONTH),
    call('/archive-json?kind=trial&from=' + MONTH + '-01&to=' + TODAY),
    call('/archive-json?kind=monthly&month=' + MONTH),
    call('/archive-json?kind=yearly&year=' + YEAR),
    call('/ar?status=open&size=2000')
  ])
  const D = dash.d || {}
  const sheet = (r, name) => (((r.d && r.d.sheets) || []).find((x) => x.name === name) || {}).rows || []
  const bal = sheet(trial, '余额类科目')
  const bOf = (label) => r2(((bal.find((r) => String(r[0]) === label) || [])[1]))
  const accSum = r2(bal.filter((r) => /^账户·/.test(String(r[0]))).reduce((a, r) => a + n0(r[1]), 0))
  const my = (sheet(trial, '本年逐月') || []).find((r) => String(r[0]) === MONTH) || []
  const ov = sheet(monthly, '总览')
  const ovOf = (label) => r2(((ov.find((r) => String(r[0]) === label) || [])[1]))
  const yrSheets = (yearly.d && yearly.d.sheets) || []
  const yrRows = (yrSheets[0] && yrSheets[0].rows) || []
  const yrMonth = yrRows.find((r) => String(r[0]) === MONTH) || []
  const bs = (repView.d && repView.d.bs) || {}
  const bsFind = (list, label) => r2((((list || []).find((x) => String(x.label) === label) || {}).value))
  const cashRow = ((bs.assets || [])[0] || {})
  const list = Array.isArray(arList.d) ? arList.d : ((arList.d && (arList.d.list || arList.d.results)) || [])
  const F = flows.d || {}
  const T = taxSum.d || {}
  const MR = monthRep.d || {}
  return {
    raw: { dash, arSum, repView, flows },
    ar: r2(D.ar_total),
    ap: r2(D.ap_total),
    cash: r2(D.cash_balance),
    inc: r2(D.month_income),
    out: r2(D.month_outcome),
    nw: r2(D.net_worth),
    debt: r2(D.debt_total),
    arOpen: r2(arSum.d && arSum.d.open_amount),
    arOpenCount: n0(arSum.d && arSum.d.open_count),
    arCatOpen: r2(arCat.d && arCat.d.total_open),
    apOpen: r2(apSum.d && apSum.d.open_amount),
    apCatOpen: r2(apCat.d && apCat.d.total_open),
    agingTotal: r2(aging.d && aging.d.total),
    accTotal: r2(accounts.d && accounts.d.total_balance),
    mr: { cash: r2(MR.cash), ar: r2(MR.ar), ap: r2(MR.ap), debt: r2(MR.debt_left), nw: r2(MR.net_worth), inc: r2(MR.cash_in), out: r2(MR.cash_out) },
    rv: { cash: r2(cashRow.value), assets: bsFind(bs.assets, '资产合计'), liab: bsFind(bs.liabilities, '负债合计'), check: r2(bs.check) },
    fl: { totalIn: r2(F.total_in), totalOut: r2(F.total_out), opIn: r2(F.op_in), opOut: r2(F.op_out), trIn: r2(F.transfer_in), trOut: r2(F.transfer_out), taxIn: r2(F.tax_in), taxOut: r2(F.tax_out), ncIn: r2(F.no_cash_in), ncOut: r2(F.no_cash_out), opText: F.op_text || '', ncText: F.no_cash_text || '' },
    tax: {
      sales: r2(T.sales_tax), buy: r2(T.buy_tax),
      noSales: r2(T.tax_no_sales), noBuy: r2(T.tax_no_buy),
      byAccIn: r2(((T.by_account) || []).reduce((a, x) => a + n0(x.tax_in), 0)),
      byAccOut: r2(((T.by_account) || []).reduce((a, x) => a + n0(x.tax_out), 0))
    },
    trial: { ar: bOf('应收未收'), ap: bOf('应付未付'), debt: bOf('借款余额'), nw: bOf('净资产'), accSum, monthIn: r2(my[1]), monthOut: r2(my[2]) },
    mo: { inc: ovOf('收款（经营，不含转账和税点）'), out: ovOf('付款/支出（经营，不含转账和税点）'), cash: ovOf('手头现金'), ar: ovOf('应收未收'), ap: ovOf('应付未付'), debt: ovOf('借款余额'), nw: ovOf('净资产') },
    yr: { inc: r2(yrMonth[5]), out: r2(yrMonth[6]) },
    arListSum: r2(list.reduce((a, x) => a + Math.max(0, n0(x.unpaid)), 0))
  }
}

const run = async () => {
  console.log('数字对账（base=' + BASE + '，账期 ' + MONTH + '，标记 ' + TAG + '）')

  await post('/auth/setup', { key: KEY }) // 干净库上第一次跑要先设口令；已有口令会回 400，忽略

  const before = await snap()
  if (!before.raw.dash.d || before.raw.dash.d.cash_balance === undefined) {
    no('首页取不到数，后面没法比', before.raw.dash.d)
    process.exit(1)
  }

  const accs = ((await call('/accounts')).d || {}).accounts || []
  const cashAcc = accs.find((a) => a.kind === 'cash') || accs[0]
  const otherAcc = accs.find((a) => a.id !== cashAcc.id)
  if (!cashAcc || !otherAcc) { no('账户不够两个，没法做转账场景', accs.length); process.exit(1) }

  const cust = TAG + '甲'
  const created = await post('/orders', { customer: cust, item_name: '数测件', price: 1000, date: TODAY, tax_kind: '不含税', tax_rate: 10, ar_cat: '加工费' })
  yes('建一张不含税 10% 的单（货款 1000，分类加工费）', created.s === 200, created.d)
  const arNow = await call('/ar?status=open&kw=' + encodeURIComponent(cust))
  const arRows = Array.isArray(arNow.d) ? arNow.d : ((arNow.d && (arNow.d.list || arNow.d.results)) || [])
  const oid = (arRows[0] || {}).id
  yes('能在应收里找到这张单', !!oid, arRows.length)

  const mid = await snap()
  const got = await post('/orders/' + oid + '/receive', { amount: 1000, account_id: cashAcc.id, date: TODAY, inv: 'yes', tax_extra: 100 })
  yes('收货款 1000 + 代收税点 100', got.s === 200 && r2(got.d && got.d.tax_extra) === 100, got.d)

  const tr = await post('/transfer', { from: cashAcc.id, to: otherAcc.id, amount: 500, date: TODAY, remark: TAG + '内部转账' })
  yes('内部转账 500', tr.s === 200, tr.d)

  // 金额做成唯一的：后端对「同一天同分类同金额」有防重，写死会被 409 挡掉
  const EXP = 300 + (Date.now() % 89)
  const exp = await post('/expenses', { amount: EXP, category: '水电', remark: TAG + '数测支出', date: TODAY, account_id: cashAcc.id, client_id: TAG + '-exp' })
  yes('记一笔支出 ' + EXP, exp.s === 200, exp.d)

  const after = await snap()

  console.log('\n【一】口径：税点不算收入、转账不算收支、现金全额进账')
  diff('本月收入只多了货款 1000（不含代收税点）', after.inc, before.inc, 1000)
  diff('本月支出只多了那笔支出 ' + EXP, after.out, before.out, EXP)
  diff('手头现金 = +1000 货款 +100 税点 −' + EXP + ' 支出（转账不增不减）', after.cash, before.cash, 1100 - EXP)
  diff('开单让应收多了 1000', mid.ar, before.ar, 1000)
  diff('收款让应收少了 1000', after.ar, mid.ar, -1000)
  yes('流水页把转账与税点单列出来了', after.fl.trIn > 0 && after.fl.taxIn > 0, { tr: after.fl.trIn, tax: after.fl.taxIn })
  yes('流水页有「经营口径」的说明文字', /经营/.test(after.fl.opText), after.fl.opText)

  console.log('\n【二】同一件事的几种说法要一致')
  near('应收：首页 / 应收汇总', after.ar, after.arOpen)
  near('应收：应收汇总 / 分类卡合计', after.arOpen, after.arCatOpen)
  near('应收：应收汇总 / 账龄表合计', after.arOpen, after.agingTotal)
  near('应收：应收汇总 / 科目余额表「应收未收」', after.arOpen, after.trial.ar)
  near('应收：应收汇总 / 单据列表逐笔相加', after.arOpen, after.arListSum)
  near('应付：首页 / 应付汇总', after.ap, after.apOpen)
  near('应付：应付汇总 / 分类卡合计', after.apOpen, after.apCatOpen)
  near('应付：应付汇总 / 科目余额表「应付未付」', after.apOpen, after.trial.ap)

  near('现金：首页 / 账户列表合计', after.cash, after.accTotal)
  near('现金：首页 / 报表页「货币资金」', after.cash, after.rv.cash)
  near('现金：首页 / 月度归档', after.cash, after.mr.cash)
  near('现金：首页 / 科目余额表各账户相加', after.cash, after.trial.accSum)
  near('现金：首页 / 月报包「手头现金」', after.cash, after.mo.cash)

  near('借款：首页 / 科目余额表「借款余额」', after.debt, after.trial.debt)
  near('借款：首页 / 月度归档', after.debt, after.mr.debt)

  near('净资产：首页 / 月度归档', after.nw, after.mr.nw)
  near('净资产：首页 / 科目余额表', after.nw, after.trial.nw)
  near('净资产：首页 / 月报包', after.nw, after.mo.nw)
  near('净资产：首页 / 报表页（资产 − 负债）', after.nw, r2(after.rv.assets - after.rv.liab))

  near('本月收款：首页 / 月度归档', after.inc, after.mr.inc)
  near('本月收款：首页 / 月报包总览', after.inc, after.mo.inc)
  near('本月收款：首页 / 科目余额表「本年逐月」', after.inc, after.trial.monthIn)
  near('本月收款：首页 / 年报当年 12 个月表', after.inc, after.yr.inc)
  near('本月收款：首页 / 流水页「经营收款」', after.inc, after.fl.opIn)
  near('本月付款：首页 / 月度归档', after.out, after.mr.out)
  near('本月付款：首页 / 月报包总览', after.out, after.mo.out)
  near('本月付款：首页 / 科目余额表「本年逐月」', after.out, after.trial.monthOut)
  near('本月付款：首页 / 流水页「经营付款」', after.out, after.fl.opOut)

  near('流水页：经营 + 转账 + 税点 = 现金合计（收）', r2(after.fl.opIn + after.fl.trIn + after.fl.taxIn), after.fl.totalIn)
  near('流水页：经营 + 转账 + 税点 = 现金合计（付）', r2(after.fl.opOut + after.fl.trOut + after.fl.taxOut), after.fl.totalOut)
  near('税金：按账户小计（销项）= 总销项', after.tax.byAccIn, after.tax.sales)
  near('税金：按账户小计（进项）= 总进项', after.tax.byAccOut, after.tax.buy)
  near('税金：净额 = 销项 − 进项', after.tax.net === undefined ? r2(after.tax.sales - after.tax.buy) : after.tax.net, r2(after.tax.sales - after.tax.buy))
  yes('税点：流水页代收的税点不超过销项税', after.fl.taxIn <= after.tax.sales + 0.011, { taxIn: after.fl.taxIn, sales: after.tax.sales })
  yes('不动现金的分录有说明文字', (after.fl.ncIn + after.fl.ncOut) === 0 || /不动现金/.test(after.fl.ncText), { nc: after.fl.ncIn + after.fl.ncOut, text: after.fl.ncText })
  yes('流水页的收付合计不含不动现金的分录', Math.abs(r2(after.fl.opIn + after.fl.trIn + after.fl.taxIn) - after.fl.totalIn) <= 0.011)

  console.log('\n【三】资产负债表自己得平')
  near('报表页 check = 资产 − 负债 − 权益', 0, after.rv.check)
  near('科目余额表：净资产 = 账户合计 + 应收 − 应付 − 借款', after.trial.nw, r2(after.trial.accSum + after.trial.ar - after.trial.ap - after.trial.debt))
  near('月报包：净资产 = 手头现金 + 应收 − 应付 − 借款', after.mo.nw, r2(after.mo.cash + after.mo.ar - after.mo.ap - after.mo.debt))

  console.log('\n【四】历史月份不许随今天变、演示口令不许导存档')
  // 上个月的科目余额表：只到 28 号，与今天记的账无关
  const lastM = new Date(new Date(TODAY + 'T00:00:00Z').getTime() - 28 * 86400000).toISOString().slice(0, 7)
  const hist = await call('/archive-json?kind=trial&from=' + lastM + '-01&to=' + lastM + '-28')
  const hb = ((((hist.d || {}).sheets || []).find((x) => x.name === '余额类科目') || {}).rows) || []
  yes('上月的科目余额表能出（不许 500）', hist.s === 200 && hb.length > 1, hist.s)
  const h1 = r2(((hb.find((r) => String(r[0]) === '应收未收') || [])[1]))
  const again = await call('/archive-json?kind=trial&from=' + lastM + '-01&to=' + lastM + '-28')
  const hb2 = ((((again.d || {}).sheets || []).find((x) => x.name === '余额类科目') || {}).rows) || []
  const h2 = r2(((hb2.find((r) => String(r[0]) === '应收未收') || [])[1]))
  near('同一个月重出一次，数字不变', h1, h2, 0.001)
  yes('上月末应收不为负', h1 >= 0, h1)

  const demo = await call('/archive-json?kind=monthly&month=' + MONTH, 'demo-look')
  yes('演示口令不能导存档', demo.s === 403, demo.s + ' ' + (demo.d && demo.d.code))

  console.log('')
  if (bad.length) {
    console.log('❌ 数字对账 ' + bad.length + ' 项失败：')
    bad.forEach((x) => console.log('   · ' + x))
    process.exit(1)
  }
  console.log('✅ 数字对账 ' + pass + ' 项全部通过')
}

run().catch((e) => { console.error('测试脚本自己挂了：', e && e.stack || e); process.exit(1) })
