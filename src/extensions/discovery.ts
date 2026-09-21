/**
 * Plugin discovery: where plugin files come from, and the two environment
 * variables that steer it.
 *
 * Both front ends used to parse these themselves (`entries/cli.ts` had helpers,
 * `protocols/acp/main.ts` inlined the same rules), so the semantics of
 * `STEVE_EXTENSIONS` / `STEVE_DISCOVERY` existed twice. They live here now and
 * both entries call these functions.
 *
 *   <cwd>/.steve/extensions/*.mjs   project-local
 *   ~/.steve/extensions/*.mjs       global
 *   explicit paths                  `--extension <file>` / `STEVE_EXTENSIONS`
 */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Plugin paths from `STEVE_EXTENSIONS` (comma separated files or directories). */
export function pluginPaths(env: NodeJS.ProcessEnv = process.env): string[] {
	return (env.STEVE_EXTENSIONS ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/** `STEVE_DISCOVERY=off` runs with only the plugins named explicitly. */
export function discoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.STEVE_DISCOVERY ?? "").toLowerCase() !== "off";
}

function listDirectory(directory: string): string[] {
	try {
		if (!statSync(directory).isDirectory()) return [];
	} catch {
		return [];
	}

	return readdirSync(directory)
		.filter((entry) => entry.endsWith(".mjs") || entry.endsWith(".js"))
		.sort()
		.map((entry) => join(directory, entry));
}

/** Explicit paths first, then the discovered directories (deduplicated). */
export function discoverExtensionFiles(options: { cwd: string; paths?: string[]; discover?: boolean }): string[] {
	const found: string[] = [];

	for (const entry of options.paths ?? []) {
		const path = resolve(entry);
		try {
			if (statSync(path).isDirectory()) found.push(...listDirectory(path));
			else found.push(path);
		} catch {
			/* the loader turns this into a load error */
			found.push(path);
		}
	}

	if (options.discover !== false) {
		found.push(...listDirectory(join(options.cwd, ".steve", "extensions")));
		found.push(...listDirectory(join(homedir(), ".steve", "extensions")));
	}

	return [...new Set(found)];
}
