# steve-serve：常驻 Personal Agent 服务

`steve-serve` 把 steve 变成一个**长驻进程**：它同时拥有

- 事件日志（`<cwd>/.steve/streams/`，JSONL，真相）；
- 运行执行器（worker：一次输入 -> 一次性 Agent -> run 生命周期事件）；
- 触发器（`.steve/watch.json`：事件谓词 / 文件 / 定时 / webhook）；
- HTTP + SSE 接口（给任意前端用，不要求编辑器或 ACP 客户端）。

前端拿到的是同一套事件词表（`features/events.ts`），只是**按受众投影**过：
默认 `user` 档隐藏模型思考与原始工具参数/输出。

## 启动

```bash
steve-serve                     # 127.0.0.1:8892，读 .steve/streams 与 .steve/watch.json
steve-serve --port 8892 --token "$STEVE_TOKEN"
steve-serve --audience full     # SSE 给完整事件（排查用；会对前端暴露工具参数）
steve-serve --no-watch          # 不加载 watch.json（只做流 + 执行器）
```

开发时：`npm run serve:dev -- --port 8892`；构建后：`npm run serve`。

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `--port <n>` | `8892` | 监听端口 |
| `--host <addr>` | `127.0.0.1` | 非回环地址**必须**配 `--token`（或 `STEVE_SERVE_TOKEN`），否则拒绝启动 |
| `--token <secret>` | — | 所有请求要带 `Authorization: Bearer <secret>` |
| `--audience <user\|full>` | `user` | SSE 的投影档位 |
| `--access <none\|read\|write\|exec>` | `exec` | 工具可用的本地能力（路径收敛仍按 workspace roots） |
| `--streams-dir <path>` | `<cwd>/.steve/streams` | 事件日志目录 |
| `--no-watch` | 关 | 不启动触发器 |

## HTTP API

所有接口都要 token（配置了的话）。SSE 的每一帧是 `data: {"seq":…,"project":"user","event":{…}}`。

| 方法与路径 | 请求体 | 返回 |
| --- | --- | --- |
| `GET /health` | — | `{ok, version, uptime}` |
| `GET /streams` | — | `{streams:[{streamId,cwd,title?,createdAt,updatedAt,lastSeq}]}` |
| `POST /streams` | `{cwd?, title?}` | `201 {streamId,cwd,title?}` |
| `GET /streams/:id/events?from=N` | — | SSE：先回放 `seq >= N` 的历史再推增量；头部带 `X-Accel-Buffering: no` |
| `POST /streams/:id/messages` | `{text, images?}` | `202 {runId}`（立即返回，跑完看事件流） |
| `POST /streams/:id/cancel` | `{runId?}` | `202 {cancelled,runId}`；无活动 run 时 `404` |
| `POST /streams/:id/approvals` | `{requestId, decision, toolName?}` | `202 {granted,decision}`（`decision`: `allow_once`/`allow_always`/`deny`） |
| `POST /hooks/:name` | 任意文本 | `202 {accepted:true}`；webhook 触发器不存在/签名不符时 `404` |

```bash
TOKEN=secret
curl -s -H "Authorization: Bearer $TOKEN" -X POST localhost:8892/streams -d '{"title":"demo"}' -H 'content-type: application/json'
curl -sN -H "Authorization: Bearer $TOKEN" \
  "localhost:8892/streams/<id>/events?from=1"
curl -s -H "Authorization: Bearer $TOKEN" -X POST localhost:8892/streams/<id>/messages \
  -H 'content-type: application/json' -d '{"text":"现在几点？"}'
```

## Watch 与后台运行

`.steve/watch.json` 的条目会被内置插件 `watch-config` 校验后交给触发器引擎；命中后引擎追加
`trigger.fired` 与一条以 `[watch:<name>] ` 开头的 `user.message`，常驻进程随即把它当输入交给 worker
（`append:false`，不重复写输入事件），默认 `mode:"background"`。

后台 run 的执行规则（安全边界）：

- 工具集来自环境快照；**需要审批的工具**不会直接执行，而是追加 `approval.pending` 并挂起，
  等前端调 `POST /streams/:id/approvals` 放行；默认 10 分钟无响应按拒绝处理（run 不会被静默放行）。
- webhook 触发器在 `.steve/watch.json` 里配 `secret` 后按 `X-Signature: HMAC-SHA256(secret, body)` 校验；
  监听非回环地址时**没有 secret 的 webhook 触发器会被拒绝加载**。
- `--no-watch` 时 `POST /hooks/*` 一律 `404 {"error":"watch disabled"}`。

`.steve/watch.json` 示例（与 `docs/personal-agent.md` §5.5 一致）：

```json
{
  "triggers": {
    "weekly-digest": {
      "kind": "cron",
      "cron": "0 9 * * 1",
      "timezone": "Asia/Shanghai",
      "targetStream": "digest",
      "mode": "background",
      "prompt": "整理上周的会议纪要"
    },
    "deploy-hook": {
      "kind": "webhook",
      "path": "/hooks/deploy",
      "secret": "至少八个字符",
      "targetStream": "deploy",
      "prompt": "检查这次部署的结果并汇报"
    }
  }
}
```

## 与 ACP / CLI 的关系

三者共享同一套底层：事件日志 -> 折叠 -> 投影，执行都走 worker（ACP 的 `session/prompt` 即
`submit + 等终态`）。区别只在**前端与授权交互**：

| 前端 | 默认投影 | 审批方式 |
| --- | --- | --- |
| CLI | `user`（`--audience full` 可看全部） | 终端 y/n |
| ACP | `full`（客户端自己渲染） | `session/request_permission` |
| `steve-serve` | `user`（`--audience full` 可改） | `POST /streams/:id/approvals` |

## 限制

- 单进程假设：同一个 `<streams-dir>` 不要同时开两个 `steve-serve`（seq 计数器在内存里）。
- 不做压缩/归档：日志按 8 MiB 轮转，单事件上限 64 KiB，长期运行请配好清理策略。
- HTTP 面没有多租户与细粒度权限；非本机使用请配合反代 TLS 与 token。
- 图片输入会以 blob 形式落 `.steve/blobs/`（按 sha256 去重），HTTP body 上限 8 MiB。
