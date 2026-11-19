// 模板包回归测试（开账全套 / 日常台账：一个工作簿多页签，一次传全导进去）
//
// 为什么要有这个：一个人的小财务，日常就是维护几个模板——新建账套填一本、日常维护一本。
// 这两个包如果导错了，不会报错，只是账目悄悄少几笔或者翻倍，所以逐条钉住：
//
//   1. 两个包都能下载，页签名对得上（页签名 = 这一页是什么账，改了就认不出来）
//   2. 开账全套：账户期初是「设」不是「加」，重复导不翻倍
//   3. 开账全套：默认账期、期初应收、期初应付、期初借支、期初借款都落到位
//   4. 期初借支 / 期初借款**不写现金流水**（钱是以前就借出去/借进来的，再记一次等于重复扣钱）
//   5. 日常台账：应收对账 / 应付对账 / 支出 / 借支→报销 / 付房东押金 一包全导
//   6. 同一个文件传两遍被拦（dup_file），改过内容照常导
//   7. 预览（dry）不写库
//
// 用法：node scripts/test-pack.mjs [--base http://127.0.0.1:8791] [--key 8888]

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const BASE = arg('base', 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = arg('key', '8888')
const H = { 'X-Access-Key': KEY, 'Content-Type': 'application/json' }

// 名字带随机后缀，测试可以在同一库反复跑（同一份内容第二次会被整包防重拦下）
const TAG = 'pk' + Date.now().toString(36).replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]).slice(-4)

let pass = 0
const bad = []
const ok = (msg) => { pass++; console.log('  ✅ ' + msg) }
const no = (msg, detail) => { bad.push(msg); console.log('  ❌ ' + msg + (detail === undefined ? '' : ' → ' + JSON.stringify(detail))) }
const eq = (label, got, want) => (String(got) === String(want) ? ok(`${label} = ${want}`) : no(`${label} 应为 ${want}`, got))
const num0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

const call = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) })
  let d = null
  try { d = await r.json() } catch (e) { d = null }
  return { status: r.status, d }
}

// ===== 极简多页签 xlsx 生成器（stored 不压缩 + inlineStr，够本项目读文件用）=====
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const sheetXml = (rows) => {
  const col = (i) => String.fromCharCode(65 + i)
  const body = rows.map((row, ri) => `<row r="${ri + 1}">${row.map((c, ci) => {
    const ref = col(ci) + (ri + 1)
    if (c == null || c === '') return ''
    if (typeof c === 'number') return `<c r="${ref}"><v>${c}</v></c>`
    return `<c r="${ref}" t="inlineStr"><is><t>${esc(c)}</t></is></c>`
  }).join('')}</row>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
}
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
// sheets: [{ name, rows }] —— 按数组顺序写进 workbook.xml，页签名就是导入时的类型依据
const mkPack = (sheets) => {
  const files = []
  const rels = []
  const wb = []
  sheets.forEach((sh, i) => {
    const n = i + 1
    files.push({ name: `xl/worksheets/sheet${n}.xml`, data: sheetXml(sh.rows) })
    rels.push(`<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`)
    wb.push(`<sheet name="${esc(sh.name)}" sheetId="${n}" r:id="rId${n}"/>`)
  })
  files.push({ name: 'xl/workbook.xml', data: `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${wb.join('')}</sheets></workbook>` })
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>` })
  return Buffer.from(zip(files)).toString('base64')
}

const ensureKey = async () => {
  const r = await call('POST', '/auth/setup', { key: KEY })
  if (r.status >= 500) throw new Error('设口令失败：' + JSON.stringify(r.d))
}

