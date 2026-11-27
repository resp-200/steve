/**
 * Feishu (Lark) bot callback + Open API client for `steve-serve`.
 *
 * The transport only decodes what Feishu sends (URL verification, message
 * receive events, optional AES encryption) and knows how to talk back to the
 * Open API. Mapping a chat to a stream and running the agent stays in the entry,
 * so another chat surface could reuse the same message pipeline.
 *
 * No SDK dependency: callbacks are plain JSON over HTTP and the Open API calls
 * use the global `fetch`. The base URL is configurable so tests can run against
 * a local fake.
 */
import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { toCardV1, type FeishuCard } from "../../model/feishu-card.js";
import { buildPostContent, looksLikeMarkdown, MAX_MESSAGE_CHARS, splitMessage, stripMarkdown } from "../../model/feishu-markdown.js";
import type { Logger } from "../../types.js";

/** Open API base; only overridden in tests. */
export const FEISHU_API_BASE = "https://open.feishu.cn";

export interface FeishuConfig {
	appId: string;
	appSecret: string;
	/**
	 * Event-subscription token. Only used by the HTTP callback transport; the
	 * long-connection transport authenticates the socket with the app credentials
	 * instead, so the token can be absent there.
	 */
	verificationToken?: string;
	/** Enables AES-CBC payload decryption and request signature checks. */
	encryptKey?: string;
	apiBase?: string;
	logger?: Logger;
	/** Injection seam for tests; defaults to the global fetch. */
	fetchImpl?: typeof fetch;
}

export interface FeishuChallenge {
	kind: "challenge";
	challenge: string;
}

export interface FeishuMessage {
	kind: "message";
	eventId: string;
	messageId: string;
	chatId: string;
	chatType: string;
	senderId?: string;
	senderType: string;
	text: string;
	/**
	 * `image_key`s from an image message. Downloading is the client's job: parsing
	 * must stay offline so a callback never waits on a second Feishu round trip.
	 */
	imageKeys?: string[];
	/**
	 * The `message_type` Feishu sent (`image`, `post`, …). Kept because download
	 * failures need it to explain themselves: the same `img_v3_…` key is served
	 * under a different `type` depending on where the picture came from.
	 */
	messageType?: string;
}

export interface FeishuIgnored {
	kind: "ignored";
	reason: string;
}

export type FeishuCallback = FeishuChallenge | FeishuMessage | FeishuIgnored;

export class FeishuError extends Error {
	readonly status: number;
	readonly code: string | number | undefined;

	constructor(status: number, message: string, code?: string | number) {
		super(message);
		this.name = "FeishuError";
		this.status = status;
		this.code = code;
	}
}

type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers, name: string): string | undefined {
	const value = headers[name];
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value[0];
	return undefined;
}

