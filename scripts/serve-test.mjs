#!/usr/bin/env node
/**
 * `steve-serve` acceptance test: the HTTP/SSE surface plus the watch webhook.
 *
 * Runs offline against scripts/mock-server.mjs. A temp workspace is the cwd so
 * `.steve/watch.json` and the stream log stay out of the repository.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStreamLog } from "../dist/features/stream-log.js";
import { webhookSignature } from "../dist/features/trigger.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

const SERVE_PORT = 8911;
const NO_WATCH_PORT = 8912;
const MOCK_PORT = 8903;
const TOKEN = "serve-test-token";
const SECRET = "serve-test-secret";

let checks = 0;
const failures = [];

function check(name, ok, detail = "") {
	checks += 1;
	if (ok) {
		process.stdout.write(`  ✓ ${name}\n`);
		return;
	}
	failures.push(name);
	process.stdout.write(`  ✗ ${name}${detail === "" ? "" : ` — ${detail}`}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeout = 15_000, interval = 100, label = "condition" } = {}) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await predicate();
		if (value) return value;
		await sleep(interval);
	}
	throw new Error(`timed out waiting for ${label}`);
}

function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

/** Spawns a child and collects stderr so a failed boot can be reported. */
function start(label, command, args, options) {
	const child = spawn(command, args, options);
	const state = { child, stderr: "", stdout: "", exited: false, code: null };
	child.stderr.on("data", (chunk) => {
		state.stderr += chunk.toString();
	});
	child.stdout.on("data", (chunk) => {
		state.stdout += chunk.toString();
	});
	child.on("exit", (code) => {
		state.exited = true;
		state.code = code;
	});
	return state;
}

async function stop(child) {
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGTERM");
		await Promise.race([
			new Promise((resolve) => child.once("exit", resolve)),
			sleep(3000).then(() => child.kill("SIGKILL")),
		]);
	}
}

const auth = { authorization: `Bearer ${TOKEN}` };

function url(port, path) {
	return `http://127.0.0.1:${port}${path}`;
}

async function request(method, path, { port = SERVE_PORT, body, headers = auth } = {}) {
	const response = await fetch(url(port, path), {
		method,
		headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = text;
	}
	return { status: response.status, body: parsed, headers: response.headers };
}

/** Reads an SSE response until `until` matches a frame (or the timeout expires). */
async function readSse(path, { port = SERVE_PORT, until, timeoutMs = 20_000 } = {}) {
	const controller = new AbortController();
	const response = await fetch(url(port, path), { headers: auth, signal: controller.signal });
	const headers = {
		contentType: response.headers.get("content-type"),
		buffering: response.headers.get("x-accel-buffering"),
	};
	if (response.body === null) return { headers, events: [] };
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const events = [];
	let buffer = "";
	const deadline = Date.now() + timeoutMs;
	try {
		while (Date.now() < deadline) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let index = buffer.indexOf("\n\n");
			while (index >= 0) {
				const frame = buffer.slice(0, index);
				buffer = buffer.slice(index + 2);
				const data = frame
					.split("\n")
					.filter((line) => line.startsWith("data: "))
					.map((line) => line.slice(6))
					.join("\n");
				if (data !== "") {
					try {
						events.push(JSON.parse(data));
					} catch {
						/* ignore malformed frames */
					}
				}
				index = buffer.indexOf("\n\n");
			}
			if (until !== undefined && events.some(until)) break;
		}
	} catch {
		/* aborted after `until` matched */
	} finally {
		controller.abort();
	}
	return { headers, events };
}

const workspace = mkdtempSync(join(tmpdir(), "steve-serve-"));
mkdirSync(join(workspace, ".steve"), { recursive: true });
writeFileSync(
	join(workspace, ".steve", "watch.json"),
	JSON.stringify({
		triggers: {
			deploy: {
				kind: "webhook",
				path: "/hooks/deploy",
				secret: SECRET,
				targetStream: "hooktarget",
				mode: "background",
				prompt: "后台检查部署结果",
			},
		},
	}),
);
const streamsDir = join(workspace, "streams");

const env = {
	...process.env,
	HOME: workspace,
	STEVE_DISCOVERY: "off",
	LLM_API_KEY: "mock",
	LLM_MODEL_ID: "mock-model",
	LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
	STEVE_SERVE_TOKEN: "",
};

