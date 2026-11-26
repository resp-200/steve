#!/usr/bin/env node
// Verifies that prompt edits reach a *running* session (features/runtime.ts).
//
// The console edits `~/.steve/admin.json` while the process is up. A prompt
// composed once at startup would make that edit invisible until a restart — and
// a CLI/ACP session can live all day. These checks drive a real AgentRuntime and
// change the file between turns:
//
//   A. a persona saved in the console shows up in the next turn's prompt
//   B. editing it again replaces it; clearing the field removes the layer
//     (clearing is a real edit — "no persona" must not mean "keep the old one")
//   C. the rest of the prompt (identity, scene) survives every refresh, so a
//     refresh cannot silently lose the behaviour rules
//   D. an explicit `systemPrompt` still wins: a caller that pinned the prompt
//     asked for that, and the refresh hook must not override it
//
//   npm run build && node scripts/prompt-hot-test.mjs
import process from "node:process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = join(tmpdir(), `steve-prompt-hot-${process.pid}`);
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
process.env.STEVE_HOME = home;

const { createAgentRuntime } = await import("../dist/features/runtime.js");
const { readAdminConfig } = await import("../dist/features/admin-config.js");

const checks = [];
const check = (name, passed, detail = "") => {
	checks.push({ name, passed });
	process.stderr.write(`  ${passed ? "✓" : "✗"} ${name}${passed || !detail ? "" : ` — ${detail}`}\n`);
};

/** Writes the console file the way the admin API does. */
const savePersona = (persona) => {
	writeFileSync(join(home, "admin.json"), JSON.stringify(persona === undefined ? { logLevel: "info" } : { logLevel: "info", persona }));
};

const refresh = async () => {
	const admin = await readAdminConfig();
	return admin.persona === undefined ? undefined : { persona: admin.persona };
};

/**
 * A turn that cannot reach a provider still proves the point: the prompt is
 * refreshed before the request is attempted. The provider is unreachable on
 * purpose, so nothing here depends on the network.
 */
const turn = async (runtime) => {
	try {
		await runtime.prompt("hi");
	} catch {
		/* expected: no provider behind this config */
	}
};

const config = {
	apiKey: "test",
	model: { id: "test-model", provider: "custom", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions" },
};

/* ---------- A/B. edits take effect without a restart ---------- */

savePersona(undefined);
const runtime = createAgentRuntime({ config, refreshPrompt: refresh });
const initial = runtime.systemPrompt();
check("no persona at startup", !initial.includes("# 用户的额外要求"));

savePersona("回答用中文，先给结论。");
await turn(runtime);
const withPersona = runtime.systemPrompt();
check("a saved persona appears in the next turn", withPersona.includes("# 用户的额外要求\n回答用中文，先给结论。"), withPersona.slice(0, 120));
check("the same runtime object keeps running", runtime.systemPrompt() === withPersona);

savePersona("第二版角色：先给方案。");
await turn(runtime);
const replaced = runtime.systemPrompt();
check("editing the persona replaces the layer", replaced.includes("第二版角色：先给方案。") && !replaced.includes("回答用中文"), replaced.slice(0, 120));

/* ---------- C. nothing else is lost on refresh ---------- */

check("identity survives a refresh", replaced.includes("史蒂夫") && replaced.includes("# 怎么工作"), replaced.slice(0, 80));
check("the scene survives a refresh", replaced.includes("# 当前场景"));
check("one persona layer at a time", replaced.split("# 用户的额外要求").length === 2);

/* ---------- clearing is an edit too ---------- */

savePersona(undefined);
await turn(runtime);
check("clearing the field removes the layer", !runtime.systemPrompt().includes("# 用户的额外要求"), runtime.systemPrompt().slice(0, 120));
check("the prompt returns to the built-in default", runtime.systemPrompt().includes("史蒂夫") && runtime.systemPrompt().includes("# 怎么工作"));

/* ---------- D. an explicit prompt still wins ---------- */

savePersona("不该覆盖显式提示词");
const pinned = createAgentRuntime({ config, systemPrompt: "固定提示词", refreshPrompt: refresh });
await turn(pinned);
check("an explicit systemPrompt is not overridden", pinned.systemPrompt() === "固定提示词", pinned.systemPrompt());

rmSync(home, { recursive: true, force: true });

const failed = checks.filter((item) => !item.passed);
process.stderr.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
if (failed.length > 0) process.exitCode = 1;
