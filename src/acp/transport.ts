import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable, Writable, type Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { createNodeHttpHandler, createNodeWebSocketUpgradeHandler, type NodeWebSocketUpgradeServer } from "@agentclientprotocol/sdk/experimental/node";
import { ndJsonStream, type AgentApp } from "@agentclientprotocol/sdk";
import type { Logger } from "./session.js";

export type AcpTransport =
	| { kind: "stdio" }
	| {
			kind: "http";
			host: string;
			port: number;
			path: string;
			token?: string;
			/** Serve the bundled browser test client (default true). */
			ui: boolean;
			/** Origins allowed to call the endpoint from a browser. Empty = no CORS headers. */
			cors: string[];
	  };

export interface ServeAcpOptions {
	/** One agent app per connection. */
	createAgent: () => AgentApp;
	transport: AcpTransport;
	logger: Logger;
}

const PROJECT_ROOT = new URL("../../", import.meta.url);

/** Files served by `--ui`, relative to the project root. */
const UI_FILES = new Map<string, { file: string; type: string; inject?: boolean }>([
	["/", { file: "test-acp-jsonrpc.html", type: "text/html; charset=utf-8", inject: true }],
	["/index.html", { file: "test-acp-jsonrpc.html", type: "text/html; charset=utf-8", inject: true }],
	["/test-acp-jsonrpc.html", { file: "test-acp-jsonrpc.html", type: "text/html; charset=utf-8", inject: true }],
	["/acp-http-client.js", { file: "web/acp-http-client.js", type: "text/javascript; charset=utf-8" }],
]);

/**
 * Serves ACP over stdio (how editors launch agents) or Streamable HTTP plus
 * WebSocket (`--port`, for clients that connect over the network).
 */
export async function serveAcp(options: ServeAcpOptions): Promise<void> {
	return options.transport.kind === "stdio" ? serveStdio(options) : serveHttp(options, options.transport);
}

async function serveStdio(options: ServeAcpOptions): Promise<void> {
	if (process.stdin.isTTY) {
		options.logger("warning: stdin is a TTY; ACP over stdio expects a client that speaks JSON-RPC on it");
	}

	// stdout is the protocol channel: logs must go to stderr.
	const stream = ndJsonStream(
		Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
		Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
	);
	const connection = options.createAgent().connect(stream);
	options.logger("ACP agent ready on stdio");

	await connection.closed;
	options.logger("ACP connection closed");
}

