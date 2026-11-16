import { Hono } from 'hono'

const app = new Hono()

app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  c.header('Access-Control-Allow-Headers', 'Content-Type,X-Access-Key,X-Book')
  await next()
})
app.options('*', (c) => c.text('', 204))

const now = () => new Date().toISOString()
const month = () => new Date().toISOString().slice(0, 7)
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const round2 = (x) => Math.round(x * 100) / 100
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
const logAudit = async (db, action, target, detail) => {
  try {
    await db.prepare('INSERT INTO audit_log (action, target, detail, created_at) VALUES (?,?,?,?)')
      .bind(action, target, detail || '', now()).run()
  } catch (e) {
    console.error('audit log failed', e)
  }
}

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
  return c.json({ ok: true })
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
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname
  if (path.startsWith('/auth/')) return next()
  // 口令只存主账套，所有账套共用一个口令
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  if (!saved) return c.json({ error: '首次使用请设置访问口令', code: 'no_key' }, 401)
  if (c.req.header('x-access-key') !== saved) return c.json({ error: '访问口令错误', code: 'bad_key' }, 401)
  await next()
})
// 把 '07-05' / '2026-07-05' / '2026/7/5' 转成 ISO 日期（本地 0 点）
const toIsoDate = (s) => {
  if (!s) return ''
  const m = String(s).trim().match(/^(\d{4})?[-/年]?(\d{1,2})[-/月](\d{1,2})日?$/)
  if (!m) return ''
  const y = m[1] || new Date().getFullYear()
  const mm = String(m[2]).padStart(2, '0')
  const dd = String(m[3]).padStart(2, '0')
  if (num(mm) < 1 || num(mm) > 12 || num(dd) < 1 || num(dd) > 31) return ''
  return `${y}-${mm}-${dd}T00:00:00.000Z`
}
const looksLikeDate = (s) => !!toIsoDate(s)
// 收款/付款日期补录：支持 YYYY-MM-DD 或 MM-DD，否则用当前时间
const normDate = (s) => {
  const t = String(s || '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t + 'T00:00:00.000Z'
  if (/^\d{1,2}-\d{1,2}$/.test(t)) {
    const [mm, dd] = t.split('-')
    return `${new Date().getFullYear()}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T00:00:00.000Z`
  }
  return now()
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
  const accs = (await db.prepare('SELECT * FROM accounts ORDER BY id').all()).results
  const out = []
  const firstId = accs.length ? accs[0].id : 0
  for (const a of accs) {
    // 未指定账户的老流水（account_id 为 0 或空）归到第一个账户，保证总余额对得上
    const pick = a.id === firstId
      ? "cash=1 AND direction='%s' AND (account_id=? OR account_id IS NULL OR account_id=0)"
      : "cash=1 AND direction='%s' AND account_id=?"
    const i = await db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE ' + pick.replace('%s', 'in')).bind(a.id).first()
    const o = await db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE ' + pick.replace('%s', 'out')).bind(a.id).first()
    const bal = round2(num(a.opening) + num(i.t) - num(o.t))
    out.push({ id: a.id, name: a.name, kind: a.kind, opening: round2(num(a.opening)), in: round2(num(i.t)), out: round2(num(o.t)), balance: bal })
  }
  return out
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
app.get('/advances', async (c) => {
  const db = c.env.DB
  const t = c.req.query('type') === 'out' ? 'out' : 'in'
  const rows = (await db.prepare('SELECT * FROM advances WHERE type=? ORDER BY id DESC').bind(t).all()).results
  return c.json(rows.map((r) => ({ ...r, remain: round2(num(r.amount) - num(r.used)) })))
})

app.post('/advances', async (c) => {
  const { type, party, amount, remark, account_id, date } = await c.req.json()
  const t = type === 'out' ? 'out' : 'in'
  const nm = String(party || '').trim()
  const a = num(amount)
  if (!nm) return c.json({ error: t === 'in' ? '客户名称必填' : '供应商名称必填' }, 400)
  if (a <= 0) return c.json({ error: '金额必须大于 0' }, 400)
  const db = c.env.DB
  if (await isMonthLocked(db, now().slice(0, 7))) return c.json({ error: '本月已结账锁定，先解锁再记账' }, 403)
  const acc = num(account_id) || (await defaultAccountId(db))
  const created = normDate(date)
  const r = await db.prepare('INSERT INTO advances (type, party, amount, used, remark, account_id, created_at) VALUES (?,?,?,0,?,?,?)')
    .bind(t, nm, a, remark || '', acc, created).run()
  const aid = r.meta && r.meta.last_row_id ? r.meta.last_row_id : 0
  await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES (?,?,?,?,?,?,?,1,?)")
    .bind(t === 'in' ? 'in' : 'out', 'advance', aid, a, t === 'in' ? '预收款' : '预付款', `${t === 'in' ? '收预收' : '付预付'} ${nm}${remark ? ' ' + remark : ''}`, acc, created).run()
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
    db.prepare('UPDATE orders SET paid=paid+? WHERE id=?').bind(total, id),
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
    db.prepare('UPDATE payables SET paid=paid+? WHERE id=?').bind(total, id),
    db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, remark, account_id, cash, created_at) VALUES ('out','payable',?,?,?,?,0,?)")
      .bind(id, total, `预付款抵扣 ${p.supplier}`, 0, now())
  ])
  await logAudit(db, '预付抵扣', p.supplier, `${p.supplier} 用预付抵扣 ¥${total}`)
  return c.json({ ok: true, applied: total })
})

// ── 多账套 ──
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
      const a = await db.prepare('SELECT COALESCE(SUM(price-paid),0) AS t FROM orders WHERE paid < price').first()
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

