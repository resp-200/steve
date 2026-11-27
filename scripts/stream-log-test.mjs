#!/usr/bin/env node
// Verifies the append-only event log and the session-store compatibility layer
// (docs/personal-agent.md §5.1):
//
//   A. stream log: append/read round trip, seq numbering, incremental reads,
//      subscribe (history then live), listStreams, remove
//   B. crash tolerance: a torn last line is skipped and the next append does not
//      glue onto it
//   C. rotation: reads continue across files and seq never resets
//   D. fork: a forked stream is independent and starts at seq 1
//   E. size strategy: over-limit events are truncated, and the fold keeps the
//      message while dropping the clipped payload
//   G. blobs: image payloads leave the log line for `blobs/<sha256>`, dedupe by
//      content, and fold back into the transcript (a missing blob drops the
//      picture, not the message)
//   F. session store: the JSONL stream is the truth — save/load/list/remove keep
//      working through the compatibility layer, legacy `.json` sessions still
//      load, and both read paths fold to the same transcript
//
//   npm run build && node scripts/stream-log-test.mjs
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

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

const eventFiles = (dir, streamId) => {
	const streamDir = join(dir, streamId);
	if (!existsSync(streamDir)) return [];
	return readdirSync(streamDir)
		.filter((name) => name.endsWith(".jsonl"))
		.sort();
};

const readLines = (path) =>
	readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line !== "");

const seqs = (events) => events.map((event) => event.seq);
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
const sameSeqs = (events, expected) => JSON.stringify(seqs(events)) === JSON.stringify(expected);

/* ------------------------- A. stream log basics ------------------------- */

async function logChecks() {
	const { createStreamLog } = await import("../dist/features/stream-log.js");
	const dir = join(scratch("steve-streams-"), "streams");
	const log = createStreamLog({ dir, logger: () => {} });
	const streamId = "stream-basic";

	const first = await log.append(streamId, [
		{ type: "stream.created", streamId, cwd: "/tmp/project", title: "demo", ts: 1_000 },
		{ type: "user.message", text: "hello" },
	]);
	check("append 返回首尾 seq", first.first === 1 && first.last === 2 && first.events.length === 2);
	check("信封字段齐全（seq/streamId/ts）", first.events.every((event, index) => event.seq === index + 1 && event.streamId === streamId && typeof event.ts === "number"));
	check("ts 提示被保留（stream.created）", first.events[0]?.ts === 1_000);

	await log.append(streamId, [
		{ type: "text_delta", text: "a" },
		{ type: "tool_start", id: "call-1", name: "read_file", args: { path: "a.txt" } },
	]);
	const all = await log.read(streamId);
	check("read 读回顺序与 seq 连续", sameSeqs(all, range(1, 4)));
	check("read 内容与写入一致", all[3]?.type === "tool_start" && all[3]?.name === "read_file" && all[3]?.args?.path === "a.txt");

	const incremental = await log.read(streamId, 3);
	check("fromSeq 只返回增量", sameSeqs(incremental, [3, 4]));
	const limited = await log.read(streamId, 1, 2);
	check("limit 限制返回条数", sameSeqs(limited, [1, 2]));

	const seen = [];
	const unsubscribe = log.subscribe(streamId, 2, (event) => seen.push(event.seq));
	check("subscribe 先补历史", JSON.stringify(seen) === JSON.stringify([2, 3, 4]));
	await log.append(streamId, [{ type: "text_delta", text: "b" }]);
	check("subscribe 收到新增", JSON.stringify(seen) === JSON.stringify([2, 3, 4, 5]));
	unsubscribe();
	await log.append(streamId, [{ type: "text_delta", text: "c" }]);
	check("取消订阅后不再收到", JSON.stringify(seen) === JSON.stringify([2, 3, 4, 5]));

	check("meta.json 落盘", existsSync(join(dir, streamId, "meta.json")));
	const cursor = JSON.parse(readFileSync(join(dir, streamId, "cursor.json"), "utf8"));
	check("cursor.json 记录 lastSeq", cursor.lastSeq === 6);

	const summaries = await log.listStreams();
	const summary = summaries.find((entry) => entry.streamId === streamId);
	check("listStreams 返回流摘要", summary?.lastSeq === 6 && summary?.cwd === "/tmp/project" && summary?.title === "demo");

	let rejected = false;
	try {
		await log.append("../escape", [{ type: "text_delta", text: "x" }]);
	} catch {
		rejected = true;
	}
	check("非法 streamId 被拒绝", rejected);

	await log.remove(streamId);
	check("remove 删除流目录", !existsSync(join(dir, streamId)) && (await log.read(streamId)).length === 0);
	log.close();
}

