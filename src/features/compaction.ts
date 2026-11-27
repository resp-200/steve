/**
 * Context compaction: what we send when the transcript no longer fits.
 *
 * Until this existed, every request replayed the whole transcript and a session
 * that outgrew `LLM_CONTEXT_WINDOW` was stuck for good: the overflow error is
 * not retryable, and the history that caused it never shrank. The policy here —
 * which pi-agent-core's `harness/compaction` implements for its own session
 * entries — is ours to make, so it is written down once, in pure functions:
 *
 *   1. measure   — `estimateContextTokens` (last reported usage + a char/4
 *                  estimate of what arrived after it);
 *   2. boundary  — cut on a *user turn* start, so a turn's tool calls and their
 *                  results are never split (Anthropic rejects an orphaned
 *                  `tool_use`);
 *   3. summarize — ask the model for a summary of everything before the cut and
 *                  replace it with one user message carrying
 *                  {@link COMPACTION_PREFIX};
 *   4. repair    — drop a tail that would start with a `toolResult`, because its
 *                  `toolCall` now lives inside the summary.
 *
 * The compaction is advisory: if the summary request fails, the caller sends the
 * (still too long) transcript and lets the turn fail the way it always did. A
 * summarizer outage must not become a new failure mode.
 *
 * Why not pi's `prepareCompaction` / `compact`: both take pi `Entry[]` and a
 * `Models` instance, and pi's own loop never calls them for us — `streamAssistantResponse`
 * only runs `transformContext`, which we already own. Borrowing the *policy*
 * and keeping the *mechanism* here avoids a second model configuration that
 * could silently disagree with the one this session actually talks to.
 */
import type { AgentMessage } from "./contract.js";

/** Marks the message that stands in for the summarized part of the transcript. */
export const COMPACTION_PREFIX = "The conversation so far was compacted to save context. Summary:";

/** Defaults for {@link resolveCompactionPolicy}; each is overridable by env. */
export const COMPACTION_DEFAULTS = {
	/** Share of the context window that may be used before compacting starts. */
	triggerRatio: 0.75,
	/** Tokens worth keeping verbatim at the tail; the rest is summarized. */
	keepRecentTokens: 20_000,
	/** Tokens budgeted for the summary itself. */
	summaryTokens: 2_048,
	/** A single tool result longer than this is compacted on sight, not summarized. */
	maxToolResultChars: 16_000,
	/** Head of an over-long tool result that survives compaction, in characters. */
	toolResultHeadChars: 1_200,
} as const;

export interface CompactionPolicy {
	/** Off entirely when false: nothing is even measured. */
	enabled: boolean;
	/** Absolute token budget that triggers a summary. */
	triggerTokens: number;
	/** Absolute token budget kept verbatim at the tail. */
	keepRecentTokens: number;
	/** Budget for the summary request. */
	summaryTokens: number;
	/** Tool results longer than this are compacted in place (step 0). */
	maxToolResultChars: number;
	/** How much of an over-long tool result to keep when compacting it in place. */
	toolResultHeadChars: number;
}

export interface CompactionPolicyInput {
	/** The model's context window (`LLM_CONTEXT_WINDOW`, or the provider's default). */
	contextWindow: number;
	/** The model's per-response cap (`LLM_MAX_TOKENS`); it is never summarized away. */
	maxTokens: number;
	/** Top the trigger up to this many tokens of headroom as well as the ratio. */
	reserveTokens?: number;
}

/** Rough token count for text: providers average ~4 characters per token. */
export function estimateTextTokens(text: string): number {
	if (text.length === 0) return 0;
	return Math.ceil(text.length / 4);
}

/**
 * Estimates the transcript's token weight. The last reported usage is the
 * ground truth for everything it covered; what came after it (the tool results
 * of the current turn, mostly) is estimated from characters.
 */
export function estimateContextTokens(messages: readonly AgentMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const used = contextTokensOf(message);
		if (used === undefined) continue;
		// Anything after the usage was never billed in it. A transcript that was
		// compacted since is *smaller* than its last usage, and reporting the stale
		// number would keep the trigger red and compact on every request.
		let trailing = 0;
		for (const later of messages.slice(index + 1)) trailing += estimateMessageTokens(later);
		return used + trailing;
	}
	return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

