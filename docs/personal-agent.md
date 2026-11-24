# 技术方案：把 steve 改造成 Personal Agent

> 状态：**设计稿（分批实施中）**。S0 拆文件、S0′ 架构断言、S1 事件日志 + 兼容层、S2 事件投影、S3 环境快照已落地；其余阶段仍只写「要做什么、怎么做、怎么验收」。
> 目标读者：改代码的人（需要知道改哪里）与评审的人（需要知道为什么这么改）。
> steve 现有架构见 [README](../README.md)；本文所有「现状」都指 `0.1.2` 的实现，并且能在源码里逐条对上。

---

## 1. 目标与约束

### 1.1 六项能力

| # | 能力 | 一句话验收标准 |
| --- | --- | --- |
| ① | 抛弃会话为单位的交互模式 | 进程生命周期与「会话」解耦：可以只有一个常驻进程，任意数量的对话线程在同一进程里并存、互不影响；「会话」退化为事件日志上的一个标签 |
| ② | 事件驱动 | 系统空闲时没有「轮询」也没有「等 prompt」，但任何一个新的输入事件（用户消息、触发器、审批结果）都会自动拉起执行 |
| ③ | 异步 ReAct | 提交一个任务立即返回 `runId`，ReAct 循环在后台跑；调用方通过订阅生命周期事件了解结果，而不是 await |
| ④ | 计算 / 状态 / 环境分离 | 状态可从事件日志**纯函数折叠**得出；计算（ReAct worker）无内部状态；环境是一份**可序列化、随每次运行落盘**的快照 |
| ⑤ | 隐藏内部工具结果和思考过程 | 同一份事件按**受众**投影：给人看的视图不含 thinking 原文、不含工具返回原文/结构化 details；给模型看的上下文不变 |
| ⑥ | 主动 Watch | 内置四类触发器（事件谓词 / 文件变化 / 定时 / Webhook），触发即向总线投递事件；有防风暴约束 |

### 1.2 不可违反的既有约束（`arch:test` 会机检）

1. 五层依赖只向下；横向边只有 `features/runtime.ts → extensions/*`（`import type`）与 `extensions/* → features/{contract,events,tool-annotations}.ts`。
2. `protocols/` 与 `entries/` 零 `@earendil-works/*`；`@agentclientprotocol/sdk` 只在 `protocols/`。
3. `new Agent({...})` 只在 `kernel/agent.ts`。
4. `src/types.ts` 零依赖。
5. 协议层不认识具体工具名（工具卡片完全靠工具自己声明的 `metadata` / `describe`）。
6. 能力实现只能被它的插件引用；入口不实现插件命令。
7. 运行时依赖白名单：`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@agentclientprotocol/sdk`；`ws` 只能 optional；`devDependencies` 只放 `tsx` / `typescript` / `@types/node`。
8. 代码风格：tab 缩进、双引号、分号、`import type` 优先、ESM 相对导入带 `.js`；注释英文、README/文档中文；单文件超过约 300 行考虑拆。
9. 一个能力 = 一个 `scripts/<能力>-test.mjs` + npm script，并加进 `scripts/verify.mjs`。

### 1.3 本文档的硬性设计原则

- **内核不动**：`kernel/agent.ts`、`model/*`、`features/contract.ts` 保持原样。pi 的 `Agent` 仍然只在一个地方装配，ReAct 循环、模型、工具执行都不变。
- **对外行为可保持**：ACP 客户端在默认配置下看到的 `session/update` 序列与今天**逐条相同**（靠投影的 `full` 档位 + 兼容的 `SessionStore` 读路径）。
- **先地基后能力**：事件日志与投影是一切的前提；worker 与触发器建立在其上。
- **每一步可独立回滚**：每个阶段都是一个自洽的提交，前一步不依赖后一步。

### 1.4 能力 → 模块映射（读文档时的导航）

| 能力 | 主改模块 | 次要改动 |
| --- | --- | --- |
| ① 抛弃会话为单位 | §5.1 `stream-log.ts` | §5.7.1 ACP、§5.7.3 `entries/serve.ts`、§5.6 折叠 |
| ② 事件驱动 | §5.1 `stream-log.ts` + §5.2 `worker.ts` 的订阅 | §5.7.3 `entries/serve.ts` |
| ③ 异步 ReAct | §5.2 `worker.ts` | §5.7.1 ACP `session/prompt`、§9 权限 |
| ④ 计算/状态/环境分离 | §5.2 计算 + §5.6 状态 + §5.4 环境 | — |
| ⑤ 隐藏内部细节 | §5.3 `projection.ts` | §5.7.1 ACP、§5.7.2 CLI |
| ⑥ 主动 Watch | §5.5 `trigger.ts` | §9 权限（后台 run）、§5.7.3 HTTP hook |

---

## 2. 现状诊断：一条规则，六个死结

steve 现在只有一条运转规则：

> 调一次 `prompt()` → 跑完一轮 ReAct（期间 `emit()` 推事件）→ 返回 `TurnResult` → 整份 `messages` 覆盖写盘 → 等下一次输入。

这条规则分别长在下面这些位置（`src/features/runtime.ts` 517 行、`src/protocols/acp/session.ts` 433 行）：

| 现状事实 | 位置 | 被哪项能力要求打破 |
| --- | --- | --- |
| 事件只在 `prompt()` 执行期间产生；空闲时 `emit()` 不会发生 | `runtime.prompt()` 内部 | ② |
| `prompt()` 返回 `Promise<TurnResult>`，调用方必须 await | `AgentRuntime.prompt` 签名 | ③ |
| 并发靠 `running` 标志 + "superseding the in-flight turn"（abort 上一轮） | `AcpSession.prompt` | ③、① |
| 状态就是 `agent.state.messages`；唯一出口是 `snapshot()/restore()`（整体替换） | `runtime.snapshot/restore` | ④ |
| 环境（cwd、workspace roots、access、工具集、permission 模式）在构造时闭包进 `AgentRuntime`/`AcpSession` | 各入口的装配处 | ④ |
| `thinking_delta → agent_thought_chunk`、`tool_end.text → tool_call_update` 是恒等映射 | `AcpSession.publishEvent` | ⑤ |
| 除了 prompt 之外没有任何输入源 | 全局 | ⑥ |
| 会话 = `AcpSession` 实例 = 一个 `AgentRuntime` = 一个 `<id>.json` | `protocols/acp/agent.ts` 的 `sessions: Map` | ① |

**「不做会怎样」的诚实结论**（评审时必须知道的部分）：

- ①②③④ 都可以不做——现有产品形态（终端对话 + ACP 客户端）本身能用。
- ⑤ 存在实际风险：远程 ACP 客户端会收到工具返回原文（最大 200 KiB）与 thinking 原文。
- ⑥ 是**唯一无法用现有代码凑出来的功能**——没有 prompt 就没有动作，这是架构级缺口，不是缺个开关。

---

## 3. 目标架构

### 3.1 改造前 vs 改造后

**改造前**

```
用户键入 ──▶ entries/cli.ts ──▶ runtime.prompt() ──▶ pi 循环
                                      │ 期间 emit(事件)
                                      ├────────────▶ Renderer / AcpSession.publishEvent（恒等映射）
                                      ▼
                               await 到 TurnResult
                                      ▼
                     store.save(整份 messages)  ──▶ <id>.json
                                      ▼
                                   等待下一次输入（进程"死"着）
```

**改造后**

