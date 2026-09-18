// Blocks obviously destructive shell commands before they run.
//
//   STEVE_EXTENSIONS=examples/extensions/guard-destructive.mjs npm run dev
//
// A `tool_call` handler that returns `{ block: true }` turns the call into an
// error tool result: the model sees the refusal and can pick another approach.

const DANGEROUS = [
	/\brm\s+(-[a-z]+\s+)*-[a-z]*[rf]/i, // rm -rf, rm -fr, rm -r -f …
	/\bmkfs(\.\w+)?\b/i,
	/\bdd\s+if=/i,
	/\bshutdown\b|\breboot\b/i,
	/:\(\)\s*\{.*\}\s*;\s*:/, // fork bomb
];

export default function guardDestructive(pi) {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "run_command") return;

		const args = Array.isArray(event.args?.args) ? event.args.args.join(" ") : "";
		const command = `${event.args?.command ?? ""} ${args}`.trim();
		if (!DANGEROUS.some((pattern) => pattern.test(command))) return;

		pi.ctx.log(`refused: ${command}`);
		return { block: true, reason: `guard-destructive refused "${command}": it looks destructive.` };
	});
}
