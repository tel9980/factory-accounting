// 应付分类回归测试
//
// 为什么要有这个：这家厂应付的不是「货款」这种笼统东西，是硫酸、磷酸、硝酸、染料、
// 除油剂、包装、报纸这些化工辅料，还有外发加工费。分类要是导不进去、或者导进去写歪了，
// 「这个月硫酸花了多少」就永远算不出来，而且不会报错——只是数字悄悄归到「未分类」。
//
// 断言：
//   1. 应付模板第 2 列是「分类」，并且带下拉（dv=true）
//   2. 新模板（供应商, 分类, 金额）→ 分类写进去了
//   3. 老模板（供应商, 金额, 备注）→ 金额照样对，分类空着（不能因为加了一列就把老文件导坏）
//   4. 分类写法宽松：98硫酸 / 硫酸(工业) / 染料费 都归到标准分类
//   5. 手记一笔带分类的应付，列表里能按分类筛出来
//   6. /ap-by-category 按分类汇总：本月新增、本月已付、还欠
//
// 用法：node scripts/test-apcat.mjs [--base http://127.0.0.1:8791] [--key 8888]

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const BASE = arg('base', 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = arg('key', '8888')
const H = { 'X-Access-Key': KEY, 'Content-Type': 'application/json' }

// 供应商名带随机后缀：/payables 有「同供应商同金额 7 天内提醒」的防重。
// 后缀只用字母：粘贴导入是「按空格拆词、把带数字的词当金额」的，
// 名字里混进数字会被当成金额，把真金额挤到后面去（老坑，smoke-write 也踩过）。
const TAG = '分类测试' + Date.now().toString(36).replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]).slice(-4)

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
const apRows = async (q) => {
  const r = await call('GET', '/ap?status=all&limit=200' + (q || ''))
  return Array.isArray(r.d) ? r.d : []
}

