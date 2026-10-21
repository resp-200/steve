import { readFileSync } from "node:fs";

/**
 * The one place the package version is read.
 *
 * `package.json` is the single source of truth — not a constant here — so a bump
 * can never leave a front end behind (the ACP `initialize` handshake used to say
 * `0.1.0` while the package was already `0.1.2`). `src/model/` and `dist/model/`
 * sit two levels under the package root, so `../../package.json` resolves the same
 * in `tsx`, in the built output, and in an installed `node_modules/@zhyoung/steve/`.
 */
function readVersion(): string {
	try {
		const file = new URL("../../package.json", import.meta.url);
		const pkg: unknown = JSON.parse(readFileSync(file, "utf8"));
		const version = (pkg as { version?: unknown } | null)?.version;
		if (typeof version === "string" && version.length > 0) return version;
	} catch {
		/* 打包/裁剪过的部署（没有 package.json）走下面的兜底 */
	}
	return "0.0.0-unknown";
}

/** e.g. `"0.1.2"` — `steve --version`, the ACP handshake and the MCP client info. */
export const VERSION = readVersion();
