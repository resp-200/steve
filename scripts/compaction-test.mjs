#!/usr/bin/env node
// Verifies context compaction (docs/personal-agent.md §4.3 / §5.5):
//
//   A. measurement: usage is trusted, the tail after it is estimated
//   B. the cut keeps whole turns: it never lands inside a tool call, and a tail
//      can never start with an orphaned tool result
//   C. over-long tool results are shortened without an LLM call
//   D. planning: below the trigger nothing happens; above it the head is
//      summarized and the tail survives verbatim
//   E. the hook: one summary per run, failures are advisory, later requests in
//      the same run reuse the prefix instead of summarizing again
//   F. folding a `compaction` event reproduces the compacted transcript, so a
//      restored session does not walk back into the overflow
//   G. projection: a person sees that history was compacted, not what it said
//
//   npm run build && node scripts/compaction-test.mjs
import process from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const checks = [];
const check = (name, passed, detail = "") => {
	checks.push({ name, passed });
	process.stderr.write(`  ${passed ? "✓" : "✗"} ${name}${passed || !detail ? "" : ` — ${detail}`}\n`);
};

let exitCode = 0;
try {
	const compaction = await import(join(ROOT, "dist/features/compaction.js"));
	const hook = await import(join(ROOT, "dist/features/compaction-hook.js"));
	const summary = await import(join(ROOT, "dist/features/compaction-summary.js"));
	const { foldTranscript } = await import(join(ROOT, "dist/features/state-fold.js"));
	const { project, DEFAULT_POLICIES } = await import(join(ROOT, "dist/features/projection.js"));
	const {
		COMPACTION_PREFIX,
		estimateContextTokens,
		estimateMessageTokens,
		findCompactionCut,
		lastCompactionSummary,
		compactionEventFor,
		planCompaction,
		previousSummaryOf,
		pruneToolResults,
		repairTail,
		resolveCompactionPolicy,
		serializeForSummary,
	} = compaction;

	/* ------------------------------ fixtures -------------------------------- */

	const USAGE = (input, output = 0) => ({ input, output, total: input + output, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
	const user = (text) => ({ role: "user", content: text, timestamp: 1 });
	const assistant = (text, usage) => ({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: usage ?? USAGE(10, 5),
		stopReason: "stop",
		timestamp: 2,
	});
	const calling = (id, name = "read_file") => ({
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: { path: "/tmp/x" } }],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: USAGE(10, 5),
		stopReason: "toolUse",
		timestamp: 3,
	});
	const result = (id, text, name = "read_file") => ({
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		timestamp: 4,
	});
	/**
	 * One user turn: ask, call a tool, get a result, answer. The filler is
	 * generous because the policy's floor is 1k tokens — a transcript has to be
	 * substantial before compaction ever considers it.
	 */
	const turn = (index, filler = 8_000) => [
		user(`question ${index}: ${"q".repeat(filler)}`),
		calling(`call-${index}`),
		result(`call-${index}`, `answer ${index}: ${"r".repeat(filler)}`),
		assistant(`reply ${index}`),
	];

	/* --------------------------- A. measurement ----------------------------- */

	check("空历史估算为 0", estimateContextTokens([]) === 0);
	{
		// The last usage is the ground truth; whatever came after it is estimated.
		const messages = [user("a"), assistant("b"), result("call-9", "x".repeat(4_000))];
		const tokens = estimateContextTokens(messages);
		check("usage 优先：无尾部时等于 usage 总量", estimateContextTokens([user("a"), assistant("b")]) === 15, String(tokens));
		check("usage 之后的消息按字符估算", tokens >= 1_000, String(tokens));
	}
	check(
		"没有 usage 时按全部消息估算",
		estimateContextTokens([user("x".repeat(4_000))]) === estimateMessageTokens(user("x".repeat(4_000))),
	);

	/* ------------------------------ B. cut ---------------------------------- */

	{
		const policy = resolveCompactionPolicy({ contextWindow: 128_000, maxTokens: 8_192 });
		check("默认触发阈值 = 窗口的 75%", policy.triggerTokens === 96_000, String(policy.triggerTokens));
		check("默认保留尾部 20k", policy.keepRecentTokens === 20_000, String(policy.keepRecentTokens));
		const small = resolveCompactionPolicy({ contextWindow: 20_000, maxTokens: 8_192 });
		check(
			"窗口小到 75% 不够用时按「窗口 - 回复 - 摘要」触发",
			small.triggerTokens === 20_000 - 8_192 - 2_048,
			String(small.triggerTokens),
		);
		check("保留尾部不超过触发预算的一半", small.keepRecentTokens <= Math.floor(small.triggerTokens / 2), String(small.keepRecentTokens));
	}

	{
		const messages = [...turn(1), ...turn(2), ...turn(3), ...turn(4)];
		const cut = findCompactionCut(messages, { keepRecentTokens: 2_000 });
		check("切点落在 user 消息上", messages[cut]?.role === "user", messages[cut]?.role);
		check("切点之前至少有内容", cut > 0, String(cut));
		const tail = messages.slice(cut);
		check("尾部不以孤立的 toolResult 开头", tail[0]?.role === "user", tail[0]?.role);
		// Every tool call in the tail kept its result, and vice versa.
		const calls = new Set();
		for (const message of tail) {
			if (message.role !== "assistant") continue;
			for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
		}
		const orphans = tail.filter((message) => message.role === "toolResult" && !calls.has(message.toolCallId));
		check("尾部里没有失去调用的 toolResult", orphans.length === 0, `${orphans.length} orphan(s)`);
	}
	check("只有一轮时无法切分", findCompactionCut(turn(1), { keepRecentTokens: 1 }) === undefined);
	{
		// A tail whose first message is a result of a call that stayed behind.
		const head = [...turn(1)];
		const tail = [result("call-1", "stale"), user("next"), assistant("ok")];
		const repaired = repairTail(tail, head);
		check("孤立 toolResult 被修掉", repaired?.[0]?.role === "user", repaired?.[0]?.role);
	}
	{
		const kept = repairTail([result("call-2", "still paired"), assistant("ok")], []);
		check("调用仍在尾部的 toolResult 不被误删", kept?.length === 2, String(kept?.length));
	}

	/* --------------------------- C. tool results ---------------------------- */

	{
		const policy = resolveCompactionPolicy({ contextWindow: 128_000, maxTokens: 8_192 });
		const big = "x".repeat(40_000);
		const messages = [user("read it"), calling("call-1"), result("call-1", big), assistant("done")];
		const pruned = pruneToolResults(messages, policy);
		check("超长 toolResult 被裁剪", pruned.pruned === 1, String(pruned.pruned));
		check("裁剪确实省下字符", pruned.savedChars > 30_000, String(pruned.savedChars));
		const text = pruned.messages[2].content[0].text;
		check("裁剪后保留头部", text.includes("xxxxxxxxxx"), text.slice(0, 20));
		check("裁剪后在正文里说明被省略了多少", /compacted: [\d,]+ more characters of read_file output/.test(text), text.slice(-120));
		check("工具名仍然可见", /read_file/.test(text), text.slice(-120));
		const small = pruneToolResults([user("a"), result("call-9", "short")], policy);
		check("短 toolResult 原样保留", small.pruned === 0 && small.messages[1].content[0].text === "short");
	}

	/* ----------------------------- D. planning ------------------------------ */

	const policy = resolveCompactionPolicy({ contextWindow: 128_000, maxTokens: 8_192 });
	{
		check("低于阈值不压缩", planCompaction([...turn(1), ...turn(2)], policy, 1_000) === undefined);

		// Six turns (~6k tokens). The default keep budget (20k) exceeds the whole
		// fixture, so one that fits is scaled down here; the *bounds* still come
		// from the policy under test.
		const messages = [1, 2, 3, 4, 5, 6].flatMap((index) => turn(index));
		const plan = planCompaction(messages, { ...policy, keepRecentTokens: 2_000 }, policy.triggerTokens);
		check("达到阈值给出计划", plan !== undefined);
		if (plan === undefined) throw new Error(`no plan for ${messages.length} messages`);
		check("保留尾部从 user 消息开始", plan.keep[0].role === "user", plan.keep[0].role);
		check(
			"摘要部分与保留部分不重叠",
			plan.summarize.length + plan.keep.length === messages.length,
			`${plan.summarize.length}+${plan.keep.length}`,
		);
		check("至少保留最近一轮", plan.keep.some((m) => m.role === "user" && m.content === turn(6)[0].content));
		check("切点至少晚于第一条 user 消息", plan.cut >= 4, String(plan.cut));
		check(
			"摘要输入里每轮都是完整的",
			plan.summarize.filter((m) => m.role === "toolResult").length === plan.summarize.filter((m) => m.role === "user").length,
			`${plan.summarize.filter((m) => m.role === "toolResult").length} result(s)`,
		);
	}
	{
		// A transcript that was compacted once carries its summary as a user message.
		const previous = {
			role: "user",
			content: `${COMPACTION_PREFIX}\n\nearlier summary text`,
			timestamp: 5,
		};
		const messages = [previous, ...[2, 3, 4, 5, 6].flatMap((index) => turn(index))];
		const plan = planCompaction(messages, { ...policy, keepRecentTokens: 2_000 }, policy.triggerTokens);
		check("旧摘要被识别为「上一次摘要」", plan?.previousSummary === "earlier summary text", String(plan?.previousSummary));
		check("旧摘要本身不再进入摘要输入", (plan?.summarize ?? []).every((m) => previousSummaryOf(m) === undefined));
	}

	/* ------------------------------ E. the hook ----------------------------- */

	const reject = async () => {
		throw new Error("provider is down");
	};
	const echoSummary = (label) => async (request) => {
		echoSummary.calls.push(request);
		return label;
	};
	echoSummary.calls = [];

	{
		const compactor = hook.createContextCompactor({ policy, summarize: async () => "S" });
		const small = [...turn(1)];
		check("小历史原样返回", (await compactor.apply(small)) === small);
	}
	{
		// A realistic policy for a fixture-sized transcript: the defaults assume a
		// real session (20k kept), which these synthetic turns never reach.
		const tiny = { ...policy, keepRecentTokens: 2_000 };
		const compactor = hook.createContextCompactor({ policy: tiny, summarize: async () => "summary of everything" });
		const big = [...turn(1), ...turn(2), ...turn(3)];
		// Force the trigger without inflating the transcript: measure with a huge
		// usage on the last assistant message.
		big[big.length - 1] = assistant("reply", USAGE(200_000));
		const next = await compactor.apply(big);
		check("超阈值时替换为一条摘要消息", next.length < big.length, `${big.length} → ${next.length}`);
		check("摘要消息带前缀", next[0].content.startsWith(COMPACTION_PREFIX), next[0].content.slice(0, 40));
		check("摘要之后紧跟保留的尾部", next[1]?.role === "user", next[1]?.role);
		// Compared through the policy's own numbers: the fixture's fake usage sits
		// on a message that survives, so re-measuring cannot show the saving.
		check("压缩前后占用都记录在案", (compactor.last()?.after ?? 0) < (compactor.last()?.before ?? 0), JSON.stringify(compactor.last()));
		check("last() 记录本次压缩", compactor.last()?.droppedMessages === big.length - next.length + 1, String(compactor.last()?.droppedMessages));
	}
	{
		const { createContextCompactor } = hook;
		const compactor = createContextCompactor({ policy: { ...policy, keepRecentTokens: 2_000 }, summarize: reject });
		const big = [...turn(1), ...turn(2), ...turn(3)];
		big[big.length - 1] = assistant("reply", USAGE(200_000));
		const next = await compactor.apply(big);
		check("摘要失败不阻塞本轮（原样返回）", next.length === big.length, `${next.length}`);
		check("摘要失败不记录 last()", compactor.last() === undefined);
	}
	{
		const summarize = echoSummary("one");
		const compactor = hook.createContextCompactor({ policy: { ...policy, keepRecentTokens: 2_000 }, summarize });
		const big = [...turn(1), ...turn(2), ...turn(3)];
		big[big.length - 1] = assistant("reply", USAGE(200_000));
		await compactor.apply(big);
		// Same run, a later request (tool loop) that added nothing new.
		const again = await compactor.apply(big);
		check("同一 run 只摘要一次", echoSummary.calls.length === 1, String(echoSummary.calls.length));
		check("同一 run 的后续请求复用结果", again[0].content.startsWith(COMPACTION_PREFIX));
		// A new run may compact again — and now it has a previous summary to update.
		compactor.beginRun();
		const grown = [again[0], again[1], ...turn(4)];
		grown[grown.length - 1] = assistant("reply", USAGE(200_000));
		await compactor.apply(grown);
		check("新 run 结束后可以再次摘要", echoSummary.calls.length === 2, String(echoSummary.calls.length));
		check("第二次请求带上了上一次摘要", typeof echoSummary.calls[1].previousSummary === "string", String(echoSummary.calls[1].previousSummary));
	}
	{
		const disabled = hook.createContextCompactor({ policy: { ...policy, keepRecentTokens: 2_000, enabled: false }, summarize: async () => "S" });
		const big = [...turn(1), ...turn(2), ...turn(3)];
		big[big.length - 1] = assistant("reply", USAGE(200_000));
		check("enabled=false 时完全不动作", (await disabled.apply(big)).length === big.length);
	}

	/* ----------------------------- F. folding ------------------------------- */

	{
		const summaryText = "user wanted X; we edited a.ts; next: run the tests";
		// Two settled turns, then a compaction keeping only the second one: the
		// numbers carried by the event are exactly "how much of what the log
		// already holds stays".
		const first = turn(1);
		const kept = turn(2).map((message) => ({ ...message, timestamp: 20 }));
		const settled = (message, index, ts) => ({
			seq: index + 3,
			streamId: "s",
			ts,
			type: "run.turn.settled",
			runId: "run-1",
			message,
		});
		const events = [
			{ seq: 1, streamId: "s", ts: 10, type: "user.message", text: "first" },
			...first.map((message, index) => settled(message, index, 11 + index)),
			...kept.map((message, index) => settled(message, index + first.length, 20 + index)),
			{
				seq: 100,
				streamId: "s",
				ts: 30,
				type: "compaction",
				droppedMessages: first.length,
				keptMessages: kept.length,
				beforeTokens: 99,
				afterTokens: 40,
				summary: summaryText,
			},
		];
		const folded = foldTranscript(events);
		check("折叠出的上下文就是压缩后的样子", folded.length === kept.length + 1, `${folded.length} vs ${kept.length + 1}`);
		// The summary is appended when folded (it replaces what came before), so it
		// sits ahead of the retained tail rather than at the head of the array.
		const summaryIndex = folded.findIndex((m) => m.content === `${COMPACTION_PREFIX}\n\n${summaryText}`);
		check("折叠包含摘要消息", summaryIndex >= 0, String(summaryIndex));
		check("摘要之前不留旧历史", summaryIndex === 0, String(summaryIndex));
		check(
			"折叠后的尾部与保留部分一致",
			JSON.stringify(folded.slice(summaryIndex + 1)) === JSON.stringify(kept),
			`${folded.length} vs ${kept.length + 1}`,
		);
		check("摘要可从折叠结果读回", lastCompactionSummary(folded) === summaryText);
	}
	{
		// A compaction event reported with more kept messages than the log holds
		// (a truncated log, say) must not fabricate history: the summary lands and
		// is the only thing left.
		const events = [
			{ seq: 1, streamId: "s", ts: 10, type: "user.message", text: "only" },
			{ seq: 2, streamId: "s", ts: 11, type: "compaction", droppedMessages: 1, keptMessages: 4, beforeTokens: 9, afterTokens: 4, summary: "S" },
		];
		const folded = foldTranscript(events);
		check(
			"保留条数超过日志时不会伪造历史",
			folded.length === 1 && folded[0].content.includes("S"),
			`${folded.length}: ${JSON.stringify(folded.map((m) => m.role))}`,
		);
	}

	/* ---------------------------- G. projection ----------------------------- */

	{
		const event = {
			seq: 1,
			streamId: "s",
			ts: 1,
			type: "compaction",
			droppedMessages: 6,
			keptMessages: 4,
			beforeTokens: 120_000,
			afterTokens: 30_000,
			summary: "SECRET DETAILS THE USER SHOULD NOT SEE TWICE",
		};
		const forUser = project(event, DEFAULT_POLICIES.user, {}).filter((p) => p.audience === "user");
		check("user 能看到「历史被压缩了」", forUser.length === 1, String(forUser.length));
		check("user 看不到摘要正文", !JSON.stringify(forUser).includes("SECRET"), JSON.stringify(forUser[0]?.event).slice(0, 120));
	}

	/* ------------------------- H. summary plumbing -------------------------- */

	{
		check("序列化 user 消息", serializeForSummary(user("hello")).startsWith("USER: hello"));
		check("序列化工具调用（含参数）", serializeForSummary(calling("c1")).includes("read_file("));
		check("序列化工具结果（带工具名）", serializeForSummary(result("c1", "ok")).startsWith("TOOL read_file: ok"));
		check(
			"失败的工具体现在序列化里",
			serializeForSummary({ ...result("c1", "no"), isError: true }).includes("failed"),
		);
	}
	{
		// A stream that only carries deltas, like an adapter that never rewrites partial.
		const streamFrom = (texts) => ({
			async *[Symbol.asyncIterator]() {
				for (const text of texts) yield { type: "text_delta", delta: text };
				yield { type: "done", message: { content: [{ type: "text", text: texts.join("") }] } };
			},
		});
		check("从事件流取出摘要文本", (await summary.streamedText(streamFrom(["a", "b"]))) === "ab");
		const failing = {
			async *[Symbol.asyncIterator]() {
				yield { type: "error", error: { errorMessage: "no key configured" } };
			},
		};
		let thrown;
		try {
			await summary.streamedText(failing);
		} catch (error) {
			thrown = String(error);
		}
		check("流里的错误变成异常（由 hook 降级）", thrown?.includes("no key configured"), thrown ?? "no throw");
		const empty = { async *[Symbol.asyncIterator]() {} };
		let emptyThrown;
		try {
			await summary.streamedText(empty);
		} catch (error) {
			emptyThrown = String(error);
		}
		check("空摘要视为失败", emptyThrown?.includes("returned no text"), emptyThrown ?? "no throw");
	}
} catch (error) {
	process.stderr.write(`✗ ${error?.stack ?? error}\n`);
	exitCode = 1;
}

const failed = checks.filter((c) => !c.passed);
if (failed.length > 0) {
	process.stderr.write(`\n${failed.length} check(s) failed:\n${failed.map((c) => `  - ${c.name}`).join("\n")}\n`);
	exitCode = 1;
} else {
	process.stderr.write(`\n${checks.length}/${checks.length} checks passed\n`);
}
process.exit(exitCode);