const main = async () => {
  console.log('应付分类（硫酸/染料/外发加工费…）')

  // 1. 模板：分类在第 2 列，且带下拉
  const tpl = await call('GET', '/import-template-xlsx?type=ap')
  eq('模板下载', tpl.status, 200)
  eq('模板名', (tpl.d && tpl.d.name) || '', '应付导入模板.xlsx')
  eq('模板带分类下拉', !!(tpl.d && tpl.d.dv), true)

  // 2. 新模板粘贴（供应商 分类 金额 备注）：分类要认出来
  const newText = `${TAG}化工 硫酸 2000 98%一吨\n${TAG}外协厂 外发加工费 3000`
  const pv = await call('POST', '/parse-import', { type: 'ap', text: newText })
  eq('预览认出行数', (pv.d && pv.d.count) || 0, 2)
  eq('第 1 行分类', (pv.d && pv.d.rows && pv.d.rows[0] && pv.d.rows[0].category) || '', '硫酸')
  eq('第 1 行金额', (pv.d && pv.d.rows && pv.d.rows[0] && pv.d.rows[0].amount) || 0, 2000)
  eq('第 2 行分类', (pv.d && pv.d.rows && pv.d.rows[1] && pv.d.rows[1].category) || '', '外发加工费')

  const im1 = await call('POST', '/import-rows', { type: 'ap', text: newText })
  eq('入账行数', (im1.d && im1.d.imported) || 0, 2)
  const r1 = await apRows('&kw=' + encodeURIComponent(TAG + '化工'))
  eq('落库后能按供应商搜到', r1.length >= 1, true)
  eq('落库分类 = 硫酸', (r1[0] && r1[0].category) || '', '硫酸')
  eq('落库金额 = 2000', (r1[0] && r1[0].amount) || 0, 2000)

  // 3. 老模板（供应商 金额 备注）：金额不能错位
  const oldText = `${TAG}老供应商 1500 老格式备注`
  const pvOld = await call('POST', '/parse-import', { type: 'ap', text: oldText })
  eq('老格式金额', (pvOld.d && pvOld.d.rows && pvOld.d.rows[0] && pvOld.d.rows[0].amount) || 0, 1500)
  eq('老格式分类为空', (pvOld.d && pvOld.d.rows && pvOld.d.rows[0] && pvOld.d.rows[0].category) || '', '')
  const im2 = await call('POST', '/import-rows', { type: 'ap', text: oldText })
  eq('老格式入账', (im2.d && im2.d.imported) || 0, 1)
  const r2 = await apRows('&kw=' + encodeURIComponent(TAG + '老供应商'))
  eq('老格式落库金额 = 1500', (r2[0] && r2[0].amount) || 0, 1500)

  // 3b. Excel 老文件走的是同一套（[供应商, 金额, 备注] 数组），也要能导
  const im3 = await call('POST', '/import-rows', {
    type: 'ap',
    rows: [{ ok: true, party: TAG + '数组供应商', amount: 700, item: '数组老格式' }]
  })
  eq('数组老格式入账', (im3.d && im3.d.imported) || 0, 1)
  const r3 = await apRows('&kw=' + encodeURIComponent(TAG + '数组供应商'))
  eq('数组老格式金额 = 700', (r3[0] && r3[0].amount) || 0, 700)

  // 4. 分类写法宽松：98硫酸 / 硫酸(工业) / 染料费
  const loose = await call('POST', '/parse-import', { type: 'ap', text: `${TAG}甲 98硫酸 100\n${TAG}乙 硫酸(工业) 100\n${TAG}丙 染料费 100` })
  const lr = (loose.d && loose.d.rows) || []
  eq('「98硫酸」归到硫酸', (lr[0] && lr[0].category) || '', '硫酸')
  eq('「硫酸(工业)」归到硫酸', (lr[1] && lr[1].category) || '', '硫酸')
  eq('「染料费」归到染料', (lr[2] && lr[2].category) || '', '染料')

  // 4b. 名字里带数字（「王五金2店」这种很常见）：金额不能跟着错
  const digit = await call('POST', '/parse-import', { type: 'ap', text: `${TAG}王五金2店 硫酸 2000 3号库` })
  const dr = (digit.d && digit.d.rows) || []
  eq('名字带数字时金额仍是 2000', (dr[0] && dr[0].amount) || 0, 2000)
  eq('名字带数字时分类仍是硫酸', (dr[0] && dr[0].category) || '', '硫酸')

  // 4c. 带单位的金额：5000元 / 3.5万
  const unit = await call('POST', '/parse-import', { type: 'ap', text: `${TAG}单位甲 染料 5000元\n${TAG}单位乙 染料 3.5万` })
  const ur = (unit.d && unit.d.rows) || []
  eq('「5000元」= 5000', (ur[0] && ur[0].amount) || 0, 5000)
  eq('「3.5万」= 35000', (ur[1] && ur[1].amount) || 0, 35000)

  // 5. 手记一笔带分类的，能按分类筛
  const add = await call('POST', '/payables', { supplier: TAG + '手记', amount: 888, category: '报纸', remark: '报纸款' })
  eq('手记带分类', add.status, 200)
  const byCat = await apRows('&cat=' + encodeURIComponent('报纸'))
  eq('按分类筛出报纸', byCat.some((x) => x.supplier === TAG + '手记'), true)

  // 6. 分类汇总
  const sum = await call('GET', '/ap-by-category')
  eq('分类汇总状态', sum.status, 200)
  const rows = (sum.d && sum.d.rows) || []
  const sulfuric = rows.find((x) => x.cat === '硫酸')
  eq('汇总里有硫酸', !!sulfuric, true)
  eq('硫酸本月新增 ≥ 2000', (sulfuric && sulfuric.month_add) >= 2000, true)
  const outsource = rows.find((x) => x.cat === '外发加工费')
  eq('汇总里有外发加工费', !!outsource, true)
  eq('汇总合计 > 0', (sum.d && sum.d.total_add) > 0, true)
  console.log('  汇总文案：' + ((sum.d && sum.d.text) || ''))

  console.log('')
  if (bad.length) {
    console.log(`❌ 应付分类：${pass} 项通过，${bad.length} 项失败`)
    for (const b of bad) console.log('   · ' + b)
    process.exit(1)
  }
  console.log(`✅ 应付分类：${pass} 项全部通过`)
}

main().catch((e) => { console.error('❌ 跑挂了：' + (e && e.stack || e)); process.exit(1) })
