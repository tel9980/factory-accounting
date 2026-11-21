#!/usr/bin/env node
// 写接口冒烟：把「记账 / 收付款 / 台账 / 报表」这些真正会改数据的接口挨个打一遍。
//
// 为什么需要它：原来的 smoke.mjs 只打 GET，通过标准也只是「不是 5xx」。
// 全项目 175 个写接口在 CI 里一个都没跑过 —— 一个字段写错、一个少 bind 的参数，
// 要等真人在手机上点那一下才炸。这个脚本就是为了在合并前炸出来。
//
// 用法（CI 里对新库跑）：
//   node scripts/smoke-write.mjs --base http://127.0.0.1:8791 --key 8888
//
// 两段：
//   一、主流程：按真实业务顺序造数据（开单 → 收款 → 核销 → 应付 → 付款 → 各类台账），
//       每一步都断言「不是 4xx/5xx」，并把新建的单据 id 传给后面几步。
//   二、扫尾：把剩下的写路由用空 body 打一遍，只报 5xx（400「参数不对」是正常反应，
//       500 才是代码崩了）。危险路由（删库、恢复备份、结账、封存、改口令）不碰。
//
// 注意：会真的写数据。只对「新建的空库」或本地开发库跑，别对着生产库跑。

import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const BASE = argOf('base', 'http://127.0.0.1:8791').replace(/\/+$/, '')
const KEY = argOf('key', '8888')
const TIMEOUT = Number(argOf('timeout', '30000')) || 30000
const VERBOSE = args.includes('--verbose')
const TODAY = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
// 每跑一次换一套名字：这个脚本会反复跑（本地开发时更是），
// 名字固定的话第二次就会被「已经有同名账户了 / 刚记过一张一样的」挡回来。
// 名字里不要出现数字：/quick 会从文本里抓第一个数字当金额，名字带数字就抓错了
const TAG = '冒烟' + Date.now().toString(36).replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]).slice(-4)

const H = { 'X-Access-Key': KEY, 'Content-Type': 'application/json' }

let bad = 0
const fails = []
const ok = (name, extra) => console.log(`  ✅ ${name}${extra ? ' · ' + extra : ''}`)
const no = (name, why) => {
  bad++
  fails.push({ name, why })
  console.log(`  ❌ ${name} · ${why}`)
}

async function call(method, p, body) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT)
  try {
    const res = await fetch(BASE + p, {
      method,
      headers: H,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal
    })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch (e) { data = text.slice(0, 200) }
    return { status: res.status, data }
  } catch (e) {
    return { status: 0, data: { error: String((e && e.message) || e) } }
  } finally {
    clearTimeout(timer)
  }
}

const brief = (d) => {
  const s = typeof d === 'string' ? d : JSON.stringify(d)
  return String(s || '').slice(0, 160)
}
const num0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

// 等服务器起来
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    const r = await call('GET', '/')
    if (r.status && r.status < 500) return true
    await new Promise((s) => setTimeout(s, 1000))
  }
  return false
}

// 设口令（已经有口令时返回 4xx，正常）
async function ensureKey() {
  const r = await call('POST', '/auth/setup', { key: KEY })
  if (VERBOSE) console.log(`  · /auth/setup → ${r.status}`)
  return r
}

// 一步 = 一个写接口调用；expect 默认「< 400」
async function step(name, method, p, body, opts = {}) {
  const r = await call(method, p, body)
  const allow = opts.allow || []
  const good = (r.status > 0 && r.status < 400) || allow.includes(r.status)
  if (!good) {
    no(name, `${method} ${p} → ${r.status} ${brief(r.data)}`)
    return null
  }
  // 成功的也打一行：CI 日志里要能看出「这个接口真的被跑过了」
  ok(name, `${method} ${p} → ${r.status}${VERBOSE ? ' ' + brief(r.data) : ''}`)
  return r.data || {}
}

