import {
	PROTOCOL_VERSION,
	RequestError,
	agent as createAgentApp,
	type AgentApp,
	type ClientCapabilities,
	type Implementation,
} from "@agentclientprotocol/sdk";
import type { AppConfig } from "../../model/config.js";
import type { Logger } from "../../types.js";
import { loadExtensions } from "../../extensions/host.js";
import type { AgentTool } from "../../features/contract.js";
import type { SessionStore } from "../../features/session-store.js";
import { connectMcpServers, type McpConnectOptions, type McpServerLike } from "../../features/mcp.js";
import type { McpServerStatus } from "../../types.js";
import { AcpSession, type PermissionMode } from "./session.js";

/** What plugins may know about the model before the session exists. */
function modelInfo(config: AppConfig): { id: string; api: string; baseUrl: string; supportsImages: boolean } {
	return {
		id: config.model.id,
		api: String(config.model.api),
		baseUrl: config.model.baseUrl,
		supportsImages: config.model.input.includes("image"),
	};
}

export const AGENT_NAME = "steve";
export const AGENT_VERSION = "0.1.0";

export interface AcpAgentOptions {
	config: AppConfig;
	logger: Logger;
	permissionMode: PermissionMode;
	/** Plugin files/directories to load for every session. */
	extensionPaths?: string[];
	/** Set false (`--no-discovery`) to skip the `.steve/extensions` directories. */
	discover?: boolean;
	/** Let sessions fall back to local file/exec tools when the client offers none. */
	allowLocalTools?: boolean;
	/** Session store; without it sessions are ephemeral and `session/load` is not offered. */
	store?: SessionStore;
}

/**
 * Builds the ACP agent app: one instance per connection.
 *
 * Handlers map ACP requests onto pi sessions:
 *   initialize     -> capability negotiation
 *   session/new    -> new pi Agent bound to the client's cwd
 *   session/prompt -> pi turn, streamed back as session/update notifications
 *   session/cancel -> pi abort
 */
