#!/usr/bin/env node
// 一键诊断：版本 / 表结构缺列 / 自检（含 cron 心跳）/ 错误日志 / 慢接口 / 表数据量。
// 用法：node scripts/diag.mjs --base http://127.0.0.1:9410 --key 8888 [--book 1]
// 输出是给人看的诊断报告，不是测试断言；只要接口都通了就 exit 0（哪怕有体检告警），
// 网络不通或接口 500 才 exit 1 —— 方便在 CI/脚本里「跑一遍就知道哪坏了」。
import { harness } from './_harness.mjs'

const h = harness({ tag: 'diag' })
const { BASE, KEY, arg, get, call } = h
const BOOK = arg('book', 1)

const H = (path) => ({ path, key: KEY, book: BOOK })
const line = (s = '') => console.log(s)
const kv = (k, v) => console.log(`  ${k.padEnd(18)}${v}`)

let failed = false
const hit = async (name, path) => {
  const r = await get(path, H(path))
  if (r.status >= 500) { failed = true; console.log(`❌ ${name} → HTTP ${r.status}`); return null }
  if (!r.d) { failed = true; console.log(`❌ ${name} → 无响应（网络不通或没起服务）`); return null }
  return r.d
}

console.log('')
console.log('═'.repeat(60))
console.log(`诊断目标  ${BASE}（账套 ${BOOK}）`)
console.log('═'.repeat(60))

// 1. 版本 / commit
const ver = await hit('版本', '/version')
if (ver) {
  line('【版本】')
  kv('version', ver.version || '?')
  kv('built', ver.built || '?')
  kv('commit', (ver.commit || '?').slice(0, 12))
}

// 2. 表结构缺列
const schema = await hit('表结构', '/schema-check')
if (schema) {
  line('')
  line(`【表结构】 ${schema.clean ? '✅ 全齐' : '❌ 有缺列'}（${schema.bad_count ?? 0} 本账有问题）`)
  for (const b of (schema.books || [])) {
    if (b.ok) { kv(b.name, '齐') }
    else { console.log(`  ${b.name}:`); for (const x of b.issues || []) console.log(`    · ${x.table} 缺 ${(x.missing || []).join('/')}`) }
  }
}

// 3. 自检（含 cron 心跳、备份、上月结账等）
const sc = await hit('自检', '/selfcheck')
if (sc) {
  line('')
  line(`【自检】 ${sc.score ?? '?'} 分 · ${sc.grade ?? ''}（${sc.clean ? '干净' : (sc.count ?? 0) + ' 处告警'}）`)
  for (const it of (sc.items || [])) {
    if (it.count > 0) {
      const heart = it.k === 'cron' ? `（心跳：${it.tip || ''}）` : ''
      console.log(`  ⚠ ${it.label} × ${it.count}${heart}`)
      if (it.k === 'cron') kv('', it.tip || '')
    }
  }
  if (!(sc.items || []).some((x) => x.count > 0)) console.log('  ✅ 没有体检告警')
}

// 4. 错误日志（近 7 天）
const err = await hit('错误日志', '/error-log?days=7&limit=30')
if (err) {
  line('')
  line(`【错误日志·近 7 天】 共 ${err.total ?? 0} 条`)
  for (const g of (err.grouped || []).slice(0, 5)) console.log(`  ${g.count}× ${g.path}`)
  const recent500 = (err.rows || []).filter((r) => Number(r.status) >= 500).slice(0, 5)
  for (const r of recent500) {
    const ray = r.ray ? ` ray=${r.ray.slice(0, 12)}` : ''
    console.log(`  500 ${r.when?.slice(0, 16).replace('T', ' ')} ${r.path}${ray}`)
    if (r.msg) console.log(`      ${r.msg.slice(0, 120)}`)
  }
  if (!(err.rows || []).length) console.log('  ✅ 没有错误日志')
}

// 5. 慢接口（近 7 天）
const slow = await hit('慢接口', '/slow-log?days=7')
if (slow) {
  line('')
  line(`【慢接口·近 7 天】 共 ${slow.count ?? 0} 条（>800ms）`)
  for (const r of (slow.rows || []).slice(0, 5)) console.log(`  ${r.max}ms × ${r.cnt}  ${r.method} ${r.path}`)
  if (!(slow.rows || []).length) console.log('  ✅ 没有慢接口')
}

// 6. 表数据量
const stats = await hit('数据量', '/db-stats')
if (stats) {
  line('')
  line(`【表数据量】 共 ${stats.total ?? 0} 行`)
  const top = (stats.rows || []).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 8)
  for (const r of top) console.log(`  ${String(r.n).padStart(8)}  ${r.label || r.k}`)
}

console.log('')
console.log('═'.repeat(60))
console.log(failed ? '❌ 诊断没跑完：有接口没通（看上面）' : '✅ 诊断跑完，接口全通（告警见上）')
console.log('═'.repeat(60))
process.exit(failed ? 1 : 0)
