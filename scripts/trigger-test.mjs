#!/usr/bin/env node
// Verifies the trigger engine and the watch config plugin (docs/personal-agent.md
// §4.6 / §5.5):
//
//   A. predicate: a matching event fires `trigger.fired` + a prefixed user
//      message into the target stream; a non-match does nothing
//   B. fire-storm guards: dedupe window, per-trigger rate limit, causal depth
//   C. cron: a fake clock advances to the slot, the slot is delivered once, and
//      stop() clears the timer; sleeping past a slot records `watch.dedupe`
//      with reason "missed" instead of replaying it
//   D. `.steve/watch.json`: valid entries become registrations on the extension
//      host, invalid ones are logged and skipped, and the registrations can be
//      handed straight to an engine
//
//   npm run build && node scripts/trigger-test.mjs
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createStreamLog } from "../dist/features/stream-log.js";
import { createTriggerEngine } from "../dist/features/trigger.js";
import { loadExtensions } from "../dist/extensions/host.js";

const checks = [];
const check = (name, passed, detail = "") => {
	checks.push({ name, passed });
	process.stderr.write(`  ${passed ? "✓" : "✗"} ${name}${passed || !detail ? "" : ` — ${detail}`}\n`);
};

const roots = [];
const scratch = (prefix) => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate, timeoutMs = 3000) => {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const value = await predicate();
		if (value) return value;
		await sleep(20);
	}
	throw new Error("timed out waiting for a condition");
};

const countType = (events, type) => events.filter((event) => event.type === type).length;
const types = (events) => events.map((event) => event.type);

/** Deterministic clock: `advance` jumps time first, then fires everything due. */
const fakeClock = () => {
	let now = 1_700_000_000_000;
	let nextId = 1;
	const timers = new Map();
	return {
		clock: {
			now: () => now,
			setTimer(callback, delayMs) {
				const id = nextId++;
				timers.set(id, { at: now + Math.max(0, delayMs), callback });
				return id;
			},
			clearTimer(handle) {
				timers.delete(handle);
			},
		},
		async advance(ms) {
			const target = now + ms;
			now = target;
			for (let guard = 0; guard < 100; guard += 1) {
				const due = [...timers.entries()]
					.filter(([, timer]) => timer.at <= target)
					.sort((left, right) => left[1].at - right[1].at)[0];
				if (due === undefined) break;
				timers.delete(due[0]);
				due[1].callback();
				await sleep(10);
			}
			await sleep(20);
		},
		pending: () => timers.size,
	};
};

async function predicateChecks(log, scratchDir) {
	const engine = createTriggerEngine({ log, cwd: scratchDir, roots: [scratchDir], logger: () => {} });
	engine.register({
		name: "on-deploy",
		spec: {
			kind: "predicate",
			on: ["user.message"],
			when: { field: "text", op: "contains", value: "deploy" },
			emit: { type: "user.message", text: "please review the deploy" },
		},
		targetStream: "work",
		mode: "background",
	});
	await engine.start();
	await log.append("work", [{ type: "stream.created", streamId: "work", cwd: scratchDir }]);
	await log.append("work", [{ type: "user.message", text: "hello there" }]);
	await sleep(100);
	let events = await log.read("work", 1);
	check("predicate：不匹配的事件不触发", countType(events, "trigger.fired") === 0);

	await log.append("work", [{ type: "user.message", text: "deploy now please" }]);
	await waitFor(async () => countType(await log.read("work", 1), "trigger.fired") >= 1);
	events = await log.read("work", 1);
	const firedEvents = events.filter((event) => event.type === "trigger.fired");
	const messages = events.filter((event) => event.type === "user.message");
	check("predicate：匹配后写入 trigger.fired", firedEvents.length === 1 && firedEvents[0].trigger === "on-deploy");
	check("predicate：source 为 predicate", firedEvents[0].source === "predicate");
	check("predicate：detail 带来源事件", firedEvents[0].detail?.event === "user.message" && typeof firedEvents[0].detail?.seq === "number");
	check("predicate：投递带 [watch:name] 前缀的消息", messages.some((event) => event.text === "[watch:on-deploy] please review the deploy"));
	const watchMessage = messages.find((event) => event.text.startsWith("[watch:on-deploy]"));
	check("predicate：投递消息挂在 trigger.fired 之后（causeId）", watchMessage?.causeId === firedEvents[0].seq);
	const armed = events.find((event) => event.type === "watch.armed");
	check("predicate：start() 记录 watch.armed", armed?.trigger === "on-deploy" && typeof armed?.spec === "object");
	check("predicate：list() 报告 lastFiredAt", engine.list().find((entry) => entry.name === "on-deploy")?.lastFiredAt !== undefined);
	await engine.stop();

	const removable = createTriggerEngine({ log, cwd: scratchDir, roots: [scratchDir] });
	const unregister = removable.register({
		name: "temporary",
		spec: { kind: "predicate", on: ["user.message"], emit: { type: "user.message", text: "never" } },
		targetStream: "temporary-stream",
		mode: "background",
	});
	unregister();
	check("register：返回的取消函数移除登记", removable.list().length === 0);
}

