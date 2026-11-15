# 小工厂加工费记账小程序

面向**以收取加工费为主要收入**的小型工厂：记录客户订单、追踪加工进度、统计欠款。

- **后端**：Cloudflare Workers（Hono）+ Cloudflare D1 数据库，免费额度足够小工厂使用。
- **前端**：微信小程序。
- 小白也能用：全部步骤见 [`DEPLOYMENT.md`](./DEPLOYMENT.md)。

## 目录结构

```
backend/            Cloudflare Worker 后端
  index.js          API 接口
  schema.sql        D1 建表语句
  wrangler.toml     Worker 配置
  package.json      依赖
frontend/           微信小程序
  pages/index/      记账主页面
docs/               需求文档
```

## 快速开始

1. **后端**：把 `backend` 目录用 `wrangler deploy` 部署到 Cloudflare Workers，并在 D1 中执行 `backend/schema.sql`。
2. **前端**：用微信开发者工具导入 `frontend` 目录，把 `frontend/pages/index/index.js` 顶部的
   `API_BASE` 改成你的 Worker 地址。

详见 [`DEPLOYMENT.md`](./DEPLOYMENT.md)。
