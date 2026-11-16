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
  if (path === '/' || path.startsWith('/auth/') || path === '/statement-print' || path === '/report-print') return next()
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
      (/^\/(profit-compare|aging|weekly-text|dunning-effect|backup|backup-list|backup-get|cloud-backup|restore|backup-to-notes)$/.test(path) && m !== 'OPTIONS') ||
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
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(party)} ${label} ${esc(from)}~${esc(to)}</title>
<style>
@page { size: A4; margin: 14mm 12mm; }
* { box-sizing: border-box; }
body { font-family: "Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif; color:#111; margin:0; padding:18px; background:#f4f5f7; }
.sheet { background:#fff; max-width:210mm; margin:0 auto; padding:14mm 12mm; box-shadow:0 2px 14px rgba(0,0,0,.12); }
h1 { font-size: 22px; text-align:center; margin:0 0 4px; letter-spacing:2px; }
.sub { text-align:center; font-size:12px; color:#666; margin-bottom:8px; }
.who { text-align:center; font-size:12.5px; color:#444; margin-bottom:10px; }
.meta2 { font-size:12px; color:#555; margin:-4px 0 8px; }
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
  const cashIn = await one("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE direction='in' AND cash=1 AND ref_type<>'transfer' AND substr(created_at,1,7)=?", mm)
  const cashOut = await one("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND substr(created_at,1,7)=?", mm)
  const orderAdd = await one('SELECT COALESCE(SUM(price),0) t FROM orders WHERE substr(created_at,1,7)=?', mm)
  const orderCnt = await one('SELECT COUNT(*) t FROM orders WHERE substr(created_at,1,7)=?', mm)
  const payableAdd = await one('SELECT COALESCE(SUM(amount),0) t FROM payables WHERE substr(created_at,1,7)=?', mm)
  const payableCnt = await one('SELECT COUNT(*) t FROM payables WHERE substr(created_at,1,7)=?', mm)
  const ledgerCnt = await one('SELECT COUNT(*) t FROM ledger WHERE substr(created_at,1,7)=?', mm)
  const amort = await one("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE ref_type='amort' AND substr(created_at,1,7)=?", mm)
  const dep = await one("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE ref_type='dep' AND substr(created_at,1,7)=?", mm)
  const accrue = await one("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE ref_type='debt_int' AND substr(created_at,1,7)=?", mm)
  const cashExp = await one("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE direction='out' AND cash=1 AND ref_type IN ('expense','fixed') AND substr(created_at,1,7)=?", mm)
  const cost = round2(cashExp + amort + dep + accrue)
  const profit = round2(orderAdd - payableAdd - cost)
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
    cash_expense: cashExp, amort, dep, accrue_int: accrue, cost,
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

app.post('/month-close', async (c) => {
  const db = c.env.DB
  const { month: m } = await c.req.json()
  const mm = String(m || '').trim()
  if (!/^\d{4}-\d{2}$/.test(mm)) return c.json({ error: '月份格式：YYYY-MM，如 2026-11' }, 400)
  const snap = await monthSnapshot(db, mm)
  snap.closed_at = now()
  await saveArchive(db, snap)
  await db.prepare('INSERT OR IGNORE INTO month_lock (month, locked_at) VALUES (?,?)').bind(mm, now()).run()
  await logAudit(db, '月结归档', mm, `结转 ${mm}：毛利 ${snap.profit}，成本 ${snap.cost}`)
  return c.json({ ok: true, snapshot: snap })
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
  // 本年累计
  let yOrder = 0; let yPayable = 0; let yCashExp = 0; let yAmort = 0; let yDep = 0; let yAccrue = 0
  for (let i = 1; i <= Number(mm.slice(5, 7)); i += 1) {
    const s = await snapOf(db, `${yr}-${String(i).padStart(2, '0')}`)
    yOrder += s.order_add; yPayable += s.payable_add; yCashExp += s.cash_expense; yAmort += s.amort; yDep += s.dep; yAccrue += s.accrue_int
  }
  const yCost = round2(yCashExp + yAmort + yDep + yAccrue)
  const yProfit = round2(yOrder - yPayable - yCost)
  const cats = (await db.prepare("SELECT category, COALESCE(SUM(amount),0) t FROM ledger WHERE direction='out' AND cash=1 AND ref_type IN ('expense','fixed') AND substr(created_at,1,7)=? GROUP BY category ORDER BY t DESC").bind(mm).all()).results
  const accounts = (await db.prepare('SELECT * FROM accounts ORDER BY id').all()).results
  const bal = await accountBalances(db)
  const money = (n) => Number(n || 0).toFixed(2)
  const rows = (arr) => arr.map((r) => `<tr><td>${r[0]}</td><td class="n">${r[1]}</td></tr>`).join('')
  const catRows = cats.map((x) => `<tr><td>　${x.category || '其他'}</td><td class="n">${money(x.t)}</td></tr>`).join('')
  const accRows = (bal.accounts || []).map((a) => `<tr><td>　${a.name}</td><td class="n">${money(a.balance)}</td></tr>`).join('')
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${(head && head.value) || '经营报表'} ${mm}</title>
<style>
@page{size:A4;margin:14mm}
body{font-family:-apple-system,"Microsoft YaHei",sans-serif;color:#222;font-size:13px;line-height:1.6}
h1{font-size:18px;text-align:center;margin:0 0 2px}
h2{font-size:14px;margin:18px 0 6px;border-left:4px solid #333;padding-left:8px}
.sub{text-align:center;color:#666;font-size:12px;margin-bottom:10px}
table{width:100%;border-collapse:collapse;margin-bottom:8px}
td,th{border-bottom:1px solid #ddd;padding:4px 6px}
th{background:#f5f5f5;text-align:left;font-weight:600}
.n{text-align:right;font-variant-numeric:tabular-nums}
.total td{font-weight:700;border-top:2px solid #333;border-bottom:2px solid #333}
.red{color:#c00}.green{color:#080}
.btn{display:block;margin:16px auto;padding:10px 22px;background:#07c;color:#fff;border:0;border-radius:6px;font-size:15px}
.sign{display:flex;justify-content:space-between;margin-top:28px;font-size:12px;color:#555}
@media print{.btn{display:none}body{font-size:12px}}
</style></head><body>
<button class="btn" onclick="window.print()">🖨 打印 / 存 PDF</button>
<h1>${(head && head.value) || '经营报表'}</h1>
<div class="sub">报表期间：${mm}（截至 ${snap.period_end}）　单位：元${snap.archived ? '　<b>· 按 ' + mm + ' 月结快照出表</b>' : ''}</div>

<h2>一、利润表（${mm}）</h2>
<table>
<tr><th>项目</th><th class="n">本月</th><th class="n">本年累计</th></tr>
<tr><td>营业收入（接单金额）</td><td class="n">${money(snap.order_add)}</td><td class="n">${money(yOrder)}</td></tr>
<tr><td>采购/委外（赊购）</td><td class="n">${money(snap.payable_add)}</td><td class="n">${money(yPayable)}</td></tr>
<tr><td>现金支出</td><td class="n">${money(snap.cash_expense)}</td><td class="n">${money(yCashExp)}</td></tr>
${catRows}
<tr><td>　摊销（待摊费用）</td><td class="n">${money(snap.amort)}</td><td class="n">${money(yAmort)}</td></tr>
<tr><td>　折旧</td><td class="n">${money(snap.dep)}</td><td class="n">${money(yDep)}</td></tr>
<tr><td>　预提利息</td><td class="n">${money(snap.accrue_int)}</td><td class="n">${money(yAccrue)}</td></tr>
<tr class="total"><td>成本合计</td><td class="n">${money(snap.cost)}</td><td class="n">${money(yCost)}</td></tr>
<tr class="total"><td>经营毛利</td><td class="n ${snap.profit >= 0 ? 'green' : 'red'}">${money(snap.profit)}</td><td class="n ${yProfit >= 0 ? 'green' : 'red'}">${money(yProfit)}</td></tr>
<tr><td>毛利率</td><td class="n">${snap.margin}%</td><td class="n">${yOrder > 0 ? round2((yProfit / yOrder) * 100) : 0}%</td></tr>
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

<div class="sign"><span>制表：____________</span><span>复核：____________</span><span>日期：${now().slice(0, 10)}</span></div>
<div class="sub" style="margin-top:18px">本表按「现金支出 + 摊销 + 折旧 + 预提利息」口径计算成本，与小程序内数据一致。</div>
</body></html>`
  return c.html(html)
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
  const r = await importRows(db, type, arr, { confirmDup: !!b.confirm_dup })
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
  return {
    type, count: out.length, match_count: matchN, diff_count: diffN,
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
    await db.prepare('INSERT INTO recon_log (month, type, party, imported, system, diff, state, done, note, created_at) VALUES (?,?,?,?,?,?,?,0,?,?)')
      .bind(month, type, party, imported, system, round2(imported - system), String(r.state || ''), '', now()).run()
    n++
  }
  await logAudit(db, '对账台账', type, `${month} 记 ${n} 家核对结果`)
  return c.json({ ok: true, saved: n, month, type })
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
    const rows = (await db.prepare("SELECT key, value FROM settings WHERE key IN ('report_title','report_note','report_phone','report_addr','report_bank')").all()).results
    const g = (k) => { const r = rows.find((x) => x.key === k); return r ? r.value : '' }
    return { title: g('report_title') || '加工厂', note: g('report_note') || '', phone: g('report_phone') || '', addr: g('report_addr') || '', bank: g('report_bank') || '' }
  } catch (e) { return { title: '加工厂', note: '', phone: '', addr: '', bank: '' } }
}
// 账期：客户/供应商约定「月结 N 天」，建单没填到期日就自动算出到期日
const termDue = async (db, party, baseIso) => {
  try {
    const t = await db.prepare('SELECT term_days FROM party_terms WHERE party=?').bind(String(party || '')).first()
    if (t && num(t.term_days) > 0) return addDaysIso(baseIso, num(t.term_days)) + 'T00:00:00.000Z'
  } catch (e) { /* 表还没建也不影响建单 */ }
  return ''
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
  ar: { name: '应收导入模板', rows: [['客户', '产品', '金额', '成本(可空)', '日期(可空)'], ['张老板', '外壳加工', 5000, 3000, '11-05'], ['李老板', '法兰件', 3200, '', '']] },
  ar_init: { name: '期初应收模板', rows: [['客户', '金额', '日期(可空)'], ['张老板', 5000, ''], ['李老板', 3000, '07-01']] },
  ap: { name: '应付导入模板', rows: [['供应商', '金额', '备注', '日期(可空)'], ['王五金', 2000, '螺丝款', '11-05'], ['李钢材', 5000, '钢板', '']] },
  ap_init: { name: '期初应付模板', rows: [['供应商', '金额', '日期(可空)'], ['王五金', 2000, ''], ['李钢材', 5000, '']] },
  expense: { name: '支出导入模板', rows: [['金额', '分类', '备注', '日期(可空)'], [1200, '房租', '8月房租', '11-01'], [300, '水电', '电费', '']] },
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
    dv = [{ sq: 'C2:C200', list }]
  }
  const xlsx = await makeXlsxSheets([{ name: t === 'expense' ? '支出' : t === 'reimb' ? '报销' : '导入', rows: T.rows, dv }])
  return c.json({ ok: true, name: T.name + '.xlsx', b64: toB64(xlsx), dv: dv.length > 0 })
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
  // 对账：只核对不入账
  if (type === 'recon' || type === 'recon_ap') {
    let body2 = rows.slice()
    if (body2.length && /单位|客户|供应|金额/.test(String((body2[0] || []).join('')))) body2 = body2.slice(1)
    const list = body2.map((r2) => ({ party: String((r2 || [])[0] || '').trim(), amount: num((r2 || [])[1]), ok: !!(String((r2 || [])[0] || '').trim() && num((r2 || [])[1]) > 0) })).filter((x) => x.ok)
    if (!list.length) return c.json({ error: '这个表格里没认出「单位 + 金额」两列' }, 400)
    return c.json({ ok: true, recon: await reconcileCore(c.env.DB, type === 'recon_ap' ? 'ap' : 'ar', list) })
  }
  const r = await importRows(c.env.DB, type, rows, { confirmDup: !!body.confirm_dup })
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
  const c = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE ref_type='dep' AND substr(created_at,1,7)=?").bind(m).first()
  const amort = round2(num(a && a.t))
  const acr = round2(num(b && b.t))
  const dep = round2(num(c && c.t))
  return { amort, accrue_int: acr, dep, net: round2(amort + acr + dep) }
}

app.get('/dashboard', async (c) => {
  const tgtRow = await (c.env.DB.prepare('SELECT receive, order_add FROM targets WHERE month=?').bind(now().slice(0, 7)).first().catch(() => null))
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
    month_dep: accAdj.dep,
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
    loan_open: round2(num((await db.prepare('SELECT COALESCE(SUM(amount-used-returned),0) t FROM loans').first()).t)),
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
// 每月 1 号推一条上个月的「对账进度」：对了多少家、还有几条差异没处理
async function pushReconRemind(db) {
  try {
    const cfg = await wxCfg(db)
    if (!cfg.appid || !cfg.secret || !cfg.tpl) return
    const d = new Date()
    d.setDate(1)
    d.setMonth(d.getMonth() - 1)
    const lm = d.toISOString().slice(0, 7)
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
const dayStr = (d) => d.toISOString().slice(0, 10)
const dayAgo = (n) => dayStr(new Date(Date.now() - n * 86400000))
const dayAfter = (n) => dayStr(new Date(Date.now() + n * 86400000))
const daysSince = (iso) => {
  const t = new Date(String(iso || '').slice(0, 10))
  if (isNaN(t.getTime())) return 0
  return Math.max(0, Math.floor((Date.now() - t.getTime()) / 86400000))
}
// 带符号天数差：正数=已经过去 N 天，负数=还有 N 天到期（daysSince 会把未来压成 0，到期表不能用它）
const dayDiff = (iso) => {
  const t = Date.parse(String(iso || '').slice(0, 10) + 'T00:00:00.000Z')
  if (isNaN(t)) return 0
  const today = Date.parse(now().slice(0, 10) + 'T00:00:00.000Z')
  return Math.round((today - t) / 86400000)
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
  const { customer, item_name, price, due_date, operator, date, cost } = await c.req.json()
  if (!customer || num(price) <= 0) return c.json({ error: '客户和金额必填' }, 400)
  const db = c.env.DB
  const created = stampOf(date)
  if (await isMonthLocked(db, created.slice(0, 7))) return c.json({ error: '该月份已结账锁定，先解锁再记账' }, 403)
  const due = toIsoDate(due_date) || (await termDue(db, customer, created))
  await db.prepare('INSERT INTO orders (customer, item_name, price, status, paid, due_date, operator, cost, created_at) VALUES (?,?,?,0,0,?,?,?,?)')
    .bind(customer, item_name || '', num(price), due || null, String(operator || '').trim() || null, round2(num(cost)), created).run()
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
    .bind(supplier, num(amount), category || '', remark || '', String(operator || '').trim() || null, toIsoDate(due_date) || (await termDue(db, supplier, created)) || null, created).run()
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
async function importRows(db, type, rows, opts) {
  let n = 0
  let skippedLocked = 0
  const o = opts || {}
  const dups = []
  const ids = []
  let total = 0
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
      const [customer, item, price, cost] = p
      if (customer && num(price) > 0) {
        const dk = (d || t).slice(0, 10)
        const from = addDaysIso(dk, -7)
        const hit = await db.prepare("SELECT id, created_at FROM orders WHERE customer=? AND price=? AND substr(created_at,1,10)>=? AND substr(created_at,1,10)<=?").bind(customer, num(price), from, dk).first()
        if (hit && !o.confirmDup) { dups.push({ party: customer, amount: num(price), date: (hit.created_at || '').slice(0, 10), id: hit.id, kind: 'ar' }); continue }
        const w = await db.prepare('INSERT INTO orders (customer, item_name, price, status, paid, cost, created_at) VALUES (?,?,?,0,0,?,?)')
          .bind(customer, item || '批量导入', num(price), round2(num(cost)), d).run()
        if (w.meta && w.meta.last_row_id) ids.push(w.meta.last_row_id)
        total += num(price)
        n++
      }
    } else if (type === 'ar_init') {
      const [customer, price] = p
      if (customer && num(price) > 0) {
        const w = await db.prepare('INSERT INTO orders (customer, item_name, price, status, paid, created_at) VALUES (?,?,?,0,0,?)')
          .bind(customer, '期初欠款', num(price), d).run()
        if (w.meta && w.meta.last_row_id) ids.push(w.meta.last_row_id)
        total += num(price)
        n++
      }
    } else if (type === 'ap') {
      const [supplier, amount, remark] = p
      if (supplier && num(amount) > 0) {
        const dk = (d || t).slice(0, 10)
        const hit = await db.prepare("SELECT id, created_at FROM payables WHERE supplier=? AND amount=? AND substr(created_at,1,10)>=? AND substr(created_at,1,10)<=?").bind(supplier, num(amount), addDaysIso(dk, -7), dk).first()
        if (hit && !o.confirmDup) { dups.push({ party: supplier, amount: num(amount), date: (hit.created_at || '').slice(0, 10), id: hit.id, kind: 'ap' }); continue }
        const w = await db.prepare('INSERT INTO payables (supplier, amount, paid, category, remark, created_at) VALUES (?,?,0,?,?,?)')
          .bind(supplier, num(amount), '', remark || '', d).run()
        if (w.meta && w.meta.last_row_id) ids.push(w.meta.last_row_id)
        total += num(amount)
        n++
      }
    } else if (type === 'ap_init') {
      const [supplier, amount] = p
      if (supplier && num(amount) > 0) {
        const w = await db.prepare('INSERT INTO payables (supplier, amount, paid, category, remark, created_at) VALUES (?,?,0,?,?,?)')
          .bind(supplier, num(amount), '', '期初欠款', d).run()
        if (w.meta && w.meta.last_row_id) ids.push(w.meta.last_row_id)
        total += num(amount)
        n++
      }
    } else if (type === 'expense') {
      const [amount, category, remark] = p
      if (num(amount) > 0) {
        const dk = (d || t).slice(0, 10)
        const hit = await db.prepare("SELECT id, created_at FROM ledger WHERE ref_type='expense' AND amount=? AND category=? AND substr(created_at,1,10)>=? AND substr(created_at,1,10)<=?").bind(num(amount), category || '', addDaysIso(dk, -7), dk).first()
        if (hit && !o.confirmDup) { dups.push({ party: category || '支出', amount: num(amount), date: (hit.created_at || '').slice(0, 10), id: hit.id, kind: 'expense' }); continue }
        const accI = await defaultAccountId(db)
        const w = await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('out','expense',0,?,?,?,?,1,?)")
          .bind(num(amount), category || '', remark || '', accI, d).run()
        if (w.meta && w.meta.last_row_id) ids.push(w.meta.last_row_id)
        total += num(amount)
        n++
      }
    } else if (type === 'loan') {
      const [staff, amount, remark] = p
      if (staff && num(amount) > 0) {
        const accI = await defaultAccountId(db)
        const r = await db.prepare('INSERT INTO loans (staff, amount, used, returned, remark, account_id, created_at) VALUES (?,?,0,0,?,?,?)')
          .bind(staff, num(amount), remark || '', accI, d).run()
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
  await logAudit(db, '批量导入', type, `导入 ${n} 条${skippedLocked ? `，跳过锁定 ${skippedLocked} 条` : ''}${dups.length ? `，疑似重复 ${dups.length} 条未导入` : ''}`)
  return { imported: n, skipped_locked: skippedLocked, dup: dups, dup_count: dups.length, ids, total: round2(total) }
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
      id: t.id, party: t.party, kind: t.kind || 'ar', term_days: num(t.term_days), recon_cycle: num(t.recon_cycle), note: t.note || '',
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
  const note = String(b.note || '')
  const old = await db.prepare('SELECT * FROM party_terms WHERE party=?').bind(party).first()
  if (old) await db.prepare('UPDATE party_terms SET kind=?, term_days=?, recon_cycle=?, note=? WHERE id=?').bind(kind, term, cycle, note, old.id).run()
  else await db.prepare('INSERT INTO party_terms (party, kind, term_days, recon_cycle, note, created_at) VALUES (?,?,?,?,?,?)').bind(party, kind, term, cycle, note, now()).run()
  await logAudit(db, '账期设置', party, `账期 ${term} 天，对账周期 ${cycle} 天`)
  return c.json({ ok: true })
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
  const out = list.slice(0, 20).map((x, i) => Object.assign({}, x, (() => {
    const dm = dmap[norm(x.party)]
    const last = dm && dm.last ? dm.last.slice(0, 10) : ''
    return { told_times: dm ? dm.n : 0, told_last: last, told_days: last ? daysSince(last) : null, told_text: dm ? ('已催 ' + dm.n + ' 次，上次 ' + last.slice(5) + '（' + daysSince(last) + ' 天前）') : '还没催过' }
  })(), {
    no: i + 1,
    text: type === 'ap'
      ? `${x.party} 你好，我这边欠你 ${x.left} 元（${x.cnt} 笔，最早 ${x.oldest_days} 天前）${title}，这两天安排一下，方便的话把对账单发我对一下。`
      : `${x.party} 你好，${title}账上你这边还有 ${x.left} 元没结（${x.cnt} 笔，最早 ${x.oldest_days} 天前）${x.due ? `，约定 ${String(x.due).slice(5, 10)} 到期` : ''}。方便的话这两天结一下，或者把对账单发我核一核。`
  }))
  const total = round2(list.reduce((a, x) => a + x.left, 0))
  return c.json({ ok: true, type, total, count: list.length, list: out })
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
  const since = (() => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - months); return d.toISOString().slice(0, 10) })()
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
  const six = new Date(Date.now() - 183 * 86400000).toISOString().slice(0, 7)
  const add = num((await db.prepare('SELECT COALESCE(SUM(price),0) AS t FROM orders WHERE substr(created_at,1,7)>=?').bind(six).first() || {}).t)
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
  const base = new Date()
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
  const one = async (sql, ...b) => num(((await db.prepare(sql).bind(...b).first()) || {}).t)
  const inc = await one("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='in' AND cash=1 AND ref_type<>'transfer' AND substr(created_at,1,7)=?", m)
  const out = await one("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1 AND ref_type<>'transfer' AND substr(created_at,1,7)=?", m)
  const orderAdd = await one('SELECT COALESCE(SUM(price),0) AS t FROM orders WHERE substr(created_at,1,7)=?', m)
  const orderCost = await one('SELECT COALESCE(SUM(COALESCE(cost,0)),0) AS t FROM orders WHERE substr(created_at,1,7)=?', m)
  const payableAdd = await one('SELECT COALESCE(SUM(amount),0) AS t FROM payables WHERE substr(created_at,1,7)=?', m)
  const expCash = await one("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=1 AND ref_type='expense' AND substr(created_at,1,7)=?", m)
  const dep = await one("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=0 AND ref_type='dep' AND substr(created_at,1,7)=?", m)
  const amort = await one("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=0 AND ref_type='prepaid' AND substr(created_at,1,7)=?", m)
  const accrual = await one("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out' AND cash=0 AND ref_type='debt_int' AND substr(created_at,1,7)=?", m)
  const arLeft = await one('SELECT COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) AS t FROM orders WHERE paid + COALESCE(written_off,0) < price')
  const apLeft = await one('SELECT COALESCE(SUM(amount-paid-COALESCE(written_off,0)),0) AS t FROM payables WHERE paid + COALESCE(written_off,0) < amount')
  const accounts = await accountBalances(db)
  const debtRows = (await db.prepare('SELECT * FROM debts').all()).results || []
  const debtReps = (await db.prepare('SELECT * FROM debt_repays').all()).results || []
  const debtLeft = round2(debtRows.map((d) => debtView(d, debtReps.filter((r) => r.debt_id === d.id))).filter((x) => x.status === 'open').reduce((a, x) => a + x.remain, 0))
  const cash = round2(accounts.reduce((a, x) => a + x.balance, 0))
  const gross = round2(orderAdd - orderCost)
  const net = round2(gross - expCash - dep - amort - accrual)
  return { m, inc: round2(inc), out: round2(out), orderAdd: round2(orderAdd), orderCost: round2(orderCost), payableAdd: round2(payableAdd), expCash: round2(expCash), dep: round2(dep), amort: round2(amort), accrual: round2(accrual), gross, net, arLeft: round2(arLeft), apLeft: round2(apLeft), debtLeft, cash, accounts, equity: round2(cash + arLeft - apLeft - debtLeft) }
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
  const led = (await db.prepare("SELECT * FROM ledger WHERE substr(created_at,1,7)=? ORDER BY id").bind(m).all()).results || []
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
  const rows = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base + '-01T00:00:00.000Z')
    d.setUTCMonth(d.getUTCMonth() - i)
    const m = d.toISOString().slice(0, 7)
    const o = await db.prepare('SELECT COALESCE(SUM(price),0) a, COALESCE(SUM(COALESCE(cost,0)),0) c FROM orders WHERE substr(created_at,1,7)=?').bind(m).first()
    const e = await db.prepare("SELECT COALESCE(SUM(amount),0) a FROM ledger WHERE direction='out' AND cash=1 AND ref_type!='transfer' AND substr(created_at,1,7)=?").bind(m).first()
    const inc = await db.prepare("SELECT COALESCE(SUM(amount),0) a FROM ledger WHERE direction='in' AND cash=1 AND substr(created_at,1,7)=?").bind(m).first()
    const add = round2(num(o && o.a))
    const cost = round2(num(o && o.c))
    const expense = round2(num(e && e.a))
    rows.push({ m, label: num(m.slice(5, 7)) + '月', order_add: add, cost, gross: round2(add - cost), expense, profit: round2(add - cost - expense), cash_in: round2(num(inc && inc.a)) })
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
  const add = await db.prepare('SELECT COALESCE(SUM(price),0) a FROM orders WHERE substr(created_at,1,7)=?').bind(m).first()
  const receive = round2(num(inc && inc.a))
  const orderAdd = round2(num(add && add.a))
  const tr = round2(num(t && t.receive))
  const ta = round2(num(t && t.order_add))
  const today = new Date()
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
  const catRows = (await db.prepare("SELECT substr(created_at,1,7) AS m, category, COALESCE(SUM(amount),0) AS amt FROM ledger WHERE direction='out' AND cash=1 AND ref_type='expense' AND substr(created_at,1,7)>=? GROUP BY m, category").bind(months[6]).all()).results || []
  const map = {}
  catRows.forEach((r) => { const k = r.category || '其他'; (map[k] = map[k] || {})[r.m] = num(r.amt) })
  Object.keys(map).forEach((k) => {
    const curAmt = map[k][cur] || 0
    const prev = months.slice(1, 7).map((m) => map[k][m] || 0).filter((x) => x > 0)
    if (!prev.length || curAmt <= 0) return
    const avg = prev.reduce((a, x) => a + x, 0) / prev.length
    if (curAmt > avg * 1.5 && curAmt - avg >= 200) list.push({ tone: 'bad', kind: 'cat', party: '', text: '「' + k + '」这个月花了 ' + round2(curAmt) + ' 元，平时平均 ' + round2(avg) + ' 元，多出 ' + round2(curAmt - avg) + ' 元。', cur: round2(curAmt), avg: round2(avg) })
  })
  const arRows = (await db.prepare("SELECT substr(created_at,1,7) AS m, customer, COALESCE(SUM(price),0) AS amt FROM orders WHERE substr(created_at,1,7)>=? GROUP BY m, customer").bind(months[6]).all()).results || []
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
app.get('/year-summary', async (c) => {
  const db = c.env.DB
  const y = String(c.req.query('year') || now().slice(0, 4))
  if (!/^\d{4}$/.test(y)) return c.json({ error: '年份格式应为 YYYY' }, 400)
  const ms = []
  for (let i = 1; i <= 12; i++) ms.push(y + '-' + String(i).padStart(2, '0'))
  const rows = []
  for (const m of ms) {
    const s = await monthSum(db, m)
    rows.push({ m, month_label: Number(m.slice(5, 7)) + '月', order_add: s.orderAdd, cost: s.orderCost, gross: s.gross, expense: round2(s.expCash + s.dep + s.amort + s.accrual), profit: s.net, cash_in: s.inc, cash_out: s.out, cash_net: round2(s.inc - s.out) })
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

app.get('/month-report', async (c) => {
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
    await db.prepare('INSERT INTO import_log (type, cnt, total, dup_count, skipped_locked, ids, src, undone, created_at) VALUES (?,?,?,?,?,?,?,0,?)')
      .bind(String(type), cnt, round2(num(r && r.total)), num(r && r.dup_count), num(r && r.skipped_locked), JSON.stringify((r && r.ids) || []), String(src || ''), now()).run()
  } catch (e) { /* 记录失败不影响导入本身 */ }
}

app.get('/import-log', async (c) => {
  const db = c.env.DB
  const rows = (await db.prepare('SELECT * FROM import_log ORDER BY id DESC LIMIT 50').all()).results || []
  const out = rows.map((r) => {
    let n = 0
    try { n = (JSON.parse(r.ids || '[]') || []).length } catch (e) { n = 0 }
    return { id: r.id, type: r.type, cnt: num(r.cnt), total: round2(num(r.total)), dup_count: num(r.dup_count), skipped_locked: num(r.skipped_locked), ids_count: n, src: r.src, undone: num(r.undone), created_at: r.created_at }
  })
  return c.json({ ok: true, rows: out, count: out.length })
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
  const rr = await importRows(c.env.DB, type, rows, { confirmDup: !!cd })
  await logImport(c.env.DB, type, rr, 'paste')
  return c.json({ ok: true, imported: num(rr && rr.imported), skipped_locked: num(rr && rr.skipped_locked), dup: rr.dup || [], dup_count: num(rr && rr.dup_count), total: num(rr && rr.total) })
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
  const { customer, item_name, price, due_date, operator, rev, cost } = await c.req.json()
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
  const nc = cost !== undefined ? round2(num(cost)) : round2(num(o.cost))
  await db.prepare('UPDATE orders SET customer=?, item_name=?, price=?, due_date=?, operator=?, cost=?, rev=COALESCE(rev,0)+1 WHERE id=?')
    .bind(customer || o.customer, item_name || o.item_name, p, nd, op, nc, id).run()
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
// 收付流水：逐笔看钱进钱出（老板最常问「这个月钱花哪了」）
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
  const oAdd = num((await db.prepare("SELECT COALESCE(SUM(price),0) t FROM orders WHERE substr(created_at,1,7)=?").bind(m).first()).t)
  const pAdd = num((await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM payables WHERE substr(created_at,1,7)=?").bind(m).first()).t)
  const cashCost = num((await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND ref_type<>'transfer' AND direction='out' AND substr(created_at,1,7)=?").bind(m).first()).t)
  const cashIn = num((await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND ref_type<>'transfer' AND direction='in' AND substr(created_at,1,7)=?").bind(m).first()).t)
  const adj = await accrualAdjust(db, m)
  const costTotal = round2(cashCost + adj.net)
  const profit = round2(oAdd - pAdd - costTotal)
  const margin = oAdd > 0 ? round2((profit / oAdd) * 100) : 0
  const expenseRatio = oAdd > 0 ? round2((costTotal / oAdd) * 100) : 0
  // 保本月收入：固定月成本（固定支出+摊销+折旧+预提）/ 毛利率
  const fixedTotal = round2(num(adj.amort) + num(adj.dep) + num(adj.accrue_int))
  const fixedRows = num((await db.prepare('SELECT COALESCE(SUM(amount),0) t FROM fixed_expenses').first()).t)
  const breakEven = margin > 0 ? round2((fixedTotal + fixedRows) / (margin / 100)) : 0
  // 近 6 个月趋势
  const trend = []
  for (const mm of monthList(6)) {
    const oo = num((await db.prepare("SELECT COALESCE(SUM(price),0) t FROM orders WHERE substr(created_at,1,7)=?").bind(mm).first()).t)
    const pp = num((await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM payables WHERE substr(created_at,1,7)=?").bind(mm).first()).t)
    const cc = num((await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE cash=1 AND ref_type<>'transfer' AND direction='out' AND substr(created_at,1,7)=?").bind(mm).first()).t)
    const ad = await accrualAdjust(db, mm)
    const pf = round2(oo - pp - cc - ad.net)
    trend.push({ m: mm, order_add: round2(oo), cost: round2(cc + ad.net), profit: pf, margin: oo > 0 ? round2((pf / oo) * 100) : 0 })
  }
  const netWorth = round2((await accountBalances(db)).reduce((s, a) => s + a.balance, 0))
  // 净资产更准一点：现金 + 别人欠我 − 我欠别人 − 借款
  const arOpen = num((await db.prepare('SELECT COALESCE(SUM(price - paid - COALESCE(written_off,0)),0) t FROM orders WHERE paid + COALESCE(written_off,0) < price').first()).t)
  const apOpen = num((await db.prepare('SELECT COALESCE(SUM(amount - paid - COALESCE(written_off,0)),0) t FROM payables WHERE paid + COALESCE(written_off,0) < amount').first()).t)
  const debtOpen = num((await db.prepare("SELECT COALESCE(SUM(principal),0) t FROM debts WHERE status='open'").first()).t)
  const debtRepaid = num((await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM debt_repays WHERE kind='principal'").first()).t)
  const nw = round2(netWorth + arOpen - apOpen - Math.max(debtOpen - debtRepaid, 0))
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
  const add3 = round2(num((await db.prepare('SELECT COALESCE(SUM(price),0) AS a FROM orders WHERE substr(created_at,1,7)>=? AND substr(created_at,1,7)<=?').bind(from, to).first()).a))
  const fixedAvg = round2(fixedSum / 3)
  const varRatio = add3 > 0 ? Math.min(0.95, varSum / add3) : 0
  const gm = Math.max(0.05, 1 - varRatio)
  const breakEven = fixedAvg > 0 ? Math.round(fixedAvg / gm) : 0
  const curAdd = round2(num((await db.prepare('SELECT COALESCE(SUM(price),0) AS a FROM orders WHERE substr(created_at,1,7)=?').bind(m).first()).a))
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
  const buyM = String(a.buy_date || now()).slice(0, 7)
  const curM = now().slice(0, 7)
  const mGap = (Number(curM.slice(0, 4)) - Number(buyM.slice(0, 4))) * 12 + (Number(curM.slice(5, 7)) - Number(buyM.slice(5, 7)))
  const months = buyM > curM ? 0 : Math.max(0, mGap + 1)
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

// 按月自动折旧：每台设备每月一条（cash=0，不动现金，只进成本），当月已提过就跳过
const runDepreciation = async (db) => {
  const m = now().slice(0, 7)
  const rows = (await db.prepare('SELECT * FROM assets').all()).results
  let added = 0
  let amount = 0
  for (const a of rows) {
    const v = assetCalc(a)
    if (!(v.monthly > 0)) continue
    const buyM = String(a.buy_date || now()).slice(0, 7)
    if (buyM > m) continue
    const depCap = round2(v.cost - v.residual)
    const prev = num((await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE ref_type='dep' AND ref_id=?").bind(a.id).first()).t)
    let booked = prev
    for (let k = 0; k < Math.round(v.life_years * 12); k += 1) {
      const mm = monthOf(monthAdd(buyM + '-01', k))
      if (mm > m) break
      if (booked >= depCap - 0.01) break
      const has = await db.prepare("SELECT id FROM ledger WHERE ref_type='dep' AND ref_id=? AND substr(created_at,1,7)=?").bind(a.id, mm).first()
      if (has) continue
      const amt = round2(Math.min(v.monthly, depCap - booked))
      if (!(amt > 0)) break
      await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('out','dep',?,?,?,?,?,0,?)")
        .bind(a.id, amt, '折旧', '折旧：' + (a.name || '') + '（' + mm + '）', 0, mm + '-28').run()
      booked = round2(booked + amt)
      added += 1
      amount = round2(amount + amt)
    }
  }
  return { added, amount }
}

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
  // 对账：有差异没处理优先提醒，其次「这个月还没对过账」
  const ro = await db.prepare("SELECT COUNT(*) n FROM recon_log WHERE done=0 AND state<>'match'").first()
  if (num(ro.n) > 0) {
    const lst = await db.prepare("SELECT party, type, diff FROM recon_log WHERE done=0 AND state<>'match' ORDER BY id DESC LIMIT 3").all()
    push('yellow', `对账还有 ${num(ro.n)} 条差异没处理`, 'import',
      (lst.results || []).map((x) => ({ party: x.party || '', amount: round2(Math.abs(num(x.diff))), note: x.type === 'ap' ? '应付' : '应收' })))
  } else {
    const cm = now().slice(0, 7)
    const rl = await db.prepare('SELECT COUNT(*) n FROM recon_log WHERE month=?').bind(cm).first()
    if (num(rl.n) === 0 && num(now().slice(8, 10)) >= 10) push('gray', `${cm.slice(5)} 月还没和客户/供应商对过账`, 'import')
  }
  // 答应付款的日子过了还没付
  try {
    const br = await db.prepare("SELECT d.party, d.promise_date, d.note FROM dunning_log d WHERE d.promise_date IS NOT NULL AND substr(d.promise_date,1,10) < ? AND d.id = (SELECT MAX(x.id) FROM dunning_log x WHERE x.party=d.party AND x.promise_date IS NOT NULL)").bind(today).all()
    const arLeft = (await db.prepare('SELECT customer AS party, COALESCE(SUM(price-paid-COALESCE(written_off,0)),0) t FROM orders WHERE price-paid-COALESCE(written_off,0) > 0 GROUP BY customer').all()).results || []
    const apLeft = (await db.prepare('SELECT supplier AS party, COALESCE(SUM(amount-paid-COALESCE(written_off,0)),0) t FROM payables WHERE amount-paid-COALESCE(written_off,0) > 0 GROUP BY supplier').all()).results || []
    const lmap = {}
    for (const r of arLeft.concat(apLeft)) lmap[norm(r.party)] = round2(num(lmap[norm(r.party)]) + num(r.t))
    const brokenRows = (br.results || []).filter((x) => num(lmap[norm(x.party)]) > 0.005)
    if (brokenRows.length) {
      const sum = round2(brokenRows.reduce((a, x) => a + num(lmap[norm(x.party)]), 0))
      push('red', `${brokenRows.length} 家答应付的日子过了还没付（共 ¥${sum}）`, 'ar', brokenRows.slice(0, 3).map((x) => ({ party: x.party || '', amount: round2(num(lmap[norm(x.party)])), note: '答应 ' + String(x.promise_date).slice(5, 10) + ' 付' })))
    }
    // 答应「明天」付的，今天先提醒一句，别等过了日子才发现
    const tomorrow = addDaysIso(today, 1)
    const so = await db.prepare("SELECT d.party, d.promise_date FROM dunning_log d WHERE substr(d.promise_date,1,10) = ? AND d.id = (SELECT MAX(x.id) FROM dunning_log x WHERE x.party=d.party AND x.promise_date IS NOT NULL)").bind(tomorrow).all()
    const soonRows = (so.results || []).filter((x) => num(lmap[norm(x.party)]) > 0.005)
    if (soonRows.length) {
      const sum2 = round2(soonRows.reduce((a, x) => a + num(lmap[norm(x.party)]), 0))
      push('yellow', `${soonRows.length} 家答应明天付（共 ¥${sum2}），今天提一句`, 'ar', soonRows.slice(0, 3).map((x) => ({ party: x.party || '', amount: round2(num(lmap[norm(x.party)])), note: '答应 ' + String(x.promise_date).slice(5, 10) + ' 付' })))
    }
  } catch (e) {}
  // 对账单有异议还没处理（最容易变死账）
  try {
    const dp = await db.prepare("SELECT s.party, s.month, s.note, s.created_at FROM statement_log s WHERE s.ack='doubt' AND COALESCE(s.resolved_at,'')='' ORDER BY s.id DESC").all()
    const dl = dp.results || []
    if (dl.length) {
      push('red', `${dl.length} 份对账单对方说对不上，还没处理`, 'ar', dl.slice(0, 3).map((x) => ({ party: x.party || '', amount: 0, note: (x.note || '有异议').slice(0, 20) + '（' + daysSince(x.created_at) + ' 天前）' })))
    }
  } catch (e) {}
  // 对账单发出去 7 天还没回音
  try {
    const nr = await db.prepare("SELECT party, type, month, channel, created_at FROM statement_log WHERE COALESCE(ack,'') = '' AND date(created_at) <= date(?, '-7 day') ORDER BY created_at").bind(today).all()
    const list0 = nr.results || []
    if (list0.length) {
      push('yellow', `${list0.length} 份对账单发出去 7 天没回音`, 'ar', list0.slice(0, 3).map((x) => ({ party: x.party || '', amount: 0, note: (String(x.created_at).slice(5, 10)) + ' 用' + (x.channel || '微信') + '发的' })))
    }
  } catch (e) {}
  // 这个月还没发过对账单的欠款家（欠得久又没发单，最容易扯皮）
  try {
    const ns = await db.prepare("SELECT o.customer AS party, COUNT(*) n, COALESCE(SUM(o.price-o.paid-COALESCE(o.written_off,0)),0) t FROM orders o WHERE o.price-o.paid-COALESCE(o.written_off,0) > 0 AND substr(o.created_at,1,10) <= date(?, '-30 day') AND NOT EXISTS (SELECT 1 FROM statement_log s WHERE s.party=o.customer AND substr(s.created_at,1,7)=?) GROUP BY o.customer ORDER BY t DESC").bind(today, now().slice(0, 7)).all()
    const nr = (ns.results || [])
    if (nr.length) {
      const tt = round2(nr.reduce((a, x) => a + num(x.t), 0))
      push('yellow', `${nr.length} 家这个月还没发过对账单（欠 ¥${tt}）`, 'ar', nr.slice(0, 3).map((x) => ({ party: x.party || '', amount: round2(num(x.t)), note: '欠了 30 天以上' })))
    }
  } catch (e) {}
  // 欠了很久又一直没催过的家
  try {
    const mc = await db.prepare("SELECT value FROM settings WHERE key='collect_min_days'").first()
    const minD = Math.max(7, num(mc && mc.value) || 15)
    const nc = await db.prepare("SELECT o.customer AS party, COUNT(*) n, COALESCE(SUM(o.price-o.paid-COALESCE(o.written_off,0)),0) t FROM orders o WHERE o.price-o.paid-COALESCE(o.written_off,0) > 0 AND substr(o.created_at,1,10) <= date(?, '-" + minD + " day') AND NOT EXISTS (SELECT 1 FROM dunning_log d WHERE d.party=o.customer AND substr(d.created_at,1,10) >= date(?, '-7 day')) GROUP BY o.customer ORDER BY t DESC").bind(today, today).all()
    const nn = (nc.results || []).length
    if (nn > 0) {
      const tsum = round2((nc.results || []).reduce((a, r) => a + num(r.t), 0))
      push('yellow', `${nn} 家欠超 ${minD} 天、这周还没催过（共 ¥${tsum}）`, 'ar', (nc.results || []).slice(0, 3).map((r) => ({ party: r.party || '', amount: round2(num(r.t)), note: num(r.n) + ' 笔' })))
    }
  } catch (e) {}
  // 约定了对账周期的单位：到日子还没对过账，单独提醒
  try {
    const ts = (await db.prepare('SELECT party, recon_cycle FROM party_terms WHERE recon_cycle > 0').all()).results || []
    if (ts.length) {
      const done = (await db.prepare('SELECT party, MAX(created_at) last_at FROM recon_log GROUP BY party').all()).results || []
      const lm = (p) => { const x = done.find((d) => d.party === p); return x ? x.last_at : '' }
      const due = ts.filter((t) => { const l = lm(t.party); return !l || daysSince(l) >= num(t.recon_cycle) }).map((t) => { const l = lm(t.party); return { party: t.party, amount: 0, note: l ? `上次对账 ${daysSince(l)} 天前` : '还没对过账' } })
      if (due.length) push('yellow', `${due.length} 家到了该对账的日子`, 'import', due.slice(0, 3))
    }
  } catch (e) { /* 没设账期就不提醒 */ }
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
        await runDepreciation(db)
        const cron = (event && event.cron) || ''
        if (cron === '0 1 * * 1') await pushWeekly(db)
        else if (cron === '0 2 1 * *') {
          await pushReconRemind(db)
          // 每月 1 号：把上个月的全套报表打包存好，并推一条「报表已生成」
          try {
            const pm = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString().slice(0, 7)
            const rp = await runMonthPack(db, pm)
            if (rp && rp.ok) await pushMonthPack(db, pm)
          } catch (e) {
            console.error('month pack failed book' + bid, e)
          }
        } else {
          await runWxReminder(db)
          // 每月最后一天：推一条「这个月目标收了多少」
          const t0 = new Date()
          const lastDay = new Date(Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth() + 1, 0)).getUTCDate()
          if (t0.getUTCDate() === lastDay) { await pushTargetSummary(db); await pushDunningSummary(db) }
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
  const inc = await db.prepare("SELECT COALESCE(SUM(amount),0) a FROM ledger WHERE direction='in' AND cash=1 AND substr(created_at,1,7)=?").bind(m).first()
  const got = round2(num(inc && inc.a))
  // 回款率：近 6 个月「实收 / 开单」，下限 30%、上限 100%
  const since = (() => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 5, 1)).toISOString().slice(0, 10) })()
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
  const base = new Date()
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1))
    const m = d.toISOString().slice(0, 7)
    const t = await db.prepare('SELECT * FROM targets WHERE month=?').bind(m).first()
    const inc = await db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE direction='in' AND cash=1 AND substr(created_at,1,7)=?").bind(m).first()
    const ord = await db.prepare("SELECT COUNT(*) n, COALESCE(SUM(price),0) t FROM orders WHERE substr(created_at,1,7)=?").bind(m).first()
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
    month: (() => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 7) })(),
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
async function pushDunningSummary(db) {
  try {
    const m = now().slice(0, 7)
    const r = await dunningMonthText(db, m)
    if (!r.stat.count && !r.stat.statements) return
    await wxPush(db, { title: '这个月催款小结：收回 ¥' + r.stat.recovered, time: m, note: '催 ' + r.stat.times + ' 次、' + r.stat.count + ' 家；还欠 ¥' + r.stat.left_total + (r.stat.broken ? '；失约 ' + r.stat.broken + ' 次' : '') })
  } catch (e) { /* 没配微信就跳过 */ }
}
async function pushTargetSummary(db) {
  try {
    const m = now().slice(0, 7)
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
    const c = await db.prepare("SELECT COUNT(*) AS c FROM ledger WHERE ref_type='fixed' AND ref_id=? AND substr(created_at,1,7)=?").bind(f.id, m).first()
    if (c && c.c > 0) continue
    await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, account_id, cash, created_at) VALUES ('out','fixed',?,?,?,?,?,1,?)")
      .bind(f.id, num(f.amount), f.category || '', f.remark || '固定支出', accF, now()).run()
    n++
  }
  return n
}
