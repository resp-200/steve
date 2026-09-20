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
import { connectMcpServers, type McpServerLike } from "../../features/mcp.js";
import type { McpServerStatus } from "../../types.js";
import { AcpSession, type PermissionMode } from "./session.js";

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
	/** Client-declared servers are tagged so `/mcp` can tell them from plugin ones. */
	const connectMcp = async (servers: McpServerLike[]) => {
		if (servers.length === 0) {
			return { tools: [] as AgentTool[], servers: [] as McpServerStatus[], close: undefined as undefined | (() => Promise<void>) };
		}
		const { connections, tools, servers: statuses } = await connectMcpServers(servers, { logger: options.logger });
		return {
			tools,
			servers: statuses,
			close: connections.length > 0 ? async () => { await Promise.all(connections.map((connection) => connection.close())); } : undefined,
		};
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
					log: options.logger,
				});
				const clientServers = (ctx.params.mcpServers ?? []).map((server) => ({ ...server, source: "client" as const }));
				const mcp = await connectMcp([...clientServers, ...extensions.mcpServers]);
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
					...(mcp.tools.length > 0 ? { mcpTools: mcp.tools } : {}),
					mcpServers: mcp.servers,
					...(mcp.close ? { closeMcp: mcp.close } : {}),
					logger: options.logger,
				});
				sessions.set(id, session);
				await session.announceCommands();
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
					log: options.logger,
				});
				const clientServers = (ctx.params.mcpServers ?? []).map((server) => ({ ...server, source: "client" as const }));
				const mcp = await connectMcp([...clientServers, ...extensions.mcpServers]);
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
					...(mcp.tools.length > 0 ? { mcpTools: mcp.tools } : {}),
					mcpServers: mcp.servers,
					...(mcp.close ? { closeMcp: mcp.close } : {}),
					restore: stored,
					logger: options.logger,
				});
				sessions.set(stored.id, session);

				// Replay history first, then the command list, so the client sees a full session.
				await session.replay();
				await session.announceCommands();
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

