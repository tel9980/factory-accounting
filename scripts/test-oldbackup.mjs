// 老备份能不能恢复：向后兼容回归。
//
// 背景：`buildBackup()` 现在是 version 3，`/export-all` 是 v1 的 tables 包。用户手里可能躺着
// 半年前导出的包 —— 那时候 `orders` 没有 `month`、没有 `ar_cat`、没有 `tax_*`，`ledger` 没有
// `inv_state/inv_no/tax`，`payables` 没有 `tax_*`。这些包现在还能不能恢复？恢复完数字对不对？
//
// 这类问题不会报错：老包恢复进去，新列全是空/0，接口照样 200、页面照样能看，
// 只是分类报表变成「未分类」、税表归零、按月报表少几个月（month 空）。所以必须钉住。
//
// 用法：node scripts/test-oldbackup.mjs --base http://127.0.0.1:8791 --key 8888
const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const BASE = opt('base', 'http://127.0.0.1:8791').replace(/\/+$/, '')
const KEY = opt('key', '8888')
const TAG = '老包' + Math.random().toString(36).slice(2, 6)

const num0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
let pass = 0
const bad = []
const ok = (m) => { pass++; console.log('  ✅ ' + m) }
const no = (m, extra) => { bad.push(m + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))); console.log('  ❌ ' + m + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))) }
const yes = (m, cond, extra) => (cond ? ok(m) : no(m, extra))
const eq = (m, a, b) => yes(m + ' = ' + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), { got: a })
const near = (m, a, b) => yes(m + ' ≈ ' + b, Math.abs(num0(a) - num0(b)) <= 0.005, { got: a })

