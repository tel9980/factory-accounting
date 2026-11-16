#!/usr/bin/env python3
"""从 backend/index.js 抽取所有路由，重写 README 里的「接口清单」附录。
用法： python3 scripts/gen-api-list.py
目的：让 README 的接口清单跟着代码走，不会越写越偏。
"""
import io, re, os, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(ROOT, 'backend', 'index.js')
MD = os.path.join(ROOT, 'README.md')
BEGIN, END = '<!-- API-LIST:BEGIN -->', '<!-- API-LIST:END -->'

src = io.open(JS, encoding='utf-8').read()
routes = sorted(set(re.findall(r"app\.(get|post|patch|delete)\('([^']+)'", src)))

raw = collections.OrderedDict()
for m, p in routes:
    parts = p.split('/')
    seg = parts[1] if len(parts) > 1 else 'root'
    seg = seg.split(':')[0] or 'root'
    raw.setdefault(seg, []).append((m.upper(), p))

# 只有一两个接口的零碎分组归到「其它」，清单更好扫
groups = collections.OrderedDict((k, v) for k, v in raw.items() if len(v) >= 2)
misc = [x for k, v in raw.items() if len(v) < 2 for x in v]
if misc:
    groups['其它（单个接口）'] = sorted(misc, key=lambda x: x[1])

lines = [BEGIN, '', '## 附录：接口清单（由 `scripts/gen-api-list.py` 自动生成，请勿手改）', '',
         f'共 {len(routes)} 个接口。改完后端跑一次 `python3 scripts/gen-api-list.py` 即可同步本清单。', '']
for seg, items in groups.items():
    lines.append(f'**{seg}**（{len(items)}）')
    lines.append('')
    for m, p in items:
        lines.append(f'- `{m} {p}`')
    lines.append('')
lines.append(END)
block = '\n'.join(lines)

md = io.open(MD, encoding='utf-8').read()
if BEGIN in md and END in md:
    md = md[:md.index(BEGIN)] + block + md[md.index(END) + len(END):]
else:
    md = md.rstrip() + '\n\n' + block + '\n'
io.open(MD, 'w', encoding='utf-8').write(md)
print(f'{len(routes)} routes, {len(groups)} groups written to README.md')
