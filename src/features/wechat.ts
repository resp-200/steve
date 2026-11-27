/**
 * WeChat ClawBot client (feature layer).
 *
 * Wraps the iLink protocol into the things the rest of the app needs: log in once
 * (QR code), poll for messages, send a reply. Everything protocol-shaped lives in
 * `model/wechat.ts`; everything here is about being a long-running process —
 * where the token lives, how a poll loop survives a dropped request, and what
 * happens when the login gets revoked.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { steveHomeDir } from "../model/config.js";
import {
	buildSendTextBody,
	callIlink,
	parseWechatSession,
	qrCodeFromLogin,
	readQrStatus,
	readUpdates,
	SEND_MESSAGE_ENDPOINT,
	serializeWechatSession,
	SESSION_EXPIRED_CODE,
	POLL_TIMEOUT_MS,
	WechatError,
	type WechatEvent,
	type WechatSession,
} from "../model/wechat.js";
import type { Logger } from "../types.js";

/** Where the scan result lives. One bot per machine, so one file. */
export function wechatSessionPath(): string {
	return join(steveHomeDir(), "wechat.json");
}

/**
 * Reads the saved login.
 *
 * A corrupt file is treated as "not logged in" rather than an error: the fix is
 * the same either way — run the login again — and a parse error at startup would
 * take down a server that could otherwise keep serving everything else.
 */
export function readWechatSession(file: string = wechatSessionPath()): WechatSession | undefined {
	if (!existsSync(file)) return undefined;
	try {
		return parseWechatSession(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		return undefined;
	}
}

/**
 * Writes the login for later runs.
 *
 * Mode 0600: the token is a full-access credential for the WeChat account, and the
 * default umask would leave it world-readable on a shared machine.
 */
export function writeWechatSession(session: WechatSession, file: string = wechatSessionPath()): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(serializeWechatSession(session), null, 2)}\n`, { mode: 0o600 });
}

export function clearWechatSession(file: string = wechatSessionPath()): void {
	rmSync(file, { force: true });
}

export interface WechatClient {
	/** Sends a text reply. `contextToken` comes from the message being answered. */
	sendText(input: { to: string; contextToken: string; text: string }): Promise<void>;
	/** Shows "正在输入" while a run works. Best effort: failures are logged, not thrown. */
	setTyping(input: { userId: string; contextToken: string; on: boolean }): Promise<void>;
}

/**
 * Builds the client for one logged-in session.
 *
 * `typing_ticket`s are cached per user for the life of the process. ClawBot hands
 * one out per conversation and they are stable, so re-fetching per message would
 * double the request count for a cosmetic indicator.
 */
export function createWechatClient(session: WechatSession, logger?: Logger): WechatClient {
	const tickets = new Map<string, string>();
	const base = session.baseUrl;
	const token = session.botToken;

	const post = async (endpoint: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> =>
		callIlink(endpoint, payload, {
			token,
			...(base !== undefined ? { baseUrl: base } : {}),
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
		});

	let clientCounter = 0;

	return {
		async sendText(input) {
			clientCounter += 1;
			// client_id is ClawBot's idempotency key: a retried send with the same id
			// would be a duplicate message, so each send gets a fresh one.
			const body = buildSendTextBody({ to: input.to, contextToken: input.contextToken, text: input.text, clientId: `steve-${Date.now()}-${clientCounter}` });
			await post(SEND_MESSAGE_ENDPOINT, body);
		},
		async setTyping(input) {
			const key = `${input.userId}`;
			try {
				let ticket = tickets.get(key);
				if (ticket === undefined) {
					const config = await post("ilink/bot/getconfig", { ilink_user_id: input.userId, context_token: input.contextToken });
					ticket = typeof config.typing_ticket === "string" ? config.typing_ticket : undefined;
					if (ticket === undefined) return;
					tickets.set(key, ticket);
				}
				await post("ilink/bot/sendtyping", { ilink_user_id: input.userId, typing_ticket: ticket, status: input.on ? 1 : 2 });
			} catch (error) {
				// A missing typing indicator is cosmetic; the answer still arrives.
				logger?.(`wechat: typing indicator failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	};
}

