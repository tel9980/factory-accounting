// 第一刀修的那几条（会算错钱 / 会静默失效 / 每天多点几下）的回归测试
//
// 这一批共同点是「以前错得很安静」：
//   1. 一句话记账写「收张老板5000」，系统建的是**新开一张应收单** —— 客户欠款反而多一笔，
//      而提示语就叫「应收 张老板 5000 元」，看着像收到钱了。
//   2. 导入表里没写日期 → 全记成今天；补录上个月的纸质单会整批记错月，而且「已结账的月份」
//      那道锁也判不出来（锁是按认到的日期判的）。预览以前完全不说这件事。
//   3. 预收/预付的月结锁看「今天」不看单据日期：12 月打开账能往 11 月塞预收款。
//   4. 银行账单换个导出区间再导一次（9/1–10/31 之后导 9/1–11/30），重叠的 9 月会再来一遍：
//      流水翻倍，认领两次就是两倍收款。以前只拦「同一个文件」。
//   5. 统计算出错会被当成「就是 0」：200 正常返回、error_log 一条没有；前端也从没读过 degraded。
//   6. 出 500 只记路径，同一路径挂着 8 个写接口，判断不出是哪一笔。
//
// 前 5 条都只改后端，最后一条顺带在 /error-log 上加了筛选和分页。
//
// 用法：node scripts/test-fixes1.mjs [--base http://127.0.0.1:9401] [--key 8888]

import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const BASE = arg('base', 'http://127.0.0.1:9401').replace(/\/$/, '')
const KEY = arg('key', '8888')
const H = { 'X-Access-Key': KEY, 'Content-Type': 'application/json' }

let pass = 0
const bad = []
const ok = (msg) => { pass++; console.log('  ✅ ' + msg) }
const no = (msg, detail) => { bad.push(msg); console.log('  ❌ ' + msg + (detail === undefined ? '' : ' → ' + JSON.stringify(detail))) }
const eq = (label, got, want) => (String(got) === String(want) ? ok(`${label} = ${want}`) : no(`${label} 应为 ${want}`, got))
const near = (label, got, want, tol = 0.02) => (Math.abs(Number(got) - Number(want)) <= tol ? ok(`${label} = ${want}`) : no(`${label} 应为 ${want}`, got))
const num0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const day = (back) => {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  d.setUTCDate(d.getUTCDate() - (back || 0))
  return d.toISOString().slice(0, 10)
}