// ── 一、主流程 ────────────────────────────────────────────────
async function mainFlow() {
  console.log('\n[主流程：从开单到结账前的每一环]')

  // 账户（后面收付款都挂在它上面）
  await step('建现金账户', 'POST', '/accounts', { name: `${TAG}现金`, kind: 'cash', opening: 0 })
  const accs = await call('GET', '/accounts')
  const accRows = (accs.data && (accs.data.accounts || accs.data.rows || accs.data)) || []
  const accId = (Array.isArray(accRows) && accRows[0] && accRows[0].id) || 1

  // 分类 + 预算
  await step('建支出分类', 'POST', '/categories', { name: TAG + '分类', kind: 'expense' })
  await step('设分类预算', 'POST', '/budgets', { category: TAG + '分类', amount: 5000 })

  // 应收：开单 → 收款 → 核销
  await step('开一张应收单', 'POST', '/orders', {
    customer: TAG + '客户', item_name: '测试件', price: 1000, qty: 1, date: TODAY
  })
  const ar = await call('GET', '/ar?status=all&kw=' + encodeURIComponent(TAG + '客户') + '&limit=5')
  const arList = Array.isArray(ar.data) ? ar.data : (ar.data && ar.data.rows) || []
  const orderId = arList[0] && arList[0].id
  if (!orderId) no('开单后能查回来', '/ar 里找不到刚开的单')
  else ok('开单后能查回来', `id=${orderId}`)

  if (orderId) {
    await step('改单（补成本）', 'PATCH', `/orders/${orderId}`, { cost: 600 })
    await step('记一笔收款', 'POST', `/orders/${orderId}/receive`, { amount: 400, account_id: accId, date: TODAY })
    await step('更新生产进度', 'PATCH', `/orders/${orderId}/progress`, { step: '开料', qty: 1 })
    await step('改状态', 'POST', `/orders/${orderId}/status`, { status: 1 })
    await step('核销一部分', 'POST', `/orders/${orderId}/writeoff`, { amount: 100, reason: '冒烟核销' })
    await step('报价单转单前先建报价', 'POST', '/quotes', { party: TAG + '客户', item: '测试件', qty: 1, cost: 600, price: 1000 })
    const qs = await call('GET', '/quotes')
    const qList = (qs.data && (qs.data.rows || qs.data)) || []
    const qid = qList[0] && qList[0].id
    if (qid) {
      await step('报价发送留痕', 'POST', `/quotes/${qid}/send`, { channel: 'wechat' })
      await step('报价转成订单', 'POST', `/quotes/${qid}/to-order`, {})
    }
  }

  // 预收 → 抵扣
  await step('记客户预收', 'POST', '/advances', {
    type: 'in', party: TAG + '客户', amount: 300, account_id: accId, date: TODAY, remark: '冒烟预收'
  })
  const advs = await call('GET', '/advances?type=in')
  const advList = (advs.data && (advs.data.rows || advs.data)) || []
  const advId = advList[0] && advList[0].id
  if (advId && orderId) await step('预收抵扣到订单', 'POST', `/orders/${orderId}/apply-advance`, { advance_id: advId, amount: 100 })

  // 实报实销（老板要的口径）：实际收付跟当初记的不一样，按实际记
  //   · 多收/多付 → 多出来的记预收/预付
  //   · 少收/少付 + settle → 差额记尾差核销，单子算结清（不进现金流）
  await step('开一张应收单（实收有出入）', 'POST', '/orders', {
    customer: TAG + '实收客户', item_name: '实收件', price: 1000, qty: 1, date: TODAY
  })
  const ar2 = await call('GET', '/ar?status=all&kw=' + encodeURIComponent(TAG + '实收客户') + '&limit=5')
  const ar2List = Array.isArray(ar2.data) ? ar2.data : (ar2.data && ar2.data.rows) || []
  const oid2 = ar2List[0] && ar2List[0].id
  if (!oid2) no('实收客户能查回来', '/ar 里找不到刚开的单')
  else {
    const r1 = await step('客户多打钱 1200（单子只 1000）', 'POST', `/orders/${oid2}/receive`, { amount: 1200, account_id: accId, date: TODAY })
    if (r1 && Math.abs(num0(r1.over) - 200) < 0.01) ok('多收的 200 记成预收', 'over=200')
    else no('多收的 200 记成预收', r1 ? JSON.stringify(r1) : '接口失败')
    await step('开第二张应收单（要抹零）', 'POST', '/orders', {
      customer: TAG + '抹零客户', item_name: '抹零件', price: 1000, qty: 1, date: TODAY
    })
    const ar3 = await call('GET', '/ar?status=all&kw=' + encodeURIComponent(TAG + '抹零客户') + '&limit=5')
    const ar3List = Array.isArray(ar3.data) ? ar3.data : (ar3.data && ar3.data.rows) || []
    const oid3 = ar3List[0] && ar3List[0].id
    if (oid3) {
      await step('先收 900', 'POST', `/orders/${oid3}/receive`, { amount: 900, account_id: accId, date: TODAY })
      const r2 = await step('剩下 100 差额抹零结清', 'POST', `/orders/${oid3}/receive`, { amount: 0, settle: true, account_id: accId, date: TODAY })
      if (r2 && Math.abs(num0(r2.settled) - 100) < 0.01) ok('差额 100 记了核销', 'settled=100')
      else no('差额 100 记了核销', r2 ? JSON.stringify(r2) : '接口失败')
      const ar4 = await call('GET', '/ar?status=open&kw=' + encodeURIComponent(TAG + '抹零客户') + '&limit=5')
      const left = (Array.isArray(ar4.data) ? ar4.data : (ar4.data && ar4.data.rows) || []).length
      left === 0 ? ok('抹零后不再挂在未结清里') : no('抹零后不再挂在未结清里', `还剩 ${left} 张`)
    } else no('抹零客户能查回来', '/ar 里找不到刚开的单')
  }

  // 应付：进货 → 付款 → 核销
  await step('开一张应付单', 'POST', '/payables', {
    supplier: TAG + '供应商', item_name: '原材料', amount: 800, date: TODAY
  })
  const ap = await call('GET', '/ap?status=all&kw=' + encodeURIComponent(TAG + '供应商') + '&limit=5')
  const apList = Array.isArray(ap.data) ? ap.data : (ap.data && ap.data.rows) || []
  const payId = apList[0] && apList[0].id
  if (payId) {
    await step('付一笔款', 'POST', `/payables/${payId}/pay`, { amount: 300, account_id: accId, date: TODAY })
    await step('应付核销', 'POST', `/payables/${payId}/writeoff`, { amount: 50, reason: '冒烟核销' })
  } else no('应付单能查回来', '/ap 里找不到刚开的单')

  // 应付也按实际：多付记预付、少付抹零结清
  await step('开一张应付单（实付有出入）', 'POST', '/payables', {
    supplier: TAG + '实付供应商', item_name: '实付款', amount: 600, date: TODAY
  })
  const ap2 = await call('GET', '/ap?status=all&kw=' + encodeURIComponent(TAG + '实付供应商') + '&limit=5')
  const ap2List = Array.isArray(ap2.data) ? ap2.data : (ap2.data && ap2.data.rows) || []
  const payId2 = ap2List[0] && ap2List[0].id
  if (payId2) {
    const p1 = await step('多付 700（单子只 600）', 'POST', `/payables/${payId2}/pay`, { amount: 700, account_id: accId, date: TODAY })
    if (p1 && Math.abs(num0(p1.over) - 100) < 0.01) ok('多付的 100 记成预付', 'over=100')
    else no('多付的 100 记成预付', p1 ? JSON.stringify(p1) : '接口失败')
  } else no('实付供应商能查回来', '/ap 里找不到刚开的单')
  await step('开第二张应付单（要抹零）', 'POST', '/payables', {
    supplier: TAG + '抹零供应商', item_name: '抹零款', amount: 600, date: TODAY
  })
  const ap3 = await call('GET', '/ap?status=all&kw=' + encodeURIComponent(TAG + '抹零供应商') + '&limit=5')
  const ap3List = Array.isArray(ap3.data) ? ap3.data : (ap3.data && ap3.data.rows) || []
  const payId3 = ap3List[0] && ap3List[0].id
  if (payId3) {
    await step('先付 500', 'POST', `/payables/${payId3}/pay`, { amount: 500, account_id: accId, date: TODAY })
    const p2 = await step('剩下 100 差额抹零结清', 'POST', `/payables/${payId3}/pay`, { amount: 0, settle: true, account_id: accId, date: TODAY })
    if (p2 && Math.abs(num0(p2.settled) - 100) < 0.01) ok('应付差额 100 记了核销', 'settled=100')
    else no('应付差额 100 记了核销', p2 ? JSON.stringify(p2) : '接口失败')
  } else no('抹零供应商能查回来', '/ap 里找不到刚开的单')

  // 材料台账：入库 → 出库（出库有库存校验，先入后出）
  await step('建材料', 'POST', '/materials', { name: TAG + '钢板', unit: '张', min_qty: 1 })
  await step('材料入库', 'POST', '/material-moves', { material: TAG + '钢板', kind: 'in', qty: 10, price: 30, date: TODAY })
  await step('材料出库', 'POST', '/material-moves', { material: TAG + '钢板', kind: 'out', qty: 2, date: TODAY })

  // 计件工资：单价 → 记录 → 发工资
  await step('设计件单价', 'POST', '/wage-rates', { worker: TAG + '工人', item: '测试件', process: '车', rate: 5, unit: '件' })
  await step('记计件', 'POST', '/wage-records', { rows: [{ worker: TAG + '工人', item: '测试件', process: '车', qty: 10, date: TODAY }] })
  await step('发工资', 'POST', '/payroll/pay', { month: TODAY.slice(0, 7), workers: [TAG + '工人'], account_id: accId })

  // 其它台账
  await step('固定支出', 'POST', '/fixed', { amount: 200, category: TAG + '房租', day: 5, remark: '冒烟' })
  await step('记一笔支出', 'POST', '/expenses', { amount: 66, category: TAG + '分类', remark: '冒烟', account_id: accId, date: TODAY })
  // 「工资按实发数入账」这条路：不开计件工资时，工资就是一笔分类=工资的支出。
  // 这条必须能记上、且分类不被改写（净利/现金流都靠它）。
  // 金额带 TAG 后缀：同一天连跑两遍时不会撞上「今天已经记过一笔」的防重（409 dup）
  await step('发工资（按实发数记支出）', 'POST', '/expenses', { amount: 3000, category: '工资', remark: `${TODAY.slice(0, 7)} 工资（实发）${TAG}`, account_id: accId, date: TODAY, confirm_dup: true, client_id: `smoke-wage-${TAG}-${Date.now()}` })
  const exW = await call('GET', '/expenses?kw=' + encodeURIComponent('工资（实发）'))
  const exWrows = Array.isArray(exW.data) ? exW.data : ((exW.data && exW.data.rows) || [])
  const wageRow = exWrows.find((x) => String(x.category || '') === '工资' && num0(x.amount) === 3000)
  if (wageRow) ok('工资按实发数入账', `id=${wageRow.id} 分类=${wageRow.category} 金额=${wageRow.amount}`)
  else no('工资按实发数入账', '记了 3000 的工资支出，/expenses 里找不到')
  await step('借款', 'POST', '/debts', { lender: TAG + '银行', kind: 'bank', principal: 10000, rate: 4.5, start_date: TODAY, term_months: 12, pay_kind: 'interest' })
  const dbs = await call('GET', '/debts')
  const dbList = (dbs.data && (dbs.data.rows || dbs.data)) || []
  const debtId = dbList[0] && dbList[0].id
  if (debtId) await step('还一笔借款', 'POST', `/debts/${debtId}/repay`, { amount: 1000, rdate: TODAY, kind: 'principal' })

  await step('员工借支', 'POST', '/loans', { staff: TAG + '工人', amount: 100, account_id: accId, date: TODAY, remark: '冒烟借支' })
  await step('建第二个账户', 'POST', '/accounts', { name: TAG + '银行', kind: 'bank', opening: 1000 })
  const accs2 = await call('GET', '/accounts')
  const accList2 = (accs2.data && (accs2.data.accounts || accs2.data.rows || accs2.data)) || []
  const acc2 = (Array.isArray(accList2) ? accList2.find((x) => x.name === TAG + '银行') : null || {}).id
  if (acc2) await step('账户间转账', 'POST', '/transfers', { from: accId, to: acc2, amount: 10, date: TODAY, remark: '冒烟' })
  else no('账户间转账', '没查到刚建的第二个账户')
  await step('固定资产', 'POST', '/assets', { name: TAG + '机床', cost: 3000, buy_date: TODAY, life_years: 5, residual_rate: 5 })
  await step('预付款摊销', 'POST', '/prepaids', { name: TAG + '保险', total: 1200, months: 12, category: '保险', account_id: accId, start_date: TODAY })
  await step('返工损失', 'POST', '/rework', { kind: 'rework', date: TODAY, cost: 20, party: TAG + '客户' })
  await step('外协', 'POST', '/outsource', { party: TAG + '外协', price: 300, sent_date: TODAY, due_date: TODAY })
  await step('框架价', 'POST', '/frame-prices', { party: TAG + '客户', price: 980, item: '测试件', unit: '件', start_date: TODAY })
  await step('开票登记', 'POST', '/invoices', { type: 'out', no: TAG + '-1', party: TAG + '客户', amount: 1000, tax: 130, date: TODAY })
  await step('月度目标', 'POST', '/target', { month: TODAY.slice(0, 7), receive: 5000, order_add: 8000 })
  await step('账期设置', 'POST', '/party-terms', { party: TAG + '客户', kind: 'ar', term_days: 30, recon_cycle: 'month' })
  await step('信用额度', 'POST', '/credit-limits', { party: TAG + '客户', limit_amount: 5000, note: '冒烟' })
  await step('催款记录', 'POST', '/dunning-log', { party: TAG + '客户', type: 'ar', promise_date: TODAY, channel: 'wechat', note: '冒烟' })
  await step('对账单登记', 'POST', '/statement-log', { party: TAG + '客户', type: 'ar', month: TODAY.slice(0, 7), force: 1 })
  await step('对账结论确认', 'POST', '/recon-confirm', { party: TAG + '客户', type: 'ar', month: TODAY.slice(0, 7) }, { allow: [400] })
  await step('一句话记账', 'POST', '/quick', { text: '收' + TAG + '客户加工费800' })
  await step('粘贴预览', 'POST', '/parse-import', { type: 'ar', text: TAG + '客户,500,' + TODAY }, { allow: [400] })
  await step('粘贴导入', 'POST', '/import-rows', { type: 'ar', text: TAG + '客户,500,' + TODAY, date: TODAY }, { allow: [400] })
  await step('生成月报包', 'POST', '/month-pack-run', { month: TODAY.slice(0, 7) }, { allow: [400, 409] })
  await step('净值快照', 'POST', '/networth-snapshot', {}, { allow: [409] })
  await step('预提/摊销/折旧', 'POST', '/run-accrual', { month: TODAY.slice(0, 7) }, { allow: [400, 409] })
  // 云端备份要连外部笔记站，CI 里没配，500 是预期的（失败会写 error_log，不影响别的接口）
  await step('云端备份', 'POST', '/cloud-backup', {}, { allow: [400, 500] })
  await step('清理回收站', 'POST', '/db-clean', { days: 30 })

  // 删除类接口：造一条自己的记录再删，不碰已有数据
  await step('建临时材料', 'POST', '/materials', { name: TAG + '临时料', unit: '个', min_qty: 0 })
  const ms = await call('GET', '/materials')
  const mList = (ms.data && (ms.data.rows || ms.data.materials || ms.data)) || []
  const tmpMat = (Array.isArray(mList) ? mList : []).find((x) => x.name === TAG + '临时料')
  if (tmpMat && tmpMat.id) await step('删临时材料', 'DELETE', `/materials/${tmpMat.id}`)
  else if (tmpMat) no('删临时材料', '/materials 的行里没有 id')
  else no('删临时材料', '/materials 里找不到刚建的那条')
}

