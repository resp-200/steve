#!/usr/bin/env node
// Verifies the run worker (docs/personal-agent.md §5.2):
//
//   A. lifecycle: `submit` returns before the run finishes, but the input and
//      `run.started` are already durable; the run appends a canonical event
//      sequence and settles with a `RunOutcome`
//   B. one-shot agents: every run rebuilds its transcript from the log, so a
//      second run sees the first run's messages and nothing else
//   C. retries: a flaky provider is retried, retry failures stay out of the
//      folded transcript, and the run still settles successfully
//   D. cancellation: `run.cancel_requested` is durable, the agent is aborted,
//      `run.cancelled` follows, and nothing is retried
//   E. concurrency: `serial` supersedes the running run, `queue` waits for it
//   F. background runs only receive tools the snapshot allows without asking
//
//   npm run build && node scripts/worker-test.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MOCK_PORT = Number(process.env.WORKER_TEST_MOCK_PORT ?? 8897);
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

async function waitFor(predicate, timeoutMs = 10_000, label = "condition") {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await sleep(20);
	}
	throw new Error(`timed out waiting for ${label}`);
}

const streamId = (name) => `worker-test-${name}`;
const streamDir = mkdtempSync(join(tmpdir(), "steve-worker-streams-"));
let log;

const mock = spawn(process.execPath, ["scripts/mock-server.mjs"], {
	cwd: ROOT,
	env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
	stdio: ["ignore", "pipe", "pipe"],
});

let exitCode = 0;

