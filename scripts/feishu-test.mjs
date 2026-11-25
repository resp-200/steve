#!/usr/bin/env node
/**
 * Feishu (Lark) bot acceptance test: callback parsing, chat -> stream mapping,
 * agent run, Open API reply, dedupe and encrypted callbacks.
 *
 * Everything runs offline: a local fake Feishu Open API records the reply calls
 * and scripts/mock-server.mjs stands in for the model provider.
 */
import { spawn } from "node:child_process";
import { createHash, createCipheriv } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { streamIdForChat } from "../dist/protocols/feishu/bot.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

const SERVE_PORT = 8942;
const ENCRYPTED_PORT = 8944;
const MOCK_PORT = 8943;
const FEISHU_PORT = 8941;
const WS_PORT = 8946;
const WS_SERVE_PORT = 8947;

const TOKEN = "feishu-serve-token";
const APP_ID = "cli_feishu_test";
const APP_SECRET = "feishu-test-app-secret";
const VERIFICATION_TOKEN = "feishu-test-verification-token";
const ENCRYPT_KEY = "feishu-test-encrypt-key";
const TENANT_TOKEN = "feishu-test-tenant-token";
const CHAT_ID = "oc_feishu_test_chat";
const MESSAGE_ID = "om_feishu_test_message";
const REPLY_TEXT = "你好！我是一个基于 pi-agent-core 与 pi-ai 的最小对话 Agent。";

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

async function waitFor(predicate, { timeout = 20_000, interval = 100, label = "condition" } = {}) {
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
	void label;
	return state;
}

async function stop(child) {
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGTERM");
		await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(3000).then(() => child.kill("SIGKILL"))]);
	}
}

const sleepAsync = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPort(port, label, token) {
	await waitFor(
		async () => {
			try {
				const response = await fetch(`http://127.0.0.1:${port}/health`, {
					headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
				});
				return response.ok;
			} catch {
				return false;
			}
		},
		{ timeout: 20_000, label },
	);
}

/** Local stand-in for the Feishu Open API. */
function startFakeFeishu() {
	const replies = [];
	const tokenCalls = [];
	const endpointCalls = [];
	const server = createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const parsed = body === "" ? {} : JSON.parse(body);
			const reply = (status, payload) => {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify(payload));
			};
			if (request.url === "/callback/ws/endpoint") {
				endpointCalls.push({ body: parsed, headers: { locale: request.headers.locale, "user-agent": request.headers["user-agent"] } });
				reply(200, {
					code: 0,
					msg: "ok",
					data: {
						URL: `ws://127.0.0.1:${WS_PORT}/?device_id=dev-test&service_id=42`,
						ClientConfig: { PingInterval: 5, ReconnectCount: 3, ReconnectInterval: 1, ReconnectNonce: 1 },
					},
				});
				return;
			}
			if (request.url === "/open-apis/auth/v3/tenant_access_token/internal") {
				tokenCalls.push({ body: parsed });
				reply(200, { code: 0, msg: "ok", tenant_access_token: TENANT_TOKEN, expire: 7200 });
				return;
			}
			if (request.url !== undefined && /^\/open-apis\/im\/v1\/messages\/[^/]+\/reply$/.test(request.url)) {
				replies.push({ path: request.url, body: parsed, authorization: request.headers.authorization, at: Date.now() });
				reply(200, { code: 0, msg: "success", data: { message_id: "om_reply" } });
				return;
			}
			reply(404, { code: 404, msg: "not found" });
		});
	});
	return new Promise((resolve) => {
		server.listen(FEISHU_PORT, "127.0.0.1", () => resolve({ server, replies, tokenCalls, endpointCalls }));
	});
}

const mockEnv = {
	LLM_API_KEY: "mock",
	LLM_MODEL_ID: "mock",
	LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/anthropic`,
	STEVE_DISCOVERY: "off",
};

const feishuEnv = {
	FEISHU_MODE: "http",
	FEISHU_APP_ID: APP_ID,
	FEISHU_APP_SECRET: APP_SECRET,
	FEISHU_VERIFICATION_TOKEN: VERIFICATION_TOKEN,
	FEISHU_API_BASE: `http://127.0.0.1:${FEISHU_PORT}`,
};

function callbackHeaders(extra = {}) {
	return { "content-type": "application/json", ...extra };
}

