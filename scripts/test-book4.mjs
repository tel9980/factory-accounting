// 多账套「第 4 本账」演练：证明代码不写死三本。
//
// 背景：线上是 9 个 D1 绑定（DB/DB2…DB9）、本机版是 9 个 .db 文件。以前 backend 里写死
// [DB,DB2,DB3]，想多开一本得改代码；后来改成 bookDbs(env) 自己发现绑定，最多 9 本。
// 这个测试自己起一个本机版服务（本机版天然就是 9 本），然后：
//   1) /books-all 必须列出 9 本，且第 4 本 binding 是 DB4；
//   2) 用 X-Book:4 往第 4 本写一笔，/books-all 里第 4 本的单数要 +1（证明第 4 本是真库、不是摆设）；
//   3) /books-check 与 /merge-summary 也必须枚举 9 本（不是只扫前三本）。
//
// 为什么是「自己起本机版」而不是用 --base：wrangler dev 的 wrangler.toml 只有 DB/DB2/DB3
// 三个绑定，加 DB4 会拖累生产部署（线上还没有 factory-db4）。本机版 server/main.mjs 按
// server/books.mjs 的 BOOKS=9 一次建好 9 本，正好当「9 本全在」的演练场，且不碰生产配置。
//
// 这个脚本不依赖 --base/--key，自己起服务、自己设口令，登记在 run-all.mjs 的 OFFLINE（自包含）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const H = harnessFromScratch()

function harnessFromScratch() {
  const pass = [], bad = []
  const ok = (m) => { pass.push(m); console.log('  ✅ ' + m) }
  const no = (m, d) => { bad.push(m); console.log('  ❌ ' + m + (d === undefined ? '' : ' → ' + JSON.stringify(d))) }
  const yes = (l, c, d) => (c ? ok(l) : no(l, d))
  const finish = (name) => {
    console.log('')
    if (bad.length) { console.log(`❌ ${name} ${bad.length} 项失败：`); bad.forEach((x) => console.log('   · ' + x)); process.exit(1) }
    console.log(`✅ ${name} ${pass.length} 项全部通过`); process.exit(0)
  }
  return { ok, no, yes, finish }
}

const KEY = '8888'
const PORT = 8944
const DIR = path.join(os.tmpdir(), 'fa-book4-' + Date.now().toString(36))
const { ok, no, yes, finish } = H

const sleep = (ms) => new Promise((s) => setTimeout(s, ms))

async function waitUp(base) {
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(base + '/version'); if (r.ok) return true } catch (e) {}
    await sleep(1000)
  }
  return false
}

async function api(base, method, p, body, book) {
  const headers = { 'X-Access-Key': KEY, 'Content-Type': 'application/json' }
  if (book) headers['X-Book'] = String(book)
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  let d = null
  try { d = await r.json() } catch (e) {}
  return { status: r.status, d }
}

let child = null
const run = async () => {
  fs.mkdirSync(DIR, { recursive: true })
  child = spawn('node', ['server/main.mjs', '--port', String(PORT), '--data', DIR, '--no-open', '--no-cron'], {
    cwd: process.cwd(), stdio: 'ignore',
  })
  const base = `http://127.0.0.1:${PORT}`
  yes('本机版服务能起来（9 本建库）', await waitUp(base), '等了 90s 还没起来')

  // 0) 还没设口令的时候，演示账套必须能进 —— 微信审核不许「必须先设口令才能看到任何东西」。
  // 这一条以前是坏的：中间件的 no_key 守卫把演示口令一起挡在外面，审核员头一次打开
  // 小程序只会看到「设个口令」，一个页面都点不进去。
  const DEMO = 'demo-look'
  const dAr = await fetch(base + '/ar', { headers: { 'X-Access-Key': DEMO } })
  yes('一次口令都没设时，演示口令照样能进（审核员不用先注册）', dAr.status === 200, dAr.status)
  let dMe = null
  try { dMe = await (await fetch(base + '/me', { headers: { 'X-Access-Key': DEMO } })).json() } catch (e) {}
  yes('…身份是 demo、进的是第 3 本演示账', !!dMe && dMe.role === 'demo' && String(dMe.book) === '3', dMe && { role: dMe.role, book: dMe.book })
  yes('…而且没口令时别的请求还是 401（不能借演示把真账打开）', (await fetch(base + '/ar')).status === 401, 'no_key 守卫被绕过了')

  const setup = await api(base, 'POST', '/auth/setup', { key: KEY, confirm: KEY })
  if (setup.status !== 200) { no('设口令', setup); cleanup(); finish('第 4 本账演练'); return }
  ok('设口令')

  // 1) 列出 9 本，第 4 本 binding 是 DB4
  const all1 = await api(base, 'GET', '/books-all')
  yes('/books-all 返回 max=9', all1.status === 200 && all1.d && all1.d.max === 9, all1)
  yes('/books-all 列出 9 本', Array.isArray(all1.d && all1.d.books) && all1.d.books.length === 9, (all1.d && all1.d.books && all1.d.books.length))
  const b4a = (all1.d && all1.d.books || []).find((b) => b.id === 4)
  yes('第 4 本在列，binding=DB4', !!b4a && b4a.binding === 'DB4', b4a)

  // 2) 往第 4 本写一笔，/books-all 里第 4 本单数 +1
  const before4 = b4a ? b4a.orders : -1
  const po = await api(base, 'POST', '/orders', { customer: '第四本客户', item_name: '第四本测试', price: 123, date: new Date().toISOString().slice(0, 10) }, 4)
  if (po.status !== 200 || !po.d || !po.d.ok) { no('往第 4 本开单', po); cleanup(); finish('第 4 本账演练'); return }
  ok('往第 4 本开单（X-Book:4）')
  const all2 = await api(base, 'GET', '/books-all')
  const b4b = (all2.d && all2.d.books || []).find((b) => b.id === 4)
  yes('第 4 本单数 +1（写进第 4 本了）', !!b4b && b4b.orders === before4 + 1, { before: before4, after: b4b && b4b.orders })

  // 3) /books-check 与 /merge-summary 都枚举 9 本
  const bc = await api(base, 'GET', '/books-check')
  yes('/books-check 检查 9 本', bc.status === 200 && Array.isArray(bc.d && bc.d.rows) && bc.d.rows.length === 9, (bc.d && bc.d.rows && bc.d.rows.length))
  const ms = await api(base, 'GET', '/merge-summary')
  yes('/merge-summary 合并 9 本', ms.status === 200 && Array.isArray(ms.d && ms.d.books) && ms.d.books.length === 9, (ms.d && ms.d.books && ms.d.books.length))

  cleanup()
  finish('第 4 本账演练')
}

function cleanup() {
  try { if (child) child.kill('SIGKILL') } catch (e) {}
  try { fs.rmSync(DIR, { recursive: true, force: true }) } catch (e) {}
}

run().catch((e) => { console.error(e); cleanup(); process.exit(1) })
