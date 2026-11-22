// 把 docs/新手教程.md 转成一张网页，编译进 backend/guide.js，线上用 /guide 打开。
// 为什么不用运行时读文件：Worker 运行时没有文件系统（本机版也没有打包 docs/），
// 所以文档必须在构建前就变成字符串。改完文档跑一次 `node scripts/gen-guide.mjs`；
// CI 里跑 `--check`，忘了重新生成会直接红。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC = path.join(ROOT, 'docs/新手教程.md')
const OUT = path.join(ROOT, 'backend/guide.js')

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const inl = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^(\s*)·\s/gm, '$1· ')

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[`*]/g, '')
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-|-$/g, '')

function md2html(md) {
  const lines = md.split(/\r?\n/)
  const out = []
  const toc = []
  let i = 0
  let inCode = false
  const codeBuf = []
  const closeList = () => {
    if (out.length && /<\/?(ul|ol)>$/.test(out[out.length - 1])) return
  }
  let listOpen = '' // 'ul' | 'ol' | ''
  const endList = () => {
    if (listOpen) {
      out.push(`</${listOpen}>`)
      listOpen = ''
    }
  }
  while (i < lines.length) {
    const raw = lines[i]
    const line = raw.replace(/\s+$/, '')
    // 代码块
    if (/^```/.test(line)) {
      if (inCode) {
        out.push('<pre><code>' + esc(codeBuf.join('\n')) + '</code></pre>')
        codeBuf.length = 0
        inCode = false
      } else {
        endList()
        inCode = true
      }
      i++
      continue
    }
    if (inCode) {
      codeBuf.push(raw)
      i++
      continue
    }
    // 空行
    if (!line.trim()) {
      endList()
      i++
      continue
    }
    // 分隔线
    if (/^---+$/.test(line.trim())) {
      endList()
      out.push('<hr/>')
      i++
      continue
    }
    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      endList()
      const lvl = h[1].length
      const txt = h[2].trim()
      const id = slug(txt)
      if (lvl === 2 && txt !== '目录') toc.push({ id, txt })
      out.push(`<h${lvl} id="${esc(id)}">${inl(txt)}</h${lvl}>`)
      i++
      continue
    }
    // 表格：以 | 开头，且下一行是分隔行
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      endList()
      const cell = (s) => s.trim().replace(/^\|/, '').replace(/\|$/, '')
      const head = cell(line).split('|').map((x) => x.trim())
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(cell(lines[i]).split('|').map((x) => x.trim()))
        i++
      }
      out.push('<div class="tw"><table><thead><tr>' + head.map((x) => `<th>${inl(x)}</th>`).join('') + '</tr></thead><tbody>')
      for (const r of rows) out.push('<tr>' + r.map((x) => `<td>${inl(x)}</td>`).join('') + '</tr>')
      out.push('</tbody></table></div>')
      continue
    }
    // 引用
    if (/^>\s?/.test(line)) {
      endList()
      const buf = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      out.push('<blockquote>' + buf.map((x) => (x.trim() ? inl(x) : '')).join('<br/>') + '</blockquote>')
      continue
    }
    // 有序 / 无序列表
    const ul = line.match(/^\s*[-*]\s+(.*)$/)
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol'
      if (listOpen !== want) {
        endList()
        out.push(`<${want}>`)
        listOpen = want
      }
      out.push(`<li>${inl((ul || ol)[1])}</li>`)
      i++
      continue
    }
    // 普通段落
    endList()
    out.push(`<p>${inl(line)}</p>`)
    i++
  }
  endList()
  if (inCode && codeBuf.length) out.push('<pre><code>' + esc(codeBuf.join('\n')) + '</code></pre>')
  return { body: out.join('\n'), toc }
}

