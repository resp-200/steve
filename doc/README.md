# steve 文档

| 文档 | 内容 |
| --- | --- |
| [model-integration.md](./model-integration.md) | 如何把 steve 接到不同的模型 / 网关上，以及每个环境变量参数的含义 |
| [acp-server.md](./acp-server.md) | ACP 服务端：启动参数、编辑器接入、线协议（Streamable HTTP）、工具与权限、持久化、排查 |
| [mcp.md](./mcp.md) | MCP 接入：三种来源与优先级、`.steve/mcp.json`、工具映射、连接时机、`/mcp`、没实现什么 |
| [plugins.md](./plugins.md) | 插件开发：发现位置、`pi.ctx`、四类钩子、三类贡献、失败语义、什么时候该写成插件 |

项目整体说明（分层、约定与规范、测试、发布）在主 [README](../README.md)。

## 30 秒速查

改 `.steve/.env` 里三个必填项即可换模型，其余按需：

```ini
LLM_API_KEY="<你的 key>"
LLM_MODEL_ID="<模型名>"
LLM_BASE_URL="<端点根地址>"      # Anthropic 形如 https://host/anthropic；OpenAI 形如 https://host/v1
```

| 协议 | `LLM_API` | `LLM_BASE_URL` 示例 |
| --- | --- | --- |
| Anthropic Messages | `anthropic-messages`（可自动判定） | `https://host/anthropic` |
| OpenAI Chat Completions | `openai-completions`（可自动判定） | `https://host/v1` |
| OpenAI Responses | `openai-responses`（**必须显式设置**） | `https://host/v1` |

| 想做的事 | 看哪篇 |
| --- | --- |
| 换模型 / 网关、搞清楚每个环境变量 | [model-integration.md](./model-integration.md) |
| 让编辑器（IDEA / Zed）连上 | [acp-server.md](./acp-server.md) §2–3 |
| 接一个 MCP server | [mcp.md](./mcp.md) §2–3 |
| 加工具 / 加斜杠命令 / 挂钩子 | [plugins.md](./plugins.md) |
