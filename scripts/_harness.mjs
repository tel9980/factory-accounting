// 测试脚本公共样板 —— 新写 test-*.mjs 一律 `import { harness } from './_harness.mjs'`，别再复制这段。
//
// 为什么值得抽：以前 36 个测试脚本每个都手抄一份 arg()/BASE/KEY/TAG/TODAY/MONTH/YEAR +
// pass/bad + ok/no/yes/eq/near/r2/n0 + call/post/wait 约 40 行样板。抄来抄去就开始走样——
// 有的 call 返回 {s,d}、有的返回 {status,d}，有的 yes 参数顺序都不一样。新脚本统一走这里。
//
// 旧脚本（scripts/test-*.mjs 里还没 import 这份的）保持不变、照常能跑；它们已经在跑，
// 强行统一反而有「改错一个断言让它静默变绿」的风险。以后新增/重写脚本时才迁到这里。
//
// 用法（脚本顶部）：
//   import { harness } from './_harness.mjs'
//   const h = harness({ tag: 'xx' })
//   const { BASE, KEY, TAG, TODAY, MONTH, YEAR, ok, no, yes, eq, near, r2, n0, call, post, wait, finish } = h

const TZ_OFFSET = 8 * 3600 * 1000 // 北京时间（小程序后端所有「今天/本月」都按东八区）

export function harness(opts = {}) {
  const argv = process.argv.slice(2)
  const arg = (name, dflt) => {
    const i = argv.indexOf('--' + name)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
  }

  const BASE = arg('base', opts.base || 'http://127.0.0.1:8791').replace(/\/+$/, '')
  const KEY = arg('key', opts.key || '8888')
  const TODAY = new Date(Date.now() + TZ_OFFSET).toISOString().slice(0, 10)
  const MONTH = TODAY.slice(0, 7)
  const YEAR = TODAY.slice(0, 4)
  // 名字不能带数字：带数字的会被导入解析当成金额（这个坑踩过两次）
  const TAG = (opts.tag || 't') + Date.now().toString(36).replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]).slice(-4)

  let pass = 0
  const bad = []
  const ok = (m) => { pass++; console.log('  ✅ ' + m) }
  const no = (m, d) => { bad.push(m); console.log('  ❌ ' + m + (d === undefined ? '' : ' → ' + JSON.stringify(d))) }
  const yes = (label, cond, d) => (cond ? ok(label) : no(label, d))
  const eq = (label, got, want) => (String(got) === String(want) ? ok(`${label} = ${want}`) : no(`${label} 应为 ${want}`, got))
  const n0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const r2 = (v) => Math.round(n0(v) * 100) / 100
  // 允许一分钱以内的浮点差；其它一律算错
  const near = (label, a, b, eps = 0.011) => yes(`${label}（${r2(a)} vs ${r2(b)}）`, Math.abs(r2(a) - r2(b)) <= eps, { a: r2(a), b: r2(b) })

  const call = async (method, path, body, extra = {}) => {
    const headers = { 'X-Access-Key': extra.key === undefined ? KEY : extra.key, 'Content-Type': 'application/json' }
    if (extra.book) headers['X-Book'] = String(extra.book)
    const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    let d = null
    try { d = await r.json() } catch (e) { d = null }
    return { status: r.status, d }
  }
  const get = (path, extra) => call('GET', path, undefined, extra)
  const post = (path, body, extra) => call('POST', path, body, extra)

  const wait = async () => {
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(BASE + '/version'); if (r.ok) return true } catch (e) {}
      await new Promise((s) => setTimeout(s, 1000))
    }
    return false
  }

  // 统一收尾：有失败就列清单并 exit 1，否则打「N 项全部通过」。
  const finish = (name) => {
    console.log('')
    if (bad.length) {
      console.log(`❌ ${name} ${bad.length} 项失败：`)
      bad.forEach((x) => console.log('   · ' + x))
      process.exit(1)
    }
    console.log(`✅ ${name} ${pass} 项全部通过`)
    process.exit(0)
  }

  return { BASE, KEY, TAG, TODAY, MONTH, YEAR, arg, ok, no, yes, eq, near, n0, r2, call, get, post, wait, finish, _bad: bad, _pass: () => pass }
}
