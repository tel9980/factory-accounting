#!/usr/bin/env node
// 演示口令（只读）的回归测试。
// 为什么要有这个：小程序审核被「登录受限（3.3）」驳回——审核员拿不到口令进不去，
// 就没法「完整体验功能」。给一个只读的演示口令能解决，但只读必须真的是只读：
// 能看、不能改、不能导出，更不能拿它去改口令或者看备份。
//
// 另外还有「内置演示口令」（demo-look）：不用老板设、登录页点一下就进，进的是第 3 本账的
// 示例数据，可以随便记（不碰真账），但导出/备份/改设置照样不给。
//
// 用法：node scripts/test-demo.mjs --base http://127.0.0.1:8791 --key 8888
import process from 'node:process'

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const BASE = arg('base', 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = arg('key', '8888')
const DEMO = arg('demo', 'demo1234')

let bad = 0
const ok = (msg) => console.log('  ✅ ' + msg)
const no = (msg, extra) => { bad++; console.log('  ❌ ' + msg + (extra !== undefined ? ' ' + JSON.stringify(extra) : '')) }
const eq = (name, got, want) => (got === want ? ok(`${name} = ${want}`) : no(`${name} 应为 ${want} → ${got}`))

async function call(method, path, body, key, book) {
  const opt = { method, headers: { 'x-access-key': key || KEY } }
  if (book) opt.headers['x-book'] = String(book)
  if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body) }
  const r = await fetch(BASE + path, opt)
  const text = await r.text()
  let data = text
  try { data = JSON.parse(text) } catch (e) { /* 非 JSON 保留原文 */ }
  return { s: r.status, d: data }
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/health-print'); if (r.status < 500) return true } catch (e) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

