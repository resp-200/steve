import type { Agent, AgentEvent, AgentTool, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	RequestError,
	type AgentContext,
	type ClientCapabilities,
	type PromptRequest,
	type PromptResponse,
	type SessionUpdate,
	type StopReason,
	type ToolCallContent,
	type ToolKind,
	type Usage,
} from "@agentclientprotocol/sdk";
import type { AppConfig } from "../../model/config.js";
import { createKernelAgent } from "../../kernel/agent.js";
import { tools as localTools } from "../../features/tools.js";
import { blocksToImages, blocksToText, firstText, locationsFromArgs, truncate } from "./content.js";
import { createAcpTools } from "./tools.js";
import type { Logger } from "../../types.js";


export type PermissionMode = "ask" | "allow";

/** Tools the editor must approve before pi executes them. */
const PERMISSION_REQUIRED = new Set<string>(["write_file", "run_command"]);

const TOOL_KINDS: Record<string, ToolKind> = {
	read_file: "read",
	write_file: "edit",
	run_command: "execute",
	calculate: "other",
	get_current_time: "other",
	get_weather: "other",
};

/** pi stop reasons -> ACP stop reasons. */
const STOP_REASONS: Record<AssistantMessage["stopReason"], StopReason> = {
	stop: "end_turn",
	toolUse: "end_turn",
	pending: "end_turn",
	deferred: "end_turn",
	length: "max_tokens",
	aborted: "cancelled",
	error: "end_turn",
};

function describeToolCall(name: string, args: unknown): string {
	const record = (args ?? {}) as Record<string, unknown>;
	const text = (key: string): string | undefined => (typeof record[key] === "string" ? (record[key] as string) : undefined);

	switch (name) {
		case "read_file":
			return `Read ${text("path") ?? "file"}`;
		case "write_file":
			return `Write ${text("path") ?? "file"}`;
		case "run_command": {
			const extra = Array.isArray(record.args) ? (record.args as unknown[]).join(" ") : "";
			return `Run ${text("command") ?? "command"}${extra ? ` ${extra}` : ""}`;
		}
		case "calculate":
			return `Calculate ${text("expression") ?? ""}`.trim();
		case "get_current_time":
			return "Get current time";
		case "get_weather":
			return `Get weather for ${text("city") ?? "city"}`;
		default:
			return name;
	}
}

/** Tool output shown in the client's tool-call UI (text plus embedded terminal). */
function toolCallContent(result: unknown, isError: boolean): ToolCallContent[] {
	const content: ToolCallContent[] = [];

	const terminalId = (result as { details?: { terminalId?: unknown } } | undefined)?.details?.terminalId;
	if (typeof terminalId === "string") content.push({ type: "terminal", terminalId });

	const text = firstText(result) ?? (isError ? "Tool failed without a message" : "Tool finished without output");
	content.push({ type: "content", content: { type: "text", text: truncate(text) } });

	return content;
}

export interface AcpSessionOptions {
	id: string;
	cwd: string;
	additionalDirectories: string[];
	config: AppConfig;
	/** Connection-scoped context used to call client-side ACP methods. */
	client: AgentContext;
	clientCapabilities: ClientCapabilities;
	permissionMode: PermissionMode;
	logger: Logger;
}

/**
 * One ACP session == one pi `Agent` (own transcript, own tools).
 *
 * pi's event stream is translated into ACP `session/update` notifications, and
 * pi's `beforeToolCall` hook is translated into `session/request_permission`.
 */
export class AcpSession {
	readonly id: string;
	readonly cwd: string;
	readonly toolNames: string[];

	private readonly options: AcpSessionOptions;
	private readonly agent: Agent;
	private readonly supportsImages: boolean;
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

		const tools: AgentTool<any>[] = [
			...localTools,
			...createAcpTools({
				sessionId: options.id,
				workingDirectory: options.cwd,
				client: options.client,
				capabilities: options.clientCapabilities,
			}),
		];
		this.toolNames = tools.map((tool) => tool.name);

		this.agent = createKernelAgent({
			config: options.config,
			tools,
			systemPrompt: this.systemPrompt(),
			hooks: {
				beforeToolCall: async (context) => this.authorize(context.toolCall.name, context.toolCall.id, context.args),
			},
		});

