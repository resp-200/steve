/**
 * Turn retries: a turn that failed before it ran any tool can be rolled back
 * safely, so provider hiccups (429/502 and friends) are retried before a front
 * end ever hears about them.
 *
 * The model turn is described by {@link TurnDriver} instead of a concrete kernel
 * agent, so this stays a policy module: only `runtime.ts` knows the agent.
 */
import type { AgentMessage } from "./contract.js";
import type { PromptImage, TurnStopReason, TurnUsage } from "./events.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The assistant half of pi's message union, without importing pi-ai for a name. */
type AssistantTurn = Extract<AgentMessage, { role: "assistant" }>;

const EMPTY_USAGE: TurnUsage = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

/** pi stop reasons -> our vocabulary (the mapping to a client's is a protocol concern). */
const STOP_REASONS: Record<string, TurnStopReason> = {
	stop: "stop",
	toolUse: "tool_use",
	pending: "stop",
	deferred: "stop",
	length: "length",
	aborted: "cancelled",
	error: "error",
};

export interface PromptOptions {
	images?: PromptImage[];
	signal?: AbortSignal;
	/** Extra attempts after a turn fails without running any tool. Default: 2. */
	retries?: number;
	/** Delay before attempt N (1-based retry index). */
	retryDelayMs?: (attempt: number) => number;
	onRetry?: (reason: string, attempt: number) => void;
}

export interface TurnResult {
	/** True when the turn was still failing after the retries were used up. */
	failed: boolean;
	errorMessage?: string;
	/** Retries that were needed before the turn settled. */
	retries: number;
	stopReason: TurnStopReason;
	/** Usage reported for the final assistant message of the turn. */
	usage: TurnUsage;
	/** Tokens the transcript occupied after this turn. */
	contextTokens: number;
}

/** The kernel agent, reduced to what retrying a turn needs. */
export interface TurnDriver {
	/** The live pi transcript. */
	messages(): AgentMessage[];
	/** Replaces the transcript (used to drop a failed attempt). */
	setMessages(messages: AgentMessage[]): void;
	/** Runs one attempt; images are passed through as they arrived. */
	prompt(text: string, images: PromptImage[]): Promise<void>;
	abort(): void;
}

function toUsage(usage: AssistantTurn["usage"]): TurnUsage {
	return {
		input: usage.input,
		output: usage.output,
		total: usage.totalTokens,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		reasoning: usage.reasoning ?? 0,
	};
}

function summarize(assistant: AssistantTurn | undefined, failure: string | undefined, retriesUsed: number): TurnResult {
	const usage = assistant ? toUsage(assistant.usage) : EMPTY_USAGE;
	return {
		failed: failure !== undefined,
		...(failure !== undefined ? { errorMessage: failure } : {}),
		retries: retriesUsed,
		stopReason: assistant ? (STOP_REASONS[assistant.stopReason] ?? "stop") : "stop",
		usage,
		contextTokens: usage.total,
	};
}

/**
 * Prompts the driver and retries the attempts that can be rolled back.
 *
 * `retries` is the resolved count (the runtime folds in its own default); a
 * cancelled turn is never retried, and neither is one whose tools already ran.
 */
export async function runTurn(
	driver: TurnDriver,
	text: string,
	options: PromptOptions,
	retries: number,
): Promise<TurnResult> {
	const images = options.images ?? [];
	const forwardAbort = (): void => driver.abort();
	options.signal?.addEventListener("abort", forwardAbort, { once: true });

	try {
		for (let tryIndex = 0; ; tryIndex += 1) {
			const before = driver.messages().length;
			await driver.prompt(text, images);

			const appended: AgentMessage[] = driver.messages().slice(before);
			const last = appended.at(-1);
			const assistant = last?.role === "assistant" ? last : undefined;
			const aborted = assistant?.stopReason === "aborted";
			const failure =
				assistant && (aborted || assistant.stopReason === "error")
					? (assistant.errorMessage ?? `request ${assistant.stopReason}`)
					: undefined;
			const toolsRan = appended.some((message) => message.role === "toolResult");

			// Cancelling is intentional, so only provider failures are retried.
			if (failure === undefined || aborted || toolsRan || tryIndex >= retries) {
				return summarize(assistant, failure, tryIndex);
			}

			options.onRetry?.(failure, tryIndex + 1);
			// Drop the failed user/assistant pair so the retry starts from a clean transcript.
			driver.setMessages(driver.messages().slice(0, before));
			await sleep(options.retryDelayMs?.(tryIndex + 1) ?? Math.min(1_000 * 2 ** tryIndex, 8_000));
		}
	} finally {
		options.signal?.removeEventListener("abort", forwardAbort);
	}
}
