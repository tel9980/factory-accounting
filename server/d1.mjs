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

// node:sqlite 只认 null / number / string / Uint8Array；D1 会自己转 true/false，
// 这里也得转，否则布尔参数直接抛「TypeError: Provided value cannot be bound」。
const bindable = (v) => {
  if (v === undefined || v === null) return null
  if (v === true) return 1
  if (v === false) return 0
  if (typeof v === 'bigint') return Number(v)
  return v
}

class D1Stmt {
  constructor(owner, sql, args) {
    this.owner = owner
    this.sql = sql
    this.args = args || []
  }

  bind(...args) {
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
    const out = []
    this.raw.exec('BEGIN')
    try {
      for (const s of list) {
        if (!s || typeof s.run !== 'function') throw new Error('batch 里只能是 db.prepare(...) 出来的语句')
        out.push(await s.run())
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
export async function ensureSchema(db, schemaSql) {
  const has = await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").first()
  const before = Number((has && has.n) || 0)
  await db.exec(schemaSql)
  const after = await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").first()
  return { before, after: Number((after && after.n) || 0) }
}
