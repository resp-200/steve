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
import type { Logger } from "../../types.js";

/** Open API base; only overridden in tests. */
export const FEISHU_API_BASE = "https://open.feishu.cn";

/** Feishu caps a single text message well above this; keep replies readable. */
export const MAX_REPLY_CHARS = 4_000;

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
	 */
	downloadImage(imageKey: string, hint?: ImageSourceHint): Promise<{ mimeType: string; data: string }>;
}

function clampReply(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= MAX_REPLY_CHARS) return trimmed;
	return `${trimmed.slice(0, MAX_REPLY_CHARS - 3)}...`;
}

/**
 * `type` values the image resource endpoint accepts, in the order worth trying.
 * `message` is right for a picture a user sent in the chat; `default` covers keys
 * that came from somewhere else (forwarded albums, images inside cards). The
 * endpoint answers 400 "invalid param" for the wrong one, so a single attempt
 * would make some perfectly valid pictures unreadable.
 */
const IMAGE_RESOURCE_TYPES = ["message", "default"] as const;

/**
 * What we know about where an image came from. Feishu serves the same
 * `img_v3_…` key under different `type` values, and which one is valid depends
 * on how the key was created — a `post` image is not the same resource as an
 * `image` message. Passing the message type lets the client try the plausible
 * one first and, when everything fails, say which types it tried.
 */
export interface ImageSourceHint {
	/** `message_type` of the message the key came from. */
	messageType?: string;
}

/**
 * Feishu's "the key or a query parameter did not parse" code. Seeing it for every
 * `type` means the key itself is unusable by this app, not that we picked wrong.
 */
const INVALID_PARAM_CODE = 234_001;

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
			await send("/open-apis/im/v1/messages?receive_id_type=chat_id", {
				receive_id: chatId,
				msg_type: "text",
				content: JSON.stringify({ text: clampReply(text) }),
			});
			log(`feishu: replied to chat ${chatId}`);
		},
		async replyText(messageId, text) {
			await send(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
				msg_type: "text",
				content: JSON.stringify({ text: clampReply(text) }),
			});
			log(`feishu: replied to message ${messageId}`);
		},
		async downloadImage(imageKey, hint) {
			const token = await tenantToken();
			// Feishu serves one `img_v3_…` key under different `type` values and
			// answers 400 "Invalid request param" when the guess is wrong, so the
			// type that matches the message shape is tried first and the other one
			// after it. A key whose *shape* Feishu itself rejects is not worth two
			// round trips: both attempts fail identically (code 234001), which is
			// the signature of a key from another app rather than a wrong type.
			const preferred = hint?.messageType === "post" ? "default" : "message";
			const kinds = [preferred, ...IMAGE_RESOURCE_TYPES.filter((kind) => kind !== preferred)];
			const failures: string[] = [];
			for (const kind of kinds) {
				const url = `${base}/open-apis/im/v1/images/${encodeURIComponent(imageKey)}?type=${kind}`;
				let response: Response;
				try {
					response = await doFetch(url, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
				} catch (error) {
					throw new FeishuError(502, `cannot reach Feishu for image ${imageKey}: ${error instanceof Error ? error.message : String(error)}`);
				}
				if (!response.ok) {
					const exploded = await describeImageFailure(response);
					failures.push(`${kind}: HTTP ${response.status}${exploded.text}`);
					// The reply only tells the user it failed; whoever debugs it needs the
					// exact URL and Feishu's own wording to tell "wrong type" from
					// "wrong key" from "missing permission".
					log(`feishu: image fetch ${url} -> ${response.status}${exploded.text}`);
					// 234001 means Feishu could not parse the key or the query at all: the
					// key is not usable by this app (another tenant's image, an expired
					// one), so the other `type` will fail identically and the second
					// round trip is pure latency.
					if (exploded.code === INVALID_PARAM_CODE) break;
					continue;
				}
				// This endpoint answers with the raw file, not the usual JSON envelope;
				// the content type is how we learn what the model will be shown.
				const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
				const bytes = Buffer.from(await response.arrayBuffer());
				const mimeType = contentType.startsWith("image/") ? contentType : "image/png";
				log(`feishu: downloaded image ${imageKey} as type=${kind} (${mimeType}, ${bytes.length} bytes)`);
				return { mimeType, data: bytes.toString("base64") };
			}
			throw new FeishuError(502, `Feishu image ${imageKey} download failed (${failures.join("; ")})`);
		},
		async replyCard(messageId, card) {
			// Cards are not clamped: the builder caps the body, and truncating JSON
			// would produce a card Feishu cannot parse.
			await send(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
				msg_type: "interactive",
				content: JSON.stringify(card),
			});
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
