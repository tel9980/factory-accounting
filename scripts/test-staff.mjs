// 员工账号与权限：网页能加人、换口令、改权限、停用、删除；员工只能做被允许的事
const BASE = (process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = process.argv.includes('--key') ? process.argv[process.argv.indexOf('--key') + 1] : '8888'

let pass = 0
const bad = []
const yes = (m, ok, extra) => { if (ok) { pass++; console.log('  ✅ ' + m + (extra !== undefined ? '（' + extra + '）' : '')) } else { bad.push(m + (extra !== undefined ? ' → ' + extra : '')); console.log('  ❌ ' + m + (extra !== undefined ? ' → ' + extra : '')) } }
const eq = (m, got, want) => yes(m, String(got) === String(want), got)

async function req(method, path, opts = {}) {
  const headers = { 'content-type': 'application/json' }
  if (opts.key !== null) headers['x-access-key'] = opts.key === undefined ? KEY : opts.key
  if (opts.book) headers['X-Book'] = String(opts.book)
  const r = await fetch(BASE + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  let d = null
  try { d = await r.json() } catch (e) { d = null }
  return { s: r.status, d: d || {} }
}

const PB = String(1000 + (Date.now() % 9000))
const TODAY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const TAG = 'staff' + Date.now().toString(36).replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]).slice(-4)

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/version')).ok) return } catch (e) {}
    await new Promise((r) => setTimeout(r, 700))
  }
  throw new Error('服务没起来：' + BASE)
}

