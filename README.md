# 设备历史库的区间边界与修订读数采集

这是面向资料接收人员的 Node.js 服务。提供人工收件、原始字节保管、业务身份版本记录、收件查询，以及按来源契约领取历史区间：`POST /api/collect` 会按分页凭据读完所请求区间，把原始页字节、raw 观测、同一时刻的多个修订和绘图端点分别保管。领取完成以来源返回 `next:null` 为准，不以图形连续推断；端点与插值值标记为 `measurement:false`，不会混入测量。

## 环境

支持 Node.js 22.22.1 及以上的 22.x 补丁版本；项目 Dockerfile 仍固定原有镜像摘要以保证可复现，正式 Linux 基线另外在 Node.js 22.23.4 验证。运行期没有第三方包及公网数据依赖。`npm ci --ignore-scripts --no-audit --no-fund` 安装锁定环境，`npm run build` 检查所有模块语法，`npm test` 验证归档、HTTP 入口及来源行为。来源材料均为本地合成的业务样本，没有真实账号、个人材料或访问外部站点的要求。

`npm start` 同时启动收件服务 3200 和来源 4200；可分别通过 `PORT`、`SOURCE_PORT` 修改端口。`ARCHIVE_DIR` 指定收件目录，默认 `.local/archive`；`SOURCE_URL` 指定收件端信任的来源根地址，默认 `http://127.0.0.1:${SOURCE_PORT}`。`npm run demo` 使用临时目录和系统分配端口展示人工收件、区间领取与领取报告，结束即清理，通常只需数秒。

## 容器

`docker build -t historian-intervals:local .` 构建环境，`docker run --rm -p 3200:3200 -p 4200:4200 historian-intervals:local` 启动。环境准备后，`docker run --rm --network none historian-intervals:local sh -c 'npm run build && npm test && npm run demo'` 可离线检查现有功能。正式展示应从干净归档启动真实新增功能并展示当前输出，完整操作限时 90 秒；准备镜像不计入运行时间。

## 接口与目录

`POST /api/manual` 接收 `fixtures/manual.json` 同形的业务对象，`GET /api/records` 查询人工收件版本，`GET /health` 检查进程。人工记录身份字段为 point, sourceTime, revision。同一身份与相同原文重复提交复用版本，内容变化保留旧版本；不同来源不能混淆。归档目录有按摘要保存的 blobs 和按业务身份保存的 receipts。

历史区间用 `POST /api/collect` 领取，例如 `{"point":"store-temperature","start":"2026-11-01T00:00:00Z","end":"2026-11-01T00:03:00Z"}`。`GET /api/intervals` 查看每次领取是否读完，`GET /api/observations` 查看观测及其修订，`GET /api/acquisition?point=&start=&end=` 给出窗口内已读覆盖、`gaps` 缺口、`pending` 未完成领取，以及“没有测量 / 质量不可靠 / 读取未完成”三种独立结论。区间可重复领取，重叠和首尾相接都不会丢弃先前修订依据。

`src/` 为收件、传输与历史区间领取，`provider/` 为独立来源服务，`fixtures/` 保留来源字节与人工记录，`test/` 验证现有行为。协议范围与局部身份约定见 `docs/source-contract.md`。
