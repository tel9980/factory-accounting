# 加工费核算小程序部署说明

这套东西由两块组成：**后端**（Cloudflare Worker + D1 数据库）和 **前端**（微信小程序）。
下面按「从零装一套新的」和「升级已有的」分开写，照着做就行。

---

## 0. 装之前先跑一遍自检（30 秒，不联网、不碰数据）

```bash
node scripts/check.mjs
```

要 **Node 24**（自检用内置 `node:sqlite` 在内存里真建一遍库，Node 20 没有这个模块）。
它会检查：路由有没有重名、`schema.sql` 能不能一次建出新库、代码里写死的 625 条 SQL 在新库上跑不跑得通、
前端 251 个接口调用后台有没有、页面 wxml 绑的方法在 js 里存不存在。红了就先修，别急着装。

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

**一个 `schema.sql` 就够**：它会建出全部 56 张表、索引和 `month` 列的触发器，
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

> 早期文档写的是「把 index.js 粘进 Cloudflare 编辑器」，那是 2025 年的做法，
> 现在只有一个 1.6 万行的单文件，别再粘贴了——用 `wrangler deploy`。

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
4. 进去点「设置 → 数据体检 → 结构自检」（`GET /schema-check`）：三本账缺哪张表、缺哪一列都会列出来。
5. 顺手点一次「立即备份」（`POST /cloud-backup`），再看备份自检（`GET /backup-verify`）：
   它会告诉你这份备份覆盖多少张表、哪些表按设计不进备份（以及原因）、有没有哪张表被漏登记。

> 有一部分列是**运行时兜底**建的（`ensureMonthCols()` 补 `month` 列和触发器、
> `ensureBaseTables()` 补那 11 张老表），所以老库即使不补灌 schema 也不会当场崩；
> 但补灌一次更干净，结构自检也就绿了。

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

## 推送遇到 TLS 报错（本机代理问题）

如果 `git push` 报 `gnutls_handshake() failed: The TLS connection was non-properly terminated`，是本机 `http_proxy`（192.168.2.22:20172）对 GitHub 的 TLS 握手不稳，不是仓库问题。绕过代理推即可：

```bash
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY git -c http.proxy= -c https.proxy= push origin main
```