function jsonBody(body: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new FeishuError(400, "callback body is not JSON");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new FeishuError(400, "callback body must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

/** Decrypts the `encrypt` envelope Feishu uses when an encrypt key is configured. */
export function decryptFeishuPayload(encrypted: string, encryptKey: string): string {
	const key = createHash("sha256").update(encryptKey).digest();
	const raw = Buffer.from(encrypted, "base64");
	if (raw.length <= 16) throw new FeishuError(400, "encrypted payload is too short");
	const iv = raw.subarray(0, 16);
	const data = raw.subarray(16);
	try {
		const decipher = createDecipheriv("aes-256-cbc", key, iv);
		return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
	} catch {
		throw new FeishuError(400, "cannot decrypt callback payload");
	}
}

function sameSecret(left: string, right: string): boolean {
	const a = Buffer.from(left, "utf8");
	const b = Buffer.from(right, "utf8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/**
 * Verifies the callback signature. Feishu computes
 * sha256(timestamp + nonce + encryptKey + rawBody) and sends it in
 * `X-Lark-Signature` when encryption is enabled.
 */
export function verifyFeishuSignature(input: { body: string; headers: Headers; encryptKey: string; now?: number; toleranceMs?: number }): void {
	const timestamp = header(input.headers, "x-lark-request-timestamp");
	const nonce = header(input.headers, "x-lark-request-nonce");
	const signature = header(input.headers, "x-lark-signature");
	if (timestamp === undefined || nonce === undefined || signature === undefined) {
		throw new FeishuError(401, "missing Feishu signature headers");
	}
	const seconds = Number(timestamp);
	const now = input.now ?? Date.now();
	if (Number.isFinite(seconds)) {
		const drift = Math.abs(now / 1000 - seconds);
		const tolerance = (input.toleranceMs ?? 5 * 60_000) / 1000;
		if (drift > tolerance) throw new FeishuError(401, "Feishu callback timestamp is out of range");
	}
	const expected = createHash("sha256").update(timestamp + nonce + input.encryptKey + input.body).digest("hex");
	const given = Buffer.from(signature, "utf8");
	const wanted = Buffer.from(expected, "utf8");
	if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
		throw new FeishuError(401, "Feishu callback signature mismatch");
	}
}

/** A chat always maps to the same 12 hex chars, so a stream survives restarts. */
export function streamIdForChat(chatId: string): string {
	return createHash("sha256").update(`feishu:${chatId}`).digest("hex").slice(0, 12);
}

function textFromContent(content: string, mentions: unknown): string {
	let text = "";
	try {
		const parsed: unknown = JSON.parse(content);
		if (parsed !== null && typeof parsed === "object" && typeof (parsed as { text?: unknown }).text === "string") {
			text = (parsed as { text: string }).text;
		}
	} catch {
		return "";
	}
	if (Array.isArray(mentions)) {
		for (const mention of mentions) {
			if (mention !== null && typeof mention === "object" && typeof (mention as { key?: unknown }).key === "string") {
				text = text.split((mention as { key: string }).key).join(" ");
			}
		}
	}
	return text.replace(/[ \t]+/g, " ").trim();
}

/**
 * Rich text (`message_type: "post"`) is what Feishu actually sends for the
 * common cases a user thinks of as "sending a picture": a screenshot with a
 * caption, a pasted or dragged-in image, a forwarded conversation. The content
 * is a two-dimensional array — outer = paragraphs, inner = inline elements like
 * `{"tag":"text","text":"…"}`, `{"tag":"img","image_key":"…"}`, `{"tag":"at",…}`
 * — so it has to be walked, not treated as one string.
 *
 * Returns the paragraphs as text plus the image keys in reading order. A `post`
 * with neither text nor pictures is not a usable turn and the caller ignores it.
 */
function postContent(content: string, mentions: unknown): { text: string; imageKeys: string[] } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return { text: "", imageKeys: [] };
	}
	if (parsed === null || typeof parsed !== "object") return { text: "", imageKeys: [] };
	// The body is either `{"title","content":[[...]]}` or, for localised variants
	// ("post", "post_zh_cn", …), that same object nested under `content`.
	const inner = (parsed as { content?: unknown }).content;
	const body = inner !== null && typeof inner === "object" && !Array.isArray(inner) ? (inner as { content?: unknown }) : (parsed as { content?: unknown });
	const rows = Array.isArray(body.content) ? (body.content as unknown[]) : [];
	const paragraphs: string[] = [];
	const imageKeys: string[] = [];
	for (const row of rows) {
		if (!Array.isArray(row)) continue;
		let line = "";
		for (const element of row) {
			if (element === null || typeof element !== "object") continue;
			const tag = typeof (element as { tag?: unknown }).tag === "string" ? (element as { tag: string }).tag : "";
			if (tag === "text" || tag === "code_block" || tag === "md") {
				if (typeof (element as { text?: unknown }).text === "string") line += (element as { text: string }).text;
				continue;
			}
			if (tag === "a") {
				const label = typeof (element as { text?: unknown }).text === "string" ? (element as { text: string }).text : "";
				const href = typeof (element as { href?: unknown }).href === "string" ? (element as { href: string }).href : "";
				line += href === "" || href === label ? label : `${label} (${href})`;
				continue;
			}
			if (tag === "img") {
				const key = (element as { image_key?: unknown }).image_key;
				if (typeof key === "string" && key !== "") imageKeys.push(key);
				continue;
			}
			if (tag === "media") {
				// A video/file inside rich text: the model cannot see it, so leave a
				// trace in the text instead of pretending the message was only text.
				line += "［附件］";
				continue;
			}
			if (tag === "at") {
				const name = typeof (element as { user_name?: unknown }).user_name === "string" ? (element as { user_name: string }).user_name : "";
				line += name === "" ? "" : `@${name}`;
			}
		}
		paragraphs.push(line);
	}
	let text = paragraphs.join("\n");
	if (Array.isArray(mentions)) {
		for (const mention of mentions) {
			if (mention !== null && typeof mention === "object" && typeof (mention as { key?: unknown }).key === "string") {
				text = text.split((mention as { key: string }).key).join(" ");
			}
		}
	}
	return { text: text.replace(/[ \t]+/g, " ").trim(), imageKeys };
}

/**
 * `image_key`s in an image message. A single image is `{"image_key": "..."}`;
 * a forwarded album arrives as `{"image_key": ["a", "b"]}` on some tenants, so
 * both shapes are read rather than dropping the batch.
 */
function imageKeysFromContent(content: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return [];
	}
	if (parsed === null || typeof parsed !== "object") return [];
	const raw = (parsed as { image_key?: unknown }).image_key;
	const keys = Array.isArray(raw) ? raw : [raw];
	return keys.filter((key): key is string => typeof key === "string" && key !== "");
}

