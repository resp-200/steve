#!/usr/bin/env node
// Verifies event projection (docs/personal-agent.md §4.5): one event stream,
// several audiences.
//
//   A. full / internal / audit: identity projection, so existing consumers (the
//      ACP client) see exactly what they saw before projection existed
//   B. user: thinking and raw tool arguments/output are hidden, summaries and
//      declared titles replace them, `run.turn.settled` never leaks
//   C. approval.pending narrows to title + one-line summary; oneLine/truncateText
//      behave at their boundaries
//
//   npm run build && node scripts/projection-test.mjs
import process from "node:process";

const checks = [];
const check = (name, passed, detail = "") => {
	checks.push({ name, passed });
	process.stderr.write(`  ${passed ? "✓" : "✗"} ${name}${passed || !detail ? "" : ` — ${detail}`}\n`);
};

const { DEFAULT_POLICIES, oneLine, project, truncateText } = await import("../dist/features/projection.js");

const usage = { input: 10, output: 5, total: 15, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

/** A representative tool call plus its result, as the runtime emits them. */
const toolStart = { type: "tool_start", id: "call-1", name: "edit_file", args: { path: "a.ts", old: "x", new: "y" } };
const toolEnd = {
	type: "tool_end",
	id: "call-1",
	name: "edit_file",
	isError: false,
	text: "Edited a.ts\n  1 replacement  \n",
	details: { path: "a.ts", replacements: 1 },
	images: [{ mimeType: "image/png", data: "AAA" }],
};
const turnEnd = {
	type: "turn_end",
	stopReason: "stop",
	usage,
	contextTokens: 42,
	failed: false,
	errorMessage: "provider said: secret internal detail",
	retries: 0,
};

const projectOne = (event, policy, hooks) => project(event, policy, hooks);
const bodies = (event, policy, hooks) => projectOne(event, policy, hooks).map((entry) => entry.event);

/* --------------------------- identity audiences --------------------------- */

function identityChecks() {
	const samples = [
		{ type: "turn_start" },
		{ type: "text_delta", text: "hello" },
		{ type: "thinking_delta", text: "internal reasoning" },
		toolStart,
		{ type: "tool_update", id: "call-1", name: "edit_file", text: "still running" },
		toolEnd,
		turnEnd,
		{ type: "user.message", text: "hi" },
		{ type: "run.started", runId: "run-1", inputCause: 1, environment: null, mode: "foreground" },
		{ type: "run.settled", runId: "run-1", outcome: { stopReason: "stop", usage, contextTokens: 42, retries: 0 } },
		{ type: "run.turn.settled", runId: "run-1", message: { role: "assistant" } },
	];

	for (const audience of ["full", "internal", "audit"]) {
		const projected = samples.map((sample) => projectOne(sample, DEFAULT_POLICIES[audience]));
		check(
			`${audience}: 每个事件都投影出一条`,
			projected.every((list) => list.length === 1),
			JSON.stringify(projected.map((list) => list.length)),
		);
		check(
			`${audience}: 事件正文原引用透传（逐条相等）`,
			projected.every((list, index) => list[0].event === samples[index]),
		);
		check(`${audience}: 标记 audience=${audience}`, projected.every((list) => list[0].audience === audience));
	}

	// ACP defaults to full, which must stay identity for the shapes it consumes.
	check("full: tool_start 仍带原始 args", bodies(toolStart, DEFAULT_POLICIES.full)[0].args.path === "a.ts");
	check("full: tool_end 仍带原文与 details", bodies(toolEnd, DEFAULT_POLICIES.full)[0].text.includes("Edited"));
	check("full: turn_end 仍带 errorMessage", bodies(turnEnd, DEFAULT_POLICIES.full)[0].errorMessage !== undefined);
	check("full: 默认策略就是 ACP 的 full 档", DEFAULT_POLICIES.full.audience === "full");
}

/* -------------------------------- user view ------------------------------- */

function userChecks() {
	const user = DEFAULT_POLICIES.user;
	check("user 默认：不显式思考、摘要 240 字符、不带 details", user.thinking === "drop" && user.toolOutputChars === 240 && !user.details);

	const start = bodies(toolStart, user)[0];
	check("user: tool_start 去掉 args", !("args" in start), JSON.stringify(start));
	check("user: tool_start 保留 id/name", start.id === "call-1" && start.name === "edit_file");

	const titled = bodies(toolStart, user, { titleFor: () => "Edit a.ts", kindFor: () => "edit" })[0];
	check("user: tool_start 用声明的 title/kind", titled.title === "Edit a.ts" && titled.kind === "edit");

	const ended = bodies(toolEnd, user)[0];
	check("user: tool_end 只有 summary，无 text/details/images", !("text" in ended) && !("details" in ended) && !("images" in ended));
	check("user: tool_end summary 是一行", ended.summary === "Edited a.ts 1 replacement", JSON.stringify(ended.summary));

	const ownSummary = bodies(toolEnd, user, { summaryFor: () => "1 replacement in a.ts" })[0];
	check("user: 工具自己的 summary 优先于原文", ownSummary.summary === "1 replacement in a.ts");

	const detailed = bodies(toolEnd, { ...user, details: true })[0];
	check("user: details=true 时结构详情透出", detailed.details !== undefined && detailed.details.replacements === 1);

	const truncated = bodies(toolEnd, { ...user, toolOutput: "truncated", toolOutputChars: 12 })[0];
	check("user: toolOutput=truncated 保留多行但截断", typeof truncated.summary === "string" && truncated.summary.length <= 12);

	check("user: thinking 默认整条不发", projectOne({ type: "thinking_delta", text: "x" }, user).length === 0);
	const placeholder = bodies({ type: "thinking_delta", text: "x" }, { ...user, thinking: "placeholder" })[0];
	check("user: thinking=placeholder 只留占位、不留正文", placeholder.type === "thinking_delta" && !("text" in placeholder));

	const update = bodies({ type: "tool_update", id: "call-1", name: "edit_file", text: "partial" }, user)[0];
	check("user: tool_update 去掉进度正文", update.id === "call-1" && !("text" in update), JSON.stringify(update));

	const settled = bodies(turnEnd, user)[0];
	check("user: turn_end 去掉 errorMessage", !("errorMessage" in settled) && settled.failed === false && settled.retries === 0);
	check("user: turn_end 保留 usage/contextTokens", settled.usage.total === 15 && settled.contextTokens === 42);
	check("user: run.turn.settled 不投影给 user", projectOne({ type: "run.turn.settled", runId: "r", message: {} }, user).length === 0);
	const failed = bodies({ type: "run.failed", runId: "run-1", error: "provider said 429: secret-ish", retryable: true }, user)[0];
	check("user: run.failed 去掉错误原文", failed.type === "run.failed" && !("error" in failed) && failed.runId === "run-1");
	check("user: run.failed 保留 retryable 分类", failed.retryable === true);
	check(
		"full: run.failed 保留错误原文",
		bodies({ type: "run.failed", runId: "run-1", error: "boom" }, DEFAULT_POLICIES.full)[0].error === "boom",
	);

	check("user: text_delta 原样通过", bodies({ type: "text_delta", text: "hi" }, user)[0].text === "hi");
	check("user: user.message 原样通过", bodies({ type: "user.message", text: "hi" }, user)[0].text === "hi");
	check(
		"user: run.started 原样通过",
		bodies({ type: "run.started", runId: "run-1", inputCause: 3, environment: null, mode: "background" }, user)[0].mode ===
			"background",
	);
}

/* ------------------------- approval + text helpers ------------------------ */

function approvalChecks() {
	const pending = {
		type: "approval.pending",
		requestId: "req-1",
		runId: "run-1",
		toolName: "write_file",
		args: { path: "a.ts", content: "secret" },
		preview: { summary: "Write a.ts (+3 lines)", diff: "@@ ..." },
	};
	const narrowed = bodies(pending, DEFAULT_POLICIES.user)[0];
	check("user: approval.pending 去掉 args", !("args" in narrowed));
	check("user: approval.pending 带一行 preview summary", narrowed.summary === "Write a.ts (+3 lines)");

	const hooked = bodies(pending, DEFAULT_POLICIES.user, {
		titleFor: () => "Write a.ts",
		previewFor: () => "3 lines added",
	})[0];
	check("user: approval.pending 用声明的 title/preview", hooked.title === "Write a.ts" && hooked.summary === "3 lines added");

	const fullApproval = bodies(pending, DEFAULT_POLICIES.full)[0];
	check("full: approval.pending 保留 args 与 preview", fullApproval.args !== undefined && fullApproval.preview !== undefined);

	check("oneLine: 折叠空白", oneLine(" a\n\n b\t c ") === "a b c");
	check("oneLine: 超长以 ... 截断", oneLine("x".repeat(20), 10) === `${"x".repeat(7)}...`);
	check("oneLine: 恰好等于上限不截断", oneLine("x".repeat(10), 10) === "x".repeat(10));
	check("truncateText: 保留换行并截断", truncateText("a\nb\nc\nd", 6) === "a\nb...");
}

async function main() {
	identityChecks();
	userChecks();
	approvalChecks();

	const failed = checks.filter((entry) => !entry.passed);
	process.stdout.write(`${checks.length - failed.length}/${checks.length} checks passed\n`);
	if (failed.length > 0) {
		process.stderr.write(`failed:\n${failed.map((entry) => `  - ${entry.name}`).join("\n")}\n`);
		process.exit(1);
	}
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exit(1);
});
