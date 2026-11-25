/**
 * Run worker: turns "a stream + an input event" into "run lifecycle events on
 * the same stream" (§5.2).
 *
 * The worker keeps no agent between runs: every run builds a fresh one from the
 * transcript folded out of the log, so a run is reproducible from events alone.
 * Failures that can be rolled back are retried by {@link runTurn}; the retry
 * drops the failed assistant turn in memory, and the log never received it, so
 * the fold after a retry equals the old `messages.slice(0, before)` rollback.
 */
import { randomUUID } from "node:crypto";
import type { AgentMessage, AgentTool } from "./contract.js";
import { createKernelAgent, type KernelHooks } from "../kernel/agent.js";
import type { AppConfig } from "../model/config.js";
import type { ExtensionHost } from "../extensions/host.js";
import type {
	AgentRuntimeEvent,
	PromptImage,
	RunMode,
	RunOutcome,
	StreamEventBody,
	TurnStopReason,
	TurnUsage,
} from "./events.js";
import type { EnvironmentSnapshot } from "./environment.js";
import { normalizeKernelEvent } from "./normalize.js";
import { runTurn, type PromptOptions, type TurnDriver } from "./retry.js";
import { isStreamId, type StreamEventInput, type StreamLog } from "./stream-log.js";
import type { Logger } from "../types.js";

/** The input that starts a run; appended to the stream before `run.started`. */
export interface RunInput {
	text: string;
	images?: PromptImage[];
}

export interface SubmitResult {
	runId: string;
	accepted: boolean;
	/** Set when the run will not start immediately: `queued` or `superseded`. */
	reason?: string;
}

/** A run currently executing (or waiting for its slot) inside the worker. */
export interface ActiveRun {
	streamId: string;
	runId: string;
	mode: RunMode;
	startedAt: number;
}

/**
 * The agent a run needs, reduced to what the worker uses. Structural on
 * purpose: the feature layer must not import pi, and tests plug a fake in.
 */
export interface WorkerAgent {
	messages(): AgentMessage[];
	setMessages(messages: AgentMessage[]): void;
	/** Continue the seeded transcript: the input user message is already in it. */
	proceed(): Promise<void>;
	subscribe(listener: (event: unknown) => void): () => void;
	abort(): void;
}

export interface RunAgentContext {
	streamId: string;
	runId: string;
	mode: RunMode;
	environment: EnvironmentSnapshot;
	messages: AgentMessage[];
	tools: AgentTool<any>[];
	config: AppConfig;
}

export interface RunWorkerOptions {
	config: AppConfig;
	extensions?: ExtensionHost;
	log: StreamLog;
	/** Whatever the stream says the transcript is, input message included. */
	readState(streamId: string): Promise<AgentMessage[]>;
	resolveEnvironment(streamId: string, mode: RunMode): Promise<EnvironmentSnapshot>;
	/** Tool catalog of this process; runs only get the ones their snapshot allows. */
	tools?: readonly AgentTool<any>[];
	systemPrompt?: string;
	/** Kernel hooks the host assembles (extension gate, permissions, context). */
	hooks?: KernelHooks;
	retries?: number;
	retryDelayMs?: (attempt: number) => number;
	maxConcurrent?: number;
	concurrency?: "serial" | "queue" | "parallel";
	logger?: Logger;
	/** Observes normalised turn events as they are appended (live front ends). */
	onEvent?: (event: AgentRuntimeEvent) => void;
	/** Test seam; the default builds a one-shot kernel agent. */
	createAgent?: (context: RunAgentContext) => WorkerAgent;
}

export interface RunWorker {
	submit(streamId: string, input: RunInput, mode?: RunMode): Promise<SubmitResult>;
	cancel(streamId: string, runId: string): Promise<void>;
	/** Waits until every running and queued run settled. */
	drain(): Promise<void>;
	active(): ActiveRun[];
}

interface QueuedRun {
	streamId: string;
	runId: string;
	input: RunInput;
	mode: RunMode;
	inputCause: number;
}

interface Running {
	streamId: string;
	runId: string;
	mode: RunMode;
	startedAt: number;
	agent?: WorkerAgent;
	cancelRequested: boolean;
	settled: Promise<void>;
	markSettled: () => void;
}

const DEFAULT_RETRIES = 2;

function isAgentMessage(value: unknown): value is AgentMessage {
	if (typeof value !== "object" || value === null) return false;
	const role = (value as { role?: unknown }).role;
	return role === "user" || role === "assistant" || role === "toolResult";
}

