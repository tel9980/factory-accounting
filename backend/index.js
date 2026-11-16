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
  if (path === '/' || path.startsWith('/auth/') || path === '/statement-print') return next()
  // 口令只存主账套，所有账套共用一个口令
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const saved = await getKey(mainDb)
  if (!saved) return c.json({ error: '首次使用请设置访问口令', code: 'no_key' }, 401)
  const given = String(c.req.header('x-access-key') || '')
  let role = ''
  if (given && given === saved) role = 'owner'
  else {
    const staff = await getStaffKey(mainDb)
    if (staff && given === staff) role = 'staff'
  }
  if (!role) return c.json({ error: '访问口令错误', code: 'bad_key' }, 401)
  // 员工权限：只能记账/收付/查询，不能删改单、不能看毛利与成本、不能改设置
  if (role === 'staff') {
    const m = c.req.method
    const denyStaff = m === 'PATCH' || m === 'DELETE' ||
      (/^\/(profit-compare|aging|weekly-text|backup|backup-list|backup-get|cloud-backup|restore|backup-to-notes)$/.test(path) && m !== 'OPTIONS') ||
      (/^\/auth\/(change|staff)$/.test(path)) ||
      (/^\/(report-head|book-name|wx-config)$/.test(path)) ||
      (/^\/month-lock/.test(path)) ||
      (/^\/accounts/.test(path) && m !== 'GET') ||
      (/^\/categories/.test(path) && m !== 'GET') ||
      (/^\/budgets/.test(path) && m !== 'GET') ||
      (/^\/fixed/.test(path) && m !== 'GET' && path !== '/run-fixed') ||
      ((/^\/debts/.test(path) || /^\/credit-limits/.test(path)) && m !== 'OPTIONS') ||
      (/^\/prepaids/.test(path) && m !== 'GET') ||
      (/^\/run-(amort|accrual)$/.test(path)) ||
      (/^\/transfers/.test(path) && m !== 'GET') ||
      (/^\/writeoffs/.test(path) && m !== 'GET') ||
      (/^\/assets/.test(path) && m !== 'GET') ||
      (/^\/trash/.test(path) && m !== 'GET')
    if (denyStaff) return c.json({ error: '这是老板才能用的功能（员工口令不能删改单据、看不到毛利）', code: 'staff_denied' }, 403)
  }
  c.set('role', role)
  await next()
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
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(party)} ${label} ${esc(from)}~${esc(to)}</title>
<style>
@page { size: A4; margin: 14mm 12mm; }
* { box-sizing: border-box; }
body { font-family: "Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif; color:#111; margin:0; padding:18px; background:#f4f5f7; }
.sheet { background:#fff; max-width:210mm; margin:0 auto; padding:14mm 12mm; box-shadow:0 2px 14px rgba(0,0,0,.12); }
h1 { font-size: 22px; text-align:center; margin:0 0 4px; letter-spacing:2px; }
.sub { text-align:center; font-size:12px; color:#666; margin-bottom:14px; }
.meta { display:flex; justify-content:space-between; font-size:13px; margin:10px 0; border-bottom:1px solid #ddd; padding-bottom:8px; }
table { width:100%; border-collapse:collapse; font-size:12.5px; }
th,td { border:1px solid #bbb; padding:6px 8px; }
th { background:#f0f2f5; font-weight:600; }
td.n { text-align:right; font-variant-numeric: tabular-nums; }
td.b { font-weight:700; }
.sum { margin-top:12px; font-size:13px; }
.sum table { width:auto; min-width:60%; margin-left:auto; }
.sum td { border:none; padding:4px 10px; }
.sum .big { font-size:15px; font-weight:700; color:#b3261e; }
.foot { margin-top:26px; display:flex; justify-content:space-between; font-size:12.5px; color:#333; }
.sign { border-top:1px solid #999; padding-top:6px; width:42%; }
.tip { text-align:center; font-size:12px; color:#888; margin-top:18px; }
.btn { display:block; width:200px; margin:16px auto 0; padding:12px; text-align:center; background:#1f6feb; color:#fff; border-radius:8px; text-decoration:none; font-size:15px; }
@media print { body { background:#fff; padding:0; } .sheet { box-shadow:none; padding:0; margin:0; } .btn,.tip { display:none; } }
</style></head><body>
<div class="sheet">
<h1>${esc(t.title || '对账单')}</h1>
<div class="sub">${label}（打印版 · A4）</div>
<div class="meta"><div>${who}：<b>${esc(party)}</b></div><div>账期：${esc(from)} 至 ${esc(to)}</div></div>
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
<div class="foot"><div class="sign">对账单位签章：</div><div class="sign">制表：${esc(t.title || '')}　${esc(today)}</div></div>
<a class="btn" href="javascript:window.print()">🖨 打印 / 存为 PDF</a>
<div class="tip">手机上：右上角「…」→ 发送给朋友或用浏览器打开 → 打印</div>
</div></body></html>`
  return c.html(html)
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
      const has = await db.prepare("SELECT id FROM ledger WHERE ref_type='amort' AND ref_id=? AND substr(created_at,1,7)=?").bind(p.id, dueMonth).first()
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
    const has = await db.prepare("SELECT id FROM ledger WHERE ref_type='debt_int' AND ref_id=? AND substr(created_at,1,7)=?").bind(d.id, cur).first()
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
app.get('/me', async (c) => {
  const role = c.get('role') || 'owner'
  const mainDb = (c.env.ENV_ALL && c.env.ENV_ALL.DB) || c.env.DB
  const staff = await getStaffKey(mainDb)
  return c.json({ role, book: c.env.BOOK || '1', staff_enabled: !!staff })
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
    const rows = (await db.prepare("SELECT key, value FROM settings WHERE key IN ('report_title','report_note')").all()).results
    const g = (k) => { const r = rows.find((x) => x.key === k); return r ? r.value : '' }
    return { title: g('report_title') || '加工厂', note: g('report_note') || '' }
  } catch (e) { return { title: '加工厂', note: '' } }
}
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
    return `${new Date().getFullYear()}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T00:00:00.000Z`
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
  const soon = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
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
  return c.json({ appid: cfg.appid, has_secret: !!cfg.secret, tpl: cfg.tpl, fields: cfg.fields, users: num(u && u.n), quota: num(u && u.q) })
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

function sheetXml(rows) {
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const colName = (i) => {
    let s = ''
    let n = i + 1
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) }
    return s
  }
  const body = rows.map((r, ri) => '<row r="' + (ri + 1) + '">' + r.map((v, ci) => '<c r="' + colName(ci) + (ri + 1) + '" t="inlineStr"><is><t xml:space="preserve">' + esc(v) + '</t></is></c>').join('') + '</row>').join('')
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="8" width="16" customWidth="1"/></cols><sheetData>' + body + '</sheetData></worksheet>'
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
  sheets.forEach((sh, i) => files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: sheetXml(sh.rows || []) }))
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
  ar: { name: '应收导入模板', rows: [['客户', '产品', '金额', '日期(可空)'], ['张老板', '外壳加工', 5000, '11-05'], ['李老板', '法兰件', 3200, '']] },
  ar_init: { name: '期初应收模板', rows: [['客户', '金额', '日期(可空)'], ['张老板', 5000, ''], ['李老板', 3000, '07-01']] },
  ap: { name: '应付导入模板', rows: [['供应商', '金额', '备注', '日期(可空)'], ['王五金', 2000, '螺丝款', '11-05'], ['李钢材', 5000, '钢板', '']] },
  ap_init: { name: '期初应付模板', rows: [['供应商', '金额', '日期(可空)'], ['王五金', 2000, ''], ['李钢材', 5000, '']] },
  expense: { name: '支出导入模板', rows: [['金额', '分类', '备注', '日期(可空)'], [1200, '房租', '8月房租', '11-01'], [300, '水电', '电费', '']] },
  loan: { name: '员工借支模板', rows: [['员工', '金额', '备注', '日期(可空)'], ['张三', 1000, '买辅料', '11-05'], ['李四', 500, '加油', '']] },
  reimb: { name: '报销模板', rows: [['员工', '金额', '分类', '备注', '日期(可空)'], ['张三', 800, '采购', '买螺丝', '11-06'], ['张三', 200, '运费', '送货油费', '']] }
}

// 下载 Excel 模板（base64 返回，小程序存文件后可直接用 Excel/WPS 打开编辑）
app.get('/import-template-xlsx', async (c) => {
  const t = String(c.req.query('type') || 'ar')
  const T = IMPORT_TEMPLATES[t] || IMPORT_TEMPLATES.ar
  const xlsx = await makeXlsx(T.rows)
  return c.json({ ok: true, name: T.name + '.xlsx', b64: toB64(xlsx) })
})

// 直接上传 Excel 文件导入
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
  const r = await importRows(c.env.DB, type, rows)
  return c.json(r)
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
  const a = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE ref_type='amort' AND substr(created_at,1,7)=?").bind(m).first()
  const b = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE ref_type='debt_int' AND substr(created_at,1,7)=?").bind(m).first()
  const amort = round2(num(a && a.t))
  const acr = round2(num(b && b.t))
  return { amort, accrue_int: acr, net: round2(amort + acr) }
}

app.get('/dashboard', async (c) => {
  const db = c.env.DB
  const m = month()
  const ar = await db.prepare('SELECT COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) AS total FROM orders WHERE paid + COALESCE(written_off,0) < price').first()
  const ap = await db.prepare('SELECT COALESCE(SUM(amount-paid-COALESCE(written_off,0)),0) AS total FROM payables WHERE paid + COALESCE(written_off,0) < amount').first()
  const inc = await db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM ledger WHERE direction='in' AND cash=1 AND ref_type<>'transfer' AND substr(created_at,1,7)=?").bind(m).first()
  const out = await db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND substr(created_at,1,7)=?").bind(m).first()
  const pending = await db.prepare('SELECT COUNT(*) AS n FROM orders WHERE status < 2').first()
  const recent = await db.prepare('SELECT * FROM ledger ORDER BY id DESC LIMIT 10').all()
  const orderAdd = await db.prepare('SELECT COALESCE(SUM(price),0) AS t FROM orders WHERE substr(created_at,1,7)=?').bind(m).first()
  const payableAdd = await db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM payables WHERE substr(created_at,1,7)=?').bind(m).first()
  const expCash = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND ref_type='expense' AND substr(created_at,1,7)=?").bind(m).first()
  const accAdj = await accrualAdjust(db, m)
  const expTotal = round2(num(expCash.t) + accAdj.net)
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString()
  const overdue = await db.prepare('SELECT * FROM orders WHERE paid + COALESCE(written_off,0) < price AND created_at < ? ORDER BY created_at LIMIT 5').bind(cutoff).all()
  const todayS = new Date().toISOString().slice(0, 10)
  const soonS = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
  const dueSoon = await db.prepare("SELECT * FROM orders WHERE paid + COALESCE(written_off,0) < price AND due_date IS NOT NULL AND substr(due_date,1,10) <= ? AND substr(due_date,1,10) >= ? ORDER BY due_date LIMIT 8").bind(soonS, todayS).all()
  const debtRows = (await db.prepare('SELECT * FROM debts').all()).results
  const debtReps = (await db.prepare('SELECT * FROM debt_repays').all()).results
  const debts = (() => {
    const list = debtRows.map((d) => debtView(d, debtReps.filter((r) => r.debt_id === d.id))).filter((x) => x.status === 'open')
    return { total_principal: round2(list.reduce((a, x) => a + x.remain, 0)), month_interest: round2(list.reduce((a, x) => a + x.monthly_interest, 0)), overdue_count: list.filter((x) => x.overdue).length, soon: list.filter((x) => !x.overdue && x.days_to_due !== null && x.days_to_due >= 0 && x.days_to_due <= 7) }
  })()
  const overLimitRow = await db.prepare("SELECT COUNT(*) AS n FROM (SELECT o.customer, SUM(MAX(0, o.price - o.paid - COALESCE(o.written_off,0))) AS unpaid FROM orders o GROUP BY o.customer) t JOIN credit_limits l ON l.party=t.customer WHERE l.limit_amount>0 AND t.unpaid>l.limit_amount").first()
  const overLimit = { n: num(overLimitRow && overLimitRow.n) }
  const paySoon = await db.prepare("SELECT * FROM payables WHERE paid + COALESCE(written_off,0) < amount AND due_date IS NOT NULL AND substr(due_date,1,10) <= ? AND substr(due_date,1,10) >= ? ORDER BY due_date LIMIT 8").bind(soonS, todayS).all()
  const todayIn = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='in' AND cash=1 AND ref_type<>'transfer' AND substr(created_at,1,10)=?").bind(todayS).first()
  const topCust = await db.prepare('SELECT customer AS nm, COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) AS t FROM orders WHERE paid + COALESCE(written_off,0) < price GROUP BY customer ORDER BY t DESC LIMIT 1').first()
  // 预算：按分类统计本月已花，超出或接近 90% 的提醒
  const buds = await db.prepare('SELECT * FROM budgets ORDER BY id').all()
  const budgetOver = []
  for (const b of buds.results) {
    const sp = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND COALESCE(NULLIF(category,''),'其他')=? AND substr(created_at,1,7)=?").bind(b.category, m).first()
    const spent = round2(num(sp.t))
    const limit = round2(num(b.amount))
    const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0
    if (pct >= 90) budgetOver.push({ category: b.category, limit, spent, pct, over: spent > limit, over_amt: spent > limit ? round2(spent - limit) : 0 })
  }
  const accList = await accountBalances(db)
  const cashBal = round2(accList.reduce((s2, a) => s2 + a.balance, 0))
  const role = c.get('role') || 'owner'
  const hideProfit = role === 'staff'
  const scRow = await db.prepare("SELECT value FROM settings WHERE key='selfcheck_count'").first()
  const scAt = await db.prepare("SELECT value FROM settings WHERE key='selfcheck_at'").first()
  return c.json({
    role,
    hide_profit: hideProfit,
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
    profit_biz: hideProfit ? null : round2(num(orderAdd.t) - num(payableAdd.t) - expTotal),
    pending_count: pending.n,
    today_income: round2(num(todayIn.t)),
    top_customer: topCust ? topCust.nm : '',
    top_unpaid: topCust ? round2(num(topCust.t)) : 0,
    overdue_count: overdue.results.length,
    overdue: overdue.results.map((r) => ({ ...r, unpaid: round2(r.price - r.paid) })),
    due_soon_count: dueSoon.results.length,
    due_soon: dueSoon.results.map((r) => ({ ...r, unpaid: round2(r.price - r.paid), due_short: (r.due_date || '').slice(0, 10) })),
    debt_total: hideProfit ? null : debts.total_principal,
    net_worth: hideProfit ? null : round2(cashBal - debts.total_principal),
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
    loan_open: round2(num((await db.prepare('SELECT COALESCE(SUM(amount-used-returned),0) t FROM loans').first()).t))
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
  const start = new Date(Date.now() - 6 * 86400000).toISOString()
  const q = async (sql) => num((await db.prepare(sql).bind(start, end).first()).t)
  const inc = await q("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE direction='in' AND cash=1 AND ref_type<>'transfer' AND created_at>=? AND created_at<=?")
  const out = await q("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND created_at>=? AND created_at<=?")
  const incCnt = await q("SELECT COUNT(*) t FROM ledger WHERE direction='in' AND cash=1 AND ref_type<>'transfer' AND created_at>=? AND created_at<=?")
  const outCnt = await q("SELECT COUNT(*) t FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND created_at>=? AND created_at<=?")
  const orderAdd = await q('SELECT COALESCE(SUM(price),0) t FROM orders WHERE created_at>=? AND created_at<=?')
  const payableAdd = await q('SELECT COALESCE(SUM(amount),0) t FROM payables WHERE created_at>=? AND created_at<=?')
  const expCash = await q("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE direction='out' AND cash=1 AND ref_type='expense' AND created_at>=? AND created_at<=?")
  const arTotal = num((await db.prepare('SELECT COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) t FROM orders WHERE paid + COALESCE(written_off,0) < price').first()).t)
  const apTotal = num((await db.prepare('SELECT COALESCE(SUM(amount-paid-COALESCE(written_off,0)),0) t FROM payables WHERE paid + COALESCE(written_off,0) < amount').first()).t)
  const topAr = (await db.prepare('SELECT customer nm, SUM(price-paid-COALESCE(written_off,0)) t FROM orders WHERE paid + COALESCE(written_off,0) < price GROUP BY customer ORDER BY t DESC LIMIT 3').all()).results
  const cash = round2((await accountBalances(db)).reduce((a, x) => a + x.balance, 0))
  const profit = round2(orderAdd - payableAdd - expCash)
  return {
    from: start.slice(0, 10), to: end.slice(0, 10),
    inc: round2(inc), inc_cnt: incCnt, out: round2(out), out_cnt: outCnt,
    order_add: round2(orderAdd), payable_add: round2(payableAdd), exp_cash: round2(expCash),
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
  lines.push(`经营毛利（估算）：¥${w.profit}`)
  lines.push(`现在被欠：¥${w.ar_total}　我欠别人：¥${w.ap_total}　手头现金：¥${w.cash}`)
  if (w.top_ar.length) lines.push('欠款最多：' + w.top_ar.map((x) => `${x.party} ¥${x.amount}`).join('、'))
  return { text: lines.join('\n'), stat: w }
}
app.get('/weekly-text', async (c) => c.json(await weeklyText(c.env.DB)))

// 周一早上推周报（一次性订阅消费一条额度）
async function pushWeekly(db) {
  try {
    const cfg = await wxCfg(db)
    if (!cfg.appid || !cfg.secret || !cfg.tpl) return
    const w = await weeklyText(db)
    const s = w.stat
    await wxPush(db, {
      title: `上周收 ¥${s.inc} 付 ¥${s.out}`,
      time: `${s.from.slice(5)} ~ ${s.to.slice(5)}`,
      note: `毛利约 ¥${s.profit}；被欠 ¥${s.ar_total}，手头 ¥${s.cash}`
    })
  } catch (e) { console.error('weekly push failed', e) }
}

// 赚没赚：两个口径对比
app.get('/profit-compare', async (c) => {
  const db = c.env.DB
  const m = String(c.req.query('month') || month()).slice(0, 7)
  const q = async (sql) => num((await db.prepare(sql).bind(m).first()).t)
  const inc = await q("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='in' AND cash=1 AND ref_type<>'transfer' AND substr(created_at,1,7)=?")
  const out = await q("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND substr(created_at,1,7)=?")
  const orderAdd = await q('SELECT COALESCE(SUM(price),0) AS t FROM orders WHERE substr(created_at,1,7)=?')
  const payableAdd = await q('SELECT COALESCE(SUM(amount),0) AS t FROM payables WHERE substr(created_at,1,7)=?')
  const expCash = await q("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND ref_type='expense' AND substr(created_at,1,7)=?")
  const fixedCash = await q("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND ref_type='fixed' AND substr(created_at,1,7)=?")
  const accAdj = await accrualAdjust(db, m)
  // 现金口径：本月实际收到的钱 − 本月实际付出的钱
  const cash = num(inc) - num(out)
  // 权责口径：本月接的活 − 本月赊的料 − 本月花的现金成本（工资水电等）
  const otherCash = round2(num(out) - expCash - fixedCash) // 还供应商/其它付出
  const accrual = round2(num(orderAdd) - num(payableAdd) - expCash - fixedCash - accAdj.net)
  return c.json({
    month: m,
    cash_income: round2(num(inc)),
    cash_outcome: round2(num(out)),
    cash_profit: round2(cash),
    order_add: round2(num(orderAdd)),
    payable_add: round2(num(payableAdd)),
    expense_cash: round2(num(expCash) + accAdj.net),
    amort: accAdj.amort,
    accrue_int: accAdj.accrue_int,
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
const dayStr = (d) => d.toISOString().slice(0, 10)
const dayAgo = (n) => dayStr(new Date(Date.now() - n * 86400000))
const dayAfter = (n) => dayStr(new Date(Date.now() + n * 86400000))
const daysSince = (iso) => {
  const t = new Date(String(iso || '').slice(0, 10))
  if (isNaN(t.getTime())) return 0
  return Math.max(0, Math.floor((Date.now() - t.getTime()) / 86400000))
}
const fmtOrder = (r) => ({
  ...r,
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
app.get('/onboarding', async (c) => {
  const db = c.env.DB
  await ensureAccounts(db)
  const accs = (await db.prepare('SELECT * FROM accounts').all()).results
  const opening = round2(accs.reduce((a, x) => a + num(x.opening), 0))
  const oRow = await db.prepare('SELECT COUNT(*) AS n FROM orders').first()
  const pRow = await db.prepare('SELECT COUNT(*) AS n FROM payables').first()
  const lRow = await db.prepare('SELECT COUNT(*) AS n FROM ledger').first()
  const flag = (await db.prepare("SELECT value FROM settings WHERE key='onboard_done'").first()) || {}
  const steps = [
    { k: 'acc', t: '填一下账户余额', d: '现在手上的现金、银行卡、微信里各有多少钱', done: opening > 0, go: '设置 → 账户' },
    { k: 'ar', t: '录"别人还欠我"的账', d: '外面还没收回来的加工费（期初应收）', done: num(oRow && oRow.n) > 0, go: '记账 → 导入 → 期初应收' },
    { k: 'ap', t: '录"我还欠别人"的账', d: '还没付给供应商的钱（期初应付）', done: num(pRow && pRow.n) > 0, go: '记账 → 导入 → 期初应付' }
  ]
  const doneCount = steps.filter((x) => x.done).length
  return c.json({
    show: String(flag.value || '') !== '1',
    steps, done: doneCount, total: steps.length, all_done: doneCount === 3,
    opening, ledger_rows: num(lRow && lRow.n)
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
    const add = await db.prepare('SELECT COUNT(*) n, COALESCE(SUM(price),0) t FROM orders WHERE substr(created_at,1,7)=?').bind(m).first()
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
  const add = await db.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount),0) t FROM payables WHERE substr(created_at,1,7)=?').bind(m).first()
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
  const sql = 'SELECT * FROM ' + T + ' WHERE ' + conds.join(' AND ') + ' ORDER BY created_at ASC, id ASC'
  let rows = []
  try { rows = (await db.prepare(sql).bind(...binds).all()).results || [] } catch (e) { rows = [] }
  const map = new Map()
  for (const r of rows) {
    const name = (r[NAME] || '未填写') + ''
    const it = isAr ? fmtOrder(r) : fmtPayable(r)
    if (!map.has(name)) map.set(name, { name, unpaid: 0, cnt: 0, oldest_days: 0, due_soon: 0, overdue: 0, items: [] })
    const g = map.get(name)
    g.unpaid = round2(g.unpaid + it.unpaid)
    g.cnt += 1
    if (it.days > g.oldest_days) g.oldest_days = it.days
    if (it.due_short && it.due_short >= today && it.due_short <= d7 && !it.settled) g.due_soon += 1
    if (it.days > 30 && !it.settled) g.overdue += 1
    g.items.push({ id: it.id, unpaid: it.unpaid, days: it.days, due_short: it.due_short, created_at: it.created_at, title: isAr ? (it.item_name || '加工') : (it.remark || '采购'), total: isAr ? num(it.price) : num(it.amount), paid: num(it.paid), written_off: it.written_off, operator: it.operator || '' })
  }
  const groups = [...map.values()].sort((a, b) => b.unpaid - a.unpaid)
  return c.json({ type, count: groups.length, groups })
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
app.post('/orders', async (c) => {
  const { customer, item_name, price, due_date, operator, date } = await c.req.json()
  if (!customer || num(price) <= 0) return c.json({ error: '客户和金额必填' }, 400)
  const db = c.env.DB
  const created = stampOf(date)
  if (await isMonthLocked(db, created.slice(0, 7))) return c.json({ error: '该月份已结账锁定，先解锁再记账' }, 403)
  const due = toIsoDate(due_date)
  await db.prepare('INSERT INTO orders (customer, item_name, price, status, paid, due_date, operator, created_at) VALUES (?,?,?,0,0,?,?,?)')
    .bind(customer, item_name || '', num(price), due || null, String(operator || '').trim() || null, created).run()
  await logAudit(db, '新增应收', customer, `${customer} ${item_name || ''} ¥${num(price)}`)
  // 超信用额度提醒（不拦，只提醒）
  let warn = null
  const lim = await db.prepare('SELECT * FROM credit_limits WHERE party=?').bind(customer).first()
  if (lim && num(lim.limit_amount) > 0) {
    const agg = await db.prepare('SELECT SUM(MAX(0, price - paid - COALESCE(written_off,0))) AS unpaid FROM orders WHERE customer=?').bind(customer).first()
    const unpaid = round2(num(agg && agg.unpaid))
    const over = round2(unpaid - num(lim.limit_amount))
    if (over > 0) warn = { over_limit: true, party: customer, limit_amount: num(lim.limit_amount), unpaid, over, error: `提醒：${customer} 已欠 ¥${unpaid}，超信用额度 ¥${num(lim.limit_amount)}（多出 ¥${over}）` }
  }
  return c.json(Object.assign({ ok: true }, warn ? { warn } : {}))
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
    db.prepare('UPDATE orders SET paid=paid+?, rev=COALESCE(rev,0)+1 WHERE id=?').bind(a, id),
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
  await logAudit(db, '批量收款', name, `${name} 共收 ¥${total}，核销 ${detail.length} 张单`)
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
  await logAudit(db, '整户付款', name, `${name} 共付 ¥${total}，核销 ${detail.length} 笔`)
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
    let sql = 'SELECT customer AS nm, COUNT(*) AS cnt, SUM(price-paid-COALESCE(written_off,0)) AS unpaid, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM orders WHERE paid + COALESCE(written_off,0) < price'
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
    'SELECT supplier AS nm, COUNT(*) AS cnt, SUM(amount-paid-COALESCE(written_off,0)) AS unpaid, MIN(created_at) AS oldest FROM payables WHERE paid + COALESCE(written_off,0) < amount GROUP BY supplier ORDER BY unpaid DESC'
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
  const { supplier, amount, category, remark, operator, due_date, confirm_dup, date } = await c.req.json()
  if (!supplier || num(amount) <= 0) return c.json({ error: '供应商和金额必填' }, 400)
  const db = c.env.DB
  const created = stampOf(date)
  if (await isMonthLocked(db, created.slice(0, 7))) return c.json({ error: '该月份已结账锁定，先解锁再记账' }, 403)
  // 防重复：同供应商 + 同金额，7 天内提醒一次
  if (!confirm_dup) {
    const since = new Date(Date.now() - 7 * 86400000).toISOString()
    const d = await db.prepare('SELECT 1 FROM payables WHERE supplier=? AND amount=? AND created_at >= ?')
      .bind(supplier, num(amount), since).first()
    if (d) return c.json({ error: `${supplier} 7 天内已经有一笔 ${num(amount)} 的应付了，确认再记一笔吗？`, dup: true }, 409)
  }
  await db.prepare('INSERT INTO payables (supplier, amount, paid, category, remark, operator, due_date, created_at) VALUES (?,?,0,?,?,?,?,?)')
    .bind(supplier, num(amount), category || '', remark || '', String(operator || '').trim() || null, toIsoDate(due_date) || null, created).run()
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
    db.prepare('UPDATE payables SET paid=paid+?, rev=COALESCE(rev,0)+1 WHERE id=?').bind(a, id),
    db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('out','payable',?,?,?,?,?,1,?)")
      .bind(id, a, p.category || '', `付 ${p.supplier} ${p.remark}`, acc, normDate(date))
  ])
  await logAudit(db, '付款', p.supplier, `${p.supplier} 付 ¥${a}`)
  return c.json({ ok: true })
})

// 现付支出
app.post('/expenses', async (c) => {
  const { amount, category, remark, operator, account_id, confirm_dup, date } = await c.req.json()
  if (num(amount) <= 0) return c.json({ error: '金额必填' }, 400)
  const db = c.env.DB
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
  return c.json({ text: lines.join('\n') })
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
    return c.json({ text: lines.join('\n'), month: m, name, type: 'ar', open: round2(open), inc: round2(cur), inc_cnt: curCnt, got: round2(num(got.t)), end: round2(end) })
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
    return c.json({ text: lines.join('\n'), month: m, name, type: 'ap', open: round2(open), inc: round2(cur), inc_cnt: curCnt, got: round2(num(paid.t)), end: round2(end) })
  }
  return c.json({ error: '类型不对，只能是 ar 或 ap' }, 400)
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
// 批量导入核心：rows = [[单元格, ...], ...]（首行若是表头会自动跳过）
async function importRows(db, type, rows) {
  let n = 0
  let skippedLocked = 0
  const t = now()
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
    } else if (type === 'loan') {
      const [staff, amount, remark] = p
      if (staff && num(amount) > 0) {
        const accI = await defaultAccountId(db)
        const r = await db.prepare('INSERT INTO loans (staff, amount, used, returned, remark, account_id, created_at) VALUES (?,?,0,0,?,?,?)')
          .bind(staff, num(amount), remark || '', accI, d).run()
        const lid = r.meta && r.meta.last_row_id ? r.meta.last_row_id : 0
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
  await logAudit(db, '批量导入', type, `导入 ${n} 条${skippedLocked ? `，跳过锁定 ${skippedLocked} 条` : ''}`)
  await logAudit(db, '批量导入', type, `导入 ${n} 条${skippedLocked ? `，跳过锁定 ${skippedLocked} 条` : ''}`)
  return { imported: n, skipped_locked: skippedLocked }
}

app.post('/import', async (c) => {
  const { type, text } = await c.req.json()
  const lines = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean)
  if (!lines.length) return c.json({ error: '没有可导入的内容' }, 400)
  const rows = lines.map((row) => row.split(/[,，\t]/).map((s) => s.trim()))
  return c.json(await importRows(c.env.DB, type, rows))
})

// 年度流水报表
app.get('/report', async (c) => {
  const y = String(c.req.query('year') || new Date().getFullYear())
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
  const stat = async (m) => {
    const inc = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='in' AND cash=1 AND ref_type<>'transfer' AND substr(created_at,1,7)=?").bind(m).first()
    const out = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND substr(created_at,1,7)=?").bind(m).first()
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
async function selfCheck(db) {
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
  const arRow = await db.prepare('SELECT COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) AS t FROM orders WHERE paid + COALESCE(written_off,0) < price').first()
  const arFlow = await db.prepare('SELECT COALESCE(SUM(price),0) AS a, COALESCE(SUM(paid),0) AS p FROM orders').first()
  const flowIn = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='in' AND cash=1 AND ref_type<>'transfer'").first()
  const flowOut = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer'").first()
  const apRow = await db.prepare('SELECT COALESCE(SUM(amount-paid-COALESCE(written_off,0)),0) AS t FROM payables WHERE paid + COALESCE(written_off,0) < amount').first()
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
app.get('/selfcheck', async (c) => c.json(await selfCheck(c.env.DB)))

// 编辑应收单
app.patch('/orders/:id', async (c) => {
  const id = c.req.param('id')
  const { customer, item_name, price, due_date, operator, rev } = await c.req.json()
  const db = c.env.DB
  const o = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first()
  if (!o) return c.json({ error: '订单不存在' }, 404)
  if (rev !== undefined && rev !== null && rev !== '' && num(rev) !== num(o.rev)) {
    return c.json({ error: '这张单刚被别人改过（或被收过款），请下拉刷新后再改', code: 'conflict' }, 409)
  }
  if (await isMonthLocked(db, (o.created_at || '').slice(0, 7))) return c.json({ error: '该订单所在月份已结账锁定' }, 403)
  const p = num(price, o.price)
  if (p < num(o.paid)) return c.json({ error: '金额不能小于已收款' }, 400)
  const nd = due_date !== undefined ? (toIsoDate(due_date) || null) : (o.due_date || null)
  const op = operator !== undefined ? (String(operator).trim() || null) : (o.operator || null)
  await db.prepare('UPDATE orders SET customer=?, item_name=?, price=?, due_date=?, operator=?, rev=COALESCE(rev,0)+1 WHERE id=?')
    .bind(customer || o.customer, item_name || o.item_name, p, nd, op, id).run()
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
  const { supplier, amount, remark, due_date, rev } = await c.req.json()
  const db = c.env.DB
  const p = await db.prepare('SELECT * FROM payables WHERE id=?').bind(id).first()
  if (!p) return c.json({ error: '应付单不存在' }, 404)
  if (rev !== undefined && rev !== null && rev !== '' && num(rev) !== num(p.rev)) {
    return c.json({ error: '这笔刚被别人改过（或被付过款），请下拉刷新后再改', code: 'conflict' }, 409)
  }
  if (await isMonthLocked(db, (p.created_at || '').slice(0, 7))) return c.json({ error: '该应付单所在月份已结账锁定' }, 403)
  const a = num(amount, p.amount)
  if (a < num(p.paid)) return c.json({ error: '金额不能小于已付款' }, 400)
  const nd = due_date !== undefined ? (toIsoDate(due_date) || null) : (p.due_date || null)
  await db.prepare('UPDATE payables SET supplier=?, amount=?, remark=?, due_date=?, rev=COALESCE(rev,0)+1 WHERE id=?')
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
  const i = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND ref_type<>'transfer' AND direction='in' AND substr(created_at,1,7)<=?").bind(m).first()
  const o = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND ref_type<>'transfer' AND direction='out' AND substr(created_at,1,7)<=?").bind(m).first()
  return round2(opening + num(i.t) - num(o.t))
}
const arAtEnd = async (db, m) => {
  const a = await db.prepare("SELECT COALESCE(SUM(price - COALESCE(written_off,0)),0) t FROM orders WHERE substr(created_at,1,7)<=?").bind(m).first()
  const b = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE direction='in' AND ref_type='order' AND substr(created_at,1,7)<=?").bind(m).first()
  return round2(Math.max(num(a.t) - num(b.t), 0))
}
const apAtEnd = async (db, m) => {
  const a = await db.prepare("SELECT COALESCE(SUM(amount - COALESCE(written_off,0)),0) t FROM payables WHERE substr(created_at,1,7)<=?").bind(m).first()
  const b = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE direction='out' AND ref_type='payable' AND substr(created_at,1,7)<=?").bind(m).first()
  return round2(Math.max(num(a.t) - num(b.t), 0))
}

// 家底：每月末 现金 + 别人欠我 − 我欠别人
app.get('/networth', async (c) => {
  const db = c.env.DB
  const n = Math.min(Math.max(num(c.req.query('months'), 12) || 12, 3), 36)
  const debts = (await db.prepare('SELECT * FROM debts').all()).results
  const reps = (await db.prepare('SELECT * FROM debt_repays').all()).results
  const debtAtEnd = (m) => {
    const end = m + '-31'
    const borrowed = debts.filter((d) => (d.start_date || d.created_at || '').slice(0, 10) <= end).reduce((a, d) => a + num(d.principal), 0)
    const repaid = reps.filter((r) => r.kind === 'principal' && (r.rdate || r.created_at || '').slice(0, 10) <= end).reduce((a, r) => a + num(r.amount), 0)
    return round2(Math.max(0, borrowed - repaid))
  }
  const out = []
  for (const m of monthList(n)) {
    const cash = await cashAtEnd(db, m)
    const ar = await arAtEnd(db, m)
    const ap = await apAtEnd(db, m)
    const debt = debtAtEnd(m)
    out.push({ m, cash, ar, ap, debt, net: round2(cash + ar - ap - debt) })
  }
  return c.json(out)
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
  const inc = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND ref_type<>'transfer' AND direction='in' AND substr(created_at,1,7)=?").bind(m).first()
  const out = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND ref_type<>'transfer' AND direction='out' AND substr(created_at,1,7)=?").bind(m).first()
  const oAdd = await db.prepare("SELECT COALESCE(SUM(price),0) t FROM orders WHERE substr(created_at,1,7)=?").bind(m).first()
  const pAdd = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM payables WHERE substr(created_at,1,7)=?").bind(m).first()
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
  const cashCost = num((await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND ref_type<>'transfer' AND direction='out' AND substr(created_at,1,7)=?").bind(m).first()).t)
  const cashIn = num((await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND ref_type<>'transfer' AND direction='in' AND substr(created_at,1,7)=?").bind(m).first()).t)
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
  const in3 = num((await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND ref_type<>'transfer' AND direction='in' AND substr(created_at,1,7)<=? AND substr(created_at,1,7)>=?").bind(m, monthList(3)[0]).first()).t)
  const ar = await arAtEnd(db, m)
  const turnDays = in3 > 0 ? round2((ar / (in3 / 3)) * 30) : 0
  // 现金安全垫：现金余额 / 近 3 个月平均月支出
  const out3 = num((await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND ref_type<>'transfer' AND direction='out' AND substr(created_at,1,7)<=? AND substr(created_at,1,7)>=?").bind(m, monthList(3)[0]).first()).t)
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
  const unin = await db.prepare("SELECT COUNT(*) n, COALESCE(SUM(o.price),0) t FROM orders o WHERE o.paid > 0 AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.order_id=o.id)").first()
  return c.json({
    month, rows,
    summary: { out: await sumOf('out'), in: await sumOf('in') },
    uninvoiced: { count: num(unin.n), amount: round2(num(unin.t)) }
  })
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
  const start = a.buy_date ? new Date(a.buy_date) : new Date()
  const months = Math.max(0, Math.floor((Date.now() - start.getTime()) / (30.44 * 86400000)))
  const cap = Math.round(life * 12)
  const usedMonths = Math.min(months, cap)
  const depCap = round2(cost - residual)
  const acc = round2(Math.min(monthly * usedMonths, depCap))
  return {
    id: a.id, name: a.name, cost: round2(cost), buy_date: a.buy_date, life_years: life,
    residual_rate: num(a.residual_rate), monthly, residual, acc_dep: acc,
    net: round2(cost - acc), used_months: usedMonths, remain_months: Math.max(cap - usedMonths, 0),
    done: acc >= depCap - 0.01
  }
}

app.get('/assets', async (c) => {
  const db = c.env.DB
  const rows = (await db.prepare('SELECT * FROM assets ORDER BY id DESC').all()).results
  const list = rows.map(assetCalc)
  return c.json({
    rows: list,
    total_cost: round2(list.reduce((s, a) => s + a.cost, 0)),
    total_monthly: round2(list.filter((a) => !a.done).reduce((s, a) => s + a.monthly, 0)),
    total_net: round2(list.reduce((s, a) => s + a.net, 0))
  })
})

app.post('/assets', async (c) => {
  const { name, cost, buy_date, life_years, residual_rate } = await c.req.json()
  const nm = String(name || '').trim()
  if (!nm) return c.json({ error: '设备名称必填' }, 400)
  if (num(cost) <= 0) return c.json({ error: '原值必须大于 0' }, 400)
  const db = c.env.DB
  await db.prepare('INSERT INTO assets (name, cost, buy_date, life_years, residual_rate, created_at) VALUES (?,?,?,?,?,?)')
    .bind(nm, num(cost), toIsoDate(buy_date) || now().slice(0, 10), num(life_years) || 5,
      residual_rate === undefined ? 5 : num(residual_rate), now()).run()
  await logAudit(db, '新增固定资产', nm, `${nm} 原值 ¥${num(cost)}`)
  return c.json({ ok: true })
})

app.delete('/assets/:id', async (c) => {
  const id = c.req.param('id')
  await c.env.DB.prepare('DELETE FROM assets WHERE id=?').bind(id).run()
  return c.json({ ok: true })
})

// 把本月折旧记成一笔支出（防重复）
app.post('/assets/run-depreciation', async (c) => {
  const db = c.env.DB
  const m = now().slice(0, 7)
  const has = await db.prepare("SELECT 1 FROM ledger WHERE ref_type='dep' AND substr(created_at,1,7)=?").bind(m).first()
  if (has) return c.json({ ok: true, added: 0, note: '本月折旧已经记过了' })
  const rows = (await db.prepare('SELECT * FROM assets').all()).results.map(assetCalc).filter((a) => !a.done && a.monthly > 0)
  const total = round2(rows.reduce((s, a) => s + a.monthly, 0))
  if (total <= 0) return c.json({ ok: true, added: 0, note: '没有需要计提折旧的设备' })
  const acc = await defaultAccountId(db)
  await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('out','dep',0,?,?,?,?,1,?)")
    .bind(total, '折旧', `本月固定资产折旧（${rows.length} 项）`, acc, now()).run()
  await logAudit(db, '计提折旧', '固定资产', `${rows.length} 项 共 ¥${total}`)
  return c.json({ ok: true, added: total })
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
    out.push({ date, direction: dir, amount: round2(amount), memo })
  }
  return out
}

app.post('/bank-import', async (c) => {
  const { text, account_id } = await c.req.json()
  const db = c.env.DB
  const rows = parseBankText(text)
  if (!rows.length) return c.json({ error: '没解析出流水，格式：日期,收/付,金额,摘要（一行一笔）' }, 400)
  const acc = num(account_id) || 0
  for (const r of rows) {
    await db.prepare('INSERT INTO bank_flows (date, direction, amount, memo, matched_type, matched_id, created_at) VALUES (?,?,?,?,?,0,?)')
      .bind(r.date, r.direction, r.amount, `${r.memo}${acc ? ' [账户' + acc + ']' : ''}`, null, now()).run()
  }
  await logAudit(db, '导入银行流水', '银行流水', `导入 ${rows.length} 笔`)
  return c.json({ ok: true, imported: rows.length, rows })
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

// 认领：把一笔流水登记成「某张应收的收款 / 某笔应付的付款 / 一笔支出」
app.post('/bank-flows/:id/match', async (c) => {
  const id = c.req.param('id')
  const { target_type, target_id, category, account_id } = await c.req.json()
  const db = c.env.DB
  const bf = await db.prepare('SELECT * FROM bank_flows WHERE id=?').bind(id).first()
  if (!bf) return c.json({ error: '流水不存在' }, 404)
  if (bf.matched_type) return c.json({ error: '这笔已经认领过了' }, 400)
  const acc = num(account_id) || (await defaultAccountId(db))
  const amt = num(bf.amount)
  if (target_type === 'order' && bf.direction !== 'in') return c.json({ error: '这笔流水是付款，不能抵应收（收款的才能抵）' }, 400)
  if (target_type === 'payable' && bf.direction !== 'out') return c.json({ error: '这笔流水是收款，不能抵应付（付款的才能抵）' }, 400)
  if (target_type === 'order') {
    const o = await db.prepare('SELECT * FROM orders WHERE id=?').bind(target_id).first()
    if (!o) return c.json({ error: '应收单不存在' }, 404)
    await db.batch([
      db.prepare('UPDATE orders SET paid=paid+?, rev=COALESCE(rev,0)+1 WHERE id=?').bind(amt, o.id),
      db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, remark, account_id, cash, created_at) VALUES ('in','order',?,?,?,?,1,?)")
        .bind(o.id, amt, `银行对账收款 ${o.customer} ${o.item_name}`, acc, bf.date + 'T00:00:00.000Z')
    ])
  } else if (target_type === 'payable') {
    const p = await db.prepare('SELECT * FROM payables WHERE id=?').bind(target_id).first()
    if (!p) return c.json({ error: '应付单不存在' }, 404)
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
    .bind(target_type === 'order' ? 'order' : target_type === 'payable' ? 'payable' : 'expense', num(target_id) || 0, id).run()
  await logAudit(db, '银行流水认领', bf.memo || '', `¥${amt} → ${target_type}`)
  return c.json({ ok: true })
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
app.get('/reminders', async (c) => {
  const db = c.env.DB
  const today = now().slice(0, 10)
  const items = []
  const push = (level, text, tab, list) => items.push({ level, text, tab, list: list || [] })
  // 应收逾期超 30 天：带上具体是哪个客户、多少、拖了几天，首页直接能看到名字
  const od = await db.prepare("SELECT id, customer, (price-paid-COALESCE(written_off,0)) AS unpaid, created_at FROM orders WHERE paid + COALESCE(written_off,0) < price AND substr(created_at,1,10) <= date(?, '-30 day') ORDER BY created_at LIMIT 50").bind(today).all()
  if (od.results.length) {
    const t = od.results.reduce((a, r) => a + num(r.unpaid), 0)
    push('red', `${od.results.length} 张应收逾期超 30 天，共 ¥${round2(t)}`, 'ar',
      od.results.slice(0, 3).map((r) => ({ party: r.customer || '', amount: round2(num(r.unpaid)), note: `已 ${daysSince(r.created_at)} 天` })))
  }
  const ds = await db.prepare("SELECT id, customer, (price-paid-COALESCE(written_off,0)) AS unpaid, due_date FROM orders WHERE paid + COALESCE(written_off,0) < price AND due_date IS NOT NULL AND due_date BETWEEN ? AND date(?, '+7 day') ORDER BY due_date LIMIT 50").bind(today, today).all()
  if (ds.results.length) {
    push('yellow', `${ds.results.length} 张应收 7 天内到期`, 'ar',
      ds.results.slice(0, 3).map((r) => ({ party: r.customer || '', amount: round2(num(r.unpaid)), note: (r.due_date || '').slice(5, 10) + ' 到期' })))
  }
  const ps = await db.prepare("SELECT id, supplier, (amount-paid-COALESCE(written_off,0)) AS unpaid, due_date FROM payables WHERE paid + COALESCE(written_off,0) < amount AND due_date IS NOT NULL AND due_date BETWEEN ? AND date(?, '+7 day') ORDER BY due_date LIMIT 50").bind(today, today).all()
  if (ps.results.length) {
    push('yellow', `${ps.results.length} 笔应付 7 天内要付`, 'ap',
      ps.results.slice(0, 3).map((r) => ({ party: r.supplier || '', amount: round2(num(r.unpaid)), note: (r.due_date || '').slice(5, 10) + ' 要付' })))
  }
  const bo = await db.prepare("SELECT COUNT(*) n FROM budgets WHERE amount > 0 AND (SELECT COALESCE(SUM(l.amount),0) FROM ledger l WHERE l.direction='out' AND l.cash=1 AND l.ref_type<>'transfer' AND COALESCE(NULLIF(l.category,''),'其他')=budgets.category AND substr(l.created_at,1,7)=?) >= budgets.amount").bind(now().slice(0, 7)).first()
  if (num(bo.n) > 0) push('yellow', `${num(bo.n)} 个分类已经花超预算`, 'home')
  const un = await db.prepare('SELECT COUNT(*) n FROM bank_flows WHERE matched_type IS NULL').first()
  if (num(un.n) > 0) push('yellow', `${num(un.n)} 笔银行流水还没认领`, 'nw')
  const lo = await db.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount-used-returned),0) t FROM loans').first()
  if (num(lo.n) > 0 && num(lo.t) > 0) push('yellow', `员工借支还有 ¥${round2(num(lo.t))} 没清`, 'expense')
  const iv = await db.prepare('SELECT COUNT(*) n FROM orders o WHERE o.paid > 0 AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.order_id=o.id)').first()
  if (num(iv.n) > 0) push('gray', `${num(iv.n)} 张已收款的单还没开发票`, 'nw')
  return c.json({ items, count: items.length, today })
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
    const books = [['1', env.DB], ['2', env.DB2], ['3', env.DB3]]
    for (const [bid, db] of books) {
      if (!db) continue
      try {
        await runFixed(db)
        await runAmort(db)
        await runAccrual(db)
        const cron = (event && event.cron) || ''
        if (cron === '0 1 * * 1') await pushWeekly(db)
        else await runWxReminder(db)
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
