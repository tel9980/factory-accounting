// 本机版入口：用 Node 起一个 HTTP 服务，把 Cloudflare Workers 那份 backend/index.js
// 原样挂上去。用途有两个：
//   1) 打成一个免安装 exe，厂长自己电脑上双击就能用（数据是本地 SQLite 文件）；
//   2) 打进 Docker 镜像，扔到任意一台机器/群晖上跑。
//
// 微信小程序那边不用改代码，只把 index.js 顶部的 API_BASE 指到本机地址即可
// （同一个局域网：http://<这台电脑的IP>:8787）。
//
// 不加任何业务逻辑，只干四件事：
//   ① 把 HTTP 请求转成 Web Request 交给 worker；
//   ② 给 worker 准备 env（三个本地库 + 版本号 + 可选 R2/笔记绑定）；
//   ③ 首次启动建库（跑 backend/schema.sql）；
//   ④ 提供一个落地页：看状态、首次设口令、下载完整备份。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { LocalD1, ensureSchema } from './d1.mjs'
import { BOOKS, bookBindingOf, bookFileOf } from './books.mjs'
import worker from '../backend/index.js'

// 版本号：打 exe / 镜像时由构建脚本用 esbuild --define 写死（__FA_VERSION__），
// 直跑或容器里也可以用环境变量覆盖。
const APP_VERSION = process.env.FACTORY_VERSION || (typeof __FA_VERSION__ !== 'undefined' ? __FA_VERSION__ : 'local')
const APP_BUILT = process.env.FACTORY_BUILT || (typeof __FA_BUILT__ !== 'undefined' ? __FA_BUILT__ : '')

const HERE = (() => { try { return typeof __dirname === 'string' ? __dirname : process.cwd() } catch (e) { return process.cwd() } })()

// ── 命令行参数 ──
function parseArgs(argv) {
  const out = { port: Number(process.env.PORT || 8787), host: process.env.HOST || '0.0.0.0', data: process.env.FACTORY_DATA || '', open: true, cron: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const eq = a.indexOf('=')
    const k = eq > 0 ? a.slice(0, eq) : a
    const v = eq > 0 ? a.slice(eq + 1) : argv[i + 1]
    const take = () => { if (eq > 0) return v; i++; return v }
    if (k === '--port' || k === '-p') out.port = Number(take()) || 8787
    else if (k === '--host') out.host = take() || '0.0.0.0'
    else if (k === '--data' || k === '-d') out.data = take() || ''
    else if (k === '--no-open') out.open = false
    else if (k === '--no-cron') out.cron = false
    else if (k === '--help' || k === '-h') out.help = true
  }
  return out
}

function isSea() {
  try { return !!(require0('node:sea') && require0('node:sea').isSea && require0('node:sea').isSea()) } catch (e) { return false }
}

// 能同步 require 内置模块的小工具（CJS 打包后直接用 require；ESM 直跑时退回 process.binding 不可行，
// 所以这里只用来问 SEA，取不到就当作不是 SEA）
function require0(name) {
  try { return typeof require === 'function' ? require(name) : null } catch (e) { return null }
}

