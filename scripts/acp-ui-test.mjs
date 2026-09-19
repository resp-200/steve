#!/usr/bin/env node
// Drives the real test page (test-acp-jsonrpc.html) in headless Chrome over the
// DevTools protocol, so the browser client path is verified end to end:
// initialize → session/new → prompt → session/update streaming → permission →
// fs/read_text_file / fs/write_text_file / terminal/* answered by the page.
//
//   npm run mock &
//   LLM_API_KEY=mock LLM_MODEL_ID=mock LLM_BASE_URL=http://127.0.0.1:8899/anthropic \
//     node dist/protocols/acp/main.js --port 8891 &
//   node scripts/acp-ui-test.mjs --url http://127.0.0.1:8891/
//
// The full suite asserts against the offline mock gateway (keyword-driven tool
// calls). With a real gateway use the smoke mode, which only checks that a turn
// streams back:
//   node scripts/acp-ui-test.mjs --url http://127.0.0.1:8892/ --smoke "用一句话介绍你自己"
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import WebSocket from "ws";

const CHROME_CANDIDATES = [
	process.env.CHROME_PATH,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
].filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
	const options = { url: "http://127.0.0.1:8891/", keepOpen: false, smoke: undefined };
	for (let index = 0; index < argv.length; index += 1) {
		const next = argv[index + 1];
		if (argv[index] === "--url") options.url = argv[++index];
		else if (argv[index] === "--keep-open") options.keepOpen = true;
		else if (argv[index] === "--smoke") options.smoke = next && !next.startsWith("--") ? argv[++index] : "用一句话介绍你自己";
	}
	return options;
}

/* --------------------------------- Chrome --------------------------------- */

