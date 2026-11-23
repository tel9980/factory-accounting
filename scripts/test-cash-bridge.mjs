// 第十五刀回归：「钱去哪了」（/cash-bridge）每一类真金白银的进出都要有自己的行
//
// 为什么要这个测试：
//   这张表原来只有 11 行。预付货款（现金出去）、预付抵应付（不动现金但要冲掉应付）、
//   押金/预付房租、卖设备收到的钱、银行认领的「其他收入」这五类进出完全没有行去解释，
//   只能全塞进「残差」，残差天天不为 0 但谁也说不清差在哪；应收/应付又是拿**现在的** paid
//   倒算「月初/月底」，一查上个月这月收的钱就被算回去，历史月份永远对不上。
//   现在改成「本月单据事件 + 本月流水」，一类一行，另加一行兜底「没归类」。
//
// 断言方式：测试库里本来就有别的测试留下的数据，残差的绝对值没法钉，所以每一步都要求
//   「残差一分不动」+「该类别的行确实动了这么多」—— 哪类现金进出漏了行，这一步就会红。
//
// 用法：node scripts/test-cash-bridge.mjs [--base http://127.0.0.1:8791] [--key 8888]

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const BASE = arg('base', 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = arg('key', '8888')
const H = { 'X-Access-Key': KEY, 'Content-Type': 'application/json' }

let pass = 0
const bad = []
const ok = (msg) => { pass++; console.log('  ✅ ' + msg) }
const no = (msg, detail) => { bad.push(msg); console.log('  ❌ ' + msg + (detail === undefined ? '' : ' → ' + JSON.stringify(detail))) }
const eq = (label, got, want) => (String(got) === String(want) ? ok(`${label} = ${want}`) : no(`${label} 应为 ${want}`, got))
const near = (label, got, want, tol = 0.02) => (Math.abs(Number(got) - Number(want)) <= tol ? ok(`${label} ≈ ${want}`) : no(`${label} 应约 ${want}`, got))
const num0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const round2 = (v) => Math.round(num0(v) * 100) / 100

const day = (back) => {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  d.setUTCDate(d.getUTCDate() - (back || 0))
  return d.toISOString().slice(0, 10)
}
const TODAY = day(0)
const MONTH = TODAY.slice(0, 7)

const call = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) })
  let d = null
  try { d = await r.json() } catch (e) { d = null }
  return { status: r.status, d }
}
const get = (p) => call('GET', p)
const post = (p, b) => call('POST', p, b)

// 建单接口只回 {ok:true}，不回 id，所以建完要从列表里按名字找回来。
// 列表接口的形状各不一样：/ar /ap /advances 直接是数组，/debts 是 {debts}，/loans 是 {list}，/assets 是 {rows}。
const pick = (arr, montage) => {
  const hit = (arr || []).filter(montage)
  return num0((hit.length ? hit[hit.length - 1] : {}).id)
}

