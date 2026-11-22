#!/usr/bin/env node
// 本机版运维 CLI：把常用运维动作收成一句命令，不用记一堆 curl。
// 用法：
//   node scripts/cli.mjs status [--base URL] [--key K] [--book N]   版本 + 体检
//   node scripts/cli.mjs backup [--base URL] [--key K] [--book N]   立即全量备份
//   node scripts/cli.mjs cron   [--base URL] [--key K] [--book N]   手动跑每日结账（固定支出/摊销/预提/折旧）
//   node scripts/cli.mjs clean  [--base URL] [--key K] [--days 180] 清日志（业务数据不动）
//   node scripts/cli.mjs diag   [--base URL] [--key K] [--book N]   一键诊断（转发给 diag.mjs）
//   node scripts/cli.mjs reset  [--base URL] [--key K] --yes        清空账本（危险，必须 --yes）
// 默认 BASE=http://127.0.0.1:8787（本机版 server/main.mjs 的默认端口）、KEY=8888。
import { harness } from './_harness.mjs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const cmd = process.argv[2]
const h = harness({ tag: 'cli' })
const { BASE, KEY, arg, get, post } = h

const here = path.dirname(fileURLToPath(import.meta.url))

async function main() {
  if (!cmd) { usage(); process.exit(1) }

  if (cmd === 'diag') {
    const extra = ['--base', BASE, '--key', KEY]
    if (arg('book')) extra.push('--book', arg('book'))
    const r = spawnSync('node', [path.join(here, 'diag.mjs'), ...extra], { stdio: 'inherit' })
    process.exit(r.status || 0)
  }

  if (cmd === 'status') {
    const v = await get('/version')
    const sc = await get('/selfcheck')
    if (!v.d) return fail('连不上服务：' + BASE + '（先跑 server/main.mjs 或 wrangler dev）')
    console.log('版本    ' + (v.d.version || '?') + '  commit ' + (v.d.commit || '?').slice(0, 12))
    if (sc.d) {
      console.log('体检    ' + (sc.d.score ?? '?') + ' 分 · ' + (sc.d.grade ?? '') + (sc.d.clean ? '（干净）' : '（' + (sc.d.count ?? 0) + ' 处告警）'))
      for (const it of (sc.d.items || [])) if (it.count > 0) console.log('  ⚠ ' + it.label + ' × ' + it.count)
    }
    process.exit(sc.status >= 500 ? 1 : 0)
  }

  if (cmd === 'backup') {
    const r = await get('/backup')
    if (r.status >= 400) return fail('备份失败 HTTP ' + r.status, r.d)
    console.log('✅ 备份完成')
    if (r.d && r.d.at) console.log('   at ' + r.d.at + '  份数 ' + (r.d.count ?? '?'))
    process.exit(0)
  }

  if (cmd === 'cron') {
    const r = await post('/run-cron', {})
    if (r.status >= 400) return fail('跑 cron 失败 HTTP ' + r.status, r.d)
    console.log('✅ 每日结账跑完：' + JSON.stringify(r.d))
    process.exit(r.d && r.d.ok === false ? 1 : 0)
  }

  if (cmd === 'clean') {
    const days = Math.round(Number(arg('days', 180)))
    const r = await post('/db-clean', { days })
    if (r.status >= 400) return fail('清理失败 HTTP ' + r.status, r.d)
    console.log('✅ 清理完成（' + days + ' 天前的日志）：' + JSON.stringify(r.d && r.d.deleted || {}))
    process.exit(0)
  }

  if (cmd === 'reset') {
    if (arg('yes') !== '1' && !process.argv.includes('--yes')) {
      console.log('❌ 清空账本是不可逆操作（业务数据全删，只剩备份）。确认要清空就在命令末尾加 --yes。')
      process.exit(1)
    }
    const r = await post('/book-reset', { confirm: '清空' })
    if (r.status >= 400) return fail('清空失败 HTTP ' + r.status, r.d)
    console.log('✅ 账本已清空')
    process.exit(0)
  }

  usage(); process.exit(1)
}

function usage() {
  console.log('本机版运维 CLI —— 用法：node scripts/cli.mjs <命令> [--base URL] [--key K] [--book N]')
  console.log('  命令：status | backup | cron | clean [--days N] | diag | reset --yes')
}
function fail(msg, d) {
  console.log('❌ ' + msg)
  if (d && d.error) console.log('   ' + d.error)
  process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
