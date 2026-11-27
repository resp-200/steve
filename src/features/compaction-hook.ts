/**
 * The compaction hook: what `transformContext` runs after the failed-turn filter.
 *
 * It is deliberately *not* a plugin. A plugin sees `ExtensionContext`, which
 * carries neither the model (and so its context window) nor a way to run an LLM
 * request; compaction needs both. Keeping it in the functional layer also means
 * the CLI, the ACP server and the run worker all get it from `assembleAgent`,
 * with no front end changes.
 *
 * Every run gets one budget: a compaction is attempted at most once per
 * `prompt()`, so a turn that makes ten tool calls cannot re-summarize ten times.
 * Idempotence lives here rather than in the pure planning code, because only
 * this layer knows what a "run" is.
 */
import type { AgentMessage } from "./contract.js";
import {
	applyCompaction,
	estimateContextTokens,
	estimateMessageTokens,
	planCompaction,
	pruneToolResults,
	type CompactionPolicy,
	type CompactionPlan,
} from "./compaction.js";
import type { SummaryStreamer } from "./compaction-summary.js";

/** What a compaction did, for the event log and `/stats`. */
export interface CompactionResult {
	/** Why it ran: the trigger, or the in-place tool-result pruning that preceded it. */
	reason: "trigger" | "tool-result";
	droppedMessages: number;
	keptMessages: number;
	/** Estimated tokens before and after. */
	before: number;
	after: number;
	toolResultsPruned: number;
	durationMs: number;
}

export interface ContextCompactorOptions {
	policy: CompactionPolicy;
	/** Summarizes a plan; injected so tests (and a future local model) can replace it. */
	summarize?: SummaryStreamer;
	/** Where a skipped or failed compaction is reported. */
	log?: (message: string) => void;
	/** Called after a successful rewrite, once per run. */
	onCompact?: (result: CompactionResult) => void;
}

export interface ContextCompactor {
	/**
	 * Rewrites the transcript for the request that is about to be made. Returns
	 * the input unchanged when nothing is due, when this run already compacted,
	 * or when summarizing failed.
	 */
	apply(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]>;
	/** Starts a new run: the once-per-run budget resets. */
	beginRun(): void;
	/** Forgets history (a `/new` in the same process). */
	reset(): void;
	/** The last compaction, for `/stats`. */
	last(): CompactionResult | undefined;
	readonly policy: CompactionPolicy;
}

export function createContextCompactor(options: ContextCompactorOptions): ContextCompactor {
	const { policy } = options;
	const summarize = options.summarize;
	let compactedThisRun = false;
	let lastResult: CompactionResult | undefined;
	/** The run's first rewritten prefix, reused until the run ends. */
	let carried: AgentMessage[] | undefined;
	let carriedOriginalLength = 0;

	const apply = async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
		if (!policy.enabled) return messages;

		let current = messages;
		// Cheap pass first: an over-long tool result is shortened on sight, without
		// an LLM call. It is also the pass that most often makes compaction itself
		// unnecessary, so it runs before the trigger is even measured.
		const prune = pruneToolResults(current, policy);
		if (prune.pruned > 0) {
			current = prune.messages;
			options.log?.(`compaction: shortened ${prune.pruned} tool result(s), ${prune.savedChars.toLocaleString("en-US")} characters`);
		}

		if (compactedThisRun) {
			// Same run, next request: reuse the prefix the run already rewrote and
			// keep whatever arrived since. Re-summarizing here would pay twice for
			// the same history.
			if (carried !== undefined && messages.length >= carriedOriginalLength) {
				return [...carried, ...messages.slice(carriedOriginalLength)];
			}
			return current;
		}

		const before = estimateContextTokens(current);
		if (before < policy.triggerTokens) return current;

		const plan: CompactionPlan | undefined = planCompaction(current, policy, before);
		if (plan === undefined) {
			options.log?.(`compaction: ${before} tokens is over the trigger but the transcript cannot be split safely`);
			return current;
		}

		if (summarize === undefined) {
			options.log?.(`compaction: ${before} tokens is over the trigger but no summarizer is configured`);
			return current;
		}

		const started = Date.now();
		try {
			const summary = await summarize({
				messages: plan.summarize,
				...(plan.previousSummary !== undefined ? { previousSummary: plan.previousSummary } : {}),
				maxTokens: policy.summaryTokens,
				...(signal !== undefined ? { signal } : {}),
			});
			if (summary.trim() === "") throw new Error("the summarizer returned nothing");
			compactedThisRun = true;
			const next = applyCompaction(plan, summary);
			carried = next;
			carriedOriginalLength = messages.length;
			const result: CompactionResult = {
				reason: prune.pruned > 0 ? "tool-result" : "trigger",
				droppedMessages: plan.summarize.length,
				keptMessages: plan.keep.length,
				before,
				// What the next request will actually carry: measured, not trusted
				// from the surviving messages' stale usage numbers.
				after: next.reduce((total, message) => total + estimateMessageTokens(message), 0),
				toolResultsPruned: prune.pruned,
				durationMs: Date.now() - started,
			};
			lastResult = result;
			options.log?.(
				`compaction: summarized ${result.droppedMessages} message(s) into ${estimateContextTokens([next[0]!])} tokens ` +
					`(${result.before} → ${result.after}) in ${result.durationMs}ms`,
			);
			options.onCompact?.(result);
			return next;
		} catch (error) {
			// Advisory, never fatal: the turn proceeds with the transcript as it is
			// and fails the way it did before compaction existed — with the
			// provider's own context-length error.
			options.log?.(`compaction: skipped, ${error instanceof Error ? error.message : String(error)}`);
			return current;
		}
	};

	return {
		apply,
		policy,
		beginRun: () => {
			compactedThisRun = false;
			carried = undefined;
			carriedOriginalLength = 0;
		},
		reset: () => {
			compactedThisRun = false;
			carried = undefined;
			carriedOriginalLength = 0;
		},
		last: () => lastResult,
	};
}
