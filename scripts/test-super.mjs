// 超级管理员 / 每账套独立管理员：一个口令管所有账套，每本账也能有自己的管理员
// 跑之前：本机 wrangler dev 要对三本账都灌过 schema.sql（见 DEPLOYMENT.md）
const BASE = (process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = process.argv.includes('--key') ? process.argv[process.argv.indexOf('--key') + 1] : '8888'

let bad = 0
let good = 0
const ok = (name, extra) => { good++; console.log('  ✅ ' + name + (extra ? '（' + extra + '）' : '')) }
const no = (name, extra) => { bad++; console.log('  ❌ ' + name + (extra ? ' → ' + extra : '')) }
const eq = (name, got, want) => (String(got) === String(want) ? ok(name, got) : no(name, '现在是 ' + JSON.stringify(got) + '，应为 ' + JSON.stringify(want)))

async function call(method, path, opts = {}) {
  const headers = { 'content-type': 'application/json' }
  if (opts.key !== null) headers['x-access-key'] = opts.key === undefined ? KEY : opts.key
  if (opts.book) headers['X-Book'] = String(opts.book)
  const r = await fetch(BASE + path, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
  let d = null
  try { d = await r.json() } catch (e) { d = null }
  return { s: r.status, d: d || {} }
}
const wait = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/version'); if (r.ok) return } catch (e) {}
    await new Promise((r) => setTimeout(r, 700))
  }
  throw new Error('服务没起来：' + BASE)
}

const SUPER = 'sp' + Date.now().toString(36).replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]).slice(-4) + '99'
const BOOK2 = 'bk' + Date.now().toString(36).replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]).slice(-4) + '77'

async function main() {
  await wait()
  // 主账套口令（已经有了就当 200）
  await call('POST', '/auth/setup', { key: null, body: { key: KEY } })
  console.log('\n[1] 设超级口令')

  let r = await call('POST', '/auth/super', { body: { key: '0000', password: SUPER } })
  eq('口令不对时设不了', r.s, 403)

  r = await call('POST', '/auth/super', { body: { key: KEY, password: '123' } })
  eq('超级口令太短 → 400', r.s, 400)

  r = await call('POST', '/auth/super', { body: { key: KEY, password: KEY } })
  eq('不能和主账套口令一样 → 400', r.s, 400)

  r = await call('POST', '/auth/super', { body: { key: KEY, password: SUPER } })
  eq('主账套老板口令能设超级口令', r.s, 200)
  eq('  返回 enabled', r.d.enabled, true)

  r = await call('POST', '/auth/super-state', { body: { key: KEY } })
  eq('老板能查超级口令开着', r.d.enabled, true)

  console.log('\n[2] 超级口令进哪一本都是老板')

  r = await call('GET', '/me', { key: SUPER, book: 1 })
  eq('第 1 本：role', r.d.role, 'owner')
  eq('  标成超级管理员', r.d.super, true)

  r = await call('GET', '/me', { key: SUPER, book: 2 })
  eq('第 2 本也能进', r.s, 200)
  eq('  第 2 本 role', r.d.role, 'owner')
  eq('  第 2 本也是超级', r.d.super, true)
  eq('  账套号', r.d.book, '2')

  r = await call('GET', '/ar', { key: SUPER, book: 2 })
  eq('超级口令能读第 2 本的应收', r.s, 200)

  console.log('\n[3] 每本账可以有自己的管理员口令')

  r = await call('GET', '/me', { key: BOOK2, book: 2 })
  eq('还没设口令时，随便一个口令进不去', r.s, 401)

  r = await call('POST', '/book-admin-key', { key: KEY, body: { book: 2, password: BOOK2 } })
  eq('普通老板不能给别的账套设口令', r.s, 403)
  eq('  提示是 super_only', r.d.code, 'super_only')

  r = await call('POST', '/book-admin-key', { key: SUPER, body: { book: 2, password: BOOK2 } })
  eq('超级管理员能给第 2 本设管理员口令', r.s, 200)

  r = await call('GET', '/me', { key: BOOK2, book: 2 })
  eq('第 2 本自己的口令能进', r.s, 200)
  eq('  是这本账的管理员', r.d.book_admin, true)
  eq('  不是超级管理员', r.d.super, false)
  eq('  不是员工', r.d.role, 'owner')

  r = await call('GET', '/me', { key: BOOK2, book: 1 })
  eq('第 2 本的口令进不了第 1 本', r.s, 401)

  r = await call('GET', '/me', { key: KEY, book: 2 })
  eq('主账套口令照样能进第 2 本', r.s, 200)
  eq('  不是这本账的管理员', r.d.book_admin, false)

  r = await call('GET', '/books-all', { key: SUPER })
  eq('超级管理员能看账套列表', r.s, 200)
  eq('  列表说我是超级', r.d.super, true)
  eq('  第 2 本现在有口令了', (r.d.books || []).find((b) => b.id === 2).has_key, true)

  r = await call('POST', '/book-admin-key', { key: SUPER, body: { book: 9, password: 'x1234' } })
  eq('给不存在的账套设口令 → 404', r.s, 404)

  r = await call('POST', '/book-admin-key', { key: SUPER, body: { book: 2, password: '123' } })
  eq('管理员口令太短 → 400', r.s, 400)

  r = await call('POST', '/book-admin-key', { key: SUPER, body: { book: 3, password: '' } })
  eq('空口令 → 400', r.s, 400)

  console.log('\n[4] 关掉超级口令')

  r = await call('POST', '/auth/super', { key: KEY, body: { password: '' } })
  eq('能关掉', r.s, 200)
  eq('  返回 enabled=false', r.d.enabled, false)

  r = await call('GET', '/me', { key: SUPER, book: 1 })
  eq('关掉之后超级口令进不去', r.s, 401)

  r = await call('GET', '/me', { key: BOOK2, book: 2 })
  eq('第 2 本自己的口令不受影响', r.s, 200)

  console.log('\n[5] 演示口令不能碰这些')

  r = await call('POST', '/auth/super', { key: 'demo-look', body: { password: SUPER } })
  eq('演示口令设不了超级口令', r.s, 403)

  r = await call('POST', '/book-admin-key', { key: 'demo-look', body: { book: 2, password: 'x1234' } })
  eq('演示口令设不了账套口令', r.s, 403)

  console.log('\n' + (bad ? '❌ 超级管理员测试 ' + good + ' 项通过、' + bad + ' 项失败' : '✅ 超级管理员测试 ' + good + ' 项全部通过'))
  process.exit(bad ? 1 : 0)
}

main().catch((e) => { console.error('测试崩了：', e); process.exit(1) })
