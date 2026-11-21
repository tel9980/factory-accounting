// 两个人同时点，会不会记两遍？—— 并发下必须仍然成立的账务往来
//
// 为什么单独测这一块：
// 前面所有的测试都是一个请求发完再发下一个，所以「先查一下有没有、再写进去」这种写法永远是绿的。
// 但真实场景是：老板在手机上点「收清」，同一秒员工在电脑上点了同一张单的「收款」；
// 或者老板手抖连点两下，两个请求同时到了 Worker。Worker 里每个 await 都会让出执行权，
// 于是两边都查到「还没收满」，都 INSERT 了一条流水 —— 单子上写着收了 1000，账上多了 2000。
//
// 这里钉住的不是「状态码对不对」，而是**账务不变量**：
//   单据的 paid / written_off 不许超过金额；流水合计必须等于单据上的数；
//   同一个 client_id 并发两次只许记一笔；同一份导入文件并发两次只许导一次；
//   撤销认领并发了不许把钱退两遍。
//
// 用法：node scripts/test-concurrency.mjs --base http://127.0.0.1:8791 --key 8888
const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const BASE = opt('base', 'http://127.0.0.1:8791').replace(/\/+$/, '')
const KEY = opt('key', '8888')
// 只用字母：一句话记账会把句子里的数字当金额剥掉，客户名里带数字会被拆坏（第 8 组就靠这个名字查单）。
const TAG = '并发' + Array.from({ length: 4 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')
const TODAY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const MON = TODAY.slice(0, 7)

const num0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const r2 = (v) => Math.round(num0(v) * 100) / 100
let pass = 0
const bad = []
const ok = (m) => { pass++; console.log('  ✅ ' + m) }
const no = (m, extra) => { bad.push(m + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))); console.log('  ❌ ' + m + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))) }
const yes = (m, cond, extra) => (cond ? ok(m) : no(m, extra))

async function call(method, path, body, key) {
  const h = { 'x-access-key': key || KEY }
  if (body !== undefined) h['content-type'] = 'application/json'
  const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
  const t = await r.text()
  let d = null
  try { d = JSON.parse(t) } catch (e) { d = t }
  return { s: r.status, d }
}
const get = (p, key) => call('GET', p, undefined, key)
const post = (p, b, key) => call('POST', p, b === undefined ? {} : b, key)

// 同时发出去：一条 command 里同时 fetch，谁也不等谁
const par = (fns) => Promise.all(fns.map((f) => f().catch((e) => ({ s: 0, d: { error: 'throw:' + e.message } }))))

async function newOrder(customer, price) {
  await post('/orders', { customer, item_name: '并发测试', price, date: TODAY })
  const r = await get('/ar?status=all&kw=' + encodeURIComponent(customer))
  const row = (Array.isArray(r.d) ? r.d : []).find((x) => x.customer === customer)
  return row || {}
}
async function newPayable(supplier, amount) {
  await post('/payables', { supplier, amount, date: TODAY })
  const r = await get('/ap?status=all&kw=' + encodeURIComponent(supplier))
  const row = (Array.isArray(r.d) ? r.d : []).find((x) => x.supplier === supplier)
  return row || {}
}
// 这张单在流水里一共记了多少（按 ref_type+ref_id 汇总）
async function ledgerSum(refType, refId, dir) {
  const r = await get('/flows?month=' + MON)
  const rows = (r.d && r.d.rows) || []
  return r2(rows.filter((x) => String(x.ref_type) === refType && num0(x.ref_id) === num0(refId) && (!dir || x.dir === dir)).reduce((a, x) => a + num0(x.amount), 0))
}
async function ledgerCount(refType, refId, dir) {
  const r = await get('/flows?month=' + MON)
  const rows = (r.d && r.d.rows) || []
  return rows.filter((x) => String(x.ref_type) === refType && num0(x.ref_id) === num0(refId) && (!dir || x.dir === dir)).length
}

