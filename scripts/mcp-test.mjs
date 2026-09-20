#!/usr/bin/env node
// Verifies MCP passthrough and session management:
//
//   A. MCP client: connect over stdio, list tools, call them (text, schema,
//      error, image), survive a broken server, close cleanly
//   B. ACP end to end: `session/new` with mcpServers registers the tools
//      (`mcp__mock__echo`), a model-driven call reaches the MCP server, and the
//      tools go through the permission dialog
//   C. session/list + session/delete over ACP
//
//   npm run build && node scripts/mcp-test.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AcpHttpClient } from "../web/acp-http-client.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 8894);
const ACP_PORT = Number(process.env.PLUGIN_TEST_PORT ?? 8892);
const MCP_SCRIPT = join(ROOT, "scripts", "mock-mcp-server.mjs");

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

const stdioServer = (name = "mock") => ({ name, command: process.execPath, args: [MCP_SCRIPT], env: [] });

/* ------------------------------ A. MCP client ---------------------------- */

async function mcpClientChecks() {
	const { connectMcpServers, connectMcpServer } = await import("../dist/features/mcp.js");
	const logs = [];

	const connection = await connectMcpServer(stdioServer(), { logger: (message) => logs.push(message) });
	check(
		"MCP 工具以 mcp__<server>__<tool> 命名",
		connection.tools.map((tool) => tool.name).join(",") === "mcp__mock__echo,mcp__mock__sum,mcp__mock__fail,mcp__mock__image",
		connection.tools.map((tool) => tool.name).join(","),
	);

	const { createToolRegistry } = await import("../dist/features/tool-annotations.js");
	const mcpRegistry = createToolRegistry(connection.tools);
	check(
		"MCP 工具自带权限与标题声明",
		mcpRegistry.permissionRequired().includes("mcp__mock__echo") && mcpRegistry.titleFor("mcp__mock__echo", {}) === "mock: echo",
		`${mcpRegistry.permissionRequired().join(",")} / ${mcpRegistry.titleFor("mcp__mock__echo", {})}`,
	);

	const echo = connection.tools.find((tool) => tool.name === "mcp__mock__echo");
	const echoed = await echo.execute("t", { text: "hi" });
	check("MCP tools/call 返回文本", echoed.content[0]?.text === "echo: hi", JSON.stringify(echoed.content));
	check("MCP inputSchema 被原样用作 parameters", (echo.parameters ?? {}).properties?.text?.type === "string", JSON.stringify(echo.parameters));

	const sum = connection.tools.find((tool) => tool.name === "mcp__mock__sum");
	check("带 schema 的工具可用", (await sum.execute("t", { a: 2, b: 3 })).content[0]?.text === "5");

	const failing = connection.tools.find((tool) => tool.name === "mcp__mock__fail");
	const failure = await failing.execute("t", {}).then(
		() => "",
		(error) => String(error.message),
	);
	check("MCP isError 变成工具错误", failure.includes("always fails"), failure);

	const image = connection.tools.find((tool) => tool.name === "mcp__mock__image");
	check("MCP 图片结果被摘要成文本", (await image.execute("t", {})).content[0]?.text === "[image image/png]");

	await connection.close();
	check("close 结束子进程", logs.some((line) => line.includes("connected, 4 tool(s)")));

	// A server that cannot start must not take the others down.
	const broken = await connectMcpServers(
		[
			{ name: "nope", command: "/definitely/not/a/binary", args: [], env: [] },
			{ name: "http-only", type: "http", url: "http://127.0.0.1:1/mcp", headers: [] },
			stdioServer("second"),
		],
		{ logger: (message) => logs.push(message), timeoutMs: 5_000 },
	);
	check(
		"坏 server 被跳过，好 server 仍然连上",
		broken.connections.length === 1 && broken.connections[0].name === "second" && broken.errors.length === 2,
		broken.errors.join(" | ").slice(0, 120),
	);
	check("非 stdio 传输被明确报告为不支持", broken.errors.some((line) => line.includes("not supported yet")), broken.errors.join(" | ").slice(0, 90));
	check(
		"每个声明的 server 都有状态（含失败与不支持的传输）",
		broken.servers.map((server) => `${server.name}:${server.status}`).join(",") === "nope:failed,http-only:unsupported,second:connected",
		broken.servers.map((server) => `${server.name}:${server.status}`).join(","),
	);
	// A server that dies during the handshake must say *why* (its stderr).
	const dying = await connectMcpServers(
		[
			{
				name: "no-key",
				command: process.execPath,
				args: ["-e", "console.error('MISSING_API_KEY is not set'); process.exit(1)"],
				env: [],
			},
		],
		{ logger: () => {}, timeoutMs: 5_000 },
	);
	check(
		"握手失败时把 server 的 stderr 带进错误",
		(dying.servers[0].error ?? "").includes("MISSING_API_KEY is not set") && dying.servers[0].status === "failed",
		dying.servers[0].error ?? "no error",
	);

	// Slow starters (npx -y downloads on first run) need a per-server timeout.
	const slow = (timeoutMs) =>
		connectMcpServers(
			[{ name: "slow", command: process.execPath, args: [MCP_SCRIPT], env: [{ name: "SLOW_INIT_MS", value: "700" }], timeoutMs }],
			{ logger: () => {}, timeoutMs: 200 },
		);
	const timedOut = await slow(200);
	check("超时会报错而不是挂死", timedOut.servers[0].status === "failed" && /timed out/.test(timedOut.servers[0].error ?? ""), timedOut.servers[0].error ?? "");
	await Promise.all(timedOut.connections.map((entry) => entry.close()));
	const patient = await slow(3_000);
	check("每个 server 可以单独放宽超时", patient.servers[0].status === "connected", patient.servers[0].error ?? patient.servers[0].tools.join(","));
	await Promise.all(patient.connections.map((entry) => entry.close()));

	check(
		"状态里带来源、命令行与远端工具名",
		broken.servers[0].source === "plugin" &&
			broken.servers[2].transport === "stdio" &&
			broken.servers[2].tools.join(",") === "echo,sum,fail,image" &&
			(broken.servers[0].error ?? "").includes("ENOENT"),
		JSON.stringify(broken.servers[2]).slice(0, 110),
	);
	await Promise.all(broken.connections.map((entry) => entry.close()));

	// A plugin-contributed MCP server: the host collects it, the core connects it.
	const { loadExtensions } = await import("../dist/extensions/host.js");
	const pluginDir = mkdtempSync(join(tmpdir(), "steve-mcp-plugin-"));
	const pluginFile = join(pluginDir, "with-mcp.mjs");
	writeFileSync(
		pluginFile,
		[
			"export default function (pi) {",
			`\tpi.registerMcpServer({ name: "fromplugin", command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(MCP_SCRIPT)}] });`,
			"}",
		].join("\n"),
	);
	const host = await loadExtensions({ cwd: ROOT, mode: "cli", paths: [pluginFile], builtins: false, discover: false, log: () => {} });
	const pluginMcp = await connectMcpServers(host.mcpServers, { logger: () => {} });
	check(
		"插件注册的 MCP server 被核心连上",
		pluginMcp.tools.some((tool) => tool.name === "mcp__fromplugin__echo"),
		pluginMcp.tools.map((tool) => tool.name).join(","),
	);
	check(
		"插件声明的 server 在状态里标为 plugin",
		pluginMcp.servers.length === 1 && pluginMcp.servers[0].source === "plugin" && pluginMcp.servers[0].status === "connected",
		JSON.stringify(pluginMcp.servers ?? null),
	);
	await Promise.all(pluginMcp.connections.map((entry) => entry.close()));
	rmSync(pluginDir, { recursive: true, force: true });
}

