/**
 * Leveled logging for the long-running entries (serve now, others later).
 *
 * The admin console can raise or lower the level and point the log at a
 * directory at runtime; both settings are meant to survive a restart, so their
 * *values* live in `~/.steve/admin.json` (`admin-config.ts`) — this module only
 * owns the mechanics: filtering, formatting and the file sink.
 *
 * Where lines go:
 *   - always to the sink (stderr by default);
 *   - into a file when a directory is configured. The console/CLI value is a
 *     **folder**, never a file: one file per calendar hour is created under it
 *     (`<dir>/YYYY-MM-DD/steve-YYYY-MM-DDTHH.log`, local time), so a long
 *     running process never grows a single unbounded file.
 *
 * With no directory configured the default is `~/.steve/logs` — the one global
 * state directory every other local artefact lives in — so a fresh install
 * writes logs out of the box.
 *
 * A broken path must never take the process down: the first failure falls back
 * to the sink and disables the file sink for this process.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { steveHomeDir } from "../model/config.js";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(value: unknown): value is LogLevel {
	return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Default log directory: `~/.steve/logs` (the global state directory). */
export function defaultLogDir(): string {
	return join(steveHomeDir(), "logs");
}

const pad = (value: number): string => String(value).padStart(2, "0");

/**
 * The file a line written at `date` belongs to.
 *
 * Layout: `<dir>/<YYYY-MM-DD>/steve-<YYYY-MM-DD>T<HH>.log` — one directory per
 * day (keeps a directory listing readable) and one file per hour. Local time,
 * because log readers think in local time and the line prefix keeps the
 * unambiguous ISO timestamp.
 */
export function logFilePath(dir: string, date: Date): string {
	const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	const hour = pad(date.getHours());
	return join(dir, day, `steve-${day}T${hour}.log`);
}

export interface LeveledLogger {
	level: LogLevel;
	/** The configured log directory, or `undefined` when the file sink is off. */
	dir?: string;
	setLevel(level: LogLevel): void;
	/** `undefined`/`""` disables the file sink and falls back to the default directory. */
	setDir(dir: string | undefined): void;
	log(message: string): void;
	debug(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface LoggerOptions {
	level?: LogLevel;
	/** Log **directory** (absolute or cwd-relative); files are created per hour under it. */
	dir?: string;
	/** Where every accepted line is written; defaults to stderr with a newline. */
	sink?: (line: string) => void;
	now?: () => Date;
}

export function createLogger(options: LoggerOptions = {}): LeveledLogger {
	const now = options.now ?? (() => new Date());
	const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
	let level: LogLevel = options.level ?? "info";
	let dir: string | undefined = options.dir === undefined || options.dir === "" ? undefined : options.dir;
	let fileBroken = false;

	const writeLine = (line: string, at: Date): void => {
		const target = dir ?? defaultLogDir();
		if (!fileBroken) {
			const file = logFilePath(target, at);
			try {
				mkdirSync(dirname(file), { recursive: true });
				appendFileSync(file, `${line}\n`);
			} catch (error) {
				fileBroken = true;
				sink(`${line} [logging] could not append to ${file}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		sink(line);
	};

	const emit = (lineLevel: LogLevel, message: string): void => {
		if (RANK[lineLevel] < RANK[level]) return;
		const at = now();
		writeLine(`${at.toISOString()} [${lineLevel}] ${message}`, at);
	};

	return {
		get level() {
			return level;
		},
		get dir() {
			return dir;
		},
		setLevel(next: LogLevel) {
			level = next;
		},
		setDir(next: string | undefined) {
			dir = next === "" ? undefined : next;
			fileBroken = false;
		},
		log(message: string) {
			emit("info", message);
		},
		debug(message: string) {
			emit("debug", message);
		},
		info(message: string) {
			emit("info", message);
		},
		warn(message: string) {
			emit("warn", message);
		},
		error(message: string) {
			emit("error", message);
		},
	};
}
