// ACP over Streamable HTTP — dependency-free client that runs in a browser and
// in Node 22+ (same code path, so the bundled test page and the CLI probe agree).
//
// Wire protocol implemented here (mirrors @agentclientprotocol/sdk's own
// HttpStreamTransport, which is what the server expects):
//
//   1. POST <url>  {initialize}                    -> 200 JSON + `Acp-Connection-Id` header
//   2. GET  <url>  Accept: text/event-stream       -> connection mailbox
//        + `Acp-Connection-Id`
//   3. POST <url>  {session/new}                   -> 202, response arrives on the connection SSE
//   4. GET  <url>  + `Acp-Session-Id`              -> session mailbox
//   5. POST <url>  {session/prompt}                -> 202, updates + response arrive on the session SSE
//   6. POST <url>  {JSON-RPC response}             -> answers server->client requests
//
// Every mailbox only accepts one active receiver, so each stream is opened once.

export const HEADER_CONNECTION_ID = "Acp-Connection-Id";
export const HEADER_SESSION_ID = "Acp-Session-Id";
export const PROTOCOL_VERSION = 1;

/** JSON-RPC ids are matched the way the SDK does it (type-tagged). */
export function messageKey(id) {
	if (typeof id === "string") return `string:${id}`;
	if (typeof id === "number") return `number:${id}`;
	return `other:${JSON.stringify(id)}`;
}

export class AcpRequestError extends Error {
	constructor(method, error) {
		super(`${method} failed: ${error?.message ?? JSON.stringify(error)}`);
		this.name = "AcpRequestError";
		this.code = error?.code;
		this.data = error?.data;
	}
}

export class AcpHttpClient {
	#url;
	#fetch;
	#headers;
	#connectionId = null;
	#nextId = 1;
	#pending = new Map();
	#handlers = new Map();
	#listeners = new Set();
	#streams = new Map();
	#controllers = new Set();
	#sessions = new Set();
	#closed = false;

	constructor(url, { token, headers = {}, fetch: fetchImpl } = {}) {
		this.#url = url;
		// Bind so `fetch` keeps its receiver (browsers throw "Illegal invocation" otherwise).
		this.#fetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
		this.#headers = { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) };
	}

	get connectionId() {
		return this.#connectionId;
	}

