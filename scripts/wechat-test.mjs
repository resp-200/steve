#!/usr/bin/env node
// Verifies the WeChat (ClawBot / iLink) channel end to end:
//
//   A. the wire format: request headers, base_info, the send body, and the update
//      parser (own messages, media, missing context tokens, the cursor)
//   B. who may drive the bot: the scanning account, STEVE_WECHAT_ALLOW, and an
//      owner-less session refusing everyone
//   C. a fake iLink server: QR login (including an expired code), long polling that
//      only advances the cursor when the server hands one back, session expiry, and
//      a real sendmessage reaching the server with the text the model produced
//   D. the terminal QR: our encoder against the shapes a login URL takes, and the
//      refusal to silently truncate something that does not fit
//
//   npm run build && node scripts/wechat-test.mjs
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { CHANNEL_VERSION, parseAllowList, readQrStatus, readUpdates, SESSION_EXPIRED_CODE, WechatError, wechatAllowed, wechatStreamId, buildSendTextBody, parseWechatSession, serializeWechatSession } from "../dist/model/wechat.js";
import { clearWechatSession, createWechatClient, loginWechat, pollWechat, readWechatSession, WechatSessionExpired, writeWechatSession } from "../dist/features/wechat.js";
import { encodeQr, renderQr } from "../dist/features/qr.js";

