# 加工费核算小程序部署说明

这套东西由两块组成：**后端**（Cloudflare Worker + D1 数据库）和 **前端**（微信小程序）。
下面按「从零装一套新的」和「升级已有的」分开写，照着做就行。

---

## 0. 装之前先跑一遍自检（30 秒，不联网、不碰数据）

```bash
node scripts/check.mjs
```

要 **Node 24**（自检用内置 `node:sqlite` 在内存里真建一遍库，Node 20 没有这个模块）。
它会检查：路由有没有重名、`schema.sql` 能不能一次建出新库、代码里写死的 677 条 SQL 在新库上跑不跑得通、
前端 265 个接口调用后台有没有、页面 wxml 绑的方法在 js 里存不存在。红了就先修，别急着装。

GitHub Actions 里也是这个顺序：`.github/workflows/deploy.yml` 先跑自检，绿了才 `wrangler deploy`。

---

## 1. 从零装一套新的

### 1.1 建数据库（D1）

在 Cloudflare 控制台 → **Storage & Databases → D1 SQL Database** 里建库：

| 绑定名 | 库名 | 用途 |
| --- | --- | --- |
| `DB` | `factory-db` | 主账本（必装） |
| `DB2` | `factory-db2` | 第二本账（可选） |
| `DB3` | `factory-db3` | 第三本账（可选，员工口令/小程序用户存在这里） |

三本账的表结构完全一样。只想用一个账本，建 `DB` 就够，`DB2`/`DB3` 的绑定可以留空不配
（后台会自己跳过，不会报错）。

### 1.2 把表灌进去（关键一步，以前这里最容易漏）

```bash
cd backend
npm install
npx wrangler d1 execute factory-db  --remote --file=schema.sql
npx wrangler d1 execute factory-db2 --remote --file=schema.sql   # 建了 DB2 才要
npx wrangler d1 execute factory-db3 --remote --file=schema.sql   # 建了 DB3 才要
```

**一个 `schema.sql` 就够**：它会建出全部 60 张表、索引和 `month` 列的触发器，
不用再手工 ALTER、也不用单独跑别的脚本。重复执行是安全的（都是 `IF NOT EXISTS`）。

> 历史坑：2026-11 之前 `schema.sql` 是「线上库更新、文件没跟上」的状态，
> 拿它新建一本账会卡在 `CREATE INDEX ... ledger(account_id)` 直接报错，
> 另外还有 11 张表压根没写建表语句。现在修好了，`scripts/check.mjs` 每次都会验一遍。

### 1.3 改 `wrangler.toml`

把三个 `database_id` 换成你自己刚建的库 ID，`database_name` 对应改或保持不变都行，
绑定名（`DB` / `DB2` / `DB3`）**必须保持这三个名字**——后端就是按名字取的。

同一文件里还有 cron（每天 16:00/01:00 备份与提醒、周一汇总、每月 1 号月结）：

```toml
[triggers]
crons = ["0 16 * * *", "0 1 * * *", "0 1 * * 1", "0 2 1 * *"]
```

### 1.4 部署后端

日常部署就一条命令（在仓库根目录）：

```bash
bash scripts/deploy.sh
```

它会依次做四件事，少一步就出过事，所以都收进去了：

1. **找 token**：环境变量 `CLOUDFLARE_API_TOKEN` → 仓库根 `.env.local` → `~/.dsh/cf-token`，三个有一个就行
2. **清代理**：`http_proxy/https_proxy` 会让 wrangler 连 Cloudflare 直接 TLS 失败（跟 git push 是同一个坑）
3. **跑自检** `scripts/check.mjs`，绿了才发（赶时间可以 `--no-check`）
4. **带上版本号部署**（`APP_VERSION` / `APP_BUILT` / `APP_COMMIT` 三个 `--var`），发完**自己打一次 `/version` 核对**，`version` 还是 `dev` 或者 `commit` 对不上就报错退出

想先看看会发什么：`bash scripts/deploy.sh --dry-run`。

token 放哪儿（三选一，别写进仓库）：

```bash
# 本机：仓库根建 .env.local（.gitignore 的 .env.* 已经挡住了，进不了仓库）
CLOUDFLARE_API_TOKEN=xxxx
CLOUDFLARE_ACCOUNT_ID=fb907fe08010a1b319f68be568331ce5

# 或者全机共用一份
echo 'xxxx' > ~/.dsh/cf-token && chmod 600 ~/.dsh/cf-token
```

token 需要 `Workers Scripts:Edit` + `D1:Edit`（模板 "Edit Cloudflare Workers" 就够）。
注意**账号要对**：拿别的账号的 token 部署会报
`D1 binding 'DB2' references database 'ace7317a-…' which was not found`（code 10181）——
那说明 token 属于另一个 Cloudflare 账号，不是这个项目的。

手工部署（脚本不好使时兜底）：

```bash
cd backend
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY NODE_USE_ENV_PROXY
CLOUDFLARE_ACCOUNT_ID=fb907fe08010a1b319f68be568331ce5 \
  npx wrangler deploy \
  --var APP_VERSION:"$(TZ=Asia/Shanghai date +%Y%m%d-%H%M)" \
  --var APP_BUILT:"$(date -u +%FT%TZ)" \
  --var APP_COMMIT:"$(git rev-parse --short HEAD)"
curl -s https://jz.qy663.de5.net/version   # {"ok":true,"version":"20261121-1944",...}
```

部署完**一定要打一下 `/version`**：以前只能靠猜线上更新没有（CI 绿勾不等于线上更新，
见下面 1.4 末尾的说明）。

**回滚**（改坏了、要退回上一版）：

```bash
cd backend
npx wrangler deployments list          # 看最近几次部署
npx wrangler rollback [deployment-id]  # 不填就是退回上一个版本
```

推 `main` 分支也会自动部署（GitHub Actions），但**只有自检 + 全接口冒烟都通过才会部署**。

前提是这个仓库配了 `CF_API_TOKEN`：

```
仓库 → Settings → Secrets and variables → Actions → New repository secret
名字：CF_API_TOKEN
值：  Cloudflare → My Profile → API Tokens → Create Token → Edit Cloudflare Workers 模板
```

没配会怎样：自检和冒烟照跑，「部署」那步会跳过，并在运行摘要上挂一条 warning。
**2026-11-21 已配上 `CF_API_TOKEN`**（用 `gh secret set CF_API_TOKEN` 设的），
所以从那以后推 `main` 就是「自检绿 → 自动部署 → 部署后验版本」，不用再手工发。
上线后还是建议打一下 `/version` 确认 commit 对得上。

还有一个可选的 `PROD_KEY`（值就是线上老板口令），配上之后部署完会多跑一步「线上体检」：

```
名字：PROD_KEY
值：  线上那本账的老板口令
```

这一步做两件事：①对 `https://jz.qy663.de5.net` 跑一遍 `scripts/check-live.mjs`
（16 个 GET，**只读不写**；任何非 200 都算坏；口令被拒时退出码 2 = 不是线上坏了，不回滚）；
②问一次 `/schema-check`，线上真缺列就直接红，并打印缺哪张表哪个字段。

> ⚠️ 别拿 `scripts/smoke.mjs` 去跑生产：它第一步就 `POST /auth/setup`，会在线上写东西。
> 那是本机/CI 冒烟用的，只能 `--base http://127.0.0.1:…`（第 17 轮 F1）。
为什么不配也能跑：`check.mjs` 只能证明「`schema.sql` 在空库上建得出来」，证明不了
「线上那个库缺不缺列」——这两个 secret 都不配时，CI 只能保证「代码能跑」，保证不了「线上是对的」。

**体检没过会自动回滚**：`deploy.yml` 的部署步现在带 `id: deploy`，紧随其后的「线上体检」
一旦红，就会自动 `npx wrangler rollback`（退回上一个 Worker 版本）并把过程写进运行摘要。
以前体检红了只是红，线上照样挂着新版本——用户看到的是「线上怪怪的」，CI 是一片绿。

> 早期文档写的是「把 index.js 粘进 Cloudflare 编辑器」，那是 2025 年的做法，
> 现在只有一个 1.9 万行的单文件，别再粘贴了——用 `wrangler deploy`。

**部署后怎么确认跑的是哪一版**：`curl https://你的域名/version` 会回
`{"ok":true,"version":"20261119-2140","built":"2026-11-19T13:40:12Z","commit":"a1b2c3d","ray":"..."}`
（`/version` 不要口令）。`commit` 只有 CI 部署时才有值——本机部署时手动带上：
`npx wrangler deploy --var APP_VERSION:"$(date -u +%Y%m%d-%H%M)" --var APP_BUILT:"$(date -u +%FT%TZ)" --var APP_COMMIT:"$(git rev-parse --short HEAD)"`。

**出问题看日志**（不用登 Cloudflare 后台）：

```bash
cd backend
npx wrangler tail                      # 实时看请求与异常，Ctrl+C 退出
npx wrangler tail --status error       # 只看 5xx
npx wrangler tail --format pretty      # 带表格线，人看着舒服些
```

`wrangler.toml` 里已开 `[observability] enabled = true`（采样 10%），
所以也能在 Cloudflare 后台 Workers → 你的 Worker → Logs 里翻最近 3 天的请求；
不想用或嫌占免费额度就把它改成 `enabled = false`。
另外后端自己会把 5xx 写进 `error_log` 表（界面：报表 → 数据体检 → 🐞 运行日志），
留最近 90 天；定时任务出错也会写进去（以前只 `console.error`，线上没人看得见）。

### 1.5 设口令（第一次进去要设）

打开 Worker 的网址（或小程序）第一次会要你设一个**老板口令**（接口 `POST /auth/setup`），
设完会给你一个 4 段恢复码，**抄下来存好**（忘了口令只能靠它）。

口令在库里存的是 `s1$<salt>$<sha256>`，不是明文；老账本里的明文口令会在**下次登录成功时自动升级**，用户无感。同一个 IP 15 分钟内错 10 次会锁 10 分钟（`auth_fails` 表），锁定期内正确口令也进不来——急着进去走恢复码重设，那条路自带 8 次/10 分钟的限制、不受 IP 锁影响。

员工口令在「设置 → 员工口令」里开（`POST /auth/staff`），员工登录后看不到钱（见 README 268）。

**员工账号（一人一个 PIN）**：`staff_users.pin` 也不再存明文，改成 `pin_hash = sha256(staff_salt|sp|PIN)`，登录按哈希查（全局盐，才能按口令直接索引到人）。老库里的明文 PIN 会在**第一次有人用它登录时自动迁移**，迁移完 `pin` 列只剩 `'@'+id` 占位符。所以：新建账号 / 重设口令时返回的 4 位数字**只显示这一次**，列表里只显示「口令已设」；员工忘了就点「换个口令」重设一个。

**响应 ETag**：GET 的 JSON/HTML（≤256KB）都会带 `ETag`，客户端带 `if-none-match` 且对得上就回 304。小程序 `wx.request` 不发这个头，行为不变；浏览器打开打印页/对账单才省流量。`/backup` 这种大响应不打 ETag。

⚠️ **Cloudflare 会摘掉 ETag**：只要响应被压缩（br/gzip），CF 就把 `ETag` 删掉，线上看起来像没生效（本地 workerd 压缩后仍保留，所以本地测不出来）。打印页因此加了 `Cache-Control: no-cache, no-transform` 禁压缩——这些页面只有几 KB，重复打开时 304 比压缩省。JSON 接口维持压缩，其 ETag 在线上会被摘掉。

**D1 读复制（read replication）默认关闭**，理由和开启方法写在 `backend/wrangler.toml` 的注释里：开了之后「刚记完一笔就刷新」可能读到滞后副本，人会以为没存进去再记一遍。要开必须同时改造成 Sessions API（`env.DB.withSession('first-primary')`）。

### 1.6 前端（微信小程序）

1. 微信开发者工具导入 `frontend` 目录。
2. 把 `frontend/pages/index/index.js` 顶部 `API_BASE` 改成你的 Worker 地址。
3. 微信公众平台 → 开发管理 → 服务器域名，把该域名加进 **request 合法域名**（必须 https）。
4. 本地调试时可勾「不校验合法域名」。

---

## 2. 升级一套已经在用的账本

1. `git pull` 或把新代码放进来，先跑 `node scripts/check.mjs`。
2. 如果这一版动过表结构（`backend/schema.sql` 有变化），补灌一次：
   `npx wrangler d1 execute factory-db --remote --file=schema.sql`
   —— 只补缺的表/索引，已有表和数据不动。
3. `npx wrangler deploy`（或推 main 走 CI）。
4. 进去点「报表 → 数据自检」（面板里那条 `GET /schema-check`，界面上叫「数据自检」）：三本账缺哪张表、缺哪一列都会列出来。
5. 顺手点一次「报表 → 备份全部数据」（`POST /cloud-backup`），再看「🔍 查一下备份能不能用」（`GET /backup-verify`）：
   它会告诉你这份备份覆盖多少张表、哪些表按设计不进备份（以及原因）、有没有哪张表被漏登记。

> 有一部分列是**运行时兜底**建的（`ensureMonthCols()` 补 `month` 列和触发器、
> `ensureBaseTables()` 补那 11 张老表），所以老库即使不补灌 schema 也不会当场崩；
> 但补灌一次更干净，数据自检也就绿了。
>
> **本机版 / Docker 不用手动补灌**：`server/d1.mjs` 启动时会按 `schema.sql` 对一遍每条表，
> 缺的列自己 `ALTER TABLE ADD COLUMN`（启动日志会打「老库补上 N 个列」）。
> 这是 2026-11-21 补的——在那之前，老库（几个月前的 `data/`）升级后会直接
> `启动失败：Error: no such column: month`，看起来像文件坏了。

---

## 2.5 可选：把单据照片搬到 R2（省 D1 存储与读行数）

单据照片默认以 base64 存在 D1 的 `attachments.b64` 里（单张上限约 650KB）。照片多了以后 D1 存储和「读行数」都会涨，可以改存对象存储：

1. Cloudflare 后台 → R2 → **Enable R2**（当前账号还没开通，`wrangler r2 bucket list` 会返回 `Please enable R2 through the Cloudflare Dashboard.`）；
2. 建桶：`npx wrangler r2 bucket create factory-attach`；
3. `wrangler.toml` 里加上：

   ```toml
   [[r2_buckets]]
   binding = "ATTACH"
   bucket_name = "factory-attach"
   ```

4. `npx wrangler deploy`。

代码是**可选绑定**：有 `ATTACH` 就走 R2（D1 只存 `attachments.r2_key`），没有就照旧存 D1；取回接口返回的仍是 base64，小程序端不用改。老照片不会自动搬（要搬得写一次性脚本；线上附件目前是 0 张，暂时没做）。

## 3. 备份与恢复（别等出事才看）

- **备份在哪**：`backups` 表，每天 cron 自动存一份，保留最近 30 份；`GET /backup` 可当场导出一份 JSON。
- **备份了什么**：46 张表（账目、客户、材料、工钱、外协、返工、待摊、银行流水…），标 `version: 3`。
  单份备份超过 900KB 会自动切成几片存进 `backup_parts`（D1 单行上限 2MB），取回时自动拼回来，用起来感觉不到。
  另有 14 张表**按设计不进备份**（附件照片、月度报表 xlsx、员工口令、试错计数、运行日志…），`/backup-verify` 会把它们和原因一起列出来。
- **什么不进备份、为什么**：图片（`attachments`）、月报 xlsx（`month_report`）、员工 PIN（`staff_users`）、
  审计流水（`audit_log`）、报错与慢接口日志、备份自己（`backups`）、去重标记（`op_dedupe`）、
  小程序试用额度（`wx_users`）。`GET /backup-verify` 会把这张清单**原样列给用户看**。
- **恢复**：`POST /backup-restore` + `{id}`，会先要一次 `confirm:1` 确认，恢复前自动再存一份快照。
- **D1 单行上限 2MB**：备份超过 1.5MB 时 `/backup-verify` 会提醒，建议按月导出留档。
- **备份读不出来就报失败**：某张表读失败时 `/backup` 会直接返回 500 并说清是哪几张表，
  **不会再生成一份「少了半本账却说成功」的文件**；带 `failed` 标记的旧备份也会被拒绝恢复
  （否则恢复会先 `DELETE` 再插 0 行，把那张表清空）。
- **恢复的最后一招：D1 时间点恢复（Time Travel，保留 30 天）**。库被误清空、误覆盖、
  或者备份本身就有问题的时候用这个，它不依赖我们自己的备份文件：

  ```bash
  cd backend
  # 1) 看这个时间点之前库里有多少数据（先确认再恢复，别一把梭）
  npx wrangler d1 time-travel info factory-db --timestamp "2026-11-18T00:00:00Z"
  # 2) 记下现在的 bookmark，万一恢复错了还能退回来
  npx wrangler d1 time-travel info factory-db
  # 3) 恢复到某个时间点
  npx wrangler d1 time-travel restore factory-db --timestamp "2026-11-18T00:00:00Z"
  # 4) 恢复错了？用上一步记下的 bookmark 退回来
  npx wrangler d1 time-travel restore factory-db --bookmark "<上一步的 bookmark>"
  ```

  三个账套要分别对 `factory-db` / `factory-db2` / `factory-db3` 各做一次。
  时间点用 UTC（北京时间减 8 小时）。

---

## 4. 不装 Cloudflare：跑在自己电脑上（免安装 exe / Docker 镜像）

不想开 Cloudflare 账号也能用。两种跑法用的是**同一份后端**，只把 D1 换成了本机 SQLite 文件
（`server/d1.mjs`），账目规则、备份、导出、打印页都在。

### 4.1 免安装 exe（Windows 最省事）

1. 打开仓库的 **Releases** 页，下载 `factory-accounting-windows-x64.exe`（90.9 MB；Linux 是 `factory-accounting-linux-x64` 122.3 MB，macOS 是 `factory-accounting-macos-arm64` 117.2 MB，只出 Apple 芯片）。
2. 双击。浏览器会自己打开 `http://127.0.0.1:8787`。
3. 页面上设一个口令（小程序里要输的那个），**把显示的恢复码抄下来**。
4. 数据在 exe 旁边的 `data/book1.db`。拷走 `data/` 就是备份，换电脑拷回来接着用。

命令行用法（想换端口/只给本机访问）：

```bash
factory-accounting-windows-x64.exe --port 8788 --host 127.0.0.1 --data D:\factory-data
```

macOS / Linux 一样，先 `chmod +x`；macOS 若提示「无法验证开发者」，右键 → 打开，
或 `xattr -d com.apple.quarantine <文件>`。

**手机小程序连上来**：手机和电脑同一个 Wi-Fi，把 `frontend/pages/index/index.js` 顶部的
`API_BASE` 改成 `http://<电脑IP>:8787`（IP 在启动窗口和落地页上都写着）。
正式发布的小程序要在微信后台把该域名加进 request 合法域名——局域网 IP 过不了审核，
所以**本机版适合自己/车间内部用**，对外发布还是走 Cloudflare 那套。

### 4.2 Docker 镜像（服务器 / 群晖 / NAS）—— 推荐用仓库里的 compose

仓库根目录有 `docker-compose.yml`，已经写好端口、数据挂载、健康检查、日志轮转和版本号，
不需要改就能起：

```bash
mkdir -p ./data
docker compose up -d
docker compose logs -f        # 看启动日志，Ctrl-C 退出
```

打开 `http://<这台机器IP>:8787` → 设老板口令 → 抄下恢复码。数据在 `./data`
（启动时自动建 `book1.db` … `book9.db` 九本，和线上一样最多 9 本账；只用到第 1 本的话别管另外 8 个文件）。

日常运维：

```bash
docker compose pull && docker compose up -d     # 升级到新版本
tar czf backup-$(date +%F).tgz data/            # 备份（更稳的做法：先 docker compose stop）
docker compose down                             # 停
```

容器**自带四条定时任务**（每天备份/体检/记账兜底、每周一汇总、每月 1 号报表包），
不用你在宿主机上再配 crontab；时间按 `TZ=Asia/Shanghai` 算。

不想用 compose 的话，一行 `docker run` 等价写法：

