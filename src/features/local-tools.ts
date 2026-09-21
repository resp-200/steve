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
import type { Logger, ShellCommand } from "../types.js";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type, type AgentTool } from "./contract.js";
import type { AnnotatedTool } from "./tool-annotations.js";
import { editPreview, findOccurrences, writePreview } from "./change-preview.js";
import type { ToolChangePreview } from "./permissions.js";

/** Directories that are never walked by glob/grep. */
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", ".next", "target", "vendor"]);

/** Image types `read_file` can hand to a vision model. */
const IMAGE_MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

export interface LocalToolOptions {
	/** Workspace roots; every path must resolve inside one of them. */
	roots: string[];
	/** Register write_file / edit_file (still gated by permissions). */
	allowWrite?: boolean;
	/** Register run_command (still gated by permissions). */
	allowExec?: boolean;
	/** Return image files as image content instead of refusing them. */
	supportsImages?: boolean;
	/** Cap for read_file / run_command output. Default: 200 KiB. */
	maxBytes?: number;
	/** Cap for image files handed to the model. Default: 4 MiB. */
	maxImageBytes?: number;
	/** Cap for glob/grep result counts. Default: 200. */
	maxResults?: number;
	/** Shell timeout. Default: 30s. */
	timeoutMs?: number;
	/** Override how shell commands are run (defaults to `resolveShell()`). */
	shell?: ShellCommand;
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
	line: Type.Optional(Type.Number({ description: "1-based line the match must start on, to disambiguate repeated snippets." })),
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

/**
 * True when `candidate` is inside `root`.
 *
 * Windows and default macOS filesystems compare paths case-insensitively, so
 * containment has to as well — otherwise a path that differs only in case is
 * wrongly refused. Linux stays case-sensitive to keep the boundary tight.
 */
export interface ContainmentOptions {
	/** Compare case-insensitively. Default: true on Windows and macOS. */
	caseInsensitive?: boolean;
	/** Separator used for the boundary check. Default: the platform's `sep`. */
	separator?: string;
}

export function isInside(root: string, candidate: string, options: ContainmentOptions = {}): boolean {
	const caseInsensitive = options.caseInsensitive ?? (process.platform === "win32" || process.platform === "darwin");
	const separator = options.separator ?? sep;
	const [a, b] = caseInsensitive ? [root.toLowerCase(), candidate.toLowerCase()] : [root, candidate];
	return b === a || b.startsWith(a.endsWith(separator) ? a : a + separator);
}

/**
 * `sh -lc` on POSIX, `cmd.exe /d /s /c` on Windows. Override with
 * `LocalToolOptions.shell` (or `SHELL`/`COMSPEC`) when you want another shell.
 */
export function resolveShell(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): ShellCommand {
	if (platform === "win32") {
		return { file: env.COMSPEC || "cmd.exe", args: ["/d", "/s", "/c"] };
	}

	return { file: env.SHELL || "/bin/sh", args: ["-lc"] };
}

export function createLocalTools(options: LocalToolOptions): AgentTool<any>[] {
	const roots = options.roots.map((root) => resolve(root));
	const maxBytes = options.maxBytes ?? 200 * 1024;
	const maxResults = options.maxResults ?? 200;
	const timeoutMs = options.timeoutMs ?? 30_000;
	const base = roots[0] ?? process.cwd();
	const canonicalRoots = roots.map(canonicalize);
	const maxImageBytes = options.maxImageBytes ?? 4 * 1024 * 1024;
	const canonicalBase = canonicalRoots[0] ?? canonicalize(base);

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
		const inside = canonicalRoots.some((root) => isInside(root, canonical));
		if (!inside) {
			throw new Error(`Refused: ${path} is outside the workspace roots (${roots.join(", ")}).`);
		}
		return path;
	};

