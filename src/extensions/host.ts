/**
 * Extension host: discovers plugin files, loads them, and runs their hooks.
 *
 * Plugins live outside the build:
 *   <cwd>/.steve/extensions/*.mjs   project-local
 *   ~/.steve/extensions/*.mjs       global
 *   explicit paths                  `--extension <file>` / `STEVE_EXTENSIONS`
 *
 * A plugin is an ES module whose default export is `(api) => void`. Everything it
 * does is recorded through {@link createExtensionAPI}. A plugin that throws while
 * loading — or later, while handling a hook — is reported and skipped, never
 * allowed to take the agent loop down with it.
 */
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentMessage } from "../features/contract.js";
import type { AgentRuntimeEvent } from "../features/events.js";
import type { ToolAnnotations } from "../features/tool-annotations.js";
import {
	createExtensionAPI,
	createExtensionContext,
	type ModelInfo,
	type WorkspacePolicy,
	type ContextHandler,
	type EventHandler,
	type ExtensionContext,
	type ExtensionRecords,
	type HeadersHandler,
	type PluginCommand,
	type PluginFactory,
	type PluginMcpServer,
	type PluginTool,
	type SessionAccessors,
	type ToolCallDecision,
	type ToolCallHandler,
	type ToolCallHookEvent,
	type ToolResultHandler,
	type ToolResultHookEvent,
	type ToolResultPatch,
} from "./api.js";
import { demoTools } from "./builtin/demo-tools.js";
import { localTools } from "./builtin/local-tools.js";
import { mcpConfig } from "./builtin/mcp-config.js";
import { sessionCommands } from "./builtin/session-commands.js";
import { discoverExtensionFiles, discoveryEnabled, pluginPaths } from "./discovery.js";

// Re-exported: discovery is part of the host's surface, the implementation lives next door.
export { discoverExtensionFiles, discoveryEnabled, pluginPaths };

const EXTENSION_SUFFIXES = [".mjs", ".js"];

export interface ExtensionLoadError {
	file: string;
	message: string;
}

export interface ExtensionHostOptions {
	cwd: string;
	mode: "cli" | "acp";
	sessionId?: string;
	/** Explicit plugin files or directories. */
	paths?: string[];
	/** Set false to skip the `.steve/extensions` directories. Default: true. */
	discover?: boolean;
	/** Load the in-repo plugins (session commands, local tools, demo tools, mcp.json). Default: true. */
	builtins?: boolean;
	/** Extra in-repo plugins, loaded before files. */
	inline?: { name: string; factory: PluginFactory }[];
	/**
	 * Static session policy plugins may read (workspace roots, access level, shell).
	 * Defaults to `{ roots: [cwd], access: "none" }`: no local capability unless the
	 * front end asks for it.
	 */
	workspace?: WorkspacePolicy;
	/** Which model this session uses; plugins may branch on `supportsImages`. */
	model?: ModelInfo;
	log: (message: string) => void;
}

export interface ExtensionHost {
	/** Plugin files that loaded, in load order. */
	readonly files: string[];
	readonly errors: ExtensionLoadError[];
	readonly tools: PluginTool[];
	readonly commands: PluginCommand[];
	/** How many hooks of each kind are registered (handy for `/plugins` and logs). */
	readonly counts: { toolCall: number; toolResult: number; context: number; headers: number; events: number };
	/** Runs `tool_call` hooks; the first plugin that blocks wins. */
	runToolCall(event: ToolCallHookEvent): Promise<ToolCallDecision | undefined>;
	/** Runs `tool_result` hooks; later plugins override earlier patches. */
	runToolResult(event: ToolResultHookEvent): Promise<ToolResultPatch | undefined>;
	/** Runs `context` hooks, threading the message list through each one. */
	runContext(messages: AgentMessage[]): Promise<AgentMessage[]>;
	/** Runs synchronous `before_provider_headers` hooks in place. */
	runHeaders(headers: Record<string, string>, info: { model: string; api: string }): void;
	/** Fans a normalised runtime event out to `on(<event>)` handlers. */
	dispatch(event: AgentRuntimeEvent): void;
	/** Runs a plugin command; `undefined` when no plugin owns that name. */
	runCommand(name: string, args: string): Promise<string | undefined>;
	/** True when a plugin registered that command name. */
	hasCommand(name: string): boolean;
	/** MCP servers the plugins asked for (the core connects them). */
	readonly mcpServers: PluginMcpServer[];
	/** Tool names plugins marked as needing approval. */
	permissionRequired(): string[];
	/** Presentation hints a plugin declared for a tool, if any. */
	metadataFor(toolName: string): ToolAnnotations["metadata"];
	/** Hands the live session to every plugin (called by the runtime). */
	attachSession(session: SessionAccessors): void;
}

/** Explicit paths first, then project-local, then global; duplicates removed. */
/** The policy plugins see; a front end that says nothing gets no local capability. */
function workspacePolicy(options: ExtensionHostOptions): WorkspacePolicy {
	return options.workspace ?? { roots: [options.cwd], access: "none" };
}

/** What is known about the model before the runtime exists. */
function modelInfo(options: ExtensionHostOptions): ModelInfo {
	return options.model ?? { id: "unknown", api: "unknown", baseUrl: "", supportsImages: false };
}


interface LoadedPlugin {
	file: string;
	records: ExtensionRecords;
	ctx: ExtensionContext;
}