function readSchema() {
  // 打成 exe 时 schema.sql 作为 SEA 资源塞进二进制里；直跑/Docker 时从文件读。
  try {
    const sea = require0('node:sea')
    if (sea && sea.isSea && sea.isSea() && sea.getAsset) {
      const buf = sea.getAsset('schema.sql')
      if (buf && buf.length) return Buffer.from(buf).toString('utf8')
    }
  } catch (e) { /* 没打包资源就往下找文件 */ }
  const cands = [
    path.join(HERE, 'schema.sql'),
    path.join(HERE, '../backend/schema.sql'),
    path.join(process.cwd(), 'backend/schema.sql'),
    path.join(process.cwd(), 'schema.sql'),
  ]
  for (const f of cands) {
    try { if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8') } catch (e) { /* 下一个 */ }
  }
  throw new Error('找不到 backend/schema.sql（建库要用）。请把 schema.sql 放在程序旁边的 backend/ 目录里。')
}

function lanIps() {
  const out = []
  const ifs = os.networkInterfaces()
  for (const k of Object.keys(ifs)) {
    for (const a of ifs[k] || []) {
      if (a.family === 'IPv4' && !a.internal && !String(a.address).startsWith('169.254.')) out.push(a.address)
    }
  }
  return out
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'])
const HOP_RES = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length'])

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => { chunks.push(c); if (chunks.length > 4000) { /* 9MB 备份也够 */ } })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function isPrivateAddr(addr) {
  const a = String(addr || '')
  if (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1') return true
  if (/^10\./.test(a)) return true
  if (/^192\.168\./.test(a)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true
  if (/^::ffff:(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(a)) return true
  return false
}

function fmtSize(n) {
  const b = Number(n) || 0
  if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB'
  if (b > 1024) return (b / 1024).toFixed(0) + ' KB'
  return b + ' B'
}

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>本地记账服务</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f4f6f8;color:#222;font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:24px 16px 60px}
h1{font-size:22px;margin:0 0 4px}
.sub{color:#777;font-size:13px;margin-bottom:18px}
.card{background:#fff;border-radius:14px;padding:16px 18px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.card h2{font-size:15px;margin:0 0 10px;color:#333}
.kv{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px dashed #eef0f2;font-size:14px}
.kv:last-child{border:0}
.kv span:first-child{color:#777}
.kv span:last-child{font-variant-numeric:tabular-nums}
input{width:100%;padding:10px 12px;border:1px solid #d7dbe0;border-radius:10px;font-size:15px;margin:8px 0}
button{background:#1a73e8;color:#fff;border:0;border-radius:10px;padding:10px 16px;font-size:15px;cursor:pointer}
button.ghost{background:#eef2f7;color:#1a73e8}
button:disabled{opacity:.5;cursor:default}
.tip{font-size:13px;color:#777;margin-top:8px}
.ok{color:#0a7d33}.bad{color:#c0261a}
code{background:#f2f4f6;padding:1px 6px;border-radius:6px;font-size:13px}
.mono{font-family:ui-monospace,Consolas,monospace}
#rc{background:#e7f6ec;border:1px solid #bfe3cc;border-radius:10px;padding:10px 12px;margin-top:10px;font-family:ui-monospace,monospace;letter-spacing:1px}
</style></head><body><div class="wrap">
<h1>本地记账服务</h1><div class="sub" id="ver">正在连接…</div>

<div class="card"><h2>服务状态</h2><div id="status"><div class="kv"><span>读取中…</span><span></span></div></div></div>

<div class="card" id="authCard"><h2 id="authTitle">连接这台电脑</h2>
<div id="authBody"><div class="tip">读取中…</div></div></div>

<div class="card"><h2>手机小程序怎么连</h2>
<div class="tip">把 <code>frontend/pages/index/index.js</code> 顶部的 <code>API_BASE</code> 改成下面这个地址（手机和这台电脑要在同一个 Wi-Fi 下），
微信开发者工具里勾上「不校验合法域名」后重新编译。正式发布时把该域名配进小程序后台的 request 合法域名。</div>
<div class="kv" style="margin-top:8px"><span>本机地址</span><span class="mono" id="localUrl">-</span></div>
<div id="lanList"></div>
</div>

<div class="card"><h2>完整备份</h2>
<div class="tip">把整本账导成一个 JSON 文件存到别处（U 盘/网盘）。恢复时在程序里用 <code>POST /backup-restore</code>，或把文件放回来找技术支持。</div>
<button id="bkBtn" style="margin-top:10px" disabled>下载完整备份</button>
<div class="tip" id="bkTip"></div>
</div>

<div class="tip" style="text-align:center;margin-top:18px">数据都在本机 <code id="dataDir">-</code>，不上传任何地方。</div>
</div>
<script>
var KEY = localStorage.getItem('fa_key') || '';
function el(id){return document.getElementById(id)}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function kv(k,v){return '<div class="kv"><span>'+k+'</span><span>'+esc(v)+'</span></div>'}
function api(p,opt){
  opt = opt || {};
  var h = Object.assign({'Content-Type':'application/json'}, opt.headers||{});
  if (KEY) h['X-Access-Key'] = KEY;
  return fetch(p, {method:opt.method||'GET', headers:h, body:opt.body}).then(function(r){
    return r.text().then(function(t){ var d; try{d=JSON.parse(t)}catch(e){d={raw:t}} ; d.__status=r.status; return d })
  })
}
function showStatus(s){
  el('ver').textContent = '版本 ' + (s.version||'dev') + (s.built ? ' · 构建于 ' + s.built : '');
  el('dataDir').textContent = s.dataDir;
  el('status').innerHTML =
    kv('数据文件', s.dbFile) + kv('文件大小', s.dbSizeText) +
    kv('应收单', s.orders + ' 张') + kv('客户', s.customers + ' 家') +
    kv('流水', s.ledger + ' 条') + kv('应付单', s.payables + ' 张') +
    kv('账号', s.staff ? (s.staff + ' 个员工') : '只有老板');
  el('localUrl').textContent = 'http://' + (s.localIp||'127.0.0.1') + ':' + s.port;
  var html = '';
  (s.lan||[]).forEach(function(ip){ html += kv('局域网', 'http://' + ip + ':' + s.port) });
  el('lanList').innerHTML = html || '<div class="tip">没检测到局域网地址（只在本机用就没问题）。</div>';
}
function boot(){
  fetch('/__local/status').then(function(r){return r.json()}).then(showStatus).catch(function(e){
    el('status').innerHTML = '<div class="bad">连不上本地服务：' + esc(e.message) + '</div>'
  });
  api('/me').then(function(d){
    if (d.__status === 200) {
      el('authTitle').textContent = '已连接';
      el('authBody').innerHTML = '<div class="ok">这台电脑上的账已经能读了（' + esc(d.role === 'staff' ? '员工' : '老板') + '口径）。</div>' +
        '<div class="tip">换一个口令：<input id="chg" type="password" placeholder="新口令（至少 4 位）"><button class="ghost" id="chgBtn">改口令</button></div>';
      el('bkBtn').disabled = false;
      el('chgBtn').onclick = function(){
        var v = el('chg').value.trim(); if (v.length < 4) return alert('口令至少 4 位');
        api('/auth/change',{method:'POST',body:JSON.stringify({key:v})}).then(function(x){
          if (x.__status===200){ KEY=v; localStorage.setItem('fa_key',v); alert('改好了，记住新口令'); }
          else alert(x.error || '改口令失败');
        })
      };
      return;
    }
    if (d.code === 'no_key' || /设置了访问口令|首次使用/.test(String(d.error||''))) {
      el('authTitle').textContent = '第一次用：设个口令';
      el('authBody').innerHTML = '<div class="tip">这本账还没有口令（就是小程序里打开要输的那个）。设一个记牢，下面会给你一串恢复码。</div>' +
        '<input id="k1" type="password" placeholder="口令，至少 4 位"><input id="k2" type="password" placeholder="再输一遍">' +
        '<button id="setBtn">设好，开始记账</button><div id="rc" style="display:none"></div>';
      el('setBtn').onclick = function(){
        var a = el('k1').value.trim(), b = el('k2').value.trim();
        if (a.length < 4) return alert('口令至少 4 位');
        if (a !== b) return alert('两次输的不一样');
        el('setBtn').disabled = true;
        api('/auth/setup',{method:'POST',body:JSON.stringify({key:a})}).then(function(x){
          el('setBtn').disabled = false;
          if (x.__status!==200) return alert(x.error || '没设成功');
          KEY = a; localStorage.setItem('fa_key', a);
          el('rc').style.display = 'block';
          el('rc').textContent = '恢复码：' + (x.recover_code || '（没返回）') + '  ← 抄下来，忘了口令用它';
          setTimeout(boot, 1200);
        })
      };
      return;
    }
    el('authTitle').textContent = '连不上（' + (d.__status||'?') + '）';
    el('authBody').innerHTML = '<div class="bad">' + esc(d.error || '口令不对，或服务还没准备好') + '</div>' +
      '<input id="k0" type="password" placeholder="再输一次口令"><button id="tryBtn">重试</button>';
    el('tryBtn').onclick = function(){ KEY = el('k0').value.trim(); localStorage.setItem('fa_key', KEY); boot() };
  }).catch(function(e){
    el('authTitle').textContent = '读状态失败';
    el('authBody').innerHTML = '<div class="bad">' + esc(e.message) + '</div>';
  });
}
el('bkBtn').onclick = function(){
  el('bkBtn').disabled = true; el('bkTip').textContent = '正在打包整本账…';
  api('/backup').then(function(d){
    el('bkBtn').disabled = false;
    if (d.__status !== 200 || !d.text) { el('bkTip').innerHTML = '<span class="bad">备份没成功：' + esc(d.error || '未知原因') + '</span>'; return }
    var blob = new Blob([d.text], {type:'application/json'});
    var a = document.createElement('a');
    var t = new Date(Date.now() + 8*3600*1000).toISOString().slice(0,10);
    a.href = URL.createObjectURL(blob);
    a.download = 'factory-backup-' + t + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    el('bkTip').textContent = '已下载 ' + (d.text.length/1048576).toFixed(1) + ' MB，存到别的地方去。';
  }).catch(function(e){ el('bkBtn').disabled = false; el('bkTip').innerHTML = '<div class="bad">' + esc(e.message) + '</div>' })
};
boot();
</script></body></html>`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(`本地记账服务

  --port 8787        端口（默认 8787）
  --host 0.0.0.0     监听地址（只想本机用就写 127.0.0.1）
  --data <目录>      数据目录（默认程序旁边的 data/）
  --no-open          启动后不自动打开浏览器
  --no-cron          不自动跑每日结账任务（固定支出/摊销/预提/折旧）
`)
    return
  }

  // 数据目录：exe 双击时默认放在 exe 旁边的 data/，直跑时放在当前目录的 data/。
  const sea = isSea()
  const dataDir = args.data
    ? path.resolve(args.data)
    : path.resolve(process.env.FACTORY_DATA || path.join(sea ? path.dirname(process.execPath) : process.cwd(), 'data'))
  fs.mkdirSync(dataDir, { recursive: true })

  const schemaSql = readSchema()
  // 本机版和线上一样能开 9 本账（线上是 9 个 D1 绑定，本机是 9 个 .db 文件）。
  // 数字来自 server/books.mjs —— build-exe 的自测断言也从那里取，不会再对不上。
  const files = {}
  for (let i = 1; i <= BOOKS; i++) files[bookBindingOf(i)] = path.join(dataDir, bookFileOf(i))
  const dbs = {}
  // 第 11 轮 F9：DB / DB2 / DB3 … → 1 / 2 / 3
  const numOfBook = (k) => Number(String(k).replace(/\D/g, '')) || 1
  for (const k of Object.keys(files)) {
    dbs[k] = new LocalD1(files[k])
    const r = await ensureSchema(dbs[k], schemaSql)
    if (r.after !== r.before) console.log(`  ${k} 建好 ${r.after - r.before} 张表（共 ${r.after} 张）`)
    if (r.added && r.added.length) console.log(`  ${k} 老库补上 ${r.added.length} 个列：` + r.added.slice(0, 8).join('、') + (r.added.length > 8 ? ' …' : ''))
    for (const f of r.failed || []) {
      console.log(`  ⚠️ ${k} 有一个列没补上（不影响启动，但那一列的数据读不到）：` + f)
      // 第 11 轮 F9：以前只打在控制台里。本机版是双击 exe 跑的，
      // 窗口一关什么都看不到，界面上也没有「这台机器的库缺列」的地方。
      // 现在同时写一条 error_log，界面的「设置 → 数据体检 → 运行日志」能看到。
      try {
        dbs[k].prepare('INSERT INTO error_log (book,method,path,status,msg,ms,created_at) VALUES (?,?,?,?,?,?,?)')
          .bind(numOfBook(k), 'BOOT', 'schema', 0, ('老库补列失败：' + f).slice(0, 300), 0, new Date(Date.now() + 8 * 3600 * 1000).toISOString())
          .run()
      } catch (e) { /* 连 error_log 都写不进去就只留控制台 */ }
    }
  }

  const env = {
    BOOK: 1,
    APP_VERSION: APP_VERSION,
    APP_BUILT: APP_BUILT,
    NOTES_BASE: process.env.NOTES_BASE || '',
    NOTES_SLUG: process.env.NOTES_SLUG || '',
    NOTES_PASS: process.env.NOTES_PASS || '',
  }
  // 九本账的绑定：DB、DB2 … DB9（backend 按 bookDbs(env) 自己发现有几本）
  for (const k of Object.keys(files)) env[k] = dbs[k]
  env.ENV_ALL = env

  const ctx = { waitUntil(p) { try { Promise.resolve(p).catch(() => {}) } catch (e) {} }, passThroughOnException() {} }

  const server = http.createServer(async (req, res) => {
    const started = Date.now()
    try {
      const url = new URL(req.url || '/', 'http://' + (req.headers.host || '127.0.0.1'))
      const remote = req.socket && req.socket.remoteAddress

      if ((url.pathname === '/' || url.pathname === '/index.html') && req.method === 'GET') {
        res.statusCode = 200
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(PAGE)
        return
      }

      if (url.pathname === '/__local/status' && req.method === 'GET') {
        if (!isPrivateAddr(remote)) { res.statusCode = 403; res.end('{"error":"只允许本机/局域网访问"}'); return }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(await localStatus()))
        return
      }

      const method = String(req.method || 'GET').toUpperCase()
      const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req)
      const headers = new Headers()
      // 不能信客户端自己报的 IP：本机版没有 Cloudflare 挡在前面，
      // 谁都能塞一个 x-forwarded-for / cf-connecting-ip 把「试错锁定」绕过去（每换一个假 IP 又能试 10 次）。
      // 这里统一丢掉这两个头，改成用真实连接的地址。
      const SPOOF = new Set(['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip'])
      for (const k of Object.keys(req.headers)) {
        const lk = k.toLowerCase()
        if (HOP.has(lk) || SPOOF.has(lk)) continue
        const v = req.headers[k]
        if (Array.isArray(v)) v.forEach((x) => headers.append(k, x))
        else if (v != null) headers.set(k, v)
      }
      // 用真实连接地址覆盖：这样「试错锁定」是按真 IP 算的，伪造头绕不过去
      if (remote) headers.set('cf-connecting-ip', String(remote).replace(/^::ffff:/, ''))
      const request = new Request(url, { method, headers, body })
      const response = await worker.fetch(request, env, ctx)

      res.statusCode = response.status
      response.headers.forEach((v, k) => { if (!HOP_RES.has(k.toLowerCase())) res.setHeader(k, v) })
      if (method === 'HEAD' || !response.body) { res.end(); return }
      const buf = Buffer.from(await response.arrayBuffer())
      res.setHeader('content-length', String(buf.length))
      res.end(buf)

      if (process.env.FACTORY_LOG === '1') {
        console.log(`  ${method} ${url.pathname}${url.search} → ${response.status} (${Date.now() - started}ms)`)
      }
    } catch (e) {
      const msg = String((e && (e.stack || e.message)) || e)
      console.error(`  500 ${req.method} ${req.url}\n` + msg.split('\n').slice(0, 4).join('\n'))
      try {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, error: '本机服务出错了：' + String((e && e.message) || e) }))
      } catch (_) { /* 已经发过头了 */ }
    }
  })

  async function localStatus() {
    const one = async (sql) => {
      try { return (await env.DB.prepare(sql).first()) || {} } catch (e) { return {} }
    }
    const [o, c, l, p, s] = await Promise.all([
      one('SELECT COUNT(*) AS n FROM orders'),
      one('SELECT COUNT(DISTINCT customer) AS n FROM orders'),
      one('SELECT COUNT(*) AS n FROM ledger'),
      one('SELECT COUNT(*) AS n FROM payables'),
      one('SELECT COUNT(*) AS n FROM staff_users WHERE active=1'),
    ])
    let size = 0
    try { size = fs.statSync(files.DB).size } catch (e) { /* 还没有文件 */ }
    const lan = lanIps()
    return {
      version: env.APP_VERSION,
      built: env.APP_BUILT,
      port: args.port,
      host: args.host,
      localIp: lan[0] || '127.0.0.1',
      lan,
      dataDir,
      dbFile: files.DB,
      dbSize: size,
      dbSizeText: fmtSize(size),
      orders: Number(o.n || 0),
      customers: Number(c.n || 0),
      ledger: Number(l.n || 0),
      payables: Number(p.n || 0),
      staff: Number(s.n || 0),
      node: process.version,
    }
  }

  const listen = () => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(args.port, args.host, () => { server.removeListener('error', reject); resolve() })
  })
  try {
    await listen()
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') {
      console.error(`\n端口 ${args.port} 被占用了。换一个：--port 8788\n`)
      process.exit(2)
    }
    throw e
  }

  const ips = lanIps()
  const localUrl = `http://127.0.0.1:${args.port}`
  console.log(`
  本地记账服务已启动
  ─────────────────────────────
  浏览器打开：${localUrl}
  手机小程序：${ips.length ? ips.map((ip) => `http://${ip}:${args.port}`).join('  ') : '（没检测到局域网地址）'}
  数据目录：  ${dataDir}
  版本：      ${env.APP_VERSION}${env.APP_BUILT ? ' · ' + env.APP_BUILT : ''}
  ─────────────────────────────
  第一次用：浏览器里设个口令（小程序要输的那个）。
  关掉这个窗口就等于关掉服务。按 Ctrl+C 退出。
`)

  if (args.open && process.stdout.isTTY && !process.env.CI) {
    try {
      const cp = await import('node:child_process')
      const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', localUrl]] : process.platform === 'darwin' ? ['open', [localUrl]] : ['xdg-open', [localUrl]]
      cp.spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref()
    } catch (e) { /* 打不开就算了，用户自己点链接 */ }
  }

  // 定时任务：Cloudflare 那边配了 4 条 cron，本机版以前只跑「0 1 * * *」这一条，
  // 于是「周一汇总」和「每月 1 号的报表包」在本机版上永远不会发生（后端是靠 cron 字符串精确匹配分活的）。
  // 现在四条都按 UTC 时间点各跑各的，并且带「错过了就补跑」：电脑关机/睡眠过了点，开机后补一次。
  // 这些任务本身是幂等的（固定支出/摊销/预提/折旧都是 INSERT OR IGNORE + 按月份条件插入）。
  if (args.cron) {
    const stampFile = path.join(dataDir, 'last-cron.txt')
    const CRONS = [
      { c: '0 16 * * *', min: 0, hour: 16, dom: null, dow: null, what: '每日（备份/体检/记账兜底）' },
      { c: '0 1 * * *', min: 0, hour: 1, dom: null, dow: null, what: '每日（固定支出/摊销/预提/折旧）' },
      { c: '0 1 * * 1', min: 0, hour: 1, dom: null, dow: 1, what: '每周一汇总' },
      { c: '0 2 1 * *', min: 0, hour: 2, dom: 1, dow: null, what: '每月 1 号报表包' }
    ]
    const loadStamp = () => {
      try { return new Set(String(fs.readFileSync(stampFile, 'utf8') || '').split('\n').map((x) => x.trim()).filter(Boolean)) } catch (e) { return new Set() }
    }
    const saveStamp = (set) => {
      try { fs.writeFileSync(stampFile, Array.from(set).slice(-200).join('\n') + '\n') } catch (e) { /* 写不了就算了，下次补跑 */ }
    }
    const slotKey = (cron, d) => `${cron}|${d.toISOString().slice(0, 10)}`
    // 今天该跑的那一次（UTC），返回 { key, at } 或 null
    const slotOf = (x, nowUtc) => {
      const d = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate(), x.hour, x.min, 0))
      if (x.dom !== null && d.getUTCDate() !== x.dom) return null
      if (x.dow !== null && d.getUTCDay() !== x.dow) return null
      return { key: slotKey(x.c, d), at: d.getTime() }
    }
    let running = false
    const tick = async () => {
      if (running) return
      if (typeof worker.scheduled !== 'function') return
      const nowUtc = new Date()
      const stamps = loadStamp()
      // 到点的（允许 15 分钟内算「刚过点」）或者已经过了点但没跑过的，都补上
      const due = []
      for (const x of CRONS) {
        const sl = slotOf(x, nowUtc)
        if (!sl) continue
        if (stamps.has(sl.key)) continue
        if (nowUtc.getTime() < sl.at) continue
        due.push({ x, sl })
      }
      if (!due.length) return
      running = true
      for (const { x, sl } of due) {
        try {
          stamps.add(sl.key)
          saveStamp(stamps)
          console.log(`  [定时] ${sl.key.split('|')[1]} 跑 ${x.c}（${x.what}）…`)
          await worker.scheduled({ cron: x.c, scheduledTime: sl.at }, env, ctx)
          console.log('  [定时] 跑完了')
        } catch (e) {
          stamps.delete(sl.key) // 出错就把戳撤掉，下一轮重试
          saveStamp(stamps)
          console.log('  [定时] 出错（不影响记账）：' + String((e && e.message) || e))
          // 第 11 轮 F9：定时任务失败也要留痕，否则「今天没自动摊销」在界面上永远查不到原因
          try {
            (dbs[Object.keys(dbs)[0]]).prepare('INSERT INTO error_log (book,method,path,status,msg,ms,created_at) VALUES (?,?,?,?,?,?,?)')
              .bind(1, 'CRON', (sl.key || 'cron').split('|')[1] || 'cron', 0, ('定时任务失败：' + String((e && e.message) || e)).slice(0, 300), 0, new Date(Date.now() + 8 * 3600 * 1000).toISOString())
              .run()
          } catch (e2) { /* 同上 */ }
        }
      }
      running = false
    }
    setTimeout(tick, 8000)
    setInterval(tick, 60 * 1000)
  }

  const bye = () => {
    console.log('\n  正在关闭，数据已落盘…')
    try { server.close() } catch (e) {}
    for (const k of Object.keys(dbs)) { try { dbs[k].close() } catch (e) {} }
    process.exit(0)
  }
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
}

main().catch((e) => {
  console.error('\n启动失败：' + String((e && (e.stack || e.message)) || e) + '\n')
  process.exit(1)
})