/**
 * Parses one HTTP callback request: URL verification, `im.message.receive_v1`,
 * or an ignored event. Token/signature enforcement happens here; the caller
 * only has to turn the result into a response.
 */
export function parseFeishuCallback(input: { body: string; headers: Headers; config: FeishuConfig }): FeishuCallback {
	const { body, headers, config } = input;
	if (config.encryptKey !== undefined) verifyFeishuSignature({ body, headers, encryptKey: config.encryptKey });
	let payload = jsonBody(body);
	if (typeof payload.encrypt === "string") {
		if (config.encryptKey === undefined) throw new FeishuError(400, "encrypted callback but no encrypt key configured");
		payload = jsonBody(decryptFeishuPayload(payload.encrypt, config.encryptKey));
	}
	const token = typeof payload.token === "string" ? payload.token : undefined;
	if (config.verificationToken !== undefined) {
		if (token !== undefined && !sameSecret(token, config.verificationToken)) {
			throw new FeishuError(401, "Feishu verification token mismatch");
		}
		if (typeof payload.challenge === "string" && token === undefined) {
			throw new FeishuError(401, "Feishu challenge without a token");
		}
		// v2 events carry their token in `header.token`; classifyFeishuPayload checks it.
	}
	if (typeof payload.challenge === "string") return { kind: "challenge", challenge: payload.challenge };
	return classifyFeishuPayload(payload, config.verificationToken);
}

/**
 * Classifies an authenticated v2 event payload. The HTTP transport calls it
 * after signature/token checks; the long-connection transport calls it directly
 * because the socket itself was authenticated with the app credentials.
 */
