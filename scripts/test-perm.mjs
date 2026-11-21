// 权限与可见性回归：员工（4 位 PIN）与演示（谁都能点）这两个身份，能碰的东西必须是白名单。
//
// 为什么值得钉住：这套系统里「越权」从来不会报错。员工 4 位 PIN 就能 POST /transfer 建内部转账、
// 拖走 /export 的全量单子（含成本）、点 /collect-config 改催款口径、/networth-snapshot 写家底存档 ——
// 页面上什么都看不出来，老板也收不到任何提示。所以这里做三件事：
//   1) 从源码里把「所有写接口」抄出来，逐个用员工口令打一遍：白名单以外的必须 403。
//      新加一个接口如果忘了想权限，这条测试会红 —— 这正是我们要的（默认关，而不是默认开）。
//   2) 「看得见金额的系统内部东西」（报错日志、自检、账套清单、审计、回收站、税金汇总）逐个打 403。
//   3) 员工该干的事不能被误拦：建单、收款、记支出、借支、导入、对账、提改单申请，都要通。
//
// 用法：node scripts/test-perm.mjs [--base http://127.0.0.1:8791] [--key 8888]

const fs = await import('node:fs')
const args = process.argv.slice(2)
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const BASE = arg('base', 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = arg('key', '8888')
const TODAY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const MONTH = TODAY.slice(0, 7)
const TAG = '权测' + Date.now().toString(36).replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]).slice(-4)

let pass = 0
const bad = []
const ok = (m) => { pass++; console.log('  ✅ ' + m) }
const no = (m, d) => { bad.push(m); console.log('  ❌ ' + m + (d === undefined ? '' : ' → ' + JSON.stringify(d))) }
const eq = (m, a, b) => (a === b ? ok(m + ' = ' + JSON.stringify(a)) : no(m, { got: a, want: b }))

const req = async (method, path, key, body, extra) => {
  const headers = { 'X-Access-Key': key, 'Content-Type': 'application/json' }
  if (extra && extra.book) headers['X-Book'] = String(extra.book)
  const r = await fetch(BASE + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) })
  let d = null
  try { d = await r.json() } catch (e) { d = null }
  return { s: r.status, d }
}

// 从源码里抄出所有写接口：这样「新加一个 POST 忘了想权限」也能被抓到
const src = fs.readFileSync(new URL('../backend/index.js', import.meta.url), 'utf8')
const allRoutes = []
for (const line of src.split('\n')) {
  const m = line.match(/app\.(get|post|patch|delete|put)\(\s*'([^']+)'/)
  if (m) allRoutes.push([m[1].toUpperCase(), m[2]])
}
const writes = allRoutes.filter(([m]) => m !== 'GET')
// 与 backend/index.js 里的 STAFF_WRITE_OK 一一对应：员工「记账本身」需要的动作
const STAFF_WRITE_OK = [
  /^\/orders$/, /^\/orders\/\d+\/receive$/, /^\/orders\/\d+\/status$/,
  /^\/receive-batch$/, /^\/pay-batch$/, /^\/quick$/,
  /^\/payables$/, /^\/payables\/\d+\/pay$/,
  /^\/expenses$/, /^\/advances$/, /^\/loans$/, /^\/loans\/\d+\/(return|reimburse)$/,
  /^\/attachments?$/, /^\/batch$/,
  /^\/edit-request$/, /^\/edit-requests\/\d+\/cancel$/,
  /^\/(import|import-rows|import-xlsx|import-pack|parse-import|detect-import)$/,
  /^\/(reconcile|recon-confirm|pipeline-summary)$/,
  /^\/statement-log$/, /^\/statement-log\/\d+\/(ack|resolve)$/,
  /^\/party-terms$/, /^\/party-terms\/apply$/, /^\/dunning-log$/, /^\/profiles$/,
  /^\/(materials|material-moves|frame-prices|outsource|rework|invoices)$/, /^\/outsource\/\d+\/back$/
]
const isStaffOk = (p) => STAFF_WRITE_OK.some((re) => re.test(p))