let mock;
let serve;
let noWatch;
let log;
try {
	mock = start("mock", process.execPath, [join(ROOT, "scripts", "mock-server.mjs")], {
		cwd: ROOT,
		env: { ...env, MOCK_PORT: String(MOCK_PORT) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	serve = start(
		"serve",
		process.execPath,
		[join(ROOT, "dist", "entries", "serve.js"), "--port", String(SERVE_PORT), "--token", TOKEN, "--streams-dir", streamsDir],
		{ cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] },
	);
	await waitFor(() => serve.stderr.includes("listening on"), { timeout: 20_000, label: "serve boot" });

	// ── health + auth ─────────────────────────────────────────────────────
	const health = await request("GET", "/health");
	check("GET /health answers", health.status === 200 && health.body.ok === true, `status ${health.status}`);
	check("GET /health reports the package version", health.body.version === VERSION, String(health.body.version));

	const anonymous = await request("GET", "/streams", { headers: {} });
	check("requests without the token are rejected", anonymous.status === 401, `status ${anonymous.status}`);

	const wrongToken = await request("GET", "/streams", { headers: { authorization: "Bearer nope" } });
	check("a wrong token is rejected", wrongToken.status === 401, `status ${wrongToken.status}`);

	// ── stream lifecycle ──────────────────────────────────────────────────
	const created = await request("POST", "/streams", { body: { title: "serve test" } });
	check("POST /streams creates a stream", created.status === 201 && /^[0-9a-f]{12}$/.test(created.body.streamId), JSON.stringify(created.body));
	const streamId = created.body.streamId;
	check("POST /streams echoes the title", created.body.title === "serve test");

	const listed = await request("GET", "/streams");
	check("GET /streams lists the new stream", listed.status === 200 && listed.body.streams.some((item) => item.streamId === streamId));

	const unknown = await request("GET", `/streams/doesnotexist123/events`);
	check("events of an unknown stream are 404", unknown.status === 404, `status ${unknown.status}`);

	const badId = await request("GET", `/streams/bad!id/events`);
	check("an invalid stream id is 400", badId.status === 400, `status ${badId.status}`);

	// ── prompt → SSE (user projection) ────────────────────────────────────
	const submitted = await request("POST", `/streams/${streamId}/messages`, { body: { text: "what time is it?" } });
	check("POST messages returns a run id", submitted.status === 202 && typeof submitted.body.runId === "string", JSON.stringify(submitted.body));

	const failedText = await request("POST", `/streams/${streamId}/messages`, { body: { text: "   " } });
	check("empty input is 400", failedText.status === 400, `status ${failedText.status}`);

	const sse = await readSse(`/streams/${streamId}/events?from=1`, {
		until: (frame) => frame.event?.type === "run.settled",
	});
	check("SSE sets text/event-stream", (sse.headers.contentType ?? "").includes("text/event-stream"), String(sse.headers.contentType));
	check("SSE disables proxy buffering", sse.headers.buffering === "no", String(sse.headers.buffering));

	const types = sse.events.map((frame) => frame.event?.type);
	check("SSE replays the user message", types.includes("user.message"));
	check("SSE streams assistant text", types.includes("text_delta") && sse.events.some((frame) => frame.event?.type === "text_delta" && typeof frame.event.text === "string" && frame.event.text !== ""));
	check("SSE ends with run.settled", types.includes("run.settled"));
	check("user projection never ships full tool args", sse.events.every((frame) => frame.event?.type !== "tool_start" || !("args" in frame.event)));
	check("user projection summarises tool results", sse.events.every((frame) => frame.event?.type !== "tool_end" || !("details" in frame.event && frame.event.details !== undefined)));
	check("user projection hides the internal turn message", types.includes("run.turn.settled") === false);
	check("every SSE frame is audience-tagged", sse.events.every((frame) => frame.project === "user" || frame.project === "full"));

	const replay = await readSse(`/streams/${streamId}/events?from=1`, { until: (frame) => frame.event?.type === "run.settled" });
	check("SSE replay is identical to the live pass", replay.events.map((frame) => frame.event?.type).join(",") === types.join(","));

	const listAfter = await request("GET", "/streams");
	const summary = listAfter.body.streams.find((item) => item.streamId === streamId);
	check("the stream summary advances", summary !== undefined && summary.lastSeq >= 3, JSON.stringify(summary));

	// ── cancel ────────────────────────────────────────────────────────────
	const running = await request("POST", `/streams/${streamId}/messages`, { body: { text: "flaky request" } });
	check("a flaky prompt is accepted", running.status === 202 && typeof running.body.runId === "string");
	await sleep(250);
	const cancelled = await request("POST", `/streams/${streamId}/cancel`, { body: { runId: running.body.runId } });
	check("cancel accepts an active run", cancelled.status === 202, `status ${cancelled.status}: ${JSON.stringify(cancelled.body)}`);
	check("cancel targets the submitted run", cancelled.body.runId === running.body.runId);
	const idleStream = await request("POST", "/streams", { body: {} });
	const cancelMissing = await request("POST", `/streams/${idleStream.body.streamId}/cancel`, { body: { runId: "nope" } });
	check("cancelling an unknown run is 404", cancelMissing.status === 404, `status ${cancelMissing.status}`);

	const eventsAfterCancel = await waitFor(
		async () => {
			const frames = await readSse(`/streams/${streamId}/events?from=1`, { until: (frame) => frame.event?.type === "run.cancelled", timeoutMs: 8000 });
			return frames.events.some((frame) => frame.event?.type === "run.cancelled") ? frames.events : undefined;
		},
		{ timeout: 15_000, label: "run.cancelled" },
	);
	check("the cancelled run settles as cancelled", eventsAfterCancel.some((frame) => frame.event?.type === "run.cancelled"));

	// ── approvals ─────────────────────────────────────────────────────────
	const granted = await request("POST", `/streams/${streamId}/approvals`, { body: { requestId: "approval-test", decision: "allow_once" } });
	check("approvals are accepted", granted.status === 202 && granted.body.granted === true, JSON.stringify(granted.body));

	// ── watch webhook → background run ────────────────────────────────────
	log = createStreamLog({ dir: streamsDir });
	const body = JSON.stringify({ ref: "main" });
	const signed = await fetch(url(SERVE_PORT, "/hooks/deploy"), {
		method: "POST",
		headers: { ...auth, "content-type": "application/json", "x-signature": webhookSignature(SECRET, body) },
		body,
	});
	check("a signed webhook is accepted", signed.status === 202, `status ${signed.status}`);

	const rejected = await fetch(url(SERVE_PORT, "/hooks/deploy"), {
		method: "POST",
		headers: { ...auth, "content-type": "application/json", "x-signature": "deadbeef" },
		body,
	});
	check("a bad webhook signature is rejected", rejected.status === 404, `status ${rejected.status}`);

	const missing = await fetch(url(SERVE_PORT, "/hooks/unknown"), { method: "POST", headers: auth, body: "{}" });
	check("an unknown webhook is 404", missing.status === 404, `status ${missing.status}`);

	const hookEvents = await waitFor(
		async () => {
			const events = await log.read("hooktarget");
			return events.some((event) => event.type === "run.settled") ? events : undefined;
		},
		{ timeout: 25_000, label: "background run settled" },
	);
	const hookTypes = hookEvents.map((event) => event.type);
	check("the webhook stream records trigger.fired", hookTypes.includes("trigger.fired"));
	check(
		"the fired input is prefixed with the trigger name",
		hookEvents.some((event) => event.type === "user.message" && typeof event.text === "string" && event.text.startsWith("[watch:deploy]")),
	);
	const hookStarted = hookEvents.find((event) => event.type === "run.started");
	check("the trigger runs in the background", hookStarted !== undefined && hookStarted.mode === "background");
	check("the background run produced an answer", hookEvents.some((event) => event.type === "run.turn.settled"));
	check("the background run folded a user + assistant pair", hookTypes.filter((type) => type === "user.message").length === 1);

	// ── --no-watch ────────────────────────────────────────────────────────
	noWatch = start(
		"serve-no-watch",
		process.execPath,
		[
			join(ROOT, "dist", "entries", "serve.js"),
			"--port",
			String(NO_WATCH_PORT),
			"--token",
			TOKEN,
			"--no-watch",
			"--streams-dir",
			join(workspace, "streams-nowatch"),
		],
		{ cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] },
	);
	await waitFor(() => noWatch.stderr.includes("listening on"), { timeout: 20_000, label: "no-watch boot" });
	const disabled = await fetch(url(NO_WATCH_PORT, "/hooks/deploy"), { method: "POST", headers: auth, body: "{}" });
	const disabledBody = await disabled.text();
	check("--no-watch disables hooks", disabled.status === 404 && disabledBody.includes("watch disabled"), `${disabled.status} ${disabledBody}`);
	check("--no-watch reports watch: off", noWatch.stderr.includes("watch: off"));

	// ── non-loopback without a token refuses to start ─────────────────────
	const open = start(
		"serve-open",
		process.execPath,
		[join(ROOT, "dist", "entries", "serve.js"), "--host", "0.0.0.0", "--port", "0", "--no-watch"],
		{ cwd: workspace, env: { ...env, STEVE_SERVE_TOKEN: "" }, stdio: ["ignore", "pipe", "pipe"] },
	);
	await waitFor(() => open.exited, { timeout: 15_000, label: "open host exit" });
	check("a non-loopback host without a token exits 2", open.code === 2, `code ${open.code}`);
	check("the refusal explains the missing token", open.stderr.includes("requires --token"), open.stderr.slice(0, 200));
} catch (error) {
	check("serve-test completed without throwing", false, describe(error));
} finally {
	if (noWatch !== undefined) await stop(noWatch.child);
	if (serve !== undefined) await stop(serve.child);
	if (mock !== undefined) await stop(mock.child);
	log?.close();
	rmSync(workspace, { recursive: true, force: true });
}

const total = checks;
if (failures.length > 0) {
	process.stderr.write(`\n${total - failures.length}/${total} checks passed; failed: ${failures.join(", ")}\n`);
	process.exit(1);
}
process.stdout.write(`\n${total}/${total} checks passed\n`);
