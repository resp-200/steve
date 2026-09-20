#!/usr/bin/env node
// Minimal ACP *client* used to exercise `src/protocols/acp` (and as a reference for
// embedding this agent in another host).
//
//   node scripts/acp-client.mjs "list the files here"          # spawns the agent over stdio
//   node scripts/acp-client.mjs --agent-cwd /path/to/project "hi"   # session cwd
//   (works from any directory: the agent path is resolved relative to this script)
//   node scripts/acp-client.mjs --http http://127.0.0.1:8890/acp --token secret "..."
//   node scripts/acp-client.mjs --deny "delete everything"     # rejects permission prompts
//   node scripts/acp-client.mjs --cancel-after 2000 "count to 100"
//
// stdout is reserved for the ACP wire format in stdio mode; all logging goes to stderr.
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { client as createClientApp, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";

// Absolute, so the client can be run from any directory (an editor spawns the
// agent from its own cwd, and `session/new` carries the project directory).
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const dim = (text) => (process.stderr.isTTY ? `\u001b[2m${text}\u001b[0m` : text);
const cyan = (text) => (process.stderr.isTTY ? `\u001b[36m${text}\u001b[0m` : text);
const yellow = (text) => (process.stderr.isTTY ? `\u001b[33m${text}\u001b[0m` : text);
const red = (text) => (process.stderr.isTTY ? `\u001b[31m${text}\u001b[0m` : text);

const log = (message = "") => process.stderr.write(`${message}\n`);

function parseArgs(argv) {
	const options = {
		prompts: [],
		http: undefined,
		token: undefined,
		command: "node",
		agentArgs: [join(ROOT, "dist", "protocols", "acp", "main.js")],
		decision: "allow_once",
		cancelAfter: undefined,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = () => argv[++index];
		switch (arg) {
			case "--http":
				options.http = next();
				break;
			case "--ws":
				options.ws = next();
				break;
			case "--token":
				options.token = next();
				break;
			case "--command":
				options.command = next();
				break;
			case "--agent-args":
				options.agentArgs = (next() ?? "").split(" ").filter(Boolean);
				break;
			case "--deny":
				options.decision = "reject_once";
				break;
			case "--always":
				options.decision = "allow_always";
				break;
			case "--cancel-after":
				options.cancelAfter = Number.parseInt(next() ?? "", 10);
				break;
			case "--help":
				options.help = true;
				break;
			default:
				options.prompts.push(arg);
		}
	}
	return options;
}

/* --------------------------------- terminals -------------------------------- */

let terminalCounter = 0;
const terminals = new Map();

function createTerminal(request) {
	const terminalId = `term-${++terminalCounter}`;
	const child = spawn(request.command, request.args ?? [], {
		cwd: request.cwd ?? process.cwd(),
		env: { ...process.env, ...Object.fromEntries((request.env ?? []).map((item) => [item.name, item.value])) },
		stdio: ["ignore", "pipe", "pipe"],
	});

	let output = "";
	child.stdout.on("data", (chunk) => (output += chunk.toString()));
	child.stderr.on("data", (chunk) => (output += chunk.toString()));

	const exit = new Promise((resolve) => {
		child.on("exit", (code, signal) => {
			record.exitCode = code;
			record.signal = signal;
			resolve();
		});
		child.on("error", (error) => {
			output += `\n[spawn error] ${error.message}`;
			record.exitCode = 127;
			resolve();
		});
	});

	const record = { child, exit, get output() { return output; }, exitCode: null, signal: null };
	terminals.set(terminalId, record);
	log(dim(`   client: terminal ${terminalId} started: ${request.command} ${(request.args ?? []).join(" ")}`));
	return { terminalId };
}

function requireTerminal(terminalId) {
	const record = terminals.get(terminalId);
	if (!record) throw new Error(`Unknown terminal ${terminalId}`);
	return record;
}

/* ---------------------------------- client ---------------------------------- */

const options = parseArgs(process.argv.slice(2));
if (options.help || options.prompts.length === 0) {
	log(
		[
			"usage: node scripts/acp-client.mjs [--http <url>] [--token <t>] [--deny|--always] [--cancel-after <ms>] <prompt...>",
			"",
			"examples:",
			'  node scripts/acp-client.mjs "list the files in this directory"',
			'  node scripts/acp-client.mjs --http http://127.0.0.1:8890/acp --token secret "hello"',
		].join("\n"),
	);
	process.exit(options.help ? 0 : 1);
}

const app = createClientApp({ name: "steve-cli-client" })
	.onNotification("session/update", (ctx) => {
		const { update } = ctx.params;
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
				if (update.content.type === "text") process.stdout.write(update.content.text);
				break;
			case "agent_thought_chunk":
				if (update.content.type === "text" && update.content.text.trim()) {
					log(dim(`thinking › ${update.content.text.trim()}`));
				}
				break;
			case "tool_call":
				log(yellow(`tool › ${update.title} [${update.kind}/${update.status}] ${JSON.stringify(update.rawInput ?? {})}`));
				break;
			case "tool_call_update": {
				const text = update.content?.map((part) => (part.type === "content" && part.content.type === "text" ? part.content.text : `[${part.type}]`)).join(" ");
				log(dim(`  ${update.status}${text ? ` · ${text.replace(/\s+/g, " ").slice(0, 160)}` : ""}`));
				break;
			}
			case "usage_update":
				log(dim(`usage › ${update.used}/${update.size} tokens`));
				break;
			default:
				log(dim(`update › ${update.sessionUpdate}`));
		}
	})
	.onRequest("session/request_permission", (ctx) => {
		const { toolCall } = ctx.params;
		log(yellow(`permission › ${toolCall.title} -> ${options.decision}`));
		return { outcome: { outcome: "selected", optionId: options.decision } };
	})
	.onRequest("fs/read_text_file", async (ctx) => {
		// The client owns the file system: `line`/`limit` slicing is our job.
		const { path, line, limit } = ctx.params;
		let content = await readFile(path, "utf8");
		if (line || limit) {
			const lines = content.split("\n");
			const start = Math.max(0, (line ?? 1) - 1);
			content = lines.slice(start, limit ? start + limit : undefined).join("\n");
		}
		log(dim(`   client: read ${path}${line || limit ? ` (line=${line ?? 1}, limit=${limit ?? "all"})` : ""}`));
		return { content };
	})
	.onRequest("fs/write_text_file", async (ctx) => {
		await writeFile(ctx.params.path, ctx.params.content, "utf8");
		log(dim(`   client: wrote ${ctx.params.content.length} chars to ${ctx.params.path}`));
		return {};
	})
	.onRequest("terminal/create", (ctx) => createTerminal(ctx.params))
	.onRequest("terminal/output", (ctx) => {
		const record = requireTerminal(ctx.params.terminalId);
		return { output: record.output, truncated: false, ...(record.exitCode === null ? {} : { exitStatus: { exitCode: record.exitCode, signal: record.signal } }) };
	})
	.onRequest("terminal/wait_for_exit", async (ctx) => {
		const record = requireTerminal(ctx.params.terminalId);
		await record.exit;
		return { exitCode: record.exitCode, signal: record.signal };
	})
	.onRequest("terminal/kill", (ctx) => {
		requireTerminal(ctx.params.terminalId).child.kill("SIGTERM");
		return {};
	})
	.onRequest("terminal/release", (ctx) => {
		const record = terminals.get(ctx.params.terminalId);
		terminals.delete(ctx.params.terminalId);
		record?.child.kill("SIGTERM");
		return {};
	});