const main = async () => {
  console.log('模板包：开账全套 / 日常台账（一次传全导进去）')
  await ensureKey()

  // 1. 两个包都能下载，页签名对
  const wantOpen = ['说明', '账户期初', '默认账期', '期初应收', '期初应付', '期初借支', '期初借款']
  const wantDaily = ['说明', '应收对账', '应付对账', '支出', '借支', '报销', '付房东']
  let openSheets = []
  let dailySheets = []
  for (const [tpl, name, want] of [['open', '开账全套模板.xlsx', wantOpen], ['daily', '日常台账模板.xlsx', wantDaily]]) {
    const r = await call('GET', '/import-template-pack?tpl=' + tpl)
    eq(`${tpl} 包下载`, r.status, 200)
    eq(`${tpl} 包文件名`, (r.d && r.d.name) || '', name)
    const list = ((r.d && r.d.sheets) || []).map((x) => x.sheet)
    eq(`${tpl} 包页签名`, list.join('|'), want.join('|'))
    if (!(r.d && r.d.b64 && r.d.b64.length > 1000)) no(`${tpl} 包内容为空`, r.d && r.d.b64 ? r.d.b64.length : 0)
    else ok(`${tpl} 包内容 ${r.d.b64.length} 字节`)
    if (tpl === 'open') openSheets = list
    else dailySheets = list
  }

  // 1.5 服务器生成的包要能自己读回来（填好数据之前先验一遍：页签名认得出来、空页不报错）
  {
    const r = await call('GET', '/import-template-pack?tpl=open')
    const rt = await call('POST', '/import-pack', { b64: (r.d || {}).b64 || '', dry: true })
    eq('包能自己读回来（预览状态）', rt.status, 200)
    eq('包自己读回来认出的页数', ((rt.d && rt.d.sheets) || []).filter((x) => x.type).length, 6)
    eq('空页不报错（默认账期有 30 天）', ((rt.d && rt.d.sheets) || []).filter((x) => x.type && !x.empty && !x.error).length, 1)
  }

  // 2. 开账全套：填好整本传上去
  const base0 = await call('GET', '/accounts')
  const acc0 = ((base0.d || {}).accounts) || []
  const before = {
    accs: acc0.length,
    cashOpen: num0((acc0.find((x) => x.name === '现金') || {}).opening),
    bankOpen: num0((acc0.find((x) => x.name === '银行卡') || {}).opening),
    orders: ((await call('GET', '/ar')).d || []).length,
    loans: ((await call('GET', '/loans')).d || []).length
  }
  const led0 = ((await call('GET', '/flows')).d || {})
  const cashIn0 = num0(led0.total_in)
  const cashOut0 = num0(led0.total_out)

  const openB64 = mkPack([
    { name: '说明', rows: [['开账全套模板 —— 测试']] },
    { name: '账户期初', rows: [['账户', '期初余额', '备注(可空)'], ['现金', 3000, ''], ['银行卡', 20000, '']] },
    { name: '默认账期', rows: [['默认账期(天)'], [45]] },
    { name: '期初应收', rows: [['客户', '金额', '日期(可空)'], [TAG + '期初客户甲', 5000, ''], [TAG + '期初客户乙', 3000, '']] },
    { name: '期初应付', rows: [['供应商', '金额', '日期(可空)'], [TAG + '期初供应商', 2000, '']] },
    { name: '期初借支', rows: [['员工', '未还金额', '备注(可空)'], [TAG + '员工甲', 800, '上月买辅料']] },
    { name: '期初借款', rows: [['出借方', '本金', '年利率%', '起始日(可空)', '期限(月,可空)'], [TAG + '银行', 100000, 4.5, '', 12]] }
  ])

  // 2.1 先预览：不写库
  const dry = await call('POST', '/import-pack', { b64: openB64, dry: true })
  eq('开账预览状态', dry.status, 200)
  eq('开账预览认出的页数', ((dry.d && dry.d.sheets) || []).filter((x) => x.type).length, 6)
  const accDry = ((((await call('GET', '/accounts')).d || {}).accounts) || []).find((x) => x.name === '现金') || {}
  eq('预览没写库（现金期初没变）', num0(accDry.opening), before.cashOpen)
  const ordDry = ((await call('GET', '/ar')).d || []).length
  eq('预览没写库（应收条数没变）', ordDry, before.orders)

  // 2.2 真导
  const imp = await call('POST', '/import-pack', { b64: openB64 })
  eq('开账整包导入状态', imp.status, 200)
  // 账户 2 + 账期 1 + 期初应收 2 + 期初应付 1 + 期初借支 1 + 期初借款 1 = 8
  eq('开账整包导入行数', num0(imp.d && imp.d.total_imported), 8)

  const accs = ((((await call('GET', '/accounts')).d || {}).accounts) || [])
  eq('现金期初 = 3000', num0((accs.find((x) => x.name === '现金') || {}).opening), 3000)
  eq('银行卡期初 = 20000', num0((accs.find((x) => x.name === '银行卡') || {}).opening), 20000)
  const term = await call('GET', '/term-default')
  eq('默认账期 = 45', num0((term.d || {}).days), 45)

  const arList = (await call('GET', '/ar')).d || []
  eq('期初应收进了 2 家', arList.filter((x) => x.customer === TAG + '期初客户甲' || x.customer === TAG + '期初客户乙').length, 2)
  const apList = (await call('GET', '/ap')).d || []
  eq('期初应付进了 1 家', apList.filter((x) => x.supplier === TAG + '期初供应商').length, 1)
  eq('期初应付金额', num0((apList.find((x) => x.supplier === TAG + '期初供应商') || {}).amount), 2000)

  const loans = ((await call('GET', '/loans')).d || {}).list || []
  const loanRow = loans.find((x) => x.staff === TAG + '员工甲') || {}
  eq('期初借支记了 800', num0(loanRow.amount), 800)

  const debts = ((await call('GET', '/debts')).d || {}).debts || []
  const debtRow = debts.find((x) => x.lender === TAG + '银行') || {}
  eq('期初借款记了 10 万', num0(debtRow.principal), 100000)
  eq('期初借款年息 4.5', num0(debtRow.rate), 4.5)

  // 2.3 期初借支 / 借款不写现金流水
  const led1 = ((await call('GET', '/flows')).d || {})
  eq('期初借支/借款没动现金收入', num0(led1.total_in), cashIn0)
  eq('期初借支/借款没动现金支出', num0(led1.total_out), cashOut0)

  // 2.4 同一份文件再传一遍：整包拦下
  const dup = await call('POST', '/import-pack', { b64: openB64 })
  eq('同一份文件重传被拦', dup.d && dup.d.dup_file, true)
  eq('重传导了 0 行', num0(dup.d && dup.d.total_imported), 0)

  // 2.5 硬要再导一次（force）：账户是「设」不是「加」，不会变 6000
  const force = await call('POST', '/import-pack', { b64: openB64, force: true })
  eq('强制重导状态', force.status, 200)
  const accs2 = ((((await call('GET', '/accounts')).d || {}).accounts) || [])
  eq('账户期初是「设」不是「加」（仍 3000）', num0((accs2.find((x) => x.name === '现金') || {}).opening), 3000)

  // 3. 日常台账：一包全导
  // 断言落到「本次这批数据」上（供应商/备注都带 TAG）：这个库上别的测试也会往同一分类里加，
  // 写死「等于 12000」在共享库上必红。支出金额也每次不同，避开同分类同金额的当日防重。
  const EXP = 1200 + (Date.now() % 500)
  const dailyB64 = mkPack([
    { name: '说明', rows: [['日常台账模板 —— 测试']] },
    { name: '应收对账', rows: [['客户', '对账金额', '月份(可空)', '备注(可空)'], [TAG + '客户甲', 12800, '2091-03', ''], [TAG + '客户乙', 9600, '', '含打样费']] },
    { name: '应付对账', rows: [['供应商', '对账金额', '分类(可空)', '月份(可空)', '备注(可空)'], [TAG + '化工', 8600, '硫酸', '2091-03', ''], [TAG + '外协厂', 12000, '外发加工费', '', '这批外发']] },
    { name: '支出', rows: [['金额', '分类', '备注', '经手人(可空)', '日期(可空)'], [EXP, '房租', TAG + ' 厂房租金', '', '']] },
    { name: '借支', rows: [['员工', '金额', '备注', '日期(可空)'], [TAG + '员工乙', 1000, '买辅料', '']] },
    { name: '报销', rows: [['员工', '金额', '分类', '备注', '日期(可空)'], [TAG + '员工乙', 300, '采购', '买螺丝', '']] },
    { name: '付房东', rows: [['名称', '金额', '月数(0=押金不摊)', '分类', '起始日(可空)', '备注(可空)'], [TAG + '厂房押金', 6000, 0, '押金', '', '退租收回'], [TAG + '11月租金', 12000, 1, '厂房租金', '', '']] }
  ])
  const ddry = await call('POST', '/import-pack', { b64: dailyB64, dry: true })
  eq('日常台账预览状态', ddry.status, 200)
  eq('日常台账预览认出的页数', ((ddry.d && ddry.d.sheets) || []).filter((x) => x.type).length, 6)

  const dimp = await call('POST', '/import-pack', { b64: dailyB64 })
  eq('日常台账整包导入状态', dimp.status, 200)
  // 应收对账 2 + 应付对账 2 + 支出 1 + 借支 1 + 报销 1 + 付房东 2 = 9
  eq('日常台账导入行数', num0(dimp.d && dimp.d.total_imported), 9)

  const ar2 = (await call('GET', '/ar')).d || []
  const a1 = ar2.find((x) => x.customer === TAG + '客户甲') || {}
  eq('应收对账金额 12800', num0(a1.price), 12800)
  eq('应收对账记到 2091-03 月底', String(a1.created_at || '').slice(0, 10), '2091-03-31')

  const apAll = (await call('GET', '/ap')).d || []
  const apOut = (Array.isArray(apAll) ? apAll : (apAll.list || [])).find((x) => x.supplier === TAG + '外协厂') || {}
  eq('应付对账「外发」归到分类外发加工费', apOut.category, '外发加工费')
  eq('应付对账「外发」金额 12000', num0(apOut.amount), 12000)
  const apSup = (Array.isArray(apAll) ? apAll : (apAll.list || [])).find((x) => x.supplier === TAG + '化工') || {}
  eq('应付对账「硫酸」归到分类硫酸', apSup.category, '硫酸')

  const flows = ((await call('GET', '/flows?kw=' + encodeURIComponent(TAG + ' 厂房租金'))).d || {})
  const myEx = (flows.rows || []).find((x) => String(x.remark || '').indexOf(TAG + ' 厂房租金') >= 0) || {}
  eq('支出进了流水（金额对）', num0(myEx.amount), EXP)
  eq('支出的分类是房租', myEx.category, '房租')
  eq('支出是付出去的钱', myEx.dir, 'out')

  const ppRows = (((await call('GET', '/prepaids')).d || {}).prepaids) || []
  const dep = ppRows.find((x) => x.name === TAG + '厂房押金') || {}
  eq('押金月数 0 → deposit', dep.deposit, true)
  eq('押金每月摊 0', num0(dep.per_month), 0)
  eq('押金还剩 6000', num0(dep.remain), 6000)
  const rent = ppRows.find((x) => x.name === TAG + '11月租金') || {}
  eq('租金 1 个月摊 12000', num0(rent.per_month), 12000)

  // 报销冲了借支：借支已用 300
  const loans2 = (((await call('GET', '/loans')).d || {}).list) || []
  const lb = loans2.find((x) => x.staff === TAG + '员工乙') || {}
  eq('报销冲借支 300', num0(lb.used), 300)

  // 4. 整包导入不能把账弄乱：自检里不许出现本次导入的数据
  //（不能直接要求 ok===true —— 同一库上别的测试会故意留不一致的数据来验守卫）
  const sc = await call('GET', '/selfcheck')
  eq('自检接口通', sc.status, 200)
  const mine = ((sc.d && sc.d.issues) || []).filter((x) => String(x).indexOf(TAG) >= 0)
  eq('整包导入没弄乱账（自检里没有本次数据的问题）', mine.length, 0)
  if (mine.length) console.log('    ' + mine.join('\n    '))

  console.log(`\n共 ${pass} 项通过${bad.length ? `，${bad.length} 项失败` : ''}`)
  if (bad.length) { bad.forEach((b) => console.log('  ❌ ' + b)); process.exit(1) }
}

main().catch((e) => { console.error('测试出错：', e && e.stack ? e.stack : e); process.exit(1) })
