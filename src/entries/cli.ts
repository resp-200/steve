#!/usr/bin/env node
import process from "node:process";
import { createInterface } from "node:readline";
import { discoveryEnabled, pluginPaths } from "../extensions/discovery.js";
import { loadExtensions, type ExtensionHost } from "../extensions/host.js";
import type { AgentTool } from "../features/contract.js";
import { connectMcpServers } from "../features/mcp.js";
import type { PermissionDecision, PermissionRequest } from "../features/permissions.js";
import { createAgentRuntime, type AgentRuntime } from "../features/runtime.js";
import { createSessionStore, sessionRecord } from "../features/session-store.js";
import { modelInfo, workspacePolicy } from "../features/session-policy.js";
import { loadConfig, type AppConfig } from "../model/config.js";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { color, Renderer } from "./render.js";

const HELP = `
Commands
  /exit, /quit   leave
  /plugins       list loaded plugins (hooks, tools, commands)
  /help          the full command list — provided by the session-commands plugin,
                 so it also works in editors and cannot go stale here

Flags
  --read-only    no write_file / edit_file / run_command (so no approval prompts)
  --yes, -y      approve every write/exec without asking
  --resume <id>  continue a previous session (the id is printed on exit)
  --session-dir  where transcripts live (default <cwd>/.steve/sessions)
  --no-sessions  do not read or write any transcript
  --help, -h     show this help

Anything else is sent to the model. Ctrl+C aborts a running answer;
pressing it again while idle exits.
`.trim();

/** Short, typeable session id (12 hex chars); collisions are irrelevant locally. */
function newSessionId(): string {
	return randomBytes(6).toString("hex");
}

interface CliOptions {
	/** Register read-only tools only. */
	readOnly: boolean;
	/** Approve write/exec without asking. */
	autoApprove: boolean;
	/** Transcript to resume (`--resume <id>`); new sessions get a generated id. */
	resume?: string;
	/** Where transcripts live (default `<cwd>/.steve/sessions`). */
	sessionDir?: string;
	/** `--no-sessions`: nothing is read or written. */
	noSessions: boolean;
	/** One-shot prompt (everything that was not a flag). */
	prompt: string;
}

interface ReplContext {
	chat: AgentRuntime;
	/** For the banner (model id + endpoint); the session itself lives in `chat`. */
	config: AppConfig;
	extensions: ExtensionHost;
	options: CliOptions;
	/** How the transcript ended up: resumed from disk, fresh, or switched off. */
	sessionState: string;
	/** Persists the transcript (no-op with `--no-sessions`). */
	saveSession: () => Promise<void>;
	/** Prints the `steve --resume <id>` hint when there is something to resume. */
	printResumeHint: () => void;
}

function parseArgv(argv: string[]): CliOptions | "help" {
	const options: CliOptions = { readOnly: false, autoApprove: false, noSessions: false, prompt: "" };
	const rest: string[] = [];

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		if (arg === "--help" || arg === "-h") return "help";
		if (arg === "--read-only" || arg === "--readonly") {
			options.readOnly = true;
			continue;
		}
		if (arg === "--yes" || arg === "-y") {
			options.autoApprove = true;
			continue;
		}
		if (arg === "--no-sessions") {
			options.noSessions = true;
			continue;
		}
		if (arg === "--resume") {
			options.resume = argv[index + 1];
			index += 1;
			continue;
		}
		if (arg === "--session-dir") {
			options.sessionDir = argv[index + 1] ?? options.sessionDir;
			index += 1;
			continue;
		}
		rest.push(arg);
	}

	options.prompt = rest.join(" ").trim();
	return options;
}

/* --------------------------- permission prompts --------------------------- */

/**
 * The REPL hands the next typed line to whoever is waiting for approval; while
 * no turn is running there is nothing to feed, so writes/exec are denied.
 */
let pendingApproval: ((line: string) => void) | null = null;
let canAsk = false;

function describeRequest(request: PermissionRequest): string {
	const args = (request.args ?? {}) as Record<string, unknown>;
	const detail =
		typeof args.command === "string"
			? [args.command, ...(Array.isArray(args.args) ? (args.args as unknown[]).map(String) : [])].join(" ")
			: typeof args.path === "string"
				? args.path
				: JSON.stringify(args).slice(0, 80);
	return `${request.toolName} ${detail}`;
}

