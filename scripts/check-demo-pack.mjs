#!/usr/bin/env node
// 演示账套（给新手照着做的那份）不能悄悄变样：node scripts/check-demo-pack.mjs
//
// 为什么要有它：docs/演示账套/模拟账套-2026-04至11.json 和 docs/新手照着做-完整账套演练.md
// 是一对 —— 文档里写满了「4 月接单额 96,390」「全年净利 −296,212.22」「家底 32,218.50」。
// 谁重新生成一次演示账套（改了 scripts/mock-data.mjs 的日期或金额），文件里的数就变了，
// 而文档还停在旧数字上：新手照着填，对不上，会以为自己错了。
// 所以这里把「文件算出来的数」和「文档里写的数」两边都钉住。
//
// 三件事：
//   1. 文件本身自洽（counts / rows_total / 会计恒等式 / 现金余额）
//   2. 文件的数与文档里那张月度表、全年结论逐个对得上
//   3. 文档里确实印着这几个关键数字（防止改了文件忘了改文档）
//
// 只用 Node 内置模块（CI 的 check job 里没装依赖）。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const PKG = path.join(ROOT, 'docs/演示账套/模拟账套-2026-04至11.json')
const DOC = path.join(ROOT, 'docs/新手照着做-完整账套演练.md')

function fail(msg) { console.log(`  ❌ ${msg}`); process.exitCode = 1 }
function ok(msg) { console.log(`  ✅ ${msg}`) }
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const money = (n) => r2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

if (!fs.existsSync(PKG)) { console.log(`  ❌ 找不到演示账套：${path.relative(ROOT, PKG)}`); process.exit(1) }
if (!fs.existsSync(DOC)) { console.log(`  ❌ 找不到配套文档：${path.relative(ROOT, DOC)}`); process.exit(1) }

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'))
const doc = fs.readFileSync(DOC, 'utf8')
const T = pkg.tables || {}
const rows = (k) => T[k] || []

console.log('\n[1] 文件与自身清单一致')
const realCount = Object.keys(T).reduce((a, k) => a + rows(k).length, 0)
if (pkg.kind !== 'factory-accounting-full') fail(`kind 应为 factory-accounting-full，实际是 ${pkg.kind}`)
else ok('kind = factory-accounting-full（能直接喂给 /import-all）')
if (pkg.table_count !== Object.keys(T).length) fail(`table_count 写 ${pkg.table_count}，实际 ${Object.keys(T).length} 张表`)
else ok(`${pkg.table_count} 张表，与清单一致`)
if (pkg.rows_total !== realCount) fail(`rows_total 写 ${pkg.rows_total}，实际 ${realCount} 行（删过表就要重算，别留旧数）`)
else ok(`${pkg.rows_total} 行，与逐表行数一致`)
const badCount = Object.entries(pkg.counts || {}).filter(([k, v]) => rows(k).length !== v)
if (badCount.length) fail(`counts 与逐表行数不一致：${badCount.map(([k, v]) => `${k} 写 ${v} 实际 ${rows(k).length}`).join('、')}`)
else ok('counts 逐表对得上')

console.log('\n[2] 里面没有能进账的凭据')
// 语义规则：设置项名字沾 key/secret/password/token/pin/hash/code 的都算凭据
const CRED = /(key|secret|salt|pass|token|pin|hash|code|auth)/i
const credSettings = rows('settings').filter((r) => CRED.test(String(r.key || '')))
if (credSettings.length) fail(`settings 里还有凭据类键：${credSettings.map((r) => r.key).join('、')} —— 删掉再发`)
else ok('settings 里没有口令 / 密钥类键（导入不会盖掉别人的口令）')
if (rows('wx_users').length) fail(`wx_users 有 ${rows('wx_users').length} 行（微信身份），演示包装这些没意义，删掉`)
else ok('没有 wx_users')
if (rows('auth_fails').length) fail('auth_fails 非空（别人的失败登录记录不该往外发）')
else ok('没有登录失败记录')
// 员工口令是演示值，必须明说，否则新手以为是真口令
const staff = rows('staff_users')
if (!staff.length) fail('没有员工账号 —— 文档第 12 步要让新手看到员工视角，得留 2 个')
else if (!/123456/.test(doc)) fail('文档没写员工口令是 123456（演示用），新手进不去员工视角')
else ok(`${staff.length} 个员工账号，文档写明了演示口令`)