```bash
docker run -d --name factory -p 8787:8787 -v "$PWD/data:/data" \
  --restart unless-stopped ghcr.io/tel9980/factory-accounting:latest
```

- 数据在卷 `factory-data` 里（容器内 `/data`）。
- 支持 `linux/amd64` 和 `linux/arm64`（群晖 ARM 机型也行）；v1.0.0 多架构 digest `sha256:644744fdafb766cdf51a32a7d4f628382ab6293ca9566727e3b91cee88ad42ac`。
- `docker pull` 若报无权限：`echo <PAT> | docker login ghcr.io -u tel9980 --password-stdin`（PAT 勾 `read:packages`）。
- 想接笔记站同步：`-e NOTES_BASE=https://... -e NOTES_SLUG=... -e NOTES_PASS=...`。
- 升级：`docker pull` 新镜像后删掉旧容器重建（卷不删，数据不动）。启动时会自动补新表、新列。
- 看日志：`docker logs factory`；健康状态：`docker inspect --format '{{.State.Health.Status}}' factory`。

### 4.3 自己打一个（改了代码想立刻验证）

```bash
cd backend && npm install && cd ..   # 需要 Node 24（node:sqlite 是内置模块）；装完回仓库根
node scripts/build-exe.mjs --out dist
```

> ⚠️ `scripts/` 在仓库根目录：`cd backend` 之后跑 `node scripts/build-exe.mjs` 必然
> `Cannot find module`。以前这两处文档都是那样写的（第 16 轮 C4 修）。

脚本会 esbuild 打包 → 生成 SEA blob（`schema.sql` 作为资源塞进去）→ postject 注入 →
**自己跑一遍自测**（`/version` 版本号、落地页、建库 60 张表），不通就报错退出。
macOS 上会自己处理代码签名（先去掉签名，注入完再 ad-hoc 签）。

### 4.4 本机版的注意事项

- **没有网页版记账界面**：落地页只做「看状态 / 设口令 / 下载完整备份」，记账仍然用小程序。
- **别把 `data/` 放进网盘同步目录**（OneDrive / 坚果云 / iCloud）。SQLite 有 WAL 日志，
  边写边同步容易把库同步坏。要备份就用落地页的「下载完整备份」，或定时把 `data/` 拷出来。
- 本机版**照样跑那 4 条 cron**（每日维护 / 固定支出摊销预提折旧 / 每周一汇总 / 每月 1 号报表包），
  按 UTC 到点就触发，错过（关机、睡眠）下次起来补一次；`--no-cron` 可以关掉
  （关了之后固定支出/摊销/预提/折旧要手动点）。
- 多账套照样能用（`book1.db` … `book9.db`，最多 9 本），口令各管各的。

---

## 5. 过微信审核（第一次提审被「登录受限 3.3」驳回过）

被驳原文：「存在登录受限问题，违反《微信小程序平台运营规范常见拒绝情形 3.3》」，
详情：「【口令】无法完整体验功能，请在提审页面填写有效账号及密码或上传小程序完整功能截图、
录屏运行协助完成」。

原因很直白：小程序一打开就是「请输入访问口令」，审核员没有口令，进不去，也就判断不了这东西能不能用。

### 4.9 电脑上填表（客户多的时候）

浏览器打开 `https://你的域名/pc`（不需要口令就能打开页面，页面里的动作才要口令）：
填一次口令 → 下载模板（客户/供应商名字已经预填好）→ 用 Excel 填 → 选文件「先看看要导什么」→ 确认导入。
这条路径不经过小程序，70 多个客户的月度对账在电脑上做最省事。

### 4.8 网页上管人与权限（`/pc` 第 7 块）

手机小程序里「设置 → 员工账号」能做的事，电脑上也能做（客户多、人多的时候更顺手）：打开 `https://<你的域名>/pc`，填口令，滚到第 7 块「人员与权限」。

| 要做的事 | 在网页上点哪里 |
| --- | --- |
| 看现在有谁 | 「看员工账号」（表格：名字 / 口令 / 能做什么 / 状态） |
| 加一个人 | 「7.1 加一个人」填名字，口令留空就自动生成 4 位，勾上他要用的模块，点「加这个员工」 |
| 换口令 | 那一行的「换口令」（新口令只显示这一次） |
| 改权限 | 那一行的「改权限」→ 勾选 →「保存权限」 |
| 暂时不让他进 | 那一行的「停用」（再点「启用」恢复，他记的账不动） |
| 彻底删掉 | 那一行的「删」（同样不删账） |
| 员工只看自己录的单 | 顶部勾「员工只能看自己录的单」→「保存这两项」 |
| 员工只看自己负责的客户 | 顶部勾「员工只能看自己负责的客户」→「保存这两项」（分客户在「设置 → 客户分给员工」） |

模块权限就六类：**应收（开单、收款）、应付（进货、付款）、支出与流水、批量导入、单位与对账、家底（账户、设备、发票）**。员工永远不能删改单据、看不到毛利和金额类分析——这是代码层面挡的，不是靠勾选。

命令行等价写法（排查或写脚本时用）：

```bash
K=你的老板口令
# 看有谁
curl -s -H "x-access-key: $K" https://<你的域名>/staff-users
# 加一个只开应收的员工（pin 不传就自动生成）
curl -s -H "x-access-key: $K" -H "content-type: application/json" \
  -d '{"name":"小王","mods":["ar"]}' https://<你的域名>/staff-users
# 改他的权限 / 停用 / 换口令
curl -s -H "x-access-key: $K" -H "content-type: application/json" \
  -d '{"mods":["ar","ap"]}' https://<你的域名>/staff-users/2
curl -s -H "x-access-key: $K" -H "content-type: application/json" -d '{"active":0}' https://<你的域名>/staff-users/2
# 两个总开关
curl -s -H "x-access-key: $K" -H "content-type: application/json" \
  -d '{"modules":["ar","ap","exp","import","contact","asset"],"self_only":true,"scope":"own"}' https://<你的域名>/staff-perms
```

两点容易误会：

- **员工账号按账套分开**：第 7 块列的是「当前账套」的人。要在二厂加人，先把上面的账套切到第 2 本，再加一次。同一个人可以只在某一本账里有账号；同一串 4 位口令在两本账里也可以各是一个人（各记各的名字）。「只看自己负责的客户」同样按账套分（`party_staff` 在各账套自己的库里）。
- 从旧版本升上来：**原来那批员工只在主账套有效**，二厂 / 三厂要重新加（那两本账原来没有员工表，第一条登录时会自动建）。
- **管理员和员工是两套东西**：管理员（老板 / 超级 / 每本账的管理员）能看全部；员工只有上面那些模块，且默认看不到钱。

### 4.13 超级管理员与每账套的管理员

两层口令：

| 口令 | 存在哪 | 能做什么 |
| --- | --- | --- |
| 主账套老板口令 | 主账套 `settings.access_key` | 进**所有**账套都是老板权限（老行为，不变） |
| 超级口令（至少 6 位） | 主账套 `settings.super_key`（哈希） | 进任何账套都是老板权限，**并且**能给别的账套设管理员口令 |
| 账套自己的管理员口令 | 那本账自己的 `settings.access_key` | 只能进那一本账 |

设置办法：

```bash
# 设 / 改（key 用主账套老板口令，或现有超级口令）
curl -X POST https://jz.qy663.de5.net/auth/super \
  -H 'content-type: application/json' \
  -d '{"key":"主账套口令","password":"超级口令至少6位"}'

# 关掉（空串）
curl -X POST https://jz.qy663.de5.net/auth/super -H 'content-type: application/json' -d '{"key":"主账套口令","password":""}'

# 给第 2 本账设它自己的管理员口令（要用超级口令）
curl -X POST https://jz.qy663.de5.net/book-admin-key \
  -H 'content-type: application/json' -H 'x-access-key: 超级口令' \
  -d '{"book":2,"password":"二厂口令"}'
```

也可以全在网页上点：`/pc` → 第 6 块「6.1 超级管理员」设超级口令；「看我的账套」表格里每行有「设管理员口令」（用超级口令登录时才显示）。

注意：**主账套口令永远能进所有账套**（否则老板要记三把）。想让某本账彻底独立，就给它设自己的管理员口令，并且不要把那把主口令告诉用那本账的人。

### 4.12 多账套（一本账 = 一个数据库，最多 9 本）

默认开 3 本（`DB` / `DB2` / `DB3`），小程序顶上「当前账套」和电脑 `/pc` 第 6 块都能切。想多开一本：

```bash
npx wrangler d1 create factory-db4          # 记下回来的 database_id
# 在 backend/wrangler.toml 里复制一段 [[d1_databases]]，改 binding = "DB4"、database_name = "factory-db4"、database_id = 新的
npx wrangler d1 execute factory-db4 --remote --file=schema.sql
cd backend && ./node_modules/.bin/wrangler deploy
```

部署完 `/pc` 第 6 块「看我的账套」里就会多出第 4 本；`DB5`…`DB9` 同理（代码不用改，`BOOK_MAX = 9`）。

**在电脑上管理账套**：`/pc` → 第 6 块「看我的账套」→ 每行有「改名」「用这本」。改名只需要当前账套的老板口令；**切到某一本后如果要导出/导入/初始化/看报表，得填那一本自己的口令**（每本账的口令是独立的，这是故意的：一本给别人看，一本自己用）。

### 4.11 报表存档（日报 / 月报 / 年报 / 应收 / 应付 / 明细账 / 科目余额表）

电脑打开 `/pc`，第 5 块选类型 → 填日期/月份/年份/区间 → 「下载 Excel」：

| 类型 | 参数 | 里面有什么 |
|---|---|---|
| 日报 | 某一天 | 当天收付合计、每笔明细、按科目小计、按账户小计 |
| 月报 | 某个月 | 总览 / 利润表 / 资产负债表 / 应收明细 / 应付明细 / 收付流水 / 账龄 / 应收到期表（8 张） |
| 年报 | 某一年 | 12 个月汇总 + 全年合计、年末余额（按 12-31 算）、年末应收/应付、客户与供应商年度榜 |
| 应收台账 | — | 每张未结清的单（含逾期天数、账龄档）+ 按客户汇总 |
| 应付台账 | — | 同上，按供应商 |
| 明细账 | 区间 | 按科目分页签：期初 → 逐笔（收/付/结余）→ 小计 |
| 科目余额表 | 区间 | 每科目期初 / 本期收 / 本期付 / 期末 + 余额类科目 + 本年逐月 |

命令行也能拿：`curl -H "x-access-key: 口令" "https://jz.qy663.de5.net/archive-pack?kind=monthly&month=2026-11"`（返回 base64 xlsx）。
建议：每月结完账存一份月报、年底存一份年报，和整账套 JSON 放同一个文件夹。

### 4.10 换公司 / 想从头再来

同一个浏览器打开 `/pc`，第 4 块「整账套」：

| 想做什么 | 怎么做 |
|---|---|
| 留个底、换电脑 | 选账套 → 「导出这本账（下载 JSON）」，得到 `factory-book1-2026-11-21.json`；到新电脑/新账套上「导入到这本账」 |
| 换公司、账目全清 | 输入「清空」两个字 → 「一键初始化」：单据/流水/客户/材料/工资/备份/照片全清，账户和分类回默认，**口令和账本名保留**；清空前自动备份一份 |
| 只是想换个名字重来 | 小程序「设置 → 账套」里改成新公司名即可，数据不用动 |
| 两家公司的账要同时留着 | 用账套二/账套三（三本账互相看不见），别清空 |

导入会先自动备份当前数据，再整本覆盖；`/book-reset` 只有老板口令能调，演示口令一律 403。

同一个站点还有一页 **`/guide`**：把 `docs/新手教程.md` 编译成网页（免口令、可打印），`/pc` 页面右上角有链接。
改完教程记得跑一次 `node scripts/gen-guide.mjs`（CI 会校验 `backend/guide.js` 是否最新）。

### 4.14 报表口径的几条硬规则（改报表前先看这段）

- **「某一天还剩多少」一律走 `arApLeftAt(db, ymd, 'ar'|'ap')` 和 `debtLeftAt(db, ymd)`**
  （`backend/index.js` 里，报表存档之前）。不能用 `orders.paid / written_off` ——
  那两列是「今天」的累计值，拿它算去年年底余额，每年重打一次年报数字就变小一次、永远不可复现。
- **借款余额 = `SUM(debts.principal) − debt_repays(kind='principal')`**。`debts` 表里
  没有 `amount / repayed` 两列（曾经写错过，报错被 `.catch` 吞掉，表现为「科目余额表的借款余额恒为 0」）。
- **经营收付不含内部转账与税点**：`ref_type NOT IN ('transfer','tax_ar','tax_ap')`。
  代收/代付的税点单独一行；账户现金余额（`cash=1`）是含税点和转账的真实现金。
- **账龄按到期日**（没填到期日才用开单日），五档：30 天内 / 31-60 / 61-90 / 91-180 / 180 以上；
  坏账准备 = 61-90×10% + 91-180×30% + 180 以上×50%，只在这一个地方算。
- **「截至今天或更晚」= 账本上现有的全部**（`asOfEff()` / `uptoMonth()`）。这样处理的理由：
  有人把年份打成 2062 这种未来日期，如果按日期一刀切，首页家底算它、月报和科目余额表不算它，
  两处就差一整笔，而且谁也说不清差在哪。
- **税额只算「有票」的行**（`inv_state='yes'`）。没票/没标票的税额不算销项/进项，
  单独放在 `/tax-summary` 的 `tax_no_sales`、`tax_no_buy` 里并在页面上写明「抵不了」——
  以前把没票的税额算进进项，页面下面又写着「没票不能抵税」，两句话互相打脸。
- **流水页的收付合计只算动现金的行**（`COALESCE(cash,1)=1`）。摊销、折旧、预收款抵扣、
  报销冲借支都是 `cash=0` 的账本分录，它们出现在列表里（标「不动现金」），但不进合计，
  另有 `no_cash_text` 一句话说明这部分有多少。以前不分，流水页合计比首页的「本月收/付」多一大截。
- **同一件事的两个说法必须相等，而且有测试钉住**：`scripts/test-numbers.mjs` 会把
  首页 / 应收汇总 / 分类卡 / 账龄表 / 科目余额表 / 月报包 / 月度归档 / 报表页 / 流水页
  十几个「同一个数字」摆在一起比，差一分钱就红。改报表口径时先跑它，别只跑冒烟。
- **`/archive-json` 与 `/archive-pack` 同源**：同一个 `archiveSheets()`，一个给行列、一个给 xlsx。
  想让网页/小程序直接看表，用前者；想让人下载存档，用后者。改了一处就是两处一起改。

### 4.15 应收分类（钱是从哪来的）

应付分类回答「钱花在哪」（`AP_CATS`：硫酸、染料、外发加工费…），应收分类回答「钱从哪来」，
两套名单**故意分开**——混在一起会出现「这个月硫酸收进来多少」这种没意义的行。

- **名单在哪改**：`backend/index.js` 的 `const AR_CATS = ['货款','加工费','打样费','模具费','运费代垫','包装代垫','维修费','其他']`，
  改完要同步前端 `frontend/pages/index/index.js` 里 `data.ar_cats`（录单 chips 用它）。两边不一致时以数据库里存的原值为准，不会报错，只是 chips 少一项。
- **别写法**：`AR_ALIAS` 一张小映射表（「代垫运费」→ 运费代垫、「开模费」→ 模具费、「样品费」→ 打样费…），认不出就原样存，**不拦**。
- **一个字段全家桶**：`orders.ar_cat`；`POST /orders`、`PATCH /orders/:id`（会进「改了什么都记下来」）、`fmtOrder`、`/ar`、`/ar?cat=`、
  `/ar-by-category`、应收对账模板第 5 列、整包导入、粘贴解析都读它。
- **口径**：`/ar-by-category` 的「本月开单」按 `orders.month`，「本月已收」按 `ledger.month + ref_type='order'`，
  「还欠」是**当前**未结（不分月份，跟单据列表一致）。
- **备份恢复别漏列**：`restoreCore()` 的 orders `INSERT` 是一列一列写死的，加新列（`ar_cat`、`tax_*`、
  `inv_state`、`created_by`…）时必须同时加进那份清单，否则备份/恢复、`/import-all` 覆盖之后这一列全丢、且不报错。
  `scripts/test-arcat.mjs` 里有一条「备份 → 恢复 → 分类还在」专门盯这个。

### 4.16 员工「只看自己的」到底管哪几处

两个开关（`/staff-perms` 的 `scope` 与 `self_only`）现在覆盖：

| 位置 | `scope='own'`（只看自己负责的客户） | `self_only`（只看自己录的单） |
| --- | --- | --- |
| `/ar`、`/ap` 列表 | ✅ | ✅ |
| `/ar-summary`（顶部汇总 + 大客户榜） | ✅ | ✅ |
| `/ar-by-category`、`/ap-by-category` | ✅ | ✅ |
| `/aging` 账龄 | ✅ | —（员工本来就没这个入口） |
| `/report`、`/dashboard` 这些老板报表 | 员工进不去（`denyStaff`） | — |

口径要求：**顶部数字必须等于列表能看到的那些单之和**。改这几处时先 `await partyStaffTable(db)`
（那张表是懒建的，新库上不建就 `no such table: party_staff`，查询直接 500），并且 D1 的 `.bind()`
返回对象**不能再 `.bind()`**（本地 miniflare 会报 `st.bind is not a function`）——要追加参数就一次拼齐再 bind。
`scripts/test-staff.mjs` 第 [7] 组专门验「两种模式下顶部数字与列表笔数一致」。

### 4.17 员工 / 演示身份能做什么（白名单，不是黑名单）

改权限之前先看这条规则：**员工能写的动作走白名单（`STAFF_WRITE_OK`），其余一律 403。**

以前是反过来的——一长串「不许……」的正则，每加一个接口都要记得补一条。结果是每轮都能查出漏网的：
`POST /transfer`（当时只拦了复数 `/transfers`）、`/export`（只拦了 `/export-all`）、`/archive-json`（新接口）、
`/bank-flows/:id/unmatch`（撤销流水认领）、`/collect-config`（催款口径）、`/target`（目标）、
`/networth-snapshot`（写家底存档）、`/term-default` `/term-auto`（批量改客户账期）、`/run-fixed`、
`/onboarding/apply`、`/wx-test`。页面上什么都没露，员工 4 位 PIN 就能改掉全厂的口径。
另外 `GET /trash`（别人的单据）、`/tax-summary`、`/audit-logs`、`/month-archives`（家底月月快照）、
`/report-link`（直接生成含毛利的报表链接）、`/party-staff`（客户归属）也都该关，一并关了。

**白名单里有什么**（员工记账本身需要的动作）：

| 做什么 | 接口 |
|---|---|
| 开单 / 收款 | `POST /orders`、`/orders/:id/receive`、`/orders/:id/status`、`/receive-batch`、`/quick` |
| 进货 / 付款 | `POST /payables`、`/payables/:id/pay`、`/pay-batch` |
| 支出 / 借支 | `POST /expenses`、`/advances`、`/loans`、`/loans/:id/return`、`/loans/:id/reimburse` |
| 导入 | `POST /import`、`/import-rows`、`/import-xlsx`、`/import-pack`、`/parse-import`、`/detect-import` |
| 对账 / 催款 | `POST /reconcile`、`/recon-confirm`、`/pipeline-summary`、`/statement-log(+ack/resolve)`、`/party-terms(+apply)`、`/dunning-log`、`/profiles` |
| 车间 / 家底登记 | `POST /materials`、`/material-moves`、`/frame-prices`、`/outsource(+back)`、`/rework`、`/invoices`、`/attachments` |
| 改单申请 | `POST /edit-request`、`/edit-requests/:id/cancel`（改单本身要老板批） |
| 只读批量 | `POST /batch` |

**新加接口默认是关的**：加完记得想两件事——① 员工要不要用？要用就补进 `STAFF_WRITE_OK`；
② 老板要不要看？要就把读取路径从 `denyStaff` 的 GET 名单里放出来。`scripts/test-perm.mjs` 会把
源码里所有写接口逐个用员工口令打一遍，白名单外没 403 就红——忘了想权限它会提醒你。

