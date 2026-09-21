/**
 * Tool annotations: the declarative extras a tool carries about itself.
 *
 * Tools — core ones and plugin ones alike — declare
 *
 *   - `permission`: whether the user must approve a call,
 *   - `metadata`:   how a client should present the call (kind / title),
 *   - `describe`:   what the call is about to change (approval preview).
 *
 * The registry below turns a flat tool list into lookups, so the protocol layer
 * and the permission gate no longer need their own hard-coded tables of tool
 * names. Annotations are *advisory*: the gate and the path confinement in the
 * core still decide what actually runs.
 */
import type { AgentTool, TSchema } from "./contract.js";
import type { ToolChangePreview } from "./permissions.js";

export interface ToolAnnotations {
	/** `ask` makes the core permission gate ask before this tool runs. */
	permission?: "ask" | "auto";
	/** Presentation hints; `title` may be a function of the call arguments. */
	metadata?: {
		kind?: string;
		title?: string | ((args: unknown) => string);
	};
	/** Explains what the call will change, for the approval prompt. */
	describe?: (args: unknown) => Promise<ToolChangePreview | undefined> | ToolChangePreview | undefined;
}

/** A tool plus its annotations (pi ignores the extra fields). */
export type AnnotatedTool<T extends TSchema = TSchema> = AgentTool<T> & ToolAnnotations;

export interface ToolRegistry {
	/** Adds a tool that showed up after the session started (MCP connects in the background). */
	add(tool: AgentTool<any>): void;
	/** Names of the tools that ask for approval. */
	permissionRequired(): string[];
	/** Presentation kind a tool declared, if any. */
	kindFor(toolName: string): string | undefined;
	/** Static or computed title a tool declared, if any. */
	titleFor(toolName: string, args: unknown): string | undefined;
	/** The tool's own preview callback, if it declared one. */
	describeFor(toolName: string): ToolAnnotations["describe"];
}

export function annotationsOf(tool: AgentTool<any>): ToolAnnotations {
	const annotated = tool as AnnotatedTool;
	return {
		...(annotated.permission ? { permission: annotated.permission } : {}),
		...(annotated.metadata ? { metadata: annotated.metadata } : {}),
		...(annotated.describe ? { describe: annotated.describe } : {}),
	};
}

export function createToolRegistry(tools: AgentTool<any>[]): ToolRegistry {
	const byName = new Map<string, AnnotatedTool>();
	for (const tool of tools) byName.set(tool.name, tool as AnnotatedTool);

	return {
		add: (tool) => {
			byName.set(tool.name, tool as AnnotatedTool);
		},

		permissionRequired: () =>
			tools.filter((tool) => (tool as AnnotatedTool).permission === "ask").map((tool) => tool.name),

		kindFor: (toolName) => byName.get(toolName)?.metadata?.kind,

		titleFor: (toolName, args) => {
			const title = byName.get(toolName)?.metadata?.title;
			if (typeof title === "function") return title(args);
			return title;
		},

		describeFor: (toolName) => byName.get(toolName)?.describe,
	};
}
