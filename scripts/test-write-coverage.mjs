// 覆盖 24 个从没被任何脚本调用过的写接口（check.mjs [5.6] 名单）。
// 目标：证明这些真实执行路径不 500、返回结构合理，而不是只做静态命中。
// 每个接口都「先造数据 → 调一次 → 断言」，失败才 exit 1。
import { harness } from './_harness.mjs'

const h = harness({ tag: 'wcov' })
const { BASE, KEY, TAG, TODAY, MONTH, YEAR, ok, no, yes, eq, near, n0, r2, call, get, post, wait, finish } = h

// 第 12 轮 F6：以前 400/404 也算「没崩」（假安心），现在按路由断言精确 200。
// 负例（业务拒绝）单独测，不混在这里。
const assertStatus = (label, res, expected = 200) => yes(`${label}（HTTP ${res.status}，期望 ${expected}）`, res.status === expected && !!res.d, res)
// 写后读：带 TAG 写一条，再 GET 回来断言字段真的落库了（不是只返回 ok 但没写）。
const assertPersisted = async (label, readPath, check) => {
  const rows = (await get(readPath)).d
  const arr = Array.isArray(rows) ? rows : ((rows && (rows.rows || rows.list)) || [])
  const hit = arr.find(check)
  yes(`${label} 写后读回命中`, !!hit, { count: arr.length, sample: (arr[0] || {}) })
}