const call = async (method, p, body, extra) => {
  const r = await fetch(BASE + p, {
    method,
    headers: Object.assign({}, H, extra || {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let d = null
  try { d = await r.json() } catch (e) { d = null }
  return { s: r.status, d }
}
const get = (p) => call('GET', p)
const post = (p, b, x) => call('POST', p, b === undefined ? {} : b, x)

// 客户欠多少（应收未收合计）
const owedOf = async (party) => {
  const r = await get('/party-balance?type=ar&party=' + encodeURIComponent(party))
  const d = (r.d && (r.d.balance !== undefined ? r.d : null)) || r.d || {}
  return num0(d.balance !== undefined ? d.balance : d.left !== undefined ? d.left : d.total_left)
}

const main = async () => {
  console.log('第一刀修复回归（' + BASE + '）')

  // ── 先看看这个库能不能用 ──
  const v = await get('/version')
  if (!v.d || !v.d.ok) { console.log('  ❌ 服务没起来：' + BASE); process.exit(1) }

  // ── 1. 一句话记账：说「收」是开单，不是收钱 ──
  console.log('\n[1] 一句话记账说「收」，不能被当成收到钱')
  // 注意：一句话记账会把数字当金额剥掉，客户名里千万别带数字（不然 name 被拆坏）
  const C1 = '甲测试客户甲乙丙'
  const q1 = await post('/quick', { text: '收' + C1 + '5000', client_id: 'q1' + Date.now() })
  eq('[1] 记账成功', q1.d && q1.d.ok, true)
  const sm = String((q1.d && q1.d.summary) || '')
  if (/新开一张应收单/.test(sm)) ok('[1] 说的是「新开一张应收单」：' + sm)
  else no('[1] summary 应该说清是开单', sm)
  if (/应收 /.test(sm) && !/新开/.test(sm)) no('[1] 还在用「应收 X Y 元」这种像收款的措辞', sm)
  const ow1 = await owedOf(C1)
  near('[1] 客户欠款是「多了一笔」而不是「少了一笔」', ow1, 5000)
  // 第二次（这个客户已经欠着钱）→ 必须带 warn 提醒「想记收款请点收钱」
  const q2 = await post('/quick', { text: '收' + C1 + '1200', client_id: 'q2' + Date.now() })
  const w2 = String((q2.d && q2.d.warn) || '')
  if (/原来还欠/.test(w2) && /收钱/.test(w2)) ok('[1] 已经欠着钱时会提醒怎么记收款')
  else no('[1] 第二次应该带 warn', w2)
  const ow2 = await owedOf(C1)
  near('[1] 欠款变成两笔相加', ow2, 6200)

  // ── 2. 导入没写日期 → 预览要报出来 ──
  console.log('\n[2] 导入行没写日期，预览要说「会记成今天」')
  // 期初应收：只有单位 + 金额，没有日期列 → 空日期
  const noDate = await post('/import', { type: 'ar_init', text: C1 + ',3000\n' + C1 + ',2000' })
  eq('[2] 期初应收导入成功', noDate.d && noDate.d.ok, true)
  // 用 dry 预览一份「支出」但只有金额/分类/备注 → 没有日期
  const pv = await post('/import-pack', { dry: true, b64: '' }) // 空包只为确认不炸
  eq('[2] 空包不该 500', pv.s < 500, true)
  // 直接调 previewImport 的等价路径：用 /import 的 type=expense 且不给日期
  const exNoDate = await post('/import', { type: 'expense', text: '999,水电,没写日期' })
  eq('[2] 没写日期的支出照样能导（不阻止，只提醒）', exNoDate.d && exNoDate.d.ok, true)

  // ── 3. 预收：月结锁按单据日期判 ──
  console.log('\n[3] 预收款往已结账的月份记，要拦住')
  const lastMonth = (() => {
    const d = new Date(Date.now() + 8 * 3600 * 1000)
    d.setUTCDate(1)
    d.setUTCMonth(d.getUTCMonth() - 1)
    return d.toISOString().slice(0, 7)
  })()
  await post('/month-lock', { month: lastMonth })
  const advLocked = await post('/advances', { type: 'in', party: C1, amount: 800, date: lastMonth + '-15', client_id: 'a' + Date.now() })
  if (advLocked.s === 403) ok('[3] 上个月已结账 → 403（' + lastMonth + '）')
  else no('[3] 应拦下，实际 ' + advLocked.s, advLocked.d && advLocked.d.error)
  const advToday = await post('/advances', { type: 'in', party: C1, amount: 800, client_id: 'b' + Date.now() })
  eq('[3] 不限日期（今天）照常能记', advToday.d && advToday.d.ok, true)
  await call('DELETE', '/month-lock/' + lastMonth)

  // ── 4. 银行账单：换区间重导不翻倍 ──
  console.log('\n[4] 银行账单换导出区间重导，重叠部分不能再来一遍')
  const d1 = day(10), d2 = day(9)
  const tag = String(Date.now()).slice(-6)
  const A1m = 1111 + (Number(tag) % 90)
  const memoA = '张三货款' + tag
  const t1 = '日期,收/付,金额,摘要\n' + d1 + ',收,' + A1m + ',' + memoA + '\n' + d2 + ',付,222,电费' + tag
  const b1 = await post('/bank-import', { text: t1 })
  eq('[4] 第一次导入 2 笔', num0(b1.d && b1.d.imported), 2)
  // 同一个文件再导一次：文件指纹拦住
  const b2 = await post('/bank-import', { text: t1 })
  eq('[4] 同一份文件再导 → 导入 0 笔', num0(b2.d && b2.d.imported), 0)
  eq('[4] 同一份文件再导 → dup_file', b2.d && b2.d.dup_file, true)
  // 换个区间（多一行新流水）：重叠的两笔要跳过，只进新的那一笔
  const t2 = t1 + '\n' + day(8) + ',收,3333,李四货款' + tag
  const b3 = await post('/bank-import', { text: t2 })
  eq('[4] 换区间重导 → 只进新的 1 笔', num0(b3.d && b3.d.imported), 1)
  eq('[4] 换区间重导 → 跳过重复 2 笔', num0(b3.d && b3.d.dup_rows), 2)
  const flows = await get('/bank-flows?matched=0')
  const got = ((flows.d && flows.d.rows) || []).filter((x) => String(x.memo || '') === memoA)
  eq('[4] 库里「张三货款」只有一笔', got.length, 1)

  // ── 5. /error-log：能筛、能翻、带现场信息 ──
  console.log('\n[5] 出错的现场能查（ray / 参数 / 筛选 / 翻页）')
  const el = await get('/error-log?days=7')
  eq('[5] /error-log 能取', el.d && el.d.ok, true)
  const anyRow = ((el.d && el.d.rows) || [])[0]
  if (!anyRow) ok('[5] 这段时间没有错误（跳过字段检查）')
  else {
    if ('ray' in anyRow && 'ref' in anyRow && 'params' in anyRow) ok('[5] 每行带 ray/ref/params')
    else no('[5] 缺现场字段', Object.keys(anyRow))
  }
  const el2 = await get('/error-log?days=90&limit=5&offset=0')
  eq('[5] 天数能放到 90 天', el2.d && el2.d.days, 90)
  eq('[5] limit 生效', ((el2.d && el2.d.rows) || []).length <= 5, true)
  const el3 = await get('/error-log?status=500')
  eq('[5] 能只看 500', el3.d && el3.d.ok, true)
  const el4 = await get('/error-log?kw=zzz不可能匹配zzz')
  eq('[5] 关键字搜不到就是 0 条', num0(el4.d && el4.d.count), 0)
  // 故意制造一次 500：不存在的路径不会 500，用一个必炸的入参
  await post('/orders', { customer: '', item_name: '', price: 'x' })
  const el5 = await get('/error-log?status=500&limit=3')
  eq('[5] 500 过滤能跑', el5.d && el5.d.ok, true)

  // ── 6. 首页 degraded 有就返回（正常情况应为空） ──
  console.log('\n[6] 首页降级要能被看见（正常时为空）')
  const dash = await get('/dashboard')
  eq('[6] /dashboard 能取', dash.d && !dash.d.error, true)
  if (Array.isArray(dash.d.degraded)) ok('[6] 带 degraded 字段（' + dash.d.degraded.length + ' 块降级）')
  else no('[6] degraded 不是数组', dash.d && dash.d.degraded)

  // ── 7. 静态护栏：前端那几条只能靠读源码钉住 ──
  console.log('\n[7] 前端几条硬护栏（读源码断言）')
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const feJs = fs.readFileSync(path.join(root, 'frontend/pages/index/index.js'), 'utf8')
  const feWx = fs.readFileSync(path.join(root, 'frontend/pages/index/index.wxml'), 'utf8')
  const beJs = fs.readFileSync(path.join(root, 'backend/index.js'), 'utf8')
  const sch = fs.readFileSync(path.join(root, 'backend/schema.sql'), 'utf8')
  const must = (label, src, re) => (re.test(src) ? ok('[7] ' + label) : no('[7] 少了：' + label))
  // C14：两张现金卡不能共用一个 data 字段
  must('45 天现金流写进 cfl（不再抢 cf）', feJs, /setData\(\{ cfl: res\.data/)
  must('cf 不再被 /cashflow 覆盖', feJs, /const cf = this\.data\.cfl \|\| \{\}/)
  if (/setData\(\{ cf: res\.data \|\| null \}\)/.test(feJs)) no('[7] 还有地方把 /cashflow 写进 cf')
  else ok('[7] 没有残留的 cf 覆盖')
  // C15：逾期条点了要带筛选
  must('逾期条点了会切到逾期筛选', feJs, /jumpTodo\(\)[\s\S]{0,400}ar_filter: down\.f/)
  // C16：收款面板走 toAmount
  must('收款金额走 toAmount（认「1.2万」）', feJs, /const num2 = \(v\) => \{\s*const n = this\.toAmount\(v\)/)
  must('面板文案不再承诺「不填=一次结清」', feWx, /整笔点「收清/)
  // C17：三个主表单有 loading + 记上了
  must('_busy 助手在', feJs, /_busy\(label\)[\s\S]{0,400}showLoading/)
  eq('[7] 三处主表单都接了 _busy', (feJs.match(/this\._busy\('记着…'\)/g) || []).length, 3)
  if ((feJs.match(/title: '记上了'/g) || []).length >= 3) ok('[7] 三个主表单都有「记上了」')
  else no('[7] 「记上了」少于 3 处', (feJs.match(/title: '记上了'/g) || []).length)
  // C18：补记快键
  must('quickDate 处理器在', feJs, /quickDate\(e\) \{[\s\S]{0,300}setUTCDate/)
  // 应收/应付/支出/收款面板/记工 五个地方各 3 个日期快键
  eq('[7] 五个表单都有日期快键', (feWx.match(/bindtap="quickDate"/g) || []).length, 15)
  // C19：报表页进去就有数 + 月份快键
  must('进报表页就拉本月', feJs, /t === 'report'\) \{\s*this\.loadReportView\(\)/)
  must('报表月份有快键', feWx, /bindtap="pickRvMonth"/)
  // C20：/pc 的模板/预览/导入都带账套号
  eq('[7] /pc 四处导入相关请求都带 X-Book', (beJs.match(/import-(?:template-pack|template-xlsx|pack)'[^\n]*X-Book/g) || []).length + (beJs.match(/'x-access-key': K, 'X-Book': bk\(\) \}, body: JSON\.stringify\(\{ b64/g) || []).length, 4)
  // C23：首页欠款最多那行能点
  must('欠款最多那行可点', feWx, /class="topcust"[^>]*bindtap="topCustTap"/)
  // C24：主按钮不再 mini
  must('主记账按钮铺满一行', feWx, /class="btn btn-main" bindtap="addOrder"/)
  must('.btn-main 样式在', fs.readFileSync(path.join(root, 'frontend/pages/index/index.wxss'), 'utf8'), /\.btn-main \{ width: 100%/)
  // B11：手机上能一键初始化
  must('设置页有一键初始化入口', feWx, /bindtap="bookResetTap"/)
  must('要手打「清空」才真清', feJs, /!== '清空'\) return wx\.showToast\(\{ title: '没打「清空」/)
  // B12/B13：后端这几条
  must('降级会落 error_log', beJs, /function noteQuiet\(db, book\)/)
  must('首页调了 noteQuiet', beJs, /noteQuiet\(db, c\.env\.BOOK\)/)
  must('error_log 有 ray/ref/params', sch, /ray TEXT DEFAULT ''/)
  must('logError 记 ray', beJs, /const ray = \(c\.req\.header && c\.req\.header\('cf-ray'\)\)/)
  must('导入预览会给 no_date_count', beJs, /no_date_count: noDateCnt/)
  must('预收锁定按单据月份', beJs, /const aMonth = String\(normDate\(date\) \|\| now\(\)\)\.slice\(0, 7\)/)
  must('银行流水按「日期+收付+金额+摘要」查重', beJs, /银行流水·查重/)

  // 收尾：把测试造的客户清掉（它欠着 6200，留着会影响别的脚本的首页断言）
  const all = await get('/ar?kw=' + encodeURIComponent(C1) + '&status=open&limit=50')
  for (const o of (Array.isArray(all.d) ? all.d : (all.d && all.d.rows) || [])) {
    await call('DELETE', '/orders/' + o.id)
  }

  console.log('\n' + (bad.length ? '❌ ' + bad.length + ' 项没过（共 ' + (pass + bad.length) + '）' : '✅ 全过：' + pass + ' 项'))
  if (bad.length) { bad.forEach((b) => console.log('   - ' + b)); process.exit(1) }
}

main().catch((e) => { console.error('跑炸了：', e); process.exit(1) })
