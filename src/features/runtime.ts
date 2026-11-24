/**
 * Session runtime: one pi agent plus the behaviour every front end shares.
 *
 * The agent, tool wiring, permission gate and counters live here. Event
 * normalisation lives in `normalize.ts`, and the retry policy in `retry.ts`, so
 * protocols and entries never touch pi directly — they consume
 * {@link AgentRuntimeEvent} and {@link TurnResult}.
 */
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentMessage,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
} from "./contract.js";
import type { PluginCommand, SessionAccessors } from "../extensions/api.js";
import { createToolRegistry, type AnnotatedTool, type ToolRegistry } from "./tool-annotations.js";
import { modelInfo } from "./session-policy.js";
import type { ExtensionHost } from "../extensions/host.js";
import type { AppConfig } from "../model/config.js";
import { createKernelAgent } from "../kernel/agent.js";
import { createPermissionGate, type PermissionDecision, type PermissionRequest, type ToolChangePreview } from "./permissions.js";
import type { AgentRuntimeEvent, TranscriptEntry } from "./events.js";
import type { Logger, McpServerStatus } from "../types.js";
import { firstText, normalizeKernelEvent, toTranscript } from "./normalize.js";
import { runTurn, type PromptOptions, type TurnDriver, type TurnResult } from "./retry.js";

export type { PromptOptions, TurnResult } from "./retry.js";

export interface AgentStats {
	turns: number;
	userMessages: number;
	toolCalls: number;
	inputTokens: number;
	outputTokens: number;
}

export interface AgentRuntimeOptions {
	config: AppConfig;
	tools?: AgentTool<any>[];
	/** Defaults to `config.systemPrompt`. */
	systemPrompt?: string;
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	/** Plugins loaded for this session (their tools, hooks, commands and events). */
	extensions?: ExtensionHost;
	/** MCP servers configured for this session (connected or not), for `/mcp`. */
	mcpServers?: McpServerStatus[];
	/** Where policy notices go (e.g. a plugin tool shadowed by a front-end tool). */
	logger?: Logger;
	/**
	 * Permission policy: the runtime asks before any tool that declared
	 * `permission: "ask"` (core tools and plugins alike).
	 */
	permissions?: {
		mode: "ask" | "allow";
		ask: (request: PermissionRequest) => Promise<PermissionDecision>;
		/** Fallback preview for tools that do not declare their own `describe`. */
		describe?: (request: PermissionRequest) => Promise<ToolChangePreview | undefined> | ToolChangePreview | undefined;
	};
	/** Extra attempts after a failed turn that ran no tool. Default: 2. */
	retries?: number;
}

export interface AgentRuntime {
	/** Names of the tools this runtime registered. */
	readonly toolNames: string[];
	/** Slash commands registered by plugins. */
	readonly commands: PluginCommand[];
	/** Opaque, JSON-serializable transcript (what a session store persists). */
	snapshot(): unknown[];
	/** Replaces the transcript, e.g. when a stored session is resumed. */
	restore(snapshot: unknown[]): void;
	/** The transcript in provider-neutral terms, for replaying to a client. */
	transcript(): TranscriptEntry[];
	/** Subscribes to normalised events; the returned function unsubscribes. */
	subscribe(listener: (event: AgentRuntimeEvent) => void): () => void;
	prompt(text: string, options?: PromptOptions): Promise<TurnResult>;
	abort(): void;
	waitForIdle(): Promise<void>;
	reset(): void;
	/** Runs a plugin command; `undefined` when no plugin owns that name. */
	runCommand(name: string, args: string): Promise<string | undefined>;
	/** What plugins may see about this session (tools, counters, reset). */
	accessors(): SessionAccessors;
	/** Declarative extras (permission / metadata / describe) keyed by tool name. */
	toolRegistry(): ToolRegistry;
	/** Adds tools to the live agent (MCP servers connect after `session/new` returned). */
	addTools(tools: AgentTool<any>[]): void;
	/** Adds or replaces one MCP server's status (same array identity, so `/mcp` sees it). */
	upsertMcpServer(status: McpServerStatus): void;
	stats(): AgentStats;
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
	const config = options.config;
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
	const agentTools: AgentTool<any>[] = [];
	const toolSource = new Map<string, string>();
	for (const tool of options.tools ?? []) {
		agentTools.push(tool);
		toolSource.set(tool.name, "the front end");
	}
	for (const tool of pluginTools) {
		const existing = toolSource.get(tool.name);
		if (existing) {
			options.logger?.(`tool "${tool.name}" from a plugin ignored: already provided by ${existing}`);
			continue;
		}
		agentTools.push(tool);
		toolSource.set(tool.name, "a plugin");
	}
	const defaultRetries = options.retries ?? 2;
	const listeners = new Set<(event: AgentRuntimeEvent) => void>();
	/** Same array identity for the session lifetime: `/mcp` sees background updates. */
	const mcpServers: McpServerStatus[] = [...(options.mcpServers ?? [])];