app.get('/dashboard', async (c) => {
  const db = c.env.DB
  const m = month()
  const ar = await db.prepare('SELECT COALESCE(SUM(price-paid),0) AS total FROM orders WHERE paid < price').first()
  const ap = await db.prepare('SELECT COALESCE(SUM(amount-paid),0) AS total FROM payables WHERE paid < amount').first()
  const inc = await db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM ledger WHERE direction='in' AND cash=1 AND substr(created_at,1,7)=?").bind(m).first()
  const out = await db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM ledger WHERE direction='out' AND cash=1 AND substr(created_at,1,7)=?").bind(m).first()
  const pending = await db.prepare('SELECT COUNT(*) AS n FROM orders WHERE status < 2').first()
  const recent = await db.prepare('SELECT * FROM ledger ORDER BY id DESC LIMIT 10').all()
  const orderAdd = await db.prepare('SELECT COALESCE(SUM(price),0) AS t FROM orders WHERE substr(created_at,1,7)=?').bind(m).first()
  const payableAdd = await db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM payables WHERE substr(created_at,1,7)=?').bind(m).first()
  const expCash = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1 AND ref_type='expense' AND substr(created_at,1,7)=?").bind(m).first()
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString()
  const overdue = await db.prepare('SELECT * FROM orders WHERE paid < price AND created_at < ? ORDER BY created_at LIMIT 5').bind(cutoff).all()
  const todayS = new Date().toISOString().slice(0, 10)
  const soonS = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
  const dueSoon = await db.prepare("SELECT * FROM orders WHERE paid < price AND due_date IS NOT NULL AND substr(due_date,1,10) <= ? AND substr(due_date,1,10) >= ? ORDER BY due_date LIMIT 8").bind(soonS, todayS).all()
  const paySoon = await db.prepare("SELECT * FROM payables WHERE paid < amount AND due_date IS NOT NULL AND substr(due_date,1,10) <= ? AND substr(due_date,1,10) >= ? ORDER BY due_date LIMIT 8").bind(soonS, todayS).all()
  const todayIn = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='in' AND cash=1 AND substr(created_at,1,10)=?").bind(todayS).first()
  const topCust = await db.prepare('SELECT customer AS nm, COALESCE(SUM(price-paid),0) AS t FROM orders WHERE paid < price GROUP BY customer ORDER BY t DESC LIMIT 1').first()
  // 预算：按分类统计本月已花，超出或接近 90% 的提醒
  const buds = await db.prepare('SELECT * FROM budgets ORDER BY id').all()
  const budgetOver = []
  for (const b of buds.results) {
    const sp = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1 AND COALESCE(NULLIF(category,''),'其他')=? AND substr(created_at,1,7)=?").bind(b.category, m).first()
    const spent = round2(num(sp.t))
    const limit = round2(num(b.amount))
    const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0
    if (pct >= 90) budgetOver.push({ category: b.category, limit, spent, pct, over: spent > limit, over_amt: spent > limit ? round2(spent - limit) : 0 })
  }
  return c.json({
    ar_total: round2(num(ar.total)),
    ap_total: round2(num(ap.total)),
    month_income: round2(num(inc.total)),
    month_outcome: round2(num(out.total)),
    month_profit: round2(num(inc.total) - num(out.total)),
    month_order_add: round2(num(orderAdd.t)),
    month_payable_add: round2(num(payableAdd.t)),
    month_expense_cash: round2(num(expCash.t)),
    profit_biz: round2(num(orderAdd.t) - num(payableAdd.t) - num(expCash.t)),
    pending_count: pending.n,
    today_income: round2(num(todayIn.t)),
    top_customer: topCust ? topCust.nm : '',
    top_unpaid: topCust ? round2(num(topCust.t)) : 0,
    overdue_count: overdue.results.length,
    overdue: overdue.results.map((r) => ({ ...r, unpaid: round2(r.price - r.paid) })),
    due_soon_count: dueSoon.results.length,
    due_soon: dueSoon.results.map((r) => ({ ...r, unpaid: round2(r.price - r.paid), due_short: (r.due_date || '').slice(0, 10) })),
    pay_soon_count: paySoon.results.length,
    pay_soon: paySoon.results.map((r) => ({ ...r, unpaid: round2(r.amount - r.paid), due_short: (r.due_date || '').slice(0, 10) })),
    recent: recent.results,
    budget_over: budgetOver,
    budget_alert_count: budgetOver.length,
    cash_balance: round2((await accountBalances(db)).reduce((s2, a) => s2 + a.balance, 0))
  })
})

