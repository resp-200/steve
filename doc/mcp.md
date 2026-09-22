# steve MCP 接入指南

本文说明 steve 怎么连 MCP（Model Context Protocol）server：三种来源、优先级、工具怎么进工具表、
连接时机与生命周期、`/mcp` 怎么看、以及**没实现什么**。
对应源码：`src/features/mcp.ts`、`src/extensions/builtin/mcp-config.ts`，实测过的 server 见 §10。

---

## 1. 一句话

MCP server **只支持 stdio**（`http` / `sse` / `acp` 明确报不支持，不静默忽略）。
server 的来源有三个，工具以 `mcp__<server>__<tool>` 命名进工具表，**每次调用都先问权限**。

---

## 2. 三种来源与优先级

| 来源 | 怎么声明 | `/mcp` 里的 `source` |
| --- | --- | --- |
| **插件** | `pi.registerMcpServer({ name, command, args, env, timeoutMs })` | `plugin` |
| **ACP 客户端** | 编辑器在 `session/new` / `session/load` 里传 `mcpServers` | `client` |
| **项目配置** | `<cwd>/.steve/mcp.json` | `project` |
| **全局配置** | `~/.steve/mcp.json` | `global` |

同名时按优先级取一个（`src/features/mcp.ts` 的 `SOURCE_PRIORITY`）：

```
plugin = client (3)  >  project (2)  >  global (1)
```

同优先级先声明者胜。落败的那条**不会消失**：它在 `/mcp` 里显示为 `skipped` 并说明原因，
日志里也会有一行 `MCP server "x" (global) ignored: the plugin declaration wins`。

> 为什么必须去重：两个同名 server 会产生同名的 `mcp__x__y` 工具，工具表里就会出现冲突。

---

## 3. `.steve/mcp.json`（内置插件 `mcp-config`）

格式和 Claude Desktop / Cursor 一致，可以直接抄；仓库根目录有模板 `mcp.example.json`：

```bash
mkdir -p .steve && cp mcp.example.json .steve/mcp.json
```

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "timeoutMs": 120000
    },
    "amap-maps": {
      "command": "npx",
      "args": ["-y", "@amap/amap-maps-mcp-server"],
      "env": { "AMAP_MAPS_API_KEY": "..." }
    }
  }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `command` | stdio 必填 | 可执行文件 |
| `args` | | 字符串数组 |
| `env` | | 对象，值按字面量传给子进程（数字/布尔会转成字符串） |
| `timeoutMs` | | 握手超时；`npx -y <pkg>` 首次要下载，**默认 20s 常常不够**，建议 `120000` |
| `type` | | 传输；只有 `stdio` 实现，写别的会被 `/mcp` 报 `unsupported` |

三条规则：

1. **不插值**：`${VAR}` 不会被展开，原样传给 server（会打一行提示）。要读环境变量请写插件。
2. **坏文件 / 坏条目只记日志并跳过**：缺 `command`、`args` 不是字符串数组、JSON 语法错，都不会影响会话。
3. **`.steve/` 整个目录都在 `.gitignore` 里**，所以明文 key 只留在本机（这也是不做插值的前提）。

`"//"` 之类的额外键会被忽略，可以当注释用（模板里就是这么写的）。

---

## 4. 插件里声明

需要读环境变量、或按平台/cwd 拼参数时用插件（完整示例 `examples/extensions/mcp-server.mjs`）：

```js
export default function (pi) {
  pi.registerMcpServer({
    name: "filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", pi.ctx.cwd],
    timeoutMs: 120_000,
  });
}
```

`registerMcpServer` 只校验 `name`（stdio 还需要 `command`）。它**不连接**任何东西 —— 连接由核心负责，
插件只是声明"这个会话需要这些 server"。

---

## 5. 工具怎么进工具表

| 环节 | 行为 |
| --- | --- |
| 命名 | `mcp__<server>__<tool>`（`/tools` 能看到；避免与核心工具撞名） |
| 参数 schema | MCP 的 `inputSchema`（JSON Schema）**原样**当 `parameters` 用；没有 schema 时退化为 `{}` |
| 权限 | **一律 `permission: "ask"`**：MCP server 能做的事和它自己一样多 |
| 呈现 | `metadata: { kind: "other", title: "<server>: <tool>" }`，所以编辑器的工具卡片用它渲染 |
| 调用 | `tools/call`；`isError: true` 的结果**抛出**，变成 `isError` 工具结果回灌给模型 |
| 非文本结果 | `image` / `resource` 内容块摘要成 `[image image/png]` / `[resource <uri>]` |

---

## 6. 连接时机与生命周期

这是踩过坑的地方（编辑器会杀慢进程）：

```
session/new ──▶ 立即返回（不 await MCP）
                 └─ 后台 connectMcpServers()
                      ├─ server A 连上 → 立刻 addTools() + 更新 /mcp 状态
                      ├─ server B 连上 → 同上（不等 A 之后的其它 server）
                      └─ server C 失败 → 只记日志，状态标 failed
```

- **`session/new` 不等 MCP**：编辑器对初始化有超时（IDEA 超时会报 `Failed to initialize ACP process`，`exit code 143`）。
  实测：加了 `SLOW_INIT_MS=1500` 的慢 server，`session/new` 仍然是 **22ms**。
- **每个 server 一连上就挂载**：一个慢 server（`npx` 冷启动）不会拖住其它 server 的工具。
  副作用：**第一个问题可能还没有 MCP 工具**，从第二个问题起就有。
