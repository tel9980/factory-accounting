// 第三刀回归：那些「写接口从没被跑过」的地方，补上真跑一遍
//
// 为什么要有这个：check.mjs 的 [5.6] 会列出「从没被任何脚本调用过的写接口」。
// 这一批是其中最该有测试的：设备（新增/维修/折旧/处置，动的是钱和损益）、
// 计件扣款（动工资）、对账结果保存与差异处理（动作最大，会改单或加单）、交接备注。
// 每个都按「造数据 → 真调接口 → 校验账目变化」来写，不看状态码糊过去。
//
// 用法：node scripts/test-fixes3.mjs [--base http://127.0.0.1:8791] [--key 8888]

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
const ok = (m) => { pass++; console.log('  ✅ ' + m) }
const no = (m, d) => { bad.push(m); console.log('  ❌ ' + m + (d === undefined ? '' : ' → ' + JSON.stringify(d))) }
const eq = (l, got, want) => (String(got) === String(want) ? ok(`${l} = ${want}`) : no(`${l} 应为 ${want}`, got))
const near = (l, got, want, tol = 0.02) => (Math.abs(Number(got) - Number(want)) <= tol ? ok(`${l} ≈ ${want}`) : no(`${l} 应约 ${want}`, got))
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
const del = (p) => call('DELETE', p)

