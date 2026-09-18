# steve

一个最小但完整的流式对话 Agent：直接基于 **`@earendil-works/pi-agent-core`**（Agent 循环 / 状态 / 工具 / 事件）与 **`@earendil-works/pi-ai`**（各家模型 API 的统一流式适配层）编写，**不依赖 `pi-coding-agent`**。

- 终端里流式输出文本与思考过程（thinking）
- 内置 3 个可被模型调用的工具（计算器 / 时间 / mock 天气），支持并行工具调用
- 支持三种线上协议，切换只改 `.env`：
  `anthropic-messages`、`openai-completions`、`openai-responses`
- 失败自动重试，并把失败轮次从上下文里剔除后再重试
- 通过 **ACP（Agent Client Protocol）** 把同一个 Agent 暴露给编辑器客户端（Zed 等）：stdio + Streamable HTTP/WebSocket 两种传输
- 零运行时依赖（pi 两个包 + ACP SDK），另带一个离线 mock server 和 ACP 客户端脚本方便本地验证

## 分层

自下而上五层，**只允许上层依赖下层，同层之间不互相依赖**：

| 层 | 目录 | 职责 |
| --- | --- | --- |
| L1 入口 | `src/entries/` | 进程入口：CLI（REPL / 单次提问 / slash 命令）与 ACP 的启动参数 |
| L2 协议 | `src/protocols/acp/` | ACP 服务端：传输、方法处理、`session/update` 映射、由客户端执行的工具 |
| L3 功能 | `src/features/` | 会话运行时与策略：事件归一化、失败重试与回滚、权限判定、本地工具、统计 |
| L3′ 拓展 | `src/extensions/`（规划中） | 插件宿主：发现 / 加载 / 隔离扩展；与功能层平级，只对功能层的接缝说话 |
| L4 内核 | `src/kernel/` | **唯一**装配 pi-agent-core `Agent` 的地方：streamFn、上下文净化、thinking 等级、hooks |
| L5 模型 | `src/model/` | pi-ai 对接：`.env` / `AppConfig`、`Model` 构造、`StreamFn`（协议路由 + 鉴权 + 错误编码进流） |

```
src/types.ts             跨层共享类型（Logger 等，零依赖）
src/entries/cli.ts       L1 CLI：REPL / 单次提问 / slash 命令 / Ctrl+C 中断
src/entries/render.ts    L1 归一化事件 -> 终端渲染（文本、thinking、工具调用、失败）
src/protocols/acp/*      L2 ACP 服务端（main / agent / session / transport / tools / content / tool-call）
src/features/runtime.ts  L3 会话运行时：事件归一化、失败重试与回滚、reset、统计
src/features/events.ts    L3 事件词表：这以上（协议/入口）只说这套事件
src/features/permissions.ts L3 权限策略：哪些工具要问人、allow_always 记忆
src/features/contract.ts  L3 工具契约：协议层定义工具的唯一入口（TypeBox/AgentTool）
src/features/tools.ts     L3 3 个 AgentTool 示例
src/kernel/agent.ts      L4 createKernelAgent()：唯一组装 pi Agent 的位置
src/model/config.ts      L5 .env 读取 + 构造 pi 的 Model（api / baseUrl / compat / 鉴权方式）
src/model/stream.ts      L5 StreamFn：按 model.api 路由到 pi-ai 适配器，错误编码进流
web/*                    ACP over HTTP 浏览器/Node 通用 client（测试页与 probe 共用）
test-acp-jsonrpc.html    浏览器 ACP 测试页（由 --ui 提供）
scripts/*                离线 mock 网关 + ACP 测试客户端 / probe / headless 浏览器测试
```

CLI 与 ACP 走的是同一个内核装配点，所以「接 pi 的位置」只有一处；协议层不碰 pi 的类型，只把功能层的事件翻译成 ACP 的 `session/update`。

数据流：

