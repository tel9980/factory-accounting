#!/usr/bin/env node
// 功能模块开关的回归测试。
// 为什么要有这个：模块关掉以后，接口必须真的 403（不然只是界面上藏起来，
// 老链接、批量取数、别处点进来照样能写），打开以后必须立刻恢复；
// 而且「应收/应付/支出/Excel 导入」这四块是记账基础，谁都不能关。
//
// 用法：node scripts/test-modules.mjs --base http://127.0.0.1:8791 --key 8888
// 参数：--base 后端地址（默认 http://127.0.0.1:8791）--key 老板口令（默认 8888）
//       --staff 员工口令（可选，给了就顺便验「员工改不了模块开关」）
import process from 'node:process'

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const BASE = arg('base', 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = arg('key', '8888')
const STAFF = arg('staff', '')

let bad = 0
const ok = (msg) => console.log('  ✅ ' + msg)
const no = (msg, extra) => { bad++; console.log('  ❌ ' + msg + (extra ? ' ' + JSON.stringify(extra) : '')) }

async function call(method, path, body, key) {
  const opt = { method, headers: { 'x-access-key': key || KEY } }
  if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body) }
  const r = await fetch(BASE + path, opt)
  const text = await r.text()
  let data = text
  try { data = JSON.parse(text) } catch (e) { /* 非 JSON 就保留原文 */ }
  return { s: r.status, d: data }
}

const eq = (name, got, want) => (got === want ? ok(`${name} = ${want}`) : no(`${name} 应为 ${want} → ${got}`))

// 等后端起来（CI 里是刚 nohup 起来的 wrangler dev）
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/health-print'); if (r.status < 500) return true } catch (e) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

async function main() {
  if (!await waitUp()) { console.log('❌ 后端没起来：' + BASE); process.exit(1) }
  console.log('功能模块开关：' + BASE)

  // 先恢复出厂：默认态是「从没动过开关」，而别的脚本（smoke-write）跑过之后库里会存一行 modules_off，
  // 那样就变成「动过但存空串 = 全部打开」，默认态验不出来了。
  const rs = await call('POST', '/modules', { reset: true })
  eq('恢复出厂设置', rs.s, 200)

  // 再看默认状态：从没改过开关的老账本，基础四块全开，计件工资默认关着
  const m0 = await call('GET', '/modules')
  if (m0.s !== 200 || !Array.isArray(m0.d && m0.d.list)) { console.log('❌ /modules 拿不到列表'); process.exit(1) }
  const keys = m0.d.list.map((x) => x.k)
  ok(`模块清单 ${keys.length} 个：${keys.join('、')}`)
  const keepOn = m0.d.list.filter((x) => x.keep && x.on).map((x) => x.k)
  eq('基础模块（应收/应付/支出/导入）默认开着', keepOn.sort().join(','), 'ap,ar,expense,import')
  const wageRow = m0.d.list.find((x) => x.k === 'wage') || {}
  eq('计件工资默认关着（工资按实发数走支出）', !!wageRow.on, false)
  eq('默认关着时 /modules 会给一句替代做法', !!(m0.d.hint || ''), true)
  const wageOff = await call('GET', '/wage-rates')
  eq('默认关着时 /wage-rates 状态码', wageOff.s, 403)
  eq('默认关着时返回的 code', wageOff.d && wageOff.d.code, 'module_off')
  // 关着计件工资不能连累别的：支出/应收照常
  eq('工资关着不影响支出', (await call('GET', '/expenses')).s, 200)
  eq('工资关着不影响应收', (await call('GET', '/ar')).s, 200)

  // 打开计件工资，工资类接口立刻恢复
  const on = await call('POST', '/modules', { off: [] })
  eq('打开计件工资', on.s, 200)
  eq('打开后 /wage-rates 恢复', (await call('GET', '/wage-rates')).s, 200)

  // 再关掉，必须 403
  const save = await call('POST', '/modules', { off: ['wage'] })
  eq('关掉计件工资', save.s, 200)
  const wage = await call('GET', '/wage-rates')
  eq('关掉后 /wage-rates 状态码', wage.s, 403)
  eq('关掉后返回的 code', wage.d && wage.d.code, 'module_off')
  const stillOk = await call('GET', '/ar')
  eq('关掉工资不影响应收', stillOk.s, 200)

  // 基础模块不许关
  const keepTry = await call('POST', '/modules', { off: ['ar', 'ap', 'expense', 'import'] })
  eq('想关基础模块时接口仍返回 200（静默忽略）', keepTry.s, 200)
  const afterKeep = await call('GET', '/ar')
  eq('基础模块仍然能用', afterKeep.s, 200)
  const mKeep = await call('GET', '/modules')
  eq('基础模块没被关掉', (mKeep.d.off || []).filter((k) => ['ar', 'ap', 'expense', 'import'].includes(k)).length, 0)

  // 员工口令不能改
  if (STAFF) {
    const s1 = await call('POST', '/modules', { off: [] }, STAFF)
    eq('员工改模块开关被拒', s1.s, 403)
    eq('员工被拒的 code', s1.d && s1.d.code, 'owner_only')
  }

  // 打开回来
  const back = await call('POST', '/modules', { off: [] })
  eq('全部打开', back.s, 200)
  const wage2 = await call('GET', '/wage-rates')
  eq('打开后 /wage-rates 恢复', wage2.s, 200)

  if (bad) { console.log(`\n❌ 功能模块开关测试失败：${bad} 项`); process.exit(1) }
  console.log('\n✅ 功能模块开关测试通过')
}

main().catch((e) => { console.log('❌ 测试脚本自己挂了：' + (e && e.message)); process.exit(1) })