/* ------------------------------ B. ACP + MCP ----------------------------- */

async function acpChecks() {
	const sessionDir = mkdtempSync(join(tmpdir(), "steve-mcp-"));
	const mock = spawn(process.execPath, ["scripts/mock-server.mjs"], {
		cwd: ROOT,
		env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
		stdio: ["ignore", "pipe", "pipe"],
	});

	const serverLog = [];
	const server = spawn(
		process.execPath,
		["dist/protocols/acp/main.js", "--port", String(ACP_PORT), "--cors", "*", "--session-dir", sessionDir],
		{
			cwd: ROOT,
			env: { ...process.env, STEVE_DISCOVERY: "off",
					LLM_API_KEY: "mock", LLM_MODEL_ID: "mock", LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/anthropic` },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	server.stderr.on("data", (chunk) => serverLog.push(String(chunk)));

	try {
		await waitForPort(MOCK_PORT);
		await waitForPort(ACP_PORT);

		const updates = [];
		const announced = [];
		const permissions = [];
		const client = new AcpHttpClient(`http://127.0.0.1:${ACP_PORT}/acp`, {});
		client
			.onMessage((event) => {
				if (event.message?.method === "session/update") {
					const update = event.message.params.update;
					updates.push(update);
					if (update.sessionUpdate === "available_commands_update") announced.push(...(update.availableCommands ?? []).map((command) => command.name));
				}
			})
			.on("session/request_permission", (params) => {
				permissions.push(params.toolCall?.title ?? "");
				return { outcome: { outcome: "selected", optionId: "allow_once" } };
			});

		const initialized = await client.initialize({ clientName: "steve-mcp-test", clientVersion: "1.0.0", capabilities: {} });
		check(
			"initialize 声明 session/list 与 delete 能力",
			Boolean(initialized.agentCapabilities?.sessionCapabilities?.list) && Boolean(initialized.agentCapabilities?.sessionCapabilities?.delete),
			JSON.stringify(initialized.agentCapabilities?.sessionCapabilities ?? {}),
		);

		const session = await client.newSession({ cwd: ROOT, mcpServers: [stdioServer()] });
		await sleep(150);
		check(
			"MCP 工具进入会话工具表",
			/mcp__mock__echo/.test(serverLog.join("")) && serverLog.join("").includes("[mcp mock] connected"),
			serverLog.join("").match(/tools=[^\s]*/)?.[0]?.slice(0, 120) ?? "",
		);

		// The mock gateway plans a call to mcp__mock__echo for prompts with "mcp-echo".
		updates.length = 0;
		permissions.length = 0;
		await client.prompt(session.sessionId, [{ type: "text", text: "please mcp-echo now" }]);
		const toolText = updates
			.filter((update) => update.sessionUpdate === "tool_call_update")
			.map((update) => (update.content ?? []).map((part) => part.content?.text ?? "").join(""))
			.join("\n");
		check("模型调用 MCP 工具并拿到结果", toolText.includes("echo: hello from the gateway"), toolText.replace(/\n/g, " ").slice(0, 100));
		check("MCP 工具走权限确认", permissions.some((title) => title.includes("mcp__mock__echo")), permissions.join(" | ").slice(0, 90));

		// `/mcp` is a plugin command, so it also has to work through the editor.
		const mcpText = () =>
			updates
				.filter((update) => update.sessionUpdate === "agent_message_chunk")
				.map((update) => update.content?.text ?? "")
				.join("");
		updates.length = 0;
		await client.prompt(session.sessionId, [{ type: "text", text: "/mcp" }]);
		check(
			"ACP 里 /mcp 列出客户端声明的 server",
			mcpText().includes("mock [client] stdio") && mcpText().includes("4 tool(s): echo, sum, fail, image"),
			mcpText().replace(/\n/g, " | ").slice(0, 140),
		);
		check("命令列表里播报了 /mcp", announced.includes("mcp"), announced.join(","));

		// C. session/list + session/delete
		const listed = await client.request("session/list", { cwd: ROOT });
		check(
			"session/list 列出当前会话",
			Array.isArray(listed?.sessions) && listed.sessions.some((entry) => entry.sessionId === session.sessionId && entry.cwd === ROOT),
			JSON.stringify(listed?.sessions ?? []).slice(0, 110),
		);

		const otherCwd = await client.request("session/list", { cwd: "/nonexistent-cwd" });
		check("session/list 按 cwd 过滤", Array.isArray(otherCwd?.sessions) && otherCwd.sessions.length === 0);

		const file = join(sessionDir, `${session.sessionId}.json`);
		await client.request("session/delete", { sessionId: session.sessionId });
		await sleep(100);
		const afterDelete = await client.request("session/list", {});
		check(
			"session/delete 删掉会话与文件",
			!existsSync(file) && !(afterDelete?.sessions ?? []).some((entry) => entry.sessionId === session.sessionId),
			`file=${existsSync(file)}`,
		);
		check("session/delete 幂等（未知 id 不报错）", (await client.request("session/delete", { sessionId: "nope" })) !== undefined);

		await client.close();
	} finally {
		server.kill("SIGTERM");
		mock.kill("SIGTERM");
		await sleep(200);
		server.kill("SIGKILL");
		mock.kill("SIGKILL");
		rmSync(sessionDir, { recursive: true, force: true });
	}
}

/** The CLI has no ACP client to hand it servers, so plugin-contributed MCP is its only path. */
async function cliChecks() {
	const mock = spawn(process.execPath, ["scripts/mock-server.mjs"], {
		cwd: ROOT,
		env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const dir = mkdtempSync(join(tmpdir(), "steve-mcp-cli-"));
	const pluginFile = join(dir, "with-mcp.mjs");
	writeFileSync(
		pluginFile,
		[
			"export default function (pi) {",
			`\tpi.registerMcpServer({ name: "climcp", command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(MCP_SCRIPT)}] });`,
			"}",
		].join("\n"),
	);

	try {
		await waitForPort(MOCK_PORT);
		const output = await new Promise((resolve) => {
			const child = spawn(process.execPath, [join(ROOT, "dist/entries/cli.js"), "--read-only"], {
				cwd: ROOT,
				env: {
					...process.env,
					NO_COLOR: "1",
					STEVE_DISCOVERY: "off",
					LLM_API_KEY: "mock",
					LLM_MODEL_ID: "mock",
					LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/anthropic`,
					STEVE_EXTENSIONS: pluginFile,
				},
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "";
			child.stdout.on("data", (chunk) => (stdout += chunk));
			setTimeout(() => child.stdin.write("/mcp\n"), 900);
			setTimeout(() => child.stdin.write("/exit\n"), 1_400);
			child.on("exit", () => resolve(stdout));
		});
		check("CLI 也能用插件里的 MCP 工具", /tools\s+.*mcp__climcp__echo/.test(output), output.split("\n").find((line) => line.includes("tools")) ?? "");
		check(
			"CLI 的 /mcp 列出插件声明的 server 与工具",
			output.includes("climcp [plugin] stdio") && output.includes("4 tool(s): echo, sum, fail, image"),
			output.split("\n").find((line) => line.includes("climcp")) ?? "",
		);
	} finally {
		mock.kill("SIGTERM");
		await sleep(200);
		mock.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
}

async function main() {
	process.stderr.write("mcp · client\n");
	await mcpClientChecks();
	process.stderr.write("\nmcp · CLI\n");
	await cliChecks();
	process.stderr.write("\nmcp · ACP end to end\n");
	await acpChecks();

	const failed = checks.filter((entry) => !entry.passed);
	process.stderr.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
	if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
	process.stderr.write(`mcp test failed: ${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
});
