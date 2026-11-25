// 一把跑完全套回归（和 .github/workflows/deploy.yml 里的顺序一致）。
//
// 用法：
//   node scripts/run-all.mjs --base http://127.0.0.1:8791 --key 8888
//
// 离线五件套（不联网、不依赖后端）照跑；联网件套逐个打后端，失败不中断，
// 最后列一张「失败 N 项」的清单并 exit 1。这样本地/CI 都能一键复用同一个顺序。
//
// 这两份清单是「全套回归有哪些测试」的**单一事实源**：`scripts/check-manifest.mjs` 会拿它去
// 比对 `.github/workflows/deploy.yml` / `release.yml` 里写死的步骤，谁少跑一个就红。
// 所以：**新加一个测试脚本，先在这里登记，再在 deploy.yml（联网件）里加一步**，release.yml
// 只跑离线五件套，不用动。别在 workflow 里加、这里忘了登记——那样 check-manifest 会报「多了」。

import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const OFFLINE = [
  'test-batch',
  'test-key-queue',
  'test-firstscreen',
  'test-list',
  'test-offline',
  // 这个不是「离线」——它自己起一个本机版服务（9 本账）验第 4 本账不写死三本；
  // 放这里只是因为它不依赖 --base 那个 wrangler 服务、自包含。
  'test-book4',
  // 定时任务（worker 的 scheduled()）离线回归：进程内 import backend/index.js，
  // 用 node:sqlite 造 D1 兼容环境，把 4 条 cron 各跑一遍。自包含、不联网、不依赖 --base。
  'test-cron',
  // 备份口径自检：读 backend/index.js 里真实的 BACKUP_SKIP / BACKUP_SETTINGS_SKIP，
  // 确认口令类的东西不会混进备份包。只用内置模块，不联网、不依赖服务。
  'check-backup',
  // 演示账套（给新手照着做的那份）自检：docs/演示账套/*.json 与
  // docs/新手照着做-完整账套演练.md 里那张月度表、全年结论必须逐个对得上。
  // 纯读文件，不联网 —— 谁重新生成演示账套而忘了改文档，这里立刻红。
  'check-demo-pack',
]

export const ONLINE = [
  'smoke',
  'test-modules',
  'smoke-write',
  'test-crossmonth',
  'test-apcat',
  'test-arcat',
  'test-import-xlsx',
  'test-onboarding',
  'test-safety',
  'test-demo',
  'test-archive',
  'test-book',
  'test-restore',
  'test-super',
  'test-staff',
  'test-perm',
  'test-pack',
  'test-template-fill',
  'test-preview',
  'test-undo',
  'test-impact',
  'test-upload',
  'test-fixes1',
  'test-fixes2',
  'test-fixes3',
  'test-fixes4',
  'test-cash-bridge',
  'test-tax',
  'test-numbers',
  'test-bookiso',
  'test-concurrency',
  'test-write-coverage',
  'test-write-methods',
  'test-profit-consistency',
  // 账套口径核验：同一个「净利」在 /kpi /trend /month-brief /cash-bridge /year-summary
  // /year-book /year-customers 七处必须是同一个数，外加桥接 18 行覆盖与打印页不缺格。
  // 第 21 轮拿模拟数据跑完整账套才发现的：这四个问题（报销不进成本、核销漏算、
  // 年度汇总用错常量、客户排行公式反了）都不报错，只是数字各说一套。
  'test-ledger',
  'test-oldbackup',
  // 网页端（打印页 / 客户对账页 / 电脑看账台）：纯 fetch 断言，不需要浏览器。
  // 第 19 轮加的 —— 这些页面以前没有任何自动化，「刚修好又被改坏」反复发生。
  'test-web-pages',
]

export const CASES = [...OFFLINE, ...ONLINE]

// 被 check-manifest.mjs import 时只取上面两份清单，别真跑；只有 `node scripts/run-all.mjs` 才跑。
// 第 17 轮 D4：`import.meta.main` 是 Node ≥24.2 才有的属性。
// 在 Node 22（backend/package.json 的 engines 下限）上它是 undefined → 下面的 main() 整段不执行，
// 退出码还是 0：迁移「跑完了」其实一条没跑、回归「全过」其实一个测试没跑。
// 用 argv[1] 与 import.meta.url 比较，Node 18+ 都可靠。
const IS_MAIN = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (IS_MAIN) {
  const argv = process.argv.slice(2)
  const opt = (n, d) => {
    const i = argv.indexOf('--' + n)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d
  }
  const BASE = opt('base', 'http://127.0.0.1:8791').replace(/\/+$/, '')
  const KEY = opt('key', '8888')
  // --offline：只跑离线件套（不联网、不依赖 --base 那个服务）。
  // release.yml 的自检 job 用它 —— 那里没有 wrangler dev 起的服务。
  const onlyOffline = argv.includes('--offline')

  const failed = []
  let passN = 0
  const t0 = Date.now()

  for (const name of OFFLINE) {
    const r = spawnSync('node', [`scripts/${name}.mjs`], { stdio: 'inherit' })
    if (r.status === 0) passN++
    else failed.push(name + '（离线，退出码 ' + r.status + '）')
  }

  if (!onlyOffline) {
    for (const name of ONLINE) {
      const r = spawnSync('node', [`scripts/${name}.mjs`, '--base', BASE, '--key', KEY], { stdio: 'inherit' })
      if (r.status === 0) passN++
      else failed.push(name)
    }
  }

  const total = onlyOffline ? OFFLINE.length : OFFLINE.length + ONLINE.length
  const sec = Math.round((Date.now() - t0) / 1000)
  console.log('\n──────────────────────────────────────────────')
  console.log(`跑完 ${total} 件，通过 ${passN}，失败 ${failed.length}，用时 ${sec}s`)
  if (failed.length) {
    console.log('失败清单：')
    for (const f of failed) console.log('  ❌ ' + f)
    process.exit(1)
  } else {
    console.log('✅ 全套全绿')
  }
}
