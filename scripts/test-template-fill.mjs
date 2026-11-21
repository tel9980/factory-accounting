// 模板预填回归（下载模板时先把名字填好，省得每天手打）
//
// 为什么要有这个：一个人的小财务，日常就是「下载模板 → 填 → 传」。名字打错一个字，
// 这一笔就对不上人 —— 员工的借支余额、「只看自己录的单」全靠那个字串对。
// 所以下载模板时把已有的名字做成下拉。这里钉住：
//
//   1. fill=1 时客户 / 供应商 / 员工三类名字都能查到（响应里有 fills 计数，不用解析 xlsx）
//   2. 员工名真的写进了 xlsx 的下拉里（借支/报销的「员工」列、支出的「经手人」列）
//   3. 支出页原来那个「分类」下拉不能被覆盖掉（改这一页时最容易顺手写坏）
//   4. 应收对账页仍然按客户一家一行预填（这条是老功能，不能因为改下拉而退化）
//   5. Excel 下拉的候选值整串不能超过 255 字符 —— 超了 Excel 直接说文件损坏，
//      所以给 60 个员工时要自动截断，而不是生成一个打不开的文件
//   6. fill=0 时一个名字都不填（不想预填的人不受影响）
//
// 用法：node scripts/test-template-fill.mjs [--base http://127.0.0.1:8791] [--key 8888]

import zlib from 'node:zlib'

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
const ge = (label, got, want) => (Number(got) >= Number(want) ? ok(`${label} = ${got}（≥${want}）`) : no(`${label} 应 ≥${want}`, got))
const num0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

const call = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) })
  let d = null
  try { d = await r.json() } catch (e) { d = null }
  return { status: r.status, d }
}

// ===== 从 xlsx 里读某一页的 XML（后台生成的是 deflate 压缩的 zip，这里自己解）=====
const unzipSheet = (b64, name) => {
  const buf = Buffer.from(String(b64 || ''), 'base64')
  let p = 0
  while (p + 30 <= buf.length) {
    if (buf.readUInt32LE(p) !== 0x04034b50) break
    const method = buf.readUInt16LE(p + 8)
    const compSize = buf.readUInt32LE(p + 18)
    const nameLen = buf.readUInt16LE(p + 26)
    const extraLen = buf.readUInt16LE(p + 28)
    const fn = buf.slice(p + 30, p + 30 + nameLen).toString('utf8')
    const start = p + 30 + nameLen + extraLen
    const data = buf.slice(start, start + compSize)
    if (fn === name) return method === 0 ? data.toString('utf8') : zlib.inflateRawSync(data).toString('utf8')
    p = start + compSize
  }
  return ''
}