async function serveHttp(options: ServeAcpOptions, transport: Extract<AcpTransport, { kind: "http" }>): Promise<void> {
	const server = new AcpServer({ createAgent: options.createAgent });
	const acpHandler = createNodeHttpHandler(server);

	const uiFiles = transport.ui ? resolveUiFiles(options.logger) : new Map<string, ServedFile>();
	const corsOrigin = (request: IncomingMessage): string | undefined => {
		if (transport.cors.length === 0) return undefined;
		const origin = request.headers.origin;
		if (transport.cors.includes("*")) return "*";
		return origin && transport.cors.includes(origin) ? origin : undefined;
	};

	const httpServer = createServer((request: IncomingMessage, response: ServerResponse) => {
		const path = new URL(request.url ?? "/", "http://localhost").pathname;

		// CORS is opt-in: browsers can only read/send the ACP headers when it is on.
		const allowedOrigin = corsOrigin(request);
		if (allowedOrigin) {
			response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
			response.setHeader("Vary", "Origin");
			response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
			response.setHeader(
				"Access-Control-Allow-Headers",
				"content-type, authorization, acp-connection-id, acp-session-id",
			);
			response.setHeader("Access-Control-Expose-Headers", "acp-connection-id");
			response.setHeader("Access-Control-Max-Age", "600");
			// Chrome requires this when a file:// page (or another public origin) calls localhost.
			if (request.headers["access-control-request-private-network"] === "true") {
				response.setHeader("Access-Control-Allow-Private-Network", "true");
			}
		}
		if (request.method === "OPTIONS") {
			response.writeHead(204).end();
			return;
		}

		if (path === transport.path) {
			if (transport.token && request.headers.authorization !== `Bearer ${transport.token}`) {
				response.writeHead(401, { "content-type": "text/plain" }).end("Unauthorized");
				return;
			}
			void acpHandler(request, response);
			return;
		}

		const asset = uiFiles.get(path);
		if (asset) {
			// Read on every request so edits to the page/module show up without a restart.
			const raw = readFileSync(asset.path, "utf8");
			// The page asks the server for its cwd so `session/new` can use a real path.
			const body = asset.inject ? raw.replace('"__ACP_DEFAULT_CWD__"', JSON.stringify(process.cwd())) : raw;
			response.writeHead(200, { "content-type": asset.type, "cache-control": "no-store" }).end(body);
			return;
		}

		response.writeHead(404, { "content-type": "text/plain" }).end("Not Found");
	});

	// WebSocket is optional: only wired up when the `ws` package is installed.
	const webSocketUpgrade = await attachWebSocket(server, httpServer, transport, options.logger);

	await new Promise<void>((resolve) => httpServer.listen(transport.port, transport.host, resolve));
	options.logger(`ACP Streamable HTTP endpoint listening on http://${transport.host}:${transport.port}${transport.path}`);
	if (webSocketUpgrade) options.logger(`ACP WebSocket endpoint listening on ws://${transport.host}:${transport.port}${transport.path}`);
	if (uiFiles.size > 0) options.logger(`browser test client: http://${transport.host}:${transport.port}/`);

	const shutdown = (): void => {
		options.logger("shutting down");
		httpServer.close();
		void server.close().finally(() => process.exit(0));
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);

	await new Promise<void>((resolve) => httpServer.once("close", resolve));
}

interface ServedFile {
	path: string;
	type: string;
	/** Replace the `"__ACP_DEFAULT_CWD__"` placeholder with the server's cwd. */
	inject: boolean;
}
/** Loads the browser test client from disk; missing files just disable the UI. */
function resolveUiFiles(logger: Logger): Map<string, ServedFile> {
	const files = new Map<string, ServedFile>();
	for (const [route, asset] of UI_FILES) {
		const path = fileURLToPath(new URL(asset.file, PROJECT_ROOT));
		if (!existsSync(path)) {
			if (route === "/") logger(`note: ${asset.file} not found, browser test client disabled`);
			continue;
		}
		files.set(route, { path, type: asset.type, inject: asset.inject === true });
	}
	return files;
}

type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * Attaches a WebSocket upgrade route when `ws` can be imported. `ws` is an
 * optional dependency, so a missing module simply disables WS support.
 */
async function attachWebSocket(
	server: AcpServer,
	httpServer: ReturnType<typeof createServer>,
	transport: Extract<AcpTransport, { kind: "http" }>,
	logger: Logger,
): Promise<boolean> {
	let webSocketServer: NodeWebSocketUpgradeServer;
	try {
		const specifier = "ws";
		const module = (await import(specifier)) as { WebSocketServer: new (options: { noServer: boolean }) => NodeWebSocketUpgradeServer };
		webSocketServer = new module.WebSocketServer({ noServer: true });
	} catch {
		logger("note: `ws` is not installed, serving Streamable HTTP only (npm i ws to enable the WebSocket transport)");
		return false;
	}

	const upgradeHandler: UpgradeHandler = createNodeWebSocketUpgradeHandler(server, webSocketServer);
	httpServer.on("upgrade", (request, socket, head) => {
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		if (path !== transport.path) {
			socket.destroy();
			return;
		}
		if (transport.token && request.headers.authorization !== `Bearer ${transport.token}`) {
			socket.destroy();
			return;
		}
		upgradeHandler(request, socket, head);
	});
	return true;
}
