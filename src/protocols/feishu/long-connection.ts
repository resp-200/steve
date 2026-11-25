/**
 * Feishu (Lark) long-connection transport for `steve-serve`.
 *
 * Instead of exposing a public HTTP callback, the app opens a WebSocket to
 * Feishu: POST /callback/ws/endpoint with the app credentials returns a
 * connection URL, and events then arrive as `pbbp2.Frame` protobuf messages on
 * that socket. This is the "长连接" event-subscription mode in the developer
 * console, and it needs no public address, no verification token and no
 * encryption key — the socket is authenticated by the app secret itself.
 *
 * No SDK dependency: the protobuf envelope is a handful of fields, so the codec
 * lives here; the WebSocket comes from the optional `ws` package (the same one
 * the ACP transport uses) and a missing module simply disables this transport.
 */
import { randomUUID } from "node:crypto";
import { FEISHU_API_BASE } from "./bot.js";
import type { Logger } from "../../types.js";

/** Field tags of `pbbp2.proto`; the wire format is frozen upstream. */
const FRAME = { seqId: 1, logId: 2, service: 3, method: 4, headers: 5, payloadEncoding: 6, payloadType: 7, payload: 8, logIdNew: 9 } as const;
const HEADER = { key: 1, value: 2 } as const;

const FRAME_TYPE = { control: 0, data: 1 } as const;
const HEADER_KEY = { type: "type", messageId: "message_id", sum: "sum", seq: "seq", traceId: "trace_id", bizRt: "biz_rt" } as const;
const MESSAGE_TYPE = { event: "event", card: "card", ping: "ping", pong: "pong" } as const;

const DEFAULT_PING_INTERVAL = 120_000;
const DEFAULT_RECONNECT_INTERVAL = 5_000;
const MAX_RECONNECT_DELAY = 60_000;
const FRAGMENT_TTL = 30_000;
/** These all mean an HTTP frame or event arrived, i.e. the socket is alive. */
const DEFAULT_USER_AGENT = "steve-feishu-long-connection";

export interface FeishuFrameHeader {
	key: string;
	value: string;
}

/** Decoded `pbbp2.Frame`; `method` 0 is control (ping/pong), 1 is data. */
export interface FeishuFrame {
	seqId: number;
	logId: number;
	service: number;
	method: 0 | 1;
	headers: FeishuFrameHeader[];
	payloadEncoding?: string;
	payloadType?: string;
	payload?: Uint8Array;
	logIdNew?: string;
}

/* ------------------------------------------------------------------ */
/* protobuf codec (pbbp2.Frame / pbbp2.Header only)                    */
/* ------------------------------------------------------------------ */

function writeVarint(target: number[], value: number): void {
	let remaining = BigInt(Math.trunc(value));
	if (remaining < 0n) remaining = BigInt.asUintN(64, remaining);
	while (remaining > 0x7fn) {
		target.push(Number((remaining & 0x7fn) | 0x80n));
		remaining >>= 7n;
	}
	target.push(Number(remaining));
}

function tag(field: number, wireType: number): number {
	return (field << 3) | wireType;
}

function writeString(target: number[], field: number, value: string): void {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length === 0) return;
	writeVarint(target, tag(field, 2));
	writeVarint(target, bytes.length);
	for (const byte of bytes) target.push(byte);
}

function writeBytes(target: number[], field: number, value: Uint8Array): void {
	if (value.length === 0) return;
	writeVarint(target, tag(field, 2));
	writeVarint(target, value.length);
	for (const byte of value) target.push(byte);
}

