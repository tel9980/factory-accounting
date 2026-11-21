# 加工费核算小程序部署说明

这套东西由两块组成：**后端**（Cloudflare Worker + D1 数据库）和 **前端**（微信小程序）。
下面按「从零装一套新的」和「升级已有的」分开写，照着做就行。

---

## 0. 装之前先跑一遍自检（30 秒，不联网、不碰数据）

```bash
node scripts/check.mjs
```

要 **Node 24**（自检用内置 `node:sqlite` 在内存里真建一遍库，Node 20 没有这个模块）。
它会检查：路由有没有重名、`schema.sql` 能不能一次建出新库、代码里写死的 632 条 SQL 在新库上跑不跑得通、
前端 258 个接口调用后台有没有、页面 wxml 绑的方法在 js 里存不存在。红了就先修，别急着装。

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

**一个 `schema.sql` 就够**：它会建出全部 57 张表、索引和 `month` 列的触发器，
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

```bash
cd backend
# 带上版本号，部署完 /version 就能看到线上到底跑的是哪一版
npx wrangler deploy --var APP_VERSION:"$(date +%Y%m%d-%H%M)" --var APP_BUILT:"$(date -u +%FT%TZ)"
curl -s https://jz.qy663.de5.net/version   # {"ok":true,"version":"20261119-0812",...}
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
**2026-11 查过，这个仓库当时一个 secret 都没有**，所以线上的 Worker 一直是手工
`wrangler deploy` 上去的，不是 CI 推的——看到绿勾不等于线上更新了，去看 warning。

还有一个可选的 `PROD_KEY`（值就是线上老板口令），配上之后部署完会多跑一步「线上体检」：

```
名字：PROD_KEY
值：  线上那本账的老板口令
```

这一步做两件事：①对 `https://jz.qy663.de5.net` 跑一遍 `scripts/smoke.mjs`（230 个 GET，
只读不写）；②问一次 `/schema-check`，线上真缺列就直接红，并打印缺哪张表哪个字段。
为什么不配也能跑：`check.mjs` 只能证明「`schema.sql` 在空库上建得出来」，证明不了
「线上那个库缺不缺列」——这两个 secret 都不配时，CI 只能保证「代码能跑」，保证不了「线上是对的」。

> 早期文档写的是「把 index.js 粘进 Cloudflare 编辑器」，那是 2025 年的做法，
> 现在只有一个 1.7 万行的单文件，别再粘贴了——用 `wrangler deploy`。

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
  另有 11 张表**按设计不进备份**（附件照片、月度报表 xlsx、员工口令、试错计数、运行日志…），`/backup-verify` 会把它们和原因一起列出来。
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

打开 `http://<这台机器IP>:8787` → 设老板口令 → 抄下恢复码。数据在 `./data`（`book1.db`/`book2.db`/`book3.db`）。

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
cd backend && npm install       # 需要 Node 24（node:sqlite 是内置模块）
node scripts/build-exe.mjs --out dist
```

脚本会 esbuild 打包 → 生成 SEA blob（`schema.sql` 作为资源塞进去）→ postject 注入 →
**自己跑一遍自测**（`/version` 版本号、落地页、建库 57 张表），不通就报错退出。
macOS 上会自己处理代码签名（先去掉签名，注入完再 ad-hoc 签）。

### 4.4 本机版的注意事项

- **没有网页版记账界面**：落地页只做「看状态 / 设口令 / 下载完整备份」，记账仍然用小程序。
- **别把 `data/` 放进网盘同步目录**（OneDrive / 坚果云 / iCloud）。SQLite 有 WAL 日志，
  边写边同步容易把库同步坏。要备份就用落地页的「下载完整备份」，或定时把 `data/` 拷出来。
- 本机版**照样跑那 4 条 cron**（每日维护 / 固定支出摊销预提折旧 / 每周一汇总 / 每月 1 号报表包），
  按 UTC 到点就触发，错过（关机、睡眠）下次起来补一次；`--no-cron` 可以关掉
  （关了之后固定支出/摊销/预提/折旧要手动点）。
- 多账套照样能用（`book1.db` / `book2.db` / `book3.db`），口令各管各的。

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

### 5.0 最省事：什么都不用配（内置演示入口）

登录页有一行 **「👀 先看看演示（不用口令，示例数据）」**——审核员点它就直接进演示账套
（第 3 本账，第一次进自动种一批示例数据：几个客户、几张单、应付、日常支出、材料进料），
可以随便记一笔试试，**碰不到你的真账本**；导出/备份/改设置这些照旧不给。

所以提审时备注写一句就够：**「打开小程序点『先看看演示』即可完整体验，不需要口令。」**

审核过了，如果不想让任何人点进来，小程序里 **设置 → 单位·账户·设置 →
「👀 内置演示入口：开着（点这里关掉）」** 点一下即可关闭（关掉后登录页不再显示那一行）。

> ⚠️ 演示账套用的是**第 3 个库**（绑定名 `DB3` = `factory-db3`）。如果新装时只灌了主账套，
> 第一次点「先看看演示」会提示「演示账套还没准备好」，补一条命令即可（只灌一次）：
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

如果 `git push` 报 `gnutls_handshake() failed: The TLS connection was non-properly terminated`，是本机 `http_proxy`（192.168.2.22:20172）对 GitHub 的 TLS 握手不稳，不是仓库问题。绕过代理推即可：

```bash
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY git -c http.proxy= -c https.proxy= push origin main
```
