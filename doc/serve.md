# steve-serve：常驻 Personal Agent 服务

`steve-serve` 把 steve 变成一个**长驻进程**：它同时拥有

- 事件日志（`~/.steve/streams/`，JSONL，真相）；
- 运行执行器（worker：一次输入 -> 一次性 Agent -> run 生命周期事件）；
- 触发器（`~/.steve/watch.json`：事件谓词 / 文件 / 定时 / webhook）；
- HTTP + SSE 接口（给任意前端用，不要求编辑器或 ACP 客户端）。

前端拿到的是同一套事件词表（`features/events.ts`），只是**按受众投影**过：
默认 `user` 档隐藏模型思考与原始工具参数/输出。

## 启动

```bash
steve-serve                     # 127.0.0.1:8892，读 ~/.steve/streams 与 ~/.steve/watch.json
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
| `--streams-dir <path>` | `~/.steve/streams` | 事件日志目录 |
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

事件传输有两种方式：**长连接（默认，推荐）** 与 **HTTP 回调**（兼容旧配置）。长连接由进程主动连飞书，**不需要公网地址、不需要回调 URL，也不需要 Verification Token**。

**准备**（飞书开放平台，约 3 分钟）：

1. 创建**企业自建应用** → 添加「机器人」能力。
2. 权限：`im:message`（接收消息）与 `im:message:send_as_bot`（发消息）。
3. 事件订阅：添加事件 `im.message.receive_v1`（接收消息 v2.0）。
4. 事件接收方式选**「长连接」**（推荐，不需要填写请求地址）。若只能用 HTTP 回调：请求地址填 `https://<你的公网地址>/feishu/events`，并记下事件订阅页的 Verification Token（开启「加密策略」时再记 Encrypt Key）。
5. 把凭证写进 `~/.steve/.env`（或直接 export）：

```bash
FEISHU_APP_ID="cli_xxxxxxxxxxxxxxxx"
FEISHU_APP_SECRET="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
# FEISHU_MODE="ws"                 # ws（默认，长连接）| http（旧回调）
# FEISHU_VERIFICATION_TOKEN="..."   # 仅 http 模式需要
# FEISHU_ENCRYPT_KEY="..."          # 仅 http 模式且开启加密时需要
```

**运行**：`steve-serve --port 8892`（默认长连接），启动日志出现 `feishu bot: on (long connection, ...)` 即生效。切换方式：`--feishu-mode http` 用回调、`--feishu-mode off` 或 `--no-feishu` 关闭；管理后台「网关」页也能切换并查看连接状态。长连接依赖 optional 依赖 `ws`（本仓库 devDependencies 已含；部署时若未安装，启动会记录错误并禁用飞书）。

**长连接行为**：

- 启动时用 App ID / App Secret 调 `POST /callback/ws/endpoint` 换取 WebSocket 地址，随后主动连接（不校验 Verification Token，连接本身用应用凭据认证）。
- ping/pong 保活；断线后**重新请求发现端点**（地址可能变化），并按飞书下发的间隔做指数退避重连，连接成功日志为 `long connection ready (service_id=…)`。
- 大事件按 `sum`/`seq` 分片，收齐后重组；每条事件处理完回 ack `{"code":200}`。
- **凭据错误视为 fatal**：发现端点返回 HTTP 403 或飞书 code 403/514 时只尝试一次就停止重连，日志写明原因，管理后台「网关」页显示「已停止（配置错误）」；HTTP 服务与其它功能不受影响。改好凭证重启即可。
- 国际版 Lark 用 `FEISHU_API_BASE=https://open.larksuite.com` 即可，协议与飞书一致。
- 事件到流的映射与回复逻辑和 HTTP 模式完全一致。

**HTTP 回调模式额外说明**：`/feishu/events` 必须先 `200` ACK（飞书 3 秒超时重投）；该路径不走 `--token` 的 Bearer 鉴权（飞书回调无法带自定义头），改用 Verification Token 与（开启加密时的）`X-Lark-Signature` 校验；其余接口仍然要 token。长连接模式下不再注册 `/feishu/events`（返回 404）。

**公共行为**：