async function run() {
	let child;
	let stream;

	if (options.ws) {
		log(dim(`connecting over websocket to ${options.ws}`));
		const { WebSocket } = await import("ws");
		stream = createWebSocketStream(options.ws, {
			WebSocket,
			headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
		});
	} else if (options.http) {
		log(dim(`connecting to ${options.http}`));
		stream = createHttpStream(options.http, {
			headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
		});
	} else {
		child = spawn(options.command, options.agentArgs, { stdio: ["pipe", "pipe", "inherit"] });
		log(dim(`spawned ${options.command} ${options.agentArgs.join(" ")} (pid ${child.pid})`));
		stream = ndJsonStream(
			Writable.toWeb(child.stdin),
			Readable.toWeb(child.stdout),
		);
	}

	await app.connectWith(stream, async (ctx) => {
		const initialized = await ctx.request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: {
				fs: { readTextFile: true, writeTextFile: true },
				terminal: true,
			},
			clientInfo: { name: "steve-cli-client", version: "0.1.0" },
		});
		log(dim(`initialized: agent=${initialized.agentInfo?.name} v${initialized.agentInfo?.version} protocol=${initialized.protocolVersion}`));
		log(dim(`capabilities: ${JSON.stringify(initialized.agentCapabilities)}`));

		const session = await ctx.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		log(dim(`session: ${session.sessionId}`));

		let cancelTimer;
		if (options.cancelAfter && options.cancelAfter > 0) {
			cancelTimer = setTimeout(() => {
				log(yellow(`\n-- cancel-after ${options.cancelAfter}ms: sending session/cancel`));
				void ctx.notify("session/cancel", { sessionId: session.sessionId });
			}, options.cancelAfter);
		}

		for (const prompt of options.prompts) {
			log(`\n${cyan("user ›")} ${prompt}`);
			process.stdout.write("\n");
			const response = await ctx.request("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: prompt }],
			});
			process.stdout.write("\n");
			log(dim(`stop › ${response.stopReason}${response.usage ? ` · tokens in/out ${response.usage.inputTokens}/${response.usage.outputTokens}` : ""}`));
		}

		clearTimeout(cancelTimer);

		// Denied permissions have to be observed the same way a client would.
		for (const record of terminals.values()) record.child.kill("SIGTERM");
		terminals.clear();
	});

	child?.kill("SIGTERM");
	log(red("connection closed"));
}

run().catch((error) => {
	log(red(`client error: ${error instanceof Error ? error.message : String(error)}`));
	process.exitCode = 1;
});
