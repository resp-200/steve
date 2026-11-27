/**
 * Event projection: one event bus, several audiences (docs/personal-agent.md §4.5).
 *
 * The runtime emits a single normalized stream. What a *consumer* may see depends
 * on who it is: a terminal should not print raw tool arguments or model thinking,
 * an ACP client keeps today's full view, and the audit log keeps the original
 * event. This module is the one place that decision is written down, as a pure
 * function, so every front end can share it and it can be tested without a
 * runtime.
 *
 * Narrowing is *not* redaction of secrets the model already produced — it is the
 * difference between what the agent internally knows and what a person needs to
 * see while it works.
 */
import type { Audience, ProjectionPolicy, StreamEventBody, TurnStopReason, TurnUsage } from "./events.js";

/**
 * The policy types live in the event vocabulary so `features/environment.ts` can
 * embed a snapshot of them without importing this module (contract files stay
 * free of runtime implementations, see `scripts/arch-test.mjs` 3c).
 */
export type { Audience, ProjectionPolicy } from "./events.js";

const FULL: ProjectionPolicy = {
	audience: "full",
	thinking: "placeholder",
	toolOutput: "truncated",
	toolOutputChars: 4000,
	details: true,
};

/**
 * Defaults per audience. `full` is what ACP clients get today — projection must
 * be an identity there so nothing observable changes; `user` is the terminal's
 * default: no thinking, no raw arguments, only human-sized summaries.
 */
export const DEFAULT_POLICIES: Record<Audience, ProjectionPolicy> = {
	internal: { ...FULL, audience: "internal" },
	audit: { ...FULL, audience: "audit" },
	full: FULL,
	user: {
		audience: "user",
		thinking: "drop",
		toolOutput: "summary",
		toolOutputChars: 240,
		details: false,
	},
};

/**
 * What the host knows about its tools that projection cannot infer. All optional:
 * without them the projection degrades to ids and names, never to raw arguments.
 */
export interface ProjectionHooks {
	/** Presentation kind a tool declared. */
	kindFor?(toolName: string): string | undefined;
	/** Static or argument-derived title a tool declared. */
	titleFor?(toolName: string, args: unknown): string | undefined;
	/** The tool's own one-line summary for a finished call; wins over its text. */
	summaryFor?(toolName: string, args: unknown, text: string): string | undefined;
	/** The tool's own preview summary for a call that needs approval. */
	previewFor?(toolName: string, args: unknown): string | undefined;
}

/* ------------------------------ user view ------------------------------- */

/** Event types whose shape is narrowed for the `user` audience. */
type NarrowedType = "thinking_delta" | "tool_start" | "tool_update" | "tool_end" | "turn_end" | "run.failed" | "approval.pending";

/** Every event we pass through unchanged: its original body type survives. */
type WithoutNarrowed<T> = T extends { type: NarrowedType } ? never : T;

/** Thinking happened, but the text itself is internal. */
export interface ProjectedThinkingEvent {
	type: "thinking_delta";
}

export interface ProjectedToolStartEvent {
	type: "tool_start";
	id: string;
	name: string;
	/** Declared title, if the tool has one; otherwise the name is what a UI shows. */
	title?: string;
	kind?: string;
}

/** A tool is still running: progress text is internal, the id/name are enough. */
export interface ProjectedToolUpdateEvent {
	type: "tool_update";
	id: string;
	name: string;
}

export interface ProjectedToolEndEvent {
	type: "tool_end";
	id: string;
	name: string;
	isError: boolean;
	/** Human-sized summary: the tool's own, or one line of its output. */
	summary?: string;
	/** Structured details, only when the policy asks for them. */
	details?: unknown;
}

export interface ProjectedTurnEndEvent {
	type: "turn_end";
	stopReason: TurnStopReason;
	usage: TurnUsage;
	contextTokens: number;
	failed: boolean;
	/** Provider error text is internal; `stopReason`/`failed` are enough. */
	retries: number;
}

/** A retryable failure is internal bookkeeping: the error text stays inside. */
export interface ProjectedRunFailedEvent {
	type: "run.failed";
	runId: string;
	retryable?: boolean;
}

export interface ProjectedApprovalPendingEvent {
	type: "approval.pending";
	requestId: string;
	runId: string;
	toolName: string;
	title?: string;
	/** The call's preview summarized to one line. */
	summary?: string;
}

/** The body a `user` consumer receives. */
export type UserProjectedBody =
	| WithoutNarrowed<StreamEventBody>
	| ProjectedThinkingEvent
	| ProjectedToolStartEvent
	| ProjectedToolUpdateEvent
	| ProjectedToolEndEvent
	| ProjectedTurnEndEvent
	| ProjectedRunFailedEvent
	| ProjectedApprovalPendingEvent;