		this.agent.subscribe((event) => this.publish(event));
	}

	/* ------------------------------- prompting ------------------------------ */

	async prompt(request: PromptRequest, signal: AbortSignal): Promise<PromptResponse> {
		if (this.running) {
			// ACP clients send one prompt per session; a second one supersedes the first.
			this.options.logger(`session ${this.id}: superseding the in-flight turn`);
			this.agent.abort();
			await this.agent.waitForIdle();
		}

		const text = blocksToText(request.prompt);
		const images = this.supportsImages ? blocksToImages(request.prompt) : [];
		if (!text.trim() && images.length === 0) {
			throw RequestError.invalidParams(undefined, "Prompt contained no usable content");
		}

		const forwardAbort = (): void => this.agent.abort();
		signal.addEventListener("abort", forwardAbort, { once: true });

		this.running = true;
		try {
			await this.agent.prompt(text, images.length > 0 ? images : undefined);
		} finally {
			signal.removeEventListener("abort", forwardAbort);
			this.running = false;
		}

		const last = this.agent.state.messages.at(-1);
		const assistant = last?.role === "assistant" ? last : undefined;

		if (assistant?.errorMessage && assistant.content.length === 0) {
			// Surface transport/provider failures inside the transcript instead of
			// failing the whole JSON-RPC request, so the client keeps its history.
			await this.send({
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: `⚠️ ${assistant.errorMessage}` },
			});
		}

		if (assistant) {
			this.accountUsage(assistant);
			await this.send({
				sessionUpdate: "usage_update",
				used: assistant.usage.totalTokens,
				size: this.options.config.model.contextWindow,
				cost: null,
			});
		}

		return {
			stopReason: assistant ? STOP_REASONS[assistant.stopReason] : "end_turn",
			usage: { ...this.usage },
		};
	}

	cancel(): void {
		this.agent.abort();
	}

	dispose(): void {
		this.agent.abort();
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

	private accountUsage(assistant: AssistantMessage): void {
		this.usage.inputTokens += assistant.usage.input;
		this.usage.outputTokens += assistant.usage.output;
		this.usage.totalTokens += assistant.usage.totalTokens;
		this.usage.cachedReadTokens = (this.usage.cachedReadTokens ?? 0) + assistant.usage.cacheRead;
		this.usage.cachedWriteTokens = (this.usage.cachedWriteTokens ?? 0) + assistant.usage.cacheWrite;
		this.usage.thoughtTokens = (this.usage.thoughtTokens ?? 0) + (assistant.usage.reasoning ?? 0);
	}

	/**
	 * pi asks the editor for permission before running sensitive tools.
	 * Returning `block: true` turns the denial into an error tool result that the
	 * model sees, so it can explain or pick a different approach.
	 */
	private async authorize(name: string, toolCallId: string, args: unknown): Promise<BeforeToolCallResult | undefined> {
		if (this.options.permissionMode === "allow" || !PERMISSION_REQUIRED.has(name)) return undefined;

		const kind = TOOL_KINDS[name] ?? "other";
		let outcome: string;
		try {
			const response = await this.options.client.request("session/request_permission", {
				sessionId: this.id,
				toolCall: {
					toolCallId,
					title: describeToolCall(name, args),
					kind,
					status: "pending",
					rawInput: args,
					locations: locationsFromArgs(args) ?? null,
				},
				options: [
					{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
					{ optionId: "allow_always", name: `Always allow ${name}`, kind: "allow_always" },
					{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
				],
			});

			if (response.outcome.outcome !== "selected") return { block: true, reason: "Permission request was cancelled." };
			outcome = response.outcome.optionId;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { block: true, reason: `Could not ask the editor for permission: ${message}` };
		}

		if (outcome === "allow_always") {
			PERMISSION_REQUIRED.delete(name);
			return undefined;
		}
		if (outcome === "allow_once") return undefined;

		return { block: true, reason: "The user denied permission for this tool call." };
	}

	private send(update: SessionUpdate): Promise<void> {
		return this.options.client.notify("session/update", { sessionId: this.id, update });
	}

	private publish(event: AgentEvent): void {
		void this.publishEvent(event).catch((error: unknown) => {
			this.options.logger(`session ${this.id}: failed to send update: ${String(error)}`);
		});
	}

	private async publishEvent(event: AgentEvent): Promise<void> {
		switch (event.type) {
			case "message_update": {
				const inner = event.assistantMessageEvent;
				if (inner.type === "text_delta" && inner.delta.length > 0) {
					await this.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: inner.delta } });
				} else if (inner.type === "thinking_delta" && inner.delta.length > 0) {
					await this.send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: inner.delta } });
				}
				break;
			}

			case "tool_execution_start":
				await this.send({
					sessionUpdate: "tool_call",
					toolCallId: event.toolCallId,
					title: describeToolCall(event.toolName, event.args),
					name: event.toolName,
					kind: TOOL_KINDS[event.toolName] ?? "other",
					status: "in_progress",
					rawInput: event.args,
					locations: locationsFromArgs(event.args),
				});
				break;

			case "tool_execution_update": {
				const partial = firstText(event.partialResult);
				if (partial) {
					await this.send({
						sessionUpdate: "tool_call_update",
						toolCallId: event.toolCallId,
						status: "in_progress",
						content: [{ type: "content", content: { type: "text", text: truncate(partial) } }],
					});
				}
				break;
			}

			case "tool_execution_end":
				await this.send({
					sessionUpdate: "tool_call_update",
					toolCallId: event.toolCallId,
					status: event.isError ? "failed" : "completed",
					content: toolCallContent(event.result, event.isError),
					rawOutput: event.result?.details ?? null,
				});
				break;

			default:
				break;
		}
	}
}
