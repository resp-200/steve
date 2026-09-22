# steve 插件开发指南

本文说明 steve 的插件机制：**放在哪、能挂哪些接缝、怎么写第一个插件、失败会怎样、什么时候该写成插件**。
对应源码：`src/extensions/api.ts`（契约）、`src/extensions/host.ts`（宿主）、`src/extensions/discovery.ts`（发现）。

---

## 1. 一句话

插件是一个独立的 ES module，导出 `default (pi) => {}`。它能**加工具、加斜杠命令、加 MCP server、挂四类钩子、观察事件**，
但**只能加约束、不能放宽安全边界**（路径收敛、权限闸门、截断都在核心）。

```js
export default function myPlugin(pi) {
  pi.registerTool({
    name: "hello",
    description: "Say hello.",
    parameters: pi.Type.Object({ who: pi.Type.Optional(pi.Type.String({})) }),
    execute: async (_id, params) => ({ content: [{ type: "text", text: `hello ${params.who ?? "world"}` }] }),
  });
}
```

---

## 2. 放在哪（发现顺序）

| 位置 | 作用范围 | 备注 |
| --- | --- | --- |
| `<cwd>/.steve/extensions/*.mjs` | 项目级 | 自动发现；`.steve/` 已 gitignore |
| `~/.steve/extensions/*.mjs` | 全局 | 自动发现，所有项目生效 |
| `--extension <path>`（ACP）/ `STEVE_EXTENSIONS=a.mjs,b.mjs` | 单次运行 | 显式指定，文件或目录 |
| `STEVE_DISCOVERY=off` / `--no-discovery` | 单次运行 | 只加载显式指定的插件，跳过上面两个目录 |

- 目录发现只收 `.mjs` / `.js`，按文件名排序；显式路径排在发现结果之前。
- 重名去重（同一个文件不会加载两次）。
- 编辑器场景：插件跟着**会话 cwd** 走，不跟安装目录走。

---

## 3. 插件能看到什么（`pi.ctx`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ctx.cwd` | `string` | 会话工作目录 |
| `ctx.mode` | `"cli" \| "acp"` | 哪个前端加载的 |
| `ctx.sessionId` | `string?` | 会话 id（CLI/ACP 都有） |
| `ctx.hasUI` | `false` | 目前没有前端把交互 UI 交给插件（保留字段） |
| `ctx.log` | `(msg) => void` | 写日志（两端都走 stderr，带 `[plugin <file>]` 前缀；stdio 模式下 stdout 只走协议） |
| `ctx.exec` | `(cmd, args?, opts?) => Promise<{stdout,stderr,code}>` | 跑命令（不进编辑器的终端） |
| `ctx.workspace` | `WorkspacePolicy` | **只读策略**：`{ roots, access, shell? }`，见 §5 |
| `ctx.session` | `SessionAccessors` | 运行时内省，见下 |

`ctx.session` 提供：`tools`（当前工具列表）、`commands`、`model`（含 `supportsImages`）、`mcp`（MCP 状态）、
`stats()`（turns/tokens 计数）、`reset()`。

> **工厂执行阶段只有"静态"信息是准的**：`ctx.workspace` 与 `ctx.session.model` 在前端加载插件前就已确定，
> 所以插件可以在注册时据此决定注册什么。`ctx.session.tools` / `stats()` 这些是**运行时**之后才填的，
> 在工厂里读到的是空值 —— 需要它们请写在命令或工具执行体里。

---

## 4. 能挂的接缝

### 4.1 四类钩子

| 钩子 | 触发时机 | 返回值语义 |
| --- | --- | --- |
| `pi.on("tool_call", (event, ctx) => …)` | 每次工具调用**之前**（在权限闸门之前） | `{ block: true, reason }` 直接拒绝这次调用 |
| `pi.on("tool_result", (event, ctx) => …)` | 工具执行完、模型看到结果之前 | `{ text?, details?, isError? }` 局部改写 |
| `pi.on("context", (messages, ctx) => …)` | 每轮发给模型之前（在内置"失败轮过滤"之后） | 返回新的消息数组替换 |
| `pi.on("before_provider_headers", (headers, info, ctx) => …)` | 每个请求组装 header 时 | **同步**（streamFn 不能 await），就地改 `headers` |

### 4.2 观察事件

