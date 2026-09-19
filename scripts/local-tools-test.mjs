#!/usr/bin/env node
// Verifies the local tools (features/local-tools.ts):
//
//   A. in-process: path confinement, read/write/edit, glob/grep, binary refusal,
//      command execution, and the read-only mode's tool list
//   B. CLI end to end against the offline mock: with `--yes` a real file is
//      written and read back; without it a non-interactive run is denied
//
//   npm run build && node scripts/local-tools-test.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 8897);

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

const textOf = (result) => (result.content ?? []).map((part) => part.text ?? "").join("");
const toolNamed = (tools, name) => tools.find((tool) => tool.name === name);
const failure = async (call) => {
	try {
		await call();
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
};

/* ------------------------ A. tools, in process --------------------------- */

async function toolChecks() {
	const { createLocalTools } = await import("../dist/features/local-tools.js");

	const workspace = mkdtempSync(join(tmpdir(), "steve-workspace-"));
	const outside = mkdtempSync(join(tmpdir(), "steve-outside-"));
	mkdirSync(join(workspace, "src", "nested"), { recursive: true });
	writeFileSync(join(workspace, "src", "nested", "app.ts"), "export const answer = 42;\n");
	writeFileSync(join(workspace, "notes.md"), "# notes\nTODO: ship it\n");
	writeFileSync(join(workspace, ".env"), "SECRET_TOKEN=do-not-leak\n");
	writeFileSync(join(workspace, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 4]));
	writeFileSync(join(outside, "secret.txt"), "outside\n");

	const tools = createLocalTools({ roots: [workspace], allowWrite: true, allowExec: true });
	check(
		"读/写/执行工具都注册了",
		["read_file", "glob", "grep", "write_file", "edit_file", "run_command"].every((name) => toolNamed(tools, name)),
		tools.map((tool) => tool.name).join(","),
	);
	check("只读模式只给读工具", createLocalTools({ roots: [workspace] }).map((tool) => tool.name).join(",") === "read_file,glob,grep");

	const read = toolNamed(tools, "read_file");
	const readResult = await read.execute("t", { path: "notes.md" });
	check("read_file 读回内容并带行号信息", textOf(readResult).includes("TODO: ship it") && textOf(readResult).includes("lines 1-3"), textOf(readResult).split("\n")[0]);

	const refusedRead = await failure(() => read.execute("t", { path: join(outside, "secret.txt") }));
	check("工作区外的路径被拒绝（读）", refusedRead.includes("outside the workspace roots"), refusedRead);
	const refusedWrite = await failure(() => toolNamed(tools, "write_file").execute("t", { path: join(outside, "new.txt"), content: "x" }));
	check("工作区外的路径被拒绝（写）", refusedWrite.includes("outside the workspace roots") && !existsSync(join(outside, "new.txt")), refusedWrite);
	const refusedCwd = await failure(() => toolNamed(tools, "run_command").execute("t", { command: "pwd", cwd: outside }));
	check("工作区外的 cwd 被拒绝（执行）", refusedCwd.includes("outside the workspace roots"), refusedCwd);
	const traversal = await failure(() => read.execute("t", { path: "../outside-file.txt" }));
	check("相对路径逃逸被拒绝", traversal.includes("outside the workspace roots"), traversal);

	await toolNamed(tools, "write_file").execute("t", { path: "src/new/created.ts", content: "export const created = true;\n" });
	check("write_file 建目录并写入", readFileSync(join(workspace, "src", "new", "created.ts"), "utf8").includes("created = true"));

	await toolNamed(tools, "edit_file").execute("t", { path: "notes.md", old_string: "TODO: ship it", new_string: "TODO: shipped" });
	check("edit_file 精确替换", readFileSync(join(workspace, "notes.md"), "utf8").includes("TODO: shipped"));
	writeFileSync(join(workspace, "dup.txt"), "same\nsame\n");
	const ambiguous = await failure(() => toolNamed(tools, "edit_file").execute("t", { path: "dup.txt", old_string: "same", new_string: "other" }));
	check("edit_file 拒绝有歧义的替换", ambiguous.includes("appears 2 times"), ambiguous);
	const missing = await failure(() => toolNamed(tools, "edit_file").execute("t", { path: "dup.txt", old_string: "nope", new_string: "x" }));
	check("edit_file 报出找不到的片段", missing.includes("was not found"), missing);

	const globbed = textOf(await toolNamed(tools, "glob").execute("t", { pattern: "**/*.ts" }));
	check("glob 支持 ** 且匹配嵌套文件", globbed.includes("src/nested/app.ts"), globbed.split("\n").slice(1, 4).join(" | "));

	const grepped = textOf(await toolNamed(tools, "grep").execute("t", { pattern: "TODO", glob: "*.md" }));
	check("grep 命中并给出 path:line", grepped.includes("notes.md:2"), grepped.split("\n").slice(0, 3).join(" | "));
	const dotfileHits = textOf(await toolNamed(tools, "grep").execute("t", { pattern: "do-not-leak" }));
	check("grep 不扫隐藏文件（.env 不外泄）", dotfileHits.includes("(no matches)"), dotfileHits.split("\n")[0]);

	const binary = await failure(() => read.execute("t", { path: "blob.bin" }));
	check("二进制文件拒绝按文本读取", binary.includes("looks binary"), binary);

	const command = await toolNamed(tools, "run_command").execute("t", { command: "echo hello && exit 3" });
	check("run_command 返回输出与退出码", textOf(command).includes("hello") && textOf(command).includes("exit 3"), textOf(command).replace(/\n/g, " "));
	const timedOut = await toolNamed(tools, "run_command").execute("t", { command: "sleep 2", timeout_ms: 150 });
	check("run_command 超时被标记", textOf(timedOut).includes("timed out"), textOf(timedOut).replace(/\n/g, " "));

	// --- images ---------------------------------------------------------------
	const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
		"base64",
	);
	writeFileSync(join(workspace, "pixel.png"), png);

	const visionTools = createLocalTools({ roots: [workspace], supportsImages: true });
	const imageResult = await toolNamed(visionTools, "read_file").execute("t", { path: "pixel.png" });
	const imageBlock = imageResult.content.find((part) => part.type === "image");
	check(
		"支持图片时 read_file 返回 image 内容块",
		imageBlock?.mimeType === "image/png" && (imageBlock?.data ?? "").length > 50 && imageResult.details?.image === true,
		JSON.stringify(imageResult.content.map((part) => part.type)),
	);
	const noVision = await failure(() => read.execute("t", { path: "pixel.png" }));
	check("不支持图片时仍按二进制拒绝", noVision.includes("looks binary"), noVision);
	const tinyCap = createLocalTools({ roots: [workspace], supportsImages: true, maxImageBytes: 10 });
	const tooBig = await failure(() => toolNamed(tinyCap, "read_file").execute("t", { path: "pixel.png" }));
	check("超出图片上限时拒绝", tooBig.includes("images are limited to"), tooBig);

	// --- change previews ------------------------------------------------------
	const { createLocalToolDescriber } = await import("../dist/features/local-tools.js");
	const describe = createLocalToolDescriber({ roots: [workspace], allowWrite: true, allowExec: true });

	const createPreview = await describe("write_file", { path: "fresh.txt", content: "one\ntwo\n" });
	check("预览：新建文件", createPreview?.summary.startsWith("create fresh.txt") === true && createPreview?.file?.oldText === undefined, createPreview?.summary ?? "");

	const overwritePreview = await describe("write_file", { path: "notes.md", content: "# notes\nDONE\n" });
	check(
		"预览：覆盖文件带 +/- diff",
		overwritePreview?.summary.startsWith("overwrite notes.md") === true &&
			(overwritePreview?.text ?? "").includes("-TODO: shipped") &&
			(overwritePreview?.text ?? "").includes("+DONE"),
		(overwritePreview?.text ?? "").split("\n").slice(2, 6).join(" | "),
	);

	const editPreview = await describe("edit_file", { path: "notes.md", old_string: "TODO: shipped", new_string: "DONE: shipped" });
	check(
		"预览：编辑给出发生次数与 diff",
		(editPreview?.summary ?? "").includes("1 occurrence") && (editPreview?.text ?? "").includes("-TODO: shipped") && (editPreview?.text ?? "").includes("+DONE: shipped"),
		(editPreview?.text ?? "").split("\n").slice(2, 5).join(" | "),
	);
	check("预览：执行命令只给摘要", (await describe("run_command", { command: "ls -la" }))?.summary === "run ls -la");
	check("预览：越界路径直接报错", (await failure(() => describe("write_file", { path: join(outside, "x.txt"), content: "x" }))).includes("outside the workspace roots"));

	rmSync(workspace, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
}

