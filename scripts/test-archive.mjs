// 报表存档回归：日报 / 月报 / 年报 / 应收 / 应付 / 明细账 / 科目余额表 —— 七种都要能出 Excel
//
// 为什么值得钉住：这几张表是「存下来才算数」的东西。以前只有月报和几处打印页，
// 老板要日报、年报、科目余额表只能自己抄；这些接口一旦 500 或者出个空表，
// 不会有任何报错，只会安静地少一份存档 —— 年底对账才发现没了。
//
// 用法：node scripts/test-archive.mjs [--base http://127.0.0.1:8791] [--key 8888]

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const BASE = arg('base', 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = arg('key', '8888')
const H = { 'X-Access-Key': KEY, 'Content-Type': 'application/json' }
const TAG = '存档' + Date.now().toString(36).replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]).slice(-4)
const TODAY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const MONTH = TODAY.slice(0, 7)
const YEAR = TODAY.slice(0, 4)

let pass = 0
const bad = []
const ok = (m) => { pass++; console.log('  ✅ ' + m) }
const no = (m, d) => { bad.push(m); console.log('  ❌ ' + m + (d === undefined ? '' : ' → ' + JSON.stringify(d))) }
const yes = (label, cond, d) => (cond ? ok(label) : no(label, d))

const call = async (p, key) => {
  const h = { 'X-Access-Key': key || KEY, 'Content-Type': 'application/json' }
  const r = await fetch(BASE + p, { method: 'GET', headers: h })
  const txt = await r.text()
  let d = null
  try { d = JSON.parse(txt) } catch (e) { d = { raw: txt.slice(0, 160) } }
  return { s: r.status, d }
}
const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(body || {}) })
  return { s: r.status, d: await r.json().catch(() => null) }
}

// 每种报表：期望出现的页签名（只查前两个，避免以后加页签就红）
const KINDS = [
  ['daily', '&date=' + TODAY, ['日报摘要', '当天明细']],
  ['monthly', '&month=' + MONTH, ['总览', '利润表']],
  ['yearly', '&year=' + YEAR, [YEAR + ' 年 12 个月', '年末余额']],
  ['ar', '', ['应收台账', '按单位汇总']],
  ['ap', '', ['应付台账', '按单位汇总']],
  ['ledger', '&from=' + MONTH + '-01&to=' + TODAY, null],
  ['trial', '&from=' + MONTH + '-01&to=' + TODAY, ['科目余额表', '余额类科目']]
]

const run = async () => {
  console.log('报表存档（' + BASE + '）')

  // 先造点数据，保证报表里不是空的
  const o = await post('/orders', { customer: TAG + '客户', item_name: '存档测试活', price: 900, cost: 300, date: TODAY })
  yes('造一张应收单', o.s === 200, o.s)
  await post('/expenses', { amount: 123, category: '水电', remark: TAG + '存档测试支出', date: TODAY })
  await post('/payables', { supplier: TAG + '供应商', amount: 456, category: '硫酸', date: TODAY })

  const kinds = await call('/archive-kinds')
  yes('/archive-kinds 返回七种', kinds.s === 200 && (kinds.d.kinds || []).length === 7, kinds.d && (kinds.d.kinds || []).length)

  for (const [kind, q, wants] of KINDS) {
    const r = await call('/archive-pack?kind=' + kind + q)
    if (r.s !== 200 || !r.d.ok) { no('出表「' + kind + '」', r.s + ' ' + JSON.stringify(r.d).slice(0, 160)); continue }
    ok('出表「' + kind + '」 → ' + r.d.name + '（' + r.d.sheets.length + ' 张表）')
    yes('  ' + kind + ' 至少有 1 张表', (r.d.sheets || []).length >= 1, r.d.sheets)
    yes('  ' + kind + ' 的 b64 是 xlsx（PK 头）', String(r.d.b64 || '').slice(0, 2) === 'UE' || String(r.d.b64 || '').startsWith('UEs'), String(r.d.b64 || '').slice(0, 8))
    yes('  ' + kind + ' 体积 > 1KB', Number(r.d.size) > 1000, r.d.size)
    if (wants) {
      const miss = wants.filter((w) => (r.d.sheets || []).indexOf(w) < 0)
      yes('  ' + kind + ' 有这几个页签：' + wants.join(' / '), miss.length === 0, miss)
    }
    if (kind === 'monthly') yes('  月报是 8 张表（总览/利润/资产负债/应收/应付/流水/账龄/到期）', (r.d.sheets || []).length === 8, r.d.sheets)
    if (kind === 'ledger') yes('  明细账按科目分了页签', (r.d.sheets || []).length >= 1, r.d.sheets)
  }

  const wrong = await call('/archive-pack?kind=xxx')
  yes('不认识的报表类型 → 400', wrong.s === 400, wrong.s)

  // 带非法日期不许 500（回落成默认区间）
  const odd = await call('/archive-pack?kind=ledger&from=2026-02-31&to=不是日期')
  yes('日期写错不报 500', odd.s === 200 && odd.d.ok === true, odd.s)

  // 员工/演示口令不许导（跟导出同一类动作）
  const demo = await call('/archive-pack?kind=monthly', 'demo-look')
  yes('演示口令不能导报表', demo.s === 403, demo.s + ' ' + (demo.d && demo.d.code))

  console.log('')
  if (bad.length) {
    console.log('❌ 报表存档 ' + bad.length + ' 项失败：')
    bad.forEach((x) => console.log('   · ' + x))
    process.exit(1)
  }
  console.log('✅ 报表存档 ' + pass + ' 项全部通过')
}

run().catch((e) => { console.error('测试脚本自己挂了：', e); process.exit(1) })
