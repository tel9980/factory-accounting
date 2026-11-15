import { Hono } from 'hono'

const app = new Hono()

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

app.options('*', (c) => c.json({}, 200, cors))

const round = (n) => Math.round(Number(n || 0) * 100) / 100
const nowIso = () => new Date().toISOString()
const monthOf = (d) => d.toISOString().slice(0, 7) // YYYY-MM

// ===== 核心：dashboard 合并接口（一次返回首页全部数据） =====
app.get('/dashboard', async (c) => {
  const db = c.env.DB
  const month = c.req.query('month') || monthOf(new Date())

  const unpaid = await db.prepare(
    'SELECT COALESCE(SUM(price - paid), 0) AS total FROM orders WHERE status < 2'
  ).first()

  const income = await db.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE substr(created_at,1,7) = ?'
  ).bind(month).first()

  const expense = await db.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE substr(created_at,1,7) = ?'
  ).bind(month).first()

  const pending = await db.prepare(
    'SELECT COUNT(*) AS n FROM orders WHERE status < 2'
  ).first()

  const recent = await db.prepare(
    'SELECT * FROM orders ORDER BY id DESC LIMIT 30'
  ).all()

  return c.json({
    month,
    unpaid_total: round(unpaid.total),
    month_income: round(income.total),
    month_expense: round(expense.total),
    month_profit: round(income.total - expense.total),
    pending_count: pending.n,
    recent_orders: recent.results,
  }, 200, cors)
})

// ===== 订单 =====
app.get('/orders', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') || 30), 200)
  const offset = Math.max(Number(c.req.query('offset') || 0), 0)
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM orders ORDER BY id DESC LIMIT ? OFFSET ?'
  ).bind(limit, offset).all()
  return c.json(results, 200, cors)
})

app.post('/orders', async (c) => {
  const { customer, item_name, price } = await c.req.json()
  if (!customer || !item_name || !price) {
    return c.json({ error: '缺少客户/产品/加工费' }, 400, cors)
  }
  await c.env.DB.prepare(
    'INSERT INTO orders (customer, item_name, price, status, paid, created_at) VALUES (?, ?, ?, 0, 0, ?)'
  ).bind(String(customer).trim(), String(item_name).trim(), Number(price), nowIso()).run()
  return c.json({ success: true }, 200, cors)
})

app.patch('/orders/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  if (body.status !== undefined) {
    await c.env.DB.prepare(
      'UPDATE orders SET status = ? WHERE id = ?'
    ).bind(Number(body.status), id).run()
  }
  return c.json({ success: true }, 200, cors)
})

// ===== 收款（流水 + 更新订单已收，D1 batch 保证一致） =====
app.post('/orders/:id/payments', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const amount = Number(body.amount)
  if (!amount || amount <= 0) return c.json({ error: '金额无效' }, 400, cors)

  const db = c.env.DB
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first()
  if (!order) return c.json({ error: '订单不存在' }, 404, cors)

  const due = round(Number(order.price) - Number(order.paid))
  if (amount > due + 0.001) return c.json({ error: '收款超过剩余欠款 ' + due }, 400, cors)

  await db.batch([
    db.prepare('INSERT INTO payments (order_id, amount, created_at) VALUES (?, ?, ?)')
      .bind(id, amount, nowIso()),
    db.prepare('UPDATE orders SET paid = paid + ? WHERE id = ?').bind(amount, id),
  ])
  return c.json({ success: true }, 200, cors)
})

// ===== 支出 =====
app.post('/expenses', async (c) => {
  const { amount, category, remark } = await c.req.json()
  if (!amount || Number(amount) <= 0) return c.json({ error: '金额无效' }, 400, cors)
  await c.env.DB.prepare(
    'INSERT INTO expenses (amount, category, remark, created_at) VALUES (?, ?, ?, ?)'
  ).bind(Number(amount), String(category || '其他'), String(remark || ''), nowIso()).run()
  return c.json({ success: true }, 200, cors)
})

app.get('/expenses', async (c) => {
  const month = c.req.query('month') || monthOf(new Date())
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM expenses WHERE substr(created_at,1,7) = ? ORDER BY id DESC'
  ).bind(month).all()
  return c.json(results, 200, cors)
})

// ===== 客户汇总 =====
app.get('/customers', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT customer,
            COUNT(*) AS order_count,
            SUM(price) AS total_price,
            SUM(paid) AS total_paid,
            SUM(price - paid) AS unpaid
     FROM orders GROUP BY customer ORDER BY unpaid DESC`
  ).all()
  return c.json(results, 200, cors)
})

export default app
