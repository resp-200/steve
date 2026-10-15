# steve ACP Server 指南

本文说明 steve 作为 **ACP（Agent Client Protocol）服务端**怎么启动、编辑器怎么接、线上协议长什么样。
所有结论都对应源码：`src/protocols/acp/*`、`web/acp-http-client.js`，并在这台机器上实测过（IDEA 2025.3、内置测试页、Node 客户端）。

---

## 1. 数据流

```
编辑器（client）                      steve（agent）
  │  stdio / Streamable HTTP / WS          │
  ├─ initialize ──────────────────────────▶ 记录 clientCapabilities（fs / terminal）
  ├─ session/new ─────────────────────────▶ 建 AgentRuntime：工具集、策略、插件、MCP
  │                                         │
  │◀──── session/update（流式）─────────────┤  text / thinking / tool_call / usage / commands
  ├─ session/prompt ──────────────────────▶ agent.prompt()
  │                                         │
  │◀──── session/request_permission ────────┤  写/执行类工具先问人
  ├─ fs/read_text_file, terminal/* ───────▶  反向：agent 请求客户端执行
  │                                         │
  └─ session/cancel ──────────────────────▶ agent.abort()
```

要点：**协议层不认识 pi，也不认识任何工具名**。它只说功能层的事件词表（`src/features/events.ts`），
工具卡片（kind/标题/diff）全部来自工具自己的声明。

---

## 2. 启动

```bash
npm run build

# 编辑器默认方式：stdio
node dist/protocols/acp/main.js

# TCP 端口：Streamable HTTP + WebSocket（--port 一给，transport 自动变 http）
node dist/protocols/acp/main.js --port 8890 --token secret

# 额外允许浏览器跨域调用（默认关闭）
node dist/protocols/acp/main.js --port 8890 --cors "*"

# 客户端没有 fs/terminal 能力时，回退到本机文件/命令工具（默认关闭，见 §6）
node dist/protocols/acp/main.js --port 8890 --allow-local-tools
```

`--port` 模式下默认还会在 `/` 提供内置浏览器测试页（`--no-ui` 关闭）。

### 2.1 一键启动脚本（远程 / 云）

`scripts/steve-acp-serve.mjs` 把上面那串参数固定下来，token 不用每次手敲。它同时是包里的第三个 bin，
所以三种跑法等价：**装过就 `steve-acp-serve`**、仓库里 `npm run acp:serve`、或 `node scripts/steve-acp-serve.mjs`。
用 Node 写而不是 bash —— Windows / macOS / Linux 行为一致，不需要 bash、`nohup` 或 `/dev/tcp`。

```bash
# 只需一次：生成 token 并写进 ~/.steve/.env（steve 自己不读 ACP_TOKEN，是脚本读出来再 --token 传进去）
umask 077 && printf 'ACP_TOKEN=%s\n' "$(openssl rand -hex 32)" >> ~/.steve/.env

steve-acp-serve                    # 前台（装过就是 PATH 上的命令）
steve-acp-serve --daemon            # 后台：日志与 pidfile 落在 ~/.steve/log/
steve-acp-serve --stop              # 停掉 --daemon 起的那个实例（按端口）
steve-acp-serve --help              # 本脚本的开关 + steve-acp 的完整参数表

npm run acp:serve -- --daemon       # 在仓库里等价；node scripts/steve-acp-serve.mjs --daemon 也行
# → endpoint http://127.0.0.1:8891/acp · 页面 http://127.0.0.1:8891/
```

