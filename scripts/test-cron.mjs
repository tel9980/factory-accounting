// 定时任务（Cloudflare Worker 的 scheduled()）离线回归。
//
// 背景：backend/index.js 里的 scheduled(event, env, ctx) 是 Cloudflare Cron 触发的那一支，
// 但 /run-cron 只跑 fixed/amort/accrual/dep/selfcheck，scheduled() 里的分支
// （pushWeekly / pushReconRemind / runMonthPack / pushMonthPack / runWxReminder /
//   pushTargetSummary / pushDunningSummary / snapNet / pushToNotes / uploadClean /
//   自动备份 saveBackup …）一行都没有测试覆盖 —— 线上是没人能触发的「黑盒」。
//
// 为什么是「进程内 import worker」而不是起本机版服务：
//   scheduled() 只能被 CF 的 Cron 事件触发，本机版 server/main.mjs 虽然也调它，
//   但那要等真实时钟到点（一天一次），测试没法等。所以这里直接
//   import backend/index.js 的 default.scheduled，用 server/d1.mjs 的 LocalD1（node:sqlite）
//   造一个和 server/main.mjs 一模一样的 env（DB/DB2…DB9 绑定 + ENV_ALL + ctx.waitUntil），
//   然后把 4 条 cron（backend/wrangler.toml 里那 4 条）各跑一遍。
//
// 不联网、不需要 CF_API_TOKEN：微信通道没配 token 时应该被优雅跳过（不算失败），
// 但如果因为「没配微信」而抛未捕获异常，那本身就是缺陷 —— 记成一条失败断言，
// 并往 settings 里塞一份假的微信配置，让它能走完流程。
//
// 这个脚本自包含、不依赖 --base，登记在 run-all.mjs 的 OFFLINE。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = path.join(os.tmpdir(), 'fa-cron-' + Date.now().toString(36))

const pass = []
const bad = []
const ok = (m) => { pass.push(m); console.log('  ✅ ' + m) }
const no = (m, d) => { bad.push(m); console.log('  ❌ ' + m + (d === undefined ? '' : ' → ' + JSON.stringify(d))) }
const yes = (l, c, d) => (c ? ok(l) : no(l, d))
const finish = (name) => {
  console.log('')
  console.log(`通过 ${pass.length} 项 / 失败 ${bad.length} 项`)
  if (bad.length) {
    console.log(`❌ ${name} ${bad.length} 项失败：`)
    bad.forEach((x) => console.log('   · ' + x))
    process.exit(1)
  }
  console.log(`✅ ${name} ${pass.length} 项全部通过`)
  process.exit(0)
}

const CRONS = ['0 16 * * *', '0 1 * * *', '0 1 * * 1', '0 2 1 * *']
// 断网闸：整个脚本不许碰网络（微信取 token、笔记站上传都要走 fetch）。
// 一旦有代码真的去联网，这里直接抛错 —— 既保证离线可跑，也能立刻暴露「偷偷联网」。
globalThis.fetch = async (url) => {
  throw new Error('测试里不许联网：被请求的地址是 ' + String(url))
}
const TZ_MS = 8 * 3600 * 1000
const bjNow = () => new Date(Date.now() + TZ_MS)
const bjDay = () => bjNow().toISOString().slice(0, 10)
const prevMonth = () => {
  const d = bjNow()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)
}
const curMonth = () => bjNow().toISOString().slice(0, 7)

let worker = null
let env = null
let db = null
let db2 = null

const q = async (d, sql, ...args) => {
  const r = await d.prepare(sql).bind(...args).all()
  return (r && r.results) || []
}
const q1 = async (d, sql, ...args) => {
  const r = await d.prepare(sql).bind(...args).first()
  return r || null
}
const count = async (d, table) => {
  const r = await q1(d, `SELECT COUNT(*) AS c FROM ${table}`)
  return Number((r && r.c) || 0)
}
const setting = async (d, key) => {
  const r = await q1(d, 'SELECT value FROM settings WHERE key=?', key)
  return r ? r.value : null
}