```
   用户输入 ─▶ 入口层 ─▶ 功能层（runtime / ACP session） ─▶ createKernelAgent()   ← src/kernel/agent.ts
                                                              │ 组装 Context(systemPrompt, messages, tools)
                                                              ▼
                                                streamFn(model, context, options)  ← src/model/stream.ts
                                                              ▼
                                    pi-ai 适配器 (anthropic-messages / openai-completions / openai-responses)
                                                              ▼
                              AssistantMessageEventStream ──事件──▶ AgentEvent ─▶ Renderer / session/update
                                                              ▼
                                toolCall? ─▶ hooks.beforeToolCall ─▶ 执行工具 ─▶ 结果回灌 ─▶ 下一轮（直到 stop）
```
## 快速开始

```bash
npm install
cp .env.example .env      # 填 LLM_API_KEY / LLM_MODEL_ID / LLM_BASE_URL
npm run dev               # 交互式对话
npm run dev "现在几点？顺便算一下 128*37+15"   # 单次提问
npm run build && npm start
```

当前 `.env` 指向 Anthropic Messages 格式的网关（`https://your-gateway.example.com/anthropic`），`LLM_API` 未设置时会根据 `LLM_BASE_URL` 自动判定为 `anthropic-messages`。

`npm run mock` 会用自带的离线 mock server（`scripts/mock-server.mjs`）替代真实网关，三种协议都支持，无需 key、不联网：

```bash
npm run mock &            # 监听 127.0.0.1:8899
# Anthropic Messages
LLM_API_KEY=mock LLM_MODEL_ID=mock LLM_BASE_URL=http://127.0.0.1:8899/anthropic npm run dev
# OpenAI chat completions
LLM_API_KEY=mock LLM_MODEL_ID=mock LLM_BASE_URL=http://127.0.0.1:8899/v1 npm run dev
# OpenAI responses
LLM_API=openai-responses LLM_API_KEY=mock LLM_MODEL_ID=mock LLM_BASE_URL=http://127.0.0.1:8899/v1 npm run dev
# 说 "what is 21 * 2?" 触发 calculate 工具调用；说 "boom" 触发工具报错路径；说 "flaky" 触发两次 429 的重试路径
```

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `LLM_API_KEY` | ✅ | 鉴权用 key |
| `LLM_MODEL_ID` | ✅ | 模型名 |
| `LLM_BASE_URL` | ✅ | Anthropic 形如 `https://host/anthropic`（自动拼 `/v1/messages`）；OpenAI 形如 `https://host/v1` |
| `LLM_API` | | `anthropic-messages` / `openai-completions` / `openai-responses`，留空则按 baseUrl 自动判定 |
| `LLM_AUTH_STYLE` | | `auto`（默认）/ `bearer` / `api-key`，见下文「鉴权」 |
| `LLM_PROVIDER` | | 传给 pi 的 provider id，默认 `custom` |
| `LLM_REASONING` | | `true` 时显式请求 reasoning/thinking（网关自带思考的模型不设也会输出） |
| `LLM_CONTEXT_WINDOW` / `LLM_MAX_TOKENS` | | 默认 128000 / 8192；Anthropic 协议必须带 `max_tokens` |
| `LLM_SYSTEM_PROMPT` | | 覆盖默认 system prompt |

## REPL 命令

`/help` `/new` `/tools` `/model` `/stats` `/exit`；流式输出时按 `Ctrl+C` 中断本轮，空闲时退出。

## 关键实现说明

### 1. 用 pi 的 `Model` 描述任意网关

`src/model/config.ts` 依据 `LLM_API` 生成 `Model<"anthropic-messages" | "openai-completions" | "openai-responses">`。`api` 决定用哪个适配器，`baseUrl`/`compat`/`maxTokens` 决定请求长什么样：

```ts
// OpenAI 兼容网关常拒绝 OpenAI 专有字段
compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: reasoning }
// Anthropic 兼容网关若只暴露部分能力，可关掉 eager_input_streaming / cache_control
compat: { supportsEagerToolInputStreaming: false, supportsCacheControlOnTools: false }
```

### 2. 鉴权：Anthropic SDK 的 `x-api-key` vs 网关的 `Authorization: Bearer`

Anthropic 官方 SDK 默认发 `x-api-key`，但很多 Anthropic 兼容网关只认 `Authorization: Bearer`（本仓库用的网关就是这种，单独发 `x-api-key` 会 401）。`src/model/stream.ts` 因此在需要时额外补一个 Bearer 头（SDK 仍会照发 `x-api-key`，两者并存已被验证可用）：

