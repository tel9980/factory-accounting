# 应急手册（RUNBOOK）

出事了照着做：**先判断是哪一类症状 → 照对应小节做 → 看「成功判据」那一行**。
每条命令都可以直接复制到终端里跑（在本机版仓库根目录，或服务器上装了仓库的目录）。

> 命令里的 `FA_BASE` / `FA_KEY` 是环境变量：线上是 `https://jz.qy663.de5.net`，口令是你的访问口令。
> 例：`export FA_BASE=https://jz.qy663.de5.net FA_KEY=你的口令`
> 本机版（`node server/main.mjs`）默认 `FA_BASE=http://127.0.0.1:8787`、`FA_KEY=8888`。

---

## 1. 部署红了（GitHub Actions 挂了 / 没部署上去）

**先分清是「没部署」还是「部署了但体检没过」**：

```bash
# 看最近一次工作流的结论
gh run list --limit 5
gh run view <run-id> --log-failed     # 只看失败那几步的日志
```

常见三种：

| 现象 | 原因 | 怎么做 |
|---|---|---|
| `❌ 这次 push 没有部署到线上` | 仓库没配 `CF_API_TOKEN` secret | GitHub 仓库 → Settings → Secrets → 加 `CF_API_TOKEN`（Cloudflare API Token，要 D1 Edit 权限）；加完重新 push 或手动重跑 workflow |
| `❌ 迁移失败`（在线上迁移那一步） | 远程 D1 迁移跑挂了 | 见下面第 3 节，在仓库根目录跑 `node scripts/d1-seed-schema.mjs && node scripts/d1-migrate.mjs` 单独看是哪条语句失败 |
| `体检没过就自动回滚` | 部署后的体检（`/schema-check`、接口冒烟）没过，CI 已自动 `wrangler rollback` | 看 `## 线上表结构与接口体检` 那段摘要，按第 2 节查线上 500 |

**手动重跑线上迁移**（CI 里那一步失败时用）：

```bash
# 注意：这两个脚本都在**仓库根目录**的 scripts/ 下，不要 cd 进 backend（那里没有 scripts/）。
# 第 11 轮 F6：以前这里写成 `cd backend && node scripts/d1-migrate.mjs`，照抄必然 No such file。
cd <仓库根目录>
npx --prefix backend wrangler d1 execute factory-db --remote --command "SELECT name FROM migrations"
node scripts/d1-seed-schema.mjs        # 第 1 遍：建表（老库缺新列时可能报错，正常）
node scripts/d1-migrate.mjs            # 跑迁移：读 wrangler.toml 里的全部 d1 绑定，逐条语句跑，已跑过的跳过
node scripts/d1-seed-schema.mjs        # 第 2 遍：迁移加完列以后补索引（这一遍必须过）
node scripts/d1-migrate.mjs --force    # 忽略 migrations 记录重跑一遍（幂等）
```

> ⚠️ 灌表结构是**两遍**：`backend/schema.sql` 里有几条索引引用「迁移才加上的列」
> （例如 `idx_writeoffs_m` 要 `writeoffs.month`）。老库里表已存在、建表语句整句跳过，
> 所以第一遍建不出这些索引，要等迁移加完列再补一遍（第 16 轮 C3）。
> 下面那条 `npx wrangler` 也一样：`wrangler` 装在 `backend/` 里，根目录直接 `npx wrangler`
> 会拉到另一个版本 —— 一律带 `--prefix backend`（第 16 轮 C5）。注意 `--prefix` 要放在
> `d1 execute` 之后、`--remote` 前后的位置都能被 wrangler 接受，但**不能省**。
>
> `scripts/cli.mjs` 的默认 `BASE` 是 `http://127.0.0.1:8791`（= wrangler dev）。本机版服务跑在
> **8787**，要打它得显式给：`FA_BASE=http://127.0.0.1:8787 node scripts/cli.mjs status`（第 17 轮 F2）。

**成功判据**：`node scripts/d1-migrate.mjs` 打印「✅ 迁移全部跑完」，且
`npx wrangler d1 execute factory-db --remote --prefix backend --command "SELECT name FROM migrations"` 能看到每个迁移文件名。

---

## 2. 线上 500（用户说「打不开 / 转圈 / 提示出错」）

```bash
export FA_BASE=https://jz.qy663.de5.net FA_KEY=你的口令
node scripts/cli.mjs errors --days 1     # 最近 1 天的报错
node scripts/cli.mjs status              # 版本 + 数据体检分数
node scripts/diag.mjs --base "$FA_BASE" --key "$FA_KEY"   # 一键诊断（版本/表结构/自检/慢接口）
```

线上接口能直接打：

```bash
node -e "fetch(process.env.FA_BASE+'/version').then(r=>r.json()).then(d=>console.log(d))"
```

**成功判据**：`node scripts/cli.mjs errors --days 1` 里没有 `status >= 500` 的行；
`/version` 返回的 `version` 不是 `dev`。

---

## 3. 数据不见了（少了单子 / 少了流水）

**先别恢复，先看备份列表**：

```bash
export FA_BASE=https://jz.qy663.de5.net FA_KEY=你的口令
node scripts/cli.mjs backups            # 列最近的备份（#id / 时间 / 大小 / 第几本账）
node scripts/cli.mjs backup              # 立刻存一份当前的（先保住现场）
```

