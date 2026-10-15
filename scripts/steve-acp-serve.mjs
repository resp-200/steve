#!/usr/bin/env node
/**
 * 一键启动 steve 的 ACP HTTP 服务（远程 / 云端访问用）。
 *
 * 这是包里的第三个 bin（steve / steve-acp / steve-acp-serve）。用 Node 写而不是 bash，
 * 所以 Windows / macOS / Linux 行为一致：Windows 上 npm 会生成 .cmd 垫片，
 * 没有 nohup、/dev/tcp、$HOME 展开这些 POSIX 假设。
 *
 *   steve-acp-serve                    # 前台，默认 http://127.0.0.1:8891/acp
 *   steve-acp-serve --daemon           # 后台，日志与 pidfile 落在 ~/.steve/log/
 *   steve-acp-serve --stop             # 停掉 --daemon 起的那个实例（按端口）
 *   steve-acp-serve --port 9000 ...    # 其余参数原样透传给 steve-acp，可覆盖默认值
 *
 * token 从 ~/.steve/.env 的 ACP_TOKEN 读取。steve 自己不读这一项（它只认 process.env），
 * 所以由这里取出来再用 --token 传进去；解析规则直接复用 src/model/config.ts 的
 * parseEnvFile()，不另写一套，免得两边对引号 / 注释 / export 的处理跑偏。
 *
 * 可覆盖项（环境变量，默认值见下）：
 *   STEVE_ACP_ENV_FILE  ~/.steve/.env       token 从哪个文件读
 *   ACP_TOKEN           无                 直接给 token，优先于文件（与 steve 一致）
 *   ACP_HOST            127.0.0.1           对外服务要先反代；直接暴露才写 0.0.0.0
 *   ACP_PORT            8891
 *   ACP_PATH            /acp
 *   ACP_SESSION_DIR     ~/.steve/sessions   transcript 落盘位置，会自动创建
 *   ACP_PERMISSIONS     ask                 ask | allow（allow 不问直接执行写/命令，慎用）
 *   ACP_ALLOW_LOCAL_TOOLS  true             false 则不给本地文件/命令工具
 *   ACP_QUIET           前台 true / --daemon 时 false
 *   ACP_CORS            空                  只在「页面与端点不同源」时需要，如 "*"
 *   STEVE_ACP_LOG_DIR   ~/.steve/log        --daemon 的日志与 pidfile 目录（按端口命名）
 *
 * cwd 有意义：`.steve/mcp.json` 与 `.steve/extensions/` 都按启动目录发现，
 * 所以想带哪个项目的 MCP / 插件，就在那个目录里启动。
 */