console.log('\n[3] 规模与文档一致')
const sum = (arr, f) => r2(arr.reduce((a, x) => a + (Number(f(x)) || 0), 0))
const orders = rows('orders')
const payables = rows('payables')
const ledger = rows('ledger')
const want = [
  ['订单数', orders.length, 360],
  ['接单额', sum(orders, (o) => o.price), 817740],
  ['应付单数', payables.length, 176],
  ['收付流水', ledger.length, 587],
  ['客户数', new Set(orders.map((o) => o.customer)).size, 12],
  ['供应商数', new Set(payables.map((p) => p.supplier)).size, 8],
  ['设备数', rows('assets').length, 4],
  ['材料出入库', rows('material_moves').length, 48],
  ['外协单', rows('outsourcing').length, 32],
  ['外协已回货', rows('outsourcing').filter((o) => o.back_date).length, 20],
  ['发票', rows('invoices').length, 16],
  ['记工', rows('wage_records').length, 16],
  ['工资扣款', rows('wage_deduct').length, 1],
  ['工资发放', rows('wage_pays').length, 12],
  ['预收（客户先给的钱）', sum(rows('advances').filter((a) => a.type === 'in'), (a) => a.amount), 18000],
  ['预付（先给供应商的钱）', sum(rows('advances').filter((a) => a.type === 'out'), (a) => a.amount), 30000],
  ['预付费用（房租押金）', sum(rows('prepaids'), (p) => p.total), 140000],
  ['已锁月份', rows('month_lock').length, 6],
]
let bad3 = 0
for (const [name, got, exp] of want) {
  if (r2(got) !== r2(exp)) { fail(`${name}：文件里是 ${got}，文档写 ${exp}`); bad3++ }
}
if (!bad3) ok(`${want.length} 项规模全部与文档一致（360 单 / 817,740 / 176 应付 / 587 流水 …）`)
const lockMonths = rows('month_lock').map((r) => r.month).sort()
if (lockMonths.join(',') !== '2026-04,2026-05,2026-06,2026-07,2026-08,2026-09') fail(`锁定的月份是 ${lockMonths.join(',')}，文档写的是 4～9 月`)
else ok('锁定 2026-04～09（6 个月），10、11 月可写 —— 与文档一致')

console.log('\n[4] 逐月数字与文档里那张表一致')
// 文档那张表的列：单数 / 接单额 / 材料 / 费用（材料之外）/ 折旧摊销预提 / 核销 / 净利 / 实收 / 实付
const EXPECT = [
  ['2026-04', 45, 96390, 60945.30, 57250, 1425, 0, -23230.30, 324480.50, 66650.50],
  ['2026-05', 45, 98055, 61994.25, 57606, 3483.33, 0, -25028.58, 97879, 88316.50],
  ['2026-06', 45, 99720, 63043.20, 57962, 24644.44, 0, -45929.64, 94780.50, 224884],
  ['2026-07', 45, 101385, 64092.15, 58318, 24644.44, 0, -45669.59, 101435, 88512.50],
  ['2026-08', 45, 103050, 65141.10, 56674, 24834.44, 0, -43599.54, 91124.50, 88109],
  ['2026-09', 45, 104715, 66190.05, 57030, 24834.44, 0, -43339.49, 103462, 90511],
  ['2026-10', 45, 106380, 67239, 47422, 24834.44, 0, -33115.44, 90046, 154653.50],
  ['2026-11', 45, 108045, 68287.95, 47524, 25740.69, 7303, -36299.64, 70572, 63918],
]
// 口径与 /year-summary 一致：
//   费用 = 所有 expense/fixed 流水（含 cash=0 的「报销冲借支」，这是全系统的口径）
//   折旧摊销预提 = cash=0 的 dep + amort + debt_int
//   净利 = 接单 − 材料 − 费用 − 折旧摊销预提 − 核销 + 豁免
//   实收/实付 = cash=1 的流水，转账两边都不算
const monthOf = (x) => String(x.month || x.created_at || '').slice(0, 7)
const woOf = (m, t) => sum(rows('writeoffs').filter((w) => monthOf(w) === m && w.ref_type === t), (w) => w.amount)
const cashOf = (m, dir) => sum(ledger.filter((r) => monthOf(r) === m && r.cash === 1 && dir === r.direction && r.ref_type !== 'transfer'), (r) => r.amount)