async function guardChecks(log, scratchDir) {
	// Dedupe: one fire per window, the second match is dropped and recorded.
	const dedupeEngine = createTriggerEngine({ log, cwd: scratchDir, roots: [scratchDir], logger: () => {} });
	dedupeEngine.register({
		name: "dedupe",
		spec: { kind: "predicate", on: ["user.message"], when: { field: "text", op: "contains", value: "go" }, emit: { type: "user.message", text: "handled" } },
		dedupe: { key: "dedupe", windowMs: 60_000 },
		targetStream: "dedupe-stream",
		mode: "background",
	});
	await dedupeEngine.start();
	await log.append("dedupe-stream", [{ type: "user.message", text: "go 1" }]);
	await waitFor(async () => countType(await log.read("dedupe-stream", 1), "trigger.fired") >= 1);
	await log.append("dedupe-stream", [{ type: "user.message", text: "go 2" }]);
	await waitFor(async () => countType(await log.read("dedupe-stream", 1), "watch.dedupe") >= 1);
	let events = await log.read("dedupe-stream", 1);
	check("dedupe：窗口内只触发一次", countType(events, "trigger.fired") === 1);
	check("dedupe：被丢弃的那次记录 watch.dedupe", events.some((event) => event.type === "watch.dedupe" && event.reason === "dedupe"));
	check("dedupe：list() 报告 suppressed", dedupeEngine.list().find((entry) => entry.name === "dedupe")?.suppressed === "dedupe");
	await dedupeEngine.stop();

	// Rate: maxFiresPerMinute caps fires even without a dedupe window.
	const rateEngine = createTriggerEngine({ log, cwd: scratchDir, roots: [scratchDir], logger: () => {}, maxFiresPerMinute: 1 });
	rateEngine.register({
		name: "rate",
		spec: { kind: "predicate", on: ["user.message"], when: { field: "text", op: "contains", value: "tick" }, emit: { type: "user.message", text: "rate handled" } },
		targetStream: "rate-stream",
		mode: "background",
	});
	await rateEngine.start();
	await log.append("rate-stream", [{ type: "user.message", text: "tick 1" }]);
	await waitFor(async () => countType(await log.read("rate-stream", 1), "trigger.fired") >= 1);
	await log.append("rate-stream", [{ type: "user.message", text: "tick 2" }]);
	await waitFor(async () => countType(await log.read("rate-stream", 1), "watch.dedupe") >= 1);
	events = await log.read("rate-stream", 1);
	check("rate：每分钟上限生效", countType(events, "trigger.fired") === 1 && events.some((event) => event.type === "watch.dedupe" && event.reason === "rate"));
	await rateEngine.stop();

	// Depth: a trigger matching its own output stops after the configured chain.
	const depthEngine = createTriggerEngine({ log, cwd: scratchDir, roots: [scratchDir], logger: () => {}, maxDepth: 3 });
	depthEngine.register({
		name: "loop",
		spec: { kind: "predicate", on: ["user.message"], when: { field: "text", op: "contains", value: "chain" }, emit: { type: "user.message", text: "chain again" } },
		targetStream: "depth-stream",
		mode: "background",
	});
	await depthEngine.start();
	await log.append("depth-stream", [{ type: "user.message", text: "chain start" }]);
	await waitFor(async () => (await log.read("depth-stream", 1)).some((event) => event.type === "watch.dedupe" && event.reason === "depth"));
	events = await log.read("depth-stream", 1);
	check("depth：自触发链在 maxDepth 处停止", countType(events, "trigger.fired") === 2);
	check("depth：超过深度记录 watch.dedupe", events.some((event) => event.type === "watch.dedupe" && event.reason === "depth"));
	await depthEngine.stop();
}