`pi.on(<eventType>, (event, ctx) => …)`，事件词表在 `src/features/events.ts`：

```
turn_start · text_delta · thinking_delta · tool_start · tool_update · tool_end · turn_end
```

事件回调的返回值被忽略（只用来观察/记日志）。

### 4.3 贡献能力

```js
pi.registerTool({ name, label?, description, parameters, execute, permission?, metadata?, describe? });
pi.registerCommand({ name, description, run: (args, ctx) => string | undefined });
pi.registerMcpServer({ name, command, args?, env?, timeoutMs?, type? });
```

**工具的三个注解**（核心工具与插件工具共用同一套，见 `features/tool-annotations.ts`）：

| 注解 | 作用 |
| --- | --- |
| `permission: "ask"` | 执行前让权限闸门问用户（CLI 终端 y/n、编辑器弹窗） |
| `metadata: { kind, title }` | 客户端怎么呈现（`kind` 是 ACP 的 `read`/`edit`/`execute`/`other`，`title` 可为函数） |
| `describe: (args) => ToolChangePreview` | **审批预览**：返回 `{ summary, text?, file? }`（`file` 是 `{ path, oldText?, newText? }`），CLI 打印 diff、编辑器渲染 diff 卡片 |

`execute` 返回 `content`（回灌给模型）+ `details`（给 UI / 日志）；抛错会被转成 `isError` 工具结果。

命令的返回值会作为消息发回给用户（CLI 打印、ACP 变成 `agent_message_chunk`）。插件命令在两端都可用：
CLI 里输入 `/name`，编辑器里由 `available_commands_update` 播报、会话本地执行。

---

## 5. 会话策略（`ctx.workspace`）

前端**发布**策略，插件**只读**它：

```ts
ctx.workspace = {
  roots: string[],                                   // 路径收敛边界
  access: "none" | "read" | "write" | "exec",        // 阶梯，每级在上一级基础上加工具
  shell?: { file: string; args: string[] },
}
```

内置插件 `local-tools` 就是靠它决定注册哪些工具的：`none` 什么都不注册、`read` 只注册读工具、
`write` 加写工具、`exec` 再加 `run_command`（写/执行仍然过权限闸门）。

**插件只能收窄，不能放宽**：路径收敛、截断、权限闸门都在核心，`access` 由前端给，插件改不了。

---

## 6. 三种东西（Tier）与失败语义

| Tier | 是什么 | 加载语义 |
| --- | --- | --- |
| 0 核心 | 引导（`model/`、`kernel/`、`host`）、边界（权限闸门/路径收敛/截断）、协议 | 编译进去，不可关 |
| 1 内置插件 | `session-commands`、`local-tools`、`demo-tools`、`mcp-config` | **默认必装**；可拆卸只是为了测试与替换（`builtins: false`） |
| 2 发现插件 | 你写的插件 | 失败隔离 |

失败语义（`npm run plugins:test` 有断言）：

- **工厂抛错**（`export default` 执行时）→ 该插件被跳过，`host.errors` 记录，**其它插件照常加载**；
  `/plugins` 里会列出 `failed <file>: <message>`。
- **钩子抛错** → 只记日志，**不中断本轮**（工具调用/对话继续）。
- **`ctx.exec` 失败** → 返回 `{ code }`，不抛。

---

## 7. 同名工具：前端优先

前端（例如 ACP 客户端提供的 `read_file`）先注册，插件同名的那条**被丢弃并记日志**：

```
tool "read_file" from a plugin ignored: already provided by the front end
```

插件不能悄悄替换宿主已有的工具。要"故意替换"需要一个显式的 `override` 标记（**尚未实现**，见主 README 的「接下来」）。

---

## 8. 什么时候该写成插件（判据）

"是不是能力"**不是**判据。问三个问题（详见主 README「约定与规范」第 2 节）：

| 问题 | 偏向插件 | 偏向核心 |
| --- | --- | --- |
| ① 有变体预期吗（多实现、按用户/组织变化） | 会 | 只有唯一实现 |
| ② 装配代码重复吗（每个前端都要知道它的参数） | 重复 | 一处装配 |
| ③ 它在边界上吗（判断者 / 引导 / 协议专属） | 是能力（被执行的一侧） | 是边界本身、引导、协议映射 |

还有两条硬规则（`arch:test` 机检）：

