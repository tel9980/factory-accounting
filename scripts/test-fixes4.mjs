// 第三刀剩下的五条（C21 C22 C25 B10 A6）的回归测试
//
// 这一批是「换系统第一天」和「每天打客户名」相关的：
//   C21 客户名不用手打全称：/party-pick 给候选（精确 / 去后缀近似 / 档案里的）
//   C22 应收页的记账表单默认收起，常用客户和候选都在上面（静态护栏：模板里有这些开关）
//   C25 固定资产 / 材料期初 / 计件单价 / 信用额度 / 框架价 五类能一次导入
//       （以前只能在界面一条条敲；而且「期初资料」不该被月结锁挡住）
//   B10 备份异地副本 + 一次导出所有账本
//   A6  预收定金进家底（客户先打来的钱是负债）、对账单要写出来
//
// 用法：node scripts/test-fixes4.mjs [--base http://127.0.0.1:9401] [--key 8888]

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
const yes = (label, cond, detail) => (cond ? ok(label) : no(label, detail))
const num0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const day = (back) => {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  d.setUTCDate(d.getUTCDate() - (back || 0))
  return d.toISOString().slice(0, 10)
}
const month = () => day(0).slice(0, 7)

const call = async (method, p, body) => {
  const r = await fetch(BASE + p, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let d = null
  try { d = await r.json() } catch (e) { d = null }
  return { s: r.status, d }
}
const get = (p) => call('GET', p)
const post = (p, b) => call('POST', p, b === undefined ? {} : b)

const root = path.resolve(import.meta.dirname, '..')
const feSrc = fs.readFileSync(path.join(root, 'frontend/pages/index/index.js'), 'utf8')
const feWxml = fs.readFileSync(path.join(root, 'frontend/pages/index/index.wxml'), 'utf8')
const beSrc = fs.readFileSync(path.join(root, 'backend/index.js'), 'utf8')

// 名字里不能带数字：一句话记账会把数字当金额剥掉（第一刀踩过这个坑）
const TAG = Array.from({ length: 4 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')
const CUST = '甲测试钟表行' + TAG
const CUST2 = '乙测试螺丝厂' + TAG
const SUP = '丙测试钢材商' + TAG

const main = async () => {
  console.log('== [1] C21 客户名候选（/party-pick）')
  await post('/orders', { customer: CUST, item_name: '外壳加工', price: 1200, due_date: day(-7) })
  await post('/orders', { customer: CUST2, item_name: '螺丝', price: 800, due_date: day(-7) })
  await post('/payables', { supplier: SUP, amount: 900, remark: '钢材' })

  const p1 = await get('/party-pick?type=ar&kw=' + encodeURIComponent('钟表'))
  yes('打「钟表」两个字就能带出客户', p1.s === 200 && (p1.d.list || []).some((x) => x.name === CUST), p1.d)
  yes('候选里带「这家欠了多少/几单」', (p1.d.list || []).some((x) => x.name === CUST && num0(x.cnt) >= 1), p1.d.list)

  const p2 = await get('/party-pick?type=ar&kw=' + encodeURIComponent('甲测试钟表行' + TAG + '有限公司'))
  yes('打了全称（多了「有限公司」）也能认出来', (p2.d.list || []).some((x) => x.name === CUST && x.hit === 'near'), p2.d.list)

  const p3 = await get('/party-pick?type=ar')
  yes('不打字时给「最近用过的」', (p3.d.list || []).length >= 2, (p3.d.list || []).length)

  const p4 = await get('/party-pick?type=ap&kw=' + encodeURIComponent('钢材'))
  yes('供应商那边同一条路（type=ap）', p4.s === 200 && (p4.d.list || []).some((x) => x.name === SUP), p4.d)

  console.log('== [2] C22 表单默认收起（静态护栏）')
  yes('前端真的去问了 /party-pick', feSrc.indexOf('/party-pick?type=ar&kw=') >= 0)
  yes('有「是这家吗」候选列表方法 pickSugName', feSrc.indexOf('pickSugName') >= 0)
  yes('有收起/展开开关 toggleO', feSrc.indexOf('toggleO(') >= 0)
  yes('预收/批量核销有独立展开开关 toggleArOther', feSrc.indexOf('toggleArOther') >= 0)
  yes('常用客户「还有 N 个」开关 toggleMoreCust', feSrc.indexOf('toggleMoreCust') >= 0)
  yes('模板里开单表单受 o_open 控制', feWxml.indexOf('o_open') >= 0)
  yes('模板里候选 chips 受 csug 控制', feWxml.indexOf('csug') >= 0)
  yes('模板里预收/批量核销受 ar_other 控制', feWxml.indexOf('ar_other') >= 0)
  yes('「记一笔应收」按钮在表单收起时出现', feWxml.indexOf('记一笔应收') >= 0)

  console.log('== [3] C25 五类期初资料能一次导入')
  const tpl = await get('/import-template-xlsx?type=asset')
  yes('固定资产模板能下载', tpl.s === 200 && !!tpl.d.b64 && tpl.d.b64.length > 1000, tpl.s)
  const pk = await get('/import-template-pack?tpl=base')
  const sheetsRaw = (pk.d && pk.d.sheets) || []
  const sheets = sheetsRaw.map((x) => (typeof x === 'string' ? x : x.sheet))
  yes('「初始资料」整包能下载', pk.s === 200 && !!pk.d.b64, pk.s)
  yes('整包里有 5 个页签', sheets.length >= 6, sheets)
  ;['固定资产', '材料期初', '计件单价', '信用额度', '框架价'].forEach((n) => {
    yes('整包含页签「' + n + '」', sheets.indexOf(n) >= 0, sheets)
  })

  // 固定资产
  const asName = '测试车床' + TAG
  const a1 = await post('/import', { type: 'asset', text: `名称,原值,购入日,年限,残值率\n${asName},86000,2024-05-01,10,5` })
  eq('固定资产导进 1 台', a1.d.imported, 1)
  const asList = await get('/assets')
  const asRow = ((asList.d.rows) || []).find((x) => x.name === asName)
  yes('列表里能看到这台机器', !!asRow, (asList.d.rows || []).length)
  near('原值对', asRow && asRow.cost, 86000)
  eq('年限对', asRow && asRow.life_years, 10)
  const a2 = await post('/import', { type: 'asset', text: `名称,原值,购入日,年限,残值率\n${asName},86000,2024-05-01,10,5` })
  yes('同一台再导一次不会翻倍', num0(a2.d.imported) === 0 && num0(a2.d.dup_count) >= 1, a2.d)

  // 材料期初
  const matName = '45#圆钢' + TAG
  const m1 = await post('/import', { type: 'material', text: `材料名,单位,数量,单价\n${matName},公斤,800,6.5` })
  eq('材料期初导进 1 条', m1.d.imported, 1)
  const mats = await get('/materials')
  const matRow = (mats.d.materials || mats.d.rows || []).find((x) => x.name === matName)
  yes('材料档案里有这一条', !!matRow, mats.d)
  eq('单位带上了', matRow && matRow.unit, '公斤')
  const mv = await get('/material-moves?material=' + encodeURIComponent(matName))
  const mvRows = mv.d.rows || mv.d.list || []
  near('库存流水记了 800 公斤', mvRows.length ? mvRows[0].qty : 0, 800)

  // 计件单价（「计件工资」模块默认关着，先打开）
  await post('/modules', { off: [] })
  const proc = '车外圆' + TAG
  const w1 = await post('/import', { type: 'wage_rate', text: `工序,单价,单位\n${proc},1.2,件` })
  eq('计件单价导进 1 条', w1.d.imported, 1)
  const wr = await get('/wage-rates')
  yes('计件单价列表里有这一道工序', JSON.stringify(wr.d).indexOf(proc) >= 0, wr.d)

  // 信用额度（设置语义：再导一次是覆盖，不是加）
  const cr1 = await post('/import', { type: 'credit', text: `客户,额度\n${CUST},50000` })
  eq('信用额度导进 1 条', cr1.d.imported, 1)
  const cr2 = await post('/import', { type: 'credit', text: `客户,额度\n${CUST},80000` })
  eq('再导一次也成功（覆盖）', cr2.d.imported, 1)
  const cl = await get('/credit-limits')
  const clRows = (cl.d.limits || []).filter((x) => x.party === CUST)
  eq('同一个人只有一条额度', clRows.length, 1)
  near('额度被改成新的 80000', clRows.length ? clRows[0].limit_amount : 0, 80000)

  // 框架价
  const fr1 = await post('/import', { type: 'frame', text: `客户,产品,单价,起始日\n${CUST},外壳加工,12.5,2026-01-01` })
  eq('框架价导进 1 条', fr1.d.imported, 1)
  const fp = await get('/frame-prices')
  yes('框架价列表里有这条协议', JSON.stringify(fp.d).indexOf(CUST) >= 0, fp.d)

  // 期初资料不该被月结锁挡住（锁的是这个月的账，不是这台机器）
  await post('/month-lock', { month: month() })
  const asName2 = '测试空压机' + TAG
  const a3 = await post('/import', { type: 'asset', text: `名称,原值,购入日,年限,残值率\n${asName2},12000,,5,` })
  eq('本月已结账，设备照样能补录', a3.d.imported, 1)
  const a4 = await post('/orders', { customer: CUST, item_name: '外壳加工', price: 500 })
  yes('但这个小票记应收照样被挡', a4.s >= 400, a4.d)
  await call('DELETE', '/month-lock/' + month())

  console.log('== [4] B10 备份异地副本 / 一次导出所有账本')
  const ea = await get('/export-all?all=1')
  yes('一次导出所有账本', ea.s === 200 && ea.d.kind === 'factory-accounting-multi', ea.d && ea.d.kind)
  yes('导出结果里不止一本', (ea.d.books || []).length >= 2, (ea.d.books || []).length)
  yes('每本都带自己的账套号和数据包', (ea.d.books || []).every((b) => b.book_id && b.pkg && b.pkg.tables), (ea.d.books || []).map((b) => b.book_id))
  const single = await get('/export-all')
  yes('不带 all 还是只导当前这本（老行为不变）', single.s === 200 && single.d.book_id && !single.d.books, single.d && single.d.book_id)
  const nz = await post('/backup-to-notes', { all: true })
  yes('笔记站「全部推一遍」接口在（没配就回失败，但形状对）', Array.isArray(nz.d && nz.d.books), nz.d)

  console.log('== [5] A6 预收定金进家底 / 对账单写出来')
  const nw0 = await get('/networth')
  const before = (nw0.d || []).slice(-1)[0] || {}
  const cash0 = num0(before.cash)
  const net0 = num0(before.net)

  await post('/advances', { type: 'in', party: CUST, amount: 2000, remark: '定金' + TAG })
  const nw1 = await get('/networth')
  const after = (nw1.d || []).slice(-1)[0] || {}
  near('收了 2000 定金，现金多 2000', num0(after.cash) - cash0, 2000)
  near('家底里看得见这笔预收（负债）', num0(after.adv_in) - num0(before.adv_in), 2000)
  near('家底总数不变（钱多了、欠客户的货也多了）', num0(after.net) - net0, 0)

  await post('/advances', { type: 'out', party: SUP, amount: 1000, remark: '预付' + TAG })
  const nw2 = await get('/networth')
  const after2 = (nw2.d || []).slice(-1)[0] || {}
  near('付了 1000 预付，现金少 1000', num0(after2.cash) - num0(after.cash), -1000)
  near('家底里看得见预付（资产）', num0(after2.adv_out) - num0(after.adv_out), 1000)

  const mr = await get('/month-report?month=' + month())
  near('月度归档的家底和首页一致', num0(mr.d.net_worth), num0(after2.net))
  yes('月度归档写明预收多少', String(mr.d.text || '').indexOf('预收') >= 0, String(mr.d.text || '').slice(-200))

  const st = await get('/statement?type=ar&name=' + encodeURIComponent(CUST))
  yes('客户对账单写明「已预收定金 2000」', st.s === 200 && String(st.d.text || '').indexOf('预收定金 2000') >= 0, String(st.d.text || '').slice(0, 300))
  const stp = await get('/statement?type=ap&name=' + encodeURIComponent(SUP))
  yes('供应商对账单写明「已预付 1000」', stp.s === 200 && String(stp.d.text || '').indexOf('已预付 1000') >= 0, String(stp.d.text || '').slice(0, 300))

  yes('后端家底公式里带上了预收预付', beSrc.indexOf('adv_in: advInL') >= 0 || beSrc.indexOf('adv_in: advInL,') >= 0)
  yes('术语表不再说「预付款不计入」', beSrc.indexOf('预付款不计入') < 0)

  // 收尾：把测试造的客户/单据删掉，免得脏库影响后面的断言
  for (const p of [CUST, CUST2]) {
    const r = await get('/ar?kw=' + encodeURIComponent(p))
    const rows = Array.isArray(r.d) ? r.d : (r.d && r.d.rows) || []
    for (const o of rows) await call('DELETE', '/orders/' + o.id)
  }
  const pr = await get('/ap?kw=' + encodeURIComponent(SUP))
  const prows = Array.isArray(pr.d) ? pr.d : (pr.d && pr.d.rows) || []
  for (const x of prows) await call('DELETE', '/payables/' + x.id)

  console.log('\n' + (bad.length ? `❌ ${bad.length} 项没过 / 共 ${pass + bad.length} 项` : `✅ 全部通过（${pass} 项）`))
  if (bad.length) {
    console.log('没过的：')
    bad.forEach((b) => console.log('  - ' + b))
    process.exitCode = 1
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