// 赚没赚：两个口径对比
app.get('/profit-compare', async (c) => {
  const db = c.env.DB
  const m = String(c.req.query('month') || month()).slice(0, 7)
  const q = async (sql) => num((await db.prepare(sql).bind(m).first()).t)
  const inc = await q("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='in' AND cash=1 AND substr(created_at,1,7)=?")
  const out = await q("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1 AND substr(created_at,1,7)=?")
  const orderAdd = await q('SELECT COALESCE(SUM(price),0) AS t FROM orders WHERE substr(created_at,1,7)=?')
  const payableAdd = await q('SELECT COALESCE(SUM(amount),0) AS t FROM payables WHERE substr(created_at,1,7)=?')
  const expCash = await q("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1 AND ref_type='expense' AND substr(created_at,1,7)=?")
  const fixedCash = await q("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1 AND ref_type='fixed' AND substr(created_at,1,7)=?")
  // 现金口径：本月实际收到的钱 − 本月实际付出的钱
  const cash = num(inc) - num(out)
  // 权责口径：本月接的活 − 本月赊的料 − 本月花的现金成本（工资水电等）
  const otherCash = round2(num(out) - expCash - fixedCash) // 还供应商/其它付出
  const accrual = round2(num(orderAdd) - num(payableAdd) - expCash - fixedCash)
  return c.json({
    month: m,
    cash_income: round2(num(inc)),
    cash_outcome: round2(num(out)),
    cash_profit: round2(cash),
    order_add: round2(num(orderAdd)),
    payable_add: round2(num(payableAdd)),
    expense_cash: round2(expCash),
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

app.get('/ar', async (c) => {
  const db = c.env.DB
  const { off, lim } = pageArgs(c)
  const kw = (new URL(c.req.url).searchParams.get('kw') || '').trim()
  const base = 'SELECT * FROM orders WHERE paid < price'
  let rows
  if (kw) {
    const like = '%' + kw + '%'
    rows = await db.prepare(base + " AND (customer LIKE ? OR item_name LIKE ? OR COALESCE(operator,'') LIKE ?) ORDER BY id DESC LIMIT ? OFFSET ?")
      .bind(like, like, like, lim, off).all()
  } else {
    rows = await db.prepare(base + ' ORDER BY id DESC LIMIT ? OFFSET ?').bind(lim, off).all()
  }
  return c.json(rows.results.map((r) => ({ ...r, unpaid: round2(r.price - r.paid), due_short: (r.due_date || '').slice(0, 10) })))
})

// 应付：未结清应付单
app.get('/ap', async (c) => {
  const db = c.env.DB
  const { off, lim } = pageArgs(c)
  const kw = (new URL(c.req.url).searchParams.get('kw') || '').trim()
  const base = 'SELECT * FROM payables WHERE paid < amount'
  let rows
  if (kw) {
    const like = '%' + kw + '%'
    rows = await db.prepare(base + " AND (supplier LIKE ? OR COALESCE(remark,'') LIKE ? OR COALESCE(operator,'') LIKE ?) ORDER BY id DESC LIMIT ? OFFSET ?")
      .bind(like, like, like, lim, off).all()
  } else {
    rows = await db.prepare(base + ' ORDER BY id DESC LIMIT ? OFFSET ?').bind(lim, off).all()
  }
  return c.json(rows.results.map((r) => ({ ...r, unpaid: round2(r.amount - r.paid), due_short: (r.due_date || '').slice(0, 10) })))
})

// 支出流水
app.get('/expenses', async (c) => {
  const db = c.env.DB
  const { off, lim } = pageArgs(c)
  const kw = (new URL(c.req.url).searchParams.get('kw') || '').trim()
  let rows
  if (kw) {
    const like = '%' + kw + '%'
    rows = await db.prepare("SELECT * FROM ledger WHERE direction='out' AND (COALESCE(remark,'') LIKE ? OR COALESCE(category,'') LIKE ? OR COALESCE(operator,'') LIKE ?) ORDER BY id DESC LIMIT ? OFFSET ?")
      .bind(like, like, like, lim, off).all()
  } else {
    rows = await db.prepare("SELECT * FROM ledger WHERE direction='out' ORDER BY id DESC LIMIT ? OFFSET ?").bind(lim, off).all()
  }
  return c.json(rows.results)
})

// 记应收（加工订单）
app.post('/orders', async (c) => {
  const { customer, item_name, price, due_date, operator } = await c.req.json()
  if (!customer || num(price) <= 0) return c.json({ error: '客户和金额必填' }, 400)
  const db = c.env.DB
  if (await isMonthLocked(db, now().slice(0, 7))) return c.json({ error: '本月已结账锁定，先解锁再记账' }, 403)
  const due = toIsoDate(due_date)
  await db.prepare('INSERT INTO orders (customer, item_name, price, status, paid, due_date, operator, created_at) VALUES (?,?,?,0,0,?,?,?)')
    .bind(customer, item_name || '', num(price), due || null, String(operator || '').trim() || null, now()).run()
  await logAudit(db, '新增应收', customer, `${customer} ${item_name || ''} ¥${num(price)}`)
  return c.json({ ok: true })
})

// 收客户款（可带日期补录）
app.post('/orders/:id/receive', async (c) => {
  const id = c.req.param('id')
  const { amount, date, account_id } = await c.req.json()
  const db = c.env.DB
  const o = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first()
  if (!o) return c.json({ error: '订单不存在' }, 404)
  if (await isMonthLocked(db, (o.created_at || '').slice(0, 7))) return c.json({ error: '该订单所在月份已结账锁定' }, 403)
  const a = num(amount)
  if (a <= 0) return c.json({ error: '金额无效' }, 400)
  const acc = num(account_id) || (await defaultAccountId(db))
  await db.batch([
    db.prepare('UPDATE orders SET paid=paid+? WHERE id=?').bind(a, id),
    db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, remark, account_id, cash, created_at) VALUES ('in','order',?,?,?,?,1,?)")
      .bind(id, a, `收 ${o.customer} ${o.item_name}`, acc, normDate(date))
  ])
  await logAudit(db, '收款', o.customer, `${o.customer} 收 ¥${a}`)
  return c.json({ ok: true })
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
    'SELECT * FROM orders WHERE customer=? AND paid < price ORDER BY created_at, id'
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
      db.prepare('UPDATE orders SET paid=paid+? WHERE id=?').bind(use, o.id),
      db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, remark, account_id, cash, created_at) VALUES ('in','order',?,?,?,?,1,?)")
        .bind(o.id, use, `收 ${name} ${o.item_name}${remark ? ' ' + remark : ''}`, acc, d)
    ])
  }
  await logAudit(db, '批量收款', name, `${name} 共收 ¥${total}，核销 ${detail.length} 张单`)
  return c.json({ ok: true, total: round2(total), used: detail, rest: round2(left) })
})

// 一键催款：按客户汇总未结应收，生成可直接发微信的话术
app.get('/dunning', async (c) => {
  const db = c.env.DB
  const type = c.req.query('type') || 'ar'
  const days = num(c.req.query('days'), 30)
  const name = c.req.query('name')
  const today = Date.now()
  const lines = []
  if (type === 'ar') {
    let sql = 'SELECT customer AS nm, COUNT(*) AS cnt, SUM(price-paid) AS unpaid, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM orders WHERE paid < price'
    const binds = []
    if (name) { sql += ' AND customer=?'; binds.push(name) }
    sql += ' GROUP BY customer ORDER BY unpaid DESC'
    const { results } = await db.prepare(sql).bind(...binds).all()
    const rows = results.filter((r) => num(r.unpaid) > 0)
    if (!rows.length) return c.text('没有未结清的应收，暂时不用催款。')
    let all = 0
    for (const r of rows) {
      const od = Math.floor((today - new Date(r.oldest).getTime()) / 86400000)
      all += num(r.unpaid)
      lines.push(`${r.nm}：欠 ¥${round2(num(r.unpaid))}（${r.cnt} 单，最早一笔 ${od} 天前）`)
    }
    return c.text(
      `【应收催款清单 ${new Date().toISOString().slice(0, 10)}】\n` +
        `合计待收：¥${round2(all)}\n\n${lines.join('\n')}\n\n` +
        `—— 催款话术模板（复制后改名字发微信）——\n` +
        `${rows[0].nm}您好，麻烦对一下账：这边还有 ¥${round2(num(rows[0].unpaid))} 加工费没结（${rows[0].cnt} 单），方便的话这两天安排一下，谢谢！`
    )
  }
  // 应付：我该付谁
  const { results } = await db.prepare(
    'SELECT supplier AS nm, COUNT(*) AS cnt, SUM(amount-paid) AS unpaid, MIN(created_at) AS oldest FROM payables WHERE paid < amount GROUP BY supplier ORDER BY unpaid DESC'
  ).all()
  if (!results.length) return c.text('没有未结清的应付。')
  let all = 0
  for (const r of results) {
    all += num(r.unpaid)
    lines.push(`${r.nm}：欠 ¥${round2(num(r.unpaid))}（${r.cnt} 笔）`)
  }
  return c.text(`【应付清单 ${new Date().toISOString().slice(0, 10)}】\n合计待付：¥${round2(all)}\n\n${lines.join('\n')}`)
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
  const { supplier, amount, category, remark, operator, due_date, confirm_dup } = await c.req.json()
  if (!supplier || num(amount) <= 0) return c.json({ error: '供应商和金额必填' }, 400)
  const db = c.env.DB
  if (await isMonthLocked(db, now().slice(0, 7))) return c.json({ error: '本月已结账锁定，先解锁再记账' }, 403)
  // 防重复：同供应商 + 同金额，7 天内提醒一次
  if (!confirm_dup) {
    const since = new Date(Date.now() - 7 * 86400000).toISOString()
    const d = await db.prepare('SELECT 1 FROM payables WHERE supplier=? AND amount=? AND created_at >= ?')
      .bind(supplier, num(amount), since).first()
    if (d) return c.json({ error: `${supplier} 7 天内已经有一笔 ${num(amount)} 的应付了，确认再记一笔吗？`, dup: true }, 409)
  }
  await db.prepare('INSERT INTO payables (supplier, amount, paid, category, remark, operator, due_date, created_at) VALUES (?,?,0,?,?,?,?,?)')
    .bind(supplier, num(amount), category || '', remark || '', String(operator || '').trim() || null, toIsoDate(due_date) || null, now()).run()
  await logAudit(db, '新增应付', supplier, `${supplier} ${remark || ''} ¥${num(amount)}`)
  return c.json({ ok: true })
})