演示口令另外一套：**能看账、不能碰系统**。`/error-log`、`/slow-log`、`/selfcheck`、`/books`、
`/books-check`、`/audit-logs`、`/party-staff` 全部 403（里面有内部表名、报错原文、别本账的应收合计）；
导出/备份/改账套/初始化一律 403。内置演示（`demo-look`）只能进第 3 本账，`demo_seeded=1` 时才允许试记，
那本账里一旦有真数据就立刻退回只读。


### 4.18 加一列之后，恢复备份要不要跟着改？

**不用了。** 以前 `restoreCore()` 恢复应收/应付/流水时是手写列清单，加列必须回来补一次，
漏了就「恢复成功但那一列变默认值」——`no_invoice`、`delivered_at`、`tax_*`、`created_by`、`ar_cat`
全这么丢过，接口还回 `ok`。现在恢复走 `PRAGMA table_info` 取真表结构、与备份里有的字段取交集动态拼，
和家底那几十张表一直是同一个写法。

改恢复逻辑时只要守住两条：

1. **别把 `month` 忘掉**：老备份没有这一列（以前靠触发器补），恢复时按 `created_at` 补；
2. **口令类键继续跳过**（`BACKUP_SETTINGS_SKIP`）：`access_key` / `staff_key` / `sign_secret` / 封存状态
   不跟着备份走，否则一份备份发出去就把口令也带出去了。

`scripts/test-restore.mjs` 会把备份、一键初始化、恢复之后每一张表每一行的每一列逐一比一遍
（现在 65 项）。它已经抓到过一个真陷阱：**一键初始化会把之前的备份全删掉**——用户昨天特意备份的
一份，今天点「一键初始化」就没了。现在一份都不删，只靠 `saveBackup` 之后保留最近 30 份。

### 4.19 老备份（几个月前导出的包）还能恢复吗

能，而且有回归测试钉着（`scripts/test-oldbackup.mjs`，58 项）。三种老包都验过：

| 包的样子 | 谁导出的 | 结果 |
| --- | --- | --- |
| 顶层平铺 `orders/payables/ledger/...`，`version: 1` 或 `2` | 早期「云端备份」 | `POST /restore` 能恢复 |
| `{kind:'factory-accounting-full', tables:{...}, v:1}` | 早期「导出整库」 | `POST /import-all` 能恢复 |
| 只有 `orders/payables/ledger`，连 `settings` 都没有 | 手工裁过的包 | 能恢复，口令/账户沿用现在的 |

恢复时按 `created_at` 把 `month` 补上（老包没这一列），新列（`ar_cat`/`tax_*`/`inv_state`）留空，
所以**老账的分类会落在「未分类」、税表是 0** —— 这是数据本来就没有，不是恢复丢了。

两条容易踩的：

1. **`/restore` 拒绝坏包时回 400 `restore_rejected`**（以前误回 200 + `ok:true`，调用方会以为恢复成功）；
2. **整库导入保 14 个本机设置键**（`KEEP_SET_IMPORT`）：`access_key`/`staff_key`/`super_key`/`demo_key`/
   `book_name`/`modules_off`/封存状态等。从别的机器导出的包里没有这些键，以前导入一次就把超级口令、
   演示入口、账本名全冲掉，而且一声不吭。

### 4.20 三本账之间会不会串？（备份 / 恢复 / 导出 / 设置）

三本账各是一个 D1 数据库，**备份 id 是每本账自己从 1 数的**——第 1 本的 `#5` 和第 2 本的 `#5`
是两份完全不同的账。界面上两本都叫「回到某一天」，所以最容易出的一种串账是：

> 在第 1 本看过备份列表 → 切到第 2 本 → 点还留在屏幕上的那一行「恢复」 → 恢复的是第 2 本的 `#5`，
> 数据完全不是你想的那份，界面还显示「回来了」。

现在的做法：

| 动作 | 现在的行为 |
| --- | --- |
| `/backup-list` | 每一行都带 `book`（账套号） |
| `/backup-timeline` | 顶层带 `book` |
| `/backup-restore` | 收 `{id, confirm, book}`；`book` 和当前账套对不上 → `409 {code:'book_mismatch'}`，一句也不动账 |
| 不带 `book` 的调用 | 照旧能用（向后兼容） |
| `/export-all` | 包上带 `book_id`（账本名可能两本重名，号才是身份） |
| 小程序切账套 | 顺手清掉备份列表 / 备份体检 / 「最近备份时间」 |

**把 A 的整库包导进 B，B 的设置不会被 A 带走**——`book_name`、`modules_off`、`demo_key`、
`demo_builtin_off`、`super_key`、`access_key`、`sign_secret`、封存状态 这些「这台机器自己的」键，
`/restore` 和 `/import-all` 都不认包里的同名值。所以「换公司」「搬家」「多厂共用一套代码」时
可以放心互相导，导入的只是账目，不是身份。

笔记站备份（`/backup-to-notes`）也按账套分开了：第 1 本沿用老 slug `factory-ledger-backup`，
第 2 本起是 `factory-ledger-backup-book2`、`-book3`。以前 slug 写死一个，第 2 本同步一次就把
第 1 本那篇盖掉，笔记站上看不出被换过。

回归：`node scripts/test-bookiso.mjs --base http://127.0.0.1:8791 --key 8888`（38 项，已挂 CI）。

### 4.21 两个人同时点同一笔，会不会记两遍？

会——这一轮之前会。典型场景：厂长和会计都在催同一笔尾款，两个人几乎同时点「收清」；
或者弱网下手机连点两下；或者 `/pc` 网页和小程序同时提交同一份表。

现在有三层保证，**从下往上依次是**：

1. **每条 SQL 自带条件**（最靠得住的一层）。收款是
   `UPDATE orders SET paid = paid + ? WHERE id = ? AND paid + COALESCE(written_off,0) + ? <= price + 0.005`，
   流水那条用同样的条件 `INSERT ... SELECT ... WHERE (...)`，两条捆在一个 `db.batch` 里。
   谁先把金额占满，第二个请求影响 0 行 → 回 `409 {code:'stale'}`，页面提示「刷新再看一眼」。
   `/payables/:id/pay`、两条 `writeoff`、`/loans/:id/return`、`/debts/:id/repay`、
   `/bank-flows/:id/unmatch`（先占位再退钱）都是这个套路。
2. **`client_id` 先占坑**。前端每笔操作带一个 `client_id`，后端 `opClaim()` 用
   `INSERT OR IGNORE INTO op_dedupe (client_id, ...)` 抢坑：抢到才往下走，抢不到直接回
   `{ok:true, dup_ok:true}`（页面显示「这笔刚记过了」，`200` 不是错误，离线队列会把它清掉）。
   干完 `opMark()` 把坑标成真单号，失败 `opRelease()` 放坑；**占坑超过 60 秒没标完的**（进程被杀了）
   下次来先清掉，免得用户永远被「刚记过了」挡住。
3. **防重用 `INSERT ... WHERE NOT EXISTS (...)`**。`/orders`（同客户同额 2 分钟内）、
   `/payables`（7 天内）、`/expenses`（同日同分类同额）以前是「先查再写」，中间那点缝
   两个请求都能过；现在条件写进 `INSERT` 本身，写不进去才回 409。

回归：`node scripts/test-concurrency.mjs --base http://127.0.0.1:8791 --key 8888`（67 项，已挂 CI）。

> ⚠️ **一个反直觉的坑**：本地 `wrangler dev` 经常把请求串行化，把这些闸门全删掉测试**照样全绿**。
> 所以别信「测试过了就是并发安全」——真正的保证是第 1 层。测试里专门有一组「静态护栏」，
> 直接读源码断言那些 SQL 条件片段还在（19 条），谁清理代码时删掉了就红。

#### 4.21.1 写「一个 batch 里好几句」的时候，必须按「哪句生效了」逐条退

这是本项目踩过两次的坑，值得单独写一段，因为它的失败方式极隐蔽。

一个 `db.batch([改单, 扣预收, 写流水])` 是**一起跑**的，不是「一句成了一句跟着成」。输的
那一家：第一句（改单）影响 0 行，**后面几句照样会执行**。如果后面那句的闸门写的是
「现在这个值 == 老值 + 本次数量」，那么赢的那一家刚刚把值改成这个数，输的这一家的闸门
**正好成立** → 流水真的插进去了，而它前面那句没生效。于是账上多一条流水、单据金额却没变。

实测（四人同时用预收抵扣 500）：单据只收 500，流水四条共 2000。借支退回同构
（两人同时退 500，`returned` 只加 500，流水两条共 1000）。

写法要求（`apply-advance` 与 `/loans/:id/return` 已经是这样）：

```js
const done = await db.batch(stmts)
const won = changesOf(done[0]) > 0                       // 主表那句到底成没成
const bad = parts.filter((q, i) => !changesOf(done[i + 1])) // 关联那几句成没成
if (!won || bad.length) {
  const lid = num(done[stmts.length - 1]?.meta?.last_row_id) // 自己插的那条流水的 id
  const fix = []
  if (lid > 0) fix.push(db.prepare('DELETE FROM ledger WHERE id=? AND ref_type=? AND ref_id=?').bind(lid, RT, id))
  if (won) fix.push(db.prepare('UPDATE orders SET paid = MAX(0, COALESCE(paid,0) - ?) WHERE id=?').bind(total, id))
  if (fix.length) await db.batch(fix)                   // 退干净，再回 409
  return c.json({ error: '…刚被别人用掉了，刷新再看一眼', code: 'stale' }, 409)
}
```

三条规矩：

- **回滚必须发生在 return 之前**。旧代码 `if (!changesOf(done[0])) return 409` 在第一句就
  return 了，后面那个 `badAdv` 判断永远不会执行——这就是这个 bug 活了这么久的原因。
- **删流水要按 `meta.last_row_id` 删自己那一条**，不要「按单号 + 金额找最新一条」：并发下
  那会删掉别人刚插的。
- **关联那几句也要能各自退**（自己真扣过的预收/借支，`used = MAX(0, used - 本次)`）。

同一个思路也用在「同一个文件不重复入账」上：`/import-pack` 的 `packf_` 与 `/bank-import`
的 `bankf_` 以前是「先 `SELECT settings` 看导过没有 → 导 → 写指纹」，两个窗口同时点都读到
「没导过」，同一份表导两遍。现在改成 `INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)`
先占坑（`settings.key` 是主键，天然原子），抢不到就回 `dup_file`；一行都没导进去、或者插到
一半炸了，就把坑 `DELETE` 放开，别让用户被自己挡住。

### 4.22 网不好时记的账（离线队列）会不会丢？

前端的离线队列存在 `pending_ops`（`wx.setStorageSync`），断网时 `enqueueOp()` 把请求连
`client_id` 一起存下来，联网后 `flushPending()` 按入队顺序逐条补发。

判成功只有两种：**2xx 且 body 不是 `ok:false`**（包括 `{ok:true, dup_ok:true}`——那说明
后端按 `client_id` 认出来已经记过了，同样算成功）。其余一律**留在队列里**，并给出原因：

| 响应 | 处理 | 为什么 |
|---|---|---|
| 2xx `ok:true`（含 `dup_ok`） | 出队 | 记上了 |
| 2xx `ok:false` | 留队 + 服务端原话 | 日期不对这类，服务端明确没记 |
| 400/403/409 | 留队 + 原因 | 规则驳回（重复、已结账锁定、金额被改过） |
| 401 | **立刻停**，当前及后面原样留队（不标错） | 只是要重新登录；逐条试会把每条都标成「口令错误」 |
| 5xx / 断网 | 当前及后面整段留队 | 服务器/网络的事，不是这笔的问题 |

三条容易踩的细节：

1. **补发途中用户又记了一笔**（网刚回来最常见）：`finish()` 只覆盖「快照之前」的部分，
   快照之后新追加的原样保留（用 `uid` 区分）。以前直接拿快照覆盖，那笔就静默消失了。
2. **顺序不乱**：结果按原下标放在 `slot[]` 里再 `filter(Boolean)`，失败的不会跳到队头。
3. **没补上的有出口**：点「待补 N 笔」→「先不发」→「最早那笔要不要丢掉？」→ 确认才丢
   （文案明说「丢掉就是彻底不要这笔」）。否则参数错的那条会永远挂着。

回归：`node scripts/test-offline.mjs`（40 项，纯离线假 wx，11 组场景，已挂 `deploy.yml` 与 `release.yml`）。

> ⚠️ **写这类测试的坑**：假 `wx.getStorageSync` 如果直接返回数组引用，「补发途中新记了一笔」
> 这个场景永远测不出来——真机 storage 是「序列化再读回来」的，假实现必须 `JSON.parse(JSON.stringify(...))`。

### 4.23 几 MB 的 Excel 传不上去怎么办（切片上传）

70 多家客户的对账表攒一个月就是几百 KB 到几 MB。手机端的导入一直是「整个文件转 base64，
塞一个 `wx.request`」——3MB 的 xlsx 转出来是 4MB，弱网下超时是常态，而**超时之后用户不知道
到底导进去没有**，再点一次就可能导两遍。

现在超过 **900KB** 走切片：每片 70 万字符，客户端一片片传，服务端拼回来。

| 端点 | 作用 | 关键返回 |
|---|---|---|
| `POST /upload-start` | 开会话 | `{ok, id, part:700000, ttl_min:120, max_parts:400}` |
| `POST /upload-part` | 传第 `seq` 片（同一片重传=覆盖） | `{ok, seq, got:[0,1,2]}` |
| `GET /upload-state?id=` | 看已收到哪几片（断点续传用） | `{ok, parts, done, got}` |
| `POST /upload-finish` | 拼装并校验长度 | `{ok, size, parts}` |

拿到 `id` 之后，`/import-pack` 和 `/import-xlsx` 都可以传 `{upload_id: id}` 代替 `{b64}`；
**不传 `upload_id` 就还是老行为**（老版本小程序不用升级也能用）。

三种以前会「静默坏掉」的情况现在都明确拒绝：

| 情况 | 返回 | 为什么必须拒绝 |
|---|---|---|
| 片数不够 | 409 `upload_incomplete`（「已收 2/3」） | 拼出来是半个文件 |
| 片数够但片号不连续（0 和 2） | 409 `upload_gap` | 数量对得上，拼出来是坏文件，只会报「读不了这个 Excel」 |
| 长度和 `size` 不符 | 409 `upload_size` | 同上 |
| `upload_id` 不存在/过期 | 410 `no_upload` | 不能混成「没有收到文件内容」 |

其它约定：单个文件上限 14MB、会话 120 分钟有效、过期会话与孤儿分片由定时任务清理；
`uploads` / `upload_parts` 不进备份、`/book-reset` 会清掉；演示口令调 `/upload-*` 一律 403。

命令行自测（本机没有 curl 时用 node）：

```bash
node -e "
const B='https://jz.qy663.de5.net', H={'X-Access-Key':'你的口令','content-type':'application/json'}
const c=async(m,p,b)=>(await fetch(B+p,{method:m,headers:H,body:b&&JSON.stringify(b)})).json()
c('POST','/upload-start',{name:'a.xlsx',size:100,parts:1}).then(r=>console.log(r))
"
```

回归：`node scripts/test-upload.mjs`（42 项，含 3.4MB 分 5 片拼回来的实测，已挂 `deploy.yml`）。

### 4.24 一个人管账 + 模板：名字别手打、错在哪要说清、导错了能整批撤

日常用法就一句：「下载模板 → 填 → 传」。这条链路上有三个地方会持续吃人的时间，
而且**出错的时候都不报错**——只是名字对不上、改不完、退不回去。

**一、模板里的名字是下拉，不是空白**

`GET /import-template-pack?tpl=daily&fill=1` 会把手上有的名字先填成下拉：

| 页签 | 列 | 候选值来自 |
|---|---|---|
| 应收对账 / 期初应收 | A（客户名） | 应收单里的客户 + 客户档案 |
| 应付对账 / 期初应付 | A（供应商名） | 应付单里的供应商 |
| 借支 / 报销 | A（员工） | 借支记录 + 员工账号（在职） + 计件工资里的工人 |
| 支出 | D（经手人） | 同上 |
| 支出 / 报销 / 应付 | 分类列 | 支出分类表 / 应付分类表 |

响应里的 `fills: {customers, suppliers, staffs}` 是三个实际条数，可以拿来核对。

两个坑，改代码时注意：

- **Excel 下拉整串上限 255 字符**。名字一多就会超，超了 Excel 直接说「文件已损坏」。
  所以所有下拉都过 `fitDvList(list, 250)`（按累计长度截断，不是按条数）。
- **`fill=1` 也会把客户名按「一家一行」预填进对账/期初页**（没有金额的行当「还没填」，导入时跳过）。
  别把这条规则加到借支/报销页上，那两页是一笔一行，没有「预填」的概念。

**二、预览把「哪里错了」一次说完**

`POST /import-pack {dry:true}` 每页除老的 `errors`（前 3 条字符串，保留兼容）之外，还会给：

| 字段 | 内容 |
|---|---|
| `error_rows` | 最多 200 条：`{row, error, party, amount, date}` |
| `error_more` | 还有多少条没列出来 |
| `dup_rows` / `dup_more` | 像重复的行（默认不导），跟「写错了」分开 |

「这个月已结账」的行也在 `error_rows` 里，`error` 直接写「这个月已结账，导不进去」。

**三、导错了能整批撤**（`POST /import-undo/:id`）

能撤的六类：应收 `ar`/`ar_init`、应付 `ap`/`ap_init`、支出 `expense`、借支 `loan`、
**报销 `reimb`**、**付房东 `prepaid`**。`/import-log` 每行有 `can_undo`，界面只在这批真能撤时出按钮。

| 撤什么 | 必须一起退回去的 |
|---|---|
| 报销 | 删那条报销流水 + **把借支的 `used` 减回去**（只删流水，员工余额就永远对不上） |
| 付房东 | 删预付单 + 删它摊出来的摊销流水（`ref_type='amort'`），否则成本凭空留着 |

撤不掉的情况都明确拒绝，不装成功：已结账月份 → `deleted 0 / skipped 1` + 理由；
撤第二次 → 400「已经撤回过」；不支持的类型 → 400 并列出能撤的六类。

命令行自测：

```bash
node scripts/test-template-fill.mjs     # 27 项：下拉落在哪一列、串长 ≤255、fill=0 时全空
node scripts/test-preview.mjs           # 25 项：5 行全错给 5 条、300 行错给 200 条 + 「还有 100 行」
node scripts/test-undo.mjs              # 41 项：报销撤回退借支、付房东撤回删摊销、锁月撤不掉
```

（三个都在 `deploy.yml` 里，紧跟在 `test-pack` 之后。）

真正需要传几十 MB（比如三五年的流水）时，让用户在电脑上打开 `https://<你的域名>/pc`——
浏览器直传、断了自己重试，比手机上稳得多。

### 4.25 导入前先试算：这批进去之后，账会变成多少

预览以前只回答「能不能导」，不回答「导了会怎样」。用户真正怕的是那个「会怎样」——
现金会不会莫名少两万、应收会不会翻倍。等他导完再去首页看已经晚了（要退只能逐批撤）。
现在 `POST /import-pack {dry:true}` 的响应里多一个 `impact`：

```json
{
  "before":  {"cash": 12800, "ar": 128000, "ap": 40000, "loan": 3000, "debt": 0, "net_worth": 118800},
  "after":   {"cash": 21400, "ar": 119400, "ap": 40000, "loan": 3000, "debt": 0, "net_worth": 119400},
  "delta":   {"cash": 8600, "ar": -8600, "ap": 0, "loan": 0, "debt": 0, "net_worth": 600},
  "rows":    [{"sheet":"应收对账","type":"ar_recon","type_name":"应收对账模板","count":7,"amount":8600,"cash":8600,"ar":-8600,"ap":0,"loan":0,"debt":0}],
  "notes":   ["应收会少 ¥8,600（¥128,000 → ¥119,400）", "现金会进来 ¥8,600（¥12,800 → ¥21,400）"],
  "warn":    [],
  "text":    "现金 ¥12,800 → ¥21,400；应收 ¥128,000 → ¥119,400；应付 ¥40,000 → ¥40,000"
}
```

