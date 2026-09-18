import type { ContentBlock, ToolCallLocation } from "@agentclientprotocol/sdk";
import type { ImageContent } from "@earendil-works/pi-ai";

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

/** pi-ai image content and ACP image content share the same shape. */
export function blocksToImages(blocks: ContentBlock[]): ImageContent[] {
	return blocks
		.filter((block): block is Extract<ContentBlock, { type: "image" }> => block.type === "image")
		.map((block) => ({ type: "image", data: block.data, mimeType: block.mimeType }));
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

export function truncate(text: string, max = 4_000): string {
	return text.length > max ? `${text.slice(0, max)}… (+${text.length - max} chars)` : text;
}
