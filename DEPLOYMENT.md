# 加工费核算小程序部署说明

本系统采用 GitHub 管理代码，Cloudflare 作为后端托管平台。

## 1. 结构概览
- `/backend`: Hono 后端逻辑（需部署到 Cloudflare Workers）
- `/frontend`: 微信小程序项目（需用微信开发者工具打开）

## 2. 部署步骤 (无需编程)

### 第一步：GitHub 初始化
1. 在 GitHub 上新建一个仓库（例如 `factory-accounting`）。
2. 将 workspace 中的所有文件上传至该仓库。

### 第二步：Cloudflare 部署 (后端)
1. 登录 Cloudflare 控制台，进入 **Workers & Pages**。
2. 点击 **Create application** -> **Create Worker**。
3. 将 `/backend/index.js` 的内容粘贴进编辑器。
4. 在该 Worker 配置中创建一个 **D1 Database**，名称设为 `factory_db`。
5. 在 Worker 的 `Settings` -> `Bindings` 中添加 `DB`，指向刚创建的 `factory_db`。
6. 点击 **Deploy**。

### 第三步：微信小程序配置 (前端)
1. 下载并安装 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)。
2. 将 `/frontend` 目录导入。
3. 在 `index.js` 中将 `https://your-cf-worker-url` 修改为你刚才部署的 Cloudflare Worker 网址。
4. 点击 **上传** 即可发布。

## 3. 下一步建议
如果你需要我为你完成“GitHub上传”或“CF配置”的自动化流水线，请告诉我你的 GitHub 用户名，我可以通过脚本为你创建仓库并生成初始化提交。

## 推送遇到 TLS 报错（本机代理问题）

如果 `git push` 报 `gnutls_handshake() failed: The TLS connection was non-properly terminated`，是本机 `http_proxy`（192.168.2.22:20172）对 GitHub 的 TLS 握手不稳，不是仓库问题。绕过代理推即可：

```bash
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY git -c http.proxy= -c https.proxy= push origin main
```
