// 备份 → 一键初始化 → 恢复，这条链的**逐列**完整性回归。
//
// 为什么要有它：`restoreCore()` 恢复三张主表时原来是**手写列清单**，每加一列都要记得同步。
// no_invoice / delivered_at / tax_* / created_by / ar_cat 全是这么丢过的——恢复完接口回 ok、
// 页面也正常，只是那些列静默变成默认值（税表归零、分类报表归零、交期提醒重新冒出来）。
// 光测「能恢复」永远发现不了，所以这里比的是「每一行的每一列，恢复前后是不是一模一样」。
//
// 用法：node scripts/test-restore.mjs --base http://127.0.0.1:8791 --key 8888
const num0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const BASE = opt('base', 'http://127.0.0.1:8791').replace(/\/+$/, '')
// 第 16 轮 C5：这个脚本会**清空/覆盖账本**。以前没有任何提醒，默认又指 8791（wrangler dev），
// 照 docs/RUNBOOK.md 在本机版（8787）上跑会连不上；有人顺手改成线上地址就真把生产账本清了。
// 现在：目标不是本机时必须显式加 --yes，并且开头就把后果打在屏幕上。
const IS_LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(BASE)
if (!IS_LOCAL && !argv.includes('--yes')) {
  console.error('❌ 目标不是本机（' + BASE + '）：这个脚本会清空/覆盖账本。真要跑请加 --yes。')
  process.exit(2)
}
console.log('⚠️  这个脚本会清空或覆盖账本数据（目标 ' + BASE + '）')
const KEY = opt('key', '8888')
const TAG = '恢复测' + Math.random().toString(36).slice(2, 6)
const TODAY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const MONTH = TODAY.slice(0, 7)

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

// 对比两份「行集合」：按 id 对齐，逐列比。返回差异描述（最多几条）与不一致的单元格总数。
function diffRows(table, before, after) {
  const keyOf = (r) => String(r.id !== undefined && r.id !== null ? r.id : JSON.stringify(r))
  const map = new Map()
  for (const r of after) map.set(keyOf(r), r)
  const diffs = []
  let badCells = 0
  for (const r of before) {
    const a = map.get(keyOf(r))
    if (!a) { diffs.push(`${table}#${keyOf(r)} 恢复后不见了`); badCells++; continue }
    for (const k of Object.keys(r)) {
      const x = r[k]
      const y = a[k]
      if (k === 'month' && (x === '' || x === null) && y) continue // 老备份没 month，恢复时按 created_at 补
      let same
      if (typeof x === 'number' || (typeof x === 'string' && /^-?\d+(\.\d+)?$/.test(x) && typeof y === 'number')) same = Math.abs(num0(x) - num0(y)) <= 0.005
      else same = JSON.stringify(x) === JSON.stringify(y)
      if (!same) { badCells++; if (diffs.length < 6) diffs.push(`${table}#${keyOf(r)}.${k}: ${JSON.stringify(x)} → ${JSON.stringify(y)}`) }
    }
  }
  return { diffs, badCells }
}

