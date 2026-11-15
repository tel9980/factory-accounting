const API_BASE = 'https://jz.qy663.de5.net'

const STATUS_TEXT = { 0: '待加工', 1: '加工中', 2: '已交付' }
const CATEGORIES = ['工资', '水电', '房租', '采购', '辅料', '其他']

Page({
  data: {
    month_income: 0,
    month_expense: 0,
    month_profit: 0,
    unpaid_total: 0,
    pending_count: 0,
    orders: [],

    customer: '',
    item_name: '',
    price: '',

    expense_amount: '',
    expense_category: '其他',
    expense_category_index: 5,
    expense_remark: '',
    categories: CATEGORIES,
  },

  onShow() { this.loadDashboard() },

  loadDashboard() {
    wx.request({
      url: API_BASE + '/dashboard',
      success: (res) => {
        const d = res.data || {}
        const orders = (d.recent_orders || []).map((o) => ({
          ...o,
          status_text: STATUS_TEXT[o.status] || '未知',
          unpaid: (o.price - o.paid).toFixed(2),
        }))
        this.setData({
          month_income: d.month_income || 0,
          month_expense: d.month_expense || 0,
          month_profit: d.month_profit || 0,
          unpaid_total: d.unpaid_total || 0,
          pending_count: d.pending_count || 0,
          orders,
        })
      },
      fail: () => wx.showToast({ title: '网络错误', icon: 'none' }),
    })
  },

  // ---- 订单 ----
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
        this.loadDashboard()
      },
      fail: () => wx.showToast({ title: '网络错误', icon: 'none' }),
    })
  },

  // ---- 收款：一键收全款，可改数字 ----
  payFull(e) {
    const id = e.currentTarget.dataset.id
    const unpaid = e.currentTarget.dataset.unpaid
    wx.showModal({
      title: '收款',
      content: '剩余欠款 ' + unpaid + ' 元，输入本次收款金额',
      editable: true,
      placeholderText: unpaid,
      success: (res) => {
        if (res.confirm) {
          const amount = parseFloat(res.content) || parseFloat(unpaid)
          wx.request({
            url: API_BASE + '/orders/' + id + '/payments',
            method: 'POST',
            data: { amount },
            success: () => {
              wx.showToast({ title: '已收款' })
              this.loadDashboard()
            },
            fail: () => wx.showToast({ title: '网络错误', icon: 'none' }),
          })
        }
      },
    })
  },

  finishOrder(e) {
    const id = e.currentTarget.dataset.id
    wx.request({
      url: API_BASE + '/orders/' + id,
      method: 'PATCH',
      data: { status: 2 },
      success: () => this.loadDashboard(),
      fail: () => wx.showToast({ title: '网络错误', icon: 'none' }),
    })
  },

  // ---- 支出 ----
  onExpenseAmount(e) { this.setData({ expense_amount: e.detail.value }) },
  onExpenseRemark(e) { this.setData({ expense_remark: e.detail.value }) },
  onExpenseCategory(e) {
    const i = Number(e.detail.value)
    this.setData({ expense_category_index: i, expense_category: CATEGORIES[i] })
  },

  addExpense() {
    const { expense_amount, expense_category, expense_remark } = this.data
    if (!expense_amount) {
      wx.showToast({ title: '填金额', icon: 'none' })
      return
    }
    wx.request({
      url: API_BASE + '/expenses',
      method: 'POST',
      data: { amount: Number(expense_amount), category: expense_category, remark: expense_remark },
      success: () => {
        wx.showToast({ title: '已记录' })
        this.setData({ expense_amount: '', expense_remark: '' })
        this.loadDashboard()
      },
      fail: () => wx.showToast({ title: '网络错误', icon: 'none' }),
    })
  },
})
