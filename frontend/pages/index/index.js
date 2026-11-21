const API_BASE = 'https://jz.qy663.de5.net'
// 内置演示口令（和后端 DEMO_KEY 一致）：登录页「先看看演示」用，进的是演示账套（示例数据）
const DEMO_KEY = 'demo-look'

// 手机本地日期串（YYYY-MM-DD）。不能用 toISOString()——那是 UTC，北京时间 0~8 点会差一天
const pad2 = (n) => String(n).padStart(2, '0')
const dayOf = (d) => { const x = d || new Date(); return x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate()) }
// 转数字：空串/非数字一律当 0（页面上到处是输入框，直接 Number() 会得到 NaN）
const num0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

// 功能索引：170 多项功能太多，用「找功能」搜索直接跳过去（纯前端，不发请求）
const FEATS = [
  { n: "预收款（客户先给的钱）", go: "me:contact", desc: "客户没干活先给的钱，记成预收款；以后发货/加工完成抵扣，不重复算收入", kw: "预收 预付款 定金 先给 打款 客户先给 抵扣" },
  { n: "员工借支（借钱给伙计）", go: "me:contact", desc: "借出去、报销冲抵、退回余款，一笔一笔挂着", kw: "借支 借钱 伙计 员工 报销 预支 备用金" },
  { n: "借款（外面借的钱）", go: "me:contact", desc: "本金、利率、每月利息、还款计划；净资产会自动扣掉", kw: "借款 贷款 借钱 利息 月供 还款 银行贷款" },
  { n: "钱的三条线（首页）", go: "home:home", desc: "预收款、预付供应商、员工借支、借款一屏看清", kw: "三条线 资金 往来 挂着 没结清 概览" },
  { n: "改单（填错了要改）", go: "bill:ar", desc: "客户、产品、金额、成本、到期日都能改；收过钱的不能改到比已收还少", kw: "改 修改 改错 填错 错了 改金额 改客户 重开" },
  { n: "历史流水（每笔进出）", go: "stat:history", desc: "一天一天看收了多少、付了多少、花在哪", kw: "流水 明细 历史 每笔 台账 进出 收了哪些" },
  { n: "记一笔应收（接单）", go: "bill:ar", desc: "客户、产品、金额、成本、约定收款日", kw: "开单 接单 记账 应收 加工费 报价单" },
  { n: "收客户的钱", go: "bill:ar", desc: "点应收那一行「收款」，可以只收一部分", kw: "收款 收钱 到账 回款 结清" },
  { n: "记一笔应付（欠供应商）", go: "bill:ap", desc: "供应商、金额、备注、到期日", kw: "应付 欠款 供应商 赊购 进货" },
  { n: "付供应商的钱", go: "bill:ap", desc: "点应付那一行「付款」", kw: "付款 付钱 还钱 结清" },
  { n: "记一笔支出（工资/水电/房租）", go: "bill:expense", desc: "六类：工资水电网费房租采购辅料运费维修税金其他", kw: "支出 费用 花销 工资 水电 房租 加油 运费" },
  { n: "一句话记账", go: "home:home", desc: "首页顶上那个框，写「收张老板3000」「工资5000」", kw: "语音 一句话 快速 懒 不想点" },
  { n: "批量导入（Excel/模板）", go: "bill:import", desc: "下载模板填好，选文件直接导入", kw: "导入 excel 表格 模板 批量 一堆单子" },
  { n: "期初余额导入（开账）", go: "bill:import", desc: "接手前的旧账：客户欠我多少、我欠别人多少", kw: "期初 开账 旧账 一开始 建账" },
  { n: "和客户对账（对账单）", go: "stat:report", desc: "按客户出对账单，可存图片发微信、可打印 A4", kw: "对账 对账单 结账 核对 发对方" },
  { n: "批量对账单（每家一页）", go: "stat:report", desc: "一次导出所有客户/供应商的对账单", kw: "批量对账 所有客户 一起发" },
  { n: "对账差异补记", go: "bill:import", desc: "对方账面和我这边不一样，一键按差额补一张", kw: "差异 少记 漏记 补记 对不上" },
  { n: "催款清单（该催谁）", go: "stat:report", desc: "按「欠多久、平时多久付」排出先催谁，带话术", kw: "催款 要钱 催收 欠钱不还 讨债" },
  { n: "催款台账（催过几次）", go: "stat:report", desc: "记下每次催款、对方答应哪天付", kw: "催了几次 承诺 答应 跟进" },
  { n: "客户进度链接（发给他看）", go: "me:contact", desc: "生成一个链接，客户点开能看到做到哪一步", kw: "进度 工序 发客户 链接" },
  { n: "看谁欠最多 / 信用额度", go: "stat:report", desc: "欠款排行、最久未结、平均回款天数", kw: "欠款排行 谁欠 信用 额度 老赖" },
  { n: "毛利分析（按客户/产品）", go: "stat:report", desc: "哪个客户赚钱、哪个活白干", kw: "毛利 利润 赚多少 亏 白干 毛利率" },
  { n: "价格表 / 上次报价", go: "stat:report", desc: "同一客户同一产品以前报多少，录单时自动带出", kw: "报价 价格 上次多少 便宜了 涨价" },
  { n: "损失台账（亏的和少赚的）", go: "stat:report", desc: "坏账、毛利过低、被压价的单", kw: "亏了 少赚 坏账 被压价" },
  { n: "月度总账一页纸", go: "stat:report", desc: "三句人话说清这个月赚了多少、钱去哪了", kw: "月报 小结 一页纸 总结" },
  { n: "报表打印 / 导出 Excel", go: "stat:report", desc: "利润表、资产负债表、任意区间导出", kw: "打印 A4 导出 excel 报表 给会计" },
  { n: "月度结账（锁账）", go: "stat:report", desc: "结完这个月就不能再改，防止事后乱动", kw: "结账 锁账 月结 封账" },
  { n: "月底收尾清单", go: "stat:report", desc: "六步：录完单、对过账、差异清完、出小结、备份、结账", kw: "月底 收尾 清单 该做什么" },
  { n: "现金流预测（会不会缺钱）", go: "home:home", desc: "按到期日算未来 45 天手头钱够不够", kw: "缺钱 现金 预测 撑得住" },
  { n: "这周的钱够不够（要不要催一笔）", go: "home:home", desc: "账上现金 + 14 天内该收 − 该付，差多少、先催谁", kw: "够不够 付不出 周转 缺口 催一笔 现金流" },
  { n: "老客户是不是跑了", go: "stat:report", desc: "按这家自己多久下一单来比，超了就提醒，带问候话术", kw: "老客户 流失 很久没来 复购 问一句 留住客户" },
  { n: "打印加工单 / 送货单", go: "bill:ar", desc: "单张单据 A4 打印，客户签收签字带回", kw: "打印 加工单 送货单 签收 车间 带去客户" },
  { n: "净资产 / 家底曲线", go: "stat:asset", desc: "现金 + 别人欠我 − 我欠别人，每月存档", kw: "家底 净资产 存款 有多少钱 身家 总资产" },
  { n: "家底存档（留个底）", go: "stat:asset", desc: "每月末自动存一份，改老单据不影响历史", kw: "存档 快照 历史 曲线" },
  { n: "账龄 / 坏账准备", go: "stat:asset", desc: "欠了多久、分几档、该提多少坏账", kw: "账龄 欠多久 老账 坏账" },
  { n: "寿命/折旧（设备）", go: "stat:asset", desc: "设备按月计提折旧", kw: "折旧 设备 机器 固定资产" },
  { n: "待摊费用（房租一次交一年）", go: "stat:asset", desc: "钱一次出，成本按月摊", kw: "摊销 待摊 房租 一次交" },
  { n: "借款台账 / 利息", go: "stat:asset", desc: "借了多少钱、月息多少、该还多少", kw: "借款 贷款 利息 还本 贷款利息" },
  { n: "员工借支 / 报销", go: "bill:expense", desc: "员工先借后报，冲抵", kw: "借支 报销 垫付 员工借钱" },
  { n: "坏账核销（要不回来了）", go: "stat:report", desc: "这笔钱确定收不回来，抹掉往来不动现金", kw: "核销 坏账 要不回来 放弃" },
  { n: "预收 / 预付（定金）", go: "me:contact", desc: "客户先给的钱、先付给供应商的钱", kw: "预收 预付 定金 预付款" },
  { n: "账户与余额（现金/银行卡/微信）", go: "me:contact", desc: "期初余额、每个账户进出、余额", kw: "账户 现金 银行卡 微信 支付宝 余额" },
  { n: "账户之间转账", go: "me:contact", desc: "银行卡取现、微信转银行卡", kw: "转账 内部 取现 挪钱" },
  { n: "支出预算（别超）", go: "stat:report", desc: "给某类费用设月预算，快超了首页提醒", kw: "预算 控制 花超了" },
  { n: "账期设置（多少天付款）", go: "me:contact", desc: "按客户/供应商设账期，开单自动算到期日", kw: "账期 30天 月结 到期日" },
  { n: "单位档案（电话/地址）", go: "me:contact", desc: "联系人和电话，一键拨号", kw: "客户 供应商 电话 地址 联系" },
  { n: "发对账单留痕 / 对方回音", go: "me:contact", desc: "记下什么时候发的、对方有没有异议", kw: "回音 确认 有异议 争议" },
  { n: "发票台账 / 钱和票对一下", go: "stat:asset", desc: "开了多少票、收了多少钱、差在哪", kw: "发票 开票 税额 票钱对照" },
  { n: "银行流水导入与认领", go: "stat:asset", desc: "把银行流水粘进来，勾掉已记的", kw: "银行流水 对账 认领 未认领" },
  { n: "固定资产/家庭收支以外的资产", go: "stat:asset", desc: "设备清单", kw: "设备 资产 机器" },
  { n: "数据体检（哪里填得不对）", go: "stat:report", desc: "10 项检查打分：没填成本、没设账期、疑似重复…", kw: "体检 检查 打分 有问题" },
  { n: "运行日志（出错了）", go: "stat:report", desc: "服务器错误的原文，报问题时给我看", kw: "日志 错误 报错 500" },
  { n: "备份 / 回到某一天", go: "me:contact", desc: "每天自动备份，可以回到某一天", kw: "备份 恢复 还原 找回来" },
  { n: "回收站（删错了）", go: "me:contact", desc: "删掉的单据 30 天内能找回", kw: "删错 删除 删掉 找回 恢复 回收站 误删" },
  { n: "换手机 / 多人用", go: "me:contact", desc: "同一个口令登录就是同一本账", kw: "换手机 新手机 多台 一起用" },
  { n: "员工口令（只记账不能删）", go: "me:contact", desc: "员工看不到毛利、不能删改单据", kw: "员工 店员 家人 权限 口令" },
  { n: "账本健康分", go: "home:home", desc: "首页那个分数，点开看哪几项能改好", kw: "健康分 分数 体检" },
  { n: "我的活（今天该干什么）", go: "home:home", desc: "3 天内到期和逾期的收付款", kw: "今天做什么 待办 提醒" },
  { n: "全局搜索（找单据）", go: "home:home", desc: "首页底部搜客户名、金额、备注", kw: "搜索 查找 找单" },
  { n: "多账套（几本账）", go: "me:contact", desc: "一个口令下可以有多本账，互不串", kw: "账套 两个厂 分开记 另一本" },
  { n: "出事了怎么办（一页纸）", go: "home:home", desc: "首页「怎么用」，每天 30 秒、每周 5 分钟", kw: "怎么用 教程 新手 说明" },
  { n: "合并重名 / 单位改名", go: "me:contact", desc: "同一家被记成两个名字时，在「单位」页点 🔀 查重名", kw: "重名 合并 改名 名字 两个名字 对不上 重复 同一个客户" },
]

Page({
  data: {
    btp: null,
    ri: null, ri_type: 'ar_update', ri_b64: '',
    mat: null, mv: [], mv_open: '', mats_names: [], mt_name: '', mt_kind: 0, mt_qty: '', mt_price: '', mt_date: '', mt_note: '', mat_new: false, mat_unit: '个', mat_min: '',
    big: false,
    psv: null,
    fp: null, fr_party: '', fr_party_kw: '', fr_item: '', fr_price: '', fr_unit: '件', fr_note: '',
    os: null, os_party: '', os_item: '', os_qty: '', os_price: '', os_due: '',
    dp: null, dp_days: 7, wip: null, ot: null,
    rw_faults: ['自己做坏了', '材料有问题', '客户改了要求', '图纸 / 尺寸给错', '别的原因'],
    rwk: null, rwk_month: '', rw_kind: 'rework', rw_party: '', rw_item: '', rw_qty: '', rw_cost: '', rw_reason: '', rw_fix: '', rw_fault_idx: 0,
    pw: null, pw_month: '', pw_recs: [], pw_rates: null, pw_worker: '', pw_date: '', pw_item: '', pw_process: '', pw_qty: '', pw_rate: '',
    wd_open: false, wd_workers: '', wd_kind: '宿舍水电', wd_amount: '', wd_remark: '', wd_rows: [],
    wd_kinds: ['宿舍水电', '宿舍租金', '伙食', '罚款', '其他'],
    wr_worker: '', wr_item: '', wr_rate: '', wr_unit: '件',
    bank_layout: '', bank_skip: 0,
    bv: null,
    mg: null, mg_month: '',
    qt: null, qt_n: 0, qh: null, qt_party: '', qt_item: '', qt_cost: '', qt_margin: '', qt_qty: '', qt_price: '', qt_days: '',
    yrv: null, yrv_year: '',
    mg_open: false, mg_type: 'ar', mg_text: '', mg_date: '', mg_cost_mode: 'none', mg_margin: 30, mgp: null,
    tab: 'home', group: 'home',
    ar_total: 0, ap_total: 0,
    month_income: 0, month_outcome: 0, month_profit: 0, dash_err: '', net_bad: false,
    month_order_add: 0, month_payable_add: 0, profit_biz: 0,
    overdue_count: 0, overdue: [],
    due_soon_count: 0, due_soon: [], pay_soon_count: 0, pay_soon: [],
    ar_list: [], ap_list: [], expense_list: [],
    onboard: null,
    ob_open: false, ob_accs: [], ob_term: '30', ob_ar: '', ob_ap: '', ob_busy: false,
    ar_kw: '', ap_kw: '', ex_kw: '',
    rb_customer: '', rb_amount: '', rb_date: '',
    today_income: 0, top_customer: '', top_unpaid: 0,
    o_customer: '', o_item: '', o_price: '', o_cost: '', o_due: '', o_deliver: '', o_operator: '', o_date: '', o_ar_cat: '',
    ar_cats: ['货款', '加工费', '打样费', '模具费', '运费代垫', '包装代垫', '维修费', '其他'],
    mb_type: 'customer', mb_month: '', mb: null, ns: null,
    p_supplier: '', p_amount: '', p_remark: '', p_operator: '', p_due: '', p_date: '', p_category: '',
    ar_off: 0, ap_off: 0, ex_off: 0, ar_more: false, ap_more: false, ex_more: false, import_file_name: '',
    xp: null, xp_open: false,
    rcc: null, rcc_month: '',
    itd: null, itd_rate: 0.13,
    yb: null, yb_year: '',
    categories: ['工资', '水电', '房租', '采购', '辅料', '运费', '维修', '税金', '其他'],
    e_category: 0, e_amount: '', e_remark: '', e_operator: '', e_acc: 0, e_date: '',
    l_staff: '', l_amount: '', l_remark: '', loans: [], loan_staff: [], loan_open: 0,
    cur_loan: 0, cur_loan_name: '', rl_amount: '', rl_category: 0, rl_remark: '',
    cash_balance: 0, accounts: [], acc_names: [], acc_idx: 0, acc_id: 0, acc_name: '',
    // 收付款面板：金额 / 日期 / 账户 / 有票没票 / 税额 / 只记税金
    pay_open: false, pay_kind: 'ar', pay_id: 0, pay_title: '', pay_remain: 0,
    pay_amt: '', pay_date: '', pay_inv: '', pay_tax: '', pay_taxonly: false, pay_busy: false,
    pay_taxmode: false, pay_tax_extra: '', pay_extra_sug: 0,
    pay_invs: [{ k: 'yes', n: '有票' }, { k: 'no', n: '没票' }, { k: 'part', n: '部分开票' }],
    tax: null, tax_open: false, o_tax_kind: '', o_tax_rate: '', o_tax_hint: '', p_tax_kind: '', p_tax_rate: '', p_tax_hint: '',
    tr_from: -1, tr_to: -1, tr_amount: '', tr_remark: '', tr_rows: [],
    wf_rows: [], wf_bad: 0, wf_waived: 0,
    adv_in: [], adv_out: [], adv_type: 0, a_party: '', a_amount: '', a_remark: '',
    new_acc_name: '', new_acc_opening: '', new_cat_name: '', new_cat_type: 0,
    import_types: ['应收：客户,产品,金额', '应付：供应商,金额,备注', '支出：金额,分类,备注', '借支：员工,金额,备注', '报销：员工,金额,分类,备注', '期初应收：客户,金额', '期初应付：供应商,金额', '应收对账：客户,对账金额,月份', '应付对账：供应商,对账金额,分类,月份', '付房东：名称,金额,月数(0=押金),分类,起始日', '客户名单：名称,类型,联系人,电话'],
    role: 'owner', staff_enabled: false, demo: false, demo_enabled: false, demo_builtin: true,
    super: false, super_enabled: false, book_admin: false, book_own_key: false,
    key_open: false, key_input: '', key_mode: 'enter', key_err: '', cf: null, mw: null, md: null, sad: null, fund: null, help_open: false,
    er_open: false, er_kind: '', er_id: 0, er_title: '', er_item: '', er_amount: '', er_cost: '', er_due: '',
    er_operator: '', er_remark: '', er_cat: '', er_reason: '', er_orig: {}, er_list_open: false, ers: [], er_pending: 0,
    feat_all: FEATS, feat_kw: '', feat_hits: [], feat_open: false, feat_recent: [],
    mods: null, mod: {},
    tp_packs: [
      { p: 'open', n: '开账全套（新建账套一次装好）', d: '账户余额 · 默认账期 · 期初应收 · 期初应付 · 期初借支 · 期初借款' },
      { p: 'daily', n: '日常台账（多页一次传）', d: '应收对账 · 应付对账 · 支出 · 报销 · 借支 · 付房东' }
    ],
    pk_open: false, pk_title: '', pk_text: '', pk_sheets: [], pk_busy: false, pk_force: false,
    tpls: [
      { t: 'ar_recon', n: '应收对账（按客户对账金额）', d: '客户, 对账金额, 月份 —— 一个月一家一条' },
      { t: 'ap_recon', n: '应付对账（按供应商/外发）', d: '供应商, 对账金额, 分类, 月份 —— 外发选「外发加工费」' },
      { t: 'ar', n: '应收（按单）', d: '客户, 产品, 金额, 成本, 到期日' },
      { t: 'ap', n: '应付（按单）', d: '供应商, 分类, 金额, 备注, 到期日' },
      { t: 'prepaid', n: '付房东（租金/押金/水电）', d: '名称, 金额, 月数(0=押金), 分类, 起始日' },
      { t: 'recon', n: '对账（对方的余额）', d: '单位, 金额 —— 只核对不入账', recon: true },
      { t: 'reimb', n: '报销（员工报的）', d: '员工, 金额, 分类, 备注' },
      { t: 'expense', n: '支出（水电房租）', d: '金额, 分类, 备注' },
      { t: 'loan', n: '员工借支', d: '员工, 金额, 备注' },
      { t: 'ar_init', n: '期初应收（按对账金额）', d: '客户, 金额 —— 接手前的旧账' },
      { t: 'ap_init', n: '期初应付（按对账金额）', d: '供应商, 金额 —— 接手前欠别人的' },
      { t: 'parties', n: '客户名单（只建档案）', d: '名称, 类型, 联系人, 电话 —— 不建单、不动钱' }
    ],
    prepaids: [], prepaid_sum: {}, pp_name: '', pp_total: '', pp_months: '1', pp_cat: '厂房租金', pp_start: '',
    pp_cats: ['厂房租金', '宿舍租金', '水费', '电费', '押金', '其他'],
    month_amort: 0, month_accrue_int: 0, month_dep: 0, month_expense_cash: 0,
    debts: [], debt_sum: {}, credit_limits: [], d_lender: '', d_principal: '', d_rate: '6', d_start: '', d_term: '12', d_kind: 0, d_paykind: 0, d_remark: '',
    debt_kinds: ['银行贷款', '个人借款', '其他'], debt_paykinds: ['按月付息到期还本', '等额本息', '到期一次还本付息'], issue_count: 0, issue_at: '',
    amts: [50, 100, 200, 500, 1000, 2000],
    gl: null, gl_kw: '', gl_open: '', gl_cat: '',
    rec: null,
    rec_show: false, rec_code: '', rec_pw: '', rec_busy: false,
    ag: null, ag_tab: 'newphone', cc: null, ro: null, ro_month: '', dc: null, ar2: null,
    map_groups: [
      { title: '每天都用（1~3 分钟）', items: [
        { name: '记一笔应收', desc: '客户又给活了，顺手记上', go: 'bill:ar' },
        { name: '收钱', desc: '在应收那行点「收款」，可一次收清', go: 'bill:ar' },
        { name: '记一笔应付 / 支出', desc: '欠供应商的记应付，当场花的记支出', go: 'bill:ap' },
        { name: '今天要做什么', desc: '首页「我的活」：谁该付我、我该付谁', go: 'home' }
      ] },
      { title: '每周用一次（5 分钟）', items: [
        { name: '批量导入', desc: 'Excel 填模板 / 直接粘贴多行，先看预览再入账', go: 'bill:import' },
        { name: '对账核对', desc: '对方报的金额和我这边逐个比，差异可一键补记', go: 'bill:import' },
        { name: '催款清单', desc: '按该催的先后排好，带话术，可记「催了一次」', go: 'me:contact' },
        { name: '发对账单', desc: '单位页每家「发对账单」，图片 / 打印链接 / 记送达', go: 'me:contact' }
      ] },
      { title: '每月用一次（20 分钟）', items: [
        { name: '月底收尾', desc: '六步清单：录完单 → 对账 → 处理差异 → 小结 → 备份 → 结账', go: 'stat:report' },
        { name: '本月一页纸', desc: '三句话汇报 + 最大三件事，可发家人/合伙人', go: 'stat:report' },
        { name: '月度报表包', desc: '八张表打包成一个 Excel，可归档可发人', go: 'stat:report' },
        { name: '损失台账', desc: '这个月亏了多少、少赚了多少，是谁', go: 'stat:report' }
      ] },
      { title: '出事了 / 半年看一次', items: [
        { name: '利润去哪了', desc: '净利和现金变化对不上时，一笔笔解释清楚', go: 'stat:report' },
        { name: '数据体检 + 运行日志', desc: '健康分多少、哪里该补，出错记录在这', go: 'stat:report' },
        { name: '家底 / 账龄 / 借款', desc: '设备、发票、银行流水、借出去的钱', go: 'stat:asset' },
        { name: '全年 × 客户 / 年度汇总', desc: '这一年从谁那儿赚的、谁在拖钱', go: 'stat:report' },
        { name: '备份与恢复', desc: '整库备份、从备份恢复、回收站找回', go: 'me:contact' }
      ] }
    ],
    health: {}, health_done: false, err_shown: false, err_days: 7, err_count: 0, err_groups: [], err_rows: [],
    hc: null, hc_open: false, hr: null, hr_open: false, cb: null, cb_month: '', cb2: null, cb2_month: '', yc: null, yc_year: '', cr: null, lb: null, lb_month: '', ec: null, ec_month: '', mbr: null, ns_open: false, bck: null, mtip: null, sb: null, sb_month: '', me: null, dbk: null, pb: null, pa: null, pb_kw: '', price_tip: '', price_warn: '', price_last: 0, ic: null, ic_month: '', import_type: 0, import_text: '', import_preview: null, recon: null, recon_log: null, rec_prog: null, rec_dun: null, import_log: null, imp_docs: null, dbst: null, term_default: '0', pipe: null, pbal: null, pbal_type: 'ar',
    terms: [], terms_unset: [], term_party: '', term_days: '30', term_cycle: '30', term_day: '', rc: null, collect: null, cp: null, rb: null, rb_month: '', dr: null, dr_month: '', tg: null, tadv: null, term_auto: false,
    packs: [], fc: null, due: null, risk: null,
    import_hint: '每行一条，用逗号分隔，末尾可带日期（如 07-05）\n应收：客户,产品,金额\n应付：供应商,金额,备注\n支出：金额,分类,备注\n借支：员工,金额,备注\n报销：员工,金额,分类,备注\n期初应收：客户,金额（不带日期默认记年初）\n期初应付：供应商,金额（不带日期默认记年初）',
    report_year: '', report_text: '', chart: [],
    cmp_month: '', analysis_text: '', ex_month: '', ex_from: '', ex_to: '',
    pc_month: '', pc: null, rv_month: '', rv: null, ano: null, ys_year: '', ys: null,
    tgt: null, tgt_edit: false, tgt_receive: '', tgt_order: '', trend: null, ps: null, be: null,
    flows: null, flows_month: '', flows_kw: '', flows_dir: '', profile_edit: false, pf_party: '', pf_contact: '', pf_phone: '', pf_addr: '', pf_note: '', profiles: [],
    th: null, thTips: [], tw: null, tf: null,
    q_text: '',
  q_busy: false,
    history_type: 'ar', history_ar_list: [], history_ap_list: [], st: null, st_month: '', st_kw: '',
    contact_type: 'ar', contacts_ar: [], contacts_ap: [],
    sug_ar: [], sug_ap: [], sug_ex: [], last_tip: '',
    contact_show: false, contact_title: '', contact_text: '',
    trash_list: [],
    ar_filter: 'open', ar_sort: 'new', ar_sum: {}, ap_filter: 'open', ap_sort: 'new', ap_sum: {},
    // 应付的分类：硫酸、磷酸、硝酸、染料、除油剂、包装、报纸、外发加工费…（和后台 AP_CATS 一致）
    ap_cats: ['硫酸', '磷酸', '硝酸', '染料', '除油剂', '包装', '报纸', '外发加工费', '运费', '电费', '五金配件'],
    ap_cat: '', ap_cat_rows: [], ap_cat_text: '',
    ar_cat: '', ar_cat_rows: [], ar_cat_text: '',
    ar_view: 'order', ap_view: 'order', ar_groups: [], ap_groups: [], ar_open: '', ap_open: '',
    detail_show: false, detail_title: '', detail_head: '', detail_rows: [],
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
    lock_month: '', month_locks: [], archives: [], this_month: '',
    audit_logs: [],
    search_kw: '', search_res: null,
    phrases: [], phrase_kind: 0,
    budget_over: [], budget_alert_count: 0,
    budgets: [], b_category: 0, b_amount: '',
    pending_count: 0, ho: null, ho_open: false, ho_note: '',
    sealed: false, sealed_at: '', seal_note: '',
    offline_at: '',
    btl: null,
    book: 1, book_name: '主账套', books: [], rename_text: '',
    nw: [], nw_max: 1, nw_latest: null, nws: null, pdup: null, pm_from: '', pm_to: '',
    aging_type: 'ar', aging: null, wx_appid: '', wx_secret: '', wx_tpl: '', wx_fields: '', wx_info: null, wx_openid: '', wx_msg: '',
    kpi: null,
    mr_month: '', mr_text: '',
    head_title: '', head_note: '', head_phone: '', head_addr: '', head_bank: '', collect_min: '', dun_for: '', dun_log: null, dfx: null, dfx_text: '', dsum: null, dsum_text: '', dy: null, dy_year: '', st_log: null,
  },
  newCid() { return String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8) },
  // 金额解析：把「8,000」「8000元」「1.2万」都认成数字；认不出来返回 null。
  // 以前直接用 Number()：从微信聊天里复制「8,000」粘进来 → NaN → 后端归 0，
  // 于是她填了金额却收到「客户和金额必填」，或者成本静默变 0、毛利显示 100%。
  toAmount(v) {
    const raw = String(v === null || v === undefined ? '' : v).trim()
    if (!raw) return null
    const s2 = raw.replace(/[,，\s]/g, '').replace(/元|块|人民币|¥/g, '')
    const m = s2.match(/^(-?\d+(?:\.\d+)?)(万)?$/)
    if (!m) return null
    const n = Number(m[1]) * (m[2] ? 10000 : 1)
    if (!Number.isFinite(n)) return null
    return Math.round(n * 100) / 100
  },
  enqueueOp(op) {
    const q = wx.getStorageSync('pending_ops') || []
    op.data = op.data || {}
    if (!op.data.client_id) op.data.client_id = this.newCid()
    // uid 用来在补发时区分「这批里的」和「补发途中用户新记的」
    if (!op.uid) op.uid = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    op.ts = Date.now()
    q.push(op)
    wx.setStorageSync('pending_ops', q)
    this.setData({ pending_count: q.length })
  },
  // 联网后把存着的单子补发上去。
  // 判成功的标准是 2xx（且 body 不是 ok:false）。4xx（口令失效 401、已结账锁定 403、被规则驳回 400）
  // 说明服务端明确拒绝了：这条**留在队列里**并把原因告诉用户——以前一律算「补上了」然后清空队列，
  // 那几笔就永远消失了，界面还轻飘飘一句「补上了 2 笔」，她以为全补上了。
  //
  // 另外三个坑（都是这一轮补的）：
  //   1. 补发途中用户又记了一笔（网刚回来最容易发生），finish() 以前拿旧快照覆盖存储，新那笔被静默抹掉。
  //      现在按「快照长度之后新追加的」合并回去。
  //   2. 中途 401（口令过期 / 换了账套）：以前逐条试，每条都被标上「口令错误」。现在立刻停，
  //      当前这条及后面的原样留着（不标错），弹出登录卡，输完口令自动接着补。
  //   3. 200 但 body 里 ok:false（少数接口的失败形状）：以前算成功 → 这条就没了。现在按失败处理。
  flushPending(silent) {
    if (this._flushing) return
    const snap = wx.getStorageSync('pending_ops') || []
    if (!snap.length) { if (this.data.pending_count) this.setData({ pending_count: 0 }); return }
    this._flushing = true
    const ak = wx.getStorageSync('ak') || ''
    const bk = String(wx.getStorageSync('book') || 1)
    // slot 按原下标放「还没补上的」，这样失败的不会跑到队头、顺序不乱
    const slot = new Array(snap.length).fill(null)
    let done = 0
    let needKey = false
    const finish = () => {
      this._flushing = false
      const left = slot.filter(Boolean)
      // 补发期间新记的账（enqueueOp 追加在快照后面）不能丢
      const nowQ = wx.getStorageSync('pending_ops') || []
      const added = nowQ.length > snap.length ? nowQ.slice(snap.length) : []
      const keep = left.concat(added)
      wx.setStorageSync('pending_ops', keep)
      this.setData({ pending_count: keep.length })
      const bad = keep.filter((x) => x && x._err)
      if (done && !silent) wx.showToast({ title: '补上了 ' + done + ' 笔' + (bad.length ? '，' + bad.length + ' 笔没补上' : ''), icon: 'none' })
      if (needKey) {
        // 口令过期：直接弹登录卡，输完自动接着补（submitKey 里会再调一次 flushPending）
        this._askingKey = false
        this._keyQueue = []
        this._keyCtx = { done: () => { this._askingKey = false }, replayKey: () => {}, doReq: () => {} }
        this.setData({
          key_open: true, key_input: '', key_mode: 'enter',
          key_err: '口令过期了，重新输一下；剩下的 ' + keep.length + ' 笔会自动补发'
        })
        return
      }
      if (bad.length && !silent) {
        wx.showModal({
          title: '有 ' + bad.length + ' 笔没补上',
          content: bad.slice(0, 5).map((x) => '· ' + (x.label || '记账') + '：' + x._err).join('\n') +
            (bad.length > 5 ? '\n…共 ' + bad.length + ' 笔' : '') + '\n\n这些还留在「待补」里，改好再发一次。点顶上的「待补 N 笔」能看、能丢掉。',
          showCancel: false, confirmText: '知道了'
        })
      }
      if (done) this.refresh()
    }
    const step = (i) => {
      if (i >= snap.length) return finish()
      const it = snap[i]
      const body = it.data || {}
      wx.request({
        url: it.url, method: it.method || 'POST', data: body,
        header: { 'X-Access-Key': ak, 'X-Book': bk },
        success: (res) => {
          const code = res.statusCode
          if (code >= 200 && code < 300) {
            const d = res.data || {}
            if (d && d.ok === false) {
              // 200 但明确说没成（日期不对、参数不合规这类）
              slot[i] = Object.assign({}, it, { _err: String(d.error || '服务端说没记上').slice(0, 90) })
              step(i + 1)
              return
            }
            done++
            step(i + 1)
            return
          }
          if (code === 401) {
            // 口令过期 / 换手机 / 切了账套：别再一条条试（会把每条都标成「口令错误」）
            for (let k = i; k < snap.length; k++) slot[k] = snap[k]
            needKey = true
            return finish()
          }
          if (code >= 400 && code < 500) {
            const d = res.data || {}
            const msg = d.error || d.msg || ('被拒绝（' + code + '）')
            slot[i] = Object.assign({}, it, { _err: String(msg).slice(0, 90) })
            step(i + 1)
            return
          }
          // 5xx：服务器那边的事，当前及剩下的原样留着等下次；不能当成功
          for (let k = i; k < snap.length; k++) slot[k] = snap[k]
          finish()
        },
        fail: () => {
          for (let k = i; k < snap.length; k++) slot[k] = snap[k]
          finish()
        }
      })
    }
    step(0)
  },
  viewPending() {
    const q = wx.getStorageSync('pending_ops') || []
    if (!q.length) return wx.showToast({ title: '没有待补的记录', icon: 'none' })
    wx.showModal({
      title: '还有 ' + q.length + ' 笔没发出去',
      content: q.slice(0, 8).map((x) => '· ' + (x.label || '记账') + ' ' + ((x.data && (x.data.customer || x.data.supplier || x.data.remark || x.data.amount)) || '') + (x._err ? '（上次没补上：' + x._err + '）' : '')).join('\n') + '\n\n现在重发吗？',
      confirmText: '重发', cancelText: '先不发',
      success: (r) => {
        if (r.confirm) { this.flushPending(false); return }
        // 有些条永远补不上（参数错了、单子已经删了），得给个「丢掉」的口子，
        // 否则「待补」会一直挂着，用户每次点都看到同一句错。
        const one = q[0] || {}
        const what = one.label || '记账'
        wx.showModal({
          title: '最早那笔要不要丢掉？',
          content: '· ' + what + '\n\n丢掉就是彻底不要这笔了（不会记进账）。确定不该记的时候才丢。',
          confirmText: '丢掉这笔', cancelText: '留着',
          success: (r2) => {
            if (!r2.confirm) return
            const rest = (wx.getStorageSync('pending_ops') || []).slice(1)
            wx.setStorageSync('pending_ops', rest)
            this.setData({ pending_count: rest.length })
            wx.showToast({ title: '丢掉了，还剩 ' + rest.length + ' 笔', icon: 'none' })
          }
        })
      }
    })
  },
  req(opts) {
    // 兜底补域名：以前有 6 处写成 url: '/xxx'（少了 API_BASE +），wx.request 直接报「url 不合法」，
    // 对应功能（账户对账、使用向导、客户卡片、月对账单、对账单据、今天收工）在真机上一次都没成功过。
    if (opts && opts.url && !/^https?:\/\//.test(opts.url)) opts.url = API_BASE + opts.url
    // 写接口统一带一个 client_id：后端按它去重，网络超时重试也不会记两笔。
    // 同一个动作（once 名字相同）共用一个 id，所以「点两下」和「超时重发」都只算一次。
    if (opts.once && (opts.method || 'GET').toUpperCase() !== 'GET') {
      this._cid = this._cid || {}
      if (!this._cid[opts.once]) this._cid[opts.once] = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
      opts.data = Object.assign({ client_id: this._cid[opts.once] }, opts.data || {})
      const done0 = () => { if (this._cid) delete this._cid[opts.once] }
      setTimeout(done0, 30000)
    }
    const ak = wx.getStorageSync('ak') || ''
    // 一屏里的 GET 攒到一起发（弱网下 10 次往返 → 1 次），失败自动退回逐个发
    const method = (opts.method || 'GET').toUpperCase()
    const rel = opts.url && opts.url.indexOf(API_BASE) === 0 ? opts.url.slice(API_BASE.length) : ''
    opts.__rel = rel
    // 防连点：所有写操作都加一道。以前只有显式写了 once 的接口才有，于是「加员工 / 记支出 /
    // 加借款 / 存目标」这十几个保存按钮连点两下就记两笔、余额翻倍。
    // 键 = 方法 + 路径 + 主键/金额；改单和删单各算各的，不会互相挡。
    const guard = opts.once || (method !== 'GET'
      ? method + '|' + rel + '|' + String((opts.data && (opts.data.id || opts.data.amount || opts.data.price || '')) || '')
      : '')
    if (guard) {
      this._once = this._once || {}
      if (this._once[guard]) return
      this._once[guard] = true
      const tag = guard
      const relF = () => { if (this._once) delete this._once[tag] }
      setTimeout(relF, 8000)
      const s0 = opts.success, f0 = opts.fail, c0 = opts.complete
      opts = Object.assign({}, opts, {
        success: (res) => { relF(); s0 && s0(res) },
        fail: (res) => { relF(); f0 && f0(res) },
        complete: (res) => { relF(); c0 && c0(res) }
      })
    }
    // 同一个 GET 还在路上时，不再发第二遍：切页签回来、enterTab 和 refresh 撞在一起时，
    // 同一条路径经常被要两次（回来的数据一模一样）。后到的挂到前一个上，数据回来一起回调。
    // opts.fresh === true 表示「我就要一次新的」（比如用户点了刷新），那种照发。
    if (method === 'GET' && rel && opts.fresh !== true) {
      this._flight = this._flight || {}
      const cur = this._flight[rel]
      if (cur) { cur.push({ success: opts.success, fail: opts.fail }); return }
      this._flight[rel] = []
      const pS = opts.success, pF = opts.fail
      const drain = (arr, res, isFail) => {
        arr.forEach((w) => { try { (isFail ? w.fail : w.success) && (isFail ? w.fail(res) : w.success(res)) } catch (e) {} })
      }
      opts = Object.assign({}, opts, {
        success: (res) => {
          const waits = (this._flight && this._flight[rel]) || []
          if (this._flight) delete this._flight[rel]
          try { pS && pS(res) } finally { drain(waits, res, false) }
        },
        fail: (err) => {
          const waits = (this._flight && this._flight[rel]) || []
          if (this._flight) delete this._flight[rel]
          try { pF && pF(err) } finally { drain(waits, err, true) }
        }
      })
      // 兜底：万一某个分支既没回调成功也没回调失败（比如标了 queue 走离线入队），
      // 20 秒后把这个占位清掉，别让后来的请求永远挂在它身上。
      const key0 = rel
      setTimeout(() => {
        if (!this._flight || !this._flight[key0]) return
        const stuck = this._flight[key0]
        delete this._flight[key0]
        // 20 秒还没回来（比如口令弹窗里被取消了），把挂在后面的当成失败放掉，
        // 不能让它们永远等在那里（会表现为「这一屏一直转圈」）。
        drain(stuck, { statusCode: 0, timeout: true }, true)
      }, 20000)
    }
    const canBatch = method === 'GET' && rel && opts.batch !== false && !/^\/(batch|auth|track|statement-print|report-print|export|import-template|backup|restore)/.test(rel)
    if (canBatch) {
      this._bq = this._bq || []
      this._bq.push({ path: rel, opts })
      if (!this._bt) this._bt = setTimeout(() => this._batchFlush(), 0)
      return
    }
    this._send(opts, ak)
  },
  // ── 断网看账：把最近一次的取数结果存在手机上 ──
  _cacheKey(rel) {
    const bk = String(wx.getStorageSync('book') || 1)
    return 'c_' + bk + '_' + rel
  },
  _cachePut(rel, data) {
    if (!rel) return
    // 报错响应不能进缓存：否则断网时把「口令错误 / 接口报错」当成上次的数据渲染出来。
    if (data && (data.error || data.ok === false || data.code === 'bad_key' || data.code === 'no_key')) return
    let str = ''
    try { str = JSON.stringify(data) } catch (e) { return }
    if (!str || str.length > 80000) return   // 大响应（导出之类）不占手机空间
    try { wx.setStorage({ key: this._cacheKey(rel), data: { t: Date.now(), d: data } }) } catch (e) {}
  },
  // maxAge 默认 7 天：离线兜底本来就允许看旧数据（顶部会显示「X 前的数据」），
  // 但太旧的（跨了账期）就别拿了，免得把上个月的快照当成这个月的。
  _cacheGet(rel, maxAge) {
    if (!rel) return null
    const cap = maxAge == null ? 7 * 86400000 : maxAge
    try {
      const v = wx.getStorageSync(this._cacheKey(rel))
      if (v && v.d !== undefined && v.d !== null && (cap <= 0 || Date.now() - Number(v.t || 0) <= cap)) return v
    } catch (e) {}
    return null
  },
  _agoText(ts) {
    const m = Math.max(0, Math.round((Date.now() - Number(ts || 0)) / 60000))
    if (m < 1) return '刚刚'
    if (m < 60) return m + ' 分钟前'
    const h = Math.round(m / 60)
    if (h < 24) return h + ' 小时前'
    return Math.round(h / 24) + ' 天前'
  },
  // 真正发请求（含 401 索赔口令、断网入队等处理）
  // 静默失败的兜底：以前 loadSeal / loadAttach / loadAdvances 这些失败就是「空着」，
  // 弱网下看到的是「没有提醒 / 没有照片 / 没有预收」，分不清是真没有还是没拉到。
  // 这里只统计「连续挂了两次」才亮一行，单次抖动不打扰。
  _noteFail() {
    this._failStreak = (this._failStreak || 0) + 1
    if (this._failStreak >= 2 && !this.data.net_bad) this.setData({ net_bad: true })
  },
  retryAll() {
    this._failStreak = 0
    this.setData({ net_bad: false })
    this.refresh()
  },
  _send(opts, key) {
    this.__doReq(opts, key)
  },
  __doReq(opts, key) {
    const bk = String(wx.getStorageSync('book') || 1)
    const ak = key
    const rel = opts.__rel || ''
    const isGet = (opts.method || 'GET').toUpperCase() === 'GET'
    const useCache = isGet && rel && opts.cache !== false
    const doReq = (k) => {
      wx.request(Object.assign({}, opts, {
        // 断网时不丢单：标了 queue 的动作先存到手机上，联网后自动补发（后端按 client_id 去重，不会记两遍）
        fail: (err) => {
          if (opts.queue) {
            this.enqueueOp({ url: opts.url, method: opts.method || 'POST', data: Object.assign({}, opts.data), label: opts.queue })
            wx.showModal({ title: '网络不好', content: '这笔记到手机上了，联网后会自动补上（不用重新录）', showCancel: false, confirmText: '知道了' })
            opts.queued && opts.queued()
            return
          }
          if (useCache) {
            const hit = this._cacheGet(rel)
            if (hit) {
              if (!this._offShown) { this._offShown = true; this.setData({ offline_at: this._agoText(hit.t) }) }
              opts.success && opts.success({ data: hit.d, statusCode: 200, fromCache: true })
              return
            }
          }
          if (!opts.silent) wx.showToast({ title: '网络不好，稍后再试', icon: 'none' })
          this._noteFail()
          opts.fail && opts.fail(err)
        },
        header: Object.assign({ 'X-Access-Key': key, 'X-Book': bk }, (function () {
          try {
            const sn = String(wx.getStorageSync('staff_name') || '').trim()
            return sn ? { 'X-Staff-Name': encodeURIComponent(sn) } : {}
          } catch (e) { return {} }
        })(), opts.header),
        success: (res) => {
          if (res.statusCode === 401) {
            // 首屏一屏就发 18+13 个请求，全部 401。以前这里直接 return，等于把除第一个以外的请求全丢了，
            // 用户输完口令看到一屏空白（还没有下拉刷新，只能杀进程重进）。现在排队，拿到口令后原样重放。
            if (this._askingKey) { (this._keyQueue = this._keyQueue || []).push(opts); return }
            this._askingKey = true
            this._keyQueue = []
            const code = res.data && res.data.code
            const done = () => { this._askingKey = false }
            const replayKey = (k) => {
              const q = this._keyQueue || []
              this._keyQueue = []
              q.forEach((o) => { try { this._send(o, k) } catch (e) { /* 单个失败不影响别的 */ } })
            }
            // 以前这里弹 wx.showModal，只有一个输入框——小白不知道「口令」是什么，
            // 微信审核员也不知道，3.3「登录受限」就是这么被驳回的。现在改成站内一张卡片：
            // 输口令 / 先看看演示（内置示例账套，不用口令、不碰真账）/ 忘了口令用恢复码。
            this._keyCtx = { done, replayKey, doReq }
            const why = code === 'bad_key'
              ? (String((res.data && res.data.error) || '口令不对') + ((res.data && res.data.left) ? '，还能试 ' + res.data.left + ' 次' : ''))
              : ''
            this.setData({ key_open: true, key_input: '', key_err: why, key_mode: code === 'no_key' ? 'set' : 'enter' })
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
            if (d.code === 'sealed') {
              wx.showModal({
                title: '这本账已封存', content: d.error, confirmText: '去解封', cancelText: '知道了',
                success: (r4) => { if (r4.confirm) this.enterTab('me') }
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
          if (useCache) this._cachePut(rel, res.data)
          if (this._offShown) { this._offShown = false; this.setData({ offline_at: '' }) }
          this._failStreak = 0
          if (this.data.net_bad) this.setData({ net_bad: false })
          opts.success && opts.success(res)
        }
      }))
    }
    doReq(ak)
  },
  _batchFlush() {
    this._bt = null
    const raw = this._bq || []
    this._bq = []
    if (!raw.length) return
    // 同一条路径只发一次：refresh() 一次调 18 个 loader，再加 enterTab 当前那一屏，
    // 有 3 条路径被重复请求（同样的 URL 发两遍，回来的数据一模一样）。
    // 后到的挂到先到的那一条上，数据回来时一起回调——少几个请求，界面行为不变。
    const byPath = {}
    const q = []
    for (const it of raw) {
      const hit = byPath[it.path]
      if (!hit) { byPath[it.path] = it; q.push(it); continue }
      const prev = hit.opts.success
      const add = it.opts.success
      hit.opts.success = (res) => {
        try { prev && prev(res) } catch (e) {}
        try { add && add(res) } catch (e) {}
      }
      if (it.opts.cache !== false) hit.wantCache = true
    }
    // 一次 /batch 最多带 16 条（后端上限 24，但老版本后端是 16；这边按 16 分组，两边新旧都不会错）。
    // 为什么要分组：首屏 refresh() 一进来就是 18 条 GET，攒成一个 tick 后超了 16 → 后端截断成 16 条、
    // 这边发现「回来的条数对不上」就整批作废退回逐个发 —— 等于白跑一轮 16 次查询再发 18 个请求。
    // 分组之后 18 条 = 16 + 2 两批，全都走批量，一次都不浪费。
    const CHUNK = 16
    if (q.length > CHUNK) {
      for (let i = 0; i < q.length; i += CHUNK) this._batchSend(q.slice(i, i + CHUNK))
      return
    }
    this._batchSend(q)
  },
  _batchSend(q) {
    if (!q || !q.length) return
    const ak = wx.getStorageSync('ak') || ''
    const bk = String(wx.getStorageSync('book') || 1)
    const fallback = () => q.forEach((it) => this._send(it.opts, ak))
    wx.request({
      url: API_BASE + '/batch',
      method: 'POST',
      header: { 'X-Access-Key': ak, 'X-Book': bk, 'Content-Type': 'application/json' },
      data: { qs: q.map((it) => it.path) },
      success: (res) => {
        const d = res.data || {}
        if (res.statusCode !== 200 || !d.ok || !Array.isArray(d.results) || d.results.length !== q.length) return fallback()
        // 口令不对时退回逐个发，好让原来的「输口令」弹窗照旧出现
        if (d.results.some((x) => x && (x.code === 'no_key' || x.code === 'bad_key'))) return fallback()
        d.results.forEach((val, i) => {
          const o = q[i].opts
          // 合批前 caller 明确说了 cache:false（动态数据），这里也要遵守，不能无脑缓存。
          if ((o.cache !== false || q[i].wantCache) && !(o.method && o.method.toUpperCase() !== 'GET')) this._cachePut(q[i].path, val)
          o.success && o.success({ data: val, statusCode: 200 })
          // 以前合批成功不调 complete：分页的 _pagBusy 只能靠 complete 复位，
          // 于是「加载更多」第二次就没反应了（要退出重进）。成功也要走 complete。
          o.complete && o.complete({ data: val, statusCode: 200 })
        })
        if (this._offShown) { this._offShown = false; this.setData({ offline_at: '' }) }
      },
      fail: () => {
        // 断网：能拿手机里上次数据的就先顶上，拿不到的再逐个发（逐个发里也会兜一次缓存）
        const misses = []
        q.forEach((it) => {
          const hit = it.opts.cache === false ? null : this._cacheGet(it.path)
          if (!hit) return misses.push(it)
          if (!this._offShown) { this._offShown = true; this.setData({ offline_at: this._agoText(hit.t) }) }
          it.opts.success && it.opts.success({ data: hit.d, statusCode: 200, fromCache: true })
        })
        if (misses.length) misses.forEach((it) => this._send(it.opts, ak))
      }
    })
  },

  onShow() {
    // 大字号模式：老板年纪大看着费劲时用（设置里开关，存本机）
    const bigOn = wx.getStorageSync('big_font') === '1'
    if (bigOn !== !!this.data.big) this.setData({ big: bigOn })
    // 第一次进来沿用上次选的含税口径（报价忽含忽不含，记住上次的少点一下；随时能点别的）
    if (!this._taxInit) {
      this._taxInit = true
      const ka = wx.getStorageSync('tax_kind_ar')
      const kp = wx.getStorageSync('tax_kind_ap')
      const d = {}
      if (ka === '含税' || ka === '不含税') d.o_tax_kind = ka
      if (kp === '含税' || kp === '不含税') d.p_tax_kind = kp
      if (Object.keys(d).length) this.setData(d)
    }
    // 第一次进来沿用上次记支出用的分类，少点一次
    if (!this._catInit) {
      this._catInit = true
      const lc = wx.getStorageSync('last_cat')
      if (lc !== '' && lc !== null && lc !== undefined) this.setData({ e_category: Number(lc) })
    }
    this.setData({ pending_count: (wx.getStorageSync('pending_ops') || []).length })
    this.flushPending(true)
    if (!this._modsLoaded) { this._modsLoaded = true; this.loadModules() }
    // 刚离开又马上回来（切到微信看消息、点开又退回）不必整轮重拉：
    // 20 秒内回来只刷第一屏，省掉第二波那 11 个跟这笔账无关的请求。
    const nowMs = Date.now()
    const gap = nowMs - (this._shownAt || 0)
    this._shownAt = nowMs
    this.refresh(gap > 0 && gap < 20000 ? { lite: true } : undefined)
    this.loadCloudBackupLazy()
  },
  // opts.lite === true：记完一笔账之后用。写完只需要把「数字 + 当前这一屏」刷新回来，
  // 体检分数、目标、在制、资金预测、账本、分类这些跟这笔账无关，晚一点或下次进来再拉。
  // 一次记账原来要连带 21 个请求，lite 之后是 11 个。
  refresh(opts) {
    const lite = !!(opts && opts.lite)
    // 第一波：首屏第一眼要看的（首页那几个数字、提醒、我的今天、下一步、应收应付汇总）
    this.loadDashboard()
    this.loadReminders()
    this.loadMe()
    this.loadAccounts()
    this.loadOnboard()
    this.loadNextStep()
    // 当前这一屏自己的数据（切到哪一页就拉哪一页；首页那几张单子由 enterTab 一起带出来）
    this.enterTab(this.data.tab)
    // 第二波：晚 150 毫秒再拉，跟第一眼无关的那些
    //   体检分数、目标、在制、预收预付、资金预测、现金流、账本、分类、账期、我的活、本月提示
    //   原来这 11 个跟第一波一起发，首屏要等 20 多个请求全回来才算完（真机 onShow 900 多毫秒）；
    //   拆成两波之后第一波只有十来个，首屏先出来，剩下的自己补上。
    if (lite) return
    clearTimeout(this._slowT)
    this._slowT = setTimeout(() => {
      this.loadHealth()
      this.loadTarget()
      this.loadPipeline()
      this.loadFunding()
      this.loadCashForecast()
      this.loadCashflow()
      this.loadBooks()
      this.loadCategories()
      this.loadTermDefault()
      this.loadMyWork()
      this.loadMonthTip()
    }, 150)
  },
  // 备份时间这条跟首屏无关，而且不会天天变：5 分钟内只问一次，别每次切页面都打一遍
  loadCloudBackupLazy() {
    const t = Date.now()
    if (this._cbAt && t - this._cbAt < 300000) return
    this._cbAt = t
    this.loadCloudBackup()
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
  // 账期 / 对账周期
  loadPartyTerms() {
    this.req({
      url: API_BASE + '/party-terms',
      success: (res) => {
        const d = res.data || {}
        const rows = (d.rows || []).map((r) => Object.assign({}, r, {
          kind_text: r.kind === 'ap' ? '应付' : '应收',
          term_text: r.term_days > 0 ? '月结 ' + r.term_days + ' 天' : '没设账期',
          cycle_text: r.recon_cycle > 0 ? '每 ' + r.recon_cycle + ' 天对一次账' : '不对账',
          due_text: r.recon_due ? '该对账了' : (r.last_recon ? '对过 ' + r.recon_times + ' 次' : '没对过')
        }))
        this.setData({ terms: rows, terms_unset: d.unset || [] })
      }
    })
  },

  loadTermGap() {
    this.req({
      url: API_BASE + '/term-gap',
      success: (res) => { const d = res.data || {}; if (d.ok) this.setData({ tg: d }) }
    })
  },
  closeTermGap() { this.setData({ tg: null }) },
  loadTermAdvice() {
    this.req({
      url: API_BASE + '/term-advice?type=ar',
      success: (res) => {
        const d = res.data || {}
        if (d.ok) this.setData({ tadv: d, term_auto: !!d.auto })
      }
    })
  },
  closeTermAdvice() { this.setData({ tadv: null }) },
  toggleTermAuto() {
    const on = !this.data.term_auto
    this.req({
      url: API_BASE + '/term-auto', method: 'POST', data: { on },
      success: (r) => {
        const x = r.data || {}
        if (!x.ok) return
        this.setData({ term_auto: !!x.on })
        wx.showToast({ title: x.on ? '已开启' : '已关闭', icon: 'none' })
        wx.showModal({ title: x.on ? '信用账期已开启' : '信用账期已关闭', content: x.text || '', showCancel: false })
        this.loadTermAdvice()
      }
    })
  },
  applyTermAdvice(e) {
    const mode = (e && e.currentTarget && e.currentTarget.dataset.mode) || 'tighten'
    const d = this.data.tadv
    if (!d) return
    const n = mode === 'all' ? (d.counts.tighten + d.counts.loosen + d.counts.set) : d.counts.tighten
    if (!n) return wx.showToast({ title: mode === 'all' ? '没有要调的' : '没有该收紧的', icon: 'none' })
    wx.showModal({
      title: mode === 'all' ? '按信用调 ' + n + ' 家账期' : '收紧 ' + n + ' 家账期',
      content: (mode === 'all'
        ? '信用好的放宽、差的收紧、没设的补上，按建议天数写进账期表。'
        : '只收紧给得太宽的那几家，不动其他。') + '\n新单以后就按新账期算到期日；已经开出去的单到期日不变。',
      confirmText: '改',
      success: (m) => {
        if (!m.confirm) return
        this.req({
          url: API_BASE + '/term-advice/apply', method: 'POST', data: { type: 'ar', mode },
          success: (r) => {
            const x = r.data || {}
            if (!x.ok) return
            wx.showModal({ title: '调好了', content: x.text || '', showCancel: false })
            this.loadTermAdvice(); this.loadPartyTerms(); this.loadTermGap(); this.refresh()
          }
        })
      }
    })
  },
  applyTermGap() {
    const d = this.data.tg
    if (!d || !d.count) return
    const days = Math.max(1, Math.min(180, Math.round(Number(d.default_term) || 30)))
    wx.showModal({
      title: '给 ' + d.count + ' 家补账期',
      content: '统一按 ' + days + ' 天账期设置，并顺手把还没到期日的未结单补上到期日。',
      confirmText: '一键补上',
      success: (m) => {
        if (!m.confirm) return
        this.req({
          url: API_BASE + '/term-gap/apply', method: 'POST', data: { term_days: days },
          success: (r) => {
            const x = r.data || {}
            if (x.error) return wx.showToast({ title: x.error, icon: 'none' })
            wx.showToast({ title: '设了 ' + (x.updated || 0) + ' 家、补 ' + (x.filled || 0) + ' 个到期日', icon: 'none' })
            this.loadTermGap(); this.loadPartyTerms(); this.refresh()
          }
        })
      }
    })
  },
  onTermParty(e) { this.setData({ term_party: e.detail.value }) },
  onTermDays(e) { this.setData({ term_days: e.detail.value }) },
  onTermCycle(e) { this.setData({ term_cycle: e.detail.value }) },
  onTermDay(e) { this.setData({ term_day: e.detail.value }) },
  loadReconCal() {
    this.req({
      url: API_BASE + '/recon-calendar',
      success: (res) => {
        const d = res.data || {}
        if (!d.ok) return wx.showToast({ title: d.error || '没取到', icon: 'none' })
        this.setData({ rc: d })
      }
    })
  },
  closeReconCal() { this.setData({ rc: null }) },
  onTermDefault(e) { this.setData({ term_default: e.detail.value }) },
  loadTermDefault() {
    this.req({
      url: API_BASE + '/term-default',
      success: (res) => { const d = res.data || {}; this.setData({ term_default: String(d.days || 0) }) }
    })
  },
  saveTermDefault() {
    const days = Math.max(0, Math.min(180, Math.round(Number(this.data.term_default) || 0)))
    const body = { days }
    const go = () => this.req({
      url: API_BASE + '/term-default', method: 'POST', data: body,
      success: (res) => {
        const d = res.data || {}
        if (d.error) { wx.showToast({ title: d.error, icon: 'none' }); return }
        wx.showToast({ title: days ? '默认账期 ' + days + ' 天' : '已关闭默认账期', icon: 'none' })
        this.setData({ term_default: String(days) })
        this.refresh()
      }
    })
    if (!days) return go()
    wx.showModal({
      title: '默认账期 ' + days + ' 天',
      content: '以后新单没写到期日就按「单据日期 + ' + days + ' 天」算。要不要顺手把现在还没到期日的未结单也补上？',
      confirmText: '都补上', cancelText: '只存设置',
      success: (m) => {
        body.fill = !!m.confirm
        go()
      }
    })
  },
  saveTerm() {
    const party = (this.data.term_party || '').trim()
    if (!party) return wx.showToast({ title: '填单位名', icon: 'none' })
    this.req({
      url: API_BASE + '/party-terms', method: 'POST',
      data: { party, term_days: Number(this.data.term_days) || 0, recon_cycle: Number(this.data.term_cycle) || 0, recon_day: Number(this.data.term_day) || 0 },
      success: (res) => {
        if (res.data && res.data.error) return wx.showToast({ title: res.data.error, icon: 'none' })
        wx.showToast({ title: '存好了', icon: 'none' })
        this.setData({ term_party: '' })
        this.loadPartyTerms()
      }
    })
  },
  pickUnsetParty(e) { this.setData({ term_party: this.data.terms_unset[e.currentTarget.dataset.i].party }) },
  editTerm(e) {
    const t = this.data.terms[e.currentTarget.dataset.i]
    this.setData({ term_party: t.party, term_days: String(t.term_days || ''), term_cycle: String(t.recon_cycle || ''), term_day: String(t.recon_day || '') })
  },
  delTerm(e) {
    const t = this.data.terms[e.currentTarget.dataset.i]
    wx.showModal({
      title: '删掉 ' + t.party + ' 的账期？', content: '只删账期设置，不动单据。',
      success: (m) => { if (m.confirm) this.req({ url: API_BASE + '/party-terms/' + t.id, method: 'DELETE', success: () => this.loadPartyTerms() }) }
    })
  },
  applyTerm(e) {
    const t = this.data.terms[e.currentTarget.dataset.i]
    this.req({
      url: API_BASE + '/party-terms/apply', method: 'POST', data: { party: t.party },
      success: (res) => {
        const d = res.data || {}
        if (d.error) return wx.showToast({ title: d.error, icon: 'none' })
        wx.showToast({ title: '给 ' + (d.updated || 0) + ' 张单补了到期日', icon: 'none' })
        this.refresh(); this.loadPartyTerms()
      }
    })
  },
  // 催款清单：按「欠得久 × 欠得多」排，话术现成
  openCollect(e) {
    const type = (e && e.currentTarget && e.currentTarget.dataset.type) || 'ar'
    this.req({
      url: API_BASE + '/collect-list?type=' + type,
      success: (res) => {
        const d = res.data || {}
        if (!d.count) return wx.showToast({ title: '没有未结的款', icon: 'none' })
        this.setData({ collect: Object.assign({}, d, { type_text: d.type === 'ap' ? '要付' : '要收' }) })
        wx.pageScrollTo({ scrollTop: 0, duration: 200 })
      }
    })
  },
  copyCollectOne(e) {
    const x = ((this.data.collect && this.data.collect.list) || [])[e.currentTarget.dataset.i]
    if (x) wx.setClipboardData({ data: x.text })
  },
  copyCollectAll() {
    const c = this.data.collect
    if (!c) return
    const head = (c.type === 'ap' ? '【要付清单】共 ' : '【催款清单】共 ') + c.total + ' 元，' + c.count + ' 家\n\n'
    wx.setClipboardData({ data: head + (c.list || []).map((x) => x.no + '. ' + x.text).join('\n\n') })
  },
  // 催款清单存成图片：可直接用微信「发给对方」
  makeCollectImage(e) {
    const c = this.data.collect
    if (!c || !c.list || !c.list.length) return wx.showToast({ title: '先点催款清单', icon: 'none' })
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const i = ds.i !== undefined ? Number(ds.i) : -1
    if (i >= 0) {
      const x = c.list[i]
      if (!x) return
      return this.drawStatementImage({ text: (c.type === 'ap' ? '【付款提醒】\n' : '【收款提醒】\n') + x.text }, true)
    }
    const head = c.type === 'ap' ? '【我这边要付的】' : '【还欠我钱的】'
    const lines = [head + ' 共 ' + c.count + ' 家 · ' + c.total + ' 元', '']
    c.list.forEach((x) => lines.push(x.no + '. ' + x.party + '  ' + x.left + ' 元（' + x.cnt + ' 笔，最久 ' + x.oldest_days + ' 天）'))
    lines.push('', '点哪家可以单独复制话术发过去。')
    this.drawStatementImage({ text: lines.join('\n') }, true)
  },
  // 到期表：哪张单哪天到期
  onQtParty(e) { this.setData({ qt_party: e.detail.value }) },
  onQtItem(e) { this.setData({ qt_item: e.detail.value }) },
  onQtCost(e) { this.setData({ qt_cost: e.detail.value }) },
  onQtMargin(e) { this.setData({ qt_margin: e.detail.value }) },
  onQtQty(e) { this.setData({ qt_qty: e.detail.value }) },
  onQtPrice(e) { this.setData({ qt_price: e.detail.value }) },
  onQtDays(e) { this.setData({ qt_days: e.detail.value }) },
  // 报多少合适：按成本+想赚的毛利算，再对照这家以前给过什么价
  quoteHint() {
    const party = String(this.data.qt_party || '').trim()
    const cost = Number(this.data.qt_cost) || 0
    if (!party) return wx.showToast({ title: '先填报给谁', icon: 'none' })
    if (!cost) return wx.showToast({ title: '填一下成本，才好算价', icon: 'none' })
    this.req({
      url: API_BASE + '/quote-hint?party=' + encodeURIComponent(party) + '&item=' + encodeURIComponent(this.data.qt_item || '') + '&cost=' + cost + '&margin=' + (Number(this.data.qt_margin) || 15),
      success: (res) => {
        const d = res.data || {}
        if (!d.ok) return wx.showToast({ title: d.error || '算不出来', icon: 'none' })
        this.setData({ qh: d })
        if (!this.toAmount(this.data.qt_price)) {
          const t = (d.tiers || []).filter((x) => x.k === 'target')[0]
          if (t) this.setData({ qt_price: String(t.price) })
        }
      },
      fail: () => wx.showToast({ title: '算不出来，下拉刷新再试', icon: 'none' })
    })
  },
  pickTier(e) {
    const p = e.currentTarget.dataset.p
    if (p) this.setData({ qt_price: String(p) })
  },
  saveQuote() {
    const party = String(this.data.qt_party || '').trim()
    if (!party) return wx.showToast({ title: '先填报给谁', icon: 'none' })
    const body = {
      party: party, item: this.data.qt_item || '', qty: Number(this.data.qt_qty) || 1,
      cost: this.toAmount(this.data.qt_cost) || 0, price: this.toAmount(this.data.qt_price) || 0,
      margin: Number(this.data.qt_margin) || 15, valid_days: Number(this.data.qt_days) || 15
    }
    if (!body.price && !body.cost) return wx.showToast({ title: '单价和成本至少填一个', icon: 'none' })
    this.req({
      url: API_BASE + '/quotes', method: 'POST', data: body,
      success: (res) => {
        const d = res.data || {}
        if (d.error) return wx.showToast({ title: d.error, icon: 'none' })
        wx.showToast({ title: '报价单 ' + (d.no || '') + ' 存好了', icon: 'none' })
        this.setData({ qt_price: '' })
        this.loadQuotes()
      },
      fail: () => wx.showToast({ title: '没存上，再点一次', icon: 'none' })
    })
  },
  loadQuotes() {
    this.req({
      url: API_BASE + '/quotes',
      success: (res) => {
        const d = res.data || {}
        if (d.error) return wx.showToast({ title: d.error, icon: 'none' })
        this.setData({ qt: d, qt_n: d.count || 0 })
      },
      fail: () => wx.showToast({ title: '拿不到报价单', icon: 'none' })
    })
  },
  sendQuote(e) {
    const id = e.currentTarget.dataset.id
    this.req({
      url: API_BASE + '/quotes/' + id + '/send', method: 'POST', data: {},
      success: (res) => {
        const d = res.data || {}
        if (d.error) return wx.showToast({ title: d.error, icon: 'none' })
        wx.setClipboardData({
          data: d.text || '',
          success: () => wx.showModal({
            title: '话术已复制',
            content: '粘到微信发给对方就行。里面那个链接他点开就能看报价、直接点「可以」，你这边会自动变成「客户接受了」。',
            showCancel: false
          })
        })
        this.loadQuotes()
      },
      fail: () => wx.showToast({ title: '发不出去，再点一次', icon: 'none' })
    })
  },
  quoteToOrder(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '转成应收单？',
      content: '会按报价的金额、成本建一张单子，到期日按这家的账期算。',
      success: (r) => {
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/quotes/' + id + '/to-order', method: 'POST', data: {},
          success: (res) => {
            const d = res.data || {}
            if (d.error) return wx.showToast({ title: d.error, icon: 'none' })
            wx.showToast({ title: '已转成单子 ¥' + d.amount, icon: 'none' })
            this.loadQuotes(); this.refresh()
          },
          fail: () => wx.showToast({ title: '转不了，再点一次', icon: 'none' })
        })
      }
    })
  },
  delQuote(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删掉这份草稿？',
      content: '发出去的报价会留着当记录，草稿删了就没了。',
      success: (r) => {
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/quotes/' + id, method: 'DELETE',
          success: () => { this.loadQuotes() },
          fail: () => wx.showToast({ title: '删不掉，再点一次', icon: 'none' })
        })
      }
    })
  },
  openDue(e) {
    const t = (e && e.currentTarget && e.currentTarget.dataset.type) || 'ar'
    wx.showLoading({ title: '算到期…' })
    this.req({
      url: API_BASE + '/due-schedule?type=' + t + '&months=6&limit=60&offset=0',
      success: (res) => {
        wx.hideLoading()
        const d = res.data || {}
        this.setData({ due: { type: t, total: d.total, overdue_total: d.overdue_total, soon_total: d.soon_total, no_due_total: d.no_due_total, count: d.count, rows: d.rows || [], has_more: !!d.has_more, next_offset: d.next_offset || 0, rows_total: d.rows_total || 0, more: 0 } })
      },
      fail: () => wx.hideLoading()
    })
  },
  loadDueMore() {
    const d = this.data.due
    if (!d || !d.has_more) return
    wx.showLoading({ title: '再取 60 张…' })
    this.req({
      url: API_BASE + '/due-schedule?type=' + d.type + '&months=6&limit=60&offset=' + (d.next_offset || 0),
      success: (res) => {
        wx.hideLoading()
        const x = res.data || {}
        const rows = (d.rows || []).concat(x.rows || [])
        this.setData({ due: Object.assign({}, d, { rows, has_more: !!x.has_more, next_offset: x.next_offset || 0, rows_total: x.rows_total || d.rows_total }) })
      },
      fail: () => wx.hideLoading()
    })
  },
  closeDue() { this.setData({ due: null }) },
  downloadDueXlsx() {
    const d = this.data.due
    if (!d) return
    wx.showLoading({ title: '生成 Excel…' })
    this.req({
      url: API_BASE + '/due-schedule-xlsx?type=' + d.type + '&months=6',
      success: (res) => {
        const r = res.data || {}
        if (!r.b64) { wx.hideLoading(); return wx.showToast({ title: '生成失败', icon: 'none' }) }
        const p = wx.env.USER_DATA_PATH + '/' + (r.name || '到期表.xlsx')
        wx.getFileSystemManager().writeFile({
          filePath: p, data: r.b64, encoding: 'base64',
          success: () => {
            wx.hideLoading()
            if (wx.shareFileMessage) wx.shareFileMessage({ filePath: p, fileName: r.name || '到期表.xlsx', fail: () => wx.showToast({ title: '已生成', icon: 'none' }) })
            else wx.showToast({ title: '已生成', icon: 'success' })
          },
          fail: () => { wx.hideLoading(); wx.showToast({ title: '保存失败', icon: 'none' }) }
        })
      },
      fail: () => wx.hideLoading()
    })
  },
  // 超期分级：30/60/90
  openRisk(e) {
    const t = (e && e.currentTarget && e.currentTarget.dataset.type) || 'ar'
    wx.showLoading({ title: '分级…' })
    this.req({
      url: API_BASE + '/risk-list?type=' + t,
      success: (res) => {
        wx.hideLoading()
        const d = res.data || {}
        const bk = d.buckets || {}
        this.setData({ risk: { type: t, level: d.level || '', bad_total: d.bad_total || 0, bad_count: d.bad_count || 0, bad: (d.bad || []).slice(0, 8), b: [bk.dx, bk.d90, bk.d60, bk.d30, bk.d0].filter(Boolean) } })
      },
      fail: () => wx.hideLoading()
    })
  },
  closeRisk() { this.setData({ risk: null }) },
  copyRiskText() {
    const r = this.data.risk
    if (!r) return
    const lines = [r.type === 'ap' ? '【我欠别人·超期分级】' : '【欠款超期分级】', '']
    r.b.forEach((x) => { if (x.cnt) lines.push(x.label + '：' + x.amount + ' 元（' + x.cnt + ' 笔）') })
    if (r.bad.length) { lines.push('', '拖最久的：'); r.bad.forEach((p) => lines.push('· ' + p.party + ' ' + p.left + ' 元，最久 ' + p.worst + ' 天')) }
    lines.push('', r.level)
    wx.setClipboardData({ data: lines.join('\n') })
  },
  // 这周催款排班：按「金额 × 逾期 × 信用」排好，分到具体哪天打
  openCollectPlan(e) {
    const type = (e && e.currentTarget && e.currentTarget.dataset.type) || 'ar'
    wx.showLoading({ title: '排班…' })
    this.req({
      url: API_BASE + '/collect-plan?type=' + type + '&days=7&per_day=3',
      success: (res) => {
        wx.hideLoading()
        const d = res.data || {}
        this.setData({ cp: Object.assign({}, d, { type_text: d.type === 'ap' ? '要付' : '要收' }) })
        wx.pageScrollTo({ scrollTop: 0, duration: 200 })
      },
      fail: () => wx.hideLoading()
    })
  },
  // 催款月报：这个月催了几次、催回多少、哪家催了也白催
  onDrMonth(e) { this.setData({ dr_month: e.detail.value }) },
  loadDunningReport() {
    const m = String(this.data.dr_month || '').trim()
    wx.showLoading({ title: '算月报…' })
    this.req({
      url: API_BASE + '/dunning-report?type=ar' + (m ? '&month=' + m : ''),
      success: (res) => {
        wx.hideLoading()
        const d = res.data || {}
        if (d.error) return wx.showToast({ title: d.error, icon: 'none' })
        this.setData({ dr: d })
      },
      fail: () => wx.hideLoading()
    })
  },
  closeDunningReport() { this.setData({ dr: null }) },
  copyDunningReport() {
    const d = this.data.dr
    if (!d) return
    const L = ['【催款月报 · ' + d.month + '】']
    ;(d.advice || []).forEach((a) => L.push(a.text))
    ;(d.rows || []).forEach((x) => L.push('· ' + x.party + '：' + x.state_text + '（催 ' + x.times + ' 次，还欠 ¥' + x.left + '）'))
    wx.setClipboardData({ data: L.join('\n') })
  },
  closeCollectPlan() { this.setData({ cp: null }) },
  copyPlanAll() {
    const p = this.data.cp
    if (!p) return
    const lines = ['【' + p.type_text + '排班】这 ' + p.span + ' 天 ' + p.plan_n + ' 家 · 共 ¥' + p.plan_amt]
    ;(p.plan || []).forEach((d) => {
      lines.push('', d.wd + ' ' + d.label + '（' + d.rows.length + ' 家 ¥' + d.amount + '）')
      d.rows.forEach((r) => lines.push('  ' + r.party + ' ¥' + r.left + ' · ' + r.act + ' · ' + r.why))
    })
    wx.setClipboardData({ data: lines.join('\n') })
  },
  copyPlanOne(e) {
    const p = this.data.cp
    if (!p) return
    const name = e.currentTarget.dataset.p
    const r = ((p.plan || []).reduce((a, d) => a.concat(d.rows), [])).find((x) => x.party === name)
    if (r) wx.setClipboardData({ data: r.party + '　欠 ¥' + r.left + '（' + r.why + '）　建议：' + r.act })
  },
  // 对账完成度：这个月该对几家、对上几家、卡在哪
  onRbMonth(e) { this.setData({ rb_month: String(e.detail.value || '').trim() }) },
  loadReconBoard(e) {
    const type = (e && e.currentTarget && e.currentTarget.dataset.type) || 'ar'
    const mm = /^\d{4}-\d{2}$/.test(this.data.rb_month) ? this.data.rb_month : ''
    wx.showLoading({ title: '算…' })
    this.req({
      url: API_BASE + '/recon-board?type=' + type + (mm ? '&month=' + mm : ''),
      success: (res) => {
        wx.hideLoading()
        const d = res.data || {}
        this.setData({ rb: Object.assign({}, d, { type_text: d.type === 'ap' ? '供应商' : '客户' }) })
      },
      fail: () => wx.hideLoading()
    })
  },
  closeReconBoard() { this.setData({ rb: null }) },
  copyReconBoard() {
    const r = this.data.rb
    if (!r) return
    const lines = [r.text, '']
    ;(r.rows || []).forEach((x) => lines.push(x.party + '　' + x.st_text + '　还欠 ¥' + x.left + (x.sent ? '　' + x.sent + ' 发的' : '')))
    lines.push('', '近几个月：')
    ;(r.curve || []).forEach((c) => lines.push(c.month + '　' + (c.total ? c.done + '/' + c.total + ' 家（' + c.rate + '%）' : '没单子')))
    wx.setClipboardData({ data: lines.join('\n') })
  },
  closeCollect() { this.setData({ collect: null }) },
  // 月度报表包：每月 1 号自动生成，一个 Excel 装全套
  loadPacks() {
    this.req({
      url: API_BASE + '/month-reports', fail: () => {},
      success: (res) => {
        const rows = (res.data || {}).rows || []
        this.setData({ packs: rows.map((r) => ({ id: r.id, month: r.month, name: r.name, kb: Math.round((r.size || 0) / 1024), created: String(r.created_at || '').slice(0, 16).replace('T', ' ') })) })
      }
    })
  },
  genMonthPack() {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1)
    const m = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2)
    wx.showLoading({ title: '打包 ' + m + '…' })
    this.req({
      url: API_BASE + '/month-pack-run', method: 'POST', data: { month: m }, fail: () => wx.hideLoading(),
      success: (res) => {
        wx.hideLoading()
        const d2 = res.data || {}
        if (!d2.ok) return wx.showModal({ title: '没生成成功', content: d2.error || '稍后再试一次', showCancel: false })
        wx.showToast({ title: '已生成 ' + m, icon: 'success' })
        this.loadPacks()
      }
    })
  },
  downloadPack(e) {
    const p = (this.data.packs || [])[e.currentTarget.dataset.i]
    if (!p) return
    wx.showLoading({ title: '取文件…' })
    this.req({
      url: API_BASE + '/month-pack-file?month=' + encodeURIComponent(p.month), fail: () => wx.hideLoading(),
      success: (res) => { wx.hideLoading(); this.saveXlsxFile(res.data || {}) }
    })
  },
  // 回款预测
  loadForecast() {
    wx.showLoading({ title: '算一下…' })
    this.req({
      url: API_BASE + '/forecast?months=3', fail: () => wx.hideLoading(),
      success: (res) => {
        wx.hideLoading()
        const d = res.data || {}
        if (!d.months) return wx.showToast({ title: d.error || '算不出来', icon: 'none' })
        this.setData({ fc: Object.assign({}, d, { rate_pct: Math.round((d.rate || 0) * 100) }) })
      }
    })
  },
  copyForecast() {
    const f = this.data.fc
    if (!f) return
    const lines = ['【回款预测】' + f.months.length + ' 个月', '回款率 ' + f.rate_pct + '%（' + f.rate_basis + '）', '']
    f.months.forEach((m) => lines.push(m.month + '　应收 ' + m.ar + '（原 ' + m.ar_raw + '）　应付 ' + m.ap + '　净 ' + m.net))
    lines.push('', '合计：收回 ' + f.total_ar + '　要付 ' + f.total_ap + '　净进 ' + f.net, '已逾期未收 ' + f.overdue, f.note)
    wx.setClipboardData({ data: lines.join('\n') })
  },
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
      data: { type: adv_type, party: a_party, amount: Number(a_amount), remark: a_remark, account_id: this.data.acc_id, client_id: this.newCid() },
      queue: '记预收款/预付款',
      success: () => { this.setData({ a_party: '', a_amount: '', a_remark: '' }); this.refresh() }
    })
  },
  addAdvancePre() {
    this.setData({ adv_type: 1 })
    const { a_party, a_amount, a_remark } = this.data
    if (!a_party || !(Number(a_amount) > 0)) return wx.showToast({ title: '名称和金额必填', icon: 'none' })
    this.req({
      url: API_BASE + '/advances', method: 'POST',
      data: { type: 'out', party: a_party, amount: Number(a_amount), remark: a_remark, account_id: this.data.acc_id, client_id: this.newCid() },
      queue: '记预收款/预付款',
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
    const amount = this.toAmount(this.data.l_amount) || 0
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
    const amount = this.toAmount(this.data.rl_amount) || 0
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
    const types = ['ar', 'ap', 'expense', 'loan', 'reimb', 'ar_init', 'ap_init', 'ar_recon', 'ap_recon', 'prepaid', 'parties']
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
  excelTemplate(e) {
    const types = ['ar', 'ap', 'expense', 'loan', 'reimb', 'ar_init', 'ap_init', 'ar_recon', 'ap_recon', 'prepaid', 'parties']
    const ov = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.t : ''
    const t = ov || types[this.data.import_type] || 'ar'
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
  // ===== 模板包：一个工作簿好几个页签，一次下载、填完一次上传全导进去 =====
  // 存文件 + 转发的流程和单张模板一样，抽出来两边共用。
  _saveXlsx(b64, name) {
    const dst = wx.env.USER_DATA_PATH + '/' + (name || '导入模板.xlsx')
    wx.getFileSystemManager().writeFile({
      filePath: dst, data: b64, encoding: 'base64',
      success: () => {
        wx.showToast({ title: '模板已生成', icon: 'success' })
        if (wx.shareFileMessage) {
          wx.shareFileMessage({
            filePath: dst, fileName: name || '导入模板.xlsx',
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
  },
  // 70 多个客户在手机上一个个敲不现实：把这个网址发到电脑浏览器，下载模板填好再传回来
  copyPcUrl() {
    const u = API_BASE + '/pc'
    wx.setClipboardData({ data: u, success: () => wx.showModal({ title: '网址已复制', content: u + '\n\n发到自己电脑上打开：填口令 → 下载模板 → 用 Excel 填 → 传回来。手机上不用敲。', showCancel: false }) })
  },
  packTemplate(e) {
    const p = (e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.p : '') || 'daily'
    wx.showLoading({ title: '生成中…' })
    this.req({
      // fill=1：把已有客户/供应商名字先填进对账页，70 多个客户不用一个个手打
      url: API_BASE + '/import-template-pack?tpl=' + p + '&fill=1',
      success: (res) => {
        wx.hideLoading()
        const d = res.data || {}
        if (!d.b64) return wx.showToast({ title: '生成失败', icon: 'none' })
        this._saveXlsx(d.b64, d.name || '模板.xlsx')
      },
      fail: () => { wx.hideLoading(); wx.showToast({ title: '生成失败，看看网', icon: 'none' }) }
    })
  },
  // 大文件切片上传：手机上选一个 3MB 的 Excel，转 base64 是 4MB，塞进一个 wx.request
  // 发上去弱网下超时是常态；更糟的是超时后用户不知道到底导进去了没有，重发一次就可能导两遍。
  // 超过 ~900KB 就切：每片约 500KB，断了重发只补没传完的片，最后由服务端拼起来。
  // cb(err, payload)，payload 是 { b64 } 或 { upload_id }，两个导入接口都认。
  _upChunk: 700000,
  _upSmall: 900000,
  filePayload(b64, name, cb) {
    const s = String(b64 || '')
    if (!s) return cb('这个文件是空的')
    if (s.length <= this._upSmall) return cb(null, { b64: s })
    const CH = this._upChunk
    const total = Math.ceil(s.length / CH)
    if (total > 400) return cb('这个文件太大了（' + Math.round(s.length / 1024) + 'KB），用电脑上的 /pc 页面导吧')
    const ak = wx.getStorageSync('ak') || ''
    const bk = String(wx.getStorageSync('book') || 1)
    const post = (url, data, ok, bad) => wx.request({
      url: API_BASE + url, method: 'POST', data, timeout: 60000,
      header: { 'X-Access-Key': ak, 'X-Book': bk },
      success: (r) => {
        const d = r.data || {}
        if (r.statusCode >= 200 && r.statusCode < 300 && d.ok !== false) return ok(d)
        bad(d.error || ('上传失败（' + r.statusCode + '）'))
      },
      fail: () => bad('网络断了；再点一次会从没传完的那片接着传')
    })
    wx.showLoading({ title: '上传 0%', mask: true })
    post('/upload-start', { name: name || '', size: s.length, parts: total }, (st) => {
      const id = st.id
      const send = (i) => {
        if (i >= total) {
          return post('/upload-finish', { id }, () => { wx.hideLoading(); cb(null, { upload_id: id }) }, (e) => { wx.hideLoading(); cb(e) })
        }
        const piece = s.slice(i * CH, (i + 1) * CH)
        post('/upload-part', { id, seq: i, b64: piece }, () => {
          wx.showLoading({ title: '上传 ' + Math.round(((i + 1) / total) * 100) + '%', mask: true })
          send(i + 1)
        }, (e) => { wx.hideLoading(); cb(e) })
      }
      send(0)
    }, (e) => { wx.hideLoading(); cb(e) })
  },
  // 选填好的整本表：先预览每一页要导什么，确认了才真导
  packPick(e) {
    const p = (e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.p : '') || 'daily'
    if (!wx.chooseMessageFile) return wx.showToast({ title: '微信版本过低，用不了这个', icon: 'none' })
    wx.chooseMessageFile({ count: 1, type: 'file', extension: ['xlsx', 'XLSX'], success: (r) => {
      const f = (r.tempFiles || [])[0]
      if (!f) return
      if (f.size > 3 * 1024 * 1024) return wx.showToast({ title: '文件太大（3MB 以内）', icon: 'none' })
      wx.showLoading({ title: '看一眼每页…' })
      wx.getFileSystemManager().readFile({ filePath: f.path, encoding: 'base64', success: (fr) => {
        this._pkName = f.name || '模板包'
        // 大文件先切片传上去：预览和「确认导入」用同一个 upload_id，不必再把几 MB 重发一遍
        this.filePayload(fr.data, this._pkName, (e2, payload) => {
          if (e2) { wx.hideLoading(); return wx.showToast({ title: e2, icon: 'none' }) }
          this._pkPayload = payload
          this._pkB64 = payload.b64 || ''
          this.req({
            url: API_BASE + '/import-pack', method: 'POST', data: Object.assign({ dry: true }, payload),
            success: (res) => {
              wx.hideLoading()
              const d = res.data || {}
              if (!d.ok) return wx.showToast({ title: d.error || '读不了这个表', icon: 'none' })
              this.setData({
                pk_open: true, pk_title: this._pkName, pk_text: d.text || '', pk_sheets: d.sheets || [], pk_force: false,
                pk_dry: true, pk_total: d.total_amount || 0
              })
            },
            fail: () => { wx.hideLoading(); wx.showToast({ title: '上传失败，看看网', icon: 'none' }) }
          })
        })
      }, fail: () => { wx.hideLoading(); wx.showToast({ title: '读不到这个文件', icon: 'none' }) } })
    } })
  },
  packClose() { this.setData({ pk_open: false }) },
  packConfirm() {
    if (this.data.pk_busy) return
    this.setData({ pk_busy: true })
    this.req({
      url: API_BASE + '/import-pack', method: 'POST',
      data: Object.assign({ name: this._pkName || '', force: !!this.data.pk_force }, this._pkPayload || { b64: this._pkB64 || '' }),
      success: (res) => {
        this.setData({ pk_busy: false })
        const d = res.data || {}
        if (d.dup_file) {
          // 默认按钮必须是「知道了」。以前默认是「还是再导一次」，手一抖就把同一份表导两遍，
          // 账上的应收直接翻倍。
          return wx.showModal({
            title: '这份表导过了', content: d.error || '同一个文件不会重复入账。',
            confirmText: '知道了', cancelText: '确实要再导一次',
            success: (m) => { if (!m.confirm && m.cancel) { this.setData({ pk_force: true }); this.packConfirm() } }
          })
        }
        if (!d.ok) return wx.showToast({ title: d.error || '导入失败', icon: 'none' })
        this._pkPayload = null
        this.setData({ pk_open: false, pk_sheets: [], pk_text: '', pk_force: false })
        wx.showModal({ title: '导完了', content: d.text || '', showCancel: false })
        this.refresh({ lite: true })
      },
      fail: () => { this.setData({ pk_busy: false }); wx.showToast({ title: '导入失败，看看网', icon: 'none' }) }
    })
  },
  // 直接选 .xlsx 文件导入（不用管编码，Excel 存什么都能读）
  // ===== Excel 改完再导回来（批量改单：先对比，勾选后才写库）=====
  chooseReimport(e) {
    const t = e.currentTarget.dataset.t === 'ap' ? 'ap_update' : 'ar_update'
    if (!wx.chooseMessageFile) return wx.showToast({ title: '微信版本过低，用不了这个', icon: 'none' })
    wx.chooseMessageFile({ count: 1, type: 'file', extension: ['xlsx', 'XLSX'], success: (r) => {
      const f = (r.tempFiles || [])[0]
      if (!f) return
      if (f.size > 3 * 1024 * 1024) return wx.showToast({ title: '文件太大（3MB 以内）', icon: 'none' })
      wx.showLoading({ title: '对比中…' })
      wx.getFileSystemManager().readFile({ filePath: f.path, encoding: 'base64', success: (fr) => {
        this.filePayload(fr.data, f.name || '', (e2, payload) => {
        if (e2) { wx.hideLoading(); return wx.showToast({ title: e2, icon: 'none' }) }
        this.req({ url: API_BASE + '/import-xlsx', method: 'POST', data: Object.assign({ type: t }, payload),
          success: (res) => {
            wx.hideLoading()
            const d = res.data || {}
            if (!d.ok) return wx.showModal({ title: '读不了这个表', content: d.error || '稍后再试', showCancel: false })
            const rows = (d.changes || []).map((x) => Object.assign({}, x, { pick: x.state === 'ok' }))
            // 文件内容（base64，最大 3MB）放实例变量，不进 setData：
            // 小程序单次 setData 上限 1MB，塞进去会直接白屏，而且白屏时没有任何提示。
            this._riB64 = payload.b64 || ''
            this._riPayload = payload
            this.setData({ ri: Object.assign({}, d, { changes: rows }), ri_type: t, ri_b64: '' })
            if (!rows.length) wx.showToast({ title: '都和账上一样，不用改', icon: 'none' })
          },
          fail: () => wx.hideLoading() })
        })
      } })
    } })
  },
  toggleRi(e) {
    const i = Number(e.currentTarget.dataset.i)
    const rows = (this.data.ri && this.data.ri.changes || []).slice()
    if (!rows[i] || rows[i].state !== 'ok') return
    rows[i].pick = !rows[i].pick
    this.setData({ 'ri.changes': rows })
  },
  closeRi() { this._riB64 = ''; this._riPayload = null; this.setData({ ri: null, ri_b64: '' }) },
  applyRi() {
    const d = this.data.ri
    if (!d) return
    const pick = (d.changes || []).filter((x) => x.pick && x.state === 'ok')
    if (!pick.length) return wx.showToast({ title: '没勾要改的行', icon: 'none' })
    wx.showModal({ title: '确认改这 ' + pick.length + ' 行？', content: '只改勾上的，别的行一分不动；改完在「编辑留痕」里能看到改了哪几处。', success: (r) => {
      if (!r.confirm) return
      this.req({ url: API_BASE + '/import-xlsx', method: 'POST', once: 'applyRi',
        data: Object.assign({ type: this.data.ri_type, apply: true, changes: pick.map((x) => ({ id: x.id, set: x.set })) }, this._riPayload || { b64: this._riB64 || '' }),
        success: (res) => {
          const x = res.data || {}
          if (!x.ok) return wx.showModal({ title: '没改成', content: x.error || '稍后再试', showCancel: false })
          wx.showToast({ title: x.text || '改好了', icon: 'success' })
          this.setData({ ri: null })
          this.loadAr(); this.loadAp(); this.loadArSummary()
        } })
    } })
  },
  // 模板中心那一行点「传」：先对准类型，再走选文件
  tplPick(e) {
    const t = e.currentTarget.dataset.t
    const idx = ['ar', 'ap', 'expense', 'loan', 'reimb', 'ar_init', 'ap_init', 'ar_recon', 'ap_recon', 'prepaid'].indexOf(t)
    if (idx >= 0 && idx !== this.data.import_type) this.setData({ import_type: idx })
    this.chooseXlsxFile()
  },
  chooseXlsxFile() {
    const types = ['ar', 'ap', 'expense', 'loan', 'reimb', 'ar_init', 'ap_init', 'ar_recon', 'ap_recon', 'prepaid', 'parties']
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
            wx.showLoading({ title: '看这是什么表…' })
            this.setData({ import_file_name: f.name || 'Excel 文件' })
            const names = { ar: '应收（客户欠我）', ap: '应付（我欠别人）', expense: '支出', loan: '员工借支', reimb: '报销', recon: '对账核对（只比不入账）', ar_init: '期初应收', ap_init: '期初应付' }
            this.req({
              url: API_BASE + '/detect-import', method: 'POST', data: { b64: fr.data },
              success: (res) => {
                wx.hideLoading()
                const d = res.data || {}
                if (d.type && d.type !== t) {
                  return wx.showModal({
                    title: '这个表看着是「' + (names[d.type] || d.type) + '」',
                    content: (d.why || '') + '，共 ' + (d.rows_count || 0) + ' 行。\n按它说的导，还是按你选的「' + (names[t] || t) + '」导？',
                    confirmText: '按它说的', cancelText: '按我选的',
                    success: (m) => { wx.showLoading({ title: '先看一眼…' }); this.previewXlsx(m.confirm ? d.type : t, fr.data) }
                  })
                }
                wx.showLoading({ title: '先看一眼…' })
                this.previewXlsx(t, fr.data)
              },
              fail: () => { wx.hideLoading(); wx.showLoading({ title: '先看一眼…' }); this.previewXlsx(t, fr.data) }
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
    const nm = (e.currentTarget.dataset.n || '').trim()
    // 分类是一排 chip，手指一碰就删，以前没有任何确认
    wx.showModal({
      title: '删除分类',
      content: (nm ? '「' + nm + '」' : '这个分类') + '删掉后，已经用它记过的账不受影响，但以后不能再选。确定删吗？',
      success: (r) => { if (r.confirm) this.req({ url: API_BASE + '/categories/' + id, method: 'DELETE', success: () => this.loadCategories() }) }
    })
  },
  loadDashboard() {
    this.req({
      url: API_BASE + '/dashboard',
      success: (res) => {
        if (res.data && !res.data.error) {
          const N = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
          this.setData({
            // 一律转成数字：后端某个字段缺了的话，直接塞 undefined 首页那几个大数字会变成空白，
            // 看着像「没有欠款」，比显示 0 危险。
            ar_total: N(res.data.ar_total), ap_total: N(res.data.ap_total),
            month_income: N(res.data.month_income), month_outcome: N(res.data.month_outcome),
            month_profit: N(res.data.month_profit),
            month_order_add: N(res.data.month_order_add), month_payable_add: N(res.data.month_payable_add),
            profit_biz: N(res.data.profit_biz),
            dash_err: '',
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
          if (res.data.role === 'staff') this.askStaffName()
        } else {
          this.setData({ dash_err: (res.data && res.data.error) || '首页数字没取到，下拉刷新试试' })
        }
      },
      fail: () => this.setData({ dash_err: '网断了，首页数字没更新（下拉刷新重试）' })
    })
  },
  PAGE: 60,
  // more=true 表示上拉加载下一页
  loadArSummary() {
    this.req({ url: API_BASE + '/ar-summary?type=ar', success: (res) => this.setData({ ar_sum: res.data || {} }) })
    this.req({ url: API_BASE + '/ar-summary?type=ap', success: (res) => this.setData({ ap_sum: res.data || {} }) })
    this.loadApCats()
    this.loadArCats()
  },
  // 应付按分类看：这个月硫酸/染料/外发加工费各花了多少、还欠多少
  loadApCats() {
    this.req({ url: API_BASE + '/ap-by-category', success: (res) => {
      const d = res.data || {}
      this.setData({ ap_cat_rows: d.rows || [], ap_cat_text: d.text || '' })
    } })
  },
  // 应收按分类（钱是从哪来的）：货款/加工费/打样费分开看
  loadArCats() {
    this.req({ url: API_BASE + '/ar-by-category', success: (res) => {
      const d = res.data || {}
      this.setData({ ar_cat_rows: d.rows || [], ar_cat_text: d.text || '' })
    } })
  },
  pickArCatFilter(e) {
    const c = e.currentTarget.dataset.c || ''
    this.setData({ ar_cat: this.data.ar_cat === c ? '' : c })
    this.loadAr()
  },
  // 表单里选分类（再点一下取消）
  pickPCat(e) {
    const c = e.currentTarget.dataset.c || ''
    this.setData({ p_category: this.data.p_category === c ? '' : c })
  },
  // 列表按分类筛（再点一下看全部）
  pickApCat(e) {
    const c = e.currentTarget.dataset.c || ''
    this.setData({ ap_cat: this.data.ap_cat === c ? '' : c })
    this.loadAp()
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
    const open = this.data.ar_open === n ? '' : n
    this.setData({ ar_open: open })
    if (open) this.loadPartyItems('ar', n)
  },
  toggleGroupAp(e) {
    const n = e.currentTarget.dataset.n
    const open = this.data.ap_open === n ? '' : n
    this.setData({ ap_open: open })
    if (open) this.loadPartyItems('ap', n)
  },
  // 点开某一家才去取它的单据（客户多时首屏不扛几百条）
  loadPartyItems(t, name) {
    const key = t === 'ar' ? 'ar_groups' : 'ap_groups'
    const gs = this.data[key] || []
    const i = gs.findIndex((g) => g.name === name)
    if (i < 0) return
    if ((gs[i].items || []).length) return
    this.req({
      url: API_BASE + '/party-items?type=' + t + '&party=' + encodeURIComponent(name),
      silent: true,
      success: (res) => {
        const d = res.data || {}
        const arr = (this.data[key] || []).slice()
        const j = arr.findIndex((g) => g.name === name)
        if (j < 0) return
        arr[j] = Object.assign({}, arr[j], { items: d.items || [], items_more: !!d.more })
        const patch = {}
        patch[key] = arr
        this.setData(patch)
      }
    })
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
          url: API_BASE + '/pay-batch', method: 'POST', once: 'pay-batch',
          data: { supplier: ds.n, amount: Number(ds.amt), account_id: this.data.acc_id },
          success: (res) => {
            const d = res.data || {}
            if (d.ok) {
              wx.showModal({ title: '付款成功', content: '共冲 ¥' + d.total + '，' + (d.used || []).length + ' 笔' + (d.rest > 0 ? '\n还剩 ¥' + d.rest + ' 没抵完' : ''), showCancel: false })
              this.refresh({ lite: true })
            } else wx.showToast({ title: d.error || '失败', icon: 'none' })
          }
        })
      }
    })
  },
  // 追加分页：手机滑到底会连着触发好几次 onReachBottom（滑得快 3 次都有），
  // 以前每次都发请求、每次都 offset=同一个数，回来三份一样的行 —— 列表里同一张单出现三遍，
  // 点哪一行都不知道点的是哪一份。现在：一次只发一个请求，回来的按 id 去重。
  _appendPage(cur, page, more) {
    // more=false 是「重新拉第一页」：必须从空开始，否则旧行（同 id）会被当成重复留下，
    // 新数据全被丢掉 —— 收了款列表还显示「欠5000」、删掉的单还挂在上面、切账套显示别家的单。
    const base = more ? (Array.isArray(cur) ? cur : []) : []
    const seen = new Set(base.map((x) => String(x.id)))
    const add = []
    // 后端某次回的不是数组（比如 {ok:true, error:…}）时不能直接 for…of，
    // 那会抛 TypeError 把整页渲染带死，而错误还看不见。
    const rows = Array.isArray(page) ? page : []
    for (const row of rows) if (!seen.has(String(row.id))) { seen.add(String(row.id)); add.push(row) }
    return base.concat(add)
  },
  // 分页加载中状态：除了内部防重发（_pagBusy），还要让界面看得见 ——
  // 以前点「加载更早的」按钮文字一点变化都没有，弱网下像没反应，于是又点一次。
  _loading(key, on) {
    this._pagBusy = this._pagBusy || {}
    this._pagBusy[key] = !!on
    const k = key === 'ex' ? 'ex_busy' : key + '_busy'
    this.setData({ [k]: !!on })
  },
  loadAr(more) {
    if (more && this._pagBusy && this._pagBusy.ar) return
    const off = more ? this.data.ar_off : 0
    // 搜索词要下推给后端：以前只在前端筛「已经加载的那 60 条」，
    // 单子一多，老的单在后台有、页面上搜不到，还提示「没有」。
    const kwq = (this.data.ar_kw ? '&kw=' + encodeURIComponent(this.data.ar_kw) : '') + (this.data.ar_cat ? '&cat=' + encodeURIComponent(this.data.ar_cat) : '')
    const q = '&status=' + this.data.ar_filter + '&sort=' + this.data.ar_sort + kwq
    if (more) this._loading('ar', true)
    this.req({ url: API_BASE + '/ar?offset=' + off + '&limit=' + this.PAGE + q, success: (res) => {
      const page = res.data || []
      // 全量列表只留在页面实例上（this._arAll），不进 data：
      // data 里的东西每次 setData 都要序列化过桥发给视图层，而 wxml 从来没用过 ar_all。
      const all = this._appendPage(this._arAll, page, more)
      this._arAll = all
      this.setData({ ar_off: all.length, ar_more: page.length >= this.PAGE, ar_list: this.filterAr(all, this.data.ar_kw) })
    }, fail: () => this._loading('ar', false), complete: () => this._loading('ar', false) })
  },
  loadAp(more) {
    if (more && this._pagBusy && this._pagBusy.ap) return
    const off = more ? this.data.ap_off : 0
    const kwq = this.data.ap_kw ? '&kw=' + encodeURIComponent(this.data.ap_kw) : ''
    const q = '&status=' + this.data.ap_filter + '&sort=' + this.data.ap_sort + (this.data.ap_cat ? '&cat=' + encodeURIComponent(this.data.ap_cat) : '') + kwq
    if (more) this._loading('ap', true)
    this.req({ url: API_BASE + '/ap?offset=' + off + '&limit=' + this.PAGE + q, success: (res) => {
      const page = res.data || []
      const all = this._appendPage(this._apAll, page, more)
      this._apAll = all
      this.setData({ ap_off: all.length, ap_more: page.length >= this.PAGE, ap_list: this.filterAp(all, this.data.ap_kw) })
    }, fail: () => this._loading('ap', false), complete: () => this._loading('ap', false) })
  },
  loadExpenses(more) {
    if (more && this._pagBusy && this._pagBusy.ex) return
    const off = more ? this.data.ex_off : 0
    if (more) this._loading('ex', true)
    this.req({ url: API_BASE + '/expenses?offset=' + off + '&limit=' + this.PAGE, success: (res) => {
      const page = res.data || []
      const all = this._appendPage(this._expAll, page, more)
      this._expAll = all
      this.setData({ ex_off: all.length, ex_more: page.length >= this.PAGE, expense_list: this.filterEx(all, this.data.ex_kw) })
    }, fail: () => this._loading('ex', false), complete: () => this._loading('ex', false) })
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
  onArKw(e) {
    const kw = e.detail.value
    this.setData({ ar_kw: kw, ar_list: this.filterAr(this._arAll, kw) })
    clearTimeout(this._arT)
    this._arT = setTimeout(() => this.loadAr(), 300)
  },
  onApKw(e) {
    const kw = e.detail.value
    this.setData({ ap_kw: kw, ap_list: this.filterAp(this._apAll, kw) })
    clearTimeout(this._apT)
    this._apT = setTimeout(() => this.loadAp(), 300)
  },
  onExKw(e) { this.setData({ ex_kw: e.detail.value, expense_list: this.filterEx(this._expAll, e.detail.value) }) },
  // 切到某个页时才加载那一页要用的数据（一次 30 个请求太多，手机上慢）
  enterTab(t) {
    if (t === 'ar' || t === 'ap') {
      this.loadAr(); this.loadAp(); this.loadArSummary(); this.loadGroups(t || 'ar')
      this.loadLimits(); this.loadAdvances()
    } else if (t === 'expense') {
      this.loadExpenses(); this.loadLoans(); this.loadSuggest(); this.loadMaterials()
    } else if (t === 'history') {
      this.loadHistory()
    } else if (t === 'import') {
      this.loadReconLog(); this.loadImportLog(); this.loadReconProgress()
    } else if (t === 'report') {
      this.loadFixed(); this.loadMonthLocks(); this.loadArchives(); this.loadAuditLogs()
      this.loadTrash(); this.loadPhrases(); this.loadBudgets()
      this.loadProfitCompare(); this.loadMarginBy(); this.loadPacks(); this.loadTaxSummary()
    } else if (t === 'asset') {
      this.loadAsset(); this.loadInvoices(); this.loadAssets(); this.loadBankFlows()
      this.loadWriteoffs(); this.loadTransfers(); this.loadDebts(); this.loadPrepaids()
    } else if (t === 'flows') {
      this.loadFlows()
    } else if (t === 'contact') {
      this.loadContacts(); this.loadProfiles(); this.loadPartyTerms(); this.loadTermGap(); this.loadTermAdvice(); this.loadTransfers(); this.loadAccounts(); this.loadTermDefault(); this.loadBackupTimeline(); this.loadPartyDups(); this.loadSeal(); this.loadReconCal()
      this.loadEditReqs()
    } else if (t === 'me') {
      this.loadHelpKw()
    } else {
      this.loadAr(); this.loadAp(); this.loadArSummary(); this.loadMyDay()
    }
  },
  // ── 不懂就问：名词小词典（搜一个词，看它啥意思） ──
  onGlKw(e) {
    this.setData({ gl_kw: e.detail.value })
    clearTimeout(this._glT)
    this._glT = setTimeout(() => this.loadHelpKw(), 350)
  },
  loadHelpKw() {
    const kw = this.data.gl_kw || ''
    this.req({
      url: API_BASE + '/help?kw=' + encodeURIComponent(kw) + (this.data.gl_cat ? '&cat=' + this.data.gl_cat : ''),
      once: 'help', silent: true,
      success: (r) => { if (r.data && r.data.ok) this.setData({ gl: r.data, gl_open: '' }) }
    })
  },
  setGlCat(e) {
    const c = e.currentTarget.dataset.c || ''
    this.setData({ gl_cat: this.data.gl_cat === c ? '' : c, gl_open: '' })
    this.loadHelpKw()
  },
  toggleGl(e) {
    const k = e.currentTarget.dataset.k
    this.setData({ gl_open: this.data.gl_open === k ? '' : k })
  },
  glGo(e) {
    const go = e.currentTarget.dataset.go
    if (go) this.jumpMap({ currentTarget: { dataset: { go } } })
  },
  // ── 找回口令（恢复码）：忘了口令时不用求人 ──
  showRecoverCode(code) {
    wx.setClipboardData({ data: code })
    wx.showModal({
      title: '这串恢复码请抄下来',
      content: code + '\n\n忘了口令时，用它就能重设口令。只显示这一次，我们也不存明文，抄在纸上放进抽屉（别和手机放一起）。',
      showCancel: false, confirmText: '我抄好了',
    })
  },
  openRecover() {
    this.setData({ rec_show: true, rec_code: '', rec_pw: '', rec_busy: false })
  },
  closeRecover() { this.setData({ rec_show: false }) },
  onRecCode(e) { this.setData({ rec_code: e.detail.value }) },
  onRecPw(e) { this.setData({ rec_pw: e.detail.value }) },
  doRecover() {
    const code = String(this.data.rec_code || '').trim()
    const pw = String(this.data.rec_pw || '').trim()
    if (!code || !pw) { wx.showToast({ title: '恢复码和新口令都要填', icon: 'none' }); return }
    if (pw.length < 4) { wx.showToast({ title: '新口令至少 4 位', icon: 'none' }); return }
    if (this.data.rec_busy) return
    this.setData({ rec_busy: true })
    wx.request({
      url: API_BASE + '/auth/recover', method: 'POST',
      data: { code, password: pw },
      header: { 'Content-Type': 'application/json' },
      success: (r) => {
        this.setData({ rec_busy: false })
        const d = r.data || {}
        if (d.ok) {
          wx.setStorageSync('ak', d.key || pw)
          this.setData({ rec_show: false, rec_code: '', rec_pw: '' })
          wx.showToast({ title: '口令已重设', icon: 'success' })
          this.refresh()
        } else {
          wx.showModal({ title: '没成功', content: d.error || '恢复码不对', showCancel: false })
        }
      },
      fail: () => { this.setData({ rec_busy: false }); wx.showToast({ title: '网络不好', icon: 'none' }) }
    })
  },
  // ── 钱进了哪个口袋（按账户对收付） ──
  openAccRecon() {
    const mode = (this.data.ar2 && this.data.ar2.mode) || 'day'
    this.loadAccRecon(mode)
  },
  accReconDay() { this.loadAccRecon('day') },
  accReconMonth() { this.loadAccRecon('month') },
  loadAccRecon(mode) {
    this.req({
      url: '/account-recon?mode=' + (mode || 'day'),
      success: (res) => {
        if (res.data && res.data.ok) this.setData({ ar2: res.data })
      },
    })
  },
  closeAccRecon() { this.setData({ ar2: null }) },
  copyAccRecon() {
    const d = this.data.ar2
    if (!d) return
    wx.setClipboardData({ data: d.text, success: () => wx.showToast({ title: '已复制' }) })
  },
  // ── 换手机 / 停用员工向导 ──
  loadAccessGuide() {
    this.req({
      url: '/access-guide',
      success: (res) => {
        if (res.data && res.data.ok) {
          const t = res.data.topics || []
          const keep = this.data.ag_tab
          const has = t.some((x) => x.k === keep)
          this.setData({ ag: res.data, ag_tab: has ? keep : ((t[0] && t[0].k) || 'newphone') })
        }
      },
    })
  },
  switchAgTab(e) { this.setData({ ag_tab: e.currentTarget.dataset.k }) },
  closeAccessGuide() { this.setData({ ag: null }) },
  copyAccessGuide() {
    const ag = this.data.ag
    if (!ag) return
    const t = (ag.topics || []).find((x) => x.k === this.data.ag_tab) || (ag.topics || [])[0]
    if (!t) return
    const txt = '【' + t.title + '】\n' + t.steps.map((s, i) => (i + 1) + '. ' + s).join('\n')
    wx.setClipboardData({ data: txt, success: () => wx.showToast({ title: '已复制，可以发给别人' }) })
  },
  // 一键停用员工口令
  staffOff() {
    wx.showModal({
      title: '停用员工口令？',
      content: '停用后，员工手机上那个口令立刻进不去（数据都还在）。以后要再用，重新设一个就行。',
      confirmText: '停用',
      confirmColor: '#b3261e',
      success: (r) => {
        if (!r.confirm) return
        const key = wx.getStorageSync('ak')
        wx.request({
          url: API_BASE + '/auth/staff-off',
          method: 'POST',
          header: { 'content-type': 'application/json', 'X-Access-Key': key, 'X-Book': this.data.book || '1' },
          data: { key, note: '小程序里一键停用' },
          success: (res) => {
            if (res.statusCode === 200 && res.data && res.data.ok) {
              this.setData({ staff_enabled: false })
              wx.showToast({ title: '已停用', icon: 'success' })
              this.loadAccessGuide()
              this.loadHealthDetail && this.loadHealthDetail()
            } else {
              wx.showToast({ title: (res.data && res.data.error) || '停用失败', icon: 'none' })
            }
          },
          fail: () => wx.showToast({ title: '网络不好，稍后再试', icon: 'none' }),
        })
      },
    })
  },
  loadRecoverInfo() {
    this.req({
      url: API_BASE + '/auth/recover-info',
      success: (r) => { if (r.data && r.data.ok) this.setData({ rec: r.data }) },
    })
  },
  openRecoverPanel() { this.loadRecoverInfo() },
  closeRecoverPanel() { this.setData({ rec: null }) },
  genRecoverCode() {
    wx.showModal({
      title: '重设恢复码', content: '生成新的恢复码后，旧那张纸就没用了。现在生成吗？',
      success: (m) => {
        if (!m.confirm) return
        this.req({
          url: API_BASE + '/auth/recover-code', method: 'POST', data: { key: wx.getStorageSync('ak') }, once: 'recover-gen',
          success: (r) => {
            const d = (r.data || {})
            if (d.ok && d.code) { this.showRecoverCode(d.code); this.loadRecoverInfo() }
            else wx.showToast({ title: d.error || '生成失败', icon: 'none' })
          },
        })
      },
    })
  },
  // ── 找功能：输一个词，直接跳到那个功能 ──
  openFeatSearch() {
    let recent = []
    try { recent = wx.getStorageSync('feat_recent') || [] } catch (e) { recent = [] }
    this.setData({ feat_open: true, feat_kw: '', feat_hits: [], feat_recent: recent })
  },
  closeFeatSearch() { this.setData({ feat_open: false }) },
  onFeatKw(e) {
    const kw = String(e.detail.value || '').trim()
    this.setData({ feat_kw: kw })
    this.searchFeat(kw)
  },
  searchFeat(kwArg) {
    const kw = String(typeof kwArg === 'string' ? kwArg : this.data.feat_kw || '').trim().toLowerCase()
    if (!kw) { this.setData({ feat_hits: [] }); return }
    const words = kw.split(/\s+/).filter(Boolean)
    const hit = (f) => {
      const hay = (f.n + ' ' + f.desc + ' ' + f.kw).toLowerCase()
      return words.every((w) => hay.indexOf(w) >= 0)
    }
    let hits = this.data.feat_all.filter(hit)
    // 名字里直接含这个词的排前面
    hits.sort((a, b) => (b.n.toLowerCase().indexOf(kw) >= 0 ? 1 : 0) - (a.n.toLowerCase().indexOf(kw) >= 0 ? 1 : 0))
    this.setData({ feat_hits: hits.slice(0, 20) })
  },
  openFeat(e) {
    const d = e.currentTarget.dataset
    const go = String(d.go || '')
    const name = String(d.n || '')
    if (go) {
      try {
        let recent = wx.getStorageSync('feat_recent') || []
        recent = [{ n: name, go }].concat(recent.filter((x) => x.n !== name)).slice(0, 5)
        wx.setStorageSync('feat_recent', recent)
      } catch (err) { /* 存不下就存不下 */ }
      this.setData({ feat_open: false, feat_recent: [] })
      this.jumpMap({ currentTarget: { dataset: { go } } })
    }
  },
  jumpMap(e) {
    const go = String(e.currentTarget.dataset.go || '')
    const [g, t] = go.indexOf(':') > 0 ? go.split(':') : [go, '']
    this.setData({ group: g })
    if (t) this.setData({ tab: t })
    this.enterTab(t || (g === 'home' ? 'home' : this.data.tab))
    wx.pageScrollTo({ scrollTop: 0, duration: 200 })
  },
  setGroup(e) {
    const g = e.currentTarget.dataset.g
    const keep = { bill: ['ar', 'ap', 'expense', 'import'], stat: ['report', 'asset', 'history'], me: ['contact'], home: ['home'] }
    const t = (keep[g] || ['home']).indexOf(this.data.tab) >= 0 ? this.data.tab : (keep[g] || ['home'])[0]
    this.setData({ group: g, tab: t })
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
    this.enterTab(t)
    if (t === 'ar' || t === 'ap' || t === 'expense') this.loadSuggest()
  },
  // 工作台待办点击跳转（reminders 里的 tab: ar/ap/expense/nw/home）
  jumpTodo() {
    if (this.data.overdue_count > 0 || this.data.due_soon_count > 0) this.setData({ tab: 'ar' })
    else if (this.data.pay_soon_count > 0) this.setData({ tab: 'ap' })
  },
  loadHealth() {
    this.req({
      url: API_BASE + '/health-check',
      success: (res) => {
        const r = res.data || {}
        if (r.score == null) return
        const items = (r.items || []).map((x) => ({
          ...x,
          fix: x.count > 0 ? (x.go || x.tip || '') : ''
        }))
        this.setData({ hc: { score: r.score, grade: r.grade, clean: r.clean, count: r.count, delta: r.delta || 0, items } })
      },
      fail: () => {}
    })
  },
  openHealth() { this.setData({ hc_open: true }) },
  closeHealth() { this.setData({ hc_open: false }) },
  hpGo(e) {
    const t = e.currentTarget.dataset.tab || 'home'
    this.setData({ hc_open: false })
    if (t === 'home') return
    this.enterTab ? this.enterTab(t) : this.setTab({ currentTarget: { dataset: { t } } })
  },

  loadPipeline() {
    this.req({
      url: API_BASE + '/pipeline',
      success: (res) => { if (res.data && res.data.ok) this.setData({ pipe: res.data }) },
      fail: () => {}
    })
  },
  pipeGo(e) {
    const t = e.currentTarget.dataset.tab || 'ar'
    const g = ({ ar: 'bill', ap: 'bill', expense: 'bill', import: 'bill', report: 'stat', asset: 'stat', history: 'stat', contact: 'me' })[t] || 'home'
    this.setData({ tab: t, group: g })
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
    this.enterTab(t)
  },
  // 设置页「🩺 体检一下」：把明细摊开给人看（首页那条健康分条用上面的 loadHealth）
  loadHealthDetail() {
    this.req({
      url: API_BASE + '/health-check?fresh=1',
      success: (res) => {
        const r = res.data || {}
        if (!r.items) return
        this.setData({ health: r, health_done: true, hc: { score: r.score, grade: r.grade, clean: r.clean, count: r.count, delta: r.delta || 0, items: r.items } })
        wx.showToast({ title: r.clean ? '体检全部通过' : '有 ' + r.count + ' 项要补', icon: 'none' })
      }
    })
  },
  // 📋 体检报告单：分数曲线 + 每项问题哪天发现、哪天修好
  loadHealthReport() {
    this.req({
      url: API_BASE + '/health-report?days=180',
      success: (res) => {
        const r = res.data || {}
        if (!r.ok) { wx.showToast({ title: (r && r.error) || '取不到报告单', icon: 'none' }); return }
        this.setData({ hr: r, hr_open: true })
      }
    })
  },
  closeHealthReport() { this.setData({ hr_open: false }) },
  copyHealthReport() {
    const r = this.data.hr
    if (!r) return
    const L = []
    L.push('【账本体检报告单】' + (r.at || '').slice(0, 10))
    L.push('现在 ' + r.score + ' 分 · ' + r.grade + (r.delta ? '（比上次 ' + (r.delta > 0 ? '+' : '') + r.delta + '）' : ''))
    if (r.spark) L.push('分数变化：' + r.spark)
    for (const x of (r.sentences || [])) L.push('· ' + x)
    if ((r.open || []).length) {
      L.push('—— 还没改 ——')
      for (const x of r.open) L.push('· ' + x.label + '（' + x.count + ' 处，' + (x.since || '') + ' 起，' + (x.days_open > 0 ? '已 ' + x.days_open + ' 天' : '今天刚出现') + '）')
    }
    if ((r.fixed || []).length) {
      L.push('—— 已经修好 ——')
      for (const x of r.fixed) L.push('· ' + x.label + '：' + (x.fixed || ''))
    }
    wx.setClipboardData({ data: L.join('\n') })
  },
  openHealthPrint() {
    const r = this.data.hr
    if (!r || !r.url) return
    wx.setClipboardData({
      data: API_BASE + r.url,
      success: () => wx.showModal({ title: '打印页链接已复制', content: '粘贴到浏览器打开，可以直接打印或存成 PDF。', showCancel: false })
    })
  },
  loadErrorLog() {
    this.req({
      url: API_BASE + '/error-log?days=7',
      success: (res) => {
        const r = res.data || {}
        this.setData({ err_shown: true, err_days: r.days || 7, err_count: r.count || 0, err_groups: r.grouped || [], err_rows: r.rows || [] })
      }
    })
  },
  clearErrorLog() {
    wx.showModal({
      title: '清空报错记录',
      content: '清空后如果还报错会重新记。继续？',
      success: (x) => {
        if (!x.confirm) return
        this.req({
          url: API_BASE + '/error-log',
          method: 'DELETE',
          success: () => this.setData({ err_shown: false, err_count: 0, err_groups: [], err_rows: [] })
        })
      }
    })
  },
  loadSlowLog() {
    this.req({
      url: API_BASE + '/slow-log?days=7',
      success: (res) => {
        const r = res.data || {}
        this.setData({ slow: r, slow_shown: true })
      }
    })
  },
  closeSlowLog() { this.setData({ slow_shown: false }) },
  copySlowLog() {
    const r = this.data.slow
    if (!r) return
    const lines = [r.text]
    ;(r.rows || []).slice(0, 20).forEach((x) => lines.push(`${x.method} ${x.path}  最慢 ${x.max}ms  平均 ${x.avg}ms  ${x.cnt} 次  最近 ${x.last}`))
    ;(r.advice || []).forEach((t) => lines.push('· ' + t))
    wx.setClipboardData({ data: lines.join('\n'), success: () => wx.showToast({ title: '已复制' }) })
  },
  explainProfit() {
    const d = this.data
    wx.showModal({
      title: '这个「本月净利」怎么算的',
      content: `本月接单 ¥${d.month_order_add || 0}\n− 材料·外协成本 ¥${d.month_mat_cost || 0}\n− 现金支出（工资水电房租等）¥${d.month_expense_cash || 0}\n− 摊销 ¥${d.month_amort || 0} − 折旧 ¥${d.month_dep || 0} − 预提利息 ¥${d.month_accrue_int || 0}\n= 净利 ¥${d.profit_biz || 0}\n\n赊购（欠供应商的货款）只算到「我欠别人」里，不重复扣一次成本。想按付钱算，看报表页「两口径」。`,
      showCancel: false,
      confirmText: '知道了'
    })
  },
  goRem(e) {
    const t0 = e.currentTarget.dataset.tab
    const t = ({ nw: 'asset', home: 'report' })[t0] || t0 || 'home'
    const g = ({ ar: 'bill', ap: 'bill', expense: 'bill', import: 'bill', report: 'stat', asset: 'stat', history: 'stat', contact: 'me' })[t] || 'home'
    this.setData({ tab: t, group: g })
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
    if (t === 'ar') this.setData({ ar_filter: 'overdue' })
    if (t === 'ap') this.setData({ ap_filter: 'overdue' })
    this.enterTab(t)
  },
  setTab(e) {
    const t = e.currentTarget.dataset.t
    const g = ({ ar: 'bill', ap: 'bill', expense: 'bill', import: 'bill', report: 'stat', asset: 'stat', history: 'stat', contact: 'me', home: 'home' })[t] || 'home'
    this.setData({ tab: t, group: g })
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
    this.enterTab(t)
  },
  // 首页三个大按钮：直接跳过去，少点两次
  quickGo(e) {
    const t = e.currentTarget.dataset.t
    if (t) this.setTab({ currentTarget: { dataset: { t } } })
  },
  // 「💰 收钱」以前和「＋ 记一笔应收」是同一个动作，点下去直接落到「记应收」表单，
  // 最坏会把已经收到的钱记成一张新欠条。现在它只负责跳到「未结清」列表并提示怎么收。
  // 「💰 收钱」：先切到应收未结清，再报「一共几张、多少钱」。
  // 以前是拿列表里已经加载的前 60 条现算，客户一多就少报（金额和笔数都不对）。
  goCollect() {
    this.setData({ tab: 'ar', group: 'bill', ar_filter: 'open' })
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
    this.enterTab('ar')
    const say = (d) => {
      const n = Number((d && d.open_count) || 0)
      const t = Number((d && d.open_amount) || 0)
      wx.showToast({
        title: n ? `共 ${n} 张没结清，合计 ¥${Math.round(t * 100) / 100}；点「整户收款」一次收清` : '现在没有未结清的单',
        icon: 'none',
        duration: 2600
      })
    }
    const cached = this.data.ar_sum || {}
    if (cached.open_count !== undefined) return say(cached)
    this.req({ url: API_BASE + '/ar-summary?type=ar', silent: true, success: (res) => { const d = res.data || {}; this.setData({ ar_sum: d }); say(d) } })
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
    this.loadSupplyPrice()
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
  // 常用面额：点一下 = 把金额设成这个数（以前是往上**加**：想从 8000 改成 2000，
  // 点一下变 10000，直接记上去了）
  fillAmt(e) {
    const { f, v } = e.currentTarget.dataset
    this.setData({ [f]: String(v) })
  },
  // 再来一单：把上次同样的客户/产品/单价带出来
  againOrder(e) {
    const id = e.currentTarget.dataset.id
    const it = (this._arAll || []).find((x) => String(x.id) === String(id)) || {}
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
    const it = (this._apAll || []).find((x) => String(x.id) === String(id)) || {}
    this.req({
      url: API_BASE + '/last-deal?type=ap&party=' + encodeURIComponent(it.supplier || ''),
      success: (r) => {
        const d = r.data || {}
        this.setData({
          p_supplier: it.supplier || '', p_amount: String(d.amount || it.amount || ''),
          p_remark: d.item || it.remark || '', p_operator: d.operator || it.operator || '', p_due: '', p_date: '',
          p_category: it.category || ''
        })
        wx.pageScrollTo({ scrollTop: 0, duration: 200 })
        wx.showToast({ title: '填好了，核对后记一笔', icon: 'none' })
      }
    })
  },
  onOItem(e) { this.setData({ o_item: e.detail.value }) },
  onOPrice(e) { this.setData({ o_price: e.detail.value }); this.priceWarn(e.detail.value) },
  onOPriceBlur() { this.costHint() },
  onOCost(e) { this.setData({ o_cost: e.detail.value }) },
  onOCostBlur() { this.costHint() },
  onODue(e) { this.setData({ o_due: e.detail.value }) },
  onODeliver(e) { this.setData({ o_deliver: e.detail.value }) },
  onOOperator(e) { this.setData({ o_operator: e.detail.value }) },
  pickCustomer(e) { const n = e.currentTarget.dataset.n; this.setData({ o_customer: n }); this.applyLastDeal('ar', n) },
  // 应收分类：客户为什么给这笔钱。点一下选中，再点一下取消。
  pickArCat(e) {
    const k = String(e.currentTarget.dataset.k || '')
    this.setData({ o_ar_cat: this.data.o_ar_cat === k ? '' : k })
  },
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
  // 这张单是含税价还是不含税价（税率不固定，13/9/6/3/1 都见过，自己填）
  pickOTax(e) {
    const k = String(e.currentTarget.dataset.k || '')
    const d = { o_tax_kind: this.data.o_tax_kind === k ? '' : k }
    if (!d.o_tax_kind) d.o_tax_rate = ''
    const c = this._taxCalc(d.o_tax_kind, d.o_tax_kind ? this.data.o_tax_rate : '', this.data.o_price)
    d.o_tax_hint = c ? ('税额 ¥' + c.tax + '，不含税 ¥' + c.net) : ''
    try { wx.setStorageSync('tax_kind_ar', d.o_tax_kind || '') } catch (e2) {}
    this.setData(d)
  },
  onOTaxRate(e) {
    const r = e.detail.value
    const c = this._taxCalc(this.data.o_tax_kind, r, this.data.o_price)
    this.setData({ o_tax_rate: r, o_tax_hint: c ? ('税额 ¥' + c.tax + '，不含税 ¥' + c.net) : '' })
  },
  pickPTax(e) {
    const k = String(e.currentTarget.dataset.k || '')
    const d = { p_tax_kind: this.data.p_tax_kind === k ? '' : k }
    if (!d.p_tax_kind) d.p_tax_rate = ''
    const c = this._taxCalc(d.p_tax_kind, d.p_tax_kind ? this.data.p_tax_rate : '', this.data.p_amount)
    d.p_tax_hint = c ? ('税额 ¥' + c.tax + '，不含税 ¥' + c.net) : ''
    try { wx.setStorageSync('tax_kind_ap', d.p_tax_kind || '') } catch (e2) {}
    this.setData(d)
  },
  onPTaxRate(e) {
    const r = e.detail.value
    const c = this._taxCalc(this.data.p_tax_kind, r, this.data.p_amount)
    this.setData({ p_tax_rate: r, p_tax_hint: c ? ('税额 ¥' + c.tax + '，不含税 ¥' + c.net) : '' })
  },
  // 算给用户看一眼：这张单里含多少税、不含税是多少
  _taxCalc(kind, rate, total) {
    const t = Number(total) || 0
    const r = Number(rate) || 0
    if (!t || !r) return null
    const tax = kind === '含税' ? Math.round((t - t / (1 + r / 100)) * 100) / 100 : Math.round((t * r) / 100) * 1
    const net = kind === '含税' ? Math.round((t - tax) * 100) / 100 : t
    return { tax, net }
  },
  addOrder() {
    const { o_customer, o_item, o_price, o_cost, o_due, o_deliver, o_operator, o_date } = this.data
    if (!o_customer) return wx.showToast({ title: '客户必填', icon: 'none' })
    const priceN = this.toAmount(o_price)
    if (priceN === null || priceN <= 0) return wx.showToast({ title: '金额只能填数字（8000 或 8,000）', icon: 'none' })
    const costN = String(o_cost === null || o_cost === undefined ? '' : o_cost).trim() === '' ? 0 : this.toAmount(o_cost)
    if (costN === null) return wx.showToast({ title: '成本只能填数字，不填就留空', icon: 'none' })
    this.req({
      url: API_BASE + '/orders', method: 'POST', once: 'add-order', dupRetry: true, queue: '记应收',
      queued: () => this.setData({ o_customer: '', o_item: '', o_price: '', o_cost: '', o_due: '', o_deliver: '', o_date: '', last_tip: '', o_ar_cat: '' }),
      data: { customer: o_customer, item_name: o_item, price: priceN, cost: costN, due_date: o_due, deliver_date: o_deliver, operator: o_operator, date: o_date, ar_cat: this.data.o_ar_cat || '', client_id: this.newCid(), tax_kind: this.data.o_tax_kind || '', tax_rate: Number(this.data.o_tax_rate || 0) },
      success: (res) => {
        // 交货日要清（每单不同），经手人不清（一天里基本是同一个人，清了反而要重打）
        // 分类也要清：下一单可能是别的客户别的事，留着上一次的会把分类记错
        this.setData({ o_customer: '', o_item: '', o_price: '', o_cost: '', o_due: '', o_deliver: '', o_date: '', last_tip: '', o_ar_cat: '' })
        this.refresh({ lite: true }); this.loadSuggest()
        this.showChecks(res)
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
    const { p_supplier, p_amount, p_remark, p_operator, p_due, p_date, p_category } = this.data
    if (!p_supplier) return wx.showToast({ title: '供应商必填', icon: 'none' })
    const pAmt = this.toAmount(p_amount)
    if (pAmt === null || pAmt <= 0) return wx.showToast({ title: '金额只能填数字（8000 或 8,000）', icon: 'none' })
    this.req({
      url: API_BASE + '/payables', method: 'POST', once: 'add-payable', queue: '记应付',
      queued: () => this.setData({ p_supplier: '', p_amount: '', p_remark: '', p_due: '', p_date: '', last_tip: '' }),
      data: { supplier: p_supplier, amount: pAmt, category: p_category, remark: p_remark, operator: p_operator, due_date: p_due, date: p_date, client_id: this.newCid(), tax_kind: this.data.p_tax_kind || '', tax_rate: Number(this.data.p_tax_rate || 0) }, dupRetry: true,
      success: (res) => { this.setData({ p_supplier: '', p_amount: '', p_remark: '', p_operator: '', p_due: '', p_date: '', last_tip: '' }); this.refresh({ lite: true }); this.loadSuggest(); this.showChecks(res) }
    })
  },
  // 「按实发数入账」：不开计件工资时，工资就是「这个月实际发出去多少钱」，
  // 直接记一笔支出（分类=工资）就行——净利、现金流、月报全都认这一笔。
  presetWage() {
    const cats = this.data.categories || []
    const idx = Math.max(0, cats.indexOf('工资'))
    const d = new Date(Date.now() + 8 * 3600 * 1000)
    const m = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0')
    this.setData({ e_category: idx, e_remark: m + ' 工资（实发）' })
    wx.showToast({ title: '填上实发总额，点「记支出」', icon: 'none' })
  },
  addExpense() {
    const { e_amount, e_remark, categories, e_category, e_operator, e_date } = this.data
    const eAmt = this.toAmount(e_amount)
    if (eAmt === null || eAmt <= 0) return wx.showToast({ title: '金额只能填数字（8000 或 8,000）', icon: 'none' })
    this.req({
      url: API_BASE + '/expenses', method: 'POST', dupRetry: true, once: 'add-expense', queue: '记支出',
      queued: () => { wx.setStorageSync('last_cat', e_category); this.setData({ e_amount: '', e_remark: '', e_date: '' }) },
      data: { amount: eAmt, category: categories[e_category], remark: e_remark, operator: e_operator, account_id: this.data.acc_id, date: e_date, client_id: this.newCid() },
      success: () => { wx.setStorageSync('last_cat', e_category); this.setData({ e_amount: '', e_remark: '', e_operator: '', e_date: '' }); this.refresh({ lite: true }); this.loadSuggest() }
    })
  },
  // 记完自查：后端挑出的「可能记错」的地方，一条条摆出来（不影响已记上的账）
  showChecks(res) {
    const list = (res && res.data && res.data.checks) || []
    if (!list.length) return
    wx.showModal({
      title: '记上了，但这几处看一下',
      content: list.map((x, i) => (i + 1) + '. ' + x.text).join('\n\n') + '\n\n（不影响已经记上的账，要改就在列表里点那一条编辑）',
      showCancel: false, confirmText: '知道了'
    })
  },
  // 收付款输入框里的文字：可能是「5000」「5,000」「5000,07-05」「5000元」
  // 以前直接 split(/[,，\s]+/) 取第一段，"5,000" 就变成了 5 —— 少收 4995 也不报错。
  _payText(txt) {
    let t = String(txt || '').trim()
    const dm = t.match(/(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[-/月]\d{1,2}\s*日?)/)
    const date = dm ? dm[0].replace(/[月日]/g, '-').replace(/-+$/, '') : ''
    if (dm) t = t.replace(dm[0], ' ')
    const numTxt = t.replace(/[^\d.]/g, '')
    const amt = numTxt ? Number(numTxt) : 0
    return { amt: Number.isFinite(amt) ? Math.round(amt * 100) / 100 : 0, date }
  },
  // 找某一单还剩多少没结（先从当前列表里查）
  _remainOf(list, id) {
    const it = (list || []).find((x) => String(x.id) === String(id)) || {}
    return Math.max(0, Math.round(Number(it.unpaid || 0) * 100) / 100)
  },
  // ===== 收付款面板 =====
  // 一个输入框问不出「有没有票、这笔里的税多少、这笔是不是单独收的税金」，
  // 所以收/付款改成一块面板：金额、日期、账户、有票没票、税额、只记税金。
  payOrder(e) {
    this.openPay(e, 'ar')
  },
  payPayable(e) {
    this.openPay(e, 'ap')
  },
  openPay(e, kind) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const k = kind || ds.kind || 'ar'
    const id = ds.id
    const list = k === 'ar' ? this._arAll : this._apAll
    const row = (list || []).find((x) => String(x.id) === String(id)) || {}
    const remain = this._remainOf(list, id)
    const accs = this.data.accounts || []
    const acc = accs[this.data.acc_idx] || accs[0] || {}
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
    const name = k === 'ar' ? (row.customer || '') : (row.supplier || '')
    // 不含税的单：货款不动，开票时另外收税点（用户的实际做法）
    const isExcl = String(row.tax_kind || '') === '不含税'
    const sug = isExcl ? Math.round(Number(row.tax_amt || 0) * 100) / 100 : 0
    const inv0 = String(acc.inv_default || '')
    this.setData({
      pay_open: true, pay_kind: k, pay_id: id,
      pay_taxmode: isExcl && sug > 0, pay_extra_sug: sug,
      pay_tax_extra: (isExcl && sug > 0 && inv0 !== 'no') ? String(sug) : '',
      pay_title: (k === 'ar' ? '收 ' : '付 ') + name + (row.item_name ? ' · ' + row.item_name : ''),
      pay_remain: remain,
      pay_amt: ds.all ? String(remain) : '',
      pay_date: today,
      // 账户平时有没有票：工行对公一般有票、农行个人一般没票，跟着账户带出来，可以改
      pay_inv: String(acc.inv_default || ''),
      pay_tax: '', pay_taxonly: false, pay_busy: false
    })
  },
  onPayField(e) {
    const o = {}
    o[e.currentTarget.dataset.f] = e.detail.value
    this.setData(o)
  },
  onPayAcc(e) {
    const i = Number(e.detail.value) || 0
    const a = (this.data.accounts || [])[i] || {}
    this.setData({ acc_idx: i, acc_id: a.id || 0, acc_name: a.name || '', pay_inv: String(a.inv_default || '') })
  },
  pickPayInv(e) {
    const k = String(e.currentTarget.dataset.k || '')
    const now = this.data.pay_inv === k ? '' : k
    const d = { pay_inv: now }
    // 不开票就不收税点（开了票才有税点这回事）
    if (this.data.pay_taxmode) d.pay_tax_extra = now === 'no' ? '' : (now ? String(this.data.pay_extra_sug) : '')
    this.setData(d)
  },
  togglePayTaxOnly() {
    this.setData({ pay_taxonly: !this.data.pay_taxonly })
  },
  closePay() {
    if (this.data.pay_busy) return
    this.setData({ pay_open: false })
  },
  paySettle() {
    const d = this.data
    this.setData({ pay_open: false })
    this._settleByDiff(d.pay_id, d.pay_kind)
  },
  submitPay() {
    const d = this.data
    if (d.pay_busy) return
    const isAr = d.pay_kind === 'ar'
    const num2 = (v) => {
      const n = Number(String(v === null || v === undefined ? '' : v).replace(/[^\d.]/g, ''))
      return Number.isFinite(n) ? n : 0
    }
    const tax = num2(d.pay_tax)
    let amt = num2(d.pay_amt)
    if (d.pay_taxonly) {
      // 单独收付的税金：金额就是税额，原单金额一分不动
      if (!(tax > 0)) return wx.showToast({ title: '先填这笔税金多少', icon: 'none' })
      amt = tax
    } else if (!(amt > 0)) {
      // 金额空着不再默默按「全额」记：她本来想改金额，清空后手一抖点确认，
      // 就把这张单整笔收掉了。要说清楚。
      return wx.showToast({ title: '填一下这次收付多少（整笔收清请点行上的「收清」）', icon: 'none' })
    }
    if (!(amt > 0)) return wx.showToast({ title: '金额不对', icon: 'none' })
    const body = {
      amount: amt, date: d.pay_date, account_id: this.data.acc_id,
      client_id: this.newCid(), inv: d.pay_inv, tax: d.pay_taxonly ? amt : tax
    }
    if (d.pay_taxonly) body.kind = 'tax'
    if (d.pay_taxmode && !d.pay_taxonly) body.tax_extra = num2(d.pay_tax_extra)
    const url = API_BASE + (isAr ? '/orders/' : '/payables/') + d.pay_id + (isAr ? '/receive' : '/pay')
    this.setData({ pay_busy: true })
    this.req({
      url, method: 'POST',
      once: (d.pay_taxonly ? 'tax-' : isAr ? 'receive-' : 'payp-') + d.pay_id,
      queue: isAr ? '收客户款' : '付供应商款',
      data: body,
      success: (res) => {
        const r = res.data || {}
        this.setData({ pay_open: false, pay_busy: false })
        this.refresh({ lite: true })
        if (d.pay_taxonly) {
          wx.showToast({ title: '税金 ' + amt + ' 记好了（不冲这张单）', icon: 'none' })
          return
        }
        if (isAr) this.showChecks(res)
        if (r.over) wx.showToast({ title: '多出的 ' + r.over + ' 元记成' + (isAr ? '预收' : '预付') + '了', icon: 'none' })
        else if (r.tax_extra) wx.showToast({ title: '货款 ' + amt + ' + 税点 ' + r.tax_extra + ' 都记好了', icon: 'none' })
        const left = Math.round((d.pay_remain - amt) * 100) / 100
        this._afterPay(d.pay_id, amt, d.pay_remain, d.pay_kind, left <= 0.005 || !!r.over)
      },
      fail: () => this.setData({ pay_busy: false })
    })
  },
  // 差额抹零：剩下的钱不要了，记一条核销把这张单结清（不进现金流）
  _settleByDiff(id, kind) {
    const isAr = kind === 'ar'
    wx.showModal({
      title: '差额抹零',
      content: (isAr ? '这单剩下的钱' : '这笔剩下的钱') + '当作尾差不要了，记一条核销结清？账上会显示「已核销」，不算收到钱。',
      confirmText: '抹零结清',
      success: (rr) => {
        if (!rr.confirm) return
        this.req({
          url: API_BASE + (isAr ? '/orders/' : '/payables/') + id + (isAr ? '/receive' : '/pay'),
          method: 'POST', once: 'settle-' + id,
          data: { amount: 0, settle: true, account_id: this.data.acc_id, client_id: this.newCid() },
          success: (res) => {
            const d = res.data || {}
            this.refresh({ lite: true })
            wx.showToast({ title: d.settled ? '差额 ' + d.settled + ' 记了核销' : '已结清', icon: 'none' })
            this._offerReceipt(id, kind)
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
      // 「取消」原来等于「差额抹零」= 直接写一笔核销把这张单结掉。
      // 按返回键、点错了、只想先收这一笔，都会静默把差的钱抹掉 —— 单子显示已收清，账上却没这笔钱。
      // 现在取消就是什么都不做；真要抹零走行上单独的「抹零」按钮（会再确认一次）。
      content: (kind === 'ar' ? '这张单还没收完' : '这笔还没付完') + '。现在把剩下的 ' + left + ' 元也记成收/付吗？',
      confirmText: '剩下的也记上', cancelText: '先这样',
      success: (rr) => {
        if (!rr.confirm) return
        this.req({
          url: API_BASE + (kind === 'ar' ? '/orders/' : '/payables/') + id + (kind === 'ar' ? '/receive' : '/pay'), once: 'pay-' + id,
          method: 'POST',
          data: { amount: left, account_id: this.data.acc_id },
          success: () => { this.refresh({ lite: true }); wx.showToast({ title: kind === 'ar' ? '已收清' : '已付清', icon: 'success' }); this._offerReceipt(id, kind) }
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
    const amount = this.toAmount(this.data.rb_amount) || 0
    if (!customer) return wx.showToast({ title: '填客户名称', icon: 'none' })
    if (!(amount > 0)) return wx.showToast({ title: '填收款金额', icon: 'none' })
    wx.showModal({
      title: '批量核销收款',
      content: '收到 ' + customer + ' ¥' + amount + '，将按「先老后新」抵掉未结的单，确定吗？',
      success: (r) => {
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/receive-batch', method: 'POST', once: 'receive-batch',
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
              this.refresh({ lite: true })
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
  // ===== 员工提「改单申请」，老板点同意才生效（第63轮）=====
  openEditReq(e) {
    const kind = e.currentTarget.dataset.kind
    const id = Number(e.currentTarget.dataset.id)
    let row = null
    if (kind === 'ar') row = (this._arAll || []).filter((x) => x.id === id)[0]
    else if (kind === 'ap') row = (this._apAll || []).filter((x) => x.id === id)[0]
    else row = (this.data.expense_list || []).filter((x) => x.id === id)[0]
    if (!row) return wx.showToast({ title: '这张单没找到，下拉刷新再试', icon: 'none' })
    const title = kind === 'ar'
      ? (row.customer || '') + ' · ' + (row.item_name || '加工')
      : kind === 'ap' ? (row.supplier || '') + ' · 应付' : '支出 · ' + (row.category || '')
    this.setData({
      er_open: true, er_kind: kind, er_id: id, er_title: title,
      er_item: kind === 'ar' ? (row.item_name || '') : '',
      er_amount: String(kind === 'ar' ? (row.price || '') : (row.amount || '')),
      er_cost: (kind === 'ar' && row.cost !== null && row.cost !== undefined) ? String(row.cost) : '',
      er_due: (row.due_short || String(row.due_date || '').slice(5, 10) || ''),
      er_operator: row.operator || '', er_remark: row.remark || '', er_cat: row.category || '', er_reason: '',
      er_orig: {
        item_name: String(row.item_name || ''), price: String(row.price === undefined ? '' : row.price),
        cost: row.cost === null || row.cost === undefined ? '' : String(row.cost),
        due: (row.due_short || String(row.due_date || '').slice(5, 10) || ''),
        operator: String(row.operator || ''), amount: String(row.amount === undefined ? '' : row.amount),
        remark: String(row.remark || ''), category: String(row.category || '')
      }
    })
    wx.pageScrollTo({ scrollTop: 0, duration: 200 })
  },
  closeEditReq() { this.setData({ er_open: false, er_reason: '' }) },
  onErItem(e) { this.setData({ er_item: e.detail.value }) },
  onErAmount(e) { this.setData({ er_amount: e.detail.value }) },
  onErCost(e) { this.setData({ er_cost: e.detail.value }) },
  onErDue(e) { this.setData({ er_due: e.detail.value }) },
  onErOperator(e) { this.setData({ er_operator: e.detail.value }) },
  onErRemark(e) { this.setData({ er_remark: e.detail.value }) },
  onErCat(e) { this.setData({ er_cat: e.detail.value }) },
  onErReason(e) { this.setData({ er_reason: e.detail.value }) },
  submitEditReq() {
    const d = this.data
    const kind = d.er_kind
    const ch = {}
    const o = d.er_orig || {}
    const diff = (v, k) => String(v || '') !== String(o[k] === undefined ? '' : o[k])
    if (kind === 'ar') {
      if (d.er_item && diff(d.er_item, 'item_name')) ch.item_name = d.er_item
      if (d.er_amount !== '' && diff(d.er_amount, 'price')) ch.price = d.er_amount
      if (d.er_cost !== '' && diff(d.er_cost, 'cost')) ch.cost = d.er_cost
      if (d.er_due && diff(d.er_due, 'due')) ch.due_date = d.er_due
      if (d.er_operator && diff(d.er_operator, 'operator')) ch.operator = d.er_operator
    } else if (kind === 'ap') {
      if (d.er_amount !== '' && diff(d.er_amount, 'amount')) ch.amount = d.er_amount
      if (d.er_remark && diff(d.er_remark, 'remark')) ch.remark = d.er_remark
      if (d.er_due && diff(d.er_due, 'due')) ch.due_date = d.er_due
    } else {
      if (d.er_amount !== '' && diff(d.er_amount, 'amount')) ch.amount = d.er_amount
      if (d.er_cat && diff(d.er_cat, 'category')) ch.category = d.er_cat
      if (d.er_remark && diff(d.er_remark, 'remark')) ch.remark = d.er_remark
    }
    if (!Object.keys(ch).length) return wx.showToast({ title: '先把要改的地方填上', icon: 'none' })
    this.req({
      url: API_BASE + '/edit-request', method: 'POST',
      data: { kind, id: d.er_id, changes: ch, reason: d.er_reason },
      success: (res) => {
        const r = res.data || {}
        if (!r.ok) return wx.showToast({ title: r.error || '提交没成功', icon: 'none' })
        this.setData({ er_open: false })
        wx.showToast({ title: '申请已提交，等老板同意', icon: 'none' })
        this.loadEditReqs()
      }
    })
  },
  toggleErList() {
    const open = !this.data.er_list_open
    this.setData({ er_list_open: open })
    if (open) this.loadEditReqs()
  },
  loadEditReqs() {
    this.req({
      url: API_BASE + '/edit-requests?status=' + (this.data.role === 'staff' ? 'all' : 'pending'),
      success: (res) => {
        const d = res.data || {}
        const ST = { pending: '等老板处理', ok: '已同意', no: '已驳回' }
        const rows = (d.rows || []).map((r) => Object.assign({}, r, { status_text: ST[r.status] || r.status }))
        this.setData({ ers: rows, er_pending: this.data.role === 'staff' ? 0 : (d.count || 0) })
      }, silent: true
    })
  },
  approveEr(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '同意这次改动？', content: '同意后单据会按申请改掉，操作日志里会留痕。',
      success: (r) => {
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/edit-requests/' + id + '/approve', method: 'POST', data: {},
          success: (res) => {
            const d = res.data || {}
            if (!d.ok) return wx.showToast({ title: d.error || '没改成', icon: 'none' })
            wx.showToast({ title: '改好了', icon: 'success' })
            this.loadEditReqs(); this.refresh({ lite: true })
          }
        })
      }
    })
  },
  rejectEr(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '驳回这条申请', editable: true, placeholderText: '跟员工说一句为什么（可不填）',
      success: (r) => {
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/edit-requests/' + id + '/reject', method: 'POST', data: { note: r.content || '' },
          success: (res) => {
            const d = res.data || {}
            if (!d.ok) return wx.showToast({ title: d.error || '没处理成', icon: 'none' })
            wx.showToast({ title: '已驳回', icon: 'none' })
            this.loadEditReqs()
          }
        })
      }
    })
  },
  // 改应收单：一项一项改。
  // 以前是一个输入框里塞「客户,产品,金额,成本」，客户名里带逗号就错位，
  // 手一抖把 8000 改成别的，客户名就变成了数字、金额变成 0，还不提示。
  // 改一张单：先选「改哪一项」，再单独填这一项。
  // 以前是一个输入框塞「客户,产品,金额,成本」四个字段：客户名里带个逗号就全串位，
  // 改金额顺手多打一个字，客户名就变成数字、金额变 0，还不报错。
  _editFields(fields, url, extra) {
    wx.showActionSheet({
      itemList: fields.map((f) => `改${f.t}（现在 ${f.v || '空'}）`),
      success: (r) => {
        const f = fields[r.tapIndex]
        if (!f) return
        wx.showModal({
          title: '改' + f.t, editable: true, content: f.v,
          placeholderText: f.num ? '只能填数字' : '填新的' + f.t,
          success: (m) => {
            if (!m.confirm) return
            const raw = String(m.content || '').trim()
            const data = Object.assign({}, extra || {})
            if (f.num) {
              const n = Number(raw.replace(/[,，\s元]/g, ''))
              if (!Number.isFinite(n) || n < 0) return wx.showToast({ title: f.t + '要填数字', icon: 'none' })
              data[f.k] = n
            } else {
              if (!raw && !f.empty) return wx.showToast({ title: f.t + '不能空着', icon: 'none' })
              data[f.k] = raw
            }
            this.req({
              url, method: 'PATCH', data,
              success: (res) => {
                const d = res.data || {}
                if (d.error) return wx.showToast({ title: d.error, icon: 'none' })
                wx.showToast({ title: d.changed ? '改好了：' + d.changed : '改好了', icon: 'none' })
                this.refresh({ lite: true })
              }
            })
          }
        })
      }
    })
  },
  editOrder(e) {
    const id = e.currentTarget.dataset.id
    const it = (this._arAll || []).find((x) => x.id === id) || {}
    const fields = [
      { k: 'customer', t: '客户', v: String(it.customer || ''), num: false },
      { k: 'item_name', t: '产品', v: String(it.item_name || ''), num: false },
      { k: 'price', t: '金额', v: String(it.price || 0), num: true },
      { k: 'cost', t: '成本', v: String(it.cost || 0), num: true },
      { k: 'ar_cat', t: '分类', v: String(it.ar_cat || ''), num: false, empty: true }
    ]
    this._editFields(fields, API_BASE + '/orders/' + id, { rev: it.rev })
  },
  editProgress(e) {
    const id = e.currentTarget.dataset.id
    const it = (this._arAll || []).find((x) => x.id === id) || {}
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
              else { wx.showToast({ title: '已更新', icon: 'success' }); this.refresh({ lite: true }) }
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
    const it = (this._apAll || []).find((x) => x.id === id) || {}
    const fields = [
      { k: 'supplier', t: '供应商', v: String(it.supplier || ''), num: false },
      { k: 'amount', t: '金额', v: String(it.amount || 0), num: true },
      { k: 'remark', t: '备注', v: String(it.remark || ''), num: false, empty: true }
    ]
    this._editFields(fields, API_BASE + '/payables/' + id, { rev: it.rev })
  },
  editExpense(e) {
    const id = e.currentTarget.dataset.id
    const it = (this._expAll || []).find((x) => x.id === id) || {}
    const fields = [
      { k: 'amount', t: '金额', v: String(it.amount || 0), num: true },
      { k: 'category', t: '分类', v: String(it.category || ''), num: false },
      { k: 'remark', t: '备注', v: String(it.remark || ''), num: false, empty: true }
    ]
    this._editFields(fields, API_BASE + '/ledger/' + id)
  },
  finishOrder(e) {
    const id = e.currentTarget.dataset.id
    const ds = e.currentTarget.dataset || {}
    const who = ds.who || ''
    // 以前点一下就改状态、没有任何反馈：一行挤了十几个小按钮，点偏了也不知道点上没有
    wx.showModal({
      title: '标记为已交付',
      content: (who ? who + ' 这单' : '这单') + '的货已经交给客户了？标记后会计入「已交付」，不影响收款。',
      confirmText: '已交付',
      success: (r) => {
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/orders/' + id + '/status', method: 'POST', once: 'finish-' + id,
          data: { status: 2 },
          success: (res) => {
            const d = (res && res.data) || {}
            if (d && d.ok === false) return wx.showToast({ title: d.error || '没改成', icon: 'none' })
            wx.showToast({ title: '已标记交付', icon: 'success' })
            this.refresh({ lite: true })
          },
          fail: () => wx.showToast({ title: '网络不好，没提交成功', icon: 'none' })
        })
      }
    })
  },
  delOrder(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除应收单', content: '会连同它的收款记录一起删除。删掉后 30 天内在「设置 → 回收站」还能找回。',
      success: (r) => {
        if (r.confirm) {
          this.req({ url: API_BASE + '/orders/' + id, method: 'DELETE', success: () => this.refresh({ lite: true }) })
        }
      }
    })
  },
  delPayable(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除应付单', content: '会连同它的付款记录一起删除。删掉后 30 天内在「设置 → 回收站」还能找回。',
      success: (r) => {
        if (r.confirm) {
          this.req({ url: API_BASE + '/payables/' + id, method: 'DELETE', success: () => this.refresh({ lite: true }) })
        }
      }
    })
  },
  delExpense(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除支出', content: '删掉后 30 天内在「设置 → 回收站」还能找回。确定删除这条支出？',
      success: (r) => {
        if (r.confirm) {
          this.req({ url: API_BASE + '/ledger/' + id, method: 'DELETE', success: () => this.refresh({ lite: true }) })
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
            this.statementActions(d2, { type, name })
          },
          fail: () => wx.hideLoading()
        })
      }
    })
  },
  // 对账单：选“存图片/直接发对方/复制文字”
  // 记一笔「对账单已发出」（silent=true 不弹提示）
  logStatement(d, ctx, channel, silent) {
    const party = (ctx && ctx.name) || (d && d.party) || ''
    if (!party) return
    const type = (ctx && ctx.type) || (d && d.type) || 'ar'
    const month = (d && d.month) || ''
    this.req({
      url: API_BASE + '/statement-log', method: 'POST',
      data: { party, type, month, channel: channel || '微信', note: '' },
      success: () => { if (!silent) wx.showToast({ title: '已记下这次发送', icon: 'none' }) },
      fail: () => {}
    })
  },
  // 单位页手动补记（当面给纸质单、别人代发等）
  // 某家的对账单送达与回音
  oneLiner(e) {
    const ds = e.currentTarget.dataset || {}
    const party = ds.n || ds.name || ''
    const type = ds.type || this.data.contact_type || 'ar'
    if (!party) return wx.showToast({ title: '没选单位', icon: 'none' })
    this.req({
      url: API_BASE + '/party-balance?type=' + type + '&party=' + encodeURIComponent(party),
      success: (r) => {
        const d = r.data || {}
        if (!d.ok) return wx.showToast({ title: '读取失败', icon: 'none' })
        this.setData({ pbal: d, pbal_type: type })
      }
    })
  },
  closePartyBalance() { this.setData({ pbal: null }) },
  copyPartyBalance() {
    const d = this.data.pbal
    if (!d) return
    wx.setClipboardData({ data: d.text, success: () => wx.showToast({ title: '已复制', icon: 'success' }) })
  },
  // ── 客户画像 ──
  openCustCard(e) {
    const p = e.currentTarget.dataset.p
    if (!p) return
    this.req({
      url: '/customer-card?party=' + encodeURIComponent(p),
      success: (res) => { if (res.data && res.data.ok) this.setData({ cc: res.data }) },
    })
  },
  closeCustCard() { this.setData({ cc: null }) },
  copyCustCard() {
    const cc = this.data.cc
    if (!cc) return
    wx.setClipboardData({ data: cc.text, success: () => wx.showToast({ title: '已复制' }) })
  },
  openStatementFromCard() {
    const cc = this.data.cc
    if (!cc) return
    this.req({
      url: '/statement?type=' + (cc.type || 'ar') + '&name=' + encodeURIComponent(cc.party),
      success: (res) => { if (res.data && res.data.text) this.statementActions(res.data, { type: cc.type || 'ar', name: cc.party }) },
    })
  },
  partyBalanceDetail() {
    const d = this.data.pbal
    if (!d) return
    this.setData({ pbal: null })
    this.contactDetail({ currentTarget: { dataset: { type: d.type, name: d.party } } })
  },
  openStLog(e) {
    const party = e.currentTarget.dataset.p
    this.loadStLog(party)
  },
  loadStLog(party) {
    this.req({
      url: API_BASE + '/statement-log?party=' + encodeURIComponent(party || ''),
      success: (res) => {
        const d = res.data || {}
        this.setData({ st_log: { party, count: d.count || 0, rows: d.rows || [] } })
      }
    })
  },
  ackSt(e) {
    const id = e.currentTarget.dataset.id
    const ack = e.currentTarget.dataset.ack
    const party = this.data.st_log && this.data.st_log.party
    const doIt = (note) => {
      this.req({
        url: API_BASE + '/statement-log/' + id + '/ack', method: 'POST', data: { ack, note: note || '' },
        success: (res) => {
          if (res.data && res.data.ok) {
            wx.showToast({ title: ack === 'ok' ? '已记对方确认' : '已记异议，并记了一笔催款', icon: 'none' })
            this.loadStLog(party)
          } else wx.showToast({ title: (res.data && res.data.error) || '失败', icon: 'none' })
        }
      })
    }
    if (ack === 'doubt') {
      wx.showModal({
        title: '对方说哪里对不上？', editable: true, placeholderText: '例：他说 11 月那笔 800 没收到 / 金额不对',
        success: (r) => { if (r.confirm) doIt(r.content) }
      })
    } else doIt('')
  },
  delSt(e) {
    const id = e.currentTarget.dataset.id
    const party = this.data.st_log && this.data.st_log.party
    wx.showModal({
      title: '删掉这条送达记录？', content: '删了就不算发过（对账单提醒里会重新出现）',
      success: (r) => {
        if (!r.confirm) return
        this.req({ url: API_BASE + '/statement-log/' + id, method: 'DELETE', success: () => this.loadStLog(party) })
      }
    })
  },
  closeStLog() { this.setData({ st_log: null }) },
  copyRcText(e) {
    const t = String(e.currentTarget.dataset.t || '')
    if (!t) return wx.showToast({ title: '没有话术', icon: 'none' })
    wx.setClipboardData({ data: t, success: () => wx.showToast({ title: '话术已复制', icon: 'none' }) })
  },
  openRcUrl(e) {
    const u = String(e.currentTarget.dataset.u || '')
    if (!u) return wx.showToast({ title: '链接没生成', icon: 'none' })
    wx.setClipboardData({
      data: u,
      success: () => wx.showModal({
        title: '打印链接已复制',
        content: '在电脑浏览器里粘贴打开，就能打印或存 PDF 发给对方。',
        showCancel: false
      })
    })
  },
  // 让对方在手机上点一下确认（只读、带签名）
  copyAckLink(e) {
    const party = e.currentTarget.dataset.p
    const type = e.currentTarget.dataset.k === 'ap' ? 'ap' : 'ar'
    if (!party) return
    this.req({
      url: API_BASE + '/statement-ack-link?type=' + type + '&party=' + encodeURIComponent(party),
      success: (res) => {
        const u = (res.data || {}).url
        if (!u) return wx.showToast({ title: '生成不了链接', icon: 'none' })
        wx.setClipboardData({
          data: party + '，这是我这边到今天的对账明细，您点开核一下，对得上点一下就行：\n' + u,
          success: () => wx.showModal({
            title: '确认链接已复制',
            content: '发给对方，他点开能看到自己的账，按一下「对得上」或「有几笔对不上」，你这边自动记下来（报表 → ✅ 对账回执）。',
            showCancel: false
          })
        })
      }
    })
  },
  loadPromiseBook() {
    this.req({
      url: API_BASE + '/promise-book',
      success: (res) => {
        const d = res.data || {}
        if (d.error) return wx.showToast({ title: d.error, icon: 'none' })
        this.setData({ pbook: d })
      }
    })
  },
  closePromiseBook() { this.setData({ pbook: null }) },
  loadStatementAcks() {
    this.req({
      url: API_BASE + '/statement-acks?days=30',
      success: (res) => {
        const d = res.data || {}
        if (d.ok) this.setData({ sacks: d })
      }
    })
  },
  closeStatementAcks() { this.setData({ sacks: null }) },
  rcAll() {
    const rc = this.data.rc || {}
    const list = (rc.overdue_list || []).concat(rc.today_list || [])
    if (!list.length) return wx.showToast({ title: '今天没有到点的', icon: 'none' })
    const txt = list.map((r) => `【${r.party}】${r.left > 0 ? '欠 ¥' + r.left : '已结清'}\n${r.send_text}`).join('\n\n')
    wx.setClipboardData({
      data: txt,
      success: () => wx.showModal({
        title: '这 ' + list.length + ' 家的话术都复制了',
        content: '在微信里按顺序粘贴发出去。发完回到这里点「发好了，记一笔」，日历就变成本月已发。',
        showCancel: false
      })
    })
  },
  logStatementManual(e) {
    const party = e.currentTarget.dataset.p
    const type = e.currentTarget.dataset.k === 'ap' ? 'ap' : 'ar'
    wx.showActionSheet({
      itemList: ['微信发过去', '打印纸质当面给', '别人代发', '其他'],
      success: (r) => {
        const ch = ['微信发过去', '打印纸质当面给', '别人代发', '其他'][r.tapIndex] || '其他'
        this.logStatement({}, { name: party, type }, ch)
      }
    })
  },
  statementActions(d, ctx) {
    wx.showActionSheet({
      itemList: ['存成图片（可保存/转发）', '直接发给对方', '复制文字', '打印页链接（电脑浏览器存 PDF）'],
      success: (r) => {
        if (r.tapIndex === 2) {
          wx.setClipboardData({ data: d.text, success: () => wx.showToast({ title: '已复制', icon: 'none' }) })
          return
        }
        if (r.tapIndex === 3) {
          const party = (ctx && ctx.name) || d.party || ''
          const stype = (ctx && ctx.type) || d.type || 'ar'
          this.logStatement(d, ctx, '打印版链接')
          if (!party) return wx.showToast({ title: '这份对账单没有单位名，改用图片', icon: 'none' })
          wx.showLoading({ title: '生成链接…' })
          this.req({
            url: API_BASE + '/statement-link?type=' + (stype === 'ap' ? 'ap' : 'ar') + '&party=' + encodeURIComponent(party),
            fail: () => wx.hideLoading(),
            success: (res) => {
              wx.hideLoading()
              const u = (res.data || {}).url
              if (!u) return wx.showToast({ title: '没生成出来', icon: 'none' })
              this.copyPrintLink(u)
            }
          })
          return
        }
        this.logStatement(d, ctx, r.tapIndex === 1 ? '微信发对方' : '存图')
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
    const { import_type, import_text } = this.data
    const types = ['ar', 'ap', 'expense', 'loan', 'reimb', 'ar_init', 'ap_init', 'ar_recon', 'ap_recon', 'prepaid', 'parties']
    if (!import_text.trim()) return wx.showToast({ title: '请先粘贴内容', icon: 'none' })
    this._impText = import_text
    wx.showLoading({ title: '看一遍…' })
    this.req({
      url: API_BASE + '/parse-import', method: 'POST',
      data: { type: types[import_type], text: import_text },
      success: (res) => {
        wx.hideLoading()
        const d = res.data || {}
        if (!d.count) return wx.showToast({ title: '一行都没看懂，检查下格式', icon: 'none' })
        d.new_text = (d.new_parties || []).join('、')
        this.setData({ import_preview: d, recon: null })
      },
      fail: () => wx.hideLoading()
    })
  },
  confirmImport() {
    const { import_preview } = this.data
    const good = ((import_preview && import_preview.rows) || []).filter((r) => r.ok)
    this.postImportRows(good, false)
  },
  // Excel 文件入账；命中「同家同额 7 天内已记过」时先问一句
  // 导入前先看一眼：这个表认出了什么、哪几行有问题、哪几行像重复
  previewXlsx(type, b64) {
    const names = { ar: '应收（客户欠我）', ap: '应付（我欠别人）', expense: '支出', loan: '员工借支', reimb: '报销', ar_init: '期初应收', ap_init: '期初应付' }
    this._xb64 = b64
    // 大文件走切片上传，之后真导用同一个 upload_id（几 MB 不必再发一遍）
    this.filePayload(b64, '', (e2, payload) => {
    if (e2) { wx.hideLoading(); return wx.showToast({ title: e2, icon: 'none' }) }
    this._xPayload = payload
    this._xb64 = payload.b64 || ''
    this.req({
      url: API_BASE + '/import-xlsx', method: 'POST',
      data: Object.assign({ type, preview: true }, payload),
      success: (res) => {
        wx.hideLoading()
        const d = res.data || {}
        if (d.error) return wx.showToast({ title: d.error, icon: 'none' })
        const rows = (d.rows || []).map((r) => Object.assign({}, r, { drop: false }))
        this.setData({
          xp: {
            type, type_name: names[type] || type, rows,
            count: d.count || 0, ok_count: d.ok_count || 0, bad_count: d.bad_count || 0,
            dup_count: d.dup_count || 0, locked_count: d.locked_count || 0,
            total: d.total || 0, text: d.text || '', header_skipped: d.header_skipped
          },
          xp_open: true
        })
        if (!rows.length) wx.showToast({ title: '这个表里没认出数据行', icon: 'none' })
      },
      fail: () => wx.hideLoading()
    })
    })
  },
  dropXpRow(e) {
    const i = Number(e.currentTarget.dataset.i)
    const rows = (this.data.xp && this.data.xp.rows) || []
    if (!rows[i]) return
    rows[i].drop = !rows[i].drop
    this.setData({ 'xp.rows': rows })
  },
  closeXlsxPreview() { this.setData({ xp_open: false, xp: null }) },
  confirmXlsx() {
    const xp = this.data.xp || {}
    const rows = xp.rows || []
    const keep = rows.filter((r) => !r.drop && r.ok && !r.locked)
    if (!keep.length) return wx.showToast({ title: '没有可以导入的行', icon: 'none' })
    const skip = rows.filter((r) => r.drop).map((r) => r.i)
    const dupKeep = keep.filter((r) => r.dup).length
    const go = (force) => {
      wx.showLoading({ title: '导入中…' })
      this.setData({ xp_open: false })
      this.postXlsx(xp.type, this._xb64, force, skip)
    }
    if (dupKeep) {
      return wx.showModal({
        title: '这 ' + dupKeep + ' 条系统里已经有一样的',
        content: '同一家、同一金额、7 天内已经记过。多半是重复导入，建议这次跳过；确实还没记过就点「一起导入」。',
        confirmText: '一起导入', cancelText: '跳过这些',
        success: (m) => {
          if (m.confirm) return go(true)
          const skip2 = skip.concat(keep.filter((r) => r.dup).map((r) => r.i))
          wx.showLoading({ title: '导入中…' })
          this.setData({ xp_open: false })
          this.postXlsx(xp.type, this._xb64, false, skip2)
        }
      })
    }
    go(false)
  },
  postXlsx(type, b64, force, skip) {
    this.req({
      url: API_BASE + '/import-xlsx', method: 'POST',
      data: Object.assign({ type, confirm_dup: !!force, skip: skip || [] }, this._xPayload || { b64 }),
      success: (res) => {
        wx.hideLoading()
        const d = res.data || {}
        if (d.error) return wx.showToast({ title: d.error, icon: 'none' })
        const dup = d.dup || []
        if (dup.length && !force) {
          const lines = dup.slice(0, 5).map((x) => x.party + ' ' + x.amount + ' 元' + (x.date ? '（' + x.date + ' 已记过）' : '')).join('\n')
          return wx.showModal({
            title: '导入 ' + (d.imported || 0) + ' 条，' + dup.length + ' 条像重复',
            content: lines + '\n\n这些先没进账。确实还没记过就点「仍然导入」。',
            confirmText: '仍然导入', cancelText: '先不导',
            success: (m) => { if (m.confirm) this.postXlsx(type, b64, true, skip); else this.refresh() }
          })
        }
        wx.showModal({
          title: '导入完成',
          content: '成功导入 ' + (d.imported || 0) + ' 条' + (d.skipped_locked ? '，跳过已结账月份 ' + d.skipped_locked + ' 条' : '') + (dup.length ? '，跳过重复 ' + dup.length + ' 条' : '') + '。金额和客户名请在列表里抽两条核对。',
          showCancel: false,
          success: () => this.refresh()
        })
      },
      fail: () => wx.hideLoading()
    })
  },
  // 入账；dup 不空时先问一句「好像记过了」，再决定是否强制导入
  postImportRows(good, force) {
    const { import_type } = this.data
    const types = ['ar', 'ap', 'expense', 'loan', 'reimb', 'ar_init', 'ap_init', 'ar_recon', 'ap_recon', 'prepaid', 'parties']
    this.req({
      url: API_BASE + '/import-rows', method: 'POST',
      data: { type: types[import_type], rows: good, text: this._impText || '', confirm_dup: !!force },
      success: (res) => {
        const d = res.data || {}
        const n = d.imported || 0
        const dup = d.dup || []
        if (dup.length && !force) {
          const lines = dup.slice(0, 5).map((x) => x.party + ' ' + x.amount + ' 元' + (x.date ? '（' + x.date + ' 已记过）' : '')).join('\n')
          return wx.showModal({
            title: '这 ' + dup.length + ' 条好像记过了',
            content: '同一家、同一金额、7 天内已经有一笔：\n' + lines + '\n\n多半是重复粘贴。确定要再导一次吗？',
            confirmText: '仍然导入', cancelText: '跳过这些',
            success: (m) => {
              if (m.confirm) this.postImportRows(good.map((r) => Object.assign({}, r, { confirm: true })), true)
              else { wx.showToast({ title: '已跳过重复 ' + dup.length + ' 条', icon: 'none' }); this.setData({ import_text: '', import_preview: null }); this.refresh() }
            }
          })
        }
        wx.showToast({ title: '已入账 ' + n + ' 条' + (dup.length ? '，跳过重复 ' + dup.length : ''), icon: 'none' })
        this.setData({ import_text: '', import_preview: null })
        this.refresh()
      }
    })
  },
  cancelPreview() { this.setData({ import_preview: null }) },
  // 对账差异一键处理：我少记的那笔直接补一张单，不用再手工录
  reconType() {
    const it = this.data.import_type
    return (it === 1 || it === 3 || it === 6) ? 'ap' : 'ar'
  },
  reconFixAdd(e) {
    const r = ((this.data.recon || {}).rows || [])[e.currentTarget.dataset.i]
    if (!r) return
    const type = this.reconType()
    const amt = Math.abs(Number(r.imported || 0) - Number(r.system || 0))
    const month = (this.data.recon || {}).month || ''
    wx.showModal({
      title: '补记这一笔',
      content: `给「${r.party}」补记 ${type === 'ap' ? '应付' : '应收'} ${amt} 元，记在 ${month} 月（到期日按这家账期自动算）。`,
      confirmText: '补记',
      success: (res) => {
        if (!res.confirm) return
        this.req({
          url: API_BASE + '/recon-fix', method: 'POST',
          data: { type, party: r.party, amount: amt, month, mode: 'add', imported: r.imported, system: r.system, state: r.state },
          success: (res2) => {
            const d = res2.data || {}
            if (!d.ok) return wx.showToast({ title: d.error || '没补成', icon: 'none' })
            wx.showToast({ title: '已补记 ' + amt, icon: 'none' })
            this.markRecon(e.currentTarget.dataset.i, '已补记 ' + amt)
            this.refresh()
          }
        })
      }
    })
  },
  // 我多记了：对方对账单上没有这么多 → 把差额核销掉（不动现金，只抹往来）
  // 对账结论单：这个月该跟谁结、期末多少，一键出话术/打印确认单
  loadReconConcl() {
    const m = this.data.rcc_month || ''
    const type = this.reconType()
    this.req({
      url: API_BASE + '/recon-conclusion?type=' + type + (m ? '&month=' + m : ''),
      success: (res) => {
        const d = res.data || {}
        if (d.error) return wx.showToast({ title: d.error, icon: 'none' })
        this.setData({ rcc: d })
      },
      fail: () => wx.showToast({ title: '取不到对账结论', icon: 'none' })
    })
  },
  onRccMonth(e) { this.setData({ rcc_month: e.detail.value }, () => this.loadReconConcl()) },
  closeReconConcl() { this.setData({ rcc: null }) },
  copyRccOne(e) {
    const i = Number(e.currentTarget.dataset.i)
    const r = ((this.data.rcc || {}).rows || [])[i]
    if (!r) return
    wx.setClipboardData({ data: r.text, success: () => wx.showToast({ title: '结论已复制', icon: 'none' }) })
  },
  copyRccAll() {
    const d = this.data.rcc || {}
    if (!d.all_text) return wx.showToast({ title: '没有要发的', icon: 'none' })
    wx.setClipboardData({ data: d.all_text, success: () => wx.showToast({ title: '全部结论已复制', icon: 'none' }) })
  },
  openReconPrint(e) {
    const i = Number(e.currentTarget.dataset.i)
    const r = ((this.data.rcc || {}).rows || [])[i]
    const d = this.data.rcc || {}
    if (!r) return
    const type = this.reconType()
    this.req({
      url: API_BASE + '/recon-print-link?type=' + type + '&month=' + (d.month || '') + '&party=' + encodeURIComponent(r.party),
      success: (res) => {
        const u = (res.data || {}).url
        if (!u) return wx.showToast({ title: '生成不了链接', icon: 'none' })
        wx.setClipboardData({
          data: u,
          success: () => wx.showModal({
            title: '打印版链接已复制',
            content: '在电脑浏览器里粘贴打开就能打印/存 PDF；也可以直接发给对方看。\n链接只能看这一家这个月，改了字符就失效。',
            showCancel: false
          })
        })
      }
    })
  },
  markReconConfirmed(e) {
    const i = Number(e.currentTarget.dataset.i)
    const r = ((this.data.rcc || {}).rows || [])[i]
    const d = this.data.rcc || {}
    if (!r) return
    wx.showModal({
      title: '对方确认了？',
      content: `记下：${r.party} ${d.month} 期末 ${r.end} 元已核对确认。以后有争议这就是证据。`,
      confirmText: '记下',
      success: (res) => {
        if (!res.confirm) return
        this.req({
          url: API_BASE + '/recon-confirm', method: 'POST',
          data: { type: this.reconType(), month: d.month, party: r.party },
          success: () => { wx.showToast({ title: '已记下确认', icon: 'none' }); this.loadReconConcl() }
        })
      }
    })
  },
  reconFixCut(e) {
    const r = ((this.data.recon || {}).rows || [])[e.currentTarget.dataset.i]
    if (!r) return
    const type = this.reconType()
    const gap = Math.abs(Number(r.system || 0) - Number(r.imported || 0))
    const month = (this.data.recon || {}).month || ''
    if (!(gap > 0)) return wx.showToast({ title: '这家没有差额', icon: 'none' })
    wx.showModal({
      title: '核销差额',
      content: `我这边记 ${r.system} 元，对方单上只有 ${r.imported} 元，差 ${gap.toFixed(2)} 元。\n核销掉这 ${gap.toFixed(2)} 元（当作对方不认这笔），现金不动，只把「别人欠我」抹平。`,
      confirmText: '核销差额',
      success: (res) => {
        if (!res.confirm) return
        this.req({
          url: API_BASE + '/recon-fix', method: 'POST',
          data: { type, party: r.party, amount: 0, month, mode: 'cut', gap, imported: r.imported, system: r.system, state: r.state },
          success: (res2) => {
            const d = res2.data || {}
            if (!d.ok) return wx.showToast({ title: d.error || '没核销成', icon: 'none' })
            const msg = d.cut_left > 0.005 ? `核销了 ${d.cut_amount}，还差 ${d.cut_left} 没核销（单子不够）` : '已核销差额 ' + d.cut_amount
            wx.showToast({ title: msg, icon: 'none' })
            this.markRecon(e.currentTarget.dataset.i, '已核销差额 ' + d.cut_amount)
            this.refresh()
          }
        })
      }
    })
  },
  reconFixIgnore(e) {
    const r = ((this.data.recon || {}).rows || [])[e.currentTarget.dataset.i]
    if (!r) return
    const type = this.reconType()
    const month = (this.data.recon || {}).month || ''
    this.req({
      url: API_BASE + '/recon-fix', method: 'POST',
      data: { type, party: r.party, amount: 0, month, mode: 'ignore', imported: r.imported, system: r.system, state: r.state },
      success: () => {
        wx.showToast({ title: '已标记处理完', icon: 'none' })
        this.markRecon(e.currentTarget.dataset.i, '不用补')
        this.loadReconLog()
      }
    })
  },
  reconFixAll() {
    const all = (this.data.recon || {}).rows || []
    const rows = all.filter((x) => x.state === 'more' || x.state === 'less' || x.state === 'new')
    if (!rows.length) return wx.showToast({ title: '没有要处理的差异', icon: 'none' })
    const type = this.reconType()
    const month = (this.data.recon || {}).month || ''
    const nAdd = rows.filter((x) => x.state === 'more' || x.state === 'new').length
    const nCut = rows.filter((x) => x.state === 'less').length
    const addAmt = rows.filter((x) => x.state === 'more').reduce((a, x) => a + Math.abs(Number(x.imported || 0) - Number(x.system || 0)), 0)
    const newAmt = rows.filter((x) => x.state === 'new').reduce((a, x) => a + Number(x.imported || 0), 0)
    const cutAmt = rows.filter((x) => x.state === 'less').reduce((a, x) => a + Math.abs(Number(x.system || 0) - Number(x.imported || 0)), 0)
    const lines = []
    if (nAdd) lines.push(`补记 ${nAdd} 家（共 ¥${(addAmt + newAmt).toFixed(2)}）`)
    if (nCut) lines.push(`核销差额 ${nCut} 家（共 ¥${cutAmt.toFixed(2)}）`)
    wx.showModal({
      title: '一次处理完',
      content: `给 ${rows.length} 家按差异处理：\n${lines.join('\n')}\n\n补记 = 我少记的补一张单；核销 = 我多记的把差额抹掉（现金不动）。都记在 ${month} 月。`,
      confirmText: '开始处理',
      success: (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '处理中…' })
        this.req({
          url: API_BASE + '/recon-fix-batch', method: 'POST',
          data: { type, month, rows },
          success: (r2) => {
            wx.hideLoading()
            const d = r2.data || {}
            if (!d.ok) return wx.showToast({ title: d.error || '没处理成', icon: 'none' })
            wx.showModal({
              title: '处理完了',
              content: (d.text || '') + '\n台账已经记上了，单据可以在应收/应付里核对。',
              showCancel: false,
              success: () => { this.setData({ recon: null }); this.refresh(); this.loadReconLog() }
            })
          },
          fail: () => wx.hideLoading()
        })
      }
    })
  },
  markRecon(i, text) {
    const rc = this.data.recon || {}
    const rows = (rc.rows || []).slice()
    if (rows[i]) rows[i] = Object.assign({}, rows[i], { state: 'match', state_text: text, bad: false })
    const left = rows.filter((x) => x.state === 'more' || x.state === 'less' || x.state === 'new').length
    this.setData({ recon: Object.assign({}, rc, { rows, add_count: left }) })
  },
  // 把这次核对结果记进对账台账（月底能看谁对过、还差几家没处理）
  saveRecon() {
    const { recon, import_type } = this.data
    if (!recon || !recon.rows || !recon.rows.length) return wx.showToast({ title: '先核对一次', icon: 'none' })
    const type = (import_type === 1 || import_type === 3 || import_type === 6) ? 'ap' : 'ar'
    this.req({
      url: API_BASE + '/recon-save', method: 'POST',
      data: { type, month: (recon.month || ''), rows: recon.rows },
      success: (res) => {
        const d = res.data || {}
        wx.showToast({ title: '已记入台账 ' + (d.saved || 0) + ' 家', icon: 'none' })
        this.loadReconLog()
      }
    })
  },
  loadReconLog() {
    this.req({
      url: API_BASE + '/recon-log',
      success: (res) => {
        const d = res.data || {}
        const rows = (d.rows || []).map((r) => {
          let st = '一致'
          if (r.state === 'more') st = '我少记 ' + r.diff
          else if (r.state === 'less') st = '我多记 ' + Math.abs(r.diff)
          else if (r.state === 'new') st = '没这家'
          return Object.assign({}, r, { state_text: st, bad: r.state !== 'match' && !r.done, done_text: r.done ? '已处理' : '待处理' })
        })
        this.setData({ recon_log: { rows, months: d.months || [], open_diff: d.open_diff || 0 } })
      }
    })
  },
  // 导入记录（每批留痕，导错了整批撤回）
  loadImportLog() {
    const kinds = { ar: '应收', ap: '应付', expense: '支出', loan: '借支', reimb: '报销', ar_init: '期初应收', ap_init: '期初应付' }
    this.req({
      url: API_BASE + '/import-log',
      success: (res) => {
        const rows = ((res.data && res.data.rows) || []).map((r) => Object.assign({}, r, {
          kind_text: kinds[r.type] || r.type,
          time_text: String(r.created_at || '').replace('T', ' ').slice(5, 16),
          src_text: r.src === 'excel' ? 'Excel' : r.src === 'preview' ? '预览后入账' : '粘贴'
        }))
        this.setData({ import_log: { rows } })
      }
    })
  },
  // 这批到底导了哪几笔、现在什么状态
  loadImportBatch(e) {
    const r = ((this.data.import_log || {}).rows || [])[e.currentTarget.dataset.i]
    if (!r) return
    const kinds = { ar: '应收', ap: '应付', expense: '支出', loan: '借支', reimb: '报销' }
    this.req({
      url: API_BASE + '/import-log/' + r.id,
      success: (res) => {
        const d = res.data || {}
        if (d.error) { wx.showToast({ title: d.error, icon: 'none' }); return }
        const rows = (d.rows || []).map((x) => Object.assign({}, x, { kind_text: kinds[x.kind] || x.kind }))
        this.setData({
          imp_docs: Object.assign({}, d, {
            rows,
            at_text: String(d.created_at || '').replace('T', ' ').slice(5, 16) + ' 导入的'
          })
        })
      }
    })
  },
  closeImpDocs() { this.setData({ imp_docs: null }) },
  undoImport(e) {
    const r = ((this.data.import_log || {}).rows || [])[e.currentTarget.dataset.i]
    if (!r) return
    wx.showModal({
      title: '撤回这一批导入？',
      content: '把这批导入的 ' + r.cnt + ' 条（' + r.total + ' 元）删掉。已经收过款/付过款的不动，会告诉你有几条没撤。',
      confirmText: '撤回', confirmColor: '#c00',
      success: (m) => {
        if (!m.confirm) return
        this.req({
          url: API_BASE + '/import-undo/' + r.id, method: 'POST', data: {},
          success: (res) => {
            const d = res.data || {}
            wx.showModal({
              title: '撤回完成',
              content: '删掉 ' + (d.deleted || 0) + ' 条' + (d.skipped ? '，跳过 ' + d.skipped + ' 条（' + (d.reason || '') + '）' : ''),
              showCancel: false,
              success: () => { this.loadImportLog(); this.refresh() }
            })
          }
        })
      }
    })
  },
  delImportLog(e) {
    const r = ((this.data.import_log || {}).rows || [])[e.currentTarget.dataset.i]
    if (!r) return
    wx.showModal({
      title: '删除这条导入记录',
      content: '只删「导入批次」这条记录，已经导进去的账不动。想撤账请用「撤销这次导入」。确定删吗？',
      success: (x) => { if (x.confirm) this.req({ url: API_BASE + '/import-log/' + r.id, method: 'DELETE', success: () => this.loadImportLog() }) }
    })
  },
  // 把「还没处理的差异」复制成一段话，直接发微信给对方
  copyDiffText() {
    const type = (this.data.import_type === 1 || this.data.import_type === 3 || this.data.import_type === 6) ? 'ap' : 'ar'
    this.req({
      url: API_BASE + '/recon-diff-text?type=' + type,
      success: (res) => {
        const t = (res.data && res.data.text) || ''
        wx.setClipboardData({ data: t, success: () => wx.showToast({ title: '已复制，可发给对方', icon: 'none' }) })
      }
    })
  },
  toggleReconDone(e) {
    const r = (this.data.recon_log.rows || [])[e.currentTarget.dataset.i]
    if (!r) return
    this.req({
      url: API_BASE + '/recon-log/' + r.id, method: 'PATCH', data: { done: !r.done },
      success: () => this.loadReconLog()
    })
  },
  loadReconProgress() {
    const type = (this.data.import_type === 1 || this.data.import_type === 3 || this.data.import_type === 6) ? 'ap' : 'ar'
    this.req({
      url: API_BASE + '/recon-progress?type=' + type,
      success: (res) => {
        const d = res.data || {}
        const list = (d.list || []).map((x) => Object.assign({}, x, { bad: x.open_diff > 0 }))
        this.setData({ rec_prog: { list, never: d.never || [], never_count: d.never_count || 0, open_diff: d.open_diff || 0, type_text: type === 'ap' ? '应付' : '应收' } })
      }
    })
  },
  loadReconDunning() {
    const type = (this.data.import_type === 1 || this.data.import_type === 3 || this.data.import_type === 6) ? 'ap' : 'ar'
    this.req({
      url: API_BASE + '/recon-dunning?type=' + type,
      success: (res) => {
        const d = res.data || {}
        this.setData({ rec_dun: { rows: d.rows || [], count: d.count || 0, all_text: d.all_text || '' } })
      }
    })
  },
  copyDunOne(e) {
    const r = ((this.data.rec_dun || {}).rows || [])[e.currentTarget.dataset.i]
    if (!r) return
    wx.setClipboardData({ data: r.text, success: () => wx.showToast({ title: '已复制，粘给' + r.party, icon: 'none' }) })
  },
  copyDunAll() {
    const t = (this.data.rec_dun || {}).all_text || ''
    if (!t) return wx.showToast({ title: '没有要说的差异', icon: 'none' })
    wx.setClipboardData({ data: t, success: () => wx.showToast({ title: '全部差异话术已复制', icon: 'none' }) })
  },
  delReconLog(e) {
    const r = (this.data.recon_log.rows || [])[e.currentTarget.dataset.i]
    if (!r) return
    wx.showModal({
      title: '删掉这条核对记录？', content: '只删台账记录，不动单据。',
      success: (m) => {
        if (!m.confirm) return
        this.req({ url: API_BASE + '/recon-log/' + r.id, method: 'DELETE', success: () => this.loadReconLog() })
      }
    })
  },
  reconView(d) {
    const rows = (d.rows || []).map((r) => {
      let st = '一致'
      if (r.state === 'more') st = '我少记 ' + r.diff
      else if (r.state === 'less') st = '我多记 ' + Math.abs(r.diff)
      else if (r.state === 'new') st = '系统里没这家'
      return Object.assign({}, r, { state_text: st, bad: r.state !== 'match' })
    })
    return Object.assign({}, d, { rows })
  },
  doReconcile() {
    const { import_type, import_text } = this.data
    if (!import_text.trim()) return wx.showToast({ title: '先把对账单粘到上面的框', icon: 'none' })
    const type = (import_type === 1 || import_type === 6 || import_type === 3) ? 'ap' : 'ar'
    wx.showLoading({ title: '核对中…' })
    this.req({
      url: API_BASE + '/reconcile', method: 'POST', data: { type, text: import_text },
      success: (res) => {
        wx.hideLoading()
        const d = res.data || {}
        if (!d.count) return wx.showToast({ title: '没看懂，检查下格式', icon: 'none' })
        this.setData({ recon: this.reconView(d), import_preview: null })
      },
      fail: () => wx.hideLoading()
    })
  },
  // 选对账表格（.xlsx：单位 / 金额 两列）直接核对
  chooseReconFile() {
    const it = this.data.import_type
    const t = (it === 1 || it === 3 || it === 6) ? 'recon_ap' : 'recon'
    if (!wx.chooseMessageFile) return wx.showToast({ title: '微信版本过低，请用粘贴方式', icon: 'none' })
    wx.chooseMessageFile({
      count: 1, type: 'file', extension: ['xlsx', 'XLSX'],
      success: (r) => {
        const f = (r.tempFiles || [])[0]
        if (!f) return
        if (f.size > 3 * 1024 * 1024) return wx.showToast({ title: '文件太大（3MB 以内）', icon: 'none' })
        wx.showLoading({ title: '核对中…' })
        wx.getFileSystemManager().readFile({
          filePath: f.path, encoding: 'base64',
          success: (fr) => {
            this.filePayload(fr.data, f.name || '', (e2, payload) => {
            if (e2) { wx.hideLoading(); return wx.showToast({ title: e2, icon: 'none' }) }
            this.req({
              url: API_BASE + '/import-xlsx', method: 'POST', data: Object.assign({ type: t }, payload),
              success: (res) => {
                wx.hideLoading()
                const d = (res.data && res.data.recon) || null
                if (!d || !d.count) return wx.showToast({ title: (res.data && res.data.error) || '没认出数据', icon: 'none' })
                this.setData({ recon: this.reconView(d), import_preview: null, import_file_name: f.name || '' })
              },
              fail: () => wx.hideLoading()
            })
            })
          },
          fail: () => { wx.hideLoading(); wx.showToast({ title: '读不到这个文件', icon: 'none' }) }
        })
      }
    })
  },
  onReportYear(e) { this.setData({ report_year: e.detail.value }) },
  onPcMonth(e) { this.setData({ pc_month: e.detail.value }) },
  loadTarget() {
    this.req({
      url: API_BASE + '/target',
      success: (res) => { const d = res.data || {}; if (d.ok) this.setData({ tgt: d }) },
      fail: () => {}
    })
  },
  openTargetEdit() {
    const t = this.data.tgt || {}
    this.setData({ tgt_edit: true, tgt_receive: t.receive_target ? String(t.receive_target) : '', tgt_order: t.order_target ? String(t.order_target) : '' })
  },
  closeTargetEdit() { this.setData({ tgt_edit: false }) },
  onTgtReceive(e) { this.setData({ tgt_receive: e.detail.value }) },
  onTgtOrder(e) { this.setData({ tgt_order: e.detail.value }) },
  saveTarget() {
    const r = Number(this.data.tgt_receive || 0)
    const o = Number(this.data.tgt_order || 0)
    if (!(r >= 0) || !(o >= 0)) return wx.showToast({ title: '填数字', icon: 'none' })
    this.req({
      url: API_BASE + '/target', method: 'POST', data: { receive: r, order_add: o },
      success: () => {
        this.setData({ tgt_edit: false })
        wx.showToast({ title: r === 0 && o === 0 ? '目标已取消' : '目标设好了', icon: 'none' })
        this.loadTarget(); this.loadDashboard()
      },
      fail: () => wx.showToast({ title: '存不了，再试一次', icon: 'none' })
    })
  },
  loadTargetHistory() {
    this.req({
      url: API_BASE + '/target-history?months=6',
      success: (res) => {
        const d = res.data || {}
        if (!d.ok) return
        const tips = [{ tone: 'ok', text: d.advice }]
        const rows = d.rows || []
        const curM = rows.length ? rows[rows.length - 1].month : ''
        const miss = rows.filter((x) => x.receive_target > 0 && x.month < curM && !x.hit).slice(-1)[0]
        if (miss) tips.push({ tone: 'warn', text: miss.label + '只收了 ' + miss.receive + ' 元（目标 ' + miss.receive_target + '），差 ' + Math.round((miss.receive_target - miss.receive) * 100) / 100 + ' 元。' })
        this.setData({ th: d, thTips: tips })
      },
      fail: () => wx.showToast({ title: '拿不到，下拉刷新再试', icon: 'none' })
    })
  },
  loadTargetWeeks() {
    this.req({
      url: API_BASE + '/target-weeks',
      success: (res) => { const d = res.data || {}; if (d.ok) this.setData({ tw: d }) },
      fail: () => wx.showToast({ title: '拿不到，下拉刷新再试', icon: 'none' })
    })
  },
  loadTargetForecast() {
    this.req({
      url: API_BASE + '/target-forecast',
      success: (res) => { const d = res.data || {}; if (d.ok) this.setData({ tf: d }) },
      fail: () => wx.showToast({ title: '拿不到，下拉刷新再试', icon: 'none' })
    })
  },
  applySuggest() {
    const sg = (this.data.th && this.data.th.suggest) || {}
    if (!(sg.receive > 0)) return
    wx.showModal({
      title: '设 ' + sg.month + ' 目标',
      content: '收款目标 ' + sg.receive + ' 元' + (sg.order_add > 0 ? '，接单目标 ' + sg.order_add + ' 元' : '') + '。这样设吗？',
      success: (m) => {
        if (!m.confirm) return
        this.req({
          url: API_BASE + '/target?month=' + sg.month, method: 'POST', data: { receive: sg.receive, order_add: sg.order_add || 0 },
          success: () => { wx.showToast({ title: sg.month.slice(5) + '月目标设好了', icon: 'none' }); this.loadTargetHistory(); this.loadTarget() },
          fail: () => wx.showToast({ title: '没存上，再试一次', icon: 'none' })
        })
      }
    })
  },
  loadTrend() {
    this.req({
      url: API_BASE + '/trend?months=6',
      success: (res) => { const d = res.data || {}; if (d.ok) this.setData({ trend: d }) },
      fail: () => wx.showToast({ title: '拿不到，下拉刷新再试', icon: 'none' })
    })
  },
  loadPaySpeed() {
    this.req({
      url: API_BASE + '/pay-speed',
      success: (res) => { const d = res.data || {}; if (d.ok) this.setData({ ps: d }) },
      fail: () => wx.showToast({ title: '拿不到，下拉刷新再试', icon: 'none' })
    })
  },
  loadFlows() {
    const m = (this.data.flows_month || '').trim()
    const kw = (this.data.flows_kw || '').trim()
    const dir = this.data.flows_dir || ''
    const qs = []
    if (m) qs.push('month=' + m)
    if (kw) qs.push('kw=' + encodeURIComponent(kw))
    if (dir) qs.push('dir=' + dir)
    this.req({
      url: API_BASE + '/flows' + (qs.length ? '?' + qs.join('&') : ''),
      success: (res) => { const d = res.data || {}; if (d.ok) this.setData({ flows: d }) },
      fail: () => wx.showToast({ title: '拿不到，下拉刷新再试', icon: 'none' })
    })
  },
  onFlowsMonth(e) {
    let v = String(e.detail.value || '').trim()
    const mm = v.match(/^(\d{4})-(\d{1,2})$/)
    if (mm) v = mm[1] + '-' + mm[2].padStart(2, '0')
    this.setData({ flows_month: v })
  },
  onFlowsKw(e) { this.setData({ flows_kw: e.detail.value }) },
  setFlowsDir(e) { this.setData({ flows_dir: e.currentTarget.dataset.d || '' }, () => this.loadFlows()) },
  delFlow(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删掉这笔？', content: '这笔记错了就删掉，单据上已收/已付的金额会一起调回来。',
      success: (r) => {
        if (!r.confirm) return
        this.req({ url: API_BASE + '/ledger/' + id, method: 'DELETE', success: () => { wx.showToast({ title: '删掉了', icon: 'none' }); this.loadFlows(); this.refresh() } })
      }
    })
  },
  loadProfiles() {
    this.req({
      url: API_BASE + '/profiles',
      success: (res) => { const d = res.data || {}; if (d.ok) this.setData({ profiles: d.list }) },
      fail: () => {}
    })
  },
  openProfile(e) {
    const party = e.currentTarget.dataset.p || ''
    const pf = (this.data.profiles || []).filter((x) => x.party === party)[0] || {}
    this.setData({ profile_edit: true, pf_party: party, pf_contact: pf.contact || '', pf_phone: pf.phone || '', pf_addr: pf.addr || '', pf_note: pf.note || '' })
  },
  closeProfile() { this.setData({ profile_edit: false }) },
  onPfContact(e) { this.setData({ pf_contact: e.detail.value }) },
  onPfPhone(e) { this.setData({ pf_phone: e.detail.value }) },
  onPfAddr(e) { this.setData({ pf_addr: e.detail.value }) },
  onPfNote(e) { this.setData({ pf_note: e.detail.value }) },
  saveProfile() {
    const b = { party: this.data.pf_party, contact: this.data.pf_contact, phone: this.data.pf_phone, addr: this.data.pf_addr, note: this.data.pf_note }
    if (!String(b.party || '').trim()) return wx.showToast({ title: '单位名称空着', icon: 'none' })
    this.req({
      url: API_BASE + '/profiles', method: 'POST', data: b,
      success: () => { this.setData({ profile_edit: false }); wx.showToast({ title: '存好了', icon: 'none' }); this.loadProfiles() },
      fail: () => wx.showToast({ title: '没存上，再试一次', icon: 'none' })
    })
  },
  callParty(e) {
    const phone = e.currentTarget.dataset.ph || ''
    if (!phone) return wx.showToast({ title: '这家还没填电话，点「档案」填一下', icon: 'none' })
    wx.showActionSheet({
      itemList: ['打电话 ' + phone, '复制电话'],
      success: (r) => {
        if (r.tapIndex === 0) wx.makePhoneCall({ phoneNumber: phone, fail: () => {} })
        else wx.setClipboardData({ data: phone })
      }
    })
  },
  loadReconMonth() {
    const m = this.data.rsum_month || dayOf(new Date()).slice(0, 7)
    this.req({
      url: API_BASE + '/recon-month?month=' + m + '&type=' + (this.data.rsum_type || 'ar'),
      success: (res) => {
        const d = res.data || {}
        if (!d.ok) return wx.showToast({ title: '读取失败', icon: 'none' })
        this.setData({ rsum: d, rsum_text: d.text || '' })
        this.req({ url: API_BASE + '/pipeline-summary', method: 'POST', data: { month: m }, fail: () => {}, success: () => this.loadPipeline() })
      }
    })
  },
  copyReconMonth() {
    if (!this.data.rsum_text) return
    wx.setClipboardData({ data: this.data.rsum_text, success: () => wx.showToast({ title: '已复制', icon: 'none' }) })
  },
  makeReconMonthImage() {
    if (!this.data.rsum_text) return
    this.drawStatementImage({ text: this.data.rsum_text }, true)
  },
  closeReconMonth() { this.setData({ rsum: null, rsum_text: '' }) },
  loadDisputes() {
    this.req({
      url: API_BASE + '/disputes',
      success: (res) => {
        const d = res.data || {}
        if (!d.ok) return wx.showToast({ title: '读取失败', icon: 'none' })
        this.setData({ dp: d })
      }
    })
  },
  blurOItem() { this.priceLookup(); this.costHint() },
  // 这单价做下来能赚几个点：材料（填的）+ 人工（这个产品过去实际记的工钱）
  costHint() {
    const d = this.data
    const item = (d.o_item || '').trim()
    if (!item) { if (d.chint) this.setData({ chint: null }); return }
    const q = '?item=' + encodeURIComponent(item) + '&cost=' + encodeURIComponent(d.o_cost || '') + '&price=' + encodeURIComponent(d.o_price || '')
    this.req({ url: API_BASE + '/cost-hint' + q, silent: true, success: (res) => {
      const r = res.data || {}
      if (r.ok === false) return
      this.setData({ chint: r })
    } })
  },
  priceLookup() {
    const party = (this.data.o_customer || '').trim()
    const item = (this.data.o_item || '').trim()
    if (!party) return
    this.req({
      url: API_BASE + '/price-lookup?party=' + encodeURIComponent(party) + (item ? '&item=' + encodeURIComponent(item) : ''),
      success: (r) => {
        const d = r.data || {}
        if (!d.found) return this.setData({ price_tip: '', price_last: 0, price_warn: '' })
        this._pb = d
        const up = { price_tip: d.text + '（共 ' + d.cnt + ' 单，平均 ' + d.avg_price + '）', price_last: d.last_price }
        if (!this.data.o_price) up.o_price = String(d.last_price)
        if (!this.data.o_cost && d.last_cost > 0) up.o_cost = String(d.last_cost)
        this.setData(up, () => this.priceWarn(this.data.o_price))
      }
    })
  },
  priceWarn(val) {
    const last = Number(this.data.price_last || 0)
    const v = Number(val || 0)
    if (!last || !v) return this.setData({ price_warn: '' })
    const pct = Math.round(((v - last) / last) * 1000) / 10
    this.setData({ price_warn: Math.abs(pct) >= 10 ? (pct > 0 ? '比上次高 ' + pct + '%（上次 ' + last + ' 元）' : '比上次低 ' + Math.abs(pct) + '%（上次 ' + last + ' 元）') : '' })
  },
  onIcMonth(e) { this.setData({ ic_month: e.detail.value }) },
  loadInvoiceCheck() {
    const m = (this.data.ic_month || '').trim() || this.data.today_month || ''
    this.req({
      url: API_BASE + '/invoice-check' + (m ? '?month=' + encodeURIComponent(m) : ''),
      success: (r) => {
        const d = r.data || {}
        if (!d.ok) return wx.showToast({ title: '读取失败', icon: 'none' })
        this.setData({ ic: d })
      }
    })
  },
  closeInvoiceCheck() { this.setData({ ic: null }) },
  copyInvoiceCheck() {
    const d = this.data.ic
    if (!d) return
    wx.setClipboardData({ data: d.text || '', success: () => wx.showToast({ title: '已复制', icon: 'none' }) })
  },
  loadCashbook() {
    this.req({
      url: API_BASE + '/cashbook?month=' + encodeURIComponent(this.data.cb_month || this.data.today_month || ''),
      success: (r) => {
        const d = r.data || {}
        if (!d.ok) return wx.showToast({ title: '读取失败', icon: 'none' })
        this.setData({ cb: d })
      }
    })
  },
  openStBatchAr() { this.loadStBatch('ar') },
  openStBatchAp() { this.loadStBatch('ap') },
  loadStBatch(t) {
    this.req({
      url: API_BASE + '/statement-batch?type=' + t + '&month=' + encodeURIComponent(this.data.sb_month || this.data.today_month || ''),
      once: 'stbatch',
      success: (r) => {
        if (!r.data || !r.data.ok) return wx.showToast({ title: '取不出来，稍后再试', icon: 'none' })
        this.setData({ sb: r.data })
      }
    })
  },
  closeStBatch() { this.setData({ sb: null }) },
  copyStOne(e) {
    const i = Number(e.currentTarget.dataset.i)
    const row = (this.data.sb && this.data.sb.rows && this.data.sb.rows[i]) || null
    if (!row) return
    wx.setClipboardData({ data: row.text })
    this.markStSent(i, '微信')
  },
  // 复制话术 / 拿打印页 = 这家的对账单发出去了，自动记一笔（同一天同一家只记一条）
  markStSent(i, channel) {
    const sb = this.data.sb
    const row = (sb && sb.rows && sb.rows[i]) || null
    if (!row) return
    this.req({
      url: API_BASE + '/statement-log',
      method: 'POST',
      data: { party: row.party, type: sb.type, month: sb.month, channel: channel },
      once: 'stsent',
      success: () => {
        if (row.sent_this_month) return
        const d0 = new Date()
        const td = d0.getFullYear() + '-' + String(d0.getMonth() + 1).padStart(2, '0') + '-' + String(d0.getDate()).padStart(2, '0')
        const rows = sb.rows.slice()
        rows[i] = { ...row, sent_this_month: true, sent_last: td, sent_times: row.sent_times + 1 }
        const unsent = rows.filter((x) => !x.sent_this_month)
        const unsentTotal = Number(unsent.reduce((s2, x) => s2 + x.left, 0).toFixed(2))
        this.setData({
          sb: { ...sb, rows: rows, sent_count: rows.length - unsent.length, unsent_count: unsent.length, unsent_total: unsentTotal,
            sent_note: `${sb.month} 已发 ${rows.length - unsent.length} 家，还没发 ${unsent.length} 家${unsent.length ? '（欠 ' + unsentTotal + ' 元）' : ''}` }
        })
      }
    })
  },
  openStUrl(e) {
    const i = Number(e.currentTarget.dataset.i)
    const row = (this.data.sb && this.data.sb.rows && this.data.sb.rows[i]) || null
    if (!row) return
    if (!row.url) return wx.showToast({ title: '先设访问口令才能生成打印页', icon: 'none' })
    wx.setClipboardData({
      data: row.url,
      success: () => {
        this.markStSent(i, '打印页')
        wx.showModal({ title: '打印页链接已复制', content: '发到对方微信，他用浏览器打开就能看明细、打印或存 PDF。', showCancel: false })
      }
    })
  },
  copyStAll() {
    const d = this.data.sb
    if (!d) return
    wx.setClipboardData({ data: d.all_text })
  },
  onMbMonth(e) { this.setData({ mb_month: e.detail.value }) },
  loadMonthBrief() {
    this.req({
      url: API_BASE + '/month-brief?month=' + encodeURIComponent(this.data.mb_month || this.data.today_month || ''),
      success: (r) => {
        if (!r.data || !r.data.ok) return wx.showToast({ title: '取不出来', icon: 'none' })
        this.setData({ mbr: r.data })
      }
    })
  },
  onEcMonth(e) { this.setData({ ec_month: e.detail.value }) },
  // ── 逐笔对账 ──
  onRoMonth(e) { this.setData({ ro_month: e.detail.value }) },
  loadReconOrders(e) {
    const t = (e && e.currentTarget && e.currentTarget.dataset.t) || (this.data.ro && this.data.ro.type) || 'ar'
    const m = String(this.data.ro_month || '').trim()
    this.req({
      url: '/recon-orders?type=' + t + (m ? '&month=' + encodeURIComponent(m) : ''),
      success: (res) => { if (res.data && res.data.ok) this.setData({ ro: res.data }) },
    })
  },
  closeReconOrders() { this.setData({ ro: null }) },
  copyReconOrders() {
    const ro = this.data.ro
    if (!ro) return
    wx.setClipboardData({ data: ro.text, success: () => wx.showToast({ title: '已复制' }) })
  },
  loadExpenseCompare() {
    const mv = (this.data.ec_month || '').trim()
    const q = /^\d{4}-\d{2}$/.test(mv) ? '?month=' + encodeURIComponent(mv) : ''
    this.req({
      url: API_BASE + '/expense-compare' + q,
      success: (r) => {
        if (!r.data || !r.data.ok) return wx.showToast({ title: '查不到', icon: 'none' })
        this.setData({ ec: r.data, ec_month: r.data.month })
      }
    })
  },
  closeEcCompare() { this.setData({ ec: null }) },
  copyEcCompare() {
    const d = this.data.ec
    if (!d) return
    wx.setClipboardData({ data: d.text || '', success: () => wx.showToast({ title: '已复制', icon: 'none' }) })
  },
  onLbMonth(e) { this.setData({ lb_month: e.detail.value }) },
  loadLossBook() {
    const mv = (this.data.lb_month || '').trim()
    const q = /^\d{4}-\d{2}$/.test(mv) ? 'month=' + encodeURIComponent(mv) : 'year=' + encodeURIComponent(mv.slice(0, 4) || '')
    this.req({
      url: API_BASE + '/loss-book?' + q,
      success: (r) => {
        if (!r.data || !r.data.ok) return wx.showToast({ title: '查不到', icon: 'none' })
        this.setData({ lb: r.data })
      }
    })
  },
  closeLossBook() { this.setData({ lb: null }) },
  copyLossBook() {
    const d = this.data.lb
    if (!d) return
    wx.setClipboardData({ data: d.text || '', success: () => wx.showToast({ title: '已复制', icon: 'none' }) })
  },
  onYcYear(e) { this.setData({ yc_year: e.detail.value }) },
  loadYearCust() {
    this.req({
      url: API_BASE + '/year-customers?year=' + encodeURIComponent(this.data.yc_year || this.data.today_year || ''),
      success: (r) => {
        if (!r.data || !r.data.ok) return wx.showToast({ title: '查不到，先确认年份', icon: 'none' })
        this.setData({ yc: r.data })
      }
    })
  },
  // 信用分档
  loadCreditBook(e) {
    const t = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.type) || 'ar'
    this.req({
      url: API_BASE + '/credit-book?type=' + t,
      success: (res) => {
        const d = res.data || {}
        if (d.ok) this.setData({ cr: d })
        else wx.showToast({ title: d.error || '取不到', icon: 'none' })
      }
    })
  },
  closeCreditBook() { this.setData({ cr: null }) },
  closeYearCust() { this.setData({ yc: null }) },
  copyYearCust() {
    const d = this.data.yc
    if (!d) return
    wx.setClipboardData({ data: d.text || '', success: () => wx.showToast({ title: '已复制', icon: 'none' }) })
  },
  closeMonthBrief() { this.setData({ mbr: null }) },
  copyMonthBrief() {
    const d = this.data.mbr
    if (!d) return
    wx.setClipboardData({ data: d.text || '', success: () => wx.showToast({ title: '已复制，去微信粘贴', icon: 'none' }) })
  },
  saveMonthBriefImage() {
    const d = this.data.mbr
    if (!d) return
    const lines = [d.title + '　' + d.month, '']
      .concat(d.sentences.map((x) => '· ' + x.text))
      .concat(d.events.length ? ['', '本月最大的三件事'] : [])
      .concat(d.events.map((e, i) => (i + 1) + '. ' + e.date + ' ' + e.text))
    this.drawStatementImage({ text: lines.join('\n') }, true)
  },
  onCb2Month(e) { this.setData({ cb2_month: e.detail.value }) },
  loadCashBridge() {
    this.req({
      url: API_BASE + '/cash-bridge?month=' + encodeURIComponent(this.data.cb2_month || this.data.today_month || ''),
      success: (r) => {
        if (!r.data || !r.data.ok) return wx.showToast({ title: '算不出来', icon: 'none' })
        this.setData({ cb2: r.data })
      }
    })
  },
  closeCashBridge() { this.setData({ cb2: null }) },
  copyCashBridge() {
    const d = this.data.cb2
    if (!d) return
    wx.setClipboardData({ data: d.text || '', success: () => wx.showToast({ title: '已复制，去微信粘贴', icon: 'none' }) })
  },
  closeCashbook() { this.setData({ cb: null }) },
  copyCashbook() {
    const d = this.data.cb
    if (!d) return
    wx.setClipboardData({ data: d.text, success: () => wx.showToast({ title: '已复制，发微信吧', icon: 'none' }) })
  },
  onCbMonth(e) {
    this.setData({ cb_month: e.detail.value }, () => this.loadCashbook())
  },
  loadPriceBook() {
    const kw = (this.data.pb_kw || '').trim()
    this.req({
      url: API_BASE + '/price-book' + (kw ? '?kw=' + encodeURIComponent(kw) : ''),
      success: (r) => {
        const d = r.data || {}
        if (!d.ok) return wx.showToast({ title: '读取失败', icon: 'none' })
        this.setData({ pb: d })
      }
    })
  },
  closePriceBook() { this.setData({ pb: null }) },
  loadPriceAnomaly() {
    this.req({
      url: API_BASE + '/price-anomaly?days=90&pct=15',
      success: (r) => {
        const d = r.data || {}
        if (!d.ok) return wx.showToast({ title: '读取失败', icon: 'none' })
        this.setData({ pa: d })
      }
    })
  },
  closePriceAnomaly() { this.setData({ pa: null }) },
  openOrderFromPrice(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    if (this.showDetail) this.showDetail({ currentTarget: { dataset: { id: id, type: 'ar' } } })
  },
  onPbKw(e) { this.setData({ pb_kw: e.detail.value }) },

  loadNextStep() {
    this.req({
      url: API_BASE + '/next-step',
      silent: true,
      success: (r) => {
        if (r.data && r.data.ok) this.setData({ ns: r.data })
      }
    })
  },
  goNext() {
    const it = this.data.ns && this.data.ns.item
    if (!it) return
    this.jumpMap({ currentTarget: { dataset: { go: it.tab } } })
    if (it.k === 'chase' || it.k === 'soon') wx.showToast({ title: '点那一行「收钱」就行', icon: 'none' })
  },
  // 每月 22 号以后，在「今天的活」上提示月底还有几件事没办完
  loadMonthTip() {
    const n = new Date()
    if (n.getDate() < 22) return
    this.req({
      url: API_BASE + '/month-end',
      silent: true,
      success: (res) => {
        const x = res.data || {}
        if (!x.ok || !x.total) return
        const left = x.total - x.done_count
        if (left <= 0) return this.setData({ mtip: null })
        this.setData({ mtip: { left, total: x.total, done: x.done_count, month: x.month, next: (x.steps || []).filter((s) => !s.done)[0] || null } })
      }
    })
  },
  goMonthEnd() { this.jumpMap({ currentTarget: { dataset: { go: 'stat:report' } } }) },
  toggleNextAll() {
    const open = !this.data.ns_open
    this.setData({ ns_open: open })
    if (open) wx.pageScrollTo({ scrollTop: 0, duration: 150 })
  },
  goNextItem(e) {
    const i = Number(e.currentTarget.dataset.i)
    const it = (this.data.ns && this.data.ns.others && this.data.ns.others[i]) || null
    if (!it) return
    this.jumpMap({ currentTarget: { dataset: { go: it.tab } } })
  },
  loadMyWork() {
    this.req({
      url: API_BASE + '/my-work',
      silent: true,
      success: (r) => { const d = r.data || {}; if (d.ok) this.setData({ mw: d }) }
    })
  },
  // 钱的三条线（预收款 / 预付供应商 / 员工借支 / 借款）
  // 工序卡住的单
  loadStale() {
    this.req({ url: API_BASE + '/process-stale?days=7', success: (r) => { const d = r.data || {}; if (d.ok) this.setData({ ps: d }) } })
  },
  closeStale() { this.setData({ ps: null }) },
  copyStale() {
    const d = this.data.ps
    if (!d) return
    wx.setClipboardData({ data: d.advice, success: () => wx.showToast({ title: '已复制' }) })
  },
  goOrderFromStale(e) {
    const id = Number(e.currentTarget.dataset.id)
    if (!id) return
    this.setData({ ps: null })
    this.enterTab('ar')
    wx.pageScrollTo({ scrollTop: 0, duration: 200 })
  },
  // 这周的钱够不够付
  loadCashForecast() {
    this.req({ url: API_BASE + '/cash-forecast?days=14', silent: true, success: (r) => { const d = r.data || {}; if (d.ok) this.setData({ cf: d }) } })
  },
  toggleCashForecast() { this.setData({ cf_open: !this.data.cf_open }); if (!this.data.cf) this.loadCashForecast() },
  copyCashForecast() {
    const d = this.data.cf
    if (!d) return
    wx.setClipboardData({ data: d.text, success: () => wx.showToast({ title: '已复制' }) })
  },
  // 老客户是不是跑了
  loadChurnRisk() {
    this.req({ url: API_BASE + '/churn-risk', success: (r) => { const d = r.data || {}; if (d.ok) this.setData({ ch: d }) } })
  },
  closeChurnRisk() { this.setData({ ch: null }) },
  copyChurnOne(e) {
    const i = Number(e.currentTarget.dataset.i)
    const row = (this.data.ch && this.data.ch.rows && this.data.ch.rows[i]) || null
    if (!row) return
    wx.setClipboardData({ data: row.text, success: () => wx.showToast({ title: '已复制，发给客户就行' }) })
  },
  copyChurnAll() {
    const d = this.data.ch
    if (!d) return
    const t = (d.rows || []).map((r) => r.text).join('\n\n')
    wx.setClipboardData({ data: t, success: () => wx.showToast({ title: '全部话术已复制' }) })
  },
  // 打印加工单（链接复制到浏览器打开就能打）
  printOrder(e) {
    const id = Number(e.currentTarget.dataset.id)
    if (!id) return
    this.req({
      url: API_BASE + '/order-print-link?id=' + id,
      success: (r) => {
        const d = r.data || {}
        if (!d.url) return wx.showToast({ title: d.error || '生成失败', icon: 'none' })
        wx.setClipboardData({ data: d.url, success: () => wx.showModal({ title: '打印链接已复制', content: '粘到浏览器地址栏打开，就能打印或存 PDF。车间打一张带给客户签字。', showCancel: false }) })
      }
    })
  },
  loadFunding() {
    this.req({
      url: API_BASE + '/funding',
      success: (r) => { const d = r.data || {}; if (d.ok) this.setData({ fund: d }) }
    })
  },
  jumpFund(e) {
    const t = e.currentTarget.dataset.t || 'me'
    this.enterTab(t)
    wx.pageScrollTo({ scrollTop: 0, duration: 200 })
  },
  openDayClose() { this.loadDayClose() },
  closeDayClose() { this.setData({ dc: null }) },
  loadDayClose() {
    this.req({
      url: '/day-close',
      success: (res) => { if (res.data && res.data.ok) this.setData({ dc: res.data }) },
    })
  },
  copyDayClose() {
    const dc = this.data.dc
    if (!dc) return
    wx.setClipboardData({ data: dc.text, success: () => wx.showToast({ title: '已复制，可以发出去' }) })
  },
  loadMyDay() {
    this.req({
      url: API_BASE + '/my-day',
      success: (r) => { const d = r.data || {}; if (d.ok) this.setData({ md: d }) }
    })
  },
  copyMyDay() {
    const d = this.data.md
    if (!d) return
    const t = d.text + (d.tips && d.tips.length ? '\n' + d.tips.map((x) => '· ' + x).join('\n') : '')
    wx.setClipboardData({ data: t, success: () => wx.showToast({ title: '已复制', icon: 'none' }) })
  },
  // 员工第一次用时记个名字，之后每笔操作日志都能看出是谁记的
  askStaffName(force) {
    let cur = ''
    try { cur = String(wx.getStorageSync('staff_name') || '') } catch (e) { cur = '' }
    if (cur && !force) return
    wx.showModal({
      title: '你叫什么名字',
      editable: true,
      placeholderText: '比如 小王（只用来区分谁记的账）',
      content: cur,
      success: (r) => {
        if (!r.confirm) return
        const nm = String(r.content || '').trim().slice(0, 12)
        if (!nm) return
        try { wx.setStorageSync('staff_name', nm) } catch (e) {}
        wx.showToast({ title: '记住了：' + nm, icon: 'none' })
        this.refresh()
      }
    })
  },
  // 员工权限：老板勾哪些模块给员工用
  loadStaffPerms() {
    this.req({ url: API_BASE + '/staff-perms', success: (res) => { const d = res.data || {}; this.setData({ spm: d, spm_self: !!d.self_only, spm_scope: d.scope || 'all' }) } })
  },
  toggleStaffMod(e) {
    const k = e.currentTarget.dataset.k
    const d = this.data.spm
    if (!d || !d.rows) return
    const rows = d.rows.map((r) => (r.k === k ? Object.assign({}, r, { on: !r.on }) : r))
    this.setData({ spm: Object.assign({}, d, { rows }) })
  },
  toggleSelfOnly() { this.setData({ spm_self: !this.data.spm_self }) },
  toggleBigFont() {
    const v = !this.data.big
    wx.setStorageSync('big_font', v ? '1' : '0')
    this.setData({ big: v })
    wx.showToast({ title: v ? '字放大了' : '恢复默认字号', icon: 'none' })
  },
  toggleScopeOwn() { this.setData({ spm_scope: this.data.spm_scope === 'own' ? 'all' : 'own' }) },
  saveStaffPerms() {
    const d = this.data.spm
    if (!d) return
    const modules = (d.rows || []).filter((r) => r.on).map((r) => r.k)
    if (!modules.length) return wx.showToast({ title: '至少留一个模块', icon: 'none' })
    this.req({
      url: API_BASE + '/staff-perms', method: 'POST', data: { modules, self_only: !!this.data.spm_self, scope: this.data.spm_scope || 'all' },
      success: () => { wx.showToast({ title: '存好了', icon: 'success' }); this.loadStaffPerms() }
    })
  },
  closeStaffPerms() { this.setData({ spm: null }) },
  // 员工账号：一人一个 4 位口令，各自授权限
  // ===== 功能模块开关 =====
  // 一个人用的时候用不上那么多模块：关掉的模块界面上入口藏起来、接口也 403，但数据一条不删。
  loadModules() {
    this.req({
      url: API_BASE + '/modules',
      success: (res) => {
        const d = (res && res.data) || {}
        if (!Array.isArray(d.list)) return
        const map = {}
        d.list.forEach((m) => { map[m.k] = !!m.on })
        this._modOff = d.off || []
        this.setData({ mods: { list: d.list, off: d.off || [], text: d.text || '', hint: d.hint || '' }, mod: map })
        this.applyModuleFilter()
      }
    })
  },
  toggleModule(e) {
    const k = e.currentTarget.dataset.k
    const m = (this.data.mods && this.data.mods.list || []).find((x) => x.k === k)
    if (!m) return
    if (m.keep) return wx.showToast({ title: '这块是记账基础，不能关', icon: 'none' })
    const off = (this.data.mods.off || []).slice()
    const i = off.indexOf(k)
    if (i >= 0) off.splice(i, 1)
    else off.push(k)
    this.req({
      url: API_BASE + '/modules', method: 'POST', data: { off },
      success: (res) => {
        const d = (res && res.data) || {}
        if (!d.ok) return wx.showToast({ title: d.error || '没改成', icon: 'none' })
        wx.showToast({ title: i >= 0 ? '已打开' : '已关掉', icon: 'success' })
        this.loadModules()
      }
    })
  },
  closeModules() { this.setData({ mods: null }) },
  // 关掉的模块，在「找功能」里也不出现
  applyModuleFilter() {
    const off = this._modOff || []
    if (!off.length) { if (this.data.feat_all !== FEATS) this.setData({ feat_all: FEATS }); return }
    const KW = {
      wage: /工资|计件|工序单价|发工资|计时/,
      material: /材料|库存|领料|进货价|框架价|在制|余料/,
      prod: /返工|外协|排产|工序|进度|生产/,
      quote: /报价|价格表|转订单/,
      asset: /资产|折旧|待摊|发票|转账|家底|净资产/,
      debt: /借款|利息|还本/,
      credit: /账期|额度|信用|催款/,
      recon: /对账/,
      bank: /银行流水/,
      budget: /预算|目标/,
      staff: /员工|权限/
    }
    const list = FEATS.filter((f) => {
      const txt = (f.n || '') + ' ' + (f.desc || '') + ' ' + (f.kw || '')
      return !off.some((k) => KW[k] && KW[k].test(txt))
    })
    this.setData({ feat_all: list })
  },
  loadStaffUsers() {
    this.req({ url: API_BASE + '/staff-users', success: (res) => this.setData({ su: res.data || null }) })
  },
  closeStaffUsers() { this.setData({ su: null }) },
  addStaffUser() {
    wx.showModal({
      title: '加个员工', editable: true, placeholderText: '他叫什么（比如 小王）',
      success: (m) => {
        const name = String(m.content || '').trim()
        if (!m.confirm) return
        if (!name) return wx.showToast({ title: '得先填个名字', icon: 'none' })
        wx.showLoading({ title: '加…' })
        this.req({
          url: API_BASE + '/staff-users', method: 'POST', data: { name },
          success: (res) => {
            wx.hideLoading()
            const d = res.data || {}
            if (!d.ok) return wx.showToast({ title: d.error || '没加上', icon: 'none' })
            this.loadStaffUsers()
            wx.showModal({ title: '加好了', content: (d.text || '') + '\n\n口令只显示这一次（库里存的是加密后的），忘了就在列表里点「换个口令」重设。', showCancel: false })
          },
          fail: () => wx.hideLoading()
        })
      }
    })
  },
  toggleSuMod(e) {
    const d = this.data.su
    if (!d) return
    const id = e.currentTarget.dataset.id
    const k = e.currentTarget.dataset.k
    const rows = (d.rows || []).map((r) => {
      if (r.id !== id) return r
      const mods = (r.mods || []).slice()
      const i = mods.indexOf(k)
      if (i >= 0) mods.splice(i, 1)
      else mods.push(k)
      return Object.assign({}, r, { mods })
    })
    this.setData({ su: Object.assign({}, d, { rows }) })
  },
  saveStaffUser(e) {
    const id = e.currentTarget.dataset.id
    const d = this.data.su
    const r = ((d && d.rows) || []).find((x) => x.id === id)
    if (!r) return
    if (!(r.mods || []).length) return wx.showToast({ title: '至少给他开一块', icon: 'none' })
    this.req({
      url: API_BASE + '/staff-users/' + id, method: 'POST', data: { mods: r.mods },
      success: () => { wx.showToast({ title: '存好了', icon: 'success' }); this.loadStaffUsers() }
    })
  },
  toggleSuActive(e) {
    const id = e.currentTarget.dataset.id
    const on = Number(e.currentTarget.dataset.on)
    this.req({
      url: API_BASE + '/staff-users/' + id, method: 'POST', data: { active: on ? 0 : 1 },
      success: () => { wx.showToast({ title: on ? '已停用' : '已启用', icon: 'success' }); this.loadStaffUsers() }
    })
  },
  resetSuPin(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '换个口令', editable: true, placeholderText: '4 位数字，留空就随机生成',
      success: (m) => {
        if (!m.confirm) return
        const pin = String(m.content || '').replace(/\D/g, '')
        this.req({
          url: API_BASE + '/staff-users/' + id, method: 'POST', data: pin ? { pin } : { pin: String(1000 + Math.floor(Math.random() * 9000)) },
          success: (res) => {
            const d = res.data || {}
            if (!d.ok) return wx.showToast({ title: d.error || '没改成', icon: 'none' })
            this.loadStaffUsers()
            // 口令现在只存哈希，新口令只有这一次能看见，必须当场弹出来
            if (d.pin) wx.showModal({ title: '新口令是 ' + d.pin, content: '记下来告诉他。库里只存加密后的，以后再想看得重新设一个。', showCancel: false })
            else wx.showToast({ title: '改好了', icon: 'success' })
          }
        })
      }
    })
  },
  delStaffUser(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删掉这个员工账号？', content: '删了他就登不进来了（记过的账不影响）。',
      success: (m) => {
        if (!m.confirm) return
        this.req({ url: API_BASE + '/staff-users/' + id, method: 'DELETE', success: () => { this.loadStaffUsers(); wx.showToast({ title: '删了', icon: 'success' }) } })
      }
    })
  },
  loadStaffAct() {
    this.req({
      url: API_BASE + '/staff-activity?days=7',
      success: (r) => {
        const d = r.data || {}
        if (!d.ok) return wx.showToast({ title: d.error || '读取失败', icon: 'none' })
        this.setData({ sad: d })
      }
    })
  },
  closeStaffAct() { this.setData({ sad: null }) },
  openHelp() { this.setData({ help_open: true }) },
  closeHelp() { this.setData({ help_open: false }) },
  openDisputeBook(e) {
    const party = (e.currentTarget.dataset.party || '').trim()
    this.req({
      url: API_BASE + '/dispute-book?all=1&party=' + encodeURIComponent(party),
      success: (res) => {
        const d = res.data || {}
        if (!d.ok) return wx.showToast({ title: '读取失败', icon: 'none' })
        d.party_filter = party
        this.setData({ dbk: d })
      }
    })
  },
  loadDisputeBookAll() {
    this.req({
      url: API_BASE + '/dispute-book?all=1',
      success: (res) => {
        const d = res.data || {}
        if (!d.ok) return wx.showToast({ title: '读取失败', icon: 'none' })
        this.setData({ dbk: d })
      }
    })
  },
  closeDisputeBook() { this.setData({ dbk: null }) },
  copyResend(e) {
    wx.setClipboardData({ data: e.currentTarget.dataset.text || '', success: () => wx.showToast({ title: '已复制', icon: 'none' }) })
  },
  resolveDispute(e) {
    const id = e.currentTarget.dataset.id
    const k = e.currentTarget.dataset.k
    const send = (note) => {
      this.req({
        url: API_BASE + '/statement-log/' + id + '/resolve', method: 'POST', data: { note: note || '' },
        success: (res) => {
          if (res.data && res.data.ok) { wx.showToast({ title: '已处理', icon: 'none' }); this.loadDisputes() }
          else wx.showToast({ title: (res.data && res.data.error) || '失败', icon: 'none' })
        }
      })
    }
    if (k === 'ignore') {
      wx.showModal({ title: '标记为不用管？', content: '以后不在争议清单里显示', success: (r) => { if (r.confirm) send('对方没再提，算了') } })
    } else {
      wx.showModal({
        title: '怎么核对的？', editable: true, placeholderText: '例：他那笔 800 是现金付的，补记了收款',
        success: (r) => { if (r.confirm) send(r.content) }
      })
    }
  },
  onDyYear(e) { this.setData({ dy_year: e.detail.value }) },
  loadDunYear() {
    const y = this.data.dy_year || ''
    this.req({
      url: API_BASE + '/dunning-year' + (y ? '?year=' + y : ''),
      success: (res) => {
        const d = res.data || {}
        if (!d.ok) return wx.showToast({ title: d.error || '没取到', icon: 'none' })
        this.setData({ dy: d })
      }
    })
  },
  copyDunYear() {
    const d = this.data.dy
    if (!d) return
    const lines = [d.year + ' 年催款汇总', '催款 ' + d.total.times + ' 次 · 催后收回 ¥' + d.total.recovered + '（平均一次 ¥' + d.total.avg + '）']
    for (const r of d.rows) {
      if (!r.times && !r.broken && !r.disputes) continue
      lines.push('  ' + r.label + '：催 ' + r.times + ' 次 · 收回 ¥' + r.recovered + (r.broken ? ' · 失约 ' + r.broken : '') + (r.disputes ? ' · 争议 ' + r.disputes : ''))
    }
    lines.push('发对账单 ' + d.total.statements + ' 份 · 对方有异议 ' + d.total.disputes + ' 份')
    for (const a of (d.advice || [])) lines.push('· ' + a.text)
    wx.setClipboardData({ data: lines.join('\n'), success: () => wx.showToast({ title: '已复制', icon: 'none' }) })
  },
  closeDunYear() { this.setData({ dy: null }) },
  loadDunMonth() {
    this.req({
      url: API_BASE + '/dunning-month',
      success: (res) => {
        const d = res.data || {}
        if (!d.ok) return wx.showToast({ title: '读取失败', icon: 'none' })
        this.setData({ dsum: d, dsum_text: d.text || '' })
      }
    })
  },
  copyDunMonth() {
    if (!this.data.dsum_text) return
    wx.setClipboardData({ data: this.data.dsum_text, success: () => wx.showToast({ title: '已复制', icon: 'none' }) })
  },
  makeDunMonthImage() {
    if (!this.data.dsum_text) return
    this.drawStatementImage({ text: this.data.dsum_text }, true)
  },
  loadDunEffect() {
    this.req({
      url: API_BASE + '/dunning-effect',
      success: (res) => {
        const d = res.data || {}
        if (!d.ok) return wx.showToast({ title: '读取失败', icon: 'none' })
        const lines = []
        lines.push('【催款效果 · 近 ' + d.months + ' 个月】')
        lines.push('催过 ' + d.count + ' 家 / 共 ' + d.total_dun + ' 次，催后收回 ¥' + d.recovered + '，还欠 ¥' + d.still_left)
        lines.push('')
        ;(d.rows || []).forEach((r, i) => {
          lines.push((i + 1) + '. ' + r.party + '（' + r.type_text + '）催 ' + r.times + ' 次，催后收回 ' + r.paid_after + '，还欠 ' + r.left + '　→ ' + r.text)
        })
        ;(d.advice || []).forEach((a) => lines.push('· ' + a.text))
        this.setData({ dfx: d, dfx_text: lines.join('\n') })
      }
    })
  },
  copyDunEffect() {
    if (!this.data.dfx_text) return
    wx.setClipboardData({ data: this.data.dfx_text, success: () => wx.showToast({ title: '已复制', icon: 'none' }) })
  },
  loadBreakEven() {
    this.req({
      url: API_BASE + '/break-even',
      success: (res) => { const d = res.data || {}; if (d.ok) this.setData({ be: d }) },
      fail: () => wx.showToast({ title: '拿不到，下拉刷新再试', icon: 'none' })
    })
  },
  onRvMonth(e) { this.setData({ rv_month: e.detail.value }) },
  onYsYear(e) { this.setData({ ys_year: e.detail.value }) },
  loadReportView() {
    const m = (this.data.rv_month || '').trim()
    if (m && !/^\d{4}-\d{2}$/.test(m)) return wx.showToast({ title: '月份写成 2026-11 这样', icon: 'none' })
    this.req({
      url: API_BASE + '/report-view' + (m ? '?month=' + m : ''),
      success: (res) => { const d = res.data || {}; if (d.ok) this.setData({ rv: d }) },
      fail: () => wx.showToast({ title: '看不了，下拉刷新再试', icon: 'none' })
    })
  },
  loadAnomaly() {
    this.req({
      url: API_BASE + '/anomaly',
      success: (res) => {
        const d = res.data || {}
        if (!d.ok) return
        this.setData({ ano: d })
        wx.showToast({ title: d.count ? ('有 ' + d.count + ' 条要留意') : '没发现异常', icon: 'none' })
      },
      fail: () => wx.showToast({ title: '看不了，下拉刷新再试', icon: 'none' })
    })
  },
  // 完整年度总账：12 个月 + 年底结存 + 去年对比 + 可打印
  loadYearBook() {
    const y = String(this.data.yb_year || '').trim()
    this.req({
      url: API_BASE + '/year-book' + (y ? '?year=' + y : ''),
      success: (res) => {
        const d = res.data || {}
        if (d.error) return wx.showToast({ title: d.error, icon: 'none' })
        this.setData({ yb: d })
      },
      fail: () => wx.showToast({ title: '取不到年度总账', icon: 'none' })
    })
  },
  onYrvYear(e) { this.setData({ yrv_year: e.detail.value }) },
  // 一张纸的年度回顾：给家里人看的话，不是给会计的表
  loadYearReview() {
    const y = String(this.data.yrv_year || '').trim()
    if (y && !/^\d{4}$/.test(y)) return wx.showToast({ title: '年份写 4 位数，如 2026', icon: 'none' })
    this.req({
      url: API_BASE + '/year-review' + (y ? '?year=' + y : ''),
      success: (res) => {
        const d = res.data || {}
        if (d.error) return wx.showToast({ title: d.error, icon: 'none' })
        this.setData({ yrv: d })
      },
      fail: () => wx.showToast({ title: '取不到年度回顾', icon: 'none' })
    })
  },
  closeYearReview() { this.setData({ yrv: null }) },
  copyYearReview() {
    const d = this.data.yrv || {}
    if (!d.text) return
    wx.setClipboardData({ data: d.text, success: () => wx.showToast({ title: '已复制', icon: 'none' }) })
  },
  openYearReviewPrint() {
    const y = (this.data.yrv || {}).year
    if (!y) return wx.showToast({ title: '先看这一年', icon: 'none' })
    this.req({
      url: API_BASE + '/year-review-print-link?year=' + y,
      success: (res) => {
        const u = (res.data || {}).url
        if (!u) return wx.showToast({ title: '生成不了链接', icon: 'none' })
        wx.setClipboardData({
          data: u,
          success: () => wx.showModal({
            title: '打印链接已复制',
            content: '在电脑浏览器里粘贴打开，就能打印或存 PDF，发给家里人看。\n链接带签名，改字符就失效。',
            showCancel: false
          })
        })
      }
    })
  },
  onYbYear(e) { this.setData({ yb_year: e.detail.value }) },
  closeYearBook() { this.setData({ yb: null }) },
  copyYearBook() {
    const d = this.data.yb || {}
    if (!d.text) return
    wx.setClipboardData({ data: d.text, success: () => wx.showToast({ title: '已复制', icon: 'none' }) })
  },
  // 给会计的资料包：一年的总览/月度汇总/利润表/资产负债表/明细/流水/发票/固定资产/借款 打成 Excel
  // 开新年度（上年结转）
  loadYearOpen() {
    const y = String(this.data.yb_year || '').trim() || String(new Date().getFullYear())
    if (!/^\d{4}$/.test(y)) return wx.showToast({ title: '年份写 4 位数，如 2026', icon: 'none' })
    wx.showLoading({ title: '算结转数…' })
    this.req({
      url: API_BASE + '/year-open?year=' + y,
      success: (res) => { wx.hideLoading(); const d = res.data || {}; if (d.error) return wx.showToast({ title: d.error, icon: 'none' }); this.setData({ yo: d }) },
      fail: () => wx.hideLoading()
    })
  },
  doYearOpen() {
    const yo = this.data.yo || {}
    if (!yo.year) return wx.showToast({ title: '先看一下结转数', icon: 'none' })
    wx.showModal({
      title: yo.opened ? '重新定一次期初？' : '确认开账',
      content: (yo.opened ? '会覆盖原来的凭据。' : '') + '这只是把年初数定下来、留一张凭据，不动任何账目；没结清的单子和借款本来就继续算。',
      success: (r) => {
        if (!r.confirm) return
        wx.showLoading({ title: '开账中…' })
        this.req({
          url: API_BASE + '/year-open',
          method: 'POST',
          data: { year: Number(yo.year), confirm: !!yo.opened },
          success: (res) => {
            wx.hideLoading()
            const d = res.data || {}
            if (d.error) return wx.showModal({ title: '开不了账', content: d.error, showCancel: false })
            wx.showModal({ title: '开好了', content: d.text || '', showCancel: false })
            this.loadYearOpen()
          },
          fail: () => wx.hideLoading()
        })
      }
    })
  },
  closeYearOpen() { this.setData({ yo: null }) },
  openYearOpenPrint() {
    const y = (this.data.yo || {}).year
    if (!y) return
    this.req({
      url: API_BASE + '/year-open-print-link?year=' + y,
      success: (res) => {
        const u = (res.data || {}).url
        if (!u) return wx.showToast({ title: '生成不了链接', icon: 'none' })
        wx.setClipboardData({ data: u, success: () => wx.showModal({
          title: '结转凭据链接已复制',
          content: '在电脑浏览器里打开就能打印，给会计和银行看：说明新一年的账从哪儿接着算。',
          showCancel: false }) })
      }
    })
  },
  exportTaxPack() {
    const y = (this.data.yb || {}).year || ''
    wx.showLoading({ title: '打包中…' })
    this.req({
      url: API_BASE + '/tax-pack' + (y ? '?year=' + encodeURIComponent(y) : ''),
      success: (res) => {
        wx.hideLoading()
        const d = res.data || {}
        if (!d.b64) return wx.showToast({ title: d.error || '没生成出来', icon: 'none' })
        wx.showModal({
          title: '资料包好了',
          content: d.text || '',
          showCancel: false,
          success: () => this.saveXlsxFile(d)
        })
      },
      fail: () => wx.hideLoading()
    })
  },
  openYearPrint() {
    const y = (this.data.yb || {}).year
    if (!y) return wx.showToast({ title: '先看这一年', icon: 'none' })
    this.req({
      url: API_BASE + '/year-print-link?year=' + y,
      success: (res) => {
        const u = (res.data || {}).url
        if (!u) return wx.showToast({ title: '生成不了链接', icon: 'none' })
        wx.setClipboardData({
          data: u,
          success: () => wx.showModal({
            title: '打印链接已复制',
            content: '在电脑浏览器里粘贴打开，就能打印或存 PDF 给会计、银行。\n链接带签名，改字符就失效。',
            showCancel: false
          })
        })
      }
    })
  },
  loadYearSummary() {
    const y = (this.data.ys_year || '').trim()
    if (y && !/^\d{4}$/.test(y)) return wx.showToast({ title: '年份写成 2026 这样', icon: 'none' })
    this.req({
      url: API_BASE + '/year-summary' + (y ? '?year=' + y : ''),
      success: (res) => { const d = res.data || {}; if (d.ok) this.setData({ ys: d }) },
      fail: () => wx.showToast({ title: '出不了，下拉刷新再试', icon: 'none' })
    })
  },
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
    // 一句话记账：以前点两下会记两笔（没有 client_id、也没有 loading 挡一下）
    if (this.data.q_busy) return
    this.setData({ q_busy: true })
    wx.showLoading({ title: '记账中', mask: true })
    this.req({
      url: API_BASE + '/quick', method: 'POST',
      data: { text: t, client_id: this.newCid() },
      success: (res) => {
        const d = res.data || {}
        if (d.error) {
          wx.showToast({ title: d.error, icon: 'none' })
        } else {
          wx.showToast({ title: d.dup_ok ? '这笔刚记过了' : '已记：' + d.summary, icon: 'none' })
          this.setData({ q_text: '' })
          this.refresh({ lite: true })
        }
      },
      complete: () => {
        wx.hideLoading()
        this.setData({ q_busy: false })
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
  // 批量对账单：所有单位一个 Excel（汇总页 + 每家一页）
  packAr() { this.exportStatementPack('ar') },
  packAp() { this.exportStatementPack('ap') },
  exportStatementPack(type) {
    const d = new Date()
    const cm = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    wx.showActionSheet({
      itemList: ['本月', '今年（1 月至今）'],
      success: (r) => {
        const m = (this.data.ex_month || '').trim() || cm
        const q = r.tapIndex === 0 ? '&month=' + m : '&from=' + cm.slice(0, 4) + '-01-01'
        wx.showLoading({ title: '生成中…' })
        this.req({
          url: API_BASE + '/statement-pack?type=' + type + q,
          success: (res) => {
            wx.hideLoading()
            const dd = res.data || {}
            if (!dd.b64) return wx.showToast({ title: dd.error || '没生成出来', icon: 'none' })
            wx.showToast({ title: '共 ' + dd.parties + ' 家', icon: 'none' })
            this.saveXlsxFile(dd)
          },
          fail: () => wx.hideLoading()
        })
      }
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
  trackLink(e) {
    const name = e.currentTarget.dataset.name || ''
    wx.showLoading({ title: '生成中…' })
    this.req({
      url: API_BASE + '/track-link?party=' + encodeURIComponent(name),
      success: (res) => {
        wx.hideLoading()
        const u = (res.data || {}).url
        if (!u) return wx.showToast({ title: (res.data && res.data.error) || '没生成出来', icon: 'none' })
        this.req({ url: API_BASE + '/track-log?party=' + encodeURIComponent(name), success: (lg) => {
          const rows = (lg.data && lg.data.rows) || []
          const tip = rows.length ? '对方点开过 ' + rows.length + ' 次，最近一次 ' + String(rows[0].created_at || '').slice(0, 16).replace('T', ' ') : '对方还没点开过'
          wx.showModal({
            title: '对账明细链接已复制',
            content: '发给' + name + '，他点开能看到：本月期初/新增/已付/期末、每笔单做到哪了、收过哪些钱（看不到别家，也改不了账）。\n' + tip,
            confirmText: '知道了',
            success: () => wx.setClipboardData({ data: u })
          })
        }, fail: () => wx.setClipboardData({ data: u }) })
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
          if (d.wo_mismatch) L.push(`· 应收核销与核销记录不一致 ${d.wo_mismatch} 张`)
          if (d.wo_mismatch_ap) L.push(`· 应付核销与核销记录不一致 ${d.wo_mismatch_ap} 张`)
          if (d.orphan_ledger) L.push(`· 流水挂着的单据已删除 ${d.orphan_ledger} 条`)
          if (d.stock_negative) L.push(`· 库存算成负数的材料 ${d.stock_negative} 种`)
          if (d.advance_over) L.push(`· 预收/预付抵超了 ${d.advance_over} 笔`)
          if (d.account_orphan) L.push(`· 流水挂着的账户已删除 ${d.account_orphan} 条`)
          if (d.month_null) L.push(`· 没记上月份的单据 ${d.month_null} 条`)
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
  loadAsset() { this.loadWx(); this.loadNetworth(); this.loadNetworthSnap(); this.loadKpi(); this.loadAging(); this.loadHead(); this.loadLoans() },
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
  // 单位重名：同一家被记成两个名字，对账永远对不上
  loadPartyDups() {
    this.req({
      url: API_BASE + '/party-dups',
      success: (res) => {
        const d = res.data || {}
        if (!d.ok) return wx.showToast({ title: d.error || '查重失败', icon: 'none' })
        this.setData({ pdup: d })
      }
    })
  },
  closePartyDups() { this.setData({ pdup: null }) },
  onPmFrom(e) { this.setData({ pm_from: e.detail.value }) },
  onPmTo(e) { this.setData({ pm_to: e.detail.value }) },
  mergeInto(e) {
    const from = e.currentTarget.dataset.from
    const to = e.currentTarget.dataset.to
    this._doMerge(from, to)
  },
  doPartyMerge() {
    const from = (this.data.pm_from || '').trim()
    const to = (this.data.pm_to || '').trim()
    if (!from || !to) return wx.showToast({ title: '两个名字都填一下', icon: 'none' })
    if (from === to) return wx.showToast({ title: '两个名字一样', icon: 'none' })
    this._doMerge(from, to)
  },
  _doMerge(from, to) {
    wx.showModal({
      title: '合并 / 改名',
      content: `把「${from}」全部改成「${to}」？应收、应付、预收预付、对账和催款记录都会一起改，改完不能自动撤回。`,
      confirmText: '改',
      success: (r) => {
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/party-merge',
          method: 'POST',
          once: true,
          data: { from, to },
          success: (res) => {
            const d = res.data || {}
            if (!d.ok) return wx.showModal({ title: '没改成', content: d.error || '出错了', showCancel: false })
            wx.showModal({ title: '改好了', content: d.note || '', showCancel: false })
            this.setData({ pm_from: '', pm_to: '' })
            this.loadPartyDups(); this.loadContacts(); this.loadAr(); this.loadAp()
          }
        })
      }
    })
  },
  // 家底存档：每月末存一份，改了老单据也不影响存档
  loadNetworthSnap() {
    this.req({
      url: API_BASE + '/networth-snapshots',
      success: (res) => { const d = res.data || {}; if (d.ok) this.setData({ nws: d }) }
    })
  },
  saveNetworthSnap() {
    this.req({
      url: API_BASE + '/networth-snapshot',
      method: 'POST',
      once: true,
      data: {},
      success: (res) => {
        const d = res.data || {}
        if (!d.ok) return wx.showToast({ title: d.error || '没存上', icon: 'none' })
        wx.showToast({ title: `已存下 ${d.month} 的家底 ¥${d.net}`, icon: 'none' })
        this.loadNetworthSnap(); this.loadNetworth()
      }
    })
  },
  delNetworthSnap(e) {
    const m = e.currentTarget.dataset.m
    wx.showModal({
      title: '删掉这条存档？',
      content: `删除 ${m} 的家底存档（不影响账本里的单据）。`,
      success: (r) => {
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/networth-snapshot/' + m,
          method: 'DELETE',
          success: () => { this.loadNetworthSnap() }
        })
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
    this.loadCollectConfig()
    this.req({
      url: API_BASE + '/report-head',
      success: (res) => {
        const d = res.data || {}
        this.setData({ head_title: d.title || '', head_note: d.note || '', head_phone: d.phone || '', head_addr: d.addr || '', head_bank: d.bank || '' })
      }
    })
  },
  onHeadTitle(e) { this.setData({ head_title: e.detail.value }) },
  onHeadNote(e) { this.setData({ head_note: e.detail.value }) },
  onHeadPhone(e) { this.setData({ head_phone: e.detail.value }) },
  onHeadAddr(e) { this.setData({ head_addr: e.detail.value }) },
  onHeadBank(e) { this.setData({ head_bank: e.detail.value }) },
  onCollectMin(e) { this.setData({ collect_min: e.detail.value }) },
  loadCollectConfig() {
    this.req({
      url: API_BASE + '/collect-config',
      success: (res) => { const d = res.data || {}; if (d.ok) this.setData({ collect_min: String(d.min_days || 0) }) }
    })
  },
  saveCollectConfig() {
    const v = Number(this.data.collect_min || 0)
    if (!(v >= 0 && v <= 365)) return wx.showToast({ title: '填 0~365 之间的天数', icon: 'none' })
    this.req({
      url: API_BASE + '/collect-config', method: 'POST', data: { min_days: v },
      success: (res) => {
        if (res.data && res.data.ok) { wx.showToast({ title: v > 0 ? '只列欠满 ' + v + ' 天的' : '全部列出来', icon: 'none' }); const c = this.data.collect; if (c) this.openCollect(c.type) }
        else wx.showToast({ title: '没存上', icon: 'none' })
      }
    })
  },
  recordDunning(e) {
    const party = e.currentTarget.dataset.party
    const type = e.currentTarget.dataset.type || 'ar'
    wx.showModal({
      title: '记一笔催款：' + party, editable: true, placeholderText: '说了什么？（例：他说月底结，已答应）',
      success: (r) => {
        if (!r.confirm) return
        const note = r.content || ''
        // 第二步：他说哪天付（答应付款日）
        wx.showActionSheet({
          itemList: ['没答应具体日子', '今天', '3 天后', '7 天后', '月底'],
          success: (r2) => {
            const d = new Date()
            let pd = ''
            if (r2.tapIndex === 1) pd = dayOf(d)
            else if (r2.tapIndex === 2) pd = dayOf(new Date(d.getTime() + 3 * 86400000))
            else if (r2.tapIndex === 3) pd = dayOf(new Date(d.getTime() + 7 * 86400000))
            else if (r2.tapIndex === 4) pd = dayOf(new Date(d.getFullYear(), d.getMonth() + 1, 0))
            this.req({
              url: API_BASE + '/dunning-log', method: 'POST', data: { party, type, note, promise_date: pd },
              success: () => {
                wx.showToast({ title: pd ? '记下了，答应 ' + pd.slice(5) + ' 付' : '记下了', icon: 'none' })
                const c = this.data.collect; if (c) this.openCollect(c.type)
                if (this.data.dun_log) this.openDunLog(type)
              }
            })
          }
        })
      }
    })
  },
  openDunLog(type) {
    const t = type || (this.data.dun_log && this.data.dun_log.type) || 'ar'
    this.req({
      url: API_BASE + '/dunning-log?type=' + t,
      success: (res) => {
        const d = res.data || {}
        if (!d.ok) return
        const st = { none: '', pending: '还没到日子', broken: '过了日子没付', kept: '已经付了' }
        this.setData({ dun_log: { type: t, count: d.count, month_count: d.month_count, broken_count: d.broken_count, rows: (d.rows || []).map((x) => Object.assign({}, x, { pstate_text: st[x.pstate] || '' })) } })
      }
    })
  },
  closeDunLog() { this.setData({ dun_log: null }) },
  delDunLog(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删掉这条催款记录？', content: '删了就不算催过（催款清单里会重新出现）',
      success: (r) => {
        if (!r.confirm) return
        this.req({ url: API_BASE + '/dunning-log/' + id, method: 'DELETE', success: () => { if (this.data.dun_log) this.openDunLog(this.data.dun_log.type) } })
      }
    })
  },
  saveHead() {
    this.req({
      url: API_BASE + '/report-head', method: 'POST',
      data: { title: this.data.head_title, note: this.data.head_note, phone: this.data.head_phone, addr: this.data.head_addr, bank: this.data.head_bank },
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
  // 演示口令：只读（能看不能改），给微信审核和「想先看看」的人用。
  // 为什么要它：微信审核 3.3「登录受限」——审核员拿不到口令进不去，就判定「体验受限」驳回。
  setDemoKey() {
    const on = !!this.data.demo_enabled
    wx.showModal({
      title: on ? '改演示口令' : '设演示口令',
      content: on
        ? '输入新的演示口令（至少 4 位）；输空并确定=关闭演示模式'
        : '给微信审核 / 试用的人用的口令（至少 4 位）。拿到它只能看，不能改账、不能导出。输空并确定=关闭',
      editable: true, placeholderText: '演示口令', confirmText: '保存',
      success: (r) => {
        if (!r.confirm) return
        const pw = String(r.content || '').trim()
        this.req({
          url: API_BASE + '/auth/demo', method: 'POST',
          data: { key: wx.getStorageSync('ak'), password: pw },
          success: (res) => {
            const d = res.data || {}
            if (d.ok) {
              this.setData({ demo_enabled: !!d.enabled })
              wx.showToast({ title: d.enabled ? ('演示口令已保存：' + pw + '（只读）') : '演示模式已关闭', icon: 'none' })
              this.loadMe()
            } else wx.showToast({ title: d.error || '设置失败', icon: 'none' })
          }
        })
      }
    })
  },
  onKeyInput(e) { this.setData({ key_input: e.detail.value }) },
  closeKey() {
    const c = this._keyCtx
    this._keyCtx = null
    // 点了「先不看」：排队的请求既不放行也不留着 —— 否则下次进来会突然冒出别人的数据。
    // 但必须逐个收尾：不少地方只靠 complete 收尾（比如「记账中」那个 mask 遮罩），
    // 以前直接清空数组，遮罩就永远转下去，整屏点不动。
    const q = this._keyQueue || []
    this._keyQueue = []
    this._askingKey = false
    q.forEach((o) => {
      try { o.fail && o.fail({ statusCode: 0, cancelled: true }) } catch (e) { /* 单个失败不影响别的 */ }
      try { o.complete && o.complete({ statusCode: 0, cancelled: true }) } catch (e) { /* 同上 */ }
    })
    try { wx.hideLoading() } catch (e) { /* 没有遮罩就忽略 */ }
    if (c) c.done()
    this.setData({ key_open: false, key_input: '', key_err: '', no_key: true })
  },
  // 输口令进（或者第一次用：设口令）
  submitKey() {
    const k = String(this.data.key_input || '').trim()
    if (k.length < 4) return wx.showToast({ title: '口令至少 4 位', icon: 'none' })
    const c = this._keyCtx
    if (this.data.key_mode === 'set') {
      wx.showLoading({ title: '设置中' })
      wx.request({
        url: API_BASE + '/auth/setup', method: 'POST', data: { key: k },
        success: (s) => {
          wx.hideLoading()
          const d = s.data || {}
          if (d.ok) {
            wx.setStorageSync('ak', k)
            this._keyCtx = null
            this.setData({ key_open: false })
            if (c) { c.done(); c.doReq(k); c.replayKey(k) }
            this.loadMe()
            // 口令是补发时过期的话，输完接着把「待补」补完
            setTimeout(() => this.flushPending(true), 400)
            if (d.recover_code) this.showRecoverCode(d.recover_code)
          } else this.setData({ key_err: d.error || '设置失败' })
        },
        fail: () => { wx.hideLoading(); this.setData({ key_err: '网络失败，再试一次' }) }
      })
      return
    }
    this.setData({ key_err: '' })
    // 员工 PIN 是按账套存的。二厂的人默认进的是第 1 本，必然「口令错误」，
    // 而小程序里没有「选账套」这一屏。于是先问一句「这个口令属于哪一本」，是别本账就自动切过去。
    wx.request({
      url: API_BASE + '/auth/find-book', method: 'POST', data: { key: k },
      success: (r) => {
        const d = r.data || {}
        const cur = String(wx.getStorageSync('book') || 1)
        if (d.ok && d.book && String(d.book) !== cur) {
          try { wx.setStorageSync('book', d.book) } catch (e) { /* 存不进去就照旧 */ }
          this.setData({ book: Number(d.book) })
          wx.showToast({ title: '已切到「' + String(d.name || ('第 ' + d.book + ' 本账')) + '」', icon: 'none' })
        }
        wx.setStorageSync('ak', k)
        this._keyCtx = null
        this.setData({ key_open: false, key_err: '' })
        if (c) { c.done(); c.doReq(k); c.replayKey(k) }
        this.loadMe()
        this.refresh({ lite: true })
        setTimeout(() => this.flushPending(true), 400)
      },
      // 这个接口挂了不该拦住登录：照原来的路走，进不去再提示
      fail: () => {
        wx.setStorageSync('ak', k)
        this._keyCtx = null
        this.setData({ key_open: false, key_err: '' })
        if (c) { c.done(); c.doReq(k); c.replayKey(k) }
        this.loadMe()
      }
    })
  },
  // 先看看演示：内置口令直接进演示账套（示例数据），不用问任何人要口令
  enterDemoLook() {
    const c = this._keyCtx
    const q = this._keyQueue || []
    wx.setStorageSync('ak', DEMO_KEY)
    this._keyQueue = []
    this._keyCtx = null
    this.setData({ key_open: false, demo: true, role: 'demo' })
    if (c) c.done()
    let skippedWrite = 0
    q.forEach((o) => {
      const m = String((o && o.method) || 'GET').toUpperCase()
      if (m !== 'GET') {
        // 刚才没登录成功的那笔「记一笔 / 收款」不能拿去示例账套里执行：
        // 记录会落在演示账本上，用户以为自己的账记上了，回真账本一看没有。
        skippedWrite++
        try { o.fail && o.fail({ statusCode: 0, demo: true }) } catch (e) { /* 忽略 */ }
        try { o.complete && o.complete({ statusCode: 0, demo: true }) } catch (e) { /* 忽略 */ }
        return
      }
      try { this._send(o, DEMO_KEY) } catch (e) { /* 单个失败不影响别的 */ }
    })
    if (c) c.doReq(DEMO_KEY)
    if (skippedWrite) wx.showToast({ title: '演示账套只是看看，刚才那 ' + skippedWrite + ' 笔没记；记账请输自己的口令', icon: 'none', duration: 2600 })
    this.loadMe()
    this.refresh({ lite: true })
  },
  keyRecover() {
    this.closeKey()
    this.openRecover()
  },
  // 老板关/开「内置演示入口」（审核过了可以关掉，免得谁都能进来看示例账本）
  toggleDemoBuiltin() {
    const on = !!this.data.demo_builtin
    wx.showModal({
      title: on ? '关掉内置演示入口？' : '打开内置演示入口？',
      content: on
        ? '关掉后登录页不再显示「先看看演示」，微信审核员就进不来了。审核过了再关比较稳。'
        : '打开后任何拿到小程序的人都能点「先看看演示」看示例账套（碰不到你的真账本）。',
      confirmText: on ? '关掉' : '打开',
      success: (r) => {
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/auth/demo-builtin', method: 'POST',
          data: { key: wx.getStorageSync('ak'), off: on },
          success: (res) => {
            const d = res.data || {}
            if (d.ok) { this.setData({ demo_builtin: !!d.builtin }); wx.showToast({ title: d.builtin ? '演示入口已打开' : '演示入口已关掉', icon: 'none' }) }
            else wx.showToast({ title: d.error || '改不了', icon: 'none' })
          }
        })
      }
    })
  },
  // 演示模式里点横幅：清掉手上的演示口令，回到「输入我的口令」
  exitDemo() {
    wx.removeStorageSync('ak')
    this.setData({ demo: false, role: 'owner' })
    this.loadMe()
    this.refresh({ fresh: true })
  },
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
  // ===== 毛利分析（按客户 / 按产品） =====
  setMbType(e) { this.setData({ mb_type: e.currentTarget.dataset.t }, () => this.loadMarginBy()) },
  loadMarginBy() {
    const d = this.data
    const m = String(d.mb_month || '').trim()
    let url = API_BASE + '/margin-by?type=' + d.mb_type
    if (/^\d{4}-\d{2}$/.test(m)) url += '&month=' + m
    this.req({
      url,
      success: (res) => {
        const x = res.data || {}
        this.setData({ mb: x.list ? x : null })
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
  pickPPCat(e) { this.setData({ pp_cat: e.currentTarget.dataset.k, pp_months: e.currentTarget.dataset.k === '押金' ? '0' : (this.data.pp_months || '1') }) },
  onPPStart(e) { this.setData({ pp_start: e.detail.value }) },
  addPrepaid() {
    const d = this.data
    if (!(Number(d.pp_total) > 0)) return wx.showToast({ title: '总金额要大于 0', icon: 'none' })
    // 月数 0 = 押金这类不摊的（钱付了但不算成本，退租时收回），所以只拦负数
    if (!(Number(d.pp_months) >= 0) || d.pp_months === '') return wx.showToast({ title: '摊几个月要填（押金填 0）', icon: 'none' })
    this.req({
      url: API_BASE + '/prepaids', method: 'POST',
      data: { name: d.pp_name || d.pp_cat, total: Number(d.pp_total), months: Number(d.pp_months), category: d.pp_cat || '厂房租金', start_date: d.pp_start || '' },
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
        // 三种身份：老板 / 员工 / 演示（只读，给微信审核和试用的人看）
        const r = d.role === 'staff' ? 'staff' : d.role === 'demo' ? 'demo' : 'owner'
        this.setData({ role: r, demo: r === 'demo', staff_enabled: !!d.staff_enabled, demo_enabled: !!d.demo_enabled, demo_builtin: d.demo_builtin !== false, super: !!d.super, super_enabled: !!d.super_enabled, book_admin: !!d.book_admin, book_own_key: !!d.book_own_key })
      }
    })
  },
  loadHistory() {
    const d = this.data
    const q = '?type=' + d.history_type + (d.st_month ? '&month=' + d.st_month : '') + (d.st_kw ? '&kw=' + encodeURIComponent(d.st_kw) : '') + '&limit=100&offset=0'
    this.req({
      url: API_BASE + '/settled' + q,
      success: (res) => { const x = res.data || {}; if (x.ok) this.setData({ st: x }) }
    })
  },
  loadStMore() {
    const d = this.data
    const st = d.st
    if (!st || !st.has_more) return
    const q = '?type=' + d.history_type + (d.st_month ? '&month=' + d.st_month : '') + (d.st_kw ? '&kw=' + encodeURIComponent(d.st_kw) : '') + '&limit=100&offset=' + (st.next_offset || 0)
    wx.showLoading({ title: '再取 100 单…' })
    this.req({
      url: API_BASE + '/settled' + q,
      success: (res) => {
        wx.hideLoading()
        const x = res.data || {}
        if (!x.ok) return
        this.setData({ st: Object.assign({}, st, { rows: (st.rows || []).concat(x.rows || []), has_more: !!x.has_more, next_offset: x.next_offset || 0 }) })
      },
      fail: () => wx.hideLoading()
    })
  },
  setHistoryType(e) {
    this.setData({ history_type: e.currentTarget.dataset.t, st_month: '', st_kw: '' }, () => this.loadHistory())
  },
  pickStMonth(e) {
    const m = e.currentTarget.dataset.m || ''
    this.setData({ st_month: m }, () => this.loadHistory())
  },
  onStKw(e) { this.setData({ st_kw: e.detail.value }) },
  searchSettled() { this.loadHistory() },
  clearStKw() { this.setData({ st_kw: '' }, () => this.loadHistory()) },
  copySettled() {
    const st = this.data.st
    if (!st) return
    const lines = [st.text]
    ;(st.rows || []).slice(0, 60).forEach((x) => {
      lines.push(`${x.settle_date}  ${x.party}  ${x.item}  ¥${x.amount}  ${x.days_text}${x.accs ? '（' + x.accs + '）' : ''}`)
    })
    wx.setClipboardData({ data: lines.join('\n'), success: () => wx.showToast({ title: '已复制' }) })
  },
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
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/backup',
          success: (res) => {
            const text = (res.data && res.data.text) || ''
            if (!text) { wx.showToast({ title: '没拿到备份内容', icon: 'none' }); return }
            // 账本大了整份备份有好几 MB：塞进手机剪贴板基本会失败（微信请求对响应大小也有上限），
            // 所以先按实际大小拦一下，劝他走云端备份；他坚持要复制也允许。
            const mb = text.length / 1048576
            const put = () => wx.setClipboardData({
              data: text,
              success: () => wx.showToast({ title: '已复制，请粘贴保存', icon: 'none' }),
              fail: () => wx.showModal({
                title: '复制失败',
                content: `这段备份有 ${mb.toFixed(1)} MB，手机剪贴板装不下。用「云端备份」存进账本自己的数据库更稳。`,
                confirmText: '云端备份',
                success: (m) => { if (m.confirm) this.cloudBackup() }
              })
            })
            if (mb >= 2) {
              wx.showModal({
                title: `备份有 ${mb.toFixed(1)} MB`,
                content: '这么大一份，塞进剪贴板多半会失败（手机剪贴板扛不住），也白费流量。建议改用「云端备份」，它直接存进账本自己的数据库。',
                confirmText: '云端备份',
                cancelText: '还是复制',
                success: (m) => { if (m.confirm) this.cloudBackup(); else put() }
              })
              return
            }
            put()
          }
        })
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
  // 整库备份：38 张表原样打包，换环境能整包搬回去（口令不进包）
  exportAll() {
    wx.showLoading({ title: '打包中…' })
    this.req({
      url: API_BASE + '/export-all',
      success: (res) => {
        wx.hideLoading()
        const d = res.data || {}
        if (d.error || d.kind !== 'factory-accounting-full') { wx.showToast({ title: (d.error || '打包失败'), icon: 'none' }); return }
        const json = JSON.stringify(d)
        const kb = Math.max(1, Math.round(json.length / 1024))
        wx.showModal({
          title: '整库备份',
          content: '共 ' + d.table_count + ' 张表、' + d.rows_total + ' 行，约 ' + kb + ' KB。包里不含口令，转发也安全。',
          confirmText: '复制', cancelText: '存成文件',
          success: (m) => {
            if (m.confirm) {
              wx.setClipboardData({ data: json, success: () => wx.showToast({ title: '已复制，粘到微信/笔记里存好', icon: 'none' }) })
              return
            }
            const fp = wx.env.USER_DATA_PATH + '/整库备份_' + dayOf(new Date()) + '.json'
            wx.getFileSystemManager().writeFile({
              filePath: fp, data: json, encoding: 'utf8',
              success: () => wx.shareFileMessage({
                filePath: fp,
                fail: () => wx.showModal({ title: '文件已生成', content: fp + '\n可以点右上角转发到电脑保存。', showCancel: false })
              }),
              fail: () => wx.showToast({ title: '写文件失败', icon: 'none' })
            })
          }
        })
      },
      fail: () => { wx.hideLoading(); wx.showToast({ title: '网络不给力，再试一次', icon: 'none' }) }
    })
  },
  // 从整库包恢复（整包覆盖，要手动输「覆盖」）
  restoreAll() {
    const t = (this.data.restore_text || '').trim()
    if (!t) return wx.showToast({ title: '先把整库备份的 JSON 粘到上面的框', icon: 'none' })
    let pkg = null
    try { pkg = JSON.parse(t) } catch (e) { pkg = null }
    if (!pkg || pkg.kind !== 'factory-accounting-full') {
      wx.showModal({
        title: '不是整库包',
        content: '整库包是一段以 kind":"factory-accounting-full" 开头的 JSON。只想补几张单据的话，用下面的「从备份恢复」。',
        showCancel: false
      })
      return
    }
    const at = String(pkg.at || '').slice(0, 10)
    wx.showModal({
      title: '整包覆盖',
      content: '这是 ' + at + ' 的整库备份，共 ' + (pkg.rows_total || 0) + ' 行。覆盖后现在的单据、流水、账户期初都会变成包里的样子（访问口令不变）。确认请输入「覆盖」。',
      editable: true, placeholderText: '输入 覆盖', confirmText: '恢复', confirmColor: '#c00',
      success: (m) => {
        if (!m.confirm) return
        if (String(m.content || '').trim() !== '覆盖') return wx.showToast({ title: '没输入「覆盖」，已取消', icon: 'none' })
        wx.showLoading({ title: '恢复中…' })
        this.req({
          url: API_BASE + '/import-all', method: 'POST',
          data: { pkg, mode: 'replace', confirm: '覆盖' },
          success: (r) => {
            wx.hideLoading()
            const d = r.data || {}
            if (d.error) { wx.showToast({ title: d.error, icon: 'none' }); return }
            wx.showModal({
              title: '恢复完成',
              content: '灌入 ' + d.rows + ' 行、' + Object.keys(d.done || {}).length + ' 张表。访问口令没变，下拉刷新就能看到。',
              showCancel: false,
              success: () => { this.setData({ restore_text: '' }); this.refresh() }
            })
          },
          fail: () => { wx.hideLoading(); wx.showToast({ title: '网络中断，没恢复成功', icon: 'none' }) }
        })
      }
    })
  },
  // 数据量体检 / 清理老日志
  // 回到某一天的账本：列出最近 12 份备份，每份有多少单、多少钱，和现在差多少
  // 账本交接包：换人管账时一页说清（怎么记的、还欠谁、接手怎么用）
  loadHandover() {
    this.req({
      url: API_BASE + '/handover',
      success: (res) => {
        const d = res.data || {}
        const sec = (d.sections || []).find((x) => String(x.title).indexOf('交接备注') >= 0)
        this.setData({ ho: d, ho_open: false, ho_note: sec ? sec.lines.join('\n') : '' })
      }
    })
  },
  copyHandover() {
    const t = (this.data.ho || {}).text || ''
    if (!t) return
    wx.setClipboardData({ data: t, success: () => wx.showToast({ title: '已复制，粘贴给接手人' }) })
  },
  openHandover() { this.setData({ ho_open: !this.data.ho_open }) },
  openHandoverPrint() {
    const u = (this.data.ho || {}).url
    if (!u) return wx.showToast({ title: '先点「生成交接包」', icon: 'none' })
    wx.setClipboardData({
      data: u,
      success: () => wx.showModal({ title: '打印页链接已复制', content: '粘贴到浏览器打开，可以打印或存成 PDF。链接里不含你的访问口令，转发出去也安全。', showCancel: false })
    })
  },
  onHoNote(e) { this.setData({ ho_note: e.detail.value }) },
  saveHoNote() {
    this.req({
      url: API_BASE + '/handover-note', method: 'POST', once: 'ho-note',
      data: { note: this.data.ho_note || '' },
      success: () => { wx.showToast({ title: '备注已保存' }); this.loadHandover() }
    })
  },
  closeHandover() { this.setData({ ho: null, ho_open: false, ho_note: '' }) },
  // 备份能不能用：不是有没有备份，是这份真能恢复吗
  loadBackupVerify() {
    this.req({ url: API_BASE + '/backup-verify', success: (res) => this.setData({ bv: res.data || null }) })
  },
  closeBackupVerify() { this.setData({ bv: null }) },
  loadBackupTimeline() {
    this.req({ url: API_BASE + '/backup-timeline', success: (res) => this.setData({ btl: res.data }) })
  },
  restoreFromBackup(e) {
    const id = e.currentTarget.dataset.id
    const it = ((this.data.btl || {}).items || []).find((x) => String(x.id) === String(id)) || {}
    const cur = (this.data.btl || {}).current || {}
    wx.showModal({
      title: '回到 ' + (it.date || '') + ' 的账本？',
      content: '备份里：应收 ' + it.orders + ' 单（¥' + it.order_sum + '）、应付 ' + it.payables + ' 单、流水 ' + it.ledger + ' 条\n' +
        '现在：应收 ' + cur.orders + ' 单（¥' + cur.order_sum + '）、应付 ' + cur.payables + ' 单、流水 ' + cur.ledger + ' 条\n\n' +
        '恢复会用备份覆盖现在的应收 / 应付 / 流水。现在这份会先存成快照，选错了还能回来。',
      confirmText: '恢复', cancelText: '算了',
      success: (r) => {
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/backup-restore', method: 'POST', once: 'restore-bk',
          // 带上「这份备份属于哪本账」：备份 id 是每本账各自从 1 数的，
          // 切了账套却点上一本留下的那一行，会把这一本的同号备份恢复过来（数据完全不是你想的那份）。
          data: { id: Number(id), confirm: true, book: (this.data.btl || {}).book || this.data.book },
          success: (res) => {
            const d = res.data || {}
            const rs = d.restored || {}
            wx.showModal({ title: '回来了', content: '已恢复到 ' + (it.date || '') + '：应收 ' + rs.orders + ' 单、应付 ' + rs.payables + ' 单、流水 ' + rs.ledger + ' 条', showCancel: false })
            this.refresh(); this.loadBackupTimeline(); this.loadDbStats()
          }
        })
      }
    })
  },
  loadDbStats() {
    this.req({
      url: API_BASE + '/db-stats',
      success: (res) => {
        const d = res.data || {}
        if (d.error) { wx.showToast({ title: d.error, icon: 'none' }); return }
        this.setData({ dbst: { rows: d.rows || [], total: d.total || 0 } })
      }
    })
  },
  cleanData() {
    wx.showActionSheet({
      itemList: ['清理半年前的日志', '清理一年前的日志'],
      success: (a) => {
        const days = a.tapIndex === 1 ? 365 : 180
        wx.showModal({
          title: '清理日志',
          content: '把 ' + (days === 365 ? '一年' : '半年') + '前的操作日志、运行日志、导入记录删掉（回收站只留 30 天、本地快照只留 30 份）。单据和流水不动。',
          confirmText: '清理',
          success: (m) => {
            if (!m.confirm) return
            wx.showLoading({ title: '清理中…' })
            this.req({
              url: API_BASE + '/db-clean', method: 'POST', data: { days },
              success: (r) => {
                wx.hideLoading()
                const d = (r.data && r.data.deleted) || {}
                const txt = Object.keys(d).map((k) => k + ' ' + d[k]).filter((x) => !x.endsWith(' 0')).join('、') || '本来就很干净，没东西可清'
                wx.showModal({ title: '清理完成', content: txt, showCancel: false, success: () => this.loadDbStats() })
              },
              fail: () => { wx.hideLoading(); wx.showToast({ title: '网络不给力，再试一次', icon: 'none' }) }
            })
          }
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
    const amount = this.toAmount(this.data.f_amount) || 0
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
  // 账本封存：老账本对完账封起来，整本只读
  loadSeal() {
    this.req({
      url: API_BASE + '/seal', silent: true,
      success: (r) => {
        const d = r.data || {}
        this.setData({ sealed: !!d.sealed, sealed_at: String(d.sealed_at || '').slice(0, 10), seal_note: d.note || '' })
      }
    })
  },
  goSeal() { this.enterTab('me'); },
  sealBook() {
    wx.showModal({
      title: '封存这本账？', editable: true, placeholderText: '写一句为什么封（如 2026 年账已对完），可不填',
      confirmText: '封存', cancelText: '算了',
      success: (r) => {
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/seal', method: 'POST', once: 'seal',
          data: { note: String(r.content || '') },
          success: () => {
            wx.showModal({ title: '封好了', content: '这本账现在只能看。要改先点「解封」。', showCancel: false })
            this.loadSeal(); this.refresh()
          }
        })
      }
    })
  },
  unsealBook() {
    wx.showModal({
      title: '解封这本账？', content: '解封后就能增删改单据和流水了。解封会在操作日志里留一条记录。',
      confirmText: '解封', cancelText: '算了',
      success: (r) => {
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/unseal', method: 'POST', once: 'unseal',
          data: { confirm: true },
          success: () => { wx.showToast({ title: '已解封' }); this.loadSeal(); this.refresh() }
        })
      }
    })
  },
  onMgMonth(e) { this.setData({ mg_month: e.detail.value }) },
  // 三本账合起来看：分厂/分项目各记一本，老板要一个总数
  // ===== 新账本模板：空账本一次配好分类/账户/账期 =====
  loadBookTpl() {
    this.req({ url: API_BASE + '/book-templates', silent: true, success: (res) => {
      const d = res.data || {}
      if (!d.ok) return
      this.setData({ btp: d })
    } })
  },
  closeBookTpl() { this.setData({ btp: null }) },
  applyBookTpl(e) {
    const k = e.currentTarget.dataset.k
    const d = this.data.btp
    if (!d) return
    const row = (d.rows || []).find((x) => x.k === k) || {}
    wx.showModal({
      title: '按「' + (row.name || k) + '」配一下？',
      content: (row.order || '') + '。\n' + (d.empty ? '这本还空着，照它建最省事。' : '已有的分类和账户会跳过，数据一分不动。'),
      success: (r) => {
        if (!r.confirm) return
        this.req({ url: API_BASE + '/book-template/apply', method: 'POST', once: 'applyBookTpl', data: { tpl: k, confirm: true },
          success: (res) => {
            const x = res.data || {}
            if (!x.ok) return wx.showModal({ title: '没配上', content: x.error || '稍后再试', showCancel: false })
            wx.showModal({ title: '配好了', content: x.text, showCancel: false })
            this.setData({ btp: null })
            this.loadCategories(); this.loadAccounts(); this.loadBookTpl()
          } })
      }
    })
  },
  loadMergeSummary() {
    const m = String(this.data.mg_month || '').trim()
    if (m && !/^\d{4}-\d{2}$/.test(m)) return wx.showToast({ title: '月份写成 2026-11 这样', icon: 'none' })
    wx.showLoading({ title: '汇总中…' })
    this.req({
      url: API_BASE + '/merge-summary' + (m ? '?month=' + encodeURIComponent(m) : ''),
      success: (res) => {
        wx.hideLoading()
        const d = res.data || {}
        if (d.error) return wx.showToast({ title: d.error, icon: 'none' })
        this.setData({ mg: d })
      },
      fail: () => wx.hideLoading()
    })
  },
  closeMergeSummary() { this.setData({ mg: null }) },
  copyMergeSummary() {
    const d = this.data.mg || {}
    if (!d.text) return
    const lines = [d.text, '']
    ;(d.books || []).forEach((b) => {
      if (b.empty) return
      lines.push(b.name + '：接单 ' + b.income + '，净利 ' + b.profit + '，现金 ' + b.cash + '，应收 ' + b.ar + '，应付 ' + b.ap + '，家底 ' + b.net)
    })
    wx.setClipboardData({ data: lines.join('\n'), success: () => wx.showToast({ title: '已复制', icon: 'none' }) })
  },
  loadBooksCheck() {
    this.req({
      url: API_BASE + '/books-check',
      once: 'bcheck',
      success: (r) => {
        if (!r.data || !r.data.ok) return wx.showToast({ title: '看一下不了', icon: 'none' })
        this.setData({ bck: r.data })
      }
    })
  },
  closeBooksCheck() { this.setData({ bck: null }) },
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
    const nb = this.data.books.find((b) => b.id === id) || {}
    // 演示模式后端会强制进第 3 本账，切了也不生效 —— 别假装切成功
    if (this.data.demo) {
      return wx.showToast({ title: '演示账套固定是第 3 本，用自己的口令登录才能切', icon: 'none' })
    }
    wx.showModal({
      title: '切换账套',
      content: '切换到「' + (nb.name || ('第 ' + id + ' 本')) + '」？各账套数据完全分开。',
      success: (r) => {
        if (!r.confirm) return
        wx.showLoading({ title: '正在切换', mask: true })
        // 换账套 = 换一整个数据库。以前只改 book 就 refresh，结果：
        // ①列表里还是上一本的客户（两本的单号都从 1 开始，甚至会把收款记到另一本的同号单上）；
        // ②在途请求的键里没有账套号，上一本的响应回来把这一本的数据盖掉；
        // ③翻页 offset 还停在上一次的页码上。
        this._flight = {}
        this._bq = []
        this._arAll = []
        this._apAll = []
        this._expAll = []
        this._pagBusy = {}
        this.setData({
          book: id,
          book_name: nb.name || ('第 ' + id + ' 本'),
          ar_list: [], ar_off: 0, ar_more: false, ar_kw: '',
          ap_list: [], ap_off: 0, ap_more: false, ap_kw: '',
          expense_list: [], ex_off: 0, ex_more: false,
          ar_sum: null, ap_sum: null, dash_err: '',
          // 「回到某一天」的列表也属于上一本账，必须清掉：备份 id 每本各自从 1 数，
          // 留着上一本的 id 去点「恢复」，恢复的是这一本完全不同的那份。
          btl: null, bv: null, cloud_backup_at: ''
        })
        wx.setStorageSync('book', id)
        if (nb.name) wx.setStorageSync('book_name', nb.name)
        this.loadMe()
        this.refresh()
        // 等第一屏回来再报成功（立刻 toast 会让人以为已经看到了新账套的数据）
        setTimeout(() => {
          wx.hideLoading()
          wx.showToast({ title: '已切到' + (nb.name || ('第 ' + id + ' 本')), icon: 'none' })
        }, 600)
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
    wx.showModal({
      title: '删除常用短语', content: '删掉这条常用短语？',
      success: (r) => { if (r.confirm) this.req({ url: API_BASE + '/phrases/' + id, method: 'DELETE', success: () => this.loadPhrases() }) }
    })
  },
  // ── 支出预算 ──
  loadBudgets() {
    this.req({ url: API_BASE + '/budgets', success: (res) => this.setData({ budgets: res.data || [] }) })
  },
  onBCategory(e) { this.setData({ b_category: Number(e.detail.value) }) },
  onBAmount(e) { this.setData({ b_amount: e.detail.value }) },
  saveBudget() {
    const amount = this.toAmount(this.data.b_amount) || 0
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
    wx.showModal({
      title: '删除预算', content: '删掉这个分类的月度预算额度？',
      success: (r) => { if (r.confirm) this.req({ url: API_BASE + '/budgets/' + id, method: 'DELETE', success: () => { this.loadBudgets(); this.loadDashboard() } }) }
    })
  },
  loadMonthLocks() {
    this.req({ url: API_BASE + '/month-locks', success: (res) => this.setData({ month_locks: res.data || [] }) })
  },
  loadArchives() {
    if (!this.data.this_month) {
      const d = new Date()
      this.setData({ this_month: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') })
    }
    this.req({
      url: API_BASE + '/month-archives',
      success: (res) => {
        const d = res.data || {}
        this.setData({ archives: d.archives || [] })
      }
    })
  },
  closeMonth() {
    const d = this.data
    const m = (d.lock_month || d.this_month || '').trim()
    if (!/^\d{4}-\d{2}$/.test(m)) return wx.showToast({ title: '填月份，如 2026-10', icon: 'none' })
    wx.showLoading({ title: '结账前检查…' })
    this.req({
      url: API_BASE + '/close-precheck?month=' + m,
      success: (res) => {
        wx.hideLoading()
        const pc = res.data || {}
        const items = pc.items || []
        if (!items.length) return this._doClose(m)
        const lines = []
        items.forEach((it) => {
          const mark = it.tone === 'ok' ? '✓ ' : it.tone === 'bad' ? '✗ ' : it.tone === 'warn' ? '！' : '· '
          lines.push(mark + it.tip)
          if (it.after && it.tone !== 'ok') lines.push('     ↳ ' + it.after)
        })
        const li = pc.lock_info
        const tail = (li
          ? '\n\n🔒 结账后会锁住：' + li.blocked + '\n✓ 不受影响：' + li.allowed + '\n🔓 ' + li.unlock
          : (pc.blockers && pc.blockers.length)
            ? '\n\n带 ✗ 的处理一下更稳；照样结账也行——锁上后要改，得先去「月结归档」解锁。'
            : '\n\n结账会出快照并把这个月锁上：之后不能再增删改，要改先去「月结归档」解锁。')
        wx.showModal({
          title: '结账前自检 · ' + m,
          content: lines.join('\n') + tail,
          confirmText: '照样结账',
          cancelText: '再等等',
          success: (r) => { if (r.confirm) this._doClose(m) }
        })
      },
      fail: () => { wx.hideLoading(); this._doClose(m) }
    })
  },
  loadMonthEnd() {
    const m = (this.data.lock_month || this.data.this_month || '').trim()
    this.req({
      url: API_BASE + '/month-end' + (m ? '?month=' + m : ''),
      success: (res) => {
        const d = res.data || {}
        if (!d.ok) return wx.showToast({ title: d.error || '读取失败', icon: 'none' })
        // 净利口径：接单 − 材料·外协 − 现金费用等；这里把两部分拆开展示
        const mat = d.numbers.mat || 0
        d.numbers.mat = mat
        d.numbers.cost_other = Math.round((d.numbers.cost - mat) * 100) / 100
        this.setData({ me: d, lock_month: d.month })
      }
    })
  },
  // 一键结账全年
  yearCloseCheck() {
    const y = (this.data.lock_month || '').slice(0, 4) || ''
    wx.showLoading({ title: '检查中…' })
    this.req({
      url: API_BASE + '/year-close-check' + (y ? '?year=' + y : ''),
      success: (res) => {
        wx.hideLoading()
        const d = res.data || {}
        if (d.error) return wx.showToast({ title: d.error, icon: 'none' })
        const months = (d.months || []).map((m) => ({ ...m, issue_text: (m.issues || []).join('、') }))
        this.setData({ ycl: { ...d, months } })
      },
      fail: () => wx.hideLoading()
    })
  },
  doYearClose() {
    const ycl = this.data.ycl || {}
    if (!ycl.year) return wx.showToast({ title: '先检查一下', icon: 'none' })
    const ask = (msg) => wx.showModal({
      title: '结账前再确认一下', content: msg, showCancel: false,
      success: () => this._doYearClose(ycl.year, true)
    })
    this._doYearClose(ycl.year, false, ask)
  },
  _doYearClose(year, confirmed, ask) {
    wx.showLoading({ title: '结账中…' })
    this.req({
      url: API_BASE + '/year-close',
      method: 'POST',
      data: { year: Number(year), confirm: !!confirmed },
      success: (res) => {
        wx.hideLoading()
        const d = res.data || {}
        if (d.code === 'need_confirm') {
          return ask((d.text || '') + '\n\n照样结账也行——结完这几个月就锁住了，要改得先去「月结归档」解锁。')
        }
        if (d.error) return wx.showToast({ title: d.error, icon: 'none' })
        wx.showModal({
          title: '结完了',
          content: (d.text || '') + '\n\n' + (d.lock_note || '') + '\n' + (d.unlock_how || ''),
          showCancel: false
        })
        this.yearCloseCheck()
        this.loadArchives && this.loadArchives()
      },
      fail: () => wx.hideLoading()
    })
  },
  // 老账搬家
  openMigrate() { this.setData({ mg_open: !this.data.mg_open, mgp: this.data.mg_open ? null : this.data.mgp }) },
  migType(e) { this.setData({ mg_type: e.currentTarget.dataset.t, mgp: null }) },
  onMigText(e) { this.setData({ mg_text: e.detail.value }) },
  onMigDate(e) { this.setData({ mg_date: e.detail.value }) },
  migCostMode(e) { this.setData({ mg_cost_mode: e.currentTarget.dataset.m, mgp: null }) },
  _migBody() {
    return { type: this.data.mg_type, text: this.data.mg_text, date: this.data.mg_date, cost_mode: this.data.mg_cost_mode, margin_pct: this.data.mg_margin }
  },
  migPreview() {
    const b = this._migBody()
    if (!String(b.text || '').trim()) return wx.showToast({ title: '先写几行，比如「兴旺五金,5000」', icon: 'none' })
    wx.showLoading({ title: '看看…' })
    this.req({
      url: API_BASE + '/migrate-preview', method: 'POST', data: b,
      success: (res) => {
        wx.hideLoading()
        const d = res.data || {}
        if (d.error) return wx.showToast({ title: d.error, icon: 'none' })
        this.setData({ mgp: d })
      },
      fail: () => wx.hideLoading()
    })
  },
  migApply() {
    const mgp = this.data.mgp || {}
    if (!mgp.ok_count) return
    const b = this._migBody()
    const go = (confirmDup) => {
      wx.showLoading({ title: '搬入中…' })
      this.req({
        url: API_BASE + '/migrate-apply', method: 'POST', data: { ...b, confirm_dup: !!confirmDup },
        success: (res) => {
          wx.hideLoading()
          const d = res.data || {}
          if (d.error) return wx.showModal({ title: '没搬成', content: d.error, showCancel: false })
          wx.showModal({ title: '搬好了', content: (d.text || '') + (d.tip ? '\n\n' + d.tip : ''), showCancel: false })
          this.setData({ mgp: null, mg_text: '' })
          this.loadOrders && this.loadOrders()
          this.loadPayables && this.loadPayables()
          this.refresh && this.refresh()
        },
        fail: () => wx.hideLoading()
      })
    }
    if (mgp.dup_count) {
      wx.showModal({
        title: '有几笔账上已经有',
        content: `这 ${mgp.dup_count} 笔账上已经有一笔一样的，默认跳过不重复搬。`,
        confirmText: '跳过搬其余', cancelText: '取消',
        success: (r) => { if (r.confirm) go(false) }
      })
    } else go(false)
  },
  closeYearClose() { this.setData({ ycl: null }) },
  openYearClosePrint() {
    const y = (this.data.ycl || {}).year || (this.data.lock_month || '').slice(0, 4)
    if (!y) return wx.showToast({ title: '先在月份框填年份，如 2026-11', icon: 'none' })
    this.req({
      url: API_BASE + '/year-close-print-link?year=' + y,
      success: (res) => {
        const u = (res.data || {}).url
        if (!u) return wx.showToast({ title: '生成不了链接', icon: 'none' })
        wx.setClipboardData({
          data: u,
          success: () => wx.showModal({
            title: '打印链接已复制',
            content: '在电脑浏览器里粘贴打开，就能打印或存 PDF。\n链接带签名，改字符就失效。',
            showCancel: false
          })
        })
      }
    })
  },
  closeMonthEnd() { this.setData({ me: null }) },
  meGo(e) {
    const t = e.currentTarget.dataset.tab || 'report'
    this.enterTab ? this.enterTab(t) : this.setTab({ currentTarget: { dataset: { t } } })
  },
  meClose() {
    const m = this.data.me && this.data.me.month
    if (!m) return
    this.setData({ lock_month: m }, () => this.closeMonth())
  },
  _doClose(m, retry) {
    wx.showLoading({ title: '结转中…' })
    this.req({
      url: API_BASE + '/month-close', method: 'POST', data: { month: m, confirm: !!retry },
      success: (res) => {
        wx.hideLoading()
        const dd = res.data || {}
        if (dd.code === 'need_confirm' && !retry) {
          return wx.showModal({
            title: '还没弄完',
            content: dd.text || dd.error,
            confirmText: '仍然结账',
            success: (r) => { if (r.confirm) this._doClose(m, true) }
          })
        }
        const s = dd.snapshot
        if (!s) return wx.showToast({ title: dd.error || '结转失败', icon: 'none' })
        wx.showModal({
          title: m + ' 已结转',
          content: '接单 ' + s.order_add + '\n材料·外协成本 ' + (s.mat_cost || 0) + '\n现金费用 ' + s.cash_expense + ' · 摊销 ' + s.amort + ' · 折旧 ' + s.dep + ' · 预提息 ' + s.accrue_int + '\n净利 ' + s.profit + '（净利率 ' + s.margin + '%）\n期末现金 ' + s.cash_balance + '\n应收 ' + s.ar_left + ' · 应付 ' + s.ap_left + ' · 借款 ' + s.debt_left + '\n净资产 ' + s.net_worth + '\n\n以后报表就用这份快照，改历史不影响已出报表。\n\n' + (dd.lock_note || '') + '\n' + (dd.unlock_how || '') + '\n' + (dd.not_affected || ''),
          showCancel: false
        })
        this.setData({ lock_month: '' })
        this.loadArchives(); this.loadMonthLocks(); this.refresh()
      },
      fail: () => wx.hideLoading()
    })
  },
  viewArchive(e) {
    const m = e.currentTarget.dataset.m
    this.req({
      url: API_BASE + '/month-archive?month=' + m,
      success: (res) => {
        const s = (res.data || {}).snapshot || {}
        wx.showModal({
          title: m + ' 快照' + (s.archived ? '（已归档·定版）' : '（未归档·现算）'),
          content: '接单 ' + s.order_add + ' / ' + s.order_count + ' 张\n成本 ' + s.cost + '\n毛利 ' + s.profit + '（' + s.margin + '%）\n现金 收 ' + s.income + ' 付 ' + s.outcome + '\n期末现金 ' + s.cash_balance + '\n应收 ' + s.ar_left + ' · 应付 ' + s.ap_left + ' · 借款 ' + s.debt_left + '\n净资产 ' + s.net_worth,
          showCancel: false
        })
      }
    })
  },
  delArchive(e) {
    const m = e.currentTarget.dataset.m
    wx.showModal({
      title: '删掉 ' + m + ' 的归档？',
      content: '会同时解锁该月（之后又能改这个月的账）。已出过的纸质报表不受影响。',
      success: (r) => {
        if (!r.confirm) return
        this.req({
          url: API_BASE + '/month-archive/' + m, method: 'DELETE',
          success: () => { this.loadArchives(); this.loadMonthLocks(); this.refresh() }
        })
      }
    })
  },
  printReport(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const m = ds.m || (this.data.lock_month || '').trim() || this.data.this_month
    this.req({
      url: API_BASE + '/report-link?month=' + (m || ''),
      success: (res) => {
        const u = (res.data || {}).url
        if (!u) return wx.showToast({ title: '没生成出来', icon: 'none' })
        wx.setClipboardData({
          data: u,
          success: () => wx.showModal({
            title: '报表打印链接已复制',
            content: '粘到电脑浏览器打开，Ctrl+P 打印或存 PDF（给会计、银行、客户都行）。手机上打开底部也有「打印」按钮。',
            showCancel: false
          })
        })
      }
    })
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
    if (k === 'acc' || k === 'term') return this.setData({ group: 'me', tab: 'contact' })
    this.setData({ group: 'bill', tab: 'import', import_type: k === 'ap' ? 6 : 5 })
  },
  // 开账向导：一屏把底数填完（账户余额 / 默认账期 / 期初应收 / 期初应付）
  openOnboardWizard() {
    this.req({
      url: API_BASE + '/accounts',
      success: (res) => {
        const accs = ((res.data && res.data.accounts) || []).map((a) => ({
          id: a.id, name: a.name, opening: num0(a.opening) ? String(a.opening) : ''
        }))
        const ob = this.data.onboard || {}
        this.setData({
          tab: 'home', group: 'home',
          ob_open: true, ob_accs: accs,
          ob_term: String(ob.default_term || 30),
          ob_ar: this.data.ob_ar || '', ob_ap: this.data.ob_ap || ''
        })
      }
    })
  },
  closeObWizard() { this.setData({ ob_open: false }) },
  onObAcc(e) {
    const i = Number(e.currentTarget.dataset.i)
    const list = (this.data.ob_accs || []).slice()
    if (!list[i]) return
    list[i].opening = e.detail.value
    this.setData({ ob_accs: list })
  },
  onObTerm(e) { this.setData({ ob_term: e.detail.value }) },
  onObAr(e) { this.setData({ ob_ar: e.detail.value }) },
  onObAp(e) { this.setData({ ob_ap: e.detail.value }) },
  applyOnboarding() {
    if (this.data.ob_busy) return
    const accs = (this.data.ob_accs || []).map((a) => ({ id: a.id, opening: num0(a.opening) }))
    const arText = String(this.data.ob_ar || '').trim()
    const apText = String(this.data.ob_ap || '').trim()
    if (!accs.some((a) => a.opening > 0) && !arText && !apText && !num0(this.data.ob_term)) {
      return wx.showToast({ title: '先填一项再保存', icon: 'none' })
    }
    this.setData({ ob_busy: true })
    this.req({
      url: API_BASE + '/onboarding/apply',
      method: 'POST',
      data: { accounts: accs, term: num0(this.data.ob_term), ar_text: arText, ap_text: apText },
      success: (res) => {
        const d = res.data || {}
        this.setData({ ob_busy: false, ob_open: false, ob_ar: '', ob_ap: '' })
        wx.showModal({ title: '开账完成', content: d.text || '记好了，可以开始记账了。', showCancel: false })
        this.loadOnboard(); this.loadAccounts(); this.loadAr(); this.loadAp(); this.loadDashboard()
      },
      fail: () => this.setData({ ob_busy: false })
    })
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
  // 该开还没开的票：按单子算待开金额，一键开
  loadInvoiceTodo() {
    this.req({
      url: API_BASE + '/invoice-todo?rate=' + (this.data.itd_rate || 0.13),
      success: (res) => {
        const d = res.data || {}
        if (d.error) return wx.showToast({ title: d.error, icon: 'none' })
        this.setData({ itd: d })
      },
      fail: () => wx.showToast({ title: '取不到待开票清单', icon: 'none' })
    })
  },
  closeInvoiceTodo() { this.setData({ itd: null }) },
  copyInvTodoOne(e) {
    const r = ((this.data.itd || {}).rows || [])[Number(e.currentTarget.dataset.i)]
    if (!r) return
    wx.setClipboardData({ data: r.text, success: () => wx.showToast({ title: '开票信息已复制', icon: 'none' }) })
  },
  copyInvTodoAll() {
    const d = this.data.itd || {}
    if (!d.all_text) return wx.showToast({ title: '没有要开的', icon: 'none' })
    wx.setClipboardData({ data: d.all_text, success: () => wx.showToast({ title: '全部已复制', icon: 'none' }) })
  },
  openInvFromOrder(e) {
    const i = Number(e.currentTarget.dataset.i)
    const r = ((this.data.itd || {}).rows || [])[i]
    if (!r) return
    wx.showModal({
      title: '开这张的票',
      editable: true,
      placeholderText: '开票金额（留空 = 全部 ' + r.todo + ' 元）',
      content: String(r.todo),
      success: (m) => {
        if (!m.confirm) return
        const amt = String(m.content || '').trim()
        this.req({
          url: API_BASE + '/invoice-from-order', method: 'POST',
          data: { order_id: r.order_id, rate: (this.data.itd || {}).rate || 0.13, amount: amt ? Number(amt) : undefined },
          success: (res) => {
            const d = res.data || {}
            if (d.error) return wx.showModal({ title: '没开成', content: d.error, showCancel: false })
            wx.showModal({ title: '开好了', content: d.text + (d.left > 0 ? '\n还剩 ' + d.left + ' 元没开。' : ''), showCancel: false })
            this.loadInvoiceTodo()
          }
        })
      }
    })
  },
  skipInvoice(e) {
    const r = ((this.data.itd || {}).rows || [])[Number(e.currentTarget.dataset.i)]
    if (!r) return
    wx.showModal({
      title: '这家不要票？',
      content: r.party + ' 的这张单（' + r.todo + ' 元）以后不再提醒开票。想反悔可以在发票台账里重新打开。',
      confirmText: '不要票',
      success: (m) => {
        if (!m.confirm) return
        this.req({
          url: API_BASE + '/invoice-skip', method: 'POST', data: { order_id: r.order_id, skip: true },
          success: () => { wx.showToast({ title: '已记下', icon: 'none' }); this.loadInvoiceTodo() }
        })
      }
    })
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
        this.setData({ asset_rows: d.rows || [], asset_cost_total: d.total_cost || 0, asset_monthly: d.total_monthly || 0, asset_net: d.total_net || 0,
          asset_sold_gain: d.sold_gain || 0, asset_sold_amount: d.sold_amount || 0, asset_sold_count: d.sold_count || 0 })
      }
    })
  },
  onAssetName(e) { this.setData({ asset_name: e.detail.value }) },
  onAssetCost(e) { this.setData({ asset_cost: e.detail.value }) },
  onAssetBuy(e) { this.setData({ asset_buy: e.detail.value }) },
  onAssetLife(e) { this.setData({ asset_life: e.detail.value }) },
  onAssetMaint(e) { this.setData({ asset_maint: e.detail.value }) },
  onAssetRes(e) { this.setData({ asset_res: e.detail.value }) },
  // 设备保养
  loadAssetMaint() {
    this.req({ url: API_BASE + '/asset-maint', success: (r) => { const d = r.data || {}; if (d.ok) this.setData({ am: d }) } })
  },
  closeAssetMaint() { this.setData({ am: null }) },
  doMaint(e) {
    const id = Number(e.currentTarget.dataset.id)
    const months = Number(e.currentTarget.dataset.m) || 0
    if (!id) return
    wx.showModal({ title: '记一次保养', content: '是今天保养的吗？记下后按 ' + (months || '不') + ' 个月后再提醒。', success: (r) => {
      if (!r.confirm) return
      this.req({ url: API_BASE + '/assets/' + id + '/maint', method: 'POST', data: { months }, success: (res) => {
        const d = res.data || {}
        if (!d.ok) return wx.showToast({ title: d.error || '没记上', icon: 'none' })
        wx.showToast({ title: '记上了' }); this.loadAssets(); this.loadAssetMaint()
      } })
    } })
  },
  copyAssetMaint() {
    const d = this.data.am
    if (!d) return
    wx.setClipboardData({ data: d.text + '\n' + d.advice, success: () => wx.showToast({ title: '已复制' }) })
  },
  // 供应商比价（录应付时提示这次贵不贵）
  loadSupplyPrice() {
    const d = this.data
    const party = String(d.p_supplier || '').trim()
    if (!party) { this.setData({ sp_hint: '' }); return }
    const amt = Number(d.p_amount) || 0
    this.req({ url: API_BASE + '/supply-price?party=' + encodeURIComponent(party) + (amt ? '&amount=' + amt : ''), silent: true, success: (r) => {
      const x = r.data || {}
      if (x.ok) this.setData({ sp_hint: x.hint || '', sp_cnt: x.cnt, sp_avg: x.avg })
    } })
  },
  loadSupplyBook() {
    this.req({ url: API_BASE + '/supply-price', success: (r) => { const d = r.data || {}; if (d.ok) this.setData({ spb: d }) } })
  },
  closeSupplyBook() { this.setData({ spb: null }) },
  // ===== 客户分给员工（员工只看自己负责的那几家） =====
  // ===== 材料台账：进货 / 领用 / 还剩多少 =====
  loadMaterials() {
    this.req({ url: API_BASE + '/materials', silent: true, success: (res) => {
      const d = res.data || {}
      if (!d.ok) return
      this.setData({ mat: d, mats_names: (d.rows || []).map((r) => r.name) })
    } })
  },
  pickMat(e) {
    const n = this.data.mats_names[Number(e.detail.value)] || ''
    this.setData({ mt_name: n })
    if (n) this.loadMoves(n)
  },
  onMtName(e) { this.setData({ mt_name: e.detail.value }) },
  onMtKind(e) { this.setData({ mt_kind: Number(e.currentTarget.dataset.k) }) },
  onMtQty(e) { this.setData({ mt_qty: e.detail.value }) },
  onMtPrice(e) { this.setData({ mt_price: e.detail.value }) },
  onMtDate(e) { this.setData({ mt_date: e.detail.value }) },
  onMtNote(e) { this.setData({ mt_note: e.detail.value }) },
  onMatUnit(e) { this.setData({ mat_unit: e.detail.value }) },
  onMatMin(e) { this.setData({ mat_min: e.detail.value }) },
  toggleMatNew() { this.setData({ mat_new: !this.data.mat_new }) },
  addMaterial() {
    const name = (this.data.mt_name || '').trim()
    if (!name) return wx.showToast({ title: '先写材料名（钢板 / 焊丝 / 砂轮）', icon: 'none' })
    this.req({ url: API_BASE + '/materials', method: 'POST', once: 'addMaterial',
      data: { name, unit: this.data.mat_unit || '个', min_qty: Number(this.data.mat_min) || 0 },
      success: (res) => {
        const d = res.data || {}
        if (!d.ok) return wx.showModal({ title: '没存上', content: d.error || '稍后再试', showCancel: false })
        wx.showToast({ title: '建好了', icon: 'success' })
        this.setData({ mat_new: false, mat_unit: '个', mat_min: '' })
        this.loadMaterials()
      } })
  },
  addMove() {
    const name = (this.data.mt_name || '').trim()
    if (!name) return wx.showToast({ title: '先写材料名（如 钢板）', icon: 'none' })
    const kind = this.data.mt_kind === 1 ? 'out' : 'in'
    const qty = Number(this.data.mt_qty) || 0
    if (!(qty > 0)) return wx.showToast({ title: '数量要大于 0', icon: 'none' })
    const body = { material: name, kind, qty, price: this.toAmount(this.data.mt_price) || 0, date: this.data.mt_date || '', note: this.data.mt_note || '' }
    this.req({ url: API_BASE + '/material-moves', method: 'POST', once: 'addMove', queue: true, data: body,
      success: (res) => {
        const d = res.data || {}
        if (!d.ok) {
          if (d.code === 'over_out') {
            return wx.showModal({ title: '领多了', content: d.error, confirmText: '确实领这么多', cancelText: '我改一下',
              success: (r) => { if (r.confirm) { body.allow_negative = true; this._postMove(body) } } })
          }
          return wx.showModal({ title: '没记上', content: d.error || '稍后再试', showCancel: false })
        }
        wx.showToast({ title: (kind === 'in' ? '进了 ' : '领了 ') + qty, icon: 'success' })
        this.setData({ mt_qty: '', mt_note: '', mt_price: kind === 'in' ? this.data.mt_price : '' })
        this.loadMaterials()
        this.loadMoves(name)
      } })
  },
  _postMove(body) {
    this.req({ url: API_BASE + '/material-moves', method: 'POST', data: body,
      success: (res) => { if ((res.data || {}).ok) { wx.showToast({ title: '记上了', icon: 'success' }); this.loadMaterials(); this.loadMoves(body.material) } } })
  },
  loadMoves(name) {
    const n = name || this.data.mv_open || this.data.mt_name
    if (!n) return
    this.req({ url: API_BASE + '/material-moves?material=' + encodeURIComponent(n), silent: true, success: (res) => {
      const d = res.data || {}
      if (!d.ok) return
      this.setData({ mv_open: n, mv: d.rows || [] })
    } })
  },
  closeMoves() { this.setData({ mv_open: '', mv: [] }) },
  pickMatRow(e) { const n = e.currentTarget.dataset.n; this.setData({ mt_name: n }); this.loadMoves(n) },
  delMove(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({ title: '删掉这条？', content: '删掉后结存会跟着变。', success: (r) => {
      if (!r.confirm) return
      this.req({ url: API_BASE + '/material-moves/' + id, method: 'DELETE', success: () => {
        this.loadMaterials(); this.loadMoves(this.data.mv_open)
      } })
    } })
  },
  loadPartyStaff() {
    this.req({ url: API_BASE + '/party-staff', success: (r) => {
      const d = r.data || {}
      if (!d.ok) return wx.showToast({ title: d.error || '没取到', icon: 'none' })
      this.setData({ psv: d })
    } })
  },
  closePartyStaff() { this.setData({ psv: null }) },
  assignPartyStaff(e) {
    const party = e.currentTarget.dataset.party || ''
    const names = (this.data.psv && this.data.psv.staff) || []
    const staff = names[Number(e.detail.value)] || ''
    if (!party || !staff) return
    this.req({ url: API_BASE + '/party-staff', method: 'POST', data: { party, staff }, success: (r) => {
      const x = r.data || {}
      if (!x.ok) return wx.showModal({ title: '没分上', content: x.error || '', showCancel: false })
      wx.showToast({ title: party + ' → ' + staff })
      this.loadPartyStaff()
    } })
  },
  unassignPartyStaff(e) {
    const party = e.currentTarget.dataset.party || ''
    this.req({ url: API_BASE + '/party-staff', method: 'POST', data: { party, staff: '' }, success: () => {
      wx.showToast({ title: '取消了' })
      this.loadPartyStaff()
    } })
  },
  // ===== 合同 / 框架价 =====
  loadFramePrices() {
    const party = String(this.data.fr_party_kw || '').trim()
    this.req({ url: API_BASE + '/frame-prices' + (party ? '?kw=' + encodeURIComponent(party) : ''), success: (r) => {
      const d = r.data || {}
      if (!d.ok) return wx.showToast({ title: d.error || '没取到', icon: 'none' })
      this.setData({ fp: d })
    } })
  },
  closeFramePrices() { this.setData({ fp: null }) },
  onFrField(e) { this.setData({ [e.currentTarget.dataset.k]: e.detail.value }) },
  addFramePrice() {
    const d = this.data
    const body = {
      party: String(d.fr_party || '').trim(), item: String(d.fr_item || '').trim(),
      price: Number(d.fr_price) || 0, unit: String(d.fr_unit || '件').trim(), note: String(d.fr_note || '').trim()
    }
    if (!body.party) return wx.showToast({ title: '填客户名', icon: 'none' })
    if (body.price <= 0) return wx.showToast({ title: '框架价要大于 0', icon: 'none' })
    this.req({ url: API_BASE + '/frame-prices', method: 'POST', data: body, success: (r) => {
      const x = r.data || {}
      if (!x.ok) return wx.showModal({ title: '没加上', content: x.error || '', showCancel: false })
      wx.showToast({ title: '加上了' })
      this.setData({ fr_item: '', fr_price: '', fr_note: '' })
      this.loadFramePrices()
    } })
  },
  delFramePrice(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({ title: '停用这条框架价？', content: '停用后不再用它提醒，历史单据不受影响。', success: (r) => {
      if (!r.confirm) return
      this.req({ url: API_BASE + '/frame-prices/' + id, method: 'DELETE', success: () => this.loadFramePrices() })
    } })
  },
  frameForParty(e) {
    const party = e.currentTarget.dataset.party || ''
    this.setData({ fr_party: party, fr_party_kw: party })
    this.loadFramePrices()
  },
  // ===== 外协台账 =====
  loadOutsource() {
    this.req({ url: API_BASE + '/outsource-book', success: (r) => {
      const d = r.data || {}
      if (!d.ok) return wx.showToast({ title: d.error || '没取到', icon: 'none' })
      this.setData({ os: d })
    } })
  },
  closeOutsource() { this.setData({ os: null }) },
  onOsField(e) { this.setData({ [e.currentTarget.dataset.k]: e.detail.value }) },
  addOutsource() {
    const d = this.data
    const body = {
      party: String(d.os_party || '').trim(), item: String(d.os_item || '').trim(),
      qty: Number(d.os_qty) || 0, price: Number(d.os_price) || 0, due_date: String(d.os_due || '').trim()
    }
    if (!body.party) return wx.showToast({ title: '填外协给谁', icon: 'none' })
    this.req({ url: API_BASE + '/outsource', method: 'POST', data: body, success: (r) => {
      const x = r.data || {}
      if (!x.ok) return wx.showModal({ title: '没记上', content: x.error || '', showCancel: false })
      wx.showToast({ title: '记上了' })
      this.setData({ os_party: '', os_item: '', os_qty: '', os_price: '', os_due: '' })
      this.loadOutsource()
    } })
  },
  osBack(e) {
    const id = e.currentTarget.dataset.id
    this.req({ url: API_BASE + '/outsource/' + id + '/back', method: 'POST', data: {}, success: (r) => {
      const x = r.data || {}
      wx.showToast({ title: x.note || '标好了', icon: 'none' })
      this.loadOutsource()
    } })
  },
  osDel(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({ title: '删掉这条外协？', content: '删了就查不到这笔发出的活了。', success: (r) => {
      if (!r.confirm) return
      this.req({ url: API_BASE + '/outsource/' + id, method: 'DELETE', success: () => this.loadOutsource() })
    } })
  },
  copyOutsource() {
    const d = this.data.os
    if (!d) return
    wx.setClipboardData({ data: d.text, success: () => wx.showToast({ title: '已复制' }) })
  },
  // ===== 本周排产 / 交期 =====
  loadDeliveryPlan() {
    const d = Math.max(1, Number(this.data.dp_days) || 7)
    this.req({ url: API_BASE + '/delivery-plan?days=' + d, success: (r) => {
      const x = r.data || {}
      if (!x.ok) return wx.showToast({ title: x.error || '没取到', icon: 'none' })
      this.setData({ dp: x })
    } })
  },
  closeDeliveryPlan() { this.setData({ dp: null }) },
  onDpDays(e) { this.setData({ dp_days: e.detail.value }) },
  copyDeliveryPlan() {
    const d = this.data.dp
    if (!d) return
    wx.setClipboardData({ data: d.text, success: () => wx.showToast({ title: '已复制' }) })
  },
  goOrderFromDp(e) {
    const id = e.currentTarget.dataset.id
    this.req({ url: API_BASE + '/orders/' + id + '/detail', success: (r) => {
      const x = r.data || {}
      if (!x.ok) return
      this.setData({ detail: x, detail_show: true })
    } })
  },
  // ===== 返工 / 报废 / 客诉 =====
  loadWip() {
    this.req({ url: API_BASE + '/wip', success: (res) => { const d = res.data || {}; if (d.ok !== false) this.setData({ wip: d }) } })
  },
  loadOntime() {
    this.req({ url: API_BASE + '/ontime?months=6', success: (res) => { const d = res.data || {}; if (d.ok !== false) this.setData({ ot: d }) } })
  },
  openWipFromHome() {
    // 从首页「车间压着」点进来：切到报表页并直接展开面板
    this.setData({ tab: 'stat' })
    this.enterTab('stat')
    this.openWip()
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
  },
  openWip() { this.loadWip(); this.loadOntime() },
  closeWip() { this.setData({ wip: null, ot: null }) },
  copyWip() {
    const w = this.data.wip, o = this.data.ot
    if (!w) return
    const L = [w.text]
    if (o && o.count) L.push(o.text)
    ;(w.advice || []).forEach((t) => L.push('· ' + t))
    ;(w.by_progress || []).slice(0, 5).forEach((x) => L.push(`押在「${x.k}」：${x.cnt} 张、材料 ¥${x.cost}`))
    wx.setClipboardData({ data: L.join('\n'), success: () => wx.showToast({ title: '已复制' }) })
  },
  goWipOrder(e) {
    const id = e.currentTarget.dataset.id
    if (id) this.showDetail({ currentTarget: { dataset: { type: 'ar', id } } })
  },
  loadReworkBook() {
    const mm = String(this.data.rwk_month || '').trim() || dayOf().slice(0, 7)
    this.req({ url: API_BASE + '/rework-book?month=' + mm, success: (r) => {
      const d = r.data || {}
      if (!d.ok) return wx.showToast({ title: d.error || '没取到', icon: 'none' })
      this.setData({ rwk: d, rwk_month: d.month })
    } })
  },
  closeReworkBook() { this.setData({ rwk: null }) },
  onRwkMonth(e) { this.setData({ rwk_month: e.detail.value }) },
  onRwField(e) { this.setData({ [e.currentTarget.dataset.k]: e.detail.value }) },
  onRwKind(e) { this.setData({ rw_kind: e.currentTarget.dataset.k }) },
  onRwFault(e) { this.setData({ rw_fault_idx: Number(e.detail.value) }) },
  addRework() {
    const d = this.data
    const faults = ['self', 'material', 'customer', 'design', 'other']
    const body = {
      kind: d.rw_kind || 'rework',
      party: String(d.rw_party || '').trim(),
      item: String(d.rw_item || '').trim(),
      qty: Number(d.rw_qty) || 0,
      cost: Number(d.rw_cost) || 0,
      reason: String(d.rw_reason || '').trim(),
      fault: faults[Number(d.rw_fault_idx) || 0],
      fix: String(d.rw_fix || '').trim(),
      date: dayOf()
    }
    if (!body.party && !body.reason) return wx.showToast({ title: '填客户或写一句问题', icon: 'none' })
    this.req({ url: API_BASE + '/rework', method: 'POST', data: body, success: (r) => {
      const x = r.data || {}
      if (!x.ok) return wx.showModal({ title: '没记上', content: x.error || '', showCancel: false })
      wx.showToast({ title: '记上了' })
      this.setData({ rw_party: '', rw_item: '', rw_qty: '', rw_cost: '', rw_reason: '', rw_fix: '' })
      this.loadReworkBook()
    } })
  },
  delRework(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({ title: '删掉这条？', content: '删了损失台账会跟着变。', success: (r) => {
      if (!r.confirm) return
      this.req({ url: API_BASE + '/rework/' + id, method: 'DELETE', success: () => this.loadReworkBook() })
    } })
  },
  copyReworkBook() {
    const d = this.data.rwk
    if (!d) return
    wx.setClipboardData({ data: d.text, success: () => wx.showToast({ title: '已复制' }) })
  },
  // ===== 计件工资：记工 → 工资表 → 发工资 → 工资单 =====
  loadPayroll() {
    const mm = String(this.data.pw_month || '').trim() || dayOf().slice(0, 7)
    this.req({ url: API_BASE + '/payroll?month=' + mm, success: (r) => {
      const d = r.data || {}
      if (!d.ok) return wx.showToast({ title: d.error || '没取到工资表', icon: 'none' })
      this.setData({ pw: d, pw_month: d.month })
      this.loadWageRecs(d.month)
    } })
  },
  closePayroll() { this.setData({ pw: null, pw_recs: [] }) },
  onPwMonth(e) { this.setData({ pw_month: e.detail.value }) },
  onPwField(e) { this.setData({ [e.currentTarget.dataset.k]: e.detail.value }) },
  loadWageRecs(mm) {
    const m = mm || this.data.pw_month || dayOf().slice(0, 7)
    this.req({ url: API_BASE + '/wage-records?month=' + m, silent: true, success: (r) => { const d = r.data || {}; if (d.ok) this.setData({ pw_recs: d.rows || [] }) } })
  },
  addWageRec() {
    const d = this.data
    const worker = String(d.pw_worker || '').trim()
    if (!worker) return wx.showToast({ title: '先填工人姓名', icon: 'none' })
    const body = {
      worker, date: String(d.pw_date || '').trim() || dayOf(),
      item: String(d.pw_item || ''), process: String(d.pw_process || ''),
      qty: Number(d.pw_qty) || 1, rate: Number(d.pw_rate) || 0
    }
    this.req({ url: API_BASE + '/wage-records', method: 'POST', data: body, success: (r) => {
      const x = r.data || {}
      if (!x.ok) return wx.showModal({ title: '没记上', content: x.error || '', showCancel: false })
      wx.showToast({ title: '记上了 ¥' + x.total })
      this.setData({ pw_worker: '', pw_item: '', pw_process: '', pw_qty: '', pw_rate: '' })
      this.loadPayroll()
    } })
  },
  delWageRec(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({ title: '删掉这条记工？', content: '删了工资表会跟着变。', success: (r) => {
      if (!r.confirm) return
      this.req({ url: API_BASE + '/wage-records/' + id, method: 'DELETE', success: (res) => {
        const d = res.data || {}
        if (!d.ok) return wx.showToast({ title: d.error || '没删掉', icon: 'none' })
        this.loadPayroll()
      } })
    } })
  },
  payWorker(e) { this._payWage([e.currentTarget.dataset.w]) },
  payAllWorkers() {
    const p = this.data.pw
    if (!p) return
    const list = (p.rows || []).filter((r) => r.left > 0.005).map((r) => r.worker)
    if (!list.length) return wx.showToast({ title: '这个月都发完了', icon: 'none' })
    this._payWage(list)
  },
  _payWage(workers) {
    const mm = this.data.pw_month
    wx.showModal({ title: '发工资', content: '给 ' + workers.join('、') + ' 发 ' + mm + ' 的工资？会记一笔现金支出（分类「工资」）。', success: (r) => {
      if (!r.confirm) return
      this.req({ url: API_BASE + '/payroll/pay', method: 'POST', data: { month: mm, workers }, success: (res) => {
        const d = res.data || {}
        if (!d.ok) return wx.showModal({ title: '没发成', content: d.error || '', showCancel: false })
        wx.showToast({ title: '发了 ¥' + d.total })
        this.loadPayroll()
        this.loadDashboard()
      } })
    } })
  },
  // ===== 从工资里扣宿舍水电（厂里先付房东，再按人头扣回来）=====
  toggleWageDeduct() {
    const open = !this.data.wd_open
    this.setData({ wd_open: open })
    if (open) this.loadWageDeducts()
  },
  onWdField(e) { this.setData({ [e.currentTarget.dataset.k]: e.detail.value }) },
  pickWdKind(e) { this.setData({ wd_kind: e.currentTarget.dataset.k }) },
  loadWageDeducts(mm) {
    const m = mm || this.data.pw_month || dayOf().slice(0, 7)
    this.req({ url: API_BASE + '/wage-deducts?month=' + m, silent: true, success: (r) => {
      const d = r.data || {}
      if (d.ok) this.setData({ wd_rows: d.rows || [] })
    } })
  },
  addWageDeduct() {
    const d = this.data
    const mm = d.pw_month || dayOf().slice(0, 7)
    const workers = String(d.wd_workers || '').split(/[，,、\s]+/).map((x) => x.trim()).filter(Boolean)
    const amount = Number(d.wd_amount) || 0
    if (!workers.length) return wx.showToast({ title: '扣谁？填个名字', icon: 'none' })
    if (!(amount > 0)) return wx.showToast({ title: '每人扣多少', icon: 'none' })
    this.req({ url: API_BASE + '/wage-deducts', method: 'POST', once: 'addWd',
      data: { month: mm, workers, amount, kind: d.wd_kind, remark: d.wd_remark || '' },
      success: (r) => {
        const x = r.data || {}
        if (!x.ok) return wx.showModal({ title: '没扣成', content: x.error || '', showCancel: false })
        wx.showToast({ title: '扣了 ' + x.added + ' 人' })
        this.setData({ wd_workers: '', wd_amount: '', wd_remark: '' })
        this.loadWageDeducts(mm)
        this.loadPayroll()
      } })
  },
  delWageDeduct(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({ title: '删掉这条扣款？', content: '删了实发工资会变回来。', success: (r) => {
      if (!r.confirm) return
      this.req({ url: API_BASE + '/wage-deducts/' + id, method: 'DELETE', success: (res) => {
        const d = res.data || {}
        if (!d.ok) return wx.showToast({ title: d.error || '没删掉', icon: 'none' })
        this.loadWageDeducts()
        this.loadPayroll()
      } })
    } })
  },
  printPayroll() {
    const mm = this.data.pw_month || dayOf().slice(0, 7)
    this.req({ url: API_BASE + '/payroll-link?month=' + mm, success: (r) => {
      const d = r.data || {}
      if (!d.ok || !d.url) return wx.showToast({ title: '没生成链接', icon: 'none' })
      wx.setClipboardData({ data: d.url, success: () => wx.showModal({ title: '工资单链接已复制', content: '发到电脑上打开就能打印或存 PDF（' + mm + '）。', showCancel: false }) })
    } })
  },
  loadWageRates() {
    this.req({ url: API_BASE + '/wage-rates', success: (r) => { const d = r.data || {}; if (d.ok) this.setData({ pw_rates: d }) } })
  },
  closeWageRates() { this.setData({ pw_rates: null }) },
  onWrField(e) { this.setData({ [e.currentTarget.dataset.k]: e.detail.value }) },
  addWageRate() {
    const d = this.data
    const worker = String(d.wr_worker || '').trim()
    const rate = Number(d.wr_rate) || 0
    if (!worker) return wx.showToast({ title: '填工人姓名（通用写 *）', icon: 'none' })
    if (rate <= 0) return wx.showToast({ title: '一件多少钱要大于 0', icon: 'none' })
    this.req({ url: API_BASE + '/wage-rates', method: 'POST', data: { worker, item: String(d.wr_item || ''), rate, unit: String(d.wr_unit || '件') }, success: (r) => {
      const x = r.data || {}
      if (!x.ok) return wx.showToast({ title: x.error || '没加上', icon: 'none' })
      this.setData({ wr_item: '', wr_rate: '' })
      this.loadWageRates()
    } })
  },
  delWageRate(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除计件单价', content: '删掉这条单价？已经记过的工不受影响。',
      success: (r) => { if (r.confirm) this.req({ url: API_BASE + '/wage-rates/' + id, method: 'DELETE', success: () => this.loadWageRates() }) }
    })
  },
  copySupplyBook() {
    const d = this.data.spb
    if (!d) return
    const t = (d.rows || []).map((r) => r.party + '　' + r.cnt + ' 笔　共 ' + r.total + '　平均 ' + r.avg).join('\n')
    wx.setClipboardData({ data: '【供应商比价】\n' + t, success: () => wx.showToast({ title: '已复制' }) })
  },
  addAsset() {
    const d = this.data
    if (!String(d.asset_name || '').trim()) return wx.showToast({ title: '填设备名称', icon: 'none' })
    if (!Number(d.asset_cost)) return wx.showToast({ title: '填设备原值', icon: 'none' })
    this.req({
      url: API_BASE + '/assets', method: 'POST',
      data: { name: d.asset_name, cost: Number(d.asset_cost), buy_date: d.asset_buy, life_years: Number(d.asset_life) || 5, residual_rate: d.asset_res === '' ? 5 : Number(d.asset_res), maint_months: Number(d.asset_maint) || 0 },
      success: (res) => {
        if (res.data && res.data.ok) {
          this.setData({ asset_name: '', asset_cost: '', asset_buy: '', asset_life: '', asset_res: '', asset_maint: '' })
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
  // 卖掉/报废：填卖了多少钱 → 进现金、停止折旧、自动算赚了还是亏了
  disposeAsset(e) {
    const id = e.currentTarget.dataset.id
    const row = (this.data.asset_rows || []).find((x) => String(x.id) === String(id)) || {}
    wx.showModal({
      title: '卖了多少钱？',
      content: `「${row.name || ''}」现在的账面是 ¥${row.net || 0}。卖了多少钱填一下（报废就填 0）。`,
      editable: true,
      placeholderText: '例如 8000',
      success: (r) => {
        if (!r.confirm) return
        const amount = Number(String(r.content || '').replace(/[^0-9.]/g, ''))
        if (isNaN(amount)) return wx.showToast({ title: '填个数字，报废填 0', icon: 'none' })
        this.disposeAskDate(id, amount)
      }
    })
  },
  disposeAskDate(id, amount) {
    wx.showActionSheet({
      itemList: ['今天卖的', '选个别的日子'],
      success: (r) => {
        if (r.tapIndex === 1) {
          // 用当前日期兜底，简单起见让用户输 YYYY-MM-DD
          wx.showModal({
            title: '哪一天卖的？',
            editable: true, placeholderText: '例如 2026-11-16',
            success: (m) => {
              if (!m.confirm) return
              this.doDispose(id, amount, String(m.content || '').trim())
            }
          })
          return
        }
        this.doDispose(id, amount, '')
      },
      fail: () => {}
    })
  },
  doDispose(id, amount, date) {
    this.req({
      url: API_BASE + '/assets/' + id + '/dispose',
      method: 'POST',
      once: true,
      data: { amount, date },
      success: (res) => {
        const d = res.data || {}
        if (!d.ok) return wx.showModal({ title: '没记上', content: d.error || '重试一下', showCancel: false })
        wx.showModal({
          title: d.gain >= 0 ? '卖赚了' : '卖亏了',
          content: `${d.note}\n\n已经记成一笔现金收入（¥${d.amount}），这台设备的折旧到此为止。`,
          showCancel: false
        })
        this.loadAssets(); this.loadAccounts(); this.refresh()
      }
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
        if (d.ok) {
          this.setData({ bank_text: '', bank_layout: d.layout_text || '', bank_skip: d.skipped || 0 })
          this.loadBankFlows()
          wx.showToast({ title: '导入 ' + d.imported + ' 笔', icon: 'success' })
        }
        else wx.showToast({ title: d.error || '导入失败', icon: 'none' })
      }
    })
  },
  // 银行/微信/支付宝导出的 xlsx，直接选文件导（不用另存 CSV）
  importBankFile() {
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
            wx.showLoading({ title: '认出什么表…' })
            this.filePayload(fr.data, f.name || '', (e2, payload) => {
            if (e2) { wx.hideLoading(); return wx.showToast({ title: e2, icon: 'none' }) }
            this.req({
              url: API_BASE + '/import-xlsx', method: 'POST', data: Object.assign({ type: 'bank', preview: true }, payload),
              success: (res) => {
                wx.hideLoading()
                const d = res.data || {}
                if (!d.ok) return wx.showToast({ title: d.error || '没认出来', icon: 'none' })
                wx.showModal({
                  title: '认出 ' + d.count + ' 笔流水',
                  content: (d.layout_text || '') + '\n' + d.text + '\n\n先导进来，再一笔笔认领成账。',
                  confirmText: '导入',
                  success: (m) => {
                    if (!m.confirm) return
                    wx.showLoading({ title: '导入中…' })
                    this.req({
                      url: API_BASE + '/import-xlsx', method: 'POST', data: Object.assign({ type: 'bank' }, payload),
                      success: (r2) => {
                        wx.hideLoading()
                        const d2 = r2.data || {}
                        if (!d2.ok) return wx.showToast({ title: d2.error || '导入失败', icon: 'none' })
                        this.setData({ bank_layout: d2.layout_text || '', bank_skip: d2.skipped || 0 })
                        this.loadBankFlows()
                        wx.showToast({ title: '导入 ' + d2.imported + ' 笔', icon: 'success' })
                      },
                      fail: () => wx.hideLoading()
                    })
                  }
                })
              },
              fail: () => wx.hideLoading()
            })
            })
          },
          fail: () => { wx.hideLoading(); wx.showToast({ title: '读不了这个文件', icon: 'none' }) }
        })
      }
    })
  },
  autoMatchBank() {
    wx.showLoading({ title: '正在对…' })
    this.req({
      url: API_BASE + '/bank-auto-match', method: 'POST', data: {},
      success: (res) => {
        wx.hideLoading()
        const d = res.data || {}
        if (!d.ok) return wx.showToast({ title: d.error || '没算出来', icon: 'none' })
        this.setData({ ba: d })
        if (!d.rows.length) wx.showToast({ title: d.text, icon: 'none' })
      },
      fail: () => wx.hideLoading()
    })
  },
  closeBankAuto() { this.setData({ ba: null }) },
  applyBankAuto() {
    const ba = this.data.ba
    if (!ba || !ba.high) return
    wx.showModal({
      title: '自动认领 ' + ba.high + ' 笔',
      content: '按「金额正好等于还欠的 + 摘要里有单位名」自动认领，认完会生成收款/付款流水。认错了可以在单据明细里删掉那笔流水。',
      confirmText: '认领',
      success: (m) => {
        if (!m.confirm) return
        wx.showLoading({ title: '认领中…' })
        this.req({
          url: API_BASE + '/bank-auto-match', method: 'POST', data: { apply: true },
          success: (res) => {
            wx.hideLoading()
            const d = res.data || {}
            if (d.ok) {
              wx.showToast({ title: '认领了 ' + (d.applied || 0) + ' 笔', icon: 'success' })
              this.loadBankFlows(); this.refresh(); this.loadAr(); this.loadAp()
            } else wx.showToast({ title: d.error || '失败', icon: 'none' })
          },
          fail: () => wx.hideLoading()
        })
      }
    })
  },
  confirmBankAuto(e) {
    const i = e.currentTarget.dataset.i
    const row = (this.data.ba.rows || [])[i]
    if (!row || !row.target) return
    this._doBankMatch(row.id, row.target.kind, row.target.id, i)
  },
  pickBankAlt(e) {
    const { i, a } = e.currentTarget.dataset
    const row = (this.data.ba.rows || [])[i]
    const alt = row && (row.alts || [])[a]
    if (!alt) return
    this._doBankMatch(row.id, alt.kind, alt.id, i)
  },
  _doBankMatch(flowId, kind, targetId, idx) {
    this.req({
      url: API_BASE + '/bank-flows/' + flowId + '/match', method: 'POST', data: { target_type: kind, target_id: targetId },
      success: (res) => {
        const d = res.data || {}
        if (d.ok) {
          const ba = this.data.ba
          if (ba && ba.rows && ba.rows[idx]) { ba.rows[idx].done = true; this.setData({ ba }) }
          this.loadBankFlows(); this.refresh(); this.loadAr(); this.loadAp()
          wx.showToast({ title: kind === 'order' ? '已抵应收' : '已抵应付', icon: 'success' })
        } else wx.showToast({ title: d.error || '认领失败', icon: 'none' })
      }
    })
  },
  delBankFlow(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除这条银行流水', content: '只是从「待匹配」里去掉，不会动已经记好的账。确定删吗？',
      success: (r) => { if (r.confirm) this.req({ url: API_BASE + '/bank-flows/' + id, method: 'DELETE', success: () => this.loadBankFlows() }) }
    })
  },
  matchBankOrder(e) {
    const id = e.currentTarget.dataset.id
    const list = (this._arAll || []).filter((o) => Number(o.price) - Number(o.paid) > 0)
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
    const list = (this._apAll || []).filter((p) => Number(p.amount) - Number(p.paid) > 0)
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
        const amount = Number(String(v).replace(/[^\d.]/g, '')) || unpaid
        if (!(amount > 0)) return wx.showToast({ title: '金额不对', icon: 'none' })
        // 不填金额就是整笔作废，这一步一定要再问一次，不然一点就把整笔单抹掉了
        const full = amount >= unpaid - 0.005
        wx.showModal({
          title: '核销 ¥' + Math.round(amount * 100) / 100,
          content: full ? `整笔 ${unpaid} 元都核销掉，这张单就结清了（核销不算收到钱，不进现金流）。` : `只核销 ${amount} 元，还剩 ${Math.round((unpaid - amount) * 100) / 100} 元。`,
          editable: true, placeholderText: '原因（可不填，如：对方扣款/尾差/坏账）',
          confirmText: '确定核销',
          success: (r2) => {
            if (!r2.confirm) return
            const reason = String(r2.content || '').trim() || '联系不上客户/要不回来了'
            this.req({
              url: API_BASE + '/orders/' + id + '/writeoff', method: 'POST',
              data: { amount: amount, reason: reason },
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
        const amount = Number(String(v).replace(/[^\d.]/g, '')) || unpaid
        if (!(amount > 0)) return wx.showToast({ title: '金额不对', icon: 'none' })
        const full = amount >= unpaid - 0.005
        wx.showModal({
          title: '核销 ¥' + Math.round(amount * 100) / 100,
          content: full ? `整笔 ${unpaid} 元都核销掉，这笔应付就不用再付了（核销不算付过钱）。` : `只核销 ${amount} 元，还剩 ${Math.round((unpaid - amount) * 100) / 100} 元。`,
          editable: true, placeholderText: '原因（可不填，如：对方免了/尾差）',
          confirmText: '确定核销',
          success: (r2) => {
            if (!r2.confirm) return
            const reason = String(r2.content || '').trim() || '供应商免了/不用付了'
            this.req({
              url: API_BASE + '/payables/' + id + '/writeoff', method: 'POST',
              data: { amount: amount, reason: reason },
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
    const ds = Object.assign({}, e.currentTarget.dataset, { all: 1 })
    this.openPay({ currentTarget: { dataset: ds } }, 'ar')
  },
  payAll(e) {
    const ds = Object.assign({}, e.currentTarget.dataset, { all: 1 })
    this.openPay({ currentTarget: { dataset: ds } }, 'ap')
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
    const save = (val) => {
      const url = API_BASE + (type === 'ar' ? '/orders/' : '/payables/') + id
      this.req({ url, method: 'PATCH', data: { due_date: val },
        success: (res) => {
          if (res.data && res.data.ok) {
            this.refresh()
            wx.showToast({ title: val ? '已更新' : '已经清掉了', icon: 'none' })
          } else wx.showToast({ title: (res.data && res.data.error) || '失败', icon: 'none' })
        } })
    }
    wx.showModal({
      title: type === 'ar' ? '约定收款日' : '约定付款日',
      editable: true,
      // 有的机型 editable 不回填 content，所以把当前值写进提示里，让人知道现在是什么
      placeholderText: due ? '现在是 ' + due + '，如 11-20 或 2026-11-20' : '如 11-20 或 2026-11-20',
      content: due || '',
      success: (r) => {
        if (!r.confirm) return
        const raw = (r.content || '').trim()
        // 留空原来是直接 PATCH 空串 + 提示「已更新」：到期日被悄悄清掉，
        // 这张单从此不进「快到期/逾期」提醒，也没人知道是自己按了什么。
        if (!raw) {
          if (!due) return wx.showToast({ title: '本来就没填日期', icon: 'none' })
          return wx.showModal({
            title: '清掉日期？',
            content: '清掉以后这张单不会再进「快到期」「逾期」提醒，也看不出该哪天收钱。',
            confirmText: '清掉', cancelText: '算了',
            success: (r2) => { if (r2.confirm) save('') }
          })
        }
        // 本地先粗校一遍，别把「下周三」这种话发到后端再报错
        const ok = /^(\d{4}-)?\d{1,2}[-/月]\d{1,2}日?$/.test(raw)
        if (!ok) return wx.showToast({ title: '日期写成 11-20 或 2026-11-20', icon: 'none' })
        save(raw)
      }
    })
  },
  // 一行只留「收款 / 收清 / 更多」，其余动作都在这里选。
  // 微信的 showActionSheet 最多 6 项，所以按「先常用、再管理」分成两组，选完第一组里没有的再问第二组。
  moreOrder(e) {
    const d = e.currentTarget.dataset
    const type = d.type === 'ap' ? 'ap' : 'ar'
    const id = d.id
    const name = d.name || ''
    const isOwner = this.data.role === 'owner'
    const base = type === 'ar' ? [
      { t: '明细（这一单都发生了什么）', fn: 'showDetail' },
      { t: '收据', fn: 'openReceipt' },
      { t: '改约定收款日', fn: 'editDue' },
      { t: '标记已交付', fn: 'finishOrder' },
      { t: '改工序进度', fn: 'editProgress' },
      { t: '用预收抵扣', fn: 'applyAdvanceOrder' }
    ] : [
      { t: '明细（这一笔都发生了什么）', fn: 'showDetail' },
      { t: '收据', fn: 'openReceipt' },
      { t: '改约定付款日', fn: 'editDue' },
      { t: '用预付抵扣', fn: 'applyAdvancePayable' },
      { t: '对账单（这一家）', fn: 'statement' },
      { t: '月度对账单', fn: 'monthStatement' }
    ]
    const more = type === 'ar' ? [
      { t: '对账单（这一家）', fn: 'statement' },
      { t: '月度对账单', fn: 'monthStatement' },
      { t: '核销抹账（不动的钱）', fn: 'writeoffOrder' },
      { t: '再来一单', fn: 'againOrder' },
      isOwner ? { t: '改金额/客户/产品', fn: 'editOrder' } : { t: '申请修改（老板批）', fn: 'openEditReq' },
      isOwner ? { t: '删掉这张单', fn: 'delOrder' } : null
    ] : [
      { t: '核销抹账（不动的钱）', fn: 'writeoffPayable' },
      { t: '再来一笔', fn: 'againPayable' },
      isOwner ? { t: '改金额/供应商/备注', fn: 'editPayable' } : { t: '申请修改（老板批）', fn: 'openEditReq' },
      isOwner ? { t: '删掉这笔', fn: 'delPayable' } : null
    ]
    const run = (fn) => {
      const payload = { id, type, name, kind: type, who: name, unpaid: d.unpaid, due: d.due, settled: d.settled }
      if (typeof this[fn] === 'function') this[fn]({ currentTarget: { dataset: payload } })
    }
    wx.showActionSheet({
      itemList: base.map((x) => x.t).concat(['更多（核销 / 再来 / 改 / 删）']),
      success: (r) => {
        if (r.tapIndex < base.length) return run(base[r.tapIndex].fn)
        const l2 = more.filter(Boolean)
        wx.showActionSheet({ itemList: l2.map((x) => x.t), success: (r2) => { if (l2[r2.tapIndex]) run(l2[r2.tapIndex].fn) } })
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
      const eds = (d.edits || []).map((x) => ({ k: '✎ ' + x.date, v: x.action + '：' + (x.detail || '') }))
      const head = type === 'ar'
        ? d.customer + ' · ' + d.item_name + ' · 总 ' + d.price + ' · 已收 ' + d.paid + (d.written_off > 0 ? ' · 已核销 ' + d.written_off : '') + ' · 还欠 ' + d.unpaid
        : d.supplier + ' · 总 ' + d.amount + ' · 已付 ' + d.paid + (d.written_off > 0 ? ' · 已核销 ' + d.written_off : '') + ' · 还欠 ' + d.unpaid
      // 这张单的成本构成：材料（单子上填的）+ 已记计件工钱，合起来才是真实成本
      const wg = d.wage_rows
      if (wg && (wg.amount > 0 || (wg.rows || []).length)) {
        const detail = (wg.rows || []).map((x) => `${x.worker}${x.process ? '·' + x.process : ''} ${x.qty}×${x.rate}=${x.amount}`).join('；')
        rows.push({ k: '成本', v: `材料 ${d.cost || 0} ＋ 工钱 ${wg.amount}（${wg.qty} 件）＝ ${(Number(d.cost || 0) + Number(wg.amount)).toFixed(2)}；毛利 ${(Number(d.price || d.amount || 0) - Number(d.cost || 0) - Number(wg.amount)).toFixed(2)}` })
        if (detail) rows.push({ k: '记工', v: detail })
      }
      const oi = d.import_origin
      let oline = ''
      if (oi) {
        if (oi.missing) oline = '导入来源：这条导入记录已删（批次 ' + oi.batch + '）'
        else oline = '导入来源：' + oi.at + ' · ' + (oi.src === 'excel' ? 'Excel 文件' : oi.src === 'preview' ? '粘贴预览后入账' : '粘贴导入') + ' · 这批共 ' + oi.cnt + ' 笔 ' + oi.total + ' 元' + (oi.undone ? '（已撤回）' : '')
        rows.push({ k: '来源', v: oline })
      }
      const all = rows.concat(wos).concat(eds)
      this.setData({ detail_show: true, detail_title: type === 'ar' ? '应收明细' : '应付明细', detail_head: head, detail_rows: all, detail_id: id, detail_type: type === 'ar' ? 'order' : 'payable', detail_att: [] })
      this.loadAttach(type === 'ar' ? 'order' : 'payable', id)
    } })
  },
  // 单据照片：拍一张存着，随时能翻出来给人看
  loadAttach(refType, refId) {
    this.req({ url: API_BASE + '/attachments?ref_type=' + refType + '&ref_id=' + refId, silent: true, success: (r) => {
      const d = r.data || {}
      if (d.ok) this.setData({ detail_att: d.rows || [] })
    } })
  },
  addAttach() {
    const { detail_id, detail_type } = this.data
    if (!detail_id) return
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['camera', 'album'],
      success: (res) => {
        const p = res.tempFilePaths[0]
        const go = (path) => {
          wx.getFileSystemManager().readFile({ filePath: path, encoding: 'base64', success: (f) => {
            const b64 = String(f.data || '')
            if (b64.length > 880000) { wx.showToast({ title: '这张太大，换张小的', icon: 'none' }); return }
            wx.showLoading({ title: '存…' })
            this.req({
              url: API_BASE + '/attachments', method: 'POST',
              data: { ref_type: detail_type, ref_id: detail_id, name: '单据照片', mime: 'image/jpeg', b64 },
              success: (r) => {
                wx.hideLoading()
                const d = r.data || {}
                if (!d.ok) return wx.showToast({ title: d.error || '没存上', icon: 'none' })
                wx.showToast({ title: '存好了' })
                this.loadAttach(detail_type, detail_id)
              },
              fail: () => { wx.hideLoading(); wx.showToast({ title: '没存上', icon: 'none' }) }
            })
          }, fail: () => wx.showToast({ title: '读不到这张图', icon: 'none' }) })
        }
        wx.compressImage({ src: p, quality: 60, success: (c) => go(c.tempFilePath), fail: () => go(p) })
      },
      fail: (err) => {
        // 以前没有 fail：用户第一次点了「不允许」之后，再点加照片一点反应都没有，以为坏了。
        const msg = String((err && (err.errMsg || err.errmsg)) || '')
        if (/auth|deny|permission|authorize/i.test(msg)) {
          wx.showModal({
            title: '要用相机/相册',
            content: '刚才没给权限。点「去设置」把「相机」和「相册」打开，回来再点一次加照片就行。',
            confirmText: '去设置',
            success: (r) => { if (r.confirm && wx.openSetting) wx.openSetting({}) }
          })
        } else if (!/cancel/i.test(msg)) {
          wx.showToast({ title: '没选到照片：' + (msg.slice(0, 40) || '再试一次'), icon: 'none' })
        }
      }
    })
  },
  viewAttach(e) {
    const id = Number(e.currentTarget.dataset.id)
    if (!id) return
    this.req({ url: API_BASE + '/attachment/' + id, success: (r) => {
      const d = r.data || {}
      if (!d.b64) return wx.showToast({ title: '照片不在了', icon: 'none' })
      wx.previewImage({ urls: ['data:' + (d.mime || 'image/jpeg') + ';base64,' + d.b64] })
    } })
  },
  delAttach(e) {
    const id = Number(e.currentTarget.dataset.id)
    const { detail_id, detail_type } = this.data
    wx.showModal({ title: '删掉这张照片？', content: '删了找不回来，要留证据就别删。', success: (r) => {
      if (!r.confirm) return
      this.req({ url: API_BASE + '/attachment/' + id, method: 'DELETE', success: () => { this.loadAttach(detail_type, detail_id); wx.showToast({ title: '删了' }) } })
    } })
  },
  // 账户平时有没有票（工行对公一般有票、农行个人一般没票）：设一次，以后收付款自动带出来
  pickAccInv(e) {
    const id = Number(e.currentTarget.dataset.id)
    const cur = String(e.currentTarget.dataset.v || '')
    const opts = [
      { k: 'yes', n: '有票（对公户，开票走这里）' },
      { k: 'no', n: '没票（个人户，收付一般没票）' },
      { k: 'part', n: '部分开票' },
      { k: '', n: '不设（每次收付时再问）' }
    ]
    wx.showActionSheet({
      itemList: opts.map((x) => x.n + (x.k === cur ? ' ✓' : '')),
      success: (r) => {
        const k = (opts[r.tapIndex] || {}).k
        if (k === undefined) return
        this.req({
          url: API_BASE + '/accounts/' + id, method: 'PATCH', data: { inv_default: k },
          success: () => {
            wx.showToast({ title: '记下了', icon: 'success' })
            this.loadAccounts()
          }
        })
      }
    })
  },
  // 本月税金：销项 / 进项 / 差 / 没票的支出
  loadTaxSummary() {
    const m = (this.data.rv_month || '').trim()
    this.req({
      url: API_BASE + '/tax-summary' + (m ? '?month=' + encodeURIComponent(m) : ''),
      batch: false, silent: true,
      success: (res) => {
        const d = res.data || {}
        if (!d.ok) return
        this.setData({ tax: d })
      },
      fail: () => {}
    })
  },
  noop() {},
  closeDetail() { this.setData({ detail_show: false }) },
  copyDetail() {
    // 明细行数多时，text 字符串和 rows 是同一份内容的两份拷贝；用 rows 现拼，
    // 省掉每次点开明细都往 setData 里塞一份几百行的长文本（setData 是跨线程拷贝）。
    const d = this.data
    const text = [d.detail_head, ...((d.detail_rows || []).map((x) => x.k + '  ' + x.v))].filter(Boolean).join('\n')
    wx.setClipboardData({ data: text, success: () => wx.showToast({ title: '已复制', icon: 'success' }) })
  },
})
