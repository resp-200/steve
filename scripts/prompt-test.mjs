#!/usr/bin/env node
// Verifies the system-prompt assembly (model/prompt.ts):
//
//   A. layers: identity -> persona -> scene -> details, in that order
//   B. overrides: identity still gets the scene (a replaced prompt must not
//      claim a context the process does not have); empty strings mean "absent"
//   C. every scene says something different, and the worker scene carries the
//      unattended rules — that is the one a background run cannot discover alone
//
//   npm run build && node scripts/prompt-test.mjs
import process from "node:process";
import { AGENT_IDENTITY, AGENT_WORKING_RULES, DEFAULT_IDENTITY, composeSystemPrompt } from "../dist/model/prompt.js";

const checks = [];
const check = (name, passed, detail = "") => {
	checks.push({ name, passed });
	process.stderr.write(`  ${passed ? "✓" : "✗"} ${name}${passed || !detail ? "" : ` — ${detail}`}\n`);
};

/* ---------- A. layers ---------- */

const base = composeSystemPrompt({ scene: "cli" });

check("the identity body comes first", base.startsWith(AGENT_IDENTITY), base.slice(0, 40));
check("the working rules are part of the default identity", base.includes("# 怎么工作") && base.includes("# 怎么说话"));
check("the default identity is identity + rules", DEFAULT_IDENTITY === `${AGENT_IDENTITY}\n\n${AGENT_WORKING_RULES}`);
check("the scene follows the identity", base.indexOf("# 当前场景") > base.indexOf("# 怎么说话"));
check("no details block without details", !base.includes("工作目录："), base);

{
	const withPersona = composeSystemPrompt({ scene: "cli", persona: "叫我老板。" });
	const personaAt = withPersona.indexOf("# 用户的额外要求\n叫我老板。");
	check("the persona is its own layer", personaAt > 0, withPersona);
	check("the persona sits between identity and scene", personaAt > withPersona.indexOf("# 怎么说话") && personaAt < withPersona.indexOf("# 当前场景"));
}

{
	// Blank input is what an empty console field produces; it must not add an empty
	// heading or perturb the cacheable prefix.
	const blank = composeSystemPrompt({ scene: "cli", persona: "   ", identity: "  " });
	check("a whitespace-only persona adds no layer", !blank.includes("# 用户的额外要求"));
	check("a whitespace-only identity falls back to the default", blank.includes(AGENT_IDENTITY));
	check("blank layers do not change the prompt at all", blank === base, blank);
}

{
	const detailed = composeSystemPrompt({ scene: "acp", details: { cwd: "/work/proj", roots: ["/work/proj", "/work/shared"] } });
	check("the working directory is stated", detailed.includes("工作目录：/work/proj"), detailed);
	check("the accessible roots are stated", detailed.includes("可以访问的目录：/work/proj、/work/shared"));
	check("details come last", detailed.trimEnd().endsWith("/work/shared"), detailed.slice(-60));
	check("roots without cwd still render", composeSystemPrompt({ scene: "acp", details: { roots: ["/a"] } }).includes("可以访问的目录：/a"));
	check("blank roots are dropped", !composeSystemPrompt({ scene: "acp", details: { cwd: "/x", roots: [" ", ""] } }).includes("可以访问的目录"));
}

/* ---------- B. overrides ---------- */

{
	const replaced = composeSystemPrompt({ scene: "worker", identity: "你是一台只会算数的机器。" });
	check("LLM_SYSTEM_PROMPT replaces the identity", replaced.startsWith("你是一台只会算数的机器。"), replaced.slice(0, 30));
	check("a replaced identity does not keep the built-in one", !replaced.includes(AGENT_IDENTITY));
	check("a replaced identity still gets the scene", replaced.includes("# 当前场景") && replaced.includes("无人值守"), replaced);
}

/* ---------- C. scenes ---------- */

{
	const scenes = ["cli", "acp", "worker", "feishu"].map((scene) => composeSystemPrompt({ scene }));
	const sections = scenes.map((prompt) => prompt.slice(prompt.indexOf("# 当前场景")));
	check("every scene has a scene block", sections.every((section) => section.startsWith("# 当前场景")));
	check("the scenes differ from each other", new Set(sections).size === sections.length);

	const worker = scenes[2];
	check("the worker scene says nobody is watching", worker.includes("无人值守"));
	check("the worker scene says approvals will be refused", worker.includes("会被判为拒绝"), worker);
	check("the worker scene forbids irreversible actions", worker.includes("不可逆"));
	check("the worker scene points at the final reply", worker.includes("最终回复"));

	// A person is on the other end of a CLI/ACP/Feishu turn; only the worker is alone.
	const attended = [scenes[0], scenes[1], scenes[3]];
	check("only the worker scene is unattended", attended.every((prompt) => !prompt.includes("无人值守")));
	check("the feishu scene knows replies are chat messages", scenes[3].includes("飞书"));
}

{
	// Rendering advice was deliberately left out: a wrong claim about a client is
	// worse than saying nothing, and the console asked for it to stay out.
	const all = ["cli", "acp", "worker", "feishu"].map((scene) => composeSystemPrompt({ scene })).join("\n");
	// "markdown 链接" is about writing a citation, not about how a client renders
	// it — the rule under test is that no scene claims anything renders.
	const withoutCitations = all.replace(/markdown 链接/g, "链接");
	check("no rendering claims anywhere", !/markdown/i.test(withoutCitations) && !all.includes("纯文本"), all);
}

/* ---------- summary ---------- */

const failed = checks.filter((item) => !item.passed);
process.stderr.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
if (failed.length > 0) process.exitCode = 1;
