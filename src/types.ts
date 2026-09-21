/**
 * Cross-layer types.
 *
 * Deliberately dependency-free: every layer may import this module without
 * reaching into another layer just to name a type.
 */

/** Diagnostic sink. The CLI writes to stdout, the ACP transports write to stderr. */
export type Logger = (message: string) => void;

/**
 * A configured MCP server, as reported to plugins and front ends (the `/mcp` command).
 *
 * Display-only: the live connection lives in `features/mcp.ts`. This shape lives
 * here because both the feature layer (which builds it) and the extension layer
 * (which shows it to plugins) need to name it without importing each other.
 */
export interface McpServerStatus {
	name: string;
	/**
	 * Where the declaration came from: a plugin, the ACP client's `session/new`,
	 * or one of the `.steve/mcp.json` config files (project beats global).
	 */
	source: "plugin" | "client" | "project" | "global";
	/** Transport as declared; `stdio` when the spec did not say. */
	transport: string;
	/** Command line of a stdio server, for display. */
	command?: string;
	status: "connected" | "failed" | "unsupported" | "skipped";
	/** Remote tool names, without the `mcp__<server>__` prefix. */
	tools: string[];
	error?: string;
}

/** How a command tool launches a shell (`sh -lc` on POSIX, `cmd.exe /d /s /c` on Windows). */
export interface ShellCommand {
	file: string;
	args: string[];
}

/**
 * How far a session may reach into the local machine. A ladder: every level adds
 * tools on top of the previous one.
 *
 * The front end publishes this; plugins only *read* it. Core keeps the enforcement
 * (path confinement, the permission gate) — a plugin can never widen it.
 */
export type WorkspaceAccess = "none" | "read" | "write" | "exec";

/** What a session is allowed to do locally, published before plugins load. */
export interface WorkspacePolicy {
	/** Path confinement boundary: every path a tool touches must resolve inside one of these. */
	roots: string[];
	access: WorkspaceAccess;
	/** Shell command tools should use; defaults to the platform shell. */
	shell?: ShellCommand;
}

/** What is known about the model before the runtime exists (plugins may branch on it). */
export interface ModelInfo {
	id: string;
	api: string;
	baseUrl: string;
	supportsImages: boolean;
}
