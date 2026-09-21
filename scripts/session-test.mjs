#!/usr/bin/env node
// Verifies session persistence and `session/load`:
//
//   A. session store: roundtrip, listing, removal, id safety, corrupt files
//   B. runtime: snapshot/restore/transcript normalisation
//   C. ACP end to end: a session is saved to disk, `session/load` replays the
//      history to the client, and the resumed session keeps chatting
//
//   npm run build && node scripts/session-test.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AcpHttpClient } from "../web/acp-http-client.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const scratchHome = mkdtempSync(join(tmpdir(), "steve-home-")); // isolate ~/.steve for spawned agents
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 8896);
const ACP_PORT = Number(process.env.PLUGIN_TEST_PORT ?? 8895);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const check = (name, passed, detail = "") => {
	checks.push({ name, passed });
	process.stderr.write(`  ${passed ? "✓" : "✗"} ${name}${passed || !detail ? "" : ` — ${detail}`}\n`);
};

async function waitForPort(port, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const open = await new Promise((resolve) => {
			const socket = connect({ port, host: "127.0.0.1" });
			socket.once("connect", () => {
				socket.destroy();
				resolve(true);
			});
			socket.once("error", () => resolve(false));
		});
		if (open) return;
		await sleep(120);
	}
	throw new Error(`port ${port} never opened`);
}

/* ------------------------- A. session store ------------------------------ */

async function storeChecks() {
	const { createSessionStore } = await import("../dist/features/session-store.js");

	const dir = mkdtempSync(join(tmpdir(), "steve-sessions-"));
	const logs = [];
	const store = createSessionStore({ dir, logger: (message) => logs.push(message) });

	const session = {
		id: "11111111-2222-3333-4444-555555555555",
		cwd: "/tmp/project",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:05.000Z",
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		usage: { input: 3, output: 2 },
	};
	await store.save(session);

	check("写入后文件落在指定目录", existsSync(join(dir, `${session.id}.json`)));
	const loaded = await store.load(session.id);
	check("读回内容与写入一致", loaded?.messages.length === 1 && loaded?.cwd === "/tmp/project");
	check("list 能列出会话", (await store.list()).some((entry) => entry.id === session.id));

	check("拒绝非法 id（路径穿越）", (await store.load("../../etc/passwd")) === undefined && (await store.load("..")) === undefined);
	await store.save({ ...session, id: "../evil" });
	check(
		"非法 id 被拒绝且不落盘",
		!existsSync(join(dir, "..json")) && !existsSync(join(dir, "..", "evil.json")) && logs.some((line) => line.includes("refusing to load")) && logs.some((line) => line.includes("refusing to save")),
		logs.filter((line) => line.includes("refusing")).slice(0, 2).join(" | "),
	);

	const missing = await store.load("99999999-9999-9999-9999-999999999999");
	check("不存在的会话返回 undefined（且不报错）", missing === undefined && !logs.some((line) => line.includes("could not load")));

	await store.save({ ...session, id: "broken", messages: undefined });
	check("结构不对的 transcript 被忽略", (await store.load("broken")) === undefined && logs.some((line) => line.includes("malformed")));

	await store.remove(session.id);
	check("remove 删除文件", !existsSync(join(dir, `${session.id}.json`)));

	rmSync(dir, { recursive: true, force: true });
}

/* --------------------------- B. runtime snapshot ------------------------- */

async function runtimeChecks() {
	const { createAgentRuntime } = await import("../dist/features/runtime.js");
	const { loadConfig } = await import("../dist/model/config.js");

	const config = loadConfig();
	const runtime = createAgentRuntime({ config });

	runtime.restore([
		{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "pondering" },
				{ type: "text", text: "hi there" },
				{ type: "toolCall", id: "call_1", name: "get_current_time", arguments: { timeZone: "UTC" } },
			],
			api: "anthropic-messages",
			provider: "custom",
			model: config.model.id,
			usage: { input: 5, output: 2, totalTokens: 7, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "get_current_time",
			content: [{ type: "text", text: "2024-01-01 00:00:00 (UTC)" }],
			isError: false,
			timestamp: 3,
		},
	]);

	check("snapshot 反映恢复的 transcript", runtime.snapshot().length === 3);

	const transcript = runtime.transcript();
	check(
		"transcript 归一化 user/assistant/tool",
		transcript.length === 3 && transcript[0].role === "user" && transcript[1].role === "assistant" && transcript[2].role === "tool",
		transcript.map((entry) => entry.role).join(","),
	);
	check(
		"assistant 条目带 thinking/text/toolCalls",
		transcript[1].thinking === "pondering" && transcript[1].text === "hi there" && transcript[1].toolCalls[0]?.name === "get_current_time",
		JSON.stringify(transcript[1]).slice(0, 120),
	);
	check("tool 条目带结果文本", transcript[2].text.startsWith("2024-01-01") && transcript[2].toolCallId === "call_1");
	check("restore 后统计沿用 transcript", runtime.stats().turns === 1 && runtime.stats().toolCalls === 1);
}

