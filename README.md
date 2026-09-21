# steve

一个最小但完整的流式对话 Agent：直接基于 **`@earendil-works/pi-agent-core`**（Agent 循环 / 状态 / 工具 / 事件）与 **`@earendil-works/pi-ai`**（各家模型 API 的统一流式适配层）编写，**不依赖 `pi-coding-agent`**。

- 终端里流式输出文本与思考过程（thinking）
- 自带 7 个工具：6 个本地工具（读/写/改/搜/跑命令，写与执行要批准）+ 1 个演示工具（当前时间），支持并行工具调用
- 支持三种线上协议，切换只改 `.env`：
  `anthropic-messages`、`openai-completions`、`openai-responses`
- 失败自动重试，并把失败轮次从上下文里剔除后再重试
- 通过 **ACP（Agent Client Protocol）** 把同一个 Agent 暴露给编辑器客户端（Zed 等）：stdio + Streamable HTTP/WebSocket 两种传输
- 零运行时依赖（pi 两个包 + ACP SDK），另带一个离线 mock server 和 ACP 客户端脚本方便本地验证
- 工程约定可机检：`npm run arch:test` 查架构契约与发布卫生，`npm run verify` 一键跑全套回归（见文末「约定与规范」）

## 分层

自下而上五层，**只允许上层依赖下层，同层之间不互相依赖**：

