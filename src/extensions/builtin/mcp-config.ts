/**
 * Built-in plugin: MCP servers declared in a JSON file.
 *
 * Files, lowest priority first (a project file wins over the global one):
 *
 *   ~/.steve/mcp.json          global, every project
 *   <cwd>/.steve/mcp.json      the project you are in
 *
 * Format — the shape Claude Desktop / Cursor use, so configs can be copied over:
 *
 *   {
 *     "mcpServers": {
 *       "amap-maps": {
 *         "command": "npx",
 *         "args": ["-y", "@amap/amap-maps-mcp-server"],
 *         "env": { "AMAP_MAPS_API_KEY": "..." },
 *         "timeoutMs": 120000
 *       }
 *     }
 *   }
 *
 * Three deliberate rules:
 *
 *   1. **Plugin declarations win.** A server declared in code (`registerMcpServer`)
 *      or by the editor (`session/new`) takes precedence over a config file, and a
 *      project file beats the global one. The loser shows up in `/mcp` as
 *      `skipped`, with the reason.
 *   2. **No `${ENV}` interpolation.** A config file that reads the environment is
 *      a plugin's job; here a value is always the literal text. That is safe
 *      because `.steve/` is gitignored — nothing in it is meant to be committed.
 *   3. **Broken entries never break the session.** A bad file, a bad entry or a
 *      malformed field is logged and skipped; the rest still loads.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, PluginMcpServer } from "../api.js";

/** Config files, lowest priority first. */
function configFiles(cwd: string): { file: string; source: "global" | "project" }[] {
	return [
		{ file: join(homedir(), ".steve", "mcp.json"), source: "global" },
		{ file: join(cwd, ".steve", "mcp.json"), source: "project" },
	];
}

/** Catches `${VAR}` so we can say out loud that it is *not* substituted. */
const INTERPOLATION = /\$\{[^}]+\}/;

/** Validates one entry. Returns undefined (and explains why) when unusable. */
function toServer(pi: ExtensionAPI, file: string, name: string, raw: unknown): PluginMcpServer | undefined {
	const where = `[mcp.json] ${file}: "${name}"`;
	const trimmed = name.trim();
	if (!trimmed) {
		pi.ctx.log(`${where}: empty server name, skipped`);
		return undefined;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		pi.ctx.log(`${where}: expected an object, skipped`);
		return undefined;
	}

	const entry = raw as Record<string, unknown>;
	const type = typeof entry.type === "string" ? entry.type : undefined;
	const command = typeof entry.command === "string" ? entry.command.trim() : "";
	// stdio is the default transport and the only one implemented, so it needs a command.
	if (!command && (!type || type === "stdio")) {
		pi.ctx.log(`${where}: missing "command", skipped`);
		return undefined;
	}

	let args: string[] = [];
	if (entry.args !== undefined) {
		if (!Array.isArray(entry.args) || entry.args.some((value) => typeof value !== "string")) {
			pi.ctx.log(`${where}: "args" must be an array of strings, skipped`);
			return undefined;
		}
		args = entry.args as string[];
	}

	const env: { name: string; value: string }[] = [];
	if (entry.env !== undefined) {
		if (!entry.env || typeof entry.env !== "object" || Array.isArray(entry.env)) {
			pi.ctx.log(`${where}: "env" must be an object, skipped`);
			return undefined;
		}
		for (const [key, value] of Object.entries(entry.env as Record<string, unknown>)) {
			if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
				pi.ctx.log(`${where}: env ${key} must be a string, ignored`);
				continue;
			}
			const text = String(value);
			if (INTERPOLATION.test(text)) {
				pi.ctx.log(`${where}: env ${key} looks like \${...} — interpolation is not supported, the literal text is passed`);
			}
			env.push({ name: key, value: text });
		}
	}

	let timeoutMs: number | undefined;
	if (entry.timeoutMs !== undefined) {
		if (typeof entry.timeoutMs === "number" && Number.isFinite(entry.timeoutMs) && entry.timeoutMs > 0) {
			timeoutMs = entry.timeoutMs;
		} else {
			pi.ctx.log(`${where}: "timeoutMs" must be a positive number, ignored`);
		}
	}

	return {
		name: trimmed,
		command,
		args,
		env,
		...(type ? { type } : {}),
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
	};
}

export function mcpConfig(pi: ExtensionAPI): void {
	for (const { file, source } of configFiles(pi.ctx.cwd)) {
		if (!existsSync(file)) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			pi.ctx.log(`[mcp.json] ${file}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}

		const declared = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
		if (!declared || typeof declared !== "object" || Array.isArray(declared)) {
			pi.ctx.log(`[mcp.json] ${file}: expected { "mcpServers": { "<name>": { "command": "..." } } }`);
			continue;
		}

		let registered = 0;
		for (const [name, raw] of Object.entries(declared)) {
			const server = toServer(pi, file, name, raw);
			if (!server) continue;
			pi.registerMcpServer({ ...server, source });
			registered += 1;
		}
		pi.ctx.log(`[mcp.json] ${file}: ${registered} server(s)`);
	}
}
