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

// 第 4 个参数以前只当口令用；现在多一种用法 { book } —— 带 X-Book 走到指定账套
const call = async (method, p, body, key) => {
  const h = { 'Content-Type': 'application/json' }
  let bk = 0
  if (key && typeof key === 'object') { bk = Number(key.book) || 0; key = KEY }
  if (bk) h['X-Book'] = String(bk)
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
  // 这里以前写 `all_done === false || done === 0`，两个条件任一成立就算过 —— 等于恒真。
  // 清空之后必须真的是「一步都没做」。
  yes('开账引导回到「没做完」', ob.d.all_done === false && num0(ob.d.done) === 0, JSON.stringify(ob.d).slice(0, 120))

  // 4. 导回去（换电脑/换账套的主路径）
  const im = await post('/import-all', { pkg, mode: 'replace', confirm: '覆盖' })
  eq('导入状态码', im.s, 200)
  yes('导入返回 ok', im.d.ok === true, im.d && im.d.error)
  // 数总单数不能用 /ar —— 它有分页（一页 60），库里超过一页就会「少」，
  // 这条断言以前在干净库上绿、在攒了 96 张单的库上假红。用导出包自带的 counts 数。
  const ex2 = await get('/export-all')
  const ordersAfter = num0((ex2.d && ex2.d.counts && ex2.d.counts.orders) || 0)
  eq('导回来后单数一致', ordersAfter, ordersBefore)
  const me2 = await get('/me')
  eq('整本覆盖后口令还在（否则下次打不开）', me2.d.role, 'owner')

  // 5. 演示口令不许清空
  const dm = await post('/book-reset', { confirm: '清空' }, DEMO)
  // 503 是「演示账套还没就绪」（库没灌 schema），不是「被拒」。以前两者都算过。
  eq('演示口令清空被拒（403，不是 503）', dm.s, 403)
  eq('拒绝原因是只读', dm.d.code, 'demo_readonly')

  // 6. 账套管理（电脑上改名 / 看每本有多少账）
  const all = await get('/books-all')
  yes('/books-all 能列出账套', all.s === 200 && Array.isArray(all.d.books) && all.d.books.length >= 1, all.s + ' ' + JSON.stringify(all.d).slice(0, 120))
  yes('  说了最多能开几本', num0(all.d.max) >= 3, all.d.max)
  yes('  标出了当前账套', (all.d.books || []).some((b) => b.current === true), all.d.books)
  // 改名：现在是「谁的口令改哪本」。只有第 1 本的口令，改第 2 本必须被拒（以前谁都能改别家名字）。
  const nm1 = TAG + '一厂'
  const ren1 = await post('/book-admin', { book: 1, name: nm1 })
  yes('改自己这本的名字 → 200', ren1.s === 200 && ren1.d.ok === true, ren1.s)
  const after1 = await get('/books-all')
  yes('  改名生效', (after1.d.books || []).some((b) => b.id === 1 && b.name === nm1), (after1.d.books || []).map((b) => b.name))
  await post('/book-admin', { book: 1, name: '主账套' })
  ok('  名字改回去了')
  if ((all.d.books || []).some((b) => b.id === 2)) {
    const bad2 = await post('/book-admin', { book: 2, name: TAG + '二厂' })
    yes('拿第 1 本的口令改第 2 本 → 403（要超级口令）', bad2.s === 403 && bad2.d.code === 'super_only', bad2.s + ' ' + (bad2.d && bad2.d.code))
    // 切到第 2 本再改自己的名字，应该通
    const ren2 = await post('/book-admin', { book: 2, name: TAG + '二厂' }, { book: 2 })
    yes('切到第 2 本改自己的名字 → 200', ren2.s === 200 && ren2.d.ok === true, ren2.s)
    const after2 = await get('/books-all')
    yes('  改名生效', (after2.d.books || []).some((b) => b.id === 2 && b.name === TAG + '二厂'), (after2.d.books || []).map((b) => b.name))
    await post('/book-admin', { book: 2, name: '账套二' }, { book: 2 })
    ok('  名字改回去了')
  } else { ok('这台机器只开了一本账，跳过第 2 本的改名测试') }
  const noBook = await post('/book-admin', { book: 9, name: '不存在的' })
  yes('改不存在的账套 → 404', noBook.s === 404 && noBook.d.code === 'no_book', noBook.s + ' ' + (noBook.d && noBook.d.code))
  const emptyName = await post('/book-admin', { book: 1, name: '  ' })
  yes('名字空着 → 400', emptyName.s === 400, emptyName.s)
  const demoAll = await get('/books-all', DEMO)
  yes('演示口令看不到账套列表', demoAll.s === 403, demoAll.s)

  // 7. 首页要有两个入口
  const home = await fetch(BASE + '/')
  const html = await home.text()
  yes('首页有 /pc 链接', /href="\/pc"/.test(html))
  yes('首页有 /guide 链接', /href="\/guide"/.test(html))
  yes('首页不再写着「请不要在浏览器里打开」', !/请不要在浏览器里打开/.test(html))

  // 页面脚本必须能解析：这里写坏一个换行，整页按钮全都不响应，而且看起来只是「点了没反应」
  const pc = await (await fetch(BASE + '/pc')).text()
  const sm = pc.match(/<script>([\s\S]*?)<\/script>/)
  let parseErr = ''
  try {
    if (!sm) throw new Error('没有 <script>')
    new Function(sm[1])
  } catch (e) { parseErr = String((e && e.message) || e) }
  yes('/pc 的脚本能解析（解析不了整页按钮都点不动）', !parseErr, parseErr)

  console.log('')
  if (bad.length) {
    console.log('❌ 整账套回归 ' + bad.length + ' 项失败：')
    bad.forEach((x) => console.log('   · ' + x))
    process.exit(1)
  }
  console.log('✅ 整账套导出 / 导入 / 一键初始化 ' + pass + ' 项全部通过')
}

run().catch((e) => { console.error('测试脚本自己挂了：', e); process.exit(1) })