async function cronChecks(log, scratchDir) {
	const fake = fakeClock();
	const engine = createTriggerEngine({ log, cwd: scratchDir, roots: [scratchDir], logger: () => {}, clock: fake.clock });
	engine.register({
		name: "tick",
		spec: { kind: "cron", cron: "* * * * *", emit: { type: "user.message", text: "cron woke up" } },
		targetStream: "clock",
		mode: "background",
	});
	await engine.start();
	check("cron：start() 排定下一次（存在 pending timer）", fake.pending() === 1);
	await fake.advance(60_000);
	await waitFor(async () => countType(await log.read("clock", 1), "trigger.fired") >= 1);
	let events = await log.read("clock", 1);
	check("cron：到点触发一次", countType(events, "trigger.fired") === 1);
	check("cron：source 为 cron", events.find((event) => event.type === "trigger.fired")?.source === "cron");
	check("cron：投递用户消息", events.some((event) => event.type === "user.message" && event.text === "[watch:tick] cron woke up"));
	const afterFire = countType(events, "trigger.fired");
	await engine.stop();
	check("cron：stop() 清掉 timer", fake.pending() === 0);
	await fake.advance(120_000);
	await sleep(50);
	check("cron：stop() 后不再触发", countType(await log.read("clock", 1), "trigger.fired") === afterFire);

	const missedFake = fakeClock();
	const missed = createTriggerEngine({ log, cwd: scratchDir, roots: [scratchDir], logger: () => {}, clock: missedFake.clock });
	missed.register({
		name: "missed",
		spec: { kind: "cron", cron: "* * * * *", emit: { type: "user.message", text: "late" } },
		targetStream: "missed",
		mode: "background",
	});
	await missed.start();
	await missedFake.advance(10 * 60_000);
	await waitFor(async () => (await log.read("missed", 1)).some((event) => event.type === "watch.dedupe" && event.reason === "missed"));
	const missedEvents = await log.read("missed", 1);
	check("cron：睡过槽位不补跑", countType(missedEvents, "trigger.fired") === 0);
	check("cron：错过的槽位记录 reason=missed", missedEvents.some((event) => event.type === "watch.dedupe" && event.reason === "missed"));
	await missed.stop();
}

async function configChecks(log, scratchDir) {
	mkdirSync(join(scratchDir, ".steve"), { recursive: true });
	writeFileSync(
		join(scratchDir, ".steve", "watch.json"),
		JSON.stringify({
			triggers: {
				"on-deploy": {
					kind: "predicate",
					on: ["user.message"],
					when: { field: "text", op: "contains", value: "deploy" },
					targetStream: "work",
					prompt: "check the deploy",
				},
				"morning-digest": { kind: "cron", cron: "0 9 * * *", timezone: "Asia/Shanghai", targetStream: "digest", mode: "background", prompt: "write the digest" },
				"bad-kind": { kind: "nope", targetStream: "work", prompt: "x" },
				"escapes": { kind: "fs", paths: ["../outside/**"], targetStream: "work", prompt: "x" },
				"bad-cron": { kind: "cron", cron: "not a cron", targetStream: "work", prompt: "x" },
				"bad-prompt": { kind: "cron", cron: "0 9 * * *", targetStream: "work", prompt: "" },
			},
		}),
	);
	const logs = [];
	const host = await loadExtensions({
		cwd: scratchDir,
		mode: "cli",
		log: (message) => logs.push(message),
		workspace: { roots: [scratchDir], access: "read" },
		discover: false,
	});
	check("watch.json：只登记合法条目", host.triggers.length === 2);
	check("watch.json：登记了一条 predicate", host.triggers.some((entry) => entry.name === "on-deploy" && entry.spec.kind === "predicate" && entry.mode === "background"));
	check("watch.json：登记了一条 cron（带 timezone）", host.triggers.some((entry) => entry.name === "morning-digest" && entry.spec.kind === "cron" && entry.spec.timezone === "Asia/Shanghai"));
	check("watch.json：prompt 变成 emit.text", host.triggers.find((entry) => entry.name === "on-deploy")?.spec.emit.text === "check the deploy");
	check("watch.json：坏条目记日志不中断", ["bad-kind", "escapes", "bad-cron", "bad-prompt"].every((name) => logs.some((line) => line.includes(`skipping trigger "${name}"`))));
	check("watch.json：targetStream 默认仍是登记字段", host.triggers.every((entry) => typeof entry.targetStream === "string"));

	const engine = createTriggerEngine({ log, cwd: scratchDir, roots: [scratchDir], logger: () => {} });
	for (const registration of host.triggers) engine.register(registration);
	await engine.start();
	await log.append("work", [{ type: "user.message", text: "please deploy" }]);
	await waitFor(async () => countType(await log.read("work", 1), "trigger.fired") >= 1);
	check("watch.json：登记结果可直接交给引擎并触发", (await log.read("work", 1)).some((event) => event.type === "trigger.fired" && event.trigger === "on-deploy"));
	await engine.stop();
}

async function main() {
	try {
		const dir = scratch("steve-trigger-");
		const log = createStreamLog({ dir });
		try {
			await predicateChecks(log, dir);
			await guardChecks(log, dir);
			await cronChecks(log, dir);
			await configChecks(log, dir);
		} finally {
			log.close();
		}
	} finally {
		for (const root of roots) rmSync(root, { recursive: true, force: true });
	}

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
