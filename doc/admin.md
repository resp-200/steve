# 管理后台（`/admin`）

`steve-serve` 自带一个单页管理后台：不依赖额外进程、不引入前端构建，页面由服务端作为
一个内嵌 HTML 直接返回。它面向的是**这台机器上的运维者**，用来配置模型供应商、网关、
定时任务、日志和服务重启。

> 设计原则：后台只改**配置文件**（`~/.steve/admin.json`、`~/.steve/.env`、
> `~/.steve/watch.json`），不绕过任何功能层——供应商切换、网关、定时任务写完都提示
> 「需要重启」，重启由 supervisor 完成；日志级别是唯一可热更新的设置。

## 启动与访问

```bash
# 和平时一样启动，后台默认启用
npm run serve:dev -- --port 8892 --token <你的-token>

# 生产
steve-serve --port 8892 --token <你的-token>
```

打开 <http://127.0.0.1:8892/admin>。第一次会要求输入 token（即 `--token`；也可以用
`STEVE_SERVE_TOKEN` 环境变量）。token 存在浏览器 `localStorage`，不会写入页面。

- 页面本身**不需要** token（浏览器直接导航无法带 `Authorization` 头），但所有
  `/admin/api/*` 接口都要求 `Authorization: Bearer <token>`；没有配置 token
  （仅回环地址允许）时接口直接开放。
- 不想启用后台时加 `--no-admin`。

## 六个板块

### 1. 概览

版本号、Node 版本、运行时长、PID、工作目录、streams 目录、当前激活的供应商、供应商
数量、飞书网关状态、Watch 开关、日志级别与文件、流总数（5 秒轮询）。

### 2. 模型供应商

每个供应商包含：名称、Base URL、API Key、默认模型、可用模型列表、是否开启思考
（reasoning）、是否支持图片（vision）。可以新增 / 编辑 / 删除，并**一键激活**一个供应商。

「支持图片」是一个**声明**，不是探测，而且**默认勾上**：图片本来就应该能发出去，要关的是少数
纯文本模型。取消勾选后，收到图片会回一条「这张图没有发给模型」并说明怎么打开，而不是把图发过去
等网关报 400。用 `.env` 里的 `LLM_*` 直连时，对应开关是 `LLM_IMAGES`（默认开，`LLM_IMAGES=0` 才关）。
图片格式限 PNG / JPEG / GIF / WebP，单张上限 10 MB。

勾着但对方其实不认图时，网关返回的 400 会被翻译成「这张图没能发给模型 + 你该怎么办」，网关原话
附在最后 —— 直接甩 `image_url is not supported` 谁也看不出该去点哪个开关。

「可用模型」是一张可编辑列表，每行是模型 ID 与它的规格（上下文长度 / 最大输出，
供应商返回时展示，否则显示「规格未知」）。

- **选择模型**：调用供应商的 `GET {baseUrl}/v1/models`（Base URL 已以 `/v1` 结尾时
  直接拼 `/models`；Anthropic 兼容端点改用 `x-api-key` 与 `anthropic-version`），
  弹窗里按 ID / 厂商搜索、多选，确认后只把勾选的模型填回列表，并带出规格。
  这个请求会带上该供应商配置的自定义请求头（表单里尚未保存的也算），否则需要
  会话头才能路由的网关会把这个列表请求一直 400。
- **手动添加**：供应商不提供 `/v1/models` 时直接填模型 ID，规格列留空即可。
- 编辑供应商时 API Key 留空会复用已保存的 Key；上游不可达或鉴权失败时弹窗给出
  可读错误，不影响手动填写。

- 数据保存在 `~/.steve/admin.json` 的 `providers` 与 `activeProviderId`。
- 激活的供应商优先于 `~/.steve/.env` 里的 `LLM_*`，**所有入口**都这样解析（`steve`、
  `steve-acp`、`steve-serve`）：后台里配好一次，CLI 与编辑器插件也跟着用同一个模型。
- 第一次部署时可以完全没有 `.env`：直接在后台填一个已激活的供应商就能启动。此时日志会
  有一条 `environment config unavailable (...); using provider "..."` 的 warn，属正常；
  仍有 `.env` 时两者会合并（保留 `.env` 的上下文窗口/最大输出，换上供应商的 key 与模型）。
- 编辑时 API Key 留空表示**保持原值**；列表和接口只返回 `****xxxx` 掩码。
- 切换后需要重启服务生效（页面会提示并给出重启按钮）。

#### 自定义请求头

有些网关要求在请求里带自己的头（路由、归因、配额分桶、会话亲和）。供应商表单里的
「自定义请求头」就是这件事的标准入口：

- **写法**：每行一个 `名称: 值`，存成 `~/.steve/admin.json` 里的 `headers` 对象。
- **模板**：值支持占位符 `${sessionId}`（别名 `${session}`、`${conversationId}`、
  `${threadId}`、`${chatId}`），发送时替换成当前会话 id。其他 `${...}` 一律在保存时报错，
  避免把手误写成的字面量发给网关。