```ts
// auto: 除 api.anthropic.com 之外的 anthropic-messages 端点都补 Bearer
{ ...options?.headers, Authorization: `Bearer ${apiKey}` }
```

真实 Anthropic API、纯 x-api-key 网关可用 `LLM_AUTH_STYLE=api-key` 关掉该行为。

### 3. `streamFn` 是 pi-ai 与 pi-agent-core 的接缝

`Agent` 只认 `StreamFn = (model, context, options) => AssistantMessageEventStream`，而 pi-ai 的 `api/*` 模块导出的 `streamSimple` 正好符合这个形状，所以按 `model.api` 分支即可（`hasApi()` 负责类型收窄）。注意契约要求 **streamFn 不能抛异常**，失败必须以 `{ type: "error", error }` 事件收尾，因此 `src/model/stream.ts` 里做了 `try/catch` 兜底。

### 4. 工具就是一个普通对象

```ts
export const calculateTool: AgentTool<typeof CalculateParams> = {
  name: "calculate", label: "Calculator",
  description: "…",
  parameters: CalculateParams,                 // TypeBox schema（pi-ai 重新导出了 Type）
  execute: async (toolCallId, params) => ({ content: [{ type: "text", text: "…" }], details: {} }),
};
```

`execute` 抛错会被 pi 转成 `isError` 的工具结果回灌给模型，模型可自行修正参数重试（`src/features/tools.ts` 的计算器就是这样抛错的）。

### 5. 事件订阅做 UI

runtime.subscribe((event) => {
  if (event.type === "text_delta") process.stdout.write(event.text);
});
```

`src/entries/render.ts` 处理了 `text_delta` / `thinking_delta` / `tool_start` / `tool_end` / `turn_end` —— 这些是**功能层的归一化事件**（`src/features/events.ts`）。pi 的 `message_update` / `tool_execution_*` 由 `src/features/runtime.ts` 翻译成这套词表，所以协议层与入口层不需要认识 pi 的事件名；而不同线上协议之间的差异（Anthropic 的 `thinking`/`tool_use` 块、OpenAI 的 `reasoning_content`/`tool_calls`）早已被 pi-ai 归一化。

### 6. 失败重试与上下文卫生

`src/features/runtime.ts` 在 `prompt()` 之后检查最后一条 assistant 消息：如果 `stopReason` 是 `error` 且这一轮没跑过工具，就把这轮消息整体回滚再重试（网关 429/502 很常见）；**取消（aborted）不重试**，那是用户的意图。「空内容且失败」的 `transformContext` 过滤放在 `src/kernel/agent.ts`。

这套重试是协议无关的，因此 CLI 与编辑器行为一致：`npm run acp:ui-test` 的第 16 项断言就是让 mock 先注入两次 429，再验证客户端只看到成功那一轮。

## ACP：把 Agent 暴露给编辑器客户端

`src/protocols/acp/` 是一个基于 [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk) 的 ACP **服务端**（agent 侧）：编辑器（Zed 等）作为 client 启动/连接它，就能拿 pi 当后端对话。

```
src/protocols/acp/main.ts      CLI：--transport stdio|http、--port、--token、--permissions、--ui、--cors
src/protocols/acp/transport.ts 传输层：stdio（ndJsonStream）/ Streamable HTTP + WebSocket（experimental/server + node 适配器）/ 静态托管测试页
src/protocols/acp/agent.ts     每个连接一个 AgentApp：initialize / session/new / session/prompt / session/cancel
src/protocols/acp/session.ts   一个 ACP session = 一个 Agent（经 createKernelAgent）；事件流转成 session/update，权限走 hooks.beforeToolCall
src/protocols/acp/tools.ts     由**客户端**执行的工具：read_file / write_file / run_command
src/protocols/acp/content.ts   ACP ContentBlock <-> 与 provider 无关的文本/图片
src/protocols/acp/tool-call.ts 工具卡片呈现：kind / 标题 / 内容块（含终端内嵌）
web/acp-http-client.js   ACP over Streamable HTTP client（浏览器与 Node 共用，测试页和 probe 都跑它）
test-acp-jsonrpc.html    浏览器测试页：连接、对话、原始 JSON-RPC 日志、client 能力模拟
```

### 启动

```bash
npm run build
npm run acp                                   # stdio（编辑器默认方式）
npm run acp -- --port 8890 --token secret     # TCP 端口：Streamable HTTP + WebSocket
npm run acp -- --port 8890 --cors "*"          # 额外允许跨域浏览器调用（默认关闭，见下）
```

`--port` 模式下默认还会在 `/` 提供内置的浏览器测试页（`--no-ui` 关闭）。

Zed 的 `settings.json`：

```jsonc
{
  "agent_servers": {
    "steve": {
      "command": "node",
      "args": ["/绝对路径/steve/dist/protocols/acp/main.js"],
      "env": { "LLM_API_KEY": "..." }   // 不设也能读同目录的 .env
    }
  }
}
```

### 自带的测试客户端

`scripts/acp-client.mjs` 是一个完整实现的 ACP client（含 fs / terminal 回调），既能验证服务端，也能当接入参考：

```bash
npm run acp:client -- "用一句话介绍这个项目"
npm run acp:client -- --deny "把 hello 写到 /tmp/x.txt"          # 拒绝权限，观察工具被拦截
npm run acp:client -- --cancel-after 1000 "数到 100"             # 中断本轮
npm run acp:client -- --http http://127.0.0.1:8890/acp --token secret "hi"
npm run acp:client -- --ws ws://127.0.0.1:8890/acp --token secret "hi"
npm run mock &                                        # 离线：不消耗真实模型额度
LLM_API_KEY=mock LLM_MODEL_ID=mock LLM_BASE_URL=http://127.0.0.1:8899/anthropic npm run acp:client -- "what is 21 * 2"
```

### 浏览器测试页 `test-acp-jsonrpc.html`

```bash
npm run build
npm run acp -- --port 8890        # 打开 http://127.0.0.1:8890/ （同源，无需 CORS）
```

也可以**直接双击打开** `test-acp-jsonrpc.html`（`file://`）——页面内的 ACP client 是内联的，不依赖 ES module：

