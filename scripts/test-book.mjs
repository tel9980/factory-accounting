// 「换公司能重新用」回归测试：整账套导出 / 导入 / 一键初始化
//
// 这几条错了不会报错，但会让人以为数据没了、或者把上一家的账带进新公司：
//   1. /export-all 导出的包必须带 kind 标记（/import-all 认这个），并且包含单据
//   2. /book-reset 确认字写错必须 400，不许「手一抖就清空」
//   3. 一键初始化后：单据/流水/客户都空、账户和分类回到默认、口令和账本名还在、开账引导回到未完成
//   4. 清空前自动备份一份（snapshot > 0），能反悔
//   5. 把导出的包再导回去，数据要一模一样（换电脑/换账套的主路径）
//   6. 演示口令不许清空账套（只读到底）
//   7. 首页要有 /pc 和 /guide 两个入口（用户说「要链接一起啊」）
//
// 注意：这个脚本会清空当前账套再导回，必须放在 CI 的最后一步跑。
// 用法：node scripts/test-book.mjs [--base http://127.0.0.1:8791] [--key 8888]

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const BASE = arg('base', 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = arg('key', '8888')
const DEMO = 'demo-look'
const TAG = '整账' + Date.now().toString(36).replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]).slice(-4)
const TODAY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)

let pass = 0
const bad = []
const ok = (m) => { pass++; console.log('  ✅ ' + m) }
const no = (m, d) => { bad.push(m); console.log('  ❌ ' + m + (d === undefined ? '' : ' → ' + JSON.stringify(d))) }
const eq = (label, got, want) => (String(got) === String(want) ? ok(`${label} = ${want}`) : no(`${label} 应为 ${want}`, got))
const yes = (label, cond, d) => (cond ? ok(label) : no(label, d))
const num0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

const call = async (method, p, body, key) => {
  const h = { 'Content-Type': 'application/json' }
  if (key !== null) h['X-Access-Key'] = key || KEY
  const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
  const txt = await r.text()
  let d = null
  try { d = JSON.parse(txt) } catch (e) { d = { raw: txt.slice(0, 200) } }
  return { s: r.status, d }
}
const get = (p, key) => call('GET', p, undefined, key)
const post = (p, body, key) => call('POST', p, body, key)

const run = async () => {
  console.log('整账套导出 / 导入 / 一键初始化（' + BASE + '）')

  // 先造一张单，保证导出的包里有东西
  const mk = await post('/orders', { customer: TAG + '客户', item_name: '整账测试活', price: 1234, date: TODAY })
  eq('造一张单', mk.s, 200)

  // 1. 导出
  const ex = await get('/export-all')
  eq('导出状态码', ex.s, 200)
  yes('导出的包带 kind 标记（/import-all 认这个）', ex.d.kind === 'factory-accounting-full', ex.d.kind)
  yes('导出里有 orders 数组', Array.isArray(ex.d.tables && ex.d.tables.orders), typeof (ex.d.tables || {}).orders)
  const ordersBefore = (ex.d.tables.orders || []).length
  yes('导出的单数 > 0', ordersBefore > 0, ordersBefore)
  const pkg = ex.d

  // 2. 确认字写错 → 400，什么都不许动
  const wrong = await post('/book-reset', { confirm: '确定' })
  eq('确认字写错被拦下', wrong.s, 400)
  eq('拦下时给 need_confirm', wrong.d.code, 'need_confirm')
  const arAfterWrong = await get('/ar?status=all')
  yes('拦下后单据还在', Array.isArray(arAfterWrong.d) && arAfterWrong.d.length > 0, arAfterWrong.d && arAfterWrong.d.length)

  // 3. 真清空
  const rs = await post('/book-reset', { confirm: '清空' })
  eq('清空状态码', rs.s, 200)
  yes('清空了 > 20 张表', num0(rs.d.cleared) > 20, rs.d.cleared)
  yes('清空前自动备份了一份', num0(rs.d.snapshot) > 0, rs.d.snapshot)

  const ar0 = await get('/ar?status=all')
  eq('清空后没有应收单', Array.isArray(ar0.d) ? ar0.d.length : -1, 0)
  const fl0 = await get('/flows?month=' + TODAY.slice(0, 7))
  eq('清空后没有流水', Array.isArray(fl0.d.rows) ? fl0.d.rows.length : -1, 0)
  const ac = await get('/accounts')
  const acNames = ((ac.d && (ac.d.accounts || ac.d.list)) || []).map((a) => a.name)
  yes('账户回到默认 4 个', acNames.length === 4 && acNames.indexOf('现金') >= 0, acNames)
  const cg = await get('/categories')
  const outs = (cg.d && (cg.d.expense || cg.d.out)) || []
  yes('支出分类回到默认 9 个', outs.length >= 9, outs.length)
  const me = await get('/me')
  eq('口令没被动过', me.d.role, 'owner')
  const ob = await get('/onboarding')
  yes('开账引导回到「没做完」', ob.d.all_done === false || num0(ob.d.done) === 0, ob.d.done)

  // 4. 导回去（换电脑/换账套的主路径）
  const im = await post('/import-all', { pkg, mode: 'replace', confirm: '覆盖' })
  eq('导入状态码', im.s, 200)
  yes('导入返回 ok', im.d.ok === true, im.d && im.d.error)
  const ar1 = await get('/ar?status=all')
  eq('导回来后单数一致', Array.isArray(ar1.d) ? ar1.d.length : -1, ordersBefore)
  const me2 = await get('/me')
  eq('整本覆盖后口令还在（否则下次打不开）', me2.d.role, 'owner')

  // 5. 演示口令不许清空
  const dm = await post('/book-reset', { confirm: '清空' }, DEMO)
  yes('演示口令清空被拒', dm.s === 403 || dm.s === 503, dm.s + ' ' + (dm.d && (dm.d.code || dm.d.error)))
  if (dm.s === 403) eq('拒绝原因是只读', dm.d.code, 'demo_readonly')

  // 6. 首页要有两个入口
  const home = await fetch(BASE + '/')
  const html = await home.text()
  yes('首页有 /pc 链接', /href="\/pc"/.test(html))
  yes('首页有 /guide 链接', /href="\/guide"/.test(html))
  yes('首页不再写着「请不要在浏览器里打开」', !/请不要在浏览器里打开/.test(html))

  console.log('')
  if (bad.length) {
    console.log('❌ 整账套回归 ' + bad.length + ' 项失败：')
    bad.forEach((x) => console.log('   · ' + x))
    process.exit(1)
  }
  console.log('✅ 整账套导出 / 导入 / 一键初始化 ' + pass + ' 项全部通过')
}

run().catch((e) => { console.error('测试脚本自己挂了：', e); process.exit(1) })
