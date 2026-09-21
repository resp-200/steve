/**
 * Session policy assembly, shared by every front end.
 *
 * A front end's job is to *publish* policy, not to know which capabilities exist.
 * Both the CLI and the ACP server call these two helpers, so the shape of the
 * policy (and the "what does the model support" question) exists exactly once —
 * before this file, each entry built the same object literal by hand.
 *
 * The policy types live in `types.ts` because plugins read them too; see
 * `extensions/api.ts` for the plugin-facing re-exports.
 */
import type { AppConfig } from "../model/config.js";
import type { ModelInfo, WorkspaceAccess, WorkspacePolicy } from "../types.js";

/** What plugins may know about the model before the runtime exists. */
export function modelInfo(config: AppConfig): ModelInfo {
	return {
		id: config.model.id,
		api: String(config.model.api),
		baseUrl: config.model.baseUrl,
		supportsImages: config.model.input.includes("image"),
	};
}

/**
 * The workspace policy for one session. `additionalDirectories` widens the path
 * confinement boundary (ACP clients may send them), it never widens `access`.
 */
export function workspacePolicy(options: {
	cwd: string;
	additionalDirectories?: string[];
	access: WorkspaceAccess;
}): WorkspacePolicy {
	return {
		roots: [options.cwd, ...(options.additionalDirectories ?? [])],
		access: options.access,
	};
}
