#!/usr/bin/env node
// 开账向导回归：一屏把「账户余额 / 默认账期 / 期初应收 / 期初应付」填完
//   node scripts/test-onboarding.mjs [--base http://127.0.0.1:8791] [--key 8888]
//
// 为什么要有这个测试：这四件事以前分散在三个页面，第一次上手的人（只做流水的小财务）
// 会卡在「不知道该去哪填」，开账就废了。向导把四块合成一次提交，最容易坏的正是「一次提交」
// 这件事本身：漏写一块、重复点翻倍、金额解析错、账户余额被累加而不是设成实际数。
//
// 注意：会把测试库的账户期初改成脚本里的数字（语义就是「设成现在有多少钱」），
// 所以只在新建的空库或测试库上跑，别对着有真实数据的库跑。
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d
}
const BASE = arg('base', 'http://127.0.0.1:8791').replace(/\/+$/, '')
const KEY = arg('key', '8888')
const H = { 'content-type': 'application/json', 'X-Access-Key': KEY }
const TAG = '向导' + Date.now().toString(36).replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]).slice(-4)

let bad = 0
const ok = (cond, msg, extra) => {
  if (cond) return console.log('  ✅ ' + msg)
  bad++
  console.log('  ❌ ' + msg + (extra === undefined ? '' : ' → ' + JSON.stringify(extra)))
}
const get = async (p, opt) => {
  const r = await fetch(BASE + p, opt)
  const t = await r.text()
  let d = {}
  try { d = JSON.parse(t) } catch (e) { d = { raw: t.slice(0, 200) } }
  return { s: r.status, d }
}
const post = (p, body) => get(p, { method: 'POST', headers: H, body: JSON.stringify(body || {}) })

const wait = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/onboarding', { headers: H }); if (r.status) return } catch (e) {}
    await new Promise((s) => setTimeout(s, 1000))
  }
  throw new Error('服务没起来：' + BASE)
}

const main = async () => {
  await wait()
  const setup = await post('/auth/setup', { key: KEY })
  if (setup.s !== 200 && setup.s !== 400) ok(false, '设置口令', setup)

  const before = (await get('/onboarding', { headers: H })).d
  ok(typeof before.total === 'number' && before.total === 4, '开账引导是 4 步', before)
  if (before.done === 0) ok(before.all_done === false, '空账本开账前不是「全部完成」', before)

  const accs = (await get('/accounts', { headers: H })).d.accounts || []
  ok(accs.length >= 2, '自动建了账户（现金/银行卡…）', accs.map((a) => a.name))
  const cash = accs[0]
  const bank = accs[1]

  // 1) 一次提交四块
  const r = await post('/onboarding/apply', {
    accounts: [{ id: cash.id, opening: 3000 }, { id: bank.id, opening: 20000 }],
    term: 30,
    ar_text: TAG + '客户甲 12000\n' + TAG + '客户乙,8000\n' + TAG + '客户丙，5000元',
    ap_text: TAG + '供应商甲 6000\n' + TAG + '供应商乙\t4000'
  })
  ok(r.s === 200 && r.d.ok === true, '一次提交返回成功', r)
  ok(r.d.accounts === 2 && r.d.term === 30, '账户 2 个、账期 30 天都写进去了', r.d)
  ok(r.d.ar === 3 && r.d.ap === 2, '期初应收 3 家、应付 2 家都写进去了', r.d)

  // 2) 引导状态翻成全部完成
  const after = (await get('/onboarding', { headers: H })).d
  ok(after.all_done === true && after.done === 4, '四步全完成', after)
  ok(after.default_term === 30, '默认账期读回来是 30', after.default_term)
  ok(after.opening >= 23000, '账户余额合计已算上（≥23000）', after.opening)

  // 3) 账户期初是「设」不是「加」
  const a2 = (await get('/accounts', { headers: H })).d.accounts || []
  ok(Number((a2.find((a) => a.id === cash.id) || {}).opening) === 3000, '现金期初 = 3000（不是累加）')
  ok(Number((a2.find((a) => a.id === bank.id) || {}).opening) === 20000, '银行卡期初 = 20000')

  // 4) 期初欠款真的进了账，且标成「期初应收/应付」
  const arRaw = (await get('/ar', { headers: H })).d
  const arList = Array.isArray(arRaw) ? arRaw : arRaw.rows || []
  const mineAr = arList.filter((x) => String(x.customer || '').indexOf(TAG) === 0)
  ok(mineAr.length === 3, '应收里能看到 3 家期初', mineAr.length)
  ok(mineAr.every((x) => x.item_name === '期初应收'), '都标成「期初应收」', mineAr.map((x) => x.item_name))
  ok(mineAr.some((x) => String(x.customer).indexOf('客户丙') > 0 && Number(x.price) === 5000), '「5000元」这种带「元」的也认', mineAr.map((x) => x.customer + ':' + x.price))
  const apRaw = (await get('/ap', { headers: H })).d
  const apList = Array.isArray(apRaw) ? apRaw : apRaw.rows || []
  ok(apList.filter((x) => String(x.supplier || '').indexOf(TAG) === 0).length === 2, '应付里能看到 2 家期初')

  // 5) 重复点不会翻倍
  const r2 = await post('/onboarding/apply', {
    accounts: [{ id: cash.id, opening: 3000 }], term: 30,
    ar_text: TAG + '客户甲 12000', ap_text: TAG + '供应商甲 6000'
  })
  ok(r2.s === 200 && r2.d.ar === 0 && r2.d.ap === 0, '重复提交不再新增（跳过同名同额）', r2.d)
  const arRaw2 = (await get('/ar', { headers: H })).d
  const arList2 = Array.isArray(arRaw2) ? arRaw2 : arRaw2.rows || []
  ok(arList2.filter((x) => String(x.customer) === TAG + '客户甲').length === 1, '客户甲仍然只有一张单')
  const a3 = (await get('/accounts', { headers: H })).d.accounts || []
  ok(Number((a3.find((a) => a.id === cash.id) || {}).opening) === 3000, '再提交一次余额不会翻倍')

  // 6) 填完之后账本自检还是干净的
  const sc = (await get('/selfcheck', { headers: H })).d
  ok(sc.ok === true, '账本自检 10 类全 0', sc.bad)
  const dash = await get('/dashboard', { headers: H })
  ok(dash.s === 200, '/dashboard 正常', dash.s)

  console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error('❌ ' + (e && e.message ? e.message : e)); process.exit(1) })
