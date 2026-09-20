/**
 * How a tool call is *presented* to an ACP client: the kind of tool, the human
 * title, and the content blocks rendered in the client's tool-call UI.
 *
 * Kept apart from the session state machine so that mapping logic and
 * presentation logic stay separately readable.
 */
import type { ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";
import type { PromptImage } from "../../features/events.js";
import type { ToolChangePreview } from "../../features/permissions.js";
import { truncate } from "./content.js";

/** Fallback table for tools that declare no `metadata` of their own. */
export const TOOL_KINDS: Record<string, ToolKind> = {
	read_file: "read",
	write_file: "edit",
	run_command: "execute",
	calculate: "other",
	get_current_time: "other",
	get_weather: "other",
};

/** Fallback title for tools that declare no `metadata.title`. */
export function describeToolCall(name: string, args: unknown): string {
	const record = (args ?? {}) as Record<string, unknown>;
	const text = (key: string): string | undefined => (typeof record[key] === "string" ? (record[key] as string) : undefined);

	switch (name) {
		case "read_file":
			return `Read ${text("path") ?? "file"}`;
		case "write_file":
			return `Write ${text("path") ?? "file"}`;
		case "run_command": {
			const extra = Array.isArray(record.args) ? (record.args as unknown[]).join(" ") : "";
			return `Run ${text("command") ?? "command"}${extra ? ` ${extra}` : ""}`;
		}
		case "calculate":
			return `Calculate ${text("expression") ?? ""}`.trim();
		case "get_current_time":
			return "Get current time";
		case "get_weather":
			return `Get weather for ${text("city") ?? "city"}`;
		default:
			return name;
	}
}

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
