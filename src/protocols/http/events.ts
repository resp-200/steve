/**
 * HTTP + SSE transport primitives for the serve entry (§5.7.3).
 *
 * This layer knows about sockets, JSON bodies and event streams — not about
 * streams, runs or triggers. The entry wires those on top, so the same transport
 * could carry another protocol later without touching the functional layer.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "../../types.js";

export interface HttpRequest {
	method: string;
	/** Path only, no query string. */
	path: string;
	query: URLSearchParams;
	headers: Record<string, string | string[] | undefined>;
	/** Raw body (already size-limited); the handler parses JSON when it expects JSON. */
	body: string;
}

export interface SseSink {
	/** Sends one `data:` frame; `event:` is optional. */
	send(payload: unknown, options?: { event?: string }): void;
	/** A comment frame (keeps proxies from closing an idle stream). */
	comment(text: string): void;
	close(): void;
	readonly closed: boolean;
	onClose(listener: () => void): void;
}

export interface HttpExchange {
	readonly request: HttpRequest;
	/** `:name` segments of the matched route. */
	readonly params: Record<string, string>;
	json(status: number, payload: unknown): void;
	text(status: number, body: string, contentType?: string): void;
	sse(headers?: Record<string, string>): SseSink;
}

export type HttpHandler = (exchange: HttpExchange) => Promise<void> | void;

export interface HttpRoute {
	method: "GET" | "POST";
	/** `/streams/:id/events` — `:name` matches one segment. */
	path: string;
	handle: HttpHandler;
}

export interface HttpServerOptions {
	host?: string;
	port?: number;
	/** When set, every request must carry `Authorization: Bearer <token>`. */
	token?: string;
	logger?: Logger;
	routes: readonly HttpRoute[];
	/** Body limit (default 8 MiB). */
	maxBodyBytes?: number;
}

export interface HttpServerHandle {
	readonly host: string;
	readonly port: number;
	close(): Promise<void>;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;

function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxBytes) {
				reject(new Error(`request body exceeds ${maxBytes} bytes`));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}

function matchRoute(route: HttpRoute, method: string, path: string): Record<string, string> | undefined {
	if (route.method !== method) return undefined;
	const expected = route.path.split("/");
	const actual = path.split("/");
	if (expected.length !== actual.length) return undefined;
	const params: Record<string, string> = {};
	for (let index = 0; index < expected.length; index += 1) {
		const part = expected[index] as string;
		const value = actual[index] as string;
		if (part.startsWith(":")) {
			if (value === "") return undefined;
			params[part.slice(1)] = decodeURIComponent(value);
			continue;
		}
		if (part !== value) return undefined;
	}
	return params;
}

function createSse(response: ServerResponse, headers: Record<string, string> = {}): SseSink {
	response.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		// nginx buffers proxied responses otherwise, and the stream never arrives.
		"X-Accel-Buffering": "no",
		...headers,
	});
	let closed = false;
	const listeners: (() => void)[] = [];
	const heartbeat = setInterval(() => {
		if (!closed) response.write(": ping\n\n");
	}, HEARTBEAT_MS);
	heartbeat.unref?.();
	const finish = (): void => {
		if (closed) return;
		closed = true;
		clearInterval(heartbeat);
		for (const listener of listeners.splice(0)) listener();
	};
	response.on("close", finish);
	return {
		send(payload, options) {
			if (closed) return;
			const prefix = options?.event !== undefined ? `event: ${options.event}\n` : "";
			const data = typeof payload === "string" ? payload : JSON.stringify(payload);
			response.write(`${prefix}data: ${data}\n\n`);
		},
		comment(text) {
			if (!closed) response.write(`: ${text}\n\n`);
		},
		close() {
			if (closed) return;
			response.end();
			finish();
		},
		get closed() {
			return closed;
		},
		onClose(listener) {
			if (closed) listener();
			else listeners.push(listener);
		},
	};
}

export async function startHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
	const logger = options.logger ?? (() => {});
	const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
	const server: Server = createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url ?? "/", "http://localhost");
			const requestBody = request.method === "POST" ? await readBody(request, maxBodyBytes) : "";
			if (options.token !== undefined) {
				const authorization = request.headers.authorization ?? "";
				if (authorization !== `Bearer ${options.token}`) {
					response.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
					response.end(JSON.stringify({ error: "unauthorized" }));
					return;
				}
			}
			for (const route of options.routes) {
				const params = matchRoute(route, request.method ?? "GET", url.pathname);
				if (params === undefined) continue;
				let answered = false;
				const exchange: HttpExchange = {
					request: { method: request.method ?? "GET", path: url.pathname, query: url.searchParams, headers: request.headers, body: requestBody },
					params,
					json(status, payload) {
						if (answered) return;
						answered = true;
						response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
						response.end(JSON.stringify(payload));
					},
					text(status, body, contentType = "text/plain; charset=utf-8") {
						if (answered) return;
						answered = true;
						response.writeHead(status, { "Content-Type": contentType });
						response.end(body);
					},
					sse(headers) {
						if (answered) throw new Error("route already answered");
						answered = true;
						return createSse(response, headers);
					},
				};
				try {
					await route.handle(exchange);
					if (!answered && request.method !== "GET") {
						response.writeHead(204);
						response.end();
					}
				} catch (error) {
					logger(`[http] ${request.method} ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
					if (!answered && !response.headersSent) {
						response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
						response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
					}
				}
				return;
			}
			response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
			response.end(JSON.stringify({ error: "not found" }));
		})().catch((error: unknown) => {
			logger(`[http] request failed: ${error instanceof Error ? error.message : String(error)}`);
			try {
				response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
				response.end(JSON.stringify({ error: "internal error" }));
			} catch {
				// The socket is already gone.
			}
		});
	});

	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 8892;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	const actualPort = typeof address === "object" && address !== null ? address.port : port;
	return {
		host,
		port: actualPort,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections?.();
			}),
	};
}
