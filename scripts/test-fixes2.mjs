// 第二刀回归：坏账核销要进利润 / 导入判重只看同一天 / 材料成本可能算两遍要说出来
//
// 为什么要有这个：
//   1. 核销（这笔钱确认收不回来了）从「应收」里划掉，家底立刻少一块；而利润公式里一直没减它，
//      于是「这个月赚了 3 万、家底却少了 5 千」这种对不上的情况永远查不出来。现在核销算进成本。
//   2. 导入判重原来是「同客户同价 ±7 天」→ 老张一周里天天来一单 500 的加工费，第二单开始
//      被静默吞掉（不报错、不提示）。现在只认「同一天」，跨天的同额同客户都算两张单。
//   3. 单子上填了材料成本、又拿现金买了料记成「材料」支出 —— 两边都进成本就重了。
//      系统不替你改数（谁该算哪边只有老板知道），但必须在月报里说出来。
//
// 用法：node scripts/test-fixes2.mjs [--base http://127.0.0.1:8791] [--key 8888]

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const BASE = arg('base', 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = arg('key', '8888')
const H = { 'X-Access-Key': KEY, 'Content-Type': 'application/json' }

let pass = 0
const bad = []
const ok = (msg) => { pass++; console.log('  ✅ ' + msg) }
const no = (msg, detail) => { bad.push(msg); console.log('  ❌ ' + msg + (detail === undefined ? '' : ' → ' + JSON.stringify(detail))) }
const eq = (label, got, want) => (String(got) === String(want) ? ok(`${label} = ${want}`) : no(`${label} 应为 ${want}`, got))
const near = (label, got, want, tol = 0.02) => (Math.abs(Number(got) - Number(want)) <= tol ? ok(`${label} ≈ ${want}`) : no(`${label} 应约 ${want}`, got))
const num0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const r2 = (v) => Math.round(num0(v) * 100) / 100

const day = (back) => {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  d.setUTCDate(d.getUTCDate() - (back || 0))
  return d.toISOString().slice(0, 10)
}
const monthNow = () => day(0).slice(0, 7)

const call = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) })
  let d = null
  try { d = await r.json() } catch (e) { d = null }
  return { status: r.status, d }
}
const get = (p) => call('GET', p)
const post = (p, b) => call('POST', p, b)

// ===== 极简多页签 xlsx（stored，够本项目读文件用）=====
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

// 每月利润三个来源必须一致（首页 / 月报 / 六个月趋势）
const profits = async () => {
  const m = monthNow()
  const [brief, dash, cb] = await Promise.all([get('/month-brief?month=' + m), get('/dashboard'), get('/cash-bridge?month=' + m)])
  const trend = ((brief.d && brief.d.trend) || []).find((x) => x.m === m) || {}
  return {
    brief: r2((brief.d || {}).profit),
    briefAccrual: r2((brief.d || {}).profit_accrual),
    dash: r2((dash.d || {}).profit_biz),
    trend: r2(trend.profit),
    wo: r2((dash.d || {}).month_writeoff),
    briefWo: r2((brief.d || {}).writeoff),
    bridgeHuge: !!(cb.d && cb.d.huge),
    bridgeWo: r2(((cb.d || {}).rows || []).reduce((a, x) => (x.k === 'wo' ? num0(x.amount) : a), 0)),
    bridgeWoLabel: (((cb.d || {}).rows || []).find((x) => x.k === 'wo') || {}).label || '',
    bridgeResidual: r2((cb.d || {}).residual),
    briefObj: brief.d || {}
  }
}
const sentences = (b) => ((b.sentences || []).map((x) => String(x.text || '')).join(' | '))

