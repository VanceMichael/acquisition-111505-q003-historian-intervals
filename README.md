# 设备历史库的区间边界与修订读数采集

这是面向资料接收人员的 Node.js 服务。当前提供人工收件、原始字节保管、业务身份版本记录、收件查询，以及面向本地来源的历史区间自动采集；人工导入与自动采集分属不同来源，不会互相冒充。

## 环境

支持 Node.js 22.22.1 及以上的 22.x 补丁版本；项目 Dockerfile 仍固定原有镜像摘要以保证可复现，正式 Linux 基线另外在 Node.js 22.23.4 验证。运行期没有第三方包及公网数据依赖。`npm ci --ignore-scripts --no-audit --no-fund` 安装锁定环境，`npm run build` 检查所有模块语法，`npm test` 验证归档、HTTP 入口、区间算法、采集器及来源行为。来源材料均为本地合成的业务样本，没有真实账号、个人材料或访问外部站点的要求。

`npm start` 同时启动收件服务 3200 和来源 4200；可分别通过 `PORT`、`SOURCE_PORT` 修改端口。`ARCHIVE_DIR` 指定收件目录，默认 `.local/archive`。来源地址由 `SOURCE_URL` 指定，默认 `http://127.0.0.1:4200`。`npm run demo` 使用临时目录和系统分配端口展示来源、人工收件与历史区间采集，结束即清理，通常只需数秒。

## 容器

`docker build -t historian-intervals:local .` 构建环境，`docker run --rm -p 3200:3200 -p 4200:4200 historian-intervals:local` 启动。环境准备后，`docker run --rm --network none historian-intervals:local sh -c 'npm run build && npm test && npm run demo'` 可离线检查现有功能。正式展示应从干净归档启动真实新增功能并展示当前输出，完整操作限时 90 秒；准备镜像不计入运行时间。

## 接口与目录

`POST /api/manual` 接收 `fixtures/manual.json` 同形的业务对象，`GET /api/records` 查询全部人工收件版本，`GET /health` 检查进程。人工记录身份字段为 point, sourceTime, revision。同一身份与相同原文重复提交复用版本，内容变化保留旧版本；不同来源不能混淆。归档目录有按摘要保存的 blobs 和按业务身份保存的 receipts。

### 历史区间采集

区间一律按 `[start, end)` 解释。`POST /api/collect` 提交 `{point, start, end}` 后立即返回 202 与任务 id，收件端在后台按来源契约翻页：分页凭据始终与原始 point/start/end 一起回传，空页只要带 next 就继续，直到 `next=null` 才把该区间登记为已覆盖；来源报错（含 badContinuation）或响应不合契约时任务标记 failed，区间不登记覆盖。

- `GET /api/jobs`、`GET /api/jobs/:id`：任务状态。状态为 `running`（进行中）、`complete`（按契约读完）、`failed`（来源或协议错误）、`interrupted`（进程在读完前退出，重启时自动标记，可重新发起同一区间）。任务逐页落盘，并记录每页原始字节摘要 `pageBlobs` 与 `/history/revisions` 探查结果。
- `GET /api/coverage?point&start&end`：区间覆盖判定。`covered` 表示请求区间已按来源契约读完；`partial` 表示读过一部分，`gaps` 给出尚未读完的缺口；`none` 表示该区间从未采集。“读完”以 `next=null` 为准，与图形是否连续无关。
- `GET /api/readings?point&start&end`：仅返回 `kind=raw` 的真实测量。来源的 `bounding`/`interpolated` 端点值保存在独立来源 `history-boundary` 下，只能通过 `GET /api/boundaries` 取得，绝不计入真实测量。每条读数带 `qualityState`：`reliable`（quality=good）或 `unreliable`（其他质量标记，如 bad）；不合格值原样保留，不静默丢弃。同一 sourceTime 的修订版按 revision 各自存档，重叠或重复采集时同一原文复用版本，修订依据不会被抹掉。

由此可区分三种情况：区间 `none/partial` 且无读数表示尚未读完；已覆盖区间内没有读数才是真的没有测量；读数带 `unreliable` 表示有测量但质量不可靠。

`src/` 为收件与传输，其中 `intervals.mjs` 是区间拼接/缺口的纯函数，`collector.mjs` 负责分页协议、来源分类与覆盖登记；`provider/` 为独立来源服务，`fixtures/` 保留来源字节与人工记录，`test/` 验证现有行为。协议范围与局部身份约定见 `docs/source-contract.md`，该文档不规定接入端的内部架构。
