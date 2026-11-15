const API_BASE = 'https://jz.qy663.de5.net'

Page({
  data: {
    tab: 'ar',
    ar_total: 0, ap_total: 0,
    month_income: 0, month_outcome: 0, month_profit: 0,
    month_order_add: 0, month_payable_add: 0, profit_biz: 0,
    overdue_count: 0, overdue: [],
    due_soon_count: 0, due_soon: [],
    ar_list: [], ap_list: [], expense_list: [],
    ar_all: [], ap_all: [], exp_all: [],
    ar_kw: '', ap_kw: '', ex_kw: '',
    o_customer: '', o_item: '', o_price: '', o_due: '', o_operator: '',
    p_supplier: '', p_amount: '', p_remark: '', p_operator: '',
    categories: ['工资', '水电', '房租', '采购', '辅料', '其他'],
    e_category: 0, e_amount: '', e_remark: '', e_operator: '',
    import_types: ['应收：客户,产品,金额', '应付：供应商,金额,备注', '支出：金额,分类,备注', '期初应收：客户,金额', '期初应付：供应商,金额'],
    import_type: 0, import_text: '',
    import_hint: '每行一条，用逗号分隔，末尾可带日期（如 07-05）\n应收：客户,产品,金额\n应付：供应商,金额,备注\n支出：金额,分类,备注\n期初应收：客户,金额（不带日期默认记年初）\n期初应付：供应商,金额（不带日期默认记年初）',
    report_year: '', report_text: '', chart: [],
    q_text: '',
    history_type: 'ar', history_ar_list: [], history_ap_list: [],
    contact_type: 'ar', contacts_ar: [], contacts_ap: [],
    cloud_backup_at: ''
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

  onShow() { this.refresh(); this.loadCloudBackup() },
  refresh() {
    this.loadDashboard()
    this.loadAr()
    this.loadAp()
    this.loadExpenses()
    this.loadHistory()
    this.loadContacts()
  },
  loadCloudBackup() {
    this.req({
      url: API_BASE + '/backup-list',
      success: (res) => {
        const list = res.data || []
        if (list.length) this.setData({ cloud_backup_at: list[0].created_at })
      }
    })
  },
  loadDashboard() {
    this.req({
      url: API_BASE + '/dashboard',
      success: (res) => {
        if (res.data && !res.data.error) {
          this.setData({
            ar_total: res.data.ar_total, ap_total: res.data.ap_total,
            month_income: res.data.month_income, month_outcome: res.data.month_outcome,
            month_profit: res.data.month_profit,
            month_order_add: res.data.month_order_add, month_payable_add: res.data.month_payable_add,
            profit_biz: res.data.profit_biz,
            overdue_count: res.data.overdue_count, overdue: res.data.overdue || [],
            due_soon_count: res.data.due_soon_count, due_soon: res.data.due_soon || []
          })
        }
      }
    })
  },
  loadAr() {
    this.req({ url: API_BASE + '/ar', success: (res) => {
      const all = res.data || []
      this.setData({ ar_all: all, ar_list: this.filterAr(all, this.data.ar_kw) })
    } })
  },
  loadAp() {
    this.req({ url: API_BASE + '/ap', success: (res) => {
      const all = res.data || []
      this.setData({ ap_all: all, ap_list: this.filterAp(all, this.data.ap_kw) })
    } })
  },
  loadExpenses() {
    this.req({ url: API_BASE + '/expenses', success: (res) => {
      const all = res.data || []
      this.setData({ exp_all: all, expense_list: this.filterEx(all, this.data.ex_kw) })
    } })
  },
  filterAr(list, kw) { kw = (kw || '').trim(); return kw ? list.filter((x) => (x.customer + ' ' + (x.item_name || '')).indexOf(kw) >= 0) : list },
  filterAp(list, kw) { kw = (kw || '').trim(); return kw ? list.filter((x) => (x.supplier + ' ' + (x.remark || '')).indexOf(kw) >= 0) : list },
  filterEx(list, kw) { kw = (kw || '').trim(); return kw ? list.filter((x) => ((x.category || '') + ' ' + (x.remark || '')).indexOf(kw) >= 0) : list },
  onArKw(e) { this.setData({ ar_kw: e.detail.value, ar_list: this.filterAr(this.data.ar_all, e.detail.value) }) },
  onApKw(e) { this.setData({ ap_kw: e.detail.value, ap_list: this.filterAp(this.data.ap_all, e.detail.value) }) },
  onExKw(e) { this.setData({ ex_kw: e.detail.value, expense_list: this.filterEx(this.data.exp_all, e.detail.value) }) },
  setTab(e) { this.setData({ tab: e.currentTarget.dataset.t }) },
  onOCustomer(e) { this.setData({ o_customer: e.detail.value }) },
  onOItem(e) { this.setData({ o_item: e.detail.value }) },
  onOPrice(e) { this.setData({ o_price: e.detail.value }) },
  onODue(e) { this.setData({ o_due: e.detail.value }) },
  onOOperator(e) { this.setData({ o_operator: e.detail.value }) },
  pickCustomer(e) { this.setData({ o_customer: e.currentTarget.dataset.n }) },
  onPSupplier(e) { this.setData({ p_supplier: e.detail.value }) },
  onPAmount(e) { this.setData({ p_amount: e.detail.value }) },
  onPRemark(e) { this.setData({ p_remark: e.detail.value }) },
  onPOperator(e) { this.setData({ p_operator: e.detail.value }) },
  pickSupplier(e) { this.setData({ p_supplier: e.currentTarget.dataset.n }) },
  onECategory(e) { this.setData({ e_category: Number(e.detail.value) }) },
  onEAmount(e) { this.setData({ e_amount: e.detail.value }) },
  onERemark(e) { this.setData({ e_remark: e.detail.value }) },
  onEOperator(e) { this.setData({ e_operator: e.detail.value }) },
  onImportType(e) { this.setData({ import_type: Number(e.detail.value) }) },
  onImportText(e) { this.setData({ import_text: e.detail.value }) },
  addOrder() {
    const { o_customer, o_item, o_price, o_due, o_operator } = this.data
    if (!o_customer || !o_price) return wx.showToast({ title: '客户和金额必填', icon: 'none' })
    this.req({
      url: API_BASE + '/orders', method: 'POST',
      data: { customer: o_customer, item_name: o_item, price: Number(o_price), due_date: o_due, operator: o_operator },
      success: () => { this.setData({ o_customer: '', o_item: '', o_price: '', o_due: '', o_operator: '' }); this.refresh() }
    })
  },
  addPayable() {
    const { p_supplier, p_amount, p_remark, p_operator } = this.data
    if (!p_supplier || !p_amount) return wx.showToast({ title: '供应商和金额必填', icon: 'none' })
    this.req({
      url: API_BASE + '/payables', method: 'POST',
      data: { supplier: p_supplier, amount: Number(p_amount), remark: p_remark, operator: p_operator },
      success: () => { this.setData({ p_supplier: '', p_amount: '', p_remark: '', p_operator: '' }); this.refresh() }
    })
  },
  addExpense() {
    const { e_amount, e_remark, categories, e_category, e_operator } = this.data
    if (!e_amount) return wx.showToast({ title: '金额必填', icon: 'none' })
    this.req({
      url: API_BASE + '/expenses', method: 'POST',
      data: { amount: Number(e_amount), category: categories[e_category], remark: e_remark, operator: e_operator },
      success: () => { this.setData({ e_amount: '', e_remark: '', e_operator: '' }); this.refresh() }
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
  editOrder(e) {
    const id = e.currentTarget.dataset.id
    const it = this.data.ar_all.find((x) => x.id === id) || {}
    wx.showModal({
      title: '改应收单', editable: true,
      placeholderText: '客户,产品,金额',
      content: [it.customer, it.item_name, it.price].join(','),
      success: (r) => {
        if (r.confirm && r.content) {
          const p = r.content.split(/[,，]/).map((s) => s.trim())
          this.req({
            url: API_BASE + '/orders/' + id, method: 'PATCH',
            data: { customer: p[0], item_name: p[1], price: Number(p[2]) },
            success: (res) => {
              if (res.data && res.data.error) wx.showToast({ title: res.data.error, icon: 'none' })
              else this.refresh()
            }
          })
        }
      }
    })
  },
  editPayable(e) {
    const id = e.currentTarget.dataset.id
    const it = this.data.ap_all.find((x) => x.id === id) || {}
    wx.showModal({
      title: '改应付单', editable: true,
      placeholderText: '供应商,金额,备注',
      content: [it.supplier, it.amount, it.remark || ''].join(','),
      success: (r) => {
        if (r.confirm && r.content) {
          const p = r.content.split(/[,，]/).map((s) => s.trim())
          this.req({
            url: API_BASE + '/payables/' + id, method: 'PATCH',
            data: { supplier: p[0], amount: Number(p[1]), remark: p[2] || '' },
            success: (res) => {
              if (res.data && res.data.error) wx.showToast({ title: res.data.error, icon: 'none' })
              else this.refresh()
            }
          })
        }
      }
    })
  },
  editExpense(e) {
    const id = e.currentTarget.dataset.id
    const it = this.data.exp_all.find((x) => x.id === id) || {}
    wx.showModal({
      title: '改支出', editable: true,
      placeholderText: '金额,分类,备注',
      content: [it.amount, it.category, it.remark || ''].join(','),
      success: (r) => {
        if (r.confirm && r.content) {
          const p = r.content.split(/[,，]/).map((s) => s.trim())
          this.req({
            url: API_BASE + '/ledger/' + id, method: 'PATCH',
            data: { amount: Number(p[0]), category: p[1] || '', remark: p[2] || '' },
            success: (res) => {
              if (res.data && res.data.error) wx.showToast({ title: res.data.error, icon: 'none' })
              else this.refresh()
            }
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
    const types = ['ar', 'ap', 'expense', 'ar_init', 'ap_init']
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
    this.req({
      url: API_BASE + '/report-data', data: { year: y },
      success: (res) => {
        const list = res.data || []
        const max = Math.max(1, ...list.map((x) => Math.max(x.inc, x.out)))
        this.setData({ chart: list.map((x) => ({ ...x, m_short: x.m.slice(5), inc_w: Math.round(x.inc / max * 100), out_w: Math.round(x.out / max * 100) })) })
      }
    })
  },
  exportCsv(e) {
    const type = e.currentTarget.dataset.type
    const names = { orders: '应收账单', payables: '应付账单', ledger: '全部收支流水' }
    wx.showModal({
      title: '导出 Excel',
      content: '会把' + (names[type] || '数据') + '做成表格文本复制到剪贴板，粘贴到电脑记事本另存为 .csv 文件，再用 Excel 打开即可。',
      success: (r) => {
        if (r.confirm) {
          this.req({
            url: API_BASE + '/export', data: { type },
            success: (res) => {
              if (res.data && res.data.text) {
                wx.setClipboardData({
                  data: res.data.text,
                  success: () => wx.showToast({ title: '已复制，去电脑粘贴保存', icon: 'none' })
                })
              }
            }
          })
        }
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
  },
  cloudBackup() {
    this.req({
      url: API_BASE + '/cloud-backup', method: 'POST',
      success: (res) => {
        if (res.data && res.data.ok) {
          this.setData({ cloud_backup_at: res.data.saved_at })
          wx.showToast({ title: '云端备份成功', icon: 'success' })
        } else {
          wx.showToast({ title: (res.data && res.data.error) || '备份失败', icon: 'none' })
        }
      }
    })
  },
  backupToNotes() {
    wx.showModal({
      title: '备份到笔记站',
      content: '把全部账目生成一篇笔记，写到你的 Markdown 笔记站（md.1211.cc.cd），每天凌晨会自动同步一次',
      success: (r) => {
        if (!r.confirm) return
        wx.showLoading({ title: '正在写入…' })
        this.req({
          url: API_BASE + '/backup-to-notes', method: 'POST',
          success: (res) => {
            wx.hideLoading()
            if (res.data && res.data.ok) {
              wx.showToast({ title: '已备份到笔记站', icon: 'success' })
            } else {
              wx.showToast({ title: (res.data && res.data.error) || '备份失败', icon: 'none' })
            }
          },
          fail: () => wx.hideLoading()
        })
      }
    })
  }
})
