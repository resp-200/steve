# steve 模型接入指南

本文说明 steve 如何接到不同的模型 / 网关，以及 `.env` 里每个参数的确切含义。
所有结论都对应到源码：`src/model/config.ts`、`src/model/stream.ts`。

---

## 1. 数据流

```
.env 文件 / 真实环境变量
  └─ loadConfig()                       src/model/config.ts
       ├─ envFileCandidates() + loadEnvFiles()   读取 .env 查找链
       ├─ buildModel()                  构造 pi-ai 的 Model（api/baseUrl/compat/…）
       │    ├─ resolveApi()             LLM_API 或按 baseUrl 自动判定
       │    └─ resolveAuthStyle()       LLM_AUTH_STYLE
       └─ systemPrompt / apiKey
  └─ createStreamFn(apiKey, authStyle)  src/model/stream.ts
       ├─ hasApi(model, "anthropic-messages") → pi-ai/api/anthropic-messages
       ├─ hasApi(model, "openai-completions") → pi-ai/api/openai-completions
       └─ hasApi(model, "openai-responses")   → pi-ai/api/openai-responses
  └─ Agent（pi-agent-core）             src/kernel/agent.ts
```

要点：`LLM_API` 决定用哪个**协议适配器**，`LLM_BASE_URL` 只决定**发到哪**。二者必须匹配（例如
Anthropic 协议的 baseUrl 不能填成 `.../v1`），否则会 404。

---

## 2. 配置文件的位置与优先级

凭据从 `.env` 文件读，**优先级从低到高**（后面的覆盖前面的）：

| 顺序 | 路径 | 用途 |
| --- | --- | --- |
| 1 | `<安装目录>/.env` | 兼容旧写法；编辑器从别的 cwd 拉起 ACP server 时的兜底 |
| 2 | `<安装目录>/.steve/.env` | 同上，新位置 |
| 3 | `~/.steve/.env` | 全局，对所有项目生效 |
| 4 | `$PWD/.env` | 兼容旧写法 |
| 5 | `$PWD/.steve/.env` | **推荐**，每个项目自己的网关/模型 |

- `<安装目录>` = `src/model/config.ts`（或 `dist/model/config.js`）往上两级，即仓库根。
- **真实环境变量永远最优先**：`LLM_MODEL_ID=xxx npm run dev` 会盖过所有 `.env` 文件。
- `.steve/` 整个目录都在 `.gitignore` 里，本地配置与密钥不会进仓库（`npm run arch:test` 会机检）。

`.env` 解析规则（`parseEnvFile`）：

- 形如 `KEY=VALUE`，`=` 两侧空白会被 trim；
- `#` 开头的整行是注释；不含 `=` 的行直接忽略；
- 值两端成对的 `'` 或 `"` 会被去掉（只去一层）；
- **不做变量插值**（没有 `${VAR}` 展开），不支持 `export`。

---

## 3. 三种协议（`LLM_API`）

| `LLM_API` | 适配器 | `LLM_BASE_URL` 写法 | 实际请求路径 |
| --- | --- | --- | --- |
| `anthropic-messages` | Anthropic Messages API | `https://host/anthropic` | `<baseUrl>/v1/messages` |
| `openai-completions`（默认） | OpenAI Chat Completions | `https://host/v1` | `<baseUrl>/chat/completions` |
| `openai-responses` | OpenAI Responses API | `https://host/v1` | `<baseUrl>/responses` |

自动判定（`resolveApi()`）：`LLM_API` 未设置时，baseUrl 命中正则 `/anthropic|\/v1\/messages/i`
就判为 `anthropic-messages`，否则判为 `openai-completions`。

> ⚠️ `openai-responses` **永远不会被自动判定**，必须显式写 `LLM_API=openai-responses`。

`LLM_API` 填了非法值会直接抛错：`LLM_API must be one of openai-completions, openai-responses, anthropic-messages (got "...")`。

---

## 4. 参数逐项详解

### 4.1 必填

| 变量 | 类型 | 含义 | 落到 `Model` 的哪里 |
| --- | --- | --- | --- |
| `LLM_API_KEY` | string | 鉴权 key。`openai-*` 协议下由适配器作为 `Authorization: Bearer` 发送；`anthropic-messages` 下默认作为 `x-api-key`（见 §5） | `AppConfig.apiKey`，每个请求经 `createStreamFn` 注入 |
| `LLM_MODEL_ID` | string | 请求体里的 `model` 字段；同时是 `Model.id` 与 `Model.name` | `Model.id` / `Model.name` |
| `LLM_BASE_URL` | string | 端点根地址；构造时去掉结尾的 `/` | `Model.baseUrl` |

三者任一缺失会抛 `Missing required environment variable <NAME>. Copy .env.example to .steve/.env and fill it in.`

### 4.2 可选