**恢复到某一份备份**（危险动作，必须 `--yes`；恢复前系统会自动留一份快照）：

```bash
node scripts/cli.mjs restore <id> --yes
```

> 备份 id 是**每本账各自从 1 数**的：第 1 本的 #5 和第 2 本的 #5 是两份不同的账。
> 恢复前先 `node scripts/cli.mjs backups` 确认 `book` 列跟你要恢复的那本账一致。

**成功判据**：`node scripts/cli.mjs status` 的体检分数回到正常；
`node scripts/cli.mjs errors --days 1` 没有新的报错；恢复后单据数对得上。

---

## 4. 备份恢复失败（点了恢复报错 / 恢复完账不对）

按报错分类：

| 报错 | 原因 | 怎么办 |
|---|---|---|
| `这份备份的格式比现在的程序还新` | 备份版本比程序新 | 先升级程序（`node scripts/cli.mjs status` 看版本），再恢复 |
| `这份备份是第 N 本账的，现在打开的是第 M 本` | 账套对不上 | 切到同一本账再恢复（`X-Book` 头 / 前端切账） |
| `这份备份里没有账目数据` | 包是空的或坏了 | 换一份备份；本机版可以用 `node scripts/test-restore.mjs` 验证恢复链路 |
| `恢复会覆盖现在的账目，请确认` | 少了 `confirm` | 这是防误触的第一道门，`--yes` 走的 CLI 会自动带上 |

**验证恢复链路本身是好的**（本机，不碰线上）：

```bash
# ⚠️ 这两个脚本会清空/覆盖账本数据，只在**本机测试库**上跑
node scripts/test-restore.mjs --base http://127.0.0.1:8787 --key 8888
node scripts/test-oldbackup.mjs --base http://127.0.0.1:8787 --key 8888   # 半年前的老包还能不能恢复
```

> ⚠️ 三件事（第 16 轮 C5）：
> ① 这两个脚本的默认 `--base` 是 `8791`（`wrangler dev` 那个），而本机版（`server/main.mjs`）
>    是 `8787` —— 不显式给 `--base` 会连不上，或者更糟：连到你以为不是的那个库。
> ② 它们会 **清空/覆盖账本**，别对线上跑。脚本现在会拒绝非本机地址（除非你加 `--yes`）。
> ③ 跑完这本账就空了，别拿有真实数据的库去「验证一下」。

**成功判据**：`node scripts/test-restore.mjs` 全绿；线上恢复后 `node scripts/cli.mjs status` 体检干净。

---

## 5. 忘了口令

后端提供「恢复码」这条路（设口令时会显示一次，只显示这一次）：

```bash
export FA_BASE=https://jz.qy663.de5.net FA_KEY=旧口令   # 拿不到旧口令就用下面的恢复码流程
```

- **有恢复码**：`POST /auth/recover-code {key}` 拿新的恢复码 → `POST /auth/recover {code, password}` 重设口令。
  没有旧口令时，`/auth/recover-code` 需要「能进这套账的口令」，所以走不通时只能找**还能进账的人**重设。
- **员工口令忘了**：老板在「设置 → 员工」里重置（`POST /auth/staff` 要老板口令）。

本机版（没配任何线上口令时）：

```bash
FA_BASE=http://127.0.0.1:8787 FA_KEY=8888 node scripts/cli.mjs status
```

**成功判据**：拿新口令跑 `node scripts/cli.mjs status` 能出体检分数，不再是 401。

---

## 6. 磁盘满了（服务器报 no space / 备份写不进去）

```bash
df -h                       # 看哪个盘满了
du -sh data/* 2>/dev/null | sort -h | tail    # 本机版：账本文件在哪
docker system df            # 用 docker 部署的话
```

**先清理日志（不动业务数据）**：

```bash
export FA_BASE=https://jz.qy663.de5.net FA_KEY=你的口令
node scripts/cli.mjs clean --days 180     # 删 180 天前的日志
```

**docker 部署的**：

```bash
docker compose down
docker compose up -d
# 备份（整个 data 目录就是账本）
# 第 13 轮 E8：服务名是 compose 里写的 factory-accounting，以前写成 app —— 照抄报
# "service \"app\" is not running"，最需要备份的时候卡在这一步。
docker compose exec factory-accounting tar czf /data/backup-$(date +%F).tar.gz -C /data .
```

**本机版**：`data/book1..book9.db` 就是九本账，备份 = 拷这个目录；旧的 `.tar.gz` 可以自己删。

**成功判据**：`df -h` 里目标盘使用率 < 80%；`node scripts/cli.mjs backup` 能跑完并打印「✅ 备份完成」。

---

## 7. 其它常用动作

```bash
node scripts/cli.mjs status      # 版本 + 体检
node scripts/cli.mjs backup      # 立刻备份
node scripts/cli.mjs cron        # 手动跑每日结账（固定支出/摊销/折旧）
node scripts/cli.mjs diag        # 一键诊断（转给 scripts/diag.mjs）
node scripts/run-all.mjs         # 本机全套回归
node scripts/check.mjs           # 上线前静态自检
```

**表结构对不上 / 老库缺列**：

```bash
node scripts/check.mjs           # 里面 [4.12] 会拿「老库」干跑一遍迁移
node scripts/d1-migrate.mjs      # 真正对线上库跑迁移
```

**成功判据**：`node scripts/check.mjs` 打印「✅ 自检通过」。