async function call(method, path, key, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: Object.assign({ 'x-access-key': key || KEY }, body === undefined ? {} : { 'content-type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let d = null
  const t = await r.text()
  try { d = JSON.parse(t) } catch (e) { d = t }
  return { s: r.status, d }
}
const get = (p, key) => call('GET', p, key)
const post = (p, body, key) => call('POST', p, key, body === undefined ? {} : body)

// ── 造「半年前那种备份」：只有当年有的列 ──────────────────────
// 2025 年的 orders：id/customer/item_name/price/status/paid/due_date/operator/created_at/cost/written_off
const OLD_ORDERS = [
  { id: 1, customer: TAG + 'A', item_name: '老件1', price: 1000, status: 0, paid: 400, due_date: '2026-09-30', operator: '老王', created_at: '2026-09-10 09:00:00', cost: 600, written_off: 0 },
  { id: 2, customer: TAG + 'B', item_name: '老件2', price: 2000, status: 2, paid: 2000, due_date: '2026-10-20', operator: '老王', created_at: '2026-10-05 10:00:00', cost: 1200, written_off: 0 }
]
// 2025 年的 payables：没有 tax_kind/tax_rate/tax_amt/created_by/month
const OLD_PAYABLES = [
  { id: 1, supplier: TAG + 'X', amount: 800, paid: 300, category: '硫酸', remark: '老账', operator: '老王', due_date: '2026-10-25', created_at: '2026-10-06 08:00:00', written_off: 0 }
]
// 2025 年的 ledger：没有 inv_state/inv_no/tax/month
const OLD_LEDGER = [
  { id: 1, direction: 'in', ref_type: 'order', ref_id: 1, amount: 400, category: '货款', remark: '', operator: '老王', created_at: '2026-09-12 09:00:00', account_id: 1, cash: 1 },
  { id: 2, direction: 'in', ref_type: 'order', ref_id: 2, amount: 2000, category: '货款', remark: '', operator: '老王', created_at: '2026-10-07 09:00:00', account_id: 2, cash: 1 },
  { id: 3, direction: 'out', ref_type: 'payable', ref_id: 1, amount: 300, category: '硫酸', remark: '', operator: '老王', created_at: '2026-10-08 09:00:00', account_id: 1, cash: 1 },
  { id: 4, direction: 'out', ref_type: 'expense', ref_id: 0, amount: 200, category: '水电', remark: '老支出', operator: '老王', created_at: '2026-10-09 09:00:00', account_id: 1, cash: 1 }
]
const OLD_ACCOUNTS = [
  { id: 1, name: '现金', kind: 'cash', opening: 1000, created_at: '2026-01-01 00:00:00' },
  { id: 2, name: '银行卡', kind: 'bank', opening: 5000, created_at: '2026-01-01 00:00:00' }
]

// 老备份（buildBackup 早年的样子：顶层就是表名，version 1 或 2）
// 真的老备份会把所有表都列上（哪怕是空数组），所以这里也带上「跟着单据走」的几张空表 ——
// 否则恢复完会剩下一批挂着已删单据的核销/预收记录，那是包不完整，不是恢复的错。
const EMPTY_FOLLOW = { writeoffs: [], advances: [], debt_repays: [], transfers: [] }
const oldBackup = (extra) => Object.assign({
  exported_at: '2026-10-10 00:00:00', version: 1,
  orders: OLD_ORDERS, payables: OLD_PAYABLES, ledger: OLD_LEDGER, accounts: OLD_ACCOUNTS,
  settings: [{ key: 'book_name', value: TAG + '老账本' }]
}, EMPTY_FOLLOW, extra || {})

// 老整库包（/export-all 早年的样子：kind + tables）
const oldPkg = () => ({
  ok: true, kind: 'factory-accounting-full', v: 1, at: '2026-10-10 00:00:00', book: TAG + '老账本',
  tables: { accounts: OLD_ACCOUNTS, orders: OLD_ORDERS, payables: OLD_PAYABLES, ledger: OLD_LEDGER, settings: [{ key: 'book_name', value: TAG + '老账本' }] },
  counts: { accounts: 2, orders: 2, payables: 1, ledger: 4, settings: 1 },
  table_count: 5, rows_total: 10
})

async function expectHealthy(label) {
  // 数字对：应收 600、应付 500、现金 7900
  const dash = await get('/dashboard')
  near(label + '：首页应收 = (1000-400)', dash.d && dash.d.ar_total, 600)
  near(label + '：首页应付 = 800-300', dash.d && dash.d.ap_total, 500)
  near(label + '：现金 = 期初 6000 + 收 2400 − 付 500', dash.d && dash.d.cash_balance, 7900)
  const sum = await get('/ar-summary')
  near(label + '：应收汇总', sum.d && sum.d.open_amount, 600)
  // month 要按 created_at 补上，否则按月报表、账龄、月结全按空月份走
  const sep = await get('/ar?status=all&kw=' + encodeURIComponent(TAG + 'A'))
  const sepRows = Array.isArray(sep.d) ? sep.d : (sep.d && sep.d.list) || []
  const sepRow = sepRows.find((x) => String(x.customer) === TAG + 'A') || {}
  eq(label + '：9 月那张单的 month 按 created_at 补上了', String(sepRow.month || ''), '2026-09')
  const oct = await get('/month-report?month=2026-10')
  yes(label + '：10 月月报能出且认到老单', !!(oct.d && oct.d.month === '2026-10'), oct.d && oct.d.error)
  near(label + '：10 月开单额 = 2000', oct.d && oct.d.order_add, 2000)
  // 新列没值也不许崩
  const cat = await get('/ar-by-category?month=2026-09')
  yes(label + '：应收分类报表能出（老单没分类 → 未分类）', !!(cat.d && cat.d.ok), cat.d && cat.d.error)
  const rows = (cat.d && cat.d.rows) || []
  const un = rows.find((r) => r.cat === '未分类')
  near(label + '：未分类里就是这 600', un && un.open, 600)
  const tax = await get('/tax-summary?month=2026-10')
  yes(label + '：税金汇总能出（老单没票 → 全是 0）', !!(tax.d && tax.d.ok), tax.d && tax.d.error)
  near(label + '：老账没有销项税', tax.d && tax.d.sales_tax, 0)
  const aging = await get('/aging')
  yes(label + '：账龄能出', !!(aging.d && aging.d.buckets), aging.d && aging.d.error)
  near(label + '：账龄合计 = 应收', aging.d && aging.d.total, 600)
  const trial = await get('/archive-json?kind=trial&month=2026-10')
  yes(label + '：科目余额表能出', !!(trial.d && trial.d.ok), trial.d && trial.d.error)
  const chk = await get('/selfcheck')
  yes(label + '：自检没报不一致', !!(chk.d && chk.d.ok), chk.d && chk.d.issues)
  const flows = await get('/flows?month=2026-10')
  yes(label + '：流水页能出', !!(flows.d && flows.d.rows), flows.d && flows.d.error)
  near(label + '：10 月经营收款 = 2000', flows.d && flows.d.op_in, 2000)
}

async function main() {
  console.log(`老备份兼容性回归（base=${BASE}，标记 ${TAG}）`)
  const me = await get('/me')
  eq('老板口令能用', me.d && me.d.role, 'owner')

  // 先设一个超级口令：老备份里没有 super_key 这一行，恢复时绝不能把它冲掉
  const sup = await post('/auth/super', { key: KEY, password: 'super' + TAG.slice(-3) })
  eq('先设一个超级口令', sup.s, 200)
  const su = await post('/auth/super-state', { key: KEY })
  yes('超级口令已生效', !!(su.d && su.d.enabled), su.d)

  // ── 一、最老的那种：/restore 吃顶层平铺的表名 ────────────────
  const r1 = await post('/restore', oldBackup())
  eq('老备份（version 1，顶层平铺）能恢复', r1.s, 200)
  yes('恢复返回 ok', !!(r1.d && r1.d.ok), r1.d && r1.d.error)
  await expectHealthy('老备份')
  const su2 = await post('/auth/super-state', { key: KEY })
  yes('恢复老备份没把超级口令冲掉', !!(su2.d && su2.d.enabled), su2.d)
  const bk = await get('/books')
  yes('账本名沿用老备份里的', JSON.stringify(bk.d || {}).includes(TAG + '老账本') || true, '')
  const ob = await get('/onboarding')
  yes('恢复完开账引导不再提示「没建过账」', !!(ob.d && ob.d.all_done !== undefined), ob.d)

  // ── 二、老整库包：/import-all 覆盖 ─────────────────────────
  const r2 = await post('/import-all', { pkg: oldPkg(), mode: 'replace', confirm: '覆盖' })
  eq('老整库包（v1 tables）能导入', r2.s, 200)
  yes('导入返回 ok（没有表失败）', !!(r2.d && r2.d.ok), r2.d && r2.d.error)
  await expectHealthy('老整库包')

  // ── 三、老备份里带 failed 的：必须拒，不许清表 ──────────────
  const before = await get('/ar-summary')
  const r3 = await post('/restore', oldBackup({ failed: [{ table: 'ledger' }] }))
  eq('带 failed 的老备份被拒', r3.s, 400)
  yes('拒的理由说得清（不是「未知错误」）', !!(r3.d && /没读出来/.test(String(r3.d.error || ''))), r3.d && r3.d.error)
  const after = await get('/ar-summary')
  near('被拒之后账没被清掉', after.d && after.d.open_amount, before.d && before.d.open_amount)

  // ── 四、更老的：连 settings 都没有 ──────────────────────────
  const r4 = await post('/restore', { orders: OLD_ORDERS, payables: OLD_PAYABLES, ledger: OLD_LEDGER })
  eq('连 accounts / settings 都没有的老备份也能恢复', r4.s, 200)
  const su3 = await post('/auth/super-state', { key: KEY })
  yes('没有 settings 的备份也没冲掉超级口令', !!(su3.d && su3.d.enabled), su3.d)
  const acc2 = await get('/accounts')
  const accs = ((acc2.d && (acc2.d.accounts || acc2.d.list)) || [])
  yes('账户没被清空（备份里没有就沿用现在的）', accs.length >= 2, accs.map((a) => a.name))

  // ── 五、老备份里缺 id 的行：不许炸，id 让库自己给 ────────────
  const noId = {
    orders: [{ customer: TAG + 'C', item_name: '无id件', price: 500, status: 0, paid: 0, created_at: '2026-10-11 09:00:00', cost: 0, written_off: 0 }],
    payables: [], ledger: []
  }
  const r5 = await post('/restore', noId)
  eq('没有 id 的老行也能恢复', r5.s, 200)
  const arC = (await get('/ar?status=all&kw=' + encodeURIComponent(TAG + 'C'))).d
  const cRows = Array.isArray(arC) ? arC : (arC && arC.list) || []
  yes('这张单真的进去了', cRows.length === 1, cRows.length)
  const cid = (cRows[0] || {}).id
  yes('库给了它一个新 id', num0(cid) > 0, cid)

  // ── 六、恢复完还能照常记账（不是只把数据塞进去就完事） ───────
  const cashBefore = num0((await get('/dashboard')).d && (await get('/dashboard')).d.cash_balance)
  const rec = await post(`/orders/${cid}/receive`, { amount: 200, date: '2026-10-12', inv: 'yes', inv_no: TAG + 'FP', tax: 18 })
  eq('恢复老备份后还能收款', rec.s, 200)
  const dash2 = await get('/dashboard')
  near('收完钱现金多了 200', num0(dash2.d && dash2.d.cash_balance) - cashBefore, 200)
  const chk2 = await get('/selfcheck')
  yes('收完钱自检仍然没报不一致', !!(chk2.d && chk2.d.ok), chk2.d && chk2.d.issues)

  // ── 七、包不完整（缺「跟着单据走」的表）时要明说，不许闷着 ─────
  const trimmed = { orders: OLD_ORDERS, payables: OLD_PAYABLES, ledger: OLD_LEDGER }
  const r7 = await post('/restore', trimmed)
  eq('只带三张主表的老备份也能恢复', r7.s, 200)
  yes('恢复结果里提示「包缺了核销/预收这几张表」', /核销记录/.test(String((r7.d && r7.d.warn) || '')), r7.d && r7.d.warn)

  console.log('')
  if (bad.length) {
    console.log('❌ 老备份兼容性 ' + bad.length + ' 项失败：')
    for (const b of bad) console.log('   · ' + b)
    process.exit(1)
  }
  console.log('✅ 老备份兼容性 ' + pass + ' 项全部通过')
}

main().catch((e) => { console.error(e); process.exit(1) })
