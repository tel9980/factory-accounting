#!/usr/bin/env node
// 本机版运维 CLI：把常用运维动作收成一句命令，不用记一堆 curl。
// 用法：
//   node scripts/cli.mjs status [--base URL] [--key K] [--book N]   版本 + 体检
//   node scripts/cli.mjs backup [--base URL] [--key K] [--book N]   立即全量备份
//   node scripts/cli.mjs cron   [--base URL] [--key K] [--book N]   手动跑每日结账（固定支出/摊销/预提/折旧）
//   node scripts/cli.mjs clean  [--base URL] [--key K] [--days 180] 清日志（业务数据不动）
//   node scripts/cli.mjs diag   [--base URL] [--key K] [--book N]   一键诊断（转发给 diag.mjs）
//   node scripts/cli.mjs reset  [--base URL] [--key K] --yes        清空账本（危险，必须 --yes）
//   node scripts/cli.mjs backups [--base URL] [--key K]            列最近的备份
//   node scripts/cli.mjs restore <id> [--book N] [--base URL] [--key K] --yes 回到某份备份（危险，必须 --yes）
//   node scripts/cli.mjs errors  [--base URL] [--key K] [--days 7] 看最近的报错
//   node scripts/cli.mjs migrate [--base URL] --yes               跑远程 D1 迁移（改库，必须 --yes）
// BASE/KEY 可以用环境变量给：FA_BASE / FA_KEY（命令行参数优先，其次环境变量，最后默认值）。
// 默认 BASE=http://127.0.0.1:8791（scripts/_harness.mjs 的默认）、KEY=8888。
import { harness } from './_harness.mjs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const cmd = process.argv[2]
// 环境变量优先（FA_BASE / FA_KEY），命令行参数其次，最后才是默认值。
// 这样在 CI / 容器里不用把口令写进命令行历史。
const envBase = process.env.FA_BASE || ''
const envKey = process.env.FA_KEY || ''
// 第 16 轮 C8：FA_BASE 和 --base 同时给、又不一样时，以前静默选命令行那个 ——
// 结果「我以为在打测试库，其实打的是生产」，而 reset / restore / migrate 都是不可逆的。
// 现在直接拒绝，让用户自己选一个。
const cliBaseAt = process.argv.indexOf('--base')
const cliBase = cliBaseAt > 0 && process.argv[cliBaseAt + 1] ? process.argv[cliBaseAt + 1] : ''
const normB = (x) => String(x || '').replace(/\/+$/, '')
if (envBase && cliBase && normB(envBase) !== normB(cliBase)) {
  console.error('❌ FA_BASE=' + envBase + ' 和 --base ' + cliBase + ' 不一致：不知道你想动哪台机器。')
  console.error('   两个只留一个（环境变量还是命令行参数，自己选）。')
  process.exit(2)
}
const h = harness({ tag: 'cli', base: envBase || undefined, key: envKey || undefined })
const { BASE, KEY, arg, get, post } = h

