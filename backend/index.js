import { Hono } from 'hono'

const app = new Hono()

app.use('*', async (c, next) => {
  failBucket.length = 0
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  c.header('Access-Control-Allow-Headers', 'Content-Type,X-Access-Key,X-Book')
  await next()
})
app.options('*', (c) => c.text('', 204))

// 出错留痕：线上报 500 时把路径/错误写进 error_log，报表页「数据体检」里能查到（不然用户只看到「加载失败」）
async function logError(c, status, msg, ms) {
  try {
    const db = c.env && c.env.DB
    if (!db) return
    const u = new URL(c.req.url)
    await db.prepare('INSERT INTO error_log (book,method,path,status,msg,ms,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(num(c.env.BOOK || 1), c.req.method, u.pathname, status, String(msg || '').slice(0, 300), ms, now()).run()
  } catch (e) { /* 留痕失败不影响主流程 */ }
}
app.use('*', async (c, next) => {
  const t0 = Date.now()
  try {
    await next()
  } catch (e) {
    await logError(c, 500, (e && (e.stack || e.message)) || e, Date.now() - t0)
    // 不往外抛：抛出去 Cloudflare 只会回一句空白「Internal Server Error」，手机上看起来像卡死
    return c.json({ ok: false, code: 'server_error', error: '服务器出了点问题，已经记下来了（设置 → 数据体检 → 🐞 运行日志）' }, 500)
  }
  const st = c.res ? c.res.status : 200
  // 500 时把「哪条统计失败了」一起记下来（noteFail 收集的），不然日志里只剩一个 500 没有原因
  if (st >= 500) await logError(c, st, failBucket.join(' | '), Date.now() - t0)
})

// 兜底：真正的 500 也要把错误原文记下来，并给前端一句人话（不然只看到「加载失败」）
app.onError(async (err, c) => {
  const t0 = Date.now()
  try { await logError(c, 500, (err && (err.stack || err.message)) || err, Date.now() - t0) } catch (e) {}
  return c.json({ ok: false, code: 'server_error', error: '服务器出了点问题，已经记下来了（设置 → 数据体检 → 🐞 运行日志）' }, 500)
})

// 全站统一北京时间（UTC+8）：created_at / due_date 存的一律是「北京日期时间串」。
// 以前用 UTC，北京时间 00:00–08:00 记的账会显示成前一天，「今天收到」「逾期天数」也都会差一天。
const TZ_MS = 8 * 3600 * 1000
const now = () => new Date(Date.now() + TZ_MS).toISOString()
const todayIso = () => now().slice(0, 10)
const month = () => now().slice(0, 7)
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const round2 = (x) => Math.round(x * 100) / 100

// ===== 统一口径（全站同一个"赚了多少"，避免不同页面数字打架）=====
// 净利（权责）= 本月接单额 − 本月单子上的材料·外协成本 − 本月现金费用（支出 + 固定支出）− 摊销 − 折旧 − 预提利息
// 赊购（应付）只影响欠款和现金流，不重复算成本；付给供应商的钱若已算在单子成本里也不再算一次。
// 静默失败的“留痕”：并发查询里 try/catch 不能把错误吃掉，否则界面上只是数字变成 0
const failBucket = []
function noteFail(e, tag) {
  try {
    const msg = String((e && (e.message || e.error)) || e || 'unknown').slice(0, 200)
    const t = tag ? `${tag}: ${msg}` : msg
    if (failBucket.indexOf(t) < 0 && failBucket.length < 20) failBucket.push(t)
  } catch (_) {}
}
// 断网补发去重：手机端把没发出去的记账先存本地，联网后重发；同一个 client_id 只入账一次
async function opSeen(db, cid) {
  if (!cid) return null
  try { return await db.prepare('SELECT * FROM op_dedupe WHERE client_id=?').bind(cid).first() } catch (e) { return null }
}
async function opMark(db, cid, kind, refId) {
  if (!cid) return
  try { await db.prepare('INSERT OR IGNORE INTO op_dedupe (client_id, kind, ref_id, created_at) VALUES (?,?,?,?)').bind(cid, kind, num(refId), now()).run() } catch (e) {}
}
const CASH_EXP_WHERE = "direction='out' AND cash=1 AND ref_type IN ('expense','fixed')"
// 首页提速的前置：orders/ledger/payables 各补一个 month 列（=substr(created_at,1,7)），
// 配触发器自动填新行 + 索引，让首页的 12 条子查询从「全表扫 substr」变成走索引。
// 幂等：列和触发器都在时只剩几条 PRAGMA，几毫秒。
// 员工账号：一人一个口令，各自授权限（老的整体员工口令继续可用）
async function ensureStaffTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS staff_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    pin TEXT NOT NULL UNIQUE,
    modules TEXT NOT NULL DEFAULT 'ar,ap,exp,import,contact,asset',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  )`).run()
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_staff_pin ON staff_users(pin)').run()
}

async function ensureMonthCols(db) {
  for (const t of ['orders', 'ledger', 'payables']) {
    let has = false
    try {
      const cols = (await db.prepare('PRAGMA table_info(' + t + ')').all()).results || []
      has = cols.some((x) => x.name === 'month')
      if (!has) await db.prepare('ALTER TABLE ' + t + ' ADD COLUMN month TEXT').run()
    } catch (e) { continue }
    try { await db.prepare('CREATE INDEX IF NOT EXISTS idx_' + t + '_month ON ' + t + '(month)').run() } catch (e) {}
    try {
      await db.prepare("CREATE TRIGGER IF NOT EXISTS trg_" + t + "_month AFTER INSERT ON " + t + " WHEN NEW.month IS NULL BEGIN UPDATE " + t + " SET month=substr(NEW.created_at,1,7) WHERE id=NEW.id; END").run()
    } catch (e) {}
    try { await db.prepare("UPDATE " + t + " SET month=substr(created_at,1,7) WHERE month IS NULL AND created_at IS NOT NULL").run() } catch (e) {}
  }
}

async function monthPL(db, mm) {
  const sql = `SELECT
    (SELECT COALESCE(SUM(price),0) FROM orders WHERE month=?) AS income,
    (SELECT COALESCE(SUM(COALESCE(cost,0)),0) FROM orders WHERE month=?) AS mat,
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE ${CASH_EXP_WHERE} AND month=?) AS cash_exp,
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE ref_type='amort' AND month=?) AS amort,
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE ref_type='dep' AND month=?) AS dep,
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE ref_type='debt_int' AND month=?) AS accrue,
    (SELECT COALESCE(SUM(amount),0) FROM payables WHERE month=?) AS payable_add,
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE direction='out' AND cash=1 AND ref_type='payable' AND substr(created_at,1,7)=?) AS paid_payable`
  const r = ((await db.prepare(sql).bind(mm, mm, mm, mm, mm, mm, mm, mm).first()) || {})
  const income = round2(num(r.income)), mat = round2(num(r.mat)), cashExp = round2(num(r.cash_exp))
  const amort = round2(num(r.amort)), dep = round2(num(r.dep)), accrue = round2(num(r.accrue))
  const adj = round2(amort + dep + accrue)
  const cost = round2(mat + cashExp + adj)
  return {
    month: mm, income, mat, cash_exp: cashExp, amort, dep, accrue, adj, cost,
    profit: round2(income - cost), margin: income > 0 ? round2(((income - cost) / income) * 100) : 0,
    payable_add: round2(num(r.payable_add)), paid_payable: round2(num(r.paid_payable))
  }
}
// 单位名归一：去掉括号备注、有限公司/公司/厂/店与空白，用来跨表匹配同一家
const norm = (t) => String(t || '').replace(/[（(].*?[)）]|有限公司|公司|厂|店|\s/g, '')
const isMonthLocked = async (db, m) => {
  if (!m) return false
  const r = await db.prepare('SELECT 1 FROM month_lock WHERE month=?').bind(m).first()
  return !!r
}
const uid = () => {
  try { return globalThis.crypto.randomUUID() } catch { return Date.now().toString(36) + Math.random().toString(36).slice(2) }
}
const intoTrash = async (db, type, refId, obj, batch) => {
  await db.prepare('INSERT INTO trash (type, ref_id, data, batch, deleted_at) VALUES (?,?,?,?,?)')
    .bind(type, refId, JSON.stringify(obj), batch, now()).run()
}
const logAudit = async (db, action, target, detail, ref, by) => {
  try {
    const [rt, rid] = String(ref || '').split(':')
    await db.prepare('INSERT INTO audit_log (action, target, detail, ref_type, ref_id, by, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(action, target, detail || '', rt || null, rid || null, by || null, now()).run()
  } catch (e) {
    console.error('audit log failed', e)
  }
}
// 谁动的手：员工口令操作记为「员工」，老板口令或未登录记为「老板」
const act = (c) => {
  try { const nm0 = c && c.get && c.get('staff_name'); if (nm0) return '员工·' + String(nm0).replace(/[\r\n]/g, '').slice(0, 12) } catch (e) {}
  if (!(c && c.get && c.get('role') === 'staff')) return '老板'
  const rawName = String((c.req && c.req.header && c.req.header('x-staff-name')) || '').trim()
  let nm = rawName
  // 头里只能放 ASCII，前端用 encodeURIComponent 传中文名字
  try { nm = decodeURIComponent(rawName) } catch (e) { nm = rawName }
  nm = nm.replace(/[\r\n]/g, '').slice(0, 12)
  return nm ? '员工·' + nm : '员工'
}
// 员工能开哪些模块：老板在「设置 → 员工权限」里勾
const STAFF_MOD_LABEL = { ar: '应收（开单、收款）', ap: '应付（进货、付款）', exp: '支出与流水', import: '批量导入', contact: '单位与对账', asset: '家底（账户、设备、发票）' }
const STAFF_MOD_DEFAULT = ['ar', 'ap', 'exp', 'import', 'contact', 'asset']
const STAFF_MOD_RULES = [
  ['ar', /^\/(orders|ar|ar-summary|history|settled|writeoffs|edit-request)/],
  ['ap', /^\/(payables|ap|ap-summary)/],
  ['exp', /^\/(expenses|ledger|fixed|run-fixed|advances|prepaids)/],
  ['import', /^\/(import|bank-|migrate-)/],
  ['contact', /^\/(contacts|party-groups|party-items|party-terms|party-balance|party-dups|party-merge|statement|recon-|dunning|collect-list|reminders|due-schedule|aging|track)/],
  ['asset', /^\/(accounts|networth|assets|invoices|funding|loans|debts|credit-limits|transfers)/]
]
function staffModOf(path) { for (const [k, re] of STAFF_MOD_RULES) if (re.test(path)) return k; return '' }
async function getStaffModules(db) {
  const r = await db.prepare("SELECT value FROM settings WHERE key='staff_modules'").first().catch(() => null)
  const v = String((r && r.value) || '')
  if (!v) return STAFF_MOD_DEFAULT.slice()
  return v.split(',').map((x) => x.trim()).filter((x) => STAFF_MOD_LABEL[x])
}
// 把「改了什么」拼成人话：金额 3000→3200；客户 张三→李四
const diffText = (pairs) => pairs
  .filter(([, a, b]) => String(a == null ? '' : a) !== String(b == null ? '' : b))
  .map(([k, a, b]) => `${k} ${a || '空'} → ${b || '空'}`).join('；')

const getKey = async (db) => {
  const r = await db.prepare("SELECT value FROM settings WHERE key='access_key'").first()
  return r ? String(r.value) : ''
}

// 访问口令：首次设置 / 修改 / 校验
app.post('/auth/setup', async (c) => {
  const { key } = await c.req.json()
  const k = String(key || '').trim()
  if (k.length < 4) return c.json({ error: '口令至少 4 位' }, 400)
  const db = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const existing = await getKey(db)
  if (existing) return c.json({ error: '口令已存在，请用修改功能' }, 400)
  await db.prepare("INSERT INTO settings (key, value) VALUES ('access_key', ?)").bind(k).run()
  // 顺手给一个恢复码：忘了口令时能自救（只显示这一次）
  let code = ''
  try { code = await saveRecoverCode(db) } catch (e) { /* 忽略 */ }
  return c.json({ ok: true, recover_code: code })
})

app.post('/auth/change', async (c) => {
  const { old_key, new_key } = await c.req.json()
  const db = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(db)
  if (!saved) return c.json({ error: '尚未设置口令' }, 400)
  if (String(old_key || '') !== saved) return c.json({ error: '旧口令不对' }, 403)
  const nk = String(new_key || '').trim()
  if (nk.length < 4) return c.json({ error: '新口令至少 4 位' }, 400)
  await db.prepare("UPDATE settings SET value=? WHERE key='access_key'").bind(nk).run()
  return c.json({ ok: true })
})


// ==================== 找回口令（恢复码）====================
// 口令丢了就进不去，数据还在云端也打不开 —— 所以设口令时给一串「恢复码」，抄在纸上放着。
// 恢复码只存哈希，不存明文；试错太多次会临时锁住。
const REC_ALPHA = 'ACDEFGHJKLMNPQRTUVWXY34679'
const genRecoverCode = () => {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  const t = [...b].map((x) => REC_ALPHA[x % REC_ALPHA.length]).join('')
  return t.slice(0, 4) + '-' + t.slice(4, 8) + '-' + t.slice(8, 12) + '-' + t.slice(12, 16)
}
const normCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const hashCode = async (v) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('rc|' + normCode(v)))
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('')
}
const setSettingRaw = async (db, k, v) => {
  const r = await db.prepare('SELECT value FROM settings WHERE key=?').bind(k).first()
  if (r) await db.prepare('UPDATE settings SET value=? WHERE key=?').bind(String(v), k).run()
  else await db.prepare('INSERT INTO settings (key, value) VALUES (?,?)').bind(k, String(v)).run()
}
const delSettingRaw = async (db, k) => { await db.prepare('DELETE FROM settings WHERE key=?').bind(k).run().catch(() => {}) }
const saveRecoverCode = async (db) => {
  const code = genRecoverCode()
  await setSettingRaw(db, 'recover_hash', await hashCode(code))
  await setSettingRaw(db, 'recover_at', now())
  await delSettingRaw(db, 'recover_fail')
  await delSettingRaw(db, 'recover_lock')
  return code
}

app.get('/auth/recover-info', async (c) => {
  const db = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const h = await db.prepare("SELECT value FROM settings WHERE key='recover_hash'").first().catch(() => null)
  const a = await db.prepare("SELECT value FROM settings WHERE key='recover_at'").first().catch(() => null)
  const enabled = !!(h && h.value)
  return c.json({
    ok: true,
    enabled,
    at: (a && a.value) || '',
    text: enabled
      ? '已经设过恢复码（' + String((a && a.value) || '').slice(0, 10) + '）。万一忘了口令，用它就能重设。'
      : '还没有恢复码。现在设一个，抄在纸上放进抽屉 —— 忘了口令时只有它能救。',
    tips: [
      '恢复码只显示一次，我们也不存明文，忘了就只能重设一个新的',
      '重设恢复码后，旧的那张纸就没用了',
      '恢复码和口令别放在同一个地方',
    ],
  })
})

app.post('/auth/recover-code', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const db = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(db)
  if (!saved) return c.json({ error: '尚未设置口令', code: 'no_key' }, 400)
  if (String(body.key || '') !== saved) return c.json({ error: '老板口令不对', code: 'bad_key' }, 403)
  const code = await saveRecoverCode(db)
  await logAudit(db, '重设恢复码', '口令', '生成了新的恢复码')
  return c.json({ ok: true, code })
})

// 用恢复码重设口令（不需要旧口令；试错太多临时锁 10 分钟）
app.post('/auth/recover', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const db = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(db)
  if (!saved) return c.json({ error: '这本账还没设口令，直接设一个就行', code: 'no_key' }, 400)
  const hRow = await db.prepare("SELECT value FROM settings WHERE key='recover_hash'").first().catch(() => null)
  if (!hRow || !hRow.value) return c.json({ error: '这本账还没设过恢复码，只能用原口令进', code: 'no_recover' }, 400)
  const lockRow = await db.prepare("SELECT value FROM settings WHERE key='recover_lock'").first().catch(() => null)
  if (lockRow && lockRow.value) {
    const left = 10 * 60 * 1000 - (Date.now() - new Date(lockRow.value).getTime())
    if (left > 0) return c.json({ error: `试错太多次了，${Math.ceil(left / 60000)} 分钟后再试`, code: 'too_many' }, 429)
  }
  const code = String(body.code || '').trim()
  const pw = String(body.password || '').trim()
  if (normCode(code).length < 8) return c.json({ error: '恢复码是 16 位，像 ABCD-EFGH-JKLM-NPQR 这样', code: 'bad_code' }, 400)
  const want = await hashCode(code)
  if (want !== String(hRow.value)) {
    const fRow = await db.prepare("SELECT value FROM settings WHERE key='recover_fail'").first().catch(() => null)
    const n = num(fRow && fRow.value) + 1
    await setSettingRaw(db, 'recover_fail', n)
    if (n >= 8) {
      await setSettingRaw(db, 'recover_lock', new Date(Date.now() + 10 * 60 * 1000).toISOString())
      await delSettingRaw(db, 'recover_fail')
      return c.json({ error: '恢复码错了 8 次，先锁 10 分钟（防止别人乱试）', code: 'too_many' }, 429)
    }
    return c.json({ error: `恢复码不对（还能试 ${8 - n} 次）`, code: 'bad_code', left: 8 - n }, 403)
  }
  if (pw.length < 4) return c.json({ error: '新口令至少 4 位', code: 'bad_password' }, 400)
  await setSettingRaw(db, 'access_key', pw)
  await delSettingRaw(db, 'recover_fail')
  await delSettingRaw(db, 'recover_lock')
  await logAudit(db, '用恢复码重设口令', '口令', '恢复码验证通过，口令已重设').catch(() => {})
  return c.json({ ok: true, key: pw })
})

const getStaffKey = async (db) => {
  try {
    const r = await db.prepare("SELECT value FROM settings WHERE key='staff_key'").first()
    return r ? String(r.value) : ''
  } catch (e) { return '' }
}

// 员工口令（老板设一个给员工用，权限受限：能记账收款，看不到毛利、不能删改单）
app.post('/auth/staff', async (c) => {
  const { key, password } = await c.req.json()
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  if (!saved) return c.json({ error: '尚未设置老板口令' }, 400)
  if (String(key || '') !== saved) return c.json({ error: '只有老板口令能设员工口令' }, 403)
  const pw = String(password || '').trim()
  if (pw && pw.length < 4) return c.json({ error: '员工口令至少 4 位' }, 400)
  if (pw && pw === saved) return c.json({ error: '员工口令不能和老板口令一样' }, 400)
  const old = await mainDb.prepare("SELECT value FROM settings WHERE key='staff_key'").first()
  if (old) await mainDb.prepare("UPDATE settings SET value=? WHERE key='staff_key'").bind(pw).run()
  else await mainDb.prepare("INSERT INTO settings (key, value) VALUES ('staff_key', ?)").bind(pw).run()
  return c.json({ ok: true, enabled: !!pw })
})

// 一键停用员工口令（离职/换人时立刻止损，不用先「改成空」）
app.post('/auth/staff-off', async (c) => {
  const b = await c.req.json().catch(() => ({}))
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  if (!saved) return c.json({ error: '尚未设置老板口令' }, 400)
  if (String(b.key || '') !== saved) return c.json({ error: '只有老板口令能停用员工口令' }, 403)
  const old = await mainDb.prepare("SELECT value FROM settings WHERE key='staff_key'").first()
  if (!old || !old.value) return c.json({ ok: true, enabled: false, note: '本来就没开员工口令' })
  await mainDb.prepare("DELETE FROM settings WHERE key='staff_key'").run()
  await logAudit(mainDb, '停用员工口令', '员工口令', (b.note || '离职/换人'), '', '老板')
  return c.json({ ok: true, enabled: false, note: '已停用：他手机上那个口令现在进不去了' })
})

// 按账户对账：今天/这个月，钱到底进了哪个口袋，有没有对不上
app.get('/account-recon', async (c) => {
  const db = c.env.DB
  const today = now().slice(0, 10)
  const curM = today.slice(0, 7)
  const mode = String(c.req.query('mode') || 'day') === 'month' ? 'month' : 'day'
  let date = String(c.req.query('date') || today).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = today
  let month = String(c.req.query('month') || curM).slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(month)) month = curM
  const from = mode === 'day' ? date : month + '-01'
  const to = mode === 'day' ? date : month + '-31'
  const label = mode === 'day' ? date : month
  const range = "substr(created_at,1,10)>=? AND substr(created_at,1,10)<=? AND cash=1"
  const [accR, byAcc, noAcc, paidR, flowR, allIn] = await Promise.all([
    db.prepare('SELECT id, name, kind, COALESCE(opening,0) AS opening FROM accounts ORDER BY id').all().catch(() => ({ results: [] })),
    db.prepare(`SELECT COALESCE(account_id,0) AS aid, direction, COALESCE(SUM(amount),0) AS s, COUNT(*) AS n FROM ledger WHERE ${range} GROUP BY COALESCE(account_id,0), direction`).bind(from, to).all().catch(() => ({ results: [] })),
    db.prepare(`SELECT direction, COALESCE(SUM(amount),0) AS s, COUNT(*) AS n FROM ledger WHERE ${range} AND (account_id IS NULL OR account_id=0) GROUP BY direction`).bind(from, to).all().catch(() => ({ results: [] })),
    db.prepare(`SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS n FROM ledger WHERE ${range} AND direction='in' AND ref_type IN ('order','batch')`).bind(from, to).first().catch(() => null),
    db.prepare(`SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS n FROM ledger WHERE ${range} AND direction='in'`).bind(from, to).first().catch(() => null),
    db.prepare(`SELECT COALESCE(account_id,0) AS aid, direction, COALESCE(SUM(amount),0) AS s FROM ledger WHERE cash=1 GROUP BY COALESCE(account_id,0), direction`).all().catch(() => ({ results: [] })),
  ])
  const accs = accR.results || []
  const firstId = accs.length ? num(accs[0].id) : 0
  const m = {}
  const put = (aid, dir, s, n) => {
    m[aid] = m[aid] || { in: 0, out: 0, in_n: 0, out_n: 0 }
    if (dir === 'in') { m[aid].in = round2(m[aid].in + num(s)); m[aid].in_n += num(n) } else { m[aid].out = round2(m[aid].out + num(s)); m[aid].out_n += num(n) }
  }
  (byAcc.results || []).forEach((r) => put(num(r.aid), r.direction, r.s, r.n))
  const allMap = {}
  ;(allIn.results || []).forEach((r) => {
    const aid = num(r.aid) || firstId
    allMap[aid] = allMap[aid] || 0
    allMap[aid] += (r.direction === 'in' ? num(r.s) : -num(r.s))
  })
  const rows = accs.map((a) => {
    const k = num(a.id)
    const mm = m[k] || { in: 0, out: 0, in_n: 0, out_n: 0 }
    return {
      id: k, name: a.name, kind: a.kind || '',
      income: round2(mm.in), outcome: round2(mm.out), net: round2(mm.in - mm.out),
      in_n: mm.in_n, out_n: mm.out_n,
      balance: round2(num(a.opening) + (allMap[k] || 0)),
    }
  })
  const noIn = round2(((noAcc.results || []).find((r) => r.direction === 'in') || {}).s || 0)
  const noOut = round2(((noAcc.results || []).find((r) => r.direction === 'out') || {}).s || 0)
  const noN = (noAcc.results || []).reduce((a, r) => a + num(r.n), 0)
  const totalIn = round2(rows.reduce((a, r) => a + r.income, 0) + noIn)
  const totalOut = round2(rows.reduce((a, r) => a + r.outcome, 0) + noOut)
  const issues = []
  if (noN > 0) issues.push({ tone: 'warn', text: `有 ${noN} 笔流水没记是哪个账户（收 ¥${noIn}／付 ¥${noOut}）。账户余额里先算进了「${(accs[0] && accs[0].name) || '第一个账户'}」，最好补一下（流水 → 改）` })
  rows.forEach((r) => { if (r.balance < 0) issues.push({ tone: 'bad', text: `${r.name} 现在是 −¥${Math.abs(r.balance)}：这个账户记的钱比实际多，去流水里核对几笔` }) })
  const paidS = round2(num(paidR && paidR.s))
  const flowS = round2(num(flowR && flowR.s))
  const gap = round2(flowS - paidS)
  if (Math.abs(gap) >= 0.01) issues.push({ tone: 'warn', text: `收款流水共 ¥${flowS}，其中挂单据的 ¥${paidS}，另外 ¥${gap} 是预收款/借款这类没有对应单据的（正常），如果多出来的记不清是啥，去流水里看一眼` })
  const text = (mode === 'day' ? `${date} 收付` : `${month} 收付`) + '：收 ¥' + totalIn + '（' + rows.reduce((a, r) => a + r.in_n, 0) + ' 笔）、付 ¥' + totalOut + '\n' +
    (rows.length ? rows.map((r) => `${r.name}：收 ${r.income}／付 ${r.outcome}，余额 ${r.balance}`).join('\n') : '还没有资金账户') +
    (issues.length ? '\n要注意：\n' + issues.map((i) => '· ' + i.text).join('\n') : '\n各账户都对得上 ✓')
  return c.json({ ok: true, mode, label, from, to, rows, no_acc: { in: noIn, out: noOut, n: noN }, total_in: totalIn, total_out: totalOut, total_net: round2(totalIn - totalOut), paid_doc: paidS, paid_flow: flowS, issues, text })
})

// 「换手机 / 停用员工」向导 + 离职交接自查
app.get('/access-guide', async (c) => {
  const db = c.env.DB
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const g = (sql) => db.prepare(sql).first().catch(() => null)
  const [staff, recInfo, bkName, lastBak, staffAct, noDue, openAr, openAp] = await Promise.all([
    getStaffKey(mainDb).catch(() => ''),
    mainDb.prepare("SELECT value FROM settings WHERE key='recover_hash'").first().catch(() => null),
    g("SELECT value FROM settings WHERE key='book_name'"),
    g("SELECT MAX(created_at) t FROM backups"),
    g("SELECT COUNT(*) n FROM audit_log WHERE by LIKE '员工%'"),
    g("SELECT COUNT(*) n FROM orders WHERE (due_date IS NULL OR due_date='') AND price > paid + COALESCE(written_off,0)"),
    g("SELECT COUNT(*) n, COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) amt FROM orders WHERE price > paid + COALESCE(written_off,0)"),
    g("SELECT COUNT(*) n, COALESCE(SUM(amount-paid-COALESCE(written_off,0)),0) amt FROM payables WHERE amount > paid + COALESCE(written_off,0)"),
  ])
  const staffOn = !!(staff && String(staff).length >= 4)
  const recOn = !!(recInfo && recInfo.value)
  const bakDays = lastBak && lastBak.t ? Math.max(0, daysSince(lastBak.t)) : null
  const topics = [
    { k: 'newphone', title: '我换手机了', icon: '📱', steps: [
      '新手机装微信开发者工具，或用「小司记账」小程序的体验版二维码/正式版打开（不用重新装什么）',
      '登录时输老板口令（就是这台手机上原来那个）；口令不知道了就用恢复码重设（设置 → 🔑 找回口令）',
      '数据在云上，自动就在：不用导出、不用导入、不用扫码迁移',
      '第一件事：打开首页看一眼「手头现金」和「客户欠我」对不对，再点「设置 → 备份到笔记站」留一份',
      recOn ? '恢复码已经设过了（' + (recInfo.value ? '有' : '无') + '），纸上的那张还能用' : '还没设恢复码——现在就在设置里生成一个，抄纸上',
      '手里这台旧手机不用注销；想让它失效，就在旧手机上清掉小程序缓存（发现 → 长按删除 → 重新进入要口令）',
    ] },
    { k: 'staff', title: '我要给员工用 / 停用员工', icon: '👷', steps: [
      staffOn ? '员工口令已开启：告诉员工这个口令，他只能记账、收款、看自己的单，看不到利润、不能删改单' : '还没开员工口令：设置里「设员工口令」，给他 4 位以上、别和老板口令一样',
      '员工记的每一笔都带「员工」标记，老板在设置页「看看员工最近记了什么」能查（近 7 天）',
      '员工要改单只能「申请改」，老板在小程序里点同意/驳回，改了会留痕',
      '离职或换人：点下面「一键停用员工口令」，他手机上那个口令立刻进不去',
      staffAct && num(staffAct.n) > 0 ? '离职前建议先看一眼他记的 ' + num(staffAct.n) + ' 笔操作，核对有没有错单' : '暂时没有员工记过的记录',
    ] },
    { k: 'leave', title: '员工离职交接（照着做不会漏）', icon: '🧾', steps: [
      '① 一键停用他的口令（下面按钮），别等「以后再说」',
      '② 看他最近记了什么，把可疑的核对一遍（设置 → 查看员工最近记了什么）',
      num(noDue && noDue.n) > 0 ? '③ 有 ' + num(noDue.n) + ' 张单没写到期日：点「单位 → 账期」补上，不然不会提醒你收钱' : '③ 单据到期日都齐了（没有漏填的）',
      '④ 如果他见过老板口令：改一次老板口令（设置 → 改口令），并把恢复码重设（旧纸作废）',
      '⑤ 应交待：未收 ' + round2(num(openAr && openAr.amt)) + ' 元（' + num(openAr && openAr.n) + ' 单）、应付 ' + round2(num(openAp && openAp.amt)) + ' 元（' + num(openAp && openAp.n) + ' 单）；点「账本交接包」把现状打成一张纸',
      '⑥ 最后备份一次并结掉这个月的账（报表 → 月底收尾）',
    ] },
  ]
  const tips = []
  if (!recOn) tips.push('没设恢复码：口令忘了就进不来了，现在去设')
  if (staffOn) tips.push('员工口令开着：人不干了记得一键停用')
  if (bakDays === null) tips.push('还没做过备份：设置 → 备份一次')
  else if (bakDays > 7) tips.push('上次备份是 ' + bakDays + ' 天前，建议现在备份一次')
  return c.json({ ok: true, staff_enabled: staffOn, recover_set: recOn, book_name: (bkName && bkName.value) || '账本1', backup_days: bakDays, topics, tips, text: tips.length ? tips.join('\n') : '口令、恢复码、备份都齐了，换手机或换人都照向导做就行。' })
})

// 打印链接签名（不暴露访问口令）
const sigOf = async (key, party, type) => {
  const data = new TextEncoder().encode(String(key) + '|' + String(party) + '|' + String(type))
  const buf = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 20)
}

// 生成 A4 打印版对账单链接（小程序里点「打印版」调用）
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname
  // 打印页在浏览器里打开（没有请求头），放行并由页面自己校验 ?k=
  if (path === '/' || path.startsWith('/auth/') || path === '/statement-print' || path === '/report-print' || path === '/track' || path === '/handover-print' || path === '/recon-print' || path === '/year-print' || path === '/year-close-print' || path === '/year-open-print' || path === '/statement-ack' || path === '/health-print' || path === '/year-review-print' || path === '/quote-print' || path === '/quote-ack' || path === '/order-print' || path === '/payroll-print') return next()
  // 口令只存主账套，所有账套共用一个口令
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  if (!saved) return c.json({ error: '首次使用请设置访问口令', code: 'no_key' }, 401)
  const given = String(c.req.header('x-access-key') || '')
  let role = ''
  let staffMods = null
  if (given && given === saved) role = 'owner'
  else if (given) {
    // 一人一个口令：认到人就按这个人的名字和权限走
    let su = null
    try { su = await mainDb.prepare('SELECT * FROM staff_users WHERE pin=? AND active=1').bind(given).first() } catch (e) { su = null }
    if (su) {
      role = 'staff'
      c.set('staff_name', String(su.name || ''))
      staffMods = String(su.modules || '').split(',').map((x) => x.trim()).filter(Boolean)
    } else {
      const staff = await getStaffKey(mainDb)
      if (staff && given === staff) role = 'staff'
    }
  }
  if (!role) return c.json({ error: '访问口令错误', code: 'bad_key' }, 401)
  // 员工权限：只能记账/收付/查询，不能删改单、不能看毛利与成本、不能改设置
  if (role === 'staff') {
    const m = c.req.method
    const denyStaff = m === 'PATCH' || m === 'DELETE' ||
      (/^\/(profit-compare|cash-bridge|aging|weekly-text|dunning-effect|backup|backup-list|backup-get|cloud-backup|restore|backup-to-notes)$/.test(path) && m !== 'OPTIONS') ||
      (/^\/auth\/(change|staff)$/.test(path)) ||
      (/^\/(report-head|book-name|wx-config)$/.test(path)) ||
      (/^\/month-lock/.test(path)) ||
      (/^\/import-undo/.test(path) && m !== 'OPTIONS') ||
      (/^\/accounts/.test(path) && m !== 'GET') ||
      (/^\/categories/.test(path) && m !== 'GET') ||
      (/^\/budgets/.test(path) && m !== 'GET') ||
      (/^\/fixed/.test(path) && m !== 'GET' && path !== '/run-fixed') ||
      ((/^\/debts/.test(path) || /^\/credit-limits/.test(path)) && m !== 'OPTIONS') ||
      (/^\/prepaids/.test(path) && m !== 'GET') ||
      (/^\/(payroll|wage-)/.test(path) && m !== 'OPTIONS') ||
      (/^\/rework-book$/.test(path) && m !== 'OPTIONS') ||
      (/^\/run-(amort|accrual)$/.test(path)) ||
      (/^\/transfers/.test(path) && m !== 'GET') ||
      (/^\/writeoffs/.test(path) && m !== 'GET') ||
      (/^\/recon-fix/.test(path) && m !== 'OPTIONS') ||
      (/^\/recon-save/.test(path) && m !== 'OPTIONS') ||
      (/^\/assets/.test(path) && m !== 'GET') ||
      (/^\/trash/.test(path) && m !== 'GET')
      || /^\/(staff-activity|staff-perms|staff-users|backup-verify)/.test(path)
      || /^\/party-merge/.test(path)
      || (/^\/party-staff$/.test(path) && m !== 'GET')
      || /^\/(schema-check|books-check|merge-summary|year-open|migrate-)/.test(path) || /^\/customer-card/.test(path) || /^\/credit-(book|grade)/.test(path) || /^\/collect-plan/.test(path) || /^\/recon-board/.test(path) || /^\/dunning-report/.test(path) || /^\/auth\/staff-off/.test(path)
      || (/^\/handover-note$/.test(path))
      || (/^\/invoice-(from-order|skip)$/.test(path) && m !== 'OPTIONS')
      || (/^\/(seal|unseal)$/.test(path))
      || /^\/edit-requests?\/\d+\/(approve|reject)$/.test(path)
      || (/^\/(tax-pack|year-close|year-review|quotes?|quote-hint)/.test(path))
      || (/^\/bank-(import|auto-match)/.test(path) && m !== 'GET')
      || (/^\/(kpi|year-summary|year-book|year-customers|loss-book|price-book|handover|month-report|report-view)$/.test(path) && m !== 'OPTIONS')
      || (/^\/bank-flows\/\d+\/match$/.test(path))
    if (denyStaff) return c.json({ error: '这是老板才能用的功能（员工口令不能删改单据、看不到毛利）', code: 'staff_denied' }, 403)
    const mod = staffModOf(path)
    if (mod) {
      const mods = staffMods || await getStaffModules(mainDb)
      if (!mods.includes(mod)) return c.json({ code: 'staff_module', error: '这个员工口令没有开「' + (STAFF_MOD_LABEL[mod] || mod) + '」，要开让老板去 设置 → 员工账号 勾上' }, 403)
    }
  }
  c.set('role', role)
  // 账本封存：整本只读（GET 照常），要动账先解封。放行：口令类、批量取数、封存开关本身
  try {
    const m2 = c.req.method
    if (m2 === 'POST' || m2 === 'PATCH' || m2 === 'DELETE') {
      const seal = await c.env.DB.prepare("SELECT value FROM settings WHERE key='sealed'").first()
      if (seal && String(seal.value) === '1') {
        const allow = /^\/(auth\/|batch$|seal$|unseal$|wx-login$)/.test(path)
        if (!allow) return c.json({ error: '这本账已经封存（只读），要改先解封：设置 → 🔒 账本封存', code: 'sealed' }, 423)
      }
    }
  } catch (e) { /* settings 表缺失时不拦 */ }
  c.set('role', role)
  await next()
})

// 员工账号：一人一个 4 位口令，各自授权限；谁记的账自动带名字
app.get('/staff-users', async (c) => {
  const db = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  await ensureStaffTable(db)
  const rows = (await db.prepare('SELECT id, name, pin, modules, active, created_at FROM staff_users ORDER BY active DESC, id').all()).results || []
  const mods = rows.map((r) => ({ ...r, mods: String(r.modules || '').split(',').filter(Boolean), mod_text: String(r.modules || '').split(',').filter(Boolean).map((k) => STAFF_MOD_LABEL[k] || k).join('、') }))
  const global = await getStaffModules(db)
  return c.json({
    ok: true, rows: mods, count: mods.length, active_count: mods.filter((r) => num(r.active)).length,
    labels: STAFF_MOD_LABEL, all_mods: Object.keys(STAFF_MOD_LABEL), global_mods: global,
    text: mods.length ? `有 ${mods.length} 个员工账号（在用 ${mods.filter((r) => num(r.active)).length} 个）。每人一个 4 位口令，记账时会自动记上名字。` : '还没有员工账号。加一个，把 4 位口令给他，他记的账就自动记上名字，也能单独限权。'
  })
})
app.post('/staff-users', async (c) => {
  const db = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  await ensureStaffTable(db)
  const b = await c.req.json().catch(() => ({}))
  const name = String(b.name || '').trim().slice(0, 12)
  if (!name) return c.json({ error: '先填个名字（比如 小王）' }, 400)
  let mods = Array.isArray(b.mods) ? b.mods.filter((k) => STAFF_MOD_LABEL[k]) : null
  if (mods && !mods.length) return c.json({ error: '至少给他开一个模块' }, 400)
  let pin = String(b.pin || '').replace(/\D/g, '').slice(0, 6)
  if (!pin) { let n = 0; do { pin = String(1000 + Math.floor(Math.random() * 9000)); n++ } while (n < 30 && await db.prepare('SELECT 1 FROM staff_users WHERE pin=?').bind(pin).first()) }
  const exists = await db.prepare('SELECT id FROM staff_users WHERE pin=?').bind(pin).first()
  if (exists) return c.json({ error: '这个口令已经有人用了，换一个' }, 409)
  const r = await db.prepare('INSERT INTO staff_users (name, pin, modules, active, created_at) VALUES (?,?,?,1,?)')
    .bind(name, pin, (mods || Object.keys(STAFF_MOD_LABEL)).join(','), now()).run()
  await logAudit(db, '加员工账号', '员工账号', `加了 ${name}（口令 ${pin}）`, '', act(c))
  return c.json({ ok: true, id: (r.meta && r.meta.last_row_id) || 0, name, pin, text: `加好了：${name}，口令 ${pin}。把口令给他，他在小程序里输这个口令就能记账，记的账会自动记上「${name}」。` })
})
app.post('/staff-users/:id', async (c) => {
  const db = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  await ensureStaffTable(db)
  const id = num(c.req.param('id'))
  const row = await db.prepare('SELECT * FROM staff_users WHERE id=?').bind(id).first()
  if (!row) return c.json({ error: '没有这个人了' }, 404)
  const b = await c.req.json().catch(() => ({}))
  const sets = []
  const vals = []
  if (b.name != null) { const nm = String(b.name).trim().slice(0, 12); if (!nm) return c.json({ error: '名字不能是空的' }, 400); sets.push('name=?'); vals.push(nm) }
  if (Array.isArray(b.mods)) { const mm = b.mods.filter((k) => STAFF_MOD_LABEL[k]); if (!mm.length) return c.json({ error: '至少给他开一个模块' }, 400); sets.push('modules=?'); vals.push(mm.join(',')) }
  if (b.active != null) { sets.push('active=?'); vals.push(num(b.active) ? 1 : 0) }
  if (b.pin != null) { const np = String(b.pin).replace(/\D/g, '').slice(0, 6); if (np.length < 4) return c.json({ error: '口令至少 4 位数字' }, 400); const dup = await db.prepare('SELECT id FROM staff_users WHERE pin=? AND id<>?').bind(np, id).first(); if (dup) return c.json({ error: '这个口令已经有人用了' }, 409); sets.push('pin=?'); vals.push(np) }
  if (!sets.length) return c.json({ error: '没有要改的东西' }, 400)
  await db.prepare('UPDATE staff_users SET ' + sets.join(',') + ' WHERE id=?').bind(...vals, id).run()
  await logAudit(db, '改员工账号', '员工账号', `改了 ${row.name}`, '', act(c))
  return c.json({ ok: true })
})
app.delete('/staff-users/:id', async (c) => {
  const db = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  await ensureStaffTable(db)
  const id = num(c.req.param('id'))
  const row = await db.prepare('SELECT * FROM staff_users WHERE id=?').bind(id).first()
  if (!row) return c.json({ error: '没有这个人了' }, 404)
  await db.prepare('DELETE FROM staff_users WHERE id=?').bind(id).run()
  await logAudit(db, '删员工账号', '员工账号', `删了 ${row.name}`, '', act(c))
  return c.json({ ok: true })
})

// 员工只看自己录的单（老板可在 设置 → 员工权限 开关）
async function selfOnly(c) {
  const role = c.get && c.get('role')
  if (role !== 'staff') return { on: false, who: '' }
  const main = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const row = await main.prepare("SELECT value FROM settings WHERE key='staff_self_only'").first().catch(() => null)
  if (!row || String(row.value) !== '1') return { on: false, who: '' }
  const nm = (c.get && c.get('staff_name')) || ''
  return { on: true, who: nm ? '员工·' + nm : '员工' }
}

// ===== 员工负责的客户：员工只看自己负责的那几家（老板可关） =====
async function partyStaffTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS party_staff (
    party TEXT PRIMARY KEY, staff TEXT NOT NULL DEFAULT '', updated_at TEXT
  )`).run()
}
// 员工 + 开了「只看自己负责的客户」时返回 {on, name}（name = 员工名，用于过滤）
async function scopeOwn(c) {
  if (!c.get || c.get('role') !== 'staff') return { on: false, name: '' }
  const main = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const row = await main.prepare("SELECT value FROM settings WHERE key='staff_scope'").first().catch(() => null)
  if (!row || String(row.value) !== 'own') return { on: false, name: '' }
  const nm = String((c.get && c.get('staff_name')) || '').trim()
  return { on: true, name: nm }
}
app.get('/party-staff', async (c) => {
  const db = c.env.DB
  await partyStaffTable(db)
  const q = await db.prepare('SELECT party, staff, updated_at FROM party_staff ORDER BY party LIMIT 500').all().catch(() => ({ results: [] }))
  const rows = ((q && q.results) || []).map((r) => ({ party: r.party || '', staff: r.staff || '', updated_at: r.updated_at || '' }))
  const staffQ = await db.prepare('SELECT name FROM staff_users WHERE COALESCE(active,1)=1 ORDER BY name').all().catch(() => ({ results: [] }))
  const names = ((staffQ && staffQ.results) || []).map((r) => r.name).filter(Boolean)
  const unassigned = await db.prepare("SELECT DISTINCT customer AS p FROM orders UNION SELECT DISTINCT supplier FROM payables").all().catch(() => ({ results: [] }))
  const assigned = new Set(rows.map((r) => norm(r.party)))
  const free = ((unassigned && unassigned.results) || []).map((r) => r.p || '').filter((p) => p && !assigned.has(norm(p)))
  const mine = await scopeOwn(c)
  if (mine.on) {
    const only = rows.filter((r) => norm(r.staff) === norm(mine.name))
    return c.json({ ok: true, role: 'staff', scope: 'own', count: only.length, rows: only, staff: names, free_count: 0, text: only.length ? `你负责 ${only.length} 家：${only.slice(0, 8).map((r) => r.party).join('、')}${only.length > 8 ? ' 等' : ''}` : '老板还没给你分客户，你只能看到自己录的单' })
  }
  return c.json({
    ok: true, count: rows.length, rows, staff: names, free_count: free.length, free: free.slice(0, 30),
    text: rows.length === 0
      ? '还没有给员工分过客户。分完之后，员工只能看到自己负责的那几家。'
      : `已给 ${new Set(rows.map((r) => r.staff)).size} 个员工分了 ${rows.length} 家客户${free.length ? `，还有 ${free.length} 家没分` : '，都分完了'}`
  })
})
app.post('/party-staff', async (c) => {
  const body = await c.req.json()
  const db = c.env.DB
  await partyStaffTable(db)
  const party = String(body.party || '').trim()
  const staff = String(body.staff || '').trim()
  if (!party) return c.json({ error: '要写是哪一家（客户 / 供应商名）' }, 400)
  if (!staff) {
    await db.prepare('DELETE FROM party_staff WHERE party=?').bind(party).run()
    await logAudit(db, '取消客户负责人', party, party, '', act(c))
    return c.json({ ok: true, cleared: true })
  }
  await db.prepare('INSERT INTO party_staff (party, staff, updated_at) VALUES (?,?,?) ON CONFLICT(party) DO UPDATE SET staff=excluded.staff, updated_at=excluded.updated_at')
    .bind(party, staff, now()).run()
  await logAudit(db, '指定客户负责人', party, `${party} → ${staff}`, '', act(c))
  return c.json({ ok: true, party, staff })
})

// 供应商比价：这家平时多少钱一笔，这次记的偏高还是偏低
app.get('/supply-price', async (c) => {
  const db = c.env.DB
  const party = String(c.req.query('party') || '').trim()
  const amount = num(c.req.query('amount'))
  const kw = String(c.req.query('kw') || '').trim()
  if (!party) {
    const rows = (await db.prepare(`SELECT supplier party, COUNT(*) cnt, COALESCE(SUM(amount),0) total, COALESCE(AVG(amount),0) avg,
        MAX(amount) max, MIN(amount) min, MAX(substr(created_at,1,10)) last_day
      FROM payables GROUP BY supplier ORDER BY total DESC LIMIT 60`).all().catch(() => ({ results: [] }))).results || []
    const list = rows.filter((r) => !kw || String(r.party).includes(kw)).map((r) => ({
      party: r.party, cnt: num(r.cnt), total: round2(num(r.total)), avg: round2(num(r.avg)),
      max: round2(num(r.max)), min: round2(num(r.min)), last_day: r.last_day, bar: Math.min(100, Math.round(num(r.total) / Math.max(1, num(rows[0] && rows[0].total)) * 100))
    }))
    return c.json({ ok: true, count: list.length, rows: list, text: list.length ? '按采购额排：' + list.slice(0, 5).map((r) => r.party + ' ¥' + r.total).join('、') : '还没有采购记录。' })
  }
  const q = (await db.prepare('SELECT id, amount, remark, substr(created_at,1,10) day FROM payables WHERE supplier=? ORDER BY id DESC LIMIT 30').bind(party).all().catch(() => ({ results: [] }))).results || []
  const amts = q.map((x) => num(x.amount))
  const cnt = amts.length
  const avg = cnt ? amts.reduce((a, x) => a + x, 0) / cnt : 0
  const hist = cnt >= 2 ? amts.slice(1) : amts
  const histAvg = hist.length ? hist.reduce((a, x) => a + x, 0) / hist.length : 0
  let pct = 0
  let hint = ''
  if (amount > 0 && histAvg > 0) {
    pct = Math.round((amount - histAvg) / histAvg * 1000) / 10
    hint = Math.abs(pct) < 10 ? '和这家平时的价位差不多（平均 ¥' + round2(histAvg) + '）'
      : pct > 0 ? '比这家平时贵 ' + pct + '%（平均 ¥' + round2(histAvg) + '）——是不是涨了价，或者这批料好一点？'
        : '比这家平时便宜 ' + (-pct) + '%（平均 ¥' + round2(histAvg) + '），可以问一句为什么'
  }
  const rows = q.slice(0, 8).map((x) => ({ id: num(x.id), day: x.day, amount: round2(num(x.amount)), remark: x.remark || '' }))
  return c.json({
    ok: true, party, cnt, avg: round2(avg), hist_avg: round2(histAvg),
    max: cnt ? round2(Math.max(...amts)) : 0, min: cnt ? round2(Math.min(...amts)) : 0,
    last: cnt ? round2(amts[0]) : 0, amount: round2(amount), pct, hint, rows,
    text: cnt ? '「' + party + '」共 ' + cnt + ' 笔采购，平均 ¥' + round2(avg) + '（最高 ¥' + round2(Math.max(...amts)) + '、最低 ¥' + round2(Math.min(...amts)) + '）。' + (hint ? hint : '') : '「' + party + '」还没有采购记录，这是第一笔。'
  })
})

// 单据照片：送货单、验收单、发票、微信转账截图，直接拍一张存着（压缩后存，一张几十 KB）
const ATT_MAX_CHARS = 900000   // 单张 base64 上限（约 650KB）
const ATT_TYPES = ['order', 'payable', 'asset', 'expense']
app.post('/attachments', async (c) => {
  const db = c.env.DB
  const b = await c.req.json().catch(() => ({}))
  const refType = String(b.ref_type || '').trim()
  const refId = num(b.ref_id)
  if (!ATT_TYPES.includes(refType)) return c.json({ error: '不支持挂在这种东西上' }, 400)
  if (!refId) return c.json({ error: '缺单据号' }, 400)
  const b64 = String(b.b64 || '').replace(/^data:[^;]+;base64,/, '')
  if (!b64) return c.json({ error: '没有图片内容' }, 400)
  if (b64.length > ATT_MAX_CHARS) return c.json({ error: '这张图太大（压缩后还超过 650KB），换个角度再拍一张' }, 400)
  const cnt = await db.prepare('SELECT COUNT(*) n FROM attachments WHERE ref_type=? AND ref_id=?').bind(refType, refId).first().catch(() => null)
  if (num(cnt && cnt.n) >= 6) return c.json({ error: '这一单已经存了 6 张，够用了（想换就先删一张）' }, 400)
  const name = String(b.name || '照片').slice(0, 40)
  const mime = String(b.mime || 'image/jpeg').slice(0, 30)
  const r = await db.prepare('INSERT INTO attachments (ref_type, ref_id, name, mime, size, b64, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind(refType, refId, name, mime, b64.length, b64, now()).run()
  const id = r.meta && r.meta.last_row_id ? num(r.meta.last_row_id) : 0
  await logAudit(db, '存单据照片', refType, refType + ' #' + refId + ' 加了照片「' + name + '」', String(refId), act(c))
  return c.json({ ok: true, id, kb: Math.round(b64.length / 1365) })
})
app.get('/attachments', async (c) => {
  const db = c.env.DB
  const refType = String(c.req.query('ref_type') || '').trim()
  const refId = num(c.req.query('ref_id'))
  if (!ATT_TYPES.includes(refType) || !refId) return c.json({ ok: true, count: 0, rows: [] })
  const list = (await db.prepare('SELECT id, name, mime, size, created_at FROM attachments WHERE ref_type=? AND ref_id=? ORDER BY id').bind(refType, refId).all().catch((e) => { noteFail(e, '单据照片'); return { results: [] } })).results || []
  return c.json({ ok: true, count: list.length, rows: list.map((a) => ({ id: num(a.id), name: a.name, size: num(a.size), kb: Math.round(num(a.size) / 1365), day: String(a.created_at || '').slice(0, 10) })) })
})
app.get('/attachment/:id', async (c) => {
  const db = c.env.DB
  const a = await db.prepare('SELECT * FROM attachments WHERE id=?').bind(num(c.req.param('id'))).first()
  if (!a) return c.json({ error: '照片不在了' }, 404)
  return c.json({ ok: true, id: num(a.id), name: a.name, mime: a.mime, b64: a.b64, day: String(a.created_at || '').slice(0, 10) })
})
app.delete('/attachment/:id', async (c) => {
  const db = c.env.DB
  const id = num(c.req.param('id'))
  const a = await db.prepare('SELECT * FROM attachments WHERE id=?').bind(id).first()
  if (!a) return c.json({ error: '照片不在了' }, 404)
  await db.prepare('DELETE FROM attachments WHERE id=?').bind(id).run()
  await logAudit(db, '删单据照片', a.ref_type, '删了照片「' + a.name + '」', String(a.ref_id), act(c))
  return c.json({ ok: true })
})

// 工序停着没动：未交付的单多久没更新过工序
// ===== 材料台账：进了多少、用了多少、还剩多少、该不该进货 =====
async function matTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE, unit TEXT DEFAULT '个',
    min_qty REAL DEFAULT 0, note TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  )`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS material_moves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    material TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'in',
    date TEXT, month TEXT, qty REAL NOT NULL DEFAULT 0,
    price REAL DEFAULT 0, amount REAL DEFAULT 0,
    party TEXT DEFAULT '', order_id INTEGER DEFAULT 0,
    note TEXT DEFAULT '', by TEXT DEFAULT '', created_at TEXT NOT NULL
  )`).run()
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_mat_move_mat ON material_moves(material, month)').run()
}
app.get('/materials', async (c) => {
  const db = c.env.DB
  await matTable(db)
  const m = /^\d{4}-\d{2}$/.test(String(c.req.query('month') || '')) ? String(c.req.query('month')).slice(0, 7) : now().slice(0, 7)
  const kinds = await db.prepare('SELECT name, unit, min_qty, note, active FROM materials ORDER BY name LIMIT 300').all().catch(() => ({ results: [] }))
  const agg = await db.prepare(`SELECT material,
      SUM(CASE WHEN kind='in' THEN qty ELSE 0 END) AS in_qty,
      SUM(CASE WHEN kind='out' THEN qty ELSE 0 END) AS out_qty,
      SUM(CASE WHEN kind='in' THEN amount ELSE 0 END) AS in_amt,
      SUM(CASE WHEN kind='out' AND month=? THEN qty ELSE 0 END) AS month_out,
      SUM(CASE WHEN kind='out' AND month=? THEN amount ELSE 0 END) AS month_amt,
      MAX(date) AS last_day
    FROM material_moves GROUP BY material`).bind(m, m).all().catch((e) => { noteFail(e, '材料汇总'); return { results: [] } })
  const lastPrice = await db.prepare(`SELECT material, price, date FROM material_moves WHERE kind='in' AND price>0 ORDER BY date DESC, id DESC`).all().catch(() => ({ results: [] }))
  const priceMap = {}
  for (const r of (lastPrice.results || [])) if (!priceMap[r.material]) priceMap[r.material] = { price: round2(num(r.price)), date: r.date }
  const aggMap = {}
  for (const r of (agg.results || [])) aggMap[norm(r.material)] = r
  const rows = ((kinds && kinds.results) || []).filter((k) => num(k.active) !== 0).map((k) => {
    const a = aggMap[norm(k.name)] || {}
    const inQty = num(a.in_qty)
    const outQty = num(a.out_qty)
    const left = round2(inQty - outQty)
    const min = num(k.min_qty)
    const lp = priceMap[k.name] || null
    return {
      name: k.name, unit: k.unit || '个', min_qty: min, note: k.note || '',
      in_qty: round2(inQty), out_qty: round2(outQty), left,
      month_out: round2(num(a.month_out)), month_amt: round2(num(a.month_amt)),
      in_amt: round2(num(a.in_amt)), last_day: a.last_day || '',
      last_price: lp ? lp.price : 0, last_price_day: lp ? lp.date : '',
      low: min > 0 && left <= min, enough: min > 0 ? left > min : true,
      // 按本月用量估还能用几天
      days_left: num(a.month_out) > 0 ? Math.floor(left / (num(a.month_out) / 30)) : null
    }
  }).sort((x, y) => (y.low ? 1 : 0) - (x.low ? 1 : 0) || x.left - y.left)
  const low = rows.filter((r) => r.low)
  const advice = []
  if (rows.length === 0) advice.push({ tone: 'info', text: '还没有建材料。常用的钢板、焊丝、砂轮，建一个名字和单位（吨/盘/片），以后进货和领用各记一笔，就不会出现「做到一半发现料没了」。' })
  for (const r of low.slice(0, 3)) advice.push({ tone: 'bad', text: `${r.name}只剩 ${r.left} ${r.unit}（低于下限 ${r.min_qty}），该进货了${r.days_left != null && r.days_left <= 7 ? `，按现在的用法撑不到 ${Math.max(1, r.days_left)} 天` : ''}` })
  const noMin = rows.filter((r) => !(r.min_qty > 0)).length
  if (rows.length > 0 && noMin > 0) advice.push({ tone: 'info', text: `有 ${noMin} 种材料没设「低于多少提醒」，设了才会自动提醒` })
  return c.json({
    ok: true, month: m, count: rows.length, low_cnt: low.length,
    low: low.slice(0, 20), rows,
    text: rows.length === 0 ? '材料台账还是空的。' : `共 ${rows.length} 种材料${low.length ? `，${low.length} 种低于下限（${low.slice(0, 3).map((r) => r.name).join('、')}）` : '，都还够用'}。`,
    advice, degraded: failBucket.slice()
  })
})
app.post('/materials', async (c) => {
  const body = await c.req.json()
  const db = c.env.DB
  await matTable(db)
  const name = String(body.name || '').trim()
  if (!name) return c.json({ error: '材料名必填（钢板 / 焊丝 / 砂轮…）' }, 400)
  const unit = String(body.unit || '个').trim() || '个'
  const min = round2(num(body.min_qty))
  const old = await db.prepare('SELECT id FROM materials WHERE name=?').bind(name).first()
  if (old) {
    await db.prepare('UPDATE materials SET unit=?, min_qty=?, note=?, active=1 WHERE id=?')
      .bind(unit, min, String(body.note || '').trim(), old.id).run()
    return c.json({ ok: true, updated: true })
  }
  await db.prepare('INSERT INTO materials (name, unit, min_qty, note, active, created_at) VALUES (?,?,?,?,1,?)')
    .bind(name, unit, min, String(body.note || '').trim(), now()).run()
  await logAudit(db, '新增材料', name, `${name}（${unit}）${min > 0 ? ' 低于 ' + min + ' 提醒' : ''}`, '', act(c))
  return c.json({ ok: true })
})
app.delete('/materials/:id', async (c) => {
  const db = c.env.DB
  await matTable(db)
  const id = c.req.param('id')
  await db.prepare('UPDATE materials SET active=0 WHERE id=?').bind(id).run()
  return c.json({ ok: true })
})
app.get('/material-moves', async (c) => {
  const db = c.env.DB
  await matTable(db)
  const sp = new URL(c.req.url).searchParams
  const mat = (sp.get('material') || '').trim()
  const m = sp.get('month') || ''
  const conds = []
  const b = []
  if (mat) { conds.push('material=?'); b.push(mat) }
  if (/^\d{4}-\d{2}$/.test(m)) { conds.push('month=?'); b.push(m) }
  const q = await db.prepare(`SELECT * FROM material_moves ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY date DESC, id DESC LIMIT 300`).bind(...b).all()
  const rows = ((q && q.results) || []).map((r) => ({
    id: r.id, material: r.material, kind: r.kind, kind_text: r.kind === 'out' ? '领用' : '进货',
    date: String(r.date || '').slice(0, 10), qty: round2(num(r.qty)), price: round2(num(r.price)), amount: round2(num(r.amount)),
    party: r.party || '', order_id: num(r.order_id), note: r.note || '', by: r.by || ''
  }))
  return c.json({ ok: true, count: rows.length, rows })
})
app.post('/material-moves', async (c) => {
  const body = await c.req.json()
  const db = c.env.DB
  await matTable(db)
  const name = String(body.material || '').trim()
  if (!name) return c.json({ error: '要写是哪种材料' }, 400)
  const kind = String(body.kind || 'in') === 'out' ? 'out' : 'in'
  const qty = round2(num(body.qty))
  if (qty <= 0) return c.json({ error: '数量要大于 0' }, 400)
  const price = round2(num(body.price))
  const date = toIsoDate(body.date) || todayIso()
  if (await isMonthLocked(db, date.slice(0, 7))) return c.json({ error: '该月份已结账锁定，先解锁再记' }, 403)
  const mt = await db.prepare('SELECT * FROM materials WHERE name=?').bind(name).first()
  if (!mt) {
    await db.prepare('INSERT INTO materials (name, unit, min_qty, note, active, created_at) VALUES (?,?,0,\'\',1,?)')
      .bind(name, String(body.unit || '个').trim() || '个', now()).run()
  }
  if (kind === 'out') {
    const agg = await db.prepare("SELECT SUM(CASE WHEN kind='in' THEN qty ELSE -qty END) AS left FROM material_moves WHERE material=?").bind(name).first()
    const left = round2(num(agg && agg.left))
    if (body.allow_negative !== true && qty > left + 0.0001) {
      return c.json({ error: `「${name}」账上只剩 ${left}，这次领 ${qty} 领多了。是之前进货没记？还是数量写错了？（真要记就勾「允许负数」）`, code: 'over_out', left }, 400)
    }
  }
  // 领用时没写单价，就按最近一次进货价估个金额（只做参考，不进利润）
  let unit = price
  if (kind === 'out' && !(unit > 0)) {
    const lp = await db.prepare("SELECT price FROM material_moves WHERE material=? AND kind='in' AND price>0 ORDER BY date DESC, id DESC LIMIT 1").bind(name).first()
    unit = round2(num(lp && lp.price))
  }
  const amount = round2(unit > 0 ? unit * qty : num(body.amount))
  await db.prepare(`INSERT INTO material_moves (material, kind, date, month, qty, price, amount, party, order_id, note, by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(name, kind, date, date.slice(0, 7), qty, price, amount, String(body.party || '').trim(), num(body.order_id) || 0, String(body.note || '').trim(), act(c), now()).run()
  await logAudit(db, kind === 'out' ? '材料领用' : '材料进货', name, `${name} ${kind === 'out' ? '领' : '进'} ${qty}${amount > 0 ? ' ¥' + amount : ''}`, '', act(c))
  const agg2 = await db.prepare("SELECT SUM(CASE WHEN kind='in' THEN qty ELSE -qty END) AS left FROM material_moves WHERE material=?").bind(name).first()
  return c.json({ ok: true, left: round2(num(agg2 && agg2.left)) })
})
app.delete('/material-moves/:id', async (c) => {
  const db = c.env.DB
  await matTable(db)
  const id = c.req.param('id')
  const r = await db.prepare('SELECT * FROM material_moves WHERE id=?').bind(id).first()
  if (!r) return c.json({ error: '没有这条记录' }, 404)
  if (await isMonthLocked(db, String(r.month || '').slice(0, 7))) return c.json({ error: '该月份已结账锁定' }, 403)
  await db.prepare('DELETE FROM material_moves WHERE id=?').bind(id).run()
  return c.json({ ok: true })
})

// ===== 合同 / 框架价：约定好的单价，下单低于它当场提醒 =====
async function frameTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS frame_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    party TEXT NOT NULL DEFAULT '', item TEXT DEFAULT '',
    price REAL NOT NULL DEFAULT 0, unit TEXT DEFAULT '件',
    start_date TEXT, end_date TEXT, note TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  )`).run()
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_frame_party ON frame_prices(party, active)').run()
}
async function frameOf(db, party, item, day) {
  try {
    await frameTable(db)
    const r = await db.prepare(`SELECT price, unit, item, note FROM frame_prices
      WHERE party=? AND active=1 AND (COALESCE(item,'')='' OR item=?)
        AND (COALESCE(start_date,'')='' OR substr(start_date,1,10) <= ?)
        AND (COALESCE(end_date,'')='' OR substr(end_date,1,10) >= ?)
      ORDER BY (CASE WHEN item=? THEN 1 ELSE 0 END) DESC, price DESC LIMIT 1`).bind(party, item || '', day || todayIso(), day || todayIso(), item || '').first()
    return r || null
  } catch (e) { noteFail(e, '框架价'); return null }
}
app.get('/frame-prices', async (c) => {
  const db = c.env.DB
  await frameTable(db)
  const party = String(c.req.query('party') || '').trim()
  const kw = String(c.req.query('kw') || '').trim()
  const conds = ['active=1']
  const b = []
  if (party) { conds.push('party=?'); b.push(party) }
  if (kw) { conds.push('(party LIKE ? OR item LIKE ?)'); b.push('%' + kw + '%', '%' + kw + '%') }
  const q = await db.prepare(`SELECT * FROM frame_prices WHERE ${conds.join(' AND ')} ORDER BY party, item LIMIT 300`).bind(...b).all()
  const rows = ((q && q.results) || []).map((r) => ({
    id: r.id, party: r.party || '', item: r.item || '（全部产品）', price: round2(num(r.price)), unit: r.unit || '件',
    start_date: String(r.start_date || '').slice(0, 10), end_date: String(r.end_date || '').slice(0, 10), note: r.note || '',
    text: `${r.party} · ${r.item || '全部产品'}：${round2(num(r.price))} 元/${r.unit || '件'}${r.note ? '（' + r.note + '）' : ''}`
  }))
  const parts = new Set(rows.map((r) => r.party))
  return c.json({
    ok: true, count: rows.length, party_count: parts.size, rows,
    text: rows.length === 0 ? '还没有约定过框架价。常做的老客户，把「一张多少钱、一年内不变」写进来，以后下单低于这个价就会提醒你。' : `共 ${rows.length} 条框架价，涉及 ${parts.size} 家：` + rows.slice(0, 6).map((r) => r.text).join('；'),
    degraded: failBucket.slice()
  })
})
app.post('/frame-prices', async (c) => {
  const body = await c.req.json()
  const db = c.env.DB
  await frameTable(db)
  const party = String(body.party || '').trim()
  if (!party) return c.json({ error: '要写是哪一家（客户名）' }, 400)
  const price = round2(num(body.price))
  if (price <= 0) return c.json({ error: '框架价要大于 0' }, 400)
  await db.prepare('INSERT INTO frame_prices (party, item, price, unit, start_date, end_date, note, active, created_at) VALUES (?,?,?,?,?,?,?,1,?)')
    .bind(party, String(body.item || '').trim(), price, String(body.unit || '件').trim(), toIsoDate(body.start_date) || null, toIsoDate(body.end_date) || null, String(body.note || '').trim(), now()).run()
  await logAudit(db, '加框架价', party, `${party} ${body.item || '全部'} ¥${price}`, '', act(c))
  return c.json({ ok: true })
})
app.delete('/frame-prices/:id', async (c) => {
  const db = c.env.DB
  await frameTable(db)
  const id = c.req.param('id')
  const r = await db.prepare('SELECT * FROM frame_prices WHERE id=?').bind(id).first()
  if (!r) return c.json({ error: '没有这条框架价' }, 404)
  await db.prepare('UPDATE frame_prices SET active=0 WHERE id=?').bind(id).run()
  await logAudit(db, '停用框架价', r.party, `${r.party} ${r.item || '全部'} ¥${num(r.price)}`, '', act(c))
  return c.json({ ok: true })
})
app.get('/frame-check', async (c) => {
  const db = c.env.DB
  const party = String(c.req.query('party') || '').trim()
  const item = String(c.req.query('item') || '').trim()
  const price = num(c.req.query('price'))
  if (!party) return c.json({ ok: true, has: false, text: '还没选客户' })
  const fr = await frameOf(db, party, item, todayIso())
  if (!fr) return c.json({ ok: true, has: false, text: `${party} 还没约定框架价` })
  const fp = round2(num(fr.price))
  const below = price > 0 && price < fp - 0.005
  return c.json({
    ok: true, has: true, frame_price: fp, unit: fr.unit || '件', item: fr.item || '',
    price: round2(price), below,
    text: `${party} ${fr.item ? '「' + fr.item + '」' : ''}框架价 ${fp} 元/${fr.unit || '件'}${price > 0 ? (below ? `，这单 ${round2(price)} 低了 ${round2(fp - price)}` : `，这单 ${round2(price)} 没低于框架价`) : ''}`
  })
})

// ===== 外协台账：发出去的活（谁、多少钱、什么时候回、回了没） =====
const OS_STATUS = { open: '还没回', done: '已回厂', cancel: '取消了' }
async function osTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS outsourcing (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    party TEXT NOT NULL DEFAULT '', order_id INTEGER DEFAULT 0,
    item TEXT DEFAULT '', qty REAL DEFAULT 0, price REAL NOT NULL DEFAULT 0,
    sent_date TEXT, due_date TEXT, back_date TEXT,
    status TEXT NOT NULL DEFAULT 'open', note TEXT DEFAULT '',
    by TEXT DEFAULT '', created_at TEXT NOT NULL
  )`).run()
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_os_status ON outsourcing(status, due_date)').run()
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_os_party ON outsourcing(party)').run()
}
app.get('/outsource-book', async (c) => {
  const db = c.env.DB
  await osTable(db)
  const today = now().slice(0, 10)
  const month = String(c.req.query('month') || '').slice(0, 7)
  const status = String(c.req.query('status') || '')
  const conds = []
  const b = []
  if (/^\d{4}-\d{2}$/.test(month)) { conds.push('substr(COALESCE(sent_date,created_at),1,7) = ?'); b.push(month) }
  if (status && OS_STATUS[status]) { conds.push('status = ?'); b.push(status) }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
  const q = await db.prepare(`SELECT o.*, (SELECT c.customer FROM orders c WHERE c.id=o.order_id) AS customer
    FROM outsourcing o ${where} ORDER BY COALESCE(due_date,'9999') ASC, id DESC LIMIT 500`).bind(...b).all()
  const all = ((q && q.results) || []).map((r) => {
    const sent = String(r.sent_date || r.created_at || '').slice(0, 10)
    const due = String(r.due_date || '').slice(0, 10)
    const back = String(r.back_date || '').slice(0, 10)
    const left = due ? Math.round((dateNum(due) - dateNum(today)) / 86400000) : null
    const late = r.status === 'open' && left !== null && left < 0
    return {
      id: r.id, party: r.party || '', order_id: num(r.order_id), customer: r.customer || '',
      item: r.item || '', qty: num(r.qty), price: round2(num(r.price)),
      sent_date: sent, due_date: due, back_date: back,
      status: r.status || 'open', status_text: OS_STATUS[r.status] || '还没回',
      left_days: left, late, note: r.note || '', by: r.by || '',
      days_out: back ? null : daysSince(sent)
    }
  })
  const openRows = all.filter((r) => r.status === 'open')
  const lateRows = openRows.filter((r) => r.late)
  const byParty = {}
  for (const r of all) {
    const k = norm(r.party)
    const o = byParty[k] || (byParty[k] = { party: r.party || '', cnt: 0, amount: 0, open: 0, late: 0 })
    o.cnt += 1
    o.amount = round2(o.amount + r.price)
    if (r.status === 'open') { o.open += 1; if (r.late) o.late += 1 }
  }
  const parties = Object.values(byParty).sort((x, y) => y.amount - x.amount).slice(0, 20)
  const advice = []
  if (lateRows.length) advice.push({ tone: 'bad', text: `${lateRows.length} 笔外协已经超过约定回厂日（${lateRows.slice(0, 2).map((x) => x.party).join('、')}），催一下，不然你自己的交期要跟着拖` })
  if (openRows.length === 0 && all.length > 0) advice.push({ tone: 'ok', text: '没有压在外面的活，外协都回来了' })
  if (all.length === 0) advice.push({ tone: 'info', text: '这段时间没有外协记录。发出去外协的时候记一笔，回来点一下，就再也不用记在脑子里了' })
  const bigParty = parties[0]
  if (bigParty && parties.length >= 3 && bigParty.amount / Math.max(1, all.reduce((t, r) => t + r.price, 0)) >= 0.7) advice.push({ tone: 'warn', text: `外协 ${Math.round((bigParty.amount / all.reduce((t, r) => t + r.price, 0)) * 100)}% 在「${bigParty.party}」一家手上，这家出问题你就停线` })
  const openAmount = round2(openRows.reduce((t, r) => t + r.price, 0))
  const text = all.length === 0
    ? (month ? `${month} 没有外协记录。` : '还没有外协记录。')
    : `【外协】（${month || '全部'}）共 ${all.length} 笔、¥${round2(all.reduce((t, r) => t + r.price, 0))}；还压在外面 ${openRows.length} 笔、¥${openAmount}${lateRows.length ? `，其中 ${lateRows.length} 笔已超期` : ''}。`
  return c.json({
    ok: true, today, month, status, count: all.length, amount: round2(all.reduce((t, r) => t + r.price, 0)),
    open_cnt: openRows.length, open_amount: openAmount, late_cnt: lateRows.length,
    rows: all.slice(0, 100), parties, advice, text, degraded: failBucket.slice()
  })
})
app.post('/outsource', async (c) => {
  const body = await c.req.json()
  const db = c.env.DB
  await osTable(db)
  const party = String(body.party || '').trim()
  if (!party) return c.json({ error: '外协给谁（加工厂/个人）必填' }, 400)
  const price = round2(num(body.price))
  if (price < 0) return c.json({ error: '外协金额不能是负数' }, 400)
  const created = stampOf(body.sent_date)
  const due = toIsoDate(body.due_date) || null
  const sent = toIsoDate(body.sent_date) || created.slice(0, 10)
  if (await isMonthLocked(db, created.slice(0, 7))) return c.json({ error: '该月份已结账锁定，先解锁再记' }, 403)
  await db.prepare(`INSERT INTO outsourcing (party, order_id, item, qty, price, sent_date, due_date, status, note, by, created_at)
    VALUES (?,?,?,?,?,?,?,'open',?,?,?)`)
    .bind(party, num(body.order_id) || 0, String(body.item || '').trim(), num(body.qty), price, sent, due, String(body.note || '').trim(), act(c), created).run()
  await logAudit(db, '外协发出', party, `${party} ${body.item || ''} ¥${price}`, '', act(c))
  return c.json({ ok: true })
})
app.post('/outsource/:id/back', async (c) => {
  const db = c.env.DB
  await osTable(db)
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const o = await db.prepare('SELECT * FROM outsourcing WHERE id=?').bind(id).first()
  if (!o) return c.json({ error: '没有这条外协记录' }, 404)
  if (o.status === 'done') return c.json({ error: '这条已经标过「回来了」' }, 400)
  const back = toIsoDate(body.back_date) || todayIso()
  await db.prepare("UPDATE outsourcing SET status='done', back_date=? WHERE id=?").bind(back, id).run()
  await logAudit(db, '外协回厂', o.party, `${o.party} ${o.item || ''} 回来了`, `outsource:${id}`, act(c))
  const late = o.due_date ? Math.round((dateNum(back) - dateNum(String(o.due_date).slice(0, 10))) / 86400000) : 0
  return c.json({ ok: true, back_date: back, late_days: late, note: late > 0 ? `比约定晚了 ${late} 天回来` : '按约定回来了' })
})
app.delete('/outsource/:id', async (c) => {
  const db = c.env.DB
  await osTable(db)
  const id = c.req.param('id')
  const o = await db.prepare('SELECT * FROM outsourcing WHERE id=?').bind(id).first()
  if (!o) return c.json({ error: '没有这条外协记录' }, 404)
  if (await isMonthLocked(db, String(o.created_at || '').slice(0, 7))) return c.json({ error: '该月份已结账锁定' }, 403)
  await db.prepare('DELETE FROM outsourcing WHERE id=?').bind(id).run()
  await logAudit(db, '删外协记录', o.party, `${o.party} ¥${num(o.price)}`, '', act(c))
  return c.json({ ok: true })
})

// 本周排产 / 交期风险：约定交货日 + 工序进度，倒排「这周该交哪些、哪单要赶」
app.get('/delivery-plan', async (c) => {
  const db = c.env.DB
  const today = now().slice(0, 10)
  const days = Math.max(1, Math.min(60, num(c.req.query('days')) || 7))
  const until = addDaysIso(today, days)
  const ST = ['待加工', '加工中', '已交付']
  const rowsQ = await db.prepare(
    `SELECT o.id, o.customer, o.item_name, o.price, o.status, o.progress, o.created_at,
            substr(o.deliver_date,1,10) dd,
            (SELECT MAX(p.created_at) FROM process_log p WHERE p.order_id=o.id) last_log
       FROM orders o
      WHERE COALESCE(o.status,0) < 2 AND COALESCE(o.deliver_date,'') <> ''
        AND substr(o.deliver_date,1,10) <= ?
      ORDER BY substr(o.deliver_date,1,10) ASC LIMIT 300`
  ).bind(until).all().catch((e) => { noteFail(e, '排产'); return { results: [] } })
  const rows = ((rowsQ && rowsQ.results) || []).map((o) => {
    const dd = o.dd || ''
    const left = dd ? Math.round((dateNum(dd) - dateNum(today)) / 86400000) : null   // 正=还有几天，负=已过
    const idle = daysSince(String(o.last_log || o.created_at || '').slice(0, 10))
    const st = num(o.status)
    // 风险：已过交货日还没交 > 剩 2 天内还没开工 > 剩 3 天内还停着
    let risk = 'ok', why = ''
    if (left < 0) { risk = 'overdue'; why = `交货日过了 ${Math.abs(left)} 天还没交` }
    else if (left <= 2 && st === 0) { risk = 'high'; why = `还有 ${left} 天，还没开工` }
    else if (left <= 3 && idle >= 3) { risk = 'high'; why = `还有 ${left} 天，已经 ${idle} 天没动` }
    else if (left <= 5) { risk = 'warn'; why = `还有 ${left} 天` }
    return {
      id: o.id, customer: o.customer || '', item: o.item_name || '', price: round2(num(o.price)),
      status: st, status_text: ST[st] || '待加工', progress: o.progress || '',
      deliver_date: dd, left_days: left, idle_days: idle, risk, why
    }
  })
  const byDay = {}
  for (const r of rows) {
    const k = r.deliver_date || '没写交货日'
    const d = byDay[k] || (byDay[k] = { date: k, cnt: 0, amount: 0, high: 0 })
    d.cnt += 1
    d.amount = round2(d.amount + r.price)
    if (r.risk === 'high' || r.risk === 'overdue') d.high += 1
  }
  const overdue = rows.filter((r) => r.risk === 'overdue').length
  const high = rows.filter((r) => r.risk === 'high').length
  const noDate = await db.prepare("SELECT COUNT(*) n FROM orders WHERE COALESCE(status,0) < 2 AND COALESCE(deliver_date,'') = ''").first().catch(() => ({ n: 0 }))
  const amount = round2(rows.reduce((t, r) => t + r.price, 0))
  const advice = []
  if (rows.length === 0) advice.push({ tone: 'ok', text: `${days} 天内没有要交的活${num(noDate && noDate.n) > 0 ? `（还有 ${num(noDate.n)} 张单没写交货日，写上才好排产）` : ''}` })
  if (overdue) advice.push({ tone: 'bad', text: `有 ${overdue} 张单交货日已经过了还没交，先给客户打个电话说明` })
  if (high) advice.push({ tone: 'warn', text: `${high} 张要赶：盯着车间今天先做这几张` })
  if (num(noDate && noDate.n) > 0) advice.push({ tone: 'info', text: `另有 ${num(noDate && noDate.n)} 张在做的单没写交货日，写上了才会进这个表` })
  if (rows.length && !overdue && !high) advice.push({ tone: 'ok', text: '这周的活排得开，按顺序做就行' })
  const text = rows.length === 0
    ? `${days} 天内没有要交的活。`
    : `【这周要交的活 · 到 ${until}】共 ${rows.length} 张，合计 ¥${amount}。${overdue ? `已过期 ${overdue} 张，` : ''}${high ? `要赶 ${high} 张。` : '暂无要赶的。'}`
  return c.json({
    ok: true, today, days, until, count: rows.length, amount,
    overdue, high, warn: rows.filter((r) => r.risk === 'warn').length,
    no_date: num(noDate && noDate.n),
    by_day: Object.values(byDay).sort((a, b) => String(a.date).localeCompare(String(b.date))),
    rows: rows.slice(0, 60), advice, text, degraded: failBucket.slice()
  })
})

app.get('/process-stale', async (c) => {
  const db = c.env.DB
  const days = Math.min(120, Math.max(1, Math.round(num(c.req.query('days'), 7))))
  const ST = ['待加工', '加工中', '已交付']
  const rows0 = (await db.prepare(`SELECT o.id, o.customer, o.item_name, o.price, o.progress, o.status, o.created_at,
      (SELECT MAX(p.created_at) FROM process_log p WHERE p.order_id = o.id) last_log
    FROM orders o WHERE COALESCE(o.status,0) < 2 ORDER BY o.id DESC LIMIT 500`).all().catch((e) => { noteFail(e, '工序停滞'); return { results: [] } })).results || []
  const rows = []
  for (const r of rows0) {
    const last = String(r.last_log || r.created_at || '').slice(0, 10)
    if (!last) continue
    const idle = daysSince(last)
    if (idle < days) continue
    rows.push({ id: num(r.id), customer: r.customer, item: r.item_name || '', price: round2(num(r.price)), progress: r.progress || '', status: ST[num(r.status)] || '待加工', last_day: last, idle_days: idle, level: idle >= days * 3 ? 'high' : 'mid' })
  }
  rows.sort((a, b) => b.idle_days - a.idle_days)
  const high = rows.filter((r) => r.level === 'high').length
  return c.json({
    ok: true, days, count: rows.length, high, rows: rows.slice(0, 50),
    advice: rows.length
      ? '有 ' + rows.length + ' 张单还没交付，其中 ' + high + ' 张超过 ' + (days * 3) + ' 天没动过。挑最久的那张问车间一句：卡在哪、缺什么料、什么时候能出。'
      : '没有卡住的单——未交付的都在 ' + days + ' 天内动过。',
    text: rows.length
      ? '【工序卡住的单】' + rows.slice(0, 5).map((r) => r.customer + (r.item ? '·' + r.item : '') + '（' + r.idle_days + ' 天没动）').join('、') + (rows.length > 5 ? ' 等 ' + rows.length + ' 张' : '')
      : '【工序卡住的单】没有，未交付的都在 ' + days + ' 天内动过。'
  })
})

// 设备保养：每 N 个月保养一次，到期提醒
app.get('/asset-maint', async (c) => {
  const db = c.env.DB
  const days = Math.min(120, Math.max(0, Math.round(num(c.req.query('days'), 15))))
  const today = todayIso()
  const list = (await db.prepare('SELECT * FROM assets ORDER BY id').all().catch((e) => { noteFail(e, '设备保养'); return { results: [] } })).results || []
  const rows = []
  for (const a of list) {
    if (a.disposed_at) continue
    const months = num(a.maint_months)
    if (months <= 0) continue
    const base = String(a.maint_last || a.buy_date || a.created_at || '').slice(0, 10) || today
    // 下一个保养日 = 上次保养 + N 个月
    const d = new Date(base + 'T00:00:00Z')
    d.setUTCMonth(d.getUTCMonth() + Math.round(months))
    const next = d.toISOString().slice(0, 10)
    const left = Math.round((dateNum(next) - dateNum(today)) / 86400000)
    if (left > days) continue
    rows.push({ id: num(a.id), name: a.name, months, base_day: base, next_day: next, left_days: left, level: left < 0 ? 'high' : 'mid' })
  }
  rows.sort((a, b) => a.left_days - b.left_days)
  const over = rows.filter((r) => r.left_days < 0).length
  return c.json({
    ok: true, today, count: rows.length, overdue: over, rows,
    advice: rows.length
      ? (over ? '有 ' + over + ' 台已经过了保养期，' : '') + '还有 ' + (rows.length - over) + ' 台 ' + days + ' 天内该保养。停一次机比保养贵得多，抽个空做掉。'
      : '设备保养都还没到期（想提醒就给设备设个保养周期）。',
    text: rows.length ? '【设备保养】' + rows.slice(0, 5).map((r) => r.name + '（' + (r.left_days < 0 ? '已超 ' + (-r.left_days) + ' 天' : r.left_days + ' 天后') + '）').join('、') : '【设备保养】都还没到期。'
  })
})
app.post('/assets/:id/maint', async (c) => {
  const db = c.env.DB
  const id = num(c.req.param('id'))
  const b = await c.req.json().catch(() => ({}))
  const a = await db.prepare('SELECT * FROM assets WHERE id=?').bind(id).first()
  if (!a) return c.json({ error: '没有这台设备' }, 404)
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) ? String(b.date) : todayIso()
  const months = b.months != null ? Math.max(0, Math.round(num(b.months))) : num(a.maint_months)
  await db.prepare('UPDATE assets SET maint_last=?, maint_months=? WHERE id=?').bind(day, months, id).run()
  await logAudit(db, '设备保养', '设备', a.name + ' 保养了（' + day + '），下次 ' + (months ? months + ' 个月后' : '不提醒'), '', act(c))
  return c.json({ ok: true, name: a.name, date: day, months })
})

// ===== 返工 / 报废 / 客诉：钱是怎么被悄悄吃掉的 =====
// 小厂最容易被吃掉利润的不是水电，是返工：同样的活干两遍，料多花一份，工钱照付。
// 这里只记「损失多少钱 + 为什么」，账上的钱不用再记一遍（返工不额外进出款）。
const RW_KIND = { rework: '返工', scrap: '报废', complaint: '客诉' }
const RW_FAULT = { self: '自己做坏了', material: '材料有问题', customer: '客户改了要求', design: '图纸 / 尺寸给错', other: '别的原因' }

async function reworkTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS reworks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'rework',
    date TEXT NOT NULL,
    month TEXT,
    party TEXT DEFAULT '',
    order_id INTEGER DEFAULT 0,
    item TEXT DEFAULT '',
    qty REAL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    reason TEXT DEFAULT '',
    fault TEXT DEFAULT '',
    fix TEXT DEFAULT '',
    note TEXT DEFAULT '',
    by TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`).run()
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_rw_month ON reworks(month)').run()
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_rw_party ON reworks(party)').run()
}

app.get('/rework-book', async (c) => {
  const db = c.env.DB
  await reworkTable(db)
  const mon = String(c.req.query('month') || '').slice(0, 7)
  const y = String(c.req.query('year') || now().slice(0, 4))
  const kind = String(c.req.query('kind') || '')
  const w = mon ? 'month=?' : 'substr(date,1,4)=?'
  const conds = [w]
  const b = [mon || y]
  if (kind && RW_KIND[kind]) { conds.push('kind=?'); b.push(kind) }
  const { results } = await db.prepare(`SELECT * FROM reworks WHERE ${conds.join(' AND ')} ORDER BY date DESC, id DESC LIMIT 500`).bind(...b).all()
  const rows = (results || []).map((r) => ({
    id: r.id, kind: r.kind, kind_label: RW_KIND[r.kind] || '返工',
    date: String(r.date || '').slice(0, 10), party: r.party || '', order_id: num(r.order_id),
    item: r.item || '', qty: num(r.qty), cost: round2(num(r.cost)),
    reason: r.reason || '', fault: r.fault || '', fault_label: RW_FAULT[r.fault] || '',
    fix: r.fix || '', note: r.note || '', by: r.by || ''
  }))
  const sum = (list) => round2(list.reduce((a, x) => a + x.cost, 0))
  const byKind = {}
  for (const k of Object.keys(RW_KIND)) byKind[k] = { k, label: RW_KIND[k], count: 0, amount: 0 }
  const byFault = {}
  const byParty = {}
  const byReason = {}
  for (const r of rows) {
    byKind[r.kind] = byKind[r.kind] || { k: r.kind, label: r.kind_label, count: 0, amount: 0 }
    byKind[r.kind].count += 1; byKind[r.kind].amount = round2(byKind[r.kind].amount + r.cost)
    if (r.fault) {
      byFault[r.fault] = byFault[r.fault] || { k: r.fault, label: r.fault_label, count: 0, amount: 0 }
      byFault[r.fault].count += 1; byFault[r.fault].amount = round2(byFault[r.fault].amount + r.cost)
    }
    if (r.party) {
      byParty[r.party] = byParty[r.party] || { party: r.party, count: 0, amount: 0 }
      byParty[r.party].count += 1; byParty[r.party].amount = round2(byParty[r.party].amount + r.cost)
    }
    if (r.reason) {
      byReason[r.reason] = byReason[r.reason] || { reason: r.reason, count: 0, amount: 0 }
      byReason[r.reason].count += 1; byReason[r.reason].amount = round2(byReason[r.reason].amount + r.cost)
    }
  }
  const total = sum(rows)
  const period = mon || y + ' 年'
  // 占接单额多少：返工最怕「看着忙，其实白干」
  let income = 0
  try {
    const oq = mon ? ['month=?', mon] : ["substr(created_at,1,4)=?", y]
    const o = await db.prepare(`SELECT COALESCE(SUM(price),0) s FROM orders WHERE ${oq[0]}`).bind(oq[1]).first()
    income = round2(num(o && o.s))
  } catch (e) { income = 0 }
  const pct = income > 0 ? round2(total / income * 100) : 0
  const topParty = Object.values(byParty).sort((a, b) => b.amount - a.amount)[0]
  const topReason = Object.values(byReason).sort((a, b) => b.amount - a.amount)[0]
  const faultSelf = Object.values(byFault).filter((f) => f.k === 'self').reduce((a, f) => a + f.amount, 0)
  const advice = []
  if (!rows.length) advice.push({ tone: 'ok', text: `${period}没有记过返工、报废或客诉 👏 如果真没出过问题，说明活做得稳。` })
  else {
    advice.push({ tone: total > 0 ? 'bad' : 'warn', text: `${period}返工/报废/客诉 ${rows.length} 笔，损失 ¥${total}` + (income > 0 ? `，相当于接单额 ¥${income} 的 ${pct}%` : '') + '。' })
    if (topReason) advice.push({ tone: 'warn', text: `最常出的问题是「${topReason.reason}」：${topReason.count} 次，¥${topReason.amount}。这个环节开工前多看一眼，比返工省钱。` })
    if (faultSelf > 0) advice.push({ tone: 'warn', text: `其中自己做坏占 ¥${faultSelf}——要么是赶工，要么是没看清图纸；同一道工序反复出问题，就该换做法或者换人带一下。` })
    if (topParty) advice.push({ tone: 'info', text: `亏得最多的是 ${topParty.party}：${topParty.count} 次 ¥${topParty.amount}。这家要求是不是特别细？下次报价把返工风险算进去。` })
  }
  const text = [
    `【${(await getTitle(db)).title}】${period} 返工/报废/客诉`,
    `共 ${rows.length} 笔，损失 ¥${total}` + (income > 0 ? `（占接单额 ${pct}%）` : ''),
    ...Object.values(byKind).filter((k) => k.count).map((k) => `· ${k.label}：${k.count} 笔 ¥${k.amount}`),
    ...Object.values(byFault).filter((f) => f.count).map((f) => `· ${f.label}：${f.count} 笔 ¥${f.amount}`),
    ...advice.map((a) => '· ' + a.text)
  ].join('\n')
  return c.json({
    ok: true, month: mon || '', year: y, period, total, count: rows.length, income, pct,
    by_kind: Object.values(byKind), by_fault: Object.values(byFault).sort((a, b) => b.amount - a.amount),
    by_party: Object.values(byParty).sort((a, b) => b.amount - a.amount).slice(0, 8),
    by_reason: Object.values(byReason).sort((a, b) => b.count - a.count).slice(0, 8),
    rows: rows.slice(0, 100), advice, text
  })
})

app.post('/rework', async (c) => {
  const body = await c.req.json()
  const db = c.env.DB
  await reworkTable(db)
  const kind = RW_KIND[body.kind] ? body.kind : 'rework'
  const day = String(body.date || todayIso()).slice(0, 10)
  const mm = day.slice(0, 7)
  if (await isMonthLocked(db, mm)) return c.json({ error: `${mm} 已结账锁定，先解锁再记` }, 403)
  const cost = round2(num(body.cost))
  if (cost < 0) return c.json({ error: '损失金额不能是负数（没损失就填 0）' }, 400)
  const party = String(body.party || '').trim()
  if (!party && !String(body.reason || '').trim()) return c.json({ error: '至少填一个客户/供应商，或者写一句出了什么问题' }, 400)
  await db.prepare('INSERT INTO reworks (kind, date, month, party, order_id, item, qty, cost, reason, fault, fix, note, by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(kind, day, mm, party, num(body.order_id), String(body.item || ''), num(body.qty), cost,
      String(body.reason || ''), RW_FAULT[body.fault] ? body.fault : '', String(body.fix || ''), String(body.note || ''), act(c), now()).run()
  await logAudit(db, '记' + RW_KIND[kind], party || '—', `${RW_KIND[kind]} ¥${cost} ${body.reason || ''}`, '', act(c))
  return c.json({ ok: true })
})

app.delete('/rework/:id', async (c) => {
  const db = c.env.DB
  await reworkTable(db)
  const id = num(c.req.param('id'))
  const row = await db.prepare('SELECT * FROM reworks WHERE id=?').bind(id).first()
  if (!row) return c.json({ error: '这条记录找不到了' }, 404)
  if (await isMonthLocked(db, String(row.month || ''))) return c.json({ error: '该月份已结账锁定，先解锁再改' }, 403)
  await db.prepare('DELETE FROM reworks WHERE id=?').bind(id).run()
  await logAudit(db, '删返工记录', row.party || '—', `${row.date} ${RW_KIND[row.kind] || ''}`, '', act(c))
  return c.json({ ok: true })
})

// ===== 计件工资：先记工，月底算钱，发工资，打工资单 =====
// 为什么这么做：小厂工人按件拿钱，平时记「谁哪天干了多少件」，月底一算就知道该发多少；
// 直接记「工资 8000」只知道花了多少，不知道贵在哪、谁干得多。
const WAGE_UNITS = ['件', '米', '平方', '套', '小时', '单']

async function wageTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS wage_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker TEXT NOT NULL DEFAULT '',
    item TEXT DEFAULT '',
    process TEXT DEFAULT '',
    rate REAL NOT NULL DEFAULT 0,
    unit TEXT DEFAULT '件',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  )`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS wage_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL,
    month TEXT,
    order_id INTEGER DEFAULT 0,
    item TEXT DEFAULT '',
    process TEXT DEFAULT '',
    qty REAL NOT NULL DEFAULT 0,
    rate REAL NOT NULL DEFAULT 0,
    amount REAL NOT NULL DEFAULT 0,
    note TEXT DEFAULT '',
    by TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS wage_pays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    worker TEXT NOT NULL DEFAULT '',
    amount REAL NOT NULL DEFAULT 0,
    account_id INTEGER DEFAULT 0,
    note TEXT DEFAULT '',
    by TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`).run()
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_wage_rec_month ON wage_records(month)').run()
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_wage_rec_worker ON wage_records(worker)').run()
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_wage_pay_month ON wage_pays(month)').run()
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_wage_rate_worker ON wage_rates(worker)').run()
}

// 找这个工人这道活该按什么单价算：工人+产品+工序 全对最优先，其次退到通用
async function wageRateOf(db, worker, item, process) {
  const { results } = await db.prepare("SELECT * FROM wage_rates WHERE COALESCE(active,1)<>0 AND (worker=? OR worker='*')").bind(String(worker || '')).all()
  let best = null
  let bestScore = -1
  for (const r of results || []) {
    let s = 0
    if (r.worker === String(worker || '')) s += 4
    else if (r.worker === '*') s += 1
    else continue
    const ri = String(r.item || '')
    if (item && ri === String(item)) s += 2
    else if (ri === '' || ri === '*') s += 0
    else continue
    const rp = String(r.process || '')
    if (process && rp === String(process)) s += 1
    else if (rp === '' || rp === '*') s += 0
    else continue
    if (s > bestScore) { bestScore = s; best = r }
  }
  return best
}

// 单价表：谁、干什么活、一件多少钱
app.get('/wage-rates', async (c) => {
  const db = c.env.DB
  await wageTable(db)
  const { results } = await db.prepare('SELECT * FROM wage_rates ORDER BY worker, item, process').all()
  const rows = (results || []).map((r) => ({
    id: r.id, worker: r.worker || '', item: r.item || '', process: r.process || '',
    rate: num(r.rate), unit: r.unit || '件', active: num(r.active, 1),
    text: `${r.worker || '（通用）'}${r.item ? ' · ' + r.item : ''}${r.process ? ' · ' + r.process : ''}：${num(r.rate)} 元/${r.unit || '件'}`
  }))
  return c.json({ ok: true, rows, count: rows.length, units: WAGE_UNITS, text: rows.length ? `一共 ${rows.length} 条单价` : '还没设单价，先加一条「谁·干什么活·一件多少钱」' })
})

app.post('/wage-rates', async (c) => {
  const body = await c.req.json()
  const db = c.env.DB
  await wageTable(db)
  const worker = String(body.worker || '').trim()
  if (!worker) return c.json({ error: '要填工人名字（通用单价写 *）' }, 400)
  if (num(body.rate) <= 0) return c.json({ error: '一件多少钱要大于 0' }, 400)
  await db.prepare('INSERT INTO wage_rates (worker, item, process, rate, unit, active, created_at) VALUES (?,?,?,?,?,1,?)')
    .bind(worker, String(body.item || '').trim(), String(body.process || '').trim(), num(body.rate), String(body.unit || '件'), now()).run()
  await logAudit(db, '设计件单价', worker, `${worker} ${body.item || ''} ${body.process || ''} ¥${num(body.rate)}/${body.unit || '件'}`, '', act(c))
  return c.json({ ok: true })
})

app.delete('/wage-rates/:id', async (c) => {
  const db = c.env.DB
  await wageTable(db)
  await db.prepare('DELETE FROM wage_rates WHERE id=?').bind(num(c.req.param('id'))).run()
  return c.json({ ok: true })
})

// 记工：今天谁干了多少件（单价没填就按单价表自动找）
app.get('/wage-records', async (c) => {
  const db = c.env.DB
  await wageTable(db)
  const mm = String(c.req.query('month') || now().slice(0, 7))
  const worker = String(c.req.query('worker') || '')
  const conds = ['month=?']
  const b = [mm]
  if (worker) { conds.push('worker=?'); b.push(worker) }
  const { results } = await db.prepare(`SELECT * FROM wage_records WHERE ${conds.join(' AND ')} ORDER BY date DESC, id DESC LIMIT 500`).bind(...b).all()
  const rows = (results || []).map((r) => ({
    id: r.id, worker: r.worker, date: String(r.date || '').slice(0, 10), order_id: num(r.order_id),
    item: r.item || '', process: r.process || '', qty: num(r.qty), rate: num(r.rate),
    amount: num(r.amount), note: r.note || '', by: r.by || ''
  }))
  const total = rows.reduce((s, r) => s + r.amount, 0)
  return c.json({ ok: true, month: mm, rows, count: rows.length, total: Math.round(total * 100) / 100, text: rows.length ? `${mm} 记了 ${rows.length} 笔工，合计 ¥${Math.round(total * 100) / 100}` : `${mm} 还没记工` })
})

app.post('/wage-records', async (c) => {
  const body = await c.req.json()
  const db = c.env.DB
  await wageTable(db)
  const list = Array.isArray(body.rows) && body.rows.length ? body.rows : [body]
  if (list.length > 60) return c.json({ error: '一次最多记 60 条，多了分两次' }, 400)
  const okList = []
  const errs = []
  for (let i = 0; i < list.length; i++) {
    const it = list[i] || {}
    const worker = String(it.worker || '').trim()
    if (!worker) { errs.push(`第 ${i + 1} 条没填工人`); continue }
    const day = String(it.date || todayIso()).slice(0, 10)
    const mm = day.slice(0, 7)
    if (await isMonthLocked(db, mm)) { errs.push(`第 ${i + 1} 条：${mm} 已结账锁定，先解锁`); continue }
    const qty = num(it.qty, 1)
    if (qty <= 0) { errs.push(`第 ${i + 1} 条件数要大于 0`); continue }
    let rate = num(it.rate)
    if (!rate) {
      const rt = await wageRateOf(db, worker, String(it.item || ''), String(it.process || ''))
      rate = rt ? num(rt.rate) : 0
    }
    if (!rate) { errs.push(`第 ${i + 1} 条：没填单价，也找不到 ${worker} 的单价，去「单价表」加一条`); continue }
    const amount = Math.round(qty * rate * 100) / 100
    await db.prepare('INSERT INTO wage_records (worker, date, month, order_id, item, process, qty, rate, amount, note, by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(worker, day, mm, num(it.order_id), String(it.item || ''), String(it.process || ''), qty, rate, amount, String(it.note || ''), act(c), now()).run()
    okList.push({ worker, date: day, amount })
  }
  if (!okList.length) return c.json({ error: errs.join('；') || '没记上' }, 400)
  const sum = okList.reduce((s, r) => s + r.amount, 0)
  await logAudit(db, '记工', okList[0].worker, `${okList.length} 条，合计 ¥${Math.round(sum * 100) / 100}`, '', act(c))
  return c.json({ ok: true, added: okList.length, total: Math.round(sum * 100) / 100, errors: errs })
})

app.delete('/wage-records/:id', async (c) => {
  const db = c.env.DB
  await wageTable(db)
  const id = num(c.req.param('id'))
  const row = await db.prepare('SELECT * FROM wage_records WHERE id=?').bind(id).first()
  if (!row) return c.json({ error: '这条记工找不到了' }, 404)
  if (await isMonthLocked(db, String(row.month || ''))) return c.json({ error: '该月份已结账锁定，先解锁再改' }, 403)
  await db.prepare('DELETE FROM wage_records WHERE id=?').bind(id).run()
  await logAudit(db, '删记工', row.worker, `${row.date} ${row.qty}×${row.rate}=${row.amount}`, '', act(c))
  return c.json({ ok: true })
})

// 月底工资表：每人应发多少、已发多少、还差多少
async function payrollOf(db, mm) {
  const { results: recs } = await db.prepare('SELECT worker, SUM(qty) q, SUM(amount) a, COUNT(*) n FROM wage_records WHERE month=? GROUP BY worker ORDER BY a DESC').bind(mm).all()
  const { results: pays } = await db.prepare('SELECT worker, SUM(amount) a FROM wage_pays WHERE month=? GROUP BY worker').bind(mm).all()
  const payMap = {}
  for (const p of pays || []) payMap[p.worker] = num(p.a)
  const { results: loans } = await db.prepare('SELECT staff, SUM(amount-COALESCE(used,0)-COALESCE(returned,0)) a FROM loans GROUP BY staff').all()
  const loanMap = {}
  for (const l of loans || []) if (num(l.a) > 0.005) loanMap[l.staff] = num(l.a)
  const rows = (recs || []).map((r) => {
    const due = Math.round(num(r.a) * 100) / 100
    const paid = Math.round((payMap[r.worker] || 0) * 100) / 100
    return {
      worker: r.worker, qty: num(r.q), cnt: num(r.n), due,
      paid, left: Math.round((due - paid) * 100) / 100,
      advance: Math.round((loanMap[r.worker] || 0) * 100) / 100
    }
  })
  const total = rows.reduce((s, r) => s + r.due, 0)
  const paidTotal = rows.reduce((s, r) => s + r.paid, 0)
  return { month: mm, rows, total: Math.round(total * 100) / 100, paid_total: Math.round(paidTotal * 100) / 100, left_total: Math.round((total - paidTotal) * 100) / 100, people: rows.length }
}

app.get('/payroll', async (c) => {
  const db = c.env.DB
  await wageTable(db)
  const mm = String(c.req.query('month') || now().slice(0, 7))
  const p = await payrollOf(db, mm)
  const locked = await isMonthLocked(db, mm)
  const unpaid = p.rows.filter((r) => r.left > 0.005)
  const text = !p.rows.length
    ? `${mm} 还没有记工记录。先在下面「记一笔工」填：今天谁、干了什么活、多少件。`
    : `${mm} ${p.people} 人记工，应发 ¥${p.total}，已发 ¥${p.paid_total}，还差 ¥${p.left_total}` + (unpaid.length ? `（${unpaid.map((r) => r.worker).join('、')} 还没发完）` : '，都发完了 ✓')
  return c.json({ ok: true, ...p, locked, unpaid_cnt: unpaid.length, text })
})

// 发工资：写一笔现金支出（ref_type='wage'），并记到工资表
app.post('/payroll/pay', async (c) => {
  const body = await c.req.json()
  const db = c.env.DB
  await wageTable(db)
  const mm = String(body.month || now().slice(0, 7))
  if (await isMonthLocked(db, mm)) return c.json({ error: `${mm} 已结账锁定，先解锁再发工资` }, 403)
  const workers = Array.isArray(body.workers) && body.workers.length ? body.workers.map(String) : (body.worker ? [String(body.worker)] : [])
  if (!workers.length) return c.json({ error: '要发谁的工资' }, 400)
  const day = String(body.date || todayIso()).slice(0, 10)
  const acc = num(body.account_id) || (await defaultAccountId(db))
  const done = []
  for (const w of workers) {
    const { results: recs } = await db.prepare('SELECT SUM(amount) a FROM wage_records WHERE month=? AND worker=?').bind(mm, w).all()
    const due = Math.round(num(recs && recs[0] && recs[0].a) * 100) / 100
    const { results: pays } = await db.prepare('SELECT SUM(amount) a FROM wage_pays WHERE month=? AND worker=?').bind(mm, w).all()
    const paid = num(pays && pays[0] && pays[0].a)
    const left = Math.round((due - paid) * 100) / 100
    if (left <= 0.005) continue
    const amt = body.amount && workers.length === 1 ? Math.min(num(body.amount), left) : left
    if (amt <= 0) continue
    await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, operator, account_id, cash, created_at) VALUES ('out','expense',0,?,'工资',?,?,?,1,?)")
      .bind(amt, `${w} ${mm} 计件工资`, act(c), acc, stampOf(day)).run()
    await db.prepare('INSERT INTO wage_pays (month, worker, amount, account_id, note, by, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(mm, w, amt, acc, String(body.note || ''), act(c), stampOf(day)).run()
    done.push({ worker: w, amount: amt })
  }
  if (!done.length) return c.json({ error: '这几个人这个月的工资都已经发过了' }, 400)
  const sum = done.reduce((s, d) => s + d.amount, 0)
  await logAudit(db, '发工资', done.map((d) => d.worker).join('、'), `${mm} 共 ¥${Math.round(sum * 100) / 100}`, '', act(c))
  return c.json({ ok: true, paid: done, total: Math.round(sum * 100) / 100 })
})

app.get('/payroll-link', async (c) => {
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  const mm = String(c.req.query('month') || now().slice(0, 7))
  const base = new URL(c.req.url).origin
  const t = await sigOf(saved, 'payroll', 'wage:' + mm)
  return c.json({ ok: true, month: mm, url: `${base}/payroll-print?month=${mm}&t=${t}` })
})

app.get('/payroll-print', async (c) => {
  const db = c.env.DB
  await wageTable(db)
  const mm = String(c.req.query('month') || now().slice(0, 7))
  const t = String(c.req.query('t') || '')
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  const good = t && t === (await sigOf(saved, 'payroll', 'wage:' + mm))
  if (!good) return c.html(a4Page({ title: '链接已失效', body: '<h1>链接已失效</h1><p>工资单链接是绑月份的，月份变了或链接被改过就打不开了。回小程序重新点「打工资单」。</p>' }))
  const p = await payrollOf(db, mm)
  const head = await getTitle(db)
  const money = (n) => Number(n || 0).toFixed(2)
  const trs = p.rows.map((r) => `<tr><td>${escHtml(r.worker)}</td><td class="n">${r.cnt}</td><td class="n">${r.qty}</td><td class="n">${money(r.due)}</td><td class="n">${money(r.advance)}</td><td class="n">${money(r.paid)}</td><td class="n">${money(r.left)}</td><td class="sign-cell"></td></tr>`).join('')
  const pageBody = `<h1>计件工资表</h1>
<div class="meta"><span>${escHtml(head.title || '')}</span><span>月份：${mm}</span><span>人数：${p.people}</span></div>
<table><thead><tr><th>工人</th><th class="n">笔数</th><th class="n">件数</th><th class="n">应发</th><th class="n">未还借支</th><th class="n">已发</th><th class="n">还差</th><th>签字</th></tr></thead>
<tbody>${trs || '<tr><td colspan="8">这个月没有记工记录</td></tr>'}</tbody>
<tfoot><tr class="total"><td>合计</td><td class="n">${p.rows.reduce((s, r) => s + r.cnt, 0)}</td><td class="n">${p.rows.reduce((s, r) => s + r.qty, 0)}</td><td class="n">${money(p.total)}</td><td></td><td class="n">${money(p.paid_total)}</td><td class="n">${money(p.left_total)}</td><td></td></tr></tfoot></table>
<p class="tip">算法：应发 = 本月每笔记工（件数 × 单价）之和；已发 = 本月发工资记的支出；还差 = 应发 − 已发。未还借支另列，发工资时可商量从里面扣。</p>`
  return c.html(a4Page({ title: `${mm} 计件工资表`, body: pageBody, sign: '<span>制表人</span><span>发款人</span><span>日期</span>' }))
})

// 这周的钱够不够付：未来 N 天要付的 vs 账上现金 + 该收的
app.get('/cash-forecast', async (c) => {
  const db = c.env.DB
  const days = Math.min(60, Math.max(3, Math.round(num(c.req.query('days'), 14))))
  const today = todayIso()
  const to = addDaysIso(today, days)
  const ago90 = addDaysIso(today, -90)
  const P = (sql, ...b) => db.prepare(sql).bind(...b).first().catch((e) => { noteFail(e, '现金预测'); return null })
  const PA = (sql, ...b) => db.prepare(sql).bind(...b).all().catch((e) => { noteFail(e, '现金预测'); return { results: [] } })
  const [accs, arDue, apDue, arTop, apTop, recent] = await Promise.all([
    accountBalances(db).catch(() => []),
    P(`SELECT COUNT(*) n, COALESCE(SUM(price - COALESCE(paid,0) - COALESCE(written_off,0)),0) t FROM orders
        WHERE COALESCE(paid,0)+COALESCE(written_off,0) < price AND substr(COALESCE(due_date,''),1,10) BETWEEN ? AND ?`, today, to),
    P(`SELECT COUNT(*) n, COALESCE(SUM(amount - COALESCE(paid,0) - COALESCE(written_off,0)),0) t FROM payables
        WHERE COALESCE(paid,0)+COALESCE(written_off,0) < amount AND substr(COALESCE(due_date,''),1,10) BETWEEN ? AND ?`, today, to),
    PA(`SELECT customer party, (price - COALESCE(paid,0) - COALESCE(written_off,0)) left_amt, substr(due_date,1,10) due
        FROM orders WHERE COALESCE(paid,0)+COALESCE(written_off,0) < price AND substr(COALESCE(due_date,''),1,10) BETWEEN ? AND ?
        ORDER BY left_amt DESC LIMIT 5`, today, to),
    PA(`SELECT supplier party, (amount - COALESCE(paid,0) - COALESCE(written_off,0)) left_amt, substr(due_date,1,10) due
        FROM payables WHERE COALESCE(paid,0)+COALESCE(written_off,0) < amount AND substr(COALESCE(due_date,''),1,10) BETWEEN ? AND ?
        ORDER BY left_amt DESC LIMIT 5`, today, to),
    PA(`SELECT direction, COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND substr(created_at,1,10) >= ? GROUP BY direction`, ago90)
  ])
  const noDue = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM orders WHERE COALESCE(paid,0)+COALESCE(written_off,0) < price AND (due_date IS NULL OR due_date = '')) ar_n,
      (SELECT COALESCE(SUM(price - COALESCE(paid,0) - COALESCE(written_off,0)),0) FROM orders WHERE COALESCE(paid,0)+COALESCE(written_off,0) < price AND (due_date IS NULL OR due_date = '')) ar_t,
      (SELECT COUNT(*) FROM payables WHERE COALESCE(paid,0)+COALESCE(written_off,0) < amount AND (due_date IS NULL OR due_date = '')) ap_n,
      (SELECT COALESCE(SUM(amount - COALESCE(paid,0) - COALESCE(written_off,0)),0) FROM payables WHERE COALESCE(paid,0)+COALESCE(written_off,0) < amount AND (due_date IS NULL OR due_date = '')) ap_t`).first().catch(() => null)
  const cash = round2((accs || []).reduce((a, x) => a + num(x.balance), 0))
  const arT = round2(num(arDue && arDue.t))
  const apT = round2(num(apDue && apDue.t))
  const inT = round2(((recent.results || []).find((x) => x.direction === 'in') || {}).t)
  const outT = round2(((recent.results || []).find((x) => x.direction === 'out') || {}).t)
  const dailyNet = round2((inT - outT) / 90)
  const optimistic = round2(cash + arT - apT)
  const safe = round2(cash - apT)
  const rows = [
    { k: 'cash', label: '现在账上现金', amount: cash, note: (accs || []).length ? (accs || []).map((a) => a.name + ' ' + a.balance).join('、') : '还没记账户' },
    { k: 'ar', label: days + ' 天内该收（' + num(arDue && arDue.n) + ' 笔）', amount: arT, note: '按约定日期能到账的话' },
    { k: 'ap', label: days + ' 天内该付（' + num(apDue && apDue.n) + ' 笔）', amount: apT, note: '房租、工资、材料款都算' },
    { k: 'safe', label: '就算一分钱收不回，够不够付', amount: safe, note: safe >= 0 ? '够，余 ' + round2(safe) + ' 元' : '差 ' + round2(-safe) + ' 元' },
    { k: 'opt', label: '应收都按时到账的话', amount: optimistic, note: optimistic >= 0 ? '够，余 ' + round2(optimistic) + ' 元' : '还差 ' + round2(-optimistic) + ' 元' }
  ]
  let advice = ''
  if (!cash && !arT && !apT) advice = '这几天没有要收要付的款，账上现金 ' + cash + ' 元。'
  else if (safe < 0) {
    const t0 = (apTop.results || [])[0]
    const a0 = (arTop.results || [])[0]
    advice = '这 ' + days + ' 天要付 ' + apT + ' 元，账上只有 ' + cash + ' 元，差 ' + round2(-safe) + ' 元。'
    if (a0) advice += '先把 ' + a0.party + ' 的 ' + round2(num(a0.left_amt)) + ' 元催回来（' + a0.due + ' 到期）。'
    if (t0) advice += '实在来不及，和 ' + t0.party + ' 说一声晚几天付。'
  } else if (optimistic < 0) {
    advice = '账上够付，但要把该收的 ' + arT + ' 元收回来才周转得开——现在账上 ' + cash + ' 元，要付 ' + apT + ' 元。'
  } else {
    advice = '这 ' + days + ' 天的钱够用：账上 ' + cash + ' 元，要付 ' + apT + ' 元，还要收 ' + arT + ' 元。'
  }
  const ndArN = num(noDue && noDue.ar_n)
  const ndApN = num(noDue && noDue.ap_n)
  const ndArT = round2(num(noDue && noDue.ar_t))
  const ndApT = round2(num(noDue && noDue.ap_t))
  const noDueNote = (ndArN || ndApN) ? '另有没约定日期的欠款' + (ndArN ? '：客户欠 ' + ndArT + ' 元（' + ndArN + ' 笔）' : '') + (ndApN ? '：欠供应商 ' + ndApT + ' 元（' + ndApN + ' 笔）' : '') + '，想排进计划就给这些单补个到期日。' : ''
  const text = '【这 ' + days + ' 天的钱够不够】\n账上现金 ¥' + cash + '\n' + days + ' 天内该收 ¥' + arT + '，该付 ¥' + apT + '\n' + advice + (noDueNote ? '\n' + noDueNote : '') + (dailyNet ? '\n（近 90 天平均每天净流入 ¥' + dailyNet + '）' : '')
  return c.json({ ok: true, days, today, cash, ar_due: arT, ap_due: apT, ar_no_due: ndArT, ap_no_due: ndApT, ar_no_due_n: ndArN, ap_no_due_n: ndApN, no_due_note: noDueNote, safe, optimistic, daily_net: dailyNet, ar_n: num(arDue && arDue.n), ap_n: num(apDue && apDue.n), ar_top: arTop.results || [], ap_top: apTop.results || [], rows, advice, text })
})

// 老客户是不是跑了：按「这家自己多久下一单」判断，不是一刀切 30 天
app.get('/churn-risk', async (c) => {
  const db = c.env.DB
  const days = Math.min(365, Math.max(15, Math.round(num(c.req.query('days'), 60))))
  const today = todayIso()
  const list = (await db.prepare(`SELECT customer party, COUNT(*) cnt, COALESCE(SUM(price),0) income,
      MIN(substr(created_at,1,10)) first_day, MAX(substr(created_at,1,10)) last_day
    FROM orders GROUP BY customer`).all().catch((e) => { noteFail(e, '流失预警'); return { results: [] } })).results || []
  const lastItems = {}
  const li = (await db.prepare(`SELECT customer, item_name, price, substr(created_at,1,10) d FROM orders ORDER BY id DESC LIMIT 600`).all().catch(() => ({ results: [] }))).results || []
  for (const r of li) if (!lastItems[r.customer]) lastItems[r.customer] = r
  const rows = []
  for (const r of list) {
    const cnt = num(r.cnt)
    if (cnt < 2) continue
    const gapDays = Math.max(1, Math.round((dateNum(r.last_day) - dateNum(r.first_day)) / 1000 / 86400))
    const avgGap = Math.max(1, Math.round(gapDays / (cnt - 1)))
    const since = daysSince(r.last_day)
    const limit = Math.max(days, avgGap * 2)
    if (since < limit) continue
    const level = since >= avgGap * 3 ? 'high' : 'mid'
    const li0 = lastItems[r.party] || {}
    rows.push({
      party: r.party, cnt, income: round2(num(r.income)), last_day: r.last_day, days_since: since,
      avg_gap: avgGap, limit, level,
      last_item: li0.item_name || '', last_price: round2(num(li0.price)),
      text: (r.party || '老板') + '，上次给您的' + (li0.item_name ? '「' + li0.item_name + '」' : '那批货') + '用得还顺吗？下批大概什么时候要？我这边好给您留工期。'
    })
  }
  rows.sort((a, b) => b.days_since - a.days_since)
  const high = rows.filter((r) => r.level === 'high').length
  const incomeAtRisk = round2(rows.reduce((a, r) => a + r.income, 0))
  return c.json({
    ok: true, days, count: rows.length, high, income_at_risk: incomeAtRisk, rows: rows.slice(0, 40),
    advice: rows.length
      ? '有 ' + rows.length + ' 家老客户超过他们自己的下单间隔没再来（其中 ' + high + ' 家拖得最久），累计做过 ' + incomeAtRisk + ' 元的活。挑最久的那两三个，用下面的话术问一句就行——不催钱，只问下批什么时候要。'
      : '老客户都在正常下单节奏里，没有需要特别问的。',
    text: rows.length
      ? '【老客户提醒】' + rows.length + ' 家超过自己下单间隔没来：' + rows.slice(0, 5).map((r) => r.party + '（' + r.days_since + ' 天）').join('、') + '。'
      : '【老客户提醒】都在正常节奏里，没有该问的。'
  })
})

// 批量发对账单：一次列出「谁还欠我 / 我还欠谁」，每家一段现成话术 + 打印页链接
app.get('/statement-batch', async (c) => {
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const db = c.env.DB
  const type = String(c.req.query('type') || 'ar') === 'ap' ? 'ap' : 'ar'
  const month = /^\d{4}-\d{2}$/.test(String(c.req.query('month') || '')) ? String(c.req.query('month')) : now().slice(0, 7)
  const saved = await getKey(mainDb)
  const base = new URL(c.req.url).origin
  const isAr = type === 'ar'
  const sql = isAr
    ? "SELECT customer AS party, COUNT(*) n, COALESCE(SUM(price - paid - COALESCE(written_off,0)),0) left_amt, MIN(due_date) first_due, MIN(created_at) first_day, MIN(substr(created_at,1,10)) oldest FROM orders WHERE price > paid + COALESCE(written_off,0) GROUP BY customer"
    : "SELECT supplier AS party, COUNT(*) n, COALESCE(SUM(amount - paid - COALESCE(written_off,0)),0) left_amt, MIN(due_date) first_due, MIN(created_at) first_day, MIN(substr(created_at,1,10)) oldest FROM payables WHERE amount > paid + COALESCE(written_off,0) GROUP BY supplier"
  const [aggR, mNewR, sentR] = await Promise.all([
    db.prepare(sql).all().catch((e) => { noteFail(e, '批量对账单'); return { results: [] } }),
    (isAr
      ? db.prepare("SELECT customer AS party, COALESCE(SUM(price),0) t FROM orders WHERE substr(created_at,1,7)=? GROUP BY customer")
      : db.prepare("SELECT supplier AS party, COALESCE(SUM(amount),0) t FROM payables WHERE substr(created_at,1,7)=? GROUP BY supplier")
    ).bind(month).all().catch(() => ({ results: [] })),
    db.prepare("SELECT party, COUNT(*) n, MAX(substr(created_at,1,10)) last FROM statement_log WHERE type=? AND substr(created_at,1,7)=? GROUP BY party").bind(type, month).all().catch(() => ({ results: [] }))
  ])
  const sentMap = {}
  for (const r of ((sentR && sentR.results) || [])) sentMap[norm(r.party)] = { times: num(r.n), last: r.last }
  const newMap = {}
  for (const r of ((mNewR && mNewR.results) || [])) newMap[r.party] = num(r.t)
  const today = now().slice(0, 10)
  const rows = []
  for (const r of ((aggR && aggR.results) || [])) {
    const left = round2(num(r.left_amt))
    if (left <= 0.005) continue
    const due = r.first_due ? String(r.first_due).slice(0, 10) : ''
    const over = due && due < today ? daysSince(due) : 0
    const t = saved ? await sigOf(saved, r.party, type) : ''
    const url = t ? base + '/statement-print?type=' + type + '&party=' + encodeURIComponent(r.party || '') + '&t=' + t : ''
    const newAmt = round2(num(newMap[r.party]))
    const lines = isAr
      ? [`${r.party}，对一下账：`,
         `到 ${today}，还有 ${num(r.n)} 笔加工费没结，共 ${left} 元。`,
         newAmt > 0 ? `其中 ${month} 月新做 ${newAmt} 元。` : '',
         over > 0 ? `最早一笔已超期 ${over} 天，麻烦安排一下。` : '',
         '明细我发你对账单，有对不上的地方跟我说，我改。']
      : [`${r.party}，对一下账：`,
         `到 ${today}，还有 ${num(r.n)} 笔货款没付，共 ${left} 元。`,
         newAmt > 0 ? `其中 ${month} 月新增 ${newAmt} 元。` : '',
         over > 0 ? `最早一笔已到期 ${over} 天。` : '',
         '麻烦确认一下金额，有出入我这边改。']
    const sent = sentMap[norm(r.party)] || { times: 0, last: '' }
    rows.push({ party: r.party, left, cnt: num(r.n), month_new: newAmt, due, overdue_days: over,
      sent_times: sent.times, sent_last: sent.last, sent_this_month: sent.times > 0,
      url, text: lines.filter(Boolean).join('\n') })
  }
  rows.sort((a, b) => b.left - a.left)
  const total = round2(rows.reduce((s, x) => s + x.left, 0))
  const allText = rows.length
    ? (isAr ? `【对账提醒】到 ${today}，共 ${rows.length} 家还欠加工费，合计 ${total} 元：\n` : `【对账提醒】到 ${today}，共 ${rows.length} 家还欠货款，合计 ${total} 元：\n`)
      + rows.map((x) => `${x.party}：${x.left} 元（${x.cnt} 笔${x.overdue_days ? `，最早超 ${x.overdue_days} 天` : ''}）`).join('\n')
    : (isAr ? '没有欠加工费的客户，账是清的。' : '没有欠货款的供应商，账是清的。')
  const unsent = rows.filter((x) => !x.sent_this_month)
  const unsentTotal = round2(unsent.reduce((s2, x) => s2 + x.left, 0))
  const sentNote = rows.length
    ? `${month} 已发 ${rows.length - unsent.length} 家，还没发 ${unsent.length} 家${unsent.length ? `（欠 ${unsentTotal} 元）` : ''}`
    : ''
  return c.json({ ok: true, type, month, count: rows.length, total, rows, all_text: allText,
    sent_count: rows.length - unsent.length, unsent_count: unsent.length, unsent_total: unsentTotal, sent_note: sentNote })
})

app.get('/statement-link', async (c) => {
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  const party = String(c.req.query('party') || '').trim()
  const type = String(c.req.query('type') || 'ar') === 'ap' ? 'ap' : 'ar'
  if (!party) return c.json({ error: '缺少对账单位' }, 400)
  const t = await sigOf(saved, party, type)
  const base = new URL(c.req.url).origin
  const url = base + '/statement-print?type=' + type + '&party=' + encodeURIComponent(party) + '&t=' + t
  return c.json({ ok: true, url })
})

// A4 打印版对账单（电脑/手机浏览器打开 → Ctrl+P / 分享打印）
// 客户进度页：一条只读链接，客户在微信里点开就能看自己的单做到哪了（不用登录）
app.get('/track-link', async (c) => {
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  const party = String(c.req.query('party') || '').trim()
  if (!party) return c.json({ error: '缺少客户名' }, 400)
  const t = await sigOf(saved, party, 'track')
  const base = new URL(c.req.url).origin
  return c.json({ ok: true, url: base + '/track?party=' + encodeURIComponent(party) + '&t=' + t })
})

app.get('/track', async (c) => {
  const db = c.env.DB
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  const party = String(c.req.query('party') || '').trim()
  const want = String(c.req.query('t') || '')
  const good = saved && party ? await sigOf(saved, party, 'track') : ''
  if (!good || want !== good) return c.html('<meta name="viewport" content="width=device-width,initial-scale=1"><div style="padding:24px;font-size:16px;line-height:1.8">链接已失效：请让对方在小程序里重新发一次进度链接。</div>')
  const t = await getTitle(db)
  const docs = await db.prepare('SELECT * FROM orders WHERE customer=? ORDER BY id DESC LIMIT 40').bind(party).all().then((r) => r.results)
  const ids = docs.map((d) => d.id)
  let pays = [], procs = []
  if (ids.length) {
    const ph = ids.map(() => '?').join(',')
    pays = await db.prepare("SELECT * FROM ledger WHERE ref_type='order' AND ref_id IN (" + ph + ')').bind(...ids).all().then((r) => r.results).catch(() => [])
    procs = await db.prepare("SELECT * FROM process_log WHERE order_id IN (" + ph + ') ORDER BY id DESC').bind(...ids).all().then((r) => r.results).catch(() => [])
  }
  const today = now().slice(0, 10)
  const paidOf = (d) => pays.filter((p) => p.ref_id === d.id).reduce((a, p) => a + num(p.amount), 0)
  const totalOpen = docs.reduce((a, d) => a + Math.max(0, num(d.price) - paidOf(d) - num(d.written_off)), 0)
  const totalAll = docs.reduce((a, d) => a + num(d.price), 0)
  const totalPaid = docs.reduce((a, d) => a + paidOf(d), 0)
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]))
  const dnum = (a, b) => {
    const da = new Date(String(a || '').slice(0, 10) + 'T00:00:00Z'), db2 = new Date(String(b || '').slice(0, 10) + 'T00:00:00Z')
    return Math.round((db2 - da) / 86400000)
  }
  const rows = docs.map((d) => {
    const paid = paidOf(d), left = Math.max(0, num(d.price) - paid - num(d.written_off))
    const due = String(d.due_date || '').slice(0, 10)
    let late = ''
    if (left > 0 && due && dnum(due, today) > 0) late = '<span style="color:#c0392b">超 ' + dnum(due, today) + ' 天</span>'
    const lastP = procs.find((x) => x.order_id === d.id)
    // status 存的是 0/1/2，不能直接显示数字
    const ST = ['待加工', '加工中', '已交付']
    const st = esc(ST[num(d.status)] || '待加工')
    const prog = lastP ? '<br><span style="color:#888;font-size:13px">' + esc(String(lastP.created_at || '').slice(5, 10)) + ' ' + esc(lastP.progress || '') + '</span>' : ''
    return '<tr><td>' + esc(String(d.created_at || '').slice(5, 10)) + '</td><td>' + esc(d.item_name || '加工') +
      '<br><span style="color:#2d6cdf;font-size:13px">' + st + '</span>' + prog + '</td>' +
      '<td style="text-align:right">' + num(d.price) + (paid ? '<br><span style="color:#888;font-size:13px">已收 ' + paid + '</span>' : '') +
      (left ? '<br><span style="color:#c0392b">未收 ' + round2(left) + ' ' + late + '</span>' : '<br><span style="color:#27ae60">已结清</span>') +
      '</td></tr>'
  }).join('')
  // 收款记录（对方最想自己核对的就是这个）
  const payRows = pays.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 30).map((p2) => {
    const doc = docs.find((d) => d.id === p2.ref_id)
    return '<tr><td>' + esc(String(p2.created_at || '').slice(5, 10)) + '</td><td>' + esc((doc && doc.item_name) || '加工费') +
      (p2.remark ? '<br><span style="color:#888;font-size:13px">' + esc(String(p2.remark).slice(0, 24)) + '</span>' : '') +
      '</td><td style="text-align:right">¥' + round2(num(p2.amount)) + '</td></tr>'
  }).join('')
  // 本月对账结论（期初 + 新增 − 已收 − 核销 = 期末）
  let concl = null
  try { concl = await conclusionOf(db, 'ar', party, now().slice(0, 7)) } catch (e) { concl = null }
  const conclHtml = concl ? '<div class="card"><div class="sub">本月对账（' + esc(concl.month) + '）</div>' +
    '<table><tr><td>期初欠</td><td style="text-align:right">¥' + round2(concl.open) + '</td></tr>' +
    '<tr><td>本月新做（' + concl.add_cnt + ' 笔）</td><td style="text-align:right">¥' + round2(concl.add) + '</td></tr>' +
    '<tr><td>本月已付（' + concl.paid_cnt + ' 笔）</td><td style="text-align:right">−¥' + round2(concl.paid) + '</td></tr>' +
    (concl.wo > 0 ? '<tr><td>已核销</td><td style="text-align:right">−¥' + round2(concl.wo) + '</td></tr>' : '') +
    '<tr><td><b>期末欠</b></td><td style="text-align:right"><b style="color:#c0392b">¥' + round2(concl.end) + '</b></td></tr></table>' +
    '<div class="sub" style="margin-top:6px">数字对不上就直接打电话，别憋着。</div></div>' : ''
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(t.title || '') + ' 对账明细</title><style>body{margin:0;background:#f4f5f7;font-family:-apple-system,"PingFang SC",sans-serif;color:#222}' +
    '.wrap{max-width:640px;margin:0 auto;padding:14px}.card{background:#fff;border-radius:10px;padding:14px;margin-bottom:10px}' +
    'h1{font-size:17px;margin:0 0 4px}.sub{color:#888;font-size:13px}.big{font-size:26px;font-weight:700;color:#c0392b}' +
    'table{width:100%;border-collapse:collapse;font-size:14px}td{padding:8px 4px;border-bottom:1px solid #eee;vertical-align:top}' +
    '.foot{color:#999;font-size:12px;text-align:center;padding:10px 0 24px}</style></head><body><div class="wrap">' +
    '<div class="card"><h1>' + esc(party) + ' · 对账明细</h1><div class="sub">' + esc(t.title || '') + (t.phone ? ' · ' + esc(t.phone) : '') + '　更新于 ' + today + '</div></div>' +
    '<div class="card"><div class="sub">还没收的钱</div><div class="big">¥' + round2(totalOpen) + '</div>' +
    '<div class="sub">共 ' + docs.length + ' 单 · 合计 ¥' + round2(totalAll) + ' · 已收 ¥' + round2(totalPaid) + '</div></div>' +
    conclHtml +
    '<div class="card"><div class="sub">每笔单据（做完了没、收了没）</div><table>' + (rows || '<tr><td>暂时没有单子</td></tr>') + '</table></div>' +
    '<div class="card"><div class="sub">收到的钱（自己核对一下）</div><table>' + (payRows || '<tr><td>还没有收款记录</td></tr>') + '</table></div>' +
    '<div class="foot">这是一条只读链接，只能看这一家，看不到别人、也不能改账。' +
    (t.phone ? '<br><a href="tel:' + esc(t.phone) + '" style="color:#2d6cdf">有疑问打 ' + esc(t.phone) + '</a>' : '') +
    '<br>' + esc(t.title || '') + (t.addr ? ' · ' + esc(t.addr) : '') + '</div></div></body></html>'
  // 留痕：谁什么时候看过
  const ua = String(c.req.header('user-agent') || '').slice(0, 60)
  await db.prepare('INSERT INTO track_log (party, ua, created_at) VALUES (?,?,?)').bind(party, ua, now()).run().catch(() => {})
  return c.html(html)
})

app.get('/track-log', async (c) => {
  const db = c.env.DB
  const party = String(c.req.query('party') || '').trim()
  const rows = party
    ? await db.prepare('SELECT * FROM track_log WHERE party=? ORDER BY id DESC LIMIT 20').bind(party).all().then((r) => r.results)
    : await db.prepare('SELECT * FROM track_log ORDER BY id DESC LIMIT 50').all().then((r) => r.results)
  const agg = await db.prepare('SELECT party, COUNT(*) c, MAX(created_at) last FROM track_log GROUP BY party ORDER BY last DESC LIMIT 30').all().then((r) => r.results)
  return c.json({ ok: true, rows, by_party: agg })
})


// ===== 账本交接包：换人管账时，一页说清「这本账怎么记的、还欠谁、接手怎么用」=====
async function handoverData(db, env) {
  const t = await getTitle(db)
  const today = now().slice(0, 10)
  const q = (sql, ...b) => db.prepare(sql).bind(...b).all().catch(() => ({ results: [] }))
  const f = (sql, ...b) => db.prepare(sql).bind(...b).first().catch(() => null)
  const [arF, apF, arTop, apTop, profs, accs, terms, reconF, doubtF, noDueF, invF, advR, loanF, noteF, nw] = await Promise.all([
    f("SELECT COUNT(*) cnt, COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) amt, MIN(created_at) oldest FROM orders WHERE price > paid + COALESCE(written_off,0)"),
    f("SELECT COUNT(*) cnt, COALESCE(SUM(amount-paid-COALESCE(written_off,0)),0) amt, MIN(created_at) oldest FROM payables WHERE amount > paid + COALESCE(written_off,0)"),
    q("SELECT customer AS party, COUNT(*) n, COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) amt, MIN(created_at) oldest, MAX(due_date) due FROM orders WHERE price > paid + COALESCE(written_off,0) GROUP BY customer ORDER BY amt DESC LIMIT 5"),
    q("SELECT supplier AS party, COUNT(*) n, COALESCE(SUM(amount-paid-COALESCE(written_off,0)),0) amt, MIN(created_at) oldest, MAX(due_date) due FROM payables WHERE amount > paid + COALESCE(written_off,0) GROUP BY supplier ORDER BY amt DESC LIMIT 5"),
    q('SELECT party, contact, phone, addr FROM party_profiles'),
    accountBalances(db),
    q("SELECT party, kind, term_days, recon_day, recon_cycle FROM party_terms ORDER BY party LIMIT 40"),
    f("SELECT COUNT(*) n FROM recon_log WHERE done=0 AND COALESCE(state,'')<>'match'"),
    f("SELECT COUNT(*) n FROM statement_log WHERE ack='doubt' AND COALESCE(resolved_at,'')=''"),
    f("SELECT COUNT(*) n FROM (SELECT 1 FROM orders WHERE paid + COALESCE(written_off,0) < price AND (due_date IS NULL OR due_date='') UNION ALL SELECT 1 FROM payables WHERE paid + COALESCE(written_off,0) < amount AND (due_date IS NULL OR due_date=''))"),
    f("SELECT COALESCE(SUM(amount),0) amt, COUNT(*) cnt FROM invoices WHERE COALESCE(order_id,0) > 0"),
    q('SELECT type, COALESCE(SUM(amount-COALESCE(used,0)),0) amt, COUNT(*) cnt FROM advances WHERE amount - COALESCE(used,0) > 0.005 GROUP BY type'),
    f("SELECT COALESCE(SUM(amount - used - returned),0) amt, COUNT(*) cnt FROM loans WHERE amount - used - returned > 0.005"),
    f("SELECT value FROM settings WHERE key='handover_note'"),
    netNow(db)
  ])
  const pmap = {}
  for (const r of ((profs && profs.results) || [])) pmap[norm(r.party)] = r
  const adv = { in: 0, out: 0, cnt: 0 }
  for (const r of ((advR && advR.results) || [])) {
    if (r.type === 'in') adv.in = round2(num(r.amt)); else adv.out = round2(num(r.amt))
    adv.cnt += num(r.cnt)
  }
  const accList = accs || []
  const cashTotal = round2(accList.reduce((s, a) => s + num(a.balance), 0))
  const arAmt = round2(num(arF && arF.amt)), apAmt = round2(num(apF && apF.amt))
  // 三个账本各是干什么的
  const envAll = env || {}
  const books = []
  const bk = [{ id: '1', db: envAll.DB }, { id: '2', db: envAll.DB2 }, { id: '3', db: envAll.DB3 }]
  for (const b of bk) {
    if (!b.db) continue
    const nm = await b.db.prepare("SELECT value FROM settings WHERE key='book_name'").first().catch(() => null)
    const c1 = await b.db.prepare('SELECT COUNT(*) n FROM orders').first().catch(() => null)
    const c2 = await b.db.prepare('SELECT COUNT(*) n FROM ledger').first().catch(() => null)
    books.push({ id: b.id, name: (nm && nm.value) || ('账本' + b.id), orders: num(c1 && c1.n), flows: num(c2 && c2.n) })
  }
  const rowLine = (r, isAr) => {
    const p = pmap[norm(r.party)] || {}
    const d = daysSince(r.oldest)
    return `${r.party}：${isAr ? '欠' : '应付'} ¥${round2(num(r.amt))}（${num(r.n)} 笔${d ? '，最久 ' + d + ' 天' : ''}）${p.phone ? ' 电话 ' + p.phone : ''}${p.contact ? ' 对接 ' + p.contact : ''}`
  }
  const sections = []
  sections.push({ title: '一、这本账是什么', lines: [
    `厂名：${t.title}${t.phone ? '　电话 ' + t.phone : ''}${t.addr ? '　地址 ' + t.addr : ''}`,
    `当前账本：${(books.find((b) => b.id === String(envAll.BOOK || '1')) || books[0] || {}).name || '账本1'}`,
    `这本账记的是：加工费应收（客户欠我）、供应商应付（我欠别人）、日常支出、收付款流水；不做生产工序与工资考勤。`,
    `赚了多少怎么算（口径）：本月接单额 − 单子上的材料·外协成本 − 现金费用（工资水电房租等）− 摊销 − 折旧 − 预提利息。赊购（应付）不算成本，等付钱时进现金流。`,
    books.length ? `一共 ${books.length} 本账（互相独立，顶部可切）：` + books.map((b) => `${b.name}（${b.orders} 张单 / ${b.flows} 笔流水）`).join('；') : ''
  ].filter(Boolean) })
  sections.push({ title: '二、现在账上有什么', lines: [
    `应收未收：${num(arF && arF.cnt)} 笔，共 ¥${arAmt}${arF && arF.oldest && daysSince(arF.oldest) > 0 ? '（最久一笔 ' + daysSince(arF.oldest) + ' 天前）' : ''}`,
    `应付未付：${num(apF && apF.cnt)} 笔，共 ¥${apAmt}${apF && apF.oldest && daysSince(apF.oldest) > 0 ? '（最久一笔 ' + daysSince(apF.oldest) + ' 天前）' : ''}`,
    `手头现金：¥${cashTotal}` + (accList.length ? '（' + accList.map((a) => `${a.name} ¥${round2(num(a.balance))}`).join('、') + '）' : ''),
    `借款（要还的）：¥${round2(num(nw.debt))}　预收款还没抵：¥${adv.in}　预付款还没到货：¥${adv.out}　员工借支没清：¥${round2(num(loanF && loanF.amt))}`,
    `净资产（现金 + 应收 − 应付 − 借款）：¥${round2(num(nw.net))}`,
    `已开发票：${num(invF && invF.cnt)} 张，共 ¥${round2(num(invF && invF.amt))}（发票只做台账，不影响收支与利润）`
  ] })
  const arTopR = (arTop && arTop.results) || []
  if (arTopR.length) sections.push({ title: '三、欠得最多的客户（先催这几家）', lines: arTopR.map((r) => rowLine(r, true)) })
  const apTopR = (apTop && apTop.results) || []
  if (apTopR.length) sections.push({ title: '四、要付出去的（按金额排）', lines: apTopR.map((r) => rowLine(r, false)) })
  const termR = (terms && terms.results) || []
  if (termR.length) sections.push({ title: '五、和客商约好的账期', lines: termR.map((r) => `${r.party}：${num(r.term_days) > 0 ? '做单后 ' + num(r.term_days) + ' 天到期' : '没设账期'}${num(r.recon_day) > 0 ? '，每月 ' + num(r.recon_day) + ' 号发对账单' : ''}`) })
  const todo = []
  if (num(reconF && reconF.n) > 0) todo.push(`有 ${num(reconF.n)} 条对账差异还没处理（记账 → 批量导入 → 对账台账）`)
  if (num(doubtF && doubtF.n) > 0) todo.push(`有 ${num(doubtF.n)} 份对账单对方说对不上，还没回（报表 → 争议清单）`)
  if (num(noDueF && noDueF.n) > 0) todo.push(`有 ${num(noDueF.n)} 张单没约定收付款日（设个默认账期就会自动算）`)
  if (!cashTotal && !accList.some((a) => num(a.opening))) todo.push('账户期初还是 0：把现在手头现金、银行卡余额填上（设置 → 资金账户）')
  const negAcc = accList.filter((a) => num(a.balance) < -0.005)
  if (negAcc.length) todo.push(`${negAcc.map((a) => a.name).join('、')} 余额是负的（${negAcc.map((a) => a.name + ' ¥' + round2(num(a.balance))).join('、')}）：多半是支出没挂账户、或期初忘了填，先核对一下（设置 → 资金账户）`)
  if (!noteF || !String(noteF.value || '').trim()) todo.push('还没写「交接备注」：谁对接供应商、有什么口头约定，写一句比什么都强')
  sections.push({ title: '六、还没办完的事', lines: todo.length ? todo : ['没有遗留问题，账是干净的。'] })
  sections.push({ title: '七、接手的人怎么用（照着做就行）', lines: [
    '1. 微信里打开小程序「小司记账」，第一次会让你设一个访问口令（自己记住；老板那台已设过的不用再设）。',
    '2. 先看首页「今天的活」：最上面那一条就是现在最该做的事，点一下就跳过去。',
    '3. 每天记完单再走人：应收（客户欠我）、应付（我欠供应商）、支出（现金花出去的）各记一笔，收钱付款在对应单据上点「收清」。',
    '4. 每周做两件事：欠得久的催一遍（首页「催款清单」有话术，发完自动记「已催」）、对账单发给欠款客户（报表 → 批量发对账单）。',
    '5. 每月月底走一遍「月底收尾」七步，最后点「结账归档」；结账后那个月的单就锁住了，要改先「解锁」。',
    '记错了：单据点进去改，或删掉（进回收站，30 天内能找回）；已经收过钱的单要先取消收款再改金额。',
    '换手机/换人：设置 → 备份与恢复，先「云端备份」一次，新手机输口令后「从备份恢复」。'
  ] })
  const note = String((noteF && noteF.value) || '').trim()
  if (note) sections.push({ title: '八、老板留的交接备注', lines: note.split('\n').filter(Boolean) })
  const head = `【${t.title}】账本交接包　生成于 ${today}`
  const text = [head, ''].concat(...sections.map((s) => [s.title].concat(s.lines.map((l) => '  ' + l)).concat(['']))) .join('\n')
  return { ok: true, title: t.title, today, sections, text, stats: { ar: arAmt, ar_cnt: num(arF && arF.cnt), ap: apAmt, ap_cnt: num(apF && apF.cnt), cash: cashTotal, net: round2(num(nw.net)), books: books.length } }
}

app.get('/handover', async (c) => {
  const d = await handoverData(c.env.DB, c.env)
  const saved = await getKey((c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB)
  const t = saved ? await sigOf(saved, 'handover', 'ho') : ''
  const base = new URL(c.req.url).origin
  return c.json({ ...d, url: t ? base + '/handover-print?t=' + t : '' })
})

app.post('/handover-note', async (c) => {
  const db = c.env.DB
  const b = await c.req.json().catch(() => ({}))
  const note = String(b.note || '').trim().slice(0, 2000)
  const old = await db.prepare("SELECT value FROM settings WHERE key='handover_note'").first().catch(() => null)
  if (note) {
    if (old) await db.prepare("UPDATE settings SET value=? WHERE key='handover_note'").bind(note).run()
    else await db.prepare("INSERT INTO settings (key, value) VALUES ('handover_note', ?)").bind(note).run()
  } else if (old) {
    await db.prepare("DELETE FROM settings WHERE key='handover_note'").run()
  }
  await logAudit(db, '改交接备注', '', note.slice(0, 40) || '（清空）', '', act(c))
  return c.json({ ok: true })
})

app.get('/handover-print', async (c) => {
  const db = c.env.DB
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  const want = String(c.req.query('t') || '')
  const good = saved ? await sigOf(saved, 'handover', 'ho') : ''
  if (!good || want !== good) return c.html('<h3>链接已失效：请在小程序里重新生成交接包。</h3>')
  const d = await handoverData(db, c.env)
  const esc = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = d.sections.map((s) => `<h2>${esc(s.title)}</h2><ul>${s.lines.map((l) => '<li>' + esc(l) + '</li>').join('')}</ul>`).join('')
  return c.html(a4Page({
    title: `账本交接包 ${d.today}`,
    body: `<h1>账本交接包</h1><div class="sub">生成于 ${esc(d.today)}　单位：${esc(d.title || '')}</div>${body}<div class="sub" style="margin-top:18px">这份说明是这本账的全部交接信息，接手的人照着第七段做就能上手。</div>`,
    extraCss: `h2{color:#0a4b8c;border-bottom:1px solid #e5e5e5;border-left:0;padding-left:0;padding-bottom:4px}
ul{margin:0 0 6px;padding-left:20px} li{margin:3px 0}`,
    sign: `<span>交出人：____________</span><span>接手人：____________</span><span>日期：____________</span>`,
    btn: '🖨 打印 / 存为 PDF',
  }))
})


// ===== 统一打印版式（对账单 / 月报 / 交接包 / 以后的任何 A4 页共用一套样式）=====
const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]))
const A4_CSS = `
@page { size: A4; margin: 14mm 12mm; }
* { box-sizing: border-box; }
body { font-family: "Microsoft YaHei","PingFang SC","Hiragino Sans GB",-apple-system,sans-serif; color:#111; margin:0; padding:18px; background:#f4f5f7; font-size:13px; line-height:1.6; }
.sheet { background:#fff; max-width:210mm; margin:0 auto; padding:14mm 12mm; box-shadow:0 2px 14px rgba(0,0,0,.12); }
h1 { font-size:22px; text-align:center; margin:0 0 4px; letter-spacing:2px; }
h2 { font-size:14px; margin:18px 0 6px; border-left:4px solid #1f6feb; padding-left:8px; }
.sub { text-align:center; color:#666; font-size:12px; margin-bottom:10px; }
.who { text-align:center; font-size:12.5px; color:#444; margin-bottom:10px; }
table { width:100%; border-collapse:collapse; font-size:12.5px; margin-bottom:8px; }
th, td { border:1px solid #bbb; padding:6px 8px; }
th { background:#f0f2f5; font-weight:600; text-align:left; }
.n { text-align:right; font-variant-numeric: tabular-nums; }
.b { font-weight:700; }
.total td { font-weight:700; border-top:2px solid #333; border-bottom:2px solid #333; background:#fafafa; }
.red { color:#b3261e; } .green { color:#0a7d32; }
.btn { display:block; width:200px; margin:16px auto 0; padding:12px; text-align:center; background:#1f6feb; color:#fff; border:0; border-radius:8px; font-size:15px; }
.sign { margin-top:26px; display:flex; justify-content:space-between; font-size:12.5px; color:#333; }
.sign span { flex:1; margin-right:18px; }
.tip { text-align:center; font-size:12px; color:#888; margin-top:18px; }
@media print { body { background:#fff; padding:0; } .sheet { box-shadow:none; padding:0; margin:0; } .btn, .tip { display:none; } }
`
const a4Page = ({ title, body, extraCss, sign, tip, btn }) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title>
<style>${A4_CSS}${extraCss || ''}</style></head><body>
<button class="btn" onclick="window.print()">${btn || '🖨 打印 / 存为 PDF'}</button>
<div class="sheet">
${body}
${sign ? '<div class="sign">' + sign + '</div>' : ''}
${tip ? '<div class="tip">' + tip + '</div>' : ''}
</div></body></html>`

app.get('/statement-print', async (c) => {
  const db = c.env.DB
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  const party = String(c.req.query('party') || '').trim()
  const type = String(c.req.query('type') || 'ar') === 'ap' ? 'ap' : 'ar'
  // 链接里带签名，不含口令本身（口令泄露风险）
  const want = String(c.req.query('t') || '')
  const good = saved ? await sigOf(saved, party, type) : ''
  if (!good || want !== good) return c.html('<h3>链接已失效：请在小程序里重新点「打印版」生成新链接。</h3>')
  if (!party) return c.html('<h3>缺少对账单位。</h3>')
  const today = now().slice(0, 10)
  let from = String(c.req.query('from') || '').slice(0, 10) || (today.slice(0, 7) + '-01')
  let to = String(c.req.query('to') || '').slice(0, 10) || today
  if (from > to) { const t = from; from = to; to = t }

  const t = await getTitle(db)
  const prof = await db.prepare('SELECT * FROM party_profiles WHERE party=?').bind(party).first().catch(() => null)
  const q = (sql, ...a) => db.prepare(sql).bind(...a).all().then((r) => r.results)
  const docs = type === 'ar'
    ? await q('SELECT * FROM orders WHERE customer=? ORDER BY id', party)
    : await q('SELECT * FROM payables WHERE supplier=? ORDER BY id', party)
  const ids = docs.map((d) => d.id)
  let pays = []
  if (ids.length) {
    const ph = ids.map(() => '?').join(',')
    pays = await q("SELECT * FROM ledger WHERE ref_type=? AND ref_id IN (" + ph + ') ORDER BY id',
      type === 'ar' ? 'order' : 'payable', ...ids)
  }
  const totalOf = (d) => num(type === 'ar' ? d.price : d.amount)
  const woOf = (d) => num(d.written_off)
  const paidIn = (d, a, b) => pays.filter((p) => p.ref_id === d.id && (p.created_at || '').slice(0, 10) >= a && (p.created_at || '').slice(0, 10) <= b).reduce((x, p) => x + num(p.amount), 0)

  let opening = 0
  let added = 0
  let got = 0
  let woff = 0
  const rows = []
  for (const d of docs) {
    const d0 = (d.created_at || '').slice(0, 10)
    if (d0 < from) {
      opening += Math.max(0, totalOf(d) - woOf(d) - paidIn(d, '0000-00-00', addDaysIso(from, -1)))
      continue
    }
    if (d0 > to) continue
    const rec = paidIn(d, from, to)
    added += totalOf(d)
    got += rec
    woff += woOf(d)
    rows.push({ id: d.id, date: d0, item: (type === 'ar' ? d.item_name : d.remark) || '', total: totalOf(d), rec, wo: woOf(d), left: Math.max(0, totalOf(d) - woOf(d) - rec - paidIn(d, '0000-00-00', addDaysIso(from, -1))) })
  }
  const closing = opening + added - got - woff
  const money = (v) => Number(v || 0).toFixed(2)
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]))
  const body = rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.date)}</td><td>${esc(r.item || '—')}</td><td class="n">${money(r.total)}</td><td class="n">${money(r.rec)}</td><td class="n">${money(r.wo)}</td><td class="n b">${money(r.left)}</td></tr>`).join('')
  const label = type === 'ar' ? '应收账款对账单' : '应付账款对账单'
  const who = type === 'ar' ? '客户' : '供应商'
  const pageBody = `
<h1>${esc(t.title || '对账单')}</h1>
<div class="sub">${label}（打印版 · A4）</div>
<div class="who">${esc(t.title)}${t.phone ? '　电话 ' + esc(t.phone) : ''}${t.addr ? '　' + esc(t.addr) : ''}</div>
<div class="meta"><div>${who}：<b>${esc(party)}</b>${prof && prof.contact ? '（' + esc(prof.contact) + '）' : ''}</div><div>账期：${esc(from)} 至 ${esc(to)}</div></div>
${prof && (prof.phone || prof.addr || prof.note) ? `<div class="meta2">${prof.phone ? '联系电话：' + esc(prof.phone) + '　' : ''}${prof.addr ? '地址：' + esc(prof.addr) + '　' : ''}${prof.note ? '备注：' + esc(prof.note) : ''}</div>` : ''}
<table>
<thead><tr><th style="width:38px">#</th><th style="width:92px">日期</th><th>项目/备注</th><th style="width:88px">金额</th><th style="width:88px">本期${type === 'ar' ? '已收' : '已付'}</th><th style="width:70px">核销</th><th style="width:88px">未结</th></tr></thead>
<tbody>${body || '<tr><td colspan="7" style="text-align:center;color:#888">本期没有发生</td></tr>'}</tbody>
</table>
<div class="sum"><table>
<tr><td>期初${type === 'ar' ? '应收' : '应付'}</td><td class="n">${money(opening)}</td></tr>
<tr><td>本期新增</td><td class="n">${money(added)}</td></tr>
<tr><td>本期${type === 'ar' ? '已收' : '已付'}</td><td class="n">-${money(got)}</td></tr>
<tr><td>本期核销/豁免</td><td class="n">-${money(woff)}</td></tr>
<tr><td><b>期末${type === 'ar' ? '应收' : '应付'}</b></td><td class="n big">${money(closing)}</td></tr>
</table></div>
${t.note ? '<div style="font-size:12.5px;color:#555;margin-top:10px">备注：' + esc(t.note) + '</div>' : ''}
${t.bank ? '<div style="font-size:12.5px;color:#333;margin-top:6px">收款信息：' + esc(t.bank) + '</div>' : ''}
` 
  const extraCss = `.meta{display:flex;justify-content:space-between;font-size:13px;margin:10px 0;border-bottom:1px solid #ddd;padding-bottom:8px}
.meta2{font-size:12px;color:#555;margin:-4px 0 8px}
.sum{margin-top:12px;font-size:13px}
.sum table{width:auto;min-width:60%;margin-left:auto}
.sum td{border:none;padding:4px 10px}
.sum .big{font-size:15px;font-weight:700;color:#b3261e}
.sign span{border-top:1px solid #999;padding-top:6px}`
  return c.html(a4Page({
    title: `${party} ${label} ${from}~${to}`,
    body: pageBody,
    extraCss,
    sign: `<span>对账单位签章：</span><span>制表：${esc(t.title || '')}　${esc(today)}</span>`,
    tip: '手机上：右上角「…」→ 发送给朋友或用浏览器打开 → 打印',
  }))
})

// ==================== 借款台账（银行/亲友借款 + 利息 + 还款计划） ====================
const DEBT_KIND = { bank: '银行贷款', person: '个人借款', other: '其他' }
const PAY_KIND = { interest: '按月付息到期还本', equal: '等额本息', end: '到期一次还本付息' }
const monthOf = (iso) => String(iso || '').slice(0, 7)
const monthAdd = (iso, k) => {
  const d = new Date(iso + 'T00:00:00Z')
  const day = d.getUTCDate()
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + k)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last))
  return d.toISOString().slice(0, 10)
}
const equalPay = (p, rate, n) => {
  const i = num(rate) / 1200
  if (!n) return 0
  if (i <= 0) return p / n
  return (p * i * Math.pow(1 + i, n)) / (Math.pow(1 + i, n) - 1)
}
const debtView = (d, repays) => {
  const p = num(d.principal)
  const n = num(d.term_months)
  const rate = num(d.rate)
  const paidP = repays.filter((r) => r.kind === 'principal').reduce((a, r) => a + num(r.amount), 0)
  const paidI = repays.filter((r) => r.kind !== 'principal').reduce((a, r) => a + num(r.amount), 0)
  const remain = Math.max(0, round2(p - paidP))
  const monthly = round2(remain * rate / 1200)
  const start = (d.start_date || d.created_at || now()).slice(0, 10)
  const today = now().slice(0, 10)
  let nextDue = ''
  let nextAmount = round2(monthly)
  const endDate = n ? monthAdd(start, n) : ''
  if (d.pay_kind === 'equal') nextAmount = round2(equalPay(p, rate, n))
  if (d.pay_kind === 'end') { nextDue = endDate; nextAmount = round2(p * (1 + rate / 100 * n / 12)) - paidP - paidI }
  if (d.pay_kind !== 'end') {
    // 下一次还款日：从起借日开始逐月，找到第一个还没付息且不早于上月的日期
    let k = 1
    let due = monthAdd(start, 1)
    while (due <= today && k < 600) { k += 1; due = monthAdd(start, k) }
    nextDue = due
  }
  const closed = d.status === 'closed' || remain <= 0
  const overdue = !closed && nextDue && nextDue < today
  return {
    id: d.id, lender: d.lender || '', kind: d.kind || 'bank', kind_name: DEBT_KIND[d.kind] || d.kind,
    pay_kind: d.pay_kind || 'interest', pay_kind_name: PAY_KIND[d.pay_kind] || d.pay_kind,
    principal: p, rate, term_months: n, start_date: start, end_date: endDate,
    account_id: num(d.account_id), remark: d.remark || '', status: closed ? 'closed' : 'open',
    remain, monthly_interest: monthly, paid_principal: round2(paidP), paid_interest: round2(paidI),
    next_due: nextDue, next_amount: nextAmount, overdue, days_to_due: nextDue ? Math.round((new Date(nextDue) - new Date(today)) / 86400000) : null
  }
}

app.get('/debts', async (c) => {
  const db = c.env.DB
  const rows = (await db.prepare('SELECT * FROM debts ORDER BY id DESC').all()).results
  const reps = (await db.prepare('SELECT * FROM debt_repays ORDER BY id').all()).results
  const list = rows.map((d) => debtView(d, reps.filter((r) => r.debt_id === d.id)))
  const open = list.filter((x) => x.status === 'open')
  return c.json({
    debts: list,
    count: list.length,
    total_principal: round2(open.reduce((a, x) => a + x.remain, 0)),
    month_interest: round2(open.reduce((a, x) => a + x.monthly_interest, 0)),
    overdue_count: open.filter((x) => x.overdue).length,
    soon: open.filter((x) => !x.overdue && x.days_to_due !== null && x.days_to_due >= 0 && x.days_to_due <= 7)
  })
})

app.post('/debts', async (c) => {
  const b = await c.req.json()
  const db = c.env.DB
  const acc = num(b.account_id) || (await defaultAccountId(db))
  const r = await db.prepare('INSERT INTO debts (lender, kind, principal, rate, start_date, term_months, pay_kind, account_id, remark, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind(String(b.lender || ''), String(b.kind || 'bank'), num(b.principal), num(b.rate), String(b.start_date || now()).slice(0, 10), num(b.term_months), String(b.pay_kind || 'interest'), acc, String(b.remark || ''), 'open', now()).run()
  const id = r.meta && r.meta.last_row_id
  // 借进来的钱记一笔现金流入（不算经营收入）
  await db.prepare('INSERT INTO ledger (direction, amount, category, remark, ref_type, ref_id, account_id, cash, created_at, operator) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind('in', num(b.principal), '借款', (DEBT_KIND[b.kind] || '借款') + '：' + String(b.lender || ''), 'debt', id, acc, 1, String(b.start_date || now()).slice(0, 10), String(b.operator || '')).run()
  return c.json({ ok: true, id })
})

app.patch('/debts/:id', async (c) => {
  const id = c.req.param('id')
  const b = await c.req.json()
  const db = c.env.DB
  const d = await db.prepare('SELECT * FROM debts WHERE id=?').bind(id).first()
  if (!d) return c.json({ error: '没有这笔借款' }, 404)
  await db.prepare('UPDATE debts SET lender=?, kind=?, principal=?, rate=?, start_date=?, term_months=?, pay_kind=?, remark=?, status=? WHERE id=?')
    .bind(b.lender !== undefined ? String(b.lender) : d.lender, b.kind || d.kind, b.principal !== undefined ? num(b.principal) : num(d.principal), b.rate !== undefined ? num(b.rate) : num(d.rate), b.start_date || d.start_date, b.term_months !== undefined ? num(b.term_months) : num(d.term_months), b.pay_kind || d.pay_kind, b.remark !== undefined ? String(b.remark) : d.remark, b.status || d.status, id).run()
  return c.json({ ok: true })
})

app.delete('/debts/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  await db.prepare('DELETE FROM debts WHERE id=?').bind(id).run()
  await db.prepare('DELETE FROM debt_repays WHERE debt_id=?').bind(id).run()
  await db.prepare("DELETE FROM ledger WHERE ref_type='debt' AND ref_id=?").bind(id).run()
  return c.json({ ok: true })
})

app.post('/debts/:id/repay', async (c) => {
  const id = c.req.param('id')
  const b = await c.req.json()
  const db = c.env.DB
  const d = await db.prepare('SELECT * FROM debts WHERE id=?').bind(id).first()
  if (!d) return c.json({ error: '没有这笔借款' }, 404)
  const amount = num(b.amount)
  if (!(amount > 0)) return c.json({ error: '还款金额要大于 0' }, 400)
  const date = String(b.date || now()).slice(0, 10)
  const acc = num(b.account_id) || num(d.account_id) || (await defaultAccountId(db))
  const kind = b.kind === 'principal' ? 'principal' : 'interest'
  await db.prepare('INSERT INTO debt_repays (debt_id, rdate, amount, kind, account_id, remark, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind(id, date, amount, kind, acc, String(b.remark || ''), now()).run()
  await db.prepare('INSERT INTO ledger (direction, amount, category, remark, ref_type, ref_id, account_id, cash, created_at, operator) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind('out', amount, '还款', (kind === 'principal' ? '还本金' : '付利息') + '：' + (d.lender || ''), 'debt', id, acc, 1, date, String(b.operator || '')).run()
  const reps = (await db.prepare('SELECT * FROM debt_repays WHERE debt_id=?').bind(id).all()).results
  const v = debtView(d, reps)
  if (v.remain <= 0) await db.prepare("UPDATE debts SET status='closed' WHERE id=?").bind(id).run()
  return c.json({ ok: true, remain: v.remain, monthly_interest: v.monthly_interest, closed: v.remain <= 0 })
})

app.get('/debts/:id/schedule', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const d = await db.prepare('SELECT * FROM debts WHERE id=?').bind(id).first()
  if (!d) return c.json({ error: '没有这笔借款' }, 404)
  const reps = (await db.prepare('SELECT * FROM debt_repays WHERE debt_id=? ORDER BY id').bind(id).all()).results
  const p = num(d.principal)
  const n = num(d.term_months) || 12
  const rate = num(d.rate)
  const start = (d.start_date || d.created_at || now()).slice(0, 10)
  const paidI = reps.filter((r) => r.kind !== 'principal').reduce((a, r) => a + num(r.amount), 0)
  const paidP = reps.filter((r) => r.kind === 'principal').reduce((a, r) => a + num(r.amount), 0)
  const rows = []
  let bal = p
  const A = round2(equalPay(p, rate, n))
  for (let k = 1; k <= n; k += 1) {
    const due = monthAdd(start, k)
    let interest = round2(bal * rate / 1200)
    let principal = 0
    if (d.pay_kind === 'equal') { principal = Math.min(bal, round2(A - interest)); interest = round2(A - principal) }
    else if (d.pay_kind === 'end') { principal = k === n ? bal : 0; interest = round2(p * rate / 1200) }
    else { principal = k === n ? bal : 0 }
    const pay = round2(principal + interest)
    bal = round2(bal - principal)
    rows.push({ n: k, due, interest, principal, pay, balance: bal })
  }
  const totalInterest = round2(rows.reduce((a, x) => a + x.interest, 0))
  return c.json({ ok: true, lender: d.lender, principal: p, rate, term_months: n, pay_kind: d.pay_kind, rows, total_interest: totalInterest, total_pay: round2(p + totalInterest), paid_interest: round2(paidI), paid_principal: round2(paidP) })
})

// ==================== 客户信用额度 ====================
app.get('/credit-limits', async (c) => {
  const db = c.env.DB
  const lims = (await db.prepare('SELECT * FROM credit_limits ORDER BY id').all()).results
  const rows = (await db.prepare('SELECT customer, SUM(MAX(0, price - paid - COALESCE(written_off,0))) AS unpaid, COUNT(*) AS cnt FROM orders GROUP BY customer').all()).results
  const m = {}
  for (const r of rows) m[r.customer] = r
  const list = lims.map((l) => {
    const r = m[l.party] || { unpaid: 0, cnt: 0 }
    const unpaid = round2(num(r.unpaid))
    const lim = num(l.limit_amount)
    return { id: l.id, party: l.party, limit_amount: lim, note: l.note || '', unpaid, cnt: num(r.cnt), over: lim > 0 && unpaid > lim, pct: lim > 0 ? Math.round(unpaid / lim * 100) : null, remain: round2(lim - unpaid) }
  })
  return c.json({ limits: list, count: list.length, over_count: list.filter((x) => x.over).length, total_limit: round2(list.reduce((a, x) => a + x.limit_amount, 0)) })
})

app.post('/credit-limits', async (c) => {
  const b = await c.req.json()
  const db = c.env.DB
  const party = String(b.party || '').trim()
  if (!party) return c.json({ error: '要写单位名称' }, 400)
  const lim = num(b.limit_amount)
  const old = await db.prepare('SELECT * FROM credit_limits WHERE party=?').bind(party).first()
  if (old) await db.prepare('UPDATE credit_limits SET limit_amount=?, note=? WHERE id=?').bind(lim, String(b.note || old.note || ''), old.id).run()
  else await db.prepare('INSERT INTO credit_limits (party, limit_amount, note, created_at) VALUES (?,?,?,?)').bind(party, lim, String(b.note || ''), now()).run()
  return c.json({ ok: true })
})

app.delete('/credit-limits/:id', async (c) => {
  const db = c.env.DB
  await db.prepare('DELETE FROM credit_limits WHERE id=?').bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

// ==================== 待摊费用（房租/保险等一次付多月，按月摊） ====================
const PREPAID_CAT = '待摊费用'
const amortPerMonth = (p) => round2(num(p.total) / Math.max(1, num(p.months)))
const prepaidView = async (db, p) => {
  const months = Math.max(1, num(p.months))
  const start = (p.start_date || p.created_at || now()).slice(0, 10)
  const done = (await db.prepare("SELECT created_at FROM ledger WHERE ref_type='amort' AND ref_id=?").bind(p.id).all()).results
  const doneMonths = done.map((r) => (r.created_at || '').slice(0, 7))
  const amortized = round2(amortPerMonth(p) * Math.min(months, doneMonths.length))
  let nextMonth = ''
  for (let k = 0; k < months; k += 1) {
    const m = monthOf(monthAdd(start, k))
    if (!doneMonths.includes(m)) { nextMonth = m; break }
  }
  return {
    id: p.id, name: p.name || '', total: num(p.total), months, per_month: amortPerMonth(p),
    start_date: start, category: p.category || '', account_id: num(p.account_id), remark: p.remark || '',
    active: num(p.active) ? 'open' : 'closed', amortized, remain: round2(num(p.total) - amortized),
    done_months: doneMonths.length, next_month: nextMonth, end_month: monthOf(monthAdd(start, months - 1))
  }
}

// 按月生成摊销流水（cash=0，不动现金，只进成本）
const runAmort = async (db) => {
  const list = (await db.prepare('SELECT * FROM prepaids WHERE active=1').all()).results
  let added = 0
  let amount = 0
  const today = now().slice(0, 10)
  for (const p of list) {
    const months = Math.max(1, num(p.months))
    const start = (p.start_date || p.created_at || today).slice(0, 10)
    const per = amortPerMonth(p)
    for (let k = 0; k < months; k += 1) {
      const dueMonth = monthOf(monthAdd(start, k))
      const dueDate = monthAdd(start, k).slice(0, 10)
      if (dueDate > today) break
      const has = await db.prepare("SELECT id FROM ledger WHERE ref_type='amort' AND ref_id=? AND month=?").bind(p.id, dueMonth).first()
      if (has) continue
      await db.prepare("INSERT INTO ledger (direction, amount, category, remark, ref_type, ref_id, account_id, cash, created_at) VALUES ('out',?,?,?,?,?,?,0,?)")
        .bind(per, p.category || PREPAID_CAT, '摊销：' + (p.name || ''), 'amort', p.id, num(p.account_id) || 0, dueDate).run()
      added += 1
      amount = round2(amount + per)
    }
  }
  return { added, amount }
}

app.get('/prepaids', async (c) => {
  const db = c.env.DB
  const rows = (await db.prepare('SELECT * FROM prepaids ORDER BY id DESC').all()).results
  const list = []
  for (const p of rows) list.push(await prepaidView(db, p))
  const open = list.filter((x) => x.active === 'open')
  return c.json({
    prepaids: list, count: list.length, open_count: open.length,
    total_left: round2(open.reduce((a, x) => a + x.remain, 0)),
    month_amount: round2(open.filter((x) => x.next_month === month() || !x.next_month).reduce((a, x) => a + x.per_month, 0))
  })
})

app.post('/prepaids', async (c) => {
  const b = await c.req.json()
  const db = c.env.DB
  const total = num(b.total)
  const months = Math.max(1, num(b.months))
  if (!(total > 0)) return c.json({ error: '总金额要大于 0' }, 400)
  const cat = String(b.category || '房租').trim() || '房租'
  const acc = num(b.account_id) || (await defaultAccountId(db))
  const start = String(b.start_date || now()).slice(0, 10)
  const r = await db.prepare('INSERT INTO prepaids (name, total, months, start_date, category, account_id, remark, active, created_at) VALUES (?,?,?,?,?,?,?,1,?)')
    .bind(String(b.name || cat), total, months, start, cat, acc, String(b.remark || ''), now()).run()
  const id = r.meta && r.meta.last_row_id
  // 付款流水：现金流出，分类「待摊费用」（不算当月成本，按月摊）
  await db.prepare("INSERT INTO ledger (direction, amount, category, remark, ref_type, ref_id, account_id, cash, created_at) VALUES ('out',?,?,?,?,?,?,1,?)")
    .bind(total, PREPAID_CAT, '预付 ' + String(b.name || cat) + '（' + months + ' 个月）', 'prepaid', id, acc, start).run()
  const run = await runAmort(db)
  return c.json({ ok: true, id, per_month: round2(total / months), amort: run })
})

app.patch('/prepaids/:id', async (c) => {
  const id = c.req.param('id')
  const b = await c.req.json()
  const db = c.env.DB
  const p = await db.prepare('SELECT * FROM prepaids WHERE id=?').bind(id).first()
  if (!p) return c.json({ error: '没找到' }, 404)
  if (b.active !== undefined) await db.prepare('UPDATE prepaids SET active=? WHERE id=?').bind(b.active ? 1 : 0, id).run()
  if (b.name !== undefined) await db.prepare('UPDATE prepaids SET name=? WHERE id=?').bind(String(b.name), id).run()
  return c.json({ ok: true })
})

app.delete('/prepaids/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  await db.prepare('DELETE FROM prepaids WHERE id=?').bind(id).run()
  await db.prepare("DELETE FROM ledger WHERE ref_type IN ('prepaid','amort') AND ref_id=?").bind(id).run()
  return c.json({ ok: true })
})

app.post('/run-amort', async (c) => {
  const db = c.env.DB
  const r = await runAmort(db)
  return c.json({ ok: true, added: r.added, amount: r.amount })
})

// ==================== 预提利息（借款每月自动计息，不用手点） ====================
const runAccrual = async (db) => {
  const rows = (await db.prepare("SELECT * FROM debts WHERE status='open'").all()).results
  const reps = (await db.prepare('SELECT * FROM debt_repays').all()).results
  const today = now().slice(0, 10)
  const cur = month()
  let added = 0
  let amount = 0
  for (const d of rows) {
    const v = debtView(d, reps.filter((r) => r.debt_id === d.id))
    if (!v.monthly_interest || v.monthly_interest <= 0 || v.status === 'closed') continue
    // 只提本月（当月最后一次还款日之前也算）；已有本期「付息」流水则不再提
    const paidThisMonth = reps.some((r) => r.debt_id === d.id && r.kind !== 'principal' && (r.rdate || r.created_at || '').slice(0, 7) === cur)
    const has = await db.prepare("SELECT id FROM ledger WHERE ref_type='debt_int' AND ref_id=? AND month=?").bind(d.id, cur).first()
    if (paidThisMonth || has) continue
    const start = (d.start_date || d.created_at || today).slice(0, 10)
    if (start.slice(0, 7) >= cur) continue
    await db.prepare("INSERT INTO ledger (direction, amount, category, remark, ref_type, ref_id, account_id, cash, created_at) VALUES ('out',?,?,?,?,?,?,0,?)")
      .bind(v.monthly_interest, '利息', '预提利息：' + (d.lender || ''), 'debt_int', d.id, num(d.account_id) || 0, today).run()
    added += 1
    amount = round2(amount + v.monthly_interest)
  }
  return { added, amount }
}

app.post('/run-accrual', async (c) => {
  const db = c.env.DB
  const r = await runAccrual(db)
  return c.json({ ok: true, added: r.added, amount: r.amount })
})

app.get('/accruals', async (c) => {
  const db = c.env.DB
  const m = String(c.req.query('month') || month()).slice(0, 7)
  const { results } = await db.prepare("SELECT * FROM ledger WHERE ref_type IN ('amort','debt_int') AND substr(created_at,1,7)=? ORDER BY id").bind(m).all()
  const amort = round2(results.filter((r) => r.ref_type === 'amort').reduce((a, r) => a + num(r.amount), 0))
  const interest = round2(results.filter((r) => r.ref_type === 'debt_int').reduce((a, r) => a + num(r.amount), 0))
  return c.json({ month: m, rows: results, amort, interest, total: round2(amort + interest) })
})

// ==================== 月度结转归档（月结后打快照，报表以快照为准） ====================
const monthEnd = (mm) => {
  const [y, mo] = mm.split('-').map(Number)
  const d = new Date(Date.UTC(y, mo, 0))
  return d.toISOString().slice(0, 10)
}

const monthSnapshot = async (db, mm) => {
  const one = async (sql, ...a) => num(((await db.prepare(sql).bind(...a).first()) || {}).t)
  const end = monthEnd(mm)
  const endTs = end + 'T23:59:59Z'
  const cashIn = await one("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE direction='in' AND cash=1 AND ref_type<>'transfer' AND month=?", mm)
  const cashOut = await one("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND substr(created_at,1,7)=?", mm)
  const orderAdd = await one('SELECT COALESCE(SUM(price),0) t FROM orders WHERE month=?', mm)
  const orderCnt = await one('SELECT COUNT(*) t FROM orders WHERE month=?', mm)
  const payableAdd = await one('SELECT COALESCE(SUM(amount),0) t FROM payables WHERE month=?', mm)
  const payableCnt = await one('SELECT COUNT(*) t FROM payables WHERE month=?', mm)
  const ledgerCnt = await one('SELECT COUNT(*) t FROM ledger WHERE month=?', mm)
  const amort = await one("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE ref_type='amort' AND month=?", mm)
  const dep = await one("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE ref_type='dep' AND month=?", mm)
  const accrue = await one("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE ref_type='debt_int' AND month=?", mm)
  const cashExp = await one("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE direction='out' AND cash=1 AND ref_type IN ('expense','fixed') AND substr(created_at,1,7)=?", mm)
  const matCost = await one('SELECT COALESCE(SUM(COALESCE(cost,0)),0) t FROM orders WHERE month=?', mm)
  const cost = round2(matCost + cashExp + amort + dep + accrue)
  const profit = round2(orderAdd - cost)
  // 期末余额（截至该月最后一天）
  const opening = await one('SELECT COALESCE(SUM(opening),0) t FROM accounts')
  const cashFlow = await one("SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) t FROM ledger WHERE cash=1 AND substr(created_at,1,10)<=?", end)
  const arLeft = await one('SELECT COALESCE(SUM(CASE WHEN price - paid - COALESCE(written_off,0) > 0 THEN price - paid - COALESCE(written_off,0) ELSE 0 END),0) t FROM orders WHERE substr(created_at,1,10)<=?', end)
  const apLeft = await one('SELECT COALESCE(SUM(CASE WHEN amount - paid - COALESCE(written_off,0) > 0 THEN amount - paid - COALESCE(written_off,0) ELSE 0 END),0) t FROM payables WHERE substr(created_at,1,10)<=?', end)
  const debtLeft = await one('SELECT COALESCE(SUM(principal),0) t FROM debts WHERE substr(start_date,1,10)<=?', end)
  const debtPaid = await one("SELECT COALESCE(SUM(amount),0) t FROM debt_repays WHERE kind='principal' AND substr(COALESCE(rdate,created_at),1,10)<=?", end)
  const debtB = round2(Math.max(0, debtLeft - debtPaid))
  const cash = round2(opening + cashFlow)
  return {
    month: mm, period_end: end,
    income: cashIn, outcome: cashOut, net_cash: round2(cashIn - cashOut),
    order_add: orderAdd, order_count: orderCnt, payable_add: payableAdd, payable_count: payableCnt, ledger_count: ledgerCnt,
    cash_expense: cashExp, mat_cost: matCost, amort, dep, accrue_int: accrue, cost,
    profit, margin: orderAdd > 0 ? round2((profit / orderAdd) * 100) : 0,
    cash_balance: cash, ar_left: arLeft, ap_left: apLeft, debt_left: debtB,
    net_worth: round2(cash + arLeft - apLeft - debtB)
  }
}

const saveArchive = async (db, snap) => {
  const js = JSON.stringify(snap)
  const has = await db.prepare('SELECT id FROM month_archive WHERE month=?').bind(snap.month).first()
  if (has) await db.prepare('UPDATE month_archive SET data=?, created_at=? WHERE month=?').bind(js, now(), snap.month).run()
  else await db.prepare('INSERT INTO month_archive (month, data, created_at) VALUES (?,?,?)').bind(snap.month, js, now()).run()
  return true
}

// 读某月数据：已归档就用归档快照（历史改动不影响已出报表）
const snapOf = async (db, mm) => {
  const a = await db.prepare('SELECT data FROM month_archive WHERE month=?').bind(mm).first()
  if (a && a.data) {
    try {
      const d = JSON.parse(a.data)
      d.archived = true
      return d
    } catch (e) { /* 归档坏了就现算 */ }
  }
  const d = await monthSnapshot(db, mm)
  d.archived = false
  return d
}

// 结账前自检：把「结账后就不许改」之前该做的事列清楚（结账不可怕，漏掉才可怕）
// 结账锁定到底锁了什么：给小白一句说清楚的「会拦 / 不拦 / 怎么解锁」
const LOCK_INFO = {
  blocked: '记单、改单、删单、收款付款、批量导入、补记差异、固定支出自动记账、计提折旧/摊销/预提',
  allowed: '查看任何页面、导出 Excel、打印对账单/月报/交接包、催款提醒、对账单、备份',
  unlock: '要改这个月的账：报表 → 月结归档 → 点这个月旁边的「解锁」（删归档），改完再结一次会生成新快照'
}
// 本月对账完成度：应核对几家、核对清楚几家（结账把关 / 月报共用）
async function reconRate(db, mm) {
  const out = { total: 0, done: 0, disputed: 0, diff: 0, none: 0, sent: 0, rate: 100, rows: [] }
  const CNT = { done: 0, disputed: 0, diff: 0, sent: 0, none: 0 }
  for (const type of ['ar', 'ap']) {
    const isAr = type === 'ar'
    const tbl = isAr ? 'orders' : 'payables'
    const col = isAr ? 'customer' : 'supplier'
    const amt = isAr ? 'price' : 'amount'
    const OPEN = `${amt}-COALESCE(paid,0)-COALESCE(written_off,0)`
    const [act, open, stmt, rlog, rconf] = await Promise.all([
      db.prepare(`SELECT ${col} AS party, COUNT(*) c FROM ${tbl} WHERE substr(created_at,1,7)=? GROUP BY ${col}`).bind(mm).all().catch(() => ({ results: [] })),
      db.prepare(`SELECT ${col} AS party, COALESCE(SUM(${OPEN}),0) l FROM ${tbl} WHERE ${OPEN}>0.005 GROUP BY ${col}`).all().catch(() => ({ results: [] })),
      db.prepare("SELECT party, ack, ack_at, resolved_at, created_at FROM statement_log WHERE type=? AND substr(COALESCE(month,''),1,7)=? ORDER BY id DESC LIMIT 400").bind(type, mm).all().catch(() => ({ results: [] })),
      db.prepare("SELECT party, done, state, diff FROM recon_log WHERE type=? AND substr(COALESCE(month,''),1,7)=? ORDER BY id DESC LIMIT 400").bind(type, mm).all().catch(() => ({ results: [] })),
      db.prepare("SELECT party FROM recon_confirm WHERE type=? AND substr(COALESCE(month,''),1,7)=?").bind(type, mm).all().catch(() => ({ results: [] }))
    ])
    const smap = {}, lmap = {}, cmap = {}, omap = {}
    for (const r of (stmt.results || [])) { const k = norm(r.party); if (!smap[k]) smap[k] = r }
    for (const r of (rlog.results || [])) { const k = norm(r.party); if (!lmap[k]) lmap[k] = r }
    for (const r of (rconf.results || [])) cmap[norm(r.party)] = 1
    for (const r of (open.results || [])) omap[norm(r.party)] = round2(num(r.l))
    const seen = {}
    const push = (party, cnt) => {
      const k = norm(party)
      if (!party || seen[k]) return
      seen[k] = 1
      const s = smap[k], r = lmap[k]
      let st = 'none'
      if (s && s.ack === 'doubt' && !String(s.resolved_at || '')) st = 'disputed'
      else if (cmap[k] || (s && s.ack === 'ok') || (r && num(r.done) === 1)) st = 'done'
      else if (r && num(r.diff) > 0.005) st = 'diff'
      else if (s) st = 'sent'
      CNT[st] = num(CNT[st]) + 1
      out.total++
      out.rows.push({ type, party, st, cnt: num(cnt), left: round2(num(omap[k])) })
    }
    for (const r of (act.results || [])) push(r.party, r.c)
    for (const r of (open.results || [])) push(r.party, 0)
  }
  out.done = CNT.done; out.disputed = CNT.disputed; out.diff = CNT.diff; out.sent = CNT.sent; out.none = CNT.none
  out.rate = out.total ? Math.round(out.done * 100 / out.total) : 100
  return out
}

async function closePrecheck(db, mm) {
  const [diff, anyRecon, summ, bk, unclosed, prevLock] = await Promise.all([
    db.prepare("SELECT COUNT(*) n FROM recon_log WHERE substr(month,1,7)=? AND done=0 AND COALESCE(state,'')<>'match'").bind(mm).first().catch(() => ({ n: 0 })),
    db.prepare('SELECT COUNT(*) n FROM recon_log WHERE substr(month,1,7)=?').bind(mm).first().catch(() => ({ n: 0 })),
    db.prepare("SELECT value AS v FROM settings WHERE key='pipeline_summary'").first().catch(() => null),
    db.prepare('SELECT MAX(created_at) t FROM backups').bind().first().catch(() => null),
    db.prepare("SELECT (SELECT COUNT(*) FROM orders WHERE month=? AND price-COALESCE(paid,0)-COALESCE(written_off,0)>0.005) + (SELECT COUNT(*) FROM payables WHERE month=? AND amount-COALESCE(paid,0)-COALESCE(written_off,0)>0.005) n")
      .bind(mm, mm).first().catch(() => ({ n: 0 })),
    (async () => {
      const [y, m] = mm.split('-').map(Number)
      const d = new Date(Date.UTC(y, m - 2, 1))
      const pm = d.toISOString().slice(0, 7)
      const r = await db.prepare('SELECT COUNT(*) n FROM month_lock WHERE month=?').bind(pm).first().catch(() => ({ n: 0 }))
      return { pm, locked: num(r && r.n) > 0 }
    })()
  ])
  const biz = await db.prepare("SELECT (SELECT COUNT(*) FROM orders WHERE month=?) + (SELECT COUNT(*) FROM payables WHERE month=?) + (SELECT COUNT(*) FROM ledger WHERE month=?) n")
    .bind(mm, mm, mm).first().catch(() => ({ n: 0 }))
  if (!num(biz && biz.n)) {
    return { month: mm, items: [{ k: 'empty', label: '本月还没有单据', count: 0, tone: 'ok',
      tip: '这个月还没有任何单据和流水，不用结账', after: '', fixable: 'yes', fix_how: '有账了再来结' }],
      blockers: [], warns: [], can_close: true, empty: true, lock_info: LOCK_INFO,
      text: '这个月还没有任何单据和流水，不用结账。' }
  }
  const items = []
  const nd = num(diff && diff.n)
  items.push({ k: 'recon_diff', label: '对账差异还没处理', count: nd, tone: nd ? 'bad' : 'ok',
    tip: nd ? `还有 ${nd} 家对账差异没处理` : '对账差异都处理完了',
    after: nd ? '结账后这个月就不能再补记差异了，等发现少记了钱只能先解锁' : '',
    fixable: 'yes',
    fix_how: '补完差异再结账；已经结过的，在「月结归档」里删掉这个月的归档就是解锁，补完重新结一次' })
  const na = num(anyRecon && anyRecon.n)
  items.push({ k: 'never_recon', label: '这个月对过账', count: na ? 1 : 0, tone: na ? 'ok' : 'warn',
    tip: na ? `本月和 ${na} 家对过账` : '这个月还没跟任何单位对过账',
    after: na ? '' : '不影响账目，只是没跟对方核过数，万一对方记的和你不一致，结完账才发现就麻烦',
    fixable: 'yes', fix_how: '对账随时都能做，结账不拦；下次结账前顺手对一遍就行' })
  const rr = await reconRate(db, mm)
  const rrBad = rr.total >= 3 && rr.rate < 60
  items.push({ k: 'recon_rate', label: '本月对账完成度', count: rr.done, total: rr.total, rate: rr.rate,
    tone: !rr.total ? 'ok' : (rr.rate >= 60 ? 'ok' : (rr.rate >= 30 ? 'warn' : 'bad')),
    tip: !rr.total ? '本月没有需要对账的单位'
      : `应核对 ${rr.total} 家，核对清楚 ${rr.done} 家（${rr.rate}%）` +
        (rr.disputed ? `，其中 ${rr.disputed} 家对方说对不上` : '') +
        (rr.none ? `，${rr.none} 家还没发过对账单` : ''),
    after: rrBad ? '这个月没跟对方核过数就结了账，以后对方说数不对，只能解锁再改' : '',
    fixable: 'yes',
    fix_how: '报表 → 📊 对账完成度 看是哪几家；对完再结，或者照样结（会记下这次没对完）' })
  const okSumm = !!(summ && String(summ.v || '') === mm)
  items.push({ k: 'summary', label: '出过本月小结', count: okSumm ? 1 : 0, tone: okSumm ? 'ok' : 'warn',
    tip: okSumm ? '本月小结已出' : '还没出本月小结',
    after: okSumm ? '' : '小结是给自己看的月报，不出也能结账，只是这个月就少一份留档的话',
    fixable: 'yes', fix_how: '报表页「出本月小结」一点就有；结账后再出也不影响' })
  const bkDays = bk && bk.t ? daysSince(new Date(new Date(bk.t).getTime() - TZ_MS).toISOString()) : -1
  const bkOk = bkDays >= 0 && bkDays <= 7
  items.push({ k: 'backup', label: '最近 7 天备份过', count: bkOk ? 1 : 0, tone: bkOk ? 'ok' : 'warn',
    tip: bkDays < 0 ? '还没备份过' : (bkOk ? `${bkDays} 天前备份过` : `上次备份是 ${bkDays} 天前`),
    after: bkOk ? '' : '结账本身不危险，但没有备份的话，以后数据出问题就回不到现在这个样子',
    fixable: 'yes', fix_how: '设置 → 「备份全部数据」（或打开云端备份，每天自动备一份）' })
  const nu = num(unclosed && unclosed.n)
  items.push({ k: 'unclosed', label: '本月还有没结清的单', count: nu, tone: nu ? 'info' : 'ok',
    tip: nu ? `本月还有 ${nu} 张单没收清/付清` : '本月单据都结清了',
    after: nu ? '欠款不受影响、到点照样提醒你收；只是这个月的单据金额以后不能再改' : '',
    fixable: 'yes', fix_how: '收款/付款随时能补记，和结账无关；要改单据金额才需要解锁' })
  items.push({ k: 'prev', label: `上个月（${prevLock.pm}）已结账`, count: prevLock.locked ? 1 : 0, tone: prevLock.locked ? 'ok' : 'info',
    tip: prevLock.locked ? '上个月已结账' : `上个月（${prevLock.pm}）还没结账`,
    after: prevLock.locked ? '' : '跳着结账不会出错，但以后按月查报表会缺上个月那一块',
    fixable: 'yes', fix_how: '回头把上个月也结一次就行，顺序不影响数据' })
  const blockers = items.filter((x) => x.k === 'recon_diff' && x.count > 0).map((x) => x.k)
    .concat(items.filter((x) => x.k === 'summary' && !x.count).map((x) => x.k))
    .concat(rrBad ? ['recon_rate'] : [])
  const warns = items.filter((x) => x.tone === 'warn').map((x) => x.k)
  return { month: mm, items, blockers, warns, can_close: blockers.length === 0, lock_info: LOCK_INFO,
    text: items.filter((x) => x.tone !== 'ok').map((x) => '· ' + x.tip + (x.after ? '（' + x.after + '）' : '')).join('\n') || '该做的都做了，可以放心结账' }
}

app.get('/close-precheck', async (c) => {
  const mm = String(c.req.query('month') || now().slice(0, 7)).slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(mm)) return c.json({ error: '月份格式：YYYY-MM' }, 400)
  return c.json({ ok: true, ...(await closePrecheck(c.env.DB, mm)) })
})

// 月底收尾：一屏把当月该做的事列完，办完就能结账
app.get('/month-end', async (c) => {
  const db = c.env.DB
  const m = String(c.req.query('month') || now().slice(0, 7)).slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(m)) return c.json({ error: '月份格式：YYYY-MM' }, 400)
  const J = (sql, ...b) => db.prepare(sql).bind(...b).first()
  const [pre, pl, accs, cnt, reconRow, lockRow, sumRow, bkRow, stR, stA] = await Promise.all([
    closePrecheck(db, m),
    monthPL(db, m),
    accountBalances(db),
    J('SELECT (SELECT COUNT(*) FROM orders WHERE month=? AND price-paid-COALESCE(written_off,0)>0) AS ar, (SELECT COUNT(*) FROM payables WHERE month=? AND amount-paid-COALESCE(written_off,0)>0) AS ap, (SELECT COUNT(*) FROM orders WHERE month=?) AS ord, (SELECT COUNT(*) FROM payables WHERE month=?) AS pay', m, m, m, m),
    J('SELECT COUNT(*) c, COUNT(DISTINCT party) p FROM recon_log WHERE month=?', m),
    J('SELECT COUNT(*) c FROM month_lock WHERE month=?', m),
    J("SELECT value FROM settings WHERE key='pipeline_summary'"),
    J('SELECT created_at FROM backups ORDER BY id DESC LIMIT 1'),
    J("SELECT COUNT(*) c FROM (SELECT DISTINCT customer p FROM orders WHERE price - paid - COALESCE(written_off,0) > 0) x WHERE x.p NOT IN (SELECT party FROM statement_log WHERE month=? AND type='ar')", m),
    J("SELECT COUNT(*) c FROM (SELECT DISTINCT supplier p FROM payables WHERE amount - paid - COALESCE(written_off,0) > 0) x WHERE x.p NOT IN (SELECT party FROM statement_log WHERE month=? AND type='ap')", m)
  ])
  const stUnsent = num(stR && stR.c) + num(stA && stA.c)
  const locked = num(lockRow && lockRow.c) > 0
  const summed = String((sumRow && sumRow.value) || '') === m
  const bkDays = (bkRow && bkRow.created_at) ? daysSince(new Date(Date.parse(bkRow.created_at) - TZ_MS).toISOString()) : 999
  const openDiff = ((pre && pre.items) || []).filter((x) => x.k === 'recon_diff').reduce((acc, x) => acc + num(x.count), 0)
  const steps = [
    { k: 'bill', no: 1, title: '本月单据录完', tab: 'ar', done: num(cnt && cnt.ord) + num(cnt && cnt.pay) > 0,
      detail: `应收 ${num(cnt && cnt.ord)} 笔 · 应付 ${num(cnt && cnt.pay)} 笔`, tip: '手工录、粘贴导入、Excel 导入都算' },
    { k: 'recon', no: 2, title: '和客商对过账', tab: 'import', done: num(reconRow && reconRow.c) > 0,
      detail: num(reconRow && reconRow.c) > 0 ? `对过 ${num(reconRow.p)} 家` : '本月还没对账', tip: '导入页粘对账单 → 对账核对' },
    { k: 'diff', no: 3, title: '差异处理完', tab: 'import', done: !openDiff,
      detail: openDiff ? '还有差异没处理' : '没有遗留差异 ✓', tip: '差异可一键补记，或标记「不用补」' },
    { k: 'stmt', no: 4, title: '对账单发给客商', tab: 'report', done: stUnsent === 0,
      detail: stUnsent === 0 ? '该发的都发了 ✓' : `还有 ${stUnsent} 家没发（应收 ${num(stR && stR.c)} · 应付 ${num(stA && stA.c)}）`,
      tip: '报表 → 📤 批量发对账单，点「话术」「打印页」自动记已发' },
    { k: 'summary', no: 5, title: '出一页月度小结', tab: 'report', done: summed,
      detail: summed ? '小结已出' : '还没出（结账会被提醒）', tip: '留档，也能直接发微信' },
    { k: 'backup', no: 6, title: '备份一次', tab: 'report', done: bkDays <= 7,
      detail: bkDays === 999 ? '从没备份过' : `上次备份 ${bkDays} 天前`, tip: '云端备份或整库备份，防误删' },
    { k: 'close', no: 7, title: '结账归档', tab: 'report', done: locked,
      detail: locked ? '已结账，单据锁定' : '还没结账', tip: '结完当月不能再改，出错可解锁' }
  ]
  const doneCount = steps.filter((x) => x.done).length
  const todo = steps.filter((x) => !x.done)
  const numbers = {
    income: pl.income, cost: pl.cost, profit: pl.profit, margin: pl.margin,
    mat: pl.mat, cash_exp: pl.cash_exp, amort: pl.amort, dep: pl.dep, accrue: pl.accrue,
    cash: round2(accs.reduce((a, x) => a + num(x.balance), 0)),
    ar_open_cnt: num(cnt && cnt.ar), ap_open_cnt: num(cnt && cnt.ap),
    payable_add: pl.payable_add
  }
  return c.json({
    ok: true, month: m, locked, steps, done_count: doneCount, total: steps.length,
    numbers, ready: pre.can_close && !locked,
    blockers: pre.blockers || [], warns: pre.warns || [],
    todo: todo.map((x) => ({ k: x.k, no: x.no, title: x.title, tab: x.tab, detail: x.detail })),
    stmt_unsent: stUnsent,
    advice: locked ? `${m} 已经结账归档了。` : (doneCount === steps.length ? '七件事都办好了，可以结账了。' : `还有 ${steps.length - doneCount} 件事没办：${todo.map((x) => x.no + '. ' + x.title).join('、')}`)
  })
})

app.post('/month-close', async (c) => {
  const db = c.env.DB
  const body = await c.req.json()
  const m = body.month
  const mm = String(m || '').trim()
  if (!/^\d{4}-\d{2}$/.test(mm)) return c.json({ error: '月份格式：YYYY-MM，如 2026-11' }, 400)
  const confirmed = !!body.confirm
  const pc = await closePrecheck(db, mm)
  if (!confirmed && pc.blockers.length) {
    return c.json({ error: '结账前还有事没做完（' + pc.blockers.length + ' 项）', code: 'need_confirm', blockers: pc.blockers, items: pc.items, text: pc.text, month: mm }, 409)
  }
  const rri = pc.items.find((x) => x.k === 'recon_rate') || { count: 0, total: 0, rate: 100 }
  const snap = await monthSnapshot(db, mm)
  snap.closed_at = now()
  await saveArchive(db, snap)
  await db.prepare('INSERT OR IGNORE INTO month_lock (month, locked_at) VALUES (?,?)').bind(mm, now()).run()
  await logAudit(db, '月结归档', mm, `结转 ${mm}：毛利 ${snap.profit}，成本 ${snap.cost}` +
    (num(rri.total) ? `，对账 ${rri.count}/${rri.total} 家` : '') +
    (confirmed && pc.blockers.length ? `（强制结账：${pc.blockers.map((k) => (BC_LABEL[k] || k)).join('、')}）` : ''))
  return c.json({ ok: true, snapshot: snap,
    lock_note: `${mm} 已经锁住了：这个月不能再新增、修改、删除单据，也不能再收付款、批量导入。`,
    unlock_how: '要改这个月的账：报表 → 月结归档 → 点这个月旁边的「解锁」，改完再结一次（归档会重新生成）。',
    not_affected: '欠款、催款提醒、对账单、报表查看都不受影响，以后月份的记账照常。' })
})

app.get('/month-archives', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM month_archive ORDER BY month DESC').all()
  const list = results.map((r) => {
    let d = {}
    try { d = JSON.parse(r.data) } catch (e) { d = {} }
    return {
      month: r.month, created_at: r.created_at,
      order_add: d.order_add || 0, cost: d.cost || 0, profit: d.profit || 0,
      margin: d.margin || 0, net_worth: d.net_worth || 0, cash_balance: d.cash_balance || 0
    }
  })
  return c.json({ archives: list, count: list.length })
})

app.get('/month-archive', async (c) => {
  const db = c.env.DB
  const mm = String(c.req.query('month') || month()).slice(0, 7)
  const r = await db.prepare('SELECT * FROM month_archive WHERE month=?').bind(mm).first()
  const snap = await snapOf(db, mm)
  return c.json({ archived: !!r, month: mm, snapshot: snap, created_at: r ? r.created_at : '' })
})

app.delete('/month-archive/:month', async (c) => {
  const mm = c.req.param('month')
  const db = c.env.DB
  await db.prepare('DELETE FROM month_archive WHERE month=?').bind(mm).run()
  await db.prepare('DELETE FROM month_lock WHERE month=?').bind(mm).run()
  await logAudit(db, '删归档', mm, `删除 ${mm} 的归档并解锁`)
  return c.json({ ok: true })
})

// ==================== A4 打印版报表（资产负债表 / 利润表） ====================
app.get('/report-link', async (c) => {
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  const mm = String(c.req.query('month') || month()).slice(0, 7)
  const t = await sigOf(saved, 'report:' + mm, 'rp')
  const base = new URL(c.req.url).origin
  return c.json({ ok: true, url: base + '/report-print?month=' + mm + '&t=' + t })
})

// 单张加工单 / 送货单：老板或车间直接打印，客户签字带回
app.get('/order-print-link', async (c) => {
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  const id = num(c.req.query('id'))
  if (!id) return c.json({ error: '缺单据号' }, 400)
  const db = c.env.DB
  const row = await db.prepare('SELECT id FROM orders WHERE id=?').bind(id).first()
  if (!row) return c.json({ error: '没找到这张单' }, 404)
  if (!saved) return c.json({ error: '先设访问口令才能生成打印页' }, 400)
  const t = await sigOf(saved, String(id), 'order')
  const base = new URL(c.req.url).origin
  return c.json({ ok: true, url: base + '/order-print?id=' + id + '&t=' + t })
})

app.get('/order-print', async (c) => {
  const db = c.env.DB
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  const id = num(c.req.query('id'))
  const want = String(c.req.query('t') || '')
  const good = saved && id ? await sigOf(saved, String(id), 'order') : ''
  if (!good || want !== good) return c.html('<h3>链接已失效：请在小程序里重新点「打印加工单」生成新链接。</h3>')
  const d = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first()
  if (!d) return c.html('<h3>没找到这张单。</h3>')
  const t = await getTitle(db)
  const prof = await db.prepare('SELECT * FROM party_profiles WHERE party=?').bind(d.customer).first().catch(() => null)
  const money = (v) => Number(v || 0).toFixed(2)
  const ST = ['待加工', '加工中', '已交付']
  const left = Math.max(0, num(d.price) - num(d.paid) - num(d.written_off))
  const pageBody = `
<h1>${escHtml(t.title || '加工单')}</h1>
<div class="sub">加工单 / 送货单（第 ${escHtml(String(d.id))} 号）</div>
<div class="meta"><div>客户：<b>${escHtml(d.customer || '')}</b></div><div>开单日期：${escHtml(String(d.created_at || '').slice(0, 10))}</div><div>联系电话：${escHtml((prof && prof.phone) || '')}</div><div>约定收款：${escHtml(String(d.due_date || '').slice(0, 10) || '—')}</div></div>
<table>
<thead><tr><th style="width:38%">产品 / 工序</th><th>数量</th><th class="n">金额（元）</th></tr></thead>
<tbody>
<tr><td>${escHtml(d.item_name || '—')}</td><td>按实际</td><td class="n">${money(d.price)}</td></tr>
<tr><td colspan="2">已收</td><td class="n">${money(d.paid)}</td></tr>
<tr class="total"><td colspan="2">未收</td><td class="n">${money(left)}</td></tr>
</tbody></table>
<div class="sum"><table>
<tr><td>当前工序</td><td class="n">${escHtml(ST[num(d.status)] || '待加工')}${d.progress ? '（' + escHtml(d.progress) + '）' : ''}</td></tr>
<tr><td>经手人</td><td class="n">${escHtml(d.operator || '—')}</td></tr>
</table></div>
<div class="tip">备注：${escHtml(t.note || '')}　货到请当场验收，数量和外观有异议请在签收时注明。</div>
`
  return c.html(a4Page({
    title: '加工单 ' + (d.customer || '') + ' 第' + d.id + '号',
    body: pageBody,
    extraCss: '.meta{display:flex;flex-wrap:wrap;gap:6px 24px;margin:6px 0 12px}.meta div{min-width:45%}table{width:100%;border-collapse:collapse}th,td{border:1px solid #333;padding:6px 8px;font-size:13px}th{background:#f4f6f8;text-align:left}.sum{margin-top:10px}.sum table{width:60%;margin-left:auto}.sum td{border:0;padding:3px 6px}',
    sign: '<span>客户签收（签字 / 日期）</span><span>我方经手（签字 / 日期）</span>',
    tip: '这张单只认单据号和签名，凭这条链接打开就能打印；改单请在小程序里改，重新生成链接。'
  }))
})

app.get('/report-print', async (c) => {
  const db = c.env.DB
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  const mm = String(c.req.query('month') || month()).slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(mm)) return c.html('<h3>月份格式不对（应为 2026-11）</h3>')
  const want = String(c.req.query('t') || '')
  const good = saved ? await sigOf(saved, 'report:' + mm, 'rp') : ''
  if (!good || want !== good) return c.html('<h3>链接已失效：请在小程序里重新点「打印报表」生成新链接。</h3>')
  const head = await getTitle(db)
  const snap = await snapOf(db, mm)
  const yr = mm.slice(0, 4)
  // 本年累计（性能：原来是逐月 snapOf，一个月 15 条查询、11 个月就 40 秒；改成 1 条聚合）
  const yFrom = `${yr}-01`
  const R = "substr(created_at,1,7)>=? AND substr(created_at,1,7)<=?"
  const yAgg = ((await db.prepare(`SELECT
    (SELECT COALESCE(SUM(price),0) FROM orders WHERE ${R}) yo,
    (SELECT COALESCE(SUM(amount),0) FROM payables WHERE ${R}) yp,
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE ${CASH_EXP_WHERE} AND ${R}) yce,
    (SELECT COALESCE(SUM(COALESCE(cost,0)),0) FROM orders WHERE ${R}) ym,
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE ref_type='amort' AND ${R}) ya,
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE ref_type='dep' AND ${R}) yd,
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE ref_type='debt_int' AND ${R}) yac`)
    .bind(yFrom, mm, yFrom, mm, yFrom, mm, yFrom, mm, yFrom, mm, yFrom, mm, yFrom, mm).first()) || {})
  const yOrder = num(yAgg.yo); const yPayable = num(yAgg.yp); const yCashExp = num(yAgg.yce)
  const yMat = num(yAgg.ym); const yAmort = num(yAgg.ya); const yDep = num(yAgg.yd); const yAccrue = num(yAgg.yac)
  const yCost = round2(yMat + yCashExp + yAmort + yDep + yAccrue)
  const yProfit = round2(yOrder - yCost)
  const cats = (await db.prepare("SELECT category, COALESCE(SUM(amount),0) t FROM ledger WHERE direction='out' AND cash=1 AND ref_type IN ('expense','fixed') AND substr(created_at,1,7)=? GROUP BY category ORDER BY t DESC").bind(mm).all()).results
  const accounts = (await db.prepare('SELECT * FROM accounts ORDER BY id').all()).results
  const bal = await accountBalances(db)
  const money = (n) => Number(n || 0).toFixed(2)
  const rows = (arr) => arr.map((r) => `<tr><td>${r[0]}</td><td class="n">${r[1]}</td></tr>`).join('')
  const catRows = cats.map((x) => `<tr><td>　${x.category || '其他'}</td><td class="n">${money(x.t)}</td></tr>`).join('')
  const accRows = (bal.accounts || []).map((a) => `<tr><td>　${a.name}</td><td class="n">${money(a.balance)}</td></tr>`).join('')
  const pageBody = `
<h1>${(head && head.value) || '经营报表'}</h1>
<div class="sub">报表期间：${mm}（截至 ${snap.period_end}）　单位：元${snap.archived ? '　<b>· 按 ' + mm + ' 月结快照出表</b>' : ''}</div>

<h2>一、利润表（${mm}）</h2>
<table>
<tr><th>项目</th><th class="n">本月</th><th class="n">本年累计</th></tr>
<tr><td>营业收入（接单金额）</td><td class="n">${money(snap.order_add)}</td><td class="n">${money(yOrder)}</td></tr>
<tr><td>材料·外协成本</td><td class="n">${money(num(snap.mat_cost))}</td><td class="n">${money(yMat)}</td></tr>
<tr><td>　本月赊购（备查，等付款时进现金流）</td><td class="n">${money(snap.payable_add)}</td><td class="n">${money(yPayable)}</td></tr>
<tr><td>现金支出</td><td class="n">${money(snap.cash_expense)}</td><td class="n">${money(yCashExp)}</td></tr>
${catRows}
<tr><td>　摊销（待摊费用）</td><td class="n">${money(snap.amort)}</td><td class="n">${money(yAmort)}</td></tr>
<tr><td>　折旧</td><td class="n">${money(snap.dep)}</td><td class="n">${money(yDep)}</td></tr>
<tr><td>　预提利息</td><td class="n">${money(snap.accrue_int)}</td><td class="n">${money(yAccrue)}</td></tr>
<tr class="total"><td>成本合计</td><td class="n">${money(snap.cost)}</td><td class="n">${money(yCost)}</td></tr>
<tr class="total"><td>净利（权责口径）</td><td class="n ${snap.profit >= 0 ? 'green' : 'red'}">${money(snap.profit)}</td><td class="n ${yProfit >= 0 ? 'green' : 'red'}">${money(yProfit)}</td></tr>
<tr><td>净利率</td><td class="n">${snap.margin}%</td><td class="n">${yOrder > 0 ? round2((yProfit / yOrder) * 100) : 0}%</td></tr>
</table>

<h2>二、资产负债表（${snap.period_end} 期末）</h2>
<table>
<tr><th>资产</th><th class="n">金额</th></tr>
<tr><td>货币资金（账户合计）</td><td class="n">${money(snap.cash_balance)}</td></tr>
${accRows}
<tr><td>应收账款（别人欠我）</td><td class="n">${money(snap.ar_left)}</td></tr>
<tr class="total"><td>资产合计</td><td class="n">${money(round2(snap.cash_balance + snap.ar_left))}</td></tr>
</table>
<table>
<tr><th>负债与所有者权益</th><th class="n">金额</th></tr>
<tr><td>应付账款（我欠供应商）</td><td class="n">${money(snap.ap_left)}</td></tr>
<tr><td>借款余额</td><td class="n">${money(snap.debt_left)}</td></tr>
<tr class="total"><td>负债合计</td><td class="n">${money(round2(snap.ap_left + snap.debt_left))}</td></tr>
<tr><td>所有者权益（净资产）</td><td class="n ${snap.net_worth >= 0 ? 'green' : 'red'}">${money(snap.net_worth)}</td></tr>
<tr class="total"><td>负债与权益合计</td><td class="n">${money(round2(snap.ap_left + snap.debt_left + snap.net_worth))}</td></tr>
</table>

<h2>三、本月现金收支</h2>
<table>
<tr><td>现金收入</td><td class="n">${money(snap.income)}</td></tr>
<tr><td>现金支出</td><td class="n">${money(snap.outcome)}</td></tr>
<tr class="total"><td>净现金</td><td class="n ${snap.net_cash >= 0 ? 'green' : 'red'}">${money(snap.net_cash)}</td></tr>
</table>
<div class="sub">本月单据：应收 ${snap.order_count} 张 · 应付 ${snap.payable_count} 张 · 流水 ${snap.ledger_count} 条</div>

<div class="sub" style="margin-top:18px">本表按「现金支出 + 摊销 + 折旧 + 预提利息」口径计算成本，与小程序内数据一致。</div>
`
  const extraCss = `h2{border-left-color:#1f6feb}`
  return c.html(a4Page({
    title: `${(head && head.value) || '经营报表'} ${mm}`,
    body: pageBody,
    extraCss,
    sign: `<span>制表：____________</span><span>复核：____________</span><span>日期：${now().slice(0, 10)}</span>`,
    btn: '🖨 打印 / 存 PDF',
  }))
})

// ==================== 智能粘贴解析（对账/导入前先看预览） ====================
const toHalf = (t) => String(t || '')
  .replace(/[\uff10-\uff19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
  .replace(/[\uff0c\u3001;\uff1b|]/g, ',')
  .replace(/[\uff08]/g, '(').replace(/[\uff09]/g, ')')
  .replace(/[¥￥$]/g, ' ')
  .replace(/\u5143|\u5757|\u5143\u6574/g, ' ')
  .replace(/(\d+(?:\.\d+)?)\s*\u4e07/g, (m, d) => String(Number(d) * 10000))
  .replace(/\t/g, ',')
  .replace(/\u3000/g, ' ')
const DATE_RE = /(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})|(\d{1,2})[-.\/](\d{1,2})(?!\d)/
const looksDate = (t) => DATE_RE.test(t)
const parseLines = (text) => String(text || '').split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !/^(客户|供应商|产品|金额|名称|日期|备注)/.test(x))

// 把一行拆成 {names[], nums[], date}
const splitLoose = (line) => {
  const t = toHalf(line)
  let date = ''
  const dm = t.match(DATE_RE)
  if (dm) {
    date = dm[1] ? `${dm[1]}-${String(dm[2]).padStart(2, '0')}-${String(dm[3]).padStart(2, '0')}` : `${String(dm[4]).padStart(2, '0')}-${String(dm[5]).padStart(2, '0')}`
  }
  const cleaned = t.replace(DATE_RE, ' ').replace(/[,\s]+/g, ' ').trim()
  const names = []
  const nums = []
  for (const tok of cleaned.split(' ')) {
    if (!tok) continue
    const isNum = /^-?\d+(\.\d+)?$/.test(tok)
    if (isNum) nums.push(Number(tok))
    else if (/\d/.test(tok)) {
      // 如 5000.00元 或 3.5万 已处理；混合词里抽数字，剩下的当名字
      const n = tok.match(/-?\d+(\.\d+)?/g)
      if (n) nums.push(Number(n.join('')))
      const rest = tok.replace(/-?\d+(\.\d+)?/g, '').trim()
      if (rest) names.push(rest)
    } else names.push(tok)
  }
  return { names, nums, date }
}

// 解析成结构化行（按导入类型）
const parseImportRows = (type, text) => {
  const out = []
  for (const line of parseLines(text)) {
    const { names, nums, date } = splitLoose(line)
    const row = { line, ok: false, error: '', party: '', item: '', amount: 0, cost: 0, category: '', date }
    if (!names.length) { row.error = '没看懂这行（缺名字）'; out.push(row); continue }
    row.party = names[0]
    if (type === 'ar' || type === 'ar_init') {
      row.item = names[1] || (type === 'ar' ? '对账导入' : '期初欠款')
      row.amount = nums[0] || 0
      row.cost = nums[1] || 0
      if (type === 'ar' && nums.length > 1 && names.length > 1) row.cost = nums[1]
    } else if (type === 'ap' || type === 'ap_init') {
      row.amount = nums[0] || 0
      row.item = names[1] || (type === 'ap' ? '' : '期初欠款')
    } else if (type === 'expense') {
      row.amount = nums[0] || 0
      row.category = names[0] || '其他'
      row.item = names[1] || ''
    } else if (type === 'loan') {
      row.amount = nums[0] || 0
      row.item = names[1] || ''
    } else if (type === 'reimb') {
      row.amount = nums[0] || 0
      row.category = names[1] || '其他'
      row.item = names[2] || ''
    }
    if (!(row.amount > 0)) { row.error = row.error || '没认出金额'; out.push(row); continue }
    row.ok = true
    out.push(row)
  }
  return out
}

app.post('/parse-import', async (c) => {
  const b = await c.req.json()
  const db = c.env.DB
  const type = String(b.type || 'ar')
  const rows = parseImportRows(type, b.text)
  const good = rows.filter((r) => r.ok)
  const bad = rows.filter((r) => !r.ok)
  // 已知往来单位（用于标出"新客户"与拼写相近的名字）
  const known = type === 'ap' || type === 'ap_init'
    ? (await db.prepare("SELECT DISTINCT supplier AS p FROM payables WHERE supplier<>''").all()).results.map((x) => x.p)
    : (await db.prepare("SELECT DISTINCT customer AS p FROM orders WHERE customer<>''").all()).results.map((x) => x.p)
  const near = (a, b2) => {
    if (!a || !b2) return false
    if (a === b2) return true
    const A = a.replace(/[（(].*?[)）]|有限公司|公司|厂|店|\s/g, '')
    const B = b2.replace(/[（(].*?[)）]|有限公司|公司|厂|店|\s/g, '')
    return A === B || (A.length >= 2 && B.length >= 2 && (A.includes(B) || B.includes(A)))
  }
  const seen = new Set(known)
  const parties = []
  for (const r of good) {
    const hit = known.find((k) => near(k, r.party)) || ''
    if (!parties.some((x) => x.name === r.party)) parties.push({ name: r.party, known: hit, is_new: !hit })
    if (hit) seen.add(hit)
  }
  const total = round2(good.reduce((a, r) => a + num(r.amount), 0))
  const costTotal = round2(good.reduce((a, r) => a + num(r.cost), 0))
  return c.json({
    type, count: good.length, bad_count: bad.length, total, cost_total: costTotal,
    profit: round2(total - costTotal),
    rows: rows.slice(0, 200), parties, new_parties: parties.filter((x) => x.is_new).map((x) => x.name)
  })
})

// 把「预览确认过」的结构化行直接入账（宽松粘贴后走这里）
app.post('/import-rows', async (c) => {
  const b = await c.req.json()
  const db = c.env.DB
  const type = String(b.type || 'ar')
  const rows = Array.isArray(b.rows) ? b.rows.filter((r) => r && r.ok !== false && num(r.amount) > 0) : []
  if (!rows.length) return c.json({ error: '没有可入账的行' }, 400)
  const arr = rows.map((r) => {
    const date = r.date || ''
    if (type === 'ar') return [r.party, r.item || '批量导入', num(r.amount), num(r.cost) || '', date].filter((x, i) => !(i === 3 && (x === '' || x === 0)))
    if (type === 'ar_init') return [r.party, num(r.amount), date]
    if (type === 'ap') return [r.party, num(r.amount), r.item || '', date]
    if (type === 'ap_init') return [r.party, num(r.amount)]
    if (type === 'expense') return [num(r.amount), r.category || '', r.item || '', date]
    if (type === 'loan') return [r.party, num(r.amount), r.item || '', date]
    if (type === 'reimb') return [r.party, num(r.amount), r.category || '', r.item || '', date]
    return [r.party, num(r.amount), date]
  })
  const r = await importRows(db, type, arr, { confirmDup: !!b.confirm_dup, by: act(c) })
  const n = (r && typeof r === 'object') ? num(r.imported) : num(r)
  const locked = (r && typeof r === 'object') ? num(r.skipped_locked) : 0
  const dup = (r && typeof r === 'object' && Array.isArray(r.dup)) ? r.dup : []
  await logImport(db, type, r, 'preview')
  return c.json({ ok: true, imported: n, skipped_locked: locked, dup, dup_count: dup.length, count: rows.length, total: num(r && r.total) })
})

// 对账核对：粘贴「客户 金额」，和系统里当前未结金额比
const reconcileCore = async (db, type, rows) => {
  const sys = type === 'ap'
    ? (await db.prepare("SELECT supplier AS party, COALESCE(SUM(CASE WHEN amount - COALESCE(paid,0) - COALESCE(written_off,0) > 0 THEN amount - COALESCE(paid,0) - COALESCE(written_off,0) ELSE 0 END),0) AS left FROM payables GROUP BY supplier").all()).results
    : (await db.prepare("SELECT customer AS party, COALESCE(SUM(CASE WHEN price - COALESCE(paid,0) - COALESCE(written_off,0) > 0 THEN price - COALESCE(paid,0) - COALESCE(written_off,0) ELSE 0 END),0) AS left FROM orders GROUP BY customer").all()).results
  const norm = (t) => String(t || '').replace(/[（(].*?[)）]|有限公司|公司|厂|店|\s/g, '')
  const hit = (name) => {
    const n = norm(name)
    const exact = sys.find((x) => x.party === name)
    if (exact) return exact
    return sys.find((x) => { const m = norm(x.party); return m && n && (m === n || (m.length >= 2 && n.length >= 2 && (m.includes(n) || n.includes(m)))) }) || null
  }
  const out = []
  let matchN = 0; let diffN = 0
  for (const r of rows) {
    const s = hit(r.party)
    const system = s ? round2(num(s.left)) : 0
    const imported = round2(num(r.amount))
    const diff = round2(imported - system)
    let state = 'match'
    if (!s) state = 'new'
    else if (Math.abs(diff) < 0.01) state = 'match'
    else state = diff > 0 ? 'more' : 'less'
    if (state === 'match') matchN += 1
    if (state === 'more' || state === 'less') diffN += 1
    out.push({ party: r.party, matched: s ? s.party : '', imported, system, diff, state })
  }
  const newN = out.filter((x) => x.state === 'new').length
  return {
    type, month: now().slice(0, 7), count: out.length, match_count: matchN, diff_count: diffN,
    new_count: newN, add_count: diffN + newN,
    imported_total: round2(out.reduce((a, x) => a + x.imported, 0)),
    system_total: round2(out.reduce((a, x) => a + x.system, 0)),
    rows: out
  }
}

app.post('/reconcile', async (c) => {
  const b = await c.req.json()
  const type = String(b.type || 'ar')
  const rows = parseImportRows(type === 'ap' ? 'ap' : 'ar', b.text).filter((r) => r.ok)
  return c.json(await reconcileCore(c.env.DB, type, rows))
})

// ===== 对账台账：每次核对的结果留一条，月底能看「谁对过、还差几家」 =====
app.post('/recon-save', async (c) => {
  const b = await c.req.json()
  const db = c.env.DB
  const type = String(b.type || 'ar')
  const month = String(b.month || now().slice(0, 7)).slice(0, 7)
  const rows = Array.isArray(b.rows) ? b.rows : []
  if (!rows.length) return c.json({ error: '没有核对结果可保存' }, 400)
  let n = 0
  for (const r of rows) {
    const party = String(r.party || '').trim()
    if (!party) continue
    const imported = round2(num(r.imported))
    const system = round2(num(r.system))
    const st = String(r.state || '')
    await db.prepare('INSERT INTO recon_log (month, type, party, imported, system, diff, state, done, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(month, type, party, imported, system, round2(imported - system), st, st === 'match' ? 1 : 0, st === 'match' ? '已核对，两家金额一致' : '', now()).run()
    n++
  }
  await logAudit(db, '对账台账', type, `${month} 记 ${n} 家核对结果`)
  return c.json({ ok: true, saved: n, month, type })
})

// 价格表：从历史单据里自动提炼「客户 × 产品」的成交价，录单时带出来、对账时查异常
app.get('/price-book', async (c) => {
  const db = c.env.DB
  const party = String(c.req.query('party') || '').trim()
  const kw = String(c.req.query('kw') || '').trim()
  let sql = `SELECT customer AS party, COALESCE(NULLIF(item_name,''),'（没写产品）') AS item,
      COUNT(*) AS cnt, COALESCE(SUM(price),0) AS total,
      MIN(price) AS min_price, MAX(price) AS max_price, AVG(price) AS avg_price,
      MAX(created_at) AS last_at
    FROM orders WHERE 1=1`
  const binds = []
  if (party) { sql += ' AND customer=?'; binds.push(party) }
  if (kw) { sql += " AND (customer LIKE ? OR item_name LIKE ?)"; binds.push('%' + kw + '%', '%' + kw + '%') }
  sql += ' GROUP BY customer, item ORDER BY last_at DESC LIMIT 200'
  const rows = ((await db.prepare(sql).bind(...binds).all()).results || []).map((r) => ({
    party: r.party, item: r.item, cnt: num(r.cnt), total: round2(num(r.total)),
    min_price: round2(num(r.min_price)), max_price: round2(num(r.max_price)),
    avg_price: round2(num(r.avg_price)), last_at: String(r.last_at || '').slice(0, 10)
  }))
  // 补上最近一次的单价与成本
  if (rows.length) {
    const lastRows = ((await db.prepare(`SELECT customer, COALESCE(NULLIF(item_name,''),'（没写产品）') AS item, price, COALESCE(cost,0) AS cost, created_at
      FROM orders ORDER BY id DESC LIMIT 800`).all()).results || [])
    const m = {}
    for (const r of lastRows) {
      const k = r.customer + '\u0001' + r.item
      if (!m[k]) m[k] = { last_price: round2(num(r.price)), last_cost: round2(num(r.cost)), last_date: String(r.created_at || '').slice(0, 10) }
    }
    for (const r of rows) Object.assign(r, m[r.party + '\u0001' + r.item] || { last_price: 0, last_cost: 0, last_date: r.last_at })
    for (const r of rows) r.gross_pct = r.last_price > 0 ? round2(((r.last_price - r.last_cost) / r.last_price) * 100) : null
  }
  const parties = Array.from(new Set(rows.map((x) => x.party)))
  return c.json({ ok: true, rows, count: rows.length, parties, party_filter: party })
})

// 录单时查这个客户这个产品上次多少钱
app.get('/price-lookup', async (c) => {
  const db = c.env.DB
  const party = String(c.req.query('party') || '').trim()
  const item = String(c.req.query('item') || '').trim()
  if (!party) return c.json({ ok: true, found: false })
  const binds = [party]
  let where = 'customer=?'
  if (item) { where += " AND item_name=?"; binds.push(item) }
  const last = await db.prepare(`SELECT price, COALESCE(cost,0) AS cost, created_at, COALESCE(NULLIF(item_name,''),'') AS item FROM orders WHERE ${where} ORDER BY id DESC LIMIT 1`).bind(...binds).first()
  const agg = await db.prepare(`SELECT COUNT(*) AS cnt, AVG(price) AS avg_price, MAX(price) AS max_price, MIN(price) AS min_price FROM orders WHERE ${where}`).bind(...binds).first()
  const exists = await db.prepare('SELECT COUNT(*) AS c FROM orders WHERE customer=?').bind(party).first()
  if (!last) return c.json({ ok: true, found: false, party, item, seen_party: num(exists && exists.c) > 0 })
  return c.json({
    ok: true, found: true, party, item: last.item || item,
    last_price: round2(num(last.price)), last_cost: round2(num(last.cost)),
    last_date: String(last.created_at || '').slice(0, 10),
    days_ago: daysSince(last.created_at),
    cnt: num(agg && agg.cnt), avg_price: round2(num(agg && agg.avg_price)),
    min_price: round2(num(agg && agg.min_price)), max_price: round2(num(agg && agg.max_price)),
    text: `上次给 ${party}${last.item ? ' 的「' + last.item + '」' : ''} 报 ${round2(num(last.price))} 元${num(last.cost) > 0 ? '（成本 ' + round2(num(last.cost)) + '）' : ''}，${daysSince(last.created_at)} 天前`
  })
})

// 价格异常：单价明显偏离这个客户这个产品的历史均价（录错、报错价的提醒）
app.get('/price-anomaly', async (c) => {
  const db = c.env.DB
  const days = Math.min(365, Math.max(7, num(c.req.query('days'), 90)))
  const pctLimit = Math.min(100, Math.max(5, num(c.req.query('pct'), 15)))
  const since = new Date(Date.now() + TZ_MS - days * 86400000).toISOString()
  const avgRows = ((await db.prepare(`SELECT customer, COALESCE(NULLIF(item_name,''),'（没写产品）') AS item, AVG(price) AS avg_price, COUNT(*) AS cnt
    FROM orders GROUP BY customer, item HAVING cnt>=2`).all()).results || [])
  const am = {}
  for (const r of avgRows) am[r.customer + '\u0001' + r.item] = { avg: round2(num(r.avg_price)), cnt: num(r.cnt) }
  const recent = ((await db.prepare(`SELECT id, customer, COALESCE(NULLIF(item_name,''),'（没写产品）') AS item, price, paid, created_at
    FROM orders WHERE created_at >= ? ORDER BY id DESC LIMIT 300`).bind(since).all()).results || [])
  const rows = []
  for (const r of recent) {
    const base = am[r.customer + '\u0001' + r.item]
    if (!base || base.avg <= 0) continue
    const pct = round2(((num(r.price) - base.avg) / base.avg) * 100)
    if (Math.abs(pct) < pctLimit) continue
    rows.push({
      id: r.id, party: r.customer, item: r.item, price: round2(num(r.price)), avg_price: base.avg,
      pct, dir: pct > 0 ? 'high' : 'low', hist_cnt: base.cnt,
      date: String(r.created_at || '').slice(0, 10), paid: round2(num(r.paid))
    })
  }
  rows.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
  return c.json({
    ok: true, days, pct_limit: pctLimit, rows, count: rows.length,
    advice: rows.length
      ? `近 ${days} 天有 ${rows.length} 笔单价偏离该客户该产品的老价超过 ${pctLimit}%${rows.some((x) => x.dir === 'low') ? '，其中低的几笔建议核对是不是漏算工序' : ''}。`
      : `近 ${days} 天价格都对得上（偏离都在 ${pctLimit}% 以内）。`
  })
})

// 对账差异一键处理：我少记 → 直接补一张单；对不上但不补 → 标记处理完，台账留痕
app.post('/recon-fix', async (c) => {
  const b = await c.req.json()
  const db = c.env.DB
  const type = b.type === 'ap' ? 'ap' : 'ar'
  const party = String(b.party || '').trim()
  const month = String(b.month || now().slice(0, 7)).slice(0, 7)
  const mode = b.mode === 'ignore' ? 'ignore' : (b.mode === 'cut' ? 'cut' : 'add')
  const amount = round2(num(b.amount))
  if (!party) return c.json({ error: '缺少单位名称' }, 400)
  const created = `${month}-01T00:00:00.000Z`
  let newId = null
  if (mode === 'add') {
    if (!(amount > 0)) return c.json({ error: '补记的金额要大于 0' }, 400)
    if (await isMonthLocked(db, month)) return c.json({ error: `${month} 已结账锁定，先解锁再补记` }, 403)
    const due = await termDue(db, party, created, type)
    if (type === 'ar') {
      const r = await db.prepare('INSERT INTO orders (customer, item_name, price, cost, status, paid, created_at, due_date, operator) VALUES (?,?,?,?,0,0,?,?,?)')
        .bind(party, '对账补记', amount, 0, created, due, '对账').run()
      newId = r.meta && r.meta.last_row_id
    } else {
      const r = await db.prepare('INSERT INTO payables (supplier, amount, paid, category, remark, created_at, due_date, operator) VALUES (?,?,0,?,?,?,?,?)')
        .bind(party, amount, '对账', '对账补记', created, due, '对账').run()
      newId = r.meta && r.meta.last_row_id
    }
    await logAudit(db, '对账补记', type, `${party} 补记 ${amount}`)
  } else if (mode === 'cut') {
    // 我多记了：对方对账单上没有这么多 → 把差额核销掉（不动现金，只抹往来）
    const imported0 = round2(num(b.imported))
    const system0 = round2(num(b.system))
    const gap = round2(num(b.gap) > 0 ? num(b.gap) : system0 - imported0)
    if (!(gap > 0)) return c.json({ error: '要核销的差额要大于 0（这个应该是「我少记」，用补记）' }, 400)
    if (await isMonthLocked(db, month)) return c.json({ error: `${month} 已结账锁定，先解锁再核销` }, 403)
    const isAp2 = type === 'ap'
    const T2 = isAp2 ? 'payables' : 'orders'
    const P2 = isAp2 ? 'supplier' : 'customer'
    const A2 = isAp2 ? 'amount' : 'price'
    const open = (await db.prepare(`SELECT id, ${A2} AS amt, COALESCE(paid,0) AS paid, COALESCE(written_off,0) AS wo, created_at FROM ${T2} WHERE ${P2}=? AND ${A2} - COALESCE(paid,0) - COALESCE(written_off,0) > 0.005 ORDER BY created_at, id`).bind(party).all()).results || []
    if (!open.length) return c.json({ error: '这家没有未结的单，核销不了' }, 400)
    let leftCut = gap
    let cutDone = 0
    for (const o of open) {
      if (leftCut <= 0.005) break
      if (await isMonthLocked(db, (o.created_at || '').slice(0, 7))) continue
      const can = round2(num(o.amt) - num(o.paid) - num(o.wo))
      const use = round2(Math.min(can, leftCut))
      if (!(use > 0.005)) continue
      await db.batch([
        db.prepare(`UPDATE ${T2} SET written_off=COALESCE(written_off,0)+?, rev=COALESCE(rev,0)+1 WHERE id=?`).bind(use, o.id),
        db.prepare('INSERT INTO writeoffs (ref_type, ref_id, party, amount, reason, created_at) VALUES (?,?,?,?,?,?)')
          .bind(isAp2 ? 'payable' : 'order', num(o.id), party, use, '对账差异：对方对账单上没有这笔', now())
      ])
      leftCut = round2(leftCut - use)
      cutDone = round2(cutDone + use)
    }
    if (!(cutDone > 0)) return c.json({ error: '这些单都在已结账月份，先解锁再核销' }, 403)
    await logAudit(db, isAp2 ? '核销应付差额' : '核销应收差额', party, `${party} 对账核销 ¥${cutDone}`)
    b.cut_amount = cutDone
    b.cut_left = leftCut
  }
  const imported = round2(num(b.imported))
  const system = round2(num(b.system))
  const state = String(b.state || (mode === 'add' ? 'more' : mode === 'cut' ? 'less' : 'match'))
  const note = mode === 'add' ? `补记 ${amount} 元` : (mode === 'cut' ? `核销差额 ${round2(num(b.cut_amount))} 元（对方对账单上没有）` : '核对过，不补记')
  // 已经有这家待处理的核对记录就把它改成已处理，不重复堆一条
  const old = await db.prepare('SELECT id FROM recon_log WHERE month=? AND type=? AND party=? AND done=0 ORDER BY id DESC').bind(month, type, party).first()
  if (old) {
    await db.prepare('UPDATE recon_log SET imported=?, system=?, diff=?, state=?, done=1, note=? WHERE id=?')
      .bind(imported, system, round2(imported - system), state, note, old.id).run()
  } else {
    await db.prepare('INSERT INTO recon_log (month, type, party, imported, system, diff, state, done, note, created_at) VALUES (?,?,?,?,?,?,?,1,?,?)')
      .bind(month, type, party, imported, system, round2(imported - system), state, note, now()).run()
  }
  return c.json({ ok: true, id: newId, mode, party, amount, month, type, cut_amount: round2(num(b.cut_amount)), cut_left: round2(num(b.cut_left)) })
})

// 一家的「对账结论」：期初欠多少、本月新增、已收、核销、期末欠多少，加上这个月核对过什么
async function conclusionOf(db, type, party, month) {
  const isAp = type === 'ap'
  const T = isAp ? 'payables' : 'orders'
  const P = isAp ? 'supplier' : 'customer'
  const A = isAp ? 'amount' : 'price'
  const L = `${A} - COALESCE(paid,0) - COALESCE(written_off,0)`
  const m0 = `${month}-01`
  const m1 = `${month}-31`
  const [open0, add, paid, wo, paidBefore, woBefore] = await Promise.all([
    // 期初：这个月之前开的单的「原始金额」（不能直接用 paid，因为 paid 是累计到现在，含本月的收款）
    db.prepare(`SELECT COALESCE(SUM(${A}),0) AS v, COUNT(*) AS c FROM ${T} WHERE ${P}=? AND substr(created_at,1,10)<?`).bind(party, m0).first().catch(() => null),
    db.prepare(`SELECT COALESCE(SUM(${A}),0) AS v, COUNT(*) AS c FROM ${T} WHERE ${P}=? AND substr(created_at,1,10)>=? AND substr(created_at,1,10)<=?`).bind(party, m0, m1).first().catch(() => null),
    db.prepare(`SELECT COALESCE(SUM(l.amount),0) AS v, COUNT(*) AS c FROM ledger l JOIN ${T} t ON t.id=l.ref_id WHERE l.ref_type=? AND t.${P}=? AND substr(l.created_at,1,10)>=? AND substr(l.created_at,1,10)<=?`).bind(isAp ? 'payable' : 'order', party, m0, m1).first().catch(() => null),
    db.prepare(`SELECT COALESCE(SUM(amount),0) AS v, COUNT(*) AS c FROM writeoffs WHERE ref_type=? AND party=? AND substr(created_at,1,10)>=? AND substr(created_at,1,10)<=?`).bind(isAp ? 'payable' : 'order', party, m0, m1).first().catch(() => null),
    // 这个月之前已经收/付掉的（含老单在本月前收的钱）
    db.prepare(`SELECT COALESCE(SUM(l.amount),0) AS v FROM ledger l JOIN ${T} t ON t.id=l.ref_id WHERE l.ref_type=? AND t.${P}=? AND substr(l.created_at,1,10)<?`).bind(isAp ? 'payable' : 'order', party, m0).first().catch(() => null),
    db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM writeoffs WHERE ref_type=? AND party=? AND substr(created_at,1,10)<?`).bind(isAp ? 'payable' : 'order', party, m0).first().catch(() => null)
  ])
  const rOpen = round2(num(open0 && open0.v) - num(paidBefore && paidBefore.v) - num(woBefore && woBefore.v))
  const rAdd = round2(num(add && add.v))
  const rPaid = round2(num(paid && paid.v))
  const rWo = round2(num(wo && wo.v))
  const end = round2(rOpen + rAdd - rPaid - rWo)
  const rec = (await db.prepare('SELECT * FROM recon_log WHERE month=? AND type=? AND party=? ORDER BY id DESC LIMIT 3').bind(month, type, party).all().catch(() => ({ results: [] }))).results || []
  const cfm = await db.prepare('SELECT * FROM recon_confirm WHERE month=? AND type=? AND party=? ORDER BY id DESC LIMIT 1').bind(month, type, party).first().catch(() => null)
  const lines = [
    `对账期间：${month}`,
    `期初${isAp ? '应付' : '应收'}：${rOpen} 元`,
    `本期新增：${rAdd} 元（${num(add && add.c)} 笔）`,
    `本期${isAp ? '已付' : '已收'}：${rPaid} 元（${num(paid && paid.c)} 笔）`,
    rWo > 0 ? `本期核销：${rWo} 元` : '',
    `期末${isAp ? '应付' : '应收'}：${end} 元`,
    rec.length ? '差异处理：' + rec.map((x) => `${x.party} 单上 ${num(x.imported)} / 我这 ${num(x.system)}${x.note ? '（' + x.note + '）' : ''}`).join('；') : ''
  ].filter(Boolean)
  const text = `【对账结论 · ${month}】${party}\n` + lines.slice(1).join('\n') + `\n\n上面这笔数两边对上了就回我一句「对」，我把这期结了。`
  return { party, type, month, open: rOpen, add: rAdd, add_cnt: num(add && add.c), paid: rPaid, paid_cnt: num(paid && paid.c), wo: rWo, end, recon: rec, confirmed: !!cfm, confirmed_at: cfm ? (cfm.created_at || '').slice(0, 10) : '', lines, text }
}

// 对账结论：单家（给 party）或整批（不给 party，列出所有还欠钱或本月核对过的家）
app.get('/recon-conclusion', async (c) => {
  const db = c.env.DB
  const type = c.req.query('type') === 'ap' ? 'ap' : 'ar'
  const month = (String(c.req.query('month') || '').slice(0, 7)) || now().slice(0, 7)
  const party = String(c.req.query('party') || '').trim()
  if (party) {
    const one = await conclusionOf(db, type, party, month)
    return c.json({ ok: true, single: true, month, type, ...one })
  }
  const isAp = type === 'ap'
  const T = isAp ? 'payables' : 'orders'
  const P = isAp ? 'supplier' : 'customer'
  const A = isAp ? 'amount' : 'price'
  const L = `${A} - COALESCE(paid,0) - COALESCE(written_off,0)`
  const parties = (await db.prepare(`SELECT ${P} AS party, COALESCE(SUM(CASE WHEN ${L}>0 THEN ${L} ELSE 0 END),0) AS left FROM ${T} GROUP BY ${P} HAVING left > 0.009 ORDER BY left DESC`).all().catch(() => ({ results: [] }))).results || []
  const logParties = (await db.prepare('SELECT DISTINCT party FROM recon_log WHERE month=? AND type=?').bind(month, type).all().catch(() => ({ results: [] }))).results || []
  const names = Array.from(new Set(parties.map((x) => x.party).concat(logParties.map((x) => x.party))))
  const rows = []
  for (const nm of names.slice(0, 60)) {
    const o = await conclusionOf(db, type, nm, month)
    rows.push({ party: nm, open: o.open, add: o.add, paid: o.paid, wo: o.wo, end: o.end, confirmed: o.confirmed, confirmed_at: o.confirmed_at, text: o.text })
  }
  const totalEnd = round2(rows.reduce((a, x) => a + x.end, 0))
  const unconfirmed = rows.filter((x) => !x.confirmed).length
  return c.json({ ok: true, single: false, month, type, count: rows.length, total_end: totalEnd, unconfirmed, rows,
    all_text: rows.map((x) => x.text).join('\n\n'),
    text: rows.length ? `这个月有 ${rows.length} 家要出对账结论，期末合计 ${totalEnd} 元，还有 ${unconfirmed} 家没确认。` : '这个月没有要出对账结论的单位。' })
})

// 对方回「对」了 → 记一笔确认（同一家同月只留最新一条）
app.post('/recon-confirm', async (c) => {
  const b = await c.req.json().catch(() => ({}))
  const db = c.env.DB
  const type = b.type === 'ap' ? 'ap' : 'ar'
  const party = String(b.party || '').trim()
  const month = (String(b.month || '').slice(0, 7)) || now().slice(0, 7)
  if (!party) return c.json({ error: '缺少单位名称' }, 400)
  const o = await conclusionOf(db, type, party, month)
  const r = await db.prepare('INSERT INTO recon_confirm (month, type, party, amount, imported, system, diff, note, by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(month, type, party, o.end, num(b.imported), num(b.system), round2(num(b.imported) - num(b.system)), String(b.note || '').trim(), act(c), now()).run()
  await logAudit(db, '对账确认', party, `${month} 确认期末 ${o.end} 元`)
  return c.json({ ok: true, id: r.meta && r.meta.last_row_id, party, month, amount: o.end, text: `已记下：${party} ${month} 期末 ${o.end} 元，对方确认过。` })
})

app.get('/recon-confirm', async (c) => {
  const db = c.env.DB
  const month = String(c.req.query('month') || '').slice(0, 7)
  const type = c.req.query('type') === 'ap' ? 'ap' : (c.req.query('type') === 'ar' ? 'ar' : '')
  let sql = 'SELECT * FROM recon_confirm WHERE 1=1'
  const args = []
  if (month) { sql += ' AND month=?'; args.push(month) }
  if (type) { sql += ' AND type=?'; args.push(type) }
  sql += ' ORDER BY id DESC LIMIT 200'
  const rows = (await db.prepare(sql).bind(...args).all().catch(() => ({ results: [] }))).results || []
  return c.json({ ok: true, count: rows.length, rows: rows.map((x) => ({ id: x.id, month: x.month, type: x.type, party: x.party, amount: round2(num(x.amount)), note: x.note || '', by: x.by || '', date: (x.created_at || '').slice(0, 10) })) })
})

app.get('/recon-print-link', async (c) => {
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  const party = String(c.req.query('party') || '').trim()
  const type = c.req.query('type') === 'ap' ? 'ap' : 'ar'
  const month = (String(c.req.query('month') || '').slice(0, 7)) || now().slice(0, 7)
  if (!party) return c.json({ error: '缺少对账单位' }, 400)
  const t = await sigOf(saved, party, 'recon:' + month + ':' + type)
  const base = new URL(c.req.url).origin
  return c.json({ ok: true, url: base + '/recon-print?type=' + type + '&month=' + month + '&party=' + encodeURIComponent(party) + '&t=' + t })
})

// A4 对账确认单（双方签字用）
app.get('/recon-print', async (c) => {
  const db = c.env.DB
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  const party = String(c.req.query('party') || '').trim()
  const type = c.req.query('type') === 'ap' ? 'ap' : 'ar'
  const month = (String(c.req.query('month') || '').slice(0, 7)) || now().slice(0, 7)
  const want = String(c.req.query('t') || '')
  const good = saved && party ? await sigOf(saved, party, 'recon:' + month + ':' + type) : ''
  if (!good || want !== good) return c.html('<h3>链接已失效：请在小程序里重新生成对账确认单。</h3>')
  const o = await conclusionOf(db, type, party, month)
  const title = await getTitle(db)
  const prof = await profLine(db, party)
  const isAp = type === 'ap'
  const rows = [
    ['期初' + (isAp ? '应付' : '应收'), o.open],
    ['本期新增（' + o.add_cnt + ' 笔）', o.add],
    ['本期' + (isAp ? '已付' : '已收') + '（' + o.paid_cnt + ' 笔）', -o.paid],
    ['本期核销', -o.wo],
    ['期末' + (isAp ? '应付' : '应收'), o.end]
  ]
  const table = rows.map(([k, v], i) => `<tr${i === rows.length - 1 ? ' class="total"' : ''}><td>${escHtml(k)}</td><td class="n">${round2(v)}</td></tr>`).join('')
  const reconBlock = o.recon.length
    ? `<h2>本期核对说明</h2><table><tr><th>对账单金额</th><th>我这边金额</th><th>怎么处理的</th></tr>${o.recon.map((x) => `<tr><td class="n">${num(x.imported)}</td><td class="n">${num(x.system)}</td><td>${escHtml(x.note || (x.done ? '已处理' : '待处理'))}</td></tr>`).join('')}</table>`
    : ''
  return c.html(a4Page({
    title: `对账确认单 ${month} ${party}`,
    body: `<h1>对账确认单</h1>
<div class="sub">账期：${escHtml(month)}　制单日期：${todayIso()}</div>
<div class="who">${escHtml(title.title || '')}${title.phone ? '　电话：' + escHtml(title.phone) : ''}${title.addr ? '　地址：' + escHtml(title.addr) : ''}</div>
<div class="who">往来单位：${escHtml(party)}${prof ? '　' + escHtml(prof) : ''}</div>
<h2>${isAp ? '应付' : '应收'}结算</h2>
<table>${table}</table>
${reconBlock}
<div class="sub" style="text-align:left;margin-top:14px">双方核对无误，以上金额经确认后作为本账期结算依据。</div>`,
    extraCss: `.sum{margin-left:auto;width:60%}`,
    sign: `<span>我方（盖章/签字）：____________</span><span>对方（盖章/签字）：____________</span><span>日期：____________</span>`,
    tip: '这份确认单由小程序生成，签字后双方各留一份。',
  }))
})

// 一次把整批差异处理完：我少记→补单，我多记→核销差额，不处理→留痕
app.post('/recon-fix-batch', async (c) => {
  const b = await c.req.json().catch(() => ({}))
  const db = c.env.DB
  const type = b.type === 'ap' ? 'ap' : 'ar'
  const month = String(b.month || now().slice(0, 7)).slice(0, 7)
  const rows = Array.isArray(b.rows) ? b.rows : []
  if (!rows.length) return c.json({ error: '没有要处理的差异' }, 400)
  if (await isMonthLocked(db, month)) return c.json({ error: `${month} 已结账锁定，先解锁再处理` }, 403)
  const done = []
  let added = 0; let cut = 0; let skipped = 0
  for (const r of rows) {
    const party = String(r.party || '').trim()
    if (!party) { skipped++; continue }
    const imported = round2(num(r.imported))
    const system = round2(num(r.system))
    const state = String(r.state || '')
    const gap = round2(Math.abs(imported - system))
    try {
      if (state === 'more') {
        if (!(gap > 0)) { skipped++; continue }
        const due = await termDue(db, party, `${month}-01T00:00:00.000Z`, type)
        const created = `${month}-01T00:00:00.000Z`
        if (type === 'ar') {
          await db.prepare('INSERT INTO orders (customer, item_name, price, cost, status, paid, created_at, due_date, operator) VALUES (?,?,?,0,0,0,?,?,?)')
            .bind(party, '对账补记', gap, created, due, '对账').run()
        } else {
          await db.prepare('INSERT INTO payables (supplier, amount, paid, category, remark, created_at, due_date, operator) VALUES (?,?,0,?,?,?,?,?)')
            .bind(party, gap, '对账', '对账补记', created, due, '对账').run()
        }
        added = round2(added + gap)
        done.push({ party, state, mode: 'add', amount: gap })
      } else if (state === 'less') {
        const isAp2 = type === 'ap'
        const T2 = isAp2 ? 'payables' : 'orders'
        const P2 = isAp2 ? 'supplier' : 'customer'
        const A2 = isAp2 ? 'amount' : 'price'
        const open = (await db.prepare(`SELECT id, ${A2} AS amt, COALESCE(paid,0) AS paid, COALESCE(written_off,0) AS wo, created_at FROM ${T2} WHERE ${P2}=? AND ${A2} - COALESCE(paid,0) - COALESCE(written_off,0) > 0.005 ORDER BY created_at, id`).bind(party).all()).results || []
        let leftCut = gap
        let cutDone = 0
        for (const o of open) {
          if (leftCut <= 0.005) break
          if (await isMonthLocked(db, (o.created_at || '').slice(0, 7))) continue
          const can = round2(num(o.amt) - num(o.paid) - num(o.wo))
          const use = round2(Math.min(can, leftCut))
          if (!(use > 0.005)) continue
          await db.batch([
            db.prepare(`UPDATE ${T2} SET written_off=COALESCE(written_off,0)+?, rev=COALESCE(rev,0)+1 WHERE id=?`).bind(use, o.id),
            db.prepare('INSERT INTO writeoffs (ref_type, ref_id, party, amount, reason, created_at) VALUES (?,?,?,?,?,?)')
              .bind(isAp2 ? 'payable' : 'order', num(o.id), party, use, '对账差异：对方对账单上没有这笔', now())
          ])
          leftCut = round2(leftCut - use)
          cutDone = round2(cutDone + use)
        }
        cut = round2(cut + cutDone)
        done.push({ party, state, mode: 'cut', amount: cutDone, left: leftCut })
      } else if (state === 'new') {
        const due = await termDue(db, party, `${month}-01T00:00:00.000Z`, type)
        if (type === 'ar') {
          await db.prepare('INSERT INTO orders (customer, item_name, price, cost, status, paid, created_at, due_date, operator) VALUES (?,?,?,0,0,0,?,?,?)')
            .bind(party, '对账新建', imported, `${month}-01T00:00:00.000Z`, due, '对账').run()
        } else {
          await db.prepare('INSERT INTO payables (supplier, amount, paid, category, remark, created_at, due_date, operator) VALUES (?,?,0,?,?,?,?,?)')
            .bind(party, imported, '对账', '对账新建', `${month}-01T00:00:00.000Z`, due, '对账').run()
        }
        added = round2(added + imported)
        done.push({ party, state, mode: 'new', amount: imported })
      } else { skipped++; continue }
      // 台账留痕
      const note = state === 'less' ? `核销差额 ${gap} 元（对方对账单上没有）` : (state === 'new' ? `新建 ${imported} 元（系统里原来没这家）` : `补记 ${gap} 元`)
      const old = await db.prepare('SELECT id FROM recon_log WHERE month=? AND type=? AND party=? AND done=0 ORDER BY id DESC').bind(month, type, party).first()
      if (old) {
        await db.prepare('UPDATE recon_log SET imported=?, system=?, diff=?, state=?, done=1, note=? WHERE id=?')
          .bind(imported, system, round2(imported - system), state, note, old.id).run()
      } else {
        await db.prepare('INSERT INTO recon_log (month, type, party, imported, system, diff, state, done, note, created_at) VALUES (?,?,?,?,?,?,?,1,?,?)')
          .bind(month, type, party, imported, system, round2(imported - system), state, note, now()).run()
      }
    } catch (e) {
      done.push({ party, state, mode: 'error', error: String(e.message || e).slice(0, 80) })
    }
  }
  await logAudit(db, '对账批量处理', type, `${month} 处理 ${done.length} 家，补记 ${added}，核销 ${cut}`)
  const nAdd = done.filter((x) => x.mode === 'add' || x.mode === 'new').length
  const nCut = done.filter((x) => x.mode === 'cut').length
  const text = `对账处理完：补记 ${nAdd} 家（共 ¥${added}）` + (nCut ? `，核销差额 ${nCut} 家（共 ¥${cut}）` : '') + (skipped ? `，跳过 ${skipped} 家` : '') + '。'
  return c.json({ ok: true, month, type, count: done.length, added, cut, skipped, n_add: nAdd, n_cut: nCut, rows: done, text })
})

// 月度对账小结：这个月和谁对过、差多少、补了几笔、还有谁没对，一页说清
async function reconMonthStat(db, m, type) {
  const isAp = type === 'ap'
  const T = isAp ? 'payables' : 'orders'
  const P = isAp ? 'supplier' : 'customer'
  const AMT = isAp ? 'amount' : 'price'
  const L = `${AMT} - COALESCE(paid,0) - COALESCE(written_off,0)`
  const logs = (await db.prepare('SELECT * FROM recon_log WHERE month=? AND type=? ORDER BY id').bind(m, type).all()).results
  const debts = (await db.prepare(`SELECT ${P} AS party, COALESCE(SUM(CASE WHEN ${L}>0 THEN ${L} ELSE 0 END),0) AS left FROM ${T} GROUP BY ${P}`).all()).results.filter((x) => num(x.left) > 0.009)
  let statements = 0; let disputes = 0; let disputesOpen = 0
  try {
    const st = (await db.prepare("SELECT COUNT(*) AS c FROM statement_log WHERE substr(created_at,1,7)=? AND type=?").bind(m, type).first()) || {}
    statements = num(st.c)
    const dp = (await db.prepare("SELECT COUNT(*) AS c FROM statement_log WHERE substr(created_at,1,7)=? AND type=? AND ack='doubt'").bind(m, type).first()) || {}
    disputes = num(dp.c)
    const dpo = (await db.prepare("SELECT COUNT(*) AS c FROM statement_log WHERE substr(created_at,1,7)=? AND type=? AND ack='doubt' AND (resolved_at IS NULL OR resolved_at='')").bind(m, type).first()) || {}
    disputesOpen = num(dpo.c)
  } catch (e) { /* 没建表就跳过 */ }
  const seen = new Set()
  let matchN = 0; let fixedN = 0; let fixedAmt = 0; let openN = 0
  const diffParties = []
  for (const r of logs) {
    seen.add(r.party)
    if (r.state === 'match') matchN += 1
    else {
      const note = String(r.note || '')
      const mm = note.match(/补记\s*([\d.]+)/)
      if (mm) { fixedN += 1; fixedAmt = round2(fixedAmt + num(mm[1])) } else diffParties.push(r.party)
    }
    if (!r.done) openN += 1
  }
  const never = debts.filter((x) => !seen.has(x.party))
  const neverLeft = round2(never.reduce((a, x) => a + num(x.left), 0))
  const days = Array.from(new Set(logs.map((r) => (r.created_at || '').slice(-16, -14) || ''))).filter(Boolean).sort()
  const dayList = Array.from(new Set(logs.map((r) => Number((r.created_at || '').slice(8, 10)) || 0))).filter(Boolean).sort((a, b) => a - b)
  const title = (await getTitle(db)).title || '加工费记账'
  const NM = isAp ? '应付' : '应收'
  const lines = []
  lines.push(`【${title}】${m} 对账小结（${NM}）`)
  lines.push(`对过账的单位：${logs.length} 家（一致 ${matchN} 家，有差异 ${logs.length - matchN} 家）`)
  if (fixedN || fixedAmt) lines.push(`差异处理：补记 ${fixedN} 笔，合计 ¥${fixedAmt}`)
  if (diffParties.length) lines.push(`有差异但不补的：${diffParties.slice(0, 6).join('、')}${diffParties.length > 6 ? ' 等 ' + diffParties.length + ' 家' : ''}`)
  if (openN) lines.push(`还没处理完：${openN} 家（台账里点一下标记）`)
  lines.push(`还没对过的：${never.length} 家${neverLeft ? `，欠 ¥${neverLeft}` : ''}${never.length ? '（' + never.slice(0, 4).map((x) => x.party).join('、') + (never.length > 4 ? ' 等' : '') + '）' : ''}`)
  if (statements || disputes) lines.push(`发出对账单 ${statements} 份${disputes ? `，对方有异议 ${disputes} 份${disputesOpen ? `（还没处理 ${disputesOpen} 份）` : '（都处理完了）'}` : ''}`)
  if (dayList.length) lines.push(`对账的日子：${dayList.map((d) => d + ' 号').join('、')}`)
  let advice = ''
  if (never.length) advice = `还有 ${never.length} 家没对（欠 ¥${neverLeft}），挑欠得最多的先对一遍`
  else if (openN) advice = `这个月都对了，但有 ${openN} 家差异还没处理完，点一下标记就行`
  else if (!logs.length) advice = '这个月还没对过账，先从欠款最多的 3 家开始'
  else advice = '这个月对账做完了，差异都处理了，下个月照这个节奏'
  lines.push(advice)
  return {
    ok: true, month: m, type, type_text: NM,
    reconciled: logs.length, match: matchN, diff: logs.length - matchN,
    diff_amount: round2(logs.reduce((a, r) => a + Math.abs(num(r.diff)), 0)),
    fixed_count: fixedN, fixed_amount: fixedAmt, open_diff: openN,
    never_count: never.length, never_left: neverLeft,
    never: never.slice(0, 8).map((x) => ({ party: x.party, left: round2(num(x.left)) })),
    statements, disputes, disputes_open: disputesOpen,
    days: days.length, day_list: dayList,
    text: lines.join('\n'), advice
  }
}

app.get('/recon-month', async (c) => {
  const m = (c.req.query('month') || now().slice(0, 7)).slice(0, 7)
  const type = c.req.query('type') === 'ap' ? 'ap' : 'ar'
  return c.json(await reconMonthStat(c.env.DB, m, type))
})

// 每月财务流水线：这个月做到哪一步了（小白照着走不会漏）
app.get('/pipeline', async (c) => {
  const db = c.env.DB
  const m = String(c.req.query('month') || now().slice(0, 7)).slice(0, 7)
  const J = (sql, ...b) => db.prepare(sql).bind(...b).first()
  const [ord, pay, expN, rl, lock, arch, sumRow] = await Promise.all([
    J('SELECT COUNT(*) c, COALESCE(SUM(price),0) t FROM orders WHERE month=?', m),
    J('SELECT COUNT(*) c, COALESCE(SUM(amount),0) t FROM payables WHERE month=?', m),
    J("SELECT COUNT(*) c FROM ledger WHERE direction='out' AND cash=1 AND ref_type IN ('expense','fixed') AND substr(created_at,1,7)=?", m),
    J('SELECT COUNT(*) c, COUNT(DISTINCT party) p, SUM(CASE WHEN done=1 THEN 1 ELSE 0 END) d, SUM(CASE WHEN done=0 AND state<>\'match\' THEN 1 ELSE 0 END) o, SUM(CASE WHEN state<>\'match\' THEN 1 ELSE 0 END) df FROM recon_log WHERE month=?', m),
    J('SELECT COUNT(*) c FROM month_lock WHERE month=?', m),
    J('SELECT COUNT(*) c FROM month_archive WHERE month=?', m),
    db.prepare("SELECT value FROM settings WHERE key='pipeline_summary'").first()
  ])
  const oc = num(ord && ord.c), pc = num(pay && pay.c), ec = num(expN && expN.c)
  const rc = num(rl && rl.c), rp = num(rl && rl.p), rd = num(rl && rl.d), ro = num(rl && rl.o), rdf = num(rl && rl.df)
  const locked = num(lock && lock.c) > 0 || num(arch && arch.c) > 0
  const summed = String((sumRow && sumRow.value) || '') === m
  const steps = [
    { k: 'bill', no: 1, title: '把单子录进来', tab: 'ar',
      done: oc + pc + ec > 0,
      detail: `应收 ${oc} 笔 / 应付 ${pc} 笔 / 支出 ${ec} 笔`,
      tip: '手工录、粘贴导入、Excel 导入都算' },
    { k: 'recon', no: 2, title: '和客户供应商对账', tab: 'import',
      done: rc > 0,
      detail: rc > 0 ? `对过 ${rp} 家（一致 ${rc - rdf} / 有差异 ${rdf}）` : '这个月还没对过账',
      tip: '导入页粘对账单 → 点对账核对' },
    { k: 'diff', no: 3, title: '把差异处理掉', tab: 'import',
      done: rc > 0 && ro === 0,
      detail: rc === 0 ? '先做第 2 步' : (ro > 0 ? `还有 ${ro} 家没处理完` : '差异都处理完了 ✓'),
      tip: '差异可以直接补记一笔，或标记「不用补」' },
    { k: 'summary', no: 4, title: '出一页月度小结', tab: 'report',
      done: summed,
      detail: summed ? `${m} 的小结已出` : '还没出',
      tip: '给老板/自己留档，也能直接发微信' },
    { k: 'close', no: 5, title: '结账归档', tab: 'report',
      done: locked,
      detail: locked ? `${m} 已结账，单据锁定` : '这个月还没结账',
      tip: '结完账当月单据不能再改，出错可解锁' }
  ]
  const done_count = steps.filter((x) => x.done).length
  const next = steps.find((x) => !x.done) || null
  const advice = locked ? `${m} 已结账，下个月接着从第 1 步走`
    : next ? `下一步：${next.no}. ${next.title}（${next.tip}）`
    : '这个月流程走完了，可以结账'
  return c.json({ ok: true, month: m, steps, done_count, total: steps.length, percent: Math.round(done_count * 100 / steps.length), locked, next_key: next ? next.k : '', advice })
})

// 出了月度小结就打一个勾（流水线第 4 步）
app.post('/pipeline-summary', async (c) => {
  const b = await c.req.json().catch(() => ({}))
  const m = String((b && b.month) || now().slice(0, 7)).slice(0, 7)
  const db = c.env.DB
  await db.prepare("INSERT INTO settings (key,value) VALUES ('pipeline_summary',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(m).run()
  return c.json({ ok: true, month: m })
})

app.get('/recon-log', async (c) => {
  const db = c.env.DB
  const month = String(c.req.query('month') || '').slice(0, 7)
  const type = String(c.req.query('type') || '')
  const where = []
  const args = []
  if (month) { where.push('month=?'); args.push(month) }
  if (type === 'ar' || type === 'ap') { where.push('type=?'); args.push(type) }
  const w = where.length ? ' WHERE ' + where.join(' AND ') : ''
  const rows = (await db.prepare('SELECT * FROM recon_log' + w + ' ORDER BY id DESC LIMIT 200').bind(...args).all()).results || []
  const months = (await db.prepare("SELECT month, type, COUNT(*) AS cnt, SUM(CASE WHEN state<>'match' THEN 1 ELSE 0 END) AS diff_cnt, SUM(CASE WHEN done=1 THEN 1 ELSE 0 END) AS done_cnt, MAX(created_at) AS last_at FROM recon_log GROUP BY month, type ORDER BY month DESC, type LIMIT 24").all()).results || []
  const open = (await db.prepare("SELECT COUNT(*) AS c FROM recon_log WHERE done=0 AND state<>'match'").first()) || { c: 0 }
  return c.json({ ok: true, rows, months, open_diff: num(open.c) })
})

// 对账差异汇总：复制成一段话，直接发微信给对方
app.get('/recon-diff-text', async (c) => {
  const db = c.env.DB
  const month = String(c.req.query('month') || '').slice(0, 7)
  const type = String(c.req.query('type') || '')
  const where = ["done=0", "state<>'match'"]
  const args = []
  if (month) { where.push('month=?'); args.push(month) }
  if (type === 'ar' || type === 'ap') { where.push('type=?'); args.push(type) }
  const rows = (await db.prepare('SELECT * FROM recon_log WHERE ' + where.join(' AND ') + ' ORDER BY type, id DESC').bind(...args).all()).results || []
  const head = (await titled(db, '对账差异清单')).join('\n')
  const lines = []
  lines.push(`${month ? month + ' ' : ''}待查差异 ${rows.length} 条`)
  for (const r of rows) {
    const st = r.state === 'more' ? `我这边少 ${round2(Math.abs(num(r.diff)))}` : r.state === 'less' ? `我这边多 ${round2(Math.abs(num(r.diff)))}` : '系统里没这家'
    lines.push(`· ${r.party}（${r.type === 'ap' ? '应付' : '应收'}）单上 ${round2(num(r.imported))} / 我这 ${round2(num(r.system))} → ${st}`)
  }
  if (!rows.length) lines.push('没有没处理的差异，账已经对平了 ✅')
  lines.push('（有出入的麻烦帮我核一下是哪一笔，确认后我这边改）')
  const text = head + '\n' + lines.join('\n')
  return c.json({ ok: true, text, count: rows.length, month })
})

app.patch('/recon-log/:id', async (c) => {
  const id = num(c.req.param('id'))
  const b = await c.req.json()
  const cur = await c.env.DB.prepare('SELECT * FROM recon_log WHERE id=?').bind(id).first()
  if (!cur) return c.json({ error: '这条核对记录不存在' }, 404)
  const done = b.done === undefined ? num(cur.done) : (b.done ? 1 : 0)
  const note = b.note === undefined ? String(cur.note || '') : String(b.note)
  await c.env.DB.prepare('UPDATE recon_log SET done=?, note=? WHERE id=?').bind(done, note, id).run()
  return c.json({ ok: true })
})

app.delete('/recon-log/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM recon_log WHERE id=?').bind(num(c.req.param('id'))).run()
  return c.json({ ok: true })
})

app.delete('/recon-log', async (c) => {
  const month = String(c.req.query('month') || '').slice(0, 7)
  if (!month) return c.json({ error: '要指定月份' }, 400)
  await c.env.DB.prepare('DELETE FROM recon_log WHERE month=?').bind(month).run()
  return c.json({ ok: true })
})

// ===== 对账进度：每家上次什么时候对过、对不对得上、谁还没对过 =====
app.get('/recon-progress', async (c) => {
  const db = c.env.DB
  const type = String(c.req.query('type') || 'ar') === 'ap' ? 'ap' : 'ar'
  const rows = (await db.prepare("SELECT party, COUNT(*) cnt, MAX(created_at) last_at, MAX(month) last_month, SUM(CASE WHEN done=0 AND state<>'match' THEN 1 ELSE 0 END) open_diff FROM recon_log WHERE type=? GROUP BY party ORDER BY last_at DESC").bind(type).all()).results || []
  const list = []
  for (const r of rows) {
    const l = (await db.prepare('SELECT state, diff, imported, system, month FROM recon_log WHERE type=? AND party=? ORDER BY id DESC LIMIT 1').bind(type, r.party).first()) || {}
    let st = '一致'
    if (l.state === 'more') st = '我少记 ' + round2(Math.abs(num(l.diff)))
    else if (l.state === 'less') st = '我多记 ' + round2(Math.abs(num(l.diff)))
    else if (l.state === 'new') st = '当时没这家'
    list.push({ party: r.party, times: num(r.cnt), last_at: r.last_at, last_month: l.month || r.last_month, open_diff: num(r.open_diff), state: l.state || '', state_text: st, imported: round2(num(l.imported)), system: round2(num(l.system)) })
  }
  // 还有欠款、但从没对过账的单位：最该提醒
  const openRows = type === 'ap'
    ? (await db.prepare("SELECT supplier AS party, SUM(CASE WHEN amount-paid-COALESCE(written_off,0)>0 THEN amount-paid-COALESCE(written_off,0) ELSE 0 END) AS left FROM payables GROUP BY supplier").all()).results
    : (await db.prepare("SELECT customer AS party, SUM(CASE WHEN price-paid-COALESCE(written_off,0)>0 THEN price-paid-COALESCE(written_off,0) ELSE 0 END) AS left FROM orders GROUP BY customer").all()).results
  const done = new Set(rows.map((r) => r.party))
  const never = (openRows || []).filter((o) => num(o.left) > 0 && !done.has(o.party)).map((o) => ({ party: o.party, left: round2(num(o.left)) }))
  const openDiff = list.reduce((a, x) => a + x.open_diff, 0)
  return c.json({ ok: true, type, list, never, never_count: never.length, open_diff: openDiff })
})

// ===== 差异话术：按差异方向自动生成该说的话（催款 / 核对 / 建账） =====
app.get('/recon-dunning', async (c) => {
  const db = c.env.DB
  const type = String(c.req.query('type') || 'ar') === 'ap' ? 'ap' : 'ar'
  const month = String(c.req.query('month') || '').slice(0, 7)
  const title = await getSetting(db, 'report_title')
  const me = (title || '我这') + '（' + (type === 'ap' ? '应付' : '应收') + '）'
  const rows = month
    ? (await db.prepare("SELECT * FROM recon_log WHERE type=? AND month=? AND done=0 ORDER BY party").bind(type, month).all()).results
    : (await db.prepare("SELECT * FROM recon_log WHERE type=? AND done=0 ORDER BY id DESC LIMIT 30").bind(type).all()).results
  const out = []
  for (const r of rows || []) {
    if (r.state === 'match') continue
    const party = r.party || ''
    const on = round2(num(r.imported))
    const mine = round2(num(r.system))
    let text = ''
    if (r.state === 'more') {
      const d = round2(Math.abs(num(r.diff)))
      text = `${party} 你好，对了一下账：你那边记的是 ${on} 元，${me}是 ${mine} 元，差 ${d} 元。方便的话把这 ${d} 元对应的单子或收款记录发我一下，我这边好对上。`
    } else if (r.state === 'less') {
      const d = round2(Math.abs(num(r.diff)))
      text = `${party} 你好，对账发现我这边记的 ${mine} 元比你那边 ${on} 元多了 ${d} 元，可能是我重复记了或者你已经付过一笔我没记上。我这边核一下，回头给你准数。`
    } else if (r.state === 'new') {
      text = `${party} 你好，我这边账上还没有你的往来，麻烦把这边的对账单（或者记的金额）发我一下，我建个账好对上。`
    } else continue
    out.push({ id: r.id, party, state: r.state, month: r.month, imported: on, system: mine, diff: round2(num(r.diff)), text })
  }
  return c.json({ ok: true, type, month, rows: out, count: out.length, all_text: out.map((x) => x.text).join('\n\n') })
})

// ===== 自动认表：选了个 Excel 但不知道是应收还是应付，先猜一下 =====
const DETECT_RULES = [
  // 流水账放前面：微信/支付宝/银行导出的表里也有「交易对方」，容易被当成供应商
  { type: 'bank', kw: /交易时间|收\/支|借方金额|贷方金额|交易对方|微信支付账单|支付宝/, why: '表头是微信/支付宝/银行流水那种' },
  { type: 'ap', kw: /供应商|采购|欠供/, why: '表里有「供应商」这类字' },
  { type: 'ar', kw: /客户|产品|加工费/, why: '表里有「客户 / 产品」这类字' },
  { type: 'expense', kw: /分类|支出|水电|房租|工资/, why: '表里有「分类 / 支出」这类字' },
  { type: 'loan', kw: /员工|借支|姓名/, why: '表里有「员工 / 借支」这类字' },
  { type: 'reimb', kw: /报销/, why: '表里有「报销」' }
]
app.post('/detect-import', async (c) => {
  const b = await c.req.json().catch(() => ({}))
  let rows = Array.isArray(b.rows) ? b.rows : []
  if (!rows.length && b.b64) {
    try { rows = await xlsxToRows(fromB64(b.b64).buffer) } catch (e) { return c.json({ error: '读不了这个文件' }, 400) }
  }
  if (!rows.length) return c.json({ error: '没有数据' }, 400)
  const head = (rows[0] || []).map((x) => String(x == null ? '' : x)).join(' ')
  const body = rows.slice(0, 40).map((r) => (r || []).map((x) => String(x == null ? '' : x)).join(' ')).join('\n')
  const cols = (rows[0] || []).length
  let type = ''
  let why = ''
  for (const r of DETECT_RULES) {
    if (r.kw.test(head) || r.kw.test(body)) { type = r.type; why = r.why; break }
  }
  if (!type && cols <= 2) { type = 'recon'; why = '只有两列，像是「单位 + 金额」的对账单' }
  if (!type) { type = 'ar'; why = '没看出关键字，按最常见的应收处理' }
  // 给出的候选（前端可以让你换）
  const cands = ['ar', 'ap', 'expense', 'loan', 'reimb', 'recon']
  if (!cands.includes(type)) cands.unshift(type)
  return c.json({ ok: true, type, why, cols, rows_count: rows.length, candidates: cands })
})

// 浏览器直接打开根路径时给个友好提示（不需要口令）
app.get('/', (c) => c.html(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>小工厂记账</title>
<style>body{font-family:-apple-system,sans-serif;max-width:520px;margin:12vh auto;padding:0 24px;color:#333;line-height:1.7}h1{font-size:20px}.ok{font-size:44px}a{color:#07c}</style>
</head><body><div class="ok">✅</div><h1>小工厂记账 · 服务已就绪</h1>
<p>这里是记账小程序的<strong>服务器</strong>，给微信小程序提供数据接口，不是网页。</p>
<p>请不要在浏览器里打开，请到<strong>微信开发者工具</strong>或<strong>手机微信</strong>里使用小程序。</p>
<p>第一次打开小程序时会让你<strong>设置一个访问口令</strong>，之后每台设备输一次口令即可记账。</p>
</body></html>`))

// 除 /auth/* 外全部需要口令


// 我是谁（老板/员工）
// 我的活（员工/老板通用）：今天该收、该付、该更新工序的单子
// 现在先做哪一件：从所有提醒里挑出最该做的一件事，别一次怼十条
app.get('/next-step', async (c) => {
  const db = c.env.DB
  const today = now().slice(0, 10)
  const m = today.slice(0, 7)
  const dnum = num(today.slice(8, 10))
  const soon = addDaysIso(today, 7)
  const P = (sql, ...b) => db.prepare(sql).bind(...b).all().catch((e) => { noteFail(e, '下一步'); return { results: [] } })
  const [arOld, apOld, cnts, unsent, bk, staleQ, maintQ] = await Promise.all([
    P(`SELECT customer party, (price - COALESCE(paid,0) - COALESCE(written_off,0)) left_amt, substr(due_date,1,10) due
       FROM orders WHERE COALESCE(paid,0)+COALESCE(written_off,0) < price AND due_date IS NOT NULL AND due_date <> ''
        AND substr(due_date,1,10) < ? ORDER BY substr(due_date,1,10) ASC LIMIT 1`, today),
    P(`SELECT supplier party, (amount - COALESCE(paid,0) - COALESCE(written_off,0)) left_amt, substr(due_date,1,10) due
       FROM payables WHERE COALESCE(paid,0)+COALESCE(written_off,0) < amount AND due_date IS NOT NULL AND due_date <> ''
        AND substr(due_date,1,10) < ? ORDER BY substr(due_date,1,10) ASC LIMIT 1`, today),
    P(`SELECT
        (SELECT COUNT(*) FROM orders WHERE COALESCE(paid,0)+COALESCE(written_off,0) < price AND due_date IS NOT NULL AND due_date <> '' AND substr(due_date,1,10) >= ? AND substr(due_date,1,10) <= ?) AS ar_soon,
        (SELECT COUNT(*) FROM payables WHERE COALESCE(paid,0)+COALESCE(written_off,0) < amount AND due_date IS NOT NULL AND due_date <> '' AND substr(due_date,1,10) >= ? AND substr(due_date,1,10) <= ?) AS ap_soon,
        (SELECT COUNT(*) FROM orders WHERE COALESCE(cost,0)=0 AND price > 0) AS no_cost,
        (SELECT COUNT(*) FROM recon_log WHERE done=0 AND COALESCE(state,'')<>'match') AS recon_open,
        (SELECT COUNT(*) FROM recon_log WHERE substr(created_at,1,7)=?) AS recon_month,
        (SELECT COUNT(*) FROM orders WHERE COALESCE(paid,0)+COALESCE(written_off,0) < price) AS ar_open_n,
        (SELECT COUNT(*) FROM payables WHERE COALESCE(paid,0)+COALESCE(written_off,0) < amount) AS ap_open_n,
        (SELECT COALESCE(SUM(price - COALESCE(paid,0) - COALESCE(written_off,0)),0) FROM orders WHERE COALESCE(paid,0)+COALESCE(written_off,0) < price AND due_date IS NOT NULL AND due_date <> '' AND substr(due_date,1,10) >= ? AND substr(due_date,1,10) <= ?) AS ar_soon_amt,
        (SELECT COALESCE(SUM(amount - COALESCE(paid,0) - COALESCE(written_off,0)),0) FROM payables WHERE COALESCE(paid,0)+COALESCE(written_off,0) < amount AND due_date IS NOT NULL AND due_date <> '' AND substr(due_date,1,10) >= ? AND substr(due_date,1,10) <= ?) AS ap_soon_amt
`, today, soon, today, soon, m, today, soon, today, soon),
    P(`SELECT
        (SELECT COUNT(*) FROM (SELECT DISTINCT customer p FROM orders WHERE COALESCE(paid,0)+COALESCE(written_off,0) < price) x
           WHERE NOT EXISTS (SELECT 1 FROM statement_log s WHERE s.party = x.p AND substr(s.month,1,7) = ?)) AS ar_n,
        (SELECT COUNT(*) FROM (SELECT DISTINCT supplier p FROM payables WHERE COALESCE(paid,0)+COALESCE(written_off,0) < amount) y
           WHERE NOT EXISTS (SELECT 1 FROM statement_log s WHERE s.party = y.p AND substr(s.month,1,7) = ?)) AS ap_n`, m, m),
    P("SELECT created_at FROM backups ORDER BY id DESC LIMIT 1"),
    P(`SELECT COUNT(*) n, COALESCE(MAX(CAST(julianday(?) - julianday(COALESCE((SELECT MAX(p.created_at) FROM process_log p WHERE p.order_id=o.id), o.created_at)) AS INTEGER)),0) mx FROM orders o WHERE COALESCE(o.status,0)<2`, today),
    P("SELECT name, maint_months, maint_last FROM assets WHERE COALESCE(maint_months,0)>0 AND COALESCE(disposed_at,'')=''"),
  ])
  const rows = (x) => (x && x.results) || []
  const c0 = rows(cnts)[0] || {}
  const u0 = rows(unsent)[0] || {}
  const bkLast = rows(bk)[0] ? String(rows(bk)[0].created_at || '').slice(0, 10) : ''
  const cand = []
  const push = (pri, k, title, why, tab, amount) => cand.push({ pri, k, title, why, tab, amount: round2(num(amount)) })
  const ao = rows(arOld)[0]
  if (ao) { const d = daysSince(ao.due); push(100 + Math.min(d, 300), 'chase', `催一下 ${ao.party}`, `${ao.due} 就该给的 ${round2(num(ao.left_amt))} 元，已经拖了 ${d} 天`, 'bill:ar', ao.left_amt) }
  const po = rows(apOld)[0]
  if (po) { const d = daysSince(po.due); push(95 + Math.min(d, 300), 'pay', `该给 ${po.party} 付款了`, `${po.due} 到期，${round2(num(po.left_amt))} 元还没付，拖了 ${d} 天`, 'bill:ap', po.left_amt) }
  if (num(c0.recon_open) > 0) push(90 + Math.min(num(c0.recon_open), 9), 'recon', '把对账差异处理掉', `有 ${num(c0.recon_open)} 条差异还没处理，拖着结账会被拦`, 'report:bill', 0)
  if (num(c0.ar_soon) + num(c0.ap_soon) > 0) push(70 + num(c0.ar_soon) + num(c0.ap_soon), 'soon', '把 7 天内到期的钱过一遍', `这周有 ${num(c0.ar_soon)} 笔要收、${num(c0.ap_soon)} 笔要付`, 'home:home', 0)
  if (num(c0.no_cost) > 0) push(62 + Math.min(num(c0.no_cost), 20), 'cost', '给没填成本的单补上成本', `${num(c0.no_cost)} 张单没填材料/外协成本，毛利算不准`, 'bill:ar', 0)
  // 钱够不够付：现金 + 这周该收 vs 这周该付
  try {
    const accList = await accountBalances(db).catch(() => [])
    const cashSum = (accList || []).reduce((t, x) => t + num(x && x.balance), 0)
    const gap = round2(cashSum + num(c0.ar_soon_amt) - num(c0.ap_soon_amt))
    if (gap < 0 && num(c0.ap_soon_amt) > 0) push(96, 'cash', '这周的钱可能不够付', '账上 ¥' + round2(cashSum) + '，这周要付 ¥' + round2(num(c0.ap_soon_amt)) + '、该收 ¥' + round2(num(c0.ar_soon_amt)) + '，还差 ¥' + Math.abs(gap), 'home:home', Math.abs(gap))
  } catch (e) { noteFail(e, '下一步') }
  // 工序卡住：没交付、又很久没动的单
  const stale0 = rows(staleQ)[0] || {}
  if (num(stale0.n) > 0 && num(stale0.mx) >= 7) push(78 + Math.min(num(stale0.mx), 60), 'stale', '问一句车间：卡在哪了', '有 ' + num(stale0.n) + ' 张单还没交付，最久 ' + num(stale0.mx) + ' 天没动过', 'bill:ar', 0)
  // 设备保养到期
  const maintDue = (rows(maintQ) || []).filter((a) => {
    const mo = num(a.maint_months)
    if (!mo) return false
    const base = String(a.maint_last || '').slice(0, 10)
    if (!base) return true
    const d0 = new Date(base + 'T00:00:00Z')
    d0.setUTCMonth(d0.getUTCMonth() + mo)
    return (Date.now() + 15 * 86400000) >= d0.getTime()
  })
  if (maintDue.length) push(74, 'maint', '该保养设备了', maintDue.length + ' 台（' + maintDue.slice(0, 2).map((x) => x.name).join('、') + (maintDue.length > 2 ? '…' : '') + '）到了保养周期', 'stat:asset', 0)
  const hasBook = num(c0.ar_open_n) + num(c0.ap_open_n) > 0
  if (hasBook && dnum >= 10 && num(c0.recon_month) === 0) push(58, 'reconmonth', '和客商对一次账', '这个月还没对过账', 'bill:import', 0)
  if (dnum >= 20 && num(u0.ar_n) + num(u0.ap_n) > 0) push(55 + num(u0.ar_n) + num(u0.ap_n), 'stmt', '把对账单发给客商', `还有 ${num(u0.ar_n) + num(u0.ap_n)} 家这个月没发（应收 ${num(u0.ar_n)} · 应付 ${num(u0.ap_n)}）`, 'report:bill', 0)
  if (hasBook && dnum >= 20 && (!bkLast || daysSince(bkLast) > 7)) push(52, 'backup', '备份一次', bkLast ? `上次备份是 ${bkLast}（${daysSince(bkLast)} 天前）` : '还没备份过，万一手机丢了就没了', 'me:me', 0)
  cand.sort((a, b) => b.pri - a.pri)
  const top = cand[0] || null
  const total = num(c0.ar_soon) + num(c0.ap_soon) + num(c0.no_cost) + num(c0.recon_open) + num(u0.ar_n) + num(u0.ap_n)
  return c.json({
    ok: true, today, item: top, degraded: failBucket.slice(),
    others: cand.slice(1, 6).map((x) => ({ k: x.k, title: x.title, why: x.why, tab: x.tab, amount: x.amount })),
    rest: Math.max(cand.length - 1, 0),
    text: top ? `现在先做这一件：${top.title}——${top.why}` : (total === 0 ? '今天没有必须处理的事，有空把今天的单记上就行。' : '没有急事，往下翻有别的提醒。')
  })
})

app.get('/my-work', async (c) => {
  const db = c.env.DB
  const role = c.get('role') || 'owner'
  const today = now().slice(0, 10)
  const soon = addDaysIso(today, 3)
  const [recv, pay, prog] = await Promise.all([
    db.prepare(`SELECT id, customer party, item_name item, price, COALESCE(paid,0) paid, due_date,
        (price - COALESCE(paid,0) - COALESCE(written_off,0)) left_amt
      FROM orders WHERE COALESCE(paid,0) + COALESCE(written_off,0) < price
        AND due_date IS NOT NULL AND substr(due_date,1,10) <= ?
      ORDER BY substr(due_date,1,10) ASC LIMIT 8`).bind(soon).all(),
    db.prepare(`SELECT id, supplier party, remark item, amount, COALESCE(paid,0) paid, due_date,
        (amount - COALESCE(paid,0) - COALESCE(written_off,0)) left_amt
      FROM payables WHERE COALESCE(paid,0) + COALESCE(written_off,0) < amount
        AND due_date IS NOT NULL AND substr(due_date,1,10) <= ?
      ORDER BY substr(due_date,1,10) ASC LIMIT 8`).bind(soon).all(),
    db.prepare(`SELECT id, customer party, item_name item, price, COALESCE(progress,'') progress, status, created_at
      FROM orders WHERE (status IS NULL OR status < 2) ORDER BY created_at DESC LIMIT 6`).all()
  ])
  const rows = (x) => (x && x.results) || []
  const R = rows(recv).map(r => ({ ...r, days: daysSince(r.due_date), late: daysSince(r.due_date) > 0 })),
    P = rows(pay).map(r => ({ ...r, days: daysSince(r.due_date), late: daysSince(r.due_date) > 0 })),
    G = rows(prog).map(r => ({ ...r, status_text: r.status === 1 ? '加工中' : '待加工', no_progress: !r.progress }))
  const { results: nd } = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM orders WHERE COALESCE(paid,0)+COALESCE(written_off,0) < price AND (due_date IS NULL OR due_date='')) +
            (SELECT COUNT(*) FROM payables WHERE COALESCE(paid,0)+COALESCE(written_off,0) < amount AND (due_date IS NULL OR due_date='')) AS cnt,
            (SELECT COALESCE(SUM(price - COALESCE(paid,0) - COALESCE(written_off,0)),0) FROM orders WHERE COALESCE(paid,0)+COALESCE(written_off,0) < price AND (due_date IS NULL OR due_date='')) AS ar_amt,
            (SELECT COALESCE(SUM(amount - COALESCE(paid,0) - COALESCE(written_off,0)),0) FROM payables WHERE COALESCE(paid,0)+COALESCE(written_off,0) < amount AND (due_date IS NULL OR due_date='')) AS ap_amt`
  ).all()
  const noDueCnt = num(nd && nd[0] && nd[0].cnt),
    noDueAmt = round2(num(nd && nd[0] && nd[0].ar_amt) + num(nd && nd[0] && nd[0].ap_amt))
  const todo = R.length + P.length + G.filter(g => g.no_progress).length
  const count = todo + (noDueCnt > 0 ? 1 : 0)
  let text = ''
  if (todo) text = `今天有 ${todo} 件事：该收 ${R.length} 笔、该付 ${P.length} 笔、${G.filter(g => g.no_progress).length} 张单还没更新进度`
  if (noDueCnt > 0) text += `${text ? '；' : '今天有 1 件事：'}还有 ${noDueCnt} 笔单子没约定收付款日（¥${noDueAmt}），设了账期到点才会提醒你`
  if (!text) text = '今天没有非办不可的事 👍'
  return c.json({
    ok: true, role, today,
    recv: R, pay: P, prog: G,
    recv_total: round2(R.reduce((a, r) => a + num(r.left_amt), 0)),
    pay_total: round2(P.reduce((a, r) => a + num(r.left_amt), 0)),
    no_due_count: noDueCnt, no_due_amount: noDueAmt,
    count, text
  })
})

// 账本封存：一整本变成只读（对完账的老账本封起来，谁也别误改）
const setSetting = async (db, k, v) => {
  const old = await db.prepare('SELECT value FROM settings WHERE key=?').bind(k).first().catch(() => null)
  if (old) await db.prepare('UPDATE settings SET value=? WHERE key=?').bind(String(v), k).run()
  else await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(k, String(v)).run()
}
const delSetting = async (db, k) => { await db.prepare('DELETE FROM settings WHERE key=?').bind(k).run() }
app.get('/seal', async (c) => {
  const db = c.env.DB
  const g = async (k) => { const r = await db.prepare('SELECT value FROM settings WHERE key=?').bind(k).first().catch(() => null); return (r && r.value) || '' }
  const sealed = (await g('sealed')) === '1'
  const since = await g('sealed_at')
  const note = await g('sealed_note')
  const name = await g('book_name')
  return c.json({
    ok: true, sealed, sealed_at: since, note, book: String(c.env.BOOK || '1'), name: name || ('账本' + (c.env.BOOK || '1')),
    text: sealed ? `这本账（${name || '账本' + (c.env.BOOK || '1')}）从 ${String(since).slice(0, 10)} 起封存了，现在是只读的。要改先解封。` : '这本账现在是可改的。'
  })
})
app.post('/seal', async (c) => {
  const db = c.env.DB
  const b = await c.req.json().catch(() => ({}))
  const note = String(b.note || '').trim().slice(0, 200)
  await setSetting(db, 'sealed', '1')
  await setSetting(db, 'sealed_at', now())
  if (note) await setSetting(db, 'sealed_note', note)
  await logAudit(db, '封存账本', '账本' + (c.env.BOOK || '1'), note || '（整本只读）', '', act(c))
  return c.json({ ok: true, sealed: true, note })
})
app.post('/unseal', async (c) => {
  const db = c.env.DB
  const b = await c.req.json().catch(() => ({}))
  if (!b.confirm) return c.json({ ok: false, error: '解封后这本账就能改动了，确认要解开吗？', code: 'need_confirm' }, 409)
  await setSetting(db, 'sealed', '0')
  await delSetting(db, 'sealed_at')
  await delSetting(db, 'sealed_note')
  await logAudit(db, '解封账本', '账本' + (c.env.BOOK || '1'), String(b.note || '').slice(0, 100) || '（恢复可改）', '', act(c))
  return c.json({ ok: true, sealed: false })
})

// 员工权限：能开哪些模块（老板专用）
app.get('/staff-perms', async (c) => {
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const mods = await getStaffModules(mainDb)
  const rows = Object.keys(STAFF_MOD_LABEL).map((k) => ({ k, label: STAFF_MOD_LABEL[k], on: mods.includes(k) }))
  const off = rows.filter((r) => !r.on).map((r) => r.label)
  const so = await mainDb.prepare("SELECT value FROM settings WHERE key='staff_self_only'").first()
  const selfOn = !!(so && String(so.value) === '1')
  const sp2 = await mainDb.prepare("SELECT value FROM settings WHERE key='staff_scope'").first().catch(() => null)
  const scope = String((sp2 && sp2.value) || 'all') === 'own' ? 'own' : 'all'
  const scCnt = await c.env.DB.prepare('SELECT COUNT(*) n FROM party_staff').first().catch(() => ({ n: 0 }))
  return c.json({ ok: true, rows, on: mods, count: mods.length, self_only: selfOn, scope, scope_count: num(scCnt && scCnt.n),
    scope_note: scope === 'own' ? `员工只看自己负责的客户（已分 ${num(scCnt && scCnt.n)} 家；没分的客户他看不到）` : '员工能看到所有客户的单据（按模块权限）',
    self_note: selfOn ? '员工现在只能看到自己录的单（应收/应付列表），汇总和报表仍是整本账。' : '员工能看到全部单据（按模块权限）。',
    text: off.length ? '员工现在能用的：' + rows.filter((r) => r.on).map((r) => r.label).join('、') + '。不能用的：' + off.join('、') + '。' : '员工现在什么模块都能用（除了删改单、看毛利）。' })
})
app.post('/staff-perms', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const want = Array.isArray(body.modules) ? body.modules : []
  const mods = want.map((x) => String(x)).filter((x) => STAFF_MOD_LABEL[x])
  if (!mods.length) return c.json({ error: '至少给员工留一个模块，不然他进来什么都点不了' }, 400)
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const v = mods.join(',')
  const old = await mainDb.prepare("SELECT value FROM settings WHERE key='staff_modules'").first()
  if (old) await mainDb.prepare("UPDATE settings SET value=? WHERE key='staff_modules'").bind(v).run()
  else await mainDb.prepare("INSERT INTO settings (key, value) VALUES ('staff_modules', ?)").bind(v).run()
  if (body.scope != null) {
    const sv2 = String(body.scope) === 'own' ? 'own' : 'all'
    const old3 = await mainDb.prepare("SELECT value FROM settings WHERE key='staff_scope'").first().catch(() => null)
    if (old3) await mainDb.prepare("UPDATE settings SET value=? WHERE key='staff_scope'").bind(sv2).run()
    else await mainDb.prepare("INSERT INTO settings (key, value) VALUES ('staff_scope', ?)").bind(sv2).run()
  }
  if (body.self_only != null) {
    const sv = body.self_only ? '1' : '0'
    const old2 = await mainDb.prepare("SELECT value FROM settings WHERE key='staff_self_only'").first()
    if (old2) await mainDb.prepare("UPDATE settings SET value=? WHERE key='staff_self_only'").bind(sv).run()
    else await mainDb.prepare("INSERT INTO settings (key, value) VALUES ('staff_self_only', ?)").bind(sv).run()
  }
  await logAudit(mainDb, '改员工权限', '员工权限', mods.map((m) => STAFF_MOD_LABEL[m]).join('、') + (body.self_only != null ? (body.self_only ? '；只给看自己录的单' : '；可看全部单据') : ''))
  return c.json({ ok: true, modules: mods, self_only: body.self_only != null ? !!body.self_only : undefined, scope: body.scope != null ? (String(body.scope) === 'own' ? 'own' : 'all') : undefined })
})

app.get('/me', async (c) => {
  const role = c.get('role') || 'owner'
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const staff = await getStaffKey(mainDb)
  const seal = await c.env.DB.prepare("SELECT value FROM settings WHERE key='sealed'").first().catch(() => null)
  const sealAt = await c.env.DB.prepare("SELECT value FROM settings WHERE key='sealed_at'").first().catch(() => null)
  // 一人一个口令时，权限按这个人的来；没有个人账号就用整体员工权限
  const myName = String(c.get('staff_name') || '')
  let mods = role === 'staff' ? await getStaffModules(mainDb) : Object.keys(STAFF_MOD_LABEL)
  if (role === 'staff' && myName) {
    const su = await mainDb.prepare('SELECT modules FROM staff_users WHERE name=? AND active=1 ORDER BY id DESC').bind(myName).first().catch(() => null)
    if (su && String(su.modules || '').trim()) mods = String(su.modules).split(',').map((x) => x.trim()).filter(Boolean)
  }
  return c.json({ role, book: String(c.env.BOOK || '1'), staff_name: myName, staff_enabled: !!staff, sealed: !!(seal && String(seal.value) === '1'), sealed_at: (sealAt && sealAt.value) || '', staff_modules: mods, staff_mod_labels: STAFF_MOD_LABEL })
})
// 把 '07-05' / '2026-07-05' / '2026/7/5' 转成 ISO 日期（本地 0 点）
const addDaysIso = (iso, n) => {
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
// 报表抬头（厂名 + 备注）
const getTitle = async (db) => {
  try {
    const rows = (await db.prepare("SELECT key, value FROM settings WHERE key IN ('report_title','report_note','report_phone','report_addr','report_bank')").all()).results
    const g = (k) => { const r = rows.find((x) => x.key === k); return r ? r.value : '' }
    return { title: g('report_title') || '加工厂', note: g('report_note') || '', phone: g('report_phone') || '', addr: g('report_addr') || '', bank: g('report_bank') || '' }
  } catch (e) { return { title: '加工厂', note: '', phone: '', addr: '', bank: '' } }
}
// 账期：客户/供应商约定「月结 N 天」，建单没填到期日就自动算出到期日
const GRADE_DAYS = { A: 45, B: 30, C: 15, D: 7, N: 30 }
const termAutoOn = async (db) => {
  try {
    const r = await db.prepare("SELECT value FROM settings WHERE key='term_auto'").first()
    return String((r && r.value) || '') === '1'
  } catch (e) { return false }
}
const termDue = async (db, party, baseIso, type) => {
  try {
    const t = await db.prepare('SELECT term_days FROM party_terms WHERE party=?').bind(String(party || '')).first()
    if (t && num(t.term_days) > 0) return addDaysIso(baseIso, num(t.term_days)) + 'T00:00:00.000Z'
  } catch (e) { /* 表还没建也不影响建单 */ }
  try {
    if (await termAutoOn(db)) {
      const g = await gradeLight(db, party, type)
      const d = GRADE_DAYS[g.grade]
      if (d) return addDaysIso(baseIso, d) + 'T00:00:00.000Z'
    }
  } catch (e) { /* 算不出就退回默认账期 */ }
  try {
    const g = await db.prepare("SELECT value FROM settings WHERE key='default_term'").first()
    if (g && num(g.value) > 0) return addDaysIso(baseIso, num(g.value)) + 'T00:00:00.000Z'
  } catch (e) { /* 忽略 */ }
  return ''
}
const toIsoDate = (s) => {
  if (!s) return ''
  const m = String(s).trim().match(/^(\d{4})?[-/年]?(\d{1,2})[-/月](\d{1,2})日?$/)
  if (!m) return ''
  const y = m[1] || todayIso().slice(0, 4)
  const mm = String(m[2]).padStart(2, '0')
  const dd = String(m[3]).padStart(2, '0')
  if (num(mm) < 1 || num(mm) > 12 || num(dd) < 1 || num(dd) > 31) return ''
  return `${y}-${mm}-${dd}T00:00:00.000Z`
}
// 单据日期：填了就用那天（保留当前时刻），没填就是现在
const stampOf = (date) => {
  const iso = toIsoDate(date)
  return iso ? iso : now()
}
const looksLikeDate = (s) => !!toIsoDate(s)
// 收款/付款日期补录：支持 YYYY-MM-DD 或 MM-DD，否则用当前时间
const normDate = (s) => {
  const t = String(s || '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t + 'T00:00:00.000Z'
  if (/^\d{1,2}-\d{1,2}$/.test(t)) {
    const [mm, dd] = t.split('-')
    return `${todayIso().slice(0, 4)}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T00:00:00.000Z`
  }
  return now()
}


// ---------------- 微信订阅消息（到期提醒） ----------------
const WX_API = 'https://api.weixin.qq.com'
const getSetting = async (db, k) => {
  const r = await db.prepare('SELECT value FROM settings WHERE key=?').bind(k).first()
  return (r && r.value) || ''
}
const putSetting = async (db, k, v) => {
  await db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(k, String(v)).run()
}
const wxCfg = async (db) => ({
  appid: await getSetting(db, 'wx_appid'),
  secret: await getSetting(db, 'wx_secret'),
  tpl: await getSetting(db, 'wx_tpl'),
  fields: (await getSetting(db, 'wx_fields')) || 'thing1,time2,thing3'
})
async function wxToken(db) {
  const cfg = await wxCfg(db)
  if (!cfg.appid || !cfg.secret) throw new Error('还没填 AppID / AppSecret')
  const cached = await getSetting(db, 'wx_token')
  const exp = Number((await getSetting(db, 'wx_token_exp')) || 0)
  if (cached && exp > Date.now() + 60000) return cached
  const r = await fetch(WX_API + '/cgi-bin/token?grant_type=client_credential&appid=' + encodeURIComponent(cfg.appid) + '&secret=' + encodeURIComponent(cfg.secret))
  const d = await r.json()
  if (!d.access_token) throw new Error('拿不到 access_token：' + (d.errmsg || JSON.stringify(d).slice(0, 80)))
  await putSetting(db, 'wx_token', d.access_token)
  await putSetting(db, 'wx_token_exp', String(Date.now() + (num(d.expires_in, 7200)) * 1000))
  return d.access_token
}
const wxClip = (v) => {
  const t = String(v === null || v === undefined ? '' : v)
  return t.length > 20 ? t.slice(0, 19) + '…' : t
}
async function wxPush(db, items) {
  const cfg = await wxCfg(db)
  if (!cfg.appid || !cfg.secret || !cfg.tpl) throw new Error('微信提醒还没配置完整（AppID / AppSecret / 模板ID）')
  const token = await wxToken(db)
  const users = (await db.prepare('SELECT * FROM wx_users WHERE quota > 0 ORDER BY id').all()).results
  if (!users.length) throw new Error('还没有人授权过接收提醒')
  const keys = String(cfg.fields || 'thing1,time2,thing3').split(',').map((x) => x.trim()).filter(Boolean)
  const out = []
  for (const u of users) {
    const data = {}
    if (keys[0]) data[keys[0]] = { value: wxClip(items.title) }
    if (keys[1]) data[keys[1]] = { value: wxClip(items.time) }
    if (keys[2]) data[keys[2]] = { value: wxClip(items.note) }
    let ok = false
    let msg = ''
    try {
      const r = await fetch(WX_API + '/cgi-bin/message/subscribe/send?access_token=' + encodeURIComponent(token), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ touser: u.openid, template_id: cfg.tpl, page: 'pages/index/index', data, miniprogram_state: 'formal' })
      })
      const d = await r.json()
      ok = num(d.errcode) === 0
      msg = d.errmsg || ''
    } catch (e) {
      msg = String(e).slice(0, 80)
    }
    if (ok) {
      await db.prepare('UPDATE wx_users SET quota = quota - 1, last_at=? WHERE id=?').bind(now(), u.id).run()
    }
    out.push({ openid: String(u.openid).slice(0, 8) + '**', ok, msg })
  }
  return out
}
// 到期提醒内容：7 天内该收/该付
async function dueReminderItems(db) {
  const today = now().slice(0, 10)
  const soon = new Date(Date.now() + TZ_MS + 7 * 86400000).toISOString().slice(0, 10)
  const ar = (await db.prepare("SELECT COUNT(*) n, COALESCE(SUM(price - paid - COALESCE(written_off,0)),0) t FROM orders WHERE paid + COALESCE(written_off,0) < price AND substr(COALESCE(due_date,''),1,10) BETWEEN ? AND ?").bind(today, soon).first())
  const ap = (await db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount - paid - COALESCE(written_off,0)),0) t FROM payables WHERE paid + COALESCE(written_off,0) < amount AND substr(COALESCE(due_date,''),1,10) BETWEEN ? AND ?").bind(today, soon).first())
  const na = num(ar && ar.n)
  const np = num(ap && ap.n)
  if (!na && !np) return null
  const parts = []
  if (na) parts.push('要收 ' + round2(num(ar.t)) + ' 元（' + na + ' 笔）')
  if (np) parts.push('要付 ' + round2(num(ap.t)) + ' 元（' + np + ' 笔）')
  return { title: '7 天内到期款项', time: soon, note: parts.join('，') }
}
async function runWxReminder(db) {
  try {
    const cfg = await wxCfg(db)
    if (!cfg.appid || !cfg.secret || !cfg.tpl) return
    const items = await dueReminderItems(db)
    if (!items) return
    await wxPush(db, items)
  } catch (e) {
    // 定时任务里失败不抛出，避免影响其它任务
  }
}
app.get('/wx-config', async (c) => {
  const db = c.env.DB
  const cfg = await wxCfg(db)
  const u = await db.prepare('SELECT COUNT(*) n, COALESCE(SUM(quota),0) q FROM wx_users').first()
  const steps = [
    { k: 'appid', label: '小程序 AppID', ok: !!cfg.appid, how: '微信公众平台 → 小程序 → 开发管理 → 开发设置 → AppID' },
    { k: 'secret', label: 'AppSecret', ok: !!cfg.secret, how: '同一页的「生成 AppSecret」（只显示一次，生成后马上填进来）' },
    { k: 'tpl', label: '订阅消息模板 ID', ok: !!cfg.tpl, how: '公众平台 → 订阅消息 → 选用「款项到期提醒 / 待办提醒」类模板，把模板 ID 填进来' },
    { k: 'fields', label: '模板字段名', ok: !!cfg.fields, how: '按模板上写的关键词填，比如 thing1,time2,thing3（对不上就推不出去）' },
    { k: 'user', label: '有人授权接收', ok: num(u && u.n) > 0, how: '在小程序里点一次「允许接收提醒」，一次授权能收多条（有配额）' }
  ]
  const miss = steps.filter((x) => !x.ok)
  return c.json({
    appid: cfg.appid, has_secret: !!cfg.secret, tpl: cfg.tpl, fields: cfg.fields, users: num(u && u.n), quota: num(u && u.q),
    ready: miss.length === 0, wx_guide: steps, missing: miss.map((x) => x.label),
    next: miss.length ? '还差：' + miss.map((x) => x.label).join('、') + '。照「怎么弄」一步步填，填完点「发一条试试」。' : '都填好了，点「发一条试试」看手机收到没有。'
  })
})
app.post('/wx-config', async (c) => {
  const db = c.env.DB
  const b = await c.req.json()
  if (b.appid !== undefined) await putSetting(db, 'wx_appid', String(b.appid).trim())
  if (b.secret) await putSetting(db, 'wx_secret', String(b.secret).trim())
  if (b.tpl !== undefined) await putSetting(db, 'wx_tpl', String(b.tpl).trim())
  if (b.fields) await putSetting(db, 'wx_fields', String(b.fields).trim())
  await logAudit(db, '微信提醒配置', '设置', '更新微信订阅消息配置')
  return c.json({ ok: true })
})
// 前端 wx.login 拿到的 code 换 openid
app.post('/wx-login', async (c) => {
  const db = c.env.DB
  const { code } = await c.req.json()
  if (!code) return c.json({ error: '缺少 code' }, 400)
  const cfg = await wxCfg(db)
  if (!cfg.appid || !cfg.secret) return c.json({ error: '后台还没填 AppID / AppSecret' }, 400)
  const r = await fetch(WX_API + '/sns/jscode2session?appid=' + encodeURIComponent(cfg.appid) + '&secret=' + encodeURIComponent(cfg.secret) + '&js_code=' + encodeURIComponent(code) + '&grant_type=authorization_code')
  const d = await r.json()
  if (!d.openid) return c.json({ error: '换 openid 失败：' + (d.errmsg || JSON.stringify(d).slice(0, 80)) }, 400)
  const old = await db.prepare('SELECT * FROM wx_users WHERE openid=?').bind(d.openid).first()
  if (old) await db.prepare('UPDATE wx_users SET last_at=? WHERE id=?').bind(now(), old.id).run()
  else await db.prepare('INSERT INTO wx_users (openid, nickname, quota, created_at, last_at) VALUES (?,?,0,?,?)').bind(d.openid, '', now(), now()).run()
  return c.json({ ok: true, openid: d.openid })
})
// 用户点了「允许」之后加一条推送额度
app.post('/wx-subscribed', async (c) => {
  const db = c.env.DB
  const { openid, n } = await c.req.json()
  if (!openid) return c.json({ error: '缺少 openid' }, 400)
  const add = Math.max(1, Math.min(10, num(n, 1)))
  const u = await db.prepare('SELECT * FROM wx_users WHERE openid=?').bind(openid).first()
  if (!u) return c.json({ error: '这个微信还没登记，先点「开启微信提醒」' }, 400)
  await db.prepare('UPDATE wx_users SET quota = quota + ?, last_at=? WHERE id=?').bind(add, now(), u.id).run()
  return c.json({ ok: true, quota: num(u.quota) + add })
})
app.post('/wx-test', async (c) => {
  const db = c.env.DB
  try {
    const items = (await dueReminderItems(db)) || { title: '测试提醒', time: now().slice(0, 10), note: '能收到就说明配通了' }
    const res = await wxPush(db, items)
    return c.json({ ok: true, sent: res })
  } catch (e) {
    return c.json({ error: String(e.message || e).slice(0, 120) }, 400)
  }
})
app.get('/wx-status', async (c) => {
  const db = c.env.DB
  const cfg = await wxCfg(db)
  const us = (await db.prepare('SELECT openid, quota, last_at FROM wx_users ORDER BY id').all()).results
  return c.json({
    ready: !!(cfg.appid && cfg.secret && cfg.tpl),
    appid: cfg.appid, tpl: cfg.tpl, fields: cfg.fields,
    users: us.map((u) => ({ openid: String(u.openid).slice(0, 8) + '**', quota: num(u.quota), last_at: u.last_at }))
  })
})

// 报表抬头（厂名 / 备注），所有对外单据统一带上
const headInfo = async (db) => {
  try {
    const rows = (await db.prepare("SELECT key, value FROM settings WHERE key IN ('report_title','report_note')").all()).results
    const g = (k) => ((rows.find((r) => r.key === k) || {}).value || '')
    return { title: g('report_title') || '加工费记账', note: g('report_note') }
  } catch (e) { return { title: '加工费记账', note: '' } }
}
// 对方档案（联系人/电话/地址/备注）——对账单、收据上带出来
const profLine = async (db, party) => {
  try {
    const p = await db.prepare('SELECT * FROM party_profiles WHERE party=?').bind(String(party || '')).first()
    if (!p) return ''
    const bits = []
    if (p.contact) bits.push('联系人 ' + p.contact)
    if (p.phone) bits.push('电话 ' + p.phone)
    if (p.addr) bits.push('地址 ' + p.addr)
    if (p.note) bits.push(p.note)
    return bits.length ? bits.join('　') : ''
  } catch (e) { return '' }
}
// 把档案行插到「期初/共 N 笔」之前，标题之后
const stampWithProf = async (db, party, lines) => {
  const arr = lines.slice()
  const pf = await profLine(db, party)
  if (pf) {
    let at = arr.findIndex((x) => /^(期初|共 \d+ 笔|本月新增)/.test(String(x)))
    if (at < 0) at = Math.min(1, arr.length)
    arr.splice(at, 0, pf)
  }
  return arr.join('\n')
}
const titled = async (db, rest) => {
  const h = await headInfo(db)
  const out = [`【${h.title}】${rest}`]
  if (h.note) out.push(`（${h.note}）`)
  return out
}

// 首页汇总
// ── 资金账户 / 收支分类 / 预收预付 ──
const DEFAULT_ACCOUNTS = [['现金', 'cash'], ['银行卡', 'bank'], ['微信', 'wechat'], ['支付宝', 'alipay']]
const ensureAccounts = async (db) => {
  try {
    const c = await db.prepare('SELECT COUNT(*) AS n FROM accounts').first()
    if (num(c.n) > 0) return
    for (const [n, k] of DEFAULT_ACCOUNTS) {
      await db.prepare('INSERT INTO accounts (name, kind, opening, created_at) VALUES (?,?,0,?)').bind(n, k, now()).run()
    }
  } catch (e) { console.error('ensureAccounts', e) }
}
const defaultAccountId = async (db) => {
  await ensureAccounts(db)
  const r = await db.prepare('SELECT id FROM accounts ORDER BY id LIMIT 1').first()
  return r ? num(r.id) : 0
}
// 账户余额 = 期初 + 现金流入 − 现金流出
const accountBalances = async (db) => {
  await ensureAccounts(db)
  const accs = (await db.prepare('SELECT * FROM accounts ORDER BY id').all()).results || []
  // 一次分组查完所有账户的收支（原来每个账户查 2 次，账户多就慢）
  const sums = (await db.prepare("SELECT account_id, direction, COALESCE(SUM(amount),0) AS t FROM ledger WHERE cash=1 GROUP BY account_id, direction").all()).results || []
  const map = {}
  for (const r of sums) {
    const k = num(r.account_id) || 0
    const o = map[k] || (map[k] = { i: 0, o: 0 })
    if (r.direction === 'in') o.i = round2(num(r.t)); else o.o = round2(num(r.t))
  }
  const firstId = accs.length ? accs[0].id : 0
  const zero = map[0] || { i: 0, o: 0 }
  return accs.map((a) => {
    const own = map[a.id] || { i: 0, o: 0 }
    // 未指定账户的老流水（account_id 为 0 或空）归到第一个账户，保证总余额对得上
    const i = round2(own.i + (a.id === firstId ? zero.i : 0))
    const o = round2(own.o + (a.id === firstId ? zero.o : 0))
    return { id: a.id, name: a.name, kind: a.kind, opening: round2(num(a.opening)), in: i, out: o, balance: round2(num(a.opening) + i - o) }
  })
}

app.get('/accounts', async (c) => {
  const list = await accountBalances(c.env.DB)
  const total = round2(list.reduce((s, a) => s + a.balance, 0))
  return c.json({ accounts: list, total_balance: total })
})

app.post('/accounts', async (c) => {
  const { name, kind, opening } = await c.req.json()
  const nm = String(name || '').trim()
  if (!nm) return c.json({ error: '账户名称必填' }, 400)
  if (nm.length > 12) return c.json({ error: '名称最多 12 个字' }, 400)
  const db = c.env.DB
  await ensureAccounts(db)
  const has = await db.prepare('SELECT 1 FROM accounts WHERE name=?').bind(nm).first()
  if (has) return c.json({ error: '已经有同名账户了' }, 400)
  await db.prepare('INSERT INTO accounts (name, kind, opening, created_at) VALUES (?,?,?,?)')
    .bind(nm, String(kind || 'cash'), num(opening), now()).run()
  await logAudit(db, '新增账户', nm, `${nm} 期初 ¥${num(opening)}`)
  return c.json({ ok: true })
})

app.patch('/accounts/:id', async (c) => {
  const id = c.req.param('id')
  const { name, opening } = await c.req.json()
  const db = c.env.DB
  const a = await db.prepare('SELECT * FROM accounts WHERE id=?').bind(id).first()
  if (!a) return c.json({ error: '账户不存在' }, 404)
  const nm = name !== undefined ? String(name).trim() || a.name : a.name
  await db.prepare('UPDATE accounts SET name=?, opening=? WHERE id=?')
    .bind(nm, opening !== undefined ? num(opening) : num(a.opening), id).run()
  await logAudit(db, '改账户', nm, `${nm} 期初 ${num(opening)}`)
  return c.json({ ok: true })
})

app.delete('/accounts/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const used = await db.prepare('SELECT COUNT(*) AS n FROM ledger WHERE account_id=?').bind(id).first()
  if (num(used.n) > 0) return c.json({ error: '这个账户已经有流水，不能删（可以改名）' }, 400)
  await db.prepare('DELETE FROM accounts WHERE id=?').bind(id).run()
  return c.json({ ok: true })
})

const DEFAULT_CATS_OUT = ['工资', '水电', '房租', '采购', '辅料', '运费', '维修', '税金', '其他']
const DEFAULT_CATS_IN = ['加工费', '维修', '其他']
const ensureCats = async (db) => {
  try {
    const c = await db.prepare('SELECT COUNT(*) AS n FROM categories').first()
    if (num(c.n) > 0) return
    let i = 0
    for (const n of DEFAULT_CATS_OUT) await db.prepare('INSERT INTO categories (type, name, sort, created_at) VALUES (?,?,?,?)').bind('out', n, i++, now()).run()
    i = 0
    for (const n of DEFAULT_CATS_IN) await db.prepare('INSERT INTO categories (type, name, sort, created_at) VALUES (?,?,?,?)').bind('in', n, i++, now()).run()
  } catch (e) { console.error('ensureCats', e) }
}

app.get('/categories', async (c) => {
  const db = c.env.DB
  await ensureCats(db)
  const rows = (await db.prepare('SELECT * FROM categories ORDER BY type, sort, id').all()).results
  return c.json({
    out: rows.filter((r) => r.type === 'out').map((r) => ({ id: r.id, name: r.name })),
    inn: rows.filter((r) => r.type === 'in').map((r) => ({ id: r.id, name: r.name }))
  })
})

app.post('/categories', async (c) => {
  const { type, name } = await c.req.json()
  const t = type === 'in' ? 'in' : 'out'
  const nm = String(name || '').trim()
  if (!nm) return c.json({ error: '分类名称必填' }, 400)
  if (nm.length > 10) return c.json({ error: '名称最多 10 个字' }, 400)
  const db = c.env.DB
  await ensureCats(db)
  const has = await db.prepare('SELECT 1 FROM categories WHERE type=? AND name=?').bind(t, nm).first()
  if (has) return c.json({ error: '这个分类已存在' }, 400)
  const mx = await db.prepare('SELECT COALESCE(MAX(sort),0) AS s FROM categories WHERE type=?').bind(t).first()
  await db.prepare('INSERT INTO categories (type, name, sort, created_at) VALUES (?,?,?,?)').bind(t, nm, num(mx.s) + 1, now()).run()
  return c.json({ ok: true })
})

app.delete('/categories/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  await db.prepare('DELETE FROM categories WHERE id=?').bind(id).run()
  return c.json({ ok: true })
})

// 预收款（客户先打钱给活还没做）/ 预付款（先付供应商定金）
// 单位重名/改名：同一家被记成两个名字，对账就永远对不上——扫出来、一键合并
app.get('/party-dups', async (c) => {
  const db = c.env.DB
  const [oR, pR] = await Promise.all([
    db.prepare('SELECT customer party, COUNT(*) n, COALESCE(SUM(price-COALESCE(paid,0)-COALESCE(written_off,0)),0) rem FROM orders GROUP BY customer').all().catch(() => ({ results: [] })),
    db.prepare('SELECT supplier party, COUNT(*) n, COALESCE(SUM(amount-COALESCE(paid,0)-COALESCE(written_off,0)),0) rem FROM payables GROUP BY supplier').all().catch(() => ({ results: [] }))
  ])
  const all = []
  for (const r of ((oR && oR.results) || [])) all.push({ party: r.party || '', side: 'ar', n: num(r.n), left: round2(num(r.rem)) })
  for (const r of ((pR && pR.results) || [])) all.push({ party: r.party || '', side: 'ap', n: num(r.n), left: round2(num(r.rem)) })
  const g = {}
  for (const x of all) {
    if (!x.party) continue
    const k = norm(x.party)
    g[k] = g[k] || []
    g[k].push(x)
  }
  const groups = []
  for (const k of Object.keys(g)) {
    const names = Array.from(new Set(g[k].map((x) => x.party)))
    if (names.length < 2) continue
    // 建议保留「用得最多的那个名字」（单数最多），没有就用最长的
    const cntOf = (nm) => g[k].filter((x) => x.party === nm).reduce((t, x) => t + x.n, 0)
    const keep = names.slice().sort((a, b) => (cntOf(b) - cntOf(a)) || (b.length - a.length))[0]
    groups.push({ key: k, names, keep,
      rows: g[k].map((x) => ({ party: x.party, side: x.side, cnt: x.n, left: x.left })) })
  }
  return c.json({ ok: true, count: groups.length, groups,
    advice: groups.length ? `有 ${groups.length} 组名字看着是同一家（比如「兴旺五金」和「兴旺五金加工厂」），合并后对账才不会再分成两家。` : '没发现重名：每个客户/供应商只有一种写法。' })
})

// 合并/改名：把 from 改成 to（to 已存在就是合并），所有用到这个名字的表一起改
app.post('/party-merge', async (c) => {
  const b = await c.req.json().catch(() => ({}))
  const from = String(b.from || '').trim()
  const to = String(b.to || '').trim()
  if (!from || !to) return c.json({ error: '要填「原来的名字」和「改成的名字」' }, 400)
  if (from === to) return c.json({ error: '两个名字一样，不用改' }, 400)
  const db = c.env.DB
  const month = String(b.month || now().slice(0, 7)).slice(0, 7)
  if (b.force !== true && (await isMonthLocked(db, month))) {
    // 只拦「动到锁定月份单据」的情况
    const hit = await db.prepare("SELECT COUNT(*) n FROM orders WHERE customer=? AND month=?").bind(from, month).first()
    const hit2 = await db.prepare("SELECT COUNT(*) n FROM payables WHERE supplier=? AND month=?").bind(from, month).first()
    if (num(hit && hit.n) + num(hit2 && hit2.n) > 0) return c.json({ error: `${month} 已结账锁定，这个月的单据名字先别改（可以换个月或先解锁）` }, 403)
  }
  const counts = {}
  const step = async (label, sql, ...args) => {
    try {
      const r = await db.prepare(sql).bind(...args).run()
      counts[label] = (r.meta && r.meta.changes != null) ? r.meta.changes : 0
    } catch (e) { counts[label] = -1 }
  }
  await step('应收单', 'UPDATE orders SET customer=? WHERE customer=?', to, from)
  await step('应付单', 'UPDATE payables SET supplier=? WHERE supplier=?', to, from)
  await step('预收预付', 'UPDATE advances SET party=? WHERE party=?', to, from)
  await step('对账记录', 'UPDATE recon_log SET party=? WHERE party=?', to, from)
  await step('催款记录', 'UPDATE dunning_log SET party=? WHERE party=?', to, from)
  await step('对账单记录', 'UPDATE statement_log SET party=? WHERE party=?', to, from)
  // 这两张是 UNIQUE(party)，目标已存在就删掉源记录（保留目标那份）
  for (const [label, table] of [['账期设置', 'party_terms'], ['单位档案', 'party_profiles'], ['信用额度', 'credit_limits']]) {
    const hasSrc = await db.prepare(`SELECT 1 FROM ${table} WHERE party=?`).bind(from).first().catch(() => null)
    if (!hasSrc) { counts[label] = 0; continue }
    const hasDst = await db.prepare(`SELECT 1 FROM ${table} WHERE party=?`).bind(to).first().catch(() => null)
    if (hasDst) {
      const r = await db.prepare(`DELETE FROM ${table} WHERE party=?`).bind(from).run().catch(() => null)
      counts[label] = (r && r.meta && r.meta.changes) || 0
      counts[label + '(删源留目标)'] = counts[label]
    } else {
      const r = await db.prepare(`UPDATE ${table} SET party=? WHERE party=?`).bind(to, from).run().catch(() => null)
      counts[label] = (r && r.meta && r.meta.changes) || 0
    }
  }
  const moved = Object.keys(counts).reduce((s, k) => s + Math.max(0, counts[k] || 0), 0)
  await logAudit(db, '合并/改名', to, `${from} → ${to}（动了 ${moved} 处）`, '', act(c))
  return c.json({ ok: true, from, to, counts, moved,
    note: `已把「${from}」全部改成「${to}」，动了 ${moved} 处。以后记账都用新名字，对账就不会再分成两家。` })
})

// 钱的三条线：客户先给的（预收）/ 员工借支未清 / 外面借的钱——首页一屏看清
app.get('/funding', async (c) => {
  const db = c.env.DB
  const one = (sql) => db.prepare(sql).first().catch((e) => { noteFail(e, '资金三条线'); return null })
  const [adv, loan, debts, reps] = await Promise.all([
    db.prepare('SELECT type, COUNT(*) n, COALESCE(SUM(amount - COALESCE(used,0)),0) r FROM advances GROUP BY type').all().catch((e) => { noteFail(e, '资金三条线'); return { results: [] } }),
    one('SELECT COUNT(DISTINCT staff) s, COUNT(*) n, COALESCE(SUM(amount - COALESCE(used,0) - COALESCE(returned,0)),0) r FROM loans WHERE amount - COALESCE(used,0) - COALESCE(returned,0) > 0.005'),
    db.prepare("SELECT * FROM debts WHERE COALESCE(status,'')<>'closed'").all().catch(() => ({ results: [] })),
    db.prepare("SELECT debt_id, COALESCE(SUM(amount),0) t FROM debt_repays WHERE kind='principal' GROUP BY debt_id").all().catch(() => ({ results: [] }))
  ])
  const advRows = (adv && adv.results) || []
  const g = (t) => {
    const x = advRows.find((r) => r.type === t)
    return { amt: x ? round2(num(x.r)) : 0, cnt: x ? num(x.n) : 0 }
  }
  const pin = g('in'), pout = g('out')
  const L = loan || { s: 0, n: 0, r: 0 }
  const repMap = {}
  for (const r of ((reps && reps.results) || [])) repMap[r.debt_id] = num(r.t)
  let dPrin = 0, dInt = 0, dCnt = 0, dOver = 0
  const today = now().slice(0, 10)
  for (const d of ((debts && debts.results) || [])) {
    const remain = round2(Math.max(num(d.principal) - num(repMap[d.id]), 0))
    if (remain <= 0.005) continue
    dPrin += remain
    dInt += remain * num(d.rate) / 1200
    dCnt++
    if (d.next_due && String(d.next_due).slice(0, 10) < today) dOver++
  }
  dPrin = round2(dPrin); dInt = round2(dInt)
  const rows = []
  if (pin.amt > 0) rows.push({ k: 'prepaid_in', label: '客户先给的钱（预收款）', amt: pin.amt, cnt: pin.cnt, tab: 'me', tip: '还没干活就已经收的钱，要用货/加工抵掉，不是赚到的' })
  if (pout.amt > 0) rows.push({ k: 'prepaid_out', label: '付给供应商的预付款', amt: pout.amt, cnt: pout.cnt, tab: 'me', tip: '钱付了、料还没到，记着催货或抵货款' })
  if (num(L.r) > 0) rows.push({ k: 'loan', label: '员工借支没清', amt: round2(num(L.r)), cnt: num(L.n), tab: 'me', tip: `${num(L.s)} 个人还挂着钱，报销或退回来就平了` })
  if (dPrin > 0) rows.push({ k: 'debt', label: '外面借的钱（还没还完）', amt: dPrin, cnt: dCnt, tab: 'me', tip: `每月利息约 ${dInt} 元${dOver ? `，有 ${dOver} 笔还款已过期` : ''}` })
  const parts = rows.map((r) => `${r.label} ${r.amt}`)
  const text = rows.length
    ? `还没结清的往来：${parts.join('；')}。这些钱都不算收入/利润，只是欠着或被欠着。`
    : '没有预收款、没有员工借支、没有借款，这三块都是干净的。'
  return c.json({ ok: true, prepaid_in: pin, prepaid_out: pout,
    loan: { amt: round2(num(L.r)), cnt: num(L.n), staff: num(L.s) },
    debt: { amt: dPrin, cnt: dCnt, month_interest: dInt, overdue: dOver },
    count: rows.length, rows, text })
})

app.get('/advances', async (c) => {
  const db = c.env.DB
  const t = c.req.query('type') === 'out' ? 'out' : 'in'
  const rows = (await db.prepare('SELECT * FROM advances WHERE type=? ORDER BY id DESC').bind(t).all()).results
  return c.json(rows.map((r) => ({ ...r, remain: round2(num(r.amount) - num(r.used)) })))
})

app.post('/advances', async (c) => {
  const body = await c.req.json()
  const { type, party, amount, remark, account_id, date } = body
  const t = type === 'out' ? 'out' : 'in'
  const nm = String(party || '').trim()
  const a = num(amount)
  if (!nm) return c.json({ error: t === 'in' ? '客户名称必填' : '供应商名称必填' }, 400)
  if (a <= 0) return c.json({ error: '金额必须大于 0' }, 400)
  const db = c.env.DB
  const cid = String(body.client_id || '')
  if (await opSeen(db, cid)) return c.json({ ok: true, dup_ok: true })
  if (await isMonthLocked(db, now().slice(0, 7))) return c.json({ error: '本月已结账锁定，先解锁再记账' }, 403)
  const acc = num(account_id) || (await defaultAccountId(db))
  const created = normDate(date)
  const r = await db.prepare('INSERT INTO advances (type, party, amount, used, remark, account_id, created_at) VALUES (?,?,?,0,?,?,?)')
    .bind(t, nm, a, remark || '', acc, created).run()
  const aid = r.meta && r.meta.last_row_id ? r.meta.last_row_id : 0
  await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES (?,?,?,?,?,?,?,1,?)")
    .bind(t === 'in' ? 'in' : 'out', 'advance', aid, a, t === 'in' ? '预收款' : '预付款', `${t === 'in' ? '收预收' : '付预付'} ${nm}${remark ? ' ' + remark : ''}`, acc, created).run()
  await opMark(db, cid, 'advance', aid)
  await logAudit(db, t === 'in' ? '收预收款' : '付预付款', nm, `${nm} ¥${a}`)
  return c.json({ ok: true, id: aid })
})

app.delete('/advances/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const ad = await db.prepare('SELECT * FROM advances WHERE id=?').bind(id).first()
  if (!ad) return c.json({ error: '记录不存在' }, 404)
  if (num(ad.used) > 0) return c.json({ error: '已经抵扣过，不能删' }, 400)
  if (await isMonthLocked(db, (ad.created_at || '').slice(0, 7))) return c.json({ error: '该记录所在月份已结账锁定' }, 403)
  await db.batch([
    db.prepare('DELETE FROM advances WHERE id=?').bind(id),
    db.prepare("DELETE FROM ledger WHERE ref_type='advance' AND ref_id=?").bind(id)
  ])
  await logAudit(db, '删除预收预付', ad.party, `${ad.party} ¥${ad.amount}`)
  return c.json({ ok: true })
})

// 用预收款抵扣应收单（不动现金，只冲往来）
app.post('/orders/:id/apply-advance', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const db = c.env.DB
  const o = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first()
  if (!o) return c.json({ error: '订单不存在' }, 404)
  const unpaid = round2(num(o.price) - num(o.paid))
  if (unpaid <= 0) return c.json({ error: '这张单已经收清了' }, 400)
  const list = (await db.prepare("SELECT * FROM advances WHERE type='in' AND party=? AND used < amount ORDER BY created_at, id").bind(o.customer).all()).results
  if (!list.length) return c.json({ error: `${o.customer} 没有可用的预收款` }, 400)
  let left = body.amount ? Math.min(num(body.amount), unpaid) : unpaid
  if (left <= 0) return c.json({ error: '金额无效' }, 400)
  let total = 0
  for (const ad of list) {
    if (left <= 0) break
    const remain = round2(num(ad.amount) - num(ad.used))
    if (remain <= 0) continue
    const use = Math.min(remain, left)
    await db.prepare('UPDATE advances SET used=used+? WHERE id=?').bind(use, ad.id).run()
    total = round2(total + use)
    left = round2(left - use)
  }
  if (total <= 0) return c.json({ error: '没有可抵扣金额' }, 400)
  await db.batch([
    db.prepare('UPDATE orders SET paid=paid+?, rev=COALESCE(rev,0)+1 WHERE id=?').bind(total, id),
    db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, remark, account_id, cash, created_at) VALUES ('in','order',?,?,?,?,0,?)")
      .bind(id, total, `预收款抵扣 ${o.customer} ${o.item_name}`, 0, now())
  ])
  await logAudit(db, '预收抵扣', o.customer, `${o.customer} 用预收抵扣 ¥${total}`)
  return c.json({ ok: true, applied: total })
})

// 用预付款抵扣应付单
app.post('/payables/:id/apply-advance', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const db = c.env.DB
  const p = await db.prepare('SELECT * FROM payables WHERE id=?').bind(id).first()
  if (!p) return c.json({ error: '应付单不存在' }, 404)
  const unpaid = round2(num(p.amount) - num(p.paid))
  if (unpaid <= 0) return c.json({ error: '这笔已经付清了' }, 400)
  const list = (await db.prepare("SELECT * FROM advances WHERE type='out' AND party=? AND used < amount ORDER BY created_at, id").bind(p.supplier).all()).results
  if (!list.length) return c.json({ error: `${p.supplier} 没有可用的预付款` }, 400)
  let left = body.amount ? Math.min(num(body.amount), unpaid) : unpaid
  if (left <= 0) return c.json({ error: '金额无效' }, 400)
  let total = 0
  for (const ad of list) {
    if (left <= 0) break
    const remain = round2(num(ad.amount) - num(ad.used))
    if (remain <= 0) continue
    const use = Math.min(remain, left)
    await db.prepare('UPDATE advances SET used=used+? WHERE id=?').bind(use, ad.id).run()
    total = round2(total + use)
    left = round2(left - use)
  }
  if (total <= 0) return c.json({ error: '没有可抵扣金额' }, 400)
  await db.batch([
    db.prepare('UPDATE payables SET paid=paid+?, rev=COALESCE(rev,0)+1 WHERE id=?').bind(total, id),
    db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, remark, account_id, cash, created_at) VALUES ('out','payable',?,?,?,?,0,?)")
      .bind(id, total, `预付款抵扣 ${p.supplier}`, 0, now())
  ])
  await logAudit(db, '预付抵扣', p.supplier, `${p.supplier} 用预付抵扣 ¥${total}`)
  return c.json({ ok: true, applied: total })
})

// ── 员工借支 / 报销 ──
// 借支：钱先给员工（现金出），不算成本；报销：按分类记支出，冲借支不动现金；退回：钱回口袋
async function reimburseStaff(db, staff, amount, category, remark, date, acc) {
  const list = (await db.prepare('SELECT * FROM loans WHERE staff=? AND used + returned < amount ORDER BY created_at, id').bind(staff).all()).results
  let left = round2(amount)
  let used = 0
  for (const l of list) {
    if (left <= 0) break
    const remain = round2(num(l.amount) - num(l.used) - num(l.returned))
    if (remain <= 0) continue
    const use = round2(Math.min(remain, left))
    await db.prepare('UPDATE loans SET used = used + ? WHERE id=?').bind(use, l.id).run()
    await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('out','expense',?,?,?,?,?,0,?)")
      .bind(l.id, use, category || '', `报销冲借支 ${staff}${remark ? ' ' + remark : ''}`, num(l.account_id) || acc, date).run()
    used = round2(used + use)
    left = round2(left - use)
  }
  if (left > 0) {
    await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('out','expense',0,?,?,?,?,1,?)")
      .bind(left, category || '', `报销现付 ${staff}${remark ? ' ' + remark : ''}`, acc, date).run()
  }
  return { used, cash: left }
}

app.get('/loans', async (c) => {
  const db = c.env.DB
  const rows = (await db.prepare('SELECT * FROM loans ORDER BY id DESC').all()).results
  const list = rows.map((r) => ({
    ...r,
    remain: round2(num(r.amount) - num(r.used) - num(r.returned))
  }))
  const map = {}
  list.forEach((r) => {
    const k = r.staff
    map[k] = map[k] || { staff: k, out: 0, used: 0, returned: 0, remain: 0, cnt: 0 }
    map[k].out = round2(map[k].out + num(r.amount))
    map[k].used = round2(map[k].used + num(r.used))
    map[k].returned = round2(map[k].returned + num(r.returned))
    map[k].remain = round2(map[k].remain + r.remain)
    map[k].cnt++
  })
  const staff = Object.values(map).sort((a, b) => b.remain - a.remain)
  return c.json({
    list,
    staff,
    open_total: round2(list.reduce((s2, r) => s2 + r.remain, 0))
  })
})

app.post('/loans', async (c) => {
  const { staff, amount, remark, account_id, date } = await c.req.json()
  const nm = String(staff || '').trim()
  const a = num(amount)
  if (!nm) return c.json({ error: '员工姓名必填' }, 400)
  if (a <= 0) return c.json({ error: '金额必须大于 0' }, 400)
  const db = c.env.DB
  const d = normDate(date)
  if (await isMonthLocked(db, (d || '').slice(0, 7))) return c.json({ error: '该月已结账锁定' }, 403)
  const acc = num(account_id) || (await defaultAccountId(db))
  const r = await db.prepare('INSERT INTO loans (staff, amount, used, returned, remark, account_id, created_at) VALUES (?,?,0,0,?,?,?)')
    .bind(nm, a, remark || '', acc, d).run()
  const lid = r.meta && r.meta.last_row_id ? r.meta.last_row_id : 0
  await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('out','loan',?,?,'借支',?,?,1,?)")
    .bind(lid, a, `借支 ${nm}${remark ? ' ' + remark : ''}`, acc, d).run()
  await logAudit(db, '员工借支', nm, `${nm} 借出 ¥${a}`)
  return c.json({ ok: true, id: lid })
})

app.post('/loans/:id/reimburse', async (c) => {
  const id = c.req.param('id')
  const { amount, category, remark, date } = await c.req.json()
  const db = c.env.DB
  const l = await db.prepare('SELECT * FROM loans WHERE id=?').bind(id).first()
  if (!l) return c.json({ error: '借支记录不存在' }, 404)
  const remain = round2(num(l.amount) - num(l.used) - num(l.returned))
  if (remain <= 0) return c.json({ error: '这笔借支已经结清了' }, 400)
  let a = num(amount) > 0 ? round2(num(amount)) : remain
  if (a > remain) a = remain
  const acc = num(l.account_id) || (await defaultAccountId(db))
  await db.prepare('UPDATE loans SET used = used + ? WHERE id=?').bind(a, id).run()
  await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('out','expense',?,?,?,?,?,0,?)")
    .bind(id, a, category || '', `报销冲借支 ${l.staff}${remark ? ' ' + remark : ''}`, acc, normDate(date)).run()
  await logAudit(db, '员工报销', l.staff, `${l.staff} 报销冲借支 ¥${a}`)
  return c.json({ ok: true, amount: a, remain: round2(remain - a) })
})

app.post('/loans/:id/return', async (c) => {
  const id = c.req.param('id')
  const { amount, account_id, date } = await c.req.json()
  const db = c.env.DB
  const l = await db.prepare('SELECT * FROM loans WHERE id=?').bind(id).first()
  if (!l) return c.json({ error: '借支记录不存在' }, 404)
  const remain = round2(num(l.amount) - num(l.used) - num(l.returned))
  if (remain <= 0) return c.json({ error: '这笔借支已经结清了' }, 400)
  let a = num(amount) > 0 ? round2(num(amount)) : remain
  if (a > remain) a = remain
  const acc = num(account_id) || num(l.account_id) || (await defaultAccountId(db))
  await db.prepare('UPDATE loans SET returned = returned + ? WHERE id=?').bind(a, id).run()
  await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, remark, account_id, cash, created_at) VALUES ('in','loan_return',?,?,?,?,1,?)")
    .bind(id, a, `退回借支余款 ${l.staff}`, acc, normDate(date)).run()
  await logAudit(db, '退回借支', l.staff, `${l.staff} 退回 ¥${a}`)
  return c.json({ ok: true, amount: a, remain: round2(remain - a) })
})

app.delete('/loans/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const l = await db.prepare('SELECT * FROM loans WHERE id=?').bind(id).first()
  if (!l) return c.json({ error: '记录不存在' }, 404)
  if (num(l.used) > 0 || num(l.returned) > 0) return c.json({ error: '已经报销/退回过，不能直接删（可把报销记录删掉再删）' }, 400)
  await db.batch([
    db.prepare('DELETE FROM loans WHERE id=?').bind(id),
    db.prepare("DELETE FROM ledger WHERE ref_type='loan' AND ref_id=?").bind(id)
  ])
  await logAudit(db, '删借支', l.staff, `${l.staff} ¥${l.amount}`)
  return c.json({ ok: true })
})

// 导入模板（CSV，可直接用 Excel 打开）

// ===================== Excel（.xlsx）读写：不依赖第三方库 =====================
// 读：手动解 zip（DecompressionStream）→ 解析 SheetML
// 写：手动打 zip（CompressionStream deflate-raw）+ 最小 SheetML
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(u8) {
  let c = 0xffffffff
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

async function streamBytes(u8, kind) {
  const Ctor = kind === 'compress' ? CompressionStream : DecompressionStream
  const st = new Blob([u8]).stream().pipeThrough(new Ctor('deflate-raw'))
  return new Uint8Array(await new Response(st).arrayBuffer())
}

async function unzipAll(buf) {
  const u8 = new Uint8Array(buf)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  let eocd = -1
  const floor = Math.max(0, u8.length - 66000)
  for (let i = u8.length - 22; i >= floor; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx 文件（请用 Excel 另存为 .xlsx）')
  const count = dv.getUint16(eocd + 10, true)
  let off = dv.getUint32(eocd + 16, true)
  const dec = new TextDecoder()
  const out = {}
  for (let i = 0; i < count; i++) {
    if (off + 46 > u8.length || dv.getUint32(off, true) !== 0x02014b50) break
    const method = dv.getUint16(off + 10, true)
    const csize = dv.getUint32(off + 20, true)
    const nlen = dv.getUint16(off + 28, true)
    const elen = dv.getUint16(off + 30, true)
    const clen = dv.getUint16(off + 32, true)
    const lho = dv.getUint32(off + 42, true)
    const name = dec.decode(u8.subarray(off + 46, off + 46 + nlen))
    const lnlen = dv.getUint16(lho + 26, true)
    const lelen = dv.getUint16(lho + 28, true)
    const dstart = lho + 30 + lnlen + lelen
    const data = u8.subarray(dstart, dstart + csize)
    out[name] = method === 0 ? data : await streamBytes(data, 'decompress')
    off += 46 + nlen + elen + clen
  }
  return out
}

function xmlUnesc(x) {
  return String(x).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, '&')
}

function colIdx(letters) {
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

// Excel 日期是数字序号（1899-12-30 起），转成 YYYY-MM-DD
function xlSerialToIso(v) {
  const n = Number(v)
  if (!isFinite(n) || n < 20000 || n > 60000) return null
  const ms = Math.round((n - 25569) * 86400000)
  return new Date(ms).toISOString().slice(0, 10)
}

async function xlsxToRows(buf) {
  const files = await unzipAll(buf)
  const dec = new TextDecoder()
  const sheets = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()
  if (!sheets.length) throw new Error('这个文件里没有工作表')
  let shared = []
  if (files['xl/sharedStrings.xml']) {
    const sx = dec.decode(files['xl/sharedStrings.xml'])
    shared = (sx.match(/<si[\s>][\s\S]*?<\/si>/g) || []).map((si) => {
      const ts = si.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []
      return xmlUnesc(ts.map((x) => x.replace(/<[^>]+>/g, '')).join(''))
    })
  }
  const sheet = dec.decode(files[sheets[0]])
  const rows = []
  for (const rx of sheet.match(/<row[\s>][\s\S]*?<\/row>/g) || []) {
    const cells = []
    for (const cx of rx.match(/<c[\s>][\s\S]*?<\/c>|<c[^>]*\/>/g) || []) {
      const ref = (cx.match(/r="([A-Z]+)\d+"/) || [])[1] || ''
      const ta = (cx.match(/t="([^"]+)"/) || [])[1] || ''
      let v = ''
      if (ta === 's') {
        const idx = Number((cx.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || -1)
        v = shared[idx] || ''
      } else if (ta === 'inlineStr' || ta === 'str') {
        v = xmlUnesc(((cx.match(/<is>[\s\S]*?<\/is>/) || cx.match(/<v>[\s\S]*?<\/v>/) || [''])[0]).replace(/<[^>]+>/g, ''))
      } else {
        const raw = (cx.match(/<v>([\s\S]*?)<\/v>/) || [])[1]
        if (raw == null) v = ''
        else {
          const iso = xlSerialToIso(raw)
          v = iso || xmlUnesc(raw)
        }
      }
      const col = ref ? colIdx(ref) : cells.length
      cells[col] = String(v).replace(/\s+/g, ' ').trim()
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = ''
    if (cells.some((x) => x !== '')) rows.push(cells)
  }
  return rows
}

async function zipMake(entries) {
  const enc = new TextEncoder()
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const nameB = enc.encode(e.name)
    const raw = typeof e.data === 'string' ? enc.encode(e.data) : e.data
    const comp = await streamBytes(raw, 'compress')
    const crc = crc32(raw)
    const lh = new Uint8Array(30 + nameB.length)
    const lv = new DataView(lh.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x0800, true)
    lv.setUint16(8, 8, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, comp.length, true)
    lv.setUint32(22, raw.length, true)
    lv.setUint16(26, nameB.length, true)
    lh.set(nameB, 30)
    locals.push(lh, comp)
    const ch = new Uint8Array(46 + nameB.length)
    const cv = new DataView(ch.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 8, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, comp.length, true)
    cv.setUint32(24, raw.length, true)
    cv.setUint16(28, nameB.length, true)
    cv.setUint32(42, offset, true)
    ch.set(nameB, 46)
    centrals.push(ch)
    offset += lh.length + comp.length
  }
  const cdSize = centrals.reduce((a, x) => a + x.length, 0)
  const eo = new Uint8Array(22)
  const ev = new DataView(eo.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)
  const all = [...locals, ...centrals, eo]
  const total = all.reduce((a, x) => a + x.length, 0)
  const out = new Uint8Array(total)
  let p = 0
  for (const x of all) { out.set(x, p); p += x.length }
  return out
}

function sheetXml(rows, dv) {
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const colName = (i) => {
    let s = ''
    let n = i + 1
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) }
    return s
  }
  const body = rows.map((r, ri) => '<row r="' + (ri + 1) + '">' + r.map((v, ci) => '<c r="' + colName(ci) + (ri + 1) + '" t="inlineStr"><is><t xml:space="preserve">' + esc(v) + '</t></is></c>').join('') + '</row>').join('')
  // 下拉选择（防止把「工资」手打成「工資」造成分类分叉）
  let dvs = ''
  if (Array.isArray(dv) && dv.length) {
    dvs = '<dataValidations count="' + dv.length + '">' + dv.map((x) => '<dataValidation type="list" allowBlank="1" showErrorMessage="1" errorTitle="请从下拉里选" error="别手打，从下拉列表里选一个" sqref="' + x.sq + '"><formula1>"' + String(x.list.join(',')).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;') + '"</formula1></dataValidation>').join('') + '</dataValidations>'
  }
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="8" width="16" customWidth="1"/></cols><sheetData>' + body + '</sheetData>' + dvs + '</worksheet>'
}

async function makeXlsxSheets(sheets) {
  const enc = new TextEncoder()
  const n = sheets.length
  const ctOver = sheets.map((sh, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('')
  const wbSheets = sheets.map((sh, i) => '<sheet name="' + String(sh.name || 'Sheet' + (i + 1)).replace(/[\\\/\?\*\[\]:]/g, '-').slice(0, 28) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('')
  const wbRels = sheets.map((sh, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('')
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + ctOver + '</Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + wbSheets + '</sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + wbRels + '</Relationships>' }
  ]
  sheets.forEach((sh, i) => files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: sheetXml(sh.rows || [], sh.dv) }))
  return zipMake(files)
}

async function makeXlsx(rows) {
  return makeXlsxSheets([{ name: '导入数据', rows }])
}

function toB64(u8) {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk))
  return btoa(s)
}

function fromB64(b64) {
  const bin = atob(String(b64 || '').replace(/^data:[^,]*,/, ''))
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return u8
}

const IMPORT_TEMPLATES = {
  ar: { name: '应收导入模板', rows: [['客户', '产品', '金额', '成本(可空)', '到期日(可空)', '经手人(可空)', '日期(可空)'], ['张老板', '外壳加工', 5000, 3000, '12-05', '小王', '11-05'], ['李老板', '法兰件', 3200, '', '', '', '']] },
  ar_init: { name: '期初应收模板', rows: [['客户', '金额', '日期(可空)'], ['张老板', 5000, ''], ['李老板', 3000, '07-01']] },
  ap: { name: '应付导入模板', rows: [['供应商', '金额', '备注', '到期日(可空)', '经手人(可空)', '日期(可空)'], ['王五金', 2000, '螺丝款', '11-30', '小王', '11-05'], ['李钢材', 5000, '钢板', '', '', '']] },
  ap_init: { name: '期初应付模板', rows: [['供应商', '金额', '日期(可空)'], ['王五金', 2000, ''], ['李钢材', 5000, '']] },
  expense: { name: '支出导入模板', rows: [['金额', '分类', '备注', '经手人(可空)', '日期(可空)'], [1200, '房租', '8月房租', '', '11-01'], [300, '水电', '电费', '', '']] },
  loan: { name: '员工借支模板', rows: [['员工', '金额', '备注', '日期(可空)'], ['张三', 1000, '买辅料', '11-05'], ['李四', 500, '加油', '']] },
  recon: { name: '对账模板（客户/供应商对账单）', rows: [['单位', '金额'], ['张老板', 5000], ['李老板', 4000], ['王老板', 35000]] },
  reimb: { name: '报销模板', rows: [['员工', '金额', '分类', '备注', '日期(可空)'], ['张三', 800, '采购', '买螺丝', '11-06'], ['张三', 200, '运费', '送货油费', '']] }
}

// 下载 Excel 模板（base64 返回，小程序存文件后可直接用 Excel/WPS 打开编辑）
app.get('/import-template-xlsx', async (c) => {
  const t = String(c.req.query('type') || 'ar')
  const T = IMPORT_TEMPLATES[t] || IMPORT_TEMPLATES.ar
  let dv = []
  if (t === 'expense' || t === 'reimb') {
    let list = []
    try {
      const r = await c.env.DB.prepare("SELECT name FROM categories WHERE type='out' ORDER BY sort, id").all()
      list = (r.results || []).map((x) => String(x.name || '').trim()).filter((x) => x && x.indexOf(',') < 0)
    } catch (e) { list = [] }
    if (!list.length) list = ['工资', '水电', '房租', '采购', '辅料', '运费', '维修', '税金', '其他']
    dv = [{ sq: t === 'expense' ? 'B2:B200' : 'C2:C200', list }]
  }
  const xlsx = await makeXlsxSheets([{ name: t === 'expense' ? '支出' : t === 'reimb' ? '报销' : '导入', rows: T.rows, dv }])
  return c.json({ ok: true, name: T.name + '.xlsx', b64: toB64(xlsx), dv: dv.length > 0 })
})

// 直接上传 Excel 文件导入
// 表头判定（与 importRows 内部规则一致，抽出来给预览用）
function stripHeader(rows) {
  if (rows.length && rows[0] && rows[0].length) {
    const KW = /客户|供应商|金额|分类|姓名|员工|产品|项目|日期|备注|摘要/
    const first = rows[0]
    const numish = first.filter((x) => /^[\d.,%\-\s]*$/.test(String(x === null || x === undefined ? '' : x).trim()) && String(x === null || x === undefined ? '' : x).trim() !== '').length
    const wordy = first.filter((x) => KW.test(String(x === null || x === undefined ? '' : x))).length
    if (numish === 0 && wordy >= 2) return { rows: rows.slice(1), skipped: true }
  }
  return { rows, skipped: false }
}

// 导入预览：先看清楚要导什么、哪行有问题、哪行像重复，再决定导不导
async function previewImport(db, type, rawRows) {
  const st = stripHeader(rawRows)
  const rows = st.rows
  const t = now()
  const parsed = []
  for (const row of rows) {
    const p = row.slice()
    let d = t
    let dateGiven = false
    if (p.length > 1 && looksLikeDate(p[p.length - 1])) { d = toIsoDate(p.pop()); dateGiven = true }
    else if (type === 'ar_init' || type === 'ap_init') d = `${todayIso().slice(0, 4)}-01-01T00:00:00.000Z`
    let party = '', item = '', amount = 0, cost = 0, category = '', extra = ''
    if (type === 'ar') { const [c, it, pr, co, dueC, operC] = p; party = c || ''; item = it || ''; amount = num(pr); cost = num(co); extra = [dueC ? '到期 ' + dueC : '', operC ? '经手 ' + operC : ''].filter(Boolean).join(' ') }
    else if (type === 'ar_init' || type === 'ap_init') { const [c, pr] = p; party = c || ''; amount = num(pr) }
    else if (type === 'ap') { const [sp2, am, rm, dueP, operP] = p; party = sp2 || ''; item = rm || ''; amount = num(am); extra = [dueP ? '到期 ' + dueP : '', operP ? '经手 ' + operP : ''].filter(Boolean).join(' ') }
    else if (type === 'expense') { const [am, cat, rm, operE] = p; amount = num(am); category = cat || ''; item = rm || ''; extra = operE ? '经手 ' + operE : '' }
    else if (type === 'loan') { const [sf, am, rm] = p; party = sf || ''; item = rm || ''; amount = num(am) }
    else if (type === 'reimb') { const [sf, am, cat, rm] = p; party = sf || ''; amount = num(am); category = cat || ''; item = rm || '' }
    parsed.push({ party: String(party).trim(), item: String(item).trim(), amount: round2(amount), cost: round2(cost), category: String(category).trim(), date: (d || t).slice(0, 10), date_given: dateGiven, extra })
  }
  // 一次把 7 天窗口内的老单据捞出来，避免逐行查库
  const dates = parsed.map((x) => x.date).filter(Boolean).sort()
  const from = dates.length ? addDaysIso(dates[0], -7) : todayIso()
  const to = dates.length ? dates[dates.length - 1] : todayIso()
  const [arOld, apOld, exOld, locks] = await Promise.all([
    db.prepare("SELECT customer p, price a, substr(created_at,1,10) d FROM orders WHERE substr(created_at,1,10)>=? AND substr(created_at,1,10)<=?").bind(from, to).all().catch(() => ({ results: [] })),
    db.prepare("SELECT supplier p, amount a, substr(created_at,1,10) d FROM payables WHERE substr(created_at,1,10)>=? AND substr(created_at,1,10)<=?").bind(from, to).all().catch(() => ({ results: [] })),
    db.prepare("SELECT category p, amount a, substr(created_at,1,10) d FROM ledger WHERE ref_type='expense' AND substr(created_at,1,10)>=? AND substr(created_at,1,10)<=?").bind(from, to).all().catch(() => ({ results: [] })),
    db.prepare('SELECT month FROM month_lock').all().catch(() => ({ results: [] }))
  ])
  const lockSet = new Set((locks.results || []).map((x) => x.month))
  const idx = (arr) => {
    const m = {}
    for (const x of (arr.results || [])) { const k = norm(x.p) + '|' + round2(num(x.a)); (m[k] = m[k] || []).push(x.d) }
    return m
  }
  const iAr = idx(arOld), iAp = idx(apOld), iEx = idx(exOld)
  const seen = new Map()
  const out = parsed.map((x, i) => {
    const r = { i: i + 1, ...x, ok: true, error: '', dup: false, dup_text: '', locked: false }
    if (type === 'expense') { if (!(x.amount > 0)) { r.ok = false; r.error = '金额不是数字' } }
    else if (!x.party) { r.ok = false; r.error = '没写单位名' }
    else if (!(x.amount > 0)) { r.ok = false; r.error = '金额不是数字' }
    const m = x.date.slice(0, 7)
    if (lockSet.has(m)) { r.locked = true; r.error = m + ' 已结账锁定，这一行导不进去' }
    if (r.ok && !r.locked) {
      const k = norm(x.party) + '|' + x.amount
      const src = type === 'ar' ? iAr : type === 'ap' ? iAp : type === 'expense' ? iEx : null
      if (src) {
        const hit = (src[type === 'expense' ? norm(x.category) + '|' + x.amount : k] || []).find((d) => d >= addDaysIso(x.date, -7) && d <= x.date)
        if (hit) { r.dup = true; r.dup_text = `系统里 ${hit} 已经有一笔一样的（¥${x.amount}）` }
      }
      // 这一批自己里面重了（同一个表里抄了两遍）
      const bk = (type === 'expense' ? norm(x.category) : norm(x.party)) + '|' + x.amount + '|' + x.date
      if (!r.dup) {
        if (seen.has(bk)) { r.dup = true; r.dup_text = `这一批里第 ${seen.get(bk)} 行跟它一模一样` }
        else seen.set(bk, i + 1)
      }
    }
    return r
  })
  const okCnt = out.filter((x) => x.ok && !x.locked).length
  const dupCnt = out.filter((x) => x.ok && !x.locked && x.dup).length
  const badCnt = out.filter((x) => !x.ok).length
  const lockCnt = out.filter((x) => x.locked).length
  const total = round2(out.filter((x) => x.ok && !x.locked).reduce((a, x) => a + x.amount, 0))
  const parts = [`认出 ${out.length} 行`]
  if (okCnt) parts.push(`能导 ${okCnt} 行（合计 ¥${total}）`)
  if (dupCnt) parts.push(`${dupCnt} 行像重复`)
  if (badCnt) parts.push(`${badCnt} 行有问题`)
  if (lockCnt) parts.push(`${lockCnt} 行在已结账月份`)
  return { header_skipped: st.skipped, rows: out, count: out.length, ok_count: okCnt, dup_count: dupCnt, bad_count: badCnt, locked_count: lockCnt, total,
    text: parts.join('，') + '。确认没问题再点「确认导入」。' }
}

// ===== Excel 改完再导回来：先逐行对比，你勾选要改的，才写库 =====
const RI_FIELDS = {
  ar: { table: 'orders', party: 'customer', label: { customer: '客户', item_name: '产品/项目', price: '金额', cost: '成本', due_date: '约定收款日', operator: '经手人' } },
  ap: { table: 'payables', party: 'supplier', label: { supplier: '供应商', amount: '金额', remark: '备注', due_date: '约定付款日', operator: '经手人', category: '分类' } }
}
const RI_HEAD = {
  id: /^(单号|编号|id|单据号)$/i,
  customer: /^(客户|客户名)$/, supplier: /^(供应商|单位)$/, item_name: /^(产品|产品\/项目|项目|品名)$/,
  price: /^(金额|应收金额)$/, amount: /^(金额|应付金额)$/, cost: /^(成本|材料·外协|材料外协成本)$/,
  due_date: /^(到期日|约定收款日|约定付款日|收付款日)$/, operator: /^(经手人|业务员)$/,
  remark: /^(备注|说明)$/, category: /^(分类|类别)$/
}
function riNormDay(v) {
  const s = String(v == null ? '' : v).trim()
  if (!s) return ''
  const m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/) || s.match(/^(\d{1,2})[-/.](\d{1,2})$/)
  if (m && m[3]) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`
  return s.slice(0, 10)
}
// 把导回来的表解析成 {changes, head_map, skipped}
async function reimportPlan(db, type, rows) {
  const conf = RI_FIELDS[type]
  if (!conf) return { error: '只支持 ar / ap' }
  const all = (rows || []).map((r) => (r || []).map((c) => String(c == null ? '' : c).trim()))
  // 找表头：前 3 行里出现「单号/客户/供应商/金额」这类列名
  let hIdx = -1
  for (let i = 0; i < Math.min(3, all.length); i++) {
    const cells = all[i]
    const hits = cells.filter((x) => Object.values(RI_HEAD).some((re) => re.test(x))).length
    if (hits >= 2) { hIdx = i; break }
  }
  let map = null
  let data = all
  if (hIdx >= 0) {
    map = {}
    all[hIdx].forEach((h, i) => {
      for (const [k, re] of Object.entries(RI_HEAD)) if (map[k] == null && re.test(h)) map[k] = i
    })
    data = all.slice(hIdx + 1)
  } else {
    // 没表头就按导出顺序：单号, 日期, 客户/供应商, 产品, 金额, 已收/已付, 未收/未付, 状态, 进度, 到期日, 经手人
    map = { id: 0, customer: 2, supplier: 2, item_name: 3, price: 4, amount: 4, due_date: 8, operator: 9 }
  }
  if (map.id == null) return { error: '这个表里没有「单号」列。请先在「导出」里导出带单号的表，改完再导回来（不要另建新表）' }
  const changes = []
  const skipped = []
  const ids = []
  for (const r of data) {
    const id = num(r[map.id])
    if (!id) { if (r.join('').trim()) skipped.push({ reason: '没有单号', row: r.slice(0, 4).join(' / ') }); continue }
    ids.push(id)
  }
  if (!ids.length) return { error: '这个表里没认出任何单据号。请用「导出」下载的表改，第一列是单号' }
  const uniq = [...new Set(ids)]
  const ph = uniq.map(() => '?').join(',')
  const q = await db.prepare(`SELECT * FROM ${conf.table} WHERE id IN (${ph})`).bind(...uniq).all()
  const byId = {}
  for (const row of (q.results || [])) byId[num(row.id)] = row
  const today = todayIso()
  for (const r of data) {
    const id = num(r[map.id])
    if (!id) continue
    const row = byId[id]
    if (!row) { changes.push({ id, party: '', state: 'err', err: `单号 ${id} 在账上找不到`, diffs: [] }); continue }
    const set = {}
    const diffs = []
    const pushIf = (f, raw, cast) => {
      if (map[f] == null) return
      const to = cast(String(r[map[f]] == null ? '' : r[map[f]]))
      const from = cast(row[f] == null ? '' : row[f])
      if (String(to) !== String(from)) { set[f] = to; diffs.push({ f, label: conf.label[f] || f, from, to }) }
    }
    const asNum = (v) => round2(num(v))
    const asText = (v) => String(v == null ? '' : v).trim()
    const asDay = (v) => riNormDay(v)
    if (type === 'ar') {
      pushIf('customer', r[map.customer], asText)
      pushIf('item_name', r[map.item_name], asText)
      pushIf('price', r[map.price], asNum)
      if (map.cost != null) pushIf('cost', r[map.cost], asNum)
      pushIf('due_date', r[map.due_date], asDay)
      pushIf('operator', r[map.operator], asText)
    } else {
      pushIf('supplier', r[map.supplier], asText)
      pushIf('amount', r[map.amount], asNum)
      pushIf('remark', r[map.remark], asText)
      pushIf('due_date', r[map.due_date], asDay)
      pushIf('operator', r[map.operator], asText)
      if (map.category != null) pushIf('category', r[map.category], asText)
    }
    const mon = String((row.created_at || '').slice(0, 7))
    const locked = await isMonthLocked(db, mon)
    const paid = round2(num(row.paid) + num(row.written_off))
    let state = 'ok'
    let err = ''
    if (!diffs.length) state = 'same'
    else if (locked) { state = 'locked'; err = `${mon} 已结账锁定，先解锁再改` }
    else {
      const newAmt = set.price != null ? num(set.price) : set.amount != null ? num(set.amount) : num(type === 'ar' ? row.price : row.amount)
      if (newAmt < paid - 0.005) { state = 'err'; err = `金额不能低于已收(付) ${round2(paid)}` }
      else if (newAmt < 0) { state = 'err'; err = '金额不能是负数' }
      else if (Object.keys(set).some((k) => (k === 'customer' || k === 'supplier') && !set[k])) { state = 'err'; err = '客户/供应商不能改成空' }
    }
    changes.push({ id, party: type === 'ar' ? row.customer : row.supplier, item: type === 'ar' ? row.item_name : (row.remark || ''), day: today, state, err, diffs, set })
  }
  const cnt = (s) => changes.filter((x) => x.state === s).length
  const out = {
    ok: true, type, rows: changes.length, change_cnt: cnt('ok'), same_cnt: cnt('same'),
    locked_cnt: cnt('locked'), err_cnt: cnt('err'), skipped,
    changes: changes.filter((x) => x.state !== 'same').slice(0, 300),
    head_map: map
  }
  out.text = changes.length === 0 ? '这个表里没有可对比的行'
    : out.change_cnt === 0 && out.locked_cnt === 0 && out.err_cnt === 0 ? `共 ${out.rows} 行，都和账上一样，没有要改的。`
      : `共 ${out.rows} 行：${out.change_cnt} 行有变化、${out.same_cnt} 行没变${out.locked_cnt ? `、${out.locked_cnt} 行被结账锁住` : ''}${out.err_cnt ? `、${out.err_cnt} 行有问题` : ''}。`
  return out
}
async function reimportApply(db, type, changes, by) {
  const conf = RI_FIELDS[type]
  let done = 0
  const fails = []
  for (const ch of changes || []) {
    if (!ch || !num(ch.id)) continue
    const set = ch.set || {}
    const keys = Object.keys(set).filter((k) => conf.label[k])
    if (!keys.length) continue
    const row = await db.prepare(`SELECT * FROM ${conf.table} WHERE id=?`).bind(ch.id).first()
    if (!row) { fails.push({ id: ch.id, err: '单号不存在' }); continue }
    const mon = String((row.created_at || '').slice(0, 7))
    if (await isMonthLocked(db, mon)) { fails.push({ id: ch.id, err: `${mon} 已结账锁定` }); continue }
    const paid = round2(num(row.paid) + num(row.written_off))
    const newAmt = set.price != null ? num(set.price) : set.amount != null ? num(set.amount) : num(type === 'ar' ? row.price : row.amount)
    if (newAmt < paid - 0.005) { fails.push({ id: ch.id, err: `金额不能低于已收(付) ${paid}` }); continue }
    const sets = []
    const binds = []
    const diffTxt = []
    for (const k of keys) {
      sets.push(`${k}=?`); binds.push(set[k])
      diffTxt.push(`${conf.label[k]} ${row[k] == null ? '' : row[k]} → ${set[k]}`)
    }
    sets.push('rev=COALESCE(rev,0)+1')
    binds.push(ch.id)
    await db.prepare(`UPDATE ${conf.table} SET ${sets.join(', ')} WHERE id=?`).bind(...binds).run()
    await logAudit(db, 'Excel 回改' + (type === 'ar' ? '应收' : '应付'), String(ch.id), diffTxt.join('；'), { ref_type: conf.table === 'orders' ? 'order' : 'payable', ref_id: num(ch.id) }, by)
    done++
  }
  return { done, fails }
}

app.post('/import-xlsx', async (c) => {
  const body = await c.req.json()
  const type = String(body.type || 'ar')
  const b64 = body.b64 || body.file || ''
  if (!b64) return c.json({ error: '没有收到文件内容' }, 400)
  let rows
  try {
    rows = await xlsxToRows(fromB64(b64).buffer)
  } catch (e) {
    return c.json({ error: '读不了这个 Excel：' + String(e.message || e) }, 400)
  }
  if (!rows.length) return c.json({ error: 'Excel 里没有数据行' }, 400)
  // 导出表改完再导回来：先对比，用户勾选后才写库
  if (type === 'ar_update' || type === 'ap_update') {
    const t = type === 'ar_update' ? 'ar' : 'ap'
    const plan = await reimportPlan(c.env.DB, t, rows)
    if (plan.error) return c.json({ error: plan.error }, 400)
    if (body.apply !== true) return c.json(plan)
    const useList = Array.isArray(body.changes) && body.changes.length ? body.changes : plan.changes.filter((x) => x.state === 'ok')
    const r = await reimportApply(c.env.DB, t, useList, act(c))
    return c.json({ ok: true, type: t, rows: plan.rows, same_cnt: plan.same_cnt, locked_cnt: plan.locked_cnt, err_cnt: plan.err_cnt, applied: r.done, fails: r.fails, changes: plan.changes, skipped: plan.skipped, text: `改好了 ${r.done} 行${r.fails.length ? `，${r.fails.length} 行没改成` : ''}。` })
  }
  // 对账：只核对不入账
  if (type === 'recon' || type === 'recon_ap') {
    let body2 = rows.slice()
    if (body2.length && /单位|客户|供应|金额/.test(String((body2[0] || []).join('')))) body2 = body2.slice(1)
    const list = body2.map((r2) => ({ party: String((r2 || [])[0] || '').trim(), amount: num((r2 || [])[1]), ok: !!(String((r2 || [])[0] || '').trim() && num((r2 || [])[1]) > 0) })).filter((x) => x.ok)
    if (!list.length) return c.json({ error: '这个表格里没认出「单位 + 金额」两列' }, 400)
    return c.json({ ok: true, recon: await reconcileCore(c.env.DB, type === 'recon_ap' ? 'ap' : 'ar', list) })
  }
  // 银行/微信/支付宝导出的 xlsx：还原成「一行一笔」的表格文本，和粘贴走同一个解析器
  if (type === 'bank') {
    const lines = rows.map((r) => (r || []).map((c) => {
      const v = String(c == null ? '' : c).replace(/[\t\r\n]/g, ' ').trim()
      // 纯数字单元格（1,200.00）把逗号直接去掉；文字里的逗号换成空格，免得被当列分隔
      return /^[\d\s,.¥￥+-]+$/.test(v) ? v.replace(/,/g, '') : v.replace(/[,，]/g, ' ')
    }).join('\t'))
    const parsed = parseBankSmart(lines.join('\n'))
    const LAYOUT_CN = { wallet: '微信/支付宝账单', bank: '银行流水（借方/贷方）', simple: '通用表格（日期/收付/金额）', plain: '简单格式（日期,收付,金额,摘要）' }
    if (!parsed.rows.length) return c.json({ error: '这个 Excel 里没认出流水。微信/支付宝导出的账单、银行导出的明细表都可以，表头要有「交易时间 / 金额 / 收/支」这类列' }, 400)
    if (body.preview === true) {
      const inSum = round2(parsed.rows.filter((x) => x.direction === 'in').reduce((a, x) => a + x.amount, 0))
      const outSum = round2(parsed.rows.filter((x) => x.direction === 'out').reduce((a, x) => a + x.amount, 0))
      return c.json({ ok: true, preview: true, type: 'bank', layout: parsed.layout, layout_text: LAYOUT_CN[parsed.layout] || parsed.layout, skipped: parsed.skipped, rows: parsed.rows.slice(0, 200), count: parsed.rows.length, in_sum: inSum, out_sum: outSum, text: '认出 ' + parsed.rows.length + ' 笔（收 ¥' + inSum + ' / 付 ¥' + outSum + '）' + (parsed.skipped ? '，跳过 ' + parsed.skipped + ' 笔不计收支/退款的' : '') })
    }
    const db = c.env.DB
    for (const r of parsed.rows) {
      await db.prepare('INSERT INTO bank_flows (date, direction, amount, memo, matched_type, matched_id, created_at) VALUES (?,?,?,?,?,0,?)')
        .bind(r.date, r.direction, r.amount, r.memo, null, now()).run()
    }
    await logAudit(db, '导入银行流水', 'Excel 账单', `导入 ${parsed.rows.length} 笔（${LAYOUT_CN[parsed.layout] || parsed.layout}）`, '', act(c))
    return c.json({ ok: true, imported: parsed.rows.length, layout: parsed.layout, layout_text: LAYOUT_CN[parsed.layout] || parsed.layout, skipped: parsed.skipped })
  }
  if (body.preview === true) {
    return c.json({ ok: true, preview: true, type, ...(await previewImport(c.env.DB, type, rows)) })
  }
  // 预览里删掉的行：按「表头之后的第几行」传 skip
  const skipSet = new Set((Array.isArray(body.skip) ? body.skip : []).map((x) => Math.round(Number(x)) || 0))
  let dataRows = stripHeader(rows).rows
  if (skipSet.size) dataRows = dataRows.filter((_, i) => !skipSet.has(i + 1))
  if (!dataRows.length) return c.json({ error: '这一批的行都被你删掉了，没东西可导' }, 400)
  const r = await importRows(c.env.DB, type, dataRows, { confirmDup: !!body.confirm_dup, by: act(c) })
  const dup = (r && Array.isArray(r.dup)) ? r.dup : []
  await logImport(c.env.DB, type, r, 'excel')
  return c.json({ ok: true, imported: num(r && r.imported), skipped_locked: num(r && r.skipped_locked), dup, dup_count: dup.length, total: num(r && r.total) })
})


// 导出整月全部数据成一个 Excel（多个工作表），直接发给会计或存档
app.get('/export-xlsx', async (c) => {
  const db = c.env.DB
  let month = String(c.req.query('month') || '').slice(0, 7) || now().slice(0, 7)
  let from = String(c.req.query('from') || '').slice(0, 10)
  let to = String(c.req.query('to') || '').slice(0, 10)
  const useRange = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)
  if (useRange && from > to) { const t = from; from = to; to = t }
  if (useRange) month = from.slice(0, 7)
  const where = useRange ? 'substr(created_at,1,10)>=? AND substr(created_at,1,10)<=?' : 'substr(created_at,1,7)=?'
  const arg = useRange ? [from, to] : [month]
  const M = (sql) => db.prepare(sql).bind(...arg).all()
  const orders = (await M('SELECT * FROM orders WHERE ' + where + ' ORDER BY id')).results
  const payables = (await M('SELECT * FROM payables WHERE ' + where + ' ORDER BY id')).results
  const ledger = (await M('SELECT * FROM ledger WHERE ' + where + ' ORDER BY id')).results
  const writeoffs = (await M('SELECT * FROM writeoffs WHERE ' + where + ' ORDER BY id')).results
  const loans = (await db.prepare('SELECT * FROM loans ORDER BY id').all()).results
  const accs = await accountBalances(db)

  let inSum = 0
  let outSum = 0
  for (const r of ledger) {
    if (!num(r.cash)) continue
    if (r.direction === 'in') inSum += num(r.amount)
    else outSum += num(r.amount)
  }
  const arOpen = orders.reduce((a, r) => a + Math.max(0, num(r.price) - num(r.paid) - num(r.written_off)), 0)
  const apOpen = payables.reduce((a, r) => a + Math.max(0, num(r.amount) - num(r.paid) - num(r.written_off)), 0)

  const accName = {}
  for (const a of accs || []) accName[a.id] = a.name
  const S = [
    { name: '总览', rows: [
      ['项目', '金额/数量'],
      ['账期', useRange ? (from + ' ~ ' + to) : month],
      ['本月收（现金）', round2(inSum)],
      ['本月付（现金）', round2(outSum)],
      ['本月结余', round2(inSum - outSum)],
      ['本月新接单', round2(orders.reduce((a, r) => a + num(r.price), 0))],
      ['本月新赊购', round2(payables.reduce((a, r) => a + num(r.amount), 0))],
      ['这些单还没收', round2(arOpen)],
      ['这些单还没付', round2(apOpen)],
      ['手头现金合计', round2((accs || []).reduce((a, x) => a + num(x.balance), 0))],
      ['导出时间', now()]
    ] },
    { name: '应收', rows: [['单号', '客户', '产品', '金额', '已收', '已核销', '未收', '状态', '约定收款日', '经手人', '开单日']].concat(
      orders.map((r) => [r.id, r.customer, r.item_name, round2(num(r.price)), round2(num(r.paid)), round2(num(r.written_off)), round2(num(r.price) - num(r.paid) - num(r.written_off)), num(r.price) - num(r.paid) - num(r.written_off) <= 0 ? '已结清' : '未结清', (r.due_date || '').slice(0, 10), r.operator || '', (r.created_at || '').slice(0, 10)])
    ) },
    { name: '应付', rows: [['单号', '供应商', '金额', '已付', '已核销', '未付', '状态', '约定付款日', '备注', '经手人', '开单日']].concat(
      payables.map((r) => [r.id, r.supplier, round2(num(r.amount)), round2(num(r.paid)), round2(num(r.written_off)), round2(num(r.amount) - num(r.paid) - num(r.written_off)), num(r.amount) - num(r.paid) - num(r.written_off) <= 0 ? '已结清' : '未结清', (r.due_date || '').slice(0, 10), r.remark || '', r.operator || '', (r.created_at || '').slice(0, 10)])
    ) },
    { name: '收付流水', rows: [['日期', '收/付', '金额', '分类', '备注', '账户', '是否动现金', '单据类型']].concat(
      ledger.map((r) => [(r.created_at || '').slice(0, 10), r.direction === 'in' ? '收' : '付', round2(num(r.amount)), r.category || '', r.remark || '', accName[r.account_id] || '', num(r.cash) ? '是' : '否（抵扣/转账）', r.ref_type || ''])
    ) },
    { name: '借支', rows: [['员工', '借出', '已报销', '已退回', '还欠着', '备注', '日期']].concat(
      loans.map((r) => [r.staff, round2(num(r.amount)), round2(num(r.used)), round2(num(r.returned)), round2(num(r.amount) - num(r.used) - num(r.returned)), r.remark || '', (r.created_at || '').slice(0, 10)])
    ) },
    { name: '核销记录', rows: [['日期', '类型', '单号', '金额', '原因']].concat(
      writeoffs.map((r) => [(r.created_at || '').slice(0, 10), r.type === 'ar' ? '应收核销' : '应付豁免', r.ref_id, round2(num(r.amount)), r.reason || ''])
    ) }
  ]
  const xlsx = await makeXlsxSheets(S)
  const nm = '记账导出_' + (useRange ? (from + '_' + to) : month) + '.xlsx'
  return c.json({ ok: true, name: nm, b64: toB64(xlsx), month, from, to, range: useRange ? (from + ' ~ ' + to) : month })
})

app.get('/import-template', async (c) => {
  const t = String(c.req.query('type') || 'ar')
  const T = {
    ar: ['客户,产品,金额,日期', '张老板,外壳加工,5000,11-05', '李老板,法兰件,3200,'],
    ar_init: ['客户,金额,日期', '张老板,5000,', '李老板,3000,07-01'],
    ap: ['供应商,金额,备注,日期', '王五金,2000,螺丝款,11-05', '李钢材,5000,钢板,'],
    ap_init: ['供应商,金额,日期', '王五金,2000,', '李钢材,5000,'],
    expense: ['金额,分类,备注,日期', '1200,房租,8月房租,11-01', '300,水电,电费,'],
    loan: ['员工,金额,备注,日期', '张三,1000,买辅料,11-05', '李四,500,加油,'],
    reimb: ['员工,金额,分类,备注,日期', '张三,800,采购,买螺丝,11-06', '张三,200,运费,送货油费,']
  }[t] || ['客户,产品,金额,日期']
  return c.text('\ufeff' + T.join('\r\n') + '\r\n', 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="import-template.csv"'
  })
})

// ── 多账套 ──
// 结构自检：三个账本的表/列是否齐全（改过数据库后最容易漏改第二、第三本）
const REQ_SCHEMA = {
  ledger: ['account_id', 'cash', 'ref_type', 'direction'],
  orders: ['cost', 'written_off', 'rev', 'due_date', 'operator', 'progress'],
  payables: ['written_off', 'rev', 'due_date', 'operator'],
  advances: ['used', 'account_id'],
  accounts: ['opening', 'kind'],
  statement_log: ['ack', 'ack_at', 'resolved_at'],
  party_terms: ['recon_day', 'term_days'],
  audit_log: ['by'],
  dunning_log: ['promise_date'],
  month_archive: ['data', 'month'],
  net_snapshots: ['net'],
  op_dedupe: ['client_id']
}
app.get('/schema-check', async (c) => {
  const all = c.env.ENV_ALL || c.env
  const defs = [['1', all.DB, '主账本'], ['2', all.DB2, '第二本'], ['3', all.DB3, '第三本']]
  const books = []
  for (const [id, db, def] of defs) {
    if (!db) continue
    const names = Object.keys(REQ_SCHEMA)
    const info = await Promise.all(names.map((t) =>
      db.prepare('PRAGMA table_info(' + t + ')').all().catch(() => null)))
    const miss = []
    names.forEach((t, i) => {
      const cols = info[i] && info[i].results ? info[i].results.map((x) => x.name) : null
      if (!cols || !cols.length) return miss.push({ table: t, missing: ['整张表'] })
      const lack = REQ_SCHEMA[t].filter((cl) => cols.indexOf(cl) < 0)
      if (lack.length) miss.push({ table: t, missing: lack })
    })
    books.push({ id, name: def, ok: miss.length === 0, issues: miss })
  }
  const bad = books.filter((b) => !b.ok)
  return c.json({ ok: true, clean: bad.length === 0, books, bad_count: bad.length,
    text: bad.length === 0
      ? '三个账本的结构都是齐的。'
      : books.filter((b) => !b.ok).map((b) => b.name + '：' + b.issues.map((x) => x.table + ' 少 ' + x.missing.join('/')).join('，')).join('；') })
})

// 三个账本都在干嘛：谁在用、谁是空的、谁的账户/分类还没配

// ===== 名词小词典（设置页「不懂就问」用；只解释、不改数）=====
const GLOSSARY = [
  { k: 'profit', t: '净利（权责口径）', s: '这个月真正赚的钱', d: '算法：本月接单额 − 单子上填的材料·外协成本 − 现金支出（工资、水电、房租等）− 摊销 − 折旧 − 预提利息。毛利率 = 净利 ÷ 接单额。', tip: '赊购（先欠着供应商）不算成本，那时你还没掏现金；等你付款那天才进现金流。所以「净利」和「手头多了多少钱」经常不一样，两者都对。', go: 'home' },
  { k: 'accrual', t: '权责发生制 / 收付实现制', s: '两种记账口径', d: '权责制：活干完、单开出来就记收入（不管钱收到没有）。收付制：只认现金进出。', tip: '本小程序利润按权责制算，现金流按收付制算，两套数不矛盾。', go: 'stat:report' },
  { k: 'ar', t: '应收（别人欠我）', s: '加工费该收还没收的钱', d: '每开一张单就产生应收，收一笔减一笔。列表里「未收」= 金额 − 已收 − 已核销。', tip: '顶部「客户欠我」四宫格就是这个总数。', go: 'bill:ar' },
  { k: 'ap', t: '应付（我欠别人）', s: '该付给供应商还没付的钱', d: '赊购材料、外协加工记应付，付一笔减一笔。', tip: '应付不影响净利，只影响「我欠别人」和现金流。', go: 'bill:ap' },
  { k: 'due', t: '到期日 / 约定收款日', s: '说好哪天给钱', d: '开单时可以填，也可以留空——留空就按这家单位设的「账期」自动算（做单后 N 天）。', tip: '有到期日才会在 7 天内提醒你、进「今天的活」。', go: 'bill:ar' },
  { k: 'term', t: '账期', s: '这家单位习惯多久结一次', d: '在单位页给每家设「做单后 N 天到期」和「每月几号发对账单」，之后开单自动算到期日、到点自动提醒。', tip: '设一次，后面所有单都省事。', go: 'stat:contact' },
  { k: 'recon', t: '对账 / 对账单', s: '和客户把两边的数对一遍', d: '把对方的金额和你记的比一比，一样就打勾，不一样就补记或标「不用补」。对账单可以存图片、发微信、生成打印链接。', tip: '月底前一定要对一次，不然差异越积越多。', go: 'bill:import' },
  { k: 'writeoff', t: '核销 / 坏账核销', s: '这笔钱不要了', d: '把收不回来的应收（或不用付的应付）抹掉，只动往来、不动现金，会记进「损失台账」。', tip: '抹掉前先确认真的收不回来，核销能撤销。', go: 'stat:asset' },
  { k: 'advance', t: '预收款 / 预付款', s: '还没干活就先收（付）的钱', d: '预收：客户先给钱；预付：你先给供应商钱。都不算赚到/花掉，等抵到具体单子上才算。', tip: '挂太久会提醒你——预收超 30 天、预付超 15 天。', go: 'home' },
  { k: 'loan', t: '员工借支', s: '员工先借走、回头报销或退回', d: '借出时记一笔现金支出（钱确实出去了），报销时冲借支，退回余款再记回来。', tip: '「钱的三条线」里能看到还没清多少。', go: 'stat:asset' },
  { k: 'debt', t: '借款（银行贷款 / 个人）', s: '你借进来的钱', d: '记本金、年利率、期限、还款方式，系统算每月利息、下次该还多少、有没有逾期。', tip: '利息按月预提进成本，还本只是现金变动。', go: 'stat:asset' },
  { k: 'amort', t: '摊销（待摊费用）', s: '一笔钱先花了，摊到几个月里', d: '比如一次交半年房租 3 万，不是当月全算成本，而是每月摊 5000。', tip: '摊销不动现金，只影响利润。', go: 'stat:report' },
  { k: 'dep', t: '折旧', s: '机器设备慢慢用旧的那部分成本', d: '按「原值 − 残值」除以年限，每月提一点进成本。设备卖掉/报废那天会先把当月折旧提足。', tip: '折旧不动现金。', go: 'stat:asset' },
  { k: 'accrue', t: '预提利息', s: '利息还没付，但已经欠着了', d: '借款每月产生利息，即使你还没付款，也先算进当月成本，付款时才动现金。', tip: '不预提的话，利润会虚高。', go: 'stat:asset' },
  { k: 'cash', t: '现金 / 手头现金', s: '账户里现在真有的钱', d: '现金、银行卡、微信、支付宝几个账户加起来。每笔收付款都挂到某个账户，账户余额才准。', tip: '老流水没挂账户的，系统归到第一个账户。', go: 'stat:flows' },
  { k: 'flow', t: '流水', s: '每一笔钱的进出', d: '流水页能看到日期、方向、金额、分类、账户和对应单据；删流水会把单据的已收已付调回去。', tip: '内部转账（银行卡转微信）也记流水，但不算收支。', go: 'stat:flows' },
  { k: 'networth', t: '净资产 / 家底', s: '把欠的扣掉，你到底有多少', d: '算法：现金 + 应收 − 应付 − 借款。资产 = 负债 + 所有者权益，报表里会对平。', tip: '每月底自动存一份存档，改老单据也不会带偏历史曲线。', go: 'stat:asset' },
  { k: 'aging', t: '账龄', s: '这笔欠款欠了多久', d: '按 0–30 / 31–60 / 61–90 / 90 天以上分档，还会估一个「可能收不回来的比例」。', tip: '90 天以上的，建议先要一部分。', go: 'stat:asset' },
  { k: 'credit', t: '信用额度', s: '这家客户最多能欠多少', d: '在单位页设一个上限，开单超过时只提醒不拦（提示他超了多少）。', tip: '对老拖款的客户很有用。', go: 'stat:contact' },
  { k: 'lock', t: '月结锁定 / 结账', s: '这个月定了，别再改', d: '结账后这个月的单据不能新增、修改、删除，避免对完账又被改乱。', tip: '结错了可以「解锁（删归档）」，但归档快照会一起没了。', go: 'stat:report' },
  { k: 'snapshot', t: '快照 / 归档', s: '把当时的样子存下来', d: '月结会把那个月的利润表、资产负债表、明细整份存好，之后报表和打印优先用快照。', tip: '所以改老单据也不会影响已归档的报表。', go: 'stat:report' },
  { k: 'trash', t: '回收站', s: '删掉的东西还能找回', d: '删单、删流水先进回收站，30 天内能还原，之后自动清掉。', tip: '整批导入错了，删的时候也是一整批进出。', go: 'stat:report' },
  { k: 'seal', t: '账本封存', s: '这本账只读了', d: '老账本对完账后封存，整本不能增删改，页面顶部会有灰条提示。', tip: '封存后每日自动记账也不再往里写；解封要确认一次。', go: 'stat:me' },
  { k: 'dedupe', t: '重复记账 / 去重', s: '同一笔别记两遍', d: '同客户同金额 2 分钟内再记会拦一下；导入时同一家同金额 7 天内会提示先确认。', tip: '真的记了两笔，选「继续记」就行。', go: 'bill:import' },
  { k: 'merge', t: '合并重名', s: '同一家单位写成了两个名字', d: '「兴旺五金」和「兴旺五金厂」会被认成两家，合并后欠款和账期归到一个名字上。', tip: '合并前建议先看一眼两边的单。', go: 'stat:contact' },
  { k: 'loss', t: '损失台账', s: '这一年亏在哪了', d: '三类：坏账核销的实亏、毛利太低白干的、比历史均价被压价的。', tip: '看完记得给低价客户涨个价。', go: 'stat:report' },
  { k: 'breakeven', t: '保本线', s: '一个月至少要做多少才不亏', d: '按近 3 个月固定开销算：保本接单额 = 固定开销 ÷（1 − 变动成本占比）。', tip: '这个月接单低于保本线，就得看看哪块能省。', go: 'stat:report' },
  { k: 'dunning', t: '催款', s: '提醒对方该付钱了', d: '催款清单按「欠得久 × 金额 × 这家平时多久付」排序，能复制话术、记承诺付款日、看催了有没有用。', tip: '答应付的日子过了还没付，首页会红字提醒。', go: 'bill:ar' },
  { k: 'promise', t: '承诺付款日', s: '对方答应哪天付', d: '记催款时顺手记下，到那天没付会提醒你，失约次数也能统计。', tip: '失约两次以上，下次开单先要预付款。', go: 'stat:report' },
  { k: 'dispute', t: '争议 / 对账单对方说对不上', s: '对方不认这个数', d: '标「有异议」后进争议清单，能看到处理过程、补记了多少、该怎么说。', tip: '处理完点「已核实」就了结。', go: 'stat:report' },
  { k: 'staff', t: '员工口令', s: '让员工只能记账、不能删改', d: '老板在设置里设一个员工口令，员工用它登录：能记账、收款、查欠款；看毛利、删单、改设置都拦下来。', tip: '员工记的每一笔都会留痕，老板能查「员工最近记了什么」。', go: 'stat:me' },
  { k: 'import', t: '批量导入 / 模板', s: '把 Excel 里的数一次录进来', d: '先下载模板（Excel），按列填好再选文件导入；也可以把对账单粘进「对账核对」里比数。', tip: '导入前会先给预览，确认了才入账，导错了能整批撤回。', go: 'bill:import' },
  { k: 'health', t: '账本健康分', s: '这本账记得规不规范', d: '十项检查：没填成本、没设到期日、没电话、流水没挂账户、疑似重复、上月没结账……', tip: '点开能看到每一项怎么改。', go: 'home' },
  { k: 'cost', t: '材料·外协成本', s: '这一单你自己的料钱和外协费', d: '开单时填「成本」，系统就能算毛利、比较不同客户赚不赚。', tip: '不填成本，毛利率会虚高，报表里会提醒你。', go: 'bill:ar' },
  // ── 出错了怎么办（把界面上会跳出来的报错都能搜到）──
  { cat: 'err', k: 'e_bad_key', t: '「口令不对」', s: '进不去', d: '每台手机第一次用要先设一个访问口令，之后每次打开都用这个口令。口令对不上就会提示这句。', tip: '忘了口令：在旧手机上「设置 → 改口令」会告诉你怎么重置，或者直接在服务器数据库里清掉口令重新设。换手机不用备份，只要填同一个口令就能看到原来的账。', go: 'stat:me' },
  { cat: 'err', k: 'e_conflict', t: '「这张单刚被别人改过」', s: '同事也在改同一张单', d: '为了避免两个人同时改把数字弄乱，系统会拦住第二次修改。', tip: '下拉刷新一下，看到最新的数再改一次就行，不用重新录单。', go: '' },
  { cat: 'err', k: 'e_sealed', t: '「这本账已经封存（只读）」', s: '老账本被锁成只读了', d: '封存是为了防止误改对完的旧账，封存后整本不能增删改。', tip: '要改就去「设置 → 🔒 账本封存 → 解封」，解封要点一次确认。', go: 'stat:me' },
  { cat: 'err', k: 'e_locked', t: '「这个月已经结账锁定」', s: '结过账的月份不让改', d: '结账会把当月的单据锁住，报表也按那时的快照出。', tip: '确实要改：先「报表 → 解锁（删归档）」，改完记得重新结一次账。', go: 'stat:report' },
  { cat: 'err', k: 'e_dup', t: '「刚记过一张一样的」', s: '可能是手滑点了两次', d: '同一家、同一金额、两分钟内又记一笔，系统会先拦一下问你。', tip: '如果确实是又一次活，点「确实要再记一笔」就记上；如果点错了，直接关掉。', go: '' },
  { cat: 'err', k: 'e_offline', t: '「现在没网，看到的是之前的数据」', s: '手机信号不好', d: '没网时还能翻之前的账（带黄条提示这是几小时前的），但不能存新数据。', tip: '记的单会在手机上排队，联网后自动补发；顶部「📤 有 N 笔没发出去」点一下可以手动重发。', go: 'home' },
  { cat: 'err', k: 'e_server', t: '「服务器出了点问题」', s: '后台出错了', d: '错误已经自动记到「设置 → 🐞 运行日志」里，不用你抄下来。', tip: '先等 30 秒再点一次，多半就好了；连续出现就把运行日志最后几条发给我。', go: 'stat:report' },
  { cat: 'err', k: 'e_staff', t: '「这是老板才能用的功能」', s: '员工口令被拦了', d: '员工能记单、收款、看自己的活，但不能删改单据、看毛利、结账、封存。', tip: '确实要这些就换老板口令，或者让老板来做。', go: 'stat:me' },
]
app.get('/help', (c) => {
  const kw = String(c.req.query('kw') || '').trim()
  const cat = String(c.req.query('cat') || '')
  const low = kw.toLowerCase()
  const all = GLOSSARY.map((g) => ({
    k: g.k, t: g.t, s: g.s, d: g.d, tip: g.tip || '', go: g.go || '',
    cat: g.cat || 'word', cat_text: g.cat === 'err' ? '出错了怎么办' : '财务名词',
  }))
  const pool = cat ? all.filter((g) => g.cat === cat) : all
  const hit = low ? pool.filter((g) => (g.t + g.s + g.d + g.tip + g.k).toLowerCase().includes(low)) : pool
  const items = hit.slice(0, 40)
  const cats = [
    { k: 'word', label: '财务名词', n: all.filter((g) => g.cat === 'word').length },
    { k: 'err', label: '出错了怎么办', n: all.filter((g) => g.cat === 'err').length },
  ]
  const text = low
    ? (items.length ? `「${kw}」找到 ${items.length} 条解释` : `没有「${kw}」这个词。换个说法（比如「核销」「账期」「口令不对」），或者直接问我`)
    : (cat ? `这一类一共 ${items.length} 条` : `一共收录 ${all.length} 条，点任意一条看解释`)
  return c.json({ ok: true, kw, cat, count: items.length, total: all.length, cats, items, text })
})

// 三本账合起来看：分厂/分项目各记一本，老板要一个总数
app.get('/merge-summary', async (c) => {
  const all = c.env.ENV_ALL || c.env
  const qm = String(c.req.query('month') || '')
  const mm = /^\d{4}-\d{2}$/.test(qm) ? qm : now().slice(0, 7)
  const defs = [['1', all.DB, '主账本'], ['2', all.DB2, '第二本'], ['3', all.DB3, '第三本']]
  const books = []
  for (const [id, db, def] of defs) {
    if (!db) continue
    const g = (sql, ...b) => db.prepare(sql).bind(...b).first().catch(() => null)
    const nm = await g("SELECT value FROM settings WHERE key='book_name'")
    const name = (nm && nm.value) || def
    const pl = await monthPL(db, mm).catch(() => null)
    const nw = await netNow(db).catch(() => null)
    const cnt = await g('SELECT COUNT(*) n FROM orders WHERE month=?', mm)
    const last = await g('SELECT MAX(created_at) t FROM ledger')
    books.push({
      id, name,
      orders: num(cnt && cnt.n),
      income: round2(num(pl && pl.income)), mat: round2(num(pl && pl.mat)), exp: round2(num(pl && pl.cash_exp)),
      adj: round2(num(pl && pl.adj)), profit: round2(num(pl && pl.profit)), margin: round2(num(pl && pl.margin)),
      cash: round2(num(nw && nw.cash)), ar: round2(num(nw && nw.ar)), ap: round2(num(nw && nw.ap)),
      debt: round2(num(nw && nw.debt)), net: round2(num(nw && nw.net)),
      last: last && last.t ? String(last.t).slice(0, 10) : '',
      empty: !num(cnt && cnt.n) && !num(pl && pl.income) && !num(pl && pl.cash_exp) && !num(nw && nw.cash) && !num(nw && nw.ar)
    })
  }
  const used = books.filter((b) => !b.empty)
  const T = (k) => round2(books.reduce((a, b) => a + num(b[k]), 0))
  const totals = { orders: books.reduce((a, b) => a + num(b.orders), 0), income: T('income'), mat: T('mat'), exp: T('exp'), adj: T('adj'),
    profit: T('profit'), cash: T('cash'), ar: T('ar'), ap: T('ap'), debt: T('debt'), net: T('net') }
  totals.margin = totals.income > 0 ? round2(totals.profit / totals.income * 100) : 0
  books.forEach((b) => {
    b.share = totals.income > 0 ? round2(b.income / totals.income * 100) : 0
    b.profit_share = totals.profit > 0 ? round2(b.profit / totals.profit * 100) : 0
  })
  const best = books.slice().sort((a, b) => b.profit - a.profit)[0]
  const text = !used.length
    ? `${mm} 三本账都还是空的，没什么可合并的。`
    : used.length === 1
      ? `${mm} 只有「${used[0].name}」有账：接单 ${used[0].income} 元、净利 ${used[0].profit} 元、家底 ${used[0].net} 元。另外 ${books.length - used.length} 本还空着。`
      : `${mm} ${used.length} 本合计：接单 ${totals.income} 元、净利 ${totals.profit} 元（净利率 ${totals.margin}%）、手头现金 ${totals.cash} 元、家底 ${totals.net} 元。` +
        `赚得最多的是「${best.name}」（净利 ${best.profit} 元，占 ${best.profit_share}%）。`
  return c.json({ ok: true, month: mm, books, totals, used_count: used.length, empty_count: books.length - used.length, best: best ? { id: best.id, name: best.name, profit: best.profit } : null, text })
})

app.get('/books-check', async (c) => {
  const all = c.env.ENV_ALL || c.env
  const role = c.get('role') || 'owner'
  const defs = [['1', all.DB, '主账本'], ['2', all.DB2, '第二本'], ['3', all.DB3, '第三本']]
  const today = now().slice(0, 10)
  const rows = []
  for (const [id, db, def] of defs) {
    if (!db) continue
    const g = (sql) => db.prepare(sql).first().catch(() => null)
    const [nm, cnt, acc, cat, lastR, opening] = await Promise.all([
      g("SELECT value FROM settings WHERE key='book_name'"),
      g("SELECT (SELECT COUNT(*) FROM orders) o, (SELECT COUNT(*) FROM payables) p, (SELECT COUNT(*) FROM ledger) l"),
      g("SELECT COUNT(*) c FROM accounts"),
      g("SELECT COUNT(*) c FROM categories"),
      g("SELECT MAX(created_at) AS t FROM ledger"),
      g("SELECT COALESCE(SUM(opening),0) AS t FROM accounts")
    ])
    const o = num(cnt && cnt.o), p = num(cnt && cnt.p), l = num(cnt && cnt.l)
    const last = (lastR && lastR.t) ? String(lastR.t).slice(0, 10) : ''
    const days = last ? daysSince(last) : -1
    const isCur = String(c.env.BOOK || '1') === id
    const tips = []
    if (o + p + l === 0) tips.push('这本还没记过东西')
    else {
      if (num(acc && acc.c) <= 0) tips.push('没有资金账户，钱都算在「未指定」里')
      if (num(cat && cat.c) <= 0) tips.push('还没设自己的支出分类（用的默认那几类）')
      if (!last) tips.push('还没有现金流水')
      else if (days > 90) tips.push(`最后一次动账是 ${last}，已经 ${days} 天没用了`)
      if (num(opening && opening.t) === 0) tips.push('账户期初都是 0（如果这本是接着老账记的，期初要补）')
    }
    rows.push({ id, name: (nm && nm.value) ? String(nm.value) : def, current: isCur,
      orders: o, payables: p, ledger: l, accounts: num(acc && acc.c), cats: num(cat && cat.c),
      opening: round2(num(opening && opening.t)), last, last_days: days,
      used: o + p + l > 0, tips })
  }
  const usedCount = rows.filter((r) => r.used).length
  const empty = rows.filter((r) => !r.used).map((r) => r.name)
  let advice = ''
  if (usedCount === 0) advice = '三个账本都还是空的。一开始只用当前这本就行，等分厂/分项目了再开第二本。'
  else if (usedCount === 1) advice = `现在只有「${rows.find((r) => r.used).name}」在用，其它空账本留着随时能开，互不影响。`
  else advice = `${usedCount} 本都在用：各本的账、账户、分类都是独立的，报表也只统计当前这本。切换在「设置 → 账本」。`
  if (empty.length) advice += ` 空着的：${empty.join('、')}。`
  // 结构差异：直接在账本列表里标出来（改库漏改第二/三本会在这里露头）
  const schemaBad = []
  for (const r of rows) {
    const db = { '1': all.DB, '2': all.DB2, '3': all.DB3 }[r.id]
    if (!db) continue
    const names = Object.keys(REQ_SCHEMA)
    const info = await Promise.all(names.map((t) => db.prepare('PRAGMA table_info(' + t + ')').all().catch(() => null)))
    const miss = []
    names.forEach((t, i) => {
      const cols = info[i] && info[i].results ? info[i].results.map((x) => x.name) : null
      if (!cols || !cols.length) return miss.push({ table: t, missing: ['整张表'] })
      const lack = REQ_SCHEMA[t].filter((cl) => cols.indexOf(cl) < 0)
      if (lack.length) miss.push({ table: t, missing: lack })
    })
    if (miss.length) { r.tips.push('结构没跟上：' + miss.map((x) => x.table + ' 少 ' + x.missing.join('/')).join('，')); schemaBad.push(r.name) }
  }
  if (schemaBad.length) advice = '（有账本结构没跟上，可能某个功能在上面会用不了）' + advice
  const warn = rows.some((r) => r.used && r.tips.some((t) => /没有资金账户|期初都是 0/.test(t)))
  return c.json({ ok: true, role, current: String(c.env.BOOK || '1'), count: rows.length, used_count: usedCount,
    empty: empty, rows, advice, warn, schema_bad: schemaBad })
})

app.get('/books', async (c) => {
  const all = c.env.ENV_ALL || c.env
  const list = []
  const defs = [[1, all.DB, '主账套'], [2, all.DB2, '账套二'], [3, all.DB3, '账套三']]
  for (const [id, db, def] of defs) {
    if (!db) continue
    let name = def, orders = 0, ar = 0
    try {
      const n = await db.prepare("SELECT value FROM settings WHERE key='book_name'").first()
      if (n && n.value) name = String(n.value)
      const o = await db.prepare('SELECT COUNT(*) AS c FROM orders').first()
      orders = o ? num(o.c) : 0
      const a = await db.prepare('SELECT COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) AS t FROM orders WHERE paid + COALESCE(written_off,0) < price').first()
      ar = a ? round2(num(a.t)) : 0
    } catch (e) { }
    list.push({ id, name, orders, ar })
  }
  return c.json({ current: c.env.BOOK || 1, books: list })
})

app.post('/book-name', async (c) => {
  const { name } = await c.req.json()
  const nm = String(name || '').trim()
  if (!nm) return c.json({ error: '账套名称不能为空' }, 400)
  if (nm.length > 20) return c.json({ error: '名称最多 20 个字' }, 400)
  const db = c.env.DB
  await db.prepare("INSERT INTO settings (key, value) VALUES ('book_name', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(nm).run()
  return c.json({ ok: true })
})

// 权责调整：把「按月摊的费用 + 预提利息」补进当月成本（现金口径本身不含它们）
const accrualAdjust = async (db, m) => {
  // 摊销/预提息/折旧三类一次查完
  const r = await db.prepare("SELECT COALESCE(SUM(CASE WHEN ref_type='amort' THEN amount ELSE 0 END),0) amort, COALESCE(SUM(CASE WHEN ref_type='debt_int' THEN amount ELSE 0 END),0) acr, COALESCE(SUM(CASE WHEN ref_type='dep' THEN amount ELSE 0 END),0) dep FROM ledger WHERE ref_type IN ('amort','debt_int','dep') AND substr(created_at,1,7)=?").bind(m).first().catch(() => null)
  const amort = round2(num(r && r.amort))
  const acr = round2(num(r && r.acr))
  const dep = round2(num(r && r.dep))
  return { amort, accrue_int: acr, dep, net: round2(amort + acr + dep) }
}

app.get('/dashboard', async (c) => {
  const db = c.env.DB
  const m = month()
  const todayS = todayIso()
  const soonS = new Date(Date.now() + TZ_MS + 7 * 86400000).toISOString().slice(0, 10)
  const cutoff = new Date(Date.now() + TZ_MS - 30 * 86400000).toISOString()
  // 性能：原来 20 多条查询一条条排队（一次要 6 秒），现在 1 条聚合 + 并发取明细
  const aggSql = `SELECT
    (SELECT COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) FROM orders WHERE paid + COALESCE(written_off,0) < price) AS ar,
    (SELECT COALESCE(SUM(amount-paid-COALESCE(written_off,0)),0) FROM payables WHERE paid + COALESCE(written_off,0) < amount) AS ap,
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE direction='in' AND cash=1 AND ref_type<>'transfer' AND month=?) AS inc,
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND month=?) AS outt,
    (SELECT COUNT(*) FROM orders WHERE status < 2) AS pending,
    (SELECT COALESCE(SUM(price),0) FROM orders WHERE month=?) AS order_add,
    (SELECT COALESCE(SUM(amount),0) FROM payables WHERE month=?) AS payable_add,
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE ${CASH_EXP_WHERE} AND month=?) AS exp_cash,
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE direction='in' AND cash=1 AND ref_type<>'transfer' AND substr(created_at,1,10)=?) AS today_in,
    (SELECT COALESCE(SUM(CASE WHEN ref_type='amort' THEN amount ELSE 0 END),0) FROM ledger WHERE ref_type='amort' AND month=?) AS amort,
    (SELECT COALESCE(SUM(CASE WHEN ref_type='debt_int' THEN amount ELSE 0 END),0) FROM ledger WHERE ref_type='debt_int' AND month=?) AS acr,
    (SELECT COALESCE(SUM(CASE WHEN ref_type='dep' THEN amount ELSE 0 END),0) FROM ledger WHERE ref_type='dep' AND month=?) AS dep,
    (SELECT COUNT(*) FROM (SELECT o.customer, SUM(MAX(0,o.price-o.paid-COALESCE(o.written_off,0))) AS unpaid FROM orders o GROUP BY o.customer) t JOIN credit_limits l ON l.party=t.customer WHERE l.limit_amount>0 AND t.unpaid>l.limit_amount) AS over_limit,
    (SELECT COALESCE(SUM(amount-used-returned),0) FROM loans) AS loan_open,
    (SELECT value FROM settings WHERE key='selfcheck_count') AS sc_cnt,
    (SELECT value FROM settings WHERE key='selfcheck_at') AS sc_at,
    (SELECT receive FROM targets WHERE month=?) AS tgt_receive,
    (SELECT order_add FROM targets WHERE month=?) AS tgt_order,
    (SELECT COALESCE(SUM(COALESCE(cost,0)),0) FROM orders WHERE month=?) AS order_cost`
  const [aggR, recentR, overdueR, dueSoonR, paySoonR, topCustR, budsR, spendR, debtRowsR, debtRepsR, accList] = await Promise.all([
    db.prepare(aggSql).bind(m, m, m, m, m, todayS, m, m, m, m, m, m).first().catch((e) => { noteFail(e, '首页汇总'); return null }),
    db.prepare('SELECT * FROM ledger ORDER BY id DESC LIMIT 10').all().catch((e) => { noteFail(e, '首页明细'); return null }),
    db.prepare('SELECT * FROM orders WHERE paid + COALESCE(written_off,0) < price AND created_at < ? ORDER BY created_at LIMIT 5').bind(cutoff).all().catch((e) => { noteFail(e, '首页明细'); return null }),
    db.prepare("SELECT * FROM orders WHERE paid + COALESCE(written_off,0) < price AND due_date IS NOT NULL AND substr(due_date,1,10) <= ? AND substr(due_date,1,10) >= ? ORDER BY due_date LIMIT 8").bind(soonS, todayS).all().catch((e) => { noteFail(e, '首页明细'); return null }),
    db.prepare("SELECT * FROM payables WHERE paid + COALESCE(written_off,0) < amount AND due_date IS NOT NULL AND substr(due_date,1,10) <= ? AND substr(due_date,1,10) >= ? ORDER BY due_date LIMIT 8").bind(soonS, todayS).all().catch((e) => { noteFail(e, '首页明细'); return null }),
    db.prepare('SELECT customer AS nm, COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) AS t FROM orders WHERE paid + COALESCE(written_off,0) < price GROUP BY customer ORDER BY t DESC LIMIT 1').first().catch((e) => { noteFail(e, '首页客户'); return null }),
    db.prepare('SELECT * FROM budgets ORDER BY id').all().catch((e) => { noteFail(e, '首页明细'); return null }),
    db.prepare("SELECT COALESCE(NULLIF(category,''),'其他') AS c, COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND month=? GROUP BY 1").bind(m).all().catch((e) => { noteFail(e, '首页明细'); return null }),
    db.prepare('SELECT * FROM debts').all().catch((e) => { noteFail(e, '首页明细'); return null }),
    db.prepare('SELECT * FROM debt_repays').all().catch((e) => { noteFail(e, '首页明细'); return null }),
    accountBalances(db).catch((e) => { noteFail(e, '账户余额'); return null })
  ])
  const agg = aggR || {}
  const ar = { total: agg.ar }, ap = { total: agg.ap }, inc = { total: agg.inc }, out = { total: agg.outt }
  const pending = { n: agg.pending }, orderAdd = { t: agg.order_add }, payableAdd = { t: agg.payable_add }
  const matCost = { t: agg.order_cost }
  const expCash = { t: agg.exp_cash }, todayIn = { t: agg.today_in }
  const accAdj = { amort: round2(num(agg.amort)), accrue_int: round2(num(agg.acr)), dep: round2(num(agg.dep)) }
  accAdj.net = round2(accAdj.amort + accAdj.accrue_int + accAdj.dep)
  const expTotal = round2(num(expCash.t) + accAdj.net)
  // 任何一条明细查询失败都不能把首页整页打挂：拿不到就当空，并在 degraded 里说明
  const R0 = (x) => x || { results: [] }
  const recent = R0(recentR), overdue = R0(overdueR), dueSoon = R0(dueSoonR), paySoon = R0(paySoonR)
  const topCust = topCustR || {}, buds = R0(budsR)
  const debtRows = R0(debtRowsR).results, debtReps = R0(debtRepsR).results
  const debts = (() => {
    const list = debtRows.map((d) => debtView(d, debtReps.filter((r) => r.debt_id === d.id))).filter((x) => x.status === 'open')
    return { total_principal: round2(list.reduce((a, x) => a + x.remain, 0)), month_interest: round2(list.reduce((a, x) => a + x.monthly_interest, 0)), overdue_count: list.filter((x) => x.overdue).length, soon: list.filter((x) => !x.overdue && x.days_to_due !== null && x.days_to_due >= 0 && x.days_to_due <= 7) }
  })()
  const overLimit = { n: num(agg.over_limit) }
  const curM = now().slice(0, 7)
  const tgtRow = { receive: num(agg.tgt_receive), order_add: num(agg.tgt_order) }
  // 预算：一次分组查出本月各分类已花，再和预算比（原来每个预算查一次）
  const spendMap = {}
  for (const r of (R0(spendR).results)) spendMap[String(r.c || '')] = round2(num(r.t))
  const budgetOver = []
  for (const b of (buds.results || [])) {
    const spent = round2(num(spendMap[b.category]))
    const limit = round2(num(b.amount))
    const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0
    if (pct >= 90) budgetOver.push({ category: b.category, limit, spent, pct, over: spent > limit, over_amt: spent > limit ? round2(spent - limit) : 0 })
  }
  const cashBal = round2((accList || []).reduce((s2, a) => s2 + num(a && a.balance), 0))
  const role = c.get('role') || 'owner'
  const hideProfit = role === 'staff'
  const scRow = { value: agg.sc_cnt }, scAt = { value: agg.sc_at }
  return c.json({
    role,
    hide_profit: hideProfit,
    degraded: failBucket.slice(),
    issue_count: hideProfit ? 0 : Number((scRow && scRow.value) || 0),
    issue_at: (scAt && scAt.value) || '',
    ar_total: round2(num(ar.total)),
    ap_total: round2(num(ap.total)),
    month_income: round2(num(inc.total)),
    month_outcome: round2(num(out.total)),
    month_profit: hideProfit ? null : round2(num(inc.total) - num(out.total)),
    month_order_add: round2(num(orderAdd.t)),
    month_payable_add: round2(num(payableAdd.t)),
    month_expense_cash: expTotal,
    month_amort: accAdj.amort,
    month_accrue_int: accAdj.accrue_int,
    month_dep: accAdj.dep,
    month_mat_cost: round2(num(matCost.t)),
    profit_biz: hideProfit ? null : round2(num(orderAdd.t) - num(matCost.t) - expTotal),
    pending_count: pending.n,
    today_income: round2(num(todayIn.t)),
    top_customer: topCust ? topCust.nm : '',
    top_unpaid: topCust ? round2(num(topCust.t)) : 0,
    overdue_count: overdue.results.length,
    overdue: overdue.results.map((r) => ({ ...r, unpaid: round2(r.price - r.paid) })),
    due_soon_count: dueSoon.results.length,
    due_soon: dueSoon.results.map((r) => ({ ...r, unpaid: round2(r.price - r.paid), due_short: (r.due_date || '').slice(0, 10) })),
    debt_total: hideProfit ? null : debts.total_principal,
    net_worth: hideProfit ? null : round2(cashBal + num(ar.total) - num(ap.total) - debts.total_principal),
    debt_month_interest: hideProfit ? null : debts.month_interest,
    debt_overdue_count: hideProfit ? 0 : debts.overdue_count,
    debt_soon_count: hideProfit ? 0 : debts.soon.length,
    over_limit_count: hideProfit ? 0 : overLimit.n,
    pay_soon_count: paySoon.results.length,
    pay_soon: paySoon.results.map((r) => ({ ...r, unpaid: round2(r.amount - r.paid), due_short: (r.due_date || '').slice(0, 10) })),
    recent: recent.results,
    budget_over: budgetOver,
    budget_alert_count: budgetOver.length,
    cash_balance: cashBal,
    loan_open: round2(num(agg.loan_open)),
    target_receive: round2(num((tgtRow && tgtRow.receive))),
    target_order: round2(num((tgtRow && tgtRow.order_add))),
    target_pct: (tgtRow && num(tgtRow.receive) > 0) ? Math.round(num(inc.total) / num(tgtRow.receive) * 1000) / 10 : null,
    target_gap: (tgtRow && num(tgtRow.receive) > 0) ? round2(num(tgtRow.receive) - num(inc.total)) : null
  })
})

// 现金流预测：手头现金 + 未来 N 天内预计进/出 → 哪一天会见底
app.get('/cashflow', async (c) => {
  const db = c.env.DB
  const days = Math.min(120, Math.max(7, Math.round(num(c.req.query('days'), 45))))
  const today = now().slice(0, 10)
  const dayMs = 86400000
  const start = new Date(today + 'T00:00:00.000Z')
  const addDays = (d, n) => new Date(d.getTime() + n * dayMs).toISOString().slice(0, 10)
  const horizon = addDays(start, days)
  const cash = round2((await accountBalances(db)).reduce((a, x) => a + x.balance, 0))
  const buckets = {}
  for (let i = 0; i <= days; i++) { const d = addDays(start, i); buckets[d] = { date: d, in: 0, out: 0 } }
  const inflowItems = []
  const outflowItems = []
  let noDueAr = 0, noDueAp = 0
  // 应收：有约定期就按约定日，没有就按"开单后 30 天"估
  const { results: ars } = await db.prepare("SELECT id, customer, item_name, price - paid - COALESCE(written_off,0) AS left_amt, created_at, due_date FROM orders WHERE paid + COALESCE(written_off,0) < price").all()
  for (const o of ars) {
    const left = Math.max(0, round2(num(o.left_amt)))
    if (!left) continue
    const dd = o.due_date ? String(o.due_date).slice(0, 10) : addDays(new Date(String(o.created_at).slice(0, 10) + 'T00:00:00.000Z'), 30)
    if (!o.due_date) noDueAr = round2(noDueAr + left)
    const useDate = dd < today ? today : dd
    if (useDate > horizon) continue
    buckets[useDate].in = round2(buckets[useDate].in + left)
    inflowItems.push({ id: o.id, party: o.customer, item: o.item_name || '加工费', amount: left, date: useDate, overdue: dd < today, no_due: !o.due_date })
  }
  // 应付：同理，没有约定日期按"记账后 15 天"估
  const { results: aps } = await db.prepare("SELECT id, supplier, remark, category, amount - paid - COALESCE(written_off,0) AS left_amt, created_at, due_date FROM payables WHERE paid + COALESCE(written_off,0) < amount").all()
  for (const a of aps) {
    const left = Math.max(0, round2(num(a.left_amt)))
    if (!left) continue
    const dd = a.due_date ? String(a.due_date).slice(0, 10) : addDays(new Date(String(a.created_at).slice(0, 10) + 'T00:00:00.000Z'), 15)
    if (!a.due_date) noDueAp = round2(noDueAp + left)
    const useDate = dd < today ? today : dd
    if (useDate > horizon) continue
    buckets[useDate].out = round2(buckets[useDate].out + left)
    outflowItems.push({ id: a.id, party: a.supplier, item: [a.category, a.remark].filter(Boolean).join(' ') || '货款', amount: left, date: useDate, overdue: dd < today })
  }
  // 固定支出：按每月 day 号推算
  let fixedTotal = 0
  try {
    const { results: fixed } = await db.prepare('SELECT * FROM fixed_expenses').all()
    for (const f of fixed) {
      const amt = num(f.amount)
      for (let k = 0; k <= 2; k++) {
        const d0 = new Date(start)
        const y = d0.getUTCFullYear(), mo = d0.getUTCMonth() + k
        const dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()
        const day = Math.min(num(f.day, 1), dim)
        const ds = new Date(Date.UTC(y, mo, day)).toISOString().slice(0, 10)
        if (ds >= today && ds <= horizon && buckets[ds]) {
          buckets[ds].out = round2(buckets[ds].out + amt)
          fixedTotal = round2(fixedTotal + amt)
          outflowItems.push({ id: 'f' + f.id, party: f.remark || f.category || '固定支出', item: '每月固定', amount: amt, date: ds, fixed: true })
        }
      }
    }
  } catch (e) { console.error('cashflow fixed', e) }
  // 逐日余额，找最低点
  const byDate = []
  let bal = cash, minBal = cash, minDate = today, sumIn = 0, sumOut = 0
  for (let i = 0; i <= days; i++) {
    const d = addDays(start, i)
    const b = buckets[d]
    sumIn = round2(sumIn + b.in)
    sumOut = round2(sumOut + b.out)
    bal = round2(bal + b.in - b.out)
    if (bal < minBal) { minBal = bal; minDate = d }
    if (b.in || b.out) byDate.push({ date: d, in: b.in, out: b.out, balance: bal })
  }
  const risky = byDate.filter((x) => x.balance < 0).slice(0, 3)
  inflowItems.sort((a, b) => (a.date < b.date ? -1 : 1))
  outflowItems.sort((a, b) => (a.date < b.date ? -1 : 1))
  return c.json({
    days, today, horizon,
    cash, inflow: sumIn, outflow: sumOut, end: round2(cash + sumIn - sumOut),
    min_balance: round2(minBal), min_date: minDate,
    risk: minBal < 0, risky, by_date: byDate,
    overdue_in: round2(inflowItems.filter((x) => x.overdue).reduce((a, x) => a + x.amount, 0)),
    no_due_in: noDueAr, no_due_out: noDueAp, fixed_total: fixedTotal,
    in_items: inflowItems.slice(0, 12), out_items: outflowItems.slice(0, 12),
    in_count: inflowItems.length, out_count: outflowItems.length
  })
})

// 近 7 天经营速览（周报）：可复制，也可自动推微信
const weeklyStat = async (db) => {
  const end = now()
  const start = new Date(Date.now() + TZ_MS - 6 * 86400000).toISOString()
  const q = async (sql) => num((await db.prepare(sql).bind(start, end).first()).t)
  const inc = await q("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE direction='in' AND cash=1 AND ref_type<>'transfer' AND created_at>=? AND created_at<=?")
  const out = await q("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND created_at>=? AND created_at<=?")
  const incCnt = await q("SELECT COUNT(*) t FROM ledger WHERE direction='in' AND cash=1 AND ref_type<>'transfer' AND created_at>=? AND created_at<=?")
  const outCnt = await q("SELECT COUNT(*) t FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND created_at>=? AND created_at<=?")
  const orderAdd = await q('SELECT COALESCE(SUM(price),0) t FROM orders WHERE created_at>=? AND created_at<=?')
  const payableAdd = await q('SELECT COALESCE(SUM(amount),0) t FROM payables WHERE created_at>=? AND created_at<=?')
  const expCash = await q(`SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE ${CASH_EXP_WHERE} AND created_at>=? AND created_at<=?`)
  const matCost = await q('SELECT COALESCE(SUM(COALESCE(cost,0)),0) t FROM orders WHERE created_at>=? AND created_at<=?')
  const arTotal = num((await db.prepare('SELECT COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) t FROM orders WHERE paid + COALESCE(written_off,0) < price').first()).t)
  const apTotal = num((await db.prepare('SELECT COALESCE(SUM(amount-paid-COALESCE(written_off,0)),0) t FROM payables WHERE paid + COALESCE(written_off,0) < amount').first()).t)
  const topAr = (await db.prepare('SELECT customer nm, SUM(price-paid-COALESCE(written_off,0)) t FROM orders WHERE paid + COALESCE(written_off,0) < price GROUP BY customer ORDER BY t DESC LIMIT 3').all()).results
  const cash = round2((await accountBalances(db)).reduce((a, x) => a + x.balance, 0))
  const profit = round2(orderAdd - matCost - expCash)
  return {
    from: start.slice(0, 10), to: end.slice(0, 10),
    inc: round2(inc), inc_cnt: incCnt, out: round2(out), out_cnt: outCnt,
    order_add: round2(orderAdd), payable_add: round2(payableAdd), mat_cost: round2(matCost), exp_cash: round2(expCash),
    profit, ar_total: round2(arTotal), ap_total: round2(apTotal), cash,
    top_ar: topAr.map((r) => ({ party: r.nm, amount: round2(num(r.t)) }))
  }
}
const weeklyText = async (db) => {
  const w = await weeklyStat(db)
  const lines = []
  if (typeof titled === 'function') lines.push(...(await titled(db, `上周经营速览 ${w.from.slice(5)} ~ ${w.to.slice(5)}`)))
  lines.push(`收到：¥${w.inc}（${w.inc_cnt} 笔）`)
  lines.push(`付出：¥${w.out}（${w.out_cnt} 笔）`)
  lines.push(`净流入：¥${round2(w.inc - w.out)}`)
  lines.push(`新接单：¥${w.order_add}　新赊购：¥${w.payable_add}　现金成本：¥${w.exp_cash}`)
  lines.push(`净利（权责口径）：¥${w.profit}`)
  lines.push(`现在被欠：¥${w.ar_total}　我欠别人：¥${w.ap_total}　手头现金：¥${w.cash}`)
  if (w.top_ar.length) lines.push('欠款最多：' + w.top_ar.map((x) => `${x.party} ¥${x.amount}`).join('、'))
  return { text: lines.join('\n'), stat: w }
}
app.get('/weekly-text', async (c) => c.json(await weeklyText(c.env.DB)))

// 周一早上推周报（一次性订阅消费一条额度）
// 每月 1 号推一条上个月的「对账进度」：对了多少家、还有几条差异没处理
async function pushReconRemind(db) {
  try {
    const cfg = await wxCfg(db)
    if (!cfg.appid || !cfg.secret || !cfg.tpl) return
    const d = new Date(Date.now() + TZ_MS)
    const lm = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)
    const all = await db.prepare('SELECT COUNT(*) n FROM recon_log WHERE month=?').bind(lm).first()
    const open = await db.prepare("SELECT COUNT(*) n FROM recon_log WHERE done=0 AND state<>'match'").first()
    await wxPush(db, {
      title: `${lm.slice(5)} 月对账：核对 ${num(all && all.n)} 家`,
      time: lm,
      note: num(open.n) > 0 ? `还有 ${num(open.n)} 条差异没处理，进去看看` : '差异都处理完了，账对平了'
    })
  } catch (e) { console.error('recon remind failed', e) }
}

async function pushWeekly(db) {
  try {
    const cfg = await wxCfg(db)
    if (!cfg.appid || !cfg.secret || !cfg.tpl) return
    const w = await weeklyText(db)
    const s = w.stat
    // 周报里带上本月目标进度，一眼知道还差多少
    let goalTxt = ''
    try {
      const m = now().slice(0, 7)
      const t = await db.prepare('SELECT receive FROM targets WHERE month=?').bind(m).first()
      if (num(t && t.receive) > 0) {
        const inc = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE direction='in' AND cash=1 AND substr(created_at,1,7)=?").bind(m).first()
        goalTxt = '；目标进度 ' + Math.round(num(inc && inc.t) / num(t.receive) * 1000) / 10 + '%'
      }
    } catch (e) { /* 没设目标就不带 */ }
    await wxPush(db, {
      title: `上周收 ¥${s.inc} 付 ¥${s.out}`,
      time: `${s.from.slice(5)} ~ ${s.to.slice(5)}`,
      note: `毛利约 ¥${s.profit}；被欠 ¥${s.ar_total}，手头 ¥${s.cash}${goalTxt}`
    })
  } catch (e) { console.error('weekly push failed', e) }
}

// 赚没赚：两个口径对比
app.get('/profit-compare', async (c) => {
  const db = c.env.DB
  const m = String(c.req.query('month') || month()).slice(0, 7)
  const q = async (sql) => num((await db.prepare(sql).bind(m).first()).t)
  const inc = await q("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='in' AND cash=1 AND ref_type<>'transfer' AND month=?")
  const out = await q("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND substr(created_at,1,7)=?")
  const orderAdd = await q('SELECT COALESCE(SUM(price),0) AS t FROM orders WHERE month=?')
  const payableAdd = await q('SELECT COALESCE(SUM(amount),0) AS t FROM payables WHERE month=?')
  const expCash = await q("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND ref_type='expense' AND month=?")
  const fixedCash = await q("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND ref_type='fixed' AND substr(created_at,1,7)=?")
  const matCost = await q('SELECT COALESCE(SUM(COALESCE(cost,0)),0) AS t FROM orders WHERE month=?')
  const accAdj = await accrualAdjust(db, m)
  // 现金口径：本月实际收到的钱 − 本月实际付出的钱
  const cash = num(inc) - num(out)
  // 权责口径：本月接的活 − 本月赊的料 − 本月花的现金成本（工资水电等）
  const otherCash = round2(num(out) - expCash - fixedCash) // 还供应商/其它付出
  const accrual = round2(num(orderAdd) - num(matCost) - expCash - fixedCash - accAdj.net)
  return c.json({
    month: m,
    cash_income: round2(num(inc)),
    cash_outcome: round2(num(out)),
    cash_profit: round2(cash),
    order_add: round2(num(orderAdd)),
    mat_cost: round2(num(matCost)),
    payable_add: round2(num(payableAdd)),
    expense_cash: round2(num(expCash) + accAdj.net),
    amort: accAdj.amort,
    accrue_int: accAdj.accrue_int,
    dep: accAdj.dep,
    fixed_cash: round2(fixedCash),
    other_cash_out: otherCash,
    accrual_profit: accrual,
    // 两者差额 = 本月应收新增 − 本月应收回款等价部分，简单解释用
    gap: round2(accrual - cash)
  })
})

// 应收：未结清订单
// 分页参数：offset 起始条数，limit 每页条数（默认 60，最多 200）
const pageArgs = (c) => {
  const u = new URL(c.req.url)
  const off = Math.max(0, num(u.searchParams.get('offset'), 0))
  let lim = num(u.searchParams.get('limit'), 60)
  if (lim <= 0) lim = 60
  if (lim > 200) lim = 200
  return { off, lim }
}

// ── 应收 / 应付 列表公共件 ──
const dayStr = (d) => new Date(d.getTime() + TZ_MS).toISOString().slice(0, 10)
const dayAgo = (n) => dayStr(new Date(Date.now() - n * 86400000))
const dayAfter = (n) => dayStr(new Date(Date.now() + n * 86400000))
// 只按「日期串」相减，不掺时刻，避免 8 小时时差把天数算偏
const dateNum = (iso) => Date.parse(String(iso || '').slice(0, 10) + 'T00:00:00.000Z')
const daysSince = (iso) => {
  const t = dateNum(iso)
  if (isNaN(t)) return 0
  return Math.max(0, Math.round((dateNum(todayIso()) - t) / 86400000))
}
// 带符号天数差：正数=已经过去 N 天，负数=还有 N 天到期（daysSince 会把未来压成 0，到期表不能用它）
const dayDiff = (iso) => {
  const t = dateNum(iso)
  if (isNaN(t)) return 0
  return Math.round((dateNum(todayIso()) - t) / 86400000)
}
const fmtOrder = (r) => ({
  ...r,
  cost: round2(num(r.cost)),
  gross: round2(num(r.price) - num(r.cost)),
  gross_pct: num(r.price) > 0 ? round2(((num(r.price) - num(r.cost)) / num(r.price)) * 100) : 0,
  unpaid: round2(num(r.price) - num(r.paid) - num(r.written_off)),
  written_off: round2(num(r.written_off)),
  due_short: (r.due_date || '').slice(0, 10),
  days: daysSince(r.created_at),
  settled: round2(num(r.paid) + num(r.written_off)) >= round2(num(r.price))
})
const fmtPayable = (r) => ({
  ...r,
  unpaid: round2(num(r.amount) - num(r.paid) - num(r.written_off)),
  written_off: round2(num(r.written_off)),
  due_short: (r.due_date || '').slice(0, 10),
  days: daysSince(r.created_at),
  settled: round2(num(r.paid) + num(r.written_off)) >= round2(num(r.amount))
})
const listOpts = (c) => {
  const sp = new URL(c.req.url).searchParams
  const status = ['open', 'overdue', 'due', 'closed', 'all'].includes(sp.get('status')) ? sp.get('status') : 'open'
  const sort = sp.get('sort') || 'new'
  const orderBy = ({
    new: 'id DESC',
    old: 'created_at ASC, id ASC',
    amount: '{A} DESC, id DESC',
    due: "CASE WHEN due_date IS NULL OR due_date='' THEN 1 ELSE 0 END, due_date ASC, id DESC",
    days: 'created_at ASC, id ASC'
  })[sort] || 'id DESC'
  return { status, sort, orderBy, kw: (sp.get('kw') || '').trim() }
}

app.get('/ar', async (c) => {
  const db = c.env.DB
  const { off, lim } = pageArgs(c)
  const { status, orderBy, kw } = listOpts(c)
  const conds = []
  const b = []
  if (status === 'closed') conds.push('paid + COALESCE(written_off,0) >= price')
  else if (status === 'all') conds.push('1=1')
  else conds.push('paid + COALESCE(written_off,0) < price')
  if (status === 'overdue') { conds.push('substr(created_at,1,10) <= ?'); b.push(dayAgo(30)) }
  if (status === 'due') {
    conds.push("due_date IS NOT NULL AND due_date <> '' AND substr(due_date,1,10) <= ?"); b.push(dayAfter(7))
  }
  const selfAr = await selfOnly(c)
  if (selfAr.on) { conds.push('created_by = ?'); b.push(selfAr.who) }
  const scAr = await scopeOwn(c)
  if (scAr.on) { conds.push('customer IN (SELECT party FROM party_staff WHERE staff = ?)'); b.push(scAr.name) }
  if (kw) {
    conds.push('(customer LIKE ? OR item_name LIKE ? OR COALESCE(operator,\'\') LIKE ?)')
    b.push('%' + kw + '%', '%' + kw + '%', '%' + kw + '%')
  }
  const payExpr = '(price - paid - COALESCE(written_off,0))'
  const { results } = await db.prepare(`SELECT * FROM orders WHERE ${conds.join(' AND ')} ORDER BY ${orderBy.replace('{A}', payExpr)} LIMIT ? OFFSET ?`)
    .bind(...b, lim, off).all()
  return c.json(results.map(fmtOrder))
})

// 应收 / 应付 页内汇总
// 上次跟这个客户/供应商做过什么（录入时自动带出，少打字）
app.get('/last-deal', async (c) => {
  const db = c.env.DB
  const u = new URL(c.req.url)
  const party = (u.searchParams.get('party') || '').trim()
  const type = u.searchParams.get('type') === 'ap' ? 'ap' : 'ar'
  if (!party) return c.json({})
  if (type === 'ap') {
    const r = await db.prepare("SELECT supplier, COALESCE(remark,'') item, amount, COALESCE(operator,'') operator FROM payables WHERE supplier=? ORDER BY id DESC LIMIT 1").bind(party).first()
    return c.json(r ? { found: true, item: r.item, amount: round2(num(r.amount)), operator: r.operator, last_date: '' } : { found: false })
  }
  const r = await db.prepare("SELECT customer, COALESCE(item_name,'') item, price, COALESCE(operator,'') operator, created_at FROM orders WHERE customer=? ORDER BY id DESC LIMIT 1").bind(party).first()
  return c.json(r ? { found: true, item: r.item, amount: round2(num(r.price)), operator: r.operator, last_date: (r.created_at || '').slice(0, 10) } : { found: false })
})



// 开账引导：第一次用要先把"底数"填上，否则后面所有报表都不准
// 默认账期：没单独设账期的单位，新单按这个天数自动算到期日（新用户最容易漏的一步）
app.get('/term-default', async (c) => {
  const db = c.env.DB
  const r = await db.prepare("SELECT value FROM settings WHERE key='default_term'").first().catch(() => null)
  return c.json({ ok: true, days: num(r && r.value) })
})
app.post('/term-default', async (c) => {
  const b = await c.req.json()
  const db = c.env.DB
  const days = Math.max(0, Math.min(180, Math.round(num(b.days))))
  await db.prepare("INSERT INTO settings (key,value) VALUES ('default_term',?) ON CONFLICT(key) DO UPDATE SET value=?").bind(String(days), String(days)).run()
  await logAudit(db, '默认账期', 'settings', `${days} 天`)
  let filled = 0
  if (days > 0 && b.fill) {
    // 顺手把没到期日的未结单补上（按单据日期 + 天数）
    const os = (await db.prepare("SELECT id, created_at FROM orders WHERE paid < price AND (due_date IS NULL OR due_date='')").all()).results || []
    const ps = (await db.prepare("SELECT id, created_at FROM payables WHERE paid < amount AND (due_date IS NULL OR due_date='')").all()).results || []
    const st = []
    for (const x of os) st.push(db.prepare('UPDATE orders SET due_date=? WHERE id=?').bind(addDaysIso(String(x.created_at || '').slice(0, 10), days) + 'T00:00:00.000Z', x.id))
    for (const x of ps) st.push(db.prepare('UPDATE payables SET due_date=? WHERE id=?').bind(addDaysIso(String(x.created_at || '').slice(0, 10), days) + 'T00:00:00.000Z', x.id))
    for (let i = 0; i < st.length; i += 40) { try { await db.batch(st.slice(i, i + 40)) } catch (e) { /* 忽略 */ } }
    filled = st.length
  }
  return c.json({ ok: true, days, filled })
})

app.get('/onboarding', async (c) => {
  const db = c.env.DB
  await ensureAccounts(db)
  const accs = (await db.prepare('SELECT * FROM accounts').all()).results
  const opening = round2(accs.reduce((a, x) => a + num(x.opening), 0))
  const oRow = await db.prepare('SELECT COUNT(*) AS n FROM orders').first()
  const pRow = await db.prepare('SELECT COUNT(*) AS n FROM payables').first()
  const lRow = await db.prepare('SELECT COUNT(*) AS n FROM ledger').first()
  const flag = (await db.prepare("SELECT value FROM settings WHERE key='onboard_done'").first()) || {}
  const dt = await db.prepare("SELECT value FROM settings WHERE key='default_term'").first().catch(() => null)
  const tr = await db.prepare('SELECT COUNT(*) AS n FROM party_terms').first().catch(() => null)
  const hasTerm = num(dt && dt.value) > 0 || num(tr && tr.n) > 0
  const steps = [
    { k: 'acc', t: '填一下账户余额', d: '现在手上的现金、银行卡、微信里各有多少钱', done: opening > 0, go: '设置 → 账户' },
    { k: 'term', t: '设个默认账期', d: '比如「30 天」，新单自动算到期日，到期才会提醒你收钱', done: hasTerm, go: '设置 → 单位 → 默认账期' },
    { k: 'ar', t: '录"别人还欠我"的账', d: '外面还没收回来的加工费（期初应收）', done: num(oRow && oRow.n) > 0, go: '记账 → 导入 → 期初应收' },
    { k: 'ap', t: '录"我还欠别人"的账', d: '还没付给供应商的钱（期初应付）', done: num(pRow && pRow.n) > 0, go: '记账 → 导入 → 期初应付' }
  ]
  const doneCount = steps.filter((x) => x.done).length
  return c.json({
    show: String(flag.value || '') !== '1',
    steps, done: doneCount, total: steps.length, all_done: doneCount === steps.length,
    opening, ledger_rows: num(lRow && lRow.n), default_term: num(dt && dt.value)
  })
})
app.post('/onboarding/dismiss', async (c) => {
  const db = c.env.DB
  await db.prepare("INSERT INTO settings (key,value) VALUES ('onboard_done','1') ON CONFLICT(key) DO UPDATE SET value='1'").run()
  return c.json({ ok: true })
})

// 账龄表：欠款按 30/60/90 天分档，一眼看出哪笔要坏
app.get('/aging', async (c) => {
  const db = c.env.DB
  const type = c.req.query('type') === 'ap' ? 'ap' : 'ar'
  const rows = type === 'ar'
    ? (await db.prepare('SELECT id,customer AS party,item_name AS item,price AS total,paid,written_off,created_at,due_date FROM orders WHERE paid + COALESCE(written_off,0) < price ORDER BY id').all()).results
    : (await db.prepare('SELECT id,supplier AS party,COALESCE(remark,\'\') AS item,amount AS total,paid,written_off,created_at,due_date FROM payables WHERE paid + COALESCE(written_off,0) < amount ORDER BY id').all()).results
  const BK = [
    { k: '30天内', label: '30 天内', key: 'd30', min: 0, max: 30 },
    { k: '31-60天', label: '31-60 天', key: 'd60', min: 31, max: 60 },
    { k: '61-90天', label: '61-90 天', key: 'd90', min: 61, max: 90 },
    { k: '90天以上', label: '90 天以上', key: 'd999', min: 91, max: 99999 }
  ]
  const buckets = BK.map((b) => ({ k: b.k, label: b.label, key: b.key, amount: 0, count: 0, cnt: 0, pct: 0 }))
  const pmap = {}
  const bad = []
  let total = 0
  for (const r of rows) {
    const unpaid = round2(num(r.total) - num(r.paid) - num(r.written_off))
    if (unpaid <= 0) continue
    const days = daysSince(r.created_at)
    const bi = Math.max(0, BK.findIndex((b) => days >= b.min && days <= b.max))
    buckets[bi].amount = round2(buckets[bi].amount + unpaid)
    buckets[bi].count += 1
    buckets[bi].cnt += 1
    total = round2(total + unpaid)
    const key = r.party || '(未填)'
    if (!pmap[key]) pmap[key] = { party: key, total: 0, cnt: 0, b: [0, 0, 0, 0], oldest_days: 0 }
    const p = pmap[key]
    p.total = round2(p.total + unpaid)
    p.cnt += 1
    p.b[bi] = round2(p.b[bi] + unpaid)
    p.oldest_days = Math.max(p.oldest_days, days)
    if (days > 90) bad.push({ id: r.id, party: key, item: r.item || '', unpaid, amount: unpaid, days, due: (r.due_date || '').slice(0, 10) })
  }
  for (const b of buckets) b.pct = total ? Math.round((b.amount / total) * 100) : 0
  const parties = Object.keys(pmap).map((k) => pmap[k]).sort((a, b2) => b2.total - a.total)
  bad.sort((a, b2) => b2.days - a.days)
  const risky = round2(buckets[2].amount + buckets[3].amount)
  const provision = type === 'ar' ? round2(buckets[2].amount * 0.1 + buckets[3].amount * 0.3) : 0
  return c.json({
    type, total, count: rows.length, buckets, parties,
    bad: bad.slice(0, 20),
    provision,
    over60: risky,
    worst: bad.slice(0, 8),
    risky, risky_pct: total ? Math.round((risky / total) * 100) : 0,
    advice: total === 0 ? '没有欠款，很干净。'
      : risky > 0 ? '有 ' + round2(risky) + ' 元已经拖过 60 天（占 ' + (total ? Math.round((risky / total) * 100) : 0) + '%），建议单独去催，实在收不回的按坏账核销。'
        : '目前都在 60 天内，正常范围，按月跟进即可。'
  })
})

// 智能建议：最近 90 天最常记的几组（客户+产品+金额 / 分类+金额），点一下就填好
app.get('/suggest', async (c) => {
  const db = c.env.DB
  const type = new URL(c.req.url).searchParams.get('type') || 'ar'
  if (type === 'ap') {
    const r = await db.prepare("SELECT supplier party, COALESCE(remark,'') item, ROUND(AVG(amount),2) amount, COUNT(*) cnt FROM payables WHERE created_at >= date('now','-90 day') GROUP BY supplier, COALESCE(remark,'') ORDER BY cnt DESC, MAX(id) DESC LIMIT 6").all()
    return c.json(r.results)
  }
  if (type === 'expense') {
    const r = await db.prepare("SELECT COALESCE(NULLIF(category,''),'其他') party, COALESCE(remark,'') item, ROUND(AVG(amount),2) amount, COUNT(*) cnt FROM ledger WHERE direction='out' AND ref_type='expense' AND created_at >= date('now','-90 day') GROUP BY COALESCE(NULLIF(category,''),'其他'), COALESCE(remark,'') ORDER BY cnt DESC, MAX(id) DESC LIMIT 6").all()
    return c.json(r.results)
  }
  const r = await db.prepare("SELECT customer party, COALESCE(item_name,'') item, ROUND(AVG(price),2) amount, COUNT(*) cnt FROM orders WHERE created_at >= date('now','-90 day') GROUP BY customer, COALESCE(item_name,'') ORDER BY cnt DESC, MAX(id) DESC LIMIT 6").all()
  return c.json(r.results)
})

app.get('/ar-summary', async (c) => {
  const db = c.env.DB
  const type = c.req.query('type') === 'ap' ? 'ap' : 'ar'
  const m = now().slice(0, 7)
  const today = now().slice(0, 10)
  if (type === 'ar') {
    const open = await db.prepare('SELECT COUNT(*) n, COALESCE(SUM(price - paid - COALESCE(written_off,0)),0) t FROM orders WHERE paid + COALESCE(written_off,0) < price').first()
    const over = await db.prepare("SELECT COUNT(*) n, COALESCE(SUM(price - paid - COALESCE(written_off,0)),0) t FROM orders WHERE paid + COALESCE(written_off,0) < price AND substr(created_at,1,10) <= ?").bind(dayAgo(30)).first()
    const due = await db.prepare("SELECT COUNT(*) n, COALESCE(SUM(price - paid - COALESCE(written_off,0)),0) t FROM orders WHERE paid + COALESCE(written_off,0) < price AND due_date IS NOT NULL AND due_date <> '' AND substr(due_date,1,10) BETWEEN ? AND ?").bind(today, dayAfter(7)).first()
    const add = await db.prepare('SELECT COUNT(*) n, COALESCE(SUM(price),0) t FROM orders WHERE month=?').bind(m).first()
    const got = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE direction='in' AND ref_type='order' AND substr(created_at,1,7)=?").bind(m).first()
    const top = (await db.prepare('SELECT customer name, COALESCE(SUM(price - paid - COALESCE(written_off,0)),0) t FROM orders WHERE paid + COALESCE(written_off,0) < price GROUP BY customer ORDER BY t DESC LIMIT 3').all()).results
    return c.json({
      type, open_amount: round2(num(open.t)), open_count: num(open.n),
      overdue_amount: round2(num(over.t)), overdue_count: num(over.n),
      due_amount: round2(num(due.t)), due_count: num(due.n),
      month_new: round2(num(add.t)), month_new_count: num(add.n), month_settled: round2(num(got.t)),
      top: top.map((x) => ({ name: x.name, amount: round2(num(x.t)) }))
    })
  }
  const open = await db.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount - paid - COALESCE(written_off,0)),0) t FROM payables WHERE paid + COALESCE(written_off,0) < amount').first()
  const over = await db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount - paid - COALESCE(written_off,0)),0) t FROM payables WHERE paid + COALESCE(written_off,0) < amount AND substr(created_at,1,10) <= ?").bind(dayAgo(30)).first()
  const due = await db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount - paid - COALESCE(written_off,0)),0) t FROM payables WHERE paid + COALESCE(written_off,0) < amount AND due_date IS NOT NULL AND due_date <> '' AND substr(due_date,1,10) BETWEEN ? AND ?").bind(today, dayAfter(7)).first()
  const add = await db.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount),0) t FROM payables WHERE month=?').bind(m).first()
  const paid = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE direction='out' AND ref_type='payable' AND substr(created_at,1,7)=?").bind(m).first()
  const top = (await db.prepare('SELECT supplier name, COALESCE(SUM(amount - paid - COALESCE(written_off,0)),0) t FROM payables WHERE paid + COALESCE(written_off,0) < amount GROUP BY supplier ORDER BY t DESC LIMIT 3').all()).results
  return c.json({
    type, open_amount: round2(num(open.t)), open_count: num(open.n),
    overdue_amount: round2(num(over.t)), overdue_count: num(over.n),
    due_amount: round2(num(due.t)), due_count: num(due.n),
    month_new: round2(num(add.t)), month_new_count: num(add.n), month_settled: round2(num(paid.t)),
    top: top.map((x) => ({ name: x.name, amount: round2(num(x.t)) }))
  })
})

// 单据明细：收款/付款流水 + 核销记录
// 单据上的批次号 → 这批是什么时候、从哪种方式导进来的（手工录的单返回 null）
async function importOrigin(db, batch) {
  if (!batch) return null
  const r = await db.prepare('SELECT id, type, src, cnt, total, created_at, undone FROM import_log WHERE batch=?').bind(String(batch)).first()
  if (!r) return { batch: String(batch), missing: true }
  return { batch: String(batch), log_id: r.id, type: r.type, src: r.src || '', cnt: num(r.cnt), total: round2(num(r.total)), at: String(r.created_at || '').replace('T', ' ').slice(0, 16), undone: num(r.undone) }
}

// 某张单的修改痕迹（谁在什么时候把什么改成了什么）
const editHistory = async (db, type, id) => {
  try {
    const { results } = await db.prepare("SELECT action, detail, created_at FROM audit_log WHERE ref_type=? AND ref_id=? ORDER BY id DESC LIMIT 10")
      .bind(type, String(id)).all()
    return (results || []).map((x) => ({ date: (x.created_at || '').slice(0, 16).replace('T', ' '), action: x.action, detail: x.detail || '' }))
  } catch (e) { return [] }
}

app.get('/orders/:id/detail', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const o = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first()
  if (!o) return c.json({ error: '订单不存在' }, 404)
  const accs = (await db.prepare('SELECT id,name FROM accounts').all()).results
  const accName = (aid) => (accs.find((a) => num(a.id) === num(aid)) || {}).name || '默认'
  const pays = (await db.prepare("SELECT * FROM ledger WHERE ref_type='order' AND ref_id=? ORDER BY created_at, id").bind(id).all()).results
  const wos = (await db.prepare("SELECT * FROM writeoffs WHERE ref_type='order' AND ref_id=? ORDER BY id").bind(id).all()).results
  return c.json({
    ...fmtOrder(o),
    payments: pays.map((x) => ({
      id: x.id, date: (x.created_at || '').slice(0, 10), amount: round2(num(x.amount)),
      account: x.cash === 0 ? '预收抵扣' : accName(x.account_id),
      cash: num(x.cash), remark: x.remark || ''
    })),
    import_origin: await importOrigin(db, o.import_batch),
    edits: await editHistory(db, 'order', id),
    writeoffs: wos.map((x) => ({ id: x.id, amount: round2(num(x.amount)), reason: x.reason || '', date: (x.created_at || '').slice(0, 10) }))
  })
})

app.get('/payables/:id/detail', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const p = await db.prepare('SELECT * FROM payables WHERE id=?').bind(id).first()
  if (!p) return c.json({ error: '应付单不存在' }, 404)
  const accs = (await db.prepare('SELECT id,name FROM accounts').all()).results
  const accName = (aid) => (accs.find((a) => num(a.id) === num(aid)) || {}).name || '默认'
  const pays = (await db.prepare("SELECT * FROM ledger WHERE ref_type='payable' AND ref_id=? ORDER BY created_at, id").bind(id).all()).results
  const wos = (await db.prepare("SELECT * FROM writeoffs WHERE ref_type='payable' AND ref_id=? ORDER BY id").bind(id).all()).results
  return c.json({
    ...fmtPayable(p),
    import_origin: await importOrigin(db, p.import_batch),
    edits: await editHistory(db, 'payable', id),
    payments: pays.map((x) => ({
      id: x.id, date: (x.created_at || '').slice(0, 10), amount: round2(num(x.amount)),
      account: x.cash === 0 ? '预付抵扣' : accName(x.account_id),
      cash: num(x.cash), remark: x.remark || ''
    })),
    writeoffs: wos.map((x) => ({ id: x.id, amount: round2(num(x.amount)), reason: x.reason || '', date: (x.created_at || '').slice(0, 10) }))
  })
})

// 应付：应付单列表
app.get('/ap', async (c) => {
  const db = c.env.DB
  const { off, lim } = pageArgs(c)
  const { status, orderBy, kw } = listOpts(c)
  const conds = []
  const b = []
  if (status === 'closed') conds.push('paid + COALESCE(written_off,0) >= amount')
  else if (status === 'all') conds.push('1=1')
  else conds.push('paid + COALESCE(written_off,0) < amount')
  const selfAp = await selfOnly(c)
  if (selfAp.on) { conds.push('created_by = ?'); b.push(selfAp.who) }
  const scAp = await scopeOwn(c)
  if (scAp.on) { conds.push('supplier IN (SELECT party FROM party_staff WHERE staff = ?)'); b.push(scAp.name) }
  if (status === 'overdue') { conds.push('substr(created_at,1,10) <= ?'); b.push(dayAgo(30)) }
  if (status === 'due') {
    conds.push("due_date IS NOT NULL AND due_date <> '' AND substr(due_date,1,10) <= ?"); b.push(dayAfter(7))
  }
  if (kw) {
    conds.push("(supplier LIKE ? OR COALESCE(remark,'') LIKE ? OR COALESCE(operator,'') LIKE ?)")
    b.push('%' + kw + '%', '%' + kw + '%', '%' + kw + '%')
  }
  const payExpr = '(amount - paid - COALESCE(written_off,0))'
  const { results } = await db.prepare(`SELECT * FROM payables WHERE ${conds.join(' AND ')} ORDER BY ${orderBy.replace('{A}', payExpr)} LIMIT ? OFFSET ?`)
    .bind(...b, lim, off).all()
  return c.json(results.map(fmtPayable))
})

// 按客户/供应商分组（应收应付分组视图）
app.get('/party-groups', async (c) => {
  const db = c.env.DB
  const sp = new URL(c.req.url).searchParams
  const type = sp.get('type') === 'ap' ? 'ap' : 'ar'
  const status = ['open', 'overdue', 'due', 'all', 'closed'].includes(sp.get('status')) ? sp.get('status') : 'open'
  const kw = (sp.get('kw') || '').trim()
  const today = dayStr(new Date())
  const d7 = dayAfter(7)
  const isAr = type === 'ar'
  const T = isAr ? 'orders' : 'payables'
  const NAME = isAr ? 'customer' : 'supplier'
  const AMT = isAr ? 'price' : 'amount'
  const conds = ['COALESCE(paid,0)+COALESCE(written_off,0) < ' + AMT]
  const binds = []
  if (status === 'closed') {
    conds[0] = 'COALESCE(paid,0)+COALESCE(written_off,0) >= ' + AMT
  } else if (status === 'overdue') {
    conds.push("date(created_at) <= date('" + dayAgo(30) + "')")
  } else if (status === 'due') {
    conds.push("due_date IS NOT NULL AND due_date != '' AND date(due_date) >= date('" + today + "') AND date(due_date) <= date('" + d7 + "')")
  }
  if (kw) { conds.push(NAME + " LIKE ?"); binds.push('%' + kw + '%') }
  const scG = await scopeOwn(c)
  if (scG.on) { conds.push(NAME + ' IN (SELECT party FROM party_staff WHERE staff = ?)'); binds.push(scG.name) }
  const AMTEXP = '(COALESCE(' + AMT + ',0) - COALESCE(paid,0) - COALESCE(written_off,0))'
  const AGE = "CAST(julianday('now') - julianday(substr(created_at,1,10)) AS INTEGER)"
  const sql = 'SELECT ' + NAME + ' AS name, COUNT(*) AS cnt, SUM(' + AMTEXP + ') AS unpaid, MAX(' + AGE + ') AS oldest_days, ' +
    "SUM(CASE WHEN substr(COALESCE(due_date,''),1,10) >= ? AND substr(COALESCE(due_date,''),1,10) <= ? THEN 1 ELSE 0 END) AS due_soon, " +
    'SUM(CASE WHEN ' + AGE + ' > 30 THEN 1 ELSE 0 END) AS overdue ' +
    'FROM ' + T + ' WHERE ' + conds.join(' AND ') + ' GROUP BY ' + NAME + ' ORDER BY unpaid DESC'
  let rows = []
  try { rows = (await db.prepare(sql).bind(today, d7, ...binds).all()).results || [] } catch (e) { rows = [] }
  const groups = rows.map((r) => ({ name: (r.name || '未填写') + '', unpaid: round2(num(r.unpaid)), cnt: num(r.cnt), oldest_days: num(r.oldest_days), due_soon: num(r.due_soon), overdue: num(r.overdue), items: [], items_total: num(r.cnt) }))
  return c.json({ type, count: groups.length, lazy: true, groups })
})

// 某一家未结的单（分组视图点开时才取）
app.get('/party-items', async (c) => {
  const db = c.env.DB
  const sp = new URL(c.req.url).searchParams
  const isAr = sp.get('type') !== 'ap'
  const party = (sp.get('party') || '').trim()
  if (!party) return c.json({ ok: false, error: '没说是哪一家' })
  const lim = Math.min(200, Math.max(1, Math.round(Number(sp.get('limit')) || 100)))
  const T = isAr ? 'orders' : 'payables'
  const NAME = isAr ? 'customer' : 'supplier'
  const AMT = isAr ? 'price' : 'amount'
  const rs = (await db.prepare(
    'SELECT * FROM ' + T + ' WHERE ' + NAME + '=? AND COALESCE(paid,0)+COALESCE(written_off,0) < ' + AMT +
    ' ORDER BY created_at ASC, id ASC LIMIT ?').bind(party, lim).all()).results || []
  const items = rs.map((r) => {
    const it = isAr ? fmtOrder(r) : fmtPayable(r)
    return { id: it.id, unpaid: it.unpaid, days: it.days, due_short: it.due_short, created_at: it.created_at,
      title: isAr ? (it.item_name || '加工') : (it.remark || '采购'), total: isAr ? num(it.price) : num(it.amount),
      paid: num(it.paid), written_off: it.written_off, operator: it.operator || '' }
  })
  return c.json({ ok: true, party, count: items.length, more: rs.length >= lim, items })
})

// 支出流水
app.get('/expenses', async (c) => {
  const db = c.env.DB
  const { off, lim } = pageArgs(c)
  const kw = (new URL(c.req.url).searchParams.get('kw') || '').trim()
  let rows
  if (kw) {
    const like = '%' + kw + '%'
    rows = await db.prepare("SELECT * FROM ledger WHERE direction='out' AND ref_type NOT IN ('loan','transfer') AND (COALESCE(remark,'') LIKE ? OR COALESCE(category,'') LIKE ? OR COALESCE(operator,'') LIKE ?) ORDER BY id DESC LIMIT ? OFFSET ?")
      .bind(like, like, like, lim, off).all()
  } else {
    rows = await db.prepare("SELECT * FROM ledger WHERE direction='out' AND ref_type NOT IN ('loan','transfer') ORDER BY id DESC LIMIT ? OFFSET ?").bind(lim, off).all()
  }
  return c.json(rows.results)
})

// 记应收（加工订单）
// 记完自查：录单/收款后立刻挑出「一看就可能错」的地方（只提醒，不拦）
function lev(a, b) {
  a = String(a || ''); b = String(b || '')
  if (Math.abs(a.length - b.length) > 1) return 9
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, (_, i) => [i].concat(new Array(n).fill(0)))
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  }
  return dp[m][n]
}
// ===== 信用打分（creditBook 与账期建议共用同一套规则）=====
function gradeCalc(x) {
  const why = []
  let score = 100
  const broken = num(x && x.broken), done = num(x && x.done), rate = (x && x.rate != null) ? num(x.rate) : null
  if (broken) { score -= Math.min(50, broken * 25); why.push(`答应付款失约 ${broken} 次`) }
  if (rate != null && rate < 50 && done >= 2) { score -= 10; why.push(`答应的事只兑现 ${rate}%`) }
  if (num(x && x.oldest) > 60) { score -= 10; why.push(`最老一笔欠了 ${num(x.oldest)} 天`) }
  if (num(x && x.over90) > 0.005) { score -= 10; why.push(`超 90 天未结 ¥${round2(num(x.over90))}`) }
  if (num(x && x.doubt) > 0) { score -= 10; why.push(`${num(x.doubt)} 份对账单对方说对不上`) }
  score = Math.max(0, Math.min(100, score))
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D'
  return { score, grade, why }
}

// 单家轻量档位（只查两次，建单时算账期用，不加载流水）
async function gradeLight(db, party, type) {
  const isAr = type !== 'ap'
  const tbl = isAr ? 'orders' : 'payables'
  const who = isAr ? 'customer' : 'supplier'
  const amt = isAr ? 'price' : 'amount'
  const OPEN = `${amt}-COALESCE(paid,0)-COALESCE(written_off,0)`
  const p = String(party || '').trim()
  if (!p) return { grade: 'N', score: 100, why: [] }
  const [br, op] = await Promise.all([
    db.prepare("SELECT COUNT(*) n FROM dunning_log WHERE party=? AND promise_date IS NOT NULL AND substr(promise_date,1,10) < ?").bind(p, todayIso()).first().catch(() => null),
    db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(${OPEN}),0) s, MIN(CASE WHEN ${OPEN}>0.005 THEN substr(created_at,1,10) END) d FROM ${tbl} WHERE ${who}=?`).bind(p).first().catch(() => null)
  ])
  if (!op || !num(op.n)) return { grade: 'N', score: 100, why: [] }
  const oldest = op.d ? daysSince(op.d) : 0
  const over90 = 0
  const g = gradeCalc({ broken: num(br && br.n), oldest, over90 })
  return { grade: g.grade, score: g.score, why: g.why }
}

// ===== 客户/供应商信用分档：失约几次、欠多久、有没有争议 =====
async function creditBook(db, type) {
  const isAr = type !== 'ap'
  const tbl = isAr ? 'orders' : 'payables'
  const who = isAr ? 'customer' : 'supplier'
  const amt = isAr ? 'price' : 'amount'
  const OPEN = `${amt}-COALESCE(paid,0)-COALESCE(written_off,0)`
  const agg = (await db.prepare(`SELECT ${who} AS party, COUNT(*) n, COALESCE(SUM(${amt}),0) total,
    COALESCE(SUM(CASE WHEN ${OPEN}>0.005 THEN ${OPEN} ELSE 0 END),0) unpaid,
    MIN(substr(created_at,1,10)) first_day,
    MIN(CASE WHEN ${OPEN}>0.005 THEN substr(created_at,1,10) END) oldest_open
    FROM ${tbl} GROUP BY ${who}`).all().catch(() => ({ results: [] }))).results || []
  const old = (await db.prepare(`SELECT ${who} AS party, COALESCE(SUM(${OPEN}),0) s FROM ${tbl}
    WHERE ${OPEN}>0.005 AND substr(created_at,1,10)<? GROUP BY ${who}`).bind(dayAgo(90)).all().catch(() => ({ results: [] }))).results || []
  const disp = (await db.prepare("SELECT party, COUNT(*) n FROM statement_log WHERE ack='doubt' AND COALESCE(resolved_at,'')='' GROUP BY party").all().catch(() => ({ results: [] }))).results || []
  const pb = await promiseBook(db, 365, type).catch(() => ({ parties: [] }))
  const om = {}, dm = {}, pm = {}
  old.forEach((r) => { om[norm(r.party)] = round2(num(r.s)) })
  disp.forEach((r) => { dm[norm(r.party)] = num(r.n) })
  ;(pb.parties || []).forEach((r) => { pm[norm(r.party)] = r })
  const rows = agg.map((r) => {
    const k = norm(r.party)
    const p = pm[k] || null
    const unpaid = round2(num(r.unpaid))
    const oldest = r.oldest_open ? daysSince(r.oldest_open) : 0
    const over90 = round2(num(om[k]))
    const doubt = num(dm[k])
    const kept = p ? num(p.kept) : 0
    const broken = p ? num(p.broken) : 0
    const done = kept + broken
    const rate = done ? Math.round((kept / done) * 100) : null
    const gc = gradeCalc({ broken, done, rate, oldest, over90, doubt })
    const score = gc.score, grade = gc.grade, why = gc.why
    const label = { A: '可以放心', B: '正常', C: '要盯一下', D: '只做现款' }[grade]
    const advice = grade === 'A'
      ? '老客户，偶尔晚几天不用紧张'
      : grade === 'B'
        ? (isAr ? '正常合作；超过 30 天没付就催一次' : '正常合作，按约定日子付款就行')
        : grade === 'C'
          ? (isAr ? '下次接单先收 30% 定金；把付款日期写进备注；别再加大额度' : '付款前先确认账上有没有这笔；别拖过约定日子')
          : (isAr ? '只做现款（做完就结）；要接大单先收一半；旧账结清再谈账期' : '先付清旧账再下新单')
    return {
      party: r.party || '', grade, label, score, advice,
      cnt: num(r.n), total: round2(num(r.total)), unpaid, oldest_days: oldest, over90,
      first_day: String(r.first_day || '').slice(0, 10),
      promises: p ? num(p.promises) : 0, kept, broken, rate,
      last_broken: p ? String(p.last_broken || '') : '', doubt,
      why: why.length ? why.join('、') : '没有不良记录',
      bar: Math.max(4, Math.min(100, score))
    }
  })
  rows.sort((a, b) => a.score - b.score || b.unpaid - a.unpaid)
  const by = { A: 0, B: 0, C: 0, D: 0 }
  rows.forEach((r) => { by[r.grade]++ })
  const bad = rows.filter((r) => r.grade === 'C' || r.grade === 'D')
  const text = !rows.length
    ? `还没有${isAr ? '客户' : '供应商'}记录，记几笔单之后这里会自动分档。`
    : bad.length
      ? `${isAr ? '客户' : '供应商'}里 ${bad.length} 家要盯（${bad.map((r) => r.party + ' ' + r.grade).join('、')}）${isAr ? '，合计还欠 ¥' + round2(bad.reduce((a, r) => a + r.unpaid, 0)) : ''}。`
      : `${rows.length} 家${isAr ? '客户' : '供应商'}都没有失约记录，信用都不错。`
  return { ok: true, type: isAr ? 'ar' : 'ap', rows, count: rows.length, by, bad_count: bad.length, text }
}

app.get('/credit-book', async (c) => {
  const type = c.req.query('type') === 'ap' ? 'ap' : 'ar'
  return c.json(await creditBook(c.env.DB, type))
})

app.get('/credit-grade', async (c) => {
  const db = c.env.DB
  const type = c.req.query('type') === 'ap' ? 'ap' : 'ar'
  const party = String(c.req.query('party') || '').trim()
  if (!party) return c.json({ error: '要指定单位名' }, 400)
  const all = await creditBook(db, type)
  const hit = all.rows.find((r) => norm(r.party) === norm(party))
  if (!hit) return c.json({ ok: true, party, found: false, grade: 'N', label: '新单位', score: 100,
    advice: '第一次合作：建议先收定金或做现款，账期等做过一两次再给。',
    text: `${party} 之前没有记录，是新单位。建议先收定金或做现款。` })
  return c.json({ ok: true, party: hit.party, found: true, ...hit,
    text: `${hit.party}：信用 ${hit.grade}（${hit.label}，${hit.score} 分）。${hit.why}。${hit.advice}。` })
})

async function orderChecks(db, o) {
  const out = []
  const amt = num(o.amount), c = num(o.cost)
  const day = String(o.created || '').slice(0, 10)
  const due = String(o.due || '').slice(0, 10)
  if (due && day && due < day) out.push({ k: 'due_early', text: `约定日期（${due}）比开单日（${day}）还早，是不是年份填错了？` })
  if (due && day && (Date.parse(due) - Date.parse(day)) > 400 * 86400000) out.push({ k: 'due_far', text: '约定日期在一年多以后，确认没有填错？' })
  if (c > 0 && c >= amt) out.push({ k: 'cost_high', text: `成本 ¥${c} 不比金额 ¥${amt} 低，这单不赚钱甚至倒贴，确认一下。` })
  if (o.party && day) {
    const dup = await db.prepare('SELECT id FROM ' + o.table + ' WHERE ' + o.who + '=? AND substr(created_at,1,10)=? AND ' + o.amtcol + '=? AND COALESCE(' + o.itemcol + ",'')=?").bind(o.party, day, amt, o.item || '').first()
    if (dup) out.push({ k: 'dup', text: `${o.party} 今天已经有一张一样的「${o.item || '同项'} ¥${amt}」，是不是重复记了？` })
    const { results: names } = await db.prepare('SELECT DISTINCT ' + o.who + ' AS party FROM ' + o.table + ' LIMIT 300').all()
    for (const r of names) {
      const n = String(r.party || '')
      const p0 = String(o.party)
      let pre = 0
      while (pre < Math.min(n.length, p0.length) && n[pre] === p0[pre]) pre++
      const likely = n.length === p0.length && lev(n, p0) === 1 && (pre >= 2 || p0.length >= 4)
      if (n && n !== p0 && likely) {
        out.push({ k: 'typo', text: `「${o.party}」和已有的「${n}」只差一个字，是不是打错了？（打错会当成两家，欠款就分开了）` })
        break
      }
    }
    if (o.table === 'orders') {
      const br = await db.prepare("SELECT COUNT(*) n FROM dunning_log WHERE party=? AND promise_date IS NOT NULL AND substr(promise_date,1,10) < ?").bind(o.party, todayIso()).first().catch(() => null)
      const op = await db.prepare('SELECT COALESCE(SUM(price-COALESCE(paid,0)-COALESCE(written_off,0)),0) s, MIN(CASE WHEN price-COALESCE(paid,0)-COALESCE(written_off,0)>0.005 THEN substr(created_at,1,10) END) d FROM orders WHERE customer=?').bind(o.party).first().catch(() => null)
      const bn = num(br && br.n), left = round2(num(op && op.s))
      const od = op && op.d ? daysSince(op.d) : 0
      if (bn >= 3 && left > 0.005) out.push({ k: 'credit_bad', text: `${o.party} 答应付款失约 ${bn} 次，现在还有 ¥${left} 没收回来。这单建议只做现款，或者先收一半定金。` })
      else if (bn >= 1 && left > 0.005 && od >= 30) out.push({ k: 'credit_watch', text: `${o.party} 答应付款失约 ${bn} 次，还欠 ¥${left}（最老 ${od} 天）。这单建议先收一部分定金。` })
    }
    const mx = await db.prepare('SELECT COALESCE(MAX(' + o.amtcol + '),0) AS mx FROM ' + o.table + ' WHERE substr(created_at,1,10)>=?').bind(dayAgo(90)).first()
    const m = num(mx && mx.mx)
    if (m > 0 && amt > m * 5 && amt > 20000) out.push({ k: 'big', text: `这一笔 ¥${amt}，比近 90 天最大的一笔（¥${m}）大 5 倍以上，确认没多打一个 0？` })
    else if (m === 0 && amt >= 50000) out.push({ k: 'big', text: `这一笔 ¥${amt}，是第一次记这么大的数，确认没多打一个 0？` })
  }
  if (o.table === 'orders' && o.party && amt > 0) {
    const fr = await frameOf(db, o.party, o.item || '', day || todayIso())
    if (fr && num(fr.price) > 0 && amt < num(fr.price) - 0.005) {
      out.push({ k: 'below_frame', text: `和 ${o.party} 约定的框架价是 ¥${round2(num(fr.price))}${fr.item ? '（' + fr.item + '）' : ''}，这单 ¥${amt} 低了 ¥${round2(num(fr.price) - amt)}。是打折还是填错了？` })
    }
  }
  return out
}

// ===== 报价单：先报个价，客户点头再转成单子 =====
const Q_ST = { draft: '草稿', sent: '已发出', accepted: '客户接受了', rejected: '客户没接受', expired: '过期了', ordered: '已转成单子' }
function qPrice(cost, margin) {
  const c = num(cost), m = Math.min(95, Math.max(0, num(margin)))
  return round2(c / (1 - m / 100))
}
function qMargin(price, cost) {
  const p = num(price), c = num(cost)
  return p > 0 ? round2((p - c) / p * 100) : 0
}
const qAddDays = (iso, n) => new Date(dateNum(iso) + n * 86400000).toISOString().slice(0, 10)
function qDaysLeft(r) {
  const base = String(r.sent_at || r.created_at || '').slice(0, 10)
  if (!base) return 0
  const vd = num(r.valid_days) || 15
  const exp = qAddDays(base, vd)
  return Math.round((dateNum(exp) - dateNum(todayIso())) / 86400000)
}
function qState(r) {
  const st = String(r.status || 'draft')
  if (st === 'sent' && qDaysLeft(r) < 0) return 'expired'
  return st
}
function qSlim(r) {
  const st = qState(r)
  return {
    id: r.id, no: r.no, party: r.party, item: r.item, qty: num(r.qty) || 1,
    price: round2(num(r.price)), cost: round2(num(r.cost)), margin: qMargin(r.price, r.cost),
    amount: round2(num(r.price) * (num(r.qty) || 1)),
    note: r.note || '', valid_days: num(r.valid_days) || 15, status: st, status_text: Q_ST[st] || st,
    days_left: qDaysLeft(r), created_at: String(r.created_at || '').slice(0, 10),
    sent_at: String(r.sent_at || '').slice(0, 10), decided_at: String(r.decided_at || '').slice(0, 10),
    order_id: num(r.order_id) || 0
  }
}
async function qGet(db, id) {
  const r = await db.prepare('SELECT * FROM quotes WHERE id=?').bind(num(id)).first()
  return r || null
}

// 报多少合适：按成本 + 想赚的毛利算，再对照这家以前给过什么价
app.get('/quote-hint', async (c) => {
  const db = c.env.DB
  const party = String(c.req.query('party') || '').trim()
  const item = String(c.req.query('item') || '').trim()
  const cost = num(c.req.query('cost'))
  const margin = num(c.req.query('margin')) || 15
  let hist = { cnt: 0 }
  if (party) {
    const h = await db.prepare(`SELECT COUNT(*) cnt, MAX(price) mx, MIN(price) mn, AVG(price) av,
      (SELECT price FROM orders WHERE customer=? AND (?='' OR item_name=?) ORDER BY id DESC LIMIT 1) last_price,
      (SELECT COALESCE(cost,0) FROM orders WHERE customer=? AND (?='' OR item_name=?) ORDER BY id DESC LIMIT 1) last_cost,
      (SELECT substr(created_at,1,10) FROM orders WHERE customer=? AND (?='' OR item_name=?) ORDER BY id DESC LIMIT 1) last_date
      FROM orders WHERE customer=? AND (?='' OR item_name=?)`).bind(party, item, item, party, item, item, party, item, item, party, item, item).first().catch((e) => { noteFail(e, '报价参考'); return null })
    if (h && num(h.cnt) > 0) hist = { cnt: num(h.cnt), max: round2(num(h.mx)), min: round2(num(h.mn)), avg: round2(num(h.av)), last_price: round2(num(h.last_price)), last_cost: round2(num(h.last_cost)), last_date: String(h.last_date || '').slice(0, 10) }
  }
  const tiers = []
  if (cost > 0) {
    tiers.push({ k: 'floor', label: '保本价（一分不赚）', price: round2(cost), profit: 0, margin: 0 })
    tiers.push({ k: 'target', label: `目标价（赚 ${margin}%）`, price: qPrice(cost, margin), profit: round2(qPrice(cost, margin) - cost), margin: round2(margin) })
    tiers.push({ k: 'fat', label: `多赚点（赚 ${Math.min(95, margin + 10)}%）`, price: qPrice(cost, margin + 10), profit: round2(qPrice(cost, margin + 10) - cost), margin: round2(Math.min(95, margin + 10)) })
  }
  const tips = []
  if (hist.cnt && hist.avg) {
    tips.push(`这家以前做过 ${hist.cnt} 次${item ? '「' + item + '」' : ''}，均价 ${hist.avg} 元，上次 ${hist.last_price} 元（${hist.last_date}）`)
    const t = qPrice(cost, margin)
    if (cost > 0 && t > hist.avg * 1.2) tips.push(`按成本算要报到 ${t} 元，比以前的均价高不少，对方可能会觉得涨了`)
    if (cost > 0 && hist.avg > 0 && (hist.avg - cost) / hist.avg * 100 < 10) tips.push(`以前那个价几乎不赚钱（毛利 ${round2((hist.avg - cost) / hist.avg * 100)}%），这次该提一提`)
  } else if (cost > 0) {
    tips.push('这家第一次做这个活，没有历史价参考，按成本加毛利报就行')
  }
  return c.json({
    ok: true, party, item, cost: round2(cost), margin: round2(margin), tiers, hist,
    suggest: cost > 0 ? qPrice(cost, margin) : (hist.last_price || 0), tips,
    text: [party ? `给 ${party} 报价${item ? '「' + item + '」' : ''}：` : '报价参考：']
      .concat(tiers.map((t) => `${t.label} ${t.price} 元`)).concat(tips).join('\n')
  })
})

app.post('/quotes', async (c) => {
  const db = c.env.DB
  const b = await c.req.json().catch(() => ({}))
  const party = String(b.party || '').trim()
  if (!party) return c.json({ error: '要写清楚报给谁' }, 400)
  const cost = round2(num(b.cost))
  let price = round2(num(b.price))
  const margin = num(b.margin)
  if (price <= 0 && cost > 0) price = qPrice(cost, margin || 15)
  if (price <= 0) return c.json({ error: '单价要大于 0（填成本 + 想赚多少也行）' }, 400)
  const created = now()
  const r = await db.prepare('INSERT INTO quotes (party,item,qty,price,cost,margin,note,valid_days,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(party, String(b.item || '').slice(0, 60), num(b.qty) || 1, price, cost, qMargin(price, cost), String(b.note || '').slice(0, 200), Math.min(180, Math.max(1, num(b.valid_days) || 15)), 'draft', created).run()
  const id = num(r.meta && r.meta.last_row_id)
  const no = 'Q' + created.slice(2, 10).replace(/-/g, '') + '-' + String(id).padStart(3, '0')
  await db.prepare('UPDATE quotes SET no=? WHERE id=?').bind(no, id).run()
  await logAudit(db, '新增报价', party, `${party} ${b.item || ''} ¥${price}`, '', act(c))
  return c.json({ ok: true, id, no, price, margin: qMargin(price, cost) })
})

app.get('/quotes', async (c) => {
  const db = c.env.DB
  const st = String(c.req.query('status') || '')
  const party = String(c.req.query('party') || '').trim()
  const lim = Math.min(300, Math.max(1, Math.round(Number(c.req.query('limit')) || 100)))
  let sql = 'SELECT * FROM quotes WHERE 1=1'
  const binds = []
  if (party) { sql += ' AND party=?'; binds.push(party) }
  sql += ' ORDER BY id DESC LIMIT 300'
  const rows = ((await db.prepare(sql).bind(...binds).all().catch((e) => { noteFail(e, '报价列表'); return { results: [] } })).results || []).map(qSlim)
  const all = rows
  const by = { draft: 0, sent: 0, accepted: 0, rejected: 0, expired: 0, ordered: 0 }
  for (const r of all) by[r.status] = (by[r.status] || 0) + 1
  const shown = st ? all.filter((r) => r.status === st) : all
  const sentN = by.sent + by.accepted + by.rejected + by.expired + by.ordered
  const okN = by.accepted + by.ordered
  return c.json({
    ok: true, status: st, party, count: shown.length, rows: shown.slice(0, lim),
    by, sent_n: sentN, accepted_n: okN, rate: sentN ? Math.round(okN * 100 / sentN) : 0,
    amount_open: round2(shown.filter((r) => r.status === 'sent' || r.status === 'accepted').reduce((a, r) => a + r.amount, 0)),
    text: !all.length ? '还没有报价单。先给客户报个价，他点头了再转成单子，省得白干。'
      : `共 ${all.length} 份报价：草稿 ${by.draft}、等回复 ${by.sent}、接受 ${okN}、没接受 ${by.rejected}、过期 ${by.expired}${sentN ? `（接受率 ${Math.round(okN * 100 / sentN)}%）` : ''}`
  })
})

app.get('/quotes/:id', async (c) => {
  const db = c.env.DB
  const r = await qGet(db, c.req.param('id'))
  if (!r) return c.json({ error: '报价单不存在' }, 404)
  return c.json({ ok: true, quote: qSlim(r) })
})

app.patch('/quotes/:id', async (c) => {
  const db = c.env.DB
  const id = num(c.req.param('id'))
  const r = await qGet(db, id)
  if (!r) return c.json({ error: '报价单不存在' }, 404)
  if (qState(r) !== 'draft') return c.json({ error: '已经发出去的报价不能改，另开一份' }, 400)
  const b = await c.req.json().catch(() => ({}))
  const price = b.price === undefined ? round2(num(r.price)) : round2(num(b.price))
  const cost = b.cost === undefined ? round2(num(r.cost)) : round2(num(b.cost))
  await db.prepare('UPDATE quotes SET party=?,item=?,qty=?,price=?,cost=?,margin=?,note=?,valid_days=? WHERE id=?')
    .bind(b.party === undefined ? r.party : String(b.party).trim(), b.item === undefined ? r.item : String(b.item).slice(0, 60),
      b.qty === undefined ? num(r.qty) || 1 : (num(b.qty) || 1), price, cost, qMargin(price, cost),
      b.note === undefined ? r.note : String(b.note).slice(0, 200),
      b.valid_days === undefined ? num(r.valid_days) || 15 : Math.min(180, Math.max(1, num(b.valid_days))), id).run()
  return c.json({ ok: true })
})

app.delete('/quotes/:id', async (c) => {
  const db = c.env.DB
  const id = num(c.req.param('id'))
  const r = await qGet(db, id)
  if (!r) return c.json({ error: '报价单不存在' }, 404)
  if (qState(r) !== 'draft') return c.json({ error: '发出去的报价留着当记录，不能删' }, 400)
  await db.prepare('DELETE FROM quotes WHERE id=?').bind(id).run()
  return c.json({ ok: true })
})

// 发出去：给一个免口令的客户页 + 一段现成的微信话术
app.post('/quotes/:id/send', async (c) => {
  const db = c.env.DB
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const id = num(c.req.param('id'))
  const r = await qGet(db, id)
  if (!r) return c.json({ error: '报价单不存在' }, 404)
  const saved = await getKey(mainDb)
  const t = saved ? await sigOf(saved, 'quote', 'q:' + id) : ''
  const at = now()
  await db.prepare("UPDATE quotes SET status='sent', token=?, sent_at=? WHERE id=?").bind(t, at, id).run()
  const base = c.req.url.split('/quotes/')[0]
  const q = qSlim(Object.assign({}, r, { status: 'sent', sent_at: at }))
  const text = [`${q.party}，${q.item || '这个活'}的报价：${q.amount} 元（${q.qty > 1 ? q.qty + ' × ' + q.price + ' 元，' : ''}含税不含运费），报价 ${q.valid_days} 天内有效。`,
    '您点开看一眼，行就说一声，我这边排产：' + (t ? `${base}/quote-print?id=${id}&t=${t}` : '（链接生成失败，请在电脑上重试）')].join('\n')
  await logAudit(db, '发报价', q.party, `${q.no || ''} ${q.party} ¥${q.amount}`, '', act(c))
  return c.json({ ok: true, url: t ? `${base}/quote-print?id=${id}&t=${t}` : '', text, quote: q })
})

app.get('/quote-print', async (c) => {
  const db = c.env.DB
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  const id = num(c.req.query('id'))
  const want = String(c.req.query('t') || '')
  const good = saved && id ? await sigOf(saved, 'quote', 'q:' + id) : ''
  if (!good || want !== good) return c.html('<h3>链接已失效：请让对方重新发一次报价。</h3>')
  const r = await qGet(db, id)
  if (!r) return c.html('<h3>这份报价已经不在了。</h3>')
  const t = await getTitle(db)
  const q = qSlim(r)
  const body = `<h1>报 价 单</h1><div class="sub">${escHtml(t.title || '')}${t.phone ? ' · ' + escHtml(t.phone) : ''}${t.addr ? ' · ' + escHtml(t.addr) : ''}</div>
<table class="meta"><tr><td>客户：${escHtml(q.party)}</td><td class="n">编号：${escHtml(q.no || '')}</td></tr>
<tr><td>日期：${escHtml(q.created_at)}</td><td class="n">有效期：${q.valid_days} 天（到 ${escHtml(qAddDays(q.created_at, q.valid_days))}）</td></tr></table>
<table><tr><th>项目</th><th class="n">数量</th><th class="n">单价（元）</th><th class="n">金额（元）</th></tr>
<tr><td>${escHtml(q.item || '加工费')}</td><td class="n">${q.qty}</td><td class="n">${q.price}</td><td class="n">${q.amount}</td></tr>
<tr class="total"><td>合计</td><td class="n"></td><td class="n"></td><td class="n">${q.amount}</td></tr></table>
${q.note ? `<h2>说明</h2><div class="sub" style="text-align:left">${escHtml(q.note)}</div>` : ''}
<h2>请确认</h2><div class="pick"><button class="ok" onclick="decide(1)">✓ 这个价可以，按这个做</button><button class="no" onclick="decide(0)">✗ 价不合适，再谈谈</button></div>
<div class="tip2" id="tip2">点一下就行，不用打字。老板那边马上能看到。</div>
<div class="sign"><span>报价人：____________</span><span>客户确认：____________</span><span>日期：____________</span></div>
<script>
function decide(ok){
  document.querySelectorAll('.pick button').forEach(function(b){b.disabled=true});
  fetch('/quote-ack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:${q.id},t:'${want}',ok:!!ok})})
    .then(function(r){return r.json()}).then(function(d){
      document.getElementById('tip2').textContent = d.ok ? (ok?'已回复「接受」，老板会尽快跟您确认排产。':'已回复「再谈谈」，老板会联系您。') : (d.error||'没提交成功，请再点一次');
      document.getElementById('tip2').className = 'tip2 done';
    }).catch(function(){document.getElementById('tip2').textContent='网络不太好，请再点一次'});
}
</script>`
  return c.html(a4Page({
    title: `${q.party} 报价单`,
    body,
    extraCss: `.meta{font-size:12.5px} .meta td{border:0;padding:2px 0} .sub{text-align:center}
      .pick{display:flex;gap:10px;justify-content:center;margin:10px 0}
      .pick button{font-size:14px;padding:10px 18px;border-radius:8px;border:1px solid #1f6feb;background:#fff;color:#1f6feb;cursor:pointer}
      .pick button.ok{background:#1f6feb;color:#fff} .pick button.no{border-color:#999;color:#666}
      .tip2{text-align:center;font-size:12px;color:#888} .tip2.done{color:#0a7a3d;font-weight:600}`,
    sign: '',
    btn: '打印 / 存 PDF',
    tip: '这份报价由「加工厂账本」生成，金额和有效期以本页为准'
  }))
})

app.post('/quote-ack', async (c) => {
  const db = c.env.DB
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const b = await c.req.json().catch(() => ({}))
  const id = num(b.id)
  const want = String(b.t || '')
  const saved = await getKey(mainDb)
  const good = saved && id ? await sigOf(saved, 'quote', 'q:' + id) : ''
  if (!good || want !== good) return c.json({ error: '链接已失效，请让老板重发' }, 403)
  const r = await qGet(db, id)
  if (!r) return c.json({ error: '这份报价已经不在了' }, 404)
  if (r.status === 'ordered') return c.json({ ok: true, already: true })
  const ok = b.ok ? 1 : 0
  await db.prepare("UPDATE quotes SET status=?, decided_at=? WHERE id=?").bind(ok ? 'accepted' : 'rejected', now(), id).run()
  await logAudit(db, ok ? '客户接受报价' : '客户没接受报价', r.party, `${r.no || ''} ${r.party} ¥${num(r.price)}`)
  return c.json({ ok: true })
})

// 客户接受了 → 一键转成应收单（省得再录一遍）
app.post('/quotes/:id/to-order', async (c) => {
  const db = c.env.DB
  const id = num(c.req.param('id'))
  const r = await qGet(db, id)
  if (!r) return c.json({ error: '报价单不存在' }, 404)
  if (num(r.order_id)) return c.json({ error: '这份报价已经转成单子了', order_id: num(r.order_id) }, 409)
  const st = qState(r)
  if (st !== 'accepted' && st !== 'sent') return c.json({ error: `这份报价是「${Q_ST[st] || st}」，客户还没接受，先别转` }, 400)
  const created = now()
  if (await isMonthLocked(db, created.slice(0, 7))) return c.json({ error: '本月已结账锁定，先解锁再转单' }, 403)
  const qty = num(r.qty) || 1
  const total = round2(num(r.price) * qty)
  const due = await termDue(db, r.party, created, 'ar')
  const ins = await db.prepare('INSERT INTO orders (customer, item_name, price, status, paid, due_date, operator, cost, created_at) VALUES (?,?,?,0,0,?,?,?,?)')
    .bind(r.party, String(r.item || '').slice(0, 60), total, due || null, '报价转单', round2(num(r.cost) * qty), created).run()
  const oid = num(ins.meta && ins.meta.last_row_id)
  await db.prepare("UPDATE quotes SET status='ordered', order_id=? WHERE id=?").bind(oid, id).run()
  await logAudit(db, '报价转单', r.party, `${r.no || ''} ${r.party} ${r.item || ''} ¥${total}`, '', act(c))
  return c.json({ ok: true, order_id: oid, amount: total, due_date: due || null })
})

app.post('/orders', async (c) => {
  const body = await c.req.json()
  const { customer, item_name, price, due_date, operator, date, cost, deliver_date } = body
  if (!customer || num(price) <= 0) return c.json({ error: '客户和金额必填' }, 400)
  const db = c.env.DB
  const cid = String(body.client_id || '')
  if (await opSeen(db, cid)) return c.json({ ok: true, dup_ok: true })
  const created = stampOf(date)
  // 手抖/连点保护：同一客户、同一金额，2 分钟内又记一张，先问一句（不是不让记，是防重复点）
  if (!body.confirm_dup) {
    const near = await db.prepare("SELECT id, created_at FROM orders WHERE customer=? AND price=? AND created_at >= ? ORDER BY id DESC LIMIT 1")
      .bind(customer, num(price), new Date(Date.now() + TZ_MS - 120000).toISOString()).first()
    if (near) return c.json({ dup: true, code: 'dup_soon', id: near.id, error: '刚记过一张一样的：' + customer + ' ¥' + num(price) + '。是又记了一笔吗？' }, 409)
  }
  if (await isMonthLocked(db, created.slice(0, 7))) return c.json({ error: '该月份已结账锁定，先解锁再记账' }, 403)
  const due = toIsoDate(due_date) || (await termDue(db, customer, created, 'ar'))
  const checks = await orderChecks(db, { table: 'orders', who: 'customer', amtcol: 'price', itemcol: 'item_name', party: customer, item: item_name || '', amount: price, cost, created: created, due })
  await db.prepare('INSERT INTO orders (customer, item_name, price, status, paid, due_date, operator, cost, created_at, created_by, deliver_date) VALUES (?,?,?,0,0,?,?,?,?,?,?)')
    .bind(customer, item_name || '', num(price), due || null, String(operator || '').trim() || null, round2(num(cost)), created, act(c), toIsoDate(deliver_date) || null).run()
  await opMark(db, cid, 'order', 0)
  await logAudit(db, '新增应收', customer, `${customer} ${item_name || ''} ¥${num(price)}`, '', act(c))
  // 超信用额度提醒（不拦，只提醒）
  let warn = null
  const lim = await db.prepare('SELECT * FROM credit_limits WHERE party=?').bind(customer).first()
  if (lim && num(lim.limit_amount) > 0) {
    const agg = await db.prepare('SELECT SUM(MAX(0, price - paid - COALESCE(written_off,0))) AS unpaid FROM orders WHERE customer=?').bind(customer).first()
    const unpaid = round2(num(agg && agg.unpaid))
    const over = round2(unpaid - num(lim.limit_amount))
    if (over > 0) warn = { over_limit: true, party: customer, limit_amount: num(lim.limit_amount), unpaid, over, error: `提醒：${customer} 已欠 ¥${unpaid}，超信用额度 ¥${num(lim.limit_amount)}（多出 ¥${over}）` }
  }
  return c.json(Object.assign({ ok: true }, warn ? { warn } : {}, checks.length ? { checks } : {}))
})

// 收客户款（可带日期补录）
app.post('/orders/:id/receive', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const { amount, date, account_id } = body
  const db = c.env.DB
  const cid = String(body.client_id || '')
  if (await opSeen(db, cid)) return c.json({ ok: true, dup_ok: true })
  const o = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first()
  if (!o) return c.json({ error: '订单不存在' }, 404)
  if (await isMonthLocked(db, (o.created_at || '').slice(0, 7))) return c.json({ error: '该订单所在月份已结账锁定' }, 403)
  const a = num(amount)
  if (a <= 0) return c.json({ error: '金额无效' }, 400)
  const leftOrder = round2(num(o.price) - num(o.paid) - num(o.written_off))
  if (a > leftOrder + 0.005) return c.json({ error: `这单只剩 ¥${leftOrder} 没收，收不了 ¥${a}`, left: leftOrder }, 400)
  const acc = num(account_id) || (await defaultAccountId(db))
  await db.batch([
    db.prepare('UPDATE orders SET paid=paid+?, rev=COALESCE(rev,0)+1 WHERE id=?').bind(a, id),
    db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, remark, account_id, cash, created_at) VALUES ('in','order',?,?,?,?,1,?)")
      .bind(id, a, `收 ${o.customer} ${o.item_name}`, acc, normDate(date))
  ])
  await opMark(db, cid, 'receive', id)
  await logAudit(db, '收款', o.customer, `${o.customer} 收 ¥${a}`, '', act(c))
  const checks = []
  const d0 = String(normDate(date)).slice(0, 10)
  if (d0 && (o.created_at || '').slice(0, 10) && d0 < (o.created_at || '').slice(0, 10)) checks.push({ k: 'pay_early', text: `收款日期（${d0}）比开单日（${(o.created_at || '').slice(0, 10)}）还早，这单是先收钱后开单吗？不是的话改一下日期。` })
  return c.json(checks.length ? { ok: true, checks } : { ok: true })
})

// 批量核销收款：客户一次打款，按「先老后新」自动抵掉多张未结单
app.post('/receive-batch', async (c) => {
  const { customer, amount, date, remark, account_id } = await c.req.json()
  const db = c.env.DB
  const acc = num(account_id) || (await defaultAccountId(db))
  const name = String(customer || '').trim()
  let left = num(amount)
  if (!name) return c.json({ error: '请填客户名称' }, 400)
  if (left <= 0) return c.json({ error: '金额无效' }, 400)
  const { results: list } = await db.prepare(
    'SELECT * FROM orders WHERE customer=? AND paid + COALESCE(written_off,0) < price ORDER BY created_at, id'
  ).bind(name).all()
  if (!list.length) return c.json({ error: `${name} 没有未结清的应收` }, 400)
  const d = normDate(date)
  const detail = []
  let total = 0
  for (const o of list) {
    if (left <= 0) break
    const unpaid = round2(o.price - o.paid)
    if (unpaid <= 0) continue
    const use = round2(Math.min(left, unpaid))
    total += use
    left = round2(left - use)
    detail.push({ id: o.id, item: o.item_name, unpaid, use })
    await db.batch([
      db.prepare('UPDATE orders SET paid=paid+?, rev=COALESCE(rev,0)+1 WHERE id=?').bind(use, o.id),
      db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, remark, account_id, cash, created_at) VALUES ('in','order',?,?,?,?,1,?)")
        .bind(o.id, use, `收 ${name} ${o.item_name}${remark ? ' ' + remark : ''}`, acc, d)
    ])
  }
  await logAudit(db, '批量收款', name, `${name} 共收 ¥${total}，核销 ${detail.length} 张单`, '', act(c))
  return c.json({ ok: true, total: round2(total), used: detail, rest: round2(left) })
})

// 整户批量付款（应付，先老后新核销）
app.post('/pay-batch', async (c) => {
  const { supplier, amount, date, remark, account_id } = await c.req.json()
  const db = c.env.DB
  const acc = num(account_id) || (await defaultAccountId(db))
  const name = String(supplier || '').trim()
  let left = num(amount)
  if (!name) return c.json({ error: '请填供应商名称' }, 400)
  if (left <= 0) return c.json({ error: '金额无效' }, 400)
  const { results: list } = await db.prepare(
    'SELECT * FROM payables WHERE supplier=? AND paid + COALESCE(written_off,0) < amount ORDER BY created_at, id'
  ).bind(name).all()
  if (!list.length) return c.json({ error: `${name} 没有未结清的应付` }, 400)
  const d = normDate(date)
  const detail = []
  let total = 0
  for (const p of list) {
    if (left <= 0) break
    const unpaid = round2(num(p.amount) - num(p.paid) - num(p.written_off))
    if (unpaid <= 0) continue
    const use = round2(Math.min(left, unpaid))
    total += use
    left = round2(left - use)
    detail.push({ id: p.id, item: p.remark || '采购', unpaid, use })
    await db.batch([
      db.prepare('UPDATE payables SET paid=paid+?, rev=COALESCE(rev,0)+1 WHERE id=?').bind(use, p.id),
      db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, remark, account_id, cash, created_at) VALUES ('out','payable',?,?,?,?,1,?)")
        .bind(p.id, use, `付 ${name} ${p.remark || ''}${remark ? ' ' + remark : ''}`, acc, d)
    ])
  }
  await logAudit(db, '整户付款', name, `${name} 共付 ¥${total}，核销 ${detail.length} 笔`, '', act(c))
  return c.json({ ok: true, total: round2(total), used: detail, rest: round2(left) })
})

// 一键催款：按客户汇总未结应收，生成可直接发微信的话术
app.get('/dunning', async (c) => {
  const db = c.env.DB
  const type = c.req.query('type') || 'ar'
  const days = num(c.req.query('days'), 30)
  const name = c.req.query('name')
  const lines = []
  if (type === 'ar') {
    let sql = 'SELECT customer AS nm, COUNT(*) AS cnt, SUM(price-paid-COALESCE(written_off,0)) AS unpaid, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM orders WHERE paid + COALESCE(written_off,0) < price'
    const binds = []
    if (name) { sql += ' AND customer=?'; binds.push(name) }
    sql += ' GROUP BY customer ORDER BY unpaid DESC'
    const { results } = await db.prepare(sql).bind(...binds).all()
    const rows = results.filter((r) => num(r.unpaid) > 0)
    if (!rows.length) return c.text('没有未结清的应收，暂时不用催款。')
    let all = 0
    for (const r of rows) {
      const od = daysSince(r.oldest)
      all += num(r.unpaid)
      lines.push(`${r.nm}：欠 ¥${round2(num(r.unpaid))}（${r.cnt} 单，最早一笔 ${od} 天前）`)
    }
    return c.text(
      `【应收催款清单 ${todayIso()}】\n` +
        `合计待收：¥${round2(all)}\n\n${lines.join('\n')}\n\n` +
        `—— 催款话术模板（复制后改名字发微信）——\n` +
        `${rows[0].nm}您好，麻烦对一下账：这边还有 ¥${round2(num(rows[0].unpaid))} 加工费没结（${rows[0].cnt} 单），方便的话这两天安排一下，谢谢！`
    )
  }
  // 应付：我该付谁
  const { results } = await db.prepare(
    'SELECT supplier AS nm, COUNT(*) AS cnt, SUM(amount-paid-COALESCE(written_off,0)) AS unpaid, MIN(created_at) AS oldest FROM payables WHERE paid + COALESCE(written_off,0) < amount GROUP BY supplier ORDER BY unpaid DESC'
  ).all()
  if (!results.length) return c.text('没有未结清的应付。')
  let all = 0
  for (const r of results) {
    all += num(r.unpaid)
    lines.push(`${r.nm}：欠 ¥${round2(num(r.unpaid))}（${r.cnt} 笔）`)
  }
  return c.text(`【应付清单 ${todayIso()}】\n合计待付：¥${round2(all)}\n\n${lines.join('\n')}`)
})

// 订单状态
app.post('/orders/:id/status', async (c) => {
  const id = c.req.param('id')
  const { status } = await c.req.json()
  const db = c.env.DB
  const o = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first()
  if (!o) return c.json({ error: '订单不存在' }, 404)
  if (await isMonthLocked(db, (o.created_at || '').slice(0, 7))) return c.json({ error: '该订单所在月份已结账锁定' }, 403)
  await db.prepare('UPDATE orders SET status=? WHERE id=?').bind(num(status), id).run()
  await logAudit(db, '状态变更', o.customer, `${o.customer} ${o.item_name} → ${['待加工','加工中','已交付'][num(status)] || num(status)}`)
  return c.json({ ok: true })
})

// 记应付
app.post('/payables', async (c) => {
  const body = await c.req.json()
  const { supplier, amount, category, remark, operator, due_date, confirm_dup, date } = body
  if (!supplier || num(amount) <= 0) return c.json({ error: '供应商和金额必填' }, 400)
  const db = c.env.DB
  const cid = String(body.client_id || '')
  if (await opSeen(db, cid)) return c.json({ ok: true, dup_ok: true })
  const created = stampOf(date)
  if (await isMonthLocked(db, created.slice(0, 7))) return c.json({ error: '该月份已结账锁定，先解锁再记账' }, 403)
  // 防重复：同供应商 + 同金额，7 天内提醒一次
  if (!confirm_dup) {
    const since = new Date(Date.now() + TZ_MS - 7 * 86400000).toISOString()
    const d = await db.prepare('SELECT 1 FROM payables WHERE supplier=? AND amount=? AND created_at >= ?')
      .bind(supplier, num(amount), since).first()
    if (d) return c.json({ error: `${supplier} 7 天内已经有一笔 ${num(amount)} 的应付了，确认再记一笔吗？`, dup: true }, 409)
  }
  const checks = await orderChecks(db, { table: 'payables', who: 'supplier', amtcol: 'amount', itemcol: 'remark', party: supplier, item: remark || '', amount, cost: 0, created: stampOf(date), due: toIsoDate(due_date) })
  await db.prepare('INSERT INTO payables (supplier, amount, paid, category, remark, operator, due_date, created_at, created_by) VALUES (?,?,0,?,?,?,?,?,?)')
    .bind(supplier, num(amount), category || '', remark || '', String(operator || '').trim() || null, toIsoDate(due_date) || (await termDue(db, supplier, created, 'ap')) || null, created, act(c)).run()
  await opMark(db, cid, 'payable', 0)
  await logAudit(db, '新增应付', supplier, `${supplier} ${remark || ''} ¥${num(amount)}`, '', act(c))
  return c.json(Object.assign({ ok: true }, checks.length ? { checks } : {}))
})

// 付供应商款（可带日期补录）
app.post('/payables/:id/pay', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const { amount, date, account_id } = body
  const db = c.env.DB
  const cid = String(body.client_id || '')
  if (await opSeen(db, cid)) return c.json({ ok: true, dup_ok: true })
  const p = await db.prepare('SELECT * FROM payables WHERE id=?').bind(id).first()
  if (!p) return c.json({ error: '应付单不存在' }, 404)
  if (await isMonthLocked(db, (p.created_at || '').slice(0, 7))) return c.json({ error: '该应付单所在月份已结账锁定' }, 403)
  const a = num(amount)
  if (a <= 0) return c.json({ error: '金额无效' }, 400)
  const leftPay = round2(num(p.amount) - num(p.paid) - num(p.written_off))
  if (a > leftPay + 0.005) return c.json({ error: `这笔只剩 ¥${leftPay} 没付，付不了 ¥${a}`, left: leftPay }, 400)
  const acc = num(account_id) || (await defaultAccountId(db))
  await db.batch([
    db.prepare('UPDATE payables SET paid=paid+?, rev=COALESCE(rev,0)+1 WHERE id=?').bind(a, id),
    db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('out','payable',?,?,?,?,?,1,?)")
      .bind(id, a, p.category || '', `付 ${p.supplier} ${p.remark}`, acc, normDate(date))
  ])
  await opMark(db, cid, 'pay', id)
  await logAudit(db, '付款', p.supplier, `${p.supplier} 付 ¥${a}`, '', act(c))
  return c.json({ ok: true })
})

// 现付支出
app.post('/expenses', async (c) => {
  const body = await c.req.json()
  const { amount, category, remark, operator, account_id, confirm_dup, date } = body
  if (num(amount) <= 0) return c.json({ error: '金额必填' }, 400)
  const db = c.env.DB
  const cid = String(body.client_id || '')
  if (await opSeen(db, cid)) return c.json({ ok: true, dup_ok: true })
  const created = stampOf(date)
  if (await isMonthLocked(db, created.slice(0, 7))) return c.json({ error: '该月份已结账锁定，先解锁再记账' }, 403)
  // 防重复：同一天 + 同分类 + 同金额，提醒一次
  if (!confirm_dup) {
    const d = await db.prepare("SELECT 1 FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND ref_type='expense' AND amount=? AND COALESCE(NULLIF(category,''),'其他')=? AND substr(created_at,1,10)=?")
      .bind(num(amount), category || '其他', created.slice(0, 10)).first()
    if (d) return c.json({ error: `今天已经记过一笔「${category || '其他'} ${num(amount)}」，确认再记一次吗？`, dup: true }, 409)
  }
  const acc = num(account_id) || (await defaultAccountId(db))
  await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, operator, account_id, cash, created_at) VALUES ('out','expense',0,?,?,?,?,?,1,?)")
    .bind(num(amount), category || '', remark || '', String(operator || '').trim() || null, acc, created).run()
  await opMark(db, cid, 'expense', 0)
  await logAudit(db, '新增支出', category || '其他', `${category || '其他'} ¥${num(amount)}`, '', act(c))
  return c.json({ ok: true })
})

// 固定支出（工资、房租等每月自动记）
app.get('/fixed', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM fixed_expenses ORDER BY day').all()
  return c.json(results)
})

app.post('/fixed', async (c) => {
  const { amount, category, day, remark } = await c.req.json()
  const d = num(day)
  if (num(amount) <= 0) return c.json({ error: '金额必填' }, 400)
  if (!(d >= 1 && d <= 28)) return c.json({ error: '每月号数填 1–28' }, 400)
  const db = c.env.DB
  await db.prepare('INSERT INTO fixed_expenses (amount, category, remark, day, created_at) VALUES (?,?,?,?,?)')
    .bind(num(amount), category || '', remark || '', d, now()).run()
  await logAudit(db, '添加固定支出', category || '其他', `每月${d}号 ¥${num(amount)}`)
  return c.json({ ok: true })
})

app.delete('/fixed/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const f = await db.prepare('SELECT * FROM fixed_expenses WHERE id=?').bind(id).first()
  await db.prepare('DELETE FROM fixed_expenses WHERE id=?').bind(id).run()
  if (f) await logAudit(db, '删除固定支出', f.category || '其他', `每月${f.day}号 ¥${f.amount}`)
  return c.json({ ok: true })
})

// 立即补记本月固定支出（平时由每日 cron 自动跑）
app.post('/run-fixed', async (c) => {
  const n = await runFixed(c.env.DB)
  if (n) await logAudit(c.env.DB, '补记固定支出', '', `本月补记 ${n} 笔`)
  return c.json({ ok: true, added: n })
})

// ── 支出结构：这个月比上个月、比平时多花在哪 ──
// 口径：只算真花出去的现金费用（费用 + 固定支出），不含采购进料（那算成本）
app.get('/expense-compare', async (c) => {
  const db = c.env.DB
  const cur = String(c.req.query('month') || '').match(/^\d{4}-\d{2}$/) ? c.req.query('month') : now().slice(0, 7)
  const n = Math.min(12, Math.max(3, num(c.req.query('months'), 6)))
  const prev = new Date(Date.parse(cur + '-01T00:00:00Z') - 86400000).toISOString().slice(0, 7)
  const fromM = new Date(Date.UTC(Number(cur.slice(0, 4)), Number(cur.slice(5, 7)) - 1 - n, 1)).toISOString().slice(0, 7)
  const { results } = await db.prepare(`SELECT substr(created_at,1,7) AS m, COALESCE(NULLIF(TRIM(category),''),'其他') AS c,
      COALESCE(SUM(amount),0) AS s, COUNT(*) AS n
    FROM ledger WHERE ${CASH_EXP_WHERE} AND month>=? AND month<=?
    GROUP BY m, c`).bind(fromM, cur).all()
  const byCat = {}
  const monthsWithData = new Set()
  for (const r of results || []) {
    const cat = r.c || '其他'
    byCat[cat] = byCat[cat] || { cur: 0, prev: 0, hist: 0, cur_n: 0 }
    const v = num(r.s)
    if (r.m === cur) { byCat[cat].cur += v; byCat[cat].cur_n += num(r.n) }
    else if (r.m === prev) byCat[cat].prev += v
    else if (r.m < cur && r.m !== prev) byCat[cat].hist += v
    monthsWithData.add(r.m)
  }
  const curTotal = round2(Object.keys(byCat).reduce((a, k) => a + byCat[k].cur, 0))
  const prevTotal = round2(Object.keys(byCat).reduce((a, k) => a + byCat[k].prev, 0))
  const rows = Object.keys(byCat).map((cat) => {
    const x = byCat[cat]
    const avg = round2(x.hist / Math.max(1, n - 1))
    let flag = 'flat'
    let flag_text = ''
    if (x.cur > 0 && avg >= 1 && x.cur >= avg * 1.5 && x.cur - avg >= 200) {
      flag = 'up'; flag_text = `比平时多花 ¥${round2(x.cur - avg)}（近 ${n - 1} 个月平均 ${avg}）`
    } else if (x.cur > 0 && x.prev === 0 && avg < 1) {
      flag = 'new'; flag_text = '这个月新出现的一类开销'
    } else if (x.cur === 0 && x.prev > 0) {
      flag = 'gone'; flag_text = `上个月花了 ¥${round2(x.prev)}，这个月没有`
    } else if (x.prev > 0 && x.cur >= x.prev + 200 && x.cur >= x.prev * 1.5) {
      flag = 'up'; flag_text = `比上个月多 ¥${round2(x.cur - x.prev)}`
    } else if (x.prev >= 1 && x.cur <= x.prev * 0.6) {
      flag = 'down'; flag_text = `比上个月少 ¥${round2(x.prev - x.cur)}`
    }
    return {
      cat, cur: round2(x.cur), prev: round2(x.prev), cur_n: num(x.cur_n), avg6: avg,
      delta: round2(x.cur - x.prev),
      pct: x.prev > 0 ? round2(((x.cur - x.prev) / x.prev) * 100) : null,
      vs_avg_pct: avg > 0 ? round2(((x.cur - avg) / avg) * 100) : null,
      pct_of_total: curTotal > 0 ? round2((x.cur / curTotal) * 100) : 0,
      bar: curTotal > 0 ? Math.max(x.cur > 0 ? 3 : 0, Math.round((x.cur / curTotal) * 100)) : 0,
      flag, flag_text
    }
  }).sort((a, b) => b.cur - a.cur || b.prev - a.prev)
  const ups = rows.filter((r) => r.flag === 'up')
  const totalDelta = round2(curTotal - prevTotal)
  const avgTotal = round2(rows.reduce((a, r) => a + r.avg6, 0))
  const advice = []
  if (!rows.length) advice.push('这个月还没记支出，记一笔就能对比了')
  else {
    if (totalDelta > 0) advice.push(`总支出比上个月多 ¥${totalDelta}${prevTotal > 0 ? '（' + round2((totalDelta / prevTotal) * 100) + '%）' : ''}`)
    else if (totalDelta < 0) advice.push(`总支出比上个月少 ¥${round2(-totalDelta)}`)
    else advice.push('总支出和上个月一样')
    if (ups.length) advice.push(`${ups[0].cat} 花得最突：${ups[0].flag_text}`)
    if (rows[0] && rows[0].pct_of_total >= 50 && curTotal >= 500) advice.push(`光「${rows[0].cat}」就占了 ${rows[0].pct_of_total}%（¥${rows[0].cur}）`)
    const gone = rows.filter((r) => r.flag === 'gone')
    if (gone.length) advice.push(`${gone.map((g) => g.cat).slice(0, 3).join('、')} 这个月没花钱`)
  }
  const L = [`【${cur} 支出对比】共支出 ¥${curTotal}（上个月 ¥${prevTotal}${totalDelta !== 0 ? '，' + (totalDelta > 0 ? '多' : '少') + ' ¥' + Math.abs(totalDelta) : ''}）`]
  rows.filter((r) => r.cur > 0).forEach((r) => {
    L.push(`· ${r.cat} ¥${r.cur}（占 ${r.pct_of_total}%${r.prev > 0 ? '，上月 ¥' + r.prev : ''}）${r.flag_text ? '｜' + r.flag_text : ''}`)
  })
  if (advice.length) L.push('— ' + advice.join('；'))
  return c.json({ ok: true, month: cur, prev_month: prev, months: n, cur_total: curTotal, prev_total: prevTotal,
    delta: totalDelta, avg6_total: avgTotal, rows, ups: ups.length, advice, text: L.join('\n') })
})

// ── 支出预算 ──
app.get('/budgets', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM budgets ORDER BY id').all()
  return c.json(results)
})

app.post('/budgets', async (c) => {
  const { category, amount } = await c.req.json()
  const cat = String(category || '').trim()
  if (!cat) return c.json({ error: '请选分类' }, 400)
  if (num(amount) <= 0) return c.json({ error: '额度要大于 0' }, 400)
  const db = c.env.DB
  const ex = await db.prepare('SELECT * FROM budgets WHERE category=?').bind(cat).first()
  if (ex) await db.prepare('UPDATE budgets SET amount=? WHERE id=?').bind(num(amount), ex.id).run()
  else await db.prepare('INSERT INTO budgets (category, amount, created_at) VALUES (?,?,?)').bind(cat, num(amount), now()).run()
  return c.json({ ok: true })
})

app.delete('/budgets/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM budgets WHERE id=?').bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

// ── 常用短语模板 ──
app.get('/phrases', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM phrases ORDER BY id DESC LIMIT 30').all()
  return c.json(results)
})

app.post('/phrases', async (c) => {
  const { text, kind } = await c.req.json()
  const t = String(text || '').trim()
  if (!t) return c.json({ error: '内容不能为空' }, 400)
  const db = c.env.DB
  const ex = await db.prepare('SELECT * FROM phrases WHERE text=?').bind(t).first()
  if (!ex) await db.prepare('INSERT INTO phrases (text, kind, created_at) VALUES (?,?,?)').bind(t, String(kind || ''), now()).run()
  return c.json({ ok: true })
})

app.delete('/phrases/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM phrases WHERE id=?').bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

// ── 全局搜索：应收/应付/支出一起查 ──
app.get('/search', async (c) => {
  const kw = String(c.req.query('kw') || '').trim()
  if (!kw) return c.json({ kw: '', orders: [], payables: [], ledger: [], total: 0 })
  const like = '%' + kw + '%'
  const db = c.env.DB
  const orders = await db.prepare('SELECT * FROM orders WHERE customer LIKE ? OR item_name LIKE ? OR COALESCE(operator,\'\') LIKE ? ORDER BY id DESC LIMIT 20').bind(like, like, like).all()
  const payables = await db.prepare('SELECT * FROM payables WHERE supplier LIKE ? OR COALESCE(remark,\'\') LIKE ? OR COALESCE(operator,\'\') LIKE ? ORDER BY id DESC LIMIT 20').bind(like, like, like).all()
  const ledger = await db.prepare('SELECT * FROM ledger WHERE COALESCE(remark,\'\') LIKE ? OR COALESCE(category,\'\') LIKE ? OR COALESCE(operator,\'\') LIKE ? ORDER BY id DESC LIMIT 20').bind(like, like, like).all()
  const o = orders.results.map((r) => ({ ...r, unpaid: round2(r.price - r.paid) }))
  const p = payables.results.map((r) => ({ ...r, unpaid: round2(r.amount - r.paid) }))
  return c.json({ kw, orders: o, payables: p, ledger: ledger.results, total: o.length + p.length + ledger.results.length })
})

// ── 月度结账锁定 ──
app.get('/month-locks', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM month_lock ORDER BY month DESC').all()
  return c.json(results)
})

app.post('/month-lock', async (c) => {
  const { month: m } = await c.req.json()
  const mm = String(m || '').trim()
  if (!/^\d{4}-\d{2}$/.test(mm)) return c.json({ error: '月份格式：YYYY-MM，如 2026-11' }, 400)
  await c.env.DB.prepare('INSERT OR IGNORE INTO month_lock (month, locked_at) VALUES (?,?)').bind(mm, now()).run()
  await logAudit(c.env.DB, '月度锁定', mm, `锁定 ${mm}`)
  return c.json({ ok: true })
})

app.delete('/month-lock/:month', async (c) => {
  const m = c.req.param('month')
  await c.env.DB.prepare('DELETE FROM month_lock WHERE month=?').bind(m).run()
  await logAudit(c.env.DB, '解除锁定', m, `解锁 ${m}`)
  return c.json({ ok: true })
})

// 操作日志（最近 100 条）
app.get('/audit-logs', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100').all()
  return c.json(results)
})

// 对账单（按单位）
// 一句话对账：某家到底欠我多少（截至今天，含未结清单、争议、对账进度）
// 现金流水账：这个月钱怎么变的（按账户列期初/进/出/期末 + 大额 + 对不上检查）
// 某月现金进/出/期末余额（cash=1 且不含内部转账）
async function cashMonth(db, m) {
  const r = await db.prepare("SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE 0 END),0) AS i, COALESCE(SUM(CASE WHEN direction='out' THEN amount ELSE 0 END),0) AS o FROM ledger WHERE cash=1 AND ref_type<>'transfer' AND substr(created_at,1,7)=?").bind(m).first()
  const bal = await accountBalances(db)
  return { in: round2(num(r && r.i)), out: round2(num(r && r.o)), balance: round2((bal || []).reduce((a, x) => a + num(x.balance), 0)) }
}

// 老板版月度一页纸：三句话 + 最大的三件事 + 趋势（给人看的，不是给会计的）
app.get('/month-brief', async (c) => {
  const db = c.env.DB
  const m = String(c.req.query('month') || '').slice(0, 7) || now().slice(0, 7)
  const prev = monthAdd(m + '-01', -1).slice(0, 7)
  const title = (await getTitle(db)).title || '加工厂'
  const [cur, pre, cash, prevCash] = await Promise.all([monthPL(db, m), monthPL(db, prev), cashMonth(db, m), cashMonth(db, prev)])
  const q1 = async (sql, ...b) => num(((await db.prepare(sql).bind(...b).first()) || {}).v)
  const [topIn, topOut, topOrder, overCust, dueAp] = await Promise.all([
    db.prepare("SELECT amount, remark, created_at FROM ledger WHERE direction='in' AND cash=1 AND ref_type<>'transfer' AND month=? ORDER BY amount DESC LIMIT 1").bind(m).first(),
    db.prepare("SELECT amount, category, remark, created_at FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND month=? ORDER BY amount DESC LIMIT 1").bind(m).first(),
    db.prepare("SELECT customer, item_name, price, created_at FROM orders WHERE month=? ORDER BY price DESC LIMIT 1").bind(m).first(),
    db.prepare("SELECT customer, SUM(price - paid - COALESCE(written_off,0)) AS left, MIN(created_at) AS oldest FROM orders WHERE price > paid + COALESCE(written_off,0) GROUP BY customer ORDER BY left DESC LIMIT 1").first(),
    db.prepare("SELECT supplier, SUM(amount - paid - COALESCE(written_off,0)) AS left, MIN(due_date) AS due FROM payables WHERE amount > paid + COALESCE(written_off,0) GROUP BY supplier ORDER BY left DESC LIMIT 1").first()
  ])
  const dCash = round2(cash.in - cash.out)
  const dProfit = round2(cur.profit - pre.profit)
  const sa = []
  if (cur.income === 0 && cur.profit === 0) sa.push({ tone: 'warn', text: '这个月还没记单子，先把接的单、收的钱记上，一页纸才有内容。' })
  else {
    sa.push({ tone: cur.profit >= 0 ? 'ok' : 'bad', text: `这个月赚了 ¥${cur.profit}（接单 ¥${cur.income}，料和现金费用花了 ¥${round2(cur.mat + cur.cash_exp)}）${pre.income > 0 && Math.abs(dProfit) >= 1 ? `，比上月${dProfit > 0 ? '多' : '少'} ¥${Math.abs(dProfit)}` : ''}。` })
    if (cash.in === 0 && cash.out === 0) sa.push({ tone: 'warn', text: `这个月没有进出的现金记录，手头账户里一共 ¥${cash.balance}。` })
    else sa.push({ tone: dCash >= 0 ? 'ok' : 'warn', text: `手头的钱${dCash >= 0 ? '多了' : '少了'} ¥${Math.abs(dCash)}（进 ¥${cash.in}、出 ¥${cash.out}），现在账户里一共 ¥${cash.balance}。` })
    const bills = []
    if (overCust && num(overCust.left) > 0) bills.push(`${overCust.customer} 欠得最多（¥${num(overCust.left)}，最老一笔 ${daysSince(overCust.oldest)} 天）`)
    if (dueAp && num(dueAp.left) > 0) bills.push(`${dueAp.supplier} 的钱该付了（¥${num(dueAp.left)}${dueAp.due ? '，约定 ' + String(dueAp.due).slice(5, 10) : ''}）`)
    sa.push({ tone: bills.length ? 'warn' : 'ok', text: bills.length ? `最该管的一件事：${bills[0]}。` : '没有特别该催的，保持这个节奏。' })
  }
  const events = []
  if (topIn) events.push({ k: 'in', text: `最大一笔进账 ¥${num(topIn.amount)}（${String(topIn.remark || '收款').slice(0, 20)}）`, date: String(topIn.created_at).slice(5, 10) })
  if (topOut) events.push({ k: 'out', text: `最大一笔花销 ¥${num(topOut.amount)}（${topOut.category || topOut.remark || '支出'}）`, date: String(topOut.created_at).slice(5, 10) })
  if (topOrder) events.push({ k: 'order', text: `最大一张单：${topOrder.customer} ${topOrder.item_name || ''} ¥${num(topOrder.price)}`, date: String(topOrder.created_at).slice(5, 10) })
  const trend = []
  for (let i = 5; i >= 0; i--) {
    const mm = monthAdd(m + '-01', -i).slice(0, 7)
    const p0 = i === 0 ? cur : await monthPL(db, mm)
    trend.push({ m: mm, profit: p0.profit, cash: 0 })
  }
  const mx = Math.max(1, ...trend.map((x) => Math.abs(x.profit)))
  trend.forEach((x) => { x.bar = Math.round(Math.abs(x.profit) / mx * 100); x.neg = x.profit < 0 })
  const out = {
    ok: true, month: m, title,
    profit: cur.profit, income: cur.income, mat: cur.mat, cash_exp: cur.cash_exp, margin: cur.margin,
    cash_in: cash.in, cash_out: cash.out, cash_delta: dCash, cash_balance: cash.balance,
    prev_profit: pre.profit, d_profit: dProfit,
    sentences: sa, events, trend,
    text: [`【${title}】${m} 一句话汇报`, '· ' + sa.map((x) => x.text).join('\n· '), events.length ? '本月最大的三件事：' : '', ...events.map((e, i) => `${i + 1}. ${e.date} ${e.text}`)].filter(Boolean).join('\n')
  }
  return c.json(out)
})

// 损失台账：这一年/这一个月亏掉的和少赚的
app.get('/loss-book', async (c) => {
  const db = c.env.DB
  const y = String(c.req.query('year') || now().slice(0, 4))
  const mon = String(c.req.query('month') || '').slice(0, 7)
  const w = mon ? "substr(created_at,1,7)=?" : "substr(created_at,1,4)=?"
  const bindv = mon || y
  const { results: wos } = await db.prepare(
    "SELECT * FROM writeoffs WHERE ref_type='order' AND " + w + ' ORDER BY created_at'
  ).bind(bindv).all()
  const { results: cheap } = await db.prepare(
    'SELECT id, customer, item_name, price, COALESCE(cost,0) AS cost, created_at FROM orders WHERE ' + w + ' AND price >= 1000 AND COALESCE(cost,0) > 0 AND (price - COALESCE(cost,0)) * 100 < price * 15 ORDER BY (price - COALESCE(cost,0)) * 100.0 / price'
  ).bind(bindv).all()
  const { results: allord } = await db.prepare(
    'SELECT customer, item_name, price, created_at FROM orders WHERE price > 0'
  ).all()
  const avgMap = {}
  for (const o of allord) {
    const k = String(o.customer) + '|' + String(o.item_name || '')
    const a = avgMap[k] = avgMap[k] || { s: 0, n: 0 }
    a.s += num(o.price); a.n += 1
  }
  const items = []
  for (const x of wos) {
    items.push({ kind: 'bad_debt', kind_label: '实亏·坏账核销', date: String(x.created_at).slice(0, 10), party: x.party || '', what: x.reason || '收不回来，核销', amount: round2(num(x.amount)), note: '', ref: 'order:' + x.ref_id })
  }
  for (const x of cheap) {
    const pr = num(x.price), c = num(x.cost)
    const gap = round2(pr * 0.15 - (pr - c))
    items.push({ kind: 'low_margin', kind_label: '少赚·毛利过低', date: String(x.created_at).slice(0, 10), party: x.customer, what: `${x.item_name || '加工'} ¥${pr}（成本 ¥${c}，毛利率 ${round2((pr - c) / pr * 100)}%）`, amount: gap, note: '按 15% 毛利率算少赚的部分', ref: 'order:' + x.id })
  }
  // 被压价：低于同客户同产品历史均价 15% 以上
  const cut = []
  for (const o of allord) {
    const k = String(o.customer) + '|' + String(o.item_name || '')
    const a = avgMap[k]
    if (!a || a.n < 3) continue
    if (!(mon ? String(o.created_at).slice(0, 7) === mon : String(o.created_at).slice(0, 4) === y)) continue
    const avg = (a.s - num(o.price)) / (a.n - 1)
    if (num(o.price) < avg * 0.85 && avg > 0) {
      cut.push({ date: String(o.created_at).slice(0, 10), party: o.customer, item: o.item_name || '加工', price: round2(num(o.price)), avg: round2(avg), amount: round2(avg * 0.85 - num(o.price)) })
    }
  }
  for (const x of cut) {
    items.push({ kind: 'price_cut', kind_label: '少赚·被压价', date: x.date, party: x.party, what: `${x.item} 做 ¥${x.price}（这家这个产品平时 ¥${x.avg}）`, amount: x.amount, note: '按平时价 85 折算少收的部分', ref: '' })
  }
  // 返工 / 报废 / 客诉：这是真金白银的损失，也算进台账
  try {
    const rw = await db.prepare('SELECT * FROM reworks WHERE ' + (mon ? 'month=?' : 'substr(date,1,4)=?') + ' ORDER BY date').bind(bindv).all()
    for (const x of rw.results || []) {
      items.push({ kind: 'rework', kind_label: '实亏·' + (RW_KIND[x.kind] || '返工'), date: String(x.date || '').slice(0, 10), party: x.party || '', what: [x.item || '加工', x.qty ? x.qty + (x.qty > 1 ? '件' : '件') : '', x.reason || ''].filter(Boolean).join(' '), amount: round2(num(x.cost)), note: RW_FAULT[x.fault] || '', ref: num(x.order_id) ? 'order:' + x.order_id : '' })
    }
  } catch (e) {}
  items.sort((a, b) => num(b.amount) - num(a.amount))
  const byKind = {}
  for (const x of items) {
    const k = byKind[x.kind] = byKind[x.kind] || { k: x.kind, label: x.kind_label, amount: 0, count: 0 }
    k.amount = round2(k.amount + num(x.amount)); k.count += 1
  }
  const total = round2(items.reduce((a, x) => a + num(x.amount), 0))
  const real = round2(items.filter((x) => x.kind === 'bad_debt' || x.kind === 'rework').reduce((a, x) => a + num(x.amount), 0))
  const missed = round2(total - real)
  const advice = []
  if (!items.length) advice.push({ tone: 'ok', text: `${mon || y + ' 年'}没有发现亏钱或明显少赚的单子 👍` })
  else {
    advice.push({ tone: real > 0 ? 'bad' : 'warn', text: `${mon || y + ' 年'}：实亏 ¥${real}（收不回来的），少赚 ¥${missed}（本来能多挣的），合计影响 ¥${total}。` })
    const top = Object.values(byKind).sort((a, b) => b.amount - a.amount)[0]
    if (top) advice.push({ tone: 'warn', text: `最多的是「${top.label}」：${top.count} 笔，¥${top.amount}。` })
    const p = items.filter((x) => x.kind === 'price_cut')[0]
    if (p) advice.push({ tone: 'warn', text: `被压价最狠的是 ${p.party} 的${p.what}——同一个活别人给多少，可以拿来谈。` })
    const bd = items.filter((x) => x.kind === 'bad_debt')[0]
    if (bd) advice.push({ tone: 'bad', text: `${bd.party} 有 ¥${bd.amount} 已经核销成坏账。以后这家先收定金再开工。` })
    const lm = items.filter((x) => x.kind === 'low_margin')
    if (lm.length >= 3) advice.push({ tone: 'warn', text: `毛利低于 15% 的单子有 ${lm.length} 张，接单前先算一下料和工，别为了忙而白干。` })
  }
  const text = [
    `【${(await getTitle(db)).title}】${mon || y + ' 年'} 损失台账`,
    `实亏 ¥${real}　少赚 ¥${missed}　合计影响 ¥${total}`,
    ...Object.values(byKind).map((k) => `· ${k.label}：${k.count} 笔 ¥${k.amount}`),
    ...items.slice(0, 8).map((x) => `${x.date} ${x.party}　${x.what}　影响 ¥${x.amount}`),
    ...advice.slice(1).map((x) => '· ' + x.text)
  ].join('\n')
  return c.json({
    ok: true, year: y, month: mon || '', period: mon || y + ' 年',
    total, real_loss: real, missed_profit: missed,
    by_kind: Object.values(byKind).sort((a, b) => b.amount - a.amount),
    items: items.slice(0, 40), count: items.length, advice, text
  })
})

// 全年 × 客户 对照：这一年从谁那儿赚的、谁在拖钱
app.get('/year-customers', async (c) => {
  const db = c.env.DB
  const y = String(c.req.query('year') || now().slice(0, 4))
  const { results: g } = await db.prepare(
    `SELECT customer AS party, COUNT(*) AS cnt, COALESCE(SUM(price),0) AS income,
            COALESCE(SUM(COALESCE(cost,0)),0) AS cost, COALESCE(SUM(paid),0) AS paid,
            COALESCE(SUM(price - paid - COALESCE(written_off,0)),0) AS unpaid,
            MIN(substr(created_at,1,10)) AS first_day, MAX(substr(created_at,1,10)) AS last_day
       FROM orders WHERE substr(created_at,1,4)=? GROUP BY customer ORDER BY income DESC`
  ).bind(y).all()
  const { results: bym } = await db.prepare(
    "SELECT customer AS party, month AS m, COALESCE(SUM(price),0) AS s FROM orders WHERE substr(created_at,1,4)=? GROUP BY customer, m"
  ).bind(y).all()
  const map = {}
  for (const r of bym) { (map[r.party] = map[r.party] || {})[r.m.slice(5)] = round2(num(r.s)) }
  const totalIncome = round2(g.reduce((a, x) => a + num(x.income), 0))
  const totalProfit = round2(g.reduce((a, x) => a + num(x.income) - num(x.cost), 0))
  const totalUnpaid = round2(g.reduce((a, x) => a + num(x.unpaid), 0))
  const rows = g.map((x, i) => {
    const inc = num(x.income), cost = num(x.cost)
    const profit = round2(inc - cost)
    const mm = map[x.party] || {}
    const best = Object.keys(mm).sort((a, b) => mm[b] - mm[a])[0] || ''
    const days = x.first_day ? daysSince(x.first_day + 'T00:00:00.000Z') : 0
    return {
      rank: i + 1, party: x.party, cnt: num(x.cnt), income: inc, cost, profit,
      margin_pct: inc > 0 ? round2(profit / inc * 100) : 0,
      paid: round2(num(x.paid)), unpaid: round2(num(x.unpaid)),
      share: totalIncome > 0 ? round2(inc / totalIncome * 100) : 0,
      bar: totalIncome > 0 ? Math.max(2, Math.round(inc / totalIncome * 100)) : 0,
      months_worked: Object.keys(mm).length, best_month: best, best_amount: best ? mm[best] : 0,
      first_day: x.first_day, last_day: x.last_day, days_since_first: days,
      no_cost: cost === 0
    }
  })
  const top3 = round2(rows.slice(0, 3).reduce((a, x) => a + x.share, 0))
  const advice = []
  if (!rows.length) advice.push({ tone: 'warn', text: `${y} 年还没有单据，先记几笔再看。` })
  else {
    const r0 = rows[0]
    if (top3 >= 70 && rows.length >= 4) advice.push({ tone: 'warn', text: `${y} 年 ${top3}% 的钱来自前 3 家（${rows.slice(0, 3).map((x) => x.party).join('、')}），太集中了——万一最大那家不做了，收入会掉一大块。` })
    else if (rows.length < 4) advice.push({ tone: 'ok', text: `一共 ${rows.length} 家客户，最赚的是 ${r0.party}（¥${r0.income}，毛利 ¥${r0.profit}）。客户多了（4 家以上）才会看集中度。` })
    else advice.push({ tone: 'ok', text: `前 3 家占 ${top3}%，客户还算分散。最赚的是 ${r0.party}（¥${r0.income}，毛利 ¥${r0.profit}）。` })
    const bad = rows.filter((x) => x.income >= 1000 && x.margin_pct < 15).sort((a, b) => a.margin_pct - b.margin_pct)[0]
    if (bad) advice.push({ tone: 'warn', text: `${bad.party} 做了 ¥${bad.income} 但毛利率只有 ${bad.margin_pct}%，几乎白干——下次报价往上提，或者少接。` })
    const owed = rows.filter((x) => x.unpaid > 0).sort((a, b) => b.unpaid - a.unpaid)[0]
    if (owed) advice.push({ tone: 'bad', text: `${owed.party} 还欠 ¥${owed.unpaid}（占今年这家的 ${round2(owed.unpaid / owed.income * 100)}%），最该催。` })
    const one = rows.find((x) => x.cnt === 1)
    if (one) advice.push({ tone: 'warn', text: `${one.party} 今年只做过 1 单（¥${one.income}），可以问一句明年还有没有活。` })
  }
  const text = [
    `【${(await getTitle(db)).title}】${y} 年从谁那儿赚的`,
    `全年接单 ¥${totalIncome}，毛利 ¥${totalProfit}，${rows.length} 家客户，还欠 ¥${totalUnpaid}`,
    ...rows.slice(0, 10).map((x) => `${x.rank}. ${x.party}　¥${x.income}（占 ${x.share}%，毛利 ${x.margin_pct}%${x.unpaid > 0 ? `，欠 ¥${x.unpaid}` : ''}）`),
    top3 >= 70 ? `· 前 3 家占 ${top3}%，客户偏集中` : `· 前 3 家占 ${top3}%`,
    ...advice.slice(1).map((x) => '· ' + x.text)
  ].join('\n')
  return c.json({
    ok: true, year: y, total_income: totalIncome, total_profit: totalProfit,
    total_unpaid: totalUnpaid, count: rows.length, top3_share: top3,
    rows: rows.slice(0, 30), advice, text
  })
})

// 利润 → 现金 桥接：赚的钱为什么没变成现金
app.get('/cash-bridge', async (c) => {
  const db = c.env.DB
  const m = String(c.req.query('month') || '').slice(0, 7) || now().slice(0, 7)
  const start = m + '-01'
  const end = addDaysIso(start, new Date(Date.UTC(num(m.slice(0, 4)), num(m.slice(5, 7)), 0)).getUTCDate() - 1)
  const pl = await monthPL(db, m)
  const q1 = async (sql, ...b) => num(((await db.prepare(sql).bind(...b).first()) || {}).v)
  const [arBegin, arEnd, apBegin, apEnd, debtIn, debtRepay, advIn, advUsed, loanOut, loanBack, woAr, woAp, cashIn, cashOut] = await Promise.all([
    q1("SELECT COALESCE(SUM(price - paid - COALESCE(written_off,0)),0) AS v FROM orders WHERE substr(created_at,1,10) < ?", start),
    q1("SELECT COALESCE(SUM(price - paid - COALESCE(written_off,0)),0) AS v FROM orders WHERE substr(created_at,1,10) <= ?", end),
    q1("SELECT COALESCE(SUM(amount - paid - COALESCE(written_off,0)),0) AS v FROM payables WHERE substr(created_at,1,10) < ?", start),
    q1("SELECT COALESCE(SUM(amount - paid - COALESCE(written_off,0)),0) AS v FROM payables WHERE substr(created_at,1,10) <= ?", end),
    q1("SELECT COALESCE(SUM(amount),0) AS v FROM ledger WHERE direction='in' AND ref_type='debt' AND month=?", m),
    q1("SELECT COALESCE(SUM(amount),0) AS v FROM ledger WHERE direction='out' AND ref_type='debt' AND substr(created_at,1,7)=?", m),
    q1("SELECT COALESCE(SUM(amount - used),0) AS v FROM advances WHERE type='in' AND substr(created_at,1,7)=?", m),
    q1("SELECT COALESCE(SUM(amount),0) AS v FROM ledger WHERE cash=0 AND ref_type='order' AND month=?", m),
    q1("SELECT COALESCE(SUM(amount),0) AS v FROM ledger WHERE direction='out' AND ref_type='loan' AND month=?", m),
    q1("SELECT COALESCE(SUM(amount),0) AS v FROM ledger WHERE direction='in' AND ref_type='loan' AND substr(created_at,1,7)=?", m),
    q1("SELECT COALESCE(SUM(amount),0) AS v FROM writeoffs WHERE ref_type='order' AND substr(created_at,1,7)=?", m),
    q1("SELECT COALESCE(SUM(amount),0) AS v FROM writeoffs WHERE ref_type='payable' AND substr(created_at,1,7)=?", m),
    q1("SELECT COALESCE(SUM(amount),0) AS v FROM ledger WHERE direction='in' AND cash=1 AND ref_type<>'transfer' AND month=?", m),
    q1("SELECT COALESCE(SUM(amount),0) AS v FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND substr(created_at,1,7)=?", m)
  ])
  const dAR = round2(arEnd - arBegin)
  const dAP = round2(apEnd - apBegin)
  const adj = round2(pl.amort + pl.dep + pl.accrue)
  const netDebt = round2(debtIn - debtRepay)
  const actual = round2(cashIn - cashOut)
  const rows = [
    { k: 'profit', label: '本月净利（权责口径）', amount: pl.profit, note: '收入减材料、现金费用、折旧摊销' },
    { k: 'adj', label: '加回 折旧 / 摊销 / 预提利息', amount: adj, note: '这些进了利润表，但没花现金' },
    { k: 'ar', label: '应收变动（变多=钱压在客户那，记账为负）', amount: round2(-dAR), note: `月初别人欠 ¥${arBegin} → 月底 ¥${arEnd}` },
    { k: 'ap', label: '应付变动（变多=赊来的钱）', amount: dAP, note: `月初我欠 ¥${apBegin} → 月底 ¥${apEnd}` },
    { k: 'mat_gap', label: '材料成本 与 本月赊购的差', amount: round2(pl.mat - pl.payable_add), note: `这月单子上用了料 ¥${pl.mat}，赊购了 ¥${pl.payable_add}（差额是现钱买的料，或料没用完）` },
    { k: 'debt', label: '借款净增（还本记负）', amount: netDebt, note: `借入 ¥${debtIn}、还 ¥${debtRepay}` },
    { k: 'adv', label: '本月收到预收款', amount: advIn, note: advIn > 0 ? `本月收预收 ¥${advIn}（还没干活的活钱）` : '' },
    { k: 'loan', label: '员工借支净变化（借出记负）', amount: round2(loanBack - loanOut), note: `借出 ¥${loanOut}、退回 ¥${loanBack}` },
    { k: 'wo', label: '核销（不走现金）', amount: round2(-(woAr - woAp)), note: `核销应收 ¥${woAr}、豁免应付 ¥${woAp}` }
  ]
  const explained = round2(rows.reduce((a, x) => a + num(x.amount), 0))
  const residual = round2(actual - explained)
  const out = {
    ok: true, month: m,
    profit: pl.profit, adj, d_ar: dAR, d_ap: dAP, net_debt: netDebt,
    cash_in: cashIn, cash_out: cashOut, actual, explained, residual,
    rows: rows.map((x) => Object.assign({}, x, { abs: Math.abs(num(x.amount)) })),
    huge: Math.abs(residual) >= 1,
    advice: []
  }
  if (Math.abs(residual) < 1) out.advice.push('对得上：净利加减这些项目，正好等于本月现金变化 ✓')
  else {
    out.advice.push(`还有 ¥${residual} 没解释，常见原因：预收款用了没算现金、内部转账漏记、直接把钱花在别的地方没记账。`)
    if (advUsed > 0) out.advice.push(`其中本月用预收抵扣了 ¥${advUsed}（不动现金，所以会让「现金变化」比账面少）。`)
  }
  if (Math.abs(pl.profit) > 0 && Math.abs(actual) < Math.abs(pl.profit) * 0.3 && pl.profit > 0)
    out.advice.push('利润有，现金没跟上——钱多半压在应收里，看一下「账龄」和「催款清单」。')
  out.text = [
    `【${(await getTitle(db)).title}】${m} 利润去哪了`,
    `本月净利 ¥${pl.profit}，实际现金变化 ¥${actual}`,
    ...rows.filter((x) => Math.abs(num(x.amount)) >= 1).map((x) => `${x.label} ¥${x.amount}`),
    `合计解释 ¥${explained}${Math.abs(residual) < 1 ? '，与现金变化一致 ✓' : `，还差 ¥${residual} 没解释`}`,
    ...out.advice.map((x) => '· ' + x)
  ].join('\n')
  return c.json(out)
})
app.get('/cashbook', async (c) => {
  const db = c.env.DB
  const m = (c.req.query('month') || now().slice(0, 7)).slice(0, 7)
  const big = num(c.req.query('big')) || 5000
  const accounts = await accountBalances(db)
  const { results: flow } = await db.prepare(
    "SELECT COALESCE(NULLIF(account_id,0),0) AS acc, direction, SUM(amount) AS s FROM ledger WHERE cash=1 AND month<=? GROUP BY acc, direction"
  ).bind(m).all()
  const { results: before } = await db.prepare(
    "SELECT COALESCE(NULLIF(account_id,0),0) AS acc, direction, SUM(amount) AS s FROM ledger WHERE cash=1 AND month<? GROUP BY acc, direction"
  ).bind(m).all()
  const { results: monthAgg } = await db.prepare(
    "SELECT COALESCE(NULLIF(account_id,0),0) AS acc, direction, SUM(amount) AS s FROM ledger WHERE cash=1 AND month=? GROUP BY acc, direction"
  ).bind(m).all()
  const map = (rows) => {
    const o = {}
    for (const r of rows) { o[r.acc] = o[r.acc] || { in: 0, out: 0 }; o[r.acc][r.direction === 'in' ? 'in' : 'out'] = num(r.s) }
    return o
  }
  const mb = map(before), mm = map(monthAgg)
  const get = (o, id) => o[id] || { in: 0, out: 0 }
  const uB = mb[0] || { in: 0, out: 0 }, uM = mm[0] || { in: 0, out: 0 }
  const rows = accounts.map((a, idx) => {
    const b0 = get(mb, a.id), m0 = get(mm, a.id)
    const inB = round2(num(b0.in) + (idx === 0 ? num(uB.in) : 0))
    const outB = round2(num(b0.out) + (idx === 0 ? num(uB.out) : 0))
    const inM = round2(num(m0.in) + (idx === 0 ? num(uM.in) : 0))
    const outM = round2(num(m0.out) + (idx === 0 ? num(uM.out) : 0))
    const open = round2(num(a.opening) + inB - outB)
    const income = inM, outgo = outM
    return { id: a.id, name: a.name, opening: open, income, outgo, end: round2(open + income - outgo), neg: round2(open + income - outgo) < 0 }
  })
  const { results: bigs } = await db.prepare(
    "SELECT id, direction, amount, COALESCE(remark,'') AS remark, COALESCE(category,'') AS category, substr(created_at,1,10) AS date FROM ledger WHERE cash=1 AND direction='out' AND amount>=? AND substr(created_at,1,7)=? ORDER BY amount DESC LIMIT 15"
  ).bind(big, m).all()
  const { results: cats } = await db.prepare(
    "SELECT COALESCE(NULLIF(category,''), remark, '其他') AS k, SUM(amount) AS s FROM ledger WHERE cash=1 AND direction='out' AND month=? GROUP BY k ORDER BY s DESC LIMIT 8"
  ).bind(m).all()
  const { results: paidAgg } = await db.prepare(
    "SELECT SUM(paid) AS s FROM orders WHERE month<=?"
  ).bind(m).all()
  const { results: ledAgg } = await db.prepare(
    "SELECT SUM(amount) AS s FROM ledger WHERE cash=1 AND direction='in' AND ref_type='order' AND substr(created_at,1,7)<=?"
  ).bind(m).all()
  const paidSum = round2(num(paidAgg[0] && paidAgg[0].s)), ledSum = round2(num(ledAgg[0] && ledAgg[0].s))
  const issues = []
  const negs = rows.filter((r) => r.neg)
  if (negs.length) issues.push({ tone: 'bad', text: `${negs.map((x) => x.name).join('、')} 期末是负数，可能是漏记了收入，或者从别的账户花了没记转账。` })
  const gap = round2(paidSum - ledSum)
  if (Math.abs(gap) >= 1) issues.push({ tone: 'warn', text: `应收单据上「已收」合计 ¥${paidSum}，但流水里记的收款是 ¥${ledSum}，差 ¥${gap}（可能删过流水，或收预付款/抵扣没走现金）。` })
  const totalIn = round2(rows.reduce((a, x) => a + x.income, 0))
  const totalOut = round2(rows.reduce((a, x) => a + x.outgo, 0))
  const totalOpen = round2(rows.reduce((a, x) => a + x.opening, 0))
  const totalEnd = round2(rows.reduce((a, x) => a + x.end, 0))
  const lines = [`【${(await getTitle(db)).title}】${m} 现金流水账`, `月初手头 ¥${totalOpen}，本月进 ¥${totalIn}，出 ¥${totalOut}，月底手头 ¥${totalEnd}`]
  for (const r of rows) lines.push(`${r.name}：月初 ${r.opening}，进 ${r.income}，出 ${r.outgo}，月底 ${r.end}`)
  if (bigs.length) { lines.push(`大额支出（≥${big}）：`); for (const b of bigs.slice(0, 8)) lines.push(`  ${b.date} ${b.category || b.remark || '支出'} ¥${b.amount}`) }
  for (const it of issues) lines.push('注意：' + it.text)
  return c.json({ ok: true, month: m, rows, total_open: totalOpen, total_in: totalIn, total_out: totalOut, total_end: totalEnd, big, bigs, cats: cats.map((x) => ({ k: x.k, s: round2(num(x.s)) })), issues, text: lines.join('\n') })
})

// ── 客户画像：这家客户到底值不值得继续做（一家一张卡）──
app.get('/customer-card', async (c) => {
  const db = c.env.DB
  const party = String(c.req.query('party') || '').trim()
  if (!party) return c.json({ error: '要看哪一家？在单位页点客户名字旁边的「📇 画像」' }, 400)
  const type = c.req.query('type') === 'ap' ? 'ap' : 'ar'
  const today = todayIso()
  const TGT = 25   // 目标毛利率（%）
  const [orR, payR, dunR, stR] = await Promise.all([
    db.prepare(`SELECT COUNT(*) cnt, COALESCE(SUM(price),0) income, COALESCE(SUM(COALESCE(cost,0)),0) cost,
        COALESCE(SUM(CASE WHEN COALESCE(cost,0)=0 THEN 1 ELSE 0 END),0) no_cost_cnt,
        MIN(created_at) first_day, MAX(created_at) last_day FROM orders WHERE customer=?`).bind(party).first().catch(() => null),
    db.prepare(`SELECT COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) unpaid,
        COALESCE(SUM(CASE WHEN paid+COALESCE(written_off,0) < price AND due_date IS NOT NULL AND due_date<>'' AND substr(due_date,1,10)<? THEN 1 ELSE 0 END),0) overdue_cnt,
        MIN(CASE WHEN paid+COALESCE(written_off,0) < price THEN created_at END) oldest_open FROM orders WHERE customer=?`).bind(today, party).first().catch(() => null),
    db.prepare("SELECT COUNT(*) n, MAX(created_at) last FROM dunning_log WHERE party=?").bind(party).first().catch(() => null),
    db.prepare("SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN ack='doubt' AND resolved_at IS NULL THEN 1 ELSE 0 END),0) doubt FROM statement_log WHERE party=? AND type=?").bind(party, type).first().catch(() => null)
  ])
  // 回款速度：只在「已经结清」的单上看（从开单到他付清花了几天）
  const hp = await db.prepare(`SELECT o.created_at c_at, MAX(l.created_at) last_pay FROM orders o
      JOIN ledger l ON l.ref_type='order' AND l.ref_id=o.id AND l.direction='in'
      WHERE o.customer=? AND o.paid + COALESCE(o.written_off,0) >= o.price GROUP BY o.id`).bind(party).all().catch(() => ({ results: [] }))
  const ds = []
  for (const h of (hp.results || [])) {
    const a = Date.parse(h.c_at || ''), b = Date.parse(h.last_pay || '')
    if (!a || !b || b < a) continue
    ds.push(Math.round((b - a) / 86400000))
  }
  ds.sort((x, y) => x - y)
  const avgDays = ds.length ? Math.round(ds.reduce((x, y) => x + y, 0) / ds.length) : null
  const last = await db.prepare('SELECT item_name, price, cost, created_at FROM orders WHERE customer=? ORDER BY price DESC LIMIT 1').bind(party).first().catch(() => null)

  const cnt = num(orR && orR.cnt), income = round2(num(orR && orR.income)), cost = round2(num(orR && orR.cost))
  const noCost = num(orR && orR.no_cost_cnt)
  const profit = round2(income - cost)
  const margin = income > 0 ? Math.round((profit / income) * 1000) / 10 : 0
  const unpaid = round2(num(payR && payR.unpaid))
  const overdueCnt = num(payR && payR.overdue_cnt)
  const oldest = (payR && payR.oldest_open) ? daysSince(payR.oldest_open) : 0
  const dunTimes = num(dunR && dunR.n)
  const stN = num(stR && stR.n)
  const disputes = num(stR && stR.doubt)
  const daysSinceLast = (orR && orR.last_day) ? daysSince(orR.last_day) : null

  // 想把毛利率补到 TGT，单价大概要涨多少（按现在的成本结构算）
  let priceUpPct = 0
  if (income > 0 && cost > 0 && margin < TGT) {
    const need = cost / (1 - TGT / 100)
    priceUpPct = Math.round((need / income - 1) * 1000) / 10
    if (priceUpPct > 300) priceUpPct = 300
  }

  const advice = []
  let tone = 'good'
  if (income <= 0) {
    tone = 'watch'
    advice.push('这家还没有单据，先记一笔才能看出赚不赚钱')
  } else {
    if (margin < 10) { tone = 'bad'; advice.push(`毛利率只有 ${margin}%，基本白干——按现在的成本，单价要涨 ${priceUpPct}% 才有 ${TGT}% 毛利`) }
    else if (margin < TGT) { tone = tone === 'bad' ? 'bad' : 'watch'; advice.push(`毛利率 ${margin}%，低于 ${TGT}%——不急，但新单可以试着报高 ${Math.min(priceUpPct, 30)}%`) }
    else advice.push(`毛利率 ${margin}%，价格是合适的`)
    if (noCost > 0) advice.push(`有 ${noCost} 张单没填料钱，毛利算不准，补上成本才能看清`)
    if (avgDays === null) advice.push('还没有结清过的单，看不出他付款快不快')
    else if (avgDays > 45) { tone = 'bad'; advice.push(`平均 ${avgDays} 天才付清（最慢 ${ds[ds.length - 1]} 天），钱压得久——下次可以要定金或缩短账期`) }
    else if (avgDays > 30) advice.push(`平均 ${avgDays} 天付清，比一般慢一点，跟紧点`)
    else advice.push(`平均 ${avgDays} 天就付清，付款爽快`)
    if (unpaid > 0 && oldest > 60) { tone = 'bad'; advice.push(`还欠 ¥${unpaid}，最老一笔挂了 ${oldest} 天，先催这笔`) }
    else if (unpaid > 0) advice.push(`还欠 ¥${unpaid}${overdueCnt ? `，其中 ${overdueCnt} 笔已过期` : ''}`)
    if (disputes > 0) advice.push(`有 ${disputes} 份对账单对方说对不上，还没了结——先把这个弄清`)
    if (dunTimes >= 3) advice.push(`催过 ${dunTimes} 次了，下次开单前先说清付款日`)
    if (daysSinceLast !== null && daysSinceLast > 90) advice.push(`${daysSinceLast} 天没下新单了，可以打个电话问问还有没有活`)
  }
  const verdict = tone === 'good' ? '这家客户值得继续做' : (tone === 'bad' ? '这家要盯紧，别越做越亏' : '能做，但有几处要留意')
  const L = []
  L.push(`【${party}】${verdict}`)
  L.push(`做了 ${cnt} 单，共 ¥${income}${last && last.item_name ? `；最大一单「${last.item_name}」¥${round2(num(last.price))}` : ''}`)
  L.push(`料钱 ¥${cost}，毛利 ¥${profit}（${margin}%）`)
  L.push(avgDays === null ? '付款速度：还没有结清的单' : `付款速度：平均 ${avgDays} 天付清（最快 ${ds[0]} 天，最慢 ${ds[ds.length - 1]} 天，共 ${ds.length} 单）`)
  L.push(`现在欠 ¥${unpaid}${oldest ? `，最老一笔 ${oldest} 天` : ''}${overdueCnt ? `，${overdueCnt} 笔已过期` : ''}`)
  if (dunTimes || stN) L.push(`催过 ${dunTimes} 次，发过 ${stN} 份对账单${disputes ? `，${disputes} 份有争议` : ''}`)
  const pbAll = await promiseBook(db, 1095, type).catch(() => null)
  const pbk = pbAll ? (pbAll.parties || []).find((x) => norm(x.party) === norm(party)) : null
  if (pbk && pbk.promises) L.push(`答应付款 ${pbk.promises} 次：兑现 ${pbk.kept} 次、失约 ${pbk.broken} 次${pbk.rate !== null ? `（兑现率 ${pbk.rate}%）` : ''}`)
  advice.forEach((x) => L.push('· ' + x))
  return c.json({
    ok: true, party, type, verdict, tone, advice, text: L.join('\n'),
    cnt, income, cost, profit, margin_pct: margin, no_cost_cnt: noCost,
    avg_per_order: cnt > 0 ? round2(income / cnt) : 0,
    biggest: last ? { item: last.item_name || '', price: round2(num(last.price)), cost: round2(num(last.cost)), date: (last.created_at || '').slice(0, 10) } : null,
    first_day: (orR && orR.first_day || '').slice(0, 10), last_day: (orR && orR.last_day || '').slice(0, 10),
    days_since_last: daysSinceLast,
    pay: { avg_days: avgDays, fastest: ds.length ? ds[0] : null, slowest: ds.length ? ds[ds.length - 1] : null, settled_cnt: ds.length },
    unpaid, overdue_cnt: overdueCnt, oldest_days: oldest,
    dun_times: dunTimes, statements: stN, disputes,
    promise: pbk ? { promises: pbk.promises, kept: pbk.kept, broken: pbk.broken, pending: pbk.pending, rate: pbk.rate, last_broken: pbk.last_broken } : null,
    price_up_pct: priceUpPct, margin_target: TGT
  })
})

app.get('/party-balance', async (c) => {
  const db = c.env.DB
  const type = (c.req.query('type') || 'ar') === 'ap' ? 'ap' : 'ar'
  const T = type === 'ar' ? 'orders' : 'payables'
  const who = type === 'ar' ? 'customer' : 'supplier'
  const amt = type === 'ar' ? 'price' : 'amount'
  const label = type === 'ar' ? '应收' : '应付'
  const party = String(c.req.query('party') || '').trim()
  const aggSql = `SELECT ${who} AS party, COUNT(*) AS cnt, ROUND(SUM(${amt}),2) AS total,
      ROUND(SUM(paid),2) AS paid, ROUND(SUM(COALESCE(written_off,0)),2) AS written,
      MAX(substr(created_at,1,10)) AS last_date FROM ${T} GROUP BY ${who}`
  if (!party) {
    const { results } = await db.prepare(`SELECT * FROM (${aggSql}) WHERE total - paid - written > 0 ORDER BY total - paid - written DESC LIMIT 60`).all()
    const rows = results.map((r) => ({ party: r.party, cnt: r.cnt, total: num(r.total), paid: num(r.paid), left: round2(num(r.total) - num(r.paid) - num(r.written)), last_date: r.last_date }))
    return c.json({ ok: true, type, rows, count: rows.length, total_left: round2(rows.reduce((a, x) => a + x.left, 0)) })
  }
  const head = await db.prepare(`SELECT * FROM (${aggSql}) WHERE party=?`).bind(party).first()
  const { results: items } = await db.prepare(`SELECT id, substr(created_at,1,10) AS date, ${type === 'ar' ? 'item_name' : 'remark'} AS item,
      ${amt} AS amount, paid, COALESCE(written_off,0) AS wo, due_date, progress
      FROM ${T} WHERE ${who}=? ORDER BY created_at DESC LIMIT 60`).bind(party).all()
  const today = dayStr(new Date())
  const rows = items.map((x) => {
    const left = round2(num(x.amount) - num(x.paid) - num(x.wo))
    const due = String(x.due_date || '').slice(0, 10)
    return { id: x.id, date: x.date, item: x.item || '', amount: num(x.amount), paid: num(x.paid), left, days: x.date ? Math.max(0, Math.round((Date.parse(today) - Date.parse(x.date)) / 86400000)) : 0, due, over: due && due < today ? Math.round((Date.parse(today) - Date.parse(due)) / 86400000) : 0 }
  })
  const open = rows.filter((x) => x.left > 0.005)
  const total = num(head && head.total), paid = num(head && head.paid), written = num(head && head.written)
  const left = round2(total - paid - written)
  const over90 = round2(open.filter((x) => x.days > 90).reduce((a, x) => a + x.left, 0))
  const oldest = open.reduce((a, x) => Math.max(a, x.days), 0)
  const [prof, term, st, recon, dun] = await Promise.all([
    db.prepare('SELECT * FROM party_profiles WHERE party=?').bind(party).first().catch(() => null),
    db.prepare('SELECT * FROM party_terms WHERE party=?').bind(party).first().catch(() => null),
    db.prepare("SELECT COUNT(*) AS c, MAX(substr(created_at,1,10)) AS d FROM statement_log WHERE party=? AND (ack IS NULL OR ack='')").bind(party).first().catch(() => null),
    db.prepare('SELECT COUNT(*) AS c FROM recon_log WHERE party=? AND done=0').bind(party).first().catch(() => null),
    db.prepare('SELECT COUNT(*) AS c, MAX(substr(created_at,1,10)) AS d FROM dunning_log WHERE party=?').bind(party).first().catch(() => null)
  ])
  const title = (await getTitle(db)).title
  const L = []
  L.push(`${party}　截至 ${today}（${label}）`)
  if (prof && (prof.contact || prof.phone)) L.push(`联系人 ${prof.contact || '—'}　电话 ${prof.phone || '—'}`)
  L.push(`共 ${num(head && head.cnt)} 单，合计 ¥${total}，已${type === 'ar' ? '收' : '付'} ¥${paid}${written > 0 ? `，核销 ¥${written}` : ''}，还欠 ¥${left}`)
  if (open.length) {
    L.push(`还欠的 ${open.length} 笔${over90 > 0 ? `，其中超 90 天 ¥${over90}` : ''}；最久一笔欠 ${oldest} 天`)
    open.slice(0, 10).forEach((x) => L.push(`  ${x.date} ${x.item || '—'} ¥${x.amount}（已${type === 'ar' ? '收' : '付'} ${x.paid}，还欠 ${x.left}${x.over > 0 ? `，超期 ${x.over} 天` : ''}）`))
    if (open.length > 10) L.push(`  …还有 ${open.length - 10} 笔`)
  } else L.push('已经全部结清 ✓')
  if (term && num(term.term_days) > 0) L.push(`账期：${num(term.term_days)} 天`)
  if (st && num(st.c) > 0) L.push(`对账单：${num(st.c)} 份还没确认（最近 ${st.d || '—'}）`)
  if (recon && num(recon.c) > 0) L.push(`⚠ 有 ${num(recon.c)} 条对账差异还没处理`)
  if (dun && num(dun.c) > 0) L.push(`已催 ${num(dun.c)} 次（上次 ${dun.d || '—'}）`)
  L.push('')
  L.push(`—— ${title} ——`)
  return c.json({ ok: true, type, party, total, paid, written, left, cnt: num(head && head.cnt), open_count: open.length, over90, oldest, rows, open, profile: prof || null, term: term || null, open_stmt: num(st && st.c), open_recon: num(recon && recon.c), dun_times: num(dun && dun.c), title, text: L.join('\n') })
})

app.get('/statement', async (c) => {
  const type = c.req.query('type')
  const name = c.req.query('name')
  const db = c.env.DB
  const lines = []
  let total = 0
  if (type === 'ar') {
    const { results } = await db.prepare('SELECT * FROM orders WHERE customer=? AND paid<price ORDER BY id').bind(name).all()
    lines.push(...(await titled(db, `对账单 · ${name}`)))
    lines.push(`共 ${results.length} 笔未结清：`)
    results.forEach((o, i) => {
      const left = o.price - o.paid
      total += left
      lines.push(`${i + 1}. ${o.item_name || '加工'} 总${o.price} 已收${o.paid} 欠${round2(left)}`)
    })
    lines.push(`合计欠款：${round2(total)} 元`)
  } else {
    const { results } = await db.prepare('SELECT * FROM payables WHERE supplier=? AND paid<amount ORDER BY id').bind(name).all()
    lines.push(...(await titled(db, `对账单 · ${name}`)))
    lines.push(`共 ${results.length} 笔未结清：`)
    results.forEach((p, i) => {
      const left = p.amount - p.paid
      total += left
      const desc = [p.category, p.remark].filter(Boolean).join(' ')
      lines.push(`${i + 1}. ${desc || '货款'} 总${p.amount} 已付${p.paid} 欠${round2(left)}`)
    })
    lines.push(`合计欠款：${round2(total)} 元`)
  }
  return c.json({ text: await stampWithProf(db, name, lines) })
})

// 收/付款收据文本（给客户/供应商看的凭证，可存成图片）
app.get('/receipt-text', async (c) => {
  const type = c.req.query('type') === 'ap' ? 'ap' : 'ar'
  const id = Math.round(num(c.req.query('id')))
  if (!id) return c.json({ error: '缺少单据编号' }, 400)
  const db = c.env.DB
  const lines = []
  if (type === 'ar') {
    const o = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first()
    if (!o) return c.json({ error: '单据不存在' }, 404)
    const last = await db.prepare("SELECT * FROM ledger WHERE ref_type='order' AND ref_id=? AND direction='in' ORDER BY id DESC LIMIT 1").bind(id).first()
    let accName = ''
    if (last && num(last.account_id)) {
      const a = await db.prepare('SELECT name FROM accounts WHERE id=?').bind(num(last.account_id)).first()
      accName = (a && a.name) || ''
    }
    const amt = round2(num(c.req.query('amount')) || num(last && last.amount))
    const day = (last && last.created_at) ? String(last.created_at).slice(0, 10) : now().slice(0, 10)
    const left = round2(num(o.price) - num(o.paid))
    lines.push(...(await titled(db, `收款收据 · ${o.customer}`)))
    lines.push(`收据日期：${day}`)
    lines.push(`本次收款：${amt || round2(num(o.paid))} 元${accName ? '（' + accName + '）' : ''}`)
    lines.push(`对应单据：${o.item_name || '加工费'} 总 ${round2(num(o.price))} 元`)
    lines.push(`已收合计：${round2(num(o.paid))} 元`)
    lines.push(left > 0.005 ? `期末欠：${left} 元` : '已全部收清 ✓')
    if (o.operator) lines.push(`经手人：${o.operator}`)
    return c.json({ text: lines.join('\n'), type: 'ar', id, amount: amt, left })
  }
  const p2 = await db.prepare('SELECT * FROM payables WHERE id=?').bind(id).first()
  if (!p2) return c.json({ error: '单据不存在' }, 404)
  const lastP = await db.prepare("SELECT * FROM ledger WHERE ref_type='payable' AND ref_id=? AND direction='out' ORDER BY id DESC LIMIT 1").bind(id).first()
  let accName2 = ''
  if (lastP && num(lastP.account_id)) {
    const a = await db.prepare('SELECT name FROM accounts WHERE id=?').bind(num(lastP.account_id)).first()
    accName2 = (a && a.name) || ''
  }
  const amt2 = round2(num(c.req.query('amount')) || num(lastP && lastP.amount))
  const day2 = (lastP && lastP.created_at) ? String(lastP.created_at).slice(0, 10) : now().slice(0, 10)
  const left2 = round2(num(p2.amount) - num(p2.paid))
  const desc2 = [p2.category, p2.remark].filter(Boolean).join(' ') || '货款'
  lines.push(...(await titled(db, `付款收据 · ${p2.supplier}`)))
  lines.push(`收据日期：${day2}`)
  lines.push(`本次付款：${amt2 || round2(num(p2.paid))} 元${accName2 ? '（' + accName2 + '）' : ''}`)
  lines.push(`对应单据：${desc2} 总 ${round2(num(p2.amount))} 元`)
  lines.push(`已付合计：${round2(num(p2.paid))} 元`)
  lines.push(left2 > 0.005 ? `期末欠：${left2} 元` : '已全部付清 ✓')
  if (p2.operator) lines.push(`经手人：${p2.operator}`)
  return c.json({ text: lines.join('\n'), type: 'ap', id, amount: amt2, left: left2 })
})

// 月度对账（按单位+月份）
// 批量对账单：一次导出所有往来单位的对账表（汇总页 + 每家一页），发给客户/供应商一次搞定
app.get('/statement-pack', async (c) => {
  const db = c.env.DB
  const isAp = c.req.query('type') === 'ap'
  const mo = c.req.query('month') || ''
  const today = now().slice(0, 10)
  let from = c.req.query('from') || ''
  let to = c.req.query('to') || ''
  if (mo) { const yy = Number(mo.slice(0, 4)); const mnum = Number(mo.slice(5, 7)); const dim = new Date(Date.UTC(yy, mnum, 0)).getUTCDate(); from = `${mo}-01`; to = `${mo}-${String(dim).padStart(2, '0')}` } else { if (!from) from = `${today.slice(0, 4)}-01-01`; if (!to) to = today }
  const T = isAp ? 'payables' : 'orders'
  const P = isAp ? 'supplier' : 'customer'
  const AMT = isAp ? 'amount' : 'price'
  const rng = 'substr(created_at,1,10)>=? AND substr(created_at,1,10)<=?'
  const bills = (await db.prepare(`SELECT * FROM ${T} WHERE ${rng} ORDER BY ${P} ASC, id ASC`).bind(from, to).all()).results
  const preRows = (await db.prepare(`SELECT ${P} AS party, COALESCE(SUM(${AMT} - COALESCE(paid,0) - COALESCE(written_off,0)),0) AS open FROM ${T} WHERE substr(created_at,1,10)<? GROUP BY ${P}`).bind(from).all()).results
  const payRows = (await db.prepare(`SELECT x.${P} AS party, COALESCE(SUM(l.amount),0) AS paid FROM ledger l JOIN ${T} x ON x.id = l.ref_id WHERE l.ref_type=? AND substr(l.created_at,1,10)>=? AND substr(l.created_at,1,10)<=? GROUP BY x.${P}`).bind(isAp ? 'payable' : 'order', from, to).all()).results
  const head = await getTitle(db)
  const map = new Map()
  const add = (p2) => { if (!map.has(p2)) map.set(p2, { party: p2, bills: [], amt: 0, paidIn: 0, wo: 0, opening: 0, oldest: 0 }); return map.get(p2) }
  for (const r of preRows) if (num(r.open) > 0.009) add(r.party).opening = round2(num(r.open))
  for (const b of bills) {
    const e = add(b[P])
    e.bills.push(b)
    e.amt = round2(e.amt + num(b[AMT]))
    e.wo = round2(e.wo + num(b.written_off))
    const left = num(b[AMT]) - num(b.paid) - num(b.written_off)
    if (left > 0.009) {
      const base = (b.due_date || b.created_at || '').slice(0, 10)
      const days = Math.floor((Date.parse(today) - Date.parse(base)) / 86400000)
      if (days > e.oldest) e.oldest = Math.max(0, days)
    }
  }
  for (const r of payRows) { const e = map.get(r.party); if (e) e.paidIn = round2(num(r.paid)) }
  const list = Array.from(map.values()).map((e) => ({ ...e, end: round2(e.opening + e.amt - e.paidIn - e.wo) }))
  list.sort((a, b) => b.end - a.end || b.amt - a.amt)
  const NAME = isAp ? '应付' : '应收'
  const CN = isAp ? '已付' : '已收'
  const CN2 = isAp ? '未付' : '未收'
  const sheets = []
  const sumRows = [[`【${head.title || '加工费记账'}】${NAME}对账单汇总`, `账期 ${from} ~ ${to}`, `导出 ${today}`]]
  sumRows.push(['单位', '单据数', '本期金额', `本期${CN}`, '核销', '期初欠', `期末${CN2}`, '最久逾期(天)'])
  const phones = new Map()
  try {
    const ps = (await db.prepare("SELECT party, phone, contact FROM party_profiles").all()).results
    for (const x of ps) phones.set(x.party, x.phone || x.contact || '')
  } catch (e) { /* 没建表就跳过 */ }
  let tAmt = 0; let tPaid = 0; let tWo = 0; let tEnd = 0
  for (const e of list) {
    tAmt = round2(tAmt + e.amt); tPaid = round2(tPaid + e.paidIn); tWo = round2(tWo + e.wo); tEnd = round2(tEnd + e.end)
    sumRows.push([e.party, String(e.bills.length), round2(e.amt).toFixed(2), round2(e.paidIn).toFixed(2), round2(e.wo).toFixed(2), round2(e.opening).toFixed(2), e.end.toFixed(2), String(e.oldest)])
  }
  sumRows.push(['合计', String(list.length), tAmt.toFixed(2), tPaid.toFixed(2), tWo.toFixed(2), '', tEnd.toFixed(2), ''])
  sheets.push({ name: `${NAME}对账汇总`, rows: sumRows })
  const cap = list.slice(0, 80)
  for (const e of cap) {
    const rows = [[`【${head.title || '加工费记账'}】${NAME}对账单`]]
    const meta = [`单位：${e.party}`, `账期：${from} ~ ${to}`]
    if (head.phone) meta.push(`电话：${head.phone}`)
    rows.push(meta)
    if (head.addr) rows.push([`地址：${head.addr}`])
    const p2 = phones.get(e.party)
    if (p2) rows.push([`对方联系：${p2}`])
    rows.push([])
    rows.push(['日期', '单号', isAp ? '类别/备注' : '产品', '金额', CN, '核销', CN2, '约定日'])
    let bAmt = 0; let bPaid = 0; let bWo = 0; let bLeft = 0
    for (const b of e.bills) {
      const amt = num(b[AMT]); const pd = num(b.paid); const wo = num(b.written_off)
      const left = round2(amt - pd - wo)
      bAmt = round2(bAmt + amt); bPaid = round2(bPaid + pd); bWo = round2(bWo + wo); bLeft = round2(bLeft + left)
      rows.push([(b.created_at || '').slice(0, 10), '#' + b.id, isAp ? (b.remark || b.category || '') : (b.item_name || ''), amt.toFixed(2), pd.toFixed(2), wo ? wo.toFixed(2) : '', left.toFixed(2), (b.due_date || '').slice(0, 10)])
    }
    rows.push(['本期合计', '', '', bAmt.toFixed(2), bPaid.toFixed(2), bWo.toFixed(2), bLeft.toFixed(2), ''])
    rows.push(['期初结转', '', '', '', '', '', round2(e.opening).toFixed(2), ''])
    rows.push([`期末${CN2}`, '', '', '', '', '', e.end.toFixed(2), ''])
    rows.push([])
    rows.push(['核对无误请签字：', '', '', '', '', '日期：', '', ''])
    sheets.push({ name: e.party, rows })
  }
  const b64 = await toB64(await makeXlsxSheets(sheets))
  const nm = `对账单_${NAME}_${from}_${to}.xlsx`
  return c.json({ ok: true, name: nm, b64, parties: list.length, exported: cap.length, from, to, total_end: tEnd, truncated: list.length > cap.length })
})

app.get('/statement-month', async (c) => {
  const type = c.req.query('type')
  const name = c.req.query('name')
  const m = c.req.query('month') || month()
  if (!name) return c.json({ error: '缺少单位名称' }, 400)
  const db = c.env.DB
  const prefix = m + '%'
  const lines = []
  if (type === 'ar') {
    const { results: orders } = await db.prepare('SELECT * FROM orders WHERE customer=? ORDER BY id').bind(name).all()
    let open = 0, cur = 0, curCnt = 0
    for (const o of orders) {
      if (o.created_at < m + '-01') open += o.price - o.paid
      else if (o.created_at.startsWith(m + '-')) { cur += o.price; curCnt++ }
    }
    const got = await db.prepare("SELECT COALESCE(SUM(l.amount),0) AS t FROM ledger l JOIN orders o ON l.ref_id=o.id WHERE l.direction='in' AND l.ref_type='order' AND o.customer=? AND l.created_at LIKE ?").bind(name, prefix).first()
    const end = open + cur - num(got.t)
    lines.push(...(await titled(db, `${m} 月对账单 · ${name}`)))
    lines.push(`期初欠：${round2(open)}`)
    lines.push(`本月新增应收：${round2(cur)}（${curCnt} 笔）`)
    lines.push(`本月已收：${round2(num(got.t))}`)
    lines.push(`期末欠：${round2(end)}`)
    const monthOrders = orders.filter((o) => o.created_at.startsWith(m + '-'))
    if (monthOrders.length) {
      lines.push(`本月明细：`)
      monthOrders.forEach((o, i) => lines.push(`${i + 1}. ${o.item_name || '加工'} 总${o.price} 已收${o.paid}`))
    }
    const { results: recv } = await db.prepare(
      "SELECT l.created_at, l.amount, a.name AS acc FROM ledger l JOIN orders o ON l.ref_id=o.id LEFT JOIN accounts a ON a.id=l.account_id WHERE l.direction='in' AND l.ref_type='order' AND o.customer=? AND l.created_at LIKE ? ORDER BY l.created_at"
    ).bind(name, prefix).all()
    if (recv.length) {
      lines.push(`本月收款记录：`)
      recv.forEach((r) => lines.push(`${String(r.created_at).slice(5, 10)} 收 ${round2(num(r.amount))}${r.acc ? '（' + r.acc + '）' : ''}`))
    }
    lines.push(`—— 制表日期 ${now().slice(0, 10)}`)
    return c.json({ text: await stampWithProf(db, name, lines), month: m, name, type: 'ar', open: round2(open), inc: round2(cur), inc_cnt: curCnt, got: round2(num(got.t)), end: round2(end) })
  } else {
    const { results: pays } = await db.prepare('SELECT * FROM payables WHERE supplier=? ORDER BY id').bind(name).all()
    let open = 0, cur = 0, curCnt = 0
    for (const p of pays) {
      if (p.created_at < m + '-01') open += p.amount - p.paid
      else if (p.created_at.startsWith(m + '-')) { cur += p.amount; curCnt++ }
    }
    const paid = await db.prepare("SELECT COALESCE(SUM(l.amount),0) AS t FROM ledger l JOIN payables p ON l.ref_id=p.id WHERE l.direction='out' AND l.ref_type='payable' AND p.supplier=? AND l.created_at LIKE ?").bind(name, prefix).first()
    const end = open + cur - num(paid.t)
    lines.push(...(await titled(db, `${m} 月对账单 · ${name}`)))
    lines.push(`期初欠：${round2(open)}`)
    lines.push(`本月新增应付：${round2(cur)}（${curCnt} 笔）`)
    lines.push(`本月已付：${round2(num(paid.t))}`)
    lines.push(`期末欠：${round2(end)}`)
    const monthPays = pays.filter((p) => p.created_at.startsWith(m + '-'))
    if (monthPays.length) {
      lines.push(`本月明细：`)
      monthPays.forEach((p, i) => {
        const desc = [p.category, p.remark].filter(Boolean).join(' ')
        lines.push(`${i + 1}. ${desc || '货款'} 总${p.amount} 已付${p.paid}`)
      })
    }
    const { results: payRec } = await db.prepare(
      "SELECT l.created_at, l.amount, a.name AS acc FROM ledger l JOIN payables p ON l.ref_id=p.id LEFT JOIN accounts a ON a.id=l.account_id WHERE l.direction='out' AND l.ref_type='payable' AND p.supplier=? AND l.created_at LIKE ? ORDER BY l.created_at"
    ).bind(name, prefix).all()
    if (payRec.length) {
      lines.push(`本月付款记录：`)
      payRec.forEach((r) => lines.push(`${String(r.created_at).slice(5, 10)} 付 ${round2(num(r.amount))}${r.acc ? '（' + r.acc + '）' : ''}`))
    }
    lines.push(`—— 制表日期 ${now().slice(0, 10)}`)
    return c.json({ text: await stampWithProf(db, name, lines), month: m, name, type: 'ap', open: round2(open), inc: round2(cur), inc_cnt: curCnt, got: round2(num(paid.t)), end: round2(end) })
  }
  return c.json({ error: '类型不对，只能是 ar 或 ap' }, 400)
})

// 一句话记账：收/付/分类 自动识别
// 一屏多发 → 一次发完：前端把同一屏要的 GET 攒起来一起送来，省掉弱网下十几次往返
app.post('/batch', async (c) => {
  let body = {}
  try { body = await c.req.json() } catch (e) { body = {} }
  const qs = Array.isArray(body.qs) ? body.qs.slice(0, 16) : []
  if (!qs.length) return c.json({ ok: false, error: '没说要取什么' })
  const hdrs = {}
  for (const [k, v] of c.req.raw.headers.entries()) {
    const kk = k.toLowerCase()
    if (kk === 'content-length' || kk === 'content-type' || kk === 'host') continue
    hdrs[k] = v
  }
  const origin = new URL(c.req.url).origin
  const one = async (q) => {
    const path = String(q || '')
    if (!path.startsWith('/') || path.startsWith('/batch') || path.startsWith('/auth')) return { ok: false, error: '这个不能批量取' }
    try {
      const r = await app.fetch(new Request(origin + path, { method: 'GET', headers: hdrs }), c.env, c.executionCtx)
      const t = await r.text()
      try { return JSON.parse(t) } catch (e) { return { ok: false, error: '返回不是 JSON' } }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 120) }
    }
  }
  const results = await Promise.all(qs.map(one))
  return c.json({ ok: true, count: results.length, results })
})

app.post('/quick', async (c) => {
  const { text, account_id } = await c.req.json()
  const s = String(text || '').trim()
  const am = s.match(/(\d+(?:\.\d+)?)/)
  if (!s || !am) return c.json({ error: '没识别出内容，请带上金额，如：收张老板加工费5000' }, 400)
  const amount = num(am[1])
  if (amount <= 0) return c.json({ error: '金额无效' }, 400)
  const rest = s.replace(am[1], '').replace(/[元块钱\s]/g, '')
  const db = c.env.DB
  if (await isMonthLocked(db, now().slice(0, 7))) return c.json({ error: '本月已结账锁定，先解锁再记账' }, 403)
  const t = now()
  const acc = num(account_id) || (await defaultAccountId(db))
  const cats = ['工资', '水电', '房租', '采购', '辅料', '运费', '维修', '税金', '其他']
  let summary = ''
  if (/收/.test(s)) {
    const name = rest.replace(/[收收到到自从]/g, '').replace(/[的了给]/g, '').trim() || '客户'
    await db.prepare('INSERT INTO orders (customer, item_name, price, status, paid, created_at) VALUES (?,?,?,0,0,?)')
      .bind(name, '一句话记账', amount, t).run()
    summary = `应收 ${name} ${amount} 元`
  } else if (/付|转给|打给|给了?/.test(s) && cats.some((k) => s.includes(k))) {
    const cat = cats.find((k) => s.includes(k))
    const name = rest.replace(/付给|付款|支付|付|转给|打给|给了?/g, '').replace(cat, '').replace(/[的了]/g, '').trim() || '其他'
    await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('out','expense',0,?,?,?,?,1,?)")
      .bind(amount, cat, name, acc, t).run()
    summary = `支出 ${cat} ${amount} 元`
  } else if (/付|转给|打给|给了?/.test(s)) {
    const name = rest.replace(/付给|付款|支付|付|转给|打给|给了?/g, '').replace(/[货款的了]/g, '').trim() || '供应商'
    await db.prepare('INSERT INTO payables (supplier, amount, paid, category, remark, created_at) VALUES (?,?,0,?,?,?)')
      .bind(name, amount, '', '', t).run()
    summary = `应付 ${name} ${amount} 元`
  } else if (cats.some((k) => s.includes(k))) {
    const cat = cats.find((k) => s.includes(k))
    const name = rest.replace(cat, '').replace(/[的了]/g, '').trim() || ''
    await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('out','expense',0,?,?,?,?,1,?)")
      .bind(amount, cat, name, acc, t).run()
    summary = `支出 ${cat} ${amount} 元`
  } else {
    return c.json({ error: '没识别出收/付/分类，请写如：收张老板5000、付货款3000、工资5000' }, 400)
  }
  await logAudit(db, '一句话记账', '', summary, '', act(c))
  return c.json({ ok: true, summary })
})

// 批量导入
// 批量导入核心：rows = [[单元格, ...], ...]（首行若是表头会自动跳过）
async function importRows(db, type, rows, opts) {
  let n = 0
  let skippedLocked = 0
  const o = opts || {}
  const dups = []
  const ids = []
  let total = 0
  const t = now()
  // 批次号：这批是哪天、第几次导的，单据上留一个，出问题能追回是哪一批
  const batch = 'IM' + t.replace(/\D/g, '').slice(0, 14) + String(Math.floor(Math.random() * 90) + 10)
  const tag = async (tbl, id) => {
    if (!id) return
    try { await db.prepare('UPDATE ' + tbl + ' SET import_batch=? WHERE id=?').bind(batch, id).run() } catch (e) { /* 老库没有这列也不影响导入 */ }
  }

  // 第一行像表头才跳过（Excel 模板带表头）。判定要严：整行没有任何数字、且至少 2 个表头关键词，
  // 否则像“甲客户,加工,1000”这种正常数据行会被误当成表头吃掉。
  if (rows.length && rows[0] && rows[0].length) {
    const KW = /客户|供应商|金额|分类|姓名|员工|产品|项目|日期|备注|摘要/
    const first = rows[0]
    const numish = first.filter((x) => /^[\d.,%\-\s]*$/.test(String(x === null || x === undefined ? '' : x).trim()) && String(x === null || x === undefined ? '' : x).trim() !== '').length
    const wordy = first.filter((x) => KW.test(String(x === null || x === undefined ? '' : x))).length
    if (numish === 0 && wordy >= 2) rows = rows.slice(1)
  }
  for (const row of rows) {
    let p = row.slice()
    // 最后一列若是日期，单独取出；否则按今天
    let d = t
    if (p.length > 1 && looksLikeDate(p[p.length - 1])) {
      d = toIsoDate(p.pop())
    } else if (type === 'ar_init' || type === 'ap_init') {
      // 期初余额：不带日期就记到今年 1 月 1 日（表示“以前欠下的”）
      d = `${todayIso().slice(0, 4)}-01-01T00:00:00.000Z`
    }
    if (await isMonthLocked(db, (d || '').slice(0, 7))) { skippedLocked++; continue }
    if (type === 'ar') {
      const [customer, item, price, cost, dueC, operC] = p
      if (customer && num(price) > 0) {
        const dk = (d || t).slice(0, 10)
        const from = addDaysIso(dk, -7)
        const hit = await db.prepare("SELECT id, created_at FROM orders WHERE customer=? AND price=? AND substr(created_at,1,10)>=? AND substr(created_at,1,10)<=?").bind(customer, num(price), from, dk).first()
        if (hit && !o.confirmDup) { dups.push({ party: customer, amount: num(price), date: (hit.created_at || '').slice(0, 10), id: hit.id, kind: 'ar' }); continue }
        const dueIso = dueC && looksLikeDate(dueC) ? toIsoDate(dueC) : await termDue(db, customer, d, 'ar')
        const w = await db.prepare('INSERT INTO orders (customer, item_name, price, status, paid, cost, due_date, operator, created_at, import_batch) VALUES (?,?,?,0,0,?,?,?,?,?)')
          .bind(customer, item || '批量导入', num(price), round2(num(cost)), dueIso || null, operC ? String(operC).trim() : null, d, batch).run()
        if (w.meta && w.meta.last_row_id) ids.push(w.meta.last_row_id)
        total += num(price)
        n++
      }
    } else if (type === 'ar_init') {
      const [customer, price] = p
      if (customer && num(price) > 0) {
        const w = await db.prepare('INSERT INTO orders (customer, item_name, price, status, paid, created_at, import_batch) VALUES (?,?,?,0,0,?,?)')
          .bind(customer, '期初欠款', num(price), d, batch).run()
        if (w.meta && w.meta.last_row_id) ids.push(w.meta.last_row_id)
        total += num(price)
        n++
      }
    } else if (type === 'ap') {
      const [supplier, amount, remark, dueP, operP] = p
      if (supplier && num(amount) > 0) {
        const dk = (d || t).slice(0, 10)
        const hit = await db.prepare("SELECT id, created_at FROM payables WHERE supplier=? AND amount=? AND substr(created_at,1,10)>=? AND substr(created_at,1,10)<=?").bind(supplier, num(amount), addDaysIso(dk, -7), dk).first()
        if (hit && !o.confirmDup) { dups.push({ party: supplier, amount: num(amount), date: (hit.created_at || '').slice(0, 10), id: hit.id, kind: 'ap' }); continue }
        const dueIso = dueP && looksLikeDate(dueP) ? toIsoDate(dueP) : await termDue(db, supplier, d, 'ap')
        const w = await db.prepare('INSERT INTO payables (supplier, amount, paid, category, remark, due_date, operator, created_at, import_batch) VALUES (?,?,0,?,?,?,?,?,?)')
          .bind(supplier, num(amount), '', remark || '', dueIso || null, operP ? String(operP).trim() : null, d, batch).run()
        if (w.meta && w.meta.last_row_id) ids.push(w.meta.last_row_id)
        total += num(amount)
        n++
      }
    } else if (type === 'ap_init') {
      const [supplier, amount] = p
      if (supplier && num(amount) > 0) {
        const w = await db.prepare('INSERT INTO payables (supplier, amount, paid, category, remark, created_at, import_batch) VALUES (?,?,0,?,?,?,?)')
          .bind(supplier, num(amount), '', '期初欠款', d, batch).run()
        if (w.meta && w.meta.last_row_id) ids.push(w.meta.last_row_id)
        total += num(amount)
        n++
      }
    } else if (type === 'expense') {
      const [amount, category, remark, operE] = p
      if (num(amount) > 0) {
        const dk = (d || t).slice(0, 10)
        const hit = await db.prepare("SELECT id, created_at FROM ledger WHERE ref_type='expense' AND amount=? AND category=? AND substr(created_at,1,10)>=? AND substr(created_at,1,10)<=?").bind(num(amount), category || '', addDaysIso(dk, -7), dk).first()
        if (hit && !o.confirmDup) { dups.push({ party: category || '支出', amount: num(amount), date: (hit.created_at || '').slice(0, 10), id: hit.id, kind: 'expense' }); continue }
        const accI = await defaultAccountId(db)
        const w = await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, operator, account_id, cash, created_at, import_batch) VALUES ('out','expense',0,?,?,?,?,?,1,?,?)")
          .bind(num(amount), category || '', remark || '', operE ? String(operE).trim() : null, accI, d, batch).run()
        if (w.meta && w.meta.last_row_id) ids.push(w.meta.last_row_id)
        total += num(amount)
        n++
      }
    } else if (type === 'loan') {
      const [staff, amount, remark] = p
      if (staff && num(amount) > 0) {
        const accI = await defaultAccountId(db)
        const r = await db.prepare('INSERT INTO loans (staff, amount, used, returned, remark, account_id, created_at, import_batch) VALUES (?,?,0,0,?,?,?,?)')
          .bind(staff, num(amount), remark || '', accI, d, batch).run()
        const lid = r.meta && r.meta.last_row_id ? r.meta.last_row_id : 0
        if (lid) ids.push(lid)
        total += num(amount)
        await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('out','loan',?,?,'借支',?,?,1,?)")
          .bind(lid, num(amount), `借支 ${staff}${remark ? ' ' + remark : ''}`, accI, d).run()
        n++
      }
    } else if (type === 'reimb') {
      const [staff, amount, category, remark] = p
      if (staff && num(amount) > 0) {
        const accI = await defaultAccountId(db)
        await reimburseStaff(db, staff, num(amount), category || '', remark || '', d, accI)
        n++
      }
    }
  }
  await logAudit(db, '批量导入', type, `导入 ${n} 条${skippedLocked ? `，跳过锁定 ${skippedLocked} 条` : ''}${dups.length ? `，疑似重复 ${dups.length} 条未导入` : ''}`, '', o.by)
  return { imported: n, skipped_locked: skippedLocked, dup: dups, dup_count: dups.length, ids, total: round2(total), batch }
}

// ===== 账期 / 对账周期 / 催款清单 =====
app.get('/party-terms', async (c) => {
  const db = c.env.DB
  const terms = (await db.prepare('SELECT * FROM party_terms ORDER BY party').all()).results || []
  const ar = (await db.prepare("SELECT customer AS party, COUNT(*) cnt, COALESCE(SUM(MAX(0, price-paid-COALESCE(written_off,0))),0) left_amt, MIN(created_at) oldest FROM orders WHERE price-paid-COALESCE(written_off,0) > 0 GROUP BY customer").all()).results || []
  const ap = (await db.prepare("SELECT supplier AS party, COUNT(*) cnt, COALESCE(SUM(MAX(0, amount-paid-COALESCE(written_off,0))),0) left_amt, MIN(created_at) oldest FROM payables WHERE amount-paid-COALESCE(written_off,0) > 0 GROUP BY supplier").all()).results || []
  const recon = (await db.prepare('SELECT party, MAX(created_at) last_at, COUNT(*) times FROM recon_log GROUP BY party').all()).results || []
  const find = (arr, p) => arr.find((x) => x.party === p)
  const rows = terms.map((t) => {
    const a = find(ar, t.party) || {}
    const b = find(ap, t.party) || {}
    const r = find(recon, t.party) || {}
    const oldest = [a.oldest, b.oldest].filter(Boolean).sort()[0] || ''
    return {
      id: t.id, party: t.party, kind: t.kind || 'ar', term_days: num(t.term_days), recon_cycle: num(t.recon_cycle), recon_day: num(t.recon_day), note: t.note || '',
      ar_left: round2(num(a.left_amt)), ar_cnt: num(a.cnt), ap_left: round2(num(b.left_amt)), ap_cnt: num(b.cnt),
      oldest_days: oldest ? daysSince(oldest) : 0, last_recon: r.last_at || '', recon_times: num(r.times),
      recon_due: num(t.recon_cycle) > 0 ? (!r.last_at || daysSince(r.last_at) >= num(t.recon_cycle)) : false
    }
  })
  // 没设账期、但有欠款的单位也列出来，方便一键设置
  const known = new Set(terms.map((t) => t.party))
  const extra = []
  for (const x of ar) if (!known.has(x.party) && num(x.left_amt) > 0) extra.push({ party: x.party, kind: 'ar', left: round2(num(x.left_amt)) })
  for (const x of ap) if (!known.has(x.party) && num(x.left_amt) > 0) extra.push({ party: x.party, kind: 'ap', left: round2(num(x.left_amt)) })
  return c.json({ ok: true, rows, unset: extra.slice(0, 30) })
})

app.post('/party-terms', async (c) => {
  const db = c.env.DB
  const b = await c.req.json()
  const party = String(b.party || '').trim()
  if (!party) return c.json({ error: '要填单位名' }, 400)
  const kind = (b.kind === 'ap' ? 'ap' : 'ar')
  const term = Math.max(0, Math.min(365, num(b.term_days)))
  const cycle = Math.max(0, Math.min(365, num(b.recon_cycle)))
  const rday = Math.max(0, Math.min(28, num(b.recon_day)))  // 每月几号发对账单（0=不设）
  const note = String(b.note || '')
  const old = await db.prepare('SELECT * FROM party_terms WHERE party=?').bind(party).first()
  if (old) await db.prepare('UPDATE party_terms SET kind=?, term_days=?, recon_cycle=?, recon_day=?, note=? WHERE id=?').bind(kind, term, cycle, rday, note, old.id).run()
  else await db.prepare('INSERT INTO party_terms (party, kind, term_days, recon_cycle, recon_day, note, created_at) VALUES (?,?,?,?,?,?,?)').bind(party, kind, term, cycle, rday, note, now()).run()
  await logAudit(db, '账期设置', party, `账期 ${term} 天，对账周期 ${cycle} 天` + (rday ? `，每月 ${rday} 号发对账单` : ''))
  return c.json({ ok: true })
})

// 对账日历：每家约好「每月几号发对账单」，到点提醒，别漏
app.get('/recon-calendar', async (c) => {
  const db = c.env.DB
  const today = now().slice(0, 10)
  const dnum = num(today.slice(8, 10))
  const curM = today.slice(0, 7)
  const terms = (await db.prepare('SELECT * FROM party_terms WHERE COALESCE(recon_day,0) > 0 ORDER BY recon_day').all()).results || []
  const ar = (await db.prepare("SELECT customer party, COALESCE(SUM(MAX(0, price-paid-COALESCE(written_off,0))),0) t FROM orders WHERE price-paid-COALESCE(written_off,0) > 0 GROUP BY customer").all()).results || []
  const ap = (await db.prepare("SELECT supplier party, COALESCE(SUM(MAX(0, amount-paid-COALESCE(written_off,0))),0) t FROM payables WHERE amount-paid-COALESCE(written_off,0) > 0 GROUP BY supplier").all()).results || []
  const sent = (await db.prepare("SELECT party, MAX(created_at) last_at FROM statement_log WHERE substr(created_at,1,7)=? GROUP BY party").bind(curM).all()).results || []
  const left = {}, sentM = {}
  for (const x of ar.concat(ap)) left[norm(x.party)] = round2(num(left[norm(x.party)]) + num(x.t))
  for (const x of sent) sentM[norm(x.party)] = String(x.last_at || '').slice(0, 10)
  const rows = terms.map((t) => {
    const k = norm(t.party)
    const d = num(t.recon_day)
    const done = !!sentM[k]
    const late = dnum - d
    const st = done ? 'sent' : (late === 0 ? 'today' : (late > 0 ? 'overdue' : 'upcoming'))
    return {
      party: t.party, kind: t.kind === 'ap' ? 'ap' : 'ar', day: d, left: round2(num(left[k])),
      sent_at: sentM[k] || '', state: st,
      state_text: st === 'sent' ? '本月已发' : (st === 'today' ? '今天该发' : (st === 'overdue' ? '晚了 ' + late + ' 天' : late === -1 ? '明天发' : Math.abs(late) + ' 天后')),
      days_late: st === 'overdue' ? late : 0
    }
  })
  // 每家现成的话术 + 签名打印链接（点一下就能发，不用再翻对账单页）
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  const base = new URL(c.req.url).origin
  const cntMap = {}
  for (const x of ((await db.prepare("SELECT customer party, COUNT(*) n FROM orders WHERE price-COALESCE(paid,0)-COALESCE(written_off,0) > 0 GROUP BY customer").all()).results || [])) cntMap['ar|' + norm(x.party)] = num(x.n)
  for (const x of ((await db.prepare("SELECT supplier party, COUNT(*) n FROM payables WHERE amount-COALESCE(paid,0)-COALESCE(written_off,0) > 0 GROUP BY supplier").all()).results || [])) cntMap['ap|' + norm(x.party)] = num(x.n)
  for (const r of rows) {
    const n = num(cntMap[r.kind + '|' + norm(r.party)])
    r.open_cnt = n
    r.send_text = r.left > 0
      ? `${r.party}，对一下账：到 ${today}，还有 ${n} 笔${r.kind === 'ap' ? '货款' : '加工费'}没结，共 ${r.left} 元。明细我发你对账单，方便的话今天核一下，有出入随时说。`
      : `${r.party}，${today} 对一下账：这边账上你这边的款都结清了，你看有没有对不上的地方。`
    const t = saved ? await sigOf(saved, r.party, r.kind) : ''
    r.url = t ? `${base}/statement-print?type=${r.kind}&party=${encodeURIComponent(r.party)}&t=${t}` : ''
  }
  const pick = (st) => rows.filter((r) => r.state === st)
  const todayList = pick('today'), over = pick('overdue'), soon = pick('upcoming')
  const pend = over.concat(todayList)
  const advice = pend.length
    ? '有 ' + pend.length + ' 家到点没发对账单（涉及欠款 ¥' + round2(pend.reduce((a, r) => a + r.left, 0)) + '），先发单再催，效果最好。'
    : (soon.length ? '今天没有到期的，最近 ' + soon.length + ' 家在这几天发单。' : '该发的对账单都发过了，节奏稳。')
  const sumLeft = round2(pend.reduce((a, r) => a + r.left, 0))
  const text = !rows.length
    ? '还没有单位约好「每月几号发对账单」。在下面「账期」里给常来往的几家填个日子（比如每月 5 号），到日子这里就会列出来。'
    : (pend.length
      ? `今天该发对账单的有 ${todayList.length} 家、晚了的有 ${over.length} 家（涉及欠款 ¥${sumLeft}）。先发单再催，对方更容易认账。`
      : `今天没有到点的，最近 ${soon.length} 家在这几天发单。`)
  return c.json({
    ok: true, today, rows, today_count: todayList.length, overdue_count: over.length,
    upcoming_count: soon.length, pending_total: sumLeft,
    today_list: todayList, overdue_list: over, upcoming_list: soon, advice, text,
    count: rows.length, sent_count: rows.filter((r) => r.state === 'sent').length
  })
})
app.delete('/party-terms/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM party_terms WHERE id=?').bind(num(c.req.param('id'))).run()
  return c.json({ ok: true })
})

// 给某个单位现有的未结单补上到期日（按账期算）
app.post('/party-terms/apply', async (c) => {
  const db = c.env.DB
  const { party } = await c.req.json()
  const p = String(party || '').trim()
  if (!p) return c.json({ error: '要填单位名' }, 400)
  const t = await db.prepare('SELECT * FROM party_terms WHERE party=?').bind(p).first()
  if (!t || num(t.term_days) <= 0) return c.json({ error: '这家还没设账期' }, 400)
  const days = num(t.term_days)
  let n = 0
  for (const tbl of ['orders', 'payables']) {
    const col = tbl === 'orders' ? 'customer' : 'supplier'
    const amt = tbl === 'orders' ? 'price' : 'amount'
    const rows = (await db.prepare(`SELECT id, created_at FROM ${tbl} WHERE ${col}=? AND ${amt}-paid-COALESCE(written_off,0) > 0 AND (due_date IS NULL OR due_date='')`).bind(p).all()).results || []
    for (const r of rows) {
      await db.prepare(`UPDATE ${tbl} SET due_date=? WHERE id=?`).bind(addDaysIso(r.created_at || now(), days) + 'T00:00:00.000Z', r.id).run()
      n++
    }
  }
  return c.json({ ok: true, updated: n })
})

// 催款清单：按「欠得久 × 欠得多」排，话术现成
// ── 付款承诺：答应哪天付、到底付没付（失约记账）──
async function promiseBook(db, days, type) {
  const since = dayAgo(days)
  const prows = (await db.prepare("SELECT id, party, type, note, promise_date, created_at FROM dunning_log WHERE promise_date IS NOT NULL AND substr(promise_date,1,10)>=? ORDER BY id DESC LIMIT 500").bind(since).all().catch(() => ({ results: [] }))).results || []
  const flows = type === 'ap'
    ? (await db.prepare("SELECT p.supplier AS party, l.created_at AS d, l.amount AS a FROM ledger l JOIN payables p ON l.ref_type='payable' AND l.ref_id=p.id WHERE l.direction='out'").all().catch(() => ({ results: [] }))).results || []
    : (await db.prepare("SELECT o.customer AS party, l.created_at AS d, l.amount AS a FROM ledger l JOIN orders o ON l.ref_type='order' AND l.ref_id=o.id WHERE l.direction='in'").all().catch(() => ({ results: [] }))).results || []
  const unpaid = {}
  try {
    const q = type === 'ap'
      ? 'SELECT supplier AS party, COALESCE(SUM(amount-paid-COALESCE(written_off,0)),0) t FROM payables WHERE amount-paid-COALESCE(written_off,0) > 0 GROUP BY supplier'
      : 'SELECT customer AS party, COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) t FROM orders WHERE price-paid-COALESCE(written_off,0) > 0 GROUP BY customer'
    for (const r of (await db.prepare(q).all()).results || []) unpaid[norm(r.party)] = round2(num(unpaid[norm(r.party)]) + num(r.t))
  } catch (e) {}
  const today = todayIso()
  const fmap = {}
  for (const f of flows) {
    const k = norm(f.party)
    ;(fmap[k] || (fmap[k] = [])).push({ d: String(f.d || '').slice(0, 10), a: num(f.a) })
  }
  const rows = prows.map((r) => {
    const made = String(r.created_at || '').slice(0, 10)
    const pd = String(r.promise_date || '').slice(0, 10)
    const left = round2(num(unpaid[norm(r.party)]))
    const paidIn = round2((fmap[norm(r.party)] || []).filter((f) => f.d >= made && f.d <= addDaysIso(pd, 1)).reduce((a, f) => a + f.a, 0))
    let outcome = 'pending'
    if (paidIn > 0.005) outcome = 'kept'
    else if (pd < today) outcome = left > 0.005 ? 'broken' : 'kept'
    return { id: num(r.id), party: r.party || '', promise_made: made, promise_date: pd, days_late: pd < today ? daysSince(pd) : 0, paid_since: paidIn, left, outcome, note: String(r.note || '').slice(0, 60) }
  })
  const pmap = {}
  for (const r of rows) {
    const k = norm(r.party)
    const p = pmap[k] || (pmap[k] = { party: r.party, promises: 0, kept: 0, broken: 0, pending: 0, left: r.left, last_promise: '', last_broken: '', broken_amt: 0 })
    p.promises++
    p[r.outcome]++
    if (r.promise_date > p.last_promise) p.last_promise = r.promise_date
    if (r.outcome === 'broken' && r.promise_date > p.last_broken) { p.last_broken = r.promise_date; p.broken_amt = r.left }
  }
  const parties = Object.keys(pmap).map((k) => {
    const p = pmap[k]
    const done = p.kept + p.broken
    const rate = done ? Math.round((p.kept / done) * 100) : null
    const text = p.broken
      ? `${p.party}：答应过 ${p.promises} 次，兑现 ${p.kept} 次、失约 ${p.broken} 次${p.last_broken ? `，最近一次说 ${p.last_broken.slice(5)} 付` : ''}`
      : `${p.party}：答应 ${p.promises} 次${p.kept ? `，兑现 ${p.kept} 次` : ''}${p.pending ? `，还有 ${p.pending} 次没到日子` : ''}`
    return { ...p, rate, text }
  }).sort((a, b) => b.broken - a.broken || b.promises - a.promises)
  const keptN = rows.filter((r) => r.outcome === 'kept').length
  const brokenN = rows.filter((r) => r.outcome === 'broken').length
  const pendingN = rows.filter((r) => r.outcome === 'pending').length
  const doneN = keptN + brokenN
  const rate = doneN ? Math.round((keptN / doneN) * 100) : null
  const brokenAmt = round2(rows.filter((r) => r.outcome === 'broken').reduce((a, r) => a + r.left, 0))
  const advice = []
  if (brokenN) advice.push({ tone: 'warn', text: `有 ${brokenN} 次答应付款没兑现（涉及 ${parties.filter((p) => p.broken).length} 家、还欠 ¥${brokenAmt}）：下次别只听日子，让他先付一部分。` })
  if (rate !== null && rate >= 80 && doneN >= 2) advice.push({ tone: 'ok', text: `答应过的 ${doneN} 次里兑现 ${keptN} 次（${rate}%），这家说话算数，可以适当宽限。` })
  if (pendingN) advice.push({ tone: 'info', text: `还有 ${pendingN} 次承诺没到日子，到那天没付会提醒你。` })
  if (!rows.length) advice.push({ tone: 'info', text: '还没有记过「答应哪天付」。催款时填一下承诺日，到日子没付这里会红字提醒你。' })
  return {
    ok: true, days, type, rows, parties,
    count: rows.length, kept_n: keptN, broken_n: brokenN, pending_n: pendingN, rate, broken_amt: brokenAmt,
    advice,
    text: rows.length
      ? `最近 ${days} 天记过 ${rows.length} 次付款承诺：兑现 ${keptN} 次、失约 ${brokenN} 次${pendingN ? `、还有 ${pendingN} 次没到日子` : ''}${rate !== null ? `（兑现率 ${rate}%）` : ''}。`
      : '还没有记过付款承诺。催款时顺手填一句「答应哪天付」，到日子没付这里会提醒你，也能看出哪家说话算数。'
  }
}
app.get('/promise-book', async (c) => {
  const db = c.env.DB
  const days = Math.min(1095, Math.max(30, Math.round(Number(c.req.query('days')) || 365)))
  const type = c.req.query('type') === 'ap' ? 'ap' : 'ar'
  return c.json(await promiseBook(db, days, type))
})

app.get('/collect-list', async (c) => {
  const db = c.env.DB
  const type = c.req.query('type') === 'ap' ? 'ap' : 'ar'
  const cfgRow = await db.prepare("SELECT value FROM settings WHERE key='collect_min_days'").first().catch(() => null)
  const cfgMin = num(cfgRow && cfgRow.value)
  const minDays = Math.max(0, c.req.query('min_days') != null ? num(c.req.query('min_days')) : cfgMin)
  const title = (await getTitle(db)).title
  const tbl = type === 'ap' ? 'payables' : 'orders'
  const col = type === 'ap' ? 'supplier' : 'customer'
  const amt = type === 'ap' ? 'amount' : 'price'
  const rows = (await db.prepare(`SELECT ${col} AS party, COUNT(*) cnt, COALESCE(SUM(${amt}-paid-COALESCE(written_off,0)),0) left_amt, MIN(created_at) oldest, MAX(CASE WHEN due_date IS NOT NULL THEN due_date END) due FROM ${tbl} WHERE ${amt}-paid-COALESCE(written_off,0) > 0 GROUP BY ${col}`).all()).results || []
  // 每家的历史付款速度（结清的单平均几天付清）——用来判断「催得动」还是「一直拖」
  const histSql = type === 'ap'
    ? "SELECT o.supplier AS party, o.created_at AS c_at, MAX(l.created_at) AS last_pay FROM payables o JOIN ledger l ON l.ref_type='payable' AND l.ref_id=o.id AND l.direction='out' WHERE o.paid + COALESCE(o.written_off,0) >= o.amount GROUP BY o.id"
    : "SELECT o.customer AS party, o.created_at AS c_at, MAX(l.created_at) AS last_pay FROM orders o JOIN ledger l ON l.ref_type='order' AND l.ref_id=o.id AND l.direction='in' WHERE o.paid + COALESCE(o.written_off,0) >= o.price GROUP BY o.id"
  const histRows = (await db.prepare(histSql).all()).results || []
  const hstat = {}
  for (const h of histRows) {
    const a = Date.parse(h.c_at || ''); const b = Date.parse(h.last_pay || '')
    if (!a || !b || b < a) continue
    const k = norm(h.party)
    const st = hstat[k] || (hstat[k] = { sum: 0, n: 0 })
    st.sum += (b - a) / 86400000
    st.n++
  }
  const list = rows.map((r) => {
    const days = daysSince(r.oldest)
    const dueOver = r.due ? Math.max(0, daysSince(r.due)) : 0
    const h = hstat[norm(r.party)]
    const avgPay = h && h.n ? round2(h.sum / h.n) : null
    const wDays = 0.5 + Math.min(days, 180) / 60
    const wRel = avgPay ? Math.min(1.6, Math.max(0.6, 60 / Math.max(avgPay, 1))) : 1
    const wDue = 1 + Math.min(dueOver, 90) / 30
    const why = ['欠 ' + days + ' 天']
    if (dueOver > 0) why.push('已逾期 ' + dueOver + ' 天')
    if (avgPay) why.push('平时 ' + avgPay + ' 天就付')
    return {
      party: r.party || '', left: round2(num(r.left_amt)), cnt: num(r.cnt), oldest_days: days,
      due: r.due || '', over_due: dueOver, avg_pay_days: avgPay, score: Math.round(num(r.left_amt) * wDays * wRel * wDue), why: why.join(' · ')
    }
  }).filter((x) => x.left > 0.005 && x.oldest_days >= minDays)
  list.sort((a, b) => b.score - a.score)
  // 催款记录：这一家催过几次、上次哪天、几天前
  const dmap = {}
  try {
    const drows = (await db.prepare("SELECT party, COUNT(*) n, MAX(created_at) last FROM dunning_log GROUP BY party").all()).results || []
    drows.forEach((r) => { dmap[norm(r.party)] = { n: num(r.n), last: String(r.last || '') } })
  } catch (e) {}
  // 对方对账回执：说「对得上」催款更硬气；说「对不上」先核数别催钱
  const amap = {}
  try {
    const arows = (await db.prepare("SELECT party, ack, ack_at, note, month, resolved_at, created_at FROM statement_log WHERE type=? AND ack IN ('ok','doubt') ORDER BY id DESC LIMIT 400").bind(type).all()).results || []
    for (const a of arows) { const k = norm(a.party); if (!amap[k]) amap[k] = a }
  } catch (e) {}
  // 付款承诺：答应过哪天付、有没有失约（话术里点一句，比空催管用）
  const pb = await promiseBook(db, 365, type).catch(() => ({ parties: [] }))
  const pbmap = {}
  for (const p of (pb.parties || [])) pbmap[norm(p.party)] = p
  const out = list.slice(0, 20).map((x, i) => Object.assign({}, x, (() => {
    const dm = dmap[norm(x.party)]
    const last = dm && dm.last ? dm.last.slice(0, 10) : ''
    return { told_times: dm ? dm.n : 0, told_last: last, told_days: last ? daysSince(last) : null, told_text: dm ? ('已催 ' + dm.n + ' 次，上次 ' + last.slice(5) + '（' + daysSince(last) + ' 天前）') : '还没催过' }
  })(), (() => {
    const a = amap[norm(x.party)]
    let kind = '', ackDays = null, ackNote = '', ackMonth = ''
    if (a) {
      kind = a.ack === 'ok' ? 'ok' : (String(a.resolved_at || '') ? 'fixed' : 'doubt')
      ackDays = daysSince(a.ack_at || a.created_at)
      ackNote = String(a.note || '').replace(/^对方说对不上[，,]?/, '').replace(/^对方确认[:：]?/, '').trim()
      ackMonth = String(a.month || '')
    }
    const ackText = kind === 'ok' ? `对方 ${ackDays} 天前确认过对得上`
      : kind === 'doubt' ? `对方 ${ackDays} 天前说对不上${ackNote ? '（' + ackNote + '）' : ''}`
      : kind === 'fixed' ? '对方提的差异已核清' : ''
    const pk = pbmap[norm(x.party)]
    const promiseText = pk && pk.broken ? `上回答应 ${String(pk.last_broken).slice(5, 10)} 付，又没付（${daysSince(pk.last_broken)} 天前）` : ''
    const lead = promiseText ? promiseText + '。' : ''
    let text
    if (type === 'ap') {
      text = `${x.party} 你好，我这边欠你 ${x.left} 元（${x.cnt} 笔，最早 ${x.oldest_days} 天前）${title}，这两天安排一下，方便的话把对账单发我对一下。`
    } else if (kind === 'ok' && ackDays !== null && ackDays <= 120) {
      text = `${x.party} 你好，${lead}${title}账上你这边还有 ${x.left} 元没结（${x.cnt} 笔，最早 ${x.oldest_days} 天前）。${ackMonth ? ackMonth + ' ' : ''}我们对过账，您那边确认过对得上，这笔数没疑问，麻烦这两天安排一下，谢谢。`
    } else if (kind === 'doubt') {
      text = `${x.party} 你好，上次对账您说有一笔对不上${ackNote ? '（' + ackNote + '）' : ''}，我这边先把数核清楚，核完把明细发您。数对上了咱再谈结款，不着急。`
    } else if (kind === 'fixed') {
      text = `${x.party} 你好，上次对账您提的差异已经核清补记了。${title}账上现在还有 ${x.left} 元没结（${x.cnt} 笔，最早 ${x.oldest_days} 天前），方便的话这两天结一下。`
    } else {
      text = `${x.party} 你好，${lead}${title}账上你这边还有 ${x.left} 元没结（${x.cnt} 笔，最早 ${x.oldest_days} 天前）${x.due ? `，约定 ${String(x.due).slice(5, 10)} 到期` : ''}。方便的话这两天结一下，或者把对账单发我核一核。`
    }
    return { ack_kind: kind, ack_days: ackDays, ack_note: ackNote, ack_text: ackText, hold: kind === 'doubt', text,
      promise_text: promiseText, promise_broken: pk ? pk.broken : 0, promise_rate: pk ? pk.rate : null }
  })()))
  const total = round2(list.reduce((a, x) => a + x.left, 0))
  const okN = out.filter((x) => x.ack_kind === 'ok').length
  const holdN = out.filter((x) => x.hold).length
  const holdAmt = round2(out.filter((x) => x.hold).reduce((a, x) => a + x.left, 0))
  const advice = []
  if (holdN) advice.push({ tone: 'warn', text: `有 ${holdN} 家（共 ¥${holdAmt}）上次对账说对不上：先把数核清再谈钱，话术已经改成核对口径，别硬催。` })
  if (okN) advice.push({ tone: 'ok', text: `${okN} 家确认过对得上：这几家话术里写明了「您确认过」，催起来更硬气。` })
  const brk = out.filter((x) => x.promise_broken > 0)
  if (brk.length) advice.push({ tone: 'warn', text: `${brk.length} 家答应过付款没兑现（${brk.map((x) => x.party + ' ' + x.promise_broken + ' 次').slice(0, 3).join('、')}）：别只听日子，让他先付一部分。` })
  return c.json({ ok: true, type, total, count: list.length, list: out, ok_n: okN, hold_n: holdN, hold_amt: holdAmt, broken_n: brk.length, advice })
})

// ── 月度催款战报：这个月催了几次、催回多少、哪家催了也白催 ──
app.get('/dunning-report', async (c) => {
  const db = c.env.DB
  const type = c.req.query('type') === 'ap' ? 'ap' : 'ar'
  const isAr = type !== 'ap'
  const q = String(c.req.query('month') || '')
  const mm = /^\d{4}-\d{2}$/.test(q) ? q : todayIso().slice(0, 7)
  const pm = monthAdd(mm + '-01', -1).slice(0, 7)
  const tbl = isAr ? 'orders' : 'payables'
  const col = isAr ? 'customer' : 'supplier'
  const amt = isAr ? 'price' : 'amount'
  const OPEN = `${amt}-COALESCE(paid,0)-COALESCE(written_off,0)`
  const duns = (await db.prepare("SELECT id, party, COALESCE(type,'ar') t, note, promise_date, created_at FROM dunning_log WHERE substr(created_at,1,7)=? ORDER BY created_at").bind(mm).all().catch(() => ({ results: [] }))).results || []
  const mine = duns.filter((d) => (String(d.t || 'ar') === 'ap' ? 'ap' : 'ar') === type)
  const paySql = isAr
    ? "SELECT o.customer AS party, substr(l.created_at,1,10) AS d, l.amount AS a FROM ledger l JOIN orders o ON l.ref_type='order' AND l.ref_id=o.id WHERE l.direction='in' AND substr(l.created_at,1,7)=?"
    : "SELECT p.supplier AS party, substr(l.created_at,1,10) AS d, l.amount AS a FROM ledger l JOIN payables p ON l.ref_type='payable' AND l.ref_id=p.id WHERE l.direction='out' AND substr(l.created_at,1,7)=?"
  const pays = (await db.prepare(paySql).bind(mm).all().catch(() => ({ results: [] }))).results || []
  const openRows = (await db.prepare(`SELECT ${col} AS party, COALESCE(SUM(${OPEN}),0) left_amt FROM ${tbl} WHERE ${OPEN}>0.005 GROUP BY ${col}`).all().catch(() => ({ results: [] }))).results || []
  const leftMap = {}
  openRows.forEach((r) => { leftMap[norm(r.party)] = round2(num(r.left_amt)) })
  const payMap = {}
  for (const p of pays) {
    const k = norm(p.party)
    const e = payMap[k] || (payMap[k] = { all: 0, list: [] })
    e.all = round2(e.all + num(p.a))
    e.list.push({ d: String(p.d || '').slice(0, 10), a: num(p.a) })
  }
  const today = todayIso()
  const gmap = {}
  const cb = await creditBook(db, type).catch(() => ({ rows: [] }))
  for (const r of (cb.rows || [])) gmap[norm(r.party)] = r.grade
  // 逐家算：催了几次、首催日、催后收回多少、现在还欠、失约几次
  const byParty = {}
  for (const d of mine) {
    const k = norm(d.party)
    const e = byParty[k] || (byParty[k] = { party: d.party || '', times: 0, first: '', last: '', broken: 0, notes: [] })
    e.times++
    const day = String(d.created_at || '').slice(0, 10)
    if (!e.first || day < e.first) e.first = day
    if (!e.last || day > e.last) e.last = day
    if (d.promise_date && String(d.promise_date).slice(0, 10) < today) e.broken++
    if (d.note && e.notes.length < 3) e.notes.push(String(d.note).slice(0, 20))
  }
  const rows = Object.keys(byParty).map((k) => {
    const e = byParty[k]
    const pm2 = payMap[k] || { all: 0, list: [] }
    const after = round2(pm2.list.filter((x) => x.d >= e.first).reduce((a, x) => a + x.a, 0))
    const left = round2(num(leftMap[k]))
    let state = 'waiting'
    if (after > 0.005) state = left > 0.005 ? 'part' : 'paid'
    else if (e.times >= 3) state = 'useless'
    else if (e.broken > 0) state = 'broken'
    const state_text = {
      paid: '催回了，钱已到账',
      part: '催回一部分，还欠 ¥' + left,
      broken: '答应过付款又没付',
      useless: '催了 ' + e.times + ' 次，一分没回' + (e.broken ? '（答应过 ' + e.broken + ' 次也没付）' : ''),
      waiting: '刚催过，还没动静'
    }[state]
    const per = e.times ? round2(after / e.times) : 0
    return {
      party: e.party, times: e.times, first: e.first, last: e.last, broken: e.broken,
      paid_month: round2(pm2.all), paid_after: after, left, state, state_text,
      per_time: per, grade: gmap[k] || 'N', notes: e.notes.join(' / ')
    }
  })
  rows.sort((a, b) => (a.state === 'useless' || a.state === 'broken' ? 0 : 1) - (b.state === 'useless' || b.state === 'broken' ? 0 : 1) || b.paid_after - a.paid_after)
  // 没催但自己付了的
  const dunKeys = new Set(Object.keys(byParty))
  const selfRows = Object.keys(payMap).filter((k) => !dunKeys.has(k)).map((k) => ({
    party: (payMap[k].list && payMap[k].list.length) ? (pays.find((p) => norm(p.party) === k) || {}).party || '' : '',
    paid: round2(payMap[k].all)
  })).filter((x) => x.paid > 0.005).sort((a, b) => b.paid - a.paid)
  const selfAmt = round2(selfRows.reduce((a, x) => a + x.paid, 0))
  const allPaid = round2(pays.reduce((a, x) => a + num(x.a), 0))
  const times = rows.reduce((a, x) => a + x.times, 0)
  const recovered = round2(rows.reduce((a, x) => a + x.paid_after, 0))
  const useless = rows.filter((x) => x.state === 'useless')
  const brokenN = rows.filter((x) => x.state === 'broken').length
  const perTime = times ? round2(recovered / times) : 0
  // 上月对比
  const prevDun = (await db.prepare("SELECT COUNT(*) n FROM dunning_log WHERE substr(created_at,1,7)=?").bind(pm).first().catch(() => null))
  const prevPay = (await db.prepare(paySql.replace('=?', '=?')).bind(pm).all().catch(() => ({ results: [] }))).results || []
  const prevPaid = round2(prevPay.reduce((a, x) => a + num(x.a), 0))
  const pTimes = num(prevDun && prevDun.n)
  const advice = []
  if (!times && !allPaid) advice.push({ tone: 'info', text: `${mm} 没催过款、也没有回款记录。` })
  else if (!times) advice.push({ tone: 'warn', text: `${mm} 一次都没催过，但有 ¥${allPaid} 自己付进来了（${selfRows.length} 家）。老账还是要催一句。` })
  else {
    advice.push({ tone: 'ok', text: `${mm} 催了 ${rows.length} 家共 ${times} 次，催后收回 ¥${recovered}${allPaid > 0 ? `（本月总回款 ¥${allPaid}，占 ${Math.round((recovered / Math.max(allPaid, 1)) * 100)}%）` : ''}，平均每催一次 ¥${perTime}。` })
    if (useless.length) advice.push({ tone: 'warn', text: `${useless.length} 家催了 3 次以上一分没回（${useless.map((x) => x.party + ' 欠 ¥' + x.left).slice(0, 3).join('、')}）：再催也是白费劲，改成打电话或上门，或者先停掉账期。` })
    if (brokenN) advice.push({ tone: 'warn', text: `${brokenN} 家答应过付款又没付：下次别只听日子，让他先付一部分。` })
    if (selfRows.length) advice.push({ tone: 'ok', text: `另有 ${selfRows.length} 家没催自己付了 ¥${selfAmt}（${selfRows.slice(0, 3).map((x) => x.party).join('、')}）：这几家不用花力气。` })
    if (pTimes && times) advice.push({ tone: times > pTimes ? 'ok' : 'info', text: `比上月（催 ${pTimes} 次、回款 ¥${prevPaid}）${times > pTimes ? '多催了 ' + (times - pTimes) + ' 次' : times < pTimes ? '少催了 ' + (pTimes - times) + ' 次' : '次数一样'}。` })
  }
  const text = advice.length ? advice[0].text : ''
  return c.json({
    ok: true, type, month: mm, prev_month: pm,
    times, parties: rows.length, recovered, all_paid: allPaid, self_amt: selfAmt, self_n: selfRows.length,
    per_time: perTime, useless_n: useless.length, broken_n: brokenN,
    prev: { times: pTimes, paid: prevPaid },
    rows, self_rows: selfRows.slice(0, 10), advice, text
  })
})

// ── 这周催款排班：按「金额 × 逾期 × 信用」排优先级，分到具体哪天打 ──
const WD_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const wdOf = (d) => WD_CN[new Date(String(d).slice(0, 10) + 'T00:00:00Z').getUTCDay()] || ''

app.get('/collect-plan', async (c) => {
  const db = c.env.DB
  const type = c.req.query('type') === 'ap' ? 'ap' : 'ar'
  const isAr = type !== 'ap'
  const span = Math.min(14, Math.max(1, Math.round(num(c.req.query('days')) || 7)))
  const perDay = Math.min(6, Math.max(1, Math.round(num(c.req.query('per_day')) || 3)))
  const tbl = isAr ? 'orders' : 'payables'
  const col = isAr ? 'customer' : 'supplier'
  const amt = isAr ? 'price' : 'amount'
  const OPEN = `${amt}-COALESCE(paid,0)-COALESCE(written_off,0)`
  const base = (await db.prepare(`SELECT ${col} AS party, COUNT(*) cnt, COALESCE(SUM(${OPEN}),0) left_amt,
    MIN(substr(created_at,1,10)) oldest, MAX(CASE WHEN due_date IS NOT NULL THEN substr(due_date,1,10) END) due
    FROM ${tbl} WHERE ${OPEN}>0.005 GROUP BY ${col}`).all().catch(() => ({ results: [] }))).results || []
  const dun = {}
  try {
    for (const r of (await db.prepare('SELECT party, COUNT(*) n, MAX(created_at) last FROM dunning_log GROUP BY party').all()).results || []) {
      dun[norm(r.party)] = { n: num(r.n), last: String(r.last || '').slice(0, 10) }
    }
  } catch (e) {}
  const ackm = {}
  try {
    for (const a of (await db.prepare("SELECT party, ack, ack_at, note, resolved_at FROM statement_log WHERE type=? AND ack IN ('ok','doubt') ORDER BY id DESC LIMIT 400").bind(type).all()).results || []) {
      const k = norm(a.party); if (!ackm[k]) ackm[k] = a
    }
  } catch (e) {}
  const cb = await creditBook(db, type).catch(() => ({ rows: [] }))
  const gmap = {}
  for (const r of (cb.rows || [])) gmap[norm(r.party)] = r
  const pb = await promiseBook(db, 365, type).catch(() => ({ parties: [] }))
  const pmap = {}
  for (const p of (pb.parties || [])) pmap[norm(p.party)] = p
  const GW = { A: 0.9, B: 1, C: 1.15, D: 1.3, N: 1 }
  const items = base.map((r) => {
    const k = norm(r.party)
    const left = round2(num(r.left_amt))
    const days = daysSince(r.oldest)
    const over = r.due ? Math.max(0, daysSince(r.due)) : 0
    const g = gmap[k]
    const grade = g ? g.grade : 'N'
    const a = ackm[k]
    const hold = !!(a && a.ack === 'doubt' && !String(a.resolved_at || ''))
    const pm = pmap[k]
    const today = todayIso()
    const wait = pm && num(pm.pending) > 0 && String(pm.last_promise || '') >= today ? String(pm.last_promise).slice(0, 10) : ''
    let score = left * (0.5 + Math.min(days, 180) / 60) * (1 + Math.min(over, 90) / 30) * (GW[grade] || 1)
    if (hold) score *= 0.8
    const dm = dun[k]
    const toldDays = dm && dm.last ? daysSince(dm.last) : null
    const cool = toldDays !== null && toldDays < 2
    if (cool) score *= 0.5
    let act = '发微信'
    if (hold) act = '先核对数'
    else if (wait) act = '等 ' + wait.slice(5, 10) + ' 那天'
    else if (over > 30 || left >= 5000) act = '打电话'
    const why = ['欠 ' + days + ' 天']
    if (over > 0) why.push('逾期 ' + over + ' 天')
    if (left >= 5000) why.push('金额大')
    if (grade === 'C' || grade === 'D') why.push('信用 ' + grade)
    if (hold) why.push('对账说对不上')
    if (cool) why.push(toldDays === 0 ? '今天刚催过' : '刚催过（' + toldDays + ' 天前）')
    return {
      party: r.party || '', left, cnt: num(r.cnt), oldest_days: days, due: r.due || '', over,
      grade, score: Math.round(score), act, why: why.join(' · '), hold, cool, wait,
      told_days: toldDays, told_times: dm ? dm.n : 0
    }
  }).filter((x) => x.left > 0.005)
  items.sort((a, b) => b.score - a.score)
  const daysArr = []
  for (let i = 0; i < span; i++) {
    const d = addDaysIso(todayIso(), i)
    const wd = wdOf(d)
    daysArr.push({ date: d, wd, label: d.slice(5, 10), is_sun: wd === '周日', rows: [], amount: 0 })
  }
  const open = daysArr.filter((d) => !d.is_sun)
  const pool = open.length ? open : daysArr
  let rest = 0
  for (const it of items) {
    const use = it.cool ? pool.slice(2) : pool
    const cand = use.filter((d) => d.rows.length < perDay)
    if (!cand.length) { rest++; continue }
    cand.sort((x, y) => x.amount - y.amount || x.rows.length - y.rows.length)
    cand[0].rows.push(it)
    cand[0].amount = round2(cand[0].amount + it.left)
  }
  const plan = pool.filter((d) => d.rows.length)
  const planN = plan.reduce((a, d) => a + d.rows.length, 0)
  const planAmt = round2(plan.reduce((a, d) => a + d.amount, 0))
  const total = round2(items.reduce((a, x) => a + x.left, 0))
  const first = items[0]
  const text = !items.length
    ? `没有还欠着钱的${isAr ? '客户' : '供应商'}，这周不用排催款。`
    : `这 ${span} 天要催 ${planN} 家（共 ¥${planAmt}）：` + plan.map((d) => `${d.wd} ${d.rows.length} 家`).join('、') +
      `。最急的是 ${first.party}（欠 ¥${first.left}，${first.why}）` + (() => {
        const fd = plan.find((d) => d.rows.some((r) => r.party === first.party))
        return fd ? `，排在${fd.wd}。` : '。'
      })() + (rest ? ` 还有 ${rest} 家排不下，下周接着催。` : '')
  return c.json({
    ok: true, type, span, per_day: perDay, total, count: items.length,
    plan, plan_n: planN, plan_amt: planAmt, rest, rows: items.slice(0, 40), text
  })
})

// ── 月度对账完成度：这个月该对几家、对上几家、卡在哪 ──
const monthsEnding = (mm, n) => {
  const y = Number(String(mm).slice(0, 4))
  const mo = Number(String(mm).slice(5, 7))
  const out = []
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.UTC(y, mo - 1 - i, 1)).toISOString().slice(0, 7))
  return out
}

app.get('/recon-board', async (c) => {
  const db = c.env.DB
  const type = c.req.query('type') === 'ap' ? 'ap' : 'ar'
  const isAr = type !== 'ap'
  const qm = String(c.req.query('month') || '')
  const mm = /^\d{4}-\d{2}$/.test(qm) ? qm : now().slice(0, 7)
  const span = Math.min(12, Math.max(1, Math.round(num(c.req.query('months')) || 6)))
  const tbl = isAr ? 'orders' : 'payables'
  const col = isAr ? 'customer' : 'supplier'
  const amt = isAr ? 'price' : 'amount'
  const OPEN = `${amt}-COALESCE(paid,0)-COALESCE(written_off,0)`
  const mons = monthsEnding(mm, span)
  const from = mons[0]
  const [act, stmt, rlog, rconf, open] = await Promise.all([
    db.prepare(`SELECT substr(created_at,1,7) m, ${col} AS party, COUNT(*) c, COALESCE(SUM(${amt}),0) t FROM ${tbl} WHERE substr(created_at,1,7)>=? AND substr(created_at,1,7)<=? GROUP BY m, ${col}`).bind(from, mm).all().catch(() => ({ results: [] })),
    db.prepare("SELECT party, month, ack, ack_at, resolved_at, created_at FROM statement_log WHERE type=? AND substr(COALESCE(month,''),1,7)>=? ORDER BY id DESC LIMIT 800").bind(type, from).all().catch(() => ({ results: [] })),
    db.prepare("SELECT party, month, done, state, diff, note, created_at FROM recon_log WHERE type=? AND substr(COALESCE(month,''),1,7)>=? ORDER BY id DESC LIMIT 800").bind(type, from).all().catch(() => ({ results: [] })),
    db.prepare("SELECT party, month FROM recon_confirm WHERE type=? AND substr(COALESCE(month,''),1,7)>=? ORDER BY id DESC LIMIT 800").bind(type, from).all().catch(() => ({ results: [] })),
    db.prepare(`SELECT ${col} AS party, COALESCE(SUM(${OPEN}),0) left_amt, COUNT(*) c FROM ${tbl} WHERE ${OPEN}>0.005 GROUP BY ${col}`).all().catch(() => ({ results: [] }))
  ])
  const smap = {}, lmap = {}, cmap = {}
  for (const r of (stmt.results || [])) { const k = String(r.month || '').slice(0, 7) + '|' + norm(r.party); if (!smap[k]) smap[k] = r }
  for (const r of (rlog.results || [])) { const k = String(r.month || '').slice(0, 7) + '|' + norm(r.party); if (!lmap[k]) lmap[k] = r }
  for (const r of (rconf.results || [])) { cmap[String(r.month || '').slice(0, 7) + '|' + norm(r.party)] = 1 }
  const leftMap = {}
  for (const r of (open.results || [])) leftMap[norm(r.party)] = round2(num(r.left_amt))
  const actMap = {}
  for (const r of (act.results || [])) {
    const m = String(r.m || '').slice(0, 7)
    ;(actMap[m] || (actMap[m] = {}))[norm(r.party)] = { party: r.party || '', cnt: num(r.c), total: round2(num(r.t)) }
  }
  const stateOf = (party, m) => {
    const k = m + '|' + norm(party)
    const s = smap[k], r = lmap[k]
    const sentDate = s ? String(s.created_at || '').slice(0, 10) : ''
    const ackDate = s && s.ack ? String(s.ack_at || s.created_at || '').slice(0, 10) : ''
    if (s && s.ack === 'doubt' && !String(s.resolved_at || '')) {
      return { st: 'disputed', st_text: '对方说对不上', sent: sentDate, ack: ackDate, diff: r ? round2(num(r.diff)) : 0 }
    }
    if (cmap[k] || (s && s.ack === 'ok') || (r && num(r.done) === 1)) {
      return { st: 'done', st_text: cmap[k] ? '签了对账确认单' : (s && s.ack === 'ok' ? '对方确认对得上' : '核对过了，没差异'), sent: sentDate, ack: ackDate, diff: 0 }
    }
    if (r && num(r.diff) > 0.005) return { st: 'diff', st_text: '有差异没处理完', sent: sentDate, ack: ackDate, diff: round2(num(r.diff)) }
    if (s) return { st: 'sent', st_text: '发过对账单，还没回话', sent: sentDate, ack: '', diff: 0 }
    return { st: 'none', st_text: '这个月没发过对账单', sent: '', ack: '', diff: 0 }
  }
  // 本月应核对 = 本月开过单的家 + 还有未结欠款的家
  const cur = Object.assign({}, actMap[mm] || {})
  for (const k of Object.keys(leftMap)) {
    if (leftMap[k] > 0.005 && !cur[k]) cur[k] = { party: '', cnt: 0, total: 0 }
  }
  const rows = Object.keys(cur).map((k) => {
    const e = cur[k]
    const st = stateOf(e.party || k, mm)
    const party = e.party || ((open.results || []).find((x) => norm(x.party) === k) || {}).party || ''
    return Object.assign({ party, cnt: e.cnt, total: e.total, left: round2(num(leftMap[k])) }, st)
  }).filter((r) => r.party)
  const ORD = { disputed: 0, diff: 1, none: 2, sent: 3, done: 4 }
  rows.sort((a, b) => (ORD[a.st] - ORD[b.st]) || (b.left - a.left))
  const cntBy = { done: 0, disputed: 0, diff: 0, sent: 0, none: 0 }
  rows.forEach((r) => { cntBy[r.st] = (cntBy[r.st] || 0) + 1 })
  const total = rows.length
  const rate = total ? Math.round((cntBy.done / total) * 100) : 100
  // 近 N 个月完成度曲线（每月应核对 = 当月开过单的家）
  const curve = mons.map((m) => {
    const parties = Object.keys(actMap[m] || {})
    let d = 0
    parties.forEach((k) => { if (stateOf((actMap[m][k] || {}).party || k, m).st === 'done') d++ })
    const n = parties.length
    return { month: m, total: n, done: d, rate: n ? Math.round((d / n) * 100) : null, bar: n ? Math.max(3, Math.round((d / n) * 100)) : 0 }
  })
  const advice = []
  if (cntBy.disputed) advice.push({ tone: 'warn', text: `${cntBy.disputed} 家对方说对不上：先核数，核完补记或核销，别急着催钱。` })
  if (cntBy.diff) advice.push({ tone: 'warn', text: `${cntBy.diff} 家有差异没处理完：去「对账」里补记或核销掉。` })
  if (cntBy.none) advice.push({ tone: 'info', text: `${cntBy.none} 家这个月还没发过对账单：报表 → 📤 批量发对账单，一次发完。` })
  if (cntBy.sent) advice.push({ tone: 'info', text: `${cntBy.sent} 家发过对账单但没回话：过两天再问一句，或者打电话。` })
  if (total && !cntBy.disputed && !cntBy.diff && !cntBy.none) advice.push({ tone: 'ok', text: '这个月的账都核对清楚了，可以安心结账。' })
  const text = !total
    ? `${mm} 没有需要核对的${isAr ? '客户' : '供应商'}（这个月没开单、也没有未结欠款）。`
    : `${mm} 该核对 ${total} 家，核对清楚 ${cntBy.done} 家（${rate}%）` +
      (cntBy.disputed ? `：${cntBy.disputed} 家对方说对不上` : '') +
      (cntBy.diff ? `、${cntBy.diff} 家有差异没处理完` : '') +
      (cntBy.none ? `、${cntBy.none} 家没发过对账单` : '') +
      (cntBy.sent ? `、${cntBy.sent} 家等回话` : '') + '。'
  return c.json({ ok: true, type, month: mm, months: mons, total, rate, cnt: cntBy, rows, curve, advice, text })
})

// ── 没设账期的单位：主动列出来 + 一键补上（到期提醒靠账期）──
app.get('/term-gap', async (c) => {
  const db = c.env.DB
  const dt = await db.prepare("SELECT value FROM settings WHERE key='default_term'").first().catch(() => null)
  const def = num(dt && dt.value) || 30
  const [terms, ar, ap] = await Promise.all([
    db.prepare('SELECT party FROM party_terms').all().catch(() => ({ results: [] })),
    db.prepare("SELECT customer party, COUNT(*) total, SUM(CASE WHEN price-COALESCE(paid,0)-COALESCE(written_off,0)>0 THEN 1 ELSE 0 END) open_cnt, COALESCE(SUM(MAX(0, price-COALESCE(paid,0)-COALESCE(written_off,0))),0) left_amt FROM orders GROUP BY customer").all().catch(() => ({ results: [] })),
    db.prepare("SELECT supplier party, COUNT(*) total, SUM(CASE WHEN amount-COALESCE(paid,0)-COALESCE(written_off,0)>0 THEN 1 ELSE 0 END) open_cnt, COALESCE(SUM(MAX(0, amount-COALESCE(paid,0)-COALESCE(written_off,0))),0) left_amt FROM payables GROUP BY supplier").all().catch(() => ({ results: [] }))
  ])
  const known = new Set((terms.results || []).map((t) => t.party))
  const map = {}
  const add = (r, kind) => {
    const p = String(r.party || '').trim()
    if (!p || known.has(p)) return
    const e = map[p] || (map[p] = { party: p, kind: [], total: 0, open_cnt: 0, left: 0 })
    if (kind === 'ar') e.kind.push('ar')
    if (kind === 'ap') e.kind.push('ap')
    e.total += num(r.total); e.open_cnt += num(r.open_cnt); e.left += num(r.left_amt)
  }
  for (const r of (ar.results || [])) add(r, 'ar')
  for (const r of (ap.results || [])) add(r, 'ap')
  const rows = Object.values(map).sort((a, b) => b.left - a.left || b.open_cnt - a.open_cnt)
    .map((e) => ({ ...e, kind: e.kind.includes('ar') && e.kind.includes('ap') ? 'both' : e.kind[0] || 'ar', left: round2(e.left) }))
  const openSum = round2(rows.reduce((a, r) => a + r.left, 0))
  const text = rows.length
    ? `还有 ${rows.length} 家没设账期，其中 ${rows.filter((r) => r.open_cnt > 0).length} 家还欠着钱（共 ¥${openSum}）。没账期到点就不会提醒你收/付钱，建议点下面「一键补账期」。`
    : '该设账期的单位都设好了，到期提醒都能正常工作。'
  return c.json({ ok: true, count: rows.length, open_sum: openSum, default_term: def, rows, text })
})

// 一键补账期：给没设账期的单位统一设天数，并顺手把未结单的到期日补上
app.post('/term-gap/apply', async (c) => {
  const db = c.env.DB
  const b = await c.req.json()
  const dt = await db.prepare("SELECT value FROM settings WHERE key='default_term'").first().catch(() => null)
  const days = Math.max(1, Math.min(180, Math.round(num(b.term_days) || num(dt && dt.value) || 30)))
  const parties = Array.isArray(b.parties) ? b.parties.map((x) => String(x).trim()).filter(Boolean) : []
  const [terms, ar, ap] = await Promise.all([
    db.prepare('SELECT party FROM party_terms').all().catch(() => ({ results: [] })),
    db.prepare("SELECT customer party FROM orders GROUP BY customer").all().catch(() => ({ results: [] })),
    db.prepare("SELECT supplier party FROM payables GROUP BY supplier").all().catch(() => ({ results: [] }))
  ])
  const known = new Set((terms.results || []).map((t) => t.party))
  const want = new Set()
  for (const r of (ar.results || [])) if (!known.has(r.party)) want.add(r.party)
  for (const r of (ap.results || [])) if (!known.has(r.party)) want.add(r.party)
  let done = 0, filled = 0
  for (const p of (parties.length ? parties : Array.from(want))) {
    const hasAr = (ar.results || []).some((x) => x.party === p)
    const hasAp = (ap.results || []).some((x) => x.party === p)
    const kind = hasAr && hasAp ? 'ar' : hasAp ? 'ap' : 'ar'
    await db.prepare('INSERT INTO party_terms (party, kind, term_days, recon_cycle, recon_day, note, created_at) VALUES (?,?,?,0,0,\'\',?) ON CONFLICT(party) DO UPDATE SET kind=excluded.kind, term_days=excluded.term_days').bind(p, kind, days, now()).run()
    done++
    // 顺手给这家未结单补到期日（按单据日期 + 账期天数）
    for (const tbl of ['orders', 'payables']) {
      const col = tbl === 'orders' ? 'customer' : 'supplier'
      const amt = tbl === 'orders' ? 'price' : 'amount'
      const rs = (await db.prepare(`SELECT id, created_at FROM ${tbl} WHERE ${col}=? AND ${amt}-COALESCE(paid,0)-COALESCE(written_off,0)>0 AND (due_date IS NULL OR due_date='')`).bind(p).all()).results || []
      for (const r of rs) {
        await db.prepare(`UPDATE ${tbl} SET due_date=? WHERE id=?`).bind(addDaysIso((r.created_at || now()).slice(0, 10), days) + 'T00:00:00.000Z', r.id).run()
        filled++
      }
    }
  }
  await logAudit(db, '一键补账期', 'party_terms', `给 ${done} 家设 ${days} 天账期，补 ${filled} 个到期日`)
  return c.json({ ok: true, updated: done, filled, term_days: days })
})

// ===== 账期按信用收紧：信用差的别给 30 天，信用好的可以放宽 =====
const termAdvise = async (db, type) => {
  const isAr = type !== 'ap'
  const [book, terms, auto] = await Promise.all([
    creditBook(db, type),
    db.prepare('SELECT party, term_days FROM party_terms').all().catch(() => ({ results: [] })),
    termAutoOn(db)
  ])
  const tm = {}
  ;(terms.results || []).forEach((t) => { tm[norm(t.party)] = num(t.term_days) })
  const rows = (book.rows || []).map((r) => {
    const nowDays = tm[norm(r.party)] || 0
    const sug = GRADE_DAYS[r.grade] || 30
    let action = 'ok'
    if (!nowDays) action = 'set'
    else if (nowDays > sug + 5) action = 'tighten'
    else if (nowDays < sug - 10) action = 'loosen'
    const actionText = {
      set: `还没设账期，建议 ${sug} 天`,
      tighten: `现在给 ${nowDays} 天，建议收紧到 ${sug} 天`,
      loosen: `现在只给 ${nowDays} 天，可以放宽到 ${sug} 天`,
      ok: `现在 ${nowDays} 天，跟信用匹配`
    }[action]
    return {
      party: r.party, grade: r.grade, score: r.score, why: r.why,
      now_days: nowDays, suggest_days: sug, action, action_text: actionText,
      unpaid: r.unpaid, oldest_days: r.oldest_days, broken: r.broken
    }
  })
  const order = { tighten: 0, set: 1, loosen: 2, ok: 3 }
  rows.sort((a, b) => (order[a.action] - order[b.action]) || b.unpaid - a.unpaid)
  const cnt = { tighten: 0, loosen: 0, set: 0, ok: 0 }
  rows.forEach((r) => { cnt[r.action]++ })
  const tgt = rows.filter((r) => r.action === 'tighten')
  const text = !rows.length
    ? `还没有${isAr ? '客户' : '供应商'}记录，等记过几单再看账期建议。`
    : tgt.length
      ? `${tgt.length} 家${isAr ? '客户' : '供应商'}的账期该收紧了（${tgt.slice(0, 3).map((r) => `${r.party} ${r.now_days}→${r.suggest_days} 天`).join('、')}${tgt.length > 3 ? ' 等' : ''}），其中还欠着 ¥${round2(tgt.reduce((a, r) => a + r.unpaid, 0))}。`
      : cnt.set
        ? `还有 ${cnt.set} 家没设账期；其余的账期都跟信用匹配。`
        : '账期都跟信用匹配，没有要调的。'
  return { ok: true, type: isAr ? 'ar' : 'ap', auto, rows, count: rows.length, counts: cnt, text, grade_days: GRADE_DAYS }
}

app.get('/term-advice', async (c) => {
  const type = c.req.query('type') === 'ap' ? 'ap' : 'ar'
  return c.json(await termAdvise(c.env.DB, type))
})

// 一键采用建议账期：mode='tighten' 只收紧，'all' 收紧+放宽+补未设
app.post('/term-advice/apply', async (c) => {
  const db = c.env.DB
  const b = await c.req.json().catch(() => ({}))
  const type = b.type === 'ap' ? 'ap' : 'ar'
  const mode = b.mode === 'all' ? 'all' : 'tighten'
  const fixOpen = !!b.fix_open
  const adv = await termAdvise(db, type)
  let want = (adv.rows || []).filter((r) => (mode === 'all' ? r.action !== 'ok' : r.action === 'tighten'))
  const pick = Array.isArray(b.parties) ? b.parties.map((x) => String(x).trim()).filter(Boolean) : []
  if (pick.length) {
    const set = new Set(pick.map((x) => norm(x)))
    want = want.filter((r) => set.has(norm(r.party)))
  }
  if (!want.length) return c.json({ ok: true, updated: 0, fixed: 0, text: mode === 'all' ? '没有要调的账期' : '没有该收紧的账期' })
  const isAr = type !== 'ap'
  const tbl = isAr ? 'orders' : 'payables'
  const who = isAr ? 'customer' : 'supplier'
  const amt = isAr ? 'price' : 'amount'
  let updated = 0, fixed = 0
  const doneRows = []
  for (const r of want) {
    await db.prepare('INSERT INTO party_terms (party, kind, term_days, recon_cycle, recon_day, note, created_at) VALUES (?,?,?,0,0,\'\',?) ON CONFLICT(party) DO UPDATE SET term_days=excluded.term_days')
      .bind(r.party, isAr ? 'ar' : 'ap', r.suggest_days, now()).run()
    updated++
    if (fixOpen) {
      const rs = (await db.prepare(`SELECT id, created_at FROM ${tbl} WHERE ${who}=? AND ${amt}-COALESCE(paid,0)-COALESCE(written_off,0)>0.005`).bind(r.party).all().catch(() => ({ results: [] }))).results || []
      for (const x of rs) {
        const mm = String(x.created_at || '').slice(0, 7)
        if (await isMonthLocked(db, mm)) continue
        await db.prepare(`UPDATE ${tbl} SET due_date=? WHERE id=?`).bind(addDaysIso(String(x.created_at || now()).slice(0, 10), r.suggest_days) + 'T00:00:00.000Z', x.id).run()
        fixed++
      }
    }
    doneRows.push({ party: r.party, from: r.now_days, to: r.suggest_days })
  }
  await logAudit(db, '按信用调账期', 'party_terms', `${doneRows.map((x) => `${x.party} ${x.from}→${x.to} 天`).join('；')}${fixOpen ? `，补 ${fixed} 个到期日` : ''}`)
  return c.json({ ok: true, updated, fixed, rows: doneRows,
    text: `调好 ${updated} 家的账期（${doneRows.slice(0, 3).map((x) => `${x.party} ${x.from || '未设'}→${x.to} 天`).join('、')}${doneRows.length > 3 ? ' 等' : ''}）${fixOpen ? `，顺手补了 ${fixed} 个到期日` : ''}。以后这些家新单就按新账期算到期日。` })
})

// 开关：新单位（没单独设账期的）按信用自动定账期
app.get('/term-auto', async (c) => {
  const on = await termAutoOn(c.env.DB)
  return c.json({ ok: true, on, grade_days: GRADE_DAYS,
    text: on ? '已开启：没单独设账期的新单位，按信用自动给账期（A 45 天 / B 30 天 / C 15 天 / D 7 天）。' : '现在没开：没单独设账期的单位都按默认账期算。' })
})
app.post('/term-auto', async (c) => {
  const db = c.env.DB
  const b = await c.req.json().catch(() => ({}))
  const on = !!b.on
  await db.prepare("INSERT INTO settings (key, value) VALUES ('term_auto', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(on ? '1' : '0').run()
  await logAudit(db, on ? '开启信用账期' : '关闭信用账期', 'settings', on ? '新单位按信用自动定账期' : '改回默认账期')
  return c.json({ ok: true, on,
    text: on ? '已开启：以后没单独设账期的新单位，按信用自动给（A 45 天 / B 30 天 / C 15 天 / D 7 天）。' : '已关闭：改回统一按默认账期算。' })
})

// ===== 催款记录：哪天跟谁催过、说了什么，避免一周催三次同一家 =====
app.get('/dunning-log', async (c) => {
  const db = c.env.DB
  const party = String(c.req.query('party') || '').trim()
  const month = String(c.req.query('month') || '').slice(0, 7)
  const type = c.req.query('type') === 'ap' ? 'ap' : (c.req.query('type') === 'ar' ? 'ar' : '')
  let sql = 'SELECT * FROM dunning_log WHERE 1=1'
  const b = []
  if (party) { sql += ' AND party=?'; b.push(party) }
  if (month) { sql += ' AND substr(created_at,1,7)=?'; b.push(month) }
  if (type) { sql += ' AND type=?'; b.push(type) }
  sql += ' ORDER BY id DESC LIMIT 100'
  const rows = (await (b.length ? db.prepare(sql).bind(...b) : db.prepare(sql)).all()).results || []
  const stat = {}
  for (const r of rows) {
    const s2 = stat[r.party] || (stat[r.party] = { party: r.party, times: 0, last: '' })
    s2.times++
    if (!s2.last || String(r.created_at) > s2.last) s2.last = String(r.created_at)
  }
  const monthCount = (await db.prepare("SELECT COUNT(*) n FROM dunning_log WHERE substr(created_at,1,7)=?").bind(now().slice(0, 7)).first()).n
  // 每家现在还欠多少（判断「答应付款的日子过了还没付」）
  const unpaid = {}
  try {
    const ar = (await db.prepare('SELECT customer AS party, COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) t FROM orders WHERE price-paid-COALESCE(written_off,0) > 0 GROUP BY customer').all()).results || []
    const ap = (await db.prepare('SELECT supplier AS party, COALESCE(SUM(amount-paid-COALESCE(written_off,0)),0) t FROM payables WHERE amount-paid-COALESCE(written_off,0) > 0 GROUP BY supplier').all()).results || []
    for (const r of ar.concat(ap)) unpaid[norm(r.party)] = round2(num(unpaid[norm(r.party)]) + num(r.t))
  } catch (e) {}
  const today = now().slice(0, 10)
  const withState = rows.map((r) => {
    const d = String(r.created_at || '').slice(0, 10)
    const pr = String(r.promise_date || '').slice(0, 10)
    const left = round2(num(unpaid[norm(r.party)]))
    let pstate = 'none'
    if (pr) {
      if (left <= 0.005) pstate = 'kept'
      else if (pr < today) pstate = 'broken'
      else pstate = 'pending'
    }
    return { ...r, date: d, days: daysSince(r.created_at), promise_date: pr, promise_left: pr ? round2(dayDiff(pr)) : null, left, pstate }
  })
  return c.json({
    ok: true, count: rows.length, month_count: num(monthCount),
    broken_count: withState.filter((x) => x.pstate === 'broken').length,
    rows: withState,
    parties: Object.keys(stat).map((k) => ({ party: k, times: stat[k].times, last: stat[k].last.slice(0, 10), days_since: daysSince(stat[k].last) })).sort((a, b) => b.times - a.times)
  })
})
app.post('/dunning-log', async (c) => {
  const db = c.env.DB
  const b = await c.req.json().catch(() => ({}))
  const party = String(b.party || '').trim()
  if (!party) return c.json({ error: '要写清楚催的是哪一家' }, 400)
  const type = b.type === 'ap' ? 'ap' : 'ar'
  const pdate = toIsoDate(b.promise_date) || null
  await db.prepare('INSERT INTO dunning_log (party,type,channel,note,promise_date,created_at) VALUES (?,?,?,?,?,?)')
    .bind(party, type, String(b.channel || '微信').slice(0, 10), String(b.note || '').slice(0, 100), pdate, now()).run()
  await logAudit(db, 'dunning', party, '催款：' + (String(b.note || '').slice(0, 30) || '已催') + (pdate ? '，答应 ' + pdate.slice(5) + ' 付' : ''))
  return c.json({ ok: true })
})
app.delete('/dunning-log/:id', async (c) => {
  const db = c.env.DB
  await db.prepare('DELETE FROM dunning_log WHERE id=?').bind(num(c.req.param('id'))).run()
  return c.json({ ok: true })
})
// 年度催款汇总：12 个月一张表，看全年催回多少
app.get('/dunning-year', async (c) => {
  const db = c.env.DB
  const y = String(c.req.query('year') || now().slice(0, 4)).slice(0, 4)
  const pre = y + '-'
  const months = []
  for (let i = 1; i <= 12; i++) months.push(pre + String(i).padStart(2, '0'))
  const dun = (await db.prepare('SELECT substr(created_at,1,7) m, COUNT(*) n, COUNT(DISTINCT party) p FROM dunning_log WHERE substr(created_at,1,4)=? GROUP BY substr(created_at,1,7)').bind(y).all()).results || []
  const firstDun = (await db.prepare('SELECT party, MIN(created_at) f FROM dunning_log GROUP BY party').all()).results || []
  const fmap = {}
  for (const r of firstDun) fmap[norm(r.party)] = String(r.f || '').slice(0, 10)
  const flows = (await db.prepare("SELECT o.customer party, l.created_at d, l.amount a FROM ledger l JOIN orders o ON l.ref_id=o.id WHERE l.direction='in' AND l.ref_type='order' AND substr(l.created_at,1,4)=? UNION ALL SELECT p.supplier party, l.created_at d, l.amount a FROM ledger l JOIN payables p ON l.ref_id=p.id WHERE l.direction='out' AND l.ref_type='payable' AND substr(l.created_at,1,4)=?").bind(y, y).all()).results || []
  const stl = (await db.prepare("SELECT substr(created_at,1,7) m, COUNT(*) n, SUM(CASE WHEN ack='doubt' THEN 1 ELSE 0 END) bad FROM statement_log WHERE substr(created_at,1,4)=? GROUP BY substr(created_at,1,7)").bind(y).all()).results || []
  const bro = (await db.prepare("SELECT substr(promise_date,1,7) m, COUNT(*) n FROM dunning_log WHERE promise_date IS NOT NULL AND substr(promise_date,1,4)=? AND substr(promise_date,1,10) < ? GROUP BY substr(promise_date,1,7)").bind(y, now().slice(0, 10)).all()).results || []
  const rec = {}
  for (const f of flows) {
    const k = norm(f.party)
    const start = fmap[k]
    if (!start) continue
    if (String(f.d).slice(0, 10) < start) continue
    const mm = String(f.d).slice(0, 7)
    rec[mm] = round2(num(rec[mm]) + num(f.a))
  }
  const g = (arr, m, key) => { const hit = arr.find((x) => x.m === m); return num(hit && hit[key]) }
  const rows = months.map((m, i) => {
    const times = g(dun, m, 'n')
    const recovered = round2(num(rec[m]))
    return {
      m, label: (i + 1) + '月', times, parties: g(dun, m, 'p'),
      recovered, broken: g(bro, m, 'n'),
      statements: g(stl, m, 'n'), disputes: g(stl, m, 'bad'),
      avg: times ? round2(recovered / times) : 0
    }
  })
  const total = {
    times: rows.reduce((a, r) => a + r.times, 0),
    recovered: round2(rows.reduce((a, r) => a + r.recovered, 0)),
    broken: rows.reduce((a, r) => a + r.broken, 0),
    statements: rows.reduce((a, r) => a + r.statements, 0),
    disputes: rows.reduce((a, r) => a + r.disputes, 0)
  }
  total.avg = total.times ? round2(total.recovered / total.times) : 0
  const active = rows.filter((r) => r.times > 0)
  const best = active.slice().sort((a, b) => b.recovered - a.recovered)[0]
  const worst = active.slice().sort((a, b) => (b.broken - a.broken) || (a.recovered - b.recovered))[0]
  const advice = []
  if (!total.times) advice.push({ tone: 'ok', text: year0(y) + ' 年还没记过催款，催完点「记一笔催款」，这里才看得出全年催回多少。' })
  else {
    advice.push({ tone: 'ok', text: y + ' 年催款 ' + total.times + ' 次，催后收回 ¥' + total.recovered + '，平均一次 ¥' + total.avg + '；发对账单 ' + total.statements + ' 份，其中对方有异议 ' + total.disputes + ' 份。' })
    if (best && best.recovered > 0) advice.push({ tone: 'ok', text: '催得最顺的是 ' + best.label + '（收回 ¥' + best.recovered + '、' + best.times + ' 次）。' })
    if (worst && worst.broken >= 2) advice.push({ tone: 'warn', text: worst.label + ' 失约 ' + worst.broken + ' 次最多，那个月是不是放松了催款节奏。' })
    if (total.disputes) advice.push({ tone: 'warn', text: '全年有 ' + total.disputes + ' 份对账单对方说对不上，对账习惯还要再紧一点（最好每月固定一天发单）。' })
  }
  return c.json({ ok: true, year: y, rows, total, best: best || null, worst: worst || null, advice })
})
function year0(y) { return y }
// 对账单争议清单：对方说对不上的，攒一页专门处理（这类最容易拖成死账）
app.get('/disputes', async (c) => {
  const db = c.env.DB
  const all = String(c.req.query('all') || '') === '1'
  const where = all ? "s.ack='doubt'" : "s.ack='doubt' AND COALESCE(s.resolved_at,'')=''"
  const rows = ((await db.prepare('SELECT s.* FROM statement_log s WHERE ' + where + ' ORDER BY s.id DESC LIMIT 100').all()).results || []).map((r) => ({
    id: r.id, party: r.party || '', type: r.type === 'ap' ? 'ap' : 'ar', month: r.month || '',
    date: String(r.created_at || '').slice(0, 10), days: daysSince(r.created_at),
    note: r.note || '', resolved_at: String(r.resolved_at || '').slice(0, 10), resolved: !!r.resolved_at
  }))
  const arLeft = (await db.prepare('SELECT customer party, COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) t, COUNT(*) n FROM orders WHERE price-paid-COALESCE(written_off,0) > 0 GROUP BY customer').all()).results || []
  const apLeft = (await db.prepare('SELECT supplier party, COALESCE(SUM(amount-paid-COALESCE(written_off,0)),0) t, COUNT(*) n FROM payables WHERE amount-paid-COALESCE(written_off,0) > 0 GROUP BY supplier').all()).results || []
  const map = {}
  for (const r of arLeft.concat(apLeft)) {
    const k = norm(r.party)
    const o = map[k] || (map[k] = { left: 0, cnt: 0 })
    o.left = round2(o.left + num(r.t)); o.cnt += num(r.n)
  }
  for (const r of rows) {
    const o = map[norm(r.party)] || { left: 0, cnt: 0 }
    r.left = round2(o.left); r.open_cnt = o.cnt
    r.kind_text = r.type === 'ap' ? '应付' : '应收'
    r.advice = r.days >= 30 ? '拖了 ' + r.days + ' 天，尽快当面核账' : (r.left > 0 ? '先把这几笔对清楚再谈付款' : '已经结清，核对完可以标记忽略')
  }
  const open0 = rows.filter((x) => !x.resolved)
  return c.json({
    ok: true, count: open0.length, total_left: round2(open0.reduce((a, x) => a + x.left, 0)),
    oldest_days: open0.length ? Math.max(...open0.map((x) => x.days)) : 0,
    rows, advice: open0.length
      ? (open0.length >= 3 ? '争议攒了 ' + open0.length + ' 家，建议抽半天一次性核完——拖越久越说不清。' : '有 ' + open0.length + ' 家对账单对不上，尽快核一笔。')
      : '没有待处理的争议，账目清楚。'
  })
})
// 争议台账：每笔争议从「对方说对不上」到「最后怎么收场」的一条线，顺手生成重发时说的话
app.get('/dispute-book', async (c) => {
  const db = c.env.DB
  const all = String(c.req.query('all') || '') === '1'
  const onlyParty = String(c.req.query('party') || '').trim()
  const title = await getTitle(db)
  const sRows = ((await db.prepare("SELECT * FROM statement_log WHERE ack='doubt' ORDER BY id DESC LIMIT 100").all()).results || [])
  const recRows = ((await db.prepare('SELECT * FROM recon_log ORDER BY id DESC LIMIT 400').all()).results || [])
  const dunRows = ((await db.prepare('SELECT party, created_at, promise_date FROM dunning_log ORDER BY id DESC LIMIT 400').all()).results || [])
  const leftMap = {}
  for (const r of ((await db.prepare('SELECT customer party, COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) t FROM orders GROUP BY customer').all()).results || [])) {
    const k = norm(r.party); leftMap[k] = round2((leftMap[k] || 0) + num(r.t))
  }
  for (const r of ((await db.prepare('SELECT supplier party, COALESCE(SUM(amount-paid-COALESCE(written_off,0)),0) t FROM payables GROUP BY supplier').all()).results || [])) {
    const k = norm(r.party); leftMap[k] = round2((leftMap[k] || 0) + num(r.t))
  }
  const rows = []
  for (const r of sRows) {
    const party = r.party || ''
    const k = norm(party)
    if (onlyParty && k !== norm(onlyParty)) continue
    const resolved = !!r.resolved_at
    if (!all && resolved) continue
    const doubtDate = String(r.created_at || '').slice(0, 10)
    const rec = recRows.find((x) => norm(x.party) === k && (!r.month || x.month === r.month))
    let fixedAmount = 0
    if (rec && rec.note) {
      const mm = /补记\s*([0-9.]+)\s*元/.exec(String(rec.note))
      if (mm) fixedAmount = round2(num(mm[1]))
    }
    const timeline = [{ d: doubtDate, t: `对方说对不上${r.note ? '：' + r.note : ''}` }]
    if (rec) {
      timeline.push({ d: String(rec.created_at || '').slice(0, 10), t: rec.note ? String(rec.note) : (num(rec.diff) === 0 ? '核对下来两家金额一致' : '核对过，差 ' + round2(num(rec.diff)) + ' 元') })
    }
    const duns = dunRows.filter((x) => norm(x.party) === k)
    if (duns.length) timeline.push({ d: String(duns[0].created_at || '').slice(0, 10), t: `催过 ${duns.length} 次` + (duns[0].promise_date ? `，对方答应 ${String(duns[0].promise_date).slice(0, 10)} 付` : '') })
    if (resolved) timeline.push({ d: String(r.resolved_at).slice(0, 10), t: '标记处理完' + (r.note ? '：' + String(r.note).slice(0, 40) : '') })
    timeline.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
    const left = round2(leftMap[k] || 0)
    const diffs = fixedAmount > 0 ? `您上月提的 ¥${fixedAmount} 差异我们已核实并补记入账` : '您上月提的差异我们已核对'
    const resend = resolved
      ? `${party} 您好，${r.month || ''} 那期对账单${diffs}。这是新一期的对账单，麻烦再核对一下${left > 0 ? `，现在账上还剩 ¥${left} 未结` : '，账目已经两清'}。`
      : (fixedAmount > 0
        ? `${party} 您好，您提的 ¥${fixedAmount} 差异我们已核实并补记入账，麻烦再看一眼这期对账单${left > 0 ? `，现在账上还剩 ¥${left} 未结` : ''}。`
        : `${party} 您好，您提的对账单差异我们正在逐笔核对，这两天给您答复。${left > 0 ? `目前账上还剩 ¥${left} 未结` : ''}`)
    rows.push({
      id: r.id, party, type: r.type === 'ap' ? 'ap' : 'ar', month: r.month || '',
      doubt_date: doubtDate, days_open: resolved ? 0 : daysSince(r.created_at),
      note: r.note || '', fixed_amount: fixedAmount, recon_state: rec ? String(rec.state || '') : '',
      left, resolved, resolved_at: String(r.resolved_at || '').slice(0, 10),
      timeline, resend_text: resend
    })
  }
  const open0 = rows.filter((x) => !x.resolved)
  const fixedTotal = round2(rows.reduce((a, x) => a + x.fixed_amount, 0))
  return c.json({
    ok: true, title: title.title, count: open0.length, total: rows.length,
    fixed_total: fixedTotal, oldest_days: open0.length ? Math.max(...open0.map((x) => x.days_open)) : 0,
    rows,
    advice: open0.length
      ? `还有 ${open0.length} 家没核完${open0.length >= 3 ? '，争议攒多了先集中核一天' : ''}；核完一条就点「标记处理完」，下次发对账单可以照着上面那句说。`
      : (rows.length ? `争议都处理完了，累计核实补记 ¥${fixedTotal}。` : '还没出现过争议。')
  })
})

// 标记争议已处理（fixed=核对改正了，ignore=不用管）
app.post('/statement-log/:id/resolve', async (c) => {
  const db = c.env.DB
  const id = num(c.req.param('id'))
  const b = await c.req.json().catch(() => ({}))
  const row = await db.prepare('SELECT * FROM statement_log WHERE id=?').bind(id).first()
  if (!row) return c.json({ error: '这条记录不存在' }, 404)
  await db.prepare("UPDATE statement_log SET resolved_at=?, note=? WHERE id=?")
    .bind(now(), (b.note ? String(b.note).slice(0, 100) : (row.note || '') + '（已处理）'), id).run()
  await logAudit(db, 'statement', row.party, '争议已处理：' + row.party + '（' + (b.note ? String(b.note).slice(0, 30) : '核对完') + '）')
  return c.json({ ok: true })
})
// ===== 对账单自助确认：对方点开链接就能说「对得上」或「有几笔不对」=====
const ACK_CSS = 'body{margin:0;background:#f5f6f8;font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#222}'
  + '.wrap{max-width:640px;margin:0 auto;padding:14px 14px 40px}'
  + '.hd{background:#1f6feb;color:#fff;border-radius:12px;padding:14px 16px}'
  + '.hd b{font-size:19px;display:block}.hd span{font-size:13px;opacity:.9}'
  + '.card{background:#fff;border-radius:12px;padding:14px 16px;margin-top:12px;box-shadow:0 1px 3px rgba(0,0,0,.06)}'
  + '.card h3{margin:0 0 8px;font-size:15px;color:#0a4b8c}'
  + '.kv{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px dashed #eceef1}'
  + '.kv:last-child{border:0}.kv b{font-variant-numeric:tabular-nums}'
  + '.big{font-size:20px;color:#1f6feb}'
  + '.doc{font-size:13px;color:#444;padding:5px 0;border-bottom:1px dashed #f0f1f3}'
  + '.doc i{color:#888;font-style:normal}'
  + '.btn{display:block;width:100%;box-sizing:border-box;text-align:center;border:0;border-radius:10px;padding:13px;font-size:16px;margin-top:10px;color:#fff;background:#1f6feb}'
  + '.btn.gray{background:#8a94a6}.btn.red{background:#d9534f}'
  + '.inp{width:100%;box-sizing:border-box;border:1px solid #dcdfe6;border-radius:8px;padding:11px;font-size:15px;margin-top:8px}'
  + '.tip{font-size:12.5px;color:#8a94a6;margin-top:10px;line-height:1.6}'
  + '.ok{background:#eaf7ee;color:#1a7f37;border-radius:10px;padding:12px;font-size:15px;margin-top:10px}'

const ackPage = (inner, script) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
  + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>对账确认</title><style>${ACK_CSS}</style></head>`
  + `<body><div class="wrap">${inner}</div>${script ? `<script>${script}</script>` : ''}</body></html>`

app.get('/statement-ack-link', async (c) => {
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  if (!saved) return c.json({ error: '还没设访问口令' }, 400)
  const type = c.req.query('type') === 'ap' ? 'ap' : 'ar'
  const party = String(c.req.query('party') || '').trim()
  if (!party) return c.json({ error: '要指定是哪一家' }, 400)
  const t = await sigOf(saved, party, 'ack:' + type)
  const base = new URL(c.req.url).origin
  const m = String(c.req.query('month') || '').slice(0, 7)
  return c.json({ ok: true, url: base + '/statement-ack?type=' + type + '&party=' + encodeURIComponent(party) + (m ? '&month=' + m : '') + '&t=' + t })
})

app.get('/statement-ack', async (c) => {
  const db = c.env.DB
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  const type = c.req.query('type') === 'ap' ? 'ap' : 'ar'
  const party = String(c.req.query('party') || '').trim()
  const want = String(c.req.query('t') || '')
  const month = String(c.req.query('month') || '').slice(0, 7) || now().slice(0, 7)
  const good = saved && party ? await sigOf(saved, party, 'ack:' + type) : ''
  if (!good || want !== good) return c.html(ackPage('<div class="card"><h3>链接已失效</h3><div class="tip">请让老板在小程序里重新发一次确认链接。</div></div>'))
  const t = await getTitle(db)
  const d = await conclusionOf(db, type, party, month)
  const docs = ((await db.prepare(type === 'ar'
    ? 'SELECT id, created_at, item_name AS item, price AS amount, COALESCE(paid,0) AS paid, COALESCE(written_off,0) AS wo FROM orders WHERE customer=? AND price-COALESCE(paid,0)-COALESCE(written_off,0)>0.005 ORDER BY created_at ASC LIMIT 12'
    : 'SELECT id, created_at, remark AS item, amount, COALESCE(paid,0) AS paid, COALESCE(written_off,0) AS wo FROM payables WHERE supplier=? AND amount-COALESCE(paid,0)-COALESCE(written_off,0)>0.005 ORDER BY created_at ASC LIMIT 12').bind(party).all()).results || [])
  const docRows = docs.map((r) => `<div class="doc">${escHtml(String(r.created_at || '').slice(0, 10))} ${escHtml(r.item || (type === 'ar' ? '加工费' : '货款'))} <b>¥${round2(num(r.amount))}</b> <i>已${type === 'ar' ? '收' : '付'} ${round2(num(r.paid))}，还欠 ${round2(num(r.amount) - num(r.paid) - num(r.wo))}</i></div>`).join('')
  const openAmt = round2(num(d.end))
  const inner = `<div class="hd"><b>${escHtml(t.title || '对账确认')}</b><span>${type === 'ar' ? '给您对一下加工费的账' : '和您对一下货款的账'} · ${escHtml(month)}</span></div>`
    + `<div class="card"><h3>${escHtml(party)}，到 ${now().slice(0, 10)}</h3>`
    + `<div class="kv"><span>月初欠</span><b>¥${round2(num(d.open))}</b></div>`
    + `<div class="kv"><span>本月新增</span><b>¥${round2(num(d.add))}</b></div>`
    + `<div class="kv"><span>本月已${type === 'ar' ? '付' : '收'}</span><b>¥${round2(num(d.paid))}</b></div>`
    + `<div class="kv"><span>${type === 'ar' ? '我这边记您还欠' : '我这边记还欠您'}</span><b class="big">¥${openAmt}</b></div>`
    + (d.lines && d.lines.length ? `<div class="tip">${escHtml(d.lines.join('；'))}</div>` : '')
    + `</div>`
    + (docRows ? `<div class="card"><h3>还没结清的单子（${docs.length} 笔${openAmt > 0 && docs.length >= 12 ? '，只列最早 12 笔' : ''}）</h3>${docRows}</div>` : '')
    + `<div class="card"><h3>请您核一下</h3><div class="tip">金额对得上就点下面第一个按钮；有对不上的，点第二个并写一下差多少。</div>`
    + `<button class="btn" onclick="ack('ok')">✓ 对得上，没问题</button>`
    + `<button class="btn gray" onclick="showDoubt()">✗ 有几笔对不上</button>`
    + `<div id="doubt" style="display:none"><input class="inp" id="amt" type="number" placeholder="差多少钱（比如 800，多了写 -800）"/>`
    + `<input class="inp" id="note" placeholder="哪一笔不对（选填，比如 6 月那笔 3000 应是 3800）"/>`
    + `<button class="btn red" onclick="ack('doubt')">提交</button></div>`
    + `<div id="res"></div><div class="tip">这是只读页面，只能看您自己这一家。点完老板那边就能看到结果。</div></div>`
  const script = `var P=${JSON.stringify({ type, party, month, t: want })};`
    + `function showDoubt(){document.getElementById('doubt').style.display='block'}`
    + `function ack(kind){var amt=0,note='';if(kind==='doubt'){amt=Number(document.getElementById('amt').value||0);note=String(document.getElementById('note').value||'')}`
    + `if(kind==='doubt'&&!amt&&!note){alert('写一下差多少，或者说明哪一笔不对');return}`
    + `fetch('/statement-ack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:P.type,party:P.party,month:P.month,t:P.t,ack:kind,amount:amt,note:note})})`
    + `.then(function(r){return r.json()}).then(function(d){document.getElementById('res').innerHTML='<div class="ok">'+(d.text||'收到了，谢谢！')+'</div>';document.getElementById('doubt').style.display='none'})`
    + `.catch(function(){alert('没提交成功，请检查网络再点一次')})}`
  return c.html(ackPage(inner, script))
})

app.post('/statement-ack', async (c) => {
  const db = c.env.DB
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  const b = await c.req.json().catch(() => ({}))
  const type = b.type === 'ap' ? 'ap' : 'ar'
  const party = String(b.party || '').trim()
  const month = String(b.month || '').slice(0, 7) || now().slice(0, 7)
  const good = saved && party ? await sigOf(saved, party, 'ack:' + type) : ''
  if (!good || String(b.t || '') !== good) return c.json({ error: '链接已失效，请让老板重新发一次' }, 403)
  const ack = b.ack === 'doubt' ? 'doubt' : 'ok'
  const amt = round2(num(b.amount))
  const note = String(b.note || '').slice(0, 120)
  const memo = ack === 'ok' ? '对方确认：对得上' : ('对方说对不上' + (amt ? '，差 ¥' + amt : '') + (note ? '（' + note + '）' : ''))
  await db.prepare('INSERT INTO statement_log (party,type,month,channel,note,ack,ack_at,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(party, type, month, '自助确认', memo.slice(0, 200), ack, now(), now()).run()
  await logAudit(db, 'statement_ack', party, memo)
  return c.json({
    ok: true, ack,
    text: ack === 'ok'
      ? '收到，谢谢！老板那边已经看到「对得上」，后面按这个数结。'
      : '收到，已经把「对不上' + (amt ? '（差 ¥' + amt + '）' : '') + '」告诉老板了，会尽快跟您核。'
  })
})

app.get('/statement-acks', async (c) => {
  const db = c.env.DB
  const days = Math.max(1, Math.min(365, Math.round(Number(c.req.query('days')) || 30)))
  const since = new Date(new Date(now()).getTime() - days * 86400000).toISOString().slice(0, 10)
  const rows = ((await db.prepare("SELECT * FROM statement_log WHERE ack IN ('ok','doubt') AND substr(COALESCE(ack_at,created_at),1,10)>=? ORDER BY id DESC LIMIT 200").bind(since).all()).results || []).map((r) => ({
    id: r.id, party: r.party, type: r.type, month: r.month, ack: r.ack,
    ack_text: r.ack === 'ok' ? '✓ 对得上' : '✗ 对不上',
    note: r.note || '', at: String(r.ack_at || r.created_at || '').slice(0, 16).replace('T', ' '),
    days: daysSince(r.ack_at || r.created_at)
  }))
  const okN = rows.filter((r) => r.ack === 'ok').length
  const doubtN = rows.filter((r) => r.ack === 'doubt').length
  const pending = ((await db.prepare("SELECT COUNT(DISTINCT party) n FROM statement_log WHERE (ack IS NULL OR ack='') AND substr(created_at,1,7)=?").bind(now().slice(0, 7)).first()) || {}).n || 0
  const text = rows.length === 0
    ? (pending ? `这个月发了 ${pending} 家对账单，还没有一家回音。发的时候带上「让对方确认」的链接，对方点一下你这边就能看到。` : '最近还没有对方确认过的对账单。发对账单时带上确认链接，对方点一下就行。')
    : `最近 ${days} 天有 ${rows.length} 家回了：${okN} 家说对得上${doubtN ? `，${doubtN} 家说对不上（去「争议」里看）` : ''}${pending ? `；这个月还有 ${pending} 家没回音` : ''}。`
  const advice = doubtN ? '有异议的先把差额核清楚再补记/核销，别直接改单据' : (pending ? '没回音的发个确认链接过去，比打电话省事' : '对账节奏不错，保持每月发一次')
  return c.json({ ok: true, days, count: rows.length, ok_count: okN, doubt_count: doubtN, pending, rows, text, advice })
})

// 月度催款小结（可复制发微信 / 存图）
app.get('/dunning-month', async (c) => {
  const db = c.env.DB
  const m = String(c.req.query('month') || now().slice(0, 7)).slice(0, 7)
  const r = await dunningMonthText(db, m)
  return c.json({ ok: true, ...r.stat, text: r.text })
})
// 对账单送达记录：哪天把对账单发给谁了（对方赖「没收到」时有据可查）
app.get('/statement-log', async (c) => {
  const db = c.env.DB
  const party = String(c.req.query('party') || '').trim()
  const month = String(c.req.query('month') || '').slice(0, 7)
  const limit = Math.max(1, Math.min(200, num(c.req.query('limit')) || 60))
  let sql = 'SELECT * FROM statement_log WHERE 1=1'
  const b = []
  if (party) { sql += ' AND party=?'; b.push(party) }
  if (month) { sql += ' AND substr(created_at,1,7)=?'; b.push(month) }
  sql += ' ORDER BY id DESC LIMIT ' + limit
  const rows = ((b.length ? await db.prepare(sql).bind(...b).all() : await db.prepare(sql).all()).results || []).map((r) => {
    const d0 = daysSince(r.created_at)
    const ackText = r.ack === 'ok' ? '对方确认了' : (r.ack === 'doubt' ? '对方有异议' : (d0 >= 7 ? '发出去 ' + d0 + ' 天没回音' : '等对方看'))
    return { ...r, date: String(r.created_at || '').slice(0, 10), days: d0, ack_text: ackText, no_reply: !r.ack && d0 >= 7 }
  })
  const stat = {}
  for (const r of rows) {
    const s2 = stat[r.party] || (stat[r.party] = { party: r.party, times: 0, last: '' })
    s2.times++
    if (!s2.last || String(r.created_at) > s2.last) s2.last = String(r.created_at)
  }
  return c.json({
    ok: true, count: rows.length, rows,
    parties: Object.keys(stat).map((k) => ({ party: k, times: stat[k].times, last: stat[k].last.slice(0, 10), days: daysSince(stat[k].last) })).sort((a, b2) => b2.times - a.times)
  })
})
app.post('/statement-log', async (c) => {
  const db = c.env.DB
  const b = await c.req.json().catch(() => ({}))
  const party = String(b.party || '').trim()
  if (!party) return c.json({ error: '要写清楚发给哪一家' }, 400)
  const type = b.type === 'ap' ? 'ap' : 'ar'
  // 同一天同一家同一个月只记一条（连点两次、或先「话术」再「打印页」不该记两笔）
  const dup = await db.prepare("SELECT id FROM statement_log WHERE party=? AND type=? AND substr(created_at,1,10)=? AND COALESCE(month,'')=? LIMIT 1")
    .bind(party, type, now().slice(0, 10), String(b.month || '').slice(0, 7)).first().catch(() => null)
  if (dup && dup.id && !b.force) return c.json({ ok: true, dup: true, id: dup.id })
  await db.prepare('INSERT INTO statement_log (party,type,month,channel,note,created_at) VALUES (?,?,?,?,?,?)')
    .bind(party, type, String(b.month || '').slice(0, 7), String(b.channel || '微信').slice(0, 10), String(b.note || '').slice(0, 100), now()).run()
  await logAudit(db, 'statement', party, '发对账单：' + (String(b.month || '') || '全部') + '（' + String(b.channel || '微信') + '）')
  return c.json({ ok: true })
})
// 对方回音：ok=确认无误，doubt=有异议（数量/金额对不上）
app.post('/statement-log/:id/ack', async (c) => {
  const db = c.env.DB
  const id = num(c.req.param('id'))
  const b = await c.req.json().catch(() => ({}))
  const ack = b.ack === 'doubt' ? 'doubt' : (b.ack === 'ok' ? 'ok' : '')
  if (!ack) return c.json({ error: '要选「确认」或「有异议」' }, 400)
  const row = await db.prepare('SELECT * FROM statement_log WHERE id=?').bind(id).first()
  if (!row) return c.json({ error: '这条记录不存在' }, 404)
  await db.prepare('UPDATE statement_log SET ack=?, ack_at=?, note=? WHERE id=?')
    .bind(ack, now(), b.note ? String(b.note).slice(0, 100) : (row.note || ''), id).run()
  await logAudit(db, 'statement', row.party, (ack === 'ok' ? '对账单已确认：' : '对账单有异议：') + row.party)
  // 有异议的自动记一条催款，别让它躺在记录里
  if (ack === 'doubt') {
    await db.prepare('INSERT INTO dunning_log (party,type,channel,note,promise_date,created_at) VALUES (?,?,?,?,?,?)')
      .bind(row.party, row.type === 'ap' ? 'ap' : 'ar', '对账单', '对方说对账单对不上' + (b.note ? '：' + String(b.note).slice(0, 40) : ''), null, now()).run()
  }
  return c.json({ ok: true, ack })
})
app.delete('/statement-log/:id', async (c) => {
  const db = c.env.DB
  await db.prepare('DELETE FROM statement_log WHERE id=?').bind(num(c.req.param('id'))).run()
  return c.json({ ok: true })
})
// 催款效果：催了几次、催完到底有没有把钱催回来
app.get('/dunning-effect', async (c) => {
  const db = c.env.DB
  const months = Math.max(1, Math.min(24, num(c.req.query('months')) || 6))
  const since = (() => { const d = new Date(Date.now() + TZ_MS); d.setUTCMonth(d.getUTCMonth() - months); return d.toISOString().slice(0, 10) })()
  const duns = (await db.prepare('SELECT party, type, COUNT(*) n, MIN(created_at) f, MAX(created_at) l FROM dunning_log WHERE substr(created_at,1,10) >= ? GROUP BY party, type').bind(since).all()).results || []
  const arIn = (await db.prepare("SELECT o.customer party, l.created_at d, l.amount a FROM ledger l JOIN orders o ON l.ref_id=o.id WHERE l.direction='in' AND l.ref_type='order' AND substr(l.created_at,1,10) >= ?").bind(since).all()).results || []
  const apOut = (await db.prepare("SELECT p.supplier party, l.created_at d, l.amount a FROM ledger l JOIN payables p ON l.ref_id=p.id WHERE l.direction='out' AND l.ref_type='payable' AND substr(l.created_at,1,10) >= ?").bind(since).all()).results || []
  const arLeft = (await db.prepare('SELECT customer party, COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) t FROM orders WHERE price-paid-COALESCE(written_off,0) > 0 GROUP BY customer').all()).results || []
  const apLeft = (await db.prepare('SELECT supplier party, COALESCE(SUM(amount-paid-COALESCE(written_off,0)),0) t FROM payables WHERE amount-paid-COALESCE(written_off,0) > 0 GROUP BY supplier').all()).results || []
  const leftOf = (type, party) => {
    const src = type === 'ap' ? apLeft : arLeft
    const hit = src.find((x) => norm(x.party) === norm(party))
    return round2(num(hit && hit.t))
  }
  const rows = duns.map((d) => {
    const type = d.type === 'ap' ? 'ap' : 'ar'
    const first = String(d.f || '').slice(0, 10)
    const flows = type === 'ap' ? apOut : arIn
    const paid = round2(flows.filter((x) => norm(x.party) === norm(d.party) && String(x.d).slice(0, 10) >= first).reduce((a, x) => a + num(x.a), 0))
    const left = leftOf(type, d.party)
    let verdict = 'quiet', vtext = '催了没动静'
    if (left <= 0.005 && paid > 0) { verdict = 'done'; vtext = '催完就收清了' }
    else if (paid > 0) { verdict = 'partial'; vtext = '催了有回款，还欠 ' + left }
    else if (left <= 0.005) { verdict = 'paid_before'; vtext = '催之前就结清了' }
    return {
      party: d.party, type, type_text: type === 'ap' ? '应付' : '应收',
      times: num(d.n), first, last: String(d.l || '').slice(0, 10),
      last_days: daysSince(d.l), paid_after: paid, left, verdict, text: vtext,
      avg_once: paid > 0 ? round2(paid / Math.max(1, num(d.n))) : 0
    }
  }).sort((a, b) => (b.left - a.left) || (b.times - a.times))
  const hit = rows.filter((r) => r.verdict === 'done' || r.verdict === 'partial')
  const quiet = rows.filter((r) => r.verdict === 'quiet')
  const recovered = round2(hit.reduce((a, r) => a + r.paid_after, 0))
  const totalDun = rows.reduce((a, r) => a + r.times, 0)
  const stillLeft = round2(rows.reduce((a, r) => a + r.left, 0))
  const advice = []
  if (!rows.length) advice.push({ tone: 'ok', text: '这 ' + months + ' 个月还没记过催款，催完记得点「记一笔催款」，这里才看得出谁催得动。' })
  else {
    if (hit.length) advice.push({ tone: 'ok', text: '催过的 ' + rows.length + ' 家里，' + hit.length + ' 家有回款，一共收回 ¥' + recovered + '（' + totalDun + ' 次催款，平均一次催回 ¥' + round2(recovered / Math.max(1, totalDun)) + '）。' })
    if (quiet.length) advice.push({ tone: 'bad', text: quiet.slice(0, 3).map((r) => r.party).join('、') + ' 催了没动静（共 ' + quiet.length + ' 家、欠 ¥' + round2(quiet.reduce((a, r) => a + r.left, 0)) + '），这些要换方式：上门、停货、或者让他先付一部分。' })
    const heavy = rows.filter((r) => r.times >= 3 && r.left > 0)
    if (heavy.length) advice.push({ tone: 'warn', text: heavy.slice(0, 2).map((r) => r.party + '（催了 ' + r.times + ' 次仍欠 ' + r.left + '）').join('、') + ' 属于「催不动」，下次开单前先要预付款。' })
    if (!quiet.length && !heavy.length) advice.push({ tone: 'ok', text: '目前没有「催了不动」的家，保持记账习惯就行。' })
  }
  return c.json({
    ok: true, months, since, count: rows.length, total_dun: totalDun,
    recovered, still_left: stillLeft, hit_count: hit.length, quiet_count: quiet.length,
    hit_rate: rows.length ? Math.round(hit.length * 100 / rows.length) : 0,
    avg_per_dun: totalDun ? round2(recovered / totalDun) : 0,
    rows, quiet_parties: quiet, advice
  })
})
// 催款阈值：欠多少天才进催款清单（默认 0 = 全都进）
app.get('/collect-config', async (c) => {
  const db = c.env.DB
  const r = await db.prepare("SELECT value FROM settings WHERE key='collect_min_days'").first().catch(() => null)
  return c.json({ ok: true, min_days: num(r && r.value) })
})
app.post('/collect-config', async (c) => {
  const db = c.env.DB
  const b = await c.req.json().catch(() => ({}))
  const v = Math.max(0, Math.min(365, Math.round(num(b.min_days))))
  const has = await db.prepare("SELECT 1 FROM settings WHERE key='collect_min_days'").first()
  if (has) await db.prepare("UPDATE settings SET value=? WHERE key='collect_min_days'").bind(String(v)).run()
  else await db.prepare("INSERT INTO settings (key, value) VALUES ('collect_min_days',?)").bind(String(v)).run()
  return c.json({ ok: true, min_days: v })
})

// ===== 到期表：按账期排出「哪张单哪天到期」，能导 Excel 发客户 =====
async function dueRows(db, type, months, party) {
  const tbl = type === 'ap' ? 'payables' : 'orders'
  const col = type === 'ap' ? 'supplier' : 'customer'
  const amt = type === 'ap' ? 'amount' : 'price'
  const itemCol = type === 'ap' ? 'remark' : 'item_name'
  const terms = (await db.prepare('SELECT party, term_days FROM party_terms').all()).results || []
  const tmap = {}
  terms.forEach((t) => { tmap[norm(t.party)] = num(t.term_days) })
  let sql = `SELECT id, ${col} AS party, ${itemCol} AS item, ${amt} AS amount, paid, COALESCE(written_off,0) AS wo, due_date, created_at FROM ${tbl} WHERE ${amt}-paid-COALESCE(written_off,0) > 0`
  const binds = []
  if (party) { sql += ` AND ${col} = ?`; binds.push(String(party)) }
  sql += ' ORDER BY created_at ASC LIMIT 800'
  const st = binds.length ? db.prepare(sql).bind(...binds) : db.prepare(sql)
  const raw = (await st.all()).results || []
  const horizon = dayAfter(num(months) > 0 ? num(months) * 31 : 186)
  const out = []
  raw.forEach((r) => {
    const left = round2(num(r.amount) - num(r.paid) - num(r.wo))
    if (left <= 0.005) return
    let due = r.due_date ? String(r.due_date).slice(0, 10) : ''
    let guess = false
    if (!due) {
      const td0 = tmap[norm(r.party)]
      const td = td0 > 0 ? td0 : 30
      const d = new Date(String(r.created_at).slice(0, 10) + 'T00:00:00.000Z')
      d.setUTCDate(d.getUTCDate() + td)
      due = d.toISOString().slice(0, 10)
      guess = true
    }
    const days = due ? dayDiff(due) : null
    let state = '没有到期日'
    if (due && days > 0) state = '已逾期 ' + days + ' 天'
    else if (due && days === 0) state = '今天到期'
    else if (due) state = '还有 ' + Math.abs(days) + ' 天'
    out.push({ id: r.id, party: r.party || '', item: r.item || '', amount: round2(num(r.amount)), left, due, guess, days, state, created_at: String(r.created_at).slice(0, 10) })
  })
  out.sort((a, b) => (a.due || '9999') < (b.due || '9999') ? -1 : 1)
  const soon = out.filter((x) => x.days !== null && x.days <= 7)
  const overdue = out.filter((x) => x.days !== null && x.days > 0)
  const future = out.filter((x) => x.days !== null && x.days < 0 && x.due <= horizon)
  return {
    rows: out, total: round2(out.reduce((a, x) => a + x.left, 0)),
    overdue_total: round2(overdue.reduce((a, x) => a + x.left, 0)),
    soon_total: round2(soon.reduce((a, x) => a + x.left, 0)),
    future_total: round2(future.reduce((a, x) => a + x.left, 0)),
    no_due_total: round2(out.filter((x) => !x.due).reduce((a, x) => a + x.left, 0)),
    count: out.length, overdue_count: overdue.length
  }
}

app.get('/due-schedule', async (c) => {
  const type = c.req.query('type') === 'ap' ? 'ap' : 'ar'
  const r = await dueRows(c.env.DB, type, num(c.req.query('months')) || 6, (c.req.query('party') || '').trim())
  return c.json(Object.assign({ ok: true, type }, r))
})

app.get('/due-schedule-xlsx', async (c) => {
  const type = c.req.query('type') === 'ap' ? 'ap' : 'ar'
  const r = await dueRows(c.env.DB, type, num(c.req.query('months')) || 6, (c.req.query('party') || '').trim())
  const head = ['单号', '单位', '产品/说明', '金额', '未结', '开单日', '到期日', '状态']
  const rows = [head].concat(r.rows.map((x) => [x.id, x.party, x.item, x.amount, x.left, x.created_at, x.due || '', x.state + (x.guess ? '（按账期推算）' : '')]))
  rows.push([])
  rows.push(['合计未结', r.total, '已逾期', r.overdue_total, '7天内', r.soon_total, '没到期日', r.no_due_total])
  const b64 = toB64(await makeXlsxSheets([{ name: type === 'ap' ? '应付到期表' : '应收到期表', rows }]))
  return c.json({ ok: true, name: (type === 'ap' ? '应付到期表_' : '应收到期表_') + now().slice(0, 10) + '.xlsx', b64 })
})

// ===== 超期分级：30/60/90 天三档，拖太久的单独圈出来 =====
app.get('/risk-list', async (c) => {
  const db = c.env.DB
  const type = c.req.query('type') === 'ap' ? 'ap' : 'ar'
  const tbl = type === 'ap' ? 'payables' : 'orders'
  const col = type === 'ap' ? 'supplier' : 'customer'
  const amt = type === 'ap' ? 'amount' : 'price'
  const raw = (await db.prepare(`SELECT id, ${col} AS party, ${amt} AS amount, paid, COALESCE(written_off,0) AS wo, due_date, created_at FROM ${tbl} WHERE ${amt}-paid-COALESCE(written_off,0) > 0`).all()).results || []
  const b = { d0: { label: '没到期 / 7天内', amount: 0, cnt: 0 }, d30: { label: '超 1-30 天', amount: 0, cnt: 0 }, d60: { label: '超 31-60 天', amount: 0, cnt: 0 }, d90: { label: '超 61-90 天', amount: 0, cnt: 0 }, dx: { label: '超 90 天（疑似坏账）', amount: 0, cnt: 0 } }
  const pmap = {}
  raw.forEach((r) => {
    const left = round2(num(r.amount) - num(r.paid) - num(r.wo))
    if (left <= 0.005) return
    const base = r.due_date ? String(r.due_date).slice(0, 10) : String(r.created_at).slice(0, 10)
    const days = dayDiff(base)
    let k = 'd0'
    if (days > 90) k = 'dx'
    else if (days > 60) k = 'd90'
    else if (days > 30) k = 'd60'
    else if (days > 7) k = 'd30'
    b[k].amount = round2(b[k].amount + left); b[k].cnt += 1
    const p = pmap[r.party || ''] || (pmap[r.party || ''] = { party: r.party || '', left: 0, cnt: 0, oldest: 99999, worst: 0 })
    p.left = round2(p.left + left); p.cnt += 1
    p.oldest = Math.min(p.oldest, days); p.worst = Math.max(p.worst, days)
  })
  const parties = Object.keys(pmap).map((k) => pmap[k]).sort((a, b2) => b2.worst - a.worst)
  const bad = parties.filter((p) => p.worst > 90)
  const badTotal = round2(bad.reduce((a, x) => a + x.left, 0))
  const level = type === 'ap' ? (badTotal > 0 ? '我欠别人超 90 天的有 ' + round2(badTotal) + ' 元，先安排这笔' : '没有拖过 90 天的应付') : (badTotal > 0 ? '超过 90 天没收回的有 ' + round2(badTotal) + ' 元（' + bad.length + ' 家），建议走坏账核销或专人跟' : '没有超过 90 天的欠款，账很干净')
  return c.json({ ok: true, type, buckets: b, parties, bad, bad_total: badTotal, bad_count: bad.length, level })
})

// ===== 回款预测：按账期把未结单排到未来几个月，再按历史回款率打折 =====
async function histRate(db) {
  const six = new Date(Date.now() + TZ_MS - 183 * 86400000).toISOString().slice(0, 7)
  const add = num((await db.prepare('SELECT COALESCE(SUM(price),0) AS t FROM orders WHERE month>=?').bind(six).first() || {}).t)
  const got = num((await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='in' AND cash=1 AND ref_type='order' AND substr(created_at,1,7)>=?").bind(six).first() || {}).t)
  const rate = add > 0 ? Math.min(1, Math.max(0.3, got / add)) : 0.8
  return { rate: Math.round(rate * 100) / 100, order_add: round2(add), got: round2(got), months: 6 }
}

app.get('/forecast', async (c) => {
  const db = c.env.DB
  const n = Math.min(6, Math.max(1, num(c.req.query('months')) || 3))
  const hr = await histRate(db)
  const ar = await dueRows(db, 'ar', 12, '')
  const ap = await dueRows(db, 'ap', 12, '')
  const base = new Date(Date.now() + TZ_MS)
  const buckets = []
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + i, 1))
    buckets.push({ month: d.toISOString().slice(0, 7), ar_raw: 0, ap_raw: 0, ar_soon: 0 })
  }
  const thisMonth = now().slice(0, 7)
  let overdue = 0
  ar.rows.forEach((r) => {
    const due = r.due || ''
    if (!due) return
    if (due.slice(0, 7) < thisMonth || (r.days !== null && r.days > 0 && due.slice(0, 7) <= thisMonth)) { overdue = round2(overdue + r.left); return }
    const b = buckets.find((x) => x.month === due.slice(0, 7))
    if (b) { b.ar_raw = round2(b.ar_raw + r.left); if (r.days !== null && r.days <= 0 && r.days >= -7) b.ar_soon = round2(b.ar_soon + r.left) }
  })
  ap.rows.forEach((r) => {
    const due = r.due || ''
    if (!due) return
    const b = buckets.find((x) => x.month === due.slice(0, 7))
    if (b) b.ap_raw = round2(b.ap_raw + r.left)
  })
  const months = buckets.map((b) => ({
    month: b.month,
    ar: round2(b.ar_raw * hr.rate), ar_raw: b.ar_raw, ar_soon: b.ar_soon,
    ap: b.ap_raw, net: round2(b.ar_raw * hr.rate - b.ap_raw)
  }))
  const totalAr = round2(months.reduce((a, x) => a + x.ar, 0))
  const totalAp = round2(months.reduce((a, x) => a + x.ap, 0))
  return c.json({
    ok: true, rate: hr.rate, rate_basis: '近 6 个月：开单 ' + hr.order_add + ' 元、实收 ' + hr.got + ' 元', months,
    overdue, total_ar: totalAr, total_ap: totalAp, net: round2(totalAr - totalAp),
    note: '回款按历史回款率 ' + Math.round(hr.rate * 100) + '% 打折估算（不是承诺，逾期越多实际会越低）；应付按到期全额算。'
  })
})

// ===== 月度报表包：一个 Excel 装下全套（利润表/资产负债表/应收/应付/流水/账龄/到期表） =====
async function monthSum(db, m) {
  // 性能：原来 13 条查询串行（报表页要等 3.5 秒），现在 1 条聚合 + 3 条并发（约 1 秒）
  const aggSql = `SELECT
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE direction='in' AND cash=1 AND ref_type<>'transfer' AND month=?) AS inc,
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND month=?) AS outt,
    (SELECT COALESCE(SUM(price),0) FROM orders WHERE month=?) AS order_add,
    (SELECT COALESCE(SUM(COALESCE(cost,0)),0) FROM orders WHERE month=?) AS order_cost,
    (SELECT COALESCE(SUM(amount),0) FROM payables WHERE month=?) AS payable_add,
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE ${CASH_EXP_WHERE} AND month=?) AS exp_cash,
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE direction='out' AND cash=0 AND ref_type='dep' AND month=?) AS dep,
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE direction='out' AND cash=0 AND ref_type='amort' AND month=?) AS amort,
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE direction='out' AND cash=0 AND ref_type='debt_int' AND month=?) AS accrual,
    (SELECT COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) FROM orders WHERE paid + COALESCE(written_off,0) < price) AS ar_left,
    (SELECT COALESCE(SUM(amount-paid-COALESCE(written_off,0)),0) FROM payables WHERE paid + COALESCE(written_off,0) < amount) AS ap_left`
  const jobs = [
    db.prepare(aggSql).bind(m, m, m, m, m, m, m, m, m).first(),
    accountBalances(db),
    db.prepare('SELECT * FROM debts').all(),
    db.prepare('SELECT * FROM debt_repays').all()
  ].map((x) => x.catch((e) => { noteFail(e); return null }))
  const [aggR, accounts, dR, rR] = await Promise.all(jobs)
  const agg = aggR || {}
  const accs = accounts || []
  const debtRows = (dR && dR.results) || []
  const debtReps = (rR && rR.results) || []
  const inc = num(agg.inc), out = num(agg.outt)
  const orderAdd = num(agg.order_add), orderCost = num(agg.order_cost), payableAdd = num(agg.payable_add)
  const expCash = num(agg.exp_cash), dep = num(agg.dep), amort = num(agg.amort), accrual = num(agg.accrual)
  const arLeft = num(agg.ar_left), apLeft = num(agg.ap_left)
  const debtLeft = round2(debtRows.map((d) => debtView(d, debtReps.filter((r) => r.debt_id === d.id))).filter((x) => x.status === 'open').reduce((a, x) => a + x.remain, 0))
  const cash = round2(accs.reduce((a, x) => a + x.balance, 0))
  const gross = round2(orderAdd - orderCost)
  const net = round2(gross - expCash - dep - amort - accrual)
  return { m, inc: round2(inc), out: round2(out), orderAdd: round2(orderAdd), orderCost: round2(orderCost), payableAdd: round2(payableAdd), expCash: round2(expCash), dep: round2(dep), amort: round2(amort), accrual: round2(accrual), gross, net, arLeft: round2(arLeft), apLeft: round2(apLeft), debtLeft, cash, accounts: accs, equity: round2(cash + arLeft - apLeft - debtLeft) }
}

async function packSheets(db, m) {
  const s = await monthSum(db, m)
  const sheets = []
  sheets.push({ name: '总览', rows: [
    ['账期', m], ['收款（现金）', s.inc], ['付款/支出（现金）', s.out], ['结余', round2(s.inc - s.out)],
    ['接单额', s.orderAdd], ['材料外协成本', s.orderCost], ['毛利', s.gross],
    ['现金支出', s.expCash], ['折旧', s.dep], ['摊销', s.amort], ['预提利息', s.accrual], ['净利（权责）', s.net],
    [], ['应收未收', s.arLeft], ['应付未付', s.apLeft], ['借款余额', s.debtLeft], ['手头现金', s.cash], ['净资产', s.equity]
  ] })
  sheets.push({ name: '利润表', rows: [
    ['项目', '本月', '说明'], ['接单额（加工费）', s.orderAdd, '本月开单金额'], ['材料·外协成本', s.orderCost, '单据上填的成本'], ['毛利', s.gross, '接单 − 成本'],
    ['减：现金支出', s.expCash, '工资水电房租采购等实际付出的'], ['减：折旧', s.dep, '设备按月计提'], ['减：摊销', s.amort, '长期费用按月摊'], ['减：预提利息', s.accrual, '借款利息按月计提'],
    ['净利（权责口径）', s.net, '毛利 − 各项费用'], [], ['现金视角：收 − 付', round2(s.inc - s.out), '只看到账的钱']
  ] })
  const bsRows = [['资产', '金额'], ['货币资金', s.cash]]
  s.accounts.forEach((a) => bsRows.push(['　' + a.name, a.balance]))
  bsRows.push(['应收未收', s.arLeft], ['资产合计', round2(s.cash + s.arLeft)], [])
  bsRows.push(['负债', '金额'], ['应付未付', s.apLeft], ['借款余额', s.debtLeft], ['负债合计', round2(s.apLeft + s.debtLeft)], [])
  bsRows.push(['所有者权益', s.equity], ['负债 + 权益', round2(s.apLeft + s.debtLeft + s.equity)])
  sheets.push({ name: '资产负债表', rows: bsRows })
  const ars = (await db.prepare('SELECT * FROM orders ORDER BY id').all()).results || []
  sheets.push({ name: '应收明细', rows: [['单号', '客户', '产品', '金额', '成本', '已收', '核销', '未收', '开单日', '到期日', '状态']].concat(
    ars.map((o) => [o.id, o.customer, o.item_name, num(o.price), num(o.cost), num(o.paid), num(o.written_off), round2(num(o.price) - num(o.paid) - num(o.written_off)), String(o.created_at).slice(0, 10), o.due_date || '', num(o.paid) + num(o.written_off) >= num(o.price) ? '已结清' : (num(o.paid) > 0 ? '部分收' : '未收')])
  ) })
  const aps = (await db.prepare('SELECT * FROM payables ORDER BY id').all()).results || []
  sheets.push({ name: '应付明细', rows: [['单号', '供应商', '说明', '金额', '已付', '核销', '未付', '开单日', '到期日']].concat(
    aps.map((o) => [o.id, o.supplier, o.remark || '', num(o.amount), num(o.paid), num(o.written_off), round2(num(o.amount) - num(o.paid) - num(o.written_off)), String(o.created_at).slice(0, 10), o.due_date || ''])
  ) })
  const led = (await db.prepare("SELECT * FROM ledger WHERE month=? ORDER BY id").bind(m).all()).results || []
  sheets.push({ name: '收付流水', rows: [['日期', '方向', '金额', '分类', '账户', '摘要', '是否动现金']].concat(
    led.map((l) => [String(l.created_at).slice(0, 10), l.direction === 'in' ? '收' : '付', num(l.amount), l.category || '', l.account_id || '', l.remark || '', num(l.cash) ? '是' : '否（内部结转）'])
  ) })
  const ag = await db.prepare('SELECT id, customer AS party, price AS amount, paid, COALESCE(written_off,0) AS wo, due_date, created_at FROM orders WHERE price-paid-COALESCE(written_off,0) > 0').all()
  const bk = { a: [0, 0], b: [0, 0], c: [0, 0], d: [0, 0], e: [0, 0] }
  ;(ag.results || []).forEach((r) => {
    const days = daysSince(r.due_date ? String(r.due_date).slice(0, 10) : String(r.created_at).slice(0, 10))
    const left = round2(num(r.amount) - num(r.paid) - num(r.wo))
    const k = days <= 30 ? 'a' : days <= 60 ? 'b' : days <= 90 ? 'c' : days <= 180 ? 'd' : 'e'
    bk[k][0] = round2(bk[k][0] + left); bk[k][1] += 1
  })
  sheets.push({ name: '账龄', rows: [['账龄档', '金额', '笔数'], ['未超 30 天', bk.a[0], bk.a[1]], ['31-60 天', bk.b[0], bk.b[1]], ['61-90 天', bk.c[0], bk.c[1]], ['91-180 天', bk.d[0], bk.d[1]], ['超 180 天', bk.e[0], bk.e[1]]] })
  const ds = await dueRows(db, 'ar', 6, '')
  sheets.push({ name: '应收到期表', rows: [['单号', '客户', '产品', '未结', '到期日', '状态']].concat(ds.rows.map((x) => [x.id, x.party, x.item, x.left, x.due || '', x.state])) })
  return sheets
}

// ===== 半年趋势：每月接单/毛利/支出/净利，给前端画柱状图 =====
app.get('/trend', async (c) => {
  const db = c.env.DB
  const n = Math.min(24, Math.max(1, num(c.req.query('months')) || 6))
  const base = now().slice(0, 7)
  const mons = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base + '-01T00:00:00.000Z')
    d.setUTCMonth(d.getUTCMonth() - i)
    mons.push(d.toISOString().slice(0, 7))
  }
  // 性能：原来每个月 3 次查询（6 个月 18 次串行，4.6 秒），改成 3 次分组查询（约 1 秒）
  const jobs = [
    db.prepare('SELECT month mk, COALESCE(SUM(price),0) a, COALESCE(SUM(COALESCE(cost,0)),0) c FROM orders WHERE month>=? GROUP BY mk').bind(mons[0]).all(),
    db.prepare(`SELECT substr(created_at,1,7) mk, COALESCE(SUM(CASE WHEN ${CASH_EXP_WHERE} THEN amount ELSE 0 END),0) o, COALESCE(SUM(CASE WHEN direction='in' AND cash=1 AND ref_type<>'transfer' THEN amount ELSE 0 END),0) i FROM ledger WHERE cash=1 AND month>=? GROUP BY mk`).bind(mons[0]).all()
  ].map((x) => x.catch((e) => { noteFail(e); return null }))
  const [oR, lR] = await Promise.all(jobs)
  const rowsOf = (r) => (r && r.results) || []
  const oMap = {}, eMap = {}, iMap = {}
  for (const x of rowsOf(oR)) { oMap[x.mk] = x.a; eMap[x.mk] = x.c }
  for (const x of rowsOf(lR)) { eMap[x.mk + '#e'] = x.o; iMap[x.mk] = x.i }
  const rows = []
  for (const m of mons) {
    const add = round2(num(oMap[m]))
    const cost = round2(num(eMap[m]))
    const expense = round2(num(eMap[m + '#e']))
    rows.push({ m, label: num(m.slice(5, 7)) + '月', order_add: add, cost, gross: round2(add - cost), expense, profit: round2(add - cost - expense), cash_in: round2(num(iMap[m])) })
  }
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.profit)))
  rows.forEach((r) => { r.bar_w = Math.max(2, Math.round(Math.abs(r.profit) / maxAbs * 100)); r.neg = r.profit < 0 })
  const best = rows.slice().sort((a, b) => b.profit - a.profit)[0]
  const worst = rows.slice().sort((a, b) => a.profit - b.profit)[0]
  const total = round2(rows.reduce((a, r) => a + r.profit, 0))
  const active = rows.filter((r) => r.order_add > 0 || r.expense > 0)
  const avg = active.length ? round2(total / active.length) : 0
  const last = rows[rows.length - 1]
  const prev = rows.length > 1 ? rows[rows.length - 2] : null
  let trend = '平'
  if (prev && Math.abs(last.profit - prev.profit) > Math.max(200, Math.abs(prev.profit) * 0.15)) trend = last.profit > prev.profit ? '升' : '降'
  const advice = []
  if (last.neg) advice.push({ tone: 'bad', text: '这个月是亏的（' + last.profit + ' 元），先看支出是不是哪项冒尖了。' })
  else if (last.profit > 0) advice.push({ tone: 'ok', text: '这个月净利 ' + last.profit + ' 元，' + (trend === '升' ? '比上月好' : trend === '降' ? '比上月差' : '和上月差不多') + '。' })
  if (active.length >= 3) {
    const down = rows.filter((r, i) => i > 0 && r.profit < rows[i - 1].profit - 200)
    if (down.length >= 2) advice.push({ tone: 'warn', text: '最近 ' + active.length + ' 个月里有 ' + down.length + ' 次下滑，留意是不是接单少了还是支出涨了。' })
  }
  return c.json({ ok: true, months: rows, total, avg, best, worst, trend, active_count: active.length, advice })
})

// ===== 收款速度：谁付钱最快、谁最慢 =====
app.get('/pay-speed', async (c) => {
  const db = c.env.DB
  const paid = (await db.prepare(`SELECT o.customer AS party, COUNT(*) cnt,
      COALESCE(AVG(julianday(p.last_pay) - julianday(substr(o.created_at,1,10))),0) avg_days,
      COALESCE(SUM(o.price),0) amt
    FROM orders o JOIN (SELECT ref_id, MAX(substr(created_at,1,10)) last_pay FROM ledger WHERE ref_type='order' AND direction='in' GROUP BY ref_id) p ON p.ref_id=o.id
    WHERE o.price - o.paid - COALESCE(o.written_off,0) <= 0.005 GROUP BY o.customer`).all()).results || []
  const unpaid = (await db.prepare(`SELECT customer AS party, COUNT(*) cnt, COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) left_amt,
      MIN(julianday('now') - julianday(substr(created_at,1,10))) min_wait, MAX(julianday('now') - julianday(substr(created_at,1,10))) max_wait
    FROM orders WHERE price-paid-COALESCE(written_off,0) > 0.005 GROUP BY customer`).all()).results || []
  const umap = {}
  unpaid.forEach((u) => { umap[u.party] = u })
  const list = paid.map((r) => {
    const u = umap[r.party]
    return {
      party: r.party || '', done_cnt: num(r.cnt), avg_days: Math.round(num(r.avg_days)),
      done_amt: round2(num(r.amt)), unpaid_cnt: u ? num(u.cnt) : 0, unpaid_amt: u ? round2(num(u.left_amt)) : 0,
      wait_days: u ? Math.round(num(u.max_wait)) : 0
    }
  })
  const onlyUnpaid = unpaid.filter((u) => !list.some((x) => x.party === u.party)).map((u) => ({
    party: u.party || '', done_cnt: 0, avg_days: null, done_amt: 0, unpaid_cnt: num(u.cnt), unpaid_amt: round2(num(u.left_amt)), wait_days: Math.round(num(u.max_wait))
  }))
  const all = list.concat(onlyUnpaid)
  const fast = all.filter((x) => x.avg_days !== null).sort((a, b) => a.avg_days - b.avg_days).slice(0, 5)
  const slow = all.filter((x) => x.avg_days !== null).sort((a, b) => b.avg_days - a.avg_days).slice(0, 5)
  const never = all.filter((x) => x.avg_days === null).sort((a, b) => b.unpaid_amt - a.unpaid_amt)
  const avgAll = fast.length || slow.length ? Math.round(all.filter((x) => x.avg_days !== null).reduce((a, x) => a + x.avg_days, 0) / all.filter((x) => x.avg_days !== null).length) : 0
  const advice = []
  if (never.length) advice.push({ tone: 'bad', text: '有 ' + never.length + ' 家一笔都没结清过（合计欠 ' + round2(never.reduce((a, x) => a + x.unpaid_amt, 0)) + ' 元），先盯这些。' })
  if (slow.length && slow[0].avg_days >= 30) advice.push({ tone: 'warn', text: slow[0].party + ' 平均要 ' + slow[0].avg_days + ' 天才付钱，最好改成先款后货或设账期上限。' })
  if (avgAll && avgAll <= 15) advice.push({ tone: 'ok', text: '平均 ' + avgAll + ' 天回款，现金周转算健康。' })
  return c.json({ ok: true, fast, slow, never, avg_days: avgAll, count: all.length, advice })
})

// ===== 月度目标：这个月想收多少 / 想接多少单 =====
app.get('/target', async (c) => {
  const db = c.env.DB
  const m = (c.req.query('month') || now().slice(0, 7))
  const t = await db.prepare('SELECT * FROM targets WHERE month=?').bind(m).first()
  const inc = await db.prepare("SELECT COALESCE(SUM(amount),0) a FROM ledger WHERE direction='in' AND cash=1 AND substr(created_at,1,7)=?").bind(m).first()
  const add = await db.prepare('SELECT COALESCE(SUM(price),0) a FROM orders WHERE month=?').bind(m).first()
  const receive = round2(num(inc && inc.a))
  const orderAdd = round2(num(add && add.a))
  const tr = round2(num(t && t.receive))
  const ta = round2(num(t && t.order_add))
  const today = new Date(Date.now() + TZ_MS)
  const isCur = m === now().slice(0, 7)
  const dim = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate()
  const daysLeft = isCur ? Math.max(0, dim - today.getUTCDate() + 1) : 0
  const pct = (v, tv) => tv > 0 ? Math.round(v / tv * 1000) / 10 : null
  const gap = tr > 0 ? round2(tr - receive) : null
  // 本周进度：把月目标按天数拆到 4 周（最后一周含余下天数）
  let wk = null
  if (isCur) {
    const segs = [[1, 7], [8, 14], [15, 21], [22, dim]]
    const dom = today.getUTCDate()
    let idx = segs.findIndex(([a, b]) => dom >= a && dom <= b)
    if (idx < 0) idx = 3
    const wa = segs[idx][0], wb = segs[idx][1]
    const wt = tr > 0 ? Math.round(tr * (wb - wa + 1) / dim) : 0
    const from = m + '-' + String(wa).padStart(2, '0')
    const to = m + '-' + String(wb).padStart(2, '0')
    const wr = await db.prepare("SELECT COALESCE(SUM(amount),0) a FROM ledger WHERE direction='in' AND cash=1 AND ref_type<>'transfer' AND substr(created_at,1,10)>=? AND substr(created_at,1,10)<=?").bind(from, to).first()
    const got = round2(num(wr && wr.a))
    const leftDays = Math.max(0, wb - dom + 1)
    wk = { no: idx + 1, from, to, target: wt, received: got, gap: wt > 0 ? round2(wt - got) : null, left_days: leftDays, need_per_day: (wt > 0 && wt - got > 0) ? round2((wt - got) / Math.max(1, leftDays)) : null }
  }
  return c.json({
    ok: true, month: m, receive_target: tr, order_target: ta, has_target: tr > 0 || ta > 0, week: wk,
    receive, order_add: orderAdd, receive_pct: pct(receive, tr), order_pct: pct(orderAdd, ta),
    gap, days_left: daysLeft, per_day: gap && daysLeft > 0 ? round2(gap / daysLeft) : null,
    advice: tr > 0
      ? (gap <= 0 ? '目标已经达成了（超 ' + round2(-gap) + ' 元）' : '还差 ' + gap + ' 元，' + daysLeft + ' 天里每天要收 ' + round2(gap / Math.max(1, daysLeft)) + ' 元')
      : '还没设这个月的目标（想设就点一下）'
  })
})

app.post('/target', async (c) => {
  const db = c.env.DB
  const b = await c.req.json().catch(() => ({}))
  const m = (b.month || c.req.query('month') || now().slice(0, 7))
  if (!/^\d{4}-\d{2}$/.test(m)) return c.json({ error: '月份写成 2026-11 这样' }, 400)
  const r = round2(num(b.receive))
  const o = round2(num(b.order_add))
  if (r < 0 || o < 0) return c.json({ error: '目标不能是负数' }, 400)
  if (r === 0 && o === 0) {
    await db.prepare('DELETE FROM targets WHERE month=?').bind(m).run()
    return c.json({ ok: true, month: m, cleared: true })
  }
  await db.prepare('INSERT INTO targets (month, receive, order_add, created_at) VALUES (?,?,?,?) ON CONFLICT(month) DO UPDATE SET receive=excluded.receive, order_add=excluded.order_add').bind(m, r, o, now()).run()
  await logAudit(db, 'target', m, '月目标 收 ' + r + ' / 接单 ' + o)
  return c.json({ ok: true, month: m, receive: r, order_add: o })
})

app.get('/month-pack', async (c) => {
  const m = String(c.req.query('month') || now().slice(0, 7))
  if (!/^\d{4}-\d{2}$/.test(m)) return c.json({ error: '月份格式应为 YYYY-MM' }, 400)
  const sheets = await packSheets(c.env.DB, m)
  const b64 = toB64(await makeXlsxSheets(sheets))
  return c.json({ ok: true, month: m, name: '全套报表_' + m + '.xlsx', b64, sheets: sheets.map((x) => x.name), size: b64.length })
})

// ===== 手机端报表：手机上直接看，不用开 Excel =====
app.get('/report-view', async (c) => {
  const db = c.env.DB
  const m = String(c.req.query('month') || now().slice(0, 7))
  if (!/^\d{4}-\d{2}$/.test(m)) return c.json({ error: '月份格式应为 YYYY-MM' }, 400)
  const s = await monthSum(db, m)
  const cats = (await db.prepare("SELECT category, COALESCE(SUM(amount),0) AS amt FROM ledger WHERE direction='out' AND cash=1 AND ref_type='expense' AND substr(created_at,1,7)=? GROUP BY category ORDER BY amt DESC").bind(m).all()).results || []
  const pl = [
    { label: '接单额（加工费）', value: s.orderAdd },
    { label: '材料·外协成本', value: -s.orderCost },
    { label: '毛利', value: s.gross, strong: true },
    { label: '现金支出', value: -s.expCash },
    { label: '折旧', value: -s.dep },
    { label: '摊销', value: -s.amort },
    { label: '预提利息', value: -s.accrual },
    { label: '净利（权责）', value: s.net, strong: true, tone: s.net >= 0 ? 'ok' : 'bad' }
  ]
  const bs = {
    assets: [{ label: '货币资金', value: s.cash }].concat(s.accounts.map((a) => ({ label: '　' + a.name, value: a.balance, sub: true }))).concat([{ label: '应收未收', value: s.arLeft }, { label: '资产合计', value: round2(s.cash + s.arLeft), strong: true }]),
    liabilities: [{ label: '应付未付', value: s.apLeft }, { label: '借款余额', value: s.debtLeft }, { label: '负债合计', value: round2(s.apLeft + s.debtLeft), strong: true }],
    equity: s.equity,
    check: round2(s.apLeft + s.debtLeft + s.equity - (s.cash + s.arLeft))
  }
  const tips = []
  if (s.net < 0) tips.push({ tone: 'bad', text: '这个月净利是负的（' + s.net + ' 元）：要么单少了，要么费用比赚的多。' })
  if (s.gross > 0 && s.expCash > s.gross) tips.push({ tone: 'bad', text: '现金支出（' + s.expCash + '）超过毛利（' + s.gross + '），钱是从老底子里出的。' })
  if (s.arLeft > 0 && s.inc === 0) tips.push({ tone: 'bad', text: '这个月一笔没收回来，但账上还挂着 ' + s.arLeft + ' 元应收 —— 去催款清单看看。' })
  if (s.arLeft > 0 && s.cash < s.apLeft) tips.push({ tone: 'bad', text: '手头现金比欠别人的少，注意周转。' })
  if (cats.length && cats[0].amt > s.orderAdd * 0.3) tips.push({ tone: 'warn', text: '「' + cats[0].category + '」花了 ' + round2(cats[0].amt) + ' 元，是这个月最大头。' })
  if (!tips.length) tips.push({ tone: 'ok', text: '这个月账看着挺稳：有单、有收、费用没冒尖。' })
  return c.json({ ok: true, month: m, pl, bs, cash: { inc: s.inc, out: s.out, net: round2(s.inc - s.out) }, cats: cats.map((x) => ({ name: x.category || '其他', amount: round2(num(x.amt)) })), tips })
})

// ===== 异常自动盯：某类费用突然冒尖 / 某家欠款突然翻倍 =====
app.get('/anomaly', async (c) => {
  const db = c.env.DB
  const months = []
  const d = new Date(now().slice(0, 7) + '-01T00:00:00.000Z')
  for (let i = 0; i < 7; i++) { const dd = new Date(d); dd.setUTCMonth(dd.getUTCMonth() - i); months.push(dd.toISOString().slice(0, 7)) }
  const cur = months[0]
  const list = []
  const catRows = (await db.prepare("SELECT month AS m, category, COALESCE(SUM(amount),0) AS amt FROM ledger WHERE direction='out' AND cash=1 AND ref_type='expense' AND substr(created_at,1,7)>=? GROUP BY m, category").bind(months[6]).all()).results || []
  const map = {}
  catRows.forEach((r) => { const k = r.category || '其他'; (map[k] = map[k] || {})[r.m] = num(r.amt) })
  Object.keys(map).forEach((k) => {
    const curAmt = map[k][cur] || 0
    const prev = months.slice(1, 7).map((m) => map[k][m] || 0).filter((x) => x > 0)
    if (!prev.length || curAmt <= 0) return
    const avg = prev.reduce((a, x) => a + x, 0) / prev.length
    if (curAmt > avg * 1.5 && curAmt - avg >= 200) list.push({ tone: 'bad', kind: 'cat', party: '', text: '「' + k + '」这个月花了 ' + round2(curAmt) + ' 元，平时平均 ' + round2(avg) + ' 元，多出 ' + round2(curAmt - avg) + ' 元。', cur: round2(curAmt), avg: round2(avg) })
  })
  const arRows = (await db.prepare("SELECT month AS m, customer, COALESCE(SUM(price),0) AS amt FROM orders WHERE month>=? GROUP BY m, customer").bind(months[6]).all()).results || []
  const amap = {}
  arRows.forEach((r) => { const k = r.customer || ''; (amap[k] = amap[k] || {})[r.m] = num(r.amt) })
  Object.keys(amap).forEach((k) => {
    const curAmt = amap[k][cur] || 0
    const prev = months.slice(1, 7).map((m) => amap[k][m] || 0).filter((x) => x > 0)
    if (!prev.length || curAmt <= 0) return
    const avg = prev.reduce((a, x) => a + x, 0) / prev.length
    if (curAmt > avg * 2 && curAmt - avg >= 1000) list.push({ tone: 'warn', kind: 'party', party: k, text: k + ' 这个月接单 ' + round2(curAmt) + ' 元，平时平均 ' + round2(avg) + ' 元，翻了一倍多 —— 别忘了留够产能、也留意他的信用额度。', cur: round2(curAmt), avg: round2(avg) })
  })
  const uncovered = (await db.prepare('SELECT COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) AS t, COUNT(*) AS c FROM orders WHERE price-paid-COALESCE(written_off,0) > 0 AND COALESCE(cost,0)=0').first()) || {}
  if (num(uncovered.c) > 0 && num(uncovered.t) >= 1000) list.push({ tone: 'warn', kind: 'nocost', party: '', text: '有 ' + num(uncovered.c) + ' 张单（合计 ' + round2(num(uncovered.t)) + ' 元）没填成本，毛利算不准 —— 补上成本才知道到底赚没赚。', cur: round2(num(uncovered.t)), avg: 0 })
  list.sort((a, b) => (a.tone === 'bad' ? -1 : 1) - (b.tone === 'bad' ? -1 : 1))
  return c.json({ ok: true, month: cur, list, count: list.length })
})

// ===== 年度总账：12 个月拼一张 =====
// ===== 年度总账：一年下来赚了多少、钱去哪了、年底还剩多少没收回来 =====
async function yearBook(db, y) {
  const y0 = y + '-01-01'
  const y1 = y + '-12-31'
  const prevY = String(num(y) - 1)
  const jobs = [
    // 接单额 / 成本 / 笔数，按月
    db.prepare(`SELECT month mk, COALESCE(SUM(price),0) inc, COALESCE(SUM(COALESCE(cost,0)),0) mat, COUNT(*) n
      FROM orders WHERE substr(created_at,1,4)=? GROUP BY mk`).bind(y).all(),
    // 现金：收 / 付 / 费用 / 折旧摊销预提，按月
    db.prepare(`SELECT substr(created_at,1,7) mk,
      COALESCE(SUM(CASE WHEN direction='in' AND cash=1 AND ref_type<>'transfer' THEN amount ELSE 0 END),0) recv,
      COALESCE(SUM(CASE WHEN direction='out' AND cash=1 AND ref_type<>'transfer' THEN amount ELSE 0 END),0) pay,
      COALESCE(SUM(CASE WHEN ${CASH_EXP_WHERE} THEN amount ELSE 0 END),0) exp,
      COALESCE(SUM(CASE WHEN cash=1 AND ref_type IN ('amort','dep','accrual') THEN amount ELSE 0 END),0) adj
      FROM ledger WHERE substr(created_at,1,4)=? GROUP BY mk`).bind(y).all(),
    // 现金余额：期初（账户期初 + 该年之前的流水）
    db.prepare(`SELECT COALESCE((SELECT SUM(COALESCE(opening,0)) FROM accounts),0) AS opening,
      COALESCE((SELECT SUM(CASE WHEN direction='in' THEN amount ELSE -amount END) FROM ledger WHERE cash=1 AND substr(created_at,1,10)<?),0) AS before_flow,
      COALESCE((SELECT SUM(CASE WHEN direction='in' THEN amount ELSE -amount END) FROM ledger WHERE cash=1 AND substr(created_at,1,10)<=?),0) AS upto_flow`).bind(y0, y1).first(),
    // 年底应收 / 应付（按「截至年底收付了多少」算，不能用现在的 paid）
    db.prepare(`SELECT COALESCE(SUM(CASE WHEN t.price - COALESCE(p.s,0) - COALESCE(w.s,0) > 0 THEN t.price - COALESCE(p.s,0) - COALESCE(w.s,0) ELSE 0 END),0) AS v, COUNT(*) AS c
      FROM orders t
      LEFT JOIN (SELECT ref_id, SUM(amount) s FROM ledger WHERE ref_type='order' AND direction='in' AND substr(created_at,1,10)<=? GROUP BY ref_id) p ON p.ref_id=t.id
      LEFT JOIN (SELECT ref_id, SUM(amount) s FROM writeoffs WHERE ref_type='order' AND substr(created_at,1,10)<=? GROUP BY ref_id) w ON w.ref_id=t.id
      WHERE substr(t.created_at,1,10)<=?`).bind(y1, y1, y1).first(),
    db.prepare(`SELECT COALESCE(SUM(CASE WHEN t.amount - COALESCE(p.s,0) - COALESCE(w.s,0) > 0 THEN t.amount - COALESCE(p.s,0) - COALESCE(w.s,0) ELSE 0 END),0) AS v, COUNT(*) AS c
      FROM payables t
      LEFT JOIN (SELECT ref_id, SUM(amount) s FROM ledger WHERE ref_type='payable' AND direction='out' AND substr(created_at,1,10)<=? GROUP BY ref_id) p ON p.ref_id=t.id
      LEFT JOIN (SELECT ref_id, SUM(amount) s FROM writeoffs WHERE ref_type='payable' AND substr(created_at,1,10)<=? GROUP BY ref_id) w ON w.ref_id=t.id
      WHERE substr(t.created_at,1,10)<=?`).bind(y1, y1, y1).first(),
    // 年底还欠多少钱（借款本金 − 已还本金）
    db.prepare(`SELECT COALESCE(SUM(d.principal),0) - COALESCE((SELECT SUM(r.amount) FROM debt_repays r WHERE r.kind='principal' AND substr(r.rdate,1,10)<=?),0) AS v
      FROM debts d WHERE substr(d.start_date,1,10)<=?`).bind(y1, y1).first(),
    // 去年对比
    db.prepare(`SELECT COALESCE(SUM(price),0) inc, COALESCE(SUM(COALESCE(cost,0)),0) mat FROM orders WHERE substr(created_at,1,4)=?`).bind(prevY).first(),
    db.prepare(`SELECT COALESCE(SUM(CASE WHEN ${CASH_EXP_WHERE} THEN amount ELSE 0 END),0) exp FROM ledger WHERE substr(created_at,1,4)=?`).bind(prevY).first()
  ]
  const [oR, lR, cashR, arR, apR, debtR, pOrdR, pExpR] = await Promise.all(jobs.map((j) => j.catch((e) => { noteFail(e, '年度总账'); return null })))
  const orows = (oR && oR.results) || []
  const lrows = (lR && lR.results) || []
  const oMap = {}, lMap = {}
  for (const r of orows) oMap[r.mk] = r
  for (const r of lrows) lMap[r.mk] = r
  const months = []
  let maxP = 1
  for (let i = 1; i <= 12; i++) {
    const mk = y + '-' + String(i).padStart(2, '0')
    const o = oMap[mk] || {}, l = lMap[mk] || {}
    const income = round2(num(o.inc))
    const mat = round2(num(o.mat))
    const exp = round2(num(l.exp))
    const adj = round2(num(l.adj))
    const profit = round2(income - mat - exp - adj)
    if (Math.abs(profit) > maxP) maxP = Math.abs(profit)
    months.push({ m: mk, label: String(i) + '月', income, mat, exp, adj, profit, cnt: num(o.n), recv: round2(num(l.recv)), pay: round2(num(l.pay)) })
  }
  for (const r of months) r.bar = Math.round(Math.abs(r.profit) / maxP * 100)
  const T = (k) => round2(months.reduce((a, x) => a + x[k], 0))
  const income = T('income'), mat = T('mat'), exp = T('exp'), adj = T('adj'), profit = T('profit')
  const active = months.filter((x) => x.income > 0 || x.profit !== 0)
  const sorted = months.slice().sort((a, b) => b.profit - a.profit)
  const best = sorted[0], worst = sorted[sorted.length - 1]
  const cash = cashR || {}
  const cashStart = round2(num(cash.opening) + num(cash.before_flow))
  const cashEnd = round2(num(cash.opening) + num(cash.upto_flow))
  const arEnd = round2(num(arR && arR.v)), apEnd = round2(num(apR && apR.v)), debtEnd = round2(num(debtR && debtR.v))
  const netEnd = round2(cashEnd + arEnd - apEnd - debtEnd)
  const prevIncome = round2(num(pOrdR && pOrdR.inc)), prevMat = round2(num(pOrdR && pOrdR.mat)), prevExp = round2(num(pExpR && pExpR.exp))
  const prevProfit = round2(prevIncome - prevMat - prevExp)
  const margin = income > 0 ? round2(profit / income * 100) : 0
  const tips = []
  if (!income && !exp) tips.push({ tone: 'gray', text: `${y} 年还没有单据，先把接的单和花的钱记上。` })
  else {
    if (prevProfit !== 0) {
      const d = round2(profit - prevProfit)
      tips.push({ tone: d >= 0 ? 'ok' : 'warn', text: `比 ${prevY} 年${d >= 0 ? '多赚' : '少赚'} ${Math.abs(d)} 元（${prevY} 年 ${prevProfit} 元）` })
    }
    if (active.length >= 2) tips.push({ tone: 'info', text: `最好的一个月是 ${best.label}（${best.profit} 元），最差是 ${worst.label}（${worst.profit} 元）` })
    if (arEnd > 0) tips.push({ tone: 'warn', text: `年底还有 ${arEnd} 元没收回来，这笔钱没进兜里` })
    if (apEnd > 0) tips.push({ tone: 'info', text: `年底还欠供应商 ${apEnd} 元` })
    if (debtEnd > 0) tips.push({ tone: 'warn', text: `年底还欠借款 ${debtEnd} 元` })
    if (margin < 15 && income > 0) tips.push({ tone: 'bad', text: `全年净利率只有 ${margin}%，几乎白干，看看哪几单不赚钱` })
  }
  const text = [
    `【${y} 年总账】`,
    `接单 ${income} 元（${months.reduce((a, x) => a + x.cnt, 0)} 单），材料·外协成本 ${mat} 元，现金费用 ${exp} 元，摊销折旧预提 ${adj} 元`,
    `净利 ${profit} 元，净利率 ${margin}%`,
    `现金：年初 ${cashStart} → 年底 ${cashEnd}（${cashEnd - cashStart >= 0 ? '多了' : '少了'} ${Math.abs(round2(cashEnd - cashStart))}）`,
    `年底还没收回来 ${arEnd} 元，欠供应商 ${apEnd} 元，欠借款 ${debtEnd} 元，家底 ${netEnd} 元`
  ].join('\n')
  return {
    ok: true, year: y, months, totals: { income, mat, exp, adj, profit, margin, recv: T('recv'), pay: T('pay'), cnt: months.reduce((a, x) => a + x.cnt, 0), avg_month: active.length ? round2(profit / active.length) : 0 },
    best: { label: best.label, profit: best.profit }, worst: { label: worst.label, profit: worst.profit },
    active_months: active.length,
    cash: { start: cashStart, end: cashEnd, net: round2(cashEnd - cashStart) },
    ar_end: arEnd, ap_end: apEnd, debt_end: debtEnd, net_worth: netEnd,
    prev: { year: prevY, income: prevIncome, profit: prevProfit },
    tips, text
  }
}

app.get('/year-book', async (c) => {
  const y = String(c.req.query('year') || now().slice(0, 4))
  if (!/^\d{4}$/.test(y)) return c.json({ error: '年份格式应为 YYYY' }, 400)
  return c.json(await yearBook(c.env.DB, y))
})


// ===== 一张纸的年度回顾：给家里人/合伙人看的，不是给会计看的 =====
async function yearReview(db, y) {
  const y1 = y + '-12-31'
  const yb = await yearBook(db, y)
  const jobs = [
    db.prepare(`SELECT customer party, COALESCE(SUM(price),0) inc, COUNT(*) n FROM orders WHERE substr(created_at,1,4)=? GROUP BY customer ORDER BY inc DESC`).bind(y).all(),
    db.prepare(`SELECT customer, item_name, price, created_at FROM orders WHERE substr(created_at,1,4)=? ORDER BY price DESC LIMIT 1`).bind(y).first(),
    db.prepare(`SELECT party, MIN(substr(created_at,1,10)) d, COUNT(*) n FROM dunning_log WHERE substr(created_at,1,4)=? GROUP BY party`).bind(y).all(),
    db.prepare(`SELECT COALESCE(SUM(amount),0) v, COUNT(*) n FROM writeoffs WHERE ref_type='order' AND substr(created_at,1,4)=?`).bind(y).first(),
    db.prepare(`SELECT COALESCE(SUM(price*0.15-(price-COALESCE(cost,0))),0) v, COUNT(*) n FROM orders
      WHERE substr(created_at,1,4)=? AND price>=1000 AND COALESCE(cost,0)>0 AND (price-COALESCE(cost,0))*1.0/price < 0.15`).bind(y).first(),
    db.prepare(`SELECT o.customer party, substr(l.created_at,1,10) d, l.amount FROM ledger l JOIN orders o ON o.id=l.ref_id
      WHERE l.ref_type='order' AND l.direction='in' AND substr(l.created_at,1,4)=?`).bind(y).all()
  ]
  const [custR, bigR, dunR, woR, lowR, inR] = await Promise.all(jobs.map((j) => j.catch((e) => { noteFail(e, '年度回顾'); return null })))
  const custs = ((custR && custR.results) || []).map((r) => ({ party: r.party, income: round2(num(r.inc)), cnt: num(r.n) }))
  const big = bigR && num(bigR.price) ? { party: bigR.customer, item: bigR.item_name, price: round2(num(bigR.price)), date: String(bigR.created_at || '').slice(0, 10) } : null
  const duns = (dunR && dunR.results) || []
  const firstDun = {}
  for (const r of duns) firstDun[norm(r.party)] = r.d
  let recovered = 0, recoveredParties = 0
  const hit = {}
  for (const r of ((inR && inR.results) || [])) {
    const k = norm(r.party)
    const d0 = firstDun[k]
    if (!d0) continue
    if (String(r.d) >= d0) { recovered += num(r.amount); hit[k] = 1 }
  }
  recoveredParties = Object.keys(hit).length
  const realLoss = round2(num(woR && woR.v)), realCnt = num(woR && woR.n)
  const missed = round2(num(lowR && lowR.v)), missedCnt = num(lowR && lowR.n)
  const income = yb.totals.income, profit = yb.totals.profit, margin = yb.totals.margin
  const cnt = yb.totals.cnt
  const active = yb.months.filter((m) => m.income > 0 || m.profit !== 0)
  // 最好/最差只在「有账的月份」里挑：把还没到的月份算成「最差 0 元」会误导
  const actSorted = active.slice().sort((a, b) => b.profit - a.profit)
  const best = actSorted.length ? { label: actSorted[0].label, profit: actSorted[0].profit } : yb.best
  const worst = actSorted.length ? { label: actSorted[actSorted.length - 1].label, profit: actSorted[actSorted.length - 1].profit } : yb.worst
  const topShare = income > 0 && custs.length ? round2(custs[0].income / income * 100) : 0
  const S = []
  if (!income && !yb.totals.exp) {
    S.push({ tone: 'gray', text: `${y} 年还没记过账，先把单子和钱记上，年底就能回顾了。` })
  } else {
    S.push({ tone: 'info', text: `${y} 年一共做了 ${custs.length} 家客户的 ${cnt} 单活，接单 ${income} 元，净利 ${profit} 元（净利率 ${margin}%）。` })
    if (big) S.push({ tone: 'info', text: `最大的一单是 ${big.party} 的「${big.item || '加工'}」，${big.price} 元，${big.date} 开的。` })
    if (active.length >= 2 && best.profit > 0) S.push({ tone: 'ok', text: `最好的一个月是 ${best.label}（${best.profit} 元），最差是 ${worst.label}（${worst.profit} 元）。` })
    if (duns.length) {
      const times = duns.reduce((a, x) => a + num(x.n), 0)
      S.push({ tone: recovered > 0 ? 'ok' : 'warn', text: `催款催了 ${duns.length} 家共 ${times} 次，催完收回 ${round2(recovered)} 元${recovered > 0 ? `（${recoveredParties} 家给了钱）` : '（一分没回）'}。` })
    }
    if (realLoss > 0) S.push({ tone: 'warn', text: `有 ${realLoss} 元是真收不回来的（${realCnt} 单核销掉了）。` })
    if (missed > 0) S.push({ tone: 'warn', text: `还有约 ${missed} 元是「本来能赚没赚到」的（${missedCnt} 单报价偏低，毛利不到 15%）。` })
    if (yb.ar_end > 0) S.push({ tone: 'warn', text: `到年底还有 ${yb.ar_end} 元在外面没收回，这笔钱不在兜里。` })
    S.push({ tone: 'info', text: `年底现金 ${yb.cash.end} 元，算上别人欠的和欠别人的，家底 ${yb.net_worth} 元。` })
    if (topShare >= 50 && custs.length >= 3) S.push({ tone: 'warn', text: `${custs[0].party} 一家就占了 ${topShare}% 的活，太靠一家了，明年可以多找一家。` })
    if (margin < 15 && income > 0) S.push({ tone: 'bad', text: `全年净利率只有 ${margin}%，几乎白干，得看看哪几单不赚钱。` })
  }
  const text = [`【${y} 年回顾】`].concat(S.map((x) => x.text)).join('\n')
  return {
    ok: true, year: y,
    headline: income ? `${y} 年：${cnt} 单活，净赚 ${profit} 元` : `${y} 年还没记过账`,
    stats: { customers: custs.length, orders: cnt, income, profit, margin, cash_end: yb.cash.end, ar_end: yb.ar_end, ap_end: yb.ap_end, net_worth: yb.net_worth, active_months: active.length },
    biggest: big, best: { label: best.label, profit: best.profit }, worst: { label: worst.label, profit: worst.profit },
    collect: { parties: duns.length, times: duns.reduce((a, x) => a + num(x.n), 0), recovered: round2(recovered), recovered_parties: recoveredParties },
    loss: { real: realLoss, real_cnt: realCnt, missed, missed_cnt: missedCnt, total: round2(realLoss + missed) },
    customers: custs.slice(0, 6).map((c, i) => ({ rank: i + 1, party: c.party, income: c.income, cnt: c.cnt, share: income > 0 ? round2(c.income / income * 100) : 0 })),
    months: yb.months.map((m) => ({ label: m.label, profit: m.profit, bar: m.bar })),
    prev: yb.prev, sentences: S, text
  }
}

app.get('/year-review', async (c) => {
  const y = String(c.req.query('year') || now().slice(0, 4))
  if (!/^\d{4}$/.test(y)) return c.json({ error: '年份格式应为 YYYY' }, 400)
  return c.json(await yearReview(c.env.DB, y))
})

app.get('/year-review-print-link', async (c) => {
  const y = String(c.req.query('year') || now().slice(0, 4))
  if (!/^\d{4}$/.test(y)) return c.json({ error: '年份格式应为 YYYY' }, 400)
  const saved = await getKey(c.env.DB)
  const t = saved ? await sigOf(saved, 'yearreview', 'yr:' + y) : ''
  return c.json({ ok: true, url: `${c.req.url.split('/year-review-print-link')[0]}/year-review-print?year=${encodeURIComponent(y)}&t=${encodeURIComponent(t)}`, year: y })
})

app.get('/year-review-print', async (c) => {
  const db = c.env.DB
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  const y = String(c.req.query('year') || now().slice(0, 4))
  const want = String(c.req.query('t') || '')
  const good = saved ? await sigOf(saved, 'yearreview', 'yr:' + y) : ''
  if (!good || want !== good) return c.html('<h3>链接已失效：请在小程序里重新生成年度回顾。</h3>')
  const d = await yearReview(db, y)
  const t = await getTitle(db)
  const bars = d.months.map((m) => `<div class="bc"><div class="bv">${m.profit || ''}</div><div class="bb" style="height:${Math.max(2, Math.round(Math.abs(m.profit) / Math.max(1, ...d.months.map((x) => Math.abs(x.profit))) * 90))}px"></div><div class="bl">${escHtml(m.label)}</div></div>`).join('')
  const cust = d.customers.map((r) => `<tr><td>${escHtml(r.party)}</td><td class="n">${r.cnt}</td><td class="n">${r.income}</td><td class="n">${r.share}%</td></tr>`).join('')
  const ss = d.sentences.map((x) => `<li>${escHtml(x.text)}</li>`).join('')
  const body = `<h1>${escHtml(y)} 年这一年</h1><div class="sub">${escHtml(t.title || '')}${t.phone ? ' · ' + escHtml(t.phone) : ''}　${now().slice(0, 10)}</div>
<div class="head">${escHtml(d.headline)}</div>
<table class="kv"><tr><td>客户</td><td class="n">${d.stats.customers} 家</td><td>单数</td><td class="n">${d.stats.orders} 单</td></tr>
<tr><td>接单额</td><td class="n">${d.stats.income}</td><td>净利</td><td class="n b">${d.stats.profit}（${d.stats.margin}%）</td></tr>
<tr><td>年底现金</td><td class="n">${d.stats.cash_end}</td><td>家底</td><td class="n">${d.stats.net_worth}</td></tr></table>
<h2>每个月的净利</h2><div class="chart">${bars}</div>
<h2>这一年发生了什么</h2><ul class="ss">${ss}</ul>
<h2>做得最多的几家</h2><table><tr><th>客户</th><th>单数</th><th>接单额</th><th>占比</th></tr>${cust || '<tr><td colspan="4">还没有客户</td></tr>'}</table>
<div class="sub" style="text-align:left;margin-top:8px">净利口径：接单额 − 单子上的材料·外协成本 − 现金费用 − 摊销 − 折旧 − 预提利息；赊购不算成本。催后收回指该家第一次催款之后收到的钱。</div>`
  return c.html(a4Page({
    title: `${y} 年回顾`,
    body,
    extraCss: `.head{text-align:center;font-size:19px;font-weight:700;margin:6px 0 12px;color:#0a4b8c}
      .sub{text-align:center} .kv td{padding:5px 8px} .kv td:nth-child(odd){color:#666;width:22%}
      .chart{display:flex;align-items:flex-end;gap:4px;height:120px;border-bottom:1px solid #ccc;padding:0 4px;margin:4px 0 2px}
      .bc{flex:1;text-align:center;display:flex;flex-direction:column;justify-content:flex-end;height:100%}
      .bv{font-size:9px;color:#666} .bb{background:#1f6feb;border-radius:2px 2px 0 0} .bl{font-size:10px;color:#555}
      .ss{margin:4px 0 0 18px;padding:0} .ss li{margin:3px 0;line-height:1.6}`,
    sign: `<span>制表人：____________</span><span>家里人：____________</span><span>日期：____________</span>`,
    tip: '这张是给自己和家人看的，不是给会计的；要报税用「给会计的资料包」'
  }))
})

// 年度总账打印链接（签名，免口令）
// ===== 一键结账全年：逐月自检 → 批量归档 → 年度封账单 =====
// ===== 老账搬家：把别的本子（Excel / 纸本 / 别的软件）上的欠款一次性搬进来 =====
// 一行一笔：客户名,金额[,成本][,开单日期]；日期留空就用「统一日期」
const MIG_ITEM = '期初搬入'
function migParse(text) {
  const out = []
  String(text || '').split(/\r?\n/).forEach((ln, idx) => {
    const raw = ln.trim()
    if (!raw) return
    if (/^(客户|供应商|单位|名字|合计)/.test(raw)) return // 表头行跳过
    let parts = raw.split(/[,，\t|]/).map((x) => x.trim())
    if (parts.length < 2) parts = raw.split(/\s+/).filter((x) => x !== '')
    if (parts.length < 2) { out.push({ i: idx + 1, party: raw, amount: 0, cost: null, date: '', raw }); return }
    const money = (v) => num(String(v == null ? '' : v).replace(/[¥￥,，\s元]/g, ''))
    const pick = (k) => (parts[k] === undefined || parts[k] === null || parts[k] === '' ? null : parts[k])
    const party = parts[0] || ''
    const amount = pick(1) === null ? 0 : money(parts[1])
    // 第 3 格可能是成本，也可能是日期（客户只写了名字、金额、日期）
    let cost = null
    let date = ''
    const f2 = pick(2)
    const f3 = pick(3)
    if (f2 !== null) { if (toIsoDate(f2)) date = toIsoDate(f2); else cost = money(f2) }
    if (f3 !== null) date = toIsoDate(f3) || date
    out.push({ i: idx + 1, party, amount, cost, date, raw })
  })
  return out
}

async function migPreview(db, body) {
  const type = String(body.type || 'ar') === 'ap' ? 'ap' : 'ar'
  const gDate = toIsoDate(body.date) || ''
  const mode = String(body.cost_mode || 'none')
  const margin = num(body.margin_pct) || 30
  let rows = []
  if (Array.isArray(body.rows) && body.rows.length) {
    rows = body.rows.map((r, i) => ({
      i: i + 1, party: String((r && r.party) || '').trim(), amount: num(r && r.amount),
      cost: (r && r.cost !== undefined && r.cost !== null && r.cost !== '') ? num(r.cost) : null,
      date: toIsoDate(r && r.date) || '', raw: ''
    }))
  } else {
    rows = migParse(body.text)
  }
  const partyCol = type === 'ar' ? 'customer' : 'supplier'
  const table = type === 'ar' ? 'orders' : 'payables'
  const amtCol = type === 'ar' ? 'price' : 'amount'
  const seen = new Set()
  const out = []
  for (const r of rows) {
    const row = { i: r.i, party: r.party, amount: round2(r.amount), cost: r.cost, date: (r.date || gDate).slice(0, 10), type, ok: true, error: '', dup: false, dup_text: '', known: false }
    if (!row.party) { row.ok = false; row.error = '没写名字' }
    else if (!(row.amount > 0)) { row.ok = false; row.error = '金额要大于 0' }
    else if (!row.date) { row.ok = false; row.error = '没写日期，也没选统一日期' }
    if (row.ok) {
      row.cost = row.type === 'ar' ? (r.cost !== null && r.cost !== undefined ? round2(r.cost) : (mode === 'pct' ? round2(row.amount * (1 - margin / 100)) : null)) : null
      if (row.cost !== null && row.cost < 0) row.cost = 0
      const key = row.party + '|' + row.amount + '|' + row.date
      if (seen.has(key)) { row.dup = true; row.dup_text = '这一批里前面已经有一笔一样的' }
      seen.add(key)
      if (!row.dup) {
        const hit = await db.prepare(`SELECT id FROM ${table} WHERE ${partyCol}=? AND ${amtCol}=? AND substr(created_at,1,10)=? LIMIT 1`).bind(row.party, row.amount, row.date).first()
        if (hit) { row.dup = true; row.dup_text = '账上已经有一笔一样的（' + row.date + ' ¥' + row.amount + '）' }
      }
      const known = await db.prepare(`SELECT 1 AS x FROM ${table} WHERE ${partyCol}=? LIMIT 1`).bind(row.party).first()
      row.known = !!known
    }
    out.push(row)
  }
  const good = out.filter((x) => x.ok)
  const arTotal = round2(good.reduce((s, x) => s + (x.type === 'ar' ? x.amount : 0), 0))
  const apTotal = round2(good.reduce((s, x) => s + (x.type === 'ap' ? x.amount : 0), 0))
  const dupN = good.filter((x) => x.dup).length
  const badN = out.filter((x) => !x.ok).length
  const parties = [...new Set(good.map((x) => x.party))]
  const total = round2(good.reduce((s, x) => s + x.amount, 0))
  const label = type === 'ar' ? '客户还欠' : '我欠供应商'
  const text = !out.length
    ? '还没输入内容。一行写一笔，比如：兴旺五金,5000'
    : (good.length
      ? `认出 ${good.length} 笔${label}，共 ¥${total}（${parties.length} 家）${dupN ? `，其中 ${dupN} 笔账上已经有了` : ''}${badN ? `，${badN} 行有问题要改` : ''}。`
      : `这 ${badN} 行都有问题，改好再来。`)
  return { ok: true, type, rows: out, count: out.length, ok_count: good.length, dup_count: dupN, bad_count: badN,
    ar_total: arTotal, ap_total: apTotal, total, parties: parties.length, party_list: parties.slice(0, 30),
    date: gDate ? gDate.slice(0, 10) : '', cost_mode: mode, margin_pct: margin, text }
}

app.post('/migrate-preview', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  return c.json(await migPreview(c.env.DB, body))
})

app.post('/migrate-apply', async (c) => {
  const db = c.env.DB
  const body = await c.req.json().catch(() => ({}))
  const pv = await migPreview(db, body)
  if (!pv.ok_count) return c.json({ error: pv.text || '没有可以搬的行' }, 400)
  if (pv.bad_count) return c.json({ error: `还有 ${pv.bad_count} 行有问题，先改好（${pv.rows.filter((x) => !x.ok).slice(0, 3).map((x) => `第 ${x.i} 行：${x.error}`).join('；')}）` }, 400)
  const months = [...new Set(pv.rows.filter((x) => x.ok).map((x) => x.date.slice(0, 7)))]
  for (const mm of months) {
    if (await isMonthLocked(db, mm)) return c.json({ error: `${mm} 已结账锁定，先解锁再搬（报表 → 月结归档 → 解锁）` }, 403)
  }
  const confirmDup = !!body.confirm_dup
  let added = 0
  let skipped = 0
  const addedRows = []
  for (const r of pv.rows) {
    if (!r.ok) continue
    if (r.dup && !confirmDup) { skipped++; continue }
    const created = r.date + 'T00:00:00.000Z'
    if (r.type === 'ar') {
      const due = (await termDue(db, r.party, created, 'ar')) || addDaysIso(r.date, 30)
      const ins = await db.prepare('INSERT INTO orders (customer, item_name, price, status, paid, due_date, operator, cost, created_at) VALUES (?,?,?,0,0,?,?,?,?)')
        .bind(r.party, MIG_ITEM, r.amount, due || null, '期初搬入', r.cost, created).run()
      addedRows.push({ type: 'ar', id: ins.meta && ins.meta.last_row_id, party: r.party, amount: r.amount })
    } else {
      const due = (await termDue(db, r.party, created, 'ap')) || addDaysIso(r.date, 30)
      const ins = await db.prepare('INSERT INTO payables (supplier, amount, remark, due_date, operator, paid, created_at) VALUES (?,?,?,?,?,0,?)')
        .bind(r.party, r.amount, MIG_ITEM, due || null, '期初搬入', created).run()
      addedRows.push({ type: 'ap', id: ins.meta && ins.meta.last_row_id, party: r.party, amount: r.amount })
    }
    added++
  }
  await logAudit(db, '老账搬入', pv.type === 'ar' ? '应收' : '应付', `搬入 ${added} 笔${skipped ? `（跳过重复 ${skipped} 笔）` : ''}，合计 ¥${pv.total}`, '', act(c))
  const addedTotal = round2(addedRows.reduce((s, x) => s + x.amount, 0))
  const text = added
    ? `搬进来 ${added} 笔${pv.type === 'ar' ? '客户欠款' : '供应商欠款'}，共 ¥${addedTotal}${skipped ? `；${skipped} 笔账上已经有了，没重复搬` : ''}。到期日按账期算好了（没设账期的按 30 天），这些单子已经能催款、能对账、能算账龄了。`
    : `这 ${skipped} 笔账上都已经有了，没有重复搬（确实要再记一遍的话，在「应收/应付」里手工录）。`
  return c.json({ ok: true, added, skipped, rows: addedRows, total: round2(addedRows.reduce((s, x) => s + x.amount, 0)), text,
    tip: pv.type === 'ar' && pv.rows.some((x) => x.ok && x.cost === null) ? '有些行没填成本：这些单子的毛利会偏高，方便时补一下成本（点开单子改成本）。' : '' })
})

const BC_LABEL = { recon_diff: '对账差异还没处理完', summary: '还没出本月小结', recon_rate: '这个月对账没做完' }
async function yearCloseScan(db, y) {
  const [om, pm, lm, ar, rc] = await Promise.all([
    db.prepare("SELECT substr(created_at,1,7) m, COUNT(*) n, COALESCE(SUM(COALESCE(price,0)),0) s FROM orders WHERE substr(created_at,1,4)=? GROUP BY m").bind(y).all(),
    db.prepare("SELECT substr(created_at,1,7) m, COUNT(*) n FROM payables WHERE substr(created_at,1,4)=? GROUP BY m").bind(y).all(),
    db.prepare("SELECT substr(created_at,1,7) m, COUNT(*) n FROM ledger WHERE cash=1 AND substr(created_at,1,4)=? GROUP BY m").bind(y).all(),
    db.prepare("SELECT month FROM month_archive WHERE substr(month,1,4)=?").bind(y).all(),
    db.prepare("SELECT substr(month,1,7) m, COUNT(*) n FROM recon_log WHERE done=0 AND COALESCE(state,'')<>'match' AND substr(month,1,4)=? GROUP BY m").bind(y).all()
  ])
  const map = (r) => { const o = {}; ((r && r.results) || []).forEach((x) => { o[x.m] = x }); return o }
  const O = map(om), P = map(pm), L = map(lm), R = map(rc)
  const closedSet = new Set(((ar && ar.results) || []).map((x) => x.month))
  const months = []
  for (let i = 1; i <= 12; i++) {
    const mm = y + '-' + String(i).padStart(2, '0')
    const o = O[mm] || { n: 0, s: 0 }
    const nOrders = num(o.n), nPay = num((P[mm] || {}).n), nLed = num((L[mm] || {}).n)
    const has = nOrders + nPay + nLed > 0
    const reconOpen = num((R[mm] || {}).n)
    const isClosed = closedSet.has(mm)
    const issues = []
    if (has && !isClosed) issues.push('还没结账')
    if (reconOpen > 0) issues.push(reconOpen + ' 处对账差异没处理')
    months.push({
      m: mm, label: i + '月', has_data: has, orders: nOrders, income: round2(num(o.s)),
      closed: isClosed, recon_open: reconOpen,
      ok: has ? (isClosed && reconOpen === 0) : true, issues
    })
  }
  const todo = months.filter((x) => x.has_data && !x.closed)
  const empties = months.filter((x) => !x.has_data)
  return {
    months, todo_count: todo.length, empty_count: empties.length,
    closed_count: months.filter((x) => x.closed).length, todo, empties
  }
}

app.get('/year-close-check', async (c) => {
  const db = c.env.DB
  const y = String(c.req.query('year') || now().slice(0, 4))
  if (!/^\d{4}$/.test(y)) return c.json({ error: '年份格式应为 YYYY' }, 400)
  const s = await yearCloseScan(db, y)
  const bad = s.months.filter((x) => x.recon_open > 0)
  const hasAny = s.months.some((x) => x.has_data)
  const text = !hasAny
    ? `${y} 年还没记过账，没有要结的月份。等有账了再来结。`
    : (s.todo_count === 0 && bad.length === 0
      ? `${y} 年有账的月份都结完了${s.empty_count ? `（${s.empty_count} 个月没记账）` : ''}，可以直接打年度封账单。`
      : `${y} 年还有 ${s.todo_count} 个月没结账${bad.length ? `、${bad.length} 个月有对账差异没处理` : ''}。结账会把每个月锁住，之后要改得先解锁。`)
  return c.json({
    ok: true, year: y, months: s.months, todo_count: s.todo_count, empty_count: s.empty_count,
    closed_count: s.closed_count, can_close: s.todo_count > 0, recon_bad: bad.map((x) => x.m), text,
    todo_list: s.todo.map((x) => x.label)
  })
})

app.post('/year-close', async (c) => {
  const db = c.env.DB
  const body = await c.req.json().catch(() => ({}))
  const y = String(body.year || now().slice(0, 4))
  if (!/^\d{4}$/.test(y)) return c.json({ error: '年份格式应为 YYYY' }, 400)
  const confirmed = !!body.confirm
  const s = await yearCloseScan(db, y)
  const todo = s.todo
  if (!todo.length) {
    return c.json({ ok: true, year: y, closed: [], skipped: s.empties.map((x) => x.label), blocked: [],
      text: `${y} 年有账的月份都已经结过了，没有要结的。` })
  }
  const blocked = []
  const done = []
  for (const it of todo) {
    const pc = await closePrecheck(db, it.m)
    if (pc.blockers.length && !confirmed) { blocked.push({ m: it.m, label: it.label, blockers: pc.blockers, labels: pc.blockers.map((k) => BC_LABEL[k] || k), text: pc.text }); continue }
    const snap = await monthSnapshot(db, it.m)
    snap.closed_at = now()
    await saveArchive(db, snap)
    await db.prepare('INSERT OR IGNORE INTO month_lock (month, locked_at) VALUES (?,?)').bind(it.m, now()).run()
    await logAudit(db, '年结归档', it.m, `年结 ${it.m}：净利 ${snap.profit}`)
    done.push({ m: it.m, label: it.label, profit: snap.profit, income: snap.order_add })
  }
  if (blocked.length && !confirmed) {
    return c.json({
      error: '有 ' + blocked.length + ' 个月结账前还有事没做完', code: 'need_confirm',
      blocked, closed: done.map((x) => x.label),
      text: blocked.map((b) => `${b.label}：${b.labels.join('、')}`).join('\n')
    }, 409)
  }
  const total = round2(done.reduce((a2, x) => a2 + num(x.profit), 0))
  return c.json({
    ok: true, year: y, closed: done, blocked, skipped: s.empties.map((x) => x.label),
    total_profit: total,
    text: `结完 ${done.length} 个月（${done.map((x) => x.label).join('、') || '无'}），这几个月合计净利 ¥${total}。${s.empties.length ? `另有 ${s.empties.length} 个月没记账，跳过。` : ''}`,
    lock_note: '结过的月份已经锁住：不能再新增、修改、删除单据，也不能再收付款、批量导入。',
    unlock_how: '要改某个月：报表 → 月结归档 → 点这个月旁边的「解锁」，改完再结一次。'
  })
})

app.get('/year-close-print-link', async (c) => {
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  if (!saved) return c.json({ error: '还没设访问口令' }, 400)
  const y = String(c.req.query('year') || now().slice(0, 4))
  if (!/^\d{4}$/.test(y)) return c.json({ error: '年份格式应为 YYYY' }, 400)
  const t = await sigOf(saved, 'year', 'yc:' + y)
  const base = new URL(c.req.url).origin
  return c.json({ ok: true, url: base + '/year-close-print?year=' + y + '&t=' + t })
})

app.get('/year-close-print', async (c) => {
  const db = c.env.DB
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  const y = String(c.req.query('year') || now().slice(0, 4))
  const want = String(c.req.query('t') || '')
  const good = saved ? await sigOf(saved, 'year', 'yc:' + y) : ''
  if (!good || want !== good) return c.html('<h3>链接已失效：请在小程序里重新生成年度封账单。</h3>')
  const d = await yearBook(db, y)
  const s = await yearCloseScan(db, y)
  const t = await getTitle(db)
  const stMap = {}
  s.months.forEach((x) => { stMap[x.m] = x })
  const rows = d.months.map((m) => {
    const st = stMap[m.m] || {}
    const state = !st.has_data ? '没记账' : (st.closed ? '已结账' : '未结账')
    return `<tr><td>${escHtml(m.label)}</td><td class="n">${m.cnt || ''}</td><td class="n">${m.income || ''}</td><td class="n">${m.mat || ''}</td><td class="n b ${m.profit < 0 ? 'red' : ''}">${m.profit || ''}</td><td class="n">${m.recv || ''}</td><td class="n">${m.pay || ''}</td><td class="${st.closed ? 'green' : ''}">${state}</td></tr>`
  }).join('')
  const body = `<h1>${escHtml(y)} 年度封账单</h1><div class="sub">${escHtml(t.title || '')}${t.phone ? ' · ' + escHtml(t.phone) : ''}　制表日期 ${now().slice(0, 10)}</div>
<table><tr><th>月份</th><th>单数</th><th>接单额</th><th>材料外协</th><th>净利</th><th>实收</th><th>实付</th><th>结账状态</th></tr>${rows}
<tr class="total"><td>全年</td><td class="n">${d.totals.cnt}</td><td class="n">${d.totals.income}</td><td class="n">${d.totals.mat}</td><td class="n">${d.totals.profit}</td><td class="n">${d.totals.recv}</td><td class="n">${d.totals.pay}</td><td>${s.closed_count} 个月已结</td></tr></table>
<h2>年底结存</h2>
<table><tr><td>现金（各账户合计）</td><td class="n">${d.cash.end}</td></tr><tr><td>客户还欠（应收）</td><td class="n">${d.ar_end}</td></tr><tr><td>欠供应商（应付）</td><td class="n">-${d.ap_end}</td></tr><tr><td>欠借款</td><td class="n">-${d.debt_end}</td></tr><tr class="total"><td>家底（净资产）</td><td class="n">${d.net_worth}</td></tr></table>
<h2>封账说明</h2><div class="sub" style="text-align:left">本年有账的 ${12 - s.empty_count} 个月中，已结账 ${s.closed_count} 个月${s.todo_count ? `，还有 ${s.todo_count} 个月未结（${escHtml(s.todo.map((x) => x.label).join('、'))}）` : '，全部结完'}。结账即锁定该月账目，之后如需修改须先解锁、改完重新结账。净利口径：接单额 − 材料·外协成本 − 现金费用 − 摊销 − 折旧 − 预提利息；赊购只进现金流，不重复计成本。年底应收/应付按截至 ${y}-12-31 的已收付计算。</div>`
  return c.html(a4Page({
    title: `${y} 年度封账单`,
    body,
    extraCss: `.sub{text-align:center} table{font-size:11.5px} th,td{padding:4px 6px}`,
    sign: `<span>制表人：____________</span><span>老板：____________</span><span>会计：____________</span><span>日期：____________</span>`,
    tip: '一年结完打一张，交给会计或存档；下一年从新年 1 月开始记，家底接着这张走'
  }))
})

app.get('/year-print-link', async (c) => {
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  if (!saved) return c.json({ error: '还没设访问口令' }, 400)
  const y = String(c.req.query('year') || now().slice(0, 4))
  if (!/^\d{4}$/.test(y)) return c.json({ error: '年份格式应为 YYYY' }, 400)
  const t = await sigOf(saved, 'year', 'yb:' + y)
  const base = new URL(c.req.url).origin
  return c.json({ ok: true, url: base + '/year-print?year=' + y + '&t=' + t })
})

app.get('/year-print', async (c) => {
  const db = c.env.DB
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  const y = String(c.req.query('year') || now().slice(0, 4))
  const want = String(c.req.query('t') || '')
  const good = saved ? await sigOf(saved, 'year', 'yb:' + y) : ''
  if (!good || want !== good) return c.html('<h3>链接已失效：请在小程序里重新生成年度总账打印页。</h3>')
  const d = await yearBook(db, y)
  const t = await getTitle(db)
  const rows = d.months.map((m) => `<tr><td>${escHtml(m.label)}</td><td class="n">${m.cnt || ''}</td><td class="n">${m.income || ''}</td><td class="n">${m.mat || ''}</td><td class="n">${m.exp || ''}</td><td class="n b ${m.profit < 0 ? 'red' : ''}">${m.profit || ''}</td><td class="n">${m.recv || ''}</td><td class="n">${m.pay || ''}</td></tr>`).join('')
  const body = `<h1>${escHtml(y)} 年度总账</h1><div class="sub">${escHtml(t.title || '')}${t.phone ? ' · ' + escHtml(t.phone) : ''}　制表日期 ${now().slice(0, 10)}</div>
<table><tr><th>月份</th><th>单数</th><th>接单额</th><th>材料外协</th><th>现金费用</th><th>净利</th><th>实收</th><th>实付</th></tr>${rows}
<tr class="total"><td>全年</td><td class="n">${d.totals.cnt}</td><td class="n">${d.totals.income}</td><td class="n">${d.totals.mat}</td><td class="n">${d.totals.exp}</td><td class="n">${d.totals.profit}</td><td class="n">${d.totals.recv}</td><td class="n">${d.totals.pay}</td></tr></table>
<h2>年底结存</h2>
<table><tr><td>现金（各账户合计）</td><td class="n">${d.cash.end}</td></tr><tr><td>客户还欠（应收）</td><td class="n">${d.ar_end}</td></tr><tr><td>欠供应商（应付）</td><td class="n">-${d.ap_end}</td></tr><tr><td>欠借款</td><td class="n">-${d.debt_end}</td></tr><tr class="total"><td>家底（净资产）</td><td class="n">${d.net_worth}</td></tr></table>
<h2>说明</h2><div class="sub" style="text-align:left">净利（权责口径）= 接单额 − 单子上的材料·外协成本 − 现金费用 − 摊销 − 折旧 − 预提利息；赊购只进现金流不重复算成本。年底应收/应付按「截至 ${y}-12-31 已收付多少」计算，不是现在的余额。</div>`
  return c.html(a4Page({
    title: `${y} 年度总账`,
    body,
    extraCss: `.sub{text-align:center} table{font-size:11.5px} th,td{padding:4px 6px}`,
    sign: `<span>制表人：____________</span><span>老板：____________</span><span>日期：____________</span>`,
    tip: '这张表可以打印出来给会计、给银行、给自己看'
  }))
})

// ===== 开新年度：把上年的结存变成新年的期初（不用手工抄一遍） =====
async function yearOpenData(db, y) {
  const py = String(num(y) - 1)
  const yb = await yearBook(db, py)
  const [bills, decLock, arCnt, apCnt, saved, live] = await Promise.all([
    db.prepare("SELECT (SELECT COUNT(*) FROM orders WHERE substr(created_at,1,4)=?) + (SELECT COUNT(*) FROM payables WHERE substr(created_at,1,4)=?) + (SELECT COUNT(*) FROM ledger WHERE substr(created_at,1,4)=?) n").bind(y, y, y).first().catch(() => ({ n: 0 })),
    db.prepare('SELECT COUNT(*) n FROM month_lock WHERE month=?').bind(py + '-12').first().catch(() => ({ n: 0 })),
    db.prepare('SELECT COUNT(*) n FROM orders WHERE price-COALESCE(paid,0)-COALESCE(written_off,0)>0.005 AND substr(created_at,1,4)<=?').bind(py).first().catch(() => ({ n: 0 })),
    db.prepare('SELECT COUNT(*) n FROM payables WHERE amount-COALESCE(paid,0)-COALESCE(written_off,0)>0.005 AND substr(created_at,1,4)<=?').bind(py).first().catch(() => ({ n: 0 })),
    db.prepare('SELECT value FROM settings WHERE key=?').bind('year_open_' + y).first().catch(() => null),
    netNow(db).catch(() => null)
  ])
  let rec = null
  try { rec = saved ? JSON.parse(saved.value) : null } catch (e) { rec = null }
  const opening = { cash: yb.cash.end, ar: yb.ar_end, ap: yb.ap_end, debt: yb.debt_end, net: yb.net_worth }
  const ar_cnt = num(arCnt && arCnt.n)
  const ap_cnt = num(apCnt && apCnt.n)
  const has_prev = yb.months.some((m) => m.cnt > 0)
  const new_bills = num(bills && bills.n)
  const dec_closed = num(decLock && decLock.n) > 0
  const items = []
  items.push({ k: 'prev', label: `${py} 年有没有账`, count: has_prev ? 1 : 0, tone: has_prev ? 'ok' : 'warn',
    tip: has_prev ? `${py} 年有账，可以结转` : `${py} 年没有账，没有可结转的数`,
    after: has_prev ? '' : '新年度从 0 开始，以前的账不用管', go: '' })
  items.push({ k: 'dec', label: `${py} 年 12 月结账`, count: dec_closed ? 1 : 0, tone: dec_closed ? 'ok' : 'warn',
    tip: dec_closed ? '12 月已经结账锁定' : '12 月还没结账（建议先结，结转数才定得下来）',
    after: dec_closed ? '' : '没结也能结转，只是以后补记了 12 月的单，结转数会和现在不一样', go: 'report' })
  items.push({ k: 'open_ar', label: '上年没收回来的钱', count: ar_cnt, tone: ar_cnt ? 'info' : 'ok',
    tip: ar_cnt ? `${ar_cnt} 张单共 ${round2(yb.ar_end)} 元会带到新年度继续追` : '上年欠款都收清了',
    after: '这些欠款不用重记，单据本来就在，新年度照常催、照常收', go: 'ar' })
  items.push({ k: 'open_ap', label: '上年没付完的钱', count: ap_cnt, tone: ap_cnt ? 'info' : 'ok',
    tip: ap_cnt ? `${ap_cnt} 张单共 ${round2(yb.ap_end)} 元会带到新年度继续付` : '上年欠款都付清了',
    after: '', go: 'ap' })
  items.push({ k: 'new_bills', label: `新年度已经记了 ${new_bills} 笔`, count: new_bills, tone: new_bills ? 'info' : 'ok',
    tip: new_bills ? `已经在 ${y} 年记了 ${new_bills} 笔了` : `${y} 年还没开始记账`,
    after: '开账只是把期初数定下来、留一张凭据，不影响已经记的单', go: '' })
  if (rec) items.push({ k: 'opened', label: '已经开过账', count: 1, tone: 'ok',
    tip: `已在 ${String(rec.created_at || '').slice(0, 16).replace('T', ' ')} 开过账`, after: '', go: '' })
  const drift = live ? {
    cash: round2(num(live.cash) - opening.cash), ar: round2(num(live.ar) - opening.ar),
    ap: round2(num(live.ap) - opening.ap), net: round2(num(live.net) - opening.net)
  } : null
  const bad = items.filter((x) => x.tone === 'warn').length
  return {
    ok: true, year: y, prev: py, opening, ar_cnt, ap_cnt, has_prev, new_bills, dec_closed,
    live: live ? { cash: round2(num(live.cash)), ar: round2(num(live.ar)), ap: round2(num(live.ap)), net: round2(num(live.net)) } : null,
    drift, opened: !!rec, record: rec, items, can_open: has_prev,
    text: !has_prev
      ? `${py} 年没有账，没什么可结转的。直接在 ${y} 年记账就行。`
      : `${y} 年年初接着 ${py} 年：手头现金 ${round2(opening.cash)} 元、客户还欠 ${round2(opening.ar)} 元（${ar_cnt} 单）、欠供应商 ${round2(opening.ap)} 元（${ap_cnt} 单）、欠借款 ${round2(opening.debt)} 元，家底 ${round2(opening.net)} 元。` +
        (rec ? '（已经开过账了）' : `点「确认开账」把这几个数定下来，留一张凭据。`) +
        (bad ? `\n注意：${items.filter((x) => x.tone === 'warn').map((x) => x.tip).join('；')}` : '')
  }
}

app.get('/year-open', async (c) => {
  const y = String(c.req.query('year') || now().slice(0, 4))
  if (!/^\d{4}$/.test(y)) return c.json({ error: '年份格式应为 YYYY' }, 400)
  return c.json(await yearOpenData(c.env.DB, y))
})

app.post('/year-open', async (c) => {
  const db = c.env.DB
  const body = await c.req.json().catch(() => ({}))
  const y = String(body.year || now().slice(0, 4))
  if (!/^\d{4}$/.test(y)) return c.json({ error: '年份格式应为 YYYY' }, 400)
  const d = await yearOpenData(db, y)
  if (!d.has_prev) return c.json({ error: `${d.prev} 年没有账，不用开账，直接在 ${y} 年记账就行` }, 400)
  if (d.opened && !body.confirm) {
    return c.json({ error: `${y} 年已经开过账了（${String((d.record || {}).created_at || '').slice(0, 10)}），要重新定一次期初就带 confirm:true`, code: 'already_open', record: d.record }, 409)
  }
  const rec = { year: y, from: d.prev, ...d.opening, ar_cnt: d.ar_cnt, ap_cnt: d.ap_cnt,
    note: String(body.note || '').slice(0, 200), created_at: now() }
  await db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .bind('year_open_' + y, JSON.stringify(rec)).run()
  await logAudit(db, '开新年度', y, `结转 ${d.prev} 年：现金 ${rec.cash}，应收 ${rec.ar}（${rec.ar_cnt} 单），应付 ${rec.ap}，借款 ${rec.debt}，家底 ${rec.net}`)
  return c.json({ ok: true, record: rec,
    text: `${y} 年开账了：年初现金 ${rec.cash} 元、应收 ${rec.ar} 元（${rec.ar_cnt} 单）、应付 ${rec.ap} 元（${rec.ap_cnt} 单）、借款 ${rec.debt} 元、家底 ${rec.net} 元。` +
      `\n这些欠款和借款不用重记——单据本来就在，新年度照常催、照常收。` +
      `\n想留一张纸：点「打印结转凭据」。` })
})

app.delete('/year-open/:year', async (c) => {
  const y = String(c.req.param('year') || '')
  if (!/^\d{4}$/.test(y)) return c.json({ error: '年份格式应为 YYYY' }, 400)
  await c.env.DB.prepare('DELETE FROM settings WHERE key=?').bind('year_open_' + y).run()
  await logAudit(c.env.DB, '撤销开账', y, `撤销 ${y} 年的开账凭据（数据不动）`)
  return c.json({ ok: true, note: '凭据删了，账上的数一分没动。' })
})

app.get('/year-open-print-link', async (c) => {
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  if (!saved) return c.json({ error: '还没设访问口令' }, 400)
  const y = String(c.req.query('year') || now().slice(0, 4))
  if (!/^\d{4}$/.test(y)) return c.json({ error: '年份格式应为 YYYY' }, 400)
  const t = await sigOf(saved, 'yearopen', 'yo:' + y)
  const base = new URL(c.req.url).origin
  return c.json({ ok: true, url: base + '/year-open-print?year=' + y + '&t=' + t })
})

app.get('/year-open-print', async (c) => {
  const db = c.env.DB
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  const y = String(c.req.query('year') || now().slice(0, 4))
  const want = String(c.req.query('t') || '')
  const good = saved ? await sigOf(saved, 'yearopen', 'yo:' + y) : ''
  if (!good || want !== good) return c.html('<h3>链接已失效：请在小程序里重新生成结转凭据。</h3>')
  const d = await yearOpenData(db, y)
  const t = await getTitle(db)
  const rec = d.record || { ...d.opening, ar_cnt: d.ar_cnt, ap_cnt: d.ap_cnt, created_at: now() }
  const body = `<h1>${escHtml(y)} 年度期初结转凭据</h1><div class="sub">${escHtml(t.title || '')}${t.phone ? ' · ' + escHtml(t.phone) : ''}　制单日期 ${now().slice(0, 10)}</div>
<h2>上年结存（${escHtml(d.prev)}-12-31）</h2>
<table><tr><th>项目</th><th>金额（元）</th><th>说明</th></tr>
<tr><td>手头现金（各账户合计）</td><td class="n">${rec.cash}</td><td>账户余额自动延续，不用重记</td></tr>
<tr><td>客户还欠（应收）</td><td class="n">${rec.ar}</td><td>${rec.ar_cnt || 0} 张单未结清</td></tr>
<tr><td>欠供应商（应付）</td><td class="n">${rec.ap}</td><td>${rec.ap_cnt || 0} 张单未付清</td></tr>
<tr><td>欠借款本金</td><td class="n">${rec.debt}</td><td>利息照合同继续算</td></tr>
<tr class="total"><td>家底（净资产）</td><td class="n">${rec.net}</td><td>现金 + 应收 − 应付 − 借款</td></tr></table>
<h2>结转说明</h2><div class="sub" style="text-align:left">以上余额是 ${escHtml(d.prev)} 年 12 月 31 日的结存，作为 ${escHtml(y)} 年的期初数。
未结清的单据、未还完的借款仍在系统里原样保留，新年度继续催收、继续付款，不需要重新录入一遍。
这张凭据只定「年初起点」，不改动任何账目。</div>
${rec.note ? `<h2>备注</h2><div class="sub" style="text-align:left">${escHtml(rec.note)}</div>` : ''}`
  return c.html(a4Page({
    title: `${y} 年度期初结转凭据`,
    body,
    extraCss: `.sub{text-align:center} table{font-size:12px} th,td{padding:5px 8px}`,
    sign: `<span>制表人：____________</span><span>老板：____________</span><span>会计：____________</span><span>日期：____________</span>`,
    tip: '这张纸是给会计和银行看的：说明新一年的账是从哪里接着算的'
  }))
})

// ===== 给会计的资料包：一年要交的东西打成一个 Excel =====
app.get('/tax-pack', async (c) => {
  const db = c.env.DB
  const y = String(c.req.query('year') || now().slice(0, 4))
  if (!/^\d{4}$/.test(y)) return c.json({ error: '年份格式应为 YYYY' }, 400)
  const y0 = y + '-01-01', y1 = y + '-12-31'
  const yb = await yearBook(db, y)
  const t = await getTitle(db)
  const [adjR, accR, ledR, invR, asR, debtR, repR, loanR] = await Promise.all([
    // 摊销/折旧/预提分开
    db.prepare(`SELECT COALESCE(SUM(CASE WHEN ref_type='amort' THEN amount ELSE 0 END),0) am,
      COALESCE(SUM(CASE WHEN ref_type='dep' THEN amount ELSE 0 END),0) dp,
      COALESCE(SUM(CASE WHEN ref_type='accrual' THEN amount ELSE 0 END),0) ac
      FROM ledger WHERE cash=1 AND substr(created_at,1,4)=?`).bind(y).all(),
    // 各账户年底余额 = 期初 + 截至年底流水
    db.prepare(`SELECT a.id, a.name, COALESCE(a.opening,0) op,
      COALESCE((SELECT SUM(CASE WHEN l.direction='in' THEN l.amount ELSE -l.amount END) FROM ledger l WHERE l.cash=1 AND (l.account_id=a.id) AND substr(l.created_at,1,10)<=?),0) flow
      FROM accounts a ORDER BY a.id`).bind(y1).all(),
    db.prepare(`SELECT l.*, COALESCE(a.name,'') acc FROM ledger l LEFT JOIN accounts a ON a.id=l.account_id
      WHERE l.cash=1 AND substr(l.created_at,1,4)=? ORDER BY l.id`).bind(y).all(),
    db.prepare("SELECT * FROM invoices WHERE substr(date,1,4)=? ORDER BY date, id").bind(y).all(),
    db.prepare('SELECT * FROM assets ORDER BY id').all(),
    db.prepare("SELECT * FROM debts WHERE substr(start_date,1,10)<=? ORDER BY id").bind(y1).all(),
    db.prepare("SELECT * FROM debt_repays WHERE substr(rdate,1,4)=? ORDER BY rdate, id").bind(y).all(),
    db.prepare('SELECT * FROM loans ORDER BY id').all()
  ])
  const adj = ((adjR && adjR.results) || [])[0] || {}
  const amort = round2(num(adj.am)), dep = round2(num(adj.dp)), accrue = round2(num(adj.ac))
  const accs = ((accR && accR.results) || []).map((a) => ({ name: a.name, balance: round2(num(a.op) + num(a.flow)) }))
  const cashEnd = round2(accs.reduce((s2, a) => s2 + a.balance, 0))
  const sheets = []
  const T = yb.totals
  sheets.push({ name: '总览', rows: [
    ['单位', t.title || ''], ['年度', y], ['导出日期', now().slice(0, 10)], [],
    ['接单额（加工费）', T.income], ['材料·外协成本', T.mat], ['现金费用', T.exp], ['折旧', dep], ['摊销', amort], ['预提利息', accrue],
    ['净利（权责口径）', T.profit], ['净利率%', T.margin], [],
    ['实收现金', T.recv], ['实付现金', T.pay], [],
    ['年初现金', yb.cash.start], ['年底现金', cashEnd],
    ['年底应收', yb.ar_end], ['年底应付', yb.ap_end], ['年底借款', yb.debt_end], ['年底家底', yb.net_worth]
  ] })
  sheets.push({ name: '月度汇总', rows: [['月份', '单数', '接单额', '材料外协', '现金费用', '摊销折旧预提', '净利', '实收', '实付']].concat(
    yb.months.map((m) => [m.label, m.cnt, m.income, m.mat, m.exp, m.adj, m.profit, m.recv, m.pay])
  ).concat([['全年', T.cnt, T.income, T.mat, T.exp, T.adj, T.profit, T.recv, T.pay]]) })
  sheets.push({ name: '利润表', rows: [
    ['项目', '金额', '说明'], ['一、接单额（加工费）', T.income, '这一年开的单'],
    ['减：材料·外协成本', T.mat, '单据上填的成本'], ['二、毛利', round2(T.income - T.mat), '接单 − 成本'],
    ['减：现金费用', T.exp, '工资/水电/房租/采购/辅料/运费等'], ['减：折旧', dep, '设备按月计提'],
    ['减：摊销', amort, '长期费用按月摊'], ['减：预提利息', accrue, '借款利息按月计提'],
    ['三、净利（权责口径）', T.profit, '毛利 − 各项费用'], [],
    ['备查：现金口径收 − 付', round2(T.recv - T.pay), '只看到账的钱，不等于净利']
  ] })
  const bs = [['资产', '金额'], ['货币资金', cashEnd]]
  accs.forEach((a) => bs.push(['　' + a.name, a.balance]))
  bs.push(['应收未收', yb.ar_end], ['资产合计', round2(cashEnd + yb.ar_end)], [])
  bs.push(['负债', '金额'], ['应付未付', yb.ap_end], ['借款余额', yb.debt_end], ['负债合计', round2(yb.ap_end + yb.debt_end)], [])
  bs.push(['所有者权益（资产 − 负债）', round2(cashEnd + yb.ar_end - yb.ap_end - yb.debt_end)], ['负债 + 权益', round2(yb.ap_end + yb.debt_end + (cashEnd + yb.ar_end - yb.ap_end - yb.debt_end))])
  sheets.push({ name: '资产负债表', rows: bs })
  const ords = (await db.prepare("SELECT * FROM orders WHERE substr(created_at,1,4)=? ORDER BY id").bind(y).all()).results || []
  sheets.push({ name: '应收明细', rows: [['单号', '客户', '产品', '金额', '成本', '毛利', '已收', '核销', '未收', '开单日', '到期日', '经手人']].concat(
    ords.map((o) => [o.id, o.customer, o.item_name || '', num(o.price), num(o.cost), round2(num(o.price) - num(o.cost)), num(o.paid), num(o.written_off),
      round2(num(o.price) - num(o.paid) - num(o.written_off)), String(o.created_at).slice(0, 10), o.due_date || '', o.operator || ''])
  ) })
  const pays = (await db.prepare("SELECT * FROM payables WHERE substr(created_at,1,4)=? ORDER BY id").bind(y).all()).results || []
  sheets.push({ name: '应付明细', rows: [['单号', '供应商', '说明', '金额', '已付', '核销', '未付', '开单日', '到期日', '经手人']].concat(
    pays.map((o) => [o.id, o.supplier, o.remark || '', num(o.amount), num(o.paid), num(o.written_off),
      round2(num(o.amount) - num(o.paid) - num(o.written_off)), String(o.created_at).slice(0, 10), o.due_date || '', o.operator || ''])
  ) })
  const led = (ledR && ledR.results) || []
  sheets.push({ name: '收支流水', rows: [['日期', '方向', '金额', '分类', '账户', '摘要', '类型']].concat(
    led.map((l) => [String(l.created_at).slice(0, 10), l.direction === 'in' ? '收' : '付', num(l.amount), l.category || '', l.acc || '', l.remark || '', l.ref_type || ''])
  ) })
  const invs = (invR && invR.results) || []
  sheets.push({ name: '发票台账', rows: [['日期', '类型', '发票号', '单位', '金额（含税）', '其中税额', '不含税', '备注']].concat(
    invs.map((i) => [String(i.date || '').slice(0, 10), i.type === 'in' ? '进项（收到）' : '销项（开出）', i.no || '', i.party || '', num(i.amount), num(i.tax), round2(num(i.amount) - num(i.tax)), i.remark || ''])
  ) })
  const assets = (asR && asR.results) || []
  const asRows = [['设备', '原值', '购入日', '年限', '残值率', '每月折旧', '截至年底已提', '年底净值', '状态']]
  for (const a of assets) {
    const life = Math.max(1, num(a.life_years) || 5)
    const rr = num(a.residual_rate)
    const monthly = round2(num(a.cost) * (1 - rr) / (life * 12))
    const buyM = String(a.buy_date || '').slice(0, 7)
    const endM = y1.slice(0, 7)
    let months = 0
    if (buyM) {
      const [by2, bm] = buyM.split('-').map(Number)
      const [ey, em] = endM.split('-').map(Number)
      months = Math.max(0, (ey - by2) * 12 + (em - bm) + 1)
    }
    const acc = Math.min(round2(num(a.cost) * (1 - rr)), round2(monthly * months))
    asRows.push([a.name, num(a.cost), a.buy_date || '', life, rr, monthly, acc, round2(num(a.cost) - acc), num(a.sold) ? '已处置' : '在用'])
  }
  sheets.push({ name: '固定资产', rows: asRows })
  const debts = (debtR && debtR.results) || []
  const reps = (repR && repR.results) || []
  const dRows = [['借款人', '类型', '本金', '年利率%', '起借日', '期限(月)', '还款方式', '本年还息', '本年还本', '截至年底还欠']]
  for (const d of debts) {
    const mine = reps.filter((r) => num(r.debt_id) === num(d.id))
    const intY = round2(mine.filter((r) => r.kind !== 'principal').reduce((a2, r) => a2 + num(r.amount), 0))
    const priY = round2(mine.filter((r) => r.kind === 'principal').reduce((a2, r) => a2 + num(r.amount), 0))
    const priAll = round2(((await db.prepare("SELECT COALESCE(SUM(amount),0) a FROM debt_repays WHERE debt_id=? AND kind='principal'").bind(d.id).first()) || {}).a)
    dRows.push([d.lender, d.kind || '', num(d.principal), num(d.rate), d.start_date || '', num(d.term_months), d.pay_kind || '', intY, priY, round2(num(d.principal) - priAll)])
  }
  sheets.push({ name: '借款利息', rows: dRows })
  const loans = (loanR && loanR.results) || []
  sheets.push({ name: '员工借支', rows: [['员工', '借出', '已报销', '已退回', '还欠', '备注', '日期']].concat(
    loans.map((l) => [l.employee, num(l.amount), num(l.used), num(l.returned), round2(num(l.amount) - num(l.used) - num(l.returned)), l.remark || '', String(l.created_at || '').slice(0, 10)])
  ) })
  const xlsx = await makeXlsxSheets(sheets)
  const b64 = toB64(xlsx)
  const size = xlsx.length
  await logAudit(db, '导出资料包', t.title || '', `${y} 年资料包 ${sheets.length} 个表`)
  return c.json({
    ok: true, year: y, name: `报税资料包_${y}.xlsx`, b64, size,
    sheets: sheets.map((s2) => s2.name),
    summary: { income: T.income, profit: T.profit, cash: cashEnd, ar: yb.ar_end, ap: yb.ap_end, debt: yb.debt_end, invoices: invs.length, assets: assets.length },
    text: `${y} 年资料包：${sheets.length} 个表（总览/月度汇总/利润表/资产负债表/应收/应付/流水/发票/固定资产/借款/借支），${Math.round(size / 1024)} KB。`
  })
})

app.get('/year-summary', async (c) => {
  const db = c.env.DB
  const y = String(c.req.query('year') || now().slice(0, 4))
  if (!/^\d{4}$/.test(y)) return c.json({ error: '年份格式应为 YYYY' }, 400)
  const ms = []
  for (let i = 1; i <= 12; i++) ms.push(y + '-' + String(i).padStart(2, '0'))
  // 性能：原来 12 个月 × monthSum（每月 4 条查询，共 48 条串行，7 秒），改成 2 条按年分组的查询自己拆到月
  const [oR, lR] = await Promise.all([
    db.prepare('SELECT month mk, COALESCE(SUM(price),0) add_, COALESCE(SUM(COALESCE(cost,0)),0) cst FROM orders WHERE substr(created_at,1,4)=? GROUP BY mk').bind(y).all().catch((e) => { noteFail(e, '年度汇总'); return { results: [] } }),
    db.prepare(`SELECT substr(created_at,1,7) mk,
      COALESCE(SUM(CASE WHEN direction='in' AND cash=1 AND ref_type<>'transfer' THEN amount ELSE 0 END),0) inc,
      COALESCE(SUM(CASE WHEN direction='out' AND cash=1 AND ref_type<>'transfer' THEN amount ELSE 0 END),0) outt,
      COALESCE(SUM(CASE WHEN ${CASH_EXP_WHERE} THEN amount ELSE 0 END),0) exp,
      COALESCE(SUM(CASE WHEN direction='out' AND cash=0 AND ref_type='dep' THEN amount ELSE 0 END),0) dep,
      COALESCE(SUM(CASE WHEN direction='out' AND cash=0 AND ref_type='amort' THEN amount ELSE 0 END),0) amort,
      COALESCE(SUM(CASE WHEN direction='out' AND cash=0 AND ref_type='debt_int' THEN amount ELSE 0 END),0) accr
      FROM ledger WHERE substr(created_at,1,4)=? GROUP BY mk`).bind(y).all().catch((e) => { noteFail(e, '年度汇总'); return { results: [] } })
  ])
  const oMap = {}, lMap = {}
  for (const r of ((oR && oR.results) || [])) oMap[r.mk] = r
  for (const r of ((lR && lR.results) || [])) lMap[r.mk] = r
  const rows = []
  for (const m of ms) {
    const o = oMap[m] || {}, l = lMap[m] || {}
    const orderAdd = round2(num(o.add_)), orderCost = round2(num(o.cst))
    const inc = round2(num(l.inc)), outt = round2(num(l.outt))
    const expCash = round2(num(l.exp)), dep = round2(num(l.dep)), amort = round2(num(l.amort)), accrual = round2(num(l.accr))
    const gross = round2(orderAdd - orderCost)
    rows.push({ m, month_label: Number(m.slice(5, 7)) + '月', order_add: orderAdd, cost: orderCost, gross, expense: round2(expCash + dep + amort + accrual), profit: round2(gross - expCash - dep - amort - accrual), cash_in: inc, cash_out: outt, cash_net: round2(inc - outt) })
  }
  const t = (k) => round2(rows.reduce((a, x) => a + num(x[k]), 0))
  const active = rows.filter((x) => x.order_add > 0 || x.expense > 0 || x.cash_in > 0)
  const best = active.length ? active.reduce((a, b) => (b.profit > a.profit ? b : a)) : null
  const worst = active.length ? active.reduce((a, b) => (b.profit < a.profit ? b : a)) : null
  const maxProfit = Math.max(1, ...rows.map((x) => Math.abs(x.profit)))
  rows.forEach((x) => { x.bar_w = Math.round(Math.abs(x.profit) / maxProfit * 100); x.neg = x.profit < 0 })
  return c.json({
    ok: true, year: y, rows,
    total: { order_add: t('order_add'), cost: t('cost'), gross: t('gross'), expense: t('expense'), profit: t('profit'), cash_in: t('cash_in'), cash_out: t('cash_out'), cash_net: t('cash_net') },
    active_months: active.length,
    best: best ? { month_label: best.month_label, profit: best.profit } : null,
    worst: worst ? { month_label: worst.month_label, profit: worst.profit } : null,
    avg_profit: active.length ? round2(t('profit') / active.length) : 0
  })
})

async function runMonthPack(db, m) {
  const sheets = await packSheets(db, m)
  const b64 = toB64(await makeXlsxSheets(sheets))
  if (b64.length > 1400000) return { ok: false, month: m, size: b64.length, error: '文件太大（' + Math.round(b64.length / 1024) + 'KB），请在报表页单月导出' }
  await db.prepare('INSERT INTO month_report (month, name, b64, size, created_at) VALUES (?,?,?,?,?)').bind(m, '全套报表_' + m + '.xlsx', b64, b64.length, now()).run()
  return { ok: true, month: m, size: b64.length }
}

app.get('/month-reports', async (c) => {
  const rows = (await c.env.DB.prepare('SELECT id, month, name, size, created_at FROM month_report ORDER BY id DESC LIMIT 24').all()).results || []
  return c.json({ ok: true, rows })
})

app.get('/month-pack-file', async (c) => {
  const m = String(c.req.query('month') || '')
  const r = await c.env.DB.prepare('SELECT * FROM month_report WHERE month=? ORDER BY id DESC LIMIT 1').bind(m).first()
  if (!r) return c.json({ error: '这个月还没有自动生成的报表包' }, 404)
  return c.json({ ok: true, month: r.month, name: r.name, b64: r.b64 })
})

app.post('/month-pack-run', async (c) => {
  const m = String((await c.req.json().catch(() => ({}))).month || now().slice(0, 7))
  const r = await runMonthPack(c.env.DB, m)
  return c.json(r)
})

// ===== 导入批次留痕：记下这一次导了哪些单据，导错了能整批撤回 =====
async function logImport(db, type, r, src) {
  try {
    const cnt = num(r && r.imported)
    if (!cnt) return
    await db.prepare('INSERT INTO import_log (type, cnt, total, dup_count, skipped_locked, ids, src, undone, created_at, batch) VALUES (?,?,?,?,?,?,?,0,?,?)')
      .bind(String(type), cnt, round2(num(r && r.total)), num(r && r.dup_count), num(r && r.skipped_locked), JSON.stringify((r && r.ids) || []), String(src || ''), now(), String((r && r.batch) || '')).run()
  } catch (e) { /* 记录失败不影响导入本身 */ }
}

app.get('/import-log', async (c) => {
  const db = c.env.DB
  const rows = (await db.prepare('SELECT * FROM import_log ORDER BY id DESC LIMIT 50').all()).results || []
  const out = rows.map((r) => {
    let n = 0
    try { n = (JSON.parse(r.ids || '[]') || []).length } catch (e) { n = 0 }
    return { id: r.id, type: r.type, cnt: num(r.cnt), total: round2(num(r.total)), dup_count: num(r.dup_count), skipped_locked: num(r.skipped_locked), ids_count: n, src: r.src, undone: num(r.undone), created_at: r.created_at, batch: r.batch || '' }
  })
  return c.json({ ok: true, rows: out, count: out.length })
})

// 这一批导了哪几笔、现在什么状态（能追到单据，单据上也有批次号）
app.get('/import-log/:id', async (c) => {
  const db = c.env.DB
  const lg = await db.prepare('SELECT * FROM import_log WHERE id=?').bind(c.req.param('id')).first()
  if (!lg) return c.json({ error: '找不到这批导入记录' }, 404)
  let ids = []
  try { ids = JSON.parse(lg.ids || '[]') || [] } catch (e) { ids = [] }
  const t = String(lg.type || '')
  const rows = []
  const push = (x, kind, party, amount, paid, written, date, status) => rows.push({
    kind, id: x.id, party: party || '', amount: round2(num(amount)), paid: round2(num(paid)),
    written_off: round2(num(written)), left: round2(num(amount) - num(paid) - num(written)),
    date: String(date || '').slice(0, 10), status: status || '', done: num(paid) + num(written) >= num(amount) - 0.01
  })
  if (ids.length) {
    const ph = ids.map(() => '?').join(',')
    if (t === 'ar' || t === 'ar_init') {
      const r = (await db.prepare(`SELECT * FROM orders WHERE id IN (${ph}) ORDER BY id`).bind(...ids).all()).results || []
      r.forEach((x) => push(x, 'ar', x.customer, x.price, x.paid, x.written_off, x.created_at, x.item_name))
    } else if (t === 'ap' || t === 'ap_init') {
      const r = (await db.prepare(`SELECT * FROM payables WHERE id IN (${ph}) ORDER BY id`).bind(...ids).all()).results || []
      r.forEach((x) => push(x, 'ap', x.supplier, x.amount, x.paid, x.written_off, x.created_at, x.remark))
    } else if (t === 'expense') {
      const r = (await db.prepare(`SELECT * FROM ledger WHERE id IN (${ph}) AND ref_type='expense' ORDER BY id`).bind(...ids).all()).results || []
      r.forEach((x) => push(x, 'expense', x.category, x.amount, 0, 0, x.created_at, x.remark))
    } else {
      const r = (await db.prepare(`SELECT * FROM loans WHERE id IN (${ph}) ORDER BY id`).bind(...ids).all()).results || []
      r.forEach((x) => push(x, 'loan', x.staff, x.amount, num(x.used) + num(x.returned), 0, x.created_at, x.remark))
    }
  }
  const leftTotal = round2(rows.reduce((a, x) => a + (x.kind === 'expense' ? 0 : x.left), 0))
  return c.json({
    ok: true, id: lg.id, type: lg.type, batch: lg.batch || '', src: lg.src || '', undone: num(lg.undone),
    created_at: lg.created_at, cnt: num(lg.cnt), total: round2(num(lg.total)),
    ids_count: ids.length, found: rows.length, missing: Math.max(0, ids.length - rows.length),
    paid_count: rows.filter((x) => x.done && x.kind !== 'expense').length, left_total: leftTotal,
    rows
  })
})

// 整批撤回：把这一批导入产生的单据/流水删掉（只删这一批，别的批次不动）
app.post('/import-undo/:id', async (c) => {
  const db = c.env.DB
  const id = num(c.req.param('id'))
  const log = await db.prepare('SELECT * FROM import_log WHERE id=?').bind(id).first()
  if (!log) return c.json({ error: '找不到这一批导入记录' }, 404)
  if (num(log.undone)) return c.json({ error: '这一批已经撤回过' }, 400)
  let ids = []
  try { ids = JSON.parse(log.ids || '[]') || [] } catch (e) { ids = [] }
  if (!ids.length) return c.json({ error: '这一批没有可撤回的单据（报销类请到借支里处理）' }, 400)
  const type = String(log.type || '')
  let del = 0
  let skipped = 0
  let reason = ''
  if (type === 'ar' || type === 'ar_init') {
    for (const oid of ids) {
      const o = await db.prepare('SELECT * FROM orders WHERE id=?').bind(oid).first()
      if (!o) { skipped++; continue }
      if (await isMonthLocked(db, (o.created_at || '').slice(0, 7))) { skipped++; reason = '有单据在已结账月份'; continue }
      if (num(o.paid) > 0 || num(o.written_off) > 0) { skipped++; reason = '有单据已经收过款或核销过'; continue }
      await db.prepare('DELETE FROM orders WHERE id=?').bind(oid).run()
      del++
    }
  } else if (type === 'ap' || type === 'ap_init') {
    for (const pid of ids) {
      const p = await db.prepare('SELECT * FROM payables WHERE id=?').bind(pid).first()
      if (!p) { skipped++; continue }
      if (await isMonthLocked(db, (p.created_at || '').slice(0, 7))) { skipped++; reason = '有单据在已结账月份'; continue }
      if (num(p.paid) > 0 || num(p.written_off) > 0) { skipped++; reason = '有单据已经付过款或核销过'; continue }
      await db.prepare('DELETE FROM payables WHERE id=?').bind(pid).run()
      del++
    }
  } else if (type === 'expense') {
    for (const lid of ids) {
      const l = await db.prepare('SELECT * FROM ledger WHERE id=?').bind(lid).first()
      if (!l) { skipped++; continue }
      if (await isMonthLocked(db, (l.created_at || '').slice(0, 7))) { skipped++; reason = '有流水在已结账月份'; continue }
      if (String(l.ref_type || '') !== 'expense') { skipped++; continue }
      await db.prepare('DELETE FROM ledger WHERE id=?').bind(lid).run()
      del++
    }
  } else if (type === 'loan') {
    for (const lid of ids) {
      const l = await db.prepare('SELECT * FROM loans WHERE id=?').bind(lid).first()
      if (!l) { skipped++; continue }
      if (num(l.used) > 0 || num(l.returned) > 0) { skipped++; reason = '这笔借支已经报销或退回过'; continue }
      await db.prepare('DELETE FROM ledger WHERE ref_type=? AND ref_id=?').bind('loan', lid).run()
      await db.prepare('DELETE FROM loans WHERE id=?').bind(lid).run()
      del++
    }
  } else {
    return c.json({ error: '这一类不支持整批撤回' }, 400)
  }
  await db.prepare('UPDATE import_log SET undone=1 WHERE id=?').bind(id).run()
  await logAudit(db, '撤回导入', type, `撤回 ${del} 条${skipped ? `，跳过 ${skipped} 条` : ''}`)
  return c.json({ ok: true, deleted: del, skipped, reason })
})

app.delete('/import-log/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM import_log WHERE id=?').bind(num(c.req.param('id'))).run()
  return c.json({ ok: true })
})

app.post('/import', async (c) => {
  const { type, text, confirm_dup: cd } = await c.req.json()
  const lines = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean)
  if (!lines.length) return c.json({ error: '没有可导入的内容' }, 400)
  const rows = lines.map((row) => row.split(/[,，\t]/).map((s) => s.trim()))
  const rr = await importRows(c.env.DB, type, rows, { confirmDup: !!cd, by: act(c) })
  await logImport(c.env.DB, type, rr, 'paste')
  return c.json({ ok: true, imported: num(rr && rr.imported), skipped_locked: num(rr && rr.skipped_locked), dup: rr.dup || [], dup_count: num(rr && rr.dup_count), total: num(rr && rr.total), batch: (rr && rr.batch) || '' })
})

// ===== 数据量体检与老日志清理（长期用下来表会越来越胖） =====
const STAT_TABS = [
  ['orders', '应收单'], ['payables', '应付单'], ['ledger', '收付流水'], ['audit_log', '操作日志'],
  ['error_log', '运行日志'], ['import_log', '导入记录'], ['backups', '本地快照'], ['trash', '回收站'],
  ['dunning_log', '催款记录'], ['statement_log', '对账单送达'], ['recon_log', '对账台账'], ['month_archive', '月结归档']
]
app.get('/db-stats', async (c) => {
  const db = c.env.DB
  const out = await Promise.all(STAT_TABS.map(async ([t, label]) => {
    try {
      const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()
      return { k: t, label, n: num(r && r.n) }
    } catch (e) { return { k: t, label, n: -1 } }
  }))
  const total = out.reduce((a, x) => a + Math.max(0, x.n), 0)
  return c.json({ ok: true, rows: out, total })
})

// 只清「日志类」，业务数据一行不动；默认半年前
app.post('/db-clean', async (c) => {
  const b = await c.req.json().catch(() => ({}))
  const days = Math.max(30, Math.min(3650, Math.round(num(b.days) || 180)))
  const db = c.env.DB
  const cut = new Date(Date.now() + TZ_MS - days * 86400000).toISOString()
  const targets = ['audit_log', 'error_log', 'import_log']
  const deleted = {}
  for (const t of targets) {
    try {
      const r = await db.prepare(`DELETE FROM ${t} WHERE created_at < ?`).bind(cut).run()
      deleted[t] = (r.meta && r.meta.changes) || 0
    } catch (e) { deleted[t] = -1 }
  }
  // 回收站只留 30 天（和每日 cron 同一口径，这里手动补一次）
  try {
    const cut30 = new Date(Date.now() + TZ_MS - 30 * 86400000).toISOString()
    const r = await db.prepare('DELETE FROM trash WHERE deleted_at < ?').bind(cut30).run()
    deleted.trash = (r.meta && r.meta.changes) || 0
  } catch (e) { deleted.trash = -1 }
  try {
    await db.prepare("DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY id DESC LIMIT 30)").run()
  } catch (e) { /* 忽略 */ }
  await logAudit(db, '数据维护', 'clean', `清理 ${days} 天前的日志：${JSON.stringify(deleted)}`)
  return c.json({ ok: true, days, cut, deleted })
})

// ===== 整库备份 / 搬家：把每一张表原样导出成一个 JSON 包，换设备、换环境都能整包搬回去 =====
const DUMP_SKIP = new Set(['sqlite_sequence', 'd1_migrations'])
async function tableList(db) {
  const r = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).results || []
  // _cf_KV 之类的内部表不能 SELECT，跳过（表名带下划线开头）
  return r.map((x) => x.name).filter((n) => !DUMP_SKIP.has(n) && !String(n).startsWith('_'))
}
async function dumpAll(db) {
  const tabs = await tableList(db)
  const tables = {}
  const counts = {}
  for (const t of tabs) {
    const rs = (await db.prepare(`SELECT * FROM ${t} LIMIT 20000`).all()).results || []
    tables[t] = rs
    counts[t] = rs.length
  }
  // 口令不随包走（包可能被转发、被存到网盘），恢复后口令还是原来的
  if (Array.isArray(tables.settings)) {
    const keep = tables.settings.filter((x) => !['access_key', 'staff_key'].includes(String(x.key)))
    tables.settings = keep
    counts.settings = keep.length
  }
  return { ok: true, kind: 'factory-accounting-full', v: 1, at: now(), book: null, tables, counts, table_count: tabs.length, rows_total: Object.values(counts).reduce((a, b) => a + b, 0) }
}
app.get('/export-all', async (c) => {
  const db = c.env.DB
  const only = String(c.req.query('only') || '')
  if (only) {
    const tabs = await tableList(db)
    if (!tabs.includes(only)) return c.json({ error: '没有这张表', tables: tabs }, 400)
    const rs = (await db.prepare(`SELECT * FROM ${only} LIMIT 20000`).all()).results || []
    return c.json({ ok: true, only, rows: rs.length, sample: rs.slice(0, 3) })
  }
  const d = await dumpAll(db)
  const nm = await getTitle(db).catch(() => ({ title: '' }))
  d.book = (nm && nm.title) || ''
  return c.json(d)
})

// 整包恢复：replace=先清空再灌（同 id 保留）；merge=只补缺的行
app.post('/import-all', async (c) => {
  const b = await c.req.json()
  const db = c.env.DB
  const pkg = b.pkg && typeof b.pkg === 'object' ? b.pkg : null
  if (!pkg || pkg.kind !== 'factory-accounting-full' || !pkg.tables) return c.json({ error: '这个包不是本小程序的整库备份（缺 kind 标记）' }, 400)
  const mode = b.mode === 'merge' ? 'merge' : 'replace'
  if (mode === 'replace' && String(b.confirm || '') !== '覆盖') return c.json({ error: '整包覆盖会清空现在所有数据，确认请在 confirm 里写「覆盖」' }, 400)
  await saveBackup(db, 'restore-all')
  // 口令不随包走：整包覆盖时先把当前口令留一份，灌完再放回去（否则会被清空、下次打不开）
  let keepKeys = []
  if (mode === 'replace') {
    try { keepKeys = (await db.prepare("SELECT key, value FROM settings WHERE key IN ('access_key','staff_key')").all()).results || [] } catch (e) { keepKeys = [] }
  }
  const have = new Set(await tableList(db))
  const done = {}
  const skipped = {}
  for (const t of Object.keys(pkg.tables)) {
    if (!have.has(t)) { skipped[t] = 'no_table'; continue }
    const rows = Array.isArray(pkg.tables[t]) ? pkg.tables[t] : []
    if (mode === 'replace') { try { await db.prepare(`DELETE FROM ${t}`).run() } catch (e) { skipped[t] = 'delete_fail'; continue } }
    let ins = 0
    for (let i = 0; i < rows.length; i += 40) {
      const chunk = rows.slice(i, i + 40)
      const stmts = []
      for (const r of chunk) {
        const cols = Object.keys(r || {})
        if (!cols.length) continue
        const ph = cols.map((x) => (r[x] === null || r[x] === undefined ? 'NULL' : '?')).join(',')
        const vals = cols.filter((x) => r[x] !== null && r[x] !== undefined).map((x) => r[x])
        const verb = mode === 'merge' ? 'INSERT OR IGNORE' : 'INSERT OR REPLACE'
        stmts.push(db.prepare(`${verb} INTO ${t} (${cols.map((x) => `"${x}"`).join(',')}) VALUES (${ph})`).bind(...vals))
      }
      if (!stmts.length) continue
      try { await db.batch(stmts); ins += stmts.length } catch (e) { skipped[t] = 'insert_fail: ' + String(e).slice(0, 60) }
    }
    done[t] = ins
  }
  for (const k of keepKeys) {
    try { await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)").bind(k.key, k.value).run() } catch (e) { /* 忽略 */ }
  }
  await logAudit(db, '整库恢复', mode, `灌入 ${Object.keys(done).length} 张表${keepKeys.length ? '，口令保持不变' : ''}`)
  return c.json({ ok: true, mode, done, skipped, rows: Object.values(done).reduce((a, x) => a + x, 0), at: pkg.at || '', book: pkg.book || '' })
})

// 年度流水报表
app.get('/report', async (c) => {
  const y = String(c.req.query('year') || todayIso().slice(0, 4))
  const db = c.env.DB
  const prefix = y + '-%'
  const lines = []
  lines.push(...(await titled(db, `${y} 年度流水报表`)))
  const pad = (s, n) => String(s).padEnd(n, ' ')
  const fmt = (n) => String(round2(n))
  // 按月汇总
  const { results: monthly } = await db.prepare(
    "SELECT substr(created_at,1,7) AS m, SUM(CASE WHEN direction='in' THEN amount ELSE 0 END) AS inc, SUM(CASE WHEN direction='out' THEN amount ELSE 0 END) AS out FROM ledger WHERE cash=1 AND ref_type<>'transfer' AND created_at LIKE ? GROUP BY m ORDER BY m"
  ).bind(prefix).all()
  lines.push('')
  lines.push('【按月汇总】')
  lines.push(pad('月份', 10) + pad('收入', 12) + pad('支出', 12) + '结余')
  let ti = 0, to = 0
  for (const r of monthly) {
    const inc = num(r.inc), out = num(r.out)
    ti += inc; to += out
    lines.push(pad(r.m, 10) + pad(fmt(inc), 12) + pad(fmt(out), 12) + fmt(inc - out))
  }
  if (!monthly.length) lines.push('（本年暂无流水）')
  lines.push(pad('合计', 10) + pad(fmt(ti), 12) + pad(fmt(to), 12) + fmt(ti - to))
  // 支出分类
  const { results: cats } = await db.prepare(
    "SELECT COALESCE(NULLIF(category,''),'其他') AS c, SUM(amount) AS t FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND created_at LIKE ? GROUP BY c ORDER BY t DESC"
  ).bind(prefix).all()
  lines.push('')
  lines.push('【支出分类】')
  for (const r of cats) lines.push(`${r.c}：${fmt(num(r.t))}`)
  if (!cats.length) lines.push('（无支出）')
  // 应收应付
  const ar = await db.prepare('SELECT COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) AS t FROM orders WHERE paid + COALESCE(written_off,0) < price').first()
  const ap = await db.prepare('SELECT COALESCE(SUM(amount-paid-COALESCE(written_off,0)),0) AS t FROM payables WHERE paid + COALESCE(written_off,0) < amount').first()
  const inAll = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='in' AND cash=1 AND ref_type<>'transfer'").first()
  const outAll = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer'").first()
  lines.push('')
  lines.push('【应收应付】')
  lines.push(`累计已收款：${fmt(num(inAll.t))}`)
  lines.push(`累计已付款：${fmt(num(outAll.t))}`)
  lines.push(`客户还欠我：${fmt(num(ar.t))}`)
  lines.push(`我还欠供应商：${fmt(num(ap.t))}`)
  return c.json({ text: lines.join('\n') })
})

// 导出 Excel（CSV，可直接用 Excel 打开）
const csvCell = (v) => { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v }
app.get('/export', async (c) => {
  const type = c.req.query('type') || 'orders'
  const db = c.env.DB
  const rows = []
  if (type === 'orders') {
    rows.push(['单号', '日期', '客户', '产品/项目', '金额', '已收', '未收', '状态', '进度', '到期日', '经手人'])
    const { results } = await db.prepare('SELECT * FROM orders ORDER BY id').all()
    const st = (s) => (s == 2 ? '已交付' : s == 1 ? '加工中' : '待加工')
    for (const o of results) rows.push([o.id, o.created_at.slice(0, 10), o.customer, o.item_name, o.price, o.paid, round2(o.price - o.paid), st(o.status), o.progress || '', (o.due_date || '').slice(0, 10), o.operator || ''])
  } else if (type === 'payables') {
    rows.push(['单号', '日期', '供应商', '金额', '已付', '未付', '分类', '备注', '约定付款日', '经手人'])
    const { results } = await db.prepare('SELECT * FROM payables ORDER BY id').all()
    for (const p of results) rows.push([p.id, p.created_at.slice(0, 10), p.supplier, p.amount, p.paid, round2(p.amount - p.paid), p.category, p.remark, (p.due_date || '').slice(0, 10), p.operator || ''])
  } else {
    rows.push(['日期', '方向', '金额', '分类', '备注', '账户', '经手人'])
    const { results } = await db.prepare('SELECT * FROM ledger WHERE cash=1 ORDER BY id').all()
    const accs = (await db.prepare('SELECT id,name FROM accounts').all()).results
    const accName = (id) => (accs.find((a) => a.id === id) || {}).name || ''
    for (const l of results) rows.push([l.created_at.slice(0, 10), l.direction === 'in' ? '收' : '付', l.amount, l.category, l.remark, accName(l.account_id), l.operator || ''])
  }
  const text = '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\n')
  return c.json({ text, filename: `factory-${type}-${todayIso()}.csv` })
})

// 报表图表数据（按月收入/支出）
app.get('/report-data', async (c) => {
  const y = String(c.req.query('year') || todayIso().slice(0, 4))
  const db = c.env.DB
  const { results } = await db.prepare(
    "SELECT substr(created_at,1,7) AS m, SUM(CASE WHEN direction='in' THEN amount ELSE 0 END) AS inc, SUM(CASE WHEN direction='out' THEN amount ELSE 0 END) AS out FROM ledger WHERE cash=1 AND ref_type<>'transfer' AND created_at LIKE ? GROUP BY m ORDER BY m"
  ).bind(y + '-%').all()
  const map = {}
  results.forEach((r) => { map[r.m] = r })
  const arr = []
  for (let i = 1; i <= 12; i++) {
    const m = y + '-' + String(i).padStart(2, '0')
    arr.push({ m, inc: round2(num((map[m] || {}).inc)), out: round2(num((map[m] || {}).out)) })
  }
  return c.json(arr)
})

// 客户/供应商信用看板：欠款榜 + 平均回款天数
app.get('/credits', async (c) => {
  const db = c.env.DB
  const today = todayIso()
  const { results: orders } = await db.prepare('SELECT * FROM orders').all()
  const { results: pays } = await db.prepare("SELECT * FROM ledger WHERE direction='in' AND ref_type='order'").all()
  const lastPay = {}
  for (const p of pays) {
    const k = String(p.ref_id)
    const d = (p.created_at || '').slice(0, 10)
    if (!lastPay[k] || d > lastPay[k]) lastPay[k] = d
  }
  const dayDiff = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000)
  const map = {}
  for (const o of orders) {
    const nm = o.customer || '(未填)'
    const g = map[nm] || (map[nm] = { name: nm, total: 0, unpaid: 0, cnt: 0, open_cnt: 0, oldest: 0, pay_days: [], last_order: '' })
    const unpaid = num(o.price) - num(o.paid)
    g.total += num(o.price)
    g.cnt++
    if (unpaid > 0) {
      g.unpaid += unpaid
      g.open_cnt++
      const d = (o.created_at || '').slice(0, 10)
      const days = d ? dayDiff(d, today) : 0
      if (days > g.oldest) g.oldest = days
    } else if (o.paid > 0) {
      const start = (o.created_at || '').slice(0, 10)
      const end = lastPay[String(o.id)]
      if (start && end) {
        const dd = dayDiff(start, end)
        if (dd >= 0) g.pay_days.push(dd)
      }
    }
    const od = (o.created_at || '').slice(0, 10)
    if (od > g.last_order) g.last_order = od
  }
  const list = Object.values(map).map((g) => ({
    name: g.name,
    total: round2(g.total),
    unpaid: round2(g.unpaid),
    cnt: g.cnt,
    open_cnt: g.open_cnt,
    oldest: g.oldest,
    avg_days: g.pay_days.length ? Math.round(g.pay_days.reduce((a, b) => a + b, 0) / g.pay_days.length) : null,
    last_order: g.last_order
  })).sort((a, b) => b.unpaid - a.unpaid || b.total - a.total)
  // 附加信用额度
  const lims = (await db.prepare('SELECT * FROM credit_limits').all()).results
  const lm = {}
  for (const l of lims) lm[l.party] = num(l.limit_amount)
  const out = list.map((x) => {
    const lim = lm[x.name] || 0
    return Object.assign({}, x, { limit_amount: lim, over: lim > 0 && x.unpaid > lim, over_amount: lim > 0 ? round2(x.unpaid - lim) : 0 })
  })
  return c.json(out)
})

// 同比环比（本月 vs 上月 / 去年同月）
app.get('/compare', async (c) => {
  const db = c.env.DB
  const base = String(c.req.query('month') || month())
  const mRe = /^(\d{4})-(\d{2})$/
  let y = Number(base.slice(0, 4))
  let mo = Number(base.slice(5, 7))
  if (!mRe.test(base) || !mo || mo > 12) return c.json({ error: '月份格式：YYYY-MM' }, 400)
  const prevY = mo === 1 ? y - 1 : y
  const prevM = mo === 1 ? 12 : mo - 1
  const prev = `${prevY}-${String(prevM).padStart(2, '0')}`
  const lastYear = `${y - 1}-${String(mo).padStart(2, '0')}`
  // 性能：原来 3 个月 × 4 次查询串行（2.9 秒），改成 3 次分组查询（约 1 秒）
  const jobs = [
    db.prepare("SELECT substr(created_at,1,7) mk, COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE 0 END),0) i, COALESCE(SUM(CASE WHEN direction='out' THEN amount ELSE 0 END),0) o FROM ledger WHERE cash=1 AND ref_type<>'transfer' AND substr(created_at,1,7) IN (?,?,?) GROUP BY mk").bind(base, prev, lastYear).all(),
    db.prepare('SELECT month mk, COALESCE(SUM(price),0) t FROM orders WHERE month IN (?,?,?) GROUP BY mk').bind(base, prev, lastYear).all(),
    db.prepare('SELECT month mk, COALESCE(SUM(amount),0) t FROM payables WHERE month IN (?,?,?) GROUP BY mk').bind(base, prev, lastYear).all()
  ].map((x) => x.catch((e) => { noteFail(e); return null }))
  const [lR, oR, pR] = await Promise.all(jobs)
  const rowsOf = (r) => (r && r.results) || []
  const li = {}, lo = {}, oa = {}, pa = {}
  for (const x of rowsOf(lR)) { li[x.mk] = num(x.i); lo[x.mk] = num(x.o) }
  for (const x of rowsOf(oR)) oa[x.mk] = num(x.t)
  for (const x of rowsOf(pR)) pa[x.mk] = num(x.t)
  const stat = (m) => ({
    month: m,
    income: round2(num(li[m])),
    outcome: round2(num(lo[m])),
    net: round2(num(li[m]) - num(lo[m])),
    order_add: round2(num(oa[m])),
    payable_add: round2(num(pa[m]))
  })
  return c.json({ cur: stat(base), prev: stat(prev), last_year: stat(lastYear) })
})

// 数据自检：账实是否对得上
async function selfCheck(db) {
  const issues = []
  // 性能：7 条查询改成一次并发
  const jobs = [
    db.prepare('SELECT * FROM orders').all(),
    db.prepare("SELECT ref_id, COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='in' AND ref_type='order' GROUP BY ref_id").all(),
    db.prepare('SELECT * FROM payables').all(),
    db.prepare("SELECT ref_id, COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND ref_type='payable' GROUP BY ref_id").all(),
    db.prepare('SELECT COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) AS t FROM orders WHERE paid + COALESCE(written_off,0) < price').first(),
    db.prepare('SELECT COALESCE(SUM(price),0) AS a, COALESCE(SUM(paid),0) AS p FROM orders').first(),
    db.prepare("SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE 0 END),0) AS i, COALESCE(SUM(CASE WHEN direction='out' THEN amount ELSE 0 END),0) AS o FROM ledger WHERE cash=1 AND ref_type<>'transfer'").first(),
    db.prepare('SELECT COALESCE(SUM(amount-paid-COALESCE(written_off,0)),0) AS t FROM payables WHERE paid + COALESCE(written_off,0) < amount').first()
  ].map((x) => x.catch((e) => { noteFail(e); return null }))
  const [oR, inR, pR, outR, arRow, arFlow, flR, apRow] = await Promise.all(jobs)
  const orders = (oR && oR.results) || []
  const inSum = (inR && inR.results) || []
  const payables = (pR && pR.results) || []
  const outSum = (outR && outR.results) || []
  const flowIn = { t: num(flR && flR.i) }
  const flowOut = { t: num(flR && flR.o) }
  const mi = {}, mo = {}
  for (const r of inSum) mi[String(r.ref_id)] = num(r.t)
  for (const r of outSum) mo[String(r.ref_id)] = num(r.t)
  let overpaid = 0, mismatch = 0
  for (const o of orders) {
    const s = round2(mi[String(o.id)] || 0)
    const p = round2(num(o.paid))
    if (s !== p) {
      mismatch++
      if (issues.length < 12) issues.push(`应收 #${o.id} ${o.customer}：单据已收 ${p}，流水合计 ${s}`)
    }
    if (p > num(o.price)) {
      overpaid++
      if (issues.length < 12) issues.push(`应收 #${o.id} ${o.customer}：已收 ${p} 超过单据金额 ${num(o.price)}`)
    }
  }
  let apMismatch = 0
  for (const p of payables) {
    const s = round2(mo[String(p.id)] || 0)
    const q = round2(num(p.paid))
    if (s !== q) {
      apMismatch++
      if (issues.length < 12) issues.push(`应付 #${p.id} ${p.supplier}：单据已付 ${q}，流水合计 ${s}`)
    }
  }
  return {
    ok: mismatch === 0 && apMismatch === 0 && overpaid === 0,
    orders: orders.length,
    payables: payables.length,
    ar_total: round2(num(arRow.t)),
    ar_check: round2(num(arFlow.a) - num(arFlow.p)),
    ap_total: round2(num(apRow.t)),
    flow_in: round2(num(flowIn.t)),
    flow_out: round2(num(flowOut.t)),
    mismatch,
    ap_mismatch: apMismatch,
    overpaid,
    issues,
    bad: mismatch + apMismatch + overpaid
  }
}
// 数据体检：把「账记得对不对」变成一张清单，一项项告诉你哪里要补
// 账本体检（首页分数条、设置页体检、体检报告单共用同一套算法）
async function healthScan(db) {
  const q1 = (sql) => db.prepare(sql).first().catch((e) => { noteFail(e, '数据体检'); return {} })
  const qAll = (sql) => db.prepare(sql).all().then((r) => r.results || []).catch((e) => { noteFail(e, '数据体检'); return [] })
  const items = []
  const add = (k, label, count, tip, go, list) => { items.push({ k, label, count: num(count), tip, go: go || '', list: list || [] }) }
  const since7 = new Date(Date.now() + TZ_MS - 7 * 86400000).toISOString()

  const [costMiss, payNoDue, arNoTerm, apNoTerm, noPhone, ledgerNoAcc, dupCnt, lastLock, errCnt, bkLast, wxCnt] = await Promise.all([
    qAll("SELECT id, customer, item_name, price FROM orders WHERE COALESCE(cost,0)=0 AND price>0 ORDER BY id DESC LIMIT 5"),
    q1("SELECT COUNT(*) AS c FROM payables WHERE paid<amount AND (due_date IS NULL OR due_date='')"),
    qAll("SELECT DISTINCT customer AS party FROM orders WHERE paid<price AND COALESCE(written_off,0)<price-paid LIMIT 300"),
    qAll("SELECT DISTINCT supplier AS party FROM payables WHERE paid<amount LIMIT 300"),
    qAll("SELECT DISTINCT customer AS party FROM orders LIMIT 300"),
    q1("SELECT COUNT(*) AS c FROM ledger WHERE COALESCE(account_id,0)=0"),
    qAll("SELECT customer, price, substr(created_at,1,10) AS d, COUNT(*) AS c FROM orders GROUP BY customer, price, substr(created_at,1,10) HAVING c>1 LIMIT 5"),
    qAll("SELECT month FROM month_lock ORDER BY month DESC LIMIT 1"),
    db.prepare("SELECT COUNT(*) AS c FROM error_log WHERE created_at >= ?").bind(since7).first().catch((e) => { noteFail(e, '数据体检'); return {} }),
    qAll("SELECT created_at FROM backups ORDER BY id DESC LIMIT 1"),
    q1("SELECT COUNT(*) AS c FROM wx_users"),
  ])
  const terms = new Set((await qAll('SELECT party FROM party_terms')).map((x) => x.party))
  const phones = new Map((await qAll('SELECT party, phone FROM party_profiles')).map((x) => [x.party, x.phone || '']))
  const arParties = (arNoTerm || []).map((x) => x.party)
  const apParties = (apNoTerm || []).map((x) => x.party)
  const allParties = Array.from(new Set([...arParties, ...apParties, ...(noPhone || []).map((x) => x.party)]))

  add('cost', '单子没填材料/外协成本', costMiss.length, '不填成本就算不出真实毛利（现在按 0 算，毛利会偏高）', '记账 → 应收 → 编辑单据 → 填「成本」', costMiss)
  add('due', '应付没约定付款日', payNoDue.c, '没约定日期就不会提醒你哪天该付，容易忘了付、被催', '记账 → 应付 → 编辑 → 填「约定付款日」')
  const noTerm = allParties.filter((p) => !terms.has(p) && (arParties.includes(p) || apParties.includes(p)))
  add('term', '往来单位没设账期', noTerm.length, '设了账期，新单会自动带出到期日，到期提醒才准', '设置 → 单位 → 账期', noTerm.slice(0, 5).map((p) => ({ party: p })))
  const noPh = allParties.filter((p) => !phones.get(p))
  add('phone', '往来单位没电话', noPh.length, '没电话就没法一键拨号催款，也对不上是谁', '设置 → 单位 → 档案 → 填电话', noPh.slice(0, 5).map((p) => ({ party: p })))
  add('acc', '流水没挂资金账户', ledgerNoAcc.c, '没挂账户的流水会默认算进第一个账户，账户余额会不准', '记账 → 流水 → 删除重记并选账户')
  const dups = (dupCnt || []).filter((x) => num(x.c) > 1)
  add('dup', '同一天同金额的疑似重复单', dups.length, '同客户、同金额、同一天出现多张，可能重复录了', '记账 → 应收 → 核对一下', dups.map((x) => ({ party: x.customer, amount: num(x.price), date: x.d })))
  const lastM = new Date(Date.now() + TZ_MS - 86400000 * 35).toISOString().slice(0, 7)
  const prevM = (() => { const d = new Date(Date.now() + TZ_MS); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7) })()
  const lockedM = (lastLock[0] || {}).month || ''
  add('lock', '上个月还没结账', lockedM >= prevM && lockedM ? 0 : 1, '月底结一次账，把报表定格存档，以后改单也不影响已出的报表', '报表 → 月结归档', [])
  add('err', '近 7 天有接口报错', errCnt.c, '偶尔一次是网络抖动；连着多次说明某个功能坏了，把路径发我', '报表 → 数据体检 → 看运行日志')
  const bkDays = (bkLast[0] && bkLast[0].created_at) ? daysSince(new Date(Date.parse(bkLast[0].created_at) - TZ_MS).toISOString()) : 999
  add('backup', '最近没自动备份', bkDays > 7 ? 1 : 0, bkDays === 999 ? '还没有备份记录，先手动备份一次' : `上次备份在 ${bkDays} 天前`, '报表 → 云端备份')
  add('wx', '微信提醒没开', num(wxCnt.c) > 0 ? 0 : 1, '开了之后每天 9 点自动推「今天该收/该付」，不用自己记', '设置 → 微信提醒')
  void lastM

  // 空账本：还没记过任何单子和流水时，「没备份」「上月没结账」「微信没开」都不算问题，
  // 否则新用户一进来就看到 77 分和一堆要处理的事，反而不想看。
  const totRow = await db.prepare('SELECT (SELECT COUNT(*) FROM orders)+(SELECT COUNT(*) FROM payables)+(SELECT COUNT(*) FROM ledger) AS tot').first().catch(() => ({ tot: 0 }))
  const emptyBook = num(totRow && totRow.tot) === 0
  let items2 = items
  if (emptyBook) items2 = items.filter((x) => !['lock', 'backup', 'wx', 'err'].includes(x.k))

  const GO = { cost: 'ar', due: 'ap', term: 'contact', phone: 'contact', acc: 'flows', dup: 'ar', lock: 'report', err: 'report', backup: 'report', wx: 'contact' }
  for (const it of items2) it.tab = GO[it.k] || 'home'
  const warn = items2.filter((x) => x.count > 0)
  const wOf = (x) => (x.k === 'err' ? 10 : x.k === 'backup' ? 10 : x.k === 'lock' ? 5 : 8)
  const score = Math.max(0, 100 - warn.reduce((a, x) => a + wOf(x), 0))
  const grade = score >= 90 ? '好' : score >= 75 ? '还行' : '要处理一下'
  const top = warn.slice().sort((a, b) => wOf(b) - wOf(a))[0] || null
  // 健康分历史（每天只记一条，留着看趋势）
  const today = now().slice(0, 10)
  let hist = []
  try { hist = JSON.parse((await db.prepare("SELECT value AS v FROM settings WHERE key='health_hist'").first() || {}).v || '[]') } catch (e) { hist = [] }
  if (!Array.isArray(hist)) hist = []
  const last = hist[hist.length - 1]
  let needWrite = false
  if (!last || last.d !== today) { hist.push({ d: today, s: score }); needWrite = true }
  else if (num(last.s) !== score) { last.s = score; needWrite = true }
  hist = hist.slice(-180)
  if (needWrite) {
    try {
      await db.prepare("INSERT INTO settings (key, value) VALUES ('health_hist', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(hist)).run()
    } catch (e) { /* 记不上不影响结果 */ }
  }
  const prevRec = hist.filter((x) => x.d !== today).slice(-1)[0]
  const delta = prevRec ? round2(score - num(prevRec.s)) : 0
  const fails = failBucket.slice()
  if (fails.length) items2.unshift({ k: 'fail', label: '有统计查询失败了', count: fails.length, tip: '某项统计没算出来（会显示成 0）。把下面这条发给开发：', go: '报表 → 🐞 运行日志', tab: 'report', list: fails.slice(0, 3).map((x) => ({ party: '', amount: 0, note: x })), party: String(fails[0] || '').slice(0, 60) })
  // 每项问题的「哪天发现 / 哪天修好」：顺带记进 settings.health_items，体检报告单要用
  let ih = {}
  try { ih = JSON.parse((await db.prepare("SELECT value AS v FROM settings WHERE key='health_items'").first() || {}).v || '{}') } catch (e) { ih = {} }
  if (!ih || typeof ih !== 'object' || Array.isArray(ih)) ih = {}
  let ihDirty = false
  for (const it of items2) {
    if (it.k === 'fail') continue
    const p = ih[it.k] || {}
    if (it.count > 0) {
      if (!p.since) { p.since = today; ihDirty = true }
      if (p.fixed) { p.fixed = ''; ihDirty = true }
      it.since = p.since
      it.days_open = Math.max(0, daysSince(p.since))
      it.fixed = ''
    } else {
      if (p.since && !p.fixed) { p.fixed = today; ihDirty = true }
      it.since = p.since || ''
      it.fixed = p.fixed || ''
      it.days_open = 0
    }
    ih[it.k] = p
  }
  if (ihDirty) {
    try { await db.prepare("INSERT INTO settings (key, value) VALUES ('health_items', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(ih)).run() } catch (e) { /* 记不上不影响结果 */ }
  }
  return { ok: true, score, grade, clean: warn.length === 0, count: warn.length, items: items2, top, hist, delta, empty: emptyBook, degraded: fails, at: now() }
}

app.get('/health-check', async (c) => c.json(await healthScan(c.env.DB)))

// 体检报告单：分数曲线 + 每项问题的发现/修好日期 + 一句结论（可打印）
const HB_BLK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
async function healthReport(db, days, savedKey) {
  const s = await healthScan(db)
  const pts = (s.hist || []).filter((x) => x && x.d).slice(-days).map((x) => ({ d: x.d, s: num(x.s) }))
  const first = pts[0] || null
  const lastP = pts[pts.length - 1] || null
  const delta = first && lastP ? round2(lastP.s - first.s) : 0
  const best = pts.reduce((a, b) => (!a || b.s > a.s ? b : a), null)
  const worst = pts.reduce((a, b) => (!a || b.s < a.s ? b : a), null)
  const spark = pts.map((p) => HB_BLK[Math.max(0, Math.min(7, Math.floor((p.s / 100) * 7.999)))]).join('')
  const items = (s.items || []).filter((x) => x.k !== 'fail')
  const open = items.filter((x) => x.count > 0).sort((a, b) => num(b.days_open) - num(a.days_open))
  const fixed = items.filter((x) => x.fixed).sort((a, b) => (a.fixed < b.fixed ? 1 : -1))
  const daysTxt = (n) => (num(n) <= 0 ? '今天刚出现' : `已经 ${num(n)} 天了`)
  const sentences = []
  if (s.empty) sentences.push('这本账还没记过东西，先记两笔单子再来体检。')
  else if (pts.length < 2) sentences.push(`今天第一次体检：${s.score} 分（${s.grade}）。以后每次打开首页都会记一条，这里就能看出账本是在变好还是变差。`)
  else if (delta > 0) sentences.push(`从 ${first.d} 的 ${first.s} 分到今天的 ${s.score} 分，升了 ${delta} 分。`)
  else if (delta < 0) sentences.push(`从 ${first.d} 的 ${first.s} 分到今天的 ${s.score} 分，掉了 ${Math.abs(delta)} 分。`)
  else sentences.push(`这段时间一直是 ${s.score} 分，没变。`)
  if (fixed.length && !s.empty) sentences.push(`修好了 ${fixed.length} 处：${fixed.slice(0, 3).map((x) => x.label).join('、')}${fixed.length > 3 ? ' 等' : ''}。`)
  if (open.length && !s.empty) {
    const worst1 = open[0]
    sentences.push(`还剩 ${open.length} 处没改，最老的是「${worst1.label}」，${daysTxt(worst1.days_open)}${worst1.tip ? '（' + worst1.tip + '）' : ''}。`)
  }
  if (!s.empty && !open.length) sentences.push('该改的都改完了，账本现在是干净的。')
  const url = savedKey ? '/health-print?days=' + days + '&t=' + (await sigOf(savedKey, 'health', 'hr:' + days)) : ''
  return {
    ok: true, at: now(), days, score: s.score, grade: s.grade, empty: s.empty, clean: s.clean, count: s.count,
    delta, first, last: lastP, best, worst, points: pts, spark,
    open: open.map((x) => ({ k: x.k, label: x.label, count: x.count, tip: x.tip, go: x.go, tab: x.tab, since: x.since, days_open: x.days_open })),
    fixed: fixed.map((x) => ({ k: x.k, label: x.label, since: x.since, fixed: x.fixed })),
    items: items.map((x) => ({ k: x.k, label: x.label, count: x.count, tip: x.tip, go: x.go, tab: x.tab, since: x.since || '', fixed: x.fixed || '', days_open: num(x.days_open) })),
    url, sentences, text: sentences.join('')
  }
}

app.get('/health-report', async (c) => {
  const days = Math.min(365, Math.max(7, num(c.req.query('days'), 180)))
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  return c.json(await healthReport(c.env.DB, days, saved))
})

app.get('/health-print', async (c) => {
  const db = c.env.DB
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  const days = Math.min(365, Math.max(7, num(c.req.query('days'), 180)))
  const want = String(c.req.query('t') || '')
  const good = saved ? await sigOf(saved, 'health', 'hr:' + days) : ''
  if (!good || want !== good) return c.html('<h3>链接已失效：请在小程序里重新生成体检报告单。</h3>')
  const r = await healthReport(db, days, saved)
  const t = await getTitle(db)
  const tr = (x) => `<tr><td>${escHtml(x.label)}</td><td class="n">${x.count > 0 ? '还有 ' + x.count + ' 处' : '正常'}</td><td>${escHtml(x.since || '')}</td><td>${x.count > 0 ? daysTxtPrint(x.days_open) : (x.fixed ? '已修好' : '')}</td><td>${escHtml(x.fixed || '')}</td><td>${escHtml(x.count > 0 ? (x.tip || '') : '')}</td></tr>`
  const rows = r.items.map(tr).join('')
  const pts = r.points.map((p) => `${escHtml(p.d)} ${p.s}`).join('　')
  const body = `<h1>账本体检报告单</h1><div class="sub">${escHtml(t.title || '')}${t.phone ? ' · ' + escHtml(t.phone) : ''}　打印日期 ${now().slice(0, 10)}　统计范围 近 ${r.days} 天</div>
<div class="score"><span class="big">${r.score}</span> 分 · ${escHtml(r.grade)}${r.delta ? `（${r.delta > 0 ? '+' : ''}${r.delta}）` : ''}</div>
<h2>分数变化</h2><div class="spark">${escHtml(r.spark || '（还没有历史记录）')}</div><div class="tip">${escHtml(pts || '')}</div>
<h2>结论</h2><ul>${r.sentences.map((x) => `<li>${escHtml(x)}</li>`).join('')}</ul>
<h2>逐项体检</h2><table><tr><th>检查项</th><th>现在</th><th>哪天发现的</th><th>持续多久</th><th>哪天修好的</th><th>怎么改</th></tr>${rows}</table>
<div class="tip">分数算法：满分 100，按问题扣分——接口报错、没备份各扣 10，上月没结账扣 5，其余每项扣 8。分数只是提醒，不影响账上的数字。</div>`
  return c.html(a4Page({ title: '账本体检报告单', body, extraCss: '.score{font-size:15px;margin:6px 0 12px}.score .big{font-size:30px;font-weight:700;color:#1f6feb}.spark{font-size:22px;letter-spacing:2px;color:#1f6feb;margin:4px 0}.tip{font-size:12px;color:#777;margin:6px 0}' }))
})
function daysTxtPrint(n) { return num(n) <= 0 ? '今天刚出现' : `${num(n)} 天` }

// 运行日志（出错留痕查询）
app.get('/error-log', async (c) => {
  const db = c.env.DB
  const days = Math.min(60, Math.max(1, num(c.req.query('days'), 7)))
  const since = new Date(Date.now() + TZ_MS - days * 86400000).toISOString()
  const rows = (await db.prepare('SELECT * FROM error_log WHERE created_at >= ? ORDER BY id DESC LIMIT 100').bind(since).all()).results
  const byPath = {}
  for (const r of rows) { const k = (r.method || 'GET') + ' ' + (r.path || ''); byPath[k] = (byPath[k] || 0) + 1 }
  return c.json({
    ok: true,
    days,
    count: rows.length,
    grouped: Object.entries(byPath).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => ({ path: k, count: n })),
    rows: rows.slice(0, 30).map((r) => ({ id: r.id, when: r.created_at, path: (r.method || '') + ' ' + (r.path || ''), status: r.status, ms: r.ms, msg: (r.msg || '').slice(0, 160) }))
  })
})
app.delete('/error-log', async (c) => {
  await c.env.DB.prepare('DELETE FROM error_log').run()
  return c.json({ ok: true })
})

app.get('/selfcheck', async (c) => c.json(await selfCheck(c.env.DB)))

// 编辑应收单
// ── 员工改单申请：员工不能直接删改，改成「提申请 → 老板一键同意/驳回」 ──
const ER_FIELDS = {
  ar: { table: 'orders', party: 'customer', fields: ['customer', 'item_name', 'price', 'cost', 'due_date', 'operator'] },
  ap: { table: 'payables', party: 'supplier', fields: ['supplier', 'amount', 'remark', 'due_date', 'operator'] },
  expense: { table: 'ledger', party: 'category', fields: ['amount', 'category', 'remark'] }
}
const ER_LABEL = { customer: '客户', item_name: '产品', price: '金额', amount: '金额', cost: '成本', due_date: '到期日', operator: '经手人', supplier: '供应商', remark: '备注', category: '分类' }
async function erLoadRow(db, kind, id) {
  const spec = ER_FIELDS[kind]
  if (!spec) return null
  if (kind === 'expense') {
    const r = await db.prepare("SELECT * FROM ledger WHERE id=? AND ref_type IN ('expense','fixed')").bind(id).first()
    return r || null
  }
  return (await db.prepare('SELECT * FROM ' + spec.table + ' WHERE id=?').bind(id).first()) || null
}
const erSlim = (v) => (v === null || v === undefined ? '' : String(v))
app.post('/edit-request', async (c) => {
  const db = c.env.DB
  const b = await c.req.json()
  const kind = ['ar', 'ap', 'expense'].includes(b.kind) ? b.kind : ''
  const id = num(b.id)
  if (!kind || !id) return c.json({ ok: false, error: '没说要改哪一张' }, 400)
  const row = await erLoadRow(db, kind, id)
  if (!row) return c.json({ ok: false, error: '这张单找不到了（可能已被删）' }, 404)
  const spec = ER_FIELDS[kind]
  const changes = {}
  const incoming = b.changes || {}
  for (const f of spec.fields) {
    if (incoming[f] === undefined) continue
    let v = incoming[f]
    if (f === 'price' || f === 'amount' || f === 'cost') v = round2(num(v))
    if (f === 'due_date') v = toIsoDate(v) || null
    if (typeof v === 'string') v = v.trim()
    if (erSlim(v) === erSlim(row[f])) continue
    changes[f] = v
  }
  if (!Object.keys(changes).length) return c.json({ ok: false, error: '没改任何内容' }, 400)
  const reason = String(b.reason || '').trim().slice(0, 200)
  const by = (c.get('role') === 'staff') ? '员工' : '老板'
  const dup = await db.prepare("SELECT id FROM edit_requests WHERE kind=? AND ref_id=? AND status='pending' ORDER BY id DESC LIMIT 1").bind(kind, id).first().catch(() => null)
  if (dup) return c.json({ ok: false, error: '这张单已经有一条申请在等了，等老板处理完再提', code: 'has_pending' }, 409)
  await db.prepare('INSERT INTO edit_requests (kind,ref_id,changes,reason,by,status,created_at) VALUES (?,?,?,?,?,\'pending\',?)')
    .bind(kind, id, JSON.stringify(changes), reason, by, now()).run()
  await logAudit(db, '提修改申请', (kind === 'ar' ? row.customer : kind === 'ap' ? row.supplier : row.category) || '', `${Object.keys(changes).map((f) => (ER_LABEL[f] || f) + ' → ' + erSlim(changes[f])).join('；')}${reason ? '（' + reason + '）' : ''}`, `${kind}:${id}`, by)
  return c.json({ ok: true })
})
app.get('/edit-requests', async (c) => {
  const db = c.env.DB
  const u = new URL(c.req.url)
  const st = ['pending', 'ok', 'no', 'all'].includes(u.searchParams.get('status')) ? u.searchParams.get('status') : 'pending'
  const role = c.get('role') || 'owner'
  const cond = st === 'all' ? '1=1' : 'status=?'
  const binds = st === 'all' ? [] : [st]
  if (role === 'staff') {
    // 员工能看到自己提的申请处理到哪一步了（看不到别人提的、也看不到审批按钮）
    const mine = (await db.prepare("SELECT * FROM edit_requests WHERE by='员工' ORDER BY id DESC LIMIT 20").all()).results || []
    const mrows = []
    for (const r of mine) {
      let ch = {}
      try { ch = JSON.parse(r.changes || '{}') } catch (e) { ch = {} }
      mrows.push({
        id: r.id, kind: r.kind, ref_id: r.ref_id, by: r.by || '', status: r.status, note: r.note || '',
        title: ER_LABEL[r.kind] + ' #' + r.ref_id,
        date: (r.created_at || '').slice(0, 16).replace('T', ' '), done_at: (r.done_at || '').slice(0, 16).replace('T', ' '),
        diffs: Object.keys(ch).map((f) => ({ f, label: ER_LABEL[f] || f, from: '', to: erSlim(ch[f]) })),
        gone: false, mine: true
      })
    }
    return c.json({ ok: true, count: mrows.length, rows: mrows, staff: true })
  }
  const rs = (await db.prepare('SELECT * FROM edit_requests WHERE ' + cond + ' ORDER BY id DESC LIMIT 60').bind(...binds).all()).results || []
  const rows = []
  for (const r of rs) {
    let ch = {}
    try { ch = JSON.parse(r.changes || '{}') } catch (e) { ch = {} }
    const row = await erLoadRow(db, r.kind, r.ref_id)
    const diffs = Object.keys(ch).map((f) => ({ f, label: ER_LABEL[f] || f, from: erSlim(row ? row[f] : '（已删）'), to: erSlim(ch[f]) }))
    const title = !row ? '（单据已删除）' : (r.kind === 'ar' ? (row.customer || '') + ' · ' + (row.item_name || '加工') : r.kind === 'ap' ? (row.supplier || '') + ' · 应付' : '支出 · ' + (row.category || ''))
    rows.push({ id: r.id, kind: r.kind, ref_id: r.ref_id, title, reason: r.reason || '', by: r.by || '', status: r.status, note: r.note || '',
      date: (r.created_at || '').slice(0, 16).replace('T', ' '), done_at: (r.done_at || '').slice(0, 16).replace('T', ' '), diffs, gone: !row })
  }
  return c.json({ ok: true, count: rows.length, rows })
})
app.post('/edit-requests/:id/approve', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const er = await db.prepare('SELECT * FROM edit_requests WHERE id=?').bind(id).first()
  if (!er) return c.json({ ok: false, error: '这条申请不在了' }, 404)
  if (er.status !== 'pending') return c.json({ ok: false, error: '这条已经处理过了' }, 409)
  const row = await erLoadRow(db, er.kind, er.ref_id)
  if (!row) return c.json({ ok: false, error: '这张单已经删了，没法改' }, 409)
  let ch = {}
  try { ch = JSON.parse(er.changes || '{}') } catch (e) { ch = {} }
  const spec = ER_FIELDS[er.kind]
  const month = String(row.created_at || '').slice(0, 7)
  if (await isMonthLocked(db, month)) return c.json({ ok: false, error: `${month} 已结账锁定，先解锁再改` }, 403)
  if (er.kind === 'ar' || er.kind === 'ap') {
    const amtF = er.kind === 'ar' ? 'price' : 'amount'
    if (ch[amtF] !== undefined) {
      const floor = round2(num(row.paid) + num(row.written_off))
      if (round2(num(ch[amtF])) < floor) {
        return c.json({ ok: false, error: `这张单已经收了 ${round2(num(row.paid))} 元、核销 ${round2(num(row.written_off))} 元，金额不能改成比 ${floor} 少` }, 400)
      }
    }
  }
  const sets = []
  const binds = []
  for (const f of Object.keys(ch)) {
    if (spec.fields.indexOf(f) < 0) continue
    sets.push(f + '=?')
    binds.push(ch[f])
  }
  if (!sets.length) return c.json({ ok: false, error: '这条申请里的字段都不认识了（可能是旧版本）' }, 400)
  if (er.kind !== 'expense') sets.push('rev=COALESCE(rev,0)+1')
  await db.prepare('UPDATE ' + spec.table + ' SET ' + sets.join(', ') + ' WHERE id=?').bind(...binds, er.ref_id).run()
  const d = diffText(Object.keys(ch).filter((f) => spec.fields.indexOf(f) >= 0).map((f) => [ER_LABEL[f] || f, erSlim(row[f]), erSlim(ch[f])]))
  await db.prepare("UPDATE edit_requests SET status='ok', done_at=?, done_by='老板', note=? WHERE id=?").bind(now(), String(er.reason || ''), id).run()
  await logAudit(db, '同意修改申请', er.kind + ':' + er.ref_id, (d || '（没改动）') + (er.by ? `（${er.by}提的）` : ''), `${er.kind}:${er.ref_id}`, '老板')
  return c.json({ ok: true, changed: d })
})
app.post('/edit-requests/:id/reject', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const b = await c.req.json().catch(() => ({}))
  const er = await db.prepare('SELECT * FROM edit_requests WHERE id=?').bind(id).first()
  if (!er) return c.json({ ok: false, error: '这条申请不在了' }, 404)
  if (er.status !== 'pending') return c.json({ ok: false, error: '这条已经处理过了' }, 409)
  const note = String(b.note || '').trim().slice(0, 120)
  await db.prepare("UPDATE edit_requests SET status='no', done_at=?, done_by='老板', note=? WHERE id=?").bind(now(), note, id).run()
  await logAudit(db, '驳回修改申请', er.kind + ':' + er.ref_id, note || '（没写原因）', `${er.kind}:${er.ref_id}`, '老板')
  return c.json({ ok: true })
})
app.post('/edit-requests/:id/cancel', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const er = await db.prepare('SELECT * FROM edit_requests WHERE id=?').bind(id).first()
  if (!er) return c.json({ ok: false, error: '这条申请不在了' }, 404)
  if (c.get('role') === 'staff' && er.by !== '员工') return c.json({ ok: false, error: '这条不是你提的' }, 403)
  await db.prepare("UPDATE edit_requests SET status='no', done_at=?, done_by=?, note=? WHERE id=?").bind(now(), c.get('role') === 'staff' ? '员工撤回' : '老板撤回', '撤回', id).run()
  return c.json({ ok: true })
})

app.patch('/orders/:id', async (c) => {
  const id = c.req.param('id')
  const { customer, item_name, price, due_date, operator, rev, cost, deliver_date } = await c.req.json()
  const db = c.env.DB
  const o = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first()
  if (!o) return c.json({ error: '订单不存在' }, 404)
  if (rev !== undefined && rev !== null && rev !== '' && num(rev) !== num(o.rev)) {
    return c.json({ error: '这张单刚被别人改过（或被收过款），请下拉刷新后再改', code: 'conflict' }, 409)
  }
  if (await isMonthLocked(db, (o.created_at || '').slice(0, 7))) return c.json({ error: '该订单所在月份已结账锁定' }, 403)
  const p = round2(num(price, o.price))
  const floor = round2(num(o.paid) + num(o.written_off))
  if (p < floor) {
    return c.json({ error: `这张单已经收了 ${round2(num(o.paid))} 元${num(o.written_off) ? `、核销 ${round2(num(o.written_off))} 元` : ''}，金额不能改成比 ${floor} 少` }, 400)
  }
  const nd = due_date !== undefined ? (toIsoDate(due_date) || null) : (o.due_date || null)
  const op = operator !== undefined ? (String(operator).trim() || null) : (o.operator || null)
  const nc = cost !== undefined ? round2(num(cost)) : round2(num(o.cost))
  const ncust = customer || o.customer
  const nitem = item_name || o.item_name
  const ndd = deliver_date !== undefined ? (toIsoDate(deliver_date) || null) : (o.deliver_date || null)
  await db.prepare('UPDATE orders SET customer=?, item_name=?, price=?, due_date=?, operator=?, cost=?, deliver_date=?, rev=COALESCE(rev,0)+1 WHERE id=?')
    .bind(ncust, nitem, p, nd, op, nc, ndd, id).run()
  const d = diffText([
    ['客户', o.customer, ncust], ['产品', o.item_name, nitem],
    ['金额', round2(num(o.price)), p], ['成本', round2(num(o.cost)), nc],
    ['经手人', o.operator, op], ['到期日', (o.due_date || '').slice(0, 10), (nd || '').slice(0, 10)],
    ['交货日', (o.deliver_date || '').slice(0, 10), (ndd || '').slice(0, 10)]
  ])
  await logAudit(db, '编辑应收', ncust, d || '（没改动）', `order:${id}`)
  return c.json({ ok: true, changed: d })
})

// 更新订单工序进度（生产环节基础版）
app.patch('/orders/:id/progress', async (c) => {
  const id = c.req.param('id')
  const { progress, operator } = await c.req.json()
  const p = String(progress || '').trim()
  const db = c.env.DB
  const o = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first()
  if (!o) return c.json({ error: '订单不存在' }, 404)
  if (await isMonthLocked(db, (o.created_at || '').slice(0, 7))) return c.json({ error: '该订单所在月份已结账锁定' }, 403)
  await db.prepare('UPDATE orders SET progress=? WHERE id=?').bind(p, id).run()
  if (p) await db.prepare('INSERT INTO process_log (order_id, progress, operator, created_at) VALUES (?,?,?,?)')
    .bind(id, p, operator || '', now()).run()
  await logAudit(db, '更新工序', o.customer, `${o.customer} → ${p}`)
  return c.json({ ok: true })
})

// 订单工序历史
app.get('/orders/:id/processes', async (c) => {
  const id = c.req.param('id')
  const { results } = await c.env.DB.prepare('SELECT * FROM process_log WHERE order_id=? ORDER BY id DESC LIMIT 50').bind(id).all()
  return c.json(results)
})

// 编辑应付单
app.patch('/payables/:id', async (c) => {
  const id = c.req.param('id')
  const { supplier, amount, remark, due_date, operator, rev } = await c.req.json()
  const db = c.env.DB
  const p = await db.prepare('SELECT * FROM payables WHERE id=?').bind(id).first()
  if (!p) return c.json({ error: '应付单不存在' }, 404)
  if (rev !== undefined && rev !== null && rev !== '' && num(rev) !== num(p.rev)) {
    return c.json({ error: '这笔刚被别人改过（或被付过款），请下拉刷新后再改', code: 'conflict' }, 409)
  }
  if (await isMonthLocked(db, (p.created_at || '').slice(0, 7))) return c.json({ error: '该应付单所在月份已结账锁定' }, 403)
  const a = round2(num(amount, p.amount))
  const floor = round2(num(p.paid) + num(p.written_off))
  if (a < floor) {
    return c.json({ error: `这笔已经付了 ${round2(num(p.paid))} 元${num(p.written_off) ? `、豁免 ${round2(num(p.written_off))} 元` : ''}，金额不能改成比 ${floor} 少` }, 400)
  }
  const nd = due_date !== undefined ? (toIsoDate(due_date) || null) : (p.due_date || null)
  const nsup = supplier || p.supplier
  const nremark = remark !== undefined ? remark : p.remark
  const nop = operator !== undefined ? (String(operator).trim() || null) : (p.operator || null)
  await db.prepare('UPDATE payables SET supplier=?, amount=?, remark=?, due_date=?, operator=?, rev=COALESCE(rev,0)+1 WHERE id=?')
    .bind(nsup, a, nremark, nd, nop, id).run()
  const d = diffText([
    ['供应商', p.supplier, nsup], ['金额', round2(num(p.amount)), a],
    ['备注', p.remark, nremark], ['经手人', p.operator, nop],
    ['到期日', (p.due_date || '').slice(0, 10), (nd || '').slice(0, 10)]
  ])
  await logAudit(db, '编辑应付', nsup, d || '（没改动）', `payable:${id}`)
  return c.json({ ok: true, changed: d })
})

// 编辑现付支出流水
app.patch('/ledger/:id', async (c) => {
  const id = c.req.param('id')
  const { amount, category, remark } = await c.req.json()
  const db = c.env.DB
  const l = await db.prepare("SELECT * FROM ledger WHERE id=? AND ref_type IN ('expense','fixed')").bind(id).first()
  if (!l) return c.json({ error: '支出记录不存在' }, 404)
  if (await isMonthLocked(db, (l.created_at || '').slice(0, 7))) return c.json({ error: '该支出所在月份已结账锁定' }, 403)
  const a = num(amount, l.amount)
  if (a <= 0) return c.json({ error: '金额无效' }, 400)
  await db.prepare('UPDATE ledger SET amount=?, category=?, remark=? WHERE id=?')
    .bind(a, category || l.category, remark !== undefined ? remark : l.remark, id).run()
  await logAudit(db, '编辑支出', category || l.category, `${category || l.category} ¥${a}`)
  return c.json({ ok: true })
})

// 删除应收单（连带删其收款流水）
app.delete('/orders/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const o = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first()
  if (!o) return c.json({ error: '订单不存在' }, 404)
  if (await isMonthLocked(db, (o.created_at || '').slice(0, 7))) return c.json({ error: '该订单所在月份已结账锁定' }, 403)
  const b = uid()
  await intoTrash(db, 'order', o.id, o, b)
  const pays = await db.prepare("SELECT * FROM ledger WHERE ref_type='order' AND ref_id=?").bind(id).all()
  for (const l of pays.results) await intoTrash(db, 'ledger', l.id, l, b)
  const procs = await db.prepare('SELECT * FROM process_log WHERE order_id=?').bind(id).all()
  for (const p of procs.results) await intoTrash(db, 'process', p.id, p, b)
  await db.batch([
    db.prepare('DELETE FROM process_log WHERE order_id=?').bind(id),
    db.prepare('DELETE FROM ledger WHERE ref_type=? AND ref_id=?').bind('order', id),
    db.prepare('DELETE FROM orders WHERE id=?').bind(id)
  ])
  await logAudit(db, '删除应收', o.customer, `${o.customer} ${o.item_name}`)
  return c.json({ ok: true })
})

// 删除应付单（连带删其付款流水）
app.delete('/payables/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const p = await db.prepare('SELECT * FROM payables WHERE id=?').bind(id).first()
  if (!p) return c.json({ error: '应付单不存在' }, 404)
  if (await isMonthLocked(db, (p.created_at || '').slice(0, 7))) return c.json({ error: '该应付单所在月份已结账锁定' }, 403)
  const b = uid()
  await intoTrash(db, 'payable', p.id, p, b)
  const pays = await db.prepare("SELECT * FROM ledger WHERE ref_type='payable' AND ref_id=?").bind(id).all()
  for (const l of pays.results) await intoTrash(db, 'ledger', l.id, l, b)
  await db.batch([
    db.prepare('DELETE FROM ledger WHERE ref_type=? AND ref_id=?').bind('payable', id),
    db.prepare('DELETE FROM payables WHERE id=?').bind(id)
  ])
  await logAudit(db, '删除应付', p.supplier, `${p.supplier} ${p.remark}`)
  return c.json({ ok: true })
})

// 删除支出流水（仅现付支出）
app.delete('/ledger/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const l = await db.prepare("SELECT * FROM ledger WHERE id=? AND ref_type IN ('expense','fixed')").bind(id).first()
  if (!l) return c.json({ error: '支出记录不存在' }, 404)
  if (await isMonthLocked(db, (l.created_at || '').slice(0, 7))) return c.json({ error: '该支出所在月份已结账锁定' }, 403)
  const b = uid()
  await intoTrash(db, 'ledger', l.id, l, b)
  await db.prepare("DELETE FROM ledger WHERE id=? AND ref_type IN ('expense','fixed')").bind(id).run()
  await logAudit(db, '删除支出', l.category || '其他', `${l.category || '其他'} ¥${l.amount}`)
  return c.json({ ok: true })
})

// 回收站列表（按批聚合）
app.get('/trash', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM trash ORDER BY deleted_at DESC, id DESC LIMIT 300').all()
  const groups = {}
  const order = []
  for (const r of results) {
    const d = JSON.parse(r.data || '{}')
    let label = ''
    if (r.type === 'order') label = `应收 ${d.customer || ''} ¥${d.price || 0}`
    else if (r.type === 'payable') label = `应付 ${d.supplier || ''} ¥${d.amount || 0}`
    else if (r.type === 'ledger') label = `流水 ¥${d.amount || 0}（${d.remark || d.category || ''}）`
    else label = `工序记录（订单#${d.order_id || ''}）`
    if (!groups[r.batch]) { groups[r.batch] = { batch: r.batch, deleted_at: r.deleted_at, ids: [], items: [] }; order.push(r.batch) }
    groups[r.batch].ids.push(r.id)
    groups[r.batch].items.push(label)
  }
  return c.json(order.map((b) => groups[b]))
})

// 恢复回收站（按批整体恢复）
app.post('/trash/:id/restore', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const t = await db.prepare('SELECT * FROM trash WHERE id=?').bind(id).first()
  if (!t) return c.json({ error: '记录不存在' }, 404)
  const { results: rows } = await db.prepare('SELECT * FROM trash WHERE batch=?').bind(t.batch).all()
  for (const r of rows) {
    const d = JSON.parse(r.data || '{}')
    const m = (d.created_at || '').slice(0, 7)
    if (m && await isMonthLocked(db, m)) return c.json({ error: `该批记录所属月份 ${m} 已结账锁定，先解锁再恢复` }, 403)
  }
  let n = 0
  for (const r of rows) {
    const d = JSON.parse(r.data || '{}')
    if (r.type === 'order') {
      await db.prepare('INSERT INTO orders (id,customer,item_name,price,status,paid,due_date,operator,progress,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .bind(d.id, d.customer, d.item_name, num(d.price), num(d.status), num(d.paid), d.due_date || null, d.operator || '', d.progress || '', d.created_at).run()
    } else if (r.type === 'payable') {
      await db.prepare('INSERT INTO payables (id,supplier,amount,paid,category,remark,operator,due_date,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(d.id, d.supplier, num(d.amount), num(d.paid), d.category || '', d.remark || '', d.operator || '', d.due_date || null, d.created_at).run()
    } else if (r.type === 'ledger') {
      await db.prepare('INSERT INTO ledger (id,direction,ref_type,ref_id,amount,category,remark,operator,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(d.id, d.direction || 'out', d.ref_type || 'expense', d.ref_id || 0, num(d.amount), d.category || '', d.remark || '', d.operator || '', d.created_at).run()
    } else if (r.type === 'process') {
      await db.prepare('INSERT INTO process_log (id,order_id,progress,operator,created_at) VALUES (?,?,?,?,?)')
        .bind(d.id, d.order_id, d.progress || '', d.operator || '', d.created_at).run()
    }
    n++
  }
  await db.prepare('DELETE FROM trash WHERE batch=?').bind(t.batch).run()
  await logAudit(db, '恢复回收站', 'trash', `${t.batch}（${n}条）`)
  return c.json({ ok: true, restored: n })
})

// 彻底删除（不可恢复）
app.delete('/trash/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const t = await db.prepare('SELECT * FROM trash WHERE id=?').bind(id).first()
  if (!t) return c.json({ error: '记录不存在' }, 404)
  await db.prepare('DELETE FROM trash WHERE batch=?').bind(t.batch).run()
  return c.json({ ok: true })
})

// 已结清历史
app.get('/history', async (c) => {
  const type = c.req.query('type') || 'ar'
  const db = c.env.DB
  if (type === 'ap') {
    const { results } = await db.prepare('SELECT * FROM payables WHERE paid >= amount ORDER BY id DESC LIMIT 200').all()
    return c.json(results.map((r) => ({ ...r, settle: round2(r.amount) })))
  }
  const { results } = await db.prepare('SELECT * FROM orders WHERE paid >= price ORDER BY id DESC LIMIT 200').all()
  return c.json(results.map((r) => ({ ...r, settle: round2(r.price) })))
})

// ── 结算台账：已经结清的单，什么时候结的、拖了几天、走的哪个账户 ──
app.get('/settled', async (c) => {
  const db = c.env.DB
  const sp = new URL(c.req.url).searchParams
  const type = sp.get('type') === 'ap' ? 'ap' : 'ar'
  const month = /^\d{4}-\d{2}$/.test(String(sp.get('month') || '')) ? String(sp.get('month')) : ''
  const kw = String(sp.get('kw') || '').trim()
  const isAr = type === 'ar'
  const tbl = isAr ? 'orders' : 'payables'
  const partyCol = isAr ? 'customer' : 'supplier'
  const amtCol = isAr ? 'price' : 'amount'
  const itemCol = isAr ? 'item_name' : 'remark'
  const refType = isAr ? 'order' : 'payable'
  const dir = isAr ? 'in' : 'out'
  const docR = db.prepare(`SELECT id, COALESCE(${partyCol},'') AS party, COALESCE(${itemCol},'') AS item,
      COALESCE(${amtCol},0) AS amount, COALESCE(paid,0) AS paid, COALESCE(written_off,0) AS wo,
      created_at, COALESCE(operator,'') AS operator,
      (SELECT MAX(l.created_at) FROM ledger l WHERE l.ref_type='${refType}' AND l.ref_id=${tbl}.id AND l.direction='${dir}') AS last_pay
    FROM ${tbl}
    WHERE COALESCE(paid,0) + COALESCE(written_off,0) >= COALESCE(${amtCol},0)
    ORDER BY id DESC LIMIT 3000`).all().catch(() => ({ results: [] }))
  const accR = db.prepare(`SELECT l.ref_id AS rid, GROUP_CONCAT(DISTINCT COALESCE(a.name,'')) AS accs
    FROM ledger l LEFT JOIN accounts a ON a.id = l.account_id
    WHERE l.ref_type='${refType}' AND l.direction='${dir}' GROUP BY l.ref_id`).all().catch(() => ({ results: [] }))
  const [doc, acc] = await Promise.all([docR, accR])
  const accMap = {}
  for (const x of (acc.results || [])) accMap[num(x.rid)] = String(x.accs || '')
  const all = []
  for (const r of (doc.results || [])) {
    const created = String(r.created_at || '').slice(0, 10)
    const settle = String(r.last_pay || '').slice(0, 10) || created
    const days = created ? Math.max(0, Math.round((Date.parse(settle + 'T00:00:00Z') - Date.parse(created + 'T00:00:00Z')) / 86400000)) : 0
    all.push({
      id: num(r.id), party: r.party, item: r.item, amount: round2(num(r.amount)),
      paid: round2(num(r.paid)), wo: round2(num(r.wo)), operator: r.operator,
      created, settle_date: settle, days, month: settle.slice(0, 7),
      no_flow: !r.last_pay, accs: accMap[num(r.id)] || '',
      days_text: days === 0 ? '当天结清' : '拖了 ' + days + ' 天'
    })
  }
  let rows = all
  if (month) rows = rows.filter((x) => x.month === month)
  if (kw) rows = rows.filter((x) => (x.party + ' ' + x.item + ' ' + x.operator).indexOf(kw) >= 0)
  // 按月汇总（不受月份筛选影响，方便点月份切换）
  const mM = {}
  for (const x of all) {
    const e = mM[x.month] || (mM[x.month] = { m: x.month, cnt: 0, total: 0 })
    e.cnt++; e.total += x.amount
  }
  const months = Object.values(mM).sort((a, b) => (a.m < b.m ? 1 : -1)).slice(0, 12)
    .map((x) => ({ m: x.m, label: x.m.slice(5) + ' 月', cnt: x.cnt, total: round2(x.total) }))
  const cnt = rows.length
  const total = round2(rows.reduce((a, x) => a + x.amount, 0))
  const daysArr = rows.map((x) => x.days).sort((a, b) => a - b)
  const avg = cnt ? round2(daysArr.reduce((a, b) => a + b, 0) / cnt) : 0
  const fast = cnt ? daysArr[0] : 0
  const slow = cnt ? daysArr[cnt - 1] : 0
  const noFlow = rows.filter((x) => x.no_flow).length
  const scope = month ? month.slice(0, 4) + ' 年 ' + month.slice(5) + ' 月' : '全部'
  const text = cnt
    ? (slow === 0
      ? `${scope}结清 ${cnt} 单，共 ¥${total}；都是当天结清的。`
      : `${scope}结清 ${cnt} 单，共 ¥${total}；平均 ${avg} 天${isAr ? '收回' : '付出'}（最快 ${fast} 天、最慢 ${slow} 天）。`)
    : (month ? `${scope}还没有结清的单。` : `还没有结清的单。`)
  return c.json({ ok: true, type, month, kw, count: cnt, total, avg_days: avg, fast, slow, no_flow_cnt: noFlow,
    rows: rows.slice(0, 300), months, text,
    tip: noFlow ? `有 ${noFlow} 单是核销/豁免结清的，没有对应的收款记录。` : '' })
})

// 单位列表（客户/供应商汇总）
// 收付流水：逐笔看钱进钱出（老板最常问「这个月钱花哪了」）
// ── 逐笔对账：这个月的单和这个月的收款，一笔一笔对起来 ──
app.get('/recon-orders', async (c) => {
  const db = c.env.DB
  const type = c.req.query('type') === 'ap' ? 'ap' : 'ar'
  const m = /^\d{4}-\d{2}$/.test(String(c.req.query('month') || '')) ? String(c.req.query('month')) : now().slice(0, 7)
  const isAr = type === 'ar'
  const dir = isAr ? 'in' : 'out'
  const docR = isAr
    ? db.prepare(`SELECT id, customer AS party, item_name AS item, price AS amount, paid, COALESCE(written_off,0) AS wo, due_date, created_at
        FROM orders WHERE month=? ORDER BY id`).bind(m).all().catch(() => ({ results: [] }))
    : db.prepare(`SELECT id, supplier AS party, remark AS item, amount, paid, COALESCE(written_off,0) AS wo, due_date, created_at
        FROM payables WHERE month=? ORDER BY id`).bind(m).all().catch(() => ({ results: [] }))
  const flowR = db.prepare(`SELECT l.id, l.ref_id, l.amount, l.direction, l.ref_type, l.created_at, COALESCE(a.name,'') AS account,
        (l.account_id IS NULL OR l.account_id=0) AS no_acc
      FROM ledger l LEFT JOIN accounts a ON a.id=l.account_id
      WHERE substr(l.created_at,1,7)=? AND l.direction=? AND l.cash=1 ORDER BY l.id`).bind(m, dir).all().catch(() => ({ results: [] }))
  const [docQ, flowQ] = await Promise.all([docR, flowR])
  const docs = docQ.results || []
  const flows = flowQ.results || []
  const byRef = {}
  for (const f of flows) {
    if (f.ref_type !== (isAr ? 'order' : 'payable') || !f.ref_id) continue
    const k = num(f.ref_id)
    ;(byRef[k] || (byRef[k] = [])).push(f)
  }
  const rows = []
  let docTotal = 0, paidTotal = 0, flowTotal = 0
  const warns = []
  for (const d of docs) {
    const paid = round2(num(d.paid)), wo = round2(num(d.wo)), amt = round2(num(d.amount))
    const left = round2(amt - paid - wo)
    docTotal = round2(docTotal + amt)
    paidTotal = round2(paidTotal + paid)
    const fs = byRef[d.id] || []
    const fsum = round2(fs.reduce((x, f) => x + num(f.amount), 0))
    flowTotal = round2(flowTotal + fsum)
    const w = []
    if (paid > 0.005 && !fs.length) w.push({ k: 'no_flow', text: `这单记了已${isAr ? '收' : '付'} ¥${paid}，却找不到对应的流水（可能是直接改的金额，或者流水被删了）` })
    if (fsum > paid + 0.005) w.push({ k: 'flow_over', text: `流水比单上记的已${isAr ? '收' : '付'}多 ¥${round2(fsum - paid)}，两边对不上` })
    if (fs.some((f) => num(f.no_acc) === 1)) w.push({ k: 'no_acc', text: '有一笔流水没记账户（会默认算进第一个账户）' })
    if (left > 0.005 && d.due_date && String(d.due_date).slice(0, 10) < todayIso()) w.push({ k: 'overdue', text: `还欠 ¥${left}，到期日 ${String(d.due_date).slice(0, 10)} 已经过了 ${daysSince(d.due_date)} 天` })
    rows.push({
      id: d.id, party: d.party, item: d.item || '', date: (d.created_at || '').slice(0, 10),
      amount: amt, paid, written_off: wo, left, due: (d.due_date || '').slice(0, 10),
      flow_sum: fsum, pays: fs.map((f) => ({ date: (f.created_at || '').slice(0, 10), amount: round2(num(f.amount)), account: f.account || '（没记账户）' })),
      warns: w, ok: w.length === 0
    })
    for (const x of w) warns.push({ doc: d.id, party: d.party, ...x })
  }
  // 落在流水里、但没挂到任何单据上的收/付款（比如手动记的「收了一笔钱」）
  const orphan = flows.filter((f) => !(f.ref_type === (isAr ? 'order' : 'payable') && f.ref_id)).map((f) => ({
    date: (f.created_at || '').slice(0, 10), amount: round2(num(f.amount)), type: f.ref_type || '（没分类）', account: f.account || '（没记账户）'
  }))
  const orphanTotal = round2(orphan.reduce((x, f) => x + num(f.amount), 0))
  const diff = round2(paidTotal - flowTotal)
  const L = []
  L.push(`【${m} 逐笔对账 · ${isAr ? '应收（收款）' : '应付（付款）'}】`)
  if (!docs.length && !flows.length) L.push('这个月没有单据也没有流水，不用对。')
  else {
    L.push(`单据 ${docs.length} 张，合计 ¥${docTotal}；其中已${isAr ? '收' : '付'} ¥${paidTotal}`)
    L.push(`这个月的${isAr ? '收款' : '付款'}流水合计 ¥${flowTotal}（挂在这月的单上）`)
    if (Math.abs(diff) < 0.005) L.push('两边一致 ✓')
    else L.push(`两边差 ¥${Math.abs(diff)}：单据上记的已${isAr ? '收' : '付'}比流水${diff > 0 ? '多' : '少'} ¥${Math.abs(diff)}`)
    if (orphan.length) L.push(`另有 ${orphan.length} 笔${isAr ? '收款' : '付款'}（合计 ¥${orphanTotal}）没挂到任何单据上——可能是手动记的钱、预收款，或者记错了`)
    if (warns.length) {
      L.push(`有 ${warns.length} 处对不上：`)
      warns.slice(0, 8).forEach((x) => L.push(`· ${x.party} 第 ${x.doc} 号单：${x.text}`))
      if (warns.length > 8) L.push(`（还有 ${warns.length - 8} 处，看明细）`)
    } else L.push('每张单的钱都能在流水里对上 ✓')
  }
  return c.json({
    ok: true, type, month: m, rows, warns, warn_count: warns.length,
    orphan, orphan_total: orphanTotal,
    doc_cnt: docs.length, doc_total: docTotal, paid_total: paidTotal, flow_total: flowTotal, diff,
    text: L.join('\n')
  })
})

app.get('/flows', async (c) => {
  const db = c.env.DB
  const m = String(c.req.query('month') || '').trim()
  const kw = String(c.req.query('kw') || '').trim()
  const dir = ['in', 'out'].indexOf(c.req.query('dir')) >= 0 ? c.req.query('dir') : ''
  let sql = "SELECT l.id, l.direction, l.amount, l.category, l.remark, l.ref_type, l.ref_id, l.created_at, COALESCE(a.name,'') AS account, (l.account_id IS NULL OR l.account_id=0) AS no_acc FROM ledger l LEFT JOIN accounts a ON a.id=l.account_id WHERE 1=1"
  const b = []
  if (m) { sql += ' AND substr(l.created_at,1,7)=?'; b.push(m) }
  if (dir) { sql += ' AND l.direction=?'; b.push(dir) }
  if (kw) { sql += ' AND (COALESCE(l.category,\'\') LIKE ? OR COALESCE(l.remark,\'\') LIKE ? OR COALESCE(a.name,\'\') LIKE ?)'; b.push('%' + kw + '%', '%' + kw + '%', '%' + kw + '%') }
  sql += ' ORDER BY l.created_at DESC, l.id DESC LIMIT 300'
  const st = b.length ? db.prepare(sql).bind(...b) : db.prepare(sql)
  const raw = (await st.all()).results || []
  const rows = raw.map((r) => ({
    id: r.id,
    date: String(r.created_at || '').slice(0, 10),
    dir: r.direction,
    dir_text: r.direction === 'in' ? '收' : '付',
    amount: round2(num(r.amount)),
    signed: round2(r.direction === 'in' ? num(r.amount) : -num(r.amount)),
    category: r.category || '',
    cat_text: r.category || (r.ref_type === 'order' ? '货款' : (r.ref_type === 'payable' ? '货款' : (r.ref_type === 'advance' ? '预收预付' : (r.ref_type === 'loan' ? '借支' : (r.ref_type === 'debt' ? '借款' : '未分类'))))),
    remark: r.remark || '',
    account: r.account || '现金',
    ref_type: r.ref_type || '',
    ref_id: r.ref_id || 0,
    ref_text: r.ref_type === 'order' ? '应收 #' + r.ref_id : (r.ref_type === 'payable' ? '应付 #' + r.ref_id : (r.ref_type === 'advance' ? '预收预付' : (r.ref_type === 'loan' ? '借支' : (r.ref_type === 'transfer' ? '内部转账' : (r.ref_type === 'dep' ? '折旧' : (r.ref_type === 'accrual' || r.ref_type === 'debt_int' ? '预提利息' : (r.ref_type === 'debt' ? '借款' : '')))))))
  }))
  const ti = round2(rows.filter((x) => x.dir === 'in').reduce((a, x) => a + x.amount, 0))
  const to = round2(rows.filter((x) => x.dir === 'out').reduce((a, x) => a + x.amount, 0))
  const cats = {}
  rows.forEach((x) => { const k = (x.dir === 'in' ? '收·' : '付·') + (x.cat_text || '未分类'); cats[k] = round2(num(cats[k]) + x.amount) })
  return c.json({
    ok: true, month: m, kw, dir, count: rows.length, rows,
    total_in: ti, total_out: to, net: round2(ti - to),
    by_cat: Object.keys(cats).map((k) => ({ name: k, amount: cats[k] })).sort((a, b2) => b2.amount - a.amount),
    tip: rows.length ? '' : '这个范围没有流水，换个月份或清空关键词'
  })
})

// 往来单位档案：电话、联系人、地址、开票信息 —— 催款能直接拨号，对账单有抬头
app.get('/profiles', async (c) => {
  const db = c.env.DB
  const kind = c.req.query('kind') === 'ap' ? 'ap' : (c.req.query('kind') === 'ar' ? 'ar' : '')
  const prof = (await db.prepare('SELECT * FROM party_profiles').all()).results || []
  const pmap = {}
  prof.forEach((r) => { pmap[r.party] = r })
  // 对账单发过几次（单位页显示，避免重复发、也证明发过）
  const slog = {}
  try {
    const sl = (await db.prepare('SELECT party, COUNT(*) n, MAX(created_at) last FROM statement_log GROUP BY party').all()).results || []
    for (const r of sl) slog[norm(r.party)] = { times: num(r.n), last: String(r.last || '').slice(0, 10), days: daysSince(r.last) }
  } catch (e) {}
  const arRows = (await db.prepare('SELECT customer AS party, COUNT(*) cnt, COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) left_amt, SUM(price) total FROM orders GROUP BY customer').all()).results || []
  const apRows = (await db.prepare('SELECT supplier AS party, COUNT(*) cnt, COALESCE(SUM(amount-paid-COALESCE(written_off,0)),0) left_amt, SUM(amount) total FROM payables GROUP BY supplier').all()).results || []
  const mk = (arr, k) => arr.map((r) => {
    const p = pmap[r.party] || {}
    const sg = slog[norm(r.party)] || {}
    return { kind: k, party: r.party || '', cnt: num(r.cnt), left: round2(num(r.left_amt)), total: round2(num(r.total)), contact: p.contact || '', phone: p.phone || '', addr: p.addr || '', note: p.note || '', has_profile: !!p.id, id: p.id || 0, sent_times: num(sg.times), sent_last: sg.last || '', sent_days: sg.days === undefined ? null : sg.days }
  })
  let list = mk(arRows, 'ar').concat(mk(apRows, 'ap'))
  if (kind) list = list.filter((x) => x.kind === kind)
  list.sort((a, b2) => (b2.left - a.left) || (b2.total - a.total))
  return c.json({ ok: true, kind, count: list.length, with_phone: list.filter((x) => x.phone).length, list })
})

app.post('/profiles', async (c) => {
  const db = c.env.DB
  const b = await c.req.json().catch(() => ({}))
  const party = String(b.party || '').trim()
  if (!party) return c.json({ error: '单位名称不能空着' }, 400)
  const kind = b.kind === 'ap' ? 'ap' : 'ar'
  const contact = String(b.contact || '').trim().slice(0, 30)
  const phone = String(b.phone || '').trim().slice(0, 30)
  const addr = String(b.addr || '').trim().slice(0, 100)
  const note = String(b.note || '').trim().slice(0, 200)
  const old = await db.prepare('SELECT id FROM party_profiles WHERE party=?').bind(party).first()
  if (old) {
    await db.prepare('UPDATE party_profiles SET kind=?,contact=?,phone=?,addr=?,note=? WHERE id=?').bind(kind, contact, phone, addr, note, old.id).run()
  } else {
    await db.prepare('INSERT INTO party_profiles (party,kind,contact,phone,addr,note,created_at) VALUES (?,?,?,?,?,?,?)').bind(party, kind, contact, phone, addr, note, now()).run()
  }
  await logAudit(db, 'profile', party, '改档案 ' + (phone || contact || ''))
  return c.json({ ok: true, party, contact, phone, addr, note })
})

app.delete('/profiles/:id', async (c) => {
  const db = c.env.DB
  await db.prepare('DELETE FROM party_profiles WHERE id=?').bind(num(c.req.param('id'))).run()
  return c.json({ ok: true })
})

app.get('/contacts', async (c) => {
  const db = c.env.DB
  const ar = await db.prepare(
    "SELECT customer AS name, SUM(price) AS total, SUM(paid) AS paid, SUM(price-paid-COALESCE(written_off,0)) AS unpaid, COUNT(*) AS cnt FROM orders GROUP BY customer ORDER BY unpaid DESC"
  ).all()
  const ap = await db.prepare(
    "SELECT supplier AS name, SUM(amount) AS total, SUM(paid) AS paid, SUM(amount-paid-COALESCE(written_off,0)) AS unpaid, COUNT(*) AS cnt FROM payables GROUP BY supplier ORDER BY unpaid DESC"
  ).all()
  return c.json({
    ar: ar.results.map((r) => ({ ...r, total: round2(r.total), paid: round2(r.paid), unpaid: round2(r.unpaid) })),
    ap: ap.results.map((r) => ({ ...r, total: round2(r.total), paid: round2(r.paid), unpaid: round2(r.unpaid) }))
  })
})

// 单位往来明细
app.get('/contact-detail', async (c) => {
  const type = c.req.query('type') || 'ar'
  const name = c.req.query('name')
  if (!name) return c.json({ error: '缺少单位名称' }, 400)
  const db = c.env.DB
  const lines = []
  if (type === 'ar') {
    const { results: orders } = await db.prepare('SELECT * FROM orders WHERE customer=? ORDER BY id').bind(name).all()
    const { results: ins } = await db.prepare(
      "SELECT l.* FROM ledger l JOIN orders o ON l.ref_id=o.id WHERE l.direction='in' AND l.ref_type='order' AND o.customer=? ORDER BY l.id"
    ).bind(name).all()
    let total = 0, paid = 0
    orders.forEach((o) => { total += o.price; paid += o.paid })
    lines.push(...(await titled(db, `${name} · 往来明细`)))
    lines.push(`累计应收：${round2(total)}  已收：${round2(paid)}  未收：${round2(total - paid)}`)
    lines.push('')
    lines.push('—— 订单 ——')
    orders.forEach((o, i) => lines.push(`${i + 1}. ${o.item_name || '加工'} 总${o.price} 已收${o.paid} 欠${round2(o.price - o.paid)}（${o.created_at.slice(0, 10)}）`))
    if (!orders.length) lines.push('（无）')
    lines.push('')
    lines.push('—— 收款记录 ——')
    ins.forEach((l, i) => lines.push(`${i + 1}. ${l.created_at.slice(0, 10)} 收${l.amount} ${l.remark}`))
    if (!ins.length) lines.push('（无）')
  } else {
    const { results: pays } = await db.prepare('SELECT * FROM payables WHERE supplier=? ORDER BY id').bind(name).all()
    const { results: outs } = await db.prepare(
      "SELECT l.* FROM ledger l JOIN payables p ON l.ref_id=p.id WHERE l.direction='out' AND l.ref_type='payable' AND p.supplier=? ORDER BY l.id"
    ).bind(name).all()
    let total = 0, paid = 0
    pays.forEach((p) => { total += p.amount; paid += p.paid })
    lines.push(...(await titled(db, `${name} · 往来明细`)))
    lines.push(`累计应付：${round2(total)}  已付：${round2(paid)}  未付：${round2(total - paid)}`)
    lines.push('')
    lines.push('—— 应付单 ——')
    pays.forEach((p, i) => {
      const desc = [p.category, p.remark].filter(Boolean).join(' ')
      lines.push(`${i + 1}. ${desc || '货款'} 总${p.amount} 已付${p.paid} 欠${round2(p.amount - p.paid)}（${p.created_at.slice(0, 10)}）`)
    })
    if (!pays.length) lines.push('（无）')
    lines.push('')
    lines.push('—— 付款记录 ——')
    outs.forEach((l, i) => lines.push(`${i + 1}. ${l.created_at.slice(0, 10)} 付${l.amount} ${l.remark}`))
    if (!outs.length) lines.push('（无）')
  }
  return c.json({ text: lines.join('\n') })
})

// 生成全量备份 JSON
// 备份里除了账目，还要带上「账目以外的家底」，否则恢复完账户期初、设备、借款都没了
const BACKUP_EXTRA = ['accounts', 'advances', 'loans', 'debts', 'debt_repays', 'assets', 'invoices', 'fixed_expenses', 'party_terms', 'party_profiles', 'credit_limits', 'quotes', 'categories', 'transfers', 'writeoffs', 'recon_log', 'statement_log', 'dunning_log', 'net_snapshots', 'targets', 'budgets', 'edit_requests', 'month_archive', 'settings']
// 口令这类东西不进备份文件，免得备份发出去把口令也带出去
const BACKUP_SETTINGS_SKIP = ['access_key', 'staff_key', 'sealed', 'sealed_at', 'sealed_note']
async function buildBackup(db) {
  const orders = await db.prepare('SELECT * FROM orders ORDER BY id').all()
  const payables = await db.prepare('SELECT * FROM payables ORDER BY id').all()
  const ledger = await db.prepare('SELECT * FROM ledger ORDER BY id').all()
  const out = { exported_at: now(), version: 2, orders: orders.results, payables: payables.results, ledger: ledger.results }
  for (const t of BACKUP_EXTRA) {
    try {
      const r = await db.prepare('SELECT * FROM ' + t).all()
      let rows = r.results || []
      if (t === 'settings') rows = rows.filter((x) => !BACKUP_SETTINGS_SKIP.includes(String(x.key)))
      out[t] = rows
    } catch (e) { out[t] = [] }
  }
  return JSON.stringify(out, null, 2)
}

// ── 备份到笔记站（md.1211.cc.cd）──
async function buildMarkdown(db) {
  const orders = await db.prepare('SELECT * FROM orders ORDER BY id').all()
  const payables = await db.prepare('SELECT * FROM payables ORDER BY id').all()
  const ledger = await db.prepare('SELECT * FROM ledger ORDER BY id').all()
  const ar = await db.prepare('SELECT COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) AS t FROM orders WHERE paid + COALESCE(written_off,0) < price').first()
  const ap = await db.prepare('SELECT COALESCE(SUM(amount-paid-COALESCE(written_off,0)),0) AS t FROM payables WHERE paid + COALESCE(written_off,0) < amount').first()
  const inAll = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='in' AND cash=1 AND ref_type<>'transfer'").first()
  const outAll = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer'").first()
  const st = (s) => (s == 2 ? '已交付' : s == 1 ? '加工中' : '待加工')
  const L = []
  L.push('# 小工厂记账 · 自动备份')
  L.push('')
  L.push(`导出时间：${now().slice(0, 19).replace('T', ' ')}`)
  L.push('')
  L.push('## 总览')
  L.push(`- 客户还欠我：**${round2(num(ar.t))}** 元`)
  L.push(`- 我还欠供应商：**${round2(num(ap.t))}** 元`)
  L.push(`- 累计已收款：${round2(num(inAll.t))} 元`)
  L.push(`- 累计已付款：${round2(num(outAll.t))} 元`)
  L.push('')
  L.push('## 应收明细')
  L.push('')
  L.push('| 日期 | 客户 | 产品 | 金额 | 已收 | 未收 | 状态 | 到期日 | 经手人 |')
  L.push('|---|---|---|---|---|---|---|---|---|')
  for (const o of orders.results) L.push(`| ${o.created_at.slice(0, 10)} | ${o.customer} | ${o.item_name || ''} | ${o.price} | ${o.paid} | ${round2(o.price - o.paid)} | ${st(o.status)} | ${(o.due_date || '').slice(0, 10)} | ${o.operator || ''} |`)
  L.push('')
  L.push('## 应付明细')
  L.push('')
  L.push('| 日期 | 供应商 | 金额 | 已付 | 未付 | 分类 | 备注 | 经手人 |')
  L.push('|---|---|---|---|---|---|---|---|')
  for (const p of payables.results) L.push(`| ${p.created_at.slice(0, 10)} | ${p.supplier} | ${p.amount} | ${p.paid} | ${round2(p.amount - p.paid)} | ${p.category || ''} | ${p.remark || ''} | ${p.operator || ''} |`)
  L.push('')
  L.push('## 收支流水')
  L.push('')
  L.push('| 日期 | 方向 | 金额 | 分类 | 备注 | 经手人 |')
  L.push('|---|---|---|---|---|---|')
  for (const l of ledger.results) L.push(`| ${l.created_at.slice(0, 10)} | ${l.direction === 'in' ? '收' : '付'} | ${l.amount} | ${l.category || ''} | ${l.remark || ''} | ${l.operator || ''} |`)
  L.push('')
  return L.join('\n')
}

async function pushToNotes(db, env) {
  const base = env.NOTES_BASE || 'https://md.1211.cc.cd'
  const pass = env.NOTES_PASS || ''
  const slug = env.NOTES_SLUG || 'factory-ledger-backup'
  if (!pass) return { ok: false, error: '未配置笔记站口令 NOTES_PASS' }
  const md = await buildMarkdown(db)
  const loginRes = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pass })
  })
  if (!loginRes.ok) return { ok: false, error: `笔记站登录失败（${loginRes.status}）` }
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0]
  const headers = { 'Content-Type': 'application/json', Cookie: cookie }
  let r = await fetch(`${base}/api/docs/${slug}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ title: '小工厂记账自动备份', content: md })
  })
  if (r.status === 404) {
    r = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: '小工厂记账自动备份', slug, content: md })
    })
  }
  if (!r.ok) return { ok: false, error: `笔记站写入失败（${r.status}）` }
  const d = await r.json().catch(() => ({}))
  return { ok: true, slug: d.slug || slug, saved_at: now() }
}


// 数据备份：全量导出 JSON（复制用）
app.get('/backup', async (c) => {
  return c.json({ text: await buildBackup(c.env.DB) })
})

// 云端备份：写一份快照进 backups 表，保留最近 30 份
async function saveBackup(db) {
  const content = await buildBackup(db)
  await db.prepare('INSERT INTO backups (content, created_at) VALUES (?,?)').bind(content, now()).run()
  await db.prepare('DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY id DESC LIMIT 30)').run()
  const latest = await db.prepare('SELECT id, created_at, length(content) AS size FROM backups ORDER BY id DESC LIMIT 1').first()
  return latest
}

app.post('/cloud-backup', async (c) => {
  const latest = await saveBackup(c.env.DB)
  return c.json({ ok: true, saved_at: latest.created_at, id: latest.id, size: latest.size })
})

// 备份到笔记站（https://md.1211.cc.cd），先登录拿 cookie 再写固定 slug 的笔记
app.post('/backup-to-notes', async (c) => {
  const res = await pushToNotes(c.env.DB, c.env)
  return c.json(res, res.ok ? 200 : 500)
})

// 云端备份列表
app.get('/backup-list', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, created_at, length(content) AS size FROM backups ORDER BY id DESC LIMIT 30').all()
  return c.json(results)
})

// 取某份云端备份内容
app.get('/backup-get', async (c) => {
  const id = c.req.query('id')
  const r = await c.env.DB.prepare('SELECT content FROM backups WHERE id=?').bind(num(id)).first()
  if (!r) return c.json({ error: '备份不存在' }, 404)
  return c.json({ text: r.content })
})

// 一键恢复：用备份 JSON 覆盖当前账目（恢复前自动留一份快照）
async function runBatch(db, stmts) {
  for (let i = 0; i < stmts.length; i += 50) {
    await db.batch(stmts.slice(i, i + 50))
  }
}

// 恢复主体：/restore（贴文字）和 /backup-restore/:id（回到某天的账本）共用
async function restoreCore(db, data) {
  const orders = Array.isArray(data.orders) ? data.orders : []
  const payables = Array.isArray(data.payables) ? data.payables : []
  const ledger = Array.isArray(data.ledger) ? data.ledger : []
  if (!orders.length && !payables.length && !ledger.length) return c.json({ error: '备份里没有账目数据' }, 400)

  // 恢复前自动快照，防止误操作
  await saveBackup(db)

  const stmts = [
    db.prepare('DELETE FROM ledger'),
    db.prepare('DELETE FROM payables'),
    db.prepare('DELETE FROM orders')
  ]
  const skipped = { orders: 0, payables: 0, ledger: 0 }
  for (const o of orders) {
    if (!o.customer || num(o.price) <= 0) { skipped.orders++; continue }
    stmts.push(db.prepare('INSERT INTO orders (id, customer, item_name, price, status, paid, due_date, operator, created_at, cost, written_off, progress, rev) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(num(o.id) || null, o.customer, o.item_name || '', num(o.price), num(o.status) || 0, num(o.paid) || 0, o.due_date || null, o.operator || null, o.created_at || now(), num(o.cost), num(o.written_off), o.progress || '', num(o.rev)))
  }
  for (const p of payables) {
    if (!p.supplier || num(p.amount) <= 0) { skipped.payables++; continue }
    stmts.push(db.prepare('INSERT INTO payables (id, supplier, amount, paid, category, remark, operator, due_date, created_at, written_off, rev) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind(num(p.id) || null, p.supplier, num(p.amount), num(p.paid) || 0, p.category || '', p.remark || '', p.operator || null, p.due_date || null, p.created_at || now(), num(p.written_off), num(p.rev)))
  }
  for (const l of ledger) {
    if (num(l.amount) <= 0 || !l.direction) { skipped.ledger++; continue }
    stmts.push(db.prepare('INSERT INTO ledger (id, direction, ref_type, ref_id, amount, category, remark, operator, created_at, account_id, cash) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind(num(l.id) || null, l.direction, l.ref_type || '', num(l.ref_id) || 0, num(l.amount), l.category || '', l.remark || '', l.operator || null, l.created_at || now(), num(l.account_id), l.cash === undefined ? 1 : num(l.cash)))
  }
  await runBatch(db, stmts)
  // 账目以外的家底也一起还原（老备份没有这些字段就跳过，不算错）
  const extra = {}
  for (const t of BACKUP_EXTRA) {
    const rows = Array.isArray(data[t]) ? data[t] : null
    if (!rows) continue
    try {
      const info = (await db.prepare('PRAGMA table_info(' + t + ')').all()).results || []
      const cols = info.map((x) => x.name)
      if (!cols.length) continue
      const st = [t === 'settings'
        ? db.prepare("DELETE FROM settings WHERE key NOT IN ('access_key','staff_key','sealed','sealed_at','sealed_note')")
        : db.prepare('DELETE FROM ' + t)]
      for (const r of rows) {
        if (t === 'settings' && BACKUP_SETTINGS_SKIP.includes(String(r.key))) continue
        const use = cols.filter((cn) => r[cn] !== undefined)
        if (!use.length) continue
        st.push(db.prepare('INSERT INTO ' + t + ' (' + use.join(',') + ') VALUES (' + use.map(() => '?').join(',') + ')').bind(...use.map((cn) => r[cn])))
      }
      await runBatch(db, st)
      extra[t] = rows.length
    } catch (e) { extra[t] = -1 }
  }
  await logAudit(db, '数据恢复', '', `恢复 应收${orders.length - skipped.orders} 应付${payables.length - skipped.payables} 流水${ledger.length - skipped.ledger} 家底${Object.keys(extra).length}类`)
  return { restored: { orders: orders.length - skipped.orders, payables: payables.length - skipped.payables, ledger: ledger.length - skipped.ledger }, extra, skipped }
}

app.post('/restore', async (c) => {
  const db = c.env.DB
  let data
  try {
    const raw = await c.req.json()
    data = raw
    if (typeof raw.text === 'string') data = JSON.parse(raw.text)
    else if (typeof raw.data === 'string') data = JSON.parse(raw.data)
  } catch (e) {
    return c.json({ error: '备份内容不是有效 JSON' }, 400)
  }
  const orders = Array.isArray(data.orders) ? data.orders : []
  const payables = Array.isArray(data.payables) ? data.payables : []
  const ledger = Array.isArray(data.ledger) ? data.ledger : []
  if (!orders.length && !payables.length && !ledger.length) return c.json({ error: '备份里没有账目数据' }, 400)
  const r = await restoreCore(db, data)
  return c.json(Object.assign({ ok: true }, r))
})

// 「回到某一天的账本」：列出最近的备份，每份备份里有多少单、多少钱，和现在差多少
app.get('/backup-timeline', async (c) => {
  const db = c.env.DB
  const [curO, curP, curL] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(price),0) AS t FROM orders').first(),
    db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS t FROM payables').first(),
    db.prepare('SELECT COUNT(*) AS c FROM ledger').first()
  ])
  const cur = { orders: num(curO && curO.c), order_sum: round2(num(curO && curO.t)), payables: num(curP && curP.c), payable_sum: round2(num(curP && curP.t)), ledger: num(curL && curL.c) }
  let rows = []
  try { rows = (await db.prepare('SELECT id, created_at, content FROM backups ORDER BY id DESC LIMIT 12').all()).results } catch (e) { rows = [] }
  const items = []
  for (const r of rows) {
    let d = null
    try { d = JSON.parse(r.content) } catch (e) { d = null }
    const o = (d && Array.isArray(d.orders)) ? d.orders : []
    const p = (d && Array.isArray(d.payables)) ? d.payables : []
    const l = (d && Array.isArray(d.ledger)) ? d.ledger : []
    const orderSum = round2(o.reduce((a, x) => a + num(x.price), 0))
    const paySum = round2(p.reduce((a, x) => a + num(x.amount), 0))
    items.push({
      id: r.id, at: r.created_at, date: String(r.created_at || '').slice(0, 10), time: String(r.created_at || '').slice(11, 16),
      orders: o.length, order_sum: orderSum, payables: p.length, payable_sum: paySum, ledger: l.length,
      d_orders: cur.orders - o.length, d_order_sum: round2(cur.order_sum - orderSum),
      d_payables: cur.payables - p.length, d_ledger: cur.ledger - l.length
    })
  }
  return c.json({
    current: cur, count: items.length, items,
    latest: items[0] || null,
    note: items.length ? '恢复会用这份备份覆盖现在的应收、应付、流水（账户余额、发票、借支这些不动的）。动手前系统会先把现在的账本存一份快照，选错了还能再回来。' : '还没有备份。先在报表页点一次「立即备份」，以后就能回到那一天。'
  })
})

// 回到某一份备份（服务端直接恢复，不用手抄 JSON）
// 备份能不能用：不是「有没有备份」，而是「这份备份真能恢复吗」
app.get('/backup-verify', async (c) => {
  const db = c.env.DB
  const row = await db.prepare('SELECT id, created_at, length(content) AS size, content FROM backups ORDER BY id DESC LIMIT 1').first().catch(() => null)
  if (!row) return c.json({ ok: true, has: false, usable: false, text: '还没有任何备份。报表页点一次「立即备份」，以后就能回到这一天。' })
  let d = null
  try { d = JSON.parse(row.content) } catch (e) { d = null }
  const CORE = ['orders', 'payables', 'ledger']
  const ALL = CORE.concat(BACKUP_EXTRA)
  const live = {}
  for (const t of ALL) {
    try {
      live[t] = t === 'settings'
        ? num((await db.prepare("SELECT COUNT(*) n FROM settings WHERE key NOT IN ('access_key','staff_key','sealed','sealed_at','sealed_note')").first()).n)
        : num((await db.prepare('SELECT COUNT(*) n FROM ' + t).first()).n)
    } catch (e) { live[t] = -1 }
  }
  const tables = []
  const missing = []
  for (const t of ALL) {
    const rows = d && Array.isArray(d[t]) ? d[t] : null
    const inB = rows ? rows.length : null
    if (inB === null) { missing.push(t); continue }
    tables.push({ name: t, in_backup: inB, live: live[t], drift: live[t] >= 0 ? live[t] - inB : 0 })
  }
  const usable = !!d && CORE.every((t) => Array.isArray(d[t]))
  const days = daysSince(String(row.created_at || '').slice(0, 10))
  const warns = []
  if (!usable) warns.push('这份备份内容坏了（不是有效 JSON 或缺账目），恢复不了')
  if (missing.length) warns.push('这份备份是旧格式，缺 ' + missing.length + ' 类数据（' + missing.slice(0, 6).join('、') + '…），恢复完这些会空着')
  if (days > 7) warns.push('最近一份备份是 ' + days + ' 天前的，超过一周没备份了')
  if (num(row.size) < 200) warns.push('备份只有 ' + row.size + ' 字节，可能是空账本')
  const drift = tables.filter((x) => Math.abs(x.drift) > 0).length
  const text = !usable
    ? '最近一份备份用不了：' + (warns[0] || '内容不完整')
    : '最近一份备份是 ' + String(row.created_at || '').slice(0, 16) + '（' + Math.round(num(row.size) / 1024) + ' KB），能恢复。' +
      (missing.length ? ' 但它是旧格式，缺 ' + missing.length + ' 类数据。' : ' 账目以外的家底也都在里面。') +
      (drift ? ' 和现在比有 ' + drift + ' 类数量不一样（备份之后又记了新东西，正常）。' : ' 和现在完全一致。')
  return c.json({ ok: true, has: true, usable, id: row.id, at: row.created_at, days_ago: days, size: num(row.size), version: d && d.version || 1,
    tables, missing, drift_count: drift, warns, text })
})

app.post('/backup-restore', async (c) => {
  const db = c.env.DB
  const b = await c.req.json().catch(() => ({}))
  const id = num(b.id)
  if (!id) return c.json({ error: '要指定回到哪一份备份' }, 400)
  const r = await db.prepare('SELECT content FROM backups WHERE id=?').bind(id).first()
  if (!r) return c.json({ error: '这份备份找不到了（可能已被新备份顶掉）' }, 404)
  let data
  try { data = JSON.parse(r.content) } catch (e) { return c.json({ error: '这份备份内容坏了，换一份试试' }, 400) }
  const o = Array.isArray(data.orders) ? data.orders : []
  const p = Array.isArray(data.payables) ? data.payables : []
  const l = Array.isArray(data.ledger) ? data.ledger : []
  if (!o.length && !p.length && !l.length) return c.json({ error: '这份备份里没有账目数据' }, 400)
  if (!b.confirm) return c.json({ need_confirm: true, will: { orders: o.length, order_sum: round2(o.reduce((a, x) => a + num(x.price), 0)), payables: p.length, ledger: l.length }, error: '恢复会覆盖现在的账目，请确认' }, 409)
  const res = await restoreCore(db, data)
  return c.json(Object.assign({ ok: true, from: id }, res))
})


// ── 第二档：家底 / 账龄 / 月度归档 / 报表抬头 / 财务指标 ──
const monthList = (n) => {
  const out = []
  const d = new Date(Date.now() + TZ_MS)
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1))
    out.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`)
  }
  return out
}
const cashAtEnd = async (db, m) => {
  const accs = await accountBalances(db)
  const opening = accs.reduce((s, a) => s + num(a.opening), 0)
  const i = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND ref_type<>'transfer' AND direction='in' AND month<=?").bind(m).first()
  const o = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND ref_type<>'transfer' AND direction='out' AND month<=?").bind(m).first()
  return round2(opening + num(i.t) - num(o.t))
}
const arAtEnd = async (db, m) => {
  const a = await db.prepare("SELECT COALESCE(SUM(price - COALESCE(written_off,0)),0) t FROM orders WHERE month<=?").bind(m).first()
  const b = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE direction='in' AND ref_type='order' AND month<=?").bind(m).first()
  return round2(Math.max(num(a.t) - num(b.t), 0))
}
const apAtEnd = async (db, m) => {
  const a = await db.prepare("SELECT COALESCE(SUM(amount - COALESCE(written_off,0)),0) t FROM payables WHERE month<=?").bind(m).first()
  const b = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE direction='out' AND ref_type='payable' AND substr(created_at,1,7)<=?").bind(m).first()
  return round2(Math.max(num(a.t) - num(b.t), 0))
}

// 家底：每月末 现金 + 别人欠我 − 我欠别人
async function netSeries(db, months) {
  const n = Math.min(Math.max(num(months) || 12, 1), 36)
  // 性能：原来每个月都要 8 次查询、串行 12 个月（19 秒），改成 5 次分组查询后自己累加（约 1 秒）
  const jobs = [
    db.prepare('SELECT COALESCE(SUM(opening),0) t FROM accounts').first(),
    db.prepare(`SELECT substr(created_at,1,7) mk,
      COALESCE(SUM(CASE WHEN direction='in' AND cash=1 AND ref_type<>'transfer' THEN amount ELSE 0 END),0) ci,
      COALESCE(SUM(CASE WHEN direction='out' AND cash=1 AND ref_type<>'transfer' THEN amount ELSE 0 END),0) co,
      COALESCE(SUM(CASE WHEN direction='in' AND ref_type='order' THEN amount ELSE 0 END),0) arin,
      COALESCE(SUM(CASE WHEN direction='out' AND ref_type='payable' THEN amount ELSE 0 END),0) apout
      FROM ledger GROUP BY mk`).all(),
    db.prepare('SELECT month mk, COALESCE(SUM(price - COALESCE(written_off,0)),0) t FROM orders GROUP BY mk').all(),
    db.prepare('SELECT month mk, COALESCE(SUM(amount - COALESCE(written_off,0)),0) t FROM payables GROUP BY mk').all(),
    db.prepare('SELECT * FROM debts').all(),
    db.prepare('SELECT * FROM debt_repays').all()
  ].map((x) => x.catch((e) => { noteFail(e); return null }))
  const [openR, lR, oR, pR, dR, rR] = await Promise.all(jobs)
  const rowsOf = (r) => (r && r.results) || []
  const opening = num(openR && openR.t)
  const lMap = {}
  for (const x of rowsOf(lR)) lMap[x.mk] = { ci: num(x.ci), co: num(x.co), arin: num(x.arin), apout: num(x.apout) }
  const oMap = {}, pMap = {}
  for (const x of rowsOf(oR)) oMap[x.mk] = num(x.t)
  for (const x of rowsOf(pR)) pMap[x.mk] = num(x.t)
  const debts = rowsOf(dR)
  const reps = rowsOf(rR)
  const debtAtEnd = (m) => {
    const end = m + '-31'
    const borrowed = debts.filter((d) => (d.start_date || d.created_at || '').slice(0, 10) <= end).reduce((a, d) => a + num(d.principal), 0)
    const repaid = reps.filter((r) => r.kind === 'principal' && (r.rdate || r.created_at || '').slice(0, 10) <= end).reduce((a, r) => a + num(r.amount), 0)
    return round2(Math.max(0, borrowed - repaid))
  }
  const keys = Array.from(new Set(Object.keys(lMap).concat(Object.keys(oMap), Object.keys(pMap))))
  const out = []
  for (const m of monthList(n)) {
    let ci = 0, co = 0, arin = 0, apout = 0, ord = 0, pay = 0
    for (const k of keys) {
      if (!k || k > m) continue
      const l = lMap[k]
      if (l) { ci += l.ci; co += l.co; arin += l.arin; apout += l.apout }
      ord += num(oMap[k]); pay += num(pMap[k])
    }
    const cash = round2(opening + ci - co)
    const ar = round2(Math.max(ord - arin, 0))
    const ap = round2(Math.max(pay - apout, 0))
    const debt = debtAtEnd(m)
    out.push({ m, cash, ar, ap, debt, net: round2(cash + ar - ap - debt) })
  }
  return out
}
// 现在这一刻的家底（按当月算）
async function netNow(db) {
  const arr = await netSeries(db, 1)
  const r = arr[arr.length - 1] || { cash: 0, ar: 0, ap: 0, debt: 0, net: 0 }
  return { month: now().slice(0, 7), cash: r.cash, ar: r.ar, ap: r.ap, debt: r.debt, net: r.net }
}
// 存一份家底快照：以后改了老单据，已存的历史数不会被带偏
async function snapNet(db, m, note) {
  const mm = String(m || '').slice(0, 7) || now().slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(mm)) return { error: '月份格式：YYYY-MM' }
  const arr = await netSeries(db, 36)
  const hit = arr.find((x) => x.m === mm)
  if (!hit) return { error: '这个月还没有账，存了也是 0' }
  const has = await db.prepare('SELECT 1 FROM net_snapshots WHERE month=?').bind(mm).first()
  if (has) {
    await db.prepare('UPDATE net_snapshots SET cash=?, ar=?, ap=?, debt=?, net=?, note=?, created_at=? WHERE month=?')
      .bind(hit.cash, hit.ar, hit.ap, hit.debt, hit.net, String(note || '').slice(0, 60), now(), mm).run()
  } else {
    await db.prepare('INSERT INTO net_snapshots (month, cash, ar, ap, debt, net, note, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(mm, hit.cash, hit.ar, hit.ap, hit.debt, hit.net, String(note || '').slice(0, 60), now()).run()
  }
  return { ok: true, month: mm, cash: hit.cash, ar: hit.ar, ap: hit.ap, debt: hit.debt, net: hit.net }
}
app.get('/networth', async (c) => {
  return c.json(await netSeries(c.env.DB, c.req.query('months')))
})

// 家底存档：存了就一直留着，可和「现在算出来的」对照（差得多说明老单据被改过）
app.get('/networth-snapshots', async (c) => {
  const db = c.env.DB
  const [saved, live] = await Promise.all([
    db.prepare('SELECT * FROM net_snapshots ORDER BY month DESC LIMIT 36').all().catch(() => ({ results: [] })),
    netSeries(db, 36).catch(() => [])
  ])
  const liveMap = {}
  for (const x of (live || [])) liveMap[x.m] = x
  const rows = (saved.results || []).map((r) => {
    const lv = liveMap[r.month]
    const drift = lv ? round2(num(lv.net) - num(r.net)) : 0
    return { month: r.month, cash: num(r.cash), ar: num(r.ar), ap: num(r.ap), debt: num(r.debt), net: num(r.net),
      note: r.note || '', saved_at: r.created_at, live_net: lv ? num(lv.net) : null, drift }
  })
  for (let i = 0; i < rows.length; i++) {
    const prev = rows[i + 1]
    rows[i].delta = prev ? round2(rows[i].net - prev.net) : null
  }
  const curM = liveMap[now().slice(0, 7)] || null
  const cur = curM ? { month: curM.m, cash: curM.cash, ar: curM.ar, ap: curM.ap, debt: curM.debt, net: curM.net } : null
  const hasThis = rows.some((r) => r.month === now().slice(0, 7))
  const diffs = rows.filter((r) => Math.abs(num(r.drift)) >= 1)
  const advice = []
  if (!rows.length) advice.push('还没存过。每月最后一天会自动存一份，也可以现在手动存。')
  if (!hasThis) advice.push('这个月的家底还没存，点一下「记下这个月的家底」就行。')
  if (diffs.length) advice.push(`有 ${diffs.length} 个月的数和现在算出来的不一样（说明那些老单据后来被改过），已存的存档不会变。`)
  return c.json({ ok: true, rows, current: cur, has_this_month: hasThis, count: rows.length, advice })
})
app.post('/networth-snapshot', async (c) => {
  const b = await c.req.json().catch(() => ({}))
  const r = await snapNet(c.env.DB, b.month || c.req.query('month'), b.note)
  if (r.error) return c.json({ error: r.error }, 400)
  return c.json(r)
})
app.delete('/networth-snapshot/:month', async (c) => {
  const m = String(c.req.param('month') || '').slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(m)) return c.json({ error: '月份格式：YYYY-MM' }, 400)
  await c.env.DB.prepare('DELETE FROM net_snapshots WHERE month=?').bind(m).run()
  return c.json({ ok: true })
})

// 报表抬头（厂名 / 备注）
app.get('/report-head', async (c) => {
  const db = c.env.DB
  const rows = (await db.prepare("SELECT key, value FROM settings WHERE key IN ('report_title','report_note','report_phone','report_addr','report_bank')").all()).results
  const g = (k) => (rows.find((r) => r.key === k) || {}).value || ''
  return c.json({ title: g('report_title'), note: g('report_note'), phone: g('report_phone'), addr: g('report_addr'), bank: g('report_bank') })
})
app.post('/report-head', async (c) => {
  const { title, note, phone, addr, bank } = await c.req.json()
  const db = c.env.DB
  const put = async (k, v) => {
    const has = await db.prepare('SELECT 1 FROM settings WHERE key=?').bind(k).first()
    if (has) await db.prepare('UPDATE settings SET value=? WHERE key=?').bind(v, k).run()
    else await db.prepare('INSERT INTO settings (key, value) VALUES (?,?)').bind(k, v).run()
  }
  await put('report_title', String(title || '').slice(0, 30))
  await put('report_note', String(note || '').slice(0, 60))
  await put('report_phone', String(phone || '').slice(0, 30))
  await put('report_addr', String(addr || '').slice(0, 60))
  await put('report_bank', String(bank || '').slice(0, 60))
  return c.json({ ok: true })
})

// 月度归档：一个月收了多少、花了多少、钱花在哪、月底还剩多少
app.get('/month-report', async (c) => {
  const db = c.env.DB
  let m = String(c.req.query('month') || '').slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(m)) m = now().slice(0, 7)
  const inc = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND ref_type<>'transfer' AND direction='in' AND month=?").bind(m).first()
  const out = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND ref_type<>'transfer' AND direction='out' AND month=?").bind(m).first()
  const oAdd = await db.prepare("SELECT COALESCE(SUM(price),0) t FROM orders WHERE month=?").bind(m).first()
  const pAdd = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM payables WHERE month=?").bind(m).first()
  const cats = (await db.prepare("SELECT COALESCE(NULLIF(category,''),'其他') c, SUM(amount) t FROM ledger WHERE cash=1 AND ref_type<>'transfer' AND direction='out' AND substr(created_at,1,7)=? GROUP BY c ORDER BY t DESC").bind(m).all()).results
  const cash = await cashAtEnd(db, m)
  const ar = await arAtEnd(db, m)
  const ap = await apAtEnd(db, m)
  const head = await db.prepare("SELECT key, value FROM settings WHERE key='report_title'").first()
  const lines = []
  lines.push(`【${(head && head.value) || '加工费记账'}】${m} 月度归档`)
  const _hn = await db.prepare("SELECT value FROM settings WHERE key='report_note'").first()
  if (_hn && _hn.value) lines.push(`（${_hn.value}）`)
  lines.push(`—— 收支 ——`)
  lines.push(`本月收款：¥${round2(num(inc.t))}`)
  lines.push(`本月付款：¥${round2(num(out.t))}`)
  lines.push(`本月结余：¥${round2(num(inc.t) - num(out.t))}`)
  lines.push(`—— 业务 ——`)
  lines.push(`新接单：¥${round2(num(oAdd.t))}`)
  lines.push(`新赊购：¥${round2(num(pAdd.t))}`)
  const pl = await monthPL(db, m)
  lines.push(`材料·外协成本：¥${pl.mat}`)
  lines.push(`净利（权责）：¥${pl.profit}`)
  const rr = await reconRate(db, m)
  lines.push(`—— 对账 ——`)
  lines.push(rr.total ? `应核对 ${rr.total} 家，核对清楚 ${rr.done} 家（${rr.rate}%）` : '本月没有需要对账的单位')
  if (rr.disputed) lines.push(`对方说对不上：${rr.disputed} 家`)
  if (rr.none) lines.push(`还没发过对账单：${rr.none} 家`)
  lines.push(`—— 钱花在哪 ——`)
  if (cats.length) cats.forEach((r) => lines.push(`${r.c}：¥${round2(num(r.t))}`))
  else lines.push('本月无支出')
  lines.push(`—— 月底家底 ——`)
  lines.push(`现金余额：¥${cash}`)
  lines.push(`别人欠我：¥${ar}`)
  lines.push(`我欠别人：¥${ap}`)
  lines.push(`净资产：¥${round2(cash + ar - ap)}`)
  return c.json({
    month: m, cash_in: round2(num(inc.t)), cash_out: round2(num(out.t)), net: round2(num(inc.t) - num(out.t)),
    order_add: round2(num(oAdd.t)), payable_add: round2(num(pAdd.t)), mat_cost: pl.mat, profit: pl.profit, cats: cats.map((r) => ({ c: r.c, t: round2(num(r.t)) })),
    recon: { total: rr.total, done: rr.done, rate: rr.rate, disputed: rr.disputed, none: rr.none },
    cash, ar, ap, net_worth: round2(cash + ar - ap), title: (head && head.value) || '', text: lines.join('\n')
  })
})

// 财务指标
// 客户 / 产品毛利分析（按单填的「材料·外协成本」算真实毛利）
app.get('/margin-by', async (c) => {
  const db = c.env.DB
  const type = String(c.req.query('type') || 'customer') === 'product' ? 'product' : 'customer'
  let from = String(c.req.query('from') || '').slice(0, 10)
  let to = String(c.req.query('to') || '').slice(0, 10)
  const m = String(c.req.query('month') || '').slice(0, 7)
  if (/^\d{4}-\d{2}$/.test(m)) { from = m + '-01'; to = m + '-31' }
  const rows = (await db.prepare("SELECT * FROM orders WHERE (?='' OR substr(created_at,1,10)>=?) AND (?='' OR substr(created_at,1,10)<=?)").bind(from, from, to, to).all()).results
  const key = type === 'customer' ? 'customer' : 'item_name'
  const map = new Map()
  let missing = 0
  for (const r of rows) {
    const k = String(r[key] || (type === 'customer' ? '（没写客户）' : '（没写产品）'))
    const g = map.get(k) || { name: k, cnt: 0, revenue: 0, cost: 0, profit: 0, unpaid: 0, no_cost: 0 }
    g.cnt += 1
    g.revenue = round2(g.revenue + num(r.price))
    g.cost = round2(g.cost + num(r.cost))
    g.profit = round2(g.revenue - g.cost)
    g.unpaid = round2(g.unpaid + Math.max(0, num(r.price) - num(r.paid) - num(r.written_off)))
    if (!num(r.cost)) { g.no_cost += 1; missing += 1 }
    map.set(k, g)
  }
  const list = Array.from(map.values())
    .map((g) => ({ ...g, margin_pct: g.revenue > 0 ? round2((g.profit / g.revenue) * 100) : 0 }))
    .sort((a, b) => b.profit - a.profit)
  const revenue = round2(list.reduce((a, x) => a + x.revenue, 0))
  const cost = round2(list.reduce((a, x) => a + x.cost, 0))
  const profit = round2(revenue - cost)
  return c.json({
    type, from, to, month: m || '', count: rows.length,
    revenue, cost, profit, margin_pct: revenue > 0 ? round2((profit / revenue) * 100) : 0,
    missing_cost: missing,
    hint: missing > 0 ? `有 ${missing} 张单没填「材料·外协成本」，这些单的毛利会偏高（按 0 成本算）` : '',
    list: list.slice(0, 50),
    worst: list.filter((x) => x.cnt > 0).slice(-3).reverse()
  })
})

app.get('/kpi', async (c) => {
  const db = c.env.DB
  let m = String(c.req.query('month') || '').slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(m)) m = now().slice(0, 7)
  const mons = monthList(6)
  const from6 = mons[0]
  const from3 = monthList(3)[0]
  // 性能：原来 40 多次查询一条条排队（7.6 秒），现在 1 条聚合 + 5 条分组并发（约 0.9 秒）
  const aggSql = `SELECT
    (SELECT COALESCE(SUM(price),0) FROM orders WHERE month=?) AS o_add,
    (SELECT COALESCE(SUM(amount),0) FROM payables WHERE month=?) AS p_add,
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE ${CASH_EXP_WHERE} AND month=?) AS cash_cost,
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE cash=1 AND ref_type<>'transfer' AND direction='in' AND month=?) AS cash_in,
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE cash=1 AND ref_type<>'transfer' AND direction='in' AND month<=? AND month>=?) AS in3,
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE cash=1 AND ref_type<>'transfer' AND direction='out' AND substr(created_at,1,7)<=? AND substr(created_at,1,7)>=?) AS out3,
    (SELECT COALESCE(SUM(amount),0) FROM fixed_expenses) AS fixed_rows,
    (SELECT COALESCE(SUM(price - paid - COALESCE(written_off,0)),0) FROM orders WHERE paid + COALESCE(written_off,0) < price) AS ar_open,
    (SELECT COALESCE(SUM(amount - paid - COALESCE(written_off,0)),0) FROM payables WHERE paid + COALESCE(written_off,0) < amount) AS ap_open,
    (SELECT COALESCE(SUM(principal),0) FROM debts WHERE status='open') AS debt_open,
    (SELECT COALESCE(SUM(amount),0) FROM debt_repays WHERE kind='principal') AS debt_repaid,
    (SELECT COALESCE(SUM(price - COALESCE(written_off,0)),0) FROM orders WHERE month<=?) AS ar_end_a,
    (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE direction='in' AND ref_type='order' AND substr(created_at,1,7)<=?) AS ar_end_b,
    (SELECT COALESCE(SUM(CASE WHEN ref_type='amort' THEN amount ELSE 0 END),0) FROM ledger WHERE ref_type='amort' AND substr(created_at,1,7)=?) AS am,
    (SELECT COALESCE(SUM(CASE WHEN ref_type='debt_int' THEN amount ELSE 0 END),0) FROM ledger WHERE ref_type='debt_int' AND substr(created_at,1,7)=?) AS ac,
    (SELECT COALESCE(SUM(CASE WHEN ref_type='dep' THEN amount ELSE 0 END),0) FROM ledger WHERE ref_type='dep' AND month=?) AS dp,
    (SELECT COALESCE(SUM(COALESCE(cost,0)),0) FROM orders WHERE month=?) AS order_cost`
  const jobs = [
    db.prepare(aggSql).bind(m, m, m, m, m, from3, m, from3, m, m, m, m, m, m).first(),
    db.prepare("SELECT month mk, COALESCE(SUM(price),0) t, COALESCE(SUM(COALESCE(cost,0)),0) c2 FROM orders WHERE month>=? GROUP BY mk").bind(from6).all(),
    db.prepare("SELECT month mk, COALESCE(SUM(amount),0) t FROM payables WHERE month>=? GROUP BY mk").bind(from6).all(),
    db.prepare(`SELECT substr(created_at,1,7) mk, COALESCE(SUM(CASE WHEN ${CASH_EXP_WHERE} THEN amount ELSE 0 END),0) c, COALESCE(SUM(CASE WHEN ref_type IN ('amort','debt_int','dep') THEN amount ELSE 0 END),0) ad FROM ledger WHERE month>=? GROUP BY mk`).bind(from6).all(),
    db.prepare("SELECT o.id, o.created_at, MAX(l.created_at) last_pay FROM orders o JOIN ledger l ON l.ref_type='order' AND l.ref_id=o.id AND l.direction='in' WHERE o.paid >= o.price GROUP BY o.id").all(),
    db.prepare("SELECT o.customer c, SUM(l.amount) t FROM ledger l JOIN orders o ON l.ref_id=o.id WHERE l.direction='in' AND l.ref_type='order' AND substr(l.created_at,1,7)=? GROUP BY o.customer ORDER BY t DESC").bind(m).all(),
    accountBalances(db)
  ].map((x) => x.catch((e) => { noteFail(e); return null }))
  const [aggR, oTR, pTR, lTR, paidR, byCustR, accs] = await Promise.all(jobs)
  const agg = aggR || {}
  const rowsOf = (r) => (r && r.results) || []
  const oMap = {}, pMap = {}, lMap = {}
  const cMap = {}
  for (const x of rowsOf(oTR)) { oMap[x.mk] = num(x.t); cMap[x.mk] = num(x.c2) }
  for (const x of rowsOf(pTR)) pMap[x.mk] = num(x.t)
  for (const x of rowsOf(lTR)) lMap[x.mk] = { c: num(x.c), ad: num(x.ad) }
  const oAdd = num(agg.o_add)
  const pAdd = num(agg.p_add)
  const cashCost = num(agg.cash_cost)
  const cashIn = num(agg.cash_in)
  const adj = { amort: round2(num(agg.am)), accrue_int: round2(num(agg.ac)), dep: round2(num(agg.dp)) }
  adj.net = round2(adj.amort + adj.accrue_int + adj.dep)
  const costTotal = round2(cashCost + adj.net)
  const matCost = num(agg.order_cost)
  const profit = round2(oAdd - matCost - costTotal)
  const margin = oAdd > 0 ? round2((profit / oAdd) * 100) : 0
  const expenseRatio = oAdd > 0 ? round2((costTotal / oAdd) * 100) : 0
  const fixedTotal = round2(num(adj.amort) + num(adj.dep) + num(adj.accrue_int))
  const fixedRows = num(agg.fixed_rows)
  const breakEven = margin > 0 ? round2((fixedTotal + fixedRows) / (margin / 100)) : 0
  const trend = []
  for (const mm of mons) {
    const oo = num(oMap[mm]), pp = num(pMap[mm])
    const lx = lMap[mm] || { c: 0, ad: 0 }
    const pf = round2(oo - num(cMap[mm]) - lx.c - lx.ad)
    trend.push({ m: mm, order_add: round2(oo), cost: round2(lx.c + lx.ad), profit: pf, margin: oo > 0 ? round2((pf / oo) * 100) : 0 })
  }
  const accList = (accs && accs.length !== undefined) ? accs : []
  const cashNow = round2(accList.reduce((s, a) => s + num(a.balance), 0))
  const arOpen = num(agg.ar_open)
  const apOpen = num(agg.ap_open)
  const debtOpen = num(agg.debt_open)
  const debtRepaid = num(agg.debt_repaid)
  const nw = round2(cashNow + arOpen - apOpen - Math.max(debtOpen - debtRepaid, 0))
  const paidOrders = rowsOf(paidR)
  let sumD = 0, cntD = 0
  for (const o of paidOrders) {
    const a = Date.parse(o.created_at || ''); const b = Date.parse(o.last_pay || '')
    if (a && b && b >= a) { sumD += (b - a) / 86400000; cntD++ }
  }
  const avg_days = cntD ? round2(sumD / cntD) : 0
  const in3 = num(agg.in3)
  const ar = round2(Math.max(num(agg.ar_end_a) - num(agg.ar_end_b), 0))
  const turnDays = in3 > 0 ? round2((ar / (in3 / 3)) * 30) : 0
  const out3 = num(agg.out3)
  const cushion = out3 > 0 ? round2(cashNow / (out3 / 3)) : 0
  const byCust = rowsOf(byCustR)
  const topCust = byCust.length ? byCust[0] : null
  const conc = cashIn > 0 && topCust ? round2((num(topCust.t) / cashIn) * 100) : 0
  return c.json({
    month: m, order_add: round2(oAdd), payable_add: round2(pAdd), mat_cost: round2(matCost), cash_cost: round2(cashCost), profit, margin,
    avg_days, ar_end: ar, turn_days: turnDays, cash_now: cashNow, cushion_months: cushion,
    top_customer: topCust ? topCust.c : '', conc_pct: conc,
    cost_total: costTotal, expense_ratio: expenseRatio, break_even: breakEven,
    amort: adj.amort, dep: adj.dep, accrue_int: adj.accrue_int, net_worth: nw, trend
  })
})

// 保本线：固定开销（房租工资水电这些每月必花的）+ 变动成本率 → 这个月最少要收多少才不亏
app.get('/break-even', async (c) => {
  const db = c.env.DB
  const m = c.req.query('month') || now().slice(0, 7)
  const ms = monthList(3)
  const from = ms[0], to = ms[ms.length - 1]
  const rows = (await db.prepare("SELECT COALESCE(NULLIF(category,''),'其他') AS cat, COALESCE(SUM(amount),0) AS amt FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND substr(created_at,1,7)>=? AND substr(created_at,1,7)<=? GROUP BY cat").bind(from, to).all()).results || []
  const VAR = ['采购', '辅料', '运费']
  let fixedSum = 0, varSum = 0
  const items = []
  for (const r of rows) {
    const a = round2(num(r.amt))
    if (VAR.indexOf(r.cat) >= 0) { varSum = round2(varSum + a); items.push({ name: r.cat, amount: a, kind: '变动' }) }
    else { fixedSum = round2(fixedSum + a); items.push({ name: r.cat, amount: a, kind: '固定' }) }
  }
  const fx = await db.prepare('SELECT COALESCE(SUM(amount),0) AS a FROM fixed_expenses').first()
  const fixedPlan = round2(num(fx && fx.a))
  const add3 = round2(num((await db.prepare('SELECT COALESCE(SUM(price),0) AS a FROM orders WHERE month>=? AND month<=?').bind(from, to).first()).a))
  const fixedAvg = round2(fixedSum / 3)
  const varRatio = add3 > 0 ? Math.min(0.95, varSum / add3) : 0
  const gm = Math.max(0.05, 1 - varRatio)
  const breakEven = fixedAvg > 0 ? Math.round(fixedAvg / gm) : 0
  const curAdd = round2(num((await db.prepare('SELECT COALESCE(SUM(price),0) AS a FROM orders WHERE month=?').bind(m).first()).a))
  const curOut = round2(num((await db.prepare("SELECT COALESCE(SUM(amount),0) AS a FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND substr(created_at,1,7)=?").bind(m).first()).a))
  return c.json({
    ok: true, month: m, fixed_avg: fixedAvg, fixed_plan: fixedPlan, var_sum: varSum, order_add_3m: add3,
    var_ratio: Math.round(varRatio * 1000) / 10, gross_margin: Math.round(gm * 1000) / 10,
    break_even: breakEven, month_order_add: curAdd, month_out: curOut, gap: round2(breakEven - curAdd),
    items: items.sort((a, b) => b.amount - a.amount),
    note: breakEven > 0
      ? (curAdd >= breakEven ? '这个月接单 ' + curAdd + ' 元，已经过了保本线（' + breakEven + ' 元），超 ' + round2(curAdd - breakEven) + ' 元。' : '这个月接单 ' + curAdd + ' 元，离保本线还差 ' + round2(breakEven - curAdd) + ' 元才不亏。')
      : '还没有支出数据，先记几笔房租、工资，系统就能算出这个月最少要收多少才不亏。'
  })
})

// ── 第三档：发票台账 / 固定资产折旧 / 银行流水对账 / 提醒汇总 ──
// 发票台账
app.get('/invoices', async (c) => {
  const db = c.env.DB
  const type = c.req.query('type')
  const month = c.req.query('month') || now().slice(0, 7)
  const kw = String(c.req.query('kw') || '').trim()
  let sql = 'SELECT * FROM invoices WHERE 1=1'
  const b = []
  if (type === 'out' || type === 'in') { sql += ' AND type=?'; b.push(type) }
  if (kw) { sql += ' AND (no LIKE ? OR party LIKE ? OR remark LIKE ?)'; b.push('%' + kw + '%', '%' + kw + '%', '%' + kw + '%') }
  sql += ' ORDER BY date DESC, id DESC LIMIT 200'
  const rows = (await db.prepare(sql).bind(...b).all()).results
  const sumOf = async (t) => {
    const r = await db.prepare("SELECT COALESCE(SUM(amount),0) a, COALESCE(SUM(tax),0) tx, COUNT(*) n FROM invoices WHERE type=? AND substr(date,1,7)=?").bind(t, month).first()
    return { amount: round2(num(r.a)), tax: round2(num(r.tx)), count: num(r.n) }
  }
  const unin = await db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(todo),0) t FROM (
    SELECT MIN(COALESCE(o.paid,0), COALESCE(o.price,0)) - COALESCE((SELECT SUM(i.amount) FROM invoices i WHERE i.type='out' AND i.order_id=o.id),0) AS todo
    FROM orders o WHERE COALESCE(o.paid,0) > 0 AND COALESCE(o.no_invoice,0)=0) WHERE todo > 0.005`).first()
  return c.json({
    month, rows,
    summary: { out: await sumOf('out'), in: await sumOf('in') },
    uninvoiced: { count: num(unin.n), amount: round2(num(unin.t)) }
  })
})

// 发票与收款对照：钱收了票没开、票开了钱没到，一页看清
app.get('/invoice-check', async (c) => {
  const db = c.env.DB
  const month = String(c.req.query('month') || now().slice(0, 7)).slice(0, 7)
  const title = await getTitle(db)
  const orders = ((await db.prepare(`SELECT id, customer, COALESCE(NULLIF(item_name,''),'加工费') AS item, price, paid, COALESCE(written_off,0) AS wo, created_at, due_date
    FROM orders WHERE month=? ORDER BY id DESC LIMIT 300`).bind(month).all()).results || [])
  const invs = ((await db.prepare(`SELECT id, no, party, amount, COALESCE(tax,0) AS tax, date, order_id FROM invoices
    WHERE type='out' AND substr(date,1,7)=? ORDER BY id DESC LIMIT 300`).bind(month).all()).results || [])
  const invByOrder = {}
  const invAll = ((await db.prepare("SELECT order_id, COALESCE(SUM(amount),0) a, COALESCE(SUM(tax),0) t FROM invoices WHERE type='out' AND order_id IS NOT NULL AND order_id>0 GROUP BY order_id").all()).results || [])
  for (const r of invAll) invByOrder[num(r.order_id)] = { amount: round2(num(r.a)), tax: round2(num(r.t)) }

  const rows = []
  for (const o of orders) {
    const price = round2(num(o.price))
    const paid = round2(num(o.paid))
    const left = round2(price - paid - round2(num(o.wo)))
    const inv = invByOrder[num(o.id)] || { amount: 0, tax: 0 }
    const state = inv.amount <= 0 ? 'none' : (inv.amount + 0.001 < price ? 'partial' : 'full')
    rows.push({
      id: num(o.id), party: o.customer, item: o.item, price, paid, left,
      inv_amount: inv.amount, inv_tax: inv.tax, inv_left: round2(price - inv.amount), state,
      date: String(o.created_at || '').slice(0, 10), due_date: String(o.due_date || '').slice(0, 10)
    })
  }
  const noInv = rows.filter((r) => r.paid > 0 && r.inv_amount <= 0)
  const partInv = rows.filter((r) => r.inv_amount > 0 && r.inv_amount + 0.001 < r.price)
  const invNoMoney = rows.filter((r) => r.inv_amount > r.paid + 0.001)
  const paidSum = round2(rows.reduce((a, r) => a + r.paid, 0))
  const orderSum = round2(rows.reduce((a, r) => a + r.price, 0))
  const invSum = round2(invs.reduce((a, r) => a + round2(num(r.amount)), 0))
  const taxSum = round2(invs.reduce((a, r) => a + round2(num(r.tax)), 0))
  const gap = round2(paidSum - invSum)
  const lines = [
    `【${title.title}】${month} 发票与收款对照`,
    `本月接单 ${orderSum} 元，收到 ${paidSum} 元，开票 ${invSum} 元${taxSum > 0 ? `（其中税额 ${taxSum} 元）` : ''}，开票 ${invs.length} 张`,
    `差额：${gap === 0 ? '收的钱和开的票对得上 ✓' : gap > 0 ? `还有 ${gap} 元收了没开票` : `多开了 ${Math.abs(gap)} 元票（钱还没到账）`}`,
    noInv.length ? `· 收了钱没开票 ${noInv.length} 笔：${noInv.slice(0, 5).map((x) => `${x.party} ${x.paid}`).join('、')}${noInv.length > 5 ? ' 等' : ''}` : '· 没有「收了钱没开票」的单',
    partInv.length ? `· 开了部分票 ${partInv.length} 笔：${partInv.slice(0, 3).map((x) => `${x.party} 已开 ${x.inv_amount}/共 ${x.price}`).join('、')}` : '',
    invNoMoney.length ? `· 开了票钱没到 ${invNoMoney.length} 笔：${invNoMoney.slice(0, 3).map((x) => `${x.party} 票 ${x.inv_amount}/已收 ${x.paid}`).join('、')}` : ''
  ].filter((x) => x)
  return c.json({
    ok: true, month, rows,
    order_sum: orderSum, paid_sum: paidSum, inv_sum: invSum, tax_sum: taxSum, inv_count: invs.length, gap,
    no_invoice: { count: noInv.length, amount: round2(noInv.reduce((a, x) => a + x.paid, 0)), list: noInv.slice(0, 20) },
    part_invoice: { count: partInv.length, amount: round2(partInv.reduce((a, x) => a + x.inv_left, 0)), list: partInv.slice(0, 20) },
    inv_no_money: { count: invNoMoney.length, amount: round2(invNoMoney.reduce((a, x) => a + (x.inv_amount - x.paid), 0)), list: invNoMoney.slice(0, 20) },
    invoices: invs.slice(0, 50),
    text: lines.join('\n'),
    advice: gap === 0 && !noInv.length && !invNoMoney.length
      ? '这个月收款和开票对得上，没有遗留。'
      : (noInv.length ? `有 ${noInv.length} 笔收了钱没开票（共 ${round2(noInv.reduce((a, x) => a + x.paid, 0))} 元），对方要票就得补开。` : `有 ${invNoMoney.length} 笔开了票但钱没到账，记得催。`)
  })
})

// ===== 待开票清单：哪一笔收了钱还没开票，一键开 =====
// 口径：待开 = min(已收, 单据金额) − 这张单已开票金额；客户说不要票的（no_invoice=1）不进清单
app.get('/invoice-todo', async (c) => {
  const db = c.env.DB
  const rate = Math.max(0, Math.min(0.3, num(c.req.query('rate')) || 0.13))
  const party = String(c.req.query('party') || '').trim()
  const sql = `SELECT o.id, o.customer AS party, COALESCE(NULLIF(o.item_name,''),'加工费') AS item,
      COALESCE(o.price,0) AS price, COALESCE(o.paid,0) AS paid, COALESCE(o.written_off,0) AS wo,
      o.created_at, o.due_date,
      COALESCE((SELECT SUM(i.amount) FROM invoices i WHERE i.type='out' AND i.order_id=o.id),0) AS invoiced
    FROM orders o
    WHERE COALESCE(o.paid,0) > 0 AND COALESCE(o.no_invoice,0)=0` + (party ? ' AND o.customer=?' : '') +
    ` ORDER BY o.created_at ASC, o.id ASC LIMIT 500`
  const raw = (await db.prepare(sql).bind(...(party ? [party] : [])).all()).results || []
  const rows = []
  for (const o of raw) {
    const paid = round2(num(o.paid))
    const price = round2(num(o.price))
    const todo = round2(Math.min(paid, price) - num(o.invoiced))
    if (todo <= 0.005) continue
    const tax = round2(todo * rate / (1 + rate))
    rows.push({
      order_id: num(o.id), party: o.party, item: o.item, date: String(o.created_at || '').slice(0, 10),
      price, paid, invoiced: round2(num(o.invoiced)), todo, rate, tax, net: round2(todo - tax),
      days: daysSince(String(o.created_at || '').slice(0, 10)),
      text: `${o.party}：${o.item} 已收 ${paid} 元，还没开票，开票金额 ${todo} 元（税率 ${Math.round(rate * 100)}%，税额 ${tax} 元）。`
    })
  }
  const total = round2(rows.reduce((a, x) => a + x.todo, 0))
  const taxTotal = round2(rows.reduce((a, x) => a + x.tax, 0))
  const byParty = {}
  for (const r of rows) {
    const k = r.party
    if (!byParty[k]) byParty[k] = { party: k, todo: 0, cnt: 0, tax: 0 }
    byParty[k].todo = round2(byParty[k].todo + r.todo)
    byParty[k].tax = round2(byParty[k].tax + r.tax)
    byParty[k].cnt++
  }
  const parties = Object.values(byParty).sort((a, b) => b.todo - a.todo)
  const skipped = await db.prepare("SELECT COUNT(*) n, COALESCE(SUM(COALESCE(paid,0)),0) t FROM orders WHERE COALESCE(no_invoice,0)=1").first().catch(() => null)
  const text = rows.length
    ? `还有 ${rows.length} 笔收了钱没开票，共 ${total} 元（税约 ${taxTotal} 元，涉及 ${parties.length} 家）。`
    : '收了钱的单子都开过票了，没有要补的。'
  return c.json({
    ok: true, rate, count: rows.length, total, tax_total: taxTotal, net_total: round2(total - taxTotal),
    parties, rows: rows.slice(0, 200), text,
    skipped: { count: num(skipped && skipped.n), amount: round2(num(skipped && skipped.t)) },
    all_text: rows.length ? rows.map((r) => r.text).join('\n') : ''
  })
})

// 按单据开一张票（金额默认=待开金额）
app.post('/invoice-from-order', async (c) => {
  const body = await c.req.json()
  const db = c.env.DB
  const oid = num(body.order_id)
  if (!oid) return c.json({ error: '要指定哪一张单' }, 400)
  const o = await db.prepare('SELECT * FROM orders WHERE id=?').bind(oid).first()
  if (!o) return c.json({ error: '这张单不存在' }, 404)
  if (await isMonthLocked(db, (o.created_at || '').slice(0, 7))) return c.json({ error: '这张单所在月份已结账锁定' }, 403)
  const rate = Math.max(0, Math.min(0.3, body.rate === undefined ? 0.13 : num(body.rate)))
  const invoiced = round2(num((await db.prepare("SELECT COALESCE(SUM(amount),0) a FROM invoices WHERE type='out' AND order_id=?").bind(oid).first()).a))
  const maxTodo = round2(Math.min(num(o.paid), num(o.price)) - invoiced)
  const amount = body.amount === undefined ? maxTodo : round2(num(body.amount))
  if (amount <= 0) return c.json({ error: '金额得大于 0' }, 400)
  if (amount > maxTodo + 0.005) return c.json({ error: `这张单最多还能开 ${maxTodo} 元（已收 ${round2(num(o.paid))}、已开 ${invoiced}）` }, 400)
  const tax = body.tax === undefined ? round2(amount * rate / (1 + rate)) : round2(num(body.tax))
  const d = toIsoDate(body.date) || now().slice(0, 10)
  const no = String(body.no || '').trim()
  await db.prepare('INSERT INTO invoices (type, no, party, amount, tax, date, remark, order_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind('out', no, o.customer, amount, tax, d, `按单据开票（${o.item_name || '加工费'} ${String(o.created_at || '').slice(0, 10)}）`, oid, now()).run()
  await logAudit(db, '开发票', o.customer, `${o.customer} ¥${amount}（税率 ${Math.round(rate * 100)}%，税额 ${tax}）`)
  return c.json({ ok: true, amount, tax, net: round2(amount - tax), left: round2(maxTodo - amount), text: `已记：${o.customer} 开票 ${amount} 元，税额 ${tax} 元。` })
})

// 客户说不要票：标一下，别一直挂在待开清单里
app.post('/invoice-skip', async (c) => {
  const body = await c.req.json()
  const db = c.env.DB
  const oid = num(body.order_id)
  if (!oid) return c.json({ error: '要指定哪一张单' }, 400)
  const o = await db.prepare('SELECT * FROM orders WHERE id=?').bind(oid).first()
  if (!o) return c.json({ error: '这张单不存在' }, 404)
  const skip = body.skip === false ? 0 : 1
  await db.prepare('UPDATE orders SET no_invoice=? WHERE id=?').bind(skip, oid).run()
  await logAudit(db, skip ? '标记不要票' : '取消不要票', o.customer, `${o.customer} ${o.item_name || '加工费'}`)
  return c.json({ ok: true, no_invoice: skip, text: skip ? '记下了：这家不要票，不再提醒。' : '已取消标记，会重新进待开票清单。' })
})

app.post('/invoices', async (c) => {
  const { type, no, party, amount, tax, date, remark, order_id } = await c.req.json()
  const t = type === 'in' ? 'in' : 'out'
  const pt = String(party || '').trim()
  if (!pt) return c.json({ error: t === 'out' ? '客户名称必填' : '供应商名称必填' }, 400)
  if (num(amount) <= 0) return c.json({ error: '金额必须大于 0' }, 400)
  const db = c.env.DB
  const d = toIsoDate(date) || now().slice(0, 10)
  await db.prepare('INSERT INTO invoices (type, no, party, amount, tax, date, remark, order_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(t, String(no || '').trim(), pt, num(amount), num(tax), d, String(remark || ''), num(order_id) || 0, now()).run()
  await logAudit(db, t === 'out' ? '开发票' : '收发票', pt, `${pt} ¥${num(amount)}`)
  return c.json({ ok: true })
})

app.patch('/invoices/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const db = c.env.DB
  const iv = await db.prepare('SELECT * FROM invoices WHERE id=?').bind(id).first()
  if (!iv) return c.json({ error: '发票不存在' }, 404)
  await db.prepare('UPDATE invoices SET no=?, party=?, amount=?, tax=?, date=?, remark=? WHERE id=?')
    .bind(body.no !== undefined ? String(body.no) : iv.no,
      body.party !== undefined ? String(body.party).trim() || iv.party : iv.party,
      body.amount !== undefined ? num(body.amount) : num(iv.amount),
      body.tax !== undefined ? num(body.tax) : num(iv.tax),
      body.date !== undefined ? (toIsoDate(body.date) || iv.date) : iv.date,
      body.remark !== undefined ? String(body.remark) : iv.remark, id).run()
  return c.json({ ok: true })
})

app.delete('/invoices/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const iv = await db.prepare('SELECT * FROM invoices WHERE id=?').bind(id).first()
  if (!iv) return c.json({ error: '发票不存在' }, 404)
  await db.prepare('DELETE FROM invoices WHERE id=?').bind(id).run()
  await logAudit(db, '删发票', iv.party, `${iv.party} ¥${iv.amount}`)
  return c.json({ ok: true })
})

// 固定资产（直线法折旧）
const assetCalc = (a) => {
  const cost = num(a.cost)
  const life = Math.max(num(a.life_years) || 5, 0.5)
  const residual = round2(cost * (num(a.residual_rate) / 100))
  const monthly = round2((cost - residual) / (life * 12))
  const buyM = String(a.buy_date || now()).slice(0, 7)
  const dispoM = String(a.disposed_at || '').slice(0, 7)
  // 卖掉的设备：折旧只算到卖掉那个月为止，净值就是卖的时候的账面
  const curM = dispoM && dispoM < now().slice(0, 7) ? dispoM : now().slice(0, 7)
  const mGap = (Number(curM.slice(0, 4)) - Number(buyM.slice(0, 4))) * 12 + (Number(curM.slice(5, 7)) - Number(buyM.slice(5, 7)))
  const months = buyM > curM ? 0 : Math.max(0, mGap + 1)
  const cap = Math.round(life * 12)
  const usedMonths = Math.min(months, cap)
  const depCap = round2(cost - residual)
  const acc = round2(Math.min(monthly * usedMonths, depCap))
  const net = round2(cost - acc)
  const disposed = !!a.disposed_at
  const sell = disposed ? round2(num(a.dispose_amount)) : null
  return {
    id: a.id, name: a.name, cost: round2(cost), buy_date: a.buy_date, life_years: life,
    residual_rate: num(a.residual_rate), monthly, residual, acc_dep: acc,
    net, used_months: usedMonths, remain_months: Math.max(cap - usedMonths, 0),
    done: acc >= depCap - 0.01,
    disposed, disposed_at: a.disposed_at || '', dispose_amount: sell,
    maint_months: num(a.maint_months), maint_last: a.maint_last || '',
    gain: disposed ? round2(sell - net) : null
  }
}

app.get('/assets', async (c) => {
  const db = c.env.DB
  const rows = (await db.prepare('SELECT * FROM assets ORDER BY id DESC').all()).results
  const list = rows.map(assetCalc)
  const live = list.filter((a) => !a.disposed)
  const sold = list.filter((a) => a.disposed)
  return c.json({
    rows: list,
    live_count: live.length,
    sold_count: sold.length,
    total_cost: round2(live.reduce((s, a) => s + a.cost, 0)),
    total_monthly: round2(live.filter((a) => !a.done).reduce((s, a) => s + a.monthly, 0)),
    total_net: round2(live.reduce((s, a) => s + a.net, 0)),
    sold_gain: round2(sold.reduce((s, a) => s + num(a.gain), 0)),
    sold_amount: round2(sold.reduce((s, a) => s + num(a.dispose_amount), 0))
  })
})

app.post('/assets', async (c) => {
  const { name, cost, buy_date, life_years, residual_rate, maint_months, maint_last } = await c.req.json()
  const nm = String(name || '').trim()
  if (!nm) return c.json({ error: '设备名称必填' }, 400)
  if (num(cost) <= 0) return c.json({ error: '原值必须大于 0' }, 400)
  const db = c.env.DB
  await db.prepare('INSERT INTO assets (name, cost, buy_date, life_years, residual_rate, maint_months, maint_last, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(nm, num(cost), toIsoDate(buy_date) || now().slice(0, 10), num(life_years) || 5,
      residual_rate === undefined ? 5 : num(residual_rate),
      Math.max(0, Math.round(num(maint_months))), toIsoDate(maint_last) || null, now()).run()
  await logAudit(db, '新增固定资产', nm, `${nm} 原值 ¥${num(cost)}`)
  return c.json({ ok: true })
})

app.delete('/assets/:id', async (c) => {
  const id = c.req.param('id')
  await c.env.DB.prepare('DELETE FROM assets WHERE id=?').bind(id).run()
  return c.json({ ok: true })
})

// 按月自动折旧：每台设备每月一条（cash=0，不动现金，只进成本），当月已提过就跳过
// 给一台设备补提折旧（从购入当月提 toM 为止），返回这轮提了多少
const bookDepOne = async (db, a, toM) => {
  const v = assetCalc(a)
  if (!(v.monthly > 0)) return { added: 0, amount: 0 }
  const buyM = String(a.buy_date || now()).slice(0, 7)
  if (buyM > toM) return { added: 0, amount: 0 }
  const depCap = round2(v.cost - v.residual)
  const prev = num((await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE ref_type='dep' AND ref_id=?").bind(a.id).first()).t)
  let booked = prev
  let added = 0, amount = 0
  for (let k = 0; k < Math.round(v.life_years * 12); k += 1) {
    const mm = monthOf(monthAdd(buyM + '-01', k))
    if (mm > toM) break
    if (booked >= depCap - 0.01) break
    const has = await db.prepare("SELECT id FROM ledger WHERE ref_type='dep' AND ref_id=? AND month=?").bind(a.id, mm).first()
    if (has) continue
    const amt = round2(Math.min(v.monthly, depCap - booked))
    if (!(amt > 0)) break
    await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('out','dep',?,?,?,?,?,0,?)")
      .bind(a.id, amt, '折旧', '折旧：' + (a.name || '') + '（' + mm + '）', 0, mm + '-28').run()
    booked = round2(booked + amt)
    added += 1
    amount = round2(amount + amt)
  }
  return { added, amount }
}
// 按月自动折旧：每台设备每月一条（cash=0，不动现金，只进成本），当月已提过就跳过
const runDepreciation = async (db) => {
  const m = now().slice(0, 7)
  const rows = (await db.prepare('SELECT * FROM assets').all()).results
  let added = 0
  let amount = 0
  for (const a of rows) {
    if (a.disposed_at) continue // 卖掉的设备不再计提折旧
    const r = await bookDepOne(db, a, m)
    added += r.added
    amount = round2(amount + r.amount)
  }
  return { added, amount }
}

app.post('/assets/:id/dispose', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const b = await c.req.json().catch(() => ({}))
  const a = await db.prepare('SELECT * FROM assets WHERE id=?').bind(id).first()
  if (!a) return c.json({ error: '这台设备没找到（可能已经删了）' }, 404)
  if (a.disposed_at) return c.json({ error: `这台已经在 ${String(a.disposed_at).slice(0, 10)} 处置过了` }, 400)
  const amount = round2(num(b.amount))
  if (!(amount >= 0)) return c.json({ error: '卖了多少钱要填（报废就填 0）' }, 400)
  const date = toIsoDate(b.date) || now().slice(0, 10)
  const m = date.slice(0, 7)
  if (await isMonthLocked(db, m)) return c.json({ error: `${m} 已结账锁定，先解锁再记处置` }, 403)
  // 处置当月的折旧先提足（卖的那个月也要提），算出来的账面才是真的
  await bookDepOne(db, a, m)
  const v = assetCalc({ ...a, disposed_at: date })
  const book = v.net
  const gain = round2(amount - book)
  const acc = num(b.account_id) || (await defaultAccountId(db))
  const remark = `卖设备：${a.name}（原值 ${v.cost}，账面 ${book}，卖 ${amount}${gain >= 0 ? '，赚 ' : '，亏 '}${Math.abs(gain)}）`
  const st = []
  if (amount > 0) {
    st.push(db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('in','dispose',?,?,?,?,?,1,?)")
      .bind(a.id, amount, '处置设备', String(b.remark || remark), acc, date))
  }
  st.push(db.prepare('UPDATE assets SET disposed_at=?, dispose_amount=? WHERE id=?').bind(date, amount, a.id))
  await db.batch(st)
  await logAudit(db, '设备处置', a.name, `${a.name} 卖 ¥${amount}，账面 ¥${book}，${gain >= 0 ? '赚' : '亏'} ¥${Math.abs(gain)}`, `asset:${a.id}`)
  return c.json({ ok: true, id: num(id), date, amount, book, gain, account_id: acc, note: `账面 ${book}，卖 ${amount}，${gain >= 0 ? '赚' : '亏'} ${Math.abs(gain)} 元` })
})

app.post('/assets/run-depreciation', async (c) => {
  const db = c.env.DB
  const r = await runDepreciation(db)
  if (r.added) await logAudit(db, '计提折旧', '固定资产', `${r.added} 项 共 ¥${r.amount}`)
  return c.json({ ok: true, added: r.added, amount: r.amount, note: r.added ? '已计提本月折旧' : '本月折旧都提过了' })
})

// 银行流水对账
const parseBankText = (text) => {
  const out = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const cells = line.split(/[,\t，\s]+/).filter((x) => x !== '')
    if (cells.length < 2) continue
    if (/日期|金额|摘要|借方|贷方/.test(line) && !/\d{1,2}[-/.]\d{1,2}/.test(line)) continue
    let date = toIsoDate(cells[0]) || now().slice(0, 10)
    let rest = cells.slice(1)
    let dir = 'in'
    const d0 = rest[0] || ''
    if (/^(付|支出|借|借debit|-|付款|转出)/i.test(d0)) { dir = 'out'; rest = rest.slice(1) }
    else if (/^(收|收入|贷|贷方|\+|收款|转入)/i.test(d0)) { dir = 'in'; rest = rest.slice(1) }
    let amount = num(rest[0])
    if (!amount) {
      const found = rest.map((x) => num(x)).filter((x) => x > 0)
      amount = found.length ? found[0] : 0
      rest = rest.slice(1)
    }
    if (amount <= 0) continue
    if (amount < 0) { amount = -amount; dir = 'out' }
    else if (String(rest[0] || '').trim().startsWith('-')) { dir = 'out' }
    const memo = rest.slice(1).join(' ').trim()
    out.push({ date: String(date || '').slice(0, 10), direction: dir, amount: round2(amount), memo })
  }
  return out
}

// 微信/支付宝/银行导出的账单格式各不相同，先认表头再按列取数
const BK_COL = {
  date: /^(交易时间|交易日期|日期|时间|记账日期|入账日期)/,
  dir: /^(收\/支|收支|收付|借贷标志|交易类型|类型)$/,
  amount: /^(金额\(元\)|金额|交易金额|发生额)/,
  debit: /^(借方金额|支出金额|付款金额|借方发生额)/,
  credit: /^(贷方金额|收入金额|收款金额|贷方发生额)/,
  memo: /(摘要|商品|交易对方|对方|备注|说明|用途|商户)/
}
function bkCell(x) { return String(x == null ? '' : x).replace(/^["'\s]+|["'\s]+$/g, '').replace(/¥|￥|元/g, '').replace(/,/g, '') }
function bkAmount(x) {
  const v = Number(bkCell(x))
  return isFinite(v) ? v : 0
}
function parseBankSmart(text) {
  const lines = String(text || '').split(/\r?\n/).map((x) => x.trim()).filter((x) => x)
  if (!lines.length) return { rows: [], layout: 'unknown', skipped: 0 }
  const split = (line) => {
    // 千分位逗号（1,200.00）先粘回去，否则会被当成列分隔符
    const fixed = String(line).replace(/(\d),(\d{3})(?=\D|$)/g, '$1$2').replace(/(\d),(\d{3})(?=\D|$)/g, '$1$2')
    if (/[,\t，]/.test(fixed)) return fixed.split(/[,\t，]/).map(bkCell)
    return fixed.split(/\s{2,}|\s+/).map(bkCell)
  }
  const bkDate = (v) => {
    const t = String(v == null ? '' : v).trim()
    const m = t.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
    if (m) return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0')
    const iso = toIsoDate(t)
    return iso ? String(iso).slice(0, 10) : ''
  }
  let headIdx = -1, head = null
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const cells = split(lines[i])
    const hits = cells.filter((c) => Object.keys(BK_COL).some((k) => BK_COL[k].test(c))).length
    if (hits >= 2 && cells.length >= 3) { headIdx = i; head = cells; break }
  }
  if (headIdx < 0) {
    // 没有表头：退回老格式（日期,收/付,金额,摘要）
    return { rows: parseBankText(text), layout: 'plain', skipped: 0 }
  }
  const idx = (re) => head.findIndex((c) => re.test(c))
  const iDate = idx(BK_COL.date)
  const iDir2 = head.findIndex((x) => /^(收\/支|收支|收付)$/.test(x))
  const iDir = iDir2 >= 0 ? iDir2 : idx(BK_COL.dir)
  const iAmt = idx(BK_COL.amount)
  const iDeb = idx(BK_COL.debit)
  const iCre = idx(BK_COL.credit)
  const iMemo = idx(BK_COL.memo)
  const layout = iDeb >= 0 || iCre >= 0 ? 'bank' : (iDir >= 0 ? 'wallet' : 'simple')
  const rows = []
  let skipped = 0
  for (let i = headIdx + 1; i < lines.length; i++) {
    const c = split(lines[i])
    if (!c.length) continue
    if (/^(合计|总计|小计|—|--)/.test(c[0] || '')) continue
    const date = bkDate(c[iDate >= 0 ? iDate : 0]) || ''
    let dir = ''
    let amount = 0
    if (layout === 'bank') {
      const deb = iDeb >= 0 ? bkAmount(c[iDeb]) : 0
      const cre = iCre >= 0 ? bkAmount(c[iCre]) : 0
      if (deb > 0) { dir = 'out'; amount = deb } else if (cre > 0) { dir = 'in'; amount = cre }
    } else {
      const dv = String(c[iDir >= 0 ? iDir : 1] || '')
      if (/支出|付款|转出|借/.test(dv)) dir = 'out'
      else if (/收入|收款|转入|贷/.test(dv)) dir = 'in'
      else if (/不计收支|中性/.test(dv)) { skipped++; continue }
      amount = bkAmount(c[iAmt >= 0 ? iAmt : 2])
    }
    if (!amount) { skipped++; continue }
    if (amount < 0) { amount = -amount; dir = dir || 'out' }
    if (!dir) dir = 'in'
    // 已退款/已关闭的交易不算真收支
    const line = lines[i]
    if (/已全额退款|交易关闭|已退款/.test(line)) { skipped++; continue }
    const memoParts = []
    const seen = {}
    for (let k = 0; k < head.length; k++) {
      if (!BK_COL.memo.test(head[k])) continue
      if (/单号|订单号|支付方式|收\/付款方式|当前状态|交易状态/.test(head[k])) continue
      if (k === iDate || k === iDir || k === iAmt || k === iDeb || k === iCre) continue
      const v = String(c[k] || '').trim()
      if (!v || seen[v]) continue
      seen[v] = 1
      memoParts.push(v)
    }
    if (!memoParts.length && iMemo >= 0 && c[iMemo]) memoParts.push(String(c[iMemo]).trim())
    rows.push({ date: date || now().slice(0, 10), direction: dir, amount: round2(amount), memo: memoParts.join(' ').slice(0, 80) })
  }
  return { rows, layout, skipped }
}

app.post('/bank-import', async (c) => {
  const { text, account_id } = await c.req.json()
  const db = c.env.DB
  const parsed = parseBankSmart(text)
  const rows = parsed.rows
  if (!rows.length) return c.json({ error: '没解析出流水。可以直接粘贴微信/支付宝/银行导出的 CSV 原文（有表头那种），或者「日期,收/付,金额,摘要」一行一笔' }, 400)
  const acc = num(account_id) || 0
  for (const r of rows) {
    await db.prepare('INSERT INTO bank_flows (date, direction, amount, memo, matched_type, matched_id, created_at) VALUES (?,?,?,?,?,0,?)')
      .bind(r.date, r.direction, r.amount, `${r.memo}${acc ? ' [账户' + acc + ']' : ''}`, null, now()).run()
  }
  await logAudit(db, '导入银行流水', '银行流水', `导入 ${rows.length} 笔`)
  const LAYOUT_CN = { wallet: '微信/支付宝账单', bank: '银行流水（借方/贷方）', simple: '通用表格（日期/收付/金额）', plain: '简单格式（日期,收付,金额,摘要）' }
  return c.json({ ok: true, imported: rows.length, rows, layout: parsed.layout, layout_text: LAYOUT_CN[parsed.layout] || parsed.layout, skipped: parsed.skipped })
})

app.get('/bank-flows', async (c) => {
  const db = c.env.DB
  const only = c.req.query('matched')
  let sql = 'SELECT * FROM bank_flows'
  if (only === '0') sql += ' WHERE matched_type IS NULL'
  else if (only === '1') sql += ' WHERE matched_type IS NOT NULL'
  sql += ' ORDER BY date DESC, id DESC LIMIT 200'
  const rows = (await db.prepare(sql).all()).results
  const un = await db.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount),0) t FROM bank_flows WHERE matched_type IS NULL').first()
  return c.json({ rows, unmatched: { count: num(un.n), amount: round2(num(un.t)) } })
})

// 认领一笔流水到单据（供单笔认领和自动认领共用）
async function bankMatch(db, bf, target_type, target_id, category, account_id) {
  if (bf.matched_type) return { error: '这笔已经认领过了' }
  const acc = num(account_id) || (await defaultAccountId(db))
  const amt = num(bf.amount)
  if (target_type === 'order' && bf.direction !== 'in') return { error: '这笔流水是付款，不能抵应收（收款的才能抵）' }
  if (target_type === 'payable' && bf.direction !== 'out') return { error: '这笔流水是收款，不能抵应付（付款的才能抵）' }
  if (target_type === 'order') {
    const o = await db.prepare('SELECT * FROM orders WHERE id=?').bind(target_id).first()
    if (!o) return { error: '应收单不存在' }
    await db.batch([
      db.prepare('UPDATE orders SET paid=paid+?, rev=COALESCE(rev,0)+1 WHERE id=?').bind(amt, o.id),
      db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, remark, account_id, cash, created_at) VALUES ('in','order',?,?,?,?,1,?)")
        .bind(o.id, amt, `银行对账收款 ${o.customer} ${o.item_name}`, acc, bf.date + 'T00:00:00.000Z')
    ])
  } else if (target_type === 'payable') {
    const p = await db.prepare('SELECT * FROM payables WHERE id=?').bind(target_id).first()
    if (!p) return { error: '应付单不存在' }
    await db.batch([
      db.prepare('UPDATE payables SET paid=paid+?, rev=COALESCE(rev,0)+1 WHERE id=?').bind(amt, p.id),
      db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('out','payable',?,?,?,?,?,1,?)")
        .bind(p.id, amt, p.category || '', `银行对账付款 ${p.supplier}`, acc, bf.date + 'T00:00:00.000Z')
    ])
  } else {
    const dir = bf.direction === 'in' ? 'in' : 'out'
    await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES (?,'expense',0,?,?,?,?,1,?)")
      .bind(dir, amt, category || (dir === 'in' ? '其他收入' : '其他'), `银行对账 ${bf.memo || ''}`, acc, bf.date + 'T00:00:00.000Z').run()
  }
  await db.prepare('UPDATE bank_flows SET matched_type=?, matched_id=? WHERE id=?')
    .bind(target_type === 'order' ? 'order' : target_type === 'payable' ? 'payable' : 'expense', num(target_id) || 0, bf.id).run()
  await logAudit(db, '银行流水认领', bf.memo || '', `¥${amt} → ${target_type}`)
  return { ok: true }
}

// 认领：把一笔流水登记成「某张应收的收款 / 某笔应付的付款 / 一笔支出」
app.post('/bank-flows/:id/match', async (c) => {
  const id = c.req.param('id')
  const { target_type, target_id, category, account_id } = await c.req.json()
  const db = c.env.DB
  const bf = await db.prepare('SELECT * FROM bank_flows WHERE id=?').bind(id).first()
  if (!bf) return c.json({ error: '流水不存在' }, 404)
  const r = await bankMatch(db, bf, target_type, target_id, category, account_id)
  if (r.error) return c.json({ error: r.error }, 400)
  return c.json({ ok: true })
})

// ── 自动认领：先按「金额对得上 + 摘要里有单位名」自动配一遍，剩下的才人工点 ──
app.post('/bank-auto-match', async (c) => {
  const db = c.env.DB
  const b = await c.req.json().catch(() => ({}))
  const apply = b.apply === true
  const flows = (await db.prepare('SELECT * FROM bank_flows WHERE matched_type IS NULL ORDER BY date DESC, id DESC LIMIT 200').all()).results || []
  if (!flows.length) {
    const all = await db.prepare('SELECT COUNT(*) n FROM bank_flows').first().catch(() => ({ n: 0 }))
    return c.json({ ok: true, total: 0, high: 0, mid: 0, none: 0, rows: [], applied: 0,
      text: num(all && all.n) ? '没有待认领的流水，都处理完了。' : '还没导入过银行流水。导入后可以一键自动认领。' })
  }
  const [ords, pays] = await Promise.all([
    db.prepare("SELECT id, customer party, item_name item, price amount, COALESCE(paid,0) paid, COALESCE(written_off,0) wo, created_at FROM orders WHERE price - COALESCE(paid,0) - COALESCE(written_off,0) > 0.005").all().catch(() => ({ results: [] })),
    db.prepare("SELECT id, supplier party, COALESCE(remark,'') item, amount, COALESCE(paid,0) paid, COALESCE(written_off,0) wo, created_at FROM payables WHERE amount - COALESCE(paid,0) - COALESCE(written_off,0) > 0.005").all().catch(() => ({ results: [] }))
  ])
  const outs = (ords.results || []).map((x) => ({ ...x, kind: 'order' }))
  const pays2 = (pays.results || []).map((x) => ({ ...x, kind: 'payable' }))
  const rows = []
  let applied = 0
  for (const f of flows) {
    const amt = num(f.amount)
    const memoN = norm(f.memo || '')
    const pool = f.direction === 'in' ? outs : pays2
    const scored = []
    for (const d of pool) {
      const left = round2(num(d.amount) - num(d.paid) - num(d.wo))
      let sc = 0
      const why = []
      if (Math.abs(left - amt) < 0.011) { sc += 60; why.push('金额正好等于还欠的 ¥' + left) }
      else if (Math.abs(num(d.amount) - amt) < 0.011) { sc += 25; why.push('金额等于单据总额 ¥' + num(d.amount)) }
      if (memoN && norm(d.party) && memoN.indexOf(norm(d.party)) >= 0) { sc += 50; why.push('摘要里有「' + d.party + '」') }
      if (amt > left + 0.011) { sc -= 45; why.push('这笔比还欠的多 ¥' + round2(amt - left)) }
      if (sc > 0) scored.push({ d, sc, why })
    }
    scored.sort((a, b2) => b2.sc - a.sc)
    const best = scored[0]
    const second = scored[1]
    const conf = !best ? 'none' : (best.sc >= 90 && (!second || second.sc < best.sc - 20) ? 'high' : (best.sc >= 50 ? 'mid' : 'none'))
    const item = {
      id: num(f.id), date: f.date, direction: f.direction, amount: amt, memo: f.memo || '',
      conf, why: best ? best.why.join('；') : '',
      target: best ? { kind: best.d.kind, id: num(best.d.id), party: best.d.party, item: best.d.item || '', left: round2(num(best.d.amount) - num(best.d.paid) - num(best.d.wo)) } : null,
      alts: scored.slice(1, 4).map((x) => ({ kind: x.d.kind, id: num(x.d.id), party: x.d.party, left: round2(num(x.d.amount) - num(x.d.paid) - num(x.d.wo)), sc: x.sc }))
    }
    if (apply && conf === 'high' && item.target) {
      const r = await bankMatch(db, f, item.target.kind, item.target.id, '', b.account_id)
      if (r.ok) { applied++; item.done = true }
      else item.err = r.error
    }
    rows.push(item)
  }
  const high = rows.filter((x) => x.conf === 'high').length
  const mid = rows.filter((x) => x.conf === 'mid').length
  const none = rows.filter((x) => x.conf === 'none').length
  const hiAmt = round2(rows.filter((x) => x.conf === 'high').reduce((a, x) => a + x.amount, 0))
  let text
  if (apply) text = applied ? `自动认领了 ${applied} 笔（共 ¥${hiAmt}），剩下 ${mid + none} 笔要你自己看一眼。` : '这次没有能自动认领的，都列在下面了。'
  else if (high) text = `${high} 笔能自动认领（共 ¥${hiAmt}），另外 ${mid} 笔有点像、${none} 笔没找到对应的单。`
  else if (mid) text = `没有能百分百确定的，${mid} 笔有相近的单，你挑一下。`
  else text = `${rows.length} 笔流水都没找到对应的单，可能要手工记成支出或收入。`
  return c.json({ ok: true, total: rows.length, high, mid, none, applied, rows, text })
})

app.delete('/bank-flows/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const bf = await db.prepare('SELECT * FROM bank_flows WHERE id=?').bind(id).first()
  if (!bf) return c.json({ error: '流水不存在' }, 404)
  if (bf.matched_type) return c.json({ error: '已认领的流水不能删，先去对应单据里改' }, 400)
  await db.prepare('DELETE FROM bank_flows WHERE id=?').bind(id).run()
  return c.json({ ok: true })
})

// 提醒汇总：把该管的事一次列出来
// 我今天干了啥（员工也看得到）：今天记了几笔、收了多少钱、本月还有多少没收
app.get('/my-day', async (c) => {
  const db = c.env.DB
  const role = c.get('role') || 'owner'
  const day = String(c.req.query('date') || '').slice(0, 10) || now().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return c.json({ error: '日期格式：YYYY-MM-DD' }, 400)
  const one = (sql, ...b) => db.prepare(sql).bind(...b).first().catch(() => ({ n: 0, s: 0 }))
  const [ar, ap, ex, inc, mUnpaid, nodue] = await Promise.all([
    one('SELECT COUNT(*) n, COALESCE(SUM(price),0) s FROM orders WHERE substr(created_at,1,10)=?', day),
    one('SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM payables WHERE substr(created_at,1,10)=?', day),
    one("SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM ledger WHERE substr(created_at,1,10)=? AND direction='out' AND cash=1 AND ref_type IN ('expense','fixed')", day),
    one("SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM ledger WHERE substr(created_at,1,10)=? AND direction='in' AND cash=1", day),
    one('SELECT COUNT(*) n, COALESCE(SUM(price-COALESCE(paid,0)-COALESCE(written_off,0)),0) s FROM orders WHERE month=? AND price-COALESCE(paid,0)-COALESCE(written_off,0)>0.005', day.slice(0, 7)),
    one("SELECT COUNT(*) n FROM orders WHERE substr(created_at,1,10)=? AND (due_date IS NULL OR due_date='')", day)
  ])
  const R = (x) => ({ n: num(x && x.n), s: round2(num(x && x.s)) })
  const a = R(ar), b = R(ap), e = R(ex), i = R(inc), mu = R(mUnpaid)
  const parts = []
  if (a.n) parts.push(`记应收 ${a.n} 张 ¥${a.s}`)
  if (b.n) parts.push(`记应付 ${b.n} 笔 ¥${b.s}`)
  if (e.n) parts.push(`记支出 ${e.n} 笔 ¥${e.s}`)
  if (i.n) parts.push(`收钱 ${i.n} 笔 ¥${i.s}`)
  const text = parts.length
    ? `今天（${day.slice(5)}）你${parts.join('、')}。`
    : `今天（${day.slice(5)}）还没记东西。有活就记一笔，一句话也行：「收张老板3000」。`
  const tips = []
  if (mu.n && mu.s > 0) tips.push(`本月的单还有 ${mu.n} 张没结清，共 ¥${mu.s}——到日子记得去收。`)
  if (nodue.n) tips.push(`今天有 ${nodue.n} 张单没写约定收款日，到点不会提醒你去收；能定个日子就填上。`)
  if (!e.n && i.n) tips.push('收了钱记得顺手记一下花出去的（工资、水电、运费），月底利润才准。')
  return c.json({ ok: true, day, role, ar: a, ap: b, exp: e, income: i, month_unpaid: mu, nodue: { n: nodue.n ? num(nodue.n) : 0 }, text, tips })
})

// ── 收工小结：给别人看的白话（发家人/合伙人）──
app.get('/day-close', async (c) => {
  const db = c.env.DB
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(c.req.query('date') || '')) ? String(c.req.query('date')) : todayIso()
  const one = (sql, ...b) => db.prepare(sql).bind(...b).first().catch(() => ({ n: 0, s: 0 }))
  const [ar, rc, pd, ex, mUnpaid, mAr] = await Promise.all([
    one('SELECT COUNT(*) n, COALESCE(SUM(price),0) s FROM orders WHERE substr(created_at,1,10)=?', day),
    one("SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM ledger WHERE substr(created_at,1,10)=? AND direction='in' AND cash=1 AND ref_type<>'transfer'", day),
    one("SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM ledger WHERE substr(created_at,1,10)=? AND direction='out' AND cash=1 AND ref_type<>'transfer'", day),
    one("SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM ledger WHERE substr(created_at,1,10)=? AND direction='out' AND cash=1 AND ref_type IN ('expense','fixed')", day),
    one("SELECT COUNT(*) n, COALESCE(SUM(price-COALESCE(paid,0)-COALESCE(written_off,0)),0) s FROM orders WHERE price-COALESCE(paid,0)-COALESCE(written_off,0)>0.005"),
    one("SELECT COUNT(*) n, COALESCE(SUM(price),0) s FROM orders WHERE month=?", day.slice(0, 7))
  ])
  const R = (x) => ({ n: num(x && x.n), s: round2(num(x && x.s)) })
  const a = R(ar), r = R(rc), p = R(pd), e = R(ex), mu = R(mUnpaid), ma = R(mAr)
  const L = []
  L.push(`【收工小结 · ${day.slice(5).replace('-', '/')}】`)
  const bits = []
  if (a.n) bits.push(`接了 ${a.n} 单活（共 ¥${a.s}）`)
  if (r.n) bits.push(`收到 ${r.n} 笔钱（¥${r.s}）`)
  else bits.push('今天没收到钱')
  if (p.n) bits.push(`付出去 ${p.n} 笔（¥${p.s}）`)
  L.push(bits.join('，') + '。')
  if (mu.n && mu.s > 0) L.push(`这个月还有 ${mu.n} 张单没收回来，共 ¥${mu.s}。`)
  if (!a.n && !r.n && !p.n) { L.length = 0; L.push(`【收工小结 · ${day.slice(5).replace('-', '/')}】`, '今天还没记单子，收工前顺手记一笔。') }
  const text = L.join('\n')
  return c.json({ ok: true, day, text, ar: a, received: r, paid: p, exp: e, month_unpaid: mu, month_ar: ma })
})

// 老板看：员工这几天记了什么（按操作日志里的「员工」标记）
app.get('/staff-activity', async (c) => {
  const db = c.env.DB
  const days = Math.min(Math.max(num(c.req.query('days')) || 7, 1), 90)
  const since = addDaysIso(now().slice(0, 10), -days)
  const [rows, byDay, byAct, staffCfg, byPerson] = await Promise.all([
    db.prepare("SELECT action, target, detail, created_at, by AS who FROM audit_log WHERE by LIKE '员工%' AND substr(created_at,1,10)>=? ORDER BY id DESC LIMIT 120").bind(since).all().catch(() => ({ results: [] })),
    db.prepare("SELECT substr(created_at,1,10) d, COUNT(*) n FROM audit_log WHERE by LIKE '员工%' AND substr(created_at,1,10)>=? GROUP BY d ORDER BY d DESC").bind(since).all().catch(() => ({ results: [] })),
    db.prepare("SELECT action, COUNT(*) n FROM audit_log WHERE by LIKE '员工%' AND substr(created_at,1,10)>=? GROUP BY action ORDER BY n DESC LIMIT 8").bind(since).all().catch(() => ({ results: [] })),
    db.prepare("SELECT value AS v FROM settings WHERE key='staff_key'").first().catch(() => null),
    db.prepare("SELECT by AS who, COUNT(*) n FROM audit_log WHERE by LIKE '员工%' AND substr(created_at,1,10)>=? GROUP BY by ORDER BY n DESC").bind(since).all().catch(() => ({ results: [] }))
  ])
  // created_at 已经存的就是北京时间，这里只做格式整理
  const local = (t) => {
    const d = new Date(String(t || '').replace(' ', 'T'))
    if (isNaN(d.getTime())) return String(t || '')
    const x = d.toISOString()
    return x.slice(0, 10) + ' ' + x.slice(11, 16)
  }
  const list = (rows.results || []).map((r) => {
    const lt = local(r.created_at)
    return { date: lt.slice(0, 10), time: lt.slice(11, 16), action: r.action, target: r.target || '', detail: r.detail || '', who: r.who || '员工', name: String(r.who || '').replace(/^员工·?/, '') || '没写名字' }
  })
  const cnt = list.length
  const last = list[0] ? list[0].date + ' ' + list[0].time : ''
  const enabled = !!(staffCfg && String(staffCfg.v || ''))
  const advice = !enabled
    ? '还没设员工口令，所以这些操作都是老板自己记的。要给家人/伙计用，去「设置 → 员工口令」设一个。'
    : (cnt ? `最近 ${days} 天员工记了 ${cnt} 笔${last ? '，最后一次 ' + last : ''}。` : `最近 ${days} 天没有员工操作记录。`)
  return c.json({ ok: true, days, since, count: cnt, last, rows: list,
    by_day: (byDay.results || []).map((x) => ({ date: x.d, cnt: num(x.n) })),
    by_action: (byAct.results || []).map((x) => ({ action: x.action, cnt: num(x.n) })),
    by_person: (byPerson.results || []).map((x) => ({ who: x.who, name: String(x.who || '').replace(/^员工·?/, '') || '没写名字', cnt: num(x.n) })),
    staff_enabled: enabled, advice })
})

app.get('/reminders', async (c) => {
  const db = c.env.DB
  const today = now().slice(0, 10)
  const curM = now().slice(0, 7)
  const tomorrow = addDaysIso(today, 1)
  const mc = await db.prepare("SELECT value FROM settings WHERE key='collect_min_days'").first().catch(() => null)
  const minD = Math.max(7, num(mc && mc.value) || 15)
  // 性能：原来是 20 多条查询一条条排队（3.8 秒），改成一次并发（约 0.6 秒）；条目顺序与文案完全不变
  const jobs = [
    db.prepare("SELECT id, customer, (price-paid-COALESCE(written_off,0)) AS unpaid, created_at FROM orders WHERE paid + COALESCE(written_off,0) < price AND substr(created_at,1,10) <= date(?, '-30 day') ORDER BY created_at LIMIT 50").bind(today).all(),
    db.prepare("SELECT id, customer, (price-paid-COALESCE(written_off,0)) AS unpaid, due_date FROM orders WHERE paid + COALESCE(written_off,0) < price AND due_date IS NOT NULL AND due_date BETWEEN ? AND date(?, '+7 day') ORDER BY due_date LIMIT 50").bind(today, today).all(),
    db.prepare("SELECT id, supplier, (amount-paid-COALESCE(written_off,0)) AS unpaid, due_date FROM payables WHERE paid + COALESCE(written_off,0) < amount AND due_date IS NOT NULL AND due_date BETWEEN ? AND date(?, '+7 day') ORDER BY due_date LIMIT 50").bind(today, today).all(),
    db.prepare("SELECT COUNT(*) n FROM budgets WHERE amount > 0 AND (SELECT COALESCE(SUM(l.amount),0) FROM ledger l WHERE l.direction='out' AND l.cash=1 AND l.ref_type<>'transfer' AND COALESCE(NULLIF(l.category,''),'其他')=budgets.category AND substr(l.created_at,1,7)=?) >= budgets.amount").bind(curM).first(),
    db.prepare('SELECT COUNT(*) n FROM bank_flows WHERE matched_type IS NULL').first(),
    db.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount-used-returned),0) t FROM loans').first(),
    db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(todo),0) t FROM (
      SELECT MIN(COALESCE(o.paid,0), COALESCE(o.price,0)) - COALESCE((SELECT SUM(i.amount) FROM invoices i WHERE i.type='out' AND i.order_id=o.id),0) AS todo
      FROM orders o WHERE COALESCE(o.paid,0) > 0 AND COALESCE(o.no_invoice,0)=0) WHERE todo > 0.005`).first(),
    db.prepare("SELECT COUNT(*) n FROM recon_log WHERE done=0 AND state<>'match'").first(),
    db.prepare('SELECT COUNT(*) n FROM recon_log WHERE month=?').bind(curM).first(),
    db.prepare("SELECT d.party, d.promise_date, d.note FROM dunning_log d WHERE d.promise_date IS NOT NULL AND substr(d.promise_date,1,10) < ? AND d.id = (SELECT MAX(x.id) FROM dunning_log x WHERE x.party=d.party AND x.promise_date IS NOT NULL)").bind(today).all(),
    db.prepare("SELECT customer AS party, COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) AS t FROM orders WHERE price-paid-COALESCE(written_off,0) > 0 GROUP BY customer UNION ALL SELECT supplier AS party, COALESCE(SUM(amount-paid-COALESCE(written_off,0)),0) AS t FROM payables WHERE amount-paid-COALESCE(written_off,0) > 0 GROUP BY supplier").all(),
    db.prepare("SELECT d.party, d.promise_date FROM dunning_log d WHERE substr(d.promise_date,1,10) = ? AND d.id = (SELECT MAX(x.id) FROM dunning_log x WHERE x.party=d.party AND x.promise_date IS NOT NULL)").bind(tomorrow).all(),
    db.prepare('SELECT party, recon_day, recon_cycle FROM party_terms WHERE COALESCE(recon_day,0) > 0 OR COALESCE(recon_cycle,0) > 0').all(),
    db.prepare('SELECT party, MAX(created_at) last_at FROM statement_log WHERE substr(created_at,1,7)=? GROUP BY party').bind(curM).all(),
    db.prepare("SELECT s.party, s.month, s.note, s.created_at FROM statement_log s WHERE s.ack='doubt' AND COALESCE(s.resolved_at,'')='' ORDER BY s.id DESC").all(),
    db.prepare("SELECT party, type, month, channel, created_at FROM statement_log WHERE COALESCE(ack,'') = '' AND date(created_at) <= date(?, '-7 day') ORDER BY created_at").bind(today).all(),
    db.prepare("SELECT o.customer AS party, COUNT(*) n, COALESCE(SUM(o.price-o.paid-COALESCE(o.written_off,0)),0) t FROM orders o WHERE o.price-o.paid-COALESCE(o.written_off,0) > 0 AND substr(o.created_at,1,10) <= date(?, '-30 day') AND NOT EXISTS (SELECT 1 FROM statement_log s WHERE s.party=o.customer AND substr(s.created_at,1,7)=?) GROUP BY o.customer ORDER BY t DESC").bind(today, curM).all(),
    db.prepare("SELECT o.customer AS party, COUNT(*) n, COALESCE(SUM(o.price-o.paid-COALESCE(o.written_off,0)),0) t FROM orders o WHERE o.price-o.paid-COALESCE(o.written_off,0) > 0 AND substr(o.created_at,1,10) <= date(?, '-" + minD + " day') AND NOT EXISTS (SELECT 1 FROM dunning_log d WHERE d.party=o.customer AND substr(d.created_at,1,10) >= date(?, '-7 day')) GROUP BY o.customer ORDER BY t DESC").bind(today, today).all(),
    db.prepare('SELECT party, MAX(created_at) last_at FROM recon_log GROUP BY party').all(),
    db.prepare("SELECT COUNT(*) n FROM (SELECT 1 FROM orders WHERE paid + COALESCE(written_off,0) < price AND (due_date IS NULL OR due_date='') UNION ALL SELECT 1 FROM payables WHERE paid + COALESCE(written_off,0) < amount AND (due_date IS NULL OR due_date=''))").first(),
    db.prepare("SELECT value FROM settings WHERE key='default_term'").first().catch(() => null),
    db.prepare('SELECT type, party, (amount - COALESCE(used,0)) AS remain, created_at FROM advances WHERE amount - COALESCE(used,0) > 0.005 ORDER BY created_at').all()
    ,
    db.prepare("SELECT COUNT(*) n, COALESCE(MAX(CAST(julianday(?) - julianday(COALESCE((SELECT MAX(p.created_at) FROM process_log p WHERE p.order_id=o.id), o.created_at)) AS INTEGER)),0) mx FROM orders o WHERE COALESCE(o.status,0)<2").bind(today).first(),
    db.prepare("SELECT name, maint_months, maint_last FROM assets WHERE COALESCE(maint_months,0)>0 AND COALESCE(disposed_at,'')=''").all(),
    db.prepare("SELECT customer party, COUNT(*) cnt, MIN(substr(created_at,1,10)) first_day, MAX(substr(created_at,1,10)) last_day FROM orders GROUP BY customer HAVING COUNT(*)>=2").all()

  ]
  const R = await Promise.all(jobs.map((j) => j.catch((e) => { noteFail(e); return null })))
  const rows0 = (x) => ((x && x.results) || [])
  const [od, ds, ps, bo, un, lo, iv, ro, rl, br, leftRows, so, ts, sents, dp, nr, ns, nc, doneRecon, noDue, dterm, advRows, staleR, maintR, custR] = R
  const items = []
  const push = (level, text, tab, list) => items.push({ level, text, tab, list: list || [] })
  // 员工提的改单申请：老板点了同意才生效，别忘了
  try {
    if ((c.get('role') || 'owner') !== 'staff') {
      const erN = await db.prepare("SELECT COUNT(*) n FROM edit_requests WHERE status='pending'").first()
      if (num(erN && erN.n) > 0) push('yellow', `${num(erN.n)} 条员工改单申请等你处理`, 'me')
    }
  } catch (e) {}
  const odR = rows0(od)
  if (odR.length) {
    const t = odR.reduce((a, r) => a + num(r.unpaid), 0)
    push('red', `${odR.length} 张应收逾期超 30 天，共 ¥${round2(t)}`, 'ar',
      odR.slice(0, 3).map((r) => ({ party: r.customer || '', amount: round2(num(r.unpaid)), note: `已 ${daysSince(r.created_at)} 天` })))
  }
  const dsR = rows0(ds)
  if (dsR.length) {
    push('yellow', `${dsR.length} 张应收 7 天内到期`, 'ar',
      dsR.slice(0, 3).map((r) => ({ party: r.customer || '', amount: round2(num(r.unpaid)), note: (r.due_date || '').slice(5, 10) + ' 到期' })))
  }
  const psR = rows0(ps)
  if (psR.length) {
    push('yellow', `${psR.length} 笔应付 7 天内要付`, 'ap',
      psR.slice(0, 3).map((r) => ({ party: r.supplier || '', amount: round2(num(r.unpaid)), note: (r.due_date || '').slice(5, 10) + ' 要付' })))
  }
  if (num(bo && bo.n) > 0) push('yellow', `${num(bo.n)} 个分类已经花超预算`, 'home')
  if (num(iv && iv.n) > 0) push('yellow', `${num(iv.n)} 笔收了钱还没开票，共 ¥${round2(num(iv.t))}`, 'asset')
  if (num(un && un.n) > 0) push('yellow', `${num(un.n)} 笔银行流水还没认领`, 'nw')
  if (num(lo && lo.n) > 0 && num(lo && lo.t) > 0) push('yellow', `员工借支还有 ¥${round2(num(lo.t))} 没清`, 'expense')
  if (num(iv && iv.n) > 0) push('gray', `${num(iv.n)} 张已收款的单还没开发票`, 'nw')
  // 新用户最容易漏：没设账期 → 未结单没有到期日 → 到期提醒、逾期榜都是空的
  if (num(noDue && noDue.n) > 0 && num(dterm && dterm.value) === 0) push('yellow', `${num(noDue.n)} 张单还没到期日（设个默认账期就会自动算）`, 'me')
  // 预收款/预付款：钱先动了、活还没抵 —— 这类最容易过期作废或忘记催
  try {
    const advAll = rows0(advRows)
    // 按「家」合并（同一家可能收了多笔），天数取该家最早那笔
    const grp = (t) => {
      const m = {}
      for (const r of advAll.filter((x) => x.type === t && num(x.remain) > 0.005)) {
        const k = norm(r.party)
        const o = m[k] || (m[k] = { party: r.party || '', amount: 0, days: 0 })
        o.amount = round2(o.amount + num(r.remain))
        o.days = Math.max(o.days, daysSince(r.created_at))
      }
      const rs = Object.values(m).sort((x, y) => y.days - x.days)
      return { n: rs.length, sum: round2(rs.reduce((a, r) => a + r.amount, 0)), oldest: rs.length ? rs[0].days : 0, rs }
    }
    const ai = grp('in'), ao = grp('out')
    if (ai.n > 0 && ai.oldest >= 30) {
      push('yellow', `${ai.n} 家客户先给了钱还没抵（共 ¥${ai.sum}），最早 ${ai.oldest} 天前`, 'me',
        ai.rs.slice(0, 3).map((r) => ({ party: r.party, amount: r.amount, note: r.days ? `${r.days} 天前收的` : '今天收的' })))
    }
    if (ao.n > 0 && ao.oldest >= 15) {
      push('yellow', `${ao.n} 家预付款付了料还没到（共 ¥${ao.sum}），最早 ${ao.oldest} 天前`, 'me',
        ao.rs.slice(0, 3).map((r) => ({ party: r.party, amount: r.amount, note: r.days ? `${r.days} 天前付的` : '今天付的' })))
    }
  } catch (e) {}
  // 工序卡住 / 设备保养 / 老客户很久没来（以前要手动点开面板才看得见）
  try {
    const sR = staleR || {}
    if (num(sR.n) > 0 && num(sR.mx) >= 7) push('yellow', `${num(sR.n)} 张单还没交付，最久 ${num(sR.mx)} 天没动过`, 'ar')
    const mDue = rows0(maintR).filter((a) => {
      const mo = num(a.maint_months)
      if (!mo) return false
      const base = String(a.maint_last || '').slice(0, 10)
      if (!base) return true
      const d0 = new Date(base + 'T00:00:00Z')
      d0.setUTCMonth(d0.getUTCMonth() + mo)
      return Date.now() >= d0.getTime()
    })
    if (mDue.length) push('yellow', `${mDue.length} 台设备该保养了（${mDue.slice(0, 2).map((x) => x.name).join('、')}）`, 'asset')
    const chHigh = rows0(custR).map((r) => {
      const g = daysSince(String(r.first_day || '').slice(0, 10)) - daysSince(String(r.last_day || '').slice(0, 10))
      const gapPer = num(r.cnt) > 1 ? g / (num(r.cnt) - 1) : 0
      const since = daysSince(String(r.last_day || '').slice(0, 10))
      return { party: r.party, cnt: num(r.cnt), since, gapPer, high: gapPer > 0 && since >= gapPer * 3 && since >= 45 }
    }).filter((x) => x.high).sort((a, b) => b.since - a.since)
    if (chHigh.length) push('gray', `${chHigh.length} 家老客户很久没下单了（最久 ${chHigh[0].since} 天没来：${chHigh[0].party}）`, 'report')
  } catch (e) {}
  // 对账：有差异没处理优先提醒，其次「这个月还没对过账」
  if (num(ro && ro.n) > 0) {
    const lst = rows0(await db.prepare("SELECT party, type, diff FROM recon_log WHERE done=0 AND state<>'match' ORDER BY id DESC LIMIT 3").all())
    push('yellow', `对账还有 ${num(ro.n)} 条差异没处理`, 'import',
      lst.map((x) => ({ party: x.party || '', amount: round2(Math.abs(num(x.diff))), note: x.type === 'ap' ? '应付' : '应收' })))
  } else if (num(rl && rl.n) === 0 && num(today.slice(8, 10)) >= 10 && rows0(leftRows).length > 0) {
    push('gray', `${curM.slice(5)} 月还没和客户/供应商对过账`, 'import')
  }
  // 欠款金额表（催款相关几条都要用）
  const lmap = {}
  for (const r of rows0(leftRows)) lmap[norm(r.party)] = round2(num(lmap[norm(r.party)]) + num(r.t))
  // 答应付款的日子过了还没付
  try {
    const brokenRows = rows0(br).filter((x) => num(lmap[norm(x.party)]) > 0.005)
    if (brokenRows.length) {
      const sum = round2(brokenRows.reduce((a, x) => a + num(lmap[norm(x.party)]), 0))
      push('red', `${brokenRows.length} 家答应付的日子过了还没付（共 ¥${sum}）`, 'ar', brokenRows.slice(0, 3).map((x) => ({ party: x.party || '', amount: round2(num(lmap[norm(x.party)])), note: '答应 ' + String(x.promise_date).slice(5, 10) + ' 付' })))
    }
    const soonRows = rows0(so).filter((x) => num(lmap[norm(x.party)]) > 0.005)
    if (soonRows.length) {
      const sum2 = round2(soonRows.reduce((a, x) => a + num(lmap[norm(x.party)]), 0))
      push('yellow', `${soonRows.length} 家答应明天付（共 ¥${sum2}），今天提一句`, 'ar', soonRows.slice(0, 3).map((x) => ({ party: x.party || '', amount: round2(num(lmap[norm(x.party)])), note: '答应 ' + String(x.promise_date).slice(5, 10) + ' 付' })))
    }
  } catch (e) {}
  // 今天/这几天该发对账单的（按每家约定的对账日）
  try {
    const dnum0 = num(today.slice(8, 10))
    const done0 = new Set(rows0(sents).map((x) => norm(x.party)))
    const rcList = rows0(ts).filter((t) => num(t.recon_day) > 0 && num(t.recon_day) <= dnum0 && !done0.has(norm(t.party)))
    if (rcList.length) {
      push('yellow', `${rcList.length} 家到点该发对账单了`, 'ar', rcList.slice(0, 3).map((x) => ({ party: x.party || '', amount: 0, note: '约定每月 ' + num(x.recon_day) + ' 号' })))
    }
  } catch (e) {}
  // 对账单有异议还没处理（最容易变死账）
  try {
    const dl = rows0(dp)
    if (dl.length) {
      push('red', `${dl.length} 份对账单对方说对不上，还没处理`, 'ar', dl.slice(0, 3).map((x) => ({ party: x.party || '', amount: 0, note: (x.note || '有异议').slice(0, 20) + '（' + daysSince(x.created_at) + ' 天前）' })))
    }
  } catch (e) {}
  // 对账单发出去 7 天还没回音
  try {
    const list0 = rows0(nr)
    if (list0.length) {
      push('yellow', `${list0.length} 份对账单发出去 7 天没回音`, 'ar', list0.slice(0, 3).map((x) => ({ party: x.party || '', amount: 0, note: (String(x.created_at).slice(5, 10)) + ' 用' + (x.channel || '微信') + '发的' })))
    }
  } catch (e) {}
  // 这个月还没发过对账单的欠款家（欠得久又没发单，最容易扯皮）
  try {
    const nr2 = rows0(ns)
    if (nr2.length) {
      const tt = round2(nr2.reduce((a, x) => a + num(x.t), 0))
      push('yellow', `${nr2.length} 家这个月还没发过对账单（欠 ¥${tt}）`, 'ar', nr2.slice(0, 3).map((x) => ({ party: x.party || '', amount: round2(num(x.t)), note: '欠了 30 天以上' })))
    }
  } catch (e) {}
  // 欠了很久又一直没催过的家
  try {
    const ncR = rows0(nc)
    if (ncR.length > 0) {
      const tsum = round2(ncR.reduce((a, r) => a + num(r.t), 0))
      push('yellow', `${ncR.length} 家欠超 ${minD} 天、这周还没催过（共 ¥${tsum}）`, 'ar', ncR.slice(0, 3).map((r) => ({ party: r.party || '', amount: round2(num(r.t)), note: num(r.n) + ' 笔' })))
    }
  } catch (e) {}
  // 约定了对账周期的单位：到日子还没对过账，单独提醒
  try {
    const cycList = rows0(ts).filter((t) => num(t.recon_cycle) > 0)
    if (cycList.length) {
      const dm = {}
      for (const x of rows0(doneRecon)) dm[x.party] = x.last_at
      const due = cycList.filter((t) => { const l = dm[t.party]; return !l || daysSince(l) >= num(t.recon_cycle) }).map((t) => { const l = dm[t.party]; return { party: t.party, amount: 0, note: l ? `上次对账 ${daysSince(l)} 天前` : '还没对过账' } })
      if (due.length) push('yellow', `${due.length} 家到了该对账的日子`, 'import', due.slice(0, 3))
    }
  } catch (e) {}
  return c.json({ items, count: items.length, today, degraded: failBucket.slice() })
})

// ── 第四档：坏账核销 / 账户内部转账 ──
// 核销坏账（应收要不回来了 / 应付不用付了）：只是把往来抹掉，不动现金、不算收支
app.post('/orders/:id/writeoff', async (c) => {
  const id = c.req.param('id')
  const { amount, reason } = await c.req.json().catch(() => ({}))
  const db = c.env.DB
  const o = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first()
  if (!o) return c.json({ error: '订单不存在' }, 404)
  const unpaid = round2(num(o.price) - num(o.paid) - num(o.written_off))
  if (unpaid <= 0) return c.json({ error: '这张单已经没有未结金额了' }, 400)
  const a = amount ? round2(Math.min(num(amount), unpaid)) : unpaid
  if (a <= 0) return c.json({ error: '核销金额无效' }, 400)
  if (await isMonthLocked(db, (o.created_at || '').slice(0, 7))) return c.json({ error: '该订单所在月份已结账锁定' }, 403)
  await db.batch([
    db.prepare('UPDATE orders SET written_off=COALESCE(written_off,0)+? WHERE id=?').bind(a, id),
    db.prepare("INSERT INTO writeoffs (ref_type, ref_id, party, amount, reason, created_at) VALUES ('order',?,?,?,?,?)")
      .bind(num(id), o.customer, a, String(reason || '').trim() || '要不回来了', now())
  ])
  await logAudit(db, '核销应收', o.customer, `${o.customer} ${o.item_name || ''} 核销 ¥${a}`)
  return c.json({ ok: true, amount: a, unpaid_left: round2(unpaid - a) })
})

app.post('/payables/:id/writeoff', async (c) => {
  const id = c.req.param('id')
  const { amount, reason } = await c.req.json().catch(() => ({}))
  const db = c.env.DB
  const p = await db.prepare('SELECT * FROM payables WHERE id=?').bind(id).first()
  if (!p) return c.json({ error: '应付单不存在' }, 404)
  const unpaid = round2(num(p.amount) - num(p.paid) - num(p.written_off))
  if (unpaid <= 0) return c.json({ error: '这笔已经没有未结金额了' }, 400)
  const a = amount ? round2(Math.min(num(amount), unpaid)) : unpaid
  if (a <= 0) return c.json({ error: '核销金额无效' }, 400)
  if (await isMonthLocked(db, (p.created_at || '').slice(0, 7))) return c.json({ error: '该应付单所在月份已结账锁定' }, 403)
  await db.batch([
    db.prepare('UPDATE payables SET written_off=COALESCE(written_off,0)+? WHERE id=?').bind(a, id),
    db.prepare("INSERT INTO writeoffs (ref_type, ref_id, party, amount, reason, created_at) VALUES ('payable',?,?,?,?,?)")
      .bind(num(id), p.supplier, a, String(reason || '').trim() || '不用付了', now())
  ])
  await logAudit(db, '核销应付', p.supplier, `${p.supplier} 核销 ¥${a}`)
  return c.json({ ok: true, amount: a, unpaid_left: round2(unpaid - a) })
})

// 核销记录（可按月）
app.get('/writeoffs', async (c) => {
  const db = c.env.DB
  const month = c.req.query('month') || now().slice(0, 7)
  const rows = (await db.prepare("SELECT * FROM writeoffs WHERE substr(created_at,1,7)=? ORDER BY id DESC").bind(month).all()).results
  const bad = round2(rows.filter((r) => r.ref_type === 'order').reduce((s2, r) => s2 + num(r.amount), 0))
  const waived = round2(rows.filter((r) => r.ref_type === 'payable').reduce((s2, r) => s2 + num(r.amount), 0))
  return c.json({ month, rows, bad_debt: bad, payable_waived: waived })
})

// 撤销某笔核销
app.delete('/writeoffs/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const w = await db.prepare('SELECT * FROM writeoffs WHERE id=?').bind(id).first()
  if (!w) return c.json({ error: '记录不存在' }, 404)
  const tbl = w.ref_type === 'order' ? 'orders' : 'payables'
  await db.batch([
    db.prepare(`UPDATE ${tbl} SET written_off=MAX(COALESCE(written_off,0)-?,0) WHERE id=?`).bind(num(w.amount), num(w.ref_id)),
    db.prepare('DELETE FROM writeoffs WHERE id=?').bind(id)
  ])
  await logAudit(db, '撤销核销', w.party, `${w.party} 撤销核销 ¥${w.amount}`)
  return c.json({ ok: true })
})

// 账户之间内部转账（现金从左口袋到右口袋，不是收入也不是支出）
app.post('/transfer', async (c) => {
  const { from, to, amount, date, remark } = await c.req.json().catch(() => ({}))
  const db = c.env.DB
  const f = num(from)
  const t = num(to)
  const a = num(amount)
  if (!f || !t) return c.json({ error: '请选择转出和转入账户' }, 400)
  if (f === t) return c.json({ error: '转出和转入不能是同一个账户' }, 400)
  if (a <= 0) return c.json({ error: '金额必须大于 0' }, 400)
  const af = await db.prepare('SELECT * FROM accounts WHERE id=?').bind(f).first()
  const at = await db.prepare('SELECT * FROM accounts WHERE id=?').bind(t).first()
  if (!af || !at) return c.json({ error: '账户不存在' }, 404)
  const d = normDate(date)
  if (await isMonthLocked(db, (d || now()).slice(0, 7))) return c.json({ error: '本月已结账锁定，先解锁再记账' }, 403)
  const memo = String(remark || '').trim()
  const r = await db.prepare('INSERT INTO transfers (from_id, to_id, amount, remark, created_at) VALUES (?,?,?,?,?)')
    .bind(f, t, a, memo, d).run()
  const tid = r.meta && r.meta.last_row_id ? r.meta.last_row_id : 0
  await db.batch([
    db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('out','transfer',?,?,?,?,?,1,?)")
      .bind(tid, a, '内部转账', `转到 ${at.name}${memo ? ' ' + memo : ''}`, f, d),
    db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('in','transfer',?,?,?,?,?,1,?)")
      .bind(tid, a, '内部转账', `从 ${af.name} 转入${memo ? ' ' + memo : ''}`, t, d)
  ])
  await logAudit(db, '内部转账', `${af.name}→${at.name}`, `${af.name} 转 ${at.name} ¥${a}`)
  return c.json({ ok: true, id: tid })
})

// 兼容别名：POST /transfers（参数名也支持 from_acc / to_acc）
app.post('/transfers', async (c) => {
  const b = await c.req.json().catch(() => ({}))
  const db = c.env.DB
  const f = num(b.from || b.from_acc), t = num(b.to || b.to_acc), a = num(b.amount)
  if (!f || !t) return c.json({ error: '请选择转出和转入账户' }, 400)
  if (f === t) return c.json({ error: '转出和转入不能是同一个账户' }, 400)
  if (a <= 0) return c.json({ error: '金额必须大于 0' }, 400)
  const af = await db.prepare('SELECT * FROM accounts WHERE id=?').bind(f).first()
  const at = await db.prepare('SELECT * FROM accounts WHERE id=?').bind(t).first()
  if (!af || !at) return c.json({ error: '账户不存在' }, 404)
  const d = normDate(b.date)
  if (await isMonthLocked(db, (d || now()).slice(0, 7))) return c.json({ error: '本月已结账锁定，先解锁再记账' }, 403)
  const memo = String(b.remark || '').trim()
  const r = await db.prepare('INSERT INTO transfers (from_id, to_id, amount, remark, created_at) VALUES (?,?,?,?,?)').bind(f, t, a, memo, d).run()
  const tid = r.meta && r.meta.last_row_id ? r.meta.last_row_id : 0
  await db.batch([
    db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('out','transfer',?,?,?,?,?,1,?)").bind(tid, a, '内部转账', `转到 ${at.name}${memo ? ' ' + memo : ''}`, f, d),
    db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('in','transfer',?,?,?,?,?,1,?)").bind(tid, a, '内部转账', `从 ${af.name} 转入${memo ? ' ' + memo : ''}`, t, d)
  ])
  await logAudit(db, '内部转账', `${af.name}→${at.name}`, `${af.name} 转 ${at.name} ¥${a}`)
  return c.json({ ok: true, id: tid })
})

app.get('/transfers', async (c) => {
  const db = c.env.DB
  const rows = (await db.prepare('SELECT * FROM transfers ORDER BY id DESC LIMIT 50').all()).results
  const accs = (await db.prepare('SELECT id,name FROM accounts').all()).results
  const nm = (i) => (accs.find((a) => a.id === num(i)) || {}).name || '已删账户'
  return c.json(rows.map((r) => ({ ...r, from_name: nm(r.from_id), to_name: nm(r.to_id) })))
})

app.delete('/transfers/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  await db.batch([
    db.prepare("DELETE FROM ledger WHERE ref_type='transfer' AND ref_id=?").bind(num(id)),
    db.prepare('DELETE FROM transfers WHERE id=?').bind(num(id))
  ])
  await logAudit(db, '删除内部转账', '', `#${id}`)
  return c.json({ ok: true })
})

export default {
  fetch: (req, env, ctx) => {
    // 多账套：根据请求头 X-Book（1/2/3）选择对应的 D1 库
    let book = 1
    try {
      const hb = Number(req.headers.get('X-Book') || 1)
      if (hb === 2 || hb === 3) book = hb
      else {
        const u = new URL(req.url)
        const qb = Number(u.searchParams.get('book') || 0)
        if (qb === 2 || qb === 3) book = qb
      }
    } catch (e) { book = 1 }
    const db = book === 3 ? env.DB3 : book === 2 ? env.DB2 : env.DB
    return app.fetch(req, { ...env, DB: db, BOOK: book, ENV_ALL: env }, ctx)
  },
  // 每天 UTC 16:00（北京时间 0 点）自动备份一次，并同步推送到笔记站
  scheduled: async (event, env, ctx) => {
  // 首页提速的前置：给 orders/ledger/payables 补 month 列并回填（幂等，列齐了就只剩 PRAGMA）
  try { await ensureMonthCols(env.DB) } catch (e) {}
  try { await ensureMonthCols(env.DB2) } catch (e) {}
  try { await ensureMonthCols(env.DB3) } catch (e) {}
  try { await ensureStaffTable(env.DB) } catch (e) {}
  try { await ensureStaffTable(env.DB2) } catch (e) {}
  try { await ensureStaffTable(env.DB3) } catch (e) {}
    const books = [['1', env.DB], ['2', env.DB2], ['3', env.DB3]]
    for (const [bid, db] of books) {
      if (!db) continue
      // 封存的账本是只读的：自动记账不再往里写（备份、体检照做）
      let isSealed = false
      try {
        const ss = await db.prepare("SELECT value FROM settings WHERE key='sealed'").first()
        isSealed = !!(ss && String(ss.value) === '1')
      } catch (e) { /* 忽略 */ }
      try {
        if (!isSealed) {
          await runFixed(db)
          await runAmort(db)
          await runAccrual(db)
          await runDepreciation(db)
        }
        const cron = (event && event.cron) || ''
        if (cron === '0 1 * * 1') await pushWeekly(db)
        else if (cron === '0 2 1 * *') {
          await pushReconRemind(db)
          // 每月 1 号：把上个月的全套报表打包存好，并推一条「报表已生成」
          try {
            const bj = new Date(Date.now() + TZ_MS)
            const pm = new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)
            const rp = await runMonthPack(db, pm)
            if (rp && rp.ok) await pushMonthPack(db, pm)
          } catch (e) {
            console.error('month pack failed book' + bid, e)
          }
        } else {
          await runWxReminder(db)
          // 这个 cron 每天在北京时间 0 点跑一次，所以「刚过完的那个月」= 北京日期为 1 号时往前推一个月
          const t0 = new Date(Date.now() + TZ_MS)
          if (t0.getUTCDate() === 1) {
            const pm = new Date(Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)
            await pushTargetSummary(db, pm)
            await pushDunningSummary(db, pm)
            // 月底：把家底存一份，以后改了老单据也不会带偏历史那一段曲线
            try { await snapNet(db, pm, '月底自动存档') } catch (e) { console.error('net snapshot failed', e) }
          }
        }
      } catch (e) {
        console.error('scheduled fixed failed book' + bid, e)
      }
      try {
        // 每天自检一次：把发现的问题数写进设置，首页亮红点
        const chk = await selfCheck(db)
        await putSetting(db, 'selfcheck_count', String((chk && chk.bad) || 0))
        await putSetting(db, 'selfcheck_at', now())
      } catch (e) {
        console.error('scheduled selfcheck failed book' + bid, e)
      }
      try {
        await saveBackup(db)
      } catch (e) {
        console.error('scheduled backup failed book' + bid, e)
      }
      try {
        // 回收站超过 30 天自动彻底清除
        const cutoff = new Date(Date.now() + TZ_MS - 30 * 86400000).toISOString()
        await db.prepare('DELETE FROM trash WHERE deleted_at < ?').bind(cutoff).run()
      } catch (e) {
        console.error('scheduled trash-clean failed book' + bid, e)
      }
    }
    // 笔记站只同步主账套
    try {
      await pushToNotes(env.DB, env)
    } catch (e) {
      console.error('scheduled push-to-notes failed', e)
    }
  }
}

// 月目标拆成每周：这周该收多少、已经收了多少、剩几天每天要收多少
app.get('/target-weeks', async (c) => {
  const db = c.env.DB
  const m = c.req.query('month') || now().slice(0, 7)
  const t = await db.prepare('SELECT * FROM targets WHERE month=?').bind(m).first()
  const tR = round2(num(t && t.receive))
  const yy = num(m.slice(0, 4))
  const mm = num(m.slice(5, 7))
  const dim = new Date(Date.UTC(yy, mm, 0)).getUTCDate()
  const todayM = now().slice(0, 7)
  const todayD = m === todayM ? num(now().slice(8, 10)) : (m < todayM ? dim : 0)
  const rs = (await db.prepare("SELECT substr(created_at,1,10) d, amount FROM ledger WHERE direction='in' AND cash=1 AND substr(created_at,1,7)=?").bind(m).all()).results || []
  const byDay = {}
  rs.forEach((r) => { const d = num(String(r.d).slice(8, 10)); byDay[d] = round2(num(byDay[d]) + num(r.amount)) })
  const spans = [[1, 7], [8, 14], [15, 21], [22, dim]]
  const rows = spans.map(([f, to], i) => {
    const days = to - f + 1
    let actual = 0
    for (let d = f; d <= to; d++) actual += num(byDay[d])
    const target = tR > 0 ? Math.round(tR * days / dim) : 0
    const state = todayD > to ? '已过完' : (todayD >= f ? '本周' : '还没到')
    const leftDays = state === '已过完' ? 0 : Math.max(1, to - Math.max(f - 1, todayD))
    const gapW = round2(target - actual)
    return {
      w: i + 1, label: '第' + (i + 1) + '周', from: m + '-' + String(f).padStart(2, '0'), to: m + '-' + String(to).padStart(2, '0'),
      days, target, actual: round2(actual), pct: target > 0 ? Math.round(actual / target * 1000) / 10 : null,
      state, gap: gapW, need_per_day: (state !== '已过完' && gapW > 0) ? round2(gapW / leftDays) : 0, left_days: leftDays
    }
  })
  const cur = rows.find((r) => r.state === '本周')
  const done = rows.filter((r) => r.state === '已过完')
  return c.json({
    ok: true, month: m, receive_target: tR, total_actual: round2(rows.reduce((a, x) => a + x.actual, 0)), rows,
    advice: tR <= 0 ? '这个月还没设目标，设了才能拆到每周。' : (cur
      ? (cur.gap <= 0 ? '这周已经收够了（多 ' + round2(-cur.gap) + ' 元）' : '这周该收 ' + cur.target + ' 元，还差 ' + cur.gap + ' 元，剩 ' + cur.left_days + ' 天每天要收 ' + cur.need_per_day + ' 元')
      : (done.length === rows.length ? '这个月过完了，共收 ' + round2(rows.reduce((a, x) => a + x.actual, 0)) + ' 元' : '这个月还没开始'))
  })
})

// 目标能不能达成：已收 + 预计还能收回的，和目标比
app.get('/target-forecast', async (c) => {
  const db = c.env.DB
  const m = c.req.query('month') || now().slice(0, 7)
  const t = await db.prepare('SELECT * FROM targets WHERE month=?').bind(m).first()
  const tR = round2(num(t && t.receive))
  const inc = await db.prepare("SELECT COALESCE(SUM(amount),0) a FROM ledger WHERE direction='in' AND cash=1 AND month=?").bind(m).first()
  const got = round2(num(inc && inc.a))
  // 回款率：近 6 个月「实收 / 开单」，下限 30%、上限 100%
  const since = (() => { const d = new Date(Date.now() + TZ_MS); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 5, 1)).toISOString().slice(0, 10) })()
  const sixIn = await db.prepare("SELECT COALESCE(SUM(amount),0) a FROM ledger WHERE direction='in' AND cash=1 AND substr(created_at,1,10)>=?").bind(since).first()
  const sixOrd = await db.prepare('SELECT COALESCE(SUM(price),0) a FROM orders WHERE substr(created_at,1,10)>=?').bind(since).first()
  const rate = Math.min(1, Math.max(0.3, num(sixOrd && sixOrd.a) > 0 ? num(sixIn && sixIn.a) / num(sixOrd && sixOrd.a) : 0.3))
  // 本月内到期的未结应收（含已逾期的）
  const yy = num(m.slice(0, 4))
  const mm = num(m.slice(5, 7))
  const monthEnd = m + '-' + String(new Date(Date.UTC(yy, mm, 0)).getUTCDate()).padStart(2, '0')
  const open = (await db.prepare("SELECT COALESCE(SUM(price - paid - COALESCE(written_off,0)),0) a, COUNT(*) n FROM orders WHERE price - paid - COALESCE(written_off,0) > 0.005 AND substr(COALESCE(due_date, created_at),1,10) <= ?").bind(monthEnd).all()).results
  const openAmt = round2(num(open && open[0] && open[0].a))
  const openCnt = num(open && open[0] && open[0].n)
  const expect = round2(openAmt * rate)
  const expectTotal = round2(got + expect)
  const gap = tR > 0 ? round2(tR - expectTotal) : null
  const willHit = tR > 0 ? expectTotal >= tR : null
  return c.json({
    ok: true, month: m, receive_target: tR, received: got, rate: Math.round(rate * 1000) / 10,
    rate_basis: { six_in: round2(num(sixIn && sixIn.a)), six_order: round2(num(sixOrd && sixOrd.a)) },
    open_amount: openAmt, open_count: openCnt, expected_more: expect, expected_total: expectTotal,
    gap, will_hit: willHit,
    note: tR <= 0 ? '这个月还没设目标。'
      : (willHit
        ? '按现在进度，月底大概能收 ' + expectTotal + ' 元，能完成目标（目标 ' + tR + '）。'
        : '按现在进度，月底大概只能收 ' + expectTotal + ' 元，离目标还差 ' + round2(tR - expectTotal) + ' 元 —— 得加把劲催款或者多接单。')
  })
})

// 目标完成情况：每月「目标 vs 实际」，看达成率
async function targetHistory(db, months) {
  const n = Math.min(24, Math.max(1, num(months) || 6))
  const out = []
  const base = new Date(Date.now() + TZ_MS)
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1))
    const m = d.toISOString().slice(0, 7)
    const t = await db.prepare('SELECT * FROM targets WHERE month=?').bind(m).first()
    const inc = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE direction='in' AND cash=1 AND month=?").bind(m).first()
    const ord = await db.prepare("SELECT COUNT(*) n, COALESCE(SUM(price),0) t FROM orders WHERE month=?").bind(m).first()
    const receive = round2(num(inc && inc.t))
    const orderAdd = round2(num(ord && ord.t))
    const tR = num(t && t.receive)
    const tO = num(t && t.order_add)
    out.push({
      month: m, label: String(num(m.slice(5, 7))) + '月',
      receive, order_add: orderAdd, order_cnt: num(ord && ord.n),
      receive_target: tR, order_target: tO,
      receive_pct: tR > 0 ? Math.round(receive / tR * 1000) / 10 : null,
      order_pct: tO > 0 ? Math.round(orderAdd / tO * 1000) / 10 : null,
      hit: tR > 0 ? receive >= tR : null
    })
  }
  const curM = now().slice(0, 7)
  const withT = out.filter((x) => x.receive_target > 0 && x.month < curM)
  const hitN = withT.filter((x) => x.hit).length
  // 下月目标建议：上一个过完月份的实收 ×1.1，取整到 500（最低 500）
  const finished = out.filter((x) => x.month < curM)
  const lastDone = finished.filter((x) => x.receive > 0 || x.order_add > 0).slice(-1)[0]
  const lastR = lastDone ? lastDone.receive : 0
  const lastO = lastDone ? lastDone.order_add : 0
  const rnd = (v, step) => Math.max(step, Math.round(v / step) * step)
  const suggest = {
    month: (() => { const d = new Date(Date.now() + TZ_MS); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 7) })(),
    receive: lastR > 0 ? rnd(lastR * 1.1, 500) : 0,
    order_add: lastO > 0 ? rnd(lastO * 1.1, 1000) : 0,
    basis: lastDone ? (lastDone.label + '实际收 ' + lastR + ' 元、接单 ' + lastO + ' 元，按 +10% 给的') : ''
  }
  return {
    rows: out, months: n, target_months: withT.length, hit_months: hitN, suggest,
    hit_rate: withT.length ? Math.round(hitN / withT.length * 1000) / 10 : null,
    advice: withT.length === 0 ? (out.some((x) => x.receive_target > 0) ? '这个月目标还在进行中，过完这个月就能看达成率了。' : '还没设过月度目标，设一个首页就有进度条。')
      : (hitN / withT.length >= 0.7 ? '设过 ' + withT.length + ' 个月目标，达成 ' + hitN + ' 个月，目标定得比较实在。'
        : '设过 ' + withT.length + ' 个月目标，只达成 ' + hitN + ' 个月 —— 要么目标偏高了，要么催款要更紧。')
  }
}

app.get('/target-history', async (c) => {
  const r = await targetHistory(c.env.DB, c.req.query('months') || 6)
  return c.json(Object.assign({ ok: true }, r))
})

// 月底最后一天推一条：这个月目标收了多少 / 差多少
// 月度催款小结：这个月催了几家、催回多少、谁还欠着、发了几份对账单
async function dunningStat(db, m) {
  const mm = String(m || now().slice(0, 7)).slice(0, 7)
  const pre = mm + '%'
  const dun = (await db.prepare('SELECT * FROM dunning_log WHERE substr(created_at,1,7)=? ORDER BY id').bind(mm).all()).results || []
  const arIn = (await db.prepare("SELECT o.customer party, l.created_at d, l.amount a FROM ledger l JOIN orders o ON l.ref_id=o.id WHERE l.direction='in' AND l.ref_type='order' AND substr(l.created_at,1,7)=?").bind(mm).all()).results || []
  const apOut = (await db.prepare("SELECT p.supplier party, l.created_at d, l.amount a FROM ledger l JOIN payables p ON l.ref_id=p.id WHERE l.direction='out' AND l.ref_type='payable' AND substr(l.created_at,1,7)=?").bind(mm).all()).results || []
  const arLeft = (await db.prepare('SELECT customer party, COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) t FROM orders WHERE price-paid-COALESCE(written_off,0) > 0 GROUP BY customer').all()).results || []
  const apLeft = (await db.prepare('SELECT supplier party, COALESCE(SUM(amount-paid-COALESCE(written_off,0)),0) t FROM payables WHERE amount-paid-COALESCE(written_off,0) > 0 GROUP BY supplier').all()).results || []
  const leftOf = (party) => {
    const a = arLeft.find((x) => norm(x.party) === norm(party))
    const b = apLeft.find((x) => norm(x.party) === norm(party))
    return round2(num(a && a.t) + num(b && b.t))
  }
  const byParty = {}
  for (const d of dun) {
    const k = norm(d.party)
    const o = byParty[k] || (byParty[k] = { party: d.party, times: 0, first: String(d.created_at).slice(0, 10), promises: [], broken: 0 })
    o.times++
    if (d.promise_date) {
      const pd = String(d.promise_date).slice(0, 10)
      o.promises.push(pd)
      if (pd < now().slice(0, 10) && leftOf(d.party) > 0.005) o.broken++
    }
  }
  const rows = Object.keys(byParty).map((k) => {
    const o = byParty[k]
    const flows = arIn.concat(apOut)
    const paid = round2(flows.filter((x) => norm(x.party) === k && String(x.d).slice(0, 10) >= o.first).reduce((a, x) => a + num(x.a), 0))
    return { party: o.party, times: o.times, first: o.first, paid_after: paid, left: leftOf(o.party), broken: o.broken, promises: o.promises }
  }).sort((a, b) => (b.left - a.left) || (b.times - a.times))
  const stl = (await db.prepare('SELECT * FROM statement_log WHERE substr(created_at,1,7)=? ORDER BY id').bind(mm).all()).results || []
  const recovered = round2(rows.reduce((a, r) => a + r.paid_after, 0))
  const cnt = rows.reduce((a, r) => a + r.times, 0)
  const leftTotal = round2(rows.reduce((a, r) => a + r.left, 0))
  const broken = rows.reduce((a, r) => a + r.broken, 0)
  return {
    month: mm, count: rows.length, times: cnt, recovered, left_total: leftTotal, broken,
    avg_per_dun: cnt ? round2(recovered / cnt) : 0,
    still: rows.filter((r) => r.left > 0.005),
    rows, statements: stl.length, statement_parties: [...new Set(stl.map((x) => x.party))]
  }
}
async function dunningMonthText(db, m) {
  const d = await dunningStat(db, m)
  const L = []
  L.push('【催款小结 ' + d.month + '】')
  L.push('催款 ' + d.times + ' 次 / ' + d.count + ' 家；催后收回 ¥' + d.recovered + '（平均一次 ¥' + d.avg_per_dun + '）')
  if (d.statements) L.push('发对账单 ' + d.statements + ' 份（' + d.statement_parties.slice(0, 5).join('、') + (d.statement_parties.length > 5 ? ' 等' : '') + '）')
  if (d.still.length) {
    L.push('还欠着的：')
    d.still.slice(0, 8).forEach((r, i) => L.push('  ' + (i + 1) + '. ' + r.party + ' 欠 ' + r.left + '，催了 ' + r.times + ' 次'))
    if (d.still.length > 8) L.push('  …还有 ' + (d.still.length - 8) + ' 家')
    L.push('共欠 ¥' + d.left_total)
  } else if (d.count) L.push('催过的家都结清了')
  if (d.broken) L.push('失约 ' + d.broken + ' 次（答应的日子过了没付）')
  if (!d.count) L.push('这个月还没记过催款（催完记得点「记一笔催款」）')
  else if (d.broken >= 2) L.push('提示：失约偏多，下次让他先付一部分再发货')
  else if (d.recovered > 0) L.push('提示：这个月催款是有效的，继续保持每周固定催一次')
  return { text: L.join('\n'), stat: d }
}
// 月底自动推一条催款小结
async function pushDunningSummary(db, mm) {
  try {
    const m = mm || now().slice(0, 7)
    const r = await dunningMonthText(db, m)
    if (!r.stat.count && !r.stat.statements) return
    await wxPush(db, { title: '这个月催款小结：收回 ¥' + r.stat.recovered, time: m, note: '催 ' + r.stat.times + ' 次、' + r.stat.count + ' 家；还欠 ¥' + r.stat.left_total + (r.stat.broken ? '；失约 ' + r.stat.broken + ' 次' : '') })
  } catch (e) { /* 没配微信就跳过 */ }
}
async function pushTargetSummary(db, mm) {
  try {
    const m = mm || now().slice(0, 7)
    const t = await db.prepare('SELECT * FROM targets WHERE month=?').bind(m).first()
    const tR = num(t && t.receive)
    if (tR <= 0) return
    const inc = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE direction='in' AND cash=1 AND substr(created_at,1,7)=?").bind(m).first()
    const got = round2(num(inc && inc.t))
    const pct = Math.round(got / tR * 1000) / 10
    const title = got >= tR ? '这个月目标达成啦（' + pct + '%）' : '这个月还差 ' + round2(tR - got) + ' 元'
    const note = '已收 ' + got + ' / 目标 ' + tR + '（' + pct + '%）'
    await wxPush(db, { title: title, time: m, note: note })
  } catch (e) { /* 没配微信提醒就不推 */ }
}

// 月度报表包生成后推一条微信：告诉老板去哪里下载
async function pushMonthPack(db, m) {
  try {
    await wxPush(db, {
      title: m + ' 全套报表已生成',
      time: m,
      note: '利润表/资产负债表/应收/应付/流水/账龄/到期表 都打包好了，报表页「月度报表包」点下载'
    })
  } catch (e) {
    /* 没配微信通知就算了，报表已经存好 */
  }
}

// 固定支出：每月号数到了就自动记一条支出（当天错过，之后几天会补记，每月只记一次）
async function runFixed(db) {
  if (await isMonthLocked(db, now().slice(0, 7))) return 0
  const accF = await defaultAccountId(db)
  const { results } = await db.prepare('SELECT * FROM fixed_expenses').all()
  const m = now().slice(0, 7)
  const todayD = Number(now().slice(8, 10))
  let n = 0
  for (const f of results) {
    if (Number(f.day) > todayD) continue
    const c = await db.prepare("SELECT COUNT(*) AS c FROM ledger WHERE ref_type='fixed' AND ref_id=? AND month=?").bind(f.id, m).first()
    if (c && c.c > 0) continue
    await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('out','fixed',?,?,?,?,?,1,?)")
      .bind(f.id, num(f.amount), f.category || '', f.remark || '固定支出', accF, now()).run()
    n++
  }
  return n
}
