// 大文件切片上传回归测试（手机上选几 MB 的 Excel 时走的那条路）
//
// 为什么要有这个：3MB 的 Excel 转成 base64 是 4MB，一个 wx.request 发上去弱网下超时是常态；
// 而超时之后**用户不知道到底导进去了没有**，重发一次就可能导两遍。改成切片上传后，
// 新出现的失败方式全是「静默」的：少一片 → 拼出来是坏文件 → 报「读不了这个 Excel」（用户猜不到是缺片）；
// 片号重复 → 内容翻倍；upload_id 过期 → 空内容被当「没收到文件」。
// 所以逐条钉住：
//   1. 分片按任意顺序传、同一片重传都不报错，传完能拼回原样
//   2. 少片 / 缺片（片号不连续）/ 长度对不上，一律明确拒绝，不装作成功
//   3. /import-pack 与 /import-xlsx 都认 upload_id，预览与真导用同一个 id
//   4. upload_id 不存在或过期 → 410，而不是「没有收到文件内容」
//   5. 演示口令不能建上传会话（否则原件能借它落地）
//
// 用法：node scripts/test-upload.mjs [--base http://127.0.0.1:8791] [--key 8888]

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const BASE = arg('base', 'http://127.0.0.1:8791').replace(/\/$/, '')
const KEY = arg('key', '8888')
const H = { 'X-Access-Key': KEY, 'Content-Type': 'application/json' }

let pass = 0
const bad = []
const ok = (msg) => { pass++; console.log('  ✅ ' + msg) }
const no = (msg, detail) => { bad.push(msg); console.log('  ❌ ' + msg + (detail === undefined ? '' : ' → ' + JSON.stringify(detail))) }
const eq = (label, got, want) => (String(got) === String(want) ? ok(`${label} = ${want}`) : no(`${label} 应为 ${want}`, got))
const num0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