export async function loadExtensions(options: ExtensionHostOptions): Promise<ExtensionHost> {
	const files = discoverExtensionFiles(options);
	const errors: ExtensionLoadError[] = [];
	const loaded: LoadedPlugin[] = [];

	const inRepo: { label: string; factory: PluginFactory }[] = [
		...(options.inline ?? []).map((entry) => ({ label: entry.name, factory: entry.factory })),
		...(options.builtins === false
			? []
			: [
					{ label: "builtin:session-commands", factory: sessionCommands as PluginFactory },
					{ label: "builtin:local-tools", factory: localTools as PluginFactory },
					{ label: "builtin:demo-tools", factory: demoTools as PluginFactory },
					{ label: "builtin:mcp-config", factory: mcpConfig as PluginFactory },
				]),
	];

	for (const entry of inRepo) {
		const ctx = createExtensionContext({
			cwd: options.cwd,
			mode: options.mode,
			workspace: workspacePolicy(options),
			model: modelInfo(options),
			...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
			log: (message) => options.log(`[plugin ${entry.label}] ${message}`),
		});

		try {
			const { api, records } = createExtensionAPI(ctx);
			await entry.factory(api);
			loaded.push({ file: entry.label, records, ctx });
			options.log(`[extensions] loaded ${entry.label}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push({ file: entry.label, message });
			options.log(`[extensions] failed to load ${entry.label}: ${message}`);
		}
	}

	for (const file of files) {
		const label = basename(file);
		const ctx = createExtensionContext({
			cwd: options.cwd,
			mode: options.mode,
			workspace: workspacePolicy(options),
			model: modelInfo(options),
			...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
			log: (message) => options.log(`[plugin ${label}] ${message}`),
		});

		try {
			const module = (await import(pathToFileURL(file).href)) as { default?: PluginFactory };
			if (typeof module.default !== "function") {
				throw new Error("default export must be a function: export default (api) => { … }");
			}

			const { api, records } = createExtensionAPI(ctx);
			await module.default(api);
			loaded.push({ file, records, ctx });
			options.log(`[extensions] loaded ${label}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push({ file, message });
			options.log(`[extensions] failed to load ${label}: ${message}`);
		}
	}

	const report = (file: string, error: unknown): void => {
		const message = error instanceof Error ? error.message : String(error);
		options.log(`[plugin ${basename(file)}] hook failed: ${message}`);
	};

	const guard = async <T>(file: string, call: () => Promise<T> | T): Promise<T | undefined> => {
		try {
			return await call();
		} catch (error) {
			report(file, error);
			return undefined;
		}
	};

	const tools = loaded.flatMap((plugin) => plugin.records.tools);
	const commands = loaded.flatMap((plugin) => plugin.records.commands);
	const mcpServers = loaded.flatMap((plugin) => plugin.records.mcpServers);
	const counts = {
		toolCall: loaded.reduce((total, plugin) => total + plugin.records.toolCallHandlers.length, 0),
		toolResult: loaded.reduce((total, plugin) => total + plugin.records.toolResultHandlers.length, 0),
		context: loaded.reduce((total, plugin) => total + plugin.records.contextHandlers.length, 0),
		headers: loaded.reduce((total, plugin) => total + plugin.records.headerHandlers.length, 0),
		events: loaded.reduce(
			(total, plugin) => total + [...plugin.records.eventHandlers.values()].reduce((sum, list) => sum + list.length, 0),
			0,
		),
	};

	return {
		files: loaded.map((plugin) => plugin.file),
		errors,
		tools,
		commands,
		mcpServers,
		counts,

		permissionRequired: () => tools.filter((tool) => tool.permission === "ask").map((tool) => tool.name),

		metadataFor: (toolName) => tools.find((tool) => tool.name === toolName)?.metadata,

		attachSession: (session) => {
			for (const plugin of loaded) plugin.ctx.session = session;
		},

		async runToolCall(event) {
			for (const plugin of loaded) {
				for (const handler of plugin.records.toolCallHandlers as ToolCallHandler[]) {
					const decision = await guard(plugin.file, () => handler(event, plugin.ctx));
					if (decision?.block) return decision;
				}
			}
			return undefined;
		},

		async runToolResult(event) {
			let patch: ToolResultPatch | undefined;
			for (const plugin of loaded) {
				for (const handler of plugin.records.toolResultHandlers as ToolResultHandler[]) {
					const result = await guard(plugin.file, () => handler(event, plugin.ctx));
					if (result) patch = { ...patch, ...result };
				}
			}
			return patch;
		},

		async runContext(messages) {
			let current = messages;
			for (const plugin of loaded) {
				for (const handler of plugin.records.contextHandlers as ContextHandler[]) {
					const next = await guard(plugin.file, () => handler(current, plugin.ctx));
					if (Array.isArray(next)) current = next;
				}
			}
			return current;
		},

		runHeaders(headers, info) {
			for (const plugin of loaded) {
				for (const handler of plugin.records.headerHandlers as HeadersHandler[]) {
					try {
						handler(headers, info, plugin.ctx);
					} catch (error) {
						report(plugin.file, error);
					}
				}
			}
		},

		dispatch(event) {
			for (const plugin of loaded) {
				for (const handler of (plugin.records.eventHandlers.get(event.type) ?? []) as EventHandler[]) {
					try {
						const result = handler(event, plugin.ctx) as unknown;
						if (result && typeof (result as Promise<unknown>).catch === "function") {
							(result as Promise<unknown>).catch((error: unknown) => report(plugin.file, error));
						}
					} catch (error) {
						report(plugin.file, error);
					}
				}
			}
		},

		hasCommand: (name) => commands.some((command) => command.name === name),

		async runCommand(name, args) {
			for (const plugin of loaded) {
				for (const command of plugin.records.commands) {
					if (command.name !== name) continue;
					const output = await guard(plugin.file, () => command.run(args, plugin.ctx));
					return typeof output === "string" ? output : "";
				}
			}
			return undefined;
		},
	};
}