let bad4 = 0
for (const [m, cnt, add, cost, fexp, dam, wo, prof, cin, cout] of EXPECT) {
  const o = orders.filter((x) => monthOf(x) === m)
  const gAdd = sum(o, (x) => x.price)
  const gCost = sum(o, (x) => x.cost)
  const gExp = sum(ledger.filter((r) => monthOf(r) === m && r.direction === 'out' && (r.ref_type === 'expense' || r.ref_type === 'fixed')), (r) => r.amount)
  const gDam = sum(ledger.filter((r) => monthOf(r) === m && r.cash === 0 && r.direction === 'out' && ['dep', 'amort', 'debt_int'].includes(r.ref_type)), (r) => r.amount)
  const gWo = woOf(m, 'order'), gWoG = woOf(m, 'payable')
  const gProf = r2(gAdd - gCost - gExp - gDam - gWo + gWoG)
  const gIn = cashOf(m, 'in'), gOut = cashOf(m, 'out')
  const pairs = [
    ['单数', o.length, cnt], ['接单额', gAdd, add], ['材料', gCost, cost], ['费用', gExp, fexp],
    ['折旧摊销预提', gDam, dam], ['核销', gWo, wo], ['净利', gProf, prof], ['实收', gIn, cin], ['实付', gOut, cout],
  ]
  for (const [k, got, exp] of pairs) {
    if (Math.abs(r2(got) - r2(exp)) > 0.011) { fail(`${m} 的${k}：文件里算出来 ${got}，文档写 ${exp}`); bad4++ }
  }
}
if (!bad4) ok('8 个月 × 9 列全部对得上（含 4～7 月每月那笔 2,000 报销冲借支）')