- **会话头 `x-opencode-session`（OpenCode Go 要求）**：只有**显式配置过**这个头的供应商才会发送，
  所以没配的网关（以及只用 `.env` 的部署）一个字节都不会变。取值规则是「自动优先，手填兜底」：

  | 配置的值 | 发送的值 |
  | --- | --- |
  | 空 / `${sessionId}` | 当前会话 id；没有会话（一次性 CLI 运行）时用下面的手填值；再没有就用供应商 id |
  | 固定字符串 | 原样发送 |

  想要手填兜底又想让真实会话优先，写 `${sessionId}` 并把兜底值交给会话 id 的来源即可；
  需要完全固定就填固定字符串。
- **生效域名**：留空 = 只在请求发往 Base URL 自己的域名时发送；填了就以填的为准（逗号分隔）。
  这条规则保证改过 Base URL、或指向代理的供应商不会把别家的请求头带出去。
- **不覆盖已有头**：`Authorization`、`Accept` 等已被鉴权层或调用方设置的头不会被覆盖。
- 「一键获取可用模型」也会带上配置的请求头——需要会话头的网关否则永远返回 400。
- 保存接口的响应里有 `sentHeaders`，是用 `sample-session` 展开后的预览，用来确认占位符有没有写对。
- 请求头值是连接信息（和 Base URL 同级，不做掩码）；只有 API Key 仍然是密钥。

### 3. 网关

目前只有**飞书机器人**，其它（企业微信 / QQ）是灰掉的「规划中」占位，架子已经按
`available / planned` 返回，后续新增网关不需要改页面结构。

- 展示飞书是否已配置、App ID 掩码、secret / verification token / encrypt key 是否已
  设置、API Base，以及**事件接收方式**（长连接 / HTTP 回调）与长连接实时状态
  （已连接 / 重试中 / 凭据错误导致的「已停止（配置错误）」）。
- 事件接收方式可选「长连接」（默认，不需要公网地址与 Verification Token）或
  「HTTP 回调」（需要公网地址与 Verification Token），保存时写 `FEISHU_MODE`。
- 表单保存写入 `~/.steve/.env` 的 `FEISHU_*`，留空表示保持不变；「清空网关配置」会删掉
  全部 `FEISHU_*` 行（含 `FEISHU_MODE`）。
