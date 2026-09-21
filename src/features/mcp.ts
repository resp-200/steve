/**
 * Minimal MCP (Model Context Protocol) client.
 *
 * ACP clients hand us `mcpServers` on `session/new` / `session/load`; we connect
 * to each of them, list their tools, and expose them as ordinary agent tools so
 * the model can call them. Only the **stdio** transport is implemented (that is
 * what editors send for local servers); `http`/`sse`/`acp` transports are
 * reported as unsupported instead of silently ignored.
 *
 * Zero dependencies: MCP's stdio framing is newline-delimited JSON-RPC 2.0.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Type, type AgentTool } from "./contract.js";
import type { AnnotatedTool } from "./tool-annotations.js";
import type { Logger, McpServerStatus } from "../types.js";

/** What an ACP client sends for a local MCP server. */
export interface McpServerSpec {
	name: string;
	command: string;
	args: string[];
	env: { name: string; value: string }[];
}

export interface McpServerLike {
	name: string;
	type?: string;
	/** Who declared it. Defaults to `plugin`: untagged specs come from the host. */
	source?: "plugin" | "client" | "project" | "global";
	/** Per-server override of `McpConnectOptions.timeoutMs` (npx cold starts are slow). */
	timeoutMs?: number;
	command?: string;
	args?: string[];
	env?: { name: string; value: string }[];
}

export interface McpConnection {
	/** Server name as reported by the client. */
	readonly name: string;
	/** Tools, named `mcp__<server>__<tool>` to keep provenance obvious. */
	readonly tools: AgentTool<any>[];
	/** The server's own tool names, without our prefix (for `/mcp`). */
	readonly toolNames: string[];
	close(): Promise<void>;
}

export interface McpConnectOptions {
	/** Per-request timeout. Default: 20s. */
	timeoutMs?: number;
	logger?: Logger;
	/**
	 * Working directory for the server process. Without it a server inherits the
	 * directory steve was launched from — wrong for editors, which spawn the ACP
	 * server elsewhere while the session belongs to a project.
	 */
	cwd?: string;
	/**
	 * Called as soon as each server settles (connected / failed / unsupported).
	 * Callers that attach tools to a live session use this: waiting for the whole
	 * batch would let one slow server (npx cold start) hold back the others.
	 */
	onServer?: (status: McpServerStatus, connection?: McpConnection) => void;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

/** The MCP revision we speak; servers negotiate down if they must. */
const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "steve", version: "0.1.0" };

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const part = block as { type?: string; text?: string; uri?: string; mimeType?: string };
			if (part.type === "text") return part.text ?? "";
			if (part.type === "image") return `[image ${part.mimeType ?? "unknown"}]`;
			if (part.type === "resource") return `[resource ${part.uri ?? "unknown"}]`;
			return `[${part.type ?? "unknown"}]`;
		})
		.join("\n")
		.trim();
}

/** Connects to one MCP server over stdio and returns its tools. */
export async function connectMcpServer(server: McpServerSpec, options: McpConnectOptions = {}): Promise<McpConnection> {
	const timeoutMs = options.timeoutMs ?? 20_000;
	const logger = options.logger ?? ((): void => {});
	const child: ChildProcessWithoutNullStreams = spawn(server.command, server.args, {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...Object.fromEntries((server.env ?? []).map((entry) => [entry.name, entry.value])) },
		...(options.cwd ? { cwd: options.cwd } : {}),
	});

	const pending = new Map<number, PendingRequest>();
	let nextId = 1;
	let buffer = "";
	let closed = false;
	/** Last few stderr lines: when a server dies, this is usually the reason. */
	const stderrTail: string[] = [];

	const fail = (error: Error): void => {
		for (const [id, request] of pending) {
			clearTimeout(request.timer);
			pending.delete(id);
			request.reject(error);
		}
	};

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (!line) continue;

			let message: { id?: number; result?: unknown; error?: { message?: string } };
			try {
				message = JSON.parse(line);
			} catch {
				logger(`[mcp ${server.name}] ignoring non-JSON line: ${line.slice(0, 120)}`);
				continue;
			}

			if (typeof message.id !== "number") continue; // notifications/requests from the server are ignored
			const request = pending.get(message.id);
			if (!request) continue;
			pending.delete(message.id);
			clearTimeout(request.timer);
			if (message.error) request.reject(new Error(message.error.message ?? "MCP error"));
			else request.resolve(message.result);
		}
	});

	// A missing binary never reaches "exit": it emits "error", which must be handled
	// or the whole process dies with an unhandled error event.
	child.on("error", (error) => {
		closed = true;
		fail(error instanceof Error ? error : new Error(String(error)));
	});

	child.on("exit", (code, signal) => {
		closed = true;
		// Server stderr is the only explanation we get for a failed handshake
		// (a missing API key, a bad command line, ...), so carry it into the error.
		const reason = stderrTail.length > 0 ? `: ${stderrTail[stderrTail.length - 1]}` : "";
		fail(new Error(`MCP server "${server.name}" exited (code ${code ?? "null"}, signal ${signal ?? "none"})${reason}`));
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		const text = chunk.trim();
		if (!text) return;
		for (const line of text.split("\n")) {
			stderrTail.push(line.slice(0, 200));
			if (stderrTail.length > 3) stderrTail.shift();
		}
		logger(`[mcp ${server.name}] ${text.split("\n")[0]?.slice(0, 200)}`);
	});

	const request = (method: string, params: unknown): Promise<unknown> => {
		if (closed) return Promise.reject(new Error(`MCP server "${server.name}" is not running`));
		const id = nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			pending.set(id, { resolve, reject, timer });
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	};

	const notify = (method: string, params: unknown): void => {
		if (closed) return;
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	};

	const close = async (): Promise<void> => {
		closed = true;
		fail(new Error(`MCP server "${server.name}" closed`));
		child.stdin.end();
		child.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 1_000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	};

	try {
		await request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
		notify("notifications/initialized", {});

		const listed = (await request("tools/list", {})) as { tools?: unknown[] };
		const toolNames: string[] = [];
		const tools = (Array.isArray(listed?.tools) ? listed.tools : []).map((entry): AnnotatedTool => {
			const tool = entry as { name?: string; description?: string; inputSchema?: unknown };
			const remoteName = tool.name ?? "unnamed";
			const name = `mcp__${server.name}__${remoteName}`;
			toolNames.push(remoteName);

			return {
				name,
				label: `${server.name}: ${remoteName}`,
				description: tool.description ?? `MCP tool ${remoteName} from ${server.name}.`,
				// MCP tools can do whatever their server can: always ask first.
				permission: "ask",
				metadata: { kind: "other", title: `${server.name}: ${remoteName}` },
				// MCP ships plain JSON Schema, which is what pi validates against.
				parameters: (tool.inputSchema ?? Type.Object({})) as AgentTool<any>["parameters"],
				execute: async (_toolCallId, params: unknown) => {
					const args = (params ?? {}) as Record<string, unknown>;
					const result = (await request("tools/call", { name: remoteName, arguments: args })) as {
						content?: unknown;
						isError?: boolean;
					};
					const text = textOf(result?.content) || "(no output)";
					if (result?.isError) throw new Error(text);
					return { content: [{ type: "text", text }], details: { server: server.name, tool: remoteName } };
				},
			};
		});

		logger(`[mcp ${server.name}] connected, ${tools.length} tool(s)`);
		return { name: server.name, tools, toolNames, close };
	} catch (error) {
		await close();
		throw error;
	}
}