```
用户输入 / 触发器 / 审批结果 / 系统事件
        │  （任何东西都能 append，不再只有"用户键入"）
        ▼
┌──────────────────────────────────────────────────────────────┐
│ append-only 事件日志（StreamLog JSONL）                       │
│  { seq, streamId, ts, type, payload, causeId? }               │  ← 唯一真相
└──────────────────────────────────────────────────────────────┘
        │ 订阅（类型过滤 + fromSeq 续订 + 游标回执）
        ▼
┌───────────────┐  冻结一次派发     ┌──────────────────────────┐
│ RunWorker     │ ───────────────▶ │ EnvironmentSnapshot      │
│ submit()→runId│                  │ {cwd,roots,access,tools, │
│ (无内部状态)  │                  │  permissionMode,model,   │
└──────┬────────┘                  │  projection}（可序列化） │
       │ createKernelAgent（不变）  └──────────────────────────┘
       ▼
   pi 循环 ──▶ ReActOutput 事件 ──▶（不直接给 front end）
       │
       ▼
┌────────────────────────────────────────────┐
│ project(events, audience)  ── 纯函数       │
│   internal : 原文（内部存档 / 审计）        │
│   user     : 摘要视图（默认，给终端/客户端）│
│   full     : 原文（兼容模式）               │
└──────────────────┬─────────────────────────┘
                   ▼
         entries/render.ts（终端）或 AcpSession（客户端）
                   ▲
                   │ 订阅
┌────────────────────────────────────────────┐
│ 触发器 Watch（事件谓词 / fs / cron / hook） │ ──▶ 投递 trigger.fired
│ 审批（pending → 收到审批事件继续执行）      │
└────────────────────────────────────────────┘
```

**没有画出来的部分是内核**：`kernel/agent.ts`、`model/*`、pi 的循环、工具执行全部不动。

### 3.2 模块落位

新增/改动全部落在 L3 功能层与 L3′ 拓展层，不碰 L4/L5：

| 新文件 | 层 | 职责 | 对应能力 |
| --- | --- | --- | --- |
| `src/features/stream-log.ts` | L3 | append-only 事件日志：追加、按 `fromSeq` 读、游标回执、原子追加写 | ① ② |
| `src/features/state-fold.ts` | L3 | 纯函数 `fold(stream) → AgentMessage[]`、`foldStatus(stream) → StreamStatus` | ④ |
| `src/features/projection.ts` | L3 | 纯函数 `project(event, audience, policy)` | ⑤ |
| `src/features/environment.ts` | L3 | `EnvironmentSnapshot` 的形状与装配（`snapshotEnvironment()`），可序列化 | ④ |
| `src/features/worker.ts` | L3 | `createRunWorker()`：`submit(input) → {runId}`、生命周期事件、取消、重试与回滚 | ③ |
| `src/features/trigger.ts` | L3 | 触发器调度：`createTriggerEngine()`，四类 spec，防风暴 | ⑥ |
| `src/extensions/builtin/watch-config.ts` | L3′ | 内置插件：读 `.steve/watch.json`，注册定时 / 文件 / 事件谓词触发器 | ⑥ |
| `src/protocols/http/events.ts` | L2 | SSE / WebSocket 订阅端点，投影后推送 | ① ⑤ |
| `src/entries/serve.ts` | L1 | 常驻入口：总线 + worker + 触发器 + HTTP 订阅 + ACP 同时挂上 | ① ② ⑥ |
| `src/extensions/api.ts`（改） | L3′ | 新增 `registerTrigger()`，`ExtensionAPI` 增加子集能力 | ⑥ |
| `src/features/runtime.ts`（改） | L3 | 拆出 `SessionRuntime`，保留 `AgentRuntime` 作为单流兼容形态 | ④ |
| `src/features/session-store.ts`（改） | L3 | 变成「JSONL → 折叠 → `StoredSession`」的兼容层 | ① |
| `src/protocols/acp/session.ts`（改） | L2 | 从总线订阅 + 投影，默认 `full` 保持兼容 | ① ⑤ |
| `src/entries/cli.ts`（改） | L1 | 从总线订阅 + 投影，`--audience` 开关 | ⑤ |

**新增的横向依赖边**（需要同步更新 `arch:test` 的白名单，并在 README「分层契约」里登记理由）：

| 边 | 为什么必须有 | 守卫 |
| --- | --- | --- |
| `features/runtime.ts → extensions/host.ts` | worker 需要 `attachSession()`、`runToolCall()` 等钩子；与现有 `runtime.ts` 同样的理由 | 已经是白名单成员，只是从"一个文件"扩成"两个文件" |
| `extensions/* → features/{trigger,environment}.ts` | 插件要注册触发器、要读环境快照 | 与现有 `contract/events/tool-annotations` 同性质：这两个文件必须是**纯类型 + 纯函数契约**，不得 import 任何运行时实现 |

**明确拒绝的事**：

- 不引入 `node-cron`、`chokidar`、`express`、`rxjs`、`kysely` 等任何新运行时依赖（违反 §1.2-7）。cron 用 `setTimeout` 自实现，文件监听用 `node:fs.watch`，HTTP 用 `node:http`，事件类型用 `discriminated union`。
- 不引入数据库。日志是 JSONL 文件 + 内存索引。
- 不改 `kernel/`、`model/`。

---

## 4. 核心数据模型

以下类型全部只落在源码里，**类型定义位置**决定它属于哪层（见各节）。

### 4.1 事件信封（`features/stream-log.ts`）

```ts
/** 所有事件的公共信封。seq 由流内单调递增分配，跨流不保证有序。 */
export interface StreamEventBase {
	seq: number;
	/** 对话线 id：一次连续对话的标识（相当于今天的 session id）。 */
	streamId: string;
	/** 毫秒时间戳。 */
	ts: number;
	/** 因果边：本次事件由哪条事件引发（run 的 turn 事件指向 run.started）。 */
	causeId?: number;
}
```

**seq 分配约定**：seq 在**一条 stream 内**单调递增、从 1 开始、不跳号；由 `StreamLog.append()` 在内存计数器上同步分配。轮转（8 MiB）不重置 seq——跨 `0001.jsonl` / `0002.jsonl` 连续。读取侧按 seq 定位文件（每文件首行记 `firstSeq`，读时二分），保证 `fromSeq` 续订不依赖文件名。

### 4.2 事件词表（扩展 `features/events.ts`，按类别分组）

现有 8 种 turn 内事件**保持不变**（这是 steve 的资产）。新增四类：

```ts
// ── 输入类：谁让系统动起来的 ────────────────────────────────
| { type: "user.message"; text: string; images?: PromptImage[] }
| { type: "trigger.fired"; trigger: string; source: "predicate" | "fs" | "cron" | "webhook"; detail: unknown }
| { type: "approval.pending"; requestId: string; runId: string; toolName: string; args: unknown; preview?: ToolChangePreview }
| { type: "approval.granted"; requestId: string; toolName: string; decision: PermissionDecision }

// ── 运行生命周期类：一次 ReAct 执行 ──────────────────────────
| { type: "run.started"; runId: string; inputCause: number; environment: EnvironmentSnapshot; mode: RunMode }
| { type: "run.cancel_requested"; runId: string; by: "user" | "policy" }
| { type: "run.settled"; runId: string; outcome: RunOutcome }
| { type: "run.failed"; runId: string; error: string }
| { type: "run.cancelled"; runId: string; reason: string }
// 内部事件：一个 turn 的最终 assistant 消息（fold 用，见 §4.3；不投影给 user 受众）
| { type: "run.turn.settled"; runId: string; message: unknown /* AssistantMessage */ }

// ── 系统类 ──────────────────────────────────────────────────
| { type: "stream.created"; streamId: string; cwd: string; title?: string }
| { type: "config.changed"; key: string; previous: unknown; value: unknown }
| { type: "watch.armed"; trigger: string; spec: WatchSpec }
| { type: "watch.dedupe"; trigger: string; reason: string }  // 被防风暴拦下
```

