/**
 * Pure helpers for triggers (§5.5): cron expressions, glob matching and path
 * containment. No IO — the trigger engine owns timers, watchers and the log.
 */
import { dirname, relative, resolve, sep } from "node:path";

/* ── cron ────────────────────────────────────────────────────────────────── */

/** A parsed five-field cron expression (`m h dom mon dow`). */
export interface CronSpec {
	minute: Set<number>;
	hour: Set<number>;
	dayOfMonth: Set<number>;
	month: Set<number>;
	dayOfWeek: Set<number>;
	/** True when the field was `*`, which changes dom/dow semantics to OR. */
	dayOfMonthAny: boolean;
	dayOfWeekAny: boolean;
}

const CRON_FIELDS: { name: string; min: number; max: number }[] = [
	{ name: "minute", min: 0, max: 59 },
	{ name: "hour", min: 0, max: 23 },
	{ name: "day-of-month", min: 1, max: 31 },
	{ name: "month", min: 1, max: 12 },
	{ name: "day-of-week", min: 0, max: 7 },
];

function parseField(raw: string, min: number, max: number): { values: Set<number>; any: boolean } {
	if (raw === "*") {
		const values = new Set<number>();
		for (let value = min; value <= max; value += 1) values.add(value);
		return { values, any: true };
	}
	const values = new Set<number>();
	for (const part of raw.split(",")) {
		const [rangePart, stepPart] = part.split("/");
		const step = stepPart === undefined ? 1 : Number(stepPart);
		if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron step "${part}"`);
		let from: number;
		let to: number;
		if (rangePart === "*") {
			from = min;
			to = max;
		} else if (rangePart?.includes("-") === true) {
			const [start, end] = rangePart.split("-");
			from = Number(start);
			to = Number(end);
		} else {
			from = Number(rangePart);
			to = stepPart === undefined ? from : max;
		}
		if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
			throw new Error(`cron field out of range: "${part}" (${min}-${max})`);
		}
		for (let value = from; value <= to; value += step) values.add(value);
	}
	if (values.size === 0) throw new Error(`empty cron field "${raw}"`);
	return { values, any: false };
}

/** Parses `m h dom mon dow`; throws with a human-readable reason. */
export function parseCron(expression: string): CronSpec {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) throw new Error(`cron needs 5 fields (m h dom mon dow), got ${fields.length}`);
	const parsed = CRON_FIELDS.map((field, index) => parseField(fields[index] as string, field.min, field.max));
	const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed as [ReturnType<typeof parseField>, ReturnType<typeof parseField>, ReturnType<typeof parseField>, ReturnType<typeof parseField>, ReturnType<typeof parseField>];
	const weekdays = new Set<number>();
	for (const value of dayOfWeek.values) weekdays.add(value === 7 ? 0 : value);
	return {
		minute: minute.values,
		hour: hour.values,
		dayOfMonth: dayOfMonth.values,
		month: month.values,
		dayOfWeek: weekdays,
		dayOfMonthAny: dayOfMonth.any,
		dayOfWeekAny: dayOfWeek.any,
	};
}

interface TimeParts {
	minute: number;
	hour: number;
	dayOfMonth: number;
	month: number;
	dayOfWeek: number;
}

const WEEKDAYS = new Map([
	["Sun", 0],
	["Mon", 1],
	["Tue", 2],
	["Wed", 3],
	["Thu", 4],
	["Fri", 5],
	["Sat", 6],
]);

function timeParts(at: number, timezone: string | undefined): TimeParts {
	const date = new Date(at);
	if (timezone === undefined) {
		return { minute: date.getUTCMinutes(), hour: date.getUTCHours(), dayOfMonth: date.getUTCDate(), month: date.getUTCMonth() + 1, dayOfWeek: date.getUTCDay() };
	}
	const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", weekday: "short", hour12: false }).formatToParts(date);
	const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
	const hour = Number(pick("hour")) % 24;
	const weekday = WEEKDAYS.get(pick("weekday"));
	if (weekday === undefined) throw new Error(`could not read weekday in timezone ${timezone}`);
	return { minute: Number(pick("minute")), hour, dayOfMonth: Number(pick("day")), month: Number(pick("month")), dayOfWeek: weekday };
}

/** True when the expression matches the minute containing `at`. */
export function cronMatches(spec: CronSpec, at: number, timezone?: string): boolean {
	const parts = timeParts(at, timezone);
	if (!spec.minute.has(parts.minute) || !spec.hour.has(parts.hour) || !spec.month.has(parts.month)) return false;
	const dayOfMonthMatches = spec.dayOfMonth.has(parts.dayOfMonth);
	const dayOfWeekMatches = spec.dayOfWeek.has(parts.dayOfWeek);
	if (spec.dayOfMonthAny && spec.dayOfWeekAny) return true;
	if (spec.dayOfMonthAny) return dayOfWeekMatches;
	if (spec.dayOfWeekAny) return dayOfMonthMatches;
	return dayOfMonthMatches || dayOfWeekMatches;
}

/** First minute boundary strictly after `from`; bounded to one year ahead. */
export function nextCronTime(spec: CronSpec, from: number, timezone?: string): number {
	let at = Math.floor(from / 60_000) * 60_000 + 60_000;
	const limit = at + 366 * 24 * 60 * 60_000;
	for (; at <= limit; at += 60_000) {
		if (cronMatches(spec, at, timezone)) return at;
	}
	throw new Error("cron expression never matches within a year");
}

export function isValidTimezone(timezone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone });
		return true;
	} catch {
		return false;
	}
}

/* ── globs and containment ───────────────────────────────────────────────── */

function globToPattern(glob: string): string {
	let out = "";
	for (let index = 0; index < glob.length; index += 1) {
		const char = glob[index] as string;
		if (char === "*") {
			if (glob[index + 1] === "*") {
				// `**/` matches zero or more directories; a bare `**` matches anything.
				if (glob[index + 2] === "/") {
					out += "(?:.*/)?";
					index += 2;
				} else {
					out += ".*";
					index += 1;
				}
			} else {
				out += "[^/]*";
			}
		} else if (char === "?") {
			out += "[^/]";
		} else if ("\\^$.|+()[]{}".includes(char)) {
			out += `\\${char}`;
		} else {
			out += char;
		}
	}
	return out;
}

export interface CompiledGlob {
	/** Absolute pattern in forward-slash form. */
	absolute: string;
	regex: RegExp;
	/** Directory the watcher can be attached to. */
	root: string;
	/** Set for patterns without wildcards. */
	literalPath?: string;
}

export function compileGlob(pattern: string, cwd: string): CompiledGlob {
	const absolute = resolve(cwd, pattern).split(sep).join("/");
	const magic = absolute.search(/[*?]/);
	const root = magic === -1 ? dirname(absolute) : absolute.slice(0, absolute.lastIndexOf("/", magic));
	const regex = new RegExp(`^${globToPattern(absolute)}$`);
	return { absolute, regex, root, ...(magic === -1 ? { literalPath: absolute } : {}) };
}

/** True when `candidate` (absolute or relative to cwd) is inside `root`. */
export function isInside(root: string, candidate: string, cwd = process.cwd()): boolean {
	const rootPath = resolve(root);
	const target = resolve(cwd, candidate);
	const path = relative(rootPath, target);
	return path === "" || (!path.startsWith("..") && !path.startsWith(sep) && !/^[A-Za-z]:/.test(path));
}