export interface LoginOptions {
	/** Called once with the QR payload so the caller can render it however it likes. */
	onQrCode: (qr: { image: string; key: string }) => void;
	/** How long to wait for the scan before giving up. */
	timeoutMs?: number;
	/** How often to ask whether the code has been scanned. */
	pollMs?: number;
	/** Injected for tests; defaults to the real endpoint. */
	baseUrl?: string;
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs the QR login to completion and returns the session.
 *
 * A QR code expires — typically within minutes — and the server reports it as
 * `expired` rather than failing. The code is fetched again at that point so a
 * user who was slow to pick up their phone gets a working code, instead of a
 * command that died while they were reaching for it.
 */
export async function loginWechat(options: LoginOptions): Promise<WechatSession> {
	const timeoutMs = options.timeoutMs ?? 120_000;
	const pollMs = options.pollMs ?? 2_000;
	const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const baseUrl = options.baseUrl;
	const started = Date.now();

	while (Date.now() - started < timeoutMs) {
		const qrPayload = await callIlink("ilink/bot/get_bot_qrcode?bot_type=3", undefined, { ...(baseUrl !== undefined ? { baseUrl } : {}) });
		const qr = qrCodeFromLogin(qrPayload);
		if (qr === undefined) throw new Error("ClawBot did not return a QR code (login endpoint changed?)");
		options.onQrCode(qr);

		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			await sleep(pollMs);
			const status = await callIlink(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.key)}`, undefined, { ...(baseUrl !== undefined ? { baseUrl } : {}) });
			const read = readQrStatus(status);
			if (read.session !== undefined) return read.session;
			if (read.status === "expired") break;
		}
	}
	throw new Error(`wechat login timed out after ${Math.round(timeoutMs / 1000)}s (no scan confirmed)`);
}

export interface PollOptions {
	client?: WechatClient & { poll?: never };
	session: WechatSession;
	onEvent: (event: WechatEvent) => void;
	logger?: Logger;
	/** Return false to stop the loop (used on shutdown). */
	shouldContinue?: () => boolean;
	/** Injected for tests. */
	fetchUpdates?: (cursor: string) => Promise<Record<string, unknown>>;
	sleep?: (ms: number) => Promise<void>;
	/** Backoff after a failed poll; 0 in tests. */
	retryDelayMs?: number;
}

export class WechatSessionExpired extends Error {
	constructor() {
		super("wechat session expired (-14): run `steve-wechat` again");
		this.name = "WechatSessionExpired";
	}
}

/**
 * Long-polls for messages until stopped or the login is revoked.
 *
 * ClawBot is at-least-once: the cursor only advances when the server hands back a
 * new buffer, so a failed poll re-fetches the same batch rather than losing it.
 * Duplicates are the caller's problem (it dedupes by message id, like the Feishu
 * channel does with event ids) — dropping a message is unrecoverable, seeing one
 * twice is not.
 */
export async function pollWechat(options: PollOptions): Promise<void> {
	const { session, onEvent, logger } = options;
	const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const retryDelayMs = options.retryDelayMs ?? 3_000;
	const fetchUpdates =
		options.fetchUpdates ??
		(async (cursor: string) =>
			callIlink(
				"ilink/bot/getupdates",
				{ get_updates_buf: cursor },
				{
					token: session.botToken,
					...(session.baseUrl !== undefined ? { baseUrl: session.baseUrl } : {}),
					timeoutMs: POLL_TIMEOUT_MS,
				},
			));

	let cursor = "";
	for (;;) {
		if (options.shouldContinue !== undefined && !options.shouldContinue()) return;
		try {
			const payload = await fetchUpdates(cursor);
			const { cursor: next, events } = readUpdates(payload);
			if (next !== undefined) cursor = next;
			for (const event of events) onEvent(event);
			// The long poll already waited server-side; only a failed poll needs a pause.
			if (events.length === 0) continue;
		} catch (error) {
			if (error instanceof WechatError && error.code === SESSION_EXPIRED_CODE) {
				throw new WechatSessionExpired();
			}
			if (error instanceof Error && error.name === "AbortError") continue;
			logger?.(`wechat: poll failed: ${error instanceof Error ? error.message : String(error)}`);
			await sleep(retryDelayMs);
		}
	}
}