`RunMode` / `RunOutcome`：

```ts
export type RunMode = "foreground" | "background";
export type RunOutcome = { stopReason: TurnStopReason; usage: TurnUsage; contextTokens: number; retries: number };
```

**关键约束：所有这些事件必须可 JSON 序列化。** `tool_start.args`、`tool_end.details` 已经是模型产生的 JSON，天然满足；`EnvironmentSnapshot` 只有字符串、数组与布尔；`PromptImage` 是 base64 字符串（需要按 §5.3 的体积策略处理）。

### 4.3 状态与状态的唯一出口（`features/state-fold.ts`）

```ts
/** 事件 → 模型上下文。纯函数，无 IO，可单测。 */
export function foldTranscript(events: readonly StreamEvent[]): AgentMessage[];

/** 事件的只读投影状态（给 UI / 状态接口用）。 */
export interface StreamStatus {
	streamId: string;
	createdAt: number;
	updatedAt: number;
	lastSeq: number;
	activeRun: { runId: string; startedAt: number; mode: RunMode } | null;
	usage: TurnUsage;              // 累计
	turnCount: number;
	toolCallCount: number;
	queued: number;                // 排队中的输入事件数
}
export function foldStatus(events: readonly StreamEvent[]): StreamStatus | undefined;

/** fork：把一条流在某个 seq 之前截断，开一条新流。 */
export function forkEvents(events: readonly StreamEvent[], atSeq: number, newStreamId: string): StreamEvent[];
```

折叠规则（这是 ④ 的核心，必须写死并有测试）：

| 事件 | 折叠结果 |
| --- | --- |
| `user.message` | 追加 `UserMessage`（text + images 转 `{type:"image"}` 块） |
| `turn_start` | 无（`turn_start` 是循环边界，不产生消息） |
| `text_delta` / `thinking_delta` / `tool_update` | 不产生消息；只影响**流式渲染**（从当前 partial 累加） |
| `tool_start` | 不产生消息（tool call 由 assistant 消息承载） |
| `turn_end` | 不产生消息；完整 assistant 内容由紧随其后的 `run.turn.settled` 事件携带（见下） |
| `run.turn.settled` | 追加该 turn 的完整 `AssistantMessage`（含 usage / stopReason / 最终 content） |
| `tool_end` | 追加 `ToolResultMessage`（`toolCallId` / `toolName` / `content` / `isError`） |
| `run.failed`（provider 失败且未跑工具） | **不追加**（等价于今天的 `messages.slice(0, before)` 回滚） |
| `run.failed`（跑过工具后失败） | 保留已产生的事件（不重试语义） |
| `compaction.*`（见 §11 未决项） | 保留期相 |

> **重要实现细节**：`text_delta` 是流式的、`turn_end` 只有元数据（`stopReason/usage`）。为了让 `foldTranscript()` 能重建**完整的 assistant 消息**，worker 在 `turn_end` 之后额外追加一条 `run.turn.settled`（内部事件）携带该 turn 的最终 `AssistantMessage`。这样实时视图用 delta，恢复视图用 settled，两者一致。
> 该事件只在内部日志里，不投影给 `user` 受众（避免把工具参数原文再泄一遍）。
> `run.turn.settled` 的体积受 §5.3 的单事件上限约束：超限时把该 turn 的 content 中超过上限的部分替换为占位符并记 `truncated: true`（实际含义：这个 turn 太大，恢复时上下文会缺失一部分——必须写进日志并在启动时 warn，不能静默）。

### 4.4 环境快照（`features/environment.ts`）

```ts
export interface EnvironmentSnapshot {
	cwd: string;
	roots: string[];
	access: WorkspaceAccess;
	shell?: ShellCommand;
	/** 工具名 + 是否需要审批（不含 execute，因此可序列化）。 */
	tools: { name: string; permissionRequired: boolean; kind?: string }[];
	permissionMode: "ask" | "allow";
	model: ModelInfo;
	/** 插件快照：加载了哪些插件文件。 */
	plugins: string[];
	/** 投影档位（见 §6）。 */
	projection: ProjectionPolicy;
	mode: RunMode;
}
export function snapshotEnvironment(options: {...}): EnvironmentSnapshot;
```

写入 `run.started.environment`，于是任何一次运行的「当时允许什么」都能从日志回答。

### 4.5 投影策略（`features/projection.ts`）

```ts
export type Audience = "internal" | "user" | "audit" | "full";
export interface ProjectionPolicy {
	audience: Audience;
	/** user 视图下 thinking 如何处理。 */
	thinking: "drop" | "placeholder";       // "drop" 完全不发；"placeholder" 发 {thinking:true}
	/** tool_end 的文本如何呈现。 */
	toolOutput: "summary" | "truncated";
	toolOutputChars: number;                 // 默认 240（与 render.ts 的 oneLine 上限一致）
	/** 是否发送 details（结构化输出）。 */
	details: boolean;
}
export const DEFAULT_POLICIES: Record<Audience, ProjectionPolicy>;
export function project(event: StreamEvent, policy: ProjectionPolicy): ProjectedEvent[];
```

`user` 受众的默认投影：

| 原事件 | 投影结果 |
| --- | --- |
| `thinking_delta` | 不发（`thinking: "drop"`），或一条 `{type:"thinking_presence"}` 占位 |
| `tool_start` | 只留 `{id, name, title, kind}`，**去掉 `args` 原文** |
| `tool_update` | 同上，去掉 text |
| `tool_end` | 只留 `{id, name, isError, summary}`，`summary` 取工具自己声明的 `describe()` 或 `oneLine(text, chars)`；`details` 不发 |
| `text_delta` | 原样 |
| `turn_end` / `run.*` | 原样（不含 error 原文，只含分类后的原因） |
| `run.turn.settled` | 不发（内部事件） |

`full` 受众 = 恒等投影，用于兼容 ACP 客户端与 `--audience full`。

### 4.6 触发器规格（`features/trigger.ts`）

```ts
export type TriggerSpec =
	| { kind: "predicate"; on: StreamEventType[]; when?: PredicateExpr; emit: TemplateEvent }
	| { kind: "fs"; paths: string[]; events: ("rename" | "change")[]; debounceMs: number; emit: TemplateEvent }
	| { kind: "cron"; cron: string; timezone?: string; emit: TemplateEvent }
	| { kind: "webhook"; path: string; method?: "POST"; secret?: string; emit: TemplateEvent };

export interface TriggerRegistration {
	name: string;
	spec: TriggerSpec;
	/** 防风暴：同 key 在 windowMs 内只触发一次。 */
	dedupe?: { key: string; windowMs: number };
	/** 触发后投递目标流的解析方式。 */
	targetStream: string | ((detail: unknown) => string | undefined);
	/** background 触发的 run 不能用需要审批的工具（见 §9）。 */
	mode: RunMode;
}
```

---

## 5. 逐模块设计

### 5.1 `features/stream-log.ts` — append-only 事件日志（能力 ①②）

**现状**：`features/session-store.ts` 把整份 `messages` 覆盖写到 `<dir>/<id>.json`（临时文件 + rename）。

**改法**：

