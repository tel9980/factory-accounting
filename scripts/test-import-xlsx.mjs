// Excel 导入回归测试（按对账金额导应收/应付、付房东的待摊、押金）
//
// 为什么要有这个：这家厂的实际用法是「一个月一家一条」——应收按客户对账金额、应付按供应商
// 和外发的对账金额、房东的租金押金水电按月付。这三条都是 Excel 进去的，导错了不会报错，
// 只是账目悄悄少一笔或者金额归零。
//
// 还专门钉一个老坑：以前读 xlsx 不看单元格格式，见到 20000~60000 的数字就当 Excel 日期序号，
// 于是「押金 20000」被读成 1954-09-13、「应付 30000」直接变空被丢掉——金额正好在 2 万~6 万
// 的文件全中招。现在只有带日期格式的单元格才转日期。
//
// 断言：
//   1. 三个新模板（应收对账/应付对账/付房东）都能下载
//   2. Excel 应收对账：一家一条、记在月末、备注进 item_name
//   3. Excel 应付对账：分类认得出来（外发加工费），/ap-by-category 能汇总
//   4. Excel 付房东：租金按月摊、押金月数 0 不摊
//   5. 金额 30000 / 押金 20000 不会被当成日期吞掉
//   6. 带日期格式的序号（46000）才转成 2025-12-31
//   7. 同一份应收对账再导一次被拦（同客户同月同金额）
//
// 用法：node scripts/test-import-xlsx.mjs [--base http://127.0.0.1:8791] [--key 8888]

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const BASE = arg('base', 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = arg('key', '8888')
const H = { 'X-Access-Key': KEY, 'Content-Type': 'application/json' }

// 名字带随机后缀：应收对账有「同客户同月同金额」防重，重复跑要能再记一遍。
const TAG = 'xlsx' + Date.now().toString(36).replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]).slice(-4)

let pass = 0
const bad = []
const ok = (msg) => { pass++; console.log('  ✅ ' + msg) }
const no = (msg, detail) => { bad.push(msg); console.log('  ❌ ' + msg + (detail === undefined ? '' : ' → ' + JSON.stringify(detail))) }
const eq = (label, got, want) => (String(got) === String(want) ? ok(`${label} = ${want}`) : no(`${label} 应为 ${want}`, got))

const call = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) })
  let d = null
  try { d = await r.json() } catch (e) { d = null }
  return { status: r.status, d }
}