/** The final assistant of a turn, only when it is worth keeping (§4.3). */
function settledAssistant(runId: string, message: unknown): StreamEventBody | undefined {
	if (!isAgentMessage(message) || message.role !== "assistant") return undefined;
	if (message.content.length === 0 && (message.stopReason === "error" || message.stopReason === "aborted")) return undefined;
	return { type: "run.turn.settled", runId, message };
}

function describeFailure(result: { failed: boolean; errorMessage?: string }): string {
	return result.errorMessage ?? "run failed";
}

function imageBlocks(images: PromptImage[] | undefined): PromptImage[] | undefined {
	return images && images.length > 0 ? images : undefined;
}

export function createRunWorker(options: RunWorkerOptions): RunWorker {
	const logger: Logger = options.logger ?? (() => {});
	const concurrency = options.concurrency ?? "serial";
	const maxConcurrent = Math.max(1, options.maxConcurrent ?? 1);
	const running = new Map<string, Running>();
	const queue: QueuedRun[] = [];

	const emitEvent = (event: AgentRuntimeEvent): void => {
		try {
			options.extensions?.dispatch(event);
		} catch (error) {
			logger(`extension event handler failed: ${String(error)}`);
		}
		try {
			options.onEvent?.(event);
		} catch (error) {
			logger(`event listener failed: ${String(error)}`);
		}
	};

	const append = async (streamId: string, events: StreamEventInput[]): Promise<void> => {
		try {
			await options.log.append(streamId, events);
		} catch (error) {
			logger(`could not append to stream ${streamId}: ${String(error)}`);
		}
	};

	/** Tools the run may use: named by the snapshot, narrowed for background runs. */
	const selectTools = (environment: EnvironmentSnapshot, mode: RunMode): AgentTool<any>[] => {
		const allowed = new Set(
			environment.tools
				.filter((tool) => mode === "foreground" || tool.permissionRequired === false)
				.map((tool) => tool.name),
		);
		return (options.tools ?? []).filter((tool) => allowed.has(tool.name));
	};

	const defaultAgent = (context: RunAgentContext): WorkerAgent => {
		const agent = createKernelAgent({
			config: options.config,
			tools: context.tools,
			...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
			...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
		});
		agent.state.messages = [...context.messages];
		return {
			messages: () => agent.state.messages,
			setMessages: (messages) => {
				agent.state.messages = [...messages];
			},
			proceed: () => agent.continue(),
			subscribe: (listener) => agent.subscribe((event) => listener(event)),
			abort: () => agent.abort(),
		};
	};

	const runOne = async (run: Running, input: RunInput, inputCause: number): Promise<void> => {
		const { streamId, runId, mode } = run;
		let unsubscribe: (() => void) | undefined;
		try {
			const environment = await options.resolveEnvironment(streamId, mode);
			await options.log.append(streamId, [{ type: "run.started", runId, inputCause, environment, mode }]);
			const messages = await options.readState(streamId);
			const tools = selectTools(environment, mode);
			const agent = (options.createAgent ?? defaultAgent)({
				streamId,
				runId,
				mode,
				environment,
				messages,
				tools,
				config: options.config,
			});
			run.agent = agent;

			// Lifecycle events are appended as they happen; assistant messages only
			// settle once pi finished them, which keeps "assistant before tool result".
			unsubscribe = agent.subscribe(async (raw) => {
				const event = raw as { type?: unknown; message?: unknown };
				if (event.type === "message_end") {
					const settled = settledAssistant(runId, event.message);
					if (settled) await append(streamId, [settled]);
					return;
				}
				const normalized = normalizeKernelEvent(raw as Parameters<typeof normalizeKernelEvent>[0]);
				if (!normalized) return;
				emitEvent(normalized);
				await append(streamId, [normalized]);
			});

			const driver: TurnDriver = {
				messages: () => agent.messages(),
				setMessages: (next) => agent.setMessages(next),
				prompt: () => agent.proceed(),
				abort: () => agent.abort(),
			};
			const promptOptions: PromptOptions = {
				...(options.retries !== undefined ? { retries: options.retries } : {}),
				...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
				onRetry: (reason) => {
					void append(streamId, [{ type: "run.failed", runId, error: reason, retryable: true }]);
				},
			};
			const result = await runTurn(driver, input.text, promptOptions, options.retries ?? DEFAULT_RETRIES);
			unsubscribe();
			unsubscribe = undefined;

			await append(streamId, [
				{
					type: "turn_end",
					stopReason: result.stopReason as TurnStopReason,
					usage: result.usage as TurnUsage,
					contextTokens: result.contextTokens,
					failed: result.failed,
					...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
					retries: result.retries,
				},
			]);
			if (result.stopReason === "cancelled" || run.cancelRequested) {
				await append(streamId, [{ type: "run.cancelled", runId, reason: run.cancelRequested ? "cancelled" : "interrupted" }]);
			} else if (result.failed) {
				await append(streamId, [{ type: "run.failed", runId, error: describeFailure(result), retryable: false }]);
			} else {
				const outcome: RunOutcome = {
					stopReason: result.stopReason as TurnStopReason,
					usage: result.usage as TurnUsage,
					contextTokens: result.contextTokens,
					retries: result.retries,
				};
				await append(streamId, [{ type: "run.settled", runId, outcome }]);
			}
		} catch (error) {
			await append(streamId, [{ type: "run.failed", runId, error: String(error), retryable: false }]);
		} finally {
			unsubscribe?.();
			running.delete(streamId);
			run.markSettled();
			startNext();
		}
	};

	const start = (queued: QueuedRun): void => {
		let markSettled = (): void => {};
		const settled = new Promise<void>((resolve) => {
			markSettled = resolve;
		});
		const run: Running = {
			streamId: queued.streamId,
			runId: queued.runId,
			mode: queued.mode,
			startedAt: Date.now(),
			cancelRequested: false,
			settled,
			markSettled,
		};
		running.set(queued.streamId, run);
		void runOne(run, queued.input, queued.inputCause);
	};

	const startNext = (): void => {
		while (queue.length > 0 && running.size < maxConcurrent) {
			const next = queue.find((item) => !running.has(item.streamId));
			if (!next) return;
			queue.splice(queue.indexOf(next), 1);
			start(next);
		}
	};

	const requestCancel = async (streamId: string, runId: string): Promise<void> => {
		const run = running.get(streamId);
		if (!run || run.runId !== runId) return;
		run.cancelRequested = true;
		await append(streamId, [{ type: "run.cancel_requested", runId, by: "user" }]);
		run.agent?.abort();
	};

	const submit = async (streamId: string, input: RunInput, mode: RunMode = "foreground"): Promise<SubmitResult> => {
		if (!isStreamId(streamId)) return { runId: "", accepted: false, reason: "invalid stream id" };
		const runId = randomUUID();
		const appended = await options.log.append(streamId, [
			{ type: "user.message", text: input.text, ...(imageBlocks(input.images) ? { images: imageBlocks(input.images) } : {}) },
		]);
		const queued: QueuedRun = { streamId, runId, input, mode, inputCause: appended.first };
		const active = running.get(streamId);
		if (active && concurrency === "serial") {
			void requestCancel(streamId, active.runId);
			queue.push(queued);
			return { runId, accepted: true, reason: "superseded" };
		}
		if (active && concurrency === "queue") {
			queue.push(queued);
			return { runId, accepted: true, reason: "queued" };
		}
		if (!active && running.size >= maxConcurrent) {
			queue.push(queued);
			return { runId, accepted: true, reason: "queued" };
		}
		start(queued);
		return { runId, accepted: true };
	};

	const cancel = async (streamId: string, runId: string): Promise<void> => {
		// A queued run never started: drop it and leave a terminal event behind.
		const index = queue.findIndex((item) => item.streamId === streamId && item.runId === runId);
		if (index >= 0) {
			queue.splice(index, 1);
			await append(streamId, [{ type: "run.cancel_requested", runId, by: "user" }]);
			await append(streamId, [{ type: "run.cancelled", runId, reason: "cancelled" }]);
			return;
		}
		await requestCancel(streamId, runId);
	};

	const drain = async (): Promise<void> => {
		while (running.size > 0 || queue.length > 0) {
			const settled = [...running.values()].map((run) => run.settled);
			if (settled.length === 0) {
				startNext();
				await Promise.resolve();
				continue;
			}
			await Promise.race(settled);
		}
	};

	return {
		submit,
		cancel,
		drain,
		active: () => [...running.values()].map(({ streamId, runId, mode, startedAt }) => ({ streamId, runId, mode, startedAt })),
	};
}