try {
	await waitForPort(MOCK_PORT);
	process.env.LLM_API_KEY = "mock";
	process.env.LLM_MODEL_ID = "mock";
	process.env.LLM_BASE_URL = `http://127.0.0.1:${MOCK_PORT}/anthropic`;
	process.env.STEVE_DISCOVERY = "off";

	const { Type } = await import(join(ROOT, "dist/features/contract.js"));
	const { createStreamLog } = await import(join(ROOT, "dist/features/stream-log.js"));
	const { createRunWorker } = await import(join(ROOT, "dist/features/worker.js"));
	const { foldStatus, foldTranscript } = await import(join(ROOT, "dist/features/state-fold.js"));
	const { modelInfo } = await import(join(ROOT, "dist/features/session-policy.js"));
	const { DEFAULT_POLICIES, project } = await import(join(ROOT, "dist/features/projection.js"));
	const { loadConfig } = await import(join(ROOT, "dist/model/config.js"));

	const config = loadConfig();
	log = createStreamLog({ dir: streamDir });
	const MODEL = modelInfo(config);
	const USAGE = { input: 11, output: 7, total: 18, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

	const timeTool = {
		name: "get_current_time",
		description: "Return the current time.",
		parameters: Type.Object({ timeZone: Type.Optional(Type.String()) }),
		execute: async () => ({
			content: [{ type: "text", text: "2024-01-01T00:00:00Z (UTC)" }],
			details: { zone: "UTC" },
		}),
	};
	const writeTool = {
		name: "write_file",
		description: "Write a file.",
		parameters: Type.Object({ path: Type.String(), content: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "written" }] }),
	};

	const environmentFor = (mode = "foreground", tools = [{ name: "get_current_time", permissionRequired: false }]) => ({
		cwd: ROOT,
		roots: [ROOT],
		access: "exec",
		tools,
		permissionMode: "allow",
		model: MODEL,
		plugins: [],
		projection: DEFAULT_POLICIES.full,
		mode,
	});

	const readEvents = (id) => log.read(id);
	const folded = async (id) => foldTranscript(await log.read(id));
	const workerFor = (extra = {}) =>
		createRunWorker({
			config,
			log,
			readState: async (id) => foldTranscript(await log.read(id)),
			resolveEnvironment: async (_id, mode) => environmentFor(mode),
			tools: [timeTool, writeTool],
			...extra,
		});

	/* ------------------------------ A. lifecycle ---------------------------- */

	const idA = streamId("lifecycle");
	const workerA = workerFor();
	const startedAt = Date.now();
	const submitted = await workerA.submit(idA, { text: "what time is it?" });
	const submitMs = Date.now() - startedAt;
	check("submit 立即返回（不等待 run 结束）", submitted.accepted === true && submitMs < 500, `${submitMs}ms`);
	const afterSubmit = await readEvents(idA);
	check(
		"submit 返回前输入与 run.started 已落盘",
		afterSubmit.some((event) => event.type === "user.message") && afterSubmit.some((event) => event.type === "run.started" && event.runId === submitted.runId),
	);
	const userEvent = afterSubmit.find((event) => event.type === "user.message");
	const startedEvent = afterSubmit.find((event) => event.type === "run.started");
	check("run.started 的 inputCause 指向输入事件", startedEvent?.inputCause === userEvent?.seq, `${startedEvent?.inputCause} vs ${userEvent?.seq}`);
	check("run.started 携带环境快照与模式", startedEvent?.mode === "foreground" && startedEvent?.environment?.cwd === ROOT && startedEvent?.environment?.tools?.some((tool) => tool.name === "get_current_time"));

	const terminalA = await workerA.wait(submitted.runId);
	check("wait() 返回该 run 的终态（settled）", terminalA.status === "settled" && terminalA.outcome?.stopReason === "stop", JSON.stringify(terminalA).slice(0, 100));
	const replayOfTerminal = await workerA.wait(submitted.runId);
	check("wait() 可重复读取同一终态", replayOfTerminal.status === "settled");
	check(
		"未知 run 的 wait() 明确失败",
		await workerA.wait("no-such-run").then(
			() => false,
			() => true,
		),
	);

	await workerA.drain();
	const eventsA = await readEvents(idA);
	const settledA = eventsA.find((event) => event.type === "run.settled");
	check("run.settled 收尾且 stopReason 为 stop", settledA?.outcome?.stopReason === "stop", JSON.stringify(settledA?.outcome ?? {}).slice(0, 80));
	check("run.settled 带 usage 与 retries", settledA?.outcome?.usage?.total === 18 && settledA?.outcome?.retries === 0);

	const messagesA = foldTranscript(eventsA);
	check(
		"折叠出 user → assistant → toolResult → assistant",
		messagesA.length === 4 && messagesA.map((message) => message.role).join(",") === "user,assistant,toolResult,assistant",
		messagesA.map((message) => message.role).join(","),
	);
	check("assistant 的 toolCall 指向 get_current_time", messagesA[1]?.content?.some((block) => block.type === "toolCall" && block.name === "get_current_time") === true);
	check("toolResult 保留结果与 isError", messagesA[2]?.isError === false && messagesA[2]?.content?.[0]?.text?.includes("2024"));
	const statusA = foldStatus(eventsA);
	check("状态：turnCount 1、toolCallCount 1、无活动 run", statusA?.turnCount === 1 && statusA?.toolCallCount === 1 && statusA?.activeRun === null);
	check("seq 从 1 连续递增", eventsA.every((event, index) => event.seq === index + 1), eventsA.map((event) => event.seq).slice(0, 5).join(","));
	check("所有事件属于同一条 stream", eventsA.every((event) => event.streamId === idA));
	check("turn_end 出现在 run.settled 之前", eventsA.findIndex((event) => event.type === "turn_end") < eventsA.findIndex((event) => event.type === "run.settled"));
	const assistantSettled = eventsA.filter((event) => event.type === "run.turn.settled");
	check(
		"每个 assistant 折叠消息都来自完整 run.turn.settled",
		assistantSettled.length >= 2 && assistantSettled.every((event) => event.message?.role === "assistant" && event.message?.usage !== undefined && typeof event.message?.stopReason === "string"),
	);
	const turnStarts = eventsA.filter((event) => event.type === "turn_start").length;
	check("流式事件也被记录（turn_start 至少 2 次）", turnStarts >= 2, `turn_start ${turnStarts}`);

	/* --------------------------- B. one-shot replay ------------------------- */

	const workerB = workerFor();
	const beforeReplay = messagesA;
	const submittedB = await workerB.submit(idA, { text: "hello again" });
	await workerB.drain();
	const messagesB = await folded(idA);
	check(
		"第二轮从日志重建上下文：消息数为旧 4 条 + 新 2 条",
		messagesB.length === beforeReplay.length + 2,
		`${beforeReplay.length} → ${messagesB.length}`,
	);
	check(
		"新一轮消息以旧 transcript 为前缀",
		JSON.stringify(messagesB.slice(0, beforeReplay.length)) === JSON.stringify(beforeReplay),
	);
	const secondStart = (await readEvents(idA)).find((event) => event.type === "run.started" && event.runId === submittedB.runId);
	check("重放后 run.started 仍携带同一环境", secondStart?.environment?.roots?.[0] === ROOT);
	check("重放后没有活动 run", foldStatus(await readEvents(idA))?.activeRun === null);

	/* ------------------------------ C. retries ------------------------------ */

	const idC = streamId("retry");
	const workerC = workerFor();
	await workerC.submit(idC, { text: "please be flaky" });
	await workerC.drain();
	const eventsC = await readEvents(idC);
	const settledC = eventsC.find((event) => event.type === "run.settled");
	const retryFailures = eventsC.filter((event) => event.type === "run.failed" && event.retryable === true);
	check("flaky 场景最终成功收尾", settledC?.outcome?.stopReason === "stop");
	check("两次 429 各留下一条 retryable 的 run.failed", retryFailures.length === 2, `${retryFailures.length}`);
	check("run.settled 记录重试次数", settledC?.outcome?.retries === 2, `${settledC?.outcome?.retries}`);
	const messagesC = foldTranscript(eventsC);
	check(
		"失败的尝试不进 transcript（等价旧 slice 回滚）",
		messagesC.length === 2 && messagesC[0]?.role === "user" && messagesC[1]?.role === "assistant",
		`${messagesC.length} 条`,
	);
	const userVisibleC = eventsC.flatMap((event) => project(event, DEFAULT_POLICIES.user, {}));
	check(
		"user 投影里没有重试失败的错误原文",
		userVisibleC.every((projected) => projected.event.type !== "run.failed" || projected.event.retryable !== true || projected.event.error === undefined),
		JSON.stringify(userVisibleC.find((projected) => projected.event.type === "run.failed") ?? null).slice(0, 80),
	);

	/* --------------------------- D. cancellation ---------------------------- */

	const idD = streamId("cancel");
	const usageBlock = { input: 1, output: 0, totalTokens: 1, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	let slowAgent = undefined;
	const workerD = workerFor({
		createAgent: () => {
			const state = [];
			slowAgent = {
				messages: () => state,
				setMessages: (next) => {
					state.length = 0;
					state.push(...next);
				},
				proceed: () => {
					slowAgent.proceeding = true;
					return new Promise((resolve) => {
						slowAgent.release = resolve;
					});
				},
				subscribe: () => () => {},
				abort: () => {
					state.push({
						role: "assistant",
						content: [],
						api: "anthropic-messages",
						provider: "custom",
						model: "mock",
						usage: usageBlock,
						stopReason: "aborted",
						timestamp: Date.now(),
					});
					slowAgent.release?.();
				},
			};
			return slowAgent;
		},
	});
	const submittedD = await workerD.submit(idD, { text: "long task" });
	await waitFor(() => slowAgent?.proceeding === true, 5_000, "run to start");
	await workerD.cancel(idD, submittedD.runId);
	const terminalD = await workerD.wait(submittedD.runId);
	check("取消后 wait() 返回 cancelled 终态", terminalD.status === "cancelled", JSON.stringify(terminalD).slice(0, 100));
	await workerD.drain();
	const eventsD = await readEvents(idD);
	check("取消留下 run.cancel_requested（by user）", eventsD.some((event) => event.type === "run.cancel_requested" && event.runId === submittedD.runId && event.by === "user"));
	check("取消以 run.cancelled 收尾", eventsD.some((event) => event.type === "run.cancelled" && event.runId === submittedD.runId));
	check("取消不会重试（没有 retryable 失败）", !eventsD.some((event) => event.type === "run.failed" && event.retryable === true));
	check("取消后的 transcript 只有用户输入", foldTranscript(eventsD).length === 1);
	check("取消后 worker 不再有活动 run", workerD.active().length === 0);

	/* --------------------------- E. concurrency ----------------------------- */

	const idE = streamId("serial");
	let created = 0;
	let releaseFirst = undefined;
	const workerE = workerFor({
		concurrency: "serial",
		createAgent: () => {
			created += 1;
			const state = [];
			const agent = {
				messages: () => state,
				setMessages: (next) => {
					state.length = 0;
					state.push(...next);
				},
				proceed: () =>
					created === 1
						? new Promise((resolve) => {
								releaseFirst = resolve;
							})
						: Promise.resolve(),
				subscribe: () => () => {},
				abort: () => {
					state.push({ role: "assistant", content: [], api: "anthropic-messages", provider: "custom", model: "mock", usage: usageBlock, stopReason: "aborted", timestamp: Date.now() });
					releaseFirst?.();
				},
			};
			return agent;
		},
	});
	const firstE = await workerE.submit(idE, { text: "first" });
	await waitFor(async () => created === 1, 5_000, "first agent");
	const secondE = await workerE.submit(idE, { text: "second" });
	check("serial 下第二个 run 被标记 superseded", secondE.accepted === true && secondE.reason === "superseded", secondE.reason ?? "");
	await workerE.drain();
	const eventsE = await readEvents(idE);
	check("被顶掉的 run 收到 cancel_requested", eventsE.some((event) => event.type === "run.cancel_requested" && event.runId === firstE.runId));
	check("被顶掉的 run 以 cancelled 收尾", eventsE.some((event) => event.type === "run.cancelled" && event.runId === firstE.runId));
	const secondStartE = eventsE.find((event) => event.type === "run.started" && event.runId === secondE.runId);
	const firstEndE = eventsE.find((event) => (event.type === "run.cancelled" || event.type === "run.settled") && event.runId === firstE.runId);
	check("第二个 run 在第一个收尾之后才开始", secondStartE !== undefined && firstEndE !== undefined && secondStartE.seq > firstEndE.seq);
	check("第二个 run 正常收尾", eventsE.some((event) => event.type === "run.settled" && event.runId === secondE.runId));

	const idF = streamId("queue");
	created = 0;
	releaseFirst = undefined;
	const workerF = workerFor({
		concurrency: "queue",
		createAgent: () => {
			created += 1;
			const state = [];
			const agent = {
				messages: () => state,
				setMessages: (next) => {
					state.length = 0;
					state.push(...next);
				},
				proceed: () =>
					created === 1
						? new Promise((resolve) => {
								releaseFirst = resolve;
							})
						: Promise.resolve(),
				subscribe: () => () => {},
				abort: () => releaseFirst?.(),
			};
			return agent;
		},
	});
	const firstF = await workerF.submit(idF, { text: "first" });
	await waitFor(async () => created === 1, 5_000, "queued first agent");
	const secondF = await workerF.submit(idF, { text: "second" });
	check("queue 下第二个 run 被排队", secondF.accepted === true && secondF.reason === "queued", secondF.reason ?? "");
	releaseFirst?.();
	await workerF.drain();
	const eventsF = await readEvents(idF);
	const settleFirstF = eventsF.find((event) => event.type === "run.settled" && event.runId === firstF.runId);
	const startSecondF = eventsF.find((event) => event.type === "run.started" && event.runId === secondF.runId);
	check("排队的 run 在第一个正常收尾后开始", settleFirstF !== undefined && startSecondF !== undefined && startSecondF.seq > settleFirstF.seq);
	check("两个 run 都正常收尾", eventsF.filter((event) => event.type === "run.settled").length === 2);

	/* -------------------------- F. background tools ------------------------- */

	const idG = streamId("background");
	const seenTools = [];
	const workerG = workerFor({
		resolveEnvironment: async (_id, mode) =>
			environmentFor(mode, [
				{ name: "get_current_time", permissionRequired: false },
				{ name: "write_file", permissionRequired: true },
			]),
		createAgent: (context) => {
			seenTools.push(...context.tools.map((tool) => tool.name));
			const state = [...context.messages];
			return {
				messages: () => state,
				setMessages: (next) => {
					state.length = 0;
					state.push(...next);
				},
				proceed: async () => {
					state.push({ role: "assistant", content: [{ type: "text", text: "done" }], api: "anthropic-messages", provider: "custom", model: "mock", usage: usageBlock, stopReason: "stop", timestamp: Date.now() });
				},
				subscribe: () => () => {},
				abort: () => {},
			};
		},
	});
	await workerG.submit(idG, { text: "background please" }, "background");
	await workerG.drain();
	const eventsG = await readEvents(idG);
	check("background run 的 run.started 标记模式", eventsG.some((event) => event.type === "run.started" && event.mode === "background"));
	check("background run 只拿到无需审批的工具", seenTools.join(",") === "get_current_time", seenTools.join(","));
	check("background run 正常收尾", eventsG.some((event) => event.type === "run.settled"));

	/* --------------------------- G. invalid input --------------------------- */

	// A tools provider is read again for every run, so tools attached later (MCP)
	// join the next run without rebuilding the worker.
	const idH = streamId("provider");
	let providerReads = 0;
	const catalog = [timeTool];
	const workerH = workerFor({
		tools: () => {
			providerReads += 1;
			return catalog;
		},
		resolveEnvironment: async (_id, mode) => environmentFor(mode, catalog.map((tool) => ({ name: tool.name, permissionRequired: false }))),
	});
	const submittedH = await workerH.submit(idH, { text: "what time is it?" });
	const terminalH = await workerH.wait(submittedH.runId);
	check("tools provider 的 run 正常收尾", terminalH.status === "settled" && providerReads >= 1, `${providerReads} read(s)`);
	catalog.push(writeTool);
	const submittedH2 = await workerH.submit(idH, { text: "hello again" });
	const terminalH2 = await workerH.wait(submittedH2.runId);
	check("追加到目录的工具在下一轮可用（provider 每轮重读）", terminalH2.status === "settled" && providerReads >= 2);

	const invalid = await workerA.submit("../../etc/passwd", { text: "nope" });
	check("非法 stream id 被拒绝", invalid.accepted === false && invalid.reason === "invalid stream id", invalid.reason ?? "");
} catch (error) {
	process.stderr.write(`  ✗ 测试崩溃：${error?.stack ?? error}\n`);
	checks.push({ name: "测试崩溃", passed: false });
	exitCode = 1;
} finally {
	mock.kill("SIGTERM");
	log?.close?.();
	rmSync(streamDir, { recursive: true, force: true });
}

const failed = checks.filter((entry) => !entry.passed);
process.stderr.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
if (failed.length > 0) process.exitCode = 1;
else if (exitCode !== 0) process.exitCode = exitCode;