// 造一份「账实对得上」的种子数据：自检 bad 必须是 0，否则没法证明 cron 没把账写坏。
async function seed(d, tag) {
  const nowIso = bjNow().toISOString()
  const pm = prevMonth()
  await d.prepare("INSERT INTO accounts (name, kind, opening, created_at) VALUES (?,?,?,?)").bind(tag + '现金', 'cash', 10000, nowIso).run()
  const accId = Number((await q1(d, 'SELECT id FROM accounts ORDER BY id LIMIT 1')).id)
  // 两笔单据：本月一笔、上月一笔（上月那笔是为了让月度报表包 / 家底存档有账可算）
  const mk = async (price, paid, month, customer) => {
    const created = month + '-05T09:00:00.000Z'
    await d.prepare('INSERT INTO orders (customer, item_name, price, status, paid, created_at, created_by) VALUES (?,?,?,?,?,?,?)')
      .bind(customer, tag + '货', price, 'done', paid, created, 'test').run()
    const oid = Number((await q1(d, 'SELECT id FROM orders ORDER BY id DESC LIMIT 1')).id)
    await d.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, created_at, month, account_id, cash) VALUES ('in','order',?,?,?,?,?,?,?,1)")
      .bind(oid, paid, tag + '货款', customer, created, month, accId).run()
  }
  await mk(1000, 1000, curMonth(), tag + '客户甲')
  await mk(800, 800, pm, tag + '客户乙')
  // 应付一笔，付清
  await d.prepare('INSERT INTO payables (supplier, amount, paid, category, remark, created_at, month, created_by) VALUES (?,?,?,?,?,?,?,?)')
    .bind(tag + '供应商', 500, 500, '采购', '', curMonth() + '-06T09:00:00.000Z', curMonth(), 'test').run()
  const pid = Number((await q1(d, 'SELECT id FROM payables ORDER BY id DESC LIMIT 1')).id)
  await d.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, created_at, month, account_id, cash) VALUES ('out','payable',?,?,?,?,?,?,?,1)")
    .bind(pid, 500, tag + '采购款', '', curMonth() + '-06T09:00:00.000Z', curMonth(), accId).run()
  // 固定支出（自动记账那条路要有活干）：day=1，保证当月一定补记一次
  await d.prepare('INSERT INTO fixed_expenses (amount, category, remark, day, created_at) VALUES (?,?,?,?,?)')
    .bind(300, '房租', tag + '房租', 1, nowIso).run()
  // 月度目标 / 催款记录（月底那两条推送要有数据才不至于早退）
  await d.prepare('INSERT INTO targets (month, receive, order_add, created_at) VALUES (?,?,?,?)')
    .bind(pm, 100000, 0, nowIso).run()
  await d.prepare('INSERT INTO dunning_log (party, type, channel, note, created_at) VALUES (?,?,?,?,?)')
    .bind(tag + '客户乙', 'call', '电话', '催了一次', pm + '-10T09:00:00.000Z').run()
  return { accId }
}

// 备份内容超过 500KB 时才会拆成 backup_parts（分片备份那条路平时走不到）。
// 造一批体积够大的小额单据（price=paid=0，不影响自检），把备份撑过 500KB。
async function seedBulk(d) {
  const created = curMonth() + '-08T09:00:00.000Z'
  const filler = 'x'.repeat(120)
  for (let i = 0; i < 2500; i++) {
    await d.prepare('INSERT INTO orders (customer, item_name, price, status, paid, created_at, created_by) VALUES (?,?,?,?,?,?,?)')
      .bind('批量客户' + (i % 50), filler, 0, 'done', 0, created, 'bulk').run()
  }
}

async function selfCheckBad(d) {
  // 用后端同一个算法不好直接调（不导出），这里用 /selfcheck 的等价指标：
  // 单据已收/已付 与流水合计是否一致（错账最典型的表现）。
  const orders = await q(d, 'SELECT id, price, paid, COALESCE(written_off,0) AS wo FROM orders')
  const inSum = new Map((await q(d, "SELECT ref_id, COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='in' AND ref_type='order' GROUP BY ref_id")).map((x) => [String(x.ref_id), Number(x.t)]))
  const outSum = new Map((await q(d, "SELECT ref_id, COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND ref_type='payable' GROUP BY ref_id")).map((x) => [String(x.ref_id), Number(x.t)]))
  let bad = 0
  for (const o of orders) {
    if (Math.round((inSum.get(String(o.id)) || 0) * 100) !== Math.round(Number(o.paid) * 100)) bad++
    if (Number(o.paid) > Number(o.price)) bad++
  }
  for (const p of await q(d, 'SELECT id, amount, paid, COALESCE(written_off,0) AS wo FROM payables')) {
    if (Math.round((outSum.get(String(p.id)) || 0) * 100) !== Math.round(Number(p.paid) * 100)) bad++
  }
  const orphan = Number((await q1(d, "SELECT COUNT(*) AS c FROM ledger l WHERE l.ref_id > 0 AND ((l.ref_type='order' AND NOT EXISTS (SELECT 1 FROM orders x WHERE x.id=l.ref_id)) OR (l.ref_type='payable' AND NOT EXISTS (SELECT 1 FROM payables x WHERE x.id=l.ref_id)))")).c || 0)
  const monthNull = Number((await q1(d, "SELECT (SELECT COUNT(*) FROM orders WHERE month IS NULL OR month='') + (SELECT COUNT(*) FROM payables WHERE month IS NULL OR month='') + (SELECT COUNT(*) FROM ledger WHERE month IS NULL OR month='') AS c")).c || 0)
  return bad + orphan + monthNull
}