export function classifyFeishuPayload(payload: Record<string, unknown>, verificationToken?: string): FeishuCallback {
	const event = payload.event;
	const eventHeader = payload.header;
	if (event === null || typeof event !== "object") return { kind: "ignored", reason: "callback has no event" };
	if (eventHeader === null || typeof eventHeader !== "object") return { kind: "ignored", reason: "callback has no header" };
	if (verificationToken !== undefined) {
		const headerToken = typeof (eventHeader as { token?: unknown }).token === "string" ? (eventHeader as { token: string }).token : undefined;
		if (headerToken === undefined || !sameSecret(headerToken, verificationToken)) {
			throw new FeishuError(401, "Feishu verification token mismatch");
		}
	}
	const eventType = typeof (eventHeader as { event_type?: unknown }).event_type === "string" ? (eventHeader as { event_type: string }).event_type : "";
	if (eventType !== "im.message.receive_v1") return { kind: "ignored", reason: `unsupported event ${eventType}` };
	const eventId = typeof (eventHeader as { event_id?: unknown }).event_id === "string" ? (eventHeader as { event_id: string }).event_id : "";
	const message = (event as { message?: unknown }).message;
	if (message === null || typeof message !== "object") return { kind: "ignored", reason: "message event without a message" };
	const typed = message as { message_id?: unknown; chat_id?: unknown; chat_type?: unknown; message_type?: unknown; content?: unknown; mentions?: unknown };
	const sender = (event as { sender?: unknown }).sender;
	const senderType = sender !== null && typeof sender === "object" && typeof (sender as { sender_type?: unknown }).sender_type === "string" ? (sender as { sender_type: string }).sender_type : "unknown";
	const senderId =
		sender !== null && typeof sender === "object" && (sender as { sender_id?: unknown }).sender_id !== null && typeof (sender as { sender_id?: { open_id?: unknown } }).sender_id === "object" && typeof (sender as { sender_id: { open_id?: unknown } }).sender_id.open_id === "string"
			? (sender as { sender_id: { open_id: string } }).sender_id.open_id
			: undefined;
	if (senderType !== "user") return { kind: "ignored", reason: `sender is ${senderType}` };
	const messageType = typeof typed.message_type === "string" ? typed.message_type : "";
	if (messageType !== "text" && messageType !== "image" && messageType !== "post") {
		return { kind: "ignored", reason: `unsupported message type ${String(typed.message_type)}` };
	}
	if (typeof typed.message_id !== "string" || typeof typed.chat_id !== "string" || typeof typed.content !== "string") {
		return { kind: "ignored", reason: "message is missing id, chat or content" };
	}
	const rich = messageType === "post" ? postContent(typed.content, typed.mentions) : undefined;
	const imageKeys = messageType === "image" ? imageKeysFromContent(typed.content) : (rich?.imageKeys ?? []);
	// An image message carries no text of its own; the model gets the pictures and
	// an empty prompt is still a usable turn, so only a text message can be empty.
	const text = messageType === "text" ? textFromContent(typed.content, typed.mentions) : (rich?.text ?? "");
	if (messageType === "image" && imageKeys.length === 0) return { kind: "ignored", reason: "image message has no image_key" };
	if (messageType === "text" && text === "") return { kind: "ignored", reason: "message has no text" };
	if (messageType === "post" && text === "" && imageKeys.length === 0) return { kind: "ignored", reason: "rich text message has no text or image" };
	return {
		kind: "message",
		eventId,
		messageId: typed.message_id,
		chatId: typed.chat_id,
		chatType: typeof typed.chat_type === "string" ? typed.chat_type : "p2p",
		...(senderId !== undefined ? { senderId } : {}),
		senderType,
		text,
		...(imageKeys.length > 0 ? { imageKeys } : {}),
		messageType,
	};
}

export interface FeishuClient {
	/** Tenant token, cached until shortly before it expires. */
	tenantToken(): Promise<string>;
	/** Sends a plain text message to a chat. */
	sendText(chatId: string, text: string): Promise<void>;
	/** Replies in the thread of the incoming message. */
	replyText(messageId: string, text: string): Promise<void>;
	/** Replies in the thread of the incoming message with an interactive card. */
	replyCard(messageId: string, card: unknown): Promise<void>;
	/**
	 * Fetches one `image_key` as base64. The bytes come back without a prefix so
	 * the caller can hand them straight to the model.
	 *
	 * The source message id is required, not decorative: Feishu authorises a
	 * resource download against the message that carries it, so the key alone is
	 * not enough to read it back.
	 */
	downloadImage(imageKey: string, hint: ImageSourceHint): Promise<{ mimeType: string; data: string }>;
}

/**
 * Splits a reply into the messages Feishu will accept.
 *
 * This used to truncate: a long answer lost its tail, which is usually the part
 * worth reading. Chunks now carry `(1/3)` markers so the reader knows they
 * belong together.
 */
