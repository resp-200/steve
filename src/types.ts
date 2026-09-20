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
	/** Where the declaration came from: a plugin, or the ACP client's `session/new`. */
	source: "plugin" | "client";
	/** Transport as declared; `stdio` when the spec did not say. */
	transport: string;
	/** Command line of a stdio server, for display. */
	command?: string;
	status: "connected" | "failed" | "unsupported";
	/** Remote tool names, without the `mcp__<server>__` prefix. */
	tools: string[];
	error?: string;
}