- 回复通过 `POST /open-apis/im/v1/messages/:message_id/reply`（tenant_access_token 进程内缓存，提前 2 分钟刷新）。
- 处理文本、图片与富文本（`post`）消息；`@_user_1` 之类的 mention key 会被剥掉；语音 / 文件等其他类型、机器人自己发的消息、未知事件类型只记日志不回复。
- 按 `event_id` 去重（飞书超时会重投）。
- 同一 chat 的 stream 串行执行：新消息若顶掉正在跑的 run，旧 run 的回复会带「执行被取消」。
- 权限仍走 `steve-serve` 的 `--access` 与审批策略：需要审批（permission: ask）的工具在常驻进程里不会弹窗，会被拒绝并写进事件流；只读/只写类工具按 `--access` 放行。
- 回复的是 agent 的最终文本（工具调用过程不推给飞书）。超过 8000 字拆成多条发送，不是截断。

**消息格式**：飞书对同一个 `msg_type` 的渲染规则不一样，选错了用户就会读到源码。

| `msg_type` | 渲染什么 | 我们用在哪 |
| --- | --- | --- |
| `text` | 什么都不渲染：`## 标题`、`\| 列 \| 列 \|` 原样显示 | 纯散文回复 |
| `post` | `md` 元素里渲染标题、表格、代码块、列表、加粗、链接 | 含任何 Markdown 结构的回复 |

判断规则在 `src/model/feishu-markdown.ts` 的 `looksLikeMarkdown()`：表格、标题、列表、围栏代码块、行内代码、加粗、删除线、链接、引用任一出现就发 `post`。单个 `*`、行内提到 `#1` 这类不算，散文仍然是 `text`。

三个细节值得知道：

- **代码块单独成行**：`post` 的内容是二维数组，围栏代码块独占一行。飞书的 `md` 渲染器在同一个元素里遇到围栏会把后面的内容吞掉，合在一起写会丢字。
- **`post` 被拒时降级**：老租户或某些构造会被回 `content format of the post type is incorrect`，此时自动改成 `text` 重发，内容是剥掉 Markdown 符号的纯文本（`stripMarkdown()`）——符号去掉但内容和链接地址都在，比一条发不出去的消息好。
- **按块判断而不是按整条**：分块后的每一块各自决定 `text`/`post`，所以一条长回复里「一半表格一半散文」时，两半都能以正确的形态到达。

**飞书卡片**：agent 可以自己决定用卡片回复。只有由飞书消息启动的那次 run 才会拿到 `send_feishu_card` 工具（普通后台 run、CLI、ACP 都没有——卡片必须回给某个具体消息），模型按需调用：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `body` | ✅ | Markdown 正文（列表、加粗、代码块都会渲染），就是用户读到的那条回复 |
| `title` | | 卡片标题栏文字，省略则无标题栏 |
| `theme` | | 标题栏颜色：`blue`/`wathet`/`turquoise`/`green`/`yellow`/`orange`/`red`/`carmine`/`violet`/`purple`/`indigo`/`grey`；未知值回落 `blue` |

- 模型传的是字段而不是原始卡片 JSON：嵌套写错只会收到一条「Card not sent: …」的工具结果并重试，不会出现用户收不到回复的情况。
- 发过卡片后，服务端不再补发同内容的纯文本（否则一次提问收到两条消息）；run 若在发卡后失败，仍会补一条错误文本。
- 正文有 20000 字上限，标题超长会截断而不是报错；空正文直接拒绝。
- 卡片是"要不要用"由模型判断：表格、多段、成功/失败的彩色标题适合，一句话回答就正常说。

**卡片里的代码块**：卡片的 `markdown` 元素是行内 Markdown，列表、粗体、链接、表格都渲染，**围栏代码块不渲染**——用户看到的是带反引号的源码。所以正文会被切成一组元素：

| 正文片段 | 卡片元素 |
| --- | --- |
| 普通文字 | `{"tag":"markdown","content":…}` |
| ```` ```ts … ``` ```` | `{"tag":"code_block","language":"typescript","text":…}` |

`segmentCardBody()` 做这个切分：语言归一化（`ts`→`typescript`、`py`→`python`，未知语言/无语言回落 `plaintext`），代码块之间的散文各自成元素。没闭合的围栏不会被当成代码一直吞到正文末尾——那样一次漏写收尾反引号就会让整篇回答变成一个灰块。

**图片**：直接发图即可，不需要配文字。飞书里"发图"其实有两种形态，两种都收：