默认值：`127.0.0.1:8891`、`--path /acp`、`~/.steve/sessions`（自动 `mkdir -p`）、`--permissions ask`、
`--allow-local-tools`、`--quiet`；启动摘要打到 stderr。

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `STEVE_ACP_ENV_FILE` | `~/.steve/.env` | token 从哪个文件读 |
| `ACP_TOKEN` | — | 直接给 token，优先于文件（与 steve「真实环境变量最优先」一致） |
| `ACP_HOST` / `ACP_PORT` / `ACP_PATH` | `127.0.0.1` / `8891` / `/acp` | 对外服务先反代，直接暴露才写 `0.0.0.0` |
| `ACP_SESSION_DIR` | `~/.steve/sessions` | transcript 落盘位置 |
| `ACP_PERMISSIONS` | `ask` | `ask` \| `allow`（`allow` 不问直接执行写/命令，慎用） |
| `ACP_ALLOW_LOCAL_TOOLS` | `true` | `false` 则不给本地文件/命令工具 |
| `ACP_QUIET` | 前台 `true` / `--daemon` 时 `false` | `false` 打开 steve 自己的日志 |
| `ACP_CORS` | 空 | 只在「页面与端点不同源」时需要，如 `*` |
| `STEVE_ACP_LOG_DIR` | `~/.steve/log` | `--daemon` 的日志与 pidfile 目录 |

额外参数原样透传给 `steve-acp`，且能覆盖上面的默认值（`node scripts/steve-acp-serve.mjs --port 9000` —— steve 后写的 flag 生效，摘要会跟着改）。
缺 token、端口被占用都会先给人话提示再退出，不会静默起一个没有认证的服务。

命令优先用 PATH 上的 `steve-acp`，没装则退回仓库的 `dist/protocols/acp/main.js`（先 `npm run build`）。
cwd 就是启动目录 —— `.steve/mcp.json` 与 `.steve/extensions/` 按 cwd 发现。

#### 后台运行与日志

`--daemon` 把服务脱离父进程丢到后台（Node `spawn({ detached: true })`，不是 `nohup`），
日志和 pidfile 按端口命名，多实例互不覆盖：

```bash
npm run acp:serve -- --daemon
# steve-acp-serve: 后台运行 pid=12345
# steve-acp-serve: 日志 tail -f ~/.steve/log/steve-acp-8891.log

tail -f ~/.steve/log/steve-acp-8891.log    # 服务日志
npm run acp:serve -- --stop                # 停：POSIX 发 SIGTERM（steve 优雅关闭），Windows 用 taskkill /T
```

| 文件 | 说明 |
| --- | --- |
| `~/.steve/log/steve-acp-<port>.log` | 追加写入；启动横幅 + steve 的 `[acp]` 日志（后台模式默认关掉 `--quiet`，否则日志里几乎只有错误） |
| `~/.steve/log/steve-acp-<port>.pid` | pidfile，`--stop` 读它；进程不在了会提示并清掉 |

几个行为细节：

- 后台模式默认 `ACP_QUIET=false`（前台仍默认安静），显式设 `ACP_QUIET` 则按你给的来。
- 启动后等 1 秒确认进程还活着，立刻退出（配置错、端口被抢）就把日志末尾 20 行打出来并以 1 退出，不会留下假 pidfile。
- 端口被占用时先报错再退出，所以重复 `--daemon` 不会起出第二个实例。
- 日志是追加写的，长期跑要自己轮转（Linux `logrotate`，或 `: > ~/.steve/log/steve-acp-8891.log` 手动清空）。
- 真要开机自启 / 崩溃重启，交给系统服务：Linux `systemd`、macOS `launchd`、Windows `nssm` / `sc.exe`。
  它们都用 `--foreground` 让进程待在**前台**，日志交给 journald / 事件日志，别用 `--daemon`。
- Windows 上没有 `nohup` / SIGTERM 语义：`--daemon` 用 Node 的 detached spawn，`--stop` 用 `taskkill /T /F`
  杀进程树（否则 MCP 子进程会留下）。

### 2.2 token 管什么、不管什么

`--token` 是 HTTP 模式下**唯一**的访问控制（`transport.ts`），且只作用于 ACP 端点：

| 位置 | 行为 |
| --- | --- |
| `POST/GET/DELETE /acp` | 头不是 `Authorization: Bearer <token>` → **401** |
| `/acp` 的 WebSocket upgrade | 头不对 → 直接 `socket.destroy()` |

