/**
 * Example plugin: wiring up MCP servers (stdio only).
 *
 * Copy this file to `.steve/extensions/` (project-local, auto-discovered) or
 * `~/.steve/extensions/` (global), or point at it explicitly:
 *
 *   STEVE_EXTENSIONS=examples/extensions/mcp-server.mjs npm run dev
 *   npm run acp -- --extension examples/extensions/mcp-server.mjs
 *
 * Then check the result with the `/mcp` command — it lists every configured
 * server with its source, command line, tools, or the reason it failed.
 *
 * What the core does with a registered server:
 *   - spawns it, speaks MCP over stdio (newline-delimited JSON-RPC), lists tools
 *   - exposes each tool as `mcp__<server>__<tool>` (its `inputSchema` becomes the
 *     parameter schema, so the model sees the real argument types)
 *   - asks the user before every MCP tool call (MCP servers can do anything they
 *     can do; the gate is not negotiable from a plugin)
 *   - closes the child process when the session ends
 *   - a server that fails to start is logged and skipped: one broken server never
 *     sinks the session
 *
 * Secrets: read them from the environment of the steve process (`.env` is loaded
 * by the CLI) and pass them through `env`. Never hardcode a key here.
 */
export default function mcpServers(pi) {
	// A server that needs a key. `npx -y <pkg>` downloads on first use, which can
	// take longer than the 20s handshake default — hence `timeoutMs`.
	const amapKey = process.env.AMAP_MAPS_API_KEY?.trim() ?? "";
	if (!amapKey) pi.ctx.log("AMAP_MAPS_API_KEY is empty — amap-maps will fail to authenticate");

	pi.registerMcpServer({
		name: "amap-maps",
		command: "npx",
		args: ["-y", "@amap/amap-maps-mcp-server"],
		env: [{ name: "AMAP_MAPS_API_KEY", value: amapKey }],
		timeoutMs: 120_000,
	});

	// A server with no secrets, already cached or installed globally.
	pi.registerMcpServer({
		name: "filesystem",
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-filesystem", pi.ctx.cwd],
		timeoutMs: 120_000,
	});
}
