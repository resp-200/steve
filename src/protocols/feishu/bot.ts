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
	if (typeof typed.message_type !== "string" || typed.message_type !== "text") {
		return { kind: "ignored", reason: `unsupported message type ${String(typed.message_type)}` };
	}
	if (typeof typed.message_id !== "string" || typeof typed.chat_id !== "string" || typeof typed.content !== "string") {
		return { kind: "ignored", reason: "message is missing id, chat or content" };
	}
	const text = textFromContent(typed.content, typed.mentions);
	if (text === "") return { kind: "ignored", reason: "message has no text" };
	return {
		kind: "message",
		eventId,
		messageId: typed.message_id,
		chatId: typed.chat_id,
		chatType: typeof typed.chat_type === "string" ? typed.chat_type : "p2p",
		...(senderId !== undefined ? { senderId } : {}),
		senderType,
		text,
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
}

function clampReply(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= MAX_REPLY_CHARS) return trimmed;
	return `${trimmed.slice(0, MAX_REPLY_CHARS - 3)}...`;
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
