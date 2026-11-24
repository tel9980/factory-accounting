#!/usr/bin/env node
// 打「免安装单文件程序」（Node SEA）：把本机版服务打成 exe/可执行文件，
// 拿到就能双击跑，不用装 Node、不用装数据库。
//
// 做法三步（Node 官方 SEA，不需要第三方打包器）：
//   1) esbuild 把 server/main.mjs + backend/index.js + hono 打成一个 CJS 文件；
//   2) `node --experimental-sea-config` 生成注入用的 blob（schema.sql 作为资源塞进去）；
//   3) postject 把 blob 注入到 node 二进制副本里，得到最终的可执行文件。
//
// 用法：
//   node scripts/build-exe.mjs                 # 打当前平台
//   node scripts/build-exe.mjs --out dist      # 输出目录
//   node scripts/build-exe.mjs --no-test       # 跳过「打完自己跑一遍」
//
// CI 见 .github/workflows/release.yml（win/linux/mac 三个平台各跑一次）。
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import { BOOKS } from '../server/books.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const argOf = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const flag = (n) => argv.includes('--' + n)

const OUT = path.resolve(argOf('out', path.join(ROOT, 'dist')))
const BUILD = path.join(ROOT, 'build')
const ENTRY = path.join(ROOT, 'server/main.mjs')
const SCHEMA = path.join(ROOT, 'backend/schema.sql')
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
const plat = process.platform
const arch = process.arch
// 文件名用大家看得懂的名字（process.platform 是 win32/darwin，别直接往文件名上贴）
const platName = plat === 'win32' ? 'windows' : plat === 'darwin' ? 'macos' : plat
const exeName = `factory-accounting-${platName}-${arch}` + (plat === 'win32' ? '.exe' : '')
const target = path.join(OUT, exeName)
// 直接跑 postject 的 js 入口，而不是 .bin 里的包装脚本 —— Windows 上 .cmd 必须走 shell，
// 一走 shell 路径里有空格就会被拆开。用 node 跑 cli.js 三个平台都一样。
const postjectCli = path.join(ROOT, 'backend', 'node_modules', 'postject', 'dist', 'cli.js')