```bash
npm run acp -- --port 8890 --cors "*"          # file:// 是跨域请求，必须开 CORS
open test-acp-jsonrpc.html                       # 端点默认 http://127.0.0.1:8890/acp
```

`file://` 打开时会提示需要 `--cors`：浏览器以 `Origin: null` 发跨域请求，而且访问 localhost 属于 Private Network Access，服务端会在预检响应里补 `Access-Control-Allow-Private-Network: true`。想连别的端口/带 token，可以用查询参数覆盖：`test-acp-jsonrpc.html?endpoint=http://127.0.0.1:9000/acp&token=secret`。

页面本身就是一个真实的 ACP client（`web/acp-http-client.js`，浏览器 / Node 通用；页面里那份由 `npm run acp:ui-sync` 从模块生成，`npm run acp:ui-test` 会校验两者一致）：

- **Streamable HTTP 正确姿势**：`POST initialize` 拿到 `Acp-Connection-Id` → `GET` 开连接级 SSE → `session/new`（响应从连接 SSE 回）→ 每个 session 再开一条 `Acp-Session-Id` 的 SSE，`session/update` 与 `session/prompt` 的响应都从这条流回来；`POST` 本身只返回 202。
- **server → client 请求**：`session/request_permission` 渲染成页面里的授权按钮（允许一次 / 总是允许 / 拒绝），`fs/read_text_file`、`fs/write_text_file`、`terminal/*` 由页面用「内存文件系统 + 模拟终端」实现，写入结果实时显示在页面底部。
- **原始 JSON-RPC 面板**：可手发改任意方法，右上角日志按方向（→ / ←）记录全部双向消息，方便对着协议排查。
- **`window.acpTest`**：暴露 `connect / newSession / sendText / chatText / logText` 等，可在 DevTools 控制台或自动化脚本里驱动页面。

### 测试脚本