function askPermission(request: PermissionRequest, options: CliOptions): Promise<PermissionDecision> {
	if (options.autoApprove) return Promise.resolve("allow_once");

	if (!canAsk) {
		process.stdout.write(
			`\n${color.yellow("denied")} ${describeRequest(request)} ${color.dim("— non-interactive run; pass --yes to allow writes/commands")}\n`,
		);
		return Promise.resolve("deny");
	}

	const preview = request.preview;
	const heading = preview?.summary ?? describeRequest(request);
	process.stdout.write(`\n${color.yellow("permission")} ${heading}\n`);
	if (preview?.text) {
		process.stdout.write(
			preview.text
				.split("\n")
				.map((line) =>
					line.startsWith("+") && !line.startsWith("+++")
						? color.green(`  ${line}`)
						: line.startsWith("-") && !line.startsWith("---")
							? color.red(`  ${line}`)
							: color.dim(`  ${line}`),
				)
				.join("\n") + "\n",
		);
	}
	process.stdout.write(`  ${color.dim("[y] once · [a] always this tool · [n] deny › ")}`);
	return new Promise<PermissionDecision>((resolve) => {
		pendingApproval = (line) => {
			pendingApproval = null;
			const answer = line.trim().toLowerCase();
			resolve(answer.startsWith("y") ? "allow_once" : answer.startsWith("a") ? "allow_always" : "deny");
		};
	});
}

/* --------------------------------- banner --------------------------------- */

function banner(context: ReplContext): void {
	const { config, options, sessionState } = context;
	const access = options.readOnly
		? color.dim("read-only (--read-only)")
		: options.autoApprove
			? color.yellow("writes + commands auto-approved (--yes)")
			: color.dim("writes + commands ask first");

	process.stdout.write(
		[
			"",
			color.bold("steve") + color.dim("  ·  pi-agent-core + pi-ai"),
			`${color.dim("model   ")} ${config.model.id}`,
			`${color.dim("endpoint")} ${config.model.baseUrl}`,
			`${color.dim("cwd     ")} ${process.cwd()}`,
			`${color.dim("tools   ")} ${context.chat.toolNames.join(", ")}`,
			`${color.dim("access  ")} ${access}`,
			`${color.dim("session ")} ${sessionState}`,
			`${color.dim("hint    ")} /help for commands, /exit to quit`,
			"",
		].join("\n") + "\n",
	);
}

function onRetry(reason: string, attempt: number): void {
	process.stdout.write(color.yellow(`retry ${attempt} · ${reason}\n`));
}

/* ------------------------------- commands -------------------------------- */

