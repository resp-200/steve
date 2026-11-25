/**
 * Normalisation: pi's kernel events and messages become the front-end-neutral
 * vocabulary in `events.ts` (`AgentRuntimeEvent`, `TranscriptEntry`).
 *
 * The kernel's own event union is described structurally here, so this module
 * never imports pi: the runtime passes its live events in, and only this file
 * knows what shape they have.
 */
import type { AgentMessage } from "./contract.js";
import type { AgentRuntimeEvent, PromptImage, TranscriptEntry } from "./events.js";

/**
 * The subset of a kernel event this layer understands. Fields the runtime
 * ignores (message_start / message_end / agent_start / agent_end) are not listed.
 */
export interface KernelEvent {
	type: string;
	assistantMessageEvent?: { type: string; delta?: string };
	toolCallId?: string;
	toolName?: string;
	args?: unknown;
	partialResult?: unknown;
	result?: unknown;
	isError?: boolean;
}

/** Reads the text out of a pi tool result (those shapes stop here). */
export function firstText(result: unknown): string | undefined {
	const content = (result as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") return text;
		}
	}
	return undefined;
}

/** Image blocks a tool returned (read_file on a screenshot, for instance). */
function resultImages(result: unknown): PromptImage[] {
	const content = (result as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return [];

	return content
		.filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "image")
		.map((block) => ({
			mimeType: String((block as { mimeType?: unknown }).mimeType ?? "application/octet-stream"),
			data: String((block as { data?: unknown }).data ?? ""),
		}))
		.filter((image) => image.data.length > 0);
}

/** pi messages -> provider-neutral transcript entries (for replaying history). */
export function toTranscript(messages: AgentMessage[]): TranscriptEntry[] {
	const entries: TranscriptEntry[] = [];

	for (const message of messages) {
		if (message.role === "user") {
			// User content is either a plain string or content blocks (fold and pi
			// both produce strings for text-only input, so both forms must replay).
			const blocks = Array.isArray(message.content) ? message.content : [];
			entries.push({
				role: "user",
				text:
					typeof message.content === "string"
						? message.content
						: blocks
								.filter((block) => block.type === "text")
								.map((block) => (block as { text?: string }).text ?? "")
								.join("\n"),
				images: blocks.filter((block) => block.type === "image").length,
			});
			continue;
		}

		if (message.role === "assistant") {
			const blocks = Array.isArray(message.content) ? message.content : [];
			entries.push({
				role: "assistant",
				thinking: blocks
					.filter((block) => block.type === "thinking")
					.map((block) => (block as { thinking?: string }).thinking ?? "")
					.join(""),
				text: blocks
					.filter((block) => block.type === "text")
					.map((block) => (block as { text?: string }).text ?? "")
					.join(""),
				toolCalls: blocks
					.filter((block) => block.type === "toolCall")
					.map((block) => {
						const call = block as { id?: string; name?: string; arguments?: unknown };
						return { id: call.id ?? "", name: call.name ?? "", args: call.arguments ?? {} };
					}),
			});
			continue;
		}

		if (message.role === "toolResult") {
			entries.push({
				role: "tool",
				toolCallId: message.toolCallId,
				name: message.toolName,
				isError: message.isError === true,
				text: firstText(message) ?? "",
			});
		}
	}

	return entries;
}

/** pi's event stream, translated into the vocabulary the layers above speak. */
export function normalizeKernelEvent(event: KernelEvent): AgentRuntimeEvent | undefined {
	switch (event.type) {
		case "turn_start":
			return { type: "turn_start" };

		case "message_update": {
			const inner = event.assistantMessageEvent;
			if (!inner) return undefined;
			if (inner.type === "text_delta" && (inner.delta ?? "").length > 0) return { type: "text_delta", text: inner.delta ?? "" };
			if (inner.type === "thinking_delta" && (inner.delta ?? "").length > 0) {
				return { type: "thinking_delta", text: inner.delta ?? "" };
			}
			return undefined;
		}

		case "tool_execution_start":
			return { type: "tool_start", id: event.toolCallId ?? "", name: event.toolName ?? "", args: event.args };

		case "tool_execution_update": {
			const text = firstText(event.partialResult);
			return text === undefined ? undefined : { type: "tool_update", id: event.toolCallId ?? "", name: event.toolName ?? "", text };
		}

		case "tool_execution_end": {
			const details = (event.result as { details?: unknown } | undefined)?.details;
			const images = resultImages(event.result);
			const text =
				firstText(event.result) ??
				(images.length > 0
					? `[${images.length} image(s) returned]`
					: event.isError
						? "Tool failed without a message"
						: "Tool finished without output");
			return {
				type: "tool_end",
				id: event.toolCallId ?? "",
				name: event.toolName ?? "",
				isError: event.isError === true,
				text,
				...(details !== undefined ? { details } : {}),
				...(images.length > 0 ? { images } : {}),
			};
		}

		default:
			return undefined;
	}
}
