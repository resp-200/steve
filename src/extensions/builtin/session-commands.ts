/**
 * Built-in plugin: the session commands every front end offers.
 *
 * It is a plugin on purpose. If our own commands could not be expressed through
 * the public extension API, that API would be wrong — and this file is the
 * cheapest way to find out.
 *
 * Everything it needs comes from `pi.ctx.session` (tools, counters, model) plus
 * `reset()`, which is exactly the introspection a third-party plugin gets.
 */
import type { ExtensionAPI } from "../api.js";

/** `128000` → `128k`, `980` → `980`: counters are read at a glance, not parsed. */
function formatTokens(tokens: number): string {
	return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens);
}

export function sessionCommands(pi: ExtensionAPI): void {
	pi.registerCommand({
		name: "tools",
		description: "List the tools this session can call.",
		run: () => {
			const tools = pi.ctx.session.tools;
			if (tools.length === 0) return "No tools registered.";
			return tools.map((tool) => `${tool.name} — ${tool.description}`).join("\n");
		},
	});

	pi.registerCommand({
		name: "stats",
		description: "Show turn and token counters.",
		run: () => {
			const stats = pi.ctx.session.stats();
			const window = pi.ctx.session.contextWindow;
			// Context fill is the number that explains an unexplained slowdown (and,
			// once compaction kicks in, a sudden drop): show it beside the counters.
			const context = stats.contextTokens === undefined || window <= 0 ? "" : ` · context ~${formatTokens(stats.contextTokens)}/${formatTokens(window)}`;
			return (
				`turns ${stats.turns} · user messages ${stats.userMessages} · tool calls ${stats.toolCalls}` +
				` · tokens in/out ${stats.inputTokens}/${stats.outputTokens}${context}`
			);
		},
	});

	pi.registerCommand({
		name: "model",
		description: "Show the model and endpoint in use.",
		run: () => {
			const model = pi.ctx.session.model;
			return `${model.id} via ${model.baseUrl} (api: ${model.api})`;
		},
	});

	pi.registerCommand({
		name: "mcp",
		description: "List the MCP servers configured for this session.",
		run: () => {
			const servers = pi.ctx.session.mcp;
			if (servers.length === 0) {
				return "No MCP servers configured. A plugin can declare one with registerMcpServer(); an ACP client can send mcpServers in session/new.";
			}
			return servers
				.map((server) => {
					const head = `${server.name} [${server.source}] ${server.transport}${server.command ? ` — ${server.command}` : ""}`;
					const detail =
						server.status === "connected"
							? `${server.tools.length} tool(s): ${server.tools.join(", ") || "none"}`
							: `${server.status} — ${server.error ?? "unknown error"}`;
					return `${head}\n  ${detail}`;
				})
				.join("\n");
		},
	});

	pi.registerCommand({
		name: "new",
		description: "Start a fresh conversation.",
		run: () => {
			pi.ctx.session.reset();
			return "Started a new conversation.";
		},
	});

	pi.registerCommand({
		name: "help",
		description: "List the commands this session understands.",
		run: () => pi.ctx.session.commands.map((command) => `/${command.name} — ${command.description}`).join("\n"),
	});
}
