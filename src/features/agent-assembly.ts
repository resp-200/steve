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
import { createContextCompactor, type CompactionResult, type ContextCompactor } from "./compaction-hook.js";
import { resolveCompactionPolicy } from "./compaction.js";
import { createSummaryStreamer, type SummaryStreamer } from "./compaction-summary.js";
import { createStreamFn } from "../model/stream.js";

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
	/**
	 * Context compaction. On by default, sized from the model's own limits
	 * (`LLM_CONTEXT_WINDOW` / `LLM_MAX_TOKENS`); pass `false` to send the
	 * transcript verbatim, as before it existed. A function replaces the
	 * summarizer (tests, or a cheaper model).
	 */
	compaction?: boolean | { summarize?: SummaryStreamer; log?: (message: string) => void; onCompact?: (result: CompactionResult) => void };
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

	/** Plugin-provided provider headers apply to the summary request too. */
	const headerHook =
		extensions?.counts.headers !== undefined
			? (headers: Record<string, string>, model: { id: string; api: string }): void =>
					extensions.runHeaders(headers, { model: model.id, api: model.api })
			: undefined;

	/** Compaction runs after plugin context hooks, so plugins only see trimmed input. */
	let compactor: ContextCompactor | undefined;
	if (options.compaction !== false) {
		const settings = typeof options.compaction === "object" ? options.compaction : {};
		compactor = createContextCompactor({
			policy: resolveCompactionPolicy({
				contextWindow: options.config.model.contextWindow ?? 128_000,
				maxTokens: options.config.model.maxTokens ?? 8_192,
			}),
			...(settings.summarize !== undefined
				? { summarize: settings.summarize }
				: {
						// Same provider, key and headers the session itself uses; the stream
						// function is built here rather than borrowed so assembly stays the
						// one place that decides how a request leaves this process.
						summarize: createSummaryStreamer(
							createStreamFn(
								() => options.config.apiKey,
								options.config.authStyle,
								headerHook,
								() => options.config.requestHeaders,
							),
							options.config.model,
							headerHook,
						),
					}),
			log: settings.log ?? options.logger,
			...(settings.onCompact !== undefined ? { onCompact: settings.onCompact } : {}),
		});
	}

	async function transformContext(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
		const refined = extensions?.counts.context ? await extensions.runContext(messages) : messages;
		return compactor === undefined ? refined : compactor.apply(refined, signal);
	}

	const hooks: KernelHooks = {
		...(extensions || options.beforeToolCall || permissionGate ? { beforeToolCall } : {}),
		...(extensions?.counts.toolResult ? { afterToolCall } : {}),
		...(compactor !== undefined || extensions?.counts.context ? { transformContext } : {}),
		...(compactor !== undefined ? { beforePrompt: () => compactor.beginRun() } : {}),
		...(extensions?.counts.headers
			? {
					beforeProviderHeaders: (headers: Record<string, string>, model: { id: string; api: string }) =>
						extensions.runHeaders(headers, { model: model.id, api: model.api }),
				}
			: {}),
	};

	return { tools, registry, hooks };
}
