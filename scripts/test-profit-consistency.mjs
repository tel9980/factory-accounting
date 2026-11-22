// 本月利润「5 处同数」回归：首页 / 利润对比 / 报表 / 月结 / 经营体检 这 5 个地方报的
// 「本月赚了多少」必须是同一个数（收付实现制：本月真收到的 − 真付出去的）。
// 以前这 5 处各写各的，同一本账能差一倍（现金口径 vs 权责口径），看的人只能挑一个信。
// 现在统一成一句 SQL：ledger WHERE cash=1 AND ref_type NOT IN ('transfer','tax_ar','tax_ap') AND month=?，
// 这个测试就往当前月塞一笔确定的收 + 一笔确定的支，断言 5 处的数字都跟着涨同一个数、而且彼此相等。
import { harness } from './_harness.mjs'
const h = harness({ tag: '利润一致' })
const { KEY, TAG, TODAY, MONTH, ok, no, yes, near, n0, r2, get, post, finish } = h

// 5 处的字段路径（month 都取当前月）
const FIVE = [
  { name: '首页 /dashboard.month_profit', path: '/dashboard', pick: (d) => d.month_profit },
  { name: '利润对比 /profit-compare.cash_profit', path: '/profit-compare?month=' + MONTH, pick: (d) => d.cash_profit },
  { name: '报表 /report-view.cash.net', path: '/report-view?month=' + MONTH, pick: (d) => d && d.cash && d.cash.net },
  { name: '月结 /month-end.numbers.profit', path: '/month-end?month=' + MONTH, pick: (d) => d && d.numbers && d.numbers.profit },
  { name: '经营体检 /kpi.profit', path: '/kpi?month=' + MONTH, pick: (d) => d.profit },
]

async function readAll() {
  const out = []
  for (const f of FIVE) {
    const { status, d } = await get(f.path)
    if (status !== 200) { no(`${f.name} 应 200`, status); out.push(null); continue }
    out.push(n0(f.pick(d)))
  }
  return out
}

const run = async () => {
  const before = await readAll()
  yes('基线 5 处都能读到数字', before.every((x) => Number.isFinite(x)), before)

  // 塞一笔确定的收入 1000：开一张单，再收它 1000（收款进现金流，ref_type='order' 不算排除项）
  const cust = TAG + '客'
  const po = await post('/orders', { customer: cust, item_name: '利润一致性测试', price: 1000, date: TODAY })
  if (po.status !== 200 || !po.d.ok) { no('开单', po); return finish('本月利润一致') }
  const ar = await get('/ar')
  const ord = (ar.d || []).find((x) => x.customer === cust)
  if (!ord || !ord.id) { no('从 /ar 找到刚开的单', ar); return finish('本月利润一致') }
  const rv = await post('/orders/' + ord.id + '/receive', { amount: 1000, date: TODAY })
  if (rv.status !== 200 || !rv.d.ok) { no('收款 1000', rv); return finish('本月利润一致') }

  // 塞一笔确定的支出 300（confirm_dup 跳过「今天记过同样一笔」的提示）
  const ex = await post('/expenses', { amount: 300, category: TAG + '水电', date: TODAY, confirm_dup: true })
  if (ex.status !== 200 || !ex.d.ok) { no('支出 300', ex); return finish('本月利润一致') }

  const after = await readAll()
  const want = 700 // 1000 收 − 300 支

  // ① 每一处都应该跟着涨 700（说明口径是「真收到的钱 − 真付出去的钱」）
  for (let i = 0; i < FIVE.length; i++) {
    near(`${FIVE[i].name} 涨 ${want}`, n0(after[i]) - n0(before[i]), want)
  }
  // ② 5 处彼此相等
  for (let i = 1; i < FIVE.length; i++) {
    near(`${FIVE[i].name} == 首页`, after[i], after[0])
  }
  finish('本月利润一致')
}

run().catch((e) => { console.error(e); process.exit(1) })
