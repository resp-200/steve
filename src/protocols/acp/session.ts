import {
	RequestError,
	type AgentContext,
	type ClientCapabilities,
	type PromptRequest,
	type PromptResponse,
	type StopReason,
	type ToolKind,
	type Usage,
} from "@agentclientprotocol/sdk";
import type { AppConfig } from "../../model/config.js";
import type { PromptImage, StreamEvent, TurnStopReason, TurnUsage } from "../../features/events.js";
import type { ExtensionHost } from "../../extensions/host.js";
import type { AgentTool } from "../../features/contract.js";
import { readFile } from "node:fs/promises";
import { encodeTranscript, sessionRecord, type SessionStore, type StoredSession } from "../../features/session-store.js";
import { isAbsolute, join } from "node:path";
import { editPreview, writePreview } from "../../features/change-preview.js";
import type { PermissionDecision, PermissionRequest, ToolChangePreview } from "../../features/permissions.js";
import { readAdminConfig } from "../../features/admin-config.js";
import { createAgentRuntime, type AgentRuntime, type TurnResult } from "../../features/runtime.js";
import { assembleAgent, type AgentAssembly } from "../../features/agent-assembly.js";
import { createRunWorker, type RunTerminal, type RunWorker } from "../../features/worker.js";
import { foldTranscript } from "../../features/state-fold.js";
import type { StreamLog } from "../../features/stream-log.js";
import type { Logger, McpServerStatus } from "../../types.js";
import { blocksToImages, blocksToText, locationsFromArgs } from "./content.js";
import { diffContent } from "./tool-call.js";
import { createAcpTools } from "./tools.js";
import { createAcpPublisher, type AcpPublisher } from "./publish.js";
import { DEFAULT_POLICIES, project, type ProjectionHooks, type ProjectionPolicy } from "../../features/projection.js";
import { snapshotEnvironment, type EnvironmentSnapshot } from "../../features/environment.js";
import { composeSystemPrompt } from "../../model/prompt.js";
import { modelInfo, workspacePolicy } from "../../features/session-policy.js";

export type PermissionMode = "ask" | "allow";


/** Our turn stop reasons -> ACP's. */
const STOP_REASONS: Record<TurnStopReason, StopReason> = {
	stop: "end_turn",
	tool_use: "end_turn",
	length: "max_tokens",
	cancelled: "cancelled",
	error: "end_turn",
};


export interface AcpSessionOptions {
	id: string;
	cwd: string;
	additionalDirectories: string[];
	config: AppConfig;
	/** Connection-scoped context used to call client-side ACP methods. */
	client: AgentContext;
	clientCapabilities: ClientCapabilities;
	permissionMode: PermissionMode;
	/** Register local read/write/exec tools when the client does not provide them. */
	allowLocalTools?: boolean;
	/** Plugins loaded for this session. */
	extensions: ExtensionHost;
	/** Where the transcript is persisted (omitted in tests that do not need it). */
	store?: SessionStore;
	/** A stored transcript to resume instead of starting empty. */
	restore?: StoredSession;
	/**
	 * How much of the internal event stream this client may see. Defaults to
	 * `full` — clients that predate projection must see exactly what they saw
	 * before (thinking chunks, raw tool arguments and output).
	 */
	projection?: ProjectionPolicy;
	/** Tools contributed by MCP servers the client asked for. */
	/** Configured MCP servers with their status, for the `/mcp` command. */
	mcpServers?: McpServerStatus[];
	/** Closes the MCP connections this session opened. */
	closeMcp?: () => Promise<void>;
	logger: Logger;
}

/**
 * One ACP session == one agent runtime (own transcript, own tools).
 *
 * The runtime's normalised events become ACP `session/update` notifications, and
 * its permission hook becomes `session/request_permission` — this class holds no
 * pi types at all.
 */
export class AcpSession {
	readonly id: string;
	readonly cwd: string;
	readonly toolNames: string[];

