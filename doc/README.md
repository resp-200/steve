# steve 文档

| 文档 | 内容 |
| --- | --- |
| [model-integration.md](./model-integration.md) | 如何把 steve 接到不同的模型 / 网关上，以及每个环境变量参数的含义 |

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

详见 [model-integration.md](./model-integration.md)。项目整体说明（分层、插件、ACP、约定与规范）在主 [README](../README.md)。
