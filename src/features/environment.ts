/**
 * Environment snapshot: the external conditions one run may rely on
 * (docs/personal-agent.md §4.4 and §5.4).
 *
 * A run used to close over its policy: the workspace policy, model info, tool
 * approvals and projection were assembled inline by each front end and could
 * never be inspected afterwards. This module turns that implicit closure into
 * one plain object, so "what was allowed when this run happened" is a question
 * the event log can answer (`run.started.environment`, the future `/env`).
 *
 * The snapshot is deliberately a pure value: no functions, no runtime objects,
 * no `AppConfig` (which carries credentials). It is JSON-serializable by
 * construction, and every entry builds it through this single function.
 *
 * Policy assembly for plugins still happens earlier, because plugins are loaded
 * before tools exist; the snapshot is taken once the runtime knows its tools.
 */
import type { ModelInfo, ShellCommand, WorkspaceAccess, WorkspacePolicy } from "../types.js";
import type { ProjectionPolicy, RunMode } from "./events.js";

/** One tool the run may call, flattened from the registry's annotations. */
export interface EnvironmentTool {
	name: string;
	permissionRequired: boolean;
	/** Presentation kind the tool declared, if any. */
	kind?: string;
}

/**
 * Everything outside the agent that shapes one run. Plain data by design:
 * serializable, comparable, and safe to write into the event log.
 */
export interface EnvironmentSnapshot {
	cwd: string;
	/** Paths the run may touch, first entry is the session cwd. */
	roots: string[];
	access: WorkspaceAccess;
	/** Shell override the workspace policy declared, if it declared one. */
	shell?: ShellCommand;
	/** Tools the runtime offers, sorted by name. */
	tools: EnvironmentTool[];
	permissionMode: "ask" | "allow";
	model: ModelInfo;
	/** Extension host files loaded for this session. */
	plugins: string[];
	projection: ProjectionPolicy;
	mode: RunMode;
}

/** What an entry knows when it takes the snapshot (tools exist by then). */
export interface EnvironmentOptions {
	cwd: string;
	/** Already-resolved workspace policy; its roots/access/shell are copied. */
	workspace: WorkspacePolicy;
	/** Model facts only — never the config, which holds credentials. */
	model: ModelInfo;
	/** Tool annotations from the runtime's registry. */
	tools: readonly { name: string; permissionRequired?: boolean; kind?: string }[];
	permissionMode: "ask" | "allow";
	plugins?: readonly string[];
	projection: ProjectionPolicy;
	/** Defaults to `foreground`: a snapshot taken by an entry serves a person. */
	mode?: RunMode;
}

/**
 * Build a fresh, detached snapshot. Ordering and de-duplication are normalized
 * here so two runs with the same inputs compare equal regardless of registry
 * insertion order (that equality is what `environment-test` asserts between the
 * CLI and ACP entries).
 */
export function snapshotEnvironment(options: EnvironmentOptions): EnvironmentSnapshot {
	const roots = [...new Set(options.workspace.roots)];

	const byName = new Map<string, EnvironmentTool>();
	for (const tool of options.tools) {
		// First declaration wins: the runtime builds `catalog` with front-end tools
		// before plugin tools, so the front end's annotation is the authoritative one.
		if (typeof tool?.name !== "string" || tool.name.length === 0 || byName.has(tool.name)) continue;
		byName.set(tool.name, {
			name: tool.name,
			permissionRequired: tool.permissionRequired === true,
			...(tool.kind ? { kind: tool.kind } : {}),
		});
	}
	const tools = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));

	const shell = options.workspace.shell;

	return {
		cwd: options.cwd,
		roots,
		access: options.workspace.access,
		...(shell ? { shell: { file: shell.file, args: [...shell.args] } } : {}),
		tools,
		permissionMode: options.permissionMode,
		model: {
			id: options.model.id,
			api: options.model.api,
			baseUrl: options.model.baseUrl,
			supportsImages: options.model.supportsImages,
		},
		plugins: [...new Set(options.plugins ?? [])].sort(),
		projection: { ...options.projection },
		mode: options.mode ?? "foreground",
	};
}
