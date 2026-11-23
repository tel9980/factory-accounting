// 本机版（免安装 exe / Docker 镜像）用的 D1 兼容层。
//
// 为什么要有这一层：backend/index.js 是照 Cloudflare Workers 写的，读库全靠 env.DB 这套
// D1 接口（prepare → bind → first/all/run、batch、exec）。Cloudflare 那边是托管的 SQLite，
// 本机这边用 Node 24 自带的 node:sqlite，行为一模一样，所以只要把这几个方法补齐，
// 同一份 index.js 就能原样在本机跑，不用维护第二套业务代码。
//
// 注意两处容易踩的差别：
//   1) D1 的 batch 是**一个事务**（要么全成要么全不成），这里也必须 BEGIN/COMMIT 包起来；
//      「整户收款」这类一次改多张单的地方靠的就是这个。
//   2) D1 的 run() 返回 { success, meta: { changes, last_row_id } }，不是 { changes }。
//      （README 迭代 285 记过：按 { changes } 写会让「库存已扣却回 409」这类假失败。）
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// node:sqlite 只认 null / number / string / Uint8Array；D1 会自己转 true/false，
// 这里也得转，否则布尔参数直接抛「TypeError: Provided value cannot be bound」。
const bindable = (v) => {
  if (v === undefined || v === null) return null
  if (v === true) return 1
  if (v === false) return 0
  if (typeof v === 'bigint') return Number(v)
  return v
}

// Cloudflare D1 的硬限制（超了线上直接报错，本机以前照单全收，于是「线上才炸」的坑永远测不出来）：
//   · 一条语句最多绑 100 个参数
//   · 一次 batch 最多 100 条语句
//   · 单条语句 SQL 最大 100KB（页面/JSON 之类的大字段靠参数走，不靠拼 SQL）
// 想临时关掉用 FACTORY_D1_STRICT=0（只在排障时用）。
const D1_MAX_PARAMS = 100
const D1_MAX_STMTS = 100
const D1_MAX_SQL = 100 * 1024
const STRICT = String(process.env.FACTORY_D1_STRICT || '1') !== '0'

class D1Stmt {
  constructor(owner, sql, args) {
    this.owner = owner
    this.sql = sql
    this.args = args || []
  }

  bind(...args) {
    if (STRICT && args.length > D1_MAX_PARAMS) {
      throw new Error(`D1_ERROR: too many SQL variables at offset 0: SQLITE_ERROR （这条语句绑了 ${args.length} 个参数，D1 上限 ${D1_MAX_PARAMS}，要分批）`)
    }
    if (STRICT && this.sql.length > D1_MAX_SQL) {
      throw new Error(`D1_ERROR: statement too large: SQLITE_ERROR （这条 SQL ${this.sql.length} 字节，D1 上限 ${D1_MAX_SQL}）`)
    }
    return new D1Stmt(this.owner, this.sql, args.map(bindable))
  }

  _prep() {
    return this.owner._prep(this.sql)
  }

  // D1: first() → 第一行对象，没行返回 null；first('col') 取单列
  async first(col) {
    const row = this._prep().get(...this.args)
    if (!row) return null
    if (col) return row[col] === undefined ? null : row[col]
    return row
  }

  // D1: all() → { results, success, meta }
  async all() {
    const results = this._prep().all(...this.args)
    return { results, success: true, meta: { changes: 0, last_row_id: 0, rows_read: results.length } }
  }

  // D1: run() → { success, meta: { changes, last_row_id } }
  async run() {
    const info = this._prep().run(...this.args)
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(info && info.changes != null ? info.changes : 0),
        last_row_id: Number(info && info.lastInsertRowid != null ? info.lastInsertRowid : 0),
        rows_written: Number(info && info.changes != null ? info.changes : 0),
      },
    }
  }
}

export class LocalD1 {
  constructor(file) {
    this.file = file
    this.raw = new DatabaseSync(file)
    // WAL：一边看报表一边记账不互相卡死；busy_timeout 兜住并发写。
    try { this.raw.prepare('PRAGMA journal_mode = WAL').get() } catch (e) { /* 内存库不支持就跳过 */ }
    try { this.raw.exec('PRAGMA busy_timeout = 5000') } catch (e) { /* 同上 */ }
    this._cache = new Map()
  }

  // 同一条 SQL 反复 prepare 很浪费（首页一次要跑几十条），这里缓存语句对象。
  // 缓存满了一次性清空，比做 LRU 简单，命中率也不差。
  _prep(sql) {
    let s = this._cache.get(sql)
    if (!s) {
      s = this.raw.prepare(sql)
      if (this._cache.size > 600) this._cache.clear()
      this._cache.set(sql, s)
    }
    return s
  }

  prepare(sql) {
    return new D1Stmt(this, sql, [])
  }

