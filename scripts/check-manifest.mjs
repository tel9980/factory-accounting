// 比对「run-all.mjs 登记的回归清单」和两个 workflow 里写死的步骤，防止三处漂移。
//
// 为什么值得：以前加一个测试脚本要在 run-all.mjs、deploy.yml（可能还有 release.yml）三处
// 各加一遍，漏一处 = 那个测试在 CI 里根本不跑，本地却「全绿」，给人假的安全感。
// 现在 run-all.mjs 是单一事实源，这里只做一件事：谁跟它不一致就红。
//
// 规则：
//   - ONLINE 每件都必须出现在 deploy.yml（联网件，起本地服务后打后端）。
//   - OFFLINE 每件都必须出现在 deploy.yml 和 release.yml（纯离线，不用起服务）。
//   - workflow 里引用到的 test-*.mjs 如果不在 CASES 里（除了部署后体检那几条特殊步骤），
//     说明是「登记漏了」，也红。
//
// 用法：node scripts/check-manifest.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CASES, OFFLINE, ONLINE } from './run-all.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEPLOY = path.join(ROOT, '.github/workflows/deploy.yml')
const RELEASE = path.join(ROOT, '.github/workflows/release.yml')

const deploy = fs.readFileSync(DEPLOY, 'utf8')
const release = fs.readFileSync(RELEASE, 'utf8')

const bad = []
const fail = (m) => { bad.push(m); console.log('  ❌ ' + m) }

// workflow 里以 `node scripts/<name>.mjs`（或 `node ./scripts/x.mjs`、`bash scripts/x.sh`）跑过的脚本。
// 第 17 轮 D9：原来的正则漏了 `./` 前缀和 bash 调用 —— 写成 `node ./scripts/x.mjs` 就等于绕过门禁。
const scriptsOf = (src) => [
  ...[...src.matchAll(/(?:node|bash|sh)\s+(?:\.\/)?scripts\/([a-z0-9-]+\.(?:mjs|sh))/g)].map((m) => m[1])
]

const deployScripts = new Set(scriptsOf(deploy))
const releaseScripts = new Set(scriptsOf(release))

// 1) 联网件：deploy.yml 里必须都有
for (const name of ONLINE) {
  if (!deployScripts.has(name + '.mjs')) fail(`ONLINE「${name}」在 deploy.yml 里没有对应步骤（新测试要登记进 run-all.mjs 的 ONLINE，再在 deploy.yml 的 smoke job 加一步）`)
}

// 2) 离线件：deploy.yml 和 release.yml 里都必须有
for (const name of OFFLINE) {
  if (!deployScripts.has(name + '.mjs')) fail(`OFFLINE「${name}」在 deploy.yml 里没有对应步骤`)
  if (!releaseScripts.has(name + '.mjs')) fail(`OFFLINE「${name}」在 release.yml 里没有对应步骤`)
}

// 2.5) 第 17 轮 D9：光看「脚本名在文件里出现过」不够 —— 那个 step 可能被
//      `continue-on-error: true`（失败也绿）或 `if: false`（永远不跑）关掉，
//      于是「测试跑过了」是假的。按 `- name:` 切块，逐块检查。
{
  const blocks = []
  let cur = null
  for (const ln of deploy.split('\n')) {
    const m = /^\s*-\s+name:\s*(.+)$/.exec(ln)
    if (m) { cur = { name: m[1].trim(), body: [] }; blocks.push(cur); continue }
    if (cur) cur.body.push(ln)
  }
  const offed = []
  for (const b of blocks) {
    const text = b.body.join('\n')
    if (!/(?:node|bash|sh)\s+(?:\.\/)?scripts\/(test-[a-z0-9-]+\.(?:mjs|sh))/.test(text)) continue
    if (/^\s*if:\s*(false|\$\{\{\s*false\s*\}\})\s*$/m.test(text)) offed.push(b.name + '（if: false）')
    else if (/^\s*continue-on-error:\s*true\s*$/m.test(text)) offed.push(b.name + '（continue-on-error: true）')
  }
  if (offed.length) {
    for (const o of offed) console.log(`  ⚠️ 这个 step 跑测试但失败不会红：${o}`)
  }
}

// 3) 反向：workflow 里引用的 test-*.mjs 不该是「清单里没有」的孤儿
const caseSet = new Set(CASES)
for (const [label, set] of [['deploy.yml', deployScripts], ['release.yml', releaseScripts]]) {
  for (const s of set) {
    const base = s.replace(/\.mjs$/, '')
    // smoke / smoke-write / gen-* 这些不是「测试清单」里的件，属于部署/生成步骤，跳过；
    // 只盯 test-* 这一族的孤儿。
    if (!base.startsWith('test-')) continue
    if (!caseSet.has(base)) fail(`${label} 引用了 test 脚本「${base}」，但 run-all.mjs 的清单里没有它（登记漏了，或该删却只删了 workflow）`)
  }
}

// 4) 第 12 轮 F7：以前反向只查 test-*，d1-*/gen-*/check-*/cli/diag 等非 test 脚本漏登记
//    永远不红，腐烂到发布/回滚才炸。现在全量枚举 scripts/*.mjs，非下划线开头的必须
//    出现在 workflow，或在显式 MANUAL 白名单里（注明用途）。
//    MANUAL：只给本地用、不需要进 CI 的工具脚本。
// 第 14 轮：book-add 是「本机加一本线上账套」的一次性工具 —— 建库要真 CF 凭证、
// 还要往 wrangler.toml 写绑定，放进 CI 只会变成「每次部署都试一次建库」，所以留在本地。
// 第 21 轮：mock-data 是「往干净库灌一套模拟账套」的演练工具 —— 它会写几百条单据、
// 还会把月份结账锁定，跑在 CI 里只会把后面所有测试的数据搅浑，所以只在本地手动跑。
const MANUAL = new Set(['cli', 'diag', 'migrations-lib', 'prof', 'book-add', 'mock-data']) // 本地工具，不进 CI
{
  const dir = path.join(ROOT, 'scripts')
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.startsWith('_'))
  const known = new Set([...deployScripts, ...releaseScripts].map((x) => x.replace(/\.mjs$/, '')))
  for (const f of all) {
    const base = f.replace(/\.mjs$/, '')
    if (known.has(base)) continue
    if (MANUAL.has(base)) continue
    fail(`scripts/${base}.mjs 既没被 workflow 引用，也不在 MANUAL 白名单里（要么登记进 workflow，要么确认它只本地用后加进 check-manifest.mjs 的 MANUAL）`)
  }
}

console.log(`\n[check-manifest] run-all.mjs：离线 ${OFFLINE.length} 件 + 联网 ${ONLINE.length} 件 = ${CASES.length} 件`)
console.log(`  deploy.yml 引用了 ${deployScripts.size} 个 node scripts/*.mjs，release.yml 引用了 ${releaseScripts.size} 个`)
if (bad.length) {
  console.log(`\n❌ 清单漂移 ${bad.length} 处，修完再部署\n`)
  process.exit(1)
}
console.log('✅ 三处清单一致\n')
