/**
 * The functional layer's event vocabulary.
 *
 * Everything above this layer (protocols, entries) speaks only these types, so
 * the layers that talk to clients never have to know how pi names its events —
 * and one vocabulary serves every front end (terminal, ACP, future protocols).
 */

/** Where a turn ended, in terms a UI understands (no provider vocabulary). */
export type TurnStopReason = "stop" | "tool_use" | "length" | "cancelled" | "error";

export interface TurnUsage {
	input: number;
	output: number;
	total: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
}

/** An image attached to a prompt, independent of any provider's schema. */
export interface PromptImage {
	mimeType: string;
	data: string;
}

/** One entry of a replayed transcript, in provider-neutral terms. */
export type TranscriptEntry =
	| { role: "user"; text: string; images: number }
	| { role: "assistant"; thinking: string; text: string; toolCalls: { id: string; name: string; args: unknown }[] }
	| { role: "tool"; toolCallId: string; name: string; isError: boolean; text: string };

export type AgentRuntimeEvent =
	| { type: "turn_start" }
	| { type: "text_delta"; text: string }
	| { type: "thinking_delta"; text: string }
	| { type: "tool_start"; id: string; name: string; args: unknown }
	| { type: "tool_update"; id: string; name: string; text: string }
	| { type: "tool_end"; id: string; name: string; isError: boolean; text: string; details?: unknown; images?: PromptImage[] }
	| {
			type: "turn_end";
			stopReason: TurnStopReason;
			/** Usage reported by the provider for the final assistant message of the turn. */
			usage: TurnUsage;
			/** Tokens the transcript occupied after this turn (used by `usage_update`). */
			contextTokens: number;
			failed: boolean;
			errorMessage?: string;
			/** Retries that were needed before the turn settled. */
			retries: number;
			/** Set when this turn's request carried a compacted transcript. */
			compacted?: { droppedMessages: number; keptMessages: number; before: number; after: number };
	  };

/* ------------------------------------------------------------------------- */
/* Stream 事件（personal agent 阶段）：除了上面的 turn 内事件，一条 stream      */
/* 还承载输入、运行生命周期与系统事件。见 docs/personal-agent.md §4.2。         */
/* ------------------------------------------------------------------------- */

/** 一次运行的模式：前台（人正等着）或后台（触发器/排队）。 */
export type RunMode = "foreground" | "background";

/**
 * 事件流的读者。投影策略写在事件词表里（而不是 `projection.ts`），
 * 这样环境快照（§4.4 的 `EnvironmentSnapshot.projection`）也能引用它，
 * 而 `environment.ts` 仍保持为纯契约、不 import 运行时实现。
 */
export type Audience = "internal" | "user" | "audit" | "full";

/** 某个受众能看到多少内部细节（§4.5）。 */
export interface ProjectionPolicy {
	audience: Audience;
	/** Keep a thinking placeholder (so the UI can show "thinking…") or drop it entirely. */
	thinking: "drop" | "placeholder";
	/** How a finished tool call is summarized: one line, or a truncated raw dump. */
	toolOutput: "summary" | "truncated";
	/** Character budget for the tool summary; 240 matches the renderer's default. */
	toolOutputChars: number;
	/** Include the tool's structured details (diffs, lists) when it reported any. */
	details: boolean;
}

/** 一次运行结束时的结果，足以重建 UI 状态。 */
export interface RunOutcome {
	stopReason: TurnStopReason;
	usage: TurnUsage;
	contextTokens: number;
	retries: number;
}

/**
 * 事件信封。`seq` 在一条 stream 内从 1 单调递增、不跳号；由 `StreamLog.append`
 * 在内存计数器上同步分配，轮转文件不会重置它。
 */
export interface StreamEventBase {
	seq: number;
	streamId: string;
	/** 毫秒时间戳。 */
	ts: number;
	/** 因果边：本次事件由哪条事件引发。 */
	causeId?: number;
	/** 写入时因超过单事件上限被截断（体积策略见 §5.3）。 */
	truncated?: boolean;
	/** 截断事件的原文预览（仅当事件无法保留原字段时出现）。 */
	preview?: string;
}