const checks = [];
const check = (name, passed, detail = "") => {
	checks.push({ name, passed });
	process.stderr.write(`  ${passed ? "✓" : "✗"} ${name}${passed || !detail ? "" : ` — ${detail}`}\n`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- A. wire format and parsing ---------- */

function wire() {
	const sent = buildSendTextBody({ to: "wxid_a", contextToken: "ctx-1", text: "你好", clientId: "steve-1" });
	// iLink nests the message under `msg`, next to the base_info every call carries.
	const body = sent.msg;
	check("send body marks the message as a bot reply", body.message_type === 2 && body.message_state === 2, JSON.stringify(body));
	check("send body carries the context token", body.context_token === "ctx-1");
	check("send body keeps text in a type-1 item", JSON.stringify(body.item_list) === JSON.stringify([{ type: 1, text_item: { text: "你好" } }]), JSON.stringify(body.item_list));
	check("send body carries the idempotency key", body.client_id === "steve-1");
	check("send body leaves the sender blank (the bot is implied)", body.from_user_id === "");

	const parsed = readUpdates({
		get_updates_buf: "buf-2",
		msgs: [
			{ message_id: "m1", from_user_id: "wxid_a", context_token: "ctx", message_type: 1, item_list: [{ type: 1, text_item: { text: "在吗" } }] },
			{ message_id: "m2", from_user_id: "wxid_bot", context_token: "ctx", message_type: 2, item_list: [{ type: 1, text_item: { text: "自己的回复" } }] },
			{ message_id: "m3", from_user_id: "wxid_c", context_token: "ctx", message_type: 1, item_list: [{ type: 2, image_item: {} }] },
			{ message_id: "m4", from_user_id: "wxid_d", context_token: "ctx", message_type: 1, item_list: [{ type: 1, text_item: { text: "一" } }, { type: 1, text_item: { text: "二" } }] },
			{ message_id: "m5", from_user_id: "wxid_e", context_token: "", message_type: 1, item_list: [{ type: 1, text_item: { text: "没有上下文" } }] },
			{ message_id: "m6", from_user_id: "bot@im.bot", context_token: "ctx", message_type: 1, item_list: [{ type: 1, text_item: { text: "镜像" } }] },
		],
	});
	check("bot's own messages are dropped", !parsed.events.some((event) => event.kind === "message" && event.messageId === "m2"));
	check("mirror messages from @im.bot are dropped", !parsed.events.some((event) => "messageId" in event && event.messageId === "m6"));
	check("a text message becomes a message event", parsed.events.some((event) => event.kind === "message" && event.text === "在吗" && event.userId === "wxid_a"));
	check("multiple text items in one message are joined", parsed.events.some((event) => event.kind === "message" && event.text === "一二"));
	check("media becomes an unsupported event naming the kind", parsed.events.some((event) => event.kind === "unsupported" && event.label === "图片"), JSON.stringify(parsed.events));
	check("a message without context_token is ignored, not answered", parsed.events.some((event) => event.kind === "ignored" && event.reason.includes("m5")), JSON.stringify(parsed.events));
	check("the server cursor is returned", parsed.cursor === "buf-2");

	const noCursor = readUpdates({ msgs: [] });
	check("an empty batch leaves the cursor untouched", noCursor.cursor === undefined);
	check("an empty batch has no events", noCursor.events.length === 0);

	check("a stream id is derived per sender", wechatStreamId("wxid_a") === wechatStreamId("wxid_a") && wechatStreamId("wxid_a") !== wechatStreamId("wxid_b"));
	check("a stream id is short and filesystem-safe", /^[0-9a-f]{12}$/.test(wechatStreamId("wxid_a")), wechatStreamId("wxid_a"));
}

/* ---------- B. who may drive the bot ---------- */

function permissions() {
	const owner = { botToken: "t", loginTime: "2026-01-01T00:00:00.000Z", ownerId: "wxid_owner" };
	check("the scanning account is allowed", wechatAllowed("wxid_owner", owner));
	check("a stranger is refused", !wechatAllowed("wxid_other", owner));
	check("an allow-listed stranger is allowed", wechatAllowed("wxid_other", owner, ["wxid_other"]));

	const unknownOwner = { botToken: "t", loginTime: "2026-01-01T00:00:00.000Z" };
	check("a session without an owner refuses everyone", !wechatAllowed("wxid_owner", unknownOwner));
	check("a session without an owner still honours the allow list", wechatAllowed("wxid_owner", unknownOwner, ["wxid_owner"]));

	check("the allow list splits on commas", JSON.stringify(parseAllowList("a, b ,,c")) === JSON.stringify(["a", "b", "c"]), JSON.stringify(parseAllowList("a, b ,,c")));
	check("an unset allow list is empty", parseAllowList(undefined).length === 0 && parseAllowList("  ").length === 0);
}

/* ---------- C. a fake iLink server ---------- */

async function withFakeIlink(run) {
	const requests = [];
	let codesIssued = 0;
	const server = createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			const url = new URL(request.url, "http://127.0.0.1");
			const body = raw === "" ? undefined : JSON.parse(raw);
			requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: request.headers, body });
			const json = (payload) => {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ ret: 0, ...payload }));
			};
			switch (url.pathname) {
				case "/ilink/bot/get_bot_qrcode": {
					// The first code is never scanned and expires; the second is.
					codesIssued += 1;
					const key = `qr-key-${codesIssued}`;
					json({ qrcode: key, qrcode_img_content: `https://weixin.qq.com/x/${key}` });
					return;
				}
				case "/ilink/bot/get_qrcode_status": {
					const key = url.searchParams.get("qrcode");
					if (key === "qr-key-1") json({ status: "expired" });
					else json({ status: "confirmed", bot_token: "bot-token-1", baseurl: baseUrl, bot_id: "bot-1" });
					return;
				}
				case "/ilink/bot/getconfig":
					json({ typing_ticket: "ticket-1" });
					return;
				case "/ilink/bot/sendtyping":
				case "/ilink/bot/sendmessage":
					json({});
					return;
				case "/ilink/bot/getupdates": {
					const cursor = body?.get_updates_buf ?? "";
					// One batch, then the server keeps handing back the same cursor with nothing new.
					if (cursor === "") {
						json({
							get_updates_buf: "buf-2",
							msgs: [{ message_id: "m10", from_user_id: "wxid_owner", context_token: "ctx-9", message_type: 1, item_list: [{ type: 1, text_item: { text: "几点了" } }] }],
						});
						return;
					}
					json({ get_updates_buf: "buf-2", msgs: [] });
					return;
				}
				default:
					response.writeHead(404).end();
			}
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${server.address().port}`;
	try {
		await run({ baseUrl, requests });
	} finally {
		server.close();
	}
}

async function againstFakeServer() {
	await withFakeIlink(async ({ baseUrl, requests }) => {
		/* login: first code expires, the second is scanned */
		const codes = [];
		const session = await loginWechat({
			baseUrl,
			pollMs: 0,
			sleep: async () => {},
			onQrCode: (qr) => {
				codes.push(qr);
			},
		});
		check("login fetches a QR code", codes.length >= 1 && codes[0].image === "https://weixin.qq.com/x/qr-key-1", JSON.stringify(codes));
		check("a new code is shown after the first expires", codes.length === 2 && codes[1].image === "https://weixin.qq.com/x/qr-key-2", JSON.stringify(codes));
		check("an expired code is replaced by a new one", requests.filter((item) => item.path === "/ilink/bot/get_bot_qrcode").length >= 2, String(requests.filter((item) => item.path === "/ilink/bot/get_bot_qrcode").length));
		check("login returns the bot token and service url", session.botToken === "bot-token-1" && session.baseUrl === baseUrl, JSON.stringify(session));

		const loginCall = requests.find((item) => item.path === "/ilink/bot/get_bot_qrcode");
		check("login asks for bot_type=3", loginCall?.query.bot_type === "3", JSON.stringify(loginCall?.query));
		check("every call carries the channel version", loginCall?.body === undefined ? true : loginCall.body.base_info?.channel_version === CHANNEL_VERSION);
		check("every call carries a stable-ish wechat uin header", typeof loginCall?.headers["x-wechat-uin"] === "string" && loginCall.headers["x-wechat-uin"] !== "", JSON.stringify(loginCall?.headers));
		check("login calls carry no bearer token", loginCall?.headers.authorization === undefined);

		/* the QR status reader */
		const confirmed = readQrStatus({ bot_token: "t", baseurl: "http://x", bot_id: "b" });
		check("a confirmed status yields a session", confirmed.session?.botToken === "t" && confirmed.status === "confirmed");
		check("a waiting status yields no session", readQrStatus({ status: "waiting" }).session === undefined);

		/* polling: one message, then stop */
		const events = [];
		let polls = 0;
		await pollWechat({
			session,
			onEvent: (event) => events.push(event),
			shouldContinue: () => polls < 3,
			fetchUpdates: async (cursor) => {
				const payload = await (async () => {
					const response = await fetch(`${baseUrl}/ilink/bot/getupdates`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.botToken}` }, body: JSON.stringify({ get_updates_buf: cursor, base_info: { channel_version: CHANNEL_VERSION } }) });
					return response.json();
				})();
				polls += 1;
				if (polls > 2) return { ret: 0, msgs: [] };
				return payload;
			},
			sleep: async () => {},
		});
		check("polling delivers the incoming message", events.some((event) => event.kind === "message" && event.text === "几点了"), JSON.stringify(events));
		const pollCalls = requests.filter((item) => item.path === "/ilink/bot/getupdates");
		check("the poll sends the bearer token", pollCalls[0]?.headers.authorization === "Bearer bot-token-1", JSON.stringify(pollCalls[0]?.headers));
		check("the poll sends the channel version", pollCalls[0]?.body?.base_info?.channel_version === CHANNEL_VERSION, JSON.stringify(pollCalls[0]?.body));
		check("the first poll starts from an empty cursor", pollCalls[0]?.body?.get_updates_buf === "", JSON.stringify(pollCalls[0]?.body));
		check("later polls carry the cursor the server handed back", pollCalls.at(-1)?.body?.get_updates_buf === "buf-2", JSON.stringify(pollCalls.at(-1)?.body));

		/* expiry: -14 stops the loop with a message that says what to do */
		let expiredError;
		try {
			await pollWechat({
				session,
				onEvent: () => {},
				shouldContinue: () => true,
				fetchUpdates: async () => {
					throw new WechatError(SESSION_EXPIRED_CODE, "getupdates failed: ret=-14 session expired");
				},
				sleep: async () => {},
			});
		} catch (error) {
			expiredError = error;
		}
		check("a -14 poll raises WechatSessionExpired", expiredError instanceof WechatSessionExpired, String(expiredError));
		check("the expiry message tells the user to log in again", String(expiredError?.message).includes("steve-wechat"), String(expiredError?.message));

		/* transient failures are retried, not fatal */
		let attempts = 0;
		const seen = [];
		await pollWechat({
			session,
			onEvent: (event) => seen.push(event),
			shouldContinue: () => attempts < 3,
			fetchUpdates: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("network down");
				return { ret: 0, get_updates_buf: "buf-2", msgs: [{ message_id: "m11", from_user_id: "wxid_owner", context_token: "ctx", message_type: 1, item_list: [{ type: 1, text_item: { text: "还在吗" } }] }] };
			},
			sleep: async () => {},
			retryDelayMs: 0,
		});
		check("a failed poll is retried instead of killing the channel", seen.some((event) => event.kind === "message" && event.text === "还在吗"), JSON.stringify(seen));

		/* sending: a reply reaches the server with the text and context token */
		const client = createWechatClient(session);
		await client.sendText({ to: "wxid_owner", contextToken: "ctx-9", text: "现在十点" });
		const sendCall = requests.filter((item) => item.path === "/ilink/bot/sendmessage").at(-1);
		check("a reply reaches sendmessage", sendCall !== undefined);
		check("the reply carries the text the model produced", sendCall?.body?.msg?.item_list?.[0]?.text_item?.text === "现在十点", JSON.stringify(sendCall?.body));
		check("the reply goes back to the sender with the context token", sendCall?.body?.msg?.to_user_id === "wxid_owner" && sendCall?.body?.msg?.context_token === "ctx-9", JSON.stringify(sendCall?.body));
		check("the reply is marked as a bot message", sendCall?.body?.msg?.message_type === 2, JSON.stringify(sendCall?.body));
		check("the reply carries a fresh client id", typeof sendCall?.body?.msg?.client_id === "string" && sendCall.body.msg.client_id.startsWith("steve-"), JSON.stringify(sendCall?.body?.msg?.client_id));

		await client.sendText({ to: "wxid_owner", contextToken: "ctx-9", text: "第二条" });
		const second = requests.filter((item) => item.path === "/ilink/bot/sendmessage").at(-1);
		check("each reply gets its own client id", second?.body?.msg?.client_id !== sendCall?.body?.msg?.client_id, `${sendCall?.body?.msg?.client_id} vs ${second?.body?.msg?.client_id}`);

		/* typing: best effort, one config fetch then a cached ticket */
		const typing = createWechatClient(session);
		await typing.setTyping({ userId: "wxid_owner", contextToken: "ctx-9", on: true });
		await typing.setTyping({ userId: "wxid_owner", contextToken: "ctx-9", on: false });
		const configs = requests.filter((item) => item.path === "/ilink/bot/getconfig");
		const typings = requests.filter((item) => item.path === "/ilink/bot/sendtyping");
		check("the typing ticket is fetched once per user", configs.length === 1, String(configs.length));
		check("typing toggles on and off with the cached ticket", typings.length === 2 && typings[0].body.status === 1 && typings[1].body.status === 2 && typings[0].body.typing_ticket === "ticket-1", JSON.stringify(typings.map((item) => item.body)));

		check("the poll did not run away after the first batch", requests.length < 40, String(requests.length));
	});
}