/* --------------------------- B. crash tolerance -------------------------- */

async function crashChecks() {
	const { createStreamLog } = await import("../dist/features/stream-log.js");
	const dir = join(scratch("steve-streams-"), "streams");
	const log = createStreamLog({ dir, logger: () => {} });
	const streamId = "stream-crash";
	await log.append(streamId, [
		{ type: "stream.created", streamId, cwd: "/tmp/project" },
		{ type: "user.message", text: "one" },
		{ type: "user.message", text: "two" },
	]);

	// Simulate a crash mid-write: a partial JSON line with no trailing newline.
	const [file] = eventFiles(dir, streamId);
	appendFileSync(join(dir, streamId, file), '{"seq":4,"streamId":"stream-crash","type":"user.mess');

	const reopened = createStreamLog({ dir, logger: () => {} });
	const events = await reopened.read(streamId);
	check("截断的最后一行被跳过且不抛错", sameSeqs(events, [1, 2, 3]));

	const appended = await reopened.append(streamId, [{ type: "user.message", text: "three" }]);
	check("崩溃后继续追加的 seq 不跳号", appended.first === 4 && appended.last === 4);
	const after = await reopened.read(streamId);
	check("崩溃后的新事件可读回", sameSeqs(after, [1, 2, 3, 4]) && after[3]?.text === "three");

	const lines = readLines(join(dir, streamId, file));
	const tornLine = lines.find((line) => line.includes('"type":"user.mess'));
	check("破损行被单独隔离（未与新事件粘连）", tornLine !== undefined && !tornLine.includes("three"));
	reopened.close();
	log.close();
}

/* ------------------------------ C. rotation ----------------------------- */

async function rotationChecks() {
	const { createStreamLog } = await import("../dist/features/stream-log.js");
	const dir = join(scratch("steve-streams-"), "streams");
	const log = createStreamLog({ dir, rotateBytes: 512, logger: () => {} });
	const streamId = "stream-rotate";
	await log.append(streamId, [{ type: "stream.created", streamId, cwd: "/tmp/project" }]);
	for (let index = 0; index < 5; index += 1) {
		await log.append(streamId, [
			{ type: "user.message", text: `${index}:${"x".repeat(120)}` },
			{ type: "text_delta", text: `${index}:${"y".repeat(120)}` },
		]);
	}

	const files = eventFiles(dir, streamId);
	check("轮转产生多个事件文件", files.length >= 2, `files=${files.join(",")}`);
	const headers = files.map((name) => JSON.parse(readLines(join(dir, streamId, name))[0]));
	check("每个文件首行记录 firstSeq", headers.every((header) => typeof header.firstSeq === "number"));
	check("firstSeq 单调递增且从 1 开始", headers[0]?.firstSeq === 1 && headers[headers.length - 1]?.firstSeq > 1);

	const all = await log.read(streamId);
	check("跨文件读回完整且 seq 连续", sameSeqs(all, range(1, 11)));
	check("轮转不重置 seq（尾部 seq 最大）", all[all.length - 1]?.seq === 11);
	const tail = await log.read(streamId, 8);
	check("fromSeq 跨文件定位", sameSeqs(tail, [8, 9, 10, 11]));
	log.close();
}

