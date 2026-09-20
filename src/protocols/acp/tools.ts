import { Type, type Static, type AgentTool } from "../../features/contract.js";
import type { AnnotatedTool } from "../../features/tool-annotations.js";
import type { AgentContext, ClientCapabilities } from "@agentclientprotocol/sdk";

/**
 * Tools backed by the ACP *client* instead of the local machine: file reads and
 * writes go through `fs/read_text_file` / `fs/write_text_file`, commands run in
 * the client's terminal via `terminal/*`.
 *
 * ACP requires absolute paths, so the session cwd is passed as the default cwd.
 */
export interface AcpToolContext {
	sessionId: string;
	workingDirectory: string;
	client: AgentContext;
	capabilities: ClientCapabilities;
}

/** Tool names the editor must approve before pi executes them. */
export const ACP_PERMISSION_TOOLS = ["write_file", "run_command"] as const;

const ReadFileParams = Type.Object({
	path: Type.String({ description: "Absolute path of the file to read." }),
	line: Type.Optional(Type.Number({ description: "1-based line to start reading from." })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read." })),
});

const WriteFileParams = Type.Object({
	path: Type.String({ description: "Absolute path of the file to write." }),
	content: Type.String({ description: "Full new content of the file." }),
});

const RunCommandParams = Type.Object({
	command: Type.String({ description: "Executable to run, e.g. 'npm' or 'git'." }),
	args: Type.Optional(Type.Array(Type.String(), { description: "Command arguments." })),
	cwd: Type.Optional(Type.String({ description: "Working directory (absolute path). Defaults to the session cwd." })),
});

function readFileTool(context: AcpToolContext): AnnotatedTool<typeof ReadFileParams> {
	return {
		name: "read_file",
		label: "Read file",
		description: "Read a UTF-8 text file through the editor. Paths must be absolute.",
		metadata: { kind: "read", title: (args) => `Read ${(args as { path?: string })?.path ?? "file"}` },
		parameters: ReadFileParams,
		execute: async (_toolCallId, params: Static<typeof ReadFileParams>) => {
			const response = await context.client.request("fs/read_text_file", {
				sessionId: context.sessionId,
				path: params.path,
				line: params.line ?? null,
				limit: params.limit ?? null,
			});
			return {
				content: [{ type: "text", text: response.content }],
				details: { path: params.path, bytes: response.content.length },
			};
		},
	};
}

function writeFileTool(context: AcpToolContext): AnnotatedTool<typeof WriteFileParams> {
	return {
		name: "write_file",
		label: "Write file",
		description: "Create or overwrite a UTF-8 text file through the editor. Paths must be absolute.",
		permission: "ask",
		metadata: { kind: "edit", title: (args) => `Write ${(args as { path?: string })?.path ?? "file"}` },
		parameters: WriteFileParams,
		execute: async (_toolCallId, params: Static<typeof WriteFileParams>) => {
			await context.client.request("fs/write_text_file", {
				sessionId: context.sessionId,
				path: params.path,
				content: params.content,
			});
			return {
				content: [{ type: "text", text: `Wrote ${params.content.length} characters to ${params.path}` }],
				details: { path: params.path, bytes: params.content.length },
			};
		},
	};
}

function runCommandTool(context: AcpToolContext): AnnotatedTool<typeof RunCommandParams> {
	return {
		name: "run_command",
		label: "Run command",
		description: "Run a shell command in the client's terminal and return its output and exit code.",
		permission: "ask",
		metadata: { kind: "execute", title: (args) => `Run ${(args as { command?: string })?.command ?? "command"}` },
		parameters: RunCommandParams,
		execute: async (_toolCallId, params: Static<typeof RunCommandParams>) => {
			const terminal = await context.client.request("terminal/create", {
				sessionId: context.sessionId,
				command: params.command,
				args: params.args,
				cwd: params.cwd ?? context.workingDirectory,
			});

			const terminalId = terminal.terminalId;
			try {
				const exit = await context.client.request("terminal/wait_for_exit", { sessionId: context.sessionId, terminalId });
				const output = await context.client.request("terminal/output", { sessionId: context.sessionId, terminalId });
				const status =
					exit.exitCode === null || exit.exitCode === undefined
						? `signal ${exit.signal ?? "unknown"}`
						: `exit ${exit.exitCode}`;
				const body = output.output.trim() || "(no output)";
				return {
					content: [{ type: "text", text: `${body}\n\n[${status}${output.truncated ? ", output truncated" : ""}]` }],
					details: {
						terminalId,
						exitCode: exit.exitCode,
						signal: exit.signal,
						output: output.output,
						truncated: output.truncated,
					},
				};
			} finally {
				await context.client.request("terminal/release", { sessionId: context.sessionId, terminalId }).catch(() => undefined);
			}
		},
	};
}

/** Builds the tools the connected editor actually supports. */
export function createAcpTools(context: AcpToolContext): AgentTool<any>[] {
	// Array literals are covariant, which keeps each tool's parameter types intact
	// while still returning the heterogeneous list the agent wants.
	return [
		...(context.capabilities.fs?.readTextFile ? [readFileTool(context)] : []),
		...(context.capabilities.fs?.writeTextFile ? [writeFileTool(context)] : []),
		...(context.capabilities.terminal ? [runCommandTool(context)] : []),
	];
}
