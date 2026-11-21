// 导入预览「错在哪」回归（一张几十行写错的表，不能只告诉前 3 行）
//
// 为什么要有这个：以前预览只回前 3 条错误（errors.slice(0,3)），用户改到第 4 行就不知道
// 还错在哪里，只能整张表重导、再猜、再错。现在给出全部问题行（上限 200），并说清是
// 「导不进去」还是「像重复」。这个测试钉住：
//
//   1. 5 行都写错 → error_rows 就是 5 条，每条带行号 / 原因（不是只给 3 条）
//   2. 300 行都写错 → 给 200 条 + error_more=100（响应不能被撑爆，但也不能装看不见）
//   3. 像重复的行单独给（dup_rows），跟「写错了」分开，因为这两种处理方式不一样
//   4. 已结账月份的行也单列出来（locked），文案说清「这个月封了」
//   5. 老的 errors 字段还在（小程序和老网页还在读它）——坏字段不能删，只能加
//   6. 预览不写库（dry 就是纯看）
//
// 用法：node scripts/test-preview.mjs [--base http://127.0.0.1:8791] [--key 8888]

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
const num0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const day = (back) => {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  d.setUTCDate(d.getUTCDate() - (back || 0))
  return d.toISOString().slice(0, 10)
}

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

const HDR = ['客户', '金额', '日期']
const preview = async (sheetName, rows) => {
  const b64 = mkPack([{ name: sheetName, rows: [HDR].concat(rows) }])
  const r = await call('POST', '/import-pack', { b64, dry: true })
  return { status: r.status, sheet: ((r.d && r.d.sheets) || [])[0] || {}, d: r.d }
}

const main = async () => {
  console.log('导入预览：错在哪要一次说清（' + BASE + '）')
  await call('POST', '/auth/setup', { key: KEY })
  const tag = 'pv' + String(Date.now()).slice(-5)

  // ===== 1. 5 行都写错 → 5 条都给，不是只给 3 条 =====
  const r1 = await preview('期初应收', [['', 500], ['', 600], ['', 700], ['', 800], ['', 900]])
  eq('预览状态', r1.status, 200)
  eq('认出页签类型', r1.sheet.type, 'ar_init')
  eq('错误行数（全给）', (r1.sheet.error_rows || []).length, 5)
  eq('没有截断提示', num0(r1.sheet.error_more), 0)
  eq('bad_count', num0(r1.sheet.bad_count), 5)
  const er0 = (r1.sheet.error_rows || [])[0] || {}
  eq('每条带行号', num0(er0.row), 1)
  eq('每条带原因', er0.error, '没写单位名')
  eq('老字段 errors 还在（不超过 3 条）', (r1.sheet.errors || []).length, 3)
  eq('老字段是字符串', typeof (r1.sheet.errors || [])[0], 'string')

  // ===== 2. 300 行都写错 → 200 条 + 「还有 100 行」=====
  const many = []
  for (let i = 0; i < 300; i++) many.push(['', 100 + i])
  const r2 = await preview('期初应收', many)
  eq('300 行错时给 200 条', (r2.sheet.error_rows || []).length, 200)
  eq('还有 100 行没列出（但要说清）', num0(r2.sheet.error_more), 100)
  eq('bad_count 照实给 300', num0(r2.sheet.bad_count), 300)

  // ===== 3. 像重复的行单独给（跟「写错了」分开）=====
  const cust = tag + '重客户'
  const mk = await call('POST', '/orders', { customer: cust, price: 1000, item_name: '加工' })
  eq('建一张应收单', mk.status, 200)
  const r3 = await preview('应收对账', [[cust, 1000]])
  eq('像重复的行数', (r3.sheet.dup_rows || []).length, 1)
  const dr0 = (r3.sheet.dup_rows || [])[0] || {}
  eq('重复行带单位名', dr0.party, cust)
  eq('重复行带金额', num0(dr0.amount), 1000)
  eq('重复行有说明', String(dr0.text || '').length > 0, true)
  eq('像重复不算「写错」', num0(r3.sheet.bad_count), 0)

  // ===== 4. 已结账月份的行：单列出来，并说清原因 =====
  await call('POST', '/month-lock', { month: '2020-02' })
  const r4 = await preview('期初应收', [[tag + '锁客户', 500, '2020-02-15']])
  eq('锁定月行数', (r4.sheet.error_rows || []).length, 1)
  eq('locked_count', num0(r4.sheet.locked_count), 1)
  const er4 = (r4.sheet.error_rows || [])[0] || {}
  eq('锁定行说明含「已结账」', /已结账/.test(String(er4.error || '')), true)
  await call('DELETE', '/month-lock/2020-02')

  // ===== 5. 都正常：一条错误都没有 =====
  const r5 = await preview('期初应收', [[tag + '好好甲', 111], [tag + '好好乙', 222]])
  eq('正常行 ok_count', num0(r5.sheet.ok_count), 2)
  eq('正常行没有 error_rows', (r5.sheet.error_rows || []).length, 0)
  eq('正常行没有 dup_rows', (r5.sheet.dup_rows || []).length, 0)

  // ===== 6. 预览不写库（dry 就是纯看）=====
  const ar = await call('GET', '/ar?kw=' + encodeURIComponent(tag + '好好甲'))
  const rows6 = Array.isArray(ar.d) ? ar.d : ((ar.d && (ar.d.list || ar.d.rows)) || [])
  eq('预览后库里没有这笔', rows6.length, 0)

  // ===== 7. 没写日期的行：不挡，但要说「会记成今天」=====
  // 补录上个月的纸质单，Excel 里日期列常常整列空着；以前系统一句话不说就全记到今天，
  // 连「已结账的月份不许改」那道锁也判不出来（锁是按认到的日期判的）。
  const r7 = await preview('支出', [[777, '水电', '没写日期'], [888, '水电', '写了', '', day(3)]])
  eq('没写日期的行数', num0(r7.sheet.no_date_count), 1)
  eq('写了的行不算「没写」', num0(r7.sheet.ok_count), 2)
  const w7 = String(r7.sheet.warn || (r7.d && r7.d.warn) || '')
  eq('预览要说「会记成今天」', /记成今天/.test(w7), true)

  console.log('')
  if (bad.length) { console.log('❌ ' + bad.length + ' 项失败：'); bad.forEach((x) => console.log('   · ' + x)); process.exit(1) }
  console.log('✅ 全部 ' + pass + ' 项通过')
}

main().catch((e) => { console.error('测试崩了：', e); process.exit(1) })