	private readonly options: AcpSessionOptions;
	private readonly runtime: AgentRuntime;
	private readonly assembly: AgentAssembly;
	private readonly publisher: AcpPublisher;
	private readonly supportsImages: boolean;
	/** Legacy event source, used only when the session has no persisted stream. */
	private readonly unsubscribeRuntime?: () => void;
	/** Event log shared with the session store; present whenever sessions persist. */
	private readonly log?: StreamLog;
	/** One stream per ACP session, named by the session id. */
	private readonly streamId: string;
	/** Runs turns as runs on the event log when a stream exists (§5.2). */
	private readonly worker?: RunWorker;
	private readonly projectionHooks: ProjectionHooks;
	private readonly createdAt: string;
	/** Bootstraps the stream (legacy transcript import, subscription) exactly once. */
	private ready?: Promise<void>;
	private unsubscribeLog?: () => void;
	/** Highest seq published to this client; the worker run start is read from here. */
	private cursor = 0;
	private currentRunId?: string;
	private readonly usage: Usage = {
		totalTokens: 0,
		inputTokens: 0,
		outputTokens: 0,
		cachedReadTokens: 0,
		cachedWriteTokens: 0,
		thoughtTokens: 0,
	};
	private running = false;
	private disposed = false;
	/** Closers for MCP servers that were attached after the session started. */
	private readonly mcpClosers: (() => Promise<void>)[] = [];
	/** What this session's run is allowed to see and do; plain, serializable data. */
	readonly environment: EnvironmentSnapshot;

	constructor(options: AcpSessionOptions) {
		this.options = options;
		this.id = options.id;
		this.cwd = options.cwd;
		this.supportsImages = options.config.model.input.includes("image");
		const projection = options.projection ?? DEFAULT_POLICIES.full;

		const clientTools = createAcpTools({
			sessionId: options.id,
			workingDirectory: options.cwd,
			client: options.client,
			capabilities: options.clientCapabilities,
		});

		// Local tools (when the front end allows them) come from the built-in plugin;
		// the runtime drops a plugin tool whose name the client already provides.
		const tools = [...clientTools];

		// One assembly for the session: the runtime uses it for commands, replay and
		// the transcript, and the run worker uses the very same tools, registry and
		// hooks — so an MCP server attached later reaches both, identically.
		this.assembly = assembleAgent({
			config: options.config,
			tools,
			extensions: options.extensions,
			logger: options.logger,
			// The runtime asks before any tool that declared `permission: "ask"`.
			permissions: {
				mode: options.permissionMode,
				ask: (request) => this.askPermission(request),
			},
		});
		this.runtime = createAgentRuntime({
			config: options.config,
			// Provider request headers identify the conversation by its ACP session id.
			requestSessionId: options.id,
			assembly: this.assembly,
			mcpServers: options.mcpServers ?? [],
			logger: options.logger,
			extensions: options.extensions,
			systemPrompt: this.systemPrompt(),
			// Persona edits in the console apply to this session from the next turn
			// on: sessions outlive a restart-free working day, so a snapshot is wrong.
			refreshPrompt: async () => {
				const admin = await readAdminConfig();
				return admin.persona === undefined ? undefined : { persona: admin.persona };
			},
		});
		this.toolNames = this.runtime.toolNames;
		this.createdAt = options.restore?.createdAt ?? new Date().toISOString();
		// The transcript itself is restored from the stream (or imported by
		// `ensureReady` for sessions written before S1); only usage is carried here.
		if (options.restore) this.accountUsage(options.restore.usage as TurnUsage | undefined);
		// One written-down environment per session (personal agent §4.4). The
		// workspace roots and model are the same values plugins were loaded with,
		// so the snapshot cannot drift from what the session actually allows.
		this.environment = snapshotEnvironment({
			cwd: this.cwd,
			workspace: workspacePolicy({
				cwd: this.cwd,
				additionalDirectories: options.additionalDirectories,
				access: options.allowLocalTools ? "exec" : "none",
			}),
			model: modelInfo(options.config),
			tools: this.runtime.toolNames.map((name) => ({
				name,
				permissionRequired: this.runtime.toolRegistry().permissionRequired().includes(name),
				...(this.kindFor(name) ? { kind: this.kindFor(name) } : {}),
			})),
			permissionMode: options.permissionMode,
			plugins: options.extensions.files,
			projection,
			mode: "foreground",
		});
		this.publisher = createAcpPublisher({
			sessionId: this.id,
			send: (update) => this.options.client.notify("session/update", { sessionId: this.id, update }),
			kindFor: (toolName) => this.kindFor(toolName),
			titleFor: (toolName, args) => this.titleFor(toolName, args),
			logger: options.logger,
		});
		this.projectionHooks = {
			kindFor: (toolName) => this.kindFor(toolName),
			titleFor: (toolName, args) => this.titleFor(toolName, args),
		};

		this.streamId = this.id;
		const log = options.store?.log;
		this.log = log;
		if (log) {
			this.worker = createRunWorker({
				config: options.config,
				extensions: options.extensions,
				log,
				readState: async (streamId) => foldTranscript(await log.read(streamId)),
				resolveEnvironment: async () => this.environment,
				tools: () => this.assembly.tools,
				// No fixed string here: the worker composes from the live config each
				// run, which is what makes persona edits visible without a restart.
				hooks: this.assembly.hooks,
				logger: options.logger,
				// ACP clients send one prompt per session; a second one supersedes.
				concurrency: "serial",
			});
		} else {
			this.unsubscribeRuntime = this.runtime.subscribe((event) => {
				for (const projected of project(event, this.environment.projection, this.projectionHooks)) {
					// ACP clients consume the raw stream; summaries are for the terminal
					// and future HTTP consumers, so a `user` projection is a no-op here.
					if (projected.audience !== "user") this.publisher.publishEvent(projected.event);
				}
			});
		}
	}