async function main() {
  await waitUp()
  await req('POST', '/auth/setup', { key: null, body: { key: KEY } })
  console.log('\n[1] 加人、看列表')

  let r = await req('GET', '/staff-users')
  eq('老板能看员工列表', r.s, 200)
  const before = (r.d.rows || []).length
  yes('列表里有模块名对照', !!(r.d.labels && r.d.labels.ar), Object.keys(r.d.labels || {}).length + ' 个模块')

  r = await req('POST', '/staff-users', { body: { name: '小' + TAG, mods: ['ar'] } })
  eq('加一个只开「应收」的员工', r.s, 200)
  const pin = r.d.pin
  const sid = r.d.id
  yes('返回了 4 位口令', /^\d{4,6}$/.test(String(pin)), pin)

  r = await req('GET', '/staff-users')
  eq('列表里多了一个', (r.d.rows || []).length, before + 1)
  const row = (r.d.rows || []).find((x) => Number(x.id) === Number(sid))
  yes('权限文字是「应收」', /应收/.test(row.mod_text || ''), row.mod_text)
  eq('列表不回明文口令', row.pin, '')

  console.log('\n[2] 员工只能做被允许的事')

  r = await req('GET', '/me', { key: pin })
  eq('员工口令能登录', r.s, 200)
  eq('  身份是员工', r.d.role, 'staff')
  eq('  名字记上了', r.d.staff_name, '小' + TAG)

  r = await req('GET', '/ar', { key: pin })
  eq('能看应收', r.s, 200)

  r = await req('GET', '/ap', { key: pin })
  eq('没开应付 → 403', r.s, 403)
  eq('  提示是 staff_module', r.d.code, 'staff_module')

  r = await req('GET', '/staff-users', { key: pin })
  eq('员工看不到员工列表', r.s, 403)

  r = await req('GET', '/export-all', { key: pin })
  eq('员工导不走整库', r.s, 403)

  console.log('\n[3] 改权限 / 换口令 / 停用 / 删除')

  r = await req('POST', '/staff-users/' + sid, { body: { mods: ['ar', 'ap'] } })
  eq('给他加上应付', r.s, 200)
  r = await req('GET', '/ap', { key: pin })
  eq('  现在能看应付了', r.s, 200)

  r = await req('POST', '/staff-users/' + sid, { body: { mods: [] } })
  eq('一个模块都不给 → 400', r.s, 400)

  r = await req('POST', '/staff-users/' + sid, { body: { pin: '2468' } })
  eq('换口令', r.s, 200)
  eq('  返回新口令', r.d.pin, '2468')

  r = await req('GET', '/me', { key: pin })
  eq('旧口令立刻失效', r.s, 401)
  r = await req('GET', '/me', { key: '2468' })
  eq('新口令能进', r.s, 200)

  r = await req('POST', '/staff-users', { body: { name: '重复' + TAG, pin: '2468' } })
  eq('口令被别人占用 → 409', r.s, 409)

  r = await req('POST', '/staff-users/' + sid, { body: { active: 0 } })
  eq('停用', r.s, 200)
  r = await req('GET', '/me', { key: '2468' })
  eq('  停用后进不来', r.s, 401)

  r = await req('POST', '/staff-users/' + sid, { body: { active: 1 } })
  eq('启用回来', r.s, 200)
  r = await req('GET', '/me', { key: '2468' })
  eq('  又能进了', r.s, 200)

  console.log('\n[4] 两个总开关')

  r = await req('GET', '/staff-perms')
  eq('老板能看员工权限总开关', r.s, 200)
  const oldSelf = !!r.d.self_only
  const oldScope = r.d.scope

  r = await req('POST', '/staff-perms', { body: { modules: r.d.on, self_only: true, scope: 'own' } })
  eq('打开「只看自己录的单 + 只看自己负责的客户」', r.s, 200)
  r = await req('GET', '/staff-perms')
  eq('  自己录的单：开着', r.d.self_only, true)
  eq('  只看自己负责的客户：开着', r.d.scope, 'own')

  await req('POST', '/staff-perms', { body: { modules: r.d.on, self_only: oldSelf, scope: oldScope } })
  r = await req('GET', '/staff-perms')
  eq('改回原样', r.d.scope, oldScope)

  console.log('\n[5] 演示口令碰不到这些')

  r = await req('GET', '/staff-users', { key: 'demo-look' })
  eq('演示口令看不到员工列表', r.s, 403)
  r = await req('POST', '/staff-perms', { key: 'demo-look', body: { modules: ['ar'] } })
  eq('演示口令改不了员工权限', r.s, 403)

  console.log('\n[6] 员工按账套分开（这本账的人进不了别的账套）')

  r = await req('POST', '/staff-users', { book: 1, body: { name: '一本小王', pin: PB, mods: ['ar'] } })
  eq('第 1 本加一个员工', r.s, 200)
  const s1 = r.d.id

  r = await req('GET', '/me', { key: PB, book: 1 })
  eq('  他在第 1 本能进', r.s, 200)
  r = await req('GET', '/me', { key: PB, book: 2 })
  eq('  到第 2 本就进不来（401）', r.s, 401)

  r = await req('GET', '/staff-users', { book: 2 })
  eq('第 2 本的员工列表里没有他', (r.d.rows || []).some((x) => Number(x.id) === Number(s1)), false)

  r = await req('POST', '/staff-users', { book: 2, body: { name: '二厂小王', pin: PB, mods: ['ar', 'ap'] } })
  eq('第 2 本可以加一个同口令的人', r.s, 200)
  const s2 = r.d.id
  r = await req('GET', '/me', { key: PB, book: 2 })
  eq('  他在第 2 本能进', r.s, 200)
  eq('  名字是二厂那个', r.d.staff_name, '二厂小王')

  r = await req('GET', '/me', { key: PB, book: 1 })
  eq('同一串口令在第 1 本还是原来那个人', r.d.staff_name, '一本小王')

  r = await req('GET', '/ar', { key: PB, book: 1 })
  eq('第 1 本的人能看第 1 本应收', r.s, 200)
  r = await req('GET', '/ap', { key: PB, book: 1 })
  eq('  但他没开应付 → 403', r.s, 403)
  r = await req('GET', '/ap', { key: PB, book: 2 })
  eq('第 2 本那个人开了应付 → 200', r.s, 200)

  await req('DELETE', '/staff-users/' + s2, { book: 2 })
  await req('DELETE', '/staff-users/' + s1, { book: 1 })
  r = await req('GET', '/me', { key: PB, book: 2 })
  eq('删掉第 2 本那个后，同一口令在第 2 本进不来', r.s, 401)

  console.log('\n[7] 员工只看自己的：顶部数字、分类汇总跟列表对得上')

  await req('POST', '/orders', { body: { customer: TAG + '甲', price: 1100, date: TODAY } })
  await req('POST', '/orders', { body: { customer: TAG + '乙', price: 2200, date: TODAY } })
  const mk = await req('POST', '/staff-users', { body: { name: TAG + '小员', pin: PB, mods: ['ar'] } })
  eq('加一个只管应收的员工', mk.s, 200)
  const sid7 = (mk.d || {}).id
  // 先打开「只看自己负责的客户」再量，否则默认是看全部，0 就不成立了
  await req('POST', '/staff-perms', { body: { modules: ['ar', 'ap'], self_only: false, scope: 'own' } })
  const ownSum = await req('GET', '/ar-summary?type=ar', { key: PB })
  eq('  还没给他分客户时，顶部「还欠」是 0', Number((ownSum.d || {}).open_amount || 0), 0)
  await req('POST', '/party-staff', { body: { party: TAG + '甲', staff: TAG + '小员' } })

  r = await req('GET', '/ar?status=all&kw=' + encodeURIComponent(TAG), { key: PB })
  const mine = (r.d && Array.isArray(r.d) ? r.d : (r.d.list || []))
  eq('  他只看得到自己负责的那家', mine.filter((x) => x.customer === TAG + '甲').length, 1)
  eq('  别人家的单看不到', mine.filter((x) => x.customer === TAG + '乙').length, 0)

  const sum1 = await req('GET', '/ar-summary?type=ar', { key: PB })
  eq('  顶部「还欠」只算他那一家的 1100（不是 3300）', Number((sum1.d || {}).open_amount || 0), 1100)
  const cat1 = await req('GET', '/ar-by-category', { key: PB })
  const open0 = await req('GET', '/ar-by-category')
  yes('  分类汇总也只算他的（≤ 老板看到的）', Number((cat1.d || {}).total_open || 0) <= Number((open0.d || {}).total_open || 0), Number((cat1.d || {}).total_open || 0) + ' / ' + Number((open0.d || {}).total_open || 0))

  await req('POST', '/staff-perms', { body: { modules: ['ar', 'ap'], self_only: true, scope: 'own' } })
  const sum2 = await req('GET', '/ar-summary?type=ar', { key: PB })
  eq('  改成「只看自己录的单」后，顶部数字归零（那些单是老板录的）', Number((sum2.d || {}).open_amount || 0), 0)
  r = await req('GET', '/ar?status=all&kw=' + encodeURIComponent(TAG), { key: PB })
  eq('  列表同时也空了，两边一致', ((r.d && Array.isArray(r.d) ? r.d : (r.d.list || []))).length, 0)

  await req('POST', '/staff-perms', { body: { modules: ['ar', 'ap'], self_only: false, scope: 'all' } })
  await req('DELETE', '/staff-users/' + sid7)
  const sum3 = await req('GET', '/ar-summary?type=ar', { key: PB })
  eq('  恢复默认权限后，这个口令就进不来了', sum3.s, 401)

  console.log('\n[8] 删除')

  r = await req('DELETE', '/staff-users/' + sid)
  eq('删掉这个员工', r.s, 200)
  r = await req('GET', '/me', { key: '2468' })
  eq('  删了他就进不来了', r.s, 401)
  r = await req('GET', '/staff-users')
  eq('  列表里也没了', (r.d.rows || []).some((x) => Number(x.id) === Number(sid)), false)

  console.log('')
  if (bad.length) {
    console.log('❌ 员工账号回归 ' + bad.length + ' 项失败：')
    bad.forEach((x) => console.log('   · ' + x))
    process.exit(1)
  }
  console.log('✅ 员工账号与权限 ' + pass + ' 项全部通过')
}

main().catch((e) => { console.error('测试崩了：', e); process.exit(1) })