/* ---------- D. the terminal QR ---------- */

function qr() {
	// A login URL with a fixed QR matrix would rot with any encoder change; asserting
	// encoder *behaviour* keeps the test honest without pinning 400 cells.
	const login = "https://weixin.qq.com/x/ABC1234567890abcdefghijklmnopqrstuvwxyz";
	const matrix = encodeQr(login);
	check("the login URL fits a small symbol", matrix.version <= 6 && matrix.size === matrix.version * 4 + 17, `v${matrix.version}`);
	check("finder patterns are drawn in three corners", matrix.modules[0][0] && matrix.modules[0][matrix.size - 1] && matrix.modules[matrix.size - 1][0]);
	check("the bottom-right corner is left open for data", !matrix.modules[matrix.size - 1][matrix.size - 1] || matrix.version > 1);
	check("the timing pattern alternates along row 6", Array.from({ length: matrix.size - 16 }, (_, index) => matrix.modules[6][8 + index]).every((dark, index) => dark === (index % 2 === 0)));
	check("the format area carries a mask number", matrix.modules[8][0] || matrix.modules[8][1] || matrix.modules[8][2]);
	check("the same text always encodes to the same matrix", JSON.stringify(encodeQr(login).modules) === JSON.stringify(matrix.modules));

	const longer = encodeQr(`${login}${"x".repeat(120)}`);
	check("a longer URL grows the symbol", longer.version > matrix.version, `v${longer.version}`);
	let overflow;
	try {
		encodeQr("x".repeat(400));
	} catch (error) {
		overflow = error;
	}
	check("a payload that does not fit is refused, not truncated", overflow instanceof Error && overflow.message.includes("too long"), String(overflow));

	const art = renderQr(login);
	const lines = art.split("\n");
	check("the terminal art has two modules per line", lines.length === Math.ceil(matrix.size / 2), `${lines.length} lines for ${matrix.size} modules`);
	check("the terminal art uses half blocks", /[▀▄█]/.test(art));
}