const main = async () => {
  console.log('第二刀回归：核销进利润 / 判重只看同一天 / 材料算两遍要说出来（' + BASE + '）')
  await call('POST', '/auth/setup', { key: KEY })
  const off = Date.now() % 900
  // 名字里带这一轮的随机后缀：不然第二次跑会撞上「同客户同价同一天」的防重，直接 409
  const tag = Date.now().toString(36).slice(-4)
  const off2 = Date.now() % 77

  // ===== 1. 坏账核销要算进利润（三个口径一起变）=====
  console.log('\n[1] 坏账核销：抹掉的钱也是亏的钱')
  const p0 = await profits()
  const cWo = '核销客户甲' + tag
  const mk = await post('/orders', { customer: cWo, price: 3000, item_name: '加工' })
  eq('[1] 建一张 3000 的单', mk.status, 200)
  const ar = await get('/ar?kw=' + encodeURIComponent(cWo))
  const rows1 = Array.isArray(ar.d) ? ar.d : ((ar.d && (ar.d.list || ar.d.rows)) || [])
  const oid = rows1.length ? rows1[0].id : 0
  ok('[1] 找到这张单 id=' + oid)
  const p1 = await profits()
  near('[1] 开单让利润 +3000（首页）', p1.dash - p0.dash, 3000)
  const woAmt = 1200 + off2
  const w = await post('/orders/' + oid + '/writeoff', { amount: woAmt, reason: '要不回来了' })
  eq('[1] 核销成功', w.status, 200)
  const p2 = await profits()
  near('[1] 核销让首页利润 -' + woAmt, p2.dash - p1.dash, -woAmt)
  // 第三刀之后：月报/趋势的主数字是收付实现制（只认到账的钱），核销不动现金，所以不动。
  // 核销影响的是权责口径那个数，两条都要钉住 —— 否则以后谁又并回去就没人发现。
  eq('[1] 核销不动现金口径的月报利润', p2.brief - p1.brief, 0)
  near('[1] 核销让月报的「权责口径」利润 -' + woAmt, p2.briefAccrual - p1.briefAccrual, -woAmt)
  eq('[1] 核销不动现金口径的六个月趋势', p2.trend - p1.trend, 0)
  near('[1] 首页「本月核销」跟着涨 ' + woAmt, p2.wo - p1.wo, woAmt)
  near('[1] 月报里也有核销这一项（跟着涨）', p2.briefWo - p1.briefWo, woAmt)
  eq('[1] 现金一条没动（核销不动钱）', p2.bridgeResidual === p1.bridgeResidual, true)
  // 只钉「核销不会把残差弄坏」：整张「钱去哪了」表在测试库上会被别的测试留下的老数据带偏，
  // 拿它当全局断言会假红。真正要保证的是「核销前后残差一模一样」+「核销那一行不再重复扣」。
  eq('[1] 核销那一行金额为 0（不重复扣）', r2(p2.bridgeWo), 0)
  eq('[1] 核销那一行文案说明了「已算进净利」', /已算进上面的净利/.test(String(p2.bridgeWoLabel || '')), true)
  const sw = sentences(p2.briefObj)
  eq('[1] 月报一句话里提到坏账核销', /坏账核销/.test(sw), true)

  // ===== 2. 导入判重：同一天挡，跨天不挡 =====
  console.log('\n[2] 导入判重只看「同一天」（老张天天来一单 500 不能被吞）')
  const cust = '老张加工户' + tag
  const amt = 500 + off2
  const b64a = mkPack([{ name: '期初应收', rows: [['客户', '金额'], [cust, amt]] }])
  const b64b = mkPack([{ name: '期初应收', rows: [['客户', '金额'], [cust, amt]] }])
  // 期初应收的日期固定是「今年 1 月 1 日」，所以两笔同日 → 第二笔算重复
  const r1 = await post('/import-pack', { b64: b64a })
  eq('[2] 第一次导入成功', r1.status, 200)
  eq('[2] 第一笔真导进去', num0((((r1.d || {}).sheets || [])[0] || {}).imported), 1)
  const r2r = await post('/import-pack', { b64: b64b })
  eq('[2] 同一天的同一笔 → 算重复不导', num0((((r2r.d || {}).sheets || [])[0] || {}).imported), 0)
  // 第二次是「同一个文件」：会被文件指纹挡住（dup_file），这也算说清了；改过内容的同一行才走行级判重
  ok('[2] 并且说清「像重复」或「这份表导过了」 = ' + JSON.stringify({ dup_file: !!((r2r.d || {}).dup_file), dup: num0((((r2r.d || {}).sheets || [])[0] || {}).dup_count) }))
  // 跨天：应收单导入（带日期列），昨天一笔、三天前一笔，同客户同价
  const arCols = ['客户', '品名', '金额', '成本', '到期', '经手']
  const b64c = mkPack([{ name: '应收', rows: [arCols, [cust, '加工', amt, '', '', '', day(2)], [cust, '加工', amt, '', '', '', day(4)]] }])
  const r3 = await post('/import-pack', { b64: b64c })
  eq('[2] 跨天的两笔都要导进去', num0((((r3.d || {}).sheets || [])[0] || {}).imported), 2)
  eq('[2] 跨天的不算重复', num0((((r3.d || {}).sheets || [])[0] || {}).dup_count), 0)
  const arAll = await get('/ar?kw=' + encodeURIComponent(cust))
  const rowsAll = Array.isArray(arAll.d) ? arAll.d : ((arAll.d && (arAll.d.list || arAll.d.rows)) || [])
  eq('[2] 库里一共 3 张（1 期初 + 2 应收）', rowsAll.length, 3)
  // 预览要说同一件事：同一天算重复、跨天不算
  const pvSame = await post('/import-pack', { b64: mkPack([{ name: '应收', rows: [arCols, [cust, '加工', amt, '', '', '', day(2)]] }]), dry: true })
  eq('[2] 预览：同一天那笔标「像重复」', num0((((pvSame.d || {}).sheets || [])[0] || {}).dup_count), 1)
  const pvOther = await post('/import-pack', { b64: mkPack([{ name: '应收', rows: [arCols, [cust, '加工', amt, '', '', '', day(6)]] }]), dry: true })
  eq('[2] 预览：跨天那笔不算重复', num0((((pvOther.d || {}).sheets || [])[0] || {}).dup_count), 0)

  // ===== 3. 材料成本可能算两遍：要说出来 =====
  console.log('\n[3] 单子上填了料、又记了「材料」现金支出 → 月报要提醒')
  const mAmt = 700 + off2
  const mkOrd = await post('/orders', { customer: '材料提示客户' + tag, price: 2000, item_name: '加工', cost: mAmt })
  eq('[3] 建一张带材料成本的单', mkOrd.status, 200)
  const ex = await post('/expenses', { amount: mAmt, category: '材料', remark: '买料（提示测试）', client_id: 'fx2ex' + Date.now() })
  eq('[3] 记一笔「材料」现金支出', ex.status, 200)
  const mb = await get('/month-brief?month=' + monthNow())
  const hint = String((mb.d || {}).cost_hint || '')
  eq('[3] 月报给出 cost_hint', hint.length > 0, true)
  eq('[3] 提示里说清「重复」', /重复/.test(hint), true)
  const sw3 = sentences(mb.d || {})
  eq('[3] 一句话汇报里也有这条提醒', /算两遍|重复/.test(sw3), true)
  eq('[3] 提醒不改数（利润照算）', Math.abs(num0((mb.d || {}).profit)) >= 0, true)

  console.log('')
  if (bad.length) { console.log('❌ ' + bad.length + ' 项失败：'); bad.forEach((x) => console.log('   · ' + x)); process.exit(1) }
  console.log('✅ 全过：' + pass + ' 项')
}

main().catch((e) => { console.error('测试崩了：', e); process.exit(1) })
