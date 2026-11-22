// 生成 README 里的接口清单。
//   node scripts/gen-api-list.mjs            → 直接改写 README.md
//   node scripts/gen-api-list.mjs --check     → 只比对，不一致就退出码 1（给 CI 用，不改文件）
//   node scripts/gen-api-list.mjs --out x.md  → 写到别的文件，不碰 README
// 以前没有 --check：CI 里想验「清单是不是过时了」只能真的跑一遍，跑完工作区就变脏了。
import fs from 'node:fs'
import { extractRoutes } from './_route-usage.mjs'
const ARGS = process.argv.slice(2)
const CHECK = ARGS.indexOf('--check') >= 0
const OUT_I = ARGS.indexOf('--out')
const OUT = OUT_I >= 0 ? ARGS[OUT_I + 1] : 'README.md'
const src = fs.readFileSync('backend/index.js', 'utf8')
// 路由提取统一走 _route-usage.mjs：6 种方法 + 三种引号 + 模板串都认，
// 免得清单里的接口数比后端实际注册的少（以前只有 4 种方法、单引号，PUT 一条都没算进去）。
const set = new Set()
for (const r of extractRoutes(src)) set.add(r.m + ' ' + r.p)
const routes = [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
const raw = new Map()
for (const r of routes) {
  const [meth, p] = [r.slice(0, r.indexOf(' ')), r.slice(r.indexOf(' ') + 1)]
  const parts = p.split('/')
  let seg = parts.length > 1 ? parts[1] : 'root'
  seg = seg.split(':')[0] || 'root'
  if (!raw.has(seg)) raw.set(seg, [])
  raw.get(seg).push([meth.toUpperCase(), p])
}
const groups = []
const misc = []
for (const [k, v] of raw) { if (v.length >= 2) groups.push([k, v]); else misc.push(...v) }
if (misc.length) groups.push(['其它（单个接口）', misc.slice().sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))])
const B = '<!-- API-LIST:BEGIN -->', E = '<!-- API-LIST:END -->'
const lines = [B, '', '## 附录：接口清单（由 `scripts/gen-api-list.mjs` 自动生成，请勿手改）', '',
  `共 ${routes.length} 个接口。改完后端跑一次 node scripts/gen-api-list.mjs 即可同步本清单（早期 python 版已删，容器里没有 python）。`, '']
for (const [seg, items] of groups) {
  lines.push(`**${seg}**（${items.length}）`, '')
  for (const [m, p] of items) lines.push(`- \`${m} ${p}\``)
  lines.push('')
}
lines.push(E)
const block = lines.join('\n')
let md = fs.readFileSync('README.md', 'utf8')
const i = md.indexOf(B), j = md.indexOf(E)
if (i >= 0 && j >= 0) md = md.slice(0, i) + block + md.slice(j + E.length)
else md = md.trimEnd() + '\n\n' + block + '\n'
if (CHECK) {
  const cur = fs.readFileSync('README.md', 'utf8')
  const ci2 = cur.indexOf(B), cj = cur.indexOf(E)
  const now = ci2 >= 0 && cj >= 0 ? cur.slice(ci2, cj + E.length) : ''
  if (now !== block) {
    console.error('❌ README 里的接口清单过时了（后端接口数/路径变了）。跑一次 node scripts/gen-api-list.mjs 同步。')
    console.error('   现在的清单：' + now.split('\n').slice(0, 4).join(' | '))
    console.error('   生成的清单：' + block.split('\n').slice(0, 4).join(' | '))
    process.exit(1)
  }
  console.log(`✅ 接口清单是最新的（${routes.length} 个接口 / ${groups.length} 组）`)
  process.exit(0)
}
fs.writeFileSync(OUT, md)
console.log(`${routes.length} routes, ${groups.length} groups written to ${OUT}`)
