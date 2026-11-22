// 写接口「有没有被脚本真跑过」的**唯一事实源**。
//
// 为什么要有这个文件：以前 check.mjs [5.6] 用宽松正则把路由路径分段拼接后模糊匹配，
// 结果 `DELETE /staff-users/:id` 被 `POST /staff-users` 命中 —— 门禁一直是绿的，
// 而真实情况是几十条写路由从没被执行过一次。这个文件把判定方式定死：
//
//   1) 从 backend/index.js 里提取全部路由（方法 + 字面路径，三种引号都认）；
//   2) 扫描 scripts/*.mjs 全文，把每个「HTTP 调用」的路径参数解析成
//      **分段列表**（静态段 / 动态段），例如
//        post('/staff-users/' + sid)  →  ['staff-users', <动态>]
//        call('DELETE', '/x/' + id + '/y') → ['x', <动态>, 'y']
//   3) 与后端路由做**逐段严格比对**：段数必须相同；路由里的 ':id' 段能匹配任意一段；
//      静态段必须字面相等。'POST /staff-users' 绝不算命中 'DELETE /staff-users/:id'。
//
// 差集就是「从来没跑过的写路由」。check.mjs 用它出红（除非都在白名单里），
// scripts/test-write-methods.mjs 用它驱动表格驱动的补测。

import fs from 'node:fs'
import path from 'node:path'

export const METHODS = ['get', 'post', 'put', 'patch', 'delete']

// ── 1. 从后端源码提取路由 ──
export function extractRoutes(beSrc) {
  const routes = []
  const re = /\bapp\.(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]*)\2/g
  for (const m of beSrc.matchAll(re)) {
    routes.push({ m: m[1].toUpperCase(), p: m[3].replace(/\$\{[^}]*\}/g, ':x') })
  }
  return routes
}

// ── 2. 表达式解析：把「'a/' + id + '/b'」拆成段 ──
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 按顶层 '+' 拆分
function splitTop(src, sep) {
  const out = []
  let depth = 0
  let quote = null
  let cur = ''
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      cur += c
      if (c === '\\') { cur += src[++i] || ''; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; continue }
    if ('([{'.includes(c)) depth++
    if (')]}'.includes(c)) depth--
    if (c === sep && depth === 0) { out.push(cur); cur = ''; continue }
    cur += c
  }
  if (cur.trim()) out.push(cur)
  return out
}

// 取 ( ... ) 里的内容（配对括号 + 跳过字符串）
export function extractCallArgs(src, openIdx) {
  let depth = 0
  let quote = null
  let out = ''
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      out += c
      if (c === '\\') { out += src[++i] || ''; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; continue }
    if (c === '(') { depth++; if (depth === 1) continue }
    if (c === ')') { depth--; if (depth === 0) break }
    out += c
  }
  return out
}

// 路径表达式 → 段列表（静态串 or null=动态）
// 做法：先把表达式拼成一条「字符流」，动态部分用占位符 \u0000 标出来，
// 再按 '/' 切段。这样 '/orders/' + id 会被正确切成 ['orders', <动态>]（不是 ['orders']）。
export function pathSegments(expr) {
  const parts = splitTop(expr, '+')
  let buf = ''
  for (const p of parts) {
    const t = p.trim()
    if (!t) continue
    let lit = null
    if (t.length >= 2) {
      const q = t[0]
      if ((q === "'" || q === '"' || q === '`') && t[t.length - 1] === q) {
        lit = t.slice(1, -1)
        if (q === '`') lit = lit.replace(/\$\{[^}]*\}/g, '\u0000') // 模板串里的插值当动态
      }
    }
    if (lit === null) { buf += '\u0000'; continue } // 整个是一个动态表达式
    buf += lit
  }
  const out = []
  for (const b of buf.split('/')) {
    if (b === '') continue
    out.push(b.includes('\u0000') ? null : b)
  }
  return out
}

// ── 3. 扫描 scripts/*.mjs，收集「方法 + 段列表」 ──
export function scanScriptUsage(scriptDir) {
  const used = []          // {m, segs}
  const seen = new Set()
  const add = (m, segs) => {
    const key = m + '|' + segs.map((s) => (s === null ? '*' : s)).join('/')
    if (seen.has(key)) return
    seen.add(key)
    used.push({ m, segs })
  }
  for (const f of fs.readdirSync(scriptDir).filter((x) => x.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(scriptDir, f), 'utf8')
    // ① 成对字面量：'POST /staff-users'
    // 注意 m[3] 只是路径部分（引号在外），要还原成带引号的字面量再分段，
    // 否则 pathSegments 会把它当「动态表达式」整段变 null，命中不了任何路由。
    for (const m of src.matchAll(/(['"`])\s*(GET|POST|PUT|PATCH|DELETE)\s+(\/[^'"`]*)\1/g)) {
      add(m[2], pathSegments(m[1] + m[3] + m[1]))
    }
    // ② method('/x') —— 第一个参数是路径
    for (const m of src.matchAll(/\b(get|post|put|patch|delete)\s*\(/g)) {
      const args = extractCallArgs(src, m.index + m[0].length - 1)
      const parts = splitTop(args, ',').map((x) => x.trim()).filter(Boolean)
      if (!parts.length) continue
      const segs = pathSegments(parts[0])
      if (!segs.length) continue
      add(m[1].toUpperCase(), segs)
    }
    // ③ call('DELETE', '/x') / req('POST','/x') —— 方法在第 1 个实参，路径在第 2 个实参
    for (const m of src.matchAll(/\b[A-Za-z_$][\w$]*\s*\(\s*(['"`])(GET|POST|PUT|PATCH|DELETE)\1\s*,\s*([^)]*)/g)) {
      const parts = splitTop(m[3], ',').map((x) => x.trim()).filter(Boolean)
      if (!parts.length) continue
      const segs = pathSegments(parts[0])
      if (!segs.length) continue
      add(m[2], segs)
    }
  }
  return used
}

// ── 4. 路由 vs 使用：逐段严格比对 ──
export function routeMatches(routePath, segs) {
  const a = routePath.split('/')
  // 去掉首尾空段（'/x/' → ['x']）
  if (a.length && a[0] === '') a.shift()
  while (a.length && a[a.length - 1] === '') a.pop()
  if (a.length !== segs.length) return false
  for (let i = 0; i < a.length; i++) {
    const rs = a[i]
    const ls = segs[i]
    if (rs.startsWith(':')) continue        // 路由参数段：任意一段都行
    if (ls === null) continue               // 脚本侧是动态表达式：无法证伪，放行
    if (rs !== ls) return false
  }
  return true
}

// ── 5. 求差集：哪些写路由从来没被脚本碰过 ──
export function uncoveredWrites(routes, used) {
  const writes = routes.filter((r) => r.m !== 'GET')
  const never = []
  for (const r of writes) {
    const hit = used.some((u) => u.m === r.m && routeMatches(r.p, u.segs))
    if (!hit) never.push(r)
  }
  return never
}
