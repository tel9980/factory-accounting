#!/usr/bin/env bash
# 一条命令部署到线上：bash scripts/deploy.sh
#
# 为什么要有这个脚本：以前每次部署都要手打一长串
#   npx wrangler deploy --var APP_VERSION:"$(date …)" --var APP_BUILT:… --var APP_COMMIT:…
# 还得先找 token、先关代理 —— 少一样就报「not authenticated」或者线上 /version 变成 dev，
# 之后分不清线上跑的是哪一次代码。现在这些都收进来了，部署就一条命令。
#
# token 从哪来（按顺序找，找到就用）：
#   1) 环境变量 CLOUDFLARE_API_TOKEN（CI / 临时用）
#   2) 仓库根的 .env.local（本机，已被 .gitignore 挡住，绝不进仓库）
#   3) ~/.dsh/cf-token（本机全局，多个项目共用一份）
# token 需要的权限：Workers Scripts:Edit + D1:Edit（模板名 "Edit Cloudflare Workers"）。
#
# 用法：
#   bash scripts/deploy.sh              # 自检 → 部署 → 验线上版本
#   bash scripts/deploy.sh --no-check   # 跳过自检（赶时间时用，自己确保测过）
#   bash scripts/deploy.sh --dry-run    # 只看会部署什么，不真发
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

NO_CHECK=0
DRY=0
for a in "$@"; do
  case "$a" in
    --no-check) NO_CHECK=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "不认识的参数：$a"; exit 2 ;;
  esac
done

# ---- token ----
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ -f "$ROOT/.env.local" ]; then
  set -a; . "$ROOT/.env.local"; set +a
fi
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ -f "$HOME/.dsh/cf-token" ]; then
  CLOUDFLARE_API_TOKEN="$(cat "$HOME/.dsh/cf-token")"
fi
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  cat <<'EOF' >&2
❌ 找不到 Cloudflare token。三种给法（选一个）：
   1) 仓库根建 .env.local，写上：
        CLOUDFLARE_API_TOKEN=xxxx
        CLOUDFLARE_ACCOUNT_ID=fb907fe08010a1b319f68be568331ce5
   2) 写到 ~/.dsh/cf-token（多个项目共用）
   3) 直接 export CLOUDFLARE_API_TOKEN=xxxx
EOF
  exit 1
fi
export CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-fb907fe08010a1b319f68be568331ce5}"

# wrangler 连 Cloudflare 走本机代理经常 TLS 报错（跟 git push 是同一个坑），这里统一清掉。
# 注意：这只影响本进程，不动你 shell 里的设置。
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY NODE_USE_ENV_PROXY

# ---- 自检 ----
if [ "$NO_CHECK" = "0" ]; then
  echo "→ 自检（scripts/check.mjs）"
  node scripts/check.mjs > /tmp/deploy-check.log 2>&1 || { echo "❌ 自检没过，先看下面："; tail -30 /tmp/deploy-check.log; exit 1; }
  grep -E "路由|SQL|绑定" /tmp/deploy-check.log | tail -3 || true
fi

# ---- 版本号：这三个变量必须带上去，否则线上 /version 显示 dev，出了事查不清是哪次 ----
V="$(TZ=Asia/Shanghai date +%Y%m%d-%H%M)"
B="$(date -u +%FT%TZ)"
C="$(git rev-parse --short HEAD)"
DIRTY=""
if [ -n "$(git status --porcelain)" ]; then DIRTY="（工作区有未提交改动）"; fi
echo "→ 部署 $V  commit $C$DIRTY"

EXTRA=""
[ "$DRY" = "1" ] && EXTRA="--dry-run"

# ---- 迁移（跟 CI 同一件事、同一份脚本，别各写一套）----
# 为什么在部署之前：迁移是「加列/加索引」，先跑迁移再上新代码，新代码才一定用得上新列；
# 反过来（先部署再迁移）中间那几分钟老代码会撞新表结构。CI 里也是这个顺序（deploy.yml
# 的「跑远程数据库迁移」在「部署到 Cloudflare」之前）。跑失败的迁移脚本会 exit 1，
# 所以这里直接终止，不会「迁移没过还照样部署」。
# 第 16 轮 C2：这个脚本以前只跑迁移、不灌表结构 —— 照 DEPLOYMENT 手工发布时，
# 新开的账套（或者新加的表）根本没建，wrangler 照样回 "Deployed"，看着像成功。
# 现在和 CI 做同一套：建表 → 迁移 → 再补一遍索引 → 部署后体检。
# 顺序的道理见 deploy.yml 那段注释：schema.sql 里有索引引用迁移才加上的列，一遍过不了。
if [ "$DRY" = "1" ]; then
  echo "（--dry-run：跳过建表与迁移）"
else
  echo "→ 补表结构（第 1 遍：建表；老库缺新列时可能报错，正常）"
  node scripts/d1-seed-schema.mjs || echo "   （第 1 遍有报错，等迁移加完列再补）"
  echo "→ 跑远程数据库迁移"
  node scripts/d1-migrate.mjs
  echo "→ 补表结构（第 2 遍：迁移之后补索引，这一遍必须过）"
  node scripts/d1-seed-schema.mjs
fi

cd backend
npx wrangler deploy $EXTRA --var APP_VERSION:"$V" --var APP_BUILT:"$B" --var APP_COMMIT:"$C"
[ "$DRY" = "1" ] && { echo "（--dry-run：没有真发）"; exit 0; }

# ---- 验线上：不能光看 wrangler 说 Deployed ----
echo "→ 验线上版本"
sleep 5
node -e '
const want = process.argv[1], wantV = process.argv[2]
fetch("https://jz.qy663.de5.net/version").then((r) => r.json()).then((d) => {
  console.log("   线上：" + JSON.stringify(d))
  if (String(d.version) === "dev") { console.error("❌ 线上还是 dev，--var 没生效"); process.exit(1) }
  if (d.commit && String(d.commit).indexOf(want) !== 0) { console.error("❌ 线上 commit 是 " + d.commit + "，不是 " + want); process.exit(1) }
  if (wantV && String(d.version) !== wantV) console.log("   （注意：版本串是 " + d.version + "，本地算的是 " + wantV + "，跨分钟属正常）")
  console.log("✅ 线上已经是这次提交")
}).catch((e) => { console.error("❌ 拿不到 /version：" + e.message); process.exit(1) })
' "$C" "$V"

# ---- 部署后体检（第 16 轮 C2）----
# 光验版本号不够：版本对了但库里缺表/缺列，接口一样 500。
# check-live.mjs 只发 GET，逐项跑关键接口 + /schema-check，红了说明这次发布有问题。
# 需要访问口令：本机发布用 FA_KEY（或 .env.local 里的 FA_KEY）；没给就只提示、不判失败。
if [ "$DRY" = "1" ]; then
  echo "（--dry-run：跳过部署后体检）"
else
  KEY_TRY="${FA_KEY:-${FACTORY_KEY:-}}"
  if [ -z "$KEY_TRY" ]; then
    echo "→ 部署后体检：跳过（没给 FA_KEY 访问口令；要跑就 FA_KEY=你的口令 bash scripts/deploy.sh）"
  else
    echo "→ 部署后体检（线上接口 + 表结构）"
    node scripts/check-live.mjs --base https://jz.qy663.de5.net --key "$KEY_TRY" || {
      echo "❌ 部署后体检没过：版本对了，但线上有接口/表结构不对。先看上面哪一项红。"
      exit 1
    }
  fi
fi
