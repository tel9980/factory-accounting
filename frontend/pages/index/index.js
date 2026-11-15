// 部署好 Cloudflare Worker 后，把下面这行换成你的 Worker 地址（保留 /orders 等路径之前的域名部分）
const API_BASE = 'https://factory-accounting.tel9980-fb9.workers.dev'

const STATUS_TEXT = { 0: '待加工', 1: '加工中', 2: '已交付' }

Page({
  data: {
    customer: '',
    item_name: '',
    price: '',
    orders: [],
    summary: { unpaid: 0 }
  },

  onCustomerInput(e) { this.setData({ customer: e.detail.value }) },
  onItemInput(e) { this.setData({ item_name: e.detail.value }) },
  onPriceInput(e) { this.setData({ price: e.detail.value }) },

  addOrder() {
    const { customer, item_name, price } = this.data
    if (!customer || !item_name || !price) {
      wx.showToast({ title: '请填写完整', icon: 'none' })
      return
    }
    wx.request({
      url: API_BASE + '/orders',
      method: 'POST',
      data: { customer, item_name, price: Number(price) },
      success: () => {
        wx.showToast({ title: '已记录' })
        this.setData({ customer: '', item_name: '', price: '' })
        this.loadData()
      },
      fail: () => wx.showToast({ title: '网络错误', icon: 'none' })
    })
  },

  finishOrder(e) {
    const id = e.currentTarget.dataset.id
    wx.request({
      url: API_BASE + '/orders/' + id,
      method: 'PATCH',
      data: { status: 2 },
      success: () => this.loadData()
    })
  },

  loadData() {
    wx.request({
      url: API_BASE + '/orders',
      success: (res) => {
        const orders = (res.data || []).map((o) => ({
          ...o,
          status_text: STATUS_TEXT[o.status] || '未知',
          unpaid: (o.price - o.paid).toFixed(2)
        }))
        this.setData({ orders })
      }
    })
    wx.request({
      url: API_BASE + '/summary',
      success: (res) => {
        this.setData({ summary: res.data || { unpaid: 0 } })
      }
    })
  },

  onLoad() { this.loadData() },
  onShow() { this.loadData() }
})