// ── 二、扫尾：剩下的写路由用空 body 打一遍，只报 5xx ─────────────
const SKIP = new Set([
  // 会删数据 / 改结构 / 动口令 / 触发外部同步：本地或 CI 都不该被冒烟乱碰
  '/batch', '/restore', '/backup-restore', '/backup-to-notes', '/cloud-backup',
  '/db-clean', '/import-undo', '/migrate-apply', '/book-template/apply', '/party-merge',
  '/auth/setup', '/auth/change', '/auth/recover', '/auth/recover-code', '/auth/staff', '/auth/staff-off',
  '/seal', '/unseal', '/month-close', '/year-close', '/year-open', '/month-lock',
  '/staff-users', '/staff-perms', '/wx-login', '/wx-config', '/wx-test', '/wx-subscribed',
  '/error-log', '/slow-log', '/attachments', '/import-xlsx', '/import-all', '/import', '/detect-import',
  '/quote-ack', '/statement-ack', '/trash/:id', '/trash/:id/restore'
])

function writeRoutes() {
  const src = fs.readFileSync(path.join(process.cwd(), 'backend/index.js'), 'utf8')
  const re = /\bapp\.(post|patch|delete|put)\(\s*'([^']+)'/g
  const out = []
  let m
  while ((m = re.exec(src))) out.push({ method: m[1].toUpperCase(), path: m[2] })
  return out
}