	/** Paths are shown relative to the canonical root, so a symlinked cwd stays readable. */
	const relativeToBase = (path: string): string => {
		const relativePath = relative(canonicalBase, canonicalize(path));
		if (relativePath === "") return ".";
		return relativePath.startsWith("..") ? path : relativePath;
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

	const readFileTool: AnnotatedTool<typeof ReadParams> = {
		name: "read_file",
		label: "Read file",
		description: "Read a UTF-8 text file from the workspace. Paths outside the workspace roots are refused.",
		metadata: { kind: "read", title: (args) => `Read ${(args as { path?: string })?.path ?? "file"}` },
		parameters: ReadParams,
		execute: async (_toolCallId, params) => {
			const path = resolveInside(params.path);
			const info = await stat(path);
			if (info.isDirectory()) throw new Error(`${path} is a directory.`);

			// Images go to the model as image content when it can actually see them.
			const mimeType = options.supportsImages ? IMAGE_MIME_TYPES[extname(path).toLowerCase()] : undefined;
			if (mimeType) {
				if (info.size > maxImageBytes) {
					throw new Error(`${path} is ${info.size} bytes; images are limited to ${maxImageBytes} bytes.`);
				}
				const data = (await readFile(path)).toString("base64");
				return {
					content: [
						{ type: "text", text: `${relativeToBase(path)} (${mimeType}, ${info.size} bytes)` },
						{ type: "image", data, mimeType },
					],
					details: { path, mimeType, bytes: info.size, image: true },
				};
			}

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

	const globTool: AnnotatedTool<typeof GlobParams> = {
		name: "glob",
		label: "Glob files",
		description: "List files matching a glob pattern (e.g. 'src/**/*.ts'). Skips .git/node_modules/dist.",
		metadata: { kind: "read", title: (args) => `Glob ${(args as { pattern?: string })?.pattern ?? "*"}` },
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

	const grepTool: AnnotatedTool<typeof GrepParams> = {
		name: "grep",
		label: "Search files",
		description: "Search file contents with a regular expression. Returns `path:line: text` hits.",
		metadata: { kind: "read", title: (args) => `Search ${(args as { pattern?: string })?.pattern ?? ""}`.trim() },
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

	const writeFileTool: AnnotatedTool<typeof WriteParams> = {
		name: "write_file",
		label: "Write file",
		description: "Create or overwrite a file in the workspace. Needs the user's permission.",
		permission: "ask",
		metadata: { kind: "edit", title: (args) => `Write ${(args as { path?: string })?.path ?? "file"}` },
		describe: async (args) => {
			const input = (args ?? {}) as { path?: string; content?: string };
			if (!input.path) return undefined;
			const path = resolveInside(input.path);
			const before = await readFile(path, "utf8").catch(() => undefined);
			return writePreview({ path, shown: relativeToBase(path), ...(before === undefined ? {} : { before }), after: input.content ?? "" });
		},
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

	const editFileTool: AnnotatedTool<typeof EditParams> = {
		name: "edit_file",
		label: "Edit file",
		description: "Replace an exact snippet in a file. Needs the user's permission.",
		permission: "ask",
		metadata: { kind: "edit", title: (args) => `Edit ${(args as { path?: string })?.path ?? "file"}` },
		describe: async (args) => {
			const input = (args ?? {}) as { path?: string; old_string?: string; new_string?: string; line?: number; replace_all?: boolean };
			if (!input.path || input.old_string === undefined) return undefined;
			const path = resolveInside(input.path);
			const before = await readFile(path, "utf8").catch(() => undefined);
			if (before === undefined) return undefined;
			return editPreview({
				path,
				shown: relativeToBase(path),
				before,
				find: input.old_string,
				replace: input.new_string ?? "",
				...(typeof input.line === "number" ? { line: input.line } : {}),
				...(input.replace_all === true ? { replaceAll: true } : {}),
			});
		},
		parameters: EditParams,
		execute: async (_toolCallId, params) => {
			const path = resolveInside(params.path);
			const shown = relativeToBase(path);
			const original = await readFile(path, "utf8");
			const occurrences = findOccurrences(original, params.old_string);

			if (occurrences.length === 0) throw new Error(`old_string was not found in ${shown}.`);

			// Ambiguity is reported with candidates, so the model can pass `line` next.
			if (occurrences.length > 1 && !params.replace_all && params.line === undefined) {
				const candidates = occurrences.map((occurrence) => `  line ${occurrence.line}: ${occurrence.snippet}`).join("\n");
				throw new Error(
					`old_string appears ${occurrences.length} times in ${shown}; pass \`line\` to pick one, or set replace_all. Candidates:\n${candidates}`,
				);
			}

			const selected =
				params.line === undefined
					? params.replace_all
						? occurrences
						: occurrences.slice(0, 1)
					: occurrences.filter((occurrence) => occurrence.line === params.line);

			if (selected.length === 0) {
				throw new Error(
					`no occurrence of old_string starts at line ${params.line} in ${shown} (candidates: ${occurrences.map((occurrence) => occurrence.line).join(", ")}).`,
				);
			}

			const updated = selected.reduce((text, occurrence) => {
				const start = occurrence.index;
				return `${text.slice(0, start)}${params.new_string}${text.slice(start + params.old_string.length)}`;
			}, original);
			await writeFile(path, updated, "utf8");

			return {
				content: [{ type: "text", text: `Replaced ${selected.length} of ${occurrences.length} occurrence(s) in ${shown} (line ${selected.map((o) => o.line).join(", ")}).` }],
				details: { path, occurrences: selected.length, lines: selected.map((occurrence) => occurrence.line), bytes: updated.length },
			};
		},
	};

	const runCommandTool: AnnotatedTool<typeof CommandParams> = {
		name: "run_command",
		label: "Run command",
		description: "Run a shell command inside the workspace and return its output. Needs the user's permission.",
		permission: "ask",
		metadata: { kind: "execute", title: (args) => `Run ${(args as { command?: string })?.command ?? "command"}` },
		describe: (args) => {
			const command = (args as { command?: string })?.command;
			return command ? { summary: `run ${command}` } : undefined;
		},
		parameters: CommandParams,
		execute: async (_toolCallId, params) => {
			const cwd = params.cwd ? resolveInside(params.cwd) : base;
			const limit = params.timeout_ms ?? timeoutMs;

			const shell = options.shell ?? resolveShell();
			const result = await new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>((resolvePromise) => {
				const child = execFile(
					shell.file,
					[...shell.args, params.command],
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

/* ---------------------------- change previews ---------------------------- */

/**
 * Describes what `write_file` / `edit_file` / `run_command` are about to do, so
 * the permission prompt can show a diff before anything is touched.
 *
 * Shares the path confinement rules with the tools themselves.
 */
export function createLocalToolDescriber(options: LocalToolOptions): (toolName: string, args: unknown) => Promise<ToolChangePreview | undefined> {
	const roots = options.roots.map((root) => resolve(root));
	const base = roots[0] ?? process.cwd();
	const canonicalRoots = roots.map(canonicalize);

	const resolveInside = (target: string): string => {
		const path = isAbsolute(target) ? resolve(target) : resolve(base, target);
		const canonical = canonicalize(path);
		if (!canonicalRoots.some((root) => isInside(root, canonical))) {
			throw new Error(`${path} is outside the workspace roots.`);
		}
		return path;
	};

	return async (toolName, args) => {
		const input = (args ?? {}) as Record<string, unknown>;
		const text = (key: string): string | undefined => (typeof input[key] === "string" ? (input[key] as string) : undefined);

		if (toolName === "run_command") {
			const command = text("command");
			if (!command) return undefined;
			return { summary: `run ${command}` };
		}

		const rawPath = text("path");
		if (!rawPath) return undefined;
		const path = resolveInside(rawPath);
		const shown = shownPath(base, path);

		if (toolName === "write_file") {
			const after = text("content") ?? "";
			const before = await readFile(path, "utf8").catch(() => undefined);
			return writePreview({ path, shown, ...(before === undefined ? {} : { before }), after });
		}

		if (toolName === "edit_file") {
			const before = await readFile(path, "utf8");
			return editPreview({
				path,
				shown,
				before,
				find: text("old_string") ?? "",
				replace: text("new_string") ?? "",
				...(typeof input.line === "number" ? { line: input.line } : {}),
				...(input.replace_all === true ? { replaceAll: true } : {}),
			});
		}

		return undefined;
	};
}

/** Display path relative to the canonical root (never a `../../..` chain). */
function shownPath(base: string, path: string): string {
	const relativePath = relative(canonicalize(base), canonicalize(path));
	if (relativePath === "") return path;
	return relativePath.startsWith("..") ? path : relativePath;
}

