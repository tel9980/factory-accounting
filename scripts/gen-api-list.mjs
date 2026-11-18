import fs from 'node:fs'
const src = fs.readFileSync('backend/index.js', 'utf8')
const set = new Set()
for (const m of src.matchAll(/app\.(get|post|patch|delete)\('([^']+)'/g)) set.add(m[1] + ' ' + m[2])
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
fs.writeFileSync('README.md', md)
console.log(`${routes.length} routes, ${groups.length} groups written to README.md`)
