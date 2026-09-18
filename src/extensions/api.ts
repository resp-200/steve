/**
 * Extension layer: the contract plugins are written against.
 *
 * The vocabulary is the functional layer's own (see `features/events.ts`): a
 * plugin says "block this tool call" or "add this request header", never "emit
 * this ACP notification" — so one plugin works in every front end.
 *
 * This is steve's own host. It is *not* a compatibility layer for pi extensions:
 * those are loaded by `pi-coding-agent`'s extension runner, which this project
 * deliberately does not depend on.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "../features/contract.js";
import type { AgentMessage, AgentTool } from "../features/contract.js";
import type { AgentRuntimeEvent } from "../features/events.js";

const run = promisify(execFile);

/** What a plugin gets to see about the session it was loaded for. */
export interface ExtensionContext {
	/** Working directory of the session. */
	readonly cwd: string;
	/** Front end that loaded the plugin. */
	readonly mode: "cli" | "acp";
	readonly sessionId?: string;
	/** No front end hands interactive UI to plugins yet (pi's `hasUI: false` in print mode). */
	readonly hasUI: false;
	log(message: string): void;
	/** Runs a command locally (not in an editor's terminal). */
	exec(command: string, args?: string[], options?: { cwd?: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; code: number }>;
}

export interface ToolCallHookEvent {
	toolName: string;
	toolCallId: string;
	args: unknown;
}

/** Return `{ block: true }` to refuse a tool call before it runs. */
export interface ToolCallDecision {
	block?: boolean;
	reason?: string;
}

export interface ToolResultHookEvent {
	toolName: string;
	toolCallId: string;
	isError: boolean;
	text: string;
	details?: unknown;
}

/** Returned fields replace the tool result the model sees. */
export interface ToolResultPatch {
	text?: string;
	details?: unknown;
	isError?: boolean;
}

export type ToolCallHandler = (event: ToolCallHookEvent, ctx: ExtensionContext) => ToolCallDecision | undefined | void | Promise<ToolCallDecision | undefined | void>;
export type ToolResultHandler = (event: ToolResultHookEvent, ctx: ExtensionContext) => ToolResultPatch | undefined | void | Promise<ToolResultPatch | undefined | void>;
export type ContextHandler = (messages: AgentMessage[], ctx: ExtensionContext) => AgentMessage[] | undefined | void | Promise<AgentMessage[] | undefined | void>;
/** Header handlers are synchronous: the stream function cannot await. */
export type HeadersHandler = (headers: Record<string, string>, info: { model: string; api: string }, ctx: ExtensionContext) => void;
export type EventHandler = (event: AgentRuntimeEvent, ctx: ExtensionContext) => void;

export interface PluginTool {
	name: string;
	label?: string;
	description: string;
	/** A TypeBox schema (or plain JSON schema object). */
	parameters: unknown;
	execute: AgentTool<any>["execute"];
}

export interface PluginCommand {
	name: string;
	description: string;
	run: (args: string, ctx: ExtensionContext) => string | undefined | void | Promise<string | undefined | void>;
}

/** The object handed to a plugin's default export. */
export interface ExtensionAPI {
	/** TypeBox, so plugins can describe tool parameters without importing pi. */
	readonly Type: typeof Type;
	readonly ctx: ExtensionContext;
	on(event: "tool_call", handler: ToolCallHandler): void;
	on(event: "tool_result", handler: ToolResultHandler): void;
	on(event: "context", handler: ContextHandler): void;
	on(event: "before_provider_headers", handler: HeadersHandler): void;
	on(event: AgentRuntimeEvent["type"], handler: EventHandler): void;
	registerTool(tool: PluginTool): void;
	registerCommand(command: PluginCommand): void;
}

/** What the API recorded, in the order plugins registered it. */
export interface ExtensionRecords {
	toolCallHandlers: ToolCallHandler[];
	toolResultHandlers: ToolResultHandler[];
	contextHandlers: ContextHandler[];
	headerHandlers: HeadersHandler[];
	eventHandlers: Map<AgentRuntimeEvent["type"], EventHandler[]>;
	tools: PluginTool[];
	commands: PluginCommand[];
}

export type PluginFactory = (api: ExtensionAPI) => unknown | Promise<unknown>;

export function createExtensionAPI(ctx: ExtensionContext): { api: ExtensionAPI; records: ExtensionRecords } {
	const records: ExtensionRecords = {
		toolCallHandlers: [],
		toolResultHandlers: [],
		contextHandlers: [],
		headerHandlers: [],
		eventHandlers: new Map(),
		tools: [],
		commands: [],
	};

	const on = (event: string, handler: (...args: never[]) => unknown): void => {
		switch (event) {
			case "tool_call":
				records.toolCallHandlers.push(handler as ToolCallHandler);
				return;
			case "tool_result":
				records.toolResultHandlers.push(handler as ToolResultHandler);
				return;
			case "context":
				records.contextHandlers.push(handler as ContextHandler);
				return;
			case "before_provider_headers":
				records.headerHandlers.push(handler as HeadersHandler);
				return;
			default: {
				const key = event as AgentRuntimeEvent["type"];
				const list = records.eventHandlers.get(key) ?? [];
				list.push(handler as EventHandler);
				records.eventHandlers.set(key, list);
			}
		}
	};

	const api: ExtensionAPI = {
		Type,
		ctx,
		on: on as ExtensionAPI["on"],
		registerTool: (tool) => {
			if (!tool?.name || typeof tool.execute !== "function") {
				throw new Error("registerTool needs a name and an execute function");
			}
			records.tools.push(tool);
		},
		registerCommand: (command) => {
			if (!command?.name || typeof command.run !== "function") {
				throw new Error("registerCommand needs a name and a run function");
			}
			records.commands.push(command);
		},
	};

	return { api, records };
}

/** Builds the default context (plugin authors never construct this themselves). */
export function createExtensionContext(options: { cwd: string; mode: "cli" | "acp"; sessionId?: string; log: (message: string) => void }): ExtensionContext {
	return {
		cwd: options.cwd,
		mode: options.mode,
		...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
		hasUI: false,
		log: options.log,
		async exec(command, args = [], execOptions = {}) {
			try {
				const result = await run(command, args, {
					cwd: execOptions.cwd ?? options.cwd,
					timeout: execOptions.timeoutMs ?? 15_000,
					maxBuffer: 4 * 1024 * 1024,
				});
				return { stdout: result.stdout, stderr: result.stderr, code: 0 };
			} catch (error) {
				const failure = error as { stdout?: string; stderr?: string; code?: number; message?: string };
				return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message ?? "command failed", code: failure.code ?? 1 };
			}
		},
	};
}
