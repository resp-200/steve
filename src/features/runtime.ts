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
import { assembleAgent, type AgentAssembly, type AgentAssemblyOptions } from "./agent-assembly.js";
import { composeSystemPrompt } from "../model/prompt.js";
import { modelInfo } from "./session-policy.js";
import type { ExtensionHost } from "../extensions/host.js";
import type { AppConfig } from "../model/config.js";
import { createKernelAgent } from "../kernel/agent.js";
import type { PermissionDecision, PermissionRequest, ToolChangePreview } from "./permissions.js";
import type { AgentRuntimeEvent, TranscriptEntry } from "./events.js";
import type { ToolRegistry } from "./tool-annotations.js";
import type { AgentStats, Logger, McpServerStatus } from "../types.js";
import { normalizeKernelEvent, toTranscript } from "./normalize.js";
import { runTurn, type PromptOptions, type TurnDriver, type TurnResult } from "./retry.js";
import { estimateContextTokens, resolveCompactionPolicy } from "./compaction.js";
import type { CompactionResult } from "./compaction-hook.js";

export type { PromptOptions, TurnResult } from "./retry.js";

export type { AgentStats } from "../types.js";

export interface CompactionView {
	/** Estimated tokens the next request would carry. */
	contextTokens: number;
	/** The budget compaction keeps the transcript under. */
	triggerTokens: number;
	/** The model's context window. */
	contextWindow: number;
	/** The last compaction this runtime performed, if any. */
	last?: CompactionResult;
}

export interface AgentRuntimeOptions {
	config: AppConfig;
	/**
	 * Conversation id for provider request headers (`${sessionId}`), e.g. the ACP
	 * session id. Without one, headers fall back to the provider's manual value,
	 * then to the provider id.
	 */
	requestSessionId?: string;
	tools?: AgentTool<any>[];
	/** Defaults to `composeSystemPrompt({scene: "cli"})`. */
	systemPrompt?: string;
	/**
	 * Re-reads the parts of the prompt the user can edit (persona, identity),
	 * called at the start of every turn. Without it the prompt is composed once,
	 * so an edit in the console would only take effect in a new session.
	 */
	refreshPrompt?: () => { persona?: string; identity?: string } | undefined | Promise<{ persona?: string; identity?: string } | undefined>;
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
	/**
	 * Context compaction settings, passed through to the assembly (on unless
	 * `false`). Front ends that own an event log supply `onCompact` to record it.
	 */
	compaction?: AgentAssemblyOptions["compaction"];
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
	/** The system prompt the next turn will use (it can change between turns). */
	systemPrompt(): string;
	/** How much context the transcript is carrying, and the budget it is held to. */
	compaction(): CompactionView;
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
	// One config object per runtime: provider request headers carry this
	// conversation's id, and the stream layer reads them from the same place as
	// the model — so a session and a one-shot run cannot disagree.
	const config: AppConfig =
		options.requestSessionId === undefined || options.config.requestHeaders === undefined
			? options.config
			: { ...options.config, requestHeaders: { ...options.config.requestHeaders, sessionId: options.requestSessionId } };
	const extensions = options.extensions;
	/** Set by the compaction hook, so `/stats` and the event log can report it. */
	let lastCompaction: CompactionResult | undefined;
	const compactionSetting: AgentAssemblyOptions["compaction"] =
		options.compaction === false
			? false
			: { ...(typeof options.compaction === "object" ? options.compaction : {}), onCompact: (result) => { lastCompaction = result; } };
	const assembly =
		options.assembly ??
		assembleAgent({
			config,
			tools: options.tools,
			extensions,
			logger: options.logger,
			beforeToolCall: options.beforeToolCall,
			permissions: options.permissions,
			compaction: compactionSetting,
		});
	const agentTools = assembly.tools;
	const registry = assembly.registry;
	const defaultRetries = options.retries ?? 2;
	const listeners = new Set<(event: AgentRuntimeEvent) => void>();
	/** Same array identity for the session lifetime: `/mcp` sees background updates. */
	const mcpServers: McpServerStatus[] = [...(options.mcpServers ?? [])];

	const composePrompt = (identity: string | undefined, persona: string | undefined): string =>
		composeSystemPrompt({
			scene: "cli",
			...(identity !== undefined ? { identity } : {}),
			...(persona !== undefined ? { persona } : {}),
			details: { cwd: process.cwd() },
		});
	let systemPrompt = options.systemPrompt ?? composePrompt(config.identity, config.persona);

	/**
	 * Picks up persona/identity edits between turns. pi reads `state.systemPrompt`
	 * when a turn starts, so assigning is enough — the agent keeps its history.
	 *
	 * Done per turn rather than on every message *part* so the provider's prompt
	 * cache still hits within a turn; the file is small and reads are cheap.
	 */
	const reapplyPrompt = async (): Promise<void> => {
		if (options.systemPrompt !== undefined || options.refreshPrompt === undefined) return;
		// A refresh that returns nothing means "the user's part is gone now", not
		// "keep what you had": clearing the box in the console must clear the prompt.
		const fresh = (await options.refreshPrompt()) ?? {};
		const next = composePrompt(fresh.identity ?? config.identity, fresh.persona);
		if (next === systemPrompt) return;
		systemPrompt = next;
		agent.state.systemPrompt = next;
	};

	const agent = createKernelAgent({
		config,
		tools: agentTools,
		systemPrompt,
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
			contextWindow: config.model.contextWindow ?? 0,
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
			await reapplyPrompt();
			const retries = promptOptions.retries ?? defaultRetries;
			const result = await runTurn(driver, text, promptOptions, retries);
			emit({ type: "turn_end", ...result });
			return result;
		},

		abort: () => agent.abort(),
		waitForIdle: () => agent.waitForIdle(),

		reset: () => {
			agent.reset();
			agent.state.systemPrompt = systemPrompt;
			agent.state.tools = agentTools;
		},

		systemPrompt: () => systemPrompt,

		compaction: () => {
			const policy = resolveCompactionPolicy({
				contextWindow: config.model.contextWindow ?? 128_000,
				maxTokens: config.model.maxTokens ?? 8_192,
			});
			return {
				contextTokens: estimateContextTokens(agent.state.messages),
				triggerTokens: policy.triggerTokens,
				contextWindow: config.model.contextWindow,
				...(lastCompaction !== undefined ? { last: lastCompaction } : {}),
			};
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

			return {
				turns,
				userMessages,
				toolCalls,
				inputTokens,
				outputTokens,
				// What the next request would carry: the number compaction acts on.
				contextTokens: estimateContextTokens(agent.state.messages),
			};
		},
	};

	// Plugins get a read-only view of the session once it exists.
	extensions?.attachSession(runtime.accessors());

	return runtime;
}