/** Encodes a frame exactly as the official SDKs do. */
export function encodeFrame(frame: Partial<FeishuFrame> & { method?: 0 | 1; headers?: FeishuFrameHeader[] }): Uint8Array {
	const target: number[] = [];
	// Fields 1-4 are proto2 `required`: their tags stay on the wire even at 0.
	writeVarint(target, tag(FRAME.seqId, 0));
	writeVarint(target, frame.seqId ?? 0);
	writeVarint(target, tag(FRAME.logId, 0));
	writeVarint(target, frame.logId ?? 0);
	writeVarint(target, tag(FRAME.service, 0));
	writeVarint(target, Math.trunc(frame.service ?? 0));
	writeVarint(target, tag(FRAME.method, 0));
	writeVarint(target, Math.trunc(frame.method ?? 0));
	for (const header of frame.headers ?? []) {
		const headerBytes: number[] = [];
		writeString(headerBytes, HEADER.key, header.key);
		writeString(headerBytes, HEADER.value, header.value);
		writeVarint(target, tag(FRAME.headers, 2));
		writeVarint(target, headerBytes.length);
		for (const byte of headerBytes) target.push(byte);
	}
	if (frame.payloadEncoding !== undefined) writeString(target, FRAME.payloadEncoding, frame.payloadEncoding);
	if (frame.payloadType !== undefined) writeString(target, FRAME.payloadType, frame.payloadType);
	if (frame.payload !== undefined) writeBytes(target, FRAME.payload, frame.payload);
	if (frame.logIdNew !== undefined) writeString(target, FRAME.logIdNew, frame.logIdNew);
	return Buffer.from(target);
}

class Reader {
	private offset = 0;
	constructor(private readonly bytes: Uint8Array) {}

	get done(): boolean {
		return this.offset >= this.bytes.length;
	}

	varint(): number {
		let result = 0n;
		let shift = 0n;
		while (true) {
			if (this.offset >= this.bytes.length) throw new Error("truncated varint");
			const byte = this.bytes[this.offset++] as number;
			result |= BigInt(byte & 0x7f) << shift;
			if ((byte & 0x80) === 0) break;
			shift += 7n;
			if (shift > 63n) throw new Error("varint too long");
		}
		return Number(result);
	}

	bytesOf(length: number): Uint8Array {
		if (this.offset + length > this.bytes.length) throw new Error("truncated field");
		const slice = this.bytes.subarray(this.offset, this.offset + length);
		this.offset += length;
		return slice;
	}

	skip(wireType: number): void {
		if (wireType === 0) {
			this.varint();
			return;
		}
		if (wireType === 1) {
			this.bytesOf(8);
			return;
		}
		if (wireType === 2) {
			this.bytesOf(this.varint());
			return;
		}
		if (wireType === 5) {
			this.bytesOf(4);
			return;
		}
		throw new Error(`unsupported protobuf wire type ${wireType}`);
	}
}

function decodeHeader(bytes: Uint8Array): FeishuFrameHeader {
	const reader = new Reader(bytes);
	const header: FeishuFrameHeader = { key: "", value: "" };
	while (!reader.done) {
		const key = reader.varint();
		const field = key >>> 3;
		const wireType = key & 0x7;
		if (wireType !== 2) {
			reader.skip(wireType);
			continue;
		}
		const value = Buffer.from(reader.bytesOf(reader.varint())).toString("utf8");
		if (field === HEADER.key) header.key = value;
		else if (field === HEADER.value) header.value = value;
	}
	return header;
}

/** Decodes a frame, skipping unknown fields so an upstream addition is harmless. */
export function decodeFrame(bytes: Uint8Array): FeishuFrame {
	const reader = new Reader(bytes);
	const frame: FeishuFrame = { seqId: 0, logId: 0, service: 0, method: 0, headers: [] };
	while (!reader.done) {
		const key = reader.varint();
		const field = key >>> 3;
		const wireType = key & 0x7;
		if (wireType === 0) {
			const value = reader.varint();
			if (field === FRAME.seqId) frame.seqId = value;
			else if (field === FRAME.logId) frame.logId = value;
			else if (field === FRAME.service) frame.service = value;
			else if (field === FRAME.method) frame.method = value === 1 ? 1 : 0;
			continue;
		}
		if (wireType !== 2) {
			reader.skip(wireType);
			continue;
		}
		const value = reader.bytesOf(reader.varint());
		if (field === FRAME.headers) frame.headers.push(decodeHeader(value));
		else if (field === FRAME.payloadEncoding) frame.payloadEncoding = Buffer.from(value).toString("utf8");
		else if (field === FRAME.payloadType) frame.payloadType = Buffer.from(value).toString("utf8");
		else if (field === FRAME.payload) frame.payload = value;
		else if (field === FRAME.logIdNew) frame.logIdNew = Buffer.from(value).toString("utf8");
	}
	return frame;
}

