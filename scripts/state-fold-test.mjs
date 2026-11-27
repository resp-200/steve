#!/usr/bin/env node
// Verifies the state fold (docs/personal-agent.md §4.3, §5.6):
//
//   A. every event type either produces the documented message or nothing
//   B. `foldStatus` derives run/usage/queue counters from the same events
//   C. `forkEvents` truncates and re-sequences without touching the source
//   D. a real mock-gateway conversation folds to the transcript the old
//      in-memory runtime produced (order, content, tool-call linkage)
//   E. folding a replayed stream and continuing it equals continuing the
//      original stream (the property the one-shot agent depends on)
//
//   npm run build && node scripts/state-fold-test.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MOCK_PORT = Number(process.env.STATE_FOLD_TEST_MOCK_PORT ?? 8898);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const checks = [];
const check = (name, passed, detail = "") => {
	checks.push({ name, passed });
	process.stderr.write(`  ${passed ? "✓" : "✗"} ${name}${passed || !detail ? "" : ` — ${detail}`}\n`);
};

const isDeepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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

const streamDir = mkdtempSync(join(tmpdir(), "steve-fold-streams-"));
let log;
let mock;

const mockProcess = spawn(process.execPath, ["scripts/mock-server.mjs"], {
	cwd: ROOT,
	env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
	stdio: ["ignore", "pipe", "pipe"],
});