| 飞书里的动作 | `message_type` | 处理方式 |
| --- | --- | --- |
| 只发图 / 相册转发 | `image` | 按 `image_key` 取原图 |
| 图片 + 文字、粘贴、拖拽、转发对话 | `post`（富文本） | 二维数组逐段解析，文字拼成一行、图片按阅读顺序取出，两者一起进 run |

收图走**消息资源接口**：`GET /open-apis/im/v1/messages/:message_id/resources/:image_key?type=image`。
必须带 `message_id` —— 只拿 `image_key` 去调 `im/v1/images/:key` 会被飞书回 `234001 Invalid request param.`，
因为那个接口要的是另一类资源。

**大于 2 MiB 的图会分块取**：先发 `Range: bytes=0-0` 探测，回 206 就按 `Content-Range` 拿总长，
再按 8 MiB 一块续取拼回；回 200 说明服务端忽略了 Range、整包已经在手，直接用。直接整包取的话
飞书会在 2 MiB 处截断（`code 234037`），拼出来的图是坏的。

**MIME 按魔数判定**，不信 `content-type`：PNG/JPEG/GIF/WEBP/BMP 认不出才回落。

**图片不进日志正文**：base64 动辄几 MB，留在日志里会把单事件上限撞爆、连带把整条消息截断。
写入时换成 `{ ref: "blob:<sha256>", mimeType }`，字节落到 `~/.steve/blobs/<sha256>` 并按内容去重；
折叠 transcript 时再读回来。blob 丢了只会少那张图，消息和文字都还在。

失败时写两条日志：`feishu: image fetch <完整 URL> -> <状态码> <飞书原话（code N）>` 和
`feishu: image download failed for <message_id>: …`。回复只说失败，但排查时真正需要的是那个
URL 和错误码 —— 前者能看出 type 和 key，后者能区分「type 不对」「key 不存在」「没有权限」。

| 情况 | 结果 |
| --- | --- |
| 默认（图片支持开启） | 图片随这条消息一起进 run，模型能看见 |
| 供应商里关掉了「支持图片」，或 `LLM_IMAGES=0` | 回一条「这张图没有发给模型」并说明怎么打开，不静默丢图 |
| 勾着但网关不认图（400） | 回「这张图没能发给模型 + 你该怎么办」，附网关原话 |
| 格式不在 PNG / JPEG / GIF / WebP | 回具体原因（例如 HEIC 请先转换） |
| 超过 10 MB | 回「有 X MB，超过 10.0 MB 的上限，请压缩后再发」 |
| 图片下载失败 | 回「图片下载失败：…」，日志里带飞书的 `code`/`msg` 与试过的 type |

- 一张图坏掉就整批拒收：只送好的那几张会让模型回答"半个问题"，而用户以为它看全了。
- 纯图片消息的文本会填成「请看这张图片。」，因为模型需要一个可读的提问；富文本自带文字时用原文，不补这句。
- 多图（相册转发）按 `{"image_key": ["a","b"]}` 解析，顺序保持原样。

**限制**：群聊需 @ 机器人；入站消息只处理文本、图片和富文本（富文本里的语音/文件只记一句「［附件］」），单独的语音 / 文件消息不处理；HTTP 回调需要公网可达地址与 Verification Token。

## Watch 与后台运行

`~/.steve/watch.json` 的条目会被内置插件 `watch-config` 校验后交给触发器引擎；命中后引擎追加
`trigger.fired` 与一条以 `[watch:<name>] ` 开头的 `user.message`，常驻进程随即把它当输入交给 worker
（`append:false`，不重复写输入事件），默认 `mode:"background"`。

后台 run 的执行规则（安全边界）：

- 工具集来自环境快照；**需要审批的工具**不会直接执行，而是追加 `approval.pending` 并挂起，
  等前端调 `POST /streams/:id/approvals` 放行；默认 10 分钟无响应按拒绝处理（run 不会被静默放行）。
- webhook 触发器在 `~/.steve/watch.json` 里配 `secret` 后按 `X-Signature: HMAC-SHA256(secret, body)` 校验；
  监听非回环地址时**没有 secret 的 webhook 触发器会被拒绝加载**。
- `--no-watch` 时 `POST /hooks/*` 一律 `404 {"error":"watch disabled"}`。

`~/.steve/watch.json` 示例（与 `docs/personal-agent.md` §5.5 一致）：

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
- 图片输入会以 blob 形式落 `~/.steve/blobs/`（按 sha256 去重），HTTP body 上限 8 MiB。
