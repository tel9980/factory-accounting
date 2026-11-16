const API_BASE = 'https://jz.qy663.de5.net'

Page({
  data: {
    tab: 'home', group: 'home',
    ar_total: 0, ap_total: 0,
    month_income: 0, month_outcome: 0, month_profit: 0,
    month_order_add: 0, month_payable_add: 0, profit_biz: 0,
    overdue_count: 0, overdue: [],
    due_soon_count: 0, due_soon: [], pay_soon_count: 0, pay_soon: [],
    ar_list: [], ap_list: [], expense_list: [],
    ar_all: [], ap_all: [], exp_all: [], onboard: null,
    ar_kw: '', ap_kw: '', ex_kw: '',
    rb_customer: '', rb_amount: '', rb_date: '',
    today_income: 0, top_customer: '', top_unpaid: 0,
    o_customer: '', o_item: '', o_price: '', o_due: '', o_operator: '', o_date: '',
    p_supplier: '', p_amount: '', p_remark: '', p_operator: '', p_due: '', p_date: '',
    ar_off: 0, ap_off: 0, ex_off: 0, ar_more: false, ap_more: false, ex_more: false, import_file_name: '',
    categories: ['工资', '水电', '房租', '采购', '辅料', '运费', '维修', '税金', '其他'],
    e_category: 0, e_amount: '', e_remark: '', e_operator: '', e_acc: 0, e_date: '',
    l_staff: '', l_amount: '', l_remark: '', loans: [], loan_staff: [], loan_open: 0,
    cur_loan: 0, cur_loan_name: '', rl_amount: '', rl_category: 0, rl_remark: '',
    cash_balance: 0, accounts: [], acc_names: [], acc_idx: 0, acc_id: 0, acc_name: '',
    tr_from: -1, tr_to: -1, tr_amount: '', tr_remark: '', tr_rows: [],
    wf_rows: [], wf_bad: 0, wf_waived: 0,
    adv_in: [], adv_out: [], adv_type: 0, a_party: '', a_amount: '', a_remark: '',
    new_acc_name: '', new_acc_opening: '', new_cat_name: '', new_cat_type: 0,
    import_types: ['应收：客户,产品,金额', '应付：供应商,金额,备注', '支出：金额,分类,备注', '借支：员工,金额,备注', '报销：员工,金额,分类,备注', '期初应收：客户,金额', '期初应付：供应商,金额'],
    role: 'owner', staff_enabled: false, cf: null,
    prepaids: [], prepaid_sum: {}, pp_name: '', pp_total: '', pp_months: '12', pp_cat: '房租', pp_start: '',
    month_amort: 0, month_accrue_int: 0, month_dep: 0, month_expense_cash: 0,
    debts: [], debt_sum: {}, credit_limits: [], d_lender: '', d_principal: '', d_rate: '6', d_start: '', d_term: '12', d_kind: 0, d_paykind: 0, d_remark: '',
    debt_kinds: ['银行贷款', '个人借款', '其他'], debt_paykinds: ['按月付息到期还本', '等额本息', '到期一次还本付息'], issue_count: 0, issue_at: '',
    amts: [50, 100, 200, 500, 1000, 2000],
    import_type: 0, import_text: '',
    import_hint: '每行一条，用逗号分隔，末尾可带日期（如 07-05）\n应收：客户,产品,金额\n应付：供应商,金额,备注\n支出：金额,分类,备注\n借支：员工,金额,备注\n报销：员工,金额,分类,备注\n期初应收：客户,金额（不带日期默认记年初）\n期初应付：供应商,金额（不带日期默认记年初）',
    report_year: '', report_text: '', chart: [],
    cmp_month: '', analysis_text: '', ex_month: '', ex_from: '', ex_to: '',
    pc_month: '', pc: null,
    q_text: '',
    history_type: 'ar', history_ar_list: [], history_ap_list: [],
    contact_type: 'ar', contacts_ar: [], contacts_ap: [],
    sug_ar: [], sug_ap: [], sug_ex: [], last_tip: '',
    contact_show: false, contact_title: '', contact_text: '',
    trash_list: [],
    ar_filter: 'open', ar_sort: 'new', ar_sum: {}, ap_filter: 'open', ap_sort: 'new', ap_sum: {},
    ar_view: 'order', ap_view: 'order', ar_groups: [], ap_groups: [], ar_open: '', ap_open: '',
    detail_show: false, detail_title: '', detail_head: '', detail_rows: [], detail_text: '',
    ar_filters: [{ k: 'open', n: '全部未结' }, { k: 'overdue', n: '逾期 30 天+' }, { k: 'due', n: '7 天内到期' }, { k: 'closed', n: '已结清' }],
    ar_sorts: [{ k: 'new', n: '最新' }, { k: 'old', n: '最久未结' }, { k: 'amount', n: '金额大' }, { k: 'due', n: '最近到期' }],
    cloud_backup_at: '',
    rem_items: [],
    inv_type: 'out', inv_month: '', inv_no: '', inv_party: '', inv_amount: '', inv_tax: '', inv_date: '', inv_remark: '',
    inv_rows: [], inv_sum: { out: {}, in: {} }, inv_uninv: {},
    asset_name: '', asset_cost: '', asset_buy: '', asset_life: '', asset_res: '',
    asset_rows: [], asset_cost_total: 0, asset_monthly: 0, asset_net: 0,
    bank_text: '', bank_rows: [], bank_unmatched: {},
    bank_hint: '一行一笔：日期,收/付,金额,摘要\n如：2026-11-10,收,8000,张老板货款',
    restore_text: '',
    fixed_list: [], f_amount: '', f_category: 0, f_day: '', f_remark: '',
    lock_month: '', month_locks: [],
    audit_logs: [],
    search_kw: '', search_res: null,
    phrases: [], phrase_kind: 0,
    budget_over: [], budget_alert_count: 0,
    budgets: [], b_category: 0, b_amount: '',
    book: 1, book_name: '主账套', books: [], rename_text: '',
    nw: [], nw_max: 1, nw_latest: null,
    aging_type: 'ar', aging: null, wx_appid: '', wx_secret: '', wx_tpl: '', wx_fields: '', wx_info: null, wx_openid: '', wx_msg: '',
    kpi: null,
    mr_month: '', mr_text: '',
    head_title: '', head_note: ''
  },
  req(opts) {
    const ak = wx.getStorageSync('ak') || ''
    const bk = String(wx.getStorageSync('book') || 1)
    const doReq = (key) => {
      wx.request(Object.assign({}, opts, {
        header: Object.assign({ 'X-Access-Key': key, 'X-Book': bk }, opts.header),
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
          if (res.statusCode >= 400) {
            const d = res.data || {}
            if (d.code === 'conflict') {
              wx.showModal({
                title: '这笔刚有变化', content: d.error, confirmText: '刷新看看', cancelText: '知道了',
                success: (r3) => { if (r3.confirm) this.refresh() }
              })
              opts.fail && opts.fail(res)
              return
            }
            if (d.dup && opts.dupRetry) {
              wx.showModal({
                title: '可能重复了', content: d.error, confirmText: '再记一笔',
                success: (r2) => {
                  if (r2.confirm) {
                    const body = Object.assign({}, opts.data, { confirm_dup: true })
                    this.req(Object.assign({}, opts, { data: body, dupRetry: false }))
                  }
                }
              })
              return
            }
            wx.showToast({ title: d.error || '操作失败', icon: 'none' })
            opts.fail && opts.fail(res)
            return
          }
          opts.success && opts.success(res)
        }
      }))
    }
    doReq(ak)
  },

  onShow() {
    // 第一次进来沿用上次记支出用的分类，少点一次
    if (!this._catInit) {
      this._catInit = true
      const lc = wx.getStorageSync('last_cat')
      if (lc !== '' && lc !== null && lc !== undefined) this.setData({ e_category: Number(lc) })
    }
    this.refresh(); this.loadCloudBackup()
  },
  refresh() {
    this.loadDashboard()
    this.loadAr()
    this.loadAp()
    this.loadArSummary()
    this.loadGroups('ar')
    this.loadGroups('ap')
    this.loadExpenses()
    this.loadHistory()
    this.loadContacts()
    this.loadMe()
    this.loadCashflow()
    this.loadDebts()
    this.loadPrepaids()
    this.loadLimits()
    this.loadFixed()
    this.loadMonthLocks()
    this.loadAuditLogs()
    this.loadTrash()
    this.loadPhrases()
    this.loadBudgets()
    this.loadLoans()
    this.loadBooks()
    this.loadReminders()
    this.loadOnboard()
    this.loadAccounts()
    this.loadCategories()
    this.loadAdvances()
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
  // ── 资金账户 / 分类 / 预收预付 ──
  loadAccounts() {
    this.req({
      url: API_BASE + '/accounts',
      fail: () => {},
      success: (res) => {
        const d = res.data || {}
        if (d.error) return
        const list = d.accounts || []
        let idx = Number(this.data.acc_idx) || 0
        if (idx >= list.length) idx = 0
        this.setData({
          accounts: list, acc_names: list.map((a) => a.name + ' ¥' + a.balance),
          cash_balance: d.total_balance || 0,
          acc_idx: idx, acc_id: list.length ? list[idx].id : 0,
          acc_name: list.length ? list[idx].name : ''
        })
      }
    })
  },
  loadCategories() {
    this.req({
      url: API_BASE + '/categories',
      fail: () => {},
      success: (res) => {
        const d = res.data || {}
        if (d.error) return
        const out = (d.out || []).map((x) => x.name)
        this.setData({
          categories: out.length ? out : this.data.categories,
          cats_out: d.out || [], cats_in: d.inn || []
        })
      }
    })
  },
  loadAdvances() {
    this.req({
      url: API_BASE + '/advances?type=in',
      fail: () => {},
      success: (res) => { this.setData({ adv_in: (res.data || []).filter((x) => x.remain > 0) }) }
    })
    this.req({
      url: API_BASE + '/advances?type=out',
      fail: () => {},
      success: (res) => { this.setData({ adv_out: (res.data || []).filter((x) => x.remain > 0) }) }
    })
  },
  onAdvType(e) { this.setData({ adv_type: Number(e.detail.value) }) },
  onAParty(e) { this.setData({ a_party: e.detail.value }) },
  onAAmount(e) { this.setData({ a_amount: e.detail.value }) },
  onARemark(e) { this.setData({ a_remark: e.detail.value }) },
  addAdvance() {
    const { adv_type, a_party, a_amount, a_remark } = this.data
    if (!a_party || !(Number(a_amount) > 0)) return wx.showToast({ title: '名称和金额必填', icon: 'none' })
    this.req({
      url: API_BASE + '/advances', method: 'POST',
      data: { type: adv_type, party: a_party, amount: Number(a_amount), remark: a_remark, account_id: this.data.acc_id },
      success: () => { this.setData({ a_party: '', a_amount: '', a_remark: '' }); this.refresh() }
    })
  },
  addAdvancePre() {
    this.setData({ adv_type: 1 })
    const { a_party, a_amount, a_remark } = this.data
    if (!a_party || !(Number(a_amount) > 0)) return wx.showToast({ title: '名称和金额必填', icon: 'none' })
    this.req({
      url: API_BASE + '/advances', method: 'POST',
      data: { type: 'out', party: a_party, amount: Number(a_amount), remark: a_remark, account_id: this.data.acc_id },
      success: () => { this.setData({ a_party: '', a_amount: '', a_remark: '' }); this.refresh() }
    })
  },
  delAdvance(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除预收款/预付款', content: '确定删除吗？（已抵扣过的不能删）',
      success: (r) => {
        if (!r.confirm) return
        this.req({ url: API_BASE + '/advances/' + id, method: 'DELETE', success: () => this.refresh() })
      }
    })
  },
  applyAdvanceOrder(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '用预收款抵扣', content: '把这客户手上的预收款抵到这张单上（不动现金，只冲往来）',
      success: (r) => {
        if (!r.confirm) return
        this.req({ url: API_BASE + '/orders/' + id + '/apply-advance', method: 'POST', data: {}, success: () => this.refresh() })
      }
    })
  },
  applyAdvancePayable(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '用预付款抵扣', content: '把预付给供应商的钱抵到这笔应付上（不动现金）',
      success: (r) => {
        if (!r.confirm) return
        this.req({ url: API_BASE + '/payables/' + id + '/apply-advance', method: 'POST', data: {}, success: () => this.refresh() })
      }
    })
  },
  // ── 员工借支 / 报销 ──
  loadLoans() {
    this.req({ url: API_BASE + '/loans', success: (res) => {
      if (res.data && !res.data.error) {
        this.setData({
          loans: res.data.list || [],
          loan_staff: res.data.staff || [],
          loan_open: res.data.open_total || 0
        })
      }
    }})
  },
  onLStaff(e) { this.setData({ l_staff: e.detail.value }) },
  onLAmount(e) { this.setData({ l_amount: e.detail.value }) },
  onLRemark(e) { this.setData({ l_remark: e.detail.value }) },
  addLoan() {
    const staff = (this.data.l_staff || '').trim()
    const amount = Number(this.data.l_amount) || 0
    if (!staff) return wx.showToast({ title: '填员工姓名', icon: 'none' })
    if (amount <= 0) return wx.showToast({ title: '填借出金额', icon: 'none' })
    this.req({
      url: API_BASE + '/loans', method: 'POST',
      data: { staff, amount, remark: this.data.l_remark || '', account_id: this.data.acc_id || 0 },
      success: (res) => {
        if (res.data && res.data.ok) {
          this.setData({ l_staff: '', l_amount: '', l_remark: '' })
          this.loadLoans(); this.refresh()
          wx.showToast({ title: '已借出 ' + amount, icon: 'none' })
        } else {
          wx.showToast({ title: (res.data && res.data.error) || '失败', icon: 'none' })
        }
      }
    })
  },
  startReimburse(e) {
    const id = Number(e.currentTarget.dataset.id)
    const name = e.currentTarget.dataset.name || ''
    const remain = Number(e.currentTarget.dataset.remain) || 0
    this.setData({ cur_loan: id, cur_loan_name: name, rl_amount: String(remain), rl_category: this.data.e_category || 0, rl_remark: '' })
  },
  cancelReimburse() { this.setData({ cur_loan: 0, cur_loan_name: '', rl_amount: '', rl_remark: '' }) },
  onRlAmount(e) { this.setData({ rl_amount: e.detail.value }) },
  onRlCategory(e) { this.setData({ rl_category: Number(e.detail.value) }) },
  onRlRemark(e) { this.setData({ rl_remark: e.detail.value }) },
  doReimburse() {
    const id = this.data.cur_loan
    if (!id) return
    const amount = Number(this.data.rl_amount) || 0
    const category = (this.data.categories || [])[this.data.rl_category] || '其他'
    this.req({
      url: API_BASE + '/loans/' + id + '/reimburse', method: 'POST',
      data: { amount, category, remark: this.data.rl_remark || '' },
      success: (res) => {
        if (res.data && res.data.ok) {
          this.setData({ cur_loan: 0, cur_loan_name: '', rl_amount: '', rl_remark: '' })
          this.loadLoans(); this.refresh()
          wx.showToast({ title: '报销 ¥' + res.data.amount, icon: 'none' })
        } else {
          wx.showToast({ title: (res.data && res.data.error) || '失败', icon: 'none' })
        }
      }
    })
  },
  returnLoan(e) {
    const id = e.currentTarget.dataset.id
    const remain = Number(e.currentTarget.dataset.remain) || 0
    wx.showModal({
      title: '退回余款', content: '员工把没花完的钱交回来，默认退 ¥' + remain,
      editable: true, placeholderText: String(remain),
      success: (r) => {
        if (!r.confirm) return
        const a = Number((r.content || '').trim() || remain) || remain
        this.req({
          url: API_BASE + '/loans/' + id + '/return', method: 'POST',
          data: { amount: a, account_id: this.data.acc_id || 0 },
          success: () => { this.loadLoans(); this.refresh(); wx.showToast({ title: '已退回 ' + a, icon: 'none' }) }
        })
      }
    })
  },
  delLoan(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删借支', content: '删掉这笔借支记录（钱也一起撤销）', confirmColor: '#e64340',
      success: (r) => {
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/loans/' + id, method: 'DELETE',
          success: (res) => {
            if (res.data && res.data.ok) { this.loadLoans(); this.refresh() }
            else wx.showToast({ title: (res.data && res.data.error) || '不能删', icon: 'none' })
          }
        })
      }
    })
  },
  // 导出导入模板（CSV，微信发到电脑用 Excel 填）
  exportTemplate() {
    const types = ['ar', 'ap', 'expense', 'loan', 'reimb', 'ar_init', 'ap_init']
    const t = types[this.data.import_type] || 'ar'
    const url = API_BASE + '/import-template?type=' + t
    wx.showLoading({ title: '生成模板…' })
    wx.downloadFile({
      url,
      header: { 'X-Access-Key': wx.getStorageSync('ak') || '', 'X-Book': String(wx.getStorageSync('book') || 1) },
      success: (r) => {
        wx.hideLoading()
        if (r.statusCode !== 200) return wx.showToast({ title: '生成失败', icon: 'none' })
        const dst = wx.env.USER_DATA_PATH + '/导入模板_' + t + '.csv'
        try {
          wx.getFileSystemManager().copyFileSync(r.tempFilePath, dst)
        } catch (err) { return wx.showToast({ title: '保存失败', icon: 'none' }) }
        if (wx.shareFileMessage) {
          wx.shareFileMessage({ filePath: dst, fileName: '导入模板_' + t + '.csv', fail: () => wx.showToast({ title: '已存到手机，可转发文件传输助手', icon: 'none' }) })
        } else {
          wx.showToast({ title: '已保存到手机', icon: 'none' })
        }
      },
      fail: () => { wx.hideLoading(); wx.showToast({ title: '下载失败', icon: 'none' }) }
    })
  },
  // 下载 Excel（.xlsx）模板：真 Excel 文件，WPS/Excel 直接打开填
  excelTemplate() {
    const types = ['ar', 'ap', 'expense', 'loan', 'reimb', 'ar_init', 'ap_init']
    const t = types[this.data.import_type] || 'ar'
    wx.showLoading({ title: '生成中…' })
    this.req({
      url: API_BASE + '/import-template-xlsx?type=' + t,
      success: (res) => {
        wx.hideLoading()
        const d = res.data || {}
        if (!d.b64) return wx.showToast({ title: '生成失败', icon: 'none' })
        const dst = wx.env.USER_DATA_PATH + '/' + (d.name || '导入模板.xlsx')
        wx.getFileSystemManager().writeFile({
          filePath: dst, data: d.b64, encoding: 'base64',
          success: () => {
            wx.showToast({ title: '模板已生成', icon: 'success' })
            if (wx.shareFileMessage) {
              wx.shareFileMessage({
                filePath: dst, fileName: d.name || '导入模板.xlsx',
                fail: () => {
                  wx.openDocument({
                    filePath: dst, showMenu: true,
                    fail: () => wx.showToast({ title: '可先转发到文件传输助手', icon: 'none' })
                  })
                }
              })
            } else {
              wx.openDocument({ filePath: dst, showMenu: true, fail: () => {} })
            }
          },
          fail: () => wx.showToast({ title: '保存失败', icon: 'none' })
        })
      }
    })
  },
  // 直接选 .xlsx 文件导入（不用管编码，Excel 存什么都能读）
  chooseXlsxFile() {
    const types = ['ar', 'ap', 'expense', 'loan', 'reimb', 'ar_init', 'ap_init']
    const t = types[this.data.import_type] || 'ar'
    if (!wx.chooseMessageFile) return wx.showToast({ title: '微信版本过低，请用粘贴方式', icon: 'none' })
    wx.chooseMessageFile({
      count: 1, type: 'file', extension: ['xlsx', 'XLSX'],
      success: (r) => {
        const f = (r.tempFiles || [])[0]
        if (!f) return
        if (f.size > 3 * 1024 * 1024) return wx.showToast({ title: '文件太大（3MB 以内）', icon: 'none' })
        wx.showLoading({ title: '读取中…' })
        wx.getFileSystemManager().readFile({
          filePath: f.path, encoding: 'base64',
          success: (fr) => {
            wx.showLoading({ title: '导入中…' })
            this.req({
              url: API_BASE + '/import-xlsx', method: 'POST',
              data: { type: t, b64: fr.data },
              success: (res) => {
                wx.hideLoading()
                const d = res.data || {}
                this.setData({ import_file_name: f.name || 'Excel 文件' })
                wx.showModal({
                  title: '导入完成',
                  content: '成功导入 ' + (d.imported || 0) + ' 条' + (d.skipped_locked ? '，跳过已结账月份 ' + d.skipped_locked + ' 条' : '') + '。金额和客户名请在列表里抽两条核对。',
                  showCancel: false,
                  success: () => this.refresh()
                })
              },
              fail: () => wx.hideLoading()
            })
          },
          fail: () => { wx.hideLoading(); wx.showToast({ title: '读不到这个文件', icon: 'none' }) }
        })
      }
    })
  },
  onEAcc(e) {
    const i = Number(e.detail.value)
    const a = this.data.accounts[i] || {}
    this.setData({ e_acc: i, acc_idx: i, acc_id: a.id || 0 })
  },
  setDefaultAcc(e) {
    const i = Number(e.currentTarget.dataset.i)
    const a = this.data.accounts[i] || {}
    wx.setStorageSync('acc', a.id || 0)
    this.setData({ acc_idx: i, acc_id: a.id || 0, acc_name: a.name || '' })
    wx.showToast({ title: '默认用 ' + (a.name || ''), icon: 'none' })
  },
  onNewAccName(e) { this.setData({ new_acc_name: e.detail.value }) },
  onNewAccOpening(e) { this.setData({ new_acc_opening: e.detail.value }) },
  addAccount() {
    const nm = (this.data.new_acc_name || '').trim()
    if (!nm) return wx.showToast({ title: '填账户名', icon: 'none' })
    this.req({
      url: API_BASE + '/accounts', method: 'POST',
      data: { name: nm, opening: Number(this.data.new_acc_opening) || 0 },
      success: () => { this.setData({ new_acc_name: '', new_acc_opening: '' }); this.refresh() }
    })
  },
  editOpening(e) {
    const id = e.currentTarget.dataset.id
    const a = this.data.accounts.find((x) => x.id === id) || {}
    wx.showModal({
      title: '改期初余额', editable: true,
      content: String(a.opening || 0),
      placeholderText: '这个账户开始记账时有多少钱',
      success: (r) => {
        if (r.confirm && r.content !== '') {
          this.req({ url: API_BASE + '/accounts/' + id, method: 'PATCH', data: { opening: Number(r.content) || 0 }, success: () => this.refresh() })
        }
      }
    })
  },
  renameAccount(e) {
    const id = e.currentTarget.dataset.id
    const a = this.data.accounts.find((x) => x.id === id) || {}
    wx.showModal({
      title: '给账户改名', editable: true, content: a.name || '',
      success: (r) => {
        if (r.confirm && r.content) {
          this.req({ url: API_BASE + '/accounts/' + id, method: 'PATCH', data: { name: r.content.trim() }, success: () => this.refresh() })
        }
      }
    })
  },
  delAccount(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除账户', content: '有流水的账户不能删（可以改名）',
      success: (r) => {
        if (!r.confirm) return
        this.req({ url: API_BASE + '/accounts/' + id, method: 'DELETE', success: () => this.refresh() })
      }
    })
  },
  onNewCatType(e) { this.setData({ new_cat_type: Number(e.detail.value) }) },
  onNewCatName(e) { this.setData({ new_cat_name: e.detail.value }) },
  addCategory() {
    const nm = (this.data.new_cat_name || '').trim()
    if (!nm) return wx.showToast({ title: '填分类名', icon: 'none' })
    this.req({
      url: API_BASE + '/categories', method: 'POST',
      data: { type: this.data.new_cat_type ? 'in' : 'out', name: nm },
      success: () => { this.setData({ new_cat_name: '' }); this.loadCategories() }
    })
  },
  delCategory(e) {
    const id = e.currentTarget.dataset.id
    this.req({ url: API_BASE + '/categories/' + id, method: 'DELETE', success: () => this.loadCategories() })
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
            month_amort: res.data.month_amort || 0, month_accrue_int: res.data.month_accrue_int || 0, month_dep: res.data.month_dep || 0,
            month_expense_cash: res.data.month_expense_cash || 0,
            overdue_count: res.data.overdue_count, overdue: res.data.overdue || [],
            due_soon_count: res.data.due_soon_count, due_soon: res.data.due_soon || [],
            pay_soon_count: res.data.pay_soon_count || 0, pay_soon: res.data.pay_soon || [],
            due_brief: [
              res.data.overdue_count ? '逾期 ' + res.data.overdue_count + ' 单' : '',
              res.data.due_soon_count ? '7天内到期 ' + res.data.due_soon_count + ' 单' : '',
              res.data.pay_soon_count ? '要付 ' + res.data.pay_soon_count + ' 笔' : ''
            ].filter((x) => x).join(' · '),
            today_income: res.data.today_income || 0,
            top_customer: res.data.top_customer || '', top_unpaid: res.data.top_unpaid || 0,
            budget_over: res.data.budget_over || [], budget_alert_count: res.data.budget_alert_count || 0,
            cash_balance: res.data.cash_balance || 0,
            role: res.data.role || 'owner',
            issue_count: res.data.issue_count || 0, issue_at: res.data.issue_at || ''
          })
        }
      }
    })
  },
  PAGE: 60,
  // more=true 表示上拉加载下一页
  loadArSummary() {
    this.req({ url: API_BASE + '/ar-summary?type=ar', success: (res) => this.setData({ ar_sum: res.data || {} }) })
    this.req({ url: API_BASE + '/ar-summary?type=ap', success: (res) => this.setData({ ap_sum: res.data || {} }) })
  },
  pickArFilter(e) { this.setData({ ar_filter: e.currentTarget.dataset.k }); this.loadAr(); this.loadGroups('ar') },
  pickArSort(e) { this.setData({ ar_sort: e.currentTarget.dataset.k }); this.loadAr() },
  pickApFilter(e) { this.setData({ ap_filter: e.currentTarget.dataset.k }); this.loadAp(); this.loadGroups('ap') },
  pickApSort(e) { this.setData({ ap_sort: e.currentTarget.dataset.k }); this.loadAp() },
  loadGroups(t) {
    const st = t === 'ar' ? this.data.ar_filter : this.data.ap_filter
    const kw = t === 'ar' ? this.data.ar_kw : this.data.ap_kw
    this.req({
      url: API_BASE + '/party-groups?type=' + t + '&status=' + st + '&kw=' + encodeURIComponent(kw || ''),
      success: (res) => {
        const d = res.data || {}
        const key = t === 'ar' ? 'ar_groups' : 'ap_groups'
        const patch = {}
        patch[key] = d.groups || []
        this.setData(patch)
      }
    })
  },
  pickArView(e) {
    const v = e.currentTarget.dataset.v
    this.setData({ ar_view: v, ar_open: '' })
    if (v === 'party') this.loadGroups('ar')
  },
  pickApView(e) {
    const v = e.currentTarget.dataset.v
    this.setData({ ap_view: v, ap_open: '' })
    if (v === 'party') this.loadGroups('ap')
  },
  toggleGroupAr(e) {
    const n = e.currentTarget.dataset.n
    this.setData({ ar_open: this.data.ar_open === n ? '' : n })
  },
  toggleGroupAp(e) {
    const n = e.currentTarget.dataset.n
    this.setData({ ap_open: this.data.ap_open === n ? '' : n })
  },
  // 整户批量收款（预填客户与未收合计，走先老后新核销）
  groupReceive(e) {
    const ds = e.currentTarget.dataset
    this.setData({ rb_customer: ds.n, rb_amount: String(ds.amt), rb_date: '' })
    this.receiveBatch()
  },
  groupPay(e) {
    const ds = e.currentTarget.dataset
    this.setData({ rb_customer: ds.n, rb_amount: String(ds.amt), rb_date: '' })
    wx.showModal({
      title: '整户付款',
      content: '付给 ' + ds.n + ' ¥' + ds.amt + '，按「先老后新」抵掉未结应付，确定吗？',
      success: (r) => {
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/pay-batch', method: 'POST',
          data: { supplier: ds.n, amount: Number(ds.amt), account_id: this.data.acc_id },
          success: (res) => {
            const d = res.data || {}
            if (d.ok) {
              wx.showModal({ title: '付款成功', content: '共冲 ¥' + d.total + '，' + (d.used || []).length + ' 笔' + (d.rest > 0 ? '\n还剩 ¥' + d.rest + ' 没抵完' : ''), showCancel: false })
              this.refresh()
            } else wx.showToast({ title: d.error || '失败', icon: 'none' })
          }
        })
      }
    })
  },
  loadAr(more) {
    const off = more ? this.data.ar_off : 0
    const q = '&status=' + this.data.ar_filter + '&sort=' + this.data.ar_sort
    this.req({ url: API_BASE + '/ar?offset=' + off + '&limit=' + this.PAGE + q, success: (res) => {
      const page = res.data || []
      const all = more ? this.data.ar_all.concat(page) : page
      this.setData({ ar_all: all, ar_off: all.length, ar_more: page.length >= this.PAGE, ar_list: this.filterAr(all, this.data.ar_kw) })
    } })
  },
  loadAp(more) {
    const off = more ? this.data.ap_off : 0
    const q = '&status=' + this.data.ap_filter + '&sort=' + this.data.ap_sort
    this.req({ url: API_BASE + '/ap?offset=' + off + '&limit=' + this.PAGE + q, success: (res) => {
      const page = res.data || []
      const all = more ? this.data.ap_all.concat(page) : page
      this.setData({ ap_all: all, ap_off: all.length, ap_more: page.length >= this.PAGE, ap_list: this.filterAp(all, this.data.ap_kw) })
    } })
  },
  loadExpenses(more) {
    const off = more ? this.data.ex_off : 0
    this.req({ url: API_BASE + '/expenses?offset=' + off + '&limit=' + this.PAGE, success: (res) => {
      const page = res.data || []
      const all = more ? this.data.exp_all.concat(page) : page
      this.setData({ exp_all: all, ex_off: all.length, ex_more: page.length >= this.PAGE, expense_list: this.filterEx(all, this.data.ex_kw) })
    } })
  },
  // 上拉到底自动加载更多
  onReachBottom() {
    const t = this.data.tab
    if (t === 'ar' && this.data.ar_more) this.loadAr(true)
    else if (t === 'ap' && this.data.ap_more) this.loadAp(true)
    else if (t === 'expense' && this.data.ex_more) this.loadExpenses(true)
  },
  loadMoreTap() {
    const t = this.data.tab
    if (t === 'ar') this.loadAr(true)
    else if (t === 'ap') this.loadAp(true)
    else if (t === 'expense') this.loadExpenses(true)
  },
  filterAr(list, kw) { kw = (kw || '').trim(); return kw ? list.filter((x) => (x.customer + ' ' + (x.item_name || '')).indexOf(kw) >= 0) : list },
  filterAp(list, kw) { kw = (kw || '').trim(); return kw ? list.filter((x) => (x.supplier + ' ' + (x.remark || '')).indexOf(kw) >= 0) : list },
  filterEx(list, kw) { kw = (kw || '').trim(); return kw ? list.filter((x) => ((x.category || '') + ' ' + (x.remark || '')).indexOf(kw) >= 0) : list },
  onArKw(e) { this.setData({ ar_kw: e.detail.value, ar_list: this.filterAr(this.data.ar_all, e.detail.value) }); this.loadGroups('ar') },
  onApKw(e) { this.setData({ ap_kw: e.detail.value, ap_list: this.filterAp(this.data.ap_all, e.detail.value) }); this.loadGroups('ap') },
  onExKw(e) { this.setData({ ex_kw: e.detail.value, expense_list: this.filterEx(this.data.exp_all, e.detail.value) }) },
  setGroup(e) {
    const g = e.currentTarget.dataset.g
    const keep = { bill: ['ar', 'ap', 'expense', 'import'], stat: ['report', 'asset', 'history'], me: ['contact'], home: ['home'] }
    const t = (keep[g] || ['home']).indexOf(this.data.tab) >= 0 ? this.data.tab : (keep[g] || ['home'])[0]
    this.setData({ group: g, tab: t })
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
    if (t === 'report') { this.loadFixed(); this.loadMonthLocks(); this.loadProfitCompare() }
    if (t === 'asset') { this.loadAsset(); this.loadInvoices(); this.loadAssets(); this.loadBankFlows(); this.loadWriteoffs(); this.loadTransfers() }
    if (t === 'contact') { this.loadAccounts(); this.loadTransfers() }
    if (t === 'expense') this.loadLoans()
    if (t === 'ar' || t === 'ap' || t === 'expense') this.loadSuggest()
  },
  // 工作台待办点击跳转（reminders 里的 tab: ar/ap/expense/nw/home）
  jumpTodo() {
    if (this.data.overdue_count > 0 || this.data.due_soon_count > 0) this.setData({ tab: 'ar' })
    else if (this.data.pay_soon_count > 0) this.setData({ tab: 'ap' })
  },
  goRem(e) {
    const t0 = e.currentTarget.dataset.tab
    const t = ({ nw: 'asset', home: 'report' })[t0] || t0 || 'home'
    const g = ({ ar: 'bill', ap: 'bill', expense: 'bill', import: 'bill', report: 'stat', asset: 'stat', history: 'stat', contact: 'me' })[t] || 'home'
    this.setData({ tab: t, group: g })
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
    if (t === 'ar') this.setData({ ar_filter: 'overdue' })
    if (t === 'ap') this.setData({ ap_filter: 'overdue' })
    if (t === 'ar') this.loadAr()
    if (t === 'ap') this.loadAp()
    if (t === 'asset') { this.loadAsset(); this.loadInvoices(); this.loadAssets(); this.loadBankFlows(); this.loadWriteoffs(); this.loadTransfers() }
    if (t === 'report') { this.loadFixed(); this.loadMonthLocks(); this.loadProfitCompare() }
    if (t === 'expense') this.loadLoans()
  },
  setTab(e) {
    const t = e.currentTarget.dataset.t
    const g = ({ ar: 'bill', ap: 'bill', expense: 'bill', import: 'bill', report: 'stat', asset: 'stat', history: 'stat', contact: 'me', home: 'home' })[t] || 'home'
    this.setData({ tab: t, group: g })
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
    if (t === 'report') { this.loadFixed(); this.loadMonthLocks(); this.loadProfitCompare() }
    if (t === 'asset') { this.loadAsset(); this.loadInvoices(); this.loadAssets(); this.loadBankFlows(); this.loadWriteoffs(); this.loadTransfers() }
    if (t === 'contact') { this.loadAccounts(); this.loadTransfers() }
    if (t === 'expense') this.loadLoans()
  },
  onOCustomer(e) { this.setData({ o_customer: e.detail.value }) },
  // 客户填完，自动带出上次给他记的产品和单价（省得重复打）
  blurOCustomer() {
    const n = (this.data.o_customer || '').trim()
    if (!n) return
    this.applyLastDeal('ar', n)
  },
  blurPSupplier() {
    const n = (this.data.p_supplier || '').trim()
    if (!n) return
    this.applyLastDeal('ap', n)
  },
  applyLastDeal(type, party) {
    this.req({
      url: API_BASE + '/last-deal?type=' + type + '&party=' + encodeURIComponent(party),
      success: (r) => {
        const d = r.data || {}
        if (!d.found) return this.setData({ last_tip: '' })
        if (type === 'ar') {
          const up = {}
          if (!this.data.o_item && d.item) up.o_item = d.item
          if (!this.data.o_price && d.amount) up.o_price = String(d.amount)
          if (!this.data.o_operator && d.operator) up.o_operator = d.operator
          up.last_tip = '上次给' + party + '记的是 ' + (d.item || '加工') + ' ¥' + d.amount + (d.last_date ? '（' + d.last_date + '）' : '')
          this.setData(up)
        } else {
          const up = {}
          if (!this.data.p_remark && d.item) up.p_remark = d.item
          if (!this.data.p_amount && d.amount) up.p_amount = String(d.amount)
          if (!this.data.p_operator && d.operator) up.p_operator = d.operator
          up.last_tip = '上次跟' + party + '记的是 ' + (d.item || '货款') + ' ¥' + d.amount
          this.setData(up)
        }
      }
    })
  },
  loadSuggest() {
    ['ar', 'ap', 'expense'].forEach((t) => {
      this.req({
        url: API_BASE + '/suggest?type=' + t,
        success: (r) => {
          const list = (r.data || []).slice(0, 6)
          if (t === 'ar') this.setData({ sug_ar: list })
          else if (t === 'ap') this.setData({ sug_ap: list })
          else this.setData({ sug_ex: list })
        }
      })
    })
  },
  // 点常用组合，一键填好整张单
  fillSug(e) {
    const t = e.currentTarget.dataset.t
    const i = Number(e.currentTarget.dataset.i)
    const arr = t === 'ar' ? this.data.sug_ar : t === 'ap' ? this.data.sug_ap : this.data.sug_ex
    const it = arr[i]
    if (!it) return
    if (t === 'ar') this.setData({ o_customer: it.party, o_item: it.item || '', o_price: String(it.amount || '') })
    else if (t === 'ap') this.setData({ p_supplier: it.party, p_remark: it.item || '', p_amount: String(it.amount || '') })
    else {
      const idx = Math.max(0, this.data.categories.indexOf(it.party))
      this.setData({ e_category: idx, e_amount: String(it.amount || ''), e_remark: it.item || '' })
    }
    wx.showToast({ title: '已填好，核对金额即可', icon: 'none' })
  },
  // 常用面额一键填金额
  fillAmt(e) {
    const { f, v } = e.currentTarget.dataset
    const cur = String(this.data[f] || '')
    const nv = cur && Number(cur) ? String(Number(cur) + Number(v)) : String(v)
    this.setData({ [f]: nv })
  },
  // 再来一单：把上次同样的客户/产品/单价带出来
  againOrder(e) {
    const id = e.currentTarget.dataset.id
    const it = (this.data.ar_all || []).find((x) => String(x.id) === String(id)) || {}
    this.req({
      url: API_BASE + '/last-deal?type=ar&party=' + encodeURIComponent(it.customer || ''),
      success: (r) => {
        const d = r.data || {}
        this.setData({
          o_customer: it.customer || '', o_item: d.item || it.item_name || '',
          o_price: String(d.amount || it.price || ''), o_operator: d.operator || it.operator || '', o_due: '', o_date: '', last_tip: '已带出上次的单价，改数量/金额即可'
        })
        wx.pageScrollTo({ scrollTop: 0, duration: 200 })
        wx.showToast({ title: '填好了，核对后记一笔', icon: 'none' })
      }
    })
  },
  againPayable(e) {
    const id = e.currentTarget.dataset.id
    const it = (this.data.ap_all || []).find((x) => String(x.id) === String(id)) || {}
    this.req({
      url: API_BASE + '/last-deal?type=ap&party=' + encodeURIComponent(it.supplier || ''),
      success: (r) => {
        const d = r.data || {}
        this.setData({
          p_supplier: it.supplier || '', p_amount: String(d.amount || it.amount || ''),
          p_remark: d.item || it.remark || '', p_operator: d.operator || it.operator || '', p_due: '', p_date: ''
        })
        wx.pageScrollTo({ scrollTop: 0, duration: 200 })
        wx.showToast({ title: '填好了，核对后记一笔', icon: 'none' })
      }
    })
  },
  onOItem(e) { this.setData({ o_item: e.detail.value }) },
  onOPrice(e) { this.setData({ o_price: e.detail.value }) },
  onODue(e) { this.setData({ o_due: e.detail.value }) },
  onOOperator(e) { this.setData({ o_operator: e.detail.value }) },
  pickCustomer(e) { const n = e.currentTarget.dataset.n; this.setData({ o_customer: n }); this.applyLastDeal('ar', n) },
  onPSupplier(e) { this.setData({ p_supplier: e.detail.value }) },
  onPAmount(e) { this.setData({ p_amount: e.detail.value }) },
  onPRemark(e) { this.setData({ p_remark: e.detail.value }) },
  onPDue(e) { this.setData({ p_due: e.detail.value }) },
  onPOperator(e) { this.setData({ p_operator: e.detail.value }) },
  pickSupplier(e) { const n = e.currentTarget.dataset.n; this.setData({ p_supplier: n }); this.applyLastDeal('ap', n) },
  onECategory(e) { this.setData({ e_category: Number(e.detail.value) }) },
  onEAmount(e) { this.setData({ e_amount: e.detail.value }) },
  onERemark(e) { this.setData({ e_remark: e.detail.value }) },
  onEOperator(e) { this.setData({ e_operator: e.detail.value }) },
  // 补录日期：picker 选日期，可清除（清除=默认今天）
  onDatePick(e) { this.setData({ [e.currentTarget.dataset.f]: e.detail.value }) },
  clearDate(e) { this.setData({ [e.currentTarget.dataset.f]: '' }) },
  onImportType(e) { this.setData({ import_type: Number(e.detail.value) }) },
  onImportText(e) { this.setData({ import_text: e.detail.value }) },
  addOrder() {
    const { o_customer, o_item, o_price, o_due, o_operator, o_date } = this.data
    if (!o_customer || !o_price) return wx.showToast({ title: '客户和金额必填', icon: 'none' })
    this.req({
      url: API_BASE + '/orders', method: 'POST',
      data: { customer: o_customer, item_name: o_item, price: Number(o_price), due_date: o_due, operator: o_operator, date: o_date },
      success: (res) => {
        this.setData({ o_customer: '', o_item: '', o_price: '', o_due: '', o_date: '', last_tip: '' })
        this.refresh(); this.loadSuggest()
        const w = res.data && res.data.warn
        if (w) {
          wx.showModal({
            title: '超过信用额度了', content: `${w.party}\n已欠 ¥${w.unpaid}\n额度 ¥${w.limit_amount}\n超出 ¥${w.over}\n\n这单已记上，记得早点催款。`,
            showCancel: false, confirmText: '知道了'
          })
        }
      }
    })
  },
  addPayable() {
    const { p_supplier, p_amount, p_remark, p_operator, p_due, p_date } = this.data
    if (!p_supplier || !p_amount) return wx.showToast({ title: '供应商和金额必填', icon: 'none' })
    this.req({
      url: API_BASE + '/payables', method: 'POST',
      data: { supplier: p_supplier, amount: Number(p_amount), remark: p_remark, operator: p_operator, due_date: p_due, date: p_date }, dupRetry: true,
      success: () => { this.setData({ p_supplier: '', p_amount: '', p_remark: '', p_operator: '', p_due: '', p_date: '', last_tip: '' }); this.refresh(); this.loadSuggest() }
    })
  },
  addExpense() {
    const { e_amount, e_remark, categories, e_category, e_operator, e_date } = this.data
    if (!e_amount) return wx.showToast({ title: '金额必填', icon: 'none' })
    this.req({
      url: API_BASE + '/expenses', method: 'POST', dupRetry: true,
      data: { amount: Number(e_amount), category: categories[e_category], remark: e_remark, operator: e_operator, account_id: this.data.acc_id, date: e_date },
      success: () => { wx.setStorageSync('last_cat', e_category); this.setData({ e_amount: '', e_remark: '', e_operator: '', e_date: '' }); this.refresh(); this.loadSuggest() }
    })
  },
  // 找某一单还剩多少没结（先从当前列表里查）
  _remainOf(list, id) {
    const it = (list || []).find((x) => String(x.id) === String(id)) || {}
    return Math.max(0, Math.round(Number(it.unpaid || 0) * 100) / 100)
  },
  payOrder(e) {
    const id = e.currentTarget.dataset.id
    const remain = this._remainOf(this.data.ar_all, id)
    wx.showModal({
      title: '收客户款' + (remain > 0 ? '（还剩 ' + remain + ' 元）' : ''),
      editable: true,
      placeholderText: remain > 0 ? '不填=一次收清 ' + remain + '；也可填 金额,日期(5000,07-05)' : '填金额，可带日期(5000,07-05)',
      success: (r) => {
        if (!r.confirm) return
        const txt = String(r.content || '').trim()
        const parts = txt ? txt.split(/[,，\s]+/) : []
        const amt = parts[0] ? Number(parts[0]) : remain
        if (!(amt > 0)) return wx.showToast({ title: '金额不对', icon: 'none' })
        if (remain > 0 && amt > remain + 0.005) {
          return wx.showToast({ title: '比未收的还多（还剩 ' + remain + '）', icon: 'none' })
        }
        this.req({
          url: API_BASE + '/orders/' + id + '/receive', method: 'POST',
          data: { amount: amt, date: parts[1] || '', account_id: this.data.acc_id },
          success: () => {
            this.refresh()
            const noLeft = remain > 0 && Math.round((remain - amt) * 100) / 100 <= 0.005
            this._afterPay(id, amt, remain, 'ar', noLeft)
          }
        })
      }
    })
  },
  // 收/付完自动核对：还有余额就顺手问一句“要不要一起结清”
  _afterPay(id, amt, remain, kind, settled) {
    const left = Math.round((remain - amt) * 100) / 100
    if (settled === true || (remain > 0 && left <= 0.005)) {
      wx.showToast({ title: kind === 'ar' ? '这单已收清' : '这笔已付清', icon: 'success' })
      return this._offerReceipt(id, kind)
    }
    if (left <= 0.005) return this._offerReceipt(id, kind)
    wx.showModal({
      title: '还差 ' + left + ' 元',
      content: (kind === 'ar' ? '这张单还没收完' : '这笔还没付完') + '，剩下的一次结清吗？',
      confirmText: '一次结清', cancelText: '先这样',
      success: (rr) => {
        if (!rr.confirm) return
        this.req({
          url: API_BASE + (kind === 'ar' ? '/orders/' : '/payables/') + id + (kind === 'ar' ? '/receive' : '/pay'),
          method: 'POST',
          data: { amount: left, account_id: this.data.acc_id },
          success: () => { this.refresh(); wx.showToast({ title: kind === 'ar' ? '已收清' : '已付清', icon: 'success' }); this._offerReceipt(id, kind) }
        })
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
          data: { customer, amount, date: this.data.rb_date, account_id: this.data.acc_id },
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
  payPayable(e) {
    const id = e.currentTarget.dataset.id
    const remain = this._remainOf(this.data.ap_all, id)
    wx.showModal({
      title: '付供应商款' + (remain > 0 ? '（还剩 ' + remain + ' 元）' : ''),
      editable: true,
      placeholderText: remain > 0 ? '不填=一次付清 ' + remain + '；也可填 金额,日期(5000,07-05)' : '填金额，可带日期(5000,07-05)',
      success: (r) => {
        if (!r.confirm) return
        const txt = String(r.content || '').trim()
        const parts = txt ? txt.split(/[,，\s]+/) : []
        const amt = parts[0] ? Number(parts[0]) : remain
        if (!(amt > 0)) return wx.showToast({ title: '金额不对', icon: 'none' })
        if (remain > 0 && amt > remain + 0.005) {
          return wx.showToast({ title: '比未付的还多（还剩 ' + remain + '）', icon: 'none' })
        }
        this.req({
          url: API_BASE + '/payables/' + id + '/pay', method: 'POST',
          data: { amount: amt, date: parts[1] || '', account_id: this.data.acc_id },
          success: () => {
            this.refresh()
            this._afterPay(id, amt, remain, 'ap')
          }
        })
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
            data: { customer: p[0], item_name: p[1], price: Number(p[2]), rev: it.rev },
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
            data: { supplier: p[0], amount: Number(p[1]), remark: p[2] || '', rev: it.rev },
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
      placeholderText: '月份，如 ' + ym + '（留空=本月）',
      success: (r) => {
        if (!r.confirm) return
        const m = (r.content || '').trim() || ym
        wx.showLoading({ title: '生成中…' })
        this.req({
          url: API_BASE + '/statement-month',
          data: { type, name, month: m },
          success: (res) => {
            wx.hideLoading()
            const d2 = res.data || {}
            if (!d2.text) return wx.showToast({ title: d2.error || '生成失败', icon: 'none' })
            this.statementActions(d2)
          },
          fail: () => wx.hideLoading()
        })
      }
    })
  },
  // 对账单：选“存图片/直接发对方/复制文字”
  statementActions(d) {
    wx.showActionSheet({
      itemList: ['存成图片（可保存/转发）', '直接发给对方', '复制文字'],
      success: (r) => {
        if (r.tapIndex === 2) {
          wx.setClipboardData({ data: d.text, success: () => wx.showToast({ title: '已复制', icon: 'none' }) })
          return
        }
        this.drawStatementImage(d, r.tapIndex === 1)
      }
    })
  },
  // 收/付款收据：问一句要不要生成图片发给对方
  _offerReceipt(id, kind) {
    wx.showModal({
      title: kind === 'ar' ? '要发收款收据吗？' : '要发付款收据吗？',
      content: '生成一张图片发给对方：这次收/付了多少、还差多少，一目了然。',
      confirmText: '生成', cancelText: '不用',
      success: (r) => { if (r.confirm) this.makeReceipt(id, kind, true) }
    })
  },
  // 点按钮手动开收据（列表里的「收据」）
  openReceipt(e) {
    const { id, type } = e.currentTarget.dataset
    this.makeReceipt(id, type === 'ap' ? 'ap' : 'ar', true)
  },
  makeReceipt(id, kind, share) {
    wx.showLoading({ title: '生成中…' })
    this.req({
      url: API_BASE + '/receipt-text?type=' + (kind === 'ap' ? 'ap' : 'ar') + '&id=' + id,
      success: (res) => {
        wx.hideLoading()
        const d = res.data || {}
        if (!d.text) return wx.showToast({ title: d.error || '生成失败', icon: 'none' })
        this.drawStatementImage({ text: d.text }, share === true)
      },
      fail: () => wx.hideLoading()
    })
  },
  // 对账单图片（白底卡片：大字标题 + 明细 + 期末欠款高亮）
  drawStatementImage(d, share) {
    const text = d.text || ''
    wx.showLoading({ title: '生成图片…' })
    const W = 750, PAD = 40, DPRMAX = 678
    const src = text.split('\n')
    const title = src[0] || '对账单'
    let note = '', body = src.slice(1)
    if (body[0] && body[0].trim().startsWith('（')) { note = body[0].trim(); body = body.slice(1) }
    const unit = (ch) => (/[\u0000-\u00ff]/.test(ch) ? 0.55 : 1)
    const wrapOf = (line, font) => {
      const out = []
      if (!line.trim()) { out.push(''); return out }
      let cur = '', w = 0
      for (const ch of line) {
        const u = unit(ch)
        if (w + u > DPRMAX / font) { out.push(cur); cur = ch; w = u } else { cur += ch; w += u }
      }
      if (cur) out.push(cur)
      return out
    }
    const rows = []
    rows.push({ t: title, font: 30, lh: 46, bold: true, center: true, color: '#111111' })
    if (note) rows.push({ t: note, font: 22, lh: 34, center: true, color: '#888888' })
    rows.push({ t: '', font: 12, lh: 20 })
    body.forEach((line) => {
      const isEnd = /^期末(欠|应付|余额)/.test(line.trim())
      const isKey = /^本月(新增|已收|已付|明细|收款记录|付款记录)/.test(line.trim())
      const font = isEnd ? 30 : 24
      wrapOf(line, font).forEach((t, i) => rows.push({
        t, font, lh: isEnd ? 46 : 36,
        bold: isEnd || (isKey && i === 0), center: false,
        color: isEnd ? '#d93025' : (isKey ? '#1f6feb' : '#333333')
      }))
    })
    const H = PAD * 2 + rows.reduce((a, r) => a + r.lh, 0)
    wx.createSelectorQuery().in(this).select('#reportCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) { wx.hideLoading(); return wx.showToast({ title: '生成失败', icon: 'none' }) }
        const canvas = res[0].node
        const ctx = canvas.getContext('2d')
        const dpr = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).pixelRatio || 2
        canvas.width = W * dpr
        canvas.height = H * dpr
        ctx.scale(dpr, dpr)
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, W, H)
        // 顶部品牌色细条
        ctx.fillStyle = '#1f6feb'
        ctx.fillRect(0, 0, W, 6)
        ctx.textBaseline = 'top'
        let y = PAD
        rows.forEach((r) => {
          if (r.t) {
            ctx.font = (r.bold ? 'bold ' : '') + r.font + 'px sans-serif'
            ctx.fillStyle = r.color
            if (r.center) {
              ctx.textAlign = 'center'
              ctx.fillText(r.t, W / 2, y)
              ctx.textAlign = 'left'
            } else ctx.fillText(r.t, PAD, y)
          }
          y += r.lh
        })
        // 底部细线
        ctx.fillStyle = '#eeeeee'
        ctx.fillRect(PAD, H - 14, W - PAD * 2, 2)
        wx.canvasToTempFilePath({
          canvas,
          destWidth: W * dpr,
          destHeight: H * dpr,
          success: (rr) => {
            wx.hideLoading()
            if (share && wx.showShareImageMenu) {
              wx.showShareImageMenu({
                path: rr.tempFilePath,
                fail: () => wx.previewImage({ urls: [rr.tempFilePath] })
              })
            } else wx.previewImage({ urls: [rr.tempFilePath] })
          },
          fail: () => { wx.hideLoading(); wx.showToast({ title: '生成失败', icon: 'none' }) }
        })
      })
  },
  doImport() {
    const { import_type, import_text, import_types } = this.data
    const types = ['ar', 'ap', 'expense', 'loan', 'reimb', 'ar_init', 'ap_init']
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
    this.req({
      url: API_BASE + '/export', data: { type },
      success: (res) => {
        const text = res.data && res.data.text
        if (!text) return wx.showToast({ title: '没有数据可导出', icon: 'none' })
        const fname = (res.data && res.data.filename) || ('factory-' + type + '.csv')
        const path = wx.env.USER_DATA_PATH + '/' + fname
        wx.getFileSystemManager().writeFile({
          filePath: path, data: text, encoding: 'utf8',
          success: () => {
            if (wx.shareFileMessage) {
              wx.shareFileMessage({
                filePath: path, fileName: names[type] + '.csv',
                success: () => wx.showToast({ title: '已发出，选“文件传输助手”发给电脑', icon: 'none' }),
                fail: () => this.exportFallback(text)
              })
            } else this.exportFallback(text)
          },
          fail: () => this.exportFallback(text)
        })
      }
    })
  },
  exportFallback(text) {
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制表格内容，粘贴到记事本存成 .csv', icon: 'none' })
    })
  },
  // 从微信聊天里选一个 csv/txt 文件读进导入框
  chooseImportFile() {
    if (!wx.chooseMessageFile) return wx.showToast({ title: '微信版本过低，请用粘贴方式', icon: 'none' })
    wx.chooseMessageFile({
      count: 1, type: 'file', extension: ['csv', 'txt', 'CSV', 'TXT'],
      success: (r) => {
        const f = (r.tempFiles || [])[0]
        if (!f) return
        if (f.size > 3 * 1024 * 1024) return wx.showToast({ title: '文件太大（3MB 以内）', icon: 'none' })
        wx.getFileSystemManager().readFile({
          filePath: f.path, encoding: 'utf8',
          success: (fr) => {
            let t = String(fr.data || '').replace(/^\ufeff/, '')
            if (t.indexOf('\ufffd') >= 0) {
              wx.showModal({
                title: '文件编码不对', content: 'Excel 存成了旧格式，中文会乱。请在 Excel 里“另存为 → CSV UTF-8（逗号分隔）”再发一次。', showCancel: false
              })
              return
            }
            let lines = t.split(/\r?\n/).map((x) => x.trim()).filter((x) => x)
            // 去掉表头行（含“金额/客户/供应商/日期/分类”等字样且不是数字开头）
            if (lines.length && /金额|客户|供应商|日期|分类|备注|供应商/.test(lines[0]) && !/^\d/.test(lines[0])) lines = lines.slice(1)
            // 去掉 Excel 导出时给每个字段加的引号
            lines = lines.map((l) => l.split(',').map((x) => x.replace(/^"|"$/g, '').trim()).join(','))
            if (!lines.length) return wx.showToast({ title: '文件里没读到内容', icon: 'none' })
            this.setData({ import_text: lines.join('\n'), import_file_name: f.name || '表格文件' })
            wx.showToast({ title: '读入 ' + lines.length + ' 行，检查后点开始导入', icon: 'none' })
          },
          fail: () => wx.showToast({ title: '读取失败，改用粘贴方式', icon: 'none' })
        })
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
  onExMonth(e) { this.setData({ ex_month: e.detail.value }) },
  onExFrom(e) { this.setData({ ex_from: e.detail.value }) },
  onExTo(e) { this.setData({ ex_to: e.detail.value }) },
  // 把后端给的 xlsx 存成文件并转发
  saveXlsxFile(d) {
    if (!d.b64) return wx.showToast({ title: '没生成出来', icon: 'none' })
    const f = wx.env.USER_DATA_PATH + '/' + (d.name || '导出.xlsx')
    wx.getFileSystemManager().writeFile({
      filePath: f, data: d.b64, encoding: 'base64',
      success: () => {
        if (wx.shareFileMessage) {
          wx.shareFileMessage({ filePath: f, fileName: d.name || '导出.xlsx', fail: () => wx.openDocument({ filePath: f, showMenu: true }) })
        } else wx.openDocument({ filePath: f, showMenu: true })
      },
      fail: () => wx.showToast({ title: '存文件失败', icon: 'none' })
    })
  },
  // 整月导出：一个 Excel 多个工作表
  exportMonthXlsx() {
    const m = (this.data.ex_month || '').trim()
    wx.showLoading({ title: '生成中…' })
    this.req({
      url: API_BASE + '/export-xlsx' + (m ? '?month=' + encodeURIComponent(m) : ''),
      success: (res) => { wx.hideLoading(); this.saveXlsxFile(res.data || {}) },
      fail: () => wx.hideLoading()
    })
  },
  // 任意区间导出（比如 7-15 到 8-20）
  exportRangeXlsx() {
    const from = this.data.ex_from || ''
    const to = this.data.ex_to || ''
    if (!from || !to) return wx.showToast({ title: '先选起止日期', icon: 'none' })
    wx.showLoading({ title: '生成中…' })
    this.req({
      url: API_BASE + '/export-xlsx?from=' + from + '&to=' + to,
      success: (res) => { wx.hideLoading(); this.saveXlsxFile(res.data || {}) },
      fail: () => wx.hideLoading()
    })
  },
  // A4 打印版对账单：复制链接，电脑浏览器打开即可打印/存 PDF
  printStatement(e) {
    const ds = e.currentTarget.dataset
    const url = API_BASE + '/statement-link?type=' + (ds.type || 'ar') + '&party=' + encodeURIComponent(ds.name || '')
    wx.showLoading({ title: '生成中…' })
    this.req({
      url,
      success: (res) => {
        wx.hideLoading()
        const u = (res.data || {}).url
        if (!u) return wx.showToast({ title: (res.data && res.data.error) || '没生成出来', icon: 'none' })
        this.copyPrintLink(u)
      },
      fail: () => wx.hideLoading()
    })
  },
  copyPrintLink(u) {
    wx.setClipboardData({
      data: u,
      success: () => wx.showModal({
        title: '打印链接已复制',
        content: '粘到电脑浏览器打开，按 Ctrl+P 就能打印或存成 PDF（手机浏览器打开底部也有「打印」按钮）。',
        showCancel: false
      })
    })
  },
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
  // ── 家底 / 账龄 / 财务指标 / 月度归档 / 报表抬头 ──
  loadAsset() { this.loadWx(); this.loadNetworth(); this.loadKpi(); this.loadAging(); this.loadHead(); this.loadLoans() },
  loadNetworth() {
    this.req({
      url: API_BASE + '/networth?months=12',
      success: (res) => {
        const list = res.data || []
        let mx = 1
        list.forEach((r) => { mx = Math.max(mx, Math.abs(r.net), Math.abs(r.cash)) })
        const out = list.map((r) => ({
          m: r.m.slice(5) + '月', cash: r.cash, ar: r.ar, ap: r.ap, net: r.net,
          w: Math.round((Math.abs(r.net) / mx) * 100)
        }))
        this.setData({ nw: out, nw_max: mx, nw_latest: list.length ? list[list.length - 1] : null })
      }
    })
  },
  loadKpi() {
    this.req({ url: API_BASE + '/kpi', success: (res) => this.setData({ kpi: res.data || null }) })
  },
  loadAging() {
    this.req({
      url: API_BASE + '/aging?type=' + this.data.aging_type,
      success: (res) => this.setData({ aging: res.data || null })
    })
  },
  setAgingType(e) { this.setData({ aging_type: e.currentTarget.dataset.t }, () => this.loadAging()) },
  onMrMonth(e) { this.setData({ mr_month: e.detail.value }) },
  genMonthReport() {
    const m = (this.data.mr_month || '').trim()
    this.req({
      url: API_BASE + '/month-report' + (m ? '?month=' + encodeURIComponent(m) : ''),
      success: (res) => {
        if (res.data && res.data.text) this.setData({ mr_text: res.data.text, mr_month: res.data.month })
        else wx.showToast({ title: '生成失败', icon: 'none' })
      }
    })
  },
  copyMonthReport() {
    if (!this.data.mr_text) return wx.showToast({ title: '先生成归档', icon: 'none' })
    wx.setClipboardData({ data: this.data.mr_text })
  },
  mrImage() {
    if (!this.data.mr_text) return wx.showToast({ title: '先生成归档', icon: 'none' })
    this.drawTextImage(this.data.mr_text)
  },
  loadHead() {
    this.req({
      url: API_BASE + '/report-head',
      success: (res) => {
        const d = res.data || {}
        this.setData({ head_title: d.title || '', head_note: d.note || '' })
      }
    })
  },
  onHeadTitle(e) { this.setData({ head_title: e.detail.value }) },
  onHeadNote(e) { this.setData({ head_note: e.detail.value }) },
  saveHead() {
    this.req({
      url: API_BASE + '/report-head', method: 'POST',
      data: { title: this.data.head_title, note: this.data.head_note },
      success: (res) => {
        if (res.data && res.data.ok) wx.showToast({ title: '已保存', icon: 'success' })
        else wx.showToast({ title: (res.data && res.data.error) || '保存失败', icon: 'none' })
      }
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
  // 员工口令：设一个给员工，权限受限
  setStaffKey() {
    const tip = this.data.staff_enabled ? '输入新的员工口令（至少 4 位）；输空并确定=关闭员工登录' : '给员工用的口令（至少 4 位，别和你的口令一样）；输空并确定=关闭'
    wx.showModal({
      title: this.data.staff_enabled ? '修改员工口令' : '设置员工口令',
      content: tip, editable: true, placeholderText: '员工口令',
      success: (r) => {
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/auth/staff', method: 'POST',
          data: { key: wx.getStorageSync('ak'), password: String(r.content || '').trim() },
          success: (res) => {
            const d = res.data || {}
            if (d.ok) {
              this.setData({ staff_enabled: !!d.enabled })
              wx.showToast({ title: d.enabled ? '员工口令已保存' : '员工登录已关闭', icon: 'none' })
              this.loadMe()
            } else wx.showToast({ title: d.error || '设置失败', icon: 'none' })
          }
        })
      }
    })
  },
  // 上周经营速览（复制成文字，可发微信）
  copyWeekText() {
    this.req({
      url: API_BASE + '/weekly-text',
      success: (res) => {
        const d = res.data || {}
        const txt = d.text || d.t || ''
        if (!txt) return wx.showToast({ title: '没有数据', icon: 'none' })
        wx.setClipboardData({ data: txt, success: () => wx.showToast({ title: '已复制，去微信粘贴', icon: 'none' }) })
      }
    })
  },
  // 数据自检红点详情
  showIssue() {
    this.req({
      url: API_BASE + '/selfcheck',
      success: (res) => {
        const d = res.data || {}
        const lines = (d.issues || []).slice(0, 8).join('\n')
        wx.showModal({
          title: d.ok ? '数据对得上' : '有 ' + (d.bad || 0) + ' 处对不上',
          content: (lines || '两张单据的已收付金额和流水记录不一致，建议逐笔核对。').slice(0, 800),
          showCancel: false,
          confirmText: '知道了',
          success: () => this.refresh()
        })
      }
    })
  },
  // ===== 借款台账 =====
  loadDebts() {
    this.req({
      url: API_BASE + '/debts',
      success: (res) => {
        const d = res.data || {}
        this.setData({ debts: d.debts || [], debt_sum: { total_principal: d.total_principal, month_interest: d.month_interest, overdue_count: d.overdue_count, soon: d.soon || [], count: d.count } })
      }
    })
  },
  onDLender(e) { this.setData({ d_lender: e.detail.value }) },
  onDPrincipal(e) { this.setData({ d_principal: e.detail.value }) },
  onDRate(e) { this.setData({ d_rate: e.detail.value }) },
  onDTerm(e) { this.setData({ d_term: e.detail.value }) },
  onDRemark(e) { this.setData({ d_remark: e.detail.value }) },
  onDKind(e) { this.setData({ d_kind: Number(e.detail.value) }) },
  onDPayKind(e) { this.setData({ d_paykind: Number(e.detail.value) }) },
  onDStart(e) { this.setData({ d_start: e.detail.value }) },
  addDebt() {
    const d = this.data
    if (!d.d_lender) return wx.showToast({ title: '写一下跟谁借的', icon: 'none' })
    if (!(Number(d.d_principal) > 0)) return wx.showToast({ title: '本金要大于 0', icon: 'none' })
    const kinds = ['bank', 'person', 'other']
    const pays = ['interest', 'equal', 'end']
    this.req({
      url: API_BASE + '/debts', method: 'POST',
      data: { lender: d.d_lender, kind: kinds[d.d_kind], principal: Number(d.d_principal), rate: Number(d.d_rate || 0), start_date: d.d_start || '', term_months: Number(d.d_term || 0), pay_kind: pays[d.d_paykind], remark: d.d_remark },
      success: () => {
        wx.showToast({ title: '已记上，钱已入账户', icon: 'none' })
        this.setData({ d_lender: '', d_principal: '', d_remark: '', d_start: '' })
        this.loadDebts(); this.refresh()
      }
    })
  },
  repayDebt(e) {
    const id = e.currentTarget.dataset.id
    const it = this.data.debts.find((x) => x.id === id) || {}
    wx.showActionSheet({
      itemList: ['付利息 / 还款（记支出）', '看还款计划'],
      success: (r) => {
        if (r.tapIndex === 1) return this.debtSchedule(id, it)
        wx.showModal({
          title: '还款（' + (it.lender || '') + '）', editable: true,
          placeholderText: '金额,利息还是本金(默认利息)',
          content: String(it.next_amount || ''),
          success: (rr) => {
            if (!rr.confirm || !rr.content) return
            const parts = rr.content.split(/[,，\s]+/)
            const amt = Number(parts[0])
            const kind = (parts[1] || '').indexOf('本') >= 0 ? 'principal' : 'interest'
            if (!(amt > 0)) return wx.showToast({ title: '金额不对', icon: 'none' })
            this.req({
              url: API_BASE + '/debts/' + id + '/repay', method: 'POST',
              data: { amount: amt, kind,
                account_id: this.data.acc_id || undefined },
              success: (res) => {
                const d = res.data || {}
                wx.showToast({ title: d.closed ? '这笔借款已还清' : '已记还款，余 ' + d.remain, icon: 'none' })
                this.loadDebts(); this.refresh()
              }
            })
          }
        })
      }
    })
  },
  debtSchedule(id, it) {
    this.req({
      url: API_BASE + '/debts/' + id + '/schedule',
      success: (res) => {
        const d = res.data || {}
        const head = `${d.lender || ''}　本金 ¥${d.principal}　年利率 ${d.rate}%　${d.term_months} 期\n总利息约 ¥${d.total_interest}，连本带息 ¥${d.total_pay}\n已付息 ¥${d.paid_interest}，已还本 ¥${d.paid_principal}\n（下面是计划，点还款记实际付出）`
        const rows = (d.rows || []).slice(0, 12).map((r) => `${r.n}. ${r.due.slice(2)} 利息 ${r.interest} 本金 ${r.principal} 合计 ${r.pay}`).join('\n')
        wx.showModal({ title: '还款计划', content: (head + '\n' + rows).slice(0, 900), showCancel: false })
      }
    })
  },
  delDebt(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删掉这笔借款？', content: '会连带删掉它的还款记录和资金流水',
      success: (r) => {
        if (!r.confirm) return
        this.req({ url: API_BASE + '/debts/' + id, method: 'DELETE', success: () => { this.loadDebts(); this.refresh() } })
      }
    })
  },
  // ===== 待摊费用（房租/保险一次付多月，按月摊） =====
  loadPrepaids() {
    this.req({
      url: API_BASE + '/prepaids',
      success: (res) => {
        const d = res.data || {}
        this.setData({
          prepaids: d.prepaids || [],
          prepaid_sum: { open_count: d.open_count || 0, total_left: d.total_left || 0, month_amount: d.month_amount || 0 }
        })
      }
    })
  },
  onPPName(e) { this.setData({ pp_name: e.detail.value }) },
  onPPTotal(e) { this.setData({ pp_total: e.detail.value }) },
  onPPMonths(e) { this.setData({ pp_months: e.detail.value }) },
  onPPCat(e) { this.setData({ pp_cat: e.detail.value }) },
  onPPStart(e) { this.setData({ pp_start: e.detail.value }) },
  addPrepaid() {
    const d = this.data
    if (!(Number(d.pp_total) > 0)) return wx.showToast({ title: '总金额要大于 0', icon: 'none' })
    if (!(Number(d.pp_months) >= 1)) return wx.showToast({ title: '摊几个月要填', icon: 'none' })
    this.req({
      url: API_BASE + '/prepaids', method: 'POST',
      data: { name: d.pp_name || d.pp_cat, total: Number(d.pp_total), months: Number(d.pp_months), category: d.pp_cat || '房租', start_date: d.pp_start || '' },
      success: () => {
        wx.showToast({ title: '已记上，按月摊销', icon: 'none' })
        this.setData({ pp_name: '', pp_total: '', pp_start: '' })
        this.loadPrepaids(); this.refresh()
      }
    })
  },
  togglePrepaid(e) {
    const ds = e.currentTarget.dataset
    const on = ds.active !== 'open'
    this.req({
      url: API_BASE + '/prepaids/' + ds.id, method: 'PATCH', data: { active: on },
      success: () => { this.loadPrepaids(); this.refresh() }
    })
  },
  delPrepaid(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删掉这笔待摊？', content: '会连带删掉已摊销的流水（当月成本会变少）',
      success: (r) => {
        if (!r.confirm) return
        this.req({ url: API_BASE + '/prepaids/' + id, method: 'DELETE', success: () => { this.loadPrepaids(); this.refresh() } })
      }
    })
  },
  runAmort() {
    this.req({
      url: API_BASE + '/run-amort', method: 'POST',
      success: (res) => {
        const d = res.data || {}
        wx.showToast({ title: d.added ? '补摊了 ' + d.added + ' 个月，共 ' + d.amount + ' 元' : '没有要补的月份', icon: 'none' })
        this.loadPrepaids(); this.refresh()
      }
    })
  },
  runAccrual() {
    this.req({
      url: API_BASE + '/run-accrual', method: 'POST',
      success: (res) => {
        const d = res.data || {}
        wx.showToast({ title: d.added ? '已预提本月利息 ' + d.amount + ' 元' : '本月已经提过了', icon: 'none' })
        this.loadDebts(); this.refresh()
      }
    })
  },
  // ===== 客户信用额度 =====
  setCreditLimit(e) {
    const name = e.currentTarget.dataset.name
    const cur = (this.data.credit_limits || []).find((x) => x.party === name) || {}
    wx.showModal({
      title: '给「' + name + '」设欠款上限', editable: true,
      placeholderText: '比如 5000（填 0 等于取消）',
      content: cur.limit_amount ? String(cur.limit_amount) : '',
      success: (r) => {
        if (!r.confirm || !r.content) return
        const lim = Number(String(r.content).trim())
        if (!(lim >= 0)) return wx.showToast({ title: '填个数字', icon: 'none' })
        this.req({
          url: API_BASE + '/credit-limits', method: 'POST', data: { party: name, limit_amount: lim },
          success: () => { wx.showToast({ title: lim ? '额度已设' : '额度已取消', icon: 'none' }); this.loadLimits() }
        })
      }
    })
  },
  loadLimits() {
    this.req({ url: API_BASE + '/credit-limits', success: (res) => this.setData({ credit_limits: (res.data && res.data.limits) || [] }) })
  },
  // 现金流预测（未来 45 天会不会缺钱）
  loadCashflow() {
    if (this.data.role === 'staff') return
    this.req({ url: API_BASE + '/cashflow?days=45', success: (res) => this.setData({ cf: res.data || null }) })
  },
  showCashflow() {
    const cf = this.data.cf || {}
    if (!cf.days) return
    const ins = (cf.in_items || []).map((x) => `· ${x.date.slice(5)} 收 ${x.party} ¥${x.amount}${x.overdue ? '（已逾期）' : ''}`).join('\n')
    const outs = (cf.out_items || []).map((x) => `· ${x.date.slice(5)} 付 ${x.party} ¥${x.amount}`).join('\n')
    const body = [
      `手头现金：¥${cf.cash}`,
      `未来 ${cf.days} 天预计进：+¥${cf.inflow}（${cf.in_count} 笔）`,
      ins || '（没有安排中的收款）',
      `未来 ${cf.days} 天预计出：-¥${cf.outflow}（${cf.out_count} 笔）`,
      outs || '（没有安排中的付款）',
      `${cf.days} 天后预计：¥${cf.end}`,
      cf.risk ? `⚠ ${cf.min_date} 最低 ¥${cf.min_balance}，需要提前安排` : '✔ 这段时间不会缺钱'
    ].join('\n')
    wx.showModal({ title: '未来 ' + cf.days + ' 天现金', content: body.slice(0, 900), showCancel: false })
  },
  // 当前身份（老板/员工）
  loadMe() {
    this.req({
      url: API_BASE + '/me',
      success: (res) => {
        const d = res.data || {}
        this.setData({ role: d.role === 'staff' ? 'staff' : 'owner', staff_enabled: !!d.staff_enabled })
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
  // ---------- 微信订阅消息（到期提醒） ----------
  loadWx() {
    this.req({
      url: API_BASE + '/wx-config',
      success: (res) => {
        const d = res.data || {}
        this.setData({ wx_appid: d.appid || '', wx_tpl: d.tpl || '', wx_fields: d.fields || '', wx_info: d, wx_secret: '' })
      }
    })
  },
  onWxAppid(e) { this.setData({ wx_appid: e.detail.value }) },
  onWxSecret(e) { this.setData({ wx_secret: e.detail.value }) },
  onWxTpl(e) { this.setData({ wx_tpl: e.detail.value }) },
  onWxFields(e) { this.setData({ wx_fields: e.detail.value }) },
  saveWx() {
    const b = { appid: this.data.wx_appid, tpl: this.data.wx_tpl }
    if (this.data.wx_secret) b.secret = this.data.wx_secret
    if (this.data.wx_fields) b.fields = this.data.wx_fields
    this.req({
      url: API_BASE + '/wx-config', method: 'POST', data: b,
      success: () => { wx.showToast({ title: '已保存', icon: 'none' }); this.setData({ wx_secret: '' }); this.loadWx() }
    })
  },
  // 开启微信提醒：先登记 openid，再申请一次性订阅
  enableWx() {
    const tpl = (this.data.wx_tpl || '').trim()
    if (!tpl) return wx.showToast({ title: '先填模板ID并保存', icon: 'none' })
    wx.login({
      success: (lr) => {
        if (!lr.code) return wx.showToast({ title: '微信登录失败', icon: 'none' })
        this.req({
          url: API_BASE + '/wx-login', method: 'POST', data: { code: lr.code },
          success: (r) => {
            const openid = (r.data || {}).openid
            if (!openid) return
            this.setData({ wx_openid: openid })
            if (!wx.requestSubscribeMessage) return wx.showToast({ title: '微信版本过低', icon: 'none' })
            wx.requestSubscribeMessage({
              tmplIds: [tpl],
              success: (sr) => {
                if (sr[tpl] === 'accept') {
                  this.req({
                    url: API_BASE + '/wx-subscribed', method: 'POST', data: { openid, n: 1 },
                    success: () => { wx.showToast({ title: '已开启，明早会推一条', icon: 'none' }); this.loadWx() }
                  })
                } else {
                  wx.showModal({ title: '没允许', content: '你点了拒绝。想收到提醒，再点一次「开启微信提醒」并选「允许」。', showCancel: false })
                }
              },
              fail: (e) => wx.showToast({ title: (e && e.errMsg) || '授权失败', icon: 'none' })
            })
          }
        })
      }
    })
  },
  testWx() {
    wx.showLoading({ title: '发送中…' })
    this.req({
      url: API_BASE + '/wx-test', method: 'POST', data: {},
      success: (res) => {
        wx.hideLoading()
        const d = res.data || {}
        const line = (d.sent || []).map((x) => x.openid + (x.ok ? ' 成功' : ' 失败：' + x.msg)).join('\n')
        wx.showModal({ title: '发送结果', content: line || '已发送', showCancel: false })
        this.loadWx()
      },
      fail: () => wx.hideLoading()
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
  loadBooks() {
    const bk = Number(wx.getStorageSync('book') || 1)
    this.req({
      url: API_BASE + '/books',
      success: (res) => {
        if (res.data && res.data.books) {
          const cur = (res.data.books.find((b) => b.id === bk) || res.data.books[0] || {})
          this.setData({ books: res.data.books, book: bk, book_name: cur.name || '主账套' })
          if (cur.name) wx.setStorageSync('book_name', cur.name)
        }
      }
    })
  },
  switchBook(e) {
    const id = Number(e.currentTarget.dataset.id)
    if (id === this.data.book) return
    wx.showModal({
      title: '切换账套',
      content: '切换到「' + (this.data.books.find((b) => b.id === id) || {}).name + '」？各账套数据完全分开。',
      success: (r) => {
        if (!r.confirm) return
        wx.setStorageSync('book', id)
        this.setData({ book: id })
        this.refresh()
        wx.showToast({ title: '已切换', icon: 'success' })
      }
    })
  },
  onRenameText(e) { this.setData({ rename_text: e.detail.value }) },
  renameBook() {
    const nm = (this.data.rename_text || '').trim()
    if (!nm) return wx.showToast({ title: '先填名称', icon: 'none' })
    this.req({
      url: API_BASE + '/book-name', method: 'POST',
      data: { name: nm },
      success: (res) => {
        if (res.data && res.data.ok) {
          wx.setStorageSync('book_name', nm)
          this.setData({ rename_text: '', book_name: nm })
          this.loadBooks()
          wx.showToast({ title: '已改名', icon: 'success' })
        } else wx.showToast({ title: (res.data && res.data.error) || '改名失败', icon: 'none' })
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
  // ── 全局搜索 ──
  onSearchKw(e) {
    const kw = e.detail.value
    this.setData({ search_kw: kw })
    if (!kw.trim()) { this.setData({ search_res: null }); return }
    clearTimeout(this._st)
    this._st = setTimeout(() => {
      this.req({ url: API_BASE + '/search?kw=' + encodeURIComponent(kw.trim()), success: (res) => this.setData({ search_res: res.data || null }) })
    }, 300)
  },
  clearSearch() { this.setData({ search_kw: '', search_res: null }) },
  goSearchTab(e) {
    const t = e.currentTarget.dataset.t
    this.setData({ tab: t, search_kw: '', search_res: null })
  },
  // ── 常用短语 ──
  loadPhrases() {
    this.req({ url: API_BASE + '/phrases', success: (res) => this.setData({ phrases: res.data || [] }) })
  },
  pickPhrase(e) {
    const t = e.currentTarget.dataset.t
    this.setData({ q_text: t })
  },
  savePhrase() {
    const t = (this.data.q_text || '').trim()
    if (!t) return wx.showToast({ title: '先输入内容', icon: 'none' })
    this.req({ url: API_BASE + '/phrases', method: 'POST', data: { text: t },
      success: () => { this.loadPhrases(); wx.showToast({ title: '已存为常用', icon: 'success' }) } })
  },
  delPhrase(e) {
    const id = e.currentTarget.dataset.id
    this.req({ url: API_BASE + '/phrases/' + id, method: 'DELETE', success: () => this.loadPhrases() })
  },
  // ── 支出预算 ──
  loadBudgets() {
    this.req({ url: API_BASE + '/budgets', success: (res) => this.setData({ budgets: res.data || [] }) })
  },
  onBCategory(e) { this.setData({ b_category: Number(e.detail.value) }) },
  onBAmount(e) { this.setData({ b_amount: e.detail.value }) },
  saveBudget() {
    const amount = Number(this.data.b_amount)
    if (!(amount > 0)) return wx.showToast({ title: '额度要大于 0', icon: 'none' })
    this.req({ url: API_BASE + '/budgets', method: 'POST',
      data: { category: this.data.categories[this.data.b_category], amount },
      success: (res) => {
        if (res.data && res.data.ok) { this.setData({ b_amount: '' }); this.loadBudgets(); this.loadDashboard(); wx.showToast({ title: '已保存', icon: 'success' }) }
        else wx.showToast({ title: (res.data && res.data.error) || '失败', icon: 'none' })
      } })
  },
  delBudget(e) {
    const id = e.currentTarget.dataset.id
    this.req({ url: API_BASE + '/budgets/' + id, method: 'DELETE', success: () => { this.loadBudgets(); this.loadDashboard() } })
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
  },
  // ── 第三档：提醒汇总 / 发票台账 / 固定资产 / 银行流水对账 ──
  loadOnboard() {
    this.req({
      url: API_BASE + '/onboarding',
      success: (res) => this.setData({ onboard: res.data || null })
    })
  },
  onbGo(e) {
    const k = e.currentTarget.dataset.k
    if (k === 'acc') return this.setData({ group: 'me', tab: 'contact' })
    this.setData({ group: 'bill', tab: 'import', import_type: k === 'ap' ? 6 : 5 })
  },
  onbDismiss() {
    wx.showModal({
      title: '不再提示？', content: '底数没填的话，欠款合计、毛利、手头现金都会不准。以后想补可以在设置里做。',
      confirmText: '不再提示', success: (r) => {
        if (!r.confirm) return
        this.req({ url: API_BASE + '/onboarding/dismiss', method: 'POST', success: () => this.setData({ onboard: null }) })
      }
    })
  },
  loadReminders() {
    this.req({ url: API_BASE + '/reminders', success: (res) => this.setData({ rem_items: (res.data && res.data.items) || [] }) })
  },
  loadInvoices() {
    const m = this.data.inv_month ? '&month=' + this.data.inv_month : ''
    this.req({
      url: API_BASE + '/invoices?type=' + this.data.inv_type + m,
      success: (res) => {
        const d = res.data || {}
        this.setData({ inv_rows: d.rows || [], inv_sum: d.summary || { out: {}, in: {} }, inv_uninv: d.uninvoiced || {} })
      }
    })
  },
  onInvType(e) { this.setData({ inv_type: Number(e.detail.value) ? 'in' : 'out' }); this.loadInvoices() },
  onInvMonth(e) { this.setData({ inv_month: e.detail.value }) },
  onInvNo(e) { this.setData({ inv_no: e.detail.value }) },
  onInvParty(e) { this.setData({ inv_party: e.detail.value }) },
  onInvAmount(e) { this.setData({ inv_amount: e.detail.value }) },
  onInvTax(e) { this.setData({ inv_tax: e.detail.value }) },
  onInvDate(e) { this.setData({ inv_date: e.detail.value }) },
  onInvRemark(e) { this.setData({ inv_remark: e.detail.value }) },
  queryInv() {
    const m = this.data.inv_month && /^\d{4}-\d{2}$/.test(this.data.inv_month) ? this.data.inv_month : ''
    this.setData({ inv_month: m }); this.loadInvoices()
  },
  addInvoice() {
    const d = this.data
    if (!String(d.inv_party || '').trim()) return wx.showToast({ title: d.inv_type === 'out' ? '填客户名称' : '填供应商名称', icon: 'none' })
    if (!Number(d.inv_amount)) return wx.showToast({ title: '填开票金额', icon: 'none' })
    this.req({
      url: API_BASE + '/invoices', method: 'POST',
      data: { type: d.inv_type, no: d.inv_no, party: d.inv_party, amount: Number(d.inv_amount), tax: Number(d.inv_tax) || 0, date: d.inv_date, remark: d.inv_remark },
      success: (res) => {
        if (res.data && res.data.ok) {
          this.setData({ inv_no: '', inv_party: '', inv_amount: '', inv_tax: '', inv_date: '', inv_remark: '' })
          this.loadInvoices(); this.loadReminders()
          wx.showToast({ title: '已记发票', icon: 'success' })
        } else wx.showToast({ title: (res.data && res.data.error) || '没记上', icon: 'none' })
      }
    })
  },
  delInvoice(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删发票', content: '删掉这张发票记录？', confirmColor: '#e64340',
      success: (r) => { if (r.confirm) this.req({ url: API_BASE + '/invoices/' + id, method: 'DELETE', success: () => { this.loadInvoices(); this.loadReminders() } }) }
    })
  },
  loadAssets() {
    this.req({
      url: API_BASE + '/assets',
      success: (res) => {
        const d = res.data || {}
        this.setData({ asset_rows: d.rows || [], asset_cost_total: d.total_cost || 0, asset_monthly: d.total_monthly || 0, asset_net: d.total_net || 0 })
      }
    })
  },
  onAssetName(e) { this.setData({ asset_name: e.detail.value }) },
  onAssetCost(e) { this.setData({ asset_cost: e.detail.value }) },
  onAssetBuy(e) { this.setData({ asset_buy: e.detail.value }) },
  onAssetLife(e) { this.setData({ asset_life: e.detail.value }) },
  onAssetRes(e) { this.setData({ asset_res: e.detail.value }) },
  addAsset() {
    const d = this.data
    if (!String(d.asset_name || '').trim()) return wx.showToast({ title: '填设备名称', icon: 'none' })
    if (!Number(d.asset_cost)) return wx.showToast({ title: '填设备原值', icon: 'none' })
    this.req({
      url: API_BASE + '/assets', method: 'POST',
      data: { name: d.asset_name, cost: Number(d.asset_cost), buy_date: d.asset_buy, life_years: Number(d.asset_life) || 5, residual_rate: d.asset_res === '' ? 5 : Number(d.asset_res) },
      success: (res) => {
        if (res.data && res.data.ok) {
          this.setData({ asset_name: '', asset_cost: '', asset_buy: '', asset_life: '', asset_res: '' })
          this.loadAssets(); wx.showToast({ title: '已添加', icon: 'success' })
        } else wx.showToast({ title: (res.data && res.data.error) || '没加成功', icon: 'none' })
      }
    })
  },
  delAsset(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删设备', content: '删掉这台设备？已计提的折旧支出不会自动删。', confirmColor: '#e64340',
      success: (r) => { if (r.confirm) this.req({ url: API_BASE + '/assets/' + id, method: 'DELETE', success: () => this.loadAssets() }) }
    })
  },
  runDepreciation() {
    this.req({
      url: API_BASE + '/assets/run-depreciation', method: 'POST', data: {},
      success: (res) => {
        const d = res.data || {}
        this.setData({ tab: this.data.tab })
        if (d.ok && Number(d.added) > 0) { wx.showToast({ title: '本月折旧已记 ¥' + d.added, icon: 'success' }); this.refresh() }
        else wx.showToast({ title: d.note || '不用记', icon: 'none' })
      }
    })
  },
  loadBankFlows() {
    this.req({
      url: API_BASE + '/bank-flows?matched=0',
      success: (res) => {
        const d = res.data || {}
        this.setData({ bank_rows: d.rows || [], bank_unmatched: d.unmatched || {} })
      }
    })
  },
  onBankText(e) { this.setData({ bank_text: e.detail.value }) },
  importBank() {
    const t = String(this.data.bank_text || '').trim()
    if (!t) return wx.showToast({ title: '先把流水粘进来', icon: 'none' })
    this.req({
      url: API_BASE + '/bank-import', method: 'POST', data: { text: t },
      success: (res) => {
        const d = res.data || {}
        if (d.ok) { this.setData({ bank_text: '' }); this.loadBankFlows(); wx.showToast({ title: '导入 ' + d.imported + ' 笔', icon: 'success' }) }
        else wx.showToast({ title: d.error || '导入失败', icon: 'none' })
      }
    })
  },
  delBankFlow(e) {
    const id = e.currentTarget.dataset.id
    this.req({ url: API_BASE + '/bank-flows/' + id, method: 'DELETE', success: () => this.loadBankFlows() })
  },
  matchBankOrder(e) {
    const id = e.currentTarget.dataset.id
    const list = (this.data.ar_all || []).filter((o) => Number(o.price) - Number(o.paid) > 0)
    if (!list.length) return wx.showToast({ title: '没有未结的应收单', icon: 'none' })
    wx.showActionSheet({
      itemList: list.slice(0, 6).map((o) => `${o.customer} ${o.item_name} 欠${Math.round(Number(o.price) - Number(o.paid))}`),
      success: (r) => {
        const o = list[r.tapIndex]
        this.req({
          url: API_BASE + '/bank-flows/' + id + '/match', method: 'POST', data: { target_type: 'order', target_id: o.id },
          success: (res) => {
            if (res.data && res.data.ok) { this.loadBankFlows(); this.refresh(); wx.showToast({ title: '已抵应收', icon: 'success' }) }
            else wx.showToast({ title: (res.data && res.data.error) || '认领失败', icon: 'none' })
          }
        })
      }
    })
  },
  matchBankPayable(e) {
    const id = e.currentTarget.dataset.id
    const list = (this.data.ap_all || []).filter((p) => Number(p.amount) - Number(p.paid) > 0)
    if (!list.length) return wx.showToast({ title: '没有未结的应付单', icon: 'none' })
    wx.showActionSheet({
      itemList: list.slice(0, 6).map((p) => `${p.supplier} 欠${Math.round(Number(p.amount) - Number(p.paid))}`),
      success: (r) => {
        const p = list[r.tapIndex]
        this.req({
          url: API_BASE + '/bank-flows/' + id + '/match', method: 'POST', data: { target_type: 'payable', target_id: p.id },
          success: (res) => {
            if (res.data && res.data.ok) { this.loadBankFlows(); this.refresh(); wx.showToast({ title: '已抵应付', icon: 'success' }) }
            else wx.showToast({ title: (res.data && res.data.error) || '认领失败', icon: 'none' })
          }
        })
      }
    })
  },
  matchBankExpense(e) {
    const id = e.currentTarget.dataset.id
    const cats = (this.data.cats_out || []).map((c) => c.name)
    const list = cats.length ? cats : ['工资', '水电', '房租', '采购', '辅料', '其他']
    wx.showActionSheet({
      itemList: list.slice(0, 6),
      success: (r) => {
        this.req({
          url: API_BASE + '/bank-flows/' + id + '/match', method: 'POST', data: { target_type: 'expense', category: list[r.tapIndex] },
          success: (res) => {
            if (res.data && res.data.ok) { this.loadBankFlows(); this.refresh(); wx.showToast({ title: '已记成支出', icon: 'success' }) }
            else wx.showToast({ title: (res.data && res.data.error) || '认领失败', icon: 'none' })
          }
        })
      }
    })
  },

  // ── 坏账核销 ──
  loadWriteoffs() {
    const m = this.data.inv_month ? '?month=' + this.data.inv_month : ''
    this.req({
      url: API_BASE + '/writeoffs' + m,
      fail: () => {},
      success: (res) => {
        const d = res.data || {}
        if (d.error) return
        this.setData({ wf_rows: d.rows || [], wf_bad: d.bad_debt || 0, wf_waived: d.payable_waived || 0 })
      }
    })
  },
  writeoffOrder(e) {
    const id = e.currentTarget.dataset.id
    const unpaid = Number(e.currentTarget.dataset.unpaid) || 0
    wx.showModal({
      title: '核销这笔应收',
      content: '要不回来的金额，默认全部 ' + unpaid + ' 元（也可以只填一部分）',
      editable: true,
      placeholderText: String(unpaid),
      success: (r) => {
        if (!r.confirm) return
        const v = (r.content || '').trim()
        const amount = v ? Number(v) : unpaid
        if (!(amount > 0)) return wx.showToast({ title: '金额不对', icon: 'none' })
        this.req({
          url: API_BASE + '/orders/' + id + '/writeoff', method: 'POST',
          data: { amount: amount, reason: '联系不上客户/要不回来了' },
          success: (res) => {
            const d = res.data || {}
            if (d.ok) {
              wx.showToast({ title: '已核销 ' + d.amount, icon: 'success' })
              this.loadAr(); this.loadDashboard(); this.loadWriteoffs()
            } else wx.showToast({ title: d.error || '核销失败', icon: 'none' })
          }
        })
      }
    })
  },
  writeoffPayable(e) {
    const id = e.currentTarget.dataset.id
    const unpaid = Number(e.currentTarget.dataset.unpaid) || 0
    wx.showModal({
      title: '核销这笔应付',
      content: '供应商不用再付的金额，默认全部 ' + unpaid + ' 元',
      editable: true,
      placeholderText: String(unpaid),
      success: (r) => {
        if (!r.confirm) return
        const v = (r.content || '').trim()
        const amount = v ? Number(v) : unpaid
        if (!(amount > 0)) return wx.showToast({ title: '金额不对', icon: 'none' })
        this.req({
          url: API_BASE + '/payables/' + id + '/writeoff', method: 'POST',
          data: { amount: amount, reason: '供应商免了/不用付了' },
          success: (res) => {
            const d = res.data || {}
            if (d.ok) {
              wx.showToast({ title: '已核销 ' + d.amount, icon: 'success' })
              this.loadAp(); this.loadDashboard(); this.loadWriteoffs()
            } else wx.showToast({ title: d.error || '核销失败', icon: 'none' })
          }
        })
      }
    })
  },
  undoWriteoff(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '撤销核销',
      content: '撤销后这笔欠款会重新回到应收/应付里。确定吗？',
      success: (r) => {
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/writeoffs/' + id, method: 'DELETE',
          success: () => {
            wx.showToast({ title: '已撤销', icon: 'success' })
            this.loadWriteoffs(); this.loadAr(); this.loadAp(); this.loadDashboard()
          }
        })
      }
    })
  },
  // ── 账户内部转账 ──
  loadTransfers() {
    this.req({
      url: API_BASE + '/transfers',
      fail: () => {},
      success: (res) => { this.setData({ tr_rows: res.data || [] }) }
    })
  },
  onTrFrom(e) { this.setData({ tr_from: Number(e.detail.value) }) },
  onTrTo(e) { this.setData({ tr_to: Number(e.detail.value) }) },
  onTrAmount(e) { this.setData({ tr_amount: e.detail.value }) },
  onTrRemark(e) { this.setData({ tr_remark: e.detail.value }) },
  addTransfer() {
    const { accounts, tr_from, tr_to, tr_amount, tr_remark } = this.data
    if (tr_from < 0 || tr_to < 0) return wx.showToast({ title: '先选转出和转入账户', icon: 'none' })
    if (tr_from === tr_to) return wx.showToast({ title: '两边不能是同一个账户', icon: 'none' })
    const a = Number(tr_amount) || 0
    if (!(a > 0)) return wx.showToast({ title: '转账金额不对', icon: 'none' })
    this.req({
      url: API_BASE + '/transfer', method: 'POST',
      data: { from: accounts[tr_from].id, to: accounts[tr_to].id, amount: a, remark: tr_remark },
      success: (res) => {
        const d = res.data || {}
        if (d.ok) {
          wx.showToast({ title: '已转账', icon: 'success' })
          this.setData({ tr_amount: '', tr_remark: '' })
          this.loadAccounts(); this.loadTransfers(); this.loadDashboard()
        } else wx.showToast({ title: d.error || '转账失败', icon: 'none' })
      }
    })
  },
  delTransfer(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除这笔转账',
      content: '删掉后两边账户余额都会回滚。确定吗？',
      success: (r) => {
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/transfers/' + id, method: 'DELETE',
          success: () => {
            wx.showToast({ title: '已删除', icon: 'success' })
            this.loadAccounts(); this.loadTransfers(); this.loadDashboard()
          }
        })
      }
    })
  },

  // 一键收清 / 付清（先选资金账户，再确认）
  receiveAll(e) {
    this.settleAll(e, 'ar')
  },
  payAll(e) {
    this.settleAll(e, 'ap')
  },
  settleAll(e, type) {
    const { id, unpaid } = e.currentTarget.dataset
    const accs = this.data.accounts || []
    const isAr = type === 'ar'
    const go = (acc) => {
      wx.showModal({
        title: isAr ? '收清这一单' : '付清这一笔',
        content: (isAr ? '收 ' : '付 ') + '¥' + unpaid + (acc ? '，走「' + acc.name + '」' : '') + '，确认？',
        success: (r) => {
          if (!r.confirm) return
          const url = API_BASE + (isAr ? '/orders/' : '/payables/') + id + (isAr ? '/receive' : '/pay')
          this.req({ url, method: 'POST', data: { amount: unpaid, account_id: acc ? acc.id : 0 },
            success: (res) => {
              if (res.data && res.data.ok) { this.refresh(); wx.showToast({ title: isAr ? '已收清' : '已付清', icon: 'success' }) }
              else wx.showToast({ title: (res.data && res.data.error) || '失败', icon: 'none' })
            } })
        }
      })
    }
    if (!accs.length) return go(null)
    wx.showActionSheet({
      itemList: accs.map((a) => (isAr ? '收到 ' : '付自 ') + a.name + '（余额 ' + a.balance + '）'),
      success: (a) => go(accs[a.tapIndex]),
      fail: () => {}
    })
  },
  // 改约定日期（应收/应付通用）
  editDue(e) {
    const { id, type, due } = e.currentTarget.dataset
    wx.showModal({
      title: type === 'ar' ? '约定收款日' : '约定付款日',
      editable: true,
      placeholderText: '如 11-20 或 2026-11-20，留空=清除',
      content: due || '',
      success: (r) => {
        if (!r.confirm) return
        const val = (r.content || '').trim()
        const url = API_BASE + (type === 'ar' ? '/orders/' : '/payables/') + id
        this.req({ url, method: 'PATCH', data: type === 'ar' ? { due_date: val } : { due_date: val },
          success: (res) => {
            if (res.data && res.data.ok) { this.refresh(); wx.showToast({ title: '已更新', icon: 'success' }) }
            else wx.showToast({ title: (res.data && res.data.error) || '失败', icon: 'none' })
          } })
      }
    })
  },
  // 单据明细
  showDetail(e) {
    const { id, type } = e.currentTarget.dataset
    const url = API_BASE + (type === 'ar' ? '/orders/' : '/payables/') + id + '/detail'
    this.req({ url, success: (res) => {
      const d = res.data || {}
      if (d.error) { wx.showToast({ title: d.error, icon: 'none' }); return }
      const rows = (d.payments || []).map((x) => ({
        k: x.date + '  ' + (x.cash === 0 ? x.account : '¥' + x.amount + '  ' + x.account),
        v: x.cash === 0 ? '¥' + x.amount + '（抵扣）' : (x.remark || '')
      }))
      const wos = (d.writeoffs || []).map((x) => ({ k: x.date + '  核销', v: '¥' + x.amount + (x.reason ? '  ' + x.reason : '') }))
      const head = type === 'ar'
        ? d.customer + ' · ' + d.item_name + ' · 总 ' + d.price + ' · 已收 ' + d.paid + (d.written_off > 0 ? ' · 已核销 ' + d.written_off : '') + ' · 还欠 ' + d.unpaid
        : d.supplier + ' · 总 ' + d.amount + ' · 已付 ' + d.paid + (d.written_off > 0 ? ' · 已核销 ' + d.written_off : '') + ' · 还欠 ' + d.unpaid
      const text = head + '\n' + (rows.concat(wos).map((x) => x.k + '  ' + x.v).join('\n') || '还没有' + (type === 'ar' ? '收款' : '付款') + '记录')
      this.setData({ detail_show: true, detail_title: type === 'ar' ? '应收明细' : '应付明细', detail_head: head, detail_rows: rows.concat(wos), detail_text: text })
    } })
  },
  noop() {},
  closeDetail() { this.setData({ detail_show: false }) },
  copyDetail() {
    wx.setClipboardData({ data: this.data.detail_text, success: () => wx.showToast({ title: '已复制', icon: 'success' }) })
  },
})
