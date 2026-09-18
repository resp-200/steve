import type { ContentBlock, ToolCallLocation } from "@agentclientprotocol/sdk";
import type { PromptImage } from "../../features/events.js";

/**
 * Flattens ACP prompt content blocks into the single text prompt that pi takes.
 * Images are extracted separately (see {@link blocksToImages}).
 */
export function blocksToText(blocks: ContentBlock[]): string {
	const parts: string[] = [];

	for (const block of blocks) {
		switch (block.type) {
			case "text":
				parts.push(block.text);
				break;

			case "resource_link":
				parts.push(`[resource] ${block.name} <${block.uri}>${block.mimeType ? ` (${block.mimeType})` : ""}`);
				break;

			case "resource": {
				const resource = block.resource;
				if ("text" in resource) {
					parts.push(`[resource ${resource.uri}]\n${resource.text}`);
				} else {
					parts.push(`[binary resource ${resource.uri} (${resource.mimeType ?? "application/octet-stream"})]`);
				}
				break;
			}

			case "image":
				parts.push(`[image attached: ${block.mimeType}]`);
				break;

			case "audio":
				parts.push(`[audio attached: ${block.mimeType}]`);
				break;
		}
	}

	return parts.join("\n\n").trim();
}

/** ACP image blocks, in the provider-neutral shape the runtime takes. */
export function blocksToImages(blocks: ContentBlock[]): PromptImage[] {
	return blocks
		.filter((block): block is Extract<ContentBlock, { type: "image" }> => block.type === "image")
		.map((block) => ({ mimeType: block.mimeType, data: block.data }));
}

export function textBlock(text: string): ContentBlock {
	return { type: "text", text };
}

/** File paths a tool call touches, for the client's "follow along" UI. */
export function locationsFromArgs(args: unknown): ToolCallLocation[] | undefined {
	if (!args || typeof args !== "object") return undefined;
	const path = (args as { path?: unknown }).path;
	return typeof path === "string" && path.length > 0 ? [{ path }] : undefined;
}


export function truncate(text: string, max = 4_000): string {
	return text.length > max ? `${text.slice(0, max)}… (+${text.length - max} chars)` : text;
}
