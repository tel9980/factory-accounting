// 第二十一刀：灌一套「像真的」模拟账套，用来核对各页面口径是否自洽
//
// 为什么要有这个脚本：
//   2026-11 做「用模拟数据跑完整账套，查漏补缺」时，手上只有一份空库 + 几个十几个断言的小测试，
//   根本撞不出「同一个净利在四张纸上不一样」这类问题 —— 那类错只有在**跨模块、跨月份、
//   有核销有借支有抵扣有折旧**的账上才会显形。所以这套数据是故意配齐的：8 个月、12 家客户、
//   8 家供应商、360 张订单、176 张应付、56 笔支出、8 笔借支（含报销冲借支）、4 台设备（含处置）、
//   材料出入库、外协回货、发票、预付摊销、30 万借款、预收/预付抵扣、核销与豁免、6 个月计件工资，
//   前 6 个月结账锁定（后面两个月留着可写）。
//
// 日期是**写死**的 2026-04 ～ 2026-11：固定的剧本才能逐月对账（换一天跑，折旧摊销的月数就变了，
// 「逐月加总 = 全年」这类断言会对不上）。要换年份就改下面的 MONTHS / TODAY 两个常量。
//
// 用法（**必须对着一个干净的库跑**，比如刚灌完 schema.sql 的本地库）：
//   node scripts/mock-data.mjs [--base http://127.0.0.1:8791] [--key 8888] [--force]
// 跑完再跑：node scripts/test-ledger.mjs（口径门禁）、以及只读核验脚本。

const B = process.env.FA_BASE || (process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'http://127.0.0.1:8791')
const KEY = process.env.FA_KEY || (process.argv.includes('--key') ? process.argv[process.argv.indexOf('--key') + 1] : '8888')
const H = { 'Content-Type': 'application/json', 'X-Access-Key': KEY, 'User-Agent': 'curl/8' }

