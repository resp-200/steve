/**
 * Leveled logging for the long-running entries (serve now, others later).
 *
 * The admin console can raise or lower the level and point the log at a file at
 * runtime; both settings are meant to survive a restart, so their *values* live
 * in `.steve/admin.json` (`admin-config.ts`) — this module only owns the
 * mechanics: filtering, formatting and the optional file sink.
 *
 * Lines always go to the sink (stderr by default). When a file is configured
 * they are appended there as well; a broken file path must never take the
 * process down, so the first failure falls back to the sink and disables the
 * sink file for this process.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(value: unknown): value is LogLevel {
	return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

export interface LeveledLogger {
	level: LogLevel;
	file?: string;
	setLevel(level: LogLevel): void;
	setFile(file: string | undefined): void;
	log(message: string): void;
	debug(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface LoggerOptions {
	level?: LogLevel;
	/** Absolute (or cwd-relative) log file; the directory is created on demand. */
	file?: string;
	/** Where every accepted line is written; defaults to stderr with a newline. */
	sink?: (line: string) => void;
	now?: () => Date;
}

export function createLogger(options: LoggerOptions = {}): LeveledLogger {
	const now = options.now ?? (() => new Date());
	const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
	let level: LogLevel = options.level ?? "info";
	let file: string | undefined = options.file === undefined || options.file === "" ? undefined : options.file;
	let fileBroken = false;

	const writeLine = (line: string): void => {
		if (file !== undefined && !fileBroken) {
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
		writeLine(`${now().toISOString()} [${lineLevel}] ${message}`);
	};

	return {
		get level() {
			return level;
		},
		get file() {
			return file;
		},
		setLevel(next: LogLevel) {
			level = next;
		},
		setFile(next: string | undefined) {
			file = next === "" ? undefined : next;
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
