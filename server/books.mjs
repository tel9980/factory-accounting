// 「能开几本账」这件事只在这一个地方说数。
//
// 线上（Cloudflare Worker）是 9 个 D1 绑定：DB、DB2 … DB9；
// 本机版 / Docker 是 data/book1.db … book9.db。
//
// 为什么单独拆一个文件：以前 server/main.mjs 里写死 3 本、scripts/build-exe.mjs 的自测断言也
// 写死「应该建出 3 个库文件」。后来服务改成 9 本，断言没跟着改 —— 打出来的程序其实是好的，
// 但自测在「库文件个数不对」这一步判失败，release 三个平台全红，Release 与镜像双双跳过，
// 而平时 deploy 不跑这个脚本，所以一直没人发现。现在两边都从这里取，改一处就够。
export const BOOKS = 9

// 第 i 本账在 env 里的绑定名（DB / DB2 / DB3 …）
export const bookBindingOf = (i) => (i === 1 ? 'DB' : 'DB' + i)

// 第 i 本账在本机版数据目录里的文件名
export const bookFileOf = (i) => 'book' + i + '.db'
