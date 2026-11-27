/**
 * The summary request behind a compaction.
 *
 * It goes through the session's own `StreamFn` — the one `createKernelAgent`
 * built — so the summarizer inherits everything the chat turn has: the same
 * provider, key, auth style, request headers (including the conversation id a
 * gateway may bill against) and token budget. There is no second model
 * configuration to drift.
 *
 * The stream is consumed directly rather than through an `Agent`: a summary is
 * one exchange with no tools, so the agent loop would only add state we would
 * throw away — and constructing a second agent would break the kernel boundary
 * (one construction site) for no benefit.
 */
import type { AgentMessage, StreamContext, StreamFn, StreamModel } from "./contract.js";
import { buildSummaryPrompt, COMPACTION_SYSTEM_PROMPT } from "./compaction.js";

export interface SummaryRequest {
	/** Everything to fold into the summary (a previous compaction already removed). */
	messages: readonly AgentMessage[];
	/** The summary being superseded, for an incremental update. */
	previousSummary?: string;
	/** Output budget for the summary. */
	maxTokens: number;
	signal?: AbortSignal;
}

export type SummaryStreamer = (request: SummaryRequest) => Promise<string>;

/**
 * Turns a stream function into a summary streamer.
 *
 * pi's stream contract never throws: failures are encoded as a final message
 * with `stopReason: "error"`, which is what `createStreamFn` produces for a
 * missing key or an unsupported api. So a failed summary arrives here as a
 * message with no text, and {@link streamedText} turns that into an error.
 */
export function createSummaryStreamer(
	streamFn: StreamFn,
	model: StreamModel,
	/** Provider request headers and other per-call tweaks, same as the agent's. */
	onHeaders?: (headers: Record<string, string>, model: StreamModel) => void,
): SummaryStreamer {
	return async (request) => {
		const messages = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: buildSummaryPrompt(request.messages, request.previousSummary) }],
				timestamp: Date.now(),
			},
		];
		const context: StreamContext = { systemPrompt: COMPACTION_SYSTEM_PROMPT, messages };
		const options: Record<string, unknown> = { maxTokens: request.maxTokens };
		if (onHeaders !== undefined) {
			const headers: Record<string, string> = {};
			onHeaders(headers, model);
			if (Object.keys(headers).length > 0) options.headers = headers;
		}
		if (request.signal !== undefined) options.signal = request.signal;
		const stream = await streamFn(model, context, options);
		return streamedText(stream);
	};
}

/** Consumes an assistant event stream and returns its text, or throws its error. */
export async function streamedText(stream: AsyncIterable<{ type: string; partial?: unknown }>): Promise<string> {
	let text = "";
	let failure: string | undefined;
	for await (const event of stream) {
		if (event.type === "text_delta") {
			const partial = event.partial as { content?: { type?: string; text?: string }[] } | undefined;
			// The protocol does not guarantee the delta string itself; read the
			// accumulated block, so a provider that only updates `partial` still works.
			const accumulated = lastTextBlock(partial);
			if (accumulated !== undefined) text = accumulated;
			const delta = (event as { delta?: string }).delta;
			if (accumulated === undefined && typeof delta === "string") text += delta;
		} else if (event.type === "done") {
			const message = (event as { message?: { content?: { type?: string; text?: string }[] } }).message;
			const done = lastTextBlock(message);
			if (done !== undefined) text = done;
		} else if (event.type === "error") {
			const error = (event as { error?: { errorMessage?: string; stopReason?: string } }).error;
			failure = error?.errorMessage ?? error?.stopReason ?? "the summarizer failed";
		}
	}
	if (text.trim() === "" && failure !== undefined) throw new Error(failure);
	if (text.trim() === "") throw new Error("the summarizer returned no text");
	return text.trim();
}

function lastTextBlock(message: { content?: { type?: string; text?: string }[] } | undefined): string | undefined {
	if (message?.content === undefined) return undefined;
	let text: string | undefined;
	for (const block of message.content) if (block.type === "text") text = block.text ?? "";
	return text;
}