| 变量 | 取值 | 含义 | 默认 |
| --- | --- | --- | --- |
| `LLM_API` | `anthropic-messages` \| `openai-completions` \| `openai-responses` | 用哪个协议适配器，见 §3 | 按 `LLM_BASE_URL` 自动判定 |
| `LLM_AUTH_STYLE` | `auto` \| `bearer` \| `api-key` | 仅对 `anthropic-messages` 生效，见 §5 | `auto` |
| `LLM_PROVIDER` | string | 传给 pi 的 provider id，出现在错误信息与会话元信息里 | `custom` |
| `LLM_REASONING` | bool | 是否声明该模型支持扩展思考，见 §6 | `false` |
| `LLM_CONTEXT_WINDOW` | int > 0 | `Model.contextWindow`，pi 用它估算上下文占用、决定何时压缩 | `128000` |
| `LLM_MAX_TOKENS` | int > 0 | `Model.maxTokens`，即请求的 `max_tokens`；Anthropic 协议必须带 | `8192` |
| `LLM_SYSTEM_PROMPT` | string | 覆盖默认 system prompt | `DEFAULT_SYSTEM_PROMPT`（见 `src/model/config.ts`） |

解析细节：

- **bool**（`boolEnv`）：`1` / `true` / `yes`（忽略大小写）为 true；空字符串或未设置为默认值；其余为 false。
- **int**（`intEnv`）：`Number.parseInt`；非数字或 `<= 0` 时退回默认值。

### 4.3 写死在 `buildModel()` 里、没有环境变量可调的

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `input` | `["text"]` | 当前固定文本输入，**图片能力未通过配置暴露**；要支持需改 `src/model/config.ts` |
| `cost` | 全 `0` | 不统计费用 |
| `name` | 等于 `LLM_MODEL_ID` | |
| `thinkingLevelMap` | `LLM_REASONING=false` 时全部档位为 `null`（UI 隐藏）；`true` 时用 pi 默认映射 | 见 §6 |
| `compat`（openai-completions） | `{ supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: LLM_REASONING }` | 关掉 OpenAI 专有的 `store` / `developer` 角色，兼容第三方网关 |
| `compat`（openai-responses） | `{ supportsDeveloperRole: false, supportsMaxOutputTokens: false }` | Codex 类网关常拒绝这些字段 |
| `compat`（anthropic-messages） | 不加 | 使用 pi-ai 默认（会带 `cache_control` / `eager_input_streaming` 等标准字段） |

---

## 5. 鉴权：`x-api-key` vs `Authorization: Bearer`

- `openai-completions` / `openai-responses`：适配器自己发 `Authorization: Bearer <key>`，
  **`LLM_AUTH_STYLE` 不起作用**。
- `anthropic-messages`：Anthropic SDK 默认发 `x-api-key`。但很多 Anthropic 兼容网关
  （LiteLLM、one-api / new-api、厂商代理）只认 `Authorization: Bearer`，只发 `x-api-key` 会 401。
  `src/model/stream.ts` 的 `wantsBearerHeader()` 会在需要时**额外补一个 Bearer 头**
  （`x-api-key` 仍会照发，两者并存已验证可用）。

| `LLM_AUTH_STYLE` | 行为 |
| --- | --- |
| `auto`（默认） | `anthropic-messages` 且 hostname ≠ `api.anthropic.com` → 补 Bearer；官方 API 不补 |
| `bearer` | 总是补 Bearer |
| `api-key` | 从不补（官方 Anthropic、纯 `x-api-key` 网关） |

填了其它值会抛：`LLM_AUTH_STYLE must be auto, bearer or api-key (got "...")`。

---

## 6. Reasoning / thinking（`LLM_REASONING`）

`LLM_REASONING=true` 表示**该模型支持扩展思考**，pi 会：

- 打开思考档位选择（`thinkingLevelMap` 使用默认映射，而不是全部 `null`）；
- 对 `openai-completions` 额外把 `compat.supportsReasoningEffort` 置为 `true`，
  于是选中思考档位时请求会带 `reasoning_effort`。

`false`（默认）会把所有思考档位置为 `null`，UI 里隐藏思考档位。

> 注意：不少网关/模型**自带思考**并始终返回 `reasoning_content`（例如 `grok-4.7`），
> 即使不设 `LLM_REASONING` 也能看到思考内容。这个变量只影响「是否主动请求并暴露思考档位」，
> 不是「能不能思考」的开关。

---

## 7. 常见接入配方

### 7.1 Anthropic 官方 API

```ini
LLM_API_KEY="sk-ant-..."
LLM_MODEL_ID="claude-sonnet-4-6"
LLM_BASE_URL="https://api.anthropic.com"
```

baseUrl 含 `anthropic` → 自动判定为 `anthropic-messages`；`auto` 鉴权下 hostname 是
`api.anthropic.com`，不会补 Bearer。无需额外配置。

### 7.2 Anthropic 兼容网关（只认 Bearer）

