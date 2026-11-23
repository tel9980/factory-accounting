#!/usr/bin/env node
// 线上只读体检：部署完之后确认「线上真的活着、表结构是对的、主要页面不 500」。
//
// 为什么不能直接用 smoke.mjs 打线上（第 13 轮 E3）：
//   smoke.mjs 第一步就 `POST /auth/setup` 设口令，而且它自己注释里写着
//   「少数 GET 接口会顺手补建表、写默认值（设计上是幂等的自愈）」—— 那是给本机/测试库用的。
//   拿它打生产等于每次部署都往线上写一遍，万一哪个自愈分支有 bug，就是把线上数据改坏。
//   这里只发 GET，一个写请求都不发；参数只带月份这类过滤条件。
//
// 用法：
//   node scripts/check-live.mjs --base https://jz.qy663.de5.net --key <老板口令>
// 退出码：0 = 全通；1 = 有接口 5xx / 表结构不对 / 版本不通。

const argOf = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const BASE = argOf('base', 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = argOf('key', '')
const TIMEOUT_MS = Number(argOf('timeout', '20000')) || 20000

// 只读路径：全是 GET，不带任何会改数据的动作。
// 带 ?month= 的几个是为了让它们走真实查询分支（不带参数有些会直接返回空壳）。
const nowM = () => {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return d.toISOString().slice(0, 7)
}
const PATHS = [
  '/version',
  '/me',
  '/schema-check',
  '/dashboard',
  '/ar',
  '/ap',
  '/expenses',
  '/cashbook?month=' + nowM(),
  '/report-data?month=' + nowM(),
  '/month-brief?month=' + nowM(),
  '/cash-bridge?month=' + nowM(),
  '/health-check?fresh=1',
  '/selfcheck',
  '/accounts',
  '/modules',
  '/backup-list',
]

const hit = async (p) => {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  const headers = { 'User-Agent': 'factory-accounting-ci/check-live' }
  if (KEY) headers['x-access-key'] = KEY
  try {
    const r = await fetch(BASE + p, { headers, signal: ac.signal })
    const text = await r.text()
    return { status: r.status, text }
  } catch (e) {
    return { status: 0, text: String((e && e.message) || e) }
  } finally { clearTimeout(timer) }
}

const bad = []
const ok = []

const main = async () => {
  console.log('线上只读体检（只发 GET，不写任何数据）：' + BASE)

  // 1) 版本：不打口令也要通，且必须带 commit（线上是 Worker 部署的版本号）
  const v = await hit('/version')
  if (v.status !== 200) {
    console.log('❌ /version 不通：' + v.status + ' ' + v.text.slice(0, 120))
    process.exit(1)
  }
  let vd = {}
  try { vd = JSON.parse(v.text) } catch (e) { vd = {} }
  if (!vd.version) {
    console.log('❌ /version 没有 version 字段：' + v.text.slice(0, 120))
    process.exit(1)
  }
  console.log(`✅ /version = ${vd.version}${vd.commit ? ' / ' + String(vd.commit).slice(0, 12) : '（没带 commit）'}`)
  ok.push('/version')

  if (!KEY) {
    console.log('⚠️ 没给 --key：只验了 /version，其余接口需要口令才能查。这不是「都通过」。')
    process.exit(0)
  }

  // 2) 逐个 GET：只有 200 算过。
  //    第 16 轮 C6：以前只把 0/401/403/404/≥500 当坏，400/409/422 一律算「通过」——
  //    可这几个接口带的是合法参数（月份而已），回 400/422 恰恰说明参数校验或 SQL 写错了，
  //    结果体检打绿、发布继续。现在要求严格 200，非 200 把状态码和响应头一段打出来。
  for (const p of PATHS.slice(1)) {
    const r = await hit(p)
    if (r.status === 0) { bad.push([p, '请求失败：' + r.text.slice(0, 120)]); continue }
    if (r.status === 401 || r.status === 403) { bad.push([p, '口令被拒（HTTP ' + r.status + '）——检查 PROD_KEY 是不是老板口令']); continue }
    if (r.status !== 200) { bad.push([p, 'HTTP ' + r.status + '（应 200）：' + String(r.text || '').slice(0, 160)]); continue }
    ok.push(p)
  }

  // 3) 表结构：ok 必须真的是 true，bad_count 必须 0（以前只判 ok===false 而 ok 恒为 true）
  const sc = await hit('/schema-check')
  if (sc.status === 200) {
    let d = {}
    try { d = JSON.parse(sc.text) } catch (e) { d = {} }
    if (d.ok !== true || Number(d.bad_count || 0) > 0) bad.push(['/schema-check', '线上表结构对不上：' + String(d.text || JSON.stringify(d.books || d)).slice(0, 200)])
    else ok.push('/schema-check（表结构对得上）')
  }

  // 4) 「钱去哪了」：这张表是身份等式（每一类现金进出都有一行 + 兜底行），正常账套残差必须是 0。
  //    生产上要是有人手工改过单据的「已收/已付」，残差或 doc_gap 会不为 0 —— 那是**数据**问题，
  //    不该拦发布（拦了就没法发修数据的新版本），所以这里只提示，不进 bad。
  const cb = await hit('/cash-bridge?month=' + nowM())
  if (cb.status === 200) {
    let d = {}
    try { d = JSON.parse(cb.text) } catch (e) { d = {} }
    const res = Number(d.residual || 0)
    const gap = d.doc_gap || {}
    const gAr = Number(gap.ar || 0), gAp = Number(gap.ap || 0)
    if (Math.abs(res) < 0.01 && Math.abs(gAr) < 0.01 && Math.abs(gAp) < 0.01) console.log('✅ /cash-bridge 残差 0、单据与流水对得上')
    else console.log(`⚠️ /cash-bridge 残差 ${res}、单据差 应收 ${gAr} / 应付 ${gAp} —— 线上账本可能被手工改过（不拦发布，去「账目体检」看明细）`)
  }

  console.log(`\n通过 ${ok.length} 项`)
  if (bad.length) {
    console.log(`❌ 失败 ${bad.length} 项：`)
    for (const [p, why] of bad) console.log(`   · ${p} → ${why}`)
    process.exit(1)
  }
  console.log('✅ 线上只读体检全部通过')
}

main().catch((e) => { console.log('❌ 体检脚本自己崩了：' + String((e && e.message) || e)); process.exit(1) })