/* --------------------------- B. CLI, end to end -------------------------- */

async function cliChecks() {
	const mock = spawn(process.execPath, ["scripts/mock-server.mjs"], {
		cwd: ROOT,
		env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
		stdio: ["ignore", "pipe", "pipe"],
	});

	const workspace = mkdtempSync(join(tmpdir(), "steve-cli-"));
	const env = {
		...process.env,
		NO_COLOR: "1",
		LLM_API_KEY: "mock",
		LLM_MODEL_ID: "mock",
		LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/anthropic`,
	};

	const runCli = (args) =>
		new Promise((resolve) => {
			const child = spawn(process.execPath, [join(ROOT, "dist/entries/cli.js"), ...args], { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			child.stdout.on("data", (chunk) => (stdout += chunk));
			child.on("exit", () => resolve(stdout));
		});

	/**
	 * Runs the REPL and answers each permission prompt as soon as it appears, so
	 * the interactive approval path is exercised without timing guesses.
	 */
	const runCliInteractive = (prompt, answers) =>
		new Promise((resolve) => {
			const child = spawn(process.execPath, [join(ROOT, "dist/entries/cli.js")], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
			let stdout = "";
			let answered = 0;
			let closing = false;
			const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);

			child.stdout.on("data", (chunk) => {
				stdout += chunk;
				const prompts = stdout.split("[y] once").length - 1;
				while (answered < prompts && answered < answers.length) {
					child.stdin.write(`${answers[answered]}\n`);
					answered += 1;
				}
				if (answered >= answers.length && !closing) {
					closing = true;
					setTimeout(() => child.stdin.write("/exit\n"), 300);
				}
			});
			child.on("exit", () => {
				clearTimeout(timer);
				resolve(stdout);
			});
			child.stdin.write(`${prompt}\n`);
		});

	try {
		await waitForPort(MOCK_PORT);

		const notePath = join(workspace, "note.txt");
		const written = await runCli(["--yes", `write ${notePath}`]);
		check("CLI --yes 允许模型写文件", existsSync(notePath) && readFileSync(notePath, "utf8").includes("hello from the mock model"), written.split("\n").slice(-3).join(" ").slice(0, 120));

		const readBack = await runCli([`read ${notePath}`]);
		check("CLI 能读回文件内容", readBack.includes("hello from the mock model"), readBack.split("\n").slice(-3).join(" ").slice(0, 120));

		rmSync(notePath, { force: true });
		const denied = await runCli([`write ${notePath}`]);
		check("非交互运行默认拒绝写操作", !existsSync(notePath) && denied.includes("non-interactive"), denied.split("\n").slice(-4).join(" ").slice(0, 140));

		const readOnly = await runCli(["--read-only", "--help"]);
		const banner = await runCli(["--read-only"]);
		check("--read-only 不出现在工具列表里", readOnly.includes("--read-only") && !banner.includes("write_file"), banner.split("\n").find((line) => line.includes("tools")) ?? "");
		check("--read-only 在横幅里标明", banner.includes("read-only"), banner.split("\n").find((line) => line.includes("access")) ?? "");

		// Interactive: the prompt must show what is about to change before asking.
		const previewPath = join(workspace, "preview.txt");
		writeFileSync(previewPath, "old line\n");
		const interactive = await runCliInteractive(`write ${previewPath}`, ["n"]);
		check(
			"审批提示带 diff 预览",
			interactive.includes("overwrite preview.txt") && interactive.includes("-old line") && interactive.includes("+hello from the mock model"),
			interactive.split("\n").filter((line) => /^\s*[+-]/.test(line)).slice(0, 3).join(" | ").slice(0, 120),
		);
		check("回答 n 后文件未被修改", readFileSync(previewPath, "utf8") === "old line\n");
	} finally {
		mock.kill("SIGTERM");
		await sleep(200);
		mock.kill("SIGKILL");
		rmSync(workspace, { recursive: true, force: true });
	}
}

/* ------------------- C. ACP fallback to local tools ----------------------- */

async function acpFallbackChecks() {
	const { AcpHttpClient } = await import("../web/acp-http-client.js");
	const acpPort = Number(process.env.PLUGIN_TEST_PORT ?? 8894);
	const mock = spawn(process.execPath, ["scripts/mock-server.mjs"], {
		cwd: ROOT,
		env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
		stdio: ["ignore", "pipe", "pipe"],
	});

	const serverLog = [];
	const server = spawn(
		process.execPath,
		["dist/protocols/acp/main.js", "--port", String(acpPort), "--cors", "*", "--allow-local-tools"],
		{
			cwd: ROOT,
			env: { ...process.env, LLM_API_KEY: "mock", LLM_MODEL_ID: "mock", LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/anthropic` },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	server.stderr.on("data", (chunk) => serverLog.push(String(chunk)));

	try {
		await waitForPort(MOCK_PORT);
		await waitForPort(acpPort);

		const updates = [];
		let approvals = 0;
		const permissionRequests = [];
		const client = new AcpHttpClient(`http://127.0.0.1:${acpPort}/acp`, {});
		client
			.onMessage((event) => {
				if (event.message?.method === "session/update") updates.push(event.message.params.update);
			})
			.on("session/request_permission", (params) => {
				approvals += 1;
				permissionRequests.push(params);
				return { outcome: { outcome: "selected", optionId: "allow_once" } };
			});

		// No fs/terminal capabilities: the session must fall back to local tools.
		await client.initialize({ clientName: "steve-local-fallback", clientVersion: "1.0.0", capabilities: {} });
		const session = await client.newSession({ cwd: ROOT });
		await sleep(150);

		const textOfUpdates = (list) =>
			list
				.filter((update) => update.sessionUpdate === "agent_message_chunk")
				.map((update) => update.content?.text ?? "")
				.join("");

		const toolText = () =>
			updates
				.filter((update) => update.sessionUpdate === "tool_call_update")
				.map((update) => (update.content ?? []).map((part) => part.content?.text ?? "").join(""))
				.join("\n");

		check("无 fs/terminal 能力时会话改用本地工具", /tools=.*read_file/.test(serverLog.join("")), serverLog.join("").match(/tools=[^\s]*/)?.[0] ?? "");

		const commands = updates.find((update) => update.sessionUpdate === "available_commands_update")?.availableCommands ?? [];
		check(
			"播报内置命令（tools/stats/model/new）",
			["tools", "stats", "model", "new"].every((name) => commands.some((command) => command.name === name)),
			commands.map((command) => command.name).join(","),
		);

		updates.length = 0;
		await client.prompt(session.sessionId, [{ type: "text", text: "/tools" }]);
		check("内置 /tools 在 ACP 里本地执行", textOfUpdates(updates).includes("read_file"), textOfUpdates(updates).slice(0, 80));

		await client.prompt(session.sessionId, [{ type: "text", text: `read ${join(ROOT, ".env.example")}` }]);
		check("本地 read_file 在 ACP 里可用", toolText().includes("LLM_API_KEY"), toolText().replace(/\n/g, " ").slice(0, 100));

		updates.length = 0;
		await client.prompt(session.sessionId, [{ type: "text", text: "run ls" }]);
		check("本地 run_command 在 ACP 里可用且经权限确认", approvals > 0 && toolText().includes("package.json"), `approvals=${approvals} ${toolText().replace(/\n/g, " ").slice(0, 80)}`);

		updates.length = 0;
		permissionRequests.length = 0;
		const previewPath = join(ROOT, ".steve", "acp-preview.txt");
		await client.prompt(session.sessionId, [{ type: "text", text: `write ${previewPath}` }]);
		const request = permissionRequests.at(-1);
		const diff = request?.toolCall?.content?.find((part) => part.type === "diff");
		check(
			"ACP 审批请求带 diff 预览",
			diff?.path === previewPath && typeof diff?.newText === "string" && String(request?.toolCall?.title).startsWith("create"),
			JSON.stringify(request?.toolCall?.content ?? null).slice(0, 120),
		);
		check("审批通过后本地写入生效", existsSync(previewPath) && readFileSync(previewPath, "utf8").includes("hello from the mock model"));
		rmSync(previewPath, { force: true });

		await client.close();
	} finally {
		server.kill("SIGTERM");
		mock.kill("SIGTERM");
		await sleep(200);
		server.kill("SIGKILL");
		mock.kill("SIGKILL");
	}
}

async function main() {
	process.stderr.write("local tools · in process\n");
	await toolChecks();
	process.stderr.write("\nlocal tools · CLI end to end\n");
	await cliChecks();
	process.stderr.write("\nlocal tools · ACP fallback\n");
	await acpFallbackChecks();

	const failed = checks.filter((entry) => !entry.passed);
	process.stderr.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
	if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
	process.stderr.write(`local tools test failed: ${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
});
