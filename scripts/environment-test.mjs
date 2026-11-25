#!/usr/bin/env node
// Verifies the environment snapshot (docs/personal-agent.md §4.4 / §5.4):
//
//   A. the snapshot is plain, detached data: JSON round-trip and
//      `structuredClone` both survive, and nothing in it is callable
//   B. normalization: roots de-duplicated in order, tools sorted by name and
//      de-duplicated, plugins sorted, optional fields omitted rather than set
//      to undefined
//   C. the two entries agree: the CLI and ACP shapes built from the same policy
//      produce byte-identical snapshots, which is what makes the snapshot
//      trustworthy in `run.started.environment`
//
//   npm run build && node scripts/environment-test.mjs
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { snapshotEnvironment } = await import(join(ROOT, "dist/features/environment.js"));
const { workspacePolicy, modelInfo } = await import(join(ROOT, "dist/features/session-policy.js"));

const checks = [];
const check = (name, passed, detail = "") => {
	checks.push({ name, passed });
	process.stderr.write(`  ${passed ? "✓" : "✗"} ${name}${passed || !detail ? "" : ` — ${detail}`}\n`);
};

const CWD = "/tmp/steve-environment";
const config = {
	model: {
		id: "mock-model",
		api: "anthropic",
		baseUrl: "http://127.0.0.1:8899/anthropic",
		input: ["text", "image"],
	},
};
const MODEL = modelInfo(config);
const USER_PROJECTION = {
	audience: "user",
	thinking: "drop",
	toolOutput: "summary",
	toolOutputChars: 240,
	details: false,
};

/** What each entry passes once its runtime exists (same policy, same tools). */
const workspace = workspacePolicy({ cwd: CWD, access: "exec" });
const tools = [
	{ name: "write_file", permissionRequired: true, kind: "edit" },
	{ name: "read_file", permissionRequired: false, kind: "read" },
	{ name: "get_current_time" },
];
const snapshot = snapshotEnvironment({
	cwd: CWD,
	workspace,
	model: MODEL,
	tools,
	permissionMode: "ask",
	plugins: [join(CWD, ".steve/extensions/b.js"), join(CWD, ".steve/extensions/a.js")],
	projection: USER_PROJECTION,
});

/* A. plain data ---------------------------------------------------------- */

const roundTripped = JSON.parse(JSON.stringify(snapshot));
check("JSON 往返无损", JSON.stringify(roundTripped) === JSON.stringify(snapshot));

let cloned;
try {
	cloned = structuredClone(snapshot);
} catch (error) {
	cloned = undefined;
	check("structuredClone 成功（快照里没有函数/Agent 实例）", false, String(error));
}
if (cloned !== undefined) {
	check("structuredClone 成功（快照里没有函数/Agent 实例）", true);
	check("structuredClone 结果与快照深相等", JSON.stringify(cloned) === JSON.stringify(snapshot));
}

const containsFunction = (value) =>
	typeof value === "function" ||
	(value !== null &&
		typeof value === "object" &&
		Object.values(value).some((entry) => containsFunction(entry)));
check("快照中没有任何函数", !containsFunction(snapshot));

const JSON_KEYS = [
	"access",
	"cwd",
	"mode",
	"model",
	"permissionMode",
	"plugins",
	"projection",
	"roots",
	"tools",
];
check(
	"快照只包含约定的字段",
	JSON.stringify(Object.keys(snapshot).sort()) === JSON.stringify(JSON_KEYS),
	Object.keys(snapshot).sort().join(","),
);

check("快照与 workspace policy 是分离的（改 workspace 不影响快照）", (() => {
	const mutableWorkspace = { roots: [CWD], access: "exec" };
	const taken = snapshotEnvironment({
		cwd: CWD,
		workspace: mutableWorkspace,
		model: MODEL,
		tools: [],
		permissionMode: "ask",
		projection: USER_PROJECTION,
	});
	mutableWorkspace.roots.push("/tmp/late");
	return taken.roots.length === 1;
})());

check("快照与投影策略是分离的（改策略不影响快照）", (() => {
	const mutablePolicy = { ...USER_PROJECTION };
	const taken = snapshotEnvironment({
		cwd: CWD,
		workspace,
		model: MODEL,
		tools: [],
		permissionMode: "ask",
		projection: mutablePolicy,
	});
	mutablePolicy.audience = "full";
	return taken.projection.audience === "user";
})());

/* B. normalization ------------------------------------------------------- */

check("cwd 原样保留", snapshot.cwd === CWD);
check("roots 保留 cwd 并去重", JSON.stringify(snapshot.roots) === JSON.stringify([CWD]), JSON.stringify(snapshot.roots));

const wide = snapshotEnvironment({
	cwd: CWD,
	workspace: { roots: [CWD, "/tmp/extra", CWD, "/tmp/more"], access: "read" },
	model: MODEL,
	tools: [],
	permissionMode: "allow",
	projection: { ...USER_PROJECTION },
});
check(
	"additionalDirectories 追加在 cwd 之后且保持顺序",
	JSON.stringify(wide.roots) === JSON.stringify([CWD, "/tmp/extra", "/tmp/more"]),
	JSON.stringify(wide.roots),
);
check("access 透传", wide.access === "read");
check("permissionMode 透传", wide.permissionMode === "allow");
check("未提供 shell 时快照没有 shell 键", !("shell" in wide));
check("mode 默认为 foreground", wide.mode === "foreground");