const cronErrRows = async (d) => q(d, "SELECT path, msg FROM error_log WHERE method='CRON'")

async function run() {
  // —— 起「本机版」的 D1 兼容环境（和 server/main.mjs 一样的绑定形状）——
  const { LocalD1, ensureSchema } = await import(path.join(ROOT, 'server/d1.mjs'))
  worker = (await import(path.join(ROOT, 'backend/index.js'))).default
  const schemaSql = fs.readFileSync(path.join(ROOT, 'backend/schema.sql'), 'utf8')
  fs.mkdirSync(TMP, { recursive: true })
  db = new LocalD1(path.join(TMP, 'book1.db'))
  db2 = new LocalD1(path.join(TMP, 'book2.db'))
  await ensureSchema(db, schemaSql)
  await ensureSchema(db2, schemaSql)
  env = {
    BOOK: 1,
    APP_VERSION: 'test-cron',
    APP_BUILT: 'test-cron',
    NOTES_BASE: '',
    NOTES_SLUG: '',
    NOTES_PASS: '',
    DB: db,
    DB2: db2,
  }
  env.ENV_ALL = env
  const ctx = {
    waitUntil(p) { Promise.resolve(p).catch(() => {}) },
    passThroughOnException() {},
  }

  await seed(db, '主')
  await seed(db2, '二')
  // 把主账的备份体积撑过 500KB，好让「备份分片」那条路也走到
  await seedBulk(db)

  const beforeBad = await selfCheckBad(db)
  yes('种子数据自检干净（错账数为 0）', beforeBad === 0, beforeBad)

  // 跑之前先记下基线
  const base = {
    orders: await count(db, 'orders'),
    payables: await count(db, 'payables'),
    ledger: await count(db, 'ledger'),
    backups: await count(db, 'backups'),
    month_report: await count(db, 'month_report'),
    net_snapshots: await count(db, 'net_snapshots'),
    error_log: await count(db, 'error_log'),
  }

  const seen = {}
  for (const cron of CRONS) {
    console.log(`\n── cron "${cron}" ──`)
    const pre = {
      backups: await count(db, 'backups'),
      month_report: await count(db, 'month_report'),
      net_snapshots: await count(db, 'net_snapshots'),
      ledger: await count(db, 'ledger'),
      orders: await count(db, 'orders'),
      payables: await count(db, 'payables'),
    }
    let err = null
    try {
      await worker.scheduled({ cron, scheduledTime: Date.now() }, env, ctx)
    } catch (e) {
      err = e
    }
    if (err) {
      // 微信没配就炸 = 缺陷：记失败，再塞一份假微信配置让它走完流程
      no(`cron "${cron}" 定时任务没有抛异常`, String(err && err.message ? err.message : err))
      const msg = String(err && err.message ? err.message : err)
      if (/微信|wx/i.test(msg)) {
        for (const k of ['wx_appid', 'wx_secret', 'wx_tpl']) {
          await db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(k, 'fake-' + k).run()
          await db2.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(k, 'fake-' + k).run()
        }
        try { await worker.scheduled({ cron, scheduledTime: Date.now() }, env, ctx) } catch (e2) { no(`cron "${cron}" 塞了假微信配置后仍抛异常`, String(e2 && e2.message ? e2.message : e2)) }
      }
    } else {
      ok(`cron "${cron}" 定时任务没有抛异常`)
    }

    const after = {
      backups: await count(db, 'backups'),
      month_report: await count(db, 'month_report'),
      net_snapshots: await count(db, 'net_snapshots'),
      ledger: await count(db, 'ledger'),
      orders: await count(db, 'orders'),
      payables: await count(db, 'payables'),
    }
    seen[cron] = { pre, after }

    // 心跳 / 自检计数
    yes(`cron "${cron}" 写入了心跳 settings.cron_at`, !!(await setting(db, 'cron_at')))
    yes(`cron "${cron}" 写入了自检计数 settings.selfcheck_count`, (await setting(db, 'selfcheck_count')) !== null)
    // 备份
    yes(`cron "${cron}" 备份表 backups 有产出（累计 ${after.backups} 行）`, after.backups >= 1, after.backups)
    yes(`cron "${cron}" 备份签名 settings.backup_sig 已写入`, !!(await setting(db, 'backup_sig')))
    yes(`cron "${cron}" 备份时间 settings.backup_at 已写入`, !!(await setting(db, 'backup_at')))
    const parts = await count(db, 'backup_parts')
    const biggest = Number((await q1(db, 'SELECT COALESCE(MAX(size),0) AS s FROM backups')).s || 0)
    yes(`cron "${cron}" 备份分片 backup_parts 与内容大小匹配（分片 ${parts} 行 / 最大备份 ${biggest} 字节）`,
      parts > 0 && biggest > 500000, { parts, biggest })
    // 账没被写坏
    yes(`cron "${cron}" 订单/应付行数没有被写坏`, after.orders === pre.orders && after.payables === pre.payables, { pre: [pre.orders, pre.payables], after: [after.orders, after.payables] })
    const nowBad = await selfCheckBad(db)
    yes(`cron "${cron}" 数据自检错账数没有变差（${beforeBad} → ${nowBad}）`, nowBad <= beforeBad, { beforeBad, nowBad })
    yes(`cron "${cron}" 流水只多了自动记账那一笔（+${after.ledger - pre.ledger}）`, after.ledger - pre.ledger <= 1, after.ledger - pre.ledger)
    // 错误日志：不允许出现整块 cron 跑挂的痕迹
    const errs = await cronErrRows(db)
    const fatal = errs.filter((e) => String(e.path || '').indexOf('定时任务·') === 0 || String(e.path || '').indexOf('月度报表包') === 0 || String(e.path || '').indexOf('定时备份') === 0 || String(e.path || '').indexOf('定时清理') === 0 || String(e.path || '').indexOf('定时自检') === 0 || String(e.path || '').indexOf('月底家底存档') === 0)
    yes(`cron "${cron}" 没有 cron 级错误日志（定时任务/备份/清理/自检/报表包）`, fatal.length === 0, fatal.slice(0, 3))
    // 第 2 本账也要被跑到（多账套路径）
    yes(`cron "${cron}" 第 2 本账也跑到了（DB2 有 cron_at）`, !!(await setting(db2, 'cron_at')))
  }

  // —— 分支专项断言 ——
  console.log('\n── 分支专项 ──')
  const pm = prevMonth()

  // 0 2 1 * *：该做月度报表包
  yes('cron "0 2 1 * *" 走了月度分支：month_report 里有上一月的全套报表包',
    seen['0 2 1 * *'].after.month_report > seen['0 2 1 * *'].pre.month_report,
    seen['0 2 1 * *'])
  const mr = await q1(db, 'SELECT month, name, size FROM month_report ORDER BY id DESC LIMIT 1')
  yes('cron "0 2 1 * *" 月度报表包的月份/名字/大小正确',
    !!(mr && mr.month === pm && String(mr.name || '').indexOf('全套报表') >= 0 && Number(mr.size || 0) > 0), mr)

  // 0 1 * * 1：周报分支，不该顺手做月度报表包
  yes('cron "0 1 * * 1" 走的是周报分支：没有生成月度报表包',
    seen['0 1 * * 1'].after.month_report === seen['0 1 * * 1'].pre.month_report, seen['0 1 * * 1'])
  yes('cron "0 1 * * 1" 走的是周报分支：没有生成家底存档',
    seen['0 1 * * 1'].after.net_snapshots === seen['0 1 * * 1'].pre.net_snapshots, seen['0 1 * * 1'])

  // 0 1 * * *：每日提醒分支，不做月度家底存档
  yes('cron "0 1 * * *" 走的是每日提醒分支：没有生成家底存档',
    seen['0 1 * * *'].after.net_snapshots === seen['0 1 * * *'].pre.net_snapshots, seen['0 1 * * *'])

  // 0 16 * * *：只有 1 号才做月底家底存档
  if (bjDay().slice(8, 10) === '01') {
    yes('cron "0 16 * * *" 是 1 号：做了月底家底存档 net_snapshots',
      seen['0 16 * * *'].after.net_snapshots > seen['0 16 * * *'].pre.net_snapshots, seen['0 16 * * *'])
    const ns = await q1(db, 'SELECT month, note FROM net_snapshots ORDER BY rowid DESC LIMIT 1')
    yes('cron "0 16 * * *" 家底存档的是上一月且带备注',
      !!(ns && ns.month === pm && String(ns.note || '').indexOf('月底自动存档') >= 0), ns)
  } else {
    yes('cron "0 16 * * *" 今天不是 1 号：月底家底存档按预期跳过',
      seen['0 16 * * *'].after.net_snapshots === seen['0 16 * * *'].pre.net_snapshots, seen['0 16 * * *'])
  }

  // 微信通道没配 → 优雅跳过（没有未捕获异常，也没有把推送当成失败）
  yes('微信通道未配置时被优雅跳过（没有未捕获异常）', !bad.some((b) => /微信/.test(b)))
  const pushErr = (await cronErrRows(db)).filter((e) => /微信/.test(String(e.msg || '')))
  yes('微信未配置没有留下微信类错误日志', pushErr.length === 0, pushErr.slice(0, 3))

  // 推送笔记站（NOTES_PASS 为空）应该是「记一条错误日志」而不是抛异常
  const noteRows = (await cronErrRows(db)).filter((e) => String(e.path || '').indexOf('push-to-notes') >= 0)
  yes('笔记站未配置口令时只记日志、没让整个 cron 崩掉', noteRows.length > 0)

  // 账本体检：数据没被写坏
  yes('跑完 4 条 cron 后订单行数仍是种子时的数量', (await count(db, 'orders')) === base.orders, { base: base.orders, now: await count(db, 'orders') })
  yes('跑完 4 条 cron 后应付行数仍是种子时的数量', (await count(db, 'payables')) === base.payables)
  yes('跑完 4 条 cron 后错账数仍是 0', (await selfCheckBad(db)) === 0, await selfCheckBad(db))
  yes('跑完 4 条 cron 后流水只多了固定支出那一笔', (await count(db, 'ledger')) - base.ledger <= 1, (await count(db, 'ledger')) - base.ledger)

  // —— 把「今天」假装成 1 号，再跑一次 0 16 * * *，把月底家底存档那条路也走一遍 ——
  console.log('\n── 月底分支（把今天假装成 1 号）──')
  const bj = bjNow()
  const fakeTs = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), 1, 2) // 北京时间 1 号 10:00
  const realNow = Date.now
  const preSnap = await count(db, 'net_snapshots')
  try {
    Date.now = () => fakeTs
    await worker.scheduled({ cron: '0 16 * * *', scheduledTime: fakeTs }, env, ctx)
  } catch (e) {
    no('假装 1 号跑 "0 16 * * *" 没有抛异常', String(e && e.message ? e.message : e))
  } finally {
    Date.now = realNow
  }
  const postSnap = await count(db, 'net_snapshots')
  yes('假装 1 号跑 "0 16 * * *"：做了月底家底存档 net_snapshots', postSnap > preSnap, { preSnap, postSnap })
  const ns2 = await q1(db, 'SELECT month, note FROM net_snapshots ORDER BY rowid DESC LIMIT 1')
  yes('假装 1 号跑 "0 16 * * *"：家底存档存的是上一月且带「月底自动存档」备注',
    !!(ns2 && ns2.month === pm && String(ns2.note || '').indexOf('月底自动存档') >= 0), ns2)
  const fatal2 = (await cronErrRows(db)).filter((e) => String(e.path || '').indexOf('月底家底存档') === 0)
  yes('假装 1 号跑 "0 16 * * *"：家底存档没有报错', fatal2.length === 0, fatal2.slice(0, 3))

  // —— 兜底路径：塞一份假微信配置，再跑一遍 4 条 cron ——
  // 目的：证明「配了微信但还没取到 token」这条路也是优雅的（不抛未捕获异常、不去联网）。
  console.log('\n── 假微信配置兜底 ──')
  for (const k of ['wx_appid', 'wx_secret', 'wx_tpl']) {
    await db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(k, 'fake-' + k).run()
    await db2.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(k, 'fake-' + k).run()
  }
  await db.prepare('INSERT OR IGNORE INTO wx_users (openid, nickname, quota, created_at) VALUES (?,?,?,?)').bind('fake-openid', '假用户', 5, bjNow().toISOString()).run()
  for (const cron of CRONS) {
    let threw = null
    try {
      await worker.scheduled({ cron, scheduledTime: Date.now() }, env, ctx)
    } catch (e) { threw = e }
    yes(`配了假微信后 cron "${cron}" 仍然没有抛异常`, !threw, threw ? String(threw.message || threw) : undefined)
  }
  const wxErr = (await cronErrRows(db)).filter((e) => /微信/.test(String(e.msg || '')))
  yes('配了假微信后也没有留下微信类错误日志（取 token 失败被兜住）', wxErr.length === 0, wxErr.slice(0, 3))

  try { db.close(); db2.close() } catch (e) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (e) {}
  finish('test-cron 定时任务离线回归')
}

run().catch((e) => {
  console.error(e)
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (_) {}
  process.exit(1)
})