- 建应用与事件订阅步骤见 [serve.md](./serve.md#飞书机器人)。保存后需重启。

### 4. 联网搜索

决定 `web_search` 用谁的数据。默认**不开箱即用也开箱即用**：一个 key 都不配时走
DuckDuckGo，配了任一 key 就自动换成那一家。

- 列出五个源（Tavily / Exa / Brave / DuckDuckGo / Wikipedia），标出哪些已配 key、
  当前实际用的是哪个。**key 本身不回传**，只显示「已配置 / 未配置」。
- 三个输入框写 `TAVILY_API_KEY` / `EXA_API_KEY` / `BRAVE_API_KEY` 到 `~/.steve/.env`，
  留空表示保持不变；有 key 的行可以单独「清除」。
- 「优先使用」写 `WEB_SEARCH_PROVIDER`。**点名是绑定的**：选了 Brave 却没配 key，
  搜索直接被关掉而不是偷换成别家——页面会明说「不会注册」，而不是假装在用 Brave。
- 每行有「测试」按钮，发一次真实查询并回报条数、耗时与前三条标题；还没保存的 key 也
  可以先测（只用于这一次请求，不落盘）。失败时原样显示对方的错误，比如
  `Tavily returned HTTP 401`。
- **不需要重启**：插件在会话启动时解析 provider，所以下一个会话就生效，正在进行的
  会话继续用旧的。

### 5. 定时任务

业内常见做法就是把「定时任务」实现为一条 **cron 触发器**：到点向某个流投递一条提示
词，由运行执行器在后台跑一轮，结果写进该流的事件日志（可被网关或前端消费）。本后台
即按此设计：

- 任务字段：名称、cron（5 段：分 时 日 月 周）、时区（可选，如 `Asia/Shanghai`）、
  目标流、模式（`background` 默认 / `foreground`）、提示词。
- 保存写入 `~/.steve/watch.json` 的 `triggers`，由 `watch-config` 插件在启动时注册，
  所以**保存后需要重启生效**。
- 「立即运行」不依赖 cron 调度：直接向目标流提交一次后台 run，返回 `runId`，方便验证
  提示词效果。
- 删除只移除该 cron 触发器，不影响同文件里的其它 `predicate` / `fs` / `webhook` 条目。
- 生产建议：目标流固定、模式用 `background`；需要审批的工具在后台 run 中会挂起为
  `approval.pending`（10 分钟超时），可在流里通过 `POST /streams/:id/approvals` 放行。

### 6. 系统

- 版本 / Node / PID / 工作目录 / streams 目录。
- **日志**：级别 `debug|info|warn|error` 与**日志目录**（只接受文件夹路径，留空用默认的
  `~/.steve/logs`）。日志始终同时写 stderr，并按**小时**在目录下切分文件：
  `<dir>/<YYYY-MM-DD>/steve-<YYYY-MM-DD>T<HH>.log`（本地时间，目录按天分层）。级别
  **立即生效**，目录也立即切换（下一次写日志时创建目录与文件）。设置持久化到
  `~/.steve/admin.json` 的 `logLevel` / `logDir`，`--log-level` / `--log-dir` 可临时覆盖。
  路径不可写时只告警一次并退回 stderr，绝不影响进程。
- **角色设定**（`persona`）：用户自己的额外要求，叠加在内置提示词的身份层之后
  （`# 用户的额外要求`）。留空表示不加；清空会从 `admin.json` 删除该字段。保存后**从下一个
  turn 起生效**，不用重启、也不用开新会话：每个 turn 开始时会重新读一遍配置并替换提示词，
  历史消息保留。层级与场景说明见 README「系统提示词：四层组装」。
- **原始配置文件**：查看 `~/.steve/.env`、`~/.steve/admin.json`、`~/.steve/watch.json`、
  `~/.steve/mcp.json`（接口返回绝对路径，`?path=` 也接受裸文件名）。默认掩码 `API_KEY` / `SECRET` / `TOKEN` / `ENCRYPT_KEY` 一类值，
  勾选「显示敏感值」才返回原文。
- **重启服务**：`POST /admin/api/system/restart` 返回 `202` 后以退出码 **75** 退出，
  由 systemd / pm2 / docker 等 supervisor 拉起。直接 `npm run serve:dev` 前台跑时，
  进程会退出，需要自己重新启动。

## API

所有接口返回 JSON；错误为 `{ "error": "..." }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin` | 页面（无需 token） |
| GET | `/admin/api/overview` | 概览 |
| GET | `/admin/api/providers` | 供应商列表（掩码） |
| POST | `/admin/api/providers/models` | 拉取供应商的 `/v1/models`（返回 `models` 与带规格的 `items`） |
| POST | `/admin/api/providers/save` | 新增 / 编辑 `{provider:{id?,name,baseUrl,apiKey?,defaultModel,models,reasoning,images?,headers?,hosts?,requestSessionHeader?}}`，响应带 `sentHeaders` 预览 |
| POST | `/admin/api/providers/delete` | 删除 `{id}` |
| POST | `/admin/api/providers/activate` | 激活 `{id}` |
| GET | `/admin/api/gateways` | 网关状态 |
| POST | `/admin/api/gateways/save` | 保存 `{feishu:{appId?,appSecret?,verificationToken?,encryptKey?,apiBase?}}` 或 `{clear:true}` |
| GET | `/admin/api/search` | 联网搜索：`{providers:[{id,label,keyless,envKey?,hasKey,signup?,blurb}],keyless,active,requested,pinned}` |
| POST | `/admin/api/search/save` | 保存 `{tavily?,exa?,brave?,provider?}`（留空保持不变）或 `{clear:"<provider>"}` |
| POST | `/admin/api/search/test` | 用某 provider 发一次真实查询 `{provider,query?,key?}` → `{ok,count,elapsedMs,sample}` |
| GET | `/admin/api/schedules` | 定时任务列表 |
| POST | `/admin/api/schedules/save` | 保存 `{name,cron,timezone?,prompt,targetStream,mode?}` |
| POST | `/admin/api/schedules/delete` | 删除 `{name}` |
| POST | `/admin/api/schedules/run` | 立即运行 `{name}` → `{runId}` |
| GET | `/admin/api/system` | 系统信息与配置文件列表 |
| POST | `/admin/api/system/save` | `{logLevel?,logDir?,persona?}`；`persona` 传空串即清除 |
| GET | `/admin/api/files?path=...&reveal=0\|1` | 读取白名单配置文件 |
| POST | `/admin/api/system/restart` | 重启（退出码 75） |

```bash
TOKEN=...
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8892/admin/api/overview
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"logLevel":"debug"}' http://127.0.0.1:8892/admin/api/system/save
```

## 安全与边界

- 只在回环地址无 token 时开放；`--host` 非回环必须给 token（原有规则不变）。
- 页面/接口都不会把明文 secret 发到浏览器（除显式 `reveal=1`）；API Key 写入后无法从
  列表读回，只能重填或看文件。
- 后台只做配置管理，不提供「删除流 / 直接执行任意命令」之类的高危操作；流内容仍通过
  `/streams` 系列接口访问。
- 重启会中断进行中的 run；有长任务时建议手动挑时间。
- 定时任务是**单进程内存调度**（与 watch 引擎一致），进程退出期间错过的触发不会补跑
  （触发引擎会记 `watch.dedupe{reason:"missed"}`）；需要严格准点请交给外部调度器调
  `POST /streams/:id/messages`。
