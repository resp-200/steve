/**
 * Images on the way into a turn (model layer, zero upward dependencies).
 *
 * Three front ends hand us pictures from very different places — Feishu sends a
 * `image_key`, a terminal has a file on disk, an ACP client inlines base64 — and
 * all three must end up as the same `{mimeType, data}` pair the provider
 * understands. The rules that decide "is this picture usable" therefore live
 * here once instead of three times: which formats a provider accepts, and how
 * big a picture may be before it stops being a picture and starts being a
 * context window.
 *
 * Refusing early, with a reason the user can act on, is the whole point. A
 * silently dropped image looks exactly like a model that cannot see.
 */

/** An image, in the provider-neutral shape every layer already speaks. */
export interface ImageInput {
	mimeType: string;
	/** Base64 payload, no data-URL prefix. */
	data: string;
}

/**
 * 10 MB as decoded bytes. Big enough for phone photos and full-screen
 * screenshots, small enough that one picture cannot eat a whole context window
 * before the provider even sees it.
 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Formats the vision models behind these gateways accept. HEIC is deliberately
 * absent: it is what iPhones produce, but neither Anthropic nor the common
 * OpenAI-compatible gateways decode it, so it must be converted rather than
 * forwarded and rejected mid-turn.
 */
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Extensions a terminal user may drop in, mapped to the MIME type providers want. */
const EXTENSION_MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

/** Longest accepted MIME type, before the media-type table is even consulted. */
const MAX_MIME_TYPE_CHARS = 64;

export function imageMimeTypeForPath(path: string): string | undefined {
	const match = /\.[^./\\]+$/.exec(path);
	return match === null ? undefined : EXTENSION_MIME_TYPES[match[0].toLowerCase()];
}

/** True when the provider's model accepts pictures at all. */
export function modelSupportsImages(input: readonly string[] | undefined): boolean {
	return input?.includes("image") ?? false;
}

/** Decoded size of a base64 payload, without decoding it. */
export function base64Bytes(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** Bytes as a human would say it, for messages that a person reads. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Checks one incoming image and returns it normalised, or the reason it cannot
 * be used. Callers turn the reason into their own kind of message: the CLI
 * prints it, Feishu replies with it, ACP raises it.
 */
export function checkImage(input: { mimeType: string; data: string; label?: string }): { ok: true; image: ImageInput } | { ok: false; reason: string } {
	const label = input.label === undefined || input.label === "" ? "这张图片" : input.label;
	const mimeType = input.mimeType.trim().toLowerCase().split(";")[0]?.trim() ?? "";
	if (mimeType === "" || mimeType.length > MAX_MIME_TYPE_CHARS) return { ok: false, reason: `${label}的格式无法识别。` };
	if (!IMAGE_MIME_TYPES.has(mimeType)) {
		return { ok: false, reason: `${label}是 ${mimeType} 格式，只支持 PNG、JPEG、GIF、WebP。请转换后再发。` };
	}
	const data = input.data.trim();
	if (data === "") return { ok: false, reason: `${label}是空的（没有图片内容）。` };
	const bytes = base64Bytes(data);
	if (bytes > MAX_IMAGE_BYTES) {
		return { ok: false, reason: `${label}有 ${formatBytes(bytes)}，超过 ${formatBytes(MAX_IMAGE_BYTES)} 的上限。请压缩后再发。` };
	}
	return { ok: true, image: { mimeType, data } };
}

/**
 * Checks a batch from one message. One bad picture refuses the whole batch:
 * sending the others alone would let the model answer about half a question
 * while the user believes it saw everything.
 */
export function checkImages(inputs: readonly { mimeType: string; data: string; label?: string }[]): { ok: true; images: ImageInput[] } | { ok: false; reason: string } {
	const images: ImageInput[] = [];
	for (const [index, input] of inputs.entries()) {
		const checked = checkImage({ ...input, label: input.label ?? (inputs.length > 1 ? `第 ${index + 1} 张图片` : undefined) });
		if (!checked.ok) return checked;
		images.push(checked.image);
	}
	return { ok: true, images };
}

/**
 * Words that appear in a provider's refusal when the model cannot take pictures.
 * Gateways word it differently ("image content is not supported", "does not
 * support multimodal", "vision is not enabled"), so the test is on the failure
 * as a whole rather than on one message we happened to see once.
 */
const VISION_REFUSAL = /image|vision|multimodal|image_url|image content/i;

/**
 * Turns a failed run into advice, when the failure is really "this model cannot
 * see pictures".
 *
 * The alternative — forwarding the raw 400 — leaves the user staring at
 * `image_url is not supported` with no idea that a checkbox in the admin page is
 * what fixes it. Anything else is passed through untouched: guessing a cause
 * would be worse than admitting we do not know.
 */
export function explainVisionFailure(error: string | undefined): string | undefined {
	if (error === undefined || error === "") return undefined;
	if (!VISION_REFUSAL.test(error)) return undefined;
	return [
		"这张图没能发给模型：它拒绝了图片输入。",
		"如果该模型其实能看图，请到后台「模型供应商」确认「支持图片」没有被关掉；如果它确实只支持文本，换一个视觉模型即可。",
		`网关原话：${error}`,
	].join("\n");
}