  // 事务化批量执行：D1 的 batch 就是事务语义，中途失败整批回滚。
  async batch(stmts) {
    const list = Array.isArray(stmts) ? stmts : []
    if (STRICT && list.length > D1_MAX_STMTS) {
      throw new Error(`D1_ERROR: too many statements in batch: SQLITE_ERROR （这次 ${list.length} 条，D1 上限 ${D1_MAX_STMTS}，要分批）`)
    }
    const out = []
    this.raw.exec('BEGIN')
    try {
      for (const s of list) {
        if (!s || typeof s.run !== 'function') throw new Error('batch 里只能是 db.prepare(...) 出来的语句')
        // 真 D1 的 batch 对 SELECT 也回 rows（结果是 D1Result，带 results 数组），
        // 以前这里一律走 run()，SELECT 的 rows 全被丢掉 —— 本机版「备份出来是空的」
        // 就是这条造成的（线上没事，本机看起来像坏了，最难查的那种）。
        const isRead = /^\s*(select|with|pragma|explain)\b/i.test(String(s.sql || ''))
        out.push(isRead ? await s.all() : await s.run())
      }
      this.raw.exec('COMMIT')
    } catch (e) {
      try { this.raw.exec('ROLLBACK') } catch (_) { /* 已经回滚过 */ }
      throw e
    }
    return out
  }

  // 建库脚本用这个（多语句、含 CREATE TRIGGER ... BEGIN ... END）
  async exec(sql) {
    this.raw.exec(sql)
    return { count: 0, duration: 0 }
  }

  close() {
    try { this._cache.clear(); this.raw.close() } catch (e) { /* 退出时关不掉也无所谓 */ }
  }
}

// 首次启动时把 schema.sql 整段跑一遍。schema 里全是 IF NOT EXISTS，重复执行安全，
// 所以每次启动都跑（700 行、几毫秒），老版本升级时新表新列能自己补上。
// 老库升级：schema.sql 里全是 CREATE TABLE IF NOT EXISTS，表已经在的时候整句被跳过，
// 于是「后来加的列」永远补不上 —— 表现是老库一启动就
// `Error: no such column: month`，用户以为文件坏了。
// 这里按 schema.sql 里的建表定义，把缺的列一条条 ALTER 上去（ADD COLUMN 失败就记下来，不中断启动）。
export async function completeColumns(db, schemaSql) {
  const added = []
  const failed = []
  const defs = []
  const re = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][\w]*)\s*\(([\s\S]*?)\n\);/g
  let m
  while ((m = re.exec(schemaSql))) defs.push({ table: m[1], body: m[2] })
  for (const d of defs) {
    let cols
    try { cols = (await db.prepare('PRAGMA table_info(' + d.table + ')').all()).results || [] } catch (e) { continue }
    if (!cols.length) continue
    const have = new Set(cols.map((x) => String(x.name)))
    // 切列定义要同时躲开三种「逗号/减号陷阱」，否则会切出假的列名，甚至拿
    // DEFAULT 字符串里的片段去 ALTER TABLE（踩过两次：注释里的逗号让 created_by 补不上；
    // `modules TEXT DEFAULT 'ar,ap,exp…'` 被切成了 ap / exp / import 三列，
    // 数据库里凭空多出三列，最后一块 `asset'` 还报 unrecognized token）。
    //   1. 行注释 --…（要跳过；注释里常有中文逗号，也可能有 ,）
    //   2. 单引号字符串（DEFAULT '…'）
    //   3. 括号（CHECK (x IN (0,1))）
    const parts = []
    let depth = 0
    let cur = ''
    let quote = false
    const src2 = String(d.body)
    for (let i = 0; i < src2.length; i++) {
      const ch = src2[i]
      if (quote) {
        cur += ch
        if (ch === "'") quote = false
        continue
      }
      if (ch === '-' && src2[i + 1] === '-') {
        while (i < src2.length && src2[i] !== '\n') i++
        cur += '\n'
        continue
      }
      if (ch === "'") { quote = true; cur += ch; continue }
      if (ch === '(') depth++
      if (ch === ')') depth--
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue }
      cur += ch
    }
    if (cur.trim()) parts.push(cur)
    for (const raw of parts) {
      const line = raw.trim().replace(/\s+/g, ' ')
      if (!line) continue
      const nm = (line.match(/^([A-Za-z_][\w]*)/) || [])[1]
      if (!nm) continue
      const low = line.toLowerCase()
      if (low.startsWith('primary ') || low.startsWith('unique') || low.startsWith('foreign') || low.startsWith('check') || low.startsWith('constraint')) continue
      if (have.has(nm)) continue
      try {
        await db.prepare('ALTER TABLE ' + d.table + ' ADD COLUMN ' + line).run()
        added.push(d.table + '.' + nm)
      } catch (e) {
        // NOT NULL 又没有默认值的列 SQLite 加不上（ALTER 的限制），记下来让启动日志提示
        failed.push(d.table + '.' + nm + ': ' + String((e && e.message) || e))
      }
    }
  }
  return { added, failed }
}

