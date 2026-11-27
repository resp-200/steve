/**
 * The single exit from events to state (`docs/personal-agent.md` §4.3).
 *
 * Pure functions only: no IO, no globals — the same events always fold to the
 * same transcript, which is what makes replay, fork and retry equivalent to the
 * in-memory session the old runtime kept.
 *
 * S5 makes this the only state path: a worker folds once before each run and
 * never mutates its transcript incrementally, and `AgentRuntime.snapshot()` is
 * kept only as the compatibility seam the old on-disk format needs. The fold is
 * total over the event vocabulary — unknown or truncated events are ignored, so
 * a newer log still opens in an older process.
 */
import type { AgentMessage } from "./contract.js";
import type { PromptImage, RunMode, StreamEvent, TurnUsage } from "./events.js";

/** A read-only projection of a stream, for status endpoints and UIs. */
export interface StreamStatus {
	streamId: string;
	createdAt: number;
	updatedAt: number;
	lastSeq: number;
	activeRun: { runId: string; startedAt: number; mode: RunMode } | null;
	/** Cumulative usage over all settled turns. */
	usage: TurnUsage;
	/** Completed model turns (one per `run.turn.settled`), like `/stats.turns`. */
	turnCount: number;
	toolCallCount: number;
	/** Input events waiting for a run. */
	queued: number;
}

const EMPTY_USAGE: TurnUsage = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Usage carried on an `AssistantMessage`, mapped onto our wire shape. */
function usageOf(message: unknown): TurnUsage {
	const raw = isObject(message) && isObject(message.usage) ? message.usage : {};
	const number = (key: string): number => {
		const value = raw[key];
		return typeof value === "number" ? value : 0;
	};
	const input = number("input");
	const output = number("output");
	const cacheRead = number("cacheRead");
	const cacheWrite = number("cacheWrite");
	const reasoning = number("reasoning");
	const total = typeof raw.totalTokens === "number" ? raw.totalTokens : input + output;
	return { input, output, total, cacheRead, cacheWrite, reasoning };
}

const addUsage = (total: TurnUsage, usage: TurnUsage): TurnUsage => ({
	input: total.input + usage.input,
	output: total.output + usage.output,
	total: total.total + usage.total,
	cacheRead: total.cacheRead + usage.cacheRead,
	cacheWrite: total.cacheWrite + usage.cacheWrite,
	reasoning: total.reasoning + usage.reasoning,
});

/**
 * Images arrive either inline (a small picture written before blob storage
 * existed) or as a `blob:<sha>` reference. Resolving is the caller's job — the
 * fold is pure — so an unresolved reference simply drops out of the transcript
 * rather than becoming a block with no data.
 */
type StoredImage = PromptImage | { ref: string; mimeType: string };

function resolveImages(images: readonly StoredImage[] | undefined, read: BlobReader | undefined): PromptImage[] {
	if (images === undefined || images.length === 0) return [];
	const resolved: PromptImage[] = [];
	for (const image of images) {
		const inline = (image as { data?: unknown }).data;
		if (typeof inline === "string") {
			resolved.push({ mimeType: image.mimeType, data: inline });
			continue;
		}
		const reference = (image as { ref?: unknown }).ref;
		const found = typeof reference === "string" ? read?.(reference) : undefined;
		if (found !== undefined) resolved.push(found);
	}
	return resolved;
}

/** Resolves a `blob:<sha>` reference to its payload. */
export type BlobReader = (reference: string) => { data: string; mimeType: string } | undefined;

/** Rebuilds user content: plain text when there are no images, blocks otherwise. */
function userContent(text: string, images: readonly StoredImage[] | undefined, read: BlobReader | undefined): string | unknown[] {
	const pictures = resolveImages(images, read);
	if (pictures.length === 0) return text;
	const blocks: unknown[] = [];
	if (text !== "") blocks.push({ type: "text", text });
	for (const image of pictures) blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
	return blocks;
}

