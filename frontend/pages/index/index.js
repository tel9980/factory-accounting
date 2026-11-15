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
    rb_customer: '', rb_amount: '', rb_date: '',
    today_income: 0, top_customer: '', top_unpaid: 0,
    o_customer: '', o_item: '', o_price: '', o_due: '', o_operator: '',
    p_supplier: '', p_amount: '', p_remark: '', p_operator: '',
    categories: ['工资', '水电', '房租', '采购', '辅料', '其他'],
    e_category: 0, e_amount: '', e_remark: '', e_operator: '',
    import_types: ['应收：客户,产品,金额', '应付：供应商,金额,备注', '支出：金额,分类,备注', '期初应收：客户,金额', '期初应付：供应商,金额'],
    import_type: 0, import_text: '',
    import_hint: '每行一条，用逗号分隔，末尾可带日期（如 07-05）\n应收：客户,产品,金额\n应付：供应商,金额,备注\n支出：金额,分类,备注\n期初应收：客户,金额（不带日期默认记年初）\n期初应付：供应商,金额（不带日期默认记年初）',
    report_year: '', report_text: '', chart: [],
    cmp_month: '', analysis_text: '',
    pc_month: '', pc: null,
    q_text: '',
    history_type: 'ar', history_ar_list: [], history_ap_list: [],
    contact_type: 'ar', contacts_ar: [], contacts_ap: [],
    contact_show: false, contact_title: '', contact_text: '',
    trash_list: [],
    cloud_backup_at: '',
    restore_text: '',
    fixed_list: [], f_amount: '', f_category: 0, f_day: '', f_remark: '',
    lock_month: '', month_locks: [],
    audit_logs: []
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
    this.loadFixed()
    this.loadMonthLocks()
    this.loadAuditLogs()
    this.loadTrash()
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
            due_soon_count: res.data.due_soon_count, due_soon: res.data.due_soon || [],
            today_income: res.data.today_income || 0,
            top_customer: res.data.top_customer || '', top_unpaid: res.data.top_unpaid || 0
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
  setTab(e) {
    const t = e.currentTarget.dataset.t
    this.setData({ tab: t })
    if (t === 'report') { this.loadFixed(); this.loadMonthLocks(); this.loadProfitCompare() }
  },
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
  onRbCustomer(e) { this.setData({ rb_customer: e.detail.value }) },
  onRbAmount(e) { this.setData({ rb_amount: e.detail.value }) },
  onRbDate(e) { this.setData({ rb_date: e.detail.value }) },
  pickRbCustomer(e) { this.setData({ rb_customer: e.currentTarget.dataset.n }) },
  receiveBatch() {
    const customer = (this.data.rb_customer || '').trim()
    const amount = Number(this.data.rb_amount)
    if (!customer) return wx.showToast({ title: '填客户名称', icon: 'none' })
    if (!(amount > 0)) return wx.showToast({ title: '填收款金额', icon: 'none' })
    wx.showModal({
      title: '批量核销收款',
      content: '收到 ' + customer + ' ¥' + amount + '，将按「先老后新」抵掉未结的单，确定吗？',
      success: (r) => {
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/receive-batch', method: 'POST',
          data: { customer, amount, date: this.data.rb_date },
          success: (res) => {
            const d = res.data || {}
            if (d.ok) {
              const detail = (d.used || []).map((x) => `· ${x.item} 抵 ¥${x.use}（原欠¥${x.unpaid}）`).join('\n')
              wx.showModal({
                title: '核销成功',
                content: `共核销 ¥${d.total}，${(d.used || []).length} 张单\n${detail}` + (d.rest > 0 ? `\n\n还剩 ¥${d.rest} 没抵完（已无未结单或已抵完）` : ''),
                showCancel: false
              })
              this.setData({ rb_amount: '', rb_date: '' })
              this.refresh()
            } else {
              wx.showToast({ title: d.error || '核销失败', icon: 'none' })
            }
          }
        })
      }
    })
  },
  dunning() {
    wx.showLoading({ title: '生成中…' })
    this.req({
      url: API_BASE + '/dunning?type=' + this.data.tab,
      success: (res) => {
        wx.hideLoading()
        const text = res.data
        if (!text) return wx.showToast({ title: '没有待催款', icon: 'none' })
        wx.showModal({
          title: '催款清单',
          content: String(text).slice(0, 400),
          confirmText: '复制',
          cancelText: '存图片',
          success: (r) => {
            if (r.confirm) {
              wx.setClipboardData({ data: text, success: () => wx.showToast({ title: '已复制，可发微信', icon: 'none' }) })
            } else {
              this.drawTextImage(text)
            }
          }
        })
      },
      fail: () => wx.hideLoading()
    })
  },
  payPayable(e) {    const id = e.currentTarget.dataset.id
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
  editProgress(e) {
    const id = e.currentTarget.dataset.id
    const it = this.data.ar_all.find((x) => x.id === id) || {}
    wx.showActionSheet({
      itemList: ['更新进度', '查看进度历史'],
      success: (r) => {
        if (r.tapIndex === 0) this.inputProgress(id, it)
        else this.viewProcesses(id, it)
      }
    })
  },
  inputProgress(id, it) {
    wx.showModal({
      title: '更新工序（' + (it.customer || '') + '）', editable: true,
      placeholderText: '如：备料 / 加工 / 喷涂 / 包装',
      content: it.progress || '',
      success: (r) => {
        if (r.confirm) {
          this.req({
            url: API_BASE + '/orders/' + id + '/progress', method: 'PATCH',
            data: { progress: (r.content || '').trim(), operator: this.data.o_operator || '' },
            success: (res) => {
              if (res.data && res.data.error) wx.showToast({ title: res.data.error, icon: 'none' })
              else { wx.showToast({ title: '已更新', icon: 'success' }); this.refresh() }
            }
          })
        }
      }
    })
  },
  viewProcesses(id, it) {
    this.req({
      url: API_BASE + '/orders/' + id + '/processes',
      success: (res) => {
        const list = res.data || []
        if (!list.length) return wx.showToast({ title: '暂无工序记录', icon: 'none' })
        const lines = list.map((p) => p.progress + (p.operator ? ' · ' + p.operator : '') + ' · ' + (p.created_at || '').slice(0, 16).replace('T', ' '))
        wx.showModal({ title: (it.customer || '') + ' 工序历史', content: lines.join('\n'), showCancel: false })
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
  onPcMonth(e) { this.setData({ pc_month: e.detail.value }) },
  loadProfitCompare() {
    const m = (this.data.pc_month || '').trim()
    this.req({
      url: API_BASE + '/profit-compare' + (m ? '?month=' + encodeURIComponent(m) : ''),
      success: (res) => {
        if (res.data && !res.data.error) {
          const d = res.data
          d.cost_cash = Math.round((Number(d.expense_cash || 0) + Number(d.fixed_cash || 0)) * 100) / 100
          this.setData({ pc: d })
        }
      }
    })
  },
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
  onCmpMonth(e) { this.setData({ cmp_month: e.detail.value }) },
  genCredits() {
    this.req({
      url: API_BASE + '/credits',
      success: (res) => {
        const list = res.data || []
        if (!list.length) return wx.showToast({ title: '还没有客户记录', icon: 'none' })
        const L = []
        L.push('【客户欠款排行】')
        L.push('客户 | 未结欠款 | 未结单数 | 最久几天 | 平均回款')
        let i = 0
        for (const r of list) {
          i++
          if (i > 20) break
          const avg = r.avg_days === null ? '—' : r.avg_days + '天'
          L.push(`${i}. ${r.name} | ¥${r.unpaid} | ${r.open_cnt}单 | ${r.oldest}天 | ${avg}`)
        }
        const bad = list.filter((r) => r.unpaid > 0 && r.oldest > 60)
        if (bad.length) {
          L.push('')
          L.push('⚠ 超过 60 天没结：' + bad.map((r) => `${r.name}（¥${r.unpaid}，${r.oldest}天）`).join('、'))
        }
        const slow = list.filter((r) => r.avg_days !== null).sort((a, b) => b.avg_days - a.avg_days)[0]
        if (slow) {
          L.push('')
          L.push(`回款最慢：${slow.name}（平均 ${slow.avg_days} 天到账）`)
        }
        this.setData({ analysis_text: L.join('\n') })
      }
    })
  },
  genCompare() {
    const m = (this.data.cmp_month || '').trim()
    this.req({
      url: API_BASE + '/compare',
      data: m ? { month: m } : {},
      success: (res) => {
        const d = res.data || {}
        if (d.error) return wx.showToast({ title: d.error, icon: 'none' })
        const cur = d.cur, pv = d.prev, ly = d.last_year
        const rate = (a, b) => {
          if (!b) return a ? '新增' : '—'
          const r = Math.round(((a - b) / b) * 1000) / 10
          return (r >= 0 ? '+' : '') + r + '%'
        }
        const L = []
        L.push(`【${cur.month} 经营对比】`)
        L.push(`收到钱：¥${cur.income}（上月 ¥${pv.income}，${rate(cur.income, pv.income)}；去年同月 ¥${ly.income}，${rate(cur.income, ly.income)}）`)
        L.push(`付出去：¥${cur.outcome}（上月 ¥${pv.outcome}，${rate(cur.outcome, pv.outcome)}；去年同月 ¥${ly.outcome}，${rate(cur.outcome, ly.outcome)}）`)
        L.push(`结余：¥${cur.net}（上月 ¥${pv.net}；去年同月 ¥${ly.net}）`)
        L.push('')
        L.push(`接单额：¥${cur.order_add}（上月 ¥${pv.order_add}，${rate(cur.order_add, pv.order_add)}）`)
        L.push(`赊购额：¥${cur.payable_add}（上月 ¥${pv.payable_add}，${rate(cur.payable_add, pv.payable_add)}）`)
        L.push('')
        const trend = cur.net > pv.net ? '比上月好' : cur.net === pv.net ? '与上月持平' : '比上月差'
        L.push(`一句话：这个月结余${trend}，收钱 ${rate(cur.income, pv.income)}，花钱 ${rate(cur.outcome, pv.outcome)}。`)
        this.setData({ analysis_text: L.join('\n') })
      }
    })
  },
  genSelfcheck() {
    this.req({
      url: API_BASE + '/selfcheck',
      success: (res) => {
        const d = res.data || {}
        if (d.error) return wx.showToast({ title: d.error, icon: 'none' })
        const L = []
        L.push('【账目自检】')
        L.push(`应收单据 ${d.orders} 张，应付单据 ${d.payables} 张`)
        L.push(`应收未结 ¥${d.ar_total}（按单据算）／¥${d.ar_check}（按单据金额−已收算）`)
        L.push(`应付未结 ¥${d.ap_total}`)
        L.push(`累计收款 ¥${d.flow_in}，累计付款 ¥${d.flow_out}`)
        L.push('')
        if (d.ok) {
          L.push('✅ 检查通过：每张单据的已收/已付与流水记录完全对得上，没有多收，账面是干净的。')
        } else {
          L.push('⚠ 发现对不上的地方：')
          if (d.mismatch) L.push(`· 应收单据与收款流水不一致 ${d.mismatch} 张`)
          if (d.ap_mismatch) L.push(`· 应付单据与付款流水不一致 ${d.ap_mismatch} 张`)
          if (d.overpaid) L.push(`· 收款超过单据金额 ${d.overpaid} 张`)
          for (const s of d.issues || []) L.push('  ' + s)
          L.push('')
          L.push('处理办法：把这几张的单据金额改对，或补录/删除多出的收款记录。')
        }
        this.setData({ analysis_text: L.join('\n') })
      }
    })
  },
  copyAnalysis() {
    wx.setClipboardData({
      data: this.data.analysis_text,
      success: () => wx.showToast({ title: '已复制', icon: 'none' })
    })
  },
  analysisImage() {
    this.drawTextImage(this.data.analysis_text)
  },
  genReportImage() {
    const text = this.data.report_text
    if (!text) return wx.showToast({ title: '先点「生成报表」', icon: 'none' })
    this.drawTextImage(text)
  },
  drawTextImage(text) {
    wx.showLoading({ title: '生成图片…' })
    const FONT = 15, LH = 22, PAD = 20, W = 750
    const unit = (ch) => (/[\u0000-\u00ff]/.test(ch) ? 0.55 : 1)
    const wrap = []
    for (const line of text.split('\n')) {
      if (!line.trim()) { wrap.push(' '); continue }
      let cur = '', w = 0
      for (const ch of line) {
        const u = unit(ch)
        if (w + u > (W - PAD * 2) / FONT) { wrap.push(cur); cur = ch; w = u }
        else { cur += ch; w += u }
      }
      if (cur) wrap.push(cur)
    }
    const H = PAD * 2 + wrap.length * LH
    wx.createSelectorQuery().in(this).select('#reportCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) return wx.hideLoading()
        const canvas = res[0].node
        const ctx = canvas.getContext('2d')
        const dpr = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).pixelRatio || 2
        canvas.width = W * dpr
        canvas.height = H * dpr
        ctx.scale(dpr, dpr)
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, W, H)
        ctx.fillStyle = '#111111'
        ctx.font = FONT + 'px sans-serif'
        ctx.textBaseline = 'top'
        wrap.forEach((t, i) => ctx.fillText(t, PAD, PAD + i * LH))
        wx.canvasToTempFilePath({
          canvas,
          destWidth: W * dpr,
          destHeight: H * dpr,
          success: (r) => {
            wx.hideLoading()
            wx.previewImage({ urls: [r.tempFilePath] })
          },
          fail: () => { wx.hideLoading(); wx.showToast({ title: '生成失败', icon: 'none' }) }
        })
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
          this.setData({
            contact_show: true,
            contact_title: (type === 'ar' ? '客户' : '供应商') + '对账单 · ' + name,
            contact_text: res.data.text
          })
        }
      }
    })
  },
  closeContact() { this.setData({ contact_show: false }) },
  copyContactText() {
    wx.setClipboardData({
      data: this.data.contact_text,
      success: () => wx.showToast({ title: '已复制', icon: 'none' })
    })
  },
  genContactImage() {
    const text = this.data.contact_text
    if (!text) return wx.showToast({ title: '暂无内容', icon: 'none' })
    this.drawTextImage(text)
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
  },
  onRestoreInput(e) { this.setData({ restore_text: e.detail.value }) },
  restoreData() {
    const t = this.data.restore_text.trim()
    if (!t) return wx.showToast({ title: '先粘贴备份文本', icon: 'none' })
    wx.showModal({
      title: '从备份恢复',
      content: '恢复会用备份内容覆盖当前全部账目（恢复前会自动留一份云端快照），确定吗？',
      success: (r) => {
        if (!r.confirm) return
        wx.showLoading({ title: '恢复中…' })
        this.req({
          url: API_BASE + '/restore', method: 'POST',
          data: { text: t },
          success: (res) => {
            wx.hideLoading()
            if (res.data && res.data.ok) {
              const d = res.data.restored || {}
              wx.showToast({ title: '已恢复：应收' + (d.orders || 0) + ' 应付' + (d.payables || 0) + ' 流水' + (d.ledger || 0), icon: 'none' })
              this.setData({ restore_text: '' })
              this.refresh()
            } else {
              wx.showToast({ title: (res.data && res.data.error) || '恢复失败', icon: 'none' })
            }
          },
          fail: () => wx.hideLoading()
        })
      }
    })
  },
  loadFixed() {
    this.req({ url: API_BASE + '/fixed', success: (res) => this.setData({ fixed_list: res.data || [] }) })
  },
  onFAmount(e) { this.setData({ f_amount: e.detail.value }) },
  onFCategory(e) { this.setData({ f_category: Number(e.detail.value) }) },
  onFDay(e) { this.setData({ f_day: e.detail.value }) },
  onFRemark(e) { this.setData({ f_remark: e.detail.value }) },
  addFixed() {
    const amount = Number(this.data.f_amount)
    const day = Number(this.data.f_day)
    if (!(amount > 0)) return wx.showToast({ title: '金额必填', icon: 'none' })
    if (!(day >= 1 && day <= 28)) return wx.showToast({ title: '每月号数填 1–28', icon: 'none' })
    this.req({
      url: API_BASE + '/fixed', method: 'POST',
      data: { amount, category: this.data.categories[this.data.f_category], day, remark: this.data.f_remark },
      success: (res) => {
        if (res.data && res.data.ok) {
          this.setData({ f_amount: '', f_remark: '', f_day: '' })
          this.loadFixed()
          wx.showToast({ title: '已添加', icon: 'success' })
        } else {
          wx.showToast({ title: (res.data && res.data.error) || '添加失败', icon: 'none' })
        }
      }
    })
  },
  delFixed(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除固定支出',
      content: '删除后不再每月自动记这笔；已经记过的流水不会删。确定吗？',
      success: (r) => {
        if (r.confirm) this.req({ url: API_BASE + '/fixed/' + id, method: 'DELETE', success: () => this.loadFixed() })
      }
    })
  },
  runFixed() {
    this.req({
      url: API_BASE + '/run-fixed', method: 'POST',
      success: (res) => {
        if (res.data && res.data.ok) {
          wx.showToast({ title: '本月已补记 ' + res.data.added + ' 笔', icon: 'none' })
          this.refresh()
        }
      }
    })
  },
  loadMonthLocks() {
    this.req({ url: API_BASE + '/month-locks', success: (res) => this.setData({ month_locks: res.data || [] }) })
  },
  loadAuditLogs() {
    this.req({ url: API_BASE + '/audit-logs', success: (res) => this.setData({ audit_logs: res.data || [] }) })
  },
  onLockMonth(e) { this.setData({ lock_month: e.detail.value }) },
  lockMonth() {
    const m = (this.data.lock_month || '').trim()
    if (!/^\d{4}-\d{2}$/.test(m)) return wx.showToast({ title: '月份格式：2026-11', icon: 'none' })
    wx.showModal({
      title: '月度结账锁定',
      content: '锁定 ' + m + ' 后，该月所有账目不能再增、删、改。确定吗？',
      success: (r) => {
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/month-lock', method: 'POST',
          data: { month: m },
          success: (res) => {
            if (res.data && res.data.ok) {
              this.setData({ lock_month: '' })
              this.loadMonthLocks()
              wx.showToast({ title: '已锁定 ' + m, icon: 'success' })
            } else {
              wx.showToast({ title: (res.data && res.data.error) || '锁定失败', icon: 'none' })
            }
          }
        })
      }
    })
  },
  unlockMonth(e) {
    const m = e.currentTarget.dataset.m
    wx.showModal({
      title: '解除锁定',
      content: '解锁 ' + m + ' 后，该月账目恢复可编辑。确定吗？',
      success: (r) => {
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/month-lock/' + m, method: 'DELETE',
          success: () => { this.loadMonthLocks(); wx.showToast({ title: '已解锁 ' + m, icon: 'success' }) }
        })
      }
    })
  },
  loadTrash() {
    this.req({ url: API_BASE + '/trash', success: (res) => this.setData({ trash_list: res.data || [] }) })
  },
  restoreTrash(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '恢复',
      content: '把这批删掉的账恢复到原处。确定吗？',
      success: (r) => {
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/trash/' + id + '/restore', method: 'POST',
          success: (res) => {
            if (res.data && res.data.ok) {
              this.loadTrash()
              this.refresh()
              wx.showToast({ title: '已恢复 ' + res.data.restored + ' 条', icon: 'success' })
            } else {
              wx.showToast({ title: (res.data && res.data.error) || '恢复失败', icon: 'none' })
            }
          }
        })
      }
    })
  },
  purgeTrash(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '彻底删除',
      content: '彻底删除后无法恢复。确定吗？',
      confirmColor: '#e64340',
      success: (r) => {
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/trash/' + id, method: 'DELETE',
          success: () => { this.loadTrash(); wx.showToast({ title: '已彻底删除', icon: 'success' }) }
        })
      }
    })
  }
})
