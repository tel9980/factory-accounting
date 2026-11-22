// A5：员工能不能看到成本/毛利 —— 自动扫描 + 基线断言。
//
// 为什么要有它：以前「哪些接口不给员工看」是靠三张手工正则名单
// （STAFF_MONEY_DENY / STAFF_MONEY_SCRUB / STAFF_COST_PATHS）管的，
// 以后每加一个接口，都得记得把它加进名单 —— 忘了就漏（真漏过：
// /price-lookup 会把成本单价和「（成本 X 元）」文案发给员工）。
//
// 这里做两件事：
//   ① 扫出所有 GET 路由的 handler 里出现了哪些「钱/成本/利润」字段；
//   ② 断言：每一个命中字段的路由，要么在三张名单里，要么在基线白名单里
//      （scripts/staff-safe-baseline.json，白名单每条都要写明为什么可以给员工看）。
//
// 新增接口默认安全：只要它返回了成本/利润，又没进名单，白名单里也没有 → 这里就红。
import fs from 'node:fs'
import path from 'node:path'

// 判定「这个字段是不是钱/成本/利润」的关键词
const MONEY_WORDS = [
  'cost', 'profit', 'margin', 'gross', 'gross_pct', 'gross_net', 'mat_cost',
  'unit_cost', 'last_cost', 'total_cost', 'cost_total', 'netasset', 'networth',
  'break_even', 'var_ratio', 'accrual', 'amort', 'depreciation',
]

const DENY_RE = /^\/(margin-by|cost-hint|report-data|report$|cashbook|health-report|invoice-check|cashflow|networth(-snapshots)?$|funding|year-print-link)/
const SCRUB_RE = /^\/(wip|materials|supply-price|frame-prices|rework-book|outsource-book)/
const COST_RE = /^\/(ar|ap|orders|settled|quick$|collect)/

// 从 backend/index.js 里抽出所有 GET 路由 + 它后面那一段 handler 文本
export function scanMoneyRoutes(beSrc) {
  const re = /app\.get\(\s*'([^']+)'/g
  const out = []
  let m
  while ((m = re.exec(beSrc))) {
    const path = m[1]
    // handler 体：从 app.get 之后到下一个 app.get/app.post 为止（粗切，够用）
    const nextIdx = beSrc.indexOf('\napp.', m.index + 10)
    const body = beSrc.slice(m.index, nextIdx > 0 ? nextIdx : beSrc.length)
    const words = MONEY_WORDS.filter((w) =>
      new RegExp(`(^|[^A-Za-z0-9_])${w}([^A-Za-z0-9_]|$)`, 'i').test(body)
    )
    if (words.length) out.push({ path, words })
  }
  return out
}

export function staffLists(beSrc) {
  // 从源码里取「正则字面量」的内容（不含首尾斜杠），注意字面量里可能有转义斜杠 \\/，
  // 所以要按 (?:[^/\\]|\\.)* 逐字符吃掉，别用 [^/]* （那会在 \\/ 处截断）。
  const grab = (name) => {
    const m = beSrc.match(new RegExp(`const\\s+${name}\\s*=\\s*\\/((?:[^/\\\\]|\\\\.)*)\\/`))
    return m ? m[1] : ''
  }
  return {
    deny: grab('STAFF_MONEY_DENY'),
    scrub: grab('STAFF_MONEY_SCRUB'),
    cost: grab('STAFF_COST_PATHS'),
  }
}

// 从 denyStaff 那一整段里抠出所有正则字面量（除了三张 STAFF_* 名单，还有很多条内联规则）
export function denyStaffRegexes(beSrc) {
  const i = beSrc.indexOf('const denyStaff =')
  if (i < 0) return []
  const j = beSrc.indexOf('if (denyStaff)', i)
  const block = beSrc.slice(i, j > 0 ? j : beSrc.length)
  const out = []
  const re = /\/((?:[^/\\]|\\.)*)\//g
  let m
  while ((m = re.exec(block))) out.push(m[1])
  return out
}

export function classify(path, lists, extra) {
  try {
    if (lists.deny && new RegExp(lists.deny).test(path)) return 'deny'
  } catch (e) { /* 正则坏了就当没拦住 */ }
  try {
    if (lists.scrub && new RegExp(lists.scrub).test(path)) return 'scrub'
  } catch (e) { /* 同上 */ }
  try {
    if (lists.cost && new RegExp(lists.cost).test(path)) return 'cost'
  } catch (e) { /* 同上 */ }
  for (const r of (extra || [])) {
    try { if (new RegExp(r).test(path)) return 'deny' } catch (e) { /* 正则坏了就当没拦住 */ }
  }
  return 'none'
}

// 基线文件：{ "<path>": "<为什么可以给员工看>" }
export function loadBaseline(root) {
  const p = path.join(root, 'scripts/staff-safe-baseline.json')
  if (!fs.existsSync(p)) return {}
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return {} }
}