```ts
export interface StreamLogOptions {
	dir: string;                        // 默认 <cwd>/.steve/streams
	logger?: Logger;
	/** 单文件轮转阈值，默认 8 MiB；超了就切到 <streamId>.<n>.jsonl。 */
	rotateBytes?: number;
}

export interface StreamLog {
	readonly dir: string;
	/** 追加一批事件到一个流，返回分配到的 seq 范围。同步落盘（fs.writeSync）保证崩溃后不丢。 */
	append(streamId: string, events: NewStreamEvent[]): Promise<{ first: number; last: number }>;
	/** 从 fromSeq（含）开始读。游标语义：客户端上次收到 last，下次传 fromSeq=last+1。 */
	read(streamId: string, fromSeq?: number, limit?: number): Promise<StreamEvent[]>;
	/** 订阅：先补发 fromSeq 之后的历史，再推新增。返回 unsubscribe。 */
	subscribe(streamId: string, fromSeq: number, listener: (event: StreamEvent) => void): () => void;
	listStreams(): Promise<StreamSummary[]>;
	remove(streamId: string): Promise<void>;
	close(): Promise<void>;
}
```

**文件布局**：

```
.steve/streams/
  <streamId>/
    meta.json        { streamId, cwd, title, createdAt }
    0001.jsonl       # 每行一个 {seq, ts, type, payload, causeId}
    0002.jsonl       # 轮转
    cursor.json      { lastSeq }   # 仅在无轮转时用于快速恢复
```

**关键决策与理由**：

1. **为什么不用「一整份 JSON 覆盖写」**：覆盖写只能恢复到「最后一次写盘」这个点，且每次写都要序列化全部消息（O(n²)）。追加写是 O(1)，且天然支持「从任意 seq 恢复 / 分叉 / 多订阅者续订」。
2. **为什么是 JSONL 而不是 `pi-agent-core` 自带的 `JsonlSessionRepo`**：pi 的 harness 期望 `FileSystem` 抽象与 `Context`（chord）传递，引入它会把 pi 的内部状态机（operation leaves、effect gate）带进 L3，与「内核只在一处装配」冲突。我们只借它的**思想**（append-only），不借它的实现。
3. **`seq` 怎么分配**：每个 stream 一个内存计数器，`append()` 时同步递增并写盘。多进程并发写同一个流不在本期范围（见 §11 未决项「单进程假设」）。
4. **崩溃一致性**：用 `fs.openSync(..., "a")` + `fs.writeSync` + `fsync`。JSONL 逐行写，半行损坏时读取侧跳过最后一行不完整记录（与 MCP 分帧的容错一致）。
5. **兼容层**：`features/session-store.ts` 保留现有接口，实现改为「读 streamId 的 JSONL → `foldTranscript()` → 写 `<id>.json` 的 `StoredSession`」。这样今天所有读 `<id>.json` 的路径（ACP `session/load`、CLI `--resume`）都能工作。

**兼容层的具体映射**（`features/session-store.ts` 改造后的行为）：

| 调用 | 改造后 |
| --- | --- |
| `store.save(record)` | **过渡期双写**：把 `record.messages` 与本次增量 diff 成事件追加到 stream；同时仍写 `<id>.json`（保持旧读路径）。S5 之后停写 `<id>.json` |
| `store.load(id)` | 读 stream → `foldTranscript()` → 组装 `StoredSession{id, cwd, createdAt: 首条事件 ts, updatedAt: 末条事件 ts, messages, usage: foldStatus().usage}` |
| `store.list()` | `log.listStreams()` 映射成 `SessionSummary[]` |
| `store.remove(id)` | `log.remove(streamId)`（并删 `blobs/` 里不再被引用的 blob，惰性） |

> 双写阶段必须保证「JSONL 是真相、`<id>.json` 是产物」：任何写失败时 `logger` 记日志并**继续**（沿用现有「丢历史不能影响对话本身」的约定），但 JSONL 写失败要抛给调用方——它是真相。

**验收**：`scripts/stream-log-test.mjs`
- 追加 → 读回顺序与 seq 正确；
- `fromSeq` 续订只拿到增量；
- 崩溃模拟（截断最后一行）→ 读取不抛错、返回完整的前缀；
- 轮转后跨文件读；
- `fork` 后新流 id 独立、seq 从 0 开始；
- 与 `session-store` 折叠结果一致（同一段对话，新旧两条路径产出相同的 `StoredSession`）。

### 5.2 `features/worker.ts` — 异步执行器（能力 ③，含 ③④ 的交叉点）

**现状**：`runtime.prompt()` 里 `await agent.prompt()`、失败重试用 `messages.slice(0, before)` 回滚；`AcpSession` 用 `running` 标志串行化。

**改法**：worker 是一个**无内部状态**的「事件 → 事件」函数，用队列保证顺序：

```ts
export interface RunWorkerOptions {
	config: AppConfig;
	extensions: ExtensionHost;
	log: StreamLog;
	/** 取一条流的当前状态（fold 结果），由调用方缓存。 */
	readState(streamId: string): Promise<AgentMessage[]>;
	/** 每次 submit 时冻结环境。 */
	resolveEnvironment(streamId: string, mode: RunMode): Promise<EnvironmentSnapshot>;
	/** 并发上限，默认 1（单进程内串行）。 */
	maxConcurrent?: number;
	/** 单流内输入的处理方式：serial | queue | parallel。默认 serial。 */
	concurrency?: "serial" | "queue" | "parallel";
}

export interface RunWorker {
	/** 立即返回；真正的执行在后台。 */
	submit(streamId: string, input: InputEvent, mode: RunMode): Promise<{ runId: string; accepted: boolean; reason?: string }>;
	/** 取消（投递一条 run.cancel_requested，见下）。 */
	cancel(streamId: string, runId: string): Promise<void>;
	/** 关闭时等待所有 run 收尾。 */
	drain(): Promise<void>;
}
```

**执行流程（一次 run）**：

```
submit(streamId, user.message)
  1. 若该流已有 run 在跑：
        serial → 投递 run.cancel_requested（与今天 ACP 的 "superseding" 等价）
        queue  → 入队，等当前 run settled 后自动开新 run（返回 accepted:true, queued）
        parallel → 直接并发（需 toolExecution: "parallel"）
  2. 追加 run.started { runId, inputCause, environment, mode }
  3. 用 createKernelAgent()（不变）建一个**一次性** Agent：
        initialState: { systemPrompt, model, tools: environment 对应的工具集, messages: fold(stream) }
     —— 注意：不再持有跨 run 的 Agent 实例，这是 ④「计算无状态」的落点
  4. 订阅 pi 事件，把 normalize() 的结果逐条 append 到总线（并复用现有归一化逻辑）
  5. 失败重试（沿用今天的语义）：
        agent.prompt() 跑完后检查最后一条 assistant：
          stopReason 是 error 且**这一轮没跑过工具** → 追加 run.failed（retryable:true）
          → 重新 fold → 用同一个一次性 Agent 重跑 agent.prompt()（第 2..N 次尝试）
        重试不再需要 messages.slice(0, before) 回滚 —— 因为状态是 fold 出来的，
        run.failed 在 fold 规则里被忽略（见 §4.3 表格），等价于回滚
        注意：一次 agent.prompt() 内部已跑完整个 ReAct 循环（多个 turn），
              这里的重试是**再一次 agent.prompt()**，粒度与今天的 runtime.prompt() 重试一致
  6. 结束 → 追加 run.settled / run.failed / run.cancelled
```

**几个关键点**：