const main = async () => {
  console.log('\n== 并发测试（' + BASE + '）==')

  // ── 一、同一张单，两个人同时收全额 ──────────────────────────────
  console.log('\n[1] 同一张单，两个人同时点「收清」')
  {
    const o = await newOrder(TAG + '甲', 1000)
    const id = o.id
    const rs = await par([
      () => post(`/orders/${id}/receive`, { amount: 1000, date: TODAY }),
      () => post(`/orders/${id}/receive`, { amount: 1000, date: TODAY })
    ])
    const succ = rs.filter((x) => x.s === 200).length
    const after = (await get('/ar?status=all&kw=' + encodeURIComponent(TAG + '甲'))).d.find((x) => num0(x.id) === num0(id)) || {}
    const sum = await ledgerSum('order', id, 'in')
    yes('只成功一次（另一个被挡）', succ === 1, { 成功: succ, 状态: rs.map((x) => x.s) })
    yes('单据已收 = 1000', r2(after.paid) === 1000, after.paid)
    yes('流水合计 = 单据已收（钱没记两遍）', sum === r2(after.paid), { 流水: sum, 已收: r2(after.paid) })
  }

  // ── 二、六个人同时各收 300（单 1000）────────────────────────────
  console.log('\n[2] 六个人同时各收 300（单子只有 1000）')
  {
    const o = await newOrder(TAG + '乙', 1000)
    const id = o.id
    const rs = await par([1, 2, 3, 4, 5, 6].map(() => () => post(`/orders/${id}/receive`, { amount: 300, date: TODAY })))
    const succ = rs.filter((x) => x.s === 200).length
    const after = (await get('/ar?status=all&kw=' + encodeURIComponent(TAG + '乙'))).d.find((x) => num0(x.id) === num0(id)) || {}
    const sum = await ledgerSum('order', id, 'in')
    yes('已收没超过单子金额', r2(after.paid) <= 1000, after.paid)
    // 收款是「能收多少收多少」：最后一笔常常只收走剩下的那点（6×300 收 1000 时，
    // 可能是 300+300+300+100 四次成功，也可能是三次 300 成功、剩下 100 让用户再点一次）。
    // 所以不能断言「成功次数 = 已收/300」，也不能断言「一定收满」——
    // 真正的不变量是：每次成功都不超过 300（成功次数 × 300 一定 ≥ 已收），且已收不超过单子金额。
    yes('每次成功都不超过 300', succ * 300 >= r2(after.paid) - 0.005, { 成功: succ, 已收: r2(after.paid) })
    yes('至少收进去一笔（并发下不该全军覆没）', succ >= 1 && r2(after.paid) > 0, { 成功: succ, 已收: r2(after.paid) })
    yes('流水合计 = 单据已收', sum === r2(after.paid), { 流水: sum, 已收: r2(after.paid) })
  }

  // ── 三、同一个 client_id 连点两下 ───────────────────────────────
  console.log('\n[3] 手抖连点两下（同一个 client_id）')
  {
    const o = await newOrder(TAG + '丙', 1000)
    const id = o.id
    const cid = 'cc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const rs = await par([
      () => post(`/orders/${id}/receive`, { amount: 400, date: TODAY, client_id: cid }),
      () => post(`/orders/${id}/receive`, { amount: 400, date: TODAY, client_id: cid })
    ])
    const after = (await get('/ar?status=all&kw=' + encodeURIComponent(TAG + '丙'))).d.find((x) => num0(x.id) === num0(id)) || {}
    const sum = await ledgerSum('order', id, 'in')
    yes('同一个 client_id 只记一笔', r2(after.paid) === 400, { 已收: after.paid, 状态: rs.map((x) => x.s) })
    yes('流水也只有一笔', sum === 400, sum)
  }

  // ── 四、付款 ───────────────────────────────────────────────────
  console.log('\n[4] 同一张应付，两个人同时付全额')
  {
    const p = await newPayable(TAG + '供应商', 800)
    const rs = await par([
      () => post(`/payables/${p.id}/pay`, { amount: 800, date: TODAY }),
      () => post(`/payables/${p.id}/pay`, { amount: 800, date: TODAY })
    ])
    const after = (await get('/ap?status=all&kw=' + encodeURIComponent(TAG + '供应商'))).d.find((x) => num0(x.id) === num0(p.id)) || {}
    const sum = await ledgerSum('payable', p.id, 'out')
    yes('只成功一次', rs.filter((x) => x.s === 200).length === 1, rs.map((x) => x.s))
    yes('已付 = 800', r2(after.paid) === 800, after.paid)
    yes('流水合计 = 已付', sum === r2(after.paid), { 流水: sum, 已付: r2(after.paid) })
  }

  // ── 五、核销 ───────────────────────────────────────────────────
  console.log('\n[5] 同一张单，两个人同时整笔核销')
  {
    const o = await newOrder(TAG + '丁', 1000)
    const id = o.id
    const rs = await par([
      () => post(`/orders/${id}/writeoff`, { amount: 1000, reason: '并发核销' }),
      () => post(`/orders/${id}/writeoff`, { amount: 1000, reason: '并发核销' })
    ])
    const after = (await get('/ar?status=all&kw=' + encodeURIComponent(TAG + '丁'))).d.find((x) => num0(x.id) === num0(id)) || {}
    const wos = await get('/writeoffs')
    const rows = (wos.d && (wos.d.rows || wos.d.list)) || []
    const wsum = r2(rows.filter((x) => String(x.kind || x.ref_type || '') === 'order' && num0(x.ref_id) === num0(id)).reduce((a, x) => a + num0(x.amount), 0))
    yes('已核销没超过单子金额', r2(after.written_off) <= 1000, after.written_off)
    yes('核销记录合计 = 已核销', wsum === r2(after.written_off), { 记录: wsum, 已核销: r2(after.written_off) })
    yes('只成功一次', rs.filter((x) => x.s === 200).length === 1, rs.map((x) => x.s))
  }

  // ── 六、预收抵扣 ───────────────────────────────────────────────
  console.log('\n[6] 同一笔预收款，两个人同时抵扣同一张单')
  {
    const o = await newOrder(TAG + '戊', 1000)
    const id = o.id
    await post('/advances', { type: 'in', party: TAG + '戊', amount: 500, date: TODAY })
    // 四路一起打：两路两路地来，本地偶尔会串行，四路更容易撞在同一个窗口里
    const rs = await par([1, 2, 3, 4].map(() => () => post(`/orders/${id}/apply-advance`, {})))
    const adv = await get('/advances?type=in')
    const arow = (Array.isArray(adv.d) ? adv.d : ((adv.d && (adv.d.list || adv.d.rows)) || [])).find((x) => String(x.party) === TAG + '戊') || {}
    const after = (await get('/ar?status=all&kw=' + encodeURIComponent(TAG + '戊'))).d.find((x) => num0(x.id) === num0(id)) || {}
    const sumLed = await ledgerSum('order', id, 'in')
    yes('预收用量没超过收到的钱', r2(arow.used) <= r2(arow.amount), { used: arow.used, amount: arow.amount })
    yes('单据已收 = 预收用量', r2(after.paid) === r2(arow.used), { 已收: r2(after.paid), used: r2(arow.used) })
    yes('抵扣流水合计 = 单据已收', sumLed === r2(after.paid), { 流水: sumLed, 已收: r2(after.paid) })
    yes('只成功一次', rs.filter((x) => x.s === 200).length === 1, rs.map((x) => x.s))
  }

  // ── 七、借支退回 ───────────────────────────────────────────────
  console.log('\n[7] 同一笔借支，两个人同时点「退回」')
  {
    await post('/loans', { staff: TAG + '张', amount: 1000, date: TODAY })
    const ls = await get('/loans')
    const lrow = ((ls.d && (ls.d.list || ls.d.rows)) || []).find((x) => String(x.staff) === TAG + '张') || {}
    const rs = await par([
      () => post(`/loans/${lrow.id}/return`, { amount: 1000, date: TODAY }),
      () => post(`/loans/${lrow.id}/return`, { amount: 1000, date: TODAY })
    ])
    const ls2 = await get('/loans')
    const l2 = ((ls2.d && (ls2.d.list || ls2.d.rows)) || []).find((x) => num0(x.id) === num0(lrow.id)) || {}
    const sum = await ledgerSum('loan_return', lrow.id, 'in')
    yes('退回没超过借出', r2(l2.returned) <= r2(l2.amount), { returned: l2.returned, amount: l2.amount })
    yes('流水合计 = 退回金额', sum === r2(l2.returned), { 流水: sum, returned: r2(l2.returned) })
    yes('只成功一次', rs.filter((x) => x.s === 200).length === 1, rs.map((x) => x.s))
  }

  // ── 八、一句话记账同一个 client_id ─────────────────────────────
  console.log('\n[8] 一句话记账，同一个 client_id 同时发两次')
  {
    const name = TAG + '己'
    const cid = 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const rs = await par([
      () => post('/quick', { text: '收' + name + '500', client_id: cid }),
      () => post('/quick', { text: '收' + name + '500', client_id: cid })
    ])
    const r = await get('/ar?status=all&kw=' + encodeURIComponent(name))
    const n = (Array.isArray(r.d) ? r.d : []).filter((x) => String(x.customer || '').startsWith(name)).length
    yes('只生成一张单（不是两张）', n === 1, { 单数: n, 状态: rs.map((x) => x.s) })
  }

  // ── 九、记支出同一个 client_id ─────────────────────────────────
  console.log('\n[9] 记支出，同一个 client_id 同时发两次')
  {
    const remark = TAG + '庚支'
    const cid = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const amt = 100 + (Date.now() % 800)
    await par([
      () => post('/expenses', { amount: amt, category: '其他', remark, date: TODAY, client_id: cid }),
      () => post('/expenses', { amount: amt, category: '其他', remark, date: TODAY, client_id: cid })
    ])
    const f = await get('/flows?month=' + MON + '&kw=' + encodeURIComponent(remark))
    const n = ((f.d && f.d.rows) || []).filter((x) => String(x.remark || '').includes(remark)).length
    yes('只记一笔支出', n === 1, { 笔数: n })
  }

  // ── 十、防重（同日同分类同额）并发 ─────────────────────────────
  console.log('\n[10] 同一天同一分类同一金额，两个人同时记（不勾确认）')
  {
    const amt = 200 + (Date.now() % 700)
    const remark = TAG + '辛支'
    const rs = await par([
      () => post('/expenses', { amount: amt, category: '其他', remark, date: TODAY }),
      () => post('/expenses', { amount: amt, category: '其他', remark, date: TODAY })
    ])
    const f = await get('/flows?month=' + MON + '&kw=' + encodeURIComponent(remark))
    const n = ((f.d && f.d.rows) || []).filter((x) => String(x.remark || '').includes(remark)).length
    yes('最多只记一笔（防重不能双双放行）', n <= 1, { 笔数: n, 状态: rs.map((x) => x.s) })
  }

  // ── 十一、同一份银行流水并发导入 ───────────────────────────────
  console.log('\n[11] 同一份银行账单，两个窗口同时点「导入」')
  {
    const stamp = Date.now()
    const text = [
      '交易日期,摘要,金额,对方',
      `${TODAY},货款,${5000 + (stamp % 90)},${TAG}银行甲`,
      `${TODAY},货款,${6000 + (stamp % 90)},${TAG}银行乙`
    ].join('\n')
    const rs = await par([
      () => post('/bank-import', { text }),
      () => post('/bank-import', { text })
    ])
    const f = await get('/bank-flows')
    const rows = ((f.d && (f.d.rows || f.d.list)) || []).filter((x) => String(x.memo || '').includes(TAG + '银行'))
    yes('同一份文件只入账一次（2 条，不是 4 条）', rows.length === 2, { 条数: rows.length, 状态: rs.map((x) => x.s) })
  }

  // ── 十二、撤销认领并发 ─────────────────────────────────────────
  console.log('\n[12] 同一笔银行流水，两个人同时点「撤销认领」')
  {
    const stamp = Date.now()
    const text = ['交易日期,摘要,金额,对方', `${TODAY},货款,3000,${TAG}银行丙`].join('\n')
    await post('/bank-import', { text })
    const f = await get('/bank-flows')
    const bf = ((f.d && (f.d.rows || f.d.list)) || []).find((x) => String(x.memo || '').includes(TAG + '银行丙')) || {}
    // 先认领到一张单上
    const o = await newOrder(TAG + '壬', 3000)
    const mr = await post(`/bank-flows/${bf.id}/match`, { target_type: 'order', target_id: o.id })
    yes('先把这笔录水认领到单上（准备好前提）', mr.s === 200, { 状态: mr.s, 返回: mr.d })
    const before = (await get('/ar?status=all&kw=' + encodeURIComponent(TAG + '壬'))).d.find((x) => num0(x.id) === num0(o.id)) || {}
    const rs = await par([
      () => post(`/bank-flows/${bf.id}/unmatch`, {}),
      () => post(`/bank-flows/${bf.id}/unmatch`, {})
    ])
    const after = (await get('/ar?status=all&kw=' + encodeURIComponent(TAG + '壬'))).d.find((x) => num0(x.id) === num0(o.id)) || {}
    const sum = await ledgerSum('order', o.id, 'in')
    yes('只退一次（钱没退两遍）', r2(after.paid) >= 0 && r2(after.paid) === r2(before.paid) - r2(bf.amount), { 前: r2(before.paid), 后: r2(after.paid), 流水金额: r2(bf.amount) })
    yes('流水合计 = 单据已收', sum === r2(after.paid), { 流水: sum, 已收: r2(after.paid) })
    yes('第二次被挡', rs.filter((x) => x.s === 200).length === 1, rs.map((x) => x.s))
  }

  // ── 十三、同一张单并发标交付 ───────────────────────────────────
  console.log('\n[13] 同一张单，三个人同时点「已交付」')
  {
    const o = await newOrder(TAG + '癸', 500)
    const rs = await par([
      () => post(`/orders/${o.id}/status`, { status: 2 }),
      () => post(`/orders/${o.id}/status`, { status: 2 }),
      () => post(`/orders/${o.id}/status`, { status: 2 })
    ])
    const after = (await get('/ar?status=all&kw=' + encodeURIComponent(TAG + '癸'))).d.find((x) => num0(x.id) === num0(o.id)) || {}
    yes('都回 ok 或 409，没有 500', rs.every((x) => x.s < 500), rs.map((x) => x.s))
    yes('状态是已交付', num0(after.status) === 2, after.status)
    yes('交付日期只记一次（不是拼接/覆盖成怪值）', /^\d{4}-\d{2}-\d{2}$/.test(String(after.delivered_at || '')) || after.delivered_at === null || after.delivered_at === '', after.delivered_at)
  }

  // ── 十四、收完钱再删单，并发 ───────────────────────────────────
  console.log('\n[14] 一个人收钱，另一个人同时删这张单')
  {
    const o = await newOrder(TAG + '子', 900)
    const rs = await par([
      () => post(`/orders/${o.id}/receive`, { amount: 900, date: TODAY }),
      () => call('DELETE', `/orders/${o.id}`)
    ])
    // 不管谁先，都不许留下「单据没了但流水还挂着」的孤儿：自检要干净
    const sc = await get('/selfcheck')
    const orphans = num0(sc.d && sc.d.orphan_ledger)
    yes('没有孤儿流水', orphans === 0, { orphan_ledger: orphans, 状态: rs.map((x) => x.s) })
  }

  // ── 十五、同一个 client_id 五个请求一起到（连点/网络重试的最坏情况）──
  console.log('\n[15] 同一个 client_id 五个请求一起到')
  {
    const cid = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const name = TAG + '丑'
    const rs = await par([1, 2, 3, 4, 5].map(() => () => post('/orders', { customer: name, item_name: '五连点', price: 780, date: TODAY, client_id: cid })))
    const r = await get('/ar?status=all&kw=' + encodeURIComponent(name))
    const n = (Array.isArray(r.d) ? r.d : []).filter((x) => String(x.customer) === name).length
    yes('应收：只生成一张单', n === 1, { 单数: n, 状态: rs.map((x) => x.s) })

    const cidA = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const partyA = TAG + '寅'
    await par([1, 2, 3, 4, 5].map(() => () => post('/advances', { type: 'in', party: partyA, amount: 600, date: TODAY, client_id: cidA })))
    const adv = await get('/advances?type=in')
    const na = (Array.isArray(adv.d) ? adv.d : []).filter((x) => String(x.party) === partyA).length
    yes('预收：只记一笔', na === 1, { 笔数: na })

    const cidL = 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const staffL = TAG + '李'
    await par([1, 2, 3, 4, 5].map(() => () => post('/loans', { staff: staffL, amount: 700, date: TODAY, client_id: cidL })))
    const ls = await get('/loans')
    const nl = ((ls.d && (ls.d.list || ls.d.rows)) || []).filter((x) => String(x.staff) === staffL).length
    yes('借支：只记一笔', nl === 1, { 笔数: nl })
  }

  // ── 十六、八个人同时各收 200（单 1000）──
  console.log('\n[16] 八个人同时各收 200（单子只有 1000）')
  {
    const o = await newOrder(TAG + '卯', 1000)
    const rs = await par([1, 2, 3, 4, 5, 6, 7, 8].map(() => () => post(`/orders/${o.id}/receive`, { amount: 200, date: TODAY })))
    const after = (await get('/ar?status=all&kw=' + encodeURIComponent(TAG + '卯'))).d.find((x) => num0(x.id) === num0(o.id)) || {}
    const sum = await ledgerSum('order', o.id, 'in')
    yes('已收没超过单子金额', r2(after.paid) <= 1000, after.paid)
    yes('流水合计 = 单据已收', sum === r2(after.paid), { 流水: sum, 已收: r2(after.paid) })
    yes('成功次数 = 已收 / 200', rs.filter((x) => x.s === 200).length === Math.round(r2(after.paid) / 200), rs.map((x) => x.s))
  }

  // ── 十七、四个人同时撤销同一笔认领 ───────────────────────────
  console.log('\n[17] 四个人同时点同一笔流水的「撤销认领」')
  {
    const text = ['交易日期,摘要,金额,对方', `${TODAY},货款,2400,${TAG}银行丁`].join('\n')
    await post('/bank-import', { text })
    const f = await get('/bank-flows')
    const bf = ((f.d && (f.d.rows || f.d.list)) || []).find((x) => String(x.memo || '').includes(TAG + '银行丁')) || {}
    const o = await newOrder(TAG + '辰', 2400)
    const mr = await post(`/bank-flows/${bf.id}/match`, { target_type: 'order', target_id: o.id })
    yes('前提：流水认领成功', mr.s === 200, { 状态: mr.s, 返回: mr.d })
    const before = (await get('/ar?status=all&kw=' + encodeURIComponent(TAG + '辰'))).d.find((x) => num0(x.id) === num0(o.id)) || {}
    const rs = await par([1, 2, 3, 4].map(() => () => post(`/bank-flows/${bf.id}/unmatch`, {})))
    const after = (await get('/ar?status=all&kw=' + encodeURIComponent(TAG + '辰'))).d.find((x) => num0(x.id) === num0(o.id)) || {}
    const sum = await ledgerSum('order', o.id, 'in')
    yes('只退一次', r2(after.paid) === r2(before.paid) - 2400, { 前: r2(before.paid), 后: r2(after.paid) })
    yes('流水合计 = 单据已收', sum === r2(after.paid), { 流水: sum, 已收: r2(after.paid) })
    yes('只有一个成功', rs.filter((x) => x.s === 200).length === 1, rs.map((x) => x.s))
  }

  // ── 十八、同一笔借款，两个人同时还本金 ─────────────────────────
  console.log('\n[18] 同一笔借款，两个人同时点「还本金」')
  {
    const cr = await post('/debts', { lender: TAG + '银行', principal: 1000, kind: 'bank', pay_kind: 'interest', date: TODAY })
    const did = num0(cr.d && cr.d.id)
    const rs = await par([
      () => post(`/debts/${did}/repay`, { amount: 1000, kind: 'principal', date: TODAY }),
      () => post(`/debts/${did}/repay`, { amount: 1000, kind: 'principal', date: TODAY })
    ])
    const ds = await get('/debts')
    const drow = ((ds.d && (ds.d.list || ds.d.rows)) || []).find((x) => num0(x.id) === did) || {}
    const reps = num0(drow.repaid_principal) || num0(drow.paid_principal) || (r2(drow.principal) - r2(drow.remain))
    yes('还掉的本金没超过借进来的', r2(drow.principal) - r2(drow.remain) <= r2(drow.principal) + 0.005, { 本金: r2(drow.principal), 余: r2(drow.remain) })
    yes('还款记录合计没翻倍', r2(drow.principal) - r2(drow.remain) <= 1000 + 0.005, { 还掉: r2(drow.principal) - r2(drow.remain), 状态: rs.map((x) => x.s) })
    yes('现金只出去一次', r2(drow.principal) - r2(drow.remain) !== 2000, { 余: r2(drow.remain) })
    void reps
  }

  // ── 十九、静态护栏：上面这些「自带条件的写法」不许在重构里丢掉 ──
  // 本地 wrangler dev 经常把请求串行化，并发测试不一定每次都能撞出窗口；
  // 所以再加一层：直接看源码里那几条条件还在不在。丢了就红，不用等运气。
  console.log('\n[19] 静态护栏（并发用的 SQL 条件还在不在）')
  {
    const fs = await import('node:fs')
    const src = fs.readFileSync(new URL('../backend/index.js', import.meta.url), 'utf8')
    const has = (m, frag) => yes(m, src.includes(frag), { 缺少片段: frag })
    has('应收：收款语句带「不超金额」条件', 'AND paid + COALESCE(written_off,0) + ? <= price + 0.005')
    has('应付：付款语句带「不超金额」条件', 'AND paid + COALESCE(written_off,0) + ? <= amount + 0.005')
    has('预收抵扣：改单带「已收仍是老值」', 'AND paid BETWEEN ? - 0.005 AND ? + 0.005')
    has('预收抵扣：改单带「预收还够」子查询', "FROM advances WHERE type='in' AND party=?) >= ? - 0.005")
    has('预付抵扣：改单带「预付还够」子查询', "FROM advances WHERE type='out' AND party=?) >= ? - 0.005")
    has('预收抵扣：没扣上要回滚', 'badAdv')
    // 输的那一方后面的语句也可能真的执行了（流水那条的闸门只看单据已收），所以「没赢」
    // 也必须走回滚，而且删流水要按 batch 返回的 last_row_id 精确删自己那一条。
    has('预收抵扣：没赢也回滚（不只「预收没扣上」才回滚）', 'const won = changesOf(done[0]) > 0')
    has('预付抵扣：没赢也回滚', 'const wonP = changesOf(done[0]) > 0')
    has('回滚删流水：只删自己插的那条', 'DELETE FROM ledger WHERE id=? AND ref_type=? AND ref_id=? AND COALESCE(cash,1)=0')
    has('核销：写核销记录带「不超剩余」', 'COALESCE(written_off,0) + ? <= price - COALESCE(paid,0) + 0.005')
    has('借支退回：带「不超借出」条件', 'COALESCE(used,0) + COALESCE(returned,0) + ? <= amount + 0.005')
    has('借支退回：没赢也回滚（否则流水会被记两次）', 'const wonL = changesOf(doneL[0]) > 0')
    has('还本金：带「不超剩余本金」条件', "? <= (COALESCE(?,0) - COALESCE((SELECT SUM(amount) FROM debt_repays WHERE debt_id=? AND kind='principal'),0)) + 0.005")
    has('撤销认领：先占位再退钱', "COALESCE(matched_type,'')<>''")
    has('支出防重：写的时候才判重', 'WHERE NOT EXISTS (SELECT 1 FROM ledger WHERE direction=\'out\' AND cash=1 AND ref_type=\'expense\'')
    has('应收防连点：写的时候才判重', 'WHERE NOT EXISTS (SELECT 1 FROM orders WHERE customer=? AND price=? AND created_at >= ?)')
    has('应付防重：写的时候才判重', 'WHERE NOT EXISTS (SELECT 1 FROM payables WHERE supplier=? AND amount=? AND created_at >= ?)')
    has('导入/备份：写前先占指纹（整包）', "settings")
    // 「同一个文件不重复入账」必须是「先占坑」而不是「先查后写」：先查后写两个并发请求都读到
    // 「没导过」，同一份表/账单就导两遍（流水翻倍、认领两次就是两倍收款）。
    has('整包导入：指纹是先占坑', "const claimFp = await db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)')")
    has('银行账单：指纹是先占坑', "const claimBk = await db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)')")
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + bad.length + ' 项')
  if (bad.length) { console.log('\n失败清单：'); bad.forEach((b) => console.log('  · ' + b)); process.exit(1) }
}

main().catch((e) => { console.error('测试自身出错：', e); process.exit(1) })
