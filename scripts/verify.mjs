#!/usr/bin/env node
/**
 * 一键回归 —— README「约定与规范 / 测试」里那张表的可执行版本。
 *
 *   npm run verify              # 全部（含 headless 浏览器测试）
 *   npm run verify -- --fast    # 跳过浏览器测试（不需要 Chrome）
 *
 * 顺序固定：类型 → 构建 → 架构契约 → UI 同步 → 各能力测试（自带 mock + ACP server）→ 浏览器端到端。
 * 需要外部服务的只有浏览器测试，所以这里统一负责起停（mock 8899 / ACP 8890）。
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MOCK_PORT = 8899;
const ACP_PORT = 8890;
const fast = process.argv.includes("--fast");

const results = [];
const children = [];

function run(label, command, args) {
	const started = Date.now();
	const child = spawnSync(command, args, { cwd: ROOT, encoding: "utf8" });
	const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
	const summary = output.match(/^.*checks passed.*$/m)?.[0]?.trim();
	const ok = child.status === 0;
	results.push({ label, ok, ms: Date.now() - started, summary: summary ?? (ok ? "" : "见下方输出") });
	console.log(`\n── ${label} ${"─".repeat(Math.max(0, 46 - label.length))}`);
	console.log(output.trimEnd() || "(无输出)");
	return ok;
}

/** 起一个后台进程（带 mock 环境变量，绝不落到真实网关）并等它听上端口。 */
async function boot(command, args, env) {
	children.push(spawn(command, args, { cwd: ROOT, stdio: "ignore", env: { ...process.env, ...env } }));
	await new Promise((resolve) => setTimeout(resolve, 1500));
}

function stopAll() {
	for (const child of children) {
		try {
			child.kill("SIGTERM");
		} catch {
			/* 已经退出 */
		}
	}
}

/** 浏览器测试也走离线 mock：覆盖 .env，避免误用真实额度。 */
const mockEnv = {
	LLM_API_KEY: "mock",
	LLM_MODEL_ID: "mock",
	LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/anthropic`,
};

/* ------------------------------------------------------------------ */

run("类型检查", "npm", ["run", "typecheck"]);
run("构建", "npm", ["run", "build"]);
run("架构契约", "node", ["scripts/arch-test.mjs"]);
run("UI 内联客户端同步", "node", ["scripts/sync-ui-client.mjs", "--check"]);
run("本地工具", "node", ["scripts/local-tools-test.mjs"]);
run("插件", "node", ["scripts/plugin-test.mjs"]);
run("会话持久化", "node", ["scripts/session-test.mjs"]);
run("MCP", "node", ["scripts/mcp-test.mjs"]);

if (!fast) {
	console.log(`\n── 启动 mock(${MOCK_PORT}) + ACP(${ACP_PORT}) ${"─".repeat(12)}`);
	await boot(process.execPath, ["scripts/mock-server.mjs"], { MOCK_PORT: String(MOCK_PORT) });
	await boot(process.execPath, ["dist/protocols/acp/main.js", "--port", String(ACP_PORT), "--cors", "*"], mockEnv);
	try {
		const page = fileURLToPath(new URL("../test-acp-jsonrpc.html", import.meta.url));
		run("浏览器端到端（http）", "node", ["scripts/acp-ui-test.mjs", "--url", `http://127.0.0.1:${ACP_PORT}/`]);
		run("浏览器端到端（file://）", "node", ["scripts/acp-ui-test.mjs", "--url", `file://${page}`]);
	} finally {
		stopAll();
	}
}

/* ------------------------------------------------------------------ */

console.log(`\n${"═".repeat(56)}`);
for (const { label, ok, ms, summary } of results) {
	console.log(`${ok ? "✓" : "✗"} ${label.padEnd(24)} ${String(ms).padStart(6)}ms  ${summary}`);
}
const failed = results.filter((result) => !result.ok);
console.log(`${results.length - failed.length}/${results.length} 步通过${fast ? "（--fast：已跳过浏览器测试）" : ""}`);
if (failed.length) {
	console.log(`失败：${failed.map((result) => result.label).join("; ")}`);
	process.exit(1);
}