| 层 | 目录 | 职责 |
| --- | --- | --- |
| L1 入口 | `src/entries/` | 进程入口：CLI（REPL / 单次提问 / slash 命令）与 ACP 的启动参数 |
| L2 协议 | `src/protocols/acp/` | ACP 服务端：传输、方法处理、`session/update` 映射、由客户端执行的工具 |
| L3 功能 | `src/features/` | 会话运行时与策略：事件归一化、失败重试与回滚、权限判定、本地文件/命令工具、统计 |
| L3′ 拓展 | `src/extensions/` | 插件宿主 + **内置插件**（会话命令就住在这里）；一切能力都通过插件贡献 |
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
src/features/tool-annotations.ts L3 工具声明（permission / metadata / describe）的注册表
src/features/local-tools.ts L3 本地工具：read_file / glob / grep / write_file / edit_file / run_command
src/extensions/api.ts     L3′ 插件契约：on / registerTool / registerCommand / ctx
src/extensions/host.ts    L3′ 插件宿主：发现、加载、钩子链、错误隔离
src/extensions/builtin/*  L3′ 内置插件：会话命令（含 /mcp）+ 演示工具 + .steve/mcp.json 读取
examples/extensions/*     三个示例插件（guard / git-status / turn-logger）
src/kernel/agent.ts      L4 createKernelAgent()：唯一组装 pi Agent 的位置
src/model/config.ts      L5 .env 读取 + 构造 pi 的 Model（api / baseUrl / compat / 鉴权方式）
src/model/stream.ts      L5 StreamFn：按 model.api 路由到 pi-ai 适配器，错误编码进流
mcp.example.json         MCP 配置模板（复制到 .steve/mcp.json，见「MCP 接入」）
web/*                    ACP over HTTP 浏览器/Node 通用 client（测试页与 probe 共用）
test-acp-jsonrpc.html    浏览器 ACP 测试页（由 --ui 提供）
scripts/*                离线 mock 网关 + ACP 测试客户端 / probe / headless 浏览器测试
scripts/arch-test.mjs    架构契约 + 发布卫生检查（约定与规范的可执行版本）
scripts/verify.mjs       一键回归：类型 → 构建 → 架构 → 各能力测试 → 浏览器端到端
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
mkdir -p .steve && cp .env.example .steve/.env   # 填 LLM_API_KEY / LLM_MODEL_ID / LLM_BASE_URL
npm run dev               # 交互式对话
npm run dev "现在几点？顺便算一下 128*37+15"   # 单次提问
npm run dev -- --read-only      # 只读模式（默认写/执行前会在终端问 y/n）
npm run build && npm start
```

当前 `.steve/.env` 指向 Anthropic Messages 格式的网关（`https://your-gateway.example.com/anthropic`），`LLM_API` 未设置时会根据 `LLM_BASE_URL` 自动判定为 `anthropic-messages`。

`npm run mock` 会用自带的离线 mock server（`scripts/mock-server.mjs`）替代真实网关，三种协议都支持，无需 key、不联网：

```bash
npm run mock &            # 监听 127.0.0.1:8899
# Anthropic Messages
LLM_API_KEY=mock LLM_MODEL_ID=mock LLM_BASE_URL=http://127.0.0.1:8899/anthropic npm run dev
# OpenAI chat completions
LLM_API_KEY=mock LLM_MODEL_ID=mock LLM_BASE_URL=http://127.0.0.1:8899/v1 npm run dev
# OpenAI responses
LLM_API=openai-responses LLM_API_KEY=mock LLM_MODEL_ID=mock LLM_BASE_URL=http://127.0.0.1:8899/v1 npm run dev
# 问"现在几点了"触发 get_current_time 工具调用；"boom" 触发工具报错路径；"flaky" 触发两次 429 的重试路径；"rm -rf" 触发危险命令规划（给 guard 插件用）
```

## 环境变量

凭据从 `.env` 文件读，按**优先级从低到高**依次尝试（后面的覆盖前面的，但**真实环境变量永远最优先**）：

| 位置 | 用途 |
| --- | --- |
| `<安装目录>/.env` | 兼容旧写法；也是编辑器从别的 cwd 启动 ACP server 时的兜底 |
| `<安装目录>/.steve/.env` | 同上，新位置 |
| `~/.steve/.env` | 全局，对所有项目生效 |
| `$PWD/.env` | 兼容旧写法 |
| `$PWD/.steve/.env` | **推荐** |

`.steve/` 整个目录都在 `.gitignore` 里 —— 本地配置与密钥只放这里，永远不进仓库（`npm run arch:test` 会机检这一点）。

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

`/help` `/new` `/tools` `/model` `/stats` `/mcp` `/exit`；流式输出时按 `Ctrl+C` 中断本轮，空闲时退出。

`/mcp` 列出当前配置的 MCP server（来源、传输、命令行、连上的工具，或失败原因）：

```
mockmcp [plugin] stdio — /usr/bin/node scripts/mock-mcp-server.mjs
  4 tool(s): echo, sum, fail, image
broken [plugin] stdio — /definitely/not/a/binary
  failed — MCP server "broken": spawn /definitely/not/a/binary ENOENT
```

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
export const myTool: AnnotatedTool<typeof MyParams> = {
  name: "my_tool", label: "My tool",
  description: "…",                            // 给模型看
  parameters: MyParams,                        // TypeBox schema（pi-ai 重新导出了 Type）
  // 除 pi 要求的字段外，工具还能自己声明三件事（见「约定与规范 / 工具与安全」）
  permission: "ask",                            // 执行前是否要用户批准
  metadata: { kind: "edit", title: (args) => `Touch ${args.path}` },   // 客户端怎么呈现
  describe: (args) => ({ summary: `touch ${args.path}` }),             // 审批预览
  execute: async (toolCallId, params) => ({ content: [{ type: "text", text: "…" }], details: {} }),
};
```

真实例子见 `src/features/local-tools.ts`（写文件会给出 diff 预览）与 `src/extensions/builtin/demo-tools.ts`。`execute` 抛错会被 pi 转成 `isError` 的工具结果回灌给模型，模型可自行修正参数重试。

### 5. 事件订阅做 UI

runtime.subscribe((event) => {
  if (event.type === "text_delta") process.stdout.write(event.text);
});
```

`src/entries/render.ts` 处理了 `text_delta` / `thinking_delta` / `tool_start` / `tool_end` / `turn_end` —— 这些是**功能层的归一化事件**（`src/features/events.ts`）。pi 的 `message_update` / `tool_execution_*` 由 `src/features/runtime.ts` 翻译成这套词表，所以协议层与入口层不需要认识 pi 的事件名；而不同线上协议之间的差异（Anthropic 的 `thinking`/`tool_use` 块、OpenAI 的 `reasoning_content`/`tool_calls`）早已被 pi-ai 归一化。

### 6. 失败重试与上下文卫生

`src/features/runtime.ts` 在 `prompt()` 之后检查最后一条 assistant 消息：如果 `stopReason` 是 `error` 且这一轮没跑过工具，就把这轮消息整体回滚再重试（网关 429/502 很常见）；**取消（aborted）不重试**，那是用户的意图。「空内容且失败」的 `transformContext` 过滤放在 `src/kernel/agent.ts`。

这套重试是协议无关的，因此 CLI 与编辑器行为一致：`npm run acp:ui-test` 的第 17 项断言就是让 mock 先注入两次 429，再验证客户端只看到成功那一轮。

## 本地文件与命令工具

`pi-agent-core` 只提供工具的**形状**（`AgentTool` + 参数校验 + 执行 + 结果回灌），**不带任何内置工具**；内置的 read/write/edit/bash 属于 `pi-coding-agent`，而本仓库刻意不依赖它。所以本地工具在 `src/features/local-tools.ts` 自己实现：

| 工具 | 说明 | 需要批准 |
| --- | --- | --- |
| `read_file` | 读 UTF-8 文本（行号区间、截断标记、二进制拒绝）；图片文件在模型支持视觉时以 image 内容返回（默认上限 4 MiB） | 否 |
| `glob` | `src/**/*.ts` 这类模式列文件（跳过 .git/node_modules/dist 与隐藏项） | 否 |
| `grep` | 正则搜内容，返回 `path:line: text`，可用 `glob` 过滤文件名 | 否 |
| `write_file` | 建目录 + 覆盖写 | **是**（带 diff 预览） |
| `edit_file` | 精确替换，要求唯一匹配，否则报错让模型补充上下文 | **是**（带 diff 预览） |
| `run_command` | `sh -lc` 执行，带超时与输出上限 | **是** |

审批不是盲批：功能层会算出**将要发生什么**（`src/features/change-preview.ts`），两端各取所需——

- CLI 打印 `--- / +++` 形式的 diff（改动行绿/红）；
- ACP 把预览放进 `session/request_permission`：`toolCall.title` 是一行摘要，`toolCall.content` 是 `{ type: "diff", path, oldText, newText }`，编辑器可直接渲染（内置测试页就会把 diff 画在授权卡片上）。

预览读取“改动前内容”的后端与工具一致：本地工具读磁盘，ACP 走编辑器的 `fs/read_text_file`；读不到就当新建处理。预览失败不会阻塞审批，只会退化成一行说明。

安全边界（都有断言覆盖，见 `npm run tools:test`）：

- **路径收敛**：所有路径解析后必须落在 workspace roots 内（CLI 是 `cwd`，ACP 是 `cwd` + `additionalDirectories`），并解析软链——macOS 的 `/var` → `/private/var` 不会被误判为越界。越界直接拒绝，模型收到可读的错误。
- **不扫隐藏项**：`glob`/`grep` 跳过 `.` 开头的文件与目录，`.env` 不会意外进上下文（显式 `read_file .env` 仍可读，这是有意的）。
- **截断**：读文件与命令输出都有字节上限，命令默认 30s 超时。

CLI 的三种审批模式：

```bash
npm run dev                     # 默认：写/执行前在终端问 y/n（非交互运行时默认拒绝）
npm run dev -- --yes            # 自动批准所有写/执行（危险，慎用）
npm run dev -- --read-only      # 只注册读工具，没有审批提示
```

ACP 侧沿用编辑器的授权弹窗；只有客户端**没有**声明 `fs`/`terminal` 能力时，才可用 `--allow-local-tools` 让会话回退到本地工具（默认关闭，避免编辑器里的 agent 绕过沙箱改本机文件）。同名工具不会重复注册：客户端提供了就用客户端的。

## 跨平台

核心逻辑不依赖平台：零原生模块、路径全走 `node:path`（glob/grep 匹配时统一成 `/`）、`clean` 脚本用 `node -e` 而不是 `rm -rf`、临时目录走 `os.tmpdir()`、MCP 分帧对 CRLF 容错。

| 能力 | Linux | macOS | Windows |
| --- | --- | --- | --- |
| CLI / ACP / 插件 / MCP / 会话持久化 | ✅ | ✅（已实测） | ⚠️ 已按平台语义分支，未在真机验证 |
| `read_file` / `glob` / `grep` / `write_file` / `edit_file` | ✅ | ✅ | ⚠️ 路径收敛按大小写不敏感比较 |
| `run_command` | `$SHELL -lc` | `$SHELL -lc` | `%COMSPEC% /d /s /c`（默认 `cmd.exe`） |
| `npm run acp:ui-test` | ✅（需 chrome/chromium） | ✅（Chrome / Chromium / Edge） | ⚠️ 已加 `Program Files` 候选，或设 `CHROME_PATH` |

已知差异与应对：

- **shell**：`run_command` 默认取 `$SHELL`（POSIX）/ `%COMSPEC%`（Windows）。想固定用别的 shell（Git Bash、pwsh 等）就设这两个环境变量，或在代码里给 `createLocalTools({ shell: { file, args } })` 传值。
- **路径大小写**：Windows 与默认的 macOS 文件系统不区分大小写，路径收敛会先 `toLowerCase()` 再比；Linux 保持敏感，边界不放宽。
- **环境变量前缀写法**：文档里的 `LLM_API_KEY=mock npm run dev` 是 POSIX 语法；PowerShell 用 `$env:LLM_API_KEY="mock"; npm run dev`。
- **隐藏项**：`glob`/`grep` 靠 `.` 前缀跳过隐藏文件，Windows 的"隐藏"属性不生效（安全边界仍由路径收敛保证）。
- **测试脚本**收尾用 `SIGTERM`，Windows 上只杀直接子进程，偶发残留进程属测试噪音。

> 所有验证都在 macOS 上跑过（含 4 个测试脚本 + headless Chrome）；Windows 分支是按平台语义写的，**未在真机实测**。

## 拓展（插件）

插件是构建之外的独立 ES module，按约定发现：

| 位置 | 作用 |
| --- | --- |
| `<cwd>/.steve/extensions/*.mjs` | 项目级 |
| `~/.steve/extensions/*.mjs` | 全局 |
| `--extension <path>`（ACP）/ `STEVE_EXTENSIONS=a,b`（两端） | 显式指定 |
| `STEVE_DISCOVERY=off` / `--no-discovery`（ACP） | 只加载显式指定的插件，跳过上面两个目录（CI、排查插件冲突时用） |

```js
// examples/extensions/git-status.mjs
export default function gitStatus(pi) {
  pi.registerTool({
    name: "git_status",
    description: "Show the git working tree status.",
    parameters: pi.Type.Object({ short: pi.Type.Optional(pi.Type.Boolean({})) }),
    execute: async (_id, params) => ({ content: [{ type: "text", text: (await pi.ctx.exec("git", ["status"])).stdout }] }),
  });
  pi.registerCommand({ name: "git-status", description: "git status --short --branch", run: async () => (await pi.ctx.exec("git", ["status", "--short", "--branch"])).stdout });
}
```

插件能挂的接缝（全部定义在 `src/extensions/api.ts`）：

| 接缝 | 语义 | 落到哪里 |
| --- | --- | --- |
| `on("tool_call")` | 返回 `{ block: true }` 直接拒绝这次工具调用 | pi 的 `beforeToolCall`（在权限闸门**之前**） |
| `on("tool_result")` | 改写工具结果（`text` / `details` / `isError`） | pi 的 `afterToolCall` |
| `on("context")` | 改写发给模型的消息数组 | pi 的 `transformContext`（在内置失败轮过滤之后） |
| `on("before_provider_headers")` | 就地改请求头（**同步**：streamFn 不能 await） | `src/model/stream.ts` 的 header 钩子 |
| `on("text_delta" … "turn_end")` | 观察归一化事件（`src/features/events.ts` 那套词表） | 功能层事件派发 |
| `registerTool` / `registerCommand` | 加工具、加斜杠命令 | 工具表；CLI 斜杠命令 + ACP `available_commands_update` |

**原则：插件优先（plugin-first），而不是插件唯一。** 一切**能力**都由插件贡献；核心只保留三件不可插件化的东西：

| 核心保留 | 为什么 |
| --- | --- |
| 引导：`kernel/`、`model/`、`extensions/host.ts` | 插件宿主不能加载自己；没有模型就没有 agent |
| 边界：`features/permissions.ts`、路径收敛、截断 | 插件只能**加**约束，永远不能放宽安全边界 |
| 协议：`protocols/`、`entries/` | 插件 API 协议中立，协议层是宿主，插件不该认识 ACP |

判据是 **dogfooding**：如果内置能力写不成插件，那是 API 不够用。目前已经这样搬过三轮 ——

1. 内置命令（`/tools` `/stats` `/model` `/new` `/mcp` `/help`）→ `src/extensions/builtin/session-commands.ts`
2. MCP → 插件用 `registerMcpServer()` 声明，核心负责连接（CLI 侧唯一的 MCP 入口）
3. 演示工具（`get_current_time`）→ `src/extensions/builtin/demo-tools.ts`，`src/features/tools.ts` 已删除

**核心工具和插件工具用同一套声明**（`src/features/tool-annotations.ts`）：`read_file` / `write_file` / `run_command` 这些核心工具也是自己声明 `permission`、`metadata`、`describe`，协议层与权限闸门都改成"先问工具、再兜底"，不再维护工具名硬编码表。

插件能贡献的东西：

| 能力 | API | 核心做什么 |
| --- | --- | --- |
| 工具 | `registerTool({ name, description, parameters, execute, permission?, metadata? })` | 校验、执行、结果回灌；`permission: "ask"` 交给权限闸门 |
| 斜杠命令 | `registerCommand({ name, description, run })` | CLI 斜杠命令 + ACP `available_commands_update` |
| MCP server | `registerMcpServer({ name, command, args, env })` | 连接、工具并入工具表（`mcp__server__tool`）、会话结束关闭子进程 |
| 呈现元数据 | `registerTool({ metadata: { kind, title } })` | ACP 工具卡片按声明渲染；协议层的名字表降级为兜底 |
| 审批预览 | `registerTool({ describe: (args) => ToolChangePreview })` | 权限闸门优先用工具自己的预览，宿主回调只是兜底 |
| 会话内省 | `ctx.session.{ tools, commands, model, mcp, stats(), reset() }` | 只读视图，够写 `/tools`、`/stats`、`/mcp` 这类命令 |

### MCP 接入

只实现了 **stdio** 传输（`http`/`sse`/`acp` 明确报「不支持」，不静默忽略）。接入方式两种：

**1. `.steve/mcp.json`（内置插件，无需写代码）** —— 仓库根目录有模板 `mcp.example.json`，直接复制：

```bash
mkdir -p .steve && cp mcp.example.json .steve/mcp.json
```

格式和 Claude Desktop / Cursor 一样，可以直接抄过来（`"//"` 字段是注释，会被忽略）：

```jsonc
// .steve/mcp.json（项目级）或 ~/.steve/mcp.json（全局）
{
  "mcpServers": {
    "amap-maps": {
      "command": "npx",
      "args": ["-y", "@amap/amap-maps-mcp-server"],
      "env": { "AMAP_MAPS_API_KEY": "..." },   // 不支持 ${VAR} 插值，这里就是字面量
      "timeoutMs": 120000
    }
  }
}
```

三条规则：**同名时插件/编辑器声明优先**（配置里那条在 `/mcp` 里显示为 `skipped` 并说明原因）；**项目级优先于全局**；**坏文件、坏条目只记日志跳过**，不影响会话。

server 进程**在会话的 cwd 里启动**，所以 `args: ["."]`、相对脚本路径都指向你当前的项目（编辑器从别处启动 ACP server 时也一样）。

**2. 插件里声明** —— 终端与编辑器都生效，需要读环境变量或用条件逻辑时用它（完整示例：`examples/extensions/mcp-server.mjs`）：

```js
// .steve/extensions/mcp-server.mjs
export default function (pi) {
  pi.registerMcpServer({
    name: "amap-maps",
    command: "npx",
    args: ["-y", "@amap/amap-maps-mcp-server"],
    env: [{ name: "AMAP_MAPS_API_KEY", value: process.env.AMAP_MAPS_API_KEY ?? "" }],
    timeoutMs: 120_000,          // npx 首次要下载包，默认 20s 握手超时可能不够
  });
}
```

**3. 客户端在 `session/new` 里传（ACP）** —— 编辑器把它自己的 MCP 配置随会话送进来，`/mcp` 里来源标成 `client`。终端里没有客户端，所以 CLI 只有前两条路。

接入后核心负责这些事：

| 行为 | 说明 |
| --- | --- |
| 命名 | 工具叫 `mcp__<server>__<tool>`（`/tools` 能看到），MCP 的 `inputSchema` 直接当参数 schema 用 |
| 权限 | **一律先问**（MCP server 能做的事和它自己一样多），拒绝就是一次 `isError` 工具结果 |
| 失败隔离 | 连不上只记日志并跳过，不影响会话；`/mcp` 会写出原因（含 server 的 stderr 末行） |
| 生命周期 | 会话结束 / `session/delete` 时关掉子进程 |

排查顺序：`/mcp` 看状态 → 看 `[mcp <name>] ...` 日志里 server 自己的输出 → 手动跑一遍 `command + args` 确认它能起来。

| 现象 | 原因与处理 |
| --- | --- |
| `failed — ... exited (code 1): <原因>` | server 自己启动失败，多半缺 env（API key） |
| `failed — MCP initialize timed out` | `npx -y` 首次下载太慢 → 加 `timeoutMs`，或先 `npm i -g` |
| `unsupported — transport "http"` | 只实现了 stdio |
| `skipped — the plugin declaration wins` | 同名 server 在插件/mcp.json 里各声明了一次，按优先级只连一个 |
| `[extensions] failed to load ...` | `registerMcpServer` 校验失败（缺 name/command）会让整个插件加载报错 |
| `[mcp.json] ...: missing "command"` | mcp.json 的条目缺 command（stdio 必需），该条被跳过 |

实测（走真实 npx）：`@amap/amap-maps-mcp-server` 12 个工具、`@modelcontextprotocol/server-filesystem` 14 个工具，都能被模型调用并拿到结果。

三条设计约束：

- **插件只说功能层的词汇**，不吐协议专属事件，所以同一个插件在两端行为一致：`/git-status` 在终端是斜杠命令，在编辑器里由 `available_commands_update` 播报、由 ACP 本地执行。
- **隔离**：加载期抛错的插件被记录并跳过；钩子抛错只写日志，不会中断 agent 循环（`npm run plugins:test` 有专门断言）。
- **不是 pi 扩展的兼容层**：pi 的扩展由 `pi-coding-agent` 的 extension runner 加载，本仓库刻意不依赖它；这里的 API 只是「pi 风格」（同名 `on(...)`、`ctx.hasUI`），因此不保证能直接跑 pi 的扩展文件。

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
npm run acp -- --port 8890 --allow-local-tools  # 客户端没有 fs/terminal 能力时回退到本地工具
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

### 打包与分发（装到别处怎么连）

没有打包器：`npm run build` 用 `tsc` 直接输出 `dist/`（27 个文件、424 KB），入口都带 shebang。要分发给别人或装到别的机器，用 tarball：

```bash
npm run build
npm pack                      # → steve-0.1.0.tgz（109 KB，files 字段已限定内容）
npm i -g ./steve-0.1.0.tgz     # 装上两个命令：steve（CLI）与 steve-acp（ACP server）
# 或者只在本机试用：npm link
```

`bin` 两个入口：`steve`（终端对话）与 `steve-acp`（ACP server）。于是编辑器配置可以简单到：

```jsonc
// Zed settings.json
{
  "agent_servers": {
    "steve": {
      "command": "steve-acp",                       // 或用绝对路径：/usr/local/bin/steve-acp
      "args": [],
      "env": { "LLM_API_KEY": "...", "LLM_BASE_URL": "...", "LLM_MODEL_ID": "..." }  // 不写则读下面的文件
    }
  }
}
```

**凭据从哪来**（按优先级，真实环境变量最优先）—— 装到别处后最常用的两种：

| 放哪 | 适用 |
| --- | --- |
| `~/.steve/.env` | 装成全局命令后，任何项目、任何 cwd 都能用（推荐） |
| `<会话 cwd>/.steve/.env` | 每个项目自己的网关/模型 |
| 编辑器 `env` 块 | 只想在编辑器里用某套凭据 |

ACP 的 `session/new` 会带上项目目录，所以 MCP（`.steve/mcp.json`）与插件（`.steve/extensions/`）也跟着**项目**走，不是跟着安装目录走。

HTTP / WebSocket 模式（编辑器支持远程连接时用）：

```bash
steve-acp --port 8890 --token secret --cors "*"   # 端点 http://127.0.0.1:8890/acp，页面 http://127.0.0.1:8890/
```

验证连接（`acp:client` 可以从任意目录运行，agent 路径按脚本位置解析）：

```bash
node /path/to/steve/scripts/acp-client.mjs --command steve-acp --agent-args "" "现在几点？"
node /path/to/steve/scripts/acp-http-probe.mjs --url http://127.0.0.1:8890/acp --token secret "run ls"
```

两个坑：

- **别只拷 `dist/`**：产物是 ESM，需要同级的 `package.json`（`"type": "module"`）以及三个运行时依赖（pi 两个包 + ACP SDK，约 18 MB）。用 `npm pack` + `npm i -g` 就没这个问题。
- **UI 页面随包走**：HTTP 模式的 `/` 由 `test-acp-jsonrpc.html` 提供，`files` 里已经包含它（`arch:test` 会检查，防止漏掉）。要发到 npm 得先把 `private` 改成 `false`。

### 自带的测试客户端

`scripts/acp-client.mjs` 是一个完整实现的 ACP client（含 fs / terminal 回调），既能验证服务端，也能当接入参考：

```bash
npm run acp:client -- "用一句话介绍这个项目"
npm run acp:client -- --deny "把 hello 写到 /tmp/x.txt"          # 拒绝权限，观察工具被拦截
npm run acp:client -- --cancel-after 1000 "数到 100"             # 中断本轮
npm run acp:client -- --http http://127.0.0.1:8890/acp --token secret "hi"
npm run acp:client -- --ws ws://127.0.0.1:8890/acp --token secret "hi"
npm run mock &                                        # 离线：不消耗真实模型额度
LLM_API_KEY=mock LLM_MODEL_ID=mock LLM_BASE_URL=http://127.0.0.1:8899/anthropic npm run acp:client -- "现在几点了？"
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
| `npm run acp:ui-test` | 用 headless Chrome + CDP 驱动 **真实测试页**（`http://` 或 `file://` 都行），17 项断言覆盖流式输出、授权/拒绝、虚拟 FS、取消、429 重试等 |
| `npm run acp:ui-sync` | 从 `web/acp-http-client.js` 重新生成页面里内联的那份 client |
| `npm run plugins:test` | 插件层 23 项断言：发现/加载/隔离、四个钩子、事件派发，以及 ACP 端到端（命令播报、`/command` 本地执行、guard 在权限询问前拦下危险命令） |
| `npm run tools:test` | 本地工具 52 项断言：路径收敛（读/写/cwd/相对逃逸）、读写改、glob/grep、二进制与图片、命令退出码与超时、审批 diff 预览、CLI `--yes`/默认拒绝/`--read-only`/交互式审批、ACP 无能力时的本地回退与 diff 审批 |
| `npm run sessions:test` | 会话持久化 22 项断言：store 往返/列表/删除/id 安全/损坏文件、runtime 快照与 transcript 归一化、ACP `session/load`（落盘、历史回放、续聊、未知 id 报错） |
| `npm run config:test` | 凭据来源 10 项：`.env` 查找链（安装目录 / `~/.steve` / `$PWD` / `$PWD/.steve`）、真实环境变量优先、`.steve/.env` 优于旧 `.env`、引号与注释处理 |
| `npm run arch:test` | 架构契约与发布卫生 13 项：依赖方向、协议层零 pi 依赖、唯一装配点、依赖白名单、`bin` 与 `files` 完整、`.env` 与 `.steve/` 不入库、内网信息不泄露 |
| `npm run verify` | 一键回归：上面全部 + 类型检查 + 构建 + UI 同步 + 浏览器端到端（`-- --fast` 跳过浏览器） |
| `npm run mcp:test` | MCP 与会话管理 38 项断言：stdio 连接与工具映射（文本/schema/错误/图片）、坏 server 隔离、非 stdio 传输的明确拒绝、ACP 端到端（工具进表、模型调用、权限确认）、`session/list` 过滤与 `session/delete` 幂等 |

```bash
npm run acp:probe    -- --url http://127.0.0.1:8890/acp "run ls"
npm run acp:ui-test  -- --url http://127.0.0.1:8890/                        # 离线 mock：17 项断言
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
- **斜杠命令**：`session/new` 之后 agent 会发 `available_commands_update`，把 `/help` `/tools` `/model` `/stats` `/mcp` `/new` 与插件命令一起播报；这些命令由会话本地执行，不消耗模型调用。
- **会话持久化**：每个 session 的 transcript 存到 `<session-dir>/<id>.json`（默认 `<cwd>/.steve/sessions`，`--session-dir` 可改，`--no-sessions` 关闭）。客户端 `session/load` 时 agent 回放历史（`user_message_chunk` / `agent_message_chunk` / `agent_thought_chunk` / `tool_call*`）并把该 session 重新挂上，编辑器重启后可以接着聊。initialize 里的 `loadSession` 能力就取决于有没有开持久化。
- **会话管理**：`session/list`（可按 `cwd` 过滤，返回 `sessionId`/`cwd`/`updatedAt`）与 `session/delete`（先 dispose 活会话——顺带 abort 并关掉它的 MCP 子进程——再删文件）。两者都在 initialize 的 `sessionCapabilities` 里声明。
- **MCP 透传**：来源有两个 —— ACP 客户端在 `session/new` / `session/load` 传的 `mcpServers`，以及插件用 `registerMcpServer()` 声明的（**这是 CLI 侧唯一入口**，终端里没有客户端可传）。两者都连（**stdio 传输**，零依赖实现），工具以 `mcp__<server>__<tool>` 命名进工具表；`/mcp` 会列出每个 server 的来源（`plugin` / `client`）、传输、命令行与工具，连不上的把原因也列出来，MCP 的 `inputSchema` 直接当参数 schema 用；`isError` 结果变成工具错误，图片结果摘要成文本。坏 server 只记日志跳过，不影响会话；**MCP 工具一律先问权限**（它们能做的事和 server 一样多）。`http`/`sse`/`acp` 传输目前明确报「不支持」而不是静默忽略。

## 约定与规范

> 下面这些不是口头承诺：**架构契约与发布卫生由 `npm run arch:test` 机检，全套回归由 `npm run verify` 一键跑**（改坏了必须变红——检查脚本本身也反向验证过：故意在协议层 import 一次 pi、或让功能层反向依赖入口层，都会报错）。
> 新增能力时，本节与 README 里对应的表格要跟着一起改。

### 1. 分层契约

五层依赖**只向下**（`model` → `kernel` → `features` → `protocols` → `entries`，层号见上文「分层」），同层内可以互相引用。

| 规则 | 为什么 | 检查 |
| --- | --- | --- |
| 只允许上层 import 下层，禁止反向 | 反向依赖意味着内核/功能层知道协议，换个协议就得改内核 | `arch:test` |
| 横向边只有两条：`features/runtime.ts → extensions/*`（必须 `import type`）、`extensions/* → features/{contract,events,tool-annotations}.ts` | 插件宿主必须能被功能层调用；插件只能用「契约文件」里的词汇，不能碰运行时实现 | `arch:test` |
| `protocols/` 与 `entries/` 零 `@earendil-works/*` | 协议层与入口层不认识 pi；换掉 pi 时这两层不用动 | `arch:test` |
| `@agentclientprotocol/sdk` 只出现在 `protocols/` | ACP 只是「一种」协议实现，不能渗进功能层 | `arch:test` |
| `new Agent({ ... })` 只允许出现在 `kernel/agent.ts` | 「接 pi 的位置」只有一处，CLI 与编辑器行为天然一致 | `arch:test` |
| `src/types.ts` 零依赖 | 它是跨层共享类型，不能变成隐性依赖源 | `arch:test` |
| 协议层拿工具/类型只走 `features/contract.ts` | 类型也走契约，别各自 `import` pi | 约定 |

四条对应的「实现约定」：

- **契约文件**：`features/contract.ts`（TypeBox / `AgentTool`）、`features/events.ts`（事件词表）、`features/tool-annotations.ts`（工具声明）、`extensions/api.ts`（插件契约）——它们是层与层之间唯一的词汇表。
- **事件词表是唯一的对外语言**：协议层与入口层只说 `features/events.ts` 里那套事件，不吐 pi 的原始事件，也不吐 ACP 专属事件。
- **内核是唯一的装配点**：`createKernelAgent()` 负责 systemPrompt、工具表、hooks 组合（含内置失败轮过滤 + 插件 `transformContext` 的顺序）。
- **错误编码进流**：`StreamFn` 不 throw，见下文第 4 节。

动手前的自检（新增东西时先问这三个问题）：

1. **这属于哪一层？** 能力 → 功能层或插件；协议 → `protocols/`；模型接入 → `model/`。
2. **能不能做成插件？** 只有引导（`kernel/`、`model/`、`extensions/host.ts`）、边界（权限闸门、路径收敛、截断）、协议（`protocols/`、`entries/`）三件事进核心，其余都走插件。
3. **加协议要不要动内核？** 不用：新协议在 `protocols/` 下加目录，新模型协议在 `model/` 里加分支（`streamFn` 按 `model.api` 路由）。

### 2. 命名与目录

| 类别 | 约定 | 例子 |
| --- | --- | --- |
| 目录 | 固定六层 + `web/` `scripts/` `examples/` | `src/features/` |
| 文件名 | kebab-case | `local-tools.ts`、`change-preview.ts` |
| 函数 / 变量 | camelCase；工厂用 `createXxx` | `createToolRegistry()` |
| 类型 / 接口 | PascalCase | `AgentRuntimeOptions` |
| 常量 | UPPER_SNAKE | `LOCAL_PERMISSION_TOOLS` |
| 工具变量 | `xxxTool`；工具**名**用 snake_case | `readFileTool` / `"read_file"` |
| MCP 工具名 | `mcp__<server>__<tool>` | `mcp__mock__echo` |
| 内置插件 | `extensions/builtin/<name>.ts`，导出 `<name>(pi)` 工厂 | `demoTools(pi)` |
| 测试脚本 | `scripts/<能力>-test.mjs` + 同名 npm script | `scripts/mcp-test.mjs` |

代码风格（仓库没有 lint/format 配置，全靠约定）：**tab 缩进、双引号、语句带分号、`import type` 优先**、ESM 相对导入带 `.js` 后缀（NodeNext）、注释与标识符**英文**、README 与提交信息**中文**。

单文件超过约 300 行就考虑拆（`features/local-tools.ts` 541 行是当前上限；再往里加能力先拆文件）。

### 3. 依赖纪律

- 运行时依赖白名单：`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@agentclientprotocol/sdk`（`arch:test` 会查）。
- `ws` 只能出现在 `optionalDependencies`，且**缺失时必须降级**（WebSocket 传输不可用，HTTP 照常）。
- **不依赖 `pi-coding-agent`**：它会把依赖树从 10.5M 拉到 434M，而且内置工具与扩展宿主都在里面——本项目要自己写这两块。
- 新增运行时依赖要先回答「标准库为什么不够」；`devDependencies` 只放 `tsx` / `typescript` / `@types/node`。

### 4. 错误处理

| 场景 | 约定 |
| --- | --- |
| `StreamFn` | **永不 throw**：错误编码进流（`errorStream()`），否则 Agent 循环会炸 |
| 插件加载失败 | 记录并跳过，不影响其它插件；钩子抛错只写日志，**不中断本轮** |
| 会话持久化失败 | 吞掉 + 日志：丢历史不能影响对话本身 |
| MCP server 起不来 | 记日志跳过，工具不进表；非 stdio 传输明确报「不支持」而不是静默忽略 |
| 权限被拒 | 闸门返回 `{ block: true }` → 变成 `isError` 的工具结果回灌给模型，让模型自己换招 |
| 取消（aborted） | 不是错误：不重试、不报错，`stopReason = cancelled` |
| 日志 | stdio 模式下只写 stderr，**stdout 只走协议**；`--quiet` 只留错误 |

### 5. 工具与安全

- 每个工具自己声明 `permission` / `metadata` / `describe`（`features/tool-annotations.ts`），**核心工具与插件工具共用同一套**；协议层与权限闸门「先问工具，再兜底」，不再维护工具名硬编码表。
- 工具 `execute` 返回 `content`（回灌给模型）+ `details`（给 UI / 日志）。
- **安全边界在核心，插件只能加约束**：路径收敛（软链解析 + 大小写按平台）、隐藏项跳过、读文件与命令输出截断、命令超时——这些不可被插件放宽。
- 审批要给出**将要发生什么**：`describe` 返回 diff 预览，CLI 打彩色 diff，ACP 塞进 `session/request_permission` 的 `toolCall.content`。
- MCP 工具一律先问权限（它们能做的事和 server 一样多）。

### 6. 测试

- **一个能力 = 一个测试脚本**：`scripts/<能力>-test.mjs` + npm script，用 `check(name, ok, detail)` 输出 `✓/✗` 与结尾的 `N/N checks passed`（`npm run verify` 就靠这一行汇总）。
- **离线优先**：所有测试都打到 `scripts/mock-server.mjs`，不联网、不烧真实额度（`verify` 启动 ACP server 时会用 mock 环境变量覆盖 `.env`）。
- **端到端优先**：真浏览器（headless Chrome + CDP）、真子进程、真 HTTP/SSE、真 ACP 客户端；尽量不做「纯 mock 的单测」。
- **自起自停**：脚本自己 spawn mock / ACP server，收尾 `SIGTERM`；端口从环境变量取（见下表），不抢端口。
- **隔离本机配置**：测试用临时 `HOME`，所以 `~/.steve/`（全局插件、`mcp.json`、`.env`）不会影响断言——你自己的插件不该让回归变红。
- **断言要能失败**：写完后故意改坏一次，确认变红（`arch:test` 就是这么验的）。

| 脚本 | mock 端口 | ACP 端口 |
| --- | --- | --- |
| `npm run mock`（默认） | 8899 | — |
| `npm run verify`（起服务给浏览器测试用） | 8899 | 8890 |
| `npm run tools:test` | 8897 | 8894 |
| `npm run plugins:test` | 8898 | 8893 |
| `npm run mcp:test` | 8894 | 8892 |
| `npm run sessions:test` | 8896 | 8895 |

### 7. 提交与发布

- 提交信息**中文**、结构化（标题 + 新增 / 改动 / 测试 / 回归分段），**一个提交一个主题**。
- 提交要跳过用户全局的 lefthook：`LEFTHOOK=0 git commit ...`。
- push 必须绕开全局代理（对 `github.com:443` 会 `SSL_ERROR_SYSCALL`）：`git -c http.proxy= -c https.proxy= push origin main`。
- **历史改写只在明确 lease 下**：`--force-with-lease=main:<sha>`，绝不 blind force。
- **发布卫生**（`arch:test` 会查）：`.env` 与整个 `.steve/`（本地配置、`mcp.json`、插件、会话记录）永不入库，只提交 `.env.example`；公开文件里不出现内网域名、key 片段、真实模型 id——文档里的网关一律写成 `https://your-gateway.example.com`。

### 8. 文档

- **新能力 = 代码 + README 对应表格 + 测试脚本**，三件套缺一不算完成。
- README 中文、代码注释英文；涉及环境变量的命令同时给 POSIX 与 PowerShell 写法。

### 决策记录（为什么是这样）

| 决策 | 原因 | 代价 |
| --- | --- | --- |
| 不依赖 `pi-coding-agent` | 依赖树 10.5M → 434M，且内置工具 / 扩展宿主都在里面 | 本地工具、插件宿主都得自己写 |
| 自己写插件宿主（pi 风格，**不是** pi 扩展兼容层） | pi 的扩展由 `pi-coding-agent` 的 runner 加载；`pi-agent-core` 只暴露 `transformContext` / `beforeToolCall` / `afterToolCall` / `streamFn` 等接缝 | 现成的 pi 扩展文件不能直接用 |
| 插件优先，而非插件唯一 | 一切**能力**走插件；引导、边界、协议三件事留在核心 | 需要不断用 dogfooding 检验 API 是否够用 |
| MCP 实现留在核心、由插件声明 | 子进程生命周期必须被保证（会话结束要关干净） | 插件只能声明，不能自己实现传输 |
| 会话持久化留在核心 | 「存哪里 / 存不存」是引导决策，丢历史不可接受 | 插件无法替换存储实现 |
| 工具声明化（permission / metadata / describe） | 协议层不该认识具体工具名；MCP 与插件工具也需要审批预览 | 多一层注册表与兜底逻辑 |
| 重试放功能层 | 协议无关，编辑器与终端行为一致；取消不重试 | 功能层要处理回滚与上下文净化 |
| 路径收敛放核心 | 这是安全边界，插件只能加约束不能放宽 | 工具无法自行定义「越界」 |
| `--allow-local-tools` 默认关 | 编辑器里的 agent 不该悄悄绕过编辑器沙箱改本机文件 | 客户端没有 fs/terminal 能力时需要显式开启 |

## 换个模型 / 加个工具

- 换模型：改 `.env` 即可。换协议时只需要 `LLM_API`（或让 baseUrl 自动判定），`Agent` 侧代码一行都不用动。
- 加工具：**推荐写插件**（`registerTool`，见上文「拓展」），这样两端同时生效、还能声明权限与呈现。核心内的工具分两处：本地工具在 `src/features/local-tools.ts`，依赖客户端能力的在 `src/protocols/acp/tools.ts`；`execute` 里返回 `content`（回灌给模型）+ `details`（给 UI/日志）。演示工具就是内置插件（`src/extensions/builtin/demo-tools.ts`）。
- 改内核装配（streamFn / 上下文净化 / thinking 等级 / hooks）：只动 `src/kernel/agent.ts` 一处，CLI 与 ACP 同时生效。
- 加能力而不改代码：写个插件（见上文「拓展」），`STEVE_EXTENSIONS=...` 或 `--extension` 加载即可，两端同时生效。
