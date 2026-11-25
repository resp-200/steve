/**
 * Background-run approvals (§5.3 / §9): a run that is not attached to a live
 * human must not silently execute a tool that needs consent. Instead it parks,
 * records `approval.pending`, and waits for an `approval.granted` event from
 * whoever can answer — a CLI prompt, an HTTP endpoint, an ACP client.
 *
 * The gate is structural (it only needs append/read/subscribe), so the same code
 * serves the HTTP front end and tests without dragging the log implementation in.
 */
import type { StreamEvent, StreamEventBody } from "./events.js";
import type { Logger } from "../types.js";

/** The slice of `StreamLog` the gate needs. */
export interface ApprovalLog {
	append(streamId: string, events: readonly (StreamEventBody & { ts?: number; causeId?: number })[]): Promise<{ first: number; last: number; events: StreamEvent[] }>;
	read(streamId: string, fromSeq?: number, limit?: number): Promise<StreamEvent[]>;
	subscribe(streamId: string, fromSeq: number, listener: (event: StreamEvent) => void): () => void;
}

export interface ApprovalRequest {
	toolName: string;
	args?: unknown;
	preview?: unknown;
}

export type ApprovalDecision = "allow_once" | "allow_always" | "deny" | "timeout";

export interface ApprovalOutcome {
	allowed: boolean;
	requestId: string;
	decision: ApprovalDecision;
}

export interface ApprovalGateOptions {
	log: ApprovalLog;
	streamId: string;
	runId: string;
	/** How long a parked run waits before it gives up (default 10 minutes). */
	timeoutMs?: number;
	logger?: Logger;
}

export interface ApprovalGate {
	/** Parks the run until a matching `approval.granted` arrives or the timeout expires. */
	ask(request: ApprovalRequest): Promise<ApprovalOutcome>;
	/** Releases subscriptions and timers (also resolves anything still parked as denied). */
	dispose(): void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

const decisionOf = (value: string): ApprovalDecision => (value === "allow_always" ? "allow_always" : value === "allow_once" ? "allow_once" : "deny");

export function createApprovalGate(options: ApprovalGateOptions): ApprovalGate {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const logger = options.logger ?? (() => {});
	const parked = new Set<{ settle: (outcome: ApprovalOutcome) => void }>();
	const unsubscribers: (() => void)[] = [];
	let counter = 0;
	let disposed = false;

	return {
		async ask(request) {
			counter += 1;
			const requestId = `approval-${options.runId}-${counter}`;
			if (disposed) return { allowed: false, requestId, decision: "deny" };

			const history = await options.log.read(options.streamId, 1);
			const fromSeq = (history.at(-1)?.seq ?? 0) + 1;
			const pending = new Promise<ApprovalOutcome>((resolve) => {
				const entry = { settle: resolve };
				parked.add(entry);
				const finish = (outcome: ApprovalOutcome): void => {
					if (!parked.delete(entry)) return;
					clearTimeout(timer);
					unsubscribe?.();
					resolve(outcome);
				};
				const timer = setTimeout(() => {
					logger(`[approval] ${requestId} timed out after ${timeoutMs}ms`);
					finish({ allowed: false, requestId, decision: "timeout" });
				}, timeoutMs);
				const unsubscribe = options.log.subscribe(options.streamId, fromSeq, (event) => {
					if (event.type !== "approval.granted" || event.requestId !== requestId) return;
					finish({ allowed: decisionOf(event.decision) !== "deny", requestId, decision: decisionOf(event.decision) });
				});
				unsubscribers.push(() => unsubscribe());
			});

			try {
				await options.log.append(options.streamId, [
					{ type: "approval.pending", requestId, runId: options.runId, toolName: request.toolName, args: request.args ?? null, ...(request.preview !== undefined ? { preview: request.preview } : {}) },
				]);
			} catch (error) {
				logger(`[approval] could not record ${requestId}: ${error instanceof Error ? error.message : String(error)}`);
				return { allowed: false, requestId, decision: "deny" };
			}
			return pending;
		},
		dispose() {
			disposed = true;
			for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
			for (const entry of parked) entry.settle({ allowed: false, requestId: "", decision: "deny" });
			parked.clear();
		},
	};
}