let seq = 0
const cid = (t) => 'm3-' + t + '-' + (++seq)
async function req(path, method = 'GET', body) {
  const r = await fetch(B + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) })
  const t = await r.text()
  let d
  try { d = JSON.parse(t) } catch (e) { d = { raw: t.slice(0, 300) } }
  return { status: r.status, d }
}
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100
let bad = 0
const ok = (cond, name, detail) => { if (!cond) bad++; if (!cond || process.env.VERBOSE) console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`) }

const MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']
const TODAY = '2026-11-25'
const CUST = ['恒达机械', '永盛五金', '三合钢构', '正力模具', '华兴包装', '天马金属', '中鑫制造', '立信精工', '广源管业', '顺德机电', '鑫源铸造', '远航配件']
const SUP = ['宝钢贸易', '华东焊材', '立信砂轮', '长江物流', '城南电力', '宏达包装', '金工刀具', '顺达劳务']
const OUT_CATS = ['材料', '工资', '房租', '水电', '运费', '办公', '维修', '税']
const pad = (n) => String(n).padStart(2, '0')
const day = (m, i) => m + '-' + pad(((i * 7) % 27) + 1)
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)
const clampToday = (iso) => (iso > TODAY ? TODAY : iso)

// ── 0. 干净库闸门 ──
// 这套剧本假设从零开始：重名账户、重复预付、月结锁定都会让后半段连锁失败，
// 与其跑到一半报一堆看不懂的错，不如一开始就说清楚。
if (!process.argv.includes('--force')) {
  const probe = await req('/ar?status=all&limit=1')
  const arr = Array.isArray(probe.d) ? probe.d : []
  if (arr.length) {
    console.log('❌ 这个库里已经有单据了（/ar 不是空的）。')
    console.log('   模拟数据要在**干净的库**上跑：先重建库 + 灌 schema.sql + /auth/setup，再来一次。')
    console.log('   确实想往现有账上硬灌（会把账搅浑，只在本地演练库上这么干）：加 --force')
    process.exit(1)
  }
}

// ── 0. 基础设置 ──
console.log('［0］基础设置')
let accs = {}, cats = { out: [], in: [] }
{
  await req('/modules', 'POST', { off: [] })
  const rh = await req('/report-head', 'POST', { title: '宏运机加工厂', phone: '13800001111', addr: '浙江宁波北仑区小港街道 88 号', bank: '农行北仑支行 6228 4800 1234 5678' })
  ok(rh.status === 200, '报告抬头（单位名/电话/地址/开户行）', rh.status)

  // 新库自带四个默认账户；再补一个「农行」当主账户，并给现金设期初
  const a0 = (await req('/accounts')).d
  for (const x of a0.accounts || []) accs[x.name] = x.id
  if (!accs['农行']) {
    const r = await req('/accounts', 'POST', { name: '农行', kind: 'bank', opening: 20000 })
    ok(r.status === 200, '账户 农行', JSON.stringify(r.d).slice(0, 80))
    accs['农行'] = (await req('/accounts')).d.accounts.find((x) => x.name === '农行').id
  }
  const p1 = await req('/accounts/' + accs['现金'], 'PATCH', { opening: 5000 })
  ok(p1.status === 200, '现金期初 5000', JSON.stringify(p1.d).slice(0, 80))
  const p2 = await req('/accounts/' + accs['银行卡'], 'PATCH', { opening: 30000 })
  ok(p2.status === 200, '银行卡期初 30000', JSON.stringify(p2.d).slice(0, 80))
  ok(Object.keys(accs).length >= 5, '账户数 ≥ 5', Object.keys(accs).join('/'))

  let c0 = (await req('/categories')).d
  cats.out = (c0.out || []).map((x) => x.name)
  cats.in = (c0.inn || []).map((x) => x.name)
  // 新库默认 9 类（工资/水电/房租/采购/辅料/运费/维修/税金/其他），补上「材料/办公/税/押金」
  for (const n of ['材料', '办公', '税', '押金']) {
    if (cats.out.includes(n)) continue
    const r = await req('/categories', 'POST', { type: 'out', name: n })
    ok(r.status === 200, '支出分类 ' + n, JSON.stringify(r.d).slice(0, 60))
  }
  c0 = (await req('/categories')).d
  cats.out = (c0.out || []).map((x) => x.name)
  ok(cats.out.length >= 12, '支出分类 ≥ 12', cats.out.join(','))
  OUT_CATS.length = 0
  for (const n of ['材料', '辅料', '运费', '办公', '维修', '水电', '房租', '工资', '税']) if (cats.out.includes(n)) OUT_CATS.push(n)
  ok(OUT_CATS.length >= 9, '本轮使用的支出分类', OUT_CATS.join(','))

  // 员工（口令 8 位数字）
  for (const nm of ['小王', '老李']) {
    const r = await req('/staff-users', 'POST', { name: nm, pass: '123456', mods: null })
    ok(r.status === 200, '员工 ' + nm, JSON.stringify(r.d).slice(0, 80))
  }
  // 计件单价
  for (const [w, rate] of [['*', 12.5], ['小王', 15], ['老李', 13]]) {
    const r = await req('/wage-rates', 'POST', { worker: w, rate })
    ok(r.status === 200, '计件单价 ' + w + '=' + rate, JSON.stringify(r.d).slice(0, 60))
  }
  // 材料
  for (const [name, unit, min] of [['钢板', '张', 20], ['焊丝', '卷', 10], ['砂轮', '个', 30], ['防锈漆', '桶', 5], ['包装膜', '卷', 8]]) {
    const r = await req('/materials', 'POST', { name, unit, min_qty: min })
    ok(r.status === 200, '材料 ' + name, JSON.stringify(r.d).slice(0, 60))
  }
  // 账期
  for (const pt of CUST.slice(0, 6)) await req('/party-terms', 'POST', { party: pt, kind: 'ar', term_days: 30 })
  for (const pt of CUST.slice(6)) await req('/party-terms', 'POST', { party: pt, kind: 'ar', term_days: 45 })
  for (const pt of SUP) await req('/party-terms', 'POST', { party: pt, kind: 'ap', term_days: 30 })
  ok(true, '账期：应收 30/45 天、应付 30 天')
  // 预算
  for (const [cat, amt] of [['房租', 30000], ['水电', 12000], ['运费', 8000], ['办公', 3000]]) {
    const r = await req('/budgets', 'POST', { category: cat, amount: amt })
    ok(r.status === 200, '预算 ' + cat, JSON.stringify(r.d).slice(0, 60))
  }
  // 信用额度
  const clr = await req('/credit-limits', 'POST', { party: CUST[0], limit_amount: 60000 })
  ok(clr.status === 200, '信用额度 恒达机械 6 万', JSON.stringify(clr.d).slice(0, 60))
}

// ── 1. 订单 + 收款 ──
console.log('［1］订单与收款（8 个月）')
let orderIds = []
{
  let n = 0
  for (let mi = 0; mi < MONTHS.length; mi++) {
    const m = MONTHS[mi]
    for (let i = 0; i < 45; i++) {
      const cust = CUST[(mi * 5 + i) % CUST.length]
      const price = r2(800 + ((mi * 37 + i * 61) % 5200))
      const cost = r2(price * (0.55 + ((i % 5) * 0.04)))
      const d = day(m, i)
      const r = await req('/orders', 'POST', {
        customer: cust, item_name: ['法兰盘', '支架', '壳体', '齿轮坯', '端盖'][i % 5],
        price, cost, date: d, due_date: addDays(d, 30), deliver_date: addDays(d, (i % 9) + 1),
        operator: ['小王', '老李'][i % 2], confirm_dup: true, client_id: cid('ord'),
      })
      if (r.status !== 200 || !r.d.ok) { bad++; console.log('  ❌ 订单失败', m, i, r.status, JSON.stringify(r.d).slice(0, 120)); continue }
      n++
    }
  }
  ok(n === 360, '订单 360 张', n)

  // 找订单 id（按客户名 + 金额反查）
  const list = []
  for (let off = 0; off < 1000; off += 200) {
    const pg = (await req('/ar?status=all&limit=200&offset=' + off)).d
    const arr = Array.isArray(pg) ? pg : (pg.list || pg.rows || [])
    if (!arr.length) break
    for (const x of arr) list.push(x)
    if (arr.length < 200) break
  }
  orderIds = list.map((x) => ({ id: x.id, customer: x.customer, price: num(x.price), paid: num(x.paid), created: (x.created_at || '').slice(0, 10) }))
  ok(orderIds.length >= 360, '应收列表反查到订单', orderIds.length)
  function num(v) { return Number(v || 0) }
  // 收款：前 6 个月的单都收，第 7/8 个月收一半
  let got = 0
  for (let k = 0; k < orderIds.length; k++) {
    const o = orderIds[k]
    const mi = MONTHS.findIndex((m) => o.created.startsWith(m))
    const fully = mi <= 5 ? (k % 10 !== 0) : (k % 3 === 0)
    const half = !fully && mi <= 5
    if (!fully && !half) continue
    const amt = fully ? o.price : r2(o.price / 2)
    const dt = clampToday(addDays(o.created, 12 + (k % 20)))
    const r = await req('/orders/' + o.id + '/receive', 'POST', {
      amount: amt, date: dt, account_id: k % 4 === 0 ? accs['现金'] : accs['农行'], client_id: cid('rcv'),
    })
    if (r.status !== 200 || !r.d.ok) { bad++; if (bad < 8) console.log('  ❌ 收款失败', o.id, r.status, JSON.stringify(r.d).slice(0, 120)) }
    else got++
  }
  ok(got > 250, '收款笔数', got)
}

// ── 2. 应付 + 付款 ──
console.log('［2］应付与付款（8 个月）')
{
  let n = 0
  for (let mi = 0; mi < MONTHS.length; mi++) {
    const m = MONTHS[mi]
    for (let i = 0; i < 22; i++) {
      const sup = SUP[(mi * 3 + i) % SUP.length]
      const amt = r2(500 + ((mi * 53 + i * 71) % 4200))
      const d = day(m, i + 2)
      const r = await req('/payables', 'POST', {
        supplier: sup, amount: amt, category: OUT_CATS[i % 4], date: d, due_date: addDays(d, 30),
        remark: ['钢材', '焊材', '砂轮', '运费'][i % 4] + ' ' + (i + 1), confirm_dup: true,
      })
      if (r.status !== 200 || !r.d.ok) { bad++; if (bad < 12) console.log('  ❌ 应付失败', m, i, r.status, JSON.stringify(r.d).slice(0, 120)); continue }
      n++
    }
  }
  ok(n === 176, '应付 176 张', n)
  const apList = []
  for (let off = 0; off < 1000; off += 200) {
    const pg = (await req('/ap?status=all&limit=200&offset=' + off)).d
    const arr = Array.isArray(pg) ? pg : (pg.list || pg.rows || [])
    if (!arr.length) break
    for (const x of arr) apList.push(x)
    if (arr.length < 200) break
  }
  const list = apList.map((x) => ({ id: x.id, amount: Number(x.amount || 0), paid: Number(x.paid || 0), created: String(x.created_at || '').slice(0, 10) }))
  let pn = 0
  for (let k = 0; k < list.length; k++) {
    const p = list[k]
    const mi = MONTHS.findIndex((m) => p.created.startsWith(m))
    const fully = mi <= 5 ? k % 8 !== 0 : k % 4 === 0
    const half = !fully && mi <= 5
    if (!fully && !half) continue
    const amt = fully ? p.amount - p.paid : r2((p.amount - p.paid) / 2)
    if (!(amt > 0)) continue
    const r = await req('/payables/' + p.id + '/pay', 'POST', {
      amount: amt, date: clampToday(addDays(p.created, 10 + (k % 18))), account_id: accs['农行'], client_id: cid('pay'),
    })
    if (r.status !== 200 || !r.d.ok) { bad++; if (bad < 16) console.log('  ❌ 付款失败', p.id, r.status, JSON.stringify(r.d).slice(0, 120)) }
    else pn++
  }
  ok(pn > 100, '付款笔数', pn)
}

// ── 3. 现金支出 ──
console.log('［3］现金支出（8 个月）')
{
  let n = 0
  const PLAN = [
    ['房租', 30000, 1], ['工资', 0, 5], ['水电', 0, 8], ['运费', 0, 10], ['办公', 0, 12], ['维修', 0, 15], ['税', 0, 20],
  ]
  for (let mi = 0; mi < MONTHS.length; mi++) {
    const m = MONTHS[mi]
    for (const [cat, fixed, dd] of PLAN) {
      const amt = fixed || r2([0, 0, 0][0] || (1200 + ((mi * 17 + dd * 23) % 3800) + (cat === '工资' ? 8000 : 0)))
      const r = await req('/expenses', 'POST', {
        amount: amt, category: cat, remark: cat + ' ' + m, date: m + '-' + pad(dd),
        account_id: cat === '税' ? accs['农行'] : accs['现金'], confirm_dup: true, client_id: cid('exp'),
      })
      if (r.status !== 200 || !r.d.ok) { bad++; if (bad < 20) console.log('  ❌ 支出失败', m, cat, r.status, JSON.stringify(r.d).slice(0, 120)) }
      else n++
    }
  }
  ok(n === 56, '支出 56 笔（7 类 × 8 月）', n)
}

// ── 4. 账户之间转账 ──
console.log('［4］账户转账')
{
  let n = 0
  for (let mi = 0; mi < MONTHS.length; mi++) {
    const r = await req('/transfers', 'POST', {
      from: accs['农行'], to: accs['现金'], amount: 8000, date: MONTHS[mi] + '-06', remark: '取现备零钱', client_id: cid('trf'),
    })
    if (r.status !== 200 || !r.d.ok) { bad++; console.log('  ❌ 转账失败', MONTHS[mi], r.status, JSON.stringify(r.d).slice(0, 120)) } else n++
  }
  ok(n === 8, '转账 8 笔', n)
}

// ── 5. 借支（员工预支 + 报销 + 退回） ──
console.log('［5］借支')
{
  let n = 0
  const ids = []
  for (let mi = 0; mi < 8; mi++) {
    const r = await req('/loans', 'POST', {
      staff: ['小王', '老李'][mi % 2], amount: 3000, remark: '出差预支 ' + MONTHS[mi], date: MONTHS[mi] + '-08',
      account_id: accs['现金'], client_id: cid('loan'),
    })
    if (r.status !== 200 || !r.d.ok) { bad++; console.log('  ❌ 借支失败', r.status, JSON.stringify(r.d).slice(0, 120)) } else { n++; ids.push(r.d.id) }
  }
  ok(n === 8, '借支 8 笔', n)
  // 前 4 笔报销掉（转成本），后 2 笔现金退回
  for (let i = 0; i < 4; i++) {
    const r = await req('/loans/' + ids[i] + '/reimburse', 'POST', { amount: 2000, category: '运费', remark: '运费报销', date: MONTHS[i] + '-20' })
    ok(r.status === 200, '借支 ' + ids[i] + ' 报销 2000', JSON.stringify(r.d).slice(0, 80))
  }
  for (let i = 4; i < 6; i++) {
    const r = await req('/loans/' + ids[i] + '/return', 'POST', { amount: 3000, account_id: accs['现金'], date: MONTHS[i] + '-22' })
    ok(r.status === 200, '借支 ' + ids[i] + ' 退回 3000', JSON.stringify(r.d).slice(0, 80))
  }
  const ln = (await req('/loans')).d
  const l2 = ln.list || ln.rows || ln || []
  ok(l2.length >= 8, '借支列表', l2.length)
}

// ── 6. 固定资产 + 折旧 ──
console.log('［6］固定资产与折旧')
{
  const assets = [
    ['数控车床 CK6140', 180000, '2026-04-10', 10],
    ['龙门铣床', 260000, '2026-05-06', 10],
    ['货车（五菱）', 88000, '2026-06-15', 6],
    ['空压机', 12000, '2026-08-01', 5],
  ]
  for (const [name, cost, buy, life] of assets) {
    const r = await req('/assets', 'POST', { name, cost, buy_date: buy, life_years: life, residual_rate: 5, confirm: true })
    ok(r.status === 200, '固定资产 ' + name, JSON.stringify(r.d).slice(0, 80))
  }
  const rf = await req('/run-fixed', 'POST', {})
  ok(rf.status === 200, '按月计提折旧', JSON.stringify(rf.d).slice(0, 80))
  const fa = (await req('/assets')).d
  const fl = fa.list || fa.rows || []
  ok(fl.length >= 4, '资产列表', fl.length)
  ok(fl.every((x) => Number(x.acc_dep || x.dep || 0) > 0), '每项都有累计折旧', fl.map((x) => x.name + ':' + (x.acc_dep || x.dep)).join(' '))
}

// ── 7. 材料库存 ──
console.log('［7］材料库存')
{
  let n = 0
  for (let mi = 0; mi < 8; mi++) {
    const m = MONTHS[mi]
    for (const [name, qty, price] of [['钢板', 40, 320], ['焊丝', 20, 180], ['砂轮', 60, 45]]) {
      let r = await req('/material-moves', 'POST', { material: name, qty, kind: 'in', date: m + '-03', price, remark: '进货', client_id: cid('mm') })
      if (r.status !== 200 || !r.d.ok) { bad++; if (bad < 24) console.log('  ❌ 入库失败', name, r.status, JSON.stringify(r.d).slice(0, 120)) } else n++
      r = await req('/material-moves', 'POST', { material: name, qty: Math.round(qty * 0.7), kind: 'out', date: m + '-18', remark: '领料', client_id: cid('mm') })
      if (r.status !== 200 || !r.d.ok) { bad++; if (bad < 26) console.log('  ❌ 出库失败', name, r.status, JSON.stringify(r.d).slice(0, 120)) } else n++
    }
  }
  ok(n === 48, '材料出入库 48 条', n)
  const mm = (await req('/materials')).d
  const ml = mm.list || mm.rows || []
  ok(ml.length >= 5, '材料列表', ml.length)
}

// ── 8. 外协 ──
console.log('［8］外协')
{
  let n = 0
  const ids = []
  for (let mi = 0; mi < 8; mi++) {
    for (let i = 0; i < 4; i++) {
      const r = await req('/outsource', 'POST', {
        party: SUP[(mi + i) % SUP.length], item: '热处理', qty: 100 + i * 20, price: r2(1200 + i * 300),
        out_date: MONTHS[mi] + '-' + pad(4 + i), remark: '外协热处理 ' + MONTHS[mi],
      })
      if (r.status !== 200 || !r.d.ok) { bad++; if (bad < 30) console.log('  ❌ 外协失败', r.status, JSON.stringify(r.d).slice(0, 120)) } else n++
    }
  }
  ok(n === 32, '外协 32 条', n)
  // POST /outsource 不回 id，回货要从 /outsource-book 反查
  const ob = (await req('/outsource-book')).d
  const openIds = ((ob.rows || []).filter((x) => x.status === 'open').map((x) => x.id)).slice(0, 20)
  ok(openIds.length === 20, '外协待回货 20 条可反查', openIds.length)
  for (const id of openIds) {
    const r = await req('/outsource/' + id + '/back', 'POST', { back_date: '2026-10-20' })
    if (r.status !== 200) { bad++; if (bad < 34) console.log('  ❌ 外协回货失败', id, JSON.stringify(r.d).slice(0, 100)) }
  }
  ok(true, '外协回货 20 条')
}

// ── 9. 发票 ──
console.log('［9］发票')
{
  let n = 0
  for (let mi = 0; mi < 8; mi++) {
    const r = await req('/invoices', 'POST', {
      type: 'out', no: 'FP' + 202604 + mi, party: CUST[mi % CUST.length], amount: 5000 + mi * 300,
      tax: 13, date: MONTHS[mi] + '-25', remark: '销项 ' + MONTHS[mi],
    })
    if (r.status !== 200 || !r.d.ok) { bad++; if (bad < 36) console.log('  ❌ 销项发票失败', r.status, JSON.stringify(r.d).slice(0, 120)) } else n++
    const r2r = await req('/invoices', 'POST', {
      type: 'in', no: 'FPIN' + 202604 + mi, party: SUP[mi % SUP.length], amount: 3000 + mi * 200,
      tax: 13, date: MONTHS[mi] + '-26', remark: '进项 ' + MONTHS[mi],
    })
    if (r2r.status !== 200 || !r2r.d.ok) { bad++; if (bad < 38) console.log('  ❌ 进项发票失败', r2r.status, JSON.stringify(r2r.d).slice(0, 120)) } else n++
  }
  ok(n === 16, '发票 16 张', n)
}

// ── 10. 预付摊销 ──
console.log('［10］预付与摊销')
{
  const r1 = await req('/prepaids', 'POST', { name: '厂房租金（半年）', total: 120000, months: 6, start_date: '2026-06-01', category: '房租', account_id: accs['农行'], remark: '半年房租' })
  ok(r1.status === 200, '预付 12 万 / 6 个月', JSON.stringify(r1.d).slice(0, 100))
  const r2r = await req('/prepaids', 'POST', { name: '押金', total: 20000, months: 0, start_date: '2026-06-01', category: '押金', account_id: accs['农行'], remark: '押金，退租收回' })
  ok(r2r.status === 200, '押金 2 万（不摊）', JSON.stringify(r2r.d).slice(0, 100))
  const ra = await req('/run-amort', 'POST', {})
  ok(ra.status === 200, '跑摊销', JSON.stringify(ra.d).slice(0, 100))
}

// ── 11. 借款 ──
console.log('［11］借款')
{
  const r = await req('/debts', 'POST', { lender: '农商行', kind: 'bank', principal: 300000, rate: 4.35, start_date: '2026-04-01', term_months: 12, pay_kind: 'interest', account_id: accs['农行'], remark: '流动资金贷款' })
  ok(r.status === 200, '借款 30 万', JSON.stringify(r.d).slice(0, 100))
  if (r.d.id) {
    const rp = await req('/debts/' + r.d.id + '/repay', 'POST', { amount: 50000, kind: 'principal', date: '2026-10-08', account_id: accs['农行'] })
    const ri = await req('/debts/' + r.d.id + '/repay', 'POST', { amount: 1087.5, kind: 'interest', date: '2026-10-08', account_id: accs['农行'] })
    ok(rp.status === 200, '还本 5 万', JSON.stringify(rp.d).slice(0, 100))
  }
}

// ── 12. 预收 ──
console.log('［12］预收')
{
  for (let i = 0; i < 3; i++) {
    const r = await req('/advances', 'POST', { type: 'in', party: CUST[i], amount: 5000 + i * 1000, remark: '预付定金', account_id: accs['农行'], date: MONTHS[5 + i] + '-12' })
    ok(r.status === 200, '预收 ' + CUST[i], JSON.stringify(r.d).slice(0, 80))
  }
  const adv = (await req('/advances?type=in')).d
  const al = Array.isArray(adv) ? adv : (adv.list || adv.rows || [])
  // 拿一笔去抵扣订单
  const first = al.find((x) => x.type === 'in' && Number(x.used || 0) === 0)
  // 找这张单那个客户「还没收清」的单（orderIds[0] 常常已经收清了，硬抵扣会 400）
  let tgt = null
  if (first) {
    for (let off = 0; off < 600 && !tgt; off += 200) {
      const pg = (await req('/ar?status=all&limit=200&offset=' + off)).d
      const arr = Array.isArray(pg) ? pg : []
      if (!arr.length) break
      tgt = arr.find((o) => o.customer === first.party && Number(o.price) - Number(o.paid || 0) - Number(o.written_off || 0) > 2000) || null
      if (arr.length < 200) break
    }
  }
  if (first && tgt) {
    const r = await req('/orders/' + tgt.id + '/apply-advance', 'POST', { advance_id: first.id, amount: 2000 })
    if (r.status === 200 && r.d.ok) ok(true, '预收抵扣订单 #' + tgt.id + ' 2000', first.party)
    else { bad++; console.log('  ❌ 预收抵扣订单失败', tgt.id, r.status, JSON.stringify(r.d).slice(0, 150)) }
  } else { bad++; console.log('  ❌ 找不到可抵扣的单/预收', !!first, !!tgt) }
}

// ── 13. 核销（坏账） ──
console.log('［13］核销')
{
  const wl = []
  for (let off = 0; off < 600; off += 200) {
    const pg = (await req('/ar?status=all&limit=200&offset=' + off)).d
    const arr = Array.isArray(pg) ? pg : []
    if (!arr.length) break
    for (const x of arr) wl.push(x)
    if (arr.length < 200) break
  }
  const list = wl.filter((x) => Number(x.price) - Number(x.paid || 0) - Number(x.written_off || 0) > 100)
  for (let i = 0; i < 2 && i < list.length; i++) {
    const o = list[i]
    const amt = r2(Number(o.price) - Number(o.paid || 0) - Number(o.written_off || 0))
    const r = await req('/orders/' + o.id + '/writeoff', 'POST', { amount: amt, reason: '对方失联，核销', date: '2026-11-20' })
    ok(r.status === 200, '应收核销 #' + o.id + ' ' + amt, JSON.stringify(r.d).slice(0, 100))
  }
  const wpl = []
  for (let off = 0; off < 600; off += 200) {
    const pg = (await req('/ap?status=all&limit=200&offset=' + off)).d
    const arr = Array.isArray(pg) ? pg : []
    if (!arr.length) break
    for (const x of arr) wpl.push(x)
    if (arr.length < 200) break
  }
  const apl = wpl.filter((x) => Number(x.amount) - Number(x.paid || 0) - Number(x.written_off || 0) > 100)
  for (let i = 0; i < 2 && i < apl.length; i++) {
    const p = apl[i]
    const amt = r2(Number(p.amount) - Number(p.paid || 0) - Number(p.written_off || 0))
    const r = await req('/payables/' + p.id + '/writeoff', 'POST', { amount: amt, reason: '供应商让账，核销', date: '2026-11-21' })
    ok(r.status === 200, '应付核销 #' + p.id + ' ' + amt, JSON.stringify(r.d).slice(0, 100))
  }
}

// ── 14. 计件工资 + 发工资 ──
console.log('［14］计件工资')
{
  let n = 0
  for (let mi = 0; mi < 8; mi++) {
    const m = MONTHS[mi]
    for (const [w, qty] of [['小王', 320 + mi * 10], ['老李', 280 + mi * 8]]) {
      const r = await req('/wage-records', 'POST', { worker: w, qty, month: m, date: m + '-' + pad(28), remark: '计件 ' + m })
      if (r.status !== 200 || !r.d.ok) { bad++; if (bad < 42) console.log('  ❌ 计件失败', w, m, r.status, JSON.stringify(r.d).slice(0, 120)) } else n++
    }
  }
  ok(n === 16, '计件记录 16 条', n)
  // 扣款
  const rd = await req('/wage-deducts', 'POST', { month: '2026-10', worker: '小王', amount: 200, kind: '迟到', remark: '迟到扣款' })
  ok(rd.status === 200, '扣款 200', JSON.stringify(rd.d).slice(0, 80))
  // 发工资（前 6 个月）
  for (let mi = 0; mi < 6; mi++) {
    const pr = (await req('/payroll?month=' + MONTHS[mi])).d
    const rows = (pr && pr.rows) || []
    const ws = rows.filter((x) => Number(x.left || 0) > 0.005).map((x) => x.worker)
    if (!ws.length) { console.log('  ⚠ 工资表为空', MONTHS[mi], JSON.stringify(pr).slice(0, 200)); continue }
    const r = await req('/payroll/pay', 'POST', { month: MONTHS[mi], workers: ws, account_id: accs['现金'], date: MONTHS[mi] + '-30', client_id: cid('payroll') })
    if (r.status !== 200 || !r.d.ok) { bad++; console.log('  ❌ 发工资失败', MONTHS[mi], r.status, JSON.stringify(r.d).slice(0, 150)) }
  }
  ok(true, '发工资 6 个月')
}

// ── 15. 报价单 ──
console.log('［15］报价')
{
  let n = 0
  for (let i = 0; i < 6; i++) {
    const r = await req('/quotes', 'POST', { party: CUST[i], item: '法兰盘 DN' + (50 + i * 10), cost: 80 + i * 10, price: 110 + i * 15, qty: 500, remark: '报价 ' + i })
    if (r.status !== 200 || !r.d.ok) { bad++; console.log('  ❌ 报价失败', r.status, JSON.stringify(r.d).slice(0, 120)) } else n++
  }
  ok(n === 6, '报价 6 条', n)
}

// ── 15.5 自动记账四步（固定支出 / 摊销 / 预提利息 / 折旧） ──
// 真实用法里 cron 每天跑；月结之前必须先跑过，否则已结账月份的折旧永远补不上
console.log('［15.5］自动记账四步')
{
  const r1 = await req('/run-cron', 'POST', {})
  ok(r1.status === 200 && r1.d.ok !== false, 'run-cron 第一遍', JSON.stringify(r1.d).slice(0, 300))
  const r2 = await req('/run-cron', 'POST', {})
  ok(r2.status === 200 && r2.d.ok !== false, 'run-cron 第二遍（幂等）', JSON.stringify(r2.d).slice(0, 300))
  const deps = (r2.d || {})
  ok(!deps.dep || Number(deps.dep.added || 0) === 0, '第二遍折旧不重复提', JSON.stringify(deps.dep))
  const sc = await req('/selfcheck')
  ok(sc.status === 200, '自检能跑', JSON.stringify(sc.d).slice(0, 200))
  if (sc.d && Array.isArray(sc.d.items)) {
    const badIt = sc.d.items.filter((x) => x && x.bad)
    ok(badIt.length === 0, '自检 0 项异常', badIt.map((x) => x.k + ':' + x.bad).join(' '))
  }
}

// ── 16. 月结（前 6 个月结账锁定） ──
console.log('［16］月结')
{
  for (let mi = 0; mi < 6; mi++) {
    const pc = await req('/close-precheck?month=' + MONTHS[mi])
    if (pc.status !== 200) { bad++; console.log('  ❌ 结账预检失败', MONTHS[mi], pc.status, JSON.stringify(pc.d).slice(0, 150)); continue }
    const r = await req('/month-close', 'POST', { month: MONTHS[mi], confirm: true })
    if (r.status !== 200 || !r.d.ok) { bad++; console.log('  ❌ 月结失败', MONTHS[mi], r.status, JSON.stringify(r.d).slice(0, 200)) }
    else ok(true, '月结 ' + MONTHS[mi], JSON.stringify(r.d).slice(0, 90))
  }
}

// ── 17. 抵扣与处置（桥接里 3 行专门管这些，以前模拟数据从没走过） ──
console.log('［17］预收抵扣 / 预付抵扣 / 设备处置')
{
  const arAll = []
  for (let off = 0; off < 600; off += 200) {
    const pg = (await req('/ar?status=all&limit=200&offset=' + off)).d
    const arr = Array.isArray(pg) ? pg : []
    if (!arr.length) break
    for (const x of arr) arAll.push(x)
    if (arr.length < 200) break
  }
  const advAll = ((await req('/advances?type=in')).d || [])
  const advList = Array.isArray(advAll) ? advAll : (advAll.list || advAll.rows || [])
  // ① 预收抵扣：找一张「有预收的客户 + 还没收清 + 月份没锁」的单
  const preIn = advList.filter((x) => x.type === 'in' && Number(x.amount) - Number(x.used || 0) > 0)
  let doneAdv = 0
  for (const ad of preIn) {
    const target = arAll.find((o) => o.customer === ad.party && String(o.month || o.created_at || '').slice(0, 7) >= '2026-10'
      && Number(o.price) - Number(o.paid || 0) - Number(o.written_off || 0) > 1)
    if (!target) continue
    const left = Math.min(Number(ad.amount) - Number(ad.used || 0), Number(target.price) - Number(target.paid || 0) - Number(target.written_off || 0))
    const r = await req('/orders/' + target.id + '/apply-advance', 'POST', { advance_id: ad.id, amount: r2(left) })
    if (r.status === 200 && r.d.ok) { doneAdv++; ok(true, '预收抵扣 #' + target.id + ' ¥' + r2(left), ad.party) }
    else { bad++; console.log('  ❌ 预收抵扣失败', target.id, r.status, JSON.stringify(r.d).slice(0, 150)) }
    if (doneAdv >= 2) break
  }
  ok(doneAdv > 0, '预收抵扣至少走一笔', doneAdv)

  // ② 预付抵扣：先给供应商打一笔预付款，再拿它抵一张应付
  const sup = '宝钢贸易'
  const rp = await req('/advances', 'POST', { type: 'out', party: sup, amount: 30000, remark: '先打款后发货', account_id: accs['农行'], date: '2026-10-06' })
  ok(rp.status === 200, '付供应商预付款 30000', JSON.stringify(rp.d).slice(0, 80))
  const advList2 = (((await req('/advances?type=out')).d) || [])
  const outList2 = Array.isArray(advList2) ? advList2 : (advList2.list || advList2.rows || [])
  const outAdv = outList2.filter((x) => x.type === 'out' && x.party === sup && Number(x.amount) - Number(x.used || 0) > 0)[0]
  const apAll = []
  for (let off = 0; off < 600; off += 200) {
    const pg = (await req('/ap?status=all&limit=200&offset=' + off)).d
    const arr = Array.isArray(pg) ? pg : []
    if (!arr.length) break
    for (const x of arr) apAll.push(x)
    if (arr.length < 200) break
  }
  const apTarget = apAll.find((x) => x.supplier === sup && String(x.month || x.created_at || '').slice(0, 7) >= '2026-10'
    && Number(x.amount) - Number(x.paid || 0) - Number(x.written_off || 0) > 1)
  if (outAdv && apTarget) {
    const left = Math.min(Number(outAdv.amount) - Number(outAdv.used || 0), Number(apTarget.amount) - Number(apTarget.paid || 0) - Number(apTarget.written_off || 0))
    const r = await req('/payables/' + apTarget.id + '/apply-advance', 'POST', { advance_id: outAdv.id, amount: r2(left) })
    ok(r.status === 200 && r.d.ok, '预付抵扣 #' + apTarget.id + ' ¥' + r2(left), JSON.stringify(r.d).slice(0, 120))
    if (r.status !== 200) bad++
  } else { bad++; console.log('  ❌ 找不到可抵扣的应付/预付款', !!outAdv, !!apTarget) }

  // ③ 设备处置（报废一台小设备，卖 5000）
  const asList = ((await req('/assets')).d || {})
  const asRows = asList.rows || asList.list || []
  const small = asRows.find((x) => !x.disposed_at && Number(x.cost) <= 13000) || asRows.find((x) => !x.disposed_at)
  if (small) {
    const r = await req('/assets/' + small.id + '/dispose', 'POST', { amount: 5000, date: '2026-11-15', account_id: accs['农行'], remark: '报废卖废铁', client_id: cid('dispose') })
    ok(r.status === 200 && r.d.ok, '处置设备「' + small.name + '」', JSON.stringify(r.d).slice(0, 120))
    if (r.status !== 200) bad++
  } else { bad++; console.log('  ❌ 没有可处置的设备') }
}

console.log('\n=== 灌数据完成：' + (bad ? '❌ ' + bad + ' 处失败' : '✅ 全部成功') + ' ===')
if (bad) process.exitCode = 1
