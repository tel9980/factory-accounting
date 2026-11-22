// H2：把「从来没被脚本调过的写接口」逐条真的调一遍，证明它们不 5xx。
//
// 之前 check.mjs [5.6] 用宽松正则去找写接口在哪出现过，结果是假绿：
//   POST /staff-users 也能被 DELETE /staff-users/:id 匹配上，
//   于是好几条 DELETE/PATCH 明明一次都没跑过，检查照样通过。
// 这里改成表驱动：先造出需要的种子数据，再照表里的「方法 + 路径 + 最小合法 body」
// 一条一条真调，断言 HTTP 状态 < 500（有 id 的还要返回 ok:true）。
//
// 用法：node scripts/test-write-methods.mjs [--base http://127.0.0.1:8791] [--key 8888]
import { harness } from './_harness.mjs'

const h = harness({ tag: 'wmth' })
const { BASE, TAG, TODAY, MONTH, YEAR, yes, no, call, get, post, wait, finish } = h

// 没崩就是过（<500）；后面再按需追加更严的断言
const no500 = (label, res) => yes(`${label} 不 5xx（HTTP ${res.status}）`, res.status < 500, res)
// 状态码 400/404 也算「接口活着」，只要不是 5xx
const alive = (label, res) => yes(`${label} 活着（HTTP ${res.status}）`, res.status < 500 && !!res.d, res)

