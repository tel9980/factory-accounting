// 账套之间不串：备份、导出、恢复、设置 都不许跨本影响。
//
// 为什么单独测这一块：三本账各是一个数据库，但**备份 id 是每本自己从 1 数的**——
// 第 1 本的 #5 和第 2 本的 #5 是两份完全不同的账。界面上又都叫「回到某一天」，
// 一旦列表没跟着切账套一起刷、或者恢复时不核对属于哪本，就会把 A 的账恢复进 B，
// 而且显示「回来了」。这类错误不会报错、不会红，只会让账悄悄变成别人的。
//
// 顺带钉住：把 A 的整库包导进 B，B 的账本名 / 模块开关 / 演示开关 / 超级口令 必须还是 B 自己的。
//
// 用法：node scripts/test-bookiso.mjs --base http://127.0.0.1:8791 --key 8888
const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const BASE = opt('base', 'http://127.0.0.1:8791').replace(/\/+$/, '')
const KEY = opt('key', '8888')
const TAG = '隔离' + Math.random().toString(36).slice(2, 6)
const PB2 = String(1000 + (Date.now() % 9000))
const SUPER_PW = 'sp' + Math.random().toString(36).slice(2, 10)

const num0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
let pass = 0
const bad = []
const ok = (m) => { pass++; console.log('  ✅ ' + m) }
const no = (m, extra) => { bad.push(m + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))); console.log('  ❌ ' + m + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))) }
const yes = (m, cond, extra) => (cond ? ok(m) : no(m, extra))
const eq = (m, a, b) => yes(m + ' = ' + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), { got: a })

async function call(method, path, key, body, book) {
  const h = { 'x-access-key': key || KEY }
  if (book) h['X-Book'] = String(book)
  if (body !== undefined) h['content-type'] = 'application/json'
  const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
  const t = await r.text()
  let d = null
  try { d = JSON.parse(t) } catch (e) { d = t }
  return { s: r.status, d }
}
const get = (p, key, book) => call('GET', p, key, undefined, book)
const post = (p, body, key, book) => call('POST', p, key, body === undefined ? {} : body, book)

const wait = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/version'); if (r.ok) return } catch (e) { /* 还没起来 */ }
    await new Promise((s) => setTimeout(s, 500))
  }
  throw new Error('服务没起来：' + BASE)
}

