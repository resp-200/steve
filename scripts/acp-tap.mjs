#!/usr/bin/env node
/**
 * ACP wire tap: sits between an editor and the agent and records both directions.
 *
 * Editors only forward the agent's stderr, which says nothing about what the
 * *client* sent — so integration bugs ("it hangs at Starting …") are hard to pin
 * down. Point the editor at this file instead of the agent and the whole JSON-RPC
 * conversation lands in a log:
 *
 *   // ~/.jetbrains/acp.json (or Zed's settings.json)
 *   { "agent_servers": { "steve": {
 *       "command": "node",
 *       "args": ["/path/to/steve/scripts/acp-tap.mjs"] } } }
 *
 * Options (env):
 *   STEVE_ACP_TARGET       command to run      (default: steve-acp)
 *   STEVE_ACP_TARGET_ARGS  extra args, space separated
 *   STEVE_ACP_TAP          log file            (default: <cwd>/.steve/acp-tap.log)
 *
 * stdout stays protocol-pure: only the log and the agent's own stderr are used
 * for output. Remember to point the editor back at the agent when you are done.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const target = process.env.STEVE_ACP_TARGET ?? "steve-acp";
const targetArgs = (process.env.STEVE_ACP_TARGET_ARGS ?? "").split(" ").filter(Boolean);
const logPath = process.env.STEVE_ACP_TAP ?? join(process.cwd(), ".steve", "acp-tap.log");

mkdirSync(dirname(logPath), { recursive: true });
process.stderr.write(`[acp-tap] ${target} ${targetArgs.join(" ")} → ${logPath}\n`);

const record = (arrow, chunk) => {
	for (const line of String(chunk).split("\n")) {
		if (line.trim()) appendFileSync(logPath, `${arrow} ${line.trim()}\n`);
	}
};

const child = spawn(target, targetArgs, { stdio: ["pipe", "pipe", "inherit"] });

process.stdin.on("data", (chunk) => {
	record("→ client", chunk);
	child.stdin.write(chunk);
});
process.stdin.on("end", () => child.stdin.end());

child.stdout.on("data", (chunk) => {
	record("← agent ", chunk);
	process.stdout.write(chunk);
});

child.on("error", (error) => {
	process.stderr.write(`[acp-tap] failed to start ${target}: ${error.message}\n`);
	process.exit(1);
});
child.on("exit", (code, signal) => {
	process.stderr.write(`[acp-tap] ${target} exited (code ${code ?? "null"}, signal ${signal ?? "none"})\n`);
	process.exit(code ?? 0);
});