const run = async () => {
  if (!(await wait())) { no('连不上服务 ' + BASE); finish('写接口覆盖'); return }

  // ============ 种子数据 ============
  const cust = TAG + '客'
  const sup = TAG + '供'
  const stf = TAG + '工'
  const out = TAG + '外协'

  // 1) 应收单（不返回 id，从 /ar 列表按名字找）
  const o1 = await post('/orders', { customer: cust, item_name: '加工费', price: 1000, client_id: 'wc1' + TAG })
  assertStatus('造单 POST /orders', o1)
  const arRows = await get('/ar?kw=' + encodeURIComponent(cust))
  const ord = (Array.isArray(arRows.d) && arRows.d.find((r) => r.customer === cust)) || {}
  const orderId = ord.id || 0
  yes('拿到应收单 id', Number(orderId) > 0, { orderId })

  // 2) 应付单（不返回 id，从 /ap 列表按名字找）
  const p1 = await post('/payables', { supplier: sup, amount: 500, category: '外发', remark: '对账用', client_id: 'wc2' + TAG })
  assertStatus('造单 POST /payables', p1)
  const apRows = await get('/ap?kw=' + encodeURIComponent(sup))
  const pay = (Array.isArray(apRows.d) && apRows.d.find((r) => r.supplier === sup)) || {}
  const payableId = pay.id || 0
  yes('拿到应付单 id', Number(payableId) > 0, { payableId })

  // 3) 借支（返回 id）
  const l1 = await post('/loans', { staff: stf, amount: 300, client_id: 'wc3' + TAG })
  const loanId = (l1.d && l1.d.id) || 0
  yes('借支返回 id', Number(loanId) > 0, l1)

  // 4) 预付款（type=out，给供应商，供 apply-advance 用）
  const a1 = await post('/advances', { type: 'out', party: sup, amount: 200, client_id: 'wc4' + TAG })
  const advId = (a1.d && a1.d.id) || 0
  yes('预付返回 id', Number(advId) > 0, a1)

  // 5) 客户账期
  const pt = await post('/party-terms', { party: cust, kind: 'ar', term_days: 30 })
  assertStatus('造账期 POST /party-terms', pt)

  // 6) 对账单（不返回 id，从 /statement-log 找）
  await post('/statement-log', { party: cust, type: 'ar', month: MONTH })
  const slRows = await get('/statement-log?party=' + encodeURIComponent(cust))
  const slId = (slRows.d && slRows.d.rows && slRows.d.rows[0] && slRows.d.rows[0].id) || 0
  yes('拿到对账单 id', Number(slId) > 0, { slId })

  // 7) 改单申请（POST /edit-request 单数；先造一条 pending）
  const er = await post('/edit-request', { kind: 'ar', id: orderId, changes: { price: 1001 }, reason: '写接口覆盖' })
  assertStatus('提改单 POST /edit-request', er)
  const erRows = await get('/edit-requests?status=pending')
  const erId = (erRows.d && erRows.d.rows && erRows.d.rows[0] && erRows.d.rows[0].id) || 0
  yes('拿到改单申请 id', Number(erId) > 0, { erId })

  // 8) 外协（不返回 id，从 /outsource-book 找）
  await post('/outsource', { party: out, item: '工序', price: 300 })
  const osRows = await get('/outsource-book?status=open')
  const osId = (osRows.d && osRows.d.rows && osRows.d.rows.find((r) => r.party === out) || {}).id || 0
  yes('拿到外协 id', Number(osId) > 0, { osId })

  // 9) 银行流水（导入，给 bank-auto-match 认领用）
  const bankText = '日期,收/付,金额,摘要\n' + TODAY + ',收,600,' + cust
  const bimp = await post('/bank-import', { text: bankText })
  assertStatus('导流水 POST /bank-import', bimp)

  // 10) 给应收单收 500（让 invoice-from-order 有「已收」可开发票）
  const rcv = await post('/orders/' + orderId + '/receive', { amount: 500, date: TODAY, client_id: 'wc5' + TAG })
  assertStatus('收款 POST /orders/:id/receive', rcv)

  // ============ 24 个目标接口 ============
  console.log('\n—— 24 个此前从未被脚本调过的写接口 ——')

  // 1 POST /outsource/:id/back
  const t1 = await post('/outsource/' + osId + '/back', { back_date: TODAY })
  assertStatus('POST /outsource/:id/back', t1)
  yes('  /outsource/:id/back 返回 ok', t1.d && t1.d.ok === true, t1.d)

  // 2 POST /reconcile（预览，不写）
  const t2 = await post('/reconcile', { type: 'ar', text: cust + ' 1000' })
  assertStatus('POST /reconcile', t2)
  yes('  /reconcile 返回 JSON 且非 4xx', t2.status < 400 || (t2.d && (t2.d.ok !== undefined || t2.d.error !== undefined)), t2.d)

  // 3 POST /recon-fix-batch（state=new 新建一家）
  const t3 = await post('/recon-fix-batch', { client_id: 'wc6' + TAG, type: 'ar', month: MONTH, rows: [{ party: TAG + '对账客', imported: 300, system: 0, state: 'new' }] })
  assertStatus('POST /recon-fix-batch', t3)
  yes('  /recon-fix-batch 返回 ok', t3.d && t3.d.ok === true, t3.d)

  // 4 POST /pipeline-summary
  const t4 = await post('/pipeline-summary', { month: MONTH })
  assertStatus('POST /pipeline-summary', t4)
  yes('  /pipeline-summary 返回 ok', t4.d && t4.d.ok === true, t4.d)

  // 5 POST /payables/:id/apply-advance（预付款冲应付）
  const t5 = await post('/payables/' + payableId + '/apply-advance', { amount: 100 })
  assertStatus('POST /payables/:id/apply-advance', t5)
  yes('  /payables/:id/apply-advance 返回 ok', t5.d && t5.d.ok === true, t5.d)

  // 6 POST /loans/:id/reimburse（借支报销）
  const t6 = await post('/loans/' + loanId + '/reimburse', { amount: 150, category: '报销', remark: '写接口覆盖', date: TODAY })
  assertStatus('POST /loans/:id/reimburse', t6)
  yes('  /loans/:id/reimburse 返回 ok', t6.d && t6.d.ok === true, t6.d)

  // 7 POST /book-name
  const t7 = await post('/book-name', { name: '写接口覆盖账' })
  assertStatus('POST /book-name', t7)
  yes('  /book-name 返回 ok', t7.d && t7.d.ok === true, t7.d)
  await post('/book-name', { name: '主账套' }) // 改回去，别脏了账套名

  // 8 POST /onboarding/dismiss
  const t8 = await post('/onboarding/dismiss', {})
  assertStatus('POST /onboarding/dismiss', t8)
  yes('  /onboarding/dismiss 返回 ok', t8.d && t8.d.ok === true, t8.d)

  // 9 POST /pay-batch（批量付款）
  const t9 = await post('/pay-batch', { supplier: sup, amount: 200, date: TODAY, client_id: 'wc7' + TAG })
  assertStatus('POST /pay-batch', t9)
  yes('  /pay-batch 返回 ok', t9.d && t9.d.ok === true, t9.d)

  // 10 POST /phrases
  const t10 = await post('/phrases', { text: '写接口覆盖短语' + TAG, kind: 'ar' })
  assertStatus('POST /phrases', t10)
  yes('  /phrases 返回 ok', t10.d && t10.d.ok === true, t10.d)
  const phId = (t10.d && t10.d.id) || 0
  await assertPersisted('/phrases 写后读', '/phrases?kind=ar', (r) => String(r.text || '').indexOf(TAG) >= 0)

  // 11 DELETE /phrases/:id
  const t11 = await call('DELETE', '/phrases/' + (phId || 1), undefined)
  assertStatus('DELETE /phrases/:id', t11)
  yes('  DELETE /phrases/:id 返回 ok', t11.d && t11.d.ok === true, t11.d)

  // 12 POST /party-terms/apply
  const t12 = await post('/party-terms/apply', { party: cust })
  assertStatus('POST /party-terms/apply', t12)
  yes('  /party-terms/apply 返回 ok', t12.d && t12.d.ok === true, t12.d)

  // 13 POST /term-gap/apply
  const t13 = await post('/term-gap/apply', { term_days: 15 })
  assertStatus('POST /term-gap/apply', t13)
  yes('  /term-gap/apply 返回 ok', t13.d && t13.d.ok === true, t13.d)

  // 14 POST /term-advice/apply
  const t14 = await post('/term-advice/apply', { type: 'ar', mode: 'all' })
  assertStatus('POST /term-advice/apply', t14)
  yes('  /term-advice/apply 返回 ok', t14.d && t14.d.ok === true, t14.d)

  // 15 POST /statement-log/:id/resolve
  const t15 = await post('/statement-log/' + slId + '/resolve', { note: '已解决' })
  assertStatus('POST /statement-log/:id/resolve', t15)
  yes('  /statement-log/:id/resolve 返回 ok', t15.d && t15.d.ok === true, t15.d)

  // 16 POST /statement-log/:id/ack
  const t16 = await post('/statement-log/' + slId + '/ack', { ack: 'ok', note: '对上了' })
  assertStatus('POST /statement-log/:id/ack', t16)
  yes('  /statement-log/:id/ack 返回 ok', t16.d && t16.d.ok === true, t16.d)

  // 17 POST /migrate-preview（预览，不写）
  const t17 = await post('/migrate-preview', { type: 'ar', date: TODAY, text: cust + ' 1000' })
  assertStatus('POST /migrate-preview', t17)
  yes('  /migrate-preview 返回 JSON', t17.d && typeof t17.d === 'object', t17.d)

  // 18 POST /edit-requests/:id/approve
  const t18 = await post('/edit-requests/' + erId + '/approve', {})
  assertStatus('POST /edit-requests/:id/approve', t18)
  yes('  /edit-requests/:id/approve 返回 ok', t18.d && t18.d.ok === true, t18.d)

  // 19 POST /edit-requests/:id/reject（再提一条，然后拒）
  await post('/edit-request', { kind: 'ar', id: orderId, changes: { price: 1002 }, reason: '写接口覆盖-拒' })
  const erRows2 = await get('/edit-requests?status=pending')
  const erId2 = (erRows2.d && erRows2.d.rows && erRows2.d.rows[0] && erRows2.d.rows[0].id) || 0
  const t19 = await post('/edit-requests/' + erId2 + '/reject', { note: '不批' })
  assertStatus('POST /edit-requests/:id/reject', t19)
  yes('  /edit-requests/:id/reject 返回 ok', t19.d && t19.d.ok === true, t19.d)

  // 20 POST /edit-requests/:id/cancel（再提一条，然后撤）
  await post('/edit-request', { kind: 'ar', id: orderId, changes: { price: 1003 }, reason: '写接口覆盖-撤' })
  const erRows3 = await get('/edit-requests?status=pending')
  const erId3 = (erRows3.d && erRows3.d.rows && erRows3.d.rows[0] && erRows3.d.rows[0].id) || 0
  const t20 = await post('/edit-requests/' + erId3 + '/cancel', {})
  assertStatus('POST /edit-requests/:id/cancel', t20)
  yes('  /edit-requests/:id/cancel 返回 ok', t20.d && t20.d.ok === true, t20.d)

  // 21 POST /report-head
  const t21 = await post('/report-head', { title: '测试抬头', note: '写接口覆盖' })
  assertStatus('POST /report-head', t21)
  yes('  /report-head 返回 ok', t21.d && t21.d.ok === true, t21.d)
  // /report-head 的 GET 返回单对象（不是数组），直接断言字段
  const rh = (await get('/report-head')).d
  yes('/report-head 写后读：title 落库', String((rh || {}).title || '') === '测试抬头', rh)

  // 22 POST /invoice-from-order（先收了 500，能开 500）
  const t22 = await post('/invoice-from-order', { order_id: orderId, amount: 500 })
  assertStatus('POST /invoice-from-order', t22)
  yes('  /invoice-from-order 返回 ok', t22.d && t22.d.ok === true, t22.d)

  // 23 POST /invoice-skip
  const t23 = await post('/invoice-skip', { order_id: orderId, skip: true })
  assertStatus('POST /invoice-skip', t23)
  yes('  /invoice-skip 返回 ok', t23.d && t23.d.ok === true, t23.d)

  // 24 POST /bank-auto-match（有流水 + 有已收单，至少能跑完不崩）
  const t24 = await post('/bank-auto-match', { apply: false })
  assertStatus('POST /bank-auto-match', t24)
  yes('  /bank-auto-match 返回 ok', t24.d && t24.d.ok === true, t24.d)

  finish('写接口覆盖')
}

run().catch((e) => { console.error('❌ 测试脚本异常：', e); process.exit(1) })