**「现在」这一组数字必须跟首页/账户页同一个口径**，否则试算就是个骗人的数字。取法：

| 项 | 怎么来的 |
|---|---|
| 现金 `cash` | `accountBalances(db)` 的 `balance` 求和（含未指定账户的流水） |
| 应收 `ar` / 应付 `ap` | `arApLeftAt(db, today, 'ar' \| 'ap').t`（只算还欠着的单） |
| 员工借支 `loan` | `SUM(MAX(amount - used - returned, 0)) FROM loans` |
| 借款 `debt` | `debtLeftAt(db, today)` |
| 净资产 `net_worth` | 现金 + 应收 − 应付 − 借款 |

**每一种导入的钱走向**（`packImpact()` 里的模拟必须跟 `importRows()` 的实际写入一致）：

| 类型 | 现金 | 应收 | 应付 | 借支 | 别的 |
|---|---|---|---|---|---|
| 应收 / 期初应收 / 应收对账 | — | +金额 | — | — | 只加欠款 |
| 应付 / 期初应付 / 应付对账 | — | — | +金额 | — | 只加欠款 |
| 支出 | −金额 | — | — | — | |
| 借支 | −金额 | — | — | +金额 | 钱从手上去到员工手上 |
| 期初借支 `loan_open` | — | — | — | +金额 | 只挂账，现金早就在外面了 |
| 报销 | 只减「冲不完的那部分」 | — | — | −冲掉的金额 | **先冲这个人手上的借支，冲完才发现金** |
| 付房东 | −金额 | — | — | — | 之后按月摊进成本（押金不摊） |
| 期初借款 `debt_open` | — | — | — | — | 借款 +金额 |
| 账户期初 `acc_open` | 新值 − 旧值 | — | — | — | **是「设成」不是「加上」** |
| 客户名单 / 默认账期 | 不动钱 | | | | 只动档案 / 设置 |

**会主动警告的情况**（`warn`，界面上红字）：

- 按这批算完现金是负数 → 「要么金额打错了，要么这笔钱其实早就付过了」
- 应收 / 应付 / 借支会变成负数 → 多半是重复导了一次收付款，或员工名字打错了

**四条改代码时必须守住的规矩**：

1. **试算和真导必须是同一个模型。** 加了新的导入类型，`packImpact()` 里就要有对应的一行，
   否则试算会说「不变」而真导会让数字变——这比没有试算更坏。`scripts/test-impact.mjs`
   每一组都是「先试算 → 再真导 → 比实际变化」，对不上就红。
2. **报销别写成「全额发现金」。** 员工手上还挂着借支时，报销是先冲借支（不动现金），
   冲不完的才走现金。写成全额现金，试算就会说「现金要出去 800」而实际只出去 400。
3. **账户期初的 delta 是「新值 − 旧值」**，不是金额本身。反复导同一个期初不该翻倍。
4. **`acc_open` 要按账户名对**（`accounts.name`），报表里的账户名允许重名的话要先归一。

界面：`/pc` 上是「项目｜现在｜导完｜变化」四列表格，现金减少标红；小程序预览页是
「🧮 这批进去之后（只是试算，还没写库）」一张卡，只列现金 / 应收 / 应付 / 净资产 四行 + 说明。

单类型上传（`POST /import-xlsx {preview:true}`）也返回 `impact`，老的 `rows` / `text` 字段没动。

回归：

```bash
node scripts/test-impact.mjs            # 54 项，已挂 deploy.yml（紧跟 test-preview）
```

写这个测试时踩到的坑：**支出类在「同一天 + 同分类 + 同金额」会被当成重复挡掉**
（防手抖重复导入），所以测试里的支出金额必须带一点随机偏移，否则第二遍跑就变成「0 行能导」。

### 4.26 那些「不报错、就是账慢慢不对」的坑（改代码前必看）

这一批问题的共同点是：**程序不崩、接口 200、界面也没红字**，错误只体现在数字上，等你发现时已经错了一个月。下面每一条都在代码里钉了断言（`scripts/test-fixes1.mjs`），改动碰到就会红。

| 现象 | 以前为什么错 | 现在怎么保证 |
| --- | --- | --- |
| 写「收张老板5000」，客户欠款反而多一笔 | `/quick` 里 `if (/收/.test(s))` 走的是「新建应收单」（`paid=0`），而提示语叫「应收 张老板 5000 元」 | 文案改成「新开一张应收单：…（欠款变成 X）」；这个客户原来就欠着钱时给 `warn` 指路「点那张单 → 💰收钱」 |
| 补录上个月的纸质单，全进了本月，而且「那个月已结账」也没拦住 | 行里没写日期 → 日期就是 `todayIso()`，月份锁按这个日期判 | 预览返回 `no_date_count` + 「N 行没写日期、会记成今天」+ `warn`；**不阻止导入**，只是显式提醒 |
| 12 月能往 11 月塞预收款 | `/advances` 的月锁用「今天」的月份 | 改成按单据日期：`const aMonth = String(normDate(date) || now()).slice(0, 7)` |
| 银行账单换个导出区间重导一遍，收款翻倍 | 查重只认「同一个文件」的指纹，`9/1–10/31` 与 `9/1–11/30` 是两个指纹 | 逐行按「日期 + 收付 + 金额 + 摘要」跟**库里已有流水**比（不跟同一份文件内比，连着刷两笔一样都得进） |
| 这个月赚了 0 —— 其实是算不出来 | `/dashboard` 各块 `.catch(() => null)`，错了只是少一块；前端从没读 `degraded` | 首页红条「有 N 块没算出来，数字可能偏小」；后端 `noteQuiet()` 落一条 `error_log`（`path='degraded'`，10 分钟最多一条） |
| 出 500 不知道是哪一笔 | `error_log` 只有路径，同路径挂着多个写接口 | 记 `cf-ray` / `ref`（`?ref=` / `?client_id=`）/ `params`；`/error-log` 支持 `days`(≤90) / `limit`(≤300) / `offset` / `kw` / `status=500\|quiet\|4xx` |
| 手机上找不到「一键初始化」 | 只有电脑 `/pc` 上有 | 设置页两个按钮（保留员工 / 不保留），两道确认 + 手打「清空」 |
| 45 天现金流卡显示 `¥undefined` | 两张卡抢同一个 `data.cf` | 拆成 `cfl`（45 天）与 `cf`（14 天） |
| 「1.2万」被记成 1.2 元 | 收款面板用 `replace(/[^\d.]/g,'')` | 走 `toAmount()`，认「1.2万」「8,000」 |
| 多账套下 `/pc` 导入静默进第 1 本 | 模板下载/预览/导入四个请求没带 `X-Book` | 四处补齐（旁边 `/export-all` 等本来就带） |

**改这一带的规矩**：

1. 「能导但会记错」的情况**一律不许静默**——要么挡住并说清，要么放进 `warn` / `no_date_count` 这类字段让界面显示出来。
2. 月结锁判的是**这张单自己的日期**，不是今天。任何「按当前月份判锁」的写法都是 bug。
3. 查重分两层：**文件指纹**（同一份文件）挡手抖连点，**逐行内容比对**（日期+方向+金额+摘要）挡换区间重导。两层都要有。
4. 统计出错不许变成 0 而没人知道：`degraded` 必须在界面上可见，并且落日志。

```bash
node scripts/test-fixes1.mjs     # 51 项，已挂 deploy.yml（紧跟切片上传）
node scripts/test-preview.mjs    # 28 项，含「没写日期要说清」
```

### 4.27 「净利」到底减了什么（改利润公式前必看）

全项目有 **三处** 算净利，必须同时改，否则首页、月报、归档快照会各说各的数：

| 位置 | 谁在用 | 代码 |
| --- | --- | --- |
| `monthPL(db, mm)` | `/month-brief`（一句话汇报）、六个月趋势、`/cash-bridge` | `backend/index.js` 的 `async function monthPL` |
| `monthSnapshot(db, mm)` | 月结归档快照（`/month-end`、`/month-archive*`、报表以快照为准） | `async function monthSnapshot` |
| `/dashboard` 的 `aggSql` + `profit_biz` | 首页「本月净利」 | `app.get('/dashboard'` |

**公式（三处必须一样）**：

```
净利 = 本月接单额
     − 单子上填的材料·外协成本 (orders.cost)
     − 现金支出（工资水电房租等，经营口径）
     − 摊销 − 折旧 − 预提利息
     − 坏账核销（writeoffs 本月金额）      ← 2026-11-21 补上的
```

为什么要减坏账核销：核销是把「确认收不回来的应收」划掉，家底（现金 + 应收 − 应付 − 借款）立刻少一块。
以前利润里不减，于是「这个月赚了 3 万、家底却少了 5 千」永远查不出来。核销**不动现金**，所以：

- 现金流表（`/cashflow`、`/flows`）里它不出现；
- 「钱去哪了」（`/cash-bridge`）里那一行 `wo` 金额固定为 **0**，标签写「核销（不走现金，已算进上面的净利）」——
  因为利润已经减了一次（`wo_ar − wo_ap`），而「应收变动」那一行（`-dAR`，含 `+woAr`）又会把它加回来，
  两下相抵正好等于「核销不动现金」。**如果你以后把 `wo` 那行改回 `-(woAr-woAp)`，残差会凭空多出这一笔。**
  （第 15 轮重写了整张表：17 行 + 兜底行，另见 4.45。）

另外两处「数字会悄悄偏」的地方（也在 `test-fixes2` 里钉住）：

- **导入判重只认「同一天」**（`importRows` 四类：应收 / 应付 / 支出 / 借支，以及 `previewImport` 里同一套规则）。
  以前是「同客户同价 ±7 天」，老张天天来一单 500 的加工费，第二单起被**静默吞掉**。
  改这条时预览和真导必须一起改 —— 两边各写一份、口径不一致，用户就会看到「预览说能导 3 行，导完只进 1 行」。
- **材料成本可能算两遍**：单子上填了材料成本，同时又记「材料」类现金支出。系统不自动改数，
  只由 `monthPL` 返回 `mat_buy` 与 `cost_hint`，`/month-brief` 把提示放进一句话汇报里。

```bash
node scripts/test-fixes2.mjs     # 28 项，已挂 deploy.yml（紧跟切片上传之后）
```

### 4.28 加列、修写接口、备份说明这三件事的硬规矩

**一、给 `backend/schema.sql` 里已有的表加列，必须同时进 `EXTRA_COLS`。**
线上 D1 全是老库：`CREATE TABLE IF NOT EXISTS` 遇到已存在的表整句跳过，「后来加的列」永远补不上，
代码一查就是 `no such column` → 整个接口 500。补列只靠 `backend/index.js` 里那张 `EXTRA_COLS`
（本机版另有一套：`server/d1.mjs` 的 `completeColumns()` 直接解析 `schema.sql`，所以本机不会漏）。

漏了会怎样（真实历史）：

| 漏的列 | 现象 |
| --- | --- |
| `orders.deliver_date` / `orders.created_by` | 老库上「预计交付日」「员工只看自己录的单」一查就 500 |
| `error_log.ray` | 出 500 时定位不到是哪一次请求 |

所以 `node scripts/check.mjs` 现在会查两件事（见 `[4.7]`）：

1. `EXTRA_COLS` 点名的表和列，`schema.sql` 里必须真的有（防手滑写错名）；
2. 拿 `scripts/schema-baseline.json`（**发布过的列快照**）对比，这次新加的列如果不在 `EXTRA_COLS` 里 → **直接红**。

改完加列的步骤：

```bash
# 1) 改 backend/schema.sql（新列写进建表语句）
# 2) 把同一列加进 backend/index.js 的 EXTRA_COLS（老库靠它补）
# 3) 跑自检（会红，提示你哪张表的新列没登记）
node scripts/check.mjs
# 4) 全绿之后刷新基线（此后这一列才算「已发布」）
node scripts/check.mjs --update-baseline
```

**二、新写接口要有人真跑过，否则「CI 全绿」是错觉。**
`check.mjs` 的 `[5.6]` 会把 195 个写接口和 `scripts/*.mjs` 全文比对，列出「从没被任何脚本调用过」的名字
（warn 不拦——有些确实只能人工验）。当前覆盖 **180/195**。加写接口时顺手在某个测试里打一次，
尤其是**动钱**的：设备处置（`/assets/:id/dispose` 会写 `ref_type='dispose'` 的现金流水）、
设备折旧（`/assets/run-depreciation`）、计件扣款（`/wage-deducts`）。

**三、备份要说清「哪些东西不在里面」。**
`BACKUP_SKIP` 里每一项都有理由，其中两项容易被误解：

- `attachments`：单据照片是图片本体，一张几百 KB；
- `month_report`：月度报表存档是 xlsx 本体（base64）。

它们**不在备份里**，恢复不回来。所以 `/backup`、`/backup-verify` 都带 `notice`
（`BACKUP_NOTICE`），`/book-reset`（一键初始化）的返回文案里也明说「照片和月报存档恢复不回来」。
加新的 skip 项时，把原因写进 `BACKUP_SKIP` 的第二列——`/backup-verify` 会把原因原样显示给用户。

```bash
node scripts/test-fixes3.mjs     # 29 项：设备买→折旧→维修→处置、计件扣款、对账保存/差异、交接备注、备份 notice
```

### 5.0 最省事：什么都不用配（内置演示入口）

登录页有一行 **「👀 先看看演示（不用口令，示例数据）」**——审核员点它就直接进演示账套
（第 3 本账，第一次进自动种一批示例数据：几个客户、几张单、应付、日常支出、材料进料），
可以随便记一笔试试，**碰不到你的真账本**；导出/备份/改设置这些照旧不给。

**连口令都还没设过的新装库，这一行也在**（审核不允许「必须先设口令才能看到东西」，见 4.40）。

所以提审时备注写一句就够：**「打开小程序点『先看看演示』即可完整体验，不需要口令。」**

审核过了，如果不想让任何人点进来，小程序里 **设置 → 单位·账户·设置 →
「👀 内置演示入口：开着（点这里关掉）」** 点一下即可关闭（关掉后登录页不再显示那一行）。

> ⚠️ 演示账套用的是**第 3 个库**（绑定名 `DB3` = `factory-db3`）。
> 走 CI 部署的话不用管：`deploy.yml` 在部署前会跑 `node scripts/d1-seed-schema.mjs`，
> 把 `wrangler.toml` 里**每一本账**的表结构都补齐（幂等，跑在有数据的库上也不丢东西）。
> 手动部署 / 新开一本账时，自己补一条（只灌一次，也可以在任意时候重跑）：
>
> ```bash
> npx wrangler d1 execute factory-db3 --remote --file=schema.sql
> ```
>
> 没绑 `DB3` 的部署也能用，只是登录页不显示那一行演示按钮。

### 5.1 需要「能看不能改」的只读口令时（给客户看账、不给他试）

小程序里：**设置 → 单位·账户·设置 → 🎬 设演示口令（审核 / 试用）**，填一个至少 4 位的口令
（不能和老板口令、员工口令一样；留空确定 = 关闭）。

拿到这个口令的人：

- **能看**：所有页面、所有数字（和老板看到的一样）；
- **不能改**：任何写操作一律 403 `演示口令只能看，不能改账、不能导出`；
- **不能导走**：`/backup`、`/backup-verify`、`/export-all`、`/staff-users`、`/schema-check` 这些也拦着；
- 进来时顶部有蓝条「👀 演示模式（只能看，不能改账）」，点一下换回自己的口令。

不想一直开着，审完到同一个按钮里清空即可（立即失效）。

### 5.2 提交审核时这样填

微信公众平台 → **管理 → 版本管理 → 提交审核**：

| 表单项 | 填什么 |
| --- | --- |
| 测试账号 | 随便填，比如 `老板`（这套系统只有口令、没有账号名） |
| 测试密码 | **演示口令**（最稳）；想省事也可以填老板口令，但那是全权 |
| 备注 / 补充说明 | `打开小程序会弹口令输入框，请在上面「测试密码」里填的口令进入；另有只读演示模式，数据可随意浏览。` |
| 功能页面 / 截图 | 建议顺手把「工作台 / 应收 / 报表」三张截图传上去，审核员看得更快 |

如果还是被驳，就补**录屏**（30–60 秒足够）：打开小程序 → 输口令 → 记一笔应收 → 收一笔钱 →
点「报表」看这个月。录屏要点只有一条：**从启动到核心流程一镜到底**，别剪。

### 5.3 自己先验一遍（提审前 1 分钟）

```bash
# 换到演示口令，看能不能进、能不能写
curl -s -H 'x-access-key: 你的演示口令' https://jz.qy663.de5.net/me
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'x-access-key: 你的演示口令' \
  -H 'content-type: application/json' -d '{"customer":"越权测试","price":1}' \
  https://jz.qy663.de5.net/orders      # 必须是 403
```

（本机有 `scripts/test-demo.mjs`，走一遍就是 34 项断言：`node scripts/test-demo.mjs --base http://127.0.0.1:8791 --key 8888`）

---

## 推送遇到 TLS 报错（本机代理问题）

如果 `git push` 报 `GnuTLS recv error (-110)`、`Error in the HTTP2 framing layer` 或
`Failed to connect to github.com port 443 after ... ms`，是**直连**不稳，不是仓库问题。
这台机器上正确做法是**显式带上代理**（别用 `env -u` 去绕过）：

```bash
P=http://<你的代理地址>:<端口>      # 例：http://192.168.2.22:20172（作者本机的代理，别照抄）
git -c http.proxy=$P -c https.proxy=$P push origin main
```

> 第 16 轮 C9：这里原来写死了作者本机的内网代理地址，别人照抄只会连不上、还以为是仓库问题。
> 换成占位符；代理地址属于「每台机器自己的事」，不该进文档当命令。

反例（别再用）：`env -u http_proxy ... git push` 走直连，经常要重试十几次、每次卡两分钟。

### 4.29 家底（净资产）的口径改过一次，迁移前后数字会不一样

**公式（现在）**：

```
净资产 = 现金 + 应收 − 应付 − 借款 − 预收 + 预付
```

- **预收**（`advances.type='in'`，客户先打来的钱）= 我们还欠他货 → 负债 → 减。
- **预付**（`advances.type='out'`，先付给供应商的钱）= 他还欠我们货 → 资产 → 加。
- 剩余额一律按 `MAX(amount − used, 0)` 算，只认「还没用掉的那部分」；统一入口是 `advLeftAt(db, ymd)`。
- **已结清（`status='closed'`）的借款算 0**：以前 `debtLeftAt` 和 `netSeries` 的 `debtAtEnd` 都不看 status，
  用「结清」按钮还完的借款没有还款记录，于是这笔钱永远挂在家底里；而首页只算 `open`，
  两边差一整笔，越用越远。现在两处都跳过 closed。

**改口径的影响面（都同改过了，新增地方必须跟上）**：`netSeries`（`/networth`、首页家底、趋势）、
`/dashboard`、`/month-report`、月结归档 `monthSnapshot`、年报 `yearly`（年末余额页）、
`/archive-json?kind=trial` 的余额类科目、经营体检（`s.equity`）、`/cash-bridge` 的 `wo` 行、
试用算 `packImpact`。判断口径对不对，跑 `node scripts/test-numbers.mjs`（57 项）——
它会把首页、月度归档、科目余额表、月报包、报表页五处的净资产两两对比。

**升级到这一版之后会看到什么**：只要账上有预收/预付、或有「结清但没还款记录」的借款，
历史月份的家底曲线会整体平移一次（通常往上/往下几百到几万）。这不是数据被改了，
是原来没算进去的项现在算了；想留证据就先 `POST /networth-snapshot` 存一份当时的快照再升级。

### 4.30 「初始资料」整包：换系统第一天要搬的五类静态资料

`GET /import-template-pack?tpl=base` 给一个 6 页签的工作簿：

