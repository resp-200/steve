/**
 * How a tool call is *presented* to an ACP client: the kind of tool, the human
 * title, and the content blocks rendered in the client's tool-call UI.
 *
 * Kept apart from the session state machine so that mapping logic and
 * presentation logic stay separately readable.
 */
import type { ToolCallContent } from "@agentclientprotocol/sdk";
import type { PromptImage } from "../../features/events.js";
import type { ToolChangePreview } from "../../features/permissions.js";
import { truncate } from "./content.js";

/** Tool output shown in the client's tool-call UI: text, images, embedded terminal. */
export function toolCallContent(text: string, details: unknown, images: PromptImage[] = []): ToolCallContent[] {
	const content: ToolCallContent[] = [];

	const terminalId = (details as { terminalId?: unknown } | undefined)?.terminalId;
	if (typeof terminalId === "string") content.push({ type: "terminal", terminalId });

	if (text) content.push({ type: "content", content: { type: "text", text: truncate(text) } });
	for (const image of images) {
		content.push({ type: "content", content: { type: "image", data: image.data, mimeType: image.mimeType } });
	}

	return content;
}

/** ACP renders file changes as a real diff when the agent can describe them. */
export function diffContent(preview: ToolChangePreview): ToolCallContent[] {
	if (!preview.file) return [];
	return [
		{
			type: "diff",
			path: preview.file.path,
			oldText: preview.file.oldText ?? null,
			newText: preview.file.newText ?? "",
		},
	];
}