// 付供应商款（可带日期补录）
app.post('/payables/:id/pay', async (c) => {
  const id = c.req.param('id')
  const { amount, date, account_id } = await c.req.json()
  const db = c.env.DB
  const p = await db.prepare('SELECT * FROM payables WHERE id=?').bind(id).first()
  if (!p) return c.json({ error: '应付单不存在' }, 404)
  if (await isMonthLocked(db, (p.created_at || '').slice(0, 7))) return c.json({ error: '该应付单所在月份已结账锁定' }, 403)
  const a = num(amount)
  if (a <= 0) return c.json({ error: '金额无效' }, 400)
  const acc = num(account_id) || (await defaultAccountId(db))
  await db.batch([
    db.prepare('UPDATE payables SET paid=paid+? WHERE id=?').bind(a, id),
    db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('out','payable',?,?,?,?,?,1,?)")
      .bind(id, a, p.category || '', `付 ${p.supplier} ${p.remark}`, acc, normDate(date))
  ])
  await logAudit(db, '付款', p.supplier, `${p.supplier} 付 ¥${a}`)
  return c.json({ ok: true })
})

// 现付支出
app.post('/expenses', async (c) => {
  const { amount, category, remark, operator, account_id, confirm_dup } = await c.req.json()
  if (num(amount) <= 0) return c.json({ error: '金额必填' }, 400)
  const db = c.env.DB
  if (await isMonthLocked(db, now().slice(0, 7))) return c.json({ error: '本月已结账锁定，先解锁再记账' }, 403)
  // 防重复：同一天 + 同分类 + 同金额，提醒一次
  if (!confirm_dup) {
    const d = await db.prepare("SELECT 1 FROM ledger WHERE direction='out' AND cash=1 AND ref_type='expense' AND amount=? AND COALESCE(NULLIF(category,''),'其他')=? AND substr(created_at,1,10)=?")
      .bind(num(amount), category || '其他', now().slice(0, 10)).first()
    if (d) return c.json({ error: `今天已经记过一笔「${category || '其他'} ${num(amount)}」，确认再记一次吗？`, dup: true }, 409)
  }
  const acc = num(account_id) || (await defaultAccountId(db))
  await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, operator, account_id, cash, created_at) VALUES ('out','expense',0,?,?,?,?,?,1,?)")
    .bind(num(amount), category || '', remark || '', String(operator || '').trim() || null, acc, now()).run()
  await logAudit(db, '新增支出', category || '其他', `${category || '其他'} ¥${num(amount)}`)
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
app.get('/statement', async (c) => {
  const type = c.req.query('type')
  const name = c.req.query('name')
  const db = c.env.DB
  const lines = []
  let total = 0
  if (type === 'ar') {
    const { results } = await db.prepare('SELECT * FROM orders WHERE customer=? AND paid<price ORDER BY id').bind(name).all()
    lines.push(`【对账单】${name}`)
    lines.push(`共 ${results.length} 笔未结清：`)
    results.forEach((o, i) => {
      const left = o.price - o.paid
      total += left
      lines.push(`${i + 1}. ${o.item_name || '加工'} 总${o.price} 已收${o.paid} 欠${round2(left)}`)
    })
    lines.push(`合计欠款：${round2(total)} 元`)
  } else {
    const { results } = await db.prepare('SELECT * FROM payables WHERE supplier=? AND paid<amount ORDER BY id').bind(name).all()
    lines.push(`【对账单】${name}`)
    lines.push(`共 ${results.length} 笔未结清：`)
    results.forEach((p, i) => {
      const left = p.amount - p.paid
      total += left
      const desc = [p.category, p.remark].filter(Boolean).join(' ')
      lines.push(`${i + 1}. ${desc || '货款'} 总${p.amount} 已付${p.paid} 欠${round2(left)}`)
    })
    lines.push(`合计欠款：${round2(total)} 元`)
  }
  return c.json({ text: lines.join('\n') })
})

// 月度对账（按单位+月份）
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
    lines.push(`【${m} 月对账单】${name}`)
    lines.push(`期初欠：${round2(open)}`)
    lines.push(`本月新增应收：${round2(cur)}（${curCnt} 笔）`)
    lines.push(`本月已收：${round2(num(got.t))}`)
    lines.push(`期末欠：${round2(end)}`)
    const monthOrders = orders.filter((o) => o.created_at.startsWith(m + '-'))
    if (monthOrders.length) {
      lines.push(`本月明细：`)
      monthOrders.forEach((o, i) => lines.push(`${i + 1}. ${o.item_name || '加工'} 总${o.price} 已收${o.paid}`))
    }
  } else {
    const { results: pays } = await db.prepare('SELECT * FROM payables WHERE supplier=? ORDER BY id').bind(name).all()
    let open = 0, cur = 0, curCnt = 0
    for (const p of pays) {
      if (p.created_at < m + '-01') open += p.amount - p.paid
      else if (p.created_at.startsWith(m + '-')) { cur += p.amount; curCnt++ }
    }
    const paid = await db.prepare("SELECT COALESCE(SUM(l.amount),0) AS t FROM ledger l JOIN payables p ON l.ref_id=p.id WHERE l.direction='out' AND l.ref_type='payable' AND p.supplier=? AND l.created_at LIKE ?").bind(name, prefix).first()
    const end = open + cur - num(paid.t)
    lines.push(`【${m} 月对账单】${name}`)
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
  }
  return c.json({ text: lines.join('\n') })
})