const md = fs.readFileSync(SRC, 'utf8')
const { body, toc } = md2html(md)
const title = (md.match(/^#\s+(.*)$/m) || [, '使用教程'])[1].replace(/[`*]/g, '')

const tocHtml = toc.length
  ? '<nav class="toc"><div class="toct">目录</div>' + toc.map((x) => `<a href="#${esc(x.id)}">${esc(x.txt)}</a>`).join('') + '</nav>'
  : ''

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<style>
 *{box-sizing:border-box}
 body{margin:0;background:#f5f6f8;color:#222;font:16px/1.85 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
 .wrap{max-width:880px;margin:0 auto;padding:22px 18px 80px}
 header.top{position:sticky;top:0;background:#fff;border-bottom:1px solid #e8ebef;margin:0 -18px 18px;padding:12px 18px;display:flex;gap:12px;align-items:center;z-index:5}
 header.top a{color:#2f6fed;text-decoration:none;font-size:15px}
 header.top .sp{flex:1}
 .card{background:#fff;border-radius:12px;padding:6px 22px 22px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
 h1{font-size:24px;margin:16px 0 6px}
 h2{font-size:20px;margin:30px 0 10px;padding-top:10px;border-top:1px solid #eef0f3}
 h3{font-size:17px;margin:22px 0 8px}
 h4{font-size:16px;margin:18px 0 6px}
 p,li{font-size:15.5px}
 code{background:#f0f2f5;padding:1px 5px;border-radius:4px;font-size:14px}
 pre{background:#f7f8fa;border:1px solid #eceff3;border-radius:10px;padding:14px;overflow:auto}
 pre code{background:none;padding:0;font-size:13.5px;line-height:1.6}
 blockquote{margin:12px 0;padding:10px 14px;background:#fff8e8;border-left:4px solid #f0b429;border-radius:6px}
 blockquote p{margin:0}
 .tw{overflow-x:auto;margin:12px 0}
 table{border-collapse:collapse;width:100%;font-size:14.5px;background:#fff}
 th,td{border:1px solid #e8ebef;padding:8px 10px;text-align:left;vertical-align:top}
 th{background:#f7f8fa;font-weight:600}
 hr{border:none;border-top:1px solid #eef0f3;margin:22px 0}
 a{color:#2f6fed}
 .toc{background:#fff;border-radius:12px;padding:14px 18px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.06);display:flex;flex-wrap:wrap;gap:8px 16px}
 .toc .toct{width:100%;color:#777;font-size:13px;margin-bottom:2px}
 @media print{header.top,.toc{display:none}body{background:#fff}.card{box-shadow:none;padding:0}}
</style></head><body><div class="wrap">
<header class="top"><a href="/pc">← 回「电脑填表」</a><span class="sp"></span><a href="/guide" onclick="window.print();return false">🖨 打印</a></header>
${tocHtml}
<div class="card">
${body}
</div>
</div></body></html>`

// 故意不写「生成时间」：每次生成都变的时间戳会让 git 永远有 diff，
// 也会让 --check 只能靠「先把时间戳抹掉再比」这种绕法。
// 要看内容有没有更新，看 scripts/gen-guide.mjs --check 的结果就行。
const file = `// 这个文件由 scripts/gen-guide.mjs 从 docs/新手教程.md 生成，不要手改。
export const GUIDE_HTML = ${JSON.stringify(html)}
`

if (process.argv.includes('--check')) {
  const old = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
  // 兼容老版本 guide.js 里那一行「// 生成时间：…」（连换行一起吃掉）
  const strip = (x) => x.replace(/^\/\/ 生成时间：.*\n?/m, '')
  if (strip(old) !== strip(file)) {
    console.error('❌ backend/guide.js 跟 docs/新手教程.md 不一致：跑一次 node scripts/gen-guide.mjs')
    process.exit(1)
  }
  console.log('✅ 使用教程网页是最新的（' + Math.round(html.length / 1024) + ' KB）')
} else {
  fs.writeFileSync(OUT, file)
  console.log('✅ 生成 backend/guide.js（' + Math.round(html.length / 1024) + ' KB，' + toc.length + ' 个章节）')
}