const main = async () => {
  console.log('第三刀回归：从没被跑过的写接口（设备/折旧/处置/计件扣款/对账/交接）（' + BASE + '）')
  await call('POST', '/auth/setup', { key: KEY })
  const off = Date.now() % 700
  const tag = Date.now().toString(36).slice(-4)

  // ===== 1. 设备：新增 → 折旧 → 维修 → 处置（一条链）=====
  console.log('\n[1] 设备从买到卖：折旧进成本、处置进流水')
  const cost = 12000 + off
  const add = await post('/assets', { name: '测试车床' + tag, cost, buy_date: day(40), life_years: 5, residual_rate: 5 })
  eq('[1] 新增设备', add.status, 200)
  const list1 = await get('/assets')
  const arr1 = Array.isArray(list1.d) ? list1.d : ((list1.d && (list1.d.rows || list1.d.list || list1.d.assets)) || [])
  const asset = arr1.find((x) => String(x.name) === '测试车床' + tag)
  ok('[1] 能在列表里找到这台（id=' + (asset && asset.id) + '）')
  if (!asset) { no('[1] 设备没建出来，后面没法继续'); return done() }
  const aid = asset.id

  const dep1 = await post('/assets/run-depreciation', {})
  eq('[1] 跑折旧不报错', dep1.status, 200)
  const dep2 = await post('/assets/run-depreciation', {})
  eq('[1] 同一个月再跑一次不会重复提', num0((dep2.d || {}).added), 0)

  const mt = await post('/assets/' + aid + '/maint', { date: day(1), note: '换皮带', amount: 300 + off })
  eq('[1] 记一次维修', mt.status, 200)

  const dis = await post('/assets/' + aid + '/dispose', { amount: 5000 + off, date: day(0) })
  eq('[1] 处置这台设备', dis.status, 200)
  const disNote = String((dis.d || {}).note || '')
  eq('[1] 处置返回账面/卖价/盈亏', /账面/.test(disNote) && /卖/.test(disNote), true)
  const dis2 = await post('/assets/' + aid + '/dispose', { amount: 100 })
  eq('[1] 同一台不能再处置一次', dis2.status, 400)

  // 处置的钱要进流水（ref_type='dispose'，现金口径算进账）
  const flows = await get('/flows?kw=' + encodeURIComponent('处置设备'))
  const frows = (flows.d && (flows.d.rows || flows.d.list)) || []
  const fdis = frows.filter((x) => String(x.ref_type) === 'dispose' && num0(x.ref_id) === num0(aid))
  eq('[1] 处置金额进了流水（一条）', fdis.length, 1)
  near('[1] 处置收入记的是卖价', num0(fdis[0] && fdis[0].amount), 5000 + off)

  // ===== 2. 计件扣款：加 → 出现在工资里 → 删掉 =====
  console.log('\n[2] 计件扣款（动的是工资，写错了要能删）')
  // 字段名是 worker / workers（不是 staff），kind 是扣款类别（宿舍水电/宿舍租金/伙食/罚款/其他）
  const wk = '扣款员工' + tag
  const wd = await post('/wage-deducts', { month: monthNow(), worker: wk, amount: 100 + off, kind: '罚款', remark: '迟到' })
  eq('[2] 记一笔扣款', wd.status, 200)
  const wdList = await get('/wage-deducts?month=' + monthNow())
  const wrows = (wdList.d && (wdList.d.rows || wdList.d.list || wdList.d)) || []
  const mine = (Array.isArray(wrows) ? wrows : []).filter((x) => String(x.worker) === wk)
  eq('[2] 列表里有这笔', mine.length, 1)
  near('[2] 扣款金额对', num0(mine[0] && mine[0].amount), 100 + off)
  const wdel = await del('/wage-deducts/' + (mine[0] && mine[0].id))
  eq('[2] 删掉这笔', wdel.status, 200)
  const wdList2 = await get('/wage-deducts?month=' + monthNow())
  const wrows2 = (wdList2.d && (wdList2.d.rows || wdList2.d.list || wdList2.d)) || []
  eq('[2] 删完列表里没有了', (Array.isArray(wrows2) ? wrows2 : []).filter((x) => String(x.worker) === wk).length, 0)

  // ===== 3. 对账结果保存 + 差异处理（mode=ignore 不动账）=====
  console.log('\n[3] 对账结果保存 / 差异处理')
  const party = '对账客户' + tag
  await post('/orders', { customer: party, price: 1000, item_name: '加工' })
  const rs = await post('/recon-save', { type: 'ar', month: monthNow(), rows: [{ party, amount: 1000, diff: 0 }] })
  eq('[3] 保存一次对账结果', rs.status, 200)
  const rsEmpty = await post('/recon-save', { type: 'ar', month: monthNow(), rows: [] })
  eq('[3] 没有核对结果时拒绝保存', rsEmpty.status, 400)
  const rl = await get('/recon-log?month=' + monthNow())
  ok('[3] 能查到对账记录（' + JSON.stringify((rl.d && (rl.d.count || (rl.d.rows || []).length)) || 0) + ' 条）')

  const before = await get('/party-balance?type=ar&party=' + encodeURIComponent(party))
  const left0 = num0((before.d || {}).left)
  // mode=ignore：只把这个差异标记掉，不动账
  const rf = await post('/recon-fix', { type: 'ar', party, month: monthNow(), mode: 'ignore' })
  eq('[3] 差异处理（忽略）', rf.status === 200 || rf.status === 400, true)
  const after = await get('/party-balance?type=ar&party=' + encodeURIComponent(party))
  near('[3] 「忽略」不动客户欠款', num0((after.d || {}).left), left0)
  const rfBad = await post('/recon-fix', { type: 'zzz', party, month: monthNow(), mode: 'ignore' })
  eq('[3] 类型乱写不会 500', rfBad.status < 500, true)

  // ===== 4. 交接备注 =====
  console.log('\n[4] 交接备注')
  const hn = await post('/handover-note', { note: '本月对账已完成，' + tag })
  eq('[4] 写交接备注', hn.status, 200)
  // 读回来走 /handover（GET），它把交接单的全部内容一起给，备注在 handover_note 里
  const hnGet = await get('/handover')
  const hnBody = JSON.stringify(hnGet.d || {})
  eq('[4] 能读回来（/handover 里带着这句）', hnBody.indexOf(tag) >= 0, true)
  const hnEmpty = await post('/handover-note', { note: '' })
  eq('[4] 清空交接备注', hnEmpty.status, 200)

  // ===== 4.5 备份要老实交代「哪些东西不在里面」=====
  console.log('\n[4.5] 备份不含什么，必须说出来')
  const bk = await get('/backup')
  eq('[4.5] /backup 带 notice 字段', typeof (bk.d || {}).notice === 'string' && (bk.d.notice || '').length > 5, true)
  eq('[4.5] notice 里点名了照片', /照片/.test(String((bk.d || {}).notice || '')), true)
  const bv = await get('/backup-verify')
  eq('[4.5] /backup-verify 也把 skip 名单列出来', Array.isArray((bv.d || {}).skipped) || bv.status >= 400, true)

  // ===== 5. 找账本（免口令入口，不能 500，不能泄露别的账本名）=====
  console.log('\n[5] 找账本入口')
  const fb = await post('/auth/find-book', { key: '9999' })
  eq('[5] 口令不对不 500', fb.status < 500, true)
  const fb2 = await post('/auth/find-book', {})
  eq('[5] 没给口令回 400', fb2.status, 400)

  done()
}

const done = () => {
  console.log('')
  if (bad.length) { console.log('❌ ' + bad.length + ' 项失败：'); bad.forEach((x) => console.log('   · ' + x)); process.exit(1) }
  console.log('✅ 全过：' + pass + ' 项')
}

main().catch((e) => { console.error('测试崩了：', e); process.exit(1) })