| 页签 | type | 列 | 说明 |
|---|---|---|---|
| 说明 | — | — | 怎么填 |
| 固定资产 | `asset` | 名称, 原值, 购入日(可空), 年限(可空=5), 残值率%(可空=5), 备注 | 进 `assets`，之后 `/assets/run-depreciation` 按月折旧 |
| 材料期初 | `material` | 材料名, 单位(可空), 数量, 单价, 日期(可空), 备注 | 写 `material_moves(kind='in')`，**只记库存不动现金** |
| 计件单价 | `wage_rate` | 工序, 单价, 单位(可空), 备注 | 进 `wage_rates`（`worker=''`＝通用工序价） |
| 信用额度 | `credit` | 客户, 额度, 备注(可空) | `ON CONFLICT(party) DO UPDATE`，**设成不是加上** |
| 框架价 | `frame` | 客户, 产品, 单价, 起始日(可空), 备注(可空) | 进 `frame_prices`，开单时提示「框架价偏低」 |

规矩：

1. **这五类不受月结锁限制**（`STATIC_IMPORT_TYPES`）——锁的是这个月的账，不是机器的出厂日期。
2. **重复导不会翻倍**：`asset` 按「名称+原值」、`material` 按「材料+日期+数量+单价」、
   `wage_rate` 按「工序+单价」、`frame` 按「客户+产品+单价」判重；`credit` 是覆盖。
3. 只动 `assets` / `materials` / `material_moves` / `wage_rates` / `credit_limits` / `frame_prices`，
   **不写 `ledger`、不改现金、不进家底**（机器早就买了，钱当年就付过了）。
4. 加新的初始资料类型，要同时改：`IMPORT_TEMPLATES`、`PACK_SHEET_TYPE`（页签名 → type）、
   `previewImport` 的解析分支、`importRows` 的分支、`STATIC_IMPORT_TYPES`（如果它不该被锁），
   最后 `node scripts/test-fixes4.mjs`（57 项）与 `node scripts/check.mjs`。

### 4.31 客户名候选、表单收起、备份异地副本（C21/C22/B10）

- `GET /party-pick?kw=&type=ar|ap&limit=`：客户/供应商名字候选，三段来源（精确 LIKE / 去掉
  「有限公司·公司·厂·店·门市部·经营部·括号」后近似 / `party_profiles` 档案），返回
  `{ok,type,kw,list:[{name,cnt,total,hit}]}`，`kw` 空时给「最近用过的」。前端开单输入 350ms 防抖调用。
- 应收页：开单表单默认收起（`o_open`），顶部是「＋ 记一笔应收」+ 常用客户 chips；
  预收 / 批量核销 / 催款清单收进 `ar_other`。改这块要注意：**记完一笔要把 `o_open` 收回 false**，
  否则表单一直占着屏幕、列表看不见。
- 备份：`scheduled` 现在每本账各推一份到笔记站（slug 带 `-bookN`，标题写明第几本）；
  `POST /backup-to-notes {all:true}` 手动全推；`GET /export-all?all=1` 一次导出所有账本
  （`kind:'factory-accounting-multi'`，`books:[{book_id, book, pkg}]`）。

### 4.32 性能 / 高效 / 便捷一轮的硬规矩（改后端并发和前端交互前先看这段）

- **别把「快慢接口」混着串行发**：这一轮把 `/collect-list`（删了废弃的 `pbP`）、`/customer-card`
  （`promiseBook` 必须传 `[party]`，别再为一家客户读全库三年）、`/tax-pack`（借款还欠改成
  一次 `GROUP BY debt_id`）、`/month-brief`（趋势 6 个月别再串行 5 次 `monthPL`）、
  `payrollOf` / `promiseBook` / `/month-report`（14 条）/ `/merge-summary`（每本账 5 条）/
  `healthScan` 尾部，全部改成 `Promise.all` 并发。以后再写「循环里发查询」先问一句：
  这几条有依赖吗？没有就并起来，D1 是「读多少行计费」，串行 = 多等一次往返还多读一遍。
- **两个索引不能删**：`idx_ledger_cash_dir ON ledger(cash, direction, ref_type)` 与
  `idx_writeoffs_month ON writeoffs(substr(created_at,1,7))` 已经写进 `schema.sql`（新装自带）+
  `ensureBaseTables`（老库部署后第一次请求自动补）。`accountBalances`（首页现金卡/月报/手机报表/
  本月一页纸都在复用）和 `monthPL`（利润口径）全靠它们，删了立刻回到全表扫。
- **`guide.js` 是懒加载，别改回顶层 import**：那 50KB 静态 HTML 原来 `import { GUIDE_HTML } from './guide.js'`
  写在第 2 行，每次冷启动 eager parse。现在是 `/guide` 处理器里 `await import('./guide.js')`。
  GUIDE_HTML 只有 `/guide` 一处用，别再挪到顶层。
- **DDL 记忆化只注册一次**：`ensureStaffTable` 等建表函数统一在文件底部 `_memoDdl(fn, tag)` 注册，
  不要在顶部再内联包一层（之前 `tag` 写错成 'stafftable' 和 'staff' 两个，包两层纯冗余）。
- **前端交互几个「别退回」**：①`goCollect` 必须 `setData({ar_view:'party'})`——「整户收款」按钮只在
  `ar_view=='party'` 渲染，不切过去 toast 会指向一个不存在的按钮；②支出搜索走 `loadExpenses` 的 `kw`
  下推后端（`/expenses` 支持 `kw`），别退回只在前端 filter；③`enterTab` 只拉当前 tab（loadAr 或 loadAp），
  别再两个都发；④工资加载 `/payroll` 与工资记录并行，别再等 payroll 回来才发第二条；⑤缓存要回收——
  `_cacheSweep` 在 onShow 里跑，`c_` 前缀缓存超 14 天自动删，别把 storage 越撑越大。
- **有意的两个暂缓（不是没做，是算过账）**：①`failBucket` 并发串台——Workers 没有 AsyncLocalStorage、
  `noteFail` 50+ 处内联没有 `c` 可传，逐处穿桶是大 diff，且只影响「降级日志归属」不碰账和钱，低严重度；
  ②SQL 口径抽常量（`ref_type NOT IN (...)` 57 处、`COALESCE(written_off,0)` 227 处）——片段已完全一致，
  抽 `${OP_REF}` 要逐处把双引号串转反引号，mass replace 一处漏转就语法错或 SQL 静默变，收益只是
  「将来改排除项少改几处」，暂缓。**这两条如果要动，先评估 diff 和回归成本，别顺手改。**
- **`scripts/run-all.mjs` 是全套回归的入口**：`node scripts/run-all.mjs --base <url> --key <口令>`，
  顺序跟 `.github/workflows/deploy.yml` 一致（离线五件套 + smoke + 29 个 test 脚本），失败不中断、
  最后列清单 exit 1。CI 里加新 test 脚本时，别忘在这里的 ONLINE 数组里也加一行，否则本地一把跑不全。


### 4.33 「本月赚了多少」只有一个答案（收付实现制）——改利润相关代码前必读

上一版里同一个问题有五个实现、两个口径：首页 `profit_biz`（权责，按开单算）、`/report-view` 的
`monthSum().net`（权责）、`/month-end` 的 `numbers.profit`（`monthPL().profit`，权责）、`/kpi` 的
`profit`（另一份 aggSql，权责）、首页 `month_profit`（现金，收 − 付）。实测同一月
**144,138.50 对 277,197.09，差 92%**，而且分别印在首页和报表/月结页——用户只能挑一个信。

**现在的硬规矩：**

- **「本月赚了多少」= 收付实现制 = 本月实际收到的钱 − 本月实际付出去的钱**，一句 SQL 口径：
  `SELECT SUM(amount) FROM ledger WHERE direction='in'|'out' AND cash=1 AND ref_type NOT IN ('transfer','tax_ar','tax_ap') AND month=?`。
  转账、代收代付的税点不算收入也不算支出。
- **唯一入口是 `monthPL()` 的 `cash_in` / `cash_out` / `profit_cash`**（`backend/index.js` 顶部）。
  新代码要这个数就取它，别再自己写一份 aggSql——这一轮之所以要收敛，就是因为「各写一份」。
- **权责口径的 `monthPL().profit` 一个字都不许动**：月报、月度归档、年报、现金流量表桥接那几处
  的标签本来写着「净利（权责）」，动了才是制造新错。要展示两套数时，两行并排、各自把标签写全
  （「净利（权责口径·含没收回来的）」vs「净利（收付实现制·收 − 付）」）。
- **`/cash-bridge` 的第一行必须留权责数**：那张表靠「权责净利 + 各项调整 = 现金变化」配平，
  换成现金口径残差永远对不上。同理 `packSheets` 的「利润表」页签保留两行。
- **`/month-brief` 的趋势柱必须和文案同源**：过去 5 个月用按月聚合的 `cash_in − cash_out`，
  当月直接复用 `cur.profit_cash`，别再单独跑一次 `monthPL`（上一版就是这样白跑 5 次 10 子查询）。
- **核销（`writeoffs`）不动现金口径的数**。它只减权责利润和家底。`test-fixes2` 已经钉住
  「核销前后现金口径利润不变、权责口径 −X」两条断言，改利润公式时这两条会先红。
- **写接口 / 列表接口里这两组字段不能删**：`delivered_at`（交付时间要显示）、`tax_net`/`gross_net`
  （含税/不含税要核对）、`rev`（乐观锁）、`month`（老备份补月要验）。`SLIM_DROP` 只允许放
  `created_by` / `import_batch` 这种确实没人读的列。

**补一条（这一轮 CI 抓回来的）**：换数据访问写法时，**本机版和线上是两套驱动，两边都要跑**。
`backend/index.js` 里改成 `db.batch([...SELECT...])` 之后，线上 D1 正常（batch 对 SELECT 也回
`results` 数组），但 `server/d1.mjs` 的 `batch` 原来一律走 `run()`、rows 全丢 —— 本机版备份出来
是 1 KB 空包，恢复直接报「这份备份里没有账目数据」。现在两边都改好：`server/d1.mjs` 按
`select/with/pragma/explain` 分流走 `all()`，`buildBackup` / `dumpAll` 再加一道断言
（batch 结果缺 `results` 就抛错退回逐表读）。**任何「读不到」都不能被当成「这张表是空的」**——
备份里少一张表，恢复时会先 DELETE 再插 0 行，整本账就被清空了。
改完的验证顺序：`node scripts/run-all.mjs --base <wrangler dev> --key ...`（线上语义）
**加上** `node server/main.mjs --port 8792 --data /tmp/fa-local --no-open --no-cron` +
`smoke.mjs` + `smoke-write.mjs`（本机语义），两边都绿再推。

### 4.34 电脑网页 `/pc` 的快捷面板（只动内嵌网页，不动账本）

`/pc` 第一块「口令」下面加了「★ 快捷面板」：填了口令就自动加载，一屏看本月收/付/剩、应收应付、逾期单数，并列出「该催谁」前 6 家（点「看话术」复制催款话术）；四个按钮分别是刷新、一键出本月月报 Excel、下应收到期表、下应付到期表。

它全部复用现成接口（`/dashboard`、`/collect-list`、`/archive-pack?kind=monthly`、`/due-schedule-xlsx`），**没加路由、没改后端账务逻辑**，所以：改这块不用碰小程序、不用灌库、不用改 `wrangler.toml`。要在电脑上更快干活，打开 `https://<你的域名>/pc` 直接用即可；小程序仍是随手记账的主入口。

接着 4.34：快捷面板底部又多了一块「月度对账」（近 60 天确认 / 有异议 / 本月没回音的家数 + 有异议清单），跟「该催谁」同一屏、点「刷新数据」一起更新。同样只动 `/pc` 内嵌网页、复用 `/statement-acks`，**没加路由、没动账本逻辑、不用重传小程序**。

### 4.35 多账套与权限的几处「静默」坑（改前必读）

这一轮四维审计修的都是**不报错、看着没事**的坑，其中两条以后改代码最容易再踩：

- **账套不能写死 `DB`/`DB2`/`DB3`**。仓库最多 9 本账（`wrangler.toml` 里加 `DB4…DB9` 即可，`bookDbs()` 自动枚举）。历史上有 4 处把三本写死（`handoverData`、`/merge-summary`、`/books-check` 的 defs 和 schema 检查），加 DB4 后这些接口还只认三本、静默丢第 4 本。现在统一走 `bookDbs(env)`，`scripts/check.mjs` [4.7] 会拦任何 `DB2`/`DB3` 字面量。**以后新增任何「遍历账套」的代码，一律用 `bookDbs()`，别写死。**
- **员工写接口白名单是单一事实源 `backend/perm-rules.mjs`**。后端权限中间件和 `scripts/test-perm.mjs` 都 import 它。改白名单只改这一个文件，改完两端同步；`check.mjs` [4.7] 会断言两边都 import 同一份。以前后端和测试各存一份，改线上忘改测试 → 测试全绿但线上权限已经错。**注意白名单默认关**：新写接口不加进去就是 403（关错顶多不方便，开错就是越权）；`/profiles` 就是这类越权口子，已从白名单移除（员工 PIN 曾能改客户 / 供应商档案）。
- **防重别再用「先查后记」**：`opSeen` → 干完 → `opMark` 挡不住并发双击（两个请求都查不到标记就各记一遍）。正确的姿势是 `opClaim` 先 `INSERT OR IGNORE` 占坑（唯一索引 `client_id` 保证只有一个能往下走），参数错 / 没单据 / 抛异常时 `opRelease` 放坑。`/receive-batch`、`/pay-batch`、`/payroll/pay` 已改，新增「按 `client_id` 幂等」的写接口照这个模板做。`opClaim` 失败时 `return true` 是**故意的 fail-open**：防重是安全网，库坏了宁让业务先走（真实写还有条件守卫兜底），别把它改成 fail-close。
- **缺 secret 必须让 CI 红**。`deploy.yml` 里缺 `CF_API_TOKEN` / `PROD_KEY` 现在都是 `::error` + `exit 1`，不再「warning 后继续绿」——否则部署被跳过 / 体检被跳过，CI 还显示成功，会误以为改动上线。配法见 1.4（Settings → Secrets and variables → Actions）。

### 4.36 测试防线与可观测性的硬规矩（改后端并发 / 加写接口 / 动 CI 清单前先读）

这一轮 12 条优化的主题是「改错的时候能更早发现」，其中几条规矩以后改代码会反复用到：

- **新增任何写接口，`check.mjs` [5.6] 会点名「没被脚本调用过」**。补齐覆盖的路子是 `scripts/test-write-coverage.mjs`：先造种子再打目标接口，断言「没 500 + `ok:true`」。种子端点签名见脚本内注释（订单/应付/借支/预付/账期/对账单/改单申请/外协/银行流水）。**别让一个写接口长期裸奔**——现在 195 个写接口 195 个都有脚本跑。
- **测试样板抽在 `scripts/_harness.mjs`**（`harness({tag})` → `arg/ok/no/yes/eq/near/call/post/wait/finish`）。**新测试脚本一律 import 它**，别再复制 arg/BASE/KEY/TAG 那 40 行。既有 36 个老脚本不迁（helper 签名已分化，强迁有「改错断言让它静默变绿」的风险）。
- **CI 清单是单一事实源 `run-all.mjs`**。它导出 `OFFLINE/ONLINE/CASES`，`scripts/check-manifest.mjs` 断言 run-all、deploy.yml、release.yml 三处一致——**新增测试脚本要同时改 run-all.mjs（`OFFLINE` 或 `ONLINE`）+ deploy.yml + release.yml 三处**，漏一处 `check-manifest` 就红（已挂在两个 workflow 的 check.mjs 之后）。自包含（不依赖 --base）的测试放 `OFFLINE`（如 test-book4 自己起本机版），依赖 wrangler dev 的放 `ONLINE`。
- **本月利润的「唯一答案」是收付实现制**，有 5 处实现（首页 `/dashboard`、`/profit-compare`、`/report-view`、`/month-end`、`/kpi`），口径都是 `ledger WHERE cash=1 AND ref_type NOT IN ('transfer','tax_ar','tax_ap')`。`test-profit-consistency.mjs` 用「塞 1000 收 + 300 支，断言 5 处都涨 700 且相等」钉住——**改任何一处的利润算法，先保证这个测试还绿**，否则五处会再分叉（4.33 那次就是这个坑）。
- **`ref_type NOT IN` 的排除名单只有两种标准**：`('transfer','tax_ar','tax_ap')`（排除内部转账和代垫税）和 `('loan','transfer')`（借支口径）。`check.mjs` [4.10] 会拦第三种名单。**改排除项要三处一起想**：语义上到底排谁、跟其它 66 处一不一致、check.mjs 会不会红。
- **文档表数 / 账套数是钉死的**：README 和 DEPLOYMENT 里「建 N 张表」必须 == `schema.sql` 的表数（check.mjs [4.9]）；`backend BOOK_MAX` 必须 == `server/books.mjs BOOKS`（check.mjs [4.11]）。**改 schema 加表、改账套上限，文档和两个常量要同步**，否则 check.mjs 红。
- **`node:async_hooks` 已在 `wrangler.toml` 开 `nodejs_compat`**。`failBucket` 用 `AsyncLocalStorage` 给每个请求独立桶，`noteFail(e,tag)` 通过 `als.getStore()` 拿当前请求桶。**别再退回模块级数组做「当前请求」状态**——单 isolate 多请求交错必串台；Workers 没有别的 TLS 机制，ALS + nodejs_compat 是正路。

### 4.54 第 24 轮（网页端第四轮）的八条硬规矩

1. **数字填错必须报错，不许「按原来的值保存还回 ok」**。`num(x, 默认值)` 这种写法等于把用户的输入悄悄丢掉：`PATCH /ledger/:id` 填「1000元整」会静默保存原值、`/loans/:id/reimburse` 填「三百」会按**全额**冲、空串会把账户期初改成 0。改金额、改期初、改税率、填报销，一律 `numStrict` + 明确错误码（`bad_amount` / `bad_opening` / `bad_tax`），并且回一句人话。门禁 `[4.29]`。
2. **查询失败不许变成「一切正常」**。这一轮抓到的都是同一类病：`closePrecheck` 六条 `.catch(() => ({ n: 0 }))` → 查询一挂就显示「七件事都办好了，可以结账」并把月份锁死；`netSeries` 七条吞错 → 家底偏大；`conclusionOf` 吞错 → 客户签字那页印「本期结清 ¥0」。规矩是：**失败要么整体返回 `null` 并让调用点给「这次没算出来」，要么带着 `checked:false` / `code:'degraded'` 上来**。门禁 `[4.30]`。
3. **永久快照里更不许吞错**。`month_archive`、`net_snapshots`、`backups` 这类「存下来以后再也看不出来源」的地方，算不全就**别存**（`snapNet` 现在 `code:'degraded'` 直接拒存）。宁可今天没有这条记录，也不要留一条几年后还在骗人的数。
4. **形状变了要让手机端能接受**。`GET /networth` 是**裸数组**（小程序 `list.forEach`），改成 `{rows:[…]}` 会让老板的手机白屏，而小程序重传要他自己动手。规矩：**能不改形状就不改**（失败靠响应头 `X-FA-Degraded`），真要改就得同步前端并提醒重传。
5. **内联 `onclick` 不要拼引号**（第 23 轮已经写过一次，这一轮又踩）。`onclick="bkRestore(' + id + ',\'' + at + '\',this)"` 里的反斜杠会在模板字面量里被吃掉、引号提前闭合。正确写法是 `data-id`/`data-at` + `onclick="bkRestore(this)"`，函数里 `btn.getAttribute('data-id')`。
6. **模板字面量里的 `
` 会变成真换行**（同上，第 23 轮写过，这一轮又踩）。后端 `c.html(\`…\`)` 里的页面脚本写 `confirm('…？\n\n…')`，渲染出来是真换行 → 整个 `/pc` 的脚本 `SyntaxError`，按钮全点不动。源文件必须写 `\\n`。**改完页面脚本一定抽出来 `node --check`**（`scripts/test-web-pages.mjs` 的 `new Function` 断言就是干这个的）。
7. **一天跑一次的事别让每个 cron 都跑**。`wrangler.toml` 有 4 条 cron × N 本账，自检/备份/清理这种「一天一次就够」的动作必须用 `dailyOnce` 门控（`cron === '0 16 * * *'`），否则一天把全库重算十几遍、白烧 D1 行数额度。门禁 `[4.31]`。
8. **网页上写下的承诺必须能在网页上兑现**。`/pc` 写着「清空前会自动备份，点错了还能退回去」，可整页既没有备份列表也没有恢复按钮 —— 老板只能掏手机。凡是文案里说「能退回去 / 能导出 / 能改」的，同一页就要有对应按钮（这一轮补了备份列表+恢复、报价单发链接/转单、记一张单、记预收）。门禁 `[4.32]`。

