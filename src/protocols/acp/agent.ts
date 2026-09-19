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
import type { SessionStore } from "../../features/session-store.js";
import { AcpSession, type PermissionMode } from "./session.js";

export const AGENT_NAME = "steve";
export const AGENT_VERSION = "0.1.0";

export interface AcpAgentOptions {
	config: AppConfig;
	logger: Logger;
	permissionMode: PermissionMode;
	/** Plugin files/directories to load for every session. */
	extensionPaths?: string[];
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
						sessionCapabilities: { additionalDirectories: {} },
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
					log: options.logger,
				});
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
					log: options.logger,
				});
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

				// Replay history first, then the command list, so the client sees a full session.
				await session.replay();
				await session.announceCommands();
				options.logger(`session/load: ${stored.id} messages=${stored.messages.length}`);
				return {};
			})

			.onRequest("session/prompt", async (ctx) => sessionFor(ctx.params.sessionId).prompt(ctx.params, ctx.signal))

			.onNotification("session/cancel", (ctx) => {
				sessions.get(ctx.params.sessionId)?.cancel();
			})
	);
}

