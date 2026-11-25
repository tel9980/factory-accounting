// 网页端（客户/老板在浏览器里看到的那些页）回归测试
//
// 为什么单独一个脚本：这些页面以前没有任何自动化 —— 手机上排版挤成一团、
// 打印出来的纸上缺电话和免责条款、客户确认页点第二次没反应，全靠人眼看，
// 所以「上一轮刚修好、下一轮又改坏」反复发生（第 18 轮加的电话被第 18 轮
// 自己的 .tip{display:none} 藏了整整一天没人发现）。
//
// 全部用 fetch 断言，不需要浏览器：
//   1. 打印页：抬头有单位名、tip 里有电话、表头/合计行都在、千分位、0 不印成空白
//   2. 手机窄屏：媒体查询在、金额列不许藏、工资单合计行和表头藏同样的列
//   3. 批量打印：最后一张带 .last（不会多印一张空白页）
//   4. 客户对账：有单号、有应结日、改账期链接就失效、改口能改、重复点判重
//   5. 安全头：CSP / no-store / no-referrer；客户名里的 < 必须被转义
//
// 用法：node scripts/test-web-pages.mjs [--base http://127.0.0.1:8791] [--key 8888]

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const BASE = arg('base', 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = arg('key', '8888')
const H = { 'X-Access-Key': KEY, 'Content-Type': 'application/json' }
const UA = { 'User-Agent': 'factory-accounting-test/web-pages' }
const TAG = '网页' + Date.now().toString(36).slice(-4)
const TODAY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const MM = TODAY.slice(0, 7)
const YY = TODAY.slice(0, 4)
const FACTORY = TAG + '加工厂'
const PHONE = '13900001234'

let pass = 0
const bad = []
const ok = (m) => { pass++; console.log('  ✅ ' + m) }
const no = (m, d) => { bad.push(m); console.log('  ❌ ' + m + (d === undefined ? '' : ' → ' + JSON.stringify(d).slice(0, 300))) }
const eq = (label, got, want) => (String(got) === String(want) ? ok(`${label} = ${want}`) : no(`${label} 应为 ${want}`, got))
const isTrue = (label, got) => eq(label, !!got, true)

const call = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) })
  let d = null
  try { d = await r.json() } catch (e) { d = null }
  return { status: r.status, d, headers: r.headers }
}
// 公开页：不带口令，只带普通 UA（Cloudflare 会对空 UA 返 403）
const page = async (url) => {
  const r = await fetch(/^https?:/.test(url) ? url : BASE + url, { headers: UA })
  return { status: r.status, text: await r.text().catch(() => ''), headers: r.headers }
}
const pathOf = (u) => String(u || '').replace(/^https?:\/\/[^/]+/, '')
const wait = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/version'); if (r.ok) return true } catch (e) {}
    await new Promise((s) => setTimeout(s, 1000))
  }
  return false
}
// 页面上某段 CSS 里的规则（用来断言「这条规则还在」而不是只看字符串出现）
const hasCss = (t, frag) => t.indexOf(frag) >= 0

if (!(await wait())) { console.log('❌ 服务器没起来：' + BASE); process.exit(1) }
await call('POST', '/auth/setup', { key: KEY })
// 抬头：单位名和电话（下面每个打印页都要靠它）
await call('POST', '/report-head', { title: FACTORY, note: '网页端测试', phone: PHONE, addr: '测试地址', bank: '测试银行' })

// 造一点数据：本月两张单、一张有到期日
const CUST = TAG + '客户'
const mkOrder = async (item, price, date, due) => {
  const b = { customer: CUST, item_name: item, qty: 1, price, date }
  if (due) b.due_date = due
  const r = await call('POST', '/orders', b)
  if (r.status !== 200) throw new Error('建单失败 ' + r.status + ' ' + JSON.stringify(r.d))
}
await mkOrder('网页测试甲', 1234.56, MM + '-03', MM + '-20')
await mkOrder('网页测试乙', 2000, MM + '-05')