function replyChunks(text: string): string[] {
	return splitMessage(text, MAX_MESSAGE_CHARS);
}

/**
 * Sends one already-formatted reply, choosing the message type by content.
 *
 * `text` renders no markdown at all — a table arrives as pipes and dashes, a
 * heading as `## 标题`. So anything with structure goes as a `post` whose `md`
 * element is rendered. When Feishu refuses the post (a construct its renderer
 * rejects), the message is resent as plain text with the syntax stripped:
 * unformatted is better than undelivered.
 */
async function sendReply(
	send: (body: Record<string, unknown>) => Promise<void>,
	text: string,
	log: Logger,
): Promise<void> {
	for (const chunk of replyChunks(text)) {
		if (!looksLikeMarkdown(chunk)) {
			await send({ msg_type: "text", content: JSON.stringify({ text: chunk }) });
			continue;
		}
		const content = JSON.stringify(buildPostContent(chunk));
		try {
			await send({ msg_type: "post", content });
		} catch (error) {
			log(`feishu: post rejected (${error instanceof Error ? error.message : String(error)}); falling back to text`);
			await send({ msg_type: "text", content: JSON.stringify({ text: stripMarkdown(chunk) }) });
		}
	}
}

/**
 * Everything the image resource endpoint needs besides the key itself.
 *
 * `messageId` is what makes the download authorised: Feishu checks that the
 * caller can read that message before handing over the bytes, which is why the
 * `im/v1/images/{key}` endpoint — which takes no message id — answered
 * "Invalid request param" (code 234001) for keys that were perfectly good.
 */
export interface ImageSourceHint {
	/** `message_id` of the message the key came from. */
	messageId: string;
}

/**
 * Feishu truncates a single plain GET of a message resource above roughly 2 MiB
 * with code 234037. Requesting one range first tells us how big the resource is
 * without downloading it: a 206 means the server honours `Range` and the body
 * needs assembling from chunks, a 200 means it ignored the header and already
 * sent everything.
 */
const IMAGE_DOWNLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Reads the image format off the bytes instead of trusting `content-type`.
 * Some Feishu deployments and file-broker hops return the picture with a
 * generic type, and the model needs the real one to decode it.
 */