/* ------------------------------------------------------------------ */
/* long connection                                                    */
/* ------------------------------------------------------------------ */

export interface FeishuLongConnectionClientConfig {
	pingInterval: number;
	reconnectCount: number;
	reconnectInterval: number;
	reconnectNonce: number;
}

export interface FeishuLongConnectionStatus {
	connected: boolean;
	attempts: number;
	/** True once discovery reported bad credentials; the client stops retrying. */
	fatal: boolean;
	lastError?: string;
	connectedAt?: number;
	serviceId?: string;
	pingIntervalMs?: number;
}

/** Minimal socket surface so tests can inject a fake WebSocket. */
export interface FeishuSocket {
	readyState: number;
	send(data: Uint8Array): void;
	close(): void;
	terminate?(): void;
	on(event: "open" | "message" | "error" | "close", listener: (...args: unknown[]) => void): void;
}

export interface FeishuLongConnectionOptions {
	appId: string;
	appSecret: string;
	apiBase?: string;
	logger?: Logger;
	fetchImpl?: typeof fetch;
	/** Receives one complete event payload (the same JSON the HTTP callback gets). */
	onEvent: (payload: Record<string, unknown>, meta: { messageId?: string; traceId?: string }) => void;
	/** Injection seam for tests. */
	createSocket?: (url: string) => FeishuSocket;
	/** Test seam for deterministic reconnect math. */
	random?: () => number;
	/** Customize the discovery path (tests point it at a fake server). */
	endpointPath?: string;
}

export interface FeishuLongConnection {
	start(): void;
	stop(): void;
	status(): FeishuLongConnectionStatus;
}

