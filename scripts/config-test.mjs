#!/usr/bin/env node
// Verifies where credentials come from:
//
//   A. the .env chain: install dir -> ~/.steve -> $PWD -> $PWD/.steve, with a
//      real environment variable always winning over every file
//   B. `.steve/.env` is the preferred location, the legacy `.env` still works
//
//   npm run build && node scripts/config-test.mjs
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
	process.stderr.write("config · .env 链\n");

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

	// 2. the project's .steve/.env
	writeEnv(join(project, ".steve"), 'LLM_API_KEY="from-project-steve"\n');
	check(".steve/.env 被读到", resolve(project, home).key === "from-project-steve", resolve(project, home).key);

	// 3. a legacy .env in the same directory loses to .steve/.env
	writeEnv(project, 'LLM_API_KEY="from-legacy-env"\n');
	check("同目录下 .steve/.env 优先于 .env", resolve(project, home).key === "from-project-steve", resolve(project, home).key);

	// 4. the global ~/.steve/.env is used when the project has nothing
	writeEnv(join(home, ".steve"), 'LLM_API_KEY="from-global"\n');
	check("项目没配置时用 ~/.steve/.env", resolve(bare, home).key === "from-global", resolve(bare, home).key);

	// 5. and it loses to the project's own file
	check("项目配置优先于全局配置", resolve(project, home).key === "from-project-steve", resolve(project, home).key);

	// 6. the real environment always wins
	const overridden = resolve(project, home, { LLM_API_KEY: "from-process-env" });
	check("真实环境变量优先于所有文件", overridden.key === "from-process-env", overridden.key);

	// 7. the install directory's own files are the fallback: editors spawn the ACP
	//    server from another cwd, so the project's .steve/.env must still be found.
	const candidates = resolve(bare, home).files;
	check(
		"候选顺序：安装目录 < 全局 < 工作目录 < 工作目录/.steve",
		candidates.length === 5 &&
			candidates[0] === join(real(INSTALL), ".env") &&
			candidates[1] === join(real(INSTALL), ".steve", ".env") &&
			candidates[2] === join(home, ".steve", ".env") && // homedir() keeps $HOME as given
			candidates[3] === join(real(bare), ".env") &&
			candidates[4] === join(real(bare), ".steve", ".env"),
		candidates.join(", "),
	);

	// Nothing global, nothing in cwd: the install directory answers.
	rmSync(join(home, ".steve", ".env"), { force: true });
	writeEnv(join(INSTALL, ".steve"), 'LLM_API_KEY="from-install-dir"\n');
	check("cwd 与全局都没有时，安装目录的 .steve/.env 兜底", resolve(bare, home).key === "from-install-dir", resolve(bare, home).key);
	writeEnv(join(home, ".steve"), 'LLM_API_KEY="from-global"\n');
	check("全局配置优先于安装目录", resolve(bare, home).key === "from-global", resolve(bare, home).key);

	// 8. quoted values are unwrapped, comments and blanks ignored
	writeEnv(join(project, ".steve"), '# comment\n\nLLM_API_KEY=\'single-quoted\'\nNOT_A_PAIR\n');
	check("引号/注释/空行处理正确", resolve(project, home).key === "single-quoted", resolve(project, home).key);

	const failed = checks.filter((entry) => !entry.passed);
	process.stderr.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
	if (failed.length > 0) process.exitCode = 1;
} finally {
	rmSync(workspace, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
}
