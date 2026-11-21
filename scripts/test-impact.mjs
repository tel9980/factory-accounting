// 导入前试算回归：这批表进去之后，首页那几个数字会变成多少
//
// 为什么要有这个：以前「先看看要导什么」只回答「能不能导」，不回答「导了会怎样」。
// 用户真实的担心是「这一传会不会把账搞乱」——现金是不是会莫名少两万、应收是不是会翻倍。
// 导完再去看首页已经晚了（要撤回还得逐批撤）。现在预览就给出试算，这个测试钉住：
//
//   1. 试算的「现在」跟首页/账户页的数字是同一口径（不是另算一套）
//   2. 试算的「变化」跟真导进去之后实际的数字变化一致（这是最重要的一条：
//      试算和真导必须是同一个模型，否则试算就是个骗人的数字）
//   3. 各类型的钱走向对：应收/应付只加欠款、支出和付房东扣现金、借支扣现金并挂账、
//      报销先冲借支再发现金、账户期初是「设成」不是「加」
//   4. 现金会被算成负数时要明确警告（这是最容易发现「金额打错了」的信号）
//   5. 试算不写库（dry 就是纯看）
//   6. 老的返回字段（ok / sheets / text）一个都没坏
//
// 用法：node scripts/test-impact.mjs [--base http://127.0.0.1:8791] [--key 8888]

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
const r2 = (v) => Math.round(num0(v) * 100) / 100
const near = (label, got, want, tol = 0.02) => (Math.abs(r2(got) - r2(want)) <= tol ? ok(`${label} = ${r2(want)}`) : no(`${label} 应为 ${r2(want)}`, r2(got)))

const call = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) })
  let d = null
  try { d = await r.json() } catch (e) { d = null }
  return { status: r.status, d }
}
const get = async (p) => (await call('GET', p)).d || {}

// ===== 极简多页签 xlsx 生成器（stored 不压缩 + inlineStr，跟 test-preview 同一套）=====
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

// 首页/账户页那几个数（试算必须跟它们一个口径）
const snap = async () => {
  const acc = await get('/accounts')
  const ar = await get('/ar-summary')
  const ap = await get('/ar-summary?type=ap')
  const ln = await get('/loans')
  return { cash: r2(acc.total_balance), ar: r2(ar.open_amount), ap: r2(ap.open_amount), loan: r2(ln.open_total) }
}

// 先试算、再真导，然后看实际变化跟试算对不对得上
const run = async (sheets) => {
  const b64 = mkPack(sheets)
  const d1 = await call('POST', '/import-pack', { b64, dry: true })
  const imp = (d1.d || {}).impact
  const before = await snap()
  const b2 = await call('POST', '/import-pack', { b64 })
  const after = await snap()
  return { dry: d1, imp, before, after, imported: (b2.d || {}).imported, real: b2 }
}

