// 整批撤回回归（导错了要能退回去，而且只退这一批）
//
// 为什么要有这个：日常台账是「下载模板 → 填 → 传」，填错、传错、传两遍都会发生。
// 以前能整批撤的只有应收、应付、支出、借支四类；报销和付房东导错了只能一条条手删，
// 而且报销还得记着把借支的「已用」退回去 —— 十有八九漏掉，员工的借支余额就永远对不上。
// 这个测试钉住：
//
//   1. 报销导错了能整批撤：流水删掉，借支的「已用」一起退回去（两头都要退）
//   2. 付房东导错了能整批撤：预付单 + 它摊出来的摊销流水一起删（成本不能凭空留着）
//   3. 撤完再撤一次：直接说「已经撤回过」，不会又删一遍别人的账
//   4. 已结账月份的不许撤（那个月的账封了，删了跟月报对不上）
//   5. 不能撤的类型（账户期初）老实说「不支持」，而不是假装撤了
//   6. 导入记录列表要标出「这一批现在还能不能撤」
//
// 用法：node scripts/test-undo.mjs [--base http://127.0.0.1:8791] [--key 8888]

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

const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
const thisMonth = () => today().slice(0, 7)

// 找某一类最新的一批导入记录
const lastLog = async (type) => {
  const r = await call('GET', '/import-log')
  const rows = (r.d && r.d.rows) || []
  return rows.filter((x) => String(x.type) === type).sort((a, b) => num0(b.id) - num0(a.id))[0] || null
}
const loanOf = async (staff) => {
  const r = await call('GET', '/loans')
  return (((r.d && r.d.staff) || []).find((x) => x.staff === staff)) || null
}
const flows = async (kw) => {
  const r = await call('GET', '/flows?kw=' + encodeURIComponent(kw))
  return (r.d && (r.d.rows || r.d.list)) || []
}