### 4.53 第 23 轮（网页端第三轮）的七条硬规矩

1. **查询失败不许变成 0，也不许变成「没有欠款」。** 这一类错误最坏的地方是**页面看不出异常**：`conclusionOf()` 六条查询失败算成「期末 0 元」，这行字会印到客户签字的那张对账单上；批量对账的名单查询失败回落空数组，页面回「账是清的」。规矩是：**只要这个数字会印给客户或拿去决策，就不许 `.catch(() => 0)` / `.catch(() => [])`**，要么整体 `return null` 由调用方给「这次没算出来」，要么带 `code` 报错。只影响备注/确认记录这种附带信息的（`recon_log`、`recon_confirm`），才允许静默降级。`check.mjs` [4.25] 守着。
2. **永久快照里更不许吞错。** `month_snapshot` / `month_archive` 是「这个月就长这样」的存证，事后没有任何痕迹可查。他们里面调用的 `advLeftAt()` 一旦 `.catch` 成 `{in:0,out:0}`，那笔预收就永久从快照里消失了 —— 而归档是幂等的，报错让它重试才是对的。
3. **分类、账户这类「表单里的选项」必须传名字（或必须与后端字段语义一致）。** 第 20 轮把支出分类的 `<option value>` 写成 `c.id`，后端 `/expenses` 的 `category` 要的是**名字**，于是账上出现 `cat_text:"39"`——`/cash-bridge`、分类报表、导出全跟着错，但页面一点异常都没有。规矩：**新增任何下拉/选项，先看后端这个字段收的是什么**；后端再加一层「是数字就按 id 反查名字」的兜底；`check.mjs` [4.26] 守着。
4. **内联 `onclick` 里不要拼引号。** 后端模板字面量里写 `\\'` 会被吃成 `'`，输出成 `onclick="goNext(''` → 整页脚本 `SyntaxError: Unexpected string`，页面上所有按钮一起失效（而且 `curl` 看页面是 200，只有真浏览器里才炸）。正确写法：`data-tab="'+esc(tab)+'"` 配 `onclick="goNext(this.dataset.tab)"`。`test-web-pages.mjs` [12] 会把每个页面的内联脚本抽出来 `new Function()` 编译一遍，就是防这个。
5. **模板字面量里的 `\n` 会被解释成真换行。** 源文件要写 `\\n`（在 `python3 - <<'PY'` 里要写 `\\\\n`），否则页面脚本 `SyntaxError: Invalid or unexpected token`。同一个坑在本轮出现两次，都是「后端多写一层转义」造成的。
6. **两个接口算同一个数，宁可重算也不许「共享一份逻辑」。** B11（把 `/kpi` 与 `/dashboard` 的未结总额并成一个 `/desk-data`）本轮**故意没做**：并接口等于在**第 4 个地方**复制一遍利润口径，而「任何页面的净利都必须等于 `/year-book`」那条（4.51 第 3 条）是断言级的硬约束，多一处实现就多一条漂的路。要并，必须先把「未结订单条件聚合」抽成一个函数、`/kpi` `/dashboard` `/ar-summary` `/due-schedule` 四处都调它，再谈合并。
7. **到期表（`dueRows`）的合计与列表必须在 SQL 里算。** 以前「合计」要按 3000 一段把全部未结单搬进 Worker（最多 6 万行）、造几千个对象再排序，最后只取 20 行 —— 翻页看一次账就烧掉几万行读（D1 免费额度 500 万行/天）。现在一条 SQL 算四个合计、一条 SQL 排序分页。**改它之前先把改前改后的输出编号存下来逐字段比对**（本轮比了 18 组参数：ar/ap × limit 10/20/300 × months 空/6/12，含每行内容）。`check.mjs` [4.27] 守着「不许改回搬进 Worker」，另外两个容易漂的点：`ORDER BY` 必须用 SQL 里那个 `due_eff`（不是 JS 里的 `due`）、`party_terms` 必须 JOIN（没填到期日的单靠账期推算，漏 JOIN 就全按 30 天算）。

### 4.52 第 22 轮（演示账套 / 新手演练文档）的五条硬规矩

1. **发出去的示例账套里不许有能进账的东西。** `docs/演示账套/*.json` 是要贴给用户、当培训材料发出去的。`/export-all` 已经跳过 `access_key` / `staff_key` / `sign_secret` 这类设置项（`BACKUP_SETTINGS_SKIP`），但**新加设置项时要回来确认一遍**：`scripts/check-demo-pack.mjs` 会用语义规则（key/secret/pass/token/pin/hash/code）扫 `settings` 的键，还会拒 `wx_users` / `auth_fails` 非空。员工口令必须留在文档里写明是**演示值**（当前 123456）。
2. **文档里的数字不许手写，必须由脚本核对。** 那份演练文档里有几十个具体数字（接单额 96,390、全年净利 −296,212.22、家底 32,218.50…），手写必然有一天和文件脱节。`check-demo-pack.mjs` 的 `[4][5][6]` 三段就是干这个的：**逐月 8×9 列**、**14 项年度结论**、**15 个关键数字必须能在文档里找到**。改文件不改文档 → CI 红，比人肉 review 可靠。
3. **重新生成演示账套的顺序不能变**：干净库 → `node scripts/mock-data.mjs` → **立刻** `GET /export-all` → 删 `op_dedupe`（103 KB 幂等管道，无教学价值）→ 重算 `counts` / `rows_total` → 最后才跑 `test-ledger.mjs`。**`test-ledger.mjs` 会写数据**（口径客户 / 口径供应商 / 361 单 / 6 条核销），先跑它再导出，账套里就带着测试残留，所有数字都会漂。
4. **给新手看的表要写清口径，别让他自己对不上。** 文档那张月度表里三处最容易让人怀疑自己：①「费用（材料之外）」含 `cash=0` 的报销冲借支（4～7 月各 2,000），真金白银比这列少；②报表页的「费用」还把折旧算进去了（4 月页面写 58,675 = 57,250 + 1,425）；③「实收 / 实付」是真金白银进出（4 月实收 324,480.50 里 300,000 是银行贷款），**转账两边都不算**。这三句已经直接写进文档的注里 —— 以后再改表，注也要改。
5. **演示账套是故意做成亏损的**（全年 −296,212.22，含借支报销 / 坏账核销 / 供应商豁免 / 设备中途处置 / 半年房租摊销）。别「顺手」把它改成盈利或把它抹平：账做平了就看不出「记了成本却没动现金」这类特殊行，那份文档的教学价值也就没了。要换剧本改 `scripts/mock-data.mjs` 的 `MONTHS` / `TODAY`，但**日期故意写死**（换了「今天」，折旧摊销月数就变，逐月加总对不上）。

### 4.51 第 21 轮（模拟数据跑完整账套）的六条硬规矩

1. **账上多一类流水，桥接就要多一行。** `/cash-bridge` 用的是恒等式「净利 + 调整 = 现金变动」，任何一类流水进了利润却没被某一行解释，它就会静静躺在「残差」里，谁也不知道差在哪。第 21 轮就是「借支报销」（`ref_type='expense'` 但 `cash=0`）没行承接，残差每月正好多一笔报销额。**新增/修改任何写 `ledger` 的地方，都要问一句：桥接哪一行负责它？** 兜底行 `other` 只该解释「确实没法归类」的那点东西。`scripts/test-ledger.mjs` [P5] 会扫 `ref_type` 是否有未归类项。
2. **利润口径只认 `COST_EXP_WHERE`，`CASH_EXP_WHERE` 只能用在「真现金支出」分项。** 两者差的就是 `cash=0` 的费用（报销冲借支、折旧摊销预提之外的那种）。拿 `CASH_EXP_WHERE` 去算净利，利润会一直偏高，且**只在有人报销时才偏高**——平时看不出来。`check.mjs` [4.24] 会拦 `/year-summary` 再用错。
3. **页面上任何一个「净利」都必须等于 `/year-book` 的 `totals.profit`。** 这条不是建议，是断言：`test-ledger.mjs` [P3] 把 `/year-summary`、`/year-book`（逐月加总）、`/year-customers`、`/cash-bridge`（逐月加总）四处拉平。改任何一处口径先跑它。
4. **数表头/合计行列数，用 `/<th[\s>]/g`，别用 `/<th/g`。** 后者会把 `<thead` 也数进去，于是「经营报表 4 列 vs 合计 3 格」「年度总账 9 vs 8」全是误报 —— 第 21 轮为此白查了半天。同理 `<td` 会数到 `<tfoot>`…（`<tf` 不同前缀，但 `<td` 与 `<tdx` 会混）。
5. **改完后端只重启 dev，别清库。** `node /tmp/killdev.mjs killdev` 后重新 `bash /tmp/startdev.sh`，`/tmp/d1r11` 里的数据要留着（重建干净库会丢掉演练数据，得从 `scripts/mock-data.mjs` 重灌一遍）。核验脚本支持 `FA_NOWRITE=1`，**先跑只读核验，再跑写路径测试**，否则自己造的测试数据会把「逐月加总」这类跨页断言带偏。
6. **`/month-brief` 的 `profit` 是现金口径，权责口径在 `profit_accrual`。** 同一个 `profit` 字段在不同页面上含义不一样（`/kpi`、`/cash-bridge`、`/trend` 的 `profit` 是权责）。看数、写断言、给别人讲账，都要先确认拿的是哪一个 —— 这条已经坑过一次（我把现金净利当权责净利比，误判成 bug）。

### 4.50 第 20 轮（网页端第三轮）的八条硬规矩

1. **前端判成功要看状态码，不能只看「能不能解析成 JSON」。** `/statement-ack` 曾经在后端 403/500 时照样弹「收到了，谢谢！」—— 后端错误响应也是合法 JSON，`r.json()` 永远成功。凡是「对外部的人」的页面（客户确认、客户对账、进度页），一律 `r.ok` + `d.ok !== false` 双判，失败必须用红色文字说明，不能静默。
2. **浏览器里凡是「点了没反应」，先怀疑 `window.open` 写在异步回调里。** 弹窗权限只在用户点击的同步阶段有效。写法固定为：函数入口 `var w = window.open('','_blank')`，回调里 `w.location.href = url`（本项目封装成 `/desk` 的 `preWin()` / `goWin()`）。`scripts/test-web-pages.mjs` 里有一条断言专门禁止 `window.open(d.url` 这种写法回来。
3. **幂等键不许用「纯内容指纹」。** 后端 `op_dedupe` 记录保留 30 天，纯内容指纹会把「同一天同金额的两笔真实收款」也判成重复。`/desk` 用的是「3 秒时间桶 + 内容」：3 秒内重复点击是同一个 id（后端判重），超过 3 秒是新的 id（真的是第二笔）。
4. **「没取到」不许显示成 0。** 金额位显示 `¥0.00` 比显示「加载失败」更危险 —— 老板会以为这个月没收入。约定：`null`/`undefined`/非数字 → 显示 `—`，并写「没取到，不是没有 —— 点刷新再看」。
5. **缓存分层要写清楚**：签名页（URL 带 `?t=`）`no-store` + 不发 ETag + 允许压缩；账目 JSON `no-store`；普通页面 `no-cache`（走 304）。`applyEtag` 里任何提前 `return` 都必须先把头补齐 —— 曾经因为 `c.res = res` 把新加的头全丢了。
6. **压缩交给 Cloudflare，不要自己在 Worker 里压。** 本机实测两个坑：`fetch` 拿到手写 `Content-Encoding` 的响应时不会自动解（显示乱码）；上线后 CF 可能对已 gzip 的响应再压一层，浏览器只解一层 = 全站乱码。要做的是**别写 `no-transform`**（它会让 CF 完全不压）。
7. **部分索引的谓词必须和查询逐字一致。** `idx_orders_open ... WHERE COALESCE(paid,0) + COALESCE(written_off,0) < price` 只有查询里写成一模一样的形式才可能被用上；写成 `price - paid - wo > 0` 就退回全表扫。改索引时 `check.mjs` 的 [4.15]/[4.20] 会校 schema.sql 与 migrations 是否一致。
8. **新加的「服务端页面」要同时补三样东西**：`scripts/test-web-pages.mjs` 的断言（含内联脚本 `new Function` 编译）、`check.mjs` 的守卫（守住那条断言不许被删）、以及公开路径白名单（`/desk`、`/statements-print` 这类壳页面靠口令头取数，漏了白名单就是 401）。

### 4.49 第 19 轮（网页端第二轮）的七条硬规矩

1. **打印隐藏名单只能收窄，不能拿 `.tip` 当垃圾桶。** `@media print{ .tip{display:none} }` 会把「电话」「数据截至」「验收条款」一起藏掉 —— 印出来的纸上看不到，而这几句正是纸上最该有的东西。要藏的是「只在屏幕上有意义」的控件（按钮、微信提示块），给它们各自的类（`.wxtip`），别复用语义类。
2. **`m-hide` 必须表头与合计行成对。** 手机断点藏列时，`<thead>` 藏了 4 列、`<tfoot>` 一格不藏，合计行就整体串位（工资单错两格，且看不出错）。改列必改合计行，并且要有断言（`test-web-pages` 里数 `m-hide` 出现次数是否相等）。
3. **`extraCss` 会赢过移动断点。** 页面自己注入的 `table{font-size:11.5px} th,td{padding:4px 6px}` 与 `A4_CSS` 同权重、且在后面 → 375px 上表宽 450px 撑破卡片。宽表页面必须自带 `@media screen and (max-width:760px)`，或让 `.sheet` 在卡片内横滚。
4. **给客户看的失效页，一律走 `errorPage()`，不要走 `a4Page()`。** `a4Page` 带「打印/存 PDF」按钮，手机上是张 A4 白纸，点下去印出来的就是「链接已失效」。`errorPage` 支持 `phone`，有号码就别让客户自己找。
5. **模板字面量里的 `\n` 会被解释成真换行。** 写进页面脚本的 `split('\n')` 到了浏览器就是 `SyntaxError: Invalid or unexpected token`（整页按钮全点不动）。要在页面里出现 `\n`，源文件必须写 `\\n`；`JSON.stringify(...).replace(/</g,'\u003c')` 这种**在服务端执行**的替换只能写 2 个反斜杠。改完页面脚本，务必把 `<script>` 抽出来跑一次 `node --check`。
6. **缓存头分三类，别一把梭。** ①签名页（URL 里有 `?t=`）：`no-store` + 不发 ETag + 允许压缩；②账目 JSON：`no-store`（公用电脑退出后按后退不该还能看到金额）；③普通页（`/`、`/pc`、`/guide`）：`no-cache` 走 304。注意 `applyEtag` 里任何「提前 return」都必须先把该有的头补上，否则又回到「一个缓存指令都没有」。
7. **进 `innerHTML` 的东西一律 `esc()`，包括「只是数字旁边的一小段名字」。** `/desk` 的客户名截断后直接拼进 `innerHTML`，而同一页 `localStorage` 里放着老板口令 —— 一个员工把客户名改成 `<img onerror=…>` 就能把口令发走。截断和转义的顺序也要对：先 `slice` 再 `esc`，别把 `&quot;` 截断成半个实体。

### 4.48 第 18 轮（网页端）的六条硬规矩