const main = async () => {
  const tag = Date.now().toString(36).slice(-4)
  const M = MONTH

  // 取一次状态：残差 + 每一行的金额（按 k 索引）
  const state = async () => {
    const g = await get('/cash-bridge?month=' + M)
    const d = g.d || {}
    const rows = {}
    for (const x of (d.rows || [])) rows[x.k] = num0(x.amount)
    return { status: g.status, ok: !!d.ok, residual: num0(d.residual), rows, doc: d.doc_gap || {}, d }
  }
  // 一步一验：残差不动 + 指定几行按预期变化
  const step = async (label, fn, expect) => {
    const a = await state()
    if (!a.ok) { no(`[${label}] /cash-bridge 能返回`, a.status); return }
    const r = await fn()
    if (r && r.status && r.status !== 200) no(`[${label}] 操作成功`, r.status + ' ' + JSON.stringify(r.d).slice(0, 120))
    const b = await state()
    near(`[${label}] 残差一分不动`, b.residual, a.residual, 0.01)
    for (const k of Object.keys(expect || {})) {
      near(`[${label}] 行 ${k} 变化`, num0(b.rows[k]) - num0(a.rows[k]), expect[k], 0.01)
    }
  }

  console.log('\n[1] 表格结构：该有的行一行都不能少')
  {
    const s = await state()
    eq('[1] 接口返回 ok', s.ok, true)
    const need = ['profit', 'adj', 'ar', 'ap', 'mat_gap', 'debt', 'adv', 'adv_out', 'adv_used',
      'adv_used_pay', 'prepaid', 'dispose', 'other_in', 'tax', 'loan', 'other', 'wo']
    const miss = need.filter((k) => !(k in s.rows))
    eq('[1] 17 类项目都在（缺的：' + (miss.join(',') || '无') + '）', 0, miss.length)
    eq('[1] 有 doc_gap（顺带核单据和流水）', typeof s.doc.ar === 'number' && typeof s.doc.ap === 'number', true)
    const g = await get('/cash-bridge?month=2099-01')
    eq('[1] 空月份残差为 0', num0((g.d || {}).residual), 0)
    eq('[1] 空月份说「对得上」', /对得上/.test(String(((g.d || {}).advice || [])[0] || '')), true)
    eq('[1] 一句话里有「利润去哪了」', /利润去哪了/.test(String((g.d || {}).text || '')), true)
  }

  console.log('\n[2] 接单（不花钱）→ 应收变动那一行吃掉，残差不动')
  let oid = 0
  const CUST = '桥接客户' + tag
  await step('[2] 建应收单 1000/成本 400', async () => {
    const r = await post('/orders', { customer: CUST, price: 1000, cost: 400, item_name: '加工' })
    const list = await get('/ar?status=all&kw=' + encodeURIComponent(CUST))
    oid = pick(list.d, (x) => String(x.customer) === CUST && num0(x.price) === 1000)
    return r
  }, { ar: -1000, profit: 600, mat_gap: 400 })
  eq('[2] 找回这张单的 id', oid > 0, true)

  console.log('\n[3] 收钱：现金 +300，应收那一行 +300')
  await step('[3] 收 300', () => post('/orders/' + oid + '/receive', { amount: 300, date: TODAY }), { ar: 300 })

  console.log('\n[4] 付房租（预付）：现金出去 1200，摊销不动钱')
  await step('[4] 预付房租 1200（摊 3 个月）', () => post('/prepaids', { total: 1200, months: 3, category: '厂房租金', name: '桥接房租' + tag, start_date: TODAY }), { prepaid: -1200 })

  console.log('\n[5] 给供应商付预付：现金出去 500，不算这个月花掉')
  let advOutId = 0
  await step('[5] 付预付 500', async () => {
    const r = await post('/advances', { type: 'out', party: '桥接供应商' + tag, amount: 500, date: TODAY })
    const list = await get('/advances?type=out')
    advOutId = pick(list.d, (x) => String(x.type) === 'out' && String(x.party) === '桥接供应商' + tag)
    return r
  }, { adv_out: -500 })

  console.log('\n[6] 赊购 800 + 用预付抵 500：应付变动与抵扣互抵，残差不动')
  let payId = 0
  await step('[6] 赊购 800', async () => {
    const r = await post('/payables', { supplier: '桥接供应商' + tag, amount: 800, date: TODAY })
    const list = await get('/ap?status=all&kw=' + encodeURIComponent('桥接供应商' + tag))
    payId = pick(list.d, (x) => String(x.supplier) === '桥接供应商' + tag && num0(x.amount) === 800)
    return r
  }, { ap: 800, mat_gap: -800 })
  eq('[6] 找回这笔应付的 id', payId > 0, true)
  await step('[6] 用预付抵 500（不动现金）', () => post('/payables/' + payId + '/apply-advance', { amount: 500 }), { ap: -500, adv_used_pay: 500 })
  eq('[6] 预付单还在（没被当现金重复算）', advOutId > 0, true)

  console.log('\n[7] 收预收 200 → 再接一张单、用预收抵掉（两张都不动现金的部分要对上）')
  let advInId = 0
  await step('[7] 收预收 200', async () => {
    const r = await post('/advances', { type: 'in', party: '桥接客户' + tag, amount: 200, date: TODAY })
    const list = await get('/advances')
    advInId = pick(list.d, (x) => String(x.type) === 'in' && String(x.party) === '桥接客户' + tag && num0(x.amount) === 200)
    return r
  }, { adv: 200 })
  let oid2 = 0
  await step('[7] 给这家客户再开一张 900 的单', async () => {
    const r = await post('/orders', { customer: CUST, price: 900, cost: 0, item_name: '加工' })
    const list = await get('/ar?status=all&kw=' + encodeURIComponent(CUST))
    oid2 = pick(list.d, (x) => String(x.customer) === CUST && num0(x.price) === 900)
    return r
  }, { ar: -900, profit: 900 })
  await step('[7] 用预收抵 200', () => post('/orders/' + oid2 + '/apply-advance', { amount: 200 }), { ar: 200, adv_used: -200 })
  eq('[7] 预收单还在', advInId > 0, true)
  eq('[7] 找回第二张单的 id', oid2 > 0, true)

  console.log('\n[8] 坏账核销 100：损失进净利，应收变动又加回来 → 核销那一行必须是 0')
  await step('[8] 核销 100', () => post('/orders/' + oid2 + '/writeoff', { amount: 100, reason: '要不回来了' }), { profit: -100, ar: 100, wo: 0 })

  console.log('\n[9] 供应商豁免 150（不用还了）：这是收益不是损失，方向不能反')
  await step('[9] 豁免应付 150', () => post('/payables/' + payId + '/writeoff', { amount: 150, reason: '供应商不要了' }), { profit: 150, ap: -150, wo: 0 })

  console.log('\n[10] 卖设备：收 500 现金，不算做生意的收入')
  let assetId = 0
  await post('/assets', { name: '桥接设备' + tag, cost: 2000, buy_date: TODAY, life_years: 5, residual_rate: 5 })
  {
    const g = await get('/assets')
    const list = (g.d && (g.d.assets || g.d.rows)) || []
    const one = list.filter((x) => String(x.name) === '桥接设备' + tag).pop()
    assetId = num0(one && one.id)
  }
  eq('[10] 资产建好了', assetId > 0, true)
  await step('[10] 处置卖 500', () => post('/assets/' + assetId + '/dispose', { amount: 500, date: TODAY }), { dispose: 500 })

  console.log('\n[11] 借 5000、还 600：借款净增那一行')
  let debtId = 0
  await step('[11] 借 5000', async () => {
    const r = await post('/debts', { lender: '桥接银行' + tag, principal: 5000, start_date: TODAY, kind: 'bank', rate: 6 })
    const list = await get('/debts')
    debtId = pick(list.d && list.d.debts, (x) => String(x.lender) === '桥接银行' + tag)
    return r
  }, { debt: 5000 })
  await step('[11] 还 600（含利息）', () => post('/debts/' + debtId + '/repay', { amount: 600, date: TODAY }), { debt: -600 })

  console.log('\n[12] 员工借支 300、退回 100：借出记负，退回记正')
  let loanId = 0
  await step('[12] 借支 300', async () => {
    const r = await post('/loans', { staff: '桥接员工' + tag, amount: 300, date: TODAY })
    const list = await get('/loans')
    loanId = pick(list.d && list.d.list, (x) => String(x.staff) === '桥接员工' + tag)
    return r
  }, { loan: -300 })
  await step('[12] 退回 100', () => post('/loans/' + loanId + '/return', { amount: 100, date: TODAY }), { loan: 100 })

  console.log('\n[13] 现金支出：净利里扣，现金也少，残差不动')
  // 金额不能和别的测试撞（后端有「同一天同分类同金额」的防重），所以按 tag 抖一下
  const EXP = round2(200 + (parseInt(tag, 36) % 400) + 0.37)
  await step('[13] 记一笔支出 ' + EXP, () => post('/expenses', { amount: EXP, category: '其他', remark: '桥接测试支出' + tag, date: TODAY }), { profit: -EXP })

  console.log('\n[14] 内部转账不算现金进出（两个账户之间左手倒右手）')
  {
    const accs = await get('/accounts')
    const list = (accs.d && (accs.d.rows || accs.d.accounts)) || []
    if (list.length >= 2) {
      await step('[14] 账户间转 100', () => post('/transfer', { from: num0(list[0].id), to: num0(list[1].id), amount: 100, date: TODAY }), {})
    } else ok('[14] 只有一个账户，跳过转账')
  }

  console.log('\n[15] 兜底那一行：账本里认不出的类别要摆出来，不能变成残差')
  {
    const g = await get('/cash-bridge?month=' + M)
    const d = g.d || {}
    const hasOther = (d.rows || []).some((x) => x.k === 'other')
    eq('[15] 有「没归类」这一行（金额可以为 0）', hasOther, true)
    if (num0(d.residual) !== 0) eq('[15] 残差不为 0 时 advice 说清原因', String((d.advice || []).join('')).length > 8, true)
    eq('[15] uncovered 是数组', Array.isArray(d.uncovered), true)
  }

  console.log('')
  if (bad.length) { console.log('❌ ' + bad.length + ' 项失败：'); bad.forEach((x) => console.log('   · ' + x)); process.exit(1) }
  console.log('✅ 全过：' + pass + ' 项')
}

main().catch((e) => { console.error('测试崩了：', e); process.exit(1) })