async function main() {
  console.log(`备份 / 恢复逐列回归（base=${BASE}，标记 ${TAG}）`)
  const me = await get('/me')
  eq('老板口令能用', me.d && me.d.role, 'owner')

  // ── 1. 造一份「每一列都有值」的账 ─────────────────────────────
  const exA0 = await get('/export-all')
  const baseOrders = num0(exA0.d && exA0.d.counts && exA0.d.counts.orders)
  const acc = ((await get('/accounts')).d || {})
  const accList = acc.accounts || acc.list || []
  const accCash = (accList.find((a) => a.name === '现金') || accList[0] || {}).id
  yes('有账户可用', !!accCash, accCash)

  // 基线：库里可能已经有别的数据（重复跑、或者别的测试留下的），断言一律用增量
  const s0 = await get('/ar-summary')
  const baseOpen = num0(s0.d && s0.d.open_amount)
  const m0 = await get('/month-report?month=' + MONTH)
  const baseAdd = num0(m0.d && m0.d.order_add)

  const o1 = await post('/orders', {
    customer: TAG + '甲', item_name: TAG + '件', price: 2000, cost: 1200,
    due_date: TODAY, deliver_date: TODAY, operator: TAG + '人',
    tax_kind: '不含税', tax_rate: 10, ar_cat: '加工费'
  })
  eq('建单（带分类 / 税 / 交期 / 工序）', o1.s, 200)
  const list1 = (await get('/ar?status=all&kw=' + encodeURIComponent(TAG + '甲'))).d
  const oid = (((Array.isArray(list1) ? list1 : (list1 && list1.list) || [])[0]) || {}).id
  yes('能查回这张单', !!oid, oid)

  eq('改工序进度', (await call('PATCH', `/orders/${oid}/progress`, KEY, { progress: '已排产', operator: TAG + '人' })).s, 200)
  // 票据状态字段叫 inv（'yes'/'no'），不是 inv_state
  const rc = await post(`/orders/${oid}/receive`, { amount: 800, account_id: accCash, date: TODAY, inv: 'yes', inv_no: TAG + 'FP1', tax: 72 })
  eq('收款（带票号 / 税额）', rc.s, 200)
  const wo = await post(`/orders/${oid}/writeoff`, { amount: 50, reason: '抹零', date: TODAY })
  eq('核销一部分（写 written_off / rev）', wo.s, 200)

  const p1 = await post('/payables', { supplier: TAG + '供', amount: 1500, category: '硫酸', remark: TAG + '备注', due_date: TODAY, tax_kind: '含税', tax_rate: 13 })
  eq('建应付（带分类 / 税）', p1.s, 200)
  const apList = (await get('/ap?status=all')).d
  const pid = (((Array.isArray(apList) ? apList : (apList && apList.list) || [])).filter((x) => String(x.supplier || '').indexOf(TAG) === 0)[0] || {}).id
  yes('能查回这张应付', !!pid, pid)
  eq('付一部分（没票）', (await post(`/payables/${pid}/pay`, { amount: 500, account_id: accCash, date: TODAY, inv: 'no' })).s, 200)

  eq('记支出', (await post('/expenses', { amount: 300 + (Date.now() % 700), category: '水电', remark: TAG, account_id: accCash, date: TODAY })).s, 200)
  eq('记预收', (await post('/advances', { type: 'in', party: TAG + '甲', amount: 200, account_id: accCash })).s, 200)
  const lo = await post('/loans', { staff: TAG + '人', amount: 500, date: TODAY, remark: TAG })
  eq('记借支', lo.s, 200)
  const loans = (await get('/loans')).d || {}
  const lid = (((loans.list || []).filter((x) => String(x.staff || '') === TAG + '人'))[0] || {}).id
  if (lid) eq('借支退回一部分（used / returned）', (await post(`/loans/${lid}/return`, { amount: 120, date: TODAY })).s, 200)

  const db = await post('/debts', { lender: TAG + '银行', kind: 'bank', principal: 30000, rate: 4.5, start_date: TODAY, term_months: 12, pay_kind: 'interest' })
  eq('记借款（本金 / 利率 / 期限）', db.s, 200)
  const debts = (await get('/debts')).d || {}
  const did = (((debts.debts || []).filter((x) => String(x.lender || '').indexOf(TAG) === 0))[0] || {}).id
  if (did) eq('还一部分本金', (await post(`/debts/${did}/repay`, { amount: 1000, kind: 'principal', date: TODAY })).s, 200)

  eq('记预付待摊（期数 / 起始日）', (await post('/prepaids', { name: TAG + '租金', total: 6000, months: 6, start_date: TODAY, category: '房租', account_id: accCash })).s, 200)
  eq('记资产（年限 / 残值率）', (await post('/assets', { name: TAG + '设备', cost: 20000, buy_date: TODAY, life_years: 5, residual_rate: 5 })).s, 200)
  eq('记材料（最低库存）', (await post('/materials', { name: TAG + '料', unit: 'kg', min_qty: 10 })).s, 200)
  eq('记材料出入', (await post('/material-moves', { material: TAG + '料', kind: 'in', qty: 5, price: 100, date: TODAY })).s, 200)
  await post('/party-terms', { party: TAG + '甲', term_days: 45, recon_cycle: 30, recon_day: 5, note: TAG + '账期' })
  await post('/profiles', { party: TAG + '甲', phone: '13800001111', contact: TAG + '联系人', addr: TAG + '地址' })
  await post('/credit-limits', { party: TAG + '甲', limit_amount: 5000 })
  await post('/fixed-expenses', { name: TAG + '房租', amount: 6000, category: '房租', day: 5 })

  // ── 2. 备份 ─────────────────────────────────────────────────
  const bak = await post('/cloud-backup', { note: TAG })
  eq('备份成功', bak.s, 200)
  const bid = num0((bak.d && (bak.d.id || (bak.d.backup && bak.d.backup.id))) || 0)
  yes('拿到备份 id', bid > 0, bak.d)
  const got = await get('/backup-get?id=' + bid)
  // /backup-get 回的是 {text: '<JSON 字符串>'}（分片存储时也是拼好的整串）
  let pkg = {}
  try { pkg = JSON.parse((got.d && got.d.text) || '{}') } catch (e) { pkg = {} }
  yes('备份内容能取回', !!(pkg.orders || pkg.payables || pkg.ledger), Object.keys(pkg).slice(0, 6))
  const exA = await get('/export-all')
  const A = (exA.d && exA.d.tables) || {}
  yes('恢复前的账里有足够多的表能比', Object.keys(A).length > 30, Object.keys(A).length)

  // ── 3. 一键初始化（清空）再恢复 ──────────────────────────────
  const rs = await post('/book-reset', { confirm: '清空' })
  eq('一键初始化', rs.s, 200)
  const afterReset = await get('/export-all')
  const R = (afterReset.d && afterReset.d.tables) || {}
  near('清空后应收单归零', (R.orders || []).length, 0)
  // 一键初始化以前会把旧备份全删掉（只留它自己做的快照），于是「先备份 → 初始化 → 想退回去」退不了
  const still = await get('/backup-get?id=' + bid)
  eq('一键初始化没把之前的备份删掉', still.s, 200)

  // 不带 confirm 必须先回 409，让人看清「要覆盖多少」
  const nc = await post('/backup-restore', { id: bid })
  eq('不带确认要先问一遍', nc.s, 409)
  yes('问的时候给出会覆盖多少', !!(nc.d && nc.d.need_confirm && nc.d.will), nc.d && nc.d.will)
  const rr = await post('/backup-restore', { id: bid, confirm: 1 })
  eq('恢复成功', rr.s, 200)
  yes('恢复返回 ok', !!(rr.d && rr.d.ok), rr.d && rr.d.error)

  const exB = await get('/export-all')
  const B = (exB.d && exB.d.tables) || {}

  // ── 4. 逐表逐行逐列比 ───────────────────────────────────────
  // 只比「备份里真的带了的表」：attachments / audit_log / error_log / staff_users 这些本来就不进备份。
  const tables = Object.keys(pkg).filter((k) => Array.isArray(pkg[k]) && pkg[k].length && k !== 'settings')
  yes('备份里带了很多张表', tables.length >= 10, tables.length)
  let totalBad = 0
  const tableBad = []
  for (const t of tables) {
    const before = pkg[t]
    const after = Array.isArray(B[t]) ? B[t] : []
    const { diffs, badCells } = diffRows(t, before, after)
    if (badCells) { tableBad.push(t + '（' + badCells + ' 处）'); totalBad += badCells }
    if (diffs.length) console.log('    ' + t + ': ' + diffs.join(' | '))
  }
  eq('恢复后每一行的每一列都和备份里一样', totalBad, 0)
  if (totalBad) console.log('    有差异的表：' + tableBad.join('、'))

  // settings：只比备份里带的键（口令 / 封存状态这些故意不覆盖）
  const setBefore = (pkg.settings || []).filter((r) => r && r.key && !['access_key', 'staff_key', 'sign_secret', 'sealed', 'sealed_at', 'sealed_note', 'backup_sig', 'backup_at'].includes(String(r.key)))
  const setAfter = new Map(((B.settings || []).map((r) => [String(r.key), r.value])))
  let setBad = 0
  for (const r of setBefore) if (JSON.stringify(String(r.value)) !== JSON.stringify(String(setAfter.get(String(r.key))))) setBad++
  eq('settings 里的业务键也回来了', setBad, 0)

  // 业务上再验几个最常被漏的列（列名写死，删了会直接报红）
  const o2 = (B.orders || []).find((x) => String(x.id) === String(oid))
  yes('恢复后这张单还在', !!o2, oid)
  if (o2) {
    eq('应收分类还在', o2.ar_cat, '加工费')
    eq('税的口径还在', o2.tax_kind, '不含税')
    near('税率还在', o2.tax_rate, 10)
    eq('交期还在', String(o2.deliver_date || '').slice(0, 10), TODAY)
    eq('工序进度还在', o2.progress, '已排产')
    near('已核销还在', o2.written_off, 50)
    near('成本还在', o2.cost, 1200)
    yes('开单人还在', !!o2.created_by, o2.created_by)
  }
  const l2 = (B.ledger || []).find((x) => String(x.ref_type) === 'order' && String(x.ref_id) === String(oid))
  yes('恢复后这笔收款还在', !!l2)
  if (l2) {
    eq('票据状态还在', l2.inv_state, 'yes')
    eq('票号还在', l2.inv_no, TAG + 'FP1')
    near('税额还在', l2.tax, 72)
  }
  const p2 = (B.payables || []).find((x) => String(x.id) === String(pid))
  if (p2) { eq('应付分类还在', p2.category, '硫酸'); eq('应付税口径还在', p2.tax_kind, '含税') }
  const pf = (B.party_profiles || []).find((x) => String(x.party) === TAG + '甲')
  if (pf) { eq('客户电话还在', pf.phone, '13800001111'); eq('客户地址还在', pf.addr, TAG + '地址') }
  const pt = (B.party_terms || []).find((x) => String(x.party) === TAG + '甲')
  if (pt) { near('客户账期还在', pt.term_days, 45); near('对账周期还在', pt.recon_cycle, 30); eq('对账日还在', num0(pt.recon_day), 5) } else no('客户账期那条还在')
  const d2 = (B.debts || []).find((x) => String(x.id) === String(did))
  if (d2) { near('借款本金还在', d2.principal, 30000); near('借款利率还在', d2.rate, 4.5) }
  const a2 = (B.assets || []).find((x) => String(x.name) === TAG + '设备')
  if (a2) { near('资产年限还在', a2.life_years, 5); near('资产残值率还在', a2.residual_rate, 5) }
  const pp = (B.prepaids || []).find((x) => String(x.name) === TAG + '租金')
  if (pp) near('待摊期数还在', pp.months, 6)

  // ── 5. 恢复之后账还是活的（不是只把数据塞回去） ──────────────
  const exC = await get('/export-all')
  const newBase = num0((exC.d && exC.d.counts && exC.d.counts.orders) || 0)
  near('恢复后单数 = 恢复前的单数', newBase, baseOrders + 1)
  const sum = await get('/ar-summary')
  yes('恢复后应收汇总还能算（接口没崩）', !!(sum.d && sum.d.type === 'ar' && sum.d.open_count >= 1), sum.d && sum.d.error)
  near('恢复后应收汇总的金额 = 原来那些 + 这张单剩下的', num0(sum.d && sum.d.open_amount) - baseOpen, 2000 - 800 - 50)
  const chk = await get('/selfcheck')
  yes('恢复后自检没报「单据已核销 X，核销记录合计 0」这类不一致', !!(chk.d && chk.d.ok), (chk.d && chk.d.items || []).filter((x) => x.bad).map((x) => x.title))
  const mk = await get('/month-report?month=' + MONTH)
  yes('恢复后月报还能出', !!(mk.d && mk.d.month === MONTH), mk.d && mk.d.error)
  near('恢复后月报里的「本月开单」增量 = 这张单', num0(mk.d && mk.d.order_add) - baseAdd, 2000)

  console.log('')
  if (bad.length) {
    console.log('❌ 备份 / 恢复逐列回归 ' + bad.length + ' 项失败：')
    for (const b of bad) console.log('   · ' + b)
    process.exit(1)
  }
  console.log('✅ 备份 / 恢复逐列回归 ' + pass + ' 项全部通过')
}

main().catch((e) => { console.error(e); process.exit(1) })