1. **服务端内联页也必须过手机这一关**：改 `A4_CSS` / `a4Page` 之后，用 375px 宽度打开对账单、工资单、经营报表各看一遍 —— 全仓只有 `@media print` 没有屏幕断点 11 个月，手机上正文只剩 248px 却没人发现（老板以为「网页版就这样」）。同理：**藏列只许藏序号/签字这类非金额列**，金额列在手机上再挤也得留（藏了等于藏账）。
2. **微信里没有 `window.print()`**：任何打印按钮都要先判 `/MicroMessenger/i` 并给出「右上角「…」→ 在浏览器打开」的三步说明，别再指望用户自己猜到。
3. **URL 里带签名的页面一律 `Cache-Control: no-store` + `Referrer-Policy: no-referrer`**。前者防「链接过期后按后退还能看金额」，后者防 URL 里的 `t=` 漏给下一个站点。判据用 `/[?&]t=/.test(search)`，写在 `applyEtag` 里（那里是唯一统一出口）。
4. **内联页拼 HTML 时，用户数据只许进 `data-*` 或文本节点，不许拼进 `onclick="fn('…')"`**：`/pc` 员工按钮以前就是这个写法，名字里一个引号按钮就点不动、甚至能借属性注入脚本。用 `esc()` 写进 `data-name` + 事件委托。
5. **模板字面量里的正则要写双反斜杠**：`` `…replace(/\B(?=(\d{3})+(?!\d))/g, ',')` `` —— 单反斜杠会被模板吃掉（`\B`→`B`、`\d`→`d`），不报错、只是功能静默失效（数字不再千分位）。**表达式箭头**（`(c) => c.html(\`…\`)`）结尾只能 `` `)) ``，多一个 `}` 会报 `missing ) after argument list` 且指向模板最后一行，极难定位。
6. **新开一个「给人看」的页面，要同时确认它在公开路径白名单里**（`backend/index.js` 的 `if (path === '/' || …)`，在 `applyEtag` 前面那个中间件里）。漏了就是 401，而且本地用口令头测不出来 —— 必须**不带任何头**直接 GET 那个 URL 才算验过（`/statements-print` 第一次就漏了）。

### 4.47 第 17 轮的七条硬规矩（「保险丝也要有人验」与「屏幕上看不出来的错」）

1. **`if:` 里引用了 `steps.*.outputs`，就必须显式写状态函数**（`always()` / `failure()` / `success()`），或者在该 step 里注明 `fail-fast`。GitHub 会给带自定义 `if:` 的 step 隐式 AND 一个 `success()` —— 于是「体检没过就回滚」这种步骤，**永远等不到它该跑的那一刻**。`check.mjs [4.18]` 会拦。
2. **部署后置的检查（验版本、版本比对、线上体检、报错巡检）一律 `always()` + `deploy.outcome == 'success'`**。它们的价值就在「前面某步红了」的时候，跟着一起被跳过等于没有。
3. **体检失败要先分清「线上坏了」还是「口令不对」**：`check-live.mjs` 用退出码 2 表示「全部失败都是 401/403」，CI 见到 2 只告警、**不回滚**（回滚会把好版本撤掉）。
4. **判主模块不许用 `import.meta.main`**（Node < 24.2 上是 `undefined`，整段 `main()` 不执行而退出码 0 —— 迁移「跑完了」其实一条没跑）。用 `argv[1]` 比 `pathToFileURL`。`check.mjs [4.19]` 会拦。
5. **门禁的「修法」不许是关掉门禁**：`--update-baseline` 只在「同批有迁移文件」或显式 `--force` 时才允许重写基线。
6. **`schema.sql` 必须是「一个文件建出来的库 == 跑完全部迁移的库」**：索引也好、列也好，只在迁移里加 = 按文档自建/打 exe 的机器永远缺。`check.mjs [4.20]` 真建两个内存库比集合。
7. **列表可以截断，合计不能跟着截断**：分页/封顶之后，凡是给人看的「合计」必须另用一条全表聚合算（`/loans` 的每人欠款、`/due-schedule` 的总额都是这个道理），并且响应里要带 `more`/`truncated`/`warn`，让人知道「这不是全量」。

### 4.46 第 16 轮的九条硬规矩（「同一个概念两套算法」与「失败写成成功」）

1. **同一个概念只能有一套算法**。这一轮最大的收获不是某条 bug，而是发现「核销」在不同页面有 9 套写法：`plOf` 早就知道「客户坏账核销是损失、供应商豁免应付是收益」，可另外 9 个地方还在 `SUM(amount)` 一把梭 —— 于是**只要豁免过应付，那些页面的利润就少算一倍**。规矩：①涉及「利润/成本/现金」的数只从 `plOf` / `monthSum` / `/cash-bridge` 这几个统一口径的地方取，别在页面里自己写 SQL 拼；②确实要自己写，`writeoffs` 必须按 `ref_type` 分成应收（损失）/应付（收益）两列；③费用口径分两种且只有两种 —— `CASH_EXP_WHERE`（只看现金）与 `COST_EXP_WHERE`（含报销冲借支等 `cash=0` 的费用），同一个页面上这两者不能混着用（`/year-book` 的年度费用以前就混了）。
2. **聚合查询失败不许降级成 0**。`jobs.map(x => x.catch(()=>null))` + `const agg = x || {}` + `num(undefined)` = **一份 13 项全 0 的月报被归档、还推「报表已生成」**。规矩：失败就抛（统一 500），并且要额外检查「13 个关键字段在不在」—— 列名写错时 SQL 是**成功**的，字段变 `undefined`，光靠 try/catch 拦不住。`monthSum` 里 `aggMiss` 那道检查就是为此。
3. **灌表结构要跑两遍：建表 → 迁移 → 再补一遍**。`backend/schema.sql` 里有索引引用**迁移才加上的列**（`idx_writeoffs_m` 要 `writeoffs.month`）。老库里表早就存在、`CREATE TABLE IF NOT EXISTS` 整句跳过，所以第一遍一定建不出这类索引 —— 只跑一遍的结果二选一：整步红（像发布失败），或者被当「幂等跳过」而索引永久缺失。`check.mjs [4.16]` 会扫出这类索引，并检查 `deploy.yml` 与 `scripts/deploy.sh` 的顺序。**新增「引用新列的索引」时必须先确认迁移里有那一列。**
4. **发布入口只有一套流程**。`deploy.yml` 与 `scripts/deploy.sh` 必须做同样的事：建表 → 迁移 → 补索引 → 部署 → 版本核对 → 线上体检。以前 `deploy.sh` 只跑迁移，照文档手工发布时新表没建也照样回 `Deployed`。**改发布流程要两个文件一起改**（`check.mjs [4.16]` 会盯着顺序）。
5. **失败不许显示成正常**。这一轮清掉一串「假安心」：报表全 0、提醒拉失败显示「账都是清的 👍」、账龄切类型留着上一类的数、对账失败留着上一份文件的差异、恢复没成功却弹「已恢复」、按钮卡在 loading、`check-live` 把 400/422 算通过。规矩：前端每个 `load*` 都要有 `fail` 分支并写 `_err(key,true)`、wxml 要有对应错误块（「⚠️ 没拉出来（不是没有）」）；后端拒绝时给 **400 + 人话 + code**；体检脚本非 200 一律算坏。
6. **幂等键只能由 `req` 发号，调用方不许自己 `newCid`**。`req` 的键是「`once` + 写内容指纹」：同一笔重发（30 秒内）共用同一个 cid，后端按它判重。有 8 处调用自己塞 `client_id: this.newCid()`，每次重试都是新 cid → **判重永远不生效**。要幂等就传 `once:`，别传 `client_id`。
7. **危险命令必须自报目标**。`cli.mjs` 的 `reset` / `restore` / `migrate` 现在先打印「动哪台机器的哪本账」；`FA_BASE` 与 `--base` 冲突时**直接拒绝**（以前静默取命令行那个）；`test-restore.mjs` / `test-oldbackup.mjs` 会清空账本，目标不是本机时必须显式 `--yes`。规矩：任何「不可逆 + 有目标地址」的脚本都要在动手前把目标打出来，配置冲突不许猜。
8. **cron 里「一天一次的推送」必须有幂等键，失败必须留痕**。两条 cron（`0 16` / `0 1`）都调 `runWxReminder` → 一天发两遍；发不出去时 `catch {}` 吞掉，配额耗尽后**提醒永久失效也没人知道**。规矩：推送前查 `settings.wx_remind_day` 今天发过没有、发成功写回；失败 `noteFailDb` + 写 `wx_err_day` 让设置页显示出来。群发 10 条一批并发 + 每条 5 秒超时（串行时一条卡住整批停）。
9. **`env:` 只属于它上面那一个 step，插步骤时先看归属**。第 16 轮把「灌表结构」改成两遍，新步骤插在「跑远程数据库迁移」的 `run` 与它的 `env:` 之间 —— `env:` 顺势归了新步骤，迁移裸跑没 token，2 秒 `exit 1`，日志只有「Process completed with exit code 1.」。规矩：①每个动 Cloudflare 的 step 都**自带** `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`，不靠继承（job 级 `env` 也别放这一类凭证）；②在 `deploy.yml` 里插入/删除 step 后，重新数一遍「哪些 step 有 env」；③`check.mjs [4.17]` 会逐个 step 核对，别靠肉眼。**同理适用于 `if:` / `continue-on-error:` / `id:` —— 它们都属于最近的那个 `- name:`。**

### 4.45 第 15 轮的六条硬规矩（「解释不了就塞进残差」那类）

1. **每一类真金白银的进出，桥接表里都要有自己的行，最后再加一行兜底**。「钱去哪了」（`/cash-bridge`）以前只有 11 行，预付货款、预付抵扣、押金/预付房租、卖设备收到的钱、银行认领的「其他收入」这五类现金进出**完全没有行去解释**，只能全落进「残差」；残差天天不为 0、谁也说不清差在哪。现在一类一行（17 行），外加 `other`「账本里有、上面几行没归类」列明细兜底。**新增任何写 `ledger` 的代码（新的 `ref_type`），必须在 `/cash-bridge` 里给它一行**，否则就会变成下一个「无人解释」的残差。
2. **每条流水查询都要写明 `cash`**。`ledger` 里同一张单据会同时有「真收钱」(`cash=1`) 和「预收抵扣」(`cash=0`) 两种行，漏写 `cash` 就会把同一笔算两次：第 15 轮「收回的钱」那条查询没写 `cash=1`，预收抵扣既被当成「收到了钱」、又被 `-orderOff` 扣一次 → **残差直接翻倍**（新测试第一版就是被它撞红的）。写「真金白银」的查询一律 `cash=1`，写「不动现金的抵扣/核销」一律 `cash=0`，混合口径就用两条。
3. **不许拿「现在的余额」倒算历史月份的变动**。应收/应付的变动以前是「月底欠款 − 月初欠款」，而两个数都用**当前的** `paid` 在场算 —— 查上个月时这个月收的钱会被算回上个月，历史月份必然对不上。现在一律用「本月发生的单据事件」：`ΔAR = 本月接单 − 本月收回 − 预收抵扣 − 核销应收 + 退给客户`，`ΔAP = 本月赊购 − 本月付掉 − 预付抵扣 − 豁免应付 + 供应商退款`。**任何「变动 = 期末余额 − 期初余额」的写法，都要先确认余额本身能按月份还原。**
4. **核销必须分「应收核销（损失）」和「应付核销（收益）」两个数**。`plOf` 以前只有一个 `wo`，`profit` 里减的是 `woAr − woAp` 的净值没错，但**只有「供应商豁免」的账套会把利润少算一倍**，残差正好是豁免额的 2 倍。现在 SQL 拆成 `wo_ar` / `wo_ap` 两条，返回 `writeoff`（应收核销，语义不变）、`writeoff_ap`、`writeoff_net` 三个字段。**动利润公式时先想清楚「这是损失还是收益」。**
5. **桥接表是「身份等式」，不是「容差表」**。每一类进出都有行 + 兜底行之后，正常账套 `residual` 恒为 0；残差再不为 0 只有一种可能——账本被手工动过（直接改单据的「已收/已付」、或删过流水）。为此另加了 `doc_gap`（「按单据算的余额」vs「按流水累计算」），不为 0 就在 `advice` 里点名。**修桥接表不能靠「把差塞进最后一行」**，那只是把问题藏起来。
6. **回归断言要能用「残差一分不动」的方式钉**。测试库里本来就有别的测试留下的数据，残差的绝对值没法钉死 —— 所以 `scripts/test-cash-bridge.mjs` 的写法是「**每做一笔业务，残差必须一分不动** + 对应那一行确实动了这么多」。这类断言不依赖干净库、也不会随别处的数据变化假红，**新加现金类功能请照这个模式补一条**。

### 4.43 第 13 轮的七条硬规矩（「两头没对齐」那类）

1. **签名必须「生成端和校验端用同一个串」**。`sigBook`/`sigOf` 的第 5 参 `exp` 和账套号前缀是签名串的一部分，**生成处和校验处必须一字不差**：生成传了 exp，校验就要读 `&x=` 传进去；生成用 `sigBook(mainDb,book,…)`（带 `|bN`），校验就不能用 `sigOf(db,…)`（不带）。第 13 轮一次扒出四个已瘫的公开功能（`/statement-ack`、`/year-open-print`、`/health-print`、`/recon-calendar`），全是这条没对齐，而且**测试都测不出来**（脚本直接调内部函数，不走链接）。改任何带签名的路由后，用真实 URL 打一次再说「好了」。
2. **HTTP 层的一次性键不能只用固定串**。`req()` 的 `client_id` 以前 = `opts.once`，而 `once:'receive-batch'` 是常量 → 30 秒内两笔不同收款共用同一个 id，后端判重返回 `dup_ok:true` 一分钱不核销，前端照弹「成功」。现在 `okKey = opts.once + '|' + this._writeIdent(data)`。**新增任何写操作，`once` 只是「语义前缀」，内容必须参与键。**
3. **「0」是有意义的值，不许用 `Math.max(1,x)` 兜底**。押金的 `pp_months=0`（不摊销）被 `Math.max(1,…)` 改成 1 → 押金按月摊进费用，利润每月虚减。**数字字段先 `amountOrToast`/`numStrict` 解析，再按业务允许的范围校验；不要用 `||默认值` 或者 `Math.max` 悄悄改用户填的值。**
4. **后端口径一律走 `SUM_MONEY(col)` / `centsSum`，不写裸 `SUM()`**。REAL 累加在几百行以后会跑出 0.30000000000000004 这种尾差，「本月利润 5 处等值」这类断言就会抖。`SUM_MONEY` 的表达式**必须带括号**（`(col)*100`，少了括号会变成只对最后一项乘 100，整列缩 100 倍——第 10 轮踩过）。
5. **CI 里「空检查」比没有检查更坏**。第 13 轮扒出三条恒真的门禁：`[4.13]` 只要文件里出现 `readD1Bindings` 这个**词**就绿（现在真调它比对 wrangler.toml）、`[4.12]` 没模拟成功的 `ADD COLUMN` 塞进 skipped 照样绿（现在删挡路索引重试，还有跳过就红）、`[4.15]`（新增）schema.sql 与迁移的同名索引必须同定义。**加检查时先故意把它写坏一次，确认它真的会红。**
6. **线上体检只许发 GET**。`scripts/check-live.mjs` 是给生产用的（部署后体检）；`scripts/smoke.mjs` 是给本机/测试库用的（第一步就 `POST /auth/setup`，注释里自承少数 GET 会补建表写默认值）。**别拿本地冒烟脚本打生产**，`/tmp` 上的方便会变成线上的数据风险。
7. **回滚要能证明「退回去的是好的」**。只判「线上 commit ≠ 这次坏 sha」不够——退到另一个旧坏版本也算「成功」。部署前先记 `pre_sha`（`steps.prever.outputs.pre_sha`），回滚后必须**正好回到它**；记不到时才退回「不等于坏版本」的弱判据。同理，单次部署的时间戳只取一次（`BUILT` 格式化出 `STAMP`），两次 `date` 会在整分钟边界上打架。

### 4.44 第 14 轮的六条硬规矩（「限制写在文档里、用户看不见」那类）

1. **加账套只有一条路：`node scripts/book-add.mjs`**（不加 `--yes` 只打印计划）。它挑空号、跑 `wrangler d1 create`、从输出里认 `database_id`（认不出就报错让人贴，**绝不猜**）、写 `backend/wrangler.toml` 时先查重名、再灌 `schema.sql`。**别手工抄 id**：抄错一位、忘灌表结构、绑定名大小写写错（`db4` vs `DB4`）都会变成「切过去一片 500」，现场看不错在哪一步。绑定名必须是 `DB`（第 1 本）或 `DBn`，`n` 不能超过代码里的 `BOOK_MAX`。
2. **「封顶/截断」必须同时给出人话，而且导出文件里也要写着**。`truncated` 只是个 JSON 字段，前端不显示、打印出来的人更看不见——等于把残表当全量用。现在 `dueRows()` 回 `rows_fetched` + `warn` + `code:'truncated'`，`/due-schedule-xlsx` 在表末多打一行「【注意】…合计不是全量」，前端下载前弹一次；`dumpAll()`（整库包 / `/export-all`）的 `truncated` 也配 `warn`。**新增任何 LIMIT / 封顶，三样一起给：值、人话、文件里的标记。**
3. **Excel 下拉装不下的候选不许静默丢弃**。`formula1` 有 255 字符硬上限，`fitDvList()` 现在回 `{list, rest}`，导出时把 `rest` 另开一页「下拉没列全的名字」列出来（能直接复制粘贴），接口回 `dv_dropped` + `warn`。以前员工多到装不下，用户以为「下拉里没有 = 系统里没有」，于是手敲名字，敲错一个字就是另一个人、账挂到对不上的户头上。
4. **`sign_secret` 不允许等于任何历史口令**。老账本的签名密钥是拿明文口令当种子种进去的，知道过旧口令的人能一直伪造打印链接。`/auth/change` 现在检测「`sign_secret` == 刚换下去的旧口令」并换成一串随机值（响应里说明「旧链接全失效，要重发」）；已经是随机值的库一行都不动。**新库种 `sign_secret` 一律用 `randHex`，别再用口令。**
5. **「改口令」和「作废链接」是两个动作，别混**。`sign_secret` 与 `access_key` 解耦是故意的：老板改密码不该让几十个客户手里的对账单同时打不开。要作废（链接被转发、员工离职带走记录）走老板专属 `POST /sign-secret-rotate`（要 `confirm:true`、落审计），设置页有「🔗 作废所有已发出的打印链接」按钮。**改口令时清 `sign_secret` 是错的做法。**
6. **文档里的「限制」要么修掉，要么在同一处给出修法**。第 13 轮收尾我列了 5 条「已知限制」写在回复里，README 里却只有「线上只配了 3 本」这种陈述、没有「怎么开第 4 本」。**现在规矩是：任何「目前只能 3 本 / 只算前 N 行 / 下拉装不下」的限制，必须紧跟一条可执行的做法**（脚本、参数或按钮），否则下一个人会以为这是做不到的事。

7. **签进签名的标量，写进去和比出来必须走同一个解析器，而且要有「真去用它」的测试**。第 14 轮就撞在这上面：公开链接的有效期是毫秒时间戳（1.7e12），却用了挡越界金额的 `num()`（把 `|v| > 1e12` 归 0）来解析 —— 生成侧恒拼 `|x0`、校验侧 `linkExpired(0)` 恒真，**对账单/工资单/进度/报价/体检那些打印链接一点开就是「已失效」**，而接口返回 200、签名自洽，静态检查和「只断言状态码」的测试全都绿的。规矩：①时间戳一律走 `numTs()`，金额走 `num()`/`numStrict()`，不许混用；②凡是「发出去给外面的链接」，测试里要**真的打开一次**（`fetch` 那个 URL 看返回是不是失效页），不能只断言「接口返回了 url」；③`check.mjs [5.9]` 会静态拦住这类误用。

### 4.42 第 12 轮的六条硬规矩（「旧机制只补了一半」那类）

1. **公开打印链接必须带过期时间**。`sigBook` 第 5 参 `exp`、`LINK_TTL`、`linkExpired`、`linkExpOf` 这四件是一套，**生成处必须传 exp 并拼 `&x=<exp>`，校验处必须读 `x` 并判过期**。只加生成不加校验 = 链接永久有效；只加校验不加生成 = 所有链接全失效。此前只有 statement/track/payroll 三类带 exp，其余 11 类（含毛利的 `/report-print`）链接永久有效。**新增任何带签名的公开页，生成和校验两端都要改。**
2. **员工可写的按 id 路由，查出行后必须过归属闸**。`orderVisible`/`payableVisible`（第 9 轮加的）要接到 `/orders/:id/receive`、`/orders/:id/status`、`/payables/:id/pay` 这三条——它们在员工写白名单里，以前只 SELECT 就操作，`staff_scope='own'` 下员工猜 id 能改别人的单。**新增任何「员工可写 + 按 id 操作」的路由，都要接归属闸，不满足返 404（文案与「不存在」一致，别暴露「存在但你没权限」）。**
3. **公开 auth 接口必须自己限流**。`path.startsWith('/auth/')` 走公开早退，`/auth/staff`、`/auth/staff-off`、`/auth/demo` 这些用 verifyKey 校验老板口令，但没有 IP 限流 = 可无限猜。统一用 `withAuthProbe(c,db,fn)`（查锁 + 403 计数 + 成功清零）。**演示账判定必须 fail-closed**（`isDemoBook` 判断失败时默认拦，不是默认放）。
4. **「验证/体检/汇总」类接口的 `ok` 必须由实际查询结果推出来**。`/selfCheck`、`/yearBook`、`/tax-pack`、`/dunning-year` 以前查询失败吞成 0/空继续算，照样 `ok:true`。**查询失败必须 `ok:false` + 错误说明，不许把「查不到」当「是 0」。**
5. **前端金额/数量一律 `toAmount()`，禁止 `Number(x)||默认值`**。「8,000,本金」逗号拆成 8 元、「1,000」报价变 1 件、期初余额「1.2万」清零——都是 `Number()` 静默吞错。**解析不出来必须 toast 拦下，不许静默取默认。**
6. **写接口覆盖测试必须断言精确状态码，不许「不 5xx 就算过」**。`test-write-methods.mjs` 的 `alive(label,res,expected=200)`、`test-write-coverage.mjs` 的 `assertStatus`——400/404 算「接口活着」是假安心，业务失败、路径拼错、事务部分写入后返回错误都算过。**负例单独标 expected（400/403/404），正例断言 200，再配 `assertPersisted` 写后读回。**

### 4.41 第 11 轮的八条硬规矩（都是「看着没问题、出事才发现」那类）

这些都是踩过的坑，写下来是因为**下次很容易顺手改回去**：

1. **「验证 / 体检」类接口的 `ok` 不许写死**。`/backup-verify` 曾经固定 `ok:true`（`usable` 只由几个 core 数组决定），而整块存的备份在 `readBackupContent` 里 `if (row.content) return row` **直接跳过 sha 校验** —— 脏备份一路绿灯，界面画绿勾，真去恢复才发现坏了。现在：整块与分片都核对 sha256（不符抛 `err.code='backup_corrupt'`），`ok = usable && !failedIn.length`，坏包给 `corrupt:true` 和明白话。**凡是 `ok`/`usable`/`canClose` 这种「能放心用」的字段，必须由实际检查结果推出来。**
2. **任何「占坑 / 锁」类幂等，请求异常结束必须自动放**。`opClaim` 占到坑后，之前靠每个 handler 自己记得 `opRelease`；`/quick` 的 `quickBy` 未定义直接 ReferenceError，坑停在 `ref_id=-1`，用户重试被当「重复请求」回 `ok:true` —— **那一笔永远没记上，而且越点越像成功**。现在 `opClaim` 把坑登记进本请求的 `AsyncLocalStorage` 桶（`claimTrack`），`opMark`/`opRelease` 销账，`fetch` 末尾发现 `status >= 500` 就把还挂着的坑放掉。**新增 opClaim 路由不用再加 try/finally，但失败必须返回非 2xx**（返回 200 + `ok:false` 不会放坑）。
3. **恢复码是万能钥匙：用后必须换**。`/auth/recover` 以前重设成功只清计数，不作废 `recover_hash` → 拿到纸条/截图的人可以反复改口令把老板锁死。现在成功即轮换（纯文本新码只回一次，前端弹窗让人抄）。试错计数也必须是**按 IP**（`clientIp` + `authFail/authOk`），不能只留一个全局值 —— 否则陌生人连错 8 次就能把真主人锁 10 分钟。
4. **`/auth/*` 全部要限流**。`path.startsWith('/auth/')` 在鉴权中间件里是公开早退，所以 `/auth/setup`（首设口令）、`/auth/recover`、`/auth/super`、`/auth/staff` 这些**每个 handler 自己就是门**。新增这类接口时必须自己 `clientIp + authLocked + authFail`，并且首设要 `INSERT ... ON CONFLICT DO NOTHING` 再判 `changesOf`（两个人同时首设不许 500、也不许互相顶掉）。云上部署建议配 `INSTALL_TOKEN` secret：第一次设口令要带令牌，否则「部署完成 → 老板第一次设口令」之间谁先打开地址谁就能设成自己的。
5. **前端金额一律 `toAmount()` / `amtOf()`，禁止 `Number(x) || 默认值`**。这类写法在「1,200」「1.2万」「abc」上分别变成 NaN → 默认值：退回余款会退成整笔、整户付款会付成 0 或旧值。**解析不出来必须明确拦下**（toast 说清），不许静默取默认。
6. **离线队列必须记「这笔是哪本账的」**。`enqueueOp` 要写 `op.book`，`flushPending` 只发本账的（别的原样留着并提示），`switchBook` 要连 `_tabSeq/_tabReqSeq/_keyQueue/_askingKey` 一起清。否则在一厂记的账，切到二厂联网就记进二厂 —— 这类串账错得很安静，对账时才发现，且很难倒推。
7. **迁移必须能在「老库」上跑通，而且命令在仓库根目录**。`backend/migrations/*.sql` 要能重复跑（`ALTER TABLE ADD COLUMN` 的 `duplicate column name` 由 `migrations-lib.mjs` 当幂等跳过），`scripts/check.mjs` [4.12] 会把迁移里所有 `ADD COLUMN` 都「假装老库没这列」真跑一遍。**`docs/RUNBOOK.md` 里的急救命令一律从仓库根目录写**（`node scripts/d1-seed-schema.mjs && node scripts/d1-migrate.mjs`），别写 `cd backend && node scripts/…` —— 那里没有 `scripts/`，照抄必然 No such file。
8. **回滚不回滚数据库**。`deploy.yml` 的迁移跑在部署之前（迁移失败就红、不上线），所以自动回滚时线上是「旧代码 + 新表结构」。只加列/加索引对旧代码无害，但**改类型/删列/改名必须人工处理**；回滚 step 的摘要里会列出本次迁移文件和 `migrations` 表的查询命令。另外：`python3 -c "import yaml,…"` 校验过的 workflow 才允许提交，PR 触发也要覆盖 Dockerfile/文档（改文档走 PR 以前压根不跑 CI）。

### 4.40 演示入口必须「不设口令就能进」（微信审核驳回项之二）

审核要求是**「不许必须先注册/先设口令才能看到任何东西」**。所以演示这条路有两个硬约束，别改回去：

- **新装的库（还没有 `access_key`）也必须放演示口令进来**。中间件里 `const given = String(c.req.header('x-access-key') || '')` 必须写在 `getKey()` 结果之前，守卫只能是 `if (!saved && given !== DEMO_KEY) return no_key`。上一版是 `if (!saved) return no_key`，把演示口令一起挡了 —— 审核员头一次打开小程序只看到「设个口令」，一个页面都点不进去。改成「谁都放行」也不行：`scripts/test-book4.mjs` 钉着「不带口令的 `/ar` 仍必须 401」，别顺手拆守卫。
- **登录卡上「设口令」这一步（`key_mode=='set'`）也要有演示入口**。`index.wxml` 的 `keydemo` 只判断 `demo_builtin!==false`，**不要再加 `key_mode!='set'` 这类条件**（第一次用正好会被藏起来）。
- **第 3 本演示账必须有表结构**。`deploy.yml` 里 `node scripts/d1-seed-schema.mjs` 会在部署前把 `schema.sql` 逐库补一遍（`schema.sql` 全是 `CREATE ... IF NOT EXISTS`、零 INSERT，跑在有数据的库上不丢东西），失败直接红。**新开一本书（DB4…DB9）也要进这一步**，否则切过去就是空库。
- **自测口径**：`node scripts/test-book4.mjs`（本机版 9 本、一次口令都没设）开头 3 项就是这根线，改动登录/演示相关的代码先跑它。

---

### 4.39 演示账套为什么不能设权限（要过微信审核就得读这条）

审核员拿内置演示口令进的是**第 3 本账**（示例数据那本）。那本账以前照样能建员工账号、改员工权限、把客户分给员工、设员工口令、设账套管理员口令 —— 审核视角看起来就是「一个没经过审核的多角色权限系统」，是要驳回的。现在整类入口在演示账里关掉。

- **判定别写死「第 3 本」**。`isDemoDb(db, bookId)` 先看 `settings.demo_seeded === '1'`（只有 `seedDemoBook` 种过示例数据的账才有这个标记），再看账名以「演示账套」开头**且**确实是第 3 本。**老板把第 3 本当二厂在用（里面是真数据）时，那本账不会被误伤** —— 这点以后别改回去。
- **拦的路径**：`/staff-users`、`/staff-perms`、`/party-staff`、`/auth/staff`、`/auth/staff-off`、`/book-admin-key`。统一 403 `{code:'demo_no_perm'}`。
- **三个地方容易漏**，加新入口时对照检查：
  1. **`/auth/*` 走不到鉴权中间件**（它们在「公开页早退」分支里，首次设口令时还没有口令），必须各自在路由里判一次；
  2. **`/book-admin-key` 是按目标库操作**（超级管理员在第 1 本账里给第 3 本设口令），要用 `isDemoDb(hit[1], id)` 按目标库判，不能只判「当前账」；
  3. **前端**：`GET /me` 返回 `demo_book`，wxml 里 5 个入口全部带 `!demo_book`。**藏按钮不够**，后端闸门才是真拦。
- **功能模块开关（`/modules`）故意不拦**：那是功能裁剪（关掉计件工资之类），不是给谁分配权限；拦了反而让演示账看着残废。
- **回归**：`scripts/test-demo.mjs` 第 10 段同时断言「演示账全 403」和「真账套照常 200」——**只加前者会让老板自己被拦掉**。

---

### 4.38 第十轮的几处硬规矩（改权限名单 / 改恢复 / 改幂等 / 改迁移前先读）

这一轮 100 多条改动里有几个「不改就会出事」的点：

- **「加一条接口」必须同时想「员工能不能看」**。员工侧的名单是三张正则（`STAFF_MONEY_DENY` / `STAFF_MONEY_SCRUB` / `STAFF_COST_PATHS`）加上 `denyStaff` 块里 63 条内联正则。**只加三张名单里的不够，63 条内联也要算**（漏算会误报 47 条）。`scripts/_staff-leak.mjs` + check.mjs **[5.8]** 会扫所有 GET 路由 handler 里出现的钱/成本/利润字段（cost/profit/margin/gross/…16 个），断言每条都被拦或被脱敏。**新增带成本/利润的 GET 接口，check.mjs 会红，别去改名单让它绿，要先决定这个字段该不该给员工看。**
- **公开链接的签名要带过期时间**。`sigBook(db, book, party, type, exp)` 的签名串末尾是 `|x<exp>`，**校验时必须一起看 `exp`**（`linkExpired(exp)`，没有 exp 视为已过期）。目前只有 statement/payroll/track 三类链接带过期（7 天 / 1 天 / 30 天），其余（handover/report/order-print/recon/quote/ack/year*/health）仍是永久签名 —— 给它们加过期时要一起改生成端和校验端，只改一端等于全失效。
- **恢复码不随备份走**。`RESTORE_SETTINGS_SKIP` 里含 `recover_code/recover_hash/recover_fail/recover_lock`，恢复时这几个键一律不恢复。**备份文件等同万能钥匙**（恢复码通常抄在纸上，纸又和备份放一起）。
- **跟着主表走的表，在包里缺失时必须一并清空**。`FOLLOW_TABLES = ['writeoffs','advances','debt_repays','transfers']`：主表（orders/payables/ledger）是整表替换的，这 4 张表留着旧记录就会挂在已经不存在的单据上（实测每恢复一次多一份核销记录，自检必报「单据已核销 600，核销记录合计 2400」）。**别把 D4 的「空数组不清空」套到这 4 张表上** —— 那 4 张要清。
- **备份分片必须校验**。`saveBackup` 存 `sha256` + `parts`，`readBackupContent` 拼回来后核对，不符就抛 `backup_corrupt` 拒绝恢复。`size` 按字节（`TextEncoder().encode(content).length`），不是字符数。
- **金额聚合表达式一定要加括号**。`SUM_MONEY(col)` 现在是 `SUM(CAST(ROUND((col)*100) AS INTEGER))/100.0`。**不加括号时 `*100` 只作用于最后一项，整列会缩小 100 倍**（实测应收 600 变成 6）—— 这是第 10 轮真实踩到的坑，也是 `test-numbers` 抓出来的。
- **去重键要带业务类型**。`opKey(cid, kind) = cid + '#' + kind`。`op_dedupe.client_id` 是全局唯一，跨业务共用会互相误判「重复」，把真实操作静默丢弃。**新增用到 opClaim/opSeen 的接口时，kind 要传，且和前端 `once` 的键一致。**
- **`opMark` 必须刷新 `created_at`**。不刷新的话 7 天后幂等窗口过期，重试会**重复记账**。GC 分两段：未完成的占坑（`ref_id=-1`）1 小时后清，已完成的 30 天后清。
- **占坑失败要释放**。用了 `opClaim` 的接口，每个提前返回的分支都要 `opRelease(db, cid, kind)`（金额无效、已付清、月锁、并发冲突、异常），否则用户改个金额再提交就被当成重复操作挡掉。
- **`Promise.all` 的解构个数必须和数组元素个数严格一致**。多写一个占位名，后面所有变量整体错位一格（`/dashboard` 曾经因此整页 500：`debtReps` 拿到账户余额数组）。改这块务必 `node --check` + 跑 `test-numbers`。
- **批次上限留余量**。D1 的 `batch` 最多 100 条语句 / 100 个参数；代码里统一用 `D1_MAX_STMTS = 90` / `D1_MAX_VARS = 90`。N×2 的批量（每张未结单两条语句）超过 45 张就会撞上限 —— 批量整户收付款必须分块。
- **CI 的「写接口全覆盖」要按字面路径+方法匹配**。以前用宽松正则拼接路径，`DELETE /staff-users/:id` 会被 `POST /staff-users` 命中 —— 实际有 56 条写接口从没跑过（其中 31 条 DELETE，前端在用）。现在 `scripts/test-write-methods.mjs` 表驱动逐条真调，新增写接口必须加进这个表。
- **迁移要在部署之前跑，失败就中止**。`scripts/d1-migrate.mjs` 逐条执行 `backend/migrations/*.sql` 并写进 `migrations` 表，库名从 `backend/wrangler.toml` 的 `[[d1_databases]]` 读。**迁移文件要能跑在老库上**（`written_off` 这类列是运行时 `EXTRA_COLS` 补的，迁移时还不存在 → 先补列再建索引）。SQLite 的 `ADD COLUMN` 没有 `IF NOT EXISTS`，执行器把「duplicate column name」当已执行跳过。
- **回滚判据用显式标记**。deploy.yml 的自动回滚看 `steps.health.outputs.bad == 'true'`，不要用「job 失败」—— 体检步骤缺 secret 时是 exit 0，用 job 失败当判据会误回滚（run 254 就这么把一次好好的部署退回去了）。
- **`check.mjs` 新增断言**：[4.12] 迁移在老库上能跑且能幂等复跑、[4.13] D1 绑定与迁移库一致、[5.7] 接口清单与后端一致、[5.8] 员工看不到成本。