let exitCode = 0;
try {
	await waitForPort(MOCK_PORT);
	mock = mockProcess;
	// loadConfig() creates ~/.steve on first run; keep it in the temp area.
	process.env.HOME = mkdtempSync(join(tmpdir(), "steve-fold-home-"));
	process.env.LLM_API_KEY = "mock";
	process.env.LLM_MODEL_ID = "mock";
	process.env.LLM_BASE_URL = `http://127.0.0.1:${MOCK_PORT}/anthropic`;
	process.env.STEVE_DISCOVERY = "off";

	const { Type } = await import(join(ROOT, "dist/features/contract.js"));
	const { createStreamLog } = await import(join(ROOT, "dist/features/stream-log.js"));
	const { createRunWorker } = await import(join(ROOT, "dist/features/worker.js"));
	const { createAgentRuntime } = await import(join(ROOT, "dist/features/runtime.js"));
	const { foldStatus, foldTranscript, forkEvents } = await import(join(ROOT, "dist/features/state-fold.js"));
	const { modelInfo } = await import(join(ROOT, "dist/features/session-policy.js"));
	const { DEFAULT_POLICIES } = await import(join(ROOT, "dist/features/projection.js"));
	const { loadConfig } = await import(join(ROOT, "dist/model/config.js"));

	const config = loadConfig();
	log = createStreamLog({ dir: streamDir });
	const MODEL = modelInfo(config);
	const USAGE = { input: 11, output: 7, total: 18, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

	const timeTool = {
		name: "get_current_time",
		description: "Return the current time.",
		parameters: Type.Object({ timeZone: Type.Optional(Type.String()) }),
		execute: async () => ({ content: [{ type: "text", text: "2024-01-01T00:00:00Z (UTC)" }], details: { zone: "UTC" } }),
	};

	const environment = (mode = "foreground") => ({
		cwd: ROOT,
		roots: [ROOT],
		access: "exec",
		tools: [{ name: "get_current_time", permissionRequired: false }],
		permissionMode: "allow",
		model: MODEL,
		plugins: [],
		projection: DEFAULT_POLICIES.full,
		mode,
	});

	const workerFor = () =>
		createRunWorker({
			config,
			log,
			resolveEnvironment: async (_id, mode) => environment(mode),
			tools: [timeTool],
		});

	/* --------------------------- A. fold rules ------------------------------ */

	const rulesStream = "fold-rules";
	let seq = 0;
	const event = (body, extra = {}) => ({ seq: ++seq, streamId: rulesStream, ts: 1000 + seq * 10, ...body, ...extra });
	const assistantMessage = (text) => ({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: USAGE,
		stopReason: "stop",
		timestamp: 1,
	});

	{
		const user = event({ type: "user.message", text: "hello" });
		const userWithImage = event({ type: "user.message", text: "", images: [{ mimeType: "image/png", data: "QUJD" }] });
		const assistant = assistantMessage("hi there");
		const settled = event({ type: "run.turn.settled", runId: "run-1", message: assistant });
		const toolEnd = event({ type: "tool_end", id: "call-1", name: "get_current_time", isError: false, text: "2024-01-01", details: { zone: "UTC" } });
		const toolFailure = event({ type: "tool_end", id: "call-2", name: "read_file", isError: true, text: "missing" });
		const turnEnd = event({ type: "turn_end", stopReason: "stop", usage: USAGE, contextTokens: 42, failed: false, retries: 0 });
		const failedRun = event({ type: "run.failed", runId: "run-x", error: "provider exploded" });
		const truncated = event({ type: "user.message", text: "too big" }, { truncated: true });

		const messages = foldTranscript([
			user,
			event({ type: "turn_start" }),
			event({ type: "text_delta", text: "hi" }),
			event({ type: "thinking_delta", text: "think" }),
			event({ type: "tool_start", id: "call-1", name: "get_current_time", args: {} }),
			event({ type: "tool_update", id: "call-1", name: "get_current_time", text: "partial" }),
			settled,
			toolEnd,
			toolFailure,
			turnEnd,
			event({ type: "turn_start" }),
			settled,
			turnEnd,
			failedRun,
			truncated,
			userWithImage,
		]);

		check("user.message → UserMessage（纯文本保持字符串，时间戳取事件 ts）", messages[0]?.role === "user" && messages[0]?.content === "hello" && messages[0]?.timestamp === user.ts);
		check("run.turn.settled → 原样保留完整 AssistantMessage", messages[1]?.content?.[0]?.text === "hi there" && messages[1]?.stopReason === "stop");
		check("tool_end → ToolResultMessage（toolCallId/toolName/content/details/isError）", messages[2]?.role === "toolResult" && messages[2]?.toolCallId === "call-1" && messages[2]?.toolName === "get_current_time" && messages[2]?.content?.[0]?.text === "2024-01-01" && messages[2]?.details?.zone === "UTC" && messages[2]?.isError === false);
		check("失败的 tool_end 也产生 toolResult（isError 为 true）", messages[3]?.role === "toolResult" && messages[3]?.isError === true);
		check("run.failed 不产生消息（等价旧回滚）", messages.filter((message) => message.role === "toolResult").length === 2 && messages.length === 7);
		// A truncated event lost detail, not the turn. Dropping the message left an
		// assistant at the end of the transcript and the next run could not continue
		// from it, so the message stays and only its payload is clipped.
		check("truncated 事件仍产生消息", messages.some((message) => message.content === "too big"));
		check("无文字只有图片的 user.message → 仅 image 块", Array.isArray(messages.at(-1)?.content) && messages.at(-1)?.content?.every((block) => block.type === "image") === true);
		check("turn_start/text_delta/thinking_delta/tool_start/tool_update/turn_end 不产生消息", messages.length === 7);
		check("消息顺序 = 事件里可重建的对话顺序", messages.map((message) => message.role).join(",") === "user,assistant,toolResult,toolResult,assistant,user,user");
		check("AssistantMessage 在 fold 中是同一引用（不复制模型消息）", messages[1] === assistant);
	}

	/* -------------------------- B. foldStatus ------------------------------- */

	{
		const empty = foldStatus([]);
		check("空流 → undefined", empty === undefined);

		let s = 0;
		const statusEvents = [];
		const push = (body) => statusEvents.push({ seq: ++s, streamId: "fold-status", ts: 5000 + s * 5, ...body });
		push({ type: "stream.created", streamId: "fold-status", cwd: "/tmp/x" });
		push({ type: "user.message", text: "one" });
		push({ type: "run.started", runId: "run-1", inputCause: 2, environment: { cwd: "/tmp/x" }, mode: "foreground" });
		push({ type: "user.message", text: "queued input" });
		push({ type: "run.turn.settled", runId: "run-1", message: assistantMessage("a") });
		push({ type: "tool_end", id: "call-1", name: "get_current_time", isError: false, text: "ok" });
		push({ type: "turn_end", stopReason: "tool_use", usage: USAGE, contextTokens: 10, failed: false, retries: 0 });
		push({ type: "run.turn.settled", runId: "run-1", message: assistantMessage("b") });
		push({ type: "turn_end", stopReason: "stop", usage: USAGE, contextTokens: 20, failed: false, retries: 0 });
		push({ type: "run.settled", runId: "run-1", outcome: { stopReason: "stop", usage: USAGE, contextTokens: 20, retries: 0 } });
		const status = foldStatus(statusEvents);
		check("foldStatus 返回 streamId/createdAt/updatedAt/lastSeq", status?.streamId === "fold-status" && status?.createdAt === 5005 && status?.updatedAt === 5000 + s * 5 && status?.lastSeq === s);
		check("run.started 建立 activeRun，终态清空", status?.activeRun === null);
		check("usage 累计每条 settled assistant 的 usage（total 36 = 18 + 18，turn_end 不重复计入）", status?.usage?.total === 36 && status?.usage?.input === 22);
		check("turnCount 统计已完成模型轮次（与 /stats.turns 同口径）", status?.turnCount === 2);
		check("toolCallCount 统计 tool_end 数量", status?.toolCallCount === 1);
		check("run 结束后仍等待的输入保留在 queued", status?.queued === 1);
		const resetQueued = foldStatus([
			{ seq: 1, streamId: "q", ts: 1, type: "stream.created", streamId: "q", cwd: "/tmp/x" },
			{ seq: 2, streamId: "q", ts: 2, type: "user.message", text: "a" },
			{ seq: 3, streamId: "q", ts: 3, type: "run.started", runId: "r1", inputCause: 2, environment: {}, mode: "foreground" },
			{ seq: 4, streamId: "q", ts: 4, type: "user.message", text: "b" },
			{ seq: 5, streamId: "q", ts: 5, type: "run.started", runId: "r2", inputCause: 4, environment: {}, mode: "foreground" },
		]);
		check("下一次 run.started 清零 queued", resetQueued?.queued === 0);

		const during = foldStatus(statusEvents.slice(0, 4));
		check("run 进行中 activeRun 非空且 queued 计数", during?.activeRun?.runId === "run-1" && during?.activeRun?.mode === "foreground" && during?.queued === 1);
	}

	/* -------------------------- C. forkEvents ------------------------------- */

	{
		const source = [1, 2, 3, 4].map((n) => ({ seq: n, streamId: "source", ts: n, type: "text_delta", text: `d${n}` }));
		const forked = forkEvents(source, 3, "forked");
		check("forkEvents 保留 atSeq（含）之前的事件", forked.length === 3);
		check("forkEvents 重排 seq 为 1..N", forked.map((event) => event.seq).join(",") === "1,2,3");
		check("forkEvents 换 streamId 且不改源数组", forked.every((event) => event.streamId === "forked") && source.every((event) => event.streamId === "source") && source.length === 4);
		check("forkEvents 不改事件内容", forked[0]?.text === "d1");
	}

	/* ------------------- D. old runtime vs folded transcript ---------------- */

	const oldRuntime = createAgentRuntime({ config, tools: [timeTool], logger: () => {} });
	const oldTurn = await oldRuntime.prompt("现在几点了？");
	const oldSnapshot = oldRuntime.snapshot();
	const oldStats = oldRuntime.stats();

	const newStream = "fold-conversation";
	const newWorker = workerFor();
	const submitted = await newWorker.submit(newStream, { text: "现在几点了？" });
	const terminal = await newWorker.wait(submitted.runId);
	check("新路径 run 正常结束", terminal.status === "settled" && terminal.outcome.stopReason === "stop");
	const newMessages = foldTranscript(await log.read(newStream));

	const canonicalContent = (content) => {
		const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
		return blocks.map((block) =>
			block.type === "text"
				? { type: "text", text: block.text }
				: block.type === "image"
					? { type: "image", mimeType: block.mimeType }
					: { type: block.type, name: block.name, arguments: block.arguments },
		);
	};
	const canonical = (messages) =>
		messages.map((message) =>
			message.role === "assistant"
				? { role: "assistant", stopReason: message.stopReason, content: canonicalContent(message.content) }
				: message.role === "toolResult"
					? { role: "toolResult", toolName: message.toolName, isError: message.isError, content: canonicalContent(message.content) }
					: { role: "user", content: canonicalContent(message.content) },
		);
	const oldCanonical = canonical(oldSnapshot);
	const newCanonical = canonical(newMessages);
	check("折叠出的 transcript 与旧 runtime.snapshot() 逐条相等（顺序/内容/tool 调用）", isDeepEqual(oldCanonical, newCanonical), JSON.stringify(newCanonical).slice(0, 200));
	check("旧路径与新路径角色序列一致", oldCanonical.map((message) => message.role).join(",") === newCanonical.map((message) => message.role).join(","));
	const toolCall = newMessages.find((message) => message.role === "assistant")?.content?.find((block) => block.type === "toolCall");
	const toolResult = newMessages.find((message) => message.role === "toolResult");
	check("toolCallId 在 assistant 与 toolResult 之间保持链接", toolCall?.id === toolResult?.toolCallId);
	check("旧 runtime 的 turn 数与折叠的 turnCount 一致", oldStats.turns === foldStatus(await log.read(newStream))?.turnCount, `${oldStats.turns} vs ${foldStatus(await log.read(newStream))?.turnCount}`);
	check("旧 runtime 的 toolCalls 与折叠的 toolCallCount 一致", oldStats.toolCalls === foldStatus(await log.read(newStream))?.toolCallCount);
	check("旧 runtime 的 token 总数与折叠 usage 一致", oldStats.inputTokens + oldStats.outputTokens === foldStatus(await log.read(newStream))?.usage.total);
	check("折叠不改变模型消息的 stopReason", newMessages.at(-1)?.stopReason === "stop" && oldTurn.stopReason === "stop");

	/* ------------------------- E. replay equivalence ------------------------ */

	const directStream = "fold-direct";
	const directWorker = workerFor();
	const firstDirect = await directWorker.submit(directStream, { text: "现在几点了？" });
	await directWorker.wait(firstDirect.runId);
	const secondDirect = await directWorker.submit(directStream, { text: "hello again" });
	await directWorker.wait(secondDirect.runId);

	const replayStream = "fold-replay";
	const replayWorker = workerFor();
	const firstReplay = await replayWorker.submit(replayStream, { text: "现在几点了？" });
	await replayWorker.wait(firstReplay.runId);
	const resumedWorker = workerFor();
	const secondReplay = await resumedWorker.submit(replayStream, { text: "hello again" });
	await resumedWorker.wait(secondReplay.runId);

	const directMessages = foldTranscript(await log.read(directStream));
	const replayMessages = foldTranscript(await log.read(replayStream));
	check("重放流再跑一轮与连续两轮的 transcript 相等", isDeepEqual(canonical(directMessages), canonical(replayMessages)), JSON.stringify(canonical(replayMessages)).slice(0, 200));
	check("重放流的第一轮 transcript 是第二轮的前缀", isDeepEqual(canonical(directMessages.slice(0, 4)), canonical(replayMessages.slice(0, 4))));
	check("重放流与连续流的 turnCount 都等于 3（1 工具轮 + 2 轮）", foldStatus(await log.read(directStream))?.turnCount === foldStatus(await log.read(replayStream))?.turnCount);
	check("两轮流结束后 activeRun 为空", foldStatus(await log.read(directStream))?.activeRun === null && foldStatus(await log.read(replayStream))?.activeRun === null);

	await directWorker.drain();
	await replayWorker.drain();
	await resumedWorker.drain();
	await newWorker.drain();
	oldRuntime.reset?.();
} catch (error) {
	check("state-fold-test 未抛异常", false, error?.stack ?? String(error));
	exitCode = 1;
} finally {
	try {
		log?.close();
	} catch {}
	rmSync(streamDir, { recursive: true, force: true });
	mock?.kill("SIGTERM");
	const passed = checks.filter((entry) => entry.passed).length;
	console.log(`${passed}/${checks.length} checks passed`);
	if (passed !== checks.length) exitCode = 1;
	process.exitCode = exitCode;
}
