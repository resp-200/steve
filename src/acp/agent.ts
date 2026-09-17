import {
	PROTOCOL_VERSION,
	RequestError,
	agent as createAgentApp,
	type AgentApp,
	type ClientCapabilities,
	type Implementation,
} from "@agentclientprotocol/sdk";
import type { AppConfig } from "../config.js";
import { AcpSession, type Logger, type PermissionMode } from "./session.js";

export const AGENT_NAME = "steve";
export const AGENT_VERSION = "0.1.0";

export interface AcpAgentOptions {
	config: AppConfig;
	logger: Logger;
	permissionMode: PermissionMode;
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
						loadSession: false,
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

			.onRequest("session/new", (ctx) => {
				const id = crypto.randomUUID();
				const session = new AcpSession({
					id,
					cwd: ctx.params.cwd,
					additionalDirectories: ctx.params.additionalDirectories ?? [],
					config: options.config,
					client: ctx.client,
					clientCapabilities,
					permissionMode: options.permissionMode,
					logger: options.logger,
				});
				sessions.set(id, session);
				options.logger(`session/new: ${id} cwd=${session.cwd} tools=${session.toolNames.join(",")}`);
				return { sessionId: id };
			})

			.onRequest("session/prompt", async (ctx) => sessionFor(ctx.params.sessionId).prompt(ctx.params, ctx.signal))

			.onNotification("session/cancel", (ctx) => {
				sessions.get(ctx.params.sessionId)?.cancel();
			})
	);
}