- **「一次性 Agent」vs「常驻 Agent」**：现有 `AgentRuntime` 每个会话持有一个 `Agent` 实例，充分利用 pi 的增量状态。改成一次性会让每轮都重新构造 `Agent` 与上下文。这是有意的权衡：换来「计算无状态、可重放、可跨进程」。**代价**是每轮多一次 `new Agent`（毫秒级，无网络开销）。若实测有性能问题，退路是「常驻 Agent + 每轮校验 fold 一致性」（见 §11）。
- **重试的等价性证明**：今天 `messages.slice(0, before)` 的效果是「这次失败的 turn 不出现在后续上下文里」。新的 fold 规则里 `run.failed`（未跑工具）不产生任何消息，因此**下一次 fold 的结果与今天的回滚结果逐字节相同**。这条要有测试（`worker-test.mjs` 里对比两种路径的消息数组）。
- **取消**：`cancel()` 追加 `run.cancel_requested`，worker 订阅到自己这个 run 的取消事件后调 `agent.abort()`。这样取消也是可重放的（重放时看到「那一刻请求了取消」）。
- **`agent.prompt()` 只调用一次**：pi 的 `agent.prompt()` 内部会把一个 ReAct 循环（多个 turn）一次跑完，`turn_end` 事件会多次出现；worker 只在最外层调一次，不要按 turn 重入（重入会破坏 pi 的 steering 语义）。`run` 的粒度 = 一次 `agent.prompt()` 调用。
- **重试与 rollback 的可见性**：重试期间的失败对 `user` 受众不投影（与今天 ACP 客户端「只看到最后成功那一轮」一致，`acp:ui-test` 第 17 项断言就是这个）。

**验收**：`scripts/worker-test.mjs`
- `submit` 立即返回（<10ms），`run.started` 在返回前已落盘；
- 一轮工具调用完成 → `run.settled.outcome.stopReason==="tool_use"` 且 `foldTranscript` 与今天 `snapshot()` 结果一致；
- 注入两次 429 → `run.failed`×2 + 最终成功，`user` 投影里看不到失败；
- 取消 → `run.cancelled` 且不重试；
- `serial` / `queue` 两种并发语义各一条断言；
- 重放：用日志重建上下文，再跑一轮，结果与不重建一致。

### 5.3 `features/projection.ts` — 按受众投影（能力 ⑤）

**现状**：`AcpSession.publishEvent()` 把 `thinking_delta` → `agent_thought_chunk`、`tool_end.text` → `tool_call_update.content`（`truncate(text, 4000)` 是唯一的兜底），`tool_start.args` → `rawInput`。

**改法**：

- 投影是纯函数，输入一条 `StreamEvent` 与一个 `ProjectionPolicy`，输出 `ProjectedEvent[]`（可以是空数组，即「不发」）。
- `AcpSession.publishEvent()` 改为：订阅总线 → `project(event, policy)` → 映射成 `session/update`。默认 `policy = DEFAULT_POLICIES.full`，**保证现有客户端零变化**。
- `entries/render.ts` 同样走投影，默认 `user`，新增 CLI 开关 `--audience <user|full|audit>`。
- 工具卡片标题仍走 `toolRegistry().titleFor()`，投影只决定「发/不发/发多少」，**不认识任何具体工具名**（守住 §1.2-5）。

**「摘要」从哪来**（三种来源，按优先级）：

1. 工具自己声明了 `describe(args)` → 用它返回的 `summary`（`read_file` / `write_file` / `run_command` / MCP 工具都有）；
2. 工具声明了 `metadata.title` → 用它；
3. 兜底：`oneLine(event.text, policy.toolOutputChars)`（复用 `entries/render.ts` 里同样的规则，但**该函数要下沉到 `features/`**，否则协议层与入口层会各写一份）。

> 顺带修的现有隐患：`AcpSession.publishEvent` 里 `tool_start` 会把 `rawInput`（完整工具参数）发给客户端；`user` 受众下不再发。

**后台 run 的审批流程**（⑥ 与权限模型的交叉点，详见 §9）：

```
后台 run 想调用 permission:"ask" 的工具
  → 追加 approval.pending { requestId, runId, toolName, args, preview }（投影给 user：只给 title + preview.summary）
  → 该 run 挂起（不阻塞其它 run，也不阻塞总线）
  → 人通过任一前端订阅到 approval.pending，投递 approval.granted { requestId, decision }
  → worker 订阅到自己的 run 的决策：
        allow_once / allow_always → 以「准入」状态重新执行该工具
        deny / cancel            → 让该工具返回 { block: true } 的错误结果（与今天闸门语义一致）
  → 挂起超时（默认 10 分钟）→ 追加 run.cancelled，工具调用不执行
```

> 为什么不在前台 run 里也走这套：前台 run 的交互式等待（终端 `[y]/[a]/[n]`、ACP 的 `session/request_permission`）已经工作良好，改成事件往返只会增加一跳。**两套路径共用同一个闸门**（`features/permissions.ts` 的 `createPermissionGate()`），只是「问人的方式」不同：前台直接 await，后台投事件 + 挂起。

**体积策略**（新增，属于 ⑤ 的一部分）：

- 给 `features/stream-log.ts` 加 `maxEventBytes`（默认 64 KiB）：超限的事件在**写入前**截断并标记 `truncated: true`，原文不入日志。
- 图片（`PromptImage`）不进日志正文：写入时替换为 `{ imageRef: "blob:<sha256>" }`，blob 落到 `.steve/blobs/<sha>`，把日志文件保持在可读量级。

**验收**：`scripts/projection-test.mjs`
- `full` 档位：所有事件原样通过（逐条断言等于输入）；
- `user` 档位：`thinking_delta` 消失、`tool_start` 无 `args`、`tool_end` 有 `summary` 无 `details`；
- `audit` 档位：保留原文但标记 `audience`；
- ACP 端到端：`--audience full`（默认）时 `session/update` 序列与今天一致（用 `scripts/acp-tap.mjs` 抓两版对比）。

### 5.4 `features/environment.ts` — 环境快照（能力 ④ 的一半）

**现状**：`cli.ts` 里 `workspacePolicy({cwd, access})`、`modelInfo(config)`；`acp/agent.ts` 里 `workspacePolicy({cwd, additionalDirectories, access: allowLocalTools?"exec":"none"})`。两者各装配一遍，且构造后就固定。

**改法**：

- 新增 `snapshotEnvironment(options)`：把「一次运行需要知道的所有外部条件」收成一个对象（见 §4.4）。
- 每个入口只调用这一个函数，不再手写 policy 字面量。现状里 `modelInfo()` / `workspacePolicy()` 由 `features/session-policy.ts` 提供（两个前端各调一次）；改造后它们变成 `snapshotEnvironment()` 的内部实现，对外只暴露快照。
- 快照写入 `run.started.environment`；调试命令 `/env`（插件提供）读出最近一次 run 的快照。

**为什么这个改动虽小但关键**：它把「隐式闭包」变成「显式数据」，是 ④ 里「环境」一侧的落地，也是 ⑥ 里「后台 run 用哪套环境」的判定依据。

**验收**：`scripts/environment-test.mjs`
- 同一 cwd 下 CLI / ACP 两入口产出的快照字段一致；
- 快照 JSON 往返（序列化 → 反序列化 → 深比较）无损；
- 快照里没有函数、没有 `Agent` 实例（用 `structuredClone` 断言）。

### 5.5 `features/trigger.ts` — 主动 Watch（能力 ⑥）

**现状**：无。

**改法**：一个独立的调度器，只做「观察 → 投递事件」，**不直接调模型**。

```ts
export interface TriggerEngine {
	register(reg: TriggerRegistration): () => void;
	start(): Promise<void>;
	stop(): Promise<void>;
	/** 供 /watch 命令读取。 */
	list(): { name: string; spec: WatchSpec; lastFiredAt?: number; suppressed: number }[];
}
export function createTriggerEngine(options: {
	log: StreamLog;
	logger: Logger;
	/** 是否允许这个 run 跑（例如后台 run 不许用 ask 工具）。 */
	guard?: (reg: TriggerRegistration) => boolean;
	maxFiresPerMinute?: number;   // 默认 30，超了记 watch.dedupe
}): TriggerEngine;
```

四类实现（按依赖顺序，也是建议的实施顺序）：

