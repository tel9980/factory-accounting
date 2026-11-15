import { Hono } from 'hono'

const app = new Hono()

// 订单列表（含欠款）
app.get('/orders', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM orders ORDER BY id DESC'
  ).all()
  return c.json(results || [])
})

// 新建订单
app.post('/orders', async (c) => {
  const body = await c.req.json()
  const customer = String(body.customer || '').trim()
  const item_name = String(body.item_name || '').trim()
  const price = Number(body.price || 0)
  if (!customer || !item_name || !(price > 0)) {
    return c.json({ success: false, error: '客户、产品、加工费必填' }, 400)
  }
  const { meta } = await c.env.DB.prepare(
    'INSERT INTO orders (customer, item_name, price, status, paid) VALUES (?, ?, ?, 0, 0)'
  ).bind(customer, item_name, price).run()
  return c.json({ success: true, id: meta.last_row_id })
})

// 更新订单状态（0 待加工 / 1 加工中 / 2 已交付）
app.patch('/orders/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  if (body.status !== undefined) {
    const status = Number(body.status)
    await c.env.DB.prepare('UPDATE orders SET status = ? WHERE id = ?').bind(status, id).run()
  }
  if (body.paid !== undefined) {
    const paid = Number(body.paid)
    await c.env.DB.prepare('UPDATE orders SET paid = ? WHERE id = ?').bind(paid, id).run()
    if (paid > 0) {
      await c.env.DB.prepare(
        'INSERT INTO payments (order_id, amount, type, remark) VALUES (?, ?, 1, ?)'
      ).bind(id, paid, body.remark || '').run()
    }
  }
  return c.json({ success: true })
})

// 汇总：应收总额、已收总额、未收总额
app.get('/summary', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT COALESCE(SUM(price),0) AS total, COALESCE(SUM(paid),0) AS paid FROM orders'
  ).all()
  const r = results[0] || { total: 0, paid: 0 }
  return c.json({ total: r.total, paid: r.paid, unpaid: r.total - r.paid })
})

export default app