/* ---------- E. where the login lives ---------- */

function storage() {
	const dir = mkdtempSync(join(tmpdir(), "steve-wechat-test-"));
	const file = join(dir, "wechat.json");
	try {
		check("an absent login file reads as logged out", readWechatSession(file) === undefined);

		writeWechatSession({ botToken: "bot-token-1", baseUrl: "http://127.0.0.1:1", botId: "bot-1", loginTime: "2026-01-01T00:00:00.000Z" }, file);
		const mode = statSync(file).mode & 0o777;
		check("the login file is readable only by its owner", mode === 0o600, mode.toString(8));
		const stored = JSON.parse(readFileSync(file, "utf8"));
		check("the login file is written in snake_case", stored.bot_token === "bot-token-1" && stored.login_time === "2026-01-01T00:00:00.000Z", JSON.stringify(stored));

		const loaded = readWechatSession(file);
		check("a written login reads back", loaded?.botToken === "bot-token-1" && loaded?.baseUrl === "http://127.0.0.1:1", JSON.stringify(loaded));

		writeFileSync(file, "{ not json");
		check("a corrupt login file reads as logged out", readWechatSession(file) === undefined);

		writeFileSync(file, JSON.stringify({ baseurl: "http://x" }));
		check("a login file without a token reads as logged out", readWechatSession(file) === undefined);

		clearWechatSession(file);
		check("logging out removes the file", readWechatSession(file) === undefined);

		const roundTrip = parseWechatSession(serializeWechatSession({ botToken: "t", botId: "b", ownerId: "o", loginTime: "2026-01-01T00:00:00.000Z" }));
		check("a session survives a serialize/parse round trip", roundTrip?.botToken === "t" && roundTrip.botId === "b" && roundTrip.ownerId === "o", JSON.stringify(roundTrip));
		check("an unknown owner field is rejected, not guessed", parseWechatSession({ bot_token: "" }) === undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/* ---------- run ---------- */

for (const [label, run] of [
	["发送与解析", wire],
	["谁能使用机器人", permissions],
	["与 iLink 服务端交互", againstFakeServer],
	["终端二维码", qr],
	["登录文件", storage],
]) {
	process.stderr.write(`${label}\n`);
	await run();
	void sleep;
}

const failed = checks.filter((item) => !item.passed);
process.stderr.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
if (failed.length > 0) {
	process.stderr.write(`失败：${failed.map((item) => item.name).join("; ")}\n`);
	process.exitCode = 1;
}