// 一句话记账：收/付/分类 自动识别
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
  await logAudit(db, '一句话记账', '', summary)
  return c.json({ ok: true, summary })
})

// 批量导入
app.post('/import', async (c) => {
  const { type, text } = await c.req.json()
  const rows = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean)
  if (!rows.length) return c.json({ error: '没有可导入的内容' }, 400)
  const db = c.env.DB
  let n = 0
  let skippedLocked = 0
  const t = now()
  for (const row of rows) {
    let p = row.split(/[,，\t]/).map((s) => s.trim())
    // 最后一列若是日期，单独取出；否则按今天
    let d = t
    if (p.length > 1 && looksLikeDate(p[p.length - 1])) {
      d = toIsoDate(p.pop())
    } else if (type === 'ar_init' || type === 'ap_init') {
      // 期初余额：不带日期就记到今年 1 月 1 日（表示“以前欠下的”）
      d = `${new Date().getFullYear()}-01-01T00:00:00.000Z`
    }
    if (await isMonthLocked(db, (d || '').slice(0, 7))) { skippedLocked++; continue }
    if (type === 'ar') {
      const [customer, item, price] = p
      if (customer && num(price) > 0) {
        await db.prepare('INSERT INTO orders (customer, item_name, price, status, paid, created_at) VALUES (?,?,?,0,0,?)')
          .bind(customer, item || '批量导入', num(price), d).run()
        n++
      }
    } else if (type === 'ar_init') {
      const [customer, price] = p
      if (customer && num(price) > 0) {
        await db.prepare('INSERT INTO orders (customer, item_name, price, status, paid, created_at) VALUES (?,?,?,0,0,?)')
          .bind(customer, '期初欠款', num(price), d).run()
        n++
      }
    } else if (type === 'ap') {
      const [supplier, amount, remark] = p
      if (supplier && num(amount) > 0) {
        await db.prepare('INSERT INTO payables (supplier, amount, paid, category, remark, created_at) VALUES (?,?,0,?,?,?)')
          .bind(supplier, num(amount), '', remark || '', d).run()
        n++
      }
    } else if (type === 'ap_init') {
      const [supplier, amount] = p
      if (supplier && num(amount) > 0) {
        await db.prepare('INSERT INTO payables (supplier, amount, paid, category, remark, created_at) VALUES (?,?,0,?,?,?)')
          .bind(supplier, num(amount), '', '期初欠款', d).run()
        n++
      }
    } else if (type === 'expense') {
      const [amount, category, remark] = p
      if (num(amount) > 0) {
        const accI = await defaultAccountId(db)
        await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('out','expense',0,?,?,?,?,1,?)")
          .bind(num(amount), category || '', remark || '', accI, d).run()
        n++
      }
    }
  }
  await logAudit(db, '批量导入', type, `导入 ${n} 条${skippedLocked ? `，跳过锁定 ${skippedLocked} 条` : ''}`)
  return c.json({ imported: n, skipped_locked: skippedLocked })
})

// 年度流水报表
app.get('/report', async (c) => {
  const y = String(c.req.query('year') || new Date().getFullYear())
  const db = c.env.DB
  const prefix = y + '-%'
  const lines = []
  lines.push(`【${y} 年度流水报表】`)
  const pad = (s, n) => String(s).padEnd(n, ' ')
  const fmt = (n) => String(round2(n))
  // 按月汇总
  const { results: monthly } = await db.prepare(
    "SELECT substr(created_at,1,7) AS m, SUM(CASE WHEN direction='in' THEN amount ELSE 0 END) AS inc, SUM(CASE WHEN direction='out' THEN amount ELSE 0 END) AS out FROM ledger WHERE cash=1 AND created_at LIKE ? GROUP BY m ORDER BY m"
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
    "SELECT COALESCE(NULLIF(category,''),'其他') AS c, SUM(amount) AS t FROM ledger WHERE direction='out' AND cash=1 AND created_at LIKE ? GROUP BY c ORDER BY t DESC"
  ).bind(prefix).all()
  lines.push('')
  lines.push('【支出分类】')
  for (const r of cats) lines.push(`${r.c}：${fmt(num(r.t))}`)
  if (!cats.length) lines.push('（无支出）')
  // 应收应付
  const ar = await db.prepare('SELECT COALESCE(SUM(price-paid),0) AS t FROM orders WHERE paid < price').first()
  const ap = await db.prepare('SELECT COALESCE(SUM(amount-paid),0) AS t FROM payables WHERE paid < amount').first()
  const inAll = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='in' AND cash=1").first()
  const outAll = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1").first()
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
    rows.push(['日期', '客户', '产品/项目', '金额', '已收', '未收', '状态', '进度', '到期日', '经手人'])
    const { results } = await db.prepare('SELECT * FROM orders ORDER BY id').all()
    const st = (s) => (s == 2 ? '已交付' : s == 1 ? '加工中' : '待加工')
    for (const o of results) rows.push([o.created_at.slice(0, 10), o.customer, o.item_name, o.price, o.paid, round2(o.price - o.paid), st(o.status), o.progress || '', (o.due_date || '').slice(0, 10), o.operator || ''])
  } else if (type === 'payables') {
    rows.push(['日期', '供应商', '金额', '已付', '未付', '分类', '备注', '约定付款日', '经手人'])
    const { results } = await db.prepare('SELECT * FROM payables ORDER BY id').all()
    for (const p of results) rows.push([p.created_at.slice(0, 10), p.supplier, p.amount, p.paid, round2(p.amount - p.paid), p.category, p.remark, (p.due_date || '').slice(0, 10), p.operator || ''])
  } else {
    rows.push(['日期', '方向', '金额', '分类', '备注', '账户', '经手人'])
    const { results } = await db.prepare('SELECT * FROM ledger WHERE cash=1 ORDER BY id').all()
    const accs = (await db.prepare('SELECT id,name FROM accounts').all()).results
    const accName = (id) => (accs.find((a) => a.id === id) || {}).name || ''
    for (const l of results) rows.push([l.created_at.slice(0, 10), l.direction === 'in' ? '收' : '付', l.amount, l.category, l.remark, accName(l.account_id), l.operator || ''])
  }
  const text = '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\n')
  return c.json({ text, filename: `factory-${type}-${new Date().toISOString().slice(0, 10)}.csv` })
})

