#!/usr/bin/env node
import process from "node:process";
import { join } from "node:path";
import { createAcpAgentApp, AGENT_NAME, AGENT_VERSION } from "./agent.js";
import { createSessionStore } from "../../features/session-store.js";
import { loadConfig } from "../../model/config.js";
import type { PermissionMode } from "./session.js";
import { serveAcp, type AcpTransport } from "./transport.js";

const USAGE = `
${AGENT_NAME} ${AGENT_VERSION} — Agent Client Protocol (ACP) server

Usage
  ${AGENT_NAME}-acp [options]

Transport
  --transport <stdio|http>   default: stdio, or http when --port is given
  --port <n>                 listen on a TCP port (Streamable HTTP + WebSocket)
  --host <addr>              bind address for http transport (default 127.0.0.1)
  --path <path>              ACP endpoint path for http transport (default /acp)
  --token <token>            require "Authorization: Bearer <token>" on http transport
  --ui / --no-ui             serve the browser test client on / (default on)
  --cors <origins>           allow browser origins, comma separated or * (default off)
  --extension <path>         load a plugin, repeatable (or STEVE_EXTENSIONS=a,b)
  --no-discovery             skip .steve/extensions discovery (or STEVE_DISCOVERY=off)
  --allow-local-tools        let sessions use local file/exec tools when the client offers none
  --session-dir <path>       where transcripts live (default <cwd>/.steve/sessions)
  --no-sessions              keep sessions ephemeral (no persistence, no session/load)

Behaviour
  --permissions <ask|allow>  ask the editor before write/run tools (default ask)
  --quiet                    only log warnings and errors
  --help                     show this help

Environment
  ACP_TRANSPORT, ACP_PORT, ACP_HOST, ACP_PATH, ACP_TOKEN, ACP_PERMISSIONS, ACP_CORS, ACP_UI

Editors normally launch this over stdio:
  { "command": "node", "args": ["dist/protocols/acp/main.js"] }
`.trim();

interface CliOptions {
	transport: AcpTransport;
	permissionMode: PermissionMode;
	/** Plugin files/directories to load per session. */
	extensionPaths: string[];
	/** Where transcripts are persisted (`--session-dir`, default `<cwd>/.steve/sessions`). */
	sessionDir?: string;
	/** `--no-sessions` disables persistence and the `session/load` capability. */
	noSessions: boolean;
	/** Fall back to local file/exec tools when the client offers none (default off). */
	allowLocalTools: boolean;
	/** `--no-discovery` skips `.steve/extensions` discovery (explicit plugins only). */
	discover: boolean;
	quiet: boolean;
}

const BOOLEAN_FLAGS = new Set(["--quiet", "--ui", "--no-ui", "--allow-local-tools", "--no-sessions", "--no-discovery"]);
function parseArgs(argv: string[]): CliOptions | "help" {
	const values = new Map<string, string>();
	const extensionPaths: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		if (arg === "--help" || arg === "-h") return "help";
		if (BOOLEAN_FLAGS.has(arg)) {
			values.set(arg.slice(2), "true");
			continue;
		}
		if (arg.startsWith("--")) {
			const [flag, inline] = arg.slice(2).split("=");
			const value = inline ?? argv[index + 1] ?? "";
			if (inline === undefined) index += 1;
			if (flag === "extension") {
				if (value) extensionPaths.push(value);
				continue;
			}
			if (flag) values.set(flag, value);
		}
	}

	const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;
	const pick = (flag: string, envName: string): string | undefined => values.get(flag) ?? env(envName);

	const portValue = pick("port", "ACP_PORT");
	const port = portValue ? Number.parseInt(portValue, 10) : undefined;
	if (portValue && (!Number.isFinite(port) || (port ?? 0) <= 0)) {
		throw new Error(`Invalid --port "${portValue}"`);
	}

	const kind = pick("transport", "ACP_TRANSPORT")?.toLowerCase() ?? (port ? "http" : "stdio");
	if (kind !== "stdio" && kind !== "http") {
		throw new Error(`Invalid --transport "${kind}" (expected stdio or http)`);
	}
	if (kind === "http" && !port) {
		throw new Error("--transport http requires --port <n> (or ACP_PORT)");
	}

	const permissionMode = (pick("permissions", "ACP_PERMISSIONS")?.toLowerCase() ?? "ask") as PermissionMode;
	if (permissionMode !== "ask" && permissionMode !== "allow") {
		throw new Error(`Invalid --permissions "${permissionMode}" (expected ask or allow)`);
	}

	const token = pick("token", "ACP_TOKEN");
	const cors = (pick("cors", "ACP_CORS") ?? "")
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean);
	const ui = values.has("no-ui")
		? false
		: (pick("ui", "ACP_UI") ?? "true").toLowerCase() !== "false";

	return {
		transport:
			kind === "stdio"
				? { kind: "stdio" }
				: {
						kind: "http",
						host: pick("host", "ACP_HOST") ?? "127.0.0.1",
						port: port as number,
						path: pick("path", "ACP_PATH") ?? "/acp",
						ui,
						cors,
						...(token ? { token } : {}),
					},
		permissionMode,
		extensionPaths: [
			...extensionPaths,
			...(process.env.STEVE_EXTENSIONS ?? "")
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean),
		],
		discover: !values.has("no-discovery") && (process.env.STEVE_DISCOVERY ?? "").toLowerCase() !== "off",
		allowLocalTools: values.has("allow-local-tools") || (process.env.ACP_ALLOW_LOCAL_TOOLS ?? "").toLowerCase() === "true",
		...(pick("session-dir", "ACP_SESSION_DIR") ? { sessionDir: pick("session-dir", "ACP_SESSION_DIR") as string } : {}),
		noSessions: values.has("no-sessions"),
		quiet: values.get("quiet") === "true",
	};
}

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv.slice(2));
	if (parsed === "help") {
		process.stdout.write(`${USAGE}\n`);
		return;
	}

	const config = loadConfig();
	const log = (message: string): void => {
		if (!parsed.quiet) process.stderr.write(`[acp] ${message}\n`);
	};
	const warn = (message: string): void => {
		process.stderr.write(`[acp] ${message}\n`);
	};

	// stdout carries the JSON-RPC stream in stdio mode, so status goes to stderr.
	log(`${AGENT_NAME} ${AGENT_VERSION} · model=${config.model.id} api=${config.model.api} auth=${config.authStyle}`);
	log(`transport=${parsed.transport.kind} permissions=${parsed.permissionMode}`);
	if (parsed.extensionPaths.length > 0) log(`extensions=${parsed.extensionPaths.join(",")}`);

	// Transcripts make `session/load` possible; `--no-sessions` keeps sessions ephemeral.
	const store = parsed.noSessions
		? undefined
		: createSessionStore({
				dir: parsed.sessionDir ?? join(process.cwd(), ".steve", "sessions"),
				logger: warn,
			});
	if (store) log(`sessions dir=${store.dir}`);

	await serveAcp({
		createAgent: () =>
			createAcpAgentApp({
				config,
				permissionMode: parsed.permissionMode,
				extensionPaths: parsed.extensionPaths,
				...(parsed.allowLocalTools ? { allowLocalTools: true } : {}),
				...(store ? { store } : {}),
				logger: warn,
			}),
		transport: parsed.transport,
		logger: log,
	});
}

main().catch((error: unknown) => {
	process.stderr.write(`[acp] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
