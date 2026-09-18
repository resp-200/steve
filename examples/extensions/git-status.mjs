// Adds a `git_status` tool and a `/git-status` command.
//
//   STEVE_EXTENSIONS=examples/extensions/git-status.mjs npm run dev
//   STEVE_EXTENSIONS=examples/extensions/git-status.mjs npm run acp -- --port 8890
//
// Registered tools join the agent's tool list; registered commands show up as
// slash commands in the CLI and (through `available_commands_update`) in editors.

export default function gitStatus(pi) {
	pi.registerTool({
		name: "git_status",
		label: "Git status",
		description: "Show the git working tree status of the session directory.",
		parameters: pi.Type.Object({
			short: pi.Type.Optional(pi.Type.Boolean({ description: "Use the short format." })),
		}),
		execute: async (_toolCallId, params) => {
			const result = await pi.ctx.exec("git", ["status", ...(params.short ? ["--short"] : [])]);
			const text = (result.stdout || result.stderr).trim() || "(clean working tree)";
			return { content: [{ type: "text", text }], details: { code: result.code } };
		},
	});

	pi.registerCommand({
		name: "git-status",
		description: "Print `git status --short --branch` for the session directory.",
		run: async () => {
			const result = await pi.ctx.exec("git", ["status", "--short", "--branch"]);
			return (result.stdout || result.stderr).trim() || "(clean working tree)";
		},
	});
}