/**
 * Explicit declarations (plugin code, the editor) beat config files, and a
 * project config file beats the global one. Names must be unique after this:
 * two servers with one name would produce colliding `mcp__<server>__<tool>` tools.
 */
const SOURCE_PRIORITY: Record<NonNullable<McpServerLike["source"]>, number> = {
	plugin: 3,
	client: 3,
	project: 2,
	global: 1,
};

/**
 * Connects every server the client asked for. A server that fails to start is
 * logged and skipped: one broken MCP server must not sink the whole session.
 */
export async function connectMcpServers(
	servers: McpServerLike[],
	options: McpConnectOptions = {},
): Promise<{ connections: McpConnection[]; tools: AgentTool<any>[]; errors: string[]; servers: McpServerStatus[] }> {
	const logger = options.logger ?? ((): void => {});
	const connections: McpConnection[] = [];
	const errors: string[] = [];
	/** One entry per declared server, in declaration order, failures included. */
	const statuses: McpServerStatus[] = [];

	// One winner per name: highest source priority first, ties to the earlier one.
	const winners = new Map<string, McpServerLike>();
	for (const server of [...servers].sort((a, b) => SOURCE_PRIORITY[b.source ?? "plugin"] - SOURCE_PRIORITY[a.source ?? "plugin"])) {
		if (!winners.has(server.name)) winners.set(server.name, server);
	}

	/** Everything `/mcp` shows about a server except its outcome. */
	const describe = (server: McpServerLike): Omit<McpServerStatus, "status" | "tools"> => ({
		name: server.name,
		source: server.source ?? "plugin",
		transport: server.type ?? "stdio",
		...(server.command ? { command: [server.command, ...(server.args ?? [])].join(" ") } : {}),
	});

	for (const server of servers) {
		const winner = winners.get(server.name);
		if (winner !== server) {
			const message = `MCP server "${server.name}" (${server.source ?? "plugin"}) ignored: the ${winner?.source ?? "plugin"} declaration wins`;
			errors.push(message);
			const skipped: McpServerStatus = { ...describe(server), status: "skipped", tools: [], error: message };
			statuses.push(skipped);
			options.onServer?.(skipped);
			logger(`[mcp] ${message}`);
			continue;
		}

		if (server.type && server.type !== "stdio") {
			const message = `MCP server "${server.name}": transport "${server.type}" is not supported yet (only stdio)`;
			errors.push(message);
			const unsupported: McpServerStatus = { ...describe(server), status: "unsupported", tools: [], error: message };
			statuses.push(unsupported);
			options.onServer?.(unsupported);
			logger(`[mcp] ${message}`);
			continue;
		}

		if (!server.command) {
			const message = `MCP server "${server.name}": missing command`;
			errors.push(message);
			const missing: McpServerStatus = { ...describe(server), status: "failed", tools: [], error: message };
			statuses.push(missing);
			options.onServer?.(missing);
			logger(`[mcp] ${message}`);
			continue;
		}

		try {
			const connection = await connectMcpServer(
				{ name: server.name, command: server.command, args: server.args ?? [], env: server.env ?? [] },
				{ ...options, ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}) },
			);
			connections.push(connection);
			const connected: McpServerStatus = { ...describe(server), status: "connected", tools: connection.toolNames };
			statuses.push(connected);
			options.onServer?.(connected, connection);
		} catch (error) {
			const message = `MCP server "${server.name}": ${error instanceof Error ? error.message : String(error)}`;
			errors.push(message);
			const failed: McpServerStatus = { ...describe(server), status: "failed", tools: [], error: message };
			statuses.push(failed);
			options.onServer?.(failed);
			logger(`[mcp] ${message}`);
		}
	}

	return { connections, tools: connections.flatMap((connection) => connection.tools), errors, servers: statuses };
}