interface FragmentState {
	parts: Map<number, Uint8Array>;
	expected: number;
	at: number;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Bad app credentials: retrying cannot help, so the client stops instead. */
class FatalDiscoveryError extends Error {}

/** Codes meaning "operator must fix the app configuration", not "try again". */
const FATAL_DISCOVERY_CODES = new Set([403, 514]);

/**
 * Opens and maintains the long connection. `start()` is fire-and-forget: it
 * discovers the endpoint, connects, pings on Feishu's schedule and reconnects
 * with backoff until `stop()` is called.
 */
export function createFeishuLongConnection(options: FeishuLongConnectionOptions): FeishuLongConnection {
	const logger = options.logger ?? (() => {});
	const apiBase = (options.apiBase ?? FEISHU_API_BASE).replace(/\/+$/, "");
	const fetchImpl = options.fetchImpl ?? fetch;
	const random = options.random ?? Math.random;
	const fragmentTtl = FRAGMENT_TTL;

	let running = false;
	let socket: FeishuSocket | undefined;
	let pingTimer: NodeJS.Timeout | undefined;
	let reconnectTimer: NodeJS.Timeout | undefined;
	let watchdog: NodeJS.Timeout | undefined;
	let clientConfig: FeishuLongConnectionClientConfig | undefined;
	let status: FeishuLongConnectionStatus = { connected: false, attempts: 0, fatal: false };
	const fragments = new Map<string, FragmentState>();
	let serviceId: string | undefined;
	let generation = 0;

	const sendRaw = (frame: Partial<FeishuFrame> & { method?: 0 | 1; headers?: FeishuFrameHeader[] }): void => {
		const active = socket;
		if (active === undefined || active.readyState !== 1) return;
		try {
			active.send(encodeFrame(frame));
		} catch (error) {
			logger(`[feishu] long connection send failed: ${describe(error)}`);
		}
	};

	const sendPing = (): void => {
		sendRaw({ service: Number(serviceId ?? 0), method: FRAME_TYPE.control, headers: [{ key: HEADER_KEY.type, value: MESSAGE_TYPE.ping }] });
	};

	const clearPing = (): void => {
		if (pingTimer !== undefined) clearTimeout(pingTimer);
		pingTimer = undefined;
		if (watchdog !== undefined) clearTimeout(watchdog);
		watchdog = undefined;
	};

	const armWatchdog = (): void => {
		if (watchdog !== undefined) clearTimeout(watchdog);
		const interval = clientConfig?.pingInterval ?? DEFAULT_PING_INTERVAL;
		watchdog = setTimeout(() => {
			logger(`[feishu] long connection silent for ${Math.round(interval / 1000)}s, reconnecting`);
			try {
				socket?.terminate?.();
				socket?.close();
			} catch {
				/* best effort */
			}
		}, Math.max(interval * 2, 30_000));
		watchdog.unref?.();
	};

	const pingLoop = (): void => {
		pingTimer = undefined;
		if (!running) return;
		pingTimer = setTimeout(pingLoop, clientConfig?.pingInterval ?? DEFAULT_PING_INTERVAL);
		pingTimer.unref?.();
		sendPing();
		armWatchdog();
	};

	const scheduleReconnect = (reason: string): void => {
		if (!running || status.fatal || reconnectTimer !== undefined) return;
		status = { ...status, connected: false, lastError: reason };
		const base = clientConfig?.reconnectInterval ?? DEFAULT_RECONNECT_INTERVAL;
		const jitter = random() * (clientConfig?.reconnectNonce ?? DEFAULT_RECONNECT_INTERVAL);
		const delay = Math.min(base * Math.max(1, status.attempts), MAX_RECONNECT_DELAY) + jitter;
		logger(`[feishu] long connection disconnected (${reason}); retrying in ${Math.round(delay / 1000)}s`);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			void attempt();
		}, delay);
		reconnectTimer.unref?.();
	};

	const ack = (frame: FeishuFrame, businessRt: number): void => {
		sendRaw({
			seqId: frame.seqId,
			logId: frame.logId,
			service: frame.service,
			method: frame.method,
			headers: [...frame.headers, { key: HEADER_KEY.bizRt, value: String(businessRt) }],
			payload: Buffer.from(JSON.stringify({ code: 200 }), "utf8"),
		});
	};

	const handleEventFrame = (frame: FeishuFrame): void => {
		const headers = new Map<string, string>();
		for (const header of frame.headers) headers.set(header.key, header.value);
		const type = headers.get(HEADER_KEY.type);
		if (type !== MESSAGE_TYPE.event) return;
		const messageId = headers.get(HEADER_KEY.messageId) ?? randomUUID();
		const traceId = headers.get(HEADER_KEY.traceId);
		const sum = Number(headers.get(HEADER_KEY.sum) ?? "1") || 1;
		const seq = Number(headers.get(HEADER_KEY.seq) ?? "1") || 1;
		const payload = frame.payload ?? new Uint8Array();
		const startedAt = Date.now();

		const entry = fragments.get(messageId) ?? { parts: new Map(), expected: sum, at: startedAt };
		entry.expected = Math.max(entry.expected, sum);
		entry.parts.set(seq, payload);
		entry.at = startedAt;
		fragments.set(messageId, entry);
		const now = startedAt;
		for (const [id, state] of fragments) {
			if (now - state.at > fragmentTtl) fragments.delete(id);
		}
		if (entry.parts.size < entry.expected) return;
		fragments.delete(messageId);
		const ordered: Uint8Array[] = [];
		for (let index = 1; index <= entry.expected; index += 1) {
			const part = entry.parts.get(index);
			if (part === undefined) return;
			ordered.push(part);
		}
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(Buffer.concat(ordered).toString("utf8")) as Record<string, unknown>;
		} catch (error) {
			logger(`[feishu] long connection dropped malformed event ${messageId}: ${describe(error)}`);
			ack(frame, 0);
			return;
		}
		try {
			options.onEvent(parsed, { ...(traceId !== undefined ? { traceId } : {}), messageId });
		} catch (error) {
			logger(`[feishu] long connection event handler failed: ${describe(error)}`);
		}
		ack(frame, Date.now() - startedAt);
	};

	const handleControlFrame = (frame: FeishuFrame): void => {
		const type = frame.headers.find((header) => header.key === HEADER_KEY.type)?.value;
		if (type !== MESSAGE_TYPE.pong || frame.payload === undefined) return;
		try {
			const pong = JSON.parse(Buffer.from(frame.payload).toString("utf8")) as Record<string, unknown>;
			const pingInterval = Number(pong.PingInterval);
			clientConfig = {
				pingInterval: Number.isFinite(pingInterval) && pingInterval > 0 ? pingInterval * 1_000 : clientConfig?.pingInterval ?? DEFAULT_PING_INTERVAL,
				reconnectCount: Number(pong.ReconnectCount) || clientConfig?.reconnectCount || 3,
				reconnectInterval: (Number(pong.ReconnectInterval) || 5) * 1_000,
				reconnectNonce: (Number(pong.ReconnectNonce) || 5) * 1_000,
			};
			status = { ...status, pingIntervalMs: clientConfig.pingInterval };
			logger(`[feishu] long connection ping interval ${Math.round(clientConfig.pingInterval / 1000)}s`);
		} catch (error) {
			logger(`[feishu] long connection ignored malformed pong: ${describe(error)}`);
		}
	};

	const onFrame = (frame: FeishuFrame): void => {
		armWatchdog();
		if (frame.method === FRAME_TYPE.control) {
			handleControlFrame(frame);
			return;
		}
		if (frame.method === FRAME_TYPE.data) handleEventFrame(frame);
	};

	const destroySocket = (): void => {
		clearPing();
		const active = socket;
		socket = undefined;
		if (active !== undefined) {
			try {
				active.close();
			} catch {
				/* best effort */
			}
		}
	};

	const defaultCreateSocket = async (url: string): Promise<FeishuSocket> => {
		let module: { default: new (url: string) => FeishuSocket };
		try {
			const specifier = "ws";
			module = (await import(specifier)) as unknown as { default: new (url: string) => FeishuSocket };
		} catch {
			throw new Error("`ws` is not installed; the Feishu long connection needs it (npm i ws)");
		}
		return new module.default(url);
	};

	const discover = async (): Promise<{ url: string; config: FeishuLongConnectionClientConfig }> => {
		const path = options.endpointPath ?? "/callback/ws/endpoint";
		const response = await fetchImpl(`${apiBase}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", locale: "zh", "user-agent": DEFAULT_USER_AGENT },
			body: JSON.stringify({ AppID: options.appId, AppSecret: options.appSecret }),
		});
		const body = (await response.json().catch(() => ({}))) as { code?: number; msg?: string; data?: { URL?: string; ClientConfig?: Record<string, unknown> } };
		if (!response.ok) {
			const detail = `endpoint returned HTTP ${response.status}${body.code !== undefined ? ` code=${body.code}` : ""}`;
			if (FATAL_DISCOVERY_CODES.has(response.status) || (body.code !== undefined && FATAL_DISCOVERY_CODES.has(body.code))) {
				throw new FatalDiscoveryError(detail);
			}
			throw new Error(detail);
		}
		if (body.code !== undefined && body.code !== 0) {
			const detail = `endpoint rejected credentials: code=${body.code} ${body.msg ?? ""}`.trim();
			if (FATAL_DISCOVERY_CODES.has(body.code)) throw new FatalDiscoveryError(detail);
			throw new Error(detail);
		}
		const url = body.data?.URL;
		if (typeof url !== "string" || url === "") throw new Error("endpoint response is missing URL");
		const raw = body.data?.ClientConfig ?? {};
		const pingInterval = Number(raw.PingInterval);
		return {
			url,
			config: {
				pingInterval: Number.isFinite(pingInterval) && pingInterval > 0 ? pingInterval * 1_000 : DEFAULT_PING_INTERVAL,
				reconnectCount: Number(raw.ReconnectCount) || 3,
				reconnectInterval: (Number(raw.ReconnectInterval) || 5) * 1_000,
				reconnectNonce: (Number(raw.ReconnectNonce) || 5) * 1_000,
			},
		};
	};

	const connect = async (url: string): Promise<void> => {
		const current = ++generation;
		const createSocket = options.createSocket ?? ((target: string) => defaultCreateSocket(target) as unknown as FeishuSocket);
		let created: FeishuSocket | Promise<FeishuSocket> | undefined;
		try {
			created = options.createSocket !== undefined ? createSocket(url) : await defaultCreateSocket(url);
		} catch (error) {
			scheduleReconnect(describe(error));
			return;
		}
		const active = created as FeishuSocket;
		socket = active;
		let opened = false;
		active.on("open", () => {
			if (current !== generation || !running) return;
			opened = true;
			status = { ...status, connected: true, attempts: 0, connectedAt: Date.now(), lastError: undefined, ...(serviceId !== undefined ? { serviceId } : {}) };
			logger(`[feishu] long connection ready${serviceId !== undefined ? ` (service_id=${serviceId})` : ""}`);
			pingLoop();
		});
		active.on("message", (...args: unknown[]) => {
			if (current !== generation) return;
			const data = args[0];
			if (!(data instanceof Uint8Array)) return;
			try {
				onFrame(decodeFrame(data));
			} catch (error) {
				logger(`[feishu] long connection dropped malformed frame: ${describe(error)}`);
			}
		});
		active.on("error", (...args: unknown[]) => {
			if (current !== generation) return;
			const error = args[0];
			status = { ...status, lastError: describe(error) };
			logger(`[feishu] long connection error: ${describe(error)}`);
		});
		active.on("close", () => {
			if (current !== generation) return;
			destroySocket();
			if (!running) return;
			if (!opened) {
				scheduleReconnect("connection failed");
				return;
			}
			scheduleReconnect("closed by server");
		});
	};

	const attempt = async (): Promise<void> => {
		if (!running) return;
		status = { ...status, attempts: status.attempts + 1 };
		try {
			const discovered = await discover();
			clientConfig = discovered.config;
			status = { ...status, pingIntervalMs: discovered.config.pingInterval };
			try {
				const parsed = new URL(discovered.url);
				const queryService = parsed.searchParams.get("service_id");
				if (queryService !== null && queryService !== "") serviceId = queryService;
			} catch {
				/* URL parse failures surface at connect time */
			}
			await connect(discovered.url);
		} catch (error) {
			if (error instanceof FatalDiscoveryError) {
				status = { ...status, connected: false, fatal: true, lastError: describe(error) };
				running = false;
				logger(`[feishu] long connection disabled: ${describe(error)} (check FEISHU_APP_ID / FEISHU_APP_SECRET)`);
				return;
			}
			scheduleReconnect(describe(error));
		}
	};

	return {
		start(): void {
			if (running) return;
			running = true;
			logger(`[feishu] long connection starting (${apiBase})`);
			void attempt();
		},
		stop(): void {
			running = false;
			generation += 1;
			if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
			reconnectTimer = undefined;
			destroySocket();
			status = { ...status, connected: false };
			fragments.clear();
			logger("[feishu] long connection stopped");
		},
		status(): FeishuLongConnectionStatus {
			return { ...status };
		},
	};
}
