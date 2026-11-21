#!/usr/bin/env node
// 版本号一致性：docker-compose.yml（两处）、README.md 的镜像标签、DEPLOYMENT.md 的镜像标签
// 必须是同一个 vX.Y.Z，否则「照文档拉起容器，拿到的是旧代码」（v1.1.0 那次就踩过）。
// 发新版顺序：改这几处 → 提交推送 → git tag -a vX.Y.Z → release.yml 出 exe 与镜像。
import fs from 'node:fs'

const read = (p) => fs.readFileSync(p, 'utf8')
const want = process.argv[2] || '' // 可选：指定期望版本，CI 里用 tag 传进来
let bad = 0
const found = []

const compose = read('docker-compose.yml')
for (const m of compose.matchAll(/ghcr\.io\/tel9980\/factory-accounting:(v\d+\.\d+\.\d+)/g)) found.push(['docker-compose.yml image', m[1]])
for (const m of compose.matchAll(/FACTORY_VERSION:-:?(v\d+\.\d+\.\d+)/g)) found.push(['docker-compose.yml FACTORY_VERSION', m[1]])

// README 只看「## 说明」之前的部分（后面是编年史，里面的 vX.Y.Z 是当时的事实，不能跟着改）
const readme = read('README.md').split('\n')
const readmeStop = readme.findIndex((l) => /^## 说明/.test(l))
readme.slice(0, readmeStop < 0 ? readme.length : readmeStop).forEach((line, i) => {
  for (const m of line.matchAll(/ghcr\.io\/tel9980\/factory-accounting:(v\d+\.\d+\.\d+)/g)) found.push([`README.md:${i + 1}`, m[1]])
})

const dep = read('DEPLOYMENT.md').split('\n')
dep.forEach((line, i) => {
  for (const m of line.matchAll(/ghcr\.io\/tel9980\/factory-accounting:(v\d+\.\d+\.\d+)/g)) found.push([`DEPLOYMENT.md:${i + 1}`, m[1]])
})

const versions = Array.from(new Set(found.map(([, v]) => v)))
if (versions.length > 1) {
  console.log('❌ 文档里的镜像版本号不一致：')
  for (const [where, v] of found) console.log(`   ${where} → ${v}`)
  bad++
}
if (want && versions.length === 1 && versions[0] !== want) {
  console.log(`❌ docker-compose.yml 钉的是 ${versions[0]}，但这次发的是 ${want}（发新版要一起改）`)
  bad++
}
if (!versions.length) {
  console.log('❌ 一个版本号都没找到（是不是把镜像地址写错了）')
  bad++
}
if (!bad) console.log(`✅ 版本号一致：${versions.join(' / ')}（${found.length} 处）`)
process.exit(bad ? 1 : 0)