---

### 4.37 第九轮的几处硬规矩（改权限 / 改多表写入 / 动 cron / 改镜像前先读）

这一轮 60 多条改动里有几个「不改就会出事」的点，记在这里：

- **写接口有多张表要改，就用一次 `db.batch`**。D1 的 `batch()` 是事务语义（`server/d1.mjs` 本机版也是 `BEGIN`+逐条+`COMMIT`，失败 `ROLLBACK`），一条 batch 里的语句顺序执行，所以第二条可以用 `(SELECT MAX(id) FROM t)` 拿到刚插的那条。**手工补偿（catch 里 DELETE 主表）不是事务**——进程在中途挂掉就留半截数据（`/advances`、`/loans`、`/bank-import` 以前就是这样，`/bank-import` 失败后已插的流水留在库里，重试一次就是双倍收款）。**batch 一次最多 100 条语句、100 个参数**（`D1_MAX_STMTS` / `D1_MAX_PARAMS`），自己拼的批留点余量（≤90）。
- **batch 里不要用 `last_insert_rowid()`**：它依赖语句顺序，D1 不保证。**用 `(SELECT MAX(id) FROM t)`**（或第一条的 `meta.last_row_id`）。
- **金额合计一律按分累加**（`centsSum(arr, get)`）。浮点直接累加几百上千行会出 0.1 级尾差，表现为「工资单和银行流水差几分」「备份里的合计对不上」。
- **乐观锁的 UPDATE 必须自带闸门**：`AND COALESCE(rev,0)=?`（改单）、`AND COALESCE(written_off,0)+? <= price - paid + 0.005`（核销）。**前置比一次 rev 不算闸门**（TOCTOU，两个请求都读到同一个 rev 就会丢更新）。改完记得判 `changesOf(...)===0` → 409。
- **员工可见性有两个函数**：`selfOnly(c)`（只看自己的单）和 `scopeOwn(c)`（按 `party_staff` 看分配给自己的客户）。**列表接口套了不代表详情接口套了**——`/orders/:id/detail`、`/payables/:id/detail`、`/orders/:id/processes`、`/attachments`、`/attachment/:id` 以前一个都没套，员工猜个 id 就能翻别人的单据和照片。现在统一走 `orderVisible/payableVisible/attRefVisible`。**新增任何按 id 取单据的接口，都要过这两个函数**。
- **`await c.req.json()` 必须带 `.catch(() => ({}))`**：body 非法时 Hono 会抛 → 500 而不是 400。现在 136 处全带了。**`JSON.parse` 也要 try**（老库里存过坏数据，一行坏数据曾让整个回收站页 500）。
- **查询失败不能当成「没有事」**：`/cash-forecast`、`/next-step` 以前把异常吞成 0，于是「应收查询挂了」显示成「一切正常，没有待办」。现在这两处返回 `failed:true`，前端会显示「没算出来，点一下重试」。
- **`scheduled()` 必须有测试**。线上每天的自动记账、备份、推送全靠它，而它以前**一次都没被测过**。`scripts/test-cron.mjs` 在进程内 import worker + 用 `node:sqlite` 造 D1，4 条 cron 各跑一遍（70 项断言）。**改 cron 分支或它调用的函数，先跑这个测试**。它必须在有 `npm ci`（backend 依赖 hono）的 job 里跑，不能放没有依赖的 check job。
- **`Dockerfile` 要 COPY 全 `backend/*.js` 依赖**：顶层 `import './perm-rules.mjs'` 和动态 `import('./guide.js')` 都会让容器启动即 `ERR_MODULE_NOT_FOUND`。exe 走 esbuild bundle 所以 exe 正常——**两条打包路径不一致，CI 从不 `docker run` 冒烟**。现在 release.yml 的 image job 后有一步 docker run 冒烟（/version、/help、/guide 都得 200）。
- **老库补列只覆盖 16 张表**（`EXTRA_COLS`），新加列要么写进 `EXTRA_COLS`、要么走 `backend/migrations/*.sql`。**远程 D1 的迁移现在由 `scripts/d1-migrate.mjs` 统一跑**（deploy.yml 和 `scripts/deploy.sh` 都调它，库名从 `backend/wrangler.toml` 的 `[[d1_databases]]` 读，不写死），**在部署之前跑，失败就 exit 1 拦住部署**（不再只是 warning）。迁移文件要**幂等**：SQLite 的 `ADD COLUMN` 没有 `IF NOT EXISTS`，所以由执行器把「duplicate column name」当成已执行跳过。`migrations` 表记的是「这台库跑过哪些迁移」（跑完一条就 `INSERT OR IGNORE`），不在备份里。
- **恢复备份会检查版本**：`data.version > 3` 直接拒（更新的包恢复不了，会静默丢字段）。`buildBackup` 写的 `version:3`，加字段时记得同步。
- **`check.mjs` 的表结构漂移检测是双向的**：基线里有、现在 `schema.sql` 没有的列 = 删列，会红。以前只算新增，删列永远发现不了。
- **CI 的 action 全部钉了 40 位 SHA**，`.nvmrc` 与 `backend/package.json` 的 `engines` 声明 Node ≥ 22.5（自检用 `node:sqlite`，Node 20 没有这个模块）。`npm audit --audit-level=high --omit=dev` 真会拦（审计接口本身不可用时才跳过）。

---

## 附录：本机运维命令与测试脚本（出问题时先看这里）

装完先跑一次诊断，改完代码跑一次全套回归——这两件事都有现成命令，不用自己拼。
**所有命令都在仓库根目录跑**，要 **Node 24**。

### 一键诊断与运维 CLI

- **`node scripts/diag.mjs`**：一键体检。查版本号与 commit、比对表结构有没有缺列（拿 `backend/schema-baseline.json` 当基准）、跑一遍后端自检（含 cron 心跳）、翻最近报错日志、列出慢接口、统计各表数据量。**装完先跑它、出问题先跑它**。
- **`node scripts/cli.mjs <命令>`**：本机版的运维命令行，子命令有 `status`（当前状态）、`backup`（导一份备份）、`cron`（手动跑一次定时任务）、`clean`（清理日志类旧数据）、`diag`（同 `diag.mjs`）、`reset`（**清空重来，需显式加 `--yes` 才会真删**）。默认打 `http://127.0.0.1:8787`（本机版默认端口）。

```bash
node server/main.mjs --port 8792 --data /tmp/fa-local --no-open --no-cron &   # 本机版
node scripts/cli.mjs status --base http://127.0.0.1:8792
node scripts/diag.mjs --base http://127.0.0.1:8792
```

### 回归测试：一条命令跑完

- **`node scripts/run-all.mjs`**：一把跑完全套回归（离线件照跑，联网件逐个打后端，失败不中断，最后汇总「失败 N 项」并以非 0 退出）。用法：`node scripts/run-all.mjs --base http://127.0.0.1:8791 --key 8888`。
- **它导出的 `OFFLINE` / `ONLINE` / `CASES` 清单是「全套回归有哪些测试」的单一事实源**。新增测试脚本先在这里登记（自包含、不依赖 `--base` 的放 `OFFLINE`，依赖 wrangler dev 的放 `ONLINE`），再在 `.github/workflows/deploy.yml` 补一步。
- **`node scripts/check-manifest.mjs`**：清单一致性检查——拿 `run-all.mjs` 的清单比对 `deploy.yml` / `release.yml` 里写死的步骤，少一个、多一个都会红（已挂在两个 workflow 的 `check.mjs` 之后）。

### 写测试脚本：别再抄样板

- **`scripts/_harness.mjs`**：测试脚本的公共脚手架。`harness({tag})` 返回 `BASE`（默认 `http://127.0.0.1:8791`）、`KEY`（默认 8888）、`TODAY/MONTH/YEAR/TAG`，以及一整套断言：`ok` / `no` / `yes` / `eq` / `near`（允许 1 分以内浮点差）/ `r2` / `n0` / `call` / `get` / `post` / `wait` / `finish`。新写 `test-*.mjs` 一律 `import { harness } from './_harness.mjs'`。

### 这几个专项测试各管什么

- **`scripts/test-book4.mjs`**：第 4 本账演练——自己起本机版（9 本账），验第 4 本不会被写死成三本。
- **`scripts/test-list.mjs`**：列表分页的离线回归。
- **`scripts/test-profit-consistency.mjs`**：本月利润在 5 处实现必须给出同一个数（首页 / 利润对比 / 报表 / 月结 / 经营体检）。
- **`scripts/test-write-coverage.mjs`**：补齐 `check.mjs` [5.6] 点名的「还没被脚本调用过的写接口」的覆盖。

### 在本机复现 CI（两个端口）

```bash
# 8791：wrangler dev，线上同款后端
cd backend && npx wrangler dev --port 8791

# 8792：本机版（Node 直跑 server/main.mjs），CI 里也是这么冒烟的
node server/main.mjs --port 8792 --data /tmp/fa-ci --no-open --no-cron
```
