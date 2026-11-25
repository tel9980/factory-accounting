// 第二十一刀回归：同一个「净利」在五个页面上必须是同一个数
//
// 为什么要这个测试：
//   2026-11 用模拟数据跑完整账套时，同一笔「借支报销」让四个地方各说一套：
//     · /cash-bridge  残差每月多 2000（报销记了成本、没动现金，桥接没有行加回来）
//     · /kpi          净利没减坏账核销（比 /trend 高 2792）
//     · /year-summary 全年净利用 CASH_EXP_WHERE（只认 cash=1），漏掉报销 → 比年报高 8000
//     · /year-customers 年度净利写成「接单 − 毛利 − 费用」，材料成本被倒加回去 → 说亏 8 万，实际亏 29.6 万
//   四个页面谁都不报错，只是数字不一样；老板拿哪张纸去算都算不平。
//   所以这里不测「某个接口返回什么」，而是测「几张纸上的同一个数是同一个数」，加上纸面本身的完整性。
//
// 断言方式：测试库里有别的测试留下的数据，绝对数钉不住，所以用**差值**断言
//   （做一笔操作，看指定口径变动是否正好等于这一笔的金额）。
//
// 用法：node scripts/test-ledger.mjs [--base http://127.0.0.1:8791] [--key 8888]

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const BASE = arg('base', 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = arg('key', '8888')
const H = { 'X-Access-Key': KEY, 'Content-Type': 'application/json', 'User-Agent': 'curl/8' }

let pass = 0
const bad = []
const ok = (msg) => { pass++; console.log('  ✅ ' + msg) }
const no = (msg, detail) => { bad.push(msg); console.log('  ❌ ' + msg + (detail === undefined ? '' : ' → ' + JSON.stringify(detail))) }
const near = (label, got, want, tol = 0.02) => {
  if (Math.abs(Number(got) - Number(want)) <= tol) ok(`${label} = ${want}`)
  else no(`${label} 应为 ${want}`, got)
}
const eq = (label, got, want) => (String(got) === String(want) ? ok(`${label} = ${want}`) : no(`${label} 应为 ${want}`, got))
const num0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const r2 = (v) => Math.round(num0(v) * 100) / 100

const day = (back) => {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  d.setUTCDate(d.getUTCDate() - (back || 0))
  return d.toISOString().slice(0, 10)
}
const TODAY = day(0)
const M = TODAY.slice(0, 7)
const Y = TODAY.slice(0, 4)

const call = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) })
  const txt = await r.text()
  let d = null
  try { d = JSON.parse(txt) } catch (e) { d = null }
  return { status: r.status, d, txt }
}
const get = (p) => call('GET', p)
const post = (p, b) => call('POST', p, b)

// 建单接口多半只回 {ok:true}，得从列表里按名字找回来
const pickLast = async (listPath, field, value) => {
  const r = await get(listPath)
  const arr = Array.isArray(r.d) ? r.d : (r.d && (r.d.list || r.d.rows || r.d.items)) || []
  const hit = arr.filter((x) => String(x[field] || '') === String(value))
  return num0((hit.length ? hit[hit.length - 1] : {}).id)
}