async function sweep() {
  console.log('\n[扫尾：其余写路由用空 body，只看会不会 500]')
  const routes = writeRoutes().filter((r) => !SKIP.has(r.path))
    // DELETE / PATCH 不能用空 body 打 :id=1 —— 那是真数据（第一版扫尾就把刚入的
    // 材料进货单删掉了，后面的出库校验才发现库存对不上）。删除类在 mainFlow 里
    // 用「自己建一条再删」的方式单独验。
    .filter((r) => r.method !== 'DELETE' && r.method !== 'PATCH')
  let n = 0
  let five = 0
  for (const r of routes) {
    const p = r.path.replace(/:[a-zA-Z]+/g, '1')
    const res = await call(r.method, p, r.method === 'DELETE' ? undefined : {})
    n++
    if (res.status === 0 || res.status >= 500) {
      five++
      no(`空 body ${r.method} ${r.path}`, `→ ${res.status} ${brief(res.data)}`)
    }
  }
  if (!five) ok(`${n} 个写路由空 body 打过去，没有一个 5xx`)
}

// ── 账本自检：跑完这一轮写入后，「单据 vs 流水 vs 核销记录」必须还对得上 ──
// 这是最值钱的一条断言：上面每一步都返回 200，但账可能是错的（比如收款只改了单据
// 没进流水、核销只写了一张表）。/selfcheck 会把 10 类不一致数出来，这里要求它为 0。
async function consistency() {
  console.log('\n[账本自检：单据 / 流水 / 核销记录 / 库存 对不对得上]')
  const res = await call('GET', '/selfcheck')
  if (res.status !== 200 || !res.data) return no('账本自检', `→ ${res.status} ${brief(res.data)}`)
  const d = res.data
  const items = [
    ['应收单已收 vs 收款流水', d.mismatch],
    ['应付单已付 vs 付款流水', d.ap_mismatch],
    ['收款超过单据金额', d.overpaid],
    ['应收核销 vs 核销记录', d.wo_mismatch],
    ['应付核销 vs 核销记录', d.wo_mismatch_ap],
    ['流水挂的单据已不存在', d.orphan_ledger],
    ['材料库存算出负数', d.stock_negative],
    ['预收/预付抵超了', d.advance_over],
    ['流水挂的账户已删除', d.account_orphan],
    ['单据没记上月份', d.month_null]
  ]
  // 以前只判 `Number(v) > 0`：后端把某个键改名之后 v 是 undefined，这条就永远漏检，
  // 自检看起来「10 类全是 0」其实只查了 7 类。现在先要求每个键都真的在返回里。
  const missing = items.filter(([k, v]) => v === undefined || v === null || !Number.isFinite(Number(v))).map(([k]) => k)
  if (missing.length) no('账本自检返回的字段缺了', missing.join('、'))
  const broke = items.filter(([, v]) => Number(v) > 0)
  if (broke.length) {
    no('账本自检', broke.map(([k, v]) => `${k} ${v} 处`).join('；') + (d.issues && d.issues.length ? `\n     ${d.issues.slice(0, 6).join('\n     ')}` : ''))
  } else {
    ok(`${d.orders} 张应收 / ${d.payables} 张应付，10 类一致性检查全部为 0`)
  }
}