- **不配 token = 没有认证**：连上 `/acp` 就能 `initialize` → `session/new` → `session/prompt`，也就是花你的模型额度、
  用客户端给的 `cwd` 读写服务器文件、跑命令（开了 `--allow-local-tools` 时）、`session/load` 读回历史 transcript、`session/delete` 删文件。
- **只管 `/acp`**：`/`、`/index.html`、`/test-acp-jsonrpc.html`、`/acp-http-client.js` 一律不校验，而且 `/` 会把服务端 `process.cwd()` 注入进 HTML。
  公网部署用 `--no-ui`，测试页用本地 `file://` 打开。
- **不是身份系统**：一个全局共享密钥，没有用户、没有权限分级、没有过期、没有速率限制、没有审计；比较是普通 `!==`（非 timing-safe）。
  Bearer 头必须有 TLS 保护；浏览器页支持 `?token=`，会漏进浏览器历史、Referer 与反代日志。
- 生成用 `openssl rand -hex 32`（或 `rand -base64 32` 的 base64url 版本）。hex 最省事：`?token=` 场景下 `+ / = # &` 容易被 URL 解析吃掉。
- token 持有者≈该工作区的 root：真正的隔离靠容器 / 非 root / 只读挂载 / `--permissions ask`，不是靠 token。
  要多用户、要吊销、要限流，得在反代层做（OAuth / mTLS / Cloudflare Access 之类）。

### 全部参数

| 参数 | 环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--transport <stdio\|http>` | `ACP_TRANSPORT` | 给了 `--port` 就是 `http`，否则 `stdio` | 传输方式 |
| `--port <n>` | `ACP_PORT` | — | 监听端口 |
| `--host <addr>` | `ACP_HOST` | `127.0.0.1` | 绑定地址 |
| `--path <path>` | `ACP_PATH` | `/acp` | ACP 端点路径 |
| `--token <token>` | `ACP_TOKEN` | — | 要求 `Authorization: Bearer <token>`（仅 http） |
| `--ui` / `--no-ui` | `ACP_UI` | 开 | 在 `/` 提供测试页 |
| `--cors <origins>` | `ACP_CORS` | 关 | 允许的浏览器来源，逗号分隔或 `*` |
| `--permissions <ask\|allow>` | `ACP_PERMISSIONS` | `ask` | `allow` = 不问直接执行（慎用） |
| `--allow-local-tools` | `ACP_ALLOW_LOCAL_TOOLS=true` | 关 | 见 §6 |
| `--session-dir <path>` | `ACP_SESSION_DIR` | `<cwd>/.steve/sessions` | transcript 存放位置 |
| `--no-sessions` | — | — | 不持久化：没有 `session/load` 能力 |
| `--extension <path>` | `STEVE_EXTENSIONS=a,b` | — | 加载插件，可重复 |
| `--no-discovery` | `STEVE_DISCOVERY=off` | — | 只加载显式指定的插件 |
| `--quiet` | — | — | 只留警告与错误 |
| `--help` | — | — | 用法 |

> stdio 模式下 **stdout 只走协议**，所有日志都写 stderr；`--quiet` 只留错误。

---

## 3. 编辑器接入

### 3.1 IDEA 2025.3（实测）

IDEA 的"添加自定义智能体"打开的是 **`~/.jetbrains/acp.json`**（不是 Zed 的 settings.json）：

```jsonc
{
  "default_mcp_settings": {},
  "agent_servers": {
    "steve": {
      "command": "steve-acp",     // 或用绝对路径，见 §3.3
      "args": []
    }
  }
}
```

IDEA 会把它自己的 MCP 配置随 `session/new` 传进来（`default_mcp_settings` 为空时就是不带）。

### 3.2 Zed

```jsonc
// ~/.config/zed/settings.json
{
  "agent_servers": {
    "steve": {
      "command": "node",
      "args": ["/绝对路径/steve/dist/protocols/acp/main.js"]
    }
  }
}
```

### 3.3 编辑器里的两个坑（都踩过）

1. **PATH**：GUI 应用的 PATH 与终端不同。IDEA 读登录 shell 的 PATH（含 nvm 的 bin），所以 `command: "steve-acp"` 能用；
   从 Dock 启动、PATH 更窄的编辑器则不行。**最稳的写法是绝对路径**：

   ```jsonc
   // GUI 应用的 PATH 可能很窄，写死两个绝对路径最稳。下面用占位符，按你的机器替换：
   //   which node    → node 的绝对路径
   //   npm root -g   → 全局 node_modules 目录（脚本在 <它>/steve/dist/protocols/acp/main.js）
   { "command": "<which node 的输出>",
     "args": ["<npm root -g 的输出>/steve/dist/protocols/acp/main.js"] }
   ```

   注意：只把 `command` 指向 `steve-acp` 软链**不够** —— 它的 shebang 是 `#!/usr/bin/env node`，`env` 还要能在 PATH 里找到 `node`。