// 迁移文件（backend/migrations/*.sql）—— 本机版启动时按文件名顺序跑。
// 为什么要跑：线上是 D1，靠 deploy.yml 的「跑远程数据库迁移」步骤执行 migrations/*.sql；
// 本机版没有那个步骤，schema.sql 全是 CREATE TABLE IF NOT EXISTS，
// 老库缺列/缺索引就只能靠代码里的 EXTRA_COLS 兜底 —— 索引补不上。
// 幂等性：每条语句单独跑，「列已存在 / 已存在」当成功跳过，其余错误抛出去（不吞）。
const MIG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'backend', 'migrations')

function listMigrationFiles(dir) {
  try {
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  } catch (e) { return [] }
}

// 第 13 轮 E2：打成单文件 exe（Node SEA）以后，程序里没有 backend/migrations 目录，
// 于是 exe 上永远不跑迁移 —— 0001 建的那几个索引（idx_ledger_ref_dir / idx_orders_paid /
// idx_payables_paid）在 exe 上永久缺失，大账本越用越慢，而且没人看得出来。
// 现在打包时把迁移文件作为资源塞进二进制（migrations.json），这里读不到目录就退回读资源。
function seaAssetText(name) {
  try {
    // 打包成 CJS 时有 require；直接跑 ESM 时没有 require，就当作不是 SEA
    // eslint-disable-next-line no-undef
    const req = typeof require === 'function' ? require : null
    if (!req) return ''
    const sea = req('node:sea')
    if (!sea || !sea.isSea || !sea.isSea() || !sea.getAsset) return ''
    const buf = sea.getAsset(name)
    return buf && buf.length ? Buffer.from(buf).toString('utf8') : ''
  } catch (e) { return '' }
}

// 迁移清单：优先磁盘目录，读不到就用打包进二进制的资源
function migrationList(dir) {
  const files = listMigrationFiles(dir)
  if (files.length) return files.map((f) => ({ name: f, sql: () => fs.readFileSync(path.join(dir, f), 'utf8') }))
  const raw = seaAssetText('migrations.json')
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return (Array.isArray(arr) ? arr : []).map((x) => ({ name: String(x.name || ''), sql: () => String(x.sql || '') }))
  } catch (e) { return [] }
}

// 把迁移文件拆成一条条语句（去掉整行 -- 注释，按 ';' 切）
function splitMigrationStatements(sql) {
  const clean = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
  return clean.split(';').map((s) => s.trim()).filter(Boolean)
}

export async function applyMigrations(db, dir = MIG_DIR) {
  const files = migrationList(dir)
  const applied = []
  const skipped = []
  const failed = []
  for (const m of files) {
    const f = m.name
    let sql = ''
    try { sql = m.sql() } catch (e) { failed.push(f + ': ' + String(e.message || e)); continue }
    for (const stmt of splitMigrationStatements(sql)) {
      try {
        await db.exec(stmt)
        applied.push(f)
      } catch (e) {
        const msg = String((e && e.message) || e)
        // 幂等：列/表/索引已存在 → 跳过；其余错误记下来（不吞，交由调用方打印）
        if (/duplicate column name/i.test(msg) || /already exists/i.test(msg)) { skipped.push(f); continue }
        failed.push(f + ': ' + msg)
      }
    }
  }
  return { files: files.length, applied, skipped, failed }
}

export async function ensureSchema(db, schemaSql) {
  const CNT = "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  const has = await db.prepare(CNT).first()
  const before = Number((has && has.n) || 0)
  let firstErr = null
  try {
    await db.exec(schemaSql)
  } catch (e) {
    // 老库上可能因为「索引建在新列上、而那个列还没加」直接抛错。
    // 先补列，再整段重跑一次；第二次还失败才算真问题。
    firstErr = e
  }
  const cols = await completeColumns(db, schemaSql)
  if (firstErr) {
    try { await db.exec(schemaSql) } catch (e) { throw e }
  }
  // 迁移文件（backend/migrations/*.sql）：线上由 deploy.yml 跑，本机版由这里跑。
  // 放在 schema.sql 之后、补列之后：这样 0000 补的列和 0001 建的索引都能落上。
  const mig = await applyMigrations(db)
  const after = await db.prepare(CNT).first()
  return {
    before,
    after: Number((after && after.n) || 0),
    added: cols.added,
    failed: [...cols.failed, ...(mig.failed || [])],
    migrations: { files: mig.files, applied: mig.applied.length, skipped: mig.skipped.length, failed: mig.failed },
  }
}