// ===== 极简 xlsx 生成器（stored 不压缩 + inlineStr，够本项目读文件用）=====
const sheetXml = (rows) => {
  const col = (i) => String.fromCharCode(65 + i)
  const body = rows.map((row, ri) => `<row r="${ri + 1}">${row.map((c, ci) => {
    const ref = col(ci) + (ri + 1)
    if (c == null || c === '') return ''
    if (typeof c === 'object') return `<c r="${ref}" s="${c.s}"><v>${c.v}</v></c>`
    if (typeof c === 'number') return `<c r="${ref}"><v>${c}</v></c>`
    return `<c r="${ref}" t="inlineStr"><is><t>${String(c).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></is></c>`
  }).join('')}</row>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
}
// xf 0 = 常规，xf 1 = 内置日期格式（numFmtId 14）
const STYLES = '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>'
const zip = (entries) => {
  const enc = new TextEncoder()
  const locals = []
  const centrals = []
  let off = 0
  for (const e of entries) {
    const name = enc.encode(e.name)
    const data = enc.encode(e.data)
    const lh = new Uint8Array(30 + name.length)
    const dv = new DataView(lh.buffer)
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true); dv.setUint16(26, name.length, true)
    lh.set(name, 30)
    locals.push(lh, data)
    const ch = new Uint8Array(46 + name.length)
    const cv = new DataView(ch.buffer)
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, name.length, true); cv.setUint32(42, off, true)
    ch.set(name, 46)
    centrals.push(ch)
    off += 30 + name.length + data.length
  }
  const csize = centrals.reduce((a, x) => a + x.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true); ev.setUint32(12, csize, true); ev.setUint32(16, off, true)
  const all = [...locals, ...centrals, eocd]
  const out = new Uint8Array(all.reduce((a, x) => a + x.length, 0))
  let p = 0
  for (const x of all) { out.set(x, p); p += x.length }
  return out
}
const mk = (rows, withStyles) => Buffer.from(zip([
  { name: 'xl/worksheets/sheet1.xml', data: sheetXml(rows) },
  ...(withStyles ? [{ name: 'xl/styles.xml', data: STYLES }] : []),
  { name: 'xl/workbook.xml', data: '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="导入" sheetId="1"/></sheets></workbook>' }
])).toString('base64')

const main = async () => {
  console.log('Excel 导入：按对账金额 / 付房东 / 金额不被当日期')

  // 1. 三个模板
  for (const [t, name] of [['ar_recon', '应收对账导入模板（按客户对账金额）.xlsx'], ['ap_recon', '应付对账导入模板（按供应商/外发对账金额）.xlsx'], ['prepaid', '房东预付模板（租金/押金/水电）.xlsx']]) {
    const r = await call('GET', '/import-template-xlsx?type=' + t)
    eq(`模板 ${t} 下载`, r.status, 200)
    eq(`模板 ${t} 文件名`, (r.d && r.d.name) || '', name)
    if (!(r.d && r.d.b64 && r.d.b64.length > 500)) no(`模板 ${t} 内容为空`, r.d && r.d.b64 ? r.d.b64.length : 0)
    else ok(`模板 ${t} 内容 ${r.d.b64.length} 字节`)
  }

  // 2. 应收对账：一家一条、记月末、备注进 item_name
  const arB = mk([
    ['客户', '对账金额', '月份', '备注'],
    [TAG + '客户甲', 5000, '2026-09', ''],
    [TAG + '客户乙', 3000, '', '老账']
  ])
  const arIm = await call('POST', '/import-xlsx', { type: 'ar_recon', b64: arB })
  eq('应收对账导入条数', arIm.d && arIm.d.imported, 2)
  eq('应收对账导入合计', arIm.d && arIm.d.total, 8000)
  const arList = await call('GET', '/ar')
  const a1 = (Array.isArray(arList.d) ? arList.d : []).find((x) => x.customer === TAG + '客户甲')
  const a2 = (Array.isArray(arList.d) ? arList.d : []).find((x) => x.customer === TAG + '客户乙')
  eq('月份列记到月末', a1 && String(a1.created_at).slice(0, 10), '2026-09-30')
  eq('没写月份记到本月', a2 && String(a2.created_at).slice(0, 7), new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7))
  eq('备注进 item_name', a2 && a2.item_name, '老账')
  eq('没备注用默认名', a1 && a1.item_name, '月度对账')

  // 同一份再导一次：同客户同月同金额被拦（不能翻倍）
  const arIm2 = await call('POST', '/import-xlsx', { type: 'ar_recon', b64: arB })
  eq('重复导被拦（导入 0 条）', arIm2.d && arIm2.d.imported, 0)
  eq('重复导有提示', arIm2.d && arIm2.d.dup_count, 2)

  // 3. 应付对账：分类认得出来
  const apB = mk([
    ['供应商', '对账金额', '分类', '月份', '备注'],
    [TAG + '外协厂', 9000, '外发加工费', '2026-11', ''],
    [TAG + '化工店', 2200, '硫酸', '', '']
  ])
  const apIm = await call('POST', '/import-xlsx', { type: 'ap_recon', b64: apB })
  eq('应付对账导入条数', apIm.d && apIm.d.imported, 2)
  eq('应付对账导入合计', apIm.d && apIm.d.total, 11200)
  const cat = await call('GET', '/ap-by-category?month=2026-11')
  const cOut = ((cat.d && cat.d.rows) || []).find((x) => x.cat === '外发加工费')
  if (!(cOut && cOut.month_add >= 9000)) no('外发加工费没汇总到', cOut)
  else ok(`外发加工费本月 ${cOut.month_add}`)

  // 4. 付房东：租金按月摊、押金不摊
  const ppB = mk([
    ['名称', '金额', '月数', '分类', '起始日', '备注'],
    [TAG + '宿舍租金', 3000, 2, '宿舍租金', '2026-12-01', ''],
    [TAG + '厂房押金', 20000, 0, '押金', '2026-12-01', '退租收回']
  ])
  const ppIm = await call('POST', '/import-xlsx', { type: 'prepaid', b64: ppB })
  eq('付房东导入条数', ppIm.d && ppIm.d.imported, 2)
  eq('付房东导入合计', ppIm.d && ppIm.d.total, 23000)
  const pps = await call('GET', '/prepaids')
  const rent = ((pps.d && pps.d.prepaids) || []).find((x) => x.name === TAG + '宿舍租金')
  const dep = ((pps.d && pps.d.prepaids) || []).find((x) => x.name === TAG + '厂房押金')
  eq('租金每月摊', rent && rent.per_month, 1500)
  eq('租金起始日', rent && rent.start_date, '2026-12-01')
  eq('押金不摊', dep && dep.per_month, 0)
  eq('押金标记', dep && dep.deposit, true)
  eq('押金本金留着', dep && dep.remain, 20000)

  // 5. 金额 30000 不能被当成 Excel 日期（老坑）
  const bigB = mk([
    ['客户', '对账金额', '月份', '备注'],
    [TAG + '大额客户', 30000, '2026-08', '']
  ])
  const bigIm = await call('POST', '/import-xlsx', { type: 'ar_recon', b64: bigB })
  eq('大额对账导入条数', bigIm.d && bigIm.d.imported, 1)
  eq('大额对账金额没被吞', bigIm.d && bigIm.d.total, 30000)

  // 6. 带日期格式的序号才转日期
  const dtB = mk([
    ['客户', '对账金额', '月份', '备注'],
    [TAG + '日期客户', 1000, { s: 1, v: 46000 }, '']
  ], true)
  const dtIm = await call('POST', '/import-xlsx', { type: 'ar_recon', b64: dtB })
  eq('日期格式序号导入', dtIm.d && dtIm.d.imported, 1)
  const arList2 = await call('GET', '/ar')
  const dtRow = (Array.isArray(arList2.d) ? arList2.d : []).find((x) => x.customer === TAG + '日期客户')
  // Excel 序号 46000 = 2025-12-09（1899-12-30 起算）；关键是「按日期格式转、不是当金额」
  eq('日期序号 46000 → 2025-12-09', dtRow && String(dtRow.created_at).slice(0, 10), '2025-12-09')

  // 7. 账本自检
  const sc = await call('GET', '/selfcheck')
  eq('账本自检 ok', sc.d && sc.d.ok, true)

  console.log(bad.length ? `\n❌ ${bad.length} 项失败（通过 ${pass} 项）` : `\n✅ 全部通过（${pass} 项）`)
  process.exit(bad.length ? 1 : 0)
}
main().catch((e) => { console.error('跑挂了：', e); process.exit(1) })