/* -------------------------------- D. fork ------------------------------- */

async function forkChecks() {
	const { createStreamLog } = await import("../dist/features/stream-log.js");
	const { forkEvents } = await import("../dist/features/state-fold.js");
	const dir = join(scratch("steve-streams-"), "streams");
	const log = createStreamLog({ dir, logger: () => {} });
	const source = "stream-source";
	await log.append(source, [
		{ type: "stream.created", streamId: source, cwd: "/tmp/project" },
		{ type: "user.message", text: "one" },
		{ type: "user.message", text: "two" },
		{ type: "user.message", text: "three" },
	]);

	const events = await log.read(source);
	const forked = forkEvents(events, 3, "stream-fork");
	check("fork 只保留 atSeq 之前的事件", forked.length === 3);
	check("fork 重排 seq 从 1 开始", sameSeqs(forked, [1, 2, 3]));
	check("fork 换上新 streamId", forked.every((event) => event.streamId === "stream-fork"));

	const appended = await log.append("stream-fork", forked.map(({ seq, streamId, ...body }) => body));
	check("fork 后的新流独立编号", appended.first === 1 && appended.last === 3);
	const forkRead = await log.read("stream-fork");
	check("fork 后的流内容正确", forkRead.length === 3 && forkRead[2]?.text === "two");
	check("源流未被改动", (await log.read(source)).length === 4);
	log.close();
}

/* --------------------------- E. size strategy --------------------------- */

async function sizeChecks() {
	const { createStreamLog } = await import("../dist/features/stream-log.js");
	const { foldTranscript } = await import("../dist/features/state-fold.js");
	const dir = join(scratch("steve-streams-"), "streams");
	const log = createStreamLog({ dir, maxEventBytes: 512, logger: () => {} });
	const streamId = "stream-size";

	await log.append(streamId, [
		{ type: "stream.created", streamId, cwd: "/tmp/project" },
		{ type: "user.message", text: "small" },
		{ type: "user.message", text: "big".repeat(1_000) },
		{
			type: "tool_end",
			id: "call-1",
			name: "read_file",
			isError: false,
			text: "result".repeat(1_000),
			details: { blob: "z".repeat(4_000) },
		},
	]);

	const events = await log.read(streamId);
	check("小事件不被截断", events[1]?.truncated === undefined && events[1]?.text === "small");
	check("超限 user.message 被截断并标记", events[2]?.truncated === true && typeof events[2]?.text === "string");
	check("截断后按 UTF-8 字节数受限", Buffer.byteLength(JSON.stringify(events[2])) <= 512 + 64);
	check("超限 tool_end 保留身份与错误标记", events[3]?.truncated === true && events[3]?.id === "call-1" && events[3]?.name === "read_file" && events[3]?.isError === false);
	check("截断的 tool_end 丢弃 details", events[3]?.details === undefined);
	// Truncation clips detail; it must not delete a turn from the conversation.
	// Dropping a user message left an assistant turn at the end of the transcript,
	// and the next run could not continue from it ("Cannot continue from message
	// role: assistant").
	const foldedTruncated = foldTranscript(events);
	check(
		"被截断的 user.message 仍留在 transcript 里",
		foldedTruncated.length === 3 && foldedTruncated[1]?.role === "user",
		JSON.stringify(foldedTruncated.map((message) => message.role)),
	);
	check(
		"被截断的 tool_end 仍留在 transcript 里",
		foldedTruncated[2]?.role === "toolResult",
		JSON.stringify(foldedTruncated.map((message) => message.role)),
	);
	log.close();
}

/* ------------------------- G. blob storage ------------------------------ */

