// 应收分类回归测试（钱是从哪来的：货款 / 加工费 / 打样费 / 模具费 / 运费代垫…）
//
// 为什么要有这个：应付分类回答「钱花在哪」，应收分类回答「钱从哪来」。
// 分类错了不会报错，只是报表上「加工费收了多少」永远算不出来，全归到「未分类」。
// 这家的实际情况是：既有卖货（货款），也有来料加工（加工费），还有打样、开模、代垫运费。
//
// 断言：
//   1. 应收对账模板第 5 列是「分类」，并且带下拉
//   2. 两个模板包（开账全套 / 日常台账）的「应收对账」页签表头都带分类列
//   3. 粘贴「客户 加工费 12000」→ 分类记上、金额不串位
//   4. 老格式「客户 12800」→ 金额对、分类空（加一列不能把老文件导坏）
//   5. 宽松写法：加工费(含打样) / 打样费 / 代垫运费 都能归到标准分类
//   6. 手工建单带分类 → /ar 列表返回 ar_cat，能按分类筛
//   7. 改单改分类 → PATCH 回 changed
//   8. /ar-by-category：本月开单、本月已收、还欠三项对得上
//
// 用法：node scripts/test-arcat.mjs [--base http://127.0.0.1:8791] [--key 8888]

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const BASE = arg('base', 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = arg('key', '8888')
const H = { 'X-Access-Key': KEY, 'Content-Type': 'application/json' }

// 客户名带随机字母后缀：/orders 会按「同客户同金额」提醒，名字里混数字又会被粘贴解析当金额
const TAG = '应收分类' + Date.now().toString(36).replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]).slice(-4)
const THIS_M = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7)

let pass = 0
const bad = []
const ok = (msg) => { pass++; console.log('  ✅ ' + msg) }
const no = (msg, detail) => { bad.push(msg); console.log('  ❌ ' + msg + (detail === undefined ? '' : ' → ' + JSON.stringify(detail))) }
const eq = (label, got, want) => (String(got) === String(want) ? ok(`${label} = ${want}`) : no(`${label} 应为 ${want}`, got))

const call = async (method, p, body, hdr) => {
  const r = await fetch(BASE + p, { method, headers: Object.assign({}, H, hdr || {}), body: body === undefined ? undefined : JSON.stringify(body) })
  let d = null
  try { d = await r.json() } catch (e) { d = null }
  return { status: r.status, d }
}
const arRows = async (q) => {
  const r = await call('GET', '/ar?status=all&limit=200' + (q || ''))
  return Array.isArray(r.d) ? r.d : []
}