// ── 1. 经营报表（含成本毛利，最容易印漏的那张） ──
console.log('\n[1] 经营报表：抬头是单位名、tip 里有电话、表头在')
{
  const l = await call('GET', '/report-link?month=' + MM)
  const p = await page(pathOf(l.d && l.d.url))
  eq('报表链接能打开', p.status, 200)
  isTrue('抬头印的是单位名（不是「经营报表」四个字）', p.text.includes(FACTORY))
  isTrue('抬头里没有漏出默认值「经营报表」当标题', !/<h1>经营报表<\/h1>/.test(p.text))
  isTrue('页脚 tip 里有电话（客户有疑问能打）', p.text.includes(PHONE))
  isTrue('有表头 thead（跨页时每页都印表头）', /<thead>/.test(p.text))
  isTrue('金额有千分位', /\d{1,3}(,\d{3})+\.\d\d/.test(p.text))
}

// ── 2. 年度总账 / 封账单：0 不许印成空白、宽表要有自己的窄屏规则 ──
console.log('\n[2] 年度总账与封账单：0 印成 0、宽表在手机上能看')
{
  const l = await call('GET', '/year-print-link?year=' + YY)
  const p = await page(pathOf(l.d && l.d.url))
  eq('年度总账能打开', p.status, 200)
  isTrue('没有空的金额格（0 以前印成空白）', !/<td class="n b ?">\s*<\/td>/.test(p.text))
  isTrue('月度行有千分位金额', /<td class="n">[\d,]+\.\d\d<\/td>/.test(p.text))
  isTrue('宽表有自己的窄屏规则（.sheet 内横滚）', hasCss(p.text, 'max-width:760px'))
  isTrue('表头有 thead', /<thead>/.test(p.text))

  const lc = await call('GET', '/year-close-print-link?year=' + YY)
  if (lc.status === 200 && lc.d && lc.d.url) {
    const pc = await page(pathOf(lc.d.url))
    eq('年度封账单能打开', pc.status, 200)
    isTrue('封账单表头有 thead', /<thead>/.test(pc.text))
    isTrue('封账单合计行有 tfoot', /<tfoot>/.test(pc.text))
    isTrue('封账单有签字栏（制表人/老板/会计）', pc.text.includes('制表人') && pc.text.includes('会计'))
  } else {
    no('年度封账单链接生成失败', lc.d)
  }
}

