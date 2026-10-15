#!/usr/bin/env node
/**
 * 架构契约 + 发布卫生检查 —— README「约定与规范」的可执行版本。
 *
 * 这些规则平时靠人盯，容易在某次重构里悄悄破掉（比如协议层顺手 import 了 pi 的类型）。
 * 这里把它们全部机检：
 *
 *   1. 五层依赖方向（只允许上层依赖下层；两条明确列出的横向例外）
 *   2. 协议层 / 入口层零 pi 依赖；ACP SDK 只出现在协议层
 *   3. 只有 kernel/agent.ts 能装配 pi 的 Agent
 *   4. 运行时依赖白名单（ws 只能 optional）
 *   5. 发布卫生：.env 不入库、公开文件里没有内网域名/凭据/真实模型 id/个人 home 路径
 *
 *   node scripts/arch-test.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");

/* ------------------------------------------------------------------ */
/* 断言                                                                */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures = [];
function check(name, ok, detail) {
	if (ok) {
		passed += 1;
		console.log(`  ✓ ${name}`);
		return;
	}
	failures.push(name);
	console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

/* ------------------------------------------------------------------ */
/* 层表（数字越小越底层）                                               */
/* ------------------------------------------------------------------ */

const LAYERS = {
	model: 0,
	kernel: 1,
	features: 2,
	extensions: 2, // 与功能层同层，是它的「插件侧」
	protocols: 3,
	entries: 4,
};
/** src/types.ts 是跨层共享类型，必须零依赖。 */
const SHARED = new Set(["types.ts"]);

/** 功能层 → 拓展层：只允许 runtime.ts 这一条，且必须是 `import type`。 */
const LATERAL_TO_EXTENSIONS = "features/runtime.ts";
/** 拓展层 → 功能层：只允许这几个契约文件（工具契约 / 事件词表 / 工具声明）。 */
const CONTRACTS_FOR_EXTENSIONS = new Set(["contract.ts", "events.ts", "tool-annotations.ts"]);

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else if (entry.endsWith(".ts")) out.push(full);
	}
	return out;
}

const files = walk(SRC).map((full) => ({ full, rel: relative(SRC, full).split("\\").join("/") }));
const layerOf = (rel) => (SHARED.has(rel) ? -1 : LAYERS[rel.split("/")[0]]);
const fileByRel = new Map(files.map((file) => [file.rel, file.full]));

/* ------------------------------------------------------------------ */
/* 1-3. 依赖图                                                          */
/* ------------------------------------------------------------------ */

