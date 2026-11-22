// 员工口令可写的接口白名单 —— 单一事实源。
// backend/index.js 的权限中间件和 scripts/test-perm.mjs 的黑盒回归都 import 这份，
// 免得「改了线上白名单忘了改测试」导致测试全绿但权限已经错了。
// 原则：默认关，只放行记账这件事本身需要的动作；开错就是越权，关错顶多不方便。
export const STAFF_WRITE_OK = [
  /^\/orders$/, /^\/orders\/\d+\/receive$/, /^\/orders\/\d+\/status$/,
  /^\/receive-batch$/, /^\/pay-batch$/, /^\/quick$/,
  /^\/payables$/, /^\/payables\/\d+\/pay$/,
  /^\/expenses$/, /^\/advances$/, /^\/loans$/, /^\/loans\/\d+\/(return|reimburse)$/,
  /^\/attachments?$/, /^\/batch$/,
  // 员工提「改单申请」、撤自己的申请 —— 这是员工本来就该有的路（改单要老板批）
  /^\/edit-request$/, /^\/edit-requests\/\d+\/cancel$/,
  // 导入（模块开关另外管一层）
  /^\/(import|import-rows|import-xlsx|import-pack|parse-import|detect-import)$/,
  // 对账与催款：员工对账、登记发出对账单、记催款，这些是日常活
  /^\/upload-(start|part|finish)$/,
  /^\/(reconcile|recon-confirm|pipeline-summary)$/,
  /^\/statement-log$/, /^\/statement-log\/\d+\/(ack|resolve)$/,
  /^\/party-terms$/, /^\/party-terms\/apply$/, /^\/dunning-log$/,
  // 车间/家底类日常登记
  /^\/(materials|material-moves|frame-prices|outsource|rework|invoices)$/, /^\/outsource\/\d+\/back$/
]
