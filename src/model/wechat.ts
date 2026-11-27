/**
 * WeChat ClawBot channel (protocol layer).
 *
 * ClawBot is Tencent's official bot API for personal WeChat accounts, served at
 * `ilinkai.weixin.qq.com` under the iLink protocol. It is plain HTTP/JSON — no
 * WebSocket, no SDK, no reverse-engineered client: the login is a QR code the
 * account owner scans, and after that we are an ordinary API client.
 *
 * The whole channel is four calls:
 *
 *   GET  ilink/bot/get_bot_qrcode?bot_type=3   -> QR to scan
 *   GET  ilink/bot/get_qrcode_status?qrcode=…  -> bot_token once confirmed
 *   POST ilink/bot/getupdates                  -> long poll (35s) for messages
 *   POST ilink/bot/sendmessage                 -> reply
 *
 * Two constraints shape everything here:
 *
 * - **A reply needs the message's `context_token`.** There is no way to push a
 *   message on our own initiative, so `send` takes the token of the message it
 *   answers and nothing else can reach a user.
 * - **`errcode -14` means the session is gone** (logged out, or the platform
 *   rotated it). Retrying is pointless and hammering it risks a rate limit, so
 *   the poller stops and says so.
 *
 * Keeping this module offline (no fs, no process state) is deliberate: the API
 * shapes are the part that breaks, and they are testable only if parsing can be
 * called without a live bot.
 */

import { createHash, randomBytes } from "node:crypto";

/** The iLink endpoint. Overridable for tests; production always uses this. */
export const ILINK_BASE = "https://ilinkai.weixin.qq.com";

/**
 * The protocol version ClawBot expects in every `base_info`. It is the version of
 * the plugin that documented the API, not ours — bump it only if ClawBot does.
 */
export const CHANNEL_VERSION = "1.0.2";

/** Endpoint for a reply. Named so the client and the tests agree on one string. */
export const SEND_MESSAGE_ENDPOINT = "ilink/bot/sendmessage";

/** The server holds `getupdates` for 35s; ours must wait longer than that. */
export const POLL_TIMEOUT_MS = 40_000;
export const API_TIMEOUT_MS = 15_000;

/** Messages without a token cannot be answered, so they are not reported at all. */
export interface WechatIncoming {
	kind: "message";
	/** Dedupe key. ClawBot is at-least-once; the same id can arrive twice. */
	messageId: string;
	/** Who wrote it — used for the transcript stream and the allow list. */
	userId: string;
	/** Must be echoed back when replying. This is what makes a reply possible. */
	contextToken: string;
	text: string;
}

export interface WechatUnsupported {
	kind: "unsupported";
	messageId: string;
	userId: string;
	/** Human-readable shape, e.g. "图片" — for the log line and the reply. */
	label: string;
	contextToken: string;
}

export type WechatEvent = WechatIncoming | WechatUnsupported | { kind: "ignored"; reason: string };

/** What a successful scan yields. Persisted by the caller, never by this module. */
export interface WechatSession {
	botToken: string;
	/** ClawBot can answer on a per-login host; absent means the default. */
	baseUrl?: string;
	botId?: string;
	/**
	 * The WeChat account that scanned the code — the only one allowed to drive the
	 * agent. It is not `botId`: that identifies the bot, and the sender ids on
	 * incoming messages identify people. The two never compare equal.
	 */
	ownerId?: string;
	loginTime: string;
}

/** ClawBot's item types, in the order the protocol numbers them. */
const ITEM_LABELS: Record<number, string> = { 1: "文本", 2: "图片", 3: "语音", 4: "文件", 5: "视频" };

/**
 * `X-WECHAT-UIN`: a random uint32, decimal, base64 — the server wants a value
 * that never repeats, so it is regenerated per request rather than cached.
 */
export function randomWechatUin(random: () => Buffer = () => randomBytes(4)): string {
	return random().toString("base64").replace(/=+$/, "");
}

export interface WechatRequestOptions {
	/** ClawBot host; defaults to {@link ILINK_BASE}. */
	baseUrl?: string;
	/** Sent as `Bearer` when present (absent for the two login calls). */
	token?: string;
	timeoutMs?: number;
}

/**
 * Calls one iLink endpoint and returns its JSON body.
 *
 * Errors carry the endpoint and the server's `ret`/`errmsg` when it gives one:
 * "sendmessage failed" tells whoever reads the log nothing, and the difference
 * between a bad token and a rate limit is exactly what they need.
 */