/** One event as a specific audience sees it; `full`/`audit` keep the original body. */
export type ProjectedEvent =
	| { audience: "internal" | "full" | "audit"; event: StreamEventBody }
	| { audience: "user"; event: UserProjectedBody };

/* -------------------------------- helpers -------------------------------- */

/** Collapse arbitrary text to one display line, with `...` past `max` characters. */
export function oneLine(text: string, max = 120): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** Keep the beginning of a multi-line text, ending with `...` when clamped. */
export function truncateText(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function summarize(text: string, policy: ProjectionPolicy): string {
	if (policy.toolOutput === "truncated") return truncateText(text, policy.toolOutputChars);
	return oneLine(text, policy.toolOutputChars);
}

/** The text of an approval preview, so a person sees *what* will change in one line. */
function previewSummary(preview: unknown): string | undefined {
	if (preview === undefined || preview === null) return undefined;
	if (typeof preview === "string") return oneLine(preview);
	if (typeof preview === "object" && "summary" in preview) {
		const summary = (preview as { summary?: unknown }).summary;
		if (typeof summary === "string") return oneLine(summary);
	}
	return undefined;
}

/* ------------------------------- projection ------------------------------ */

/**
 * Project one runtime event for one audience. Returns zero events when the
 * audience must not see it at all (e.g. `run.turn.settled` for a person), and an
 * identity body for `full`/`audit`/`internal` so existing consumers keep their
 * exact behaviour.
 */
export function project(event: StreamEventBody, policy: ProjectionPolicy, hooks: ProjectionHooks = {}): ProjectedEvent[] {
	if (policy.audience !== "user") {
		return [{ audience: policy.audience, event }];
	}
	return projectUser(event, policy, hooks);
}

function projectUser(event: StreamEventBody, policy: ProjectionPolicy, hooks: ProjectionHooks): ProjectedEvent[] {
	const audience = "user" as const;

	switch (event.type) {
		case "thinking_delta":
			return policy.thinking === "drop" ? [] : [{ audience, event: { type: "thinking_delta" } }];

		case "tool_start": {
			const title = hooks.titleFor?.(event.name, event.args);
			const kind = hooks.kindFor?.(event.name);
			return [
				{
					audience,
					event: {
						type: "tool_start",
						id: event.id,
						name: event.name,
						...(title !== undefined ? { title } : {}),
						...(kind !== undefined ? { kind } : {}),
					},
				},
			];
		}

		case "tool_update":
			return [{ audience, event: { type: "tool_update", id: event.id, name: event.name } }];

		case "tool_end": {
			const own = hooks.summaryFor?.(event.name, undefined, event.text);
			const summary = own !== undefined ? oneLine(own, policy.toolOutputChars) : summarize(event.text, policy);
			return [
				{
					audience,
					event: {
						type: "tool_end",
						id: event.id,
						name: event.name,
						isError: event.isError,
						...(summary !== "" ? { summary } : {}),
						...(policy.details && event.details !== undefined ? { details: event.details } : {}),
					},
				},
			];
		}

		case "turn_end":
			// Drop `errorMessage`: provider errors are internal, the classification is enough.
			return [
				{
					audience,
					event: {
						type: "turn_end",
						stopReason: event.stopReason,
						usage: event.usage,
						contextTokens: event.contextTokens,
						failed: event.failed,
						retries: event.retries,
					},
				},
			];

		case "run.failed":
			// Provider errors are internal; a run id and whether it could be retried suffice.
			return [
				{
					audience,
					event: {
						type: "run.failed",
						runId: event.runId,
						...(event.retryable !== undefined ? { retryable: event.retryable } : {}),
					},
				},
			];

		case "approval.pending": {
			const title = hooks.titleFor?.(event.toolName, event.args);
			const summary = hooks.previewFor?.(event.toolName, event.args) ?? previewSummary(event.preview);
			return [
				{
					audience,
					event: {
						type: "approval.pending",
						requestId: event.requestId,
						runId: event.runId,
						toolName: event.toolName,
						...(title !== undefined ? { title } : {}),
						...(summary !== undefined ? { summary } : {}),
					},
				},
			];
		}

		case "run.turn.settled":
			// Internal bookkeeping for rebuilding the transcript; nobody should render it.
			return [];

		case "compaction": {
			// A person sees that history was compacted, not what it said.
			const counts = `${event.droppedMessages} 条消息折叠为摘要（保留 ${event.keptMessages} 条）`;
			return [{ audience, event: { type: "compaction", droppedMessages: event.droppedMessages, keptMessages: event.keptMessages, beforeTokens: event.beforeTokens, afterTokens: event.afterTokens, summary: counts } }];
		}

		default:
			return [{ audience, event: event as WithoutNarrowed<StreamEventBody> }];
	}
}