/* ── 输入类：谁让系统动起来的 ─────────────────────────────────────────── */

export interface UserMessageEvent {
	type: "user.message";
	text: string;
	images?: PromptImage[];
}

export interface TriggerFiredEvent {
	type: "trigger.fired";
	trigger: string;
	source: "predicate" | "fs" | "cron" | "webhook";
	detail: unknown;
}

export interface ApprovalPendingEvent {
	type: "approval.pending";
	requestId: string;
	runId: string;
	toolName: string;
	args: unknown;
	preview?: unknown;
}

export interface ApprovalGrantedEvent {
	type: "approval.granted";
	requestId: string;
	toolName: string;
	decision: string;
}

/* ── 运行生命周期类：一次 ReAct 执行 ───────────────────────────────────── */

export interface RunStartedEvent {
	type: "run.started";
	runId: string;
	/** 引发这次运行的事件 seq。 */
	inputCause: number;
	environment: unknown;
	mode: RunMode;
}

export interface RunCancelRequestedEvent {
	type: "run.cancel_requested";
	runId: string;
	by: "user" | "policy";
}

export interface RunSettledEvent {
	type: "run.settled";
	runId: string;
	outcome: RunOutcome;
}

export interface RunFailedEvent {
	type: "run.failed";
	runId: string;
	error: string;
	/** 失败是否可以重试（未跑工具时才可重试，等价旧的 `messages.slice(0, before)`）。 */
	retryable?: boolean;
}

export interface RunCancelledEvent {
	type: "run.cancelled";
	runId: string;
	reason: string;
}

/**
 * 上下文压缩：一次摘要替换掉了前段历史。落盘是为了让「日志的真相」包含它——
 * `foldTranscript` 据此重建压缩后的上下文，否则恢复会话会把摘要丢掉、再次爆窗。
 *
 * 决策见 `features/compaction.ts`；`message` 是替换前段的那条摘要消息。
 */
export interface CompactionEvent {
	type: "compaction";
	/** 被摘要覆盖的消息条数。 */
	droppedMessages: number;
	/** 原样保留在摘要之后的消息条数。 */
	keptMessages: number;
	/** 压缩前后估算的上下文 token（仅供参考，不参与重放）。 */
	beforeTokens: number;
	afterTokens: number;
	/** 摘要文本，供排查「它到底记住了什么」。 */
	summary: string;
}

/**
 * 内部事件：一个 turn 的最终 assistant 消息，专供 `foldTranscript` 重建上下文。
 * 不投影给 `user` 受众（避免把工具参数原文再泄一遍）。
 */
export interface RunTurnSettledEvent {
	type: "run.turn.settled";
	runId: string;
	message: unknown;
}

/* ── 系统类 ────────────────────────────────────────────────────────────── */

export interface StreamCreatedEvent {
	type: "stream.created";
	streamId: string;
	cwd: string;
	title?: string;
}

export interface ConfigChangedEvent {
	type: "config.changed";
	key: string;
	previous: unknown;
	value: unknown;
}

export interface WatchArmedEvent {
	type: "watch.armed";
	trigger: string;
	spec: unknown;
}

export interface WatchDedupeEvent {
	type: "watch.dedupe";
	trigger: string;
	reason: string;
}

/** 一条 stream 里可能出现的事件正文（不含信封字段）。 */
export type StreamEventBody =
	| AgentRuntimeEvent
	| UserMessageEvent
	| TriggerFiredEvent
	| ApprovalPendingEvent
	| ApprovalGrantedEvent
	| RunStartedEvent
	| RunCancelRequestedEvent
	| RunSettledEvent
	| RunFailedEvent
	| RunCancelledEvent
	| RunTurnSettledEvent
	| CompactionEvent
	| StreamCreatedEvent
	| ConfigChangedEvent
	| WatchArmedEvent
	| WatchDedupeEvent;

/** 落盘/传输用的完整事件：信封 + 正文。 */
export type StreamEvent = StreamEventBase & StreamEventBody;