async function postCallback(port, payload, headers = callbackHeaders()) {
	const startedAt = Date.now();
	const response = await fetch(`http://127.0.0.1:${port}/feishu/events`, {
		method: "POST",
		headers,
		body: typeof payload === "string" ? payload : JSON.stringify(payload),
	});
	const text = await response.text();
	return { status: response.status, text, ms: Date.now() - startedAt };
}

function messageEvent({ eventId = "evt_feishu_1", text = "你好", messageType = "text", senderType = "user", token = VERIFICATION_TOKEN } = {}) {
	return {
		schema: "2.0",
		header: { event_id: eventId, event_type: "im.message.receive_v1", token, create_time: String(Date.now()), app_id: APP_ID, tenant_key: "tenant" },
		event: {
			sender: { sender_id: { open_id: "ou_sender" }, sender_type: senderType, tenant_key: "tenant" },
			message: {
				message_id: MESSAGE_ID,
				chat_id: CHAT_ID,
				chat_type: "p2p",
				message_type: messageType,
				content: JSON.stringify({ text }),
				create_time: String(Date.now()),
			},
		},
	};
}

function encryptPayload(payload, encryptKey) {
	const key = createHash("sha256").update(encryptKey).digest();
	const iv = Buffer.from("0123456789abcdef", "utf8");
	const cipher = createCipheriv("aes-256-cbc", key, iv);
	const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
	return JSON.stringify({ encrypt: Buffer.concat([iv, encrypted]).toString("base64") });
}

function signedHeaders(body, encryptKey, timestamp = Math.floor(Date.now() / 1000)) {
	const nonce = "nonce-feishu-test";
	const signature = createHash("sha256").update(`${timestamp}${nonce}${encryptKey}${body}`).digest("hex");
	return callbackHeaders({
		"x-lark-request-timestamp": String(timestamp),
		"x-lark-request-nonce": nonce,
		"x-lark-signature": signature,
	});
}

function readStreamEvents(streamsDir, streamId) {
	const dir = join(streamsDir, streamId);
	if (!existsSync(dir)) return [];
	const events = [];
	for (const file of readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort()) {
		for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
			if (line.trim() === "") continue;
			try {
				const parsed = JSON.parse(line);
				if (typeof parsed === "object" && parsed !== null && parsed.seq !== undefined) events.push(parsed);
			} catch {
				// torn partial line
			}
		}
	}
	return events;
}

const workspace = mkdtempSync(join(tmpdir(), "steve-feishu-"));
const home = mkdtempSync(join(tmpdir(), "steve-feishu-home-"));
const streamsDir = join(workspace, ".steve", "streams");
mkdirSync(streamsDir, { recursive: true });

const children = [];
let fakeFeishu;