const shell = snapshotEnvironment({
	cwd: CWD,
	workspace: { roots: [CWD], access: "exec", shell: { file: "/bin/bash", args: ["-lc"] } },
	model: MODEL,
	tools: [],
	permissionMode: "ask",
	projection: { ...USER_PROJECTION },
	mode: "background",
});
check("shell 原样写入", shell.shell?.file === "/bin/bash" && JSON.stringify(shell.shell?.args) === '["-lc"]');
check("mode 可显式设为 background", shell.mode === "background");

check("tools 按名称排序", JSON.stringify(snapshot.tools.map((tool) => tool.name)) === '["get_current_time","read_file","write_file"]', JSON.stringify(snapshot.tools.map((tool) => tool.name)));
check(
	"tools 的 permissionRequired / kind 透传，缺省为 false 且无 kind 键",
	snapshot.tools.find((tool) => tool.name === "write_file")?.permissionRequired === true &&
		snapshot.tools.find((tool) => tool.name === "read_file")?.kind === "read" &&
		snapshot.tools.find((tool) => tool.name === "get_current_time")?.permissionRequired === false &&
		!("kind" in (snapshot.tools.find((tool) => tool.name === "get_current_time") ?? {})),
	JSON.stringify(snapshot.tools),
);

const withExtras = snapshotEnvironment({
	cwd: CWD,
	workspace,
	model: MODEL,
	tools: [{ name: "write_file", permissionRequired: true, kind: "edit", execute: () => "ran" }],
	permissionMode: "ask",
	projection: { ...USER_PROJECTION },
});
check("工具上的函数在快照里被丢弃", !("execute" in (withExtras.tools[0] ?? {})));
check(
	"同名工具只保留第一个",
	(() => {
		const deduped = snapshotEnvironment({
			cwd: CWD,
			workspace,
			model: MODEL,
			tools: [
				{ name: "read_file", kind: "read" },
				{ name: "read_file", kind: "edit" },
			],
			permissionMode: "ask",
			projection: { ...USER_PROJECTION },
		});
		return deduped.tools.length === 1 && deduped.tools[0]?.kind === "read";
	})(),
);

check("plugins 排序并去重", JSON.stringify(snapshot.plugins) === JSON.stringify([join(CWD, ".steve/extensions/a.js"), join(CWD, ".steve/extensions/b.js")]), JSON.stringify(snapshot.plugins));
check(
	"未提供 plugins 时为空数组",
	JSON.stringify(
		snapshotEnvironment({ cwd: CWD, workspace, model: MODEL, tools: [], permissionMode: "ask", projection: { ...USER_PROJECTION } })
			.plugins,
	) === "[]",
);

check(
	"model 只带四个字段且与入参分离",
	JSON.stringify(snapshot.model) ===
		JSON.stringify({ id: "mock-model", api: "anthropic", baseUrl: "http://127.0.0.1:8899/anthropic", supportsImages: true }) &&
		snapshot.model !== MODEL,
	JSON.stringify(snapshot.model),
);

/* C. the two entries agree ----------------------------------------------- */

// The CLI loads plugins with workspacePolicy({cwd, access}) and the ACP entry
// with workspacePolicy({cwd, additionalDirectories, access}); same inputs must
// yield the same snapshot, otherwise `run.started.environment` lies depending on
// which entry produced the run.
const cliShape = snapshotEnvironment({
	cwd: CWD,
	workspace: workspacePolicy({ cwd: CWD, access: "exec" }),
	model: modelInfo(config),
	tools,
	permissionMode: "ask",
	plugins: [],
	projection: USER_PROJECTION,
});
const acpShape = snapshotEnvironment({
	cwd: CWD,
	workspace: workspacePolicy({ cwd: CWD, additionalDirectories: [], access: "exec" }),
	model: modelInfo(config),
	tools: [
		{ name: "read_file", permissionRequired: false, kind: "read" },
		{ name: "get_current_time" },
		{ name: "write_file", permissionRequired: true, kind: "edit" },
	],
	permissionMode: "ask",
	plugins: [],
	projection: USER_PROJECTION,
});
check("CLI 与 ACP 入口产出的快照一致", JSON.stringify(cliShape) === JSON.stringify(acpShape));

const clonedPolicy = { ...USER_PROJECTION };
const takenAgain = snapshotEnvironment({
	cwd: CWD,
	workspace,
	model: MODEL,
	tools,
	permissionMode: "ask",
	plugins: snapshot.plugins,
	projection: clonedPolicy,
});
check("同样的输入两次产出相等（确定性）", JSON.stringify(takenAgain) === JSON.stringify(snapshot));

const failed = checks.filter((entry) => !entry.passed);
process.stderr.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
if (failed.length > 0) process.exitCode = 1;