	/**
	 * Streams that predate S1 only have `<id>.json`; importing their transcript
	 * into the log keeps the run worker's view of history identical to the one the
	 * runtime had. Also attaches the live event subscription exactly once.
	 */
	private ensureReady(): Promise<void> {
		return (this.ready ??= this.initStream());
	}

	private async initStream(): Promise<void> {
		const log = this.log;
		if (!log) return;
		let events: StreamEvent[] = [];
		try {
			events = await log.read(this.streamId);
		} catch (error) {
			this.options.logger(`session ${this.id}: could not read stream: ${String(error)}`);
		}
		if (events.length === 0 && this.options.restore) {
			const createdAt = Date.parse(this.options.restore.createdAt);
			try {
				await log.append(this.streamId, [
					{ type: "stream.created", streamId: this.streamId, cwd: this.cwd, ...(Number.isFinite(createdAt) ? { ts: createdAt } : {}) },
					...encodeTranscript(this.options.restore.messages),
				]);
				events = await log.read(this.streamId);
			} catch (error) {
				this.options.logger(`session ${this.id}: could not import the stored transcript: ${String(error)}`);
			}
		}
		const last = events.at(-1)?.seq ?? 0;
		this.cursor = last;
		this.unsubscribeLog = log.subscribe(this.streamId, last + 1, (event) => {
			this.cursor = event.seq;
			for (const projected of project(event, this.environment.projection, this.projectionHooks)) {
				if (projected.audience !== "user") this.publisher.publishEvent(projected.event);
			}
		});
		this.runtime.restore(foldTranscript(events));
	}

	/** Keeps the runtime's transcript (persistence, replay, `/stats`) in sync with the log. */
	private async syncRuntime(): Promise<void> {
		const log = this.log;
		if (!log) return;
		this.runtime.restore(foldTranscript(await log.read(this.streamId)));
	}

	/* ------------------------------- prompting ------------------------------ */

