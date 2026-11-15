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
    q_text: '',
    history_type: 'ar', history_ar_list: [], history_ap_list: [],
    contact_type: 'ar', contacts_ar: [], contacts_ap: []
  },
  req(opts) {
    const ak = wx.getStorageSync('ak') || ''
    const doReq = (key) => {
      wx.request(Object.assign({}, opts, {
        header: Object.assign({ 'X-Access-Key': key }, opts.header),
        success: (res) => {
          if (res.statusCode === 401) {
            if (this._askingKey) return
            this._askingKey = true
            const code = res.data && res.data.code
            const done = () => { this._askingKey = false }
            if (code === 'no_key') {
              wx.showModal({
                title: '首次使用',
                content: '先设置一个访问口令（至少 4 位，记牢）',
                editable: true, placeholderText: '设置口令',
                success: (r) => {
                  if (r.confirm && r.content) {
                    const k = r.content.trim()
                    wx.request({
                      url: API_BASE + '/auth/setup', method: 'POST',
                      data: { key: k },
                      success: (s) => {
                        done()
                        if (s.data && s.data.ok) { wx.setStorageSync('ak', k); doReq(k) }
                        else wx.showToast({ title: (s.data && s.data.error) || '设置失败', icon: 'none' })
                      },
                      fail: () => { done(); wx.showToast({ title: '网络失败', icon: 'none' }) }
                    })
                  } else done()
                }
              })
            } else {
              wx.showModal({
                title: '访问口令', editable: true, placeholderText: '请输入访问口令',
                success: (r) => {
                  if (r.confirm && r.content) {
                    const k = r.content.trim()
                    wx.setStorageSync('ak', k)
                    done(); doReq(k)
                  } else done()
                }
              })
            }
            return
          }
          opts.success && opts.success(res)
        }
      }))
    }
    doReq(ak)
  },

  onShow() { this.refresh() },
  refresh() {
    this.loadDashboard()
    this.loadAr()
    this.loadAp()
    this.loadExpenses()
    this.loadHistory()
    this.loadContacts()
  },
  loadDashboard() {
    this.req({
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
    this.req({ url: API_BASE + '/ar', success: (res) => this.setData({ ar_list: res.data || [] }) })
  },
  loadAp() {
    this.req({ url: API_BASE + '/ap', success: (res) => this.setData({ ap_list: res.data || [] }) })
  },
  loadExpenses() {
    this.req({ url: API_BASE + '/expenses', success: (res) => this.setData({ expense_list: res.data || [] }) })
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
    this.req({
      url: API_BASE + '/orders', method: 'POST',
      data: { customer: o_customer, item_name: o_item, price: Number(o_price) },
      success: () => { this.setData({ o_customer: '', o_item: '', o_price: '' }); this.refresh() }
    })
  },
  addPayable() {
    const { p_supplier, p_amount, p_remark } = this.data
    if (!p_supplier || !p_amount) return wx.showToast({ title: '供应商和金额必填', icon: 'none' })
    this.req({
      url: API_BASE + '/payables', method: 'POST',
      data: { supplier: p_supplier, amount: Number(p_amount), remark: p_remark },
      success: () => { this.setData({ p_supplier: '', p_amount: '', p_remark: '' }); this.refresh() }
    })
  },
  addExpense() {
    const { e_amount, e_remark, categories, e_category } = this.data
    if (!e_amount) return wx.showToast({ title: '金额必填', icon: 'none' })
    this.req({
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
          this.req({
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
          this.req({
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
    this.req({
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
          this.req({ url: API_BASE + '/orders/' + id, method: 'DELETE', success: () => this.refresh() })
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
          this.req({ url: API_BASE + '/payables/' + id, method: 'DELETE', success: () => this.refresh() })
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
          this.req({ url: API_BASE + '/ledger/' + id, method: 'DELETE', success: () => this.refresh() })
        }
      }
    })
  },
  statement(e) {
    const { type, name } = e.currentTarget.dataset
    this.req({
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
          this.req({
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
    this.req({
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
  onQText(e) { this.setData({ q_text: e.detail.value }) },
  quick() {
    const t = this.data.q_text.trim()
    if (!t) return
    this.req({
      url: API_BASE + '/quick', method: 'POST',
      data: { text: t },
      success: (res) => {
        if (res.data && res.data.error) {
          wx.showToast({ title: res.data.error, icon: 'none' })
        } else {
          wx.showToast({ title: '已记：' + res.data.summary, icon: 'none' })
          this.setData({ q_text: '' })
          this.refresh()
        }
      }
    })
  },
  genReport() {
    const y = this.data.report_year.trim() || String(new Date().getFullYear())
    this.req({
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
  changeKey() {
    wx.showModal({
      title: '修改访问口令',
      content: '格式：旧口令,新口令（逗号分隔）',
      editable: true,
      placeholderText: '旧口令,新口令',
      success: (r) => {
        if (r.confirm && r.content) {
          const p = r.content.split(/[,，]/).map((s) => s.trim())
          if (p.length < 2 || !p[0] || !p[1]) return wx.showToast({ title: '格式：旧口令,新口令', icon: 'none' })
          wx.request({
            url: API_BASE + '/auth/change', method: 'POST',
            data: { old_key: p[0], new_key: p[1] },
            success: (s) => {
              if (s.data && s.data.ok) {
                wx.setStorageSync('ak', p[1])
                wx.showToast({ title: '口令已修改', icon: 'none' })
              } else {
                wx.showToast({ title: (s.data && s.data.error) || '修改失败', icon: 'none' })
              }
            }
          })
        }
      }
    })
  },
  loadHistory() {
    this.req({ url: API_BASE + '/history?type=ar', success: (res) => this.setData({ history_ar_list: res.data || [] }) })
    this.req({ url: API_BASE + '/history?type=ap', success: (res) => this.setData({ history_ap_list: res.data || [] }) })
  },
  setHistoryType(e) { this.setData({ history_type: e.currentTarget.dataset.t }) },
  loadContacts() {
    this.req({ url: API_BASE + '/contacts', success: (res) => {
      if (res.data && !res.data.error) {
        this.setData({ contacts_ar: res.data.ar || [], contacts_ap: res.data.ap || [] })
      }
    }})
  },
  setContactType(e) { this.setData({ contact_type: e.currentTarget.dataset.t }) },
  contactDetail(e) {
    const { type, name } = e.currentTarget.dataset
    this.req({
      url: API_BASE + '/contact-detail', data: { type, name },
      success: (res) => {
        if (res.data && res.data.text) {
          wx.setClipboardData({
            data: res.data.text,
            success: () => wx.showToast({ title: '往来明细已复制', icon: 'none' })
          })
        }
      }
    })
  },
  backup() {
    wx.showModal({
      title: '备份全部数据',
      content: '会把全部订单、应付、流水打包成文本复制到剪贴板，粘贴到微信/记事本/电脑保存即可',
      success: (r) => {
        if (r.confirm) {
          this.req({
            url: API_BASE + '/backup',
            success: (res) => {
              if (res.data && res.data.text) {
                wx.setClipboardData({
                  data: res.data.text,
                  success: () => wx.showToast({ title: '已复制，请粘贴保存', icon: 'none' })
                })
              }
            }
          })
        }
      }
    })
  }
})