async function blobChecks() {
	const { createStreamLog } = await import("../dist/features/stream-log.js");
	const { foldTranscript } = await import("../dist/features/state-fold.js");
	const { createBlobStore, blobHash } = await import("../dist/features/blob-store.js");
	const base = scratch("steve-blobs-");
	const blobDir = join(base, "blobs");
	const blobs = createBlobStore(blobDir);
	const log = createStreamLog({ dir: join(base, "streams"), blobs, logger: () => {} });
	const streamId = "stream-blob";

	// A real screenshot is far above the single-event cap once base64 encoded; the
	// payload has to leave the log line or the message gets amputated.
	const picture = Buffer.alloc(400_000, 7).toString("base64");
	await log.append(streamId, [
		{ type: "stream.created", streamId, cwd: "/tmp/project" },
		{ type: "user.message", text: "看看这个报错", images: [{ mimeType: "image/png", data: picture }] },
	]);

	const written = (await log.read(streamId)).find((event) => event.type === "user.message");
	const stored = Array.isArray(written?.images) ? written.images[0] : undefined;
	check("图片事件没有超过单事件上限", written?.truncated === undefined);
	check("事件里存的是 blob 引用", typeof stored?.ref === "string" && stored?.ref.startsWith("blob:") && stored?.data === undefined, JSON.stringify(stored).slice(0, 120));
	check("blob 引用带 sha256", blobHash(stored?.ref) !== undefined);
	check("blob 文件按内容寻址写出", existsSync(join(blobDir, blobHash(stored?.ref) ?? "")));
	check("日志里不含图片正文", !readFileSync(join(base, "streams", streamId, eventFiles(join(base, "streams"), streamId)[0]), "utf8").includes(picture.slice(0, 200)));
	check("mime 类型随引用保存", stored?.mimeType === "image/png");

	const ref = String(stored?.ref ?? "");
	const folded = foldTranscript(await log.read(streamId), (reference) => log.readBlob(reference));
	const foldedContent = Array.isArray(folded[0]?.content) ? folded[0].content : [];
	const foldedImage = foldedContent.find((block) => block?.type === "image");
	check("折叠时图片从 blob 还原", foldedImage?.data === picture && foldedImage?.mimeType === "image/png");
	check("折叠保留用户文字", foldedContent.some((block) => block?.type === "text" && block.text === "看看这个报错"));

	// Same bytes twice: one file, because the name is the hash.
	const before = readdirSync(blobDir).filter((name) => !name.endsWith(".json")).length;
	blobs.put(picture, "image/png");
	check("相同图片只存一份", readdirSync(blobDir).filter((name) => !name.endsWith(".json")).length === before);

	// A blob that is gone (cleaned up, copied elsewhere) must not become a block
	// with no data — the message stays, only the picture drops out.
	rmSync(join(blobDir, blobHash(ref) ?? ""), { force: true });
	const withoutBlob = foldTranscript(await log.read(streamId), (reference) => log.readBlob(reference));
	check("blob 丢失时消息仍在，图片被跳过", withoutBlob.length === 1 && withoutBlob[0]?.content === "看看这个报错", JSON.stringify(withoutBlob[0]?.content).slice(0, 120));

	// A reader that knows nothing about blobs still gets a usable transcript.
	const unresolved = foldTranscript(await log.read(streamId));
	check("不传读取器时也不崩", unresolved.length === 1);
	log.close();
}

/* --------------------- F. session-store compatibility ------------------- */