| 类型 | 实现 | 关键细节 |
| --- | --- | --- |
| `predicate` | 订阅总线，匹配 `on` 里的类型 + 可选 `when` 表达式 | 表达式是**受限 DSL**（`{ field, op, value }` 的 JSON，不是 `eval`），避免用户配置等于代码执行 |
| `fs` | `node:fs.watch(递归)` + glob 过滤 + debounce | 递归 watch 在 Linux 上要 `recursive: true`（Node 20+ 支持）；失败降级为「轮询 mtime」，轮询间隔 ≥1s |
| `cron` | 解析 5 段表达式（`m h dom mon dow`），用 `setTimeout` 算下一次触发 | 只支持 `*`、数字、`a,b`、`a-b`、`*/n`；**不支持秒级**；DST 由本地时区自然处理 |
| `webhook` | `protocols/http/events.ts` 里的 `POST /hooks/:name` | 可选 `secret`：HMAC-SHA256 校验 `X-Signature`；缺 secret 时只允许 loopback（与 `--host 127.0.0.1` 默认一致） |

**防风暴（必须实现，这是 ⑥ 最容易出事的部分）**：

1. **去重**：`dedupe.key`（默认 `trigger.name`）+ `windowMs` 内只触发一次，被拦下的记 `watch.dedupe`。
2. **全局速率**：`maxFiresPerMinute`，超出记 `watch.dedupe` 并丢弃。
3. **因果链深度**：一条 `trigger.fired` 的 `causeId` 链回溯超过 `maxDepth`（默认 3）就拒绝——防止「触发器 A 产生事件 → 触发 B → 触发 A」的无限自我驱动。
4. **后台 run 的工具集收缩**（见 §9 权限模型）：`mode: "background"` 的 run 只能使用 `permission: "auto"` 的工具，需要审批的调用直接转成 `approval.pending` 事件挂起。

配置文件 `.steve/watch.json`（内置插件 `watch-config.ts` 读取，格式与 `mcp.json` 一致）：

```jsonc
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
    "watch-src": {
      "kind": "fs",
      "paths": ["src/**/*.ts"],
      "events": ["change"],
      "debounceMs": 2000,
      "targetStream": "dev",
      "prompt": "检查刚改动的文件是否通过类型检查"
    }
  }
}
```

**`.steve/watch.json` 的校验规则**（坏条目只记日志跳过，与 `mcp.json` 的语义一致）：

| 字段 | 规则 |
| --- | --- |
| `kind` | 必须是 `predicate` / `fs` / `cron` / `webhook` 之一 |
| `targetStream` | 必填，且匹配 `SAFE_ID`（复用 `isSessionId()`）；流不存在时按需创建（追加 `stream.created`） |
| `prompt` | 必填，非空字符串（触发后作为 `user.message` 的文本投递，前缀标注来源：`[watch:weekly-digest] …`） |
| `cron` | 必须能解析成 5 段；不支持秒级；解析失败跳过 |
| `paths`（fs） | 每一条都必须落在 workspace roots 内（复用 `local-tools.ts` 的 `isInside()`，**不重新实现**） |
| `secret`（webhook） | 非 loopback 监听时必填；只有 `--host 127.0.0.1` 才能不填 |
| `mode` | `foreground` / `background`，默认 `background` |

**实现约束**（避免踩坑）：

- `node:fs.watch` 的 `recursive: true` 在 Linux 上 Node 20+ 才支持；更老的 Node 或监控失败时降级为「每 2s 轮询 mtime」（用 `stat` 而不是全目录遍历）。
- `fs.watch` 在编辑器「原子保存」（写临时文件再 rename）时会连发多个事件 → `debounceMs` 必不可少，且**按文件路径分别 debounce**，不是全局 debounce。
- cron 的「下一次触发时间」只算一次，用 `setTimeout` 到点后再算下一次；进程休眠导致错过触发时**不补跑**（记 `watch.dedupe{reason:"missed"}`），避免唤醒后一次连发 N 次。
- 所有触发器在 `stop()` 时必须清空定时器与 watcher，否则测试进程会挂住（`verify.mjs` 用 `SIGTERM` 收尾，残留 timer 会让脚本变成 `--detectOpenHandles` 那种失败）。

**验收**：`scripts/trigger-test.mjs`
- 四类触发器各一条端到端断言（predicate 用总线注入、fs 用临时目录真实写文件、cron 用假时钟注入、webhook 用真 HTTP）；
- 去重窗口内只触发一次；
- 速率上限被触发时记 `watch.dedupe`；
- 因果链深度超限被拒绝；
- `background` run 遇到 `permission: "ask"` 工具 → 挂起 `approval.pending`，不执行。

### 5.6 状态折叠 `features/state-fold.ts`（能力 ④ 的另一半）

**现状**：`agent.state.messages` 是真相，`snapshot()/restore()` 整体替换。

**改法**：

- `foldTranscript(events)` / `foldStatus(events)` 是**纯函数**，输入事件、输出消息与状态，无 IO、无缓存。
- worker 每次开 run 之前调一次 `foldTranscript` 构造上下文；run 期间不增量修改它。
- `AgentRuntime.snapshot()/restore()` 保留但**降级为兼容接口**：`snapshot()` = 从最后一次 fold 的结果截取；`restore()` 不再被新代码使用（只被 `session-store` 兼容层与旧测试使用）。
- 折叠规则见 §4.3 的表格。**必须遵守的等价性**：对同一段对话，`foldTranscript()` 的结果与今天 `snapshot()` 的结果逐条相等（元素顺序、内容、`toolCallId` 全部一致）。这条是 S5 的核心验收，做不到就不能切。

**为什么这是 ④ 的关键**：只有状态能从日志「算出来」，worker 才能做到「无内部状态」，环境才能做到「只在 run 开始时冻结一次」，投影才能做到「对已落盘的事件重新计算不同视图」。三者是同一件事的三个面。

**验收**：`scripts/state-fold-test.mjs`
- 折叠规则逐条断言（含 `run.failed` 不产生消息、`tool_start` 不产生消息）；
- 用真实对话日志（mock 网关跑 6 个场景）做「fold vs 旧 snapshot」深比较；
- 重放后再跑一轮，结果与连续跑两轮一致；
- `foldStatus` 的 `usage` / `turnCount` 与 `/stats` 命令输出一致。

### 5.7 协议层与入口（能力 ①⑤ 的出口）

#### 5.7.1 ACP（`protocols/acp/session.ts` 改造）

- `AcpSession` 不再 `createAgentRuntime`，而是持有 `streamId`；`session/prompt` 改为「往总线投 `user.message` → 等 `run.settled` → 返回 `PromptResponse`」。等待的方式是订阅（收到自己的 run 的终态事件就 resolve），语义与今天「一次 prompt 对应一次响应」完全一致。
- `publishEvent` 改为「订阅总线 + `project(event, policy)`」；`policy` 来自 `AcpSessionOptions.projection`，默认 `full`。
- `session/cancel` 改为投 `run.cancel_requested`。
- `session/load` → 走 `session-store.ts` 的兼容层（JSONL → 折叠 → `StoredSession` → `replay()`）。
- `session/delete` → `log.remove(streamId)`。

#### 5.7.2 CLI（`entries/cli.ts` 改造）

- 订阅总线 + 投影，按 `--audience` 选策略；
- 权限询问：`askPermission()` 现在返回 Promise 并在 REPl 里等待一行输入。改造后**保持不变**（前台 run 仍可交互式等待）；后台 run 不走这条路径（见 §9）。

#### 5.7.3 新入口 `entries/serve.ts`（能力 ①②⑥ 的载体）