const main = async () => {
  console.log('整批撤回：报销 / 付房东 导错了要能整批退（' + BASE + '）')
  await call('POST', '/auth/setup', { key: KEY })
  const tag = 'un' + String(Date.now()).slice(-5)
  const STAFF = tag + '甲'

  // ===== 1. 报销整批撤：流水要删，借支「已用」也要退 =====
  const lo = await call('POST', '/loans', { staff: STAFF, amount: 1000, remark: '买辅料' })
  eq('建借支 1000', lo.status, 200)
  let st = await loanOf(STAFF)
  eq('借支已用（导之前）', num0(st && st.used), 0)

  const im = await call('POST', '/import', { type: 'reimb', text: `${STAFF},300,采购,买螺丝` })
  eq('导入报销 300', im.status, 200)
  eq('导入条数', num0(im.d && im.d.imported), 1)
  st = await loanOf(STAFF)
  eq('借支已用（导之后）', num0(st && st.used), 300)
  eq('借支还欠', num0(st && st.remain), 700)
  let fl = await flows(STAFF)
  eq('多了一笔报销流水', fl.filter((x) => x.ref_type === 'expense' && num0(x.amount) === 300).length, 1)

  const lg1 = await lastLog('reimb')
  if (!lg1) no('找不到报销的导入记录')
  else {
    eq('这一批标着「能撤」', lg1.can_undo, true)
    ge('记下了要撤的行数', num0(lg1.ids_count), 1)
    const det = await call('GET', '/import-log/' + lg1.id)
    eq('明细里能看到这笔报销', num0(det.d && det.d.found), 1)
    eq('明细里也标着「能撤」', det.d && det.d.can_undo, true)

    const un1 = await call('POST', '/import-undo/' + lg1.id)
    eq('撤回状态', un1.status, 200)
    eq('撤回条数', num0(un1.d && un1.d.deleted), 1)
    eq('undone_rows', num0(un1.d && un1.d.undone_rows), 1)
    st = await loanOf(STAFF)
    eq('借支已用退回去了', num0(st && st.used), 0)
    eq('借支还欠恢复 1000', num0(st && st.remain), 1000)
    fl = await flows(STAFF)
    eq('那笔报销流水没了', fl.filter((x) => x.ref_type === 'expense' && num0(x.amount) === 300).length, 0)
    eq('借支那条流水还在（不该连坐）', fl.filter((x) => x.ref_type === 'loan').length, 1)

    // ===== 3. 撤第二次：不许再删一遍 =====
    const un2 = await call('POST', '/import-undo/' + lg1.id)
    eq('第二次撤回被拦（状态）', un2.status, 400)
    eq('第二次撤回说明', /已经撤回/.test(String((un2.d || {}).error || '')), true)
    const lg1b = await lastLog('reimb')
    eq('列表里这批变成「已撤回」', num0(lg1b && lg1b.undone), 1)
    eq('列表里这批不再标「能撤」', lg1b && lg1b.can_undo, false)
  }

  // ===== 2. 付房东整批撤：预付单 + 摊销流水一起删 =====
  const PNAME = tag + '房租'
  const im2 = await call('POST', '/import', { type: 'prepaid', text: `${PNAME},12000,1,厂房租金,${today()},测试` })
  eq('导入付房东 12000', im2.status, 200)
  eq('导入条数', num0(im2.d && im2.d.imported), 1)
  const pps = await call('GET', '/prepaids')
  const pp = ((pps.d && pps.d.prepaids) || []).find((x) => x.name === PNAME)
  eq('库里有了这笔预付', !!pp, true)
  const pid = num0(pp && pp.id)
  const fl2 = await call('GET', '/flows')
  const all2 = (fl2.d && (fl2.d.rows || fl2.d.list)) || []
  eq('有一笔付出的钱', all2.filter((x) => x.ref_type === 'prepaid' && num0(x.ref_id) === pid).length, 1)
  ge('还摊出了一笔摊销', all2.filter((x) => x.ref_type === 'amort' && num0(x.ref_id) === pid).length, 1)

  const lg2 = await lastLog('prepaid')
  if (!lg2) no('找不到付房东的导入记录')
  else {
    eq('这批付房东标着「能撤」', lg2.can_undo, true)
    const un3 = await call('POST', '/import-undo/' + lg2.id)
    eq('撤回状态', un3.status, 200)
    eq('撤回条数', num0(un3.d && un3.d.deleted), 1)
    const pps2 = await call('GET', '/prepaids')
    eq('预付单没了', ((pps2.d && pps2.d.prepaids) || []).filter((x) => x.name === PNAME).length, 0)
    const fl3 = await call('GET', '/flows')
    const all3 = (fl3.d && (fl3.d.rows || fl3.d.list)) || []
    const left3 = all3.filter((x) => num0(x.ref_id) === pid && (x.ref_type === 'prepaid' || x.ref_type === 'amort')).length
    eq('它的钱和摊销流水都没了', left3, 0)
  }

  // ===== 4. 已结账月份的不许撤 =====
  const STAFF2 = tag + '乙'
  const im3 = await call('POST', '/import', { type: 'reimb', text: `${STAFF2},200,采购,封账测试` })
  eq('导入一笔报销（封账前）', num0(im3.d && im3.d.imported), 1)
  const lg3 = await lastLog('reimb')
  await call('POST', '/month-lock', { month: thisMonth() })
  const un4 = await call('POST', '/import-undo/' + (lg3 && lg3.id))
  eq('已结账月份撤回：撤掉 0 条', num0(un4.d && un4.d.deleted), 0)
  eq('已结账月份撤回：跳过 1 条', num0(un4.d && un4.d.skipped), 1)
  eq('并说清为什么', /已结账/.test(String((un4.d || {}).reason || '')), true)
  const fl4 = await flows(STAFF2)
  eq('那笔流水没被删', fl4.filter((x) => x.ref_type === 'expense' && num0(x.amount) === 200).length, 1)
  await call('DELETE', '/month-lock/' + thisMonth())

  // ===== 5. 不支持的类型老实说「不支持」=====
  const ACC = tag + '现金'
  const im4 = await call('POST', '/import', { type: 'acc_open', text: `${ACC},3000` })
  eq('导入账户期初', im4.status, 200)
  const lg4 = await lastLog('acc_open')
  eq('账户期初不标「能撤」', lg4 && lg4.can_undo, false)
  const un5 = await call('POST', '/import-undo/' + (lg4 && lg4.id))
  eq('硬撤也被拦（状态）', un5.status, 400)
  eq('说明里有「不支持」', /不支持/.test(String((un5.d || {}).error || '')), true)

  console.log('')
  if (bad.length) { console.log('❌ ' + bad.length + ' 项失败：'); bad.forEach((x) => console.log('   · ' + x)); process.exit(1) }
  console.log('✅ 全部 ' + pass + ' 项通过')
}

main().catch((e) => { console.error('测试崩了：', e); process.exit(1) })