const step = (s) => console.log('\n▸ ' + s)
const sh = (cmd, args, opt = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opt })
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 失败（退出码 ${r.status}）`)
}
const version = (() => {
  if (process.env.RELEASE_VERSION) return process.env.RELEASE_VERSION
  const g = spawnSync('git', ['describe', '--tags', '--always'], { cwd: ROOT, encoding: 'utf8' })
  const v = (g.stdout || '').trim()
  return v || 'local'
})()
const built = new Date().toISOString().replace(/\.\d+Z$/, 'Z')

// 1) 打成一个 CJS 文件
step(`1/4 esbuild 打包（版本 ${version}）`)
fs.mkdirSync(BUILD, { recursive: true })
fs.mkdirSync(OUT, { recursive: true })
const req = createRequire(path.join(ROOT, 'backend/package.json'))
const esbuild = req('esbuild')
const cjs = path.join(BUILD, 'app.cjs')
await esbuild.build({
  entryPoints: [ENTRY],
  outfile: cjs,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  logLevel: 'warning',
  sourcemap: false,
  minify: false,
  // 这两句让程序里能报出「这是哪个版本、什么时候打的」
  define: { __FA_VERSION__: JSON.stringify(version), __FA_BUILT__: JSON.stringify(built) },
  banner: { js: '/* 本机版：由 scripts/build-exe.mjs 打出来的，不要手改 */' },
})
const cjsSize = fs.statSync(cjs).size
console.log(`  build/app.cjs  ${(cjsSize / 1024).toFixed(0)} KB`)

// 2) 生成 SEA blob（schema.sql + 迁移文件当资源塞进去，程序里读得到）
step('2/4 生成 SEA blob')
const cfgPath = path.join(BUILD, 'sea-config.json')
// 第 13 轮 E2：以前只塞 schema.sql，不塞 backend/migrations/*.sql —— exe 里没有那个目录，
// 启动时跑不到迁移，0001 建的索引在 exe 上永久缺失（大账本越用越慢，没人看得出原因）。
// 现在把迁移文件合成一个 JSON 一起塞进去，server/d1.mjs 读不到目录就用这份。
const MIG_DIR = path.join(ROOT, 'backend/migrations')
const migList = fs.existsSync(MIG_DIR)
  ? fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => ({ name: f, sql: fs.readFileSync(path.join(MIG_DIR, f), 'utf8') }))
  : []
const migJsonPath = path.join(BUILD, 'migrations.json')
fs.writeFileSync(migJsonPath, JSON.stringify(migList))
console.log(`  migrations.json  ${migList.length} 个迁移文件`)
fs.writeFileSync(cfgPath, JSON.stringify({
  main: cjs,
  output: path.join(BUILD, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: { 'schema.sql': SCHEMA, 'migrations.json': migJsonPath },
}, null, 2))
sh(process.execPath, ['--experimental-sea-config', cfgPath])
const blob = path.join(BUILD, 'sea-prep.blob')
console.log(`  sea-prep.blob  ${(fs.statSync(blob).size / 1024).toFixed(0)} KB`)

// 3) 复制 node 二进制 + 注入
step('3/4 注入到 node 二进制')
fs.copyFileSync(process.execPath, target)
if (plat === 'darwin') {
  // macOS 的 node 二进制带签名，签名不动的话注入完会被系统直接杀掉
  try { spawnSync('codesign', ['--remove-signature', target], { stdio: 'inherit' }) } catch (e) { /* 本来就没签名 */ }
}
// macOS 上必须指定新增的 segment 名（Node 官方文档那条命令里的 --macho-segment-name）。
// 少了它 postject 也会说「Injection done」，但打出来的二进制一启动就被系统 SIGKILL（连一行输出都没有）。
const machoArgs = plat === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []
sh(process.execPath, [postjectCli, target, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE, ...machoArgs])
if (plat === 'darwin') {
  sh('codesign', ['--sign', '-', target])
} else if (plat !== 'win32') {
  try { fs.chmodSync(target, 0o755) } catch (e) { /* 无所谓 */ }
}
console.log(`  ${exeName}  ${(fs.statSync(target).size / 1048576).toFixed(1)} MB`)

// 4) 自测：自己跑一遍，看版本号和落地页对不对
if (!flag('no-test')) {
  step('4/4 跑一遍打好的程序')
  const port = 9000 + Math.floor(Math.random() * 900)
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-exe-'))
  const child = spawn(target, ['--port', String(port), '--data', dataDir, '--no-open', '--no-cron'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  const base = `http://127.0.0.1:${port}`
  const get = async (p) => {
    const r = await fetch(base + p)
    return { status: r.status, text: await r.text() }
  }
  let ok = false
  for (let i = 0; i < 60; i++) {
    try {
      const v = await get('/version')
      if (v.status === 200) {
        const d = JSON.parse(v.text)
        if (d.version !== version) throw new Error(`/version 里的版本号是 ${d.version}，应该是 ${version}`)
        ok = true
        break
      }
    } catch (e) { if (/版本号/.test(String(e.message))) { console.log('  ❌ ' + e.message); break } }
    await new Promise((r) => setTimeout(r, 500))
  }
  try {
    if (!ok) throw new Error('程序起来了但 /version 一直没通')
    const page = await get('/')
    if (page.status !== 200 || !page.text.includes('本地记账服务')) throw new Error('落地页不对（HTTP ' + page.status + '）')
    const st = JSON.parse((await get('/__local/status')).text)
    if (!st.dbFile || st.orders !== 0) throw new Error('状态接口不对：' + JSON.stringify(st).slice(0, 120))
    // 建库是启动时做的，这里确认真的建出来了（60 张表）
    const files = fs.readdirSync(dataDir).filter((f) => f.endsWith('.db'))
    // 库文件个数跟 server/books.mjs 的 BOOKS 走。以前这里写死 3，服务改成 9 本以后
    // 断言没跟，打出来的程序明明是好的，自测却判失败 → 三个平台的 release 全红。
    if (files.length !== BOOKS) throw new Error(`应该建出 ${BOOKS} 个库文件，实际 ${files.length}（BOOKS 在 server/books.mjs 里改）`)
    // 记数在 WAL 里，主库文件可能还是 4KB，所以把 book1.db* 一起算
    const sz = fs.readdirSync(dataDir).filter((f) => f.startsWith('book1.db'))
      .reduce((n, f) => n + fs.statSync(path.join(dataDir, f)).size, 0)
    if (sz < 100 * 1024) throw new Error('主库文件太小（' + sz + ' 字节），schema.sql 可能没跑起来')
    // 第 13 轮 E2：确认迁移真的在 exe 上跑了 —— 以前只塞 schema.sql，迁移在 exe 上永远不跑，
    // 这几个索引就永久缺失，大账本一年后慢得没法用，而自测一直是绿的。
    try {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(path.join(dataDir, 'book1.db'))
      const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => String(r.name)))
      db.close()
      // 第 17 轮 E1：need 列表改成「schema.sql 里声明的全部索引」——
      // 以前只写死三个，以后 schema.sql 新增索引时这里不会跟着变，exe 上缺了也没人知道。
      const schemaSrc = fs.readFileSync(path.join(ROOT, 'backend/schema.sql'), 'utf8')
      const need = [...schemaSrc.matchAll(/CREATE INDEX IF NOT EXISTS\s+(\w+)/g)].map((m) => m[1])
      const miss = need.filter((n) => !names.has(n))
      if (miss.length) throw new Error('打包出来的程序没跑迁移，缺索引：' + miss.join('、') + '（build 的 assets 里要带 migrations.json）')
      console.log('  ✅ 迁移在 exe 上跑过了（schema.sql 的 ' + need.length + ' 个索引都在）')
    } catch (e) {
      // 本机 Node 太老没有 node:sqlite 时只提示，不判定失败（CI 的 Node 24 一定有）
      if (/node:sqlite|Cannot find|ERR_UNKNOWN_BUILTIN/.test(String(e && e.message))) console.log('  ⚠️ 这台机器的 Node 没有 node:sqlite，跳过索引自检')
      else throw e
    }
    console.log(`  ✅ 跑通了：/version=200，落地页正常，建出 ${BOOKS} 个库（主库 ${(sz / 1024).toFixed(0)} KB）`)
  } catch (e) {
    console.log('  ❌ 自测失败：' + String(e && e.message || e))
    console.log(`  子进程状态：exitCode=${child.exitCode} signalCode=${child.signalCode}`)
    console.log('  程序输出：\n' + (log ? log.split('\n').slice(-20).join('\n') : '（一个字都没有：多半是一启动就被系统杀掉了）'))
    try { child.kill('SIGKILL') } catch (_) {}
    process.exit(1)
  }
  try { child.kill('SIGTERM') } catch (e) { /* 已经退了 */ }
  await new Promise((r) => setTimeout(r, 800))
  try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch (e) { /* 临时目录，删不掉也无所谓 */ }
}

console.log(`\n✅ 好了：${target}`)
console.log('   双击或在命令行里跑它，浏览器会自己打开 http://127.0.0.1:8787')
console.log(`   数据默认放在程序旁边的 data/ 目录（book1.db … book${BOOKS}.db，一本账一个文件）`)