/** What the provider said the request cost, when it said anything at all. */
function contextTokensOf(message: AgentMessage): number | undefined {
	const usage = (message as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).usage;
	if (usage === undefined) return undefined;
	const total =
		(usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	return total > 0 ? total : undefined;
}

/** Per-message estimate, used for the part of the transcript usage did not cover. */
export function estimateMessageTokens(message: AgentMessage): number {
	const content = (message as { content?: unknown }).content;
	let chars = 8; // role/timestamp envelope
	if (typeof content === "string") chars += content.length;
	else if (Array.isArray(content)) {
		for (const block of content) {
			if (typeof block !== "object" || block === null) continue;
			const typed = block as { type?: string; text?: string; arguments?: unknown; data?: string };
			chars += typed.text?.length ?? 0;
			if (typed.type === "toolCall") chars += JSON.stringify(typed.arguments ?? {}).length;
			// A picture is worth a fixed, generous guess; we cannot count its pixels.
			if (typed.type === "image") chars += 4_000;
		}
	}
	return estimateTextTokens("x".repeat(chars));
}

/**
 * Derives the policy from the model's limits.
 *
 * The trigger has to leave room for three things at once: the reply itself
 * (`maxTokens`), the summary request (`summaryTokens`), and the retained tail —
 * otherwise compacting would immediately trigger again.
 */
export function resolveCompactionPolicy(input: CompactionPolicyInput): CompactionPolicy {
	const window = input.contextWindow > 0 ? input.contextWindow : 128_000;
	const reply = input.maxTokens > 0 ? input.maxTokens : 8_192;
	const reserve = input.reserveTokens ?? COMPACTION_DEFAULTS.summaryTokens;
	const ratioTrigger = Math.floor(window * COMPACTION_DEFAULTS.triggerRatio);
	const headroomTrigger = window - reply - reserve;
	const triggerTokens = Math.max(1_000, Math.min(ratioTrigger, headroomTrigger));
	const keepRecentTokens = Math.max(1_000, Math.min(COMPACTION_DEFAULTS.keepRecentTokens, Math.floor(triggerTokens / 2)));
	return {
		enabled: true,
		triggerTokens,
		keepRecentTokens,
		summaryTokens: reserve,
		maxToolResultChars: COMPACTION_DEFAULTS.maxToolResultChars,
		toolResultHeadChars: COMPACTION_DEFAULTS.toolResultHeadChars,
	};
}

/* ------------------------------------------------------------------------- */
/* Step 0: over-long tool results, compacted in place                          */
/* ------------------------------------------------------------------------- */

export interface ToolResultPrune {
	messages: AgentMessage[];
	/** How many results were rewritten. */
	pruned: number;
	/** Characters saved by the rewrite. */
	savedChars: number;
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (typeof block === "object" && block !== null && (block as { type?: string }).type === "text") {
			text += (block as { text?: string }).text ?? "";
		}
	}
	return text;
}

function clippedToolResult(message: AgentMessage, policy: CompactionPolicy): { message: AgentMessage; saved: number } | undefined {
	const text = textOfContent((message as { content?: unknown }).content);
	if (text.length <= policy.maxToolResultChars) return undefined;
	const name = (message as { toolName?: string }).toolName ?? "tool";
	const head = text.slice(0, policy.toolResultHeadChars);
	const omitted = text.length - policy.toolResultHeadChars;
	const body = `${head}\n\n[compacted: ${omitted.toLocaleString("en-US")} more characters of ${name} output were removed to save context]`;
	const images = Array.isArray((message as { content?: unknown }).content)
		? ((message as { content: unknown[] }).content.filter((block) => (block as { type?: string }).type === "image") as unknown[])
		: [];
	return {
		message: { ...message, content: [{ type: "text" as const, text: body }, ...images] } as AgentMessage,
		saved: text.length - body.length,
	};
}

/**
 * The cheap half of compaction: a `read_file` of a whole source tree or a long
 * command log is usually the reason a transcript is heavy, and none of it needs
 * an LLM to shorten. Keeps the head (paths, first lines of output) and the tool
 * identity, so the model can still tell what happened and re-read if it cares.
 */
export function pruneToolResults(messages: readonly AgentMessage[], policy: CompactionPolicy): ToolResultPrune {
	let pruned = 0;
	let savedChars = 0;
	const next: AgentMessage[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult") {
			next.push(message);
			continue;
		}
		const clipped = clippedToolResult(message, policy);
		if (clipped === undefined) {
			next.push(message);
			continue;
		}
		next.push(clipped.message);
		pruned += 1;
		savedChars += clipped.saved;
	}
	return { messages: pruned === 0 ? [...messages] : next, pruned, savedChars };
}