| 脚本 | 作用 |
| --- | --- |
| `npm run acp:client` | 完整 ACP client，走 **stdio** 或 `--http` / `--ws`，可在真编辑器之外验证服务端 |
| `npm run acp:probe` | Node 版 HTTP client（import 浏览器同一份 `web/acp-http-client.js`），带真实的 fs/terminal 回调 |
| `npm run acp:ui-test` | 用 headless Chrome + CDP 驱动 **真实测试页**（`http://` 或 `file://` 都行），16 项断言覆盖流式输出、授权/拒绝、虚拟 FS、取消、429 重试等 |
| `npm run acp:ui-sync` | 从 `web/acp-http-client.js` 重新生成页面里内联的那份 client |

```bash
npm run acp:probe    -- --url http://127.0.0.1:8890/acp "run ls"
npm run acp:ui-test  -- --url http://127.0.0.1:8890/                        # 离线 mock：16 项断言
npm run acp:ui-test  -- --url file://$PWD/test-acp-jsonrpc.html             # 直接开本地文件（需 --cors "*"）
npm run acp:ui-test  -- --url http://127.0.0.1:8890/ --smoke "用一句话介绍你自己"   # 真实网关：只验证一轮往返
```

### 协议 <-> pi 的映射

| ACP | pi |
| --- | --- |
| `session/new` | 新建一个 `Agent`（经 `createKernelAgent`；systemPrompt 里带上 cwd / workspace roots，工具 = 本地工具 + 客户端能力允许的工具） |
| `session/prompt` | `agent.prompt(text, images)`，返回 `stopReason` + 累计 usage |
| `agent_message_chunk` / `agent_thought_chunk` | `message_update` 的 `text_delta` / `thinking_delta` |
| `tool_call` / `tool_call_update` | `tool_execution_start` / `tool_execution_end`（含 kind、locations、终端内嵌内容） |
| `session/request_permission` | 功能层的权限闸门（内部就是 pi 的 `beforeToolCall`）：拒绝时返回 `{ block: true }`，变成 `isError` 的工具结果回灌给模型 |
| 失败重试 | 功能层 `prompt()` 里的回滚重试：只有 429/5xx 这类**未跑工具**的失败才重试，客户端只看到最后成功那一轮 |
| `session/cancel` | `agent.abort()`；本轮 `stopReason=cancelled` |
| `usage_update` | 每轮 assistant 的 `usage`（used = 本轮上下文 tokens，size = `contextWindow`） |
| `fs/read_text_file` `fs/write_text_file` `terminal/*` | 反向调用：pi 的工具通过 ACP 请求客户端的文件系统/终端 |

几个刻意设计：

- **客户端能力决定工具集**：`initialize` 里客户端没声明 `fs` / `terminal` 能力，对应的 `read_file` / `run_command` 就不会注册，模型看不到也用不了。
- **权限交给编辑器**：`write_file` / `run_command` 默认走 `session/request_permission`（`--permissions allow` 可关闭），UI 上是标准的 ACP 授权弹窗。「总是允许」只记在当前 session 的闸门里，不会串到别的会话。
- **重试与协议无关**：429/5xx 的回滚重试在功能层，所以编辑器里也能吃到（客户端看不到失败轮）；取消不会被重试。
- **每条连接独立**：HTTP/WS 传输下每个连接有自己的 `AgentApp` 和 session 表，session 之间不串上下文。
- **stdout 只走协议**：stdio 模式下所有日志都写到 stderr，`--quiet` 可只留错误。

## 换个模型 / 加个工具

- 换模型：改 `.env` 即可。换协议时只需要 `LLM_API`（或让 baseUrl 自动判定），`Agent` 侧代码一行都不用动。
- 加工具：在 `src/features/tools.ts` 写好 `AgentTool`，加进 `tools` 数组，并在 `execute` 里返回 `content`（回灌给模型）+ `details`（给 UI/日志）。只给 ACP 用的工具放 `src/protocols/acp/tools.ts`（比如依赖客户端能力的那些）。
- 改内核装配（streamFn / 上下文净化 / thinking 等级 / hooks）：只动 `src/kernel/agent.ts` 一处，CLI 与 ACP 同时生效。
