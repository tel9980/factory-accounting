import { Hono } from 'hono'

const app = new Hono()

app.use('*', async (c, next) => {
  await next()
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  c.header('Access-Control-Allow-Headers', 'Content-Type')
})
app.options('*', (c) => c.text('', 204))

const now = () => new Date().toISOString()
const month = () => new Date().toISOString().slice(0, 7)
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const round2 = (x) => Math.round(x * 100) / 100

// 首页汇总
app.get('/dashboard', async (c) => {
  const db = c.env.DB
  const m = month()
  const ar = await db.prepare('SELECT COALESCE(SUM(price-paid),0) AS total FROM orders WHERE paid < price').first()
  const ap = await db.prepare('SELECT COALESCE(SUM(amount-paid),0) AS total FROM payables WHERE paid < amount').first()
  const inc = await db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM ledger WHERE direction='in' AND substr(created_at,1,7)=?").bind(m).first()
  const out = await db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM ledger WHERE direction='out' AND substr(created_at,1,7)=?").bind(m).first()
  const pending = await db.prepare('SELECT COUNT(*) AS n FROM orders WHERE status < 2').first()
  const recent = await db.prepare('SELECT * FROM ledger ORDER BY id DESC LIMIT 10').all()
  return c.json({
    ar_total: round2(num(ar.total)),
    ap_total: round2(num(ap.total)),
    month_income: round2(num(inc.total)),
    month_outcome: round2(num(out.total)),
    month_profit: round2(num(inc.total) - num(out.total)),
    pending_count: pending.n,
    recent: recent.results
  })
})

// 应收：未结清订单
app.get('/ar', async (c) => {
  const db = c.env.DB
  const { results } = await db.prepare('SELECT * FROM orders WHERE paid < price ORDER BY id DESC LIMIT 200').all()
  return c.json(results.map((r) => ({ ...r, unpaid: round2(r.price - r.paid) })))
})

// 应付：未结清应付单
app.get('/ap', async (c) => {
  const db = c.env.DB
  const { results } = await db.prepare('SELECT * FROM payables WHERE paid < amount ORDER BY id DESC LIMIT 200').all()
  return c.json(results.map((r) => ({ ...r, unpaid: round2(r.amount - r.paid) })))
})

// 支出流水
app.get('/expenses', async (c) => {
  const db = c.env.DB
  const { results } = await db.prepare("SELECT * FROM ledger WHERE direction='out' ORDER BY id DESC LIMIT 100").all()
  return c.json(results)
})

// 记应收（加工订单）
app.post('/orders', async (c) => {
  const { customer, item_name, price } = await c.req.json()
  if (!customer || num(price) <= 0) return c.json({ error: '客户和金额必填' }, 400)
  const db = c.env.DB
  await db.prepare('INSERT INTO orders (customer, item_name, price, status, paid, created_at) VALUES (?,?,?,0,0,?)')
    .bind(customer, item_name || '', num(price), now()).run()
  return c.json({ ok: true })
})

// 收客户款
app.post('/orders/:id/receive', async (c) => {
  const id = c.req.param('id')
  const { amount } = await c.req.json()
  const db = c.env.DB
  const o = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first()
  if (!o) return c.json({ error: '订单不存在' }, 404)
  const a = num(amount)
  if (a <= 0) return c.json({ error: '金额无效' }, 400)
  await db.batch([
    db.prepare('UPDATE orders SET paid=paid+? WHERE id=?').bind(a, id),
    db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, remark, created_at) VALUES ('in','order',?,?,?,?)")
      .bind(id, a, `收 ${o.customer} ${o.item_name}`, now())
  ])
  return c.json({ ok: true })
})

// 订单状态
app.post('/orders/:id/status', async (c) => {
  const id = c.req.param('id')
  const { status } = await c.req.json()
  const db = c.env.DB
  await db.prepare('UPDATE orders SET status=? WHERE id=?').bind(num(status), id).run()
  return c.json({ ok: true })
})

// 记应付
app.post('/payables', async (c) => {
  const { supplier, amount, category, remark } = await c.req.json()
  if (!supplier || num(amount) <= 0) return c.json({ error: '供应商和金额必填' }, 400)
  const db = c.env.DB
  await db.prepare('INSERT INTO payables (supplier, amount, paid, category, remark, created_at) VALUES (?,?,0,?,?,?)')
    .bind(supplier, num(amount), category || '', remark || '', now()).run()
  return c.json({ ok: true })
})