/* ------------------------------------------------------------------------- */
/* Step 1–2: the cut point                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Index the tail starts at, or `undefined` when the transcript cannot be split.
 *
 * The rule is deliberately narrow: the tail must start at a **user message**
 * that no retained `toolResult` belongs before. Starting anywhere else splits a
 * pending tool call from its result, which providers reject.
 */
export function findCompactionCut(
	messages: readonly AgentMessage[],
	policy: Pick<CompactionPolicy, "keepRecentTokens">,
): number | undefined {
	if (messages.length < 4) return undefined;
	// Walk backwards accumulating weight until the tail is big enough. If the
	// whole transcript is smaller than the keep budget, the walk stops on the
	// first message and the checks below decline to compact — but it must not
	// silently keep *nothing*, which would let the caller summarize everything.
	let tailTokens = 0;
	let index = messages.length;
	for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
		tailTokens += estimateMessageTokens(messages[cursor]!);
		index = cursor;
		if (tailTokens >= policy.keepRecentTokens) break;
	}
	// …then move that start back to the nearest user message, which is what keeps
	// whole turns together. One user turn is always retained, so the boundary can
	// never land before the second user message.
	let cut = index;
	while (cut > 0 && messages[cut]?.role !== "user") cut -= 1;
	if (messages[cut]?.role !== "user") return undefined;
	let firstUser = 0;
	while (firstUser < messages.length && messages[firstUser]?.role !== "user") firstUser += 1;
	if (cut <= firstUser) return undefined;
	return cut;
}

/**
 * The tail, repaired so it starts cleanly: a leading `toolResult` whose
 * `toolCall` stayed behind in the summary is dropped, together with any
 * neighbouring assistant message that made the call. Returns `undefined` when
 * nothing usable is left.
 */
export function repairTail(tail: readonly AgentMessage[], summarized: readonly AgentMessage[]): AgentMessage[] | undefined {
	const calledBefore = new Set<string>();
	for (const message of summarized) {
		if (message.role !== "assistant") continue;
		for (const block of (message as { content?: unknown }).content as { type?: string; id?: string }[] | undefined ?? []) {
			if (block?.type === "toolCall" && typeof block.id === "string") calledBefore.add(block.id);
		}
	}
	let start = 0;
	while (start < tail.length && tail[start]?.role === "toolResult") {
		const id = (tail[start] as { toolCallId?: string }).toolCallId;
		// Only an orphan is dropped; one whose call is still in the tail is kept.
		if (id !== undefined && calledBefore.has(id)) {
			start += 1;
			continue;
		}
		break;
	}
	if (start >= tail.length) return undefined;
	return tail.slice(start);
}

/* ------------------------------------------------------------------------- */
/* Step 3: the summary request                                                */
/* ------------------------------------------------------------------------- */

/** System prompt for the summarizer; kept short so a small model can follow it. */
export const COMPACTION_SYSTEM_PROMPT = [
	"You compress conversation history for another assistant that must keep working from your output.",
	"Write a dense summary that preserves:",
	"- what the user asked for, in order, and any preference or constraint they stated;",
	"- what was decided and why, including rejected options;",
	"- facts learned from tools: file paths, commands run, errors seen, values found;",
	"- what is still unfinished, and the exact next step.",
	"Omit pleasantries and anything that can be re-derived by running a tool again.",
	"Use plain bullet points, no preamble, no headings beyond what the bullets need.",
].join("\n");

/** Serializes a message for the summarizer: readable, and much cheaper than JSON. */
export function serializeForSummary(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	switch (message.role) {
		case "user":
			return `USER: ${textOfContent(content)}`;
		case "assistant": {
			const lines: string[] = [];
			const blocks = Array.isArray(content) ? content : [];
			for (const block of blocks) {
				const typed = block as { type?: string; text?: string; name?: string; arguments?: unknown };
				if (typed.type === "text" && typed.text) lines.push(`ASSISTANT: ${typed.text}`);
				else if (typed.type === "toolCall") {
					const args = JSON.stringify(typed.arguments ?? {});
					lines.push(`ASSISTANT called ${typed.name ?? "tool"}(${args.length > 400 ? `${args.slice(0, 400)}…` : args})`);
				}
			}
			return lines.join("\n");
		}
		case "toolResult": {
			const name = (message as { toolName?: string }).toolName ?? "tool";
			const failed = (message as { isError?: boolean }).isError === true ? " (failed)" : "";
			const text = textOfContent(content);
			const clipped = text.length > 2_000 ? `${text.slice(0, 2_000)}\n… [${text.length - 2_000} more characters]` : text;
			return `TOOL ${name}${failed}: ${clipped}`;
		}
		default:
			return "";
	}
}