	const registry = createToolRegistry(agentTools);

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

	const agent = createKernelAgent({
		config,
		tools: agentTools,
		...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
		hooks: {
			...(extensions || options.beforeToolCall || permissionGate ? { beforeToolCall } : {}),
			...(extensions?.counts.toolResult ? { afterToolCall } : {}),
			...(extensions?.counts.context ? { transformContext: (messages: AgentMessage[]) => extensions.runContext(messages) } : {}),
			...(extensions?.counts.headers
				? { beforeProviderHeaders: (headers: Record<string, string>, model: { id: string; api: string }) => extensions.runHeaders(headers, { model: model.id, api: model.api }) }
				: {}),
		},
	});

	const emit = (event: AgentRuntimeEvent): void => {
		for (const listener of listeners) {
			try {
				listener(event);
			} catch {
				/* a broken front end must not break the agent loop */
			}
		}
		extensions?.dispatch(event);
	};

	agent.subscribe((event) => {
		const normalized = normalizeKernelEvent(event);
		if (normalized) emit(normalized);
	});

	/** The kernel agent, reduced to what `runTurn` needs. */
	const driver: TurnDriver = {
		messages: () => agent.state.messages,
		setMessages: (messages) => {
			agent.state.messages = messages;
		},
		prompt: async (text, images) => {
			await agent.prompt(text, images.length > 0 ? images.map((image) => ({ type: "image" as const, ...image })) : undefined);
		},
		abort: () => agent.abort(),
	};

	const runtime: AgentRuntime = {
		toolNames: agentTools.map((tool) => tool.name),
		commands: extensions?.commands ?? [],

		toolRegistry: () => registry,

		addTools: (tools) => {
			if (tools.length === 0) return;
			agentTools.push(...tools);
			for (const tool of tools) registry.add(tool);
			// pi copies the array on assignment, so hand it a fresh one.
			agent.state.tools = [...agentTools];
		},

		upsertMcpServer: (status) => {
			const index = mcpServers.findIndex((server) => server.name === status.name && server.source === status.source);
			if (index === -1) mcpServers.push(status);
			else mcpServers[index] = status;
		},

		accessors: () => ({
			tools: agentTools.map((tool) => ({ name: tool.name, description: tool.description })),
			commands: (extensions?.commands ?? []).map((command) => ({ name: command.name, description: command.description })),
			model: modelInfo(config),
			mcp: mcpServers,
			stats: () => runtime.stats(),
			reset: () => runtime.reset(),
		}),

		snapshot: () => [...agent.state.messages],
		restore: (snapshot) => {
			agent.state.messages = snapshot as AgentMessage[];
		},
		transcript: () => toTranscript(agent.state.messages),
		runCommand: (name, args) => extensions?.runCommand(name, args) ?? Promise.resolve(undefined),

		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		async prompt(text, promptOptions = {}) {
			const retries = promptOptions.retries ?? defaultRetries;
			const result = await runTurn(driver, text, promptOptions, retries);
			emit({ type: "turn_end", ...result });
			return result;
		},

		abort: () => agent.abort(),
		waitForIdle: () => agent.waitForIdle(),

		reset: () => {
			agent.reset();
			agent.state.systemPrompt = options.systemPrompt ?? config.systemPrompt;
			agent.state.tools = agentTools;
		},

		stats: () => {
			let turns = 0;
			let userMessages = 0;
			let toolCalls = 0;
			let inputTokens = 0;
			let outputTokens = 0;

			for (const message of agent.state.messages) {
				if (message.role === "user") userMessages += 1;
				if (message.role === "toolResult") toolCalls += 1;
				if (message.role === "assistant") {
					turns += 1;
					inputTokens += message.usage?.input ?? 0;
					outputTokens += message.usage?.output ?? 0;
				}
			}

			return { turns, userMessages, toolCalls, inputTokens, outputTokens };
		},
	};

	// Plugins get a read-only view of the session once it exists.
	extensions?.attachSession(runtime.accessors());

	return runtime;
}