	async prompt(request: PromptRequest, signal: AbortSignal): Promise<PromptResponse> {
		await this.ensureReady();

		const text = blocksToText(request.prompt);
		const attached = blocksToImages(request.prompt);
		// Dropping the pictures silently would make the model answer "I don't see an
		// image" while the client is sure it sent one, so say it in the transcript.
		if (attached.length > 0 && !this.supportsImages) {
			const note = `⚠️ 当前模型被设置为不支持图片（供应商里关掉了「支持图片」），这 ${attached.length} 张图没有发给模型。确认该模型能看图的话，把这个开关打开再试一次。`;
			this.options.logger(`session/prompt: ${this.id} dropping ${attached.length} image(s) (model has no vision)`);
			await this.publisher.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: note } });
		}
		const images = this.supportsImages ? attached : [];
		if (!text.trim() && images.length === 0) {
			if (attached.length > 0) throw RequestError.invalidParams(undefined, "Prompt contained no usable content (images dropped: the model has no vision)");
			throw RequestError.invalidParams(undefined, "Prompt contained no usable content");
		}

		// Clients forward the agent's stderr into their own logs, so these lines are
		// how "the client never sent a prompt" is told apart from "we never answered".
		this.options.logger(
			`session/prompt: ${this.id} ${request.prompt.length} block(s)${images.length > 0 ? `, ${images.length} image(s)` : ""}`,
		);

		// Slash commands are answered locally; anything else goes to the model.
		const command = /^\/([\w-]+)\s*([\s\S]*)$/.exec(text.trim());
		if (command) {
			const name = command[1] ?? "";
			const args = command[2]?.trim() ?? "";
			if (this.runtime.commands.some((entry) => entry.name === name)) {
				this.options.logger(`session/prompt: ${this.id} running /${name} locally`);
				const output = await this.runtime.runCommand(name, args);
				if (output) {
					await this.publisher.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: output } });
				}
				// A command such as `/new` may reset the transcript; the log follows it.
				await this.applyCommandEffects();
				return { stopReason: "end_turn", usage: { ...this.usage } };
			}
		}

		if (this.worker) return await this.promptViaWorker(text, images);
		return await this.promptViaRuntime(text, images, signal);
	}

	/**
	 * Runs one prompt as a run on the event log and waits for its terminal state.
	 *
	 * The client sees the same updates as before: the worker appends normalised
	 * events, the stream subscription projects and publishes them. Usage and the
	 * warning chunk are emitted from the terminal state, exactly where the old
	 * runtime path emitted them.
	 */
	private async promptViaWorker(text: string, images: PromptImage[]): Promise<PromptResponse> {
		const worker = this.worker!;
		const log = this.log!;
		const fromSeq = this.cursor;
		if (this.running) this.options.logger(`session ${this.id}: superseding the in-flight turn`);

		this.running = true;
		let terminal: RunTerminal;
		try {
			const submitted = await worker.submit(this.streamId, { text, ...(images.length > 0 ? { images } : {}) }, "foreground");
			if (!submitted.accepted) throw RequestError.internalError(undefined, submitted.reason ?? "run rejected");
			this.currentRunId = submitted.runId;
			terminal = await worker.wait(submitted.runId);
		} finally {
			this.running = false;
			this.currentRunId = undefined;
		}

		const events = await log.read(this.streamId, fromSeq + 1);
		const turnEnd = [...events].reverse().find((event): event is Extract<StreamEvent, { type: "turn_end" }> => event.type === "turn_end");
		const contextTokens = turnEnd?.contextTokens ?? 0;
		if (terminal.status === "failed") {
			// Surface provider failures inside the transcript instead of failing the
			// whole JSON-RPC request, so the client keeps its history.
			await this.publisher.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `⚠️ ${terminal.error}` } });
		}
		if (contextTokens > 0) {
			this.accountUsage(turnEnd?.usage);
			await this.publisher.send({
				sessionUpdate: "usage_update",
				used: contextTokens,
				size: this.options.config.model.contextWindow,
				cost: null,
			});
		}

		await this.syncRuntime();
		await this.persist();
		const stopReason: TurnStopReason = terminal.status === "cancelled" ? "cancelled" : ((turnEnd?.stopReason ?? "error") as TurnStopReason);
		const mapped = STOP_REASONS[stopReason] ?? "end_turn";
		this.options.logger(
			`session/prompt done: ${this.id} stopReason=${mapped} tokens in/out=${this.usage.inputTokens}/${this.usage.outputTokens}` +
				(terminal.status === "failed" ? ` error=${terminal.error.slice(0, 160)}` : ""),
		);
		return { stopReason: mapped, usage: { ...this.usage } };
	}

	/** Runs one prompt on the long-lived runtime (no stream: `--no-sessions`). */
	private async promptViaRuntime(text: string, images: PromptImage[], signal: AbortSignal): Promise<PromptResponse> {
		if (this.running) {
			// ACP clients send one prompt per session; a second one supersedes the first.
			this.options.logger(`session ${this.id}: superseding the in-flight turn`);
			this.runtime.abort();
			await this.runtime.waitForIdle();
		}

		this.running = true;
		let result: TurnResult;
		try {
			result = await this.runtime.prompt(text, {
				images,
				signal,
				onRetry: (reason, attempt) => this.options.logger(`session ${this.id}: retry ${attempt} · ${reason}`),
			});
		} finally {
			this.running = false;
		}

		if (result.failed && result.errorMessage) {
			await this.publisher.send({
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: `⚠️ ${result.errorMessage}` },
			});
		}

		if (result.contextTokens > 0) {
			this.accountUsage(result.usage);
			await this.publisher.send({
				sessionUpdate: "usage_update",
				used: result.contextTokens,
				size: this.options.config.model.contextWindow,
				cost: null,
			});
		}

		await this.persist();
		const stopReason = STOP_REASONS[result.stopReason];
		this.options.logger(
			`session/prompt done: ${this.id} stopReason=${stopReason} tokens in/out=${this.usage.inputTokens}/${this.usage.outputTokens}` +
				(result.failed && result.errorMessage ? ` error=${result.errorMessage.slice(0, 160)}` : ""),
		);
		return { stopReason, usage: { ...this.usage } };
	}

	/**
	 * A local command may have reset the transcript (`/new`). The log is the truth,
	 * so mirror the new transcript: an emptied runtime clears the stream, anything
	 * else is already reflected by the command's own appends.
	 */
	private async applyCommandEffects(): Promise<void> {
		const log = this.log;
		if (!log || !this.worker) return;
		if (this.runtime.snapshot().length > 0) {
			await this.syncRuntime();
			return;
		}
		this.unsubscribeLog?.();
		this.unsubscribeLog = undefined;
		try {
			if (await log.read(this.streamId).then((events) => events.length > 0)) {
				await log.remove(this.streamId);
			}
		} catch (error) {
			this.options.logger(`session ${this.id}: could not reset the stream: ${String(error)}`);
		}
		this.ready = undefined;
		this.cursor = 0;
		await this.ensureReady();
		await this.persist();
	}

	/** Saves the transcript so the session can be resumed after a restart. */
	private async persist(): Promise<void> {
		if (!this.options.store) return;
		await this.options.store.save(
			sessionRecord({
				id: this.id,
				cwd: this.cwd,
				createdAt: this.createdAt,
				messages: this.runtime.snapshot(),
				usage: { ...this.usage },
			}),
		);
	}

	/** Replays a stored transcript to the client (used by `session/load`). */
	async replay(): Promise<void> {
		await this.ensureReady();
		await this.syncRuntime();
		await this.publisher.replay(this.runtime.transcript());
	}


	async announceCommands(): Promise<void> {
		// Built-in commands are plugins too, so this is just the command registry.
		const commands = this.runtime.commands.map((command) => ({ name: command.name, description: command.description }));

		await this.publisher.send({
			sessionUpdate: "available_commands_update",
			availableCommands: commands,
		});
	}

	cancel(): void {
		if (this.worker && this.currentRunId !== undefined) {
			// The log records the request first, then the agent is interrupted: a
			// cancelled run is replayable instead of just disappearing.
			void this.worker.cancel(this.streamId, this.currentRunId);
			return;
		}
		this.runtime.abort();
	}

	/**
	 * Attaches one MCP server that settled after `session/new` returned. Clients kill
	 * an agent whose `session/new` is slow (IDEA: exit code 143), so connections run
	 * in the background — and each server is attached as soon as it is up, so one
	 * slow server (npx cold start) does not hold back the others.
	 */
	attachMcpServer(status: McpServerStatus, connection?: { tools: AgentTool<any>[]; close: () => Promise<void> }): void {
		if (connection) {
			this.runtime.addTools(connection.tools);
			// The worker only runs tools the environment names, so MCP tools must be
			// added there too (they arrive after `session/new` returned).
			if (this.worker) {
				for (const tool of connection.tools) {
					this.toolNames.push(tool.name);
					this.environment.tools.push({
						name: tool.name,
						permissionRequired: this.assembly.registry.permissionRequired().includes(tool.name),
						...(this.kindFor(tool.name) ? { kind: this.kindFor(tool.name) } : {}),
					});
				}
			}
			this.mcpClosers.push(() => connection.close());
		}
		this.runtime.upsertMcpServer(status);
		const tools = connection ? ` (${connection.tools.length} tool(s))` : "";
		this.options.logger(`session ${this.id}: mcp ${status.name} ${status.status}${tools}`);
		if (this.disposed) void this.closeMcp();
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribeRuntime?.();
		this.unsubscribeLog?.();
		if (this.worker && this.currentRunId !== undefined) void this.worker.cancel(this.streamId, this.currentRunId);
		this.runtime.abort();
		void this.closeMcp();
	}

	private async closeMcp(): Promise<void> {
		const closers = this.mcpClosers.splice(0, this.mcpClosers.length);
		await Promise.all(
			closers.map((close) =>
				Promise.resolve(close()).catch((error: unknown) => {
					this.options.logger(`session ${this.id}: closing MCP servers failed: ${String(error)}`);
				}),
			),
		);
	}

	/* ------------------------------- internals ------------------------------ */

	private systemPrompt(): string {
		return composeSystemPrompt({
			scene: "acp",
			...(this.options.config.identity !== undefined ? { identity: this.options.config.identity } : {}),
			...(this.options.config.persona !== undefined ? { persona: this.options.config.persona } : {}),
			details: { cwd: this.cwd, roots: [this.cwd, ...this.options.additionalDirectories] },
		});
	}

	private accountUsage(usage: TurnUsage | undefined): void {
		if (!usage) return;
		this.usage.inputTokens += usage.input;
		this.usage.outputTokens += usage.output;
		this.usage.totalTokens += usage.total;
		this.usage.cachedReadTokens = (this.usage.cachedReadTokens ?? 0) + usage.cacheRead;
		this.usage.cachedWriteTokens = (this.usage.cachedWriteTokens ?? 0) + usage.cacheWrite;
		this.usage.thoughtTokens = (this.usage.thoughtTokens ?? 0) + usage.reasoning;
	}

	/** Forwards a permission question to the client and reports back the decision. */
	private async askPermission(request: PermissionRequest): Promise<PermissionDecision> {
		const response = await this.options.client.request("session/request_permission", {
			sessionId: this.id,
			toolCall: {
				toolCallId: request.toolCallId,
				title: request.preview?.summary ?? this.titleFor(request.toolName, request.args),
				kind: this.kindFor(request.toolName),
				status: "pending",
				rawInput: request.args,
				locations: locationsFromArgs(request.args) ?? null,
				// Clients that render diffs show exactly what is about to change.
				...(request.preview ? { content: diffContent(request.preview) } : {}),
			},
			options: [
				{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
				{ optionId: "allow_always", name: `Always allow ${request.toolName}`, kind: "allow_always" },
				{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
			],
		});

		if (response.outcome.outcome !== "selected") return "cancel";

		switch (response.outcome.optionId) {
			case "allow_once":
				return "allow_once";
			case "allow_always":
				return "allow_always";
			default:
				return "deny";
		}
	}

	/** Tools declare their own presentation; the protocol layer knows no tool names. */
	private kindFor(toolName: string): ToolKind {
		const declared = this.runtime.toolRegistry().kindFor(toolName);
		return (declared as ToolKind | undefined) ?? "other";
	}

	private titleFor(toolName: string, args: unknown): string {
		return this.runtime.toolRegistry().titleFor(toolName, args) ?? toolName;
	}
}