2. **初始化超时**：编辑器对 `session/new` 有超时，超了就杀进程（IDEA 报 `Failed to initialize ACP process … exit code 143`）。
   所以 steve **不在 `session/new` 里等 MCP**（见 §8），响应通常 < 30ms。

### 3.4 凭据从哪来

编辑器不必在配置里写 key。按优先级（低 → 高）：`<安装目录>/.steve/.env` → `~/.steve/.env` → `$PWD/.steve/.env`，
真实环境变量永远最优先。详见 [`model-integration.md`](./model-integration.md#2-配置文件的位置与优先级)。

---

## 4. 线协议（Streamable HTTP）

stdio 模式就是换行分隔的 JSON-RPC 2.0；HTTP 模式是 ACP 的 Streamable HTTP，握手顺序如下（curl 实测）：

```
1) POST /acp  initialize                       → 200 + 响应头 acp-connection-id: <uuid>
2) GET  /acp  Accept: text/event-stream
              Acp-Connection-Id: <uuid>        → 连接级 SSE（一条连接只能有一个活跃接收者，重复开 → 409）
3) POST /acp  session/new  (+ Acp-Connection-Id) → 202（响应从连接级 SSE 回来）
4) GET  /acp  Acp-Session-Id: <sessionId>       → 会话级 SSE：session/update 与带 params.sessionId 的响应都从这里回
5) POST /acp  session/prompt (+ Acp-Connection-Id + Acp-Session-Id) → 202
```

实测的响应头与状态码：

| 情况 | 结果 |
| --- | --- |
| 没有 `Authorization: Bearer <token>`（配了 `--token` 时） | **401**（见 §2.2） |
| `POST initialize` | **200** + `acp-connection-id` |
| 带 `params.sessionId` 的请求**缺少** `Acp-Session-Id` 头 | **400** |
| 不带 sessionId 的请求（如 `session/new`） | **202**，响应走连接级 SSE |
| 同一个连接开第二条连接级 SSE | **409** |
| `OPTIONS` 预检（`--cors` 开启时） | **204** + CORS 头 |

CORS / 私网访问（`file://` 打开的测试页会用到）：

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
Access-Control-Allow-Headers: content-type, authorization, acp-connection-id, acp-session-id
Access-Control-Expose-Headers: acp-connection-id
Access-Control-Max-Age: 600
Access-Control-Allow-Private-Network: true
```

---

## 5. 方法与能力

`initialize` 返回的 `agentCapabilities`（实测原文）：

```json
{
  "loadSession": true,
  "promptCapabilities": { "image": false, "audio": false, "embeddedContext": true },
  "sessionCapabilities": { "additionalDirectories": {}, "list": {}, "delete": {} }
}
```

| 方法 | 说明 |
| --- | --- |
| `initialize` | 记录客户端能力（`fs` / `terminal`），据此决定注册哪些工具 |
| `session/new` | 建会话：插件、策略、MCP 全部在这里落地 |
| `session/load` | 从磁盘恢复会话并**回放历史**（`user_message_chunk` / `agent_message_chunk` / `agent_thought_chunk` / `tool_call*`） |
| `session/list` | 列出已保存会话（可按 `cwd` 过滤） |
| `session/delete` | dispose 活会话（abort + 关 MCP 子进程）并删文件，幂等 |
| `session/prompt` | 一轮对话；返回 `stopReason` + 累计 usage |
| `session/cancel` | 中断本轮（`stopReason=cancelled`，**不重试**） |

`promptCapabilities.image: false` 是因为 `buildModel()` 目前固定 `input: ["text"]`（见 model-integration.md §4.3）——
模型不支持图片时，图片会被丢掉而不是报错。

**一条顺序约束**（曾经导致编辑器一直卡在 `Starting …`）：`session/new` 的**响应必须先于**该会话的
`session/update`。客户端收到一个"未知 session 的更新"会把整次会话初始化当成失败并反复重试。
实现上是 `setImmediate` 播报命令列表（`announceLater()`），`arch:test` 也有断言盯着这条。

---

## 6. 工具与权限

| 来源 | 注册条件 | 例子 |
| --- | --- | --- |
| **客户端工具**（`protocols/acp/tools.ts`） | 客户端在 `initialize` 里声明了 `fs` / `terminal` | `read_file` / `write_file`（走 `fs/*`）、`run_command`（走 `terminal/*`） |
| **本地工具**（内置插件 `local-tools`） | `--allow-local-tools`（`workspace.access = "exec"`） | 同名的 `read_file` / `write_file` / `run_command`，外加 `glob` / `grep` / `edit_file` |
| **MCP 工具** | 客户端传入或插件声明 | `mcp__<server>__<tool>` |
| **插件工具** | 插件 `registerTool()` | 由插件决定 |

同名时**客户端工具优先**，本地插件那条被丢弃并记日志（`tool "read_file" from a plugin ignored: …`）。
所以 `--allow-local-tools` 的效果是"补上编辑器没有的工具"，而不是替换。

权限：

- 写/执行类工具**默认先问**（`--permissions allow` 可关）。问题以 `session/request_permission` 发给编辑器，
  `toolCall.title` 是一行摘要，`toolCall.content` 可能带 `{ type: "diff", path, oldText, newText }`，编辑器可直接渲染。
- 拒绝 → 闸门返回 `{ block: true }` → 变成一次 `isError` 工具结果回灌给模型（模型可以自己换招）。
- "总是允许"只记在当前会话的闸门里，不跨会话。

---

## 7. 会话持久化

每个会话的 transcript 存到 `<session-dir>/<id>.json`（默认 `<cwd>/.steve/sessions`，`--no-sessions` 关闭）。
`session/load` 会读回它、回放给客户端、并把该会话重新挂上（编辑器重启后能接着聊）。

- 文件格式与 CLI 共用（`features/session-store.ts` 的 `sessionRecord()` 是唯一的记录装配处）。
- 写入是"临时文件 + rename"，崩溃不会留下半个 transcript。
- 任何持久化失败都只记日志并吞掉：丢历史不能影响对话本身。

---

## 8. MCP 在 ACP 里怎么挂（要点，细节见 [`mcp.md`](./mcp.md)）

- **来源**：ACP 客户端在 `session/new` / `session/load` 传的 `mcpServers`（标 `client`）+ 插件声明的（标 `plugin`）+ `.steve/mcp.json`。
- **不阻塞**：`session/new` 立即返回，MCP 在后台连；**每个 server 一连上就立刻挂到会话**（一个慢 server 不拖累其它）。
- **子进程 cwd** = 会话 cwd，所以 `args: ["."]`、相对脚本路径都指向项目目录。
- 会话结束 / `session/delete` 时关闭子进程。

---

## 9. 验证工具

| 工具 | 用途 |
| --- | --- |
| `npm run acp:client -- "问题"` | 完整 ACP 客户端（stdio / `--http` / `--ws`），可在真编辑器之外验证；**可从任意目录运行** |
| `npm run acp:probe -- --url http://127.0.0.1:8890/acp "run ls"` | Node 版 HTTP 客户端（与测试页共用 `web/acp-http-client.js`） |
| `npm run acp:ui-test -- --url http://127.0.0.1:8890/` | headless Chrome 驱动真实测试页（`http://` 与 `file://` 都支持） |
| `scripts/acp-tap.mjs` | **协议探针**：夹在编辑器与 agent 之间，把双向 JSON-RPC 写进文件（排查"编辑器到底发了什么"） |
| 测试页 `/` | 浏览器里手动连、看原始 JSON-RPC 日志、模拟 client 能力 |

抓包探针的用法（编辑器只转 agent 的 stderr，看不到客户端方向）：

```jsonc
// ~/.jetbrains/acp.json 临时改成
{ "agent_servers": { "steve": { "command": "node",
    "args": ["/path/to/steve/scripts/acp-tap.mjs"] } } }
```

```bash
tail -f <项目>/.steve/acp-tap.log      # → client / ← agent，一行一条消息
```

---

## 10. 排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `Failed to initialize ACP process` / 进程被 SIGTERM（143） | 初始化太慢被杀。升级到会后台连 MCP 的版本；或把慢 server（`npx -y …`）预装/预热 |
| 一直卡在 `Starting <agent>…`，日志里只有 `session/new` 没有 `session/prompt` | 客户端没把消息发出来：换新会话（配置变更后 IDEA 会提示"请开始新的聊天"），必要时重启编辑器；用探针确认 |
| `session/new` 的响应先于/后于 `session/update` 顺序错乱 | 已修（`announceLater()`）；`arch:test` 有断言 |
| HTTP **401** | `--token` 配了但请求没带 `Authorization: Bearer` |
| HTTP **400**（带 `params.sessionId` 的请求） | 少了 `Acp-Session-Id` 头（先 `GET` 开该会话的 SSE） |
| HTTP **409** | 同一连接开了第二条连接级 SSE |
| 浏览器里连不上（`file://` 或跨域） | 服务端要 `--cors "*"`；私网访问还需要 `Allow-Private-Network`（已自动补） |
| `unsupported — transport "http"` | MCP 只实现了 stdio |
| 编辑器里没有 `run_command` | 客户端没声明 `terminal` 能力（IDEA 2025.3 就是 `terminal=false`）；需要本机执行就加 `--allow-local-tools` |

---

## 11. 代码位置

| 文件 | 职责 |
| --- | --- |
| `src/protocols/acp/main.ts` | CLI 参数、`loadConfig()`、装配 `AgentApp` 与传输 |
| `src/protocols/acp/transport.ts` | stdio（`ndJsonStream`）/ Streamable HTTP + WebSocket / 静态托管测试页 / CORS |
| `src/protocols/acp/agent.ts` | 每个连接一个 `AgentApp`：方法处理、会话表、策略发布、后台连 MCP |
| `src/protocols/acp/session.ts` | 一个会话 = 一个 `AgentRuntime`：事件 → `session/update`、权限、取消、持久化、回放、命令拦截 |
| `src/protocols/acp/tools.ts` | 客户端工具（`fs/*`、`terminal/*`），自带 `permission`/`metadata`/`describe` |
| `src/protocols/acp/tool-call.ts` | 工具卡片内容块（文本 / 图片 / 内嵌终端 / diff） |
| `src/protocols/acp/content.ts` | ACP ContentBlock ↔ provider 无关的文本/图片 |
| `web/acp-http-client.js` | 浏览器与 Node 共用的 HTTP client（测试页内联的那份由 `npm run acp:ui-sync` 生成） |
| `scripts/acp-tap.mjs` | 协议探针 |
| `scripts/{acp-client,acp-http-probe,acp-ui-test}.mjs` | 三种验证方式 |
