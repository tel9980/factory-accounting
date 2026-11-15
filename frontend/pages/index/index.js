const API_BASE = 'https://jz.qy663.de5.net'

Page({
  data: {
    tab: 'ar',
    ar_total: 0, ap_total: 0,
    month_income: 0, month_outcome: 0, month_profit: 0,
    ar_list: [], ap_list: [], expense_list: [],
    o_customer: '', o_item: '', o_price: '',
    p_supplier: '', p_amount: '', p_remark: '',
    categories: ['工资', '水电', '房租', '采购', '辅料', '其他'],
    e_category: 0, e_amount: '', e_remark: '',
    import_types: ['应收：客户,产品,金额', '应付：供应商,金额,备注', '支出：金额,分类,备注'],
    import_type: 0, import_text: '',
    report_year: '', report_text: '',
    history_type: 'ar', history_ar_list: [], history_ap_list: []
  },
  onShow() { this.refresh() },
  refresh() {
    this.loadDashboard()
    this.loadAr()
    this.loadAp()
    this.loadExpenses()
    this.loadHistory()
  },
  loadDashboard() {
    wx.request({
      url: API_BASE + '/dashboard',
      success: (res) => {
        if (res.data && !res.data.error) {
          this.setData({
            ar_total: res.data.ar_total, ap_total: res.data.ap_total,
            month_income: res.data.month_income, month_outcome: res.data.month_outcome,
            month_profit: res.data.month_profit
          })
        }
      }
    })
  },
  loadAr() {
    wx.request({ url: API_BASE + '/ar', success: (res) => this.setData({ ar_list: res.data || [] }) })
  },
  loadAp() {
    wx.request({ url: API_BASE + '/ap', success: (res) => this.setData({ ap_list: res.data || [] }) })
  },
  loadExpenses() {
    wx.request({ url: API_BASE + '/expenses', success: (res) => this.setData({ expense_list: res.data || [] }) })
  },
  setTab(e) { this.setData({ tab: e.currentTarget.dataset.t }) },
  onOCustomer(e) { this.setData({ o_customer: e.detail.value }) },
  onOItem(e) { this.setData({ o_item: e.detail.value }) },
  onOPrice(e) { this.setData({ o_price: e.detail.value }) },
  onPSupplier(e) { this.setData({ p_supplier: e.detail.value }) },
  onPAmount(e) { this.setData({ p_amount: e.detail.value }) },
  onPRemark(e) { this.setData({ p_remark: e.detail.value }) },
  onECategory(e) { this.setData({ e_category: Number(e.detail.value) }) },
  onEAmount(e) { this.setData({ e_amount: e.detail.value }) },
  onERemark(e) { this.setData({ e_remark: e.detail.value }) },
  onImportType(e) { this.setData({ import_type: Number(e.detail.value) }) },
  onImportText(e) { this.setData({ import_text: e.detail.value }) },
  addOrder() {
    const { o_customer, o_item, o_price } = this.data
    if (!o_customer || !o_price) return wx.showToast({ title: '客户和金额必填', icon: 'none' })
    wx.request({
      url: API_BASE + '/orders', method: 'POST',
      data: { customer: o_customer, item_name: o_item, price: Number(o_price) },
      success: () => { this.setData({ o_customer: '', o_item: '', o_price: '' }); this.refresh() }
    })
  },
  addPayable() {
    const { p_supplier, p_amount, p_remark } = this.data
    if (!p_supplier || !p_amount) return wx.showToast({ title: '供应商和金额必填', icon: 'none' })
    wx.request({
      url: API_BASE + '/payables', method: 'POST',
      data: { supplier: p_supplier, amount: Number(p_amount), remark: p_remark },
      success: () => { this.setData({ p_supplier: '', p_amount: '', p_remark: '' }); this.refresh() }
    })
  },
  addExpense() {
    const { e_amount, e_remark, categories, e_category } = this.data
    if (!e_amount) return wx.showToast({ title: '金额必填', icon: 'none' })
    wx.request({
      url: API_BASE + '/expenses', method: 'POST',
      data: { amount: Number(e_amount), category: categories[e_category], remark: e_remark },
      success: () => { this.setData({ e_amount: '', e_remark: '' }); this.refresh() }
    })
  },
  payOrder(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '收客户款', editable: true, placeholderText: '金额 或 金额,日期(如 5000,07-05)',
      success: (r) => {
        if (r.confirm && r.content) {
          const parts = r.content.split(/[,，\s]+/)
          wx.request({
            url: API_BASE + '/orders/' + id + '/receive', method: 'POST',
            data: { amount: Number(parts[0]), date: parts[1] || '' },
            success: () => this.refresh()
          })
        }
      }
    })
  },
  payPayable(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '付供应商款', editable: true, placeholderText: '金额 或 金额,日期(如 5000,07-05)',
      success: (r) => {
        if (r.confirm && r.content) {
          const parts = r.content.split(/[,，\s]+/)
          wx.request({
            url: API_BASE + '/payables/' + id + '/pay', method: 'POST',
            data: { amount: Number(parts[0]), date: parts[1] || '' },
            success: () => this.refresh()
          })
        }
      }
    })
  },
  finishOrder(e) {
    const id = e.currentTarget.dataset.id
    wx.request({
      url: API_BASE + '/orders/' + id + '/status', method: 'POST',
      data: { status: 2 },
      success: () => this.refresh()
    })
  },
  delOrder(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除应收单', content: '会连同它的收款记录一起删除，确定？',
      success: (r) => {
        if (r.confirm) {
          wx.request({ url: API_BASE + '/orders/' + id, method: 'DELETE', success: () => this.refresh() })
        }
      }
    })
  },
  delPayable(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除应付单', content: '会连同它的付款记录一起删除，确定？',
      success: (r) => {
        if (r.confirm) {
          wx.request({ url: API_BASE + '/payables/' + id, method: 'DELETE', success: () => this.refresh() })
        }
      }
    })
  },
  delExpense(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除支出', content: '确定删除这条支出流水？',
      success: (r) => {
        if (r.confirm) {
          wx.request({ url: API_BASE + '/ledger/' + id, method: 'DELETE', success: () => this.refresh() })
        }
      }
    })
  },
  statement(e) {
    const { type, name } = e.currentTarget.dataset
    wx.request({
      url: API_BASE + '/statement', data: { type, name },
      success: (res) => {
        wx.setClipboardData({
          data: res.data.text,
          success: () => wx.showToast({ title: '对账单已复制', icon: 'none' })
        })
      }
    })
  },
  monthStatement(e) {
    const { type, name } = e.currentTarget.dataset
    const d = new Date()
    const ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    wx.showModal({
      title: '按月对账 · ' + name,
      editable: true,
      placeholderText: '月份，如 ' + ym,
      content: ym,
      success: (r) => {
        if (r.confirm && r.content) {
          wx.request({
            url: API_BASE + '/statement-month',
            data: { type, name, month: r.content.trim() },
            success: (res) => {
              wx.setClipboardData({
                data: res.data.text,
                success: () => wx.showToast({ title: '月对账单已复制', icon: 'none' })
              })
            }
          })
        }
      }
    })
  },
  doImport() {
    const { import_type, import_text, import_types } = this.data
    const types = ['ar', 'ap', 'expense']
    if (!import_text.trim()) return wx.showToast({ title: '请先粘贴内容', icon: 'none' })
    wx.request({
      url: API_BASE + '/import', method: 'POST',
      data: { type: types[import_type], text: import_text },
      success: (res) => {
        const n = (res.data && res.data.imported) || 0
        wx.showToast({ title: '已导入 ' + n + ' 条', icon: 'none' })
        this.setData({ import_text: '' })
        this.refresh()
      }
    })
  },
  onReportYear(e) { this.setData({ report_year: e.detail.value }) },
  genReport() {
    const y = this.data.report_year.trim() || String(new Date().getFullYear())
    wx.request({
      url: API_BASE + '/report', data: { year: y },
      success: (res) => {
        if (res.data && res.data.text) this.setData({ report_text: res.data.text })
      }
    })
  },
  copyReport() {
    wx.setClipboardData({
      data: this.data.report_text,
      success: () => wx.showToast({ title: '报表已复制', icon: 'none' })
    })
  },
  loadHistory() {
    wx.request({ url: API_BASE + '/history?type=ar', success: (res) => this.setData({ history_ar_list: res.data || [] }) })
    wx.request({ url: API_BASE + '/history?type=ap', success: (res) => this.setData({ history_ap_list: res.data || [] }) })
  },
  setHistoryType(e) { this.setData({ history_type: e.currentTarget.dataset.t }) }
})
