/**
 * Local filesystem / shell tools.
 *
 * `pi-agent-core` ships no built-in tools and this project deliberately does not
 * depend on `pi-coding-agent`, so the local tools live here. Read-only tools are
 * always available; the ones with side effects are opt-in and go through the
 * permission gate.
 *
 * Every path is resolved against the workspace roots first: anything outside is
 * refused before a single byte is read or written.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type, type AgentTool } from "./contract.js";

/** Tool names that need the user's approval before they run. */
export const LOCAL_WRITE_TOOLS = ["write_file", "edit_file"] as const;
export const LOCAL_EXEC_TOOLS = ["run_command"] as const;
export const LOCAL_PERMISSION_TOOLS = [...LOCAL_WRITE_TOOLS, ...LOCAL_EXEC_TOOLS];

/** Directories that are never walked by glob/grep. */
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", ".next", "target", "vendor"]);

export interface LocalToolOptions {
	/** Workspace roots; every path must resolve inside one of them. */
	roots: string[];
	/** Register write_file / edit_file (still gated by permissions). */
	allowWrite?: boolean;
	/** Register run_command (still gated by permissions). */
	allowExec?: boolean;
	/** Cap for read_file / run_command output. Default: 200 KiB. */
	maxBytes?: number;
	/** Cap for glob/grep result counts. Default: 200. */
	maxResults?: number;
	/** Shell timeout. Default: 30s. */
	timeoutMs?: number;
}

const ReadParams = Type.Object({
	path: Type.String({ description: "File path (absolute, or relative to the workspace root)." }),
	offset: Type.Optional(Type.Number({ description: "1-based line to start from." })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to return." })),
});

const GlobParams = Type.Object({
	pattern: Type.String({ description: "Glob pattern, e.g. 'src/**/*.ts' or '*.json'." }),
	path: Type.Optional(Type.String({ description: "Directory to search in. Defaults to the workspace root." })),
});

const GrepParams = Type.Object({
	pattern: Type.String({ description: "JavaScript regular expression to search for." }),
	path: Type.Optional(Type.String({ description: "File or directory to search. Defaults to the workspace root." })),
	glob: Type.Optional(Type.String({ description: "Only search files matching this glob, e.g. '*.ts'." })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive match." })),
});

const WriteParams = Type.Object({
	path: Type.String({ description: "File path (absolute, or relative to the workspace root)." }),
	content: Type.String({ description: "Full new content of the file." }),
});

const EditParams = Type.Object({
	path: Type.String({ description: "File path (absolute, or relative to the workspace root)." }),
	old_string: Type.String({ description: "Exact text to replace; must be unique unless replace_all is set." }),
	new_string: Type.String({ description: "Replacement text." }),
	replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence." })),
});

const CommandParams = Type.Object({
	command: Type.String({ description: "Shell command line, run with `sh -lc`." }),
	cwd: Type.Optional(Type.String({ description: "Working directory inside the workspace roots." })),
	timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default 30000)." })),
});

/** Converts a glob into a RegExp (`**` crosses directories, `*` does not). */
function globToRegExp(pattern: string): RegExp {
	let source = "";
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index] ?? "";
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				index += 1;
				// `**/` also matches zero directories, so `src/**/*.ts` finds `src/a.ts`.
				if (pattern[index + 1] === "/") {
					index += 1;
					source += "(?:.*/)?";
				} else {
					source += ".*";
				}
			} else {
				source += "[^/]*";
			}
			continue;
		}
		if (char === "?") {
			source += "[^/]";
			continue;
		}
		source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

function looksBinary(buffer: Buffer): boolean {
	const sample = buffer.subarray(0, 4096);
	return sample.includes(0);
}

/**
 * Resolves symlinks as far as the path exists, then re-attaches the rest, so
 * `/var/...` and `/private/var/...` compare equal.
 */
function canonicalize(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		/* the target may not exist yet: resolve the nearest existing ancestor */
	}

	const parts: string[] = [];
	let current = path;
	for (;;) {
		const parent = dirname(current);
		if (parent === current) return path;
		parts.unshift(basename(current));
		current = parent;
		try {
			return join(realpathSync(current), ...parts);
		} catch {
			/* keep walking up */
		}
	}
}