const run = async () => {
  console.log('权限与可见性（base=' + BASE + '，标记 ' + TAG + '）')
  await req('POST', '/auth/setup', KEY, { key: KEY })
  const PIN = String(1000 + (Date.now() % 9000))
  const mk = await req('POST', '/staff-users', KEY, { name: TAG + '员', pin: PIN, mods: ['ar', 'ap', 'exp', 'import', 'contact', 'asset'] })
  eq('建一个全模块员工', mk.s, 200)
  eq('拿到的口令就是设的那个', (mk.d || {}).pin, PIN)

  console.log('\n【一】员工能做的日常动作不能被误拦')
  const o = await req('POST', '/orders', PIN, { customer: TAG + '甲', item_name: '权测件', price: 1200, cost: 700, date: TODAY })
  eq('员工建单', o.s, 200)
  // POST /orders 只回 ok（不给 id），靠客户名回查那一张
  const mine0 = (await req('GET', '/ar?kw=' + encodeURIComponent(TAG + '甲'), PIN)).d
  const oid = (((Array.isArray(mine0) ? mine0 : (mine0 && mine0.list) || [])[0]) || {}).id || 0
  yes0('员工能在应收里看到自己刚建的单', !!oid, mine0)
  const got = await req('POST', '/orders/' + oid + '/receive', PIN, { amount: 200, account_id: 1, date: TODAY })
  eq('员工收款', got.s, 200)
  eq('员工记支出', (await req('POST', '/expenses', PIN, { amount: 100 + (Date.now() % 90000), category: '水电', remark: TAG + '支出', date: TODAY })).s, 200)
  eq('员工记借支', (await req('POST', '/loans', PIN, { staff: TAG + '张', amount: 300, date: TODAY, account_id: 1 })).s, 200)
  eq('员工提改单申请', (await req('POST', '/edit-request', PIN, { kind: 'ar', id: oid, changes: { price: 1300 }, reason: TAG })).s, 200)
  eq('员工能批量取数（/batch）', (await req('POST', '/batch', PIN, { get: ['/dashboard'] })).s, 200)

  console.log('\n【二】白名单以外的写接口：一律 403')
  const wrong = []
  let allowedCount = 0
  for (const [m, p] of writes) {
    if (/^\/auth\//.test(p)) continue   // /auth/* 是口令入口，本来就免口令，单独验（见下）
    const path = p.replace(/:[a-zA-Z_]+/g, (x) => (x === ':id' ? '1' : 'x'))
    const r = await req(m, path, PIN, {})
    const shouldAllow = isStaffOk(path)
    if (shouldAllow) {
      allowedCount++
      if (r.s === 403) wrong.push([m, p, '白名单里的却被拦了', r.s, (r.d && r.d.code) || ''])
    } else if (r.s !== 403) {
      wrong.push([m, p, '没拦住', r.s, (r.d && r.d.code) || ''])
    }
  }
  if (wrong.length) {
    no('有 ' + wrong.length + ' 条写接口的权限不对', wrong.slice(0, 12))
  } else {
    ok('写接口权限全对（放行 ' + allowedCount + ' 条、拦下 ' + (writes.length - allowedCount - 12) + ' 条，另 12 条 /auth/* 单独验）')
  }
  // 挑几条最要命的单独再钉一次（上面那轮是「按源码逐个打」，这里是明确写出后果）
  const danger = ['/transfer', '/transfers', '/export-all', '/export', '/export-xlsx', '/import-all', '/db-clean', '/restore', '/backup-restore', '/backup-to-notes', '/book-reset', '/book-admin', '/book-admin-key', '/month-close', '/year-close', '/seal', '/unseal', '/party-merge', '/run-cron', '/run-backup', '/cloud-backup', '/run-fixed', '/run-amort', '/collect-config', '/target', '/networth-snapshot', '/term-default', '/term-auto', '/onboarding/apply', '/wx-test', '/bank-flows/1/unmatch', '/bank-import', '/modules', '/staff-users', '/staff-perms', '/staff-activity', '/month-pack-run', '/import-undo']
  for (const p of danger) {
    const r = await req('POST', p, PIN, {})
    yes0('员工打 ' + p + ' 被拦', r.s === 403 && r.d && r.d.code === 'staff_denied', { s: r.s, code: r.d && r.d.code })
  }
  // /auth/* 是口令入口（免口令放行），但员工 PIN 不该能借它改老板口令：要么 400/403，绝不能 200
  for (const p of ['/auth/change', '/auth/staff', '/auth/demo', '/auth/super', '/auth/demo-builtin', '/auth/staff-off']) {
    const r = await req('POST', p, PIN, { old_key: PIN, key: PIN, password: 'x' })
    yes0('员工拿自己的 PIN 改口令 ' + p + ' 进不去', r.s >= 400, { s: r.s, code: r.d && r.d.code })
  }

  console.log('\n【三】看得见金额的系统内部东西：员工也不给看')
  const getDeny = ['/error-log', '/slow-log', '/selfcheck', '/books', '/books-all', '/schema-check', '/books-check', '/audit-logs', '/trash', '/tax-summary', '/party-staff', '/month-archives', '/report-link', '/export', '/export-xlsx', '/month-pack', '/archive-pack', '/archive-json', '/backup-list', '/staff-users', '/staff-activity', '/profit-compare', '/aging', '/kpi', '/month-report', '/networth']
  for (const p of getDeny) {
    const r = await req('GET', p, PIN)
    yes0('员工看 ' + p + ' 被拦', r.s === 403, { s: r.s, code: r.d && r.d.code })
  }

  console.log('\n【四】员工看不到成本与毛利，但该看的金额还在')
  const arS = (await req('GET', '/ar?kw=' + encodeURIComponent(TAG + '甲'), PIN)).d
  const arO = (await req('GET', '/ar?kw=' + encodeURIComponent(TAG + '甲'), KEY)).d
  const rowS = (Array.isArray(arS) ? arS : (arS && arS.list) || [])[0] || {}
  const rowO = (Array.isArray(arO) ? arO : (arO && arO.list) || [])[0] || {}
  eq('员工拿不到 cost', rowS.cost, undefined)
  eq('员工拿不到 gross', rowS.gross, undefined)
  eq('老板能拿到 cost', rowO.cost, 700)
  eq('员工该看的金额还在（单价）', rowS.price, 1200)
  eq('员工该看的欠款还在', rowS.unpaid, 1000)

  console.log('\n【五】员工只在自己的账套里有效')
  const other = await req('GET', '/ar', PIN, null, { book: 2 })
  yes0('员工的 PIN 到第 2 本账进不去', other.s === 401, { s: other.s, code: other.d && other.d.code })
  const owner2 = await req('GET', '/ar', KEY, null, { book: 2 })
  eq('老板口令照样能进第 2 本', owner2.s, 200)

  console.log('\n【六】演示口令：能看账，不能碰系统')
  const demoDeny = ['/error-log', '/slow-log', '/selfcheck', '/books', '/books-check', '/audit-logs', '/party-staff', '/backup-list', '/export-all', '/archive-pack', '/archive-json', '/month-pack', '/staff-users', '/staff-perms', '/schema-check', '/db-clean']
  for (const p of demoDeny) {
    const r = await req('GET', p, 'demo-look')
    yes0('演示口令看 ' + p + ' 被拦', r.s === 403, { s: r.s, code: r.d && r.d.code })
  }
  const demoW = await req('POST', '/export-all', 'demo-look', {})
  yes0('演示口令不能导出整库', demoW.s === 403, { s: demoW.s })
  const dshelf = await req('POST', '/book-admin', 'demo-look', { book: 1, name: 'x' })
  yes0('演示口令不能改账套名', dshelf.s === 403, { s: dshelf.s })
  const dme = await req('GET', '/me', 'demo-look')
  eq('演示口令进的是第 3 本（示例账套）', (dme.d || {}).book, '3')

  console.log('\n【七】收尾：把测试员工删掉，别留在账本里')
  const list = await req('GET', '/staff-users', KEY)
  const mine = ((list.d && list.d.rows) || []).find((u) => u.name === TAG + '员')
  if (mine) eq('删掉测试员工', (await req('DELETE', '/staff-users/' + mine.id, KEY)).s, 200)
  const pinGone = await req('GET', '/me', PIN)
  eq('删了之后这个 PIN 进不来', pinGone.s, 401)

  console.log('')
  if (bad.length) {
    console.log('❌ 权限回归 ' + bad.length + ' 项失败：')
    bad.forEach((x) => console.log('   · ' + x))
    process.exit(1)
  }
  console.log('✅ 权限与可见性 ' + pass + ' 项全部通过')
}

// 小工具：断言「拦住」，失败时把状态码一起打出来
function yes0(m, cond, d) { return cond ? ok(m) : no(m, d) }

run().catch((e) => { console.error('测试脚本自己挂了：', e); process.exit(1) })