- **子进程 cwd = 会话 cwd**：编辑器从别处启动 ACP server 时，`args: ["."]`、相对脚本路径仍指向项目目录。
- **超时**：每个请求默认 20s（`timeoutMs` 可覆盖，`registerMcpServer({ timeoutMs })` 每 server 可调）。
- **关闭**：会话 dispose / `session/delete` / CLI 退出时关闭子进程（SIGTERM，1s 后 SIGKILL）。
- **错误信息带 stderr 末行**：server 挂掉时把它的 stderr 最后一行并进错误，所以 `/mcp` 能直接告诉你原因。

---

## 7. `/mcp` 怎么看

CLI 与编辑器里都有这个命令（内置插件 `session-commands` 提供）：

```
$ /mcp
mockmcp [plugin] stdio — /usr/bin/node scripts/mock-mcp-server.mjs
  4 tool(s): echo, sum, fail, image
remote [project] http
  unsupported — MCP server "remote": transport "http" is not supported yet (only stdio)
amap-maps [project] stdio — npx -y @amap/amap-maps-mcp-server
  skipped — MCP server "amap-maps" (project) ignored: the plugin declaration wins
amap-maps [plugin] stdio — npx -y @amap/amap-maps-mcp-server
  12 tool(s): maps_regeocode, maps_geo, maps_weather, …
```

| 状态 | 含义 |
| --- | --- |
| `connected` | 已连上，后面是它提供的远端工具名 |
| `failed` | 启动或握手失败，后面是原因（含 server 自己的 stderr 末行） |
| `unsupported` | 传输不支持（只有 stdio） |
| `skipped` | 同名冲突里落败的那条，后面说明谁赢了 |

---

## 8. 排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `failed — … exited (code 1): <原因>` | server 自己启动失败，多半缺 env（API key）。`/mcp` 现在会把它 stderr 的末行带出来 |
| `failed — MCP initialize timed out` | `npx -y` 首次下载太慢 → 加 `timeoutMs`（`120000`），或先 `npm i -g <pkg>` |
| `unsupported — transport "http"` | 只实现了 stdio |
| 同名 server 只连上一个 | 按 §2 的优先级取一个；`/mcp` 里另一条是 `skipped` |
| `[extensions] failed to load …`（插件整个没加载） | `registerMcpServer` 校验失败（缺 `name`，或 stdio 缺 `command`）会让**整个插件**加载报错 |
| 第一个问题用不上 MCP 工具 | 正常：后台连接还没完成，第二个问题起就有 |
| 想确认到底连了什么 | `/mcp`；或看 stderr 的 `[mcp <name>] connected, N tool(s)` / `[mcp <name>] mcp ready` |
| 手动确认 server 自己能起来 | 直接跑 `command + args`（stdio server 会等 JSON-RPC，不会自己退出） |

---

## 9. 没实现的部分（诚实清单）

| 没做 | 后果 |
| --- | --- |
| `http` / `sse` / `acp` 传输 | `/mcp` 里报 `unsupported` |
| server → client 的请求（sampling、roots、elicitation） | 一律忽略。实测 filesystem server 会打印 `Client does not support MCP Roots`，改用命令行参数限定目录 |
| `resources` / `prompts` | 只当工具用，这两类能力没暴露 |
| `notifications/tools/list_changed` | 工具表是**连接时的快照**，运行期不热更新 |
| `notifications/progress` | `tools/call` 期间没有中间反馈，长任务只能等 |
| OAuth / HTTP 认证 | 没有；密钥靠 `env` 传 |

另外两个已知取舍：stderr 只保留末 3 行；协议版本固定 `2024-11-05`（协商降级由 server 决定）。

---

## 10. 实测过的 server

| server | 工具数 | 说明 |
| --- | --- | --- |
| `@amap/amap-maps-mcp-server` | 12 | 需要 `AMAP_MAPS_API_KEY`；缺 key 时启动即退出，`/mcp` 会显示 server 自己打印的原因 |
| `@modelcontextprotocol/server-filesystem` | 14 | 最后一个参数是允许目录；实测能读到真实文件内容 |
| `scripts/mock-mcp-server.mjs`（仓库自带） | 4 | 离线 fixture：`echo` / `sum` / `fail`（isError）/ `image`；支持 `SLOW_INIT_MS` 模拟慢启动 |

---

## 11. 代码位置

| 文件 | 职责 |
| --- | --- |
| `src/features/mcp.ts` | 最小 MCP 客户端：stdio 分帧、`initialize`/`tools/list`/`tools/call`、超时、stderr 末行、按来源优先级去重、`onServer` 增量回调 |
| `src/extensions/builtin/mcp-config.ts` | 内置插件：读 `~/.steve/mcp.json` 与 `<cwd>/.steve/mcp.json`，校验每个条目 |
| `src/extensions/api.ts` | `registerMcpServer` 与 `PluginMcpServer` 类型 |
| `src/extensions/builtin/session-commands.ts` | `/mcp` 命令（读 `ctx.session.mcp`） |
| `src/types.ts` | `McpServerStatus`（跨层共享的状态形状） |
| `src/protocols/acp/agent.ts` | 合并客户端 + 插件声明的 server，后台连接并逐个挂到会话 |
| `scripts/mock-mcp-server.mjs` | 离线 MCP server fixture |
| `scripts/mcp-test.mjs` | 42 项机检（`npm run mcp:test`） |
