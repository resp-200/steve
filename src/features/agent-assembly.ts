/**
 * Tool assembly shared by every execution path.
 *
 * The runtime and the run worker both execute turns, and both must behave the
 * same way: front-end tools win over plugin tools, plugins may refuse a call,
 * permission-declared tools ask first, and result/context/header hooks run when
 * the plugin declared them. Keeping that wiring in one place is what makes
 * "ACP keeps working after the front end starts driving the worker" true.
 *
 * The returned {@link AgentAssembly} is deliberately passive data plus one hook
 * bag: it does not own an agent and does not execute anything, so a per-run
 * worker agent and a long-lived runtime agent can share it.
 */
import type { AfterToolCallContext, AfterToolCallResult, AgentMessage, AgentTool, BeforeToolCallContext, BeforeToolCallResult } from "./contract.js";
import type { ExtensionHost } from "../extensions/host.js";
import type { AppConfig } from "../model/config.js";
import type { KernelHooks } from "../kernel/agent.js";
import type { Logger } from "../types.js";
import { createPermissionGate, type PermissionDecision, type PermissionRequest, type ToolChangePreview } from "./permissions.js";
import { createToolRegistry, type AnnotatedTool, type ToolRegistry } from "./tool-annotations.js";
import { firstText } from "./normalize.js";

export interface AgentAssemblyOptions {
	config: AppConfig;
	/** Tools the front end provides; they win over plugin tools with the same name. */
	tools?: AgentTool<any>[];
	/** Plugins loaded for this session (their tools, hooks and counters). */
	extensions?: ExtensionHost;
	/** Where policy notices go (e.g. a plugin tool shadowed by a front-end tool). */
	logger?: Logger;
	/** Host hook used when no permission policy is configured. */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	/**
	 * Permission policy: ask before any tool that declared `permission: "ask"`
	 * (core tools and plugins alike).
	 */
	permissions?: {
		mode: "ask" | "allow";
		ask: (request: PermissionRequest) => Promise<PermissionDecision>;
		/** Fallback preview for tools that do not declare their own `describe`. */
		describe?: (request: PermissionRequest) => Promise<ToolChangePreview | undefined> | ToolChangePreview | undefined;
	};
}

export interface AgentAssembly {
	/** Registration order; front ends append MCP tools as servers connect. */
	tools: AgentTool<any>[];
	/** Declarative extras (permission / metadata / describe) keyed by tool name. */
	registry: ToolRegistry;
	/** Hooks to hand to `createKernelAgent` — the runtime's agent or a run worker's. */
	hooks: KernelHooks;
}

export function assembleAgent(options: AgentAssemblyOptions): AgentAssembly {
	const extensions = options.extensions;
	// Spread, don't rebuild: a plugin tool carries its own annotations
	// (`permission` / `metadata` / `describe`), and rebuilding the object silently
	// dropped them — which meant plugin tools were never gated and never previewed.
	const pluginTools = (extensions?.tools ?? []).map(
		(tool): AnnotatedTool => ({
			...tool,
			label: tool.label ?? tool.name,
			parameters: tool.parameters as AgentTool<any>["parameters"],
			execute: tool.execute,
		}),
	);

	/**
	 * Front-end tools come first and win: a plugin may not silently replace what the
	 * host already provides (ACP client tools vs a local-tools plugin, for instance).
	 * Replacing on purpose will need an explicit `override` flag.
	 */
	const tools: AgentTool<any>[] = [];
	const toolSource = new Map<string, string>();
	for (const tool of options.tools ?? []) {
		tools.push(tool);
		toolSource.set(tool.name, "the front end");
	}
	for (const tool of pluginTools) {
		const existing = toolSource.get(tool.name);
		if (existing) {
			options.logger?.(`tool "${tool.name}" from a plugin ignored: already provided by ${existing}`);
			continue;
		}
		tools.push(tool);
		toolSource.set(tool.name, "a plugin");
	}

	const registry = createToolRegistry(tools);

	/** Tool-declared preview wins; the host's `describe` is the fallback. */
	const describeChange = async (request: PermissionRequest): Promise<ToolChangePreview | undefined> => {
		const own = registry.describeFor(request.toolName);
		if (own) {
			const preview = await own(request.args);
			if (preview) return preview;
		}
		return options.permissions?.describe?.(request);
	};

	const permissionGate = options.permissions
		? createPermissionGate({
				mode: options.permissions.mode,
				requires: () => registry.permissionRequired(),
				ask: options.permissions.ask,
				describe: describeChange,
			})
		: undefined;

	/** Plugins may refuse a tool call before the permission gate ever asks. */
	const beforeToolCall = async (context: BeforeToolCallContext, signal?: AbortSignal) => {
		const decision = await extensions?.runToolCall({ toolName: context.toolCall.name, toolCallId: context.toolCall.id, args: context.args });
		if (decision?.block) {
			return { block: true, reason: decision.reason ?? `Blocked by an extension: ${context.toolCall.name}` };
		}
		return (permissionGate ?? options.beforeToolCall)?.(context, signal);
	};

	/** `tool_result` plugins may rewrite the result the model sees. */
	const afterToolCall = async (context: AfterToolCallContext): Promise<AfterToolCallResult | undefined> => {
		const details = (context.result as { details?: unknown } | undefined)?.details;
		const patch = await extensions!.runToolResult({
			toolName: context.toolCall.name,
			toolCallId: context.toolCall.id,
			isError: context.isError,
			text: firstText(context.result) ?? "",
			...(details !== undefined ? { details } : {}),
		});
		if (!patch) return undefined;
		return {
			...(patch.text !== undefined ? { content: [{ type: "text" as const, text: patch.text }] } : {}),
			...(patch.details !== undefined ? { details: patch.details } : {}),
			...(patch.isError !== undefined ? { isError: patch.isError } : {}),
		};
	};

	const hooks: KernelHooks = {
		...(extensions || options.beforeToolCall || permissionGate ? { beforeToolCall } : {}),
		...(extensions?.counts.toolResult ? { afterToolCall } : {}),
		...(extensions?.counts.context ? { transformContext: (messages: AgentMessage[]) => extensions.runContext(messages) } : {}),
		...(extensions?.counts.headers
			? {
					beforeProviderHeaders: (headers: Record<string, string>, model: { id: string; api: string }) =>
						extensions.runHeaders(headers, { model: model.id, api: model.api }),
				}
			: {}),
	};

	return { tools, registry, hooks };
}