import { spawn, spawnSync } from "node:child_process";
import {
	accessSync,
	closeSync,
	constants as FS,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const IS_WINDOWS = process.platform === "win32";

/** 解析 npm bin 的软链：bin/steve-acp-serve -> <包>/scripts/steve-acp-serve.mjs */
const SELF = realpathSync(fileURLToPath(import.meta.url));
const SCRIPT_DIR = dirname(SELF);
const DIST_MAIN = join(SCRIPT_DIR, "..", "dist", "protocols", "acp", "main.js");
const DIST_CONFIG = join(SCRIPT_DIR, "..", "dist", "model", "config.js");
const DEFAULT_ENV_FILE = join(homedir(), ".steve", ".env");

/* ---------------------------------------------------------------- 小工具 */

function die(message) {
	process.stderr.write(`steve-acp-serve: ${message}\n`);
	process.exit(1);
}

/** 只影响打印：home 前缀缩成 ~，免得截图 / 贴日志 / 报 bug 时带出用户名。 */
function tilde(value) {
	const home = homedir();
	if (value === home) return "~";
	return value.startsWith(home + sep) ? `~${value.slice(home.length)}` : value;
}

/** `~` 不会被 shell 或 path.join 展开，这里自己展开。 */
function expandHome(value) {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
	return value;
}

function timestamp() {
	const now = new Date();
	const pad = (value) => String(value).padStart(2, "0");
	return (
		`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
		`${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
	);
}

function sleep(ms) {
	return new Promise((done) => setTimeout(done, ms));
}

function tailLines(file, count) {
	try {
		const lines = readFileSync(file, "utf8").split(/\r?\n/);
		return lines.slice(Math.max(0, lines.length - count)).join("\n");
	} catch {
		return "";
	}
}

/** 在 PATH 上找可执行文件；Windows 还要试 PATHEXT 里的后缀。 */
function findOnPath(name) {
	const pathValue = process.env.PATH ?? "";
	const dirs = pathValue.split(IS_WINDOWS ? ";" : ":");
	const suffixes = IS_WINDOWS
		? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
		: [""];
	for (const dir of dirs) {
		if (!dir) continue;
		for (const suffix of suffixes) {
			const candidate = join(dir, name + suffix);
			try {
				accessSync(candidate, IS_WINDOWS ? FS.F_OK : FS.X_OK);
				return candidate;
			} catch {
				/* 继续找 */
			}
		}
	}
	return undefined;
}

function isAlive(pid) {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// Windows 上访问别人的进程会抛 EPERM，那也说明它活着。
		return error?.code === "EPERM";
	}
}

/**
 * 停掉一个实例。POSIX 用 SIGTERM，steve 自己会优雅关闭（顺带收掉 MCP 子进程）。
 * Windows 上 Node 的 SIGTERM 等于强杀、且带不走子进程，所以用 taskkill /T 杀进程树。
 */
function stopPid(pid) {
	if (IS_WINDOWS) {
		spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
		return;
	}
	process.kill(pid, "SIGTERM");
}

/** 端口占用探测：能连上就是有人听；ECONNREFUSED 才算空闲。 */
function portIsBusy(host, port) {
	const target = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
	return new Promise((done) => {
		const socket = createConnection({ host: target, port: Number(port) });
		const finish = (busy) => {
			socket.destroy();
			done(busy);
		};
		socket.setTimeout(500);
		socket.once("connect", () => finish(true));
		socket.once("timeout", () => finish(false));
		socket.once("error", (error) => finish(error?.code === "EADDRINUSE"));
	});
}

/* ------------------------------------------------------------ 选项与默认值 */

const argv = process.argv.slice(2);
let daemon = false;
let stop = false;
let help = false;
const passthrough = [];
for (const arg of argv) {
	if (arg === "--daemon" || arg === "-d") daemon = true;
	else if (arg === "--foreground") daemon = false;
	else if (arg === "--stop") stop = true;
	else if (arg === "-h" || arg === "--help") help = true;
	else passthrough.push(arg);
}

const ENV_FILE = expandHome(process.env.STEVE_ACP_ENV_FILE?.trim() || DEFAULT_ENV_FILE);
const HOST = process.env.ACP_HOST?.trim() || "127.0.0.1";
const PORT = process.env.ACP_PORT?.trim() || "8891";
const ENDPOINT_PATH = process.env.ACP_PATH?.trim() || "/acp";
const SESSION_DIR = expandHome(process.env.ACP_SESSION_DIR?.trim() || join(homedir(), ".steve", "sessions"));
const PERMISSIONS = process.env.ACP_PERMISSIONS?.trim() || "ask";
const ALLOW_LOCAL_TOOLS = process.env.ACP_ALLOW_LOCAL_TOOLS?.trim() || "true";
const CORS = process.env.ACP_CORS?.trim() || "";
const LOG_DIR = expandHome(process.env.STEVE_ACP_LOG_DIR?.trim() || join(homedir(), ".steve", "log"));
// 后台运行时默认打开 steve 自己的日志（前台保持安静），除非显式设了 ACP_QUIET。
const QUIET = process.env.ACP_QUIET?.trim() || (daemon ? "false" : "true");

// 优先用装到 PATH 上的命令；没装则退回包内（或仓库里）的构建产物。
const pathCommand = findOnPath("steve-acp");
const CMD = pathCommand
	? [pathCommand]
	: existsSync(DIST_MAIN)
		? [process.execPath, DIST_MAIN]
		: undefined;
if (!CMD) die("找不到 steve-acp：先 npm run build，或 npm i -g @zhyoung/steve");

const USAGE = `steve-acp-serve — 一键启动 steve 的 ACP HTTP 服务（token 取自 ${tilde(ENV_FILE)} 的 ACP_TOKEN）

用法
  steve-acp-serve [--daemon | --foreground] [--stop] [steve-acp 的参数…]

本脚本自己的开关
  --daemon, -d   后台运行；日志与 pidfile 写到 ${tilde(LOG_DIR)}${sep}steve-acp-<port>.{log,pid}
  --foreground   前台运行（默认；systemd / launchd 用这个）
  --stop         按 pidfile 停掉 --daemon 起的实例（POSIX 发 SIGTERM，Windows 用 taskkill /T）
  --help, -h     这段说明 + 下面 steve-acp 的完整参数表

环境变量（默认值）
  STEVE_ACP_ENV_FILE=${tilde(ENV_FILE)}
  STEVE_ACP_LOG_DIR=${tilde(LOG_DIR)}
  ACP_TOKEN / ACP_HOST / ACP_PORT / ACP_PATH / ACP_SESSION_DIR
  ACP_PERMISSIONS / ACP_ALLOW_LOCAL_TOOLS / ACP_QUIET / ACP_CORS

其余参数原样透传给 steve-acp（后写的 flag 生效，可覆盖默认值）：
`;

// --help 要能在没有 token 的情况下看，所以放在 token 解析之前。
if (help) {
	process.stdout.write(USAGE);
	spawnSync(CMD[0], [...CMD.slice(1), "--help"], { stdio: "inherit" });
	process.exit(0);
}

/* ------------------------------------------------------------------ token */

let token = process.env.ACP_TOKEN?.trim() ?? "";
if (!token && existsSync(ENV_FILE)) {
	let parseEnvFile;
	try {
		const module = await import(pathToFileURL(DIST_CONFIG).href);
		if (typeof module.parseEnvFile !== "function") {
			// 构建产物比源码旧（例如刚加了导出但没重新 build）——说人话，别抛 TypeError。
			throw new Error("dist/model/config.js 里没有导出 parseEnvFile");
		}
		parseEnvFile = module.parseEnvFile;
	} catch (error) {
		die(`读不到 .env 解析器（${tilde(DIST_CONFIG)}）：先 npm run build —— ${error.message}`);
	}
	// 同一文件里后出现的同名键覆盖先出现的，与 steve 加载 .env 的规则一致。
	for (const [key, value] of parseEnvFile(ENV_FILE)) {
		if (key === "ACP_TOKEN") token = value;
	}
}
if (!token) {
	const generator = "const c=require('node:crypto'),f=require('node:fs');";
	const append = (target) =>
		`f.appendFileSync(${target},'ACP_TOKEN='+c.randomBytes(32).toString('hex')+'\\n')`;
	const command =
		ENV_FILE === DEFAULT_ENV_FILE
			? // 默认路径就让脚本自己算，免得把用户名印出来
				`node -e "${generator}const p=require('node:path'),o=require('node:os');${append("p.join(o.homedir(),'.steve','.env')")}"`
			: `node -e "${generator}${append("process.argv[1]")}" "${ENV_FILE}"`;
	process.stderr.write(
		`steve-acp-serve: ${tilde(ENV_FILE)} 里没有 ACP_TOKEN。\n\n` +
			`生成一个 32 字节随机 token 并追加进去（node 一定有，跨平台）：\n  ${command}\n\n` +
			`或者临时用环境变量覆盖：\n  ACP_TOKEN=<64 位随机 hex> steve-acp-serve\n`,
	);
	process.exit(1);
}
if (token.length < 24) {
	process.stderr.write(
		`steve-acp-serve: 警告：ACP_TOKEN 只有 ${token.length} 个字符，建议至少 32 字节随机值\n`,
	);
}

try {
	mkdirSync(SESSION_DIR, { recursive: true });
} catch (error) {
	die(`无法创建 session 目录：${tilde(SESSION_DIR)} —— ${error.message}`);
}

/* --------------------------------------------------------- 组装 steve-acp 参数 */

const args = [
	"--transport",
	"http",
	"--host",
	HOST,
	"--port",
	PORT,
	"--path",
	ENDPOINT_PATH,
	"--token",
	token,
	"--session-dir",
	SESSION_DIR,
	"--permissions",
	PERMISSIONS,
];
if (ALLOW_LOCAL_TOOLS === "true") args.push("--allow-local-tools");
if (QUIET === "true") args.push("--quiet");
if (CORS) args.push("--cors", CORS);

// 透传参数里的 --host/--port/--path 会覆盖上面的值（steve-acp 后写的 flag 生效），
// 摘要跟着一起改，免得打印出来的地址和实际监听的不一致。
let shownHost = HOST;
let shownPort = PORT;
let shownPath = ENDPOINT_PATH;
const takeValue = (flag, value, apply) => {
	if (value !== undefined) apply(value);
};
for (let index = 0; index < passthrough.length; index += 1) {
	const arg = passthrough[index] ?? "";
	const inline = arg.match(/^--(host|port|path)=(.*)$/);
	if (inline) {
		takeValue(inline[1], inline[2], (value) => {
			if (inline[1] === "host") shownHost = value;
			else if (inline[1] === "port") shownPort = value;
			else shownPath = value;
		});
		continue;
	}
	const next = passthrough[index + 1];
	if (arg === "--host") takeValue(arg, next, (value) => (shownHost = value));
	else if (arg === "--port") takeValue(arg, next, (value) => (shownPort = value));
	else if (arg === "--path") takeValue(arg, next, (value) => (shownPath = value));
}

const PIDFILE = join(LOG_DIR, `steve-acp-${shownPort}.pid`);
const LOG_FILE = join(LOG_DIR, `steve-acp-${shownPort}.log`);

function summaryLines() {
	return [
		`steve-acp-serve: endpoint http://${shownHost}:${shownPort}${shownPath}`,
		`steve-acp-serve: 测试页   http://${shownHost}:${shownPort}/`,
		`steve-acp-serve: sessions ${tilde(SESSION_DIR)} · permissions ${PERMISSIONS} · local-tools ${ALLOW_LOCAL_TOOLS}`,
		`steve-acp-serve: token    ${token.slice(0, 6)}…（来自 ${tilde(ENV_FILE)}）`,
	];
}

function printSummary() {
	for (const line of summaryLines()) process.stderr.write(`${line}\n`);
}

/* ------------------------------------------------------------------- --stop */

if (stop) {
	if (!existsSync(PIDFILE)) {
		die(`没有 pidfile（${tilde(PIDFILE)}）：这个端口不是用 --daemon 起的，或者已经停了`);
	}
	const pid = Number.parseInt(readFileSync(PIDFILE, "utf8").trim(), 10);
	if (isAlive(pid)) {
		stopPid(pid);
		process.stderr.write(
			`steve-acp-serve: 已停止 pid ${pid}（日志 ${tilde(LOG_FILE)}）\n`,
		);
	} else {
		process.stderr.write(`steve-acp-serve: pid ${pid} 已经不在了，清掉 pidfile\n`);
	}
	rmSync(PIDFILE, { force: true });
	process.exit(0);
}

/* -------------------------------------------------------------- 端口占用检查 */

if (/^\d+$/.test(shownPort) && (await portIsBusy(shownHost, shownPort))) {
	die(
		`${shownHost}:${shownPort} 已被占用（可能上一次的实例还在跑）；` +
			`换端口：ACP_PORT=... 或 steve-acp-serve --port ...`,
	);
}

/* ------------------------------------------------------------------- 启动 */

const childArgs = [...CMD.slice(1), ...args, ...passthrough];

if (daemon) {
	try {
		mkdirSync(LOG_DIR, { recursive: true });
	} catch (error) {
		die(`无法创建日志目录：${tilde(LOG_DIR)} —— ${error.message}`);
	}
	const fd = openSync(LOG_FILE, "a");
	writeSync(fd, `\n=== ${timestamp()} 启动 ${shownHost}:${shownPort}${shownPath} ===\n`);
	writeSync(fd, `${summaryLines().join("\n")}\n`);
	const child = spawn(CMD[0], childArgs, {
		detached: true, // 独立进程组 / 会话，父进程退出后继续跑
		stdio: ["ignore", fd, fd],
		windowsHide: true,
		env: process.env,
	});
	child.unref();
	closeSync(fd);
	writeFileSync(PIDFILE, `${child.pid}\n`);

	await sleep(1000); // 探活：配置错 / 端口被抢会立刻退出
	if (!isAlive(child.pid)) {
		rmSync(PIDFILE, { force: true });
		process.stderr.write("steve-acp-serve: 启动后立刻退出了，日志末尾：\n");
		process.stderr.write(`${tailLines(LOG_FILE, 20)}\n`);
		process.exit(1);
	}

	printSummary();
	process.stderr.write(`steve-acp-serve: 后台运行 pid=${child.pid}\n`);
	process.stderr.write(`steve-acp-serve: 日志 tail -f ${tilde(LOG_FILE)}\n`);
	process.stderr.write(`steve-acp-serve: 停止 steve-acp-serve --stop\n`);
	process.exit(0);
}

printSummary();
const child = spawn(CMD[0], childArgs, { stdio: "inherit", env: process.env });
// SIGINT 由终端发给整个前台进程组，steve 自己收得到，这里不要重复转发；
// SIGTERM 可能是直接冲着本进程来的，转发给子进程让它优雅关闭。
process.once("SIGTERM", () => {
	try {
		child.kill("SIGTERM");
	} catch {
		/* 子进程已经退出 */
	}
});
child.once("exit", (code, signal) => {
	process.exit(code ?? (signal ? 1 : 0));
});