/** Handles a `/command`. Returns false when the REPL should stop. */
async function runCommand(context: ReplContext, input: string): Promise<boolean> {
	const { chat, extensions } = context;
	const [rawCommand, ...rest] = input.split(/\s+/);
	const command = rawCommand ?? "";

	switch (command) {
		case "/exit":
		case "/quit":
			return false;

		case "/plugins": {
			for (const file of extensions.files) process.stdout.write(`  ${color.bold(file)}\n`);
			const { toolCall, toolResult, context: contextHooks, headers, events } = extensions.counts;
			process.stdout.write(
				color.dim(`  hooks: tool_call=${toolCall} tool_result=${toolResult} context=${contextHooks} headers=${headers} events=${events}\n`),
			);
			for (const pluginCommand of chat.commands) {
				process.stdout.write(`  ${color.bold(`/${pluginCommand.name}`)} ${color.dim(`— ${pluginCommand.description}`)}\n`);
			}
			for (const server of extensions.mcpServers) {
				const detail = server.command ?? `${server.type ?? "stdio"} (unsupported)`;
				process.stdout.write(`  ${color.bold(`mcp ${server.name}`)} ${color.dim(detail)}\n`);
			}
			for (const error of extensions.errors) {
				process.stdout.write(`  ${color.red("failed")} ${error.file}${color.dim(`: ${error.message}`)}\n`);
			}
			return true;
		}

		default: {
			const pluginName = command.replace(/^\//, "");
			const pluginCommand = chat.commands.find((entry) => entry.name === pluginName);
			if (pluginCommand) {
				const output = await chat.runCommand(pluginCommand.name, rest.join(" "));
				if (output) process.stdout.write(`${output}\n`);
				return true;
			}

			process.stdout.write(color.yellow(`Unknown command ${command}. Try /help.\n`));
			return true;
		}
	}
}

/* --------------------------------- modes --------------------------------- */

async function runOneShot(chat: AgentRuntime, input: string): Promise<void> {
	const result = await chat.prompt(input, { onRetry });
	process.exitCode = result.failed ? 1 : 0;
}

async function runRepl(context: ReplContext): Promise<void> {
	const { chat } = context;
	banner(context);

	const interactive = process.stdin.isTTY === true;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const prompt = (): void => {
		if (interactive) rl.prompt();
	};
	if (interactive) rl.setPrompt(`${color.green("you")} ${color.dim("›")} `);

	let running = false;
	canAsk = true;

	const onSigint = (): void => {
		if (running) {
			process.stdout.write(color.yellow("\nAborting current answer...\n"));
			chat.abort();
			return;
		}
		process.stdout.write("\n");
		context.printResumeHint();
		rl.close();
		process.exit(0);
	};
	process.on("SIGINT", onSigint);

	try {
		prompt();
		for await (const rawLine of rl) {
			// A pending approval owns the next line, not the model.
			if (pendingApproval) {
				const answer = pendingApproval;
				answer(rawLine);
				continue;
			}

			const input = rawLine.trim();
			if (!input) {
				prompt();
				continue;
			}

			if (running) {
				process.stdout.write(color.dim("still working — Ctrl+C aborts, or answer the permission prompt.\n"));
				continue;
			}

			if (input.startsWith("/")) {
				const keepGoing = await runCommand(context, input);
				// `/new` (a plugin command) empties the transcript; save so a restart
				// resumes the fresh conversation rather than the one just discarded.
				await context.saveSession();
				if (!keepGoing) break;
				prompt();
				continue;
			}

			running = true;
			// Keep reading stdin while the turn runs: the permission prompt needs it.
			void chat
				.prompt(input, { onRetry })
				.catch((error: unknown) => {
					process.stdout.write(`${color.red("fatal")} ${error instanceof Error ? error.message : String(error)}\n`);
				})
				.finally(() => {
					running = false;
					void context.saveSession();
					prompt();
				});
		}
	} finally {
		canAsk = false;
		process.off("SIGINT", onSigint);
		rl.close();
		context.printResumeHint();
	}
}

async function main(): Promise<void> {
	const parsed = parseArgv(process.argv.slice(2));
	if (parsed === "help") {
		process.stdout.write(`${HELP}\n`);
		return;
	}

	const config = loadConfig();
	const cwd = process.cwd();

	// Transcript persistence, same store and file format the ACP server uses.
	// A run never resumes on its own: it gets a fresh id, prints it, and the exit
	// hint tells the user how to come back (`--resume <id>`).
	const store = parsed.noSessions
		? undefined
		: createSessionStore({
				dir: parsed.sessionDir ?? join(cwd, ".steve", "sessions"),
				logger: (message) => process.stderr.write(`${color.dim(message)}\n`),
			});
	const sessionId = parsed.resume ?? newSessionId();
	if (parsed.resume && parsed.noSessions) {
		process.stderr.write(`${color.yellow("note")} --resume is ignored with --no-sessions\n`);
	}
	const stored = store && parsed.resume ? await store.load(parsed.resume) : undefined;
	if (store && parsed.resume && !stored) {
		process.stderr.write(`${color.yellow("note")} no transcript for "${parsed.resume}" — starting a new one\n`);
	}
	const sessionState = store
		? stored
			? `${sessionId} · resumed ${stored.messages.length} message(s)`
			: sessionId
		: "off (--no-sessions)";
	const extensions = await loadExtensions({
		cwd,
		mode: "cli",
		paths: pluginPaths(),
		discover: discoveryEnabled(),
		// The front end publishes policy; the local-tools plugin reads it.
		workspace: workspacePolicy({ cwd, access: parsed.readOnly ? "read" : "exec" }),
		model: modelInfo(config),
		log: (message) => process.stderr.write(`${color.dim(message)}\n`),
	});


	// Plugins can contribute MCP servers; the core connects them for the session.
	const pluginLog = (message: string): void => {
		process.stderr.write(`${color.dim(message)}\n`);
	};
	const mcp = await connectMcpServers(extensions.mcpServers, { logger: pluginLog, cwd });
	// Local tools arrive through the built-in plugin; the CLI only publishes policy.
	const catalog: AgentTool<any>[] = [...mcp.tools];
	const closeMcp = async (): Promise<void> => {
		await Promise.all(mcp.connections.map((connection) => connection.close()));
	};

	const chat = createAgentRuntime({
		config,
		tools: catalog,
		extensions,
		mcpServers: mcp.servers,
		logger: pluginLog,
		// Tools declare their own approval requirement and preview.
		permissions: {
			mode: parsed.autoApprove ? "allow" : "ask",
			ask: (request) => askPermission(request, parsed),
		},
	});
	if (stored) chat.restore(stored.messages);

	/**
	 * Saves the transcript after every turn, and after `/new` (which empties it).
	 * A brand-new session with nothing in it writes no file — otherwise every
	 * `steve --help`-style run would litter the sessions directory.
	 */
	const saveSession = async (): Promise<void> => {
		if (!store) return;
		const messages = chat.snapshot();
		if (messages.length === 0 && !stored) return;
		await store.save(
			sessionRecord({
				id: sessionId,
				cwd,
				messages,
				...(stored?.createdAt !== undefined ? { createdAt: stored.createdAt } : {}),
			}),
		);
	};

	/** How to come back to this conversation; only worth printing if there is one. */
	const printResumeHint = (): void => {
		if (!store || chat.snapshot().length === 0) return;
		process.stdout.write(`\n${color.dim("Resume this session with:")}\n  ${color.bold(`steve --resume ${sessionId}`)}\n`);
	};

	const renderer = new Renderer();
	chat.subscribe((event) => renderer.handle(event));

	if (parsed.prompt) {
		await runOneShot(chat, parsed.prompt);
		await saveSession();
		printResumeHint();
		await closeMcp();
		return;
	}

	await runRepl({ chat, config, extensions, options: parsed, sessionState, saveSession, printResumeHint });
	await closeMcp();
}

main().catch((error: unknown) => {
	process.stderr.write(`${color.red("fatal")} ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
