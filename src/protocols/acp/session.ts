import {
	RequestError,
	type AgentContext,
	type ClientCapabilities,
	type PromptRequest,
	type PromptResponse,
	type SessionUpdate,
	type StopReason,
	type Usage,
} from "@agentclientprotocol/sdk";
import type { AppConfig } from "../../model/config.js";
import type { AgentRuntimeEvent, TurnStopReason, TurnUsage } from "../../features/events.js";
import type { ExtensionHost } from "../../extensions/host.js";
import { createPermissionGate, type PermissionDecision, type PermissionRequest } from "../../features/permissions.js";
import { createAgentRuntime, type AgentRuntime, type TurnResult } from "../../features/runtime.js";
import { LOCAL_PERMISSION_TOOLS, createLocalTools } from "../../features/local-tools.js";
import { tools as demoTools } from "../../features/tools.js";
import type { Logger } from "../../types.js";
import { blocksToImages, blocksToText, locationsFromArgs } from "./content.js";
import { TOOL_KINDS, describeToolCall, toolCallContent } from "./tool-call.js";
import { ACP_PERMISSION_TOOLS, createAcpTools } from "./tools.js";

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
		const taken = new Set([...demoTools, ...clientTools].map((tool) => tool.name));
		const fallbackTools = options.allowLocalTools
			? createLocalTools({
					roots: [options.cwd, ...options.additionalDirectories],
					allowWrite: true,
					allowExec: true,
				}).filter((tool) => !taken.has(tool.name))
			: [];

		const tools = [...demoTools, ...clientTools, ...fallbackTools];

		this.runtime = createAgentRuntime({
			config: options.config,
			tools,
			extensions: options.extensions,
			systemPrompt: this.systemPrompt(),
			beforeToolCall: createPermissionGate({
				mode: options.permissionMode,
				requires: [...ACP_PERMISSION_TOOLS, ...LOCAL_PERMISSION_TOOLS],
				ask: (request) => this.askPermission(request),
			}),
		});
		this.toolNames = this.runtime.toolNames;
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

		// A plugin command is answered locally; anything else goes to the model.
		const command = /^\/([\w-]+)\s*([\s\S]*)$/.exec(text.trim());
		if (command && this.runtime.commands.some((entry) => entry.name === command[1])) {
			const output = await this.runtime.runCommand(command[1] ?? "", command[2]?.trim() ?? "");
			if (output) {
				await this.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: output } });
			}
			return { stopReason: "end_turn", usage: { ...this.usage } };
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

		return { stopReason: STOP_REASONS[result.stopReason], usage: { ...this.usage } };
	}

	/** Tells the client which slash commands the loaded plugins provide. */
	async announceCommands(): Promise<void> {
		if (this.runtime.commands.length === 0) return;
		await this.send({
			sessionUpdate: "available_commands_update",
			availableCommands: this.runtime.commands.map((command) => ({ name: command.name, description: command.description })),
		});
	}

	cancel(): void {
		this.runtime.abort();
	}

	dispose(): void {
		this.unsubscribe();
		this.runtime.abort();
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

	private accountUsage(usage: TurnUsage): void {
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
				title: describeToolCall(request.toolName, request.args),
				kind: TOOL_KINDS[request.toolName] ?? "other",
				status: "pending",
				rawInput: request.args,
				locations: locationsFromArgs(request.args) ?? null,
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
					title: describeToolCall(event.name, event.args),
					name: event.name,
					kind: TOOL_KINDS[event.name] ?? "other",
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
					content: toolCallContent(event.text, event.details),
					rawOutput: event.details ?? null,
				});
				break;

			default:
				// turn_start / turn_end carry nothing the client needs.
				break;
		}
	}
}