const IMPORT_RE = /^\s*import\s+(type\s+)?[^"']*from\s+["']([^"']+)["']/gm;
const violations = [];
const piInBoundary = [];
const sdkOutsideProtocols = [];
const agentConstructions = [];

for (const { full, rel } of files) {
	const source = readFileSync(full, "utf8");
	const layer = layerOf(rel);
	const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";

	if (/new\s+Agent\s*\(/.test(source) && rel !== "kernel/agent.ts") {
		agentConstructions.push(rel);
	}
	if (/from\s+["'][^"']*\/dist\//.test(source)) violations.push(`${rel}: 引用了 dist/`);

	let imports = 0;
	for (const match of source.matchAll(IMPORT_RE)) {
		imports += 1;
		const isTypeOnly = Boolean(match[1]);
		const spec = match[2];

		// pi is allowed only where it is unavoidable: the model adapter, the single
		// Agent assembly point, and the tool contract everyone else imports.
		if (spec.startsWith("@earendil-works/") && layer !== LAYERS.model && layer !== LAYERS.kernel && rel !== "features/contract.ts") {
			piInBoundary.push(`${rel} → ${spec}`);
		}
		if (spec.startsWith("@agentclientprotocol/") && layer !== LAYERS.protocols) {
			sdkOutsideProtocols.push(`${rel} → ${spec}`);
		}
		if (!spec.startsWith(".")) continue;

		// 相对导入：解析成 src 内的路径
		const parts = `${dir ? `${dir}/` : ""}${spec}`.split("/");
		const stack = [];
		for (const part of parts) {
			if (part === "." || part === "") continue;
			if (part === "..") stack.pop();
			else stack.push(part);
		}
		// ESM 导入写的是 `.js`（NodeNext 约定），磁盘上是 `.ts`
		const resolved = stack.join("/");
		const targetRel = fileByRel.has(resolved) ? resolved : resolved.replace(/\.js$/, ".ts");
		if (!fileByRel.has(targetRel)) {
			violations.push(`${rel} → ${spec}（指向 src 之外或不存在）`);
			continue;
		}
		const targetLayer = layerOf(targetRel);
		if (targetLayer <= layer || targetLayer === -1) continue; // 向下（或同层、或共享类型）都合法

		// 向上依赖：只放行两条列明的横向例外
		const targetDir = targetRel.includes("/") ? targetRel.slice(0, targetRel.lastIndexOf("/")) : "";
		if (rel === LATERAL_TO_EXTENSIONS && targetDir === "extensions" && isTypeOnly) continue;
		if (dir === "extensions" && targetDir === "features" && CONTRACTS_FOR_EXTENSIONS.has(targetRel.split("/").pop())) continue;
		violations.push(`${rel} → ${targetRel}（L${layer} 依赖了上层的 L${targetLayer}）`);
	}

	if (SHARED.has(rel) && imports > 0) violations.push(`${rel}: 共享类型文件必须零依赖`);
}

check("依赖方向：只向下，横向例外只有两条", violations.length === 0, violations.slice(0, 5).join("; "));
check(
	"pi 只出现在 model/、kernel/、features/contract.ts",
	piInBoundary.length === 0,
	piInBoundary.slice(0, 5).join("; "),
);
check("ACP SDK 只出现在协议层", sdkOutsideProtocols.length === 0, sdkOutsideProtocols.slice(0, 5).join("; "));
check("只有 kernel/agent.ts 装配 pi 的 Agent", agentConstructions.length === 0, agentConstructions.join(", "));

/* ------------------------------------------------------------------ */
/* 3b. 协议层不认识工具名                                                */
/* ------------------------------------------------------------------ */

// Built-in tool names. The protocol layer may *define* tools (protocols/acp/tools.ts
// declares the client-backed ones) but must never branch on a tool name — that is
// what the tools' own `metadata`/`describe` declarations are for.
const BUILTIN_TOOLS = ["read_file", "write_file", "edit_file", "glob", "grep", "run_command", "get_current_time"];
const toolNameLeaks = [];
for (const { full, rel } of files) {
	if (!rel.startsWith("protocols/") || rel === "protocols/acp/tools.ts") continue;
	const source = readFileSync(full, "utf8");
	for (const tool of BUILTIN_TOOLS) {
		if (source.includes(`"${tool}"`) || source.includes(`'${tool}'`)) toolNameLeaks.push(`${rel}: ${tool}`);
	}
}
check(
	"协议层不认识具体工具名（只有 tools.ts 定义它们）",
	toolNameLeaks.length === 0,
	toolNameLeaks.slice(0, 5).join("; "),
);

// A capability implementation may only be reached through its plugin: if an entry
// or the protocol layer imported it directly, "everything is a plugin" would be a
// lie for that capability (and the front end would know its options again).
const CAPABILITY_IMPORTERS = { "local-tools": ["extensions/builtin/local-tools.ts"] };
const capabilityLeaks = [];
for (const { full, rel } of files) {
	const source = readFileSync(full, "utf8");
	for (const [capability, allowed] of Object.entries(CAPABILITY_IMPORTERS)) {
		if (!source.includes(`features/${capability}.js`)) continue;
		if (!allowed.includes(rel)) capabilityLeaks.push(`${rel} → features/${capability}.js`);
	}
}
check(
	"能力实现只能被它的插件引用（本地工具不能被入口/协议层直接用）",
	capabilityLeaks.length === 0,
	capabilityLeaks.slice(0, 5).join("; "),
);

// Commands that plugins provide must not be *handled* by an entry: two
// implementations of `/new` or `/help` drift apart (the CLI's help text had
// already gone stale). Entries own only their own host-level commands.
const PLUGIN_COMMANDS = ["tools", "stats", "model", "mcp", "new", "help"];
const commandLeaks = [];
for (const { full, rel } of files) {
	if (!rel.startsWith("entries/")) continue;
	const source = readFileSync(full, "utf8");
	for (const name of PLUGIN_COMMANDS) {
		const handlers = [`case "/${name}"`, `=== "/${name}"`, `startsWith("/${name}"`];
		if (handlers.some((pattern) => source.includes(pattern))) commandLeaks.push(`${rel}: /${name}`);
	}
}
check(
	"入口只实现自己的 host 级命令（插件命令交给插件）",
	commandLeaks.length === 0,
	commandLeaks.slice(0, 5).join("; "),
);

/* ------------------------------------------------------------------ */
/* 4. 运行时依赖白名单                                                   */
/* ------------------------------------------------------------------ */

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const RUNTIME_DEPS = ["@agentclientprotocol/sdk", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai"];
const extraDeps = Object.keys(pkg.dependencies ?? {}).filter((name) => !RUNTIME_DEPS.includes(name));
const optionalDeps = Object.keys(pkg.optionalDependencies ?? {});
check("运行时依赖只有 pi 两个包 + ACP SDK", extraDeps.length === 0, extraDeps.join(", "));
check(
	"可选依赖只允许 ws（缺失要能降级）",
	optionalDeps.every((name) => name === "ws") && !Object.keys(pkg.dependencies ?? {}).includes("ws"),
	optionalDeps.join(", "),
);
check("不依赖 pi-coding-agent", !Object.keys(pkg.dependencies ?? {}).some((name) => name.endsWith("pi-coding-agent")));

// Publish readiness: `private` blocks `npm publish`, and the tarball ships `dist/`
// only, so `prepublishOnly` has to build it — otherwise a release ships a stale or
// empty package. `repository` is what lets npm resolve the README's relative links.
check(
	"可发布：private 已关，license / repository / prepublishOnly 齐备",
	pkg.private !== true &&
		Boolean(pkg.license) &&
		Boolean(pkg.repository) &&
		typeof pkg.scripts?.prepublishOnly === "string" &&
		// scoped 包默认 restricted，且本机 registry 可能是内网镜像：两个都得写死。
		pkg.publishConfig?.access === "public" &&
		Boolean(pkg.publishConfig?.registry),
	`name=${pkg.name} license=${pkg.license ?? "—"} prepublishOnly=${pkg.scripts?.prepublishOnly ?? "—"}`,
);
// Packaging: every `bin` must point at a real entry point — built output → its
// source, shipped shell script → itself — and the tarball must carry the browser
// test page (the HTTP transport serves it), the mcp template, and the serve script.
const EXPECTED_BINS = ["steve", "steve-acp", "steve-acp-serve"];
const binEntries = Object.entries(pkg.bin ?? {});
const binSource = (target) =>
	// dist/*.js 是构建产物 → 映射回 src/*.ts；其余（scripts/*.mjs）就是仓库里的文件本身。
	target.startsWith("dist/") ? target.replace(/^dist\//, "src/").replace(/\.js$/, ".ts") : target;
const missingBins = binEntries.filter(([, target]) => !existsSync(join(ROOT, binSource(target))));
check(
	"bin 提供 steve / steve-acp / steve-acp-serve，且都指向真实存在的入口",
	EXPECTED_BINS.every((name) => name in (pkg.bin ?? {})) && missingBins.length === 0,
	binEntries.map(([name, target]) => `${name} → ${target}`).join(", "),
);
const REQUIRED_FILES = ["dist", "test-acp-jsonrpc.html", "scripts/steve-acp-serve.mjs"];
check(
	"files 覆盖 dist / 测试页 / serve 脚本（装完 UI、ACP、一键启动都能用）",
	REQUIRED_FILES.every((entry) => (pkg.files ?? []).includes(entry)),
	(pkg.files ?? []).join(", "),
);

/* ------------------------------------------------------------------ */
/* 5. 发布卫生                                                          */
/* ------------------------------------------------------------------ */

const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
	.split("\n")
	.filter(Boolean);
check("`.env` 不入库（只提交 .env.example）", !tracked.includes(".env") && tracked.includes(".env.example"));

// `.steve/` holds local config and secrets (`.env`, `mcp.json`, plugins, sessions).
const ignored = (path) => {
	try {
		execFileSync("git", ["check-ignore", "-q", path], { cwd: ROOT });
		return true;
	} catch {
		return false;
	}
};
const steveTracked = tracked.filter((file) => file.startsWith(".steve/"));
check(
	"`.steve/` 被 gitignore（本地配置与密钥永不提交）",
	ignored(".steve/.env") && ignored(".steve/mcp.json") && ignored(".steve/extensions/x.mjs"),
	".gitignore 缺少 .steve/",
);
check("没有 `.steve/` 下的文件被跟踪", steveTracked.length === 0, steveTracked.join(", "));

// 文档 / 测试夹具里的 home 路径不许出现真名（macOS 用户名、公司机器名都是隐私）。
// 占位符随便用；真路径请写成 ~ 或 $HOME，让人家自己替换。
const PLACEHOLDER_USERS = new Set(["you", "user", "example", "yourname", "me"]);
const HOME_PATH = /\/(?:Users|home)\/([A-Za-z0-9._-]+)/g;
const homeLeaks = new Set();

const FORBIDDEN = [
	["zhuan", "spirit"].join(""), // 内网网关域名
	["token", "hub"].join(""), // 内网网关名
	["sk_", "5694"].join(""), // 真实 key 片段
	["deepseek", "-v4"].join(""), // 真实模型 id
	["zhang", "haoyu"].join(""), // 真名（LICENSE 署名用 zhyoung）
];
const leaked = [];
for (const rel of tracked) {
	if (rel === "scripts/arch-test.mjs") continue; // 本文件里有这些片段，跳过自己
	if (!/\.(ts|js|mjs|json|md|html|example|yml|yaml|sh)$/.test(rel) && rel !== ".env.example") continue;
	let text;
	try {
		text = readFileSync(join(ROOT, rel), "utf8");
	} catch {
		continue;
	}
	for (const needle of FORBIDDEN) {
		if (text.includes(needle)) leaked.push(`${rel}: ${needle}`);
	}

	// 本机 home 出现即视为泄漏；/Users/<非占位符> 这类真名同样算。
	if (text.includes(homedir())) homeLeaks.add(`${rel}: ${homedir()}`);
	for (const [match, name] of text.matchAll(HOME_PATH)) {
		if (!PLACEHOLDER_USERS.has(name.toLowerCase())) homeLeaks.add(`${rel}: ${match}`);
	}
}
check("公开文件里没有内网域名 / 凭据 / 真实模型 id / 真名", leaked.length === 0, leaked.slice(0, 5).join("; "));
check(
	"公开文件里没有个人 home 路径（本机 home 或非占位符用户名）",
	homeLeaks.size === 0,
	[...homeLeaks].slice(0, 5).join("; "),
);

/* ------------------------------------------------------------------ */

console.log(`\n${passed}/${passed + failures.length} checks passed`);
if (failures.length) {
	console.log(`失败：${failures.join("; ")}`);
	process.exit(1);
}