export function createLocalTools(options: LocalToolOptions): AgentTool<any>[] {
	const roots = options.roots.map((root) => resolve(root));
	const maxBytes = options.maxBytes ?? 200 * 1024;
	const maxResults = options.maxResults ?? 200;
	const timeoutMs = options.timeoutMs ?? 30_000;
	const base = roots[0] ?? process.cwd();
	const canonicalRoots = roots.map(canonicalize);

	/**
	 * Absolute and inside a workspace root, or an error the model can read.
	 *
	 * Paths are compared after resolving symlinks, because macOS hands out
	 * `/var/...` while the real directory is `/private/var/...`: without this, a
	 * perfectly legal path under a symlinked temp dir would be refused.
	 */
	const resolveInside = (target: string): string => {
		const path = isAbsolute(target) ? resolve(target) : resolve(base, target);
		const canonical = canonicalize(path);
		const inside = canonicalRoots.some((root) => canonical === root || canonical.startsWith(root + sep));
		if (!inside) {
			throw new Error(`Refused: ${path} is outside the workspace roots (${roots.join(", ")}).`);
		}
		return path;
	};

	const relativeToBase = (path: string): string => {
		const relativePath = relative(base, path);
		return relativePath === "" ? "." : relativePath;
	};

	/** Breadth-first walk with a hard entry budget so a huge tree cannot hang us. */
	const walk = async (start: string, onFile: (path: string) => Promise<boolean | void> | boolean | void): Promise<void> => {
		const queue = [start];
		let visited = 0;

		while (queue.length > 0) {
			const current = queue.shift() as string;
			let entries;
			try {
				entries = await readdir(current, { withFileTypes: true });
			} catch {
				continue;
			}

			for (const entry of entries) {
				// Dot-entries stay out of glob/grep: `.env` and friends must not leak into results.
				if (entry.name.startsWith(".")) continue;
				const path = join(current, entry.name);
				if (entry.isDirectory()) {
					if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
					queue.push(path);
					continue;
				}
				if (!entry.isFile()) continue;
				visited += 1;
				if (visited > 20_000) return;
				if ((await onFile(path)) === false) return;
			}
		}
	};

	const readFileTool: AgentTool<typeof ReadParams> = {
		name: "read_file",
		label: "Read file",
		description: "Read a UTF-8 text file from the workspace. Paths outside the workspace roots are refused.",
		parameters: ReadParams,
		execute: async (_toolCallId, params) => {
			const path = resolveInside(params.path);
			const info = await stat(path);
			if (info.isDirectory()) throw new Error(`${path} is a directory.`);

			const buffer = await readFile(path);
			if (looksBinary(buffer)) throw new Error(`${path} looks binary; refusing to read it as text.`);
			const truncated = buffer.length > maxBytes;
			const text = buffer.subarray(0, maxBytes).toString("utf8");
			const lines = text.split("\n");
			const offset = Math.max(1, params.offset ?? 1);
			const limit = params.limit ?? lines.length;
			const slice = lines.slice(offset - 1, offset - 1 + limit);

			const header = `${relativeToBase(path)} (lines ${offset}-${offset + slice.length - 1} of ${lines.length}${truncated ? ", truncated" : ""})`;
			return {
				content: [{ type: "text", text: `${header}\n${slice.join("\n")}` }],
				details: { path, lines: lines.length, bytes: buffer.length, truncated },
			};
		},
	};

	const globTool: AgentTool<typeof GlobParams> = {
		name: "glob",
		label: "Glob files",
		description: "List files matching a glob pattern (e.g. 'src/**/*.ts'). Skips .git/node_modules/dist.",
		parameters: GlobParams,
		execute: async (_toolCallId, params) => {
			const start = params.path ? resolveInside(params.path) : base;
			const matcher = globToRegExp(params.pattern);
			const matches: string[] = [];

			await walk(start, (path) => {
				const candidate = relative(start, path).split(sep).join("/");
				if (matcher.test(candidate)) matches.push(relativeToBase(path));
				return matches.length >= maxResults ? false : undefined;
			});

			matches.sort();
			const body = matches.length > 0 ? matches.join("\n") : "(no matches)";
			return {
				content: [{ type: "text", text: `${matches.length} match(es) for ${params.pattern}\n${body}` }],
				details: { pattern: params.pattern, count: matches.length },
			};
		},
	};

	const grepTool: AgentTool<typeof GrepParams> = {
		name: "grep",
		label: "Search files",
		description: "Search file contents with a regular expression. Returns `path:line: text` hits.",
		parameters: GrepParams,
		execute: async (_toolCallId, params) => {
			const start = params.path ? resolveInside(params.path) : base;
			const filter = params.glob ? globToRegExp(params.glob) : undefined;
			const regexp = new RegExp(params.pattern, params.ignoreCase ? "i" : "");
			const hits: string[] = [];

			const searchFile = async (path: string): Promise<boolean> => {
				// `*.md` means "this file name", not "this whole path".
				if (filter && !filter.test(relative(start, path).split(sep).join("/")) && !filter.test(basename(path))) return true;
				const buffer = await readFile(path).catch(() => undefined);
				if (!buffer || looksBinary(buffer) || buffer.length > maxBytes) return true;

				const lines = buffer.toString("utf8").split("\n");
				for (let index = 0; index < lines.length; index += 1) {
					if (!regexp.test(lines[index] ?? "")) continue;
					hits.push(`${relativeToBase(path)}:${index + 1}: ${(lines[index] ?? "").trim().slice(0, 240)}`);
					if (hits.length >= maxResults) return false;
				}
				return true;
			};

			const info = await stat(start);
			if (info.isFile()) await searchFile(start);
			else await walk(start, searchFile);

			const body = hits.length > 0 ? hits.join("\n") : "(no matches)";
			return {
				content: [{ type: "text", text: `${hits.length} hit(s) for /${params.pattern}/\n${body}` }],
				details: { pattern: params.pattern, count: hits.length },
			};
		},
	};

	const writeFileTool: AgentTool<typeof WriteParams> = {
		name: "write_file",
		label: "Write file",
		description: "Create or overwrite a file in the workspace. Needs the user's permission.",
		parameters: WriteParams,
		execute: async (_toolCallId, params) => {
			const path = resolveInside(params.path);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, params.content, "utf8");
			return {
				content: [{ type: "text", text: `Wrote ${params.content.length} characters to ${relativeToBase(path)}.` }],
				details: { path, bytes: params.content.length },
			};
		},
	};

	const editFileTool: AgentTool<typeof EditParams> = {
		name: "edit_file",
		label: "Edit file",
		description: "Replace an exact snippet in a file. Needs the user's permission.",
		parameters: EditParams,
		execute: async (_toolCallId, params) => {
			const path = resolveInside(params.path);
			const original = await readFile(path, "utf8");
			const occurrences = original.split(params.old_string).length - 1;

			if (occurrences === 0) throw new Error(`old_string was not found in ${relativeToBase(path)}.`);
			if (occurrences > 1 && !params.replace_all) {
				throw new Error(`old_string appears ${occurrences} times in ${relativeToBase(path)}; add more context or set replace_all.`);
			}

			const updated = params.replace_all ? original.split(params.old_string).join(params.new_string) : original.replace(params.old_string, params.new_string);
			await writeFile(path, updated, "utf8");
			return {
				content: [{ type: "text", text: `Replaced ${occurrences} occurrence(s) in ${relativeToBase(path)}.` }],
				details: { path, occurrences, bytes: updated.length },
			};
		},
	};

	const runCommandTool: AgentTool<typeof CommandParams> = {
		name: "run_command",
		label: "Run command",
		description: "Run a shell command inside the workspace and return its output. Needs the user's permission.",
		parameters: CommandParams,
		execute: async (_toolCallId, params) => {
			const cwd = params.cwd ? resolveInside(params.cwd) : base;
			const limit = params.timeout_ms ?? timeoutMs;

			const result = await new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>((resolvePromise) => {
				const child = execFile(
					process.env.SHELL || "/bin/sh",
					["-lc", params.command],
					{ cwd, timeout: limit, maxBuffer: maxBytes, encoding: "utf8" },
					(error, stdout, stderr) => {
						const failure = error as (Error & { code?: number | string; killed?: boolean }) | null;
						resolvePromise({
							stdout: stdout ?? "",
							stderr: stderr ?? "",
							code: typeof failure?.code === "number" ? failure.code : failure ? 1 : 0,
							timedOut: Boolean(failure?.killed),
						});
					},
				);
				child.stdin?.end();
			});

			const output = `${result.stdout}${result.stderr}`.trim();
			const clipped = output.length > maxBytes ? `${output.slice(0, maxBytes)}… (output truncated)` : output;
			const status = result.timedOut ? `timed out after ${limit}ms` : `exit ${result.code}`;
			return {
				content: [{ type: "text", text: `${clipped || "(no output)"}\n\n[${status}]` }],
				details: { command: params.command, cwd, code: result.code, timedOut: result.timedOut },
			};
		},
	};

	return [
		readFileTool,
		globTool,
		grepTool,
		...(options.allowWrite ? [writeFileTool, editFileTool] : []),
		...(options.allowExec ? [runCommandTool] : []),
	];
}
