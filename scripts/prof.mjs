#!/usr/bin/env node
// 找「哪个接口最慢 / 哪个返回体最大」——不用猜，挨个打一遍。
//
// 用法：
//   1) 另开一个窗口起本地服务：cd backend && npx wrangler dev --local --port 8794 --ip 127.0.0.1
//   2) node scripts/prof.mjs --base http://127.0.0.1:8794 --key 8888
//
// 说明：
//   - 路由从 backend/index.js 里直接抽（`app.get('/xxx')`），`:id` 换成 1；
//   - 每个接口打 3 次，取第 2、3 次里快的那个（第一次含冷启动/建表兜底，不算）；
//   - 只看 200 的接口（要参数才不报错的接口会 4xx，跳过，不参与排名）；
//   - 本地库建议灌点数据再跑，否则都是 1ms，看不出问题。
import fs from 'node:fs'
import path from 'node:path'

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const BASE = arg('base', 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = arg('key', '')
const TOP = Number(arg('top', '15'))
const ROOT = path.resolve(import.meta.dirname, '..')

const src = fs.readFileSync(path.join(ROOT, 'backend/index.js'), 'utf8')
const paths = [...new Set([...src.matchAll(/\bapp\.get\(\s*'([^']+)'/g)].map((m) => m[1]))]
  .map((p) => p.replace(/:[a-zA-Z_]+/g, '1'))

const rows = []
let next = 0
const hit = async (p) => {
  let best = Infinity
  let kb = 0
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint()
    try {
      const res = await fetch(BASE + p, { headers: KEY ? { 'x-access-key': KEY } : {} })
      const body = await res.text()
      if (res.status !== 200) return null
      kb = body.length / 1024
      const ms = Number(process.hrtime.bigint() - t0) / 1e6
      if (i > 0 && ms < best) best = ms
    } catch (e) {
      return null
    }
  }
  return Number.isFinite(best) ? { p, ms: best, kb } : null
}
const worker = async () => {
  while (next < paths.length) {
    const p = paths[next++]
    const r = await hit(p)
    if (r) rows.push(r)
  }
}

console.log(`打 ${paths.length} 个 GET 路由（每个 3 次）…`)
await Promise.all([0, 1, 2].map(worker))
if (!rows.length) {
  console.log('❌ 一个 200 都没拿到：口令对不对？服务起来了吗？（--key，或先 POST /auth/setup）')
  process.exit(1)
}
const slow = rows.slice().sort((a, b) => b.ms - a.ms).slice(0, TOP)
const big = rows.slice().sort((a, b) => b.kb - a.kb).slice(0, TOP)
console.log(`\n== 最慢的 ${slow.length} 个（本地无网络往返，线上还要加一次 D1 往返）==`)
for (const r of slow) console.log(`  ${r.ms.toFixed(0).padStart(5)}ms  ${r.kb.toFixed(0).padStart(6)}KB  ${r.p}`)
console.log(`\n== 返回体最大的 ${big.length} 个 ==`)
for (const r of big) console.log(`  ${r.kb.toFixed(0).padStart(6)}KB  ${r.ms.toFixed(0).padStart(5)}ms  ${r.p}`)
console.log(`\n（有 ${paths.length - rows.length} 个接口没返回 200，已跳过：多数是要参数或只有 POST）`)