```ini
LLM_API_KEY="sk_xxx"
LLM_MODEL_ID="claude-opus-5"
LLM_BASE_URL="https://tokenhub.zhuanspirit.com/anthropic"
LLM_REASONING="true"
LLM_CONTEXT_WINDOW="1048576"
LLM_MAX_TOKENS="393216"
```

baseUrl 含 `anthropic` → 自动 `anthropic-messages`；非官方 host → `auto` 会自动补 Bearer。

### 7.3 OpenAI 兼容网关（Chat Completions）

```ini
LLM_API_KEY="sk-xxx"
LLM_MODEL_ID="grok-4.7"
LLM_BASE_URL="https://luckyg.131518.xyz/v1"
LLM_API="openai-completions"
LLM_PROVIDER="luckyg"
LLM_REASONING="true"
LLM_CONTEXT_WINDOW="256000"
LLM_MAX_TOKENS="32768"
```

baseUrl 不含 `anthropic` → 不写 `LLM_API` 也会判定为 `openai-completions`；写出来更明确。

### 7.4 只暴露 `/responses` 的网关

```ini
LLM_API="openai-responses"
LLM_API_KEY="sk-xxx"
LLM_MODEL_ID="gpt-5.6-luna"
LLM_BASE_URL="https://your-gateway.example.com/v1"
```

`openai-responses` 无法自动判定，`LLM_API` **必须**显式写。

### 7.5 本地 Ollama

```ini
LLM_API_KEY="ollama"          # 占位：必填，Ollama 不校验
LLM_MODEL_ID="qwen2.5-coder:7b"
LLM_BASE_URL="http://localhost:11434/v1"
LLM_API="openai-completions"
```

### 7.6 本地 vLLM / LM Studio / SGLang

同上，`LLM_BASE_URL` 指向 `<host>/v1` 即可，协议用 `openai-completions`。

### 7.7 离线 mock（无需 key、不联网）

```bash
npm run mock &                     # 监听 127.0.0.1:8899，三种协议都支持
LLM_API_KEY=mock LLM_MODEL_ID=mock LLM_BASE_URL=http://127.0.0.1:8899/v1 npm run dev "现在几点？"
LLM_API=openai-responses LLM_API_KEY=mock LLM_MODEL_ID=mock LLM_BASE_URL=http://127.0.0.1:8899/v1 npm run dev
```

---

## 8. 排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `Missing required environment variable LLM_API_KEY` | 没找到任何 `.env`：`mkdir -p .steve && cp .env.example .steve/.env` 并填三个必填项 |
| `LLM_API must be one of ...` | `LLM_API` 拼写错误 |
| `LLM_AUTH_STYLE must be auto, bearer or api-key` | `LLM_AUTH_STYLE` 拼写错误 |
| 401 / Unauthorized（Anthropic 网关） | 试 `LLM_AUTH_STYLE=bearer`；OpenAI 网关则确认 key 与 baseUrl 同源 |
| `model_not_found` / `No available channel for model ... under group ...` | **网关侧问题**：key 的分组/权限里没有该模型，不是 steve 配置问题 |
| 404 / `Invalid URL (POST /v1/...)` | baseUrl 层级写错：Anthropic 用 `.../anthropic`（不带 `/v1`），OpenAI 用 `.../v1` |
| 网关报不认 `developer` 角色 / `max_completion_tokens` | `openai-completions` 已默认 `supportsDeveloperRole:false`；`openai-responses` 也已关掉 `supportsMaxOutputTokens` |
| 上下文超限却不压缩 | 检查 `LLM_CONTEXT_WINDOW` 是否按网关真实值填写（估大估小都会出问题） |
| 想确认最终生效的配置 | ACP 启动日志会打印 `[acp] steve ... model=<id> api=<api> auth=<style>` |

快速打印当前生效配置：

```bash
# 开发态（tsx）
npx tsx -e 'import {loadConfig} from "./src/model/config.ts"; console.log(loadConfig().model)'

# 构建后
npm run build && node -e 'import("./dist/model/config.js").then(m => console.log(m.loadConfig().model))'
```

---

## 9. 代码位置

| 文件 | 职责 |
| --- | --- |
| `src/model/config.ts` | `.env` 链读取（`envFileCandidates` / `loadEnvFiles`）、`buildModel()`、`resolveApi()`、`resolveAuthStyle()` |
| `src/model/stream.ts` | `createStreamFn()`：按 `model.api` 路由到 pi-ai 适配器、补 Bearer 头、把失败编码成 stream 错误事件 |
| `src/kernel/agent.ts` | 把 `config`（apiKey / authStyle / model）交给 `Agent` |
| `src/entries/cli.ts` | CLI 入口，启动时 `loadConfig()` |
| `src/protocols/acp/main.ts` | ACP server 入口，启动时 `loadConfig()` 并打印 model/api/auth |
| `.env.example` | 配置模板 |
| `scripts/mock-server.mjs` | 离线 mock server（三种协议） |
| `scripts/config-test.mjs` | `.env` 查找链 10 项机检（`npm run config:test`） |