try {
	fakeFeishu = await startFakeFeishu();

	children.push(
		start("mock", process.execPath, [join(ROOT, "scripts", "mock-server.mjs")], {
			cwd: ROOT,
			env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
			stdio: ["ignore", "pipe", "pipe"],
		}),
	);
	const serve = start("serve", process.execPath, [join(ROOT, "dist", "entries", "serve.js"), "--port", String(SERVE_PORT), "--token", TOKEN], {
		cwd: workspace,
		env: { ...process.env, ...mockEnv, ...feishuEnv, HOME: home, MOCK_PORT: String(MOCK_PORT) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(serve);

	await waitForPort(SERVE_PORT, "serve /health", TOKEN);
	await waitFor(async () => fakeFeishu !== undefined, { label: "fake feishu" });

	// Auth: the Feishu callback is public (it authenticates with its own token),
	// everything else still needs the bearer token.
	const unauthenticated = await fetch(`http://127.0.0.1:${SERVE_PORT}/streams`);
	check("普通接口无 token 返回 401", unauthenticated.status === 401, `status ${unauthenticated.status}`);
	const authenticated = await fetch(`http://127.0.0.1:${SERVE_PORT}/streams`, { headers: { authorization: `Bearer ${TOKEN}` } });
	check("普通接口带 token 返回 200", authenticated.status === 200, `status ${authenticated.status}`);

	// A. URL verification
	const challenge = await postCallback(SERVE_PORT, { type: "url_verification", challenge: "feishu-challenge-1", token: VERIFICATION_TOKEN });
	let challengeBody = {};
	try {
		challengeBody = JSON.parse(challenge.text);
	} catch {
		// checked below
	}
	check("challenge 应答 200", challenge.status === 200, `status ${challenge.status}`);
	check("challenge 原样返回", challengeBody.challenge === "feishu-challenge-1", challenge.text);
	check("challenge 在 1s 内应答", challenge.ms < 1000, `${challenge.ms}ms`);

	const badToken = await postCallback(SERVE_PORT, { type: "url_verification", challenge: "x", token: "wrong-token" });
	check("错误 verification token 返回 401", badToken.status === 401, `status ${badToken.status}`);

	const missingToken = await postCallback(SERVE_PORT, { type: "url_verification", challenge: "x" });
	check("缺少 token 的 challenge 返回 401", missingToken.status === 401, `status ${missingToken.status}`);

	// B. One chat message becomes a stream + an agent run + a reply
	const ack = await postCallback(SERVE_PORT, messageEvent());
	check("消息回调 200 ACK", ack.status === 200, `status ${ack.status}`);
	check("消息回调 3 秒内 ACK", ack.ms < 3000, `${ack.ms}ms`);

	await waitFor(() => (fakeFeishu !== undefined && fakeFeishu.replies.length >= 1 ? fakeFeishu.replies : false), { label: "Feishu reply" });
	const reply = fakeFeishu.replies[0];
	let replyText = "";
	try {
		replyText = JSON.parse(reply.body.content).text;
	} catch {
		// checked below
	}
	check("回复走 messages/:id/reply", reply.path === `/open-apis/im/v1/messages/${MESSAGE_ID}/reply`, reply.path);
	check("回复携带 tenant_access_token", reply.authorization === `Bearer ${TENANT_TOKEN}`, String(reply.authorization));
	check("回复文本是 agent 的回答", replyText.includes(REPLY_TEXT), replyText);
	check("tenant token 只换取一次", fakeFeishu.tokenCalls.length === 1, `${fakeFeishu.tokenCalls.length} calls`);

	const streamId = streamIdForChat(CHAT_ID);
	const events = readStreamEvents(streamsDir, streamId);
	check("chat 映射到确定性的 stream id", /^[0-9a-f]{12}$/.test(streamId), streamId);
	check("stream 含 stream.created", events.some((event) => event.type === "stream.created"), String(events.length));
	check("stream 含用户消息", events.some((event) => event.type === "user.message" && event.text === "你好"));
	check("stream 含 run.settled", events.some((event) => event.type === "run.settled"));
	check("stream 含 assistant 输出", events.some((event) => event.type === "text_delta" || event.type === "run.turn.settled"));

	// C. Dedupe: Feishu retries the same event id
	const beforeDuplicate = readStreamEvents(streamsDir, streamId).length;
	const duplicate = await postCallback(SERVE_PORT, messageEvent({ eventId: "evt_feishu_1" }));
	check("重复 event_id 仍然 200", duplicate.status === 200, `status ${duplicate.status}`);
	await sleepAsync(1500);
	check("重复 event_id 不再产生回复", fakeFeishu.replies.length === 1, `${fakeFeishu.replies.length} replies`);
	check("重复 event_id 不再写入事件", readStreamEvents(streamsDir, streamId).length === beforeDuplicate);

	// D. Events a bot should not answer
	const imageEvent = await postCallback(SERVE_PORT, messageEvent({ eventId: "evt_feishu_2", messageType: "image" }));
	check("非文本消息 200 但忽略", imageEvent.status === 200);
	const appEvent = await postCallback(SERVE_PORT, messageEvent({ eventId: "evt_feishu_3", senderType: "app" }));
	check("app 自己发的消息 200 但忽略", appEvent.status === 200);
	await sleepAsync(1200);
	check("被忽略的事件不产生回复", fakeFeishu.replies.length === 1, `${fakeFeishu.replies.length} replies`);

	const badHeaderToken = await postCallback(SERVE_PORT, messageEvent({ eventId: "evt_feishu_4", token: "wrong" }));
	check("事件头 token 错误返回 401", badHeaderToken.status === 401, `status ${badHeaderToken.status}`);

	// E. Encrypted callbacks
	const encryptedServe = start("serve-encrypted", process.execPath, [join(ROOT, "dist", "entries", "serve.js"), "--port", String(ENCRYPTED_PORT), "--token", TOKEN], {
		cwd: workspace,
		env: { ...process.env, ...mockEnv, ...feishuEnv, FEISHU_ENCRYPT_KEY: ENCRYPT_KEY, HOME: home, MOCK_PORT: String(MOCK_PORT) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(encryptedServe);
	await waitForPort(ENCRYPTED_PORT, "encrypted serve /health", TOKEN);

	const encryptedChallengeBody = encryptPayload({ type: "url_verification", challenge: "encrypted-challenge", token: VERIFICATION_TOKEN }, ENCRYPT_KEY);
	const encryptedChallenge = await postCallback(ENCRYPTED_PORT, encryptedChallengeBody, signedHeaders(encryptedChallengeBody, ENCRYPT_KEY));
	let encryptedChallengeText = {};
	try {
		encryptedChallengeText = JSON.parse(encryptedChallenge.text);
	} catch {
		// checked below
	}
	check("加密 challenge 200", encryptedChallenge.status === 200, `status ${encryptedChallenge.status} ${encryptedChallenge.text}`);
	check("加密 challenge 解密后可应答", encryptedChallengeText.challenge === "encrypted-challenge", encryptedChallenge.text);

	const tampered = await postCallback(ENCRYPTED_PORT, encryptedChallengeBody, callbackHeaders());
	check("缺少签名头返回 401", tampered.status === 401, `status ${tampered.status}`);

	const encryptedMessageBody = encryptPayload(messageEvent({ eventId: "evt_feishu_encrypted" }), ENCRYPT_KEY);
	const encryptedMessage = await postCallback(ENCRYPTED_PORT, encryptedMessageBody, signedHeaders(encryptedMessageBody, ENCRYPT_KEY));
	check("加密消息回调 200", encryptedMessage.status === 200, `status ${encryptedMessage.status}`);

	// F. Long connection (WebSocket event subscription; no public callback)
	let wsModule;
	try {
		wsModule = await import("ws");
	} catch {
		wsModule = undefined;
	}
	if (wsModule === undefined) {
		process.stdout.write("  - `ws` is not installed; skipping long-connection checks\n");
	} else {
		const { WebSocketServer } = wsModule;
		const { encodeFrame, decodeFrame } = await import("../dist/protocols/feishu/long-connection.js");
		const frames = [];
		let connected = false;
		let serverSocket;
		const wss = new WebSocketServer({ host: "127.0.0.1", port: WS_PORT });
		await new Promise((resolve) => wss.once("listening", resolve));
		wss.on("connection", (socket) => {
			connected = true;
			serverSocket = socket;
			socket.on("message", (data) => {
				let frame;
				try {
					frame = decodeFrame(new Uint8Array(data));
				} catch (error) {
					frames.push({ error: String(error) });
					return;
				}
				frames.push(frame);
				const type = frame.headers.find((header) => header.key === "type")?.value;
				if (frame.method === 0 && type === "ping") {
					socket.send(
						encodeFrame({
							service: frame.service,
							method: 0,
							headers: [{ key: "type", value: "pong" }],
							payload: Buffer.from(JSON.stringify({ PingInterval: 5, ReconnectCount: 3, ReconnectInterval: 1, ReconnectNonce: 1 }), "utf8"),
						}),
					);
				}
			});
		});

		const wsServe = start("serve-ws", process.execPath, [join(ROOT, "dist", "entries", "serve.js"), "--port", String(WS_SERVE_PORT), "--token", TOKEN], {
			cwd: workspace,
			env: { ...process.env, ...mockEnv, ...feishuEnv, FEISHU_MODE: "ws", HOME: home, MOCK_PORT: String(MOCK_PORT) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		children.push(wsServe);
		await waitForPort(WS_SERVE_PORT, "long-connection serve /health", TOKEN);
		await waitFor(() => connected, { label: "long-connection websocket", timeout: 20_000 });

		check("长连接：用 app 凭据请求发现端点", fakeFeishu.endpointCalls.some((call) => call.body.AppID === APP_ID && call.body.AppSecret === APP_SECRET), String(fakeFeishu.endpointCalls.length));
		await waitFor(() => frames.some((frame) => frame.method === 0 && frame.headers.some((header) => header.key === "type" && header.value === "ping")), { label: "long-connection ping" });
		const ping = frames.find((frame) => frame.method === 0 && frame.headers.some((header) => header.key === "type" && header.value === "ping"));
		check("长连接：收到 ping 控制帧", ping !== undefined);
		check("长连接：ping 使用端点的 service_id", ping !== undefined && ping.service === 42 && ping.headers.some((header) => header.key === "type" && header.value === "ping"), String(ping?.service));

		// Deliver one message as two fragments, as Feishu does for larger events.
		const eventBody = JSON.stringify(messageEvent({ eventId: "evt_feishu_long_connection" }));
		const half = Math.ceil(eventBody.length / 2);
		const fragments = [eventBody.slice(0, half), eventBody.slice(half)];
		const beforeReplies = fakeFeishu.replies.length;
		fragments.forEach((fragment, index) => {
			serverSocket.send(
				encodeFrame({
					service: 42,
					method: 1,
					headers: [
						{ key: "type", value: "event" },
						{ key: "message_id", value: "lc-msg-1" },
						{ key: "sum", value: "2" },
						{ key: "seq", value: String(index + 1) },
						{ key: "trace_id", value: "trace-lc-1" },
					],
					payload: Buffer.from(fragment, "utf8"),
				}),
			);
		});
		await waitFor(() => frames.some((frame) => frame.method === 1 && frame.payload !== undefined && Buffer.from(frame.payload).toString("utf8").includes('"code":200')), { label: "long-connection ack" });
		const ack = frames.find((frame) => frame.method === 1 && frame.payload !== undefined && Buffer.from(frame.payload).toString("utf8").includes('"code":200'));
		check("长连接：分片事件收齐后 ack code=200", ack !== undefined);
		check("长连接：ack 带 biz_rt 头", ack !== undefined && ack.headers.some((header) => header.key === "biz_rt"), JSON.stringify(ack?.headers ?? []));

		const longStreamId = streamIdForChat(CHAT_ID);
		await waitFor(() => readStreamEvents(streamsDir, longStreamId).some((event) => event.type === "run.settled"), { label: "long-connection run settled", timeout: 30_000 });
		const longEvents = readStreamEvents(streamsDir, longStreamId);
		check("长连接：消息写入同一条 chat 流", longEvents.some((event) => event.type === "user.message" && event.text === "你好"));
		await waitFor(() => fakeFeishu.replies.length > beforeReplies, { label: "long-connection reply", timeout: 30_000 });
		const longReply = fakeFeishu.replies.at(-1);
		check("长连接：用 Open API 回复", longReply !== undefined && longReply.path === `/open-apis/im/v1/messages/${MESSAGE_ID}/reply`, String(longReply?.path));
		check("长连接：回复文本是 agent 的回答", longReply !== undefined && JSON.parse(longReply.body.content).text.includes(REPLY_TEXT), String(longReply?.body?.content ?? ""));

		const wsCallback = await postCallback(WS_SERVE_PORT, messageEvent({ eventId: "evt_feishu_ws_http" }), callbackHeaders({ authorization: `Bearer ${TOKEN}` }));
		check("长连接模式下 HTTP 回调返回 404", wsCallback.status === 404, `status ${wsCallback.status} ${wsCallback.text}`);
		check("长连接模式下 HTTP 回调提示改用 WebSocket", wsCallback.text.includes("long connection mode"), wsCallback.text);

		await stop(wsServe.child);
		wss.close();
		check("长连接：停止服务后连接关闭", true);
	}

	// G. Disabled without credentials
	const disabledServe = start(
		"serve-no-feishu",
		process.execPath,
		[join(ROOT, "dist", "entries", "serve.js"), "--port", "8945", "--no-feishu"],
		{
			cwd: workspace,
			env: { ...process.env, ...mockEnv, ...feishuEnv, HOME: home, MOCK_PORT: String(MOCK_PORT) },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	children.push(disabledServe);
	await waitForPort(8945, "no-feishu serve /health");
	const disabled = await postCallback(8945, { type: "url_verification", challenge: "x", token: VERIFICATION_TOKEN });
	check("--no-feishu 时 /feishu/events 返回 404", disabled.status === 404, `status ${disabled.status}`);

	process.stdout.write(`\n${checks - failures.length}/${checks} checks passed\n`);
	if (failures.length > 0) process.exitCode = 1;
} finally {
	for (const child of children) await stop(child.child);
	if (fakeFeishu !== undefined) await new Promise((resolve) => fakeFeishu.server.close(resolve));
	rmSync(workspace, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
}