const main = async () => {
  console.log('应收分类（货款 / 加工费 / 打样费…）')

  // 1. 模板：分类在第 5 列，带下拉
  const tpl = await call('GET', '/import-template-xlsx?type=ar_recon')
  eq('应收对账模板能下载', tpl.status, 200)
  eq('模板带分类下拉', !!(tpl.d && tpl.d.dv), true)
  eq('模板名', (tpl.d && tpl.d.name) || '', '应收对账导入模板（按客户对账金额）.xlsx')

  // 2. 模板包的两个页签都带分类列
  // 开账全套是「建账那一刻」用的（期初），日常台账才是天天用的对账页
  const pkOpen = await call('GET', '/import-template-pack?tpl=open&fill=1')
  eq('开账包能下（带预填）', pkOpen.status, 200)
  eq('开账包 8 个页签', ((pkOpen.d && pkOpen.d.sheets) || []).length, 8)
  const pkDaily = await call('GET', '/import-template-pack?tpl=daily&fill=1')
  eq('日常台账包能下（带预填）', pkDaily.status, 200)
  const sheet = ((pkDaily.d && pkDaily.d.sheets) || []).find((x) => x.type === 'ar_recon')
  eq('日常台账有应收对账页', !!sheet, true)

  // 3. 粘贴：客户 加工费 12000
  const newText = `${TAG}甲 加工费 12000\n${TAG}乙 打样费 800`
  const pv = await call('POST', '/parse-import', { type: 'ar_recon', text: newText })
  eq('预览认出行数', (pv.d && pv.d.count) || 0, 2)
  eq('第 1 行分类', (pv.d && pv.d.rows && pv.d.rows[0] && pv.d.rows[0].category) || '', '加工费')
  eq('第 1 行金额', (pv.d && pv.d.rows && pv.d.rows[0] && pv.d.rows[0].amount) || 0, 12000)
  eq('第 2 行分类', (pv.d && pv.d.rows && pv.d.rows[1] && pv.d.rows[1].category) || '', '打样费')

  const im = await call('POST', '/import-rows', { type: 'ar_recon', text: newText })
  eq('入账行数', (im.d && im.d.imported) || 0, 2)
  const r1 = await arRows('&kw=' + encodeURIComponent(TAG + '甲'))
  eq('落库分类 = 加工费', (r1[0] && r1[0].ar_cat) || '', '加工费')
  eq('落库金额 = 12000', (r1[0] && r1[0].price) || 0, 12000)

  // 4. 老格式：客户 12800（没有分类）
  const oldText = `${TAG}老客户 5600`
  const pvOld = await call('POST', '/parse-import', { type: 'ar_recon', text: oldText })
  eq('老格式金额', (pvOld.d && pvOld.d.rows && pvOld.d.rows[0] && pvOld.d.rows[0].amount) || 0, 5600)
  eq('老格式分类为空', (pvOld.d && pvOld.d.rows && pvOld.d.rows[0] && pvOld.d.rows[0].category) || '', '')
  const imOld = await call('POST', '/import-rows', { type: 'ar_recon', text: oldText })
  eq('老格式入账', (imOld.d && imOld.d.imported) || 0, 1)

  // 5. 宽松写法
  const loose = await call('POST', '/parse-import', { type: 'ar_recon', text: `${TAG}丙 加工费(含打样) 100\n${TAG}丁 代垫运费 200\n${TAG}戊 货款 300` })
  const lr = (loose.d && loose.d.rows) || []
  eq('「加工费(含打样)」归到加工费', (lr[0] && lr[0].category) || '', '加工费')
  eq('「代垫运费」归到运费代垫', (lr[1] && lr[1].category) || '', '运费代垫')
  eq('「货款」就是货款', (lr[2] && lr[2].category) || '', '货款')
  eq('「代垫运费」金额没串位', (lr[1] && lr[1].amount) || 0, 200)

  // 6. 手工建单带分类
  const add = await call('POST', '/orders', { customer: TAG + '手工客户', item_name: '模具', price: 3000, ar_cat: '模具费', client_id: 'arcat' + Date.now() })
  eq('建单成功', add.status, 200)
  const oid = (add.d && (add.d.id || (add.d.order && add.d.order.id))) || 0
  const r2 = await arRows('&kw=' + encodeURIComponent(TAG + '手工客户'))
  eq('手工单 ar_cat = 模具费', (r2[0] && r2[0].ar_cat) || '', '模具费')
  const id2 = oid || (r2[0] && r2[0].id)

  // 7. 改分类
  const pt = await call('PATCH', '/orders/' + id2, { ar_cat: '加工费', rev: r2[0] && r2[0].rev })
  eq('改分类 200', pt.status, 200)
  eq('返回 changed 里提到分类', /分类/.test(String((pt.d && pt.d.changed) || '')), true)
  const r3 = await arRows('&kw=' + encodeURIComponent(TAG + '手工客户'))
  eq('改完是加工费', (r3[0] && r3[0].ar_cat) || '', '加工费')

  // 8. 按分类筛
  const f1 = await arRows('&cat=' + encodeURIComponent('打样费') + '&kw=' + encodeURIComponent(TAG))
  eq('按打样费筛，全是打样费', f1.length > 0 && f1.every((x) => x.ar_cat === '打样费'), true)
  const f2 = await arRows('&cat=' + encodeURIComponent('模具费') + '&kw=' + encodeURIComponent(TAG))
  eq('筛模具费时原来那张不再出现', f2.some((x) => String(x.id) === String(id2)), false)

  // 9. 汇总
  const sum = await call('GET', '/ar-by-category?month=' + THIS_M)
  eq('分类汇总状态', sum.status, 200)
  const rows = (sum.d && sum.d.rows) || []
  const jg = rows.find((x) => x.cat === '加工费')
  eq('汇总里有加工费', !!jg, true)
  eq('加工费本月开单 ≥ 12000', (jg && jg.month_add) >= 12000, true)
  eq('汇总合计 > 0', (sum.d && sum.d.total_add) > 0, true)
  eq('汇总带标准名单', Array.isArray(sum.d && sum.d.cats) && (sum.d.cats || []).includes('打样费'), true)
  console.log('  汇总文案：' + ((sum.d && sum.d.text) || ''))

  // 10. 备份恢复别把分类弄丢（restoreCore 的 INSERT 列清单里少一列就静默丢）
  const bk = await call('POST', '/cloud-backup', {})
  eq('备份一份', bk.status, 200)
  const bid = (bk.d && bk.d.id) || 0
  const rs = await call('POST', '/backup-restore', { id: bid, confirm: 1 })
  eq('恢复备份', rs.status, 200)
  const r4 = await arRows('&kw=' + encodeURIComponent(TAG + '手工客户'))
  eq('恢复后分类还在', (r4[0] && r4[0].ar_cat) || '', '加工费')

  console.log('')
  if (bad.length) {
    console.log(`❌ 应收分类：${pass} 项通过，${bad.length} 项失败`)
    for (const b of bad) console.log('   · ' + b)
    process.exit(1)
  }
  console.log(`✅ 应收分类：${pass} 项全部通过`)
}

main().catch((e) => { console.error('❌ 跑挂了：' + (e && e.stack || e)); process.exit(1) })
