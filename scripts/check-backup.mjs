#!/usr/bin/env node
// 备份里绝不能出现口令类的东西：node scripts/check-backup.mjs
//
// 为什么要有它：备份文件是要往外发的（转发到微信、存网盘、交给会计）。
// 一旦 access_key / staff_key / sign_secret 这类键混进备份包，
// 拿到包的人就能直接进这套账 —— 比「数据泄露」严重得多。
//
// 判定方式（不写死名单）：
//   · 从 backend/index.js 里读出 BACKUP_SKIP、BACKUP_SETTINGS_SKIP、RESTORE_SETTINGS_SKIP
//     三份**真实**名单（名字以源码为准）；
//   · 再用「语义规则」挑出所有凭据语义的键（key/secret/salt/code/password/token/pin/hash 等）
//     和表（staff_users/auth_* 等）；
//   · 只要这些键/表没有出现在「跳过名单」里，就是漏了 → 红。
//
// 只用 Node 内置模块（CI 的 check job 里没装依赖，装了也白装）。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const BE = path.join(ROOT, 'backend/index.js')

function fail(msg) { console.log(`  ❌ ${msg}`); process.exitCode = 1 }
function ok(msg) { console.log(`  ✅ ${msg}`) }

// 从源码里抠出一份数组字面量（支持跨行、只取第一层 [])
function readArray(src, name) {
  const i = src.indexOf('const ' + name + ' = [')
  if (i < 0) return null
  const start = src.indexOf('[', i)
  let depth = 0, end = -1, quote = null
  for (let k = start; k < src.length; k++) {
    const c = src[k]
    if (quote) { if (c === '\\') k++; else if (c === quote) quote = null; continue }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '[') depth++
    else if (c === ']') { depth--; if (depth === 0) { end = k; break } }
  }
  if (end < 0) return null
  const body = src.slice(start + 1, end)
  const out = []
  for (const m of body.matchAll(/'([^']*)'/g)) out.push(m[1])
  return out
}

const src = fs.readFileSync(BE, 'utf8')
// BACKUP_SKIP 是 [['表名','原因'], ...] —— 名字和原因要成对读出来
const skipTables = []
{
  const i = src.indexOf('const BACKUP_SKIP = [')
  const start = src.indexOf('[', i)
  let depth = 0, end = -1, quote = null
  for (let k = start; k < src.length; k++) {
    const c = src[k]
    if (quote) { if (c === '\\') k++; else if (c === quote) quote = null; continue }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '[') depth++
    else if (c === ']') { depth--; if (depth === 0) { end = k; break } }
  }
  const body = src.slice(start + 1, end)
  for (const m of body.matchAll(/\[\s*'([^']*)'\s*,\s*'([^']*)'\s*\]/g)) skipTables.push([m[1], m[2]])
}
const skipSettings = readArray(src, 'BACKUP_SETTINGS_SKIP') || []
// RESTORE_SETTINGS_SKIP 写成 BACKUP_SETTINGS_SKIP.concat([...]) —— 两边都要算上
const restoreSkip = (() => {
  const extra = readArray(src, 'RESTORE_SETTINGS_SKIP') || []
  if (/RESTORE_SETTINGS_SKIP\s*=\s*BACKUP_SETTINGS_SKIP\.concat/.test(src)) return [...skipSettings, ...extra]
  return extra
})()

if (!skipTables.length || !skipSettings.length) {
  fail('backend/index.js 里读不到 BACKUP_SKIP / BACKUP_SETTINGS_SKIP（名单改名了？这里要跟着改）')
  process.exit(1)
}

console.log('ℹ️ 后端真实名单：BACKUP_SKIP ' + skipTables.length + ' 项、BACKUP_SETTINGS_SKIP ' + skipSettings.length + ' 项')

// ── 1. 凭据语义的 settings 键，必须都在跳过名单里 ──
const CRED_KEY = /(key|secret|salt|pass|pwd|token|pin|hash|code|credential|auth|sign)/i
// 这些键是「业务数据」不是口令，不该按语义判死
const CRED_KEY_ALLOW = ['invoice_no', 'inv_no', 'tax_no', 'code_prefix', 'postal_code', 'barcode', 'qrcode']

const credKeys = skipSettings.filter((k) => CRED_KEY.test(k) && !CRED_KEY_ALLOW.includes(k))
const skippedSet = new Set([...skipSettings, ...restoreSkip])

// 源码里出现过的 settings 键（写入 settings 表的地方）
const usedKeys = new Set()
for (const m of src.matchAll(/settings[\s\S]{0,80}?(?:key\s*[:,]\s*|INSERT INTO settings[^\n]*VALUES\s*\(\s*)'([a-z0-9_]+)'/gi)) usedKeys.add(m[1])
for (const m of src.matchAll(/setSetting\(\s*'([a-z0-9_]+)'/gi)) usedKeys.add(m[1])
for (const m of src.matchAll(/kv\(\s*'([a-z0-9_]+)'/gi)) usedKeys.add(m[1])

const leakKeys = [...usedKeys].filter((k) => CRED_KEY.test(k) && !CRED_KEY_ALLOW.includes(k) && !skippedSet.has(k))
if (leakKeys.length) {
  for (const k of leakKeys) fail(`settings 里的凭据键「${k}」没进 BACKUP_SETTINGS_SKIP —— 备份发出去就等于把口令发出去`)
} else {
  ok(`${credKeys.length} 个凭据语义的 settings 键（access_key/staff_key/sign_secret/recover_*/staff_salt…）都不进备份`)
}

// ── 2. 凭据语义的表，必须在 BACKUP_SKIP 里 ──
const CRED_TABLE = /(staff_users|auth_|sessions?|tokens?|wx_users)/
const credTables = skipTables.filter((t) => CRED_TABLE.test(t))
const covered = new Set(skipTables.map((t) => (Array.isArray(t) ? t[0] : t)))
const allTables = new Set([...src.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)].map((m) => m[1]))
const leakTables = [...allTables].filter((t) => CRED_TABLE.test(t) && !covered.has(t))
if (leakTables.length) {
  for (const t of leakTables) fail(`表「${t}」看着是凭据表（存口令/会话），却没进 BACKUP_SKIP —— 它会被打进备份包`)
} else {
  ok(`${credTables.length} 个凭据语义的表都在 BACKUP_SKIP 里（不进备份）`)
}

// ── 3. 名单里每一项都要写清原因（BACKUP_SKIP 是 [名字, 原因] 成对的）──
const noReason = skipTables.filter((x) => !Array.isArray(x) || !x[1] || !String(x[1]).trim())
if (noReason.length) {
  for (const x of noReason) fail(`BACKUP_SKIP 里的「${x[0]}」没写为什么不备份 —— /backup-verify 要把原因显示给用户看`)
} else {
  ok('BACKUP_SKIP 每一项都写了原因（用户能在 /backup-verify 里看到为什么少这张表）')
}

// ── 4. 恢复时更严的名单也必须含全部凭据键 ──
const missRestore = credKeys.filter((k) => !restoreSkip.includes(k))
if (missRestore.length) {
  for (const k of missRestore) fail(`RESTORE_SETTINGS_SKIP 里少了「${k}」——恢复别人的备份时它会盖掉这台机器的口令`)
} else {
  ok('RESTORE_SETTINGS_SKIP 覆盖了全部凭据键（恢复不会盖掉本机的口令）')
}

if (!process.exitCode) console.log('\n✅ 备份里没有凭据类的东西\n')
else console.log('\n❌ 备份口径有漏洞，别把备份发出去\n')