- **能力实现只能被它的插件引用**：`features/local-tools.ts` 只允许 `extensions/builtin/local-tools.ts` import。
- **入口不实现插件命令**：`entries/` 里不得出现 `case "/new"` 之类（两份实现必然漂移）。

**API 增长红线**：如果为了搬一个能力要公开越来越多的核心配置字段，说明方向错了 —— 停下重新设计。

---

## 9. 内置插件与示例

内置（`src/extensions/builtin/`）：

| 插件 | 贡献 |
| --- | --- |
| `session-commands.ts` | `/help` `/new` `/tools` `/stats` `/model` `/mcp`（CLI 与编辑器共用） |
| `local-tools.ts` | 6 个本地工具，按 `ctx.workspace.access` 注册 |
| `demo-tools.ts` | `get_current_time`（演示用） |
| `mcp-config.ts` | 读 `.steve/mcp.json`（项目 + 全局） |

示例（`examples/extensions/`，可直接加载）：

| 文件 | 演示什么 |
| --- | --- |
| `git-status.mjs` | `registerTool` + `registerCommand`（用 `ctx.exec` 跑 git） |
| `guard-destructive.mjs` | `on("tool_call")` 拦下危险命令（在权限询问之前） |
| `turn-logger.mjs` | 观察 `turn_end` 事件 + 改 `before_provider_headers` |
| `mcp-server.mjs` | `registerMcpServer` 接入 MCP（含 `timeoutMs` 与密钥读取） |

跑起来：

```bash
STEVE_EXTENSIONS=examples/extensions/turn-logger.mjs npm run dev
npm run acp -- --extension examples/extensions/guard-destructive.mjs
# 或者放进目录，自动发现：
cp examples/extensions/git-status.mjs .steve/extensions/
```

查看加载了什么：CLI 里 `/plugins`（列出文件、钩子计数、插件命令、MCP server、加载失败）。

---

## 10. 排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 插件没生效 | `STEVE_DISCOVERY=off` 时只加载显式指定的；确认文件在 `.steve/extensions/` 或 `~/.steve/extensions/`，且以 `.mjs`/`.js` 结尾 |
| `[extensions] failed to load <file>: …` | 工厂抛错。最常见：`registerTool` 缺 `name`/`execute`、`registerCommand` 缺 `name`/`run`、`registerMcpServer` 缺 `name`（stdio 还缺 `command`） |
| `default export must be a function` | 忘了 `export default (pi) => {}` |
| 工具注册了但模型不调用 | 检查 `description` 是否说清用途；`/tools` 确认它在表里 |
| 工具没有审批弹窗 | 少了 `permission: "ask"`；注意**核心闸门只看声明**，插件不能绕过它 |
| 工具卡片只有名字、没有好看标题 | 加 `metadata: { kind, title }`；协议层不认识工具名，不会兜底 |
| 审批卡片没有 diff | 加 `describe: (args) => ({ summary, text })`（或 `file`），核心会把它交给 CLI/编辑器渲染 |
| 插件命令在 CLI 里没反应 | 用 `/plugins` 看是否注册成功；名字不要与 host 级命令冲突（`/exit` `/quit` `/plugins` 由 CLI 自己实现） |
| 钩子抛错但对话没断 | 这是设计：只记日志。去 stderr 找 `[plugin <file>]` |

---

## 11. 代码位置

| 文件 | 职责 |
| --- | --- |
| `src/extensions/api.ts` | 插件契约：`ExtensionAPI`、`ExtensionContext`、`PluginTool` / `PluginCommand` / `PluginMcpServer`、各类 handler 类型 |
| `src/extensions/host.ts` | 宿主：加载、隔离、钩子链、命令执行、工具/命令/MCP 收集、`attachSession` |
| `src/extensions/discovery.ts` | 发现与 `STEVE_EXTENSIONS` / `STEVE_DISCOVERY` 解析 |
| `src/extensions/builtin/*` | 四个内置插件（Tier 1） |
| `src/features/runtime.ts` | 钩子接到 pi 的 `beforeToolCall` / `afterToolCall` / `transformContext`；合并前端与插件工具（同名去重） |
| `examples/extensions/*` | 四个示例插件 |
| `scripts/plugin-test.mjs` | 26 项机检（`npm run plugins:test`） |