/** Tool results always use block content, matching pi's `ToolResultMessage`. */
function toolContent(text: string, images: readonly PromptImage[] | undefined): unknown[] {
	const blocks: unknown[] = [];
	if (text !== "") blocks.push({ type: "text", text });
	if (images !== undefined) {
		for (const image of images) blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
	}
	return blocks;
}

function isAgentMessage(value: unknown): value is AgentMessage {
	return isObject(value) && typeof value.role === "string";
}

/**
 * Events → model context. Only messages that the model actually saw produce a
 * message: streaming deltas are rendering detail, and a failed turn that never
 * ran a tool leaves no trace (the old `messages.slice(0, before)` rollback).
 *
 * `truncated` means the event was too big to store and lost detail — it does
 * not mean the message is up for debate. A user message is the backbone of the
 * conversation: dropping it leaves an assistant turn ending the transcript, and
 * the next run cannot continue from there. So truncation clips payloads, and
 * the message itself always survives.
 */
export function foldTranscript(events: readonly StreamEvent[], read?: BlobReader): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const event of events) {
		switch (event.type) {
			case "user.message": {
				messages.push({
					role: "user",
					content: userContent(event.text ?? "", event.images as readonly StoredImage[] | undefined, read),
					timestamp: event.ts,
				} as AgentMessage);
				break;
			}
			case "run.turn.settled": {
				if (isAgentMessage(event.message)) messages.push(event.message);
				break;
			}
			case "tool_end": {
				messages.push({
					role: "toolResult",
					toolCallId: event.id,
					toolName: event.name,
					content: toolContent(event.text ?? "", resolveImages(event.images as readonly StoredImage[] | undefined, read)),
					...(event.details !== undefined ? { details: event.details } : {}),
					isError: event.isError,
					timestamp: event.ts,
				} as AgentMessage);
				break;
			}
			default:
				break;
		}
	}
	return messages;
}

/** Events → read-only status (no messages, safe to send over a wire). */
export function foldStatus(events: readonly StreamEvent[]): StreamStatus | undefined {
	const first = events[0];
	if (first === undefined) return undefined;

	const streamId = first.streamId;
	let createdAt = first.ts;
	let updatedAt = first.ts;
	let lastSeq = first.seq;
	let usage = EMPTY_USAGE;
	let turnCount = 0;
	let toolCallCount = 0;
	let queued = 0;
	let activeRun: StreamStatus["activeRun"] = null;

	for (const event of events) {
		updatedAt = event.ts;
		if (event.seq > lastSeq) lastSeq = event.seq;
		switch (event.type) {
			case "user.message": {
				if (activeRun !== null) queued += 1;
				break;
			}
			case "run.started": {
				activeRun = { runId: event.runId, startedAt: event.ts, mode: event.mode };
				queued = 0;
				break;
			}
			case "run.settled":
			case "run.failed":
			case "run.cancelled": {
				activeRun = null;
				break;
			}
			case "run.turn.settled": {
				// One completed model turn: this is what `/stats.turns` counts, and
				// the assistant message is the only place usage survives a retry.
				turnCount += 1;
				usage = addUsage(usage, usageOf(event.message));
				break;
			}
			case "tool_end": {
				toolCallCount += 1;
				break;
			}
			case "stream.created": {
				createdAt = event.ts;
				break;
			}
			default:
				break;
		}
	}

	return {
		streamId,
		createdAt,
		updatedAt,
		lastSeq,
		activeRun,
		usage,
		turnCount,
		toolCallCount,
		queued,
	};
}

/**
 * Truncates a stream at `atSeq` (inclusive) and re-sequences the kept events
 * into a new stream id — a fork is just "the same history under a new name".
 */
export function forkEvents(events: readonly StreamEvent[], atSeq: number, newStreamId: string): StreamEvent[] {
	const kept = events.filter((event) => event.seq <= atSeq);
	return kept.map((event, index) => ({ ...event, seq: index + 1, streamId: newStreamId }));
}