export function createAcpAgentApp(options: AcpAgentOptions): AgentApp {
	const sessions = new Map<string, AcpSession>();
	let clientCapabilities: ClientCapabilities = {};
	let clientInfo: Implementation | null = null;

	const sessionFor = (sessionId: string): AcpSession => {
		const session = sessions.get(sessionId);
		if (!session) throw RequestError.invalidParams({ sessionId }, `Unknown session "${sessionId}"`);
		return session;
	};
	/**
	 * Connects the MCP servers the client asked for. A server that fails to start is
	 * logged and skipped, so a broken one never blocks the session.
	 */
	/**
	 * `setImmediate` runs after the JSON-RPC response has been written (the SDK writes
	 * it in a microtask), which is what the ACP ordering requires.
	 */
	const announceLater = (session: AcpSession): void => {
		setImmediate(() => {
			void session.announceCommands().catch((error: unknown) => options.logger(`session ${session.id}: announcing commands failed: ${String(error)}`));
		});
	};

	/** Connects in the background and hands the tools to the session when ready. */
	const connectMcpInBackground = (servers: McpServerLike[], cwd: string, id: string, session: AcpSession): void => {
		void connectMcp(servers, cwd, (status, connection) => session.attachMcpServer(status, connection)).catch((error: unknown) =>
			options.logger(`session ${id}: MCP setup failed: ${String(error)}`),
		);
	};

	/** Client-declared servers are tagged so `/mcp` can tell them from plugin ones. */
	const connectMcp = async (servers: McpServerLike[], cwd: string, onServer?: McpConnectOptions["onServer"]) => {
		if (servers.length === 0) return { tools: [] as AgentTool[], servers: [] as McpServerStatus[] };
		const { tools, servers: statuses } = await connectMcpServers(servers, { logger: options.logger, cwd, ...(onServer ? { onServer } : {}) });
		return { tools, servers: statuses };
	};

	return (
		createAgentApp({ name: AGENT_NAME })
			.onRequest("initialize", (ctx) => {
				clientCapabilities = ctx.params.clientCapabilities ?? {};
				clientInfo = ctx.params.clientInfo ?? null;

				const clientVersion = ctx.params.protocolVersion;
				options.logger(
					`initialize: client=${clientInfo ? `${clientInfo.name} ${clientInfo.version}` : "unknown"} protocolVersion=${clientVersion} fs=${Boolean(clientCapabilities.fs?.readTextFile || clientCapabilities.fs?.writeTextFile)} terminal=${Boolean(clientCapabilities.terminal)}`,
				);

				return {
					// Respond with the client's version when it is older than ours.
					protocolVersion: Math.min(clientVersion, PROTOCOL_VERSION),
					agentInfo: { name: AGENT_NAME, version: AGENT_VERSION },
					agentCapabilities: {
						loadSession: Boolean(options.store),
						promptCapabilities: {
							image: options.config.model.input.includes("image"),
							audio: false,
							embeddedContext: true,
						},
						sessionCapabilities: {
							additionalDirectories: {},
							...(options.store ? { list: {}, delete: {} } : {}),
						},
					},
				};
			})

			.onRequest("authenticate", () => ({}))

			.onRequest("session/new", async (ctx) => {
				const id = crypto.randomUUID();
				// Plugins are per session: they may register tools or hooks with session state.
				const extensions = await loadExtensions({
					cwd: ctx.params.cwd,
					mode: "acp",
					sessionId: id,
					paths: options.extensionPaths ?? [],
					discover: options.discover !== false,
					// Policy only: the local-tools plugin decides what to register.
					workspace: {
						roots: [ctx.params.cwd, ...(ctx.params.additionalDirectories ?? [])],
						access: options.allowLocalTools ? "exec" : "none",
					},
					model: modelInfo(options.config),
					log: options.logger,
				});
				const clientServers = (ctx.params.mcpServers ?? []).map((server) => ({ ...server, source: "client" as const }));
				const session = new AcpSession({
					id,
					cwd: ctx.params.cwd,
					additionalDirectories: ctx.params.additionalDirectories ?? [],
					config: options.config,
					client: ctx.client,
					clientCapabilities,
					permissionMode: options.permissionMode,
					...(options.allowLocalTools ? { allowLocalTools: true } : {}),
					...(options.store ? { store: options.store } : {}),
					extensions,
					logger: options.logger,
				});
				sessions.set(id, session);
				// Announce *after* the response: a client cannot resolve a session/update
				// for a session it has not been told about yet (IDEA then treats the whole
				// session setup as failed and retries forever).
				announceLater(session);
				// Not awaited on purpose: a slow MCP server (npx cold start) must not
				// delay the response, or editors time out and kill the agent.
				connectMcpInBackground([...clientServers, ...extensions.mcpServers], ctx.params.cwd, id, session);
				options.logger(
					`session/new: ${id} cwd=${session.cwd} tools=${session.toolNames.join(",")}${extensions.files.length > 0 ? ` plugins=${extensions.files.length}` : ""}`,
				);
				return { sessionId: id };
			})

			.onRequest("session/load", async (ctx) => {
				const stored = await options.store?.load(ctx.params.sessionId);
				if (!stored) {
					throw RequestError.invalidParams({ sessionId: ctx.params.sessionId }, `Unknown session "${ctx.params.sessionId}"`);
				}

				const cwd = ctx.params.cwd || stored.cwd;
				const extensions = await loadExtensions({
					cwd,
					mode: "acp",
					sessionId: stored.id,
					paths: options.extensionPaths ?? [],
					discover: options.discover !== false,
					workspace: {
						roots: [cwd, ...(ctx.params.additionalDirectories ?? [])],
						access: options.allowLocalTools ? "exec" : "none",
					},
					model: modelInfo(options.config),
					log: options.logger,
				});
				const clientServers = (ctx.params.mcpServers ?? []).map((server) => ({ ...server, source: "client" as const }));
				const session = new AcpSession({
					id: stored.id,
					cwd,
					additionalDirectories: ctx.params.additionalDirectories ?? [],
					config: options.config,
					client: ctx.client,
					clientCapabilities,
					permissionMode: options.permissionMode,
					...(options.allowLocalTools ? { allowLocalTools: true } : {}),
					extensions,
					...(options.store ? { store: options.store } : {}),
					restore: stored,
					logger: options.logger,
				});
				sessions.set(stored.id, session);

				// Replay history, then the command list — both after the response, for the
				// same reason as session/new.
				setImmediate(() => {
					void (async () => {
						await session.replay();
						await session.announceCommands();
					})().catch((error: unknown) => options.logger(`session ${stored.id}: replay failed: ${String(error)}`));
				});
				connectMcpInBackground([...clientServers, ...extensions.mcpServers], cwd, stored.id, session);
				options.logger(`session/load: ${stored.id} messages=${stored.messages.length}`);
				return {};
			})

			.onRequest("session/list", async (ctx) => {
				const stored = (await options.store?.list()) ?? [];
				const filtered = ctx.params.cwd ? stored.filter((entry) => entry.cwd === ctx.params.cwd) : stored;
				return { sessions: filtered.map((entry) => ({ sessionId: entry.id, cwd: entry.cwd, updatedAt: entry.updatedAt })) };
			})

			.onRequest("session/delete", async (ctx) => {
				// Drop the live session first: that aborts it and closes its MCP servers.
				sessions.get(ctx.params.sessionId)?.dispose();
				sessions.delete(ctx.params.sessionId);
				await options.store?.remove(ctx.params.sessionId);
				options.logger(`session/delete: ${ctx.params.sessionId}`);
				return {};
			})

			.onRequest("session/prompt", async (ctx) => sessionFor(ctx.params.sessionId).prompt(ctx.params, ctx.signal))

			.onNotification("session/cancel", (ctx) => {
				sessions.get(ctx.params.sessionId)?.cancel();
			})
	);
}

