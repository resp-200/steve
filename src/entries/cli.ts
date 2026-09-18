#!/usr/bin/env node
import process from "node:process";
import { createInterface } from "node:readline";
import { createChatAgent, type ChatAgent } from "../features/runtime.js";
import { loadConfig, type AppConfig } from "../model/config.js";
import { color, Renderer } from "./render.js";
import { tools } from "../features/tools.js";

const HELP = `
Commands
  /help          show this help
  /new           start a fresh conversation (keeps the model)
  /tools         list the tools the agent can call
  /model         show the active model and endpoint
  /stats         show turn / token counters
  /exit, /quit   leave

Anything else is sent to the model. Ctrl+C aborts a running answer;
pressing it again while idle exits.
`.trim();

function banner(config: AppConfig): void {
	process.stdout.write(
		[
			"",
			color.bold("steve") + color.dim("  ·  pi-agent-core + pi-ai"),
			`${color.dim("model   ")} ${config.model.id}`,
			`${color.dim("endpoint")} ${config.model.baseUrl}`,
			`${color.dim("tools   ")} ${tools.map((tool) => tool.name).join(", ")}`,
			`${color.dim("hint    ")} /help for commands, /exit to quit`,
			"",
		].join("\n") + "\n",
	);
}

function onRetry(reason: string, attempt: number): void {
	process.stdout.write(color.yellow(`retry ${attempt} · ${reason}\n`));
}

/** Handles a `/command`. Returns false when the REPL should stop. */
function runCommand(chat: ChatAgent, config: AppConfig, input: string): boolean {
	const [command] = input.split(/\s+/);

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

		case "/tools":
			for (const tool of tools) {
				process.stdout.write(`  ${color.bold(tool.name)} ${color.dim(`— ${tool.description}`)}\n`);
			}
			return true;

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

		default:
			process.stdout.write(color.yellow(`Unknown command ${command}. Try /help.\n`));
			return true;
	}
}

async function runOneShot(chat: ChatAgent, input: string): Promise<void> {
	const result = await chat.send(input, { onRetry });
	process.exitCode = result.failed ? 1 : 0;
}

async function runRepl(chat: ChatAgent, config: AppConfig): Promise<void> {
	banner(config);

	const interactive = process.stdin.isTTY === true;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const prompt = (): void => {
		if (interactive) rl.prompt();
	};
	if (interactive) rl.setPrompt(`${color.green("you")} ${color.dim("›")} `);

	let running = false;
	const onSigint = (): void => {
		if (running) {
			process.stdout.write(color.yellow("\nAborting current answer...\n"));
			chat.agent.abort();
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
			const input = rawLine.trim();
			if (!input) {
				prompt();
				continue;
			}

			if (input.startsWith("/")) {
				const keepGoing = runCommand(chat, config, input);
				if (!keepGoing) break;
				prompt();
				continue;
			}

			running = true;
			try {
				await chat.send(input, { onRetry });
			} catch (error) {
				process.stdout.write(`${color.red("fatal")} ${error instanceof Error ? error.message : String(error)}\n`);
			} finally {
				running = false;
			}
			prompt();
		}
	} finally {
		process.off("SIGINT", onSigint);
		rl.close();
	}
}

async function main(): Promise<void> {
	const config = loadConfig();
	const chat = createChatAgent(config);
	const renderer = new Renderer();
	chat.agent.subscribe((event) => renderer.handle(event));

	const oneShot = process.argv.slice(2).join(" ").trim();
	if (oneShot === "--help" || oneShot === "-h") {
		process.stdout.write(`${HELP}\n`);
		return;
	}

	if (oneShot) {
		await runOneShot(chat, oneShot);
		return;
	}

	await runRepl(chat, config);
}

main().catch((error: unknown) => {
	process.stderr.write(`${color.red("fatal")} ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