/** The user prompt handed to the summarizer. */
export function buildSummaryPrompt(messages: readonly AgentMessage[], previousSummary?: string): string {
	const transcript = messages.map(serializeForSummary).filter((line) => line !== "").join("\n\n");
	const parts: string[] = [];
	if (previousSummary !== undefined && previousSummary.trim() !== "") {
		parts.push(`Summary of the conversation before this segment:\n${previousSummary.trim()}`);
	}
	parts.push(`Conversation segment to summarize:\n\n${transcript}`);
	parts.push("Reply with the updated summary only.");
	return parts.join("\n\n");
}

/** The single user message that replaces the summarized part. */
export function compactionMessage(summary: string, timestamp = Date.now()): AgentMessage {
	return {
		role: "user",
		content: `${COMPACTION_PREFIX}\n\n${summary.trim()}`,
		timestamp,
	} as AgentMessage;
}

/**
 * The latest compaction's text, read off a transcript head. The runtime knows
 * its summary but not that it was logged; the log needs the text, and reading it
 * back off the message it produced keeps the two from disagreeing.
 */
export function lastCompactionSummary(messages: readonly AgentMessage[]): string {
	for (const message of messages) {
		const summary = previousSummaryOf(message);
		if (summary !== undefined) return summary;
	}
	return "";
}

/**
 * Turns a compaction the hook just applied into the event the log records. The
 * summary text is read back off the message that replaced the history, so the
 * folded transcript and the message the model saw can never disagree.
 */
export function compactionEventFor(transcript: readonly AgentMessage[], result: CompactionResultLike, ts = Date.now()): CompactionEventLike {
	return {
		type: "compaction",
		droppedMessages: result.droppedMessages,
		keptMessages: result.keptMessages,
		beforeTokens: result.before,
		afterTokens: result.after,
		summary: lastCompactionSummary(transcript),
	};
}

/** The fields of the hook's result that the event needs (kept structural: no import cycle). */
export interface CompactionResultLike {
	droppedMessages: number;
	keptMessages: number;
	before: number;
	after: number;
}

/** The shape of the logged compaction event (kept structural: no import cycle). */
export interface CompactionEventLike {
	type: "compaction";
	droppedMessages: number;
	keptMessages: number;
	beforeTokens: number;
	afterTokens: number;
	summary: string;
}

/** An earlier compaction message in the transcript, if this is one. */
export function previousSummaryOf(message: AgentMessage): string | undefined {
	if (message.role !== "user") return undefined;
	const text = textOfContent((message as { content?: unknown }).content);
	if (!text.startsWith(COMPACTION_PREFIX)) return undefined;
	return text.slice(COMPACTION_PREFIX.length).trim();
}

/* ------------------------------------------------------------------------- */
/* The whole operation                                                        */
/* ------------------------------------------------------------------------- */

export interface CompactionPlan {
	/** What goes to the summarizer (everything before the cut). */
	summarize: AgentMessage[];
	/** What is kept verbatim after the summary message. */
	keep: AgentMessage[];
	/** The summary this one supersedes, when the transcript was compacted before. */
	previousSummary?: string;
	/** Index in the input the tail starts at (for reporting). */
	cut: number;
}

/**
 * Decides whether to compact and what to summarize. Returns `undefined` when
 * there is nothing to do — which is the common case, and must stay cheap.
 */
export function planCompaction(
	messages: readonly AgentMessage[],
	policy: CompactionPolicy,
	tokens: number = estimateContextTokens(messages),
): CompactionPlan | undefined {
	if (!policy.enabled || tokens < policy.triggerTokens) return undefined;
	const cut = findCompactionCut(messages, policy);
	if (cut === undefined) return undefined;
	const head = messages.slice(0, cut);
	const keep = repairTail(messages.slice(cut), head);
	if (keep === undefined) return undefined;

	// A previous summary is part of the head; feed it back so the new summary is
	// an update, not a rewrite that might drop things the earlier pass knew.
	let previousSummary: string | undefined;
	const summarize = head.filter((message) => {
		const previous = previousSummaryOf(message);
		if (previous === undefined) return true;
		previousSummary = previous;
		return false;
	});
	if (summarize.length === 0) return undefined;
	return { summarize, keep, ...(previousSummary !== undefined ? { previousSummary } : {}), cut };
}

/** The compacted transcript: one summary message, then the retained tail. */
export function applyCompaction(plan: CompactionPlan, summary: string, timestamp?: number): AgentMessage[] {
	return [compactionMessage(summary, timestamp), ...plan.keep];
}