// 危险动作（清空/覆盖/改库）之前，必须把「到底动哪台机器的哪本账」打在屏幕上，
// 别让人凭记忆确认。
const sayTarget = (book) => {
  console.log('⚠️  目标：' + BASE + (book ? '（第 ' + book + ' 本账）' : ''))
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(BASE)) {
    console.log('⚠️  这不是本机地址 —— 确认一下是不是你要动的那台。')
  }
}

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
    sayTarget(arg('book'))
    const r = await post('/book-reset', { confirm: '清空' })
    if (r.status >= 400) return fail('清空失败 HTTP ' + r.status, r.d)
    console.log('✅ 账本已清空')
    process.exit(0)
  }

  if (cmd === 'backups') {
    const r = await get('/backup-list')
    if (r.status >= 400) return fail('列备份失败 HTTP ' + r.status, r.d)
    const rows = Array.isArray(r.d) ? r.d : (r.d && r.d.rows) || []
    if (!rows.length) { console.log('（还没有备份）'); process.exit(0) }
    console.log('最近 ' + rows.length + ' 份备份：')
    for (const b of rows) console.log('  #' + b.id + '  ' + (b.created_at || b.at || '') + '  ' + (b.size ?? '?') + ' 字节  第' + (b.book || '1') + '本账')
    // 第 11 轮 E3：备份 id 每本账各自从 1 数。提示里以前不带账套号，
    // 照着抄进 restore 就会拿第 2 本的 #5 去覆盖第 1 本的 #5（完全不同的两份账）。
    const first = rows[0] || {}
    console.log('恢复其中一份：node scripts/cli.mjs restore <id> --book ' + (first.book || '1') + ' --yes')
    process.exit(0)
  }

  if (cmd === 'restore') {
    const id = Number(process.argv[3])
    if (!id) { console.log('❌ 要写明恢复哪一份备份：node scripts/cli.mjs restore <id> --book N --yes'); process.exit(1) }
    if (!process.argv.includes('--yes')) {
      console.log('❌ 恢复会用备份覆盖现在的账目（不可逆，只剩快照能退）。确认要恢复就在命令末尾加 --yes。')
      process.exit(1)
    }
    // 第 11 轮 E3：恢复必须带上是「哪本账的备份」。
    // 不给 --book 就从备份列表里查出这份 id 属于哪本（查不到就拒绝，绝不猜成第 1 本）。
    let book = arg('book')
    if (!book) {
      const lr = await get('/backup-list')
      const rows2 = Array.isArray(lr.d) ? lr.d : (lr.d && lr.d.rows) || []
      const hit = rows2.filter((x) => Number(x.id) === id)
      if (hit.length === 1) book = hit[0].book || '1'
      else if (hit.length > 1) {
        console.log('❌ 备份 #' + id + ' 在多本账里都存在，要写明是哪一本：--book N（先跑 backups 看「第N本账」）')
        process.exit(1)
      } else {
        console.log('❌ 备份列表里没有 #' + id + '，先跑 backups 看有哪些（也可以加 --book N 指定账套）')
        process.exit(1)
      }
    }
    sayTarget(String(book))
    const r = await post('/backup-restore', { id, confirm: '覆盖', book: String(book) }, { book: String(book) })
    if (r.status >= 400) return fail('恢复失败 HTTP ' + r.status, r.d)
    console.log('✅ 已恢复第 ' + book + ' 本账到备份 #' + id)
    process.exit(0)
  }

  if (cmd === 'errors') {
    const days = Math.round(Number(arg('days', 7)))
    const r = await get('/error-log?days=' + days + '&limit=50')
    if (r.status >= 400) return fail('查报错失败 HTTP ' + r.status, r.d)
    const rows = (r.d && (r.d.rows || r.d.items)) || []
    console.log('最近 ' + days + ' 天 ' + (r.d && r.d.total != null ? r.d.total : rows.length) + ' 条报错')
    for (const e of rows.slice(0, 30)) console.log('  ' + (e.created_at || '') + '  ' + (e.status || '') + '  ' + (e.method || '') + ' ' + (e.path || '') + '  ' + String(e.msg || e.message || '').slice(0, 120))
    process.exit(0)
  }

  if (cmd === 'migrate') {
    if (!process.argv.includes('--yes')) {
      console.log('❌ 迁移会改线上数据库的结构（加列、加索引），确认要跑就在命令末尾加 --yes。')
      process.exit(1)
    }
    // 这个命令打的不是 BASE，是 wrangler.toml 里的**远程** D1（跟线上是同一批库）
    console.log('⚠️  目标：backend/wrangler.toml 里声明的远程 D1（线上那几本账）—— 不是 ' + BASE)
    const r = spawnSync('node', [path.join(here, 'd1-migrate.mjs')], { stdio: 'inherit' })
    process.exit(r.status || 0)
  }

  usage(); process.exit(1)
}

function usage() {
  console.log('本机版运维 CLI —— 用法：node scripts/cli.mjs <命令> [--base URL] [--key K] [--book N]')
  console.log('  命令：status | backup | cron | clean [--days N] | diag | reset --yes')
  console.log('        backups | restore <id> --book N --yes | errors [--days N] | migrate --yes')
  console.log('  BASE/KEY 也可用环境变量给：FA_BASE / FA_KEY')
}
function fail(msg, d) {
  console.log('❌ ' + msg)
  if (d && d.error) console.log('   ' + d.error)
  process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