/* ---------------------------- C. ACP session/load ------------------------ */

async function acpChecks() {
	const sessionDir = mkdtempSync(join(tmpdir(), "steve-load-"));
	const mock = spawn(process.execPath, ["scripts/mock-server.mjs"], {
		cwd: ROOT,
		env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
		stdio: ["ignore", "pipe", "pipe"],
	});

	const serverLog = [];
	const server = spawn(
		process.execPath,
		["dist/protocols/acp/main.js", "--port", String(ACP_PORT), "--cors", "*", "--session-dir", sessionDir],
		{
			cwd: ROOT,
			env: { ...process.env, STEVE_DISCOVERY: "off",
					HOME: scratchHome,
					LLM_API_KEY: "mock", LLM_MODEL_ID: "mock", LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/anthropic` },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	server.stderr.on("data", (chunk) => serverLog.push(String(chunk)));

	try {
		await waitForPort(MOCK_PORT);
		await waitForPort(ACP_PORT);

		const updates = [];
		const client = new AcpHttpClient(`http://127.0.0.1:${ACP_PORT}/acp`, {});
		client
			.onMessage((event) => {
				if (event.message?.method === "session/update") updates.push(event.message.params.update);
			})
			.on("session/request_permission", () => ({ outcome: { outcome: "selected", optionId: "allow_once" } }));

		const initialized = await client.initialize({ clientName: "steve-session-test", clientVersion: "1.0.0", capabilities: {} });
		check("initialize 声明 loadSession 能力", initialized.agentCapabilities?.loadSession === true, JSON.stringify(initialized.agentCapabilities ?? {}).slice(0, 90));

		const session = await client.newSession({ cwd: ROOT });
		await client.prompt(session.sessionId, [{ type: "text", text: "hello there" }]);
		await sleep(150);

		const file = join(sessionDir, `${session.sessionId}.json`);
		check("会话落盘", existsSync(file), file);
		const stored = JSON.parse(readFileSync(file, "utf8"));
		check("落盘内容含 user 与 assistant", stored.messages?.length >= 2 && stored.cwd === ROOT, `messages=${stored.messages?.length}`);

		// A second client loads the same session: history must be replayed.
		const reloaded = new AcpHttpClient(`http://127.0.0.1:${ACP_PORT}/acp`, {});
		const replay = [];
		reloaded.onMessage((event) => {
			if (event.message?.method === "session/update") replay.push(event.message.params.update);
		});
		await reloaded.initialize({ clientName: "steve-session-test-2", clientVersion: "1.0.0", capabilities: {} });
		await reloaded.loadSession({ sessionId: session.sessionId, cwd: ROOT, mcpServers: [] });
		await sleep(150);

		const replayedText = replay
			.filter((update) => update.sessionUpdate === "agent_message_chunk")
			.map((update) => update.content?.text ?? "")
			.join("");
		const replayedUser = replay.filter((update) => update.sessionUpdate === "user_message_chunk").length;
		check("session/load 回放用户消息", replayedUser >= 1, `user chunks=${replayedUser}`);
		check("session/load 回放助手回复", replayedText.includes("pi-agent-core"), replayedText.slice(0, 60));
		check("session/load 后播报命令列表", replay.some((update) => update.sessionUpdate === "available_commands_update"));
		check("服务端记录了 session/load", serverLog.join("").includes("session/load:"), serverLog.join("").match(/session\/load:[^\n]*/)?.[0] ?? "");

		// The resumed session must keep working, and keep appending to the file.
		replay.length = 0;
		const followUp = await reloaded.prompt(session.sessionId, [{ type: "text", text: "现在几点了？" }]);
		await sleep(150);
		const afterFollowUp = JSON.parse(readFileSync(file, "utf8"));
		check("恢复后的会话可以继续对话", followUp.stopReason === "end_turn" && afterFollowUp.messages.length > stored.messages.length, `messages=${stored.messages.length}→${afterFollowUp.messages.length}`);

		const unknown = await reloaded.request("session/load", { sessionId: "does-not-exist", cwd: ROOT, mcpServers: [] }).then(
			() => null,
			(error) => String(error.message),
		);
		check("加载不存在的会话返回错误", typeof unknown === "string" && unknown.includes("Unknown session"), String(unknown).slice(0, 70));

		await reloaded.close();
		await client.close();
	} finally {
		server.kill("SIGTERM");
		mock.kill("SIGTERM");
		await sleep(200);
		server.kill("SIGKILL");
		mock.kill("SIGKILL");
		rmSync(sessionDir, { recursive: true, force: true });
	}
}

async function main() {
	process.stderr.write("sessions · store\n");
	await storeChecks();
	process.stderr.write("\nsessions · runtime snapshot\n");
	await runtimeChecks();
	process.stderr.write("\nsessions · ACP session/load\n");
	await acpChecks();

	const failed = checks.filter((entry) => !entry.passed);
	process.stderr.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
	if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
	process.stderr.write(`session test failed: ${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
});