	get sessions() {
		return [...this.#sessions];
	}

	/** Registers a handler for server->client requests (fs/*, terminal/*, permissions…). */
	on(method, handler) {
		this.#handlers.set(method, handler);
		return this;
	}

	/** Observes every inbound/outbound message (used for the raw log). */
	onMessage(listener) {
		this.#listeners.add(listener);
		return this;
	}

	removeMessageListener(listener) {
		this.#listeners.delete(listener);
		return this;
	}

	/* ------------------------------ ACP surface ----------------------------- */

	async initialize({ protocolVersion = PROTOCOL_VERSION, clientName, clientVersion, capabilities = {} } = {}) {
		if (this.#connectionId) throw new Error("Already initialized");

		const id = this.#nextId++;
		const request = {
			jsonrpc: "2.0",
			id,
			method: "initialize",
			params: {
				protocolVersion,
				clientCapabilities: capabilities,
				clientInfo: clientName ? { name: clientName, version: clientVersion ?? "1.0.0" } : undefined,
			},
		};

		this.#emit({ direction: "out", message: request, note: "initialize" });
		const response = await this.#fetch(this.#url, {
			method: "POST",
			headers: { "content-type": "application/json", ...this.#headers },
			body: JSON.stringify(request),
		});
		if (!response.ok) throw new Error(`initialize failed: HTTP ${response.status} ${(await response.text()).trim()}`);

		const connectionId = response.headers.get(HEADER_CONNECTION_ID);
		if (!connectionId) {
			throw new Error(
				`initialize response is missing the ${HEADER_CONNECTION_ID} header ` +
					"(cross-origin calls need CORS enabled on the server: start it with --cors)",
			);
		}

		const body = await response.json();
		this.#emit({ direction: "in", message: body, note: "initialize" });
		if (body.error) throw new AcpRequestError("initialize", body.error);

		this.#connectionId = connectionId;
		await this.#openStream("connection");
		return { ...body.result, connectionId };
	}

	async newSession({ cwd, additionalDirectories = [], mcpServers = [] } = {}) {
		const result = await this.request("session/new", { cwd, additionalDirectories, mcpServers });
		const sessionId = result?.sessionId;
		if (!sessionId) throw new Error("session/new returned no sessionId");
		this.#sessions.add(sessionId);
		await this.#openStream(`session:${sessionId}`, sessionId);
		return result;
	}

	/**
	 * Resumes a stored session. Its stream is opened *before* asking, so the history
	 * the agent replays during `session/load` has somewhere to go.
	 */
	async loadSession({ sessionId, cwd, additionalDirectories = [], mcpServers = [] }) {
		if (!sessionId) throw new Error("loadSession needs a sessionId");
		await this.#ensureSessionStream(sessionId);
		return this.request("session/load", { sessionId, cwd, additionalDirectories, mcpServers });
	}

	async prompt(sessionId, prompt, { timeoutMs = 10 * 60_000 } = {}) {
		await this.#ensureSessionStream(sessionId);
		return this.request("session/prompt", { sessionId, prompt }, { sessionId, timeoutMs });
	}

	async cancel(sessionId) {
		return this.notify("session/cancel", { sessionId }, { sessionId });
	}

	/** Raw JSON-RPC request; `params.sessionId` routes it to that session's mailbox. */
	async request(method, params, { sessionId, timeoutMs = 120_000 } = {}) {
		if (!this.#connectionId) throw new Error("Call initialize() first");

		const id = this.#nextId++;
		const key = messageKey(id);
		const routedSession = sessionId ?? params?.sessionId;

		// Session-scoped responses come back on that session's SSE stream, so it has to
		// exist before the request goes out — otherwise the reply has nowhere to land.
		if (routedSession) await this.#ensureSessionStream(routedSession);

		const pending = new Promise((resolve, reject) => {
			const timer = timeoutMs
				? setTimeout(() => {
						this.#pending.delete(key);
						reject(new Error(`${method} timed out after ${timeoutMs}ms`));
					}, timeoutMs)
				: undefined;
			this.#pending.set(key, { resolve, reject, timer, method });
		});

		await this.#post({ jsonrpc: "2.0", id, method, params }, routedSession);
		return pending;
	}

	async notify(method, params, { sessionId } = {}) {
		if (!this.#connectionId) throw new Error("Call initialize() first");
		await this.#post({ jsonrpc: "2.0", method, params }, sessionId ?? params?.sessionId);
	}

	async close() {
		if (this.#closed) return;
		this.#closed = true;

		for (const controller of this.#controllers) controller.abort();
		this.#controllers.clear();
		this.#streams.clear();

		for (const [, pending] of this.#pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error("client closed"));
		}
		this.#pending.clear();

		const connectionId = this.#connectionId;
		this.#connectionId = null;
		if (connectionId) {
			await this.#fetch(this.#url, {
				method: "DELETE",
				headers: { ...this.#headers, [HEADER_CONNECTION_ID]: connectionId },
			}).catch(() => undefined);
		}
	}

	/* ------------------------------- transport ------------------------------ */

	async #post(message, sessionId) {
		const headers = { "content-type": "application/json", ...this.#headers };
		if (this.#connectionId) headers[HEADER_CONNECTION_ID] = this.#connectionId;
		if (sessionId) headers[HEADER_SESSION_ID] = sessionId;

		this.#emit({ direction: "out", message });
		const response = await this.#fetch(this.#url, { method: "POST", headers, body: JSON.stringify(message) });
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(`POST ${message.method ?? `response ${message.id}`} failed: HTTP ${response.status} ${detail.trim()}`);
		}
		const text = await response.text();
		if (text.trim()) return JSON.parse(text);
		return undefined;
	}

	/** Opens (once) the SSE mailbox that carries a session's updates and responses. */
	openSessionStream(sessionId) {
		return this.#ensureSessionStream(sessionId);
	}

	#ensureSessionStream(sessionId) {
		if (!this.#sessions.has(sessionId)) this.#sessions.add(sessionId);
		return this.#openStream(`session:${sessionId}`, sessionId);
	}
	#openStream(routeKey, sessionId) {
		const existing = this.#streams.get(routeKey);
		if (existing) return existing;

		const opening = (async () => {
			const controller = new AbortController();
			this.#controllers.add(controller);

			const headers = { accept: "text/event-stream", ...this.#headers };
			if (this.#connectionId) headers[HEADER_CONNECTION_ID] = this.#connectionId;
			if (sessionId) headers[HEADER_SESSION_ID] = sessionId;

			const response = await this.#fetch(this.#url, { method: "GET", headers, signal: controller.signal });
			if (!response.ok) {
				const detail = await response.text().catch(() => "");
				throw new Error(`opening ${routeKey} stream failed: HTTP ${response.status} ${detail.trim()}`);
			}
			if (!response.body) throw new Error(`${routeKey} stream has no body`);

			this.#emit({ direction: "transport", note: `${routeKey} stream open` });
			void this.#readStream(response.body, controller);
		})();

		opening.catch(() => this.#streams.delete(routeKey));
		this.#streams.set(routeKey, opening);
		return opening;
	}

	async #readStream(body, controller) {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });

				let boundary;
				while ((boundary = buffer.indexOf("\n\n")) !== -1) {
					const frame = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const data = frame
						.split("\n")
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.slice(5).trim())
						.join("\n");
					if (!data) continue; // keep-alive frame ("\n" comment)
					try {
						await this.#dispatch(JSON.parse(data));
					} catch (error) {
						this.#emit({ direction: "error", note: `bad SSE frame: ${error.message}` });
					}
				}
			}
		} catch (error) {
			if (!this.#closed) this.#emit({ direction: "error", note: `stream error: ${error.message}` });
		} finally {
			this.#controllers.delete(controller);
		}
	}

	async #dispatch(message) {
		this.#emit({ direction: "in", message });

		if (message && typeof message === "object" && "method" in message) {
			if ("id" in message && message.id !== undefined) await this.#answerRequest(message);
			return; // notifications are surfaced through onMessage listeners
		}

		const pending = this.#pending.get(messageKey(message?.id));
		if (!pending) return;
		this.#pending.delete(pending);
		clearTimeout(pending.timer);
		if (message.error) pending.reject(new AcpRequestError(pending.method ?? "request", message.error));
		else pending.resolve(message.result);
	}

	async #answerRequest(request) {
		const handler = this.#handlers.get(request.method);
		const result = { jsonrpc: "2.0", id: request.id };
		try {
			if (!handler) throw new Error(`no client handler registered for ${request.method}`);
			result.result = (await handler(request.params, request)) ?? {};
		} catch (error) {
			result.error = { code: -32603, message: error instanceof Error ? error.message : String(error) };
		}
		await this.#post(result, request.params?.sessionId);
	}

	#emit(event) {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				/* a broken logger must not break the transport */
			}
		}
	}
}

export default AcpHttpClient;