async function storeChecks() {
	const { createSessionStore, sessionRecord } = await import("../dist/features/session-store.js");
	const { createStreamLog } = await import("../dist/features/stream-log.js");
	const { foldTranscript } = await import("../dist/features/state-fold.js");

	const base = scratch("steve-compat-");
	const sessionsDir = join(base, "sessions");
	const store = createSessionStore({ dir: sessionsDir, logger: () => {} });
	const id = "abcdefabcdef";

	const messages = [
		{ role: "user", content: "hi", timestamp: 1_000 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "consider" },
				{ type: "text", text: "hello" },
				{ type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "a.txt" } },
			],
			usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5 },
			stopReason: "toolUse",
			timestamp: 2_000,
		},
		{ role: "toolResult", toolCallId: "call-1", toolName: "read_file", content: [{ type: "text", text: "file body" }], isError: false, timestamp: 3_000 },
		{ role: "user", content: [{ type: "text", text: "again" }], timestamp: 4_000 },
	];

	await store.save(sessionRecord({ id, cwd: "/tmp/project", messages, createdAt: "2026-01-01T00:00:00.000Z" }));

	check("兼容产物 <id>.json 仍然写出", existsSync(join(sessionsDir, `${id}.json`)));
	check("streams 目录默认落在 sessions 的兄弟目录", existsSync(join(base, "streams", id)));
	check("流目录含 meta.json", existsSync(join(base, "streams", id, "meta.json")));

	const loaded = await store.load(id);
	check("load 从流折叠出同样的消息数", loaded?.messages.length === 4);
	check("load 保留 cwd / createdAt", loaded?.cwd === "/tmp/project" && loaded?.createdAt === "2026-01-01T00:00:00.000Z");
	check("load 保留 assistant 的完整内容", Array.isArray(loaded?.messages[1]?.content) && loaded?.messages[1]?.content?.[1]?.text === "hello");

	const log = createStreamLog({ dir: join(base, "streams"), logger: () => {} });
	const events = await log.read(id);
	const folded = foldTranscript(events);
	check("JSONL 折叠结果与 load 一致", JSON.stringify(folded) === JSON.stringify(loaded?.messages));

	// JSONL is the truth: the legacy artifact may be missing without losing history.
	rmSync(join(sessionsDir, `${id}.json`), { force: true });
	const withoutLegacy = await store.load(id);
	check("旧 json 丢失时仍从流恢复", withoutLegacy?.messages.length === 4);

	// Appending only writes the new messages.
	await store.save(sessionRecord({ id, cwd: "/tmp/project", messages: [...messages, { role: "user", content: "more", timestamp: 5_000 }], createdAt: "2026-01-01T00:00:00.000Z" }));
	check("增量保存只追加新消息", (await log.read(id)).length === 6 && (await store.load(id))?.messages.length === 5);

	// /new: a shorter transcript means the stream is rebuilt.
	await store.save(sessionRecord({ id, cwd: "/tmp/project", messages: [messages[0]], createdAt: "2026-01-01T00:00:00.000Z" }));
	const truncated = await store.load(id);
	const truncatedEvents = await log.read(id);
	check("截短后流被重建", truncated?.messages.length === 1 && truncatedEvents.length === 2 && truncatedEvents[0]?.type === "stream.created");

	// Legacy-only sessions (written before S1) still load and list.
	const legacyId = "1234567890ab";
	mkdirSync(sessionsDir, { recursive: true });
	writeFileSync(
		join(sessionsDir, `${legacyId}.json`),
		`${JSON.stringify({ id: legacyId, cwd: "/tmp/legacy", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", messages: [messages[0]] })}\n`,
	);
	const legacyLoaded = await store.load(legacyId);
	check("旧格式会话可以回退读取", legacyLoaded?.messages.length === 1 && legacyLoaded?.cwd === "/tmp/legacy");
	const listed = await store.list();
	check("list 合并流与旧 json", listed.some((entry) => entry.id === id) && listed.some((entry) => entry.id === legacyId));

	await store.remove(id);
	check("remove 同时删除流与旧 json", !existsSync(join(base, "streams", id)) && !existsSync(join(sessionsDir, `${id}.json`)) && (await store.load(id)) === undefined);
	check("remove 后不再出现在 list", !(await store.list()).some((entry) => entry.id === id));
	log.close();
}

/* -------------------------------- driver -------------------------------- */

async function main() {
	try {
		await logChecks();
		await crashChecks();
		await rotationChecks();
		await forkChecks();
		await sizeChecks();
		await blobChecks();
		await storeChecks();
	} finally {
		for (const dir of roots) rmSync(dir, { recursive: true, force: true });
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