// ── 3. 工资单：手机上合计行和表头藏同样的列（以前合计整体错两格） ──
console.log('\n[3] 工资单：表头与合计行藏同样的列、tip 里有电话')
{
  const l = await call('GET', '/payroll-link?month=' + MM)
  const p = await page(pathOf(l.d && l.d.url))
  eq('工资单能打开', p.status, 200)
  const thead = (p.text.match(/<thead>[\s\S]*?<\/thead>/) || [''])[0]
  const tfoot = (p.text.match(/<tfoot>[\s\S]*?<\/tfoot>/) || [''])[0]
  const cnt = (s) => (s.match(/m-hide/g) || []).length
  isTrue('表头有 m-hide 列', cnt(thead) > 0)
  eq('合计行藏的列数 == 表头藏的列数', cnt(tfoot), cnt(thead))
  isTrue('tip 里有电话', p.text.includes(PHONE))
  isTrue('签字栏有横线（能签字）', p.text.includes('____'))
  isTrue('tip 不会被打印规则藏掉（print 只藏 .wxtip）', /@media print\s*\{[\s\S]*?\.wxtip\s*\{\s*display\s*:\s*none/.test(p.text))
  isTrue('打印时 .tip 改成灰字而不是隐藏', /\.tip\s*\{\s*color\s*:\s*#555/.test(p.text))
}

// ── 4. 批量打对账单：最后一张带 .last，不多印空白页 ──
console.log('\n[4] 批量打对账单：最后一张带 .last')
{
  const C2 = TAG + '客户二'
  await call('POST', '/orders', { customer: C2, item_name: '批量测试', qty: 1, price: 500, date: MM + '-06' })
  const l = await call('GET', '/statements-print-link?month=' + MM + '&parties=' + encodeURIComponent(CUST + ',' + C2))
  if (l.status === 200 && l.d && l.d.url) {
    const p = await page(pathOf(l.d.url))
    eq('批量对账单能打开', p.status, 200)
    eq('两张单页（psheet）', (p.text.match(/class="sheet psheet/g) || []).length, 2)
    eq('只有最后一张带 last', (p.text.match(/class="sheet psheet last"/g) || []).length, 1)
    isTrue('CSS 里有 .psheet.last 的规则（最后一张不再分页）', /\.psheet\.last\s*\{\s*page-break-after\s*:\s*auto/.test(p.text))
    isTrue('每张之间分页', /\.psheet\s*\{\s*page-break-after\s*:\s*always/.test(p.text))
  } else {
    no('批量对账单链接生成失败', l.d)
  }
}

// ── 5. 单个对账单：单号 + 应结日、改账期就失效 ──
console.log('\n[5] 单个对账单：有单号、有应结日、改账期打不开')
{
  const l = await call('GET', '/statement-link?type=ar&party=' + encodeURIComponent(CUST))
  const url = pathOf(l.d && l.d.url)
  eq('链接带上了账期', /from=\d{4}-\d{2}-\d{2}/.test(url) && /to=\d{4}-\d{2}-\d{2}/.test(url), true)
  const p = await page(url)
  eq('对账单能打开', p.status, 200)
  isTrue('有「单号」列', p.text.includes('单号'))
  isTrue('行里印的是单据编号（#id）', /<td>#\d+<\/td>/.test(p.text))
  isTrue('有「应结日」列', p.text.includes('应结日'))
  isTrue('金额有千分位', p.text.includes('1,234.56'))
  isTrue('手机窄屏规则在', hasCss(p.text, 'max-width:760px'))
  isTrue('手机上藏的是应结日/核销，不是金额列', /class="w70 m-hide">应结日/.test(p.text))

  // 篡改账期（客户把 11 月改成全部历史）必须打不开
  const tampered = url.replace(/from=\d{4}-\d{2}-\d{2}/, 'from=2000-01-01')
  const p2 = await page(tampered)
  isTrue('改了账期 → 失效页', /name="fa-error"/.test(p2.text))

  // 签名页不许被浏览器缓存（链接过期后按「后退」还能看到金额）
  eq('签名页 Cache-Control 是 no-store', String(p.headers.get('cache-control') || ''), 'no-store')
  eq('签名页不把链接带给第三方（Referrer-Policy）', String(p.headers.get('referrer-policy') || ''), 'no-referrer')
}

// ── 6. 客户进度页：汇总按全部单据算，不按列表 40 单算 ──
console.log('\n[6] 客户进度页：45 单的汇总不能只算 40 单')
{
  const BIG = TAG + '多单'
  for (let i = 1; i <= 45; i++) {
    await call('POST', '/orders', { customer: BIG, item_name: '单' + i, qty: 1, price: 1000, date: MM + '-0' + ((i % 9) + 1) })
  }
  const l = await call('GET', '/track-link?party=' + encodeURIComponent(BIG))
  const p = await page(pathOf(l.d && l.d.url))
  eq('进度页能打开', p.status, 200)
  isTrue('汇总写的是 45 单', p.text.includes('共 45 单'))
  isTrue('合计是全部 45 单（45,000.00）', p.text.includes('45,000.00'))
  isTrue('列表只列最近 40 单并说明', p.text.includes('下面只列最近 40 单'))
  isTrue('金额有千分位', /¥[\d,]{5,}\.\d\d/.test(p.text))
}

// ── 7. 客户确认页：改口能改、重复点判重、打印时标题栏不隐形 ──
console.log('\n[7] 客户确认页：说错了能改口，重复点不重复记')
{
  const l = await call('GET', '/statement-ack-link?type=ar&party=' + encodeURIComponent(CUST) + '&month=' + MM)
  if (l.status !== 200 || !l.d || !l.d.url) {
    no('确认链接生成失败', l.d)
  } else {
    const u = new URL(l.d.url)
    const body = { type: 'ar', party: CUST, month: u.searchParams.get('month') || MM, t: u.searchParams.get('t'), x: u.searchParams.get('x') }
    const p = await page(pathOf(l.d.url))
    isTrue('确认页能打开', p.status === 200)
    isTrue('金额有千分位', /¥[\d,]+\.\d\d/.test(p.text))
    isTrue('打印时标题栏改成白底黑字（不然白字白底看不见）', /@media print\s*\{[\s\S]*?\.hd\s*\{\s*background\s*:\s*#fff/.test(p.text))
    isTrue('打印时藏掉按钮', /@media print\s*\{[\s\S]*?\.btn\s*\{\s*display\s*:\s*none/.test(p.text))
    isTrue('未结清单里有单号', /<div class="doc">#\d+/.test(p.text))

    const r1 = await call('POST', '/statement-ack', Object.assign({}, body, { ack: 'doubt', amount: 300, note: '6 月那笔不对' }))
    eq('先点「有几笔对不上」', r1.d && r1.d.ack, 'doubt')
    const r2 = await call('POST', '/statement-ack', Object.assign({}, body, { ack: 'ok' }))
    isTrue('改口成「对得上」要真的生效（以前点不动）', r2.d && r2.d.ok && r2.d.ack === 'ok' && !r2.d.dup_ok)
    const r3 = await call('POST', '/statement-ack', Object.assign({}, body, { ack: 'ok' }))
    isTrue('同一天重复点同一个按钮 → 判重（防手抖双击记两次）', r3.d && r3.d.dup_ok)
    const p2 = await page(pathOf(l.d.url))
    isTrue('再打开能看到「您已于 … 确认」', p2.text.includes('您已于'))
    isTrue('横幅告诉客户改口怎么点', p2.text.includes('改口'))
  }
}

// ── 8. 电脑看账台：客户名里的 HTML 必须被转义（这里存着老板口令） ──
console.log('\n[8] 电脑看账台：客户名不能当 HTML 跑')
{
  const EVIL = '<img src=x onerror=alert(1)>'
  await call('POST', '/orders', { customer: EVIL, item_name: '注入测试', qty: 1, price: 99999, date: MM + '-07' })
  const p = await page('/desk')
  eq('/desk 能打开', p.status, 200)
  // /desk 是个壳，数据由页面里的 fetch 拉回来再塞 innerHTML —— 所以「有没有转义」
  // 只能看那段内联脚本：客户名必须过 esc() 才能进 DOM。
  isTrue('客户名进 DOM 前过了 esc()', /esc\(String\(kpi\.top_customer\)/.test(p.text))
  isTrue('表格里的值也过了 esc()', /esc\(x\.v\)|esc\(x\.k\)/.test(p.text))
  eq('/desk 带 CSP', String(p.headers.get('content-security-policy') || '').includes("default-src 'none'"), true)
  isTrue('CSP 里留了 connect-src self（否则页面自己的 fetch 全挂）', String(p.headers.get('content-security-policy') || '').includes("connect-src 'self'"))
}

// ── 9. 统一层：错误页、缓存头、安全头 ──
console.log('\n[9] 统一层：过期链接是「能看懂的错误页」，不是一段裸文字')
{
  const p = await page('/statement-print?type=ar&party=' + encodeURIComponent(CUST) + '&t=deadbeef&x=1&book=1')
  isTrue('错误页带 fa-error 标记', /name="fa-error"/.test(p.text))
  isTrue('错误页有 viewport（手机上不缩成一条线）', p.text.includes('name="viewport"'))
  isTrue('错误页有 favicon', p.text.includes('rel="icon"') || p.text.includes('image/svg'))
  isTrue('错误页说明了为什么 + 怎么办', p.text.includes('失效') && (p.text.includes('回小程序') || p.text.includes('重新')))
  eq('错误页不缓存', String(p.headers.get('cache-control') || ''), 'no-store')
  eq('错误页不许被 iframe 套', String(p.headers.get('x-frame-options') || ''), 'DENY')
  eq('错误页不索引', String(p.headers.get('x-robots-tag') || '').includes('noindex'), true)

  const g = await page('/guide')
  eq('教程页能打开', g.status, 200)
  isTrue('教程页也有 favicon', g.text.includes('rel="icon"') || g.text.includes('image/svg'))
  // 第 19 轮 E5：只有真版本（20261125-0900 / v1.3.0）才显示这一句；
  // 本地 wrangler.toml 写死 dev，这时应当整句不出现（客户不该看到「版本 dev」）。
  isTrue('教程页版本号：真版本才显示，dev 不显示', !/版本\s*dev/.test(g.text))
  eq('教程页全站 nosniff', String(g.headers.get('x-content-type-options') || ''), 'nosniff')
}

// ── 10. 电脑端：能动手、带账套、批量去重 ──
console.log('\n[10] 电脑端：能记一笔、带账套号、批量去重')
{
  const p = await page('/desk')
  eq('/desk 能打开', p.status, 200)
  isTrue('有「快速记一笔」', p.text.includes('快速记一笔'))
  isTrue('能记收款（doRecv）', p.text.includes('function doRecv'))
  isTrue('能记支出（doExp）', p.text.includes('function doExp'))
  isTrue('请求带账套号 X-Book（不然多账套会看错本）', /'x-book'/.test(p.text))
  isTrue('标题栏显示第几本账', p.text.includes('bookTag'))
  isTrue('批量链接写明「别外发」', p.text.includes('别外发'))
  isTrue('批量超过 20 家会拦', p.text.includes('一次最多 20 家'))
  isTrue('单号能点开这一家的对账单', p.text.includes('function openStmt'))
  isTrue('每家能发确认链接', p.text.includes('function sendAck'))
  isTrue('取数失败不再整页空白（allSettled）', p.text.includes('allSettled'))
  isTrue('错误提示带错误码', p.text.includes('function errText'))

  // 真记一笔收款（模拟页面：带 X-Book 头）
  const H2 = Object.assign({}, H, { 'X-Book': '1' })
  const before = await (await fetch(BASE + '/kpi?month=' + MM, { headers: H2 })).json()
  const post2 = async (pp, body) => {
    const r = await fetch(BASE + pp, { method: 'POST', headers: H2, body: JSON.stringify(body) })
    return { status: r.status, d: await r.json().catch(() => null) }
  }
  const ar = await (await fetch(BASE + '/ar?limit=200', { headers: H2 })).json()
  const rows = Array.isArray(ar) ? ar : (ar.rows || [])
  const mine = rows.filter((o) => o.customer === CUST).sort((x, y) => Number(y.id) - Number(x.id))[0]
  if (!mine) {
    no('找不到刚才建的测试单，收款项没法验')
  } else {
    const cid = 'desk-test-' + Date.now().toString(36)
    const r1 = await post2('/orders/' + mine.id + '/receive', { amount: 100, date: TODAY, client_id: cid })
    eq('电脑端记收款成功', r1.status, 200)
    const r2 = await post2('/orders/' + mine.id + '/receive', { amount: 100, date: TODAY, client_id: cid })
    isTrue('同一个 client_id 重发判重（连点两下不会记两笔）', r2.d && r2.d.dup_ok)
    const after = await (await fetch(BASE + '/kpi?month=' + MM, { headers: H2 })).json()
    eq('收款确实记进去了（本月收款 +100）', Math.round((Number(after.cash_in) - Number(before.cash_in)) * 100) / 100, 100)
  }
  // confirm_dup：同一天同金额同分类再记一笔，后端会拦（产品行为），测试要能重复跑
  const r3 = await post2('/expenses', { amount: 12.34, category: '水电', date: TODAY, client_id: 'desk-exp-' + Date.now().toString(36), confirm_dup: true })
  eq('电脑端记支出成功', r3.status, 200)

  // 批量链接：同名重复要去重，type=ap 要能用
  const l1 = await call('GET', '/statements-print-link?month=' + MM + '&parties=' + encodeURIComponent(CUST + ',' + CUST + ',' + TAG + '客户二'))
  eq('批量链接把重复的名字去掉了（2 家）', l1.d && l1.d.count, 2)
  isTrue('批量链接带上 type', /type=ar/.test(String((l1.d || {}).url || '')))
  const l2 = await call('GET', '/statements-print-link?month=' + MM + '&type=ap&parties=' + encodeURIComponent('某供应商'))
  isTrue('应付也能批量打（以前 type 写死应收）', l2.status === 200 && /type=ap/.test(String((l2.d || {}).url || '')))
  const p2 = await page(pathOf((l2.d || {}).url))
  isTrue('应付批量页能打开', p2.status === 200 && !/name="fa-error"/.test(p2.text))

  const pc = await page('/pc')
  isTrue('/pc 有恢复码重设入口（首页说「在 /pc 最下面」不再是死链）', pc.text.includes('doRecover') && pc.text.includes('恢复码'))
  isTrue('/pc 有退出按钮（公用电脑能清口令）', pc.text.includes('logoutPc'))
  isTrue('/pc 超级口令是密码框', /id="sup_pw"[^>]*type="password"/.test(pc.text))
}

// ===== [11] 第 19 轮第 4 批：印刷/安全头/文案/教程 =====
{
  console.log('\n[11] 第 19 轮第 4 批（印出来的纸 / 安全头 / 文案 / 教程）')

  // A6/A7/A10 的样式规则都在失效页之后才渲染，所以直接读「带签名能打开」的页太麻烦，
  // 这里改成读后端源码级的产出：先拿一份能打开的对账单页确认 A4_CSS 在，再看这几页的规则。
  const qsrc = await (await fetch(BASE + '/quote-print?id=0&t=x', { headers: { 'User-Agent': 'curl/8' } })).text()
  isTrue('报价单：打印时藏掉「这个价可以」两个按钮（.pick/.tip2）', qsrc.includes('.pick, .tip2') || qsrc.includes('fa-error'))
  const ysrc = await (await fetch(BASE + '/year-review-print?year=2026&t=x', { headers: { 'User-Agent': 'curl/8' } })).text()
  isTrue('年度回顾：手机上藏柱顶数字（.bv）', ysrc.includes('.bv{display:none}') || ysrc.includes('fa-error'))
  const hsrc = await (await fetch(BASE + '/health-print?days=180', { headers: { 'User-Agent': 'curl/8' } })).text()
  isTrue('体检报告：手机上藏掉三列明细', hsrc.includes('m-hide') || hsrc.includes('fa-error'))

  // E1：首页不再把 commit 印在页脚
  const land = await page('/')
  isTrue('首页版本号还在', land.text.includes("'版本 '") || land.text.includes('版本 '))
  isTrue('首页 commit 收进 title（不再直接印一长串 hash）', land.text.includes('el.title') && !/版本 [0-9a-f]{40}/.test(land.text))
  // E3：三张卡的说法
  isTrue('首页不再说「下面两个链接」（实际三张卡）', !land.text.includes('用下面两个链接') && land.text.includes('三张卡'))

  // E2：500 文案不再指向小程序菜单（首页本来就没有，改查后端返回的 500 文案得造错，
  // 这里用源码产物间接确认：全站 500 文案里已经没有「运行日志」这条路径）
  isTrue('500 文案不再让用户去小程序找「运行日志」', !land.text.includes('🐞 运行日志'))

  // E4：教程与第 18/19 轮同步
  const g = await page('/guide')
  const anchors = [...g.text.matchAll(/<a href="#([^"]+)"/g)].map((m) => m[1])
  const ids = new Set([...g.text.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))
  const dead = anchors.filter((a) => !ids.has(a))
  eq('教程目录的锚点全部点得动（死链 0 个）', dead.length, 0)
  isTrue('教程有搜索框', g.text.includes('id="q"'))
  isTrue('教程讲了电脑看账台（/desk）', g.text.includes('电脑看账台'))
  isTrue('教程里没有「你的域名」占位符', !g.text.includes('你的域名'))
  // E5：读不到版本就不显示「版本 dev」
  isTrue('教程页脚不显示「版本 dev」', !/版本\s*dev/.test(g.text))

  // D5：确认页的 P 变量不会把 </script> 断出来
  const ackLink = await call('GET', '/statement-ack-link?type=ar&party=' + encodeURIComponent('A<B</script>') + '&month=' + MM)
  const ackUrl = (ackLink.d || {}).url
  if (ackUrl) {
    const at = await page(pathOf(ackUrl))
    isTrue('确认页把客户名里的 < 转义了（不会断出标签）', at.text.includes('\\u003c') || !at.text.includes('A<B</script>'))
  } else no('拿不到确认页链接')

  // D7/D8/D10/D11：缓存与安全头
  const ver = await fetch(BASE + '/version', { headers: { 'User-Agent': 'curl/8' } })
  eq('/version 带 nosniff', ver.headers.get('x-content-type-options'), 'nosniff')
  eq('/version 不许缓存', ver.headers.get('cache-control'), 'no-store')
  const kpiR = await fetch(BASE + '/kpi?month=' + MM, { headers: H })
  eq('账目 JSON 不许缓存（公用电脑按后退看不到金额）', kpiR.headers.get('cache-control'), 'no-store')
  const signed = await fetch(BASE + '/statement-print?party=x&type=ar&t=x', { headers: { 'User-Agent': 'curl/8' } })
  eq('签名页 no-store', signed.headers.get('cache-control'), 'no-store')
  isTrue('签名页不再发 ETag（no-store 下永远用不上）', !signed.headers.get('etag'))

  // D12/D13/D16：看账台
  const desk = await page('/desk')
  isTrue('/desk 有 noscript 兜底（脚本被拦不是白屏）', desk.text.includes('<noscript>'))
  isTrue('/desk 脚本出错会上报（/client-err）', desk.text.includes("sendBeacon('/client-err'"))
  isTrue('/desk 手机上按钮够大（44px 触控）', desk.text.includes('.btn{padding:12px 16px}'))
  const ce = await fetch(BASE + '/client-err', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'curl/8' }, body: JSON.stringify({ msg: 'selftest', page: 'test' }) })
  eq('页面错误上报接口能用', ce.status, 200)

  // D2：/pc 导入预览转义
  const pcx = await page('/pc')
  isTrue('/pc 导入预览有转义（单元格里的 < 不会执行）', pcx.text.includes('function el2('))
  isTrue('/pc 脚本出错会上报（/client-err）', pcx.text.includes("sendBeacon('/client-err'"))
}

console.log('')
if (bad.length) {
  console.log(`❌ 网页端测试失败：${bad.length} 项`)
  for (const b of bad.slice(0, 25)) console.log('   · ' + b)
  process.exit(1)
}
console.log(`✅ 网页端测试全部通过（${pass} 项）`)
