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
| `POST /feishu/events` | 飞书事件回调（明文或 AES 加密；**不需要 Bearer token**，用 Verification Token/签名校验） | `200 {challenge}`（URL 校验）或 `200 {}`（先 ACK，异步执行后主动回复） |

```bash
TOKEN=secret
curl -s -H "Authorization: Bearer $TOKEN" -X POST localhost:8892/streams -d '{"title":"demo"}' -H 'content-type: application/json'
curl -sN -H "Authorization: Bearer $TOKEN" \
  "localhost:8892/streams/<id>/events?from=1"
curl -s -H "Authorization: Bearer $TOKEN" -X POST localhost:8892/streams/<id>/messages \
  -H 'content-type: application/json' -d '{"text":"现在几点？"}'
```

## 飞书机器人

`steve-serve` 可以把飞书（Lark）自建应用机器人接成聊天面：群里或私聊里 @ 它，消息会落到一条事件流，由 worker 执行，回答再回到飞书。一个 chat 固定映射到一条流（`sha256("feishu:"+chat_id)` 前 12 位十六进制），所以历史会累积，进程重启后还能接着聊。

**准备**（飞书开放平台，约 5 分钟）：

1. 创建**企业自建应用** → 添加「机器人」能力。
2. 权限：`im:message`（接收消息）与 `im:message:send_as_bot`（发消息）。
3. 事件订阅：订阅 `im.message.receive_v1`（接收消息 v2.0），请求地址填 `https://<你的公网地址>/feishu/events`（需要公网可达，反代或内网穿透都行；与 ACP 一样，入口本身只监听回环时需要自己加一层）。
4. 若开启了「加密策略」，把 Encrypt Key 也记下来；同时事件订阅页会给 Verification Token。
5. 把凭证写进 `.steve/.env`（或直接 export）：

```bash
FEISHU_APP_ID="cli_xxxxxxxxxxxxxxxx"
FEISHU_APP_SECRET="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
FEISHU_VERIFICATION_TOKEN="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
# FEISHU_ENCRYPT_KEY="..."   # 只有开启加密策略时
```

**运行**：`steve-serve --port 8892`，启动日志出现 `feishu bot: on` 即生效；`--no-feishu` 可关闭。飞书后台点「保存」时会先发 URL 校验请求，`steve-serve` 直接回 challenge。

**行为**：

- 回调必须在 3 秒内 ACK，所以入口先回 `200`，run 完成后再调 `POST /open-apis/im/v1/messages/:message_id/reply` 回复（tenant_access_token 进程内缓存，提前 2 分钟刷新）。
- 只处理文本消息；`@_user_1` 之类的 mention key 会被剥掉；非文本、机器人自己发的消息、未知事件类型只记日志不回复。
- `/feishu/events` 不走 `--token` 的 Bearer 鉴权（飞书回调无法带自定义头），改用 Verification Token 与（开启加密时的）`X-Lark-Signature` 校验；其余接口仍然要 token。
- 按 `event_id` 去重（飞书超时会重投）。
- 同一 chat 的 stream 串行执行：新消息若顶掉正在跑的 run，旧 run 的回复会带「执行被取消」。
- 权限仍走 `steve-serve` 的 `--access` 与审批策略：需要审批（permission: ask）的工具在常驻进程里不会弹窗，会被拒绝并写进事件流；只读/只写类工具按 `--access` 放行。
- 回复是纯文本（agent 的最终文本；工具调用过程不推给飞书），超过 4000 字截断。

**限制**：只支持 HTTP 回调模式（飞书的长连接需要官方 SDK，本项目不引新依赖）；群聊需 @ 机器人；图片/卡片/富文本暂不处理。


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