console.log('\n[5] 全年结论与家底')
const totals = {
  add: sum(orders, (o) => o.price),
  cost: sum(orders, (o) => o.cost),
  exp: sum(ledger.filter((r) => r.direction === 'out' && (r.ref_type === 'expense' || r.ref_type === 'fixed')), (r) => r.amount),
  dam: sum(ledger.filter((r) => r.cash === 0 && r.direction === 'out' && ['dep', 'amort', 'debt_int'].includes(r.ref_type)), (r) => r.amount),
  wo: woOf('2026-11', 'order'),
  woG: woOf('2026-11', 'payable'),
}
totals.profit = r2(totals.add - totals.cost - totals.exp - totals.dam - totals.wo + totals.woG)
const opening = sum(rows('accounts'), (a) => a.opening)
const cash = r2(opening + sum(ledger.filter((r) => r.cash === 1 && r.ref_type !== 'transfer'), (r) => (r.direction === 'in' ? Number(r.amount) : -Number(r.amount))))
const ar = sum(orders, (o) => Math.max(0, Number(o.price) - Number(o.paid || 0) - Number(o.written_off || 0)))
const ap = sum(payables, (p) => Math.max(0, Number(p.amount) - Number(p.paid || 0) - Number(p.written_off || 0)))
// 借款余额：debts 表里没有「已还本金」这一列（那是接口算出来的），要拿 debt_repays 自己减
const debt = sum(rows('debts'), (d) => {
  const back = sum(rows('debt_repays').filter((r) => Number(r.debt_id) === Number(d.id) && r.kind === 'principal'), (r) => r.amount)
  return Math.max(0, Number(d.principal) - back)
})
const advIn = sum(rows('advances').filter((a) => a.type === 'in'), (a) => Number(a.amount) - Number(a.used || 0))
const advOut = sum(rows('advances').filter((a) => a.type === 'out'), (a) => Number(a.amount) - Number(a.used || 0))
const nw = r2(cash + ar - ap - debt - advIn + advOut)
const yearChecks = [
  ['全年净利', totals.profit, -296212.22],
  ['全年接单额', totals.add, 817740],
  ['全年材料', totals.cost, 516933],
  ['全年费用', totals.exp, 439786],
  ['全年折旧摊销预提', totals.dam, 154441.22],
  ['应收核销', totals.wo, 7303],
  ['应付豁免', totals.woG, 4511],
  ['期末现金', cash, 163224.50],
  ['应收未结', ar, 158574.50],
  ['应付未结', ap, 57011.50],
  ['借款余额', debt, 250000],
  ['预收余额', advIn, 10917],
  ['预付余额', advOut, 28348],
  ['净资产', nw, 32218.50],
]
let bad5 = 0
for (const [k, got, exp] of yearChecks) {
  if (Math.abs(r2(got) - r2(exp)) > 0.011) { fail(`${k}：文件里算出来 ${got}，文档写 ${exp}`); bad5++ }
}
if (!bad5) ok(`${yearChecks.length} 项年度结论全部一致（净利 −296,212.22 / 现金 163,224.50 / 净资产 32,218.50）`)

console.log('\n[6] 文档里确实印着这些数（改了文件就得改文档）')
const mustShow = ['817,740', '516,933', '439,786', '154,441.22', '−296,212.22', '163,224.50', '158,574.50', '57,011.50', '32,218.50', '7,303', '4,511', '10,917', '28,348', '96,390', '108,045']
const missing = mustShow.filter((x) => !doc.includes(x))
if (missing.length) fail(`文档里找不到：${missing.join('、')} —— 文件变了还是文档变了？两边对齐再提交`)
else ok(`${mustShow.length} 个关键数字都能在文档里找到`)

console.log('\n[7] 会计恒等式与现金链路')
const idOk = Math.abs(totals.profit - (totals.add - totals.cost - totals.exp - totals.dam - totals.wo + totals.woG)) < 0.011
if (!idOk) fail('净利 ≠ 接单 − 材料 − 费用 − 折旧摊销预提 − 核销 + 豁免')
else ok('净利 = 接单 − 材料 − 费用 − 折旧摊销预提 − 核销 + 豁免（账是平的）')
// 只有真金白银的流水才必须挂账户：折旧 / 摊销 / 预提 / 抵扣这些 cash=0 的行，本来就不该动任何账户
const noAcct = ledger.filter((r) => r.cash === 1 && !rows('accounts').some((a) => Number(a.id) === Number(r.account_id)))
if (noAcct.length) fail(`${noAcct.length} 条真金白银的流水没挂账户（导入后账户余额会缺席）`)
else ok('每条真金白银的流水都挂在某个账户上（cash=0 的折旧摊销不挂账户，是对的）')
const ordersWithLedger = new Set(ledger.filter((r) => r.ref_type === 'order').map((r) => Number(r.ref_id)))
const paidOrders = orders.filter((o) => Number(o.paid || 0) > 0).map((o) => Number(o.id))
const ghost = paidOrders.filter((id) => !ordersWithLedger.has(id))
if (ghost.length) fail(`${ghost.length} 张单写了「已收」却没有对应收款流水（如 #${ghost.slice(0, 5).join('、#')}）—— 现金和应收会对不上`)
else ok('每张「已收」的单都有对应的收款流水')

if (!process.exitCode) console.log('\n✅ 演示账套与演练文档一致，新手照着做能对上数\n')
else console.log('\n❌ 演示账套和文档脱节了：先定谁是对的，再一起改\n')