const main = async () => {
  await wait()
  console.log('账套隔离（base=' + BASE + '，标记 ' + TAG + '）')

  // ── 0. 准备：超级口令 + 第 2 本自己的管理员口令 ─────────────
  const sp = await post('/auth/super', { key: KEY, password: SUPER_PW })
  yes('设超级口令', sp.s === 200 && sp.d && sp.d.ok, sp.d)
  const bk2 = await post('/book-admin-key', { book: 2, password: PB2 }, SUPER_PW)
  yes('给第 2 本设管理员口令', bk2.s === 200 && bk2.d && bk2.d.ok, bk2.d)

  // ── 1. 两本账各记自己的客户 ──────────────────────────────
  const ar1 = TAG + '甲（一本）'
  const ar2 = TAG + '乙（二本）'
  const o1 = await post('/orders', { customer: ar1, item_name: '甲件', price: 1000, date: '2026-11-10' }, KEY, 1)
  yes('第 1 本记一笔应收', o1.s === 200, o1.d)
  const o2 = await post('/orders', { customer: ar2, item_name: '乙件', price: 2000, date: '2026-11-10' }, PB2, 2)
  yes('第 2 本（用自己的口令）记一笔应收', o2.s === 200, o2.d)

  // ── 2. 导出包各带自己的账套号与自己的数据 ──────────────────
  const e1 = await get('/export-all', KEY, 1)
  const e2 = await get('/export-all', PB2, 2)
  eq('第 1 本导出包的账套号', String((e1.d && e1.d.book_id) || ''), '1')
  eq('第 2 本导出包的账套号', String((e2.d && e2.d.book_id) || ''), '2')
  const cust1 = JSON.stringify(((e1.d && e1.d.tables && e1.d.tables.orders) || []).map((x) => x.customer))
  const cust2 = JSON.stringify(((e2.d && e2.d.tables && e2.d.tables.orders) || []).map((x) => x.customer))
  yes('第 1 本导出包里没有第 2 本的客户', !cust1.includes('乙（二本）'))
  yes('第 2 本导出包里没有第 1 本的客户', !cust2.includes('甲（一本）'))
  yes('第 1 本导出包里自己的客户在', cust1.includes('甲（一本）'))

  // ── 3. 备份列表：各列各的，行上带账套号 ────────────────────
  const cb1 = await post('/cloud-backup', {}, KEY, 1)
  yes('第 1 本做一份云端备份', cb1.s === 200 && num0(cb1.d && cb1.d.id) > 0, cb1.d)
  const cb2 = await post('/cloud-backup', {}, PB2, 2)
  yes('第 2 本做一份云端备份', cb2.s === 200 && num0(cb2.d && cb2.d.id) > 0, cb2.d)
  const l1 = await get('/backup-list', KEY, 1)
  const l2 = await get('/backup-list', PB2, 2)
  yes('第 1 本列表每一行都标着账套 1', Array.isArray(l1.d) && l1.d.length > 0 && l1.d.every((x) => String(x.book) === '1'), (l1.d || []).slice(0, 3))
  yes('第 2 本列表每一行都标着账套 2', Array.isArray(l2.d) && l2.d.length > 0 && l2.d.every((x) => String(x.book) === '2'), (l2.d || []).slice(0, 3))
  const id2 = num0(cb2.d && cb2.d.id)
  const in1 = (l1.d || []).some((x) => num0(x.id) === id2 && String(x.created_at) === String(cb2.d && cb2.d.saved_at))
  yes('第 2 本刚做的那份没出现在第 1 本列表里（同 id 也只是巧合）', !in1 || String(cb1.d && cb1.d.saved_at) !== String(cb2.d && cb2.d.saved_at), { id2 })

  // ── 4. 拿着另一本的备份号去恢复：必须拒 ───────────────────
  const before2 = await get('/ar?status=all', PB2, 2)
  const cnt2Before = Array.isArray(before2.d) ? before2.d.length : -1
  const wrong = await post('/backup-restore', { id: id2, confirm: true, book: 1 }, PB2, 2)
  eq('第 2 本拿「第 1 本的备份号」恢复被拒', wrong.s, 409)
  eq('拒的理由是账套对不上', String((wrong.d && wrong.d.code) || ''), 'book_mismatch')
  const after2 = await get('/ar?status=all', PB2, 2)
  eq('被拒之后第 2 本的账一点没动', Array.isArray(after2.d) ? after2.d.length : -1, cnt2Before)
  const right = await post('/backup-restore', { id: id2, confirm: true, book: 2 }, PB2, 2)
  yes('带对自己账套号就能恢复', right.s === 200 && right.d && right.d.ok, right.d)
  yes('不带账套号的老调用方式仍然能用（向后兼容）', (await post('/backup-restore', { id: id2, confirm: true }, PB2, 2)).s === 200)

  // ── 5. 口令不串本 ────────────────────────────────────────
  const cross = await get('/ar', PB2, 1)
  eq('第 2 本的管理员口令进不了第 1 本', cross.s, 401)
  const main2 = await get('/ar?status=all', KEY, 2)
  yes('主账套口令可以进第 2 本（设计如此，主管理员管全部）', main2.s === 200, main2.d && main2.d.error)

  // ── 6. 把第 1 本的整库包导进第 2 本：数据换成 1 的，设置还是 2 的 ──
  const nm2 = TAG + '二厂'
  const rn = await post('/book-admin', { book: 2, name: nm2 }, SUPER_PW)
  yes('第 2 本改名', rn.s === 200 && rn.d && rn.d.ok, rn.d)
  await post('/modules', { off: ['wage'] }, PB2, 2)
  const mods2a = await get('/modules', PB2, 2)
  const wageOffA = ((mods2a.d && mods2a.d.off) || []).includes('wage')
  yes('第 2 本关掉计件工资模块', wageOffA, mods2a.d && mods2a.d.off)
  const imp = await post('/import-all', { pkg: e1.d, mode: 'replace', confirm: '覆盖' }, PB2, 2)
  yes('第 1 本的包导进第 2 本成功', imp.s === 200 && imp.d && imp.d.ok, imp.d && imp.d.error)
  const books = await get('/books-all', KEY, 1)
  const b2row = ((books.d && books.d.books) || []).find((x) => num0(x.id) === 2) || {}
  eq('导完之后第 2 本的名字还是自己的', String(b2row.name || ''), nm2)
  const mods2b = await get('/modules', PB2, 2)
  yes('导完之后第 2 本的模块开关还是自己的（计件工资仍关着）', ((mods2b.d && mods2b.d.off) || []).includes('wage'), mods2b.d && mods2b.d.off)
  const ar2b = await get('/ar?status=all', PB2, 2)
  const cust2b = JSON.stringify((Array.isArray(ar2b.d) ? ar2b.d : []).map((x) => x.customer))
  yes('数据确实换成了第 1 本的（这是整包导入的本意）', cust2b.includes('甲（一本）'), cust2b.slice(0, 80))
  yes('第 2 本自己的口令导完还能用', (await get('/ar', PB2, 2)).s === 200)

  // ── 7. /restore 里夹带别人的设置：一律不认 ────────────────
  const crafted = {
    version: 3,
    orders: [{ id: 9001, customer: TAG + '夹带', item_name: 'x', price: 100, created_at: '2026-11-11 09:00:00' }],
    payables: [{ id: 9001, supplier: TAG + '夹带供', amount: 50, created_at: '2026-11-11 09:00:00' }],
    ledger: [{ id: 9001, direction: 'in', ref_type: 'order', ref_id: 9001, amount: 100, created_at: '2026-11-11 09:00:00', account_id: 1, cash: 1 }],
    settings: [
      { key: 'book_name', value: '被篡改的名字' },
      { key: 'modules_off', value: '' },
      { key: 'access_key', value: 'hack' },
      { key: 'super_key', value: 'hack' },
      { key: 'demo_builtin_off', value: '1' }
    ]
  }
  const cr = await post('/restore', crafted, PB2, 2)
  yes('带夹带设置的包能恢复账目', cr.s === 200 && cr.d && cr.d.ok, cr.d && cr.d.error)
  const books2 = await get('/books-all', KEY, 1)
  const b2row2 = ((books2.d && books2.d.books) || []).find((x) => num0(x.id) === 2) || {}
  eq('账本名没被包里的 settings 改掉', String(b2row2.name || ''), nm2)
  const mods2c = await get('/modules', PB2, 2)
  yes('模块开关没被包里的 settings 改掉', ((mods2c.d && mods2c.d.off) || []).includes('wage'), mods2c.d && mods2c.d.off)
  yes('第 2 本的口令没被包里的 access_key 顶掉', (await get('/ar', PB2, 2)).s === 200)
  yes('主账套口令照样能进（没被顶掉）', (await get('/ar', KEY, 1)).s === 200)
  yes('超级口令照样能用（没被包里的 super_key 顶掉）', (await get('/books-all', SUPER_PW, 1)).s === 200)

  // ── 8. 演示账套固定第 3 本，叉不进前两本 ───────────────────
  const dm = await get('/me', 'demo-look')
  eq('演示口令进来是第 3 本', String((dm.d && dm.d.book) || ''), '3')
  const dm1 = await get('/ar', 'demo-look', 1)
  yes('演示口令带 X-Book:1 也还是第 3 本（不串）', dm1.s === 200, dm1.d && dm1.d.error)
  const dmCust = JSON.stringify((Array.isArray(dm1.d) ? dm1.d : []).map((x) => x.customer))
  yes('演示账本里没有真账的客户', !dmCust.includes(TAG), dmCust.slice(0, 60))

  // ── 收尾：关掉超级口令，别留给后面的测试 ───────────────────
  const off = await post('/auth/super', { key: KEY, password: '' }, SUPER_PW)
  yes('收尾关掉超级口令', off.s === 200 && off.d && off.d.ok, off.d)

  console.log('')
  if (bad.length) {
    console.log('❌ 账套隔离 ' + bad.length + ' 项失败：')
    bad.forEach((x) => console.log('   · ' + x))
    process.exit(1)
  }
  console.log('✅ 账套隔离 ' + pass + ' 项全部通过（备份不串本、恢复认账套、设置不被别人的包带走）')
}

main().catch((e) => { console.error('测试崩了：', e); process.exit(1) })
