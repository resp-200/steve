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
import { assembleAgent, type AgentAssembly } from "./agent-assembly.js";
import { modelInfo } from "./session-policy.js";
import type { ExtensionHost } from "../extensions/host.js";
import type { AppConfig } from "../model/config.js";
import { createKernelAgent } from "../kernel/agent.js";
import type { PermissionDecision, PermissionRequest, ToolChangePreview } from "./permissions.js";
import type { AgentRuntimeEvent, TranscriptEntry } from "./events.js";
import type { ToolRegistry } from "./tool-annotations.js";
import type { Logger, McpServerStatus } from "../types.js";
import { normalizeKernelEvent, toTranscript } from "./normalize.js";
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
	/**
	 * Assembly shared with another execution path (the ACP session drives a run
	 * worker, but still keeps a runtime for commands, replay and the transcript).
	 * When given, the runtime reuses its tool list, registry and hooks instead of
	 * assembling a private copy — so MCP tools and permission rules stay in sync.
	 */
	assembly?: AgentAssembly;
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
	const assembly =
		options.assembly ??
		assembleAgent({
			config,
			tools: options.tools,
			extensions,
			logger: options.logger,
			beforeToolCall: options.beforeToolCall,
			permissions: options.permissions,
		});
	const agentTools = assembly.tools;
	const registry = assembly.registry;
	const defaultRetries = options.retries ?? 2;
	const listeners = new Set<(event: AgentRuntimeEvent) => void>();
	/** Same array identity for the session lifetime: `/mcp` sees background updates. */
	const mcpServers: McpServerStatus[] = [...(options.mcpServers ?? [])];

	const agent = createKernelAgent({
		config,
		tools: agentTools,
		...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
		hooks: assembly.hooks,
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