export async function callIlink(endpoint: string, payload: Record<string, unknown> | undefined, options: WechatRequestOptions = {}): Promise<Record<string, unknown>> {
	const base = options.baseUrl ?? ILINK_BASE;
	const url = new URL(endpoint, base.endsWith("/") ? base : `${base}/`);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		AuthorizationType: "ilink_bot_token",
		"X-WECHAT-UIN": randomWechatUin(),
	};
	if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;

	const body = payload === undefined ? undefined : JSON.stringify({ ...payload, base_info: { channel_version: CHANNEL_VERSION } });
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? API_TIMEOUT_MS);
	try {
		const response = await fetch(url, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body }), signal: controller.signal });
		const text = await response.text();
		if (!response.ok) throw new Error(`${endpoint} HTTP ${response.status}${text === "" ? "" : `: ${text.slice(0, 200)}`}`);
		if (text === "") return {};
		const parsed: unknown = JSON.parse(text);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${endpoint} returned ${typeof parsed}, expected an object`);
		const result = parsed as Record<string, unknown>;
		const ret = typeof result.ret === "number" ? result.ret : 0;
		if (ret !== 0) {
			const errmsg = typeof result.errmsg === "string" ? result.errmsg : "";
			throw new WechatError(ret, `${endpoint} failed: ret=${ret}${errmsg === "" ? "" : ` ${errmsg}`}`, result);
		}
		return result;
	} finally {
		clearTimeout(timer);
	}
}

/** An iLink-level failure; `ret` is the code the server reported. */
export class WechatError extends Error {
	readonly code: number;
	readonly detail: Record<string, unknown>;
	constructor(code: number, message: string, detail: Record<string, unknown> = {}) {
		super(message);
		this.name = "WechatError";
		this.code = code;
		this.detail = detail;
	}
}

/** The login session is gone (-14): the user has to scan again. */
export const SESSION_EXPIRED_CODE = -14;

/**
 * Reads one `getupdates` batch.
 *
 * Messages without a `context_token` are dropped rather than reported: there is
 * no way to answer them, and a run whose answer cannot be delivered is worse than
 * no run at all. Bot echoes (`message_type` 2) are dropped for the same reason a
 * person would not reply to themselves.
 */
export function readUpdates(payload: Record<string, unknown>): { cursor?: string; events: WechatEvent[] } {
	const events: WechatEvent[] = [];
	const messages = Array.isArray(payload.msgs) ? payload.msgs : [];
	for (const raw of messages) {
		if (raw === null || typeof raw !== "object") continue;
		const message = raw as Record<string, unknown>;
		// 2 = sent by a bot; our own replies come back in the stream too.
		if (message.message_type === 2) continue;
		const userId = typeof message.from_user_id === "string" ? message.from_user_id : "";
		if (userId === "") {
			events.push({ kind: "ignored", reason: "message without from_user_id" });
			continue;
		}
		// Mirrors of our own posts carry an @im.bot sender; nothing to do about them.
		if (userId.endsWith("@im.bot")) continue;
		const messageId = typeof message.message_id === "string" ? message.message_id : "";
		const contextToken = typeof message.context_token === "string" ? message.context_token : "";
		if (contextToken === "") {
			events.push({ kind: "ignored", reason: `message ${messageId} without context_token cannot be answered` });
			continue;
		}
		const items = Array.isArray(message.item_list) ? message.item_list : [];
		const texts: string[] = [];
		let label: string | undefined;
		for (const item of items) {
			if (item === null || typeof item !== "object") continue;
			const entry = item as Record<string, unknown>;
			const type = typeof entry.type === "number" ? entry.type : 0;
			if (type === 1) {
				const textItem = entry.text_item;
				if (textItem !== null && typeof textItem === "object") {
					const text = (textItem as Record<string, unknown>).text;
					if (typeof text === "string" && text !== "") texts.push(text);
				}
				continue;
			}
			// Anything else is media; this channel handles text only for now.
			label ??= ITEM_LABELS[type] ?? `type ${type}`;
		}
		const text = texts.join("");
		if (text !== "") {
			events.push({ kind: "message", messageId, userId, contextToken, text });
			continue;
		}
		if (label !== undefined) events.push({ kind: "unsupported", messageId, userId, contextToken, label });
	}
	const cursor = typeof payload.get_updates_buf === "string" && payload.get_updates_buf !== "" ? payload.get_updates_buf : undefined;
	return cursor === undefined ? { events } : { cursor, events };
}

/**
 * Whether a sender may drive the agent.
 *
 * The bot is reachable by anyone who can message the WeChat account, and the agent
 * has shell access — so the answer is "only the person who scanned the code in".
 * An unknown owner (a session file written by an older version, or a login that
 * did not report one) falls back to `STEVE_WECHAT_ALLOW` when set; with neither,
 * everything is refused. Failing closed is the whole point: an owner-less session
 * that lets strangers run commands is the failure mode worth avoiding, and the
 * fix — log in again — is one command.
 */
export function wechatAllowed(userId: string, session: WechatSession, allowList: readonly string[] = []): boolean {
	if (allowList.includes(userId)) return true;
	if (session.ownerId === undefined) return false;
	return session.ownerId === userId;
}

/** Parses `STEVE_WECHAT_ALLOW` (comma-separated user ids) into a list. */
export function parseAllowList(raw: string | undefined): string[] {
	if (raw === undefined) return [];
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
}

/** Stable per-user stream id, same scheme the Feishu channel uses. */
export function wechatStreamId(userId: string): string {
	return createHash("sha256").update(`wechat:${userId}`).digest("hex").slice(0, 12);
}

/**
 * The body of one text reply.
 *
 * `message_type: 2` marks it as a bot message (mirrors come back and are skipped),
 * `message_state: 2` marks it finished — long replies are sent as chunks, and the
 * first version of this channel sends each chunk finished rather than streaming
 * partial states.
 */
export function buildSendTextBody(input: { to: string; contextToken: string; text: string; clientId: string }): Record<string, unknown> {
	return {
		msg: {
			from_user_id: "",
			to_user_id: input.to,
			client_id: input.clientId,
			message_type: 2,
			message_state: 2,
			context_token: input.contextToken,
			item_list: [{ type: 1, text_item: { text: input.text } }],
		},
	};
}

/**
 * The `qrcode_img_content` from `get_bot_qrcode`, or undefined.
 *
 * It is *not* the `qrcode` field: that one is the key to poll with. Swapping them
 * produces a login that never completes, with no error to point at it.
 */
export function qrCodeFromLogin(payload: Record<string, unknown>): { image: string; key: string } | undefined {
	const image = typeof payload.qrcode_img_content === "string" ? payload.qrcode_img_content : "";
	const key = typeof payload.qrcode === "string" ? payload.qrcode : "";
	if (image === "" || key === "") return undefined;
	return { image, key };
}

/** The scan state; `-1`/`expired` means the code has to be fetched again. */
export function readQrStatus(payload: Record<string, unknown>): { status: string; session?: WechatSession } {
	const botToken = typeof payload.bot_token === "string" ? payload.bot_token : "";
	if (botToken !== "") {
		const session: WechatSession = { botToken, loginTime: new Date().toISOString() };
		if (typeof payload.baseurl === "string" && payload.baseurl !== "") session.baseUrl = payload.baseurl;
		if (typeof payload.bot_id === "string" && payload.bot_id !== "") session.botId = payload.bot_id;
		return { status: "confirmed", session };
	}
	const status = typeof payload.status === "string" && payload.status !== "" ? payload.status : "waiting";
	return { status };
}

/** Parses a persisted session, rejecting anything that cannot actually be used. */
export function parseWechatSession(raw: unknown): WechatSession | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const value = raw as Record<string, unknown>;
	const botToken = typeof value.bot_token === "string" ? value.bot_token : typeof value.botToken === "string" ? value.botToken : "";
	if (botToken === "") return undefined;
	const session: WechatSession = { botToken, loginTime: typeof value.login_time === "string" ? value.login_time : typeof value.loginTime === "string" ? value.loginTime : new Date(0).toISOString() };
	const baseUrl = typeof value.baseurl === "string" ? value.baseurl : typeof value.baseUrl === "string" ? value.baseUrl : "";
	if (baseUrl !== "") session.baseUrl = baseUrl;
	const botId = typeof value.bot_id === "string" ? value.bot_id : typeof value.botId === "string" ? value.botId : "";
	if (botId !== "") session.botId = botId;
	const ownerId = typeof value.owner_id === "string" ? value.owner_id : typeof value.ownerId === "string" ? value.ownerId : "";
	if (ownerId !== "") session.ownerId = ownerId;
	return session;
}

/** How a session is stored on disk: snake_case, matching what login returns. */
export function serializeWechatSession(session: WechatSession): Record<string, unknown> {
	return {
		bot_token: session.botToken,
		...(session.baseUrl !== undefined ? { baseurl: session.baseUrl } : {}),
		...(session.botId !== undefined ? { bot_id: session.botId } : {}),
		...(session.ownerId !== undefined ? { owner_id: session.ownerId } : {}),
		login_time: session.loginTime,
	};
}
