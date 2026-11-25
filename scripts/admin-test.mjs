#!/usr/bin/env node
/**
 * Admin console acceptance test: the page, the JSON API and the files it owns.
 *
 * Everything runs offline: `scripts/mock-server.mjs` is the model, the console
 * writes into a temp workspace (`.steve/admin.json`, `.steve/.env`,
 * `.steve/watch.json`) and the restart endpoint is checked by observing the
 * process exit code a supervisor would act on.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStreamLog } from "../dist/features/stream-log.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

const MOCK_PORT = 8951;
const SERVE_PORT = 8952;
const TOKEN = "admin-test-token";
const RAW_KEY = "sk-admin-test-1234567890";

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

const auth = { authorization: `Bearer ${TOKEN}` };

async function request(method, path, { body, headers = auth, port = SERVE_PORT } = {}) {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, {
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

const workspace = mkdtempSync(join(tmpdir(), "steve-admin-"));
mkdirSync(join(workspace, ".steve"), { recursive: true });
const adminFile = join(workspace, ".steve", "admin.json");
const envFile = join(workspace, ".steve", ".env");
const watchFile = join(workspace, ".steve", "watch.json");

const mock = start("mock", process.execPath, [join(ROOT, "scripts", "mock-server.mjs")], {
	cwd: ROOT,
	env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
	stdio: ["ignore", "pipe", "pipe"],
});
const serve = start("serve", process.execPath, [join(ROOT, "dist", "entries", "serve.js"), "--port", String(SERVE_PORT), "--token", TOKEN, "--no-watch"], {
	cwd: workspace,
	env: {
		...process.env,
		HOME: workspace,
		STEVE_DISCOVERY: "off",
		LLM_API_KEY: "mock",
		LLM_MODEL_ID: "mock-model",
		LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/anthropic`,
		FEISHU_APP_ID: "cli_admin_test",
		FEISHU_APP_SECRET: "feishu-secret-1234",
		FEISHU_VERIFICATION_TOKEN: "feishu-verify-1234",
	},
	stdio: ["ignore", "pipe", "pipe"],
});

try {
	await waitFor(() => serve.stderr.includes("listening on"), { label: "serve boot" });

	/* ---------------------------------------------------------------- */
	/* A. 页面与鉴权                                                     */
	/* ---------------------------------------------------------------- */
	const page = await request("GET", "/admin", { headers: {} });
	check("GET /admin 不需要 token", page.status === 200, `status ${page.status}`);
	check("GET /admin 返回 HTML 页面", String(page.headers.get("content-type")).includes("text/html"));
	check("页面包含管理后台标记", typeof page.body === "string" && page.body.includes("Steve 管理后台"));

	const unauthorized = await request("GET", "/admin/api/overview", { headers: {} });
	check("管理 API 缺少 token 返回 401", unauthorized.status === 401, `status ${unauthorized.status}`);

	const overview = await request("GET", "/admin/api/overview");
	check("概览返回版本号", overview.status === 200 && overview.body.version === VERSION, describe(overview.body));
	check("概览返回运行时间与进程信息", typeof overview.body.uptimeMs === "number" && overview.body.uptimeMs >= 0 && typeof overview.body.pid === "number");
	check("概览反映 watch 关闭", overview.body.watchEnabled === false);
	check("概览初始无供应商", overview.body.providerCount === 0 && overview.body.activeProvider === null);

	/* ---------------------------------------------------------------- */
	/* B. 模型供应商                                                     */
	/* ---------------------------------------------------------------- */
	const emptyProviders = await request("GET", "/admin/api/providers");
	check("供应商列表初始为空", emptyProviders.status === 200 && emptyProviders.body.providers.length === 0);

	const saved = await request("POST", "/admin/api/providers/save", {
		body: {
			provider: {
				name: "Test Provider",
				baseUrl: "https://api.example.com/v1",
				apiKey: RAW_KEY,
				defaultModel: "test-model",
				models: ["test-model", "test-model-2"],
				reasoning: true,
			},
		},
	});
	check("新增供应商成功并要求重启", saved.status === 200 && saved.body.restartRequired === true, describe(saved.body));
	check("新增响应不包含明文 apiKey", saved.body.provider.apiKeyMasked !== RAW_KEY && String(saved.body.provider.apiKeyMasked).endsWith("7890"));

	const listed = await request("GET", "/admin/api/providers");
	const first = listed.body.providers[0];
	check("供应商列表包含新增项", listed.body.providers.length === 1 && first.name === "Test Provider" && first.models.length === 2);
	check("供应商默认未激活", first.active === false && first.hasApiKey === true);

	const activated = await request("POST", "/admin/api/providers/activate", { body: { id: first.id } });
	check("激活供应商成功", activated.status === 200 && activated.body.activeProviderId === first.id);
	const afterActivate = await request("GET", "/admin/api/providers");
	check("激活标记出现在列表", afterActivate.body.providers[0].active === true);
	const activeOverview = await request("GET", "/admin/api/overview");
	check("概览显示激活供应商", activeOverview.body.activeProvider === "Test Provider");

	const persisted = JSON.parse(readFileSync(adminFile, "utf8"));
	check("admin.json 持久化供应商与激活项", persisted.providers.length === 1 && persisted.providers[0].apiKey === RAW_KEY && persisted.activeProviderId === first.id);

	const edited = await request("POST", "/admin/api/providers/save", {
		body: {
			provider: {
				id: first.id,
				name: "Test Provider Renamed",
				baseUrl: "https://api.example.com/v1",
				apiKey: "",
				defaultModel: "test-model",
				models: ["test-model"],
				reasoning: false,
			},
		},
	});
	check("编辑供应商成功", edited.status === 200 && edited.body.provider.name === "Test Provider Renamed");
	const afterEdit = JSON.parse(readFileSync(adminFile, "utf8"));
	check("编辑留空 apiKey 时保留原值", afterEdit.providers[0].apiKey === RAW_KEY);

	const deletedUnknown = await request("POST", "/admin/api/providers/delete", { body: { id: "nope" } });
	check("删除未知供应商返回 404", deletedUnknown.status === 404);
	const deleted = await request("POST", "/admin/api/providers/delete", { body: { id: first.id } });
	check("删除供应商成功", deleted.status === 200 && deleted.body.restartRequired === true);
	const afterDelete = await request("GET", "/admin/api/providers");
	check("删除后供应商列表为空且无激活项", afterDelete.body.providers.length === 0 && afterDelete.body.activeProviderId === null);

	/* ---------------------------------------------------------------- */
	/* C. 网关（飞书）                                                   */
	/* ---------------------------------------------------------------- */
	const gateways = await request("GET", "/admin/api/gateways");
	check("网关显示飞书已配置", gateways.status === 200 && gateways.body.feishu.configured === true && gateways.body.feishu.hasSecret === true);
	check("网关 App ID 已掩码", String(gateways.body.feishu.appIdMasked).startsWith("****"));
	check("网关仅飞书可用，其它为规划中", gateways.body.available.includes("feishu") && gateways.body.planned.includes("wecom"));

	const gatewaySaved = await request("POST", "/admin/api/gateways/save", {
		body: { feishu: { appSecret: "new-secret-5678", encryptKey: "enc-key-9999", apiBase: "http://127.0.0.1:8951" } },
	});
	check("保存网关配置成功并要求重启", gatewaySaved.status === 200 && gatewaySaved.body.restartRequired === true);
	const envText = readFileSync(envFile, "utf8");
	check(".steve/.env 写入新的 secret", envText.includes('FEISHU_APP_SECRET="new-secret-5678"') || envText.includes("FEISHU_APP_SECRET=new-secret-5678"));
	check(".steve/.env 写入 encryptKey 与 apiBase", /FEISHU_ENCRYPT_KEY=/.test(envText) && /FEISHU_API_BASE=/.test(envText));
	check(".steve/.env 保留未修改的 App ID 不在文件里（留空=保持不变）", !envText.includes("FEISHU_APP_ID"));

	/* ---------------------------------------------------------------- */
	/* D. 定时任务                                                       */
	/* ---------------------------------------------------------------- */
	const emptySchedules = await request("GET", "/admin/api/schedules");
	check("定时任务列表初始为空", emptySchedules.status === 200 && emptySchedules.body.schedules.length === 0);

	const scheduleSaved = await request("POST", "/admin/api/schedules/save", {
		body: {
			name: "daily-report",
			cron: "0 9 * * 1",
			timezone: "Asia/Shanghai",
			prompt: "整理上周的会议纪要",
			targetStream: "schedule-target",
			mode: "background",
		},
	});
	check("新增定时任务成功并要求重启", scheduleSaved.status === 200 && scheduleSaved.body.restartRequired === true);
	const watch = JSON.parse(readFileSync(watchFile, "utf8"));
	check("watch.json 写入 cron 触发器", watch.triggers["daily-report"].kind === "cron" && watch.triggers["daily-report"].cron === "0 9 * * 1");
	const listedSchedules = await request("GET", "/admin/api/schedules");
	check("定时任务列表返回字段完整", listedSchedules.body.schedules.length === 1 && listedSchedules.body.schedules[0].prompt === "整理上周的会议纪要" && listedSchedules.body.schedules[0].mode === "background");

	const badCron = await request("POST", "/admin/api/schedules/save", { body: { name: "bad", cron: "99 9 * * *", prompt: "x", targetStream: "t1" } });
	check("非法 cron 返回 400", badCron.status === 400);
	const badStream = await request("POST", "/admin/api/schedules/save", { body: { name: "bad", cron: "0 9 * * 1", prompt: "x", targetStream: "../evil" } });
	check("非法目标流返回 400", badStream.status === 400);

	const ran = await request("POST", "/admin/api/schedules/run", { body: { name: "daily-report" } });
	check("立即运行定时任务返回 runId", ran.status === 202 && typeof ran.body.runId === "string", describe(ran.body));
	const streamLog = createStreamLog({ dir: join(workspace, ".steve", "streams") });
	const raced = await waitFor(
		async () => {
			const events = await streamLog.read("schedule-target");
			return events.some((event) => event.type === "run.settled") ? events : undefined;
		},
		{ label: "scheduled background run" },
	);
	check("定时任务产生后台 run", raced.some((event) => event.type === "run.started" && event.mode === "background"));
	check("定时任务投递了提示词", raced.some((event) => event.type === "user.message" && event.text === "整理上周的会议纪要"));
	streamLog.close();

	const scheduleDeleted = await request("POST", "/admin/api/schedules/delete", { body: { name: "daily-report" } });
	check("删除定时任务成功", scheduleDeleted.status === 200);
	const watchAfterDelete = JSON.parse(readFileSync(watchFile, "utf8"));
	check("watch.json 中的触发器已移除", watchAfterDelete.triggers["daily-report"] === undefined);

	/* ---------------------------------------------------------------- */
	/* E. 系统：信息 / 日志 / 文件 / 重启                                 */
	/* ---------------------------------------------------------------- */
	const system = await request("GET", "/admin/api/system");
	check("系统信息返回版本与日志级别", system.status === 200 && system.body.version === VERSION && system.body.logLevel === "info");
	check("系统信息列出配置文件", Array.isArray(system.body.files) && system.body.files.some((file) => file.path === ".steve/admin.json" && file.exists === true));

	const logsaved = await request("POST", "/admin/api/system/save", { body: { logLevel: "debug" } });
	check("保存日志级别成功", logsaved.status === 200 && logsaved.body.logLevel === "debug");
	const systemAfter = await request("GET", "/admin/api/system");
	check("日志级别已生效", systemAfter.body.logLevel === "debug");
	const adminAfter = JSON.parse(readFileSync(adminFile, "utf8"));
	check("日志级别持久化到 admin.json", adminAfter.logLevel === "debug");

	const maskedFile = await request("GET", "/admin/api/files?path=.steve%2F.env&reveal=0");
	check("文件查看默认掩码", maskedFile.status === 200 && maskedFile.body.masked === true && String(maskedFile.body.content).includes("****5678"), describe(maskedFile.body));
	check("掩码内容不含明文 secret", !String(maskedFile.body.content).includes("new-secret-5678"));
	const revealed = await request("GET", "/admin/api/files?path=.steve%2F.env&reveal=1");
	check("显式 reveal=1 返回原文", revealed.body.masked === false && String(revealed.body.content).includes("new-secret-5678"));
	const badFile = await request("GET", "/admin/api/files?path=..%2F..%2Fetc%2Fpasswd");
	check("文件查看拒绝白名单外路径", badFile.status === 400);
	const unknownApi = await request("GET", "/admin/api/nope");
	check("未知管理 API 返回 404", unknownApi.status === 404);

	check("重启前服务仍在运行", !serve.exited);
	const restarted = await request("POST", "/admin/api/system/restart");
	check("重启接口返回 202", restarted.status === 202 && restarted.body.restarting === true);
	const exited = await waitFor(() => (serve.exited ? true : undefined), { timeout: 6000, label: "restart exit" });
	check("重启接口让进程以 75 退出（交给 supervisor）", exited && serve.code === 75, `code ${serve.code}`);
} catch (error) {
	check("测试执行未抛异常", false, describe(error));
} finally {
	await stop(serve.child);
	await stop(mock.child);
	if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
}

process.stdout.write(`\n${checks - failures.length}/${checks} checks passed\n`);
if (failures.length > 0) {
	process.stdout.write(`failed: ${failures.join(", ")}\n`);
	process.exit(1);
}