const main = async () => {
  console.log('导入前试算：这批进去之后账变成多少（' + BASE + '）')
  await call('POST', '/auth/setup', { key: KEY })
  const tag = 'ip' + String(Date.now()).slice(-5)
  // 支出类在同一天、同分类、同金额会被当成「重复」挡掉（这是防手抖重复导入的），
  // 所以金额带上一点随机偏移，脚本才能反复跑；断言按实际用的金额算。
  const off = Date.now() % 700
  const E1 = 500 + off
  const E2 = 300 + off
  const E8 = 900 + off
  const base = await snap()

  // ===== 1. 期初应收：只加欠款，不动现金 =====
  const s1 = await run([{ name: '期初应收', rows: [['客户', '金额', '日期(可空)'], [tag + '甲', 1111, ''], [tag + '乙', 2222, ''], [tag + '丙', 3333, '']] }])
  eq('预览状态 200', s1.dry.status, 200)
  if (!s1.imp) no('dry 里要有 impact')
  else {
    near('试算「现在」的现金 = 账户页合计', s1.imp.before.cash, base.cash)
    near('试算「现在」的应收 = 应收汇总', s1.imp.before.ar, base.ar)
    near('试算「现在」的应付 = 应付汇总', s1.imp.before.ap, base.ap)
    near('试算「现在」的借支 = 借支合计', s1.imp.before.loan, base.loan)
    near('应收会增加 6666', s1.imp.delta.ar, 6666)
    near('现金不动', s1.imp.delta.cash, 0)
    near('净资产跟着应收涨', s1.imp.delta.net_worth, 6666)
    eq('after = before + delta（应收）', r2(s1.imp.after.ar - s1.imp.before.ar), r2(s1.imp.delta.ar))
    eq('试算说明里提到应收', /应收/.test(String(s1.imp.text || '')), 'true')
    // 真导进去，实际变化必须跟试算一样
    near('真导后实际应收增加 = 试算', s1.after.ar - s1.before.ar, s1.imp.delta.ar)
    near('真导后实际现金变化 = 试算', s1.after.cash - s1.before.cash, s1.imp.delta.cash)
  }

  // ===== 2. 支出：只扣现金 =====
  const s2 = await run([{ name: '支出', rows: [['金额', '分类', '备注', '经手人(可空)', '日期(可空)'], [E1, '水电', tag + '电费', '', ''], [E2, '房租', tag + '房租', '', '']] }])
  if (!s2.imp) no('支出页也要有 impact')
  else {
    near(`支出 ${E1 + E2} → 现金 -${E1 + E2}`, s2.imp.delta.cash, -(E1 + E2))
    near('支出不动应收', s2.imp.delta.ar, 0)
    near('真导后现金实际变化 = 试算', s2.after.cash - s2.before.cash, s2.imp.delta.cash)
    eq('明细行里点了这一页', (s2.imp.rows || []).some((x) => x.type === 'expense'), 'true')
    near(`明细行现金 = -${E1 + E2}`, ((s2.imp.rows || [])[0] || {}).cash, -(E1 + E2))
  }

  // ===== 3. 借支：扣现金，员工那边挂账 =====
  const staff = tag + '张'
  const s3 = await run([{ name: '借支', rows: [['员工', '金额', '备注', '日期(可空)'], [staff, 1000, tag + '买辅料', '']] }])
  if (!s3.imp) no('借支页也要有 impact')
  else {
    near('借支 1000 → 现金 -1000', s3.imp.delta.cash, -1000)
    near('借支 1000 → 借支余额 +1000', s3.imp.delta.loan, 1000)
    near('真导后现金变化 = 试算', s3.after.cash - s3.before.cash, s3.imp.delta.cash)
    near('真导后借支余额变化 = 试算', s3.after.loan - s3.before.loan, s3.imp.delta.loan)
  }

  // ===== 4. 报销：先冲这个人手上的借支，冲完才发现金 =====
  const s4 = await run([{ name: '报销', rows: [['员工', '金额', '分类', '备注', '日期(可空)'], [staff, 600, '采购', tag + '冲借支', '']] }])
  if (!s4.imp) no('报销页也要有 impact')
  else {
    near('报销 600 全冲借支 → 现金不动', s4.imp.delta.cash, 0)
    near('借支余额 -600', s4.imp.delta.loan, -600)
    eq('说明里讲清「冲的是以前借出去的钱」', /冲的是以前借出去的钱/.test(String((s4.imp.notes || []).join('；'))), 'true')
    near('真导后借支余额变化 = 试算', s4.after.loan - s4.before.loan, s4.imp.delta.loan)
  }
  // 手上只剩 400，再报 800：400 冲借支、400 发现金
  const s5 = await run([{ name: '报销', rows: [['员工', '金额', '分类', '备注', '日期(可空)'], [staff, 800, '采购', tag + '超额报销', '']] }])
  if (!s5.imp) no('第二次报销也要有 impact')
  else {
    near('报销 800（只剩 400 借支）→ 现金 -400', s5.imp.delta.cash, -400)
    near('借支余额 -400（冲到 0）', s5.imp.delta.loan, -400)
    near('真导后现金变化 = 试算', s5.after.cash - s5.before.cash, s5.imp.delta.cash)
    near('真导后借支余额变化 = 试算', s5.after.loan - s5.before.loan, s5.imp.delta.loan)
  }

  // ===== 5. 付房东：现金全额出去，之后按月摊 =====
  const s6 = await run([{ name: '付房东', rows: [['名称', '金额', '月数(0=押金不摊)', '分类', '起始日(可空)', '备注(可空)'], [tag + '厂房租金', 2001, 1, '厂房租金', '', '']] }])
  if (!s6.imp) no('付房东页也要有 impact')
  else {
    near('付房东 2001 → 现金 -2001', s6.imp.delta.cash, -2001)
    eq('说明里讲清「之后按月摊」', /按月摊/.test(String((s6.imp.notes || []).join('；'))), 'true')
    near('真导后现金变化 = 试算', s6.after.cash - s6.before.cash, s6.imp.delta.cash)
  }

  // ===== 6. 账户期初：是「设成」，不是「加」 =====
  const accNow = (await get('/accounts')).accounts || []
  const cashAcc = accNow.find((a) => /现金/.test(String(a.name || ''))) || accNow[0] || { name: '现金', opening: 0 }
  const wantOpen = 7000
  const s7 = await run([{ name: '账户期初', rows: [['账户', '期初余额', '备注(可空)'], [cashAcc.name, wantOpen, '']] }])
  if (!s7.imp) no('账户期初页也要有 impact')
  else {
    near('期初从 ' + num0(cashAcc.opening) + ' 设成 7000 → 现金差 ' + r2(wantOpen - num0(cashAcc.opening)), s7.imp.delta.cash, wantOpen - num0(cashAcc.opening))
    eq('说明里讲清「设成不是加上」', /不是「加上这个数」/.test(String((s7.imp.notes || []).join('；'))), 'true')
    near('真导后现金变化 = 试算', s7.after.cash - s7.before.cash, s7.imp.delta.cash)
  }
  // 再传一次同样的期初：不该再变（这是「设」的关键）
  const again = await run([{ name: '账户期初', rows: [['账户', '期初余额', '备注(可空)'], [cashAcc.name, wantOpen, '']] }])
  if (again.imp) near('同一个期初再传一次，现金差 0', again.imp.delta.cash, 0)

  // ===== 7. 多页一起：各页的变化要相加 =====
  const s8 = await run([
    { name: '期初应收', rows: [['客户', '金额', '日期(可空)'], [tag + '丁', 4000, '']] },
    { name: '支出', rows: [['金额', '分类', '备注', '经手人(可空)', '日期(可空)'], [E8, '运费', tag + '运费', '', '']] }
  ])
  if (!s8.imp) no('多页包也要有 impact')
  else {
    near('多页：应收 +4000', s8.imp.delta.ar, 4000)
    near(`多页：现金 -${E8}`, s8.imp.delta.cash, -E8)
    eq('明细两行', (s8.imp.rows || []).filter((x) => x.count > 0).length, 2)
    near('真导后应收变化 = 试算', s8.after.ar - s8.before.ar, s8.imp.delta.ar)
    near('真导后现金变化 = 试算', s8.after.cash - s8.before.cash, s8.imp.delta.cash)
  }

  // ===== 8. 现金会被算成负数 → 必须警告 =====
  // 只试算不真导：这种手滑金额不能真写进库
  const hugeDry = await call('POST', '/import-pack', { b64: mkPack([{ name: '支出', rows: [['金额', '分类', '备注', '经手人(可空)', '日期(可空)'], [99999999, '其他', tag + '手滑多打了个零', '', '']] }]), dry: true })
  const huge = { imp: (hugeDry.d || {}).impact, dry: hugeDry }
  if (!huge.imp) no('大额支出也要有 impact')
  else {
    eq('现金为负时给警告', (huge.imp.warn || []).length > 0, 'true')
    eq('警告里说清「现金是负数」', /现金是/.test(String((huge.imp.warn || [])[0] || '')), 'true')
    eq('负数时 after.cash < 0', huge.imp.after.cash < 0, 'true')
  }

  // ===== 9. 试算不写库（dry 就是纯看）=====
  const beforeDry = await snap()
  await call('POST', '/import-pack', { b64: mkPack([{ name: '期初应付', rows: [['供应商', '金额', '日期(可空)'], [tag + '戊', 7777, '']] }]), dry: true })
  const afterDry = await snap()
  near('预览一遍之后应付没变', afterDry.ap, beforeDry.ap)
  near('预览一遍之后现金没变', afterDry.cash, beforeDry.cash)

  // ===== 10. 单类型上传的预览也有试算，老字段没坏 =====
  const single = await call('POST', '/import-xlsx', { type: 'ar_init', preview: true, b64: mkPack([{ name: 'Sheet1', rows: [['客户', '金额'], [tag + '己', 1500]] }]) })
  eq('单类型预览状态 200', single.status, 200)
  eq('单类型预览也带 impact', !!(single.d && single.d.impact), 'true')
  if (single.d && single.d.impact) near('单类型：应收 +1500', single.d.impact.delta.ar, 1500)
  eq('老的 rows 字段还在', Array.isArray((single.d || {}).rows), 'true')
  eq('老的 text 字段还在', typeof (single.d || {}).text, 'string')

  // ===== 11. 应付 / 应收回款方向：应付只加欠款 =====
  const s11 = await run([{ name: '期初应付', rows: [['供应商', '金额', '日期(可空)'], [tag + '庚', 2500, '']] }])
  if (s11.imp) {
    near('应付 +2500', s11.imp.delta.ap, 2500)
    near('应付不动现金', s11.imp.delta.cash, 0)
    near('真导后应付变化 = 试算', s11.after.ap - s11.before.ap, s11.imp.delta.ap)
  } else no('应付页也要有 impact')

  console.log('\n' + (bad.length ? '❌ ' + bad.length + ' 项没过：\n  - ' + bad.join('\n  - ') : '✅ 全部通过') + `（${pass} 项）`)
  if (bad.length) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