const main = async () => {
  const tag = Date.now().toString(36).slice(-4)
  const CUST = '口径客户' + tag
  const SUP = '口径供应商' + tag
  const STAFF = '口径员工' + tag

  const acc = await get('/accounts')
  const accList = (acc.d && (acc.d.accounts || acc.d.list)) || []
  if (!accList.length) { no('/accounts 至少有一个账户', acc.status); return }
  const ACC = num0(accList[0].id)

  // 统一取数：五个页面的同一个数
  const snap = async () => {
    const [kpi, trend, brief, bridge, ys, yb, yc] = await Promise.all([
      get('/kpi'), get('/trend'), get('/month-brief?month=' + M), get('/cash-bridge?month=' + M),
      get('/year-summary?year=' + Y), get('/year-book?year=' + Y), get('/year-customers?year=' + Y)
    ])
    const k = kpi.d || {}, t = trend.d || {}, b = brief.d || {}, br = bridge.d || {}, s = ys.d || {}, ybd = yb.d || {}, ycd = yc.d || {}
    // /trend 的当月那一行（不同版本字段名不同，两种都认）
    const tRows = t.rows || t.months || t.list || []
    const tCur = tRows.filter((x) => String(x.month || x.m || x.mk || '').slice(0, 7) === M).pop() || {}
    return {
      kpiProfit: num0(k.profit_accrual), kpiCost: num0(k.cost != null ? k.cost : k.cost_total),
      kpiWriteoff: num0(k.writeoff),
      trendProfit: num0(tCur.profit_accrual != null ? tCur.profit_accrual : tCur.profit),
      // 注意口径命名陷阱：/month-brief 的 profit 是「现金净利」，权责净利在 profit_accrual
      briefProfit: num0(b.profit_accrual != null ? b.profit_accrual : b.profit),
      bridgeResidual: num0(br.residual),
      bridgeProfit: num0(br.profit != null ? br.profit : br.profit_accrual),
      bridgeRows: (() => { const o = {}; for (const x of (br.rows || [])) o[x.k] = num0(x.amount); return o })(),
      ysProfit: r2((s.rows || []).reduce((a, x) => a + num0(x.profit), 0)),
      ybProfit: num0(ybd.totals && ybd.totals.profit),
      ycProfit: ycd.total_profit_accrual != null ? num0(ycd.total_profit_accrual) : null,
      month: M, year: Y
    }
  }

  // ── P1. 借支报销：不动现金但确实是成本 ──
  console.log('\n［P1］借支报销（cash=0 的费用）')
  {
    const a = await snap()
    const nl = await post('/loans', { staff: STAFF, amount: 1000, remark: '买辅料先垫', account_id: ACC, date: TODAY, client_id: 'lg-' + tag })
    if (nl.status !== 200 || !nl.d || nl.d.ok === false) { no('建借支', nl.status + ' ' + nl.txt.slice(0, 120)); }
    else {
      const lid = await pickLast('/loans', 'staff', STAFF)
      if (!lid) no('借支建完能从 /loans 找回来（staff=' + STAFF + '）')
      else {
        const rr = await post('/loans/' + lid + '/reimburse', { amount: 1000, category: '辅料', remark: '报销', date: TODAY })
        if (rr.status !== 200 || (rr.d && rr.d.ok === false)) no('报销冲借支 1000', rr.status + ' ' + rr.txt.slice(0, 150))
        else {
          const b = await snap()
          // 残差一分不动：报销记账了、但钱没动，桥接必须有一行把它加回来
          near('P1 桥接残差一分不动', b.bridgeResidual, a.bridgeResidual, 0.01)
          near('P1 桥接「报销冲借支」行 +1000', num0(b.bridgeRows.noncash_exp) - num0(a.bridgeRows.noncash_exp), 1000, 0.01)
          // 成本口径：kpi 的成本要包含这笔（与 /cash-bridge 的利润一致）
          near('P1 /kpi 成本 +1000', b.kpiCost - a.kpiCost, 1000, 0.01)
          near('P1 /kpi 净利 −1000', b.kpiProfit - a.kpiProfit, -1000, 0.01)
          near('P1 桥接净利润 −1000', b.bridgeProfit - a.bridgeProfit, -1000, 0.01)
        }
      }
    }
  }

  // ── P2. 坏账核销 / 豁免应付：一减一加 ──
  console.log('\n［P2］核销与豁免（一减一加）')
  {
    const a = await snap()
    const no1 = await post('/orders', { customer: CUST, item_name: '口径件', price: 5000, cost: 2000, date: TODAY, confirm_dup: true, client_id: 'o-' + tag })
    if (no1.status !== 200 || (no1.d && no1.d.ok === false)) no('建订单 5000', no1.status + ' ' + no1.txt.slice(0, 150))
    else {
      const oid = await pickLast('/ar?status=all&limit=200', 'customer', CUST)
      if (!oid) no('/ar 里能找回刚建的订单（customer=' + CUST + '）')
      else {
        // 建单本身会让毛利 +3000，所以核销前先重新取一次基线，只看核销这一步
        const aOrder = await snap()
        near('P2 建单 5000/成本 2000 → 净利 +3000', aOrder.kpiProfit - a.kpiProfit, 3000, 0.02)
        const wo = await post('/orders/' + oid + '/writeoff', { amount: 800, reason: '口径测试核销', date: TODAY })
        if (wo.status !== 200 || (wo.d && wo.d.ok === false)) no('核销 800', wo.status + ' ' + wo.txt.slice(0, 150))
        else {
          const b = await snap()
          near('P2 /kpi 核销字段 +800', b.kpiWriteoff - a.kpiWriteoff, 800, 0.01)
          near('P2 /kpi 净利再 −800（核销是损失）', b.kpiProfit - aOrder.kpiProfit, -800, 0.01)
          near('P2 /trend 当月净利 与 /kpi 同步 −800', b.trendProfit - aOrder.trendProfit, -800, 0.01)
          near('P2 /month-brief 权责净利 与 /kpi 同步 −800', b.briefProfit - aOrder.briefProfit, -800, 0.01)
          near('P2 桥接净利润 同步 −800', b.bridgeProfit - aOrder.bridgeProfit, -800, 0.01)
        }
      }
    }
    // 豁免应付 = 收益（要加回来，别当损失扣）
    const a2 = await snap()
    const np = await post('/payables', { supplier: SUP, item: '口径料', amount: 3000, date: TODAY, client_id: 'p-' + tag })
    if (np.status !== 200 || (np.d && np.d.ok === false)) no('建应付 3000', np.status + ' ' + np.txt.slice(0, 150))
    else {
      const pid = await pickLast('/ap?status=all&limit=200', 'supplier', SUP)
      if (!pid) no('/ap 里能找回刚建的应付（supplier=' + SUP + '）')
      else {
        const wg = await post('/payables/' + pid + '/writeoff', { amount: 300, reason: '口径测试豁免', date: TODAY })
        if (wg.status !== 200 || (wg.d && wg.d.ok === false)) no('豁免应付 300', wg.status + ' ' + wg.txt.slice(0, 150))
        else {
          const b2 = await snap()
          near('P2 豁免应付 300 让净利 +300（收益）', b2.kpiProfit - a2.kpiProfit, 300, 0.01)
          near('P2 豁免后桥接净利润 +300', b2.bridgeProfit - a2.bridgeProfit, 300, 0.01)
        }
      }
    }
  }

  // ── P3. 全年净利：四个页面一个数 ──
  console.log('\n［P3］全年净利五处对齐')
  {
    const s = await snap()
    near('P3 年度汇总(/year-summary) = 年报(/year-book)', s.ysProfit, s.ybProfit, 0.02)
    if (s.ycProfit !== null) near('P3 客户排行(/year-customers) = 年报', s.ycProfit, s.ybProfit, 0.02)
    const yb = await get('/year-book?year=' + Y)
    const ybd = yb.d || {}
    const ybMonths = r2(((ybd.months) || []).reduce((a, x) => a + num0(x.profit), 0))
    near('P3 年报逐月加总 = 年报合计', ybMonths, s.ybProfit, 0.02)
    // 桥接逐月加总（只算有数据的月份，避免空月把 0 也算进去）
    let sum = 0
    let cbOk = true
    const months = ((ybd.months) || []).map((x) => x.m).filter(Boolean)
    for (const mm of months) {
      const cb = await get('/cash-bridge?month=' + mm)
      if (cb.status !== 200 || !cb.d || cb.d.ok === false) { cbOk = false; break }
      sum = r2(sum + num0(cb.d.profit))
    }
    if (!cbOk) no('P3 每个月的 /cash-bridge 都能打开')
    else near('P3 桥接逐月净利加总 = 年报全年净利', sum, s.ybProfit, 0.05)
  }

  // ── P4. 纸面完整：报表子行三列、年度总账无空格 ──
  console.log('\n［P4］打印页数字不许缺格')
  {
    const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    const rl = await get('/report-link?month=' + M)
    if (!rl.d || !rl.d.url) no('/report-link 能生成当月经营报表链接', rl.status + ' ' + rl.txt.slice(0, 120))
    else {
      const pg = await get(String(rl.d.url).replace(/^https?:\/\//, '//').replace(/^\/\/([^/]+)/, ''))
      const html = strip(pg.txt)
      if (pg.status !== 200) no('/report-print 打得开', pg.status)
      else {
        // 费用明细子行（缩进的全角空格开头）必须是 3 个 td：项目 / 本月 / 本年累计
        const subRows = html.split('<tr').filter((x) => /<td>\s*　/.test(x))
        const wrong = subRows.filter((x) => (x.match(/<td/g) || []).length !== 3)
        if (!subRows.length) no('经营报表里有费用明细子行可查（本月没花现金费用？）')
        else eq('P4 经营报表费用子行都够三列（项目/本月/本年累计）', wrong.length, 0)
        eq('P4 经营报表没有空的金额格', (html.match(/<td class="n"><\/td>/g) || []).length, 0)
        eq('P4 经营报表没有 NaN / undefined', (html.match(/NaN|undefined/g) || []).length, 0)
      }
    }
    const yl = await get('/year-print-link?year=' + Y)
    if (!yl.d || !yl.d.url) no('/year-print-link 能生成年度总账链接', yl.status + ' ' + yl.txt.slice(0, 120))
    else {
      const pg = await get(String(yl.d.url).replace(/^https?:\/\//, '//').replace(/^\/\/([^/]+)/, ''))
      if (pg.status !== 200) no('/year-print 打得开', pg.status)
      else {
        const html = strip(pg.txt)
        // 表头列数 vs 合计行列数（第 19 轮修过一次，别回潮）
        const thead = (html.match(/<thead[\s\S]*?<\/thead>/) || [''])[0]
        const tfoot = (html.match(/<tfoot[\s\S]*?<\/tfoot>/) || [''])[0]
        // 注意别用 /<th/ —— 会连 <thead 一起数进来（当年就是这么数错的）
        const thN = (thead.match(/<th[\s>]/g) || []).length
        const tfN = (tfoot.match(/<td[\s>]/g) || []).length
        if (thead && tfoot) eq('P4 年度总账 表头列数 = 合计行列数', tfN, thN)
        eq('P4 年度总账没有空金额格', (html.match(/<td class="n"><\/td>/g) || []).length, 0)
        eq('P4 年度总账有千分位', /\d{1,3}(,\d{3})+\.\d\d/.test(html), true)
      }
    }
  }

  // ── P5. 桥接行覆盖率：每一类会写进账的流水都要有行解释 ──
  console.log('\n［P5］桥接行覆盖')
  {
    const cb = await get('/cash-bridge?month=' + M)
    const keys = ((cb.d || {}).rows || []).map((x) => x.k)
    // 这些 key 与 /cash-bridge 的 18 行一一对应（第 21 轮 A1 新增 noncash_exp）
    const must = ['profit', 'adj', 'noncash_exp', 'ar', 'ap', 'mat_gap', 'debt', 'adv', 'adv_out', 'adv_used',
      'adv_used_pay', 'prepaid', 'dispose', 'other_in', 'tax', 'loan', 'other', 'wo']
    const missing = must.filter((k) => keys.indexOf(k) < 0)
    eq('P5 桥接行齐全（含「报销冲借支」）', missing.join(',') || '无缺', '无缺')
    // ref_type 兜底：账本里出现过的每一种 ref_type 都要有一行对应，否则只能落进残差
    const lg = await get('/cashbook?month=' + M)
    const cbRows = (lg.d && (lg.d.rows || lg.d.list)) || []
    const types = Array.from(new Set(cbRows.map((x) => String(x.ref_type || '')).filter(Boolean)))
    const mapRef = { order: 'order', payable: 'payable', advance: 'advance', loan: 'loan', loan_return: 'loanReturn',
      prepaid: 'prepaid', expense: 'expense', fixed: 'expense', dispose: 'dispose', dep: 'expense', amort: 'expense',
      debt: 'debt', debt_int: 'debt', transfer: 'other', tax_ar: 'tax', tax_ap: 'tax' }
    const unmapped = types.filter((t) => !mapRef[t])
    eq('P5 账本里每种 ref_type 都有桥接行承接', unmapped.join(',') || '无未归类', '无未归类')
  }

  console.log(`\n=== 口径核验：${pass} 项通过${bad.length ? '，❌ ' + bad.length + ' 项没过' : '，✅ 全过'} ===`)
  if (bad.length) process.exitCode = 1
}

main().catch((e) => { console.error('跑崩了：', e); process.exitCode = 1 })
