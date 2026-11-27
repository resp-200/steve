#!/usr/bin/env node
/**
 * `steve-wechat` — links a WeChat account to this machine's agent.
 *
 * Kept out of `steve` itself because a login is a one-off that blocks on someone
 * walking over to their phone with a QR code; the chat entry point should never
 * wait on that. `steve-serve` reads the file this writes.
 *
 * The QR is rendered in the terminal without a dependency: ClawBot hands back a
 * URL, and the QR standard's byte mode with error correction level L is short
 * enough to implement honestly for one code page. When the terminal is not a TTY
 * (CI, a pipe) the URL is printed instead — a scanner can't read a pipe, but a
 * person reading a log can copy it.
 */

import process from "node:process";
import { clearWechatSession, loginWechat, readWechatSession, wechatSessionPath, writeWechatSession } from "../features/wechat.js";
import { color } from "./render.js";
import { renderQr } from "../features/qr.js";

const HELP = `
steve-wechat — 扫码把微信 ClawBot 绑到本机

用法：
  steve-wechat            扫码登录（已有登录会覆盖）
  steve-wechat --status   看当前登录状态
  steve-wechat --logout   删除保存的登录
  steve-wechat --help     显示本帮助

扫码后 token 存在 ${wechatSessionPath()}，steve-serve 启动时会自动使用它。
登录只做一次；会话过期（-14）时再跑一遍即可。
`.trim();

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${HELP}\n`);
		return;
	}
	if (args.includes("--status")) {
		const session = readWechatSession();
		if (session === undefined) {
			process.stdout.write(`未登录（${wechatSessionPath()} 不存在）\n`);
			return;
		}
		process.stdout.write(`${JSON.stringify({ file: wechatSessionPath(), ...session, botToken: `${session.botToken.slice(0, 8)}…` }, null, 2)}\n`);
		return;
	}
	if (args.includes("--logout")) {
		clearWechatSession();
		process.stdout.write(`已删除 ${wechatSessionPath()}\n`);
		return;
	}
	const unknown = args.find((arg) => arg.startsWith("-"));
	if (unknown !== undefined) {
		process.stderr.write(`${color.red("error")} 未知参数 ${unknown}（见 --help）\n`);
		process.exitCode = 2;
		return;
	}

	process.stdout.write(`${color.dim("正在向 ClawBot 申请登录二维码…")}\n`);
	const session = await loginWechat({
		onQrCode: (qr) => {
			// Both forms: the code is what a phone scans, the URL is a fallback for a
			// terminal too small (or too monochrome) to draw one.
			process.stdout.write(`\n${renderQr(qr.image)}\n`);
			process.stdout.write(`${color.dim("用微信扫描上面的二维码；扫不动就把这段链接发到手机：")}\n${qr.image}\n\n`);
			process.stdout.write(`${color.dim("等待扫码确认…")}\n`);
		},
	});
	writeWechatSession(session);
	process.stdout.write(
		[
			"",
			`${color.green("✓")} 登录成功`,
			`  token 已写入 ${wechatSessionPath()}（权限 600）`,
			session.baseUrl === undefined ? "" : `  服务地址 ${session.baseUrl}`,
			"  接下来启动 steve-serve 就会自动接收微信消息",
			"",
		]
			.filter((line) => line !== "")
			.join("\n") + "\n",
	);
}

main().catch((error: unknown) => {
	process.stderr.write(`${color.red("error")} ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