```bash
steve-serve                       # 常驻：总线 + worker + 触发器 + HTTP 订阅（默认 127.0.0.1:8892）
steve-serve --no-watch            # 不启动触发器
steve-serve --audience user       # 默认投影档位
steve-serve --port 8892 --token … # 与 steve-acp 相同的 token 语义
```

同时挂 ACP（可选，复用 `createAcpAgentApp`）与 HTTP 订阅端点：

```
GET  /streams                     → 流列表（streamId, cwd, updatedAt, status）
POST /streams                     → 新建流（body: {cwd, title?}）
GET  /streams/:id/events?from=N   → SSE，推出 project(event, user) 后的事件
POST /streams/:id/messages        → 投递 user.message（body: {text, images?}），立即返回 {runId}
POST /streams/:id/cancel          → 投 run.cancel_requested
POST /hooks/:name                 → Webhook 触发器
```

SSE 的坑与 ACP 相同：必须回 `X-Accel-Buffering: no`（已在 `protocols/acp/transport.ts` 里踩过，文档 `doc/acp-server.md` §2.3 有完整记录）。

---

## 6. 状态写入与读取路径（改造后）

| 动作 | 改造前 | 改造后 |
| --- | --- | --- |
| 写状态 | `store.save(sessionRecord({messages: snapshot()}))` → 整份覆盖 `<id>.json` | `log.append(streamId, events)` → 追加 `<streamId>/0001.jsonl` |
| 读状态（续聊） | `store.load(id).messages` → `runtime.restore()` | `log.read(streamId)` → `foldTranscript()` → 一次性 Agent 的 `messages` |
| 读状态（列表） | 扫目录 + 逐个 JSON.parse | `log.listStreams()`（读 `meta.json`） |
| 分叉 | 无 | `forkEvents(events, atSeq, newId)` |
| 投影 | 无 | `project(event, policy)` |

---

## 7. 实施阶段与依赖

严格按依赖排序，每个阶段是一个独立提交，做完可回滚：

| 阶段 | 内容 | 依赖 | 交付物 | 回归 |
| --- | --- | --- | --- | --- |
| **S0** | 拆文件（README「接下来」第 4 项）：`runtime.ts` 拆成 `runtime.ts` + `retry.ts` + `normalize.ts`；`acp/session.ts` 拆出 `publish.ts` | 无 | 纯重构，行为不变 | 全量 `verify` 绿 |
| **S0′** | 给 `arch:test` 准备新文件的落位检查：登记新增的横向边（§3.2 那两条），并加一条「新模块文件必须存在于约定目录」的断言（S1 起才真正检查，先加规则不生效） | 可与 S0 并行 | `arch:test` 从 20 项扩到 25 项 | `arch:test` 绿 |
| **S1** | `features/stream-log.ts` + `session-store.ts` 兼容层改造 | S0 | 事件日志可用，ACP/CLI 读写走新日志 | `stream-log-test` + 全量 |
| **S2** | `features/projection.ts` + `AcpSession`/`Renderer` 改走投影（默认 `full`，行为不变） | S1 | 投影可用，新增 `user` 档位 | `projection-test` + `acp:ui-test` 逐条比对 |
| **S3** | `features/environment.ts` + 各入口改用快照 | S0 | 快照进入 `run.started` | `environment-test` |
| **S4** | `features/worker.ts` + ACP `session/prompt` 改为 submit+等终态 | S1 S3 | 异步 ReAct | `worker-test` + 全量 |
| **S5** | `features/state-fold.ts` 落地，`foldTranscript` 作为状态唯一出口；过渡期双写 `<id>.json` 在此停写 | S1 S4 | ④ 完成 | `state-fold-test`（含与旧 snapshot 的等价断言）+ 双写一致性检查 |
| **S6** | `features/trigger.ts`（先 predicate + cron） + `registerTrigger()` + `watch-config.ts` | S1 S4 | ⑥ 前两类 | `trigger-test` |
| **S7** | fs + webhook 触发器、防风暴、`.steve/watch.json` 全量 | S6 | ⑥ 完成 | `trigger-test` 扩充 |
| **S8** | `protocols/http/events.ts` + `entries/serve.ts` + `doc/serve.md` | S2 S6 | 常驻形态 | `serve-test`（SSE 续订、断线重连、投影） |

**里程碑**：

- **S0–S2 完成 = 地基**：不改任何外部行为，但已经拿到「可回溯日志 + 投影」。这是最小可交付，可先上线观察。
- **S3–S5 完成 = 架构分离**：③④ 达标。
- **S6–S8 完成 = 主动化**：⑥ 达标，① 的最终形态出现。

---

## 8. 与现有代码的兼容矩阵

| 现有功能 | 改造后是否保持 | 靠什么 |
| --- | --- | --- |
| `steve`（CLI 对话） | 保持 | 投影默认 `user`，但 `--audience full` 可回到今天的样子 |
| `steve --resume <id>` | 保持 | `session-store.ts` 兼容层 |
| ACP `session/new` / `prompt` / `cancel` / `load` / `list` / `delete` | **逐条保持** | `AcpSession` 投影默认 `full`；`session/update` 序列由 `acp-tap.mjs` 抓包比对 |
| `session/request_permission` | 保持（前台 run） | 权限闸门仍是 `beforeToolCall`；后台 run 新增挂起语义（见 §9） |
| `<session-dir>/<id>.json` 文件 | 读：保持；写：**迁移为只读兼容** | 兼容层把 JSONL 折叠后仍写一份 `<id>.json`（过渡期），S5 之后改为只读回退 |
| 插件 API（`on` / `registerTool` / `registerCommand` / `registerMcpServer`） | 保持 | 新增 `registerTrigger` 是**追加**，不破坏现有插件 |
| `run_command` 等 6 个本地工具 | 保持 | 工具实现不动 |
| MCP | 保持 | 不动 |
| `/tools` `/stats` `/model` `/mcp` `/new` `/help` | 保持；新增 `/env` `/watch` | 内置插件追加 |

**行为变更清单**（必须写进 README，并给 release note）：

1. `concurrency: "serial"` 时，新输入会**投递取消事件**而不是直接 abort——外部表现相同（旧轮被取消、新轮开始），但日志里多一条 `run.cancel_requested`。
2. 默认投影档位：CLI 改为 `user`（**终端不再显示 thinking 全文与工具原文**）；ACP 保持 `full`。这是一处**用户可见的默认值变化**，CLI 需要 banner 提示 `--audience full` 可恢复。
3. `<session-dir>/<id>.json` 从「唯一真相」降级为「兼容产物」。

---

### 8.1 主要风险与回滚手段

| 风险 | 表现 | 手段 |
| --- | --- | --- |
| 一次性 Agent 导致每轮重建上下文的开销 | 长对话每轮多出可测的延迟 | S5 的 `state-fold-test` 里加一条耗时断言（构造 + fold < 100ms）；超了就切「常驻 Agent + 每轮 fold 校验」备选 |
| fold 与 pi 内部状态不一致 | 续聊上下文缺消息/多消息 | S5 强制：每轮结束用 `foldTranscript()` 与 `agent.state.messages` 深比较，不一致记 `fold.mismatch` 事件（上线首周开盘，之后可关） |
| JSONL 体积膨胀 | `.steve/streams/` 涨到数百 MB | 单事件 64 KiB 上限 + 8 MiB 轮转 + `steve --prune`（按流删除/归档）；不做自动 GC（删对话是用户决定） |
| 触发器风暴 | 后台 run 排队打满、烧额度 | §5.5 的四道防风暴；另外 `maxFiresPerMinute` 超限只记 `watch.dedupe` 不抛错 |
| ACP 兼容被投影改动破坏 | 老客户端看不到 thinking / 工具输出 | 默认 `full` + `acp-tap.mjs` 抓包比对（S2 的验收门槛） |
| 迁移期双写不一致 | `<id>.json` 与 JSONL 对不上 | 过渡期每次写 JSONL 后顺带写 `<id>.json`，但不读它；S5 之后停写 |

