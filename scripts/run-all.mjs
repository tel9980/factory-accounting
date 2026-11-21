// 一把跑完全套回归（和 .github/workflows/deploy.yml 里的顺序一致）。
//
// 用法：
//   node scripts/run-all.mjs --base http://127.0.0.1:8791 --key 8888
//
// 离线五件套（不联网、不依赖后端）照跑；联网件套逐个打后端，失败不中断，
// 最后列一张「失败 N 项」的清单并 exit 1。这样本地/CI 都能一键复用同一个顺序。

import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const BASE = opt('base', 'http://127.0.0.1:8791').replace(/\/+$/, '')
const KEY = opt('key', '8888')

const OFFLINE = [
  'test-batch',
  'test-key-queue',
  'test-firstscreen',
  'test-list',
  'test-offline',
]

const ONLINE = [
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
  'test-oldbackup',
]

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
