#!/usr/bin/env node
// Verifies where credentials come from:
//
//   A. the .env chain: install dir -> ~/.steve -> $PWD -> $PWD/.steve, with a
//      real environment variable always winning over every file
//   B. only `.steve/.env` is read: install dir -> ~/.steve -> $PWD/.steve, and a
//      plain `.env` anywhere is ignored (legacy support was dropped on purpose)
//
//   npm run build && node scripts/config-test.mjs
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const checks = [];
const check = (name, passed, detail = "") => {
	checks.push({ name, passed });
	process.stderr.write(`  ${passed ? "✓" : "✗"} ${name}${passed || !detail ? "" : ` — ${detail}`}\n`);
};

/**
 * Runs `loadConfig()` in a child process with a controlled HOME and cwd, and
 * prints the resolved key. The env is passed explicitly, so the parent's
 * variables never leak in.
 *
 * `dist/` is copied to a temp "install directory" first: that way the project's
 * own real `.steve/.env` cannot leak into the test, and the install-directory
 * fallback can be tested for real.
 */
function resolve(cwd, home, extraEnv = {}) {
	const script = `
		const { loadConfig, envFileCandidates } = await import(${JSON.stringify(join(INSTALL, "dist/model/config.js"))});
		const config = loadConfig();
		console.log(JSON.stringify({ key: config.apiKey, model: config.model.id, files: envFileCandidates() }));
	`;
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
		cwd,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			HOME: home,
			LLM_MODEL_ID: "test-model",
			LLM_BASE_URL: "https://example.test/anthropic",
			...extraEnv,
		},
	});
	if (child.status !== 0) throw new Error(child.stderr || "child failed");
	return JSON.parse(child.stdout.trim());
}

function writeEnv(dir, contents) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, ".env"), contents);
}

const workspace = mkdtempSync(join(tmpdir(), "steve-config-"));
const home = mkdtempSync(join(tmpdir(), "steve-config-home-"));
const project = join(workspace, "project");
const bare = join(workspace, "bare");
const INSTALL = join(workspace, "install");
mkdirSync(project, { recursive: true });
mkdirSync(bare, { recursive: true });
// A throwaway copy of the build output, so the install directory has no .env.
cpSync(join(ROOT, "dist"), join(INSTALL, "dist"), { recursive: true });

/** macOS resolves /var -> /private/var, so compare real paths. */
const real = (path) => realpathSync(path);

try {
	process.stderr.write("config · 全局 ~/.steve/.env\n");

	// 1. nothing on disk
	const missing = spawnSync(process.execPath, ["--input-type=module", "-e", `
		const { loadConfig } = await import(${JSON.stringify(join(INSTALL, "dist/model/config.js"))});
		try { loadConfig(); console.log("no-error"); } catch (error) { console.log(error.message); }
	`], {
		cwd: project,
		encoding: "utf8",
		env: { PATH: process.env.PATH, HOME: home, LLM_MODEL_ID: "m", LLM_BASE_URL: "https://example.test/anthropic" },
	}).stdout;
	check(
		"没有文件时缺 key 会报错，并提示 .steve/.env",
		missing.includes("Missing required environment variable LLM_API_KEY") && missing.includes(".steve/.env"),
		missing.trim().slice(0, 80),
	);

	// 2. only the global ~/.steve/.env is read
	writeEnv(join(home, ".steve"), 'LLM_API_KEY="from-global"\n');
	check("~/.steve/.env 被读到", resolve(project, home).key === "from-global", resolve(project, home).key);

	const candidates = resolve(bare, home).files;
	check(
		"只有一个候选文件：~/.steve/.env",
		candidates.length === 1 && candidates[0] === join(home, ".steve", ".env"),
		candidates.join(", "),
	);

	// 3. a project-local .steve/.env is ignored — the cwd no longer decides anything
	writeEnv(join(project, ".steve"), 'LLM_API_KEY="from-project-steve"\n');
	check("项目 .steve/.env 被忽略", resolve(project, home).key === "from-global", resolve(project, home).key);

	// 4. a plain `.env` in the cwd is ignored as well (legacy support was dropped)
	writeEnv(bare, 'LLM_API_KEY="from-legacy-env"\n');
	check("旧写法 .env 被忽略（不再兼容）", resolve(bare, home).key === "from-global", resolve(bare, home).key);
	rmSync(join(bare, ".env"), { force: true });

	// 5. the install directory never carries credentials either: clients spawn the
	//    ACP server from an unrelated cwd and must still see the same global config
	writeEnv(join(INSTALL, ".steve"), 'LLM_API_KEY="from-install-dir"\n');
	check("安装目录 .steve/.env 被忽略", resolve(bare, home).key === "from-global", resolve(bare, home).key);
	rmSync(join(INSTALL, ".steve"), { recursive: true, force: true });

	// 6. the real environment always wins
	const overridden = resolve(bare, home, { LLM_API_KEY: "from-process-env" });
	check("真实环境变量优先于文件", overridden.key === "from-process-env", overridden.key);

	// 7. STEVE_HOME points the whole directory somewhere else
	const altHome = join(workspace, "alt-home");
	writeEnv(altHome, 'LLM_API_KEY="from-steve-home"\n');
	check("STEVE_HOME 覆盖状态目录", resolve(bare, home, { STEVE_HOME: altHome }).key === "from-steve-home", resolve(bare, home, { STEVE_HOME: altHome }).key);

	// 8. first run creates ~/.steve so the console has somewhere to write
	const freshHome = join(workspace, "fresh-home");
	mkdirSync(freshHome, { recursive: true });
	const created = spawnSync(process.execPath, ["--input-type=module", "-e", `
		const { loadConfig } = await import(${JSON.stringify(join(INSTALL, "dist/model/config.js"))});
		try { loadConfig(); } catch {}
	`], {
		cwd: bare,
		encoding: "utf8",
		env: { PATH: process.env.PATH, HOME: freshHome, LLM_MODEL_ID: "m", LLM_BASE_URL: "https://example.test/anthropic" },
	});
	check("首次启动自动创建 ~/.steve", created.status === 0 && existsSync(join(freshHome, ".steve")), created.stderr.slice(0, 120));

	// 9. quoted values are unwrapped, comments and blanks ignored
	writeEnv(join(home, ".steve"), '# comment\n\nLLM_API_KEY=\'single-quoted\'\nNOT_A_PAIR\n');
	check("引号/注释/空行处理正确", resolve(bare, home).key === "single-quoted", resolve(bare, home).key);

	const failed = checks.filter((entry) => !entry.passed);
	process.stderr.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
	if (failed.length > 0) process.exitCode = 1;
} finally {
	rmSync(workspace, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
}