async function main() {
  if (!await waitUp()) { console.log('❌ 后端没起来：' + BASE); process.exit(1) }
  console.log('演示口令（只读）：' + BASE)

  // 先确保老板口令是已知的：CI 里是新库，第一次要 /auth/setup
  const probe = await call('GET', '/ar', undefined, KEY)
  if (probe.s === 401) {
    const su = await call('POST', '/auth/setup', { key: KEY }, KEY)
    if (!su.d || !su.d.ok) { console.log('❌ 设老板口令失败：' + JSON.stringify(su.d)); process.exit(1) }
    ok('新建库设好了老板口令')
  }

  // 1) 关掉演示时，演示口令进不来
  const off0 = await call('POST', '/auth/demo', { key: KEY, password: '' })
  eq('先关掉演示模式', off0.s, 200)
  const before = await call('GET', '/me', undefined, DEMO)
  eq('没开演示时演示口令进不来', before.s, 401)
  eq('…错误码是 bad_key', before.d && before.d.code, 'bad_key')

  // 2) 设演示口令
  const set = await call('POST', '/auth/demo', { key: KEY, password: DEMO })
  eq('设演示口令', set.s, 200)
  eq('…返回已开启', set.d && set.d.enabled, true)
  const st = await call('POST', '/auth/demo-state', { key: KEY })
  eq('老板能查到演示口令开着', st.d && st.d.enabled, true)

  // 3) 演示口令能看
  const meD = await call('GET', '/me', undefined, DEMO)
  eq('演示口令能登录', meD.s, 200)
  eq('…身份是 demo', meD.d && meD.d.role, 'demo')
  eq('…不应把 demo_enabled 泄露给演示身份', meD.d && meD.d.demo_enabled, false)
  const arD = await call('GET', '/ar', undefined, DEMO)
  eq('演示口令能看应收', arD.s, 200)
  const dashD = await call('GET', '/dashboard', undefined, DEMO)
  eq('演示口令能看首页', dashD.s, 200)
  const modD = await call('GET', '/modules', undefined, DEMO)
  eq('演示口令能看模块开关清单', modD.s, 200)

  // 4) 演示口令不能改账
  const w1 = await call('POST', '/orders', { customer: '演示越权', price: 1 }, DEMO)
  eq('演示口令不能记应收', w1.s, 403)
  eq('…错误码是 demo_readonly', w1.d && w1.d.code, 'demo_readonly')
  const w2 = await call('POST', '/expenses', { amount: 1, category: '其他' }, DEMO)
  eq('演示口令不能记支出', w2.s, 403)
  const w3 = await call('PATCH', '/orders/1', { price: 1 }, DEMO)
  eq('演示口令不能改单', w3.s, 403)
  const w4 = await call('DELETE', '/orders/1', undefined, DEMO)
  eq('演示口令不能删单', w4.s, 403)

  // 5) 演示口令不能把数据导走 / 看备份 / 动口令
  for (const p of ['/backup', '/backup-verify', '/export-all', '/staff-users', '/schema-check']) {
    const r = await call('GET', p, undefined, DEMO)
    eq('演示口令不能看 ' + p, r.s, 403)
  }
  const w5 = await call('POST', '/auth/change', { old_key: DEMO, new_key: 'hacked' }, DEMO)
  if (w5.s < 400) no('演示口令竟然能改口令', w5.d); else ok('演示口令不能改口令（' + w5.s + '）')

  // 6) 老板口令一切照旧（别把老板也拦了）
  const arO = await call('GET', '/ar', undefined, KEY)
  eq('老板口令照常能看应收', arO.s, 200)
  const meO = await call('GET', '/me', undefined, KEY)
  eq('老板身份还是 owner', meO.d && meO.d.role, 'owner')
  eq('老板能看到演示口令开着', meO.d && meO.d.demo_enabled, true)
  const wO = await call('POST', '/expenses', { amount: 1, category: '其他', remark: '演示口令测试', confirm_dup: true }, KEY)
  if (wO.s >= 400) no('老板反而写不进去了', wO.d); else ok('老板照常能记账')

  // 7) 关掉之后演示口令立刻失效
  const off1 = await call('POST', '/auth/demo', { key: KEY, password: '' })
  eq('关掉演示模式', off1.d && off1.d.enabled, false)
  const after = await call('GET', '/ar', undefined, DEMO)
  eq('关掉后演示口令进不来', after.s, 401)
  const meAfter = await call('GET', '/me', undefined, KEY)
  eq('…老板那边显示未开启', meAfter.d && meAfter.d.demo_enabled, false)

  // 8) 不能和老板口令/员工口令撞
  const same = await call('POST', '/auth/demo', { key: KEY, password: KEY })
  eq('演示口令不能和老板口令一样', same.s, 400)
  const short = await call('POST', '/auth/demo', { key: KEY, password: '123' })
  eq('演示口令至少 4 位', short.s, 400)
  const notBoss = await call('POST', '/auth/demo', { key: 'whatever', password: DEMO })
  eq('非老板口令设不了演示口令', notBoss.s, 403)

  // 9) 内置演示口令（不用老板设）：进第 3 本账的示例数据，能看能试，危险动作不给
  const BUILTIN = 'demo-look'
  const bMe = await call('GET', '/me', undefined, BUILTIN)
  eq('内置演示能直接进（不用设口令）', bMe.s, 200)
  eq('…身份是 demo', bMe.d && bMe.d.role, 'demo')
  eq('…进的是第 3 本账', String(bMe.d && bMe.d.book), '3')
  const bAr = await call('GET', '/ar', undefined, BUILTIN)
  eq('…能看演示账套的应收', bAr.s, 200)
  const bList = Array.isArray(bAr.d) ? bAr.d : (bAr.d && bAr.d.list) || []
  const hasDemo = bList.some((x) => String(x.customer || '').startsWith('演示·'))
  if (hasDemo) ok(`…演示账套里有示例单（${bList.length} 张）`)
  else no('演示账套没有种子数据（示例单应为「演示·」开头）', bList.length)
  const bDash = await call('GET', '/dashboard', undefined, BUILTIN)
  eq('…能看演示账套首页', bDash.s, 200)
  // 审核员要能真点一下「记一笔」，所以演示账套允许写（写进第 3 本账，不碰真账）
  const TAG = '演示·审核试记' + Date.now().toString(36).replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]).slice(-4)
  const bW = await call('POST', '/orders', { customer: TAG, price: 100, item_name: '试试' }, BUILTIN)
  if (bW.s >= 400) no('演示账套应该允许试记一笔（不然审核员还是「体验受限」）', bW.d); else ok('…演示账套里可以试记一笔（沙箱）')
  // 但导出/备份/改设置不给
  for (const p of ['/backup', '/export-all', '/staff-users', '/schema-check']) {
    const r = await call('GET', p, undefined, BUILTIN)
    eq('内置演示不能看 ' + p, r.s, 403)
  }
  const bMod = await call('POST', '/modules', { off: [] }, BUILTIN)
  eq('内置演示不能改模块开关', bMod.s, 403)
  // 真账本不能被碰：主账套里不该出现「演示·审核试记」
  const mainAr = await call('GET', '/ar', undefined, KEY)
  const mainList = Array.isArray(mainAr.d) ? mainAr.d : (mainAr.d && mainAr.d.list) || []
  if (mainList.some((x) => String(x.customer || '') === TAG)) no('演示账套里记的单跑进真账本了', 1)
  else ok('…真账本没被演示数据污染')
  // 老板可以关掉内置演示入口
  const offB = await call('POST', '/auth/demo-builtin', { key: KEY, off: true })
  eq('老板关掉内置演示入口', offB.d && offB.d.builtin, false)
  const afterOff = await call('GET', '/ar', undefined, BUILTIN)
  eq('关掉后内置演示进不来', afterOff.s, 401)
  const onB = await call('POST', '/auth/demo-builtin', { key: KEY, off: false })
  eq('再打开', onB.d && onB.d.builtin, true)
  const afterOn = await call('GET', '/ar', undefined, BUILTIN)
  eq('打开后又可以进', afterOn.s, 200)

  // 10) 演示账套里不能设权限（微信审核驳回理由之一）
  // 前面已经用内置演示口令进过第 3 本账 → 那边已经种过示例数据（demo_seeded=1）。
  // 现在用老板口令切到第 3 本账，各种权限入口都该被拒。
  const b3Me = await call('GET', '/me', undefined, KEY, 3)
  eq('老板口令也能进第 3 本账', b3Me.s, 200)
  eq('…第 3 本被认出是演示账套', b3Me.d && b3Me.d.demo_book, true)
  for (const p of ['/staff-users', '/staff-perms', '/party-staff']) {
    const r = await call('GET', p, undefined, KEY, 3)
    eq('演示账套不能看 ' + p, r.s, 403)
    eq('…' + p + ' 返回 demo_no_perm', r.d && r.d.code, 'demo_no_perm')
  }
  const suPost = await call('POST', '/staff-users', { name: '演示员工' }, KEY, 3)
  eq('演示账套不能加员工账号', suPost.s, 403)
  const spPost = await call('POST', '/staff-perms', { modules: ['ar'] }, KEY, 3)
  eq('演示账套不能改员工权限', spPost.s, 403)
  const psPost = await call('POST', '/party-staff', { party: '演示·张老板', staff: '小王' }, KEY, 3)
  eq('演示账套不能把客户分给员工', psPost.s, 403)
  const stPost = await call('POST', '/auth/staff', { key: KEY, password: '1234' }, KEY, 3)
  eq('演示账套不能设员工口令', stPost.s, 403)
  // 主账套（真账）照常能用这些入口 —— 别把老板自己拦了
  const mSu = await call('GET', '/staff-users', undefined, KEY, 1)
  eq('真账套照常能看员工账号', mSu.s, 200)
  const mSp = await call('GET', '/staff-perms', undefined, KEY, 1)
  eq('真账套照常能看员工权限', mSp.s, 200)
  const mPs = await call('GET', '/party-staff', undefined, KEY, 1)
  eq('真账套照常能看客户分给员工', mPs.s, 200)

  console.log(bad ? `\n❌ 演示口令：${bad} 项没过` : '\n✅ 演示口令：全部通过（只读真的只读，老板照常）')
  process.exit(bad ? 1 : 0)
}

main().catch((e) => { console.log('❌ ' + (e && e.message)); process.exit(1) })