// ── 定时任务：把「每天 0 点那条 cron」手动跑一遍 ──
// 以前 scheduled() 在 CI 里一次都没跑过（备份没生成、摊销没入账都只能等真出事才发现）。
async function runCron() {
  console.log('\n[定时任务：自动记账 + 自检]')
  const res = await call('POST', '/run-cron', {})
  if (res.status !== 200 || !res.data) return no('手动跑定时任务', `→ ${res.status} ${brief(res.data)}`)
  const d = res.data
  const errs = Object.keys(d).filter((k) => k.endsWith('_err'))
  if (errs.length) return no('手动跑定时任务', errs.map((k) => `${k}: ${d[k]}`).join('；'))
  ok(`自动记账（固定支出/摊销/预提/折旧）跑通，自检 ${d.selfcheck ? d.selfcheck.bad : 0} 处问题`)
}

// ── 备份 / 恢复闭环 ───────────────────────────────────────────
// 以前这几个接口在 CI 里零覆盖：备份写不进去（D1 单行 2MB）、恢复把表清空、
// 恢复一半失败没有回滚 —— 全是「真出事那天才发现」的类型。
// 这里做一次「备份 → 校验 → 取回 → 恢复到刚备的那份」，恢复到同一刻所以数据不变。
async function backupRoundTrip() {
  console.log('\n[备份 / 恢复闭环]')
  const bk = await step('备份一份', 'POST', '/cloud-backup', {})
  if (!bk || bk.error) return no('备份一份', brief(bk))
  const id = bk.id || (bk.backup && bk.backup.id)
  if (!id) return no('备份一份', '没回备份 id：' + brief(bk))
  const ver = await call('GET', '/backup-verify')
  if (ver.status !== 200 || !ver.data || ver.data.ok === false) return no('校验备份', `→ ${ver.status} ${brief(ver.data)}`)
  ok('校验备份：' + String(ver.data.text || '').slice(0, 40))
  const got = await call('GET', '/backup-get?id=' + id)
  if (got.status !== 200 || !got.data || !got.data.text) return no('取回备份', `→ ${got.status} ${brief(got.data)}`)
  let parsed = null
  try { parsed = JSON.parse(got.data.text) } catch (e) { return no('取回备份', '取回来的不是合法 JSON') }
  if (!parsed || !parsed.version) return no('取回备份', '备份里没有 version')
  ok(`取回备份：${(got.data.text.length / 1024).toFixed(0)} KB，${Object.keys(parsed).length} 个键`)
  // 不带 confirm 必须拒绝（否则误点一下就把账换成旧的了）
  const noConf = await call('POST', '/backup-restore', { id })
  if (noConf.status !== 409 || !noConf.data || !noConf.data.need_confirm) return no('恢复必须二次确认', `→ ${noConf.status} ${brief(noConf.data)}`)
  ok('恢复必须二次确认：不带 confirm 回 409 need_confirm')
  const done = await step('恢复到刚备的那份', 'POST', '/backup-restore', { id, confirm: 1 })
  if (done && done.error) return no('恢复到刚备的那份', brief(done))
}

// ── 跑 ───────────────────────────────────────────────────────
if (!(await waitReady())) {
  console.log(`❌ 服务器没起来：${BASE}`)
  process.exit(1)
}
await ensureKey()
// 模块开关：计件工资默认是关着的（工资一般按实发数记支出就够了），
// 但这个脚本要把所有写接口都跑一遍 —— 先全打开，否则工资那几步会被 403 挡回来。
await step('打开全部模块（冒烟要跑全部接口）', 'POST', '/modules', { off: [] })
try {
  await mainFlow()
  await sweep()
  await runCron()
  await consistency()
  await backupRoundTrip()
  // 收尾把模块开关恢复出厂（计件工资默认关着），别把「全部打开」留给后面的脚本
  await step('恢复模块开关默认', 'POST', '/modules', { reset: true })
} catch (e) {
  no('脚本自身', String((e && e.stack) || e))
}

console.log('')
if (bad) {
  console.log(`❌ 写接口冒烟失败：${bad} 项`)
  for (const f of fails.slice(0, 20)) console.log(`   · ${f.name}：${f.why}`)
  process.exit(1)
}
console.log('✅ 写接口冒烟通过：主流程全通，其余写路由无 5xx')
