# 本机版镜像：把「免安装 exe」同样的东西装进容器，扔到任意一台机器（或群晖/NAS）上跑。
#
#   docker build -t factory-accounting .
#   docker run -d --name factory -p 8787:8787 -v factory-data:/data factory-accounting
#
# 打开 http://<那台机器的IP>:8787 设个口令，然后把小程序的 API_BASE 指到这个地址。
# 数据全在 /data 里（book1.db … book9.db，一本账一个文件），把 /data 备份走就等于备份了整本账。
#
# 注意：这里不需要构建 exe，直接 node 跑 server/main.mjs —— 和 exe 里跑的是同一份代码，
# 只差 exe 用 Node SEA 把 node 运行时一起塞进了一个文件里。
FROM node:24-alpine

WORKDIR /app

# 只装运行时要的依赖（hono）。wrangler / esbuild / postject 都是构建工具，镜像里不要。
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev && npm cache clean --force

# 版本号：构建时传 --build-arg VERSION=xxx，运行时可以从环境变量读出来
ARG VERSION=dev
ENV PORT=8787 \
    FACTORY_DATA=/data \
    NODE_ENV=production \
    FACTORY_VERSION=${VERSION}

# 整个 backend 目录都拷进去（index.js / schema.sql / perm-rules.mjs / guide.js /
# migrations/*.sql / package.json …）。以前是一份份列举，加一个文件就漏一个，
# 容器启动直接 ERR_MODULE_NOT_FOUND —— 现在整目录拷，不会漏。
COPY backend/ ./backend/
COPY server ./server

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8787

# 起来后 20 秒内能打通 /version 才算健康（首次启动要建 60 张表，别设太短）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/main.mjs"]