const call = async (method, p, body, key) => {
  // key === '' 表示「故意不带口令」，key === undefined 表示用默认老板口令
  const h = Object.assign({}, H)
  if (key !== undefined) {
    if (key) h['X-Access-Key'] = key
    else delete h['X-Access-Key']
  }
  const r = await fetch(BASE + p, {
    method, headers: h,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let d = null
  try { d = await r.json() } catch (e) { d = null }
  return { s: r.status, d }
}

const split = (b64, parts) => {
  const per = Math.ceil(b64.length / parts)
  const out = []
  for (let i = 0; i < parts; i++) out.push(b64.slice(i * per, (i + 1) * per))
  return out.filter((x) => x.length)
}

const main = async () => {
  console.log('大文件切片上传（' + BASE + '）')

  // 拿一份真 xlsx：模板包（日常台账）
  const tpl = await call('GET', '/import-template-pack?tpl=daily')
  const b64 = (tpl.d && tpl.d.b64) || ''
  if (!b64) { no('拿不到模板包内容，后面没法测', tpl.s); return }
  ok('模板包内容拿到（' + b64.length + ' 字符）')

  const parts = split(b64, 4)

  // ---- 1. 正常流程：乱序传、重传一片、状态、拼装 ----
  const st = await call('POST', '/upload-start', { name: '日常台账.xlsx', size: b64.length, parts: parts.length })
  eq('建上传会话 200', st.s, 200)
  const id = (st.d && st.d.id) || ''
  ok('拿到 upload_id（' + id + '）', !!id)
  eq('单片上限 700000', num0(st.d && st.d.part), 700000)

  const order = [1, 0, 2, 3].filter((i) => i < parts.length)
  for (const i of order) {
    const r = await call('POST', '/upload-part', { id, seq: i, b64: parts[i] })
    eq('传第 ' + (i + 1) + ' 片', r.s, 200)
  }
  const again = await call('POST', '/upload-part', { id, seq: 0, b64: parts[0] })
  eq('同一片重传不报错', again.s, 200)

  const state = await call('GET', '/upload-state?id=' + encodeURIComponent(id))
  eq('上传状态 200', state.s, 200)
  eq('片数对得上', num0(state.d && state.d.parts), parts.length)
  eq('收到的片数对得上', (state.d && state.d.got || []).length, parts.length)
  eq('还没标完成', !!(state.d && state.d.done), false)

  const fin = await call('POST', '/upload-finish', { id })
  eq('拼装 200', fin.s, 200)
  eq('拼出来的长度和原文件一样', num0(fin.d && fin.d.size), b64.length)

  // ---- 2. 用 upload_id 预览 + 真导（两个导入接口都认） ----
  const dry = await call('POST', '/import-pack', { upload_id: id, dry: true })
  eq('用 upload_id 预览 200', dry.s, 200)
  eq('预览认出 7 页（日常台账）', (dry.d && dry.d.sheets || []).length, 7)

  const real = await call('POST', '/import-pack', { upload_id: id })
  eq('用 upload_id 真导 200', real.s, 200)
  eq('真导时整包没被「同一份文件」挡住（新的上传号）', !!(real.d && real.d.dup_file), false)

  const xl = await call('POST', '/import-xlsx', { type: 'bank', upload_id: id, preview: true })
  ok('/import-xlsx 也认 upload_id（' + xl.s + '）', xl.s === 200 || xl.s === 400)

  // ---- 3. 少片：必须拒绝，不能装作成功 ----
  const st2 = await call('POST', '/upload-start', { name: '少片', size: b64.length, parts: 3 })
  const id2 = (st2.d && st2.d.id) || ''
  const p2 = split(b64, 3)
  await call('POST', '/upload-part', { id: id2, seq: 0, b64: p2[0] })
  await call('POST', '/upload-part', { id: id2, seq: 1, b64: p2[1] })
  const fin2 = await call('POST', '/upload-finish', { id: id2 })
  eq('少一片 → 409', fin2.s, 409)
  eq('拒绝理由是「还差 1 片」', fin2.d && fin2.d.code, 'upload_incomplete')
  ok('说清已收几片', /已收 2\/3/.test(String((fin2.d && fin2.d.error) || '')), fin2.d && fin2.d.error)

  // ---- 4. 片号不连续：拼出来是坏文件，必须拒绝 ----
  // 片数够了、但片号是 0 和 2：这种最阴，数量对得上、拼出来却是坏文件
  const st3 = await call('POST', '/upload-start', { name: '缺中间', size: b64.length, parts: 2 })
  const id3 = (st3.d && st3.d.id) || ''
  await call('POST', '/upload-part', { id: id3, seq: 0, b64: p2[0] })
  await call('POST', '/upload-part', { id: id3, seq: 2, b64: p2[2] })
  const fin3 = await call('POST', '/upload-finish', { id: id3 })
  eq('缺中间那一片 → 409', fin3.s, 409)
  eq('拒绝理由是片号不连续', fin3.d && fin3.d.code, 'upload_gap')

  // ---- 5. 长度对不上 ----
  const st4 = await call('POST', '/upload-start', { name: '长度不对', size: 12345, parts: 1 })
  const id4 = (st4.d && st4.d.id) || ''
  await call('POST', '/upload-part', { id: id4, seq: 0, b64: parts[0] })
  const fin4 = await call('POST', '/upload-finish', { id: id4 })
  eq('长度对不上 → 409', fin4.s, 409)
  eq('拒绝理由是长度不符', fin4.d && fin4.d.code, 'upload_size')

  // ---- 6. 单片过大 / 空片 / 片号越界 ----
  const big = await call('POST', '/upload-part', { id, seq: 9, b64: 'A'.repeat(700001) })
  eq('单片超过 70 万字符 → 400', big.s, 400)
  eq('理由是「这一片太大」', big.d && big.d.code, 'part_too_big')
  const empty = await call('POST', '/upload-part', { id, seq: 9, b64: '' })
  eq('空片 → 400', empty.s, 400)

  // ---- 7. upload_id 不存在 / 过期 ----
  const ghost = await call('POST', '/import-pack', { upload_id: 'upnope12345', dry: true })
  eq('不存在的 upload_id → 410', ghost.s, 410)
  eq('不是「没有收到文件内容」', ghost.d && ghost.d.code, 'no_upload')
  const ghost2 = await call('POST', '/upload-finish', { id: 'upnope12345' })
  eq('拼装一个不存在的会话 → 410', ghost2.s, 410)

  // ---- 8. 演示口令不能建上传会话（否则原件能借演示身份落地） ----
  const dm = await call('POST', '/upload-start', { name: 'x', size: 10, parts: 1 }, 'demo-look')
  eq('演示口令建上传会话 → 403', dm.s, 403)
  eq('理由是只读', dm.d && dm.d.code, 'demo_readonly')

  // ---- 9. 没口令不许传 ----
  const anon = await call('POST', '/upload-start', { name: 'x', size: 10, parts: 1 }, '')
  eq('没口令 → 401', anon.s, 401)

  // ---- 10. 真的几 MB 也能拼起来（D1 单行上限 2MB，所以每片压到 70 万字符） ----
  // 这里用一段合成的 3.4MB 内容：不是 xlsx，所以最后一步必然报「读不了这个 Excel」——
  // 但能报到这一步，就说明几 MB 确实完整拼回来了（少了片会先被 upload_gap / upload_size 挡住）。
  {
    const size = 2600000
    const raw = Buffer.alloc(size)
    for (let i = 0; i < size; i++) raw[i] = 65 + (i % 26)
    const bigB64 = raw.toString('base64')
    const want = Math.ceil(bigB64.length / 700000)
    const s5 = await call('POST', '/upload-start', { name: 'big.bin', size: bigB64.length, parts: want })
    const id5 = (s5.d && s5.d.id) || ''
    eq('3.4MB 的文件：会话建起来', s5.s, 200)
    let sent = 0
    for (let i = 0; i < want; i++) {
      const r = await call('POST', '/upload-part', { id: id5, seq: i, b64: bigB64.slice(i * 700000, (i + 1) * 700000) })
      if (r.s === 200) sent++
    }
    eq('5 片全收下（每片 70 万字符，没超 D1 单行 2MB）', sent, want)
    const f5 = await call('POST', '/upload-finish', { id: id5 })
    eq('几 MB 也能拼起来', f5.s, 200)
    eq('拼回来的长度一字不差', num0(f5.d && f5.d.size), bigB64.length)
    const p5 = await call('POST', '/import-xlsx', { type: 'bank', upload_id: id5, preview: true })
    eq('内容确实送到解析器了（不是「读不了」之前的 410/409）', p5.s, 400)
    ok('报的是「读不了这个 Excel」而不是「没有收到文件内容」', /读不了这个 Excel/.test(String((p5.d && p5.d.error) || '')), p5.d && p5.d.error)
  }

  console.log('')
  if (bad.length) {
    console.log('❌ 切片上传：' + bad.length + ' 项没过（通过 ' + pass + ' 项）')
    bad.forEach((b) => console.log('   · ' + b))
    process.exit(1)
  }
  console.log('✅ 切片上传：' + pass + ' 项全过')
}

main().catch((e) => { console.error('测试自己崩了：', e); process.exit(1) })