export function sniffImageMimeType(bytes: Uint8Array): string | undefined {
	const at = (offset: number, ...wanted: number[]): boolean => wanted.every((value, index) => bytes[offset + index] === value);
	if (bytes.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (bytes.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
	if (bytes.length >= 6 && at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
	if (bytes.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
	if (bytes.length >= 2 && at(0, 0x42, 0x4d)) return "image/bmp";
	return undefined;
}

/** Total size from a `Content-Range: bytes 0-0/12345` header; 0 when unusable. */
function contentRangeTotal(header: string | null): number {
	if (header === null) return 0;
	const slash = header.lastIndexOf("/");
	if (slash < 0) return 0;
	const total = Number(header.slice(slash + 1).trim());
	return Number.isFinite(total) && total > 0 ? total : 0;
}

/** Pulls Feishu's `code`/`msg` out of a failed response so the log says why. */
async function describeImageFailure(response: Response): Promise<{ text: string; code?: number }> {
	const detail = (await response.text().catch(() => "")).slice(0, 300).trim();
	if (detail === "") return { text: "" };
	let code: number | undefined;
	let message = "";
	try {
		const parsed = JSON.parse(detail) as { code?: unknown; msg?: unknown };
		if (typeof parsed.code === "number") code = parsed.code;
		if (typeof parsed.msg === "string") message = parsed.msg;
	} catch {
		return { text: `: ${detail}` };
	}
	if (message === "" && code === undefined) return { text: `: ${detail}` };
	return { text: `: ${message !== "" ? message : "error"}（code ${String(code ?? response.status)}）`, ...(code !== undefined ? { code } : {}) };
}

export function createFeishuClient(config: FeishuConfig): FeishuClient {
	const base = config.apiBase ?? FEISHU_API_BASE;
	const doFetch = config.fetchImpl ?? fetch;
	const log = config.logger ?? ((): void => {});
	let cached: { token: string; expiresAt: number } | undefined;
	let pending: Promise<string> | undefined;

	const request = async (path: string, init: RequestInit): Promise<Record<string, unknown>> => {
		let response: Response;
		try {
			response = await doFetch(`${base}${path}`, init);
		} catch (error) {
			throw new FeishuError(502, `cannot reach Feishu: ${error instanceof Error ? error.message : String(error)}`);
		}
		const raw = await response.text();
		let payload: Record<string, unknown>;
		try {
			payload = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
		} catch {
			throw new FeishuError(502, `Feishu returned non-JSON (${response.status}): ${raw.slice(0, 200)}`);
		}
		const code = typeof payload.code === "number" ? payload.code : undefined;
		if (!response.ok || (code !== undefined && code !== 0)) {
			throw new FeishuError(502, `Feishu API ${path} failed: ${String(payload.msg ?? response.statusText)}`, code);
		}
		return payload;
	};

	const tenantToken = async (): Promise<string> => {
		const now = Date.now();
		if (cached !== undefined && cached.expiresAt > now) return cached.token;
		if (pending !== undefined) return await pending;
		pending = (async () => {
			try {
				const payload = await request("/open-apis/auth/v3/tenant_access_token/internal", {
					method: "POST",
					headers: { "Content-Type": "application/json; charset=utf-8" },
					body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
				});
				const token = typeof payload.tenant_access_token === "string" ? payload.tenant_access_token : undefined;
				if (token === undefined) throw new FeishuError(502, "Feishu did not return a tenant access token");
				const expire = typeof payload.expire === "number" && payload.expire > 0 ? payload.expire : 7_200;
				cached = { token, expiresAt: Date.now() + Math.max(60, expire - 120) * 1_000 };
				return token;
			} finally {
				pending = undefined;
			}
		})();
		return await pending;
	};

	const send = async (path: string, body: Record<string, unknown>): Promise<void> => {
		const token = await tenantToken();
		await request(path, {
			method: "POST",
			headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
			body: JSON.stringify(body),
		});
	};

	return {
		tenantToken,
		async sendText(chatId, text) {
			await sendReply(
				(body) => send("/open-apis/im/v1/messages?receive_id_type=chat_id", { receive_id: chatId, ...body }),
				text,
				log,
			);
			log(`feishu: replied to chat ${chatId}`);
		},
		async replyText(messageId, text) {
			await sendReply(
				(body) => send(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, body),
				text,
				log,
			);
			log(`feishu: replied to message ${messageId}`);
		},
		async downloadImage(imageKey, hint) {
			const token = await tenantToken();
			// The resource endpoint is the one that works: it scopes the read to the
			// message carrying the key, which is what Feishu authorises against.
			// `im/v1/images/{key}` takes no message id and answers 234001 for the
			// same keys that download fine here.
			const url = `${base}/open-apis/im/v1/messages/${encodeURIComponent(hint.messageId)}/resources/${encodeURIComponent(imageKey)}?type=image`;
			const fetchRange = async (range?: string): Promise<Response> => {
				try {
					return await doFetch(url, {
						method: "GET",
						headers: { Authorization: `Bearer ${token}`, ...(range === undefined ? {} : { Range: range }) },
					});
				} catch (error) {
					throw new FeishuError(502, `cannot reach Feishu for image ${imageKey}: ${error instanceof Error ? error.message : String(error)}`);
				}
			};
			const fail = async (response: Response, context: string): Promise<never> => {
				const exploded = await describeImageFailure(response);
				// The reply only tells the user it failed; whoever debugs it needs the
				// exact URL and Feishu's own wording to tell "wrong key" from
				// "missing permission".
				log(`feishu: image fetch ${context} -> ${response.status}${exploded.text}`);
				throw new FeishuError(502, `Feishu image ${imageKey} download failed: HTTP ${response.status}${exploded.text}`, exploded.code);
			};

			// One range probe decides how to read the body: 206 means the server
			// honours Range and the resource may exceed Feishu's ~2 MiB single-GET
			// cap (code 234037 past it), 200 means everything already arrived.
			const probe = await fetchRange("bytes=0-0");
			if (!probe.ok) await fail(probe, `${url} (probe)`);
			const total = probe.status === 206 ? contentRangeTotal(probe.headers.get("content-range")) : 0;
			if (probe.status !== 206 || total <= 0) {
				const bytes = Buffer.from(await probe.arrayBuffer());
				return finish(bytes, "single GET", probe);
			}
			await probe.body?.cancel();
			const chunks: Uint8Array[] = [];
			for (let start = 0; start < total; start += IMAGE_DOWNLOAD_CHUNK_BYTES) {
				const end = Math.min(start + IMAGE_DOWNLOAD_CHUNK_BYTES, total) - 1;
				const part = await fetchRange(`bytes=${start}-${end}`);
				if (!part.ok) await fail(part, `${url} (bytes=${start}-${end})`);
				chunks.push(new Uint8Array(await part.arrayBuffer()));
			}
			const bytes = Buffer.concat(chunks);
			if (bytes.length !== total) {
				throw new FeishuError(502, `Feishu image ${imageKey} came back ${bytes.length} of ${total} bytes`);
			}
			return finish(bytes, `chunked in ${chunks.length}`, probe);

			function finish(bytes: Buffer, how: string, last: Response): { mimeType: string; data: string } {
				// Bytes beat headers: Feishu sometimes hands back a generic content type,
				// and the model needs the real format to decode the picture.
				const declared = (last.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
				const mimeType = sniffImageMimeType(bytes) ?? (declared.startsWith("image/") ? declared : "image/png");
				log(`feishu: downloaded image ${imageKey} (${how}, ${mimeType}, ${bytes.length} bytes)`);
				return { mimeType, data: bytes.toString("base64") };
			}
		},
		async replyCard(messageId, card) {
			// Cards are not clamped: the builder caps the body, and truncating JSON
			// would produce a card Feishu cannot parse.
			const path = `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`;
			try {
				await send(path, { msg_type: "interactive", content: JSON.stringify(card) });
			} catch (error) {
				// Card JSON 2.0 is only accepted by tenants on a recent platform. A
				// rejected card used to mean silence, so fall back to the 1.0 shape:
				// the code block loses its highlight, the reply still arrives.
				const v1 = toCardV1(card as FeishuCard);
				if (JSON.stringify(v1) === JSON.stringify(card)) throw error;
				log(`feishu: card 2.0 rejected (${error instanceof Error ? error.message : String(error)}); retrying as card 1.0`);
				await send(path, { msg_type: "interactive", content: JSON.stringify(v1) });
			}
			log(`feishu: replied with a card to message ${messageId}`);
		},
	};
}

/** Reads the bot credentials from the environment; undefined when disabled. */
export function feishuConfigFromEnv(env: NodeJS.ProcessEnv = process.env, logger?: Logger): FeishuConfig | undefined {
	const appId = env.FEISHU_APP_ID?.trim();
	const appSecret = env.FEISHU_APP_SECRET?.trim();
	const verificationToken = env.FEISHU_VERIFICATION_TOKEN?.trim();
	if (appId === undefined || appSecret === undefined) {
		if (appId !== undefined || appSecret !== undefined || verificationToken !== undefined) {
			logger?.("feishu: FEISHU_APP_ID and FEISHU_APP_SECRET must both be set; bot disabled");
		}
		return undefined;
	}
	const encryptKey = env.FEISHU_ENCRYPT_KEY?.trim();
	const apiBase = env.FEISHU_API_BASE?.trim();
	return {
		appId,
		appSecret,
		...(verificationToken !== undefined && verificationToken !== "" ? { verificationToken } : {}),
		...(encryptKey !== undefined && encryptKey !== "" ? { encryptKey } : {}),
		...(apiBase !== undefined && apiBase !== "" ? { apiBase } : {}),
		...(logger !== undefined ? { logger } : {}),
	};
}