**回滚策略**：每个阶段一个提交，出问题直接 revert 该提交。S1 之后的阶段都不改变磁盘布局（只追加文件与字段），因此回滚不会损坏已有数据；S1 本身的回滚需要把 `session-store.ts` 切回覆盖写，此时已有 JSONL 数据可忽略（`<id>.json` 在过渡期内仍然完整）。

## 9. 安全与权限模型

| 场景 | 规则 |
| --- | --- |
| 前台 run（用户直接输入） | 权限闸门照旧：`ask` 工具弹终端 / 发 `session/request_permission` |
| 后台 run（触发器产生） | **不允许**任何 `permission: "ask"` 的工具被执行；调用这类工具 → 投 `approval.pending` 事件并**挂起该 run**，等 `approval.granted` 后继续。挂起超时（默认 10 分钟）→ `run.cancelled` |
| 工具集合 | 后台 run 的工具集 = 环境快照里 `permissionRequired === false` 的子集（`environment.ts` 已含该字段，正好可用） |
| Webhook | 配了 `secret` 才允许非 loopback 来源；`--host` 非 127.0.0.1 且无 secret 时启动失败（与 `steve-acp-serve.mjs` 的「不会静默起一个没有认证的服务」一致） |
| 触发器输入注入 | `predicate` 的 `when` 是受限 JSON DSL，**不使用 `eval` / `new Function`**；`cron` / `fs` 的路径必须收敛在 workspace roots 内（复用 `isInside()`） |
| 日志体积 | 单事件 64 KiB 上限；图片走 blob；单文件 8 MiB 轮转 |
| 隐私 | `audit` 档位写 `.steve/audit.jsonl`（含原文），默认不开启；`user` 档位不发 thinking 与工具原文 |

---

## 10. 测试计划

一个能力一个脚本，全部离线（打 `scripts/mock-server.mjs`），并加进 `verify.mjs`：

| 脚本 | 断言数（估） | 覆盖 |
| --- | --- | --- |
| `scripts/stream-log-test.mjs` | 25 | 追加/读取/续订/轮转/半行容错/fork/与 session-store 折叠一致 |
| `scripts/state-fold-test.mjs` | 20 | 折叠规则逐条；与旧 `snapshot()` 等价；重放后再跑一轮结果一致 |
| `scripts/projection-test.mjs` | 20 | 三档位逐条；工具 summary 三个来源；ACP `full` 抓包对比 |
| `scripts/environment-test.mjs` | 10 | 两入口快照一致；JSON 往返；无函数 |
| `scripts/worker-test.mjs` | 30 | submit 即返回、生命周期事件、重试等价回滚、取消、并发三档、重放 |
| `scripts/trigger-test.mjs` | 30 | 四类触发器、去重、速率、因果深度、后台 run 权限收缩 |
| `scripts/serve-test.mjs` | 20 | SSE 续订、断线重连（`Last-Event-ID` → `fromSeq`）、投影、POST 消息、hook 鉴权 |
| 既有 `arch:test` | +5 | 新增文件落位、新横向边白名单、无新依赖、`new Agent(` 仍只在一处 |

**端到端回归**：`npm run verify` 全绿 + `npm run acp:ui-test` 17 项断言逐条不变。

---

## 11. 未决项与备选方案

| 议题 | 默认选择 | 备选 / 触发条件 |
| --- | --- | --- |
| **Agent 实例生命周期** | 每个 run 一次性构造（计算无状态） | 若实测每轮构造有可观开销（>50ms 或上下文重建成本高），改「常驻 Agent + 每轮 fold 校验」，保留 worker 的异步语义 |
| **单进程假设** | 一个进程独占一个 stream 目录 | 若要多进程/多机写同一 stream，需要引入文件锁或外置存储；本期明确不做 |
| **压缩（compaction）** | 不做，`LLM_CONTEXT_WINDOW` 超限仍按现状报错 | 后续可选接入 `pi-agent-core` 的 `compaction` 工具函数（`prepareCompaction` / `compact`），但要把结果作为 `compaction` 事件落日志 |
| **`<id>.json` 去留** | 过渡期继续写，S5 后只读 | 若无外部消费者直接读该文件，可提前停写 |
| **thinking 默认展示** | CLI 改为不展示（`user`） | 若用户偏好保留，把默认改成 `thinking: "placeholder"` |
| **HTTP 订阅端点与 ACP 并存** | 并存 | 若客户端已统一到 ACP，可只保留 ACP 通道 |
| **事件总线是否暴露给插件** | 只暴露 `on(事件类型)` 与 `registerTrigger`，不暴露 `append` | 若插件需要自定义事件，再开 `appendCustom(customType, data)`（对应 pi 的 `custom` 消息） |

---

## 12. 需要评审拍板的决策（按影响排序）

1. **CLI 默认投影档位**：`user`（不显示 thinking/工具原文，符合 ⑤ 的意图）还是 `full`（与今天一致）？
2. **ACP 默认投影档位**：建议 `full` 保持兼容；是否要给 ACP 客户端一个 `initialize` 参数来协商？
3. **后台 run 遇到 `ask` 工具**：挂起等审批（本方案默认）还是直接拒绝该工具调用（更简单，模型自己换招）？
4. **`<session-dir>/<id>.json`**：过渡期继续写（本方案默认）还是立即改只读？
5. **Agent 实例**：一次性（本方案默认）还是常驻？
6. **是否本期就做 `entries/serve.ts`**（S8）：还是先只做到 S7，`steve-serve` 另立一期？

---

## 12.1 如果只能先做一步，做哪一步

按「价值 / 风险」排序，推荐的落地路径是：

1. **先做 S0 + S0′ + S1**（拆文件 + `arch:test` 准备 + 事件日志 + 兼容层）。这三步**不改变任何外部行为**，做完后系统已经拿到「可追溯日志」这一项最实质的收益，而且是最容易验证的（新旧两条读路径产出相同结果）。
2. 观察一周。如果日志形态没问题，继续 **S2（投影）**——它以最小的改动兑现 ⑤，且能立刻感受到「终端不刷 thinking/工具原文」的效果。
3. 之后按需推进 S3–S5（架构分离）与 S6–S8（主动化）。⑥ 的 `predicate` + `cron` 两类成本最低、最实用，建议先做这两类，fs/webhook 后置。

反过来，**不建议**一上来做 S5（fold）：它风险最高、收益是「结构性」的，前面几步不做的话它没有可以依凭的数据。

## 13. 术语表

| 术语 | 含义 |
| --- | --- |
| **stream（流）** | 一条连续对话的事件日志，等价于今天的 session id，但**不是容器**——它只是日志的标签 |
| **run（一次运行）** | 一次 ReAct 执行，从 `run.started` 到 `run.settled/failed/cancelled`，有独立 `runId` |
| **turn（轮）** | pi 语义里「一次模型响应 + 它的工具调用」，是 run 的内部单位 |
| **event（事件）** | 带 `seq` 的不可变记录，是唯一真相 |
| **fold（折叠）** | 从事件序列重建模型上下文/状态的纯函数 |
| **projection（投影）** | 事件 → 某个受众可见视图的纯函数 |
| **environment（环境）** | 一次运行的外部条件快照（cwd、roots、工具集、权限、模型、投影） |
| **trigger（触发器）** | 观察到条件满足就投递事件的组件，本身不调用模型 |
| **audience（受众）** | `internal` / `user` / `audit` / `full` |
