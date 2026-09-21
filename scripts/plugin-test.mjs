#!/usr/bin/env node
// Verifies the extension layer end to end.
//
//   A. host (in-process, against dist): discovery, loading, hook chains, isolation
//   B. ACP (spawned server + real client): plugins reach an editor — commands are
//      announced, `/command` runs locally, a blocking `tool_call` hook stops a
//      dangerous call before the editor is even asked, and the plugin tool lands
//      in the session's tool list.
//
//   npm run build && node scripts/plugin-test.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AcpHttpClient } from "../web/acp-http-client.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const scratchHome = mkdtempSync(join(tmpdir(), "steve-home-")); // isolate ~/.steve for spawned agents
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 8898);
const ACP_PORT = Number(process.env.PLUGIN_TEST_PORT ?? 8893);

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

/* ------------------------- A. host, in process --------------------------- */

async function hostChecks() {
	const { loadExtensions, discoverExtensionFiles } = await import("../dist/extensions/host.js");

	const temp = mkdtempSync(join(tmpdir(), "steve-plugins-"));
	mkdirSync(join(temp, ".steve", "extensions"), { recursive: true });
	writeFileSync(join(temp, ".steve", "extensions", "local.mjs"), "export default () => {};\n");
	writeFileSync(join(temp, "broken-factory.mjs"), 'export default () => { throw new Error("boom in factory"); };\n');
	writeFileSync(
		join(temp, "broken-hook.mjs"),
		[
			"export default function (pi) {",
			'\tpi.on("tool_call", () => { throw new Error("boom in hook"); });',
			'\tpi.on("context", () => { throw new Error("boom in context"); });',
			"}",
		].join("\n"),
	);
	writeFileSync(
		join(temp, "declares-everything.mjs"),
		[
			"export default function (pi) {",
			"\tpi.registerTool({",
			'\t\tname: "risky",',
			'\t\tdescription: "A tool that needs approval and custom presentation.",',
			"\t\tparameters: { type: \"object\", properties: {} },",
			'\t\tpermission: "ask",',
			'\t\tmetadata: { kind: "execute", title: "Risky thing" },',
			'\t\tdescribe: (args) => ({ summary: `risky ${args?.what ?? "?"}` }),',
			'\t\texecute: async () => ({ content: [{ type: "text", text: "ok" }] }),',
			"\t});",
			`\tpi.registerMcpServer({ name: "fixture", command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(join(ROOT, "scripts", "mock-mcp-server.mjs"))}] });`,
			"}",
		].join("\n"),
	);
	writeFileSync(
		join(temp, "filter-context.mjs"),
		[
			"export default function (pi) {",
			'\tpi.on("context", (messages) => messages.filter((message) => !JSON.stringify(message).includes("secret")));',
			'\tpi.registerCommand({ name: "ping", description: "Ping.", run: () => "pong" });',
			"}",
		].join("\n"),
	);

	// Discovery also looks at ~/.steve/extensions, so pin HOME to a scratch dir:
	// the developer's own global plugins must not change the result.
	const withHome = (fn) => {
		const previous = process.env.HOME;
		process.env.HOME = scratchHome;
		try {
			return fn();
		} finally {
			if (previous === undefined) delete process.env.HOME;
			else process.env.HOME = previous;
		}
	};
	check("项目本地 .steve/extensions 会被发现", withHome(() => discoverExtensionFiles({ cwd: temp }).length) === 1);
	check("discover: false 时跳过目录发现", withHome(() => discoverExtensionFiles({ cwd: temp, discover: false }).length) === 0);
	const globalPluginDir = join(scratchHome, ".steve", "extensions");
	mkdirSync(globalPluginDir, { recursive: true });
	writeFileSync(join(globalPluginDir, "global.mjs"), "export default function () {}\n");
	check(
		"全局 ~/.steve/extensions 也会被发现",
		withHome(() => discoverExtensionFiles({ cwd: mkdtempSync(join(tmpdir(), "steve-empty-")) }).length) === 1,
	);

	const logs = [];
	const host = await loadExtensions({
		cwd: ROOT,
		mode: "cli",
		paths: ["examples/extensions", temp],
		discover: false, // the repo's own .steve/extensions must not affect this run
		log: (message) => logs.push(message),
	});

	const examples = ["guard-destructive.mjs", "git-status.mjs", "turn-logger.mjs", "mcp-server.mjs"];
	check(
		"示例插件全部加载",
		examples.every((name) => host.files.some((file) => file.endsWith(name))) && host.errors.length === 1,
		`files=${host.files.length} errors=${host.errors.length}`
	);
	check("加载期抛错的插件被隔离", host.errors[0]?.message.includes("boom in factory") === true, host.errors[0]?.message ?? "no error");
	check(
		"注册的工具与命令可见",
		host.tools.some((tool) => tool.name === "git_status") && host.commands.some((command) => command.name === "git-status"),
		`tools=${host.tools.map((tool) => tool.name).join(",")}`,
	);

	const blocked = await host.runToolCall({ toolName: "run_command", toolCallId: "1", args: { command: "rm", args: ["-rf", "/"] } });
	check("tool_call 钩子拦截危险命令", blocked?.block === true && String(blocked.reason).includes("guard-destructive"), JSON.stringify(blocked ?? null));
	check(
		"tool_call 钩子放行普通命令",
		(await host.runToolCall({ toolName: "run_command", toolCallId: "2", args: { command: "ls", args: ["-la"] } })) === undefined,
	);
	check("钩子抛错不会中断调用链", (await host.runToolCall({ toolName: "write_file", toolCallId: "3", args: {} })) === undefined);

	const messages = [
		{ role: "user", content: [{ type: "text", text: "secret" }] },
		{ role: "user", content: [{ type: "text", text: "keep" }] },
	];
	check("context 钩子能改写消息", (await host.runContext(messages)).length === 1);

	const headers = {};
	host.runHeaders(headers, { model: "mock", api: "anthropic-messages" });
	check("before_provider_headers 能改请求头", headers["x-steve-plugin"] === "turn-logger", JSON.stringify(headers));

	check(
		"插件可声明 permission=ask（核心闸门据此询问）",
		host.permissionRequired().includes("risky"),
		host.permissionRequired().join(","),
	);
	check(
		"插件可声明呈现元数据（协议层据此渲染）",
		host.metadataFor("risky")?.kind === "execute" && host.metadataFor("risky")?.title === "Risky thing",
		JSON.stringify(host.metadataFor("risky") ?? null),
	);
	const riskyTool = host.tools.find((tool) => tool.name === "risky");
	const riskyPreview = await riskyTool?.describe?.({ what: "thing" });
	check(
		"插件可给自己的工具提供审批预览",
		riskyPreview?.summary === "risky thing",
		JSON.stringify(riskyPreview ?? null),
	);
	check(
		"插件可注册 MCP server（由核心连接）",
		host.mcpServers.some((server) => server.name === "fixture" && server.args?.length === 1),
		JSON.stringify(host.mcpServers),
	);

	check("插件命令可执行", (await host.runCommand("ping", "")) === "pong");
	check("未注册的命令返回 undefined", (await host.runCommand("nope", "")) === undefined);

	host.dispatch({
		type: "turn_end",
		stopReason: "stop",
		usage: { input: 11, output: 7, total: 18, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
		contextTokens: 18,
		failed: false,
		retries: 0,
	});
	await sleep(20);
	check("运行期事件派发到插件", logs.some((line) => line.includes("turn stop")), logs.slice(-3).join(" | "));

	rmSync(temp, { recursive: true, force: true });
	return { logs };
}

/* --------------------------- B. ACP, end to end -------------------------- */

async function acpChecks() {
	const mock = spawn(process.execPath, ["scripts/mock-server.mjs"], {
		cwd: ROOT,
		env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
		stdio: ["ignore", "pipe", "pipe"],
	});

	const serverLog = [];
	const server = spawn(
		process.execPath,
		[
			"dist/protocols/acp/main.js",
			"--port",
			String(ACP_PORT),
			"--cors",
			"*",
			"--extension",
			"examples/extensions/git-status.mjs",
			"--extension",
			"examples/extensions/guard-destructive.mjs",
		],
		{
			cwd: ROOT,
			env: {
				...process.env,
					STEVE_DISCOVERY: "off",
					HOME: scratchHome,
					LLM_API_KEY: "mock",
				LLM_MODEL_ID: "mock",
				LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/anthropic`,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	server.stderr.on("data", (chunk) => serverLog.push(String(chunk)));

	try {
		await waitForPort(MOCK_PORT);
		await waitForPort(ACP_PORT);

		const updates = [];
		const terminals = new Map();
		let permissionsAsked = 0;

		const client = new AcpHttpClient(`http://127.0.0.1:${ACP_PORT}/acp`, {});
		client
			// Notifications only reach `onMessage` listeners; `on` is for server requests.
			.onMessage((event) => {
				if (event.message?.method === "session/update") updates.push(event.message.params.update);
			})
			.on("session/request_permission", () => {
				permissionsAsked += 1;
				return { outcome: { outcome: "selected", optionId: "allow_once" } };
			})
			.on("fs/read_text_file", async (params) => ({ content: await (await import("node:fs/promises")).readFile(params.path, "utf8") }))
			.on("fs/write_text_file", () => ({}))
			.on("terminal/create", (params) => {
				const terminalId = `plugin-test-${terminals.size + 1}`;
				const child = spawn(params.command, params.args ?? [], { cwd: params.cwd ?? ROOT, stdio: ["ignore", "pipe", "pipe"] });
				const record = { child, output: "", exitCode: null, signal: null, exit: Promise.resolve() };
				child.stdout.on("data", (chunk) => (record.output += chunk));
				child.stderr.on("data", (chunk) => (record.output += chunk));
				record.exit = new Promise((resolve) =>
					child.on("exit", (code, signal) => {
						record.exitCode = code;
						record.signal = signal;
						resolve();
					}),
				);
				terminals.set(terminalId, record);
				return { terminalId };
			})
			.on("terminal/output", (params) => ({ output: terminals.get(params.terminalId)?.output ?? "", truncated: false }))
			.on("terminal/wait_for_exit", async (params) => {
				const record = terminals.get(params.terminalId);
				await record?.exit;
				return { exitCode: record?.exitCode ?? null, signal: record?.signal ?? null };
			})
			.on("terminal/kill", () => ({}))
			.on("terminal/release", (params) => {
				terminals.get(params.terminalId)?.child.kill("SIGTERM");
				terminals.delete(params.terminalId);
				return {};
			});

		await client.initialize({
			clientName: "steve-plugin-test",
			clientVersion: "1.0.0",
			capabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
		});
		const session = await client.newSession({ cwd: ROOT });
		await sleep(150);

		const textOf = () =>
			updates
				.filter((update) => update.sessionUpdate === "agent_message_chunk")
				.map((update) => update.content?.text ?? "")
				.join("");

		check(
			"session/new 后播报插件命令",
			updates.some(
				(update) => update.sessionUpdate === "available_commands_update" && update.availableCommands?.some((command) => command.name === "git-status"),
			),
			JSON.stringify(updates.map((update) => update.sessionUpdate)),
		);
		check("插件工具进入会话工具列表", serverLog.join("").includes("git_status"), serverLog.join("").slice(-160));

		updates.length = 0;
		await client.prompt(session.sessionId, [{ type: "text", text: "/git-status" }]);
		check("/git-status 由插件本地执行", textOf().includes("## "), textOf().slice(0, 90).replace(/\n/g, " "));

		updates.length = 0;
		permissionsAsked = 0;
		await client.prompt(session.sessionId, [{ type: "text", text: "run rm -rf /tmp/steve-demo" }]);
		const failedTool = updates.filter((update) => update.sessionUpdate === "tool_call_update" && update.status === "failed");
		check(
			"插件在权限询问前拦下危险命令",
			permissionsAsked === 0 && failedTool.length > 0 && JSON.stringify(failedTool).includes("guard-destructive"),
			`permissions=${permissionsAsked} failed=${failedTool.length}`,
		);

		updates.length = 0;
		const reply = await client.prompt(session.sessionId, [{ type: "text", text: "hello there" }]);
		check("普通提问仍走模型", reply.stopReason === "end_turn" && textOf().includes("pi-agent-core"), textOf().slice(0, 60));

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
	process.stderr.write("extensions · host\n");
	await hostChecks();
	process.stderr.write("\nextensions · ACP end to end\n");
	await acpChecks();

	const failed = checks.filter((entry) => !entry.passed);
	process.stderr.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
	if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
	process.stderr.write(`plugin test failed: ${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
});
