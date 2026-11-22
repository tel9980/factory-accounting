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
  'test-tax',
  'test-numbers',
  'test-bookiso',
  'test-concurrency',
  'test-write-coverage',
  'test-profit-consistency',
  'test-oldbackup',
]

export const CASES = [...OFFLINE, ...ONLINE]

// 被 check-manifest.mjs import 时只取上面两份清单，别真跑；只有 `node scripts/run-all.mjs` 才跑。
if (import.meta.main) {
  const argv = process.argv.slice(2)
  const opt = (n, d) => {
    const i = argv.indexOf('--' + n)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d
  }
  const BASE = opt('base', 'http://127.0.0.1:8791').replace(/\/+$/, '')
  const KEY = opt('key', '8888')

  const failed = []
  let passN = 0
  const t0 = Date.now()

  for (const name of OFFLINE) {
    const r = spawnSync('node', [`scripts/${name}.mjs`], { stdio: 'inherit' })
    if (r.status === 0) passN++
    else failed.push(name + '（离线，退出码 ' + r.status + '）')
  }

  for (const name of ONLINE) {
    const r = spawnSync('node', [`scripts/${name}.mjs`, '--base', BASE, '--key', KEY], { stdio: 'inherit' })
    if (r.status === 0) passN++
    else failed.push(name)
  }

  const sec = Math.round((Date.now() - t0) / 1000)
  console.log('\n──────────────────────────────────────────────')
  console.log(`跑完 ${OFFLINE.length + ONLINE.length} 件，通过 ${passN}，失败 ${failed.length}，用时 ${sec}s`)
  if (failed.length) {
    console.log('失败清单：')
    for (const f of failed) console.log('  ❌ ' + f)
    process.exit(1)
  } else {
    console.log('✅ 全套全绿')
  }
}
