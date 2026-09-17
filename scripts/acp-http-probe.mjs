#!/usr/bin/env node
// Drives the shared browser/Node ACP-over-HTTP client (`web/acp-http-client.js`)
// against a running `npm run acp -- --port ...`, answering every server->client
// request with real Node capabilities. This is the same code path the bundled
// test page uses, so a green run means the wire protocol in the page is correct.
//
//   node dist/acp/main.js --port 8890 --permissions ask --cors "*" &
//   node scripts/acp-http-probe.mjs --url http://127.0.0.1:8890/acp "list files here"
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { AcpHttpClient } from "../web/acp-http-client.js";

const dim = (text) => text;
const log = (message = "") => process.stderr.write(`${message}\n`);

function parseArgs(argv) {
	const options = { url: "http://127.0.0.1:8890/acp", token: undefined, decision: "allow_once", prompts: [] };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--url") options.url = argv[++index];
		else if (arg === "--token") options.token = argv[++index];
		else if (arg === "--deny") options.decision = "reject_once";
		else options.prompts.push(arg);
	}
	return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.prompts.length === 0) options.prompts.push("你好");

const terminals = new Map();
const client = new AcpHttpClient(options.url, { token: options.token });

client
	.onMessage((event) => {
		if (event.direction === "transport") return log(dim(`   · ${event.note}`));
		if (event.direction === "out") {
			const m = event.message;
			return log(dim(`   → ${m.method ?? `response#${m.id}`}${m.params?.sessionId ? ` (session ${String(m.params.sessionId).slice(0, 8)})` : ""}`));
		}
		const m = event.message;
		if (m.method === "session/update") return renderUpdate(m.params.update);
		if (m.method) return log(dim(`   ← ${m.method} (server request #${m.id ?? "notification"})`));
		return log(dim(`   ← response#${m.id}${m.error ? ` error ${m.error.message}` : ""}`));
	})
	.on("session/update", (params) => {
		renderUpdate(params.update);
		return {};
	})
	.on("session/request_permission", (params) => {
		log(`   permission: ${params.toolCall.title} -> ${options.decision}`);
		return { outcome: { outcome: "selected", optionId: options.decision } };
	})
	.on("fs/read_text_file", async (params) => {
		// line/limit 由客户端实现（ACP 只描述请求）
		const lines = (await readFile(params.path, "utf8")).split("\n");
		const start = Math.max(0, (params.line ?? 1) - 1);
		const content = params.line || params.limit ? lines.slice(start, params.limit ? start + params.limit : undefined).join("\n") : lines.join("\n");
		log(`   read ${params.path} (line=${params.line ?? 1}, limit=${params.limit ?? "all"})`);
		return { content };
	})
	.on("fs/write_text_file", async (params) => {
		await writeFile(params.path, params.content, "utf8");
		log(`   wrote ${params.content.length} chars to ${params.path}`);
		return {};
	})
	.on("terminal/create", (params) => {
		const terminalId = `probe-${terminals.size + 1}`;
		const child = spawn(params.command, params.args ?? [], { cwd: params.cwd ?? process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
		const record = { child, output: "", exitCode: null, signal: null };
		child.stdout.on("data", (chunk) => (record.output += chunk));
		child.stderr.on("data", (chunk) => (record.output += chunk));
		record.exit = new Promise((resolve) =>
			child.on("exit", (code, signal) => {
				record.exitCode = code;
				record.signal = signal;
				resolve();
			}),
		);
		terminals.set(terminalId, record);
		log(`   terminal ${terminalId}: ${params.command} ${(params.args ?? []).join(" ")}`);
		return { terminalId };
	})
	.on("terminal/output", (params) => {
		const record = terminals.get(params.terminalId);
		return { output: record?.output ?? "", truncated: false };
	})
	.on("terminal/wait_for_exit", async (params) => {
		const record = terminals.get(params.terminalId);
		await record?.exit;
		return { exitCode: record?.exitCode ?? null, signal: record?.signal ?? null };
	})
	.on("terminal/kill", () => ({}))
	.on("terminal/release", (params) => {
		terminals.get(params.terminalId)?.child.kill("SIGTERM");
		terminals.delete(params.terminalId);
		return {};
	});

function renderUpdate(update) {
	switch (update.sessionUpdate) {
		case "agent_message_chunk":
			if (update.content.type === "text") process.stdout.write(update.content.text);
			break;
		case "agent_thought_chunk":
			if (update.content.type === "text" && update.content.text.trim()) log(dim(`   thinking: ${update.content.text.trim()}`));
			break;
		case "tool_call":
			log(`   tool -> ${update.title} [${update.kind}/${update.status}]`);
			break;
		case "tool_call_update": {
			const text = update.content?.map((part) => (part.type === "content" && part.content.type === "text" ? part.content.text : `[${part.type}]`)).join(" ");
			log(dim(`   tool <- ${update.status} ${text ? text.replace(/\s+/g, " ").slice(0, 120) : ""}`));
			break;
		}
		case "usage_update":
			log(dim(`   usage ${update.used}/${update.size}`));
			break;
		default:
			log(dim(`   update: ${update.sessionUpdate}`));
	}
}

async function main() {
	const initialized = await client.initialize({
		clientName: "steve-http-probe",
		clientVersion: "1.0.0",
		capabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
	});
	log(`initialized: agent=${initialized.agentInfo?.name} v${initialized.agentInfo?.version} protocol=${initialized.protocolVersion}`);
	log(`connection: ${initialized.connectionId}`);
	log(`capabilities: ${JSON.stringify(initialized.agentCapabilities)}`);

	const session = await client.newSession({ cwd: process.cwd() });
	log(`session: ${session.sessionId}`);

	for (const text of options.prompts) {
		log(`\nuser › ${text}`);
		const response = await client.prompt(session.sessionId, [{ type: "text", text }]);
		process.stdout.write("\n");
		log(`stop › ${response.stopReason} · tokens in/out ${response.usage?.inputTokens}/${response.usage?.outputTokens}`);
	}

	// Second prompt reuses the same session (and its still-open SSE stream).
	if (process.env.PROBE_SECOND_TURN) {
		const followUp = await client.prompt(session.sessionId, [{ type: "text", text: process.env.PROBE_SECOND_TURN }]);
		process.stdout.write("\n");
		log(`stop › ${followUp.stopReason}`);
	}

	await client.close();
	log("closed");
}

main().catch((error) => {
	log(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
