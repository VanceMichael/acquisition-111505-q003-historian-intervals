# 合作来源约定

## 资料边界

POST /history/read 接收 point、start、end、continuation；区间采用 [start,end)，reply 中 values 分别带 sourceTime、revision、quality、kind。kind 为 raw、bounding 或 interpolated。continuation 与 point/start/end 完整绑定；next=null 才结束。/history/revisions 说明同一 sourceTime 的修订关系。读取空页仍可能带 next；badContinuation 不代表空区间。

## 本地服务

来源和收件端是两个独立 HTTP 监听器。来源 `/health` 报告运行状态，`/__state` 返回当前情景；仅本地使用的 `POST /__control` 可改变来源情景，不属于收件端的业务 API。具体情景字段在 `provider/scenario.mjs` 的 `initialState` 中定义，切换只影响后续来源响应，不会改写已有收件。探查入口为 `/history/revisions`，请求相对链接必须以实际来源地址解释。

来源响应在每页都带 `next`；`next` 为字符串时下一请求必须原样回传为 `continuation`，为 `null` 才表示该查询已读完。空页也可能带 `next`，因此不能以“本页没有值”推断区间为空。`values` 中的 `bounding` 与 `interpolated` 是来源为绘图补出的端点或插值，不是测量；`raw` 才是原始观测。同一 sourceTime 可同时出现不合格的旧修订和后续修订，二者都要保留。

## 收件端区间领取

`POST /api/collect` 接收 `{ point, start, end }`，`source` 可选。收件端用配置的来源（`createIntake` 的 `source` 参数或 `SOURCE_URL`）确定源站根地址，请求里若再给 `source` 必须与配置一致，避免把收件端当作任意转发器。领取按 `continuation` 严格分页：

- 每页原始字节先按摘要保管在 `history-page`，即使后面一页失败也可复核已读内容；
- `kind=raw` 的值按 `(origin, point, sourceTime, revision)` 存档，修订版本不合并、不覆盖；
- `bounding`/`interpolated` 单独记为 `measurement:false` 的绘图材料，绝不进入观测；
- 区间写入 `history-collection`：开始时先记 `status:"running"`，结束时记 `complete` 或 `incomplete`；
- `complete` 只表示来源返回过 `next:null`，即所请求区间已按契约读完，与图形是否连续无关；
- `badContinuation`、HTTP 错误、无效 JSON、缺少 `next` 或重复凭据都会停止领取并保留已读页，结果为 `incomplete` 且 `continuation` 原样返回，便于人工排查。

多次领取可以重叠或首尾相接；`GET /api/intervals` 列出每次领取及其完成状态。`GET /api/observations` 返回所有观测版本（含 `latestRevision`、`reliable`）。`GET /api/acquisition?point=&start=&end=&origin=` 汇总所请求窗口：`readComplete` 仅在窗口被完整领取覆盖时为真，`gaps` 给出尚未读完的区间，`pending` 给出未完成领取的凭据和错误。没有 `raw` 且在已读部分内时报 `noMeasurement`；`raw` 的 `quality` 不是 `good` 时计入 `unreliable`。三种结论互不替代。

## 已有归档约定

人工入口只接收人工确认过的结构化对象，并不验证自动来源完整性。`Archive.accept(source, identity, data, raw)` 把原始字节按摘要保存，并为同一来源与身份保留不同版本。`source` 和 `identity` 的选择必须与业务对象对应，正文摘要只用于原文复用，不代表两份业务记录相同。`src/transport.mjs` 仅提供一次请求，不带自动分页；分页与协议解释在 `src/history.mjs`。