async function launchChrome() {
	const profile = mkdtempSync(join(tmpdir(), "acp-ui-test-"));
	let lastError;

	for (const executable of CHROME_CANDIDATES) {
		const child = spawn(
			executable,
			[
				"--headless=new",
				"--disable-gpu",
				"--no-first-run",
				"--no-default-browser-check",
				"--disable-extensions",
				"--disable-background-networking",
				`--user-data-dir=${profile}`,
				"--remote-debugging-port=0",
				"--remote-allow-origins=*",
				"about:blank",
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);

		try {
			const endpoint = await new Promise((resolve, reject) => {
				let buffer = "";
				const timer = setTimeout(() => reject(new Error("timed out waiting for the DevTools endpoint")), 20_000);
				child.stderr.on("data", (chunk) => {
					buffer += chunk.toString();
					const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
					if (match) {
						clearTimeout(timer);
						resolve(match[1]);
					}
				});
				child.once("exit", (code) => {
					clearTimeout(timer);
					reject(new Error(`chrome exited early with code ${code}`));
				});
			});
			return { child, endpoint, profile };
		} catch (error) {
			lastError = error;
			child.kill("SIGKILL");
		}
	}

	rmSync(profile, { recursive: true, force: true });
	throw new Error(`could not launch Chrome (${lastError?.message ?? "no candidate found"})`);
}

/** Tiny CDP client: one websocket, one promise per message id. */
class Cdp {
	constructor(socket) {
		this.socket = socket;
		this.nextId = 1;
		this.pending = new Map();
		socket.on("message", (raw) => {
			const message = JSON.parse(raw.toString());
			if (message.id === undefined) return;
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.error) pending.reject(new Error(message.error.message));
			else pending.resolve(message.result);
		});
	}

	send(method, params = {}, sessionId) {
		const id = this.nextId++;
		const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify(payload));
		});
	}

	async evaluate(sessionId, expression) {
		const result = await this.send(
			"Runtime.evaluate",
			{ expression, awaitPromise: true, returnByValue: true, userGesture: true },
			sessionId,
		);
		if (result.exceptionDetails) {
			throw new Error(`page exception: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
		}
		return result.result?.value;
	}
}

/* ---------------------------------- test ---------------------------------- */

const checks = [];
function check(name, passed, detail = "") {
	checks.push({ name, passed, detail });
	process.stderr.write(`${passed ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}\n`);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	process.stderr.write("launching headless Chrome...\n");
	const { child, endpoint, profile } = await launchChrome();

	const socket = new WebSocket(endpoint);
	await new Promise((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	const cdp = new Cdp(socket);

	const { targetId } = await cdp.send("Target.createTarget", { url: options.url });
	const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
	await cdp.send("Runtime.enable", {}, sessionId);

	/** Sends a prompt without blocking and auto-approves every permission card. */
	const sendAndApprove = async (text, { approvals = 8 } = {}) => {
		await cdp.evaluate(
			sessionId,
			`void (() => {
				window.__turnResult = null;
				window.acpTest.sendText(${JSON.stringify(text)}).then(
					() => { window.__turnResult = "ok"; },
					(error) => { window.__turnResult = String(error && error.message ? error.message : error); },
				);
			})()`,
		);

		let granted = 0;
		for (let attempt = 0; attempt < 120; attempt += 1) {
			const state = JSON.parse(
				await cdp.evaluate(
					sessionId,
					`JSON.stringify({
						done: window.__turnResult,
						approvable: Boolean(document.querySelector('.permission .btn-row button')),
					})`,
				),
			);
			if (state.approvable && granted < approvals) {
				await cdp.evaluate(sessionId, "document.querySelector('.permission .btn-row button')?.click()");
				granted += 1;
				continue;
			}
			if (state.done) return { result: state.done, granted };
			await sleep(250);
		}
		throw new Error(`turn did not finish: ${text}`);
	};

	try {
		// 0. the inlined ACP client must match web/acp-http-client.js
		try {
			execFileSync(process.execPath, ["scripts/sync-ui-client.mjs", "--check"], { stdio: "pipe" });
			check("页面内联的 ACP client 与 web/acp-http-client.js 同步", true);
		} catch {
			check("页面内联的 ACP client 与 web/acp-http-client.js 同步", false, "运行 `npm run acp:ui-sync`");
		}

		// 1. page bootstrap
		let ready = false;
		for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
			ready = await cdp.evaluate(sessionId, "document.readyState === 'complete' && Boolean(window.acpTest)");
			if (!ready) await sleep(250);
		}
		if (!ready) throw new Error("page did not initialize window.acpTest");
		check("页面加载并提供 window.acpTest", true);

		const cwd = await cdp.evaluate(sessionId, "document.getElementById('cwd').value");
		check("服务端注入了真实 cwd", cwd.startsWith("/"), cwd);

		// 1. initialize + session/new
		await cdp.evaluate(sessionId, "window.acpTest.connect()");
		const connected = await cdp.evaluate(sessionId, "window.acpTest.chatText()");
		check("initialize 成功并建立会话", connected.includes("已连接") && connected.includes("session 就绪"));

		const caps = await cdp.evaluate(sessionId, "document.getElementById('agentCapabilities').textContent");
		check("读到 agent 能力", caps.includes("promptCapabilities"), caps.slice(0, 70));

		if (options.smoke) {
			// Real-gateway mode: only assert that a turn round-trips.
			const run = await sendAndApprove(options.smoke);
			const chat = await cdp.evaluate(sessionId, "window.acpTest.chatText()");
			check(`smoke 提问完成：${options.smoke}`, run.result === "ok", `approvals=${run.granted}`);
			check("smoke：拿到助手文本", chat.includes("AGENT") && chat.length > 120, chat.slice(-100).replace(/\n/g, " "));
		} else {
			// 2. agent_message_chunk 流式渲染
			const first = await sendAndApprove("hello there");
			const chatAfterText = await cdp.evaluate(sessionId, "window.acpTest.chatText()");
			check("agent_message_chunk 流式渲染", first.result === "ok" && chatAfterText.includes("pi-agent-core"));

			// 3. fs/read_text_file（浏览器虚拟文件系统）
			await sendAndApprove(`read ${cwd}/README.md`);
			const readTurn = await cdp.evaluate(sessionId, "window.acpTest.chatText()");
			check("fs/read_text_file 往返", readTurn.includes("demo project"));

			// 4. 权限弹窗 + terminal/* + run_command
			const run = await sendAndApprove("run ls");
			const terminalText = await cdp.evaluate(sessionId, "window.acpTest.terminalText()");
			check("授权后执行 run_command（terminal/create）", run.granted > 0 && terminalText.includes("$ ls"), `approvals=${run.granted}`);
			check("terminal/output 回传输出", terminalText.includes("README.md"), terminalText.replace(/\n/g, " | ").slice(0, 60));

			// 5. 拒绝授权 → 工具被拦截
			await cdp.evaluate(
				sessionId,
				`void (() => {
					window.__denied = null;
					window.acpTest.sendText("run ls").then(() => { window.__denied = "ok"; }, (error) => { window.__denied = String(error); });
				})()`,
			);
			let denyCard = false;
			for (let attempt = 0; attempt < 60 && !denyCard; attempt += 1) {
				denyCard = await cdp.evaluate(sessionId, "Boolean(document.querySelector('.permission .btn-row button.btn-danger'))");
				if (!denyCard) await sleep(250);
			}
			check("拒绝按钮可用", denyCard);
			await cdp.evaluate(sessionId, "document.querySelector('.permission .btn-row button.btn-danger')?.click()");
			for (let attempt = 0; attempt < 60; attempt += 1) {
				if (await cdp.evaluate(sessionId, "window.__denied !== null")) break;
				await sleep(250);
			}
			const failedTool = await cdp.evaluate(
				sessionId,
				`(() => { const cards = [...document.querySelectorAll('.tool')]; const last = cards[cards.length - 1]; return last ? last.className + "|" + (last.querySelector('pre')?.textContent ?? "") : "none"; })()`,
			);
			check("拒绝授权后工具失败且未执行", failedTool.includes("failed") && failedTool.includes("denied"), failedTool.slice(0, 90));

			// 6. fs/write_text_file
			const write = await sendAndApprove(`write ${cwd}/note.txt`);
			const filesText = await cdp.evaluate(sessionId, "window.acpTest.filesText()");
			check("fs/write_text_file 写入虚拟文件系统", write.result === "ok" && filesText.includes("note.txt"));

			// 6b. 审批卡片渲染 agent 给出的 diff（原始 JSON-RPC 里也能看到）
			const diffCard = await cdp.evaluate(sessionId, "document.querySelector('.permission .diff')?.textContent ?? ''");
			const diffLogged = await cdp.evaluate(sessionId, "window.acpTest.logText()");
			check(
				"授权卡片显示 diff 预览",
				diffCard.includes("note.txt") && diffCard.includes("+hello from the mock model") && /\"type\":\s*\"diff\"/.test(diffLogged),
				diffCard.replace(/\n/g, " | ").slice(0, 100),
			);

			// 7. 原始 JSON-RPC 日志
			const logText = await cdp.evaluate(sessionId, "window.acpTest.logText()");
			check(
				"日志记录双向 JSON-RPC",
				logText.includes("session/update") && logText.includes("session/prompt") && logText.includes("session/request_permission"),
			);

			// 8. session/cancel
			const cancelled = await cdp.evaluate(
				sessionId,
				`(async () => {
					const client = window.acpTest.state.client;
					const sessionId = window.acpTest.state.sessionId;
					const promise = client.prompt(sessionId, [{ type: "text", text: "hello there" }]);
					setTimeout(() => client.cancel(sessionId), 60);
					return (await promise).stopReason;
				})()`,
			);
			check("session/cancel → stopReason=cancelled", cancelled === "cancelled", String(cancelled));

			// 9. 未实现的方法
			const listError = await cdp.evaluate(
				sessionId,
				`window.acpTest.state.client.request("providers/list", {}).then(() => null, (error) => String(error.message))`,
			);
			check("未实现的方法返回 JSON-RPC 错误", typeof listError === "string" && listError.length > 0, String(listError).slice(0, 70));

			// 10. 传输层 429 会被自动重试：mock 对含 “flaky” 的一轮先失败两次
			const chatBefore = await cdp.evaluate(sessionId, "window.acpTest.chatText()");
			const flaky = await sendAndApprove("flaky 请回答 ok");
			const flakyTurn = (await cdp.evaluate(sessionId, "window.acpTest.chatText()")).slice(chatBefore.length);
			check(
				"provider 429 自动重试后成功（客户端看不到失败轮）",
				flaky.result === "ok" && flakyTurn.includes("flaky-recovered after 2 injected 429s") && !flakyTurn.includes("⚠️"),
				flakyTurn.slice(-110).replace(/\n/g, " "),
			);
		}

		await cdp.evaluate(sessionId, "window.acpTest.disconnect()");
	} catch (error) {
		process.stderr.write(`\n--- diagnostics ---\n${error.message}\n`);
		try {
			process.stderr.write(`chat:\n${await cdp.evaluate(sessionId, "window.acpTest.chatText()")}\n`);
			process.stderr.write(`log tail:\n${(await cdp.evaluate(sessionId, "window.acpTest.logText()")).slice(-1200)}\n`);
		} catch {
			/* page may be gone */
		}
		process.exitCode = 1;
	} finally {
		if (!options.keepOpen) {
			socket.close();
			child.kill("SIGTERM");
			await sleep(300);
			child.kill("SIGKILL");
			rmSync(profile, { recursive: true, force: true });
		}
	}

	const failed = checks.filter((entry) => !entry.passed);
	process.stderr.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
	if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
	process.stderr.write(`ui test failed: ${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
});