// 付供应商款
app.post('/payables/:id/pay', async (c) => {
  const id = c.req.param('id')
  const { amount } = await c.req.json()
  const db = c.env.DB
  const p = await db.prepare('SELECT * FROM payables WHERE id=?').bind(id).first()
  if (!p) return c.json({ error: '应付单不存在' }, 404)
  const a = num(amount)
  if (a <= 0) return c.json({ error: '金额无效' }, 400)
  await db.batch([
    db.prepare('UPDATE payables SET paid=paid+? WHERE id=?').bind(a, id),
    db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, created_at) VALUES ('out','payable',?,?,?,?,?)")
      .bind(id, a, p.category || '', `付 ${p.supplier} ${p.remark}`, now())
  ])
  return c.json({ ok: true })
})

// 现付支出
app.post('/expenses', async (c) => {
  const { amount, category, remark } = await c.req.json()
  if (num(amount) <= 0) return c.json({ error: '金额必填' }, 400)
  const db = c.env.DB
  await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, created_at) VALUES ('out','expense',0,?,?,?,?)")
    .bind(num(amount), category || '', remark || '', now()).run()
  return c.json({ ok: true })
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

// 批量导入
app.post('/import', async (c) => {
  const { type, text } = await c.req.json()
  const rows = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean)
  if (!rows.length) return c.json({ error: '没有可导入的内容' }, 400)
  const db = c.env.DB
  let n = 0
  const t = now()
  for (const row of rows) {
    const p = row.split(/[,，\t]/).map((s) => s.trim())
    if (type === 'ar') {
      const [customer, item, price] = p
      if (customer && num(price) > 0) {
        await db.prepare('INSERT INTO orders (customer, item_name, price, status, paid, created_at) VALUES (?,?,?,0,0,?)')
          .bind(customer, item || '批量导入', num(price), t).run()
        n++
      }
    } else if (type === 'ap') {
      const [supplier, amount, remark] = p
      if (supplier && num(amount) > 0) {
        await db.prepare('INSERT INTO payables (supplier, amount, paid, category, remark, created_at) VALUES (?,?,0,?,?,?)')
          .bind(supplier, num(amount), '', remark || '', t).run()
        n++
      }
    } else if (type === 'expense') {
      const [amount, category, remark] = p
      if (num(amount) > 0) {
        await db.prepare("INSERT INTO ledger (direction, ref_type, ref_id, amount, category, remark, created_at) VALUES ('out','expense',0,?,?,?,?)")
          .bind(num(amount), category || '', remark || '', t).run()
        n++
      }
    }
  }
  return c.json({ imported: n })
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
    "SELECT substr(created_at,1,7) AS m, SUM(CASE WHEN direction='in' THEN amount ELSE 0 END) AS inc, SUM(CASE WHEN direction='out' THEN amount ELSE 0 END) AS out FROM ledger WHERE created_at LIKE ? GROUP BY m ORDER BY m"
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
    "SELECT COALESCE(NULLIF(category,''),'其他') AS c, SUM(amount) AS t FROM ledger WHERE direction='out' AND created_at LIKE ? GROUP BY c ORDER BY t DESC"
  ).bind(prefix).all()
  lines.push('')
  lines.push('【支出分类】')
  for (const r of cats) lines.push(`${r.c}：${fmt(num(r.t))}`)
  if (!cats.length) lines.push('（无支出）')
  // 应收应付
  const ar = await db.prepare('SELECT COALESCE(SUM(price-paid),0) AS t FROM orders WHERE paid < price').first()
  const ap = await db.prepare('SELECT COALESCE(SUM(amount-paid),0) AS t FROM payables WHERE paid < amount').first()
  const inAll = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='in'").first()
  const outAll = await db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE direction='out'").first()
  lines.push('')
  lines.push('【应收应付】')
  lines.push(`累计已收款：${fmt(num(inAll.t))}`)
  lines.push(`累计已付款：${fmt(num(outAll.t))}`)
  lines.push(`客户还欠我：${fmt(num(ar.t))}`)
  lines.push(`我还欠供应商：${fmt(num(ap.t))}`)
  return c.json({ text: lines.join('\n') })
})

export default app
