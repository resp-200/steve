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
import type { SessionStore, StoredSession } from "../../features/session-store.js";
import { isAbsolute, join } from "node:path";
import { editPreview, writePreview } from "../../features/change-preview.js";
import type { PermissionDecision, PermissionRequest, ToolChangePreview } from "../../features/permissions.js";
import { createAgentRuntime, type AgentRuntime, type TurnResult } from "../../features/runtime.js";
import { createLocalTools } from "../../features/local-tools.js";
import type { Logger, McpServerStatus } from "../../types.js";
import { blocksToImages, blocksToText, locationsFromArgs } from "./content.js";
import { TOOL_KINDS, describeToolCall, diffContent, toolCallContent } from "./tool-call.js";
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
	mcpTools?: AgentTool<any>[];
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

		// Local tools only fill the gaps the editor does not cover, so names never clash.
		const taken = new Set(clientTools.map((tool) => tool.name));
		const localOptions = {
			roots: [options.cwd, ...options.additionalDirectories],
			allowWrite: true,
			allowExec: true,
			supportsImages: this.supportsImages,
		};
		const fallbackTools = options.allowLocalTools ? createLocalTools(localOptions).filter((tool) => !taken.has(tool.name)) : [];

		const tools = [...clientTools, ...fallbackTools, ...(options.mcpTools ?? [])];

		this.runtime = createAgentRuntime({
			config: options.config,
			tools,
			mcpServers: options.mcpServers ?? [],
			extensions: options.extensions,
			systemPrompt: this.systemPrompt(),
			// The runtime asks before any tool that declared `permission: "ask"`.
			permissions: {
				mode: options.permissionMode,
				ask: (request) => this.askPermission(request),
				describe: (request) => this.describeChange(request.toolName, request.args),
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

		// Slash commands are answered locally; anything else goes to the model.
		const command = /^\/([\w-]+)\s*([\s\S]*)$/.exec(text.trim());
		if (command) {
			const name = command[1] ?? "";
			const args = command[2]?.trim() ?? "";
			if (this.runtime.commands.some((entry) => entry.name === name)) {
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
		return { stopReason: STOP_REASONS[result.stopReason], usage: { ...this.usage } };
	}

	/** Saves the transcript so the session can be resumed after a restart. */
	private async persist(): Promise<void> {
		if (!this.options.store) return;
		await this.options.store.save({
			id: this.id,
			cwd: this.cwd,
			createdAt: this.createdAt,
			updatedAt: new Date().toISOString(),
			messages: this.runtime.snapshot(),
			usage: { ...this.usage },
		});
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


	/**
	 * Previews what a write/edit is about to do. The previous content comes from the
	 * editor's filesystem when it has one, otherwise from the local fallback.
	 */
	private async describeChange(toolName: string, args: unknown): Promise<ToolChangePreview | undefined> {
		const input = (args ?? {}) as Record<string, unknown>;
		const text = (key: string): string => (typeof input[key] === "string" ? (input[key] as string) : "");

		if (toolName === "run_command") {
			const command = text("command");
			return command ? { summary: `run ${command}` } : undefined;
		}

		const rawPath = text("path");
		if (!rawPath) return undefined;
		const path = isAbsolute(rawPath) ? rawPath : join(this.cwd, rawPath);

		if (toolName === "write_file") {
			const before = await this.readForPreview(path);
			return writePreview({ path, shown: path, ...(before === undefined ? {} : { before }), after: text("content") });
		}

		if (toolName === "edit_file") {
			const before = await this.readForPreview(path);
			if (before === undefined) return undefined;
			return editPreview({
				path,
				shown: path,
				before,
				find: text("old_string"),
				replace: text("new_string"),
				...(typeof input.line === "number" ? { line: input.line } : {}),
				...(input.replace_all === true ? { replaceAll: true } : {}),
			});
		}

		return undefined;
	}

	/** Reads a file for preview purposes only; failures just mean "no preview". */
	private async readForPreview(path: string): Promise<string | undefined> {
		if (this.options.clientCapabilities.fs?.readTextFile) {
			try {
				const response = await this.options.client.request("fs/read_text_file", { sessionId: this.id, path, line: null, limit: null });
				return response.content;
			} catch {
				return undefined;
			}
		}

		if (!this.options.allowLocalTools) return undefined;
		try {
			return await readFile(path, "utf8");
		} catch {
			return undefined;
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

	dispose(): void {
		this.unsubscribe();
		this.runtime.abort();
		void this.options.closeMcp?.().catch((error: unknown) => {
			this.options.logger(`session ${this.id}: closing MCP servers failed: ${String(error)}`);
		});
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
				title: request.preview?.summary ?? describeToolCall(request.toolName, request.args),
				kind: TOOL_KINDS[request.toolName] ?? "other",
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

	/** Tools declare their own presentation; the protocol table is a fallback. */
	private kindFor(toolName: string): ToolKind {
		const declared = this.runtime.toolRegistry().kindFor(toolName);
		return (declared as ToolKind | undefined) ?? TOOL_KINDS[toolName] ?? "other";
	}

	private titleFor(toolName: string, args: unknown): string {
		return this.runtime.toolRegistry().titleFor(toolName, args) ?? describeToolCall(toolName, args);
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