const main = async () => {
  console.log('模板预填：下载模板时把客户 / 供应商 / 员工名填成下拉（' + BASE + '）')
  await call('POST', '/auth/setup', { key: KEY })

  const tag = 'tf' + String(Date.now()).slice(-5)
  const custs = [tag + '甲客户', tag + '乙客户', tag + '丙客户']
  const sups = [tag + '甲供应', tag + '乙供应']
  const staffs = [tag + '员工甲', tag + '员工乙']

  // ===== 造底数：3 客户、2 供应商、2 员工、1 笔借支 =====
  let mk = 0
  for (const c of custs) {
    const r = await call('POST', '/orders', { customer: c, price: 100 + (mk++), item_name: '加工' })
    if (r.status !== 200) no('建客户（应收单）失败：' + c, r.d)
  }
  for (const s of sups) {
    const r = await call('POST', '/payables', { supplier: s, amount: 200 + (mk++) })
    if (r.status !== 200) no('建供应商（应付单）失败：' + s, r.d)
  }
  let pin = 1000 + (Date.now() % 8000)
  for (const st of staffs) {
    const r = await call('POST', '/staff-users', { name: st, pin: String(pin++), mods: ['ar'] })
    if (r.status !== 200) no('建员工失败：' + st, r.d)
  }
  const lo = await call('POST', '/loans', { staff: staffs[0], amount: 800, remark: '买辅料' })
  if (lo.status !== 200) no('建借支失败', lo.d)

  // ===== 1. fill=1：三类名字都查得到 =====
  const f1 = await call('GET', '/import-template-pack?tpl=daily&fill=1')
  eq('download 状态', f1.status, 200)
  const fills = (f1.d && f1.d.fills) || {}
  ge('预填客户数', num0(fills.customers), 3)
  ge('预填供应商数', num0(fills.suppliers), 2)
  ge('预填员工数', num0(fills.staffs), 2)
  const sheetNames = ((f1.d && f1.d.sheets) || []).map((x) => x.sheet)
  eq('日常包页数', sheetNames.length, 7)
  eq('日常包页签名', sheetNames.join('|'), ['说明', '应收对账', '应付对账', '支出', '借支', '报销', '付房东'].join('|'))

  // ===== 2. 员工名真的写进了下拉（借支第 1 列 / 报销第 1 列 / 支出第 4 列）=====
  const b64 = (f1.d && f1.d.b64) || ''
  const sLoan = unzipSheet(b64, 'xl/worksheets/sheet5.xml') // 借支
  const sReimb = unzipSheet(b64, 'xl/worksheets/sheet6.xml') // 报销
  const sExp = unzipSheet(b64, 'xl/worksheets/sheet4.xml') // 支出
  const sAr = unzipSheet(b64, 'xl/worksheets/sheet2.xml') // 应收对账
  if (!sLoan || !sReimb || !sExp || !sAr) no('解不出 xlsx 里的页（生成的包坏了）', { loan: !!sLoan, reimb: !!sReimb, exp: !!sExp, ar: !!sAr })
  else {
    ok('xlsx 里能解出 4 个页签')
    eq('借支页「员工」列有下拉', sLoan.includes('sqref="A2:A200"'), true)
    eq('借支页下拉里有员工甲', sLoan.includes(staffs[0]), true)
    eq('报销页「员工」列有下拉', sReimb.includes('sqref="A2:A200"'), true)
    eq('报销页下拉里有员工乙', sReimb.includes(staffs[1]), true)
    eq('支出页「经手人」列有下拉', sExp.includes('sqref="D2:D200"'), true)
    // 3. 分类下拉不能被覆盖掉
    eq('支出页「分类」下拉还在', sExp.includes('sqref="B2:B200"'), true)
    eq('报销页「分类」下拉还在', sReimb.includes('sqref="C2:C200"'), true)
    // 4. 应收对账仍然按客户一家一行预填
    const arRows = (sAr.match(/<row /g) || []).length
    ge('应收对账页行数（表头+预填客户）', arRows, 4)
    eq('应收对账页含客户甲', sAr.includes(custs[0]), true)
  }

  // ===== 5. 60 个员工：下拉自动截断，不生成打不开的文件 =====
  const many = []
  for (let i = 0; i < 60; i++) many.push('多' + (1000 + i))
  let p2 = 2000 + (Date.now() % 5000)
  for (const nm of many) {
    const r = await call('POST', '/staff-users', { name: nm, pin: String(p2++), mods: ['ar'] })
    if (r.status !== 200) { no('批量建员工失败：' + nm, r.d); break }
  }
  const f2 = await call('GET', '/import-template-pack?tpl=daily&fill=1')
  eq('60 个员工时下载仍然成功', f2.status, 200)
  ge('预填员工数（真实数量照实报）', num0((f2.d && f2.d.fills || {}).staffs), 60)
  const sLoan2 = unzipSheet((f2.d || {}).b64 || '', 'xl/worksheets/sheet5.xml')
  const mF = sLoan2.match(/<formula1>([\s\S]*?)<\/formula1>/g) || []
  let longest = 0
  for (const x of mF) longest = Math.max(longest, x.replace(/<\/?formula1>/g, '').length)
  if (!mF.length) no('60 个员工时下拉整个丢了（应该截断而不是不挂）', 0)
  else if (longest > 255) no('下拉候选值超过 255 字符，Excel 会报文件损坏', longest)
  else ok('下拉候选值最长 ' + longest + ' 字符（≤255，Excel 能打开）')

  // ===== 6. fill=0：一个名字都不填 =====
  const f3 = await call('GET', '/import-template-pack?tpl=daily')
  const fills3 = (f3.d && f3.d.fills) || {}
  eq('不预填时客户数', num0(fills3.customers), 0)
  eq('不预填时员工数', num0(fills3.staffs), 0)
  const sExp3 = unzipSheet((f3.d || {}).b64 || '', 'xl/worksheets/sheet4.xml')
  eq('不预填时支出页没有经手人下拉', sExp3.includes('sqref="D2:D200"'), false)
  eq('不预填时分类下拉还在', sExp3.includes('sqref="B2:B200"'), true)

  // ===== 7. 生成的包要能自己读回来（预填行不算数据）=====
  const rt = await call('POST', '/import-pack', { b64, dry: true })
  eq('预填过的包能读回来', rt.status, 200)
  const typed = ((rt.d && rt.d.sheets) || []).filter((x) => x.type)
  eq('认出的页数', typed.length, 6)
  const arSheet = typed.find((x) => x.type === 'ar_recon')
  eq('预填了客户名但没填金额的行被当「还没填」', arSheet ? num0(arSheet.count) : -1, 0)
  eq('预填行不报错', arSheet ? num0(arSheet.bad_count) : -1, 0)

  // 收尾：把员工删掉，免得同一库反复跑攒一堆
  const su = await call('GET', '/staff-users')
  for (const u of ((su.d && (su.d.users || su.d.rows)) || [])) {
    if (String(u.name || '').indexOf(tag) === 0 || String(u.name || '').indexOf('多1') === 0) await call('DELETE', '/staff-users/' + u.id)
  }

  console.log('')
  if (bad.length) { console.log('❌ ' + bad.length + ' 项失败：'); bad.forEach((x) => console.log('   · ' + x)); process.exit(1) }
  console.log('✅ 全部 ' + pass + ' 项通过')
}

main().catch((e) => { console.error('测试崩了：', e); process.exit(1) })
