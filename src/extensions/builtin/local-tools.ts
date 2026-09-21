/**
 * Built-in plugin (Tier 1): the local filesystem and shell tools.
 *
 * These six tools are a *capability*, so they live in a plugin like every other
 * capability — the front ends no longer know their names or their options, they
 * only publish a policy:
 *
 *   ctx.workspace = { roots, access, shell? }
 *
 * `access` is a ladder, and each level adds tools on top of the previous one:
 *
 *   none   → nothing (an editor session that did not pass `--allow-local-tools`)
 *   read   → read_file / glob / grep
 *   write  → + write_file / edit_file        (still gated by the permission gate)
 *   exec   → + run_command                   (still gated by the permission gate)
 *
 * Safety is *not* delegated: path confinement, truncation and the permission gate
 * stay in the core, and `createLocalTools` uses them. A plugin can only narrow
 * what the front end allowed — never widen it.
 *
 * It is a Tier 1 plugin: shipped with the product, loaded by default, and its
 * failure is reported loudly rather than silently skipped.
 */
import { createLocalTools } from "../../features/local-tools.js";
import type { ExtensionAPI, PluginTool, WorkspaceAccess } from "../api.js";

/** Ladder order; `access` is compared by level, not by name. */
const LEVEL: Record<WorkspaceAccess, number> = { none: 0, read: 1, write: 2, exec: 3 };

export function localTools(pi: ExtensionAPI): void {
	const { access, roots, shell } = pi.ctx.workspace;
	if (LEVEL[access] === 0 || roots.length === 0) return;

	for (const tool of createLocalTools({
		roots,
		allowWrite: LEVEL[access] >= LEVEL.write,
		allowExec: LEVEL[access] >= LEVEL.exec,
		supportsImages: pi.ctx.session.model.supportsImages,
		...(shell ? { shell } : {}),
	})) {
		// The tool already carries its annotations (permission / metadata / describe);
		// hand them straight through like the other built-in plugins do.
		pi.registerTool(tool as unknown as PluginTool);
	}
}