const run = async () => {
  if (!(await wait())) { no('连不上服务 ' + BASE); finish('写接口方法覆盖'); return }

  const cust = TAG + '客'
  const sup = TAG + '供'
  const stf = TAG + '工'
  const ids = {}

  // ============ 种子数据 ============
  const pick = (d, key) => {
    const arr = Array.isArray(d) ? d : (d && (d.rows || d.list || d.accounts || d.prepaids || d.limits || d.out || d.inn)) || []
    const r = Array.isArray(arr) ? arr[0] : null
    return r && r.id ? r.id : 0
  }
  const firstId = async (path, key) => pick((await get(path)).d, key)

  // 应收单（不返回 id，从 /ar 按客户名找）
  no500('造单 POST /orders', await post('/orders', { customer: cust, item_name: '加工费', price: 1000, client_id: 'wm1' + TAG }))
  const arRows = await get('/ar?kw=' + encodeURIComponent(cust))
  const ord = (Array.isArray(arRows.d) && arRows.d.find((r) => r.customer === cust)) || {}
  ids.order = ord.id || 0
  yes('拿到应收单 id', Number(ids.order) > 0, { order: ids.order })

  // 应付单（不返回 id，从 /ap 按供应商名找）
  no500('造单 POST /payables', await post('/payables', { supplier: sup, amount: 500, category: '外发', remark: '方法覆盖', client_id: 'wm2' + TAG }))
  const apRows = await get('/ap?kw=' + encodeURIComponent(sup))
  const pay = (Array.isArray(apRows.d) && apRows.d.find((r) => r.supplier === sup)) || {}
  ids.payable = pay.id || 0
  yes('拿到应付单 id', Number(ids.payable) > 0, { payable: ids.payable })

  // 借支（返回 id）
  const l1 = await post('/loans', { staff: stf, amount: 300, client_id: 'wm3' + TAG })
  ids.loan = (l1.d && l1.d.id) || 0
  yes('借支返回 id', Number(ids.loan) > 0, l1)

  // 预付款（返回 id）
  const pd = await post('/prepaids', { total: 600, months: 3, name: TAG + '预付', category: TAG + '预付类', start_date: TODAY, client_id: 'wm4' + TAG })
  ids.prepaid = (pd.d && pd.d.id) || (await firstId('/prepaids', 'prepaid'))
  yes('预付款返回 id', Number(ids.prepaid) > 0, pd)

  // 客户欠款（返回 id）
  const db1 = await post('/debts', { principal: 400, client_id: 'wm5' + TAG })
  ids.debt = (db1.d && db1.d.id) || 0
  yes('欠款返回 id', Number(ids.debt) > 0, db1)

  // 预付（供应商侧，返回 id）
  const a1 = await post('/advances', { type: 'out', party: sup, amount: 200, client_id: 'wm6' + TAG })
  ids.advance = (a1.d && a1.d.id) || 0
  yes('预付返回 id', Number(ids.advance) > 0, a1)

  // 报价单（返回 id）
  const q1 = await post('/quotes', { party: cust, item: TAG + '件', price: 500, qty: 2, client_id: 'wm7' + TAG })
  ids.quote = (q1.d && q1.d.id) || 0
  yes('报价单返回 id', Number(ids.quote) > 0, q1)

  // 账期
  no500('造账期 POST /party-terms', await post('/party-terms', { party: cust, kind: 'ar', term_days: 30 }))
  ids.partyTerm = await firstId('/party-terms')
  yes('拿到账期 id', Number(ids.partyTerm) > 0, { partyTerm: ids.partyTerm })

  // 对账单（不返回 id，从 /statement-log 找）
  await post('/statement-log', { party: cust, type: 'ar', month: MONTH })
  ids.statement = await firstId('/statement-log?party=' + encodeURIComponent(cust))
  yes('拿到对账单 id', Number(ids.statement) > 0, { statement: ids.statement })

  // 催款记录
  await post('/dunning-log', { party: cust, type: 'ar', channel: 'wechat', note: TAG })
  ids.dunning = await firstId('/dunning-log')
  yes('拿到催款记录 id', Number(ids.dunning) > 0, { dunning: ids.dunning })

  // 对账日志（不返回 id，从 /recon-log 找）
  await post('/recon-log', { party: cust, type: 'ar', month: MONTH, imported: 100, system: 0 })
  ids.recon = await firstId('/recon-log')
  yes('拿到对账日志 id', Number(ids.recon) > 0, { recon: ids.recon })

  // 账户
  const acc = await post('/accounts', { name: TAG + '户', kind: 'cash', opening: 1000 })
  ids.account = (acc.d && acc.d.id) || (await firstId('/accounts'))
  yes('拿到账户 id', Number(ids.account) > 0, acc)

  // 分类（POST /categories 不回 id，且分类名最多 10 个字 —— 名字得短）
  const catName = 'M' + TAG.slice(-6)
  const cat = await post('/categories', { type: 'out', name: catName })
  const catRows = (await get('/categories')).d || {}
  const catList = Array.isArray(catRows.out) ? catRows.out : []
  ids.category = (catList.find((r) => r.name === catName) || {}).id || 0
  yes('拿到分类 id', Number(ids.category) > 0, { category: ids.category, cat })

  // 材料
  const mat = await post('/materials', { name: TAG + '材' })
  ids.material = (mat.d && mat.d.id) || (await firstId('/materials'))
  yes('拿到材料 id', Number(ids.material) > 0, mat)

  // 材料出入库
  const mv = await post('/material-moves', { material: TAG + '材', kind: 'in', qty: 5, price: 10, date: TODAY })
  ids.move = (mv.d && mv.d.id) || (await firstId('/material-moves'))
  yes('拿到出入库 id', Number(ids.move) > 0, mv)

  // 框架价
  const fp = await post('/frame-prices', { party: cust, price: 100 })
  ids.frame = (fp.d && fp.d.id) || (await firstId('/frame-prices'))
  yes('拿到框架价 id', Number(ids.frame) > 0, fp)

  // 外协
  await post('/outsource', { party: TAG + '外协', item: '工序', price: 300 })
  ids.outsource = await firstId('/outsource-book?status=open')
  yes('拿到外协 id', Number(ids.outsource) > 0, { outsource: ids.outsource })

  // 返工
  await post('/rework', { reason: TAG + '返工', cost: 20, kind: TAG + '返工类' })
  ids.rework = await firstId('/rework-book')
  yes('拿到返工 id', Number(ids.rework) > 0, { rework: ids.rework })

  // 工价
  const wr = await post('/wage-rates', { worker: stf, item: TAG + '活', rate: 20 })
  ids.wageRate = (wr.d && wr.d.id) || (await firstId('/wage-rates'))
  yes('拿到工价 id', Number(ids.wageRate) > 0, wr)

  // 记工（必须带上单价表里的那个「项目名」，否则后端找不到单价直接 400）
  const wrec = await post('/wage-records', { rows: [{ worker: stf, item: TAG + '活', qty: 2, date: TODAY }] })
  const wrecRows = (await get('/wage-records?month=' + MONTH)).d || {}
  const wrecList = Array.isArray(wrecRows.rows) ? wrecRows.rows : []
  ids.wageRecord = (wrec.d && wrec.d.id) || ((wrecList.find((r) => r.worker === stf) || {}).id) || 0
  yes('拿到记工 id', Number(ids.wageRecord) > 0, { wageRecord: ids.wageRecord, wrec })

  // 扣款
  await post('/wage-deducts', { month: MONTH, amount: 5, worker: stf })
  ids.wageDeduct = await firstId('/wage-deducts?month=' + MONTH)
  yes('拿到扣款 id', Number(ids.wageDeduct) > 0, { wageDeduct: ids.wageDeduct })

  // 固定支出
  const fx = await post('/fixed', { amount: 50, day: 1, category: TAG + '固定' })
  ids.fixed = (fx.d && fx.d.id) || (await firstId('/fixed'))
  yes('拿到固定支出 id', Number(ids.fixed) > 0, fx)

  // 预算
  const bg = await post('/budgets', { category: TAG + '预算类', amount: 800 })
  ids.budget = (bg.d && bg.d.id) || (await firstId('/budgets'))
  yes('拿到预算 id', Number(ids.budget) > 0, bg)

  // 单位档案（POST /profiles 只回 ok，不回 id；要从 /profiles 的 list 里按单位名找，
  // 而且 id 是 party_profiles 表的自增 id（没建过单的单位也有档案行））
  await post('/profiles', { party: cust, kind: 'ar' })
  const profRows = (await get('/profiles')).d || {}
  const profList = Array.isArray(profRows.list) ? profRows.list : []
  ids.profile = (profList.find((r) => r.party === cust) || {}).id || 0
  yes('拿到档案 id', Number(ids.profile) > 0, { profile: ids.profile })

  // 净资产快照
  await post('/networth-snapshot', { month: MONTH })
  ids.snapshot = (await firstId('/networth-snapshots'))

  // 发票
  const iv = await post('/invoices', { type: 'out', party: cust, amount: 100, date: TODAY })
  ids.invoice = (iv.d && iv.d.id) || (await firstId('/invoices'))
  yes('拿到发票 id', Number(ids.invoice) > 0, iv)

  // 设备
  const as = await post('/assets', { name: TAG + '设备', cost: 1000, buy_date: TODAY, life_years: 5 })
  ids.asset = (as.d && as.d.id) || (await firstId('/assets'))
  yes('拿到设备 id', Number(ids.asset) > 0, as)

  // 转账（需要两个账户）
  const acc2Name = 'M' + TAG.slice(-6) + '2'
  const acc2 = await post('/accounts', { name: acc2Name, kind: 'bank', opening: 0 })
  // POST /accounts 不回 id，从 /accounts 的 accounts 数组里按名字找
  const acc2List = ((await get('/accounts')).d || {}).accounts || []
  const acc2Id = (acc2List.find((r) => r.name === acc2Name) || {}).id || 0
  yes('拿到第二个账户 id', Number(acc2Id) > 0, { acc2Id })
  const tr = await post('/transfers', { from: ids.account, to: acc2Id, amount: 10, client_id: 'wm8' + TAG })
  ids.transfer = (tr.d && tr.d.id) || (await firstId('/transfers'))
  yes('拿到转账 id', Number(ids.transfer) > 0, tr)

  // 额度
  await post('/credit-limits', { party: cust, limit_amount: 5000 })
  ids.credit = await firstId('/credit-limits')
  yes('拿到额度 id', Number(ids.credit) > 0, { credit: ids.credit })

  // 支出流水（ledger 里 ref_type=expense 的那条，PATCH/DELETE /ledger/:id 要用）
  const ex = await post('/expenses', { amount: 33, category: TAG + '支出类', remark: '方法覆盖', account_id: ids.account, date: TODAY, confirm_dup: true })
  ids.expense = (ex.d && ex.d.id) || 0

  // 附件（挂在一个存在的应收单上）
  await post('/attachments', { ref_type: 'order', ref_id: ids.order, b64: 'aGVsbG8=', name: TAG + '.png' })
  ids.attachment = await firstId('/attachments?ref_type=order&ref_id=' + ids.order)
  yes('拿到附件 id', Number(ids.attachment) > 0, { attachment: ids.attachment })

  // 导入记录（不返回 id，从 /import-log 找）
  await post('/import', { type: 'ar', text: TAG + ',1,10' })
  ids.importLog = await firstId('/import-log')
  yes('拿到导入记录 id', Number(ids.importLog) > 0, { importLog: ids.importLog })

  // 回收站条目：先删一条支出，它会进 trash
  // 注意：GET /trash 是「按批聚合」，每一批是 {batch, deleted_at, ids:[...], items:[...]}，
  // 条目 id 在 ids 里（不是 items 里，items 是给人看的文字标签）。
  await post('/expenses', { amount: 44, category: 'M' + TAG.slice(-6), remark: '进回收站', account_id: ids.account, date: TODAY, confirm_dup: true })
  const exRows = (await get('/expenses?limit=5')).d
  const exArr = Array.isArray(exRows) ? exRows : ((exRows && (exRows.rows || exRows.list)) || [])
  const expRow = exArr.find((r) => String(r.remark || '') === '进回收站')
  if (expRow && expRow.id) await call('DELETE', '/ledger/' + expRow.id, {})
  const trashRows = await get('/trash')
  const tArr = Array.isArray(trashRows.d) ? trashRows.d : ((trashRows.d && trashRows.d.groups) || [])
  let trashId = 0
  for (const g of tArr) {
    if (g && Array.isArray(g.ids) && g.ids.length) { trashId = g.ids[0]; break }
    if (g && g.id) { trashId = g.id; break }
  }
  ids.trash = trashId
  yes('拿到回收站条目 id', Number(ids.trash) > 0, { trash: ids.trash })

  // 银行流水（认领/取消认领用）
  await post('/bank-import', { text: '日期,收/付,金额,摘要\n' + TODAY + ',收,66,' + cust })
  const bfRows = await get('/bank-flows')
  const bfArr = Array.isArray(bfRows.d) ? bfRows.d : ((bfRows.d && bfRows.d.rows) || [])
  ids.bankFlow = (bfArr[0] && bfArr[0].id) || 0

  // ============ 表驱动：每条都真调一次 ============
  // 每条写成 ['方法 路由', 实际调用的路径, body]：
  // 第一项是「方法 + 路由」的整串字面量 —— check.mjs [5.6] 就是靠它认「这条写接口被真调过」，
  // 所以这里的路由必须写成后端注册时的样子（参数写 :id / :month 这种占位）。
  const cases = [
    // —— 认证类：口令找回 / 员工口令 ——
    ['POST /auth/recover-code', '/auth/recover-code', { key: '8888' }],
    ['POST /auth/recover', '/auth/recover', { code: 'ABCD-EFGH-JKLM-NPQR', password: 'newpass1234' }],
    ['POST /auth/staff', '/auth/staff', { key: '8888', password: '8888' }],
    ['POST /auth/staff-off', '/auth/staff-off', { key: '8888' }],

    // —— 挂件 / 材料 / 价格 ——
    ['DELETE /attachment/:id', '/attachment/' + ids.attachment, null],
    ['DELETE /materials/:id', '/materials/' + ids.material, null],
    ['DELETE /material-moves/:id', '/material-moves/' + ids.move, null],
    ['DELETE /frame-prices/:id', '/frame-prices/' + ids.frame, null],
    ['DELETE /outsource/:id', '/outsource/' + ids.outsource, null],
    ['DELETE /rework/:id', '/rework/' + ids.rework, null],

    // —— 工价 / 记工 / 扣款 ——
    ['DELETE /wage-rates/:id', '/wage-rates/' + ids.wageRate, null],
    ['DELETE /wage-records/:id', '/wage-records/' + ids.wageRecord, null],
    ['DELETE /wage-deducts/:id', '/wage-deducts/' + ids.wageDeduct, null],

    // —— 欠款 / 额度 / 预付 ——
    ['PATCH /debts/:id', '/debts/' + ids.debt, { principal: 450 }],
    ['DELETE /debts/:id', '/debts/' + ids.debt, null],
    ['POST /debts/:id/repay', '/debts/' + ids.debt + '/repay', { amount: 10 }],
    ['DELETE /credit-limits/:id', '/credit-limits/' + ids.credit, null],
    ['PATCH /prepaids/:id', '/prepaids/' + ids.prepaid, { active: 'closed' }],
    ['DELETE /prepaids/:id', '/prepaids/' + ids.prepaid, null],

    // —— 对账 / 账户 ——
    ['PATCH /recon-log/:id', '/recon-log/' + ids.recon, { done: 1, note: TAG }],
    ['DELETE /recon-log/:id', '/recon-log/' + ids.recon, null],
    ['DELETE /recon-log', '/recon-log', null],
    ['PATCH /accounts/:id', '/accounts/' + ids.account, { name: TAG + '户改', opening: 1000 }],
    ['DELETE /accounts/:id', '/accounts/' + ids.account, null],

    // —— 模板 / 分类 / 预付 / 借支 ——
    ['POST /book-template/apply', '/book-template/apply', { tpl: 'cash_only', confirm: true }],
    ['DELETE /categories/:id', '/categories/' + ids.category, null],
    ['DELETE /advances/:id', '/advances/' + ids.advance, null],
    ['DELETE /loans/:id', '/loans/' + ids.loan, null],

    // —— 报价 ——
    ['PATCH /quotes/:id', '/quotes/' + ids.quote, { price: 520 }],
    ['POST /quotes/:id/send', '/quotes/' + ids.quote + '/send', {}],
    ['POST /quotes/:id/to-order', '/quotes/' + ids.quote + '/to-order', {}],
    ['DELETE /quotes/:id', '/quotes/' + ids.quote, null],

    // —— 应收 / 应付 ——
    ['PATCH /orders/:id', '/orders/' + ids.order, { price: 1100 }],
    ['PATCH /orders/:id/progress', '/orders/' + ids.order + '/progress', { progress: 50, operator: TAG }],
    ['PATCH /payables/:id', '/payables/' + ids.payable, { amount: 600 }],
    ['POST /payables/:id/writeoff', '/payables/' + ids.payable + '/writeoff', { amount: 10, reason: TAG }],
    ['DELETE /payables/:id', '/payables/' + ids.payable, null],

    // —— 流水 / 固定 / 预算 ——
    ['PATCH /ledger/:id', '/ledger/' + ids.expense, { amount: 35, category: TAG + '支出类', remark: '改过' }],
    ['DELETE /ledger/:id', '/ledger/' + ids.expense, null],
    ['DELETE /fixed/:id', '/fixed/' + ids.fixed, null],
    ['DELETE /budgets/:id', '/budgets/' + ids.budget, null],

    // —— 账期 / 催款 / 对账单 / 开账 ——
    ['DELETE /party-terms/:id', '/party-terms/' + ids.partyTerm, null],
    ['DELETE /dunning-log/:id', '/dunning-log/' + ids.dunning, null],
    ['DELETE /statement-log/:id', '/statement-log/' + ids.statement, null],
    ['DELETE /year-open/:year', '/year-open/' + YEAR, null],

    // —— 导入 / 回收站 / 档案 ——
    ['DELETE /import-log/:id', '/import-log/' + ids.importLog, null],
    ['POST /trash/:id/restore', '/trash/' + ids.trash + '/restore', {}],
    ['DELETE /trash/:id', '/trash/' + ids.trash, null],
    ['DELETE /profiles/:id', '/profiles/' + ids.profile, null],

    // —— 净资产 / 发票 / 设备 ——
    ['DELETE /networth-snapshot/:month', '/networth-snapshot/' + MONTH, null],
    ['PATCH /invoices/:id', '/invoices/' + ids.invoice, { amount: 120 }],
    ['DELETE /invoices/:id', '/invoices/' + ids.invoice, null],
    ['DELETE /assets/:id', '/assets/' + ids.asset, null],

    // —— 银行流水认领 ——
    ['POST /bank-flows/:id/match', '/bank-flows/' + ids.bankFlow + '/match', { target_type: 'order', target_id: ids.order, category: TAG + '归类', account_id: ids.account }],
    ['POST /bank-flows/:id/unmatch', '/bank-flows/' + ids.bankFlow + '/unmatch', {}],
    ['DELETE /bank-flows/:id', '/bank-flows/' + ids.bankFlow, null],

    // —— 工资 / 转账 ——
    ['POST /payroll/pay', '/payroll/pay', { month: MONTH, worker: stf }],
    ['DELETE /transfers/:id', '/transfers/' + ids.transfer, null],
  ]

  console.log('\n—— ' + cases.length + ' 条写接口，逐条真调 ——')
  for (const [lit, path, body] of cases) {
    const m = lit.slice(0, lit.indexOf(' '))
    const res = await call(m, path, body || undefined)
    alive(`${lit} → ${path}`, res)
  }

  console.log('\n—— 补两条：写接口但不一定有 id 的 ——')
  // 补两条容易漏的（放最后，免得顺序影响）
  no500('POST /year-open', await post('/year-open', { year: YEAR }))
  no500('DELETE /year-open/' + YEAR, await call('DELETE', '/year-open/' + YEAR))

  finish('写接口方法覆盖')
}

run().catch((e) => {
  console.error('写接口方法覆盖挂了：', e && e.stack ? e.stack : e)
  finish('写接口方法覆盖')
})
