#!/usr/bin/env node
import process from "node:process";
import { createInterface } from "node:readline";
import { loadExtensions, type ExtensionHost } from "../extensions/host.js";
import type { AgentTool } from "../features/contract.js";
import { LOCAL_PERMISSION_TOOLS, createLocalTools } from "../features/local-tools.js";
import { createPermissionGate, type PermissionDecision, type PermissionRequest } from "../features/permissions.js";
import { createAgentRuntime, type AgentRuntime } from "../features/runtime.js";
import { tools as demoTools } from "../features/tools.js";
import { loadConfig, type AppConfig } from "../model/config.js";
import { color, Renderer } from "./render.js";

const HELP = `
Commands
  /help          show this help
  /new           start a fresh conversation (keeps the model)
  /tools         list the tools the agent can call
  /model         show the active model and endpoint
  /plugins       list loaded plugins (hooks, tools, commands)
  /stats         show turn / token counters
  /exit, /quit   leave

Flags
  --read-only    no write_file / edit_file / run_command (so no approval prompts)
  --yes, -y      approve every write/exec without asking
  --help, -h     show this help

Anything else is sent to the model. Ctrl+C aborts a running answer;
pressing it again while idle exits.
`.trim();

interface CliOptions {
	/** Register read-only tools only. */
	readOnly: boolean;
	/** Approve write/exec without asking. */
	autoApprove: boolean;
	/** One-shot prompt (everything that was not a flag). */
	prompt: string;
}

interface ReplContext {
	chat: AgentRuntime;
	config: AppConfig;
	extensions: ExtensionHost;
	/** Tools the session registered (demo + local), for `/tools`. */
	catalog: AgentTool<any>[];
	options: CliOptions;
}

function parseArgv(argv: string[]): CliOptions | "help" {
	const options: CliOptions = { readOnly: false, autoApprove: false, prompt: "" };
	const rest: string[] = [];

	for (const arg of argv) {
		if (arg === "--help" || arg === "-h") return "help";
		if (arg === "--read-only" || arg === "--readonly") {
			options.readOnly = true;
			continue;
		}
		if (arg === "--yes" || arg === "-y") {
			options.autoApprove = true;
			continue;
		}
		rest.push(arg);
	}

	options.prompt = rest.join(" ").trim();
	return options;
}

/** Plugin paths from `STEVE_EXTENSIONS` (comma separated files or directories). */
function extensionPaths(): string[] {
	return (process.env.STEVE_EXTENSIONS ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
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

	process.stdout.write(`\n${color.yellow("permission")} ${describeRequest(request)}\n  ${color.dim("[y] once · [a] always this tool · [n] deny › ")}`);
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
	const { config, catalog, options } = context;
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
			`${color.dim("tools   ")} ${catalog.map((tool) => tool.name).join(", ")}`,
			`${color.dim("access  ")} ${access}`,
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
	const { chat, config, extensions, catalog } = context;
	const [rawCommand, ...rest] = input.split(/\s+/);
	const command = rawCommand ?? "";

	switch (command) {
		case "/exit":
		case "/quit":
			return false;

		case "/help":
			process.stdout.write(`${HELP}\n`);
			return true;

		case "/new":
			chat.reset();
			process.stdout.write(color.dim("Started a new conversation.\n"));
			return true;

		case "/tools": {
			for (const tool of catalog) {
				const needsApproval = (LOCAL_PERMISSION_TOOLS as readonly string[]).includes(tool.name);
				process.stdout.write(`  ${color.bold(tool.name)} ${color.dim(`— ${tool.description}`)}${needsApproval ? ` ${color.yellow("(asks first)")}` : ""}\n`);
			}
			for (const tool of extensions.tools) {
				process.stdout.write(`  ${color.bold(tool.name)} ${color.dim(`— ${tool.description}`)} ${color.yellow("(plugin)")}\n`);
			}
			return true;
		}

		case "/plugins": {
			if (extensions.files.length === 0) {
				process.stdout.write(color.dim("No plugins loaded. Put .mjs files in .steve/extensions or set STEVE_EXTENSIONS.\n"));
				return true;
			}

			for (const file of extensions.files) process.stdout.write(`  ${color.bold(file)}\n`);
			const { toolCall, toolResult, context: contextHooks, headers, events } = extensions.counts;
			process.stdout.write(
				color.dim(`  hooks: tool_call=${toolCall} tool_result=${toolResult} context=${contextHooks} headers=${headers} events=${events}\n`),
			);
			for (const pluginCommand of chat.commands) {
				process.stdout.write(`  ${color.bold(`/${pluginCommand.name}`)} ${color.dim(`— ${pluginCommand.description}`)}\n`);
			}
			for (const error of extensions.errors) {
				process.stdout.write(`  ${color.red("failed")} ${error.file}${color.dim(`: ${error.message}`)}\n`);
			}
			return true;
		}

		case "/model":
			process.stdout.write(
				`  ${config.model.id} ${color.dim(`via ${config.model.baseUrl} (api: ${config.model.api}, auth: ${config.authStyle}, reasoning ${config.model.reasoning})`)}\n`,
			);
			return true;

		case "/stats": {
			const stats = chat.stats();
			process.stdout.write(
				`  ${color.dim("assistant turns")} ${stats.turns}` +
					`  ${color.dim("user messages")} ${stats.userMessages}` +
					`  ${color.dim("tool calls")} ${stats.toolCalls}` +
					`  ${color.dim("tokens in/out")} ${stats.inputTokens}/${stats.outputTokens}\n`,
			);
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
					prompt();
				});
		}
	} finally {
		canAsk = false;
		process.off("SIGINT", onSigint);
		rl.close();
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
	const extensions = await loadExtensions({
		cwd,
		mode: "cli",
		paths: extensionPaths(),
		log: (message) => process.stderr.write(`${color.dim(message)}\n`),
	});

	const localTools = createLocalTools({
		roots: [cwd],
		allowWrite: !parsed.readOnly,
		allowExec: !parsed.readOnly,
	});
	const catalog: AgentTool<any>[] = [...demoTools, ...localTools];

	const chat = createAgentRuntime({
		config,
		tools: catalog,
		extensions,
		beforeToolCall: createPermissionGate({
			mode: parsed.autoApprove ? "allow" : "ask",
			requires: LOCAL_PERMISSION_TOOLS,
			ask: (request) => askPermission(request, parsed),
		}),
	});
	const renderer = new Renderer();
	chat.subscribe((event) => renderer.handle(event));

	if (parsed.prompt) {
		await runOneShot(chat, parsed.prompt);
		return;
	}

	await runRepl({ chat, config, extensions, catalog, options: parsed });
}

main().catch((error: unknown) => {
	process.stderr.write(`${color.red("fatal")} ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
