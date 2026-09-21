import {
	RequestError,
	type AgentContext,
	type ClientCapabilities,
	type PromptRequest,
	type PromptResponse,
	type SessionUpdate,
	type StopReason,
	type ToolKind,
	type Usage,
} from "@agentclientprotocol/sdk";
import type { AppConfig } from "../../model/config.js";
import type { AgentRuntimeEvent, TurnStopReason, TurnUsage } from "../../features/events.js";
import type { ExtensionHost } from "../../extensions/host.js";
import type { AgentTool } from "../../features/contract.js";
import { readFile } from "node:fs/promises";
import { sessionRecord, type SessionStore, type StoredSession } from "../../features/session-store.js";
import { isAbsolute, join } from "node:path";
import { editPreview, writePreview } from "../../features/change-preview.js";
import type { PermissionDecision, PermissionRequest, ToolChangePreview } from "../../features/permissions.js";
import { createAgentRuntime, type AgentRuntime, type TurnResult } from "../../features/runtime.js";
import type { Logger, McpServerStatus } from "../../types.js";
import { blocksToImages, blocksToText, locationsFromArgs } from "./content.js";
import { diffContent, toolCallContent } from "./tool-call.js";
import { createAcpTools } from "./tools.js";

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
	/** Register local read/write/exec tools when the editor does not provide them. */
	allowLocalTools?: boolean;
	/** Plugins loaded for this session. */
	extensions: ExtensionHost;
	/** Where the transcript is persisted (omitted in tests that do not need it). */
	store?: SessionStore;
	/** A stored transcript to resume instead of starting empty. */
	restore?: StoredSession;
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
	private readonly supportsImages: boolean;
	private readonly unsubscribe: () => void;
	private readonly createdAt: string;
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

	constructor(options: AcpSessionOptions) {
		this.options = options;
		this.id = options.id;
		this.cwd = options.cwd;
		this.supportsImages = options.config.model.input.includes("image");

		const clientTools = createAcpTools({
			sessionId: options.id,
			workingDirectory: options.cwd,
			client: options.client,
			capabilities: options.clientCapabilities,
		});

		// Local tools (when the front end allows them) come from the built-in plugin;
		// the runtime drops a plugin tool whose name the editor already provides.
		const tools = [...clientTools];

		this.runtime = createAgentRuntime({
			config: options.config,
			tools,
			mcpServers: options.mcpServers ?? [],
			logger: options.logger,
			extensions: options.extensions,
			systemPrompt: this.systemPrompt(),
			// The runtime asks before any tool that declared `permission: "ask"`.
			permissions: {
				mode: options.permissionMode,
				ask: (request) => this.askPermission(request),
			},
		});
		this.toolNames = this.runtime.toolNames;
		this.createdAt = options.restore?.createdAt ?? new Date().toISOString();
		if (options.restore) {
			this.runtime.restore(options.restore.messages);
			this.accountUsage(options.restore.usage as TurnUsage | undefined);
		}
		this.unsubscribe = this.runtime.subscribe((event) => this.publish(event));
	}

	/* ------------------------------- prompting ------------------------------ */

	async prompt(request: PromptRequest, signal: AbortSignal): Promise<PromptResponse> {
		if (this.running) {
			// ACP clients send one prompt per session; a second one supersedes the first.
			this.options.logger(`session ${this.id}: superseding the in-flight turn`);
			this.runtime.abort();
			await this.runtime.waitForIdle();
		}

		const text = blocksToText(request.prompt);
		const images = this.supportsImages ? blocksToImages(request.prompt) : [];
		if (!text.trim() && images.length === 0) {
			throw RequestError.invalidParams(undefined, "Prompt contained no usable content");
		}

		// Editors forward the agent's stderr into their own logs, so these lines are
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
					await this.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: output } });
				}
				return { stopReason: "end_turn", usage: { ...this.usage } };
			}
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
			// Surface provider failures inside the transcript instead of failing the
			// whole JSON-RPC request, so the client keeps its history.
			await this.send({
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: `⚠️ ${result.errorMessage}` },
			});
		}

		if (result.contextTokens > 0) {
			this.accountUsage(result.usage);
			await this.send({
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
		for (const entry of this.runtime.transcript()) {
			if (entry.role === "user") {
				const suffix = entry.images > 0 ? `\n[${entry.images} image(s)]` : "";
				await this.send({ sessionUpdate: "user_message_chunk", content: { type: "text", text: `${entry.text}${suffix}` } });
				continue;
			}

			if (entry.role === "assistant") {
				if (entry.thinking) await this.send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: entry.thinking } });
				if (entry.text) await this.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: entry.text } });
				for (const call of entry.toolCalls) {
					await this.send({
						sessionUpdate: "tool_call",
						toolCallId: call.id,
						title: this.titleFor(call.name, call.args),
						name: call.name,
						kind: this.kindFor(call.name),
						status: "in_progress",
						rawInput: call.args,
						locations: locationsFromArgs(call.args),
					});
				}
				continue;
			}

			await this.send({
				sessionUpdate: "tool_call_update",
				toolCallId: entry.toolCallId,
				status: entry.isError ? "failed" : "completed",
				content: toolCallContent(entry.text, undefined),
			});
		}
	}


	async announceCommands(): Promise<void> {
		// Built-in commands are plugins too, so this is just the command registry.
		const commands = this.runtime.commands.map((command) => ({ name: command.name, description: command.description }));

		await this.send({
			sessionUpdate: "available_commands_update",
			availableCommands: commands,
		});
	}

	cancel(): void {
		this.runtime.abort();
	}

	/**
	 * Attaches one MCP server that settled after `session/new` returned. Editors kill
	 * an agent whose `session/new` is slow (IDEA: exit code 143), so connections run
	 * in the background — and each server is attached as soon as it is up, so one
	 * slow server (npx cold start) does not hold back the others.
	 */
	attachMcpServer(status: McpServerStatus, connection?: { tools: AgentTool<any>[]; close: () => Promise<void> }): void {
		if (connection) {
			this.runtime.addTools(connection.tools);
			this.mcpClosers.push(() => connection.close());
		}
		this.runtime.upsertMcpServer(status);
		const tools = connection ? ` (${connection.tools.length} tool(s))` : "";
		this.options.logger(`session ${this.id}: mcp ${status.name} ${status.status}${tools}`);
		if (this.disposed) void this.closeMcp();
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribe();
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
		const roots = [this.cwd, ...this.options.additionalDirectories];
		return [
			this.options.config.systemPrompt,
			`You are connected to a code editor through the Agent Client Protocol. The session working directory is ${this.cwd}.`,
			`Workspace roots you may touch with file tools: ${roots.join(", ")}.`,
			"File and terminal tools require absolute paths; the editor asks the user for permission before writes and commands.",
		].join("\n");
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

	/** Forwards a permission question to the editor and reports back the decision. */
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

	private send(update: SessionUpdate): Promise<void> {
		return this.options.client.notify("session/update", { sessionId: this.id, update });
	}

	private publish(event: AgentRuntimeEvent): void {
		void this.publishEvent(event).catch((error: unknown) => {
			this.options.logger(`session ${this.id}: failed to send update: ${String(error)}`);
		});
	}

	private async publishEvent(event: AgentRuntimeEvent): Promise<void> {
		switch (event.type) {
			case "text_delta":
				await this.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } });
				break;

			case "thinking_delta":
				await this.send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.text } });
				break;

			case "tool_start":
				await this.send({
					sessionUpdate: "tool_call",
					toolCallId: event.id,
					title: this.titleFor(event.name, event.args),
					name: event.name,
					kind: this.kindFor(event.name),
					status: "in_progress",
					rawInput: event.args,
					locations: locationsFromArgs(event.args),
				});
				break;

			case "tool_update":
				await this.send({
					sessionUpdate: "tool_call_update",
					toolCallId: event.id,
					status: "in_progress",
					content: toolCallContent(event.text, undefined),
				});
				break;

			case "tool_end":
				await this.send({
					sessionUpdate: "tool_call_update",
					toolCallId: event.id,
					status: event.isError ? "failed" : "completed",
					content: toolCallContent(event.text, event.details, event.images),
					rawOutput: event.details ?? null,
				});
				break;

			default:
				// turn_start / turn_end carry nothing the client needs.
				break;
		}
	}
}