// 报表图表数据（按月收入/支出）
app.get('/report-data', async (c) => {
  const y = String(c.req.query('year') || new Date().getFullYear())
  const db = c.env.DB
  const { results } = await db.prepare(
    "SELECT substr(created_at,1,7) AS m, SUM(CASE WHEN direction='in' THEN amount ELSE 0 END) AS inc, SUM(CASE WHEN direction='out' THEN amount ELSE 0 END) AS out FROM ledger WHERE cash=1 AND created_at LIKE ? GROUP BY m ORDER BY m"
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
  const today = new Date().toISOString().slice(0, 10)
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
  return c.json(list)
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
  const stat = async (m) => {
    const inc = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='in' AND cash=1 AND substr(created_at,1,7)=?").bind(m).first()
    const out = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1 AND substr(created_at,1,7)=?").bind(m).first()
    const oadd = await db.prepare('SELECT COALESCE(SUM(price),0) AS t FROM orders WHERE substr(created_at,1,7)=?').bind(m).first()
    const padd = await db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM payables WHERE substr(created_at,1,7)=?').bind(m).first()
    return {
      month: m,
      income: round2(num(inc.t)),
      outcome: round2(num(out.t)),
      net: round2(num(inc.t) - num(out.t)),
      order_add: round2(num(oadd.t)),
      payable_add: round2(num(padd.t))
    }
  }
  return c.json({ cur: await stat(base), prev: await stat(prev), last_year: await stat(lastYear) })
})

// 数据自检：账实是否对得上
app.get('/selfcheck', async (c) => {
  const db = c.env.DB
  const issues = []
  const { results: orders } = await db.prepare('SELECT * FROM orders').all()
  const { results: inSum } = await db.prepare("SELECT ref_id, COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='in' AND ref_type='order' GROUP BY ref_id").all()
  const { results: payables } = await db.prepare('SELECT * FROM payables').all()
  const { results: outSum } = await db.prepare("SELECT ref_id, COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND ref_type='payable' GROUP BY ref_id").all()
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
  const arRow = await db.prepare('SELECT COALESCE(SUM(price-paid),0) AS t FROM orders WHERE paid < price').first()
  const arFlow = await db.prepare('SELECT COALESCE(SUM(price),0) AS a, COALESCE(SUM(paid),0) AS p FROM orders').first()
  const flowIn = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='in' AND cash=1").first()
  const flowOut = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1").first()
  const apRow = await db.prepare('SELECT COALESCE(SUM(amount-paid),0) AS t FROM payables WHERE paid < amount').first()
  return c.json({
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
    issues
  })
})

// 编辑应收单
app.patch('/orders/:id', async (c) => {
  const id = c.req.param('id')
  const { customer, item_name, price } = await c.req.json()
  const db = c.env.DB
  const o = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first()
  if (!o) return c.json({ error: '订单不存在' }, 404)
  if (await isMonthLocked(db, (o.created_at || '').slice(0, 7))) return c.json({ error: '该订单所在月份已结账锁定' }, 403)
  const p = num(price, o.price)
  if (p < num(o.paid)) return c.json({ error: '金额不能小于已收款' }, 400)
  await db.prepare('UPDATE orders SET customer=?, item_name=?, price=? WHERE id=?')
    .bind(customer || o.customer, item_name || o.item_name, p, id).run()
  await logAudit(db, '编辑应收', customer || o.customer, `${customer || o.customer} ${item_name || o.item_name} ¥${p}`)
  return c.json({ ok: true })
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
  const { supplier, amount, remark, due_date } = await c.req.json()
  const db = c.env.DB
  const p = await db.prepare('SELECT * FROM payables WHERE id=?').bind(id).first()
  if (!p) return c.json({ error: '应付单不存在' }, 404)
  if (await isMonthLocked(db, (p.created_at || '').slice(0, 7))) return c.json({ error: '该应付单所在月份已结账锁定' }, 403)
  const a = num(amount, p.amount)
  if (a < num(p.paid)) return c.json({ error: '金额不能小于已付款' }, 400)
  const nd = due_date !== undefined ? (toIsoDate(due_date) || null) : (p.due_date || null)
  await db.prepare('UPDATE payables SET supplier=?, amount=?, remark=?, due_date=? WHERE id=?')
    .bind(supplier || p.supplier, a, remark !== undefined ? remark : p.remark, nd, id).run()
  await logAudit(db, '编辑应付', supplier || p.supplier, `${supplier || p.supplier} ¥${a}`)
  return c.json({ ok: true })
})

// 编辑现付支出流水
app.patch('/ledger/:id', async (c) => {
  const id = c.req.param('id')
  const { amount, category, remark } = await c.req.json()
  const db = c.env.DB
  const l = await db.prepare("SELECT * FROM ledger WHERE id=? AND ref_type='expense'").bind(id).first()
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
  const l = await db.prepare("SELECT * FROM ledger WHERE id=? AND ref_type='expense'").bind(id).first()
  if (!l) return c.json({ error: '支出记录不存在' }, 404)
  if (await isMonthLocked(db, (l.created_at || '').slice(0, 7))) return c.json({ error: '该支出所在月份已结账锁定' }, 403)
  const b = uid()
  await intoTrash(db, 'ledger', l.id, l, b)
  await db.prepare("DELETE FROM ledger WHERE id=? AND ref_type='expense'").bind(id).run()
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

// 单位列表（客户/供应商汇总）
app.get('/contacts', async (c) => {
  const db = c.env.DB
  const ar = await db.prepare(
    "SELECT customer AS name, SUM(price) AS total, SUM(paid) AS paid, SUM(price-paid) AS unpaid, COUNT(*) AS cnt FROM orders GROUP BY customer ORDER BY unpaid DESC"
  ).all()
  const ap = await db.prepare(
    "SELECT supplier AS name, SUM(amount) AS total, SUM(paid) AS paid, SUM(amount-paid) AS unpaid, COUNT(*) AS cnt FROM payables GROUP BY supplier ORDER BY unpaid DESC"
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
    lines.push(`【${name} · 往来明细】`)
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
    lines.push(`【${name} · 往来明细】`)
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
async function buildBackup(db) {
  const orders = await db.prepare('SELECT * FROM orders ORDER BY id').all()
  const payables = await db.prepare('SELECT * FROM payables ORDER BY id').all()
  const ledger = await db.prepare('SELECT * FROM ledger ORDER BY id').all()
  return JSON.stringify({
    exported_at: now(),
    orders: orders.results,
    payables: payables.results,
    ledger: ledger.results
  }, null, 2)
}

// ── 备份到笔记站（md.1211.cc.cd）──
async function buildMarkdown(db) {
  const orders = await db.prepare('SELECT * FROM orders ORDER BY id').all()
  const payables = await db.prepare('SELECT * FROM payables ORDER BY id').all()
  const ledger = await db.prepare('SELECT * FROM ledger ORDER BY id').all()
  const ar = await db.prepare('SELECT COALESCE(SUM(price-paid),0) AS t FROM orders WHERE paid < price').first()
  const ap = await db.prepare('SELECT COALESCE(SUM(amount-paid),0) AS t FROM payables WHERE paid < amount').first()
  const inAll = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='in' AND cash=1").first()
  const outAll = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1").first()
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
    stmts.push(db.prepare('INSERT INTO orders (id, customer, item_name, price, status, paid, due_date, operator, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(num(o.id) || null, o.customer, o.item_name || '', num(o.price), num(o.status) || 0, num(o.paid) || 0, o.due_date || null, o.operator || null, o.created_at || now()))
  }
  for (const p of payables) {
    if (!p.supplier || num(p.amount) <= 0) { skipped.payables++; continue }
    stmts.push(db.prepare('INSERT INTO payables (id, supplier, amount, paid, category, remark, operator, due_date, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(num(p.id) || null, p.supplier, num(p.amount), num(p.paid) || 0, p.category || '', p.remark || '', p.operator || null, p.due_date || null, p.created_at || now()))
  }
  for (const l of ledger) {
    if (num(l.amount) <= 0 || !l.direction) { skipped.ledger++; continue }
    stmts.push(db.prepare('INSERT INTO ledger (id, direction, ref_type, ref_id, amount, category, remark, operator, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(num(l.id) || null, l.direction, l.ref_type || '', num(l.ref_id) || 0, num(l.amount), l.category || '', l.remark || '', l.operator || null, l.created_at || now()))
  }
  await runBatch(db, stmts)
  await logAudit(db, '数据恢复', '', `恢复 应收${orders.length - skipped.orders} 应付${payables.length - skipped.payables} 流水${ledger.length - skipped.ledger}`)
  return c.json({ ok: true, restored: { orders: orders.length - skipped.orders, payables: payables.length - skipped.payables, ledger: ledger.length - skipped.ledger }, skipped })
})


// ── 第二档：家底 / 账龄 / 月度归档 / 报表抬头 / 财务指标 ──
const monthList = (n) => {
  const out = []
  const d = new Date()
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(d.getFullYear(), d.getMonth() - i, 1)
    out.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`)
  }
  return out
}
const cashAtEnd = async (db, m) => {
  const accs = await accountBalances(db)
  const opening = accs.reduce((s, a) => s + num(a.opening), 0)
  const i = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND direction='in' AND substr(created_at,1,7)<=?").bind(m).first()
  const o = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND direction='out' AND substr(created_at,1,7)<=?").bind(m).first()
  return round2(opening + num(i.t) - num(o.t))
}
const arAtEnd = async (db, m) => {
  const a = await db.prepare("SELECT COALESCE(SUM(price),0) t FROM orders WHERE substr(created_at,1,7)<=?").bind(m).first()
  const b = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE direction='in' AND ref_type='order' AND substr(created_at,1,7)<=?").bind(m).first()
  return round2(Math.max(num(a.t) - num(b.t), 0))
}
const apAtEnd = async (db, m) => {
  const a = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM payables WHERE substr(created_at,1,7)<=?").bind(m).first()
  const b = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE direction='out' AND ref_type='payable' AND substr(created_at,1,7)<=?").bind(m).first()
  return round2(Math.max(num(a.t) - num(b.t), 0))
}

// 家底：每月末 现金 + 别人欠我 − 我欠别人
app.get('/networth', async (c) => {
  const db = c.env.DB
  const n = Math.min(Math.max(num(c.req.query('months'), 12) || 12, 3), 36)
  const out = []
  for (const m of monthList(n)) {
    const cash = await cashAtEnd(db, m)
    const ar = await arAtEnd(db, m)
    const ap = await apAtEnd(db, m)
    out.push({ m, cash, ar, ap, net: round2(cash + ar - ap) })
  }
  return c.json(out)
})

// 账龄分析 + 坏账准备建议
app.get('/aging', async (c) => {
  const db = c.env.DB
  const type = c.req.query('type') === 'ap' ? 'ap' : 'ar'
  const rows = type === 'ar'
    ? (await db.prepare("SELECT id, customer AS party, (price - paid) AS unpaid, created_at FROM orders WHERE paid < price ORDER BY created_at").all()).results
    : (await db.prepare("SELECT id, supplier AS party, (amount - paid) AS unpaid, created_at FROM payables WHERE paid < amount ORDER BY created_at").all()).results
  const buckets = [
    { key: 'd30', label: '30 天内', amount: 0, cnt: 0 },
    { key: 'd60', label: '31-60 天', amount: 0, cnt: 0 },
    { key: 'd90', label: '61-90 天', amount: 0, cnt: 0 },
    { key: 'd999', label: '90 天以上', amount: 0, cnt: 0 }
  ]
  const today = Date.now()
  const detail = []
  for (const r of rows) {
    const t = Date.parse(r.created_at || '') || today
    const days = Math.max(Math.floor((today - t) / 86400000), 0)
    const amt = round2(num(r.unpaid))
    const idx = days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3
    buckets[idx].amount = round2(buckets[idx].amount + amt)
    buckets[idx].cnt++
    detail.push({ id: r.id, party: r.party, amount: amt, days })
  }
  const total = round2(buckets.reduce((s, b) => s + b.amount, 0))
  // 坏账准备建议：61-90 天按 10%，90 天以上按 30%（只对"别人欠我"）
  const provision = type === 'ar' ? round2(buckets[2].amount * 0.1 + buckets[3].amount * 0.3) : 0
  detail.sort((a, b) => b.days - a.days)
  return c.json({ type, total, buckets, provision, worst: detail.slice(0, 8), over60: round2(buckets[2].amount + buckets[3].amount) })
})

// 报表抬头（厂名 / 备注）
app.get('/report-head', async (c) => {
  const db = c.env.DB
  const rows = (await db.prepare("SELECT key, value FROM settings WHERE key IN ('report_title','report_note')").all()).results
  const g = (k) => (rows.find((r) => r.key === k) || {}).value || ''
  return c.json({ title: g('report_title'), note: g('report_note') })
})
app.post('/report-head', async (c) => {
  const { title, note } = await c.req.json()
  const db = c.env.DB
  const put = async (k, v) => {
    const has = await db.prepare('SELECT 1 FROM settings WHERE key=?').bind(k).first()
    if (has) await db.prepare('UPDATE settings SET value=? WHERE key=?').bind(v, k).run()
    else await db.prepare('INSERT INTO settings (key, value) VALUES (?,?)').bind(k, v).run()
  }
  await put('report_title', String(title || '').slice(0, 30))
  await put('report_note', String(note || '').slice(0, 60))
  return c.json({ ok: true })
})

// 月度归档：一个月收了多少、花了多少、钱花在哪、月底还剩多少
app.get('/month-report', async (c) => {
  const db = c.env.DB
  let m = String(c.req.query('month') || '').slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(m)) m = now().slice(0, 7)
  const inc = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND direction='in' AND substr(created_at,1,7)=?").bind(m).first()
  const out = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND direction='out' AND substr(created_at,1,7)=?").bind(m).first()
  const oAdd = await db.prepare("SELECT COALESCE(SUM(price),0) t FROM orders WHERE substr(created_at,1,7)=?").bind(m).first()
  const pAdd = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM payables WHERE substr(created_at,1,7)=?").bind(m).first()
  const cats = (await db.prepare("SELECT COALESCE(NULLIF(category,''),'其他') c, SUM(amount) t FROM ledger WHERE cash=1 AND direction='out' AND substr(created_at,1,7)=? GROUP BY c ORDER BY t DESC").bind(m).all()).results
  const cash = await cashAtEnd(db, m)
  const ar = await arAtEnd(db, m)
  const ap = await apAtEnd(db, m)
  const head = await db.prepare("SELECT key, value FROM settings WHERE key='report_title'").first()
  const lines = []
  lines.push(`【${(head && head.value) || '加工费记账'}】${m} 月度归档`)
  lines.push(`—— 收支 ——`)
  lines.push(`本月收款：¥${round2(num(inc.t))}`)
  lines.push(`本月付款：¥${round2(num(out.t))}`)
  lines.push(`本月结余：¥${round2(num(inc.t) - num(out.t))}`)
  lines.push(`—— 业务 ——`)
  lines.push(`新接单：¥${round2(num(oAdd.t))}`)
  lines.push(`新赊购：¥${round2(num(pAdd.t))}`)
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
    order_add: round2(num(oAdd.t)), payable_add: round2(num(pAdd.t)), cats: cats.map((r) => ({ c: r.c, t: round2(num(r.t)) })),
    cash, ar, ap, net_worth: round2(cash + ar - ap), title: (head && head.value) || '', text: lines.join('\n')
  })
})

// 财务指标
app.get('/kpi', async (c) => {
  const db = c.env.DB
  let m = String(c.req.query('month') || '').slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(m)) m = now().slice(0, 7)
  const oAdd = num((await db.prepare("SELECT COALESCE(SUM(price),0) t FROM orders WHERE substr(created_at,1,7)=?").bind(m).first()).t)
  const pAdd = num((await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM payables WHERE substr(created_at,1,7)=?").bind(m).first()).t)
  const cashCost = num((await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND direction='out' AND substr(created_at,1,7)=?").bind(m).first()).t)
  const cashIn = num((await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND direction='in' AND substr(created_at,1,7)=?").bind(m).first()).t)
  const profit = round2(oAdd - pAdd - cashCost)
  const margin = oAdd > 0 ? round2((profit / oAdd) * 100) : 0
  // 平均回款天数：已收完的单 从开单到收清的平均天数
  const paidOrders = (await db.prepare("SELECT o.id, o.created_at, MAX(l.created_at) last_pay FROM orders o JOIN ledger l ON l.ref_type='order' AND l.ref_id=o.id AND l.direction='in' WHERE o.paid >= o.price GROUP BY o.id").all()).results
  let sumD = 0, cntD = 0
  for (const o of paidOrders) {
    const a = Date.parse(o.created_at || ''); const b = Date.parse(o.last_pay || '')
    if (a && b && b >= a) { sumD += (b - a) / 86400000; cntD++ }
  }
  const avg_days = cntD ? round2(sumD / cntD) : 0
  // 应收周转天数：期末应收 / 近 3 个月平均月收款 × 30
  const in3 = num((await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND direction='in' AND substr(created_at,1,7)<=? AND substr(created_at,1,7)>=?").bind(m, monthList(3)[0]).first()).t)
  const ar = await arAtEnd(db, m)
  const turnDays = in3 > 0 ? round2((ar / (in3 / 3)) * 30) : 0
  // 现金安全垫：现金余额 / 近 3 个月平均月支出
  const out3 = num((await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND direction='out' AND substr(created_at,1,7)<=? AND substr(created_at,1,7)>=?").bind(m, monthList(3)[0]).first()).t)
  const cashNow = round2((await accountBalances(db)).reduce((s, a) => s + a.balance, 0))
  const cushion = out3 > 0 ? round2(cashNow / (out3 / 3)) : 0
  // 客户集中度：本月收款里最大客户占比
  const byCust = (await db.prepare("SELECT o.customer c, SUM(l.amount) t FROM ledger l JOIN orders o ON l.ref_id=o.id WHERE l.direction='in' AND l.ref_type='order' AND substr(l.created_at,1,7)=? GROUP BY o.customer ORDER BY t DESC").bind(m).all()).results
  const topCust = byCust.length ? byCust[0] : null
  const conc = cashIn > 0 && topCust ? round2((num(topCust.t) / cashIn) * 100) : 0
  return c.json({
    month: m, order_add: round2(oAdd), payable_add: round2(pAdd), cash_cost: round2(cashCost), profit, margin,
    avg_days, ar_end: ar, turn_days: turnDays, cash_now: cashNow, cushion_months: cushion,
    top_customer: topCust ? topCust.c : '', conc_pct: conc
  })
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
    const books = [['1', env.DB], ['2', env.DB2], ['3', env.DB3]]
    for (const [bid, db] of books) {
      if (!db) continue
      try {
        await runFixed(db)
      } catch (e) {
        console.error('scheduled fixed failed book' + bid, e)
      }
      try {
        await saveBackup(db)
      } catch (e) {
        console.error('scheduled backup failed book' + bid, e)
      }
      try {
        // 回收站超过 30 天自动彻底清除
        const cutoff = new Date(Date.now() - 30 * 86400000).toISOString()
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
    const c = await db.prepare("SELECT COUNT(*) AS c FROM ledger WHERE ref_type='fixed' AND ref_id=? AND substr(created_at,1,7)=?").bind(f.id, m).first()
    if (c && c.c > 0) continue
    await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('out','fixed',?,?,?,?,?,1,?)")
      .bind(f.id, num(f.amount), f.category || '', f.remark || '固定支出', accF, now()).run()
    n++
  }
  return n
}
